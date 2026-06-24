# 单目 2in1 大分辨率支持模式分析

本文结合 `ref.md` 的官方说明，以及 `lichee/linux-4.9/drivers/media/platform/sunxi-vin` 里的实现，分析 V85X/V853 平台上“单目 2in1 模式”的工作方式，并给出关键源码片段。

## 1. 结论先行

从驱动实现看，官方文档里的“单目 2in1 大分辨率支持模式”，在 VIN 驱动中对应的是：

- `VIDIOC_SET_DMA_MERGE` 打开 `dma_merge_mode`
- 驱动在 `VIDIOC_S_PARM` 阶段强制把 `large_image` 设为 `3`
- 由一对 `vinc` 节点共同完成一张大图的处理和输出

也就是说，这个模式对应的不是 `large_image == 2`，而是：

```text
dma_merge_mode == 1 + large_image == 3
```

其本质流程是：

```text
单个 Sensor0 输出一张大图
  -> CSI/TDM 将大图拆成左右两路，且保留中间 overlap
  -> 左右两路分别进入不同 ISP 通道处理
  -> VIPP 将两路 overlap 裁掉，只保留最终左右半幅
  -> 两路 DMA 把左右半幅写入同一个最终输出 buffer
  -> 用户空间拿到一张源尺寸图像
```

## 2. 官方文档中的关键信息

`ref.md` 中与该模式最直接相关的内容如下：

```text
V85X 2in1 模式：支持（8M、12M、20M 像素等）高分辨率图像输入，SOC 在通路中将大图拆
分为小图分别处理后，最终拼接回源尺寸图像输出。如下图所示，原图分辨率：4032x3016，
ISP0/ISP1 分别处理左右半图（分辨率：2288x3016），其中蓝色区域为中间缝合区（分辨率：
272x3016，用于 ISP 处理中间图像效果，改善中间区域的拼接痕迹）。

PS：V85X ISP 能处理的最大分辨率为 3072x3072，所以高于这个分辨率的图像均需要开启 2in1 模
式来进行处理。

• CSI 接收源尺寸图像
• 按照比例原图拆分为左右部分，分别送给 ISP0/1 通道
• ISP0/1 进行图像处理，VIPP 以源尺寸输出图像
```

这段话对应到驱动代码，有三个非常明确的含义：

1. 单路 ISP 的最大处理宽度有限，所以超出上限的大图必须拆分。
2. 拆分不是简单对半，而是左右两路都保留一段中间 overlap，用来改善拼接效果。
3. 最终输出不是两张图，而是回到一张源尺寸图像。

## 3. DTS 配置在 VIN 框架里的含义

官方文档要求把 `vinc0/1`、`vinc4/5`、`vinc8/9`、`vinc12/13` 成对打开，并都指向同一个 `Sensor0`。这与驱动如何解析 `vinc` 属性是完全一致的。

`vin_core.c` 里，`vinc` 设备启动时会从 DTS 读取 `csi_sel / mipi_sel / isp_sel / tdm_rx_sel` 等属性，同时把 `vipp_sel` 直接设成自身的 `pdev->id`：

```c
sprintf(property_name, "vinc%d_csi_sel", pdev->id);
if (of_property_read_u32(np, property_name, &vinc->csi_sel))
	vinc->csi_sel = 0;

sprintf(property_name, "vinc%d_mipi_sel", pdev->id);
if (of_property_read_u32(np, property_name, &vinc->mipi_sel))
	vinc->mipi_sel = 0xff;

sprintf(property_name, "vinc%d_csi_ch", pdev->id);
if (of_property_read_u32(np, property_name, &vinc->csi_ch))
	vinc->csi_ch = 0xff;

sprintf(property_name, "vinc%d_isp_sel", pdev->id);
if (of_property_read_u32(np, property_name, &vinc->isp_sel))
	vinc->isp_sel = 0;

sprintf(property_name, "vinc%d_isp_tx_ch", pdev->id);
if (of_property_read_u32(np, property_name, &vinc->isp_tx_ch))
	vinc->isp_tx_ch = 0;

sprintf(property_name, "vinc%d_tdm_rx_sel", pdev->id);
if (of_property_read_u32(np, property_name, &vinc->tdm_rx_sel))
	vinc->tdm_rx_sel = 0;

vinc->vipp_sel = pdev->id;

vinc->id = pdev->id;
```

因此，文档中的 `vinc0/vinc1` 其实就是：

- 共用同一个 `sensor0`
- 共用同一个 `CSI0/MIPI0`
- 分别走不同的 `tdm_rx`
- 分别走不同的 `isp_sel`
- 自动对应不同的 `vipp_sel`

这正是“单目 2in1”的核心：不是两个 Sensor，而是一个 Sensor 被拆成两路 VIN 处理链。

## 4. 为什么文档只配置 `scaler@0/@4/@8/@12`

文档里只给了 `scaler@0`、`scaler@4`、`scaler@8`、`scaler@12` 的 `work_mode`，看起来像没给 `vipp1/5/9/13` 配置。但驱动其实有“逻辑 VIPP”和“虚拟 VIPP”之分。

VIPP 虚拟到逻辑的映射是：

```c
int vipp_virtual_find_logic[16] = {
	0, 0, 0, 0, 4, 4, 4, 4, 8, 8, 8, 8, 12, 12, 12, 12,
};
```

而 `sunxi_scaler.c` 会把逻辑节点的 `work_mode` 传播给同组虚拟节点：

```c
if (scaler->id == vipp_virtual_find_logic[scaler->id]) {
	scaler->work_mode = clamp_t(unsigned int, scaler->work_mode, VIPP_ONLINE, VIPP_OFFLINE);
} else if (scaler->work_mode == 0xff) {
	logic_scaler = glb_vipp[vipp_virtual_find_logic[scaler->id]];
	if (logic_scaler->work_mode == VIPP_ONLINE) { /*logic vipp work in online*/
		vin_log(VIN_LOG_VIDEO, "scaler%d work in online mode, scaler%d cannot to work!\n", logic_scaler->id, scaler->id);
		__scaler_init_subdev(scaler);
```

所以：

- `vipp0/1/2/3` 共享逻辑节点 `0`
- `vipp4/5/6/7` 共享逻辑节点 `4`
- `vipp8/9/10/11` 共享逻辑节点 `8`
- `vipp12/13/14/15` 共享逻辑节点 `12`

这就解释了文档为什么只配置 `scaler@0/@4/@8/@12`。

ISP 侧也是类似的虚拟/逻辑映射：

```c
int isp_virtual_find_logic[ISP600_MAX_NUM + 1] = {
	0, 0, 0, 0, 4
};
```

```c
if (isp->id == isp_virtual_find_logic[isp->id]) {
	isp->work_mode = clamp_t(unsigned int, isp->work_mode, ISP_ONLINE, ISP_OFFLINE);
} else if (isp->work_mode == 0xff) {
	logic_isp = glb_isp[isp_virtual_find_logic[isp->id]];
	if (logic_isp->work_mode == ISP_ONLINE) { /*logic isp work in online*/
		vin_log(VIN_LOG_VIDEO, "isp%d work in online mode, isp%d cannot to work!\n", logic_isp->id, isp->id);
		isp->is_empty = 1;
```

这意味着文档中“ISP0/ISP1 分别处理”更准确地说，是两个 ISP 虚拟通道参与处理。

## 5. 为什么文档要求 TDM / ISP / VIPP 都设为离线模式

文档里明确写了：

```dts
tdm0:tdm@0 {
	work_mode = <1>;
};

isp00:isp@0 {
	work_mode = <1>;
};

scaler00:scaler@0 {
	work_mode = <1>;
};
```

驱动枚举里，`1` 就是 `OFFLINE`：

```c
enum tdm_work_mode {
	TDM_ONLINE = 0,
	TDM_OFFLINE = 1,
};
```

```c
enum isp_work_mode {
	ISP_ONLINE = 0,
	ISP_OFFLINE = 1,
};
```

```c
enum vipp_work_mode {
	VIPP_ONLINE = 0,
	VIPP_OFFLINE = 1,
};
```

这和 2in1 的设计是相符的，因为这条链路需要：

- 同时维护两路处理链
- 在中间模块缓存、裁剪、再输出
- 最终通过 DMA 合并到同一张图

离线模式更适合这种需要中间缓冲和双路拼接的处理。

## 6. VIN 媒体框架里，这条链路是怎么串起来的

`vin.c` 会在媒体图里把各子设备连成一条完整链路。对于有 TDM 的场景，代码是：

```c
if (tdm_rx != NULL) {
	source = &csi->entity;
	sink = &tdm_rx->entity;
#if defined CONFIG_MIPI_VC
	ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
					sink, VIN_SD_PAD_SINK,
					MEDIA_LNK_FL_ENABLED);
#else
	ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
					sink, VIN_SD_PAD_SINK,
					0);
#endif
	vin_log(VIN_LOG_MD, "created link [%s] %c> [%s]\n",
		source->name, '=', sink->name);

	source = &tdm_rx->entity;
	sink = &isp->entity;
	ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
					sink, VIN_SD_PAD_SINK,
					MEDIA_LNK_FL_ENABLED);
	vin_log(VIN_LOG_MD, "created link [%s] %c> [%s]\n",
		source->name, '=', sink->name);
} else {
	source = &csi->entity;
	sink = &isp->entity;
	ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
					sink, VIN_SD_PAD_SINK,
					MEDIA_LNK_FL_ENABLED);
	vin_log(VIN_LOG_MD, "created link [%s] %c> [%s]\n",
		source->name, '=', sink->name);
}
```

后续再接到 `SCALER(VIPP)`、`VIN Core` 和 `video node`：

```c
/* SCALER */
scaler = vind->scaler[i].sd;
if (scaler == NULL)
	continue;
/*Link Vin Core*/
source = &scaler->entity;
sink = &cap_sd->entity;
ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
			       sink, VIN_SD_PAD_SINK,
			       MEDIA_LNK_FL_ENABLED);
if (ret)
	break;

/* Notify vin core subdev entity */
ret = media_entity_call(sink, link_setup, &sink->pads[0],
				&source->pads[SCALER_PAD_SOURCE],
				MEDIA_LNK_FL_ENABLED);
if (ret)
	break;

vin_log(VIN_LOG_MD, "created link [%s] %c> [%s]\n",
	source->name, '=', sink->name);

source = &cap_sd->entity;
sink = &vinc->vid_cap.vdev.entity;
ret = media_create_pad_link(source, VIN_SD_PAD_SOURCE,
			       sink, 0, MEDIA_LNK_FL_ENABLED);
```

所以单目 2in1 的 VIN 框架路径可以概括为：

```text
Sensor0
  -> CSI
  -> TDM_RX0 / TDM_RX1
  -> ISP0 / ISP1
  -> VIPP0 / VIPP1
  -> VIN Core
  -> 同一张最终输出 buffer
```

## 7. runtime 开关：2in1 模式如何落到 `large_image == 3`

用户空间先通过私有 ioctl 打开 `dma_merge_mode`：

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

然后在 `VIDIOC_S_PARM` 时，驱动把 `large_image` 强制改成 `3`：

```c
cap->capture_mode = parms->parm.capture.capturemode;
if (vinc->dma_merge_mode == 1)
	parms->parm.capture.reserved[2] = 3;
vinc->large_image = parms->parm.capture.reserved[2];
/* large_image 3:large image separate to two picture */

ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SENSOR], video, s_parm,
			parms);
if (ret < 0)
	vin_warn("v4l2 subdev sensor s_parm error!\n");

ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_CSI], video, s_parm,
			parms);
if (ret < 0)
	vin_warn("v4l2 subdev csi s_parm error!\n");

if (inst->is_isp_used) {
	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_ISP], video, s_parm,
				parms);
	if (ret < 0)
		vin_warn("v4l2 subdev isp s_parm error!\n");
}

if (vinc->tdm_rx_sel != 0xff && cap->pipe.sd[VIN_IND_TDM_RX])
	v4l2_subdev_call(cap->pipe.sd[VIN_IND_TDM_RX], video, s_parm,
		parms);

v4l2_subdev_call(cap->pipe.sd[VIN_IND_SCALER], video, s_parm,
		parms);
```

因此，2in1 模式在整个 VIN 子设备树里，是通过 `reserved[2]` 这个字段一路下发到各模块的。

## 8. Sensor 侧如何感知到 2in1 模式

`sensor_helper.c` 中，Sensor 侧接收到 `large_image == 3` 后，会把当前窗口信息打包给上层：

```c
if (info->large_image == 3) {
	overlayer = vin_set_large_overlayer(info->current_wins->width_input);
	cfg->width = info->current_wins->width_input + ((info->current_wins->width_input / 2 + overlayer) << 16);
} else
	cfg->width = info->current_wins->width_input;
cfg->height = info->current_wins->height_input;
cfg->hoffset = info->current_wins->hoffset;
cfg->voffset = info->current_wins->voffset;
cfg->hts = info->current_wins->hts;
```

这里 `cfg->width` 在 `large_image == 3` 时被打包成一种“低 16 位保留原始输入宽度，高 16 位携带半图宽度”的形式，这说明上层确实需要知道“原始大图宽度”和“拆分后的单路处理宽度”这两组信息。

## 9. overlap 是怎么计算出来的

`large_image == 3` 不是简单平分，而是左右两路都会保留一段 overlap。关键函数是：

```c
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
	vin_log(VIN_LOG_LARGE, "max_overlayer/2 is %d, min_overlayer/2 is %d, overlayer/2 is %d\n", max_overlayer / 2, min_overlayer / 2, overlayer / 2);

	if (overlayer == 0)
		overlayer = 256;

	return overlayer / 2;
}
```

关键点有两个：

1. 单路 ISP 最大处理宽度是 `3072`，所以要保证：

```text
width / 2 + overlap <= 3072
```

2. 函数最后返回的是 `overlayer / 2`，也就是“单侧扩展量”。

以文档中的 `4032x3016` 为例，按驱动公式计算得到：

```text
min_total=256 min_side=128
max_total=544 max_side=272
final_total=544 final_side=272
half_plus_overlap=2288
```

这和官方文档的数值完全一致：

- 原图宽度：`4032`
- 半图基础宽度：`2016`
- 单侧 overlap：`272`
- 单路处理宽度：`2016 + 272 = 2288`

也就是文档里的：

```text
4032x3016 -> 两路 2288x3016
```

## 10. 文档里的“缝合区 272”与代码里的 overlap 如何对应

这里容易产生一个理解误差，需要单独说明。

驱动函数返回的是“单侧 overlap”：

```text
O = 272
```

而左右两路 parser 窗口是：

- 左路：`[0, 2016 + 272)` -> `[0, 2288)`
- 右路：`[2016 - 272, 4032)` -> `[1744, 4032)`

这意味着：

- 每一路都多保留了 `272` 像素的过渡区
- 两个窗口在原图上真正重叠的公共区域是 `[1744, 2288)`，宽度为 `544`

所以如果严格按原图坐标理解：

- 文档里的“缝合区 272”更像是在说每一路额外保留的单侧缝合边界
- 驱动中两路窗口的真实公共 overlap 区域宽度是 `544`

这一点并不矛盾，只是文档和代码描述的角度不同。

## 11. 大图在 CSI / TDM 前端如何被拆成两路

CSI 侧的拆分代码如下：

```c
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

TDM 侧处理方式是同样的思路：

```c
if (tdm_rx->large_image == 3) {
	overlayer = vin_set_large_overlayer(tdm_rx->format.width);
	tdm_rx->format.width = tdm_rx->format.width/2 + overlayer;

	//if (tdm_rx->id == 0) {
	//	csic_tdm_set_rx_chn_cfg_mode(tdm->id, CH0_1);
	//}
}
csic_tdm_rx_set_min_ddr_size(tdm->id, tdm_rx->id, DDRSIZE_512b);
csic_tdm_rx_input_bit(tdm->id, tdm_rx->id, tdm_rx->tdm_fmt->input_type);
```

因此，前端拆分后的两路实际窗口是：

```text
左路：width = W/2 + O, start = 0
右路：width = W/2 + O, start = W/2 - O
```

这与官方文档“按比例原图拆分为左右部分，分别送给 ISP0/1 通道”完全一致。

## 12. 两路数据如何分别送到 ISP0 / ISP1

在 `vin.c` 的 `SUN8IW21P1` 处理分支里，`large_image == 3` 会触发专门的双路 ISP 输入选择：

```c
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

这段实现和文档的 DTS 配置可以直接对应起来：

- `vinc0` 选择 `isp_sel = 0`
- `vinc1` 选择 `isp_sel = 1`
- 两者都来自同一个 `CSI0`

所以这就是驱动层面的“单目 2in1 双路 ISP”。

## 13. VIPP 如何把 overlap 裁掉

虽然前端给 ISP 的是“半图 + overlap”，但 VIPP 不会把这 `2288` 全部原样输出，而是会裁掉 overlap，只输出最终该写入整图的左右半幅。

代码如下：

```c
if (scaler->large_image == 3) {
	if (scaler->crop.active.width/2 <= scaler->crop.active.left) {
		vin_err("vipp crop left is greater than the half of width\n");
		return -1;
	}

	if (scaler->id % 4 == 0) {
		crop.hor = scaler->crop.active.left;
	} else if (scaler->id % 4 == 1) {
		crop.hor = vin_set_large_overlayer(scaler->crop.active.width);
	}
	crop.width = scaler->crop.active.width/2;
	scaler_size.sc_width = scaler->para.width/2;
	scaler->para.width /= 2;
}
vin_log(VIN_LOG_LARGE, "video%d  after:%d, %d, %d, %d, %d, %d, %d,\n", scaler->id, crop.hor, crop.ver, crop.width, crop.height,
			scaler_size.sc_width, scaler_size.sc_height, scaler->para.xratio);
```

它的含义是：

- 偶数侧 `vipp` 输出左半边：从原始左边开始裁
- 奇数侧 `vipp` 输出右半边：从 `overlap` 偏移之后开始裁
- 两边最终都只输出 `W/2`

以 `4032` 为例：

- 左路 parser 拿到 `2288`
- 右路 parser 拿到 `2288`
- VIPP 最终把左右各裁成 `2016`

所以最终用于拼接的不是两张 `2288` 宽图，而是两张 `2016` 宽图。

## 14. DMA 如何把左右半幅写回同一个输出 buffer

拼接并不是软件 memcpy 完成的，而是两路 DMA 直接写入同一个最终输出帧缓冲的不同偏移位置：

```c
if (vinc->large_image == 3) {
	if (vinc->id % 4 == 1 && vin_core_gbl[vinc->id - 1]) {
		offset_width = frame->o_width/2;
		vinc_bind = vin_core_gbl[vinc->id - 1];
		csic_dma_buffer_address(vinc_bind->vipp_sel, CSI_BUF_0_A, paddr->y);
		csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_0_A, paddr->y + offset_width);
		if (paddr->cr && paddr->cb) {
			csic_dma_buffer_address(vinc_bind->vipp_sel, CSI_BUF_1_A, paddr->cb);
			csic_dma_buffer_address(vinc_bind->vipp_sel, CSI_BUF_2_A, paddr->cr);
			csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_1_A, paddr->cb + (offset_width >> 1));
			csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_2_A, paddr->cr + (offset_width >> 1));
		} else if (paddr->cb) {
			csic_dma_buffer_address(vinc_bind->vipp_sel, CSI_BUF_1_A, paddr->cb);
			csic_dma_buffer_address(vinc_bind->vipp_sel, CSI_BUF_2_A, paddr->cr);
			csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_1_A, paddr->cb + (offset_width));
			csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_2_A, paddr->cr);
		} else {
			csic_dma_buffer_address(vinc_bind->vipp_sel, CSI_BUF_1_A, paddr->cb);
			csic_dma_buffer_address(vinc_bind->vipp_sel, CSI_BUF_2_A, paddr->cr);
			csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_1_A, paddr->cb);
			csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_2_A, paddr->cr);
		}
	}
}
```

对应关系是：

- 偶数侧 `vipp` 写输出 buffer 左半
- 奇数侧 `vipp` 写输出 buffer 右半

也就是：

```text
左路写 dst[0 ... W/2)
右路写 dst[W/2 ... W)
```

这就是官方文档所说“最终拼接回源尺寸图像输出”的底层实现。

## 15. 为什么官方文档特别强调 `vinc1/5/9/13`

从驱动实现看，2in1 模式下真正充当主控的一般是 `id % 4 == 1` 这一侧。因为：

```c
if (vinc->large_image == 1)
	return;
if ((vinc->large_image == 3) && (vinc->id % 4 == 0))
	return;

vinc->vid_cap.first_flag = 0;
vinc->vin_status.frame_cnt = 0;
vinc->vin_status.err_cnt = 0;
vinc->vin_status.lost_cnt = 0;
```

偶数侧 `vinc0/4/8/12` 在 `large_image == 3` 时会直接返回，不负责正常的 next buffer 设置流程。

另外，偶数侧 DMA 中断也会被关掉：

```c
if ((vinc->large_image == 3) && vinc->vipp_sel % 4 == 0)
	csic_dma_int_disable(vinc->vipp_sel, DMA_INT_ALL);
```

这说明：

- `vinc0/4/8/12` 是从属输出链
- `vinc1/5/9/13` 是主控输出链

这也就解释了文档为什么强调要把 `vinc1/5/9/13` 打开并配置为同一个 Sensor0 输入。

## 16. 用 `4032x3016` 把整条链路走一遍

把上面的代码和文档示例合起来，可以得到一条完整的时序解释：

### 16.1 原始输入

```text
Sensor0 输出：4032x3016
```

### 16.2 overlap 计算

驱动计算得到：

```text
单侧 overlap = 272
单路处理宽度 = 2016 + 272 = 2288
```

### 16.3 CSI / TDM 拆图

左路：

```text
start = 0
width = 2288
窗口范围 = [0, 2288)
```

右路：

```text
start = 2016 - 272 = 1744
width = 2288
窗口范围 = [1744, 4032)
```

### 16.4 双路 ISP 处理

```text
左路 -> tdm_rx0 -> isp_sel 0
右路 -> tdm_rx1 -> isp_sel 1
```

### 16.5 VIPP 裁掉 overlap

左路：

```text
从 0 开始裁 2016
得到最终左半图
```

右路：

```text
从 272 开始裁 2016
得到最终右半图
```

### 16.6 DMA 拼回一张图

```text
左路写输出 buffer 前半
右路写输出 buffer 后半
最终输出 4032x3016
```

## 17. 最终理解

结合官方文档和驱动源码，可以把“单目 2in1 模式”准确理解为：

1. 输入源只有一个 Sensor0。
2. `vinc0/1`、`4/5`、`8/9`、`12/13` 这样的成对 `vinc` 节点，共同承担一张大图的处理。
3. `dma_merge_mode` 打开后，驱动强制进入 `large_image == 3`。
4. `large_image == 3` 的真正含义是“把一张大图拆成左右两张带 overlap 的半图处理，再合并回一张图”。
5. 文档里的 `2288x3016` 和 `272x3016`，可以被驱动中的 `vin_set_large_overlayer()` 公式完全验证。
6. 2in1 模式依赖整条 VIN 框架链路协同完成，而不是某一个单独模块完成。

## 18. 一句话总结

“单目 2in1 大分辨率支持模式”在 VIN 驱动里的本质，就是：

```text
单个 Sensor0 的大分辨率图像
-> 通过 dma_merge + large_image==3 在 VIN 通路中拆成左右两路
-> 经 TDM/ISP/VIPP 分别处理
-> 最终由双路 DMA 写回同一个输出 buffer
-> 输出一张完整源尺寸图像
```
