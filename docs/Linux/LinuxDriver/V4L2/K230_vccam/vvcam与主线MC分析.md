# K230 vvcam 与主线 V4L2/Media Controller 差异分析

本文只分析 `buildroot-overlay/package/vvcam/v4l2` 这套 V4L2/Media Controller 外壳和 private event/private ioctl 桥接方案。不展开 ISP 算法本身，也不把用户态 `isp_media_server_debian` 当作完整源码来反编译。

核心结论：

```text
K230 vvcam 使用了主线 V4L2/MC 的对象模型：
    media_device
    media_entity
    media_pad
    media_link
    video_device
    v4l2_subdev
    vb2_queue
    v4l2_ctrl_handler

但它没有完全按主线 MC-centric camera driver 的方式把 pipeline runtime 放在内核 MC/subdev 状态机里。

它的实际模型更像：
    主线 V4L2/MC 外壳
        + 私有 pad ioctl
        + 私有 V4L2 event
        + 共享内存参数包
        + 用户态 daemon ack
        + daemon 内部 vendor ISP HAL/IP driver
```

所以这里有两个不同层面的 pipeline：

```text
1. Media Controller topology pipeline
   由内核维护，表现为 entity/pad/link 图。
   K230 用它来暴露拓扑，并帮助 video node 找到 remote subdev。

2. ISP runtime pipeline
   由用户态 daemon 维护。
   K230 通过 CREATE_PIPELINE、DESTROY_PIPELINE、REQBUFS、QBUF、STREAMON、STREAMOFF、
   S_CTRL、G_CTRL 等 private event 通知 daemon，由 daemon 真正创建和驱动 ISP runtime。
```

这正是它和主线差异较大的根本原因：K230 在接口层用了主线对象，但在运行时控制层绕到了私有协议和用户态 ISP server。

## 1. 主线 V4L2/MC 的典型职责划分

主线 V4L2/MC camera driver 通常会把硬件拆成若干 subdev 和 video node：

```text
sensor subdev
    -> csi/phy/receiver subdev
    -> isp/scaler/color/formatter subdev
    -> video capture node
```

Media Controller 负责描述这些 block 之间的 entity/pad/link 拓扑。对于 MC-centric 设备，用户态通常需要通过 media controller API 和 subdev API 配置 pipeline，例如设置 link、设置 pad format、设置 selection/routing，然后对 video node 做 REQBUFS/QBUF/STREAMON。

主线更常见的运行路径是：

```text
应用:
    media-ctl / subdev ioctls 配置拓扑和 pad format
    ioctl(/dev/videoX, VIDIOC_REQBUFS/QBUF/STREAMON)

内核 bridge/video driver:
    校验 link 和格式
    启动 vb2 queue
    沿 pipeline 调用 subdev .s_stream/.enable_streams
    由各 subdev 的内核驱动直接操作对应硬件寄存器或调用内核内部 HAL

返回:
    ioctl 直接返回成功或错误
```

这里的关键点是：主线事件机制主要用于通知异步事件，例如 control event、source change、frame sync 等，不通常用于让 daemon 同步 ack 每一个 pipeline/control/buffer 操作。

参考主线文档：

- V4L2 sub-device driver API: https://docs.kernel.org/driver-api/media/v4l2-subdev.html
- V4L2 sub-device userspace API: https://docs.kernel.org/userspace-api/media/v4l/dev-subdev.html
- Opening V4L2 and MC-centric devices: https://docs.kernel.org/userspace-api/media/v4l/open.html
- V4L2 async notifier API: https://docs.kernel.org/driver-api/media/v4l2-async.html
- Media Controller introduction: https://docs.kernel.org/userspace-api/media/mediactl/media-controller-intro.html

## 2. K230 的整体结构

K230 的内核侧大致分三层：

```text
vvcam_video.ko
    暴露 /dev/videoX
    注册 video_device、vb2 queue、media entity sink pad
    把 VIDIOC_* 转换成对 remote ISP subdev 的 VVCAM_PAD_* private ioctl

vvcam_isp_subdev
    暴露 v4l2_subdev，带 devnode 和 media pads
    接收 VVCAM_PAD_* private ioctl
    再转换成 VVCAM_ISP_EVENT_* private event 发给 daemon

vvcam_isp.ko
    misc 硬件访问层
    提供 /dev/vvcam-isp.0
    支持寄存器 read/write/reset/irq 等底层能力
```

用户态：

```text
isp_media_server_debian
    打开 /dev/videoX、/dev/vvcam-isp-subdev.X、/dev/vvcam-isp.X 等节点
    订阅 private event
    ack 内核侧事件
    维护 ISP runtime pipeline
    调用用户态 vendor ISP HAL/IP driver
```

## 3. 差异一：拓扑链接方式不是纯主线 fwnode/DT graph

K230 编译时打开了 `VVCAM_PLATFORM_REGISTER`：

```makefile
# buildroot-overlay/package/vvcam/Makefile

ccflags-y	+= -DVVCAM_ISP0_BASE=0x90000000
ccflags-y	+= -DVVCAM_ISP_REG_SIZE=0x10000
ccflags-y	+= -DVVCAM_ISP0_IRQ=129
ccflags-y	+= -DVVCAM_ISP0_MI_IRQ=127
ccflags-y	+= -DVVCAM_ISP0_FE_IRQ=128
ccflags-y	+= -DVVCAM_PLATFORM_REGISTER
ccflags-y	+= -DVVCAM_ISP_DEV_MAX=1
```

`v4l2/isp/Makefile` 里也同样定义：

```makefile
# buildroot-overlay/package/vvcam/v4l2/isp/Makefile

ccflags-y	+= -DVVCAM_PLATFORM_REGISTER
ccflags-y	+= -DVVCAM_ISP_DEV_MAX=1
```

打开这个宏以后，video 到 ISP subdev 的 link 主要来自静态 C 表，而不是完全依赖 DT/fwnode graph：

```c
/* buildroot-overlay/package/vvcam/v4l2/video/vvcam_pipeline_link.h */

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

对应 link 创建逻辑：

```c
/* buildroot-overlay/package/vvcam/v4l2/video/vvcam_video_driver.c */

if (vvcam_mdev->pipeline_link[i].local_is_video) {
    port = vvcam_mdev->pipeline_link[i].video_index;
    vdev = vvcam_mdev->video_devs[port]->video;
    source = &sd->entity;
    source_pad = vvcam_mdev->pipeline_link[i].remote_pad;
    sink =&vdev->entity;
    sink_pad = 0;
} else {
    local_subdev = *vvcam_mdev->pipeline_link[i].local_subdev;
    source = &sd->entity;
    source_pad = vvcam_mdev->pipeline_link[i].remote_pad;
    sink =&local_subdev->entity;
    sink_pad = vvcam_mdev->pipeline_link[i].local_pad;
}

ret = media_create_pad_link(source, source_pad, sink, sink_pad, MEDIA_LNK_FL_ENABLED);
```

代码里其实也有 fwnode graph 分支：

```c
/* buildroot-overlay/package/vvcam/v4l2/video/vvcam_video_driver.c */

ep = fwnode_graph_get_next_endpoint(sd->fwnode, ep);
ret = v4l2_fwnode_parse_link(ep, &link);

vvcam_vdev = vvcam_mdev->video_devs[link.remote_port];
vdev = vvcam_vdev->video;
source = &sd->entity;
source_pad = link.local_port;
sink = &vdev->entity;
sink_pad = 0;

ret = media_create_pad_link(source, source_pad, sink, sink_pad, MEDIA_LNK_FL_ENABLED);
```

但在当前 K230 build 配置下，静态 platform register 路径是主路径。

和主线的差异：

```text
主线倾向：
    通过 DT/fwnode graph 描述硬件连接
    bridge driver 用 async notifier 匹配 remote subdev
    根据 firmware graph 创建 media links

K230 当前路径：
    用 VVCAM_PLATFORM_REGISTER 固化静态 pipeline link 表
    通过全局 g_vvcam_isp_subdev 指针连接 video 和 ISP subdev
    media graph 更像固定拓扑暴露，而不是完整 firmware-described graph
```

## 4. 差异二：MC graph 只维护拓扑，不维护真正 runtime pipeline

video node 通过 MC link 找 remote subdev：

```c
/* buildroot-overlay/package/vvcam/v4l2/video/vvcam_video_register.c */

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

这个函数说明 MC link 在 K230 里的一个关键用途是：

```text
video sink pad
    -> remote ISP subdev source pad
    -> 得到 subdev 指针
    -> 后续 private ioctl 都发给这个 subdev
```

真正的 runtime pipeline 创建不是通过主线 MC pipeline start/state 完成，而是发送 private video event：

```c
/* buildroot-overlay/package/vvcam/v4l2/video/vvcam_video_register.c */

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
```

注意这里的顺序：

```text
先 vvcam_video_create_pipeline_event()
再 subdev get_fmt
最后 vvcam_vdev->pipeline = 1
```

所以 `vvcam_vdev->pipeline` 这个 flag 表示 K230 自己的 runtime pipeline 已经由 daemon 创建，而不是标准 MC pipeline object 的完整状态。

video event 定义也很直接：

```c
/* buildroot-overlay/package/vvcam/v4l2/video/vvcam_video_event.h */

#define VVCAM_VIDEO_DEAMON_EVENT (V4L2_EVENT_PRIVATE_START + 1000)

enum vvcam_video_event_id {
    VVCAM_VEVENT_CREATE_PIPELINE = 0,
    VVCAM_VEVENT_DESTROY_PIPELINE,
    VVCAM_VEVENT_MAX,
};

struct vvcam_video_event_pkg {
    struct vvcam_video_event_pkg_head head;
    uint8_t  ack;
    int32_t  result;
    uint8_t data[2048];
};
```

发送 create/destroy pipeline：

```c
/* buildroot-overlay/package/vvcam/v4l2/video/vvcam_video_event.c */

int vvcam_video_create_pipeline_event(struct vvcam_video_dev *vvcam_vdev)
{
    struct vvcam_video_event_pkg *event_pkg = vvcam_vdev->event_shm.virt_addr;
    int ret;

    mutex_lock(&vvcam_vdev->event_shm.event_lock);

    event_pkg->head.eid = VVCAM_VEVENT_CREATE_PIPELINE;
    event_pkg->head.shm_addr = vvcam_vdev->event_shm.phy_addr;
    event_pkg->head.shm_size = vvcam_vdev->event_shm.size;
    event_pkg->head.data_size = 0;
    event_pkg->ack = 0;
    event_pkg->result = 0;

    ret = vvcam_video_post_event(vvcam_vdev, event_pkg);

    mutex_unlock(&vvcam_vdev->event_shm.event_lock);

    return ret;
}
```

和主线的差异：

```text
主线 MC pipeline:
    media graph 不只是找 remote subdev，也参与 link validation、pipeline start/stop、
    runtime PM、stream propagation、format consistency 等。

K230:
    kernel MC graph 主要提供拓扑和 remote subdev 定位。
    真正 pipeline 生命周期通过 VVCAM_VIDEO_DEAMON_EVENT 交给 daemon。
```

## 5. 差异三：大量标准 V4L2 ioctl 被转成 private subdev ioctl

K230 定义了一组 `VVCAM_PAD_*` private ioctl：

```c
/* buildroot-overlay/package/vvcam/v4l2/common/vvcam_v4l2_common.h */

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

以 `VIDIOC_S_CTRL` 为例，video node 不直接完成 control，也不只通过标准 ctrl handler 返回，而是找到 remote ISP subdev 后调用 private ioctl：

```c
/* buildroot-overlay/package/vvcam/v4l2/video/vvcam_video_register.c */

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

streamon 也是同样风格：

```c
/* buildroot-overlay/package/vvcam/v4l2/video/vvcam_video_register.c */

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
        ret = v4l2_subdev_call(subdev, core, ioctl, VVCAM_PAD_S_STREAM, &stream_status);
    }

    return ret;
}
```

和主线的差异：

```text
主线倾向：
    video ioctl 进入 bridge/vb2/subdev 标准 ops
    subdev 使用 pad/video/core ops 的标准语义
    控制尽量用 V4L2 ctrl framework 和标准 CID

K230:
    video ioctl 先转成 VVCAM_PAD_* private command
    private command 带 pad index
    remote ISP subdev 的 core.ioctl 成为私有命令总入口
```

## 6. 差异四：ISP subdev 是 private ioctl 分发器

ISP subdev 的 `.core.ioctl` 指向 `vvcam_isp_priv_ioctl()`：

```c
/* buildroot-overlay/package/vvcam/v4l2/isp/vvcam_isp_driver.c */

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

static struct v4l2_subdev_core_ops vvcam_isp_core_ops = {
    .ioctl             = vvcam_isp_priv_ioctl,
    .subscribe_event   = vvcam_isp_subscribe_event,
    .unsubscribe_event = v4l2_event_subdev_unsubscribe,
};
```

这和主线 subdev ops 的典型拆分不同。主线更希望各类操作落到语义化 ops：

```text
pad ops:
    enum_mbus_code
    get_fmt
    set_fmt
    get_selection
    set_selection
    link_validate

video ops:
    s_stream 或 enable_streams/disable_streams

core ops:
    ioctl 一般不是正常数据路径和控制路径的主入口
```

K230 则把很多操作集中到 `core.ioctl` 私有分发器里。

## 7. 差异五：private event + ack 是同步调用通道

K230 video event：

```c
/* buildroot-overlay/package/vvcam/v4l2/video/vvcam_video_event.c */

int vvcam_video_post_event(struct vvcam_video_dev *vvcam_vdev,
                        struct vvcam_video_event_pkg *event_pkg)
{
    struct v4l2_event event;
    int timeout_ms = 200000;
    int i = 0;

    memset(&event, 0, sizeof(event));

    event.type   = VVCAM_VIDEO_DEAMON_EVENT;
    event.id     = event_pkg->head.eid;
    memcpy(event.u.data, &event_pkg->head, sizeof(event_pkg->head));

    if (!vvcam_video_event_subscribed(vvcam_vdev, event.type, event.id))
        return -EINVAL;

    v4l2_event_queue(vvcam_vdev->video, &event);

    for (i = 0; i < timeout_ms; i++) {
        if (event_pkg->ack) {
            break;
        }
        usleep_range(5, 10);
    }

    if (event_pkg->ack == 0) {
        dev_err(vvcam_vdev->vvcam_mdev->dev,
            "%s post event %d time out\n",
            vvcam_vdev->video->name, event.id);
        return -EIO;
    }

    if (event_pkg->result) {
        return -EINVAL;
    }

    return 0;
}
```

K230 ISP event 也一样：

```c
/* buildroot-overlay/package/vvcam/v4l2/isp/vvcam_isp_event.c */

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

event 类型是 private 的：

```c
/* buildroot-overlay/package/vvcam/v4l2/video/vvcam_video_event.h */

#define VVCAM_VIDEO_DEAMON_EVENT (V4L2_EVENT_PRIVATE_START + 1000)

/* buildroot-overlay/package/vvcam/v4l2/isp/vvcam_isp_event.h */

#define VVCAM_ISP_DEAMON_EVENT (V4L2_EVENT_PRIVATE_START + 2000)
```

subdev 和 video node 都允许 daemon 订阅这种 private event：

```c
/* buildroot-overlay/package/vvcam/v4l2/video/vvcam_video_register.c */

static int vvcam_videoc_subscribe_event(struct v4l2_fh *fh,
                                const struct v4l2_event_subscription *sub)
{
    int ret;
    switch (sub->type) {
    case V4L2_EVENT_CTRL:
        ret = v4l2_ctrl_subscribe_event(fh, sub);
        break;
    case VVCAM_VIDEO_DEAMON_EVENT:
        ret = v4l2_event_subscribe(fh, sub, 2, NULL);
        break;
    default:
        ret = -EINVAL;
        break;
    }
```

```c
/* buildroot-overlay/package/vvcam/v4l2/isp/vvcam_isp_driver.c */

int vvcam_isp_subscribe_event(struct v4l2_subdev *sd,
                            struct v4l2_fh *fh,
                            struct v4l2_event_subscription *sub)
{
    switch (sub->type) {
        case V4L2_EVENT_CTRL:
            return v4l2_ctrl_subdev_subscribe_event(sd, fh, sub);
        case VVCAM_ISP_DEAMON_EVENT:
            return v4l2_event_subscribe(fh, sub, 2, NULL);
        default:
            return -EINVAL;
    }
}
```

和主线的差异：

```text
主线 V4L2 event:
    偏通知语义，用户态 dequeue event 后获知某事发生。
    ioctl 的完成通常不依赖另一个用户态 daemon 写共享内存 ack。

K230 private event:
    是同步 RPC 通道。
    内核 queue event 后轮询等待 event_pkg->ack。
    daemon 不运行或未订阅时，pipeline/control/buffer 操作会失败。
```

## 8. 差异六：buffer 和 stream runtime 由 daemon 参与维护

vb2 queue setup 仍在 video node：

```c
/* buildroot-overlay/package/vvcam/v4l2/video/vvcam_video_register.c */

static int vvcam_video_vb2_queue_setup(struct vb2_queue *queue,
                                    unsigned int *num_buffers,
                                    unsigned int *num_planes,
                                    unsigned int sizes[],
                                    struct device *alloc_devs[])
{
    struct vvcam_video_dev *vvcam_vdev = queue->drv_priv;
    struct v4l2_format *format = &vvcam_vdev->format;
    unsigned int i;

    if (format->type == V4L2_BUF_TYPE_VIDEO_CAPTURE) {
        if (*num_planes) {
            if (*num_planes != 1)
                return -EINVAL;
            if (sizes[0] < format->fmt.pix.sizeimage)
                return -EINVAL;
        } else {
            *num_planes = 1;
            sizes[0] = format->fmt.pix.sizeimage;
        }
    } else if (format->type == V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE) {
        if (*num_planes) {
            if (*num_planes != format->fmt.pix_mp.num_planes)
                return -EINVAL;
            for (i = 0; i < format->fmt.pix_mp.num_planes; i++) {
                if (sizes[i] < format->fmt.pix_mp.plane_fmt[i].sizeimage)
                    return -EINVAL;
            }
        } else {
            *num_planes = format->fmt.pix_mp.num_planes;
            for (i = 0; i < format->fmt.pix_mp.num_planes; i++) {
                sizes[i] = format->fmt.pix_mp.plane_fmt[i].sizeimage;
            }
        }
    } else {
        return -EINVAL;
    }

    return 0;
}
```

但 QBUF 会被转发给 ISP subdev：

```c
/* buildroot-overlay/package/vvcam/v4l2/video/vvcam_video_register.c */

memset(&pad_buf, 0, sizeof(pad_buf));
pad_buf.pad = pad->index;
pad_buf.buf = buf;
v4l2_subdev_call(subdev, core, ioctl, VVCAM_PAD_BUF_QUEUE, &pad_buf);
```

ISP subdev 再发 event 给 daemon：

```c
/* buildroot-overlay/package/vvcam/v4l2/isp/vvcam_isp_driver.c */

static int vvcam_isp_pad_s_stream(struct v4l2_subdev *sd, void *arg)
{
    struct vvcam_pad_stream_status *pad_stream = (struct vvcam_pad_stream_status *)arg;
    struct vvcam_isp_dev *isp_dev = v4l2_get_subdevdata(sd);
    int ret;

    isp_dev->pad_data[pad_stream->pad].stream = pad_stream->status;

    if (pad_stream->status == 0 ) {
        INIT_LIST_HEAD(&isp_dev->pad_data[pad_stream->pad].queue);
    }
    ret = vvcam_isp_s_stream_event(isp_dev, pad_stream->pad, pad_stream->status);

    return ret;
}
```

stream event：

```c
/* buildroot-overlay/package/vvcam/v4l2/isp/vvcam_isp_event.c */

int vvcam_isp_s_stream_event(struct vvcam_isp_dev *isp_dev, int pad, uint32_t status)
{
    struct vvcam_isp_event_pkg *event_pkg = isp_dev->event_shm.virt_addr;
    int ret = 0;

    mutex_lock(&isp_dev->event_shm.event_lock);
    event_pkg->head.pad = pad;
    event_pkg->head.dev = isp_dev->id;
    if (status) {
        event_pkg->head.eid = VVCAM_ISP_EVENT_STREAMON;
    } else {
        event_pkg->head.eid = VVCAM_ISP_EVENT_STREAMOFF;
    }

    event_pkg->head.shm_addr = isp_dev->event_shm.phy_addr;
    event_pkg->head.shm_size = isp_dev->event_shm.size;
    event_pkg->head.data_size = 0;
    event_pkg->ack = 0;
    event_pkg->result = 0;

    ret = vvcam_isp_post_event(&isp_dev->sd, event_pkg);

    mutex_unlock(&isp_dev->event_shm.event_lock);
    return ret;
}
```

和主线的差异：

```text
主线:
    vb2 buffer lifecycle 通常由内核 driver 和硬件中断驱动。
    STREAMON 触发内核内部 pipeline start 和 subdev s_stream。

K230:
    vb2 仍在内核，但 buffer/stream 状态还要通知 daemon。
    daemon 成为 buffer 地址、stream on/off 和 ISP runtime 的参与者。
```

## 9. 差异七：control 到寄存器不在内核 subdev 内闭环

K230 的 ISP event id 包含 control：

```c
/* buildroot-overlay/package/vvcam/v4l2/isp/vvcam_isp_event.h */

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
```

`S_CTRL` 被打包进共享内存，再发给 daemon：

```c
/* buildroot-overlay/package/vvcam/v4l2/isp/vvcam_isp_event.c */

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
```

底层实际寄存器写不在 `v4l2/isp` 的 control 回调里，而是在 daemon 的 vendor stack 里。我们已经能从 `isp_media_server_debian` 的符号看到这些函数：

```text
MediaIspGeSetCtrl
CamerIcIspGeSetThreshold
CamerIcIspWriteReg
BinderHalWriteReg
isp_drv_write_reg
```

和主线的差异：

```text
主线:
    control handler 通常由内核 subdev driver 实现。
    s_ctrl 最终在内核里写对应硬件寄存器，或调用内核内部 helper/HAL。

K230:
    内核 control handler 主要负责打包 event。
    寄存器级别落实由用户态 daemon 的 vendor ISP stack 完成。
```

## 10. 差异八：依赖 daemon，驱动本身不是自闭环

daemon 启动脚本：

```sh
/* buildroot-overlay/package/vvcam/deb/etc/vvcam/isp_start.sh */

modprobe vvcam_isp
modprobe vvcam_mipi
modprobe vvcam_vb
modprobe vvcam_isp_subdev
modprobe vvcam_video

ISP_MEDIA_SENSOR_DRIVER=/lib/riscv64-linux-gnu/libvvcam.so \
    /usr/bin/isp_media_server_debian >/tmp/isp.err.log 2>&1 &
```

private event 发送前会检查是否有订阅者：

```c
/* buildroot-overlay/package/vvcam/v4l2/isp/vvcam_isp_event.c */

if (!vvcam_isp_event_subscribed(sd, event.type, event.id)) {
    dev_err(sd->dev, "post event %d not subscribed\n", event.id);
    return -EINVAL;
}
```

这意味着 daemon 没有运行、没有打开 devnode、没有订阅 event 时，许多标准 V4L2 操作会失败。

和主线的差异：

```text
主线 driver:
    用户态应用可以只通过标准 V4L2/MC/subdev API 使用设备。
    即便有 libcamera 或 3A daemon，基础驱动通常仍自洽。

K230:
    isp_media_server_debian 是 pipeline/control/buffer/stream runtime 的必要组成。
    标准 V4L2 API 入口背后依赖 private daemon 协议。
```

## 11. pipeline 到底是谁维护的

可以按层回答：

```text
Media graph/topology:
    内核维护。
    由 media_entity、media_pad、media_link 表示。
    K230 通过 media_create_pad_link() 创建 link。
    /dev/mediaX 可以枚举到这些 entity/pad/link。

Video node buffer queue:
    内核 vb2 维护。
    vvcam_video 负责 queue_setup、buf_prepare、start_streaming、stop_streaming。

K230 runtime ISP pipeline:
    daemon 维护。
    vvcam_video_create_pipeline_event() 只是通知 daemon 创建 pipeline。
    vvcam_video_destroy_pipeline_event() 通知 daemon 销毁 pipeline。
    stream/control/buffer 等 runtime 动作也通过 VVCAM_ISP_DEAMON_EVENT 通知 daemon。

寄存器级硬件状态:
    daemon 内部 vendor ISP IP/HAL 决策。
    最底层通过 vvcam_isp misc driver 或 mmap/devmem 类路径访问寄存器。
```

所以如果问“pipeline 是谁维护的”，最准确的答案不是单选，而是：

```text
拓扑 pipeline:
    Linux Media Controller 维护。

运行时 ISP pipeline:
    isp_media_server_debian 维护。

video buffer 生命周期:
    Linux vb2 和 daemon 共同参与。

硬件寄存器状态:
    daemon 的 vendor ISP stack 决策，内核 misc ISP driver 执行底层 readl/writel。
```

## 12. 为什么说它和主线差异较大

主要不是因为它用了 private ioctl 或 private event 这件事本身，而是因为 private 协议承载了太多主线通常由内核 driver/subdev state machine 承担的职责。

差异可以压缩成这张表：

| 维度 | 主线常见做法 | K230 vvcam 做法 |
| --- | --- | --- |
| 拓扑来源 | DT/fwnode graph + async notifier | 当前 build 主要使用静态 C link 表 |
| MC graph 角色 | 拓扑、link validate、pipeline start/stop、format consistency 的一部分 | 主要用于暴露拓扑和找 remote subdev |
| pipeline 生命周期 | 内核 MC/subdev/vb2 状态机 | private event 通知 daemon create/destroy |
| video ioctl | bridge/video driver 调用标准 subdev ops | 转成 VVCAM_PAD_* private subdev ioctl |
| subdev ops | pad/video/core ops 语义化分工 | core.ioctl 私有分发器承载大量操作 |
| streamon | vb2 start 后内核启动 pipeline/subdev | VVCAM_PAD_S_STREAM -> VVCAM_ISP_EVENT_STREAMON -> daemon ack |
| control | 内核 ctrl handler 落到硬件驱动 | ctrl handler 打包 event，daemon 落到寄存器 |
| event | 通知语义为主 | 同步 RPC + ack/result |
| daemon | 可选算法/策略层居多 | pipeline/control/buffer/stream runtime 必需 |
| 主线化难点 | 符合标准 API 和内核状态机 | 需要把 daemon 私有协议里的职责拆回内核标准 ops |

## 13. 主线化或重构方向

如果目标是更接近主线，可以按优先级拆：

```text
1. 拓扑
   用 DT/fwnode graph 描述 sensor/csi/isp/video 连接。
   减少 VVCAM_PLATFORM_REGISTER 静态 C link 表。

2. subdev ops
   把 VVCAM_PAD_S_STREAM 迁移到标准 .s_stream 或 enable_streams/disable_streams。
   把格式协商迁移到标准 pad ops。
   实现 link_validate。

3. controls
   能标准化的 control 使用标准 V4L2 CID。
   vendor 私有 control 可以仍用 V4L2_CID_PRIVATE_BASE/vendor range，但 s_ctrl 应尽量内核闭环。

4. events
   private event 可以保留用于调试或异步通知。
   不建议继续让标准 ioctl 成功依赖 daemon 写 ack。

5. daemon
   把 daemon 从“硬件执行者”降级为“策略/算法/tuning 管理者”。
   例如 3A、tuning 参数计算可以在用户态，但寄存器提交路径最好由内核 driver 控制。

6. register/IP driver
   把 CamerIcIsp* 这类 IP block driver 尽量内核化或拆出清晰的 kernel HAL。
   daemon 通过标准 V4L2 controls/subdev API 配置，而不是直接承担 pipeline runtime。
```

## 14. 结论

K230 vvcam 并不是完全脱离主线框架。它确实注册了标准 `video_device`、`v4l2_subdev`、`media_entity`、`media_pad`、`media_link`、`vb2_queue` 和 `v4l2_ctrl_handler`，因此普通应用可以看到 `/dev/videoX`、`/dev/mediaX`、subdev devnode 这些主线对象。

但它把很多主线 MC-centric driver 的运行时职责移到了私有协议和用户态 daemon：

```text
CREATE_PIPELINE / DESTROY_PIPELINE
REQBUFS / QBUF
STREAMON / STREAMOFF
S_CTRL / G_CTRL
SET_FMT
S_SELECTION
```

这些动作不是单纯在内核 subdev ops 中闭环，而是经过：

```text
video ioctl
    -> VVCAM_PAD_* private ioctl
    -> ISP subdev private ioctl
    -> VVCAM_ISP_EVENT_* private event
    -> daemon
    -> vendor ISP HAL/IP driver
    -> /dev/vvcam-isp.0
    -> readl/writel
```

因此，最准确的概括是：

```text
K230 vvcam 是“主线 V4L2/MC 外壳 + 私有 RPC bridge + 用户态 ISP runtime”的混合架构。

它的 MC pipeline 是内核维护的拓扑。
它的 ISP runtime pipeline 是 daemon 维护的实际运行状态。
```

