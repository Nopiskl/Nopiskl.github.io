# Function purpose explanation
_Exported on 2026/3/17 at GMT+8 17:06:20 from Cursor (2.3.34)_

---

**User**

@sample_virvi.c (753-778) 解释一下这个函数干什么的

---

**Cursor**

Wait, let me read the specific lines first and then provide context.

```1:1:home/ubuntu/v851s/tina-v853-100ask/external/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi/sample_virvi.c```

Let me read the file properly:


Based on the file read, here is the explanation. Let me get the actual content first.

这个函数 `initCaps` 的作用是**初始化所有视频采集通道（Capture）的状态**。

以下是逐步解析：

```753:778:external/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi/sample_virvi.c
static void initCaps(SampleVirViContext *pContext)
{
    SampleVirviCap *pCap = NULL;
    SampleVirViConfig *pConfig = NULL;

    for (int i = 0; i < MAX_CAPTURE_NUM; i++)
    {
        pCap = &pContext->mCaps[i];
        pConfig = &pCap->mConfig;

        pCap->Dev = MM_INVALID_DEV;
        pCap->mIspDev = MM_INVALID_DEV;
        pCap->Chn = MM_INVALID_CHN;

        if ((pConfig->DevNum < 0) || \
            (0 == pConfig->PicWidth) || (0 == pConfig->PicHeight))
        {
            pCap->mbCapValid = FALSE;
        }
        else
        {
            pCap->mbCapValid = TRUE;
            pCap->mpContext = (void *)pContext;
        }
    }
}
```

**逐段说明：**

1. **循环遍历所有采集通道**：从 `0` 到 `MAX_CAPTURE_NUM - 1`，对每一个 `SampleVirviCap` 结构体进行初始化。

2. **将设备/通道号标记为无效**：
   - `pCap->Dev = MM_INVALID_DEV` — VI 设备号设为无效值
   - `pCap->mIspDev = MM_INVALID_DEV` — ISP 设备号设为无效值
   - `pCap->Chn = MM_INVALID_CHN` — 通道号设为无效值

   这是一种防御性初始化，避免后续使用时出现脏数据。

3. **根据配置判断该采集通道是否有效**（`mbCapValid`）：
   - 若 `DevNum < 0`（设备号未配置）**或** 图像宽/高为 0（分辨率未配置），则将该通道标记为**无效**（`FALSE`），后续流程会跳过它。
   - 否则标记为**有效**（`TRUE`），并将全局上下文指针 `pContext` 存入 `pCap->mpContext`，供后续采集线程等回调使用。

**总结**：`initCaps` 是一个初始化函数，在采集启动前对每个采集通道做"复位 + 有效性判断"，只有配置正确（有合法的设备号和非零分辨率）的通道才会被标记为有效，参与后续的视频采集流程。

```c
static void initCaps(SampleVirViContext *pContext)
{
    SampleVirviCap *pCap = NULL;
    SampleVirViConfig *pConfig = NULL;

    for (int i = 0; i < MAX_CAPTURE_NUM; i++)
    {
        pCap = &pContext->mCaps[i];
        pConfig = &pCap->mConfig;

        pCap->Dev = MM_INVALID_DEV;
        pCap->mIspDev = MM_INVALID_DEV;
        pCap->Chn = MM_INVALID_CHN;

        if ((pConfig->DevNum < 0) || \
            (0 == pConfig->PicWidth) || (0 == pConfig->PicHeight))
        {
            pCap->mbCapValid = FALSE;
        }
        else
        {
            pCap->mbCapValid = TRUE;
            pCap->mpContext = (void *)pContext;
        }
    }
}
```

---

**User**

分析一下static int copyVideoFrame(VIDEO_FRAME_INFO_S *pSrc, SampleVirviSaveBufNode *pNode)

---

**Cursor**

先搜索这个函数的位置。

已获取到完整函数内容，下面进行详细分析：

```448:522:external/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi/sample_virvi.c
static int copyVideoFrame(VIDEO_FRAME_INFO_S *pSrc, SampleVirviSaveBufNode *pNode)
{
    unsigned int nFrmsize[3] = {0,0,0};
    void *pTmp = pNode->mpDataVirAddr;
    unsigned int dataWidth  = pSrc->VFrame.mOffsetRight - pSrc->VFrame.mOffsetLeft;
    unsigned int dataHeight = pSrc->VFrame.mOffsetBottom - pSrc->VFrame.mOffsetTop;
    // ... 像素格式 switch-case ...
    // ... 缓冲区大小校验 ...
    // ... memcpy 拷贝各平面数据 ...
}
```

---

**函数总体功能**

将一帧视频数据（`VIDEO_FRAME_INFO_S *pSrc`）从 MPP 框架管理的内存，拷贝到一个用于保存/处理的缓冲节点（`SampleVirviSaveBufNode *pNode`）中，同时记录帧的格式和大小信息。

---

**逐段分析**

**① 计算有效图像尺寸**
```c
unsigned int dataWidth  = pSrc->VFrame.mOffsetRight - pSrc->VFrame.mOffsetLeft;
unsigned int dataHeight = pSrc->VFrame.mOffsetBottom - pSrc->VFrame.mOffsetTop;
```
通过裁剪偏移量计算出实际有效图像区域的宽高（而非缓冲区的对齐宽高）。

---

**② 根据像素格式计算各平面大小（`nFrmsize[3]`）**

| 格式 | plane0 | plane1 | plane2 |
|---|---|---|---|
| NV12/NV21/NV21M（半平面 4:2:0） | W×H | W×H/2（UV 交织） | 0 |
| YV12/YU12（平面 4:2:0） | W×H | W×H/4 | W×H/4 |
| NV16/NV61（半平面 4:2:2） | W×H | W×H（UV 交织） | 0 |
| LBC 压缩格式 / RAW10 / RAW12 | 直接用 `mStride[i]`（驱动已算好） | 同左 | 同左 |
| RAW8 | W×H | 0 | 0 |

对于压缩/RAW 格式，直接使用驱动层填写好的 `mStride[]` 字段，不再手动计算。

---

**③ 缓冲区容量校验**
```c
if (pNode->mDataLen < (nFrmsize[0]+nFrmsize[1]+nFrmsize[2]))
    return -1;  // 目标缓冲区太小，报错返回
```
防止越界写入。

---

**④ 记录帧元信息**
```c
pNode->mFrmSize.Width  = dataHeight;  // 注意：此处 Width/Height 赋值是反的，疑似 bug
pNode->mFrmSize.Height = dataWidth;
pNode->mFrmFmt = pSrc->VFrame.mPixelFormat;
```
> **注意**：这里 `Width` 被赋值为 `dataHeight`，`Height` 被赋值为 `dataWidth`，**宽高赋反了**，是一个潜在 bug。

---

**⑤ 逐平面 memcpy 拷贝**
```c
for (int i = 0; i < 3; i++)
{
    if (pSrc->VFrame.mpVirAddr[i])
    {
        memcpy(pTmp, pSrc->VFrame.mpVirAddr[i], nFrmsize[i]);
        pTmp += nFrmsize[i];
        pNode->mFrmLen += nFrmsize[i];
    }
}
```
只要某个平面的虚拟地址非空，就将该平面数据拷贝到目标缓冲区，并累加已拷贝的总长度到 `mFrmLen`。`pTmp` 作为写入指针随之后移。

---

**总结**

`copyVideoFrame` 本质是一个**多平面 YUV/RAW 帧的内存拷贝工具函数**，核心流程为：计算各平面大小 → 校验目标缓冲区 → 记录元信息 → 逐平面 `memcpy`。值得注意的是第④步存在**宽高字段赋值颠倒**的问题，若后续代码依赖 `mFrmSize` 字段，可能导致图像处理或保存时宽高信息错误。

```c
static int copyVideoFrame(VIDEO_FRAME_INFO_S *pSrc, SampleVirviSaveBufNode *pNode)
{
    unsigned int nFrmsize[3] = {0,0,0};
    void *pTmp = pNode->mpDataVirAddr;
    unsigned int dataWidth  = pSrc->VFrame.mOffsetRight - pSrc->VFrame.mOffsetLeft;
    unsigned int dataHeight = pSrc->VFrame.mOffsetBottom - pSrc->VFrame.mOffsetTop;
    // ... 像素格式 switch-case ...
    // ... 缓冲区大小校验 ...
    // ... memcpy 拷贝各平面数据 ...
}
```

```c
unsigned int dataWidth  = pSrc->VFrame.mOffsetRight - pSrc->VFrame.mOffsetLeft;
unsigned int dataHeight = pSrc->VFrame.mOffsetBottom - pSrc->VFrame.mOffsetTop;
```

```c
if (pNode->mDataLen < (nFrmsize[0]+nFrmsize[1]+nFrmsize[2]))
    return -1;  // 目标缓冲区太小，报错返回
```

```c
pNode->mFrmSize.Width  = dataHeight;  // 注意：此处 Width/Height 赋值是反的，疑似 bug
pNode->mFrmSize.Height = dataWidth;
pNode->mFrmFmt = pSrc->VFrame.mPixelFormat;
```

```c
for (int i = 0; i < 3; i++)
{
    if (pSrc->VFrame.mpVirAddr[i])
    {
        memcpy(pTmp, pSrc->VFrame.mpVirAddr[i], nFrmsize[i]);
        pTmp += nFrmsize[i];
        pNode->mFrmLen += nFrmsize[i];
    }
}
```

---

**User**

static void *GetCSIFrameThread(void *pThreadData)中的if ((ret = AW_MPI_VI_GetFrame(pCap->Dev, pCap->Chn, &pCap->pstFrameInfo, pCap->s32MilliSec)) != 0)，&pCap->pstFrameInfo的结构体什么时候被malloc的？ VIDEO_FRAME_INFO_S是什么？

---

**Cursor**

我来同时查找相关信息。

我来读取函数内容和 VIDEO_FRAME_INFO_S 的定义。

找到了 `VIDEO_FRAME_INFO_S.h`，同时继续读取 `GetCSIFrameThread` 后续内容。

再查一下 `VIDEO_FRAME_INFO_S` 结构体的具体定义。

现在已经有了所有需要的信息，可以完整回答这个问题了。

---

## `&pCap->pstFrameInfo` 什么时候被 malloc？

**答：它从来没有被 malloc，因为它根本不是指针，而是一个内嵌在结构体中的值类型成员。**

看 `SampleVirviCap` 的定义：

```39:40:external/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi/sample_virvi.h
    VIDEO_FRAME_INFO_S pstFrameInfo;
```

注意：`pstFrameInfo` 是 `VIDEO_FRAME_INFO_S` 类型的**值**，不是指针（没有 `*`）。它直接嵌套在 `SampleVirviCap` 结构体内部，而 `SampleVirviCap mCaps[MAX_CAPTURE_NUM]` 又直接嵌套在 `SampleVirViContext` 中：

```87:88:external/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi/sample_virvi.h
    SampleVirviCap mCaps[MAX_CAPTURE_NUM];
```

所以整条内存链路是：

```
SampleVirViContext（栈/堆上分配）
  └─ mCaps[4]（SampleVirviCap 数组，随 Context 一起分配）
       └─ pstFrameInfo（VIDEO_FRAME_INFO_S，随 SampleVirviCap 一起分配）
```

`&pCap->pstFrameInfo` 只是取这个值成员的地址，传给 `AW_MPI_VI_GetFrame`，让驱动把帧信息**填写到这块已存在的内存**里，不需要也不应该单独 malloc。

---

## `VIDEO_FRAME_INFO_S` 是什么？

它定义在 `mm_comm_video.h` 中，是一个**视频帧描述结构体**，包含两个字段：

```c
typedef struct VIDEO_FRAME_INFO_S
{
    VIDEO_FRAME_S VFrame;   // 帧的核心数据
    unsigned int  mId;      // 帧的唯一 ID
} VIDEO_FRAME_INFO_S;
```

其中核心是 `VIDEO_FRAME_S VFrame`，它包含了完整的帧描述信息：

| 字段 | 含义 |
|---|---|
| `mWidth` / `mHeight` | 图像宽高（像素） |
| `mPixelFormat` | 像素格式（NV12/NV21/YV12/RAW 等） |
| `mPhyAddr[3]` | Y/U/V 各平面的**物理地址**（DMA 用） |
| `mpVirAddr[3]` | Y/U/V 各平面的**虚拟地址**（CPU 访问用） |
| `mStride[3]` | 各平面每行的字节数（考虑内存对齐） |
| `mOffsetTop/Bottom/Left/Right` | 有效图像区域的裁剪偏移 |
| `mpts` | 时间戳（单位：微秒） |
| `mVideoFormat` | 线性/Tile 等内存排布格式 |
| `mCompressMode` | 是否启用压缩（AFBC 等） |

---

## 整体流程总结

```
AW_MPI_VI_GetFrame(Dev, Chn, &pCap->pstFrameInfo, timeout)
         │
         │  驱动将帧的物理地址、虚拟地址、时间戳等填入 pstFrameInfo
         ▼
copyVideoFrame(&pCap->pstFrameInfo, pEntry)
         │
         │  通过 mpVirAddr[] 读取各平面数据，memcpy 到 SaveBufNode
         ▼
AW_MPI_VI_ReleaseFrame(Dev, Chn, &pCap->pstFrameInfo)
         │
         │  将帧归还给驱动，驱动可重新使用该 buffer
```

`pstFrameInfo` 相当于一个"帧描述符"，`GetFrame` 填入，`ReleaseFrame` 归还，中间用 `mpVirAddr` 访问实际图像数据。

```plaintext
    VIDEO_FRAME_INFO_S pstFrameInfo;
```

```plaintext
    SampleVirviCap mCaps[MAX_CAPTURE_NUM];
```

```plaintext
SampleVirViContext（栈/堆上分配）
  └─ mCaps[4]（SampleVirviCap 数组，随 Context 一起分配）
       └─ pstFrameInfo（VIDEO_FRAME_INFO_S，随 SampleVirviCap 一起分配）
```

```c
typedef struct VIDEO_FRAME_INFO_S
{
    VIDEO_FRAME_S VFrame;   // 帧的核心数据
    unsigned int  mId;      // 帧的唯一 ID
} VIDEO_FRAME_INFO_S;
```

```plaintext
AW_MPI_VI_GetFrame(Dev, Chn, &pCap->pstFrameInfo, timeout)
         │
         │  驱动将帧的物理地址、虚拟地址、时间戳等填入 pstFrameInfo
         ▼
copyVideoFrame(&pCap->pstFrameInfo, pEntry)
         │
         │  通过 mpVirAddr[] 读取各平面数据，memcpy 到 SaveBufNode
         ▼
AW_MPI_VI_ReleaseFrame(Dev, Chn, &pCap->pstFrameInfo)
         │
         │  将帧归还给驱动，驱动可重新使用该 buffer
```

---

**User**

VIDEO_FRAME_S VFrame里面已存在的地址是什么时候被分配的

---

**Cursor**

好问题。`mpVirAddr[]` 和 `mPhyAddr[]` 里的地址并不是应用层分配的，而是**驱动层在 `AW_MPI_VI_GetFrame` 内部填入的**。我来找一下 `AW_MPI_VI_GetFrame` 的实现来确认这一点。

继续追踪 `COMP_IndexVendorViGetFrame` 的实现。

只有二进制文件匹配，说明源码在别处。继续找 VI 组件的 GetConfig 实现。

找到了，查看 `VideoVirVi_Component.c` 中的具体实现。

继续追踪 `DoVideoViGetData` 的实现。

关键代码已找到。再追踪一下 `VideoBufMgrGetValidFrame` 和 buffer 是在哪里被分配和填充的。

找到关键位置了，读取 `videoInputHw.c` 中这段代码的上下文。

现在已经有了完整的调用链，可以给出完整答案了。

---

## `VIDEO_FRAME_S` 中的地址是什么时候分配的？

**答：这些地址指向的内存是在 VI 设备初始化时，由内核驱动通过 V4L2 的 `VIDIOC_REQBUFS` + `mmap` 机制分配和映射的，应用层从不 malloc 这块内存。**

---

## 完整调用链

```
AW_MPI_VI_SetAttr()  ←── 配置 VI 属性（分辨率、格式、nbufs=3 等）
        │
        ▼
AW_MPI_VI_EnableVirChn()
        │
        ▼
videoInputHw（内核驱动层）
  ├── VIDIOC_REQBUFS  ──→  内核分配 DMA 物理内存（CMA/ION）
  ├── VIDIOC_QUERYBUF ──→  查询每块 buffer 的偏移
  └── mmap()          ──→  将物理内存映射到用户态虚拟地址
                            得到 buffer.planes[i].mem      (虚拟地址)
                            得到 buffer.planes[i].mem_phy  (物理地址)
```

之后每次 `AW_MPI_VI_GetFrame` 时，底层调用 `video_dequeue_buffer`（即 `VIDIOC_DQBUF`），从驱动队列中取出一帧已填好图像数据的 buffer，然后在 `videoInputHw_GetData` 里把地址填入 `VIDEO_FRAME_S`：

```5844:5887:external/eyesee-mpp/middleware/sun8iw21/media/videoIn/videoInputHw.c
    if (video_dequeue_buffer(video, &buffer) < 0)
    {
        return ERR_VI_BUF_EMPTY;
    }
    // ...
    for (i = 0; i < vfmt.nplanes; i++)
    {
        pstFrameInfo->VFrame.mpVirAddr[i] = buffer.planes[i].mem;      // 虚拟地址（mmap 得到）
        pstFrameInfo->VFrame.mPhyAddr[i]  = buffer.planes[i].mem_phy;  // 物理地址（DMA 地址）
        pstFrameInfo->VFrame.mStride[i]   = width_stride;
    }
    // 对单 buffer 格式（NV21/NV12/YUV420等），手动计算 UV 平面偏移
    pstFrameInfo->VFrame.mpVirAddr[1] = buffer.planes[0].mem + ySize;
    pstFrameInfo->VFrame.mPhyAddr[1]  = buffer.planes[0].mem_phy + ySize;
```

---

## 内存生命周期总结

| 阶段 | 操作 | 说明 |
|---|---|---|
| **初始化** | `VIDIOC_REQBUFS` | 内核分配 N 块 DMA buffer（物理连续内存） |
| **映射** | `mmap()` | 将物理内存映射到用户态，得到虚拟地址 |
| **采集中** | `VIDIOC_QBUF` | 把空 buffer 入队，等待驱动填充图像 |
| **GetFrame** | `VIDIOC_DQBUF` | 取出已填好数据的 buffer，地址写入 `VIDEO_FRAME_S` |
| **ReleaseFrame** | `VIDIOC_QBUF` | 把用完的 buffer 重新入队给驱动，循环使用 |
| **去初始化** | `munmap` + `VIDIOC_REQBUFS(0)` | 解除映射，释放内核 DMA buffer |

所以 `mpVirAddr[]` 和 `mPhyAddr[]` 里存的是**一直存在的 mmap 地址**，`GetFrame` 只是把当前帧对应的那块 buffer 的地址"告知"应用层，并不做任何 malloc。`ReleaseFrame` 后这块内存并不释放，而是归还给驱动继续复用。

```plaintext
AW_MPI_VI_SetAttr()  ←── 配置 VI 属性（分辨率、格式、nbufs=3 等）
        │
        ▼
AW_MPI_VI_EnableVirChn()
        │
        ▼
videoInputHw（内核驱动层）
  ├── VIDIOC_REQBUFS  ──→  内核分配 DMA 物理内存（CMA/ION）
  ├── VIDIOC_QUERYBUF ──→  查询每块 buffer 的偏移
  └── mmap()          ──→  将物理内存映射到用户态虚拟地址
                            得到 buffer.planes[i].mem      (虚拟地址)
                            得到 buffer.planes[i].mem_phy  (物理地址)
```

```c
    if (video_dequeue_buffer(video, &buffer) < 0)
    {
        return ERR_VI_BUF_EMPTY;
    }
    // ...
    for (i = 0; i < vfmt.nplanes; i++)
    {
        pstFrameInfo->VFrame.mpVirAddr[i] = buffer.planes[i].mem;      // 虚拟地址（mmap 得到）
        pstFrameInfo->VFrame.mPhyAddr[i]  = buffer.planes[i].mem_phy;  // 物理地址（DMA 地址）
        pstFrameInfo->VFrame.mStride[i]   = width_stride;
    }
    // 对单 buffer 格式（NV21/NV12/YUV420等），手动计算 UV 平面偏移
    pstFrameInfo->VFrame.mpVirAddr[1] = buffer.planes[0].mem + ySize;
    pstFrameInfo->VFrame.mPhyAddr[1]  = buffer.planes[0].mem_phy + ySize;
```

