# GStreamer package analysis with sunxi CSI
_Exported on 2026/4/17 at GMT+8 14:02:05 from Cursor (2.6.21)_

---

**User**

@buildroot/buildroot-202205/package/gstreamer1 请基于这个gstreamer包，帮我分析一下
0002-add-sunxi-csi-merge.patch
结合sunxi-vin驱动bsp/drivers/vinbsp/drivers/vin，详细分析一下
1、相比标准gst采集路径，做了哪些改动以及为什么要做改动?
（参考：codex给我说最核心的私有扩展：VIDIOC_SET_DMA_MERGE + 强制 S_INPUT + S_PARM）
2、再分析一下为什么 DISPLAY=:0 gst-launch-1.0 v4l2src device=/dev/video1 en-awisp=1 en-largemode=1 ! video/x-raw,format=NV12,width=4208,height=3120,framerate=24/1 ! xvimagesink可以正常采集，cheese程序无法正常采集

---

**Cursor**

下面我基于你给的两个部分一起分析：

- GStreamer patch：`buildroot/buildroot-202205/package/gstreamer1/gst1-plugins-good/0002-add-sunxi-csi-merge.patch`
- 以及相关补丁：`0004-add-sunxi-csi-merge-config.patch`、`1.18/0001-gst-good-support-vin.patch`
- sunxi-vin BSP 驱动：`bsp/drivers/vin/...`

---

## 一、先说结论

你提到的“最核心的私有扩展：`VIDIOC_SET_DMA_MERGE` + 强制 `S_INPUT` + `S_PARM`”，这个判断是对的，而且从代码上看确实就是为了**把标准 V4L2/GStreamer 的通用采集流程，改造成适配 sunxi-vin 大图拼接 / AWISP / merge 模式的专用初始化流程**。

它和标准 gst 采集路径相比，核心改动是：

1. **在 open 后立刻下发私有 ioctl：`VIDIOC_SET_DMA_MERGE`**
   - 作用：打开 sunxi-vin 的 DMA merge 模式，让两个 video 通道按 BSP 逻辑协同工作。
   - 原因：标准 V4L2 没有这个概念，sunxi 的大图/拼接模式是私有扩展。

2. **强制 `VIDIOC_S_INPUT`**
   - 作用：强制完成 vin pipeline 的 sensor/csi/isp/scaler link 建立和 open/init。
   - 原因：sunxi-vin 驱动里很多后续动作依赖先 `S_INPUT`，否则 pipeline 还没真正搭起来。

3. **强制 `VIDIOC_S_PARM`，并把 `capturemode=V4L2_MODE_VIDEO`，以及在 merge 模式下通过 `reserved[2]=3` 传“大图模式”**
   - 作用：通知 sensor/csi/isp/scaler 当前进入 video 流工作模式，并把 `large_image` / merge 参数传进整个 vin 子链路。
   - 原因：sunxi 驱动不是只靠 `S_FMT` 就能把大图模式准备好，它把很多模式切换塞进了 `S_PARM`。

4. **在 GStreamer 里新增 `en-awisp`、`en-largemode` 属性，并在 STREAMON/OFF 时显式拉起/关闭 AWIspApi**
   - 作用：不仅是 V4L2 采集，还把 AW 的用户态 ISP 控制流程绑定进 `v4l2src`。
   - 原因：标准 `v4l2src` 并不会帮你启动 Allwinner 私有 AWISP 服务。

因此，本质上这套补丁不是“优化标准路径”，而是**把 `v4l2src` 变成一个会主动配合 sunxi 私有 camera BSP 完成初始化的专用采集前端**。

---

# 二、相比标准 gst 采集路径，做了哪些改动，以及为什么要改

---

## 1. 标准 GStreamer 的 `v4l2src` 是怎么干的

标准路径里，`v4l2src` 主要做的是：

- `open(/dev/videoX)`
- `QUERYCAP`
- 枚举 format / frame size / fps
- `S_FMT`
- `REQBUFS / QBUF`
- `STREAMON`

它**通常不会在 open 阶段强制**做下面这些事：

- 不会默认发私有 ioctl
- 不会默认强制 `S_INPUT`
- 不会默认强制 `S_PARM`
- 更不会帮你启动某个厂商私有的 userspace ISP 库

所以标准 `v4l2src` 假设：
> 设备是一个“标准 V4L2 capture 设备”，只要 `S_FMT + STREAMON` 就能工作。

但 sunxi-vin BSP 并不完全符合这个“纯标准设备”假设。

---

## 2. `0002-add-sunxi-csi-merge.patch` 的直接改动

补丁里最直接的修改在 `gst_v4l2_open()`：

```1:33:buildroot/buildroot-202205/package/gstreamer1/gst1-plugins-good/0002-add-sunxi-csi-merge.patch
+#define VIDIOC_SET_DMA_MERGE \
+	_IOWR('V', BASE_VIDIOC_PRIVATE + 50, unsigned char)
...
+  char dma_merge_mode = 1;
...
+  if (-1 == ioctl(v4l2object->video_fd, VIDIOC_SET_DMA_MERGE, &dma_merge_mode)) {
+      GST_ERROR_OBJECT(v4l2object->dbg_obj,"VIDIOC_SET_DMA_MERGE error!\n");
+      return -1;
+  }
+
   inp.index = sel;
   if (-1 == ioctl(v4l2object->video_fd, VIDIOC_S_INPUT, &inp)) {
       GST_ERROR_OBJECT(v4l2object->dbg_obj,"VIDIOC_S_INPUT %d error!\n", sel);
```

也就是说：  
**设备一打开，就先做 merge，再做 input select。**

---

## 3. `0004-add-sunxi-csi-merge-config.patch` 进一步把它做成“可配置的大图模式”

后续补丁又把逻辑补强了：

```1:67:buildroot/buildroot-202205/package/gstreamer1/gst1-plugins-good/0004-add-sunxi-csi-merge-config.patch
+  g_object_class_install_property (gobject_class, PROP_ENABLE_LARGEMODE,
+      g_param_spec_boolean("en-largemode", "Enable AWISP using largemode",
...
+  if (v4l2object->use_large_image_mode) {
+    GST_INFO_OBJECT (v4l2object->dbg_obj,"VIDIOC_SET_DMA_MERGE[%d] start\n", dma_merge_mode);
+    if (-1 == ioctl(v4l2object->video_fd, VIDIOC_SET_DMA_MERGE, &dma_merge_mode)) {
+        GST_ERROR_OBJECT(v4l2object->dbg_obj,"VIDIOC_SET_DMA_MERGE error!");
+        goto error;
+    }
+  }
...
+  memset (&parms, 0x00, sizeof (struct v4l2_streamparm));
+  parms.type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
+  parms.parm.capture.timeperframe.numerator = 1;
+  parms.parm.capture.timeperframe.denominator = 30;
+  parms.parm.capture.capturemode = V4L2_MODE_VIDEO;
...
+  if (-1 == ioctl(v4l2object->video_fd, VIDIOC_S_PARM, &parms)) {
+    GST_ERROR_OBJECT(v4l2object->dbg_obj,"VIDIOC_S_PARM error!\n");
+    goto error;
+  }
```

这说明 sunxi 的 patch 作者已经发现：

- 光 `SET_DMA_MERGE + S_INPUT` 还不够
- 还要补一个 `S_PARM`
- 并且 `capturemode` 必须显式给到 `VIDEO`

---

## 4. 这个私有 ioctl 在驱动里确实存在

驱动侧在 `vin_param_handler()` 里接收了这个 ioctl：

```3520:3561:bsp/drivers/vin/vin-video/vin_video.c
static long vin_param_handler(struct file *file, void *priv,
			      bool valid_prio, unsigned int cmd, void *param)
{
...
	case VIDIOC_SET_DMA_MERGE:
		ret = vidioc_set_dma_merge(file, fh, param);
		break;
...
}
```

对应实现：

```3068:3083:bsp/drivers/vin/vin-video/vin_video.c
static int vidioc_set_dma_merge(struct file *file, struct v4l2_fh *fh,
			unsigned char *dma_merge)
{
	struct vin_core *vinc = video_drvdata(file);
	__maybe_unused struct vin_core *vinc_bind = NULL;

	vinc->dma_merge_mode = *dma_merge;

	if (vinc->dma_merge_mode == 1) {
		if (vinc->id % 4 == 1 && vin_core_gbl[vinc->id - 1]) {
			vinc_bind = vin_core_gbl[vinc->id - 1];
			vinc_bind->dma_merge_mode = *dma_merge;
		}
	}
	return 0;
}
```

### 这里说明了什么？

`dma_merge_mode=1` 后，不只是当前 video node 生效，还会把**绑定的另一条 vin 通道**也一起置位。  
而且条件是：

- 当前节点 `vinc->id % 4 == 1`
- 绑定节点是 `id - 1`

这基本就说明：
- `/dev/video1` 是主入口
- `/dev/video0` 是被配对的另一路
- merge 模式下其实是 **video1 + video0 联动**

这也正好解释了你命令里为什么用的是 `/dev/video1`。

---

## 5. 为什么必须强制 `S_INPUT`

驱动里的 `vidioc_s_input()` 不是简单切个 input index，它实际做了**整条 pipeline 的搭建和初始化**：

```2489:2584:bsp/drivers/vin/vin-video/vin_video.c
static int __vin_s_input(struct vin_core *vinc, unsigned int i)
{
...
	if (__vin_sensor_setup_link(vinc, module, valid_idx, 1) < 0) {
		vin_err("sensor setup link failed\n");
		return -EINVAL;
	}
	if (__csi_isp_setup_link(vinc, 1) < 0) {
		vin_err("csi&isp setup link failed\n");
		return -EINVAL;
	}
...
	ret = vin_pipeline_call(vinc, open, &cap->pipe, &cap->vdev.entity, true);
...
	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_ISP], core, init, 1);
...
	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SCALER], core, init, 1);
...
	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SENSOR], core, init, 1);
...
}
```

### 这意味着：

对 sunxi-vin 来说，`S_INPUT` 的语义远远超出标准 V4L2 的“切输入源”：

它实际上会：

- 建立 sensor link
- 建立 csi/isp link
- open pipeline
- init ISP
- init SCALER
- init SENSOR

而且在 merge 模式下，它还会把**绑定通道一起做**：

```2460:2474:bsp/drivers/vin/vin-video/vin_video.c
static int vidioc_s_input(struct file *file, void *priv, unsigned int i)
{
...
	if (vinc->dma_merge_mode == 1) {
		if (vinc->id % 4 == 1 && vin_core_gbl[vinc->id - 1]) {
			vinc_bind = vin_core_gbl[vinc->id - 1];
			ret = __vin_s_input(vinc_bind, i);
...
	ret = __vin_s_input(vinc, i);
```

### 所以为什么 GStreamer 要强制 `S_INPUT`？

因为标准 `v4l2src` 不一定会在“恰当时机”调用 `S_INPUT`，或者有些应用根本不调。  
但这个 BSP 驱动**要求你先把 input 选好，才能真正把 pipeline 拉起来**。  
不这么做，后面的 `S_PARM/S_FMT/STREAMON` 可能都是在“半初始化状态”下执行。

---

## 6. 为什么必须强制 `S_PARM`

这是最容易被忽略、但实际上非常关键的一点。

驱动里的 `__vin_s_parm()` 做的事非常多：

```2530:2576:bsp/drivers/vin/vin-video/vin_video.c
static int __vin_s_parm(struct vin_core *vinc, struct v4l2_streamparm *parms)
{
...
	if (parms->parm.capture.capturemode != V4L2_MODE_VIDEO &&
	    parms->parm.capture.capturemode != V4L2_MODE_IMAGE &&
	    parms->parm.capture.capturemode != V4L2_MODE_PREVIEW) {
		parms->parm.capture.capturemode = V4L2_MODE_PREVIEW;
	}

	if (vinc->dma_merge_mode == 1)
		parms->parm.capture.reserved[2] = 3;
...
	cap->capture_mode = parms->parm.capture.capturemode;
	vinc->large_image = parms->parm.capture.reserved[2];
...
	ret = sensor_s_parm(cap->pipe.sd[VIN_IND_SENSOR], parms);
...
	ret = sunxi_csi_subdev_s_parm(cap->pipe.sd[VIN_IND_CSI], parms);
...
	ret = sunxi_isp_s_parm(cap->pipe.sd[VIN_IND_ISP], parms);
...
	ret = sunxi_scaler_subdev_s_parm(cap->pipe.sd[VIN_IND_SCALER], parms);
...
}
```

### 这里的关键点有两个：

#### 6.1 `capturemode` 决定当前采集工作模式
它会写到：

- `cap->capture_mode`

驱动后续很多逻辑会依赖这个 mode，例如 image / video / preview 行为不同。

#### 6.2 merge 模式会强行设置 `reserved[2] = 3`
也就是：

- `vinc->dma_merge_mode == 1` 时
- 驱动直接把 `parms->parm.capture.reserved[2] = 3`
- 然后 `vinc->large_image = reserved[2]`

这说明 **sunxi 把“大图模式/merge 模式”的另一个关键开关，藏在 `S_PARM.reserved[2]` 里了。**

---

## 7. `large_image == 3` 在 scaler 里真的会触发特殊逻辑

scaler 侧能看到 `large_image` 的特殊处理：

```768:827:bsp/drivers/vin/vin-vipp/sunxi_scaler.c
		if (scaler->large_image == 3) {
			vin_log(VIN_LOG_SCALER, "vipp%d before change crop: left = %d, top = %d, w = %d, h = %d\n",
...
			if (scaler->id % 4 == 0)
				crop.hor = scaler->crop.active.left;
			else
				crop.hor = vin_set_large_overlayer(scaler->crop.active.width);

			crop.width = scaler->crop.active.width/2;
			scaler_size.sc_width = scaler->para.width/2;
			scaler->para.width /= 2;
...
		}
```

### 这个逻辑说明：

在 `large_image == 3` 时：

- 每个 scaler 不再处理整幅图
- 而是处理**半幅宽度**
- 不同通道的 crop 起点不同
- 然后通过 overlap / overlay 逻辑拼接

这就坐实了：

> `VIDIOC_SET_DMA_MERGE + S_PARM(reserved[2]=3)`  
> 本质上是在告诉 BSP：进入双通道大图拼接采集模式。

---

## 8. `S_FMT` 也因为 merge 模式变成“双通道联动”

驱动 `vidioc_s_fmt_vid_cap_mplane()` 里：

```1272:1290:bsp/drivers/vin/vin-video/vin_video.c
static int vidioc_s_fmt_vid_cap_mplane(struct file *file, void *priv,
				struct v4l2_format *f)
{
...
	if (vinc->dma_merge_mode == 1) {
		if (vinc->id % 4 == 1 && vin_core_gbl[vinc->id - 1]) {
			vinc_bind = vin_core_gbl[vinc->id - 1];
			ret = __vin_set_fmt(vinc_bind, f);
...
	ret = __vin_set_fmt(vinc, f);
```

也就是说 merge 模式下：

- `S_FMT(video1)` 时
- 实际也会同步给 `video0`

这也是为什么标准应用如果没有先正确进入 merge 模式，会导致格式协商和内部真实 pipeline 状态不一致。

---

## 9. AWISP 也是专门补进去的，不是标准 gst 行为

`1.18/0001-gst-good-support-vin.patch` 里新增了 `en-awisp`、`en-largemode`，而且在 `streamon` 时显式调用 AWIspApi：

```43:84:buildroot/buildroot-202205/package/gstreamer1/gst1-plugins-good/1.18/0001-gst-good-support-vin.patch
+      if (obj->enable_awisp) {
+        AWIspApi *isp = CreateAWIspApi();
+        if(isp) {
+          obj->isp = (void* )isp;
+          isp->ispApiInit();
+          obj->isp_id = isp->ispGetIspId(obj->dev_id);
+
+          /* large isp image mode settings*/
+          if(obj->use_large_image_mode) {
+            if(isp->ispSetIspLargeImage(obj->isp_id) < 0) {
+              GST_ERROR_OBJECT(pool, "set isp stitch err");
+              goto stream_on;
+            }
+            if(isp->ispStart(obj->isp_id - 1) < 0) {
+              GST_ERROR_OBJECT (pool, "Fail to start isp!");
+              goto stream_on;
+            }
+          }
+
+          if(isp->ispStart(obj->isp_id) < 0) {
+            GST_ERROR_OBJECT (pool, "Fail to start isp!");
+            goto stream_on;
+          }
+        }
+      }
```

这说明在 large image 模式下：

- 不只是 V4L2 驱动要 merge
- AWISP 也要进入 `ispSetIspLargeImage()`
- 甚至要启动 `isp_id - 1` 和 `isp_id` 两个 ISP 实例

这和内核里“video1 联动 video0”的逻辑完全一致。

---

## 10. 所以，相比标准 gst 路径，改动本质是什么？

一句话概括：

> 把标准 `v4l2src` 从“只会按通用 V4L2 规则采集”的插件，改成“懂 sunxi-vin 大图拼接/AWISP 初始化顺序”的厂商定制插件。

### 核心新增步骤
标准路径：
- open
- S_FMT
- STREAMON

sunxi 定制路径：
- open
- `VIDIOC_SET_DMA_MERGE`
- `VIDIOC_S_INPUT`
- `VIDIOC_S_PARM`（带 `capturemode=VIDEO`，并经驱动转成 `large_image=3`）
- `S_FMT`（联动双通道）
- `STREAMON`
- 启动 AWISP / large image ISP

### 为什么必须这样做
因为 BSP 驱动把很多关键模式切换都放在了：

- 私有 ioctl
- `S_INPUT`
- `S_PARM`
- userspace AWIspApi

而不是完全放在标准 `S_FMT/REQBUFS/STREAMON` 内。

---

# 三、为什么 `gst-launch-1.0 ... v4l2src ... xvimagesink` 能正常，而 cheese 不行

你的命令是：

```bash
DISPLAY=:0 gst-launch-1.0 v4l2src device=/dev/video1 en-awisp=1 en-largemode=1 \
! video/x-raw,format=NV12,width=4208,height=3120,framerate=24/1 ! xvimagesink
```

这个能正常，本质原因是：

## 1. 你这个命令显式触发了 sunxi 私有初始化路径

因为你用了：

- `device=/dev/video1`
- `en-awisp=1`
- `en-largemode=1`

所以定制过的 `v4l2src` 会执行：

1. 识别 `/dev/video1`，提取 `dev_id`
2. `VIDIOC_SET_DMA_MERGE`
3. `VIDIOC_S_INPUT`
4. `VIDIOC_S_PARM`
5. `STREAMON` 前启动 AWISP large image
6. 输出 NV12 4208x3120@24

整个 sunxi 大图模式所需的私有初始化都满足了。

---

## 2. cheese 大概率走的是“标准应用路径”，没有这些私有步骤

cheese 一般是基于 GStreamer / 或 GNOME camera stack 上层封装来采集，但它通常：

- 不会设置 `en-awisp=1`
- 不会设置 `en-largemode=1`
- 很可能不会强制触发你这个定制属性
- 更可能不会保证 `S_INPUT + S_PARM + 私有 merge ioctl` 按 BSP 期望顺序发生

也就是说，cheese 看到的是一个 `/dev/video1` 标准 V4L2 设备，但实际上它背后是一个**必须做私有初始化**才能工作的 sunxi 大图拼接节点。

所以 cheese 失败，不是因为它“不会采集 V4L2”，而是因为：

> 它不会按照 Allwinner BSP 这套私有约定来初始化这个节点。

---

## 3. 更具体地说，cheese 可能卡在哪些地方

### 3.1 没有 `en-largemode`
那就不会触发：

- `VIDIOC_SET_DMA_MERGE`
- AWISP large mode

结果：
- video1 没把 video0 联动起来
- scaler 不进入 `large_image==3`
- 内部只准备了一半链路或普通链路
- 4208x3120 这种模式无法成立

### 3.2 没有 `en-awisp`
那就不会调用：

- `ispSetIspLargeImage()`
- `ispStart(obj->isp_id - 1)`
- `ispStart(obj->isp_id)`

结果：
- 内核侧即使部分准备好了，用户态 ISP 服务没起来
- RAW/YUV 输出链路可能不完整
- 或能枚举到设备，但真正开流失败 / 黑屏 / 超时

### 3.3 没有按预期做 `S_INPUT`
sunxi 驱动里 `S_INPUT` 是“搭 pipeline”的关键步骤。  
如果 cheese 只做标准协商，不保证这个动作在正确时机做，可能出现：

- sensor 没 init 完
- csi/isp/scaler link 没连好
- `S_FMT` / `STREAMON` 表面成功，实际没数据

### 3.4 没有正确做 `S_PARM`
驱动里 merge 模式真正把 `large_image=3` 打进去，是在 `S_PARM`：

```2539:2557:bsp/drivers/vin/vin-video/vin_video.c
	if (vinc->dma_merge_mode == 1)
		parms->parm.capture.reserved[2] = 3;
...
	vinc->large_image = parms->parm.capture.reserved[2];
...
	ret = sunxi_scaler_subdev_s_parm(cap->pipe.sd[VIN_IND_SCALER], parms);
```

如果 cheese 没有这一段：
- scaler 不知道要半幅裁切+拼接
- 整个大图模式不会成立

---

## 4. 为什么 `xvimagesink` 正常，不代表 cheese 一定正常

`xvimagesink` 正常，只说明：

- `v4l2src` 已经把 sunxi 私有初始化做好了
- 输出到了一个 `video/x-raw, format=NV12` 流
- sink 只是负责显示

而 cheese 作为完整应用，还涉及：

- 设备枚举
- 自动选择 caps
- 可能偏好 MJPEG/YUY2 而不是你这个定制 NV12 大分辨率流
- 是否会设置 source 私有属性
- 是否能接受高分辨率/特定 framerate
- 是否会在预览和拍照之间切换 mode

所以两者不对等：

- `gst-launch` 是你手工精确指定“正确初始化方式”
- cheese 是通用应用，假定 camera 是“标准 UVC/标准 V4L2”

sunxi-vin 这个 `/dev/video1` 在 large merge 场景下，显然不是一个“完全标准”的 camera 节点。

---

# 四、把 cheese 失败归纳成一句最本质的话

## 本质原因
**cheese 把 `/dev/video1` 当作标准 V4L2 摄像头使用；但这个节点在 4208x3120 大图采集场景下，本质上是一个依赖 Allwinner 私有初始化序列的“复合采集节点”。**

必须满足：

1. `VIDIOC_SET_DMA_MERGE`
2. `VIDIOC_S_INPUT`
3. `VIDIOC_S_PARM(capturemode=VIDEO, large_image path)`
4. `AWIspApi large image start`
5. 正确 caps：`NV12 4208x3120 24fps`

你的 `gst-launch` 正好全满足；cheese 通常一个都不会主动满足。

---

# 五、再结合驱动细节，解释为什么 `/dev/video1` 特别关键

驱动里 merge 模式的联动条件一直是：

- 当前节点 `id % 4 == 1`
- 绑定节点是 `id - 1`

比如：

- `video1` 绑定 `video0`
- `video5` 绑定 `video4`
- ...

所以 `/dev/video1` 是 merge 入口节点，而不是随便一个 video 节点。

这意味着：

- 用 `/dev/video0` 可能不行
- 用 `/dev/video1` 但不设 merge，也不行
- 必须“以 video1 为主节点”进入 merge 模式

这也是 cheese 更容易失败的原因之一：  
通用应用未必知道该优先挑 `/dev/video1`，更不知道它是“主拼接节点”。

---

# 六、你可以怎么理解这套设计

可以把它想成两层：

## 标准层
V4L2 / GStreamer：
- open
- set format
- stream on

## Allwinner 私有层
sunxi-vin + AWISP：
- merge 双通道配对
- 建 pipeline link
- 设置 capture mode
- 设置 large image
- 启动双 ISP
- scaler 半幅裁切 + overlap 拼接

**标准层只是壳，真正让大图采集成立的是私有层。**

所以补丁本质上是在 `v4l2src` 里偷偷补上这层“厂商私有 bring-up 逻辑”。

---

# 七、最终回答你的两个问题

---

## 1）相比标准 gst 采集路径，做了哪些改动，以及为什么？

### 改动点
1. 新增私有 ioctl `VIDIOC_SET_DMA_MERGE`
2. 在 `open()` 后强制 `VIDIOC_S_INPUT`
3. 强制 `VIDIOC_S_PARM`
4. 新增 `en-awisp` / `en-largemode` 属性
5. 在 `STREAMON/OFF` 时集成 AWIspApi 的启动/退出
6. 支持 sunxi 扩展 raw format / bayer10/12 等格式
7. 在 large mode 下走双通道 + 双 ISP + scaler 半幅拼接逻辑

### 为什么要改
因为 sunxi-vin BSP 的大图采集并不是标准 V4L2 流程能直接覆盖的，它依赖：

- 私有 ioctl 使能 merge
- `S_INPUT` 建立完整 pipeline
- `S_PARM` 把 `capturemode` 和 `large_image` 传到 sensor/csi/isp/scaler
- AWISP userspace 控制 ISP large image 模式

如果不在 `v4l2src` 里补这些，标准 gst 只会把它当普通 camera 打开，最终采集失败或行为异常。

---

## 2）为什么 `gst-launch ...` 能正常采集，而 cheese 不行？

### `gst-launch` 能正常的原因
因为你显式用了：

- `device=/dev/video1`
- `en-awisp=1`
- `en-largemode=1`
- 指定 `NV12,width=4208,height=3120,framerate=24/1`

于是定制 `v4l2src` 会自动执行：
- `VIDIOC_SET_DMA_MERGE`
- `VIDIOC_S_INPUT`
- `VIDIOC_S_PARM`
- AWISP large image start
- 最终输出正确的大图 NV12 流

### cheese 不行的原因
cheese 是通用相机应用，它通常不会：

- 设置 `en-awisp`
- 设置 `en-largemode`
- 主动发 `VIDIOC_SET_DMA_MERGE`
- 保证 `S_INPUT + S_PARM` 按 BSP 需要的顺序执行
- 理解 `/dev/video1` 是 merge 主节点
- 自动选择你这个特定的 `4208x3120 NV12@24` 模式

所以 cheese 走的是“标准 camera 应用路径”，而这个 sunxi 节点在该场景下必须走“厂商私有初始化路径”，两者不匹配，导致不能正常采集。

---

如果你愿意，我下一步可以继续帮你做两件事之一：

1. **把这条分析整理成一份“时序图式”的 open → s_input → s_parm → s_fmt → streamon → awisp 启动流程说明**
2. **继续深挖 cheese 实际会走到哪些 GStreamer/V4L2 调用，和这个 sunxi 定制路径逐项对比**

---

**User**

帮我结合VIN驱动源码分析一下en-awisp和en-largemode这两个属性

---

**Cursor**

可以，这两个属性要分开看：

- `en-awisp`：**主要是 GStreamer 用户态去拉起 Allwinner 私有 AWIspApi**
- `en-largemode`：**同时作用在用户态 AWISP 和内核 VIN 驱动，用来打开“大图拼接/merge”链路**

它们名字看起来像一组，但从源码上看，职责并不对称。下面我结合源码给你拆开分析。

---

# 一、先给结论

## 1）`en-awisp` 是什么

`en-awisp` 本质是：

> 让 `v4l2src` 在 `STREAMON/STREAMOFF` 前后，额外调用 Allwinner 的 `AWIspApi`，启动/退出用户态 ISP 控制流程。

它**不是标准 V4L2 属性**，也**不是直接下发给 VIN 驱动的 ioctl**。  
它的主要作用对象是：

- `platform/allwinner/vision/libAWIspApi/...`
- 以及 ISP media graph / ISP 服务线程

### 它解决的问题
对于 sunxi RAW sensor / AW ISP 路径，光靠 `VIDIOC_STREAMON` 不够，往往还要显式：

- 初始化 media dev
- 根据 `/dev/videoX` 找到对应 `isp_id`
- `isp_init()`
- `isp_run()`

而 `en-awisp=1` 就是在 `v4l2src` 里自动做这件事。

---

## 2）`en-largemode` 是什么

`en-largemode` 本质是：

> 让 `v4l2src` 进入 Allwinner 的“大图/拼接”采集模式。

它会触发两条线：

### 线 A：用户态 AWISP 线
- 调 `ispSetIspLargeImage()`
- 启动双 ISP（当前 `isp_id` 以及 `isp_id - 1`）

### 线 B：VIN 内核驱动线
- `VIDIOC_SET_DMA_MERGE`
- `VIDIOC_S_INPUT`
- `VIDIOC_S_PARM`
- 驱动内部把 `dma_merge_mode=1`
- 再把 `parms->reserved[2] = 3`
- 最终 `vinc->large_image = 3`
- scaler 按半图裁切/拼接方式工作

所以 `en-largemode` 才是真正和 VIN 驱动深度绑定的属性。

---

# 二、`en-awisp` 源码分析

---

## 1. GStreamer 里怎么定义的

在 `gst1-plugins-good/1.18/0001-gst-good-support-vin.patch` 里，它被加成了 `v4l2src` 的布尔属性：

```425:450:buildroot/buildroot-202205/package/gstreamer1/gst1-plugins-good/1.18/0001-gst-good-support-vin.patch
+#ifdef HAVE_AW_ISP
+  g_object_class_install_property (gobject_class, PROP_ENABLE_AWISP,
+      g_param_spec_boolean("en-awisp", "Enable AWISP",
+          "Enable/Disable AWISP processing",
+          FALSE,
+          G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS));
```

对应字段在 `GstV4l2Object` 里：

```261:274:buildroot/buildroot-202205/package/gstreamer1/gst1-plugins-good/1.18/0001-gst-good-support-vin.patch
+  gboolean enable_awisp;
+  void     *isp;
+  gint     isp_id;
+  guint32  dev_id;
+  gboolean use_large_image_mode;
```

设置属性时：

```738:748:buildroot/buildroot-202205/package/gstreamer1/gst1-plugins-good/1.18/0001-gst-good-support-vin.patch
+    case PROP_ENABLE_AWISP:
+      v4l2object->enable_awisp = g_value_get_boolean (value);
+      break;
```

### 说明
`en-awisp` 只是把一个布尔值记在 `v4l2object->enable_awisp` 里。  
它**并没有直接对应某个 VIN ioctl**。

---

## 2. 它真正生效的位置：`STREAMON`

在 buffer pool 的 `streamon` 阶段：

```20:52:buildroot/buildroot-202205/package/gstreamer1/gst1-plugins-good/1.18/0001-gst-good-support-vin.patch
+      if (obj->enable_awisp) {
+        AWIspApi *isp = CreateAWIspApi();
+        if(isp) {
+          obj->isp = (void* )isp;
+          isp->ispApiInit();
+          obj->isp_id = isp->ispGetIspId(obj->dev_id);
...
+          if(isp->ispStart(obj->isp_id) < 0) {
+            GST_ERROR_OBJECT (pool, "Fail to start isp!");
+            goto stream_on;
+          }
+        } else {
+          obj->isp = NULL;
+        }
+      }
```

### 这里的动作顺序是：

1. 创建 `AWIspApi`
2. `ispApiInit()`
3. `ispGetIspId(dev_id)`
4. `ispStart(isp_id)`
5. 然后才 `VIDIOC_STREAMON`

也就是说：

> `en-awisp=1` 的核心含义，不是改 VIN 参数，而是让 `v4l2src` 在开流前把 AW ISP 用户态服务拉起来。

---

## 3. AWIspApi 具体干了什么

看 `AWIspApi.c`：

### 根据 video 节点拿 ISP id
```83:95:platform/allwinner/vision/libAWIspApi/isp6xx/AWIspApi.c
static int awIspGetIspId(int video_id)
{
    int id = -1;

    id = isp_get_isp_id(video_id);
...
    ALOGD("F:%s, L:%d, video%d --> isp%d\n",__FUNCTION__, __LINE__, video_id, id);
    return id;
}
```

### 启动 ISP
```97:114:platform/allwinner/vision/libAWIspApi/isp6xx/AWIspApi.c
static int awIspStart(int isp_id)
{
    int ret = -1;

    CHECK_ISP_ID(isp_id);
    pthread_mutex_lock(&lock);
    ret = isp_init(isp_id);
    pthread_mutex_unlock(&lock);
...
    ret = isp_run(isp_id);
...
    return 0;
}
```

### 初始化 media dev
```29:33:platform/allwinner/vision/libAWIspApi/isp6xx/AWIspApi.c
static int awIspApiInit()
{
    media_dev_init();
    return 0;
}
```

### 退出
```143:148:platform/allwinner/vision/libAWIspApi/isp6xx/AWIspApi.c
static int awIspApiUnInit()
{
    media_dev_exit();
    return 0;
}
```

---

## 4. 所以 `en-awisp` 和 VIN 驱动是什么关系？

### 它不是直接控制 VIN
`en-awisp` 本身没有对应到：

- `VIDIOC_SET_SENSOR_ISP_CFG`
- `VIDIOC_S_CTRL`
- `VIDIOC_PRIVATE`

这些 VIN ioctl。

### 它是“VIN 之外的补充 bring-up”
它依赖的是：

- `/dev/videoX` 能映射到某个 `isp_id`
- media graph 已经能连通
- VIN 这边在 `S_INPUT/S_PARM/S_FMT` 后已经把 sensor/csi/isp/scaler 通路准备好

所以它的定位更像：

> VIN 负责把采集链路建起来，`en-awisp` 负责把 AW 的 ISP 用户态运行时拉起来。

### 可以这样理解
如果不用 `en-awisp`：
- 内核 V4L2 设备可能能开
- 但 AW ISP 的控制线程、同步和算法未必真正启动

如果加了 `en-awisp=1`：
- `v4l2src` 不只是采集，还顺带扮演了 “启动 AW ISP 服务”的角色

---

# 三、`en-largemode` 源码分析

这个属性比 `en-awisp` 更关键，因为它是真正把用户态和 VIN 驱动串起来的。

---

## 1. GStreamer 里怎么定义

在 `0004-add-sunxi-csi-merge-config.patch` 里：

```31:50:buildroot/buildroot-202205/package/gstreamer1/gst1-plugins-good/0004-add-sunxi-csi-merge-config.patch
+  g_object_class_install_property (gobject_class, PROP_ENABLE_LARGEMODE,
+      g_param_spec_boolean("en-largemode", "Enable AWISP using largemode",
+          "Enable/Disable AWISP largemode processing. Largemode using in big input size",
+          FALSE,
+          G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS));
```

保存到：

```56:65:buildroot/buildroot-202205/package/gstreamer1/gst1-plugins-good/0004-add-sunxi-csi-merge-config.patch
+  gboolean use_large_image_mode;
```

设置时：

```53:61:buildroot/buildroot-202205/package/gstreamer1/gst1-plugins-good/0004-add-sunxi-csi-merge-config.patch
+    case PROP_ENABLE_LARGEMODE:
+      v4l2object->use_large_image_mode = g_value_get_boolean (value);
+      break;
```

---

## 2. `en-largemode` 先作用到 open 阶段：VIN merge 初始化

在 `gst_v4l2_open()` 里：

```77:110:buildroot/buildroot-202205/package/gstreamer1/gst1-plugins-good/0004-add-sunxi-csi-merge-config.patch
+  if (v4l2object->use_large_image_mode) {
+    GST_INFO_OBJECT (v4l2object->dbg_obj,"VIDIOC_SET_DMA_MERGE[%d] start\n", dma_merge_mode);
+    if (-1 == ioctl(v4l2object->video_fd, VIDIOC_SET_DMA_MERGE, &dma_merge_mode)) {
+        GST_ERROR_OBJECT(v4l2object->dbg_obj,"VIDIOC_SET_DMA_MERGE error!");
+        goto error;
+    }
+  }
...
+  if (-1 == ioctl(v4l2object->video_fd, VIDIOC_S_INPUT, &inp)) {
...
+  parms.parm.capture.capturemode = V4L2_MODE_VIDEO;
...
+  if (-1 == ioctl(v4l2object->video_fd, VIDIOC_S_PARM, &parms)) {
```

### 这说明：
`en-largemode=1` 会触发三件关键事：

1. `VIDIOC_SET_DMA_MERGE`
2. `VIDIOC_S_INPUT`
3. `VIDIOC_S_PARM`

而这三件事正是 VIN 驱动的大图模式入口。

---

## 3. `VIDIOC_SET_DMA_MERGE` 在 VIN 驱动里干了什么

```3068:3083:bsp/drivers/vin/vin-video/vin_video.c
static int vidioc_set_dma_merge(struct file *file, struct v4l2_fh *fh,
			unsigned char *dma_merge)
{
	struct vin_core *vinc = video_drvdata(file);
	__maybe_unused struct vin_core *vinc_bind = NULL;

	vinc->dma_merge_mode = *dma_merge;

	if (vinc->dma_merge_mode == 1) {
		if (vinc->id % 4 == 1 && vin_core_gbl[vinc->id - 1]) {
			vinc_bind = vin_core_gbl[vinc->id - 1];
			vinc_bind->dma_merge_mode = *dma_merge;
		}
	}
	return 0;
}
```

### 这里的意义
- 当前 `videoX` 进入 merge mode
- 如果是主节点（典型就是 `video1`），会把配对的 `video0` 也一起置 `dma_merge_mode=1`

也就是说：

> `en-largemode` 首先让单节点采集变成“双 VIN 通道协同采集”。

---

## 4. 为什么还要 `S_INPUT`

`S_INPUT` 在 sunxi VIN 里不是“切输入”那么简单，它会完成整条管线初始化：

```2514:2566:bsp/drivers/vin/vin-video/vin_video.c
static int __vin_s_input(struct vin_core *vinc, unsigned int i)
{
...
	if (__vin_sensor_setup_link(vinc, module, valid_idx, 1) < 0) {
...
	if (__csi_isp_setup_link(vinc, 1) < 0) {
...
	ret = vin_pipeline_call(vinc, open, &cap->pipe, &cap->vdev.entity, true);
...
	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_ISP], core, init, 1);
...
	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SCALER], core, init, 1);
...
	ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SENSOR], core, init, 1);
```

merge 模式下还会连带配对通道一起做：

```2461:2476:bsp/drivers/vin/vin-video/vin_video.c
static int vidioc_s_input(struct file *file, void *priv, unsigned int i)
{
...
	if (vinc->dma_merge_mode == 1) {
		if (vinc->id % 4 == 1 && vin_core_gbl[vinc->id - 1]) {
			vinc_bind = vin_core_gbl[vinc->id - 1];
			ret = __vin_s_input(vinc_bind, i);
...
	ret = __vin_s_input(vinc, i);
```

### 所以
`en-largemode` 不是只打开一个标志，而是要求：

- 主节点 + 绑定节点都完成 pipeline open/init

---

## 5. 最关键的是 `S_PARM` 如何把 largemode 传进内核

看 `__vin_s_parm()`：

```2532:2568:bsp/drivers/vin/vin-video/vin_video.c
static int __vin_s_parm(struct vin_core *vinc, struct v4l2_streamparm *parms)
{
...
	if (vinc->dma_merge_mode == 1)
		parms->parm.capture.reserved[2] = 3;
...
	cap->capture_mode = parms->parm.capture.capturemode;
	vinc->large_image = parms->parm.capture.reserved[2];
...
	ret = sunxi_isp_s_parm(cap->pipe.sd[VIN_IND_ISP], parms);
...
	ret = sunxi_scaler_subdev_s_parm(cap->pipe.sd[VIN_IND_SCALER], parms);
```

### 这段代码非常关键
逻辑是：

1. 如果 `dma_merge_mode == 1`
2. 驱动自动把 `reserved[2] = 3`
3. 然后把它落到 `vinc->large_image`

也就是说：

> GStreamer 用户态并没有直接传 `3`，它只是打开 `VIDIOC_SET_DMA_MERGE`；  
> 真正把 “large image mode” 数值化成 `3` 的，是 VIN 驱动自己在 `S_PARM` 里做的。

---

## 6. `large_image == 3` 到底在驱动里意味着什么

从 `vin_core.h` 的注释可以看出：

```91:108:bsp/drivers/vin/vin-video/vin_core.h
	unsigned char large_image;/* 2:get merge yuv, 1: get pattern raw (save in kernel), 0: normal */
...
	unsigned char dma_merge_mode;
```

虽然注释里没写 `3`，但实际代码里明显把 `3` 用成了“大图拼接模式”。

最直观的是 scaler：

```768:791:bsp/drivers/vin/vin-vipp/sunxi_scaler.c
		if (scaler->large_image == 3) {
...
			if (scaler->id % 4 == 0)
				crop.hor = scaler->crop.active.left;
			else
				crop.hor = vin_set_large_overlayer(scaler->crop.active.width);

			crop.width = scaler->crop.active.width/2;
			scaler_size.sc_width = scaler->para.width/2;
			scaler->para.width /= 2;
```

### 这说明：
在 `large_image == 3` 时：

- 单个 scaler 不再处理全图
- 而是处理半图
- 不同通道 crop 起点不同
- 最终做的是双路大图拼接

这就是 `en-largemode` 的 VIN 内核实质。

---

# 四、`en-largemode` 在 AWISP 用户态又做了什么

如果同时启用了 `en-awisp`，那 `en-largemode` 还会影响 AWIspApi：

```28:42:buildroot/buildroot-202205/package/gstreamer1/gst1-plugins-good/1.18/0001-gst-good-support-vin.patch
+          if(obj->use_large_image_mode) {
+            if(isp->ispSetIspLargeImage(obj->isp_id) < 0) {
+              GST_ERROR_OBJECT(pool, "set isp stitch err");
+              goto stream_on;
+            }
+            if(isp->ispStart(obj->isp_id - 1) < 0) {
+              GST_ERROR_OBJECT (pool, "Fail to start isp!");
+              goto stream_on;
+            }
+          }
```

AWIspApi 里对应实现：

```116:131:platform/allwinner/vision/libAWIspApi/isp6xx/AWIspApi.c
static int awIspSetIspLargeImage(int isp_id)
{
    int ret = -1;

    isp_set_stitch_mode(isp_id, STITCH_2IN1_LINNER);

    if (isp_id % 2 == 0)
        ret = isp_set_sync((0x1 << isp_id) | (0x1 << (isp_id + 1)));
    else
        ret = isp_set_sync((0x1 << (isp_id - 1)) | (0x1 << isp_id));
...
    return 0;
}
```

### 这里说明
在用户态 ISP 看来，`en-largemode` 的语义是：

- 打开 stitch mode：`STITCH_2IN1_LINNER`
- 把两个相邻 ISP 做同步：`isp_set_sync(...)`
- 然后先启动配对 ISP，再启动当前 ISP

所以 `en-largemode` 不仅是 VIN merge，也要求 ISP 进入双输入拼接模式。

---

# 五、把两个属性放在一张图里看

---

## 1. 只有 `en-awisp=1`
### GStreamer 做的事
- 创建 AWIspApi
- `media_dev_init()`
- `videoX -> isp_id`
- `isp_init() + isp_run()`
- streamoff 时 `isp_exit() + media_dev_exit()`

### VIN 驱动侧
- **没有新增特定 largemode 逻辑**
- 就是普通 `S_INPUT/S_FMT/STREAMON` 采集链路

### 作用
- 开普通 AWISP 路径
- 适合普通 RAW/ISP 场景
- 不一定涉及双路拼接

---

## 2. 只有 `en-largemode=1`
### GStreamer 做的事
- `VIDIOC_SET_DMA_MERGE`
- `VIDIOC_S_INPUT`
- `VIDIOC_S_PARM`

### VIN 驱动侧
- `dma_merge_mode = 1`
- 配对 video 节点也进入 merge
- `reserved[2] = 3`
- `vinc->large_image = 3`
- scaler 半图裁切+拼接

### 作用
- 打开内核 VIN 的大图 merge 模式
- 但如果不启动 AWISP，用户态 ISP 侧可能还不完整

---

## 3. `en-awisp=1 + en-largemode=1`
这是你命令用的组合，也是最完整的路径。

### GStreamer 层
- largemode：打开 VIN merge 入口
- awisp：启动 ISP 用户态运行时
- largemode + awisp：再给 ISP 打开 stitch/sync

### VIN 层
- 双 video 节点 merge
- `large_image = 3`
- scaler 半图处理
- 整个大图 pipeline 成立

### AWISP 层
- 双 ISP 同步
- stitch mode
- 启动两个 ISP 实例

### 这才是真正的大图采集完整链路

---

# 六、为什么说这两个属性“强相关但不对等”

## `en-awisp`
更像：
> 是否启动 AW 用户态 ISP 服务

它主要控制：
- `CreateAWIspApi`
- `ispApiInit`
- `ispGetIspId`
- `ispStart`
- `ispWaitToExit`

它本身不直接改 VIN 内核模式。

---

## `en-largemode`
更像：
> 是否把当前采集从普通单路模式切到 Allwinner 私有大图拼接模式

它同时控制：
- VIN 内核 merge / large_image
- AWISP stitch / sync

所以从系统层级上说：

- `en-awisp`：偏“ISP runtime enable”
- `en-largemode`：偏“pipeline topology/mode switch”

---

# 七、一个非常实用的理解方式

如果把整套路径按层拆开：

## 内核层：VIN/V4L2
- `VIDIOC_SET_DMA_MERGE`
- `VIDIOC_S_INPUT`
- `VIDIOC_S_PARM`
- `large_image=3`
- scaler 拼接

## 用户态 ISP 层：AWIspApi
- `media_dev_init`
- `isp_get_isp_id`
- `isp_set_stitch_mode`
- `isp_set_sync`
- `isp_init/run`

那么：

### `en-awisp`
只打开 **用户态 ISP 层**

### `en-largemode`
打开 **内核层大图模式**，并在 `en-awisp` 存在时继续打开 **用户态 stitch/sync**

---

# 八、最终总结

## `en-awisp` 属性
- 是 GStreamer 补丁新增的私有属性
- 不直接映射到 VIN 驱动某个私有 ioctl
- 作用是让 `v4l2src` 在开流时拉起 `AWIspApi`
- 本质是“启动 AW 用户态 ISP 运行时”
- 依赖 VIN pipeline 已经能正常建立

## `en-largemode` 属性
- 是 GStreamer 补丁新增的“大图模式”属性
- 会直接触发 VIN 驱动私有初始化：
  - `VIDIOC_SET_DMA_MERGE`
  - `VIDIOC_S_INPUT`
  - `VIDIOC_S_PARM`
- 在 VIN 驱动里最终转成：
  - `dma_merge_mode = 1`
  - `vinc->large_image = 3`
- 在 scaler 里体现为：
  - 半幅 crop
  - 双路拼接
- 如果同时启用 `en-awisp`，还会让 AWISP 进入：
  - `STITCH_2IN1_LINNER`
  - 双 ISP sync/start

---

如果你愿意，我下一步可以继续给你补一张**“从 gst 属性到 VIN 内核变量”的映射表**，比如：

- `en-awisp` → `enable_awisp` → `AWIspApi::ispStart`
- `en-largemode` → `use_large_image_mode` → `VIDIOC_SET_DMA_MERGE` → `dma_merge_mode` → `reserved[2]=3` → `vinc->large_image=3` → `scaler->large_image==3`

这样你拿去写设计说明会更直观。

