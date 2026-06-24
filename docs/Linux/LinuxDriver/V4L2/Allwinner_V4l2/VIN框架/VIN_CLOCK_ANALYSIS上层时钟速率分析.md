# 全志 VIN 时钟与取流路径综合分析

更新时间: 2026-04-10

说明: 本文为合并版，综合整理以下两份文档内容，并补充当前源码状态下的新结论与交叉引用。

- `VIN_vind0_clk_analysis.md`
- `VIN_CLOCK_STREAM_ANALYSIS.md`

---

## 1. 文档目标

本文希望把下面几类问题统一讲清楚：

- `vind0_clk` 到底控制什么
- 为什么 `vind0_clk` 配置不当会导致采集失败，但 `sensor / ISP / MIPI` 看起来还能初始化
- 为什么 `200MHz` 不行，而 `340/360MHz` 往往可以正常出图
- `VIDIOC_STREAMON` 之后到底发生了什么，为什么问题更容易在首帧进入片内链路时暴露
- `time_hs / settle_time` 真正调的是什么
- VIN 里哪些是“独立可调频率时钟”，哪些只是 gate
- 结合当前 `kw33000` 自定义驱动，哪些现象是驱动自身实现方式放大的

本文对应源码范围：

- `self_driver/new_version/board0.dts`
- `self_driver/new_version/kw33000_mipi.c`
- `device/config/chips/v853/configs/vision/board.dts`
- `device/config/chips/v853/configs/100ask/board.dts`
- `lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi`
- `lichee/linux-4.9/drivers/clk/sunxi/clk-sun8iw21.c`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/`

---

## 2. 最核心结论

### 2.1 `vind0_clk` 控制的是 VIN top clock，不是 sensor `MCLK`

在 V853 / `sun8iw21p1` 上：

- DTS 中的 `vind0_clk`
- 被 VIN 驱动读入
- 保存到 `vind->clk[VIN_TOP_CLK].frequency`
- 最终设置到 `clk_csi_top`

关键代码：

- `VIN_TOP_CLK` 定义：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.h:31`
- `VIN_TOP_CLK = of_clk_get(np, 0)`：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:146`
- 读取 `vind0_clk`：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:259`
- `sun8iw21p1.dtsi` 中 `vind0` 第 0 个 clock 是 `clk_csi_top`：
  - `lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi:1326`

所以：

`vind0_clk` -> `VIN_TOP_CLK` -> `clk_csi_top`

它不是：

- sensor 外部参考时钟 `MCLK`
- ISP clock
- CCI clock

### 2.2 采集失败不等于初始化失败

如果 `vind0_clk` 配低，完全可能出现：

- sensor probe 成功
- 寄存器读写正常
- ISP 初始化正常
- MIPI subdev 也初始化正常
- 但一旦真正 `STREAMON`，VIN front-end 片内链路吞吐/时序余量不够，最终无帧、丢帧、超时或同步错误

本质上是：

- 控制面正常
- 数据面失败

### 2.3 `200MHz` 和 `340/360MHz` 的差别不只是“频率高低”

在 V853 上，`vind0_clk` 不同区间会走不同父时钟源：

- `200MHz` 通常落在外围 PLL 档
- `>300MHz` 会切到 CSI 专用 PLL 工作区

所以从 `200MHz` 升到 `340/360MHz`，通常同时带来：

- 更高的 top 工作频率
- 更合理的父时钟路径
- 更好的 VIN front-end 时序余量

### 2.4 `time_hs` 不是时钟，它是 MIPI RX PHY 调参值

`info->time_hs` 和运行时 `settle_time` 影响的是：

- MIPI D-PHY HS settle
- S2P 延时
- 接收端采样窗口

它们不等于：

- `vind0_clk`
- `MCLK`
- ISP clock

### 2.5 很多 VIN 子模块“有时钟控制位”，但并没有独立 rate

VIN 中不少模块只是 gate enable，并没有独立 `clk_set_rate()` 路径。

也就是说：

- `vind0_clk` 是主干频率
- combo/parser/post/bk/vipp 的很多控制位更像是开关门
- 门开了不等于它们可以脱离 `csi_top` 主干独立跑自己的 MHz

---

## 3. 当前工程上下文

### 3.1 平台

当前问题背景是 V853，对应架构为 `sun8iw21p1`，参考 DTS 为：

- `lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi`

### 3.2 当前 `board0.dts` 关键配置

当前自定义 `board0.dts` 里：

- `vind0_clk = <200000000>;`
  - `self_driver/new_version/board0.dts:53`
- `sensor0_mname = "kw33000_mipi";`
  - `self_driver/new_version/board0.dts:109`
- `sensor0_twi_cci_id = <2>;`
  - `self_driver/new_version/board0.dts:110`
- `sensor0_twi_addr = <0x70>;`
  - `self_driver/new_version/board0.dts:111`
- `sensor0_mclk_id` 当前被注释掉
  - `self_driver/new_version/board0.dts:112`

`vinc00` 选择关系：

- `vinc0_csi_sel = <1>;`
  - `self_driver/new_version/board0.dts:165`
- `vinc0_mipi_sel = <1>;`
  - `self_driver/new_version/board0.dts:166`
- `vinc0_isp_sel = <4>;`
  - `self_driver/new_version/board0.dts:167`
- `vinc0_isp_tx_ch = <0>;`
  - `self_driver/new_version/board0.dts:168`
- `work_mode = <0x0>;`
  - `self_driver/new_version/board0.dts:173`

关于 `vinc0_isp_sel = <4>`，按 `vin.c` 中的写法，V853 上 `isp_sel` 会按 `isp_sel / ISP_VIRT_NUM` 与 `isp_sel % ISP_VIRT_NUM` 拆分：

- `csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + i, ...)`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:1036`

而 `ISP_VIRT_NUM = 4`：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/isp600/isp600_reg_cfg.h:23`

因此当前 `vinc0_isp_sel = 4` 可以推导为：

- 物理 ISP 号 = `4 / 4 = 1`
- 虚拟输入号 = `4 % 4 = 0`

这是从源码逻辑推导出来的结论。

### 3.3 参考板对比

V853 参考配置不是 `200MHz`，而是：

- `340MHz`
  - `device/config/chips/v853/configs/vision/board.dts:106`
  - `device/config/chips/v853/configs/100ask/board.dts:106`

SoC 基础 DTS 默认值为：

- `300MHz`
  - `lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi:1321`

所以单从平台默认经验看，`200MHz` 已经明显偏低。

---

## 4. 当前 `kw33000` 驱动的重要状态

### 4.1 初始化路径被大幅简化

当前 `kw33000` 驱动里：

- `sensor_detect(sd)` 被注释掉：
  - `self_driver/new_version/kw33000_mipi.c:536`
- `vin_set_mclk_freq(sd, MCLK)` 被注释：
  - `self_driver/new_version/kw33000_mipi.c:607`
  - `self_driver/new_version/kw33000_mipi.c:619`
- `vin_set_mclk(sd, ON/OFF)` 被注释：
  - `self_driver/new_version/kw33000_mipi.c:608`
  - `self_driver/new_version/kw33000_mipi.c:617`
  - `self_driver/new_version/kw33000_mipi.c:642`

这意味着当前驱动更容易出现一种“假正常”：

- 日志看起来初始化没报错
- 但 sensor 身份验证不充分
- MCLK 标准时序流程没有走完整
- 真正问题要到开流后才暴露

### 4.2 当前 `kw33000` 模式参数

`kw33000` 当前设置：

- `info->time_hs = 0x30`
  - `self_driver/new_version/kw33000_mipi.c:589`
- 像素格式 `MEDIA_BUS_FMT_SBGGR12_1X12`
  - `self_driver/new_version/kw33000_mipi.c:952`
- `mipi_bps = 400 * 1000 * 1000`
  - `self_driver/new_version/kw33000_mipi.c:974`

### 4.3 当前 driver 内部存在模式不一致

注释写的是：

- `1-lane MIPI CSI-2`
  - `self_driver/new_version/kw33000_mipi.c:963`

但 `g_mbus_config()` 实际返回的是：

- `V4L2_MBUS_CSI2_2_LANE`
- `V4L2_MBUS_CSI2_CHANNEL_0 | V4L2_MBUS_CSI2_CHANNEL_1`
  - `self_driver/new_version/kw33000_mipi.c:992`

因此当前 `kw33000` 驱动本身就有一个重要不一致：

- 注释/模式说明是单 lane
- 实际总线 flags 是双 lane + 双 VC/channel

这个不一致本身就值得优先核对。

### 4.4 当前 `sensor_s_stream()` 行为

当前 `sensor_s_stream()` 在 enable 时会下发自定义寄存器流启动序列：

- `kw33000_load_stream_out_start_regs_v2(sd);`
  - `self_driver/new_version/kw33000_mipi.c:891`

disable 时则下发 stop 序列：

- `kw33000_load_stream_out_stop_regs(sd);`
  - `self_driver/new_version/kw33000_mipi.c:895`

也就是说，这个驱动的真正“开始吐像素流”边界，已经被放在 `sensor_s_stream()` 里。

---

## 5. VIN 相关时钟的职责划分

这部分是理解整件事的前提。

### 5.1 sensor `MCLK`

这是送给 sensor 芯片的外部参考时钟，通常来自 `csi_master0/1/2`。

对应时钟定义：

- `csi_master0/1/2`
  - `lichee/linux-4.9/drivers/clk/sunxi/clk-sun8iw21.c:461`

VIN 框架里 `MCLK` 的通用控制接口：

- `vin_set_mclk()`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/utility/vin_supply.c:134`
- `vin_set_mclk_freq()`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/utility/vin_supply.c:236`

它负责的是：

- sensor 是否按预期工作
- sensor 是否拿到参考时钟

它不负责片内 VIN front-end 的主吞吐。

### 5.2 `pclk`

`pclk` 是 sensor mode 里的时序参数，用来描述 sensor 本身的像素输出节奏。

例如：

- `kw33000`: `pclk = 33280000`
  - `self_driver/new_version/kw33000_mipi.c:973`
- `gc2053`: `pclk = 74250000`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/gc2053_mipi.c:2049`

### 5.3 `mipi_bps`

这是 sensor 串行链路速率，不是 VIN top clock。

例如：

- `kw33000`: `400Mbps`
  - `self_driver/new_version/kw33000_mipi.c:974`
- `gc2053`: 多数 1080p 模式是 `297Mbps`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/gc2053_mipi.c:2050`

### 5.4 `VIN_TOP_CLK`

也就是 `vind0_clk` 最终控制的 `csi_top`。

它负责 VIN/CSI front-end 主工作域。

关键代码：

- `VIN_TOP_CLK` 读取：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:146`
- `vind0_clk` 读入：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:259`
- 设置频率：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:340`

### 5.5 `VIN_ISP_CLK`

ISP clock 独立于 `vind0_clk`。

VIN 驱动单独读取 `vind0_isp`：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:208`

### 5.6 `VIN_MIPI_CLK` / `DPHY_CLK`

V853 上还有一条独立 MIPI clock：

- `vind->mipi_clk[VIN_MIPI_CLK]`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:216`
- rate 被设置成 `DPHY_CLK`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:237`

`DPHY_CLK` 定义：

- `150MHz`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/platform/platform_cfg.h:91`

这条时钟与 `vind0_clk` 不是同一条。

---

## 6. 为什么这些内部时钟由 VIN 驱动配置，而不是由 sensor 外部直接决定

### 6.1 sensor 在 SoC 外部，片内时钟树只能由 SoC 自己配置

sensor 只能通过自身模式参数告诉 SoC：

- 我用几 lane
- 我输出什么格式
- 我的大致链路速率是多少

但 SoC 片内：

- `csi_top`
- `isp`
- `mipi_clk`
- `vipp`
- `dma`

这些时钟资源都属于 SoC 自己的时钟树，只能由 VIN 驱动和时钟框架配置。

### 6.2 sensor 给的是需求，不是 SoC 片内频率答案

例如 sensor 给出：

- `mipi_bps = 400Mbps`
- RAW12
- 2 lane

这并不能直接推出：

- `csi_top` 应该等于多少
- `isp_clk` 应该等于多少

这些必须由 SoC 内部架构决定。

### 6.3 所以内部时钟不需要和 sensor 某个频率完全相等

不存在一个简单规则说：

- `top_clk = pclk`
- 或 `top_clk = mipi_bps / N`
- 或 `top_clk` 必须和 `MCLK` 相同

更合理的判断方式是：

- 片内 front-end 和后端处理链路是否能覆盖输入吞吐
- 是否有足够时序余量

---

## 7. `vind0_clk` 的父时钟选择与 V853 特性

### 7.1 `csi_top` 父时钟候选

`sun8iw21` 时钟驱动中：

- `csi_top_parents[] = {"pll_periph0300m", "pll_periph0400m", "pll_video0x4", "pll_csix4"}`
  - `lichee/linux-4.9/drivers/clk/sunxi/clk-sun8iw21.c:359`

### 7.2 VIN 驱动中的选择逻辑

在 `vin.c` 中，V853 对 `core_clk` 做如下选择：

- `<=150MHz` -> `tmp_clk_1`
- `<=200MHz` -> `tmp_clk_2`
- `<=300MHz` -> `tmp_clk_1`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:267`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:271`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:273`

在 `sun8iw21p1.dtsi` 的 `vind0` clocks 列表中：

- `tmp_clk_1` 对应 `clk_pll_periph0300m`
- `tmp_clk_2` 对应 `clk_pll_periph0400m`
  - `lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi:1331`

### 7.3 `__vin_set_top_clk_rate()` 的频率策略

`__vin_set_top_clk_rate()` 中：

- `rate >= 300MHz` -> source frequency = `rate`
- `150MHz <= rate < 300MHz` -> source frequency = `rate * 2`
- `75MHz <= rate < 150MHz` -> source frequency = `rate * 4`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:318`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:320`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:322`

而在 `sun8iw21p1` 上又有一个特殊点：

- 如果 `rate > 300MHz`
- source frequency 被强制拉到 `VIN_PLL_CSI_RATE = 2376MHz`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:328`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.h:49`

### 7.4 为什么 `200MHz` 和 `340/360MHz` 会差别很大

因为这不是简单的“输出频率差了 140MHz”。

它实际还意味着：

- 父时钟源可能变化
- 分频链路可能变化
- 是否进入 CSI 专用 PLL 区间也变化

这就是为什么 `200MHz` 很可能处在临界区，而 `340/360MHz` 会明显稳定得多。

---

## 8. 为什么 VIN 里有很多“时钟控制”，却仍然会被 `vind0_clk` 影响

### 8.1 真正独立可调频率的时钟

VIN 框架里真正有独立 rate 处理的主要是：

- `VIN_TOP_CLK`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:340`
- `VIN_ISP_CLK`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:368`
- `VIN_MIPI_CLK`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:237`
- sensor `MCLK`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/utility/vin_supply.c:236`

### 8.2 很多子模块只有 gate，没有独立 `clk_set_rate()`

例如：

- combo gate：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c:397`
- parser gate：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c:409`
- post gate：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c:423`
- bk/capture gate：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c:435`
- vipp gate：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c:445`

VIN core 里做的也是 gate enable：

- combo：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:521`
- parser：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:525`
- vipp：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:533`
- capture/bk：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:537`

### 8.3 这类 gate 只能控制“开/关”，不能决定“多快”

所以更准确的理解是：

- `vind0_clk` 决定主干频率
- 这些子模块大多只是挂在主干上的 gate 分支

换个比喻：

- `vind0_clk` 是总水压
- combo/parser/post/vipp/bk 的 `clk_en` 是阀门
- 阀门打开，并不意味着它们可以摆脱总管水压独立工作

这也是为什么你会看到“明明有自己的时钟控制”，但最终仍然会被 `vind0_clk` 影响。

---

## 9. 为什么“初始化正常、采集失败”是合理现象

### 9.1 初始化阶段主要是控制面

初始化通常只涉及：

- GPIO reset / pwdn
- PMU 上电
- CCI/I2C 通信
- sensor ID 检查
- subdev 注册
- ISP 基础寄存器初始化

这些动作都不是高吞吐数据路径。

### 9.2 当前 `kw33000` 更容易放大这个现象

因为它：

- 注释掉了 `sensor_detect()`
- 注释掉了标准 `MCLK` 控制路径

所以“看起来初始化没问题”这件事本身就不够有说服力。

### 9.3 标准驱动 `gc2053` 是更正常的对照组

`gc2053_mipi.c` 会：

- `vin_set_mclk_freq(sd, MCLK);`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/gc2053_mipi.c:1826`
- `vin_set_mclk(sd, ON);`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/gc2053_mipi.c:1827`
- 在 `sensor_init()` 中执行 `sensor_detect(sd);`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/gc2053_mipi.c:1943`

这类驱动通常更容易在初始化阶段就暴露 bring-up 问题。

### 9.4 真正问题在数据面

当 `vind0_clk` 太低时，最容易出问题的是：

- parser 吞吐不够
- front-end FIFO 余量不足
- frame done 不来
- pipeline 超时
- MIPI 同步 / ECC / checksum 错误

这就是为什么：

- probe/init 成功
- 但一到真实收流阶段失败

---

## 10. `VIDIOC_STREAMON` 之后到底发生了什么

这部分解释为什么问题更像是“首帧后暴露”。

### 10.1 用户态入口

用户态调用：

- `VIDIOC_STREAMON`

在 VIN 驱动中的入口：

- `vin-video/vin_video.c:2307`

其中实际调用：

- `vb2_ioctl_streamon(...)`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c:2328`

### 10.2 pipeline 的 `s_stream`

VIN pipeline 核心流控入口：

- `__vin_pipeline_s_stream(...)`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:956`

其中对各 subdev 的 `s_stream` 调用在：

- `v4l2_subdev_call(sd, video, s_stream, on);`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:944`

### 10.3 stream-on 前后会做的路由与选择

在 `on_idx` 打开路径时，VIN 会：

- 获取 sensor `g_mbus_config`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:1004`
- 如有需要修改 `VIN_TOP_CLK`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:1015`
- 做 `isp_input_select`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:1036`
- 做 `vipp_input_select`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:1039`

所以 stream-on 不是单纯“通知 sensor 开始出流”，而是整条 pipeline 真正进入接收状态的边界。

### 10.4 MIPI subdev `s_stream`

MIPI 侧在 `sunxi_mipi_subdev_s_stream()` 中：

- 读取 `res->res_mipi_bps`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:600`
- 设置 `dphy_freq = DPHY_CLK`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:602`
- 决定 `time_hs`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:614`
- 在 enable 时调用 `combo_csi_init(sd);`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:640`

### 10.5 为什么问题往往在首帧到来后暴露

在 probe/init 阶段：

- 没有持续真实像素流
- 所以片内 parser / FIFO / ISP input / DMA 还没有受到持续吞吐压力

在 `STREAMON` 之后：

1. MIPI / CSI / ISP / capture 路由全部准备好
2. sensor `s_stream(1)` 开始吐数据
3. 首批真实像素进入 front-end
4. 如果 `vind0_clk` 不够，问题此时才会集中暴露

因此从工程经验和源码逻辑上看，`vind0_clk` 导致的故障更可能体现在：

- `VIDIOC_STREAMON` 之后
- 首帧进入 parser / ISP / DMA 时

而不是 probe/init 阶段。

---

## 11. 为什么 `vind0_clk` 还会间接影响 MIPI 接收时序观察

MIPI 驱动里有一个很关键的细节：

- `dphy_clk = clk_get_rate(vind->clk[VIN_TOP_CLK].clock) / 1000000;`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:1189`

随后：

- `mipi_bps = 1000 * dphy_clk * 8 / phy_freq_cnt;`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:1191`

底层 helper 还会用 `dphy_clk` 去计算：

- RX delay
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/bsp_mipi_csi_v1.c:95`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/bsp_mipi_csi_v1.c:103`
- LP reset delay
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/bsp_mipi_csi_v1.c:108`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/bsp_mipi_csi_v1.c:111`
- D-PHY timing
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/bsp_mipi_csi_v1.c:123`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/bsp_mipi_csi_v1.c:130`

也就是说，`vind0_clk` 不只是 front-end 主干频率，它还会进入一部分 MIPI timing 观测/换算背景。

---

## 12. `time_hs` 与 `settle_time`

### 12.1 默认来源

在 `kw33000` 里：

- `info->time_hs = 0x30`
  - `self_driver/new_version/kw33000_mipi.c:589`

### 12.2 运行时优先级

MIPI driver 里：

- 如果 `mipi->settle_time > 0`
  - 优先用运行时 sysfs 写入值
- 否则如果 `res->res_time_hs`
  - 用 sensor driver 传入值
- 否则
  - 用 VIN 内部默认值

对应代码：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:614`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:615`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:616`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:617`

### 12.3 作用对象

最终会写到：

- `cmb_rx_mipi_stl_time(...)`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:347`
- `cmb_s2p_ctl(...)`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:509`

因此它真正影响的是：

- D-PHY HS settle
- S2P 延时
- MIPI 接收端锁定窗口

它不能替代：

- 正确的 `vind0_clk`
- 正确的 `MCLK`
- 正确的 lane/channel 配置

---

## 13. 为什么 `200MHz` 比 `340MHz` 更危险

综合源码和参考板配置，可以把当前问题理解成：

- V853 参考板常用 `340MHz`
- SoC 默认 DTS 也给了 `300MHz`
- 你的自定义配置是 `200MHz`

而当前 `kw33000` 又具备：

- RAW12
- `mipi_bps = 400Mbps`
- 自定义 stream on/off
- lane/channel 定义与注释不一致

在这种背景下，把 `200MHz` 看成：

- 也许能完成初始化
- 但对真实收流链路缺乏足够余量

是完全合理的工程判断。

---

## 14. 典型故障现象与日志

### 14.1 VIN video 层

- `Video%d over 2s no frame received`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c:2126`
- `pipeline reset after interrupt timeout`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c:326`

### 14.2 MIPI 层

可能出现：

- `MIPI_FRAME_SYNC_ERR`
- `MIPI_LINE_SYNC_ERR`
- `MIPI_ECC_WRN`
- `MIPI_ECC_ERR`
- `MIPI_CHKSUM_ERR`
- `MIPI_EOT_ERR`

对应代码：

- 中断使能：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:550`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:551`
- 状态处理：
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:945`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:949`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:953`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:957`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:961`
  - `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:965`

---

## 15. 推荐调试顺序

### 15.1 第一步：先把 `vind0_clk` 拉回稳定区

建议先不要用 `200MHz` 挣扎，直接先试：

- `300MHz`
- 或参考板的 `340MHz`

如果恢复到 `300/340MHz` 后就正常出图，那么根因基本可以确认就在 VIN top working range。

### 15.2 第二步：核对 `kw33000` 的 lane / channel / mode

优先核对：

- 注释里的 1-lane 是否仍然成立
- `g_mbus_config()` 返回的 `2-lane + channel0/channel1` 是否才是实际设计
- sensor 真正输出的是 1 VC 还是多 VC

### 15.3 第三步：恢复标准 sensor bring-up 逻辑

建议至少恢复：

- `sensor_detect(sd)`
- `vin_set_mclk_freq(sd, MCLK)`
- `vin_set_mclk(sd, ON/OFF)`

否则会持续存在“初始化假正常”的判断噪声。

### 15.4 第四步：最后再调 `time_hs / settle_time`

只有在：

- `vind0_clk` 已经进入稳定区
- lane / channel 定义正确
- sensor 已确认出流正常

之后，再去扫 `settle_time` 才是有效调试。

---

## 16. 一句话总结

`vind0_clk` 配低不会优先把 sensor 初始化打死，因为初始化主要依赖独立的 `MCLK / CCI / GPIO / PMU`。  
它真正影响的是 VIN 片内 front-end 数据通路，所以更合理的故障窗口不是 probe/init，而是 `VIDIOC_STREAMON` 之后首帧进入 `MIPI / parser / ISP / DMA` 时。  
`200MHz` 提升到 `340/360MHz` 之所以往往就能恢复，不只是频率变高，而是整个 `csi_top` 的工作区间和父时钟路径一起变得更合理了。

---

## 17. 关键源码索引

- `self_driver/new_version/board0.dts`
- `self_driver/new_version/kw33000_mipi.c`
- `device/config/chips/v853/configs/vision/board.dts`
- `device/config/chips/v853/configs/100ask/board.dts`
- `lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi`
- `lichee/linux-4.9/drivers/clk/sunxi/clk-sun8iw21.c`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.h`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/bsp_mipi_csi_v1.c`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/utility/vin_supply.c`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/gc2053_mipi.c`
