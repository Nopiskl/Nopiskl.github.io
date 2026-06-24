
---

**User**

帮我解释一下RKCIF_TOOLS_CHx这个的设计动机

---

**Cursor**

---

## `RKCIF_TOOLS_CHx` 的设计动机

### 一、它是什么：同一帧数据的"旁路拷贝"通道

从 `rkcif_tools_set_fmt()` 的实现可以看到一个非常关键的细节：

```163:171:c:\Users\Admin\Desktop\rockchip\cif\cif-tools.c
static int rkcif_tools_set_fmt(struct rkcif_tools_vdev *tools_vdev,
			       struct v4l2_pix_format_mplane *pixm,
			       bool try)
{
	struct rkcif_stream *stream = tools_vdev->stream;

	*pixm = stream->pixm;   // 直接复制主流的格式，不允许自定义

	if (!try) {
		tools_vdev->tools_out_fmt = stream->cif_fmt_out;
		tools_vdev->pixm = *pixm;
```

**Tools 通道不能自定义格式和分辨率**，它的输出格式完全继承自绑定的 `MIPI_IDx` 主流（`stream->pixm`）。这与 Scale 通道（可以自定义分辨率）截然不同。

这说明 Tools 的设计意图不是做格式转换，而是**对主流数据做一个完整的帧级拷贝**，供另一个消费者使用。

---

### 二、核心机制：`memcpy` 旁路拷贝 + `use_cnt` 引用计数

`rkcif_tools_buf_done()` 是整个 Tools 通道逻辑的核心，代码揭示了两个关键机制：

**机制一：主流 buffer 的引用计数保护**

```601:617:c:\Users\Admin\Desktop\rockchip\cif\cif-tools.c
	tools_buf->use_cnt = 2;   // 固定设为 2：主流消费者 + tools 消费者各持一份引用
	tools_buf->frame_idx = buf->vb.sequence;
	tools_buf->timestamp = buf->vb.vb2_buf.timestamp;
```

主流 buffer 完成时，不会立刻归还给 vb2，而是先被包装进 `rkcif_tools_buffer`，`use_cnt=2` 表示这个 buffer 同时被主流和 tools 通道"占用"，两边都 release 后才真正归还。

**机制二：用 `memcpy` 将主流数据拷贝到 tools 的独立 buffer**

```641:660:c:\Users\Admin\Desktop\rockchip\cif\cif-tools.c
		for (i = 0; i < fmt->mplanes; i++) {
			u32 payload_size = tools_vdev->pixm.plane_fmt[i].sizeimage;
			void *src = vb2_plane_vaddr(&buf->vb.vb2_buf, i);
			void *dst = vb2_plane_vaddr(&tools_vdev->curr_buf->vb.vb2_buf, i);
			// ...
			memcpy(dst, src, payload_size);  // 整帧数据拷贝
		}
		rkcif_buf_queue(&tools_buf->vb->vb2_buf);  // 主流 buffer 归还
		tools_vdev->curr_buf->vb.sequence = tools_buf->frame_idx;
		tools_vdev->curr_buf->vb.vb2_buf.timestamp = tools_buf->frame_idx;
		vb2_buffer_done(&tools_vdev->curr_buf->vb.vb2_buf, VB2_BUF_STATE_DONE);
```

流程是：主流帧到达 → 整帧 `memcpy` 到 tools 的独立 buffer → 主流 buffer 立刻归还重用 → tools buffer 交给用户态。

---

### 三、为什么用 `workqueue` 而不是 `tasklet`

Tools 通道的帧完成处理在 workqueue 中运行：

```780:787:c:\Users\Admin\Desktop\rockchip\cif\cif-tools.c
static void rkcif_tools_work(struct work_struct *work)
{
	struct rkcif_tools_vdev *tools_vdev = container_of(work,
						struct rkcif_tools_vdev,
						work);
	if (tools_vdev->stream->dma_en & RKCIF_DMAEN_BY_VICAP)
		rkcif_tools_buf_done(tools_vdev);
	else if (tools_vdev->stream->dma_en & RKCIF_DMAEN_BY_ISP)
		rkcif_tools_buf_done_rdbk(tools_vdev);
}
```

原因：`memcpy` 一整帧 RAW 图像（4K RAW12 约 30MB）是**不能在中断上下文或 tasklet 中做的**（会长时间占用 CPU、禁止抢占）。workqueue 运行在内核线程上下文，可以被调度、可以休眠，适合这种重量级拷贝操作。相比之下，MIPI_IDx 主流和 Scale 通道只是更新 DMA 地址指针，用轻量的 tasklet 即可。

---

### 四、两种工作模式说明了它的真实用途

`rkcif_tools_work` 根据主流的 `dma_en` 模式分两个路径：

| `dma_en` 模式 | Tools 使用路径 | 含义 |
|---|---|---|
| `RKCIF_DMAEN_BY_VICAP` | `rkcif_tools_buf_done()` | CIF 自己 DMA 写 DDR，tools 从主流 buffer `memcpy` |
| `RKCIF_DMAEN_BY_ISP` | `rkcif_tools_buf_done_rdbk()` | 数据由 ISP 回读（online 模式），tools 从 `dummy` 虚拟 buffer 拷贝 |

第二个路径（`rdbk`）尤为关键：

```706:725:c:\Users\Admin\Desktop\rockchip\cif\cif-tools.c
		for (i = 0; i < fmt->mplanes; i++) {
			u32 payload_size = tools_vdev->pixm.plane_fmt[i].sizeimage;
			void *src = buf->dummy.vaddr;  // 从 dummy buffer 读，而非正常 DMA buffer
			void *dst = vb2_plane_vaddr(&tools_vdev->curr_buf->vb.vb2_buf, i);
			// ...
			dma_sync_single_for_device(...);
			memcpy(dst, src, payload_size);
		}
```

**这意味着 Tools 通道的核心使用场景是 CIF→ISP online 模式下的 RAW 数据旁路截取**：数据主路径是 CIF 直接在片上送给 ISP（不写 DDR），主流的 MIPI_IDx 节点不产生任何 DDR 数据，用户态拿不到原始 RAW。但 Tools 通道会把同一帧数据从 `dummy buffer`（ISP 回读用的内部缓存）中 `memcpy` 出来，写到一个独立的 buffer 里交给用户。

---

### 五、支持格式：全精度 RAW，用于标定和调试

```30:145:c:\Users\Admin\Desktop\rockchip\cif\cif-tools.c
// Tools 支持 RAW8 / RAW10 / RAW12，全部 Bayer 颜色排列
V4L2_PIX_FMT_SRGGB8,  V4L2_PIX_FMT_SGRBG8,  V4L2_PIX_FMT_SGBRG8,  V4L2_PIX_FMT_SBGGR8,
V4L2_PIX_FMT_SRGGB10, V4L2_PIX_FMT_SGRBG10, V4L2_PIX_FMT_SGBRG10, V4L2_PIX_FMT_SBGGR10,
V4L2_PIX_FMT_SRGGB12, V4L2_PIX_FMT_SGRBG12, V4L2_PIX_FMT_SGBRG12, V4L2_PIX_FMT_SBGGR12,
```

对比 Scale 只支持 RAW16，Tools 支持 RAW8/10/12 三种精度，与 sensor 输出的原生精度一致，适合：
- **IQ Tuning（图像质量标定）**：需要 sensor 输出的原始 RAW 数据，不能有任何处理
- **出厂 OTP 标定**：LSCM（镜头阴影校正）标定需要未经 ISP 处理的 RAW 帧
- **在线调试**：ISP 开发过程中随时 dump 当前帧的原始输入

`CIF_TOOLS_REQ_BUFS_MIN = 1` 也说明它不追求高吞吐量，**只需要抓一帧就够**，是典型的调试/工具用途。

---

### 总结：Tools 通道存在的根本理由

```
                    ┌─────────────────────────────────┐
  Sensor → CIF ────┤ MIPI_IDx 主流                   ├──► 编码器 / ISP（正常业务）
                   │   ↓ 帧完成时触发 work           │
                   │ Tools_CHx（旁路工具通道）        │
                   │   memcpy 整帧数据                │
                   │   ↓                              │
                   │ /dev/video_tools_id0             ├──► IQ Tuning / 调试工具
                   └─────────────────────────────────┘
```

**一句话概括**：Tools 通道是"在不影响正常视频业务的前提下，以 workqueue 异步 memcpy 的方式，为图像调试工具和标定流程提供原始 RAW 帧的旁路输出通道"，尤其是在 CIF→ISP online 直连模式下，它是拿到 sensor 原始数据的唯一途径。

---

**User**

详细讲一下memcpy 旁路拷贝 + use_cnt 引用计数

---

```
硬件帧完成
    │
    ▼
active_buf 进入 tools_vdev->buf_done_head
    │
    ▼
workqueue 取出 active_buf
    │
    ├─ tools_buf->vb = &active_buf->vb
    ├─ tools_buf->use_cnt = 2
    │
    ├─ rkcif_vb_done_oneframe(active_buf)
    │     └─ vb2_buffer_done()
    │         主流用户态可以 DQBUF
    │         注意：这里不减 use_cnt
    │
    ├─ memcpy(active_buf -> tools curr_buf)
    │
    ├─ rkcif_buf_queue(active_buf)
    │     └─ use_cnt: 2 -> 1
    │         因为还没归零，所以 return，不真正回 DMA 队列
    │
    └─ vb2_buffer_done(tools curr_buf)
          └─ tools 用户可以 DQBUF 拷贝帧


之后，主流用户态：
    │
    ├─ DQBUF 拿到 active_buf 对应的帧
    ├─ 处理完成
    └─ QBUF 把这个 buffer 还给驱动
          │
          ▼
       vb2 调用 rkcif_buf_queue(active_buf)
          │
          └─ use_cnt: 1 -> 0
              这次才真正把 active_buf 放回 stream->buf_head
              后续硬件 DMA 才能复用、
```
必须有两次 rkcif_buf_queue() 调用；一次由 tools 拷贝完成后驱动主动调用，另一次由主流用户态后续 QBUF 触发。两次都发生后，use_cnt 才会从 2 变成 0。文件里的代码也明确显示，use_cnt-- 是放在 rkcif_buf_queue() 的门控逻辑里，而不是放在 vb2_buffer_done() 里


---

**User**

memcpy拖慢buffer处理效率，会不会导致摄像头延迟变大？

---

**Cursor**

这个问题很关键，需要从代码里找到几个关键事实来支撑分析。让我查几个核心点：

现在有足够的代码证据来回答这个问题。

---

## `memcpy` 会不会导致摄像头延迟变大？

**结论先说：不会影响主流（MIPI_IDx）的采集延迟。** 但代价是真实存在的，只是被架构设计隔离掉了。下面逐点分析。

---

### 一、`memcpy` 与主流 buffer 归还是解耦的

从 `rkcif_buf_done_with_tools()` 的代码可以看到，IRQ 中只做了两件事：

```8573:8586:c:\Users\Admin\Desktop\rockchip\cif\capture.c
static void rkcif_buf_done_with_tools(struct rkcif_stream *stream,
				      struct rkcif_buffer *active_buf)
{
	unsigned long flags;

	spin_lock_irqsave(&stream->tools_vdev->vbq_lock, flags);
	if (stream->tools_vdev->state == RKCIF_STATE_STREAMING) {
		list_add_tail(&active_buf->queue, &stream->tools_vdev->buf_done_head);
		if (!work_busy(&stream->tools_vdev->work))
			schedule_work(&stream->tools_vdev->work);
	} else {
		rkcif_vb_done_tasklet(stream, active_buf);
	}
	spin_unlock_irqrestore(&stream->tools_vdev->vbq_lock, flags);
}
```

- `list_add_tail`：O(1)，纳秒级
- `schedule_work`：投递到 workqueue，**立刻返回，不等 memcpy 完成**

IRQ 路径本身不阻塞。主流 buffer 的归还（`vb2_buffer_done`）和硬件 DMA 地址更新都在 workqueue 里完成，与 IRQ 路径完全异步。

---

### 二、主流 buffer 归还在 memcpy 之前，不是之后

在 `rkcif_tools_buf_done()` 里，操作顺序是：

```648:665:c:\Users\Admin\Desktop\rockchip\cif\cif-tools.c
	rkcif_vb_done_oneframe(stream, &buf->vb);   // ← 第一步：主流 buffer 先归还

	if (!list_empty(&tools_vdev->buf_head)) {
		// ...
		for (i = 0; i < fmt->mplanes; i++) {
			// ...
			memcpy(dst, src, payload_size);      // ← 第二步：再做 memcpy
		}
		rkcif_buf_queue(&tools_buf->vb->vb2_buf); // ← 第三步：buffer 重投硬件
		vb2_buffer_done(&tools_vdev->curr_buf->vb.vb2_buf, VB2_BUF_STATE_DONE);
	}
```

**主流 `vb2_buffer_done` 先于 `memcpy` 执行**。这意味着：
- 编码器、ISP 等主流消费者在 `memcpy` 开始前就能拿到这帧数据
- `memcpy` 只影响 tools 通道自己的 buffer 交付时间，不影响主流帧延迟

---

### 三、硬件 DMA 在 memcpy 期间可以继续工作

`rkcif_buf_queue` 在 `memcpy` 之后调用，这里有一个潜在问题：**在 memcpy 期间，这块 buffer 没有重投给硬件，如果硬件需要它会发生什么？**

这正是 CIF 使用 **ping-pong 双 buffer 机制**的原因：

```c
// rkcif_stream 中
struct rkcif_buffer *curr_buf;   // 当前帧正在写入
struct rkcif_buffer *next_buf;   // 下一帧预先配置好
```

硬件始终有 `next_buf` 可用，不需要等待 `curr_buf` 归还。只要 `memcpy` 在下下帧到来之前完成（即在两个帧周期内），就不会造成 buffer 饥荒。

---

### 四、真实的代价：tools 通道自己的延迟 + DDR 带宽压力

**tools 通道本身的延迟增加：**

```
主流帧延迟:  IRQ → vb2_buffer_done  （微秒级，tasklet）
Tools帧延迟: IRQ → schedule_work → workqueue调度 → memcpy → vb2_buffer_done
             = 主流延迟 + workqueue调度等待 + memcpy耗时
```

对于 4K RAW12（约 12MB），在 RK3588 上 DDR 带宽约 50GB/s，`memcpy` 耗时约：
```
12MB / 50GB/s ≈ 0.24ms
```

对于普通分辨率（1080p RAW10，约 4MB）约 0.08ms。

**DDR 带宽压力：**

`memcpy` 本质是一次读 + 一次写，额外消耗 2 倍帧数据的 DDR 带宽。在 30fps 4K RAW12 场景下：
```
额外带宽 = 12MB × 2 × 30fps ≈ 720MB/s
```
相对 RK3588 的 DDR 总带宽（约 50GB/s）占比不到 2%，影响可忽略。

---

### 五、tools 通道不开启时完全没有代价

`rkcif_buf_done_prepare()` 中有明确的分支：

```8618:8626:c:\Users\Admin\Desktop\rockchip\cif\capture.c
		if (active_buf) {
			if (cif_dev->is_support_tools && stream->tools_vdev)
				rkcif_buf_done_with_tools(stream, active_buf);
			else
				rkcif_vb_done_tasklet(stream, active_buf);  // 直接走 tasklet
		}
```

只有 `is_support_tools == true` **且** `tools_vdev->state == RKCIF_STATE_STREAMING`（用户态打开了 tools 节点并 STREAMON）时才走 tools 路径。否则直接走普通 tasklet，零额外开销。

---

### 总结

| 影响对象 | 是否受 memcpy 影响 | 原因 |
|---|---|---|
| **主流（MIPI_IDx）帧延迟** | **不影响** | `vb2_buffer_done` 在 `memcpy` 之前执行 |
| **硬件 DMA 连续性** | **不影响** | ping-pong 机制，`next_buf` 始终就绪 |
| **Tools 通道帧延迟** | 增加约 0.1~0.3ms | workqueue 调度 + memcpy 耗时 |
| **DDR 带宽** | 增加约 1~2% | 仅在 tools STREAMON 时生效 |
| **tools 未开启时** | **零影响** | 直接走 tasklet 路径，不触发 memcpy |

设计者的取舍非常清晰：**用 tools 通道约 0.2ms 的额外延迟和 1~2% 的带宽开销，换取对主流业务零侵入的 RAW 帧旁路能力**，而且这个代价只在调试/标定时才会发生。

---

**User**

        ├─ rkcif_vb_done_oneframe(active_buf)
        │       └─► vb2_buffer_done() → 主流用户 dqbuf 返回  [use_cnt 第1份]
        │
        ├─ memcpy(src=active_buf DMA内存, dst=tools curr_buf)
        │       └─► cache finish → memcpy → set payload
        │
        ├─ rkcif_buf_queue(active_buf)
        │       └─► buffer 重新投入硬件 DMA 队列               [use_cnt 第2份]
        │
        └─ vb2_buffer_done(tools curr_buf)
                └─► tools 用户 dqbuf 返回，拿到拷贝后的完整帧

第一步以后一定要等到用户返回dqbuf才会进行

---

**Cursor**

你问到点子上了：**不需要等用户 `dqbuf` 返回，驱动就会继续执行下一步。**

### 结论
- `rkcif_vb_done_oneframe(active_buf)` 里的 `vb2_buffer_done()` 只是把 buffer 状态改为 DONE 并唤醒用户态可读。
- **不会阻塞等待用户态 `dqbuf`。**
- `rkcif_buf_queue(active_buf)` 是否立刻执行，取决于 `use_cnt` 逻辑，而不是用户何时 `dqbuf`。

---

### 代码证据：`rkcif_buf_queue` 用 `use_cnt` 做“二次使用门控”

在 `capture.c` 的 `rkcif_buf_queue()` 里：

```4500:4506:c:\Users\Admin\Desktop\rockchip\cif\capture.c
			if (is_find_tools_buf) {
				if (tools_buf->use_cnt)
					tools_buf->use_cnt--;
				if (tools_buf->use_cnt) {
					spin_unlock_irqrestore(&stream->tools_vdev->vbq_lock, flags);
					return;
				}
			}
```

含义是：
- 第一次调用 `rkcif_buf_queue`：`use_cnt` 从 2 变 1，直接 `return`（不重投 DMA）。
- 第二次调用 `rkcif_buf_queue`：`use_cnt` 从 1 变 0，才真正把 buffer 放回 `stream->buf_head` 给硬件用。

---

### 两次调用来自哪里？

在 `cif-tools.c`：
- 初始化：`tools_buf->use_cnt = 2`  
- 先 `rkcif_vb_done_oneframe()`（主流 DONE 通知）
- 然后在不同分支里会调用 `rkcif_buf_queue(...)`

你看到的两步本质是“同一个 buffer 要经过两次 `rkcif_buf_queue` 才会真回到 DMA 队列”，由 `use_cnt` 计数控制，不是由用户 `dqbuf` 控制。

---

### 所以和用户 `dqbuf` 的关系是？

- 用户 `dqbuf` 只是“应用拿到已完成帧”的动作。
- 驱动内部 buffer 生命周期（DONE、复制、重投 DMA）是内核自己推进的。
- 用户慢 `dqbuf` 会导致用户侧队列堆积，但**不会让内核在这一步卡住等用户**。

