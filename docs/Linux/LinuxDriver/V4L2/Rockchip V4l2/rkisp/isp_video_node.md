
---

**User**

为什么要在上层单独创建RKCIF_TOOLS_CHx

---

**Cursor**

让我读取 tools 相关的核心源码来给出准确答案。

已经读取了完整的 `cif-tools.c`，现在结合源码给出完整分析。

---

## `RKCIF_TOOLS_CHx` 为什么要单独创建

读完 `cif-tools.c` 的全部代码，可以从以下几个维度给出基于实际代码的回答。

---

### 一、Tools 节点的核心定位：**MIPI_IDx 主流的 CPU 拷贝旁路**

`rkcif_tools_set_fmt()` 揭示了 Tools 节点的格式来源：

```154:162:d:/Users/DELL/Desktop/rockchip/cif/cif-tools.c
static int rkcif_tools_set_fmt(struct rkcif_tools_vdev *tools_vdev,
			       struct v4l2_pix_format_mplane *pixm,
			       bool try)
{
	struct rkcif_stream *stream = tools_vdev->stream;

	*pixm = stream->pixm;   // ← 直接继承主流的分辨率和格式
```

**Tools 节点不能独立配置分辨率和格式**，它只能继承所挂载的 `MIPI_IDx` 主流的格式。这说明 Tools 节点**本质上是主流数据的一个副本出口**，而不是一个独立的采集通道。

---

### 二、数据流向：软件内存拷贝，而非硬件 DMA

这是 Tools 与 MIPI_IDx、Scale 最本质的区别。

`rkcif_tools_buf_done()` 中完成帧数据交付的核心路径：

```302:330:d:/Users/DELL/Desktop/rockchip/cif/cif-tools.c
		/* Dequeue a filled buffer */
		for (i = 0; i < fmt->mplanes; i++) {
			u32 payload_size = tools_vdev->pixm.plane_fmt[i].sizeimage;
			void *src = vb2_plane_vaddr(&buf->vb.vb2_buf, i);
			void *dst = vb2_plane_vaddr(&tools_vdev->curr_buf->vb.vb2_buf, i);

			if (!src || !dst)
				break;

			if (buf->vb.vb2_buf.vb2_queue->mem_ops->finish)
				buf->vb.vb2_buf.vb2_queue->mem_ops->finish(...);

			vb2_set_plane_payload(&tools_vdev->curr_buf->vb.vb2_buf, i,
					      payload_size);
			memcpy(dst, src, payload_size);   // ← CPU memcpy
		}
```

**Tools 节点通过 `memcpy` 把主流的 DMA buffer 内容拷贝到自己的 buffer 里**，而不是让硬件独立 DMA 写出。这意味着：

- Tools **不需要额外的硬件 DMA 通道**，只需要 CPU 时间
- Tools **不占用 CIF 的 DMA 资源**，对主流的帧采集完全无干扰
- 拷贝代价由 CPU 承担，因此 Tools 用 `work_struct`（可睡眠的 workqueue）而非 `tasklet`

`rkcif_tools_work()` 明确了这一点：

```371:378:d:/Users/DELL/Desktop/rockchip/cif/cif-tools.c
static void rkcif_tools_work(struct work_struct *work)
{
	struct rkcif_tools_vdev *tools_vdev = container_of(work,
						struct rkcif_tools_vdev, work);
	if (tools_vdev->stream->dma_en & RKCIF_DMAEN_BY_VICAP)
		rkcif_tools_buf_done(tools_vdev);       // CIF直接采集模式
	else if (tools_vdev->stream->dma_en & RKCIF_DMAEN_BY_ISP)
		rkcif_tools_buf_done_rdbk(tools_vdev);  // ISP readback模式
}
```

同时支持两种工作模式：
- `RKCIF_DMAEN_BY_VICAP`：CIF 直接采集，从主流 buffer 拷贝
- `RKCIF_DMAEN_BY_ISP`：ISP readback 模式，从 `rx_buffer`（`dummy.vaddr`）拷贝

---

### 三、Tools 节点的 `use_cnt` 引用计数机制——支持多消费者共享同一帧

`rkcif_tools_buf_done()` 中的这段代码是 Tools 节点最独特的设计：

```267:279:d:/Users/DELL/Desktop/rockchip/cif/cif-tools.c
	tools_buf->use_cnt = 2;
	tools_buf->frame_idx = buf->vb.sequence;
	tools_buf->timestamp = buf->vb.vb2_buf.timestamp;
```

`use_cnt = 2` 表示同一帧的 source buffer 被**两个消费者同时引用**：
1. 主流（`MIPI_IDx`）通过 `rkcif_vb_done_oneframe()` 将 buffer 归还给用户态
2. Tools 通道完成 `memcpy` 后，再通过 `rkcif_buf_queue()` 将 buffer 重新入队给主流

```297:299:d:/Users/DELL/Desktop/rockchip/cif/cif-tools.c
		rkcif_buf_queue(&tools_buf->vb->vb2_buf);  // 拷贝完毕，源buffer还给主流队列
```

主流的 buffer 在 Tools 拷贝完成之前不会被归还给硬件，保证数据完整性。这个机制允许同一帧原始数据被**主流和 Tools 各使用一次**，而不需要硬件提供两路独立 DMA。

---

### 四、为什么 Tools 需要独立的 video 节点而不是复用主流

根据上述代码，有以下三个不可绕过的理由：

**1. 用户态消费者独立**

Tools 的消费者（如 ISP 调试工具、IQ tuning 工具、标定程序）与主流消费者（编码器、ISP）是完全不同的进程。V4L2 的 `vb2_queue` 只能被一个 `open()` 的进程独占。要让两个进程分别获取同一路摄像头的数据，**必须有两个独立的 video 节点**。

**2. buffer 队列完全独立**

Tools 有自己的三条 list：

```383:388:d:/Users/DELL/Desktop/rockchip/cif/cif-tools.c
	INIT_LIST_HEAD(&tools_vdev->buf_head);       // 用户态 qbuf 进来的空闲 buffer
	INIT_LIST_HEAD(&tools_vdev->buf_done_head);  // 帧结束时放入，等待 work 处理
	INIT_LIST_HEAD(&tools_vdev->src_buf_head);   // 追踪源 buffer 的引用状态
```

主流只有 `buf_head`。Tools 的 `buf_done_head` 用于解耦中断处理（帧结束时快速入队）和 CPU 拷贝（work 里慢慢 memcpy），这种两阶段设计必须有独立的 buffer 管理机制，无法与主流共用同一个 `vb2_queue`。

**3. `STREAMON/STREAMOFF` 独立控制**

Tools 节点有独立的 `rkcif_tools_start/stop()`，与主流的 streaming 状态机完全解耦。主流在 streaming，Tools 可以不启动（不需要 RAW 副本时节省 CPU）；主流关流，Tools 通过 `wait_event_timeout` 等待当前帧处理完毕后再停止，避免 memcpy 过程中 buffer 被提前释放。

---

### 五、总结

| 问题 | 答案（来自代码） |
|---|---|
| Tools 节点的数据来自哪里？ | `memcpy` 主流的 DMA buffer，不是独立硬件 DMA |
| 为什么不合并进主流节点？ | 消费者进程不同，需要独立 `vb2_queue` |
| 为什么用 `work_struct` 不用 `tasklet`？ | `memcpy` 可能耗时较长，需要在进程上下文执行 |
| `use_cnt = 2` 是什么含义？ | 源 buffer 同时被主流和 Tools 引用，保证 memcpy 期间不被硬件覆盖 |
| 什么时候不需要 Tools 节点？ | 不需要 RAW 副本时可以不 STREAMON，不消耗 CPU |
| Tools 节点支持哪些格式？ | RAW8/10/12 所有 Bayer 排列，不支持 YUV |

**一句话总结**：`RKCIF_TOOLS_CHx` 是主流数据的**软件旁路拷贝通道**，专为调试工具、IQ tuning、标定程序等辅助场景设计，通过独立的 video 节点实现零硬件资源占用的同帧副本输出。

```plaintext
static int rkcif_tools_set_fmt(struct rkcif_tools_vdev *tools_vdev,
			       struct v4l2_pix_format_mplane *pixm,
			       bool try)
{
	struct rkcif_stream *stream = tools_vdev->stream;

	*pixm = stream->pixm;   // ← 直接继承主流的分辨率和格式
```

```plaintext
		/* Dequeue a filled buffer */
		for (i = 0; i < fmt->mplanes; i++) {
			u32 payload_size = tools_vdev->pixm.plane_fmt[i].sizeimage;
			void *src = vb2_plane_vaddr(&buf->vb.vb2_buf, i);
			void *dst = vb2_plane_vaddr(&tools_vdev->curr_buf->vb.vb2_buf, i);

			if (!src || !dst)
				break;

			if (buf->vb.vb2_buf.vb2_queue->mem_ops->finish)
				buf->vb.vb2_buf.vb2_queue->mem_ops->finish(...);

			vb2_set_plane_payload(&tools_vdev->curr_buf->vb.vb2_buf, i,
					      payload_size);
			memcpy(dst, src, payload_size);   // ← CPU memcpy
		}
```

```plaintext
static void rkcif_tools_work(struct work_struct *work)
{
	struct rkcif_tools_vdev *tools_vdev = container_of(work,
						struct rkcif_tools_vdev, work);
	if (tools_vdev->stream->dma_en & RKCIF_DMAEN_BY_VICAP)
		rkcif_tools_buf_done(tools_vdev);       // CIF直接采集模式
	else if (tools_vdev->stream->dma_en & RKCIF_DMAEN_BY_ISP)
		rkcif_tools_buf_done_rdbk(tools_vdev);  // ISP readback模式
}
```

```plaintext
	tools_buf->use_cnt = 2;
	tools_buf->frame_idx = buf->vb.sequence;
	tools_buf->timestamp = buf->vb.vb2_buf.timestamp;
```

```plaintext
		rkcif_buf_queue(&tools_buf->vb->vb2_buf);  // 拷贝完毕，源buffer还给主流队列
```

```plaintext
	INIT_LIST_HEAD(&tools_vdev->buf_head);       // 用户态 qbuf 进来的空闲 buffer
	INIT_LIST_HEAD(&tools_vdev->buf_done_head);  // 帧结束时放入，等待 work 处理
	INIT_LIST_HEAD(&tools_vdev->src_buf_head);   // 追踪源 buffer 的引用状态
```


**User**

那你帮我分析一下MIPI_IDx的video节点能否读到被ISP处理后的数据？还是说要从ISP创建的video节点读取？

---

**Cursor**

这个问题直接关系到 CIF→ISP 的数据流向，让我从源码中找到确切的架构证据。

已有足够证据，再补充读取 `rkcif_stream_mode` 和 ISP 输出节点的关系确认。

现在已有完整的证据链，可以给出准确回答。

---

## MIPI_IDx 的 video 节点能否读到 ISP 处理后的数据？

**不能。** 两者的数据流方向和所处位置在架构上完全不同。下面基于源码逐层说明。

---

### 一、三种工作模式决定数据去哪里

`isp/isp_external.h` 定义了 CIF 与 ISP 之间的三种链路模式：

```
enum rkisp_vicap_link {
    RKISP_VICAP_ONLINE,       // CIF→ISP 在线直通，数据不落 DDR
    RKISP_VICAP_RDBK_AIQ,     // CIF 写 DDR，AIQ(3A算法库)触发 ISP 回读
    RKISP_VICAP_RDBK_AUTO,    // CIF 写 DDR，ISP 自动触发回读
};
```

这三种模式的数据流向完全不同：

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 模式一：RKISP_VICAP_ONLINE（在线模式）                                   │
│                                                                         │
│  Sensor→MIPI→CIF ──片上总线──► ISP ──处理──► MP/SP video节点           │
│                 ↑                                                       │
│                 │ MIPI_IDx video节点在此模式下                           │
│                 └─ 没有自己的DDR buffer，用户态dqbuf拿不到任何数据       │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ 模式二/三：RKISP_VICAP_RDBK（回读模式）                                  │
│                                                                         │
│  Sensor→MIPI→CIF ──DMA──► DDR(rx_buf) ──ISP回读──► ISP处理─► MP/SP    │
│                        ↑                                                │
│                   MIPI_IDx stream 把帧写到 rx_buf，                      │
│                   但这个 rx_buf 不是 vb2_queue buffer，                  │
│                   用户态无法通过 MIPI_IDx 节点 dqbuf 拿到它              │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### 二、在线模式：MIPI_IDx 节点完全没有 DDR 输出

`subdev-itf.c:581` 处可以看到在线模式的初始化路径将 `rdbk_mode` 设为 `RKISP_VICAP_ONLINE`，随后 `sditf_change_to_online()` 被调用，这个函数的作用是把 CIF stream 的 `dma_en` 切换到 `RKCIF_DMAEN_BY_ISP`——即 DMA 由 ISP 控制，CIF 侧不分配 `vb2_queue` 的 buffer：

```
subdev-itf.c:634:
if (priv->mode.rdbk_mode == RKISP_VICAP_ONLINE) {
    // 配置 CIF 走片上总线直通 ISP，stream[x] 的 buf_head 始终为空
    ...
}
```

此时打开 `/dev/video_mipi_id0`，`VIDIOC_REQBUFS` 会成功，但 `STREAMON` 之后永远不会有帧完成事件，因为帧数据直接在片上被 ISP 消费，没有任何数据写入 `vb2_queue` 的 buffer。

---

### 三、回读模式：rx_buf 不暴露给 MIPI_IDx video 节点

回读模式下 CIF 把帧写到 `rx_buf`（`rkcif_rx_buffer`），这是 CIF 和 ISP 之间专用的循环内部 buffer，通过 `rkcif_s_rx_buffer()` → `v4l2_subdev_call(sd, video, s_rx_buffer)` 接口传给 ISP：

```
capture.c:1643-1669:
static void rkcif_s_rx_buffer(struct rkcif_device *dev, struct rkisp_rx_buf *dbufs)
{
    ...
    v4l2_subdev_call(sd, video, s_rx_buffer, dbufs, NULL);  // 直接交给 ISP subdev
}
```

`rx_buf` 使用的是 `rkcif_init_rx_buf()` 分配的内部 dummy buffer，**完全独立于 MIPI_IDx video 节点的 `vb2_queue`**。用户态通过 `MIPI_IDx` 节点 `VIDIOC_REQBUFS/QBUF/DQBUF` 操作的 buffer 集合与 `rx_buf` 是两套完全不同的内存，互不相交。

---

### 四、ISP 处理后的数据在哪里读

必须从 **ISP 驱动注册的 video 节点**读取，即 `isp/capture.h` 中定义的：

```
RKISP_STREAM_MP   → /dev/rkisp_mainpath    ISP处理后主路输出（最高分辨率）
RKISP_STREAM_SP   → /dev/rkisp_selfpath    ISP处理后自路输出（预览/辅路）
RKISP_STREAM_FBC  → /dev/rkisp_fbcpath     FBC压缩输出→ISPP后处理
RKISP_STREAM_BP   → /dev/rkisp_bypasspath  旁路输出
```

---

### 五、完整数据流全景

```
                           ┌──────────────────────────────────────────┐
                           │         MIPI_IDx video 节点              │
Sensor                     │  /dev/video_stream_cif_mipi_id0          │
  │                        │  ← 只能读到 ISP处理前的 RAW 原始数据      │
  │ MIPI CSI-2             │  ← 回读模式下才有数据，在线模式下无数据   │
  ▼                        └──────────────────────────────────────────┘
┌─────┐                            ↑（仅回读模式写DDR）
│ CIF │──── rx_buf (内部buffer) ───┘
└─────┘         │
  │             │ rkcif_s_rx_buffer()
  │             ▼
  │         ┌──────────────────────────────────────────────────────────┐
  │         │  ISP (rkisp_device)                                      │
  │         │  - BLC/DPC/LSC/AWB/CCM/Gamma/NR/Sharp 等图像处理        │
  │         │  - 3A统计 → stats_vdev → /dev/rkisp_ispdev              │
  │         │                                                          │
  │         │  ┌────────────────────────────────────────────────────┐ │
  │         │  │  ISP 输出 video 节点（ISP处理后的数据在这里读）     │ │
  │         │  │  /dev/rkisp_mainpath   ← 编码主流                  │ │
  │         │  │  /dev/rkisp_selfpath   ← 预览/辅路                 │ │
  │         │  │  /dev/rkisp_fbcpath    ← ISPP后处理输入            │ │
  │         │  └────────────────────────────────────────────────────┘ │
  │         └──────────────────────────────────────────────────────────┘
  │
  └──── 在线模式(TOISP)：片上总线直通ISP，MIPI_IDx节点无任何DDR数据
```

---

### 六、一句话总结

| 节点 | 数据内容 | 可用模式 |
|---|---|---|
| `MIPI_IDx` (`/dev/video_stream_cif_mipi_idX`) | ISP **处理前**的 RAW 原始数据 | 仅回读模式；在线模式下无数据 |
| `rkisp_mainpath` / `rkisp_selfpath` | ISP **处理后**的 YUV/RGB 数据 | 所有模式均可用 |
| `rkisp_rawwr0~3` | ISP 内部 RAW 写出（HDR 多帧） | HDR 回读模式 |

**要读 ISP 处理后的数据，必须打开 ISP 驱动注册的 `/dev/rkisp_mainpath` 或 `/dev/rkisp_selfpath` 节点，MIPI_IDx 节点永远只能给你 sensor 出来的原始 RAW 数据。**

```plaintext
enum rkisp_vicap_link {
    RKISP_VICAP_ONLINE,       // CIF→ISP 在线直通，数据不落 DDR
    RKISP_VICAP_RDBK_AIQ,     // CIF 写 DDR，AIQ(3A算法库)触发 ISP 回读
    RKISP_VICAP_RDBK_AUTO,    // CIF 写 DDR，ISP 自动触发回读
};
```

```plaintext
┌─────────────────────────────────────────────────────────────────────────┐
│ 模式一：RKISP_VICAP_ONLINE（在线模式）                                   │
│                                                                         │
│  Sensor→MIPI→CIF ──片上总线──► ISP ──处理──► MP/SP video节点           │
│                 ↑                                                       │
│                 │ MIPI_IDx video节点在此模式下                           │
│                 └─ 没有自己的DDR buffer，用户态dqbuf拿不到任何数据       │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ 模式二/三：RKISP_VICAP_RDBK（回读模式）                                  │
│                                                                         │
│  Sensor→MIPI→CIF ──DMA──► DDR(rx_buf) ──ISP回读──► ISP处理─► MP/SP    │
│                        ↑                                                │
│                   MIPI_IDx stream 把帧写到 rx_buf，                      │
│                   但这个 rx_buf 不是 vb2_queue buffer，                  │
│                   用户态无法通过 MIPI_IDx 节点 dqbuf 拿到它              │
└─────────────────────────────────────────────────────────────────────────┘
```

```plaintext
subdev-itf.c:634:
if (priv->mode.rdbk_mode == RKISP_VICAP_ONLINE) {
    // 配置 CIF 走片上总线直通 ISP，stream[x] 的 buf_head 始终为空
    ...
}
```

```plaintext
capture.c:1643-1669:
static void rkcif_s_rx_buffer(struct rkcif_device *dev, struct rkisp_rx_buf *dbufs)
{
    ...
    v4l2_subdev_call(sd, video, s_rx_buffer, dbufs, NULL);  // 直接交给 ISP subdev
}
```

```plaintext
RKISP_STREAM_MP   → /dev/rkisp_mainpath    ISP处理后主路输出（最高分辨率）
RKISP_STREAM_SP   → /dev/rkisp_selfpath    ISP处理后自路输出（预览/辅路）
RKISP_STREAM_FBC  → /dev/rkisp_fbcpath     FBC压缩输出→ISPP后处理
RKISP_STREAM_BP   → /dev/rkisp_bypasspath  旁路输出
```

```plaintext
                           ┌──────────────────────────────────────────┐
                           │         MIPI_IDx video 节点              │
Sensor                     │  /dev/video_stream_cif_mipi_id0          │
  │                        │  ← 只能读到 ISP处理前的 RAW 原始数据      │
  │ MIPI CSI-2             │  ← 回读模式下才有数据，在线模式下无数据   │
  ▼                        └──────────────────────────────────────────┘
┌─────┐                            ↑（仅回读模式写DDR）
│ CIF │──── rx_buf (内部buffer) ───┘
└─────┘         │
  │             │ rkcif_s_rx_buffer()
  │             ▼
  │         ┌──────────────────────────────────────────────────────────┐
  │         │  ISP (rkisp_device)                                      │
  │         │  - BLC/DPC/LSC/AWB/CCM/Gamma/NR/Sharp 等图像处理        │
  │         │  - 3A统计 → stats_vdev → /dev/rkisp_ispdev              │
  │         │                                                          │
  │         │  ┌────────────────────────────────────────────────────┐ │
  │         │  │  ISP 输出 video 节点（ISP处理后的数据在这里读）     │ │
  │         │  │  /dev/rkisp_mainpath   ← 编码主流                  │ │
  │         │  │  /dev/rkisp_selfpath   ← 预览/辅路                 │ │
  │         │  │  /dev/rkisp_fbcpath    ← ISPP后处理输入            │ │
  │         │  └────────────────────────────────────────────────────┘ │
  │         └──────────────────────────────────────────────────────────┘
  │
  └──── 在线模式(TOISP)：片上总线直通ISP，MIPI_IDx节点无任何DDR数据
```

