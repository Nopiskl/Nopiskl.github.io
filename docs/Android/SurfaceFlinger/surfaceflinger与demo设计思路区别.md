
---

**User**

请结合这个教程示例，对比分析一下AIDL这样的复杂service和这个教程使用的示例的异同点@tmp/HIDL介绍和使用.html 

---

**Cursor**

文件未找到，让我搜索一下这个文件的实际位置：

文件较大，分段读取：

读取到了HTML头部，继续读取正文内容部分：

继续读取后续内容：

继续读取后面的客户端调用部分：

已经读取了完整的 HIDL 教程内容。现在结合 `SurfaceComposerClient` 的源码进行详细的对比分析。

---

## HIDL 与 `SurfaceComposerClient`（AIDL 复杂 Service）的异同点对比分析

---

### 一、底层 Binder 驱动的差异

这是两者最根本的区别，教程中已经总结得很清楚：

| 维度 | HIDL（教程示例） | SurfaceComposerClient（AIDL） |
|---|---|---|
| 驱动节点 | `/dev/hwbinder` | `/dev/binder` |
| Binder 库 | `libhwbinder`（`BpHwBinder`） | `libbinder`（`BpBinder`） |
| ServiceManager | `hwservicemanager` | `servicemanager` |
| 注册方式 | 注册到 `vendor/manifest.xml` | `ServiceManager::addService()` |
| 设计目的 | HAL 层 Framework 与 Vendor 解耦（Treble） | App 与系统服务通信 |

SurfaceFlinger 同时使用了**两条通道**，这正是它"复杂"的地方：

```cpp
// 通道1：走 /dev/binder，注册到 servicemanager
// 用于 Transaction 提交等旧式接口
mComposerService = waitForService<ISurfaceComposer>(name); // "SurfaceFlinger"

// 通道2：走 /dev/binder，注册到 servicemanager（AIDL 化后的新接口）
mComposerService = waitForService<gui::ISurfaceComposer>(name); // "SurfaceFlingerAIDL"
```

而 HIDL 的 `yangyangTest.cpp` 中直接：

```cpp
// 走 /dev/hwbinder，向 hwservicemanager 查询
android::sp<IYangyang> service = IYangyang::getService();
```

---

### 二、接口定义语言（IDL）的差异

**HIDL（教程）：**

```
// IYangyang.hal
package android.hardware.yangyang@1.0;
interface IYangyang {
    helloWorld(string name) generates (string result);
};
```

- 使用 `.hal` 文件，工具为 `hidl-gen`
- 返回值通过 `generates` 关键字 + **回调函数**传递（因 hwbinder 设计限制）
- 客户端调用时需要传入 lambda 接收结果：

```cpp
service->helloWorld("I am Yangyang48", [&](hidl_string result){
    printf("%s\n", result.c_str());
});
```

**AIDL（SurfaceComposerClient）：**

```aidl
// ISurfaceComposer.aidl
interface ISurfaceComposer {
    @nullable ISurfaceComposerClient createConnection();
    void bootFinished();
    ...
}
// ISurfaceComposerClient.aidl
interface ISurfaceComposerClient {
    CreateSurfaceResult createSurface(@utf8InCpp String name, int flags,
        @nullable IBinder parent, in LayerMetadata metadata);
}
```

- 使用 `.aidl` 文件，工具为 `aidl`
- 返回值直接作为函数返回值，更接近普通函数调用
- 支持 `@nullable`、`in/out/inout`、`oneway` 等丰富的修饰符

---

### 三、服务获取方式的对比

这是两者在**使用模式**上最大的差异。

**HIDL（教程，简单直接）：**

```cpp
// 客户端一行代码直接拿到服务实现
android::sp<IYangyang> service = IYangyang::getService();
service->helloWorld(...);
```

服务端只有一个全局实例，`getService()` 直接向 `hwservicemanager` 查询并返回代理，**没有"连接"的概念**，所有客户端共用同一个服务对象。

**SurfaceComposerClient（AIDL，有状态两级模型）：**

```
第一级：ISurfaceComposer（全局单例）
    │  ← ComposerServiceAIDL::getComposerService()
    │    类似 IYangyang::getService()，全进程共享
    │
    └─ createConnection()  ← 这一步是 HIDL 没有的
         │
第二级：ISurfaceComposerClient（每连接独享）
         │  ← mClient，每个 SurfaceComposerClient 实例独占
         └─ createSurface() / getLayerFrameStats() ...
```

这种两级模型的动机是：SurfaceFlinger 需要**追踪每个连接方的身份**，在 `Client` 对象中记录"这个 Layer 属于谁"：

```cpp
// Client.cpp - 服务端为每个连接创建独立 Client
Client::Client(const sp<SurfaceFlinger>& flinger) : mFlinger(flinger) {}

binder::Status Client::createSurface(...) {
    // args 中携带了 sp<Client>，SF 知道 Layer 属于哪个进程
    LayerCreationArgs args(mFlinger.get(), sp<Client>::fromExisting(this), ...);
    mFlinger->createLayer(args, *outResult);
}
```

HIDL 的 `Yangyang` 服务是无状态的，不需要区分调用方。

---

### 四、代码生成产物对比

**HIDL 生成（`hidl-gen`）：**

```
IYangyang.h         ← 接口抽象类
IHwYangyang.h       ← HwBinder 传输层接口
BnHwYangyang.h      ← 服务端存根（Native/Bn）
BpHwYangyang.h      ← 客户端代理（Proxy/Bp）
BsYangyang.h        ← 直通模式（passthrough）包装
YangyangAll.cpp     ← 所有传输层实现
android.hardware.yangyang@1.0.so     ← 接口库
android.hardware.yangyang@1.0-impl.so ← 实现库
```

**AIDL 生成（`aidl` 工具）：**

```
BnSurfaceComposerClient.h   ← 服务端存根（由 aidl 自动生成）
BpSurfaceComposerClient.h   ← 客户端代理（由 aidl 自动生成）
```

SurfaceFlinger 在此基础上**手写了 `Client`** 作为 `BnSurfaceComposerClient` 的实现，添加了与 `SurfaceFlinger` 主体交互的业务逻辑。

---

### 五、进程隔离与资源清理机制对比

**HIDL（教程示例）：**

```cpp
// 服务端是全局单例，客户端崩溃后无需特殊处理
// 因为 HIDL 服务是无状态的，没有"属于某个客户端的资源"
android::sp<IYangyang> service = IYangyang::getService();
```

**SurfaceComposerClient（AIDL）：**

两处都注册了死亡监听：

```cpp
// 1. ComposerServiceAIDL 监听 SF 进程死亡（重连）
mDeathObserver = new DeathObserver(...);
IInterface::asBinder(mComposerService)->linkToDeath(mDeathObserver);

// 2. SurfaceComposerClient 可以监听 SF 死亡
status_t SurfaceComposerClient::linkToComposerDeath(
        const sp<IBinder::DeathRecipient>& recipient, ...) {
    sp<ISurfaceComposer> sf(ComposerService::getComposerService());
    return IInterface::asBinder(sf)->linkToDeath(recipient, ...);
}
```

当 App 进程崩溃，其持有的 `mClient`（`Client` 对象的 Binder 引用）引用计数归零，SF 侧的 `Client` 对象析构，SF 借此自动清理该连接下所有 Layer 资源。

---

### 六、综合对比总结

```
维度              HIDL（教程示例）              AIDL + SurfaceComposerClient
─────────────────────────────────────────────────────────────────────────
驱动              /dev/hwbinder                /dev/binder
ServiceManager    hwservicemanager             servicemanager
IDL 语法          .hal + generates 回调        .aidl + 直接返回值
连接模型          无状态单例，直接 getService() 两级：全局服务 + 每连接 Client
资源归属          无法追踪调用方               Client 绑定调用方，死亡自动清理
Transaction 聚合  无，每次调用直接 IPC          有，本地 Transaction 批量提交
Buffer 缓存       无                           BufferCache 本地去重
适用场景          HAL 层 Framework↔Vendor      图形、显示等需要状态管理的系统服务
代码复杂度        低（一个 .hal 定义即可）      高（接口 + 封装层 + 连接管理）
```

**核心结论：** HIDL 适合"调一下硬件、拿个结果"这类**无状态 HAL 访问**；而 `SurfaceComposerClient` 的设计是针对**长生命周期、有状态、需要资源归属追踪**的复杂系统服务，其两级模型、Transaction 聚合、Buffer 缓存等机制都是为了在高频图形操作场景下兼顾安全隔离与性能。

```cpp
// 通道1：走 /dev/binder，注册到 servicemanager
// 用于 Transaction 提交等旧式接口
mComposerService = waitForService<ISurfaceComposer>(name); // "SurfaceFlinger"

// 通道2：走 /dev/binder，注册到 servicemanager（AIDL 化后的新接口）
mComposerService = waitForService<gui::ISurfaceComposer>(name); // "SurfaceFlingerAIDL"
```

```cpp
// 走 /dev/hwbinder，向 hwservicemanager 查询
android::sp<IYangyang> service = IYangyang::getService();
```

```plaintext
// IYangyang.hal
package android.hardware.yangyang@1.0;
interface IYangyang {
    helloWorld(string name) generates (string result);
};
```

```cpp
service->helloWorld("I am Yangyang48", [&](hidl_string result){
    printf("%s\n", result.c_str());
});
```

```plaintext
// ISurfaceComposer.aidl
interface ISurfaceComposer {
    @nullable ISurfaceComposerClient createConnection();
    void bootFinished();
    ...
}
// ISurfaceComposerClient.aidl
interface ISurfaceComposerClient {
    CreateSurfaceResult createSurface(@utf8InCpp String name, int flags,
        @nullable IBinder parent, in LayerMetadata metadata);
}
```

```cpp
// 客户端一行代码直接拿到服务实现
android::sp<IYangyang> service = IYangyang::getService();
service->helloWorld(...);
```

```plaintext
第一级：ISurfaceComposer（全局单例）
    │  ← ComposerServiceAIDL::getComposerService()
    │    类似 IYangyang::getService()，全进程共享
    │
    └─ createConnection()  ← 这一步是 HIDL 没有的
         │
第二级：ISurfaceComposerClient（每连接独享）
         │  ← mClient，每个 SurfaceComposerClient 实例独占
         └─ createSurface() / getLayerFrameStats() ...
```

```cpp
// Client.cpp - 服务端为每个连接创建独立 Client
Client::Client(const sp<SurfaceFlinger>& flinger) : mFlinger(flinger) {}

binder::Status Client::createSurface(...) {
    // args 中携带了 sp<Client>，SF 知道 Layer 属于哪个进程
    LayerCreationArgs args(mFlinger.get(), sp<Client>::fromExisting(this), ...);
    mFlinger->createLayer(args, *outResult);
}
```

```plaintext
IYangyang.h         ← 接口抽象类
IHwYangyang.h       ← HwBinder 传输层接口
BnHwYangyang.h      ← 服务端存根（Native/Bn）
BpHwYangyang.h      ← 客户端代理（Proxy/Bp）
BsYangyang.h        ← 直通模式（passthrough）包装
YangyangAll.cpp     ← 所有传输层实现
android.hardware.yangyang@1.0.so     ← 接口库
android.hardware.yangyang@1.0-impl.so ← 实现库
```

```plaintext
BnSurfaceComposerClient.h   ← 服务端存根（由 aidl 自动生成）
BpSurfaceComposerClient.h   ← 客户端代理（由 aidl 自动生成）
```

```cpp
// 服务端是全局单例，客户端崩溃后无需特殊处理
// 因为 HIDL 服务是无状态的，没有"属于某个客户端的资源"
android::sp<IYangyang> service = IYangyang::getService();
```

```cpp
// 1. ComposerServiceAIDL 监听 SF 进程死亡（重连）
mDeathObserver = new DeathObserver(...);
IInterface::asBinder(mComposerService)->linkToDeath(mDeathObserver);

// 2. SurfaceComposerClient 可以监听 SF 死亡
status_t SurfaceComposerClient::linkToComposerDeath(
        const sp<IBinder::DeathRecipient>& recipient, ...) {
    sp<ISurfaceComposer> sf(ComposerService::getComposerService());
    return IInterface::asBinder(sf)->linkToDeath(recipient, ...);
}
```

```plaintext
维度              HIDL（教程示例）              AIDL + SurfaceComposerClient
─────────────────────────────────────────────────────────────────────────
驱动              /dev/hwbinder                /dev/binder
ServiceManager    hwservicemanager             servicemanager
IDL 语法          .hal + generates 回调        .aidl + 直接返回值
连接模型          无状态单例，直接 getService() 两级：全局服务 + 每连接 Client
资源归属          无法追踪调用方               Client 绑定调用方，死亡自动清理
Transaction 聚合  无，每次调用直接 IPC          有，本地 Transaction 批量提交
Buffer 缓存       无                           BufferCache 本地去重
适用场景          HAL 层 Framework↔Vendor      图形、显示等需要状态管理的系统服务
代码复杂度        低（一个 .hal 定义即可）      高（接口 + 封装层 + 连接管理）
```
