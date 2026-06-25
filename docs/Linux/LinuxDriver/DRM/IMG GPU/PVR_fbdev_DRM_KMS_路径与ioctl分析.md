# PVR fbdev / DRM KMS 路径与 ioctl 分析

本文基于当前 SDK 中三处源码整理：

- `bsp/modules/gpu/img-bxm`
- `bsp/drivers/video/sunxi`
- `bsp/drivers/drm`

核心问题：

1. 同一套 PVR 框架如何同时保留 fbdev 和 DRM/KMS 两种显示适配路径？
2. 如果走 fbdev 路径、没有 DRM KMS，上层还能使用哪些 DRM ioctl？

## 1. 总体结论

当前 SDK 中的 PVR BXM/Rogue 驱动不是一个简单的显示驱动，而是一套 Imagination PowerVR Services 框架。它把 GPU render、内存管理、同步、用户态 bridge、显示后端分开。

所以所谓“既支持 fbdev 又支持 DRM”，不是同一个显示路径同时操作两套显示框架，而是：

- GPU / Services 核心共用。
- 上层 window system 和 display backend 可切换。
- DRM/KMS 路径下，PVR 主要负责 render、GEM/PRIME/dma-buf、sync、bridge。
- fbdev 路径下，PVR 通过 Display Class/DC bridge 接入 `dc_sunxi`，再由 `dc_sunxi` 操作 Linux fbdev。

当前 `sunxi_linux/Makefile` 默认选择的是 DRM/KMS 相关 window system：

```make
# bsp/modules/gpu/img-bxm/linux/rogue_km/build/linux/sunxi_linux/Makefile
WINDOW_SYSTEM := nulldrmws
PVR_SYSTEM := rgx_sunxi
KERNEL_COMPONENTS := srvkm

#DISPLAY_CONTROLLER := dc_sunxi
#KERNEL_COMPONENTS += $(DISPLAY_CONTROLLER)
```

也就是说，当前默认构建只编 `srvkm`，不编 `dc_sunxi`。`dc_sunxi` 是保留在源码里的旧 fbdev Display Class 后端。

## 2. 构建开关如何决定路径

`WINDOW_SYSTEM := nulldrmws` 会在 PVR 构建系统中选择 KMS/DRM 方向：

```make
# bsp/modules/gpu/img-bxm/linux/rogue_km/build/linux/config/window_system.mk
else ifeq ($(WINDOW_SYSTEM),nulldrmws)
 ifeq ($(MESA_EGL),)
  OPK_DEFAULT  := libpvrNULLDRM_WSEGL.so
  OPK_FALLBACK := libpvrNULLDRM_WSEGL.so
  _supported_gbm_backends := dbm
  GBM_BACKEND ?= dbm
 endif
 SUPPORT_VK_PLATFORMS := null
 SUPPORT_DISPLAY_CLASS := 0
 SUPPORT_NATIVE_FENCE_SYNC := 1
 SUPPORT_KMS := 1
 override PVRSRV_WRAP_EXTMEM_WRITE_ATTRIB_ENABLE := 0
```

关键点：

- `SUPPORT_DISPLAY_CLASS := 0`：不启用 PVR Display Class。
- `SUPPORT_KMS := 1`：窗口系统按 KMS/DRM 方向构建。
- `SUPPORT_NATIVE_FENCE_SYNC := 1`：使用 native fence sync。

如果要走旧 fbdev/DC 路径，需要启用 Display Class，并把 display controller 加进 kernel components。例如历史意图大概是：

```make
WINDOW_SYSTEM := nullws
SUPPORT_DISPLAY_CLASS := 1
DISPLAY_CONTROLLER := dc_sunxi
KERNEL_COMPONENTS += $(DISPLAY_CONTROLLER)
```

当前文件中 `dc_sunxi` 被注释，说明默认产物已经不走这条路。

## 3. DRM/KMS 路径

当前默认路径可以概括为：

```text
PVR userspace
  -> /dev/dri/renderD* 或 PVR DRM 节点
  -> pvrsrvkm.ko
  -> PVR bridge / GPU render / PMR memory / sync
  -> 导出 GEM/PRIME/dma-buf
  -> 用户态 compositor 或 KMS client
  -> /dev/dri/cardX(sunxi-drm)
  -> PRIME fd import / AddFB2 / atomic commit
  -> plane / crtc / connector
  -> DE / TCON / HDMI / DSI / LVDS / eDP
```

PVR 侧注册 DRM 外壳：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_drm.c
static struct drm_ioctl_desc pvr_drm_ioctls[] = {
	DRM_IOCTL_DEF_DRV(PVR_SRVKM_CMD, PVRSRV_BridgeDispatchKM,
			  DRM_RENDER_ALLOW),
	DRM_IOCTL_DEF_DRV(PVR_SRVKM_INIT, drm_pvr_srvkm_init,
			  DRM_RENDER_ALLOW),
	...
};

const struct drm_driver pvr_drm_generic_driver = {
	.driver_features = DRIVER_MODESET | DRIVER_RENDER |
			   DRIVER_GEM | PVR_DRM_DRIVER_PRIME,
	.open = pvr_drm_open,
	.postclose = pvr_drm_release,
	.ioctls = pvr_drm_ioctls,
	.num_ioctls = ARRAY_SIZE(pvr_drm_ioctls),
	.fops = &pvr_drm_fops,
	.name = PVR_DRM_DRIVER_NAME,
};
```

PVR platform probe 中创建并注册 `drm_device`：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_platform_drv.c
static int pvr_probe(struct platform_device *pdev)
{
	struct drm_device *ddev;

	ddev = drm_dev_alloc(&pvr_drm_platform_driver, &pdev->dev);
	ret = pvr_drm_load(ddev, 0);
	ret = drm_dev_register(ddev, 0);
	return 0;
}
```

`pvr_drm_load()` 进入 PVR Services：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_drm.c
dev_set_drvdata(ddev->dev, ddev);
srv_err = PVRSRVCommonDeviceCreate(ddev->dev, deviceId, &priv->dev_node);
err = PVRSRVDeviceInit(priv->dev_node);
drm_mode_config_init(ddev);
```

真正负责显示扫描输出的是 `sunxi-drm`：

```c
// bsp/drivers/drm/sunxi_drm_drv.c
static const struct drm_ioctl_desc sunxi_drm_ioctls[] = {
	DRM_IOCTL_DEF_DRV(SUNXI_PQ_PROC, sunxi_de_pq_ioctl, 0),
};

static struct drm_driver sunxi_drm_driver = {
	.driver_features = DRIVER_MODESET | DRIVER_GEM | DRIVER_ATOMIC,
	.fops = &sunxi_drm_driver_fops,
	.ioctls = sunxi_drm_ioctls,
	.num_ioctls = ARRAY_SIZE(sunxi_drm_ioctls),
	.gem_create_object = sunxi_gem_create_object,
};
```

`sunxi-drm` 初始化 mode config、绑定组件、注册 DRM 设备：

```c
// bsp/drivers/drm/sunxi_drm_drv.c
ret = drmm_mode_config_init(drm);
sunxi_drm_mode_config_init(drm);
sunxi_drm_property_create(private);
ret = component_bind_all(dev, drm);
drm_mode_config_reset(drm);
drm_kms_helper_poll_init(drm);
ret = drm_dev_register(drm, 0);
```

`sunxi-drm` 子驱动覆盖 DE、TCON、DSI、LVDS、RGB、HDMI、eDP：

```c
// bsp/drivers/drm/sunxi_drm_drv.c
static struct platform_driver *sunxi_drm_sub_drivers[] = {
	DRV_PTR(sunxi_tcon_top_platform_driver, CONFIG_AW_DRM_TCON_TOP),
	DRV_PTR(sunxi_de_platform_driver, CONFIG_AW_DRM_DE),
	DRV_PTR(sunxi_dsi_combo_phy_platform_driver, CONFIG_AW_DRM_DSI_COMBOPHY),
	DRV_PTR(sunxi_dsi_platform_driver, CONFIG_AW_DRM_DSI),
	DRV_PTR(sunxi_lvds_platform_driver, CONFIG_AW_DRM_LVDS),
	DRV_PTR(sunxi_rgb_platform_driver, CONFIG_AW_DRM_RGB),
	DRV_PTR(sunxi_hdmi_platform_driver, CONFIG_AW_DRM_HDMI_TX),
	DRV_PTR(sunxi_drm_edp_platform_driver, CONFIG_AW_DRM_EDP),
	DRV_PTR(sunxi_tcon_platform_driver, CONFIG_AW_DRM_TCON),
};
```

## 4. PVR 如何把 render buffer 交给 sunxi-drm

PVR 侧提供 GEM/PRIME/dma-buf 导出能力：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_drm.c
const struct drm_driver pvr_drm_generic_driver = {
	...
#if (LINUX_VERSION_CODE < KERNEL_VERSION(6, 6, 0))
	.prime_handle_to_fd = drm_gem_prime_handle_to_fd,
	/* prime_fd_to_handle is not supported */
#endif

#if (LINUX_VERSION_CODE < KERNEL_VERSION(5, 9, 0))
	.gem_prime_export = PhysmemGEMPrimeExport,
	.gem_free_object = PhysmemGEMObjectFree,
#endif
	...
};
```

新内核中通过 GEM object funcs 导出：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/physmem_dmabuf.c
struct dma_buf *PhysmemGEMPrimeExport(struct drm_gem_object *psObj, int iFlags)
{
	DEFINE_DMA_BUF_EXPORT_INFO(sDmaBufExportInfo);

	sDmaBufExportInfo.priv  = psObj;
	sDmaBufExportInfo.ops   = &sPVRDmaBufOpsGEM;
	sDmaBufExportInfo.size  = PMR_LogicalSize(psPMRWrapper->psPMR);
	sDmaBufExportInfo.flags = iFlags;
	sDmaBufExportInfo.resv  = &psPMRWrapper->sDmaResv;

	psDmaBuf = drm_gem_dmabuf_export(psObj->dev, &sDmaBufExportInfo);
	return psDmaBuf;
}

static const struct drm_gem_object_funcs sPhysmemGEMObjFuncs = {
	.export = PhysmemGEMPrimeExport,
	.free = PhysmemGEMObjectFree,
};
```

因此标准路径是：

1. PVR 渲染到自己的 PMR/GEM buffer。
2. PVR 导出 dma-buf fd。
3. 用户态把 fd 交给 `sunxi-drm`。
4. `sunxi-drm` 通过 DRM core PRIME import 生成 GEM object。
5. 上层对 `sunxi-drm` 调 `ADDFB2` / atomic commit 进行显示。

## 5. fbdev / Display Class 路径

旧 fbdev 路径可以概括为：

```text
PVR userspace nullws/ews
  -> DRM_IOCTL_PVR_SRVKM_CMD
  -> PVR bridge dispatch
  -> DC bridge
  -> dc_server
  -> dc_sunxi.ko
  -> registered_fb[fb_devminor]
  -> fb_set_var / fb_pan_display
  -> bsp/drivers/video/sunxi/disp2
```

`dc_sunxi` 源码实际是 fbdev DC driver：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
#include <linux/fb.h>

#if (LINUX_VERSION_CODE >= KERNEL_VERSION(6, 1, 0))
#error dc_fbdev is not supported for Linux version 6.1.0 or later.
#endif

#if !defined(CONFIG_FB)
#error dc_fbdev needs Linux framebuffer support. Enable it in your kernel.
#endif

#define DRVNAME "dc_fbdev"
```

probe 时直接寻找 Linux fbdev：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
psLINFBInfo = registered_fb[gui32fb_devminor];
if (!psLINFBInfo) {
	err = -EPROBE_DEFER;
	goto err_out;
}
```

然后向 PVR Services 注册 Display Class 设备：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
static DC_DEVICE_FUNCTIONS sDCFunctions = {
	.pfnGetInfo = DC_FBDEV_GetInfo,
	.pfnPanelQueryCount = DC_FBDEV_PanelQueryCount,
	.pfnPanelQuery = DC_FBDEV_PanelQuery,
	.pfnFormatQuery = DC_FBDEV_FormatQuery,
	.pfnDimQuery = DC_FBDEV_DimQuery,
	.pfnContextCreate = DC_FBDEV_ContextCreate,
	.pfnContextDestroy = DC_FBDEV_ContextDestroy,
	.pfnContextConfigure = DC_FBDEV_ContextConfigure,
	.pfnContextConfigureCheck = DC_FBDEV_ContextConfigureCheck,
	.pfnBufferAlloc = DC_FBDEV_BufferAlloc,
	.pfnBufferAcquire = DC_FBDEV_BufferAcquire,
	.pfnBufferRelease = DC_FBDEV_BufferRelease,
	.pfnBufferFree = DC_FBDEV_BufferFree,
};

DCRegisterDevice(&sDCFunctions,
		 MAX_COMMANDS_IN_FLIGHT,
		 gpsDeviceData,
		 &gpsDeviceData->hSrvHandle);
```

`dc_server` 把这个设备挂到 PVR Services 的 DC device list：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/common/dc_server.c
PVRSRV_ERROR DCRegisterDevice(DC_DEVICE_FUNCTIONS *psFuncTable,
                              IMG_UINT32 ui32MaxConfigsInFlight,
                              IMG_HANDLE hDeviceData,
                              IMG_HANDLE *phSrvHandle)
{
	psNew->psDevNode = PVRSRVGetDeviceInstance(g_ui32DCDeviceCount);
	psNew->psFuncTable = psFuncTable;
	psNew->hDeviceData = hDeviceData;
	psNew->ui32Index = g_ui32DCNextIndex++;

	dllist_add_to_tail(&g_sDCDeviceListHead, &psNew->sListNode);
	g_ui32DCDeviceCount++;
	*phSrvHandle = (IMG_HANDLE)psNew;
	return PVRSRV_OK;
}
```

DC bridge 暴露给用户态 PVR 库：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/generated/rogue/dc_bridge/server_dc_bridge.c
SetDispatchTableEntry(PVRSRV_BRIDGE_DC, PVRSRV_BRIDGE_DC_DCDEVICESQUERYCOUNT,
		      PVRSRVBridgeDCDevicesQueryCount, ...);
SetDispatchTableEntry(PVRSRV_BRIDGE_DC, PVRSRV_BRIDGE_DC_DCDEVICEACQUIRE,
		      PVRSRVBridgeDCDeviceAcquire, ...);
SetDispatchTableEntry(PVRSRV_BRIDGE_DC, PVRSRV_BRIDGE_DC_DCDISPLAYCONTEXTCREATE,
		      PVRSRVBridgeDCDisplayContextCreate, ...);
SetDispatchTableEntry(PVRSRV_BRIDGE_DC, PVRSRV_BRIDGE_DC_DCBUFFERALLOC,
		      PVRSRVBridgeDCBufferAlloc, ...);
SetDispatchTableEntry(PVRSRV_BRIDGE_DC, PVRSRV_BRIDGE_DC_DCDISPLAYCONTEXTCONFIGURE2,
		      PVRSRVBridgeDCDisplayContextConfigure2, ...);
```

真正翻屏是 fbdev 操作，不是 KMS：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
if (ui32PipeCount != 0) {
	if (psDeviceData->bCanFlip) {
		DC_FBDEV_BUFFER *psBuffer = ahBuffers[0];
		sVar.yoffset = sVar.yres * psBuffer->ui32BufferID;
	}
}

if (psDeviceData->bCanFlip &&
    sVar.yres_virtual < sVar.yres * NUM_PREFERRED_BUFFERS) {
	sVar.activate = FB_ACTIVATE_NOW;
	sVar.yres_virtual = sVar.yres * NUM_PREFERRED_BUFFERS;
	err = fb_set_var(psDeviceData->psLINFBInfo, &sVar);
} else {
	err = fb_pan_display(psDeviceData->psLINFBInfo, &sVar);
}
```

fbdev buffer 地址也直接来自 fbdev：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
#if defined(DC_FBDEV_USE_SCREEN_BASE)
	uiStartAddr = (uintptr_t)psDeviceData->psLINFBInfo->screen_base;
#else
	uiStartAddr = psDeviceData->psLINFBInfo->fix.smem_start;
#endif

uiStartAddr += psBuffer->ui32BufferID * ui32ByteSize;
pasDevPAddr[i].uiAddr = uiStartAddr + (i * PAGE_SIZE);
```

## 6. bsp/drivers/video/sunxi 的 fbdev/disp 入口

`bsp/drivers/video/sunxi/disp2/disp/fb_core.c` 注册 `/dev/fbX`：

```c
// bsp/drivers/video/sunxi/disp2/disp/fb_core.c
static struct fb_ops dispfb_ops = {
	.owner = THIS_MODULE,
	.fb_open = sunxi_fb_open,
	.fb_release = sunxi_fb_release,
	.fb_pan_display = sunxi_fb_pan_display,
	.fb_compat_ioctl = sunxi_fb_ioctl,
	.fb_ioctl = sunxi_fb_ioctl,
	.fb_check_var = sunxi_fb_check_var,
	.fb_set_par = sunxi_fb_set_par,
	.fb_blank = sunxi_fb_blank,
	.fb_mmap = sunxi_fb_mmap,
	.fb_setcolreg = sunxi_fb_setcolreg,
};

register_framebuffer(info);
```

fbdev ioctl 支持：

```c
// bsp/drivers/video/sunxi/disp2/disp/fb_core.c
#define FBIOPAN_DISPLAY_SUNXI 0x4650
#define FBIOGET_DMABUF _IOR('F', 0x21, struct fb_dmabuf_export)

static int sunxi_fb_ioctl(struct fb_info *info, unsigned int cmd,
			  unsigned long arg)
{
	switch (cmd) {
	case FBIOPAN_DISPLAY_SUNXI:
		ret = sunxi_fb_pan_display(&var, info);
		break;
	case FBIO_WAITFORVSYNC:
		ret = sunxi_fb_wait_for_vsync(info);
		break;
	case FBIOGET_DMABUF:
		...
		break;
	default:
		ret = -EINVAL;
		break;
	}
	return ret;
}
```

`/dev/disp` 走 Allwinner 私有 `DISP_*` ioctl，不是 DRM ioctl：

```c
// bsp/drivers/video/sunxi/disp2/disp/dev_disp.c
static long disp_ioctl(struct file *file, unsigned int cmd, unsigned long arg)
{
	unsigned long arg64[4] = {0};

	if (copy_from_user((void *)arg64, (void __user *)arg,
			   4 * sizeof(unsigned long)))
		return -EFAULT;

	return disp_ioctl_inner(file, cmd, (unsigned long)arg64);
}

static const struct file_operations disp_fops = {
	.open = disp_open,
	.release = disp_release,
	.unlocked_ioctl = disp_ioctl,
	.compat_ioctl = disp_compat_ioctl,
	.mmap = disp_mmap,
	.poll = disp_vsync_poll,
};
```

## 7. 没有 DRM KMS 时，上层能使用什么 DRM ioctl？

如果系统走纯 fbdev/Display Class 路径，没有 DRM KMS display driver，那么上层不能依赖 DRM KMS ioctl 完成显示。

不能作为显示路径依赖的典型 ioctl：

```text
DRM_IOCTL_MODE_GETRESOURCES
DRM_IOCTL_MODE_GETCONNECTOR
DRM_IOCTL_MODE_GETCRTC
DRM_IOCTL_MODE_CREATE_DUMB
DRM_IOCTL_MODE_ADDFB / DRM_IOCTL_MODE_ADDFB2
DRM_IOCTL_MODE_SETCRTC
DRM_IOCTL_MODE_PAGE_FLIP
DRM_IOCTL_MODE_ATOMIC
```

原因是这些需要真正的 KMS `drm_driver`，即需要 `DRIVER_MODESET` 对应的 CRTC、plane、connector、encoder、framebuffer 等对象。fbdev 路径下显示对象在 `/dev/fbX` 和 `/dev/disp`，不是 DRM KMS object。

但是 PVR 自己的 DRM private ioctl 仍然可以使用，因为 PVR 的 Services 入口仍然挂在 DRM 外壳上。

PVR 暴露的主要 DRM ioctl：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/include/drm/pvr_drm.h
#define DRM_PVR_SRVKM_CMD 0
#define DRM_PVR_SYNC_RENAME_CMD 1
#define DRM_PVR_SYNC_FORCE_SW_ONLY_CMD 2
#define DRM_PVR_SW_SYNC_CREATE_FENCE_CMD 3
#define DRM_PVR_SW_SYNC_INC_CMD 4
#define DRM_PVR_SRVKM_INIT 5
#define DRM_PVR_EXP_FENCE_SYNC_FORCE_CMD 6
#define DRM_PVR_SYNC_CREATE_EXPORT_FENCE_CMD 7

#define DRM_IOCTL_PVR_SRVKM_CMD \
	DRM_IOWR(DRM_COMMAND_BASE + DRM_PVR_SRVKM_CMD, \
		 struct drm_pvr_srvkm_cmd)
```

`DRM_IOCTL_PVR_SRVKM_CMD` 是一个通用 bridge 分发入口：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/include/drm/pvr_drm.h
struct drm_pvr_srvkm_cmd {
	__u32 bridge_id;
	__u32 bridge_func_id;
	__u64 in_data_ptr;
	__u64 out_data_ptr;
	__u32 in_data_size;
	__u32 out_data_size;
};
```

内核中转发到 PVR bridge：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_bridge_k.c
int PVRSRV_BridgeDispatchKM(struct drm_device *dev, void *arg,
			    struct drm_file *pDRMFile)
{
	struct drm_pvr_srvkm_cmd *psSrvkmCmd = arg;
	PVRSRV_BRIDGE_PACKAGE sBridgePackageKM = { 0 };

	sBridgePackageKM.ui32BridgeID = psSrvkmCmd->bridge_id;
	sBridgePackageKM.ui32FunctionID = psSrvkmCmd->bridge_func_id;
	sBridgePackageKM.pvParamIn =
		(void __user *)(uintptr_t)psSrvkmCmd->in_data_ptr;
	sBridgePackageKM.pvParamOut =
		(void __user *)(uintptr_t)psSrvkmCmd->out_data_ptr;

	error = BridgedDispatchKM(psConnection, &sBridgePackageKM);
	return OSPVRSRVToNativeError(error);
}
```

如果启用 `SUPPORT_DISPLAY_CLASS=1`，显示相关 bridge 是 `PVRSRV_BRIDGE_DC`：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/include/pvr_bridge.h
#define PVRSRV_BRIDGE_DC 12UL
```

DC bridge function id：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/generated/rogue/dc_bridge/common_dc_bridge.h
#define PVRSRV_BRIDGE_DC_DCDEVICESQUERYCOUNT 0
#define PVRSRV_BRIDGE_DC_DCDEVICESENUMERATE 1
#define PVRSRV_BRIDGE_DC_DCDEVICEACQUIRE 2
#define PVRSRV_BRIDGE_DC_DCDEVICERELEASE 3
#define PVRSRV_BRIDGE_DC_DCGETINFO 4
#define PVRSRV_BRIDGE_DC_DCPANELQUERYCOUNT 5
#define PVRSRV_BRIDGE_DC_DCPANELQUERY 6
#define PVRSRV_BRIDGE_DC_DCFORMATQUERY 7
#define PVRSRV_BRIDGE_DC_DCDIMQUERY 8
#define PVRSRV_BRIDGE_DC_DCBUFFERALLOC 17
#define PVRSRV_BRIDGE_DC_DCBUFFERIMPORT 18
#define PVRSRV_BRIDGE_DC_DCDISPLAYCONTEXTCONFIGURE2 25
```

所以在 fbdev 路径下，“上层能使用的 DRM ioctl”主要是：

- `DRM_IOCTL_PVR_SRVKM_INIT`
- `DRM_IOCTL_PVR_SRVKM_CMD`
- PVR sync/fence 相关 private ioctl
- DRM core 的基础 open/close/poll/mmap 路径
- 可能的 GEM/PRIME handle-to-fd/export 路径，取决于 PVR buffer 类型和内核版本

但它不能用 DRM KMS ioctl 来控制显示。显示控制应通过：

- PVR Display Class bridge，由 PVR 用户态库间接使用。
- `/dev/fbX` 的 fbdev ioctl，例如 `FBIOPAN_DISPLAY_SUNXI`、`FBIO_WAITFORVSYNC`、`FBIOGET_DMABUF`。
- `/dev/disp` 的 Allwinner `DISP_*` 私有 ioctl。

## 8. 一句话总结

PVR 这套框架支持两条路：

- **DRM/KMS 路**：PVR 负责 render 和 buffer export，`sunxi-drm` 负责 KMS 显示。
- **fbdev/DC 路**：PVR 通过 Display Class 调 `dc_sunxi`，`dc_sunxi` 再调 Linux fbdev。

没有 DRM KMS 时，上层仍可打开 PVR DRM 节点并使用 PVR private ioctl/bridge，但不能使用标准 DRM KMS ioctl 完成显示；显示必须走 PVR DC bridge 或 fbdev/disp ioctl。
