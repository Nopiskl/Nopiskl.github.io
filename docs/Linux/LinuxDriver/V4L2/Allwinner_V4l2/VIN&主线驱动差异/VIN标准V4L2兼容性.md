# Allwinner `sunxi-vin` 标准 V4L2 兼容性分析

## 1. 文档目的

本文基于 `lichee/linux-4.9/drivers/media/platform/sunxi-vin` 整个 VIN 框架源码，对它面向上层 `/dev/videoX` 暴露的“标准 V4L2”能力做一次完整梳理，回答三个问题：

1. 哪些标准 V4L2 调用可以正常使用。
2. 哪些调用虽然有接口，但有明显的实现约束或语义偏差，使用时必须注意。
3. 哪些标准 V4L2 能力不要按“通用 Linux 摄像头驱动”的预期去依赖。

这里的“标准 V4L2”主要指：

- video node 上的标准 ioctl，例如 `VIDIOC_S_FMT`、`VIDIOC_REQBUFS`、`VIDIOC_STREAMON`
- V4L2 control/event 框架
- V4L2 subdev / media graph 在 VIN 内部的配合方式

本文也会结合已有分析结论 `v4l2.md`，尤其是 `get_selection` 报错这个典型例子，说明为什么这个框架“接口表面上很标准，但很多地方其实是 Allwinner VIN 自己定义的行为模型”。

---

## 2. 先给结论

如果只看 `/dev/videoX` 的标准采集流程，这套 VIN 驱动最稳妥的理解方式是：

- 它**支持标准 V4L2 的基本采流模型**，例如 `S_INPUT -> S_PARM -> S_FMT -> REQBUFS/QBUF -> STREAMON -> DQBUF`
- 但它**不是一个“完全按标准抽象”的通用 capture driver**
- 它的 video node 只是整个 VIN pipeline 的一个入口，很多 ioctl 最终会被**转发到 sensor / mipi / csi / isp / scaler 子设备**
- 因此，上层如果按“通用 UVC 摄像头 / 普通 PCIe capture 卡”的习惯去调用，容易踩到一些“接口存在但语义不完全兼容”的点

最重要的总体判断如下：

### 可以正常依赖的

- 基本打开/关闭
- 单平面/多平面中的 `VIDEO_CAPTURE_MPLANE`
- `MMAP` / `USERPTR` 采集
- `REQBUFS / QUERYBUF / QBUF / DQBUF / STREAMON / STREAMOFF`
- `S_INPUT`
- `S_FMT / G_FMT`
- `G_PARM / S_PARM` 的基本帧率配置
- 标准 control 框架的多数常用控制项

### 需要非常注意的

- `S_INPUT` 在这个框架里几乎是“必须先调”的初始化动作
- `TRY_FMT` 不是纯探测，实际上会走 active format 路径
- `ENUM_FMT` / `ENUM_FRAMESIZES` 只能当“参考”，不能当严格能力声明
- `G_FMT` 在 `REQBUFS` 之前，`bytesperline/sizeimage` 可能并不可靠
- `STREAMOFF` 会主动拆 media link，再次 `STREAMON` 不能简单按通用 V4L2 预期理解
- `G_SELECTION / S_SELECTION` 只支持 scaler crop 这一小部分
- control 是否真生效，取决于当前 pipeline 是 YUV sensor 还是 RAW+ISP

### 不要按标准通用能力去依赖的

- 完整 selection 语义
- 传统 crop ioctl
- 完整 frame interval 枚举
- 通用 overlay 能力发现
- 多客户端同时打开
- “capability bits 完整反映真实能力” 这件事本身

## 2.1 直观总表

先用两张表把结论压缩一下，方便快速查阅。

### 兼容性总览

| V4L2 能力/接口 | 结论 | 直观理解 | 关键原因 |
| --- | --- | --- | --- |
| `open/close` | 可正常使用 | 能正常打开关闭，但基本是独占设备 | `vin_open()` 忙时直接 `-EBUSY` |
| `VIDIOC_S_INPUT` | 可正常使用 | 不只是选输入，实际上是在拉起整条 pipeline | 会建 link、open pipeline、init sensor/isp/scaler |
| `VIDIOC_G_INPUT` | 可正常使用 | 能返回当前 front/rear 选择 | 但和 `ENUM_INPUT` 不完全一致 |
| `VIDIOC_ENUM_INPUT` | 需要注意 | 只能当参考，不能当完整输入发现接口 | 只枚举 `index=0`，但 `S_INPUT` 实际支持 `0/1` |
| `VIDIOC_S_FMT/G_FMT` | 可正常使用 | 是主采流路径的一部分 | 会把格式一路传到 sensor/mipi/csi/isp/scaler |
| `VIDIOC_TRY_FMT` | 需要注意 | 不是纯探测，可能改 active format | 内部走的是 `ACTIVE set_fmt` 路径 |
| `VIDIOC_ENUM_FMT` | 需要注意 | 只能当候选列表，不是最终真相 | 枚举的是 VIN host format 表，不是严格按当前 pipeline 过滤 |
| `VIDIOC_ENUM_FRAMESIZES` | 需要注意 | 只能看大致范围 | 返回成 `CONTINUOUS`，但实际常常是离散窗口 |
| `VIDIOC_REQBUFS/QUERYBUF/QBUF/DQBUF` | 可正常使用 | 最成熟、最标准的一条路径 | 官方测试程序主路径就是这一套 |
| `VIDIOC_EXPBUF` | 可正常使用 | buffer 导出接口是有的 | 但后续使用仍受 DMA 连续性和 32-bit DMA 约束 |
| `VIDIOC_STREAMON` | 可正常使用 | 正常启动采流 | 依赖前面 pipeline 已建立 |
| `VIDIOC_STREAMOFF` | 需要注意 | 不只是停流，还会拆 link | 会调用 `__csi_isp_setup_link(...,0)` 和 `__vin_sensor_setup_link(...,0)` |
| `VIDIOC_G_PARM/S_PARM` | 可正常使用 | 基本帧率配置可用 | 但 `capturemode/reserved[]` 混入了私有语义 |
| `VIDIOC_G_SELECTION/S_SELECTION` for `CROP*` | 需要注意 | 只能当 scaler crop 接口用 | video node 固定转发给 scaler sink pad |
| `VIDIOC_G_SELECTION/S_SELECTION` for `COMPOSE` 等 | 不可按标准依赖 | 很容易报 `-EINVAL` | scaler 只实现 `CROP_BOUNDS` 和 `CROP` |
| `VIDIOC_CROPCAP/G_CROP/S_CROP` | 不能用 | 不要按老式 crop API 设计上层 | video node 没实现 |
| `VIDIOC_ENUM_FRAMEINTERVALS` | 不能用 | 标准帧间隔枚举不要依赖 | video node 没实现 |
| 标准 controls | 可正常使用 | 大多数常见 control 都能走通 | 但是否真生效，取决于 RAW+ISP 还是 YUV 路径 |
| `HFLIP/VFLIP` | 需要注意 | 有时序和格式约束 | 某些配置下要求 `S_INPUT` 后或 `STREAMON` 后；LBC 不支持 |
| `VIDIOC_SUBSCRIBE_EVENT` for `CTRL` | 可正常使用 | 订阅 control 事件没问题 | 走标准 `v4l2_ctrl_subscribe_event()` |
| 非 `CTRL` 类型 event | 需要注意 | 入口有，但别当 video node 完整事件源 | video node 本身缺少像 ISP subdev 那样明确的主动事件输出 |
| `MMAP` | 可正常使用 | 最推荐的采集方式 | vb2 主路径支持完整 |
| `USERPTR` | 可正常使用 | 官方也提供了测试程序 | 主路径支持完整 |
| `DMABUF` | 需要注意 | 接口有，但不如 `MMAP/USERPTR` 稳 | 底层是 `vb2_dma_contig_memops`，且 DMA 32-bit |
| `read()` | 需要注意 | 理论支持，但不是推荐主路径 | 更推荐 vb2 queue 模型 |
| overlay 相关 ioctl | 不要按标准 overlay 依赖 | 真实语义是 VIPP OSD/cover/orl | 接口名标准，语义平台私有 |
| `QUERYCAP` | 需要注意 | 能看，但别只信 capability bit | `device_caps` 填写并不完整自洽 |

### 推荐调用顺序

| 阶段 | 推荐调用 | 是否建议固定这样做 | 原因 |
| --- | --- | --- | --- |
| 1 | `open("/dev/videoX")` | 是 | 建立 video node 会话 |
| 2 | `VIDIOC_S_INPUT` | 强烈建议 | 这一步实际上会把整条 VIN pipeline 拉起来 |
| 3 | `VIDIOC_S_PARM` | 建议 | 设置帧率/采集模式，且部分私有配置也依赖这一步 |
| 4 | `VIDIOC_S_FMT` | 强烈建议 | 让格式沿 sensor 到 scaler 全链路生效 |
| 5 | `VIDIOC_REQBUFS` | 强烈建议 | 触发 buffer 大小、`sizeimage`、`bytesperline` 等真正落地 |
| 6 | `VIDIOC_QUERYBUF` + `mmap()` / 准备 `USERPTR` | 强烈建议 | 准备用户态 buffer |
| 7 | `VIDIOC_QBUF` | 强烈建议 | 把 buffer 送入队列 |
| 8 | `VIDIOC_STREAMON` | 强烈建议 | 启动采流 |
| 9 | `VIDIOC_DQBUF` | 强烈建议 | 取帧 |
| 10 | `VIDIOC_STREAMOFF` | 建议 | 正常收尾，但要意识到它会拆 link |
| 11 | `close()` | 建议 | 完整释放 pipeline 和资源 |

### 不推荐的“通用 V4L2 习惯”

| 常见上层习惯 | 在 `sunxi-vin` 上的问题 |
| --- | --- |
| `open` 后直接 `S_FMT`，不调 `S_INPUT` | 很多后续行为依赖 pipeline 已通过 `S_INPUT` 建立 |
| 把 `TRY_FMT` 当无副作用探测 | 这里的 `TRY_FMT` 实际会走 active format 路径 |
| 把 `ENUM_FMT/ENUM_FRAMESIZES` 当最终真实能力 | 这里它们更像“候选能力提示”，不是严格承诺 |
| `STREAMOFF` 后直接按原状态 `STREAMON` | 这里 `STREAMOFF` 会拆链路，不是单纯停 DMA |
| 用 `G_SELECTION(COMPOSE)` 之类标准 target 探测 | scaler 只支持 crop 子集，容易直接 `-EINVAL` |
| 用老式 `CROPCAP/G_CROP/S_CROP` | video node 根本没实现 |
| 用 capability bits 推断所有实际能力 | 这套驱动的 `QUERYCAP` 并不完整反映真实行为 |

---

## 3. VIN 框架的真实结构

这套驱动不是一个单体 capture 驱动，而是一个 media pipeline：

`sensor -> mipi/subLVDS/parallel -> csi -> isp -> scaler(vipp) -> video node`

对应源码中的关键组成：

- video node：`vin-video/vin_video.c`
- format / buffer / video core：`vin-video/vin_core.c`
- sensor：`modules/sensor/*.c`
- sensor 通用 helper：`modules/sensor/sensor_helper.c`
- MIPI：`vin-mipi/sunxi_mipi.c`
- CSI：`vin-csi/sunxi_csi.c`
- ISP：`vin-isp/sunxi_isp.c`
- VIPP/scaler：`vin-vipp/sunxi_scaler.c`

video 节点导出的 ioctl 在 `vin_video.c` 里统一挂出：

- `vin_fops`：`vin_video.c:4567`
- `vin_ioctl_ops`：`vin_video.c:4580`

video node 本身不是“最终能力的唯一实现者”，它经常做两件事：

1. 保存用户态状态
2. 把动作转发到下游 subdev

这决定了后面所有兼容性判断的基调：**不能只看 video node 有没有 ioctl，还要看它把调用转发给了谁。**

---

## 4. video node 实际暴露了哪些标准 V4L2 入口

`vin_video.c:4580-4608` 可见，video node 实现了以下标准入口：

### Capture 主路径

- `VIDIOC_QUERYCAP`
- `VIDIOC_ENUM_FMT` for `VIDEO_CAPTURE_MPLANE`
- `VIDIOC_ENUM_FRAMESIZES`
- `VIDIOC_G_FMT / VIDIOC_TRY_FMT / VIDIOC_S_FMT` for `VIDEO_CAPTURE_MPLANE`
- `VIDIOC_REQBUFS / QUERYBUF / QBUF / DQBUF / EXPBUF`
- `VIDIOC_ENUM_INPUT / G_INPUT / S_INPUT`
- `VIDIOC_STREAMON / STREAMOFF`
- `VIDIOC_G_PARM / S_PARM`
- `VIDIOC_G_SELECTION / S_SELECTION`
- `VIDIOC_SUBSCRIBE_EVENT / UNSUBSCRIBE_EVENT`

### 额外挂出的 overlay 路径

- `VIDIOC_ENUM_FMT` for `VIDEO_OVERLAY`
- `VIDIOC_G_FMT / TRY_FMT / S_FMT` for `VIDEO_OVERLAY`
- `VIDIOC_OVERLAY`

### 另外还有一组非标准私有 ioctl

- 由 `vidioc_default = vin_param_handler` 接住
- 例如 `VIDIOC_SET_VE_ONLINE`、`VIDIOC_SET_VIPP_SHRINK`、`VIDIOC_SET_DMA_MERGE`
- 这些不是标准 V4L2，不能当作“标准能力”的一部分看待

---

## 5. 哪些标准 V4L2 调用可以正常使用

这一部分的意思是：在这套驱动里，这些调用不仅“有入口”，而且其行为大体符合这个框架的设计目标，可以作为常规上层使用路径。

## 5.1 `open` / `close`

可以正常使用，但这是**单客户端模型**。

参考：

- `vin_open()`：`vin_video.c:3923`
- `vin_close()`：`vin_video.c:3947`

行为特点：

- `vin_open()` 如果设备忙，直接返回 `-EBUSY`
- 说明同一个 video 节点并不支持多客户端同时正常工作

结论：

- `open/close` 本身是可用的
- 但它是“独占式采集设备”，不是可以放心多开共享的 V4L2 设备

## 5.2 `VIDIOC_S_INPUT` / `VIDIOC_G_INPUT`

可以正常使用，而且在这个框架里非常关键。

参考：

- `vidioc_g_input()`：`vin_video.c:2482`
- `vidioc_s_input()`：`vin_video.c:2616`
- 真正核心逻辑在 `__vin_s_input()`：`vin_video.c:2512`

`S_INPUT` 做的事情远不只是“选择输入编号”，它实际上会：

- 选择 rear/front sensor
- 建立 sensor 链路：`__vin_sensor_setup_link(..., 1)`
- 建立 csi/isp 链路：`__csi_isp_setup_link(..., 1)`
- `vin_pipeline_call(... open ...)`
- 初始化 ISP
- 初始化 scaler
- 初始化 sensor
- 退出 low power 状态

结论：

- `S_INPUT` 是可用的
- 并且在这套 VIN 驱动里，它实际上承担了“打开整条 pipeline”的职责

补充一个实现细节：

- `vidioc_enum_input()` 只接受 `index == 0`：`vin_video.c:2469-2479`
- 但 `vidioc_g_input()` / `vidioc_s_input()` 实际又按 `0/1` 区分 rear/front sensor：`vin_video.c:2482-2491, 2616-2635`

这说明：

- `ENUM_INPUT` 和 `G_INPUT/S_INPUT` 之间并不完全一致
- 对上层来说，`S_INPUT(0/1)` 可以工作，但不要把 `ENUM_INPUT` 结果当成完整输入集合

## 5.3 `VIDIOC_S_FMT` / `VIDIOC_G_FMT`

可以正常使用，是标准采流流程的核心接口。

参考：

- `vidioc_g_fmt_vid_cap_mplane()`：`vin_video.c:1037`
- `vidioc_s_fmt_vid_cap_mplane()`：`vin_video.c:1464`
- 核心格式传播逻辑：`vin_pipeline_try_format()`：`vin_video.c:1058`
- 真正 set fmt：`__vin_set_fmt()`：`vin_video.c:1278`

它会把格式沿整条 pipeline 往下传：

- sensor `set_fmt`
- mipi `set_fmt`
- csi `set_fmt`
- isp `set_fmt`
- scaler `set_fmt`

然后还会进一步：

- 读取 sensor 当前窗口配置 `GET_CURRENT_WIN_CFG`
- 配 CSI parser crop
- 配 VIPP crop / shrink

结论：

- `S_FMT/G_FMT` 是可正常依赖的
- 但它依赖 pipeline 已经被打开，所以最好在 `S_INPUT` 之后调用

## 5.4 `VIDIOC_REQBUFS / QUERYBUF / QBUF / DQBUF / STREAMON / STREAMOFF`

这是最标准、也最成熟的一条路径。

参考：

- `vin_init_video()`：`vin_video.c:6098`
- queue io mode：`vin_video.c:6137-6143`
- `queue_setup()`：`vin_video.c:761`
- `buffer_prepare()`：`vin_video.c:892`
- `vidioc_streamon()`：`vin_video.c:2307`
- `vidioc_streamoff()`：`vin_video.c:2394`

队列类型明确是：

- `V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE`

支持的 io mode：

- `VB2_MMAP`
- `VB2_USERPTR`
- `VB2_DMABUF`
- `VB2_READ`

其中最可信、最常规的是：

- `MMAP`
- `USERPTR`

因为官方测试程序就分别提供了：

- `vin_test/mplane_image/csi_test_mplane.c`
- `vin_test/mplane_image_userptr/csi_test_mplane.c`

结论：

- 标准 buffer queue + stream 控制是这套驱动最适合上层使用的一部分

补充：

- `VIDIOC_EXPBUF` 也实现了：`vin_video.c:4596`
- 因此 buffer 导出接口本身是有的，但导出后的使用约束仍然受 `dma_contig`/DMA32 条件影响

## 5.5 `VIDIOC_G_PARM` / `VIDIOC_S_PARM`

基本帧率配置可以正常使用。

参考：

- video node：`vin_video.c:2644-2730`
- sensor helper：`modules/sensor/sensor_helper.c:673-707`

sensor helper 明确支持：

- `type == V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE`
- `g_parm` 返回 `V4L2_CAP_TIMEPERFRAME`

这说明：

- 基本的 `timeperframe` 模型是支持的

结论：

- 如果只是设置/获取帧率，这是可以正常使用的

## 5.6 标准 control 框架

大多数常见 control 可以正常走通。

参考：

- control 注册：`vin_init_controls()`：`vin_video.c:5994`
- control get/set：`vin_g_volatile_ctrl()`：`vin_video.c:4110`
- `vin_s_ctrl()`：`vin_video.c:4362`

注册的常见标准控制包括：

- `V4L2_CID_BRIGHTNESS`
- `V4L2_CID_CONTRAST`
- `V4L2_CID_SATURATION`
- `V4L2_CID_HUE`
- `V4L2_CID_AUTO_WHITE_BALANCE`
- `V4L2_CID_EXPOSURE`
- `V4L2_CID_GAIN`
- `V4L2_CID_HFLIP`
- `V4L2_CID_VFLIP`
- `V4L2_CID_EXPOSURE_AUTO`
- `V4L2_CID_FOCUS_*`
- `V4L2_CID_FLASH_LED_MODE`

结论：

- `QUERYCTRL/QUERY_EXT_CTRL/G_CTRL/S_CTRL` 这条标准 control 路径整体可用
- 但具体某个 control 是否真的生效，还要看当前 pipeline 类型，这属于下一章的“注意点”

## 5.7 `VIDIOC_SUBSCRIBE_EVENT`

订阅入口本身是有的。

参考：

- video node：`vin_video.c:3914-3920, 4607-4608`

video node 对 `V4L2_EVENT_CTRL` 走的是：

- `v4l2_ctrl_subscribe_event()`

其它类型则走：

- `v4l2_event_subscribe()`

结论：

- 对 video node 来说，最可依赖的是 `CTRL` 事件
- 其它 event 类型虽然可以“订阅成功”，但 video node 本身并没有像 ISP subdev 那样明显主动 queue 事件，因此不要把它当成完整事件源

## 5.8 subdev devnode

从整个 VIN 框架角度看，subdev 节点也基本是标准可访问的。

参考：

- sensor：`vin-cci/cci_helper.c:341-355`
- mipi：`vin-mipi/sunxi_mipi.c:895-904`
- csi：`vin-csi/sunxi_csi.c:639`
- isp：`vin-isp/sunxi_isp.c:2057-2060`
- scaler：`vin-vipp/sunxi_scaler.c:679-682`

它们都设置了：

- `V4L2_SUBDEV_FL_HAS_DEVNODE`

结论：

- 对调试型上层或 MC/subdev 用户来说，subdev 节点是可以正常访问和使用的

---

## 6. 哪些标准 V4L2 调用“能调，但必须注意”

这一类是最关键的。它们经常让人误判为“标准支持没问题”，但实际上语义和通用 V4L2 预期不同。

## 6.1 `VIDIOC_S_INPUT` 不是普通输入切换，而是“pipeline 初始化”

这点最重要。

如前所述，`S_INPUT` 在这里不仅选择输入，还会：

- 建 media link
- open pipeline
- 初始化 ISP/scaler/sensor

所以在这套驱动里，很多本来在通用 V4L2 里“不一定要求先调 `S_INPUT`”的 ioctl，实际上都隐含依赖 `S_INPUT` 之后的状态。

比如：

- `S_FMT`
- `S_PARM`
- 很多 control
- 私有 ioctl

结论：

- 对 `sunxi-vin`，推荐把 `S_INPUT` 看成“启动 session”的第一步，而不是一个可有可无的输入选择

## 6.2 `VIDIOC_TRY_FMT` 不是纯探测

这是一个明显的语义偏差。

参考：

- `vidioc_try_fmt_vid_cap_mplane()`：`vin_video.c:1252`

关键代码：

- `vin_pipeline_try_format(vinc, &mf, &ffmt, true);`

注意最后一个参数是 `true`，而 `vin_pipeline_try_format()` 内部会据此设置：

- `sfmt.which = set ? V4L2_SUBDEV_FORMAT_ACTIVE : V4L2_SUBDEV_FORMAT_TRY`

也就是说，`TRY_FMT` 在这里走的是 **ACTIVE** format 路径，而不是标准意义上的纯 `TRY`。

结论：

- `TRY_FMT` 有接口
- 但不要把它当成“无副作用探测”
- 如果你的上层逻辑强依赖 `TRY_FMT` 不改动活动状态，这套驱动不适合这么用

## 6.3 `VIDIOC_ENUM_FMT` 只能作为参考，不是严格能力声明

参考：

- `vidioc_enum_fmt_vid_cap_mplane()`：`vin_video.c:1000`
- `vin_find_format(... VIN_FMT_ALL ...)`：`vin_video.c:1005`
- `VIN_FMT_ALL`：`vin-video/vin_video.h:210-217`
- `vin_formats[]`：`vin-video/vin_core.c:115`

问题点在于：

- `ENUM_FMT` 枚举的是 VIN 框架的 host format 表
- 用的是 `VIN_FMT_ALL`
- 而 `VIN_FMT_ALL` 包含了 `VIN_FMT_OSD`

可以看到格式表里：

- `RGB555`、`RGB444`、`RGB32` 标了 `VIN_FMT_RGB | VIN_FMT_OSD`：`vin_core.c:143-165`

这说明 `ENUM_FMT` 不是“严格按当前 sensor + 当前 pipeline + 当前 mode 过滤后的最终格式能力集合”，而更像“VIN 整体格式表的一个外露视图”。

结论：

- `ENUM_FMT` 可以用来做初步筛选
- 但最终能不能成功，仍以 `S_FMT` 的结果为准
- 不建议把 `ENUM_FMT` 当成完全可靠的真实能力声明

## 6.4 `VIDIOC_ENUM_FRAMESIZES` 结果语义不够标准

参考：

- `vidioc_enum_framesizes()`：`vin_video.c:1014`

这里会调用 sensor subdev 的：

- `enum_frame_size`

但返回给用户时：

- 直接把 `fsize->type` 设成 `V4L2_FRMSIZE_TYPE_CONTINUOUS`

同时它并没有根据用户传入的 `pixel_format` 去做严格区分。

而很多 sensor driver 实际上给出的窗口集合是离散的，不是真连续空间。

结论：

- `ENUM_FRAMESIZES` 可以当成“一个大致范围/候选”
- 不能按标准严格语义理解为“这个格式支持连续任意尺寸”

## 6.5 `VIDIOC_G_FMT` 在 `REQBUFS` 前后语义不同

参考：

- `vidioc_g_fmt_vid_cap_mplane()`：`vin_video.c:1037-1054`
- `queue_setup()`：`vin_video.c:761-889`

`G_FMT` 返回的：

- `width/height/pixelformat` 来自 `cap->frame`
- `plane_fmt[].bytesperline`
- `plane_fmt[].sizeimage`

而后两者实际上是在 `queue_setup()` 里计算并写回的：

- `cap->frame.bytesperline[]`
- `cap->frame.payload[]`

这意味着：

- `S_FMT` 之后但 `REQBUFS` 之前，`G_FMT` 的宽高通常是可信的
- 但 `bytesperline/sizeimage` 可能还没有被完整计算好

结论：

- 若上层依赖 `sizeimage`，应优先在 `REQBUFS` 之后确认

## 6.6 `STREAMOFF` 会拆链路，再次 `STREAMON` 不能机械套用通用预期

参考：

- `vidioc_streamon()`：`vin_video.c:2307`
- `vidioc_streamoff()`：`vin_video.c:2394`

标准 V4L2 里，很多驱动的 `STREAMOFF -> STREAMON` 只是停启 DMA/采集状态。

但这里 `STREAMOFF` 额外做了：

- `__csi_isp_setup_link(vinc, 0)`
- `__vin_sensor_setup_link(vinc, ..., 0)`
- 设置 `VIN_LPM`

也就是把 media link 和 low power 状态一起回收了。

而 `STREAMON` 本身并没有对称地重新建链，它主要做的是：

- `vb2_ioctl_streamon`
- `vin_pipeline_call(... set_stream ...)`

结论：

- 对这套驱动，不建议把 `STREAMOFF` 后的再次 `STREAMON` 理解成“原状态原地恢复”
- 更稳妥的上层流程通常是重新 `S_INPUT`，甚至重新 open

## 6.7 `G_SELECTION / S_SELECTION` 只支持 scaler crop 子集

这是你前面那个 `get_selection` 问题的核心，也是 `v4l2.md` 里已经分析过的重点。

参考：

- video node 转发：`vin_video.c:1489-1524`
- scaler `get_selection`：`vin-vipp/sunxi_scaler.c:236-267`
- scaler `set_selection`：`vin-vipp/sunxi_scaler.c:270-283`

video node 的 `G_SELECTION/S_SELECTION` 并不自己实现 selection 逻辑，而是**固定转发给 scaler sink pad**：

- `sel.pad = SCALER_PAD_SINK`
- `sel.which = V4L2_SUBDEV_FORMAT_ACTIVE`

scaler 实际只支持：

- `V4L2_SEL_TGT_CROP_BOUNDS`
- `V4L2_SEL_TGT_CROP`

对其它 target，例如：

- `V4L2_SEL_TGT_COMPOSE`

直接返回 `-EINVAL`。

这也正是 `v4l2-ctl --stream-mmap` 会打出 `get_selection error` 的根因，和 `v4l2.md` 的结论一致。

结论：

- `G_SELECTION/S_SELECTION` 不是“完整标准 selection 支持”
- 只能把它当作“VIPP/scaler crop 接口”使用

## 6.8 `G_PARM / S_PARM` 里混入了明显的私有语义

参考：

- `__vin_s_parm()`：`vin_video.c:2659-2707`
- sensor helper：`sensor_helper.c:692-706`

`timeperframe` 是标准的，但除此之外还有几件不标准的事：

- `capturemode` 使用了 Allwinner 自己的 `V4L2_MODE_VIDEO / IMAGE / PREVIEW`
- 宏定义来自 `vin_test/sunxi_camera_v2.h:26-29`
- `reserved[0] / reserved[1] / reserved[2]` 被拿来传递
  - `use_current_win`
  - `isp_wdr_mode`
  - `large_image`

也就是说：

- 这个接口既承担标准帧率配置
- 又承载了大量平台私有配置

结论：

- `G/S_PARM` 可以用来设置帧率
- 但不要把 `capturemode` 和 `reserved[]` 当作通用标准语义

## 6.9 control 是标准框架，但能力是否成立取决于 pipeline 类型

参考：

- `vin_s_ctrl()`：`vin_video.c:4362-4544`
- `vin_g_volatile_ctrl()`：`vin_video.c:4110-4169`

这套驱动对 control 的处理分成两类：

- RAW Bayer + ISP 路径：大量控制项转发给 ISP
- 非 RAW 路径：很多控制项转发给 sensor / flash / actuator

例如：

- RAW+ISP 时，亮度/对比度/饱和度/白平衡等大量控制项走 ISP：`vin_video.c:4456-4508`
- 非 RAW 时，更多是 sensor 原生 ctrl：`vin_video.c:4509-4540`

这意味着：

- `v4l2-ctl --all` 看到某个 control，并不等价于“所有 sensor / 所有 pipeline 都能稳定支持它”

结论：

- 标准 control 框架可用
- 但具体 control 的有效性具有强烈的平台和 pipeline 条件

## 6.10 `HFLIP/VFLIP` 约束很强

参考：

- `vin_s_ctrl()`：`vin_video.c:4381-4436`

注意点：

- 某些配置下，flip 只能在 `stream on` 之后改
- 另一条路径下，flip 只能在 `S_INPUT` 之后、退出 low power 后改
- LBC 输出格式时不支持 flip

结论：

- `HFLIP/VFLIP` 虽然是标准 control
- 但不要假定它可以像普通 UVC 摄像头那样在任意时刻设置

## 6.11 `ENUM_INPUT` 与真实输入选择不完全一致

参考：

- `vidioc_enum_input()`：`vin_video.c:2469-2479`
- `vidioc_g_input()`：`vin_video.c:2482-2491`
- `vidioc_s_input()`：`vin_video.c:2616-2635`

从接口表面看：

- `ENUM_INPUT` 只枚举出一个输入，名字是 `sunxi-vin`

但实际实现里：

- `G_INPUT/S_INPUT` 仍然使用 `0/1` 区分 rear/front

结论：

- 这不是一个严格自洽的标准 input 枚举模型
- 上层不应依赖 `ENUM_INPUT` 去完整发现所有可选 sensor

## 6.12 `DMABUF` 和 `READ` 虽然声明支持，但优先级应低于 `MMAP/USERPTR`

参考：

- `q->io_modes = VB2_MMAP | VB2_USERPTR | VB2_DMABUF | VB2_READ`：`vin_video.c:6138`
- `q->mem_ops = &vb2_dma_contig_memops`：`vin_video.c:6142`
- DMA mask 32 位：`vin_video.c:6102, 6124-6125`

这说明：

- DMABUF 在接口层是支持的
- 但底层依赖 `dma_contig`，并且 DMA 地址约束是 32 位

因此相比 `MMAP/USERPTR`：

- `DMABUF` 更依赖导入 buffer 的物理条件是否匹配

`READ` 也是类似：

- fops 里有 `vb2_fop_read`：`vin_video.c:4571`
- capability 里也有 `V4L2_CAP_READWRITE`：`vin_video.c:992-995`

但官方测试主路径并不是 `read()` 风格，而是 vb2 queue 流程。

结论：

- `DMABUF` / `READ` 不是完全不能用
- 但在这套驱动上，优先级应低于 `MMAP` 和 `USERPTR`

---

## 7. 哪些标准 V4L2 能力不要按“通用驱动能力”去依赖

这一类的意思是：不是说接口绝对不存在，而是**不要把它们当成标准兼容承诺**。

## 7.1 不要依赖完整 selection 语义

如上所述，selection 只覆盖：

- scaler sink pad 的 `CROP_BOUNDS`
- scaler sink pad 的 `CROP`

不要依赖：

- `COMPOSE`
- `COMPOSE_BOUNDS`
- `NATIVE_SIZE`
- 其它标准 selection target

这也是 `v4l2.md` 中 `get_selection` 报错的直接原因。

## 7.2 不要依赖传统 crop ioctl

video node 并没有实现：

- `VIDIOC_CROPCAP`
- `VIDIOC_G_CROP`
- `VIDIOC_S_CROP`

它走的是 selection 体系，而且还是裁剪过的 selection 子集。

结论：

- 老式 crop API 不要指望

## 7.3 不要依赖 `VIDIOC_ENUM_FRAMEINTERVALS`

从 `vin_ioctl_ops` 看，video node 并没有实现：

- `vidioc_enum_frameintervals`

结论：

- 如果上层依赖标准 frame interval 枚举，这套驱动本身不给

## 7.4 不要把 `QUERYCAP` 里的 capability bit 当成完整真相

参考：

- `vidioc_querycap()`：`vin_video.c:985-997`

这里写法比较特殊：

- `cap->capabilities = VIDEO_CAPTURE_MPLANE | STREAMING | READWRITE | DEVICE_CAPS`
- `cap->device_caps |= V4L2_CAP_EXT_PIX_FORMAT`

问题在于：

- `device_caps` 只 OR 了一个 `EXT_PIX_FORMAT`
- 并没有像很多标准驱动那样把实际 capture/streaming/readwrite 能力完整镜像到 `device_caps`

另外：

- 它实现了 overlay 相关 ioctl
- 但 `QUERYCAP` 并没有声明 `V4L2_CAP_VIDEO_OVERLAY`

结论：

- `QUERYCAP` 能用
- 但不要把 capability bit 当成完全准确的最终能力描述

## 7.5 不要按“标准 overlay 设备”来理解 overlay ioctl

参考：

- overlay format 枚举只取 `VIN_FMT_OSD`：`vin_video.c:1528-1539`
- `S_FMT` overlay 实际是在配 VIPP OSD/cover/orl：`vin_video.c:1767-1950`
- `overlay` ioctl 则在做 OSD 资源使能/释放：`vin_video.c:2090`

这组 ioctl 虽然接口名是标准 overlay API：

- `VIDIOC_G_FMT/TRY_FMT/S_FMT` for `VIDEO_OVERLAY`
- `VIDIOC_OVERLAY`

但真实语义并不是传统 V4L2 overlay 显示通道，而是：

- overlay bitmap
- cover
- ORL
- chromakey
- alpha

本质上是 VIPP OSD 的用户态入口。

结论：

- 这组 ioctl 更适合被视为“借用标准 V4L2 overlay 外壳实现的平台 OSD 功能”
- 不要按标准通用 overlay 设备去依赖

## 7.6 不要依赖多客户端并发

`vin_open()` busy 就返回 `-EBUSY`，说明单 video 节点基本是独占的。

结论：

- 一个程序采流时，不要预期另一个程序还能同时稳定查询/控制同一个 `/dev/videoX`

## 7.7 不要假定所有 subdev 都支持完整标准 subdev pad API

从整个 VIN 框架看，各级 subdev 支持是明显不对称的：

### sensor

以 `gc2053_mipi.c` 为代表：

- video ops：`s_parm / g_parm / s_stream / g_mbus_config`：`gc2053_mipi.c:2335-2340`
- pad ops：`enum_mbus_code / enum_frame_size / get_fmt / set_fmt`：`gc2053_mipi.c:2342-2347`
- 没有 `get_selection / set_selection`

### mipi

- `get_fmt / set_fmt`
- `s_stream / s_mbus_config`
- 无 selection：`sunxi_mipi.c:880-893`

### csi

- `set_selection`
- `get_fmt / set_fmt`
- `s_stream / s_parm / s_mbus_config`
- 没有 `get_selection`：`sunxi_csi.c:611-625`

### isp

- `s_parm / g_parm / s_stream`
- `get_fmt / set_fmt`
- 无 selection：`sunxi_isp.c:1774-1788`

### scaler

- `s_parm / s_stream`
- `get_fmt / set_fmt`
- `get_selection / set_selection`
- 但 selection 只有 crop 子集：`sunxi_scaler.c:654-669`

结论：

- 整个 VIN 子设备层并不是一个“每级都完整支持标准 pad ops”的对称体系
- 上层如果直接操作 subdev，要针对不同节点分别判断能力

---

## 8. 结合 `v4l2.md`：为什么 `get_selection` 是一个典型反例

`v4l2.md` 讨论的核心现象是：

- 上层工具会调用 `VIDIOC_G_SELECTION`
- 驱动打印 `v4l2 sub device scaler get_selection error!`
- 但采流本身未必完全失败

结合这次对整个 VIN 框架的梳理，可以把它抽象成一个标准案例：

### 案例本质

- video node 提供了标准 `G_SELECTION`
- 但它不是完整 video selection 实现，只是把请求转发给 scaler
- scaler 只支持 `CROP_BOUNDS` 和 `CROP`
- 一旦用户态用的是别的标准 target，例如 `COMPOSE`
- 那么这个“标准 ioctl”就会因语义不匹配而返回 `-EINVAL`

参考：

- video node 转发：`vin_video.c:1507-1524`
- scaler 支持范围：`sunxi_scaler.c:236-267`

这正好说明：

- `sunxi-vin` 的很多标准 ioctl 不是“完整实现”
- 而是“把 Allwinner VIN 自己真正需要的那一小部分能力，塞进标准 V4L2 接口壳子里”

这不是说驱动不能用，而是说：

- **上层必须围绕这套框架的真实行为模型来写**
- 而不是仅凭 ioctl 名字推断“标准语义必然成立”

---

## 9. 对上层最安全的标准调用顺序

如果目标只是“稳定采一帧/连续采流”，推荐把流程固定成：

1. `open("/dev/videoX")`
2. `VIDIOC_S_INPUT`
3. `VIDIOC_S_PARM`
4. `VIDIOC_S_FMT`
5. `VIDIOC_REQBUFS`
6. `VIDIOC_QUERYBUF`
7. `VIDIOC_QBUF`
8. `VIDIOC_STREAMON`
9. `VIDIOC_DQBUF`
10. `VIDIOC_STREAMOFF`
11. `close()`

如果还要做 control，建议：

- `S_INPUT` 之后再做大多数 control

如果要重新开始一轮采流，建议：

- 不要只靠 `STREAMOFF -> STREAMON`
- 更稳妥是重新 `S_INPUT`，必要时重新 open

如果只是想探测格式，不建议依赖：

- `TRY_FMT` 的“纯探测”语义

如果要做 crop，只建议使用：

- `G_SELECTION(CROP_BOUNDS)`
- `G_SELECTION(CROP)`
- `S_SELECTION(CROP)`

不要使用：

- `COMPOSE`
- 旧式 `CROPCAP/G_CROP/S_CROP`

---

## 10. 最终分类清单

## 10.1 可以正常调用的

- `open/close`
- `VIDIOC_S_INPUT`
- `VIDIOC_G_INPUT`
- `VIDIOC_SUBSCRIBE_EVENT` for `CTRL`
- `VIDIOC_S_FMT`
- `VIDIOC_G_FMT`
- `VIDIOC_REQBUFS`
- `VIDIOC_QUERYBUF`
- `VIDIOC_QBUF`
- `VIDIOC_DQBUF`
- `VIDIOC_EXPBUF`
- `VIDIOC_STREAMON`
- `VIDIOC_STREAMOFF`
- `VIDIOC_G_PARM`
- `VIDIOC_S_PARM`
- 标准 control 框架的大多数常用项
- `MMAP`
- `USERPTR`

## 10.2 需要有注意点的

- `VIDIOC_TRY_FMT`
- `VIDIOC_ENUM_FMT`
- `VIDIOC_ENUM_FRAMESIZES`
- `VIDIOC_ENUM_INPUT`
- `VIDIOC_G_FMT` 中 `bytesperline/sizeimage`
- `VIDIOC_G_SELECTION`
- `VIDIOC_S_SELECTION`
- `VIDIOC_STREAMOFF` 后再次启动
- `DMABUF`
- `READ`
- 非 `CTRL` 类型的 event 订阅
- `HFLIP/VFLIP`
- control 的实际生效范围
- `QUERYCAP`

## 10.3 不建议按标准通用能力去依赖的

- 完整 selection 语义
- `VIDIOC_CROPCAP`
- `VIDIOC_G_CROP`
- `VIDIOC_S_CROP`
- `VIDIOC_ENUM_FRAMEINTERVALS`
- 多客户端同时访问
- 标准 overlay 设备语义
- capability bit 完整反映实际能力
- “所有 subdev 都具备对称、完整 pad ops” 这个前提

---

## 11. 一句话结论

`sunxi-vin` 不是“标准 V4L2 不兼容”，而是“只对标准 V4L2 的核心采流路径做了较完整支持，对很多扩展语义只实现了它自己框架真正需要的子集”。  
所以对上层来说，**最安全的做法不是追求“所有标准 ioctl 都能调”，而是围绕 VIN 的实际 pipeline 设计，使用那条被官方测试程序和源码主路径真正验证过的调用序列。**
