# VIN LargeMode 下 CSI -> TDM -> ISP 路由与数据竞争分析

更新时间：2026-04-17

## 1. 文档目的

本文结合下列资料，对 VIN 框架里 `large_image == 3` 的 `CSI -> TDM_RX -> ISP` 路由进行一次源码级梳理，并回答一个核心问题：

- 在 `ref.md` 这种单目 2in1 / LargeMode 配置里，`vinc0` 和 `vinc1` 都选了同一个 `MIPI0/CSI0`，会不会产生数据竞争？
- 还是说，驱动里本来就有专门的 LargeMode 分支来处理“同源大图拆成左右两路”？

本文主要基于：

- `ref.md`
- `KW33000_VIN_MULTI_VC_ANALYSIS.md`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin`

## 2. 先说结论

`ref.md` 这种配置不会按“两个 video 节点抢同一份 CSI 数据”的方式工作。  
前提是运行时进入了 `dma_merge_mode == 1`，从而强制进入 `large_image == 3` 这条专用路径。

在这条路径下，VIN 的行为是：

1. 同一个 `MIPI0/CSI0` 接收整张大图。
2. CSI parser 在硬件前端把一张大图拆成左右两路，分别对应 `parser ch0` 和 `parser ch1`。
3. 左右两路再分别进入 `tdm_rx0 / tdm_rx1`。
4. 然后分别进入两路 ISP 处理上下文。
5. 最后由 VIPP 裁掉 overlap，DMA 把左右半图写回同一个输出 buffer。

所以这里的关键不是“共用一个 CSI 是否危险”，而是：

- 有没有进入 `large_image == 3` 专门分支；
- 下游是否分别使用不同的 `tdm_rx_sel` 和 `isp_sel`；
- 是否开启了 `dma_merge_mode` 让两条 `vinc` 被成对绑定处理。

如果只是把 DTS 写成 `ref.md` 那样，但运行时没有进入 `dma_merge_mode / large_image == 3`，那就不能简单认为它自动具备 2in1 路由能力。

## 3. `ref.md` 的板级配置到底意味着什么

`ref.md` 中 LargeMode 相关的关键特征是：

- `vinc0` 和 `vinc1` 共用同一个 `csi_sel = 0`
- `vinc0` 和 `vinc1` 共用同一个 `mipi_sel = 0`
- 但它们的 `tdm_rx_sel` 不同：`0 / 1`
- 它们的 `isp_sel` 不同：`0 / 1`

文档中的示例大意如下：

```dts
vinc00:vinc@0 {
    vinc0_csi_sel = <0>;
    vinc0_mipi_sel = <0>;
    vinc0_isp_sel = <0>;
    vinc0_tdm_rx_sel = <0>;
    ...
};

vinc01:vinc@1 {
    vinc1_csi_sel = <0>;
    vinc1_mipi_sel = <0>;
    vinc1_isp_sel = <1>;
    vinc1_tdm_rx_sel = <1>;
    ...
};
```

这套配置表达的不是“两路独立输入”，而是：

- 一个输入源：`MIPI0 -> CSI0`
- 两个下游接收口：`TDM_RX0 / TDM_RX1`
- 两个后续处理上下文：`ISP0 / ISP1`

也就是说，它从设计上就是“一进两出”的结构。

## 4. VIN 框架里，CSI / TDM_RX / ISP 是怎么建链的

在媒体图创建时，如果当前 `vinc` 配了 `tdm_rx_sel`，VIN 会创建：

- `CSI -> TDM_RX`
- `TDM_RX -> ISP`

对应源码如下：

```c
/*tdm*/
if (vinc->tdm_rx_sel == 0xff)
	tdm_rx = NULL;
else
	tdm_rx = vind->tdm[vinc->tdm_rx_sel/TDM_RX_NUM].tdm_rx[vinc->tdm_rx_sel].sd;
/*isp*/
if (vinc->isp_sel == 0xff)
	isp = NULL;
else
	isp = vind->isp[vinc->isp_sel].sd;

if (tdm_rx != NULL) {
	source = &csi->entity;
	sink = &tdm_rx->entity;
	ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
				sink, VIN_SD_PAD_SINK, 0);

	source = &tdm_rx->entity;
	sink = &isp->entity;
	ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
				sink, VIN_SD_PAD_SINK,
				MEDIA_LNK_FL_ENABLED);
} else {
	source = &csi->entity;
	sink = &isp->entity;
	ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
				sink, VIN_SD_PAD_SINK,
```

这说明：

- 如果配了 `tdm_rx_sel`，数据不会直接从 CSI 进 ISP；
- 而是先进入 TDM，再由 TDM 输出到 ISP。

所以 `ref.md` 这种模式的完整链路是：

```text
Sensor -> MIPI0 -> CSI0(parser) -> TDM_RX0/1 -> ISP0/1 -> VIPP0/1 -> DMA
```

## 5. LargeMode 不是普通 CSI 单通道流程，而是专门把 parser 扩成双通道

在普通模式下，CSI 的接收通道数来自 sensor 的 `g_mbus_config()`，例如 `CHANNEL_0/1`。  
但在 `large_image == 3` 下，CSI 会强制进入双通道拆图模式：

```c
for (i = 0; i < csi->bus_info.ch_total_num; i++) {
	if (csi->large_image == 3) {
		csic_prs_ch_en(csi->id, 1);
		csi->bus_info.ch_total_num = 2;
		overlayer = vin_set_large_overlayer(mf->width);
		if (i == 0) {
			csi->out_size.hor_len = mf->width/2 + overlayer;
			csi->out_size.ver_len = mf->height;
			csi->out_size.hor_start = 0;
			csi->out_size.ver_start = 0;
		} else {
			csi->out_size.hor_len = mf->width/2 + overlayer;
			csi->out_size.ver_len = mf->height;
			csi->out_size.hor_start = mf->width/2 - overlayer;
			csi->out_size.ver_start = 0;
		}
	}
	csic_prs_input_fmt_cfg(csi->id, i, csi->csi_fmt->infmt);
	csic_prs_output_size_cfg(csi->id, i, &csi->out_size);
```

这段代码有两个关键点：

1. `csic_prs_ch_en(csi->id, 1)`  
   说明 parser 双通道被打开了。

2. `csi->bus_info.ch_total_num = 2`  
   说明这里不是普通的单路输出，而是明确变成了 2 路 parser 输出。

而且这两路不是“复制同一份完整图像”，而是：

- `i == 0`：左半图 + overlap
- `i == 1`：右半图 + overlap

也就是说，拆图发生在 CSI parser 这一层，而不是到后面才临时分。

## 6. 为什么说不是两个 `vinc` 在抢同一个 CSI 输出

如果只是两个 `vinc` 都去读同一个单通道输出，那才叫“竞争”。  
但 LargeMode 下不是这个模型。

在 `sun8iw21` 的 `vin.c` 里，针对 `large_image == 3` 有一条专门分支：

```c
#elif defined (CONFIG_ARCH_SUN8IW21P1)
	if (vinc->large_image == 3) {
		/* parserx ch0--isp0 ch0, parserx ch1-- isp1 ch0 */
		if (vinc->isp_sel == 0)
			csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, 0);
		else if (vinc->isp_sel == 1)
			csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, 1);
		else
			vin_warn("large image mode not support isp%d\n", vinc->isp_sel);
	} else {
		if ((vinc->csi_ch != 0xff) && (vinc->csi_ch & 0x10))
			csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, vinc->csi_ch & 0xf);
		else {
			for (i = 0; i < vinc->total_rx_ch; i++)
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + i, vinc->csi_sel, i);
		}
	}
	csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
```

这里可以非常明确地看到：

- `large_image == 3` 时走的是专门分支；
- `isp_sel == 0` 取 `parser ch0`；
- `isp_sel == 1` 取 `parser ch1`。

所以在 `ref.md` 这种配置里：

- `vinc0` 虽然也写 `csi_sel = 0`
- `vinc1` 也写 `csi_sel = 0`

但它们最终拿到的不是同一个 parser 输出：

- `vinc0 -> parser ch0`
- `vinc1 -> parser ch1`

因此不应把它理解为“两个 client 抢一条 CSI 数据流”。

## 7. TDM_RX 这一层为什么也不会互相抢

TDM RX 本身就是按 `rx channel` 分开的。  
在当前平台实现里可以看到：

```c
#define TDM_RX_NUM   2
```

而 `tdm_set_rx_cfg()` 是按 `tdm_rx->id` 分别配置每一路的：

```c
static int tdm_set_rx_cfg(struct tdm_rx_dev *tdm_rx, unsigned int en)
{
	struct tdm_dev *tdm = container_of(tdm_rx, struct tdm_dev, tdm_rx[tdm_rx->id]);
	...
	if (en) {
		if (tdm_rx->large_image == 3) {
			overlayer = vin_set_large_overlayer(tdm_rx->format.width);
			tdm_rx->format.width = tdm_rx->format.width/2 + overlayer;
		}
		csic_tdm_rx_set_min_ddr_size(tdm->id, tdm_rx->id, DDRSIZE_512b);
		csic_tdm_rx_input_bit(tdm->id, tdm_rx->id, tdm_rx->tdm_fmt->input_type);
		csic_tdm_rx_input_fmt(tdm->id, tdm_rx->id, tdm_rx->tdm_fmt->raw_fmt);
		csic_tdm_rx_input_size(tdm->id, tdm_rx->id, tdm_rx->format.width, tdm_rx->format.height);
```

也就是说：

- `vinc0` 绑定的是 `tdm_rx0`
- `vinc1` 绑定的是 `tdm_rx1`
- 两路各自有自己的输入尺寸、格式、buffer/config 状态

因此它们不是“都在读同一个 `tdm_rx0`”，而是各自占一个 RX channel。

## 8. 运行时为什么不是两个独立 `vinc` 各玩各的

LargeMode 还要求运行时开启 `dma_merge_mode`。  
驱动里一旦进入这个模式，就会把一对 `vinc` 绑定起来处理：

```c
/* must set before VIDIOC_S_INPUT */
static int vidioc_set_dma_merge(struct file *file, struct v4l2_fh *fh,
			unsigned char *dma_merge)
{
	struct vin_core *vinc = video_drvdata(file);

	/*dma_merge_mode = 1 mean video0 bind video1,video4 bind video5*/
	vinc->dma_merge_mode = *dma_merge;
	if (vinc->dma_merge_mode == 1) {
		if (vinc->id % 4 == 1 && vin_core_gbl[vinc->id - 1])
			vin_core_gbl[vinc->id - 1]->dma_merge_mode = *dma_merge;
	}

	return 0;
}
```

并且 `dma_merge_mode == 1` 会强制把 `large_image` 设成 `3`：

```c
cap->capture_mode = parms->parm.capture.capturemode;
if (vinc->dma_merge_mode == 1)
	parms->parm.capture.reserved[2] = 3;
vinc->large_image = parms->parm.capture.reserved[2];
/* large_image 3:large image separate to two picture */
```

这意味着 LargeMode 不是“DTS 配好就完事”，而是有一套 runtime binding 机制。

## 9. `set_fmt / s_parm / stream on/off` 都会同步到绑定的另一条 `vinc`

这也是避免“各配各的互相覆盖”的关键。

### 9.1 `VIDIOC_S_FMT` 会带上绑定路

```c
ret =  __vin_set_fmt(vinc, f);
if (ret < 0) {
	vin_err("set fmt%d error\n", vinc->id);
	return ret;
}

if (vinc->dma_merge_mode == 1) {
	if (vinc->id % 4 == 1 && vin_core_gbl[vinc->id - 1]) {
		vinc_bind = vin_core_gbl[vinc->id - 1];
		ret = __vin_set_fmt(vinc_bind, f);
		if (ret < 0)
			vin_err("set fmt%d error\n", vinc->id - 1);
	}
}
```

### 9.2 `VIDIOC_S_PARM` 会带上绑定路

```c
if (vinc->dma_merge_mode == 1) {
	if (vinc->id % 4 == 1 && vin_core_gbl[vinc->id - 1]) {
		vinc_bind = vin_core_gbl[vinc->id - 1];
		ret = __vin_s_parm(vinc_bind, parms);
		if (ret < 0)
			return ret;
	}
}
```

同时 `s_parm` 会继续往下传给：

- sensor
- CSI
- ISP
- TDM_RX
- SCALER

```c
ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SENSOR], video, s_parm, parms);
ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_CSI], video, s_parm, parms);
ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_ISP], video, s_parm, parms);
if (vinc->tdm_rx_sel != 0xff && cap->pipe.sd[VIN_IND_TDM_RX])
	v4l2_subdev_call(cap->pipe.sd[VIN_IND_TDM_RX], video, s_parm, parms);
v4l2_subdev_call(cap->pipe.sd[VIN_IND_SCALER], video, s_parm, parms);
```

### 9.3 `stream on/off` 也会同步操作绑定路

```c
if (vinc->dma_merge_mode == 1) {
#ifndef BUF_AUTO_UPDATE
	vin_set_next_buf_addr(vinc);
#endif
	if (vinc->id % 4 == 1 && vin_core_gbl[vinc->id - 1]) {
		vinc_bind = vin_core_gbl[vinc->id - 1];
		ret = vin_pipeline_call(vinc_bind, set_stream, &vinc_bind->vid_cap.pipe, vinc_bind->stream_idx);
		if (ret < 0)
			vin_err("video%d %s error!\n", vinc_bind->id, __func__);
		set_bit(VIN_STREAM, &vinc_bind->vid_cap.state);
	}
}
ret = vin_pipeline_call(cap->vinc, set_stream, &cap->pipe, cap->vinc->stream_idx);
```

`stream off` 也会把绑定路一起关掉：

```c
if (vinc->dma_merge_mode == 1) {
	if (vinc->id % 4  == 1 && vin_core_gbl[vinc->id - 1]) {
		vinc_bind = vin_core_gbl[vinc->id - 1];
		clear_bit(VIN_STREAM, &vinc_bind->vid_cap.state);
		vin_pipeline_call(vinc_bind, set_stream, &vinc_bind->vid_cap.pipe, 0);
		__csi_isp_setup_link(vinc_bind, 0);
		__vin_sensor_setup_link(vinc_bind, module, valid_idx, 0);
	}
}
```

所以 LargeMode 下，`vinc0/vinc1` 的关系并不是“两个互相独立的 video client”，而是“成对绑定的一主一辅”。

## 10. 大图为什么必须在 CSI/TDM/ISP 前半段就拆开

因为它的根本目标是把超过单路 ISP 处理上限的大图拆成两路较小宽度。

overlap 计算函数如下：

```c
unsigned int vin_set_large_overlayer(unsigned int width)
{
	unsigned int max_overlayer = 0,  min_overlayer = 0;
	unsigned int overlayer = 0;
	unsigned align = 16;
	unsigned int max_width = 3072;

#if defined CONFIG_ARCH_SUN8IW21P1
	max_width = ISP_MAX_WIDTH;
#endif

	min_overlayer = ALIGN(width / 61, align) * 3 + 16;
	if (min_overlayer / 2 + width / 2 > max_width) {
		vin_err("min overlayer/2 + width/2 is more than max_width, %d + %d > %d\n", min_overlayer / 2, width / 2, max_width);
		return overlayer;
	}

	max_overlayer = ALIGN(width / 57, align) * 7 - 16;
	overlayer = max_overlayer;
	while (overlayer / 2 + width / 2 > max_width)
		overlayer -= align / 2;

	return overlayer / 2;
}
```

这说明 LargeMode 的本质是：

- 原始整图太宽；
- 单路 ISP 吃不下；
- 所以必须在前端先切成左/右半图加 overlap；
- 然后再交给两路 ISP 处理。

这也解释了为什么它不能像 multi-VC 那样只靠同一个 ISP 的 `tx_ch0/1` 解决。  
`tx_ch` 只是“从哪个输出口取数据”，而 LargeMode 需要的是“在进入 ISP 之前就先完成左右拆图和独立处理”。

## 11. DMA 最终是怎么避免“左右两路各自完成、互相打架”的

LargeMode 最终不是输出两张图，而是把左右两半写回同一个 buffer。

```c
if (vinc->large_image == 3) {
	if (vinc->id % 4 == 1 && vin_core_gbl[vinc->id - 1]) {
		offset_width = frame->o_width/2;
		vinc_bind = vin_core_gbl[vinc->id - 1];
		csic_dma_buffer_address(vinc_bind->vipp_sel, CSI_BUF_0_A, paddr->y);
		csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_0_A, paddr->y + offset_width);
		...
	}
}
```

同时，偶数侧还会被弱化成从属路：

```c
if (vinc->large_image == 1)
	return;
if ((vinc->large_image == 3) && (vinc->id % 4 == 0))
	return;
```

```c
if ((vinc->large_image == 3) && vinc->vipp_sel % 4 == 0)
	csic_dma_int_disable(vinc->vipp_sel, DMA_INT_ALL);
```

这说明：

- 一路是主路，负责 frame/buffer/中断；
- 一路是从路，只负责把自己的半图写进去；
- 因此不会出现两边都把自己当成完整帧来上报的竞争。

## 12. 对“是否会数据竞争”的最终回答

### 12.1 在正确的 LargeMode 用法下，不会按“抢同一路数据”的方式竞争

原因是：

1. `CSI0` 在 `large_image == 3` 下会主动扩成双 parser 通道；
2. 左右半图分别对应 `parser ch0 / ch1`；
3. `vinc0` 和 `vinc1` 下游分别走 `tdm_rx0 / tdm_rx1`；
4. 它们再分别进入不同 ISP 处理上下文；
5. 运行时有 `dma_merge_mode` 把一对 `vinc` 绑定成主从协同工作。

因此它不是“两个节点抢一条原始流”，而是“同一输入源被硬件路由成两条处理路径”。

### 12.2 但如果只有 DTS，没有真正进入 `dma_merge_mode / large_image == 3`，就不能保证成立

也就是说，下面这个判断很重要：

- 不是“只要 `vinc0/vinc1` 共用 `CSI0/MIPI0` 就自动进入 2in1”
- 而是“必须同时满足 DTS 拓扑 + runtime merge mode + `large_image == 3` 分支”

如果缺少这几个条件中的任意一个，就不能直接套用 LargeMode 的无竞争结论。

## 13. 一句话总结

`ref.md` 里的单目 2in1 / LargeMode，不是两个 `vinc` 去抢同一个 `CSI0` 输出，而是 VIN 在 `large_image == 3` 的专门分支里，把同一个 `CSI0` 输入的大图通过 parser 拆成左右两路，再分别送给 `tdm_rx0/1` 和两路 ISP 处理，最后再合并输出。  
因此它本质上是“同源双路分发”，而不是“同源单路竞争”。
