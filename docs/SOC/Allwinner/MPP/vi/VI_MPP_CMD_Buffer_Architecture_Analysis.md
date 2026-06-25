# VI 组件中的 CMD 队列、Component 实例与 Buffer 流转机制分析

> 本文结合 `CMD.md`、`thread_start&cmd.md` 以及前面关于 VI buffer、VirChn component、`COMP_EmptyThisBuffer()`、引用计数、`SendCommand` 回调和多 component 实例的讨论整理而成。重点保留 `CMD.md` 中关于 MPP 架构设计、两套 CMD 队列、为什么使用异步命令队列而不是直接函数调用的分析，同时补充 buffer 生命周期与 component 实例模型。

---

## 0. 先给结论

VI 模块里至少有两条需要分开看的主线：

1. **控制面 CMD 主线**
   - 硬件层 CMD：`AW_MPI_VI_EnableVipp()` 通过 `videoInputHw_ChnEnable()` 把 `VVideoInputHw_EnableVipp` 投递到 `gpVIDevManager->mCmdQueue`，由全局 `VideoInputHw_CapThread` 处理。
   - 组件层 CMD：`COMP_SendCommand()` 进入 component 注册的 `SendCommand` 回调，例如 `VideoViSendCommand()`，再把 `SetState` / `Flush` / `Stop` 等投递到当前 VirChn component 实例自己的 `pVideoViData->cmd_queue`，由该实例的 `Vi_ComponentThread` 处理。

2. **数据面 Buffer 主线**
   - 硬件层 `VideoInputHw_CapThread` 在 VIPP 开流后 `select()` 等待 fd ready，通过 `DQBUF` 取得 V4L2 buffer，封装成 `VIDEO_FRAME_INFO_S`。
   - 然后它遍历该 VIPP 下的 `mChnList`，对每个 VirChn component 调用 `COMP_EmptyThisBuffer()`，把这帧作为 **输入 buffer** 投递给 component。
   - component 在 `VideoViEmptyThisBuffer()` 中把帧放入自己的 `mpCapMgr`。
   - 上层 sample/app 通过 `AW_MPI_VI_GetFrame()` 从 `mpCapMgr` 取帧，通过 `AW_MPI_VI_ReleaseFrame()` 归还帧。
   - 底层真实 V4L2 buffer 是否能重新 `QBUF` 回驱动，由 `refs[frameId]` 引用计数决定。

一句话概括：

> **硬件层 CMD 队列管 VIPP/V4L2/真实 buffer 生命周期；组件层 CMD 队列管 VirChn component 状态机；`COMP_EmptyThisBuffer()` 是数据帧进入 VirChn component 的入口；引用计数保证同一个底层 V4L2 buffer 被多个 VirChn 共享时不会被过早 QBUF 回驱动。**

---

## 1. 核心对象与术语

| 名称 | 含义 | 所属层级 | 重点 |
|---|---|---|---|
| `VIPP` / `VI_DEV` | 硬件采集入口，对应 `/dev/videoX` 等底层设备节点 | 硬件层 | 管 V4L2 fd、buffer、stream on/off |
| `VirChn` / `VI_CHN` | 从某个 VIPP 派生出来的虚拟通道 | 组件层 | 每个通道通常对应一个 `VideoVirVi` component 实例 |
| `VideoInputHw_CapThread` | VI 硬件层全局采集线程 | 硬件层 | 处理硬件 CMD、select、DQBUF、帧分发 |
| `Vi_ComponentThread` | VirChn component 内部线程入口函数 | 组件层 | 处理当前 component 实例的 CMD 队列 |
| `gpVIDevManager->mCmdQueue` | 硬件层全局 CMD 队列 | 硬件层 | `EnableVipp` / `DisableVipp` / `Stop` 等 |
| `pVideoViData->cmd_queue` | component 实例自己的 CMD 队列 | 组件层 | `SetState` / `Flush` / `Stop` / `VViComp_*` 等 |
| `mpCapMgr` | VirChn component 的帧管理器 | 组件层 | 管 `VIDEO_FRAME_INFO_S` 状态，不拥有真实图像内存 |
| `refs[frameId]` | 底层 buffer 引用计数 | 硬件层 | 决定真实 V4L2 buffer 何时可重新 `QBUF` |
| `COMP_EmptyThisBuffer()` | 数据帧输入 component 的接口 | 数据面 | 由硬件层向 VirChn component 投帧 |
| `SendCommand` | component 注册的控制命令入口 | 控制面 | 不是传帧接口，而是状态机/flush/stop 等控制入口 |

---

## 2. MPP VI 架构分层

可以把 VI 的架构理解成三层：

```text
1. MPI API 层
   - 对外提供 AW_MPI_VI_xxx
   - 做参数检查
   - 屏蔽内部线程、队列、组件细节

2. VideoInputHw 硬件层
   - 管理 VIPP / V4L2 / media graph / buffer pool
   - 全局 CapThread 统一处理硬件 CMD 和帧采集
   - 对多个 VIPP 做 select
   - 将帧分发给多个 VirChn

3. VideoVirVi Component 层
   - 每个 VirChn 对应一个 VideoVirVi component 实例
   - 每个实例有自己的 pVideoViData、cmd_queue、mpCapMgr
   - 处理组件状态机、GetFrame/ReleaseFrame、Tunnel、帧缓存
```

对应关系：

```text
VIPP = 硬件采集入口
VirChn = 从某个 VIPP 派生出的虚拟通道
CapThread = VIPP / V4L2 级别的硬件采集线程
Vi_ComponentThread = VirChn component 级别的控制线程入口函数
```

这里要特别注意：

> **`Vi_ComponentThread` 是一个线程入口函数，不代表整个 VI 模块只有一个 component 线程。多个 VirChn component 实例可以复用同一个线程入口函数，各自传入不同的 `pVideoViData`。**

---

## 3. 两套 CMD 队列：硬件层与组件层

`CMD.md` 中最关键的分析是：VI 里不是只有一套 cmd 队列，而是至少有两套不同层级的 cmd 队列。

| 层级 | 线程 | 队列 | 主要职责 |
|---|---|---|---|
| 硬件层 | `VideoInputHw_CapThread` | `gpVIDevManager->mCmdQueue` | 处理 VIPP enable/disable、V4L2 stream on/off、select 采集、帧分发 |
| 组件层 | `Vi_ComponentThread` | `pVideoViData->cmd_queue` | 处理 VirChn 状态机、flush、stop、长曝光事件、组件内部控制 |

所以：

- `VVideoInputHw_EnableVipp` 由 `VideoInputHw_CapThread` 处理。
- `SetState` / `Flush` / `VViComp_*` 由 `Vi_ComponentThread` 处理。
- 两者都是 CMD 机制，但服务于不同抽象层。

---

## 4. 硬件层 CMD：`AW_MPI_VI_EnableVipp()` 到 `VideoInputHw_CapThread`

### 4.1 入口函数：`AW_MPI_VI_EnableVipp()`

`AW_MPI_VI_EnableVipp()` 本身很薄：

```c
ERRORTYPE AW_MPI_VI_EnableVipp(VI_DEV ViDev)
{
    if (!(ViDev >= 0 && ViDev < VI_VIPP_NUM_MAX)) {
        aloge("invalid ViDev[%d]", ViDev);
        return ERR_VI_INVALID_DEVID;
    }

    return videoInputHw_ChnEnable(ViDev);
}
```

它只做参数范围检查，然后转入硬件层 `videoInputHw_ChnEnable()`。

---

### 4.2 `videoInputHw_ChnEnable()`：异步投递 + 同步等待

`videoInputHw_ChnEnable()` 的核心逻辑是构造一条硬件层 CMD：

```c
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
```

这里体现的是典型的 **异步投递 + 同步等待结果** 模式：

```text
调用线程：
    构造 message_t
    msg.command = VVideoInputHw_EnableVipp
    msg.para0 = ViVipp
    msg.pReply = Reply 信号量

    putMessageWithData(&gpVIDevManager->mCmdQueue, &msg)

    等待 ReplySem
```

从 API 使用者角度看，`AW_MPI_VI_EnableVipp()` 是同步返回的；但从内部执行角度看，真正的 V4L2 操作被转交给了 `VideoInputHw_CapThread`。

---

### 4.3 `VideoInputHw_CapThread` 接收并处理 `VVideoInputHw_EnableVipp`

`VideoInputHw_CapThread` 是硬件层中心线程。它不断从 `gpVIDevManager->mCmdQueue` 取消息：

```c
void * VideoInputHw_CapThread(void *pThreadData)
{
    message_t stCmdMsg;
    while (1)
    {
PROCESS_MESSAGE:
        if(get_message(&gpVIDevManager->mCmdQueue, &stCmdMsg) == 0)
        {
            if (Stop == stCmdMsg.command)
            {
                goto EXIT;
            }
            else if (VVideoInputHw_EnableVipp == stCmdMsg.command)
            {
                ...
            }
        }
        ...
    }
}
```

处理 `VVideoInputHw_EnableVipp` 时，主要做下面这些事情：

1. 获取 sensor 信息并校验分辨率。
2. 创建 buffer pool。
3. `video_req_buffers()` 申请 V4L2 buffer，对应 `VIDIOC_REQBUFS`。
4. 遍历 `vfmt.nbufs`，调用 `video_queue_buffer()` 预入队，对应 `VIDIOC_QBUF`。
5. 调用 `video_stream_on()` 开流，对应 `VIDIOC_STREAMON`。
6. 初始化一些帧状态变量，例如 `iDropFrameNum`、`mLastGetFrameTm`、`last_v_frm_pts`。
7. 调用 `videoInputHw_setVippEnable(nVipp)` 标记该 VIPP 已 enable。
8. 设置 `ReplyResult`，通过 `cdx_sem_up(&ReplySem)` 唤醒调用线程。

伪代码可以概括为：

```c
if (VVideoInputHw_EnableVipp == stCmdMsg.command)
{
    int nVipp = stCmdMsg.para0;
    struct isp_video_device *video = gpVIDevManager->media->video_dev[nVipp];
    viChnManager *pVipp = gpVIDevManager->gpVippManager[nVipp];

    // 1. 获取 sensor 信息，检查分辨率
    isp_get_sensor_info(iIspId, &stConfig);

    // 2. 申请 V4L2 buffer
    struct buffers_pool *pool = buffers_pool_new(video);
    video_req_buffers(video, pool);      // VIDIOC_REQBUFS

    // 3. 所有 buffer 预入队
    video_get_fmt(video, &vfmt);
    for (i = 0; i < vfmt.nbufs; i++) {
        video_queue_buffer(video, i);    // VIDIOC_QBUF
    }

    // 4. 启动采集流
    video_stream_on(video);              // VIDIOC_STREAMON

    // 5. 标记 enable
    videoInputHw_setVippEnable(nVipp);

    // 6. 回复调用线程
    stCmdMsg.pReply->ReplyResult = cmdRet;
    cdx_sem_up(&stCmdMsg.pReply->ReplySem);
}
```

---

### 4.4 为什么 `VVideoInputHw_EnableVipp` 不会被 `Vi_ComponentThread` 处理？

这是前面讨论中最容易混淆的点。

`VVideoInputHw_EnableVipp` 被投递到：

```c
putMessageWithData(&gpVIDevManager->mCmdQueue, &msg);
```

这个队列是硬件层全局队列，由 `VideoInputHw_CapThread` 读取。

而 `Vi_ComponentThread` 读取的是：

```c
get_message(&pVideoViData->cmd_queue, &cmd_msg)
```

这是某个 VirChn component 实例自己的队列。

因此：

```text
VVideoInputHw_EnableVipp
    -> gpVIDevManager->mCmdQueue
    -> VideoInputHw_CapThread

SetState / Flush / VViComp_*
    -> pVideoViData->cmd_queue
    -> Vi_ComponentThread
```

所以 `Vi_ComponentThread` 处理 CMD 是对的，但它处理的是 **组件层 CMD**，不是硬件层 `VVideoInputHw_EnableVipp`。

---

## 5. 组件层 CMD：`SendCommand` 回调一般做什么？

### 5.1 `SendCommand` 是控制面入口，不是数据面入口

component 注册的 `SendCommand` 回调，一般用于接收框架或 MPI 发来的控制命令，例如：

- `COMP_CommandStateSet`
- `COMP_CommandFlush`
- `Stop`
- 组件内部扩展控制命令

它不是用来传图像帧的。

VI component 中常见入口可以这样区分：

| 回调/接口 | 主要作用 | 控制面/数据面 |
|---|---|---|
| `SendCommand` | 发控制命令，如状态切换、flush、stop | 控制面 |
| `EmptyThisBuffer` | 外部把输入帧送进组件 | 数据面 |
| `GetConfig` / `SetConfig` | 获取/设置组件私有参数，例如 GetFrame / ReleaseFrame | 控制/配置面 |
| `FillThisBuffer` | 某些组件用于输出 buffer | 数据面，VI 主路径中不是重点 |

所以前面讨论中的结论是：

> **`SendCommand` 管 VirChn 状态机；`EmptyThisBuffer` 管帧输入；`GetConfig/SetConfig` 管 `GetFrame/ReleaseFrame` 这类私有操作；`videoInputHw` 的 CMD 队列才管真正的 V4L2 硬件启停。**

---

### 5.2 `VideoViSendCommand()` 的典型逻辑

`VideoViSendCommand()` 会从当前 `hComponent` 找到该实例的私有数据：

```c
pVideoViData = (VIDEOVIDATATYPE *)(((MM_COMPONENTTYPE *)hComponent)->pComponentPrivate);
```

然后做几件事：

1. 检查 `pVideoViData` 是否为空。
2. 检查组件是否已经是 `COMP_StateInvalid`。
3. 把外部 `COMP_COMMANDTYPE` 翻译成内部 `CompInternalMsgType`。
4. 把内部消息投递到当前 component 实例的 `pVideoViData->cmd_queue`。

典型映射：

```c
switch (Cmd) {
    case COMP_CommandStateSet:
        eCmd = SetState;
        break;

    case COMP_CommandFlush:
        eCmd = Flush;
        break;

    default:
        ...
}

msg.command = eCmd;
msg.para0 = nParam1;
put_message(&pVideoViData->cmd_queue, &msg);
```

也就是说，`SendCommand` 本身通常并不直接完成复杂状态切换，而是把“我要切状态 / 我要 flush”这个意图发给组件线程。

---

### 5.3 `Vi_ComponentThread` 消费组件层 CMD

`Vi_ComponentThread` 的核心循环可以概括为：

```c
while (1) {
PROCESS_MESSAGE:
    if (get_message(&pVideoViData->cmd_queue, &cmd_msg) == 0) {
        cmd = cmd_msg.command;
        cmddata = (unsigned int)cmd_msg.para0;

        if (cmd == SetState) {
            // 处理 Loaded / Idle / Executing / Pause 等状态切换
        } else if (cmd == Flush) {
            // flush 组件缓存
        } else if (cmd == Stop) {
            goto EXIT;
        } else if (cmd == VViComp_InputFrameAvailable) {
            // 输入帧可用事件
        } else if (cmd == VViComp_DropFrame) {
            // 丢帧事件/策略
        } else if (cmd == VViComp_LongExpEvent) {
            // 长曝光事件，可能回调上层
        } else if (cmd == VViComp_StoreFrame) {
            // 调试存帧
        }
    }

    // cmd_queue 为空后，才进入 Executing 状态下的数据处理/等待逻辑
}
```

因此，`Vi_ComponentThread` 的定位是：

```text
Vi_ComponentThread：
    管“虚拟通道状态”和“组件内部控制事件”

VideoInputHw_CapThread：
    管“硬件资源”和“帧生产/分发”
```

---

## 6. Component 实例、VirChn 与线程数量

前面讨论中有一个重要修正：

> **不是一个源码文件 `VideoVirVi_Component.c` 只开一个全局线程，而是每创建一个 VirChn component 实例，都会在该实例内部创建/维护自己的 `pVideoViData`、`cmd_queue`、`mpCapMgr`，并通常通过一个 `Vi_ComponentThread` 线程实例来消费该实例自己的队列。**

### 6.1 `COMP_GetHandle()` 创建的是一个 component 实例

创建 VirChn 时会看到类似逻辑：

```c
eRet = COMP_GetHandle((COMP_HANDLETYPE *)&(pNode->mViComp),
                      CDX_ComponentNameViScale,
                      (void *)pNode,
                      &VideoViCallback);

MPP_CHN_S ChannelInfo;
ChannelInfo.mModId = MOD_ID_VIU;
ChannelInfo.mDevId = ViDev;
ChannelInfo.mChnId = ViCh;

eRet = COMP_SetConfig(pNode->mViComp,
                      COMP_IndexVendorMPPChannelInfo,
                      (void*)&ChannelInfo);
```

这里的本质是：

1. `COMP_GetHandle(... CDX_ComponentNameViScale ...)` 创建一个 VI component 实例。
2. 这个实例的 handle 存在当前 `pNode->mViComp` 中。
3. `COMP_SetConfig(... MPPChannelInfo ...)` 把这个实例绑定到具体 `ViDev / ViCh`。

因此，不是全局只有一个 VI component，而是：

```text
组件类型：CDX_ComponentNameViScale
    ↓ COMP_GetHandle()
组件实例 0：绑定 ViDev0 / ViCh0
组件实例 1：绑定 ViDev0 / ViCh1
组件实例 2：绑定 ViDev1 / ViCh0
```

### 6.2 线程函数只有一个，线程实例可以有多个

`Vi_ComponentThread()` 是线程入口函数，不等价于“全系统只有一个线程”。

更严谨地说：

```text
Vi_ComponentThread 函数：一个源码函数
Vi_ComponentThread 线程实例：可以被多个 component 实例分别创建
pVideoViData：每个 component 实例自己的私有上下文
pVideoViData->cmd_queue：每个 component 实例自己的 CMD 队列
```

逻辑上可以理解为：

```text
VIPP0
 ├── VirChn0 -> pNode0 -> mViComp0 -> pVideoViData0 -> cmd_queue0 -> Vi_ComponentThread0
 ├── VirChn1 -> pNode1 -> mViComp1 -> pVideoViData1 -> cmd_queue1 -> Vi_ComponentThread1
 └── VirChn2 -> pNode2 -> mViComp2 -> pVideoViData2 -> cmd_queue2 -> Vi_ComponentThread2
```

如果运行时只创建了一个 VirChn，那当然只会看到一个 `Vi_ComponentThread` 线程实例。但架构上它是实例级模型，不是全局唯一 component 模型。

---

## 7. 为什么使用 CMD 队列，而不是直接调用函数？

这是 `CMD.md` 中最核心的设计分析，应当保留。

### 7.1 让硬件操作集中到一个线程，避免多线程直接操作 V4L2

`AW_MPI_VI_EnableVipp()` 最终涉及：

- `VIDIOC_REQBUFS`
- `VIDIOC_QBUF`
- `VIDIOC_STREAMON`
- 修改 `vipp_enable`
- 后续 `select`
- `DQBUF`
- 分发帧
- `QBUF` / release

这些都围绕同一批 V4L2 fd、buffer、引用计数和 VI manager 状态展开。

如果允许多个 API 调用线程直接调用这些函数，就可能出现：

```text
线程 A：EnableVipp -> 正在 req buffer / qbuf
线程 B：DisableVipp -> 正在 stream off / free buffer
线程 C：GetFrame / ReleaseFrame -> 正在操作 refs / buffer
CapThread：select 返回，正在 dequeue frame
```

这会让 buffer 生命周期非常难保证。

采用 CMD 队列后，关键硬件状态变化被串行化到 `VideoInputHw_CapThread`：

```text
EnableVipp
DisableVipp
Stop
帧采集循环
```

它们都在同一个硬件中心线程中按顺序处理，减少竞态。

---

### 7.2 CapThread 本来就是帧采集事件循环，enable/disable 必须和 select 循环协同

`VideoInputHw_CapThread` 不只是 CMD 线程，它还负责 `select()` 所有已经 enable 的 VIPP fd。

典型逻辑是：

```c
for (int i = 0; i < VI_VIPP_NUM_MAX; i++)
{
    viChnManager *pVippInfo = gpVIDevManager->gpVippManager[i];

    if (pVippInfo->vipp_enable)
    {
        struct isp_video_device *video = gpVIDevManager->media->video_dev[i];
        FD_SET(video->entity->fd, &fds);
        if (video->entity->fd > nMaxFd)
            nMaxFd = video->entity->fd;
    }
}

select(nMaxFd + 1, &fds, NULL, NULL, &tv);
```

只有 `pVippInfo->vipp_enable` 为真时，该 VIPP 的 fd 才会加入 `select()`。

这意味着 `EnableVipp` 不只是“启动硬件”，还在改变 CapThread 的事件监听集合。

如果 `EnableVipp` 由用户线程直接执行，那么用户线程一边修改 `vipp_enable`、buffer、fd 状态，CapThread 另一边正在构建 fd set 或正在 `select()`，同步复杂度会明显上升。

现在的设计是：

```text
CapThread 自己处理 EnableVipp
    -> stream on
    -> set vipp_enable
    -> 下一轮 select 自然加入该 fd
```

这使得“硬件状态变化”和“采集事件循环”天然处于同一个执行上下文中。

---

### 7.3 队列保证命令顺序，适合 MPP/OMX 风格状态机

MPP/OMX 风格 component 通常不是简单函数库，而是一套状态机系统：

```text
Loaded -> Idle -> Executing -> Pause -> Idle -> Loaded
```

状态切换、资源申请、buffer 生命周期、回调通知都需要顺序性。

比如：

```text
EnableVipp
CreateVirChn
EnableVirChn
Start receive frame
DisableVirChn
DestroyVirChn
DisableVipp
```

如果每个 API 都直接调用底层函数，系统需要到处加锁，到处检查当前状态。

CMD 队列的好处是：

> **把“并发调用”转成“串行事件流”。**

这符合 MPP 的设计思想：

```text
外部可以多线程调用 API
内部按队列顺序处理状态变化
```

这比“所有函数互相直接调用 + 大量锁保护”更容易维护。

---

### 7.4 实现“内部异步处理 + 外部同步返回”

这套设计并不是完全异步。对用户来说，`AW_MPI_VI_EnableVipp()` 仍然等待结果：

```text
putMessageWithData()
cdx_sem_down_timedwait()
```

CapThread 处理完以后：

```text
ReplyResult = cmdRet
cdx_sem_up()
```

所以它兼顾了两个目标：

1. **内部执行异步化**：实际硬件操作交给专用线程。
2. **外部接口同步化**：调用者得到明确成功/失败返回值。

这是一种常见的“同步 RPC 到工作线程”的模式。

---

### 7.5 降低死锁风险，避免复杂锁顺序在多个线程扩散

VI 子系统里存在多把锁，例如：

- `gpVIDevManager->mManagerLock`
- `pVipp->mLock`
- VirVi 的 `mStateLock`
- buffer manager 内部锁
- cmd queue 内部锁/信号量

如果让用户线程直接进入硬件操作路径，会扩大锁组合范围，更容易形成锁顺序冲突。

例如：

```text
线程 A 持有 mManagerLock，等待 mStateLock
线程 B 持有 mStateLock，等待 mManagerLock
```

CMD 队列不能自动消除所有死锁，但它能把复杂并发问题收敛到少数线程和少数入口。

---

### 7.6 enable/disable 是“重操作”，不适合作为普通函数内联调用

`EnableVipp` 不只是设置一个 flag，而是完整采集链路启动：

```text
sensor 信息检查
buffer pool 创建
VIDIOC_REQBUFS
VIDIOC_QBUF
VIDIOC_STREAMON
初始化帧时间戳/丢帧计数
修改 vipp_enable
```

这些操作可能阻塞、失败、依赖硬件状态，也可能触发驱动层等待。

把它放到 CapThread 中处理，可以让：

- API 层不直接承担硬件细节。
- 硬件异常集中记录。
- buffer 生命周期集中管理。
- 与后续采集循环天然衔接。

---

## 8. `COMP_EmptyThisBuffer()` 为什么用于 buffer 分发？

前面讨论过，文档中“buffer 分发给上层”这句话需要更精确。

更准确地说：

> **DQBUF 后，`videoInputHw` 不是直接把帧返回给 sample，而是通过 `COMP_EmptyThisBuffer()` 把帧作为输入 buffer 投递给每个 VirChn component。VirChn component 在 `VideoViEmptyThisBuffer()` 中把帧 push 到 `mpCapMgr`。sample/app 后续调用 `AW_MPI_VI_GetFrame()`，才从 `mpCapMgr` 取到这帧。**

### 8.1 数据流方向

```text
VideoInputHw_CapThread
    select(fd)
    -> video_dequeue_buffer() / DQBUF
    -> 封装 VIDEO_FRAME_INFO_S
    -> 遍历 mChnList
    -> COMP_EmptyThisBuffer(pEntry->mViComp, &bufferHeader)

VideoVirVi component
    -> VideoViEmptyThisBuffer()
    -> VideoBufMgrPushFrame(mpCapMgr, pFrm)

sample / app
    -> AW_MPI_VI_GetFrame()
    -> DoVideoViGetData()
    -> VideoBufMgrGetValidFrame()
```

### 8.2 为什么叫 `EmptyThisBuffer`？

在 OMX/MPP 风格 component 里，`EmptyThisBuffer()` 的语义通常是：

> 外部把一个“已经装有数据的输入 buffer”交给 component，让 component 消费它。

它不是说这个 buffer 真的没有数据，而是说：

```text
调用者：我把这个 input buffer 给你，你来 empty/consume 它。
```

对 VI 来说，V4L2 已经 DQBUF 得到了一帧，这帧被封装成 `VIDEO_FRAME_INFO_S`。硬件层把它送进 VirChn component 的 CAP 输入口，因此调用的是 `COMP_EmptyThisBuffer()`。

### 8.3 `bufferHeader.pOutputPortPrivate = &stFrameInfo` 是否矛盾？

不矛盾。

虽然字段名叫 `pOutputPortPrivate`，但这里它被当作一个私有指针字段来携带 `stFrameInfo`。

真正决定语义的是：

```c
bufferHeader.nInputPortIndex = VI_CHN_PORT_INDEX_CAP_IN;
COMP_EmptyThisBuffer(pEntry->mViComp, &bufferHeader);
```

这说明它仍然是送到 component input port 的帧，而不是 output port 输出。

---

## 9. `mpCapMgr` 与真实 V4L2 buffer 的关系

`mpCapMgr = VideoBufMgrCreate(...)` 不是驱动 buffer 池。

它是 VirChn component 层自己的帧管理器，用于管理 `VIDEO_FRAME_INFO_S` 的状态流转：

```text
Free -> Valid -> Using -> Free
```

### 9.1 三个链表

| 链表 | 含义 |
|---|---|
| `mFreeFrmList` | 空闲 frame header 节点 |
| `mValidFrmList` | 已收到、等待上层 `GetFrame()` 的帧 |
| `mUsingFrmList` | 已被上层取走、等待 `ReleaseFrame()` 的帧 |

### 9.2 收帧：`Free -> Valid`

component 收到 `COMP_EmptyThisBuffer()` 后：

```c
VideoBufMgrPushFrame(pVideoViData->mpCapMgr, pFrm);
```

其本质是：

```text
从 Free 取一个节点
复制 VIDEO_FRAME_INFO_S
节点移入 Valid
```

### 9.3 取帧：`Valid -> Using`

上层 `AW_MPI_VI_GetFrame()` 最终会进入：

```c
tmp = VideoBufMgrGetValidFrame(pVideoViData->mpCapMgr);
```

其本质是：

```text
从 Valid 取最旧帧
移动到 Using
返回给上层
```

### 9.4 还帧：`Using -> Free`

上层 `AW_MPI_VI_ReleaseFrame()` 后，component 调用：

```c
VideoBufMgrReleaseFrame(pVideoViData->mpCapMgr, pstFrameInfo);
```

其本质是：

```text
在 Using 中找到这帧
移回 Free
```

### 9.5 关键点

`mpCapMgr` 不拥有真实图像内存。它只管理 frame header 和 component 内部状态。真实图像内存仍属于底层 V4L2 buffer，何时回驱动由底层引用计数决定。

---

## 10. 引用计数：为什么需要 `refs[frameId]`？

### 10.1 问题背景

一个 VIPP 可以有多个 VirChn：

```text
VIPP0
 ├── VirChn0
 ├── VirChn1
 └── VirChn2
```

底层 V4L2 `DQBUF` 出来的是真实的一块 buffer。这个 buffer 可能会被封装成同一个 `stFrameInfo`，再分发给多个 VirChn component。

因此不能某个 VirChn 先 `ReleaseFrame()`，底层就立刻把该 buffer `QBUF` 回驱动。否则其他 VirChn 还没处理完，驱动就可能拿这块 buffer 去采下一帧，造成数据被覆盖。

所以需要：

```c
refs[stFrameInfo.mId]
```

记录当前 frameId 对应的底层 buffer 还有多少持有者。

---

### 10.2 分发阶段如何加引用

典型逻辑如下：

```c
if (0 == pVippInfo->refs[stFrameInfo.mId])
{
    if (!list_empty(&pVippInfo->mChnList))
    {
        // 分发过程临时引用
        videoInputHw_RefsIncrease(nVippIndex, &stFrameInfo);

        list_for_each_entry(pEntry, &pVippInfo->mChnList, mList)
        {
            COMP_BUFFERHEADERTYPE bufferHeader;
            bufferHeader.nInputPortIndex = VI_CHN_PORT_INDEX_CAP_IN;
            bufferHeader.pOutputPortPrivate = &stFrameInfo;

            // 每个 VirChn 成功接收前先加引用
            videoInputHw_RefsIncrease(nVippIndex, &stFrameInfo);

            ERRORTYPE ret2 = COMP_EmptyThisBuffer(pEntry->mViComp, &bufferHeader);
            if (ret2 != SUCCESS)
            {
                // 投递失败则回滚引用
                videoInputHw_RefsReduceAndRleaseData(nVippIndex, &stFrameInfo);
            }
        }

        // 分发结束，释放采集线程临时引用
        videoInputHw_RefsReduceAndRleaseData(nVippIndex, &stFrameInfo);
    }
}
```

这里有两类引用：

1. **分发过程临时引用**
   - 遍历 `mChnList` 前加一次。
   - 遍历结束后减一次。
   - 用来保护分发过程，防止分发途中引用计数提前归零。

2. **每个 VirChn 的持有引用**
   - 每投递给一个 VirChn 前加一次。
   - 如果 `COMP_EmptyThisBuffer()` 失败，立即减回去。
   - 如果成功，则等该 VirChn 上层 `ReleaseFrame()` 时再减。

---

### 10.3 三个 VirChn 的例子

假设当前帧 `mId = 5`，一开始：

```text
refs[5] = 0
```

分发前加临时引用：

```text
refs[5] = 1
```

分发给 VirChn0 成功：

```text
refs[5] = 2
```

分发给 VirChn1 成功：

```text
refs[5] = 3
```

分发给 VirChn2 成功：

```text
refs[5] = 4
```

分发结束，释放临时引用：

```text
refs[5] = 3
```

此时剩下的 3 个引用分别属于 3 个 VirChn 的消费链路。

之后上层逐个 release：

```text
VirChn0 ReleaseFrame -> refs[5] = 2，不 QBUF
VirChn1 ReleaseFrame -> refs[5] = 1，不 QBUF
VirChn2 ReleaseFrame -> refs[5] = 0，调用 videoInputHw_ReleaseData()，QBUF 回驱动
```

---

### 10.4 ReleaseFrame 的双重释放

上层调用 `AW_MPI_VI_ReleaseFrame()` 后，component 层通常会做两件事：

```c
videoInputHw_RefsReduceAndRleaseData(vipp_id, pstFrameInfo);
VideoBufMgrReleaseFrame(pVideoViData->mpCapMgr, pstFrameInfo);
```

两者含义不同：

| 调用 | 所属层级 | 作用 |
|---|---|---|
| `videoInputHw_RefsReduceAndRleaseData()` | 硬件层 | 底层 V4L2 buffer 引用计数减一；减到 0 时 QBUF 回驱动 |
| `VideoBufMgrReleaseFrame()` | 组件层 | 当前 VirChn 的 `mpCapMgr` 从 `Using` 回到 `Free` |

也就是说：

```text
refs[] 管真实底层 buffer 生命周期
mpCapMgr 管某个 VirChn 内部 frame header 状态
```

---

## 11. 从 Enable 到 GetFrame / ReleaseFrame 的完整闭环

可以把整个流程串成一条完整时间线：

```text
1. AW_MPI_VI_EnableVipp(ViDev)
   -> videoInputHw_ChnEnable(ViDev)
   -> msg.command = VVideoInputHw_EnableVipp
   -> putMessageWithData(&gpVIDevManager->mCmdQueue, &msg)
   -> 等待 ReplySem

2. VideoInputHw_CapThread 处理 VVideoInputHw_EnableVipp
   -> sensor 信息检查
   -> buffers_pool_new(video)
   -> video_req_buffers(video, pool)      // REQBUFS
   -> for each buffer: video_queue_buffer // QBUF
   -> video_stream_on(video)              // STREAMON
   -> videoInputHw_setVippEnable(nVipp)
   -> cdx_sem_up(ReplySem)

3. AW_MPI_VI_CreateVirChn / EnableVirChn
   -> COMP_GetHandle(... CDX_ComponentNameViScale ...)
   -> COMP_SetConfig(... MPPChannelInfo ...)
   -> COMP_SendCommand(... COMP_CommandStateSet, COMP_StateExecuting)
   -> VideoViSendCommand()
   -> put_message(&pVideoViData->cmd_queue, SetState)
   -> Vi_ComponentThread 处理状态切换

4. CapThread 进入采集循环
   -> select(enabled vipp fd)
   -> video_dequeue_buffer()              // DQBUF
   -> 封装 VIDEO_FRAME_INFO_S

5. CapThread 分发 frame
   -> 遍历 pVippInfo->mChnList
   -> refs[frameId]++
   -> COMP_EmptyThisBuffer(pEntry->mViComp, &bufferHeader)

6. VirChn component 收帧
   -> VideoViEmptyThisBuffer()
   -> VideoBufMgrPushFrame(mpCapMgr, pFrm)
   -> Free -> Valid

7. sample/app 取帧
   -> AW_MPI_VI_GetFrame()
   -> DoVideoViGetData()
   -> VideoBufMgrGetValidFrame()
   -> Valid -> Using

8. sample/app 还帧
   -> AW_MPI_VI_ReleaseFrame()
   -> videoInputHw_RefsReduceAndRleaseData()
   -> VideoBufMgrReleaseFrame()
   -> Using -> Free
   -> refs[frameId] == 0 时 videoInputHw_ReleaseData()
   -> video_queue_buffer()                // QBUF 回驱动
```

---

## 12. 硬件层 CMD 队列与组件层 CMD 队列对比

| 对比项 | 硬件层 CMD 队列 | 组件层 CMD 队列 |
|---|---|---|
| 队列变量 | `gpVIDevManager->mCmdQueue` | `pVideoViData->cmd_queue` |
| 消费线程 | `VideoInputHw_CapThread` | `Vi_ComponentThread` |
| 数量 | 全局一个，面向 VI/VIPP 硬件管理 | 每个 VirChn component 实例一个 |
| 管理对象 | VIPP / V4L2 / buffer / stream | VirChn / component 状态机 / 帧缓存 |
| 典型命令 | `VVideoInputHw_EnableVipp` / `VVideoInputHw_DisableVipp` / `Stop` | `SetState` / `Flush` / `Stop` / `VViComp_*` |
| 数据角色 | 帧生产者、分发者 | 帧消费者、缓存者、转发者 |
| 和 buffer 的关系 | 负责真实 V4L2 buffer 的申请、DQBUF、QBUF | 管理 frame header 在 Valid/Using/Free 间流转 |
| 设计目的 | 串行化硬件资源操作 | 串行化组件状态变化 |

一句话总结：

> **硬件层 CMD 队列解决“怎么安全地控制采集设备”；组件层 CMD 队列解决“每个 VI 通道如何按状态机接收和处理帧”。**

---

## 13. 常见误区修正

### 误区 1：`Vi_ComponentThread` 会处理 `VVideoInputHw_EnableVipp`

不对。

`VVideoInputHw_EnableVipp` 进入的是：

```text
gpVIDevManager->mCmdQueue -> VideoInputHw_CapThread
```

`Vi_ComponentThread` 处理的是：

```text
pVideoViData->cmd_queue -> SetState / Flush / Stop / VViComp_*
```

---

### 误区 2：`COMP_EmptyThisBuffer()` 是把 buffer 分发给 sample 上层

不严谨。

更准确是：

```text
videoInputHw 通过 COMP_EmptyThisBuffer()
把帧投递给 VirChn component 的 input port。

sample/app 之后再通过 AW_MPI_VI_GetFrame()
从 component 的 mpCapMgr 取帧。
```

---

### 误区 3：`mpCapMgr` 就是 V4L2 buffer 池

不对。

`mpCapMgr` 只管理 `VIDEO_FRAME_INFO_S` 头信息和状态，不拥有真实图像内存。真实 buffer 属于底层 V4L2 / `videoInputHw`。

---

### 误区 4：`CDX_ComponentNameViScale` 只能创建一个 component

不对。

`CDX_ComponentNameViScale` 是组件类型名，不是实例唯一标识。每次 `COMP_GetHandle()` 都可以创建一个新的 component 实例，再通过 `COMP_SetConfig(... MPPChannelInfo ...)` 绑定到不同的 `ViDev / ViCh`。

---

### 误区 5：只要一个 VirChn release，底层 buffer 就能回驱动

不对。

如果同一底层 buffer 被多个 VirChn 引用，必须等所有引用都释放：

```text
refs[frameId] == 0
    -> videoInputHw_ReleaseData()
    -> QBUF 回驱动
```

---

## 14. 推荐的调试关注点

如果后续要排查 VI 相关问题，可以按下面几个点看。

### 14.1 EnableVipp 卡住或失败

重点看：

```text
AW_MPI_VI_EnableVipp
-> videoInputHw_ChnEnable
-> putMessageWithData(&gpVIDevManager->mCmdQueue)
-> cdx_sem_down_timedwait
-> VideoInputHw_CapThread 是否收到 VVideoInputHw_EnableVipp
-> video_req_buffers / video_queue_buffer / video_stream_on 返回值
-> ReplySem 是否被 up
```

### 14.2 VirChn Enable 后没有帧

重点看：

```text
VirChn 是否创建 component 成功
pNode->mViComp 是否有效
ChannelInfo 是否正确设置 ViDev / ViCh
COMP_SendCommand(StateSet, Executing) 是否成功
Vi_ComponentThread 是否处理 SetState
VIPP 是否已经 EnableVipp 并 stream on
CapThread 是否 DQBUF 到帧
CapThread 是否遍历 mChnList 并调用 COMP_EmptyThisBuffer
VideoViEmptyThisBuffer 是否 push 到 mpCapMgr
```

### 14.3 GetFrame 超时

重点看：

```text
mpCapMgr 的 Valid 队列是否有帧
VideoViEmptyThisBuffer 是否被调用
mWaitingCapDataFlag / mSemWaitInputFrame 是否正常唤醒
VirChn 状态是否 Executing
是否因 cache policy 丢帧
```

### 14.4 buffer 不回收 / 后续无帧

重点看：

```text
refs[frameId] 是否一直大于 0
某个 VirChn 是否 GetFrame 后没有 ReleaseFrame
COMP_EmptyThisBuffer 失败路径是否正确减引用
DropFrame 路径是否正确 release 引用
VideoBufMgrReleaseFrame 是否找得到 Using 中的 frame
videoInputHw_ReleaseData 是否最终 QBUF 回驱动
```

---

## 15. 最终总结

VI 的 MPP 架构并不是简单的函数调用链，而是一个典型的“控制面 + 数据面 + 状态机 + buffer 生命周期”组合模型。

最核心的设计可以概括为：

```text
控制面：
    硬件层 CMD 队列
        AW_MPI_VI_EnableVipp
        -> videoInputHw_ChnEnable
        -> gpVIDevManager->mCmdQueue
        -> VideoInputHw_CapThread
        -> REQBUFS / QBUF / STREAMON

    组件层 CMD 队列
        COMP_SendCommand
        -> VideoViSendCommand
        -> pVideoViData->cmd_queue
        -> Vi_ComponentThread
        -> 状态切换 / flush / stop / 内部事件

数据面：
    VideoInputHw_CapThread
        -> select
        -> DQBUF
        -> VIDEO_FRAME_INFO_S
        -> refs++
        -> COMP_EmptyThisBuffer

    VideoVirVi component
        -> VideoViEmptyThisBuffer
        -> mpCapMgr Free -> Valid
        -> AW_MPI_VI_GetFrame Valid -> Using
        -> AW_MPI_VI_ReleaseFrame Using -> Free
        -> refs--
        -> refs == 0 时 QBUF 回驱动
```

这套设计的价值在于：

1. 把 V4L2 硬件操作集中到 `VideoInputHw_CapThread`，减少并发风险。
2. 把 VirChn 状态机集中到 component 自己的 `Vi_ComponentThread`，保持组件自治。
3. 通过 CMD 队列把并发调用变成有序事件流。
4. 通过 reply 信号量保留上层同步 API 语义。
5. 通过 `mpCapMgr` 管理每个 VirChn 的帧消费状态。
6. 通过 `refs[frameId]` 管理底层真实 buffer 的共享生命周期。

最终可以用一句话收束：

> **`AW_MPI_VI_EnableVipp()` 启动的是硬件生产端；`COMP_SendCommand()` 控制的是 VirChn component 状态机；`COMP_EmptyThisBuffer()` 负责把硬件采到的帧送进 component；`AW_MPI_VI_GetFrame/ReleaseFrame()` 负责上层借还帧；`refs[]` 负责确保真实 V4L2 buffer 在所有通道都释放后才回驱动。**
