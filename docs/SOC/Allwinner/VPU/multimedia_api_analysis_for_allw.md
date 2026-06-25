# Multimedia API analysis for Allwinner
_Exported on 2026/5/28 at GMT+8 22:17:59 from Cursor (2.6.21)_

---

**User**

platform/allwinner/multimedia
结合这个分析一下
cedarc cedarx
以及tplayer/xplayer/multimedia_demo里面分别用的是什么API

---

**Cursor**

我先梳理 `platform/allwinner/multimedia` 目录结构和相关源码调用关系，再归纳 `cedarc`、`cedarx`、`tplayer/xplayer/multimedia_demo` 分别使用的 API。

目录很大，我会进一步定位各层对外头文件、demo 的 include/链接库和典型调用。

接下来我按 demo 子目录的 Makefile/源码入口统计它们用到的库和头文件，这样可以避免只凭目录名判断。

需要一点精确检索，我用脚本汇总 `multimedia_demo` 每个 demo 的 include、链接库和关键 API 调用。

结合 `platform/allwinner/multimedia` 目录看，这套多媒体栈大致可以分成三层：

```text
应用 / demo
  ├─ tplayerdemo / backplaydemo / tplayercastdemo  -> TPlayer API
  ├─ xplayerdemo                                   -> XPlayer API
  ├─ decodertest / tinycedar                       -> CdxParser + vdecoder API
  ├─ encodertest / vencoderDemo / encoderStress    -> vencoder API
  ├─ trecorderdemo / camerapreviewer / uvcout      -> TRecorder / awrecorder / camera / V4L2
  └─ jpeg / image / metadata demo                  -> jpegdecode / libjpeg/libpng / metadata API

libtmedia
  └─ TPlayer / TRecorder / TMetadataRetriever
       TPlayer 是 Tina 上层封装，内部持有 XPlayer

libcedarx
  ├─ xplayer                    -> 播放器接口
  ├─ libcore/parser             -> CdxParser，封装格式解析
  ├─ libcore/stream             -> CdxStream，文件/http/rtsp/hls 等输入
  ├─ libcore/playback           -> Player，音视频解码播放调度
  └─ libcore/muxer / awrecorder -> 复用、录制相关

cedarc / mpp_libcedarc
  ├─ vdecoder.h -> 硬解接口
  ├─ vencoder.h -> 硬编接口
  ├─ memoryAdapter / VE / videoengine
  └─ libcedarc_v2.0/openmax -> OMX IL 封装，偏 Android/Stagefright
```

## 1. CedarC 和 CedarX 的区别

### CedarC：偏底层 Codec / VE 接口

`cedarc` 主要是视频编解码器层，直接面对硬件 VE、内存适配、码流 buffer、图像帧 buffer。典型 API 在：

- `platform/allwinner/multimedia/libtmedia/mpp_libcedarc/include/vdecoder.h`
- `platform/allwinner/multimedia/libtmedia/mpp_libcedarc/include/vencoder.h`

解码典型流程是：

1. `CreateVideoDecoder()`
2. `InitializeVideoDecoder()`
3. `RequestVideoStreamBuffer()`
4. 填入码流
5. `SubmitVideoStreamData()`
6. `DecodeVideoStream()`
7. `RequestPicture()`
8. 使用 YUV/显示帧
9. `ReturnPicture()`
10. `DestroyVideoDecoder()`

这个流程在 `multimedia_demo/decodertest` 里直接使用。例如：

- `decodertest.c:208` 调 `CreateVideoDecoder()`
- `decodertest.c:244` 调 `InitializeVideoDecoder()`
- `decodertest.c:320` 调 `RequestVideoStreamBuffer()`
- `decodertest.c:368` 调 `SubmitVideoStreamData()`
- `decodertest.c:442` 调 `DecodeVideoStream()`
- `decodertest.c:460` 调 `RequestPicture()`
- `decodertest.c:484` 调 `ReturnPicture()`
- `decodertest.c:584` 调 `DestroyVideoDecoder()`

编码典型流程是：

1. `VideoEncCreate()`
2. `VideoEncInit()`
3. 填 `VencInputBuffer`
4. `VideoEncodeOneFrame()`
5. `GetOneBitstreamFrame()`
6. 写 H264/H265/JPEG 码流
7. `FreeOneBitStreamFrame()`
8. `VideoEncDestroy()`

这个流程在当前打开的 `encodertest.c` 里直接使用：

- `encodertest.c:265` 调 `VideoEncCreate()`
- `encodertest.c:364` 调 `VideoEncInit()`
- `encodertest.c:437` 调 `VideoEncodeOneFrame()`
- `encodertest.c:447` 调 `GetOneBitstreamFrame()`
- `encodertest.c:482` 调 `FreeOneBitStreamFrame()`
- `encodertest.c:505` 调 `VideoEncDestroy()`

所以可以把 CedarC 理解成：**硬件编解码 API 层**。它不负责完整播放器状态机，也不负责容器格式解析和网络流，只处理压缩码流和原始图像帧之间的转换。

### CedarX：偏播放器 / 多媒体框架

`cedarx` 是更上层的多媒体框架，目录在：

- `platform/allwinner/multimedia/libcedarx/`

它包含：

- `xplayer/`：对外播放器接口 `XPlayer`
- `libcore/parser/`：`CdxParser`，解析 mp4/mkv/avi/ts/mp3/aac/hls 等
- `libcore/stream/`：`CdxStream`，文件、http、tcp、rtsp、hls、mms 等输入流
- `libcore/playback/`：`Player`，播放调度、音视频同步、调用解码器
- `libcore/muxer/`：封装/写文件
- `awrecorder/`：录制相关
- `demo/xplayerdemo/`：直接使用 `XPlayer`

`XPlayer` 的对外 API 在：

- `platform/allwinner/multimedia/libcedarx/xplayer/include/xplayer.h`

典型接口包括：

- `XPlayerCreate()`
- `XPlayerSetNotifyCallback()`
- `XPlayerSetDataSourceUrl()`
- `XPlayerPrepare()` / `XPlayerPrepareAsync()`
- `XPlayerStart()`
- `XPlayerPause()`
- `XPlayerStop()`
- `XPlayerSeekTo()`
- `XPlayerReset()`
- `XPlayerDestroy()`
- `XPlayerSetVideoSurfaceTexture()`
- `XPlayerSetAudioSink()`
- `XPlayerGetMediaInfo()`

`xplayerdemo` 就是直接使用这层 API：

- `xplayerdemo.c:520` 调 `XPlayerCreate()`
- `xplayerdemo.c:528` 调 `XPlayerSetNotifyCallback()`
- `xplayerdemo.c:597` 调 `XPlayerSetDataSourceUrl()`
- `xplayerdemo.c:608` 调 `XPlayerPrepareAsync()`
- `xplayerdemo.c:627` 调 `XPlayerStart()`
- `xplayerdemo.c:641` 调 `XPlayerPause()`
- `xplayerdemo.c:656` 调 `XPlayerReset()`
- `xplayerdemo.c:826` 调 `XPlayerDestroy()`

`XPlayer` 内部又创建 `Player`，`Player` 再调用 CedarC 的解码器。可以从调用链看出来：

- `libcedarx/xplayer/xplayer.c:281` 调 `PlayerCreate()`
- `libcedarx/xplayer/xplayer.c:285` 调 `PlayerSetCallback()`
- `libcedarx/xplayer/xplayer.c:1305` 调 `PlayerSetVideoStreamInfo()`
- `libcedarx/xplayer/xplayer.c:2315` 调 `PlayerStart()`
- `libcedarx/xplayer/xplayer.c:3534` 调 `PlayerReset()`

而 `Player` 的视频解码组件里直接调 CedarC：

- `libcedarx/libcore/playback/videoDecComponent.c:130` 调 `CreateVideoDecoder()`
- `videoDecComponent.c:323` 调 `InitializeVideoDecoder()`
- `videoDecComponent.c:371` 调 `RequestVideoStreamBuffer()`
- `videoDecComponent.c:405` 调 `SubmitVideoStreamData()`
- `videoDecComponent.c:866` 调 `DecodeVideoStream()`
- `videoDecComponent.c:444` 调 `RequestPicture()`
- `videoDecComponent.c:466` 调 `ReturnPicture()`

所以播放路径可以理解为：

```text
TPlayer
  -> XPlayer
      -> CdxParser / CdxStream
      -> Player
          -> videoDecComponent
              -> CedarC vdecoder
          -> audioDecComponent
              -> adecoder
          -> videoRender / audioRender
```

## 2. TPlayer 用的是什么 API？

`TPlayer` 在：

- `platform/allwinner/multimedia/libtmedia/tplayer/tplayer.h`
- `platform/allwinner/multimedia/libtmedia/tplayer/tplayer.c`

它是 Tina 平台更友好的播放器封装，接口名字是 `TPlayerXXX`。对 demo 来说，使用的是 `TPlayer API`，不是直接使用 `XPlayer`。

`TPlayer` 结构体里直接包含 `XPlayer* mXPlayer`：

```128:153:platform/allwinner/multimedia/libtmedia/tplayer/tplayer.h
typedef struct TPlayerContext
{
    XPlayer*					mXPlayer;
    TplayerType                 mPlayerType;
    void*						mUserData;
    TPlayerNotifyCallback		mNotifier;
    int				mVolume;
    MediaInfo*			mMediaInfo;
    bool						mMuteFlag;
#ifndef ONLY_ENABLE_AUDIO
    bool						mHideSubFlag;
#endif
#ifndef ONLY_DISABLE_AUDIO
    SoundCtrl*			mSoundCtrl;
#endif
#ifndef ONLY_ENABLE_AUDIO
    LayerCtrl*					mLayerCtrl;
    Deinterlace*				mDeinterlace;
    SubCtrl*					mSubCtrl;
#endif
    bool				mDebugFlag;
    int				bHoldLastPictureFlag;
    DOUBLE_VIDEO_LAYER_ERROR_TYPE     nDoubleVideoLayerType;
}TPlayer;
```

`TPlayer` 对外接口包括：

```160:203:platform/allwinner/multimedia/libtmedia/tplayer/tplayer.h
TPlayer* TPlayerCreate(TplayerType type);

void TPlayerDestroy(TPlayer* p);

int TPlayerSetDebugFlag(TPlayer* p, bool debugFlag);

int TPlayerSetNotifyCallback(TPlayer* p,
                                    TPlayerNotifyCallback notifier,
                                    void* pUserData);

int TPlayerSetDataSource(TPlayer* p, const char* pUrl, const CdxKeyedVectorT* pHeaders);

/* int TPlayerSetDataSourceFd(TPlayer* p, int fd, int64_t nOffset, int64_t nLength);*/

int TPlayerPrepare(TPlayer* p);

int TPlayerPrepareAsync(TPlayer* p);

int TPlayerStart(TPlayer* p);

int TPlayerPause(TPlayer* p);

int TPlayerStop(TPlayer* p);

int TPlayerReset(TPlayer* p);

int TPlayerSeekTo(TPlayer* p, int nSeekTimeMs);

bool TPlayerIsPlaying(TPlayer* p);

int TPlayerGetCurrentPosition(TPlayer* p, int* msec);

int TPlayerGetDuration(TPlayer* p, int* msec);

MediaInfo* TPlayerGetMediaInfo(TPlayer* p);
```

`TPlayer` 内部直接转调 `XPlayer`，例如：

- `tplayer.c:410` 调 `XPlayerCreate()`
- `tplayer.c:527` 调 `XPlayerSetNotifyCallback()`
- `tplayer.c:535` 调 `XPlayerSetDataSourceUrl()`
- `tplayer.c:543` 调 `XPlayerPrepare()`
- `tplayer.c:549` 调 `XPlayerPrepareAsync()`
- `tplayer.c:559` 调 `XPlayerStart()`
- `tplayer.c:565` 调 `XPlayerPause()`
- `tplayer.c:571` 调 `XPlayerStop()`
- `tplayer.c:577` 调 `XPlayerReset()`

所以结论是：

> `TPlayer` 是 `XPlayer` 的 Tina 上层封装。应用 demo 如果 include `<tplayer.h>`，用的是 `TPlayer API`；真正播放能力来自底层 `XPlayer -> Player -> CedarC vdecoder/adecoder`。

## 3. XPlayer 用的是什么 API？

`XPlayer` 在：

- `platform/allwinner/multimedia/libcedarx/xplayer/include/xplayer.h`
- `platform/allwinner/multimedia/libcedarx/xplayer/xplayer.c`

对外是 `XPlayer API`，内部用的是 CedarX `libcore`：

- `CdxParser`：解析媒体容器
- `CdxStream`：输入流
- `Player`：音视频解码和同步调度
- `LayerCtrl`：视频显示控制
- `SoundCtrl`：音频输出控制
- `SubCtrl`：字幕控制
- `Deinterlace`：去隔行

`XPlayer` 的对外接口片段：

```129:188:platform/allwinner/multimedia/libcedarx/xplayer/include/xplayer.h
XPlayer* XPlayerCreate();

void XPlayerDestroy(XPlayer* p);

void XPlayerSetFlag(XPlayer* p, int flag);

int XPlayerConfig(XPlayer* p, const XPlayerConfig_t *config);

int XPlayerSetNotifyCallback(XPlayer* p,
                                    XPlayerNotifyCallback notifier,
                                    void* pUserData);

int XPlayerInitCheck(XPlayer* p);

int XPlayerSetUID(XPlayer* p, int nUid);

//* we must set hdcp ops before setDataSource
int XPlayerSetHdcpOps(XPlayer* p, struct HdcpOpsS* pHdcp);

int XPlayerSetDataSourceUrl(XPlayer* p, const char* pUrl,
                         void* httpService, const CdxKeyedVectorT* pHeaders);

int XPlayerSetDataSourceFd(XPlayer* p, int fd,
                                    int64_t nOffset, int64_t nLength);

// for IStreamSource in android
int XPlayerSetDataSourceStream(XPlayer* p, const char* pStreamUri);
//for DataSoure in android
int XPlayerSetMediaDataSource(XPlayer* p, const char* streamStr);

int XPlayerPrepare(XPlayer* p);

int XPlayerPrepareAsync(XPlayer* p);

int XPlayerStart(XPlayer* p);

int XPlayerStop(XPlayer* p);

int XPlayerPause(XPlayer* p);

int XPlayerIsPlaying(XPlayer* p);

int XPlayerSeekTo(XPlayer* p, int nSeekTimeMs, SeekModeType nSeekModeType);
```

底层 `Player` API 在：

- `platform/allwinner/multimedia/libcedarx/libcore/playback/include/player.h`

`Player` 再进一步配置视频、音频、字幕和输出：

```228:250:platform/allwinner/multimedia/libcedarx/libcore/playback/include/player.h
int PlayerSetVideoStreamInfo(Player* pl, VideoStreamInfo* pStreamInfo);

int PlayerCanSupportVideoStream(Player* pl, VideoStreamInfo* pStreamInfo);

int PlayerHasVideo(Player* pl);

int PlayerConfigVideoScaleDownRatio(Player* pl, int nHorizonRatio, int nVerticalRatio);

int PlayerConfigVideoRotateDegree(Player* pl, int nDegree);

int PlayerConfigVideoDeinterlace(Player* pl, int bOpenDeinterlace);
int PlayerConfigDispErrorFrame(Player* pl, int bDispErrorFrame);
int PlayerConfigDropDelayFrame(Player* pl, int bDropDelayFrame);
int PlayerConfigTvStreamFlag(Player* pl, int bFlag);
```

所以结论是：

> `XPlayer` 是 CedarX 的播放器 API。它比 `TPlayer` 低一层，比 CedarC 高一层；它负责数据源、parser、播放状态机、音视频同步、输出控制，底层解码仍调用 CedarC 的 `vdecoder` / `adecoder`。

## 4. multimedia_demo 里面各 demo 用的 API

我按源码 include 和 Makefile 链接库看，主要可以这样分：

| demo | 使用的主要 API | 链接/依赖特征 |
|---|---|---|
| `tplayerdemo` | `TPlayer API` | `-ltplayer -lcdx_base -lstdc++` |
| `backplaydemo` | `TPlayer API` | `-ltplayer -lcdx_base -lcdx_common` |
| `tplayercastdemo` | `TPlayer + DLNA` | `-ltplayer -law_dlna` |
| `decodertest` | `CdxParser + CedarC vdecoder` | `-lcdx_parser -lcdx_stream -lvdecoder -lMemAdapter` |
| `encodertest` | `CedarC vencoder` | `-lvencoder -lvenc_base -lMemAdapter` |
| `encoderStressTest` | `CedarC vencoder` | `-lvencoder -lMemAdapter` |
| `vencoderDemo` | `CedarC vencoder` | `-lvencoder -lvenc_h264 -lvenc_h265 -lvenc_jpeg` |
| `tinycedar` | 轻量播放，直接用 `vdecoder + cdx_parser + cdx_playback` | 静态链接 `-lvdecoder -lcdx_parser -lcdx_playback -lvideoengine` |
| `jpegdecodedemo` | `jpegdecode API` | `-ljpegdecode` |
| `jpegencodedemo` | 标准 `libjpeg` | `-ljpeg` |
| `imagedecodedemo` | `libjpeg + libpng + gif/bmp 本地库` | `-ljpeg -lpng` |
| `tmetadataretrieverdemo` | `TMetadataRetriever API` | `-ltmetadataretriever` |
| `trecorderdemo` | `TRecorder / awrecorder / vencoder` | `-ltrecorder -lawrecorder -lvencoder -laencoder` |
| `camerapreviewerdemo` | camera preview + recorder/encoder 相关 | `-ltrecorder -lawrecorder -lvencoder -lvdecoder` |
| `moduledemo` | recorder 模块化 demo | `-ltrecorder -lawrecorder -lvencoder -lvdecoder` |
| `uvcout` | V4L2 UVC + camera + awrecorder | `-lawrecorder -lAWIspApi -lisp` |

### tplayerdemo

`multimedia_demo/tplayerdemo/src/tplayerdemo.c` include 的是：

```41:42:platform/allwinner/multimedia/multimedia_demo/tplayerdemo/src/tplayerdemo.c
#include <tplayer.h>
#include "tplayerdemo.h"
```

Makefile 链接的是：

```1:13:platform/allwinner/multimedia/multimedia_demo/tplayerdemo/src/Makefile
Target = tplayerdemo

SourceIncludePath := -I$(STAGING_DIR)/usr/include/allwinner/include -I$(STAGING_DIR)/usr/include/allwinner -I../libcedarc/include
CompileFlags = $(CFLAGS) $(SourceIncludePath)

ifeq ($(ONLY_ENABLE_AUDIO),y)
CompileFlags += -DONLY_ENABLE_AUDIO
endif

ifeq ($(ONLY_DISABLE_AUDIO),y)
CompileFlags += -DONLY_DISABLE_AUDIO
endif

ifeq ($(ENABLE_CEDARC),y)
CompileFlags += -DENABLE_CEDARC
```

```15:17:platform/allwinner/multimedia/multimedia_demo/tplayerdemo/src/Makefile
LoadFlags +=  -ltplayer -lcdx_base -lrt -lstdc++
target_src := tplayerdemo.c
```

所以 `tplayerdemo` 用的是 **TPlayer API**。典型调用有：

- `TPlayerCreate(CEDARX_PLAYER)`
- `TPlayerSetNotifyCallback()`
- `TPlayerSetDataSource()`
- `TPlayerPrepare()` / `TPlayerPrepareAsync()`
- `TPlayerStart()`
- `TPlayerPause()`
- `TPlayerStop()`
- `TPlayerReset()`
- `TPlayerDestroy()`

### xplayerdemo

`xplayerdemo` 不在 `multimedia_demo` 下，而在：

- `platform/allwinner/multimedia/libcedarx/demo/xplayerdemo/`

它 include 的是 `xplayer.h`：

```18:25:platform/allwinner/multimedia/libcedarx/demo/xplayerdemo/xplayerdemo.c
#include "iniparserapi.h"

#include "cdx_config.h"
#include <cdx_log.h>
#include "xplayer.h"
#include "CdxTypes.h"
#include "memoryAdapter.h"
#include "deinterlace.h"
```

Makefile 直接链接 CedarX 内部库和 CedarC 解码库：

```30:41:platform/allwinner/multimedia/libcedarx/demo/xplayerdemo/Makefile.am
xplayerdemo_LDADD = $(top_srcdir)/libcore/parser/base/libcdx_parser.la \
			$(top_srcdir)/libcore/base/libcdx_base.la \
			$(top_srcdir)/libcore/stream/base/libcdx_stream.la \
			$(top_srcdir)/libcore/playback/libcdx_playback.la \
			$(top_srcdir)/xplayer/libxplayer.la \
			$(top_srcdir)/libcore/common/libcdx_common.la \
			$(top_srcdir)/../libcedarc/memory/libMemAdapter.la

LOCAL_LIB = -ldl -lrt -lpthread -lz -lm -lvdecoder -ladecoder -lm -lsubdecoder -lVE \
		-lcrypto -lMemAdapter -lcdc_base -lssl -lvideoengine -lasound
```

所以 `xplayerdemo` 用的是 **XPlayer API**，不是 TPlayer。

### decodertest

`decodertest` 是最典型的“绕过播放器，直接用 parser + vdecoder”的 demo：

```41:45:platform/allwinner/multimedia/multimedia_demo/decodertest/src/decodertest.c
#include <cdx_log.h>
#include "cdx_config.h"
#include "CdxParser.h"
#include "vdecoder.h"
#include "memoryAdapter.h"
```

Makefile：

```1:5:platform/allwinner/multimedia/multimedia_demo/decodertest/src/Makefile
TARGET := decodertest
INCLUDES += -I$(STAGING_DIR)/usr/include/allwinner/include -I$(STAGING_DIR)/usr/include/allwinner
LIBS +=	-lcdx_base -lcdx_common -lcdx_parser -lcdx_stream -lcdx_muxer -lvdecoder \
		-lMemAdapter -lpthread -ldl -lm
```

所以 `decodertest` 用的是：

```text
CdxParser API + CedarC vdecoder API + memoryAdapter
```

也就是说它自己解析容器，然后把视频 elementary stream 喂给硬解。

### encodertest

你当前打开的 `encodertest.c` 用的是 `vencoder.h`：

```38:43:platform/allwinner/multimedia/multimedia_demo/encodertest/src/encodertest.c
#include <cdx_log.h>
#include <stdlib.h>
#include <string.h>
#include "vencoder.h"
#include <sys/time.h>
#include <time.h>
```

Makefile 链接：

```1:8:platform/allwinner/multimedia/multimedia_demo/encodertest/src/Makefile
TARGET := encodertest
INCLUDES += -I$(STAGING_DIR)/usr/include/allwinner/include -I$(STAGING_DIR)/usr/include/allwinner
LIBS +=	-lvencoder -lMemAdapter -lcdc_base -lvenc_base \
		-lpthread -ldl -lm

SRCS = encodertest.c
```

所以 `encodertest` 用的是：

```text
CedarC vencoder API
```

不是 `TPlayer`，也不是 `XPlayer`。

## 5. 总结关系

最核心关系可以记成：

```text
TPlayer：Tina 应用层播放器 API
  使用者：multimedia_demo/tplayerdemo、backplaydemo、tplayercastdemo
  内部：封装 XPlayer

XPlayer：CedarX 播放器 API
  使用者：libcedarx/demo/xplayerdemo
  内部：CdxParser + CdxStream + Player + output ctrl

Player：CedarX playback 内部 API
  使用者：XPlayer 内部
  内部：调 videoDecComponent / audioDecComponent

CedarC vdecoder/vencoder：硬件编解码 API
  使用者：
    decodertest / tinycedar -> vdecoder
    encodertest / vencoderDemo / encoderStressTest -> vencoder
  特点：只管编解码，不管完整播放器状态机

CdxParser/CdxStream：容器解析和输入流 API
  使用者：
    XPlayer 内部
    decodertest 直接使用
```

如果你的目标是写应用：

- 播放普通本地/网络音视频：优先用 `TPlayer`
- 想少一层 Tina 封装，直接控制 CedarX 播放器：用 `XPlayer`
- 只想拿硬解 YUV 帧，不需要完整播放器：用 `CdxParser + vdecoder`
- 只想把 YUV/NV12/NV21 编成 H264/H265/JPEG：用 `vencoder`
- 录制：看 `trecorderdemo` / `awrecorder` / `TRecorder`
- UVC 输出：看 `uvcout`，它走 V4L2/camera/awrecorder 那条链路。

