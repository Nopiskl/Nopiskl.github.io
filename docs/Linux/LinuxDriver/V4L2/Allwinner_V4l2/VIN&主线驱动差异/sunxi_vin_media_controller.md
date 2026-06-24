# 全志 sunxi-vin 驱动与主线 Media Controller 差异

本文整理基于当前工程中的源码：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/`
- `lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi`

结论先行：这套 `sunxi-vin` 并不是主线意义上的 **Media Controller-centric** 驱动。它确实创建了 `media_device`、`media_entity`、pad、link、`v4l2_subdev` 和 `/dev/v4l-subdevX` 节点，但这些机制主要被当作驱动内部的 pipeline 描述和遍历骨架。真正的用户态控制面主要集中在 `/dev/videoX`，由 video node 在内核中代替用户完成 sensor、MIPI、CSI、TDM、ISP、VIPP/Scaler、DMA 的选路、格式下发、裁剪、上电和 `s_stream` 顺序控制。

换句话说，`sunxi-vin` 更接近：

```text
BSP video-centric 驱动
    + 内部 V4L2 subdev pipeline manager
    + DTS 固定拓扑选择
    + 私有 ioctl / 私有 controls
```

而不是：

```text
主线 MC-centric 驱动
    + 用户态 media-ctl 配 link
    + 用户态 VIDIOC_SUBDEV_S_FMT 配每一级 pad
    + STREAMON 时只启动已经配置好的 pipeline
```

---

## 1. 主线 MC-centric 模型

主线文档中的 MC-centric 典型流程是：

1. 用户态通过 `/dev/mediaX` 枚举 entity、pad、link。
2. 用户态通过 `MEDIA_IOC_SETUP_LINK` 或 `media-ctl -l` 选择有效 pipeline。
3. 用户态打开 `/dev/v4l-subdevX`，用 `VIDIOC_SUBDEV_S_FMT`、`VIDIOC_SUBDEV_S_SELECTION` 等接口逐级配置 sensor、PHY/MIPI、CSI、ISP、Scaler。
4. 用户态最后打开 `/dev/videoX`，设置 video node buffer 格式，申请 buffer，然后 `VIDIOC_STREAMON`。
5. 驱动在 `STREAMON` 时校验 pipeline 格式是否匹配，并启动硬件。

这种模式强调：**拓扑和 pad 级格式配置是用户态职责**。驱动暴露硬件结构，用户态负责把 pipeline 配成合法状态。

---

## 2. sunxi-vin 的整体框架

全志这套框架由一个顶层 media 设备和多个内部 subdev 组成：

```text
sensor
  -> MIPI / CSI
  -> CSI parser
  -> TDM RX, 可选
  -> ISP
  -> VIPP / scaler
  -> vin_cap subdev
  -> /dev/videoX
```

源码结构大致如下：

| 模块 | 主要源码 | 角色 |
|---|---|---|
| 顶层 media 管理 | `vin.c` | 注册 `media_device`、`v4l2_device`，创建 links，维护 pipeline |
| video node / capture | `vin-video/vin_video.c` | `/dev/videoX` ioctl、buffer、streamon、controls 代理 |
| VIN core | `vin-video/vin_core.c` | 每个 `vincX` 的硬件实例、DTS 选择项读取、DMA 中断 |
| MIPI | `vin-mipi/sunxi_mipi.c` | MIPI/Combo PHY subdev |
| CSI | `vin-csi/sunxi_csi.c` | CSI parser subdev |
| TDM | `vin-tdm/vin_tdm.c` | TDM RX subdev |
| ISP | `vin-isp/sunxi_isp.c` | ISP subdev、ISP 参数和中断 |
| 统计 | `vin-stat/vin_h3a.c` | H3A 统计 subdev，非 Melis 模式下存在 |
| Scaler/VIPP | `vin-vipp/sunxi_scaler.c` | VIPP/scaler subdev |
| Sensor | `modules/sensor/*.c` | 各 sensor 驱动和私有 ioctl |

关键点：这些 subdev 虽然存在，但主流程不是让用户态逐个配置，而是由 video node 和 `vin.c` 内部的 pipeline manager 调用它们。

---

## 3. DTS 固定 pipeline 选择

在主线 MC-centric 设计里，DTS 通常描述硬件 endpoint 连接关系，用户态仍可以通过 media graph 选择 link。全志这里则更像是 DTS 直接给出每个 `vinc` 的固定配方。

以 `sun8iw21p1.dtsi` 中的 `vinc00` 为例：

```dts
/* lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi */

vinc00:vinc@0 {
	device_type = "vinc0";
	compatible = "allwinner,sunxi-vin-core";
	reg = <0x0 0x05830000 0x0 0x1000>;
	interrupts = <GIC_SPI 95 4>;
	vinc0_csi_sel = <0>;
	vinc0_mipi_sel = <0>;
	vinc0_isp_sel = <0>;
	vinc0_isp_tx_ch = <0>;
	vinc0_tdm_rx_sel = <0>;
	vinc0_rear_sensor_sel = <0>;
	vinc0_front_sensor_sel = <0>;
	vinc0_sensor_list = <0>;
	device_id = <0>;
	work_mode = <0x0>;
	iommus = <&mmu_aw 1 1>;
	status = "okay";
};
```

这些字段决定了：

- `vinc0` 使用 `csi0`
- `vinc0` 使用 `mipi0`
- `vinc0` 使用 `isp0`
- `vinc0` 使用 `tdm_rx0`
- `vinc0` 绑定 `sensor0`

对应的 probe 读取逻辑在 `vin-video/vin_core.c`：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c */

sprintf(property_name, "vinc%d_rear_sensor_sel", pdev->id);
if (of_property_read_u32(np, property_name, &vinc->rear_sensor))
	vinc->rear_sensor = 0;

sprintf(property_name, "vinc%d_front_sensor_sel", pdev->id);
if (of_property_read_u32(np, property_name, &vinc->front_sensor))
	vinc->front_sensor = 1;

sprintf(property_name, "vinc%d_csi_sel", pdev->id);
if (of_property_read_u32(np, property_name, &vinc->csi_sel))
	vinc->csi_sel = 0;

sprintf(property_name, "vinc%d_mipi_sel", pdev->id);
if (of_property_read_u32(np, property_name, &vinc->mipi_sel))
	vinc->mipi_sel = 0xff;

sprintf(property_name, "vinc%d_isp_sel", pdev->id);
if (of_property_read_u32(np, property_name, &vinc->isp_sel))
	vinc->isp_sel = 0;

sprintf(property_name, "vinc%d_tdm_rx_sel", pdev->id);
if (of_property_read_u32(np, property_name, &vinc->tdm_rx_sel))
	vinc->tdm_rx_sel = 0;

vinc->vipp_sel = pdev->id;
```

这说明 pipeline 的核心选择并不来自用户态 `MEDIA_IOC_SETUP_LINK`，而是在 probe 时从 DTS 固化进 `struct vin_core`。

---

## 4. 顶层 media device 注册了，但默认是 video-node-only

`vin.c` 确实注册了 `media_device` 和 `v4l2_device`：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c */

strlcpy(vind->media_dev.model, "Allwinner Vin",
	sizeof(vind->media_dev.model));

vind->media_dev.ops = &media_device_ops;
vind->media_dev.dev = dev;

v4l2_dev = &vind->v4l2_dev;
v4l2_dev->mdev = &vind->media_dev;
strlcpy(v4l2_dev->name, "sunxi-vin", sizeof(v4l2_dev->name));

ret = v4l2_device_register(dev, &vind->v4l2_dev);
media_device_init(&vind->media_dev);
ret = media_device_register(&vind->media_dev);
```

但紧接着能看到默认控制模式：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c */

vind->user_subdev_api = 0;
```

对应 sysfs 文本非常直接：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c */

static ssize_t vin_md_sysfs_show(struct device *dev,
				 struct device_attribute *attr, char *buf)
{
	struct platform_device *pdev = to_platform_device(dev);
	struct vin_md *vind = platform_get_drvdata(pdev);

	if (vind->user_subdev_api)
		return strlcpy(buf, "Sub-device API (sub-dev)\n", PAGE_SIZE);

	return strlcpy(buf, "V4L2 video node only API (vid-dev)\n", PAGE_SIZE);
}
```

也就是说，全志自己在代码里就承认默认模式是：

```text
V4L2 video node only API (vid-dev)
```

虽然可以通过 sysfs 写入 `"sub-dev\n"` 切换 `user_subdev_api` 标志，但这并不能让整套驱动变成主线 MC-centric。因为 link_setup、硬件 mux、pipeline open/close/streamon 的控制权仍然在驱动内部。

---

## 5. link 是驱动创建和默认启用的

`vin_create_media_links()` 根据 DTS 读出来的 `vinc->mipi_sel`、`vinc->csi_sel`、`vinc->isp_sel`、`vinc->vipp_sel` 创建 link。

关键代码：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c */

static int vin_create_media_links(struct vin_md *vind)
{
	struct v4l2_subdev *mipi, *csi, *isp, *scaler, *cap_sd;
	struct media_entity *source, *sink;
	struct modules_config *module;
	struct vin_core *vinc = NULL;
	int i, j, ret = 0;

	for (i = 0; i < VIN_MAX_DEV; i++) {
		vinc = vind->vinc[i];

		if (vinc == NULL)
			continue;

		/* MIPI */
		if (vinc->mipi_sel == 0xff)
			mipi = NULL;
		else
			mipi = vind->mipi[vinc->mipi_sel].sd;

		/* CSI */
		if (vinc->csi_sel == 0xff)
			csi = NULL;
		else
			csi = vind->csi[vinc->csi_sel].sd;

		if (mipi != NULL) {
			module = &vind->modules[vinc->rear_sensor];
			sensor_link_to_mipi_csi(module, mipi);

			source = &mipi->entity;
			sink = &csi->entity;
			ret = media_create_pad_link(source, MIPI_PAD_SOURCE,
						       sink, CSI_PAD_SINK,
						       MEDIA_LNK_FL_ENABLED);
		} else {
			module = &vind->modules[vinc->rear_sensor];
			sensor_link_to_mipi_csi(module, csi);
		}

		/* 后续还会创建 csi/tdm/isp/scaler/capture/video links */
	}
}
```

可以看到：

- link 的 source/sink 来自 `vinc->*_sel`
- MIPI -> CSI link 直接 `MEDIA_LNK_FL_ENABLED`
- Scaler -> Capture link 直接 `MEDIA_LNK_FL_ENABLED`
- Capture -> video node link 直接 `MEDIA_LNK_FL_ENABLED`
- ISP 统计节点 link 是 `MEDIA_LNK_FL_IMMUTABLE | MEDIA_LNK_FL_ENABLED`

其中 ISP 统计节点 link：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c */

ret = media_create_pad_link(source, ISP_PAD_SOURCE_ST,
			       sink, 0,
			       MEDIA_LNK_FL_IMMUTABLE |
			       MEDIA_LNK_FL_ENABLED);
```

默认 link 设置：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c */

static int vin_setup_default_links(struct vin_md *vind)
{
	...
	if (isp && scaler)
		link = media_entity_find_link(&isp->entity.pads[ISP_PAD_SOURCE],
					      &scaler->entity.pads[SCALER_PAD_SINK]);

	if (link) {
		ret = media_entity_setup_link(link, MEDIA_LNK_FL_ENABLED);
	}

	p = &vinc->vid_cap.pipe;
	vin_md_prepare_pipeline(p, &vinc->vid_cap.vdev.entity);
	...
}
```

这和主线由用户态决定 link 状态的模型不同。全志是在 probe 阶段先把默认 pipeline 准备好。

---

## 6. 用户态 setup link 不会真正驱动硬件路由

`media_device_ops` 只注册了 `link_notify`：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c */

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

这只是打印日志，不会：

- 更新 `vinc->mipi_sel`
- 更新 `vinc->csi_sel`
- 更新 `vinc->isp_sel`
- 更新 `vinc->vipp_sel`
- 重新构建 `pipe.sd[]`
- 配置硬件 mux

capture subdev 的 `link_setup` 更明显，直接空实现：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c */

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

因此，用户态即使用 `media-ctl -l` 或 `MEDIA_IOC_SETUP_LINK` 改了 media graph 的 link flag，也很难真正改变全志驱动内部的硬件路由。全志真正使用的是 `vinc->*_sel` 和内部 pipeline 数组，而不是用户态临时配置的 graph。

---

## 7. pipeline 是驱动内部反向遍历并用 grp_id 分类的

全志在 `vin_md_prepare_pipeline()` 中从 video entity 反向找 sink pad 的 remote source，然后按 `sd->grp_id` 填充内部 pipeline 数组：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c */

static void vin_md_prepare_pipeline(struct vin_pipeline *p,
				  struct media_entity *me)
{
	struct v4l2_subdev *sd;
	int i;

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
		me = &sd->entity;
		if (me->num_pads == 1)
			break;
	}
}
```

这里的重点不是“用户态配置了什么”，而是驱动内部需要一个固定数组：

```text
p->sd[VIN_IND_SENSOR]
p->sd[VIN_IND_MIPI]
p->sd[VIN_IND_CSI]
p->sd[VIN_IND_TDM_RX]
p->sd[VIN_IND_ISP]
p->sd[VIN_IND_SCALER]
p->sd[VIN_IND_CAPTURE]
```

后续所有 open、close、stream、format、controls 都围绕这个数组操作。

---

## 8. s_input 才是真正的 pipeline 打开入口

主线 MC-centric 中，`VIDIOC_S_INPUT` 通常不是复杂 pipeline 配置入口。但在全志这里，`VIDIOC_S_INPUT` 会真正 enable link、open pipeline、初始化 ISP/scaler/sensor。

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c */

static int __vin_s_input(struct vin_core *vinc, unsigned int i)
{
	struct vin_md *vind = dev_get_drvdata(vinc->v4l2_dev->dev);
	struct vin_vid_cap *cap = &vinc->vid_cap;
	struct modules_config *module = NULL;
	struct sensor_instance *inst = NULL;
	struct sensor_info *info = NULL;
	struct mipi_dev *mipi = NULL;
	int valid_idx = -1;
	int ret;

	i = i > 1 ? 0 : i;

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

	ret = vin_pipeline_call(vinc, open, &cap->pipe, &cap->vdev.entity, true);
	if (ret < 0)
		return ret;

	inst = &module->sensors.inst[valid_idx];
	sunxi_isp_sensor_type(cap->pipe.sd[VIN_IND_ISP], inst->is_isp_used);
	vinc->support_raw = inst->is_isp_used;

	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_ISP], core, init, 1);
	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SCALER], core, init, 1);

	info = container_of(cap->pipe.sd[VIN_IND_SENSOR], struct sensor_info, sd);
	if (info) {
		vinc->exp_gain.exp_val = info->exp;
		vinc->exp_gain.gain_val = info->gain;
		vinc->stream_idx = info->stream_seq + 2;
	}

	if (!vinc->ptn_cfg.ptn_en) {
		ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SENSOR], core, init, 1);
	}

	clear_bit(VIN_LPM, &cap->state);
	vinc->hflip = inst->hflip;
	vinc->vflip = inst->vflip;

	return ret;
}
```

`__vin_sensor_setup_link()` 和 `__csi_isp_setup_link()` 是驱动内部启停 link 的函数：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c */

static int __vin_sensor_setup_link(struct vin_core *vinc,
				   struct modules_config *module,
				   int i, int en)
{
	struct vin_md *vind = dev_get_drvdata(vinc->v4l2_dev->dev);
	struct v4l2_subdev *sensor = module->modules.sensor[i].sd;
	struct v4l2_subdev *subdev;
	struct media_link *link = NULL;
	int ret;

	if (vinc->mipi_sel != 0xff)
		subdev = vind->mipi[vinc->mipi_sel].sd;
	else
		subdev = vind->csi[vinc->csi_sel].sd;

	/* 找 sensor -> mipi/csi link */
	...

	if (en)
		ret = media_entity_setup_link(link, MEDIA_LNK_FL_ENABLED);
	else
		ret = __media_entity_setup_link(link, 0);

	return ret ? -1 : 0;
}

static int __csi_isp_setup_link(struct vin_core *vinc, int en)
{
	struct vin_md *vind = dev_get_drvdata(vinc->v4l2_dev->dev);
	struct v4l2_subdev *csi, *isp;
	struct media_link *link = NULL;
	int ret;

	csi = vind->csi[vinc->csi_sel].sd;
	isp = vind->isp[vinc->isp_sel].sd;

	link = media_entity_find_link(&csi->entity.pads[CSI_PAD_SOURCE],
				      &isp->entity.pads[ISP_PAD_SINK]);

	if (en)
		ret = media_entity_setup_link(link, MEDIA_LNK_FL_ENABLED);
	else
		ret = __media_entity_setup_link(link, 0);

	return ret ? -1 : 0;
}
```

注意这里的 link 操作是 video ioctl 路径中由驱动执行，不是用户通过 media controller 自主执行。

---

## 9. VIDIOC_S_FMT 由 video node 向整条 pipeline 下发格式

主线 MC-centric 模型中，用户态应该逐级配置 subdev pad 格式。全志则是用户态对 `/dev/videoX` 调 `VIDIOC_S_FMT`，然后驱动内部传播到 pipeline。

入口：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c */

static int vidioc_s_fmt_vid_cap_mplane(struct file *file, void *priv,
					struct v4l2_format *f)
{
	struct vin_core *vinc = video_drvdata(file);
	int ret;

	ret =  __vin_set_fmt(vinc, f);
	return ret;
}
```

核心配置逻辑：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c */

static int __vin_set_fmt(struct vin_core *vinc, struct v4l2_format *f)
{
	struct vin_vid_cap *cap = &vinc->vid_cap;
	struct sensor_win_size win_cfg;
	struct v4l2_mbus_framefmt mf;
	struct vin_fmt *ffmt = NULL;
	int ret = 0;

	if (vin_streaming(cap))
		return -EBUSY;

	ffmt = vin_find_format(&f->fmt.pix_mp.pixelformat, NULL,
					VIN_FMT_ALL, -1, false);
	if (ffmt == NULL)
		return -EINVAL;

	cap->frame.fmt = *ffmt;
	mf.width = f->fmt.pix_mp.width;
	mf.height = f->fmt.pix_mp.height;
	mf.field = f->fmt.pix_mp.field;
	mf.colorspace = f->fmt.pix_mp.colorspace;
	mf.code = ffmt->mbus_code;

	ret = vin_pipeline_try_format(vinc, &mf, &ffmt, true);
	if (ret < 0)
		return -EINVAL;

	cap->frame.fmt.mbus_code = mf.code;

	vin_pipeline_set_mbus_config(vinc);

	memset(&win_cfg, 0, sizeof(struct sensor_win_size));
	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SENSOR], core, ioctl,
			     GET_CURRENT_WIN_CFG, &win_cfg);

	if (ret == 0) {
		struct v4l2_subdev_pad_config cfg;
		struct v4l2_subdev_selection sel;

		/* parser crop */
		cfg.try_crop.width = win_cfg.width;
		cfg.try_crop.height = win_cfg.height;
		cfg.try_crop.left = win_cfg.hoffset;
		cfg.try_crop.top = win_cfg.voffset;

		ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_CSI], pad,
					set_selection, &cfg, NULL);

		/* vipp crop */
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
}
```

再看 `vin_pipeline_try_format()`：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c */

static int vin_pipeline_try_format(struct vin_core *vinc,
				    struct v4l2_mbus_framefmt *tfmt,
				    struct vin_fmt **fmt_id,
				    bool set)
{
	struct v4l2_subdev_format sfmt;
	struct media_entity *me;
	struct media_entity_graph graph;
	int ret, i = 0, sd_ind;

	sfmt.format = *tfmt;
	sfmt.which = set ? V4L2_SUBDEV_FORMAT_ACTIVE : V4L2_SUBDEV_FORMAT_TRY;

	me = &vinc->vid_cap.subdev.entity;
	media_entity_graph_walk_start(&graph, me);
	while ((me = media_entity_graph_walk_next(&graph)) &&
		me != &vinc->vid_cap.subdev.entity) {

		sd = media_entity_to_v4l2_subdev(me);

		/* 只处理当前 pipe.sd[] 里的 subdev */
		if (sd != vinc->vid_cap.pipe.sd[sd_ind])
			continue;

		sfmt.pad = 0;
		ret = v4l2_subdev_call(sd, pad, set_fmt, NULL, &sfmt);
		if (ret)
			goto out;

		if (sd->grp_id == VIN_GRP_ID_ISP)
			sensor_isp_input(vinc->vid_cap.pipe.sd[VIN_IND_SENSOR],
					 &sfmt.format);

		if (sd->grp_id == VIN_GRP_ID_SCALER) {
			sfmt.format.width = tfmt->width;
			sfmt.format.height = tfmt->height;
		}

		if (me->pads[0].flags & MEDIA_PAD_FL_SINK) {
			sfmt.pad = me->num_pads - 1;
			ret = v4l2_subdev_call(sd, pad, set_fmt, NULL, &sfmt);
			if (ret)
				goto out;
		}
	}
}
```

这说明格式传播方式是：

```text
用户 VIDIOC_S_FMT(/dev/videoX)
  -> __vin_set_fmt()
  -> vin_pipeline_try_format()
  -> 遍历 pipe.sd[]
  -> 内核内部调用各 subdev .set_fmt()
```

而不是：

```text
用户 media-ctl -V sensor pad
用户 media-ctl -V mipi pad
用户 media-ctl -V csi pad
用户 media-ctl -V isp pad
用户 media-ctl -V scaler pad
```

---

## 10. STREAMON 由驱动按固定顺序启动所有 subdev

video node 的 `VIDIOC_STREAMON` 路径：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c */

static int vidioc_streamon(struct file *file, void *priv, enum v4l2_buf_type i)
{
	struct vin_core *vinc = video_drvdata(file);
	struct vin_vid_cap *cap = &vinc->vid_cap;
	int ret = 0;

	if (i != V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE)
		return -EINVAL;

	if (vin_streaming(cap))
		return -1;

	sensor_check_vblank(cap->pipe.sd[VIN_IND_SENSOR]);

	ret = vb2_ioctl_streamon(file, priv, i);
	if (ret)
		return ret;

	mutex_lock(&cap->vdev.entity.graph_obj.mdev->graph_mutex);
	vin_timer_init(cap->vinc);
	ret = vin_pipeline_call(cap->vinc, set_stream,
				&cap->pipe, cap->vinc->stream_idx);
	set_bit(VIN_STREAM, &cap->state);
	mutex_unlock(&cap->vdev.entity.graph_obj.mdev->graph_mutex);

	return ret;
}
```

真正的 pipeline stream 顺序在 `vin.c`：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c */

static int __vin_pipeline_s_stream(struct vin_pipeline *p, int on_idx)
{
	static const u8 seq[5][VIN_IND_MAX] = {
		/* close online */
		{ VIN_IND_CAPTURE, VIN_IND_SCALER, VIN_IND_ISP,
		  VIN_IND_TDM_RX, VIN_IND_CSI, VIN_IND_MIPI,
		  VIN_IND_SENSOR },

		/* close offline */
		{ VIN_IND_CAPTURE, VIN_IND_TDM_RX, VIN_IND_ISP,
		  VIN_IND_SCALER, VIN_IND_CSI, VIN_IND_MIPI,
		  VIN_IND_SENSOR },

		/* open */
		{ VIN_IND_TDM_RX, VIN_IND_MIPI, VIN_IND_ISP,
		  VIN_IND_SCALER, VIN_IND_CAPTURE, VIN_IND_CSI,
		  VIN_IND_SENSOR },

		{ VIN_IND_TDM_RX, VIN_IND_SENSOR, VIN_IND_MIPI,
		  VIN_IND_ISP, VIN_IND_SCALER, VIN_IND_CAPTURE,
		  VIN_IND_CSI },

		{ VIN_IND_MIPI, VIN_IND_SENSOR, VIN_IND_TDM_RX,
		  VIN_IND_ISP, VIN_IND_SCALER, VIN_IND_CAPTURE,
		  VIN_IND_CSI },
	};

	on = on_idx ? 1 : 0;

	for (i = 0; i < VIN_IND_ACTUATOR; i++) {
		unsigned int idx = seq[on_idx][i];
		if (!p->sd[idx] || !p->sd[idx]->entity.graph_obj.mdev)
			continue;
		ret = __vin_subdev_set_stream(p->sd[idx], idx, on);
		if (ret < 0 && ret != -ENODEV)
			goto error;
		usleep_range(100, 120);
	}

	return 0;
}
```

也就是说，用户态只对 `/dev/videoX` 做 `STREAMON`，驱动内部会按固定顺序调用：

```text
TDM/MIPI/ISP/Scaler/Capture/CSI/Sensor
```

或按不同模式选择另外的硬编码顺序。

这和主线 MC-centric 的“用户态先配置好所有 subdev，STREAMON 只启动已配置 pipeline”有明显差异。

---

## 11. video node 代理大量 sensor/ISP/TDM 私有控制

`vin_video.c` 中的 ioctl table：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c */

static const struct v4l2_ioctl_ops vin_ioctl_ops = {
	.vidioc_querycap = vidioc_querycap,
	.vidioc_enum_fmt_vid_cap_mplane = vidioc_enum_fmt_vid_cap_mplane,
	.vidioc_g_fmt_vid_cap_mplane = vidioc_g_fmt_vid_cap_mplane,
	.vidioc_try_fmt_vid_cap_mplane = vidioc_try_fmt_vid_cap_mplane,
	.vidioc_s_fmt_vid_cap_mplane = vidioc_s_fmt_vid_cap_mplane,
	.vidioc_reqbufs = vb2_ioctl_reqbufs,
	.vidioc_querybuf = vb2_ioctl_querybuf,
	.vidioc_qbuf = vb2_ioctl_qbuf,
	.vidioc_dqbuf = vb2_ioctl_dqbuf,
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

`vidioc_default = vin_param_handler` 接收大量私有 ioctl：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c */

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
	case VIDIOC_SET_STANDBY:
		ret = vidioc_set_standby(file, fh, param);
		break;
	case VIDIOC_SET_SENSOR_ISP_CFG:
		ret = vidioc_set_sensor_isp_cfg(file, fh, param);
		break;
	case VIDIOC_SET_TDM_SPEEDDN_CFG:
		ret = vidioc_set_tdm_speeddn_cfg(file, fh, param);
		break;
	case VIDIOC_SET_TDM_DEPTH:
		ret = vidioc_set_tdm_depth_cfg(file, fh, param);
		break;
	case VIDIOC_SET_D3DLBCRATIO:
		ret = vidioc_set_d3d_lbc_ratio(file, fh, param);
		break;
	case VIDIOC_SET_DMA_MERGE:
		ret = vidioc_set_dma_merge(file, fh, param);
		break;
	case VIDIOC_VIN_SET_INPUT_BIT_WIDTH:
		ret = vidioc_set_input_bit_width(file, fh, param);
		break;
	default:
		ret = -ENOTTY;
	}
}
```

这说明全志的用户态 API 是：

```text
/dev/videoX 标准 V4L2 ioctl
  + /dev/videoX 私有 VIDIOC_*
  + video node controls
  + 驱动内部转发到 sensor/isp/tdm subdev
```

不是主线式：

```text
/dev/mediaX 配 link
/dev/v4l-subdevX 配每级格式和参数
/dev/videoX 只负责 buffer 和最终采集
```

---

## 12. video node controls 也会转发到 ISP 或 sensor

`vin_s_ctrl()` 中，根据 sensor 是否使用 ISP，把控制请求转发到 ISP 或 sensor。

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c */

static int vin_s_ctrl(struct v4l2_ctrl *ctrl)
{
	struct vin_vid_cap *cap =
		container_of(ctrl->handler, struct vin_vid_cap, ctrl_handler);
	struct sensor_instance *inst = get_valid_sensor(cap->vinc);
	struct v4l2_subdev *sensor = cap->pipe.sd[VIN_IND_SENSOR];
	struct v4l2_subdev *flash = cap->pipe.sd[VIN_IND_FLASH];
	struct v4l2_subdev *act = cap->pipe.sd[VIN_IND_ACTUATOR];
	struct v4l2_subdev *isp = cap->pipe.sd[VIN_IND_ISP];
	struct v4l2_control c;

	c.id = ctrl->id;
	c.value = ctrl->val;

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
		switch (ctrl->id) {
		case V4L2_CID_FOCUS_ABSOLUTE:
			ret = v4l2_subdev_call(act, core, ioctl,
					       ACT_SET_CODE, &vcm_ctrl);
			break;
		case V4L2_CID_FLASH_LED_MODE:
			if (flash)
				ret = v4l2_s_ctrl(NULL, flash->ctrl_handler, &c);
			break;
		default:
			ret = v4l2_s_ctrl(NULL, sensor->ctrl_handler, &c);
			break;
		}
	}
	return ret;
}
```

这进一步说明全志的设计是“video node 统一代理控制”，而不是让应用直接控制各个 subdev。

---

## 13. 各 subdev 有 pad ops，但实现不完整、不足以作为主控制面

### 13.1 MIPI subdev

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c */

static const struct v4l2_subdev_pad_ops sunxi_mipi_subdev_pad_ops = {
	.get_fmt = sunxi_mipi_subdev_get_fmt,
	.set_fmt = sunxi_mipi_subdev_set_fmt,
};

static struct v4l2_subdev_ops sunxi_mipi_subdev_ops = {
	.video = &sunxi_mipi_subdev_video_ops,
	.pad = &sunxi_mipi_subdev_pad_ops,
};

static int __mipi_init_subdev(struct mipi_dev *mipi)
{
	v4l2_subdev_init(sd, &sunxi_mipi_subdev_ops);
	sd->grp_id = VIN_GRP_ID_MIPI;
	sd->flags |= V4L2_SUBDEV_FL_HAS_DEVNODE;
	snprintf(sd->name, sizeof(sd->name), "sunxi_mipi.%u", mipi->id);

	mipi->mipi_pads[MIPI_PAD_SINK].flags = MEDIA_PAD_FL_SINK;
	mipi->mipi_pads[MIPI_PAD_SOURCE].flags = MEDIA_PAD_FL_SOURCE;
	sd->entity.function = MEDIA_ENT_F_IO_V4L;

	ret = media_entity_pads_init(&sd->entity, MIPI_PAD_NUM, mipi->mipi_pads);
}
```

只有 `get_fmt/set_fmt`，没有 `enum_mbus_code`、`enum_frame_size`、`link_validate` 等主线常见能力。

### 13.2 CSI subdev

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-csi/sunxi_csi.c */

static const struct v4l2_subdev_pad_ops sunxi_csi_subdev_pad_ops = {
	.set_selection = sunxi_csi_subdev_set_selection,
	.get_fmt = sunxi_csi_subdev_get_fmt,
	.set_fmt = sunxi_csi_subdev_set_fmt,
};

static struct v4l2_subdev_ops sunxi_csi_subdev_ops = {
	.video = &sunxi_csi_subdev_video_ops,
	.pad = &sunxi_csi_subdev_pad_ops,
};

static int __csi_init_subdev(struct csi_dev *csi)
{
	v4l2_subdev_init(sd, &sunxi_csi_subdev_ops);
	sd->grp_id = VIN_GRP_ID_CSI;
	sd->flags |= V4L2_SUBDEV_FL_HAS_DEVNODE;
	snprintf(sd->name, sizeof(sd->name), "sunxi_csi.%u", csi->id);

	csi->csi_pads[CSI_PAD_SINK].flags = MEDIA_PAD_FL_SINK;
	csi->csi_pads[CSI_PAD_SOURCE].flags = MEDIA_PAD_FL_SOURCE;
	sd->entity.function = MEDIA_ENT_F_IO_V4L;
}
```

CSI 比 MIPI 多了 `set_selection`，但同样不是完整的主线 MC-centric 控制面。

### 13.3 ISP subdev

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c */

static const struct v4l2_subdev_core_ops sunxi_isp_subdev_core_ops = {
	.init = sunxi_isp_subdev_init,
	.ioctl = sunxi_isp_subdev_ioctl,
#ifdef CONFIG_COMPAT
	.compat_ioctl32 = isp_compat_ioctl32,
#endif
#if !defined CONFIG_ISP_SERVER_MELIS
	.subscribe_event = sunxi_isp_subscribe_event,
	.unsubscribe_event = v4l2_event_subdev_unsubscribe,
#endif
};

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

ISP 也只有 `get_fmt/set_fmt`，关键 ISP 参数靠私有 ioctl：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c */

static long sunxi_isp_subdev_ioctl(struct v4l2_subdev *sd,
				   unsigned int cmd, void *arg)
{
	switch (cmd) {
	case VIDIOC_VIN_ISP_LOAD_REG:
		ret = __isp_set_load_reg(sd, (struct isp_table_reg_map *)arg);
		break;
	case VIDIOC_VIN_ISP_SYNC_DEBUG_INFO:
		ret = __isp_sync_debug_info(sd, (struct isp_debug_info *)arg);
		break;
	default:
		return -ENOIOCTLCMD;
	}

	return ret;
}
```

这说明全志 ISP 不是“标准 subdev pad + controls 完整建模”，而是：

```text
少量标准 subdev ops
  + 大量私有 ISP ioctl
  + 驱动内部参数表 load/save
```

---

## 14. ISP：不是主线形式，而是混合式 BSP ISP

全志 ISP 的形式可以概括为：

```text
V4L2 subdev 外壳
  + H3A/stat 统计节点
  + 私有 ISP 参数表 ioctl
  + video node 代理控制
  + 可选 Melis/RTOS ISP Server
```

### 14.1 非 Melis 模式：Linux 侧 ISP + H3A 统计 subdev

在 `CONFIG_ISP_SERVER_MELIS` 未开启时，会注册统计 subdev：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c */

for (i = 0; i < VIN_MAX_ISP; i++) {
	vind->isp[i].sd = sunxi_isp_get_subdev(i);
	ret = v4l2_device_register_subdev(&vind->v4l2_dev,
						vind->isp[i].sd);

#if !defined CONFIG_ISP_SERVER_MELIS
	vind->stat[i].id = i;
	vind->stat[i].sd = sunxi_stat_get_subdev(i);
	ret = v4l2_device_register_subdev(&vind->v4l2_dev,
						vind->stat[i].sd);
#endif
}
```

统计 subdev 初始化：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-stat/vin_h3a.c */

int vin_isp_h3a_init(struct isp_dev *isp)
{
	struct isp_stat *stat = &isp->h3a_stat;

	stat->sd.grp_id = VIN_GRP_ID_STAT;
	stat->sd.flags |= V4L2_SUBDEV_FL_HAS_EVENTS |
			  V4L2_SUBDEV_FL_HAS_DEVNODE;
	stat->sd.entity.function = MEDIA_ENT_F_PROC_VIDEO_STATISTICS;

	return media_entity_pads_init(&stat->sd.entity, 1, &stat->pad);
}
```

这部分看起来接近主线：有独立统计节点、有 event、有 devnode。但仍然不是完整主线形式，因为 ISP 参数和 pipeline 配置仍由全志私有 API 与 video node 代理完成。

### 14.2 Melis/RTOS 模式：统计 subdev 被绕开

如果定义 `CONFIG_ISP_SERVER_MELIS`，`vin.c` 不会注册 `sunxi_stat_get_subdev()`，ISP 统计和 3A 更偏向 RPMsg/RPBuf 与 RTOS 交互。源码中有明显条件编译：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c */

#ifdef CONFIG_ISP_SERVER_MELIS
extern struct rpmsg_driver rpmsg_vin_client;
#endif

...

#ifdef CONFIG_ISP_SERVER_MELIS
register_rpmsg_driver(&rpmsg_vin_client);
#endif
```

ISP probe 中也有 Melis/RTOS 相关路径：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c */

#if defined CONFIG_ISP_SERVER_MELIS
	isp->first_init_server = 1;
	if (isp->id == 0 || isp->id == 1 || isp->id == 2) {
		isp->controller = rpbuf_get_controller_by_of_node(np, 0);
		if (!isp->controller)
			vin_warn("isp%d cannot get rpbuf controller\n", isp->id);
	}
#else
	isp->first_init_server = 0;
#endif
```

所以 ISP 有两种 BSP 运行形态：

| 模式 | 条件 | 统计/3A 位置 | 形态 |
|---|---|---|---|
| Linux ISP/H3A | `CONFIG_ISP_SERVER_MELIS` 未定义 | Linux 内核 + 用户态库 | 接近主线但仍私有化 |
| Melis/RTOS ISP Server | `CONFIG_ISP_SERVER_MELIS=y` | RTOS/Melis + RPMsg/RPBuf | 明显非主线 |

---

## 15. 为什么主线 media-ctl / subdev API 很难控制这套驱动

### 15.1 link 改了，硬件路由不一定改

`link_notify` 不更新硬件，不更新 `vinc->*_sel`，不重建 pipeline。

### 15.2 subdev 格式改了，可能被 video node 覆盖

`VIDIOC_S_FMT(/dev/videoX)` 会重新走 `vin_pipeline_try_format()`，内部调用各 subdev `set_fmt`。所以你手工用 `media-ctl -V` 设置的格式可能被下一次 video node `S_FMT` 覆盖。

### 15.3 STREAMON 不信任用户态完整 pipeline，而信任内部 `pipe.sd[]`

`STREAMON` 调用的是：

```text
vin_pipeline_call(cap->vinc, set_stream, &cap->pipe, cap->vinc->stream_idx)
```

`cap->pipe` 来自 `vin_md_prepare_pipeline()`，而它基于驱动默认 link 和 `grp_id` 分类。

### 15.4 私有能力无法用标准 MC API 表达

例如：

- `VIDIOC_SET_TOP_CLK`
- `VIDIOC_ISP_DEBUG`
- `VIDIOC_SET_PARSER_FPS`
- `VIDIOC_SET_TDM_DEPTH`
- `VIDIOC_SET_D3DLBCRATIO`
- `VIDIOC_SET_DMA_MERGE`
- `GET_CURRENT_WIN_CFG`
- `GET_COMBO_SYNC_CODE`
- `SET_SENSOR_OUTPUT_BIT_WIDTH`

这些都不是通用 media controller API 能表达的 pipeline 配置。

### 15.5 子设备 ops 不完整

很多内部 subdev 只实现了 `get_fmt/set_fmt`，缺少主线 MC-centric 常见的枚举、selection、link validate 等完整接口。

---

## 16. 与主线 MC-centric 的核心差异表

| 维度 | 主线 MC-centric | 全志 sunxi-vin |
|---|---|---|
| 拓扑描述 | DT endpoint graph + MC graph | DTS 中 `vinc*_sel` 固定选择 |
| link 配置 | 用户态 `MEDIA_IOC_SETUP_LINK` | probe/s_input/close 中驱动内部 setup |
| 格式配置 | 用户态逐级配置 subdev pad | video node `S_FMT` 内部传播 |
| stream 顺序 | driver 根据已配置 pipeline 启动 | `seq[]` 硬编码顺序 |
| control 入口 | subdev controls + video controls 分层 | video node 代理 ISP/sensor/flash/actuator |
| ISP 参数 | 标准 controls/events/buffer API 尽量建模 | 私有 ioctl 加载 ISP 参数表 |
| 用户态工具 | `media-ctl`、`v4l2-ctl`、libcamera | 全志 demo、私有库、`/dev/videoX` 私有 ioctl |
| 动态拓扑 | 可设计为用户态选择 | 基本由 DTS 和驱动内部状态决定 |
| 主线友好度 | 高 | 低 |

---

## 17. 典型使用流程对比

### 17.1 主线 MC-centric 流程

```bash
media-ctl -p

media-ctl -l "'sensor':0->'mipi':0[1]"
media-ctl -l "'mipi':1->'csi':0[1]"
media-ctl -l "'csi':1->'isp':0[1]"
media-ctl -l "'isp':1->'scaler':0[1]"
media-ctl -l "'scaler':1->'capture':0[1]"

media-ctl -V "'sensor':0[fmt:SBGGR10_1X10/1920x1080]"
media-ctl -V "'mipi':0[fmt:SBGGR10_1X10/1920x1080]"
media-ctl -V "'csi':0[fmt:SBGGR10_1X10/1920x1080]"
media-ctl -V "'isp':0[fmt:SBGGR10_1X10/1920x1080]"
media-ctl -V "'isp':1[fmt:YUYV8_2X8/1920x1080]"

v4l2-ctl -d /dev/video0 --set-fmt-video=width=1920,height=1080,pixelformat=NV12
v4l2-ctl -d /dev/video0 --stream-mmap
```

### 17.2 全志 sunxi-vin 更真实的流程

```bash
# 1. DTS 决定 pipeline
# vinc0_csi_sel = <0>;
# vinc0_mipi_sel = <0>;
# vinc0_isp_sel = <0>;
# vinc0_tdm_rx_sel = <0>;
# vinc0_rear_sensor_sel = <0>;

# 2. 打开 video node
v4l2-ctl -d /dev/video0 --set-input 0

# 3. 对 video node 设置输出格式
v4l2-ctl -d /dev/video0 --set-fmt-video=width=1920,height=1080,pixelformat=NV12

# 4. 通过 video node 私有 ioctl / controls 设置额外功能
# 例如 ISP debug、TDM depth、D3D LBC ratio 等，全志应用通常直接 ioctl

# 5. 开始采集
v4l2-ctl -d /dev/video0 --stream-mmap
```

---

## 18. 对你的 V853/100ask 配置的判断

从你当前工程上下文看，`sun8iw21p1.dtsi` 中存在 V853 相关节点：

- `e907_rproc` 存在，但 `status = "disabled"`
- `msgbox` 存在，但 `status = "disabled"`
- `e907_standby` 存在，但 `status = "disabled"`
- VIN/ISP/MIPI/CSI/VIPP 节点由 Linux 侧驱动管理

如果你的 `device/config/chips/v853/configs/100ask/linux/config-4.9` 中：

```text
CONFIG_ISP_SERVER_MELIS is not set
CONFIG_VIN_INIT_MELIS is not set
CONFIG_RPMSG_CTRL is not set
CONFIG_RPBUF_CONTROLLER_SUNXI is not set
```

则可判断当前是 **Linux 独占 VIN/ISP 模式**，不是 RTOS+Linux ISP Server 模式。

Linux 独占模式下：

```text
Linux A7
  -> sunxi-vin
  -> sunxi_isp
  -> vin_h3a/stat
  -> 用户态 3A/ISP 库
  -> ISP 硬件
```

RTOS+Linux 模式下才会变成：

```text
Linux A7
  -> video/buffer/app
  -> RPMsg/RPBuf

RTOS/Melis
  -> ISP Server
  -> 3A
  -> sensor/ISP 参数控制
```

---

## 19. 总结

`sunxi-vin` 的 Media Controller 不是假的，但它的 MC 不是主控制面。

它使用 MC/subdev 的地方：

- 创建 entities、pads、links，方便描述内部拓扑
- 注册 `/dev/v4l-subdevX`
- 内部遍历 graph，找到当前 pipeline
- 内部调用各 subdev 的 `set_fmt`、`s_stream`、`ioctl`
- 暴露部分统计、事件、控制接口

它不符合主线 MC-centric 的地方：

- DTS 中 `vinc*_sel` 固定 pipeline，而不是用户态动态选择
- `MEDIA_IOC_SETUP_LINK` 不会更新硬件 mux 和 `vinc->*_sel`
- `link_setup` 基本空实现
- `VIDIOC_S_FMT(/dev/videoX)` 内部覆盖并传播 subdev 格式
- `VIDIOC_STREAMON(/dev/videoX)` 内部按硬编码顺序启动整条链路
- 大量 ISP/sensor/TDM/clock/3A 功能走私有 ioctl 和 video node 代理
- ISP 是 BSP 混合式实现，不是完整主线 ISP pipeline handler

最简洁的判断：

```text
全志 sunxi-vin 是 video-centric BSP 驱动。
Media Controller 在这里主要是内部拓扑描述和辅助遍历机制。
用户态几乎不能按主线 MC API 完整控制它，因为真正的 pipeline 状态和硬件路由由 DTS、vinc->*_sel、pipe.sd[] 和 video node 私有流程决定。
```

