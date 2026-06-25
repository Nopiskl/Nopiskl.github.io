
**User**

帮我分析一下@self_test.cpp (39-40) 是如何通过层层操作到具体的一块buffer的？又是怎样通过DRM同步到内核的buffer块最后显示到屏幕上的，不用创建文档直接给我说就行

---

**Cursor**


你这个问题问得很到位。先说结论：

- `self_test.cpp` 的 **39-40 行（你这里是开始创建 `Transaction t1`）本身并不会触达具体 buffer**，它做的是“层状态事务”（Z 顺序、可见性）。
- 真正触达某一块 buffer，是后面的 `surface->lock()` / `unlockAndPost()` 那条链路。
- 从 SF 到 DRM 显示，核心是 **buffer + acquire/release/present fence** 一路传到 HWC，再由 HWC（DRM 方案下）做 atomic commit 给内核。

---

### 1）你问的 39-40 行，层层调用到哪里？

你这段是：

- `t1.setLayer(surfaceControl, 100000);`
- `t1.show(surfaceControl);`
- `t1.apply();`

这条链路是“Layer 状态控制”：

1. `setLayer()`  
   在 `SurfaceComposerClient::Transaction` 里把 `layer_state_t` 标记 `eLayerChanged`，写入 `z` 值。
2. `show()`  
   本质是 `setFlags(..., 0, eLayerHidden)`，把 hidden 位清掉（即显示）。
3. `apply()`  
   把 transaction 打包成 `ComposerState/DisplayState`，通过 `ISurfaceComposer::setTransactionState(...)` 发给 SurfaceFlinger。
4. SurfaceFlinger 收到后，在 `SurfaceFlinger::setTransactionState(...)` 入队 transaction，主线程 commit 时应用到对应 `Layer`。

> 这一步只是在 SF 中修改 Layer 的“属性状态”（可见、层级、变换等），还没有“写像素”。

---

### 2）什么时候才到“具体一块 buffer”？

是 `surface->lock()` / `unlockAndPost()`：

1. `Surface::lock()`  
   - 调 `dequeueBuffer()` 向 `IGraphicBufferProducer`（BufferQueue producer 端）要一个 slot。  
   - 拿到对应 `GraphicBuffer`，`outBuffer.bits` 映射给 CPU 写。
2. 你在用户态把 `outBuffer.bits` 填红/填绿。
3. `Surface::unlockAndPost()`  
   - 先 `unlockAsync()` 拿到一个 fence fd（写完信号）。  
   - 再 `queueBuffer(slot, input)` 入队到 BufferQueue。
4. SF 下一帧 `latchBuffers()` 时，从这个 Layer 对应的 consumer 侧把最新 queued buffer latch 到 Layer 当前帧。

---

### 3）从 SF 到 DRM/内核再到屏幕（你关心的“DRM同步”）

从 `latch` 之后开始：

1. SF `commit()` 后进入 `composite()`，调用 `mCompositionEngine->present(refreshArgs)`。
2. CompositionEngine/HWComposer 路径中，最终走到：
   - `HWComposer::presentAndGetReleaseFences(...)`
   - `HWC2::Display::present(...)`
   - 底层 composer HAL `presentDisplay(...)`
3. **DRM 设备上**，vendor HWC 通常会：
   - 把 gralloc/dma-buf 对应的 buffer 绑定到 plane/crtc（atomic state）；
   - 把 acquire fence 作为 in-fence 提给内核；
   - 做 `drmModeAtomicCommit(...)`（非阻塞或阻塞视实现）。
4. 内核 KMS 在合适时机（通常 vblank）切换扫描源，开始从这块 buffer 扫描输出到屏幕。
5. 返回链路：
   - HWC 返回 `presentFence`（显示时序相关）；
   - 返回每层 `releaseFence`（该层 buffer 可被生产者重用）。
6. SF 把 release fence 回传，生产者下一次可安全重用这块 buffer。

---

### 4）一句话串起来

- `setLayer/show/apply`：只是把这层“放到前面并显示”；
- `lock/fill/unlockAndPost`：才是“把像素写进某个 GraphicBuffer 并入队”；
- SF `latch + composite + present`：把这块 buffer 交给 HWC；
- DRM 内核通过 atomic commit + fence 同步，在 vblank 后真正显示到屏幕。

---

如果你愿意，我下一步可以按你这份 `self_test.cpp`，给你画一个“**精确到函数名**”的时序图（App 线程 / Binder 线程 / SF 主线程 / HWC HAL / DRM KMS）。

---

**User**

结合具体源码分析一下

---

**Cursor**

Need snippets read these line ranges.

好的，我们就**按你这个 `self_test.cpp` 实际源码**，从 `39-40` 开始一路走到显示，串一遍“到底是哪块 buffer、怎么同步到内核”的链路。

---

## 1）`39-40` 先做了什么：创建 Layer（不是写 buffer）

`39-40` 是 `createSurface`，它先在 SF 创建 Layer/handle，再在客户端创建 `SurfaceControl`：

```39:42:android14/frameworks/native/services/surfaceflinger/tests/self_test/self_test.cpp
sp<SurfaceControl> surfaceControl = client->createSurface(String8("resize"),
        160, 240, PIXEL_FORMAT_RGB_565, 0);

sp<Surface> surface = surfaceControl->getSurface();
```

客户端 `createSurfaceChecked` 通过 binder 调 `mClient->createSurface(...)`，成功后拿 `result.handle/layerId` 构造 `SurfaceControl`：

```2417:2437:android14/frameworks/native/libs/gui/SurfaceComposerClient.cpp
status_t SurfaceComposerClient::createSurfaceChecked(...){
    ...
    gui::CreateSurfaceResult result;
    binder::Status status = mClient->createSurface(std::string(name.string()), flags,
                                                   parentHandle, std::move(metadata), &result);
    ...
    *outSurface = new SurfaceControl(this, result.handle, result.layerId,
                                     toString(result.layerName), w, h, format,
                                     result.transformHint, flags);
}
```

SF 侧对应创建 Layer：

```5410:5438:android14/frameworks/native/services/surfaceflinger/SurfaceFlinger.cpp
status_t SurfaceFlinger::createLayer(LayerCreationArgs& args, gui::CreateSurfaceResult& outResult) {
    ...
    result = createBufferStateLayer(args, &outResult.handle, &layer);
    ...
    result = addClientLayer(args, outResult.handle, layer, parent, &outTransformHint);
    ...
    outResult.layerId = layer->sequence;
}
```

---

## 2）`getSurface()` 后，实际用的是 BLAST/BufferQueue producer

`surfaceControl->getSurface()` 会生成 `BLASTBufferQueue` 包装的 `Surface`，这个 `Surface` 就是后续 `lock/unlockAndPost` 的入口：

```137:151:android14/frameworks/native/libs/gui/SurfaceControl.cpp
sp<Surface> SurfaceControl::generateSurfaceLocked()
{
    ...
    mBbq = sp<BLASTBufferQueue>::make("bbq-adapter", mBbqChild, mWidth, mHeight, mFormat);
    mSurfaceData = mBbq->getSurface(true);
    return mSurfaceData;
}
```

---

## 3）`t1.setLayer/show/apply` 只改 Layer 状态（Z/hidden）

你这几行：

```45:48:android14/frameworks/native/services/surfaceflinger/tests/self_test/self_test.cpp
SurfaceComposerClient::Transaction t1;
t1.setLayer(surfaceControl, 100000);
t1.show(surfaceControl);
t1.apply();
```

`setLayer` 设置 `eLayerChanged + z`，`show` 清除 hidden flag：

```1361:1383:android14/frameworks/native/libs/gui/SurfaceComposerClient.cpp
SurfaceComposerClient::Transaction& SurfaceComposerClient::Transaction::show(
        const sp<SurfaceControl>& sc) {
    return setFlags(sc, 0, layer_state_t::eLayerHidden);
}
...
SurfaceComposerClient::Transaction& SurfaceComposerClient::Transaction::setLayer(
        const sp<SurfaceControl>& sc, int32_t z) {
    ...
    s->what |= layer_state_t::eLayerChanged;
    s->z = z;
    ...
}
```

`apply()` 打包后走 binder 到 SF 的 `setTransactionState(...)`：

```1156:1203:android14/frameworks/native/libs/gui/SurfaceComposerClient.cpp
status_t SurfaceComposerClient::Transaction::apply(bool synchronous, bool oneWay) {
    ...
    Vector<ComposerState> composerStates;
    ...
    for (auto const& kv : mComposerStates) {
        composerStates.add(kv.second);
    }
    ...
    sf->setTransactionState(..., composerStates, ...);
}
```

SF 收到后入事务队列：

```4576:4588:android14/frameworks/native/services/surfaceflinger/SurfaceFlinger.cpp
status_t SurfaceFlinger::setTransactionState(...) {
    ...
    IPCThreadState* ipc = IPCThreadState::self();
    const int originPid = ipc->getCallingPid();
    ...
}
```

---

## 4）真正“到一块具体 buffer”是 `lock/unlockAndPost`

你后面第一帧/第二帧才真正写像素。

### 4.1 `lock`：dequeue 一个 slot 对应的 `GraphicBuffer` 并映射 CPU 地址

```2355:2375:android14/frameworks/native/libs/gui/Surface.cpp
status_t Surface::lock(ANativeWindow_Buffer* outBuffer, ARect* inOutDirtyBounds)
{
    ...
    status_t err = dequeueBuffer(&out, &fenceFd);
    ...
}
```

拿到后 `lockAsync`，把 `outBuffer.bits` 指向这块 gralloc buffer 的映射地址：

```2428:2432:android14/frameworks/native/libs/gui/Surface.cpp
void* vaddr;
status_t res = backBuffer->lockAsync(
        GRALLOC_USAGE_SW_READ_OFTEN | GRALLOC_USAGE_SW_WRITE_OFTEN,
        newDirtyRegion.bounds(), &vaddr, fenceFd);
```

### 4.2 `unlockAndPost`：生成写入完成 fence，然后 queueBuffer 入队

```2450:2463:android14/frameworks/native/libs/gui/Surface.cpp
status_t Surface::unlockAndPost()
{
    ...
    status_t err = mLockedBuffer->unlockAsync(&fd);
    ...
    err = queueBuffer(mLockedBuffer.get(), fd);
    ...
}
```

`queueBuffer` 核心是调用 `mGraphicBufferProducer->queueBuffer(...)`：

```1096:1124:android14/frameworks/native/libs/gui/Surface.cpp
int Surface::queueBuffer(android_native_buffer_t* buffer, int fenceFd) {
    ...
    status_t err = mGraphicBufferProducer->queueBuffer(i, input, &output);
    ...
}
```

> 到这里，“具体哪块 buffer”就明确了：`dequeue` 出来的 slot `i` 对应那块 `GraphicBuffer`。

---

## 5）SF 侧 latch：把这个 queued buffer 变成当前合成输入

SF 在主线程 `latchBuffers()` 遍历层，把 ready frame latch：

```4128:4191:android14/frameworks/native/services/surfaceflinger/SurfaceFlinger.cpp
bool SurfaceFlinger::latchBuffers() {
    ...
    if (!mLayersWithQueuedFrames.empty()) {
        ...
        for (const auto& layer : mLayersWithQueuedFrames) {
            ...
            if (layer->latchBuffer(visibleRegions, latchTime)) {
                mLayersPendingRefresh.push_back(layer);
                newDataLatched = true;
            }
        }
    }
    ...
}
```

---

## 6）合成与提交：SF -> CompositionEngine -> HWC

SF `composite()` 中调用 `mCompositionEngine->present(...)`：

```2586:2589:android14/frameworks/native/services/surfaceflinger/SurfaceFlinger.cpp
void SurfaceFlinger::composite(TimePoint frameTime, VsyncId vsyncId) {
    ATRACE_FORMAT("%s %" PRId64, __func__, vsyncId.value);
```

```2682:2685:android14/frameworks/native/services/surfaceflinger/SurfaceFlinger.cpp
std::vector<std::pair<Layer*, LayerFE*>> layers =
        moveSnapshotsToCompositionArgs(refreshArgs, /*cursorOnly=*/false, vsyncId.value);
mCompositionEngine->present(refreshArgs);
moveSnapshotsFromCompositionArgs(refreshArgs, layers);
```

---

## 7）HWC 提交与 fence：到内核显示同步点

HWC 侧 `presentAndGetReleaseFences`：

```509:537:android14/frameworks/native/services/surfaceflinger/DisplayHardware/HWComposer.cpp
status_t HWComposer::presentAndGetReleaseFences(...) {
    ...
    auto error = hwcDisplay->present(&displayData.lastPresentFence);
    ...
    error = hwcDisplay->getReleaseFences(&releaseFences);
    ...
}
```

`hwcDisplay->present()` 最终是调用 composer HAL 的 `presentDisplay`：

```394:404:android14/frameworks/native/services/surfaceflinger/DisplayHardware/HWC2.cpp
Error Display::present(sp<Fence>* outPresentFence)
{
    int32_t presentFenceFd = -1;
    auto intError = mComposer.presentDisplay(mId, &presentFenceFd);
    ...
    *outPresentFence = sp<Fence>::make(presentFenceFd);
}
```

---

## 8）你问的“DRM 同步到内核 buffer 块最后显示”如何理解

AOSP 到这里为止只到 `presentDisplay`（composer HAL 接口）。  
**再往下是 vendor HWC 实现**（通常在 vendor 目录，不在你刚看的这几个 AOSP 文件里）：

- 把 layer buffer（通常 dma-buf）配置到 KMS plane/CRTC；
- 带上 acquire fence（in-fence）做显示时序同步；
- 执行 DRM atomic commit；
- 内核在 vblank 时切换扫描；
- 返回 present fence / release fences 给上层。

所以你看到的 fence 语义是闭环的：

- App 写完：`unlockAsync` 产生/传递 fence；
- SF/HWC 等待可用后提交；
- 显示后返回 `presentFence`、每层 `releaseFence`，生产者才能安全复用那块 buffer。

---

如果你要，我可以下一条把这份 `self_test.cpp` 的两帧（红、绿）按时间轴展开成“slot0/slot1 在每个阶段的状态变化表”（DEQUEUED/QUEUED/ACQUIRED/FREE）给你。

