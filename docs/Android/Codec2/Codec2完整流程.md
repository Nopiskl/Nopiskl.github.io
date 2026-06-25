
---

**User**

帮我结合具体源码分析一下
其中CCodec::allocate()后如何通过HIDL连上 HIDL service？ HIDL service又如何调用到具体的解码.so?

---

**Cursor**

可以，这个问题要分成两段看：

1. **`CCodec::allocate()` 之后，怎么通过 HIDL 连到 Codec2 HAL service**
2. **HAL service 再怎么把请求落到具体解码 `.so`**

你这个代码树里，已经把这两段都实现得比较清楚了，而且是“标准 framework 客户端 + 厂商 Allwinner HIDL service + 厂商 component store + 各 codec so”的典型链路。

---

# 一、先给你完整结论

在你的源码里，这条链路是：

## 上半段：framework 侧
`MediaCodec -> CCodec::allocate() -> Codec2Client::CreateFromService("default") -> Base::getService("default") -> HIDL IComponentStore service`

## 下半段：service 侧
`IComponentStore::createComponent(name)`  
→ `utils::ComponentStore::createComponent()`  
→ 厂商自己的 `C2AwComponentStore::createComponent(name, &component)`  
→ 找到对应 `libcodec2_hw_xxx.so`  
→ `dlopen()`  
→ `dlsym("CreateCodec2Factory")`  
→ `factory->createComponent(...)`  
→ 得到真正 codec component 对象

所以：

- **连 HIDL service**：是通过 `Codec2Client` 持有的 `IComponentStore` HIDL proxy 完成的
- **调到具体解码 so**：是在 service 进程里，由厂商 `C2AwComponentStore` 用 `dlopen + dlsym + CreateCodec2Factory` 动态加载并创建的

---

# 二、从 `CCodec::allocate()` 开始看

你前面已经看到这里了：

```735:796:android14/frameworks/av/media/codec2/sfplugin/CCodec.cpp
void CCodec::allocate(const sp<MediaCodecInfo> &codecInfo) {
    if (codecInfo == nullptr) {
        mCallback->onError(UNKNOWN_ERROR, ACTION_CODE_FATAL);
        return;
    }
    ALOGD("allocate(%s)", codecInfo->getCodecName());
    mClientListener.reset(new ClientListener(this));

    AString componentName = codecInfo->getCodecName();
    std::shared_ptr<Codec2Client> client;

    // set up preferred component store to access vendor store parameters
    client = Codec2Client::CreateFromService("default");
    if (client) {
        ALOGI("setting up '%s' as default (vendor) store", client->getServiceName().c_str());
        SetPreferredCodec2ComponentStore(
                std::make_shared<Codec2ClientInterfaceWrapper>(client));
    }

    std::shared_ptr<Codec2Client::Component> comp;
    c2_status_t status = Codec2Client::CreateComponentByName(
            componentName.c_str(),
            mClientListener,
            &comp,
            &client);
    ...
}
```

这里有两个关键动作：

## 1）`Codec2Client::CreateFromService("default")`
这是**连到 HIDL service**

## 2）`Codec2Client::CreateComponentByName(...)`
这是**通过 HIDL 让远端 service 创建具体 component**

---

# 三、`CreateFromService("default")` 是怎么连上 HIDL service 的

---

## 3.1 先枚举有哪些 Codec2 HIDL service

看 `Codec2Client::GetServiceNames()`：

```892:979:android14/frameworks/av/media/codec2/hal/client/client.cpp
std::vector<std::string> const& Codec2Client::GetServiceNames() {
    static std::vector<std::string> sServiceNames{[]() {
        using ::android::hardware::media::c2::V1_0::IComponentStore;
        using ::android::hidl::manager::V1_2::IServiceManager;

        while (true) {
            sp<IServiceManager> serviceManager = IServiceManager::getService();
            CHECK(serviceManager) << "Hardware service manager is not running.";

            ...
            transResult = serviceManager->listManifestByInterface(
                    IComponentStore::descriptor,
                    [&defaultNames, &vendorNames, &otherNames](
                            hidl_vec<hidl_string> const& instanceNames) {
                        for (hidl_string const& instanceName : instanceNames) {
                            char const* name = instanceName.c_str();
                            if (strncmp(name, "default", 7) == 0) {
                                defaultNames.emplace_back(name);
                            } else if (strncmp(name, "vendor", 6) == 0) {
                                vendorNames.emplace_back(name);
                            } else {
                                otherNames.emplace_back(name);
                            }
                        }
                    });
            ...
        }
    }()};
    return sServiceNames;
}
```

### 这里做了什么
它通过 HIDL 的 service manager：

- `IServiceManager::getService()`
- `listManifestByInterface(IComponentStore::descriptor, ...)`

去查系统 manifest 里有哪些 `IComponentStore` 服务实例。

也就是说，framework 并不是写死某个 binder 句柄，而是：

> 先去 hwservicemanager 查：系统里有哪些 `android.hardware.media.c2::IComponentStore` 实例。

---

## 3.2 然后按名字取 `"default"`

接着：

```960:978:android14/frameworks/av/media/codec2/hal/client/client.cpp
std::shared_ptr<Codec2Client> Codec2Client::CreateFromService(
        const char* name,
        bool setAsPreferredCodec2ComponentStore) {
    size_t index = getServiceIndex(name);
    if (index == GetServiceNames().size()) {
        ...
        return nullptr;
    }
    std::shared_ptr<Codec2Client> client = _CreateFromIndex(index);
    ...
    return client;
}
```

这里传的是 `"default"`，表示要找 instance name 为 `default` 的 `IComponentStore` 服务。

---

## 3.3 真正拿 HIDL proxy：`Base::getService(name)`

关键在 `_CreateFromIndex()`：

```1000:1003:android14/frameworks/av/media/codec2/hal/client/client.cpp
CHECK(transResult.isOk()) << "Codec2 service \"" << name << "\""
                            "does not have IConfigurable.";
sp<IConfigurable> configurable = static_cast<sp<IConfigurable>>(transResult);
return std::make_shared<Codec2Client>(baseStore, configurable, index);
```

上面这段太短了，我把前文补上：它前面会调用 `Base::getService(name)`。从前面读取结果可知：

```cpp
sp<Base> baseStore = Base::getService(name);
...
Return<sp<IConfigurable>> transResult = baseStore->getConfigurable();
...
return std::make_shared<Codec2Client>(baseStore, configurable, index);
```

也就是说，真正连 HIDL service 的动作是：

### `Base::getService("default")`

这里的 `Base` 实际上就是 `android.hardware.media.c2::V1_0::IComponentStore` 的 HIDL 接口基类/别名。  
这一步返回的是一个 **HIDL 远端代理对象** `baseStore`。

### 所以“连上 HIDL service”本质上就是：
- 从 hwservicemanager 根据实例名 `"default"` 找到远端 service
- 拿到一个 `IComponentStore` 的 HIDL proxy
- 用这个 proxy 后续发起 `createComponent` 等远程调用

---

# 四、你的设备上这个 `"default"` service 是谁？

这就要看厂商 service 进程。

你的树里 Allwinner 的 service 是：

```1:15:android14/hardware/aw/libcodec2/services/android.hardware.media.aw.c2@1.0-service.rc
service android-hardware-media-aw-c2-hal-1-0 /vendor/bin/hw/android.hardware.media.aw.c2@1.0-service
    class hal
    user mediacodec
    group camera mediadrm drmrpc media system media_rw external_storage graphics
```

说明运行中的服务进程是：

- `/vendor/bin/hw/android.hardware.media.aw.c2@1.0-service`

构建文件也对应：

```1:21:android14/hardware/aw/libcodec2/services/Android.bp
cc_binary {
    name: "android.hardware.media.aw.c2@1.0-service",
    ...
    srcs: [
        "vendor.cpp",
    ],
    ...
    shared_libs: [
        "android.hardware.media.c2@1.0",
        ...
        "libawcodec2_vndk",
        "libcodec2_vndk",
        ...
```

---

## 4.1 这个 service 在 `main()` 里注册成 `"default"`

看 Allwinner 的 `vendor.cpp`：

```99:121:android14/hardware/aw/libcodec2/services/vendor.cpp
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

  // Create IComponentStore service.
  {
    using android::hardware::media::c2::V1_0::IComponentStore;
    using android::hardware::media::c2::V1_0::utils::ComponentStore;
    android::sp<IComponentStore> store;

    ALOGD("Instantiating Codec2's vendor IComponentStore service......");
```

继续：

```120:121:android14/hardware/aw/libcodec2/services/vendor.cpp
    ALOGD("Instantiating Codec2's vendor IComponentStore service......");
```

前面完整代码里你已经看到后面是：

```cpp
store = new ComponentStore(android::GetCodec2HwComponentStore());
...
store->registerAsService("default")
```

所以这个进程会把自己注册成：

- `IComponentStore/default`

这就跟前面 framework 侧 `CreateFromService("default")` 对上了。

---

# 五、`CreateComponentByName()` 如何通过 HIDL 调到远端 service

这一步就是 `Codec2Client` 持有 HIDL proxy 后，通过 proxy 发起远程调用。

看 `Codec2Client::createComponent()`：

```648:711:android14/frameworks/av/media/codec2/hal/client/client.cpp
c2_status_t Codec2Client::createComponent(
        const C2String& name,
        const std::shared_ptr<Codec2Client::Listener>& listener,
        std::shared_ptr<Codec2Client::Component>* const component) {

    c2_status_t status;
    sp<Component::HidlListener> hidlListener = new Component::HidlListener{};
    hidlListener->base = listener;
    Return<void> transStatus;
    if (mBase1_2) {
        transStatus = mBase1_2->createComponent_1_2(
            name,
            hidlListener,
            ClientManager::getInstance(),
            [&status, component, hidlListener](
                    Status s,
                    const sp<IComponent>& c) {
                status = static_cast<c2_status_t>(s);
                if (status != C2_OK) {
                    return;
                }
                *component = std::make_shared<Codec2Client::Component>(c);
                hidlListener->component = *component;
            });
    }
    ...
}
```

### 这段的意义
`mBase1_2` / `mBase1_1` / `mBase1_0` 都是远端 service 的 HIDL proxy。

所以这句：

```cpp
mBase1_2->createComponent_1_2(...)
```

就是一次 **HIDL RPC**，发给远端 `IComponentStore` service。

传过去的参数主要有：
- `name`：component 名，例如 `c2.aw.avc.decoder`
- `hidlListener`：事件监听器，用于回调 work/error/death 等
- `ClientManager::getInstance()`：bufferpool 相关 client manager

返回时拿到远端创建好的：
- `sp<IComponent>`

然后包装成本地 `Codec2Client::Component`。

---

# 六、远端 HIDL service 收到 `createComponent` 后做了什么

看 HIDL service 侧 `utils::ComponentStore::createComponent()`：

```197:215:android14/frameworks/av/media/codec2/hal/hidl/1.2/utils/ComponentStore.cpp
Return<void> ComponentStore::createComponent(
        const hidl_string& name,
        const sp<IComponentListener>& listener,
        const sp<IClientManager>& pool,
        createComponent_cb _hidl_cb) {

    sp<Component> component;
    std::shared_ptr<C2Component> c2component;
    Status status = static_cast<Status>(
            mStore->createComponent(name, &c2component));

    if (status == Status::OK) {
#ifndef __ANDROID_APEX__
        c2component = GetFilterWrapper()->maybeWrapComponent(c2component);
#endif
        onInterfaceLoaded(c2component->intf());
        component = new Component(c2component, listener, this, pool);
        if (!component) {
            status = Status::CORRUPTED;
```

这里很关键：

## `mStore->createComponent(name, &c2component)`

这个 `mStore` 不是 HIDL 接口，而是**service 进程里的真正 C2ComponentStore 实现**。

在 Allwinner service 中，这个 `mStore` 是这样传进来的：

```cpp
store = new ComponentStore(android::GetCodec2HwComponentStore());
```

也就是说：

- HIDL 层 `utils::ComponentStore`
- 只是个**桥接层**
- 真正干活的是 `android::GetCodec2HwComponentStore()` 返回的厂商 store

---

# 七、Allwinner 的 `GetCodec2HwComponentStore()` 返回什么

看源码：

```323:352:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
...
std::shared_ptr<C2ComponentStore> GetCodec2HwComponentStore() {
  static std::mutex mutex;
  static std::weak_ptr<C2ComponentStore> hwStore;
  std::lock_guard<std::mutex> lock(mutex);
  std::shared_ptr<C2ComponentStore> store = hwStore.lock();
  if (store == nullptr) {
    store = std::make_shared<C2AwComponentStore>();
    hwStore = store;
  }
  return store;
}
```

也就是返回厂商实现的：

- `C2AwComponentStore`

---

# 八、`C2AwComponentStore` 如何把 component name 映射到具体 `.so`

这就是你最关心的“调用到具体解码 so”的地方。

---

## 8.1 初始化时先登记可用组件 so

在 `C2AwComponentStore` 构造函数里：

```249:293:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
C2AwComponentStore::C2AwComponentStore()
    : mVisited(false),
      mReflector(std::make_shared<C2ReflectorHelper>()),
      mInterface(mReflector) {
  bool mRemoveHardwareCodec2 = false;
  ...
  auto emplace = [this](const char *libPath) {
    mComponents.emplace(libPath, libPath);
  };
  if (!mRemoveHardwareCodec2) {
    ALOGD("load normal libs");
    emplace("libcodec2_hw_avcdec.so");
    emplace("libcodec2_hw_hevcdec.so");
    emplace("libcodec2_hw_mpeg2dec.so");
    emplace("libcodec2_hw_mpeg4dec.so");
    emplace("libcodec2_hw_h263dec.so");
    emplace("libcodec2_hw_s263dec.so");
    emplace("libcodec2_hw_mjpegdec.so");
    emplace("libcodec2_hw_mpeg1dec.so");
    emplace("libcodec2_hw_xviddec.so");
    emplace("libcodec2_hw_avcenc.so");
    emplace("libcodec2_hw_vp8dec.so");
...
    emplace("libcodec2_hw_av1dec.so");
}
```

### 这里做了什么
厂商 store 启动时，先把自己支持的 codec 组件库列表记下来：

- `libcodec2_hw_avcdec.so`
- `libcodec2_hw_hevcdec.so`
- `libcodec2_hw_vp8dec.so`
- ...

这只是**登记候选库**，不是一开始就全部实例化 component。

---

## 8.2 首次访问时扫描这些 so，拿出 traits / 组件名

看 `visitComponents()`：

```323:352:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
void C2AwComponentStore::visitComponents() {
  std::lock_guard<std::mutex> lock(mMutex);
  if (mVisited) {
    return;
  }
  for (auto &pathAndLoader : mComponents) {
    const C2String &path = pathAndLoader.first;
    ComponentLoader &loader = pathAndLoader.second;
    std::shared_ptr<ComponentModule> module;
    if (loader.fetchModule(&module) == C2_OK) {
      std::shared_ptr<const C2Component::Traits> traits = module->getTraits();
      if (traits) {
        mComponentList.push_back(traits);
        mComponentNameToPath.emplace(traits->name, path);
        for (const C2String &alias : traits->aliases) {
          mComponentNameToPath.emplace(alias, path);
        }
      }
    }
  }
  mVisited = true;
}
```

### 这里的作用
把：

- codec component name，例如 `c2.aw.avc.decoder`
- 映射到对应 so 路径，例如 `libcodec2_hw_avcdec.so`

存进 `mComponentNameToPath`。

所以后面客户端传入一个名字时，store 就能知道该加载哪个 `.so`。

---

## 8.3 创建 component 时先按名字查 so

看 `findComponent()` + `createComponent()`：

```345:352:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
c2_status_t C2AwComponentStore::findComponent(
    C2String name, std::shared_ptr<ComponentModule> *module) {
  (*module).reset();
  visitComponents();

  auto pos = mComponentNameToPath.find(name);
  if (pos != mComponentNameToPath.end()) {
    return mComponents.at(pos->second).fetchModule(module);
  }
```

```209:223:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
c2_status_t C2AwComponentStore::ComponentModule::createComponent(
    c2_node_id_t id, std::shared_ptr<C2Component> *component,
    std::function<void(::C2Component *)> deleter) {
  component->reset();
  if (mInit != C2_OK) {
    return mInit;
  }
  ...
  if(mComponentsNum.load() >= MAX_COMPONENT_COUNTS) {
...
  } else {
    res= mComponentFactory->createComponent(
```

以及：

```1177:1197:android14/frameworks/av/media/codec2/vndk/C2Store.cpp
c2_status_t C2PlatformComponentStore::createComponent(
        C2String name, std::shared_ptr<C2Component> *const component) {
    component->reset();
    std::shared_ptr<ComponentModule> module;
    c2_status_t res = findComponent(name, &module);
    if (res == C2_OK) {
        res = module->createComponent(0, component);
    }
    return res;
}
```

Allwinner 的版本逻辑相同。

---

# 九、真正落到具体 `.so`：`dlopen + dlsym + factory`

---

## 9.1 加载 so

核心就在 `ComponentModule::init()`：

```48:71:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
c2_status_t C2AwComponentStore::ComponentModule::init(std::string libPath) {
  ALOGD("dlopen %s.", libPath.c_str());
  ...
  mLibHandle = dlopen(libPath.c_str(), RTLD_NOW | RTLD_NODELETE);
  LOG_ALWAYS_FATAL_IF(mLibHandle == nullptr, "could not dlopen %s: %s",
                      libPath.c_str(), dlerror());

  createFactory = (C2ComponentFactory::CreateCodec2FactoryFunc)dlsym(
      mLibHandle, "CreateCodec2Factory");
  LOG_ALWAYS_FATAL_IF(createFactory == nullptr, "createFactory is null in %s",
                      libPath.c_str());

  destroyFactory = (C2ComponentFactory::DestroyCodec2FactoryFunc)dlsym(
      mLibHandle, "DestroyCodec2Factory");
```

这一步说明：

> service 进程不是直接链接调用某个 decoder 类，而是动态加载对应的 `libcodec2_hw_xxx.so`，再去找标准导出符号：
> - `CreateCodec2Factory`
> - `DestroyCodec2Factory`

---

## 9.2 创建 factory

继续：

```67:71:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
  mComponentFactory = createFactory();
  if (mComponentFactory == nullptr) {
    ALOGD("could not create factory in %s", libPath.c_str());
    mInit = C2_NO_MEMORY;
  } else {
    mInit = C2_OK;
  }
```

说明每个 codec so 都要实现一个 `C2ComponentFactory` 工厂对象。

---

## 9.3 factory 再创建具体 codec component

最后：

```209:223:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
c2_status_t C2AwComponentStore::ComponentModule::createComponent(
    c2_node_id_t id, std::shared_ptr<C2Component> *component,
    std::function<void(::C2Component *)> deleter) {
  ...
  } else {
    res= mComponentFactory->createComponent(
      id, component, [module, deleter](C2Component *p) mutable {
```

所以真正 component 实例的来源是：

### `mComponentFactory->createComponent(...)`

也就是：

- so 导出的 `CreateCodec2Factory()`
- 返回 `C2ComponentFactory`
- 这个 factory 再生成真正的 `C2Component`

因此“具体解码 `.so` 被调用”的准确表述是：

> HIDL service 先通过厂商 `C2AwComponentStore` 找到对应的 component so，动态加载后拿到 `C2ComponentFactory`，再由 factory 构造出真正的解码 component 对象。

---

# 十、这些 `.so` 又如何进一步用到底层硬解库

你树里 Allwinner 还做了一层更底层的插件初始化。

看 service 启动时的 `AddVDLib()`：

```43:69:android14/hardware/aw/libcodec2/services/vendor.cpp
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

和：

```73:95:android14/hardware/aw/libcodec2/services/vendor.cpp
static void AddVDLib(void)
{
    InitVDLib("libawh265.so");
    InitVDLib("libawh265soft.so");
    InitVDLib("libawh264.so");
    InitVDLib("libawmjpeg.so");
    InitVDLib("libawmjpegplus.so");
    InitVDLib("libawmpeg2.so");
    ...
    InitVDLib("libawvp8.so");
    InitVDLib("libawwmv3.so");
...
}
```

然后 `main()` 里在 service 注册后调用：

```cpp
AddVDLib();
```

### 这里说明什么
除了 `libcodec2_hw_avcdec.so` 这种 **Codec2 component so** 外，Allwinner 还额外预加载了更底层的视频解码插件库：

- `libawh264.so`
- `libawh265.so`
- `libawvp8.so`
- ...

这些库通过导出的 `CedarPluginVDInit` 做注册/初始化。  
通常它们再往下会接 `libvdecoder`、`libVE`、`libvideoengine` 之类底层 CedarX/VideoEngine 硬件解码框架。

这点从 service 的链接库也能看出来：

```15:55:android14/hardware/aw/libcodec2/services/Android.bp
shared_libs: [
    ...
    "libcodec2_hw_avcdec",
    "libcodec2_hw_hevcdec",
    ...
    "libvdecoder",
    "libVE",
    "libvideoengine",
    "libMemAdapter",
    "libvencoder",
    "libcdc_base",
    ...
]
```

也就是说，这里至少有两层 so：

## 第一层：Codec2 component so
比如：
- `libcodec2_hw_avcdec.so`
- `libcodec2_hw_hevcdec.so`

这层对外实现的是 `C2ComponentFactory / C2Component`

## 第二层：厂商底层编解码库
比如：
- `libawh264.so`
- `libawh265.so`
- `libvdecoder`
- `libvideoengine`

这层是更贴近硬件/驱动/VE 的真正解码执行体

---

# 十一、把整条调用链按时序串起来

下面这条是你当前代码里的真实主线：

---

## 第 1 步：framework 里 `CCodec::allocate()`

```735:759:android14/frameworks/av/media/codec2/sfplugin/CCodec.cpp
client = Codec2Client::CreateFromService("default");
...
c2_status_t status = Codec2Client::CreateComponentByName(
        componentName.c_str(),
        mClientListener,
        &comp,
        &client);
```

---

## 第 2 步：`CreateFromService("default")` 去 hwservicemanager 找 service

```892:979:android14/frameworks/av/media/codec2/hal/client/client.cpp
serviceManager->listManifestByInterface(IComponentStore::descriptor, ...)
...
std::shared_ptr<Codec2Client> client = _CreateFromIndex(index);
```

然后：

```1000:1003:android14/frameworks/av/media/codec2/hal/client/client.cpp
sp<IConfigurable> configurable = static_cast<sp<IConfigurable>>(transResult);
return std::make_shared<Codec2Client>(baseStore, configurable, index);
```

实际是：
- `Base::getService("default")`
- 拿到 `IComponentStore/default` 的 HIDL proxy

---

## 第 3 步：客户端通过 HIDL proxy 调 `createComponent`

```648:700:android14/frameworks/av/media/codec2/hal/client/client.cpp
transStatus = mBase1_2->createComponent_1_2(
    name,
    hidlListener,
    ClientManager::getInstance(),
    ...
);
```

---

## 第 4 步：远端 service 进程接收 RPC

Allwinner service 启动并注册：

```1:15:android14/hardware/aw/libcodec2/services/android.hardware.media.aw.c2@1.0-service.rc
service android-hardware-media-aw-c2-hal-1-0 /vendor/bin/hw/android.hardware.media.aw.c2@1.0-service
```

```99:121:android14/hardware/aw/libcodec2/services/vendor.cpp
store = new ComponentStore(android::GetCodec2HwComponentStore());
...
store->registerAsService("default")
```

---

## 第 5 步：HIDL 桥接层把请求转给厂商 C2 store

```197:207:android14/frameworks/av/media/codec2/hal/hidl/1.2/utils/ComponentStore.cpp
Status status = static_cast<Status>(
        mStore->createComponent(name, &c2component));
```

其中 `mStore = GetCodec2HwComponentStore() = C2AwComponentStore`

---

## 第 6 步：厂商 store 根据组件名找到对应 so

```345:352:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
auto pos = mComponentNameToPath.find(name);
if (pos != mComponentNameToPath.end()) {
    return mComponents.at(pos->second).fetchModule(module);
}
```

而 `mComponentNameToPath` 是通过扫描这些 so 建出来的：

```260:292:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
emplace("libcodec2_hw_avcdec.so");
emplace("libcodec2_hw_hevcdec.so");
...
emplace("libcodec2_hw_av1dec.so");
```

---

## 第 7 步：动态加载具体 codec so

```48:64:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
mLibHandle = dlopen(libPath.c_str(), RTLD_NOW | RTLD_NODELETE);
...
createFactory = (C2ComponentFactory::CreateCodec2FactoryFunc)dlsym(
    mLibHandle, "CreateCodec2Factory");
destroyFactory = (C2ComponentFactory::DestroyCodec2FactoryFunc)dlsym(
    mLibHandle, "DestroyCodec2Factory");
```

---

## 第 8 步：factory 创建 codec component

```67:71:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
mComponentFactory = createFactory();
```

```223:223:android14/hardware/aw/libcodec2/vndk/C2Store.cpp
res= mComponentFactory->createComponent(
```

---

## 第 9 步：如果 component 内部还要用更底层解码库，再继续下钻

service 启动时还预加载了：

```73:95:android14/hardware/aw/libcodec2/services/vendor.cpp
InitVDLib("libawh264.so");
InitVDLib("libawh265.so");
...
```

这些库再通过 `CedarPluginVDInit` 注册到底层 Cedar/VE 解码体系。

---

# 十二、回答你问题里的两句“直白版”

## 1）`CCodec::allocate()` 后如何通过 HIDL 连上 HIDL service？

答：

- `CCodec::allocate()` 里先调 `Codec2Client::CreateFromService("default")`
- `Codec2Client` 会通过 `IServiceManager::listManifestByInterface(IComponentStore::descriptor)` 找到名为 `"default"` 的 Codec2 HIDL service
- 然后通过 `Base::getService("default")` 拿到远端 `IComponentStore` 的 HIDL proxy
- 接着调用 `mBase1_2->createComponent_1_2(...)` / `mBase1_0->createComponent(...)` 发起远程创建请求

---

## 2）HIDL service 又如何调用到具体解码 `.so`？

答：

- HIDL service 的 `createComponent()` 会把请求转给厂商的 `C2AwComponentStore`
- `C2AwComponentStore` 根据 `componentName` 在内部映射表里找到对应 codec so，比如 `libcodec2_hw_avcdec.so`
- 然后对这个 so 执行：
  - `dlopen()`
  - `dlsym("CreateCodec2Factory")`
  - `createFactory()`
  - `factory->createComponent(...)`
- 这样就得到真正的 `C2Component`
- 如果这个 component 还依赖更底层硬解库，则再调用像 `libawh264.so / libawh265.so / libvideoengine` 等厂商库完成真正解码

---

如果你愿意，我下一步可以继续帮你做两件很有价值的事之一：

1. **把某个具体 codec 例子串到底**，比如从 `c2.aw.avc.decoder` 一路追到 `libcodec2_hw_avcdec.so` 的 `CreateCodec2Factory()` 和 `AvcDecComponent`
2. **把 HIDL 返回后的回调链讲完**，即 `createComponent` 成功后，`Codec2Client::Component` / `CCodecBufferChannel` / `MediaCodec` 如何接上后续 `configure/start/decode` 流程

