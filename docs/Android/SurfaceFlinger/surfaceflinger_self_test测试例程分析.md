# SurfaceFlinger self-test流程分析
_Exported on 2026/3/30 at GMT+8 19:40:02 from Cursor (2.6.21)_

---

**User**

帮我分析一下surfaceflinger的
@android14/frameworks/native/services/surfaceflinger/tests/self_test/self_test.cpp的@self_test.cpp (36-70) 这些流程

---

**Cursor**

我来帮你分析这个文件的流程。先让我读取一下完整的内容。

好的，我来详细分析一下第36-70行的SurfaceFlinger流程：

## 流程分析

**第36-37行：Binder线程池初始化**
```cpp
sp<ProcessState> proc(ProcessState::self());
ProcessState::self()->startThreadPool();
```
- 获取当前进程的ProcessState单例
- 启动Binder线程池，用于处理来自SurfaceFlinger的IPC回调

**第40-41行：创建SurfaceComposerClient客户端**
```cpp
sp<SurfaceComposerClient> client = new SurfaceComposerClient();
```
- 连接到SurfaceFlinger服务
- 这是应用与SurfaceFlinger通信的代理对象

**第43-45行：创建Surface**
```cpp
sp<SurfaceControl> surfaceControl = client->createSurface(String8("resize"),
        160, 240, PIXEL_FORMAT_RGB_565, 0);
sp<Surface> surface = surfaceControl->getSurface();
```
- 创建一个160x240的RGB565格式的Surface
- SurfaceControl用于控制图层属性（位置、大小、可见性等）
- Surface用于绘制内容

**第48-52行：设置图层顺序并显示**
```cpp
SurfaceComposerClient::Transaction t1;
t1.setLayer(surfaceControl, 100000);
t1.show(surfaceControl);
t1.apply();
```
- 创建一个事务(Transaction)对象
- setLayer：设置图层Z轴顺序为100000（值越大越靠前）
- show：使图层可见
- apply：提交事务到SurfaceFlinger，触发合成

**第55-59行：第一帧绘制（红色）**
```cpp
ANativeWindow_Buffer outBuffer;
surface->lock(&outBuffer, NULL);
ssize_t bpr = outBuffer.stride * bytesPerPixel(outBuffer.format);
uint16_t* pixels = (uint16_t*)outBuffer.bits;
for (ssize_t i = 0; i < bpr * outBuffer.height / 2; i++) pixels[i] = 0xF800;
surface->unlockAndPost();
```
- lock：获取Surface的缓冲区指针（双缓冲机制）
- 计算每行字节数(bpr)
- 填充像素数据为红色(0xF800 = RGB565红色)
- unlockAndPost：解锁缓冲区并提交给SurfaceFlinger合成

**第62-66行：第二帧绘制（绿色）**
```cpp
surface->lock(&outBuffer, NULL);
pixels = (uint16_t*)outBuffer.bits;
for (ssize_t i = 0; i < bpr * outBuffer.height / 2; i++) pixels[i] = 0x07E0;
surface->unlockAndPost();
```
- 同样流程，但填充绿色(0x07E0 = RGB565绿色)
- 双缓冲机制确保前一帧显示时，后一帧在后台缓冲区绘制

**第69-72行：缩放变换**
```cpp
SurfaceComposerClient::Transaction t2;
t2.setMatrix(surfaceControl, 2.0f, 0, 0, 1.0f);
t2.apply();
```
- 创建第二个事务
- setMatrix：应用2D变换矩阵（水平缩放2倍，垂直保持1倍）
- apply：提交变换到SurfaceFlinger

## 核心概念总结

| 概念 | 作用 |
|------|------|
| **ProcessState** | Binder进程通信框架 |
| **SurfaceComposerClient** | 与SurfaceFlinger的客户端连接 |
| **SurfaceControl** | 图层属性控制（Z序、可见性、变换等） |
| **Surface** | 图形缓冲区，用于绘制像素数据 |
| **Transaction** | 原子性提交多个图层操作 |
| **双缓冲** | 前台显示，后台绘制，避免撕裂 |

这个测试程序演示了Android图形系统的基本流程：**创建图层 → 设置属性 → 绘制内容 → 提交合成**。

---

**User**

sp<SurfaceControl> surfaceControl = client->createSurface(String8("resize"),
        160, 240, PIXEL_FORMAT_RGB_565, 0);
sp<Surface> surface = surfaceControl->getSurface();

结合源码详细分析一下流程，不用生成文档，直接发给我就行

---

**Cursor**

好的，我先结合 `SurfaceComposerClient` 和 `SurfaceControl` 的实现把这两行的调用链捋一遍，然后给你按源码路径详细展开。

{"id":"","input":{},"name":"","type":"tool_use"}

Need more lines around 2402. use Read offset around2380.


Need file path for grep content incomplete due truncation. get files_with_matches in service dir and aidl file path.


Need read Client.cpp and aidl file sections. Also maybe createSurface from SurfaceFlinger.cpp called by client. Let's read key sections via python script maybe line nums. use shell python for line numbers quick maybe fine.

Need read around 5410.


Need continue unlockAndPost lines.


你这两行背后其实是 **两段不同职责** 的链路：

1) `client->createSurface(...)`：向 SurfaceFlinger **创建 Layer 控制对象**（`SurfaceControl`）  
2) `surfaceControl->getSurface()`：在客户端侧构建可生产 buffer 的 `Surface`（底层走 BLAST/BQ）

下面按源码把调用链展开。

---

### 1) self_test 入口

```39:42:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/services/surfaceflinger/tests/self_test/self_test.cpp
sp<SurfaceControl> surfaceControl = client->createSurface(String8("resize"),
        160, 240, PIXEL_FORMAT_RGB_565, 0);

sp<Surface> surface = surfaceControl->getSurface();
```

---

### 2) `client->createSurface(...)` 这条链

#### 2.1 先确保 `SurfaceComposerClient` 已连接 SF

`SurfaceComposerClient` 初始是 `NO_INIT`，首次引用时在 `onFirstRef()` 里通过 `ISurfaceComposer::createConnection()` 拿到 `ISurfaceComposerClient` Binder 通道：

```2349:2363:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/SurfaceComposerClient.cpp
SurfaceComposerClient::SurfaceComposerClient() : mStatus(NO_INIT) {}

void SurfaceComposerClient::onFirstRef() {
    sp<gui::ISurfaceComposer> sf(ComposerServiceAIDL::getComposerService());
    if (sf != nullptr && mStatus == NO_INIT) {
        sp<ISurfaceComposerClient> conn;
        binder::Status status = sf->createConnection(&conn);
        if (status.isOk() && conn != nullptr) {
            mClient = conn;
            mStatus = NO_ERROR;
        }
    }
}
```

#### 2.2 `createSurface()` 只是薄封装，核心在 `createSurfaceChecked()`

```2402:2439:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/SurfaceComposerClient.cpp
sp<SurfaceControl> SurfaceComposerClient::createSurface(const String8& name, uint32_t w, uint32_t h,
                                                        PixelFormat format, int32_t flags,
                                                        const sp<IBinder>& parentHandle,
                                                        LayerMetadata metadata,
                                                        uint32_t* outTransformHint) {
    sp<SurfaceControl> s;
    createSurfaceChecked(name, w, h, format, &s, flags, parentHandle, std::move(metadata),
                         outTransformHint);
    return s;
}

status_t SurfaceComposerClient::createSurfaceChecked(...){
    if (mStatus == NO_ERROR) {
        gui::CreateSurfaceResult result;
        binder::Status status = mClient->createSurface(std::string(name.string()), flags,
                                                       parentHandle, std::move(metadata), &result);
        ...
        if (err == NO_ERROR) {
            *outSurface = new SurfaceControl(this, result.handle, result.layerId,
                                             toString(result.layerName), w, h, format,
                                             result.transformHint, flags);
        }
    }
}
```

关键点：  
- Binder 调用参数里只有 `name/flags/parent/metadata`，接口定义就是这样（没有显式 w/h/format）
- `w/h/format` 是客户端构造 `SurfaceControl` 时保存下来，供后续 `getSurface()` 初始化 BLAST 用

AIDL 定义可见：

```48:48:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/aidl/android/gui/ISurfaceComposerClient.aidl
CreateSurfaceResult createSurface(@utf8InCpp String name, int flags, @nullable IBinder parent, in LayerMetadata metadata);
```

#### 2.3 服务端 `Client::createSurface` -> `SurfaceFlinger::createLayer`

```51:60:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/services/surfaceflinger/Client.cpp
binder::Status Client::createSurface(const std::string& name, int32_t flags,
                                     const sp<IBinder>& parent, const gui::LayerMetadata& metadata,
                                     gui::CreateSurfaceResult* outResult) {
    LayerCreationArgs args(mFlinger.get(), sp<Client>::fromExisting(this), name.c_str(),
                           static_cast<uint32_t>(flags), std::move(metadata));
    args.parentHandle = parent;
    const status_t status = mFlinger->createLayer(args, *outResult);
    return binderStatusFromStatusT(status);
}
```

`LayerCreationArgs` 里会记录调用方 pid/uid、metadata 等：

```32:45:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/services/surfaceflinger/FrontEnd/LayerCreationArgs.cpp
LayerCreationArgs::LayerCreationArgs(SurfaceFlinger* flinger, sp<Client> client, std::string name,
                                     uint32_t flags, gui::LayerMetadata metadataArg, ...)
      : flinger(flinger), client(std::move(client)), name(std::move(name)), flags(flags),
        metadata(std::move(metadataArg)) {
    IPCThreadState* ipc = IPCThreadState::self();
    ownerPid = ipc->getCallingPid();
    uid_t callingUid = ipc->getCallingUid();
    metadata.setInt32(gui::METADATA_CALLING_UID, static_cast<int32_t>(callingUid));
    ownerUid = callingUid;
```

SF 侧创建 Layer 并返回 handle/layerId/transformHint：

```5410:5455:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/services/surfaceflinger/SurfaceFlinger.cpp
status_t SurfaceFlinger::createLayer(LayerCreationArgs& args, gui::CreateSurfaceResult& outResult) {
    ...
    switch (args.flags & ISurfaceComposerClient::eFXSurfaceMask) {
        case ISurfaceComposerClient::eFXSurfaceBufferQueue:
        case ISurfaceComposerClient::eFXSurfaceContainer:
        case ISurfaceComposerClient::eFXSurfaceBufferState:
            args.flags |= ISurfaceComposerClient::eNoColorFill;
            FMT_FALLTHROUGH;
        case ISurfaceComposerClient::eFXSurfaceEffect: {
            result = createBufferStateLayer(args, &outResult.handle, &layer);
        } break;
        ...
    }
    ...
    result = addClientLayer(args, outResult.handle, layer, parent, &outTransformHint);
    ...
    outResult.transformHint = static_cast<int32_t>(outTransformHint);
    outResult.layerId = layer->sequence;
    outResult.layerName = String16(layer->getDebugName());
}
```

---

### 3) `surfaceControl->getSurface()` 这条链

#### 3.1 懒创建：第一次 `getSurface()` 才真正建生产端

```137:157:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/SurfaceControl.cpp
sp<Surface> SurfaceControl::generateSurfaceLocked()
{
    uint32_t ignore;
    auto flags = mCreateFlags & (ISurfaceComposerClient::eCursorWindow |
                                 ISurfaceComposerClient::eOpaque);
    mBbqChild = mClient->createSurface(String8("bbq-wrapper"), 0, 0, mFormat,
                                       flags, mHandle, {}, &ignore);
    mBbq = sp<BLASTBufferQueue>::make("bbq-adapter", mBbqChild, mWidth, mHeight, mFormat);
    mSurfaceData = mBbq->getSurface(true);
    return mSurfaceData;
}

sp<Surface> SurfaceControl::getSurface()
{
    Mutex::Autolock _l(mLock);
    if (mSurfaceData == nullptr) {
        return generateSurfaceLocked();
    }
    return mSurfaceData;
}
```

这里有个很关键的点：  
`getSurface()` 里又触发了一次 `createSurface("bbq-wrapper"... parent=mHandle)`，创建了一个 **子 layer** 作为 BLAST wrapper。也就是你只写了两行，但底层通常是“主 layer + bbq-wrapper layer”两层协作。

#### 3.2 BLAST 返回 `BBQSurface`（`Surface` 子类）供 CPU/GPU 生产 buffer

```194:198:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/BLASTBufferQueue.cpp
BLASTBufferQueue::BLASTBufferQueue(const std::string& name, const sp<SurfaceControl>& surface,
                                   int width, int height, int32_t format)
      : BLASTBufferQueue(name) {
    update(surface, width, height, format);
}
```

```948:954:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/BLASTBufferQueue.cpp
sp<Surface> BLASTBufferQueue::getSurface(bool includeSurfaceControlHandle) {
    ...
    return new BBQSurface(mProducer, true, scHandle, this);
}
```

---

### 4) 这两行最终“拿到的是什么”

- `surfaceControl`：控制 Layer 属性（show/layer/matrix/alpha 等）的控制句柄
- `surface`：向该 Layer 提交图像 buffer 的生产端接口（后续 `lock/unlockAndPost` 会走 `queueBuffer`）

对应 `Surface` 里：

```2355:2368:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/Surface.cpp
status_t Surface::lock(
        ANativeWindow_Buffer* outBuffer, ARect* inOutDirtyBounds)
{
    ...
    status_t err = dequeueBuffer(&out, &fenceFd);
    ...
}
```

```2450:2463:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/Surface.cpp
status_t Surface::unlockAndPost()
{
    ...
    err = queueBuffer(mLockedBuffer.get(), fd);
    ...
}
```

---

如果你愿意，我下一步可以接着把这条链路画成“**进程/线程视角**”的时序（app进程 binder线程、SF主线程、事务提交点），这样你看 `t1.apply()` 和 `lock/unlockAndPost()` 在 SF 里何时生效会更直观。

---

**User**

帮我结合源码分析一下layer和物理buffer的关系、以及buffer的生产消费者模型

---

**Cursor**

我先把 `Layer`、`BufferQueue`、`Surface/BLAST` 和 `SurfaceFlinger` 中关键实现点串起来，再给你一版“源码对应关系图”。



## 1) `Layer` 和“物理 buffer”的关系

**结论：`Layer` 不是像素内存本体，`Layer` 是“显示对象 + 状态机”；像素数据在 `GraphicBuffer`（gralloc 分配的物理/共享内存）里。**

`Layer` 里保存的是“当前用于合成的 buffer 及其元信息（fence、frameNumber、crop、transform）”，例如：

```141:161:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/services/surfaceflinger/Layer.h
uint64_t frameNumber;
...
std::shared_ptr<renderengine::ExternalTexture> buffer;
sp<Fence> acquireFence;
std::shared_ptr<FenceTime> acquireFenceTime;
HdrMetadata hdrMetadata;
Region surfaceDamageRegion;
```

当新帧到来时，`Layer::setBuffer()` 把新的 `ExternalTexture/GraphicBuffer` 和 fence 更新到 drawing state：

```3043:3112:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/services/surfaceflinger/Layer.cpp
bool Layer::setBuffer(std::shared_ptr<renderengine::ExternalTexture>& buffer,
                      const BufferData& bufferData, ...)
{
    ...
    mDrawingState.buffer = std::move(buffer);
    mDrawingState.acquireFence = ... ? bufferData.acquireFence : Fence::NO_FENCE;
    mDrawingState.acquireFenceTime = std::make_unique<FenceTime>(mDrawingState.acquireFence);
    ...
}
```

所以可以理解为：

- 一个 `Layer` 生命周期里会关联**很多帧**的 buffer（随时间滚动）
- 同一时刻用于显示的是“当前 latched 的那一帧 buffer”
- `Layer` 管的是“哪张 buffer + 怎么显示”，不是“存像素”

---

## 2) Producer-Consumer 模型（BufferQueue）

这是标准“生产者-消费者队列 + slot 池 + fence 同步”模型。

### 2.1 队列怎么建：一对 Producer/Consumer 共享同一个 Core

```97:113:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/BufferQueue.cpp
void BufferQueue::createBufferQueue(sp<IGraphicBufferProducer>* outProducer,
        sp<IGraphicBufferConsumer>* outConsumer, bool consumerIsSurfaceFlinger) {
    sp<BufferQueueCore> core(new BufferQueueCore());
    sp<IGraphicBufferProducer> producer(new BufferQueueProducer(core, consumerIsSurfaceFlinger));
    sp<IGraphicBufferConsumer> consumer(new BufferQueueConsumer(core));
```

### 2.2 生产者（App/Surface）流程

- `dequeueBuffer`：拿可写 slot，必要时分配 `GraphicBuffer`
- CPU/GPU 写入
- `queueBuffer`：把 slot 入队，并带上 acquire fence + frameNumber

`dequeue` 里可见按需创建 `GraphicBuffer`：

```572:586:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/BufferQueueProducer.cpp
sp<GraphicBuffer> graphicBuffer = new GraphicBuffer(
        width, height, format, BQ_LAYER_COUNT, usage,
        {mConsumerName.string(), mConsumerName.size()});
...
mSlots[*outSlot].mGraphicBuffer = graphicBuffer;
```

`queueBuffer` 会写入 fence、frame counter、并推入队列：

```931:941:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/BufferQueueProducer.cpp
mSlots[slot].mFence = acquireFence;
mSlots[slot].mBufferState.queue();

++mCore->mFrameCounter;
currentFrameNumber = mCore->mFrameCounter;
mSlots[slot].mFrameNumber = currentFrameNumber;

item.mAcquireCalled = mSlots[slot].mAcquireCalled;
item.mGraphicBuffer = mSlots[slot].mGraphicBuffer;
```

### 2.3 消费者（SF 侧）流程

消费者从队列取最新可用帧 `acquireBuffer`，显示后 `releaseBuffer` 返还 slot：

```79:96:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/BufferQueueConsumer.cpp
status_t BufferQueueConsumer::acquireBuffer(BufferItem* outBuffer,
        nsecs_t expectedPresent, uint64_t maxFrameNumber) {
    ...
    if (mCore->mQueue.empty() && !sharedBufferAvailable) {
        return NO_BUFFER_AVAILABLE;
    }
```

```443:452:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/BufferQueueConsumer.cpp
status_t BufferQueueConsumer::releaseBuffer(int slot, uint64_t frameNumber,
        const sp<Fence>& releaseFence, EGLDisplay eglDisplay,
        EGLSyncKHR eglFence) {
    ...
    if (slot < 0 || slot >= BufferQueueDefs::NUM_BUFFER_SLOTS ||
            releaseFence == nullptr) {
```

---

## 3) 在 SF 体系里，谁在消费？

在你这个场景（`SurfaceControl->getSurface()`）下，客户端走的是 **BLASTBufferQueue**。  
BLAST 内部持有 `Producer + Consumer`，并在 `onFrameAvailable` 时 acquire，再组 transaction 送 SF：

```147:156:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/BLASTBufferQueue.cpp
BLASTBufferQueue::BLASTBufferQueue(const std::string& name, bool updateDestinationFrame)
      : ... {
    createBufferQueue(&mProducer, &mConsumer);
    ...
    mBufferItemConsumer->setFrameAvailableListener(this);
}
```

```691:739:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/libs/gui/BLASTBufferQueue.cpp
void BLASTBufferQueue::onFrameAvailable(const BufferItem& item) {
    ...
    mNumFrameAvailable++;
    ...
    acquireNextBufferLocked(std::nullopt);
}
```

这一步之后，buffer 会通过 transaction 变成 Layer 的新内容（即前面 `Layer::setBuffer` 的状态更新）。

---

## 4) 合成阶段：buffer 进入 GPU 或 HWC

### 4.1 若走 client composition（GPU），LayerFE 把 buffer/fence 填到渲染设置

```223:250:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/services/surfaceflinger/LayerFE.cpp
layerSettings.source.buffer.buffer = mSnapshot->externalTexture;
layerSettings.source.buffer.isOpaque = mSnapshot->contentOpaque;
layerSettings.source.buffer.fence = mSnapshot->acquireFence;
...
layerSettings.frameNumber = mSnapshot->frameNumber;
layerSettings.bufferId = mSnapshot->externalTexture->getId();
```

### 4.2 若走 device composition（HWC），OutputLayer 把 buffer 交给 HWC layer

```683:693:/home/szbaijie/A733/qihua-x733-android15/android14/frameworks/native/services/surfaceflinger/CompositionEngine/src/OutputLayer.cpp
if (auto error = hwcLayer->setBuffer(hwcSlotAndBuffer.slot, hwcSlotAndBuffer.buffer, hwcFence);
    error != hal::Error::NONE) {
    ALOGE("[%s] Failed to set buffer %p: %s (%d)", ...
}
```

---

## 5) 一句话时序图（你可以直接带入 self_test）

`Surface.lock/dequeue -> 写像素 -> unlockAndPost/queue -> BufferQueue 入队 -> BLAST onFrameAvailable acquire -> transaction.setBuffer -> Layer::setBuffer -> CompositionEngine -> HWC/GPU 合成 -> present -> releaseBuffer 回 producer`

---

如果你愿意，我可以下一条专门画出**“一个 slot 在 Dequeued/Queued/Acquired/Free 之间如何流转”**，把 `mSlots[]` 状态机和 fence 方向（acquire fence / release fence）也画出来。

