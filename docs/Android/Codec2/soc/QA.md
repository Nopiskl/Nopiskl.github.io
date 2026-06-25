
---

**User**

我有一些问题，请你根据之前的分析+源码给我解答
1、@android14/hardware/aw/libcodec2/services/vendor.cpp 是否是HIDL的vedor HAL侧驱动实现？AOSP规定codec2的HAL侧需要实现什么东西，只是实现一个store就行了吗？并简要分析一下该cpp
2、根据你之前的分析，软件解码器和硬件解码器都被注册为default service，上层如何区分？
3、告诉我SOC厂商一般该如何适配自己的编解码器？以aw为例android14/hardware/aw/libcodec2，简要分析一下各个子目录需要实现的内容

---

**Cursor**

下面我按你的 3 个问题分别回答，尽量结合你当前树里的 `aw` 源码来讲。

---

# 1）`android14/hardware/aw/libcodec2/services/vendor.cpp` 是否是 HIDL 的 vendor HAL 侧实现？AOSP 规定 codec2 的 HAL 侧需要实现什么，只是实现一个 store 就行了吗？并简要分析该 cpp

## 1.1 它是不是 HIDL vendor HAL 侧实现？

**是的，它就是 AW 的 Codec2 HIDL HAL service 入口程序。**

从构建文件可以直接看出来：

```1:16:android14/hardware/aw/libcodec2/services/Android.bp
cc_binary {
    name: "android.hardware.media.aw.c2@1.0-service",
    defaults: [
        "hidl_defaults",
        "codec2_defaults",
    ],
    relative_install_path: "hw",
    vendor: true,
    srcs: [
        "vendor.cpp",
    ],

    init_rc: ["android.hardware.media.aw.c2@1.0-service.rc"],

    shared_libs: [
        "android.hardware.media.c2@1.0",
```

以及对应 rc：

```1:4:android14/hardware/aw/libcodec2/services/android.hardware.media.aw.c2@1.0-service.rc
service android-hardware-media-aw-c2-hal-1-0 /vendor/bin/hw/android.hardware.media.aw.c2@1.0-service
    class hal
    user mediacodec
    group camera mediadrm drmrpc media system media_rw external_storage graphics
```

这说明：

- 它是 vendor 分区下的一个 HAL service 进程
- 可执行文件名就是 `android.hardware.media.aw.c2@1.0-service`
- 启动后向系统注册一个 Codec2 的 HIDL service

---

## 1.2 这个 `vendor.cpp` 做了什么？

核心逻辑很简单，主要是三件事：

### a. 初始化运行环境
包括：
- `minijail`
- `vndbinder`
- binder/hwbinder 线程池

```99:112:android14/hardware/aw/libcodec2/services/vendor.cpp
int main(int /* argc */, char** /* argv */) {
  ALOGD("android.hardware.media.aw.c2@1.0-service starting...");

  signal(SIGPIPE, SIG_IGN);
  android::SetUpMinijail(kBaseSeccompPolicyPath, kExtSeccompPolicyPath);

  // vndbinder is needed by BufferQueue.
  android::ProcessState::initWithDriver("/dev/vndbinder");
  android::ProcessState::self()->startThreadPool();

  // Extra threads may be needed to handle a stacked IPC sequence that
  // contains alternating binder and hwbinder calls. (See b/35283480.)
  android::hardware::configureRpcThreadpool(8, true /* callerWillJoin */);
```

---

### b. 创建并注册 HIDL `IComponentStore` service

```113:127:android14/hardware/aw/libcodec2/services/vendor.cpp
  // Create IComponentStore service.
  {
    using android::hardware::media::c2::V1_0::IComponentStore;
    using android::hardware::media::c2::V1_0::utils::ComponentStore;
    android::sp<IComponentStore> store;

    ALOGD("Instantiating Codec2's vendor IComponentStore service......");

    store = new ComponentStore(android::GetCodec2HwComponentStore());
    if (store == nullptr) {
      ALOGE("Cannot create Codec2's IComponentStore service.");
    } else {
      if (store->registerAsService("default") != android::OK) {
```

这里非常关键：

- `ComponentStore` 是 AOSP 提供的 **HIDL 桥接壳**
- 真正的后端 store 是 `android::GetCodec2HwComponentStore()`
- 也就是 AW 自己实现的 `C2AwComponentStore`

所以这个 `vendor.cpp` 的角色不是“真正的解码逻辑实现”，而是：

> **把 AW 自己的 `C2ComponentStore` 封装成一个 HIDL `IComponentStore` 服务并注册出去。**

---

### c. 预加载底层 Cedar 解码插件

```39:69:android14/hardware/aw/libcodec2/services/vendor.cpp
extern "C" {

typedef void VDPluginFun(void);

static void InitVDLib(const char *lib)
{
    ...
    libFd = dlopen(lib, RTLD_NOW);
    ...
    PluginInit = (VDPluginFun*)dlsym(libFd, "CedarPluginVDInit");
    ...
    PluginInit(); /* init plugin */
}
```

```73:95:android14/hardware/aw/libcodec2/services/vendor.cpp
static void AddVDLib(void)
{
    InitVDLib("libawh265.so");
    InitVDLib("libawh265soft.so");
    InitVDLib("libawh264.so");
    InitVDLib("libawmjpeg.so");
    ...
}
```

然后在 service 注册后调用：

```127:128:android14/hardware/aw/libcodec2/services/vendor.cpp
    }
    AddVDLib();
```

这说明 AW 在 HAL service 进程里，还会提前把底层 Cedar/VE 相关的解码插件库初始化好。

---

## 1.3 AOSP 规定 HAL 侧到底需要实现什么？是不是“只要实现一个 store 就行”？

**从架构上讲，核心是要实现一个 `C2ComponentStore`，然后把它通过 HIDL `IComponentStore` 暴露出去。**

也就是说，最核心的 HAL 对接点确实是：

- 一个 `C2ComponentStore` 实现
- 一个 HIDL service 壳把它注册为 `IComponentStore`

这也是 AW `vendor.cpp` 这一句的本质：

```cpp
store = new ComponentStore(android::GetCodec2HwComponentStore());
```

这里：
- `ComponentStore(...)`：AOSP HIDL 适配层
- `GetCodec2HwComponentStore()`：vendor 自己的实现

---

### 但“只实现一个空 store”当然不够
真正可用的 Codec2 HAL 至少要能完成这些事：

#### 1）列举组件
- `listComponents()`

#### 2）按名字创建 component / interface
- `createComponent(name, ...)`
- `createInterface(name, ...)`

#### 3）提供参数反射/查询/配置
- `getParamReflector()`
- `query_sm()`
- `config_sm()`
- `querySupportedParams_nb()`
- `querySupportedValues_sm()`

#### 4）处理 allocator / buffer 相关策略
比如 ion / dmabuf / gralloc 的 usage 映射

在 AW 的 `C2Store.h` 里，这些接口都明确要实现：

```31:52:android14/hardware/aw/libcodec2/vndk/include/C2Store.h
class C2AwComponentStore : public C2ComponentStore {
 public:
  std::vector<std::shared_ptr<const C2Component::Traits>> listComponents()
      override;
  std::shared_ptr<C2ParamReflector> getParamReflector() const override;
  C2String getName() const override;
  c2_status_t querySupportedValues_sm(
      std::vector<C2FieldSupportedValuesQuery> &fields) const override;
  c2_status_t querySupportedParams_nb(
      std::vector<std::shared_ptr<C2ParamDescriptor>> *const params)
      const override;
  c2_status_t query_sm(
      const std::vector<C2Param *> &stackParams,
      const std::vector<C2Param::Index> &heapParamIndices,
      std::vector<std::unique_ptr<C2Param>> *const heapParams) const override;
  c2_status_t createInterface(
      C2String name,
      std::shared_ptr<C2ComponentInterface> *const interface) override;
  c2_status_t createComponent(
      C2String name, std::shared_ptr<C2Component> *const component) override;
```

所以准确说法是：

> **HAL 侧最核心的工作是实现一个完整可用的 `C2ComponentStore`。**
>  
> HIDL service 入口 `vendor.cpp` 只是把这个 store 注册出去的壳。

---

# 2）根据之前分析，软件解码器和硬件解码器都被注册为 default service，上层如何区分？

这个问题非常关键。

## 2.1 上层不是靠 “service 名字” 来区分软硬编解码器

**不是看 `default` / `vendor` 区分，也不是看 HIDL service 名区分。**

上层真正区分软硬 codec，靠的是：

- `MediaCodecList / MediaCodecInfo` 里的 **codec name**
- 以及该 codec name 属于哪个 `owner`
- 然后 `CCodec::allocate()` 把**具体 component 名称**传给 store 去创建

也就是说：

> service 名只表示“请求发给哪个 `IComponentStore` 实例”  
> component 名才表示“你到底要创建哪个 codec”

---

## 2.2 软硬 codec 的名字本身就不一样

### AOSP 软件 AVC 解码器
在 AOSP 软解中，组件名是：

```33:35:android14/frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp
constexpr size_t kMinInputBufferSize = 2 * 1024 * 1024;
constexpr char COMPONENT_NAME[] = "c2.android.avc.decoder";
constexpr uint32_t kDefaultOutputDelay = 8;
```

### AW 硬件 codec
AW 的每个硬件 component 会在自己的组件实现里定义自己的 `name`，通常不是 `c2.android.*`，而是类似厂商命名。

AW store 也是靠组件 interface 读出名字后建立映射：

```323:331:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
      if (traits) {
        mComponentList.push_back(traits);
        mComponentNameToPath.emplace(traits->name, path);
        for (const C2String &alias : traits->aliases) {
          mComponentNameToPath.emplace(alias, path);
        }
      }
```

所以同样叫 AVC decoder：

- 软件解码器名字可能是 `c2.android.avc.decoder`
- 厂商硬解名字可能是 `c2.aw.avc.decoder` 或其它 vendor 名称

**上层最终拿的是 codec name，不是只看 service 名。**

---

## 2.3 `CCodec::allocate()` 传的是 component name

```743:759:android14/frameworks/av/media/codec2/sfplugin/CCodec.cpp
    AString componentName = codecInfo->getCodecName();
    std::shared_ptr<Codec2Client> client;
    ...
    std::shared_ptr<Codec2Client::Component> comp;
    c2_status_t status = Codec2Client::CreateComponentByName(
            componentName.c_str(),
            mClientListener,
            &comp,
            &client);
```

也就是说上层在创建时，已经明确指定：

- 这次我要的是哪个组件名

例如：
- `c2.android.avc.decoder`
- `c2.aw.avc.decoder`

store 只负责“按名字找到对应 component 并创建”。

---

## 2.4 既然都叫 `default service`，那怎么决定请求发给谁？

这里要分两层：

### 层 1：service instance
`default` 只是 HIDL 的 service instance 名。

### 层 2：store 内部 component list
真正创建哪个 component，是 store 看 `name` 决定的。

例如 AOSP 平台软件 store 中：

```1075:1107:android14/frameworks/av/media/codec2/vndk/C2Store.cpp
    emplace("libcodec2_soft_aacdec.so");
    ...
    emplace("libcodec2_soft_avcdec.so");
    ...
    emplace("libcodec2_soft_vp9dec.so");
```

AW 硬件 store 中：

```258:292:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
  if (!mRemoveHardwareCodec2) {
    ALOGD("load normal libs");
    emplace("libcodec2_hw_avcdec.so");
    emplace("libcodec2_hw_hevcdec.so");
    emplace("libcodec2_hw_mpeg2dec.so");
    ...
    emplace("libcodec2_hw_av1dec.so");
  }
```

所以“软硬区分”不是通过 `default`，而是通过：

- 当前连接到哪个 store
- 以及传入的 component name 能不能在该 store 里被找到

---

## 2.5 更准确地说：上层先通过 `MediaCodecList` 选 codec，再按这个 codec name 去创建

也就是：
1. `MediaCodecList/MediaCodecInfo` 决定选哪个 codec
2. 选中的 codec 有自己的 `name` 和 `owner`
3. `MediaCodec` / `CCodec` 把这个 `name` 带到 `CreateComponentByName(name)`
4. 对应 store 再根据 `name` 找具体 so

所以软硬区分的根本依据是：

- **codec info / codec name**
- **component store 内部的组件集合**

不是 service 名字。

---

# 3）SOC 厂商一般如何适配自己的编解码器？以 aw 为例 `android14/hardware/aw/libcodec2`，简要分析各子目录需要实现的内容

这个目录结构其实已经比较标准了。  
根目录：

```1:5:android14/hardware/aw/libcodec2/Android.bp
subdirs = [
    "components",
    "config",
    "services",
    "vndk",
    "plugins"
]
```

另外你这里还有 `aidl/`，虽然没放在根 `subdirs` 里，但也属于扩展能力的一部分。

---

## 3.1 `services/`：HAL service 入口与 manifest/rc

这是**HAL 进程入口层**。

主要内容：
- service 主程序
- rc 启动脚本
- manifest fragment
- seccomp policy

例如：

- `vendor.cpp`
- `android.hardware.media.aw.c2@1.0-service.rc`
- `manifest_media_c2_V1_0_default.xml`

### 需要实现什么
- 初始化 binder/hwbinder 环境
- 创建并注册 `IComponentStore/default`
- 把 vendor 自己的 `C2ComponentStore` 挂进去
- 配置进程权限/沙箱
- 如有需要，初始化底层解码插件

AW 这里就是：

```113:127:android14/hardware/aw/libcodec2/services/vendor.cpp
store = new ComponentStore(android::GetCodec2HwComponentStore());
...
store->registerAsService("default")
...
AddVDLib();
```

---

## 3.2 `vndk/`：vendor 自己的 `C2ComponentStore` 实现

这个目录是**vendor codec2 适配的核心**。

主要职责：
- 实现 `C2ComponentStore`
- 管理有哪些 codec component
- `dlopen()` 每个 component so
- `dlsym(CreateCodec2Factory)`
- 创建 component / interface
- 做参数能力反射和分配器 usage 映射

AW 的核心就在：

- `vndk/include/C2Store.h`
- `vndk/C2Store.cpp`

例如 `C2AwComponentStore`：

```31:52:android14/hardware/aw/libcodec2/vndk/include/C2Store.h
class C2AwComponentStore : public C2ComponentStore {
 public:
  ...
  c2_status_t createInterface(...) override;
  c2_status_t createComponent(...) override;
  ...
```

以及动态加载 component so：

```48:67:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
  mLibHandle = dlopen(libPath.c_str(), RTLD_NOW | RTLD_NODELETE);
  ...
  createFactory = (C2ComponentFactory::CreateCodec2FactoryFunc)dlsym(
      mLibHandle, "CreateCodec2Factory");
  ...
  mComponentFactory = createFactory();
```

以及组件注册列表：

```258:292:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
  if (!mRemoveHardwareCodec2) {
    ...
    emplace("libcodec2_hw_avcdec.so");
    emplace("libcodec2_hw_hevcdec.so");
    ...
  }
```

### 这个目录是厂商最必须认真适配的部分

---

## 3.3 `components/`：每个具体 codec component 的实现

这是**真正的编解码器 component 层**。

目录结构很清晰：

- `decoders/`
- `encoders/`
- `include/`
- 公共基类文件
- postprocess/DI 等扩展

### `components/Android.bp`
可以看出公共库和默认规则：

```1:18:android14/hardware/aw/libcodec2/components/Android.bp
subdirs = [
    "decoders",
    "encoders",
]
cc_library_shared {
    name: "libcodec2_hw_common",
    proprietary: true,
    ...
    srcs: [
        "HwC2Component.cpp",
        "VdecComponent.cpp",
        "VencComponent.cpp",
        "HwC2Interface.cpp",
        "C2DebugHelper.cpp",
        "DI/Deinterlace.cpp",
    ],
```

### 这里需要实现什么
#### 公共层
- `HwC2Component.cpp`
- `VdecComponent.cpp`
- `VencComponent.cpp`
- `HwC2Interface.cpp`

这些一般负责：
- 共用的 component 生命周期
- 参数同步
- work queue / drain / flush
- buffer 和 graphic block 处理
- 对接底层 vdecoder/vencoder 框架

#### 各具体编解码器
例如：
- `decoders/avc/AvcDecComponent.cpp`
- `decoders/hevc/HevcDecComponent.cpp`
- `encoders/avc/AvcEncComponent.cpp`

每个具体 codec so 需要导出：
- `CreateCodec2Factory`
- `DestroyCodec2Factory`

并实现自己的：
- codec name
- media type
- 参数
- `createComponent()`
- decode/encode 工作流

---

## 3.4 `components/include/`：公共头和抽象

这个目录是 component 共用接口层。

比如：
- `HwC2Component.h`
- `HwC2Interface.h`
- `VdecComponent.h`
- `VencComponent.h`
- `VdecParameterHelper.h`
- `VencParameterHelper.h`

### 一般需要做什么
- 抽象解码/编码基类
- 把 CedarX/VE 的能力包装成 C2 接口
- 公共参数 helper
- 减少每个 codec 的重复实现

---

## 3.5 `components/extend/`：后处理/增强功能

比如：

- `postprocess/`
- `AwsrWrapper.cpp`
- `G2dWrapper.cpp`
- `postprocess-sr.cpp`

### 一般对应什么
- 图像后处理
- 缩放
- 超分
- G2D/后处理引擎接入
- 平台扩展能力

这类不是 Codec2 HAL 核心必需，但很多 SoC 厂商会在这里接自家图像处理模块。

---

## 3.6 `components/DI/`：去隔行等视频处理

比如：

- `Deinterlace.cpp`
- `Deinterlace.h`

通常用于：
- interlace 视频输出前的处理
- 平台视频后处理能力

---

## 3.7 `plugins/`：插件式扩展，尤其 DRM / Widevine

你这里有：

- `plugins/widevine_plugins/`

以及：

```1:1:android14/hardware/aw/libcodec2/plugins/Android.bp
subdirs = [
    "widevine_plugins",
]
```

### 一般需要实现什么
- secure path
- DRM/Widevine buffer allocator
- 安全播放相关插件能力
- 与 secure decoder / TEE / protected buffer 相关的扩展

---

## 3.8 `aidl/`：辅助服务，不一定是 codec2 HAL 本体，但经常为 codec 服务

你这里 `aidl/` 下是：

- `vendor.hardware.drmheapallocator`

并且默认服务入口：

```1:25:android14/hardware/aw/libcodec2/aidl/default/service.cpp
int main() {
    android::ProcessState::initWithDriver("/dev/vndbinder");
    ...
    std::shared_ptr<DrmHeapAllocator> drmheapallocator = ndk::SharedRefBase::make<DrmHeapAllocator>();
    const std::string desc = DrmHeapAllocator::descriptor + "/default"s;
    ...
    AServiceManager_addService(...)
```

### 这类目录通常用于
- DRM heap allocator
- secure memory allocator
- buffer service
- 被 codec2 组件或 secure path 依赖的辅助 AIDL service

不是 Codec2 HAL 主入口，但常常是厂商适配中必需的配套服务。

---

## 3.9 `config/`：Soong/构建期开关与配置

例如：

```1:10:android14/hardware/aw/libcodec2/config/Android.bp
bootstrap_go_package {
    name: "soong-c2codec-config",
    pkgPath: "android/soong/c2codec-config",
    ...
    srcs: [
        "c2codec_config.go",
    ],
}
```

### 这类目录一般用于
- 构建期生成配置
- 编解码器开关控制
- 根据平台能力选择编译哪些 component
- Soong plugin 逻辑

---

# 3.10 总结一下：SOC 厂商一般要适配哪些内容？

如果抽象成厂商适配 checklist，大致是：

## 必需项
1. **实现 vendor `C2ComponentStore`**
   - 组件枚举
   - createComponent/createInterface
   - 参数查询/配置
   - allocator usage mapping

2. **实现 HIDL/AIDL HAL service**
   - 注册 `IComponentStore/default`
   - 启动 binder/hwbinder 线程池
   - 配好 manifest/rc/seccomp

3. **实现每个 codec component**
   - 解码器/编码器的 `C2ComponentFactory`
   - codec name / traits / media type
   - 具体编解码逻辑
   - buffer / work 处理

4. **接入底层硬件编解码库**
   - vdecoder / vencoder / videoengine / DRM / secure path

## 常见扩展项
5. **secure codec / widevine / protected path**
6. **后处理 / 去隔行 / 超分 / G2D**
7. **drmheap / secure memory allocator 等辅助服务**
8. **构建配置与平台 feature 开关**

---

# 最后用一句话概括 AW 这套目录的角色分工

- `services/`：把 AW 的 codec2 store 注册成 HIDL HAL service
- `vndk/`：AW 自己的 `C2ComponentStore` 核心实现，负责动态加载 codec so
- `components/`：具体硬编/软编组件实现与公共基类
- `plugins/`：DRM/Widevine 等扩展插件
- `aidl/`：辅助服务，如 DRM heap allocator
- `config/`：构建配置与开关

---

如果你愿意，我下一步可以继续帮你做两种深入分析之一：

1. **专门分析 `hardware/aw/libcodec2/vndk/C2Store.cpp`**
   - 逐函数讲 `visitComponents / findComponent / createComponent / createInterface`
2. **专门分析某个 AW codec component**
   - 比如 `decoders/avc/AvcDecComponent.cpp`
   - 看它如何对接 `libvdecoder / libvideoengine` 做真正硬解



