
SurfaceFlinger:
APP/framework
  SurfaceComposerClient，本地包装
    -> ISurfaceComposer.aidl createConnection()
       -> SurfaceFlinger 进程创建 services/surfaceflinger/Client
          -> 返回 ISurfaceComposerClient Binder
             -> 后续 createSurface() 走 ISurfaceComposerClient.aidl

Codec2:
APP/framework/MediaCodec/CCodec
  Codec2Client，本地包装
    -> 直接通过 HIDL service manager 找 IComponentStore service
       -> IComponentStore::createComponent()
          -> Codec2 service 进程创建/返回 IComponent HIDL 对象
             -> 后续 start/queue/flush/stop 走 IComponent HIDL 接口

普通 APP 通常不直接和 Codec2Client 交互，而是通过 MediaCodec。MediaCodec 选择 CCodec 路径后，framework/native 层的 CCodec 会使用 Codec2Client。Codec2Client 再通过导出的 HIDL 接口连接 Codec2 service