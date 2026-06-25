# VirChn implementation analysis
_Exported on 2026/6/4 at GMT+8 14:40:33 from Cursor (2.6.21)_

---

**User**

结合@agent_docs/virchn.md 以及工作区中的MPP源码，详细分析一下VirChn是怎么实现的？最好像我给你发的文档那样，有类似流程图的解析

---

**Cursor**

我会先阅读你提到的文档，并在源码里定位 `VirChn` 相关实现，再整理成带流程图式结构的解析。

我已经确认文档是之前的分析草稿。接下来我会对照源码中的关键函数，把实现细节补全并纠正文档中可能过于简化的部分。

部分搜索输出被路径/正则限制影响了，我会直接读取源码的关键区间来确认实现。

还需要确认 GetFrame 起始部分和 Bind 函数主体，以便描述用户取帧和 tunnel 建立的闭环。

下面结合你现有的 `agent_docs/virchn.md` 风格，以及工作区里 `middleware/sun8iw21/media` 下的 MPP 源码，对 `VirChn` 做一次更完整的实现分析。重点结论先说：

**VirChn 不是内核里真的又开了多个 `/dev/videoX` 通道，而是在用户态 MPP 中为同一个 VIPP 建多个 `VideoVirVi_Component` 实例。采集线程从一个 VIPP 取到一帧后，遍历该 VIPP 下挂的所有 VirChn，把同一个 DMA buffer 的帧信息分发给每个 VirChn，并用 `refs[frameId]` 引用计数保证所有消费者都归还后才 `QBUF` 还给内核。**

---

## 1. 整体架构：一个 VIPP，多路 VirChn，共享同一帧

以一个 sensor 输出给 VENC 和 VO 为例，MPP 的典型组织方式是：

```text
Sensor / CSI / ISP
        │
        ▼
VIPP /dev/videoX
        │
        │ DQBUF：取出一个物理 DMA buffer
        ▼
VideoInputHw_CapThread
        │
        │ 遍历 gpVippManager[ViDev]->mChnList
        │ 对每个 VirChn refs[frameId]++
        │ COMP_EmptyThisBuffer(VirChnComp, &frame)
        │
        ├─────────────────────────────┐
        │                             │
        ▼                             ▼
VirChn 0                           VirChn 1
VideoVirVi_Component               VideoVirVi_Component
        │                             │
        │ tunnel out                   │ tunnel out
        ▼                             ▼
VENC Component                    VO Component
编码 H264/H265                     显示预览
        │                             │
        │ FillThisBuffer 回调归还帧     │ FillThisBuffer 回调归还帧
        └──────────────┬──────────────┘
                       ▼
              refs[frameId]--
                       │
              refs == 0 时 QBUF
                       ▼
              归还给 VIPP 内核队列
```

所以“一个 sensor 图像同时给到 VENC 和 VO”的关键并不是复制图像数据，而是：

1. **同一个 VIPP 下创建多个 VirChn**；
2. 每个 VirChn 是一个独立 OMX 组件；
3. 每个 VirChn 只能 tunnel 到一个下游；
4. 采集线程把同一帧广播给所有 VirChn；
5. 用引用计数追踪这帧还有几个消费者没有释放。

---

## 2. 核心数据结构

### 2.1 `VI_CHN_MAP_S`：MPI 层的 VirChn 句柄节点

每创建一个 VirChn，MPP 都会分配一个 `VI_CHN_MAP_S`，它保存该虚通道的 OMX 组件句柄，并挂到 VIPP 的 `mChnList` 链表里。

```74:85:middleware/sun8iw21/media/include/videoIn/videoInputHw.h
typedef struct VI_CHN_MAP_S {
    int mThdRunning;
    // VI_DEV mViDev;             
	/* DevX = SensorX; // X = 0,1,2,3 */
	/* ChnX = ScaleX;  // X = 0,1,2...16 */
    VI_CHN mViChn;  //vipp<<16 | virChn
    MM_COMPONENTTYPE *mViComp; /* video vi component instance */
    cdx_sem_t mSemCompCmd;
    MPPCallbackInfo mCallbackInfo;
    struct list_head mList;
} VI_CHN_MAP_S;
```

这里的 `mViChn` 被编码成：

```text
mViChn = (ViDev << 16) | ViCh
```

也就是说：

```text
高 16 bit：VIPP ID / VI_DEV
低 16 bit：VirChn ID
```

---

### 2.2 `viChnManager`：每个 VIPP 的全局管理对象

每个 VIPP 都有一个 `viChnManager`，里面最关键的是：

```text
mChnList           当前 VIPP 下所有 VirChn
refs[32]           每个内核 DMA buffer slot 的引用计数
VideoFrameInfo[32] 每个 slot 的帧信息备份
mIdleFrameList     调试/追踪：空闲帧节点
mReadyFrameList    调试/追踪：已取出未完全归还帧节点
```

对应源码：

```91:130:middleware/sun8iw21/media/include/videoIn/videoInputHw.h
typedef struct {
	//pthread_t threadid;
	//pthread_t threadid_gyro;
	//pthread_t threadid_videoPorcess;
    char mThreadName[32];
	VI_DEV  vipp_dev_id; /* vipp id num */
	int	vipp_enable; /* 1:enable; 0:disable. default=0. */
    struct list_head mChnList;  //element type: VI_CHN_MAP_S
    pthread_mutex_t mLock;

    MPPCallbackFuncType mMppCallback;
    void *pAppData;

    //int mVippTimeoutCnt;
    int iDropFrameNum; //left frames to drop.
    int64_t mLastGetFrameTm;    //unit:ms

	int 	refs[32];
    VIDEO_FRAME_INFO_S	VideoFrameInfo[32]; //store frame info from vipp.
    pthread_mutex_t mRefsLock;

    //for debug video frame occupy
    struct list_head mIdleFrameList;    //VippFrame
    struct list_head mReadyFrameList;
    pthread_mutex_t mFrameListLock;
```

`refs[]` 是整个 VirChn 实现的生命线。它表示某个 `mId` 对应的内核 buffer 当前还有多少个 VirChn / 下游模块正在持有。

---

### 2.3 `VIDEOVIDATATYPE`：每个 VirChn 组件自己的私有上下文

`VideoVirVi_Component.c` 里定义了每个 VirChn 组件的私有数据：

```45:78:middleware/sun8iw21/media/component/VideoVirVi_Component.c
typedef struct awVIDEOVIDATATYPE{
    COMP_STATETYPE state;
    pthread_mutex_t mStateLock;
    pthread_mutex_t mLock;
    COMP_CALLBACKTYPE* pCallbacks;
    void* pAppData;
    COMP_HANDLETYPE hSelf;
    char mThreadName[32];

    COMP_PORT_PARAM_TYPE sPortParam;
    COMP_PARAM_PORTDEFINITIONTYPE sPortDef[VI_CHN_MAX_PORTS];
    COMP_INTERNAL_TUNNELINFOTYPE sPortTunnelInfo[VI_CHN_MAX_PORTS];
    COMP_PARAM_BUFFERSUPPLIERTYPE sPortBufSupplier[VI_CHN_MAX_PORTS];
    bool mInputPortTunnelFlag;
    bool mOutputPortTunnelFlag;  //TRUE: tunnel mode; FALSE: non-tunnel mode.

    MPP_CHN_S mMppChnInfo;
    VI_ATTR_S mViAttr;
    ViVirChnAttrS mViVirChnAttr;
    pthread_t thread_id;
```

其中最重要的是：

| 字段 | 含义 |
|---|---|
| `state` | OMX 组件状态：Loaded / Idle / Executing / Pause |
| `sPortDef[]` | VirChn 的端口定义 |
| `sPortTunnelInfo[]` | tunnel 连接信息 |
| `mOutputPortTunnelFlag` | 是否已经绑定下游模块 |
| `mMppChnInfo` | `{MOD_ID_VIU, ViDev, VirChn}` |
| `mViAttr` | VIPP 设备属性 |
| `mViVirChnAttr` | VirChn 缓存策略等属性 |
| `mpCapMgr` | 当前 VirChn 的帧队列 |
| `mSemWaitInputFrame` | 非 tunnel 模式下 `AW_MPI_VI_GetFrame` 等帧信号量 |

---

## 3. VirChn 的端口设计

`VideoVirViCompPortIndex.h` 定义了 VirChn 组件的三个端口：

```13:18:middleware/sun8iw21/media/include/component/VideoVirViCompPortIndex.h
typedef enum VI_CHANNEL_PORT_DEFINE_E {
	VI_CHN_PORT_INDEX_CAP_IN = 0,
	VI_CHN_PORT_INDEX_FILE_IN, /* FILE_IN : Decode H26x,mpeg data, or yuv file input*/
	VI_CHN_PORT_INDEX_OUT,
	VI_CHN_MAX_PORTS,
} VI_CHANNEL_PORT_DEFINE_E;
```

可以理解为：

```text
VideoVirVi_Component
        │
        ├── CAP_IN   ：来自 VideoInputHw_CapThread 的采集帧
        ├── FILE_IN  ：文件输入预留，代码里基本未用
        └── OUT      ：输出给 VENC / VO / ISE / EIS 等下游组件
```

每个 VirChn 的 `OUT` 端口只能连接一个下游，因为 `mOutputPortTunnelFlag` 只有一个，绑定后再次绑定会报错。

这也是为什么一个 sensor 同时给 VENC 和 VO 时，通常不是：

```text
VirChn0 -> VENC + VO
```

而是：

```text
VirChn0 -> VENC
VirChn1 -> VO
```

两个 VirChn 共享同一个 VIPP 源。

---

## 4. 创建流程：`AW_MPI_VI_CreateVirChn`

创建 VirChn 的入口在 `mpi_vi.c`：

```1291:1368:middleware/sun8iw21/media/mpi_vi.c
ERRORTYPE AW_MPI_VI_CreateVirChn(VI_DEV ViDev, VI_CHN ViCh, ViVirChnAttrS *pAttr)
{
    ERRORTYPE eRet = SUCCESS;
    int status = -1;
    VI_CHN_MAP_S *pNode = NULL;

    if ((!(ViDev >= 0 && ViDev < VI_VIPP_NUM_MAX)) ||
        (!(ViCh >= 0 && ViCh < VI_VIRCHN_NUM_MAX))){
        aloge("fatal error! invalid ViDev[%d], ViVirChn[%d]!", ViDev, ViCh);
        return ERR_VI_INVALID_CHNID;
    }
    ///////判断是否存在虚通道
    eRet = videoInputHw_searchExistDevVirChn(ViDev, ViCh, &pNode);
    if (SUCCESS == eRet)
    {
        alogv("vichn[%d] has exist!!\n", ViCh);
        return ERR_VI_EXIST;
    }
    else if(ERR_VI_SYS_NOTREADY == eRet)
    {
        aloge("fatal error! whu vipp[%d] is not ready when create virChn[%d]?", ViDev, ViCh);
        return ERR_VI_SYS_NOTREADY;
    }
    videoInputHw_searchVippStatus(ViDev, &status);
    if (0 == status) {
        alogd("we allow to create virChn[%d] in disable status of vipp[%d]", ViCh, ViDev);
        //return ERR_VI_UNEXIST;
    }

    pNode = videoInputHw_CHN_MAP_S_Construct();
```

后续流程是：

```text
AW_MPI_VI_CreateVirChn(ViDev, ViCh, pAttr)
        │
        ├── 检查 ViDev / ViCh 范围
        │
        ├── 检查该 VirChn 是否已存在
        │
        ├── videoInputHw_CHN_MAP_S_Construct()
        │       创建 VI_CHN_MAP_S 节点
        │
        ├── pNode->mViChn = (ViDev << 16) | ViCh
        │
        ├── COMP_GetHandle(CDX_ComponentNameViScale)
        │       创建 VideoVirVi_Component
        │       初始化 VIDEOVIDATATYPE
        │       创建 mpCapMgr
        │       创建 Vi_ComponentThread
        │
        ├── COMP_SetConfig(COMP_IndexVendorMPPChannelInfo)
        │       写入 {MOD_ID_VIU, ViDev, ViCh}
        │
        ├── videoInputHw_GetChnAttr(ViDev)
        │       从 VIPP 读取 VI_ATTR_S
        │
        ├── COMP_SetConfig(COMP_IndexVendorViDevAttr)
        │       把 VIPP 属性写入 VirChn
        │
        ├── COMP_SetConfig(COMP_IndexVendorViChnAttr)
        │       写入 VirChn 属性
        │
        ├── COMP_SendCommand(StateSet, Idle)
        │       VirChn 从 Loaded -> Idle
        │
        ├── cdx_sem_down(&pNode->mSemCompCmd)
        │       等待状态切换完成
        │
        └── videoInputHw_addChannel(ViDev, pNode)
                挂到 gpVippManager[ViDev]->mChnList
```

最关键的是最后一步：**挂链表**。只有挂到 `mChnList` 后，采集线程才会把 VIPP 帧分发给这个 VirChn。

```1354:1369:middleware/sun8iw21/media/mpi_vi.c
    eRet = COMP_SendCommand(pNode->mViComp, COMP_CommandStateSet, COMP_StateIdle, NULL);

    
    cdx_sem_down(&pNode->mSemCompCmd);
    videoInputHw_addChannel(ViDev, pNode);
    //把 pNode（即 VI_CHN_MAP_S，包含 mViComp 句柄）尾插到 gpVippManager[ViDev]->mChnList 链表中。
    //这是整个创建流程的最后一步，也是最关键的一步。一旦 pNode 挂入链表，硬件采集线程 VideoInputHw_CapThread 在每次从 VIPP 拿到帧后，会遍历这条链表，向每个虚拟通道推帧
    return eRet;
}
```

---

## 5. 组件初始化：`VideoViComponentInit`

`COMP_GetHandle(CDX_ComponentNameViScale)` 最终会初始化 `VideoVirVi_Component`。初始化动作包括：

1. 分配 `VIDEOVIDATATYPE`；
2. 初始化锁、信号量；
3. 创建 `mpCapMgr` 帧队列；
4. 注册组件函数表；
5. 初始化 CAP_IN / FILE_IN / OUT 三个端口；
6. 创建组件内部线程 `Vi_ComponentThread`。

关键代码：

```1231:1255:middleware/sun8iw21/media/component/VideoVirVi_Component.c
    cdx_sem_init(&pVideoViData->mSemWaitInputFrame, 0);
    //mpCapMgr 是一个 FIFO 式帧队列，管理"硬件推入 → 用户消费"的帧生命周期，内部维护两个链表：mValidFrmList（待消费）和 mUsingFrmList（已取出未归还）
    pVideoViData->mpCapMgr = VideoBufMgrCreate(VI_FIFO_LEVEL, 0);
    if (pVideoViData->mpCapMgr == NULL) {
        aloge("videoInputBufMgrCreate error!");
        return FAILURE;
    }
    // Fill in function pointers
    pComp->SetCallbacks = VideoViSetCallbacks;
    pComp->SendCommand = VideoViSendCommand;
    pComp->GetConfig = VideoViGetConfig;
    pComp->SetConfig = VideoViSetConfig;
    pComp->GetState = VideoViGetState;
    pComp->ComponentTunnelRequest = VideoViComponentTunnelRequest;
    pComp->ComponentDeInit = VideoViComponentDeInit;
    pComp->EmptyThisBuffer = VideoViEmptyThisBuffer;
    pComp->FillThisBuffer = VideoViFillThisBuffer;
```

这里要特别注意：

- `EmptyThisBuffer` 是 VirChn **接收上游帧** 的入口；
- `FillThisBuffer` 是 VirChn **从下游收回帧** 的入口。

也就是：

```text
VideoInputHw_CapThread
        │
        │ COMP_EmptyThisBuffer(VirChn, frame)
        ▼
VideoViEmptyThisBuffer()

下游 VENC / VO 用完
        │
        │ COMP_FillThisBuffer(VirChn, frame)
        ▼
VideoViFillThisBuffer()
```

---

## 6. 启用流程：`AW_MPI_VI_EnableVirChn`

创建后 VirChn 只是 `Idle`，还不会真正接收帧。使能时会切到 `Executing`：

```1442:1465:middleware/sun8iw21/media/mpi_vi.c
ERRORTYPE AW_MPI_VI_EnableVirChn(VI_DEV ViDev, VI_CHN ViCh)
{
    VI_CHN_MAP_S *pNode;
    if ((!(ViDev >= 0 && ViDev < VI_VIPP_NUM_MAX)) ||
        (!(ViCh >= 0 && ViCh < VI_VIRCHN_NUM_MAX))){
        aloge("fatal error! invalid ViDev[%d], ViVirChn[%d]!", ViDev, ViCh);
        return ERR_VI_INVALID_CHNID;
    }
    if (SUCCESS != videoInputHw_searchExistDevVirChn(ViDev, ViCh, &pNode)) {
        aloge("vichn[%d] is unexist!!\n", ViCh);
        return ERR_VI_UNEXIST;
    }
    int eRet;
    COMP_STATETYPE nCompState;
    eRet = pNode->mViComp->GetState(pNode->mViComp, &nCompState);
    if (COMP_StateIdle == nCompState) {
        eRet = pNode->mViComp->SendCommand(pNode->mViComp, COMP_CommandStateSet, COMP_StateExecuting, NULL);
        cdx_sem_down(&pNode->mSemCompCmd);
```

对应流程：

```text
AW_MPI_VI_EnableVirChn
        │
        ├── 查找 VI_CHN_MAP_S
        │
        ├── 获取组件状态
        │
        ├── Idle ?
        │       │
        │       ├── 是：SendCommand(StateSet, Executing)
        │       └── 否：一般 do nothing
        │
        └── 等待 mSemCompCmd
```

在 `VideoViEmptyThisBuffer()` 中，只有 `Executing` 或 `Pause` 状态才正常接收帧；`Idle` 默认会丢弃帧。

---

## 7. 数据分发核心：`VideoInputHw_CapThread`

### 7.1 采集线程的角色

`VideoInputHw_CapThread` 是全局采集线程，负责：

```text
select 多个 VIPP fd
        │
        ├── 哪个 VIPP 有帧可读
        │
        ├── DQBUF 得到 VIDEO_FRAME_INFO_S
        │
        ├── 做 drop frame、online/offline 判断
        │
        └── offline 模式下分发给所有 VirChn
```

VirChn 真正能“一帧多用”的逻辑就在这里：

```6564:6605:middleware/sun8iw21/media/videoIn/videoInputHw.c
                                else //distribute frame to all virChns
                                {
                                    VI_CHN_MAP_S *pEntry;
                                    pthread_mutex_lock(&pVippInfo->mLock);// Fix me mID
                                    /*
                                    1. normal video have this mID , it from videoX buffer.
                                    2. stabilization video no this mID
                                    */
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

### 7.2 分发流程图

```text
VideoInputHw_CapThread 取到 stFrameInfo
        │
        ▼
检查 refs[stFrameInfo.mId] 是否为 0
        │
        ├── 不为 0
        │       │
        │       └── 说明该 buffer 上一轮还没完全归还
        │           直接 release/drop，打印错误
        │
        └── 为 0
                │
                ▼
        检查 mChnList 是否为空
                │
                ├── 空
                │       └── 没有 VirChn，直接 videoInputHw_ReleaseData()
                │
                └── 非空
                        │
                        ├── refs++ 保护遍历期间不归零
                        │
                        ├── 遍历每个 VI_CHN_MAP_S
                        │       │
                        │       ├── 保存 VideoFrameInfo[mId]
                        │       ├── refs++
                        │       ├── COMP_EmptyThisBuffer(VirChnComp, frame)
                        │       └── 如果 VirChn 拒绝帧，则 refs--
                        │
                        └── 遍历结束后 refs--
                            抵消最开始的保护引用
```

这里有一个很巧妙的细节：**遍历前先 `refs++`，遍历后再 `refs--`。**

原因是：如果只有一个 VirChn，而且它在 `COMP_EmptyThisBuffer` 中很快失败或者归还，`refs` 可能在遍历过程中变成 0 并触发 `QBUF`。为了避免遍历期间 buffer 被提前还给内核，代码先加了一个“临时引用”。

---

## 8. 引用计数机制：所有消费者释放后才 QBUF

### 8.1 `refs++`

```6126:6134:middleware/sun8iw21/media/videoIn/videoInputHw.c
static ERRORTYPE videoInputHw_RefsIncrease(int vipp_id, VIDEO_FRAME_INFO_S *pstFrameInfo)
{ // it will be not called.
    pthread_mutex_lock(&gpVIDevManager->gpVippManager[vipp_id]->mRefsLock);
	gpVIDevManager->gpVippManager[vipp_id]->refs[pstFrameInfo->mId]++;
    pthread_mutex_unlock(&gpVIDevManager->gpVippManager[vipp_id]->mRefsLock);
	return SUCCESS;
}
```

### 8.2 `refs--`，归零释放

```6136:6160:middleware/sun8iw21/media/videoIn/videoInputHw.c
ERRORTYPE videoInputHw_RefsReduceAndRleaseData(int vipp_id, VIDEO_FRAME_INFO_S *pstFrameInfo)
{
	int refs = 0, ret = -1;
    pthread_mutex_lock(&gpVIDevManager->gpVippManager[vipp_id]->mRefsLock);
    if(gpVIDevManager->gpVippManager[vipp_id]->refs[pstFrameInfo->mId] <= 0)
    {
        for(int i=0; i<100; i++)
        {
            aloge("fatal error! vipp[%d], frmid[%d]: ref=[%d] when reduce refs, check code!", vipp_id, pstFrameInfo->mId,
                gpVIDevManager->gpVippManager[vipp_id]->refs[pstFrameInfo->mId]);
        }
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

引用计数生命周期可以画成：

```text
VIPP DQBUF 得到 frameId = N
        │
        ├── VirChn0 接收成功：refs[N]++
        ├── VirChn1 接收成功：refs[N]++
        ├── VirChn2 接收成功：refs[N]++
        │
        ▼
refs[N] = 3
        │
        ├── VirChn0 下游用完：refs[N]--
        ├── VirChn1 下游用完：refs[N]--
        ├── VirChn2 下游用完：refs[N]--
        │
        ▼
refs[N] = 0
        │
        ▼
videoInputHw_ReleaseData()
        │
        ▼
VIDIOC_QBUF / video_queue_buffer
        │
        ▼
buffer N 回到内核采集队列
```

---

## 9. VirChn 收帧入口：`VideoViEmptyThisBuffer`

采集线程分发到每个 VirChn 时，会调用：

```text
COMP_EmptyThisBuffer(pEntry->mViComp, &bufferHeader)
```

对应实现是 `VideoViEmptyThisBuffer()`。

### 9.1 状态检查

```799:833:middleware/sun8iw21/media/component/VideoVirVi_Component.c
ERRORTYPE VideoViEmptyThisBuffer(PARAM_IN COMP_HANDLETYPE hComponent, PARAM_IN COMP_BUFFERHEADERTYPE *pBuffer)
{
    ERRORTYPE eError    = SUCCESS;
    ERRORTYPE ret;
    VIDEOVIDATATYPE *pVideoViData = (VIDEOVIDATATYPE *) (((MM_COMPONENTTYPE*) hComponent)->pComponentPrivate);
    VIDEO_FRAME_INFO_S *pFrm = (VIDEO_FRAME_INFO_S *)pBuffer->pOutputPortPrivate;
    uint64_t FrmIntervalMs = (pFrm->VFrame.mpts-pVideoViData->mLastFrmPtsCache)/1000;
    unsigned int FrmCntInterval = pFrm->VFrame.mFramecnt-pVideoViData->mLastFrmCnt;
    int iGetLongExpFlag = 0;

    /* long exposure mode should be 1S and lager time interval,
    * if the time interval is less than 1S, it may be regarded as normal frame.
    */
    if (0 != pVideoViData->mLastFrmPtsCache && (FrmIntervalMs>1000/pVideoViData->mViAttr.fps*FrmCntInterval+500)) {
        iGetLongExpFlag = 1;
    }

    pFrm->VFrame.mWhoSetFlag = (pVideoViData->mMppChnInfo.mModId<<16) | (pVideoViData->mMppChnInfo.mDevId<<8) | (pVideoViData->mMppChnInfo.mChnId);

    pVideoViData->mLastFrmPtsCache = pFrm->VFrame.mpts;
    pVideoViData->mLastFrmCnt      = pFrm->VFrame.mFramecnt;

    pthread_mutex_lock(&pVideoViData->mStateLock);
    bool bDiscardFlag = false;
```

状态逻辑：

```text
VideoViEmptyThisBuffer
        │
        ├── state == Executing / Pause
        │       └── 接收
        │
        ├── state == Idle
        │       └── 当前代码实际不支持 Idle 收帧，丢弃
        │
        └── 其他状态
                └── 丢弃
```

虽然有 `mbRecvInIdleState` 字段，但源码里可以看到，即使它为 true，也会打印“不支持 idle 接收”，然后丢弃。

---

### 9.2 tunnel 模式：推给下游 VENC / VO

如果 VirChn 已经通过 `AW_MPI_SYS_Bind` 绑定了下游，那么 `mOutputPortTunnelFlag == TRUE`。这时收到帧后：

1. 检查缓存数量；
2. `VideoBufMgrPushFrame()` 放入本 VirChn 队列；
3. `VideoBufMgrGetValidFrame()` 取出一帧标记为 using；
4. 调用下游组件的 `COMP_EmptyThisBuffer()`；
5. 如果下游拒绝，则释放本 VirChn 队列引用。

核心代码：

```900:957:middleware/sun8iw21/media/component/VideoVirVi_Component.c
        if(pVideoViData->mOutputPortTunnelFlag)
        {
            bDiscardFlag = false;
            if(pVideoViData->mViVirChnAttr.mCacheFrameNum > 0)
            {
                int nFrameNum = pVideoViData->mpCapMgr->GetValidUsingFrameNum(pVideoViData->mpCapMgr);
                if(nFrameNum >= pVideoViData->mViVirChnAttr.mCacheFrameNum)
                {
                    //cache frame number is enough, discard current frame.
                    bDiscardFlag = true;
                    eError = FAILURE;
                }
            }
            if(!bDiscardFlag)
            {
                pthread_mutex_lock(&pVideoViData->mFrameLock);
                eError = VideoBufMgrPushFrame(pVideoViData->mpCapMgr, pFrm);
                if (eError != SUCCESS)
                {
                    pthread_mutex_unlock(&pVideoViData->mFrameLock);
                    aloge("fatal error! failed to push this frame, it will be droped");
                    eError = FAILURE;
                    goto push_fail;
                }
                alogv("VideoViEmptyThisBuffer pushFrame process, %p.\r\n", pFrm->VFrame.mpVirAddr[0]);
                pthread_mutex_unlock(&pVideoViData->mFrameLock);

                /* Tunnel mode, send frame to next component */
                //alogw("Tunnel virvi debug.\r\n");
                COMP_INTERNAL_TUNNELINFOTYPE *pPortTunnelInfo = &pVideoViData->sPortTunnelInfo[VI_CHN_PORT_INDEX_OUT];
                MM_COMPONENTTYPE *pOutTunnelComp = (MM_COMPONENTTYPE*)pPortTunnelInfo->hTunnel;
                if (pOutTunnelComp != NULL)
                {
                    COMP_BUFFERHEADERTYPE obh;
                    pthread_mutex_lock(&pVideoViData->mFrameLock);
                    VIDEO_FRAME_INFO_S *pFrm = VideoBufMgrGetValidFrame(pVideoViData->mpCapMgr);
```

继续往下就是发给下游：

```999:1024:middleware/sun8iw21/media/component/VideoVirVi_Component.c
                    obh.nOutputPortIndex = pPortTunnelInfo->nPortIndex;
                    obh.nInputPortIndex = pPortTunnelInfo->nTunnelPortIndex;
                    //obh.pOutputPortPrivate = pFrm;
                    obh.pOutputPortPrivate = pFrm;
                    ret = COMP_EmptyThisBuffer(pOutTunnelComp, &obh);
                    if(SUCCESS != ret)
                    {
                        if(ERR_VENC_BUF_FULL == ret)
                        {
                            alogd("viChn[%d-%d] detect refuse because limited frame number, ret[0x%x].", pVideoViData->mMppChnInfo.mDevId,
                                pVideoViData->mMppChnInfo.mChnId, ret);
                        }
                        else if(ERR_VENC_INCORRECT_STATE_OPERATION == ret)
                        {
                            alogd("viChn[%d-%d] detect refuse because state is incorrect, ret[0x%x].", pVideoViData->mMppChnInfo.mDevId,
                                pVideoViData->mMppChnInfo.mChnId, ret);
                        }
```

tunnel 模式流程图：

```text
VideoViEmptyThisBuffer
        │
        ├── mOutputPortTunnelFlag == TRUE
        │
        ├── 检查 mCacheFrameNum
        │       │
        │       ├── 队列满：丢弃当前帧，返回 FAILURE
        │       └── 未满：继续
        │
        ├── VideoBufMgrPushFrame(mpCapMgr, pFrm)
        │
        ├── VideoBufMgrGetValidFrame(mpCapMgr)
        │       把帧从 valid 转为 using
        │
        ├── 构造 obh
        │       obh.nOutputPortIndex = VirChn OUT
        │       obh.nInputPortIndex  = 下游输入 port
        │       obh.pOutputPortPrivate = pFrm
        │
        ├── COMP_EmptyThisBuffer(下游组件, &obh)
        │
        └── 下游接收失败？
                │
                ├── 是：VideoBufMgrReleaseFrame()
                └── 否：等待下游用完后回调 FillThisBuffer()
```

---

### 9.3 非 tunnel 模式：用户通过 `AW_MPI_VI_GetFrame` 取帧

如果没有绑定下游，即 `mOutputPortTunnelFlag == FALSE`，VirChn 会把帧缓存在自己的 `mpCapMgr` 中，等待用户调用：

```text
AW_MPI_VI_GetFrame()
AW_MPI_VI_ReleaseFrame()
```

非 tunnel 接收帧的逻辑：

```1033:1085:middleware/sun8iw21/media/component/VideoVirVi_Component.c
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
                        //cache frame number is enough, discard current frame.
                        eError = FAILURE;
                    }
                    else if(1 == pVideoViData->mViVirChnAttr.mCachePolicy)
                    {
                        bDiscardFlag = false;
                        //cache frame number is enough, discard old frame.
                        bNeedSendDropFrameMsg = TRUE;
                        alogv("nFrameNum=%d, VViComp DropFrame", nFrameNum);
                    }
                    else
                    {
                        aloge("fatal error! Cache Policy %d is NOT supported!", pVideoViData->mViVirChnAttr.mCachePolicy);
                    }
                }
            }
            if(!bDiscardFlag)
            {
                pthread_mutex_lock(&pVideoViData->mFrameLock);
                eError = VideoBufMgrPushFrame(pVideoViData->mpCapMgr, pFrm);
```

如果有用户正在阻塞等待帧，则唤醒：

```1075:1081:middleware/sun8iw21/media/component/VideoVirVi_Component.c
                if (pVideoViData->mWaitingCapDataFlag)
                {
                    cdx_sem_up(&pVideoViData->mSemWaitInputFrame);
                    pVideoViData->mWaitingCapDataFlag = FALSE;
                }
                pthread_mutex_unlock(&pVideoViData->mFrameLock);
```

非 tunnel 流程：

```text
VideoViEmptyThisBuffer
        │
        ├── mOutputPortTunnelFlag == FALSE
        │
        ├── 检查缓存数量
        │       │
        │       ├── mCachePolicy == 0
        │       │       └── 满了丢当前帧
        │       │
        │       └── mCachePolicy == 1
        │               └── 满了允许当前帧入队，后续线程丢旧帧
        │
        ├── VideoBufMgrPushFrame()
        │
        └── 如果用户正在 GetFrame 阻塞等待
                └── cdx_sem_up(mSemWaitInputFrame)
```

---

## 10. 用户取帧和释放：`AW_MPI_VI_GetFrame / ReleaseFrame`

非 tunnel 模式下，用户调用：

```text
AW_MPI_VI_GetFrame(ViDev, ViCh, &frame, timeout)
```

内部会调用组件的 `COMP_IndexVendorViGetFrame`，最终走到 `DoVideoViGetData()`。

取帧逻辑：

```229:267:middleware/sun8iw21/media/component/VideoVirVi_Component.c
        alogw("call getStream in wrong state[0x%x]", pVideoViData->state);
        return ERR_VI_NOT_PERM;
    }
    int ret;

    /* not support get data in Tunnel mode for app */
    if (TRUE == pVideoViData->mOutputPortTunnelFlag) {
        return ERR_VI_NOT_PERM;
    }

    /* for online, does not support get/release vipp data by user. */
    if (pVideoViData->mViAttr.mOnlineEnable) {
        return ERR_VI_NOT_PERM;
    }

    VIDEO_FRAME_INFO_S *pstFrameInfo = pstParams->pstFrameInfo;
    VIDEO_FRAME_INFO_S *tmp = NULL;
_TryToGetFrame:
    tmp = VideoBufMgrGetValidFrame(pVideoViData->mpCapMgr);
    if (NULL != tmp)
        goto GetFrmSuccess;

    if (0 == nMilliSec)
        return FAILURE;
    else if (nMilliSec < 0) {
```

关键限制：

1. **tunnel 模式下不允许用户 GetFrame**；
2. **online 模式下不允许用户 GetFrame / ReleaseFrame**；
3. `nMilliSec == 0` 表示非阻塞；
4. `nMilliSec < 0` 表示一直等；
5. `nMilliSec > 0` 表示超时等待。

释放时：

```321:345:middleware/sun8iw21/media/component/VideoVirVi_Component.c
ERRORTYPE DoVideoViReleaseData(PARAM_IN COMP_HANDLETYPE hComponent, PARAM_IN VI_Params *pstParams)
{
    VIDEOVIDATATYPE *pVideoViData = (VIDEOVIDATATYPE *)(((MM_COMPONENTTYPE *)hComponent)->pComponentPrivate);
    if (COMP_StateIdle != pVideoViData->state && COMP_StateExecuting != pVideoViData->state) {
        alogw("call releaseStream in wrong state[0x%x], but still release it", pVideoViData->state);
        //return ERR_VI_NOT_PERM;
    }
    if (TRUE == pVideoViData->mOutputPortTunnelFlag) { /* Tunnel mode */
        return ERR_VI_NOT_PERM;
    }

    /* for online, does not support get/release vipp data by user. */
    if (pVideoViData->mViAttr.mOnlineEnable) {
        return ERR_VI_NOT_PERM;
    }

    int vipp_id = pstParams->mDev;
    VIDEO_FRAME_INFO_S *pstFrameInfo = pstParams->pstFrameInfo;
    videoInputHw_RefsReduceAndRleaseData(vipp_id, pstFrameInfo);
    VideoBufMgrReleaseFrame(pVideoViData->mpCapMgr, pstFrameInfo);
```

用户模式生命周期：

```text
CapThread
  │
  ├── refs++
  └── VideoViEmptyThisBuffer()
          │
          └── VideoBufMgrPushFrame()
                  │
                  ▼
        AW_MPI_VI_GetFrame()
                  │
                  ├── VideoBufMgrGetValidFrame()
                  │       valid -> using
                  │
                  ▼
        用户处理 frame
                  │
                  ▼
        AW_MPI_VI_ReleaseFrame()
                  │
                  ├── videoInputHw_RefsReduceAndRleaseData()
                  └── VideoBufMgrReleaseFrame()
```

---

## 11. 下游归还帧：`VideoViFillThisBuffer`

tunnel 模式下，VirChn 把帧送给 VENC / VO 后，帧什么时候还给 VIPP？

答案是：**下游组件用完后，会调用 VirChn 的 `FillThisBuffer()`。**

源码：

```1110:1129:middleware/sun8iw21/media/component/VideoVirVi_Component.c
ERRORTYPE VideoViFillThisBuffer(PARAM_IN COMP_HANDLETYPE hComponent, PARAM_IN COMP_BUFFERHEADERTYPE *pBuffer)
{
    VIDEOVIDATATYPE *pVideoViData;
    ERRORTYPE eError = SUCCESS;
    int ret;

    pVideoViData = (VIDEOVIDATATYPE *) (((MM_COMPONENTTYPE*) hComponent)->pComponentPrivate);
    if (COMP_StateIdle != pVideoViData->state && COMP_StateExecuting != pVideoViData->state) 
    {
        alogw("call fillThisBuffer in wrong state[0x%x], but still release it", pVideoViData->state);
    }
    if (pBuffer->nOutputPortIndex == pVideoViData->sPortDef[VI_CHN_PORT_INDEX_OUT].nPortIndex)
    {
        VIDEO_FRAME_INFO_S *pFrm = pBuffer->pOutputPortPrivate;
        videoInputHw_RefsReduceAndRleaseData(pVideoViData->mMppChnInfo.mDevId, pFrm);
        VideoBufMgrReleaseFrame(pVideoViData->mpCapMgr, pFrm);
```

这就是 tunnel 模式的归还链路：

```text
VirChn -> VENC / VO
        │
        │ 下游用完 frame
        ▼
VENC / VO 调用 VirChn.FillThisBuffer()
        │
        ├── videoInputHw_RefsReduceAndRleaseData()
        │       refs--
        │       refs == 0 时 QBUF
        │
        └── VideoBufMgrReleaseFrame()
                using -> free
```

---

## 12. `AW_MPI_SYS_Bind`：VirChn 和 VENC / VO 是怎么连接的

### 12.1 允许的绑定关系

`mpi_sys.c` 中有绑定关系表：

```183:192:middleware/sun8iw21/media/mpi_sys.c
MppBindMap gMppBindMapTable[] =
{
    {MOD_ID_AI,         MOD_ID_AENC },  //ai    -> aenc
    {MOD_ID_AI,         MOD_ID_AO   },  //ai    -> ao
    {MOD_ID_AO,         MOD_ID_AI   },  //ao    -> ai
    {MOD_ID_AENC,       MOD_ID_MUX  },  //aenc  -> mux
    {MOD_ID_TENC,       MOD_ID_MUX  },  //tenc  -> mux
    {MOD_ID_VIU,        MOD_ID_VENC },  //vi    -> venc
    {MOD_ID_VIU,        MOD_ID_VOU  },  //vi    -> vo
    {MOD_ID_VIU,        MOD_ID_ISE  },  //vi    -> ise
```

因此 VI 可以绑定到：

```text
VI -> VENC
VI -> VO
VI -> ISE
VI -> EIS
```

---

### 12.2 获取组件句柄

绑定时，系统会根据 `MPP_CHN_S` 里的 `mModId` 找到对应组件。

VI 的组件获取方式是：

```96:102:middleware/sun8iw21/media/mpi_sys.c
#if (MPPCFG_VI == OPTION_VI_ENABLE)
		case MOD_ID_VIU:
        {
            *pComp = videoInputHw_GetChnComp(pChn->mDevId, pChn->mChnId);
            break;
        }
#endif
```

所以：

```text
MPP_CHN_S viChn = {
    .mModId = MOD_ID_VIU,
    .mDevId = ViDev,
    .mChnId = VirChn,
}
```

会被解析成：

```text
videoInputHw_GetChnComp(ViDev, VirChn)
        │
        ▼
找到 VI_CHN_MAP_S
        │
        ▼
返回 pNode->mViComp
```

---

### 12.3 端口选择

VI 作为 source 时，输出端口固定是 `VI_CHN_PORT_INDEX_OUT`：

```421:426:middleware/sun8iw21/media/mpi_sys.c
		case MOD_ID_VIU:
        {   //pDestChn->mModId =MOD_ID_VDA, MOD_ID_VENC, MOD_ID_ISE, MOD_ID_VOU
            *pSrcPortIdx = VI_CHN_PORT_INDEX_OUT;
			break;
        }
```

如果目标是 VENC，目标端口是 `0`：

```533:544:middleware/sun8iw21/media/mpi_sys.c
        case MOD_ID_VENC:
        {
            #if 0
		if(pSrcChn->mModId == MOD_ID_VIU)
		{
			*pDstPortIdx = 0;
		}
		if(pSrcChn->mModId == MOD_ID_ISE)
            {
                *pDstPortIdx = 0;
            }
```

如果目标是 VO，则目标端口是 `VDR_PORT_INDEX_VIDEO`：

```549:558:middleware/sun8iw21/media/mpi_sys.c
        case MOD_ID_VOU:
        {
            if(pSrcChn->mModId == MOD_ID_VDEC || pSrcChn->mModId == MOD_ID_VIU || pSrcChn->mModId == MOD_ID_UVC || pSrcChn->mModId == MOD_ID_ISE)
            {
                *pDstPortIdx = VDR_PORT_INDEX_VIDEO;
            }
            else if(pSrcChn->mModId == MOD_ID_CLOCK)
            {
                *pDstPortIdx = VDR_PORT_INDEX_CLOCK;
```

因此绑定过程可以抽象成：

```text
AW_MPI_SYS_Bind(src = VI, dst = VENC / VO)
        │
        ├── SYS_GetComp(src)
        │       VI -> videoInputHw_GetChnComp(ViDev, VirChn)
        │
        ├── SYS_GetComp(dst)
        │       VENC -> VENC_GetChnComp()
        │       VO   -> VO_GetChnComp()
        │
        ├── SYS_QueryBindRelation()
        │       检查 gMppBindMapTable 是否允许
        │
        ├── SYS_DecideBindPortIndex()
        │       VI source port = VI_CHN_PORT_INDEX_OUT
        │       VENC dest port = 0
        │       VO dest port   = VDR_PORT_INDEX_VIDEO
        │
        └── COMP_SetupTunnel(srcComp, srcPort, dstComp, dstPort)
                触发双方 ComponentTunnelRequest()
```

---

## 13. 为什么要多个 VirChn 才能同时给 VENC 和 VO？

因为 `VideoViComponentTunnelRequest()` 中，如果输出端口已经绑定，会拒绝再次绑定：

```760:768:middleware/sun8iw21/media/component/VideoVirVi_Component.c
    if(pPortDef->eDir == COMP_DirOutput)
    {
        if (pVideoViData->mOutputPortTunnelFlag) {
            aloge("VirVi_Comp outport already bind, why bind again?!");
            eError = FAILURE;
            goto COMP_CMD_FAIL;
        }
        pTunnelSetup->nTunnelFlags = 0;
        pTunnelSetup->eSupplier = pPortBufSupplier->eBufferSupplier;
```

也就是说，一个 VirChn 的输出端口只能有一个 tunnel 下游。

所以正确做法是：

```text
同一个 VIPP：
    ViDev = 0

创建两个 VirChn：
    VirChn 0 -> bind VENC
    VirChn 1 -> bind VO
```

应用层典型伪代码：

```c
MPP_CHN_S vi_venc = {MOD_ID_VIU,  ViDev, VirChnForVenc};
MPP_CHN_S venc    = {MOD_ID_VENC, 0,     VencChn};

MPP_CHN_S vi_vo   = {MOD_ID_VIU,  ViDev, VirChnForVo};
MPP_CHN_S vo      = {MOD_ID_VOU,  VoDev, VoChn};

AW_MPI_SYS_Bind(&vi_venc, &venc);
AW_MPI_SYS_Bind(&vi_vo,   &vo);
```

最终结构：

```text
             VIPP 0
               │
       VideoInputHw_CapThread
               │
        遍历 mChnList
               │
       ┌───────┴────────┐
       │                │
       ▼                ▼
   VirChn 0          VirChn 1
       │                │
       ▼                ▼
     VENC              VO
```

---

## 14. VirChn 的缓存策略

`VideoViEmptyThisBuffer()` 中用到了两个字段：

```text
mCacheFrameNum
mCachePolicy
```

### tunnel 模式

tunnel 模式下，如果缓存超过 `mCacheFrameNum`，直接丢当前帧：

```text
if valid_using_frame_num >= mCacheFrameNum:
    discard current frame
```

### non-tunnel 模式

非 tunnel 模式下：

```text
mCachePolicy == 0
        队列满时丢当前帧

mCachePolicy == 1
        队列满时允许当前帧入队
        后续组件线程丢旧帧
```

组件线程里对 `mCachePolicy == 1` 的旧帧丢弃逻辑：

```1554:1571:middleware/sun8iw21/media/component/VideoVirVi_Component.c
                if(pVideoViData->mViVirChnAttr.mCacheFrameNum > 0)
                {
                    if (1 == pVideoViData->mViVirChnAttr.mCachePolicy)
                    {
                        int nFrameNum = 0;
                        do
                        {
                            nFrameNum = pVideoViData->mpCapMgr->GetValidUsingFrameNum(pVideoViData->mpCapMgr);
                            alogv("nFrameNum=%d", nFrameNum);
                            if(nFrameNum <= pVideoViData->mViVirChnAttr.mCacheFrameNum)
                            {
                                break;
                            }
                            VIDEO_FRAME_INFO_S *pOldFrm = VideoBufMgrGetValidFrame(pVideoViData->mpCapMgr);
```

继续释放旧帧：

```1572:1580:middleware/sun8iw21/media/component/VideoVirVi_Component.c
                            if (pOldFrm)
                            {
                                videoInputHw_RefsReduceAndRleaseData(pVideoViData->mMppChnInfo.mDevId, pOldFrm);
                                VideoBufMgrReleaseFrame(pVideoViData->mpCapMgr, pOldFrm);
                            }
                            else
                            {
                                alogw("Be careful. too many frames[%d] out, more than [%d]cacheFrames", nFrameNum, pVideoViData->mViVirChnAttr.mCacheFrameNum);
```

---

## 15. 销毁流程：必须先回到 Idle，再从 `mChnList` 删除

销毁 VirChn 的入口是 `AW_MPI_VI_DestroyVirChn()`：

```1371:1424:middleware/sun8iw21/media/mpi_vi.c
ERRORTYPE AW_MPI_VI_DestroyVirChn(VI_DEV ViDev, VI_CHN ViCh)
{
    ERRORTYPE eRet = SUCCESS;
    VI_CHN_MAP_S *pNode;

    if ((!(ViDev >= 0 && ViDev < VI_VIPP_NUM_MAX)) ||
        (!(ViCh >= 0 && ViCh < VI_VIRCHN_NUM_MAX))){
        aloge("fatal error! invalid ViDev[%d], ViVirChn[%d]!", ViDev, ViCh);
        return ERR_VI_INVALID_CHNID;
    }
    if (SUCCESS != videoInputHw_searchExistDevVirChn(ViDev, ViCh, &pNode)) {
        alogw("vipp[%d]vichn[%d] is unexist!!\n", ViDev, ViCh);
        return ERR_VI_UNEXIST;
    }

    if (pNode->mViComp) {
        COMP_STATETYPE nCompState;
        if (SUCCESS == pNode->mViComp->GetState(pNode->mViComp, &nCompState)) {
            if (nCompState == COMP_StateIdle) {
```

销毁流程：

```text
AW_MPI_VI_DestroyVirChn
        │
        ├── 查找 VI_CHN_MAP_S
        │
        ├── 检查组件状态
        │
        ├── 只有 Idle / Loaded / Invalid 可以继续
        │
        ├── 如果 Idle：
        │       SendCommand(StateSet, Loaded)
        │       等待 mSemCompCmd
        │
        ├── videoInputHw_removeChannel()
        │       从 VIPP 的 mChnList 删除
        │
        ├── COMP_FreeHandle()
        │       触发 VideoViComponentDeInit
        │       停组件线程
        │       销毁 mpCapMgr
        │
        └── videoInputHw_CHN_MAP_S_Destruct()
```

注意：如果 VirChn 还在 `Executing`，销毁会认为 busy。因此一般顺序是：

```text
AW_MPI_VI_DisableVirChn()
AW_MPI_VI_DestroyVirChn()
```

而 `DisableVipp` 时，代码还要求该 VIPP 下不能再有 VirChn：

```6225:6232:middleware/sun8iw21/media/videoIn/videoInputHw.c
                list_for_each(pList, &pVipp->mChnList) { cnt++;}
                if(cnt > 0)
                {
                    aloge("fatal error! there is [%d] vir channel exist in vipp[%d], must destroy them first!", cnt, nVipp);
                    cmdRet = ERR_VI_NOT_PERM;
                    pthread_mutex_unlock(&pVipp->mLock);
                    pthread_mutex_unlock(&gpVIDevManager->mManagerLock);
```

所以推荐销毁顺序：

```text
解绑 SYS_Bind
        │
        ▼
DisableVirChn
        │
        ▼
DestroyVirChn
        │
        ▼
DisableVipp
```

---

## 16. online 模式特殊点

源码中有一处重要判断：

```1539:1546:middleware/sun8iw21/media/component/VideoVirVi_Component.c
            /* For online, csi&ve driver transfer data directly, and virvi channel does not need to process data. */
            if (0 != pVideoViData->mViAttr.mOnlineEnable)
            {
                TMessage_WaitQueueNotEmpty(&pVideoViData->cmd_queue, 0);
                goto PROCESS_MESSAGE;
            }

            /* For offline. */
```

也就是说：

- **offline 模式**：VIPP 帧由用户态 CapThread `DQBUF` 后分发到 VirChn；
- **online 模式**：CSI/VIPP 到 VE 可能是驱动层直连，VirChn 组件线程本身不做普通取帧处理；
- `AW_MPI_VI_GetFrame / ReleaseFrame` 也明确禁止 online 模式使用。

因此本文上面的“广播 + refs 引用计数”主要对应普通 offline 采集路径。

---

## 17. 总结：VirChn 的本质

可以把 VirChn 理解成 MPP 在用户态实现的一个“帧引用分发器”：

```text
VirChn =
    一个 VideoVirVi_Component 实例
    +
    一个独立的 mpCapMgr 帧队列
    +
    一个 output tunnel 连接
    +
    一套状态机
    +
    对 VIPP DMA buffer 的引用
```

它不复制 YUV 数据，而是共享同一个 `VIDEO_FRAME_INFO_S` / DMA buffer，通过引用计数保证生命周期安全。

最终核心机制可以浓缩成下面这张图：

```text
                 ┌──────────────────────┐
                 │      Sensor / ISP      │
                 └───────────┬──────────┘
                             │
                             ▼
                 ┌──────────────────────┐
                 │   VIPP /dev/videoX    │
                 │   DMA buffer queue    │
                 └───────────┬──────────┘
                             │ DQBUF
                             ▼
                 ┌──────────────────────┐
                 │ VideoInputHw_CapThread│
                 └───────────┬──────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
        refs[id]++      refs[id]++      refs[id]++
              │              │              │
              ▼              ▼              ▼
        ┌─────────┐    ┌─────────┐    ┌─────────┐
        │VirChn 0 │    │VirChn 1 │    │VirChn 2 │
        └────┬────┘    └────┬────┘    └────┬────┘
             │              │              │
             ▼              ▼              ▼
           VENC             VO          GetFrame
             │              │              │
             ▼              ▼              ▼
        refs[id]--     refs[id]--     refs[id]--
              │              │              │
              └──────────────┴──────────────┘
                             │
                             ▼
                       refs[id] == 0 ?
                             │
                             ▼
                            QBUF
                             │
                             ▼
                    buffer 回到 VIPP 队列
```

一句话概括：

**VirChn 的实现方式是：同一 VIPP 只采集一次帧，用户态根据该 VIPP 的 VirChn 链表做 fan-out 分发；每个 VirChn 维护自己的帧队列和 tunnel 下游；底层 DMA buffer 通过 `refs[mId]` 引用计数共享，最后一个消费者释放时才还给内核。**

