
**User**

基于之前分析，请你再回答我的一些问题
1、你所说的parser channel，是否是同一个 CSI 接收源（同一个 parser 实例）下面，同时存在 ch0/ch1/ch2/... 多个内部输出通道？sensor
  └─ MIPI CSI-2 link
      └─ csi_sel = 1   （同一个物理 CSI 接收口 / parser 实例）
           ├─ parser ch0  <- VC0
           ├─ parser ch1  <- VC1
           ├─ parser ch2  <- VC2
           └─ parser ch3  <- VC3

然后 VIN 再做路由：
parser ch0 -> isp input0
parser ch1 -> isp input1
parser ch2 -> isp input2
parser ch3 -> isp input3
这个拓扑对吗
2、如果驱动没有具体依据，那请你尽量根据现有源码内容推断一下，多VC是否是ISP内部硬件做出了input chn ->vinc_isp_tx_ch的一一映射，而WDR则是将多ISP input chn合并为一路vinc_isp_tx_ch？

---

**Cursor**

可以，这次我尽量把“**能被源码证明的**”和“**只能合理推断的**”分开讲。

---

# 1）你画的 parser channel 拓扑，对不对？

你画的是：

```text
sensor
  └─ MIPI CSI-2 link
      └─ csi_sel = 1   （同一个物理 CSI 接收口 / parser 实例）
           ├─ parser ch0  <- VC0
           ├─ parser ch1  <- VC1
           ├─ parser ch2  <- VC2
           └─ parser ch3  <- VC3

然后 VIN 再做路由：
parser ch0 -> isp input0
parser ch1 -> isp input1
parser ch2 -> isp input2
parser ch3 -> isp input3
```

## 结论：  
**这个拓扑从当前源码看，是基本正确的，而且是我目前认为最符合源码语义的理解。**

---

## 证据 1：parser 明确支持 4 个 channel

`parser_reg.h`：

```26:26:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-csi/parser_reg.h
#define MAX_CH_NUM 4
```

这说明 parser 模块的软件抽象里就有 4 个 channel。

---

## 证据 2：parser 寄存器里明确存在 CH0/CH1/CH2/CH3 的独立控制位

`parser_reg_i.h`：

```87:102:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-csi/parser_reg_i.h
#define CH0_SCAP_ON             0
#define CH0_VCAP_ON             1
#define CH0_SV_ON_MASK         (0X3 << CH0_SCAP_ON)
#define CH0_FPS_DS              2
#define CH0_FPS_DS_MASK        (0XF << CH0_FPS_DS)
#define CH1_SCAP_ON             8
#define CH1_VCAP_ON             9
#define CH1_SV_ON_MASK         (0X3 << CH1_SCAP_ON)
#define CH1_FPS_DS              10
#define CH1_FPS_DS_MASK        (0XF << CH1_FPS_DS)
#define CH2_SCAP_ON             16
#define CH2_VCAP_ON             17
#define CH2_SV_ON_MASK         (0X3 << CH2_SCAP_ON)
#define CH2_FPS_DS              18
#define CH2_FPS_DS_MASK        (0XF << CH2_FPS_DS)
#define CH3_SCAP_ON             24
#define CH3_VCAP_ON             25
#define CH3_SV_ON_MASK         (0X3 << CH3_SCAP_ON)
#define CH3_FPS_DS             26
#define CH3_FPS_DS_MASK        (0XF << CH3_FPS_DS)
```

这不是一个“单输出 parser”的样子，而是明显的：

- 同一个 parser 实例下
- 有 `ch0/ch1/ch2/ch3`
- 每个 channel 都能独立开 capture 模式

所以你说的：

> 同一个 `csi_sel`（同一个 parser 实例）下面，同时存在 `ch0/ch1/ch2/ch3`

这个判断是**有源码依据的**。

---

## 证据 3：CSI 驱动把 `CHANNEL_0..3` 直接统计成 `ch_total_num`

`sunxi_csi.c`：

```513:529:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-csi/sunxi_csi.c
static int sunxi_csi_s_mbus_config(struct v4l2_subdev *sd,
				   const struct v4l2_mbus_config *cfg)
{
	struct csi_dev *csi = v4l2_get_subdevdata(sd);

	if (cfg->type == V4L2_MBUS_CSI2 || cfg->type == V4L2_MBUS_SUBLVDS ||
	    cfg->type == V4L2_MBUS_HISPI) {
		csi->bus_info.bus_if = V4L2_MBUS_CSI2;
		csi->bus_info.ch_total_num = 0;
		if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_0))
			csi->bus_info.ch_total_num++;
		if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_1))
			csi->bus_info.ch_total_num++;
		if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_2))
			csi->bus_info.ch_total_num++;
		if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_3))
			csi->bus_info.ch_total_num++;
```

这里等价于：

- 一个 CSI/parser
- 根据 sensor 上报的 VC bit 数，得到有几个内部 channel 在工作

这和你画的拓扑完全吻合。

---

## 证据 4：VIN 会按 `total_rx_ch` 把 parser ch0/ch1/ch2/ch3 接到 ISP input0/1/2/3

`vin_video.c` 先把 `csi->ch_total_num` 赋给 `vinc->total_rx_ch`：

```1219:1224:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
	}
	media_entity_graph_walk_cleanup(&graph);

	csi = v4l2_get_subdevdata(pipe->sd[VIN_IND_CSI]);
	vinc->total_rx_ch = csi->bus_info.ch_total_num;
```

然后 `vin.c` 里按 `i = 0..total_rx_ch-1` 配 ISP 输入：

```1029:1037:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		} else {
			if ((vinc->csi_ch != 0xff) && (vinc->csi_ch & 0x10))
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, vinc->csi_ch & 0xf);
			else {
				for (i = 0; i < vinc->total_rx_ch; i++)
					csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + i, vinc->csi_sel, i);
			}
		}
```

再看 `csic_isp_input_select()`：

```228:232:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
void csic_isp_input_select(unsigned int sel, unsigned int isp, unsigned int in,
				unsigned int psr, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_ISP0_IN0_REG_OFF + isp * 16 + in * 4,
			isp_input[isp][in][psr][ch]);
}
```

这个函数的参数语义就是：

- `psr`：parser 实例
- `ch`：parser channel
- `in`：ISP input 编号

所以你画的：

```text
parser ch0 -> isp input0
parser ch1 -> isp input1
parser ch2 -> isp input2
parser ch3 -> isp input3
```

**从 VIN 软件路由逻辑上看，是对的。**

---

# 2）尽量基于现有源码推断：多VC 与 WDR 的关系

你问的是：

> 多VC是否是 ISP 内部硬件做出了 `input chn -> vinc_isp_tx_ch` 的一一映射，而 WDR 则是将多 ISP input chn 合并为一路 `vinc_isp_tx_ch`？

这个问题我分成两部分回答。

---

## 第一部分：多 VC 是否更像“一一映射”？

## 我的判断：**很像，而且这是目前最合理的推断。**

但注意，我说的是“**很像**”，不是“源码铁证”。

---

### 为什么说“很像”？

因为现在源码呈现出的结构是：

### 输入侧
- parser 有 4 个 channel
- VIN 按 `i=0..N-1` 把这些 channel 接到 ISP 的 `input0..inputN-1`

这是一种非常明显的 **并行多输入** 结构。

### 输出侧
- `vipp_input[vipp][isp][ch]`
- `csic_vipp_input_select(..., ch)`
- `ch` 就是 `isp_tx_ch`

说明软件层认知里，ISP 对外也存在 `ch0/ch1/ch2/ch3` 这样的可选输出源。

`top_reg.c` 直接说明了这一点：

```110:134:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
/*vipp_id isp_id isp_ch*/
static char vipp_input[8][4][4] = {
    // ...
};
```

注释已经写得很明白了：

- 第 1 维：`vipp_id`
- 第 2 维：`isp_id`
- 第 3 维：`isp_ch`

所以“多 VC 场景下，ISP 内部很可能把不同 input ch 维持成不同 output ch”，这是非常合理的。

---

### 但为什么我还说不是铁证？
因为源码里**没有看到一条直白规则**：

```c
input0 -> output_ch0
input1 -> output_ch1
input2 -> output_ch2
input3 -> output_ch3
```

它只是给了你：
- 输入是 0/1/2/3
- 输出可选也是 0/1/2/3

因此：

> **最自然、最符合现有代码组织的推断，就是多VC场景更像“input chn 与 output chn 一一对应保留”，而不是被 ISP 自动融合成一路。**

---

## 第二部分：WDR 是否更像“多 input 合并成一路 output”？

## 我的判断：**是的，这个推断比多VC的一一映射还更强。**

原因在于 WDR 本质就是多帧融合：

- 多个曝光输入
- 最后输出一帧融合结果

这本身就决定了它不像多 VC 那样是“多路并行独立流”。

---

### 源码上的支持点

虽然我这次没有继续往 `isp600_reg_cfg.c` 深挖 WDR 配置寄存器，但现有代码里已经有几个明显迹象：

#### 1）ISP 驱动中大量 WDR/DOL 专用处理
`sunxi_isp.c` 里有明显的 WDR/D3D 特殊缓冲、模式管理，这表明 ISP 会把多输入作为融合算法输入，而不是并列输出。

#### 2）TDM/WDR 场景下常常是多个 RX 对应一路 ISP 工作流
你之前看到的 TDM reset/start 逻辑里，`DOL_WDR` / `3FDOL_WDR` 会多开多个 `tdm_rx`，但它们不是分别变成多个 `videoX`，而是给 ISP 作为同一算法链的多帧输入。

也就是说，WDR 语义天然更像：

```text
input ch0 + input ch1 (+ input ch2)
   -> ISP融合
   -> 1 路输出
```

而不是：

```text
input ch0 -> output0
input ch1 -> output1
```

---

# 所以你这个推断，我会这样修正后给结论

## 对多 VC：
**很大概率是 ISP 内部维持多路独立通道，不融合，最终由 `isp_tx_ch` 选择取第几路。**

也就是更接近：

```text
parser ch0 -> isp input0 -> isp out ch0
parser ch1 -> isp input1 -> isp out ch1
parser ch2 -> isp input2 -> isp out ch2
parser ch3 -> isp input3 -> isp out ch3
```

这是**最符合现有源码结构的推断**。

---

## 对 WDR：
**更像 ISP 把多个 input chn 当作多曝光/多帧输入，在内部融合后输出一路结果。**

所以更接近：

```text
parser/tdm ch0 + ch1 (+ ch2)
   -> ISP WDR merge
   -> 1 路输出给某个 isp_tx_ch / VIPP
```

---

# 最后把两个问题分别做成一句话结论

## 问题 1：你的 parser channel 拓扑对吗？
**对，基本正确。**
从 `MAX_CH_NUM = 4`、`CH0~CH3` 独立寄存器位、`ch_total_num` 统计和 `for (i < total_rx_ch) csic_isp_input_select()` 这条链看，确实可以理解为：

- 同一个 `csi_sel/parser`
- 内部有 `ch0/ch1/ch2/ch3`
- VIN 再把这些 channel 接到 ISP 的多个 input

---

## 问题 2：多VC 是否一一映射，WDR 是否多路合一路？
### 我的谨慎结论：
- **多VC：非常像一一映射保留多路，再由 `isp_tx_ch` 选路**
- **WDR：非常像多 input 在 ISP 内部融合成一路输出**

### 但注意：
这仍然是“基于源码结构的高可信推断”，不是我已经在寄存器层面找到的最终铁证。

---

如果你愿意，下一步我建议继续做这个：

## 继续去追 `isp600_reg_cfg.c / isp600_reg.h`
目标是确认：
1. ISP 是否真的有 4 路 output ch 的寄存器定义
2. WDR 模式下是否存在“多 input -> 单 output”的明确寄存器语义
3. 普通多VC模式下是否能找到“input0->out0 / input1->out1”的底层证据

如果你要，我下一条就继续往 `isp600` 寄存器层挖。

