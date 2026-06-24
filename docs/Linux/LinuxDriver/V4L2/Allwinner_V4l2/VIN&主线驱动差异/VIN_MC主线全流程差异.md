# A733 全志 VIN 与标准 V4L2/Media Controller 兼容性分析

```text
主线 camera 模型不是 video node 私有拉起整条链路，
而是由 DT endpoint 描述物理连接，
由 sensor 和 VIN/CSI/ISP/scaler 驱动分别注册标准 subdev/entity/pad，
由 bridge 驱动根据 endpoint 和 async notifier 创建 media links。

用户态，例如 libcamera，通过 MC 枚举和选择可用 pipeline，
通过 subdev pad ops 和 controls 配置 sensor、CSI、ISP、scaler 等各级状态，
通过 video node 配置最终 capture format 和 buffer queue。

最终启动时，用户态对 capture video node 调 VIDIOC_STREAMON；
内核中的 VIN/bridge 驱动负责 link validation、media_pipeline_start，
并按已启用拓扑逐级调用各 subdev 的 stream on，最后启动 DMA。


全志 VIN 并不是没有 Media Controller，
而是没有把 Media Controller 作为用户态的主控制面。

media link、pipeline 选择、subdev 格式传播、stream 顺序
主要由 VIN 驱动内部根据 DTS 私有 vinc*_sel 配置和 pipe.sd[] 数组维护。

用户态主要操作 /dev/videoX。
当用户调用 S_INPUT / S_FMT / STREAMON / STREAMOFF 时，
VIN 在这些 V4L2 ioctl 内部代替用户完成 link setup、subdev set_fmt、
selection、sensor init、ISP/scaler init、set_stream 等动作。

因此效果上看，就是把原本主线 MC-centric 模型中
由用户态 media-ctl / v4l-subdevX 完成的控制，
收敛进了 /dev/videoX 的 V4L2 ioctl 流程里。

```

结论先行：当前全志 VIN 不是“完全不能用标准 V4L2”，而是“能按 `/dev/videoX` 的基本采集路径用，但不能按主线 Media Controller-centric 模型完整控制”。它创建了 media graph 和 subdev 节点，但真实控制面主要仍在 video node 内部。

```text
全志 VIN 的真实使用模型：

/dev/videoX
  -> VIDIOC_S_INPUT 拉起 pipeline
  -> VIDIOC_S_FMT 向 sensor/MIPI/CSI/ISP/scaler 下发格式
  -> VIDIOC_STREAMON 按驱动内部顺序启动整条链路
  -> vb2 buffer 采集
```

而主线 MC/libcamera 更期待的是：

```text
/dev/mediaX
  -> 枚举 entity/pad/link
  -> MEDIA_IOC_SETUP_LINK 配置有效 pipeline

/dev/v4l-subdevX
  -> VIDIOC_SUBDEV_S_FMT 配每一级 pad format
  -> VIDIOC_SUBDEV_S_SELECTION 配 crop/compose
  -> controls/events 配 sensor/ISP 行为

/dev/videoX
  -> 只负责最终 capture format 和 buffer queue
```

## 1. 为什么不能被 libcamera 等库按标准 V4L2/MC 控制

### 1.1 不是没有 MC，而是 MC 不是主控制面

`vin.c` 默认把用户态 API 模式设为 video node only：

```c
/* bsp/drivers/vin/vin.c:1768-1804 */
static ssize_t vin_md_sysfs_show(struct device *dev,
				 struct device_attribute *attr, char *buf)
{
	struct platform_device *pdev = to_platform_device(dev);
	struct vin_md *vind = platform_get_drvdata(pdev);

	if (vind->user_subdev_api)
		return strlcpy(buf, "Sub-device API (sub-dev)\n", PAGE_SIZE);

	return strlcpy(buf, "V4L2 video node only API (vid-dev)\n", PAGE_SIZE);
}

static ssize_t vin_md_sysfs_store(struct device *dev,
				  struct device_attribute *attr,
				  const char *buf, size_t count)
{
	...
	if (!strcmp(buf, "vid-dev\n"))
		subdev_api = false;
	else if (!strcmp(buf, "sub-dev\n"))
		subdev_api = true;
	...
	vind->user_subdev_api = subdev_api;
	for (i = 0; i < VIN_MAX_DEV; i++)
		if (vind->vinc[i])
			vind->vinc[i]->vid_cap.user_subdev_api = subdev_api;
	return count;
}

/* bsp/drivers/vin/vin.c:2540 */
vind->user_subdev_api = 0;
```

这个开关只能改变 API 暴露模式的标志，不能把硬件路由、format propagation、stream 顺序、私有 ioctl 都改成主线 MC 语义。

### 1.2 link 是驱动和 DTS 固化出来的，不是用户态动态决定的

A733 `pro2/linux-6.6/board.dts` 里每个 `vinc` 直接绑定 CSI/MIPI/ISP/TDM/sensor：

```dts
/* device/config/chips/a733/configs/pro2/linux-6.6/board.dts:2217-2229 */
vinc00:vinc@5830000 {
	vinc0_csi_sel = <1>;
	vinc0_mipi_sel = <1>;
	vinc0_isp_sel = <0>;
	vinc0_isp_tx_ch = <0>;
	vinc0_tdm_rx_sel = <0>;
	vinc0_rear_sensor_sel = <0>;
	vinc0_front_sensor_sel = <0>;
	vinc0_sensor_list = <0>;
	device_id = <0>;
	work_mode = <0x1>;
	status = "okay";
};
```

驱动创建 media links 时也直接使用 `vinc->mipi_sel`、`vinc->csi_sel`、`vinc->isp_sel`、`vinc->vipp_sel`：

```c
/* bsp/drivers/vin/vin.c:2042-2088 */
static int vin_create_media_links(struct vin_md *vind)
{
	struct v4l2_subdev *mipi, *csi, *isp, *scaler, *cap_sd;
	...
	for (i = 0; i < VIN_MAX_DEV; i++) {
		vinc = vind->vinc[i];
		if (vinc == NULL)
			continue;

		if (vinc->mipi_sel == 0xff)
			mipi = NULL;
		else
			mipi = vind->mipi[vinc->mipi_sel].sd;

		if (vinc->csi_sel == 0xff)
			csi = NULL;
		else
			csi = vind->csi[vinc->csi_sel].sd;

		if (mipi != NULL) {
			module = &vind->modules[vinc->rear_sensor];
			sensor_link_to_mipi_csi(module, mipi);
			...
			ret = media_create_pad_link(source, MIPI_PAD_SOURCE,
						       sink, CSI_PAD_SINK,
						       MEDIA_LNK_FL_ENABLED);
		}
		...
	}
}
```

默认 link 也由驱动主动 enable：

```c
/* bsp/drivers/vin/vin.c:2226-2268 */
static int vin_setup_default_links(struct vin_md *vind)
{
	...
	if (isp && scaler)
		link = media_entity_find_link(&isp->entity.pads[ISP_PAD_SOURCE],
					      &scaler->entity.pads[SCALER_PAD_SINK]);

	if (link) {
		ret = media_entity_setup_link(link, MEDIA_LNK_FL_ENABLED);
		if (ret)
			vin_err("media_entity_setup_link error\n");
	}

	p = &vinc->vid_cap.pipe;
	vin_md_prepare_pipeline(p, &vinc->vid_cap.vdev.entity);
}
```

主线 `MEDIA_IOC_SETUP_LINK` 的语义是用户态修改 link 的 `ENABLED` flag。内核文档说应用填 `media_link_desc`，调用 `MEDIA_IOC_SETUP_LINK` 来改变 link 属性，唯一可配置属性是 `ENABLED`。但在全志 VIN 里，用户态改 link flag 不会同步改 `vinc->*_sel` 和硬件 mux。

### 1.3 `link_notify()` 只打日志，`link_setup()` 是空实现

```c
/* bsp/drivers/vin/vin.c:1754-1766 */
static int vin_md_link_notify(struct media_link *link, u32 flags,
				unsigned int notification)
{
	if (notification == MEDIA_DEV_NOTIFY_POST_LINK_CH)
		vin_log(VIN_LOG_MD, "%s: source %s, sink %s, flag %d\n", __func__,
			link->source->entity->name,
			link->sink->entity->name, flags);
	return 0;
}

const struct media_device_ops media_device_ops = {
		.link_notify = vin_md_link_notify,
};
```

```c
/* bsp/drivers/vin/vin-video/vin_video.c:5793-5802 */
static int vin_link_setup(struct media_entity *entity,
			  const struct media_pad *local,
			  const struct media_pad *remote, u32 flags)
{
	return 0;
}

static const struct media_entity_operations vin_sd_media_ops = {
	.link_setup = vin_link_setup,
};
```

这说明 `media-ctl -l` 即使能改 media graph 的 link flag，也很难真正改变 VIN 内部的硬件路由和 pipeline state。

### 1.4 内部 pipeline 靠 `grp_id` 反向遍历组装

VIN 内部并不把用户态配置后的 graph 当成唯一真相，而是从 video entity 反向遍历，按 `sd->grp_id` 填充固定数组 `p->sd[]`：

```c
/* bsp/drivers/vin/vin.c:83-132 */
static void vin_md_prepare_pipeline(struct vin_pipeline *p,
				  struct media_entity *me)
{
	struct v4l2_subdev *sd;
	int i;

	for (i = 0; i < VIN_IND_ACTUATOR; i++)
		p->sd[i] = NULL;

	while (1) {
		struct media_pad *pad = NULL;

		for (i = 0; i < me->num_pads; i++) {
			struct media_pad *spad = &me->pads[i];

			if (!(spad->flags & MEDIA_PAD_FL_SINK))
				continue;
			pad = media_pad_remote_pad_first(spad);
			if (pad)
				break;
		}

		if (pad == NULL)
			break;

		sd = media_entity_to_v4l2_subdev(pad->entity);

		switch (sd->grp_id) {
		case VIN_GRP_ID_SENSOR:
			p->sd[VIN_IND_SENSOR] = sd;
			break;
		case VIN_GRP_ID_MIPI:
			p->sd[VIN_IND_MIPI] = sd;
			break;
		case VIN_GRP_ID_CSI:
			p->sd[VIN_IND_CSI] = sd;
			break;
		case VIN_GRP_ID_TDM_RX:
			p->sd[VIN_IND_TDM_RX] = sd;
			break;
		case VIN_GRP_ID_ISP:
			p->sd[VIN_IND_ISP] = sd;
			break;
		...
		}
	}
}
```

后续 open、format、stream、control 都围绕这个固定数组操作。

### 1.5 `VIDIOC_S_INPUT` 实际是 pipeline 初始化入口

`VIDIOC_S_INPUT` 表面是标准 V4L2 输入选择，但这里会建立 link、open pipeline、初始化 ISP/scaler/sensor：

```c
/* bsp/drivers/vin/vin-video/vin_video.c:2355-2473 */
static int __vin_s_input(struct vin_core *vinc, unsigned int i)
{
	...
	if (i == 0)
		vinc->sensor_sel = vinc->rear_sensor;
	else
		vinc->sensor_sel = vinc->front_sensor;

	module = &vind->modules[vinc->sensor_sel];
	valid_idx = module->sensors.valid_idx;

	if (__vin_sensor_setup_link(vinc, module, valid_idx, 1) < 0)
		return -EINVAL;

	if (__csi_isp_setup_link(vinc, 1) < 0)
		return -EINVAL;

	inst = &module->sensors.inst[valid_idx];

	sunxi_isp_sensor_type(cap->pipe.sd[VIN_IND_ISP], inst->is_isp_used);
	vinc->support_raw = inst->is_isp_used;

	mutex_lock(&cap->vdev.entity.graph_obj.mdev->graph_mutex);
	ret = vin_pipeline_call(vinc, open, &cap->pipe, &cap->vdev.entity, true);
	...
	mutex_unlock(&cap->vdev.entity.graph_obj.mdev->graph_mutex);

	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_ISP], core, init, 1);
	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SCALER], core, init, 1);
	...
	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SENSOR], core, init, 1);
	clear_bit(VIN_LPM, &cap->state);

	vinc->hflip = inst->hflip;
	vinc->vflip = inst->vflip;

	return ret;
}
```

这和主线 MC-centric 模型冲突：主线期望用户态先配置好 graph/subdev，`S_INPUT` 不应承担整条 pipeline 初始化的职责。

### 1.6 `TRY_FMT` 会走 ACTIVE 路径，破坏主线 TRY 语义

主线文档对 subdev TRY format 的要求是：TRY 不应用到设备，只存在当前 subdev file handle 的 try state。全志 video node 的 `TRY_FMT` 却调用 `vin_pipeline_try_format(..., true)`：

```c
/* bsp/drivers/vin/vin-video/vin_video.c:1032-1055 */
static int vidioc_try_fmt_vid_cap_mplane(struct file *file, void *priv,
					 struct v4l2_format *f)
{
	...
	mf.width = f->fmt.pix_mp.width;
	mf.height = f->fmt.pix_mp.height;
	mf.code = ffmt->mbus_code;
	vin_pipeline_try_format(vinc, &mf, &ffmt, true);
	...
	return 0;
}
```

`true` 会导致内部使用 `V4L2_SUBDEV_FORMAT_ACTIVE`：

```c
/* bsp/drivers/vin/vin-video/vin_video.c:823-826 */
memset(&sfmt, 0, sizeof(sfmt));
sfmt.format = *tfmt;
sfmt.which = set ? V4L2_SUBDEV_FORMAT_ACTIVE : V4L2_SUBDEV_FORMAT_TRY;
```

因此，libcamera 或其他用户态若把 `TRY_FMT` 当作无副作用探测，会碰到语义偏差。

### 1.7 `S_FMT` 是全链路格式下发器

```c
/* bsp/drivers/vin/vin-video/vin_video.c:1059-1114 */
static int __vin_set_fmt(struct vin_core *vinc, struct v4l2_format *f)
{
	...
	ffmt = vin_find_format(&f->fmt.pix_mp.pixelformat, NULL,
					VIN_FMT_ALL, -1, false);
	...
	mf.width = f->fmt.pix_mp.width;
	mf.height = f->fmt.pix_mp.height;
	mf.field = f->fmt.pix_mp.field;
	mf.colorspace = f->fmt.pix_mp.colorspace;
	mf.code = ffmt->mbus_code;
	res->res_pix_fmt = f->fmt.pix_mp.pixelformat;

	ret = vin_pipeline_try_format(vinc, &mf, &ffmt, true);
	if (ret < 0)
		return -EINVAL;

	vin_pipeline_set_mbus_config(vinc);

	memset(&win_cfg, 0, sizeof(win_cfg));
	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SENSOR], core, ioctl,
			     GET_CURRENT_WIN_CFG, &win_cfg);
	...
}
```

`vin_pipeline_try_format()` 遍历 graph，并对每个属于当前 `pipe.sd[]` 的 subdev 调 `set_fmt`：

```c
/* bsp/drivers/vin/vin-video/vin_video.c:851-917 */
media_graph_walk_start(&graph, me);
while ((me = media_graph_walk_next(&graph)) &&
	me != &vinc->vid_cap.subdev.entity) {

	sd = media_entity_to_v4l2_subdev(me);
	...
	if (sd != vinc->vid_cap.pipe.sd[sd_ind])
		continue;

	sfmt.pad = 0;
	ret = v4l2_subdev_call(sd, pad, set_fmt, NULL, &sfmt);
	if (ret)
		return ret;
	...
}
```

这意味着用户态提前用 `media-ctl -V` 对 subdev 配好的格式，会被下一次 `/dev/videoX` 的 `S_FMT` 重新覆盖。

### 1.8 `STREAMON/STREAMOFF` 也在操作整条链路

`STREAMON` 如果处于 low-power，会重新 enable links，然后按内部 pipeline 顺序启动：

```c
/* bsp/drivers/vin/vin-video/vin_video.c:2140-2213 */
static int vidioc_streamon(struct file *file, void *priv, enum v4l2_buf_type i)
{
	...
	ret = vb2_ioctl_streamon(file, priv, i);
	if (ret)
		goto streamon_error;

	if (vin_lpm(cap)) {
		if (__vin_sensor_setup_link(vinc, module, valid_idx, 1) < 0)
			return -EINVAL;
		if (__csi_isp_setup_link(vinc, 1) < 0)
			return -EINVAL;
		clear_bit(VIN_LPM, &cap->state);
	}

	mutex_lock(&cap->vdev.entity.graph_obj.mdev->graph_mutex);
	ret = vin_pipeline_call(cap->vinc, set_stream, &cap->pipe, cap->vinc->stream_idx);
	set_bit(VIN_STREAM, &cap->state);
	mutex_unlock(&cap->vdev.entity.graph_obj.mdev->graph_mutex);
	...
}
```

`STREAMOFF` 不只是停 DMA，还会拆 link 并进入 LPM：

```c
/* bsp/drivers/vin/vin-video/vin_video.c:2251-2306 */
static int vidioc_streamoff(struct file *file, void *priv, enum v4l2_buf_type i)
{
	...
	mutex_lock(&cap->vdev.entity.graph_obj.mdev->graph_mutex);
	clear_bit(VIN_STREAM, &cap->state);
	vin_pipeline_call(vinc, set_stream, &cap->pipe, 0);
	...
	set_bit(VIN_LPM, &cap->state);
	__csi_isp_setup_link(vinc, 0);
	__vin_sensor_setup_link(vinc, module, valid_idx, 0);
	mutex_unlock(&cap->vdev.entity.graph_obj.mdev->graph_mutex);

	ret = vb2_ioctl_streamoff(file, priv, i);
	vin_queue_free(file);
	...
}
```

主线通常要求 streaming 时保护 link，不随意重写用户态配置好的 graph；停流也不等价于销毁用户态配置的 link 拓扑。

### 1.9 subdev pad ops 不完整，无法支撑通用 MC/libcamera 推导

MIPI 只有格式和 mbus config：

```c
/* bsp/drivers/vin/vin-mipi/sunxi_mipi.c:1406-1414 */
static const struct v4l2_subdev_pad_ops sunxi_mipi_subdev_pad_ops = {
	.get_fmt = sunxi_mipi_subdev_get_fmt,
	.set_fmt = sunxi_mipi_subdev_set_fmt,
#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 1, 0)
	.get_mbus_config = sunxi_mipi_g_mbus_config,
#elif LINUX_VERSION_CODE >= KERNEL_VERSION(5, 10, 0)
	.set_mbus_config = sunxi_mipi_s_mbus_config,
#endif
};
```

CSI 有 `set_selection`，但没有完整 selection get/routing/frame-size 枚举：

```c
/* bsp/drivers/vin/vin-csi/sunxi_csi.c:1001-1010 */
static const struct v4l2_subdev_pad_ops sunxi_csi_subdev_pad_ops = {
	.set_selection = sunxi_csi_subdev_set_selection,
	.get_fmt = sunxi_csi_subdev_get_fmt,
	.set_fmt = sunxi_csi_subdev_set_fmt,
#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 1, 0)
	.get_mbus_config = sunxi_csi_g_mbus_config,
#else
	.set_mbus_config = sunxi_csi_s_mbus_config,
#endif
};
```

ISP 也主要只有 `get_fmt/set_fmt`：

```c
/* bsp/drivers/vin/vin-isp/sunxi_isp.c:1994-2006 */
static const struct v4l2_subdev_video_ops sunxi_isp_subdev_video_ops = {
	.s_stream = sunxi_isp_subdev_s_stream,
};

static const struct v4l2_subdev_pad_ops sunxi_isp_subdev_pad_ops = {
	.get_fmt = sunxi_isp_subdev_get_fmt,
	.set_fmt = sunxi_isp_subdev_set_fmt,
};
```

Scaler 有 selection，但 `set_selection()` 只接受 `CROP`：

```c
/* bsp/drivers/vin/vin-vipp/sunxi_scaler.c:274-287 */
static int sunxi_scaler_subdev_set_selection(struct v4l2_subdev *sd,
					     struct v4l2_subdev_state *state,
					     struct v4l2_subdev_selection *sel)
{
	struct scaler_dev *scaler = v4l2_get_subdevdata(sd);
	...
	if (scaler->noneed_register)
		return 0;
	if (sel->target != V4L2_SEL_TGT_CROP || sel->pad != SCALER_PAD_SINK)
		return -EINVAL;
	...
}
```

当前 6.6 分支的 `get_selection()` 比旧版宽一些，接受 `COMPOSE/CROP_DEFAULT/CROP_BOUNDS/CROP`，但它仍然是固定转发到 scaler sink pad 的局部实现，不是完整 camera pipeline 的 selection/compose 建模：

```c
/* bsp/drivers/vin/vin-vipp/sunxi_scaler.c:248-269 */
if (sel->pad != SCALER_PAD_SINK)
	return -EINVAL;

switch (sel->target) {
case V4L2_SEL_TGT_COMPOSE:
case V4L2_SEL_TGT_CROP_DEFAULT:
case V4L2_SEL_TGT_CROP_BOUNDS:
	sel->r.left = 0;
	sel->r.top = 0;
	sel->r.width = INT_MAX;
	sel->r.height = INT_MAX;
	__scaler_try_crop(format_sink, format_source, &sel->r);
	break;
case V4L2_SEL_TGT_CROP:
	sel->r = scaler->crop.request;
	break;
default:
	return -EINVAL;
}
```

## 2. 不走 MC 时，cheese/OpenCV/C 直接 V4L2 是否能采集

### 2.1 C 程序直接调用 V4L2 API：可以，且最可控

video node 挂出的 ioctl 覆盖了基本采集路径：

```c
/* bsp/drivers/vin/vin-video/vin_video.c:4370-4407 */
static const struct v4l2_ioctl_ops vin_ioctl_ops = {
	.vidioc_querycap = vidioc_querycap,
	.vidioc_enum_fmt_vid_cap = vidioc_enum_fmt_vid_cap_mplane,
	.vidioc_enum_framesizes = vidioc_enum_framesizes,
	.vidioc_enum_frameintervals = vidioc_enum_frameintervals,
	.vidioc_g_fmt_vid_cap_mplane = vidioc_g_fmt_vid_cap_mplane,
	.vidioc_try_fmt_vid_cap_mplane = vidioc_try_fmt_vid_cap_mplane,
	.vidioc_s_fmt_vid_cap_mplane = vidioc_s_fmt_vid_cap_mplane,
	...
	.vidioc_reqbufs = vb2_ioctl_reqbufs,
	.vidioc_querybuf = vb2_ioctl_querybuf,
	.vidioc_qbuf = vb2_ioctl_qbuf,
	.vidioc_dqbuf = vb2_ioctl_dqbuf,
	.vidioc_expbuf = vb2_ioctl_expbuf,
	.vidioc_enum_input = vidioc_enum_input,
	.vidioc_g_input = vidioc_g_input,
	.vidioc_s_input = vidioc_s_input,
	.vidioc_streamon = vidioc_streamon,
	.vidioc_streamoff = vidioc_streamoff,
	.vidioc_g_parm = vidioc_g_parm,
	.vidioc_s_parm = vidioc_s_parm,
	.vidioc_g_selection = vidioc_g_selection,
	.vidioc_s_selection = vidioc_s_selection,
	.vidioc_default = vin_param_handler,
	...
};
```

buffer queue 明确是 multiplanar capture，并支持 MMAP/USERPTR/DMABUF/READ：

```c
/* bsp/drivers/vin/vin-video/vin_video.c:5755-5763 */
q = &cap->vb_vidq;
q->type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
q->io_modes = VB2_MMAP | VB2_USERPTR | VB2_DMABUF | VB2_READ;
q->drv_priv = cap;
q->buf_struct_size = sizeof(*vin_buffer_size);
q->ops = &vin_video_qops;
q->mem_ops = &vb2_dma_contig_memops;
q->timestamp_flags = V4L2_BUF_FLAG_TIMESTAMP_MONOTONIC;
```

最稳流程：

```text
open("/dev/videoX")
VIDIOC_S_INPUT
VIDIOC_S_PARM
VIDIOC_S_FMT
VIDIOC_REQBUFS
VIDIOC_QUERYBUF + mmap() 或 USERPTR
VIDIOC_QBUF
VIDIOC_STREAMON
VIDIOC_DQBUF
VIDIOC_STREAMOFF
close()
```

注意点：

- 必须使用 `V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE`。
- 建议先 `S_INPUT`，因为它实际拉起 pipeline。
- 不要假设 `TRY_FMT` 无副作用。
- 不要依赖 MC/subdev 配置状态能在 `S_FMT` 后保持。
- `STREAMOFF` 会拆 link，再次采集建议重新走 `S_INPUT/S_FMT/REQBUFS`。

### 2.2 OpenCV：能否工作取决于 backend 和格式

OpenCV 如果直接用 V4L2 backend，常见风险是：

- backend 按单平面 `VIDEO_CAPTURE` 习惯写，而 VIN 是 `VIDEO_CAPTURE_MPLANE`。
- backend 不一定先调用 `VIDIOC_S_INPUT`。
- backend 可能大量使用 `TRY_FMT/ENUM_FMT/selection` 做探测，而 VIN 的语义有平台偏差。
- OpenCV 期望 BGR/YUYV 等易处理格式，而 VIN 可能更常用 NV12/NV21/YUV420/LBC/FBC 等。

更稳的方式是用 GStreamer 明确指定 `v4l2src device=/dev/videoX`、caps、分辨率和格式，再交给 OpenCV。

### 2.3 cheese：可能能用，但不是最佳验证工具

cheese 通常经由 GStreamer/v4l2src。如果 GStreamer 插件能正确处理 VIN 的 multi-plane 格式和初始化顺序，它可能工作。但 cheese 的自动探测若没有满足 `S_INPUT -> S_FMT -> REQBUFS -> STREAMON` 这条 VIN 友好路径，就可能黑屏或失败。

建议验证顺序：

```text
1. 全志官方 demo 或最小 C 程序
2. v4l2-ctl 指定 input/format/stream
3. GStreamer v4l2src
4. OpenCV/cheese
```

## 3. 对比主线需求：VIN 省略或修改了什么

| 维度 | 主线 MC-centric 期望 | 当前全志 VIN 行为 | 影响 |
| --- | --- | --- | --- |
| 拓扑来源 | DT endpoint graph + async notifier + media graph | DTS `vinc*_sel` 私有绑定 | 用户态 link 选择不能真正改硬件路由 |
| link 配置 | `MEDIA_IOC_SETUP_LINK` 控制可变 link | `link_notify` 只 log，`link_setup` 空实现 | `media-ctl -l` 不可靠 |
| 格式配置 | 用户态逐级 `VIDIOC_SUBDEV_S_FMT` | `/dev/videoX S_FMT` 内部遍历并下发 | 用户态 subdev 设置会被覆盖 |
| TRY 语义 | TRY 不改变 active state | video `TRY_FMT` 走 ACTIVE | libcamera 探测语义被破坏 |
| selection | crop/compose/bounds/native size 语义完整 | video node 固定转 scaler sink，set 只收 CROP | 通用 crop/compose 控制不完整 |
| stream | `media_pipeline_start/stop` + link_validate | 内部固定 `vin_pipeline_call(set_stream)` 顺序 | 难以由用户态自定义 pipeline |
| controls | sensor/ISP/video 分层清晰 | video node 代理 ISP/sensor/flash/actuator | libcamera 难以按 entity 建模 |
| 私有能力 | 尽量标准化 controls/events/meta | 大量 `VIDIOC_*` 私有 ioctl | 标准 MC API 无法表达 |

### 3.1 gc2053 sensor 是 register-list 模型，不是完整自由配置模型

gc2053 的窗口是离散寄存器表：

```c
/* bsp/drivers/vin/modules/sensor/gc2053_mipi.c:1327-1422 */
static struct sensor_win_size sensor_win_sizes[] = {
	{
		.width      = 1920,
		.height     = 1080,
		.hts        = 3300,
		.vts        = 1125,
		.pclk       = 74250000,
		.mipi_bps   = 297 * 1000 * 1000,
		.fps_fixed  = 20,
		.regs       = sensor_1080p20_regs,
		.regs_size  = ARRAY_SIZE(sensor_1080p20_regs),
	},
	{
		.width      = 1928,
		.height     = 1088,
		.hts        = 2200,
		.vts        = 1125,
		.pclk       = 74250000,
		.mipi_bps   = 297 * 1000 * 1000,
		.fps_fixed  = 30,
		.regs       = sensor_1080p30_regs,
		.regs_size  = ARRAY_SIZE(sensor_1080p30_regs),
		.vipp_w     = 1920,
		.vipp_h     = 1080,
		.vipp_hoff  = 4,
		.vipp_voff  = 4,
	},
	...
};
```

主线文档承认很多 sensor 是 register-list based，但它仍要求把可枚举能力、pad format、timing controls 等清楚暴露给用户态。gc2053 当前只暴露了一部分：

```c
/* bsp/drivers/vin/modules/sensor/gc2053_mipi.c:1545-1572 */
static const struct v4l2_subdev_core_ops sensor_core_ops = {
	.reset = sensor_reset,
	.init = sensor_init,
	.s_power = sensor_power,
	.ioctl = sensor_ioctl,
};

static const struct v4l2_subdev_video_ops sensor_video_ops = {
	.s_stream = sensor_s_stream,
};

static const struct v4l2_subdev_pad_ops sensor_pad_ops = {
	.enum_mbus_code = sensor_enum_mbus_code,
	.enum_frame_size = sensor_enum_frame_size,
	.get_fmt = sensor_get_fmt,
	.set_fmt = sensor_set_fmt,
	.get_mbus_config = sensor_g_mbus_config,
};
```

注意：`sensor_helper.c` 里实现了 `sensor_enum_frame_interval()`，但 gc2053 的 `sensor_pad_ops` 没有挂 `.enum_frame_interval`。因此 video node 虽然实现了 `VIDIOC_ENUM_FRAMEINTERVALS`，对 gc2053 这类未挂接的 sensor 实际会失败：

```c
/* bsp/drivers/vin/vin-video/vin_video.c:757-780 */
static int vidioc_enum_frameintervals(struct file *file, void *fh,
					  struct v4l2_frmivalenum *fival)
{
	...
	ret = v4l2_subdev_call(vinc->vid_cap.pipe.sd[VIN_IND_SENSOR], pad,
				enum_frame_interval, NULL, &fie);
	if (ret < 0)
		return -1;

	fival->type = V4L2_FRMIVAL_TYPE_DISCRETE;
	fival->discrete = fie.interval;
	return 0;
}
```

gc2053 的 MIPI 总线配置只给出固定 CSI2 DPHY/2 lane：

```c
/* bsp/drivers/vin/modules/sensor/gc2053_mipi.c:1424-1436 */
static int sensor_g_mbus_config(struct v4l2_subdev *sd, unsigned int pad,
				struct v4l2_mbus_config *cfg)
{
	cfg->type  = V4L2_MBUS_CSI2_DPHY;
#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 1, 0)
	cfg->bus.mipi_csi2.num_data_lanes =
		0 | V4L2_MBUS_CSI2_2_LANE | V4L2_MBUS_CSI2_CHANNEL_0;
#else
	cfg->flags = 0 | V4L2_MBUS_CSI2_2_LANE | V4L2_MBUS_CSI2_CHANNEL_0;
#endif
	return 0;
}
```

controls 也只有 gain/exposure：

```c
/* bsp/drivers/vin/modules/sensor/gc2053_mipi.c:1589-1615 */
static int sensor_init_controls(struct v4l2_subdev *sd,
				const struct v4l2_ctrl_ops *ops)
{
	struct sensor_info *info = to_state(sd);
	struct v4l2_ctrl_handler *handler = &info->handler;
	struct v4l2_ctrl *ctrl;

	v4l2_ctrl_handler_init(handler, 2);

	ctrl = v4l2_ctrl_new_std(handler, ops, V4L2_CID_GAIN, 1 * 1600,
				  256 * 1600, 1, 1 * 1600);
	if (ctrl != NULL)
		ctrl->flags |= V4L2_CTRL_FLAG_VOLATILE;

	ctrl = v4l2_ctrl_new_std(handler, ops, V4L2_CID_EXPOSURE, 1,
				  65536 * 16, 1, 1);
	if (ctrl != NULL)
		ctrl->flags |= V4L2_CTRL_FLAG_VOLATILE;

	sd->ctrl_handler = handler;
	return ret;
}
```

主线 raw sensor 通常希望有 `V4L2_CID_PIXEL_RATE`、`V4L2_CID_HBLANK`、`V4L2_CID_VBLANK` 等 timing controls。内核文档 `camera-sensor.rst` 明确说明 frame interval 由 crop width/height、blanking、pixel rate 推导。gc2053 当前没有按这个模型暴露 timing。

### 3.2 gc2053 与 VIN 的实际串联

gc2053 的 `set_fmt` 由通用 helper 完成，本质是选择 `current_wins` 和 `fmt`：

```c
/* bsp/drivers/vin/modules/sensor/sensor_helper.c:826-862 */
int sensor_set_fmt(struct v4l2_subdev *sd,
			struct v4l2_subdev_pad_config *cfg,
			struct v4l2_subdev_format *fmt)
{
	struct sensor_info *info = to_state(sd);
	struct sensor_win_size *ws = NULL;
	struct sensor_format_struct *sf = NULL;
	...
	sensor_try_format(sd, cfg, fmt, &ws, &sf);
	if (fmt->which == V4L2_SUBDEV_FORMAT_TRY) {
		...
		*mf = fmt->format;
	} else {
		switch (fmt->pad) {
		case SENSOR_PAD_SOURCE:
			info->current_wins = ws;
			info->fmt = sf;
			break;
		default:
			ret = -EBUSY;
		}
	}
	...
}
```

VIN `S_FMT` 后会通过 gc2053 私有 ioctl 拿当前窗口：

```c
/* bsp/drivers/vin/modules/sensor/gc2053_mipi.c:1276-1290 */
static long sensor_ioctl(struct v4l2_subdev *sd, unsigned int cmd, void *arg)
{
	struct sensor_info *info = to_state(sd);

	switch (cmd) {
	case GET_CURRENT_WIN_CFG:
		if (info->current_wins != NULL) {
			memcpy(arg, info->current_wins,
				sizeof(*info->current_wins));
			ret = 0;
		} else {
			sensor_err("empty wins!\n");
			ret = -1;
		}
		...
	}
}
```

VIN 再用这个 `win_cfg` 配 CSI parser crop 和 VIPP/scaler crop：

```c
/* bsp/drivers/vin/vin-video/vin_video.c:1132-1177 */
cfg.try_crop.width = win_cfg.width;
cfg.try_crop.height = win_cfg.height;
cfg.try_crop.left = win_cfg.hoffset;
cfg.try_crop.top = win_cfg.voffset;
sel.which = V4L2_SUBDEV_FORMAT_TRY;
sel.pad = cap->pipe.sd[VIN_IND_CSI]->entity.num_pads - 1;

ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_CSI], pad,
			set_selection, &state, &sel);

if ((win_cfg.vipp_hoff != 0) || (win_cfg.vipp_voff != 0)) {
	sel.target = V4L2_SEL_TGT_CROP;
	sel.pad = SCALER_PAD_SINK;
	sel.which = V4L2_SUBDEV_FORMAT_ACTIVE;
	sel.r.width = win_cfg.vipp_w;
	sel.r.height = win_cfg.vipp_h;
	sel.r.left = win_cfg.vipp_hoff;
	sel.r.top = win_cfg.vipp_voff;
	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SCALER],
			pad, set_selection, NULL, &sel);
}
```

最后 `STREAMON` 调到 gc2053 的 `s_stream`，写入寄存器表：

```c
/* bsp/drivers/vin/modules/sensor/gc2053_mipi.c:1493-1535 */
static int sensor_reg_init(struct sensor_info *info)
{
	struct v4l2_subdev *sd = &info->sd;
	struct sensor_format_struct *sensor_fmt = info->fmt;
	struct sensor_win_size *wsize = info->current_wins;

	ret = sensor_write_array(sd, sensor_default_regs,
				 ARRAY_SIZE(sensor_default_regs));
	...
	sensor_write_array(sd, sensor_fmt->regs, sensor_fmt->regs_size);

	if (wsize->regs)
		sensor_write_array(sd, wsize->regs, wsize->regs_size);

	if (wsize->set_size)
		wsize->set_size(sd);

	info->width = wsize->width;
	info->height = wsize->height;
	return 0;
}

static int sensor_s_stream(struct v4l2_subdev *sd, int enable)
{
	struct sensor_info *info = to_state(sd);

	if (!enable)
		return 0;

	return sensor_reg_init(info);
}
```

这条链路说明 gc2053 是被 VIN video node 主动驱动的 register-list sensor，而不是由用户态通过 MC/subdev API 自由组合出来的 pipeline 节点。

## 4. 私有 ioctl 和 video node 代理 controls

VIN video node 接了大量私有 ioctl：

```c
/* bsp/drivers/vin/vin-video/vin_video.c:3567-3641 */
static long vin_param_handler(struct file *file, void *priv,
			      bool valid_prio, unsigned int cmd, void *param)
{
	switch (cmd) {
	case VIDIOC_ISP_EXIF_REQ:
		break;
	case VIDIOC_SYNC_CTRL:
		ret = vidioc_sync_ctrl(file, fh, param);
		break;
	case VIDIOC_SET_TOP_CLK:
		ret = vidioc_set_top_clk(file, fh, param);
		break;
	case VIDIOC_SET_FPS_DS:
		ret = vidioc_set_fps_ds(file, fh, param);
		break;
	case VIDIOC_ISP_DEBUG:
		ret = vidioc_set_isp_debug(file, fh, param);
		break;
	case VIDIOC_VIN_PTN_CFG:
		ret = vidioc_vin_ptn_config(file, fh, param);
		break;
	case VIDIOC_SET_PARSER_FPS:
		ret = vidioc_set_parser_fps(file, fh, param);
		break;
	case VIDIOC_SET_SENSOR_ISP_CFG:
		ret = vidioc_set_sensor_isp_cfg(file, fh, param);
		break;
	case VIDIOC_SET_VE_ONLINE:
		ret = vidioc_set_ve_online_cfg(file, fh, param);
		break;
	case VIDIOC_SET_VIPP_SHRINK:
		ret = vidioc_set_vipp_shrink_cfg(file, fh, param);
		break;
	case VIDIOC_SET_TDM_SPEEDDN_CFG:
		ret = vidioc_set_tdm_speeddn_cfg(file, fh, param);
		break;
	case VIDIOC_SET_DMA_MERGE:
		ret = vidioc_set_dma_merge(file, fh, param);
		break;
	default:
		ret = -ENOTTY;
	}
	return ret;
}
```

controls 也由 video node 根据 RAW+ISP 或非 RAW 路径代理到 ISP/sensor/flash/actuator：

```c
/* bsp/drivers/vin/vin-video/vin_video.c:4239-4297 */
if (inst->is_isp_used && inst->is_bayer_raw) {
	switch (ctrl->id) {
	case V4L2_CID_BRIGHTNESS:
	case V4L2_CID_CONTRAST:
	case V4L2_CID_SATURATION:
	case V4L2_CID_HUE:
	case V4L2_CID_AUTO_WHITE_BALANCE:
	case V4L2_CID_EXPOSURE:
	case V4L2_CID_AUTOGAIN:
	case V4L2_CID_GAIN:
	case V4L2_CID_POWER_LINE_FREQUENCY:
	case V4L2_CID_WHITE_BALANCE_TEMPERATURE:
	case V4L2_CID_SHARPNESS:
	case V4L2_CID_WIDE_DYNAMIC_RANGE:
	case V4L2_CID_3A_LOCK:
		ret = v4l2_s_ctrl(NULL, isp->ctrl_handler, &c);
		break;
	case V4L2_CID_FLASH_LED_MODE:
		ret = v4l2_s_ctrl(NULL, isp->ctrl_handler, &c);
		if (flash)
			ret = v4l2_s_ctrl(NULL, flash->ctrl_handler, &c);
		break;
	default:
		ret = -EINVAL;
		break;
	}
} else {
	...
	ret = v4l2_s_ctrl(NULL, sensor->ctrl_handler, &c);
}
```

这类私有能力无法被标准 `MEDIA_IOC_SETUP_LINK`、`VIDIOC_SUBDEV_S_FMT`、selection API 完整表达。

## 5. 正常主线应该完整实现什么

结合内核 6.6 文档，主线 MC-friendly camera pipeline 应该具备：

1. 标准 DT endpoint graph 描述物理连接。
2. bridge driver 使用 async notifier 绑定外部 sensor subdev。
3. media entity/pad/link/function 正确；可变链路由用户态通过 `MEDIA_IOC_SETUP_LINK` 控制。
4. 每个 subdev 提供足够完整的 pad ops：
   - `enum_mbus_code`
   - `enum_frame_size`
   - `enum_frame_interval` 或等价 timing controls
   - `get_fmt/set_fmt`
   - `get_selection/set_selection`
   - 必要时 `get_routing/set_routing`
   - sink pad 上的 `link_validate`
5. TRY 和 ACTIVE 状态严格分离。
6. raw sensor 暴露标准 timing/image controls，如 pixel rate、hblank、vblank、exposure、gain、test pattern。
7. ISP/scaler/capture 分层清晰：sensor/CSI/ISP/scaler 的配置在对应 subdev；video node 只负责最终 DMA buffer。
8. `STREAMON` 时 `media_pipeline_start()`、link validation、按拓扑启动 subdev；`STREAMOFF` 时停止 streaming，不把用户态配置好的 link 拆掉。
9. 私有 ioctl 尽量减少，确实需要时也应放在明确的 entity 或 metadata/stat node 上，而不是全部挂在 `/dev/videoX` 上。

标准用户态流程大致是：

```bash
media-ctl -p

media-ctl -l "'sensor':0->'csi':0[1]"
media-ctl -l "'csi':1->'isp':0[1]"
media-ctl -l "'isp':1->'scaler':0[1]"
media-ctl -l "'scaler':1->'capture':0[1]"

media-ctl -V "'sensor':0[fmt:SRGGB10_1X10/1920x1080]"
media-ctl -V "'csi':0[fmt:SRGGB10_1X10/1920x1080]"
media-ctl -V "'isp':0[fmt:SRGGB10_1X10/1920x1080]"
media-ctl -V "'isp':1[fmt:NV12/1920x1080]"
media-ctl -V "'scaler':0[fmt:NV12/1920x1080]"

v4l2-ctl -d /dev/video0 --set-fmt-video=width=1920,height=1080,pixelformat=NV12
v4l2-ctl -d /dev/video0 --stream-mmap
```

全志 VIN 更现实的流程是：

```bash
v4l2-ctl -d /dev/video0 --set-input 0
v4l2-ctl -d /dev/video0 --set-parm=...
v4l2-ctl -d /dev/video0 --set-fmt-video=width=1920,height=1080,pixelformat=NV12
v4l2-ctl -d /dev/video0 --stream-mmap
```

## 6. 对 libcamera 的具体影响

libcamera 这类库通常需要：

- 可靠的 media graph。
- 可通过 MC link 选择 pipeline。
- 可通过 subdev pad API 配置每一级格式。
- sensor 暴露标准 controls/timing。
- TRY format 无副作用。
- stream start 只启动已配置好的 pipeline。

当前 VIN 的问题对应为：

- graph 存在，但 link 控制不改变 `vinc->*_sel`。
- subdev 节点存在，但 ops 不完整、不对称。
- video `S_FMT` 会覆盖 subdev active format。
- video `TRY_FMT` 可能改变 active state。
- sensor controls 太少，gc2053 没有 pixel rate/hblank/vblank。
- streamoff 会拆 link，破坏用户态对 graph 状态的假设。
- ISP/3A/TDM/clock 等大量行为走私有 ioctl。

因此它缺的不是一个简单的 userspace 适配脚本，而是完整的 mainline-style pipeline handler 或驱动侧重构。若要让 libcamera 原生支持，通常有两条路：

1. 写一个专门的 libcamera pipeline handler，理解全志 VIN 的 video-centric 私有流程。
2. 重构内核驱动，使 MC/subdev 成为真实控制面，逐步消除 video node 对整条 pipeline 的私有代理。

第一条工程量小一些，但仍要处理私有 ioctl、ISP 参数、buffer 格式和 sensor mode 映射。第二条更符合主线，但工程量最大。

## 7. 最终结论

1. 全志 VIN 可以用于基本 V4L2 采集，但推荐按 `/dev/videoX` 的 BSP 流程使用。
2. 它不能被 libcamera/media-ctl 按主线 MC 模型完整控制，核心原因是控制权在 video node 内部，而不是用户态 MC/subdev。
3. C 程序直接 V4L2 调用最可控；OpenCV/cheese 有机会工作，但依赖 backend 是否支持 multiplanar、是否先 `S_INPUT`、是否选对格式。
4. gc2053 在这套框架里是 register-list sensor，被 VIN video node 通过 `set_fmt`、`GET_CURRENT_WIN_CFG`、`s_stream` 驱动；它不是一个完整主线自由配置 sensor entity。
5. 若目标是主线/libcamera 友好，需要补齐 DT endpoint graph、真实 link setup、完整 subdev pad ops、TRY/ACTIVE 语义、link validation、标准 sensor controls、标准 stream pipeline，以及减少 video node 私有代理。
