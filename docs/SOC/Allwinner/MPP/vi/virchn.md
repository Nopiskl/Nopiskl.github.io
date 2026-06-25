
---

**User**

帮我结合全志VIN框架分析一下VirChn是怎么实现的？

---

**Cursor**

我来深入分析 VirChn 的实现机制，需要查看组件实现和相关内核侧的 VIPP 缩放逻辑。

现在我已经有了完整的信息，可以给出深入详细的 VirChn 实现分析。

---

## VirChn 实现深度分析

### 一、架构总览

VirChn（虚拟通道）的本质是：**一个内核 VIPP 设备节点（`/dev/videoX`）的物理帧，通过引用计数机制，被多个 OpenMAX IL 组件（`VideoVirVi_Component`）并发消费**，每个组件独立管理自己的帧队列和下游 tunnel 连接。

```
            内核: /dev/video0 (VIPP 0, 1080P ISP输出)
                        │
                        │ ioctl(VIDIOC_DQBUF) 
                        ▼
              VideoInputHw_CapThread (全局唯一采集线程)
                        │
              stFrameInfo.mId = buffer.index  (帧ID = DMA buffer slot)
              refs[mId]++ for each VirChn
                        │
         ┌──────────────┼──────────────┐
         │              │              │
         ▼              ▼              ▼
   VirChn 0         VirChn 1      VirChn 2
COMP_EmptyThisBuffer → VideoViEmptyThisBuffer()
   mpCapMgr           mpCapMgr      mpCapMgr
  (帧FIFO队列)        (帧FIFO队列)   (帧FIFO队列)
         │              │              │
   用户GetFrame    下游Venc组件   下游VO组件
   (非Tunnel)      (Tunnel模式)   (Tunnel模式)
         │              │              │
   ReleaseFrame   FillThisBuffer  FillThisBuffer
         └──────────────┴──────────────┘
                        │
              refs[mId]-- (每次归还)
              refs==0时: ioctl(VIDIOC_QBUF) 归还内核
```

---

### 二、关键数据结构

#### 2.1 `VIDEOVIDATATYPE`（每个 VirChn 的私有数据）

```c
// VideoVirVi_Component.c 第54~100行
typedef struct awVIDEOVIDATATYPE {
    COMP_STATETYPE state;             // OMX 状态机
    pthread_mutex_t mStateLock;

    bool mInputPortTunnelFlag;        // 输入端是否为 tunnel 模式
    bool mOutputPortTunnelFlag;       // 输出端是否为 tunnel 模式（→ Venc/VO）

    MPP_CHN_S mMppChnInfo;           // {ModId=VIU, DevId=vipp_id, ChnId=virChn}
    VI_ATTR_S mViAttr;               // 继承自 VIPP 的硬件属性
    ViVirChnAttrS mViVirChnAttr;     // VirChn 独有属性（缓存帧数/策略）

    VideoBufferManager *mpCapMgr;     // 帧 FIFO 队列管理器
    pthread_mutex_t mFrameLock;
    cdx_sem_t mSemWaitInputFrame;     // 等待新帧的信号量

    pthread_t thread_id;             // Vi_ComponentThread 线程
    message_queue_t cmd_queue;       // 组件命令队列（状态切换等）
} VIDEOVIDATATYPE;
```

#### 2.2 `viChnManager`（每个 VIPP 的管理结构，在 `videoInputHw.h` 中）

```c
// VIPP级别的全局状态
viChnManager {
    struct list_head mChnList;         // 所有 VirChn 组件链表
    int refs[32];                      // 每个 DMA buffer slot 的引用计数
    VIDEO_FRAME_INFO_S VideoFrameInfo[32]; // 每个 slot 的帧信息副本
    struct list_head mIdleFrameList;   // 空闲 VippFrame 节点
    struct list_head mReadyFrameList;  // 已采集待处理的 VippFrame 节点
    pthread_mutex_t mRefsLock;
    pthread_mutex_t mFrameListLock;
    pthread_mutex_t mLock;             // 保护 mChnList
}
```

---

### 三、VirChn 创建流程

```c
// mpi_vi.c: AW_MPI_VI_CreateVirChn(ViDev=0, ViCh=0, &stChnAttr)

// 1. 分配 VI_CHN_MAP_S 节点（代表一个 VirChn 句柄）
pNode = videoInputHw_CHN_MAP_S_Construct();
pNode->mViChn = (ViDev<<16) | ViCh;   // 编码为 32bit: 高16=VIPP, 低16=Chn

// 2. 创建 OMX 组件（CDX_ComponentNameViScale）
COMP_GetHandle(&pNode->mViComp, CDX_ComponentNameViScale, pNode, &VideoViCallback);
// 内部: 分配 VIDEOVIDATATYPE, 初始化 mpCapMgr (VI_FIFO_LEVEL深度的FIFO)
// 内部: 启动 Vi_ComponentThread

// 3. 配置组件
COMP_SetConfig(pNode->mViComp, COMP_IndexVendorMPPChannelInfo, &ChannelInfo);
COMP_SetConfig(pNode->mViComp, COMP_IndexVendorViDevAttr, &stAttr);   // VIPP属性
COMP_SetConfig(pNode->mViComp, COMP_IndexVendorViChnAttr, pAttr);     // VirChn属性

// 4. 组件进入 Idle 状态
COMP_SendCommand(pNode->mViComp, COMP_CommandStateSet, COMP_StateIdle, NULL);
cdx_sem_down(&pNode->mSemCompCmd);  // 等待完成

// 5. 挂入 VIPP 的 mChnList
videoInputHw_addChannel(ViDev, pNode);
// gpVIDevManager->gpVippManager[vipp_id]->mChnList 链表增加此节点
```

---

### 四、帧分发：CapThread → 多路 VirChn

这是整个 VirChn 机制最核心的部分，位于 `videoInputHw.c` 第 6563 行附近：

```c
// VideoInputHw_CapThread 采集到帧后：

// Step 1: 检查该 DMA buffer slot 是否已被占用
if (0 == pVippInfo->refs[stFrameInfo.mId])
{
    if (!list_empty(&pVippInfo->mChnList))
    {
        // Step 2: 先整体+1（防止遍历中归零）
        videoInputHw_RefsIncrease(nVippIndex, &stFrameInfo);

        // Step 3: 遍历所有 VirChn，每个 +1 后推送
        list_for_each_entry(pEntry, &pVippInfo->mChnList, mList)
        {
            memcpy(&pVippInfo->VideoFrameInfo[stFrameInfo.mId],
                   &stFrameInfo, sizeof(stFrameInfo));

            COMP_BUFFERHEADERTYPE bufferHeader;
            bufferHeader.nInputPortIndex = VI_CHN_PORT_INDEX_CAP_IN;
            bufferHeader.pOutputPortPrivate = &stFrameInfo;

            videoInputHw_RefsIncrease(nVippIndex, &stFrameInfo); // refs++
            ERRORTYPE ret2 = COMP_EmptyThisBuffer(pEntry->mViComp, &bufferHeader);
            if (ret2 != SUCCESS) {
                videoInputHw_RefsReduceAndRleaseData(nVippIndex, &stFrameInfo); // refs--
            }
        }

        // Step 4: 抵消 Step 2 的整体+1
        videoInputHw_RefsReduceAndRleaseData(nVippIndex, &stFrameInfo);
    }
}
```

**引用计数逻辑**（`videoInputHw.c` 第 6129~6155 行）：

```c
// refs++ (线程安全)
static ERRORTYPE videoInputHw_RefsIncrease(int vipp_id, VIDEO_FRAME_INFO_S *pstFrameInfo)
{
    pthread_mutex_lock(&gpVIDevManager->gpVippManager[vipp_id]->mRefsLock);
    gpVIDevManager->gpVippManager[vipp_id]->refs[pstFrameInfo->mId]++;
    pthread_mutex_unlock(&gpVIDevManager->gpVippManager[vipp_id]->mRefsLock);
    return SUCCESS;
}

// refs-- , 归零时归还内核
ERRORTYPE videoInputHw_RefsReduceAndRleaseData(int vipp_id, VIDEO_FRAME_INFO_S *pstFrameInfo)
{
    int refs = 0;
    pthread_mutex_lock(&gpVIDevManager->gpVippManager[vipp_id]->mRefsLock);
    gpVIDevManager->gpVippManager[vipp_id]->refs[pstFrameInfo->mId]--;
    refs = gpVIDevManager->gpVippManager[vipp_id]->refs[pstFrameInfo->mId];
    pthread_mutex_unlock(&gpVIDevManager->gpVippManager[vipp_id]->mRefsLock);

    if (0 == refs) {
        // 所有 VirChn 都归还了，调用 ioctl(VIDIOC_QBUF) 还给内核
        videoInputHw_ReleaseData(vipp_id, pstFrameInfo);
    }
    return ret;
}
```

---

### 五、VirChn 内部帧处理（`VideoViEmptyThisBuffer`）

`COMP_EmptyThisBuffer` 最终调用到 `VideoViEmptyThisBuffer`（第 815 行），这是每个 VirChn 组件接收帧的入口：

```
VideoViEmptyThisBuffer(hComponent, pBuffer)
  │
  ├── 状态检查（必须 Idle 或 Executing）
  ├── mViVirChnAttr.mbRecvInIdleState 控制 Idle 时是否接收
  │
  ├── [缓存溢出策略]
  │   mViVirChnAttr.mCacheFrameNum > 0 时：
  │   ├── Policy=0: 丢弃新帧（drop current）
  │   └── Policy=1: 丢弃最旧帧（drop oldest，LIFO语义）
  │
  ├── VideoBufMgrPushFrame(mpCapMgr, pFrm)  // 入队
  │
  └── [分两路]
      ├── Tunnel 模式（→ Venc/VO）：
      │   VideoBufMgrGetValidFrame() 取帧
      │   COMP_EmptyThisBuffer(pOutTunnelComp, &obh)  // 推给下游
      │   失败时: VideoBufMgrReleaseFrame() 归还
      │
      └── 非 Tunnel 模式（用户 GetFrame）：
          cdx_sem_up(&mSemWaitInputFrame)  // 唤醒等待的 GetFrame 调用
```

---

### 六、与内核 VIPP 的关系

在内核侧，**每个 `VI_DEV`（VIPP 编号）对应一个独立的 V4L2 video 节点**（`/dev/video0`、`/dev/video4` 等），每个节点有自己独立的 DMA buffer 队列和 

```plaintext
            内核: /dev/video0 (VIPP 0, 1080P ISP输出)
                        │
                        │ ioctl(VIDIOC_DQBUF) 
                        ▼
              VideoInputHw_CapThread (全局唯一采集线程)
                        │
              stFrameInfo.mId = buffer.index  (帧ID = DMA buffer slot)
              refs[mId]++ for each VirChn
                        │
         ┌──────────────┼──────────────┐
         │              │              │
         ▼              ▼              ▼
   VirChn 0         VirChn 1      VirChn 2
COMP_EmptyThisBuffer → VideoViEmptyThisBuffer()
   mpCapMgr           mpCapMgr      mpCapMgr
  (帧FIFO队列)        (帧FIFO队列)   (帧FIFO队列)
         │              │              │
   用户GetFrame    下游Venc组件   下游VO组件
   (非Tunnel)      (Tunnel模式)   (Tunnel模式)
         │              │              │
   ReleaseFrame   FillThisBuffer  FillThisBuffer
         └──────────────┴──────────────┘
                        │
              refs[mId]-- (每次归还)
              refs==0时: ioctl(VIDIOC_QBUF) 归还内核
```

```c
// VideoVirVi_Component.c 第54~100行
typedef struct awVIDEOVIDATATYPE {
    COMP_STATETYPE state;             // OMX 状态机
    pthread_mutex_t mStateLock;

    bool mInputPortTunnelFlag;        // 输入端是否为 tunnel 模式
    bool mOutputPortTunnelFlag;       // 输出端是否为 tunnel 模式（→ Venc/VO）

    MPP_CHN_S mMppChnInfo;           // {ModId=VIU, DevId=vipp_id, ChnId=virChn}
    VI_ATTR_S mViAttr;               // 继承自 VIPP 的硬件属性
    ViVirChnAttrS mViVirChnAttr;     // VirChn 独有属性（缓存帧数/策略）

    VideoBufferManager *mpCapMgr;     // 帧 FIFO 队列管理器
    pthread_mutex_t mFrameLock;
    cdx_sem_t mSemWaitInputFrame;     // 等待新帧的信号量

    pthread_t thread_id;             // Vi_ComponentThread 线程
    message_queue_t cmd_queue;       // 组件命令队列（状态切换等）
} VIDEOVIDATATYPE;
```

```c
// VIPP级别的全局状态
viChnManager {
    struct list_head mChnList;         // 所有 VirChn 组件链表
    int refs[32];                      // 每个 DMA buffer slot 的引用计数
    VIDEO_FRAME_INFO_S VideoFrameInfo[32]; // 每个 slot 的帧信息副本
    struct list_head mIdleFrameList;   // 空闲 VippFrame 节点
    struct list_head mReadyFrameList;  // 已采集待处理的 VippFrame 节点
    pthread_mutex_t mRefsLock;
    pthread_mutex_t mFrameListLock;
    pthread_mutex_t mLock;             // 保护 mChnList
}
```

```c
// mpi_vi.c: AW_MPI_VI_CreateVirChn(ViDev=0, ViCh=0, &stChnAttr)

// 1. 分配 VI_CHN_MAP_S 节点（代表一个 VirChn 句柄）
pNode = videoInputHw_CHN_MAP_S_Construct();
pNode->mViChn = (ViDev<<16) | ViCh;   // 编码为 32bit: 高16=VIPP, 低16=Chn

// 2. 创建 OMX 组件（CDX_ComponentNameViScale）
COMP_GetHandle(&pNode->mViComp, CDX_ComponentNameViScale, pNode, &VideoViCallback);
// 内部: 分配 VIDEOVIDATATYPE, 初始化 mpCapMgr (VI_FIFO_LEVEL深度的FIFO)
// 内部: 启动 Vi_ComponentThread

// 3. 配置组件
COMP_SetConfig(pNode->mViComp, COMP_IndexVendorMPPChannelInfo, &ChannelInfo);
COMP_SetConfig(pNode->mViComp, COMP_IndexVendorViDevAttr, &stAttr);   // VIPP属性
COMP_SetConfig(pNode->mViComp, COMP_IndexVendorViChnAttr, pAttr);     // VirChn属性

// 4. 组件进入 Idle 状态
COMP_SendCommand(pNode->mViComp, COMP_CommandStateSet, COMP_StateIdle, NULL);
cdx_sem_down(&pNode->mSemCompCmd);  // 等待完成

// 5. 挂入 VIPP 的 mChnList
videoInputHw_addChannel(ViDev, pNode);
// gpVIDevManager->gpVippManager[vipp_id]->mChnList 链表增加此节点
```

```c
// VideoInputHw_CapThread 采集到帧后：

// Step 1: 检查该 DMA buffer slot 是否已被占用
if (0 == pVippInfo->refs[stFrameInfo.mId])
{
    if (!list_empty(&pVippInfo->mChnList))
    {
        // Step 2: 先整体+1（防止遍历中归零）
        videoInputHw_RefsIncrease(nVippIndex, &stFrameInfo);

        // Step 3: 遍历所有 VirChn，每个 +1 后推送
        list_for_each_entry(pEntry, &pVippInfo->mChnList, mList)
        {
            memcpy(&pVippInfo->VideoFrameInfo[stFrameInfo.mId],
                   &stFrameInfo, sizeof(stFrameInfo));

            COMP_BUFFERHEADERTYPE bufferHeader;
            bufferHeader.nInputPortIndex = VI_CHN_PORT_INDEX_CAP_IN;
            bufferHeader.pOutputPortPrivate = &stFrameInfo;

            videoInputHw_RefsIncrease(nVippIndex, &stFrameInfo); // refs++
            ERRORTYPE ret2 = COMP_EmptyThisBuffer(pEntry->mViComp, &bufferHeader);
            if (ret2 != SUCCESS) {
                videoInputHw_RefsReduceAndRleaseData(nVippIndex, &stFrameInfo); // refs--
            }
        }

        // Step 4: 抵消 Step 2 的整体+1
        videoInputHw_RefsReduceAndRleaseData(nVippIndex, &stFrameInfo);
    }
}
```

```c
// refs++ (线程安全)
static ERRORTYPE videoInputHw_RefsIncrease(int vipp_id, VIDEO_FRAME_INFO_S *pstFrameInfo)
{
    pthread_mutex_lock(&gpVIDevManager->gpVippManager[vipp_id]->mRefsLock);
    gpVIDevManager->gpVippManager[vipp_id]->refs[pstFrameInfo->mId]++;
    pthread_mutex_unlock(&gpVIDevManager->gpVippManager[vipp_id]->mRefsLock);
    return SUCCESS;
}

// refs-- , 归零时归还内核
ERRORTYPE videoInputHw_RefsReduceAndRleaseData(int vipp_id, VIDEO_FRAME_INFO_S *pstFrameInfo)
{
    int refs = 0;
    pthread_mutex_lock(&gpVIDevManager->gpVippManager[vipp_id]->mRefsLock);
    gpVIDevManager->gpVippManager[vipp_id]->refs[pstFrameInfo->mId]--;
    refs = gpVIDevManager->gpVippManager[vipp_id]->refs[pstFrameInfo->mId];
    pthread_mutex_unlock(&gpVIDevManager->gpVippManager[vipp_id]->mRefsLock);

    if (0 == refs) {
        // 所有 VirChn 都归还了，调用 ioctl(VIDIOC_QBUF) 还给内核
        videoInputHw_ReleaseData(vipp_id, pstFrameInfo);
    }
    return ret;
}
```

```plaintext
VideoViEmptyThisBuffer(hComponent, pBuffer)
  │
  ├── 状态检查（必须 Idle 或 Executing）
  ├── mViVirChnAttr.mbRecvInIdleState 控制 Idle 时是否接收
  │
  ├── [缓存溢出策略]
  │   mViVirChnAttr.mCacheFrameNum > 0 时：
  │   ├── Policy=0: 丢弃新帧（drop current）
  │   └── Policy=1: 丢弃最旧帧（drop oldest，LIFO语义）
  │
  ├── VideoBufMgrPushFrame(mpCapMgr, pFrm)  // 入队
  │
  └── [分两路]
      ├── Tunnel 模式（→ Venc/VO）：
      │   VideoBufMgrGetValidFrame() 取帧
      │   COMP_EmptyThisBuffer(pOutTunnelComp, &obh)  // 推给下游
      │   失败时: VideoBufMgrReleaseFrame() 归还
      │
      └── 非 Tunnel 模式（用户 GetFrame）：
          cdx_sem_up(&mSemWaitInputFrame)  // 唤醒等待的 GetFrame 调用
```

---

**User**

怎么实现一个sensor输出的图像能同时给到venc和vo等的？他们是怎么连接的

---

**Cursor**

现在我已经掌握了完整的连接机制，可以给出详细分析。

---

## Sensor → VirChn → Venc/VO 的连接机制

### 一、完整连接链路图

```
Sensor（/dev/videoX 内核驱动）
        │  ioctl VIDIOC_DQBUF（DMA 帧）
        ▼
  CapThread（全局采集线程）
        │  refs计数广播给所有 VirChn
        │
   ┌────┴────────────────────┐
   │                         │
   ▼                         ▼
VirChn 0（OMX组件）       VirChn 1（OMX组件）
mOutputPortTunnelFlag=TRUE  mOutputPortTunnelFlag=TRUE
sPortTunnelInfo[OUT].hTunnel=VencComp  sPortTunnelInfo[OUT].hTunnel=VOComp
        │                         │
   COMP_EmptyThisBuffer()    COMP_EmptyThisBuffer()
        │                         │
        ▼                         ▼
   Venc 组件               VO 组件
（H264编码→Mux→文件）    （显示输出）
```

---

### 二、连接的三个关键步骤

#### Step 1：用户调用 `AW_MPI_SYS_Bind()`

```c
// sample_smartIPC_demo.c
MPP_CHN_S ViChn  = {MOD_ID_VIU,  mVipp,    mViChn};    // {模块ID, VIPP号, VirChn号}
MPP_CHN_S VeChn  = {MOD_ID_VENC, 0,        mVEncChn};  // {模块ID, 设备号, 编码通道}
AW_MPI_SYS_Bind(&ViChn, &VeChn);
```

#### Step 2：`AW_MPI_SYS_Bind` 内部流程

```c
// mpi_sys.c
ERRORTYPE AW_MPI_SYS_Bind(MPP_CHN_S* pSrcChn, MPP_CHN_S* pDestChn)
{
    // 1. 按 ModId 查找对应的 OMX 组件指针
    SYS_GetComp(pSrcChn, &pSrcComp);   
    // MOD_ID_VIU → videoInputHw_GetChnComp(vipp_id, virChn_id) → VI_CHN_MAP_S.mViComp

    SYS_GetComp(pDestChn, &pDstComp);  
    // MOD_ID_VENC → VENC_GetChnComp(pChn) → VencComp

    // 2. 查合法性表（白名单）
    SYS_QueryBindRelation(pSrcChn, pDestChn);
    // 查 gMppBindMapTable: {MOD_ID_VIU, MOD_ID_VENC} ✓ 合法

    // 3. 决定端口号
    SYS_DecideBindPortIndex(pSrcChn, pDestChn, &srcPortIdx, &dstPortIdx, NULL);
    // VI 的输出端口: VI_CHN_PORT_INDEX_OUT
    // Venc 的输入端口: 0

    // 4. 建立 tunnel 连接
    COMP_SetupTunnel(pSrcComp, srcPortIdx, pDstComp, dstPortIdx);
}
```

#### Step 3：`COMP_SetupTunnel` 握手协议

```c
// mm_component.c
ERRORTYPE COMP_SetupTunnel(hOutput, nPortOutput, hInput, nPortInput)
{
    // 第一次握手: 通知输出端（VirChn）记录下游组件
    hOutput->ComponentTunnelRequest(
        hOutput,        // VirChn 组件
        nPortOutput,    // VI_CHN_PORT_INDEX_OUT
        hInput,         // Venc 组件指针
        nPortInput,     // 0
        &oTunnelSetup   // 输出端填写能力信息
    );
    // 结果: pVideoViData->sPortTunnelInfo[OUT].hTunnel = VencComp
    //       pVideoViData->mOutputPortTunnelFlag = TRUE

    // 第二次握手: 通知输入端（Venc）记录上游组件
    hInput->ComponentTunnelRequest(
        hInput,         // Venc 组件
        nPortInput,     // 0
        hOutput,        // VirChn 组件指针
        nPortOutput,    // VI_CHN_PORT_INDEX_OUT
        &oTunnelSetup   // 输入端验证能力匹配
    );
    // 结果: VencComp 内部记录上游 = VirChn
}
```

---

### 三、合法绑定关系白名单

`gMppBindMapTable` 定义了所有允许的连接关系：

```c
// mpi_sys.c
MppBindMap gMppBindMapTable[] = {
    {MOD_ID_VIU,   MOD_ID_VENC},  // VI → 视频编码
    {MOD_ID_VIU,   MOD_ID_VOU },  // VI → 视频输出显示
    {MOD_ID_VIU,   MOD_ID_ISE },  // VI → 图像拼接
    {MOD_ID_VIU,   MOD_ID_EIS },  // VI → 电子防抖
    {MOD_ID_ISE,   MOD_ID_VENC},  // 拼接 → 编码
    {MOD_ID_EIS,   MOD_ID_VENC},  // 防抖 → 编码
    {MOD_ID_VENC,  MOD_ID_MUX },  // 编码 → 封装（写文件）
    {MOD_ID_VDEC,  MOD_ID_VOU },  // 解码 → 显示
    ...
};
```

---

### 四、一个 Sensor 同时给 Venc 和 VO 的方法

利用**多个 VirChn** + 各自独立 Bind 实现：

```c
// 同一 VIPP（同一 ISP 输出）创建两个虚拟通道
AW_MPI_VI_CreateVirChn(VIPP=0, VirChn=0, NULL);  // 主码流 1080P
AW_MPI_VI_CreateVirChn(VIPP=0, VirChn=1, NULL);  // 预览流 720P

// VirChn 0 → Venc（H264编码）
MPP_CHN_S ViChn0  = {MOD_ID_VIU,  0, 0};
MPP_CHN_S VencChn = {MOD_ID_VENC, 0, 0};
AW_MPI_SYS_Bind(&ViChn0, &VencChn);
// 内部: VirChn0.sPortTunnelInfo[OUT].hTunnel = VencComp

// VirChn 1 → VO（显示）
MPP_CHN_S ViChn1 = {MOD_ID_VIU, 0, 1};
MPP_CHN_S VoChn  = {MOD_ID_VOU, 0, 0};
AW_MPI_SYS_Bind(&ViChn1, &VoChn);
// 内部: VirChn1.sPortTunnelInfo[OUT].hTunnel = VOComp
```

运行时数据流：
```
CapThread DQBUF → 一帧数据
    refs[frameId] = 2  (有两个 VirChn 引用)
    ├── COMP_EmptyThisBuffer(VirChn0) → VideoViEmptyThisBuffer()
    │       └── mOutputPortTunnelFlag=TRUE → COMP_EmptyThisBuffer(VencComp)  ← 零拷贝
    │               Venc 编码完成 → FillThisBuffer 回调 → refs[frameId]--
    │
    └── COMP_EmptyThisBuffer(VirChn1) → VideoViEmptyThisBuffer()
            └── mOutputPortTunnelFlag=TRUE → COMP_EmptyThisBuffer(VOComp)   ← 零拷贝
                    VO 显示完成 → FillThisBuffer 回调 → refs[frameId]--

    refs[frameId] == 0 → videoInputHw_ReleaseData() → ioctl(VIDIOC_QBUF) 归还内核
```

---

### 五、smartIPC 的典型 pipeline（主+子+NNA）

```
ISP 0
 ├── VIPP 0 (1080P 主码流)
 │    └── VirChn 0 ──Bind──→ Venc 0 ──Bind──→ Mux → RTSP/文件
 │
 ├── VIPP 4 (720P 子码流)
 │    └── VirChn 0 ──Bind──→ Venc 1 ──Bind──→ Mux → RTSP
 │
 └── VIPP 8 (416x416 NNA输入)
      └── VirChn 0 ──(非Tunnel/GetFrame)──→ AI推理（人脸/人形检测）
```

这正是 `Readme.txt` 中 `main_vipp=0 / sub_vipp=4 / nna_vipp=8` 配置的底层实现：每个 VIPP 对应独立的 V4L2 video 节点，同一 ISP 提供 RAW 数据，各自缩放到不同分辨率，通过 Bind 机制以**零拷贝 Tunnel 模式**连接到下游编码/显示/AI 模块。

```plaintext
Sensor（/dev/videoX 内核驱动）
        │  ioctl VIDIOC_DQBUF（DMA 帧）
        ▼
  CapThread（全局采集线程）
        │  refs计数广播给所有 VirChn
        │
   ┌────┴────────────────────┐
   │                         │
   ▼                         ▼
VirChn 0（OMX组件）       VirChn 1（OMX组件）
mOutputPortTunnelFlag=TRUE  mOutputPortTunnelFlag=TRUE
sPortTunnelInfo[OUT].hTunnel=VencComp  sPortTunnelInfo[OUT].hTunnel=VOComp
        │                         │
   COMP_EmptyThisBuffer()    COMP_EmptyThisBuffer()
        │                         │
        ▼                         ▼
   Venc 组件               VO 组件
（H264编码→Mux→文件）    （显示输出）
```

```c
// sample_smartIPC_demo.c
MPP_CHN_S ViChn  = {MOD_ID_VIU,  mVipp,    mViChn};    // {模块ID, VIPP号, VirChn号}
MPP_CHN_S VeChn  = {MOD_ID_VENC, 0,        mVEncChn};  // {模块ID, 设备号, 编码通道}
AW_MPI_SYS_Bind(&ViChn, &VeChn);
```

```c
// mpi_sys.c
ERRORTYPE AW_MPI_SYS_Bind(MPP_CHN_S* pSrcChn, MPP_CHN_S* pDestChn)
{
    // 1. 按 ModId 查找对应的 OMX 组件指针
    SYS_GetComp(pSrcChn, &pSrcComp);   
    // MOD_ID_VIU → videoInputHw_GetChnComp(vipp_id, virChn_id) → VI_CHN_MAP_S.mViComp

    SYS_GetComp(pDestChn, &pDstComp);  
    // MOD_ID_VENC → VENC_GetChnComp(pChn) → VencComp

    // 2. 查合法性表（白名单）
    SYS_QueryBindRelation(pSrcChn, pDestChn);
    // 查 gMppBindMapTable: {MOD_ID_VIU, MOD_ID_VENC} ✓ 合法

    // 3. 决定端口号
    SYS_DecideBindPortIndex(pSrcChn, pDestChn, &srcPortIdx, &dstPortIdx, NULL);
    // VI 的输出端口: VI_CHN_PORT_INDEX_OUT
    // Venc 的输入端口: 0

    // 4. 建立 tunnel 连接
    COMP_SetupTunnel(pSrcComp, srcPortIdx, pDstComp, dstPortIdx);
}
```

```c
// mm_component.c
ERRORTYPE COMP_SetupTunnel(hOutput, nPortOutput, hInput, nPortInput)
{
    // 第一次握手: 通知输出端（VirChn）记录下游组件
    hOutput->ComponentTunnelRequest(
        hOutput,        // VirChn 组件
        nPortOutput,    // VI_CHN_PORT_INDEX_OUT
        hInput,         // Venc 组件指针
        nPortInput,     // 0
        &oTunnelSetup   // 输出端填写能力信息
    );
    // 结果: pVideoViData->sPortTunnelInfo[OUT].hTunnel = VencComp
    //       pVideoViData->mOutputPortTunnelFlag = TRUE

    // 第二次握手: 通知输入端（Venc）记录上游组件
    hInput->ComponentTunnelRequest(
        hInput,         // Venc 组件
        nPortInput,     // 0
        hOutput,        // VirChn 组件指针
        nPortOutput,    // VI_CHN_PORT_INDEX_OUT
        &oTunnelSetup   // 输入端验证能力匹配
    );
    // 结果: VencComp 内部记录上游 = VirChn
}
```

```c
// mpi_sys.c
MppBindMap gMppBindMapTable[] = {
    {MOD_ID_VIU,   MOD_ID_VENC},  // VI → 视频编码
    {MOD_ID_VIU,   MOD_ID_VOU },  // VI → 视频输出显示
    {MOD_ID_VIU,   MOD_ID_ISE },  // VI → 图像拼接
    {MOD_ID_VIU,   MOD_ID_EIS },  // VI → 电子防抖
    {MOD_ID_ISE,   MOD_ID_VENC},  // 拼接 → 编码
    {MOD_ID_EIS,   MOD_ID_VENC},  // 防抖 → 编码
    {MOD_ID_VENC,  MOD_ID_MUX },  // 编码 → 封装（写文件）
    {MOD_ID_VDEC,  MOD_ID_VOU },  // 解码 → 显示
    ...
};
```

```c
// 同一 VIPP（同一 ISP 输出）创建两个虚拟通道
AW_MPI_VI_CreateVirChn(VIPP=0, VirChn=0, NULL);  // 主码流 1080P
AW_MPI_VI_CreateVirChn(VIPP=0, VirChn=1, NULL);  // 预览流 720P

// VirChn 0 → Venc（H264编码）
MPP_CHN_S ViChn0  = {MOD_ID_VIU,  0, 0};
MPP_CHN_S VencChn = {MOD_ID_VENC, 0, 0};
AW_MPI_SYS_Bind(&ViChn0, &VencChn);
// 内部: VirChn0.sPortTunnelInfo[OUT].hTunnel = VencComp

// VirChn 1 → VO（显示）
MPP_CHN_S ViChn1 = {MOD_ID_VIU, 0, 1};
MPP_CHN_S VoChn  = {MOD_ID_VOU, 0, 0};
AW_MPI_SYS_Bind(&ViChn1, &VoChn);
// 内部: VirChn1.sPortTunnelInfo[OUT].hTunnel = VOComp
```

```plaintext
CapThread DQBUF → 一帧数据
    refs[frameId] = 2  (有两个 VirChn 引用)
    ├── COMP_EmptyThisBuffer(VirChn0) → VideoViEmptyThisBuffer()
    │       └── mOutputPortTunnelFlag=TRUE → COMP_EmptyThisBuffer(VencComp)  ← 零拷贝
    │               Venc 编码完成 → FillThisBuffer 回调 → refs[frameId]--
    │
    └── COMP_EmptyThisBuffer(VirChn1) → VideoViEmptyThisBuffer()
            └── mOutputPortTunnelFlag=TRUE → COMP_EmptyThisBuffer(VOComp)   ← 零拷贝
                    VO 显示完成 → FillThisBuffer 回调 → refs[frameId]--

    refs[frameId] == 0 → videoInputHw_ReleaseData() → ioctl(VIDIOC_QBUF) 归还内核
```

```plaintext
ISP 0
 ├── VIPP 0 (1080P 主码流)
 │    └── VirChn 0 ──Bind──→ Venc 0 ──Bind──→ Mux → RTSP/文件
 │
 ├── VIPP 4 (720P 子码流)
 │    └── VirChn 0 ──Bind──→ Venc 1 ──Bind──→ Mux → RTSP
 │
 └── VIPP 8 (416x416 NNA输入)
      └── VirChn 0 ──(非Tunnel/GetFrame)──→ AI推理（人脸/人形检测）
```

