
---

**User**

你能否把从上层EnableVipp后到底层 buffer 申请、入队、开流再到buffer传递给上层完整的一条链分析清楚

---

**Cursor**

Optimizing conversation history

可以，这次我按你要求，**只围绕一条完整主链**来讲：

> **上层 `AW_MPI_VI_EnableVipp()`**  
> → **底层申请 V4L2 buffer**  
> → **buffer 入队**  
> → **开流**  
> → **采集线程 `DQBUF` 拿到一帧**  
> → **把 frame 分发给 VirChn component**  
> → **component 缓存 frame**  
> → **上层 `AW_MPI_VI_GetFrame()` 取到 buffer**  
> → **上层 `AW_MPI_VI_ReleaseFrame()` 归还后重新回到底层队列**

我把它拆成 8 步。

---

# 0. 先给一句总定义

这套 VI 链路实际上有 **三层 buffer 视角**：

1. **V4L2 驱动层 buffer**  
   真正由 `REQBUFS/QBUF/DQBUF/STREAMON` 管理的采集 buffer。

2. **`videoInputHw` 层 frame 分发与 ref 计数**  
   把同一个底层 buffer 以 `VIDEO_FRAME_INFO_S` 的形式分发给多个 VirChn。

3. **VirChn component 层 `mpCapMgr`**
   它不拥有底层图像内存，只管理每个 VirChn 的“待取/已取/归还”状态。

这个区分非常关键，否则会把 “驱动 buffer 池” 和 “component 队列” 混在一起。

---

# 1. 上层 `AW_MPI_VI_EnableVipp()` 只是入口

MPI 层很薄：

```263:271:middleware/sun8iw21/media/mpi_vi.c
ERRORTYPE AW_MPI_VI_EnableVipp(VI_DEV ViDev)
{
    if (!(ViDev >= 0 && ViDev < VI_VIPP_NUM_MAX)) {
        aloge("invalid ViDev[%d]", ViDev);
        return ERR_VI_INVALID_DEVID;
    }

    return videoInputHw_ChnEnable(ViDev);
}
```

所以真正逻辑进入了 `videoInputHw_ChnEnable()`。

---

# 2. `videoInputHw_ChnEnable()` 不是直接做 ioctl，而是给采集线程发“EnableVipp 命令”

代码在这里：

```1249:1281:middleware/sun8iw21/media/videoIn/videoInputHw.c
ERRORTYPE videoInputHw_ChnEnable(int ViVipp) /*Enable /dev/video[0~3] node*/
{
    ERRORTYPE rc;
    int ret;
    if (ViVipp >= HW_VIDEO_DEVICE_NUM || NULL == gpVIDevManager->media->video_dev[ViVipp])
    {
        aloge("VIN CH[%d] number is invalid!", ViVipp);
        return ERR_VI_INVALID_CHNID;
    }

    message_t msg;
    InitMessage(&msg);
    msg.command = VVideoInputHw_EnableVipp;
    msg.para0 = ViVipp;
    msg.pReply = ConstructMessageReply();
    putMessageWithData(&gpVIDevManager->mCmdQueue, &msg);
    while(1)
    {
        ret = cdx_sem_down_timedwait(&msg.pReply->ReplySem, 5000);
        if(ret != 0)
        {
            aloge("fatal error! wait enable vipp[%d] fail[0x%x]", ViVipp, ret);
        }
        else
        {
            break;
        }
    }
    rc = (ERRORTYPE)msg.pReply->ReplyResult;
    alogd("receive enable vipp[%d] reply: 0x%x!", ViVipp, rc);
    DestructMessageReply(msg.pReply);
    msg.pReply = NULL;
    return rc;
}
```

这里本质上做了 3 件事：

1. 组装消息 `VVideoInputHw_EnableVipp`
2. 投递到全局 `gpVIDevManager->mCmdQueue`
3. 同步等待采集线程处理完成并回包

所以：

> **EnableVipp 是“发消息给底层采集线程去执行 Enable”，不是当前线程直接做。**

---

# 3. 采集线程收到 `VVideoInputHw_EnableVipp` 后，真正做 buffer 申请 / 入队 / 开流

处理消息的线程是 `VideoInputHw_CapThread()`：

```6218:6286:middleware/sun8iw21/media/videoIn/videoInputHw.c
void * VideoInputHw_CapThread(void *pThreadData)
{
    // ...
    while (1)
    {
PROCESS_MESSAGE:
        if(get_message(&gpVIDevManager->mCmdQueue, &stCmdMsg) == 0)
        {
            alogv("VideoInputHw CapThread get_message cmd: %d", stCmdMsg.command);

            if (Stop == stCmdMsg.command)
            {
                goto EXIT;
            }
            else if (VVideoInputHw_EnableVipp == stCmdMsg.command)
            {
                ERRORTYPE cmdRet = SUCCESS;
                int nVipp = stCmdMsg.para0;
                struct isp_video_device *video = gpVIDevManager->media->video_dev[nVipp];
                viChnManager *pVipp = gpVIDevManager->gpVippManager[nVipp];
                // ...
                struct buffers_pool *pool = buffers_pool_new(video);
                if(NULL == pool)
                {
                    aloge("fatal error! new buffers pool fail");
                    cmdRet = ERR_VI_SYS_NOTREADY;
                    goto _enableVippExit;
                }
                ret = video_req_buffers(video, pool);
```

继续往下看：

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
pVipp->iDropFrameNum = vfmt.drop_frame_num;
pVipp->mLastGetFrameTm = -1;
pVipp->last_v_frm_pts = -1;

pthread_mutex_lock(&gpVIDevManager->mManagerLock);
videoInputHw_setVippEnable(nVipp);
pthread_mutex_unlock(&gpVIDevManager->mManagerLock);

_enableVippExit:
stCmdMsg.pReply->ReplyResult = (int)cmdRet;
cdx_sem_up(&stCmdMsg.pReply->ReplySem);
```

---

## 3.1 这几句分别对应哪些标准 V4L2 动作？

虽然你现在看到的是封装函数，但从接口名和职责上很清楚：

在 `video.h` 里声明了这些标准接口：

```127:134:middleware/sun8iw21/media/LIBRARY/libisp/include/device/video.h
int video_req_buffers(struct isp_video_device *video, struct buffers_pool *pool);
int video_free_buffers(struct isp_video_device *video);
int video_wait_buffer(struct isp_video_device *video, int timeout);
int video_dequeue_buffer(struct isp_video_device *video,	struct video_buffer *buffer);
int video_queue_buffer(struct isp_video_device *video, unsigned int buf_id);
int video_s_selection(struct isp_video_device *video, struct v4l2_selection *s);
int video_stream_on(struct isp_video_device *video);
int video_stream_off(struct isp_video_device *video);
```

可以对应为：

- `video_req_buffers()` → `VIDIOC_REQBUFS`
- `video_queue_buffer()` → `VIDIOC_QBUF`
- `video_dequeue_buffer()` → `VIDIOC_DQBUF`
- `video_stream_on()` → `VIDIOC_STREAMON`
- `video_stream_off()` → `VIDIOC_STREAMOFF`

所以 EnableVipp 的真正 V4L2 主链就是：

### EnableVipp 主链
1. `buffers_pool_new(video)`  
   创建本地 buffer 描述池
2. `video_req_buffers(video, pool)`  
   向驱动申请采集 buffer
3. `for(i=0; i<vfmt.nbufs; i++) video_queue_buffer(video, i)`  
   所有 buffer 先入驱动队列
4. `video_stream_on(video)`  
   开始采集流
5. 设置 `vipp_enable = true`
6. 回应上层 Enable 完成

---

# 4. 开流后，采集线程进入 `select()` + `DQBUF` 循环

Enable 完成后，`VideoInputHw_CapThread()` 不断轮询所有已 enable 的 vipp fd：

```6358:6399:middleware/sun8iw21/media/videoIn/videoInputHw.c
int nMaxFd = -1;
fd_set fds;
FD_ZERO(&fds);
// ... 遍历所有 enabled vipp，把 fd 放进 fds ...
int nSetNum = select(nMaxFd + 1, &fds, NULL, NULL, &tv);
if(nSetNum > 0)
{
    // 遍历 ready 的 fd
```

ready 后就调用 `videoInputHw_GetData()` 取一帧：

```5786:5802:middleware/sun8iw21/media/videoIn/videoInputHw.c
static ERRORTYPE videoInputHw_GetData(int nVipp, VIDEO_FRAME_INFO_S *pstFrameInfo)
{
    if (nVipp >= HW_VIDEO_DEVICE_NUM)
    {
        aloge("fatal error! vipp[%d] number is invalid!", nVipp);
        return ERR_VI_INVALID_CHNID;
    }
    viChnManager *pVippInfo = gpVIDevManager->gpVippManager[nVipp];
    struct isp_video_device *video = gpVIDevManager->media->video_dev[nVipp];
    struct video_buffer buffer;
    struct video_fmt vfmt;
    int i;
    int ev_value;

    if (video_dequeue_buffer(video, &buffer) < 0)
    {
        return ERR_VI_BUF_EMPTY;
    }
```

---

## 4.1 `DQBUF` 后干了什么？

`videoInputHw_GetData()` 不是把 `v4l2_buffer` 直接往上扔，而是转换成统一的 `VIDEO_FRAME_INFO_S`：

```5804:5820:middleware/sun8iw21/media/videoIn/videoInputHw.c
int isp_id = video_to_isp_id(video);
memset(&vfmt, 0, sizeof(vfmt));
video_get_fmt(video, &vfmt);
unsigned int width_stride = AWALIGN(vfmt.format.width, VIN_ALIGN_WIDTH);
unsigned int u_width_stride = AWALIGN(vfmt.format.width, VIN_ALIGN_WIDTH/2);
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

所以此时已经完成：

- 驱动 buffer → `video_buffer`
- `video_buffer` → `VIDEO_FRAME_INFO_S`

也就是把底层帧包装成 MPP 内部统一帧对象。

---

# 5. `DQBUF` 取出的 frame 怎么传给 VirChn component？

这是整条链里最关键的一步。

采集线程拿到一帧后，在 offline 模式下会把它分发给当前 VIPP 下所有虚拟通道：

```6525:6557:middleware/sun8iw21/media/videoIn/videoInputHw.c
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
    else
    {
        alogv("VIPP[%d] has no Virvi Component, drop this yuv data[%d-%d].", nVippIndex, stFrameInfo.mId, stFrameInfo.VFrame.mFramecnt);
        videoInputHw_ReleaseData(nVippIndex, &stFrameInfo);
    }
}
```

---

## 5.1 这里的本质是什么？

一句话：

> **底层采集线程把同一个 V4L2 buffer 的 frame 描述，逐个投递给各个 VirChn component。**

投递动作是：

```c
COMP_EmptyThisBuffer(pEntry->mViComp, &bufferHeader);
```

注意 `bufferHeader.pOutputPortPrivate = &stFrameInfo;`

这说明：

- 不是拷贝一份图像数据给 component
- 而是把**该帧的头信息和底层地址**交给 component
- 图像内存本体仍是同一个底层 buffer

---

# 6. component 收到 frame 后，先放进自己的 `mpCapMgr`

VirChn component 初始化时就创建了自己的帧管理器：

```1252:1258:middleware/sun8iw21/media/component/VideoVirVi_Component.c
cdx_sem_init(&pVideoViData->mSemWaitInputFrame, 0);
//mpCapMgr 是一个 FIFO 式帧队列，管理"硬件推入 → 用户消费"的帧生命周期，内部维护两个链表：mValidFrmList（待消费）和 mUsingFrmList（已取出未归还）
pVideoViData->mpCapMgr = VideoBufMgrCreate(VI_FIFO_LEVEL, 0);
if (pVideoViData->mpCapMgr == NULL) {
    aloge("videoInputBufMgrCreate error!");
    return FAILURE;
}
```

这个 manager 的定义很清楚：

```27:45:middleware/sun8iw21/media/include/utils/video_buffer_manager.h
typedef struct VideoBufferManager {
    struct list_head mFreeFrmList;
    struct list_head mValidFrmList;
    struct list_head mUsingFrmList;
    pthread_mutex_t mFrmListLock;
    pthread_cond_t mCondUsingFrmEmpty;
    int mFrameNodeNum;
    int mbWaitUsingFrmEmptyFlag;
    // ...
} VideoBufferManager;
```

而且它明确说明：

```74:76:middleware/sun8iw21/media/include/utils/video_buffer_manager.h
/* This buffer manager module is used to manage buffers that
*the real buffer pool is not belong to ourselves, we just use the buffer header info to manage it.
*/
```

即：

> **`mpCapMgr` 不拥有底层 V4L2 图像 buffer，只管理 frame header 的状态流转。**

---

## 6.1 frame 进入 component 的动作

VirChn component 收到 `COMP_EmptyThisBuffer()` 后，在非 tunnel 模式下会把 frame 推进 `mpCapMgr`：

```1065:1117:middleware/sun8iw21/media/component/VideoVirVi_Component.c
else
{
    bDiscardFlag = false;
    BOOL bNeedSendDropFrameMsg = FALSE;
    if(pVideoViData->mViVirChnAttr.mCacheFrameNum > 0)
    {
        int nFrameNum = pVideoViData->mpCapMgr->GetValidUsingFrameNum(pVideoViData->mpCapMgr);
        if(nFrameNum >= pVideoViData->mViVirChnAttr.mCacheFrameNum)
        {
            if(0 == pVideoViData->mViVirChnAttr.mCachePolicy)
            {
                bDiscardFlag = true;
                bNeedSendDropFrameMsg = FALSE;
                eError = FAILURE;
            }
            else if(1 == pVideoViData->mViVirChnAttr.mCachePolicy)
            {
                bDiscardFlag = false;
                bNeedSendDropFrameMsg = TRUE;
                alogv("nFrameNum=%d, VViComp DropFrame", nFrameNum);
            }
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
        alogv("VideoViEmptyThisBuffer pushFrame process, %p.\r\n", pFrm->VFrame.mpVirAddr[0]);
        if (pVideoViData->mWaitingCapDataFlag)
        {
            cdx_sem_up(&pVideoViData->mSemWaitInputFrame);
            pVideoViData->mWaitingCapDataFlag = FALSE;
        }
        pthread_mutex_unlock(&pVideoViData->mFrameLock);
    }
```

---

## 6.2 `VideoBufMgrPushFrame()` 实际做什么？

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

推入函数在同文件中：

```113:161:middleware/sun8iw21/media/utils/video_buffer_manager.c
static int VBMReleaseFrame(VideoBufferManager *pMgr, VIDEO_FRAME_INFO_S *pFrame)
{
    // ...
}

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

所以 component 层做的是：

- 从 `mFreeFrmList` 取一个节点
- 复制 `VIDEO_FRAME_INFO_S`
- 节点移到 `mValidFrmList`

即：

> **从 component 的角度，这一帧已经“准备好可供上层 GetFrame 取走”。**

---

# 7. 上层 `AW_MPI_VI_GetFrame()` 实际是从 component 的 `mpCapMgr` 取，不是直接 `DQBUF`

MPI 层：

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
        aloge("wrong state[0x%x], return!", nState);
        return ERR_VI_NOT_PERM;
    }

    ret = pNode->mViComp->GetConfig(pNode->mViComp, COMP_IndexVendorViGetFrame, (void *)&viParams);
    return ret;
}
```

最终进入 component 的 `DoVideoViGetData()`：

```225:289:middleware/sun8iw21/media/component/VideoVirVi_Component.c
ERRORTYPE DoVideoViGetData(PARAM_IN COMP_HANDLETYPE hComponent, PARAM_OUT VI_Params *pstParams, PARAM_IN int nMilliSec)
{
    // ...
    VIDEO_FRAME_INFO_S *pstFrameInfo = pstParams->pstFrameInfo;
    VIDEO_FRAME_INFO_S *tmp = NULL;
_TryToGetFrame:
    tmp = VideoBufMgrGetValidFrame(pVideoViData->mpCapMgr);
    if (NULL != tmp)
        goto GetFrmSuccess;

    if (0 == nMilliSec)
        return FAILURE;
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
    // ...
GetFrmSuccess:
    memcpy(&pstFrameInfo->VFrame, &tmp->VFrame, sizeof(VIDEO_FRAME_INFO_S));
    pstFrameInfo->mId = tmp->mId;
```

这说明：

### 从上层视角：
`AW_MPI_VI_GetFrame()` 取到的是 component 缓存好的 frame。

### 从状态流转视角：
`VideoBufMgrGetValidFrame()` 会把一帧从：

- `Valid`
移动到
- `Using`

所以这一步本质是：

> **上层“借走”了一帧。**

---

# 8. 上层 `ReleaseFrame()` 后，frame 如何最终回到底层驱动队列？

这是整条链闭环的最后一步。

上层 release 进入：

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
    alogv("DoVideoViReleaseData addr = %p.\r\n", pstFrameInfo->VFrame.mpVirAddr[0]);

    return SUCCESS;
}
```

这里做了两件事：

---

## 8.1 component 自己的 `Using -> Free`

`VideoBufMgrReleaseFrame()` 会把节点从 `Using` 放回 `Free`：

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
    }
```

这一步只是在 **VirChn component 内部** 归还这个 frame slot。

---

## 8.2 底层 ref 计数减 1，减到 0 才真正回驱动

```6096:6115:middleware/sun8iw21/media/videoIn/videoInputHw.c
ERRORTYPE videoInputHw_RefsReduceAndRleaseData(int vipp_id, VIDEO_FRAME_INFO_S *pstFrameInfo)
{
	int refs = 0, ret = -1;
    pthread_mutex_lock(&gpVIDevManager->gpVippManager[vipp_id]->mRefsLock);
    if(gpVIDevManager->gpVippManager[vipp_id]->refs[pstFrameInfo->mId] <= 0)
    {
        // ...
        abort();
    }
    gpVIDevManager->gpVippManager[vipp_id]->refs[pstFrameInfo->mId]--;
    refs = gpVIDevManager->gpVippManager[vipp_id]->refs[pstFrameInfo->mId];
	pthread_mutex_unlock(&gpVIDevManager->gpVippManager[vipp_id]->mRefsLock);

	if (0 == refs)
	{
		ret = videoInputHw_ReleaseData(vipp_id, pstFrameInfo);
	}
    return ret;
}
```

这里最关键的一点是：

> **一个底层 V4L2 buffer 可能同时被多个 VirChn/component/上层持有，所以不能谁先 release 谁就立刻 QBUF 回驱动。**

必须等 `refs == 0`。

而 `videoInputHw_ReleaseData()` 内部最终会把这个 buffer 重新 `QBUF` 回驱动队列：

```6096:6115:middleware/sun8iw21/media/videoIn/videoInputHw.c
if (0 == refs)
{
    ret = videoInputHw_ReleaseData(vipp_id, pstFrameInfo);
}
```

结合前面读到的 release 路径可知，它内部就是做：

- `video_queue_buffer(...)`
- 对应驱动侧重新入队

这样这个底层采集 buffer 才能再次参与下一轮采集。

---

# 9. 把整条链压缩成一张“时间线”

---

## 阶段 A：EnableVipp

### 1）上层调用
```c
AW_MPI_VI_EnableVipp(ViDev)
```

### 2）MPI 转发
```263:271:middleware/sun8iw21/media/mpi_vi.c
return videoInputHw_ChnEnable(ViDev);
```

### 3）给底层采集线程发命令
```1249:1281:middleware/sun8iw21/media/videoIn/videoInputHw.c
msg.command = VVideoInputHw_EnableVipp;
putMessageWithData(&gpVIDevManager->mCmdQueue, &msg);
wait reply ...
```

### 4）采集线程真正执行
```6242:6275:middleware/sun8iw21/media/videoIn/videoInputHw.c
buffers_pool_new(video);
video_req_buffers(video, pool);   // REQBUFS
for (...) video_queue_buffer(video, i);   // QBUF
video_stream_on(video);           // STREAMON
```

---

## 阶段 B：采集线程拿到一帧

### 5）`select()` 检测 fd ready
```6358:6399:middleware/sun8iw21/media/videoIn/videoInputHw.c
select(nMaxFd + 1, &fds, NULL, NULL, &tv);
```

### 6）`DQBUF`
```5786:5802:middleware/sun8iw21/media/videoIn/videoInputHw.c
video_dequeue_buffer(video, &buffer);
```

### 7）封装成 `VIDEO_FRAME_INFO_S`
```5804:5820:middleware/sun8iw21/media/videoIn/videoInputHw.c
pstFrameInfo->VFrame.mpVirAddr[i] = buffer.planes[i].mem;
pstFrameInfo->VFrame.mPhyAddr[i] = buffer.planes[i].mem_phy;
```

---

## 阶段 C：分发给 VirChn component

### 8）采集线程遍历所有 VirChn
```6525:6557:middleware/sun8iw21/media/videoIn/videoInputHw.c
list_for_each_entry(pEntry, &pVippInfo->mChnList, mList)
{
    bufferHeader.pOutputPortPrivate = &stFrameInfo;
    COMP_EmptyThisBuffer(pEntry->mViComp, &bufferHeader);
}
```

### 9）VirChn component 收帧后放入 `mpCapMgr`
```1065:1117:middleware/sun8iw21/media/component/VideoVirVi_Component.c
VideoBufMgrPushFrame(pVideoViData->mpCapMgr, pFrm);
```

此时 frame 状态：
- component: `Free -> Valid`

---

## 阶段 D：上层取帧

### 10）sample / app 调用
```c
AW_MPI_VI_GetFrame(ViDev, ViCh, &frame, timeout)
```

### 11）进入 component 的 `DoVideoViGetData`
```225:289:middleware/sun8iw21/media/component/VideoVirVi_Component.c
tmp = VideoBufMgrGetValidFrame(pVideoViData->mpCapMgr);
```

此时 frame 状态：
- component: `Valid -> Using`

### 12）返回给上层
```c
memcpy(&pstFrameInfo->VFrame, &tmp->VFrame, ...);
```

---

## 阶段 E：上层归还帧

### 13）app 调用
```c
AW_MPI_VI_ReleaseFrame(ViDev, ViCh, &frame)
```

### 14）component 先归还自身引用
```347:367:middleware/sun8iw21/media/component/VideoVirVi_Component.c
videoInputHw_RefsReduceAndRleaseData(vipp_id, pstFrameInfo);
VideoBufMgrReleaseFrame(pVideoViData->mpCapMgr, pstFrameInfo);
```

此时 component 状态：
- `Using -> Free`

### 15）如果底层 ref 计数减到 0
```6096:6115:middleware/sun8iw21/media/videoIn/videoInputHw.c
if (0 == refs)
{
    ret = videoInputHw_ReleaseData(vipp_id, pstFrameInfo);
}
```

### 16）底层重新 `QBUF` 回驱动
于是该 buffer 再次回到驱动采集队列，进入下一轮循环。

---

# 10. 最后给你一句“抓主线”的总结

如果只记一条线，你就记这个：

### 完整主链
`AW_MPI_VI_EnableVipp`
→ `videoInputHw_ChnEnable`
→ 发 `VVideoInputHw_EnableVipp` 消息  
→ 采集线程里 `REQBUFS`
→ `QBUF`
→ `STREAMON`
→ `select`
→ `DQBUF`
→ 封装成 `VIDEO_FRAME_INFO_S`
→ `COMP_EmptyThisBuffer` 投递给每个 VirChn component
→ component 用 `mpCapMgr` 缓存
→ 上层 `AW_MPI_VI_GetFrame` 从 `mpCapMgr` 取
→ 上层 `AW_MPI_VI_ReleaseFrame`
→ component release + 底层 ref--
→ ref 为 0 时 `QBUF` 回驱动

---

# 11. 一句回答你最核心的疑问

你如果问：

## “从 EnableVipp 到上层 GetFrame，中间谁真的持有 buffer？”

答案是：

- **真正 buffer 所有权**：在 V4L2 驱动 / `videoInputHw`
- **VirChn component**：只持有 frame header 和使用状态
- **上层 app/sample**：只是临时借用该 frame 的地址视图
- **最终归还条件**：所有引用都释放后，底层才会重新 `QBUF`

---

如果你愿意，我下一步可以继续把这条链再往下深挖两层：

1. **`videoInputHw_ReleaseData()` 内部如何把 `frameId -> QBUF` 精确映射回驱动 buffer**
2. **一个底层 frame 同时分发给多个 VirChn 时，`refs[]` 和 `VideoFrameInfo[frameId]` 如何保证不串帧**

这两块一补，你对这个 VI buffer 生命周期就完全闭环了。

