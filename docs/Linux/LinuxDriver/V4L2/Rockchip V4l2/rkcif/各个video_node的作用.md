
---

**Cursor**

可以，这个问题要分成两层看：

1. **这些 `video` 节点分别是什么角色、给谁用、背后连到哪类硬件路径**
2. **`4 个 RKCIF_STREAM_MIPI_IDx` 到底代表什么流**：  
   它们**并不等价于“一个 sensor 流固定复制成 4 份”**，而更接近于 **CIF 内部 4 个可独立配置的采集通道/ID 通道**。这些通道最终承载的“流语义”，取决于输入模式：
   - 可能是 **1 路 MIPI sensor 的 4 个 VC/数据通道**
   - 也可能是 **HDR 多帧（Long/Middle/Short）**
   - 也可能是 **BT656/BT1120 多路复用出来的 4 路**
   - 对 DVP/BT656 新平台上，也统一抽象成 4 个 stream

下面我按源码把它掰开讲。

---

# 1. 先看这几个节点在驱动里的“对象关系”

驱动内部的数据结构关系很清楚：

- `rkcif_device` 下面有：
  - `stream[5]`
  - `scale_vdev[5]`
  - `tools_vdev[3]`

并且每个 `scale_vdev`、`tools_vdev` 都**直接绑到某个 `stream`** 上：

```487:580:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.h
struct rkcif_stream {
	unsigned id:3;
	struct rkcif_device		*cifdev;
	struct rkcif_vdev_node		vnode;
	enum rkcif_state		state;
	...
	struct rkcif_scale_vdev		*scale_vdev;
	struct rkcif_tools_vdev		*tools_vdev;
	int				dma_en;
	...
	bool				to_en_scale;
	...
};
```

```680:701:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.h
struct rkcif_scale_vdev {
	unsigned int ch:3;
	struct rkcif_device *cifdev;
	struct rkcif_vdev_node vnode;
	struct rkcif_stream *stream;
	...
	unsigned int ch_src;
	unsigned int scale_mode;
	...
};
```

```731:749:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.h
struct rkcif_tools_vdev {
	unsigned int ch:3;
	struct rkcif_device *cifdev;
	struct rkcif_vdev_node vnode;
	struct rkcif_stream *stream;
	...
	const struct cif_output_fmt *tools_out_fmt;
	...
};
```

也就是说：

- `stream` 是**主采集通道**
- `scale` 是**挂在对应 stream 上的缩放输出口**
- `tools` 是**挂在对应 stream 上的辅助/工具输出口**

这不是三套彼此独立的源，而是：
**`stream` 是主路径，`scale/tools` 是围绕某个 stream 的附属输出路径。**

---

# 2. `RKCIF_STREAM_MIPI_IDx` 节点的具体作用

## 2.1 节点名字本身已经说明了它的语义：ID0~ID3

驱动里直接定义了 4 个 MIPI stream ID：

```42:68:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.h
#define RKCIF_SINGLE_STREAM	1
#define RKCIF_STREAM_CIF	0
...
#define RKCIF_MULTI_STREAMS_NUM	5
#define RKCIF_STREAM_MIPI_ID0	0
#define RKCIF_STREAM_MIPI_ID1	1
#define RKCIF_STREAM_MIPI_ID2	2
#define RKCIF_STREAM_MIPI_ID3	3
#define RKCIF_MAX_STREAM_MIPI	4
#define RKCIF_MAX_STREAM_LVDS	4
#define RKCIF_MAX_STREAM_DVP	4
#define RKCIF_STREAM_DVP	4
```

这里的 `ID0~ID3`，不是“第 0~3 个 video 节点而已”，而是**硬件采集 ID 通道**的概念。

---

## 2.2 它们是怎么注册成 `/dev/videoX` 的

在平台注册阶段，MIPI/LVDS 或新平台统一注册 4 个 stream 节点：

```1692:1728:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int rkcif_register_platform_subdevs(struct rkcif_device *cif_dev)
{
	int stream_num = 0, ret;

	if (cif_dev->chip_id < CHIP_RV1126_CIF) {
		if (cif_dev->inf_id == RKCIF_MIPI_LVDS) {
			stream_num = RKCIF_MAX_STREAM_MIPI;
			ret = rkcif_register_stream_vdevs(cif_dev, stream_num,
							  true);
		} else {
			stream_num = RKCIF_SINGLE_STREAM;
			ret = rkcif_register_stream_vdevs(cif_dev, stream_num,
							  false);
		}
	} else {
		stream_num = RKCIF_MAX_STREAM_MIPI;
		ret = rkcif_register_stream_vdevs(cif_dev, stream_num, true);
	}
	...
}
```

实际注册单个节点时，名字也明确映射到 `mipi_id0~id3`：

```7369:7447:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/capture.c
static int rkcif_register_stream_vdev(struct rkcif_stream *stream,
				      bool is_multi_input)
{
	...
	if (dev->chip_id < CHIP_RV1126_CIF) {
		if (is_multi_input) {
			switch (stream->id) {
			case RKCIF_STREAM_MIPI_ID0:
				vdev_name = CIF_MIPI_ID0_VDEV_NAME;
				break;
			case RKCIF_STREAM_MIPI_ID1:
				vdev_name = CIF_MIPI_ID1_VDEV_NAME;
				break;
			case RKCIF_STREAM_MIPI_ID2:
				vdev_name = CIF_MIPI_ID2_VDEV_NAME;
				break;
			case RKCIF_STREAM_MIPI_ID3:
				vdev_name = CIF_MIPI_ID3_VDEV_NAME;
				break;
...
```

后面它把这个 `stream` 注册成标准 V4L2 capture 节点：

```7447:7486:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/capture.c
	strlcpy(vdev->name, vdev_name, sizeof(vdev->name));
	node = vdev_to_node(vdev);
	mutex_init(&node->vlock);
	...
	vdev->ioctl_ops = &rkcif_v4l2_ioctl_ops;
	vdev->fops = &rkcif_fops;
	...
	vdev->device_caps = V4L2_CAP_VIDEO_CAPTURE_MPLANE |
			    V4L2_CAP_STREAMING;
	...
	ret = media_entity_pads_init(&vdev->entity, 1, &stream->pad);
	...
	ret = video_register_device(vdev, VFL_TYPE_VIDEO, -1);
```

### 结论
`RKCIF_STREAM_MIPI_IDx` 是**主采集 video 节点**。  
用户态真正抓图，核心就是这些节点。

---

## 2.3 这些 stream 节点的“功能本质”

它们本质上是 **CIF 硬件的 4 个输入/采集 ID 通道对应的软件抽象**。  
每个 `stream[id]` 都可以：

- 维护自己的格式
- 自己的 crop
- 自己的 vb2 buffer 队列
- 自己的 DMA 使能状态
- 自己的 frame 计数
- 自己的当前/下一帧地址

也就是说，**它是“真正拥有帧缓冲和 DMA 地址编程能力”的主通道**。

看 `rkcif_stream` 结构体就很明显，它不是个“虚节点”，而是真正负责缓存轮转和 DMA 的对象：

```487:556:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.h
struct rkcif_stream {
	unsigned id:3;
	...
	struct list_head		buf_head;
	struct rkcif_buffer		*curr_buf;
	struct rkcif_buffer		*next_buf;
	...
	const struct cif_output_fmt	*cif_fmt_out;
	const struct cif_input_fmt	*cif_fmt_in;
	struct v4l2_pix_format_mplane	pixm;
	...
	int				dma_en;
	int				to_en_dma;
	...
	bool				is_compact;
	bool				is_high_align;
	bool				to_en_scale;
	...
};
```

---

# 3. `RKCIF_SCALE_CHx` 节点的具体作用

## 3.1 它不是新的 sensor 源，而是绑定到对应 `stream[ch]` 的缩放输出口

初始化时直接一一绑定：

```1054:1081:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-scale.c
void rkcif_init_scale_vdev(struct rkcif_device *cif_dev, u32 ch)
{
	struct rkcif_scale_vdev *scale_vdev = &cif_dev->scale_vdev[ch];
	struct rkcif_stream *stream = &cif_dev->stream[ch];
	...
	scale_vdev->cifdev = cif_dev;
	scale_vdev->stream = stream;
	stream->scale_vdev = scale_vdev;
	scale_vdev->ch = ch;
	...
	rkcif_scale_set_fmt(scale_vdev, &pixm, false);
}
```

这句非常关键：

- `scale_vdev->stream = stream`
- `stream->scale_vdev = scale_vdev`

说明 **scale_ch0 就是绑 stream0，scale_ch1 绑 stream1 ...**

不是随便从 4 个 stream 中任意取一个。

---

## 3.2 它注册成独立 video 节点，但本质是“硬件 scale 输出节点”

注册函数里是标准 capture 节点：

```1083:1135:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-scale.c
static int rkcif_register_scale_vdev(struct rkcif_scale_vdev *scale_vdev, bool is_multi_input)
{
	...
	switch (scale_vdev->ch) {
	case RKCIF_SCALE_CH0:
		vdev_name = CIF_SCALE_CH0_VDEV_NAME;
		break;
	case RKCIF_SCALE_CH1:
		vdev_name = CIF_SCALE_CH1_VDEV_NAME;
		break;
	case RKCIF_SCALE_CH2:
		vdev_name = CIF_SCALE_CH2_VDEV_NAME;
		break;
	case RKCIF_SCALE_CH3:
		vdev_name = CIF_SCALE_CH3_VDEV_NAME;
		break;
	}
	...
	vdev->ioctl_ops = &rkcif_scale_ioctl;
	vdev->fops = &rkcif_scale_fops;
	...
	ret = video_register_device(vdev, VFL_TYPE_VIDEO, -1);
```

所以从用户态看，它就是独立 `/dev/videoX`；  
但从硬件语义看，它不是新的输入源，而是 **scale engine 的输出口**。

---

## 3.3 scale 的输入到底从哪里来

看 `rkcif_scale_channel_init()`：

```590:604:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-scale.c
static int rkcif_scale_channel_init(struct rkcif_scale_vdev *scale_vdev)
{
	struct rkcif_device *cif_dev = scale_vdev->cifdev;
	...
	if (cif_dev->inf_id == RKCIF_DVP)
		scale_vdev->ch_src = SCALE_DVP;
	else
		scale_vdev->ch_src = 4 * cif_dev->csi_host_idx + scale_vdev->ch;
	...
	return 0;
}
```

这里说明：

- 如果是 DVP，scale 输入源就是 `SCALE_DVP`
- 如果是 MIPI/LVDS，scale 输入源是  
  `4 * csi_host_idx + scale_ch`

也就是：  
**某个 CSI host 下的第 `ch` 路输入**。

再看它真正下发硬件时：

```820:826:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-scale.c
	rkcif_write_register(dev, get_reg_index_of_scale_vlw(ch),
			     scale_vdev->ch_info.vir_width);
	val = CIF_SCALE_SW_SRC_CH(scale_vdev->ch_src, ch) |
	      CIF_SCALE_SW_MODE(scale_vdev->scale_mode, ch) |
	      CIF_SCALE_EN(ch);
	rkcif_write_register_or(dev, CIF_REG_SCL_CH_CTRL,
				val);
```

这说明 scale 硬件明确要配置：

- `scale 通道 ch`
- 它的输入源 `ch_src`

### 结论
`RKCIF_SCALE_CHx` 的作用是：

- 从对应 `stream/ch` 的采集路径取数
- 走硬件 scale
- 以独立 video 节点形式输出缩放后的数据

所以它不是“新的一路 sensor”，而是**围绕某个主 stream 的后处理输出**。

---

# 4. `RKCIF_TOOLS_CHx` 节点的具体作用

## 4.1 它也是绑定到某个 stream 的辅助输出口

初始化同样是一一绑定：

```793:816:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-tools.c
void rkcif_init_tools_vdev(struct rkcif_device *cif_dev, u32 ch)
{
	struct rkcif_tools_vdev *tools_vdev = &cif_dev->tools_vdev[ch];
	struct rkcif_stream *stream = &cif_dev->stream[ch];
	...
	tools_vdev->cifdev = cif_dev;
	tools_vdev->stream = stream;
	stream->tools_vdev = tools_vdev;
	tools_vdev->ch = ch;
	...
	rkcif_tools_set_fmt(tools_vdev, &pixm, false);
}
```

所以：

- `tools_ch0` 对应 `stream0`
- `tools_ch1` 对应 `stream1`
- `tools_ch2` 对应 `stream2`

---

## 4.2 为什么 tools 只有 3 个，不是 4 个

定义里直接写死了：

```716:729:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.h
#define RKCIF_TOOLS_CH0		0
#define RKCIF_TOOLS_CH1		1
#define RKCIF_TOOLS_CH2		2
#define RKCIF_MAX_TOOLS_CH	3

#define CIF_TOOLS_CH0_VDEV_NAME CIF_DRIVER_NAME	"_tools_id0"
#define CIF_TOOLS_CH1_VDEV_NAME CIF_DRIVER_NAME	"_tools_id1"
#define CIF_TOOLS_CH2_VDEV_NAME CIF_DRIVER_NAME	"_tools_id2"
```

这说明 tools 路径在硬件/驱动设计里就只支持 3 路。  
这通常和 RAW/HDR 三帧（L/M/S）或 ISP 回读辅助路径数量有关，不是简单的“为什么少写了一个”。

---

## 4.3 tools 节点到底干什么

从 `tools_work()` 看得很清楚：

```782:790:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-tools.c
static void rkcif_tools_work(struct work_struct *work)
{
	struct rkcif_tools_vdev *tools_vdev = container_of(work,
						struct rkcif_tools_vdev,
						work);
	if (tools_vdev->stream->dma_en & RKCIF_DMAEN_BY_VICAP)
		rkcif_tools_buf_done(tools_vdev);
	else if (tools_vdev->stream->dma_en & RKCIF_DMAEN_BY_ISP)
		rkcif_tools_buf_done_rdbk(tools_vdev);
}
```

这说明 tools 节点的数据来源依赖于其绑定的 stream 当前工作模式：

- 如果 stream 当前是 VICAP 采集路径，tools 走 `rkcif_tools_buf_done`
- 如果 stream 当前是 ISP 回读路径，tools 走 `rkcif_tools_buf_done_rdbk`

而 `rkcif_tools_buf_done_rdbk()` 里面甚至直接在做 copy：

```753:770:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-tools.c
		for (i = 0; i < fmt->mplanes; i++) {
			u32 payload_size = tools_vdev->pixm.plane_fmt[i].sizeimage;
			void *src = buf->dummy.vaddr;
			void *dst = vb2_plane_vaddr(&tools_vdev->curr_buf->vb.vb2_buf, i);
			...
			memcpy(dst, src, payload_size);
		}
		tools_vdev->curr_buf->vb.sequence = buf->dbufs.sequence;
		tools_vdev->curr_buf->vb.vb2_buf.timestamp = buf->dbufs.timestamp;
		vb2_buffer_done(&tools_vdev->curr_buf->vb.vb2_buf, VB2_BUF_STATE_DONE);
```

### 结论
`tools` 节点不是主采集节点，而是：

- 给某个 stream 提供的辅助 RAW/工具输出口
- 有时来自 VICAP 当前路径
- 有时来自 ISP 回读路径
- 更像算法/调试/工具链用的附加输出

---

# 5. 回答你的第 2 个核心问题：  
# `4 个 RKCIF_STREAM_MIPI_IDx` 和 `RKCIF_SCALE_CHx` 到底对应什么流？

这个要分情况回答，不能一句“是一分四”或者“一路一路”概括。

---

## 5.1 先说结论

### `4 个 RKCIF_STREAM_MIPI_IDx`
它们本质上是 **4 个 CIF 输入/采集通道**。  
这些通道承载的流，取决于实际输入拓扑：

1. **MIPI CSI2 多 VC 场景**  
   一个 sensor 可能输出多个 VC/通道，这时 `ID0~ID3` 可以对应不同 VC 数据流

2. **HDR 场景**  
   `ID0/1/2` 可能分别对应 Long / Middle / Short 曝光帧

3. **BT656/BT1120 多路复用场景**  
   同一物理输入上复用出来多路 ID，驱动也映射成 `ID0~ID3`

4. **普通单 sensor 单 VC 场景**  
   实际可能只有 `ID0` 真正在跑，其他节点只是被注册出来但不一定都承载有效数据

### `4 个 RKCIF_SCALE_CHx`
它们不是独立 sensor 流，  
而是**分别挂在 `stream0~stream3` 后面的 4 个 scale 输出通道**。

所以 `scale_chx` 是“对对应 stream[x] 的后处理输出”，不是另一组输入源。

---

## 5.2 为什么说 `stream` 不是“固定的一路复制成四份”

看 CSI 通道数的计算：

```3280:3316:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/capture.c
static void rkcif_csi_get_vc_num(struct rkcif_device *dev,
				 unsigned int mbus_flags)
{
	int i, vc_num = 0;

	for (i = 0; i < RKCIF_MAX_CSI_CHANNEL; i++) {
		if (mbus_flags & V4L2_MBUS_CSI2_CHANNEL_0) {
			dev->channels[vc_num].vc = vc_num;
			vc_num++;
			mbus_flags ^= V4L2_MBUS_CSI2_CHANNEL_0;
			continue;
		}
		...
		if (mbus_flags & V4L2_MBUS_CSI2_CHANNEL_3) {
			dev->channels[vc_num].vc = vc_num;
			vc_num++;
			mbus_flags ^= V4L2_MBUS_CSI2_CHANNEL_3;
			continue;
		}
	}

	dev->num_channels = vc_num ? vc_num : 1;
	if (dev->num_channels == 1)
		dev->channels[0].vc = 0;
}
```

这里直接根据 `mbus.flags` 里的 `CSI2_CHANNEL_0~3` 去解析出 VC 通道数。

这说明什么？

**stream[0..3] 的存在，是为了接住 CIF 硬件可能出现的多通道输入，不是为了机械地把单路视频复制四份。**

---

## 5.3 为什么又说它有时会承载 HDR 的不同曝光流

看 `csi_stream_start()` 里对 HDR 的处理：

```4041:4085:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/capture.c
static int rkcif_csi_stream_start(struct rkcif_stream *stream, unsigned int mode)
{
	...
	channel = &dev->channels[stream->id];
	channel->id = stream->id;
	...
	if (stream->state != RKCIF_STATE_STREAMING) {
		if (mode  == RKCIF_STREAM_MODE_CAPTURE) {
			stream->dma_en |= RKCIF_DMAEN_BY_VICAP;
		} else if (mode == RKCIF_STREAM_MODE_TOISP_RDBK) {
			stream->dma_en |= RKCIF_DMAEN_BY_ISP;
		} else if (mode == RKCIF_STREAM_MODE_TOISP) {
			if (dev->hdr.hdr_mode == HDR_X2 &&
			    stream->id == 0)
				stream->dma_en |= RKCIF_DMAEN_BY_ISP;
			else if (dev->hdr.hdr_mode == HDR_X3 && (stream->id == 0 || stream->id == 1))
				stream->dma_en |= RKCIF_DMAEN_BY_ISP;
```

以及 LVDS HDR 场景里，不同 `stream->id` 对应不同曝光组：

```3328:3348:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/capture.c
	if (dev->hdr.hdr_mode == NO_HDR || dev->hdr.hdr_mode == HDR_COMPR) {
		...
	} else {
		if (channel->id == RKCIF_STREAM_MIPI_ID0)
			frm_sync_code = &lvds_cfg->frm_sync_code[LVDS_CODE_GRP_LONG];

		if (dev->hdr.hdr_mode == HDR_X2) {
			if (channel->id == RKCIF_STREAM_MIPI_ID1)
				frm_sync_code = &lvds_cfg->frm_sync_code[LVDS_CODE_GRP_SHORT];
			else
				frm_sync_code = &lvds_cfg->frm_sync_code[LVDS_CODE_GRP_LONG];
		} else if (dev->hdr.hdr_mode == HDR_X3) {
			if (channel->id == RKCIF_STREAM_MIPI_ID1)
				frm_sync_code = &lvds_cfg->frm_sync_code[LVDS_CODE_GRP_MEDIUM];
			else if (channel->id == RKCIF_STREAM_MIPI_ID2)
				frm_sync_code = &lvds_cfg->frm_sync_code[LVDS_CODE_GRP_SHORT];
			else
				frm_sync_code = &lvds_cfg->frm_sync_code[LVDS_CODE_GRP_LONG];
		}
```

这已经非常明确了：

- HDR_X2 时，`ID0/ID1` 可能就是长短帧
- HDR_X3 时，`ID0/ID1/ID2` 可能就是长中短帧

所以这里绝不是简单复制，而是**不同 stream 节点可能代表不同曝光子流**。

---

## 5.4 为什么在 BT656/BT1120 上也会有 4 个 stream

看 `rkcif_plat_init()` 的注释：

```1949:1964:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
	if (cif_dev->chip_id < CHIP_RV1126_CIF) {
		...
	} else {
		/* for rv1126/rk356x, bt656/bt1120/mipi are multi channels */
		rkcif_stream_init(cif_dev, RKCIF_STREAM_MIPI_ID0);
		rkcif_stream_init(cif_dev, RKCIF_STREAM_MIPI_ID1);
		rkcif_stream_init(cif_dev, RKCIF_STREAM_MIPI_ID2);
		rkcif_stream_init(cif_dev, RKCIF_STREAM_MIPI_ID3);
	}
```

这句注释已经点明了：

- 在 `rv1126/rk356x` 上
- `bt656/bt1120/mipi` 都按 **multi channels** 模型处理

所以你看到是 `RKCIF_STREAM_MIPI_IDx` 这个名字，不代表它一定只服务 MIPI。  
在新平台上，它其实是统一的“4 路输入通道抽象”。

---

# 6. 那 `scale_chx` 和 `stream_idx` 是什么关系？

是**一一对应关系**，不是“三份复制”。

## 6.1 初始化关系
```1054:1065:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-scale.c
void rkcif_init_scale_vdev(struct rkcif_device *cif_dev, u32 ch)
{
	...
	struct rkcif_stream *stream = &cif_dev->stream[ch];
	...
	scale_vdev->stream = stream;
	stream->scale_vdev = scale_vdev;
	scale_vdev->ch = ch;
```

## 6.2 start streaming 时也直接拿对应 stream
```873:888:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-scale.c
static int
rkcif_scale_vb2_start_streaming(struct vb2_queue *queue,
				unsigned int count)
{
	struct rkcif_scale_vdev *scale_vdev = queue->drv_priv;
	struct rkcif_stream *stream = scale_vdev->stream;
	...
	if (stream->state == RKCIF_STATE_STREAMING) {
		stream->to_en_scale = true;
	} else {
		ret = rkcif_scale_start(scale_vdev);
```

也就是说：

- 如果主 stream 已经在跑，开 scale 时只是给 stream 打个 `to_en_scale`
- 否则就启动对应 scale 通道

### 这意味着
`scale_ch0` 不是从 `stream0~3` 任意选一个，而是天然挂 `stream0`。  
同理：

- `scale_ch1 <-> stream1`
- `scale_ch2 <-> stream2`
- `scale_ch3 <-> stream3`

---

# 7. 所以到底是不是“一路 sensor 输出被分为三份/四份”？

## 7.1 对 `stream` 来说：**一般不能这么理解**
更准确的说法应该是：

**CIF 把输入数据按“通道/VC/曝光子帧/复用 ID”拆分成多个 stream。**

这几个 stream 有时来自同一个 sensor，但它们不一定是“同一帧简单复制”：

- 可能是同一 sensor 的不同 VC
- 可能是同一 sensor 的 HDR 不同曝光
- 可能是同一总线复用出的不同通道
- 也可能实际上只有一个通道有效

所以：
**不是“主流切三份/四份”，而是“输入本身就可能包含多路子流，CIF 用 ID0~ID3 去承接”。**

---

## 7.2 对 `scale` 来说：可以理解为“对应 stream 的派生输出”
这一点更像“复制/派生”：

- 主采集 `streamX` 负责原始采集
- `scale_chX` 从 `streamX` 这一路取输入，经过硬件 scale，再输出一份缩放结果

所以 scale 是**基于 stream 的后处理派生路径**。

---

# 8. 一个最容易理解的最终图

你可以把它理解成这样：

## 场景 A：普通单 sensor 单 VC
- `stream_id0`：真正有数据
- `stream_id1/2/3`：注册了，但大概率不用
- `scale_ch0`：如果打开，就是 `stream0` 的缩放输出
- `tools_ch0`：如果打开，就是 `stream0` 的辅助输出

## 场景 B：一个 MIPI sensor 输出 4 个 VC
- `stream_id0`：VC0
- `stream_id1`：VC1
- `stream_id2`：VC2
- `stream_id3`：VC3  
- `scale_ch0~3`：分别对应各自 VC 流的 scale 输出

## 场景 C：HDR_X3
- `stream_id0`：Long
- `stream_id1`：Middle
- `stream_id2`：Short
- `stream_id3`：可能闲置/保留
- `tools_ch0~2`：正好常对应这 3 路 RAW/HDR 工具输出

## 场景 D：BT656/BT1120 多路复用
- `stream_id0~3`：对应复用拆出来的 4 路 channel/id
- `scale_chx`：对应每一路的缩放输出

---

# 9. 直接回答你的两个问题

---

## 问题 1：能否依次结合源码分析这些 video 节点的具体作用？

### `RKCIF_STREAM_MIPI_ID0~3`
- 是 CIF 的**主采集 video 节点**
- 真正负责：
  - set_fmt/crop
  - vb2 buffer 管理
  - DMA 地址编程
  - IRQ 收帧
- 它们代表 CIF 的 **ID0~ID3 输入采集通道**

参考：

```7369:7486:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/capture.c
static int rkcif_register_stream_vdev(struct rkcif_stream *stream,
				      bool is_multi_input)
{
	...
	vdev->ioctl_ops = &rkcif_v4l2_ioctl_ops;
	vdev->fops = &rkcif_fops;
	...
	ret = media_entity_pads_init(&vdev->entity, 1, &stream->pad);
	...
	ret = video_register_device(vdev, VFL_TYPE_VIDEO, -1);
```

---

### `RKCIF_SCALE_CH0~3`
- 是**挂在各自 stream 上的硬件缩放输出节点**
- 一一绑定：
  - `scale_ch0 -> stream0`
  - `scale_ch1 -> stream1`
  - ...
- 不是新的输入源，而是 stream 的后处理输出口

参考：

```1054:1081:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-scale.c
void rkcif_init_scale_vdev(struct rkcif_device *cif_dev, u32 ch)
{
	...
	struct rkcif_stream *stream = &cif_dev->stream[ch];
	...
	scale_vdev->stream = stream;
	stream->scale_vdev = scale_vdev;
```

```590:604:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-scale.c
static int rkcif_scale_channel_init(struct rkcif_scale_vdev *scale_vdev)
{
	...
	if (cif_dev->inf_id == RKCIF_DVP)
		scale_vdev->ch_src = SCALE_DVP;
	else
		scale_vdev->ch_src = 4 * cif_dev->csi_host_idx + scale_vdev->ch;
```

---

### `RKCIF_TOOLS_CH0~2`
- 是**绑定到前 3 个 stream 上的辅助/工具输出节点**
- 主要用于：
  - VICAP 数据辅助输出
  - ISP 回读路径辅助输出
  - RAW/工具链/调试场景

参考：

```793:816:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-tools.c
void rkcif_init_tools_vdev(struct rkcif_device *cif_dev, u32 ch)
{
	...
	tools_vdev->stream = stream;
	stream->tools_vdev = tools_vdev;
```

```782:790:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-tools.c
static void rkcif_tools_work(struct work_struct *work)
{
	...
	if (tools_vdev->stream->dma_en & RKCIF_DMAEN_BY_VICAP)
		rkcif_tools_buf_done(tools_vdev);
	else if (tools_vdev->stream->dma_en & RKCIF_DMAEN_BY_ISP)
		rkcif_tools_buf_done_rdbk(tools_vdev);
}
```

---

## 问题 2：`4 个 RKCIF_STREAM_MIPI_IDx` 和 `RKCIF_SCALE_CHx` 的 stream 到底是什么？

### 我的结论是：

### 对 `RKCIF_STREAM_MIPI_IDx`
它们是 **4 个主采集通道**，不是固定的“单路 sensor 复制 4 份”。

它们可能表示：

- 同一 sensor 的多 VC
- HDR 的不同曝光帧
- BT656/BT1120 多路通道
- 或者仅仅其中一路有效

依据：

```3280:3316:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/capture.c
static void rkcif_csi_get_vc_num(struct rkcif_device *dev,
				 unsigned int mbus_flags)
{
	...
	if (mbus_flags & V4L2_MBUS_CSI2_CHANNEL_0) ...
	if (mbus_flags & V4L2_MBUS_CSI2_CHANNEL_1) ...
	if (mbus_flags & V4L2_MBUS_CSI2_CHANNEL_2) ...
	if (mbus_flags & V4L2_MBUS_CSI2_CHANNEL_3) ...
}
```

以及 HDR 分配：

```3328:3348:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/capture.c
if (dev->hdr.hdr_mode == HDR_X2) {
	if (channel->id == RKCIF_STREAM_MIPI_ID1)
		frm_sync_code = ...SHORT;
	else
		frm_sync_code = ...LONG;
} else if (dev->hdr.hdr_mode == HDR_X3) {
	if (channel->id == RKCIF_STREAM_MIPI_ID1)
		frm_sync_code = ...MEDIUM;
	else if (channel->id == RKCIF_STREAM_MIPI_ID2)
		frm_sync_code = ...SHORT;
	else
		frm_sync_code = ...LONG;
}
```

---

### 对 `RKCIF_SCALE_CHx`
它们是 **对应 `stream[x]` 的 scale 派生输出**。

不是多路 sensor 的另一组独立 stream，  
而是：

- `stream[x]` 先采集
- `scale_ch[x]` 再从这一路拿输入做缩放

依据：

```1054:1065:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-scale.c
scale_vdev->stream = stream;
stream->scale_vdev = scale_vdev;
```

---

如果你愿意，我下一步可以继续给你做两件更深入的事：

1. **把 `RKCIF_STREAM_MIPI_ID0~3` 在 RK3568 上结合 dts/media graph 画成一张“数据流拓扑图”**
2. **继续往下分析：用户态对某个 `videoX` 执行 `VIDIOC_STREAMON` 后，最终是怎么走到 `rkcif_csi_stream_start()` / `rkcif_stream_start()` 并把寄存器配起来的**

如果你要，我下一条就可以直接按  
**“open videoX -> set_fmt -> reqbufs -> qbuf -> streamon -> IRQ 收帧”**  
这条路径继续详细拆。

