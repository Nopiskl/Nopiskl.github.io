
---

## 5. `ISurfaceComposer` 和 `ISurfaceComposerClient` 的区别

这里有两个 Binder 接口：

```text
ISurfaceComposer
ISurfaceComposerClient
```

它们职责不同。

### 5.1 `ISurfaceComposer`

`ISurfaceComposer` 可以理解为 SurfaceFlinger 对外暴露的全局服务入口。

App 先通过它调用：

```cpp
sf->createConnection(&conn);
```

含义是：

```text
App：SurfaceFlinger，我要建立一个客户端连接。
SurfaceFlinger：好，我给你创建一个属于你的 Client 对象。
```

### 5.2 `ISurfaceComposerClient`

`ISurfaceComposerClient` 是每个客户端连接对应的 Binder 接口。

`createConnection()` 返回之后，App 后续创建 Surface / Layer 相关的操作，会继续走这个接口。

例如：

```cpp
mClient->createSurface(...)
```

这里的 `mClient` 类型就是：

```cpp
sp<ISurfaceComposerClient>
```

---

## 6. SurfaceFlinger 侧创建了什么？

SurfaceFlinger 侧的 `createConnection()` 会创建一个服务端 `Client` 对象：

```cpp
binder::Status SurfaceComposerAIDL::createConnection(
        sp<gui::ISurfaceComposerClient>* outClient) {
    const sp<Client> client = sp<Client>::make(mFlinger);
    if (client->initCheck() == NO_ERROR) {
        *outClient = client;
        return binder::Status::ok();
    } else {
        *outClient = nullptr;
        return binderStatusFromStatusT(BAD_VALUE);
    }
}
```

这里的 `Client` 位于 SurfaceFlinger 进程中。

它继承自：

```cpp
class Client : public gui::BnSurfaceComposerClient
```

含义是：

```text
Client 是 ISurfaceComposerClient 的服务端实现。
```

App 进程拿到的不是这个 `Client` 对象的真实指针，而是它的 Binder 代理。

---

## 7. App 侧和 SurfaceFlinger 侧的对象关系

App 侧：

```text
SurfaceComposerClient
    └── mClient: BpSurfaceComposerClient
```

SurfaceFlinger 侧：

```text
Client
    └── BnSurfaceComposerClient
```

其中：

```text
BpSurfaceComposerClient
= Binder Proxy，运行在 App 进程

BnSurfaceComposerClient
= Binder Native Stub，运行在 SurfaceFlinger 进程
```

`Bp` 和 `Bn` 这类胶水代码由 AIDL 自动生成。

---

## 8. 创建 Surface 的真实调用链

App 调用：

```cpp
client->createSurface(...)
```

看起来是在调用 `SurfaceComposerClient` 的方法。

但内部最终会转发给：

```cpp
mClient->createSurface(...)
```

这就进入了 Binder IPC。

完整调用链可以简化为：

```text
App 进程

new SurfaceComposerClient()
        |
        v
SurfaceComposerClient::onFirstRef()
        |
        v
ISurfaceComposer::createConnection()
        |
        | Binder IPC，走 ISurfaceComposer.aidl
        v

SurfaceFlinger 进程

SurfaceComposerAIDL::createConnection()
        |
        v
new Client(mFlinger)
        |
        v
返回 ISurfaceComposerClient Binder 给 App


之后 App 创建 Surface：

App 进程

SurfaceComposerClient::createSurface()
        |
        v
mClient->createSurface()
        |
        | Binder IPC，走 ISurfaceComposerClient.aidl
        v

SurfaceFlinger 进程

Client::createSurface()
        |
        v
SurfaceFlinger::createLayer()
```

SurfaceFlinger 侧最终会走到类似逻辑：

```cpp
binder::Status Client::createSurface(
        const std::string& name,
        int32_t flags,
        const sp<IBinder>& parent,
        const gui::LayerMetadata& metadata,
        gui::CreateSurfaceResult* outResult) {
    sp<IBinder> handle;
    LayerCreationArgs args(
            mFlinger.get(),
            sp<Client>::fromExisting(this),
            name.c_str(),
            static_cast<uint32_t>(flags),
            std::move(metadata));
    args.parentHandle = parent;
    const status_t status = mFlinger->createLayer(args, *outResult);
    return binderStatusFromStatusT(status);
}
```

这里真正创建 Layer 的是：

```cpp
mFlinger->createLayer(...)
```

也就是 SurfaceFlinger 进程里的逻辑。


## 11. 最终总结

`sp<SurfaceComposerClient> client = new SurfaceComposerClient()` 只是在 App 进程中创建了一个本地 C++ 包装对象。

这个对象本身不能直接创建 Layer。

它在 `onFirstRef()` 中通过：

```cpp
ISurfaceComposer::createConnection()
```

向 SurfaceFlinger 请求创建一个服务端 `Client` 对象。

SurfaceFlinger 返回一个 `ISurfaceComposerClient` Binder 连接给 App。

之后 App 调用：

```cpp
SurfaceComposerClient::createSurface()
```

内部实际会走：

```cpp
mClient->createSurface()
```

也就是通过 `ISurfaceComposerClient.aidl` 跨进程调用 SurfaceFlinger 里的：

```cpp
Client::createSurface()
```

最终再由 SurfaceFlinger 调用：

```cpp
SurfaceFlinger::createLayer()
```

因此：

> 没有 `ISurfaceComposerClient.aidl`，App 侧的 `SurfaceComposerClient` 就只是一个本地空壳，无法让 SurfaceFlinger 真正创建任何 Layer。
