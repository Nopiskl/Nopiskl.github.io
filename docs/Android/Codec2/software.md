
---

**User**

同样的方式，以aosp自带的软件解码器为例，帮我结合具体源码分析一下
其中CCodec::allocate()后如何通过HIDL连上 HIDL service？ HIDL service又如何调用到具体的解码.so?

---

**Cursor**

可以。  
这次我们**不看厂商硬解**，改成**AOSP 自带的软件 Codec2 解码器**来串一遍完整链路。为了更具体，我用 AOSP 自带的 AVC 软件解码器作为例子：

- 组件名：`c2.android.avc.decoder`
- 对应 so：`libcodec2_soft_avcdec.so`
- 对应源码：`frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp`

---

# 一、先给结论

对 AOSP 自带软件解码器来说，这条路径是：

## framework 侧
`MediaCodec -> CCodec::allocate() -> Codec2Client::CreateFromService("default") -> Base::getService("default") -> HIDL IComponentStore/default`

## HIDL service 侧
`IComponentStore::createComponent("c2.android.avc.decoder")`  
→ `utils::ComponentStore::createComponent()`  
→ service 内部 `mStore->createComponent(...)`

## AOSP 默认 service 的实际 store
在你这套源码里，`frameworks/av/media/codec2/hal/services/vendor.cpp` 的默认 service 里，传进去的是一个 `StoreImpl`，**这个 `StoreImpl` 只是示例/空实现，不会真的创建软件 codec**。  
AOSP 真正的软件 codec 动态加载逻辑在：

- `frameworks/av/media/codec2/vndk/C2Store.cpp`

这个 `C2PlatformComponentStore` 才是：
- 维护软件 codec so 列表
- `dlopen("libcodec2_soft_avcdec.so")`
- `dlsym("CreateCodec2Factory")`
- `factory->createComponent(...)`

因此从“机制”上，AOSP 软件解码器的调用链是：

> HIDL service 收到 `createComponent("c2.android.avc.decoder")`  
> → 底层 `C2ComponentStore` 用 `C2PlatformComponentStore` 查到 `libcodec2_soft_avcdec.so`  
> → `dlopen + dlsym(CreateCodec2Factory)`  
> → `C2SoftAvcDecFactory`  
> → `createComponent()`  
> → 创建 `C2SoftAvcDec`

---

# 二、先从 `CCodec::allocate()` 开始

还是先看你最关心的起点：

```735:759:android14/frameworks/av/media/codec2/sfplugin/CCodec.cpp
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
```

---

## 这里对软件解码器也一样

假设这里 `codecInfo->getCodecName()` 是：

```text
c2.android.avc.decoder
```

那 `allocate()` 做两件事：

1. `CreateFromService("default")`：连上名为 `"default"` 的 Codec2 HIDL service
2. `CreateComponentByName("c2.android.avc.decoder", ...)`：要求这个 service 创建对应 component

---

# 三、`CCodec::allocate()` 后如何通过 HIDL 连上 HIDL service

这部分对“软件解码器”和“硬件解码器”是一样的，区别只在远端 store 最终创建哪种 component。

---

## 3.1 先通过 hwservicemanager 找所有 Codec2 service

```892:1003:android14/frameworks/av/media/codec2/hal/client/client.cpp
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
```

### 这里干了什么
它通过 HIDL service manager 枚举：

- 哪些服务实现了 `IComponentStore`
- 它们的实例名是什么

所以 `CreateFromService("default")` 的前提，是系统里确实注册了一个：

- `IComponentStore/default`

---

## 3.2 `CreateFromService("default")`

```960:979:android14/frameworks/av/media/codec2/hal/client/client.cpp
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

这里就是按 `"default"` 去服务列表里查。

---

## 3.3 真正拿到 HIDL proxy：`Base::getService(name)`

```992:1003:android14/frameworks/av/media/codec2/hal/client/client.cpp
std::shared_ptr<Codec2Client> Codec2Client::_CreateFromIndex(size_t index) {
    std::string const& name = GetServiceNames()[index];
    LOG(VERBOSE) << "Creating a Codec2 client to service \"" << name << "\"";
    sp<Base> baseStore = Base::getService(name);
    CHECK(baseStore) << "Codec2 service \"" << name << "\""
                        " inaccessible for unknown reasons.";
    LOG(VERBOSE) << "Client to Codec2 service \"" << name << "\" created";
    Return<sp<IConfigurable>> transResult = baseStore->getConfigurable();
    CHECK(transResult.isOk()) << "Codec2 service \"" << name << "\""
                                "does not have IConfigurable.";
    sp<IConfigurable> configurable = static_cast<sp<IConfigurable>>(transResult);
    return std::make_shared<Codec2Client>(baseStore, configurable, index);
}
```

### 这就是“连上 HIDL service”的关键动作
也就是：

```cpp
sp<Base> baseStore = Base::getService("default");
```

它拿到的是远端 `IComponentStore/default` 的 HIDL 代理对象。

---

# 四、framework 如何通过 HIDL 请求“创建软件 AVC 解码器”

看 `CreateComponentByName()`：

```1066:1092:android14/frameworks/av/media/codec2/hal/client/client.cpp
c2_status_t Codec2Client::CreateComponentByName(
        const char* componentName,
        const std::shared_ptr<Listener>& listener,
        std::shared_ptr<Component>* component,
        std::shared_ptr<Codec2Client>* owner,
        size_t numberOfAttempts) {
    std::string key{"create:"};
    key.append(componentName);
    c2_status_t status = ForAllServices(
            key,
            numberOfAttempts,
            [owner, component, componentName, &listener](
                    const std::shared_ptr<Codec2Client> &client)
                        -> c2_status_t {
                c2_status_t status = client->createComponent(componentName,
                                                             listener,
                                                             component);
```

最终会调用：

```648:711:android14/frameworks/av/media/codec2/hal/client/client.cpp
c2_status_t Codec2Client::createComponent(
        const C2String& name,
        const std::shared_ptr<Codec2Client::Listener>& listener,
        std::shared_ptr<Codec2Client::Component>* const component) {

    ...
    if (mBase1_2) {
        transStatus = mBase1_2->createComponent_1_2(
            name,
            hidlListener,
            ClientManager::getInstance(),
            [&status, component, hidlListener](
                    Status s,
                    const sp<IComponent>& c) {
```

### 这里的含义
如果这次 name 是：

```text
c2.android.avc.decoder
```

那 framework 侧就会通过 HIDL RPC 调用远端：

```cpp
IComponentStore::createComponent_1_2("c2.android.avc.decoder", ...)
```

---

# 五、AOSP 默认 HIDL service 是谁注册的

看 `frameworks/av/media/codec2/hal/services/vendor.cpp`：

```160:210:android14/frameworks/av/media/codec2/hal/services/vendor.cpp
int main(int /* argc */, char** /* argv */) {
    using namespace ::android;
    LOG(DEBUG) << "android.hardware.media.c2@1.2-service starting...";

    ...
    // Create IComponentStore service.
    {
        using namespace ::android::hardware::media::c2::V1_2;
        sp<IComponentStore> store;

        ...
        LOG(DEBUG) << "Instantiating Codec2's IComponentStore service...";
        store = new utils::ComponentStore(
                std::make_shared<StoreImpl>());

        ...
        } else {
            constexpr char const* serviceName = "default";
            if (store->registerAsService(serviceName) != OK) {
```

再结合 rc 文件：

```1:5:android14/frameworks/av/media/codec2/hal/services/android.hardware.media.c2@1.2-default-service.rc
service android-hardware-media-c2-hal-1-2 /vendor/bin/hw/android.hardware.media.c2@1.2-default-service
    class hal
    user mediacodec
    group camera mediadrm drmrpc
```

### 说明
AOSP 默认的 Codec2 HIDL service 是：

- 二进制：`/vendor/bin/hw/android.hardware.media.c2@1.2-default-service`
- 注册实例名：`default`

所以 `CreateFromService("default")` 连上的就是它。

---

# 六、HIDL service 收到 `createComponent()` 后做什么

看 HIDL bridge 层：

```197:230:android14/frameworks/av/media/codec2/hal/hidl/1.2/utils/ComponentStore.cpp
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
```

### 关键点
HIDL service 本身不直接认识 `C2SoftAvcDec`。  
它只是把请求继续转给：

```cpp
mStore->createComponent(name, &c2component)
```

所以真正决定“创建哪个 codec”的，是这个 `mStore`。

---

# 七、AOSP 软件解码器真正落地到哪个 store

这里要注意一个现实点：

## 你当前 `frameworks/av/media/codec2/hal/services/vendor.cpp` 里的 `StoreImpl`
是个**示例空实现**，它本身不会真的创建 component：

源码里 `StoreImpl` 的 `createComponent()` 返回 `C2_NOT_FOUND`。

所以如果严格只看这一个 `vendor.cpp`，它并不会把 `c2.android.avc.decoder` 创建出来。

---

## 但 AOSP 软件 codec 的真实实现路径在 `C2PlatformComponentStore`

也就是：

- `frameworks/av/media/codec2/vndk/C2Store.cpp`

这里的 `GetCodec2PlatformComponentStore()` 才是 AOSP 软件 codec 的真正仓库。

```1231:1238:android14/frameworks/av/media/codec2/vndk/C2Store.cpp
std::shared_ptr<C2ComponentStore> GetCodec2PlatformComponentStore() {
    static std::mutex mutex;
    static std::weak_ptr<C2ComponentStore> platformStore;
    std::lock_guard<std::mutex> lock(mutex);
    std::shared_ptr<C2ComponentStore> store = platformStore.lock();
    if (store == nullptr) {
        store = std::make_shared<C2PlatformComponentStore>();
        platformStore = store;
```

所以从**机制**上讲，AOSP 软件解码器一定是由 `C2PlatformComponentStore` 这条逻辑创建出来的。

---

# 八、`C2PlatformComponentStore` 如何找到软件解码 so

---

## 8.1 启动时登记所有 AOSP 软件 codec so

```1066:1107:android14/frameworks/av/media/codec2/vndk/C2Store.cpp
C2PlatformComponentStore::C2PlatformComponentStore()
    : mVisited(false),
      mReflector(std::make_shared<C2ReflectorHelper>()),
      mInterface(mReflector) {

    auto emplace = [this](const char *libPath) {
        mComponents.emplace(libPath, libPath);
    };

    // TODO: move this also into a .so so it can be updated
    emplace("libcodec2_soft_aacdec.so");
    ...
    emplace("libcodec2_soft_avcdec.so");
    emplace("libcodec2_soft_avcenc.so");
    ...
    emplace("libcodec2_soft_hevcdec.so");
    ...
    emplace("libcodec2_soft_vp9dec.so");
```

### 这里很清楚
AOSP 平台 store 预先知道一组软件 codec so，其中就包括：

- `libcodec2_soft_avcdec.so`

---

## 8.2 创建 component 时先按名字找 so

```1175:1198:android14/frameworks/av/media/codec2/vndk/C2Store.cpp
c2_status_t C2PlatformComponentStore::findComponent(
        C2String name, std::shared_ptr<ComponentModule> *module) {
    (*module).reset();
    visitComponents();

    auto pos = mComponentNameToPath.find(name);
    if (pos != mComponentNameToPath.end()) {
        return mComponents.at(pos->second).fetchModule(module);
    }
    return C2_NOT_FOUND;
}

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

### 这里的含义
如果远端请求是：

```text
c2.android.avc.decoder
```

那么 `findComponent()` 会在 `mComponentNameToPath` 里查到它对应的 so，最终找到：

- `libcodec2_soft_avcdec.so`

---

# 九、`C2PlatformComponentStore` 如何知道 `c2.android.avc.decoder` 对应 `libcodec2_soft_avcdec.so`

这个映射不是手写的，而是**通过加载 so 后读 component traits 得到**。

---

## 9.1 `ComponentModule::init()` 里先 `dlopen()`

```940:1011:android14/frameworks/av/media/codec2/vndk/C2Store.cpp
c2_status_t C2PlatformComponentStore::ComponentModule::init(
        std::string libPath) {
    ...
    if(!createFactory) {
        mLibHandle = dlopen(libPath.c_str(), RTLD_NOW|RTLD_NODELETE);
        LOG_ALWAYS_FATAL_IF(mLibHandle == nullptr,
                "could not dlopen %s: %s", libPath.c_str(), dlerror());

        createFactory =
            (C2ComponentFactory::CreateCodec2FactoryFunc)dlsym(mLibHandle, "CreateCodec2Factory");
        ...
        destroyFactory =
            (C2ComponentFactory::DestroyCodec2FactoryFunc)dlsym(mLibHandle, "DestroyCodec2Factory");
    }

    mComponentFactory = createFactory();
```

### 这一步表示
service/store 进程会对 `libcodec2_soft_avcdec.so` 做：

- `dlopen`
- `dlsym("CreateCodec2Factory")`
- `createFactory()`

---

## 9.2 再从 interface 中读取 traits，得到真实名字

同一个 `init()` 中：

```988:1007:android14/frameworks/av/media/codec2/vndk/C2Store.cpp
    std::shared_ptr<C2ComponentInterface> intf;
    c2_status_t res = createInterface(0, &intf);
    if (res != C2_OK) {
        ...
    }

    std::shared_ptr<C2Component::Traits> traits(new (std::nothrow) C2Component::Traits);
    if (traits) {
        if (!C2InterfaceUtils::FillTraitsFromInterface(traits.get(), intf)) {
            ...
        }
```

所以 store 会从 component 的 interface 中读出：

- name
- domain
- kind
- mediaType
- aliases

然后在 `visitComponents()` 中建立映射：

```cpp
mComponentNameToPath.emplace(traits->name, path);
```

---

# 十、AOSP 软件 AVC 解码器的真实组件名在哪里定义

看 `C2SoftAvcDec.cpp`：

```33:52:android14/frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp
constexpr size_t kMinInputBufferSize = 2 * 1024 * 1024;
constexpr char COMPONENT_NAME[] = "c2.android.avc.decoder";
...
class C2SoftAvcDec::IntfImpl : public SimpleInterface<void>::BaseParams {
public:
    explicit IntfImpl(const std::shared_ptr<C2ReflectorHelper> &helper)
        : SimpleInterface<void>::BaseParams(
                helper,
                COMPONENT_NAME,
                C2Component::KIND_DECODER,
                C2Component::DOMAIN_VIDEO,
                MEDIA_MIMETYPE_VIDEO_AVC) {
```

### 这就说明
`libcodec2_soft_avcdec.so` 这个 so 暴露出来的 component 名就是：

```text
c2.android.avc.decoder
```

所以当 framework 传入这个名字时，最终就能匹配到它。

---

# 十一、`libcodec2_soft_avcdec.so` 是怎么导出 factory 的

继续看 `C2SoftAvcDec.cpp` 末尾：

```1063:1073:android14/frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp
__attribute__((cfi_canonical_jump_table))
extern "C" ::C2ComponentFactory* CreateCodec2Factory() {
    ALOGV("in %s", __func__);
    return new ::android::C2SoftAvcDecFactory();
}

__attribute__((cfi_canonical_jump_table))
extern "C" void DestroyCodec2Factory(::C2ComponentFactory* factory) {
    ALOGV("in %s", __func__);
    delete factory;
}
```

这正好对应前面 `C2PlatformComponentStore::ComponentModule::init()` 里的：

- `dlsym(..., "CreateCodec2Factory")`
- `dlsym(..., "DestroyCodec2Factory")`

所以软件 AVC so 的入口是完全对上的。

---

# 十二、`module->createComponent()` 如何真正创建 `C2SoftAvcDec`

在 store 里：

```1048:1058:android14/frameworks/av/media/codec2/vndk/C2Store.cpp
if (mInit != C2_OK) {
    return mInit;
}
std::shared_ptr<ComponentModule> module = shared_from_this();
c2_status_t res = mComponentFactory->createComponent(
        id, component, [module, deleter](C2Component *p) mutable {
            deleter(p); // delete component first
            module.reset();
});
return res;
```

这里的 `mComponentFactory` 就是刚才从 `libcodec2_soft_avcdec.so` 的 `CreateCodec2Factory()` 返回的：

- `C2SoftAvcDecFactory`

于是：

```cpp
mComponentFactory->createComponent(...)
```

最终就会构造出：

- `C2SoftAvcDec`

---

# 十三、这个 so 本身怎么构建出来

看 `Android.bp`：

```10:18:android14/frameworks/av/media/codec2/components/avc/Android.bp
cc_library {
    name: "libcodec2_soft_avcdec",
    defaults: [
        "libcodec2_soft-defaults",
        "libcodec2_soft_sanitize_signed-defaults",
        "libcodec2_soft_sanitize_cfi-defaults",
    ],

    static_libs: ["libavcdec"],
```

这说明：

- so 名就是 `libcodec2_soft_avcdec`
- 它的源码是 `C2SoftAvcDec.cpp`
- 底层实际 AVC bitstream 解码逻辑链接了 `libavcdec`

也就是说：

## AOSP 软件 Codec2 的两层关系是
### 第一层：Codec2 component so
- `libcodec2_soft_avcdec.so`

### 第二层：真正的解码算法库
- `libavcdec`

和厂商硬解“component so + 底层硬件库”的分层思想是一样的，只不过这里底层是 AOSP 软件解码库，而不是硬件 VE/driver。

---

# 十四、把 AOSP 软件 AVC 解码器整条链路串起来

下面是最核心的时序：

---

## 1）`CCodec::allocate()` 收到 codecInfo
其名字例如：

```text
c2.android.avc.decoder
```

对应：

```735:759:android14/frameworks/av/media/codec2/sfplugin/CCodec.cpp
client = Codec2Client::CreateFromService("default");
...
Codec2Client::CreateComponentByName(componentName.c_str(), ...)
```

---

## 2）framework 通过 HIDL 连上 `IComponentStore/default`

```992:1003:android14/frameworks/av/media/codec2/hal/client/client.cpp
sp<Base> baseStore = Base::getService(name);
...
return std::make_shared<Codec2Client>(baseStore, configurable, index);
```

---

## 3）framework 通过 HIDL 发起远程创建请求

```648:671:android14/frameworks/av/media/codec2/hal/client/client.cpp
mBase1_2->createComponent_1_2(
    name,
    hidlListener,
    ClientManager::getInstance(),
    ...
);
```

这里的 `name = "c2.android.avc.decoder"`。

---

## 4）HIDL service 收到请求，转给底层 store

```197:207:android14/frameworks/av/media/codec2/hal/hidl/1.2/utils/ComponentStore.cpp
Status status = static_cast<Status>(
        mStore->createComponent(name, &c2component));
```

---

## 5）底层 platform store 查到这个名字对应哪个 so

AOSP 软件 codec 列表中有：

```1085:1085:android14/frameworks/av/media/codec2/vndk/C2Store.cpp
emplace("libcodec2_soft_avcdec.so");
```

并且这个 so 的 interface 声明：

```34:34:android14/frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp
constexpr char COMPONENT_NAME[] = "c2.android.avc.decoder";
```

所以名字和 so 对上了。

---

## 6）store 动态加载 so

```960:971:android14/frameworks/av/media/codec2/vndk/C2Store.cpp
mLibHandle = dlopen(libPath.c_str(), RTLD_NOW|RTLD_NODELETE);
...
createFactory =
    (C2ComponentFactory::CreateCodec2FactoryFunc)dlsym(mLibHandle, "CreateCodec2Factory");
...
destroyFactory =
    (C2ComponentFactory::DestroyCodec2FactoryFunc)dlsym(mLibHandle, "DestroyCodec2Factory");
```

---

## 7）so 返回 factory

```1064:1066:android14/frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp
extern "C" ::C2ComponentFactory* CreateCodec2Factory() {
    return new ::android::C2SoftAvcDecFactory();
}
```

---

## 8）factory 创建真正的 component

```1052:1057:android14/frameworks/av/media/codec2/vndk/C2Store.cpp
c2_status_t res = mComponentFactory->createComponent(
        id, component, ...
);
```

最终创建出：

- `C2SoftAvcDec`

---

## 9）解码算法再调用 `libavcdec`

构建文件说明：

```11:18:android14/frameworks/av/media/codec2/components/avc/Android.bp
name: "libcodec2_soft_avcdec",
...
static_libs: ["libavcdec"],
```

所以真正软解码执行时，会落到 AOSP 的 `libavcdec` 解码实现。

---

# 十五、回答你这次问题的两句话总结

## 1）AOSP 自带软件解码器场景下，`CCodec::allocate()` 后如何通过 HIDL 连上 HIDL service？
答：

- `CCodec::allocate()` 先调用 `Codec2Client::CreateFromService("default")`
- `Codec2Client` 通过 `IServiceManager::listManifestByInterface(IComponentStore::descriptor)` 找到实例名为 `"default"` 的 Codec2 HIDL service
- 再通过 `Base::getService("default")` 获取 `IComponentStore/default` 的 HIDL proxy
- 然后使用 `mBase1_2->createComponent_1_2("c2.android.avc.decoder", ...)` 发起远程创建请求

---

## 2）HIDL service 又如何调用到具体的解码 `.so`？
答：

- HIDL bridge 层 `utils::ComponentStore::createComponent()` 会把请求交给底层 `C2ComponentStore`
- 对 AOSP 软件 codec 来说，真正负责动态加载的是 `C2PlatformComponentStore`
- 它内部维护软件 codec so 列表，如 `libcodec2_soft_avcdec.so`
- 它通过组件名 `c2.android.avc.decoder` 找到对应 so
- 然后执行：
  - `dlopen("libcodec2_soft_avcdec.so")`
  - `dlsym("CreateCodec2Factory")`
  - `CreateCodec2Factory()` 返回 `C2SoftAvcDecFactory`
  - `factory->createComponent(...)` 创建 `C2SoftAvcDec`
- 该 so 又静态链接 `libavcdec`，最终真正做 AVC 软件解码

---

# 十六、再提醒一个你做源码分析时很容易踩的点

你现在这个树里：

- `frameworks/av/media/codec2/hal/services/vendor.cpp`

里的 `StoreImpl` 是**示例空实现**，并不能直接创建 `c2.android.avc.decoder`。  
所以如果你问“机制上 AOSP 软件解码器怎么被调用”，答案确实是上面这条**platform store + soft so**链路；  
但如果你问“你当前设备实际跑的是哪个 service/store 组合”，那要再结合设备 manifest、实际注册的 service、以及系统最终把哪个 `C2ComponentStore` 暴露成 `default` 来判断。

---

如果你愿意，我下一步可以继续帮你做两种深入分析中的一种：

1. **继续把 `c2.android.avc.decoder` 往下追**：从 `C2SoftAvcDecFactory` 到 `C2SoftAvcDec::process()`，看真正解码入口怎么调用 `libavcdec`
2. **继续把 HIDL 返回后的上半链路追完**：`createComponent` 成功后，`Codec2Client::Component`、`CCodecBufferChannel`、`MediaCodec` 如何进入 `configure/start/decode`

