# 全志多路编解码模型分析：多软件通道 + VE 分时复用

本文把本次讨论、当前 SDK 源码、内核 `cedar-ve` 驱动、以及 TinyVision 中的播放器 demo 证据合在一起，解释全志多路编解码到底是怎样工作的。

核心结论先放前面：

1. **应用和 MPP 层支持多路逻辑通道**。`VENC_MAX_CHN_NUM` 和 `VDEC_MAX_CHN_NUM` 都定义为 16，`AW_MPI_VENC_CreateChn()` / `AW_MPI_VDEC_CreateChn()` 都是按 channel id 创建独立 component 节点。
2. **多路不是每一路都有独立硬件编解码核心**。每个 channel 有自己的上下文、队列、线程、buffer 管理和回调，但真正进入 VE 硬件执行时，需要通过 `cedar-ve` 的 lock。
3. **同类任务是分时复用硬件路径**。多路编码共享 VENC 硬件路径，多路解码共享 VDEC 硬件路径。源码里 VENC 路径能直接看到 `CdcVeLock -> pVEncDevice->encode -> CdcVeUnLock`。内核层能看到 `VE_LOCK_VENC` / `VE_LOCK_VDEC` 分别对应 `lock_venc` / `lock_vdec`。
4. **demo 的证明力不同**。`sample_CodecParallel` 可以证明多编码 + 单解码并行框架；`vdecoderDemo` / `decodertest` 只证明单路解码；`xplayerdemo` 原版也是单实例；TinyVision 的 `tplayerdemo` 多文件参数模式可以直接验证 1-4 个播放器实例并发，也就是多路解码/播放模型。

## 1. 总体架构

可以把全志多路编解码分成四层：

```text
应用 / sample / demo
  sample_CodecParallel / tplayerdemo / xplayerdemo / decodertest

MPP / Player 逻辑层
  AW_MPI_VENC / AW_MPI_VDEC / TPlayer / XPlayer
  每一路创建自己的 channel 或 player context

Component / CedarC 层
  VideoEnc_Component / VideoDec_Component
  vencoder / vdecoder
  每一路有自己的 component、队列、线程、VideoEncoder 或 VideoDecoder 上下文

Kernel VE 驱动
  lichee/linux-4.9/drivers/media/cedar-ve
  用 VE_LOCK_VENC / VE_LOCK_VDEC 等锁保护硬件访问
```

多路的本质不是“硬件复制 N 份”，而是：

```text
VENC chn0 -> component0 -> VencContext0 -> encodeOneFrame()
VENC chn1 -> component1 -> VencContext1 -> encodeOneFrame()
VENC chn2 -> component2 -> VencContext2 -> encodeOneFrame()

进入硬件前：
  CdcVeLock(...)
  pVEncDevice->encode(...)
  CdcVeUnLock(...)
```

解码同理：

```text
VDEC chn0 -> component0 -> VideoDecoder0 -> DecodeVideoStream()
VDEC chn1 -> component1 -> VideoDecoder1 -> DecodeVideoStream()
VDEC chn2 -> component2 -> VideoDecoder2 -> DecodeVideoStream()

进入 VE 时受 cedar-ve 的 VE_LOCK_VDEC 保护
```

所以“多路能力”主要体现在上层通道、buffer、线程、调度、回调、VBV/FBM 管理上；“硬件执行”仍然是受锁仲裁的共享资源。

## 2. MPP 层确实支持多逻辑通道

### 2.1 VENC 最大通道数

`external/eyesee-mpp/middleware/sun8iw21/include/utils/plat_defines.h:65`：

```c
#define VENC_MAX_CHN_NUM        16
```

`external/eyesee-mpp/middleware/sun8iw21/include/utils/plat_defines.h:95`：

```c
#define VDEC_MAX_CHN_NUM        16
```

这说明 MPP API 设计上不是只有一个编码/解码通道，而是允许多个逻辑 channel id。

### 2.2 VENC channel manager

`external/eyesee-mpp/middleware/sun8iw21/media/mpi_venc.c:50` 定义了 `VENC_CHN_MAP_S`：

```c
VENC_CHN            mVeChn;
MM_COMPONENTTYPE    *mEncComp;
struct list_head    mList;
```

`external/eyesee-mpp/middleware/sun8iw21/media/mpi_venc.c:73` 定义 `VencChnManager`，内部维护 `mChnList`。

`AW_MPI_VENC_CreateChn()` 在 `external/eyesee-mpp/middleware/sun8iw21/media/mpi_venc.c:492`：

1. 检查 `VeChn` 是否在 `[0, VENC_MAX_CHN_NUM)`。
2. 检查该 channel 是否已存在。
3. `VENC_CHN_MAP_S_Construct()` 创建节点。
4. `COMP_GetHandle(... CDX_ComponentNameVideoEncoder ...)` 创建 VideoEncoder component。
5. 设置 `MPPChannelInfo`、`VencChnAttr`、`VEFreq`。
6. `addChannel_l(pNode)` 挂到全局 channel list。

这就是典型的“一个 VENC channel 对应一个 component 实例”。

`AW_MPI_VENC_StartRecvPic()` 在 `external/eyesee-mpp/middleware/sun8iw21/media/mpi_venc.c:682`，对指定 channel 的 component 发送 `COMP_StateExecuting`。`AW_MPI_VENC_SendFrame()` 和 `AW_MPI_VENC_GetStream()` 也都是先通过 `VeChn` 找到 `VENC_CHN_MAP_S`，再转到对应 component。

### 2.3 VDEC channel manager

`external/eyesee-mpp/middleware/sun8iw21/media/mpi_vdec.c:38` 定义了 `VDEC_CHN_MAP_S`：

```c
VDEC_CHN            mVdChn;
MM_COMPONENTTYPE    *mComp;
struct list_head    mList;
```

`external/eyesee-mpp/middleware/sun8iw21/media/mpi_vdec.c:47` 定义 `VdecChnManager`，内部维护 `mList`。

`AW_MPI_VDEC_CreateChn()` 在 `external/eyesee-mpp/middleware/sun8iw21/media/mpi_vdec.c:316`：

1. 检查 `VdChn` 是否在 `[0, VDEC_MAX_CHN_NUM)`。
2. 检查该 channel 是否已存在。
3. `VDEC_CHN_MAP_S_Construct()` 创建节点。
4. `COMP_GetHandle(... CDX_ComponentNameVideoDecoder ...)` 创建 VideoDecoder component。
5. 设置 `MPPChannelInfo`、`VdecChnAttr`、`VEFreq`。
6. `addChannel_l(pNode)` 挂入全局 channel list。

`AW_MPI_VDEC_StartRecvStream()` 在 `external/eyesee-mpp/middleware/sun8iw21/media/mpi_vdec.c:453`，对指定 VDEC channel 的 component 切到 executing。`AW_MPI_VDEC_SendStream()` 在 `external/eyesee-mpp/middleware/sun8iw21/media/mpi_vdec.c:880`，也是按 `VdChn` 找到对应 component 后送入该通道。

因此，MPP 层能支持多路 VENC/VDEC 的结论是明确的。

## 3. 编码链路：多通道共享 VENC 硬件路径

### 3.1 每个 VENC component 会创建自己的 encoder 上下文

`external/eyesee-mpp/middleware/sun8iw21/media/component/VideoEnc_Component.c:5578` 的 `VideoEncCreateEncoder()` 会在 component idle 状态下创建编码库：

```c
if(NULL == pVideoEncData->pCedarV)
{
    CedarvEncInit(pVideoEncData);
}
```

而 CedarC 的 `vencoder.c` 里，`VencContext` 是每个 `VideoEncoder` 实例自己的上下文。`external/eyesee-mpp/middleware/sun8iw21/media/LIBRARY/libcedarc/vencoder/vencoder.c:110` 可以看到：

```c
typedef struct VencContext
{
    int                  nChannelId;
    VENC_DEVICE*         pVEncDevice;
    void*                pEncoderHandle;
    FrameBufferManager*  pFBM;
    VeOpsS*              veOpsS;
    void*                pVeOpsSelf;
    pthread_t            processThread;
    CdcMessageQueue*     mq;
    ...
} VencContext;
```

这个结构说明每个 encoder 实例都有：

- 自己的 channel id
- 自己的编码设备句柄
- 自己的输入 FBM
- 自己的线程和消息队列
- 自己的 VE ops 入口

### 3.2 真正进入硬件 encode 时有 VE lock

最关键的证据在 `external/eyesee-mpp/middleware/sun8iw21/media/LIBRARY/libcedarc/vencoder/vencoder.c:302` 的 `encodeOneFrame()`。

在 `external/eyesee-mpp/middleware/sun8iw21/media/LIBRARY/libcedarc/vencoder/vencoder.c:421`：

```c
CdcVeLock(venc_ctx->veOpsS, venc_ctx->pVeOpsSelf);
result = venc_ctx->pVEncDevice->encode(venc_ctx->pEncoderHandle,
                                       &venc_ctx->curEncInputbuffer);
CdcVeUnLock(venc_ctx->veOpsS, venc_ctx->pVeOpsSelf);
```

这段代码非常直接：不管上层有多少个 `VencContext`，真正调用 `pVEncDevice->encode()` 之前都会拿 VE lock，完成后释放。

`CdcVeLock()` 本身在 `external/eyesee-mpp/middleware/sun8iw21/media/LIBRARY/libcedarc/include/veInterface.h:200`，只是转调 `veops->lock(p)`：

```c
static inline int CdcVeLock(VeOpsS *veops, void *p)
{
    return veops->lock(p);
}
```

所以编码侧的执行模型可以简化为：

```text
VencContext0: 准备输入帧、码率、OSD、VBV
VencContext1: 准备输入帧、码率、OSD、VBV
VencContext2: 准备输入帧、码率、OSD、VBV

硬件 encode 临界区：
  channel i 拿 VE lock
  调用 pVEncDevice->encode()
  释放 VE lock
  下一个 channel 再进来
```

### 3.3 vencoder 自己也有多通道轮询/调度痕迹

`external/eyesee-mpp/middleware/sun8iw21/media/LIBRARY/libcedarc/vencoder/vencoder.c:154` 定义了 `OnlineVencContext`：

```c
VencContext *pVencCxt[MAX_VENCODER_CHANNEL_NUM];
pthread_t    onlineThread;
int          nValidChannelNum;
int          nOnlineChannelIndex;
```

`external/eyesee-mpp/middleware/sun8iw21/media/LIBRARY/libcedarc/vencoder/vencoder.c:2268` 附近可以看到它遍历 `pOnlineCxt->pVencCxt[i]`，对不同 `VencContext` 调用 `encodeOneFrame()`。`external/eyesee-mpp/middleware/sun8iw21/media/LIBRARY/libcedarc/vencoder/vencoder.c:2311` 又处理 online channel。

这说明 CedarC 编码库不仅允许多个 `VencContext`，还专门有 online/offline channel 相关的调度逻辑。但最终每次执行硬件编码还是落到 `encodeOneFrame()` 的 VE lock 临界区。

## 4. 解码链路：多 VDEC component / VideoDecoder 实例共享 VDEC 硬件路径

### 4.1 每个 VDEC channel 创建自己的 VideoDecoder

`external/eyesee-mpp/middleware/sun8iw21/media/component/VideoDec_Component.c:527` 的 `CedarvCodecInit()` 会给当前 VDEC component 创建 CedarC decoder。

关键位置在 `external/eyesee-mpp/middleware/sun8iw21/media/component/VideoDec_Component.c:570`：

```c
pCedarV = CreateVideoDecoder();
```

然后在 `external/eyesee-mpp/middleware/sun8iw21/media/component/VideoDec_Component.c:753`：

```c
ret = InitializeVideoDecoder(pCedarV, pVideoStreamInfo, &pVideoDecData->mVConfig);
```

最后把这个 decoder 保存到当前 component 私有数据：

```c
pVideoDecData->pCedarV = pCedarV;
```

因此多个 VDEC channel 的模型是：

```text
VDEC chn0 -> VideoDec_Component0 -> pCedarV0
VDEC chn1 -> VideoDec_Component1 -> pCedarV1
VDEC chn2 -> VideoDec_Component2 -> pCedarV2
```

### 4.2 每个 VDEC component 有自己的线程

`external/eyesee-mpp/middleware/sun8iw21/media/component/VideoDec_Component.c:3358` 创建 component thread：

```c
pthread_create(&pVideoDecData->thread_id, NULL, ComponentThread, pVideoDecData);
```

在 `external/eyesee-mpp/middleware/sun8iw21/media/component/VideoDec_Component.c:3568`，线程名设置为：

```c
VDecChn%d
```

所以如果真的创建多个 VDEC channel，系统里应该能看到多个 `VDecChn0`、`VDecChn1` 这样的线程。

### 4.3 每个 VDEC component 的线程调用自己的 DecodeVideoStream()

`external/eyesee-mpp/middleware/sun8iw21/media/component/VideoDec_Component.c:4121` 取当前 component 的 `pCedarV`：

```c
VideoDecoder *pCedarV = pVideoDecData->pCedarV;
```

在 `external/eyesee-mpp/middleware/sun8iw21/media/component/VideoDec_Component.c:4159` 调用：

```c
DecodeVideoStream(pCedarV, bStreamEOF, 0, pVideoDecData->drop_B_frame, 0);
```

也就是说多路 VDEC 并不是一个 `DecodeVideoStream()` 里管理多个码流，而是多个 component/线程各自调用自己的 decoder 实例。

### 4.4 解码 demo 与 VDEC 框架能力要分开看

本地 `external/libcedarc/demo/vdecoderDemo/vdecoderDemo.c` 是单路 decoder demo：

- `external/libcedarc/demo/vdecoderDemo/vdecoderDemo.c:852` 只有一个 `DecDemo Decoder;`
- `external/libcedarc/demo/vdecoderDemo/vdecoderDemo.c:265` 只创建一个 `CreateVideoDecoder()`
- `external/libcedarc/demo/vdecoderDemo/vdecoderDemo.c:437` 的 `DecodeVideoStream()` 使用的也是这个单一 decoder
- `external/libcedarc/demo/vdecoderDemo/vdecoderDemo.c:946` 到 `948` 创建 parser/decode/display 三个线程，但这三个线程共享同一个 `Decoder`

所以这个 demo 只能证明：

```text
单个 VideoDecoder + parser/decode/display 多线程
```

不能证明：

```text
多个 VideoDecoder 并发解码
```

同理，TinyVision 的 `decodertest` 也是单 `VideoDecoder` 路径。它能做 API smoke test，不能做多路解码证明。

## 5. 内核层：cedar-ve 用 lock 仲裁 VE 访问

内核驱动路径：

```text
lichee/linux-4.9/drivers/media/cedar-ve/
```

`lichee/linux-4.9/drivers/media/cedar-ve/cedar_ve.h:58` 定义：

```c
IOCTL_GET_LOCK
IOCTL_RELEASE_LOCK
```

`lichee/linux-4.9/drivers/media/cedar-ve/cedar_ve.h:100` 定义：

```c
#define VE_LOCK_VDEC 0x01
#define VE_LOCK_VENC 0x02
```

`lichee/linux-4.9/drivers/media/cedar-ve/cedar_ve.c:324` 的设备私有结构里有：

```c
struct mutex lock_vdec;
struct mutex lock_venc;
```

初始化在 `lichee/linux-4.9/drivers/media/cedar-ve/cedar_ve.c:3365`：

```c
mutex_init(&cedar_devp->lock_vdec);
mutex_init(&cedar_devp->lock_venc);
```

`IOCTL_GET_LOCK` 在 `lichee/linux-4.9/drivers/media/cedar-ve/cedar_ve.c:2052`：

```c
if (lock_type == VE_LOCK_VDEC)
    mutex_lock(&cedar_devp->lock_vdec);
else if (lock_type == VE_LOCK_VENC)
    mutex_lock(&cedar_devp->lock_venc);
```

`IOCTL_RELEASE_LOCK` 在 `lichee/linux-4.9/drivers/media/cedar-ve/cedar_ve.c:2113`：

```c
if (lock_type == VE_LOCK_VDEC)
    mutex_unlock(&cedar_devp->lock_vdec);
else if (lock_type == VE_LOCK_VENC)
    mutex_unlock(&cedar_devp->lock_venc);
```

这个内核证据非常关键：如果硬件是“每路一个独立 VDEC/VENC core”，就不需要所有同类任务都走同一把 `lock_vdec` / `lock_venc`。这里的模型更符合“多软件上下文共享单个 VDEC/VENC 硬件执行路径”。

需要注意一个细节：源码中 VDEC 和 VENC 是两把锁，不是一把全局大锁。因此更准确的说法是：

```text
多路 VENC 之间共享 VENC 硬件路径，受 lock_venc 仲裁。
多路 VDEC 之间共享 VDEC 硬件路径，受 lock_vdec 仲裁。
编解码同时存在时，属于同一个 VE 子系统内的不同 lock domain，SDK 还提供了 EncAndDecCase 之类的专门配置。
```

因此“单编解码核心 + 分时复用”应理解为：不是 N 路就有 N 个硬件编解码核心，而是多个软件通道复用有限的 VE 编码/解码硬件资源。

## 6. sample_CodecParallel 能证明什么

当前关注文件：

```text
external/eyesee-mpp/middleware/sun8iw21/sample/sample_CodecParallel/sample_CodecParallel.c
```

### 6.1 它支持主码流编码 + 子码流编码

`loadRecordConfig()` 在 `sample_CodecParallel.c:219`，主编码通道默认：

```c
pRec->mVencCfg.mVencChn = 0;
```

`loadSubRecordConfig()` 在 `sample_CodecParallel.c:252`，子编码通道默认：

```c
pRec->mVencCfg.mVencChn = 1;
```

`prepare()` 在 `sample_CodecParallel.c:2380`：

- `sample_CodecParallel.c:2393` 如果 `mRec.mEnable`，调用 `prepareRecord(&mRec)`
- `sample_CodecParallel.c:2406` 如果 `mSubRec.mEnable`，调用 `prepareRecord(&mSubRec)`

`prepareRecord()` 在 `sample_CodecParallel.c:1612`：

1. 创建 VI channel。
2. 配置 VENC channel。
3. `sample_CodecParallel.c:1629` 调用 `createVencChn(&pRec->mVencPara)`。
4. 创建 MUX channel。

`start()` 在 `sample_CodecParallel.c:2448`：

- `sample_CodecParallel.c:2463` 启动主 record。
- `sample_CodecParallel.c:2475` 启动子 record。

这证明 sample 本身支持多 VENC channel，也就是多路编码 demo。

### 6.2 它只有一路播放/解码

`loadPlayConfig()` 在 `sample_CodecParallel.c:306`，只配置一个 `PlayContext`。

`preparePlay()` 在 `sample_CodecParallel.c:2175`：

1. 创建一个 demux。
2. 配置一个 VDEC。
3. `sample_CodecParallel.c:2202` 调用一次 `createVdecChn(&pPlay->mVdecPara)`。
4. 创建一个 VO。

`createVdecChn()` 在 `sample_CodecParallel.c:1222`，里面的 while 循环从 0 开始找空闲 VDEC channel id：

```c
pVdecPara->mVdecChn = 0;
while (pVdecPara->mVdecChn < VDEC_MAX_CHN_NUM) {
    AW_MPI_VDEC_CreateChn(...)
}
```

这个循环只是“给当前一路播放找一个空闲 VDEC channel”，不是创建多路 VDEC。

`prepare()` 在 `sample_CodecParallel.c:2432` 只对 `pContext->mPlay` 调用一次 `preparePlay()`。`start()` 在 `sample_CodecParallel.c:2497` 也只对 `mPlay` 调用一次 `startPlay()`。

所以 `sample_CodecParallel` 的能力边界是：

```text
能证明：
  多路编码 + 一路解码/播放 可以共存
  编码和解码并行场景下 SDK 有专门处理

不能证明：
  多路解码同时进行
```

### 6.3 EncAndDecCase 说明 SDK 知道这是编解码并行场景

`sample_CodecParallel.c:1145` 注释写明：

```c
// only for code parallel, only set online channel
```

随后在 `sample_CodecParallel.c:1150` 调用：

```c
AW_MPI_VENC_SetEncAndDecCase(pVencPara->mVencChn, TRUE);
```

触发条件是：

```text
play enabled
record 或 subrecord enabled
当前 venc 是 online channel
```

这说明全志 SDK 对“编码 + 解码并行”有特别路径，不是把所有通道理解成彼此独立硬件。

## 7. 播放器 demo 能证明什么

### 7.1 xplayerdemo 原版不能证明多路解码

TinyVision 的 `xplayerdemo` 原版 `main()` 只有一个：

```c
DemoPlayerContext demoPlayer;
demoPlayer.mAwPlayer = XPlayerCreate();
```

参考：

https://github.com/YuzukiHD/TinyVision/blob/main/tina/openwrt/package/allwinner/multimedia/tina_multimedia/libcedarx/demo/xplayerdemo/xplayerdemo.c#L420-L442

后续 `XPlayerSetDataSourceUrl()`、`XPlayerPrepareAsync()`、`XPlayerStart()` 都作用在同一个 `demoPlayer.mAwPlayer`：

https://github.com/YuzukiHD/TinyVision/blob/main/tina/openwrt/package/allwinner/multimedia/tina_multimedia/libcedarx/demo/xplayerdemo/xplayerdemo.c#L516-L546

所以原版 xplayerdemo 是：

```text
1 个 XPlayer -> 1 路 demux/decode/render
```

不能直接证明多路解码。

但 `XPlayerCreate()` 本身是多实例友好的。TinyVision 的 `xplayer.c` 中每次 `XPlayerCreate()` 都会创建自己的 `PlayerContext`、`Player`、`DemuxComp` 和线程：

https://github.com/YuzukiHD/TinyVision/blob/main/tina/openwrt/package/allwinner/multimedia/tina_multimedia/libcedarx/xplayer/xplayer.c#L237-L314

往下 `PlayerInitialVideo()` 会给当前 player 创建 `VideoDecComp`：

https://github.com/YuzukiHD/TinyVision/blob/main/tina/openwrt/package/allwinner/multimedia/tina_multimedia/libcedarx/libcore/playback/player.c#L4312-L4345

`VideoDecCompCreate()` 又创建自己的 `VideoDecoder` 和 decode thread：

https://github.com/YuzukiHD/TinyVision/blob/main/tina/openwrt/package/allwinner/multimedia/tina_multimedia/libcedarx/libcore/playback/videoDecComponent.c#L91-L144

所以 xplayerdemo 如果改成多个 `XPlayerCreate()`，可以验证多路解码；原版不行。

### 7.2 tplayerdemo 的 TinyVision 版本可以直接验证 1-4 路

TinyVision 的 `tplayerdemo` 比 xplayerdemo 更直接。它有：

```c
DemoPlayerContext gDemoPlayers[5];
```

参考：

https://github.com/YuzukiHD/TinyVision/blob/main/tina/openwrt/package/allwinner/multimedia/tina_multimedia_demo/tplayerdemo/src/tplayerdemo.c#L111

`main()` 里有：

```c
if(argc > 1 && argc < 6)   /* can play 1-4 video*/
```

参考：

https://github.com/YuzukiHD/TinyVision/blob/main/tina/openwrt/package/allwinner/multimedia/tina_multimedia_demo/tplayerdemo/src/tplayerdemo.c#L971

`createPlayersAndPlayVideos()` 在每个文件参数上创建一个 TPlayer：

```c
gDemoPlayers[i].mTPlayer = TPlayerCreate(CEDARX_PLAYER);
```

参考：

https://github.com/YuzukiHD/TinyVision/blob/main/tina/openwrt/package/allwinner/multimedia/tina_multimedia_demo/tplayerdemo/src/tplayerdemo.c#L674-L735

`playVideo()` 对每一路执行：

```c
TPlayerSetDataSource(...)
TPlayerPrepare(...)
TPlayerSetDisplayRect(...)
TPlayerStart(...)
```

参考：

https://github.com/YuzukiHD/TinyVision/blob/main/tina/openwrt/package/allwinner/multimedia/tina_multimedia_demo/tplayerdemo/src/tplayerdemo.c#L631-L667

并且 demo 对 2/3/4 路分别做了分屏布局：

- 2 路：左右分屏，`tplayerdemo.c:754`
- 3 路：左半屏 + 右上 + 右下，`tplayerdemo.c:776`
- 4 路：四宫格，`tplayerdemo.c:806`

因此运行：

```sh
tplayerdemo /mnt/UDISK/0.mp4 /mnt/UDISK/1.mp4
tplayerdemo /mnt/UDISK/0.mp4 /mnt/UDISK/1.mp4 /mnt/UDISK/2.mp4 /mnt/UDISK/3.mp4
```

理论上就是：

```text
TPlayer0 -> XPlayer0 -> VideoDecComp0 -> VideoDecoder0
TPlayer1 -> XPlayer1 -> VideoDecComp1 -> VideoDecoder1
TPlayer2 -> XPlayer2 -> VideoDecComp2 -> VideoDecoder2
TPlayer3 -> XPlayer3 -> VideoDecComp3 -> VideoDecoder3
```

这可以验证“多路软件解码实例并发运行”。如果多路都能持续出帧，就说明多路 VDEC 逻辑通道和 VE 分时复用路径工作正常。

但它不能证明“硬件有 4 个独立解码器”。结合 `cedar-ve` lock，只能证明多个软件实例能共享 VE 解码硬件。

### 7.3 本地 tplayer 封装确认 TPlayer 是 XPlayer wrapper

本地 SDK 的 `external/multimedia/tplayer/tplayer.h:111`：

```c
typedef struct TPlayerContext
{
    XPlayer* mXPlayer;
    ...
} TPlayer;
```

`external/multimedia/tplayer/tplayer.c:191` 的 `TPlayerCreate()` 每次都会分配一个 `TPlayer`。在 `external/multimedia/tplayer/tplayer.c:210`：

```c
mPrivateData->mXPlayer = XPlayerCreate();
```

`external/multimedia/tplayer/tplayer.c:319` 起，`TPlayerSetDataSource()`、`TPlayerPrepare()`、`TPlayerStart()` 都转调到 `XPlayer`：

```c
TPlayerSetDataSource -> XPlayerSetDataSourceUrl
TPlayerPrepare      -> XPlayerPrepare
TPlayerStart        -> XPlayerStart
```

这说明 TPlayer 多实例实际就是 XPlayer 多实例。

需要注意：本地 `external/multimedia_demo/tplayerdemo/src/tplayerdemo.c` 与 TinyVision 的 `tplayerdemo` 版本不完全相同。本文把“TinyVision tplayerdemo 支持 1-4 路参数播放”作为外部 demo 证据；本地 SDK 的 tplayer 底层封装则作为 TPlayer/XPlayer 关系证据。

## 8. 单路 demo 的边界

### 8.1 vdecoderDemo

本地 `external/libcedarc/demo/vdecoderDemo/vdecoderDemo.c`：

```text
DecDemo Decoder;
Decoder.pVideoDec = CreateVideoDecoder();
pthread_create(parserThreadFunc, &Decoder);
pthread_create(DecodeThread, &Decoder);
pthread_create(displayPictureThreadFunc, &Decoder);
```

虽然有多个线程，但它们共享一个 `Decoder`。因此它证明的是：

```text
单路解码内部 pipeline 多线程
```

不是：

```text
多路解码并发
```

### 8.2 decodertest

TinyVision 的 `decodertest` 同样只创建一个 `VideoDecoder`：

https://github.com/YuzukiHD/TinyVision/blob/main/tina/openwrt/package/allwinner/multimedia/tina_multimedia_demo/decodertest/src/decodertest.c#L178-L216

parser/decode 线程共享同一个 `Decoder`：

https://github.com/YuzukiHD/TinyVision/blob/main/tina/openwrt/package/allwinner/multimedia/tina_multimedia_demo/decodertest/src/decodertest.c#L544-L548

因此它也只能做单路解码 API 验证。

## 9. 结论模型

综合上面的源码，完整模型可以这样画：

```text
                +-----------------------------+
                |          App / Demo          |
                | sample_CodecParallel/tplayer |
                +--------------+--------------+
                               |
                 create N channels / players
                               |
        +----------------------+----------------------+
        |                                             |
        v                                             v
+------------------+                         +------------------+
|   VENC chn i     |                         |   VDEC chn j     |
| AW_MPI_VENC_*    |                         | AW_MPI_VDEC_*    |
+---------+--------+                         +---------+--------+
          |                                            |
          v                                            v
+------------------+                         +------------------+
| VideoEnc_Component|                        | VideoDec_Component|
| queue/thread/buf  |                        | queue/thread/buf  |
+---------+--------+                         +---------+--------+
          |                                            |
          v                                            v
+------------------+                         +------------------+
|  VencContext i   |                         | VideoDecoder j   |
|  encodeOneFrame  |                         | DecodeVideoStream|
+---------+--------+                         +---------+--------+
          |                                            |
          | CdcVeLock / VE_LOCK_VENC                   | VE_LOCK_VDEC
          v                                            v
  +----------------+                            +----------------+
  | VENC hardware  |                            | VDEC hardware  |
  | shared by chns |                            | shared by chns |
  +----------------+                            +----------------+
```

因此建议采用下面的措辞：

```text
全志 SDK/MPP/CedarX 支持多路逻辑编解码通道。
多路通道不是多份独立硬件核心，而是多份软件上下文、队列、buffer 和线程。
同类硬件执行路径通过 cedar-ve 的 VE lock 分时复用。
```

## 10. 如何进一步实测验证

### 10.1 多路编码验证

使用 `sample_CodecParallel`：

1. 使能主 record 和 sub record。
2. 配置 `record_venc_chn = 0`、`record_sub_venc_chn = 1` 对应的输入输出。
3. 观察两个 VENC channel 是否都创建成功。
4. 在 `vencoder.c:421` 前后加日志，打印 `venc_ctx->nChannelId`、时间戳、线程 id。
5. 在 `cedar_ve.c:2052` 和 `cedar_ve.c:2113` 加日志，打印 `current->pid`、`lock_type`、时间戳。

期望看到：

```text
VENC chn0 request VE_LOCK_VENC
VENC chn0 release VE_LOCK_VENC
VENC chn1 request VE_LOCK_VENC
VENC chn1 release VE_LOCK_VENC
...
```

这能直接印证多路 VENC 分时进入硬件。

### 10.2 多路解码验证

优先使用 TinyVision `tplayerdemo` 多文件参数模式：

```sh
tplayerdemo /mnt/UDISK/a.mp4 /mnt/UDISK/b.mp4
tplayerdemo /mnt/UDISK/a.mp4 /mnt/UDISK/b.mp4 /mnt/UDISK/c.mp4 /mnt/UDISK/d.mp4
```

建议：

1. 先使用无音频视频，或只保留一路音频，避免音频 sink 干扰。
2. 从低分辨率开始，例如 4 路 640x360，再到 720p/1080p。
3. 观察是否有多个 `VDecChn%d` 线程。
4. 在 `VideoDec_Component.c:4159` 打印 `mChnId`、`pCedarV`、返回值、时间戳。
5. 在 `cedar_ve.c` 的 `VE_LOCK_VDEC` 获取/释放处打印日志。

期望看到：

```text
VDecChn0 DecodeVideoStream(pCedarV0)
VDecChn1 DecodeVideoStream(pCedarV1)
VDecChn2 DecodeVideoStream(pCedarV2)
VDecChn3 DecodeVideoStream(pCedarV3)

kernel:
  pid A get VE_LOCK_VDEC
  pid A release VE_LOCK_VDEC
  pid B get VE_LOCK_VDEC
  pid B release VE_LOCK_VDEC
```

这能证明多个解码实例交替使用 VDEC 硬件路径。

### 10.3 不要把显示瓶颈误判为解码瓶颈

`tplayerdemo` 多路播放同时测试了：

- 解码能力
- demux 能力
- 内存带宽
- VO/DE layer/scaler 能力
- 音频输出能力
- 应用调度能力

如果目标是纯 VDEC 压测，最好做 decode-only 或者只统计解码帧，不显示；否则四路播放失败可能是显示资源限制，而不一定是 VDEC 不支持多实例。

## 11. 最终判断

这套源码最合理的解释是：

```text
全志多路编解码 = 多个软件逻辑通道 + 多个 component/codec context + buffer 队列管理
               + 进入 VE 硬件时通过 lock 分时复用。
```

`sample_CodecParallel` 证明多路编码和编解码并行路径；`vdecoderDemo` / `decodertest` 只证明单路解码；TinyVision `tplayerdemo` 的 1-4 文件参数模式可以验证多路解码/播放实例并发。

所以“多路同编同解”在这套 SDK 中更应理解为：

```text
上层支持同时创建并驱动多路编解码任务；
底层不是每路一套独立硬件核心；
同类编解码硬件资源通过 VE lock 和队列调度分时复用。
```
