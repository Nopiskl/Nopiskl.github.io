# K230 vvcam V4L2/MC 外壳与私有事件/私有 ioctl 驱动链路分析

本文档整理 `buildroot-overlay/package/vvcam` 中 K230 vvcam 相关 V4L2/Media Controller 适配代码的走读结果，重点分析：

- 主线 V4L2/Media Controller 外壳如何建立。
- `/dev/videoX` 如何把标准 V4L2 ioctl 转成 remote subdev 私有 ioctl。
- `VVCAM_PAD_*` 命令在 ISP subdev 中如何被分发。
- 典型 control 调用如何继续转成 `VVCAM_ISP_EVENT_*` 私有事件。
- 当前 SDK 中能追到的寄存器级入口在哪里。
- 当前 SDK 中断开的部分在哪里，以及为什么无法从源码直接看到每个 control id 到具体寄存器 offset 的映射。

本文中的“ISP”主要指 v4l2 subdev 这一层与底层 misc ISP 寄存器设备这两部分。这里不展开 ISP 算法细节，只关注接口桥接和调用链。

## 1. 总体结论

这套驱动不是一个完全在内核里闭环完成 ISP pipeline 和寄存器编程的主线风格驱动，而是一个分层桥接方案：

```text
用户态 V4L2 app
    |
    | 标准 V4L2 ioctl: VIDIOC_S_FMT / REQBUFS / QBUF / STREAMON / S_CTRL ...
    v
/dev/videoX
    |
    | vvcam_video: video_device + vb2 + media entity
    | 通过 media graph 找 remote v4l2_subdev
    v
vvcam-isp-subdev.X
    |
    | VVCAM_PAD_* private subdev ioctl
    | V4L2 ctrl handler
    | VVCAM_ISP_DEAMON_EVENT + shared memory
    v
isp_media_server_debian
    |
    | 用户态解析 event, control id, buffer, stream 状态
    | 调用 HAL / engine / isp_drv 逻辑
    v
/dev/vvcam-isp.0
    |
    | VVCAM_ISP_READ_REG / VVCAM_ISP_WRITE_REG
    v
readl/writel(ISP_MMIO_BASE + offset)
```

因此可以把它理解为：

```text
标准接口负责“让 Linux 多媒体生态认得它”；
私有协议负责“让 VeriSilicon/K230 后端真正跑起来”。
```

关键点：

- `v4l2/video` 提供 `/dev/videoX` 标准 capture 外壳。
- `v4l2/isp` 提供 `/dev/v4l-subdevX` subdev 外壳、V4L2 ctrl handler 和 event 桥。
- `package/vvcam/isp` 提供底层 `/dev/vvcam-isp.0` misc 设备，里面有实际 `readl/writel`。
- `isp_media_server_debian` 是用户态 daemon，负责把 v4l2 subdev event 转换为 ISP HAL/寄存器操作。
- 当前仓库没有展开 `buildroot-overlay/isp_media/...` 用户态 daemon 源码，只有二进制和 debug 字符串，所以无法从源码精确追出每个 `VVCAM_ISP_CID_*` 到具体寄存器 offset 的映射。

## 2. 主要源码位置

| 模块 | 文件 | 作用 |
| --- | --- | --- |
| video node 注册 | `v4l2/video/vvcam_video_register.c` | 注册 `/dev/videoX`、V4L2 ioctl、vb2 queue、media entity |
| video platform/media device | `v4l2/video/vvcam_video_driver.c` | 注册 media_device/v4l2_device，建立 media link |
| video event | `v4l2/video/vvcam_video_event.c` | `CREATE_PIPELINE` / `DESTROY_PIPELINE` private event |
| common private ioctl | `v4l2/common/vvcam_v4l2_common.h` | 定义 `VVCAM_PAD_*` private subdev ioctl |
| ISP subdev | `v4l2/isp/vvcam_isp_driver.c` | 接收 `VVCAM_PAD_*`，注册 subdev、ctrl handler、pad ops |
| ISP event | `v4l2/isp/vvcam_isp_event.c` | 把 subdev 操作转成 `VVCAM_ISP_EVENT_*` |
| ISP ctrl registry | `v4l2/isp/isp_ctrl/vvcam_isp_ctrl.c` | 初始化各 ISP 模块 control |
| GE ctrl 示例 | `v4l2/isp/isp_ctrl/ge/ge/vvcam_isp_ge.c` | GE 模块 control ops 示例 |
| 底层 ISP misc 设备 | `isp/vvcam_isp_driver.c` | `/dev/vvcam-isp.0`，提供 reset/read_reg/write_reg |
| 底层寄存器访问 | `isp/vvcam_isp_hal.c` | `readl/writel` |
| 用户态 daemon | `isp_media_server_debian` | 二进制，处理 V4L2 event 和真实 ISP HAL |

## 3. 主线 V4L2/MC 外壳

### 3.1 video_device 外壳

`vvcam_video_register()` 为每个 port 注册一个标准 capture video node。

源码位置：`buildroot-overlay/package/vvcam/v4l2/video/vvcam_video_register.c`

```c
int vvcam_video_register(struct vvcam_media_dev *vvcam_mdev, int port)
{
    int ret = 0;
    struct vvcam_video_dev *vvcam_vdev;

    vvcam_vdev = devm_kzalloc(vvcam_mdev->dev,
                sizeof(struct vvcam_video_dev), GFP_KERNEL);
    if (!vvcam_vdev)
        return -ENOMEM;

    mutex_init(&vvcam_vdev->video_lock);
    vvcam_vdev->vvcam_mdev = vvcam_mdev;
    vvcam_vdev->video_params = vvcam_mdev->video_params[port];

    vvcam_vdev->video = video_device_alloc();
    if (!vvcam_vdev->video) {
        dev_err(vvcam_mdev->dev, "could not alloc video device\n");
        ret = -ENOMEM;
        goto error_free_vvcam_vdev;
    }

    snprintf(vvcam_vdev->video->name, sizeof(vvcam_vdev->video->name),
                "%s.%d.%d", VVCAM_VIDEO_NAME, vvcam_mdev->id, port);

    vvcam_vdev->video->fops          = &vvcam_video_fops;
    vvcam_vdev->video->ioctl_ops     = &vvcam_video_ioctl_ops;
    vvcam_vdev->video->release       = video_device_release_empty;
    vvcam_vdev->video->v4l2_dev      = &vvcam_mdev->v4l2_dev;
    vvcam_vdev->video->device_caps   = V4L2_CAP_VIDEO_CAPTURE |
                                       V4L2_CAP_STREAMING;
    vvcam_vdev->video->minor         = -1;

    video_set_drvdata(vvcam_vdev->video, vvcam_vdev);
```

这使用户态看到标准 `/dev/videoX`，并可以使用：

```text
VIDIOC_QUERYCAP
VIDIOC_ENUM_FMT
VIDIOC_G_FMT
VIDIOC_S_FMT
VIDIOC_REQBUFS
VIDIOC_QBUF
VIDIOC_DQBUF
VIDIOC_STREAMON
VIDIOC_STREAMOFF
VIDIOC_S_CTRL
VIDIOC_G_CTRL
...
```

### 3.2 Media Controller entity/pad 外壳

同一个 `video_device` 也被挂成 Media Controller entity，并带一个 sink pad。

```c
    vvcam_vdev->video->entity.name     = vvcam_vdev->video->name;
    vvcam_vdev->video->entity.obj_type = MEDIA_ENTITY_TYPE_VIDEO_DEVICE;
    vvcam_vdev->video->entity.function = MEDIA_ENT_F_IO_V4L;
    vvcam_vdev->video->entity.ops      = &vvcam_video_entity_ops;
    vvcam_vdev->pad.flags              = MEDIA_PAD_FL_SINK;

    ret = media_entity_pads_init(&vvcam_vdev->video->entity, 1, &vvcam_vdev->pad);
```

从 MC graph 看，video node 是 graph 的 capture 终点：

```text
remote subdev source pad ---> vvcam-video.X.Y sink pad 0 ---> /dev/videoX
```

### 3.3 vb2 queue 外壳

video node 使用标准 vb2 queue 管理用户态 buffer。

源码位置：`v4l2/video/vvcam_video_register.c`

```c
static int vvcam_video_queue_init(struct vvcam_video_dev *vvcam_vdev)
{
    int ret = 0;
    struct vb2_queue *queue;

    queue = &vvcam_vdev->queue;
    queue->type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    queue->io_modes = VB2_MMAP | VB2_USERPTR | VB2_DMABUF;
    queue->drv_priv = vvcam_vdev;
    queue->ops = &vvcam_video_queue_ops;
    queue->mem_ops = &vb2_dma_contig_memops;
    queue->buf_struct_size = sizeof(struct vvcam_vb2_buffer);
    queue->timestamp_flags = V4L2_BUF_FLAG_TIMESTAMP_MONOTONIC;
    queue->lock = &vvcam_vdev->video_lock;
    queue->dev = vvcam_vdev->vvcam_mdev->dev;

    ret = vb2_queue_init(queue);
    if (ret) {
        dev_err(vvcam_vdev->vvcam_mdev->dev, "vb2 queue init failed\n");
        return ret;
    }
    vvcam_vdev->video->queue = queue;

    return 0;
}
```

用户态看到的是标准 V4L2 streaming buffer 模型，但 buffer 进入后端时会被转成 `VVCAM_PAD_BUF_QUEUE`。

## 4. Media graph 与 remote subdev 查找

video 层不直接知道后端具体是谁，而是通过 media link 找 remote subdev。

源码位置：`v4l2/video/vvcam_video_register.c`

```c
static struct v4l2_subdev *vvcam_video_remote_subdev(struct vvcam_video_dev *vvcam_vdev)
{
    struct media_pad *pad;
    struct v4l2_subdev *subdev;

#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 0, 0)
    pad = media_pad_remote_pad_first(&vvcam_vdev->pad);
#else
    pad = media_entity_remote_pad(&vvcam_vdev->pad);
#endif
    if (!pad || !is_media_entity_v4l2_subdev(pad->entity))
        return NULL;

    subdev = media_entity_to_v4l2_subdev(pad->entity);

    return subdev;
}
```

这个函数是后续所有 `v4l2_subdev_call()` 的基础。

在 K230 当前 Makefile 中启用了：

```makefile
ccflags-y += -DVVCAM_PLATFORM_REGISTER
```

所以 graph 默认是静态 C 表建立，而不是纯 DT graph。静态 link 表位于：

`v4l2/video/vvcam_pipeline_link.h`

```c
extern struct v4l2_subdev *g_vvcam_isp_subdev[VVCAM_ISP_DEV_MAX];

static struct vvcam_v4l2_link pipeline0[] = {
    {
        .local_is_video = true,
        .video_index = 0,
        .local_pad = 0,
        .remote_subdev = &g_vvcam_isp_subdev[0],
        .remote_pad = 1,
    },
    {
        .local_is_video = true,
        .video_index = 1,
        .local_pad = 0,
        .remote_subdev = &g_vvcam_isp_subdev[0],
        .remote_pad = 2,
    },
    {
        .local_is_video = true,
        .video_index = 2,
        .local_pad = 0,
        .remote_subdev = &g_vvcam_isp_subdev[0],
        .remote_pad = 3,
    },
    {
        .local_is_video = true,
        .video_index = 3,
        .local_pad = 0,
        .remote_subdev = &g_vvcam_isp_subdev[0],
        .remote_pad = 4,
    },
};
```

link 创建逻辑位于 `v4l2/video/vvcam_video_driver.c`：

```c
source = &sd->entity;
source_pad = vvcam_mdev->pipeline_link[i].remote_pad;
sink =&vdev->entity;
sink_pad = 0;

ret = media_create_pad_link(source, source_pad, sink, sink_pad,
                            MEDIA_LNK_FL_ENABLED);
```

## 5. `VVCAM_PAD_*` 私有 ioctl 定义

这些命令定义在：

`v4l2/common/vvcam_v4l2_common.h`

```c
struct vvcam_pad_reqbufs {
    int pad;
    uint32_t num_buffers;
};

struct vvcam_pad_buf {
    uint32_t pad;
    struct vvcam_vb2_buffer *buf;
};

struct vvcam_pad_stream_status {
    uint32_t pad;
    uint32_t status;
};

struct vvcam_pad_queryctrl {
    uint32_t pad;
    struct v4l2_queryctrl *query_ctrl;
};

struct vvcam_pad_query_ext_ctrl {
    uint32_t pad;
    struct v4l2_query_ext_ctrl *query_ext_ctrl;
};

struct vvcam_pad_control {
    uint32_t pad;
    struct v4l2_control *control;
};

struct vvcam_pad_ext_controls {
    uint32_t pad;
    struct v4l2_ext_controls *ext_controls;
};

struct vvcam_pad_querymenu {
    uint32_t pad;
    struct v4l2_querymenu *querymenu;
};

#define VVCAM_PAD_REQUBUFS       _IOWR('V',  BASE_VIDIOC_PRIVATE + 0, struct vvcam_pad_reqbufs)
#define VVCAM_PAD_BUF_DONE       _IOWR('V',  BASE_VIDIOC_PRIVATE + 1, struct vvcam_pad_buf)
#define VVCAM_PAD_BUF_QUEUE      _IOWR('V',  BASE_VIDIOC_PRIVATE + 2, struct vvcam_pad_buf)
#define VVCAM_PAD_S_STREAM       _IOWR('V',  BASE_VIDIOC_PRIVATE + 3, struct vvcam_pad_stream_status)

#define VVCAM_PAD_QUERYCTRL      _IOWR('V',  BASE_VIDIOC_PRIVATE + 4, struct vvcam_pad_queryctrl)
#define VVCAM_PAD_QUERY_EXT_CTRL _IOWR('V',  BASE_VIDIOC_PRIVATE + 5, struct vvcam_pad_query_ext_ctrl)
#define VVCAM_PAD_G_CTRL         _IOWR('V',  BASE_VIDIOC_PRIVATE + 6, struct vvcam_pad_control)
#define VVCAM_PAD_S_CTRL         _IOWR('V',  BASE_VIDIOC_PRIVATE + 7, struct vvcam_pad_control)
#define VVCAM_PAD_G_EXT_CTRLS    _IOWR('V',  BASE_VIDIOC_PRIVATE + 8, struct vvcam_pad_ext_controls)
#define VVCAM_PAD_S_EXT_CTRLS    _IOWR('V',  BASE_VIDIOC_PRIVATE + 9, struct vvcam_pad_ext_controls)
#define VVCAM_PAD_TRY_EXT_CTRLS  _IOWR('V',  BASE_VIDIOC_PRIVATE + 10, struct vvcam_pad_ext_controls)
#define VVCAM_PAD_QUERYMENU      _IOWR('V',  BASE_VIDIOC_PRIVATE + 11, struct vvcam_pad_querymenu)
```

注意：

- 这些不是应用直接对 `/dev/videoX` 调用的 ioctl。
- 它们是 video driver 内部通过 `v4l2_subdev_call(subdev, core, ioctl, ...)` 发给 remote subdev 的私有命令。

## 6. video 层如何把标准 V4L2 ioctl 转成 `VVCAM_PAD_*`

### 6.1 `VIDIOC_S_CTRL -> VVCAM_PAD_S_CTRL`

源码位置：`v4l2/video/vvcam_video_register.c`

```c
static int vvcam_vidioc_s_ctrl(struct file *file, void *fh,
                 struct v4l2_control *a)
{
    struct vvcam_video_dev *vvcam_vdev = video_drvdata(file);
    struct media_pad *pad;
    struct v4l2_subdev *subdev;
    struct vvcam_pad_control pad_control;
    int ret;

    subdev = vvcam_video_remote_subdev(vvcam_vdev);
    if (subdev) {
#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 0, 0)
        pad = media_pad_remote_pad_first(&vvcam_vdev->pad);
#else
        pad = media_entity_remote_pad(&vvcam_vdev->pad);
#endif
        memset(&pad_control, 0, sizeof(pad_control));
        pad_control.pad = pad->index;
        pad_control.control = a;
        ret = v4l2_subdev_call(subdev, core, ioctl,
                        VVCAM_PAD_S_CTRL, &pad_control);

    } else {
        return -ENOTTY;
    }

    return ret;
}
```

### 6.2 `VIDIOC_REQBUFS -> VVCAM_PAD_REQUBUFS`

```c
static int vvcam_videoc_reqbufs(struct file *file, void *priv,
                        struct v4l2_requestbuffers *p)
{
    struct vvcam_video_dev *vvcam_vdev = video_drvdata(file);
    struct media_pad *pad;
    struct v4l2_subdev *subdev;
    struct vvcam_pad_reqbufs pad_requbufs;

    int ret;

    ret = vvcam_video_try_create_pipeline(vvcam_vdev);
    if (ret)
        return ret;

    ret = vb2_ioctl_reqbufs(file, priv, p);
    if (ret)
        return ret;

    subdev = vvcam_video_remote_subdev(vvcam_vdev);
    if (subdev) {
#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 0, 0)
        pad = media_pad_remote_pad_first(&vvcam_vdev->pad);
#else
        pad = media_entity_remote_pad(&vvcam_vdev->pad);
#endif
        memset(&pad_requbufs, 0, sizeof(pad_requbufs));
        pad_requbufs.pad = pad->index;
        pad_requbufs.num_buffers = p->count;
        v4l2_subdev_call(subdev, core, ioctl,
                         VVCAM_PAD_REQUBUFS, &pad_requbufs);
    }

    return ret;
}
```

### 6.3 `QBUF -> VVCAM_PAD_BUF_QUEUE`

`QBUF` 先进入 vb2，随后触发 `buf_queue` callback。

```c
static void vvcam_video_vb2_buf_queue(struct vb2_buffer *vb)
{
    struct vvcam_video_dev *vvcam_vdev = vb->vb2_queue->drv_priv;
    struct vb2_v4l2_buffer *vbuf = to_vb2_v4l2_buffer(vb);
    struct vvcam_vb2_buffer *buf = container_of(vbuf,
                          struct vvcam_vb2_buffer, vb);
    struct media_pad *pad;
    struct v4l2_subdev *subdev;
    struct vvcam_pad_buf pad_buf;

    subdev = vvcam_video_remote_subdev(vvcam_vdev);
    if (subdev) {
#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 0, 0)
        pad = media_pad_remote_pad_first(&vvcam_vdev->pad);
#else
        pad = media_entity_remote_pad(&vvcam_vdev->pad);
#endif
        memset(&pad_buf, 0, sizeof(pad_buf));
        pad_buf.pad = pad->index;
        pad_buf.buf = buf;
        v4l2_subdev_call(subdev, core, ioctl,
                         VVCAM_PAD_BUF_QUEUE, &pad_buf);
    }
}
```

### 6.4 `STREAMON/STREAMOFF -> VVCAM_PAD_S_STREAM`

```c
static int vvcam_video_vb2_start_streaming(struct vb2_queue *queue,
                                        unsigned int count)
{
    struct vvcam_video_dev *vvcam_vdev = queue->drv_priv;
    struct media_pad *pad;
    struct v4l2_subdev *subdev;
    struct vvcam_pad_stream_status stream_status;
    int ret = -EINVAL;

    subdev = vvcam_video_remote_subdev(vvcam_vdev);
    if (subdev) {
#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 0, 0)
        pad = media_pad_remote_pad_first(&vvcam_vdev->pad);
#else
        pad = media_entity_remote_pad(&vvcam_vdev->pad);
#endif
        memset(&stream_status, 0, sizeof(stream_status));
        stream_status.pad = pad->index;
        stream_status.status = 1;
        ret = v4l2_subdev_call(subdev, core, ioctl,
                               VVCAM_PAD_S_STREAM, &stream_status);
    }

    return ret;
}
```

`STREAMOFF` 同样调用 `VVCAM_PAD_S_STREAM`，只是 `status = 0`。

## 7. `VVCAM_PAD_*` 在 ISP subdev 中的实现

`v4l2_subdev_call(subdev, core, ioctl, cmd, arg)` 最终调用 remote subdev 的：

```c
subdev->ops->core->ioctl(subdev, cmd, arg)
```

在当前代码中，接收者是：

`v4l2/isp/vvcam_isp_driver.c`

```c
static long vvcam_isp_priv_ioctl(struct v4l2_subdev *sd,
                                unsigned int cmd, void *arg)
{
    int ret = -EINVAL;
    switch (cmd) {
        case VIDIOC_QUERYCAP:
            ret = vvcam_isp_querycap(sd, arg);
            break;
        case VVCAM_PAD_REQUBUFS:
            ret = vvcam_isp_pad_requbufs(sd, arg);
            break;
        case VVCAM_PAD_BUF_QUEUE:
            ret = vvcam_isp_pad_buf_queue(sd, arg);
            break;
        case VVCAM_PAD_S_STREAM:
            ret = vvcam_isp_pad_s_stream(sd, arg);
            break;
        case VVCAM_ISP_IOC_BUFDONE:
            ret = vvcam_isp_buf_done(sd, arg);
            break;
        case VVCAM_PAD_QUERYCTRL:
            ret = vvcam_isp_queryctrl(sd, arg);
            break;
        case VVCAM_PAD_QUERY_EXT_CTRL:
            ret = vvcam_isp_query_ext_ctrl(sd, arg);
            break;
        case VVCAM_PAD_G_CTRL:
            ret = vvcam_isp_g_ctrl(sd, arg);
            break;
        case VVCAM_PAD_S_CTRL:
            ret = vvcam_isp_s_ctrl(sd, arg);
            break;
        case VVCAM_PAD_G_EXT_CTRLS:
            ret = vvcam_isp_g_ext_ctrls(sd, arg);
            break;
        case VVCAM_PAD_S_EXT_CTRLS:
            ret = vvcam_isp_s_ext_ctrls(sd, arg);
            break;
        case VVCAM_PAD_TRY_EXT_CTRLS:
            ret = vvcam_isp_try_ext_ctrls(sd, arg);
            break;
        case VVCAM_PAD_QUERYMENU:
            ret = vvcam_isp_querymenu(sd, arg);
            break;
        default:
            break;
    }

    return ret;
}
```

该函数挂在 subdev core ops：

```c
static struct v4l2_subdev_core_ops vvcam_isp_core_ops = {
    .ioctl             = vvcam_isp_priv_ioctl,
    .subscribe_event   = vvcam_isp_subscribe_event,
    .unsubscribe_event = v4l2_event_subdev_unsubscribe,
};
```

因此完整内部调用形式是：

```text
vvcam_video_register.c
    v4l2_subdev_call(subdev, core, ioctl, VVCAM_PAD_XXX, arg)
        |
        v
vvcam_isp_driver.c
    vvcam_isp_priv_ioctl(sd, VVCAM_PAD_XXX, arg)
        |
        v
    switch(cmd)
        |
        v
    vvcam_isp_pad_xxx() / vvcam_isp_s_ctrl() / ...
```

## 8. 典型 control 链路：`VIDIOC_S_CTRL -> GE threshold`

这里以 `isp_ge_threshold` 为例。

### 8.1 control 定义

源码位置：

`v4l2/isp/isp_ctrl/ge/ge/vvcam_isp_ge.h`

```c
#define VVCAM_ISP_CID_GE_ENABLE             (VVCAM_ISP_CID_GE_BASE + 0x0000)
#define VVCAM_ISP_CID_GE_RESET              (VVCAM_ISP_CID_GE_BASE + 0x0001)
#define VVCAM_ISP_CID_GE_THRESHOLD          (VVCAM_ISP_CID_GE_BASE + 0x0002)
```

源码位置：

`v4l2/isp/isp_ctrl/ge/ge/vvcam_isp_ge.c`

```c
static int vvcam_isp_ge_s_ctrl(struct v4l2_ctrl *ctrl)
{
    int ret = 0;
    struct vvcam_isp_dev *isp_dev =
        container_of(ctrl->handler, struct vvcam_isp_dev, ctrl_handler);

    switch (ctrl->id)
    {
        case VVCAM_ISP_CID_GE_ENABLE:
        case VVCAM_ISP_CID_GE_RESET:
        case VVCAM_ISP_CID_GE_THRESHOLD:
            ret = vvcam_isp_s_ctrl_event(isp_dev, isp_dev->ctrl_pad, ctrl);
            break;

        default:
            dev_err(isp_dev->dev, "unknow v4l2 ctrl id %d\n", ctrl->id);
            return -EACCES;
    }

    return ret;
}

static int vvcam_isp_ge_g_ctrl(struct v4l2_ctrl *ctrl)
{
    int ret = 0;
    struct vvcam_isp_dev *isp_dev =
        container_of(ctrl->handler, struct vvcam_isp_dev, ctrl_handler);

    switch (ctrl->id)
    {
        case VVCAM_ISP_CID_GE_ENABLE:
        case VVCAM_ISP_CID_GE_RESET:
        case VVCAM_ISP_CID_GE_THRESHOLD:
            ret = vvcam_isp_g_ctrl_event(isp_dev, isp_dev->ctrl_pad, ctrl);
            break;

        default:
            dev_err(isp_dev->dev, "unknow v4l2 ctrl id %d\n", ctrl->id);
            return -EACCES;
    }

    return ret;
}

static const struct v4l2_ctrl_ops vvcam_isp_ge_ctrl_ops = {
    .s_ctrl = vvcam_isp_ge_s_ctrl,
    .g_volatile_ctrl = vvcam_isp_ge_g_ctrl,
};
```

control 配置：

```c
const struct v4l2_ctrl_config vvcam_isp_ge_ctrls[] = {
    {
        .ops  = &vvcam_isp_ge_ctrl_ops,
        .id   = VVCAM_ISP_CID_GE_ENABLE,
        .type = V4L2_CTRL_TYPE_BOOLEAN,
        .flags= V4L2_CTRL_FLAG_VOLATILE | V4L2_CTRL_FLAG_EXECUTE_ON_WRITE,
        .name = "isp_ge_enable",
        .step = 1,
        .min  = 0,
        .max  = 1,
    },
    {
        .ops  = &vvcam_isp_ge_ctrl_ops,
        .id   = VVCAM_ISP_CID_GE_RESET,
        .type = V4L2_CTRL_TYPE_BOOLEAN,
        .flags= V4L2_CTRL_FLAG_VOLATILE | V4L2_CTRL_FLAG_EXECUTE_ON_WRITE,
        .name = "isp_ge_reset",
        .step = 1,
        .min  = 0,
        .max  = 1,
    },
    {
        /* float 0.0 ~ 511.992 */
        .ops  = &vvcam_isp_ge_ctrl_ops,
        .id   = VVCAM_ISP_CID_GE_THRESHOLD,
        .type = V4L2_CTRL_TYPE_INTEGER,
        .flags= V4L2_CTRL_FLAG_VOLATILE | V4L2_CTRL_FLAG_EXECUTE_ON_WRITE,
        .name = "isp_ge_threshold",
        .step = 1,
        .min  = 0,
        .max  = 65535,
    },
};
```

注册 control：

```c
int vvcam_isp_ge_ctrl_create(struct vvcam_isp_dev *isp_dev)
{
    int i;

    for (i = 0; i < ARRAY_SIZE(vvcam_isp_ge_ctrls); i++) {
        v4l2_ctrl_new_custom(&isp_dev->ctrl_handler,
                            &vvcam_isp_ge_ctrls[i], NULL);
        if (isp_dev->ctrl_handler.error) {
            dev_err( isp_dev->dev, "reigster isp ge ctrl %s failed %d.\n",
                vvcam_isp_ge_ctrls[i].name, isp_dev->ctrl_handler.error);
        }
    }

    return 0;
}
```

### 8.2 control handler 初始化

所有 ISP 模块 control 在 `vvcam_isp_ctrl_init()` 中统一注册。

源码位置：

`v4l2/isp/isp_ctrl/vvcam_isp_ctrl.c`

```c
int vvcam_isp_ctrl_init(struct vvcam_isp_dev *isp_dev)
{
    uint32_t ctrl_count = 0;

#if defined(ISP_GE)
    ctrl_count += vvcam_isp_ge_ctrl_count();
#endif

    v4l2_ctrl_handler_init(&isp_dev->ctrl_handler,  ctrl_count);

#if defined(ISP_GE)
    vvcam_isp_ge_ctrl_create(isp_dev);
#endif

    isp_dev->sd.ctrl_handler = &isp_dev->ctrl_handler;

    return 0;
}
```

ISP subdev probe 中调用：

```c
pm_runtime_enable(&pdev->dev);
vvcam_isp_ctrl_init(isp_dev);
```

### 8.3 `VVCAM_PAD_S_CTRL` 到 `v4l2_s_ctrl`

源码位置：

`v4l2/isp/vvcam_isp_driver.c`

```c
static int vvcam_isp_s_ctrl(struct v4l2_subdev *sd,void *arg)
{
    int ret;
    struct vvcam_isp_dev *isp_dev = v4l2_get_subdevdata(sd);
    struct vvcam_pad_control *pad_ctrl = (struct vvcam_pad_control *)arg;

    mutex_lock(&isp_dev->ctrl_lock);
    isp_dev->ctrl_pad = pad_ctrl->pad;
    ret = v4l2_s_ctrl(NULL, &isp_dev->ctrl_handler, pad_ctrl->control);
    mutex_unlock(&isp_dev->ctrl_lock);

    return ret;
}
```

这里不会直接写寄存器，而是把 control 交给 V4L2 control framework。framework 根据 `ctrl->id` 找到 GE control，然后调用 `vvcam_isp_ge_s_ctrl()`。

### 8.4 GE control 到 `VVCAM_ISP_EVENT_S_CTRL`

`vvcam_isp_ge_s_ctrl()` 最后调用：

```c
ret = vvcam_isp_s_ctrl_event(isp_dev, isp_dev->ctrl_pad, ctrl);
```

源码位置：

`v4l2/isp/vvcam_isp_event.c`

```c
int vvcam_isp_s_ctrl_event(struct vvcam_isp_dev *isp_dev,
            int pad, struct v4l2_ctrl *ctrl)
{
    struct vvcam_isp_event_pkg *event_pkg = isp_dev->event_shm.virt_addr;
    int ret;
    struct vvcam_isp_ctrl *isp_ctrl;

    mutex_lock(&isp_dev->event_shm.event_lock);

    isp_ctrl = (struct vvcam_isp_ctrl *)event_pkg->data;
    isp_ctrl->cid = ctrl->id;
    isp_ctrl->size = ctrl->elem_size * ctrl->elems;
    memcpy(isp_ctrl->data, ctrl->p_new.p_u8, isp_ctrl->size);

    event_pkg->head.pad = pad;
    event_pkg->head.dev = isp_dev->id;
    event_pkg->head.eid = VVCAM_ISP_EVENT_S_CTRL;
    event_pkg->head.shm_addr = isp_dev->event_shm.phy_addr;
    event_pkg->head.shm_size = isp_dev->event_shm.size;
    event_pkg->head.data_size = sizeof(isp_ctrl) + isp_ctrl->size;
    event_pkg->ack = 0;
    event_pkg->result = 0;

    ret = vvcam_isp_post_event(&isp_dev->sd, event_pkg);

    mutex_unlock(&isp_dev->event_shm.event_lock);

    return ret;
}
```

事件格式定义在 `v4l2/isp/vvcam_isp_event.h`：

```c
#define  VVCAM_ISP_DEAMON_EVENT (V4L2_EVENT_PRIVATE_START + 2000)

enum vvcam_isp_vevent_id {
    VVCAM_ISP_EVENT_SET_FMT,
    VVCAM_ISP_EVENT_REQBUFS,
    VVCAM_ISP_EVENT_QBUF,
    VVCAM_ISP_EVENT_BUF_DONE,
    VVCAM_ISP_EVENT_STREAMON,
    VVCAM_ISP_EVENT_STREAMOFF,
    VVCAM_ISP_EVENT_S_CTRL,
    VVCAM_ISP_EVENT_G_CTRL,
    VVCAM_ISP_EVENT_S_SELECTION,
    VVCAM_ISP_EVENT_MAX,
};

struct vvcam_isp_ctrl {
    uint32_t cid;
    uint32_t size;
#ifdef __KERNEL__
    uint8_t data[0];
#endif
};

struct vvcam_isp_event_pkg_head {
    uint32_t pad;
    uint8_t  dev;
    uint32_t eid;
    uint64_t shm_addr;
    uint32_t shm_size;
    uint32_t data_size;
};

struct vvcam_isp_event_pkg {
    struct vvcam_isp_event_pkg_head head;
    uint8_t  ack;
    int32_t  result;
    uint8_t data[2048];
};
```

所以 GE threshold 设置在 shared memory 中变成：

```text
head.eid  = VVCAM_ISP_EVENT_S_CTRL
head.pad  = remote ISP pad index
head.dev  = ISP id
data.cid  = VVCAM_ISP_CID_GE_THRESHOLD
data.size = sizeof(integer)
data.data = new threshold value
```

### 8.5 `vvcam_isp_post_event()` 发给 daemon

源码位置：

`v4l2/isp/vvcam_isp_event.c`

```c
int vvcam_isp_post_event(struct v4l2_subdev *sd, struct vvcam_isp_event_pkg *event_pkg)
{
    struct v4l2_event event;
    int timeout_ms = 200000;
    int i = 0;

    memset(&event, 0, sizeof(event));

    event.type   = VVCAM_ISP_DEAMON_EVENT;
    event.id     = event_pkg->head.eid;
    memcpy(event.u.data, &event_pkg->head, sizeof(event_pkg->head));

    if (!vvcam_isp_event_subscribed(sd, event.type, event.id)) {
        dev_err(sd->dev, "post event %d not subscribed\n", event.id);
        return -EINVAL;
    }

    v4l2_event_queue(sd->devnode, &event);

    for (i = 0; i < timeout_ms; i++) {
        if (event_pkg->ack) {
            break;
        }
        usleep_range(5, 10);
    }

    if (event_pkg->ack == 0) {
        dev_err(sd->dev, "post event %d time out\n", event.id);
        return -EIO;
    }

    if (event_pkg->result) {
        dev_err(sd->dev, "post event %d return error\n", event.id);
        return -EINVAL;
    }

    return 0;
}
```

这说明：

- daemon 必须订阅 `VVCAM_ISP_DEAMON_EVENT`。
- kernel 发 event 后同步等待 daemon 写 `ack`。
- daemon 失败时通过 `result` 返回错误。
- 这里是 busy wait + `usleep_range()`，不是典型主线内核异步完成模型。

## 9. `G_CTRL` 方向

`G_CTRL` 与 `S_CTRL` 类似，但数据方向相反。

源码位置：

`v4l2/isp/vvcam_isp_driver.c`

```c
static int vvcam_isp_g_ctrl(struct v4l2_subdev *sd,void *arg)
{
    int ret;
    struct vvcam_isp_dev *isp_dev = v4l2_get_subdevdata(sd);
    struct vvcam_pad_control *pad_ctrl = (struct vvcam_pad_control *)arg;

    mutex_lock(&isp_dev->ctrl_lock);
    isp_dev->ctrl_pad = pad_ctrl->pad;
    ret = v4l2_g_ctrl(&isp_dev->ctrl_handler, pad_ctrl->control);
    mutex_unlock(&isp_dev->ctrl_lock);

    return ret;
}
```

GE 模块：

```c
static int vvcam_isp_ge_g_ctrl(struct v4l2_ctrl *ctrl)
{
    int ret = 0;
    struct vvcam_isp_dev *isp_dev =
        container_of(ctrl->handler, struct vvcam_isp_dev, ctrl_handler);

    switch (ctrl->id)
    {
        case VVCAM_ISP_CID_GE_ENABLE:
        case VVCAM_ISP_CID_GE_RESET:
        case VVCAM_ISP_CID_GE_THRESHOLD:
            ret = vvcam_isp_g_ctrl_event(isp_dev, isp_dev->ctrl_pad, ctrl);
            break;

        default:
            dev_err(isp_dev->dev, "unknow v4l2 ctrl id %d\n", ctrl->id);
            return -EACCES;
    }

    return ret;
}
```

event 发送和返回值拷贝：

```c
int vvcam_isp_g_ctrl_event(struct vvcam_isp_dev *isp_dev,
            int pad, struct v4l2_ctrl *ctrl)
{
    struct vvcam_isp_event_pkg *event_pkg = isp_dev->event_shm.virt_addr;
    int ret = 0;
    struct vvcam_isp_ctrl *isp_ctrl;

    mutex_lock(&isp_dev->event_shm.event_lock);

    isp_ctrl = (struct vvcam_isp_ctrl *)event_pkg->data;
    isp_ctrl->cid = ctrl->id;
    isp_ctrl->size = ctrl->elem_size * ctrl->elems;

    event_pkg->head.pad = pad;
    event_pkg->head.dev = isp_dev->id;
    event_pkg->head.eid = VVCAM_ISP_EVENT_G_CTRL;
    event_pkg->head.shm_addr = isp_dev->event_shm.phy_addr;
    event_pkg->head.shm_size = isp_dev->event_shm.size;
    event_pkg->head.data_size = sizeof(isp_ctrl) + isp_ctrl->size;
    event_pkg->ack = 0;
    event_pkg->result = 0;

    ret = vvcam_isp_post_event(&isp_dev->sd, event_pkg);

    if (ret == 0) {
         memcpy(ctrl->p_new.p_u8, event_pkg->data + sizeof(isp_ctrl),
            isp_ctrl->size);
    }

    mutex_unlock(&isp_dev->event_shm.event_lock);

    return ret;
}
```

抽象流程：

```text
VIDIOC_G_CTRL
    -> VVCAM_PAD_G_CTRL
    -> vvcam_isp_g_ctrl()
    -> v4l2_g_ctrl()
    -> module g_volatile_ctrl
    -> VVCAM_ISP_EVENT_G_CTRL
    -> daemon 读取寄存器或内部状态
    -> daemon 写回 shared memory
    -> kernel copy back to ctrl
```

## 10. buffer/stream cmd 的落地方式

### 10.1 REQBUFS

```c
static int vvcam_isp_pad_requbufs(struct v4l2_subdev *sd, void *arg)
{
    struct vvcam_pad_reqbufs *pad_requbufs = (struct vvcam_pad_reqbufs *)arg;
    struct vvcam_isp_dev *isp_dev = v4l2_get_subdevdata(sd);

    return vvcam_isp_requebus_event(isp_dev,
                                    pad_requbufs->pad,
                                    pad_requbufs->num_buffers);
}
```

转成：

```text
VVCAM_ISP_EVENT_REQBUFS
```

### 10.2 QBUF

```c
static int vvcam_isp_pad_buf_queue(struct v4l2_subdev *sd, void *arg)
{
    struct vvcam_pad_buf *pad_buf = (struct vvcam_pad_buf *)arg;
    struct vvcam_isp_dev *isp_dev = v4l2_get_subdevdata(sd);
    int ret;
    unsigned long flags;
    struct vvcam_isp_pad_data *cur_pad;

    cur_pad = &isp_dev->pad_data[pad_buf->pad];

    spin_lock_irqsave(&cur_pad->qlock, flags);
    list_add_tail(&pad_buf->buf->list, &cur_pad->queue);
    spin_unlock_irqrestore(&cur_pad->qlock, flags);

    ret = vvcam_isp_qbuf_event(isp_dev, pad_buf->pad, pad_buf->buf);

    return ret;
}
```

转成：

```text
VVCAM_ISP_EVENT_QBUF
```

event payload 包含：

```c
struct vvcam_isp_buf {
    uint32_t pad;
    uint32_t index;
    uint32_t num_planes;
    struct vvcam_isp_plane planes[VIDEO_MAX_PLANES];
};
```

其中 `planes[i].dma_addr` 和 `planes[i].size` 来自 vb2 DMA-contig buffer。

### 10.3 STREAMON/STREAMOFF

```c
static int vvcam_isp_pad_s_stream(struct v4l2_subdev *sd, void *arg)
{
    struct vvcam_pad_stream_status *pad_stream = (struct vvcam_pad_stream_status *)arg;
    struct vvcam_isp_dev *isp_dev = v4l2_get_subdevdata(sd);
    int ret;

    isp_dev->pad_data[pad_stream->pad].stream = pad_stream->status;

    if (pad_stream->status == 0 ) {
        INIT_LIST_HEAD(&isp_dev->pad_data[pad_stream->pad].queue);
    }
    ret = vvcam_isp_s_stream_event(isp_dev,
                                   pad_stream->pad,
                                   pad_stream->status);

    return ret;
}
```

转成：

```text
status = 1 -> VVCAM_ISP_EVENT_STREAMON
status = 0 -> VVCAM_ISP_EVENT_STREAMOFF
```

## 11. runtime pipeline create/destroy

video 层还有一组单独的 private event，用于 runtime pipeline 生命周期。

源码位置：

`v4l2/video/vvcam_video_event.h`

```c
#define  VVCAM_VIDEO_DEAMON_EVENT (V4L2_EVENT_PRIVATE_START + 1000)

enum vvcam_video_event_id {
    VVCAM_VEVENT_CREATE_PIPELINE = 0,
    VVCAM_VEVENT_DESTROY_PIPELINE,
    VVCAM_VEVENT_MAX,
};
```

触发点：

`v4l2/video/vvcam_video_register.c`

```c
static int vvcam_video_try_create_pipeline(struct vvcam_video_dev *vvcam_vdev)
{
    int ret;
    struct media_pad *pad;
    struct v4l2_subdev *subdev;
    struct v4l2_subdev_format sd_fmt;
    struct v4l2_subdev_pad_config pad_cfg;
    struct v4l2_subdev_state sd_state = {
        .pads = &pad_cfg,
    };

    if (vvcam_vdev->pipeline) {
        return 0;
    }
    ret = vvcam_video_create_pipeline_event(vvcam_vdev);
    if (ret) {
        return ret;
    }

    subdev = vvcam_video_remote_subdev(vvcam_vdev);
    if (!subdev) {
        return -EINVAL;
    }

    pad = media_pad_remote_pad_first(&vvcam_vdev->pad);

    memset(&sd_fmt, 0, sizeof(sd_fmt));
    sd_fmt.pad = pad->index;
    sd_fmt.which = V4L2_SUBDEV_FORMAT_TRY;

    ret = v4l2_subdev_call(subdev, pad, get_fmt, &sd_state, &sd_fmt);
    if (ret) {
        return ret;
    }

    ret = vvcam_video_mfmt_to_vfmt(&sd_fmt, &vvcam_vdev->format);
    if (ret) {
        return ret;
    }

    vvcam_vdev->pipeline = 1;

    return 0;
}
```

`CREATE_PIPELINE` 会在 `ENUM_FMT`、`TRY_FMT`、`S_FMT`、`G_FMT`、`REQBUFS` 等路径中被提前触发。

销毁：

```c
static int vvcam_video_release(struct file *file)
{
    struct vvcam_video_dev *vvcam_vdev = video_drvdata(file);
    int ret;

    ret = vb2_fop_release(file);
    if (vvcam_vdev->video->queue->owner == NULL) {
        if (vvcam_vdev->pipeline) {
            vvcam_video_destroy_pipeline(vvcam_vdev);
        }
    }

    return ret;
}
```

## 12. 底层寄存器级入口

当前 SDK 中能看到的寄存器级实现不在 `v4l2/isp`，而在：

`buildroot-overlay/package/vvcam/isp`

这个目录实现的是底层 misc device，例如：

```text
/dev/vvcam-isp.0
```

### 12.1 ioctl 定义

源码位置：

`isp/vvcam_isp.h`

```c
typedef struct {
    uint32_t addr;
    uint32_t value;
} vvcam_isp_reg_t;

#define VVCAM_ISP_IOC_MAGIC 'v'
#define VVCAM_ISP_RESET             _IOW(VVCAM_ISP_IOC_MAGIC, 0x01, uint32_t)
#define VVCAM_ISP_READ_REG          _IOWR(VVCAM_ISP_IOC_MAGIC, 0x02, vvcam_isp_reg_t)
#define VVCAM_ISP_WRITE_REG         _IOW(VVCAM_ISP_IOC_MAGIC, 0x03, vvcam_isp_reg_t)
#define VVCAM_ISP_SUBSCRIBE_EVENT   _IOW(VVCAM_ISP_IOC_MAGIC, 0x04, vvcam_subscription_t)
#define VVCAM_ISP_UNSUBSCRIBE_EVENT _IOW(VVCAM_ISP_IOC_MAGIC, 0x05, vvcam_subscription_t)
#define VVCAM_ISP_DQEVENT           _IOR(VVCAM_ISP_IOC_MAGIC, 0x06, vvcam_event_t)
```

### 12.2 ioctl 分发

源码位置：

`isp/vvcam_isp_driver.c`

```c
static long vvcam_isp_ioctl(struct file *file,
                        unsigned int cmd, unsigned long arg)
{
    struct vvcam_isp_dev *isp_dev;
    struct vvcam_isp_fh *isp_fh;
    uint32_t reset;
    vvcam_isp_reg_t isp_reg;
    vvcam_subscription_t sub;
    vvcam_event_t event;
    int ret = 0;

    isp_fh = file->private_data;
    isp_dev = isp_fh->isp_dev;

    mutex_lock(&isp_dev->mlock);

    switch(cmd) {
    case VVCAM_ISP_RESET:
        ret = copy_from_user(&reset, (void __user *)arg, sizeof(reset));
        if (ret)
            break;
        ret = vvcam_isp_reset(isp_dev, reset);
        break;
    case VVCAM_ISP_READ_REG:
        ret = copy_from_user(&isp_reg, (void __user *)arg, sizeof(isp_reg));
        if (ret)
            break;
        ret = vvcam_isp_read_reg(isp_dev, &isp_reg);
        if (ret)
            break;
        ret = copy_to_user((void __user *)arg, &isp_reg, sizeof(isp_reg));
        break;
    case VVCAM_ISP_WRITE_REG:
        ret = copy_from_user(&isp_reg, (void __user *)arg, sizeof(isp_reg));
        if (ret)
            break;
        ret = vvcam_isp_write_reg(isp_dev, isp_reg);
        break;
    case VVCAM_ISP_SUBSCRIBE_EVENT:
        ret = copy_from_user(&sub, (void __user *)arg, sizeof(sub));
        if (ret)
            break;
        ret = vvcam_event_subscribe(&isp_fh->event_fh,
                    &sub, VVCAM_ISP_EVENT_ELEMS);
        break;
    case VVCAM_ISP_UNSUBSCRIBE_EVENT:
        ret = copy_from_user(&sub, (void __user *)arg, sizeof(sub));
        if (ret)
            break;
        ret = vvcam_event_unsubscribe(&isp_fh->event_fh, &sub);
        break;
    case VVCAM_ISP_DQEVENT:
        ret = vvcam_event_dequeue(&isp_fh->event_fh, &event);
        if (ret)
            break;
        ret = copy_to_user((void __user *)arg, &event, sizeof(event));
        break;
    default:
        ret = -EINVAL;
        break;
    }

    mutex_unlock(&isp_dev->mlock);

    return ret;
}
```

### 12.3 MMIO 映射

源码位置：

`isp/vvcam_isp_driver.c`

```c
static int vvcam_isp_parse_params(struct vvcam_isp_dev *isp_dev,
                        struct platform_device *pdev)
{
    struct resource *res;

    res =  platform_get_resource(pdev, IORESOURCE_MEM, 0);
    if (!res) {
        dev_err(&pdev->dev, "can't fetch device resource info\n");
        return -EIO;
    }
    isp_dev->paddr = res->start;
    isp_dev->regs_size = resource_size(res);
    dev_info(&pdev->dev, "isp addr: %08llx, size: %u\n",
             isp_dev->paddr, isp_dev->regs_size);
    isp_dev->base = devm_ioremap_resource(&pdev->dev, res);
    if (IS_ERR(isp_dev->base)) {
        dev_err(&pdev->dev, "can't remap device resource info\n");
        return PTR_ERR(isp_dev->base);
    }
```

### 12.4 readl/writel

源码位置：

`isp/vvcam_isp_hal.c`

```c
static void vvcam_isp_hal_write_reg(void __iomem *base,
            uint32_t addr, uint32_t value)
{
    writel(value, base + addr);
}

static int vvcam_isp_hal_read_reg(void __iomem *base, uint32_t addr)
{
    return readl(base + addr);
}

int vvcam_isp_write_reg(struct vvcam_isp_dev *isp_dev, vvcam_isp_reg_t isp_reg)
{
    vvcam_isp_hal_write_reg(isp_dev->base, isp_reg.addr, isp_reg.value);
    return 0;
}

int vvcam_isp_read_reg(struct vvcam_isp_dev *isp_dev, vvcam_isp_reg_t *isp_reg)
{
    uint32_t reg_value = 0;

    reg_value = vvcam_isp_hal_read_reg(isp_dev->base, isp_reg->addr);

    isp_reg->value = reg_value;

    return 0;
}
```

所以寄存器级最终形式是：

```text
writel(value, isp_dev->base + addr)
readl(isp_dev->base + addr)
```

## 13. 用户态 daemon 的证据

启动脚本：

`deb/etc/vvcam/isp_start.sh`

```sh
#!/bin/bash
/etc/vvcam/S99adb_mtp  start
modprobe vvcam_isp
modprobe vvcam_mipi
modprobe vvcam_vb
modprobe vvcam_isp_subdev
modprobe vvcam_video
#ISP_MEDIA_SENSOR_DRIVER=/usr/lib/libvvcam.so
ISP_MEDIA_SENSOR_DRIVER=/lib/riscv64-linux-gnu/libvvcam.so /usr/bin/isp_media_server_debian  >/tmp/isp.err.log  2>&1 &
```

`strings -a buildroot-overlay/package/vvcam/isp_media_server_debian` 可看到：

```text
vvcam-video
vvcam-isp-subdev.%d
ISP_MEDIA_ISP_EVENT
Receive Event MEDIA_EID_REQBUFS
Receive Event MEDIA_EID_QBUF
Receive Event MEDIA_EID_STREAMON
Receive Event MEDIA_EID_S_CTRL
Receive Event MEDIA_EID_G_CTRL
/dev/vvcam-isp.%u
/dev/vvcam-vb
/dev/vvcam-mipi.%u
/dev/mem
media_isp_ge_ctrl.c
cameric_isp_ge.c
units/isp_drv/source/...
units/hal/source/hal_isp.c
```

这些字符串说明：

- daemon 确实处理 v4l2 subdev event。
- daemon 确实知道 `S_CTRL/G_CTRL/REQBUFS/QBUF/STREAMON` 等 event。
- daemon 会打开 `/dev/vvcam-isp.%u`。
- daemon 内部有 `media_isp_ge_ctrl.c`、`cameric_isp_ge.c`、`hal_isp.c` 等用户态/库代码路径。

但当前仓库没有这些源码目录，只有二进制。因此我们只能从内核侧确认：

```text
v4l2/isp subdev event -> daemon -> /dev/vvcam-isp.0 -> writel/readl
```

不能从源码继续确认：

```text
VVCAM_ISP_CID_GE_THRESHOLD -> 具体寄存器 offset / bitfield
```

这部分映射应在 `isp_media_server_debian` 对应的用户态 `isp_media` 源码或其链接库中。

## 14. 典型调用链完整展开

以 `VIDIOC_S_CTRL(VVCAM_ISP_CID_GE_THRESHOLD)` 为例：

```text
1. 用户态 app:
   ioctl(/dev/videoX, VIDIOC_S_CTRL, struct v4l2_control {
       id = VVCAM_ISP_CID_GE_THRESHOLD,
       value = xxx,
   })

2. v4l2/video/vvcam_video_register.c:
   vvcam_vidioc_s_ctrl()
       -> vvcam_video_remote_subdev()
       -> v4l2_subdev_call(subdev, core, ioctl,
                           VVCAM_PAD_S_CTRL, &pad_control)

3. v4l2/isp/vvcam_isp_driver.c:
   vvcam_isp_priv_ioctl()
       -> case VVCAM_PAD_S_CTRL
       -> vvcam_isp_s_ctrl()
       -> isp_dev->ctrl_pad = pad
       -> v4l2_s_ctrl(&isp_dev->ctrl_handler, control)

4. v4l2 ctrl framework:
   根据 control id 找到 GE ctrl
       -> vvcam_isp_ge_s_ctrl()

5. v4l2/isp/isp_ctrl/ge/ge/vvcam_isp_ge.c:
   vvcam_isp_ge_s_ctrl()
       -> case VVCAM_ISP_CID_GE_THRESHOLD
       -> vvcam_isp_s_ctrl_event(isp_dev, pad, ctrl)

6. v4l2/isp/vvcam_isp_event.c:
   vvcam_isp_s_ctrl_event()
       -> shared memory 写入:
          cid  = VVCAM_ISP_CID_GE_THRESHOLD
          size = sizeof(value)
          data = value
       -> event id = VVCAM_ISP_EVENT_S_CTRL
       -> v4l2_event_queue(sd->devnode, event)
       -> wait ack/result

7. 用户态 isp_media_server_debian:
   VIDIOC_DQEVENT on /dev/v4l-subdevX
       -> 收到 MEDIA_EID_S_CTRL / VVCAM_ISP_EVENT_S_CTRL
       -> 读取 shared memory
       -> 根据 cid 分发到 media_isp_ge_ctrl/cameric_isp_ge 逻辑
       -> 计算寄存器 offset/value
       -> 调用 /dev/vvcam-isp.0 或 mmap/devmem 写寄存器
       -> 写 ack/result

8. isp/vvcam_isp_driver.c:
   ioctl(/dev/vvcam-isp.0, VVCAM_ISP_WRITE_REG, vvcam_isp_reg_t)
       -> vvcam_isp_write_reg()

9. isp/vvcam_isp_hal.c:
   vvcam_isp_write_reg()
       -> writel(value, isp_dev->base + addr)
```

## 15. 为什么 v4l2/isp subdev 不直接写寄存器

从代码设计看，这是一种刻意分层：

- 内核 V4L2 层只提供 Linux 标准对象模型：video node、subdev、media graph、vb2、V4L2 ctrl。
- 复杂 ISP pipeline、3A、tuning、sensor XML/JSON、模块参数转换、寄存器序列都留在用户态 daemon。
- 底层内核 misc ISP 驱动只提供 reset、irq、register read/write、mmap 这种薄硬件访问层。

优点：

- 用户态 ISP 算法和 tuning 更新不需要重写内核。
- 保留标准 V4L2 入口，应用仍可使用 `/dev/videoX`。
- ISP vendor 复杂 HAL 可以维持原有用户态架构。

代价：

- 强依赖 daemon，daemon 不运行时很多 V4L2 ioctl 会失败。
- control 到寄存器的真实映射不在内核源码里，不利于纯内核调试。
- 主线化难度较高，因为使用大量 private event/private ioctl。
- event ack 使用 busy wait 风格，不是典型上游驱动状态机。

## 16. 如何排查问题

### 16.1 control 设置失败

重点检查：

```text
1. /dev/videoX VIDIOC_S_CTRL 是否进入 vvcam_vidioc_s_ctrl()
2. media graph 上 video sink pad 是否连到了 vvcam-isp-subdev source pad
3. vvcam_video_remote_subdev() 是否返回 NULL
4. vvcam_isp_priv_ioctl() 是否收到 VVCAM_PAD_S_CTRL
5. control id 是否在对应模块 ctrl table 中注册
6. daemon 是否订阅 VVCAM_ISP_DEAMON_EVENT
7. daemon 是否 ack，并且 result == 0
```

### 16.2 `post event not subscribed`

说明 daemon 没有订阅对应 V4L2 private event：

```text
VVCAM_VIDEO_DEAMON_EVENT
VVCAM_ISP_DEAMON_EVENT
```

检查：

```sh
ps | grep isp_media_server
cat /tmp/isp.err.log
```

以及 module 加载顺序是否匹配：

```text
vvcam_isp
vvcam_mipi
vvcam_vb
vvcam_isp_subdev
vvcam_video
isp_media_server_debian
```

### 16.3 想追某个 control 到寄存器

内核源码只能追到：

```text
VVCAM_ISP_CID_xxx
    -> module s_ctrl/g_ctrl
    -> VVCAM_ISP_EVENT_S_CTRL/G_CTRL
    -> daemon
```

要继续追到寄存器，需要：

- 找到 `buildroot-overlay/isp_media/...` 用户态源码。
- 或反汇编/调试 `isp_media_server_debian`。
- 或在 `/dev/vvcam-isp.0` 的 `VVCAM_ISP_WRITE_REG` ioctl 中加 trace，打印 `{addr, value}`。
- 或在 `vvcam_isp_hal_write_reg()` 中加 trace，但要注意寄存器写非常频繁，可能影响时序。

推荐最小侵入调试点：

```c
int vvcam_isp_write_reg(struct vvcam_isp_dev *isp_dev, vvcam_isp_reg_t isp_reg)
{
    dev_dbg(isp_dev->dev, "write reg addr=0x%08x value=0x%08x\n",
            isp_reg.addr, isp_reg.value);
    vvcam_isp_hal_write_reg(isp_dev->base, isp_reg.addr, isp_reg.value);
    return 0;
}
```

如果只想追某个 control，建议在 `vvcam_isp_s_ctrl_event()` 中打印：

```c
dev_info(isp_dev->dev, "S_CTRL pad=%d cid=0x%x size=%u\n",
         pad, isp_ctrl->cid, isp_ctrl->size);
```

然后在底层 `VVCAM_ISP_WRITE_REG` 中临时打印寄存器写，结合时间戳匹配。

## 17. daemon 是否可以理解为“用户态 ISP HAL/IP 驱动”

可以这样理解，但要稍微加一个限定：它不是简单的 V4L2 转发器，而是一个用户态 ISP media server。

它做的事情大致是：

```text
1. 打开 video/subdev/misc/vb/mipi 等设备节点
2. 订阅内核 vvcam 抛出的 private V4L2 event
3. 读取 event head 和共享内存中的 control/buffer/stream 信息
4. 把这些 Linux V4L2/MC 外壳语义转换为 vendor media pipeline 语义
5. 调用用户态 ISP 模块控制层、CamerIc IP 驱动层、HAL/binder 层
6. 最终通过 /dev/vvcam-isp.0 或 /dev/mem 类路径落实到寄存器访问
7. 把 result 写回 event head，并设置 ack，唤醒内核侧等待者
```

也就是说，内核侧的 `vvcam_video` / `vvcam_isp_subdev` 更像 Linux 主线接口外壳和事件桥；真正 ISP 模块参数如何翻译成寄存器，是 daemon 内部的 vendor ISP stack 负责。

### 17.1 daemon 二进制中的底层函数

当前目录下没有展开 `buildroot-overlay/isp_media/...` 这套用户态源码，但 `buildroot-overlay/package/vvcam/isp_media_server_debian` 是一个带符号和 debug info 的 RISC-V ELF：

```sh
file buildroot-overlay/package/vvcam/isp_media_server_debian
```

可以用 `nm -C` 看到真正的用户态 ISP/IP/HAL 函数名。以 GE 模块为例：

```text
0000000000066522 T MediaIspGeSetCtrl
00000000000669f2 T MediaIspGeGetCtrl
0000000000066180 t MediaIspGeSwitch
00000000000662c0 t MediaIspGeReset
0000000000066336 t MediaIspGeSetConfig
0000000000066880 t MediaIspGeGetConfig
0000000000066760 t MediaIspGeGetEnable

00000000000ee554 T CamerIcIspGeEnable
00000000000ee5ae T CamerIcIspGeDisable
00000000000ee650 T CamerIcIspGeSetThreshold
00000000000ee6aa T CamerIcIspGeGetThreshold
00000000000ee4f6 T CamerIcIspGeInit
00000000000ee538 T CamerIcIspGeRelease
00000000000ee606 T CamerIcIspGeIsEnabled
```

这说明 daemon 内部至少分成两层：

```text
MediaIspGe*      用户态 media pipeline / control 适配层
CamerIcIspGe*    GE 这个 ISP IP block 的驱动层
```

再往下能看到通用 ISP 寄存器和 HAL/binder 层：

```text
00000000000eafe0 T CamerIcIspWriteReg
00000000000eb04a T CamerIcIspReadReg

0000000000108786 T BinderHalWriteReg
00000000001087ec T BinderHalReadReg

000000000011d76a T isp_write_reg
000000000011d7bc T isp_read_reg
000000000011efce T isp_drv_write_reg
000000000011ef8e T isp_drv_read_reg
```

这基本确认了 daemon 内部存在一条类似传统 RTOS/vendor HAL 的路径：

```text
Media pipeline ctrl
    -> CamerIc ISP IP driver
    -> CamerIc generic register accessor
    -> Binder/HAL
    -> isp_drv command
    -> Linux misc device 或 memory mapped register
```

### 17.2 debug info 暴露的原始源码路径

虽然当前 SDK 目录没有对应源码，但二进制 debug 信息保留了原始文件名和行号：

```text
MediaIspGeSetCtrl
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/mediacontrol/media_pipeline/media_isp/source/sub_module/ge/media_isp_ge_ctrl.c:109

MediaIspGeGetCtrl
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/mediacontrol/media_pipeline/media_isp/source/sub_module/ge/media_isp_ge_ctrl.c:211

CamerIcIspGeSetThreshold
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp_ge.c:149

CamerIcIspGeGetThreshold
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp_ge.c:172

CamerIcIspWriteReg
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp.c:2399

CamerIcIspReadReg
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp.c:2425

BinderHalWriteReg
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/binder/api/source/binder_hal_api.c:164

BinderHalReadReg
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/binder/api/source/binder_hal_api.c:188

isp_write_reg
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/isp_drv/source/isp_drv_cmd.c:58

isp_read_reg
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/isp_drv/source/isp_drv_cmd.c:73

isp_drv_write_reg
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/isp_drv/source/isp_drv_cmd.c:781

isp_drv_read_reg
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/isp_drv/source/isp_drv_cmd.c:773
```

这几个路径非常有价值。它们说明“真正的 daemon 底层 IP 驱动函数”大概率就在这套未随当前源码展开的用户态源码里：

```text
buildroot-overlay/isp_media/mediacontrol/media_pipeline/media_isp/source/sub_module/ge/media_isp_ge_ctrl.c
buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp_ge.c
buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp.c
buildroot-overlay/isp_media/units/binder/api/source/binder_hal_api.c
buildroot-overlay/isp_media/units/isp_drv/source/isp_drv_cmd.c
```

### 17.3 以 GE threshold 为例的完整链路

结合内核源码和 daemon 符号，`VVCAM_ISP_CID_GE_THRESHOLD` 的典型链路可以整理为：

```text
应用:
    ioctl(/dev/videoX, VIDIOC_S_CTRL, VVCAM_ISP_CID_GE_THRESHOLD)

video node:
    vvcam_vidioc_s_ctrl()
        -> v4l2_subdev_call(remote_isp_subdev, core, ioctl,
                            VVCAM_PAD_S_CTRL, &pad_control)

isp subdev:
    vvcam_isp_priv_ioctl()
        -> vvcam_isp_s_ctrl()
        -> v4l2_s_ctrl()
        -> vvcam_isp_ge_s_ctrl()
        -> vvcam_isp_s_ctrl_event()
        -> vvcam_isp_post_event()
        -> queue VVCAM_ISP_DEAMON_EVENT
        -> wait ack

daemon:
    收到 VVCAM_ISP_EVENT_S_CTRL
        -> 根据 cid 分发到 MediaIspGeSetCtrl()
        -> GE threshold 分支调用 CamerIcIspGeSetThreshold()
        -> 调用 CamerIcIspWriteReg()
        -> 调用 BinderHalWriteReg() / isp_drv_write_reg()
        -> 通过 /dev/vvcam-isp.0 或映射寄存器完成写寄存器
        -> 写回 result
        -> ack = 1

kernel misc isp:
    ioctl(/dev/vvcam-isp.0, VVCAM_ISP_WRITE_REG)
        -> vvcam_isp_write_reg()
        -> vvcam_isp_hal_write_reg()
        -> writel(value, base + addr)
```

其中最后一层内核寄存器写在当前源码中可以直接看到：

```c
void vvcam_isp_hal_write_reg(void __iomem *base, uint32_t addr, uint32_t value)
{
    writel(value, base + addr);
}
```

### 17.4 还差什么才能 100% 还原寄存器位域

现在可以确认“函数链路”和“源码文件名”，但还不能仅凭当前源码 100% 还原每个 control 对应哪个寄存器 offset、哪些 bit 位。缺口在这里：

```text
CamerIcIspGeSetThreshold()
    -> 具体写哪个 GE 寄存器
    -> threshold 如何 pack 到 value
    -> 是否还有 enable/update shadow 等附加写操作
```

这些逻辑应该在：

```text
buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp_ge.c
```

当前目录没有这个源码文件，所以有三种继续办法：

```text
1. 找到完整 k230_linux_sdk 中的 buildroot-overlay/isp_media 源码
2. 用 RISC-V objdump/llvm-objdump 反汇编 isp_media_server_debian
3. 在内核 /dev/vvcam-isp.0 的 VVCAM_ISP_WRITE_REG 路径加 trace，运行时记录 addr/value
```

对调试而言，第三种最快；对写移植文档而言，第一种最完整。

## 18. 一句话总结

`VVCAM_PAD_*` 并不是最终寄存器操作。它们是 video node 到 ISP subdev 的私有桥接命令；ISP subdev 收到后再转换为 `VVCAM_ISP_EVENT_*`，由用户态 `isp_media_server_debian` 解析并调用底层 `/dev/vvcam-isp.0`，最后才通过 `vvcam_isp_hal.c` 中的 `readl/writel` 访问真实 ISP 寄存器。
