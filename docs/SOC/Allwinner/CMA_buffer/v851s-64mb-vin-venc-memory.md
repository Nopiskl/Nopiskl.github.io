# V851S 64MB DDR 下 VIN/VO/VENC 内存压缩分析

本文基于当前 SDK 中 `v851s/lizard/openwrt` 构建和以下源码路径分析：

- `platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi2vo`
- `platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi2venc`
- `platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_OnlineVenc`
- `kernel/linux-4.9/drivers/media/platform/sunxi-vin`
- `kernel/linux-4.9/drivers/media/cedar-ve`

核心结论：

- 1080P 本身并不省内存，普通 NV21/NV12 1080P 一帧约 3 MiB。
- SDK 把内存压下来，主要靠减少帧队列深度、MPP bind 传递 buffer 引用、避免用户态大拷贝、online/LBC 降低输入帧池，以及 IOMMU/Ion 降低大块连续物理内存压力。
- `sample_virvi2vo` 的源码无配置文件默认是 1080P 采集，但仓库里的 `sample_virvi2vo.conf` 不是 1080P，而是小分辨率预览配置。
- `sample_virvi2venc.conf` 默认是 1080P 采集 + 1080P H.265 编码，但默认 `online_en = 0`、`src_pixfmt = "nv21"`，不是最省内存的 online + LBC 模式。

## 1. 基础内存量级

1080P NV21/NV12 按 VIN 常见高度对齐到 1088 粗算：

```text
1920 * 1088 * 1.5 = 3,133,440 bytes ~= 2.99 MiB
```

因此：

```text
8 buffers ~= 24 MiB
5 buffers ~= 15 MiB
3 buffers ~= 9 MiB
2 buffers ~= 6 MiB
```

对 64 MiB SIP DDR 来说，差别非常大。真正决定能不能跑的是队列深度和是否重复保存原始帧。

## 2. VIN 驱动如何决定每帧大小和 buffer 个数

VIN V4L2 队列使用 `queue_setup()` 计算每个 buffer 的 payload，并决定实际 buffer 数。

源码片段：

```c
// kernel/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
static int queue_setup(struct vb2_queue *vq,
		       unsigned int *nbuffers, unsigned int *nplanes,
		       unsigned int sizes[], struct device *alloc_devs[])
{
	...
	size = roundup(cap->frame.o_width, VIN_ALIGN_WIDTH) *
	       roundup(cap->frame.o_height, VIN_ALIGN_HEIGHT);
	...
	default:
		cap->frame.payload[0] = size * cap->frame.fmt.depth[0] / 8;
		break;
	}
	cap->frame.payload[1] = size * cap->frame.fmt.depth[1] / 8;
	cap->frame.payload[2] = size * cap->frame.fmt.depth[2] / 8;
	cap->buf_byte_size =
		PAGE_ALIGN(cap->frame.payload[0]) +
		PAGE_ALIGN(cap->frame.payload[1]) +
		PAGE_ALIGN(cap->frame.payload[2]);

	if (*nbuffers == 0)
		*nbuffers = 8;
	...
}
```

默认情况下，如果用户态没有指定 buffer 数，VIN 会使用 8 个 buffer。

源码片段：

```c
// kernel/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
if (*nbuffers == 0)
	*nbuffers = 8;
```

但在非拍照模式下，驱动也会限制最小 buffer 数；普通视频至少 3 个，VE online 可压到 1 或 2 个。

源码片段：

```c
// kernel/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
if (cap->vinc->ve_online_cfg.dma_buf_num == BK_TWO_BUFFER &&
    cap->vinc->id == CSI_VE_ONLINE_VIDEO && *nbuffers != 2) {
	*nbuffers = 2;
	vin_print("video%d:buffer count is invalid, set to 2\n", cap->vinc->id);
} else if (cap->vinc->ve_online_cfg.dma_buf_num == BK_ONE_BUFFER &&
	   cap->vinc->id == CSI_VE_ONLINE_VIDEO && *nbuffers != 1) {
	*nbuffers = 1;
	vin_print("video%d:buffer count is invalid, set to 1\n", cap->vinc->id);
} else {
	if (*nbuffers < 3) {
		*nbuffers = 3;
		vin_err("buffer count is invalid, set to 3\n");
	}
}
```

这就是 VIN 侧最基础的省内存机制：应用或 MPP 明确传 `nbufs`，避免落入 8-buffer 默认值。

## 3. `sample_virvi2vo`：1080P VIN 采集 + VO 显示为什么能压下来

### 3.1 默认配置需要区分源码默认和 conf 默认

`sample_virvi2vo.c` 在没有传配置文件时，源码默认是 1080P 采集、640x360 显示。

源码片段：

```c
// platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi2vo/sample_virvi2vo.c
pConfig->mVIPP2VOConfigArray[0].mVippDev = 0;
pConfig->mVIPP2VOConfigArray[0].mCaptureWidth = 1920;
pConfig->mVIPP2VOConfigArray[0].mCaptureHeight = 1080;
pConfig->mVIPP2VOConfigArray[0].mDisplayX = 0;
pConfig->mVIPP2VOConfigArray[0].mDisplayY = 0;
pConfig->mVIPP2VOConfigArray[0].mDisplayWidth = 640;
pConfig->mVIPP2VOConfigArray[0].mDisplayHeight = 360;
pConfig->mPicFormat = MM_PIXEL_FORMAT_YVU_SEMIPLANAR_420;
pConfig->mFrameRate = 60;
```

但当前仓库的 `sample_virvi2vo.conf` 是小分辨率预览，不是 1080P：

```ini
# platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi2vo/sample_virvi2vo.conf
capture_width = 360
capture_height = 640
display_width = 320
display_height = 240
pic_format = nv21
frame_rate = 20
```

因此分析 1080P 时，应以源码默认值或手动改 conf 到 1080P 为前提。

### 3.2 VI 队列固定为 5 个 MMAP buffer

`sample_virvi2vo` 创建 VIPP 后设置 `VI_ATTR_S`，使用 `V4L2_MEMORY_MMAP`，并把 `nbufs` 写死为 5。

源码片段：

```c
// platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi2vo/sample_virvi2vo.c
stAttr.type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
stAttr.memtype = V4L2_MEMORY_MMAP;
stAttr.format.pixelformat = map_PIXEL_FORMAT_E_to_V4L2_PIX_FMT(pContext->mConfigPara.mPicFormat);
stAttr.format.field = V4L2_FIELD_NONE;
stAttr.format.colorspace = V4L2_COLORSPACE_JPEG;
stAttr.format.width = pConfig->mCaptureWidth;
stAttr.format.height =pConfig->mCaptureHeight;
stAttr.nbufs = 5;//5;
stAttr.nplanes = 2;
stAttr.drop_frame_num = 0;
stAttr.mbEncppEnable = TRUE;
stAttr.fps = pContext->mConfigPara.mFrameRate;
eRet = AW_MPI_VI_SetVippAttr(pLinkInfo->mVIDev, &stAttr);
```

以 1080P NV21 估算：

```text
5 * 3 MiB ~= 15 MiB
```

如果不设置 `nbufs`，走 VIN 默认 8 个，则约 24 MiB。`virvi2vo` 通过固定 5 个 buffer，直接少约 9 MiB。

### 3.3 VO 不是应用层 memcpy 到 framebuffer

`sample_virvi2vo` 不是手工 `DQBUF -> memcpy -> /dev/fb0`。它创建 VI 和 VO 后通过 MPP 绑定。

源码片段：

```c
// platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi2vo/sample_virvi2vo.c
AW_MPI_VO_SetChnDispBufNum(pLinkInfo->mVoLayer, pLinkInfo->mVOChn, 2);

MPP_CHN_S VOChn = {MOD_ID_VOU, pLinkInfo->mVoLayer, pLinkInfo->mVOChn};
MPP_CHN_S VIChn = {MOD_ID_VIU, pLinkInfo->mVIDev, pLinkInfo->mVIChn};
AW_MPI_SYS_Bind(&VIChn, &VOChn);

eRet = AW_MPI_VI_EnableVirChn(pLinkInfo->mVIDev, pLinkInfo->mVIChn);
AW_MPI_VO_StartChn(pLinkInfo->mVoLayer, pLinkInfo->mVOChn);
```

这个模式的意义：

- VI buffer 由 MPP/VO 直接消费或引用。
- 用户态不再额外申请一套 1080P RGB/YUV 缓冲。
- 不需要把 1080P 原始帧整帧复制到 framebuffer。
- VO 自身显示队列设置为 2，显示端不会无限堆积。

### 3.4 显示尺寸通常小于采集尺寸

源码默认是 1080P 采集，但显示窗口是 640x360。板级 LCD 是 480x800：

```dts
// device/config/chips/v851s/configs/lizard/board.dts
lcd_x               = <480>;
lcd_y               = <800>;
```

因此屏显侧的 framebuffer/显示缓存不是 1080P 级别。真正的大头仍然是 VIN 的 5 个 NV21 采集 buffer。

`sample_virvi2vo` 的 1080P 模式大致内存结构：

```text
VIN raw frame pool: 5 * 1080P NV21 ~= 15 MiB
VO display queue:   2 buffers / references, display resolution smaller
extra app copy:     no 1080P app copy pool
```

## 4. `sample_virvi2venc`：1080P VIN + Cedar 编码为什么能压下来

### 4.1 conf 默认是 1080P + H.265，但 VIN buffer 只有 3 个

`sample_virvi2venc.conf` 默认：

```ini
# platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi2venc/sample_virvi2venc.conf
online_en = 0
online_share_buf_num = 2
src_width  = 1920
src_height = 1080
vi_buffer_num = 3
src_pixfmt = "nv21"
video_framerate = 20
video_bitrate = 1572864
video_width  = 1920
video_height = 1080
video_encoder = "H.265"
```

重点是 `vi_buffer_num = 3`。它把 VIN 输入帧池控制在：

```text
3 * 1080P NV21 ~= 9 MiB
```

### 4.2 sample 明确把 `vi_buffer_num` 下传到 VI

解析配置：

```c
// platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi2venc/sample_virvi2venc.c
pContext->mConfigPara.mVideoFrameRate = GetConfParaInt(&mConf, CFG_DST_VIDEO_FRAMERATE, 0);
pContext->mConfigPara.mViBufferNum = GetConfParaInt(&mConf, CFG_DST_VI_BUFFER_NUM, 0);
pContext->mConfigPara.mVideoBitRate = GetConfParaInt(&mConf, CFG_DST_VIDEO_BITRATE, 0);
```

设置 VI 属性：

```c
// platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi2venc/sample_virvi2venc.c
pContext->mViAttr.type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
pContext->mViAttr.memtype = V4L2_MEMORY_MMAP;
pContext->mViAttr.format.pixelformat = map_PIXEL_FORMAT_E_to_V4L2_PIX_FMT(pContext->mConfigPara.srcPixFmt);
pContext->mViAttr.format.width = pContext->mConfigPara.srcWidth;
pContext->mViAttr.format.height = pContext->mConfigPara.srcHeight;
pContext->mViAttr.nbufs =  pContext->mConfigPara.mViBufferNum;
pContext->mViAttr.nplanes = 2;
pContext->mViAttr.fps = pContext->mConfigPara.mVideoFrameRate;
```

MPP VI 层继续把 `VI_ATTR_S.nbufs` 转成底层 video fmt，并最终由 V4L2 `REQBUFS` 申请。

源码片段：

```c
// platform/allwinner/eyesee-mpp/middleware/sun8iw21/media/videoIn/videoInputHw.c
vfmt.nbufs = pVipp->mstAttr.nbufs;
vfmt.nplanes = pVipp->mstAttr.nplanes;
vfmt.fps = pVipp->mstAttr.fps;
...
if (video_set_fmt(video, &vfmt) < 0) {
	...
}
```

```c
// out/v851s/lizard/openwrt/build_dir/target/libAWIspApi/src/libisp/isp_dev/video.c
video->nbufs = vfmt->nbufs;
...
rb.count = pool->nbufs;
rb.type = video->type;
rb.memory = video->memtype;

ret = ioctl(video->entity->fd, VIDIOC_REQBUFS, &rb);
```

这条链路证明：`vi_buffer_num = 3` 不是注释值，而是会进入底层 V4L2 buffer 申请路径。

### 4.3 VI 和 VENC 通过 MPP bind 传递，不做应用层二次帧池

`sample_virvi2venc` 创建 VI 和 VENC 后绑定：

```c
// platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi2venc/sample_virvi2venc.c
MPP_CHN_S ViChn = {MOD_ID_VIU, pContext->mViDev, pContext->mViChn};
MPP_CHN_S VeChn = {MOD_ID_VENC, 0, pContext->mVeChn};

AW_MPI_SYS_Bind(&ViChn, &VeChn);
```

启动时：

```c
// platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi2venc/sample_virvi2venc.c
ret = AW_MPI_VI_EnableVirChn(pContext->mViDev, pContext->mViChn);
...
AW_MPI_VENC_StartRecvPic(pContext->mVeChn);
```

这个 bind 很关键：VENC 输入不是应用自己 malloc 一组 1080P 输入 buffer 再 memcpy。MPP 将 VI frame/buffer 引用交给 VENC，避免 `VI 3 帧 + app 3 帧 + VENC input 3 帧` 这种灾难性重复。

### 4.4 Cedar 的内部内存通过 IOMMU/Ion system heap 分配

当前 kernel 打开了 `CONFIG_SUNXI_IOMMU`，Cedar memory helper 在这种情况下选择 Ion system heap，而不是 carveout。

源码片段：

```c
// kernel/linux-4.9/drivers/media/cedar-ve/codec/memory/ion_mem/ion_mem.c
#if defined(CONFIG_SUNXI_IOMMU)
	heap_mask = 1 << ION_HEAP_TYPE_SYSTEM;
	align     = PAGE_SIZE;
#else
	heap_mask = 1 << ION_HEAP_TYPE_CARVEOUT;
	align     = PAGE_SIZE;
#endif

node->handle = ion_alloc(client, size, align, heap_mask, flags);
```

Cedar 驱动通过 dma-buf attach/map 得到 IOMMU 地址：

```c
// kernel/linux-4.9/drivers/media/cedar-ve/cedar_ve.c
pVeIommuBuf->fd      = sUserIommuParam.fd;
pVeIommuBuf->dma_buf = dma_buf_get(pVeIommuBuf->fd);
...
pVeIommuBuf->attachment = dma_buf_attach(pVeIommuBuf->dma_buf,
					 cedar_devp->platform_dev);
...
ret = dma_map_sg(cedar_devp->platform_dev, pVeIommuBuf->sgt->sgl,
		 pVeIommuBuf->sgt->nents,
		 DMA_BIDIRECTIONAL);
...
pVeIommuBuf->iommu_addr = sg_dma_address(pVeIommuBuf->sgt->sgl);
```

这解决的是大块连续物理内存压力。也就是说：

- 容量压缩：靠 `vi_buffer_num=3`、bind、低码率/VBV。
- 连续性压力：靠 IOMMU + Ion system heap。

### 4.5 码流/VBV 缓存不是 1080P raw frame 量级

默认码率是 1.5 Mbps：

```ini
# platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi2venc/sample_virvi2venc.conf
video_bitrate = 1572864
```

`sample_virvi2venc.conf` 里 VBV 默认交给 middleware 决定：

```ini
# platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi2venc/sample_virvi2venc.conf
vbvBufferSize = 0 #0:middleware decide itself, >0:app decide.
vbvThreshSize = 0 #0:middleware decide itself, >0:app decide.
```

代码把这些值传给 VENC：

```c
// platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_virvi2venc/sample_virvi2venc.c
if (PT_H265 == pContext->mVencChnAttr.VeAttr.Type)
{
	pContext->mVencChnAttr.VeAttr.AttrH265e.mBufSize = pContext->mConfigPara.mVbvBufferSize;
	pContext->mVencChnAttr.VeAttr.AttrH265e.mThreshSize = pContext->mConfigPara.mVbvThreshSize;
	pContext->mVencChnAttr.VeAttr.AttrH265e.mbByFrame = TRUE;
	pContext->mVencChnAttr.VeAttr.AttrH265e.mPicWidth = pContext->mConfigPara.dstWidth;
	pContext->mVencChnAttr.VeAttr.AttrH265e.mPicHeight = pContext->mConfigPara.dstHeight;
	...
}
```

码流缓冲和编码内部参考帧仍然会占内存，但它不是再复制一套 `3 * 1080P NV21` 的输入帧池。

`sample_virvi2venc` 的默认 1080P H.265 模式大致结构：

```text
VIN raw frame pool: 3 * 1080P NV21 ~= 9 MiB
VI -> VENC:         MPP bind, frame/buffer reference path
Cedar internal:     Ion system heap + IOMMU mapping
bitstream/VBV:      low bitrate, middleware-sized buffer
```

## 5. 更省内存的编码路径：online + LBC

`sample_virvi2venc.conf` 默认不是最省内存，因为：

```ini
online_en = 0
src_pixfmt = "nv21"
```

更省内存的是 `sample_OnlineVenc` 这种配置：

```ini
# platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_OnlineVenc/sample_OnlineVenc.conf
main_src_width = 1920
main_src_height = 1080
main_pixel_format = "aw_lbc_2_0x"
main_vi_buf_num = 3
main_src_frame_rate = 20
main_online_en = 1
main_online_share_buf_num = 2
```

sample 里同时给 VI 和 VENC 设置 online：

```c
// platform/allwinner/eyesee-mpp/middleware/sun8iw21/sample/sample_OnlineVenc/sample_OnlineVenc.c
if (pContext->mConfigPara.mMainOnlineEnable)
{
	pContext->mMainStream.mViAttr.mOnlineEnable = 1;
	pContext->mMainStream.mViAttr.mOnlineShareBufNum = pContext->mConfigPara.mMainOnlineShareBufNum;
	pContext->mMainStream.mVEncChnAttr.VeAttr.mOnlineEnable = 1;
	pContext->mMainStream.mVEncChnAttr.VeAttr.mOnlineShareBufNum = pContext->mConfigPara.mMainOnlineShareBufNum;
}
```

LBC 在 VIN 驱动中改变每帧 payload 计算方式，不再按普通 NV21 的 1.5 byte/pixel 算。

源码片段：

```c
// kernel/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
case V4L2_PIX_FMT_LBC_2_0X:
case V4L2_PIX_FMT_LBC_2_5X:
case V4L2_PIX_FMT_LBC_1_0X:
case V4L2_PIX_FMT_LBC_1_5X:
	lbc_mode_select(&cap->lbc_cmp, cap->frame.fmt.fourcc);
	wth = roundup(cap->frame.o_width, 32);
	if (cap->lbc_cmp.is_lossy) {
		cap->lbc_cmp.line_tar_bits[0] =
			roundup(cap->lbc_cmp.cmp_ratio_even * wth * cap->lbc_cmp.bit_depth/1000, 512);
		cap->lbc_cmp.line_tar_bits[1] =
			roundup(cap->lbc_cmp.cmp_ratio_odd * wth * cap->lbc_cmp.bit_depth/500, 512);
	}
	/* add 1KB buffer to fix ve-lbc error */
	cap->frame.payload[0] =
		(cap->lbc_cmp.line_tar_bits[0] + cap->lbc_cmp.line_tar_bits[1]) *
		cap->frame.o_height/2/8 + 1024;
	break;
```

`LBC_2_0X` 的压缩参数：

```c
// kernel/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
case V4L2_PIX_FMT_LBC_2_0X: /* 2x */
	lbc_cmp->is_lossy = 1;
	lbc_cmp->bit_depth = 8;
	lbc_cmp->cmp_ratio_even = 600;
	lbc_cmp->cmp_ratio_odd  = 450;
	break;
```

按驱动公式粗算 1920x1080 `aw_lbc_2_0x`：

```text
line0 ~= roundup(600 * 1920 * 8 / 1000, 512) = 9216 bits
line1 ~= roundup(450 * 1920 * 8 / 500, 512)  = 13824 bits
payload ~= (9216 + 13824) * 1080 / 2 / 8 + 1024
        ~= 1.48 MiB
```

所以输入侧可以从：

```text
NV21 3 buffers ~= 9 MiB
```

进一步压到：

```text
LBC_2_0X 2 shared buffers ~= 3 MiB
```

这才是 64 MiB 下最舒服的编码形态。

## 6. 当前 SDK 中 online 下传需要特别确认

MPP 的 `videoInputHw.c` 会把 `VI_ATTR_S.mOnlineEnable` 和 `mOnlineShareBufNum` 放到 `video_fmt`：

```c
// platform/allwinner/eyesee-mpp/middleware/sun8iw21/media/videoIn/videoInputHw.c
vfmt.ve_online_en = pVipp->mstAttr.mOnlineEnable;
if (pVipp->mstAttr.mOnlineEnable) {
	if ((BK_TWO_BUFFER < pVipp->mstAttr.mOnlineShareBufNum) ||
	    (BK_MUL_BUFFER >= pVipp->mstAttr.mOnlineShareBufNum)) {
		vfmt.dma_buf_num = BK_ONE_BUFFER;
	} else {
		vfmt.dma_buf_num = pVipp->mstAttr.mOnlineShareBufNum;
	}
} else {
	vfmt.dma_buf_num = BK_MUL_BUFFER;
}
```

但当前构建目录里的 `libAWIspApi` 中，真正调用 `VIDIOC_SET_VE_ONLINE` 的代码块被 `#if 0` 包住：

```c
// out/v851s/lizard/openwrt/build_dir/target/libAWIspApi/src/libisp/isp_dev/video.c
#if 0
	struct csi_ve_online_cfg ve_online_cfg;
	// only vipp0 support online
	if (0 == video->id)
	{
		memset(&ve_online_cfg, 0, sizeof ve_online_cfg);
		ve_online_cfg.ve_online_en = vfmt->ve_online_en;
		ve_online_cfg.dma_buf_num  = vfmt->dma_buf_num;
		/* must set after VIDIOC_S_INPUT and before VIDIOC_S_PARM */
		if (-1 == ioctl(video->entity->fd, VIDIOC_SET_VE_ONLINE, &ve_online_cfg)) {
			ISP_ERR("video fd[%d] VIDIOC_SET_VE_ONLINE error\n", video->entity->fd);
			return -1;
		}
	}
#endif
```

同时 `video_set_fmt()` 里保存 online 状态的字段也被注释：

```c
// out/v851s/lizard/openwrt/build_dir/target/libAWIspApi/src/libisp/isp_dev/video.c
video->nbufs = vfmt->nbufs;
video->fps = vfmt->fps;
//	video->ve_online_en = vfmt->ve_online_en;
//	video->dma_buf_num = vfmt->dma_buf_num;
```

因此：

- `nbufs` 下传和 `VIDIOC_REQBUFS` 路径是明确成立的。
- `sample_virvi2venc` 默认 `online_en = 0`，不受这个问题影响。
- 如果要依赖 online 2-buffer 作为 64 MiB 的核心方案，需要确认实际产品分支是否打开了这段 ioctl，或是否存在另一条下传 online 的路径。

## 7. 为什么 20 MiB NPU 推理 + `camerademo_self` OpenCV/fb0 仍然能跑

原因不是这条链路很省，而是它和 1080P MPP/VENC 不是同一个内存量级。

`camerademo_self` 里请求的是 480x480 摄像头输入，不是 1080P：

```c
// openwrt/package/lizard/camerademo_self/src/main.cpp
const int frame_width = 480;
const int frame_height = 480;
const int frame_rate = 30;
...
cap.open(0);
...
cap.set(cv::CAP_PROP_FRAME_WIDTH, frame_width);
cap.set(cv::CAP_PROP_FRAME_HEIGHT, frame_height);
cap.set(cv::CAP_PROP_FPS, frame_rate);
```

它显示前还 resize 到 240x240：

```c
// openwrt/package/lizard/camerademo_self/src/main.cpp
#define DISPLAY_X 240
#define DISPLAY_Y 240
...
cap >> frame;
...
cv::transpose(frame, frame);
cv::flip(frame, frame, 0);
cv::resize(frame, frame, cv::Size(DISPLAY_X, DISPLAY_Y));
```

写 framebuffer 时，会转换成 16bpp 或 32bpp 的小图：

```c
// openwrt/package/lizard/camerademo_self/src/main.cpp
cv::Mat framebuffer_compat;

switch (framebuffer_depth) {
case 16:
	cv::cvtColor(frame, framebuffer_compat, cv::COLOR_BGR2BGR565);
	for (int y = 0; y < frame_size.height; y++) {
		ofs.seekp(y * framebuffer_width * 2);
		ofs.write(reinterpret_cast<char*>(framebuffer_compat.ptr(y)), frame_size.width * 2);
	}
	break;

case 32:
	cv::cvtColor(frame, framebuffer_compat, cv::COLOR_BGR2RGBA);
	for (int y = 0; y < frame_size.height; y++) {
		ofs.seekp(y * framebuffer_width * 4);
		ofs.write(reinterpret_cast<char*>(framebuffer_compat.ptr(y)), frame_size.width * 4);
	}
	break;
}
```

按 BGR 3 通道估算：

```text
480 * 480 * 3 ~= 0.66 MiB
240 * 240 * 3 ~= 0.16 MiB
240 * 240 * 2 ~= 0.11 MiB  // BGR565
240 * 240 * 4 ~= 0.22 MiB  // RGBA
```

即使 OpenCV 内部 V4L2 还持有几个 480x480 buffer，总量也远小于 1080P MPP：

```text
480x480 BGR 4 buffers ~= 2.6 MiB
1080P NV21 3 buffers  ~= 9 MiB
1080P NV21 5 buffers  ~= 15 MiB
```

因此，20 MiB NPU 推理内存 + `camerademo_self` 能跑，并不能证明 20 MiB NPU + 1080P VIN/VENC 也稳。它只能证明当前这条 OpenCV demo 使用的小分辨率路径还有余量。

如果你的 NPU 程序类似 `yolov8` 包，它会通过 VIPlite 初始化一块 NPU 内存池：

```c
// openwrt/package/lizard/yolov8/src/NeuralNetworkRuntime.cpp
vip_status_e status = vip_init(config.memSize);
```

并创建输入/输出 buffer：

```c
// openwrt/package/lizard/yolov8/src/NeuralNetworkRuntime.cpp
status = vip_create_buffer(&bufferCreateParams, sizeof(bufferCreateParams), &inputBuffer);
...
status = vip_create_buffer(&bufferCreateParams, sizeof(bufferCreateParams), &outputBuffer);
```

推理时只是把输入/输出 buffer 交给 NPU：

```c
// openwrt/package/lizard/yolov8/src/NeuralNetworkRuntime.cpp
status = vip_set_input(network, i, inputBuffers[i]);
...
status = vip_set_output(network, i, outputBuffers[i]);
...
status = vip_run_network(network);
```

也就是说，NPU 的 20 MiB 和 OpenCV 的 480x480 小图缓存可以同时存在，只要系统当时还有足够可用 DDR。但它们会压缩后续 1080P 开流的余量。

如果换成 1080P OpenCV 路径，中间再 `clone()`、检测标注、`resize()`、`cvtColor()`，内存会明显上升。尤其 `yolov8` 里有 `frame.clone()`：

```c
// openwrt/package/lizard/yolov8/src/main.cpp
auto inputFrame = frame.clone();
yoloV8Processor.preProcess(inputFrame);
```

多线程 pipeline 里也会把 Mat 放进队列：

```c
// openwrt/package/lizard/yolov8/src/VideoObjectDetectionPipeline.cpp
ThreadSafeQueue<cv::Mat> preprocessQueue;
ThreadSafeQueue<cv::Mat> inferenceQueue;
...
preprocessQueue.push(frame.clone());
```

这种写法在 480x480 下通常还能接受；在 1080P 下，每多一份 BGR Mat 就约 6 MiB，压力会快速放大。

## 8. 两条路径的对比

| 路径 | 默认/典型输入 | VIN buffer | 是否 bind | 是否 LBC | 是否 online | 主要省内存点 |
| --- | --- | ---: | --- | --- | --- | --- |
| `sample_virvi2vo` 源码默认 | 1920x1080 NV21 采集，640x360 显示 | 5 | VI->VO | 否 | 否 | 限制 5 buffer，VO 绑定消费，避免应用层复制 |
| `sample_virvi2vo.conf` 当前配置 | 360x640 NV21 采集 | 5 | VI->VO | 否 | 否 | 分辨率本身很小 |
| `sample_virvi2venc.conf` 默认 | 1920x1080 NV21 + H.265 | 3 | VI->VENC | 否 | 否 | 限制 3 buffer，编码器绑定输入，低码率/VBV |
| `sample_OnlineVenc` | 1920x1080 LBC + H.265 | 3 配置，online 共享 2 | VI->VENC | 是 | 是 | LBC 单帧约减半，online 共享 buffer |
| `camerademo_self` | 480x480 OpenCV，240x240 fb0 | OpenCV/V4L2 内部 | 否 | 否 | 否 | 分辨率小，显示前缩到 240x240 |

## 9. 总结

以 1080P 采集为例，64 MiB 下能跑的关键不是“CMA 很大”，而是避免最坏内存形态。

最坏形态：

```text
VIN 默认 8 帧
+ 应用层复制一套 1080P
+ VO/VENC 各自再排队
+ 无 IOMMU 要求大块连续物理内存
```

SDK 里的省内存形态：

```text
VIN nbufs = 5 或 3
+ MPP AW_MPI_SYS_Bind 传递 buffer 引用
+ VO 显示尺寸小于采集尺寸
+ Cedar 通过 IOMMU/Ion system heap 获取硬件地址
+ 低码率减少 bitstream/VBV 压力
+ 更优路径使用 online + LBC，把输入侧压到 2 个共享压缩 buffer
```

所以：

- `virvi2vo` 主要靠 `5 buffer + VI->VO bind + 小显示窗口`。
- `virvi2venc` 主要靠 `3 buffer + VI->VENC bind + Cedar IOMMU/Ion + 低码率`。
- 真正面向极限 64 MiB 的编码形态，应优先验证 `online + LBC` 是否在产品分支中完整下传到 VIN 驱动。
- `camerademo_self` 能和 20 MiB NPU 同跑，主要因为它是 480x480 输入、240x240 显示的小分辨率 OpenCV/fb0 路径，不能直接外推到 1080P VENC。
