# PVR dc_sunxi 渲染与送显流程源码分析

本文基于 SDK 根目录下已有三份文档继续整理：

- `DRM_PVR_dc_sunxi_整理说明.md`
- `IMG_PVR_GPU_DRM_对话总结.md`
- `PVR_fbdev_DRM_KMS_路径与ioctl分析.md`

涉及源码目录：

- DISP/fbdev 驱动：`bsp/drivers/video/sunxi`
- DRM/KMS 驱动：`bsp/drivers/drm`
- IMG PVR/BXM GPU 驱动：`bsp/modules/gpu/img-bxm`

## 1. 总体结论

`dc_sunxi` 适配体系下，渲染和送显不是标准 DRM/KMS plane scanout 流程，而是 PVR Display Class 到 Linux fbdev/Allwinner disp2 的桥接流程。

核心链路是：

```text
App / EGL / GLES
  -> IMG PVR 用户态库
  -> /dev/dri/cardX 或 /dev/dri/renderD*
  -> DRM_IOCTL_PVR_SRVKM_CMD
  -> PVRSRV_BridgeDispatchKM()
  -> PVR bridge
  -> RGX render / TA3D / TQ
  -> PVR Display Class bridge
  -> dc_sunxi(dc_fbdev)
  -> registered_fb[0]
  -> fb_pan_display() / fb_set_var()
  -> sunxi fbdev
  -> disp2 manager/layer config
  -> DE / TCON / LCD/HDMI/DSI
```

也就是说：

```text
GPU 负责画，dc_sunxi 负责把 fbdev 显存包装给 PVR 使用，最终翻页由 fbdev/disp2 完成。
```

但当前 A733 BXM 默认构建不是这条历史 `dc_sunxi` 路径，而是 `nulldrmws`：

```make
# bsp/modules/gpu/img-bxm/linux/rogue_km/build/linux/sunxi_linux/Makefile
WINDOW_SYSTEM := nulldrmws
PVR_SYSTEM := rgx_sunxi
KERNEL_COMPONENTS := srvkm

#DISPLAY_CONTROLLER := dc_sunxi
#KERNEL_COMPONENTS += $(DISPLAY_CONTROLLER)
```

`nulldrmws` 在窗口系统配置中明确关闭 Display Class、打开 KMS：

```make
# bsp/modules/gpu/img-bxm/linux/rogue_km/build/linux/config/window_system.mk
else ifeq ($(WINDOW_SYSTEM),nulldrmws)
 SUPPORT_VK_PLATFORMS := null
 SUPPORT_DISPLAY_CLASS := 0
 SUPPORT_NATIVE_FENCE_SYNC := 1
 SUPPORT_KMS := 1
 override PVRSRV_WRAP_EXTMEM_WRITE_ATTRIB_ENABLE := 0
```

所以本文分析的是 `dc_sunxi` 适配体系的实际设计和代码路径，同时会对比当前默认 `PVR render + sunxi-drm KMS scanout` 路径。

## 2. PVR DRM 入口只负责 GPU/Services 接入

PVR 内核模块通过 DRM 框架注册设备节点，用户态通过 DRM private ioctl 进入 PVR Services。

平台驱动 probe 创建并注册 `drm_device`：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_platform_drv.c
static int pvr_probe(struct platform_device *pdev)
{
	struct drm_device *ddev;
	int ret;

	ddev = drm_dev_alloc(&pvr_drm_platform_driver, &pdev->dev);
	if (IS_ERR(ddev))
		return PTR_ERR(ddev);

	ret = pvr_drm_load(ddev, 0);
	if (ret)
		goto err_drm_dev_put;

	ret = drm_dev_register(ddev, 0);
	if (ret)
		goto err_drm_dev_unload;
```

模块初始化时复制 PVR DRM driver 模板并注册 platform driver：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_platform_drv.c
static int __init pvr_init(void)
{
	int err;

	pvr_drm_platform_driver = pvr_drm_generic_driver;

	err = PVRSRVDriverInit();
	if (err)
		return err;

	err = platform_driver_register(&pvr_platform_driver);
	if (err)
		return err;

	return pvr_devices_register();
}

late_initcall(pvr_init);
```

`pvr_drm_load()` 创建 PVR Services 设备节点并初始化 RGX：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_drm.c
int pvr_drm_load(struct drm_device *ddev, unsigned long flags)
{
	struct pvr_drm_private *priv;
	enum PVRSRV_ERROR_TAG srv_err;
	int err, deviceId;

	dev_set_drvdata(ddev->dev, ddev);

	if (ddev->render)
		deviceId = ddev->render->index;
	else
		deviceId = ddev->primary->index;

	priv = kzalloc(sizeof(*priv), GFP_KERNEL);
	ddev->dev_private = priv;

	srv_err = PVRSRVCommonDeviceCreate(ddev->dev, deviceId, &priv->dev_node);
	if (srv_err != PVRSRV_OK) {
		...
	}

	err = PVRSRVDeviceInit(priv->dev_node);
	if (err) {
		...
	}

	drm_mode_config_init(ddev);
```

PVR 的 DRM driver 声明了 render/GEM/PRIME/private ioctl 能力：

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

这里的 `DRIVER_MODESET` 不能单独证明 PVR 自己接管了实际显示 scanout。`pvr_drm.c` 只看到 `drm_mode_config_init(ddev)`，没有创建 Allwinner DRM 里的 plane/crtc/encoder/connector，也没有 atomic commit 到 DE 的路径。

## 3. PVR private ioctl 如何进入 bridge

用户态 PVR 库通过 `DRM_IOCTL_PVR_SRVKM_CMD` 传入 bridge id、function id、输入输出参数地址。

UAPI 定义：

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

#define DRM_PVR_SRVKM_CMD 0

#define DRM_IOCTL_PVR_SRVKM_CMD \
	DRM_IOWR(DRM_COMMAND_BASE + DRM_PVR_SRVKM_CMD, \
		 struct drm_pvr_srvkm_cmd)
```

内核分发入口：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_bridge_k.c
int PVRSRV_BridgeDispatchKM(struct drm_device *dev,
			    void *arg,
			    struct drm_file *pDRMFile)
{
	struct drm_pvr_srvkm_cmd *psSrvkmCmd = arg;
	PVRSRV_BRIDGE_PACKAGE sBridgePackageKM = { 0 };
	CONNECTION_DATA *psConnection = LinuxServicesConnectionFromFile(pDRMFile->filp);
	PVRSRV_ERROR error;

	sBridgePackageKM.ui32BridgeID = psSrvkmCmd->bridge_id;
	sBridgePackageKM.ui32FunctionID = psSrvkmCmd->bridge_func_id;
	sBridgePackageKM.ui32Size = sizeof(sBridgePackageKM);
	sBridgePackageKM.pvParamIn =
		(void __user *)(uintptr_t)psSrvkmCmd->in_data_ptr;
	sBridgePackageKM.ui32InBufferSize = psSrvkmCmd->in_data_size;
	sBridgePackageKM.pvParamOut =
		(void __user *)(uintptr_t)psSrvkmCmd->out_data_ptr;
	sBridgePackageKM.ui32OutBufferSize = psSrvkmCmd->out_data_size;

	error = BridgedDispatchKM(psConnection, &sBridgePackageKM);

	return OSPVRSRVToNativeError(error);
}
```

因此用户态所有 PVR Services 操作本质上都可以理解为：

```text
ioctl(DRM_IOCTL_PVR_SRVKM_CMD)
  -> bridge_id
  -> bridge_func_id
  -> generated server bridge
  -> services/server/*
```

## 4. GPU 渲染提交路径

渲染相关 bridge 由自动生成代码注册，典型 3D kick 是 `RGXKickTA3D2`：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/generated/rogue/rgxta3d_bridge/server_rgxta3d_bridge.c
SetDispatchTableEntry(PVRSRV_BRIDGE_RGXTA3D,
		      PVRSRV_BRIDGE_RGXTA3D_RGXKICKTA3D2,
		      PVRSRVBridgeRGXKickTA3D2,
		      NULL,
		      sizeof(PVRSRV_BRIDGE_IN_RGXKICKTA3D2),
		      sizeof(PVRSRV_BRIDGE_OUT_RGXKICKTA3D2));
```

bridge 内查找 render context、sync PMR 等 handle 后，进入 RGX server：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/generated/rogue/rgxta3d_bridge/server_rgxta3d_bridge.c
psRGXKickTA3D2OUT->eError =
	PVRSRVRGXKickTA3DKM(psRenderContextInt,
			    psRGXKickTA3D2IN->ui32ClientTAFenceCount,
			    psClientTAFenceSyncPrimBlockInt,
			    ui32ClientTAFenceSyncOffsetInt,
			    ui32ClientTAFenceValueInt,
			    psRGXKickTA3D2IN->ui32ClientTAUpdateCount,
			    psClientTAUpdateSyncPrimBlockInt,
			    ui32ClientTAUpdateSyncOffsetInt,
			    ui32ClientTAUpdateValueInt,
			    ...);
```

GPU 硬件资源来自 Sunxi 系统适配层：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/system/rogue/rgx_sunxi/sysconfig.c
PVRSRV_ERROR SysDevInit(void *pvOSDevice, PVRSRV_DEVICE_CONFIG **ppsDevConfig)
{
	struct sunxi_platform *sunxi_data;
	struct device *dev = (struct device *)pvOSDevice;

	if (sunxi_platform_init(dev)) {
		pr_err(LOG_TAG " sunxi_platform_init failed\n");
		return PVRSRV_ERROR_INIT_FAILURE;
	}
	sunxi_data = (struct sunxi_platform *)dev->platform_data;

	psRGXTimingInfo->ui32CoreClockSpeed = clk_get_rate(sunxi_data->clk_core);

	psDevConfig->pvOSDevice = pvOSDevice;
	psDevConfig->pszName = "sunxi";

	psDevConfig->sRegsCpuPBase.uiAddr = sunxi_data->reg_base;
	psDevConfig->ui32RegsSize = sunxi_data->reg_size;
	psDevConfig->ui32IRQ = sunxi_data->irq_num;

	psDevConfig->pfnPrePowerState = sunxiPrePowerState;
	psDevConfig->pfnPostPowerState = sunxiPostPowerState;
	psDevConfig->pfnClockFreqGet = sunxi_get_device_clk_rate;
```

这一段只负责 GPU 初始化、寄存器、IRQ、clock、reset、DVFS，不负责显示扫描输出。

## 5. dc_sunxi 是 PVR Display Class 到 fbdev 的桥

`dc_sunxi.c` 实际驱动名是 `dc_fbdev`，强依赖 Linux fbdev：

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
#define MAX_COMMANDS_IN_FLIGHT 2
```

核心设备数据直接保存 `struct fb_info *`：

```c
typedef struct
{
	IMG_HANDLE hSrvHandle;
	IMG_UINT32 ePixFormat;
	struct fb_info *psLINFBInfo;
	bool bCanFlip;
} DC_FBDEV_DEVICE;
```

probe 时直接从 `registered_fb[]` 找 fbdev：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
psLINFBInfo = registered_fb[gui32fb_devminor];
if (!psLINFBInfo)
{
	pr_err("No Linux framebuffer (/dev/fbdev%u) device is registered!\n"
	       "Deferring device probe.\n",
	       gui32fb_devminor);
	err = -EPROBE_DEFER;
	goto err_out;
}
```

注册给 PVR Display Class 的函数表：

```c
static DC_DEVICE_FUNCTIONS sDCFunctions =
{
	.pfnGetInfo = DC_FBDEV_GetInfo,
	.pfnPanelQueryCount = DC_FBDEV_PanelQueryCount,
	.pfnPanelQuery = DC_FBDEV_PanelQuery,
	.pfnFormatQuery = DC_FBDEV_FormatQuery,
	.pfnDimQuery = DC_FBDEV_DimQuery,
	.pfnSetBlank = NULL,
	.pfnSetVSyncReporting = NULL,
	.pfnLastVSyncQuery = NULL,
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

所以 `dc_sunxi` 不是 DRM plane driver，它向 PVR Services 注册的是 Display Class 设备。

## 6. dc_sunxi 如何把 fbdev 显存包装成 GPU 可渲染 buffer

Display Class buffer 分配时只分配一个 `DC_FBDEV_BUFFER`，并记录 buffer id：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
PVRSRV_ERROR DC_FBDEV_BufferAlloc(IMG_HANDLE hDisplayContext,
				  DC_BUFFER_CREATE_INFO *psCreateInfo,
				  IMG_DEVMEM_LOG2ALIGN_T *puiLog2PageSize,
				  IMG_UINT32 *pui32PageCount,
				  IMG_UINT32 *pui32ByteStride,
				  IMG_HANDLE *phBuffer)
{
	DC_FBDEV_BUFFER *psBuffer;

	psBuffer->ui32ByteStride =
		psSurfInfo->sDims.ui32Width * psCreateInfo->ui32BPP;
	psBuffer->ui32Width = psSurfInfo->sDims.ui32Width;
	psBuffer->ui32Height = psSurfInfo->sDims.ui32Height;

	if (!DC_FBDEV_GetBufferID(psDeviceContext, &psBuffer->ui32BufferID)) {
		eError = PVRSRV_ERROR_OUT_OF_MEMORY;
		goto err_free;
	}

	ui32ByteSize = psBuffer->ui32ByteStride * psBuffer->ui32Height;

	*puiLog2PageSize = PAGE_SHIFT;
	*pui32PageCount = BYTE_TO_PAGES(ui32ByteSize);
	*pui32ByteStride = psBuffer->ui32ByteStride;
	*phBuffer = psBuffer;
```

真正给 GPU 的物理页来自 fbdev 显存：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
PVRSRV_ERROR DC_FBDEV_BufferAcquire(IMG_HANDLE hBuffer,
				    IMG_DEV_PHYADDR *pasDevPAddr,
				    void **ppvLinAddr)
{
	DC_FBDEV_BUFFER *psBuffer = hBuffer;
	DC_FBDEV_DEVICE *psDeviceData = psBuffer->psDeviceContext->psDeviceData;
	IMG_UINT32 ui32ByteSize = psBuffer->ui32ByteStride * psBuffer->ui32Height;
	uintptr_t uiStartAddr;

	uiStartAddr = psDeviceData->psLINFBInfo->fix.smem_start;
	uiStartAddr += psBuffer->ui32BufferID * ui32ByteSize;

	for (i = 0; i < BYTE_TO_PAGES(ui32ByteSize); i++)
	{
		pasDevPAddr[i].uiAddr = uiStartAddr + (i * PAGE_SIZE);
	}

	*ppvLinAddr = NULL;

	return PVRSRV_OK;
}
```

PVR `dc_server` 再把 Display Class buffer 包成 PMR：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/common/dc_server.c
static PVRSRV_ERROR _DCCreatePMR(IMG_DEVMEM_LOG2ALIGN_T uiLog2PageSize,
				 IMG_UINT32 ui32PageCount,
				 PHYS_HEAP *psPhysHeap,
				 DC_BUFFER *psBuffer,
				 PMR **ppsPMR,
				 IMG_BOOL bSystemBuffer,
				 const IMG_CHAR *pszAnnotation)
{
	...
	eError = PMRCreatePMR(psPhysHeap,
			      uiBufferSize,
			      1,
			      1,
			      &uiMappingTable,
			      uiLog2PageSize,
			      PVRSRV_MEMALLOCFLAG_GPU_READABLE |
			      PVRSRV_MEMALLOCFLAG_GPU_WRITEABLE |
			      PVRSRV_MEMALLOCFLAG_CPU_WRITEABLE |
			      PVRSRV_MEMALLOCFLAG_UNCACHED_WC,
			      pszAnnotation,
			      &sDCPMRFuncTab,
			      psPMRPriv,
			      PMR_TYPE_DC,
			      ppsPMR,
			      bSystemBuffer ? PDUMP_PERSIST : PDUMP_NONE);
```

PMR 锁物理地址时会回调 `dc_sunxi` 的 `pfnBufferAcquire`：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/common/dc_server.c
static PVRSRV_ERROR _DCPMRLockPhysAddresses(PMR_IMPL_PRIVDATA pvPriv)
{
	DC_BUFFER_PMR_DATA *psPMRPriv = pvPriv;
	DC_BUFFER *psBuffer = psPMRPriv->psBuffer;
	DC_DEVICE *psDevice = psBuffer->psDisplayContext->psDevice;

	psPMRPriv->pasDevPAddr =
		OSAllocZMem(sizeof(IMG_DEV_PHYADDR) * psPMRPriv->ui32PageCount);

	eError = psDevice->psFuncTable->pfnBufferAcquire(psBuffer->hBuffer,
							 psPMRPriv->pasDevPAddr,
							 &psPMRPriv->pvLinAddr);
```

因此 `dc_sunxi` 路径下，GPU render target 本质上是 fbdev 显存的一段。GPU 渲染完成后，不需要再导出 dma-buf 给 KMS plane。

## 7. present/flip 如何从 PVR DC bridge 到 fb_pan_display

Display Class bridge id：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/include/pvr_bridge.h
#define PVRSRV_BRIDGE_DC 12UL
```

如果启用 `SUPPORT_DISPLAY_CLASS`，DC bridge function 会进入分发表：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/generated/rogue/dc_bridge/server_dc_bridge.c
SetDispatchTableEntry(PVRSRV_BRIDGE_DC,
		      PVRSRV_BRIDGE_DC_DCDISPLAYCONTEXTCONFIGURE2,
		      PVRSRVBridgeDCDisplayContextConfigure2,
		      pDCBridgeLock,
		      sizeof(PVRSRV_BRIDGE_IN_DCDISPLAYCONTEXTCONFIGURE2),
		      sizeof(PVRSRV_BRIDGE_OUT_DCDISPLAYCONTEXTCONFIGURE2));
```

对应的 bridge 输入结构包含 display context、buffer handle、fence 等：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/generated/rogue/dc_bridge/common_dc_bridge.h
typedef struct PVRSRV_BRIDGE_IN_DCDISPLAYCONTEXTCONFIGURE2_TAG
{
	IMG_HANDLE hDisplayContext;
	PVRSRV_SURFACE_CONFIG_INFO *psSurfInfo;
	IMG_HANDLE *phBuffers;
	PVRSRV_FENCE hAcquireFence;
	PVRSRV_TIMELINE hReleaseFenceTimeline;
	IMG_UINT32 ui32DisplayPeriod;
	IMG_UINT32 ui32MaxDepth;
	IMG_UINT32 ui32PipeCount;
} __packed PVRSRV_BRIDGE_IN_DCDISPLAYCONTEXTCONFIGURE2;
```

bridge 查 handle 后进入 `DCDisplayContextConfigure()`：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/generated/rogue/dc_bridge/server_dc_bridge.c
psDCDisplayContextConfigure2OUT->eError =
	DCDisplayContextConfigure(psDisplayContextInt,
				  psDCDisplayContextConfigure2IN->ui32PipeCount,
				  psSurfInfoInt,
				  psBuffersInt,
				  psDCDisplayContextConfigure2IN->ui32DisplayPeriod,
				  psDCDisplayContextConfigure2IN->ui32MaxDepth,
				  psDCDisplayContextConfigure2IN->hAcquireFence,
				  psDCDisplayContextConfigure2IN->hReleaseFenceTimeline,
				  &psDCDisplayContextConfigure2OUT->hReleaseFence);
```

`dc_server` 把显示配置提交到 software command processor，ready 后回调 Display Class driver：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/common/dc_server.c
static void _DCDisplayContextConfigure(void *hReadyData,
				       void *hCompleteData)
{
	DC_CMD_RDY_DATA *psReadyData = (DC_CMD_RDY_DATA *)hReadyData;
	DC_DISPLAY_CONTEXT *psDisplayContext = psReadyData->psDisplayContext;
	DC_DEVICE *psDevice = psDisplayContext->psDevice;

	psDevice->psFuncTable->pfnContextConfigure(
		psDisplayContext->hDisplayContext,
		psReadyData->ui32BufferCount,
		psReadyData->pasSurfAttrib,
		psReadyData->pahBuffer,
		psReadyData->ui32DisplayPeriod,
		hCompleteData);
}
```

`dc_sunxi` 的 `ContextConfigure` 根据 buffer id 设置 fbdev `yoffset`：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
void DC_FBDEV_ContextConfigure(IMG_HANDLE hDisplayContext,
			       IMG_UINT32 ui32PipeCount,
			       PVRSRV_SURFACE_CONFIG_INFO *pasSurfAttrib,
			       IMG_HANDLE *ahBuffers,
			       IMG_UINT32 ui32DisplayPeriod,
			       IMG_HANDLE hConfigData)
{
	DC_FBDEV_CONTEXT *psDeviceContext = hDisplayContext;
	DC_FBDEV_DEVICE *psDeviceData = psDeviceContext->psDeviceData;
	struct fb_var_screeninfo sVar = psDeviceData->psLINFBInfo->var;

	sVar.yoffset = 0;

	if (ui32PipeCount != 0) {
		if (psDeviceData->bCanFlip) {
			DC_FBDEV_BUFFER *psBuffer = ahBuffers[0];
			sVar.yoffset = sVar.yres * psBuffer->ui32BufferID;
		}
	}
```

真正翻屏是 `fb_set_var()` 或 `fb_pan_display()`：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
if (psDeviceData->bCanFlip &&
    sVar.yres_virtual < sVar.yres * NUM_PREFERRED_BUFFERS)
{
	sVar.activate = FB_ACTIVATE_NOW;
	sVar.yres_virtual = sVar.yres * NUM_PREFERRED_BUFFERS;

	err = fb_set_var(psDeviceData->psLINFBInfo, &sVar);
	if (err)
		pr_err("fb_set_var failed (err=%d)\n", err);
}
else
{
	err = fb_pan_display(psDeviceData->psLINFBInfo, &sVar);
	if (err)
		pr_err("fb_pan_display failed (err=%d)\n", err);
}
```

这就是 `eglSwapBuffers()` 这类 present 动作在 `dc_sunxi` 体系下最终触发的送显动作。

## 8. sunxi fbdev/disp2 如何完成最终送显

SDK 中有两套 fbdev 代码形态，常见入口包括：

- `bsp/drivers/video/sunxi/disp2/disp/fb_core.c`
- `bsp/drivers/video/sunxi/disp2/disp/dev_fb.c`

`fb_core.c` 里 `/dev/fbX` 的 fbops：

```c
// bsp/drivers/video/sunxi/disp2/disp/fb_core.c
static struct fb_ops dispfb_ops = {
	.owner = THIS_MODULE,
	.fb_open = sunxi_fb_open,
	.fb_release = sunxi_fb_release,
	.fb_pan_display = sunxi_fb_pan_display,
	.fb_ioctl = sunxi_fb_ioctl,
	.fb_check_var = sunxi_fb_check_var,
	.fb_set_par = sunxi_fb_set_par,
	.fb_blank = sunxi_fb_blank,
	.fb_mmap = sunxi_fb_mmap,
	.fb_setcolreg = sunxi_fb_setcolreg,
};
```

注册 fbdev：

```c
// bsp/drivers/video/sunxi/disp2/disp/fb_core.c
ret = platform_fb_memory_alloc(info->par,
			       &virtual_addr,
			       &device_addr,
			       width * height * FB_BUFFER_CNT * bpp / 8);

info->screen_base = virtual_addr;
info->fbops = &dispfb_ops;
fb_init_var(info->par, &info->var, create->fb_share.format, width, height);
fb_init_fix(&info->fix, device_addr,
	    width * info->var.bits_per_pixel / 8,
	    height * FB_BUFFER_CNT);
register_framebuffer(info);
```

`fb_core.c` 的 pan display 会调用平台层更新输出：

```c
// bsp/drivers/video/sunxi/disp2/disp/fb_core.c
int sunxi_fb_pan_display(struct fb_var_screeninfo *var,
			 struct fb_info *info)
{
	platform_update_fb_output(info->par, var);

	if (var->reserved[0] == FB_ACTIVATE_FORCE)
		return 0;

	platform_fb_pan_display_post_proc(info->par);
	return 0;
}
```

`dev_fb.c` 中更直接展示了 fbdev `yoffset` 如何转成 DE layer crop：

```c
// bsp/drivers/video/sunxi/disp2/disp/dev_fb.c
static int sunxi_fb_pan_display(struct fb_var_screeninfo *var,
				struct fb_info *info)
{
	...
	config.info.fb.crop.x =
		((long long)var->xoffset) << 32;
	config.info.fb.crop.y =
		((unsigned long long)(var->yoffset)) << 32;
	config.info.fb.crop.width =
		((long long)var->xres) << 32;
	config.info.fb.crop.height =
		((long long)(var->yres / buffer_num)) << 32;

	if (mgr->set_layer_config(mgr, &config, 1) != 0) {
		DE_WARN("fb%d,set_lyr_cfg(%d,%d,%d)fail\n",
			info->node, sel, chan, layer_id);
		return -1;
	}

	if (need_wait_vsync == 1)
		fb_wait_for_vsync(info);

	return 0;
}
```

`/dev/disp` 是另一条 Allwinner 私有 ioctl 路径，不是 DRM ioctl：

```c
// bsp/drivers/video/sunxi/disp2/disp/dev_disp.c
case DISP_LAYER_SET_CONFIG:
{
	if (copy_from_user(lyr_cfg,
			   (void __user *)ubuffer[1],
			   sizeof(struct disp_layer_config) * ubuffer[2])) {
		return -EFAULT;
	}

	if (mgr && mgr->set_layer_config)
		ret = mgr->set_layer_config(mgr, lyr_cfg, ubuffer[2]);
	break;
}

static const struct file_operations disp_fops = {
	.open = disp_open,
	.release = disp_release,
	.unlocked_ioctl = disp_ioctl,
	.mmap = disp_mmap,
	.poll = disp_vsync_poll,
};
```

## 9. 当前默认 DRM/KMS 路径对比

当前默认 `nulldrmws` 下，PVR 侧主要负责 render、GEM/PMR、PRIME/dma-buf、sync、bridge；真正 scanout owner 是 `sunxi-drm`。

标准路径为：

```text
App / EGL / GLES / compositor
  -> PVR render
  -> PVR GEM/PMR
  -> PRIME/dma-buf fd
  -> sunxi-drm import dma-buf
  -> drmModeAddFB2()
  -> drmModeAtomicCommit()
  -> DRM plane / crtc / connector
  -> DE / TCON / output
```

`sunxi-drm` 是真正的 KMS driver：

```c
// bsp/drivers/drm/sunxi_drm_drv.c
static const struct drm_mode_config_funcs sunxi_drm_mode_config_funcs = {
	.atomic_check = drm_atomic_helper_check,
	.atomic_commit = sunxi_drm_atomic_helper_commit,
	.fb_create = sunxi_drm_gem_fb_create,
};

static struct drm_driver sunxi_drm_driver = {
	.driver_features = DRIVER_MODESET | DRIVER_GEM | DRIVER_ATOMIC,
	.fops = &sunxi_drm_driver_fops,
	.ioctls = sunxi_drm_ioctls,
	.num_ioctls = ARRAY_SIZE(sunxi_drm_ioctls),
	.name = DRIVER_NAME,
	.gem_create_object = sunxi_gem_create_object,
};
```

bind 时初始化 mode config、绑定 DE/TCON/HDMI/DSI 等组件、注册 DRM 设备：

```c
// bsp/drivers/drm/sunxi_drm_drv.c
static int sunxi_drm_bind(struct device *dev)
{
	private = __devm_drm_dev_alloc(dev, &sunxi_drm_driver,
				       sizeof(*private) + sizeof(struct sunxi_drm_pri),
				       offsetof(struct sunxi_drm_private, base));
	drm = &private->base;

	ret = drmm_mode_config_init(drm);
	sunxi_drm_mode_config_init(drm);
	sunxi_drm_property_create(private);

	ret = component_bind_all(dev, drm);

	dev_set_drvdata(dev, drm);
	drm_mode_config_reset(drm);
	drm_kms_helper_poll_init(drm);

	ret = drm_dev_register(drm, 0);
```

plane 初始化：

```c
// bsp/drivers/drm/sunxi_drm_crtc.c
if (drm_universal_plane_init(dev,
			     &plane->plane,
			     possible_crtc,
			     &sunxi_plane_funcs,
			     info->formats,
			     info->format_count,
			     info->format_modifiers,
			     type,
			     "plane-%d-%s(%d)",
			     plane->index,
			     info->name,
			     de_id)) {
	DRM_ERROR("drm_universal_plane_init failed\n");
	return -1;
}

drm_plane_helper_add(&plane->plane, &sunxi_plane_helper_funcs);
```

atomic plane update 进入 DE channel update：

```c
// bsp/drivers/drm/sunxi_drm_crtc.c
static void sunxi_plane_atomic_update(struct drm_plane *plane,
				      struct drm_atomic_state *state)
{
	struct drm_plane_state *new_state = plane->state;
	struct display_channel_state *new_cstate = to_display_channel_state(new_state);
	struct sunxi_drm_plane *sunxi_plane = to_sunxi_plane(plane);
	struct sunxi_drm_crtc *scrtc = sunxi_plane->crtc;
	struct sunxi_de_channel_update info;

	info.hdl = sunxi_plane->hdl;
	info.hwde = scrtc->sunxi_de;
	info.new_state = new_cstate;
	info.old_state = old_cstate;
	info.is_fbdev = false;
	info.fbdev_output = scrtc->fbdev_output;
	sunxi_de_channel_update(&info);
}
```

DE overlay 从 DRM framebuffer 的 GEM DMA 地址生成硬件地址：

```c
// bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/ovl/de_ovl.c
gem = drm_fb_dma_get_gem_obj(fb, 0);
if (gem) {
	addr_tmp = (u64)(gem->dma_addr) + fb->offsets[0];
}

addr = addr_tmp + pitch * y0 + (x0 * bpp >> 3);

reg->lay[layer_id].pitch.dwval = pitch;
reg->lay[layer_id].top_laddr.dwval = (u32)addr;
reg->lay[layer_id].bot_laddr.dwval = 0;
```

这和 `dc_sunxi` 的最大区别是：

```text
dc_sunxi 路径：
  GPU 直接渲染 fbdev 显存，fb_pan_display() 翻页。

sunxi-drm KMS 路径：
  GPU 渲染到 PVR buffer，用户态导出 dma-buf，sunxi-drm import 后 atomic commit 到 plane。
```

## 10. 上层调用 API 示例

### 10.1 dc_sunxi 路径：EGL/GLES 上层常见形态

普通应用通常不会手写 PVR Display Class bridge。应用看到的是 EGL/GLES，Display Class present 由 IMG 用户态库完成。

```c
#include <EGL/egl.h>
#include <GLES2/gl2.h>

int main(void)
{
	EGLDisplay dpy;
	EGLConfig cfg;
	EGLContext ctx;
	EGLSurface surf;
	EGLint num;

	static const EGLint cfg_attr[] = {
		EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
		EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
		EGL_RED_SIZE, 8,
		EGL_GREEN_SIZE, 8,
		EGL_BLUE_SIZE, 8,
		EGL_ALPHA_SIZE, 8,
		EGL_NONE
	};

	static const EGLint ctx_attr[] = {
		EGL_CONTEXT_CLIENT_VERSION, 2,
		EGL_NONE
	};

	dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
	eglInitialize(dpy, NULL, NULL);
	eglChooseConfig(dpy, cfg_attr, &cfg, 1, &num);

	ctx = eglCreateContext(dpy, cfg, EGL_NO_CONTEXT, ctx_attr);

	/*
	 * dc_sunxi/nullws 类窗口系统下，native window 由 IMG WSEGL/vendor
	 * userspace 决定。有些实现可传 NULL，有些实现需要 vendor native
	 * window 句柄。
	 */
	surf = eglCreateWindowSurface(dpy, cfg,
				      (EGLNativeWindowType)0,
				      NULL);

	eglMakeCurrent(dpy, surf, surf, ctx);

	glViewport(0, 0, 1280, 720);
	glClearColor(1.0f, 0.0f, 0.0f, 1.0f);
	glClear(GL_COLOR_BUFFER_BIT);

	/*
	 * dc_sunxi 路径下，内部大致触发：
	 * eglSwapBuffers()
	 *   -> PVR DC bridge
	 *   -> DCDisplayContextConfigure()
	 *   -> DC_FBDEV_ContextConfigure()
	 *   -> fb_pan_display()
	 */
	eglSwapBuffers(dpy, surf);

	return 0;
}
```

### 10.2 fbdev 直接翻页验证示例

该示例不走 GPU，只用于验证 `/dev/fb0`、`yoffset`、`fb_pan_display()`、disp2 layer 是否能正常工作。

```c
#include <fcntl.h>
#include <linux/fb.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void)
{
	int fb;
	struct fb_var_screeninfo var;
	struct fb_fix_screeninfo fix;
	size_t map_size;
	uint8_t *base;
	int back_index = 1;

	fb = open("/dev/fb0", O_RDWR | O_CLOEXEC);
	if (fb < 0)
		return 1;

	if (ioctl(fb, FBIOGET_VSCREENINFO, &var) < 0)
		return 1;
	if (ioctl(fb, FBIOGET_FSCREENINFO, &fix) < 0)
		return 1;

	map_size = fix.smem_len;
	base = mmap(NULL, map_size, PROT_READ | PROT_WRITE, MAP_SHARED, fb, 0);
	if (base == MAP_FAILED)
		return 1;

	/* 确保 yres_virtual 至少有双缓冲空间。 */
	if (var.yres_virtual < var.yres * 2) {
		var.yres_virtual = var.yres * 2;
		ioctl(fb, FBIOPUT_VSCREENINFO, &var);
		ioctl(fb, FBIOGET_VSCREENINFO, &var);
	}

	/* 写第二个 buffer。 */
	memset(base + back_index * var.yres * fix.line_length,
	       0xff,
	       var.yres * fix.line_length);

	var.yoffset = back_index * var.yres;
	ioctl(fb, FBIOPAN_DISPLAY, &var);

	{
		uint32_t zero = 0;
		ioctl(fb, FBIO_WAITFORVSYNC, &zero);
	}

	munmap(base, map_size);
	close(fb);
	return 0;
}
```

### 10.3 PVR DC bridge 直接 ioctl 形态

实际项目中不建议应用直接调用这些 bridge，因为需要正确管理 PVR connection、handle、PMR、fence、Display Context。这里仅用于说明 UAPI 形态。

```c
#include <drm/drm.h>
#include "pvr_drm.h"
#include "pvr_bridge.h"
#include "common_dc_bridge.h"

int pvr_dc_configure2(int pvr_fd,
		      PVRSRV_BRIDGE_IN_DCDISPLAYCONTEXTCONFIGURE2 *in,
		      PVRSRV_BRIDGE_OUT_DCDISPLAYCONTEXTCONFIGURE2 *out)
{
	struct drm_pvr_srvkm_cmd cmd = {
		.bridge_id = PVRSRV_BRIDGE_DC,
		.bridge_func_id = PVRSRV_BRIDGE_DC_DCDISPLAYCONTEXTCONFIGURE2,
		.in_data_ptr = (uintptr_t)in,
		.out_data_ptr = (uintptr_t)out,
		.in_data_size = sizeof(*in),
		.out_data_size = sizeof(*out),
	};

	return ioctl(pvr_fd, DRM_IOCTL_PVR_SRVKM_CMD, &cmd);
}
```

### 10.4 当前 DRM/KMS 路径：dma-buf 到 atomic commit

这是当前默认 `nulldrmws` 更匹配的上层送显模型。PVR 用户态渲染完成后导出 dma-buf fd，再由 KMS client/compositor 交给 `sunxi-drm`。

```c
#include <fcntl.h>
#include <stdint.h>
#include <unistd.h>
#include <xf86drm.h>
#include <xf86drmMode.h>

int display_dmabuf_on_kms(int card_fd,
			  int dma_buf_fd,
			  uint32_t width,
			  uint32_t height,
			  uint32_t pitch,
			  uint32_t plane_id,
			  uint32_t crtc_id,
			  uint32_t prop_fb_id,
			  uint32_t prop_crtc_id)
{
	uint32_t handle = 0;
	uint32_t fb_id = 0;
	uint32_t handles[4] = {0};
	uint32_t pitches[4] = {0};
	uint32_t offsets[4] = {0};
	drmModeAtomicReq *req;
	int ret;

	ret = drmPrimeFDToHandle(card_fd, dma_buf_fd, &handle);
	if (ret)
		return ret;

	handles[0] = handle;
	pitches[0] = pitch;
	offsets[0] = 0;

	ret = drmModeAddFB2(card_fd,
			    width,
			    height,
			    DRM_FORMAT_XRGB8888,
			    handles,
			    pitches,
			    offsets,
			    &fb_id,
			    0);
	if (ret)
		return ret;

	req = drmModeAtomicAlloc();
	drmModeAtomicAddProperty(req, plane_id, prop_fb_id, fb_id);
	drmModeAtomicAddProperty(req, plane_id, prop_crtc_id, crtc_id);

	ret = drmModeAtomicCommit(card_fd,
				  req,
				  DRM_MODE_ATOMIC_NONBLOCK,
				  NULL);

	drmModeAtomicFree(req);
	return ret;
}
```

## 11. 快速判断当前系统走哪条路径

看构建配置：

```text
KERNEL_COMPONENTS 包含 dc_sunxi
  -> PVR Display Class fbdev 后端可能参与。

WINDOW_SYSTEM := nulldrmws
SUPPORT_DISPLAY_CLASS := 0
SUPPORT_KMS := 1
  -> 当前默认是 PVR render + KMS 方向。
```

看运行时调用：

```text
进入 DC_FBDEV_ContextConfigure()
  -> fb_pan_display()
  -> bsp/drivers/video/sunxi/disp2
  -> dc_sunxi/fbdev 路径。

进入 drmModeAtomicCommit()
  -> sunxi_plane_atomic_update()
  -> sunxi_de_channel_update()
  -> de_ovl 从 drm_framebuffer/GEM 取 dma_addr
  -> sunxi-drm KMS 路径。
```

看上层 API：

```text
只用 EGL/GLES + vendor WSEGL，swap 后内部触发 PVR DC bridge
  -> 可能是 dc_sunxi/Display Class 路径。

显式使用 drmModeAddFB2/drmModeAtomicCommit
  -> 标准 DRM/KMS 路径。

显式使用 /dev/fb0 的 FBIOPAN_DISPLAY/FBIO_WAITFORVSYNC
  -> fbdev/disp2 路径。

显式使用 /dev/disp 的 DISP_LAYER_SET_CONFIG
  -> Allwinner 私有 disp ioctl 路径。
```

## 12. 最核心的一句话

`dc_sunxi` 适配体系的关键不是把 PVR render buffer 交给 DRM/KMS plane，而是把 fbdev 显存反向包装成 PVR Display Class buffer/PMR，使 GPU 可以直接渲染到 fbdev backing memory；present 时 `dc_sunxi` 只需要调用 `fb_pan_display()` 改 `yoffset`，后面的 DE/TCON 输出由 Allwinner fbdev/disp2 完成。

当前默认 SDK 配置则已经转向 `PVR render + sunxi-drm KMS scanout`，也就是 PVR 负责画和导出 dma-buf，`sunxi-drm` 负责 plane/crtc/connector/atomic commit 和最终 scanout。
