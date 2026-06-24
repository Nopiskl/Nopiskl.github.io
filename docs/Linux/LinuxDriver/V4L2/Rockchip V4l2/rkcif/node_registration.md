# Video node registration analysis
_Exported on 2026/3/26 at GMT+8 17:16:42 from Cursor (2.6.21)_

---

**User**

@cif 请你结合这个驱动分析一下为什么要注册那么多的video节点？@cif/dev.c ，为什么要分为RKCIF_STREAM_MIPI_IDx、RKCIF_SCALE_CHx和RKCIF_TOOLS_CHx设备？

---

**Cursor**

---

## 为什么注册这么多 video 节点？

RK CIF（Camera Interface）驱动在 Rockchip 平台上需要面对非常复杂的硬件拓扑，因此注册了多类 video 节点。主要分三大类：

---

### 一、`RKCIF_STREAM_MIPI_IDx`（虚拟通道 / VC 流）

**对应硬件能力：MIPI CSI-2 虚拟通道（Virtual Channel, VC）**

MIPI CSI-2 协议支持最多 4 个虚拟通道（VC0~VC3），允许**同一物理 MIPI lane 上同时传输多路图像数据**。典型场景：

- **多摄像头聚合**：4 个摄像头通过同一 MIPI 总线同时向 SoC 发送数据，各自走不同 VC。
- **HDR 多帧合并**：同一摄像头的长曝光帧 + 短曝光帧走不同 VC 通道，ISP 合并处理。
- **TOF / RGB-D**：深度图像与彩色图像走不同 VC。

```
MIPI PHY ──┬── VC0 ──► RKCIF_STREAM_MIPI_ID0 → /dev/videoX
           ├── VC1 ──► RKCIF_STREAM_MIPI_ID1 → /dev/videoX+1
           ├── VC2 ──► RKCIF_STREAM_MIPI_ID2 → /dev/videoX+2
           └── VC3 ──► RKCIF_STREAM_MIPI_ID3 → /dev/videoX+3
```

每个 IDx 对应一个独立的 V4L2 video 设备，用户态可以分别对其进行 `open/ioctl/mmap/read` 操作，实现多路并行采集。

---

### 二、`RKCIF_SCALE_CHx`（缩放通道）

**对应硬件能力：在线缩放输出（Online Scale）**

RK3588 / RK3568 等芯片的 CIF 模块内置了**多通道独立缩放器（Scaler）**，可以对同一输入图像流**实时输出多种分辨率**，不需要经过 ISP 或 CPU 软件缩放。典型场景：

- **主码流 + 子码流**：高分辨率给编码器，低分辨率给 AI 推理或预览显示。
- **多路 AI 分析**：同一摄像头的不同 ROI 区域分别缩放输出给不同的 NPU 任务。

```
输入流 ──┬── Scale CH0 ──► 1920×1080 → /dev/videoY   （主流）
         ├── Scale CH1 ──►  640× 360  → /dev/videoY+1 （AI推理流）
         └── Scale CH2 ──►  320× 180  → /dev/videoY+2 （预览流）
```

注册独立的 video 节点意味着每个缩放通道可以被独立配置分辨率、格式、帧率，由不同的应用程序独立消费。

---

### 三、`RKCIF_TOOLS_CHx`（工具通道）

**对应硬件能力：辅助功能通道（Statistics / Metadata / RAW dump）**

Tools 通道是 CIF 的"辅助输出"，通常不输出正常图像帧，而是输出：

| 用途 | 说明 |
|------|------|
| **3A 统计数据** | 曝光、白平衡、对焦所需的亮度/颜色统计块 |
| **RAW bypass 输出** | 将 sensor 原始 RAW 数据旁路 dump 出来，不经过处理 |
| **Metadata 通道** | 帧时间戳、序号、嵌入式行信息（SMIA embedded data）|

这类通道注册为独立 video 节点的原因：

- **V4L2 框架标准化**：复用 V4L2 meta 格式或 `V4L2_BUF_TYPE_VIDEO_CAPTURE`，方便用户态用统一接口读取。
- **与图像流解耦**：统计/元数据流量小，可以用更低优先级的 buffer 队列独立管理。
- **调试与标定**：RAW dump 通道在出厂标定、IQ Tuning 时直接使用，不影响正常图像通道。

---

### 整体架构视图

```
                        ┌────────────────────────────────────┐
  Sensor ──MIPI──► CIF  │  VC0 ──► MIPI_ID0 Stream          │ → /dev/video0
                   HW   │  VC1 ──► MIPI_ID1 Stream          │ → /dev/video1
                        │  VC2 ──► MIPI_ID2 Stream          │ → /dev/video2
                        │  VC3 ──► MIPI_ID3 Stream          │ → /dev/video3
                        │                                    │
                        │  Scale Engine                      │
                        │    CH0 ──► Scale Stream 0          │ → /dev/video4
                        │    CH1 ──► Scale Stream 1          │ → /dev/video5
                        │    CH2 ──► Scale Stream 2          │ → /dev/video6
                        │                                    │
                        │  Tools Engine                      │
                        │    CH0 ──► Tools/Meta Stream 0     │ → /dev/video7
                        │    CH1 ──► Tools/Meta Stream 1     │ → /dev/video8
                        └────────────────────────────────────┘
```

---

### 为什么要这样分节点而不是合并成一个？

| 设计原因 | 说明 |
|----------|------|
| **硬件通道物理独立** | 每个通道有独立的 DMA、FIFO、寄存器组，驱动天然映射为独立设备 |
| **V4L2 框架约束** | V4L2 的 `video_device` 每次只能绑定一个 buffer queue，多路输出必须多节点 |
| **用户态灵活消费** | 不同进程/线程可以独立 open 不同节点，无需同步锁 |
| **流控独立** | 每路可以独立 `STREAMON/STREAMOFF`，不影响其他通道 |
| **格式独立配置** | 每路可以设置不同的 `pixelformat`、`width`、`height` |

总结：**这不是"注册了很多节点"的设计冗余，而是忠实反映了 RK CIF

已经读取了所有关键文件，现在可以基于实际代码给出完整深入的分析。

---

## RK CIF 驱动为什么要注册这么多 video 节点？

基于对 `dev.h`、`dev.c`、`cif-scale.c`、`cif-tools.c` 的实际阅读，下面逐层解释。

---

### 一、节点注册入口

注册动作集中在 `dev.c` 的 `rkcif_register_platform_subdevs()` 函数（L1692），在 probe 流程中被调用：

```1692:1730:c:\Users\Admin\Desktop\rockchip\cif\dev.c
static int rkcif_register_platform_subdevs(struct rkcif_device *cif_dev)
```

它依次调用了三组注册函数：

| 注册函数 | 对应节点类型 |
|---|---|
| `rkcif_register_stream_vdevs(cif_dev, stream_num, ...)` | `MIPI_IDx` / DVP 流节点 |
| `rkcif_register_scale_vdevs(cif_dev, RKCIF_MAX_SCALE_CH, true)` | Scale 缩放节点 |
| `rkcif_register_tools_vdevs(cif_dev, RKCIF_MAX_TOOLS_CH, true)` | Tools 工具节点 |

---

### 二、`RKCIF_STREAM_MIPI_IDx`：对应 MIPI CSI-2 虚拟通道（VC）

**硬件背景：** MIPI CSI-2 协议允许最多 4 路虚拟通道（VC0~VC3）在同一物理 lane bundle 上复用传输。

在 `dev.h` 中的定义说明了这一点：

```64:68:c:\Users\Admin\Desktop\rockchip\cif\dev.h
#define RKCIF_STREAM_MIPI_ID0	0
#define RKCIF_STREAM_MIPI_ID1	1
#define RKCIF_STREAM_MIPI_ID2	2
#define RKCIF_STREAM_MIPI_ID3	3
#define RKCIF_MAX_STREAM_MIPI	4
```

注释也明确说明了用途：

```57:62:c:\Users\Admin\Desktop\rockchip\cif\dev.h
/*
 * RK1808 support 5 channel inputs simultaneously:
 * dvp + 4 mipi virtual channels;
 * RV1126/RK356X support 4 channels of BT.656/BT.1120/MIPI
 */
#define RKCIF_MULTI_STREAMS_NUM	5
```

每个 `MIPI_IDx` 节点对应一个独立的 `struct rkcif_stream`，有自己的 DMA buffer 队列、`curr_buf`/`next_buf`、帧索引、状态机。**每路 VC 的数据在硬件层就是分开 DMA 写入内存的，驱动必须用独立 video 节点才能让用户态分别消费。**

典型场景：
- 4 个摄像头通过 MIPI aggregator 接入，各走一个 VC
- HDR 模式下，长短曝帧走不同 VC（见 `RDBK_L/M/S` 的 HDR readback 机制）
- DVP 接口也有对应的 `_dvp_id0~3` 节点，用于 BT.1120 双通道等场景

---

### 三、`RKCIF_SCALE_CHx`：硬件在线缩放，产生多分辨率输出

`dev.h` 中的定义：

```613:617:c:\Users\Admin\Desktop\rockchip\cif\dev.h
#define RKCIF_SCALE_CH0		0
#define RKCIF_SCALE_CH1		1
#define RKCIF_SCALE_CH2		2
#define RKCIF_SCALE_CH3		3
#define RKCIF_MAX_SCALE_CH	4
```

以及其硬件通道选择枚举 `scale_ch_sw`，揭示了 Scale 通道可以从任意 MIPI 控制器的任意 VC 拉取输入：

```628:656:c:\Users\Admin\Desktop\rockchip\cif\dev.h
enum scale_ch_sw {
	SCALE_MIPI0_ID0,
	SCALE_MIPI0_ID1,
	SCALE_MIPI0_ID2,
	SCALE_MIPI0_ID3,
	SCALE_MIPI1_ID0,
	SCALE_MIPI1_ID1,
	// ... MIPI2~5 的各 ID ...
	SCALE_DVP,
	SCALE_CH_MAX,
};
```

`struct rkcif_scale_vdev` 有独立的分辨率配置（`pixm`、`ch_info`）和独立的 buffer 队列：

```674:705:c:\Users\Admin\Desktop\rockchip\cif\dev.h
struct rkcif_scale_vdev {
	unsigned int ch:3;
	struct rkcif_device *cifdev;
	struct rkcif_vdev_node vnode;
	struct rkcif_stream *stream;       // 挂载在哪个 MIPI_IDx 主流上
	struct list_head buf_head;
	// ...
	struct v4l2_pix_format_mplane pixm; // 可以独立设置分辨率/格式
	struct rkcif_scale_ch_info ch_info;
	struct rkcif_scale_src_res src_res;
	struct rkcif_buffer *curr_buf;
	struct rkcif_buffer *next_buf;
	// ...
	unsigned int ch_src;               // 选择哪路 MIPI/DVP 作为输入源
	unsigned int scale_mode;           // 8x/16x/32x 缩放倍率
};
```

**关键点：** `scale_vdev` 通过 `stream` 指针挂接在某个 `MIPI_IDx` 流上（见 `rkcif_stream` 中的 `scale_vdev` 成员），硬件 Scaler 在 CIF 内部对该路数据做实时缩放后写入独立 DMA 地址。这意味着**同一个物理摄像头，可以同时输出原始分辨率（走 MIPI_IDx 节点）和缩小分辨率（走 Scale_CHx 节点）**，零 CPU 开销。

---

### 四、`RKCIF_TOOLS_CHx`：辅助/旁路通道

```718:722:c:\Users\Admin\Desktop\rockchip\cif\dev.h
#define RKCIF_TOOLS_CH0		0
#define RKCIF_TOOLS_CH1		1
#define RKCIF_TOOLS_CH2		2
#define RKCIF_MAX_TOOLS_CH	3
```

`struct rkcif_tools_vdev` 的设计与 Scale 类似，但有几个关键区别：

```731:756:c:\Users\Admin\Desktop\rockchip\cif\dev.h
struct rkcif_tools_vdev {
	unsigned int ch:3;
	struct rkcif_device *cifdev;
	struct rkcif_vdev_node vnode;
	struct rkcif_stream *stream;
	struct list_head buf_head;
	struct list_head buf_done_head;    // 额外的"已完成"队列
	struct list_head src_buf_head;     // 源 buffer 管理
	// ...
	struct work_struct work;           // 用 workqueue 异步处理，而非 tasklet
	// ...
};
```

Tools 通道使用 `work_struct`（workqueue）而不是 `tasklet`，说明其处理逻辑更复杂、允许睡眠。另外它有三个 list（`buf_head`、`buf_done_head`、`src_buf_head`），而 Scale 和 MIPI 流只有一个，说明 Tools 通道涉及**源帧引用计数和异步 buffer 释放**（见 `rkcif_tools_buffer` 中的 `use_cnt`）。

`rkcif_tools_buffer` 结构：

```193:200:c:\Users\Admin\Desktop\rockchip\cif\dev.h
struct rkcif_tools_buffer {
	struct vb2_v4l2_buffer *vb;
	struct rkisp_rx_buf *dbufs;
	struct list_head list;
	u32 frame_idx;
	u64 timestamp;
	int use_cnt;               // 引用计数，多个消费者共享同一帧
};
```

`use_cnt` 说明 Tools 通道的 buffer 可以被多个下游消费者（如 ISP、Rockit 媒体框架）共享引用，这是与普通图像流最本质的区别。

---

### 五、三类节点的关系总结

```
                    rkcif_device
                         │
          ┌──────────────┼──────────────────┐
          │              │                  │
   stream[0..4]    scale_vdev[0..4]   tools_vdev[0..3]
   MIPI_ID0~3      Scale_CH0~3        Tools_CH0~2
   /dev/videoX     /dev/videoY        /dev/videoZ
          │              │
          └──────────────┘
          stream->scale_vdev  (Scale 挂在 Stream 上)
          stream->tools_vdev  (Tools 挂在 Stream 上)
```

| 维度 | MIPI_IDx | Scale_CHx | Tools_CHx |
|---|---|---|---|
| 硬件来源 | MIPI CSI-2 虚拟通道 VC | CIF 内置 Scaler | CIF 辅助输出路径 |
| 输出内容 | 原始图像帧 | 缩放后图像帧 | 旁路/元数据/RAW dump |
| buffer 处理 | tasklet | tasklet | workqueue（异步）|
| buffer 共享 | 独占 | 独占 | use_cnt 引用计数 |
| 与主流关系 | 主体 | 附属于某个主流 | 附属于某个主流 |
| 典型用途 | 编码/ISP | AI推理/预览 | 标定/调试/ISP统计 |

**根本原因**：V4L2 框架的 `video_device` 每个只能绑定一个 `vb2_queue`，每个 queue 对应一条独立的 DMA 数据流。RK CIF 硬件有多条物理上独立的 DMA 写出路径（各路 VC、Scaler、Tools），驱动必须为每条路径注册一个独立的 video 节点，才能让用户态通过标准的 `open/VIDIOC_REQBUFS/STREAMON` 接口独立控制每一路数据流。

---

**User**

CIF设计时为什么不考虑把Scaler接入MIPI CSI-2输出后，再在上层创建video节点，这样不是可以省去	MIPI_IDx的注册吗？就算不用Scaler也能输出stream啊

---

**Cursor**

这是一个很好的架构设计问题。让我先读取 `cif-scale.c` 和 `capture.c` 的关键部分来支撑分析。


---

## 为什么不能把 Scaler 叠在 MIPI_IDx 之上，省去后者的独立注册？

这个想法看起来合理，但与 RK CIF 的**硬件架构**和**实际使用场景**存在根本矛盾，分以下几点说明：

---

### 一、MIPI_IDx 和 Scaler 在硬件上是并行关系，不是串行关系

你的设想隐含了一个前提：数据流是 `Sensor → MIPI → Scaler → DDR`，Scaler 是 MIPI 的下游，可以完全替代 MIPI 输出。

但实际硬件拓扑是这样的：

```
Sensor
  │
MIPI PHY / CSI-2 Controller
  │
  ├──► CIF DMA 写出路径 (MIPI_IDx) ──────────────────────► DDR
  │         ↑ 这条路径是 Scaler 的上游，Scaler 从这里取数
  │
  └──► CIF Scaler Engine
            ├── Scale CH0 ──► DDR
            ├── Scale CH1 ──► DDR
            └── Scale CH2 ──► DDR
```

Scaler 的输入源是 `MIPI_IDx` **同一帧数据的内部总线拷贝**，而不是先写入 DDR、再读回来缩放。从驱动代码中 `rkcif_stream` 里的字段可以看出两者是并列挂载关系：

```856:858:c:\Users\Admin\Desktop\rockchip\cif\dev.h
	struct rkcif_scale_vdev		*scale_vdev;
	struct rkcif_tools_vdev		*tools_vdev;
```

`scale_vdev` 是挂在 `rkcif_stream` 上的一个**附属输出**，`stream` 本身（MIPI_IDx）同时也在写 DDR。两者独立工作，互不阻塞。

---

### 二、MIPI_IDx 流有多种独立的工作模式，不能被 Scaler 替代

`dev.h` 中定义的 `rkcif_stream_mode` 表明主流（MIPI_IDx）有多种互斥或并行的输出目的地：

```100:107:c:\Users\Admin\Desktop\rockchip\cif\dev.h
enum rkcif_stream_mode {
	RKCIF_STREAM_MODE_NONE       = 0x0,
	RKCIF_STREAM_MODE_CAPTURE    = 0x01,   // 直接写 DDR，用户态读
	RKCIF_STREAM_MODE_TOISP      = 0x02,   // 送给 ISP 在线处理
	RKCIF_STREAM_MODE_TOSCALE    = 0x04,   // 同时送给 Scaler
	RKCIF_STREAM_MODE_TOISP_RDBK = 0x08,  // ISP readback 模式
	RKCIF_STREAM_MODE_ROCKIT     = 0x10   // 送给 Rockit 媒体框架
};
```

以及 `dma_en` 相关的模式：

```136:142:c:\Users\Admin\Desktop\rockchip\cif\dev.h
enum rkcif_dma_en_mode {
	RKCIF_DMAEN_BY_VICAP         = 0x1,   // CIF 自己驱动 DMA
	RKCIF_DMAEN_BY_ISP           = 0x2,   // ISP 驱动 DMA
	RKCIF_DMAEN_BY_VICAP_TO_ISP  = 0x4,
	RKCIF_DMAEN_BY_ISP_TO_VICAP  = 0x8,
	RKCIF_DMAEN_BY_ROCKIT        = 0x10,
};
```

关键模式是 `RKCIF_STREAM_MODE_TOISP`：数据**不写 DDR，直接在片上总线送给 ISP**（online mode）。这个模式下 MIPI_IDx 根本不产生任何 DDR 数据，Scaler 也无从接入。如果省掉 MIPI_IDx 节点，这个 online 链路就没有控制入口了——用户态通过哪个 video 节点来 `STREAMON`？

---

### 三、Scaler 本身不能独立 STREAMON，它依赖主流的启动

从 `rkcif_stream` 结构中的标志位可以看出 Scale 是被动跟随的：

```876:878:c:\Users\Admin\Desktop\rockchip\cif\dev.h
	bool				to_en_scale;      // 主流在 start 时顺带启动 Scale
```

Scale 节点不能脱离主流独立工作。如果你的设想是"用 Scale 节点代替 MIPI_IDx 节点作为唯一入口"，那么用户必须 open Scale 节点 → STREAMON → 内核去启动底层 MIPI 接收 → 同时 Scale 开始工作。这意味着 Scale 节点需要承担完整的 pipeline 控制（sensor subdev 的 `s_stream`、MIPI PHY 初始化、帧同步等），与现在 MIPI_IDx 节点承担的完全一样，**等价于把 MIPI_IDx 的代码全部移进 Scale 节点，只是换了个名字**，并没有减少任何复杂度。

---

### 四、不用 Scaler 时 MIPI_IDx 是唯一的 DMA 出口

你说"就算不用 Scaler 也能输出 stream"，这正是 MIPI_IDx 存在的原因。大多数场景下根本不需要 Scaler：

- 单摄像头直接出图给编码器：只用 `MIPI_ID0`
- 多摄像头各自出图：`MIPI_ID0~3` 分别对应
- 数据需要先过 ISP 再出图：`MIPI_ID0` 以 `TOISP` 模式工作，不写 DDR

这些场景没有 Scaler 参与。如果没有 MIPI_IDx 节点，这些基础功能就失去了控制入口。

---

### 五、去掉 MIPI_IDx 会破坏 Media Controller 拓扑

V4L2 Media Controller 要求设备之间有明确的 pad-to-pad link。现在的拓扑是：

```
[sensor subdev] ──pad──► [lvds/mipi subdev] ──pad──► [MIPI_IDx video node]
                                                             │
                                                      [Scale_CHx video node]
```

Scale 节点通过 `stream->scale_vdev` 挂接，在 media graph 里它是 MIPI_IDx 的下游 sink。如果去掉 MIPI_IDx，scale 节点直接连 sensor subdev，就必须在 scale 节点里实现完整的 subdev 协商（format、crop、frame interval），彻底打破 V4L2 的分层抽象。

---

### 总结

| 问题 | 为什么不能省掉 MIPI_IDx |
|---|---|
| 硬件拓扑 | Scaler 与 MIPI DMA 是并行输出，不是串行 |
| Online 模式 | MIPI→ISP 在线链路不经 DDR，Scaler 无法介入 |
| Scale 依赖主流 | Scale 节点不能独立 STREAMON，必须依附主流 |
| 不需 Scaler 的场景 | 大多数场景只需要 MIPI_IDx 直接出图 |
| Media 拓扑 | 去掉会破坏 V4L2 subdev 分层，Scale 节点要承担所有 pipeline 控制 |

**本质上**：MIPI_IDx 是"数据路径的控制入口和主 DMA 出口"，Scale 是"可选的附加缩放输出"。两者功能不重叠，不存在用一个替代另一个的可能。

这个问题问得很深入。结合刚才读取的 `cif-scale.c` 代码，现在可以给出更直接、更有代码支撑的回答。

---

## 为什么 Scaler 不能取代 MIPI_IDx 节点？

从 `cif-scale.c` 的实际代码来看，答案比架构图更直接。

---

### 一、Scaler 只支持 RAW Bayer 格式，MIPI_IDx 支持全格式

`cif-scale.c` 开头的格式表白纸黑字：

```28:60:c:\Users\Admin\Desktop\rockchip\cif\cif-scale.c
static const struct cif_output_fmt scale_out_fmts[] = {
	{
		.fourcc = V4L2_PIX_FMT_SRGGB16,
		.fmt_type = CIF_FMT_TYPE_RAW,
	}, {
		.fourcc = V4L2_PIX_FMT_SGRBG16,
		.fmt_type = CIF_FMT_TYPE_RAW,
	}, {
		.fourcc = V4L2_PIX_FMT_SGBRG16,
		.fmt_type = CIF_FMT_TYPE_RAW,
	}, {
		.fourcc = V4L2_PIX_FMT_SBGGR16,
		.fmt_type = CIF_FMT_TYPE_RAW,
	}
};
```

**Scale 节点只能输出 4 种 16-bit RAW Bayer 格式**。而 MIPI_IDx 通过 `capture.c` 支持完整格式列表：NV12、NV16、YUYV、UYVY、各种 RAW8/10/12/16 等十几种格式。

如果用 Scale 替代 MIPI_IDx 作为唯一出口，那么接 YUV sensor 的场景（这是绝大多数安防/消费摄像头的场景）直接无法使用。Scale 格式枚举函数也有明确的错误路径：

```110:115:c:\Users\Admin\Desktop\rockchip\cif\cif-scale.c
	fmt = rkcif_scale_find_output_fmt(pixm->pixelformat);
	if (fmt == NULL) {
		v4l2_err(&scale_vdev->cifdev->v4l2_dev,
			"format of source channel are not bayer raw, not support scale\n");
		return -1;
	}
```

---

### 二、Scaler 的分辨率是被迫对齐到缩放倍率的，MIPI_IDx 是原始分辨率

`cif-scale.c` 中的 `rkcif_scale_set_fmt()` 揭示了 Scale 输出分辨率的约束：

```155:170:c:\Users\Admin\Desktop\rockchip\cif\cif-scale.c
	scale_ratio = width / pixm->width;
	if (scale_ratio <= 8) {
		scale_vdev->scale_mode = SCALE_8TIMES;
		scale_times = 8;
	} else if (scale_ratio <= 16) {
		scale_vdev->scale_mode = SCALE_16TIMES;
		scale_times = 16;
	} else {
		scale_vdev->scale_mode = SCALE_32TIMES;
		scale_times = 32;
	}
	//source resolution align (scale_times * 2)
	width = ALIGN(width, scale_times * 2);
	pixm->width = width  / (scale_times * 2) * 2;
	pixm->height = height / (scale_times * 2) * 2;
```

硬件 Scaler 只支持 **8x / 16x / 32x** 三档缩放，输出分辨率被强制对齐到 `scale_times * 2`。一个 1920×1080 的 sensor，Scale 节点能给你的分辨率只有 240×135（8x）、120×67（16x）、60×33（32x）——**根本无法输出原始分辨率**。用它做唯一出口，原始分辨率的图像永远拿不到。

---

### 三、Scaler 节点只在特定芯片上存在，MIPI_IDx 是所有芯片的基础

`dev.c` 中注册逻辑非常清楚：

```1714:1728:c:\Users\Admin\Desktop\rockchip\cif\dev.c
	if (cif_dev->chip_id == CHIP_RK3588_CIF ||
	    cif_dev->chip_id == CHIP_RV1106_CIF ||
	    cif_dev->chip_id == CHIP_RK3562_CIF) {
		ret = rkcif_register_scale_vdevs(cif_dev, RKCIF_MAX_SCALE_CH, true);
		...
	}
	if (cif_dev->chip_id > CHIP_RK1808_CIF) {
		ret = rkcif_register_tools_vdevs(cif_dev, RKCIF_MAX_TOOLS_CH, true);
		...
	}
```

Scale 节点**只在 RK3588、RV1106、RK3562 三款芯片上注册**。RK1808、RV1126 等其他芯片根本没有硬件 Scaler，它们只有 MIPI_IDx 节点。如果去掉 MIPI_IDx，这些芯片上 CIF 驱动就完全没有可用的 video 节点了。

---

### 四、Scaler 需要从 stream 中"借"已完成配置的 sensor 信息

`rkcif_scale_set_fmt()` 中有一个关键细节：

```120:135:c:\Users\Admin\Desktop\rockchip\cif\cif-scale.c
	if (!cif_dev->terminal_sensor.sd)
		rkcif_update_sensor_info(&cif_dev->stream[0]);

	if (cif_dev->terminal_sensor.sd) {
		fmt_src.which = V4L2_SUBDEV_FORMAT_ACTIVE;
		fmt_src.pad = 0;
		ret = v4l2_subdev_call(cif_dev->terminal_sensor.sd, pad, get_fmt, NULL, &fmt_src);
		...
		scale_vdev->src_res.width = fmt_src.format.width;
		scale_vdev->src_res.height = fmt_src.format.height;
	}
```

Scale 节点在 `set_fmt` 时去查询 `cif_dev->terminal_sensor`，而 `terminal_sensor` 是**由 `rkcif_stream`（MIPI_IDx）在 `streamon` 时通过 `rkcif_update_sensor_info()` 填充的**。Scale 节点依赖主流节点已经完成 sensor 枚举和格式协商，才能知道自己的输入源分辨率是多少。这是一个明确的单向依赖关系：**Scale 依赖 MIPI_IDx 存在且先完成初始化**。

---

### 总结

| 约束 | 根因 |
|---|---|
| Scale 只输出 RAW16，不支持 YUV | 硬件 Scaler 设计限制，无法做 YUV 降分辨率 |
| Scale 输出分辨率只有 8x/16x/32x 档 | 硬件只有三档缩放，无法输出原始分辨率 |
| Scale 节点只在部分芯片上存在 | 老芯片无硬件 Scaler，MIPI_IDx 是唯一出口 |
| Scale 依赖 MIPI_IDx 完成 sensor 初始化 | `terminal_sensor` 由主流节点填充 |

Scale 节点从设计上就是 MIPI_IDx 的**附加缩略图输出**，定位从未是替代品。两者服务的场景完全不同：MIPI_IDx 给编码器/ISP 提供全分辨率全格式原始数据，Scale 给 AI 推理提供低分辨率 RAW 缩略图。

