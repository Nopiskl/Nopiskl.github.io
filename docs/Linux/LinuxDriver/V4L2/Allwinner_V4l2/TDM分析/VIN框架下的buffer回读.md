# TDM ISP Offline DDR Buffer Flow

本文基于 `bsp/drivers/vin` 中的 VIN/TDM/ISP 源码，说明 TDM ISP offline 链路中，RAW 数据如何先写入 DDR 中间 buffer，再由 TDM TX 回读送入 ISP。

核心结论：

```text
Sensor/MIPI/CSI(Parser)
        |
        v
TDM RX 写入内部 DDR 中间 buffer
        |
        v
TDM TX 从 DDR 中间 buffer 回读并恢复视频时序
        |
        v
ISP -> VIPP/Scaler -> VIN DMA -> 用户 vb2 buffer
```

这里的 TDM DDR 中间 buffer 是 TDM 驱动内部通过 `os_mem_alloc()` 分配的 DMA buffer，不是用户态 `VIDIOC_REQBUFS` 得到的 vb2 buffer。CPU 不搬运帧数据，只负责分配 buffer、配置 DMA 地址和打开硬件通路。

## 1. 相关 work mode

源码中存在三类 offline/online 概念，分析时要分开看。

`bsp/drivers/vin/vin-tdm/tdm200/tdm200_reg.h`

```c
enum tdm_work_mode {
	TDM_ONLINE = 0,
	TDM_OFFLINE = 1,
};
```

`TDM_OFFLINE` 是本文讨论的重点：TDM RX 将输入 RAW 写入 DDR，再由 TDM TX 回读给 ISP。

`bsp/drivers/vin/vin-video/vin_video.h`

```c
enum bk_work_mode {
	BK_ONLINE = 0,
	BK_OFFLINE = 1,
};
```

`BK_OFFLINE` 是 VIN backend/DMA 的工作方式，不等同于 TDM 的 DDR 回读模式。

`bsp/drivers/vin/vin-isp/sunxi_isp.h`

```c
enum isp_work_mode {
	ISP_ONLINE = 0,
	ISP_OFFLINE = 1,
};
```

ISP 也有自己的 online/offline mode。实际调试时建议同时确认 TDM 节点、ISP 节点、VINC 节点的 `work_mode`。

TDM probe 中会读取设备树 `work_mode` 并限制到 `TDM_ONLINE..TDM_OFFLINE`：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
tdm->work_mode = 0xff;
of_property_read_u32(np, "work_mode", &tdm->work_mode);
tdm->work_mode = clamp_t(unsigned int, tdm->work_mode,
			 TDM_ONLINE, TDM_OFFLINE);
```

VINC 侧也会读取 `work_mode`，用于 backend 工作方式：

`bsp/drivers/vin/vin-video/vin_core.c`

```c
if (of_property_read_u32(np, "work_mode", &vinc->work_mode)) {
	vin_err("vinc%d get work mode fail\n", vinc->id);
	ret = -EIO;
	goto freedev;
}
```

## 2. Media pipeline 链路挂接

开启 `SUPPORT_ISP_TDM` 后，VIN 的 media graph 不再直接创建 `CSI -> ISP` 链路，而是引入 `TDM_RX`。

### 2.1 video pipeline 内部启用 `TDM_RX -> ISP`

`bsp/drivers/vin/vin.c`

```c
if (vinc->tdm_rx_sel == 0xff)
	tdm_rx = NULL;
else
	tdm_rx = vind->tdm[vinc->tdm_rx_sel / TDM_RX_NUM]
		      .tdm_rx[vinc->tdm_rx_sel].sd;

if (vinc->isp_sel == 0xff)
	isp = NULL;
else
	isp = vind->isp[vinc->isp_sel].sd;

if (tdm_rx && isp) {
	source = &tdm_rx->entity;
	sink = &isp->entity;
	ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
				    sink, VIN_SD_PAD_SINK,
				    MEDIA_LNK_FL_ENABLED);
}
```

这段代码把当前 video pipeline 选中的 TDM RX 直接连到对应 ISP，并默认 enabled。

### 2.2 全局创建 `CSI -> TDM_RX` 可选链路

`bsp/drivers/vin/vin.c`

```c
for (i = 0; i < VIN_MAX_CSI; i++) {
	csi = vind->csi[i].sd;
	if (csi == NULL)
		continue;
	source = &csi->entity;

	for (j = 0; j < VIN_MAX_TDM * TDM_RX_NUM; j++) {
		tdm_rx = vind->tdm[j / TDM_RX_NUM].tdm_rx[j].sd;
		if (tdm_rx == NULL)
			continue;
		sink = &tdm_rx->entity;
		ret = media_create_pad_link(source, CSI_PAD_SOURCE,
					    sink, ISP_PAD_SINK, 0);
	}
}
```

这里创建的是候选链路，具体启用哪个 `CSI -> TDM_RX`，取决于当前 video 选择的 `csi_sel` 和 `tdm_rx_sel`。

## 3. stream on 顺序

VIN pipeline 的 stream 顺序由 `__vin_pipeline_s_stream()` 决定。

`bsp/drivers/vin/vin.c`

```c
static const u8 seq[5][VIN_IND_MAX] = {
	/* close */
	{ VIN_IND_CAPTURE, VIN_IND_SCALER, VIN_IND_ISP, VIN_IND_TDM_RX,
	  VIN_IND_CSI, VIN_IND_MIPI, VIN_IND_SENSOR }, /* online */
	{ VIN_IND_TDM_RX, VIN_IND_CSI, VIN_IND_MIPI, VIN_IND_SENSOR,
	  VIN_IND_ISP, VIN_IND_CAPTURE, VIN_IND_SCALER }, /* offline */

	/* open */
	{ VIN_IND_TDM_RX, VIN_IND_MIPI, VIN_IND_ISP, VIN_IND_SCALER,
	  VIN_IND_CAPTURE, VIN_IND_CSI, VIN_IND_SENSOR },
};
```

打开时，TDM RX 排在最前面。这意味着：

1. 先配置 TDM RX/TX。
2. 再启动 MIPI、ISP、Scaler、Capture。
3. 最后启动 CSI 和 Sensor。

这样可以保证前端第一帧进入之前，TDM 已经拥有可写 DDR 地址，TX/bridge/ISP 也已经准备好。

实际调用流程如下：

`bsp/drivers/vin/vin.c`

```c
if (on)
	vin_bridge_ch_en(vinc, on);

for (i = 0; i < VIN_IND_ACTUATOR; i++) {
	unsigned int idx = seq[on_idx][i];
	if (!p->sd[idx] || !p->sd[idx]->entity.graph_obj.mdev)
		continue;
	ret = __vin_subdev_set_stream(p->sd[idx], idx, on);
}

if (!on)
	vin_bridge_ch_en(vinc, on);
```

打开时先开 bridge，再按序打开各 subdev；关闭时先按序关 subdev，最后关 bridge。

## 4. ISP bridge 通路

TDM TX 回读的数据需要通过 top bridge 进入 ISP。`vin_bridge_ch_en()` 根据是否存在 TDM RX、WDR 模式、rx 通道数，打开对应 bridge channel。

normal 模式下，通常打开当前 `vinc->tdm_rx_sel` 对应的 F2S bridge：

`bsp/drivers/vin/vin.c`

```c
case ISP_NORMAL_MODE:
	if (vinc->dma_merge_mode == 1 && vinc->id % 4 == 0) {
		for (i = 0; i < csi->bus_info.ch_total_num; i++) {
			csic_ccu_f2s0_bridge_clk_en(on_idx,
						    vinc->tdm_rx_sel + i);
			csic_top_f2s0_bridge_en(vind->id, on_idx,
						vinc->tdm_rx_sel + i);
		}
	} else {
		csic_ccu_f2s0_bridge_clk_en(on_idx, vinc->tdm_rx_sel);
		csic_top_f2s0_bridge_en(vind->id, on_idx,
					vinc->tdm_rx_sel);
	}
	break;
```

WDR 模式下会打开多路 bridge：

`bsp/drivers/vin/vin.c`

```c
case ISP_3FDOL_WDR_MODE:
	for (i = 0; i < 3; i++) {
		csic_ccu_f2s0_bridge_clk_en(on_idx, vinc->tdm_rx_sel + i);
		csic_top_f2s0_bridge_en(vind->id, on_idx,
					vinc->tdm_rx_sel + i);
	}
	break;

case ISP_DOL_WDR_MODE:
	for (i = 0; i < 2; i++) {
		csic_ccu_f2s0_bridge_clk_en(on_idx, vinc->tdm_rx_sel + i);
		csic_top_f2s0_bridge_en(vind->id, on_idx,
					vinc->tdm_rx_sel + i);
	}
	break;
```

同时也会打开 ISP 对应的 S2F bridge：

`bsp/drivers/vin/vin.c`

```c
csic_ccu_s2f0_bridge_clk_en(on_idx, isp_virtual_find_sel[vinc->isp_sel]);
csic_top_s2f0_bridge_en(vind->id, on_idx,
			isp_virtual_find_sel[vinc->isp_sel]);
```

底层寄存器封装在 `top_reg.c`：

`bsp/drivers/vin/top_reg.c`

```c
void csic_top_f2s0_bridge_en(unsigned int sel, unsigned int en,
			     unsigned int id)
{
	vin_reg_clr_set(csic_top_base[sel] + CSIC_TOP_EN_REG_OFF,
		CSIC_ISP_F2S0_BRIDGE_CH_EN_MASK << id,
		en << (CSIC_ISP_F2S0_BRIDGE_CH_EN + id));
}

void csic_top_s2f0_bridge_en(unsigned int sel, unsigned int en,
			     unsigned int id)
{
	vin_reg_clr_set(csic_top_base[sel] + CSIC_TOP_EN_REG_OFF,
		CSIC_ISP_S0F2_BRIDGE_CH_EN_MASK << id,
		en << (CSIC_ISP_S0F2_BRIDGE_CH_EN + id));
}
```

## 5. TDM stream on 入口

TDM RX 的 subdev stream 入口是 `sunxi_tdm_subdev_s_stream()`。

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
static int sunxi_tdm_subdev_s_stream(struct v4l2_subdev *sd, int enable)
{
	struct tdm_rx_dev *tdm_rx = v4l2_get_subdevdata(sd);
	struct tdm_dev *tdm =
		container_of(tdm_rx, struct tdm_dev, tdm_rx[tdm_rx->id]);
	struct v4l2_mbus_framefmt *mf = &tdm_rx->format;
	struct mbus_framefmt_res *res = (void *)mf->reserved;
```

如果当前输出格式本身就是 RAW，TDM 直接返回，不配置 offline DDR 回读：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
switch (res->res_pix_fmt) {
case V4L2_PIX_FMT_SBGGR8:
case V4L2_PIX_FMT_SGBRG8:
case V4L2_PIX_FMT_SGRBG8:
case V4L2_PIX_FMT_SRGGB8:
case V4L2_PIX_FMT_SBGGR10:
case V4L2_PIX_FMT_SGBRG10:
case V4L2_PIX_FMT_SGRBG10:
case V4L2_PIX_FMT_SRGGB10:
case V4L2_PIX_FMT_SBGGR12:
case V4L2_PIX_FMT_SGBRG12:
case V4L2_PIX_FMT_SGRBG12:
case V4L2_PIX_FMT_SRGGB12:
	vin_log(VIN_LOG_FMT, "%s output fmt is raw, return directly\n",
		__func__);
	return 0;
default:
	break;
}
```

这意味着 TDM ISP offline 主要面向需要 ISP 处理的输出格式。如果用户直接抓 RAW，TDM/ISP 链路可能不会进入本文描述的 DDR 回读过程。

## 6. offline 模式下 RX/TX 功能选择

normal 模式下，如果 TDM 工作在 offline，就会使能 TDM、打开 RX 到 TX 的功能，并选择 pkg 或 LBC。

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
if (tdm->work_mode == TDM_OFFLINE) {
	tdm->ws.tdm_en = 1;
	tdm_rx->ws.tx_func_en = 1;

	if (tdm_rx->id == 0 || tdm_rx->id == 1) {
		tdm_rx->ws.pkg_en = 0;
		tdm_rx->ws.lbc_en = 1;
		tdm_rx->ws.sync_en = 0;
	} else {
		tdm_rx->ws.pkg_en = 1;
		tdm_rx->ws.lbc_en = 0;
		tdm_rx->ws.sync_en = 0;
	}
}
```

不同平台宏下 rx0/rx1 也可能改为 pkg。源码中 `CONFIG_ARCH_SUN55IW3`、`CONFIG_ARCH_SUN55IW6` 等平台分支会把 `pkg_en` 设为 1、`lbc_en` 设为 0。

2F DOL WDR 时，offline 模式会把 companion RX 通道也打开 TX 功能：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
if (tdm_rx->id == 0) {
	tdm_rx1 = &tdm->tdm_rx[1];
	tdm_rx_cpy(tdm_rx, tdm_rx1);

	if (tdm->work_mode == TDM_OFFLINE) {
		tdm_rx1->ws.tx_func_en = 1;
		tdm_rx1->ws.pkg_en = 1;
		tdm_rx1->ws.lbc_en = 0;
		tdm_rx1->ws.sync_en = 0;
	}
}
```

3F DOL WDR 时会复制并配置 rx1/rx2：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
tdm_rx1 = &tdm->tdm_rx[1];
tdm_rx2 = &tdm->tdm_rx[2];
tdm_rx_cpy(tdm_rx, tdm_rx1);
tdm_rx_cpy(tdm_rx, tdm_rx2);

if (tdm->work_mode == TDM_OFFLINE) {
	tdm_rx1->ws.tx_func_en = 1;
	tdm_rx2->ws.tx_func_en = 1;
	tdm_rx1->ws.pkg_en = 1;
	tdm_rx2->ws.pkg_en = 1;
}
```

## 7. TDM top/TX 配置

`sunxi_tdm_top_s_stream()` 负责打开 TDM top、设置 work mode、配置 TX 时序，并使能 TX。

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
if (enable) {
	csic_tdm_top_enable(tdm->id);
	if (tdm->ws.tdm_en)
		csic_tdm_enable(tdm->id);

	csic_tdm_set_rx_chn_cfg_mode(tdm->id, tdm->ws.rx_chn_mode);
	csic_tdm_set_tx_chn_cfg_mode(tdm->id, tdm->ws.tx_chn_mode);
	csic_tdm_set_work_mode(tdm->id, tdm->work_mode);
	csic_tdm_set_speed_dn(tdm->id, tdm->ws.speed_dn_en);
```

offline 模式下会按 offline 参数配置 TX FIFO/timing：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
tdm_set_tx_blank(tdm);
csic_tdm_rx_data_fifo_clear(tdm->id);
csic_tdm_set_tx_t1_cycle(tdm->id, tdm->tx_cfg.t1_cycle = 0x40);

if (tdm->work_mode == TDM_ONLINE) {
	csic_tdm_set_tx_t2_cycle(tdm->id, tdm->tx_cfg.t2_cycle = 0xfa0);
} else {
	csic_tdm_set_tx_t2_cycle(tdm->id, tdm->tx_cfg.t2_cycle = 0x0);
}
```

最后打开 TX：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
csic_tdm_tx_enable(tdm->id);
csic_tdm_tx_cap_enable(tdm->id);
csic_tdm_int_clear_status(tdm->id, TDM_INT_ALL);
csic_tdm_int_enable(tdm->id, ini_en);
```

底层 TX enable 写 TDM TX control register：

`bsp/drivers/vin/vin-tdm/tdm200/tdm200_reg.c`

```c
void csic_tdm_tx_enable(unsigned int sel)
{
	vin_reg_clr_set(csic_tdm_base[sel] + TMD_TX_OFFSET
			+ TDM_TX_CFG0_REG_OFF,
			TDM_TX_EN_MASK, 1 << TDM_TX_EN);
}
```

## 8. TDM RX 写 DDR 的配置

每个 RX 通道的 DDR 写入配置集中在 `tdm_set_rx_cfg()`。

### 8.1 配置输入格式和尺寸

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
csic_tdm_rx_set_min_ddr_size(tdm->id, tdm_rx->id, DDRSIZE_512b);
csic_tdm_rx_input_bit(tdm->id, tdm_rx->id,
		      tdm_rx->tdm_fmt->input_type);
csic_tdm_rx_input_fmt(tdm->id, tdm_rx->id,
		      tdm_rx->tdm_fmt->raw_fmt);
csic_tdm_rx_input_size(tdm->id, tdm_rx->id,
		       tdm_rx->format.width, tdm_rx->format.height);
```

对应底层寄存器封装：

`bsp/drivers/vin/vin-tdm/tdm200/tdm200_reg.c`

```c
void csic_tdm_rx_input_size(unsigned int sel, unsigned int ch,
			    unsigned int width, unsigned int height)
{
	vin_reg_clr_set(csic_tdm_base[sel] + TMD_RX0_OFFSET
			+ ch * AMONG_RX_OFFSET + TDM_RX_CFG1_REG_OFF,
			TDM_RX_WIDTH_MASK, width << TDM_RX_WIDTH);
	vin_reg_clr_set(csic_tdm_base[sel] + TMD_RX0_OFFSET
			+ ch * AMONG_RX_OFFSET + TDM_RX_CFG1_REG_OFF,
			TDM_RX_HEIGHT_MASK, height << TDM_RX_HEIGHT);
}
```

### 8.2 配置 pkg 或 LBC

pkg 模式下，按 bit width 和 width 计算每行 word 数：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
if (tdm_rx->ws.pkg_en) {
	csic_tdm_rx_pkg_enable(tdm->id, tdm_rx->id);
	rx_pkg_line_words = DIV_ROUND_UP(
		tdm_rx->tdm_fmt->input_bit_width * tdm_rx->format.width,
		32);
	csic_tdm_rx_pkg_line_words(tdm->id, tdm_rx->id,
				   ALIGN(rx_pkg_line_words, 8));
}
```

LBC 模式下，会计算压缩参数并配置 LBC：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
csic_tdm_rx_lbc_enable(tdm->id, tdm_rx->id);
tdm_rx_lbc_cal_para(tdm_rx);
rx_pkg_line_words = roundup(tdm_rx->lbc.line_max_bit
			    + tdm_rx->lbc.mb_min_bit, 512) / 32;
csic_tdm_rx_pkg_line_words(tdm->id, tdm_rx->id,
			   ALIGN(rx_pkg_line_words, 8));
csic_tdm_lbc_cfg(tdm->id, tdm_rx->id, &tdm_rx->lbc);
```

offline + LBC 时，驱动还会打开 line number 写 DDR：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
if (tdm->work_mode == TDM_OFFLINE)
	tdm_rx->ws.line_num_ddr_en = 1;
else
	tdm_rx->ws.line_num_ddr_en = 0;
csic_tdm_rx_set_line_num_ddr(tdm->id, tdm_rx->id,
			     tdm_rx->ws.line_num_ddr_en);
```

## 9. DDR 中间 buffer 的分配

TDM RX 中间 buffer 由 `tdm_rx_bufs_alloc()` 分配。

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
static int tdm_rx_bufs_alloc(struct tdm_rx_dev *tdm_rx, u32 size, u32 count)
{
	struct tdm_dev *tdm =
		container_of(tdm_rx, struct tdm_dev, tdm_rx[tdm_rx->id]);
	int i;

	tdm_rx->buf_size = size;
	tdm_rx->buf_cnt = count;

	for (i = 0; i < tdm_rx->buf_cnt; i++) {
		struct tdm_buffer *buf = &tdm_rx->buf[i];
		struct vin_mm *mm = &tdm_rx->ion_man[i];

		mm->size = size;
		if (!os_mem_alloc(&tdm->pdev->dev, mm)) {
			buf->virt_addr = mm->vir_addr;
			buf->dma_addr = mm->dma_addr;
		}
	}
```

这组 buffer 保存在：

`bsp/drivers/vin/vin-tdm/vin_tdm.h`

```c
struct tdm_rx_dev {
	/* Buffer */
	u32 buf_size;
	u8 buf_cnt;
	struct vin_mm ion_man[TDM_BUFS_NUM];
	struct tdm_buffer buf[TDM_BUFS_NUM];
};
```

注意：这里的 `tdm_rx->buf[i].dma_addr` 是给 TDM RX/TX 硬件使用的中间 RAW/pkg/LBC buffer 地址，不是最终视频节点输出给用户的 buffer。

## 10. buffer 个数和大小计算

offline 模式下，buffer 个数按 sensor fps 估算：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
if (tdm->work_mode == TDM_ONLINE) {
	if (tdm_rx->ws.pkg_en || tdm_rx->ws.lbc_en)
		tdm_buf_num = 1;
	else
		tdm_buf_num = 0;
} else {
	if (tdm_rx->sensor_fps <= 30)
		tdm_buf_num = 2;
	else if (tdm_rx->sensor_fps <= 60)
		tdm_buf_num = 3;
	else if (tdm_rx->sensor_fps <= 120)
		tdm_buf_num = 4;
	else
		tdm_buf_num = TDM_BUFS_NUM;
}
```

buffer size 根据 pkg/LBC 分别计算：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
if (tdm_rx->ws.pkg_en)
	size = ALIGN(tdm_rx->width * tdm_rx->tdm_fmt->input_bit_width,
		     512) * tdm_rx->height / 8
	     + ALIGN(tdm_rx->height, 64);
else if (tdm_rx->ws.lbc_en)
	size = ALIGN(rx_pkg_line_words, 8) * tdm_rx->height * 4
	     + ALIGN(tdm_rx->height, 64);
```

`sensor_fps`、`isp_clk`、`vts` 来自 video 侧的 `S_PARM`/window 配置：

`bsp/drivers/vin/vin-video/vin_video.c`

```c
if (cap->pipe.sd[VIN_IND_TDM_RX])
	sunxi_tdm_fps_clk(cap->pipe.sd[VIN_IND_TDM_RX],
			  win_cfg.fps_fixed,
			  clk_get_rate(vind->clk[VIN_TOP_CLK].clock),
			  win_cfg.vts);
```

`sunxi_tdm_fps_clk()` 保存这些信息：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
tdm_rx->sensor_fps = fps;
tdm_rx->isp_clk = roundup(isp_clk, 1000000);
tdm_rx->vts = vts;
```

## 11. DDR 地址写入 TDM RX 寄存器

buffer 分配完成后，驱动将 buffer 个数和每个 DMA 地址写入 TDM RX。

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
ret = tdm_rx_bufs_alloc(tdm_rx, size, tdm_buf_num);
if (ret)
	return ret;

csic_tdm_rx_set_buf_num(tdm->id, tdm_rx->id, tdm_buf_num - 1);
for (i = 0; i < tdm_buf_num; i++) {
	csic_tdm_rx_set_address(tdm->id, tdm_rx->id,
				(unsigned long)tdm_rx->buf[i].dma_addr);
}

for (i = 0; i < 16 - tdm_buf_num; i++)
	csic_tdm_rx_set_address(tdm->id, tdm_rx->id, 0);
```

`CONFIG_TDM_ONE_BUFFER` 模式下，会把同一个 buffer 地址写两次，因为硬件仍然需要两个地址槽：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
csic_tdm_rx_set_buf_num(tdm->id, tdm_rx->id,
			(tdm_buf_num + 1) - 1);
for (i = 0; i < tdm_buf_num; i++) {
	csic_tdm_rx_set_address(tdm->id, tdm_rx->id,
				(unsigned long)tdm_rx->buf[i].dma_addr);
	csic_tdm_rx_set_address(tdm->id, tdm_rx->id,
				(unsigned long)tdm_rx->buf[i].dma_addr);
}
```

底层寄存器写法：

`bsp/drivers/vin/vin-tdm/tdm200/tdm200_reg.c`

```c
void csic_tdm_rx_set_buf_num(unsigned int sel, unsigned int ch,
			     unsigned int num)
{
	vin_reg_clr_set(csic_tdm_base[sel] + TMD_RX0_OFFSET
			+ ch * AMONG_RX_OFFSET + TDM_RX_CFG0_REG_OFF,
			TDM_RX_BUF_NUM_MASK, num << TDM_RX_BUF_NUM);
}

void csic_tdm_rx_set_address(unsigned int sel, unsigned int ch,
			     unsigned long address)
{
	vin_reg_writel(csic_tdm_base[sel] + TMD_RX0_OFFSET
		       + ch * AMONG_RX_OFFSET + TDM_RX_CFG2_REG_OFF,
		       address >> TDM_ADDR_BIT_R_SHIFT);
}
```

因此，TDM RX 写 DDR 的硬件条件是：

1. TDM RX input format/size 已配置。
2. pkg/LBC 模式已配置。
3. `TDM_RX_BUF_NUM` 已设置。
4. 多个 `TDM_RX_CFG2` 地址槽已写入 DMA 地址。
5. RX enable 和 RX capture enable 已打开。

## 12. RX enable 和 RX capture enable

`sunxi_tdm_subdev_s_stream()` 在完成 `tdm_set_rx_cfg()` 后打开 RX：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
tdm_set_rx_cfg(tdm_rx, 1);
csic_tdm_rx_enable(tdm->id, tdm_rx->id);
csic_tdm_rx_cap_enable(tdm->id, tdm_rx->id);
```

WDR companion RX 也会执行同样操作：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
if (tdm_rx1) {
	tdm_set_rx_cfg(tdm_rx1, 1);
	csic_tdm_rx_enable(tdm->id, tdm_rx1->id);
	csic_tdm_rx_cap_enable(tdm->id, tdm_rx1->id);
}
```

底层寄存器封装：

`bsp/drivers/vin/vin-tdm/tdm200/tdm200_reg.c`

```c
void csic_tdm_rx_enable(unsigned int sel, unsigned int ch)
{
	vin_reg_clr_set(csic_tdm_base[sel] + TMD_RX0_OFFSET
			+ ch * AMONG_RX_OFFSET + TDM_RX_CFG0_REG_OFF,
			TDM_RX_EN_MASK, 1 << TDM_RX_EN);
}

void csic_tdm_rx_cap_enable(unsigned int sel, unsigned int ch)
{
	vin_reg_clr_set(csic_tdm_base[sel] + TMD_RX0_OFFSET
			+ ch * AMONG_RX_OFFSET + TDM_RX_CFG0_REG_OFF,
			TDM_RX_CAP_EN_MASK, 1 << TDM_RX_CAP_EN);
}
```

此后，CSI/Parser 送来的 RAW 数据就可以由 TDM RX 写入前面配置的 DDR 中间 buffer。

## 13. 从 DDR 回读到 ISP 的关键开关

TDM offline 不只是 RX 写 DDR，还要把 DDR 中的数据回读并重新输出给 ISP。这个动作由两个层面共同决定。

第一，TDM top/TX 已经打开：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
csic_tdm_set_work_mode(tdm->id, tdm->work_mode);
csic_tdm_tx_enable(tdm->id);
csic_tdm_tx_cap_enable(tdm->id);
```

第二，对应 RX 通道打开 `TDM_RX_TX_EN`：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
if (tdm_rx->ws.tx_func_en)
	csic_tdm_rx_tx_enable(tdm->id, tdm_rx->id);
else
	csic_tdm_rx_tx_disable(tdm->id, tdm_rx->id);
```

底层寄存器：

`bsp/drivers/vin/vin-tdm/tdm200/tdm200_reg.c`

```c
void csic_tdm_rx_tx_enable(unsigned int sel, unsigned int ch)
{
	vin_reg_clr_set(csic_tdm_base[sel] + TMD_RX0_OFFSET
			+ ch * AMONG_RX_OFFSET + TDM_RX_CFG0_REG_OFF,
			TDM_RX_TX_EN_MASK, 1 << TDM_RX_TX_EN);
}
```

可以把 `TDM_RX_TX_EN` 理解为“该 RX 通道写入 DDR 的数据允许被 TX 回读输出”。

## 14. ISP 侧看到的是 TDM TX 输出流

ISP stream 入口是 `sunxi_isp_subdev_s_stream()`。

`bsp/drivers/vin/vin-isp/sunxi_isp.c`

```c
static int sunxi_isp_subdev_s_stream(struct v4l2_subdev *sd, int enable)
{
	struct isp_dev *isp = v4l2_get_subdevdata(sd);
	struct v4l2_mbus_framefmt *mf = &isp->mf;
	struct mbus_framefmt_res *res = (void *)mf->reserved;
```

ISP 会配置自己的 input format、size、参数 load/save DDR、统计 buffer、WDR/3DNR buffer 等。例如：

`bsp/drivers/vin/vin-isp/sunxi_isp.c`

```c
static void sunxi_isp_set_load_ddr(struct isp_dev *isp)
{
	bsp_isp_set_input_fmt(isp->id, isp->isp_fmt->infmt);
	if (isp->isp_fmt->byr_max_bit != 0) {
		bsp_isp_set_byr_max_bit(isp->id,
					isp->isp_fmt->byr_max_bit);
		bsp_isp_set_byr_act_bit(isp->id,
					isp->isp_fmt->input_bit);
	}
	bsp_isp_set_size(isp->id, &isp->isp_ob);
	bsp_isp_set_last_blank_cycle(isp->id, 5);
	bsp_isp_set_speed_mode(isp->id, 3);
}
```

但要注意：ISP 中的 `bsp_isp_set_load_addr()`、`bsp_isp_set_saved_addr()`、`bsp_isp_set_statistics_addr()` 等地址是 ISP 参数/统计相关 DDR，不是 TDM offline RAW 中间 buffer。

TDM RAW 中间 buffer 的地址只在 TDM RX 中配置：

```text
tdm_rx->buf[i].dma_addr -> csic_tdm_rx_set_address()
```

ISP 侧并不直接管理这组 TDM buffer，它接收的是 TDM TX 回读后经 bridge 送来的流。

## 15. 最终输出到用户 vb2 buffer

ISP 处理后，数据继续流向 VIPP/Scaler，最后由 VIN DMA 写入用户 buffer。

DMA stream on 时会调用 `vin_set_next_buf_addr()`：

`bsp/drivers/vin/vin-video/vin_video.c`

```c
vin_set_next_buf_addr(vinc);
csic_dma_top_enable(vinc->vipp_sel);

csic_dma_int_clear_status(vinc->vipp_sel, DMA_INT_ALL);
csic_dma_int_enable(vinc->vipp_sel,
		    DMA_INT_BUF_0_OVERFLOW |
		    DMA_INT_BUF_1_OVERFLOW |
		    DMA_INT_CAPTURE_DONE |
		    DMA_INT_FRAME_DONE);
```

`vin_set_next_buf_addr()` 取 active queue 中的 `vin_buffer`，再通过 `vin_set_addr()` 写 DMA 输出地址：

`bsp/drivers/vin/vin-video/vin_video.c`

```c
void vin_set_next_buf_addr(struct vin_core *vinc)
{
	struct vin_buffer *buf;

	buf = list_entry(vinc->vid_cap.vidq_active.next,
			 struct vin_buffer, list);
	vin_set_addr(vinc, &buf->vb.vb2_buf,
		     &vinc->vid_cap.frame,
		     &vinc->vid_cap.frame.paddr);
}
```

`vin_set_addr()` 内部再调用：

```c
csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_0_A, paddr->y);
csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_1_A, paddr->cb);
csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_2_A, paddr->cr);
```

这一路是最终图像输出 DMA，与 TDM 内部 DDR 中间 buffer 是两套 buffer。

## 16. stream off 和 buffer 释放

关闭 TDM RX 时，驱动先停 RX，再等待 TX 状态，避免 TX/ISP 还在回读 DDR。

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
csic_tdm_rx_disable(tdm->id, tdm_rx->id);
csic_tdm_int_clear_status(tdm->id, TX_FRM_DONE_INT_EN);
csic_tdm_rx_cap_disable(tdm->id, tdm_rx->id);
tdm_set_rx_cfg(tdm_rx, 0);
```

随后等待 `TX_FRM_DONE` 或 TX idle：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
if (tdm->stream_cnt == 0)
	usleep_range(1000, 1100);
else {
	if (csic_tdm_get_tx_ctrl_status(tdm->id) == 0)
		usleep_range(1000, 1100);
	else {
		for (i = 0; i < 100; i++) {
			if (csic_tdm_internal_get_status(tdm->id,
							 TX_FRM_DONE_PD_MASK))
				break;
			usleep_range(1000, 1100);
		}
	}
}
```

VIPP/logic streamoff 中，当最后一路 TDM stream 已关闭，会停 ISP/TDM TX/TDM top，并释放 TDM DDR 中间 buffer：

`bsp/drivers/vin/vin-vipp/sunxi_scaler.c`

```c
if (tdm->stream_cnt == 0) {
	bsp_isp_top_capture_stop(tdm->id);
	bsp_isp_enable(tdm->id, 0);

	csic_tdm_set_speed_dn(tdm->id, 0);
	csic_tdm_tx_cap_disable(tdm->id);
	csic_tdm_tx_disable(tdm->id);
	csic_tdm_disable(tdm->id);
	csic_tdm_top_disable(tdm->id);
	sunxi_tdm_buffer_free(tdm->id);
}
```

`sunxi_tdm_buffer_free()` 会遍历所有 RX 通道释放内部 buffer：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
void sunxi_tdm_buffer_free(unsigned int id)
{
	struct tdm_rx_dev *tdm_rx = NULL;
	unsigned int i;

	usleep_range(1000, 1100);

	for (i = 0; i < TDM_RX_NUM; i++) {
		tdm_rx = &glb_tdm[id]->tdm_rx[i];
		tdm_rx_bufs_free(tdm_rx);
	}
}
```

实际释放动作在 `tdm_rx_bufs_free()`：

`bsp/drivers/vin/vin-tdm/vin_tdm.c`

```c
for (i = 0; i < tdm_rx->buf_cnt; i++) {
	struct tdm_buffer *buf = &tdm_rx->buf[i];
	struct vin_mm *mm = &tdm_rx->ion_man[i];

	mm->size = tdm_rx->buf_size;
	if (!buf->virt_addr)
		continue;

	mm->vir_addr = buf->virt_addr;
	mm->dma_addr = buf->dma_addr;
	os_mem_free(&tdm->pdev->dev, mm);

	buf->dma_addr = NULL;
	buf->virt_addr = NULL;
}
```

## 17. 完整时序总结

### stream on

```text
VIDIOC_STREAMON
  -> __vin_pipeline_s_stream()
     -> vin_bridge_ch_en(on)
        -> enable F2S/S2F bridge clock/channel
     -> TDM_RX.s_stream(on)
        -> 判断输出格式，RAW 直出则跳过
        -> 根据 WDR/normal 和 TDM_OFFLINE 设置 tx_func/pkg/lbc
        -> sunxi_tdm_top_s_stream()
           -> enable TDM top
           -> set TDM_OFFLINE work mode
           -> enable TDM TX
        -> tdm_set_rx_cfg()
           -> 配置 RX input fmt/size/pkg/LBC
           -> os_mem_alloc 分配 DDR 中间 buffer
           -> 写 TDM_RX_BUF_NUM
           -> 写 TDM_RX_CFG2 buffer DMA 地址
           -> enable TDM_RX_TX_EN
        -> enable TDM RX/RX CAP
     -> ISP.s_stream(on)
        -> ISP input/size/param/stat 配置
        -> ISP capture start
     -> VIN DMA.s_stream(on)
        -> 设置最终用户 vb2 buffer 地址
     -> CSI/Sensor.s_stream(on)
        -> 前端开始送帧
```

### 数据流

```text
CSI Parser 输出 RAW
  -> TDM RX
     -> 写入 tdm_rx->buf[i].dma_addr 指向的 DDR
  -> TDM TX
     -> 从同一组 DDR buffer 回读
     -> 通过 F2S/S2F bridge 送入 ISP
  -> ISP
     -> Bayer/YUV 处理
  -> VIPP/Scaler
  -> VIN DMA
     -> 写入用户 vb2 buffer
```

### stream off

```text
VIDIOC_STREAMOFF
  -> 按 offline close 序列停 TDM/CSI/MIPI/SENSOR/ISP/CAPTURE/SCALER
  -> TDM RX disable
  -> 等待 TX idle 或 TX_FRM_DONE
  -> 最后一路关闭后停 ISP/TDM TX/TDM top
  -> sunxi_tdm_buffer_free()
     -> tdm_rx_bufs_free()
     -> os_mem_free DDR 中间 buffer
```

## 18. 调试建议

1. 先确认设备树中 TDM 节点 `work_mode = <1>`，否则 TDM 可能仍是 online。
2. 再确认 VINC/ISP 的 `work_mode`，避免只打开了 backend offline，TDM 却没有走 DDR 回读。
3. 打开 `VIN_LOG_TDM` 后关注这些日志：
   - `tdm%d work mode is %d`
   - `rx%d:buf%d:dma_addr is ...`
   - `tdm%d open first, setting the interrupt and tx configuration`
   - `tdm_rx%d stream on`
4. 如果没有看到 `rx%d:buf%d:dma_addr`，通常说明没有进入 TDM buffer 分配路径，可能原因包括：
   - 输出格式是 RAW，`sunxi_tdm_subdev_s_stream()` 直接返回。
   - `tdm->work_mode` 不是 `TDM_OFFLINE`。
   - `tdm_rx->ws.pkg_en/lbc_en` 未打开。
   - media link 没有正确切到 `CSI -> TDM_RX -> ISP`。
5. 如果 stream off 后出现随机异常，重点检查是否在 TX/ISP 仍访问 DDR 时提前释放了 TDM buffer。正常路径会等待 `TX_FRM_DONE` 或在 logic streamoff 中统一 `sunxi_tdm_buffer_free()`。

