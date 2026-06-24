# VIN 中 ISP-TDM 路由关系精简文档

> 本文基于与 agent 的多轮分析对话整理，聚焦 Allwinner VIN 中 **CSI / Parser / TDM / ISP / VIPP** 的关系。  
> 核心问题是：为什么 media graph 看起来是 `csi -> tdm_rx -> isp`，但寄存器路由仍然配置 `parser_id + parser_ch -> ISP virtual input`，而不是配置 `tdm_id -> ISP`。

---

## 1. 核心结论

在 VIN 全局代码里，需要区分三层关系：

```text
1. media graph 逻辑拓扑：
   csi -> tdm_rx -> isp -> vipp

2. CSIC TOP 硬件路由：
   parser_id + parser_ch -> ISP virtual input
   ISP tx channel -> VIPP

3. TDM 数据搬运 / 时分发送：
   RX buffer / pkg / LBC / speed down / TX 时分复用 -> ISP
```

这三层不是互斥关系，而是并行成立。

最关键的一句话：

> **Parser/channel 是数据来源身份，TDM 是中间搬运和时分调度模块，ISP virtual input 是 ISP 认领这份来源身份的处理槽位。**

因此，即使在 TDM offline 场景中，ISP 物理数据前级可能是 TDM TX，CSIC TOP 寄存器层暴露给软件的来源仍然是：

```text
parser_id + parser_ch
```

而不是：

```text
tdm_id
```

---

## 2. 为什么 media graph 是 `csi -> tdm_rx -> isp`

在 `vin_create_media_links()` 中，如果当前 pipeline 选择了 TDM，media graph 会先建立：

```text
csi -> tdm_rx
```

再建立：

```text
tdm_rx -> isp
```

典型代码形态如下：

```c
source = &csi->entity;
sink = &tdm_rx->entity;
ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
                            sink, VIN_SD_PAD_SINK,
                            ...);

source = &tdm_rx->entity;
sink = &isp->entity;
ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
                            sink, VIN_SD_PAD_SINK,
                            MEDIA_LNK_FL_ENABLED);
```

这说明从 **V4L2 media graph 逻辑拓扑** 看，TDM 确实位于 CSI 与 ISP 之间：

```text
CSI / Parser -> TDM_RX -> ISP
```

注意：源码里使用 `SCALER_PAD_SOURCE`、`VIN_SD_PAD_SINK` 这类宏，名字看起来不像 CSI/TDM pad，但其本质是 source/sink pad 索引值。代码写法比较复用/偷懒，不影响实际拓扑含义。

---

## 3. 为什么 `csic_isp_input_select()` 仍然选择 Parser/CSI

`csic_isp_input_select()` 不是 media graph 建链函数，而是 **CSIC TOP 硬件路由寄存器配置函数**。

它配置的是：

```text
某个 ISP physical id
某个 ISP virtual input
接收哪个 parser_id + parser_ch
```

典型代码如下：

```c
/* top_reg.c */

/* isp_id, isp_input, parser_id, parser_ch */
static char isp_input[4][4][4][4] = {
    ...
};

void csic_isp_input_select(unsigned int sel,
                           unsigned int isp,
                           unsigned int in,
                           unsigned int psr,
                           unsigned int ch)
{
    vin_reg_writel(csic_top_base[sel]
                   + CSIC_ISP0_IN0_REG_OFF
                   + isp * 16
                   + in * 4,
                   isp_input[isp][in][psr][ch]);
}
```

这里的维度已经把语义写死：

```text
isp_input[isp][in][psr][ch]
                  │    │
                  │    └── parser channel
                  └─────── parser id
```

所以寄存器层的 source namespace 本来就是：

```text
parser_id + parser_ch
```

而不是：

```text
tdm_id
```

---

## 4. `vin.c` 中的运行时路由配置

在 `CONFIG_ARCH_SUN8IW21P1` 场景中，`vin.c` 起流前会配置 parser 到 ISP virtual input 的绑定关系：

```c
#if defined (CONFIG_ARCH_SUN8IW21P1)
if (vinc->large_image == 3) {
    /* parserx ch0--isp0 ch0, parserx ch1-- isp1 ch0 */
    if (vinc->isp_sel == 0)
        csic_isp_input_select(vind->id,
                              vinc->isp_sel / ISP_VIRT_NUM,
                              vinc->isp_sel % ISP_VIRT_NUM + 0,
                              vinc->csi_sel,
                              0);
    else if (vinc->isp_sel == 1)
        csic_isp_input_select(vind->id,
                              vinc->isp_sel / ISP_VIRT_NUM,
                              vinc->isp_sel % ISP_VIRT_NUM + 0,
                              vinc->csi_sel,
                              1);
    else
        vin_warn("large image mode not support isp%d\n", vinc->isp_sel);
} else {
    if ((vinc->csi_ch != 0xff) && (vinc->csi_ch & 0x10)) {
        csic_isp_input_select(vind->id,
                              vinc->isp_sel / ISP_VIRT_NUM,
                              vinc->isp_sel % ISP_VIRT_NUM + 0,
                              vinc->csi_sel,
                              vinc->csi_ch & 0xf);
    } else {
        for (i = 0; i < vinc->total_rx_ch; i++)
            csic_isp_input_select(vind->id,
                                  vinc->isp_sel / ISP_VIRT_NUM,
                                  vinc->isp_sel % ISP_VIRT_NUM + i,
                                  vinc->csi_sel,
                                  i);
    }
}

csic_vipp_input_select(vind->id,
                       vinc->vipp_sel / VIPP_VIRT_NUM,
                       vinc->isp_sel / ISP_VIRT_NUM,
                       vinc->isp_tx_ch);
#endif
```

这段代码做的是：

```text
parser/csi channel -> ISP virtual input
ISP tx channel     -> VIPP
```

它不是在建立 media link，也不是在选择 TDM，而是在配置 CSIC TOP 层的硬件 mux。

---

## 5. 为什么不是 `tdm_id -> ISP`

原因有三点。

### 5.1 CSIC TOP 寄存器没有暴露 TDM 作为 ISP source

`csic_isp_input_select()` 的参数是：

```c
unsigned int isp,
unsigned int in,
unsigned int psr,
unsigned int ch
```

其中 `psr/ch` 明确是 parser id 和 parser channel。代码中没有类似：

```c
csic_isp_input_select_tdm(..., tdm_id)
```

或：

```text
ISP input source = TDMx
```

这样的选择路径。

### 5.2 TDM 的寄存器关注的是“怎么发”，不是“这路数据是谁”

TDM 自己配置的是：

```text
rx enable
rx_tx_enable
tx enable
rx channel mode
tx channel mode
work mode
speed down
data rate
blank
fifo depth
buffer address
```

典型代码形态如下：

```c
csic_tdm_set_rx_chn_cfg_mode(tdm->id, tdm->ws.rx_chn_mode);
csic_tdm_set_tx_chn_cfg_mode(tdm->id, tdm->ws.tx_chn_mode);
csic_tdm_set_work_mode(tdm->id, tdm->work_mode);

csic_tdm_set_speed_dn(tdm->id, tdm->ws.speed_dn_en);

tdm_set_tx_blank(tdm);
csic_tdm_set_tx_t1_cycle(tdm->id, tdm->tx_cfg.t1_cycle);
csic_tdm_set_tx_fifo_depth(tdm->id,
                           tdm->tx_cfg.head_depth,
                           tdm->tx_cfg.data_depth);

if (tdm->ws.speed_dn_en)
    csic_tdm_set_tx_data_rate(tdm->id,
                              tdm->tx_cfg.valid_num,
                              tdm->tx_cfg.invalid_num);

csic_tdm_tx_enable(tdm->id);
```

这些配置回答的是：

```text
哪些 RX 参与复用？
怎么发？
何时发？
按什么节拍发？
是否插 invalid cycle？
```

而不是：

```text
这帧数据原本是哪一路 sensor/parser？
```

### 5.3 `tdm_rx id` 不是稳定的数据来源身份

在 WDR 模式下，一个来源可能被复制到多个 TDM RX 槽位，例如：

```text
2F DOL WDR：一个源可能占用 rx0/rx1 或 rx2/rx3
3F DOL WDR：一个源可能占用 rx0/rx1/rx2
```

这说明 `tdm_rx id` 更像 TDM 内部缓存/调度槽位，不是全链路稳定的“数据身份”。

因此，用 `tdm_id` 作为 ISP 来源身份会混淆：

```text
来源身份
```

和：

```text
TDM 内部调度槽位
```

---

## 6. Parser 为什么是“来源身份”的产生点

Parser/channel 代表的是前端数据来源身份。

普通 CSI/MIPI VC 场景中，parser channel 数来自 sensor/CSI 配置：

```c
if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_0))
    csi->bus_info.ch_total_num++;
if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_1))
    csi->bus_info.ch_total_num++;
if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_2))
    csi->bus_info.ch_total_num++;
if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_3))
    csi->bus_info.ch_total_num++;
```

large image 场景中，parser 还会主动把一路大图拆成两个 parser channel：

```c
if (csi->large_image == 3) {
    csic_prs_ch_en(csi->id, 1);
    csi->bus_info.ch_total_num = 2;

    if (i == 0) {
        csi->out_size.hor_len = mf->width / 2 + overlayer;
        csi->out_size.hor_start = 0;
    } else {
        csi->out_size.hor_len = mf->width / 2 + overlayer;
        csi->out_size.hor_start = mf->width / 2 - overlayer;
    }

    csic_prs_output_size_cfg(csi->id, i, &csi->out_size);
}
```

因此，`parser_id + parser_ch` 是一种稳定的前端身份表达：

```text
这路数据来自哪个 parser？
是 parser 的哪个 channel？
```

ISP 后续绑定 virtual input 时，需要的正是这个身份。

---

## 7. ISP 为什么关心 virtual input

ISP 不只是被动接收一股像素流，它需要知道：

```text
这路数据落到哪个 ISP virtual input / channel？
```

因为 ISP 可能存在虚拟化和多上下文处理：

```text
virtual ISP -> logic ISP
```

VIN 通过：

```text
vinc->isp_sel / ISP_VIRT_NUM
vinc->isp_sel % ISP_VIRT_NUM
```

把一个前端来源绑定到某个 physical ISP 和某个 virtual input。

因此：

```text
parser/ch -> ISP virtual input
```

本质上是在告诉 ISP：

```text
这份来源身份归你哪个处理槽位处理。
```

---

## 8. ISP 参数加载与 parser 绑定不是同一层

之前分析中有一个需要修正的点：

> `PARA_LOAD_PD` 代码本身并不涉及 parser -> ISP 绑定表。

它只负责给当前 ISP 实例装入自己的参数上下文。

典型代码如下：

```c
if (bsp_isp_get_irq_status(isp->id, PARA_LOAD_PD)) {
    bsp_isp_clr_irq_status(isp->id, PARA_LOAD_PD);

    bsp_isp_set_para_ready(isp->id, PARA_NOT_READY);

    if (isp->load_flag)
        memcpy(isp->isp_load.vir_addr,
               &isp->load_shadow[0],
               ISP_LOAD_DRAM_SIZE);

    load_val = bsp_isp_load_update_flag(isp->id);

    bsp_isp_set_size(isp->id, &isp->isp_ob);
    bsp_isp_update_table(isp->id, (unsigned short)load_val);

    bsp_isp_set_para_ready(isp->id, PARA_READY);
}
```

这段只说明：

```text
当前 isp->id 有自己的 load_shadow
PARA_LOAD_PD 时把当前 ISP 实例的参数加载到硬件
```

它没有直接查 parser 绑定表，也没有调用 `csic_isp_input_select()`。

二者的关联不是在这段 ISR 里完成，而是通过上层的 `vinc->isp_sel / isp->id` 串起来：

```text
vinc->isp_sel
   ├─ 路由阶段：
   │    csic_isp_input_select(...)
   │    => parser/ch 绑定到某个 ISP virtual input
   │
   └─ pipeline 设备选择阶段：
        vind->isp[vinc->isp_sel].sd
        => 找到对应 isp_dev
             => isp_dev 持有自己的 load_shadow
                  => PARA_LOAD_PD 时装载该实例参数
```

所以更严谨的说法是：

```text
csic_isp_input_select()
    负责 parser/ch -> ISP virtual input 的前端绑定

PARA_LOAD_PD
    负责给当前 ISP 实例加载参数

vinc->isp_sel / isp->id
    是两层机制之间的桥
```

---

## 9. TDM 是否像一个“时分 DMA”

可以这么理解，但要加限定：

> **TDM 像一个带时分调度能力的专用 DMA / 搬运引擎，但不是透明 DMA。**

它在数据面上确实很像 DMA：

```text
前端收 RAW
落入 TDM RX buffer
可选 pkg / LBC
再由 TX 按时分节奏送给 ISP
```

典型代码形态：

```c
ret = tdm_rx_bufs_alloc(tdm_rx, size, tdm_buf_num);

csic_tdm_rx_set_buf_num(tdm->id, tdm_rx->id, ...);

for (i = 0; i < tdm_buf_num; i++)
    csic_tdm_rx_set_address(tdm->id,
                             tdm_rx->id,
                             (unsigned long)tdm_rx->buf[i].dma_addr);

if (tdm_rx->ws.tx_func_en)
    csic_tdm_rx_tx_enable(tdm->id, tdm_rx->id);
else
    csic_tdm_rx_tx_disable(tdm->id, tdm_rx->id);
```

但它不只是普通 DMA，因为它还负责：

```text
RX/TX channel mode
work mode
TX blank
TX fifo
speed down
valid_num / invalid_num
TX enable / cap enable
```

所以更准确的定义是：

```text
TDM = 带 RX 缓冲、可选 pkg/LBC、带 TX 时分发送器的中间搬运模块
```

---

## 10. CSI / ISP 是否需要感知 TDM

### 10.1 数据语义上：弱感知

从数据语义上看：

```text
CSI / Parser 负责产生 parser/channel 身份
TDM 负责缓存、搬运、时分发送
ISP 负责按 virtual input / context 处理
```

CSI 和 ISP 不需要理解 TDM 内部如何切时间片。

### 10.2 驱动控制上：不能完全无感

从驱动控制和资源时序上看，CSI / ISP 不能完全无视 TDM。

例如 ISP 启动/停止时可能要显式管理 TDM：

```c
csic_tdm_top_enable(...);
csic_tdm_enable(...);
csic_tdm_tx_enable(...);
csic_tdm_tx_cap_enable(...);

csic_tdm_rx_enable(...);
csic_tdm_rx_cap_enable(...);
```

stop 阶段也可能要求特定顺序：

```c
/* in offline mode, top tdm must close after top isp,
 * otherwise isp int will occur err
 */
csic_tdm_set_speed_dn(logic_id, 0);
csic_tdm_tx_cap_disable(logic_id);
csic_tdm_tx_disable(logic_id);
csic_tdm_disable(logic_id);
csic_tdm_top_disable(logic_id);
sunxi_tdm_buffer_free(logic_id);
```

所以最终结论是：

```text
TDM 对数据语义大体透明；
但对驱动控制、启停顺序、资源释放并不透明。
```

---

## 11. 三层对照图

```text
┌────────────────────────────────────────────┐
│ 1. 来源身份层                              │
│                                            │
│ Sensor / MIPI VC / large_image split       │
│        ↓                                   │
│ CSI Parser                                 │
│        ↓                                   │
│ parser_id + parser_ch                      │
│                                            │
│ 含义：这路数据是谁                         │
└────────────────────────────────────────────┘
                    │
                    │ csic_isp_input_select()
                    ▼
┌────────────────────────────────────────────┐
│ 2. ISP 认领 / 上下文层                     │
│                                            │
│ parser/ch -> ISP virtual input             │
│ vinc->isp_sel -> vind->isp[isp_sel].sd     │
│ isp_dev -> load_shadow                     │
│ PARA_LOAD_PD -> load/update table          │
│                                            │
│ 含义：这路数据落到哪个 ISP 槽位，装哪套参数 │
└────────────────────────────────────────────┘
                    ▲
                    │
                    │ TDM 物理/数据面可能在中间
                    │
┌────────────────────────────────────────────┐
│ 3. TDM 搬运 / 时分层                       │
│                                            │
│ TDM RX buffer                              │
│ pkg / LBC                                  │
│ rx_tx_enable                               │
│ rx_chn_mode / tx_chn_mode                  │
│ speed down / valid_num / invalid_num       │
│ TX -> ISP                                  │
│                                            │
│ 含义：这份数据怎么缓存、何时发、按什么节拍发 │
└────────────────────────────────────────────┘
```

---

## 12. 最终总结

精简成一句话：

> **Parser/channel 是 VIN 中稳定的数据来源身份；ISP virtual input 是 ISP 认领并处理这份身份的槽位；TDM 是中间的缓存、搬运和时分发送模块。**

因此：

```text
media graph 可以是：
    csi -> tdm_rx -> isp

CSIC TOP 路由仍然是：
    parser_id + parser_ch -> ISP virtual input

TDM 自己负责：
    buffer / pkg / LBC / speed down / TX 时分发送
```

不要把这三层混成一层。

最准确的 TDM 定位是：

> **像“时分 DMA”，但不是“透明 DMA”。它对数据面主要是搬运器，对控制面则是 VIN / CSI / ISP 都要协同管理的中间硬件块。**
