# Codec2 component implementation analysis
_Exported on 2026/3/18 at GMT+8 20:05:35 from Cursor (2.3.34)_

---

**User**

@android14/hardware/aw/libcodec2 结合AW的codec2分析一下厂商应该实现component的哪些内容

---

**Cursor**

我来分析一下AW（全志）的codec2实现，了解厂商需要实现的组件内容。

现在我已经收集了足够的信息，可以进行全面分析了。让我再看一下 config 和 vndk 部分：

现在我已经收集了足够的信息进行全面分析。以下是基于AW（全志）libcodec2代码的完整分析：

---

## AW Codec2 厂商 Component 实现分析

### 整体架构层次

```
应用/Framework
    │
    ▼
C2ComponentStore (C2AwComponentStore)
    │  dlopen 各 .so
    ▼
C2ComponentFactory (per codec .so)
    │  CreateCodec2Factory / DestroyCodec2Factory
    ▼
XxxDecComponent / XxxEncComponent  (继承 HwC2Component，继承 C2Component)
    │
    ├── IntfImpl (继承 HwC2Interface<void>::BaseParams，管理参数)
    │
    └── VdecComponent / VencComponent  (真正的硬件解/编码逻辑)
            │
            └── vdecoder/vencoder (AW 私有硬件 VE 驱动接口)
```

---

### 一、必须实现的 C2ComponentFactory（每个 codec .so 的入口）

每个 codec 动态库必须导出以下两个 C 符号：

```cpp
extern "C" ::C2ComponentFactory *CreateCodec2Factory();
extern "C" void DestroyCodec2Factory(::C2ComponentFactory *factory);
```

`C2ComponentFactory` 需实现：
- `createComponent(id, component, deleter)` — 创建组件实例
- `createInterface(id, interface, deleter)` — 创建接口实例（用于查询 traits，不启动硬件）

AW 的做法见 `AvcDecComponent.cpp` 底部的 `AvcDecComponentFactory`。

---

### 二、必须实现的 C2Component 生命周期接口

`HwC2Component` 继承自 `C2Component`，已实现了线程调度骨架（ALooper/AHandler），但以下纯虚函数**必须由具体 codec 组件覆写**：

| 纯虚函数 | 调用时机 | 说明 |
|---|---|---|
| `onInit()` | 首次 `start()` 时 | 初始化硬件解码器，分配资源 |
| `onStart()` | 非首次 `start()` 时 | 恢复运行状态 |
| `onStop()` | `stop()` | 停止处理，释放临时资源 |
| `onReset()` | `reset()` | 重置到初始化前状态 |
| `onRelease()` | `release()` | 释放所有资源，销毁硬件上下文 |
| `onFlush_sm()` | `flush_sm()` | 冲洗内部缓冲，丢弃待处理数据 |
| `process(work, pool)` | 每帧工作队列调度 | **核心**：取输入 buffer，调用硬件，产出输出 buffer |
| `drain(drainMode, pool)` | `drain_nb()` | 排出解码器内部缓存的剩余帧（EOS 处理） |

AW 的实现方式是在 `AvcDecComponent` 中全部委托给内部的 `VdecComponent`：

```cpp
// AvcDecComponent.cpp
c2_status_t AvcDecComponent::onInit()     { return mCodec->onInit(); }
c2_status_t AvcDecComponent::onStart()    { return mCodec->onStart(); }
c2_status_t AvcDecComponent::onStop()     { return mCodec->onStop(); }
void        AvcDecComponent::onReset()    { mCodec->onReset(); }
void        AvcDecComponent::onRelease()  { mCodec->onRelease(); }
c2_status_t AvcDecComponent::onFlush_sm(){ return mCodec->onFlush_sm(); }

void AvcDecComponent::process(const std::unique_ptr<C2Work> &work,
                              const std::shared_ptr<C2BlockPool> &pool) {
  mCodec->setRuningComp(shared_from_this());
  mCodec->process(work, pool);
}
```

---

### 三、IntfImpl（参数接口）必须实现的内容

每个 codec 组件需要定义内部类 `IntfImpl`，继承 `HwC2Interface<void>::BaseParams`（即 `C2InterfaceHelper`）。需要通过 `addParameter(DefineParam(...).build())` 注册的参数：

**解码器必须注册：**

| 参数 Key | 类型 | 说明 |
|---|---|---|
| `C2_PARAMKEY_OUTPUT_DELAY` | `C2PortActualDelayTuning::output` | 输出延迟帧数 |
| `C2_PARAMKEY_OUTPUT_REORDER_DEPTH` | `C2PortReorderBufferDepthTuning::output` | reorder 深度 |
| `C2_PARAMKEY_COMPONENT_ATTRIBUTES` | `C2ComponentAttributesSetting` | 时序属性 |
| `C2_PARAMKEY_PICTURE_SIZE` | `C2StreamPictureSizeInfo::output` | 输出图像分辨率 |
| `C2_PARAMKEY_MAX_PICTURE_SIZE` | `C2StreamMaxPictureSizeTuning::output` | 最大分辨率 |
| `C2_PARAMKEY_PROFILE_LEVEL` | `C2StreamProfileLevelInfo::input` | 支持的 Profile/Level |
| `C2_PARAMKEY_INPUT_MAX_BUFFER_SIZE` | `C2StreamMaxBufferSizeInfo::input` | 输入 buffer 最大尺寸 |
| `C2_PARAMKEY_CODED_COLOR_INFO` | `C2StreamColorInfo::output` | 颜色格式 |
| `C2_PARAMKEY_DEFAULT_COLOR_ASPECTS` | `C2StreamColorAspectsTuning::output` | 默认色彩空间 |
| `C2_PARAMKEY_VUI_COLOR_ASPECTS` | `C2StreamColorAspectsInfo::input` | 码流中的色彩空间 |
| `C2_PARAMKEY_COLOR_ASPECTS` | `C2StreamColorAspectsInfo::output` | 最终输出色彩空间 |
| `C2_PARAMKEY_PIXEL_FORMAT` | `C2StreamPixelFormatInfo::output` | 像素格式（如 YUV420_888） |

**编码器在此基础上还需注册：**
分辨率、帧率、码率、Profile/Level、GOP/I帧间隔、QP 范围、码控模式、IntraRefresh、请求关键帧等。

**参数需要实现对应的 Setter 函数**，如：

```cpp
static C2R SizeSetter(bool, const C2P<C2StreamPictureSizeInfo::output> &old,
                      C2P<C2StreamPictureSizeInfo::output> &me);
static C2R ProfileLevelSetter(...);
static C2R ColorAspectsSetter(...);
```

---

### 四、`process()` 函数中的核心工作

`process()` 是每帧数据流的核心，需要完成：

1. **解析输入 work**：读取 `work->input.buffers`、时间戳 `ordinal`、flags（EOS等）
2. **处理 codec config data**（SPS/PPS 等），见 `VdecComponent::dealwithinitdate()`
3. **提交码流到硬件解码器**：`submitInputStream()`，调用 AW vdecoder API
4. **申请输出 GraphicBlock**：通过 `C2BlockPool::fetchGraphicBlock()` 申请图形 buffer
5. **初始化解码器输出地址**：`initDecoderAddress()` 将 GraphicBlock 的物理地址传给 VE
6. **获取解码输出图像**：调用 `GetVideoPicture()`，触发 DI（去隔行）或 AISR（超分）后处理
7. **填充输出 work**：`fillWork()` 将 `VideoPicture` 包装为 `C2GraphicBlock`，设置 crop、颜色信息
8. **回调 onWorkDone**：通过 `mWorkHandlerCb` 或直接调用 `handleWorkCb()` → `listener->onWorkDone_nb()`

---

### 五、`drain()` 必须实现的 EOS 处理

```cpp
c2_status_t VdecComponent::drainInternal(uint32_t drainMode,
    const std::shared_ptr<C2BlockPool> &pool,
    const std::unique_ptr<C2Work> &work) {
    // 1. 向硬件解码器发送 EOS 信号
    // 2. 循环 GetVideoPicture() 取出残留帧
    // 3. 最后一帧的 work 标记 FLAG_END_OF_STREAM
    // 4. 发送空的 EOS work 给上层
}
```

---

### 六、ComponentStore 注册（`C2Store.cpp`）

厂商需要在 `C2AwComponentStore` 构造函数中 `emplace` 所有 codec .so 路径：

```cpp
emplace("libcodec2_hw_avcdec.so");
emplace("libcodec2_hw_hevcdec.so");
emplace("libcodec2_hw_avcenc.so");
// ...
```

Store 通过 `GetCodec2HwComponentStore()` 全局单例暴露，在 `vendor.cpp` 的 `main()` 中注册为 HIDL service：

```cpp
store = new ComponentStore(android::GetCodec2HwComponentStore());
store->registerAsService("default");
```

---

### 七、总结：厂商最小实现清单

```
每个 codec .so 需要实现：
├── CreateCodec2Factory / DestroyCodec2Factory  (C 符号导出)
├── XxxDecComponent / XxxEncComponent
│   ├── IntfImpl::IntfImpl()        注册所有 C2 参数
│   ├── IntfImpl 的各 Setter 函数   参数合法性校验与联动
│   ├── onInit()                    硬件初始化
│   ├── onStart() / onStop()        启停
│   ├── onReset() / onRelease()     复位/释放
│   ├── onFlush_sm()                flush 硬件 buffer
│   ├── process(work, pool)         ★ 核心帧处理
│   └── drain(drainMode, pool)      EOS 排出
│
├── VdecComponent / VencComponent   (硬件驱动封装层)
│   ├── createDecoder/destroyDecoder
│   ├── submitInputStream           喂码流给 VE
│   ├── ensureDecoderState          管理输出 buffer 池
│   ├── renderOutputBufferIfNecessary 输出帧回调
│   └── DI / AISR 后处理（可选）
│
└── C2AwComponentStore              (或复用已有 Store)
    └── emplace("libcodec2_hw_xxx.so")
```

```plaintext
应用/Framework
    │
    ▼
C2ComponentStore (C2AwComponentStore)
    │  dlopen 各 .so
    ▼
C2ComponentFactory (per codec .so)
    │  CreateCodec2Factory / DestroyCodec2Factory
    ▼
XxxDecComponent / XxxEncComponent  (继承 HwC2Component，继承 C2Component)
    │
    ├── IntfImpl (继承 HwC2Interface<void>::BaseParams，管理参数)
    │
    └── VdecComponent / VencComponent  (真正的硬件解/编码逻辑)
            │
            └── vdecoder/vencoder (AW 私有硬件 VE 驱动接口)
```

```cpp
extern "C" ::C2ComponentFactory *CreateCodec2Factory();
extern "C" void DestroyCodec2Factory(::C2ComponentFactory *factory);
```

```cpp
// AvcDecComponent.cpp
c2_status_t AvcDecComponent::onInit()     { return mCodec->onInit(); }
c2_status_t AvcDecComponent::onStart()    { return mCodec->onStart(); }
c2_status_t AvcDecComponent::onStop()     { return mCodec->onStop(); }
void        AvcDecComponent::onReset()    { mCodec->onReset(); }
void        AvcDecComponent::onRelease()  { mCodec->onRelease(); }
c2_status_t AvcDecComponent::onFlush_sm(){ return mCodec->onFlush_sm(); }

void AvcDecComponent::process(const std::unique_ptr<C2Work> &work,
                              const std::shared_ptr<C2BlockPool> &pool) {
  mCodec->setRuningComp(shared_from_this());
  mCodec->process(work, pool);
}
```

```cpp
static C2R SizeSetter(bool, const C2P<C2StreamPictureSizeInfo::output> &old,
                      C2P<C2StreamPictureSizeInfo::output> &me);
static C2R ProfileLevelSetter(...);
static C2R ColorAspectsSetter(...);
```

```cpp
c2_status_t VdecComponent::drainInternal(uint32_t drainMode,
    const std::shared_ptr<C2BlockPool> &pool,
    const std::unique_ptr<C2Work> &work) {
    // 1. 向硬件解码器发送 EOS 信号
    // 2. 循环 GetVideoPicture() 取出残留帧
    // 3. 最后一帧的 work 标记 FLAG_END_OF_STREAM
    // 4. 发送空的 EOS work 给上层
}
```

```cpp
emplace("libcodec2_hw_avcdec.so");
emplace("libcodec2_hw_hevcdec.so");
emplace("libcodec2_hw_avcenc.so");
// ...
```

```cpp
store = new ComponentStore(android::GetCodec2HwComponentStore());
store->registerAsService("default");
```

```plaintext
每个 codec .so 需要实现：
├── CreateCodec2Factory / DestroyCodec2Factory  (C 符号导出)
├── XxxDecComponent / XxxEncComponent
│   ├── IntfImpl::IntfImpl()        注册所有 C2 参数
│   ├── IntfImpl 的各 Setter 函数   参数合法性校验与联动
│   ├── onInit()                    硬件初始化
│   ├── onStart() / onStop()        启停
│   ├── onReset() / onRelease()     复位/释放
│   ├── onFlush_sm()                flush 硬件 buffer
│   ├── process(work, pool)         ★ 核心帧处理
│   └── drain(drainMode, pool)      EOS 排出
│
├── VdecComponent / VencComponent   (硬件驱动封装层)
│   ├── createDecoder/destroyDecoder
│   ├── submitInputStream           喂码流给 VE
│   ├── ensureDecoderState          管理输出 buffer 池
│   ├── renderOutputBufferIfNecessary 输出帧回调
│   └── DI / AISR 后处理（可选）
│
└── C2AwComponentStore              (或复用已有 Store)
    └── emplace("libcodec2_hw_xxx.so")
```

---

**User**

分析一下软件解码器的实现

---

**Cursor**

现在我已经有了完整的软件解码器代码，可以进行详细分析了。

---

## AW Codec2 软件解码器实现分析（以 `C2SoftGav1Dec` AV1 为例）

### 一、架构对比：软件解码器 vs 硬件解码器

| 维度 | 软件解码器（C2SoftGav1Dec） | 硬件解码器（AvcDecComponent） |
|---|---|---|
| 基类 | `SimpleC2Component` | `HwC2Component`（自研） |
| 接口基类 | `SimpleInterface<void>::BaseParams` | `HwC2Interface<void>::BaseParams` |
| 工作线程 | SimpleC2Component 内置（两个线程） | ALooper/AHandler 单消息线程 |
| 解码核心 | `libgav1::Decoder`（纯 CPU） | AW VE 硬件 + vdecoder |
| 输出 buffer | `fetchGraphicBlock` CPU 写入 | GraphicBlock 物理地址给 VE DMA |
| ComponentStore | `GetCodec2PlatformComponentStore()` | `GetCodec2HwComponentStore()` |
| 多线程解码 | `settings.threads = CPU核心数` | 硬件并行（VE 内部） |

---

### 二、整体架构

```
C2SoftGav1Dec
    │
    ├── IntfImpl (继承 SimpleInterface<void>::BaseParams)
    │       └── 注册 C2 参数（分辨率、Profile、色彩空间等）
    │
    ├── libgav1::Decoder  (Google AV1 纯软解库)
    │       ├── EnqueueFrame()   送入码流
    │       └── DequeueFrame()   取出解码帧
    │
    └── SimpleC2Component (AOSP 提供的软件组件骨架)
            ├── WorkThread       处理 process()
            └── OutputThread     处理输出回调
```

---

### 三、关键函数逐一分析

#### 1. `initDecoder()` — 解码器初始化

```cpp
bool C2SoftGav1Dec::initDecoder() {
    mCodecCtx.reset(new libgav1::Decoder());
    libgav1::DecoderSettings settings = {};
    settings.threads = GetCPUCoreCount();  // 自动检测 CPU 核心数，多线程解码
    mCodecCtx->Init(&settings);
}
```

- 直接 `new libgav1::Decoder()`，无任何硬件资源申请
- `settings.threads` 设为 CPU 核心数，最大化并行解码
- 无需提前分配输出 buffer 池（与硬件解码器的 `ensureDecoderState` / `initDecoderAddress` 有本质区别）

---

#### 2. `process()` — 核心帧处理流程

```
process(work, pool)
    │
    ├── 1. 检查错误状态 mSignalledError / mSignalledOutputEos
    │
    ├── 2. 读取输入 buffer → C2ReadView rView
    │       work->input.buffers[0]->data().linearBlocks().front().map()
    │
    ├── 3. 跳过 codec config（AV1 无 SPS/PPS，直接返回空 work）
    │
    ├── 4. EnqueueFrame() 送入码流
    │       mCodecCtx->EnqueueFrame(bitstream, inSize, frameIndex, nullptr)
    │       ★ 注意：frameIndex 作为 user_private_data 传入，用于后续帧匹配
    │
    ├── 5. outputBuffer() 尝试取出已解码帧（可能为空，属于流水线设计）
    │
    └── 6. EOS 处理 → drainInternal()
```

**软件解码的关键特点：EnqueueFrame/DequeueFrame 流水线**

libgav1 采用异步流水线：送入一帧不一定立即出帧，需要调用 `DequeueFrame` 轮询。这与硬件解码器类似，但完全在用户态 CPU 执行。

---

#### 3. `outputBuffer()` — 输出帧处理（最核心）

```
outputBuffer(pool, work)
    │
    ├── 1. DequeueFrame() 取出已解码帧
    │       const libgav1::DecoderBuffer *buffer
    │
    ├── 2. 分辨率变化检测
    │       if (width != mWidth || height != mHeight)
    │           → mIntf->config() 更新参数
    │           → work->worklets[0]->output.configUpdate 上报给框架
    │
    ├── 3. 确定输出像素格式
    │       8bit  → HAL_PIXEL_FORMAT_YV12
    │       10bit + BT2020/ST2084 → HAL_PIXEL_FORMAT_RGBA_1010102（HDR）
    │       10bit + 其他 → HAL_PIXEL_FORMAT_YV12（降位深）
    │
    ├── 4. fetchGraphicBlock() 申请输出 buffer
    │       pool->fetchGraphicBlock(align(mWidth,16), mHeight, format, usage, &block)
    │       ★ 注意：width 对齐到 16 字节
    │
    ├── 5. block->map() 获取 CPU 可写视图 C2GraphicView
    │
    ├── 6. CPU 内存拷贝：解码输出 → GraphicBlock
    │       ┌─ 8bit YUV420  → copyOutputBufferToYV12Frame() (memcpy)
    │       ├─ 10bit→8bit   → convertYUV420Planar16ToYUV420Planar() (移位)
    │       └─ 10bit→Y410   → convertYUV420Planar16ToY410() (打包 RGBA1010102)
    │
    └── 7. finishWork() 将 block 包装为 C2Buffer 回调给框架
```

**与硬件解码器的本质区别：**
- 硬件解码器：VE 直接 DMA 写到 GraphicBlock 的物理地址，**零拷贝**
- 软件解码器：libgav1 写到自己的内存，再 **memcpy** 到 GraphicBlock，有额外拷贝开销

---

#### 4. 像素格式转换函数

**`copyOutputBufferToYV12Frame()`** — 8bit YUV420 planar 直接拷贝：
```cpp
// 逐行 memcpy Y/U/V 分量，处理单色（Monochrome）时 UV 填 128
for (size_t i = 0; i < height; ++i) {
    memcpy(dstY, srcY, width);
    srcY += srcYStride; dstY += dstYStride;
}
```

**`convertYUV420Planar16ToYUV420Planar()`** — 10bit→8bit 降深：
```cpp
// 每个像素右移 2 位（10bit → 8bit）
dstY[x] = (uint8_t)(srcY[x] >> 2);
```

**`convertYUV420Planar16ToY410()`** — 10bit 打包为 RGBA_1010102（HDR 路径）：
```cpp
// 每 4 个像素批量处理，Y(10bit) << 10 | U(10bit) | V(10bit) << 20 | alpha(2bit) << 30
*dstTop++ = 3 << 30 | ((y01 & 0x3FF) << 10) | uv0;
```
一次处理 4 个像素（SIMD 友好），转换为 `RGBA_1010102` 格式供 HDR 显示。

---

#### 5. `onFlush_sm()` — flush 实现

```cpp
c2_status_t C2SoftGav1Dec::onFlush_sm() {
    mCodecCtx->SignalEOS();          // 通知 libgav1 刷出所有缓冲帧
    const libgav1::DecoderBuffer *buffer;
    mCodecCtx->DequeueFrame(&buffer); // 取走残留帧（丢弃）
    mSignalledError = false;
    mSignalledOutputEos = false;
}
```

软件解码器 flush 极简：调用 `SignalEOS` + `DequeueFrame` 排空内部缓冲即可，无需等待 VE 完成 DMA、无需归还图形 buffer 等复杂操作。

---

#### 6. `drainInternal()` — EOS 排出

```cpp
mCodecCtx->SignalEOS();          // 告知 libgav1 后续无更多输入
while (outputBuffer(pool, work)) // 循环取出所有残留解码帧
    ;
if (drainMode == DRAIN_COMPONENT_WITH_EOS && work->workletsProcessed == 0u)
    fillEmptyWork(work);         // 若无残留帧，发送空 EOS work
```

---

#### 7. `finishWork()` — 帧匹配与回调

```cpp
void C2SoftGav1Dec::finishWork(uint64_t index, ...) {
    std::shared_ptr<C2Buffer> buffer = createGraphicBuffer(block, C2Rect(mWidth, mHeight));
    auto fillWork = [buffer, index](const std::unique_ptr<C2Work> &work) {
        work->worklets.front()->output.buffers.push_back(buffer);
        work->worklets.front()->output.ordinal = work->input.ordinal;
        work->workletsProcessed = 1u;
    };
    // 用 frameIndex（即 EnqueueFrame 时传入的 user_private_data）匹配对应的 work
    if (work && c2_cntr64_t(index) == work->input.ordinal.frameIndex) {
        fillWork(work);       // 当前 work 直接填充
    } else {
        finish(index, fillWork); // 跨 work 帧，通过 SimpleC2Component::finish() 匹配
    }
}
```

`user_private_data = frameIndex` 是软件解码器追踪帧顺序的关键机制，用于处理 B 帧 reorder 场景。

---

### 四、IntfImpl 参数注册特点

软件 AV1 解码器相比 AVC 硬件解码器，额外注册了：

| 额外参数 | 说明 |
|---|---|
| `C2_PARAMKEY_INPUT_HDR10_PLUS_INFO` | HDR10+ 动态元数据（输入） |
| `C2_PARAMKEY_OUTPUT_HDR10_PLUS_INFO` | HDR10+ 动态元数据（输出） |

没有注册 `C2_PARAMKEY_OUTPUT_DELAY` 和 `C2_PARAMKEY_OUTPUT_REORDER_DEPTH`（软件解码器不需要硬件流水线延迟补偿）。

---

### 五、软件解码器实现要点总结

```
软件解码器最小实现：
├── CreateCodec2Factory / DestroyCodec2Factory
├── C2SoftXxxDec : public SimpleC2Component
│   ├── IntfImpl : public SimpleInterface<void>::BaseParams
│   │   └── 注册分辨率、Profile/Level、色彩空间等参数
│   │
│   ├── initDecoder()     创建软解码器实例，设置线程数
│   ├── destroyDecoder()  释放软解码器
│   ├── onInit()          → initDecoder()
│   ├── onStop()          重置错误/EOS 标志
│   ├── onReset()         → onStop() + onFlush_sm()
│   ├── onRelease()       → destroyDecoder()
│   ├── onFlush_sm()      SignalEOS + DequeueFrame 排空
│   │
│   ├── process()         ★ 核心
│   │   ├── EnqueueFrame() 

```plaintext
C2SoftGav1Dec
    │
    ├── IntfImpl (继承 SimpleInterface<void>::BaseParams)
    │       └── 注册 C2 参数（分辨率、Profile、色彩空间等）
    │
    ├── libgav1::Decoder  (Google AV1 纯软解库)
    │       ├── EnqueueFrame()   送入码流
    │       └── DequeueFrame()   取出解码帧
    │
    └── SimpleC2Component (AOSP 提供的软件组件骨架)
            ├── WorkThread       处理 process()
            └── OutputThread     处理输出回调
```

```cpp
bool C2SoftGav1Dec::initDecoder() {
    mCodecCtx.reset(new libgav1::Decoder());
    libgav1::DecoderSettings settings = {};
    settings.threads = GetCPUCoreCount();  // 自动检测 CPU 核心数，多线程解码
    mCodecCtx->Init(&settings);
}
```

```plaintext
process(work, pool)
    │
    ├── 1. 检查错误状态 mSignalledError / mSignalledOutputEos
    │
    ├── 2. 读取输入 buffer → C2ReadView rView
    │       work->input.buffers[0]->data().linearBlocks().front().map()
    │
    ├── 3. 跳过 codec config（AV1 无 SPS/PPS，直接返回空 work）
    │
    ├── 4. EnqueueFrame() 送入码流
    │       mCodecCtx->EnqueueFrame(bitstream, inSize, frameIndex, nullptr)
    │       ★ 注意：frameIndex 作为 user_private_data 传入，用于后续帧匹配
    │
    ├── 5. outputBuffer() 尝试取出已解码帧（可能为空，属于流水线设计）
    │
    └── 6. EOS 处理 → drainInternal()
```

```plaintext
outputBuffer(pool, work)
    │
    ├── 1. DequeueFrame() 取出已解码帧
    │       const libgav1::DecoderBuffer *buffer
    │
    ├── 2. 分辨率变化检测
    │       if (width != mWidth || height != mHeight)
    │           → mIntf->config() 更新参数
    │           → work->worklets[0]->output.configUpdate 上报给框架
    │
    ├── 3. 确定输出像素格式
    │       8bit  → HAL_PIXEL_FORMAT_YV12
    │       10bit + BT2020/ST2084 → HAL_PIXEL_FORMAT_RGBA_1010102（HDR）
    │       10bit + 其他 → HAL_PIXEL_FORMAT_YV12（降位深）
    │
    ├── 4. fetchGraphicBlock() 申请输出 buffer
    │       pool->fetchGraphicBlock(align(mWidth,16), mHeight, format, usage, &block)
    │       ★ 注意：width 对齐到 16 字节
    │
    ├── 5. block->map() 获取 CPU 可写视图 C2GraphicView
    │
    ├── 6. CPU 内存拷贝：解码输出 → GraphicBlock
    │       ┌─ 8bit YUV420  → copyOutputBufferToYV12Frame() (memcpy)
    │       ├─ 10bit→8bit   → convertYUV420Planar16ToYUV420Planar() (移位)
    │       └─ 10bit→Y410   → convertYUV420Planar16ToY410() (打包 RGBA1010102)
    │
    └── 7. finishWork() 将 block 包装为 C2Buffer 回调给框架
```

```cpp
// 逐行 memcpy Y/U/V 分量，处理单色（Monochrome）时 UV 填 128
for (size_t i = 0; i < height; ++i) {
    memcpy(dstY, srcY, width);
    srcY += srcYStride; dstY += dstYStride;
}
```

```cpp
// 每个像素右移 2 位（10bit → 8bit）
dstY[x] = (uint8_t)(srcY[x] >> 2);
```

```cpp
// 每 4 个像素批量处理，Y(10bit) << 10 | U(10bit) | V(10bit) << 20 | alpha(2bit) << 30
*dstTop++ = 3 << 30 | ((y01 & 0x3FF) << 10) | uv0;
```

```cpp
c2_status_t C2SoftGav1Dec::onFlush_sm() {
    mCodecCtx->SignalEOS();          // 通知 libgav1 刷出所有缓冲帧
    const libgav1::DecoderBuffer *buffer;
    mCodecCtx->DequeueFrame(&buffer); // 取走残留帧（丢弃）
    mSignalledError = false;
    mSignalledOutputEos = false;
}
```

```cpp
mCodecCtx->SignalEOS();          // 告知 libgav1 后续无更多输入
while (outputBuffer(pool, work)) // 循环取出所有残留解码帧
    ;
if (drainMode == DRAIN_COMPONENT_WITH_EOS && work->workletsProcessed == 0u)
    fillEmptyWork(work);         // 若无残留帧，发送空 EOS work
```

```cpp
void C2SoftGav1Dec::finishWork(uint64_t index, ...) {
    std::shared_ptr<C2Buffer> buffer = createGraphicBuffer(block, C2Rect(mWidth, mHeight));
    auto fillWork = [buffer, index](const std::unique_ptr<C2Work> &work) {
        work->worklets.front()->output.buffers.push_back(buffer);
        work->worklets.front()->output.ordinal = work->input.ordinal;
        work->workletsProcessed = 1u;
    };
    // 用 frameIndex（即 EnqueueFrame 时传入的 user_private_data）匹配对应的 work
    if (work && c2_cntr64_t(index) == work->input.ordinal.frameIndex) {
        fillWork(work);       // 当前 work 直接填充
    } else {
        finish(index, fillWork); // 跨 work 帧，通过 SimpleC2Component::finish() 匹配
    }
}
```

```plaintext
软件解码器最小实现：
├── CreateCodec2Factory / DestroyCodec2Factory
├── C2SoftXxxDec : public SimpleC2Component
│   ├── IntfImpl : public SimpleInterface<void>::BaseParams
│   │   └── 注册分辨率、Profile/Level、色彩空间等参数
│   │
│   ├── initDecoder()     创建软解码器实例，设置线程数
│   ├── destroyDecoder()  释放软解码器
│   ├── onInit()          → initDecoder()
│   ├── onStop()          重置错误/EOS 标志
│   ├── onReset()         → onStop() + onFlush_sm()
│   ├── onRelease()       → destroyDecoder()
│   ├── onFlush_sm()      SignalEOS + DequeueFrame 排空
│   │
│   ├── process()         ★ 核心
│   │   ├── EnqueueFrame() 
```

---

**User**

继续

---

**Cursor**

继续完成软件解码器实现要点总结：

---

### 五、软件解码器实现要点总结（续）

```
软件解码器最小实现：
├── CreateCodec2Factory / DestroyCodec2Factory
├── C2SoftXxxDec : public SimpleC2Component
│   ├── IntfImpl : public SimpleInterface<void>::BaseParams
│   │   └── 注册分辨率、Profile/Level、色彩空间、HDR 等参数
│   │
│   ├── initDecoder()     创建软解码器实例，设置线程数
│   ├── destroyDecoder()  释放软解码器
│   ├── onInit()          → initDecoder()
│   ├── onStop()          重置错误/EOS 标志
│   ├── onReset()         → onStop() + onFlush_sm()（软重置）
│   ├── onRelease()       → destroyDecoder()
│   ├── onFlush_sm()      SignalEOS + DequeueFrame 排空内部队列
│   │
│   ├── process(work, pool)   ★ 核心帧处理
│   │   ├── map() 获取输入 LinearBlock 只读视图
│   │   ├── EnqueueFrame(bitstream, size, frameIndex)  送码流
│   │   ├── outputBuffer()  尝试取出解码帧（流水线）
│   │   └── EOS → drainInternal()
│   │
│   ├── outputBuffer()    取帧 + 格式转换 + 填充输出
│   │   ├── DequeueFrame()             取 libgav1 解码结果
│   │   ├── 分辨率变化上报 configUpdate
│   │   ├── fetchGraphicBlock()        申请 CPU 可写输出 buffer
│   │   ├── block->map() → C2GraphicView  CPU 映射
│   │   ├── memcpy / 移位 / 打包       ★ CPU 格式转换（软解核心代价）
│   │   └── finishWork(frameIndex)     回调框架
│   │
│   ├── drainInternal()   SignalEOS + 循环 outputBuffer() 取完残帧
│   └── drain()           → drainInternal(drainMode, pool, nullptr)
│
└── 注册到 GetCodec2PlatformComponentStore()  (非 HW Store)
```

---

### 六、软硬件解码器关键差异对比

| 对比项 | 软件解码器 | 硬件解码器 |
|---|---|---|
| **基类** | `SimpleC2Component` | `HwC2Component`（AW 自研） |
| **ComponentStore** | `GetCodec2PlatformComponentStore()` | `GetCodec2HwComponentStore()` |
| **解码器初始化** | `new libgav1::Decoder()` 纯 CPU | `CreateVideoDecoder()` 申请 VE 硬件 |
| **输入喂数据** | `EnqueueFrame(ptr, size)` 直接传指针 | `SubmitVideoStreamData()` 送到 VE 输入队列 |
| **输出 buffer 管理** | 每帧按需 `fetchGraphicBlock` | 提前批量申请，物理地址注册给 VE |
| **数据拷贝** | ❌ 必须 CPU memcpy | ✅ VE DMA 零拷贝 |
| **格式转换** | CPU 移位/打包（convertYUV420Planar16To...） | 硬件输出直接为目标格式 |
| **多线程** | `settings.threads = CPU核心数` | VE 内部并行（MB 级） |
| **flush** | `SignalEOS` + `DequeueFrame` 一次排空 | 需等待 VE 完成、归还图形 buffer、重置 DI/AISR |
| **10bit HDR** | 支持（转 RGBA_1010102） | 通过 `mAfbcModeFlag`/`m10bitVideoFlag` 硬件处理 |
| **secure 解码** | ❌ 不支持 | ✅ 独立 secure 组件（avcdec_secure） |
| **后处理** | 无 | DI 去隔行 + AISR 超分（可选） |
| **EOS 帧追踪** | `user_private_data = frameIndex` | `mInputFlagsWithTimeStamps` map 记录 |

---

### 七、`SimpleC2Component` 与 `HwC2Component` 骨架差异

**`SimpleC2Component`（AOSP 标准软件解码器骨架）：**
```
WorkThread  →  process()        （同步喂入码流）
                    ↓
OutputThread  ←  outputBuffer()  （异步取出解码帧）
```
- 内部两个线程：WorkThread 负责 `process()`，OutputThread 轮询输出
- `finish(frameIndex, fillWork)` 跨 work 帧匹配机制（处理 B 帧 reorder）

**`HwC2Component`（AW 自研硬件解码器骨架）：**
```
ALooper/AHandler 消息线程
    kWhatProcess → processQueue() → process()
                                        ↓
VdecComponent 内部：
    DecodeThread → 送码流 → VE
    WorkerThread → 取输出帧 → handleWorkCb() → listener->onWorkDone_nb()
```
- 单 ALooper 消息线程驱动状态机
- VdecComponent 内部再起 `DecodeThread` + `WorkerThread` 双线程
- 通过 `mWorkHandlerCb` 回调将完成的 work 传回 `HwC2Component`

---

### 八、开发者实现软件解码器的最小步骤

1. **选择软解库**：如 libgav1（AV1）、libvpx（VP8/9）、ffmpeg 等
2. **继承 `SimpleC2Component`**，实现 8 个纯虚函数
3. **定义 `IntfImpl`**，继承 `SimpleInterface<void>::BaseParams`，注册所有 C2 参数
4. **实现 `process()`**：
   - 从 `work->input.buffers` 取 `C2LinearBlock` 并 `map()` 获得裸指针
   - 调用软解库送帧（`EnqueueFrame` 或等价接口）
   - 调用 `outputBuffer()` 取解码结果，`fetchGraphicBlock` + CPU 拷贝 + `finishWork`
5. **实现 `drainInternal()`**：`SignalEOS` 后循环取完残帧
6. **注册 `CreateCodec2Factory`**，Factory 使用 `GetCodec2PlatformComponentStore()` 的 reflector
7. **在 ComponentStore 中 `emplace`** 对应 `.so` 路径（平台 store，非 HW store）

```plaintext
软件解码器最小实现：
├── CreateCodec2Factory / DestroyCodec2Factory
├── C2SoftXxxDec : public SimpleC2Component
│   ├── IntfImpl : public SimpleInterface<void>::BaseParams
│   │   └── 注册分辨率、Profile/Level、色彩空间、HDR 等参数
│   │
│   ├── initDecoder()     创建软解码器实例，设置线程数
│   ├── destroyDecoder()  释放软解码器
│   ├── onInit()          → initDecoder()
│   ├── onStop()          重置错误/EOS 标志
│   ├── onReset()         → onStop() + onFlush_sm()（软重置）
│   ├── onRelease()       → destroyDecoder()
│   ├── onFlush_sm()      SignalEOS + DequeueFrame 排空内部队列
│   │
│   ├── process(work, pool)   ★ 核心帧处理
│   │   ├── map() 获取输入 LinearBlock 只读视图
│   │   ├── EnqueueFrame(bitstream, size, frameIndex)  送码流
│   │   ├── outputBuffer()  尝试取出解码帧（流水线）
│   │   └── EOS → drainInternal()
│   │
│   ├── outputBuffer()    取帧 + 格式转换 + 填充输出
│   │   ├── DequeueFrame()             取 libgav1 解码结果
│   │   ├── 分辨率变化上报 configUpdate
│   │   ├── fetchGraphicBlock()        申请 CPU 可写输出 buffer
│   │   ├── block->map() → C2GraphicView  CPU 映射
│   │   ├── memcpy / 移位 / 打包       ★ CPU 格式转换（软解核心代价）
│   │   └── finishWork(frameIndex)     回调框架
│   │
│   ├── drainInternal()   SignalEOS + 循环 outputBuffer() 取完残帧
│   └── drain()           → drainInternal(drainMode, pool, nullptr)
│
└── 注册到 GetCodec2PlatformComponentStore()  (非 HW Store)
```

```plaintext
WorkThread  →  process()        （同步喂入码流）
                    ↓
OutputThread  ←  outputBuffer()  （异步取出解码帧）
```

```plaintext
ALooper/AHandler 消息线程
    kWhatProcess → processQueue() → process()
                                        ↓
VdecComponent 内部：
    DecodeThread → 送码流 → VE
    WorkerThread → 取输出帧 → handleWorkCb() → listener->onWorkDone_nb()
```

