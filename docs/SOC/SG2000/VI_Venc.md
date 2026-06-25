# Linux系统音视频编解码实现分析
_Exported on 2026/6/5 at GMT+8 12:05:22 from Cursor (2.6.21)_

---

**User**

帮我分析一下这颗SOC适配的Linux系统中，音视频以及编解码走的是V4L2还是以字符设备+自定义API实现的？结合具体SDK源码

---

**Cursor**

我会先梳理 SDK 里和视频、音频、编解码相关的驱动、用户态库与示例，再结合源码路径判断它们走的是标准 `V4L2` 还是字符设备加私有 API。

我已经定位到核心目录。接下来用脚本抽取关键符号所在行，避免在大文件中漏掉注册与 ioctl 入口。

部分大文件读取响应很慢，但已经有足够线索指向私有字符设备路径。我再补充读取用户态 `VI/VPSS/VDEC/audio` 这些较小封装文件和头文件，确认整条链路。

结论：**这颗 SoC 的 SDK 主线音视频/编解码不是走标准 V4L2 M2M / V4L2 capture/output 生态，而是 Cvitek 自己的 MPI 用户态库 + 字符设备 + 私有 ioctl/uapi。**  
更细分地说：

- **视频采集/ISP/VI、VPSS、VO、VENC/VDEC**：基本都是 `CVI_*` MPI API，底层通过 `/dev/cvi...`、`/dev/vcodec`、`/dev/cvi_vc_encN`、`/dev/cvi_vc_decN` 等字符设备与私有 `ioctl` 交互。
- **硬件 H.264/H.265/JPEG 编解码**：不是 V4L2 mem2mem codec，而是 Chips&Media/Cvitek VPU 栈，内核模块 `vcodec.ko` + 私有 VDI ioctl + `cvi_vc_enc/dec` 设备。
- **音频 PCM 输入输出**：用户态主要包了一层 `CVI_AUDIO_*`，底层实际用 **tinyalsa/ALSA PCM** 打开声卡设备；但音频算法/共享缓冲/RTOS DSP 相关又有 `cviaudio_core` 这类私有字符设备 ioctl。
- **SDK 里有 Linux V4L2 头文件和通用内核 V4L2 core**，但那是 Linux 5.10 通用源码/Buildroot sysroot 自带，不等于 SoC 的主线媒体框架使用 V4L2。实际 `osdrv/interdrv` 里未看到 SoC 自有 VI/VPSS/VENC/VDEC 走 `video_register_device()` / `v4l2_device_register()` 的证据。

---

## 1. 编解码：明确是字符设备 + 私有 ioctl

### 1.1 内核 VPU 驱动路径

关键目录：

- `osdrv/interdrv/vcodec/`
- `osdrv/interdrv/cvi_vc_drv/vcodec/`

`osdrv/interdrv/vcodec/cvi_vcodec.c` 是 VPU 内核驱动。文件开头就引入字符设备相关头文件，而不是 V4L2/M2M 相关头：

```1:28:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/vcodec/cvi_vcodec.c
/*
 * Copyright (C) Cvitek Co., Ltd. 2019-2021. All rights reserved.
 *
 * File Name: cvi_vcodec.c
 * Description:
 */

#include <linux/kernel.h>
#include <linux/cdev.h>
#include <linux/dma-mapping.h>
#include <linux/delay.h>
#include <linux/of.h>
#include <linux/of_reserved_mem.h>
#include <linux/interrupt.h>
#include <linux/io.h>
#include <linux/ioport.h>
#include <linux/list.h>
#include <linux/mm.h>
#include <linux/module.h>
#include <linux/of_address.h>
#include <linux/of_graph.h>
#include <linux/of_device.h>
#include <linux/platform_device.h>
#include <linux/poll.h>
#include <linux/reset.h>
#include <linux/slab.h>
#include <linux/sched.h>
#include <linux/uaccess.h>
```

里面定义的设备名也是私有字符设备风格：

```39:43:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/vcodec/cvi_vcodec.c
#define VPU_PLATFORM_DEVICE_NAME	"vcodec"
#define VPU_CLK_NAME			"vcodec"
#define VPU_CLASS_NAME			"vcodec"
#define VPU_DEV_NAME			"vcodec"
```

VPU 低层 ioctl 定义在 Chips&Media 风格的 `vcodec.h` 中，magic 是 `'V'`，接口是 `VDI_IOCTL_*`，完全不是 V4L2 的 `VIDIOC_*`：

```16:35:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/cvi_vc_drv/vcodec/vdi/linux/driver/vcodec.h
#define VDI_IOCTL_MAGIC 'V'
#define VDI_IOCTL_ALLOCATE_PHYSICAL_MEMORY _IO(VDI_IOCTL_MAGIC, 0)
#define VDI_IOCTL_FREE_PHYSICALMEMORY _IO(VDI_IOCTL_MAGIC, 1)
#define VDI_IOCTL_WAIT_INTERRUPT _IO(VDI_IOCTL_MAGIC, 2)
#define VDI_IOCTL_SET_CLOCK_GATE _IO(VDI_IOCTL_MAGIC, 3)
#define VDI_IOCTL_RESET _IO(VDI_IOCTL_MAGIC, 4)
#define VDI_IOCTL_GET_INSTANCE_POOL _IO(VDI_IOCTL_MAGIC, 5)
#define VDI_IOCTL_GET_COMMON_MEMORY _IO(VDI_IOCTL_MAGIC, 6)
#define VDI_IOCTL_GET_RESERVED_VIDEO_MEMORY_INFO _IO(VDI_IOCTL_MAGIC, 8)
#define VDI_IOCTL_OPEN_INSTANCE _IO(VDI_IOCTL_MAGIC, 9)
#define VDI_IOCTL_CLOSE_INSTANCE _IO(VDI_IOCTL_MAGIC, 10)
#define VDI_IOCTL_GET_INSTANCE_NUM _IO(VDI_IOCTL_MAGIC, 11)
#define VDI_IOCTL_GET_REGISTER_INFO _IO(VDI_IOCTL_MAGIC, 12)
#define VDI_IOCTL_SET_CLOCK_GATE_EXT _IO(VDI_IOCTL_MAGIC, 13)
#define VDI_IOCTL_GET_CHIP_VERSION _IO(VDI_IOCTL_MAGIC, 14)
#define VDI_IOCTL_GET_CLOCK_FREQUENCY _IO(VDI_IOCTL_MAGIC, 15)
#define VDI_IOCTL_RELEASE_COMMON_MEMORY _IO(VDI_IOCTL_MAGIC, 16)
#define VDI_IOCTL_GET_SINGLE_CORE_CONFIG _IO(VDI_IOCTL_MAGIC, 17)
```

### 1.2 VENC/VDEC 的设备节点和 ioctl

编码/解码对上层暴露的私有设备名定义在：

`osdrv/interdrv/include/chip/cv181x/uapi/linux/cvi_vc_drv_ioctl.h`

```8:12:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/include/chip/cv181x/uapi/linux/cvi_vc_drv_ioctl.h
#define CVI_VC_DRV_ENCODER_DEV_NAME			"cvi_vc_enc"
#define CVI_VC_DRV_DECODER_DEV_NAME			"cvi_vc_dec"

#define CVI_VC_DRV_IOCTL_MAGIC				'V'
```

后面定义了一整套私有 encoder/decoder ioctl：

```13:30:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/include/chip/cv181x/uapi/linux/cvi_vc_drv_ioctl.h
/* encoder ioctl */
#define CVI_VC_VENC_CREATE_CHN				_IO(CVI_VC_DRV_IOCTL_MAGIC, 0)
#define CVI_VC_VENC_DESTROY_CHN				_IO(CVI_VC_DRV_IOCTL_MAGIC, 1)
#define CVI_VC_VENC_RESET_CHN				_IO(CVI_VC_DRV_IOCTL_MAGIC, 2)
#define CVI_VC_VENC_START_RECV_FRAME		_IO(CVI_VC_DRV_IOCTL_MAGIC, 3)
#define CVI_VC_VENC_STOP_RECV_FRAME			_IO(CVI_VC_DRV_IOCTL_MAGIC, 4)
#define CVI_VC_VENC_QUERY_STATUS			_IO(CVI_VC_DRV_IOCTL_MAGIC, 5)
#define CVI_VC_VENC_SET_CHN_ATTR			_IO(CVI_VC_DRV_IOCTL_MAGIC, 6)
#define CVI_VC_VENC_GET_CHN_ATTR			_IO(CVI_VC_DRV_IOCTL_MAGIC, 7)
#define CVI_VC_VENC_GET_STREAM				_IO(CVI_VC_DRV_IOCTL_MAGIC, 8)
#define CVI_VC_VENC_RELEASE_STREAM			_IO(CVI_VC_DRV_IOCTL_MAGIC, 9)
#define CVI_VC_VENC_INSERT_USERDATA			_IO(CVI_VC_DRV_IOCTL_MAGIC, 10)
#define CVI_VC_VENC_SEND_FRAME				_IO(CVI_VC_DRV_IOCTL_MAGIC, 11)
#define CVI_VC_VENC_SEND_FRAMEEX			_IO(CVI_VC_DRV_IOCTL_MAGIC, 12)
#define CVI_VC_VENC_REQUEST_IDR				_IO(CVI_VC_DRV_IOCTL_MAGIC, 13)
```

Decoder 也是同一个私有 ioctl 空间：

```59:76:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/include/chip/cv181x/uapi/linux/cvi_vc_drv_ioctl.h
/* decoder ioctl */
#define CVI_VC_VDEC_CREATE_CHN				_IO(CVI_VC_DRV_IOCTL_MAGIC, 47)
#define CVI_VC_VDEC_DESTROY_CHN				_IO(CVI_VC_DRV_IOCTL_MAGIC, 48)
#define CVI_VC_VDEC_GET_CHN_ATTR			_IO(CVI_VC_DRV_IOCTL_MAGIC, 49)
#define CVI_VC_VDEC_SET_CHN_ATTR			_IO(CVI_VC_DRV_IOCTL_MAGIC, 50)
#define CVI_VC_VDEC_START_RECV_STREAM		_IO(CVI_VC_DRV_IOCTL_MAGIC, 51)
#define CVI_VC_VDEC_STOP_RECV_STREAM		_IO(CVI_VC_DRV_IOCTL_MAGIC, 52)
#define CVI_VC_VDEC_QUERY_STATUS			_IO(CVI_VC_DRV_IOCTL_MAGIC, 53)
#define CVI_VC_VDEC_RESET_CHN				_IO(CVI_VC_DRV_IOCTL_MAGIC, 54)
#define CVI_VC_VDEC_SET_CHN_PARAM			_IO(CVI_VC_DRV_IOCTL_MAGIC, 55)
#define CVI_VC_VDEC_GET_CHN_PARAM			_IO(CVI_VC_DRV_IOCTL_MAGIC, 56)
#define CVI_VC_VDEC_SEND_STREAM				_IO(CVI_VC_DRV_IOCTL_MAGIC, 57)
#define CVI_VC_VDEC_GET_FRAME				_IO(CVI_VC_DRV_IOCTL_MAGIC, 58)
#define CVI_VC_VDEC_RELEASE_FRAME			_IO(CVI_VC_DRV_IOCTL_MAGIC, 59)
```

用户态 `CVI_VENC_*` 直接打开 `/dev/cvi_vc_enc%d` 并 `ioctl`：

```87:104:/home/nopiskl/tmp/duo-buildroot-sdk-v2/cvi_mpi/modules/venc/src/cvi_venc.c
static CVI_S32 openDevice(VENC_CHN VeChn)
{
	if (s32VencFd[VeChn] <= 0) {
		CVI_CHAR devName[255];

		sprintf(devName, "/dev/%s%d", CVI_VC_DRV_ENCODER_DEV_NAME, VeChn);
		s32VencFd[VeChn] = open(devName, O_RDWR | O_DSYNC | O_CLOEXEC);

		if (s32VencFd[VeChn] <= 0) {
			CVI_VENC_ERR("open device (%s) fail\n", devName);
			return CVI_FAILURE;
		}
		CVI_VENC_TRACE("open device (%s) fd: %d\n", devName, s32VencFd[VeChn]);
	}
```

创建编码通道就是私有 ioctl：

```120:128:/home/nopiskl/tmp/duo-buildroot-sdk-v2/cvi_mpi/modules/venc/src/cvi_venc.c
	if (s32VencFd[VeChn] > 0) {
		s32Ret = ioctl(s32VencFd[VeChn], CVI_VC_VENC_CREATE_CHN, pstAttr);
		if (s32Ret != CVI_SUCCESS) {
			CVI_VENC_ERR("ioctl CVI_VC_VENC_CREATE_CHN fail with %d\n", s32Ret);
			return s32Ret;
		}
		u32ChannelCreatedCnt += 1;
	} else {
```

VDEC 同理打开 `/dev/cvi_vc_dec%d`：

```30:45:/home/nopiskl/tmp/duo-buildroot-sdk-v2/cvi_mpi/modules/vdec/src/cvi_vdec.c
	if (s32VdecFd[VdChn] == 0) {
		sprintf(devName, "/dev/%s%d", CVI_VC_DRV_DECODER_DEV_NAME, VdChn);
		s32VdecFd[VdChn] = open(devName, O_RDWR | O_DSYNC | O_CLOEXEC);
		CVI_VDEC_TRACE("open device (%s) fd: %d\n", devName, s32VdecFd[VdChn]);
	}

	if (s32VdecFd[VdChn] > 0) {
		s32Ret = ioctl(s32VdecFd[VdChn], CVI_VC_VDEC_CREATE_CHN, pstAttr);
```

因此编码/解码不是：

- `/dev/videoX`
- `VIDIOC_QUERYCAP`
- `VIDIOC_REQBUFS`
- `VIDIOC_QBUF/DQBUF`
- `V4L2_MEMORY_DMABUF/MMAP`
- `V4L2_PIX_FMT_H264/HEVC` mem2mem

而是：

- `/dev/vcodec`
- `/dev/cvi_vc_encN`
- `/dev/cvi_vc_decN`
- `CVI_VC_*`
- `VDI_IOCTL_*`
- `CVI_VENC_*` / `CVI_VDEC_*` MPI API

---

## 2. VI/VPSS：也是私有 ioctl，不是 V4L2 capture

VI 的用户态封装在：

- `cvi_mpi/modules/vi/src/cvi_vi.c`
- `cvi_mpi/modules/vi/src/vi_ioctl.c`
- `osdrv/interdrv/include/chip/cv181x/uapi/linux/vi_uapi.h`

VI UAPI 定义的 ioctl 是 `VI_IOC_G_CTRL` / `VI_IOC_S_CTRL`，magic 也是私有 `'V'`：

```13:18:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/include/chip/cv181x/uapi/linux/vi_uapi.h
#define VI_IOC_MAGIC		'V'
#define VI_IOC_BASE		0x20

#define VI_IOC_G_CTRL		_IOWR(VI_IOC_MAGIC, VI_IOC_BASE, struct vi_ext_control)
#define VI_IOC_S_CTRL		_IOWR(VI_IOC_MAGIC, VI_IOC_BASE + 1, struct vi_ext_control)
```

VI 的控制项包括 streaming、buffer enqueue、SDK ctrl、取帧/放帧等，但都是私有枚举，不是 V4L2 `VIDIOC_*`：

```48:61:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/include/chip/cv181x/uapi/linux/vi_uapi.h
	VI_IOCTL_GET_BUF_SIZE,          /* Get buffer size */
	VI_IOCTL_SET_DMA_BUF_INFO,      /* Set DMA buffer information */
	VI_IOCTL_ENQ_BUF,               /* Enqueue buffer */
	VI_IOCTL_DQEVENT,               /* Dequeue event */
	VI_IOCTL_START_STREAMING,       /* Start streaming */
	VI_IOCTL_STOP_STREAMING,        /* Stop streaming */
	VI_IOCTL_SET_SLICE_BUF_EN,      /* Enable slice buffer */
	VI_IOCTL_GET_CLUT_TBL_IDX,      /* Get CLUT table index */
	VI_IOCTL_SDK_CTRL,              /* SDK control commands */
	VI_IOCTL_GET_RGBMAP_LE_PHY_BUF, /* Get RGB map left physical buffer */
	VI_IOCTL_GET_RGBMAP_SE_PHY_BUF, /* Get RGB map right physical buffer */
```

用户态 `vi_ioctl.c` 通过 `ioctl(fd, VI_IOC_S_CTRL/G_CTRL, ...)` 控制：

```15:26:/home/nopiskl/tmp/duo-buildroot-sdk-v2/cvi_mpi/modules/vi/src/vi_ioctl.c
#define S_CTRL_VALUE(_fd, _cfg, _ioctl)\
	do {\
		struct vi_ext_control ec1;\
		memset(&ec1, 0, sizeof(ec1));\
		ec1.id = _ioctl;\
		ec1.value = _cfg;\
		if (ioctl(_fd, VI_IOC_S_CTRL, &ec1) < 0) {\
			fprintf(stderr, "VI_IOC_S_CTRL - %s NG, %s\n", __func__, strerror(errno));\
			return -1;\
		} \
		return 0;\
```

VPSS 也是同样路线。`vpss_ioctl.c` 中每个操作都是 `ioctl(fd, CVI_VPSS_*, ...)`：

```7:25:/home/nopiskl/tmp/duo-buildroot-sdk-v2/cvi_mpi/modules/vpss/src/vpss_ioctl.c
CVI_S32 vpss_send_frame(CVI_S32 fd, struct vpss_snd_frm_cfg *cfg)
{
	return ioctl(fd, CVI_VPSS_SEND_FRAME, cfg);
}

CVI_S32 vpss_send_chn_frame(CVI_S32 fd, struct vpss_chn_frm_cfg *cfg)
{
	return ioctl(fd, CVI_VPSS_SEND_CHN_FRAME, cfg);
}

CVI_S32 vpss_release_chn_frame(CVI_S32 fd, const struct vpss_chn_frm_cfg *cfg)
{
	return ioctl(fd, CVI_VPSS_RELEASE_CHN_FRAME, cfg);
}
```

`vpss_uapi.h` 定义的是 Cvitek 自己的结构，例如 `vpss_snd_frm_cfg`、`vpss_chn_frm_cfg`，承载的是 SDK 自己的 `VIDEO_FRAME_INFO_S`，不是 `struct v4l2_buffer`：

```25:37:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/include/chip/cv181x/uapi/linux/vpss_uapi.h
struct vpss_grp_frame_cfg {
	VPSS_GRP VpssGrp;
	VIDEO_FRAME_INFO_S stVideoFrame;
};

struct vpss_snd_frm_cfg {
	__u8 VpssGrp;
	VIDEO_FRAME_INFO_S stVideoFrame;
	__s32 s32MilliSec;
};

struct vpss_chn_frm_cfg {
```

---

## 3. 音频：PCM 是 tinyalsa/ALSA，算法/共享内存是私有字符设备

音频部分要分开看：

### 3.1 PCM 录放音

`cvi_mpi/modules/audio/include/cvi_audio_interface_tinyalsa.h` 明确包含 tinyalsa 头：

```18:24:/home/nopiskl/tmp/duo-buildroot-sdk-v2/cvi_mpi/modules/audio/include/cvi_audio_interface_tinyalsa.h
#include <linux/cvi_type.h>
#include "cvi_audio.h"
#include "cvi_aud_internal_tinyalsa.h"
#include "cvi_transcode_interface.h"
#include "cvi_audio.h"
#include "acodec.h" /* for ioctl control */
#include "asoundlib.h"
```

并定义 ALSA PCM 设备字符串：

```55:60:/home/nopiskl/tmp/duo-buildroot-sdk-v2/cvi_mpi/modules/audio/include/cvi_audio_interface_tinyalsa.h
#define ACODEC_ADC	"/dev/cvitekaadc"
#define ACODEC_DAC	"/dev/cvitekadac"

#define PCM_DEVICE_CARD0 "plughw:0,0"
#define PCM_DEVICE_CARD1 "plughw:1,0"
#define PCM_DEVICE_CARD2 "plughw:2,0"
```

`asoundlib.h` 是 tinyalsa 风格 API，提供 `pcm_open()` / `pcm_close()`：

```132:137:/home/nopiskl/tmp/duo-buildroot-sdk-v2/cvi_mpi/modules/audio/include/asoundlib.h
/* Open and close a stream */
struct pcm *pcm_open(unsigned int card, unsigned int device,
			unsigned int flags, struct pcm_config *config);
int pcm_close(struct pcm *pcm);
int pcm_is_ready(struct pcm *pcm);
```

所以 **音频 PCM 数据面更接近标准 ALSA/tinyalsa**，不是 V4L2，也不是完全私有裸字符设备。

### 3.2 音频 codec 控制和算法

内部 ADC/DAC 控制是 `/dev/cvitekaadc`、`/dev/cvitekadac` 加私有 acodec ioctl：

```55:56:/home/nopiskl/tmp/duo-buildroot-sdk-v2/cvi_mpi/modules/audio/include/cvi_audio_interface_tinyalsa.h
#define ACODEC_ADC	"/dev/cvitekaadc"
#define ACODEC_DAC	"/dev/cvitekadac"
```

`acodec.h` 里定义 `IOC_TYPE_ACODEC 'A'` 以及大量 `ACODEC_*` ioctl：

```8:17:/home/nopiskl/tmp/duo-buildroot-sdk-v2/cvi_mpi/modules/audio/include/acodec.h
#define IOC_TYPE_ACODEC 'A'

typedef enum cviACODEC_FS_E {
	ACODEC_FS_8000  =   0x1,
	ACODEC_FS_11025 =   0x2,
	ACODEC_FS_12000 =   0x3,
	ACODEC_FS_16000 =   0x4,
	ACODEC_FS_22050 =   0x5,
```

例如：

```82:99:/home/nopiskl/tmp/duo-buildroot-sdk-v2/cvi_mpi/modules/audio/include/acodec.h
#define ACODEC_SOFT_RESET_CTRL \
	_IO(IOC_TYPE_ACODEC, IOC_NR_SOFT_RESET_CTRL)
/*ACODEC_FS_E*/
#define ACODEC_SET_I2S1_FS \
	_IOWR(IOC_TYPE_ACODEC, IOC_NR_SET_I2S1_FS, unsigned int)

/*select the micpga's input, micin linein, or differential input(ACODEC_MIXER_E)*/
#define ACODEC_SET_MIXER_MIC \
	_IOWR(IOC_TYPE_ACODEC, IOC_NR_SET_MIXER_MIC, unsigned int)
/*analog part input volume control(left channel 0~0x1f)*/
#define ACODEC_SET_GAIN_MICL \
	_IOWR(IOC_TYPE_ACODEC, IOC_NR_SET_GAIN_MICL, unsigned int)
```

另外 `cviaudio_ioctl_cmd.h` 定义了 `cviaudio_core` 和大量 `CVIAUDIO_*` 私有 ioctl，主要用于共享 buffer、VQE/SSP/RTOS 处理等：

```12:18:/home/nopiskl/tmp/duo-buildroot-sdk-v2/cvi_mpi/sample/audio/include/cviaudio_ioctl_cmd.h
#define CVIAUDIO_DRV_MAX_ALL_NUM  (1)


#define CVIAUDIO_DRV_PLATFORM_DEVICE_NAME	"cvi-audio"
#define CVIAUDIO_DRV_CLASS_NAME			"cvi-audio"
#define CVIAUDIO_CEO_DEV_NAME			"cviaudio_core"
```

```100:119:/home/nopiskl/tmp/duo-buildroot-sdk-v2/cvi_mpi/sample/audio/include/cviaudio_ioctl_cmd.h
#define CVIAUDIO_DRV_IOCTL_MAGIC			'A'
#define CVIAUDIO_CMD_MASK	400

//define for cviaudio_adec_interface  commands
//for share buffer
#define CVIAUDIO_INIT_CHECK				_IO(CVIAUDIO_DRV_IOCTL_MAGIC, (CVIAUDIO_CMD_MASK + 1))
#define CVIAUDIO_DEINIT_CHECK				_IO(CVIAUDIO_DRV_IOCTL_MAGIC, (CVIAUDIO_CMD_MASK + 2))
#define CVIAUDIO_GET_MMAP_SIZE				_IO(CVIAUDIO_DRV_IOCTL_MAGIC, (CVIAUDIO_CMD_MASK + 3))
#define CVIAUDIO_AIN_CHN_BUFFER_ACQUIRE			_IO(CVIAUDIO_DRV_IOCTL_MAGIC, (CVIAUDIO_CMD_MASK + 6))
#define CVIAUDIO_AIN_ALSA_READ_BUFFER_ACQUIRE		_IO(CVIAUDIO_DRV_IOCTL_MAGIC, (CVIAUDIO_CMD_MASK + 7))
#define CVIAUDIO_AIN_SHAREBUFFER_INIT			_IO(CVIAUDIO_DRV_IOCTL_MAGIC, (CVIAUDIO_CMD_MASK + 8))
#define CVIAUDIO_AIN_RESAMPLE_HANDLER_ACQUIRE		_IO(CVIAUDIO_DRV_IOCTL_MAGIC, (CVIAUDIO_CMD_MASK + 9))
#define CVIAUDIO_AIN_RESAMPLE_HANDLER_ATTACH		_IO(CVIAUDIO_DRV_IOCTL_MAGIC, (CVIAUDIO_CMD_MASK + 10))
#define CVIAUDIO_AENC_SHAREBUFFER_INIT			_IO(CVIAUDIO_DRV_IOCTL_MAGIC, (CVIAUDIO_CMD_MASK + 11))
#define CVIAUDIO_AENC_CHN_BUFFER_ACQUIRE		_IO(CVIAUDIO_DRV_IOCTL_MAGIC, (CVIAUDIO_CMD_MASK + 12))
```

所以音频结论是：

- PCM I/O：走 ALSA/tinyalsa；
- Codec 寄存器/ADC/DAC 控制、音频算法/RTOS/VQE/AENC/ADEC 的一部分：走 Cvitek 私有字符设备 ioctl；
- 不涉及 V4L2。

---

## 4. 为什么不是 V4L2？

我在 SDK 中看到的 V4L2 主要来自：

- `linux_5.10/include/media/v4l2-*`
- `linux_5.10/drivers/media/v4l2-core/*`
- 通用 Linux 驱动样例、USB UVC、第三方平台驱动
- `ramdisk/sysroot/.../usr/include/linux/videodev2.h`

这些是 Linux/Buildroot 通用内容。关键是 SoC 自己的媒体驱动路径：

- `osdrv/interdrv/vi`
- `osdrv/interdrv/vpss`
- `osdrv/interdrv/vo`
- `osdrv/interdrv/vcodec`
- `osdrv/interdrv/cvi_vc_drv/vcodec`
- `cvi_mpi/modules/*`

没有呈现标准 V4L2 用户态模式：

- 用户态没有用 `VIDIOC_QUERYCAP`、`VIDIOC_S_FMT`、`VIDIOC_REQBUFS`、`VIDIOC_QBUF/DQBUF` 作为主路径；
- 编解码没有暴露为 V4L2 mem2mem `/dev/videoX`；
- VI/VPSS 数据结构不是 `struct v4l2_buffer`，而是 `VIDEO_FRAME_INFO_S`、`VB_POOL`、`VI_PIPE`、`VPSS_GRP` 等 MPI 私有对象；
- 内核/用户态接口头是 `vi_uapi.h`、`vpss_uapi.h`、`cvi_vc_drv_ioctl.h`、`cviaudio_ioctl_cmd.h` 这种私有 UAPI。

---

## 5. 从应用开发角度应该怎么理解

这个 SDK 的媒体软件栈大致是：

```text
应用
  |
  |  CVI_MPI / CVI_* API
  v
cvi_mpi 用户态库
  |
  | open/ioctl/mmap/select
  v
/dev/cvi_* / /dev/vcodec / /dev/cvi_vc_encN / /dev/cvi_vc_decN / /dev/cviaudio_core
  |
  v
osdrv/interdrv 私有内核驱动
  |
  v
VI/ISP/VPSS/VO/VPU/Audio codec/RTOS DSP 硬件
```

而不是标准 Linux 多媒体栈：

```text
应用 / GStreamer / FFmpeg
  |
  v
/dev/videoX + V4L2 ioctl
  |
  v
V4L2 capture / V4L2 mem2mem / media controller
```

音频 PCM 是例外，它部分接入 ALSA/tinyalsa：

```text
CVI_AUDIO_* 用户态封装
  |
  v
tinyalsa pcm_open("plughw:0,0" 等)
  |
  v
ALSA PCM
```

但音频增强、AEC/VQE、内部 codec 控制又回到私有 ioctl。

---

## 6. 最终判断

| 模块 | 是否 V4L2 | 实际接口 |
|---|---:|---|
| VI / 摄像头采集 / ISP | 否 | `CVI_VI_*` + `VI_IOC_*` 私有 ioctl |
| VPSS / 缩放裁剪旋转 | 否 | `CVI_VPSS_*` + `CVI_VPSS_*` ioctl |
| VENC / H.264/H.265/JPEG 编码 | 否 | `/dev/cvi_vc_encN` + `CVI_VC_VENC_*` |
| VDEC / H.264/H.265 解码 | 否 | `/dev/cvi_vc_decN` + `CVI_VC_VDEC_*` |
| VPU 底层 | 否 | `/dev/vcodec` + `VDI_IOCTL_*` |
| Audio PCM | 不是 V4L2；主要 ALSA | tinyalsa `pcm_open()` |
| Audio codec/VQE/RTOS/AENC/ADEC 辅助 | 否 | `/dev/cvitekaadc`、`/dev/cvitekadac`、`cviaudio_core` + 私有 ioctl |

**一句话概括：视频和硬件编解码走 Cvitek 私有字符设备/API，不走 V4L2；音频 PCM 走 ALSA/tinyalsa，但音频控制和算法部分也大量使用私有字符设备 ioctl。**

