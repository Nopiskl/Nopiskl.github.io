
---

**Cursor**

可以，这次我把“**启动 VI 采集之后，buffer 是怎么从 V4L2 驱动一路流到 sample 上层线程**”这条链彻底串起来，并专门回答你提的两点。

---

# 先给结论

你标的这两处其实分别对应两层：

1. `sample_virvi.c (865-874)`  
   这里只是**启动 VirChn 进入 Executing 状态 + 拉起上层取帧线程**，并不是直接做 V4L2 ioctl。  
   真正的 V4L2 `REQBUFS/QBUF/STREAMON/DQBUF` 都在更底层的 `videoInputHw.c` 里完成。

2. `VideoVirVi_Component.c (1256-1260)`  
   这里创建的 `mpCapMgr = VideoBufMgrCreate(...)`，不是驱动 buffer 池，而是**component 层自己的帧引用/流转管理器**。  
   它只管理 `VIDEO_FRAME_INFO_S` 头信息和状态流转：  
   `Free -> Valid -> Using -> Free`  
   不拥有真正图像内存，真正图像内存仍属于底层 V4L2 buffer。

---

# 一、先看你标的 `sample_virvi.c (865-874)` 到底干了什么

这段代码本身很短：

```865:874:middleware/sun8iw21/sample/sample_virvi/sample_virvi.c
eRet = AW_MPI_VI_EnableVirChn(pCap->Dev, pCap->Chn);
if (eRet)
{
    aloge("fatal error! vi dev[%d] enable virvi chn[%d] fail!", pCap->Dev, pCap->Chn);
    return -1;
}

pthread_create(&pCap->thid, NULL, GetCSIFrameThread, (void *)pCap);
return 0;
```

它只做两件事：

## 1.1 `AW_MPI_VI_EnableVirChn()`
把 VI 组件从 `Idle` 切到 `Executing`。  
也就是让 VirChn component 进入工作态，开始允许收帧/出帧。

## 1.2 `pthread_create(... GetCSIFrameThread ...)`
起一个 sample 层线程，循环调用：

- `AW_MPI_VI_GetFrame()`
- `AW_MPI_VI_ReleaseFrame()`

真正 sample 取帧线程在这里：

```584:652:middleware/sun8iw21/sample/sample_virvi/sample_virvi.c
static void *GetCSIFrameThread(void *pThreadData)
{
    int ret = 0;
    int frm_cnt = 0;
    SampleVirviCap *pCap = (SampleVirviCap *)pThreadData;
    // ...

    while (1)
    {
        if (pCap->mbExitFlag)
        {
            break;
        }

        // vi get frame
        if ((ret = AW_MPI_VI_GetFrame(pCap->Dev, pCap->Chn, &pCap->pstFrameInfo, pCap->s32MilliSec)) != 0)
        {
            continue ;
        }

        // ... sample 自己消费/拷贝帧 ...

        // vi release frame
        AW_MPI_VI_ReleaseFrame(pCap->Dev, pCap->Chn, &pCap->pstFrameInfo);
    }

    return NULL;
}
```

所以这段代码的意义不是“直接采集”，而是：

> **启动 component 工作态，然后让 sample 层通过 MPI 接口开始消费 component 中缓存好的帧。**

---

# 二、那真正的 V4L2 ioctl 在哪里做？

答案：**在 `videoInputHw.c` 的硬件采集线程和启停逻辑里做。**

整个链路可以拆成 3 层：

---

## 第 1 层：EnableVipp 时完成 V4L2 buffer 建立和 stream on

VIPP enable 之后，底层硬件线程收到 `VVideoInputHw_EnableVipp` 消息，做真正的 buffer 申请、入队、开流：

```6242:6286:middleware/sun8iw21/media/videoIn/videoInputHw.c
struct buffers_pool *pool = buffers_pool_new(video);
if(NULL == pool)
{
    aloge("fatal error! new buffers pool fail");
    cmdRet = ERR_VI_SYS_NOTREADY;
    goto _enableVippExit;
}
ret = video_req_buffers(video, pool);
if(ret < 0)
{
    aloge("fatal error! video req buffers fail");
    cmdRet = ERR_VI_NOMEM;
    goto _enableVippExit;
}
struct video_fmt vfmt;
memset(&vfmt, 0, sizeof(vfmt));
video_get_fmt(video, &vfmt);
alogd("EnableVipp[%d]: vfmt.bufs:%d, online:%d", nVipp, vfmt.nbufs, vfmt.ve_online_en);
int i;
for(i = 0; i < vfmt.nbufs; i++)
{
    ret = video_queue_buffer(video, i);
    if(ret != 0)
    {
        aloge("fatal error! video queue buffer fail:%d", ret);
    }
}
ret = video_stream_on(video);
if(ret < 0)
{
    aloge("fatal error! video stream on fail:%d", ret);
    cmdRet = ERR_VI_SYS_NOTREADY;
    goto _enableVippExit;
}
```

这里你可以把它映射成标准 V4L2 语义：

- `video_req_buffers(video, pool)`  
  对应 **`VIDIOC_REQBUFS`**
- `video_queue_buffer(video, i)`  
  对应 **`VIDIOC_QBUF`**
- `video_stream_on(video)`  
  对应 **`VIDIOC_STREAMON`**

所以真正“设置 buffer、把 buffer 交给驱动、启动采集流”的动作都在这里完成，而不是 sample 层。

---

## 第 2 层：采集线程 select + DQBUF 拿到一帧

底层采集线程 `VideoInputHw_CapThread()` 持续 `select()` 所有已使能 VIPP 的 fd：

```6358:6399:middleware/sun8iw21/media/videoIn/videoInputHw.c
int nMaxFd = -1;
fd_set fds;
FD_ZERO(&fds);
// ... 遍历所有 enable 的 vipp，把 fd 加入 fd_set ...
int nSetNum = select(nMaxFd + 1, &fds, NULL, NULL, &tv);
if(nSetNum > 0)
{
    // 遍历有数据的 vipp fd
```

一旦某个 VIPP fd 就绪，就调用：

```5786:5802:middleware/sun8iw21/media/videoIn/videoInputHw.c
static ERRORTYPE videoInputHw_GetData(int nVipp, VIDEO_FRAME_INFO_S *pstFrameInfo)
{
    // ...
    struct video_buffer buffer;
    // ...
    if (video_dequeue_buffer(video, &buffer) < 0)
    {
        return ERR_VI_BUF_EMPTY;
    }
```

这里：

- `video_dequeue_buffer(video, &buffer)`  
  对应标准 **`VIDIOC_DQBUF`**

也就是说，真正从驱动取出一帧 buffer，就是在这里。

---

## 第 3 层：把 DQBUF 拿到的 buffer 封装成 `VIDEO_FRAME_INFO_S`

`videoInputHw_GetData()` 会把驱动 dequeued 的 `video_buffer` 内容转换成 MPP 内部统一帧描述 `VIDEO_FRAME_INFO_S`：

```5786:5826:middleware/sun8iw21/media/videoIn/videoInputHw.c
static ERRORTYPE videoInputHw_GetData(int nVipp, VIDEO_FRAME_INFO_S *pstFrameInfo)
{
    // ...
    if (video_dequeue_buffer(video, &buffer) < 0)
    {
        return ERR_VI_BUF_EMPTY;
    }
    // ...
    video_get_fmt(video, &vfmt);
    for (i = 0; i < vfmt.nplanes; i++)
    {
        pstFrameInfo->VFrame.mpVirAddr[i] = buffer.planes[i].mem;
        if(IsV4L2_PIX_FMTCompress(vfmt.format.pixelformat))
        {
            pstFrameInfo->VFrame.mStride[i] = buffer.planes[i].size;
        }
        else
        {
            pstFrameInfo->VFrame.mStride[i] = width_stride;
        }
        pstFrameInfo->VFrame.mPhyAddr[i] = buffer.planes[i].mem_phy;
    }
```

这里就完成了从 V4L2 到 MPP 的第一层封装：

- `buffer.planes[i].mem` → `mpVirAddr[i]`
- `buffer.planes[i].mem_phy` → `mPhyAddr[i]`
- stride、format、宽高等也一起整理进 `VIDEO_FRAME_INFO_S`

也就是说：

> **component 层和 sample 层后面看到的不是裸 `v4l2_buffer`，而是被包装过的 `VIDEO_FRAME_INFO_S`。**

---

# 三、这帧数据怎么从底层传到 component，再传到 sample 上层？

这是你真正关心的“数据怎么流动”。

我按时序给你串起来。

---

## 3.1 底层从 V4L2 DQBUF 得到一帧

来源：`videoInputHw_GetData()`

- 驱动返回一个 dequeued buffer
- 封装成 `stFrameInfo`

---

## 3.2 分发给所有 VirChn component

`VideoInputHw_CapThread()` 在 offline 模式下会遍历该 VIPP 的 `mChnList`，把同一帧发给每个 VirChn 组件：

```6525:6544:middleware/sun8iw21/media/videoIn/videoInputHw.c
if (0 == pVippInfo->refs[stFrameInfo.mId])
{
    if (!list_empty(&pVippInfo->mChnList))
    {
        videoInputHw_RefsIncrease(nVippIndex, &stFrameInfo);
        list_for_each_entry(pEntry, &pVippInfo->mChnList, mList)
        {
            memcpy(&pVippInfo->VideoFrameInfo[stFrameInfo.mId], &stFrameInfo, sizeof(stFrameInfo));
            COMP_BUFFERHEADERTYPE bufferHeader;
            bufferHeader.nInputPortIndex = VI_CHN_PORT_INDEX_CAP_IN;
            bufferHeader.pOutputPortPrivate = &stFrameInfo;
            videoInputHw_RefsIncrease(nVippIndex, &stFrameInfo);
            ERRORTYPE ret2 = COMP_EmptyThisBuffer(pEntry->mViComp, &bufferHeader);
            if (ret2 != SUCCESS)
            {
                videoInputHw_RefsReduceAndRleaseData(nVippIndex, &stFrameInfo);
            }
        }
        videoInputHw_RefsReduceAndRleaseData(nVippIndex, &stFrameInfo);
    }
```

这段是整条链的核心。

### 它做了什么？

1. 当前 VIPP 拿到一帧 `stFrameInfo`
2. 遍历这个 VIPP 下所有虚拟通道 `mChnList`
3. 给每个通道组件调用一次：
   - `COMP_EmptyThisBuffer(pEntry->mViComp, &bufferHeader)`

这里的 `bufferHeader.pOutputPortPrivate = &stFrameInfo`，说明：

> **这帧不是复制一份像素数据传给 component，而是把帧描述头和底层 buffer 地址交给 component。**

---

## 3.3 component 收到帧：`VideoViEmptyThisBuffer()`

VirChn component 收到上一步投递的 buffer 后，进入：

```1039:1118:middleware/sun8iw21/media/component/VideoVirVi_Component.c
if (pBuffer->nInputPortIndex == pVideoViData->sPortDef[VI_CHN_PORT_INDEX_CAP_IN].nPortIndex)
{
    if(pVideoViData->mOutputPortTunnelFlag)
    {
        // tunnel 模式
    }
    else
    {
        bDiscardFlag = false;
        BOOL bNeedSendDropFrameMsg = FALSE;
        if(pVideoViData->mViVirChnAttr.mCacheFrameNum > 0)
        {
            int nFrameNum = pVideoViData->mpCapMgr->GetValidUsingFrameNum(pVideoViData->mpCapMgr);
            if(nFrameNum >= pVideoViData->mViVirChnAttr.mCacheFrameNum)
            {
                // 根据 cache policy 丢当前帧或丢旧帧
            }
        }
        if(!bDiscardFlag)
        {
            pthread_mutex_lock(&pVideoViData->mFrameLock);
            eError = VideoBufMgrPushFrame(pVideoViData->mpCapMgr, pFrm);
            if (eError != SUCCESS)
            {
                pthread_mutex_unlock(&pVideoViData->mFrameLock);
                aloge("failed to push this frame, it will be droped\n");
                eError = FAILURE;
                goto push_fail;
            }
            if (pVideoViData->mWaitingCapDataFlag)
            {
                cdx_sem_up(&pVideoViData->mSemWaitInputFrame);
                pVideoViData->mWaitingCapDataFlag = FALSE;
            }
            pthread_mutex_unlock(&pVideoViData->mFrameLock);
        }
```

这一步的本质是：

### component 不直接把帧返回给 sample
而是先把帧放进自己内部的 `mpCapMgr`

也就是：

- 从底层来的帧 → 进入 component 私有 buffer manager
- sample 层随后再通过 `AW_MPI_VI_GetFrame()` 来取

---

## 3.4 sample 线程调用 `AW_MPI_VI_GetFrame()`

sample 线程在 `GetCSIFrameThread()` 中反复调用：

```584:652:middleware/sun8iw21/sample/sample_virvi/sample_virvi.c
if ((ret = AW_MPI_VI_GetFrame(pCap->Dev, pCap->Chn, &pCap->pstFrameInfo, pCap->s32MilliSec)) != 0)
{
    continue ;
}
```

MPI 层实现：

```1527:1555:middleware/sun8iw21/media/mpi_vi.c
ERRORTYPE AW_MPI_VI_GetFrame(VI_DEV ViDev, VI_CHN ViCh, VIDEO_FRAME_INFO_S *pstFrameInfo, AW_S32 s32MilliSec)
{
    // ...
    VI_Params viParams;
    viParams.mDev = ViDev;
    viParams.mChn = ViCh;
    viParams.pstFrameInfo = pstFrameInfo;
    viParams.s32MilliSec = s32MilliSec;

    ret = pNode->mViComp->GetState(pNode->mViComp, &nState);
    if (COMP_StateExecuting != nState && COMP_StateIdle != nState) {
        return ERR_VI_NOT_PERM;
    }

    ret = pNode->mViComp->GetConfig(pNode->mViComp, COMP_IndexVendorViGetFrame, (void *)&viParams);
    return ret;
}
```

注意这里不是直接碰硬件，而是：

- 调 component 的 `GetConfig`
- index = `COMP_IndexVendorViGetFrame`

最后落到：

```225:295:middleware/sun8iw21/media/component/VideoVirVi_Component.c
ERRORTYPE DoVideoViGetData(PARAM_IN COMP_HANDLETYPE hComponent, PARAM_OUT VI_Params *pstParams, PARAM_IN int nMilliSec)
{
    // ...
    VIDEO_FRAME_INFO_S *tmp = NULL;
_TryToGetFrame:
    tmp = VideoBufMgrGetValidFrame(pVideoViData->mpCapMgr);
    if (NULL != tmp)
        goto GetFrmSuccess;
    // ...
GetFrmSuccess:
    memcpy(&pstFrameInfo->VFrame, &tmp->VFrame, sizeof(VIDEO_FRAME_INFO_S));
    pstFrameInfo->mId = tmp->mId;
```

这说明：

### sample 的 `GetFrame` 是从 component 的 `mpCapMgr` 中取，不是直接 DQBUF
`VideoBufMgrGetValidFrame()` 会把一帧从：

- `Valid` 链表
移动到
- `Using` 链表

然后返回给 sample。

---

## 3.5 sample 使用完成后 `AW_MPI_VI_ReleaseFrame()`

sample 用完后：

```584:652:middleware/sun8iw21/sample/sample_virvi/sample_virvi.c
AW_MPI_VI_ReleaseFrame(pCap->Dev, pCap->Chn, &pCap->pstFrameInfo);
```

MPI 层：

```1558:1585:middleware/sun8iw21/media/mpi_vi.c
ERRORTYPE AW_MPI_VI_ReleaseFrame(VI_DEV ViDev, VI_CHN ViCh, VIDEO_FRAME_INFO_S *pFrameInfo)
{
    // ...
    eRet = pNode->mViComp->SetConfig(pNode->mViComp, COMP_IndexVendorViReleaseFrame, (void *)&viParams);
    return eRet;
}
```

component 层：

```347:367:middleware/sun8iw21/media/component/VideoVirVi_Component.c
ERRORTYPE DoVideoViReleaseData(PARAM_IN COMP_HANDLETYPE hComponent, PARAM_IN VI_Params *pstParams)
{
    VIDEOVIDATATYPE *pVideoViData = (VIDEOVIDATATYPE *)(((MM_COMPONENTTYPE *)hComponent)->pComponentPrivate);
    // ...
    int vipp_id = pstParams->mDev;
    VIDEO_FRAME_INFO_S *pstFrameInfo = pstParams->pstFrameInfo;
    videoInputHw_RefsReduceAndRleaseData(vipp_id, pstFrameInfo);
    VideoBufMgrReleaseFrame(pVideoViData->mpCapMgr, pstFrameInfo);
    return SUCCESS;
}
```

这里做两件事：

1. `videoInputHw_RefsReduceAndRleaseData(...)`
   - component 对底层这帧的引用计数减 1
   - 如果减到 0，底层才真正把该 buffer requeue 回驱动

2. `VideoBufMgrReleaseFrame(...)`
   - component 自己的 `Using -> Free`

也就是说：

> sample 的 `ReleaseFrame()` 不只是“归还给 component”，最终还会通过 ref 计数机制把底层 V4L2 buffer 还给驱动循环使用。

---

# 四、用一句话概括整个数据流

完整流向是：

**V4L2驱动 buffer**  
→ `REQBUFS/QBUF/STREAMON` 建立采集队列  
→ `DQBUF` 取出一帧  
→ 封装成 `VIDEO_FRAME_INFO_S`  
→ `VideoInputHw_CapThread` 分发给 VirChn component  
→ `VideoViEmptyThisBuffer()` 放进 `mpCapMgr`  
→ sample 线程 `AW_MPI_VI_GetFrame()` 从 `mpCapMgr` 取  
→ sample 用完 `AW_MPI_VI_ReleaseFrame()`  
→ component 降 ref  
→ ref 为 0 时底层 requeue/释放回驱动

---

# 五、重点回答你第 1 问：component 层如何通过标准 V4L2 ioctl 设置、获取 buffer 并传给上层？

严格说，**component 层本身并不直接调用标准 V4L2 ioctl**。  
V4L2 ioctl 发生在更底层 `videoInputHw.c`。

component 层做的是**承上启下**：

## 5.1 “设置 buffer”
不是 component 做，而是 `EnableVipp` 时硬件层做：

- `video_req_buffers()` → `VIDIOC_REQBUFS`
- `video_queue_buffer()` → `VIDIOC_QBUF`
- `video_stream_on()` → `VIDIOC_STREAMON`

代码见：

```6242:6275:middleware/sun8iw21/media/videoIn/videoInputHw.c
struct buffers_pool *pool = buffers_pool_new(video);
ret = video_req_buffers(video, pool);
// ...
for(i = 0; i < vfmt.nbufs; i++)
{
    ret = video_queue_buffer(video, i);
}
ret = video_stream_on(video);
```

## 5.2 “获取 buffer”
也不是 component 直接做，而是采集线程：

- `select()`
- `video_dequeue_buffer()` → `VIDIOC_DQBUF`

代码见：

```5786:5802:middleware/sun8iw21/media/videoIn/videoInputHw.c
static ERRORTYPE videoInputHw_GetData(int nVipp, VIDEO_FRAME_INFO_S *pstFrameInfo)
{
    if (video_dequeue_buffer(video, &buffer) < 0)
    {
        return ERR_VI_BUF_EMPTY;
    }
```

## 5.3 “传给上层”
这是 component 层完成的：

- 底层把帧投给 `COMP_EmptyThisBuffer`
- component 把帧放进 `mpCapMgr`
- 上层 sample 调 `AW_MPI_VI_GetFrame`
- component 再从 `mpCapMgr` 取给上层

所以你可以理解为：

### 底层 `videoInputHw`
负责和 **V4L2 驱动** 打交道

### component 层 `VideoVirVi_Component`
负责把底层采到的帧变成 **MPI 可消费的 component-buffer 流**

### sample 层
只看到 `AW_MPI_VI_GetFrame/ReleaseFrame`

---

# 六、重点回答你第 2 问：`VideoVirVi_Component.c (1256-1260)` 这个 mgr 到底怎么管理 buffer？

你标的是这段：

```1252:1258:middleware/sun8iw21/media/component/VideoVirVi_Component.c
cdx_sem_init(&pVideoViData->mSemWaitInputFrame, 0);
//mpCapMgr 是一个 FIFO 式帧队列，管理"硬件推入 → 用户消费"的帧生命周期，内部维护两个链表：mValidFrmList（待消费）和 mUsingFrmList（已取出未归还）
pVideoViData->mpCapMgr = VideoBufMgrCreate(VI_FIFO_LEVEL, 0);
if (pVideoViData->mpCapMgr == NULL) {
    aloge("videoInputBufMgrCreate error!");
    return FAILURE;
}
```

这里的 `mpCapMgr` 是 component 自己的 buffer manager。  
它的结构定义在：

```27:45:middleware/sun8iw21/media/include/utils/video_buffer_manager.h
typedef struct VideoBufferManager {
    struct list_head mFreeFrmList;
    struct list_head mValidFrmList;
    struct list_head mUsingFrmList;
    pthread_mutex_t mFrmListLock;
    pthread_cond_t mCondUsingFrmEmpty;
    int mFrameNodeNum;
    int mbWaitUsingFrmEmptyFlag;

    VIDEO_FRAME_INFO_S* (*GetOldestValidFrame)(struct VideoBufferManager *pMgr);
    VIDEO_FRAME_INFO_S* (*GetOldestUsingFrame)(struct VideoBufferManager *pMgr);
    VIDEO_FRAME_INFO_S* (*GetSpecUsingFrameWithAddr)(struct VideoBufferManager *pMgr, void *pVirAddr);
    VIDEO_FRAME_INFO_S* (*GetAllValidUsingFrame)(struct VideoBufferManager *pMgr);
    VIDEO_FRAME_INFO_S* (*getValidFrame)(struct VideoBufferManager *pMgr);
    int (*releaseFrame)(struct VideoBufferManager *pMgr, VIDEO_FRAME_INFO_S *pFrame);
    int (*pushFrame)(struct VideoBufferManager *pMgr, VIDEO_FRAME_INFO_S *pFrame);
    int (*usingFrmEmpty)(struct VideoBufferManager *pMgr);
    int (*waitUsingFrmEmpty)(struct VideoBufferManager *pMgr);
    int (*GetValidUsingFrameNum)(struct VideoBufferManager *pMgr);
} VideoBufferManager;
```

---

## 6.1 它管理的不是“真实图像内存”

这个非常关键。

看头文件注释：

```74:76:middleware/sun8iw21/media/include/utils/video_buffer_manager.h
/* This buffer manager module is used to manage buffers that
*the real buffer pool is not belong to ourselves, we just use the buffer header info to manage it.
*/
```

也就是说：

- `mpCapMgr` **不拥有 V4L2 mmap buffer**
- 它只管理 `VIDEO_FRAME_INFO_S` 的副本和状态
- 真正像素内存 `mpVirAddr[] / mPhyAddr[]` 仍是底层驱动那块 buffer

所以这个 manager 更准确地说是：

> **一个 component 层的“帧引用状态管理器”**

不是驱动层的 buffer pool。

---

## 6.2 `VideoBufMgrCreate()` 初始化了什么？

```203:229:middleware/sun8iw21/media/utils/video_buffer_manager.c
VideoBufferManager *VideoBufMgrCreate(int frmNum, int frmSize)
{
    VideoBufferManager *pMgr = (VideoBufferManager *)malloc(sizeof(VideoBufferManager));
    // ...
    INIT_LIST_HEAD(&pMgr->mFreeFrmList);
    INIT_LIST_HEAD(&pMgr->mValidFrmList);
    INIT_LIST_HEAD(&pMgr->mUsingFrmList);
    pthread_mutex_init(&pMgr->mFrmListLock, NULL);
    pthread_cond_init(&pMgr->mCondUsingFrmEmpty, NULL);
    int i;
    for (i = 0; i < frmNum; ++i) {
        VideoFrameListInfo *pNode = (VideoFrameListInfo *)malloc(sizeof(VideoFrameListInfo));
        // ...
        list_add_tail(&pNode->mList, &pMgr->mFreeFrmList);
        pMgr->mFrameNodeNum++;
    }
```

它做的事是：

1. 创建 manager 对象
2. 建三个链表
   - `mFreeFrmList`
   - `mValidFrmList`
   - `mUsingFrmList`
3. 预分配 `frmNum` 个 `VideoFrameListInfo` 节点到 `mFreeFrmList`

### 这三个链表的意义

#### `mFreeFrmList`
空闲槽位  
还没装任何当前有效帧

#### `mValidFrmList`
已有帧、但还没被上层取走

#### `mUsingFrmList`
已经被上层 `GetFrame()` 取走、但还没 `ReleaseFrame()`

---

## 6.3 组件层收到一帧时：`Free -> Valid`

底层采集线程把帧投给 component 后，component 调：

```1096:1105:middleware/sun8iw21/media/component/VideoVirVi_Component.c
pthread_mutex_lock(&pVideoViData->mFrameLock);
eError = VideoBufMgrPushFrame(pVideoViData->mpCapMgr, pFrm);
if (eError != SUCCESS)
{
    pthread_mutex_unlock(&pVideoViData->mFrameLock);
    aloge("failed to push this frame, it will be droped\n");
    eError = FAILURE;
    goto push_fail;
}
```

对应 mgr 实现：

```146:161:middleware/sun8iw21/media/utils/video_buffer_manager.c
static int VBMPushFrame(VideoBufferManager *pMgr, VIDEO_FRAME_INFO_S *pFrame)
{
    VideoFrameListInfo *pEntry = NULL;

    pthread_mutex_lock(&pMgr->mFrmListLock);
    if (list_empty(&pMgr->mFreeFrmList)) {
        pthread_mutex_unlock(&pMgr->mFrmListLock);
        return FAILURE;
    }

    pEntry = list_first_entry(&pMgr->mFreeFrmList, VideoFrameListInfo, mList);
    pEntry->mFrame = *pFrame;
    list_move_tail(&pEntry->mList, &pMgr->mValidFrmList);
    pthread_mutex_unlock(&pMgr->mFrmListLock);

    return SUCCESS;
}
```

### 这一步本质
- 从 `Free` 取一个节点
- 把当前帧头拷进去
- 节点移动到 `Valid`

即：

> **新到的一帧进入 component 的“待消费队列”**

---

## 6.4 sample 取帧时：`Valid -> Using`

上层 `AW_MPI_VI_GetFrame()` 最后会调用：

```247:289:middleware/sun8iw21/media/component/VideoVirVi_Component.c
tmp = VideoBufMgrGetValidFrame(pVideoViData->mpCapMgr);
if (NULL != tmp)
    goto GetFrmSuccess;
```

对应 mgr：

```22:36:middleware/sun8iw21/media/utils/video_buffer_manager.c
static VIDEO_FRAME_INFO_S *VBMGetValidFrame(VideoBufferManager *pMgr)
{
    VideoFrameListInfo *pEntry = NULL;

    pthread_mutex_lock(&pMgr->mFrmListLock);
    if (list_empty(&pMgr->mValidFrmList)) {
        pthread_mutex_unlock(&pMgr->mFrmListLock);
        return NULL;
    }

    pEntry = list_first_entry(&pMgr->mValidFrmList, VideoFrameListInfo, mList);
    list_move_tail(&pEntry->mList, &pMgr->mUsingFrmList);
    pthread_mutex_unlock(&pMgr->mFrmListLock);

    return &pEntry->mFrame;
}
```

### 这一步本质
- 从 `Valid` 取出最旧一帧
- 节点移到 `Using`
- 返回给上层

即：

> **component 认为这帧已经“借给用户了”，等待用户归还。**

---

## 6.5 sample 释放帧时：`Using -> Free`

组件释放时：

```347:367:middleware/sun8iw21/media/component/VideoVirVi_Component.c
videoInputHw_RefsReduceAndRleaseData(vipp_id, pstFrameInfo);
VideoBufMgrReleaseFrame(pVideoViData->mpCapMgr, pstFrameInfo);
```

mgr 实现：

```113:143:middleware/sun8iw21/media/utils/video_buffer_manager.c
static int VBMReleaseFrame(VideoBufferManager *pMgr, VIDEO_FRAME_INFO_S *pFrame)
{
    VideoFrameListInfo *pEntry, *pTmp;
    int found = 0;

    pthread_mutex_lock(&pMgr->mFrmListLock);
    list_for_each_entry_safe(pEntry, pTmp, &pMgr->mUsingFrmList, mList)
    {
        if (pEntry->mFrame.VFrame.mpVirAddr[0] == pFrame->VFrame.mpVirAddr[0] ||
            pEntry->mFrame.mId == pFrame->mId) {
            *pFrame = pEntry->mFrame;
            list_del(&pEntry->mList);
            found = 1;
            break;
        }
    }

    if (found) {
        list_add_tail(&pEntry->mList, &pMgr->mFreeFrmList);
    } else {
        aloge("fatal error! Unknown video frame, frame id[%d]!", pFrame->mId);
        pthread_mutex_unlock(&pMgr->mFrmListLock);
        return FAILURE;
    }
```

### 这一步本质
- 在 `Using` 列表里按地址或 frame id 找到这帧
- 移出 `Using`
- 放回 `Free`

即：

> **这个 component 级“槽位”重新可用了。**

---

## 6.6 等待/唤醒机制

如果上层取帧时队列为空，`DoVideoViGetData()` 会阻塞等新帧：

```225:283:middleware/sun8iw21/media/component/VideoVirVi_Component.c
else if (nMilliSec < 0) {
    pVideoViData->mWaitingCapDataFlag = TRUE;
    tmp = VideoBufMgrGetValidFrame(pVideoViData->mpCapMgr);
    if (tmp != NULL) {
        pVideoViData->mWaitingCapDataFlag = FALSE;
        goto GetFrmSuccess;
    } else {
        cdx_sem_down(&pVideoViData->mSemWaitInputFrame);
        pVideoViData->mWaitingCapDataFlag = FALSE;
        goto _TryToGetFrame;
    }
}
```

而新帧 push 进来时，如果有人在等，就唤醒：

```1106:1111:middleware/sun8iw21/media/component/VideoVirVi_Component.c
if (pVideoViData->mWaitingCapDataFlag)
{
    cdx_sem_up(&pVideoViData->mSemWaitInputFrame);
    pVideoViData->mWaitingCapDataFlag = FALSE;
}
```

这说明 `mpCapMgr + mSemWaitInputFrame` 共同实现了：

- 无帧时阻塞等待
- 来帧后立即唤醒取帧线程

---

# 七、把 `mpCapMgr` 的角色说透

你可以把 component 层的 `mpCapMgr` 理解成：

## 7.1 不是驱动 buffer 池
不是 `VIDIOC_REQBUFS` 出来的那堆 buffer 本身

## 7.2 是 VirChn 自己的“消费视图”
它把底层来的帧按 VirChn 维度组织成三态：

- `Free`：component 里可用槽位
- `Valid`：已到达、待用户取
- `Using`：用户已取但未还

## 7.3 它使 component 拥有独立缓存策略
比如：

```1068:1090:middleware/sun8iw21/media/component/VideoVirVi_Component.c
if(pVideoViData->mViVirChnAttr.mCacheFrameNum > 0)
{
    int nFrameNum = pVideoViData->mmpCapMgr->GetValidUsingFrameNum(...);
    if(nFrameNum >= pVideoViData->mViVirChnAttr.mCacheFrameNum)
    {
        if(0 == pVideoViData->mViVirChnAttr.mCachePolicy)
        {
            // 丢当前帧
        }
        else if(1 == pVideoViData->mViVirChnAttr.mCachePolicy)
        {
            // 触发丢旧帧
        }
    }
}
```

也就是说：

> **真正做“VirChn 级缓存控制”的，不是底层 V4L2 queue，而是这个 `mpCapMgr`。**

---

# 八、最后给你一个完整时序图

## 8.1 启动采集

- `AW_MPI_VI_EnableVipp`
  - `REQBUFS`
  - `QBUF`
  - `STREAMON`

- `AW_MPI_VI_EnableVirChn`
  - component `Idle -> Executing`

- sample 启动 `GetCSIFrameThread`

---

## 8.2 底层来一帧

- `select(fd)`
- `DQBUF`
- 生成 `stFrameInfo`

---

## 8.3 分发到 component

- `VideoInputHw_CapThread`
- 遍历 `mChnList`
- `COMP_EmptyThisBuffer(pEntry->mViComp, &bufferHeader)`

---

## 8.4 component 缓存这帧

- `VideoViEmptyThisBuffer`
- `VideoBufMgrPushFrame`
- `Free -> Valid`

---

## 8.5 sample 取帧

- `AW_MPI_VI_GetFrame`
- `DoVideoViGetData`
- `VideoBufMgrGetValidFrame`
- `Valid -> Using`

---

## 8.6 sample 还帧

- `AW_MPI_VI_ReleaseFrame`
- `DoVideoViReleaseData`
- `videoInputHw_RefsReduceAndRleaseData`
- `VideoBufMgrReleaseFrame`
- `Using -> Free`

---

如果你愿意，我下一步可以继续给你补下面两个非常关键的点：

1. **`videoInputHw_RefsIncrease / RefsReduceAndRleaseData` 引用计数机制怎么保证一帧可以分发给多个 VirChn 而不乱**
2. **`video_req_buffers / video_queue_buffer / video_dequeue_buffer / video_stream_on` 再往下对应到哪些标准 `VIDIOC_*` ioctl 封装函数**  

这两块接上后，你对“V4L2 buffer → VI component → sample”这条链就完全闭环了。

