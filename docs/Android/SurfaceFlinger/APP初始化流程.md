# SurfaceComposerClient and SurfaceFlinger analysis
_Exported on 2026/3/18 at GMT+8 9:47:40 from Cursor (2.3.34)_

---

**User**

@android14/frameworks/native/services/surfaceflinger/tests/self_test/self_test.cpp 请基于该APP，详细分析一下sp<SurfaceComposerClient> client = new SurfaceComposerClient();的全流程

---

**Cursor**

---

## `sp<SurfaceComposerClient> client = new SurfaceComposerClient()` 全流程分析

---

### 一、整体调用链概览

```
new SurfaceComposerClient()
  └─ SurfaceComposerClient::SurfaceComposerClient()   // 构造函数，仅初始化 mStatus=NO_INIT
       └─ sp<> 引用计数首次增加 → 触发 onFirstRef()
            └─ ComposerServiceAIDL::getComposerService()  // 获取 SurfaceFlinger AIDL 代理
                 └─ waitForService<gui::ISurfaceComposer>("SurfaceFlingerAIDL")
            └─ sf->createConnection(&conn)              // 跨进程 Binder 调用到 SurfaceFlinger
                 └─ SurfaceFlinger::createConnection()
                      └─ new Client(this)               // 创建 Client 对象（BnSurfaceComposerClient 实现）
            └─ mClient = conn                           // 保存 ISurfaceComposerClient 代理
            └─ mStatus = NO_ERROR
```

---

### 二、逐步详细分析

#### 第 1 步：构造函数

```2347:2348:android14/frameworks/native/libs/gui/SurfaceComposerClient.cpp
SurfaceComposerClient::SurfaceComposerClient() : mStatus(NO_INIT) {}
```

构造函数**极简**，只将成员变量 `mStatus` 初始化为 `NO_INIT`，`mClient`（`sp<ISurfaceComposerClient>`）此时为空。**真正的初始化延迟到 `onFirstRef()`**。

---

#### 第 2 步：`sp<>` 触发 `onFirstRef()`

`SurfaceComposerClient` 继承自 `RefBase`。当 `new SurfaceComposerClient()` 的原始指针被第一次赋给 `sp<SurfaceComposerClient>` 时，`RefBase` 的强引用计数从 0 变为 1，**自动回调 `onFirstRef()`**。

```2350:2361:android14/frameworks/native/libs/gui/SurfaceComposerClient.cpp
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

这里做了三件事：
1. 通过 `ComposerServiceAIDL` 单例获取 SurfaceFlinger 的 AIDL Binder 代理
2. 调用 `sf->createConnection()` 跨进程建立连接
3. 将返回的 `ISurfaceComposerClient` 代理保存到 `mClient`，并将 `mStatus` 设为 `NO_ERROR`

---

#### 第 3 步：`ComposerServiceAIDL::getComposerService()` —— 连接 SurfaceFlinger

```
// ComposerServiceAIDL 是一个 Singleton，第一次访问时构造
ComposerServiceAIDL::ComposerServiceAIDL() : Singleton<ComposerServiceAIDL>() {
    std::scoped_lock lock(mMutex);
    connectLocked();
}
```

`connectLocked()` 通过 ServiceManager 查找名为 **"SurfaceFlingerAIDL"** 的服务：


- 若 SurfaceFlinger 尚未注册该服务，此调用**阻塞等待**直到服务上线
- 连接成功后，注册 `DeathObserver`（Binder 死亡监听），确保 SF 崩溃后能够重连

注意：系统中还有一个 **`ComposerService`**（对应旧版 `ISurfaceComposer`，名称为 **"SurfaceFlinger"**），供 `Transaction::apply()` 等使用，两套服务并存。

---

#### 第 4 步：`sf->createConnection()` —— 跨进程调用到 SurfaceFlinger

这是一次 **Binder IPC**，从 App 进程穿越到 SurfaceFlinger 进程。

服务端（SurfaceFlinger）接收后调用 `SurfaceFlinger::createConnection()`，创建一个 `Client` 对象：

```c++
//SurfaceFlinger 服务端
binder::Status SurfaceComposerAIDL::createConnection(sp<gui::ISurfaceComposerClient>* outClient) {
    const sp<Client> client = sp<Client>::make(mFlinger);
    if (client->initCheck() == NO_ERROR) {
        *outClient = client;
        return binder::Status::ok();
    } else {
        *outClient = nullptr;
        return binderStatusFromStatusT(BAD_VALUE);
    }
}

// （伪代码，实际由 AIDL 自动生成的 Bn 实现分发）
binder::Status SurfaceFlinger::createConnection(sp<ISurfaceComposerClient>* outClient) {
    *outClient = new Client(this);  // Client 是 BnSurfaceComposerClient 的实现

    //
    //这里的 Client 不是 App 进程里的 client，而是 SurfaceFlinger 进程中“代表某个 App/SurfaceComposerClient 的服务端会话对象”
    //

    return binder::Status::ok();
}
```

`Client` 类定义：

```32:55:android14/frameworks/native/services/surfaceflinger/Client.h
class Client : public gui::BnSurfaceComposerClient {
public:
    explicit Client(const sp<SurfaceFlinger>& flinger);
    ...
    binder::Status createSurface(...) override;
    binder::Status clearLayerFrameStats(...) override;
    binder::Status getLayerFrameStats(...) override;
    binder::Status mirrorSurface(...) override;
    binder::Status mirrorDisplay(...) override;
private:
    sp<SurfaceFlinger> mFlinger;
    mutable Mutex mLock;
};
```

`Client` 持有 `SurfaceFlinger` 的强引用，后续所有 surface 创建、统计等操作都通过它转发给 SurfaceFlinger。

---

#### 第 5 步：连接建立完成，`mClient` 就位

`onFirstRef()` 执行完毕后：

| 成员变量 | 值 |
|---|---|
| `mStatus` | `NO_ERROR` |
| `mClient` | `BpSurfaceComposerClient`（App 进程侧的 Binder 代理，对应 SF 进程的 `Client` 对象） |

此后调用 `client->initCheck()` 返回 `NO_ERROR`，说明连接成功。

---

### 三、后续 `createSurface` 简述（与本次构造的关系）

一旦 `mClient` 就位，`client->createSurface(...)` 内部即通过 `mClient->createSurface(...)` 再次发起 Binder IPC，到达 SF 侧的 `Client::createSurface()`：

```44:53:android14/frameworks/native/services/surfaceflinger/Client.cpp
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

---

### 四、关键类/接口关系图

```
App 进程                                      SurfaceFlinger 进程
─────────────────────────────────────────    ──────────────────────────────────────
SurfaceComposerClient
  │  mClient (BpSurfaceComposerClient)  ←───Binder IPC───→  Client (BnSurfaceComposerClient)
  │                                                               │  mFlinger
  │  ComposerServiceAIDL::mComposerService                       ↓
  │  (BpSurfaceComposer/"SurfaceFlingerAIDL") ←──────────→  SurfaceFlinger (BnSurfaceComposer)
  │
  │  ComposerService::mComposerService
  │  (BpISurfaceComposer/"SurfaceFlinger") ←────────────→  SurfaceFlinger (BnISurfaceComposer)
```

---

### 五、总结

`new SurfaceComposerClient()` 的全流程可归纳为：

1. **构造函数**：只初始化 `mStatus = NO_INIT`，不做任何 IPC
2. **`onFirstRef()`**（由 `sp<>` 赋值自动触发）：
   - 通过 `ComposerServiceAIDL` 单例（内部用 `waitForService` 阻塞获取）拿到 SurfaceFlinger AIDL 服务代理
   - 调用 `sf->createConnection()` 发起 **Binder IPC**
3. **SurfaceFlinger 服务端**：`createConnection()` 创建 `Client` 对象（持有 `SurfaceFlinger` 引用），通过 Binder 返回其代理
4. **客户端**：将代理保存为 `mClient`，设置 `mStatus = NO_ERROR`，连接建立完成

之后所有的 `createSurface`、`Transaction::apply` 等操作都依赖这两条 Binder 通道（`mClient` 和 `ComposerServiceAIDL`）与 SurfaceFlinger 通信。

```plaintext
new SurfaceComposerClient()
  └─ SurfaceComposerClient::SurfaceComposerClient()   // 构造函数，仅初始化 mStatus=NO_INIT
       └─ sp<> 引用计数首次增加 → 触发 onFirstRef()
            └─ ComposerServiceAIDL::getComposerService()  // 获取 SurfaceFlinger AIDL 代理
                 └─ waitForService<gui::ISurfaceComposer>("SurfaceFlingerAIDL")
            └─ sf->createConnection(&conn)              // 跨进程 Binder 调用到 SurfaceFlinger
                 └─ SurfaceFlinger::createConnection()
                      └─ new Client(this)               // 创建 Client 对象（BnSurfaceComposerClient 实现）
            └─ mClient = conn                           // 保存 ISurfaceComposerClient 代理
            └─ mStatus = NO_ERROR
```

```cpp
SurfaceComposerClient::SurfaceComposerClient() : mStatus(NO_INIT) {}
```

```cpp
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

```plaintext
// ComposerServiceAIDL 是一个 Singleton，第一次访问时构造
ComposerServiceAIDL::ComposerServiceAIDL() : Singleton<ComposerServiceAIDL>() {
    std::scoped_lock lock(mMutex);
    connectLocked();
}
```

```cpp
// SurfaceFlinger 服务端（伪代码，实际由 AIDL 自动生成的 Bn 实现分发）
binder::Status SurfaceFlinger::createConnection(sp<ISurfaceComposerClient>* outClient) {
    *outClient = new Client(this);  // Client 是 BnSurfaceComposerClient 的实现
    return binder::Status::ok();
}
```

```plaintext
class Client : public gui::BnSurfaceComposerClient {
public:
    explicit Client(const sp<SurfaceFlinger>& flinger);
    ...
    binder::Status createSurface(...) override;
    binder::Status clearLayerFrameStats(...) override;
    binder::Status getLayerFrameStats(...) override;
    binder::Status mirrorSurface(...) override;
    binder::Status mirrorDisplay(...) override;
private:
    sp<SurfaceFlinger> mFlinger;
    mutable Mutex mLock;
};
```

```cpp
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

```plaintext
App 进程                                      SurfaceFlinger 进程
─────────────────────────────────────────    ──────────────────────────────────────
SurfaceComposerClient
  │  mClient (BpSurfaceComposerClient)  ←───Binder IPC───→  Client (BnSurfaceComposerClient)
  │                                                               │  mFlinger
  │  ComposerServiceAIDL::mComposerService                       ↓
  │  (BpSurfaceComposer/"SurfaceFlingerAIDL") ←──────────→  SurfaceFlinger (BnSurfaceComposer)
  │
  │  ComposerService::mComposerService
  │  (BpISurfaceComposer/"SurfaceFlinger") ←────────────→  SurfaceFlinger (BnISurfaceComposer)
```


---

**User**

我能不能这样理解：
APP先连接到全局单例ISurfaceComposer上，通过createConnection()调用ISurfaceComposerClient获得粒度更细的mClient，之后所有的通信都由surface flinger的ISurfaceComposerClient完成layer/surface/buffer管理？


---

**Cursor**

这个理解基本正确，但有一个关键细节需要修正。让我结合源码来精确说明。

先确认一下 `Transaction::apply()` 走的是哪条通道：

拿到了关键证据，现在可以给出精确的分析。

---

## 你的理解基本正确，但有一个重要修正

你的理解可以用这张图来检验：

```
你的理解（接近正确）：
  APP → ISurfaceComposer.createConnection() → 得到 mClient
  之后所有通信 → mClient (ISurfaceComposerClient) 完成

实际情况（需要修正）：
  APP → ISurfaceComposer.createConnection() → 得到 mClient
  
  ┌─ Surface/Layer 生命周期管理 → mClient (ISurfaceComposerClient)  ✓
  └─ Transaction 提交（最核心的 Buffer/状态变更）→ 仍然走 ISurfaceComposer  ✗你的理解
```

---

### 关键证据：`Transaction::apply()` 走的是哪条通道

源码明确显示，`Transaction::apply()` 最终调用的是**全局 `ISurfaceComposer`**，而不是 `mClient`：

```1230:1236:android14/frameworks/native/libs/gui/SurfaceComposerClient.cpp
    sp<ISurfaceComposer> sf(ComposerService::getComposerService());
    sf->setTransactionState(mFrameTimelineInfo, composerStates, displayStates, flags, applyToken,
                            mInputWindowCommands, mDesiredPresentTime, mIsAutoTimestamp,
                            mUncacheBuffers, hasListenerCallbacks, listenerCallbacks, mId,
                            mMergedTransactionIds);
```

---

### 两条通道的精确职责划分

结合所有源码，实际的完整模型是：

```
onFirstRef() 阶段：
  ComposerServiceAIDL ("SurfaceFlingerAIDL")
      └─ sf->createConnection()
           └─ mClient = ISurfaceComposerClient（每连接独享）

运行时，两条通道并行存在：

  通道 A：mClient (ISurfaceComposerClient)
  ─────────────────────────────────────
  仅负责 Surface/Layer 的生命周期操作：
  ① createSurface()   → 创建 Layer，返回 handle
  ② mirrorSurface()   → 镜像 Layer
  ③ clearLayerFrameStats() / getLayerFrameStats()
  特点：有状态，归属当前连接，进程死亡自动清理

  通道 B：ComposerService ("SurfaceFlinger") 全局单例
  ─────────────────────────────────────────────────
  负责所有状态变更的提交和全局配置：
  ① setTransactionState()  → Transaction::apply() 的最终落点
     （setLayer/setAlpha/setMatrix/setBuffer 等全部在这里提交）
  ② createDisplay() / destroyDisplay()
  ③ getDisplayState() / setDisplayBrightness()
  ④ bootFinished() / notifyPowerBoost()
  特点：无状态，全进程共享，不区分调用方
```

---

### 为什么 Transaction 要走全局通道而不走 mClient？

这是设计上最精妙的地方。`Transaction` 在提交时可以**跨越多个 `SurfaceControl`**（来自不同的 `SurfaceComposerClient`），甚至可以被 `merge()` 合并：

```cpp
// Transaction 可以包含来自任意 SurfaceControl 的状态
Transaction& merge(Transaction&& other);  // 合并两个 Transaction
```

如果走 `mClient` 提交，就只能处理"属于本连接的 Layer"，无法支持跨连接的原子提交。走全局 `ISurfaceComposer::setTransactionState()` 才能保证**多个 Layer 的状态变更原子地生效**。

---

### 修正后的完整理解

```
① APP 连接到全局 ISurfaceComposer（"SurfaceFlingerAIDL"）
② 通过 createConnection() 得到专属 mClient（ISurfaceComposerClient）
③ mClient 负责：Surface/Layer 的创建和销毁（生命周期）
④ 所有属性变更（setLayer/show/setBuffer等）先在本地 Transaction 聚合
⑤ Transaction::apply() 走全局 ISurfaceComposer::setTransactionState() 提交
   ↑ 这是你理解需要修正的部分

总结：mClient 管"有什么 Layer"，ISurfaceComposer 管"Layer 现在是什么状态"
```

```plaintext
你的理解（接近正确）：
  APP → ISurfaceComposer.createConnection() → 得到 mClient
  之后所有通信 → mClient (ISurfaceComposerClient) 完成

实际情况（需要修正）：
  APP → ISurfaceComposer.createConnection() → 得到 mClient
  
  ┌─ Surface/Layer 生命周期管理 → mClient (ISurfaceComposerClient)  ✓
  └─ Transaction 提交（最核心的 Buffer/状态变更）→ 仍然走 ISurfaceComposer  ✗你的理解
```

```cpp
    sp<ISurfaceComposer> sf(ComposerService::getComposerService());
    sf->setTransactionState(mFrameTimelineInfo, composerStates, displayStates, flags, applyToken,
                            mInputWindowCommands, mDesiredPresentTime, mIsAutoTimestamp,
                            mUncacheBuffers, hasListenerCallbacks, listenerCallbacks, mId,
                            mMergedTransactionIds);
```

```plaintext
onFirstRef() 阶段：
  ComposerServiceAIDL ("SurfaceFlingerAIDL")
      └─ sf->createConnection()
           └─ mClient = ISurfaceComposerClient（每连接独享）

运行时，两条通道并行存在：

  通道 A：mClient (ISurfaceComposerClient)
  ─────────────────────────────────────
  仅负责 Surface/Layer 的生命周期操作：
  ① createSurface()   → 创建 Layer，返回 handle
  ② mirrorSurface()   → 镜像 Layer
  ③ clearLayerFrameStats() / getLayerFrameStats()
  特点：有状态，归属当前连接，进程死亡自动清理

  通道 B：ComposerService ("SurfaceFlinger") 全局单例
  ─────────────────────────────────────────────────
  负责所有状态变更的提交和全局配置：
  ① setTransactionState()  → Transaction::apply() 的最终落点
     （setLayer/setAlpha/setMatrix/setBuffer 等全部在这里提交）
  ② createDisplay() / destroyDisplay()
  ③ getDisplayState() / setDisplayBrightness()
  ④ bootFinished() / notifyPowerBoost()
  特点：无状态，全进程共享，不区分调用方
```

```cpp
// Transaction 可以包含来自任意 SurfaceControl 的状态
Transaction& merge(Transaction&& other);  // 合并两个 Transaction
```

```plaintext
① APP 连接到全局 ISurfaceComposer（"SurfaceFlingerAIDL"）
② 通过 createConnection() 得到专属 mClient（ISurfaceComposerClient）
③ mClient 负责：Surface/Layer 的创建和销毁（生命周期）
④ 所有属性变更（setLayer/show/setBuffer等）先在本地 Transaction 聚合
⑤ Transaction::apply() 走全局 ISurfaceComposer::setTransactionState() 提交
   ↑ 这是你理解需要修正的部分

总结：mClient 管"有什么 Layer"，ISurfaceComposer 管"Layer 现在是什么状态"
```

