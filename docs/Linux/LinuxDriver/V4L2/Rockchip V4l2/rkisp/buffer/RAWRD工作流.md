# RKISP RAWRD 回读与在线模式源码流程分析


```
用较为简单的结论归纳：

回读模式下，
CIF 把已经写好 RAW 数据的 DDR buffer 描述符传给 ISP；
ISP 驱动把这个 buffer 映射成 ISP 可访问的 DMA 地址；
再把它挂到对应 RAWRD stream；
RAWRD 的 update_mi() 把 DMA 地址写进 MI_RAWx_RD_BASE；
随后 rkisp_trigger_read_back() 触发 ISP 从 DDR 读取 RAW；
ISP 按 readback/HDR 模式处理这一帧或这一组帧。

```

本文结合源码整理 `RKISP_STREAM_RAWRD0/1/2` 的完整工作流程，重点回答几个问题：

```text
1. RAWRD 是 V4L2 output 设备，为什么还能接收 buffer？
2. CIF 抓到的 RAW 帧如何进入 DDR？
3. CIF 如何把 DDR RAW buffer 交给 ISP？
4. ISP 如何把这些 buffer 映射到 RAWRD0/1/2？
5. RAWRD 如何触发 ISP 从 DDR 回读 RAW？
6. ISP 处理完后 buffer 如何归还给 CIF？
7. 在线直通模式与回读模式有什么区别？
```

## 1. 总体结论

RKISP 有两类输入路径：

```text
在线直通:
Sensor/MIPI/CIF -> ISP

离线/回读:
DDR raw buffer -> RAWRD0/1/2 -> ISP
```

`RKISP_STREAM_RAWRD0/1/2` 是 ISP 的 DDR RAW 读入口。它们不是把图像采出来的 capture 设备，而是把 DDR 中已有的 RAW buffer 喂给 ISP 的 V4L2 output 设备。

所以 RAWRD 的核心作用是：

```text
拿到一块 RAW buffer 的 DMA 地址
        |
        v
写入 MI_RAWx_RD_BASE
        |
        v
触发 ISP readback
        |
        v
ISP 从 DDR 读 RAW 并走后续 ISP pipeline
```

## 2. 涉及的核心源码

主要文件：

```text
kernel/drivers/media/platform/rockchip/isp/isp_external.h
kernel/drivers/media/platform/rockchip/cif/subdev-itf.c
kernel/drivers/media/platform/rockchip/cif/capture.c
kernel/drivers/media/platform/rockchip/isp/csi.c
kernel/drivers/media/platform/rockchip/isp/rkisp.c
kernel/drivers/media/platform/rockchip/isp/dmarx.c
```

几个关键数据结构和命令在 `isp_external.h`：

```c
enum rkisp_vicap_link {
	RKISP_VICAP_ONLINE,
	RKISP_VICAP_RDBK_AIQ,
	RKISP_VICAP_RDBK_AUTO,
};

enum rx_buf_type {
	BUF_SHORT,
	BUF_MIDDLE,
	BUF_LONG,
};

struct rkisp_rx_buf {
	struct dma_buf *dbuf;
	dma_addr_t dma;
	u64 timestamp;
	u32 sequence;
	u32 type;
	u32 runtime_us;
	bool is_init;
	bool is_first;
	bool is_resmem;
	bool is_switch;
	bool is_uncompact;
};
```

`rkisp_rx_buf` 是 CIF 与 ISP 之间传递 DDR RAW buffer 的小型描述符。它不搬运图像数据，只传递 buffer 对象、DMA 地址、帧序号、时间戳、曝光类型等信息。

## 3. 三种模式先区分清楚

### 3.1 ONLINE：在线直通

典型链路：

```text
Sensor -> MIPI CSI2/DPHY -> CIF/VICAP -> ISP
```

或者：

```text
Sensor -> MIPI CSI2/DPHY -> rkisp-csi-subdev -> ISP
```

特点：

```text
数据是实时 pixel stream
不需要把整帧 RAW 先落 DDR
不需要用户态 QBUF 到 rawrd
不使用 MI_RAW0/1/2_RD_BASE
```

CIF 到 ISP 的在线模式在 `subdev-itf.c` 中体现：

```c
if (priv->mode.rdbk_mode == RKISP_VICAP_ONLINE) {
	...
	mode = RKCIF_STREAM_MODE_TOISP;
}
```

也就是 CIF 通过 `CIF_TOISP` 直接把像素流送给 ISP。

### 3.2 RDBK_AIQ：用户态/AIQ 手动回读

典型链路：

```text
CIF 抓 RAW 到 DDR/video buffer
        |
        v
用户态/AIQ 拿到 RAW buffer
        |
        v
QBUF 到 rkisp_rawrd0/1/2
        |
        v
ISP 从 DDR 回读 RAW
```

这是 RK3568 这类 ISP_V21 平台常见理解方式。因为 `csi.c` 中对 CIF 输入的处理有这个判断：

```c
if (dev->isp_inp == INP_CIF && dev->isp_ver > ISP_V21)
	mode.rdbk_mode = dev->is_rdbk_auto ?
			 RKISP_VICAP_RDBK_AUTO :
			 RKISP_VICAP_ONLINE;
else
	mode.rdbk_mode = RKISP_VICAP_RDBK_AIQ;
```

也就是说，`ISP_V21` 及以前平台在 CIF 接 ISP 的场景下更常被设置为 `RKISP_VICAP_RDBK_AIQ`。

### 3.3 RDBK_AUTO：驱动自动回读

典型链路：

```text
CIF 内部分配 raw buffer
        |
        v
CIF DMA 写 RAW 到 DDR
        |
        v
CIF 通过 s_rx_buffer 把 rkisp_rx_buf 交给 ISP
        |
        v
ISP 内部映射到 RAWRD0/1/2
        |
        v
ISP readback 从 DDR 读 RAW
        |
        v
处理完后 ISP 把 buffer 还给 CIF
```

这是本文后面重点展开的“CIF 到 RAWRD 到 ISP”的内核自动回读闭环。

## 4. RAWRD 为什么是 V4L2 output 设备

`dmarx.c` 注册 RAWRD video node 时设置：

```c
vdev->device_caps = V4L2_CAP_VIDEO_OUTPUT_MPLANE |
		    V4L2_CAP_STREAMING;
vdev->vfl_dir = VFL_DIR_TX;
node->pad.flags = MEDIA_PAD_FL_SOURCE;

rkisp_init_vb2_queue(&node->buf_queue, stream,
	V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE);
```

这说明 `rkisp_rawrd0/1/2` 是 output 设备。

V4L2 中 output/capture 的方向是以“用户态与硬件的关系”为准：

```text
V4L2_CAPTURE:
硬件 -> DDR buffer -> 用户态

V4L2_OUTPUT:
用户态/驱动 -> DDR buffer -> 硬件
```

RAWRD 属于第二种。它接收 buffer 的含义是：

```text
用户态或 CIF 驱动把一块 DDR RAW buffer 交给 RAWRD
RAWRD 把这个 buffer 的 DMA 地址配置给 ISP
ISP 硬件从 DDR 读这块 RAW
```

media graph 中 `rkisp_rawrdX -> rkisp-isp-subdev` 表示的是数据流方向：

```text
DDR RAW source -> ISP sink
```

V4L2 output 表示的是 buffer 投递方向：

```text
用户态/驱动 -> RAWRD -> 硬件
```

这两个方向不冲突。

## 5. RAWRD0/1/2 初始化与寄存器绑定

`dmarx.c` 中 `dmarx_init()` 根据 stream id 初始化不同的 RAWRD 节点：

```c
case RKISP_STREAM_RAWRD0:
	stream->ops = &rkisp2_dmarx_streams_ops;
	stream->config = &rkisp2_dmarx0_stream_config;
	break;
case RKISP_STREAM_RAWRD1:
	stream->ops = &rkisp2_dmarx_streams_ops;
	stream->config = &rkisp2_dmarx1_stream_config;
	break;
case RKISP_STREAM_RAWRD2:
	stream->ops = &rkisp2_dmarx_streams_ops;
	stream->config = &rkisp2_dmarx2_stream_config;
	break;
```

`ops` 是硬件操作函数表：

```c
static struct streams_ops rkisp2_dmarx_streams_ops = {
	.config_mi = rawrd_config_mi,
	.update_mi = update_rawrd,
};
```

`config` 则绑定不同 RAWRD 通道的寄存器：

```c
RAWRD0:
	frame_end_id      = RAW0_RD_FRAME
	y_base_ad_init    = MI_RAW0_RD_BASE
	y_base_ad_shd     = MI_RAW0_RD_BASE_SHD
	length            = MI_RAW0_RD_LENGTH

RAWRD1:
	frame_end_id      = RAW1_RD_FRAME
	y_base_ad_init    = MI_RAW1_RD_BASE
	y_base_ad_shd     = MI_RAW1_RD_BASE_SHD
	length            = MI_RAW1_RD_LENGTH

RAWRD2:
	frame_end_id      = RAW2_RD_FRAME
	y_base_ad_init    = MI_RAW2_RD_BASE
	y_base_ad_shd     = MI_RAW2_RD_BASE_SHD
	length            = MI_RAW2_RD_LENGTH
```

所以 `stream->config` 决定“这个 RAWRD stream 写哪组硬件寄存器”，`stream->ops` 决定“如何配置/更新这些寄存器”。

## 6. CIF 侧：RAW 帧如何写入 DDR

自动回读时，CIF 需要先申请内部 raw buffer。入口在 `subdev-itf.c`：

```c
case RKISP_VICAP_CMD_INIT_BUF:
	priv->buf_num = *pbuf_num;
	ret = sditf_init_buf(priv);
	return ret;
```

`sditf_init_buf()` 会根据 HDR 模式调用 CIF capture 层：

```c
HDR_X2 + RDBK_AUTO:
	rkcif_init_rx_buf(&cif_dev->stream[0], priv->buf_num);
	rkcif_init_rx_buf(&cif_dev->stream[1], priv->buf_num);

HDR_X3 + RDBK_AUTO:
	rkcif_init_rx_buf(&cif_dev->stream[0], priv->buf_num);
	rkcif_init_rx_buf(&cif_dev->stream[1], priv->buf_num);
	rkcif_init_rx_buf(&cif_dev->stream[2], priv->buf_num);

NO_HDR + RDBK_AUTO:
	rkcif_init_rx_buf(&cif_dev->stream[0], priv->buf_num);
```

真正分配 buffer 的函数在 `cif/capture.c`：

```c
int rkcif_init_rx_buf(struct rkcif_stream *stream, int buf_num)
```

它先根据 HDR 模式和 CIF stream id 标记曝光类型：

```c
NO_HDR:
	stream[0] -> BUF_SHORT

HDR_X2:
	stream[0] -> BUF_MIDDLE
	stream[1] -> BUF_SHORT

HDR_X3:
	stream[0] -> BUF_LONG
	stream[1] -> BUF_MIDDLE
	stream[2] -> BUF_SHORT
```

然后给每个 buffer 分配 DDR 内存：

```c
dummy->size = pixm->plane_fmt[0].sizeimage;
dummy->is_need_vaddr = true;
dummy->is_need_dbuf = true;
ret = rkcif_alloc_buffer(dev, dummy);
buf->dbufs.dbuf = dummy->dbuf;
buf->dbufs.type = frm_type;
list_add_tail(&buf->list, &stream->rx_buf_head);
```

这一步只是准备 DDR buffer，还没有写 RAW 数据。

CIF 真正把 RAW 写到 DDR，是在 stream 运行时把 buffer 的 DMA 地址写入 CIF frame address 寄存器。相关逻辑在：

```c
rkcif_assign_new_buffer_update_toisp()
rkcif_assign_new_buffer_pingpong_toisp()
```

可以理解为：

```text
从 stream->rx_buf_head 取一个空 buffer
        |
        v
把 buffer->dummy.dma_addr 配到 CIF 当前 frame address
        |
        v
CIF 硬件 DMA 把传感器 RAW 写入这块 DDR buffer
```

这里没有 CPU 拷贝整帧图像，写 DDR 的动作是 CIF 硬件 DMA 完成的。

## 7. CIF 帧结束后如何交给 ISP

CIF 一帧写完后，`rkcif_assign_new_buffer_update_toisp()` 会把上一帧完成的 active buffer 交给 ISP。

关键逻辑：

```c
if (priv && priv->mode.rdbk_mode == RKISP_VICAP_RDBK_AUTO) {
	if (stream->frame_idx == 1)
		active_buf->dbufs.is_first = true;
	active_buf->dbufs.sequence = stream->frame_idx - 1;
	active_buf->dbufs.timestamp = stream->readout.fs_timestamp;
	active_buf->fe_timestamp = ktime_get_ns();

	if (dev->hdr.hdr_mode == NO_HDR)
		rkcif_s_rx_buffer(dev, &active_buf->dbufs);
	else
		rkcif_rdbk_frame_end_toisp(stream, active_buf);
}
```

`rkcif_s_rx_buffer()` 是 CIF 交给 ISP 的关键函数：

```c
static void rkcif_s_rx_buffer(struct rkcif_device *dev,
			      struct rkisp_rx_buf *dbufs)
{
	pad = media_entity_remote_pad(&dev->sditf[0]->pads[0]);
	sd = media_entity_to_v4l2_subdev(pad->entity);
	v4l2_subdev_call(sd, video, s_rx_buffer, dbufs, NULL);
}
```

也就是说，CIF 沿着 media link 找到远端 ISP subdev，然后调用 ISP 的：

```text
.s_rx_buffer = rkisp_sd_s_rx_buffer
```

对于 HDR_X2/HDR_X3，CIF 不会随便来一帧就交给 ISP，而是先在：

```c
rkcif_rdbk_frame_end_toisp()
```

里做多曝光帧同步：

```text
HDR_X2: 等待 L/M 或 M/S 成组
HDR_X3: 等待 L/M/S 三帧成组
检查 timestamp 是否匹配
匹配后再分别 rkcif_s_rx_buffer() 给 ISP
```

这一步的目的，是保证 ISP HDR merge 回读时拿到的是同一组曝光序列。

### 7.1 为什么 CIF 找到的不是 RAWRD

这里容易产生一个疑问：

```text
既然最后要走 RAWRD0/1/2 回读，
CIF 沿着 media link 找到的远端为什么不是 rkisp_rawrdX？
```

原因是：`rkisp_rawrd0/1/2` 不是 `v4l2_subdev`，而是 ISP 驱动内部注册出来的 V4L2 output video node。

`dmarx.c` 注册 RAWRD 节点时，设置的是：

```c
vdev->device_caps = V4L2_CAP_VIDEO_OUTPUT_MPLANE |
		    V4L2_CAP_STREAMING;
vdev->vfl_dir = VFL_DIR_TX;
node->pad.flags = MEDIA_PAD_FL_SOURCE;
```

所以它对应的是：

```text
video_device: rkisp_rawrd0_m / rkisp_rawrd1_l / rkisp_rawrd2_s
```

而不是：

```text
v4l2_subdev
```

CIF 调用的是：

```c
v4l2_subdev_call(sd, video, s_rx_buffer, dbufs, NULL);
```

这个 `sd` 必须是 `struct v4l2_subdev *`。`rkisp_rawrdX` 是 video node，没有 `.s_rx_buffer` 这种 subdev 回调，因此 CIF 不能直接把 buffer 交给 `rkisp_rawrdX`。

CIF 侧 `rkcif_s_rx_buffer()` 沿着的是 CIF sditf 的 media link：

```text
rkcif sditf pad -> rkisp-isp-subdev sink pad
```

所以它找到的远端 entity 是：

```text
rkisp-isp-subdev
```

不是：

```text
rkisp_rawrd0/1/2
```

更准确的结构是：

```text
CIF sditf
  -> rkisp-isp-subdev.s_rx_buffer()
      -> rkisp_rx_buf_pool_init()
      -> rkisp_rx_qbuf()
          -> 根据 BUF_SHORT/MIDDLE/LONG 分发到 RAWRD2/0/1
              -> update_rawrd()
              -> MI_RAWx_RD_BASE
              -> ISP readback
```

也就是说：

```text
CIF 不直接找 RAWRD
CIF 只把 raw buffer 交给 ISP subdev
ISP subdev 再在驱动内部把 buffer 分发给 RAWRD stream
```

这是合理的，因为只有 ISP 驱动知道当前 readback/HDR 状态，以及：

```text
BUF_SHORT/MIDDLE/LONG 应该对应哪个 RAWRD
RAWRD0/1/2 是否存在
当前是 HDR_RDBK_FRAME1/2/3 哪种模式
如何配置 CSI2RX_RAW_RD_CTRL
何时调用 rkisp_trigger_read_back()
```

因此，RAWRD 可以理解为 ISP 的“DDR RAW 前级输入源”，但它不是 CIF 链路上的前级 subdev。它在 media graph 中表现为 `rkisp-isp-subdev` 的 source entity，在驱动实现中则是 ISP 内部的 dmarx stream/video output queue。

## 8. ISP 如何接收 CIF 的 raw buffer

ISP subdev 的 video ops 中注册了：

```c
static const struct v4l2_subdev_video_ops rkisp_isp_sd_video_ops = {
	.s_stream = rkisp_isp_sd_s_stream,
	.s_rx_buffer = rkisp_sd_s_rx_buffer,
};
```

当 CIF 调用 `s_rx_buffer` 时，进入 `rkisp.c`：

```c
static int rkisp_sd_s_rx_buffer(struct v4l2_subdev *sd,
				void *buf, unsigned int *size)
{
	dbufs = buf;
	if (!dbufs->is_init)
		ret = rkisp_rx_buf_pool_init(dev, dbufs);
	if (!ret)
		ret = rkisp_rx_qbuf(dev, dbufs);
	return ret;
}
```

ISP 对 CIF buffer 做两件事：

```text
第一次见到这个 buffer:
	rkisp_rx_buf_pool_init()

每次这个 buffer 完成一帧:
	rkisp_rx_qbuf()
```

## 9. ISP 第一次接收 buffer：attach/map dma-buf

`rkisp_rx_buf_pool_init()` 会把 CIF 传来的 dma-buf 映射到 ISP 侧：

```c
mem = g_ops->attach_dmabuf(dev->hw_dev->dev, dbufs->dbuf,
			   dbufs->dbuf->size, DMA_BIDIRECTIONAL);
ret = g_ops->map_dmabuf(mem);
dma = *((dma_addr_t *)g_ops->cookie(mem));
get_dma_buf(dbufs->dbuf);
```

然后记录到 ISP buffer：

```c
dbufs->is_init = true;
pool->buf.other = dbufs;
pool->buf.buff_addr[RKISP_PLANE_Y] = dma;
pool->buf.vaddr[RKISP_PLANE_Y] = vaddr;
```

`pool->buf.other = dbufs` 很关键。它表示这个 buffer 不是普通用户态 vb2 buffer，而是 CIF 传来的 `rkisp_rx_buf`。后面 ISP 处理完之后，会凭这个字段把 buffer 还给 CIF。

接着 ISP 根据曝光类型选择对应 RAWRD stream：

```c
switch (dbufs->type) {
case BUF_SHORT:
	stream = &dev->dmarx_dev.stream[RKISP_STREAM_RAWRD2];
	break;
case BUF_MIDDLE:
	stream = &dev->dmarx_dev.stream[RKISP_STREAM_RAWRD0];
	break;
case BUF_LONG:
default:
	stream = &dev->dmarx_dev.stream[RKISP_STREAM_RAWRD1];
}
```

映射关系是：

```text
BUF_SHORT  -> RKISP_STREAM_RAWRD2 -> rkisp_rawrd2_s
BUF_MIDDLE -> RKISP_STREAM_RAWRD0 -> rkisp_rawrd0_m
BUF_LONG   -> RKISP_STREAM_RAWRD1 -> rkisp_rawrd1_l
```

首帧时还会配置 RAWRD 的格式和硬件寄存器：

```c
if (dbufs->is_first) {
	stream->memory = 0;
	if (dbufs->is_uncompact)
		stream->memory = SW_CSI_RAW_WR_SIMG_MODE;
	rkisp_dmarx_set_fmt(stream, stream->out_fmt);
	stream->ops->config_mi(stream);
	dbufs->is_first = false;
}
```

这里的 `config_mi()` 实际就是 RAWRD 的 `rawrd_config_mi()`。

## 10. RAWRD config_mi：配置回读格式

`rawrd_config_mi()` 根据 RAW/YUV 格式配置 CSI2RX readback 的 data type、memory mode、pic size 和 raw length。

核心逻辑：

```c
val = rkisp_read(dev, CSI2RX_DATA_IDS_1, true);
val &= ~SW_CSI_ID0(0xff);

switch (stream->out_isp_fmt.fourcc) {
case V4L2_PIX_FMT_SRGGB8:
	...
	val |= CIF_CSI2_DT_RAW8;
	break;
case V4L2_PIX_FMT_SRGGB10:
	...
	val |= CIF_CSI2_DT_RAW10;
	break;
case V4L2_PIX_FMT_YUYV:
	...
	val |= CIF_CSI2_DT_YUV422_8b;
	break;
default:
	val |= CIF_CSI2_DT_RAW12;
}

rkisp_unite_write(dev, CSI2RX_RAW_RD_CTRL,
		  stream->memory << 2, false);
rkisp_unite_write(dev, CSI2RX_DATA_IDS_1, val, false);
rkisp_rawrd_set_pic_size(dev, stream->out_fmt.width,
			 stream->out_fmt.height);
mi_raw_length(stream);
```

这一步回答的是：

```text
ISP 应该按 RAW8/RAW10/RAW12/YUV422 哪种格式解释 DDR 中的数据？
读回来的图像宽高是多少？
RAW readback memory mode 是 compact 还是 word align？
```

## 11. ISP 每次接收 buffer：queue 到 RAWRD

第一次 init 之后，每帧进入：

```c
rkisp_rx_qbuf(dev, dbufs)
```

它再次根据 `dbufs->type` 找到对应 RAWRD stream，然后分两种：

```c
if (!IS_HDR_RDBK(dev->rd_mode))
	rkisp_rx_qbuf_online(stream, pool);
else
	rkisp_rx_qbuf_rdbk(stream, pool);
```

回读模式下走 `rkisp_rx_qbuf_rdbk()`：

```c
if (list_empty(&stream->buf_queue) && !stream->curr_buf) {
	stream->curr_buf = ispbuf;
	stream->ops->update_mi(stream);
} else {
	list_add_tail(&ispbuf->queue, &stream->buf_queue);
}

if (stream->id == RKISP_STREAM_RAWRD2)
	rkisp_rdbk_trigger_event(dev, T_CMD_QUEUE, &trigger);
```

这里有两个动作：

```text
1. 把当前 buffer 放到 RAWRD stream 的 curr_buf 或 buf_queue
2. 如果是 RAWRD2，投递一次 readback trigger
```

为什么是 RAWRD2 触发？因为在 Rockchip 的映射里，RAWRD2 通常对应 short/linear 帧，是一组回读帧的最后/关键触发点：

```text
FRAME1: RAWRD2
FRAME2: RAWRD0 + RAWRD2
FRAME3: RAWRD1 + RAWRD0 + RAWRD2
```

## 12. update_mi：把 DDR 地址写给 RAWRD

`stream->ops->update_mi(stream)` 对 RAWRD 来说就是：

```c
update_rawrd()
```

关键逻辑：

```c
if (stream->curr_buf) {
	val = stream->curr_buf->buff_addr[RKISP_PLANE_Y];
	rkisp_write(dev, stream->config->mi.y_base_ad_init, val, false);
	...
	stream->frame_end = false;
}
```

因为每个 stream 的 `config` 不同，所以这里实际写入的是：

```text
RAWRD0 -> MI_RAW0_RD_BASE
RAWRD1 -> MI_RAW1_RD_BASE
RAWRD2 -> MI_RAW2_RD_BASE
```

这就是“RAWRD 如何把 DDR RAW buffer 交给 ISP 硬件”的关键动作。

注意：RAWRD 并不拷贝图像数据。它只是把 DDR buffer 的 DMA 地址告诉硬件。

## 13. 触发 ISP 从 DDR 回读

当 `rkisp_rx_qbuf_rdbk()` 在 RAWRD2 上调用：

```c
rkisp_rdbk_trigger_event(dev, T_CMD_QUEUE, &trigger);
```

会进入：

```c
rkisp_rdbk_trigger_event()
rkisp_rdbk_trigger_handle()
rkisp_trigger_read_back()
```

`rkisp_rdbk_trigger_event()` 做队列操作：

```c
case T_CMD_QUEUE:
	if (!kfifo_is_full(fifo))
		kfifo_in(fifo, trigger, sizeof(*trigger));
	break;

if (cmd == T_CMD_QUEUE || cmd == T_CMD_END)
	rkisp_rdbk_trigger_handle(dev, cmd);
```

`rkisp_rdbk_trigger_handle()` 从 readback FIFO 里取出一个 trigger，更新当前帧信息：

```c
rkisp_rdbk_trigger_event(isp, T_CMD_DEQUEUE, &t);
isp->dmarx_dev.cur_frame.id = t.frame_id;
isp->dmarx_dev.cur_frame.sof_timestamp = t.sof_timestamp;
isp->dmarx_dev.cur_frame.timestamp = t.frame_timestamp;
atomic_set(&isp->isp_sdev.frm_sync_seq, t.frame_id + 1);
...
rkisp_trigger_read_back(isp, times, mode, is_try);
```

最终 `rkisp_trigger_read_back()` 配置 ISP 回读处理。

它会根据模式设置：

```text
HDR_RDBK_FRAME1
HDR_RDBK_FRAME2
HDR_RDBK_FRAME3
```

并配置 HDR merge / expander / params / CSI2RX readback 等逻辑。注释已经说明用途：

```c
/*
 * for hdr read back mode, rawrd read back data
 * this will update rawrd base addr to shadow.
 */
void rkisp_trigger_read_back(...)
```

可以把它理解为：

```text
RAWRD 已经写好 DDR 地址
        |
        v
rkisp_trigger_read_back() 让 ISP 进入 readback 处理
        |
        v
ISP 内部 CSI2RX/IBUF 按 readback mode 从 DDR 读 RAW
        |
        v
后续走 ISP pipeline / mainpath / selfpath / stats
```

## 14. ISP 处理完成后如何标记 RAWRD frame done

回读模式下，ISP 输出帧结束后进入：

```c
rkisp_check_idle()
```

它会根据 `dev->rd_mode` 组装 RAWRD frame done bit：

```c
switch (dev->rd_mode) {
case HDR_RDBK_FRAME3:
	val |= RAW1_RD_FRAME;
	/* FALLTHROUGH */
case HDR_RDBK_FRAME2:
	val |= RAW0_RD_FRAME;
	/* FALLTHROUGH */
default:
	val |= RAW2_RD_FRAME;
}
rkisp2_rawrd_isr(val, dev);
```

也就是：

```text
FRAME1: RAW2_RD_FRAME
FRAME2: RAW0_RD_FRAME + RAW2_RD_FRAME
FRAME3: RAW1_RD_FRAME + RAW0_RD_FRAME + RAW2_RD_FRAME
```

然后进入 `dmarx.c`：

```c
void rkisp2_rawrd_isr(u32 mis_val, struct rkisp_device *dev)
{
	for (i = RKISP_STREAM_RAWRD0; i < RKISP_MAX_DMARX_STREAM; i++) {
		stream = &dev->dmarx_dev.stream[i];
		if (!(mis_val & CIF_MI_FRAME(stream)))
			continue;
		stream->frame_end = true;
		dmarx_frame_end(stream);
	}
}
```

## 15. dmarx_frame_end：用户态 buffer 完成或归还 CIF buffer

`dmarx_frame_end()` 是 RAWRD buffer 完成后的统一收尾。

它先看当前 buffer 是否来自 CIF：

```c
if (stream->curr_buf) {
	if (stream->curr_buf->other) {
		struct rkisp_rx_buf *rx_buf = stream->curr_buf->other;
		rx_buf->runtime_us = dev->isp_sdev.dbg.interval / 1000;
		v4l2_subdev_call(sd, video, s_rx_buffer, rx_buf, NULL);
	} else {
		vb2_buffer_done(&stream->curr_buf->vb.vb2_buf,
				VB2_BUF_STATE_DONE);
	}
	stream->curr_buf = NULL;
}
```

这里分两种来源：

```text
stream->curr_buf->other != NULL:
	这是 CIF 自动回读传来的 rkisp_rx_buf
	处理完要调用 CIF 的 s_rx_buffer 归还

stream->curr_buf->other == NULL:
	这是用户态 QBUF 到 rawrd 的普通 vb2 buffer
	处理完调用 vb2_buffer_done() 返回用户态
```

这也解释了为什么 RAWRD 同时能服务两种场景：

```text
用户态/AIQ 手动回读
CIF 驱动自动回读
```

处理完当前 buffer 后，如果 RAWRD 队列里还有下一帧：

```c
if (!list_empty(&stream->buf_queue)) {
	stream->curr_buf = list_first_entry(...);
	list_del(&stream->curr_buf->queue);
}

if (stream->curr_buf)
	stream->ops->update_mi(stream);
```

于是继续把下一帧 DDR 地址写入 `MI_RAWx_RD_BASE`。

## 16. ISP 如何把 buffer 还给 CIF

当 `dmarx_frame_end()` 调用：

```c
v4l2_subdev_call(sd, video, s_rx_buffer, rx_buf, NULL);
```

这里的 `sd` 是 CIF 侧 subdev。CIF 接收入口在 `subdev-itf.c`：

```c
static int sditf_s_rx_buffer(struct v4l2_subdev *sd,
			     void *buf, unsigned int *size)
```

它根据 `dbufs->type` 找回对应 CIF stream：

```c
NO_HDR:
	BUF_SHORT  -> stream[0]

HDR_X2:
	BUF_SHORT  -> stream[1]
	BUF_MIDDLE -> stream[0]

HDR_X3:
	BUF_SHORT  -> stream[2]
	BUF_MIDDLE -> stream[1]
	BUF_LONG   -> stream[0]
```

然后把 `rkisp_rx_buf` 转回 CIF 自己的 `rkcif_rx_buffer`：

```c
rx_buf = to_cif_rx_buf(dbufs);
```

`to_cif_rx_buf()` 的定义在 `capture.c`：

```c
struct rkcif_rx_buffer *to_cif_rx_buf(struct rkisp_rx_buf *dbufs)
{
	return container_of(dbufs, struct rkcif_rx_buffer, dbufs);
}
```

最后把 buffer 放回 CIF 空闲队列：

```c
list_add_tail(&rx_buf->list, &stream->rx_buf_head);
rkcif_assign_check_buffer_update_toisp(stream);
```

至此，自动回读闭环完成：

```text
CIF 空闲 buffer
        |
        v
CIF DMA 写 RAW
        |
        v
CIF s_rx_buffer 给 ISP
        |
        v
ISP RAWRD 从 DDR 回读
        |
        v
ISP 处理完
        |
        v
ISP s_rx_buffer 还给 CIF
        |
        v
CIF 空闲 buffer
```

## 17. 手动/AIQ 回读路径和自动回读路径的区别

### 17.1 手动/AIQ 回读

```text
CIF capture video node 输出 RAW
        |
        v
用户态/AIQ 拿到 RAW buffer
        |
        v
用户态 QBUF 到 rkisp_rawrd0/1/2
        |
        v
RAWRD update_rawrd()
        |
        v
ISP readback
        |
        v
vb2_buffer_done() 返回给用户态
```

这个路径中 RAWRD 的 buffer 来源是 vb2 output queue。`stream->curr_buf->other == NULL`。

### 17.2 驱动自动回读

```text
CIF 内部分配 rkcif_rx_buffer
        |
        v
CIF DMA 写 DDR
        |
        v
CIF 调 ISP s_rx_buffer
        |
        v
ISP 映射成 rkisp_rx_buf_pool
        |
        v
RAWRD update_rawrd()
        |
        v
ISP readback
        |
        v
ISP 调 CIF s_rx_buffer 归还 buffer
```

这个路径中 RAWRD 的 buffer 来源是 CIF 内部 `rkisp_rx_buf`。`stream->curr_buf->other != NULL`。

## 18. 在线直通模式下 RAWRD 参与吗

一般不参与。

在线模式是：

```text
Sensor/MIPI/CIF -> ISP
```

数据以实时 pixel stream 进入 ISP，CIF 不需要把每帧先写到 DDR 后再交给 RAWRD。

CIF 在线送 ISP 时，`subdev-itf.c` 选择：

```c
RKISP_VICAP_ONLINE
RKCIF_STREAM_MODE_TOISP
```

因此不是：

```text
CIF -> DDR -> RAWRD -> ISP
```

而是：

```text
CIF -> ISP
```

如果是 CSI2 直接进 ISP，则链路更短：

```text
Sensor -> MIPI DPHY/CSI2 -> rkisp-csi-subdev -> rkisp-isp-subdev
```

这时 `isp/csi.c` 配置 ISP 内部 CSI2RX，RAWRD 同样不参与。

## 19. 一张完整流程图

### 19.1 驱动自动回读

```text
ISP 配置 CIF 模式
  rkisp/csi.c or rkisp_subdev_link_setup()
  -> RKISP_VICAP_CMD_MODE
  -> RKISP_VICAP_RDBK_AUTO

CIF 初始化 raw buffer
  subdev-itf.c:sditf_init_buf()
  -> capture.c:rkcif_init_rx_buf()
  -> rkcif_alloc_buffer()
  -> rx_buf_head

CIF 启动回读采集
  subdev-itf.c:sditf_start_stream()
  -> RKCIF_STREAM_MODE_TOISP_RDBK
  -> rkcif_do_start_stream()

CIF DMA 写 DDR
  capture.c:rkcif_assign_new_buffer_update_toisp()
  -> 配置 CIF frame address
  -> CIF 硬件写 RAW 到 DDR

CIF 帧结束交给 ISP
  capture.c:rkcif_s_rx_buffer()
  -> v4l2_subdev_call(isp, video, s_rx_buffer, dbufs)

ISP 接收 buffer
  rkisp.c:rkisp_sd_s_rx_buffer()
  -> rkisp_rx_buf_pool_init()
  -> rkisp_rx_qbuf()

ISP 映射到 RAWRD
  BUF_SHORT  -> RAWRD2
  BUF_MIDDLE -> RAWRD0
  BUF_LONG   -> RAWRD1

RAWRD 写 DDR 地址
  dmarx.c:update_rawrd()
  -> MI_RAWx_RD_BASE = dma addr

触发 ISP 回读
  rkisp.c:rkisp_rdbk_trigger_event()
  -> rkisp_rdbk_trigger_handle()
  -> rkisp_trigger_read_back()

ISP 完成处理
  rkisp.c:rkisp_check_idle()
  -> dmarx.c:rkisp2_rawrd_isr()
  -> dmarx_frame_end()

归还 CIF buffer
  dmarx_frame_end()
  -> v4l2_subdev_call(cif, video, s_rx_buffer, rx_buf)
  -> subdev-itf.c:sditf_s_rx_buffer()
  -> rx_buf_head
```

### 19.2 用户态/AIQ 手动回读

```text
CIF capture RAW 到用户态 buffer
        |
        v
用户态/AIQ 选择 rawrd0/1/2
        |
        v
VIDIOC_QBUF 到 rkisp_rawrdX
        |
        v
dmarx.c:rkisp_buf_queue()
        |
        v
stream->curr_buf / stream->buf_queue
        |
        v
update_rawrd()
        |
        v
rkisp_trigger_read_back()
        |
        v
ISP 从 DDR 读 RAW
        |
        v
dmarx_frame_end()
        |
        v
vb2_buffer_done()
```

## 20. 最短总结

```text
在线模式:
	实时像素流直接进入 ISP
	不走 RAWRD
	不需要 DDR RAW readback

手动/AIQ 回读:
	用户态把 DDR RAW buffer QBUF 到 rkisp_rawrd0/1/2
	ISP 从 DDR 读 RAW
	完成后 buffer 返回用户态

驱动自动回读:
	CIF 内部分配 buffer 并 DMA 写 RAW 到 DDR
	CIF 通过 s_rx_buffer 把 rkisp_rx_buf 交给 ISP
	ISP 映射到 RAWRD0/1/2 并触发 readback
	完成后 ISP 通过 s_rx_buffer 把 buffer 还给 CIF

RAWRD:
	不是 capture 输出口
	是 V4L2 output 设备
	是 DDR RAW 输入 ISP 的标准接口
```
