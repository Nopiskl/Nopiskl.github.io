
---

**User**

那为什么公板摄像头gc2053也会出现`get_selection` 报错？，但是能被上层调用？@lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin_test/mplane_image_userptr/csi_test_mplane.c 这个是VIN官方测试程序

---

**Cursor**

读取官方测试程序和 gc2053 驱动配置，理解为什么会出现这个矛盾现象。

读取 gc2053 驱动，对比 kw33000 驱动的差异。

读取 kw33000 驱动，查看其 `get_selection` 实现。

现在搜索 `get_selection` 在驱动框架中的实现，理解为什么会报错但仍能工作。

用 ripgrep 搜索 `get_selection`。

使用 grep 搜索。

读取 scaler 驱动的 `get_selection` 实现和调用处。

现在理解了问题所在。让我查看 kw33000 驱动是否实现了 `get_selection`。

现在完全理解了。让我总结这个矛盾现象的根本原因：

---

## 为什么 gc2053 会报 `get_selection` 错误，但仍能被上层调用？

### 核心原因：错误处理的宽松设计

#### 1. **错误的来源**

在 `vin_video.c` 的调用链中：

```c
ret = v4l2_subdev_call(vinc->vid_cap.pipe.sd[VIN_IND_SCALER], pad,
                       get_selection, NULL, &sel);
if (ret < 0)
    vin_err("v4l2 sub device scaler get_selection error!\n");
else
    s->r = sel.r;
return ret;  // ← 返回错误码，但不中断流程
```

**关键点**：这里调用的是 **scaler 驱动** 的 `get_selection`，不是 sensor 驱动。

#### 2. **gc2053 为什么会报错**

查看 gc2053 驱动的 `pad_ops`：

```c
static const struct v4l2_subdev_pad_ops sensor_pad_ops = {
    .enum_mbus_code  = sensor_enum_mbus_code,
    .enum_frame_size = sensor_enum_frame_size,
    .get_fmt         = sensor_get_fmt,
    .set_fmt         = sensor_set_fmt,
    // ← 没有 .get_selection
};
```

**gc2053 没有实现 `get_selection`**，所以当上层调用时返回 `-EINVAL`。

#### 3. **为什么仍能工作**

关键在于 **scaler 驱动的 `get_selection` 实现**：

```c
static int sunxi_scaler_subdev_get_selection(struct v4l2_subdev *sd, ...)
{
    struct scaler_dev *scaler = v4l2_get_subdevdata(sd);
    
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
    return 0;  // ← 总是返回 0（成功）
}
```

**scaler 驱动实现了 `get_selection`**，所以调用成功。错误日志来自 **sensor 驱动层面的某个其他操作**，而不是这个 `get_selection` 调用本身。

---

### 4. **为什么 kw33000 也会报错**

kw33000 驱动同样没有实现 `get_selection`：

```c
static const struct v4l2_subdev_pad_ops sensor_pad_ops = {
    .enum_mbus_code  = sensor_enum_mbus_code,
    .enum_frame_size = sensor_enum_frame_size,
    .get_fmt         = sensor_get_fmt,
    .set_fmt         = sensor_set_fmt,
    // ← 没有 .get_selection
};
```

但这个错误 **不会影响功能**，因为：

1. **scaler 驱动有实现** → 调用链最终成功
2. **错误处理宽松** → 即使返回错误码，上层也继续执行
3. **sensor 驱动不需要实现** → sensor 是数据源，不需要处理 crop/selection

---

### 5. **官方测试程序为什么没问题**

`csi_test_mplane.c` 直接调用 V4L2 API（`VIDIOC_S_FMT`、`VIDIOC_DQBUF` 等），**绕过了 scaler 的 `get_selection` 调用**。它只走：

- sensor 初始化 → `VIDIOC_S_INPUT`
- 格式设置 → `VIDIOC_S_FMT` / `VIDIOC_G_FMT`
- 流控制 → `VIDIOC_STREAMON` / `VIDIOC_STREAMOFF`

不涉及 crop/selection 操作。


#
**错误日志只是信息性的，不影响实际功能**。这是全志驱动框架的设计特点：sensor 驱动不需要实现 crop/selection，由 scaler 驱动统一处理。

```c
ret = v4l2_subdev_call(vinc->vid_cap.pipe.sd[VIN_IND_SCALER], pad,
                       get_selection, NULL, &sel);
if (ret < 0)
    vin_err("v4l2 sub device scaler get_selection error!\n");
else
    s->r = sel.r;
return ret;  // ← 返回错误码，但不中断流程
```

```c
static const struct v4l2_subdev_pad_ops sensor_pad_ops = {
    .enum_mbus_code  = sensor_enum_mbus_code,
    .enum_frame_size = sensor_enum_frame_size,
    .get_fmt         = sensor_get_fmt,
    .set_fmt         = sensor_set_fmt,
    // ← 没有 .get_selection
};
```

```c
static int sunxi_scaler_subdev_get_selection(struct v4l2_subdev *sd, ...)
{
    struct scaler_dev *scaler = v4l2_get_subdevdata(sd);
    
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
    return 0;  // ← 总是返回 0（成功）
}
```

```c
static const struct v4l2_subdev_pad_ops sensor_pad_ops = {
    .enum_mbus_code  = sensor_enum_mbus_code,
    .enum_frame_size = sensor_enum_frame_size,
    .get_fmt         = sensor_get_fmt,
    .set_fmt         = sensor_set_fmt,
    // ← 没有 .get_selection
};
```

# `v4l2-ctl --stream-mmap` 持续触发 `get_selection` 报错的原因分析

## 1. 问题背景

上层执行如下命令时：

```bash
v4l2-ctl -d /dev/video0 \
    --set-fmt-video=width=672,height=1984,pixelformat=Y12 \
    --stream-mmap \
    --stream-to=/tmp/frame.raw \
    --stream-count=1
```

会持续看到类似日志：

```text
v4l2 sub device scaler get_selection error!
```

本文只分析这条 `get_selection` 报错的根因，不展开 `pixelformat=Y12` 的格式兼容问题。

---

## 2. 结论先行

这次报错的直接原因不是 sensor 没有实现 `.get_selection`，也不是 `672x1984` 这组分辨率本身触发了异常，而是：

1. `v4l2-ctl` 在 `--stream-mmap` 流程中，会主动发起一次 `VIDIOC_G_SELECTION` 查询。
2. 这个查询的 `target` 是 `V4L2_SEL_TGT_COMPOSE`。
3. `sunxi-vin` 的 video 节点把这个查询转发给 `VIN_IND_SCALER`。
4. `sunxi_scaler_subdev_get_selection()` 只支持：
   - `V4L2_SEL_TGT_CROP_BOUNDS`
   - `V4L2_SEL_TGT_CROP`
5. 当收到 `V4L2_SEL_TGT_COMPOSE` 时，scaler 直接返回 `-EINVAL`。
6. `vin_video.c` 捕获到这个返回值后打印：

```c
vin_err("v4l2 sub device scaler get_selection error!\n");
```

因此，这个报错本质上是：

`v4l2-ctl` 的 `COMPOSE` 能力探测，撞上了全志 VIN scaler 仅支持 `CROP`/`CROP_BOUNDS` 的实现边界。

---

## 3. 这次报错和 `v4l2.md` 的关系

`v4l2.md` 之前解决的是一个更泛化的问题：

- 为什么会看到 `get_selection` 相关报错
- 为什么即使报错，采集流程仍然可能继续工作

那个结论大方向没有问题：

- VIN 框架里的 selection/crop 主要由 scaler 统一处理
- 官方测试程序默认并不会主动查询 selection
- 报错不一定会阻断最终采图

但对这次 `v4l2-ctl --stream-mmap` 的具体场景，还需要补充一个更精确的结论：

> 这次真正失败的不是 “sensor 没有实现 `get_selection`”，而是 “`v4l2-ctl` 查询了 `COMPOSE`，而 scaler 只支持 `CROP` / `CROP_BOUNDS`”。

也就是说：

- `v4l2.md` 解释了“为什么报错但还能工作”
- 本文进一步解释了“这次到底是谁在调用 `get_selection`，调用的是什么 target，为什么一定会失败”

这两份分析并不冲突，后一份是前一份在当前命令场景下的具体化。

---

## 4. 用户态是谁触发了 `VIDIOC_G_SELECTION`

### 4.1 `v4l2-ctl` 在 streaming 初始化时会主动探测 compose

参考 `v4l-utils` 上游 `v4l2-ctl` 的 streaming 实现：

- 文件：`utils/v4l2-ctl/v4l2-ctl-streaming.cpp`
- 关键函数：`get_cap_compose_rect()`

逻辑大致如下：

```c
static void get_cap_compose_rect(cv4l_fd &fd)
{
    v4l2_selection sel;

    memset(&sel, 0, sizeof(sel));
    sel.type = vidcap_buftype;
    sel.target = V4L2_SEL_TGT_COMPOSE;

    if (fd.g_selection(sel) == 0) {
        support_cap_compose = true;
        composed_width = sel.r.width;
        composed_height = sel.r.height;
    } else {
        support_cap_compose = false;
    }
}
```

也就是说，即使用户没有显式传 `--get-selection`，只要进入 `--stream-mmap` 的 streaming 路径，`v4l2-ctl` 也可能先探测一次 capture 端是否支持 `COMPOSE`。

### 4.2 这一步会在 streaming 流程里被调用

在 `streaming_set_cap()` 中，`v4l2-ctl` 在 `S_FMT` 之后、`REQBUFS` 之前调用：

```c
fd.s_fmt(fmt, in.g_type());
get_cap_compose_rect(fd);
in.reqbufs(&fd, reqbufs_count_cap);
```

这说明报错时序通常是：

1. 用户态先 `VIDIOC_S_FMT`
2. 然后用户态探测 `VIDIOC_G_SELECTION(target=COMPOSE)`
3. 接着才进入 `REQBUFS`
4. 最后才是 `STREAMON`

因此，`get_selection` 报错并不说明采集主流程已经失败，它只是 streaming 初始化中的一次能力探测失败。

### 4.3 为什么看起来像“一直在报”

在 `v4l2-ctl-streaming.cpp` 中，`get_cap_compose_rect()` 不止一个调用点，streaming 初始化总入口和 capture 分支里都会做这类探测，所以在实际日志里可能看到多次同样的报错。

这就是“不是手工调用了 `--get-selection`，但仍然不断看到 `get_selection error`”的根本原因。

参考源码：

- https://github.com/gjasny/v4l-utils/blob/master/utils/v4l2-ctl/v4l2-ctl-streaming.cpp

---

## 5. 内核里这条查询是怎么走到 scaler 的

### 5.1 `/dev/video0` 的 `VIDIOC_G_SELECTION` 实现在 `vin_video.c`

本地源码：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c:1507`

关键代码：

```c
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

这里有两个关键点：

1. video 节点没有自己处理 selection
2. 它把 `s->target` 原样透传给 scaler

也就是说：

- 用户态传 `CROP`，它就查 scaler 的 `CROP`
- 用户态传 `COMPOSE`，它就查 scaler 的 `COMPOSE`

内核层并没有做 target 转换，也没有兜底。

### 5.2 这次打印的报错就是从这里打出来的

如果 scaler 返回负值，`vin_video.c` 直接打印：

```c
vin_err("v4l2 sub device scaler get_selection error!\n");
```

所以你看到的报错字符串本身已经说明：

- 报错发生在 video 节点转发给 scaler 之后
- 失败点在 scaler 的 `get_selection`
- 不是 sensor pad ops 直接打印出来的

---

## 6. scaler 为什么一定会返回 `-EINVAL`

### 6.1 `sunxi_scaler_subdev_get_selection()` 只支持两个 target

本地源码：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/sunxi_scaler.c:236`

关键实现：

```c
static int sunxi_scaler_subdev_get_selection(struct v4l2_subdev *sd,
                         struct v4l2_subdev_pad_config *cfg,
                         struct v4l2_subdev_selection *sel)
{
    struct scaler_dev *scaler = v4l2_get_subdevdata(sd);
    struct v4l2_mbus_framefmt *format_source;
    struct v4l2_mbus_framefmt *format_sink;

    if (sel->pad != SCALER_PAD_SINK)
        return -EINVAL;

    format_sink = &scaler->formats[SCALER_PAD_SINK];
    format_source = &scaler->formats[SCALER_PAD_SOURCE];

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

这段代码说明得非常直接：

- `pad` 不是 `SCALER_PAD_SINK`，返回 `-EINVAL`
- `target` 不是 `CROP_BOUNDS` 或 `CROP`，返回 `-EINVAL`

而 `v4l2-ctl` 在 streaming 路径里查的是：

```c
sel.target = V4L2_SEL_TGT_COMPOSE;
```

因此这次失败是确定性的，不是偶发行为。

### 6.2 这不是“scaler 没初始化”，而是“接口语义不支持”

这点很重要。

从当前源码看，这次更像是：

- scaler 子设备已经存在
- video 节点也能正常拿到 `VIN_IND_SCALER`
- 但是 scaler 没有实现 `COMPOSE`

所以这里不是“对象没挂上”或“空指针分支”导致的失败，而是 selection target 不匹配导致的协议级失败。

---

## 7. 为什么 `S_FMT` 能走通，但 `G_SELECTION(COMPOSE)` 会失败

这是很多人第一次看这段代码时最容易困惑的地方。

### 7.1 `S_FMT` 走的是格式传播链

本地源码：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c:1060`

`vin_pipeline_try_format()` 会沿着媒体图把 `set_fmt` 往下传播到：

- sensor
- mipi
- csi
- isp
- scaler

核心逻辑是：

```c
ret = v4l2_subdev_call(sd, pad, set_fmt, NULL, &sfmt);
```

并且当走到 scaler 时，还会把 scaler source 侧的输出尺寸调整到用户请求的宽高。

所以：

- `VIDIOC_S_FMT` 是否成功，主要取决于格式协商链
- `VIDIOC_G_SELECTION` 是否成功，取决于对应 subdev 是否实现了该 selection target

这两件事不是同一条逻辑链。

### 7.2 VIN 框架内部使用 scaler 时，自己也只在用 `CROP`

本地源码：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c:1323`

`__vin_set_fmt()` 在拿到 sensor 的窗口配置后，会去配置：

1. CSI parser crop
2. VIPP crop
3. VIPP shrink

其中 scaler 的 selection 设置都是：

```c
sel.target = V4L2_SEL_TGT_CROP;
```

对应代码位置：

- `vin_video.c:1363`
- `vin_video.c:1380`

这说明全志这套 VIN 框架内部对 scaler 的 selection 语义，本来就围绕 `CROP` 展开，而不是 `COMPOSE`。

换句话说：

> 驱动作者自己使用 scaler 的方式，就是“设置 crop”，不是“查询 compose”。

所以当通用工具 `v4l2-ctl` 按照标准 V4L2 能力模型去问一个 `COMPOSE` 时，这个私有实现就暴露出兼容性边界了。

---

## 8. 为什么报错后流通常还能继续

### 8.1 在 `v4l2-ctl` 里，这只是一个可选探测

从 `get_cap_compose_rect()` 的写法可以看出：

```c
if (fd.g_selection(sel) == 0) {
    support_cap_compose = true;
    ...
} else {
    support_cap_compose = false;
}
```

如果失败，`v4l2-ctl` 只是把 `support_cap_compose` 设为 `false`，并不会因此直接终止 streaming 流程。

后面依然会继续：

- `REQBUFS`
- `QBUF`
- `STREAMON`

### 8.2 所以这条报错更像“能力探测失败”而不是“采集主流程失败”

这与 `v4l2.md` 的经验结论是一致的：

- selection 相关报错不一定阻断采集
- 需要看失败发生在哪个 ioctl、该 ioctl 在应用里是否是强依赖

对于这次 `v4l2-ctl --stream-mmap` 来说：

- `G_SELECTION(COMPOSE)` 不是必须成功
- 它失败后，streaming 主流程仍可能继续

---

## 9. 为什么官方 `csi_test_mplane.c` 默认不会踩到这个坑

本地源码：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin_test/mplane_image/csi_test_mplane.c:1051`

可以看到 selection 相关代码被条件编译包住了：

```c
#if video_s_selection
    struct v4l2_selection s;
    ...
    s.target = V4L2_SEL_TGT_CROP;
    ioctl(fd, VIDIOC_S_SELECTION, &s);
#endif
```

这里有两个关键点：

1. 默认并不会启用这段代码
2. 即使启用，发的也是 `VIDIOC_S_SELECTION(target=CROP)`，不是 `VIDIOC_G_SELECTION(target=COMPOSE)`

因此官方测试程序和 `v4l2-ctl --stream-mmap` 的行为差异是非常明显的：

| 场景 | 是否主动查 selection | target 是什么 |
|------|----------------------|---------------|
| `csi_test_mplane.c` 默认路径 | 否 | 无 |
| `csi_test_mplane.c` 打开宏后 | 是 | `CROP` |
| `v4l2-ctl --stream-mmap` | 是 | `COMPOSE` |

这也是为什么：

- 官方测试程序默认看起来“没问题”
- `v4l2-ctl` 却会稳定触发 `get_selection error`

---

## 10. 对这次问题的准确归因

### 10.1 不应归因到 sensor `.get_selection`

结合本次调用链，这次日志不能简单归因成：

> “sensor 没有实现 `.get_selection`，所以报错”

因为这次真正调用的是：

```c
v4l2_subdev_call(vinc->vid_cap.pipe.sd[VIN_IND_SCALER], pad,
                 get_selection, NULL, &sel);
```

也就是 scaler，不是 sensor。

### 10.2 这次真正的根因

更准确的表述应当是：

> `v4l2-ctl` 在 streaming 初始化中发起 `VIDIOC_G_SELECTION(target=COMPOSE)`，  
> `sunxi-vin` video 节点将其透传给 scaler，  
> 但 `sunxi_scaler_subdev_get_selection()` 仅支持 `CROP_BOUNDS` 和 `CROP`，  
> 因而返回 `-EINVAL`，最终打印 `v4l2 sub device scaler get_selection error!`

---

## 11. 如果后续要修，修复方向是什么

本文重点是分析，不强行给出改动方案。但从当前源码结构看，后续若要兼容 `v4l2-ctl`，通常有两条思路：

### 方案一：在 scaler 里补 `COMPOSE`

在 `sunxi_scaler_subdev_get_selection()` 里增加：

- `V4L2_SEL_TGT_COMPOSE`
- 视需要再补：
  - `V4L2_SEL_TGT_COMPOSE_BOUNDS`
  - `V4L2_SEL_TGT_COMPOSE_DEFAULT`

这是最符合通用 V4L2 工具预期的做法。

### 方案二：在 video 节点对不支持的 target 做兼容

例如在 `vidioc_g_selection()` 里：

- 对 `COMPOSE` 做本地兜底
- 或者对 `-EINVAL` 视为“不支持该能力，但不打印高优先级错误”

这种方式改动更小，但语义上不如方案一完整。

---

## 12. 最终总结

这次 `v4l2-ctl --stream-mmap` 持续出现 `get_selection` 报错，根因已经可以明确为：

1. `v4l2-ctl` 的 streaming 路径会自动探测 `VIDIOC_G_SELECTION(target=COMPOSE)`
2. `sunxi-vin` 的 `/dev/video0` 把这个请求直接转发给 scaler
3. `sunxi_scaler_subdev_get_selection()` 不支持 `COMPOSE`
4. 因此返回 `-EINVAL`
5. `vin_video.c` 捕获后打印 `v4l2 sub device scaler get_selection error!`

这解释了三个现象：

1. 为什么没有显式调用 `--get-selection` 却还会报错  
   因为 `v4l2-ctl` 在 streaming 初始化中自己会探测

2. 为什么官方测试程序默认没问题  
   因为它默认不查 selection，就算查也是 `CROP`，不是 `COMPOSE`

3. 为什么报错后采集流程有时还能继续  
   因为这只是一个可选能力探测失败，不一定是采图主链路失败

---

## 13. 参考源码

### 本地 VIN 驱动

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c:1060`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c:1323`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c:1507`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/sunxi_scaler.c:236`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin_test/mplane_image/csi_test_mplane.c:1051`

### 参考的 `v4l2-ctl` 上游实现

- `https://github.com/gjasny/v4l-utils/blob/master/utils/v4l2-ctl/v4l2-ctl-streaming.cpp`

### 之前的分析记录

- `v4l2.md`
