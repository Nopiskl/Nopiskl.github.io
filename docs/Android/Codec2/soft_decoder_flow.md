# AOSP Codec2 软件解码全链路分析

## 1. 文档范围

本文基于当前仓库中的 AOSP Android 14 源码，按 `APP -> Java MediaCodec -> JNI -> native MediaCodec(stagefright) -> CCodec(sfplugin) -> Codec2Client/HIDL IComponentStore -> C2PlatformComponentStore -> 软件解码组件` 的顺序，分析 APP 调用 `MediaCodec` 到最终进入软件解码器的全过程。

主线示例选择 H.264 软件解码器 `c2.android.avc.decoder`，因为它同时覆盖了：

- Java 层常见入口 `MediaCodec.createDecoderByType("video/avc")`
- Codec2 组件发现与排序
- `CCodec` 作为 stagefright 到 Codec2 的桥接层
- `C2SoftAvcDec` 作为典型 `SimpleC2Component` 软解实现

如果 APP 直接调用 `MediaCodec.createByCodecName("c2.android.avc.decoder")`，则会跳过“按 mime 匹配组件”的步骤，但后续创建、配置、启动、送帧、出帧路径基本相同。

---

## 2. 一张总图先看清主干

```text
APP
  -> android.media.MediaCodec
  -> JNI(android_media_MediaCodec.cpp / JMediaCodec)
  -> media::MediaCodec (frameworks/av/media/libstagefright)
  -> CodecBase = CCodec
  -> Codec2Client
  -> HIDL IComponentStore service "default"
  -> utils::ComponentStore
  -> C2PlatformComponentStore / vendor StoreImpl
  -> dlopen(libcodec2_soft_avcdec.so)
  -> CreateCodec2Factory()
  -> C2SoftAvcDecFactory
  -> C2SoftAvcDec(SimpleC2Component)
  -> process(C2Work, C2BlockPool)
```

数据面主线则是：

```text
dequeueInputBuffer
  -> APP 拿到一个 input slot
  -> queueInputBuffer
  -> MediaCodecBuffer -> C2Buffer/C2Work
  -> component->queue()
  -> SimpleC2Component::queue_nb/processQueue()
  -> C2SoftAvcDec::process()
  -> 输出 C2Buffer
  -> CCodecBufferChannel::onWorkDone()
  -> MediaCodec output slot
  -> dequeueOutputBuffer / releaseOutputBuffer
```

---

## 3. 组件是怎么“出现在系统里”的

### 3.1 MediaCodecList 同时收集 OMX 和 Codec2

`MediaCodecList::GetBuilders()` 会同时加入 OMX builder 和 Codec2 builder；Codec2 builder 就是 `Codec2InfoBuilder`。

关键源码：

- `frameworks/av/media/libstagefright/MediaCodecList.cpp:97-110`
- `frameworks/av/media/libstagefright/MediaCodecList.cpp:204-230`

这意味着 APP 看见的 `MediaCodecList` 不是只来自 OMX，也不是只来自 Codec2，而是多个 builder 合并后的结果。

### 3.2 Codec2InfoBuilder 会枚举 Codec2 组件并叠加 XML

`Codec2InfoBuilder::buildMediaCodecList()` 先用 `Codec2Client::ListComponents()` 枚举所有 Codec2 组件，再解析 XML，把组件能力、rank、alias、software/hardware 属性等写回 `MediaCodecListWriter`。

关键源码：

- `frameworks/av/media/codec2/sfplugin/Codec2InfoBuilder.cpp:396-428`
- `frameworks/av/media/codec2/sfplugin/Codec2InfoBuilder.cpp:512-755`

这里要抓住两点：

- 组件“存在”来自 `Codec2Client::ListComponents()`，即真正可创建的 Codec2 component。
- 组件“怎么对外宣称能力”依赖 XML，比如 mime、size、bitrate、feature、alias、software-codec 等。

### 3.3 `c2.android.avc.decoder` 的 XML 声明

在 AOSP 公共 XML 中，`c2.android.avc.decoder` 被声明为 `video/avc`，同时带有 `OMX.google.h264.decoder` 别名和 `software-codec` 属性。

关键源码：

- `frameworks/av/media/libstagefright/data/media_codecs_google_c2_video.xml:38-48`
- `frameworks/av/media/libstagefright/data/media_codecs_sw.xml:123-143`

这解释了两件事：

- 为什么 `createDecoderByType("video/avc")` 有机会选到 `c2.android.avc.decoder`
- 为什么系统会把它认定为软件解码器

### 3.4 `MediaCodecList::findMatchingCodecs()` 如何选择候选

`MediaCodec::CreateByType()` 会调用 `MediaCodecList::findMatchingCodecs()`。该函数按 mime/encoder/format 过滤，必要时还会做“偏软件”排序。

关键源码：

- `frameworks/av/media/libstagefright/MediaCodec.cpp:918-946`
- `frameworks/av/media/libstagefright/MediaCodecList.cpp:349-414`
- `frameworks/av/media/libstagefright/MediaCodecList.cpp:320-345`

重点结论：

- `createDecoderByType("video/avc")` 不会直接创建解码器，而是先找候选列表。
- 如果命中了 `c2.android.avc.decoder`，后面 native 层就会按组件名去实例化它。
- `c2.android.*` 在 `MediaCodecList::isSoftwareCodec()` 中被直接认定为软件 codec。

---

## 4. APP 创建 MediaCodec 实例时发生了什么

### 4.1 Java 层入口

Java 层常用入口：

- `MediaCodec.createDecoderByType(type)` -> `new MediaCodec(type, true, false)`
- `MediaCodec.createByCodecName(name)` -> `new MediaCodec(name, false, false)`

关键源码：

- `frameworks/base/media/java/android/media/MediaCodec.java:2007-2094`

构造函数最终调用 `native_setup(name, nameIsType, encoder, pid, uid)`。

### 4.2 JNI 层创建 JMediaCodec

JNI 的 `android_media_MediaCodec_native_setup()` 创建 `JMediaCodec`，而 `JMediaCodec` 构造函数根据 `nameIsType` 决定走：

- `MediaCodec::CreateByType()`
- `MediaCodec::CreateByComponentName()`

关键源码：

- `frameworks/base/media/jni/android_media_MediaCodec.cpp:214-243`
- `frameworks/base/media/jni/android_media_MediaCodec.cpp:3449-3498`

### 4.3 native MediaCodec 通过组件名决定用 ACodec 还是 CCodec

`MediaCodec::GetCodecBase()` 的规则很直接：

- 组件名以 `c2.` 开头 -> 返回 `CCodec`
- 组件名以 `omx.` 开头 -> 返回 `ACodec`

关键源码：

- `frameworks/av/media/libstagefright/MediaCodec.cpp:1840-1861`

所以一旦候选组件名是 `c2.android.avc.decoder`，stagefright 就会进入 `CCodec` 路径，而不是 OMX/ACodec。

### 4.4 `MediaCodec::init()` 把分配组件这件事交给 CCodec

`MediaCodec::init()` 会：

- 查询 `MediaCodecInfo`
- 根据 owner/name 选出 `mCodec = CCodec`
- 给 `mCodec` 和 `mBufferChannel` 挂 callback
- 发送 `kWhatInit`
- 在 `kWhatInit` 分支里调用 `mCodec->initiateAllocateComponent(format)`

关键源码：

- `frameworks/av/media/libstagefright/MediaCodec.cpp:1886-2015`
- `frameworks/av/media/libstagefright/MediaCodec.cpp:4353-4382`

这一步后，控制权进入 `CCodec`。

---

## 5. CCodec 如何拿到真正的 Codec2 组件

### 5.1 `CCodec::allocate()` 的核心动作

`CCodec::allocate()` 做了三件最关键的事：

1. `Codec2Client::CreateFromService("default")`
2. `SetPreferredCodec2ComponentStore(...)`
3. `Codec2Client::CreateComponentByName(componentName, ...)`

关键源码：

- `frameworks/av/media/codec2/sfplugin/CCodec.cpp:735-797`

这里的 `componentName` 对我们的例子就是 `c2.android.avc.decoder`。

### 5.2 Codec2Client 通过 HIDL service `"default"` 连接 IComponentStore

`Codec2Client::CreateFromService("default")` 最终调用 `Base::getService(name)` 连接 HIDL 的 `IComponentStore/default`。

关键源码：

- `frameworks/av/media/codec2/hal/client/client.cpp:960-1004`

`CreateComponentByName()` 则会对所有已知 Codec2 service 尝试 `createComponent(name, ...)`，直到成功。

关键源码：

- `frameworks/av/media/codec2/hal/client/client.cpp:1066-1102`

### 5.3 `"default"` 服务是怎么注册出来的

Codec2 HAL service 在 `vendor.cpp` 里创建并注册 `IComponentStore/default`：

- `store = new utils::ComponentStore(std::make_shared<StoreImpl>())`
- `store->registerAsService("default")`

关键源码：

- `frameworks/av/media/codec2/hal/services/vendor.cpp:181-204`

### 5.4 HIDL ComponentStore 再把请求转回 C2ComponentStore

HIDL 层的 `utils::ComponentStore::createComponent()` 本质上调用：

- `mStore->createComponent(name, &c2component)`
- 然后把返回的 `C2Component` 包装成 HIDL `Component`

关键源码：

- `frameworks/av/media/codec2/hal/hidl/1.2/utils/ComponentStore.cpp:197-230`

也就是说：

```text
Codec2Client::CreateComponentByName("c2.android.avc.decoder")
  -> IComponentStore::createComponent("c2.android.avc.decoder")
  -> C2ComponentStore::createComponent("c2.android.avc.decoder")
```

---

## 6. 软件解码器库是怎么被加载出来的

### 6.1 `C2PlatformComponentStore` 维护了 AOSP 软编解码库名单

`C2PlatformComponentStore` 构造时把所有系统软件 codec so 加入组件表，其中就包括：

- `libcodec2_soft_avcdec.so`

关键源码：

- `frameworks/av/media/codec2/vndk/C2Store.cpp:1066-1109`

### 6.2 创建组件时按名字找到库并 `dlopen`

创建路径如下：

1. `findComponent(name, &module)`
2. `module->init(libPath)`
3. `dlopen(libPath)`
4. `dlsym("CreateCodec2Factory")`
5. `factory->createComponent(...)`

关键源码：

- `frameworks/av/media/codec2/vndk/C2Store.cpp:955-1014`
- `frameworks/av/media/codec2/vndk/C2Store.cpp:1175-1198`

所以对 `c2.android.avc.decoder` 来说，最终会装载 `libcodec2_soft_avcdec.so`。

### 6.3 `CreateCodec2Factory()` 暴露工厂

`libcodec2_soft_avcdec.so` 导出的入口函数是：

- `CreateCodec2Factory()`

它返回 `C2SoftAvcDecFactory`。

关键源码：

- `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp:1026-1067`

---

## 7. `C2SoftAvcDec` 这个软件解码器本体长什么样

### 7.1 组件名、类型、domain、mime 都在接口实现里定义

`C2SoftAvcDec::IntfImpl` 声明了：

- 组件名：`c2.android.avc.decoder`
- kind：decoder
- domain：video
- mime：`video/avc`

还定义了 picture size、profile/level、max input size、pixel format、color aspects 等参数。

关键源码：

- `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp:33-205`

这也是为什么 `Codec2InfoBuilder` 能通过 interface 查询到该组件的 traits 和能力。

### 7.2 工厂创建出的组件是 `SimpleC2Component` 子类

`C2SoftAvcDec` 继承 `SimpleC2Component`，只需要实现：

- `onInit()`
- `onStop()/onReset()/onRelease()/onFlush_sm()`
- `process()`
- `drain()`

关键源码：

- `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.h:95-190`

这意味着线程、排队、pending work、listener 回调这些通用能力，都由 `SimpleC2Component` 统一托管。

### 7.3 `onInit()` 并不在 allocate 时触发，而是在 component start 时触发

`C2SoftAvcDec::onInit()` 调用 `initDecoder()`，后者会：

- `createDecoder()`
- 选择 CPU core 数
- 初始化 stride、参数
- 通过 `ih264d_api_function` 建立底层 H.264 软解实例

关键源码：

- `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp:356-358`
- `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp:414-521`

这个点很重要：`MediaCodec.configure()` 只是把组件配好，真正“把软件解码器内核拉起来”通常发生在 `start()` 触发的 component `start()` 流程中。

---

## 8. configure 阶段：Java 参数如何变成 C2 参数

### 8.1 Java `configure()` -> JNI `native_configure()`

Java 层 `configure()` 最终调用 `native_configure(keys, values, surface, crypto, ...)`。

关键源码：

- `frameworks/base/media/java/android/media/MediaCodec.java:2322-2442`
- `frameworks/base/media/jni/android_media_MediaCodec.cpp:1599-1648`

JNI 会把 Java 的 key/value 数组转成 native `AMessage format`，然后调用 `codec->configure(...)`。

### 8.2 stagefright `MediaCodec::configure()`

native `MediaCodec::configure()` 会：

- 保存 metrics、width/height/profile 等
- 把 surface / crypto / descrambler 放入消息
- 发送 `kWhatConfigure`

关键源码：

- `frameworks/av/media/libstagefright/MediaCodec.cpp:2058-2255`
- `frameworks/av/media/libstagefright/MediaCodec.cpp:4439-4594`

在 `kWhatConfigure` 分支里，真正调用的是：

- `mCodec->initiateConfigureComponent(format)`

对于 Codec2 路径，这里的 `mCodec` 就是 `CCodec`。

### 8.3 `CCodec::configure()` 做了哪些转换

`CCodec::configure()` 是 Codec2 适配层里最复杂的一段。对软件解码主线而言，最关键的是：

- 校验 mime、encoder 标志、宽高等必要参数
- 处理 output surface / tunneled / push blank buffers
- 处理 color format、dataspace、HDR、PCM encoding 等 framework 语义
- `config->getConfigUpdateFromSdkParams(...)` 把 SDK 参数翻译成 C2 参数
- `config->setParameters(comp, configUpdate, ...)` 真正下发到组件接口
- `comp->query(...)` 读回 `usage / maxInputSize / prepend header`
- 更新 `mInputFormat` / `mOutputFormat`
- 调 `mCallback->onComponentConfigured(...)`

关键源码：

- `frameworks/av/media/codec2/sfplugin/CCodec.cpp:813-1539`

对于软解典型场景，`configure()` 的本质可以概括为：

```text
SDK/AMessage format
  -> CCodec Config 映射
  -> C2Param 列表
  -> ComponentInterface::config/query
  -> 形成输入输出格式 + buffer 策略
```

---

## 9. start 阶段：组件启动与初始 buffer 发放

### 9.1 Java/Native start

Java `start()` 直接走到 native `MediaCodec::start()`，后者发送 `kWhatStart`。

关键源码：

- `frameworks/base/media/java/android/media/MediaCodec.java:2439-2442`
- `frameworks/base/media/jni/android_media_MediaCodec.cpp:389-391`
- `frameworks/av/media/libstagefright/MediaCodec.cpp:2834-2887`
- `frameworks/av/media/libstagefright/MediaCodec.cpp:4694-4731`

在 `kWhatStart` 分支里，stagefright 调用：

- `mCodec->initiateStart()`

### 9.2 `CCodec::start()`

`CCodec::start()` 做了几件关键事：

1. `comp->start()`
2. `mChannel->start(inputFormat, outputFormat, buffersBoundToCodec)`
3. `mChannel->prepareInitialInputBuffers(...)`
4. `mCallback->onStartCompleted()`
5. `mChannel->requestInitialInputBuffers(...)`

关键源码：

- `frameworks/av/media/codec2/sfplugin/CCodec.cpp:1791-1864`

这一步之后，MediaCodec 输入槽位才会真正开始回到 APP。

### 9.3 对 `SimpleC2Component` 来说，`start()` 会触发 `onInit()`

HIDL `Component::start()` 最终调用 `mComponent->start()`。

关键源码：

- `frameworks/av/media/codec2/hal/hidl/1.2/utils/Component.cpp:432-438`

而 `SimpleC2Component::start()` 的逻辑是：

- 如果当前是 `UNINITIALIZED`，先发 `kWhatInit`
- `kWhatInit` 对应调用派生类 `onInit()`
- 然后把状态切到 `RUNNING`

关键源码：

- `frameworks/av/media/codec2/components/base/SimpleC2Component.cpp:786-807`
- `frameworks/av/media/codec2/components/base/SimpleC2Component.cpp:554-586`

因此，`C2SoftAvcDec::onInit()` 就是在这里被调用，底层 `ih264d` 解码器实例正式建立。

---

## 10. APP 拿到 input buffer 的过程

### 10.1 `CCodecBufferChannel` 先把 buffer 上报给 stagefright

`mChannel->requestInitialInputBuffers()` 最终会促使 `CCodecBufferChannel` 调用：

- `mCallback->onInputBufferAvailable(index, inBuffer)`

关键源码：

- `frameworks/av/media/codec2/sfplugin/CCodec.cpp:1863`
- `frameworks/av/media/codec2/sfplugin/CCodecBufferChannel.cpp:734-765`

### 10.2 stagefright 的 `BufferCallback` 把事件转成消息

`BufferCallback::onInputBufferAvailable()` 会发 `kWhatFillThisBuffer`。

关键源码：

- `frameworks/av/media/libstagefright/MediaCodec.cpp:701-733`

### 10.3 `MediaCodec` 把 buffer 放进 input port 队列

收到 `kWhatFillThisBuffer` 后，`MediaCodec` 会：

- `updateBuffers(kPortIndexInput, msg)`
- 在同步模式下让 `dequeueInputBuffer()` 可以取到 index
- 在异步模式下发 callback

关键源码：

- `frameworks/av/media/libstagefright/MediaCodec.cpp:4129-4192`
- `frameworks/av/media/libstagefright/MediaCodec.cpp:5644-5663`
- `frameworks/av/media/libstagefright/MediaCodec.cpp:6113-6145`

### 10.4 APP 调 `dequeueInputBuffer()`

Java -> JNI -> native：

- `MediaCodec.java:3131-3148`
- `android_media_MediaCodec.cpp:2731-2749`
- `MediaCodec.cpp:3100-3113`

真正返回 slot index 的地方是 `dequeuePortBuffer(kPortIndexInput)`。

---

## 11. APP 把码流送进去时发生了什么

### 11.1 Java `queueInputBuffer()`

Java 层 `queueInputBuffer(index, offset, size, pts, flags)` 最终进入 JNI `android_media_MediaCodec_queueInputBuffer()`。

关键源码：

- `frameworks/base/media/java/android/media/MediaCodec.java:2813-2842`
- `frameworks/base/media/jni/android_media_MediaCodec.cpp:1889-1914`

### 11.2 native `MediaCodec::onQueueInputBuffer()`

stagefright 会：

- 根据 index 找到 `MediaCodecBuffer`
- 校验 client ownership
- 把 `timeUs/eos/csd/decode-only` 写进 buffer metadata
- 然后调用 `mBufferChannel->queueInputBuffer(buffer)`

关键源码：

- `frameworks/av/media/libstagefright/MediaCodec.cpp:4989-5016`
- `frameworks/av/media/libstagefright/MediaCodec.cpp:5665-5950`

关键元数据映射：

- `BUFFER_FLAG_END_OF_STREAM` -> `buffer->meta()["eos"]`
- `BUFFER_FLAG_CODECCONFIG` -> `buffer->meta()["csd"]`
- `BUFFER_FLAG_DECODE_ONLY` -> `buffer->meta()["decode-only"]`
- `presentationTimeUs` -> `buffer->meta()["timeUs"]`

### 11.3 `CCodecBufferChannel::queueInputBufferInternal()`

这里会把 stagefright buffer 包装为一个或多个 `C2Work`：

- 设置 `work->input.ordinal.timestamp`
- 分配 `frameIndex`
- 把客户端时间保存到 `customOrdinal`
- 把 input `MediaCodecBuffer` 对应的 `C2Buffer` 填到 `work->input.buffers`
- 把 EOS/CSD/DECODE_ONLY 映射为 `C2FrameData` flags
- 最终调用 `mComponent->queue(&items)`

关键源码：

- `frameworks/av/media/codec2/sfplugin/CCodecBufferChannel.cpp:216-363`

这一句是数据真正进入 Codec2 component 的关键转折点：

- `frameworks/av/media/codec2/sfplugin/CCodecBufferChannel.cpp:362`

### 11.4 HIDL `Component::queue()` -> `C2Component::queue_nb()`

HIDL 包装层把 `WorkBundle` 转成 `std::list<std::unique_ptr<C2Work>>`，然后调用：

- `mComponent->queue_nb(&c2works)`

关键源码：

- `frameworks/av/media/codec2/hal/hidl/1.2/utils/Component.cpp:226-242`

如果底层组件是 `C2SoftAvcDec`，那这里的 `mComponent` 实际就是 `SimpleC2Component` 子类实例。

### 11.5 `SimpleC2Component::queue_nb()` 进入统一执行框架

`queue_nb()` 只是把 work 放进 `WorkQueue`，再发 `kWhatProcess`。

关键源码：

- `frameworks/av/media/codec2/components/base/SimpleC2Component.cpp:708-728`

真正处理 work 的地方在 `processQueue()`：

- 取一个 `C2Work`
- 应用 `input.configUpdate`
- 调派生类 `process(work, mOutputBlockPool)`
- 如果派生类立即填完 work，就直接回调 listener
- 如果派生类暂时没填完，就放进 pending work 表

关键源码：

- `frameworks/av/media/codec2/components/base/SimpleC2Component.cpp:916-1068`

这就是 Codec2 “work model” 的核心。

---

## 12. `C2SoftAvcDec::process()` 如何真正解码

### 12.1 入口参数

`C2SoftAvcDec::process(const std::unique_ptr<C2Work>& work, const std::shared_ptr<C2BlockPool>& pool)` 是软件 AVC 解码的真实入口。

关键源码：

- `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp:807-971`

进入后先做几件事：

- 初始化 `work->result/workletsProcessed/output.flags`
- 从 `work->input.buffers[0]` map 出 `C2ReadView`
- 读取 `EOS` 标志

### 12.2 确保输出块存在

每轮解码前都调用 `ensureDecoderState(pool)`，如果当前没有合适的输出 graphic block，就从 block pool 拉一个：

- `pool->fetchGraphicBlock(ALIGN128(mWidth), mHeight, HAL_PIXEL_FORMAT_YV12, ...)`

关键源码：

- `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp:776-799`

### 12.3 调底层 `ih264d` 解码库

`process()` 里最核心的调用是：

- `setDecodeArgs(...)`
- `ivdec_api_function(mDecHandle, &decode_ip, &decode_op)`

关键源码：

- `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp:524-578`
- `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp:847-879`

这里的 `ivdec_api_function` 通过头文件宏映射到 `ih264d_api_function`：

- `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.h:33-46`

所以真正执行 H.264 解码的是 `libcodec2_soft_avcdec.so` 内部集成的 `ih264d` 软件解码实现。

### 12.4 处理分辨率变化、输出延迟、VUI 色彩信息

`process()` 还会处理多类 codec 内部状态变化：

- `IVD_RES_CHANGED` -> reset + 重解 header
- `i4_reorder_depth` 变化 -> 更新 `C2PortActualDelayTuning::output`
- 宽高变化 -> 更新 `C2StreamPictureSizeInfo::output`
- `getVuiParams()` -> 更新 color aspects

关键源码：

- `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp:893-956`
- `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp:580-627`

这些更新会进入 `work->worklets.front()->output.configUpdate`，后续由 `CCodecBufferChannel::onWorkDone()` 吃掉并同步给上层格式。

### 12.5 解到一帧后如何完成 work

当 `u4_output_present` 为真时，`process()` 调用：

- `finishWork(ps_decode_op->u4_ts, work)`

关键源码：

- `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp:958-960`

`finishWork()` 会把 `mOutBlock` 包装成 `C2Buffer`，填到 work output 里；如果这是带 EOS 的最后一帧，还可能 `cloneAndSend()` 一个 `FLAG_INCOMPLETE` work 先发帧，再保留 EOS 语义。

关键源码：

- `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp:713-774`

如果当前输入没有马上产出完整帧，`workletsProcessed` 可能维持为 0，`SimpleC2Component` 会把它挂到 pending work 表，等未来某个输出帧对应的 `frameIndex` 回来后再 `finish()`。

---

## 13. 解码结果如何一路回到 APP

### 13.1 组件 listener 把 `onWorkDone_nb` 回送给 HIDL/Client

`SimpleC2Component::processQueue()` 在 work 完成后通过 listener 回调：

- `listener->onWorkDone_nb(shared_from_this(), vec(work))`

关键源码：

- `frameworks/av/media/codec2/components/base/SimpleC2Component.cpp:1038-1045`
- `frameworks/av/media/codec2/components/base/SimpleC2Component.cpp:870-913`

### 13.2 `CCodec::ClientListener::onWorkDone()` 把完成 work 转给 `CCodec`

关键源码：

- `frameworks/av/media/codec2/sfplugin/CCodec.cpp:574-586`
- `frameworks/av/media/codec2/sfplugin/CCodec.cpp:2307-2313`

### 13.3 `CCodecBufferChannel::onWorkDone()` 做格式更新、buffer 注册、时间戳修正

这一层非常关键，它做了几件上层必须依赖的事：

- 消化 `configUpdate`，比如 output delay / reorder depth / picture size
- 把 codec 输出 timestamp 和客户端 timestamp 对齐
- 把 `C2Buffer` 转成 `MediaCodecBuffer`
- stash/register output slot
- 通过 callback 把 output buffer 通知给 stagefright

关键源码：

- `frameworks/av/media/codec2/sfplugin/CCodecBufferChannel.cpp:1856-2195`
- `frameworks/av/media/codec2/sfplugin/CCodecBufferChannel.cpp:2198-2257`

特别要注意时间戳修正：

- `output.timestamp + customOrdinal - input.timestamp`

对应源码：

- `frameworks/av/media/codec2/sfplugin/CCodecBufferChannel.cpp:2088-2108`

这解释了为什么 codec 内部可以改写工作时间戳，但 APP 最终拿到的 `timeUs` 仍尽量保持和输入对齐。

### 13.4 stagefright 收到 output buffer

`BufferCallback::onOutputBufferAvailable()` 会投递 `kWhatDrainThisBuffer`，随后：

- `updateBuffers(kPortIndexOutput, msg)`
- 同步模式下可被 `dequeueOutputBuffer()` 取到
- 异步模式下回调 `onOutputBufferAvailable()`

关键源码：

- `frameworks/av/media/libstagefright/MediaCodec.cpp:726-733`
- `frameworks/av/media/libstagefright/MediaCodec.cpp:4196-4232`
- `frameworks/av/media/libstagefright/MediaCodec.cpp:6228-6255`

### 13.5 APP `dequeueOutputBuffer()` / `releaseOutputBuffer()`

关键源码：

- `frameworks/base/media/java/android/media/MediaCodec.java:3777-3863`
- `frameworks/base/media/jni/android_media_MediaCodec.cpp:2731-2788`
- `frameworks/av/media/libstagefright/MediaCodec.cpp:3115-3165`
- `frameworks/av/media/libstagefright/MediaCodec.cpp:5979-6095`

如果是 ByteBuffer 模式，`releaseOutputBuffer(index, false)` 只是把 buffer 还给 codec。

如果是 Surface 模式，`releaseOutputBuffer(index, true/timestamp)` 最终会走：

- `mBufferChannel->renderOutputBuffer(buffer, renderTimeNs)`

对应源码：

- `frameworks/av/media/libstagefright/MediaCodec.cpp:6079`
- `frameworks/av/media/codec2/sfplugin/CCodecBufferChannel.cpp:767-840`

---

## 14. 用“时序”再串一遍最常见的同步解码路径

以 APP 调用 `MediaCodec.createDecoderByType("video/avc")` 为例：

1. Java `createDecoderByType()` 进入 `native_setup()`。
2. JNI `JMediaCodec` 调 `MediaCodec::CreateByType()`。
3. `MediaCodecList::findMatchingCodecs("video/avc", false, ...)` 找到 `c2.android.avc.decoder`。
4. `MediaCodec::GetCodecBase()` 根据名字前缀 `c2.` 选择 `CCodec`。
5. `MediaCodec::init()` 发送 `kWhatInit`。
6. `CCodec::allocate()` 通过 `Codec2Client` 连接 `IComponentStore/default`。
7. `IComponentStore::createComponent("c2.android.avc.decoder")`。
8. `C2PlatformComponentStore` 找到 `libcodec2_soft_avcdec.so`，`dlopen + CreateCodec2Factory()`。
9. `C2SoftAvcDecFactory::createComponent()` 创建 `C2SoftAvcDec`。
10. APP 调 `configure()`，参数经 `MediaCodec -> CCodec::configure()` 转成 C2 参数。
11. APP 调 `start()`，`CCodec::start()` 调 `component->start()`。
12. `SimpleC2Component::start()` 触发 `C2SoftAvcDec::onInit()`，底层 `ih264d` 实例建立。
13. `CCodecBufferChannel` 准备初始 input buffer 并上报给 `MediaCodec`。
14. APP `dequeueInputBuffer()` 取到 slot，填入 H.264 码流。
15. APP `queueInputBuffer()`。
16. `MediaCodec::onQueueInputBuffer()` 给 buffer 打上 `timeUs/eos/csd` 元数据。
17. `CCodecBufferChannel::queueInputBufferInternal()` 生成 `C2Work`，调用 `mComponent->queue(&items)`。
18. HIDL `Component::queue()` -> `SimpleC2Component::queue_nb()`。
19. `SimpleC2Component::processQueue()` 调 `C2SoftAvcDec::process()`。
20. `C2SoftAvcDec::process()` 调 `ih264d_api_function()` 进行软件解码。
21. 解出帧后 `finishWork()` 填充 output `C2Buffer`。
22. listener 把完成 work 回传到 `CCodecBufferChannel::onWorkDone()`。
23. `CCodecBufferChannel` 注册 output slot 并通知 `MediaCodec`。
24. APP `dequeueOutputBuffer()` 取到解码结果。
25. APP 读 ByteBuffer 或 `releaseOutputBuffer()` 渲染到 Surface。

---

## 15. 几个容易混淆但必须分清的点

### 15.1 `MediaCodec` 创建成功，不等于软件解码器内核已经初始化

创建阶段只完成了 component 对象实例化。像 `C2SoftAvcDec` 真正初始化 `ih264d` 的地方是 `onInit()`，而 `onInit()` 是在 component `start()` 流程里被 `SimpleC2Component` 调起的。

### 15.2 `CCodec` 不是解码器，它是 stagefright 到 Codec2 的桥

`CCodec` 本身不做 AVC 解码。它负责：

- 生命周期桥接
- 参数翻译
- buffer/channel 管理
- surface 适配
- callback 转发

真正解码发生在 `C2SoftAvcDec::process()`。

### 15.3 `C2Work` 是 Codec2 数据流转的核心单元

每个输入并不一定一进一出：

- 一个输入可能先变成 pending work，未来某次才出帧
- EOS 可能拆成“最后一帧”和“真正 EOS work”
- 格式变化通过 `output.configUpdate` 与 buffer 一起返回

所以想看 Codec2 的数据面，必须盯住 `C2Work`，而不是只看 `MediaCodecBuffer`。

### 15.4 `CCodecBufferChannel` 是理解 ByteBuffer/Surface 模式差异的关键

`CCodecBufferChannel` 同时负责：

- input/output slot 管理
- `MediaCodecBuffer` 和 `C2Buffer` 的互转
- Surface 渲染路径
- reorder/decode-only/EOS/configUpdate 处理

很多“为什么 APP 看到的行为和 codec 内部不完全一样”的答案都在这一层。

---

## 16. 对后续继续深挖最有价值的源码入口

如果你接下来想继续跟某个具体问题，建议优先看这些点：

1. 组件发现与排序
   - `frameworks/av/media/libstagefright/MediaCodecList.cpp`
   - `frameworks/av/media/codec2/sfplugin/Codec2InfoBuilder.cpp`

2. stagefright 到 Codec2 桥接
   - `frameworks/av/media/libstagefright/MediaCodec.cpp`
   - `frameworks/av/media/codec2/sfplugin/CCodec.cpp`
   - `frameworks/av/media/codec2/sfplugin/CCodecBufferChannel.cpp`

3. Codec2 service / store
   - `frameworks/av/media/codec2/hal/client/client.cpp`
   - `frameworks/av/media/codec2/hal/hidl/1.2/utils/ComponentStore.cpp`
   - `frameworks/av/media/codec2/vndk/C2Store.cpp`

4. 软件 AVC 解码器实现
   - `frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp`
   - `frameworks/av/media/codec2/components/base/SimpleC2Component.cpp`

---

## 17. 一句话总结

从 APP 视角看是 `MediaCodec` 在解码；从 AOSP 框架视角看，真正的数据主线是：

```text
MediaCodecBuffer
  -> CCodecBufferChannel
  -> C2Work
  -> SimpleC2Component::processQueue
  -> C2SoftAvcDec::process
  -> ih264d_api_function
  -> C2Buffer
  -> CCodecBufferChannel::onWorkDone
  -> MediaCodec output buffer
```

也就是说，`MediaCodec` 是 API 外壳，`CCodec` 是桥接层，`Codec2Client/HIDL` 是跨进程控制通道，`C2PlatformComponentStore` 负责把 `libcodec2_soft_avcdec.so` 动态装出来，而真正完成 H.264 软件解码的是 `C2SoftAvcDec` 里的 `process()`。
