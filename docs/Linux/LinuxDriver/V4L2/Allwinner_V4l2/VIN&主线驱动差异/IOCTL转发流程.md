# sunxi-vin Video Node 注册与 ioctl 转发分析

## 文档目的

本文基于 `lichee/linux-4.9/drivers/media/platform/sunxi-vin` 的实际实现，说明三件事：

1. `sunxi-vin` 的 `/dev/videoX` 节点是如何被注册出来的。
2. 用户态对 `/dev/videoX` 发起 V4L2 ioctl 时，是如何进入 `sunxi-vin` 并被分发到具体处理函数的。
3. 当一个 V4L2 功能最终由某个 subdev 实现时，`sunxi-vin` 是如何把 video node 的请求转发给 sensor、CSI、ISP、scaler 等不同 subdev 的。

---

## 1. video 节点不是在 `vin_probe()` 里直接注册的

从结构上看，`sunxi-vin` 不是一个单纯的 video 驱动，而是一个 media graph 框架。  
它先创建和注册 capture subdev，再在 capture subdev 的注册回调里真正注册 `/dev/videoX`。

整体链路如下：

`vin_core_probe()`
-> `vin_initialize_capture_subdev()`
-> `vin_md_register_core_entity()`
-> `v4l2_device_register_subdev()`
-> `vin_capture_subdev_registered()`
-> `vin_init_video()`
-> `video_register_device()`

---

## 2. capture subdev 的创建

`vin-video/vin_core.c` 在 `vin_core_probe()` 中创建每个 `vin_core` 对应的 capture subdev：

```c
static int vin_core_probe(struct platform_device *pdev)
{
	struct device_node *np = pdev->dev.of_node;
	struct vin_core *vinc;
	...

	vinc = kzalloc(sizeof(struct vin_core), GFP_KERNEL);
	...

	vinc->id = pdev->id;
	vinc->pdev = pdev;
	vinc->vir_prosess_ch = vinc->id;
	...

	vin_irq_request(vinc, 0);

	ret = vin_initialize_capture_subdev(vinc);
	if (ret)
		goto unmap;
	...
}
```

`vin_initialize_capture_subdev()` 里并没有直接创建 `/dev/videoX`，而是先初始化一个 `VIN_GRP_ID_CAPTURE` 类型的 subdev：

```c
static const struct v4l2_subdev_internal_ops vin_capture_sd_internal_ops = {
	.registered = vin_capture_subdev_registered,
	.unregistered = vin_capture_subdev_unregistered,
};

int vin_initialize_capture_subdev(struct vin_core *vinc)
{
	struct v4l2_subdev *sd = &vinc->vid_cap.subdev;
	int ret;

	v4l2_subdev_init(sd, &vin_subdev_ops);
	sd->grp_id = VIN_GRP_ID_CAPTURE;
	sd->flags |= V4L2_SUBDEV_FL_HAS_DEVNODE;
	snprintf(sd->name, sizeof(sd->name), "vin_cap.%d", vinc->id);

	vinc->vid_cap.sd_pads[VIN_SD_PAD_SINK].flags = MEDIA_PAD_FL_SINK;
	vinc->vid_cap.sd_pads[VIN_SD_PAD_SOURCE].flags = MEDIA_PAD_FL_SOURCE;
	sd->entity.function = MEDIA_ENT_F_IO_V4L;
	ret = media_entity_pads_init(&sd->entity, VIN_SD_PADS_NUM,
				vinc->vid_cap.sd_pads);
	if (ret)
		return ret;

	sd->entity.ops = &vin_sd_media_ops;
	sd->internal_ops = &vin_capture_sd_internal_ops;
	v4l2_set_subdevdata(sd, vinc);
	return 0;
}
```

这里最重要的是：

- capture 自己也是一个 subdev
- 它带有 `registered` 回调
- 这个回调才是后续注册 video device 的真正入口

---

## 3. media 驱动注册 capture subdev

`vin.c` 中的 media 驱动会把前面创建好的 capture subdev 注册到 `v4l2_device` 中：

```c
static int vin_md_register_core_entity(struct vin_md *vind,
					struct vin_core *vinc)
{
	struct v4l2_subdev *sd;
	int ret;

	if (WARN_ON(vinc->id >= VIN_MAX_DEV))
		return -EBUSY;

	sd = &vinc->vid_cap.subdev;
	v4l2_set_subdev_hostdata(sd, (void *)&vin_pipe_ops);

	ret = v4l2_device_register_subdev(&vind->v4l2_dev, sd);
	if (!ret) {
		vind->vinc[vinc->id] = vinc;
		vinc->vid_cap.user_subdev_api = vind->user_subdev_api;
	} else {
		vin_err("Failed to register vin_cap.%d (%d)\n",
			 vinc->id, ret);
	}
	return ret;
}
```

`vin_md_register_entities()` 中会遍历各个 `vinc`，对每个 core entity 调用这一步：

```c
for (i = 0; i < VIN_MAX_DEV; i++) {
	struct modules_config *module = NULL;

	/*video device register */
	vind->vinc[i] = sunxi_vin_core_get_dev(i);
	if (vind->vinc[i] == NULL)
		continue;
	vind->vinc[i]->v4l2_dev = &vind->v4l2_dev;

	module = &vind->modules[vind->vinc[i]->rear_sensor];

	if (module->sensors.valid_idx == NO_VALID_SENSOR) {
		vind->vinc[i] = NULL;
		continue;
	}
	vin_md_register_core_entity(vind, vind->vinc[i]);
}
```

也就是说，`vin.c` 负责把 capture subdev 正式挂进 media/v4l2 框架。

---

## 4. 真正注册 `/dev/videoX` 的地方

当 capture subdev 注册完成后，会触发 `vin_capture_subdev_registered()`。  
真正的 video 节点注册就在这里完成。

```c
static int vin_capture_subdev_registered(struct v4l2_subdev *sd)
{
	struct vin_core *vinc = v4l2_get_subdevdata(sd);
	int ret;

	vinc->vid_cap.vinc = vinc;
	if (vin_init_controls(&vinc->vid_cap.ctrl_handler, &vinc->vid_cap)) {
		vin_err("Error v4l2 ctrls new!!\n");
		return -1;
	}

	vinc->pipeline_ops = v4l2_get_subdev_hostdata(sd);
	if (vin_init_video(sd->v4l2_dev, &vinc->vid_cap)) {
		vin_err("vin init video!!!!\n");
		vinc->pipeline_ops = NULL;
	}
	ret = sysfs_create_link(&vinc->vid_cap.vdev.dev.kobj,
		&vinc->pdev->dev.kobj, "vin_dbg");
	if (ret)
		vin_err("sysfs_create_link failed\n");
	...
}
```

而 `vin_init_video()` 里面真正调用了 `video_register_device()`：

```c
int vin_init_video(struct v4l2_device *v4l2_dev, struct vin_vid_cap *cap)
{
	int ret = 0;
	struct vb2_queue *q;
	static u64 vin_dma_mask = DMA_BIT_MASK(32);

	snprintf(cap->vdev.name, sizeof(cap->vdev.name),
		"vin_video%d", cap->vinc->id);
	cap->vdev.fops = &vin_fops;
	cap->vdev.ioctl_ops = &vin_ioctl_ops;
	cap->vdev.release = video_device_release_empty;
	cap->vdev.ctrl_handler = &cap->ctrl_handler;
	cap->vdev.v4l2_dev = v4l2_dev;
	cap->vdev.queue = &cap->vb_vidq;
	cap->vdev.lock = &cap->lock;
	cap->vdev.flags = V4L2_FL_USES_V4L2_FH;
	ret = video_register_device(&cap->vdev, VFL_TYPE_GRABBER, cap->vinc->id);
	if (ret < 0) {
		vin_err("Error video_register_device!!\n");
		return -1;
	}
	video_set_drvdata(&cap->vdev, cap->vinc);
	vin_log(VIN_LOG_VIDEO, "V4L2 device registered as %s\n",
		video_device_node_name(&cap->vdev));
	...
}
```

因此，结论很明确：

- 真正负责把 `/dev/videoX` 注册出来的是 `vin_init_video()`
- 但它不是被 `vin_probe()` 直接调起，而是由 capture subdev 的 `registered` 回调触发

---

## 5. `/dev/videoX` 的 ioctl 入口

video 节点创建出来之后，用户态对 `/dev/videoX` 的 ioctl 请求会先进入 `vin_fops`：

```c
static const struct v4l2_file_operations vin_fops = {
	.owner = THIS_MODULE,
	.open = vin_open,
	.release = vin_close,
	.read = vb2_fop_read,
	.poll = vin_poll,
	.unlocked_ioctl = video_ioctl2,
#ifdef CONFIG_COMPAT
	.compat_ioctl32 = vin_compat_ioctl32,
#endif
	.mmap = vb2_fop_mmap,
};
```

这里的重点是：

- `unlocked_ioctl = video_ioctl2`

所以 `/dev/videoX` 的所有标准 V4L2 ioctl，首先进入的是内核 V4L2 公共层的 `video_ioctl2()`，不是直接进入 `sunxi-vin` 自己写的某个函数。

V4L2 公共层里的 `video_ioctl2()` 很简单：

```c
long video_ioctl2(struct file *file,
		unsigned int cmd, unsigned long arg)
{
	return video_usercopy(file, cmd, arg, __video_do_ioctl);
}
```

真正的分发在 `__video_do_ioctl()`。  
它会根据 ioctl 编号，去调用 video device 的 `ioctl_ops` 中对应的 `vidioc_xxx`。

例如：

```c
ret = ops->vidioc_g_selection(file, fh, &s);
...
return ops->vidioc_s_selection(file, fh, &s);
```

以及：

```c
return ops->vidioc_streamon(file, fh, *(unsigned int *)arg);
...
return ops->vidioc_streamoff(file, fh, *(unsigned int *)arg);
```

这一步的前提是：`cap->vdev.ioctl_ops = &vin_ioctl_ops`，而 `sunxi-vin` 确实这样设置了。

---

## 6. `sunxi-vin` 的 `vin_ioctl_ops`

`vin_init_video()` 里把 `video_device.ioctl_ops` 设成了 `vin_ioctl_ops`，因此后续所有标准 V4L2 ioctl 都会分发到这里：

```c
static const struct v4l2_ioctl_ops vin_ioctl_ops = {
	.vidioc_querycap = vidioc_querycap,
	.vidioc_enum_fmt_vid_cap_mplane = vidioc_enum_fmt_vid_cap_mplane,
	.vidioc_enum_framesizes = vidioc_enum_framesizes,
	.vidioc_g_fmt_vid_cap_mplane = vidioc_g_fmt_vid_cap_mplane,
	.vidioc_try_fmt_vid_cap_mplane = vidioc_try_fmt_vid_cap_mplane,
	.vidioc_s_fmt_vid_cap_mplane = vidioc_s_fmt_vid_cap_mplane,
	.vidioc_enum_fmt_vid_overlay = vidioc_enum_fmt_vid_overlay,
	.vidioc_g_fmt_vid_overlay = vidioc_g_fmt_vid_overlay,
	.vidioc_try_fmt_vid_overlay = vidioc_try_fmt_vid_overlay,
	.vidioc_s_fmt_vid_overlay = vidioc_s_fmt_vid_overlay,
	.vidioc_overlay = vidioc_overlay,
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
	.vidioc_subscribe_event = vin_subscribe_event,
	.vidioc_unsubscribe_event = v4l2_event_unsubscribe,
};
```

所以链路可以写成：

`用户态 ioctl(fd, CMD, ...)`
-> `video_ioctl2()`
-> `__video_do_ioctl()`
-> `vin_ioctl_ops.vidioc_xxx`
-> `sunxi-vin` 的 `vidioc_xxx()` handler

---

## 7. video node 并不自己完成所有功能，而是把请求转发到具体 subdev

这也是理解 `sunxi-vin` 的关键。

对于 `/dev/videoX`，用户态调用的始终是 video node。  
但 video node 很多时候只是一个“统一入口”，实际功能由下游 subdev 实现。

也就是说：

- 用户态并不会自己决定“这次 ioctl 打给 sensor 还是 scaler”
- 这个分发策略是在 `vin_video.c` 的各个 `vidioc_xxx()` 中写死的

---

## 8. `pipe.sd[]`：video node 如何拿到各级 subdev

`sunxi-vin` 在 pipeline 建立时，会沿 media graph 回溯，把整条链路上的 subdev 填进 `pipe.sd[]`。

关键代码如下：

```c
for (i = 0; i < VIN_IND_ACTUATOR; i++)
	p->sd[i] = NULL;

while (1) {
	struct media_pad *pad = NULL;

	/* Find remote source pad */
	for (i = 0; i < me->num_pads; i++) {
		struct media_pad *spad = &me->pads[i];

		if (!(spad->flags & MEDIA_PAD_FL_SINK))
			continue;
		pad = media_entity_remote_pad(spad);
		if (pad)
			break;
	}

	if (pad == NULL)
		break;

	sd = media_entity_to_v4l2_subdev(pad->entity);
	vin_log(VIN_LOG_MD, "%s entity is %s, group id is 0x%x\n",
		__func__, pad->entity->name, sd->grp_id);

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
	case VIN_GRP_ID_SCALER:
		p->sd[VIN_IND_SCALER] = sd;
		break;
	case VIN_GRP_ID_CAPTURE:
		p->sd[VIN_IND_CAPTURE] = sd;
		break;
	default:
		break;
	}
}
```

因此，后续 `vidioc_xxx()` 里只要拿：

- `pipe.sd[VIN_IND_SENSOR]`
- `pipe.sd[VIN_IND_CSI]`
- `pipe.sd[VIN_IND_ISP]`
- `pipe.sd[VIN_IND_SCALER]`

就能把请求准确转给对应模块。

---

## 9. 典型转发模式一：video node 直接点名某一个 subdev

### 9.1 `VIDIOC_G_SELECTION` / `VIDIOC_S_SELECTION` 直接转给 scaler

这就是 `get_selection` 问题的根本原因。

```c
int vidioc_s_selection(struct file *file, void *fh,
				struct v4l2_selection *s)
{
	struct vin_core *vinc = video_drvdata(file);
	struct v4l2_subdev_selection sel;
	int ret = 0;

	sel.which = V4L2_SUBDEV_FORMAT_ACTIVE;
	sel.pad = SCALER_PAD_SINK;
	sel.target = s->target;
	sel.flags = s->flags;
	sel.r = s->r;
	ret = v4l2_subdev_call(vinc->vid_cap.pipe.sd[VIN_IND_SCALER], pad,
				set_selection, NULL, &sel);
	if (ret < 0)
		vin_err("v4l2 sub device scaler set_selection error!\n");
	return ret;
}

int vidioc_g_selection(struct file *file, void *fh,
				struct v4l2_selection *s)
{
	struct vin_core *vinc = video_drvdata(file);
	struct v4l2_subdev_selection sel;
	int ret = 0;

	sel.which = V4L2_SUBDEV_FORMAT_ACTIVE;
	sel.pad = SCALER_PAD_SINK;
	sel.target = s->target;
	sel.flags = s->flags;
	ret = v4l2_subdev_call(vinc->vid_cap.pipe.sd[VIN_IND_SCALER], pad,
				get_selection, NULL, &sel);
	if (ret < 0)
		vin_err("v4l2 sub device scaler get_selection error!\n");
	else
		s->r = sel.r;
	return ret;
}
```

这段代码说明得非常直接：

- `VIDIOC_G_SELECTION`
- `VIDIOC_S_SELECTION`

在 `sunxi-vin` 的 video node 上，根本不是 video 节点自己处理，而是**固定转给 scaler 的 pad ops**。

而 scaler 的 pad ops 也确实这样定义：

```c
static const struct v4l2_subdev_pad_ops sunxi_scaler_subdev_pad_ops = {
	.get_fmt = sunxi_scaler_subdev_get_fmt,
	.set_fmt = sunxi_scaler_subdev_set_fmt,
	.get_selection = sunxi_scaler_subdev_get_selection,
	.set_selection = sunxi_scaler_subdev_set_selection,
};
```

scaler 的 `get_selection` 只支持 `CROP_BOUNDS` 和 `CROP`：

```c
static int sunxi_scaler_subdev_get_selection(struct v4l2_subdev *sd,
					     struct v4l2_subdev_pad_config *cfg,
					     struct v4l2_subdev_selection *sel)
{
	...
	if (sel->pad != SCALER_PAD_SINK)
		return -EINVAL;

	switch (sel->target) {
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

	return 0;
}
```

因此 `G_SELECTION(COMPOSE)` 报错，不是因为 video node 没接到请求，而是：

- video node 接到了
- video node 又明确转给了 scaler
- scaler 不支持这个 target

---

## 10. 典型转发模式二：video node 只转给 sensor

例如 `VIDIOC_G_PARM`，它只打给 sensor：

```c
static int vidioc_g_parm(struct file *file, void *priv,
			 struct v4l2_streamparm *parms)
{
	struct vin_core *vinc = video_drvdata(file);
	int ret;

	ret =
	    v4l2_subdev_call(vinc->vid_cap.pipe.sd[VIN_IND_SENSOR], video,
			     g_parm, parms);
	if (ret < 0)
		vin_warn("v4l2 sub device g_parm fail!\n");

	return ret;
}
```

这就意味着：

- 用户态调的是 `/dev/videoX`
- 但 `G_PARM` 的真正后端其实是 sensor 的 `.video.g_parm`

例如 gc2053 的 sensor ops 中，确实定义了：

```c
static const struct v4l2_subdev_video_ops sensor_video_ops = {
	.s_parm = sensor_s_parm,
	.g_parm = sensor_g_parm,
	.s_stream = sensor_s_stream,
	.g_mbus_config = sensor_g_mbus_config,
};

static const struct v4l2_subdev_pad_ops sensor_pad_ops = {
	.enum_mbus_code = sensor_enum_mbus_code,
	.enum_frame_size = sensor_enum_frame_size,
	.get_fmt = sensor_get_fmt,
	.set_fmt = sensor_set_fmt,
};

static const struct v4l2_subdev_ops sensor_ops = {
	.core = &sensor_core_ops,
	.video = &sensor_video_ops,
	.pad = &sensor_pad_ops,
};
```

---

## 11. 典型转发模式三：一个 ioctl 会扇出到多个 subdev

`VIDIOC_S_PARM` 是最典型的例子。

它不是只转给 sensor，而是按照框架需要，依次同步给多个模块：

```c
static int __vin_s_parm(struct vin_core *vinc,
			 struct v4l2_streamparm *parms)
{
	struct vin_vid_cap *cap = &vinc->vid_cap;
	struct sensor_instance *inst = get_valid_sensor(vinc);
	int ret = 0;
	...

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

	return ret;
}
```

从这段代码可以看出，`sunxi-vin` 的 video node 并不是“把一个 ioctl 机械映射到一个 subdev”，而是：

- 某些 ioctl 由一个 subdev 负责
- 某些 ioctl 会作为“配置同步动作”分发给多个 subdev

---

## 12. 典型转发模式四：交给 pipeline 统一调度

`VIDIOC_S_FMT` 和 `VIDIOC_STREAMON/OFF` 更进一步，它们并不总是由 `vidioc_xxx()` 自己一个个点名 subdev，而是会交给 pipeline 统一处理。

### 12.1 `VIDIOC_S_FMT`

`S_FMT` 最核心的一步是：

```c
ret = vin_pipeline_try_format(vinc, &mf, &ffmt, true);
```

`vin_pipeline_try_format()` 会遍历 media graph，对路径上的 subdev 调用 `set_fmt`：

```c
while ((me = media_entity_graph_walk_next(&graph)) &&
	me != &vinc->vid_cap.subdev.entity) {

	sd = media_entity_to_v4l2_subdev(me);
	...
	ret = v4l2_subdev_call(sd, pad, set_fmt, NULL, &sfmt);
	if (ret)
		goto out;

	if (me->pads[0].flags & MEDIA_PAD_FL_SINK) {
		sfmt.pad = me->num_pads - 1;
		ret = v4l2_subdev_call(sd, pad, set_fmt, NULL, &sfmt);
		if (ret)
			goto out;
	}
}
```

然后 `S_FMT` 还会补发一些特定 subdev 的 selection 配置：

```c
ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_CSI], pad,
			set_selection, &cfg, NULL);

ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SCALER],
		pad, set_selection, NULL, &sel);
```

所以 `S_FMT` 的本质是：

- 先走全 pipeline 的 `set_fmt`
- 再做 CSI/scaler 的补充配置

### 12.2 `VIDIOC_STREAMON`

`STREAMON` 不是自己直接逐个调 `s_stream`，而是交给 `vin_pipeline_call(... set_stream ...)`：

```c
ret = vin_pipeline_call(cap->vinc, set_stream, &cap->pipe, cap->vinc->stream_idx);
if (ret < 0)
	vin_err("video%d %s error!\n", vinc->id, __func__);
```

`vin_pipeline_call` 的定义如下：

```c
struct vin_pipeline_ops {
	int (*open)(struct vin_pipeline *p, struct media_entity *me,
			  bool resume);
	int (*close)(struct vin_pipeline *p);
	int (*set_stream)(struct vin_pipeline *p, int state);
};

#define vin_pipeline_call(f, op, p, args...)				\
	(((f)->pipeline_ops && (f)->pipeline_ops->op) ? \
			    (f)->pipeline_ops->op((p), ##args) : -ENOIOCTLCMD)
```

而挂到 capture subdev 上的 pipeline ops 是：

```c
static const struct vin_pipeline_ops vin_pipe_ops = {
	.open		= __vin_pipeline_open,
	.close		= __vin_pipeline_close,
	.set_stream	= __vin_pipeline_s_stream,
};
```

底层统一打开单个 subdev stream 的位置，最终还是 `v4l2_subdev_call(sd, video, s_stream, on)`：

```c
static int __vin_subdev_set_stream(struct v4l2_subdev *sd, unsigned int idx, int on)
{
	...
	ret = v4l2_subdev_call(sd, video, s_stream, on);
	...
}
```

这说明：

- `STREAMON/OFF` 是 pipeline 级别动作
- 它们不是简单点名某一个 subdev
- 而是按 `sunxi-vin` 自己定义的 pipeline 顺序去统一开关各级模块

---

## 13. `/dev/videoX` 路径和 `/dev/v4l-subdevX` 路径的区别

这也是理解“上层怎么调用到相应 V4L2 subdev”的关键。

### 13.1 打开 `/dev/videoX`

如果用户态打开的是 `/dev/video0`、`/dev/video1` 之类 video node：

- 用户态只会调用 video node
- video node 内部再根据 `vidioc_xxx()` 的实现，选择转发到 sensor / CSI / ISP / scaler
- 上层程序自己并不会“直接挑一个 subdev”

也就是说，对 `/dev/videoX` 而言：

- 分发策略由 `sunxi-vin` 写死
- 不是用户态自己控制

### 13.2 打开 `/dev/v4l-subdevX`

如果用户态真的想直接对某一级 subdev 发 ioctl，那就必须直接打开 subdev 节点。

VIN 框架里的各类 subdev 都设置了 `V4L2_SUBDEV_FL_HAS_DEVNODE`：

```c
/* capture */
sd->flags |= V4L2_SUBDEV_FL_HAS_DEVNODE;

/* scaler */
sd->flags |= V4L2_SUBDEV_FL_HAS_EVENTS | V4L2_SUBDEV_FL_HAS_DEVNODE;

/* csi */
sd->flags |= V4L2_SUBDEV_FL_HAS_DEVNODE;

/* mipi */
sd->flags |= V4L2_SUBDEV_FL_HAS_DEVNODE;

/* isp */
sd->flags |= V4L2_SUBDEV_FL_HAS_EVENTS | V4L2_SUBDEV_FL_HAS_DEVNODE;

/* sensor */
sd->flags |= V4L2_SUBDEV_FL_HAS_DEVNODE;
```

VIN media 驱动最后也会统一注册 subdev 节点：

```c
ret = v4l2_device_register_subdev_nodes(&vind->v4l2_dev);
if (ret)
	goto err_clk;
```

所以有两条完全不同的用户态路径：

1. `/dev/videoX`
   - 你调到的是 video node
   - subdev 由 `sunxi-vin` 内部分发

2. `/dev/v4l-subdevX`
   - 你直接调到某个 subdev
   - 不经过 video node 的 `vidioc_xxx()` 分发层

---

## 14. 各类 subdev 自己实际支持哪些 ops

这一步可以帮助理解为什么某个 ioctl 最终必须转给某个特定 subdev。

### sensor

```c
static const struct v4l2_subdev_video_ops sensor_video_ops = {
	.s_parm = sensor_s_parm,
	.g_parm = sensor_g_parm,
	.s_stream = sensor_s_stream,
	.g_mbus_config = sensor_g_mbus_config,
};

static const struct v4l2_subdev_pad_ops sensor_pad_ops = {
	.enum_mbus_code = sensor_enum_mbus_code,
	.enum_frame_size = sensor_enum_frame_size,
	.get_fmt = sensor_get_fmt,
	.set_fmt = sensor_set_fmt,
};

static const struct v4l2_subdev_ops sensor_ops = {
	.core = &sensor_core_ops,
	.video = &sensor_video_ops,
	.pad = &sensor_pad_ops,
};
```

### CSI

```c
static const struct v4l2_subdev_video_ops sunxi_csi_subdev_video_ops = {
	.s_stream = sunxi_csi_subdev_s_stream,
	.s_mbus_config = sunxi_csi_s_mbus_config,
	.s_parm = sunxi_csi_subdev_s_parm,
};

static const struct v4l2_subdev_pad_ops sunxi_csi_subdev_pad_ops = {
	.set_selection = sunxi_csi_subdev_set_selection,
	.get_fmt = sunxi_csi_subdev_get_fmt,
	.set_fmt = sunxi_csi_subdev_set_fmt,
};
```

### ISP

```c
static const struct v4l2_subdev_video_ops sunxi_isp_subdev_video_ops = {
	.s_parm = sunxi_isp_s_parm,
	.g_parm = sunxi_isp_g_parm,
	.s_stream = sunxi_isp_subdev_s_stream,
};

static const struct v4l2_subdev_pad_ops sunxi_isp_subdev_pad_ops = {
	.get_fmt = sunxi_isp_subdev_get_fmt,
	.set_fmt = sunxi_isp_subdev_set_fmt,
};

static struct v4l2_subdev_ops sunxi_isp_subdev_ops = {
	.core = &sunxi_isp_subdev_core_ops,
	.video = &sunxi_isp_subdev_video_ops,
	.pad = &sunxi_isp_subdev_pad_ops,
};
```

### scaler

```c
static const struct v4l2_subdev_video_ops sunxi_scaler_subdev_video_ops = {
	.s_stream = sunxi_scaler_subdev_s_stream,
	.s_parm = sunxi_scaler_subdev_s_parm,
};

static const struct v4l2_subdev_pad_ops sunxi_scaler_subdev_pad_ops = {
	.get_fmt = sunxi_scaler_subdev_get_fmt,
	.set_fmt = sunxi_scaler_subdev_set_fmt,
	.get_selection = sunxi_scaler_subdev_get_selection,
	.set_selection = sunxi_scaler_subdev_set_selection,
};
```

这说明 video node 的转发目标并不是随意的，而是由各 subdev 实际提供的 ops 决定的。

---

## 15. 总结

`sunxi-vin` 的 `/dev/videoX` 并不是一个独立完成所有功能的“黑盒视频设备”，而是整个 VIN media pipeline 的统一用户态入口。

从实现上看：

- capture subdev 先由 `vin_core_probe()` 创建
- media 驱动把 capture subdev 注册到 `v4l2_device`
- capture subdev 的 `registered` 回调里调用 `vin_init_video()`
- `vin_init_video()` 通过 `video_register_device()` 真正注册出 `/dev/videoX`

而在 ioctl 调用链上：

- 用户态 ioctl 先进入 `video_ioctl2`
- `video_ioctl2` 再根据 `vin_ioctl_ops` 分发到 `sunxi-vin` 的 `vidioc_xxx()`
- 每个 `vidioc_xxx()` 再按自身逻辑：
  - 直接转给某一个 subdev
  - 扇出给多个 subdev
  - 或交给 pipeline 统一调度

因此，对于 `/dev/videoX`：

- 上层并不会自己“选择 subdev”
- 由哪个 subdev 真正执行某个功能，是 `sunxi-vin` 在 `vin_video.c` 中写死的分发策略

如果用户态真的想直接对某个 subdev 发 ioctl，则应当走 `/dev/v4l-subdevX` 这条路径，而不是 `/dev/videoX`。
