# 为什么 RAWRD 要做成独立 video node


```text
RAWRD 是 ISP 的 DDR RAW 输入通道。用户态通过 V4L2 ioctl，或内核 CIF 自动回读路径，把已经包含 RAW 数据的 DDR buffer 送到对应 RAWRD stream；驱动随后通过 rawrd_config_mi()/update_rawrd() 配置 RAW readback 的格式、尺寸和 DMA 读地址，再由 ISP 的自动或手动 trigger 逻辑调用 rkisp_trigger_read_back()，让 ISP 从这些 DDR buffer 中读取一帧或一组 HDR RAW 帧进行处理。
```

本文单独解释两个设计问题：

```text
1. 为什么 RKISP_STREAM_RAWRD0/1/2 要暴露成独立 V4L2 output video node？
2. 为什么回读模式要先把 RAW 帧存进 DDR，再让 ISP 从 DDR 读出来？
```

## 1. 先抓住核心区别

RKISP 的输入可以分成两种思路：

```text
在线模式:
ISP 吃实时像素流

回读模式:
ISP 吃 DDR 里已经存在的一帧 RAW
```

在线模式的典型链路是：

```text
Sensor -> CSI2/CIF -> ISP
```

回读模式的典型链路是：

```text
DDR raw buffer -> rkisp_rawrd0/1/2 -> ISP
```

一旦输入变成“DDR 中已有的一帧 RAW”，它就天然需要一个 buffer 队列接口。`rkisp_rawrd0/1/2` 做成独立 video node，本质就是把这个“DDR RAW 输入 ISP”的接口标准化。

## 2. RAWRD 不是普通内部开关

RAWRD 处理的不是在线 pixel stream，而是一块块 DDR buffer。

每一块 buffer 都需要描述：

```text
DMA 地址
图像格式
宽高
bit 深
memory layout
帧序号
时间戳
short/middle/long 曝光类型
什么时候排队
什么时候处理完成
```

V4L2 video output node 正好提供了这套模型：

```text
VIDIOC_S_FMT
REQBUFS / EXPBUF / QBUF
STREAMON
DQBUF / vb2_buffer_done
```

所以 `rkisp_rawrd0/1/2` 被做成：

```text
V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE
V4L2_CAP_VIDEO_OUTPUT_MPLANE
VFL_DIR_TX
MEDIA_PAD_FL_SOURCE
```

它的含义是：

```text
用户态/驱动把 DDR RAW buffer 投递给 RAWRD
RAWRD 把 buffer 的 DMA 地址写给 ISP
ISP 硬件从 DDR 读 RAW
```

## 3. 为什么不只藏在 ISP 驱动内部

如果 RAWRD 只作为 ISP 驱动内部的私有分支，那么它大概率只能服务固定路径，例如：

```text
CIF 自动回读 -> ISP
```

但实际需求更宽：

```text
CIF 抓到的 RAW 再送 ISP
AIQ 保存/处理过的 RAW 再送 ISP
用户态从文件读出的 RAW 送 ISP
测试工具生成 RAW 送 ISP
同一帧 RAW 换一组 ISP 参数重跑
HDR short/middle/long 多曝光分别排队
```

这些场景都需要一个用户态可见、可配置、可排队、可完成通知的入口。

RAWRD 做成独立 video node 后，用户态/AIQ 可以按标准 V4L2 流程控制它：

```text
设置 rawrd 格式
申请或导入 buffer
QBUF
STREAMON
等待处理完成
```

这比新增一堆私有 ioctl 或把逻辑完全藏在 ISP 内部更通用，也更符合 V4L2/media controller 的模型。

## 4. 为什么 buffer 要先存 DDR 再拿出来

在线模式当然更直接：

```text
Sensor -> CIF/CSI2 -> ISP
```

但回读模式故意变成：

```text
Sensor -> CIF -> DDR raw buffer
DDR raw buffer -> RAWRD -> ISP
```

这么做的核心目的不是“多绕一圈”，而是把两个时序解耦：

```text
CIF 接收传感器 RAW 的时序
ISP 处理 RAW 的时序
```

传感器按自己的帧率持续吐数据，CIF 的首要任务是稳定接收，不丢前端数据。ISP 侧则可能因为这些原因不能立刻处理：

```text
AIQ/3A 参数还没准备好
HDR short/middle/long 多帧还没凑齐
ISP 当前还在处理上一帧
多个摄像头共享 ISP
需要在线/回读模式切换
需要同一帧 RAW 重跑调试
```

DDR 在这里就是一个帧缓存边界：

```text
CIF 先把真实 sensor RAW 安全落到 DDR
ISP 后面按自己的节奏从 DDR 取出来处理
```

注意，这里不是 CPU 拷贝整帧图像。数据搬运通常是：

```text
CIF DMA 写 DDR
ISP/MI 从 DDR 读
```

代价是一次 DDR 写和一次 DDR 读，换来的是：

```text
前端接收与 ISP 处理解耦
可排队
可做 HDR 多帧组帧
可由 AIQ 控制处理时机
可重处理/调试
可支持用户态 RAW 输入
```

## 5. 为什么 CIF 不直接交给 RAWRD

CIF 自动回读时，CIF 调用的是 subdev 回调：

```c
v4l2_subdev_call(sd, video, s_rx_buffer, dbufs, NULL);
```

这个 `sd` 必须是：

```text
struct v4l2_subdev *
```

但 `rkisp_rawrd0/1/2` 是：

```text
video_device
```

不是：

```text
v4l2_subdev
```

所以 CIF 找到的远端是：

```text
rkisp-isp-subdev
```

然后 ISP 内部再分发：

```text
BUF_SHORT  -> RKISP_STREAM_RAWRD2
BUF_MIDDLE -> RKISP_STREAM_RAWRD0
BUF_LONG   -> RKISP_STREAM_RAWRD1
```

正确结构是：

```text
CIF sditf
  -> rkisp-isp-subdev.s_rx_buffer()
      -> rkisp_rx_buf_pool_init()
      -> rkisp_rx_qbuf()
          -> RAWRD2 / RAWRD0 / RAWRD1
              -> update_rawrd()
              -> MI_RAWx_RD_BASE
              -> ISP readback
```

## 6. 最短理解

```text
在线模式:
追求低延迟，ISP 直接吃实时流。

回读模式:
追求可控、可排队、可重处理，ISP 从 DDR 吃 RAW 帧。

RAWRD video node:
就是 DDR RAW 输入 ISP 的标准 V4L2 output 接口。
```

所以，RAWRD 独立成 video node，不是因为驱动不能内部处理，而是因为“DDR RAW 输入 ISP”本身就是一个需要格式、buffer、队列、完成通知和用户态控制的标准数据入口。
