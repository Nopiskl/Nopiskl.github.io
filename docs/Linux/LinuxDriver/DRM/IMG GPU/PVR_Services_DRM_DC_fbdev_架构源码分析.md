# PVR Services / DRM / DC fbdev 架构源码分析

本文结合当前 SDK 源码，对 PVR 架构里两个核心问题做源码级梳理：

1. `PVRSRVCommonDeviceCreate()`、`PVRSRVDriverInit()`、`PVRSRVDeviceServicesOpen()` 等 Services 相关代码在做什么？它们是否在创建与内核 ioctl 分发有关的进程？
2. PVR 如何通过一套 Services / bridge 框架，同时支持标准 DRM/KMS 路径，以及通过 `dc_sunxi` / `dc_fbdev` 注册 Display Class 后获得 fbdev 显示能力？

涉及源码目录：

- PVR GPU 驱动：`bsp/modules/gpu/img-bxm`
- sunxi DRM/KMS 驱动：`bsp/drivers/drm`
- sunxi fbdev/disp 驱动：`bsp/drivers/video/sunxi`

## 1. 总体结论

`PVRSRVCommonDeviceCreate()` 不是创建 ioctl 分发进程，也不是创建用户态 daemon。它在内核里创建 PVR Services 的设备对象和服务上下文，核心是 `PVRSRV_DEVICE_NODE`，并把系统层、RGX GPU、物理堆、PMR、sync、debug、DVFS、apphint 等挂到这个设备节点上。

真正的 ioctl 分发入口在 PVR DRM driver 的 private ioctl：

```text
DRM_IOCTL_PVR_SRVKM_CMD
  -> PVRSRV_BridgeDispatchKM()
  -> BridgedDispatchKM()
  -> g_BridgeDispatchTable[bridge_id + func_id]
  -> generated server bridge
  -> services/server/*
```

PVR 的巧妙设计是把三层分开：

```text
ioctl transport 层:
  Linux DRM private ioctl 只负责把 bridge_id / function_id / 参数送进 PVR

PVR Services 层:
  RGX render、MM/PMR、sync、dmabuf、Display Class 都是 bridge group

显示后端层:
  标准 DRM/KMS: PVR render buffer 通过 dma-buf 交给 sunxi-drm scanout
  旧 fbdev/DC: dc_sunxi 注册 DC_DEVICE_FUNCTIONS，PVR DC bridge 调它，最终 fb_pan_display()
```

因此所谓“一套程序既能走标准 DRM，又能走 fbdev”，不是同一条显示路径同时操作两套显示框架，而是 PVR Services 核心复用，window system / display backend 可切换。

## 2. 当前默认构建路径

当前 A733 BXM 树默认是 `nulldrmws + srvkm`，没有启用 `dc_sunxi`：

```make
// bsp/modules/gpu/img-bxm/linux/rogue_km/build/linux/sunxi_linux/Makefile
WINDOW_SYSTEM := nulldrmws
PVR_SYSTEM := rgx_sunxi

KERNEL_COMPONENTS := srvkm

#DISPLAY_CONTROLLER := dc_sunxi
#KERNEL_COMPONENTS += $(DISPLAY_CONTROLLER)
```

`nulldrmws` 在 window system 配置中明确关闭 Display Class，打开 KMS：

```make
// bsp/modules/gpu/img-bxm/linux/rogue_km/build/linux/config/window_system.mk
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

所以当前默认主路径是：

```text
PVR 负责 GPU render / memory / sync / dma-buf export
sunxi-drm 负责标准 DRM/KMS scanout
```

`dc_sunxi` 是保留在源码里的旧 fbdev Display Class 后端。

## 3. PVR Services 初始化层次

PVR platform driver 初始化时，先把通用 `pvr_drm_generic_driver` 拷贝到 platform driver 实例，再做 Services 全局初始化：

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

`PVRSRVDriverInit()` 是一次性的全局 Services 初始化，包括 OS 抽象、common services、sync、apphint、debugfs/procfs 等：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/module_common.c
int PVRSRVDriverInit(void)
{
	PVRSRV_ERROR error;
	int os_err;

	error = PVROSFuncInit();
	if (error != PVRSRV_OK)
		return -ENOMEM;

	error = PVRSRVCommonDriverInit();
	if (error != PVRSRV_OK)
		return -ENODEV;

#if defined(SUPPORT_NATIVE_FENCE_SYNC)
	error = pvr_sync_register_functions();
	if (error != PVRSRV_OK)
		return -EPERM;

	os_err = pvr_sync_init();
	if (os_err != 0)
		return os_err;
#endif

	os_err = pvr_apphint_init();
	...

	return 0;
}
```

真正把 bridge dispatch table、PMR、可选 DC 框架初始化起来的是 `PVRSRVCommonDriverInit()`：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/common/pvrsrv.c
PVRSRVCommonDriverInit(void)
{
	...
	eError = ServerBridgeInit();
	PVR_GOTO_IF_ERROR(eError, Error);

	eError = DevmemIntInit();
	PVR_GOTO_IF_ERROR(eError, Error);

	eError = DebugCommonInitDriver();
	PVR_GOTO_IF_ERROR(eError, Error);

	eError = BridgeDispatcherInit();
	PVR_GOTO_IF_ERROR(eError, Error);

	...
	eError = PMRInit();
	PVR_GOTO_IF_ERROR(eError, Error);

#if defined(SUPPORT_DISPLAY_CLASS)
	eError = DCInit();
	PVR_GOTO_IF_ERROR(eError, Error);
#endif

	gpsPVRSRVData->eServicesState = PVRSRV_SERVICES_STATE_OK;
	...
}
```

这里有两个关键点：

- `ServerBridgeInit()` 注册各类 bridge group，例如 SRVCORE、MM、SYNC、RGXTA3D、DMABUF，以及可选 DC。
- `BridgeDispatcherInit()` 初始化 bridge dispatch 所需的缓冲池、统计、锁等。

## 4. `PVRSRVCommonDeviceCreate()` 到底创建什么

PVR platform probe 创建 DRM 设备后，会进入 `pvr_drm_load()`：

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

	return 0;
}
```

`pvr_drm_load()` 负责把 DRM device 和 PVR Services device node 绑起来：

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
	...
	return 0;
}
```

`PVRSRVCommonDeviceCreate()` 主要创建并初始化 `PVRSRV_DEVICE_NODE`：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/common/pvrsrv.c
PVRSRV_ERROR PVRSRVCommonDeviceCreate(void *pvOSDevice,
				      IMG_INT32 i32KernelDeviceID,
				      PVRSRV_DEVICE_NODE **ppsDeviceNode)
{
	PVRSRV_DATA *psPVRSRVData = PVRSRVGetPVRSRVData();
	PVRSRV_DEVICE_CONFIG *psDevConfig;
	PVRSRV_DEVICE_NODE *psDeviceNode;
	IMG_UINT32 ui32InternalID;
	PVRSRV_ERROR eError;

	psDeviceNode = OSAllocZMemNoStats(sizeof(*psDeviceNode));
	PVR_LOG_RETURN_IF_NOMEM(psDeviceNode, "psDeviceNode");

	psDeviceNode->sDevId.i32KernelDeviceID = i32KernelDeviceID;
	eError = PVRSRVAcquireInternalID(&ui32InternalID);
	PVR_LOG_GOTO_IF_ERROR(eError, "PVRSRVAcquireInternalID", ErrorDeregisterStats);

	eError = SysDevInit(pvOSDevice, &psDevConfig);
	PVR_LOG_GOTO_IF_ERROR(eError, "SysDevInit", ErrorDeregisterStats);

	psDeviceNode->sDevId.ui32InternalID = ui32InternalID;
	psDeviceNode->psDevConfig = psDevConfig;
	psDevConfig->psDevNode = psDeviceNode;

	eError = PhysHeapInitDeviceHeaps(psDeviceNode, psDevConfig);
	PVR_GOTO_IF_ERROR(eError, ErrorPowerLockDeInit);

#if defined(SUPPORT_RGX)
	eError = RGXRegisterDevice(psDeviceNode);
	if (eError != PVRSRV_OK) {
		eError = PVRSRV_ERROR_DEVICE_REGISTER_FAILED;
		goto ErrorPMRDeInitDevice;
	}
#endif

	eError = SyncServerInit(psDeviceNode);
	PVR_GOTO_IF_ERROR(eError, ErrorDeInitRgx);

	eError = SyncCheckpointInit(psDeviceNode);
	PVR_LOG_GOTO_IF_ERROR(eError, "SyncCheckpointInit", ErrorSyncCheckpointInit);

	...
	List_PVRSRV_DEVICE_NODE_InsertTail(&psPVRSRVData->psDeviceNodeList,
					   psDeviceNode);
	psPVRSRVData->ui32RegisteredDevices++;

	*ppsDeviceNode = psDeviceNode;
	PVRSRVDeviceSetState(psDeviceNode, PVRSRV_DEVICE_STATE_CREATED);

	return PVRSRV_OK;
}
```

这段代码可以拆成几个动作：

- 分配 `PVRSRV_DEVICE_NODE`。
- 调 `SysDevInit()` 进入平台系统层，例如 `rgx_sunxi`，拿到寄存器、IRQ、clock、power、heap 等设备配置。
- 初始化物理堆：`PhysHeapInitDeviceHeaps()`。
- 注册 RGX 设备：`RGXRegisterDevice()`。
- 初始化 sync server / sync checkpoint。
- 初始化 debug、DVFS、apphint、page fault debug 等。
- 把设备节点插入 `PVRSRV_DATA::psDeviceNodeList`。

所以它是 Services 设备对象生命周期的一部分，不是 ioctl 分发线程或进程。

## 5. open / connection / ioctl 的关系

PVR DRM driver 注册自己的 fops 和 private ioctl：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_drm.c
static struct drm_ioctl_desc pvr_drm_ioctls[] = {
	DRM_IOCTL_DEF_DRV(PVR_SRVKM_CMD, PVRSRV_BridgeDispatchKM,
			  DRM_RENDER_ALLOW),
	DRM_IOCTL_DEF_DRV(PVR_SRVKM_INIT, drm_pvr_srvkm_init,
			  DRM_RENDER_ALLOW),
	...
};

const struct file_operations pvr_drm_fops = {
	.owner          = THIS_MODULE,
	.open           = drm_open,
	.release        = drm_release,
	.unlocked_ioctl = drm_ioctl,
	.mmap           = PVRSRV_MMap,
	.poll           = drm_poll,
	.read           = drm_read,
};

const struct drm_driver pvr_drm_generic_driver = {
	.driver_features = DRIVER_MODESET | DRIVER_RENDER |
			   DRIVER_GEM | PVR_DRM_DRIVER_PRIME,
	.open      = pvr_drm_open,
	.postclose = pvr_drm_release,
	.ioctls    = pvr_drm_ioctls,
	.num_ioctls = ARRAY_SIZE(pvr_drm_ioctls),
	.fops      = &pvr_drm_fops,
	.name      = PVR_DRM_DRIVER_NAME,
};
```

当用户态打开 PVR DRM 节点时，DRM core 最终回调 `pvr_drm_open()`：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_drm.c
static int pvr_drm_open(struct drm_device *ddev, struct drm_file *dfile)
{
	struct pvr_drm_private *priv = ddev->dev_private;
	int err;

	if (!try_module_get(THIS_MODULE))
		return -ENOENT;

	err = PVRSRVDeviceServicesOpen(priv->dev_node, dfile);
	if (err)
		module_put(THIS_MODULE);

	return err;
}
```

`PVRSRVDeviceServicesOpen()` 给这个 `drm_file` 建立一个 PVR connection：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/module_common.c
int PVRSRVDeviceServicesOpen(PVRSRV_DEVICE_NODE *psDeviceNode,
			     struct drm_file *psDRMFile)
{
	PVRSRV_CONNECTION_PRIV *psConnectionPriv;
	ENV_CONNECTION_PRIVATE_DATA sPrivData;
	PVRSRV_ERROR eError;

	if (psDRMFile->driver_priv == NULL) {
		psConnectionPriv = kzalloc(sizeof(*psConnectionPriv), GFP_KERNEL);
		psConnectionPriv->ui32Type = DKF_CONNECTION_FLAG_SERVICES;
	} else {
		psConnectionPriv = (PVRSRV_CONNECTION_PRIV*)psDRMFile->driver_priv;
	}

	if (psDeviceNode->eDevState == PVRSRV_DEVICE_STATE_CREATED) {
		eError = PVRSRVCommonDeviceInitialise(psDeviceNode);
		...
	}

	sPrivData.psDevNode = psDeviceNode;
	sPrivData.psDRMFile = psDRMFile;

	eError = PVRSRVCommonConnectionConnect(&psConnectionPriv->pvConnectionData,
					       (void *)&sPrivData);
	...

	psDRMFile->driver_priv = (void*)psConnectionPriv;
	return 0;
}
```

后续 ioctl 分发时，会从 `drm_file->filp` 反查这个 connection：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/module_common.c
CONNECTION_DATA *LinuxServicesConnectionFromFile(struct file *pFile)
{
	struct drm_file *psDRMFile;
	PVRSRV_CONNECTION_PRIV *psConnectionPriv;

	psDRMFile = pFile->private_data;
	psConnectionPriv = (PVRSRV_CONNECTION_PRIV*)psDRMFile->driver_priv;

	return (CONNECTION_DATA*)psConnectionPriv->pvConnectionData;
}
```

因此 PVR 的对象模型是：

```text
drm_device
  -> pvr_drm_private
      -> PVRSRV_DEVICE_NODE

drm_file
  -> PVRSRV_CONNECTION_PRIV
      -> CONNECTION_DATA
          -> ENV_CONNECTION_DATA
```

没有额外“ioctl 分发进程”。ioctl 在调用进程上下文中从 `drm_ioctl()` 进入 PVR bridge。

## 6. PVR bridge ioctl 分发机制

用户态传给内核的 PVR private ioctl 包非常小：

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

内核入口把它转成 `PVRSRV_BRIDGE_PACKAGE`：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_bridge_k.c
int PVRSRV_BridgeDispatchKM(struct drm_device *dev,
			    void *arg,
			    struct drm_file *pDRMFile)
{
	struct drm_pvr_srvkm_cmd *psSrvkmCmd = arg;
	PVRSRV_BRIDGE_PACKAGE sBridgePackageKM = { 0 };
	CONNECTION_DATA *psConnection =
		LinuxServicesConnectionFromFile(pDRMFile->filp);
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

`BridgedDispatchKM()` 通过 `bridge_id` 找 group 起始位置，再加 `bridge_func_id` 找最终处理函数：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/common/srvcore.c
PVRSRV_ERROR BridgedDispatchKM(CONNECTION_DATA *psConnection,
			       PVRSRV_BRIDGE_PACKAGE *psBridgePackageKM)
{
	BridgeWrapperFunction pfBridgeHandler;
	IMG_UINT32 ui32DispatchTableEntry, ui32GroupBoundary;
	IMG_UINT32 ui32DispatchTableIndex, ui32DispatchTableEntryIndex;

	ui32DispatchTableIndex =
		OSConfineArrayIndexNoSpeculation(psBridgePackageKM->ui32BridgeID,
						  BRIDGE_DISPATCH_TABLE_START_ENTRY_COUNT);

	ui32DispatchTableEntry =
		g_BridgeDispatchTableStartOffsets[ui32DispatchTableIndex]
						  [PVR_DISPATCH_OFFSET_FIRST_FUNC];
	ui32GroupBoundary =
		g_BridgeDispatchTableStartOffsets[ui32DispatchTableIndex]
						  [PVR_DISPATCH_OFFSET_LAST_FUNC];

	ui32DispatchTableEntry += psBridgePackageKM->ui32FunctionID;
	ui32DispatchTableEntryIndex =
		OSConfineArrayIndexNoSpeculation(ui32DispatchTableEntry,
						  ui32GroupBoundary + 1);

	...
	CopyFromUserWrapper(...);

	pfBridgeHandler =
		(BridgeWrapperFunction)g_BridgeDispatchTable[ui32DispatchTableEntryIndex].pfFunction;

	pfBridgeHandler(ui32DispatchTableEntryIndex,
			psBridgeIn,
			psBridgeOut,
			psConnection);

	CopyToUserWrapper(...);
	return err;
}
```

各 bridge group 由自动生成的 server bridge 注册。例如 SRVCORE 的 connect：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/generated/volcanic/srvcore_bridge/server_srvcore_bridge.c
static IMG_INT PVRSRVBridgeConnect(...)
{
	PVRSRV_BRIDGE_IN_CONNECT *psConnectIN = ...;
	PVRSRV_BRIDGE_OUT_CONNECT *psConnectOUT = ...;

	psConnectOUT->eError =
		PVRSRVConnectKM(psConnection, OSGetDevNode(psConnection),
				psConnectIN->ui32Flags,
				psConnectIN->ui32ClientBuildOptions,
				psConnectIN->ui32ClientDDKVersion,
				psConnectIN->ui32ClientDDKBuild,
				&psConnectOUT->ui8KernelArch,
				&psConnectOUT->ui32CapabilityFlags,
				&psConnectOUT->ui64PackedBvnc);

	return 0;
}

PVRSRV_ERROR InitSRVCOREBridge(void)
{
	SetDispatchTableEntry(PVRSRV_BRIDGE_SRVCORE,
			      PVRSRV_BRIDGE_SRVCORE_CONNECT,
			      PVRSRVBridgeConnect,
			      NULL,
			      sizeof(PVRSRV_BRIDGE_IN_CONNECT),
			      sizeof(PVRSRV_BRIDGE_OUT_CONNECT));
	...
}
```

RGX render 提交也是同一套机制，例如 TA3D kick：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/generated/volcanic/rgxta3d_bridge/server_rgxta3d_bridge.c
SetDispatchTableEntry(PVRSRV_BRIDGE_RGXTA3D,
		      PVRSRV_BRIDGE_RGXTA3D_RGXKICKTA3D2,
		      PVRSRVBridgeRGXKickTA3D2,
		      NULL,
		      sizeof(PVRSRV_BRIDGE_IN_RGXKICKTA3D2),
		      sizeof(PVRSRV_BRIDGE_OUT_RGXKICKTA3D2));
```

## 7. 标准 DRM/KMS 路径

PVR 自己注册了一个 DRM driver，但它的重点是 render、GEM/PRIME、private ioctl：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_drm.c
const struct drm_driver pvr_drm_generic_driver = {
	.driver_features = DRIVER_MODESET | DRIVER_RENDER |
			   DRIVER_GEM | PVR_DRM_DRIVER_PRIME,

	.open      = pvr_drm_open,
	.postclose = pvr_drm_release,

	.ioctls    = pvr_drm_ioctls,
	.num_ioctls = ARRAY_SIZE(pvr_drm_ioctls),
	.fops      = &pvr_drm_fops,
	.name      = PVR_DRM_DRIVER_NAME,
};
```

注意：这里有 `DRIVER_MODESET`，但当前 `pvr_drm.c` 只看到 `drm_mode_config_init(ddev)`，没有创建 Allwinner 显示所需的 CRTC、plane、encoder、connector，也没有 atomic commit 到 DE 的代码。因此不能因为 `DRIVER_MODESET` 就认为 PVR DRM driver 是实际显示 owner。

真正 scanout owner 是 `sunxi-drm`：

```c
// bsp/drivers/drm/sunxi_drm_drv.c
static struct drm_driver sunxi_drm_driver = {
	.driver_features = DRIVER_MODESET | DRIVER_GEM | DRIVER_ATOMIC,
	.fops            = &sunxi_drm_driver_fops,
	.ioctls          = sunxi_drm_ioctls,
	.num_ioctls      = ARRAY_SIZE(sunxi_drm_ioctls),
	.name            = DRIVER_NAME,
	.gem_create_object = sunxi_gem_create_object,
};
```

`sunxi-drm` 初始化标准 DRM/KMS 对象并注册 DRM 设备：

```c
// bsp/drivers/drm/sunxi_drm_drv.c
ret = drmm_mode_config_init(drm);
if (ret)
	return ret;

sunxi_drm_mode_config_init(drm);
sunxi_drm_property_create(private);

ret = component_bind_all(dev, drm);
if (ret)
	goto mode_config_clean;

dev_set_drvdata(dev, drm);
drm_mode_config_reset(drm);
drm_kms_helper_poll_init(drm);

commit_init_connecting(drm);

ret = drm_dev_register(drm, 0);
```

DRM atomic commit 最终进 sunxi CRTC / DE：

```c
// bsp/drivers/drm/sunxi_drm_crtc.c
static void sunxi_crtc_atomic_flush(struct drm_crtc *crtc,
				    struct drm_atomic_state *state)
{
	struct sunxi_drm_crtc *scrtc = to_sunxi_crtc(crtc);
	struct sunxi_crtc_state *scrtc_state = to_sunxi_crtc_state(crtc->state);
	struct sunxi_de_flush_cfg cfg;
	void *backend_data;

	backend_data = scrtc_state->backend_blob ?
		scrtc_state->backend_blob->data : NULL;

	sunxi_de_atomic_flush(scrtc->sunxi_de, backend_data, &cfg);
	if (scrtc_state->atomic_flush)
		scrtc_state->atomic_flush(scrtc_state->output_dev_data);
}
```

因此标准 DRM/KMS 路径可以画成：

```text
App / EGL / GLES / Vulkan
  -> IMG PVR userspace
  -> /dev/dri/renderD* 或 PVR DRM 节点
  -> DRM_IOCTL_PVR_SRVKM_CMD
  -> PVRSRV_BridgeDispatchKM()
  -> RGX render / MM / PMR / sync
  -> PVR GEM/PRIME/dma-buf export
  -> userspace compositor / KMS client
  -> /dev/dri/cardX(sunxi-drm)
  -> PRIME import / AddFB2 / atomic commit
  -> sunxi plane / crtc / connector
  -> DE / TCON / HDMI / DSI / LVDS / eDP
```

## 8. Display Class / dc_sunxi fbdev 路径

如果启用 `SUPPORT_DISPLAY_CLASS`，`ServerBridgeInit()` 会注册 DC bridge：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/common/pvrsrv_bridge_init.c
#if defined(SUPPORT_DISPLAY_CLASS)
PVRSRV_ERROR InitDCBridge(void);
void DeinitDCBridge(void);
#endif

PVRSRV_ERROR ServerBridgeInit(void)
{
	...
#if defined(SUPPORT_DISPLAY_CLASS)
	eError = InitDCBridge();
	PVR_LOG_IF_ERROR(eError, "InitDCBridge");
#endif
	...
}
```

DC bridge 自动生成代码注册一组 Display Class 操作：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/generated/volcanic/dc_bridge/server_dc_bridge.c
SetDispatchTableEntry(PVRSRV_BRIDGE_DC,
		      PVRSRV_BRIDGE_DC_DCDEVICESQUERYCOUNT,
		      PVRSRVBridgeDCDevicesQueryCount,
		      pDCBridgeLock,
		      0,
		      sizeof(PVRSRV_BRIDGE_OUT_DCDEVICESQUERYCOUNT));

SetDispatchTableEntry(PVRSRV_BRIDGE_DC,
		      PVRSRV_BRIDGE_DC_DCDEVICEACQUIRE,
		      PVRSRVBridgeDCDeviceAcquire,
		      pDCBridgeLock,
		      sizeof(PVRSRV_BRIDGE_IN_DCDEVICEACQUIRE),
		      sizeof(PVRSRV_BRIDGE_OUT_DCDEVICEACQUIRE));

SetDispatchTableEntry(PVRSRV_BRIDGE_DC,
		      PVRSRV_BRIDGE_DC_DCBUFFERALLOC,
		      PVRSRVBridgeDCBufferAlloc,
		      pDCBridgeLock,
		      sizeof(PVRSRV_BRIDGE_IN_DCBUFFERALLOC),
		      sizeof(PVRSRV_BRIDGE_OUT_DCBUFFERALLOC));

SetDispatchTableEntry(PVRSRV_BRIDGE_DC,
		      PVRSRV_BRIDGE_DC_DCDISPLAYCONTEXTCONFIGURE2,
		      PVRSRVBridgeDCDisplayContextConfigure2,
		      pDCBridgeLock,
		      sizeof(PVRSRV_BRIDGE_IN_DCDISPLAYCONTEXTCONFIGURE2),
		      sizeof(PVRSRV_BRIDGE_OUT_DCDISPLAYCONTEXTCONFIGURE2));
```

DC server 自己不绑定 fbdev 或 DRM。它只维护一个 `DC_DEVICE`，里面保存后端函数表：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/common/dc_server.c
struct _DC_DEVICE_
{
	PVRSRV_DEVICE_NODE          *psDevNode;
	const DC_DEVICE_FUNCTIONS   *psFuncTable;
	IMG_UINT32                  ui32MaxConfigsInFlight;
	IMG_HANDLE                  hDeviceData;
	IMG_UINT32                  ui32Index;
	IMG_HANDLE                  hSystemBuffer;
	PMR                         *psSystemBufferPMR;
	PHYS_HEAP                   *psPhysHeap;
	DC_DISPLAY_CONTEXT          sSystemContext;
	DLLIST_NODE                 sListNode;
};
```

这就是可插拔后端的核心：DC bridge 面向 `DC_DEVICE_FUNCTIONS` 编程。

## 9. `DCRegisterDevice()` 如何挂入 fbdev 后端

`dc_sunxi` 实际驱动名是 `dc_fbdev`，强依赖 Linux fbdev：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
#if (LINUX_VERSION_CODE >= KERNEL_VERSION(6, 1, 0))
#error dc_fbdev is not supported for Linux version 6.1.0 or later.
#endif

#if !defined(CONFIG_FB)
#error dc_fbdev needs Linux framebuffer support. Enable it in your kernel.
#endif

#define DRVNAME "dc_fbdev"
```

probe 时直接从 Linux framebuffer 全局表找 `/dev/fbX`：

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

然后定义一张 `DC_DEVICE_FUNCTIONS`，把 fbdev 操作包装成 PVR Display Class 后端：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
static DC_DEVICE_FUNCTIONS sDCFunctions =
{
	.pfnGetInfo              = DC_FBDEV_GetInfo,
	.pfnPanelQueryCount      = DC_FBDEV_PanelQueryCount,
	.pfnPanelQuery           = DC_FBDEV_PanelQuery,
	.pfnFormatQuery          = DC_FBDEV_FormatQuery,
	.pfnDimQuery             = DC_FBDEV_DimQuery,
	.pfnSetBlank             = NULL,
	.pfnSetVSyncReporting    = NULL,
	.pfnLastVSyncQuery       = NULL,
	.pfnContextCreate        = DC_FBDEV_ContextCreate,
	.pfnContextDestroy       = DC_FBDEV_ContextDestroy,
	.pfnContextConfigure     = DC_FBDEV_ContextConfigure,
	.pfnContextConfigureCheck = DC_FBDEV_ContextConfigureCheck,
	.pfnBufferAlloc          = DC_FBDEV_BufferAlloc,
	.pfnBufferAcquire        = DC_FBDEV_BufferAcquire,
	.pfnBufferRelease        = DC_FBDEV_BufferRelease,
	.pfnBufferFree           = DC_FBDEV_BufferFree,
};

if (DCRegisterDevice(&sDCFunctions,
		     MAX_COMMANDS_IN_FLIGHT,
		     gpsDeviceData,
		     &gpsDeviceData->hSrvHandle) != PVRSRV_OK)
	goto err_kfree;
```

`DCRegisterDevice()` 把这张函数表注册进 PVR DC device list：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/common/dc_server.c
PVRSRV_ERROR DCRegisterDevice(DC_DEVICE_FUNCTIONS *psFuncTable,
			      IMG_UINT32 ui32MaxConfigsInFlight,
			      IMG_HANDLE hDeviceData,
			      IMG_HANDLE *phSrvHandle)
{
	DC_DEVICE *psNew;
	PVRSRV_ERROR eError;

	psNew = OSAllocMem(sizeof(DC_DEVICE));
	PVR_GOTO_IF_NOMEM(psNew, eError, FailAlloc);

	psNew->psDevNode = PVRSRVGetDeviceInstance(g_ui32DCDeviceCount);
	psNew->psFuncTable = psFuncTable;
	psNew->ui32MaxConfigsInFlight = ui32MaxConfigsInFlight;
	psNew->hDeviceData = hDeviceData;
	psNew->ui32Index = g_ui32DCNextIndex++;

	eError = PhysHeapAcquireByID(PVRSRV_PHYS_HEAP_DISPLAY,
				     psNew->psDevNode,
				     &psNew->psPhysHeap);
	if (eError == PVRSRV_ERROR_PHYSHEAP_ID_INVALID) {
		eError = PhysHeapAcquireByID(PVRSRV_PHYS_HEAP_GPU_LOCAL,
					     psNew->psDevNode,
					     &psNew->psPhysHeap);
	}

	OSLockAcquire(g_hDCDevListLock);
	dllist_add_to_tail(&g_sDCDeviceListHead, &psNew->sListNode);
	OSLockRelease(g_hDCDevListLock);

	g_ui32DCDeviceCount++;
	*phSrvHandle = (IMG_HANDLE) psNew;

	return PVRSRV_OK;
}
```

后续用户态通过 DC bridge 找设备时，查的是这个 DC device list：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/common/dc_server.c
PVRSRV_ERROR DCDeviceAcquire(CONNECTION_DATA *psConnection,
			     PVRSRV_DEVICE_NODE *psDevNode,
			     IMG_UINT32 ui32DeviceIndex,
			     DC_DEVICE **ppsDevice)
{
	dllist_foreach_node(&g_sDCDeviceListHead, psNode, psNext)
	{
		psDevice = IMG_CONTAINER_OF(psNode, DC_DEVICE, sListNode);
		if ((psDevice->ui32Index == ui32DeviceIndex) &&
		    (psDevice->psDevNode == psDevNode))
		{
			bFound = IMG_TRUE;
			eError = PVRSRV_OK;
			break;
		}
	}

	if (bFound) {
		_DCDeviceAcquireRef(psDevice);
		*ppsDevice = psDevice;
	}

	return eError;
}
```

## 10. fbdev buffer 如何包装给 GPU 渲染

PVR DC server 通过 `DCBufferAlloc()` 请求后端分配 buffer，然后把后端 buffer 包装成 PMR：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/common/dc_server.c
PVRSRV_ERROR DCBufferAlloc(DC_DISPLAY_CONTEXT *psDisplayContext,
			   DC_BUFFER_CREATE_INFO *psSurfInfo,
			   IMG_UINT32 *pui32ByteStride,
			   DC_BUFFER **ppsBuffer)
{
	DC_DEVICE *psDevice = psDisplayContext->psDevice;
	DC_BUFFER *psNew;
	PMR *psPMR;
	IMG_DEVMEM_LOG2ALIGN_T uiLog2PageSize;
	IMG_UINT32 ui32PageCount;

	eError = psDevice->psFuncTable->pfnBufferAlloc(
			psDisplayContext->hDisplayContext,
			psSurfInfo,
			&uiLog2PageSize,
			&ui32PageCount,
			pui32ByteStride,
			&psNew->hBuffer);
	...

	eError = _DCCreatePMR(uiLog2PageSize,
			      ui32PageCount,
			      psDevice->psPhysHeap,
			      psNew,
			      &psPMR,
			      IMG_FALSE,
			      pszRIText);
	...
	psNew->uBufferData.sAllocData.psPMR = psPMR;
	*ppsBuffer = psNew;
	return PVRSRV_OK;
}
```

`dc_sunxi` 的 buffer 分配不是重新申请 DRM framebuffer，而是在 fbdev 显存里分配一个 buffer slot：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
static PVRSRV_ERROR DC_FBDEV_BufferAlloc(IMG_HANDLE hDisplayContext,
					 DC_BUFFER_CREATE_INFO *psCreateInfo,
					 IMG_DEVMEM_LOG2ALIGN_T *puiLog2PageSize,
					 IMG_UINT32 *pui32PageCount,
					 IMG_UINT32 *pui32ByteStride,
					 IMG_HANDLE *phBuffer)
{
	DC_FBDEV_CONTEXT *psDeviceContext = hDisplayContext;
	DC_FBDEV_BUFFER *psBuffer;
	IMG_UINT32 ui32ByteSize;

	psBuffer = kmalloc(sizeof(DC_FBDEV_BUFFER), GFP_KERNEL);
	...
	psBuffer->psDeviceContext = psDeviceContext;
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
	*pui32PageCount  = BYTE_TO_PAGES(ui32ByteSize);
	*pui32ByteStride = psBuffer->ui32ByteStride;
	*phBuffer        = psBuffer;

	return PVRSRV_OK;
}
```

真正把 fbdev 显存地址交给 PVR PMR 的是 `DC_FBDEV_BufferAcquire()`：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
static PVRSRV_ERROR DC_FBDEV_BufferAcquire(IMG_HANDLE hBuffer,
					   IMG_DEV_PHYADDR *pasDevPAddr,
					   void **ppvLinAddr)
{
	DC_FBDEV_BUFFER *psBuffer = hBuffer;
	DC_FBDEV_DEVICE *psDeviceData = psBuffer->psDeviceContext->psDeviceData;
	IMG_UINT32 ui32ByteSize = psBuffer->ui32ByteStride * psBuffer->ui32Height;
	uintptr_t uiStartAddr;
	IMG_UINT32 i, ui32MaxLen;

#if defined(DC_FBDEV_USE_SCREEN_BASE)
	uiStartAddr = (uintptr_t)psDeviceData->psLINFBInfo->screen_base;
#else
	uiStartAddr = psDeviceData->psLINFBInfo->fix.smem_start;
#endif

	uiStartAddr += psBuffer->ui32BufferID * ui32ByteSize;
	ui32MaxLen = psDeviceData->psLINFBInfo->fix.smem_len -
		     psBuffer->ui32BufferID * ui32ByteSize;

	for (i = 0; i < BYTE_TO_PAGES(ui32ByteSize); i++)
	{
		BUG_ON(i * PAGE_SIZE >= ui32MaxLen);
		pasDevPAddr[i].uiAddr = uiStartAddr + (i * PAGE_SIZE);
	}

	*ppvLinAddr = NULL;
	return PVRSRV_OK;
}
```

这一层的意义是：PVR GPU 看到的是 PMR / device physical pages，底层实际对应的是 fbdev framebuffer memory。

## 11. fbdev 翻页如何发生

PVR DC bridge 的显示提交最终进入：

```text
PVRSRVBridgeDCDisplayContextConfigure2()
  -> DCDisplayContextConfigure()
  -> _DCDisplayContextConfigure()
  -> psDevice->psFuncTable->pfnContextConfigure()
  -> DC_FBDEV_ContextConfigure()
```

DC server 调后端函数表：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/common/dc_server.c
psDevice->psFuncTable->pfnContextConfigure(
	psDisplayContext->hDisplayContext,
	psReadyData->ui32BufferCount,
	psReadyData->pasSurfAttrib,
	psReadyData->pahBuffer,
	psReadyData->ui32DisplayPeriod,
	hCompleteData);
```

`dc_sunxi` 根据 buffer id 计算 `yoffset`，然后调用 fbdev：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
static void DC_FBDEV_ContextConfigure(IMG_HANDLE hDisplayContext,
				      IMG_UINT32 ui32PipeCount,
				      PVRSRV_SURFACE_CONFIG_INFO *pasSurfAttrib,
				      IMG_HANDLE *ahBuffers,
				      IMG_UINT32 ui32DisplayPeriod,
				      IMG_HANDLE hConfigData)
{
	DC_FBDEV_CONTEXT *psDeviceContext = hDisplayContext;
	DC_FBDEV_DEVICE *psDeviceData = psDeviceContext->psDeviceData;
	struct fb_var_screeninfo sVar = psDeviceData->psLINFBInfo->var;
	int err;

	sVar.yoffset = 0;

	if (ui32PipeCount != 0) {
		if (psDeviceData->bCanFlip) {
			DC_FBDEV_BUFFER *psBuffer = ahBuffers[0];
			sVar.yoffset = sVar.yres * psBuffer->ui32BufferID;
		}
	}

	lock_fb_info(psDeviceData->psLINFBInfo);
	console_lock();

	if (psDeviceData->bCanFlip &&
	    sVar.yres_virtual < sVar.yres * NUM_PREFERRED_BUFFERS) {
		sVar.activate = FB_ACTIVATE_NOW;
		sVar.yres_virtual = sVar.yres * NUM_PREFERRED_BUFFERS;

		err = fb_set_var(psDeviceData->psLINFBInfo, &sVar);
		if (err)
			pr_err("fb_set_var failed (err=%d)\n", err);
	} else {
		err = fb_pan_display(psDeviceData->psLINFBInfo, &sVar);
		if (err)
			pr_err("fb_pan_display failed (err=%d)\n", err);
	}

	console_unlock();
	unlock_fb_info(psDeviceData->psLINFBInfo);

	if (psDeviceContext->hLastConfigData)
		DCDisplayConfigurationRetired(psDeviceContext->hLastConfigData);

	...
}
```

sunxi fbdev 层的 `fb_pan_display` 再进入 disp 更新：

```c
// bsp/drivers/video/sunxi/disp2/disp/fb_core.c
int sunxi_fb_pan_display(struct fb_var_screeninfo *var,
			 struct fb_info *info)
{
	fb_debug_inf("fb %d pan display start update\n", info->node);
	platform_update_fb_output(info->par, var);
	fb_debug_inf("fb %d pan display update ok\n", info->node);

	if (var->reserved[0] == FB_ACTIVATE_FORCE)
		return 0;

	platform_fb_pan_display_post_proc(info->par);
	fb_debug_inf("fb %d pan display ok\n", info->node);
	return 0;
}

static struct fb_ops dispfb_ops = {
	.owner          = THIS_MODULE,
	.fb_open        = sunxi_fb_open,
	.fb_release     = sunxi_fb_release,
	.fb_pan_display = sunxi_fb_pan_display,
	.fb_ioctl       = sunxi_fb_ioctl,
	.fb_check_var   = sunxi_fb_check_var,
	.fb_set_par     = sunxi_fb_set_par,
	.fb_blank       = sunxi_fb_blank,
};
```

如果走 `/dev/disp`，则是 Allwinner 私有 ioctl，不是 DRM ioctl：

```c
// bsp/drivers/video/sunxi/disp2/disp/dev_disp.c
static long disp_ioctl(struct file *file, unsigned int cmd,
		       unsigned long arg)
{
	unsigned long arg64[4] = {0};

	if (copy_from_user((void *)arg64,
			   (void __user *)arg,
			   4 * sizeof(unsigned long))) {
		DE_WARN("copy_from_user fail\n");
		return -EFAULT;
	}

	return disp_ioctl_inner(file, cmd, (unsigned long)arg64);
}

static const struct file_operations disp_fops = {
	.owner          = THIS_MODULE,
	.open           = disp_open,
	.release        = disp_release,
	.write          = disp_write,
	.read           = disp_read,
	.unlocked_ioctl = disp_ioctl,
	.compat_ioctl   = disp_compat_ioctl,
	.mmap           = disp_mmap,
};
```

因此 fbdev/DC 路径完整链路是：

```text
App / EGL / GLES
  -> IMG PVR userspace
  -> DRM_IOCTL_PVR_SRVKM_CMD
  -> PVRSRV_BridgeDispatchKM()
  -> DC bridge
  -> DC server generic Display Class
  -> dc_sunxi / dc_fbdev
  -> registered_fb[fb_devminor]
  -> fb_pan_display() / fb_set_var()
  -> sunxi fbdev
  -> disp2 / DE / TCON
```

## 12. 为什么同一套 PVR 能切两种显示后端

关键不是 “PVR DRM driver 同时完整实现 KMS 和 fbdev”，而是 PVR 把 GPU 服务和显示输出抽象拆开了。

标准 DRM/KMS 路径：

```text
PVR Services:
  bridge / RGX render / PMR / sync / dma-buf

sunxi-drm:
  KMS object / AddFB2 / atomic commit / DE scanout
```

旧 fbdev/DC 路径：

```text
PVR Services:
  bridge / RGX render / PMR / sync / Display Class

dc_sunxi:
  DC_DEVICE_FUNCTIONS backend / fbdev framebuffer memory / fb_pan_display
```

这套设计的复用点有三个：

1. **同一个 ioctl transport**  
   用户态都可以通过 `DRM_IOCTL_PVR_SRVKM_CMD` 进入 PVR bridge。区别只是 `bridge_id` 和 `bridge_func_id` 指向 RGX/MM/DMABUF，还是 DC。

2. **同一个 Services 对象模型**  
   `PVRSRV_DEVICE_NODE`、`CONNECTION_DATA`、handle base、PMR、sync server 都复用。

3. **显示后端通过函数表插拔**  
   DC server 只认识 `DC_DEVICE_FUNCTIONS`，不关心后端是 fbdev 还是别的显示控制器。`dc_sunxi` 用 `DCRegisterDevice()` 把 fbdev 包装成一个 DC device。

## 13. 需要避免的误解

### 13.1 `PVRSRVCommonDeviceCreate()` 不是 ioctl 分发进程

它创建的是内核对象，不是进程：

```text
PVRSRVCommonDeviceCreate()
  -> allocate PVRSRV_DEVICE_NODE
  -> SysDevInit()
  -> PhysHeapInitDeviceHeaps()
  -> RGXRegisterDevice()
  -> SyncServerInit()
  -> Debug/DVFS/AppHint
  -> insert device list
```

ioctl 分发发生在：

```text
drm_ioctl()
  -> pvr_drm_ioctls[]
  -> PVRSRV_BridgeDispatchKM()
  -> BridgedDispatchKM()
```

### 13.2 PVR 申请 `DRIVER_MODESET` 不等于它是实际 KMS owner

`pvr_drm.c` 里没有 Allwinner plane/crtc/connector 创建，也没有 DE atomic commit。实际 KMS owner 是 `bsp/drivers/drm/sunxi_drm_drv.c`。

### 13.3 `sunxi-drm` 自己也有 fbdev compatibility，但它不是 `dc_sunxi`

`bsp/drivers/drm/sunxi_fbdev_core.c` 是 `sunxi-drm` 内部的 fbdev 兼容层：

```c
// bsp/drivers/drm/sunxi_fbdev_core.c
int sunxi_fbdev_init(struct drm_device *drm,
		     struct display_channel_state *out_state)
{
	int ret;

	ret = fb_config_init(drm, &create_info);
	if (ret)
		goto OUT;
	ret = fb_core_init(&create_info, out_state);
OUT:
	return ret;
}
```

这和 PVR 旧 Display Class 后端 `dc_sunxi.ko` 不是同一个东西。

## 14. 一句话总结

PVR Services 的核心是一个内核 GPU 服务框架：它用 DRM private ioctl 作为 Linux transport，用 bridge dispatch table 作为 ABI 分发层，用 `PVRSRV_DEVICE_NODE` / `CONNECTION_DATA` / PMR / sync 作为资源模型。标准 DRM/KMS 模式下，PVR 只负责 render 和 buffer export，sunxi-drm 负责 scanout；旧 fbdev 模式下，PVR 启用 Display Class，`dc_sunxi` 通过 `DCRegisterDevice()` 把 fbdev 注册成一个 DC 后端，PVR DC bridge 最终调用 `fb_pan_display()` 完成显示。
