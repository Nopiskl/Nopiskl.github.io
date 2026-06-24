# Allwinner VIN TDM Rate Control / Speed Down 机制分析

> 适用范围：本文只讨论 `vin-tdm` 中与 **rate control / speed down / TX data rate / valid_num / invalid_num** 有关的内容。  
> 参考代码：Radxa `allwinner-bsp` commit `2045a3ca2a01f088c0314dc924bda59d154e363e` 下的：
>
> - `drivers/vin/vin-tdm/vin_tdm.c`
> - `drivers/vin/vin-tdm/tdm200/tdm200_reg.c`
> - `drivers/vin/vin-tdm/tdm200/tdm200_reg_i.h`
>
> 术语说明：
>
> - **RX**：TDM 接收侧，多路 sensor RAW 输入进入 TDM。
> - **TX**：TDM 发送侧，TDM 将 RX 数据按时分复用方式发送给 ISP。
> - **speed down / rate control**：通过 `valid_num / invalid_num` 控制 TDM TX 的有效发送占空比。
> - **valid cycle**：TX 允许发送有效数据的周期。
> - **invalid cycle**：TX 插入的无效周期，相当于节流 / 空转周期。

---

## 1. 一句话结论

TDM rate control 的核心不是“让 TX 更快”，而是：

> **让可能过快、过突发的 TDM TX 输出，按照 ISP 可承受的节奏发送。**

它通过 `valid_num / invalid_num` 给 TX 插入无效周期，降低 TX 有效发送占空比，从而匹配 ISP / bridge / FIFO 的处理能力，避免 TX 侧过快导致 FIFO underflow / overflow / hsync 异常等问题。

但需要明确：

> **speed down 不能解决总输入带宽大于总输出带宽的问题。**

如果多路 sensor RAW 的长期平均输入需求已经大于 TDM TX + ISP 的长期平均处理能力，那么无论是否开启 speed down，最终都会堆积并触发 RX FIFO full、RX buffer full、frame lost 等异常。

---

## 2. 为什么需要 speed down

直觉上，TDM 是：

```text
RX0 RX1  RX2   -> TDM buffer/FIFO -> TDM TX -> ISP
RX3  /
```

RX 侧可以同时接收多路 sensor 输入；TX 侧则是一个发送口，按时分复用方式轮流把不同 RX 通道的数据送给 ISP。

很多人会自然认为：

```text
4 路同时进，1 路慢慢出，那不是必然堵吗？
```

这个推理只在一种情况下成立：

```text
多路 RX 长期平均输入 > TDM TX / ISP 长期平均输出能力
```

如果这个不等式成立，确实必然堵。speed down 不能改变数据总量，只能改变数据送出的节奏。

但实际系统中还有几个关键因素：

1. sensor 并不是 100% 时间都在输出有效像素；
2. sensor 有 hblank、vblank、vts；
3. TDM TX 使用内部发送节奏，不等于任一路 sensor pixel clock；
4. TDM RX / TX 之间存在 FIFO 和 DDR buffer；
5. TX 可以在一个帧周期内轮流发送多路数据；
6. ISP 能承受的是一定时间窗口内的平均输入和瞬时输入节奏。

因此，TDM 能稳定工作并不是因为：

```text
4 路 RAW 总速率 < 1 路 sensor RAW 速率
```

而是因为：

```text
多路 RAW 的总平均处理需求 <= TDM TX -> ISP 链路在一个帧周期内的总平均处理能力
```

speed down 解决的是第二层问题：

```text
即使平均能力够，TX 也不能以过高的突发速率冲击 ISP。
```

---

## 3. speed down 的本质

speed down 的本质是：

```text
在 TDM TX 发送过程中插入 invalid cycle，
降低有效发送周期比例，
把 TX burst 输出变成更平滑、更慢的输出。
```

可以把 TX 的发送窗口理解成 255 个周期：

```text
valid_num   = 允许发送有效 RAW 数据的周期数
invalid_num = 插入无效周期 / 空转周期数

valid_num + invalid_num = 255
```

举例：

```text
valid_num = 255, invalid_num = 0
```

表示 TX 近似满速输出。

```text
valid_num = 128, invalid_num = 127
```

表示 TX 大约一半时间发送有效数据，一半时间插入空周期。

```text
valid_num = 64, invalid_num = 191
```

表示 TX 明显降速。

因此：

```text
valid_num 越大 -> TX 有效发送占空比越高 -> TX 越快
valid_num 越小 -> invalid cycle 越多 -> TX 越慢
```

---

## 4. 为什么 TX 太快也会出问题

TDM TX 太快可能造成两类问题。

### 4.1 后级吃不下

如果 TDM TX 以很高 burst 速率向 ISP / bridge / FIFO 推数据，而后级处理节奏不匹配，就可能造成后级 FIFO 压力过大。

抽象为：

```text
TDM TX burst 太快
        ↓
ISP / bridge / FIFO 来不及消化
        ↓
出现 FIFO full / hsync 异常 / 时序异常
```

### 4.2 TX 读空导致 underflow

另一个容易忽略的问题是：TX 也可能太快，把当前 RX buffer / FIFO 读空。

抽象为：

```text
TX 读得太快
        ↓
当前 RX 数据还没准备够
        ↓
TX FIFO underflow
```

所以 speed down 既不是单纯防 overflow，也不是单纯防 underflow，而是控制 TX 节奏，使 RX、TX、ISP 之间的生产消费关系稳定。

---

## 5. 源码中的启用位置

在 `sunxi_tdm_top_s_stream()` 中，TDM 顶层打开时会配置：

```c
csic_tdm_set_rx_chn_cfg_mode(tdm->id, tdm->ws.rx_chn_mode);
csic_tdm_set_tx_chn_cfg_mode(tdm->id, tdm->ws.tx_chn_mode);
csic_tdm_set_work_mode(tdm->id, tdm->work_mode);
csic_tdm_set_speed_dn(tdm->id, tdm->ws.speed_dn_en);
```

随后初始化 TX：

```c
tdm_set_tx_blank(tdm);
csic_tdm_set_tx_t1_cycle(...);
csic_tdm_set_tx_fifo_depth(...);
csic_tdm_set_tx_t2_cycle(...);
```

如果 speed down 使能，则写入 TX data rate：

```c
if (tdm->ws.speed_dn_en) {
    csic_tdm_set_tx_data_rate(tdm->id,
                              tdm->tx_cfg.valid_num,
                              tdm->tx_cfg.invalid_num);
}
```

这说明 speed down 不是孤立功能，而是和 TX blank、TX FIFO depth、TX timing、RX/TX channel mode 一起构成 TDM TX 调度策略。

---

## 6. `tdm_set_rx_data_rate()` 的作用

`tdm_set_rx_data_rate()` 是 rate control 的核心计算函数。

它根据当前正在工作的 RX 通道统计：

```text
width
height
fps
vts
isp_clk
当前同时工作的 RX 数量
```

然后计算：

```text
tdm->tx_cfg.valid_num
tdm->tx_cfg.invalid_num
```

当前 Radxa commit 中，函数有一个重要限制：

```c
if (tdm->work_mode == TDM_ONLINE || !tdm->ws.speed_dn_en)
    return;
```

也就是说：

> 当前这份代码中，`tdm_set_rx_data_rate()` 的主要计算路径只在 **非 online 且 speed down 使能** 的场景下生效。

这点在分析时非常重要，不能简单认为所有 TDM 模式都会动态计算 `valid_num / invalid_num`。

---

## 7. 源码中的计算模型

源码注释给出了核心模型：

```c
/*
 * m: valid num, n: invalid num, m + n = 255
 * rx0 real work clock num: sum0 = ((w0*(255/m)+hb)*h0+(w0+hb)*vb)*fps0
 * rx1 real work clock num: sum1 = ((w1*(255/m)+hb)*h1+(w1+hb)*vb)*fps1
 * rx2 real work clock num: sum2 = ((w2*(255/m)+hb)*h2+(w2+hb)*vb)*fps2
 * rx3 real work clock num: sum3 = ((w3*(255/m)+hb)*h3+(w3+hb)*vb)*fps3
 * sum0 + sum1 + sum2 + sum3 = isp_clk
 * 255/m * wh_fps = (isp_clk - hh_fps - vw_fps - vh_fps)
 */
```

其中：

```text
m = valid_num
n = invalid_num
m + n = 255
```

各部分含义：

```text
w    = width
h    = height
fps  = sensor fps
hb   = hblank
vb   = vblank
```

源码中将多路 RX 的需求拆成几部分累加：

```c
wh_fps += width[i] * height[i] * fps[i];
hh_fps += TDM_TX_HBLANK_OFFLINE * height[i] * fps[i];
vw_fps += TDM_TX_VBLANK * width[i] * fps[i];
vh_fps += TDM_TX_HBLANK_OFFLINE * TDM_TX_VBLANK * fps[i];
```

可理解为：

```text
wh_fps：有效图像区域的数据需求
hh_fps：横向 blank 带来的周期开销
vw_fps：纵向 blank 带来的周期开销
vh_fps：横纵 blank 组合项
```

核心关系是：

```text
有效图像需求 + blank 开销 <= ISP 可用时钟预算
```

因为代码使用 `isp_clk * 90%`：

```c
isp_clk = tdm_rx->isp_clk / 100 * 90;
```

所以它不是把 ISP 时钟完全吃满，而是保留约 10% margin。

---

## 8. 非 one-buffer 分支

在未开启 `CONFIG_TDM_ONE_BUFFER` 时，源码主要按以下方式计算：

```c
wh_fps = roundup(wh_fps, 100);

tdm->tx_cfg.valid_num =
    DIV_ROUND_UP(
        10 * 255 * 128 /
        (128 * ((isp_clk - hh_fps - vw_fps - vh_fps) / 100)
        / (wh_fps / 100)),
        10
    );
```

可以近似理解为：

```text
valid_num ≈ 255 * wh_fps /
            (isp_clk - blank_overhead)
```

其中：

```text
blank_overhead = hh_fps + vw_fps + vh_fps
```

所以：

```text
图像有效数据需求越高 -> valid_num 越大
blank 开销越高       -> 可用于有效数据的预算越小 -> valid_num 越大
isp_clk 越高         -> valid_num 越小，TX 可以插入更多 invalid cycle
```

如果计算出的 `valid_num > 255`，源码会 clamp 到 255，并打印警告：

```c
if (tdm->tx_cfg.valid_num > 255) {
    tdm->tx_cfg.valid_num = 255;
    vin_warn("tdm tx valid_num morn than 255, you maybe need increase isp_clk\n");
}
```

这个警告的含义是：

> 当前多路 RX 的发送需求已经逼近或超过 ISP 时钟预算，TX 不能再通过减少 invalid cycle 解决，可能需要提高 `isp_clk` 或降低输入规格。

---

## 9. one-buffer 分支

开启 `CONFIG_TDM_ONE_BUFFER` 时，代码额外考虑 `vts` 和 vblank 百分比：

```c
vb_percentage[i] = 100 * (vts[i] - height[i]) / vts[i];
vb_percent_min = min(vb_percent_min, vb_percentage[i]);
```

然后计算：

```c
isp_need_clk = wh_fps + hh_fps + vw_fps + vh_fps;

if (n_rx_use > 1)
    isp_need_clk = isp_need_clk / n_rx_use * (n_rx_use - 1);

onebuffer_isp_need_clk = isp_need_clk / vb_percent_min * 100;

tdm->tx_cfg.valid_num = onebuffer_isp_need_clk / (isp_clk / 255);
tdm->tx_cfg.valid_num += 8;
```

可理解为：

1. 先计算多路 RX 总需求；
2. 根据同时使用 RX 数量修正；
3. 用最小 vblank 百分比估计 one-buffer 场景下可利用的排空窗口；
4. 计算所需 ISP 时钟占比；
5. 反推 `valid_num`；
6. 额外加 8 作为裕量。

one-buffer 模式下 buffer 缓冲能力更弱，所以计算更保守。

---

## 10. `invalid_num` 的计算

不管哪个分支，最后都会进入：

```c
if (tdm->tx_cfg.valid_num)
    tdm->tx_cfg.invalid_num = 255 - tdm->tx_cfg.valid_num;
else
    tdm->tx_cfg.invalid_num = 0;

csic_tdm_set_tx_data_rate(tdm->id,
                          tdm->tx_cfg.valid_num,
                          tdm->tx_cfg.invalid_num);
```

因此：

```text
valid_num = 0   -> invalid_num = 0
valid_num > 0   -> invalid_num = 255 - valid_num
valid_num = 255 -> invalid_num = 0
```

这里 `valid_num = 255` 表示基本不降速。

---

## 11. 寄存器层实现

寄存器字段定义在 `tdm200_reg_i.h` 中：

```c
#define TDM_TX_DATA_RATE_REG_OFF 0X018

#define TDM_TX_INVALID_NUM 0
#define TDM_TX_INVALID_NUM_MASK (0XFF << TDM_TX_INVALID_NUM)

#define TDM_TX_VALID_NUM 16
#define TDM_TX_VALID_NUM_MASK (0XFF << TDM_TX_VALID_NUM)
```

也就是说：

```text
TDM_TX_DATA_RATE_REG_OFF = 0x018
invalid_num 位于 bit[7:0]
valid_num   位于 bit[23:16]
```

写寄存器的函数在 `tdm200_reg.c` 中：

```c
void csic_tdm_set_tx_data_rate(unsigned int sel,
                               unsigned int valid_num,
                               unsigned int invalid_num)
{
    unsigned int num;

    num = ((valid_num & 0xff) << TDM_TX_VALID_NUM) +
          ((invalid_num & 0xff) << TDM_TX_INVALID_NUM);

    vin_reg_writel(csic_tdm_base[sel] + TMD_TX_OFFSET +
                   TDM_TX_DATA_RATE_REG_OFF, num);
}
```

因此硬件最终看到的是一个 32-bit value：

```text
bit[23:16] = valid_num
bit[7:0]   = invalid_num
```

---

## 12. 为什么不是“4 路 RAW 总速率必须小于单路 TX 速率”

这是分析 rate control 时最容易误解的点。

TDM 的 RX 侧和 TX 侧虽然都传 RAW，但它们不是同一条链路，也不是同一个时钟定义：

```text
sensor -> TDM RX：sensor 输入节奏
TDM TX -> ISP：TDM/ISP 内部发送节奏
```

所以不能拿“四路 RAW 输入”直接和“某一路 sensor RAW 速率”相比。

正确比较对象是：

```text
多路 RX 的长期平均输入需求
vs
TDM TX -> ISP 的长期平均处理能力
```

稳定条件是：

```text
sum(RX_i average demand) <= TX/ISP average capacity
```

只要长期平均成立，短时输入大于输出可以由 FIFO / DDR buffer 吸收；后续再利用 blank 窗口或空闲窗口排空。

如果长期平均不成立：

```text
sum(RX_i average demand) > TX/ISP average capacity
```

则必然：

```text
RX FIFO 积压
  -> DDR buffer 积压
  -> RX_BUF_FULL / RX_FIFO_FULL / RX_FRM_LOST
```

speed down 不会增加 TX 总能力，只会降低 TX 瞬时输出，因此不能修复这种总带宽不足。

---

## 13. 什么时候应该调 speed down

可以考虑 rate control / speed down 的场景：

1. 多路输入平均带宽没有超过 ISP 总能力；
2. 但运行中出现 TX 侧 FIFO underflow；
3. 或出现 speed down 相关 FIFO / hsync 异常；
4. 或 ISP / bridge 侧对 TDM TX burst 敏感；
5. 或需要降低 TDM TX 对后级的瞬时带宽冲击；
6. 或多路 WDR / offline 场景中 TX burst 过猛。

不应期望 speed down 解决：

1. sensor 总输入规格过高；
2. ISP clock 设置过低；
3. DDR / MBUS 总带宽不足；
4. buffer 数量不足导致的长期积压；
5. RX FIFO 持续 full；
6. frame lost 由上游输入过载导致。

---

## 14. 调试判断方法

### 14.1 看 `valid_num / invalid_num`

日志中通常会打印：

```c
vin_log(VIN_LOG_TDM,
        "tdm_rx%d %s, tx valid_num is %d, invalid_num is %d\n",
        tdm_rx->id,
        en ? "enable" : "disable",
        tdm->tx_cfg.valid_num,
        tdm->tx_cfg.invalid_num);
```

判断方式：

```text
valid_num 接近 255：
    TX 几乎满速，基本没有降速空间。
    如果仍然出错，可能需要提高 isp_clk 或降低输入规格。

valid_num 中等：
    TX 有一定 invalid cycle，处于 rate control 工作状态。

valid_num 很小：
    TX 被明显节流。
    如果 RX 侧开始积压，可能节流过度。
```

### 14.2 看异常类型

RX 侧异常：

```text
RX_BUF_FULL
RX_FIFO_FULL
RX_FRM_LOST
```

通常说明输入侧积压明显，可能是总输入需求过高、buffer 不够、DDR/MBUS 不足或 TX 排空能力不足。

TX 侧异常：

```text
TDM_FIFO_UNDER
SPEED_DN_FIFO_FULL
SPEED_DN_HSYNC_INT
```

更可能和 TX 节奏、speed down 参数、TX/ISP 同步关系有关。

### 14.3 看 `isp_clk`

如果代码打印：

```text
tdm tx valid_num morn than 255, you maybe need increase isp_clk
```

说明按当前输入规格和 blank 开销计算，已经需要超过最大有效发送占空比。此时继续调 speed down 没意义，应考虑：

```text
提高 isp_clk
降低 sensor 分辨率 / fps
减少同时输入路数
调整 blank / vts
增加 buffer 或优化 DDR 带宽
```

---

## 15. rate control 的正确心智模型

错误模型：

```text
4 路 RAW 同时进，1 路 TX 单路出，所以必然堵。
```

正确模型：

```text
RX 多路并行输入；
TX 单口时分复用输出；
中间有 FIFO / DDR buffer；
sensor 有 blank；
TX 有内部时钟；
ISP 有处理时钟；
rate control 控制 TX 的有效发送占空比。
```

最终稳定性看：

```text
长期平均输入 <= 长期平均输出能力
```

speed down 负责：

```text
控制 TX 瞬时输出节奏
```

它不负责：

```text
增加总带宽
```

---

## 16. 最终总结

TDM rate control / speed down 可以总结为：

> 在 V200 TDM 中，TX 不是简单地满速把 RX buffer 里的 RAW 推给 ISP，而是可以通过 `valid_num / invalid_num` 控制有效发送占空比。驱动根据多路 RX 的 width、height、fps、vts/vblank 和 isp_clk 估算 TX 所需速率，再写入 `TDM_TX_DATA_RATE_REG_OFF`。这样可以给 TX 插入 invalid cycle，降低突发输出，匹配 ISP 的处理节奏，避免 TX/ISP/FIFO 侧的节奏失配。

最重要的边界是：

```text
speed down 只能调节发送节奏，不能增加发送能力。
```

如果总输入需求超过总输出能力，最终还是会溢出；如果总平均能力足够但 TX burst 过猛，speed down 才是正确的调节手段。

---

## 17. 参考源码位置

```text
drivers/vin/vin-tdm/vin_tdm.c
  - sunxi_tdm_top_s_stream()
  - tdm_set_rx_data_rate()

drivers/vin/vin-tdm/tdm200/tdm200_reg.c
  - csic_tdm_set_tx_data_rate()

drivers/vin/vin-tdm/tdm200/tdm200_reg_i.h
  - TDM_TX_DATA_RATE_REG_OFF
  - TDM_TX_VALID_NUM
  - TDM_TX_INVALID_NUM
```
