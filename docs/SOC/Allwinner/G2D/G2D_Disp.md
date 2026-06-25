
---

**User**

全志的G2D和DISP有什么联系？

---

**Cursor**

我来查找 G2D 相关代码，分析它与 DISP 的关系。

现在我已经有足够的信息来全面分析 G2D 与 DISP 的关系了。

---

## 全志 G2D 与 DISP 的关系分析

### 一、两者定位与分工

| 模块 | 全称 | 定位 | 工作方式 |
|---|---|---|---|
| **DISP (DE)** | Display Engine | 显示输出引擎 | 实时（每帧）合成多路图层，驱动屏幕持续刷新 |
| **G2D** | 2D Graphics Engine | 2D 图形加速引擎 | 离线（按需）对图像做变换处理，结果写回内存 |

两者是**独立的硬件模块**，各有自己的寄存器基地址、时钟、复位控制和中断，互不直接控制对方。但在软件层面存在明确的**协作关系**。

---

### 二、两者的核心联系：Framebuffer 旋转场景

最直接的联系体现在 `fb_g2d_rot.c` 中——**DISP 使用 G2D 做 Framebuffer 硬件旋转**：

```
用户空间 Framebuffer（原始方向）
        │
        │ fb_g2d_rot_apply()
        ▼
   G2D 硬件旋转（g2d_bsp_blit_h）
        │ 旋转90°/180°/270°，结果写入 dst_phy_addr
        ▼
   旋转后的帧缓冲（内存）
        │
        │ 更新 disp_layer_config.info.fb.addr[0]
        ▼
   DISP 图层配置（disp_layer_config）
        │
        ▼
   DE 硬件合成 → 显示输出
```

具体流程：
1. `fb_g2d_rot_init()` 调用 `g2d_open()` 打开 G2D 设备，分配旋转目标缓冲区
2. `fb_g2d_rot_apply()` 每帧调用 `g2d_bsp_blit_h()` 让 G2D 做实际旋转，将结果写入 `dst_phy_addr`
3. 将 `dst_phy_addr` 填入 `disp_layer_config.info.fb.addr[0]`，DISP 直接读取旋转后的帧显示

---

### 三、共享的数据结构与接口

DISP 与 G2D 通过**像素格式转换函数**衔接，在 `fb_g2d_rot.c` 中：

```c
// DISP 的格式 → G2D 的格式
static inline g2d_fmt_enh disp_format_to_g2d_format(enum disp_pixel_format format)
{
    switch (format) {
    case DISP_FORMAT_ARGB_8888: return G2D_FORMAT_ARGB8888;
    case DISP_FORMAT_RGBA_8888: return G2D_FORMAT_RGBA8888;
    // ...
    }
}
```

`disp_layer_config` 结构体是两者的"交接点"——G2D 处理完后把结果地址、crop 信息写回该结构，DISP 再用它配置硬件图层。

---

### 四、G2D 内部结构与 DISP 的相似性

G2D（rcq 版本）内部也有与 DISP 相似的 Mixer 概念：

| G2D 模块 | DISP 对应概念 |
|---|---|
| `ovl_v`（视频 overlay）| VI Channel |
| `ovl_u`（UI overlay）| UI Channel |
| `bld`（blender）| Blender 混合器 |
| `scal`（scaler）| VSU/GSU 缩放单元 |
| `wb`（writeback）| RTWB（实时回写）|

但 G2D 的 Mixer 输出是**写回内存**，而 DISP 的输出是**送往 TCON 驱动屏幕**。

---

### 五、时钟/复位上的依赖关系

从 `g2d_driver_i.h` 中 `__g2d_info_t` 结构可见，G2D 有独立的时钟树：

```c
struct clk *vo_clk;          // vo 时钟（与 DISP 共享 VO 总线）
struct clk *mbus_vo_clk;     // MBUS VO 时钟
struct reset_control *vo_reset;      // VO 复位
struct reset_control *desys_reset;   // DE 系统复位
```

`vo_reset` 和 `desys_reset` 表明 G2D 与 DE（Display Engine）**共享同一套 VO（Video Output）总线和复位域**，这是硬件层面上两者同属"视频子系统"的体现。

---

### 六、总结关系图

```
┌─────────────────────────────────────────────────┐
│              视频子系统（VO Domain）              │
│                                                 │
│  ┌──────────────┐         ┌──────────────────┐  │
│  │   G2D 引擎    │         │   DISP/DE 引擎   │  │
│  │  （离线处理）  │         │   （实时显示）    │  │
│  │              │         │                  │  │
│  │ ┌──────────┐ │         │  Channel 0 (VI)  │  │
│  │ │ Mixer    │ │         │  Channel 1 (UI)  │  │
│  │ │ ovl_v    │ │         │  Channel 2 (UI)  │  │
│  │ │ ovl_u    │ │  共享    │  Channel 3 (UI)  │  │
│  │ │ blender  │ │  MBUS   │       │           │  │
│  │ │ scaler   │ │  ←────→ │   Blender        │  │
│  │ │ wb       │ │         │       │           │  │
│  │ └────┬─────┘ │         │    TCON           │  │
│  └──────┼───────┘         └──────────────────┘  │
│         │ 写回内存                  ▲             │
│         └──────── fb_addr ─────────┘             │
│              (fb_g2d_rot.c 桥接)                 │
└─────────────────────────────────────────────────┘
```

**核心结论：**
- G2D 和 DISP 是**独立硬件模块**，共属同一 VO 子系统，共享 MBUS 总线和部分复位域
- 软件上的联系主要是：**G2D 作为 DISP Framebuffer 的预处理引擎**，完成旋转/缩放等离线变换后，将结果帧缓冲交给 DISP 显示
- 接口桥接层是 `fb_g2d_rot.c`，通过 `disp_layer_config` 结构传递像素地址和裁剪信息

```plaintext
用户空间 Framebuffer（原始方向）
        │
        │ fb_g2d_rot_apply()
        ▼
   G2D 硬件旋转（g2d_bsp_blit_h）
        │ 旋转90°/180°/270°，结果写入 dst_phy_addr
        ▼
   旋转后的帧缓冲（内存）
        │
        │ 更新 disp_layer_config.info.fb.addr[0]
        ▼
   DISP 图层配置（disp_layer_config）
        │
        ▼
   DE 硬件合成 → 显示输出
```

```c
// DISP 的格式 → G2D 的格式
static inline g2d_fmt_enh disp_format_to_g2d_format(enum disp_pixel_format format)
{
    switch (format) {
    case DISP_FORMAT_ARGB_8888: return G2D_FORMAT_ARGB8888;
    case DISP_FORMAT_RGBA_8888: return G2D_FORMAT_RGBA8888;
    // ...
    }
}
```

```c
struct clk *vo_clk;          // vo 时钟（与 DISP 共享 VO 总线）
struct clk *mbus_vo_clk;     // MBUS VO 时钟
struct reset_control *vo_reset;      // VO 复位
struct reset_control *desys_reset;   // DE 系统复位
```

```plaintext
┌─────────────────────────────────────────────────┐
│              视频子系统（VO Domain）              │
│                                                 │
│  ┌──────────────┐         ┌──────────────────┐  │
│  │   G2D 引擎    │         │   DISP/DE 引擎   │  │
│  │  （离线处理）  │         │   （实时显示）    │  │
│  │              │         │                  │  │
│  │ ┌──────────┐ │         │  Channel 0 (VI)  │  │
│  │ │ Mixer    │ │         │  Channel 1 (UI)  │  │
│  │ │ ovl_v    │ │         │  Channel 2 (UI)  │  │
│  │ │ ovl_u    │ │  共享    │  Channel 3 (UI)  │  │
│  │ │ blender  │ │  MBUS   │       │           │  │
│  │ │ scaler   │ │  ←────→ │   Blender        │  │
│  │ │ wb       │ │         │       │           │  │
│  │ └────┬─────┘ │         │    TCON           │  │
│  └──────┼───────┘         └──────────────────┘  │
│         │ 写回内存                  ▲             │
│         └──────── fb_addr ─────────┘             │
│              (fb_g2d_rot.c 桥接)                 │
└─────────────────────────────────────────────────┘
```

---

**User**

上层使用G2D IOCTL变换图像，是否需要跟DISP进行交互？还是G2D直接写内存，不用通知DISP？你可以参考一下这些文档docs/Software 软件类文档/SDK模块开发指南/G2D/Linux_G2D_开发指南.pdf

---

**Cursor**

PDF 是二进制文件无法直接读取。我通过代码来分析这个问题，结合已有的源码进行深入分析。

已经获取到足够的关键信息。现在可以给出完整、准确的分析。

---

## 上层通过 G2D IOCTL 变换图像，是否需要与 DISP 交互？

### 结论：**完全不需要与 DISP 交互，G2D 直接写内存，DISP 无感知。**

---

### 一、G2D IOCTL 的完整工作流

从 `g2d.c` 的 `g2d_ioctl()` 可以清楚看到，G2D 的工作是一个**完全自治的离线处理流程**：

```
用户空间 open("/dev/g2d")
    │
    ▼
g2d_open()  ← 使能时钟、复位，硬件上电
    │
    ▼
ioctl(fd, G2D_CMD_BITBLT_H / G2D_CMD_MIXER_TASK / G2D_CMD_BLD_H ...)
    │  传入: src_buf (dma_buf fd 或物理地址) + dst_buf + 变换参数
    │
    ▼
g2d_ioctl() 内核处理:
    ├── copy_from_user()  从用户空间拷贝参数
    ├── dma_buf_get() / dma_buf_attach() → 获取 src/dst 物理地址
    ├── 配置 G2D 硬件寄存器（旋转/缩放/混合参数）
    ├── 启动硬件：g2d_mixer_start() / g2d_rotate
    ├── wait_event_timeout() 等待 G2D 中断完成
    └── dma_buf_unmap() 释放 DMA 映射
    │
    ▼
g2d_release()  ← 关闭时钟（引用计数为0时）
    │
    ▼
结果已写入 dst_buf（内存），ioctl 返回
```

**全程没有任何对 DISP 驱动的调用，也没有通知机制。**

---

### 二、DISP 完全不知道 G2D 在做什么

G2D 处理的是**纯内存到内存（mem2mem）的操作**：
- 输入：`src_image_h`（源 buffer 的物理地址/dma_buf fd）
- 输出：`dst_image_h`（目标 buffer 的物理地址/dma_buf fd）
- 操作：旋转、缩放、混合、格式转换等
- 结果：**写回到 dst buffer 的内存**，G2D 驱动不通知任何其他模块

DISP 在其自己的 vsync 定时器驱动下，每帧从配置的 layer `fb.addr` 读取数据显示。它感知不到也不关心这块内存是谁写的——可以是 CPU、GPU、G2D、VE 解码器，都无所谓。

---

### 三、唯一需要"交互"的场景：用户空间主动衔接

唯一需要"协作"的场景是：用户空间程序**用 G2D 处理完图像后，主动把结果 buffer 的地址告诉 DISP**，两步完全独立：

```
步骤1: 用户空间 → G2D IOCTL → G2D 硬件处理 → 结果写入 dst_buf
                                                    │
步骤2: 用户空间 → DISP IOCTL (disp_layer_config)  ←┘
       设置 layer.fb.addr = dst_buf 的物理地址
       → DISP 下一帧 vsync 时读取并显示
```

这两步之间**没有任何内核级别的同步或通知机制**，完全由用户空间程序自己保证顺序（先等 G2D ioctl 返回，再调用 DISP ioctl 更新 layer）。

---

### 四、内核内部唯一的例外：`fb_g2d_rot.c`

如前面分析，这是 DISP 驱动**主动调用** G2D 的场景（Framebuffer 旋转），但这属于内核内部的驱动间调用，不经过 ioctl，上层应用无需感知：

```c
// fb_g2d_rot.c 内核内部调用
g2d_bsp_blit_h(&g2d_para);  // 直接调用 G2D 内核函数，不走 ioctl
```

这是 DISP 的 `fb` 子驱动**绕过 ioctl 直接调用 G2D 内核符号**（`EXPORT_SYMBOL_GPL`），属于驱动内部实现细节。

---

### 五、总结

| 场景 | G2D 与 DISP 的关系 |
|---|---|
| 用户空间调用 G2D ioctl 做图像变换 | **完全独立，不通知 DISP** |
| G2D 处理结果显示到屏幕 | **用户空间自行调用 DISP ioctl 更新 layer 地址** |
| 内核内 fb 旋转（fb_g2d_rot.c）| DISP 驱动内部直接调用 `g2d_bsp_blit_h()`，无 ioctl |
| DISP 工作时是否需要 G2D | **不需要**，DISP 独立运行，直接从内存读帧数据 |

```plaintext
用户空间 open("/dev/g2d")
    │
    ▼
g2d_open()  ← 使能时钟、复位，硬件上电
    │
    ▼
ioctl(fd, G2D_CMD_BITBLT_H / G2D_CMD_MIXER_TASK / G2D_CMD_BLD_H ...)
    │  传入: src_buf (dma_buf fd 或物理地址) + dst_buf + 变换参数
    │
    ▼
g2d_ioctl() 内核处理:
    ├── copy_from_user()  从用户空间拷贝参数
    ├── dma_buf_get() / dma_buf_attach() → 获取 src/dst 物理地址
    ├── 配置 G2D 硬件寄存器（旋转/缩放/混合参数）
    ├── 启动硬件：g2d_mixer_start() / g2d_rotate
    ├── wait_event_timeout() 等待 G2D 中断完成
    └── dma_buf_unmap() 释放 DMA 映射
    │
    ▼
g2d_release()  ← 关闭时钟（引用计数为0时）
    │
    ▼
结果已写入 dst_buf（内存），ioctl 返回
```

```plaintext
步骤1: 用户空间 → G2D IOCTL → G2D 硬件处理 → 结果写入 dst_buf
                                                    │
步骤2: 用户空间 → DISP IOCTL (disp_layer_config)  ←┘
       设置 layer.fb.addr = dst_buf 的物理地址
       → DISP 下一帧 vsync 时读取并显示
```

```c
// fb_g2d_rot.c 内核内部调用
g2d_bsp_blit_h(&g2d_para);  // 直接调用 G2D 内核函数，不走 ioctl
```

---

**User**

它们是如何防止G2D写内存时DISP使用layer导致错误？

---

**Cursor**

这是个很好的问题，涉及到显示同步机制。让我深入查看相关代码。

现在已经有完整的信息，可以做出精确的分析。

---

## G2D 写内存时 DISP 如何防止 layer 读写冲突？

### 核心答案：依赖 **Android HWC Acquire Fence 机制**，内核提供 `dma_fence`，但**不强制等待**。

全志在这里用的是**业界标准的 Android 合成同步方案**，分两侧分别管理。

---

### 一、DISP 侧：Release Fence（`dev_composer.c`）

DISP 驱动实现了一套 **Release Fence** 机制，告诉上层"这帧我已经显示完，buffer 可以回收/重写了"：

```
上层 HWC(SurfaceFlinger/HWComposer)
    │
    ├─ ioctl(DISP_HWC_COMMIT, HWC_ACQUIRE_FENCE)
    │       └─ hwc_aquire_fence()
    │              创建一个 dma_fence（hwc_fence），seqno = ++timeline_count
    │              打包成 sync_file，返回 fd 给上层
    │
    ├─ ioctl(DISP_HWC_COMMIT, HWC_SUBMIT_FENCE, count)
    │       └─ hwc_submit() → 记录 submmit_count
    │
    ▼
  DISP vsync 中断触发
    └─ disp_composer_proc(sel)     ← 注册为 sync_finish_proc
           current_count = submmit_count
           遍历 fence_list，对 seqno ≤ current_count 的 fence 全部 signal
           → fence_signal_locked(&fence->base)
           → 上层 dma_fence_wait() 解除阻塞
```

**这个 fence 表达的语义是：DISP 已经把这帧送到屏幕，你（G2D/CPU）可以重新写这块 buffer 了。**

---

### 二、G2D 侧：Acquire Fence（`syncfence.c`）

G2D 驱动提供了 `/dev/syncfence` 设备，实现独立的 **Acquire Fence** 机制，用于告知 DISP "G2D 还没写完，你别读这块 buffer"：

```
上层 G2D 使用者
    │
    ├─ open("/dev/syncfence")
    │       └─ 创建一条 fence_timeline
    │
    ├─ ioctl(SYNCFENCE_IOC_CREATE_FENCE, value)
    │       └─ syncfence_create() → 创建 dma_fence，seqno = value
    │          返回 fence_fd 给上层
    │
    │   [启动 G2D ioctl 处理，G2D 硬件开始写 dst_buf]
    │
    ├─ [G2D ioctl 返回，写入完成]
    │
    ├─ ioctl(SYNCFENCE_IOC_INC, 1)
    │       └─ fence_timeline_signal() → signal 所有满足条件的 fence
    │          → 告知等待者：G2D 写完了
    │
    ▼
  DISP/HWC 等待这个 fence_fd signal 后，才将该 buffer 配置到 layer 显示
```

---

### 三、完整的双向保护流程

```
                   ┌─────────────────────────────────┐
                   │    用户空间 HWC / SurfaceFlinger  │
                   └───┬──────────────────────┬───────┘
                       │                      │
          ① acquire_fence_fd            ③ release_fence_fd
          (G2D写完通知)                  (DISP显示完通知)
                       │                      │
     ┌─────────────────▼──┐          ┌────────▼──────────┐
     │   G2D 驱动          │          │   DISP 驱动        │
     │  /dev/syncfence     │          │  dev_composer.c   │
     │                    │          │                   │
     │ G2D写dst_buf→完成  │          │ vsync后signal     │
     │ → signal fence     │          │ release_fence     │
     └────────────────────┘          └───────────────────┘
              │                                │
              ▼                                ▼
       DISP 等待该 fence                 G2D/CPU 等待该 fence
       signal 后才读取 buffer            signal 后才重写 buffer
```

---

### 四、关键结论

| 问题 | 答案 |
|---|---|
| 内核驱动层有强制等待吗？| **没有**，G2D ioctl 本身是同步的（wait_event_timeout 等G2D中断），返回即写完 |
| 如何防止 DISP 在 G2D 写时读 buffer？| 上层 HWC **持有 acquire_fence_fd，等 G2D signal 后才提交 layer 给 DISP** |
| 如何防止 G2D 在 DISP 读时写 buffer？| DISP 每帧 vsync 后 signal **release_fence**，上层 HWC 等该 fence 后才让 G2D 重新写 |
| 这套机制是内核保证的吗？| **不是**，内核只提供 fence 基础设施，**正确性依赖上层 HWC/应用遵守 fence 等待协议** |
| 如果上层不用 fence，直接写内存？| **内核不阻止**，可能出现撕裂/花屏，这是上层的责任 |

这就是 Android 图形系统标准的 **BufferQueue + Fence 双缓冲/三缓冲同步机制**，全志 DISP 和 G2D 都是这套机制的参与者，但**同步的正确性由用户空间（HWC）通过 fence 协议来保障**，内核驱动本身不做强制互斥。

```plaintext
上层 HWC(SurfaceFlinger/HWComposer)
    │
    ├─ ioctl(DISP_HWC_COMMIT, HWC_ACQUIRE_FENCE)
    │       └─ hwc_aquire_fence()
    │              创建一个 dma_fence（hwc_fence），seqno = ++timeline_count
    │              打包成 sync_file，返回 fd 给上层
    │
    ├─ ioctl(DISP_HWC_COMMIT, HWC_SUBMIT_FENCE, count)
    │       └─ hwc_submit() → 记录 submmit_count
    │
    ▼
  DISP vsync 中断触发
    └─ disp_composer_proc(sel)     ← 注册为 sync_finish_proc
           current_count = submmit_count
           遍历 fence_list，对 seqno ≤ current_count 的 fence 全部 signal
           → fence_signal_locked(&fence->base)
           → 上层 dma_fence_wait() 解除阻塞
```

```plaintext
上层 G2D 使用者
    │
    ├─ open("/dev/syncfence")
    │       └─ 创建一条 fence_timeline
    │
    ├─ ioctl(SYNCFENCE_IOC_CREATE_FENCE, value)
    │       └─ syncfence_create() → 创建 dma_fence，seqno = value
    │          返回 fence_fd 给上层
    │
    │   [启动 G2D ioctl 处理，G2D 硬件开始写 dst_buf]
    │
    ├─ [G2D ioctl 返回，写入完成]
    │
    ├─ ioctl(SYNCFENCE_IOC_INC, 1)
    │       └─ fence_timeline_signal() → signal 所有满足条件的 fence
    │          → 告知等待者：G2D 写完了
    │
    ▼
  DISP/HWC 等待这个 fence_fd signal 后，才将该 buffer 配置到 layer 显示
```

```plaintext
                   ┌─────────────────────────────────┐
                   │    用户空间 HWC / SurfaceFlinger  │
                   └───┬──────────────────────┬───────┘
                       │                      │
          ① acquire_fence_fd            ③ release_fence_fd
          (G2D写完通知)                  (DISP显示完通知)
                       │                      │
     ┌─────────────────▼──┐          ┌────────▼──────────┐
     │   G2D 驱动          │          │   DISP 驱动        │
     │  /dev/syncfence     │          │  dev_composer.c   │
     │                    │          │                   │
     │ G2D写dst_buf→完成  │          │ vsync后signal     │
     │ → signal fence     │          │ release_fence     │
     └────────────────────┘          └───────────────────┘
              │                                │
              ▼                                ▼
       DISP 等待该 fence                 G2D/CPU 等待该 fence
       signal 后才读取 buffer            signal 后才重写 buffer
```

