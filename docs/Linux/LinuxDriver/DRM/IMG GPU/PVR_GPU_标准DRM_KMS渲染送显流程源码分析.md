# PVR GPU 标准 DRM/KMS 渲染送显流程源码分析

本文参考当前目录下已有文档继续整理：

- `DRM_PVR_dc_sunxi_整理说明.md`
- `IMG_PVR_GPU_DRM_对话总结.md`
- `PVR_dc_sunxi_渲染送显流程源码分析.md`

涉及源码目录：

- DISP/fbdev 驱动：`bsp/drivers/video/sunxi`
- DRM/KMS 驱动：`bsp/drivers/drm`
- IMG PVR/BXM GPU 驱动：`bsp/modules/gpu/img-bxm`

本文重点分析 **PVR GPU 使用标准 DRM/KMS 作为显示输出** 时的渲染送显流程。它与旧 `dc_sunxi` 路径最大的区别是：

```text
旧 dc_sunxi：
  PVR Display Class 直接对接 fbdev/disp2，present 时走 fb_pan_display()

标准 DRM/KMS：
  PVR 只负责 GPU render / buffer / fence / dma-buf
  sunxi-drm 负责 plane / crtc / encoder / connector / atomic commit / DE scanout
```

也就是说，标准 KMS 路径里 **显示 owner 是 `sunxi-drm`，不是 PVR 的 `dc_sunxi`**。

## 1. 总体结论

标准 DRM/KMS 路径的核心链路是：

```text
App / EGL / GLES / Vulkan
  -> IMG PVR 用户态库
  -> /dev/dri/renderD* 或 PVR card 节点
  -> DRM_IOCTL_PVR_SRVKM_CMD
  -> PVRSRV_BridgeDispatchKM()
  -> RGX render bridge，例如 RGXKickTA3D2
  -> RGX firmware / GPU 硬件渲染
  -> 渲染结果落到 PVR PMR / GEM / dma-buf backing memory
  -> PVR 导出 dma-buf fd 或 GEM handle
  -> 用户态 compositor / KMS client
  -> sunxi-drm PRIME fd_to_handle 导入 dma-buf
  -> DRM_IOCTL_MODE_ADDFB2 创建 drm_framebuffer
  -> DRM_IOCTL_MODE_ATOMIC 设置 FB_ID / CRTC_ID / SRC / CRTC 坐标
  -> sunxi plane atomic_update
  -> sunxi_de_channel_update()
  -> channel_apply()
  -> DE overlay / scaler / blender / frontend 配置
  -> CRTC atomic_flush
  -> sunxi_de_atomic_flush()
  -> TCON / DSI / HDMI / RGB / LVDS / eDP
  -> Panel / Monitor
```

简化成一句话：

```text
PVR GPU 负责把图像画到共享 buffer；
标准 DRM/KMS 由 sunxi-drm 把这个 buffer 作为 plane framebuffer 扫描输出。
```

这条路径不会经过：

```text
PVR Display Class
  -> dc_sunxi
  -> registered_fb[]
  -> fb_pan_display()
```

## 2. 当前 BXM 默认配置更接近标准 KMS 路径

当前 BXM 构建配置不是旧 `dc_sunxi`，而是 `nulldrmws`：

```make
# bsp/modules/gpu/img-bxm/linux/rogue_km/build/linux/sunxi_linux/Makefile
WINDOW_SYSTEM := nulldrmws
PVR_SYSTEM := rgx_sunxi
KERNEL_COMPONENTS := srvkm

#DISPLAY_CONTROLLER := dc_sunxi
#KERNEL_COMPONENTS += $(DISPLAY_CONTROLLER)
```

窗口系统配置里明确关闭 Display Class，打开 KMS：

```make
# bsp/modules/gpu/img-bxm/linux/rogue_km/build/linux/config/window_system.mk
else ifeq ($(WINDOW_SYSTEM),nulldrmws)
 SUPPORT_VK_PLATFORMS := null
 SUPPORT_DISPLAY_CLASS := 0
 SUPPORT_NATIVE_FENCE_SYNC := 1
 SUPPORT_KMS := 1
 override PVRSRV_WRAP_EXTMEM_WRITE_ATTRIB_ENABLE := 0
```

这说明当前默认形态不是：

```text
PVR DC -> dc_sunxi -> fbdev/disp
```

而是：

```text
PVR render + dma-buf/sync
sunxi-drm KMS scanout
```

## 3. PVR DRM 节点负责 GPU 服务入口

PVR 内核模块注册 DRM driver，但这里主要承担 render node、GEM/PRIME、private ioctl、mmap、poll 等 GPU 服务入口。

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
	.owner			= THIS_MODULE,
	.open			= drm_open,
	.release		= drm_release,
	.unlocked_ioctl		= drm_ioctl,
	.mmap			= PVRSRV_MMap,
	.poll			= drm_poll,
	.read			= drm_read,
};

const struct drm_driver pvr_drm_generic_driver = {
	.driver_features	= DRIVER_MODESET | DRIVER_RENDER |
				  DRIVER_GEM | PVR_DRM_DRIVER_PRIME,
	.open			= pvr_drm_open,
	.postclose		= pvr_drm_release,
	.prime_handle_to_fd	= drm_gem_prime_handle_to_fd,
	.ioctls			= pvr_drm_ioctls,
	.num_ioctls		= ARRAY_SIZE(pvr_drm_ioctls),
	.fops			= &pvr_drm_fops,
	.name			= PVR_DRM_DRIVER_NAME,
};
```

注意：这里出现 `DRIVER_MODESET` 不等于 PVR 自己实现了 sunxi 的 plane/crtc/connector。PVR 侧没有创建 Allwinner DE 对应的 KMS 对象；真正的 KMS 对象在 `bsp/drivers/drm`。

PVR 用户态库通过 private ioctl 进入 PVR bridge：

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

#define	DRM_IOCTL_PVR_SRVKM_CMD	\
	DRM_IOWR(DRM_COMMAND_BASE + DRM_PVR_SRVKM_CMD, \
		 struct drm_pvr_srvkm_cmd)
```

内核分发入口：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_bridge_k.c
int
PVRSRV_BridgeDispatchKM(struct drm_device *dev, void *arg, struct drm_file *pDRMFile)
{
	struct drm_pvr_srvkm_cmd *psSrvkmCmd = (struct drm_pvr_srvkm_cmd *) arg;
	PVRSRV_BRIDGE_PACKAGE sBridgePackageKM = { 0 };
	CONNECTION_DATA *psConnection = LinuxServicesConnectionFromFile(pDRMFile->filp);
	PVRSRV_ERROR error;

	sBridgePackageKM.ui32BridgeID = psSrvkmCmd->bridge_id;
	sBridgePackageKM.ui32FunctionID = psSrvkmCmd->bridge_func_id;
	sBridgePackageKM.pvParamIn = (void __user *)(uintptr_t)psSrvkmCmd->in_data_ptr;
	sBridgePackageKM.ui32InBufferSize = psSrvkmCmd->in_data_size;
	sBridgePackageKM.pvParamOut = (void __user *)(uintptr_t)psSrvkmCmd->out_data_ptr;
	sBridgePackageKM.ui32OutBufferSize = psSrvkmCmd->out_data_size;

	error = BridgedDispatchKM(psConnection, &sBridgePackageKM);

	return OSPVRSRVToNativeError(error);
}
```

所以 PVR 用户态库看到的是：

```text
ioctl(DRM_IOCTL_PVR_SRVKM_CMD)
  -> bridge_id
  -> bridge_func_id
  -> generated server bridge
  -> services/server/*
```

## 4. GPU 渲染只产生 buffer 内容，不直接送显

典型 3D render bridge 是 `RGXKickTA3D2`：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/generated/rogue/rgxta3d_bridge/server_rgxta3d_bridge.c
SetDispatchTableEntry(PVRSRV_BRIDGE_RGXTA3D,
		      PVRSRV_BRIDGE_RGXTA3D_RGXKICKTA3D2,
		      PVRSRVBridgeRGXKickTA3D2,
		      NULL,
		      sizeof(PVRSRV_BRIDGE_IN_RGXKICKTA3D2),
		      sizeof(PVRSRV_BRIDGE_OUT_RGXKICKTA3D2));
```

bridge 解析 render context、sync primitive、HWRT dataset、ZS/MSAA buffer、TA/3D command 后，进入 RGX server：

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
			    ...
			    psRGXKickTA3D2IN->ui32TACmdSize,
			    ui8TACmdInt,
			    psRGXKickTA3D2IN->ui323DPRCmdSize,
			    ui83DPRCmdInt,
			    psRGXKickTA3D2IN->ui323DCmdSize,
			    ui83DCmdInt,
			    ...);
```

这里的 `RGXKickTA3D2` 仍然只是 GPU 提交。它关心的是：

- render context
- TA/3D command
- render target 的 GPU 虚拟地址
- sync/fence/update
- PMR 依赖

它不关心：

- 当前屏幕分辨率
- plane/crtc/connector
- DSI/HDMI/RGB/LVDS/eDP
- TCON 或 DE scanout 时序

因此在标准 DRM/KMS 中，渲染完成后还必须有一个 **buffer 共享和 KMS commit** 阶段。也就是把 GPU 画好的 buffer 交给 `sunxi-drm` 当 framebuffer。

## 5. PVR 通过 dma-buf / GEM 把渲染结果交给显示侧

PVR 内部用 PMR 管理物理内存。要让 `sunxi-drm` 扫描这块内存，需要把 PMR 包装成 Linux 标准的 dma-buf 或 DRM GEM 对象。

### 5.1 PMR 导出为 dma-buf fd

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/physmem_dmabuf.c
PVRSRV_ERROR
PhysmemExportDmaBuf(CONNECTION_DATA *psConnection,
                    PVRSRV_DEVICE_NODE *psDevNode,
                    PMR *psPMR,
                    IMG_INT *piFd)
{
	PMR_DMA_BUF_WRAPPER *psPMRWrapper;
	struct dma_buf *psDmaBuf;
	IMG_INT iFd;

	eError = PhysmemGetOrCreatePMRWrapper(psPMR, &psPMRWrapper);
	PMRRefPMR(psPMR);

	DEFINE_DMA_BUF_EXPORT_INFO(sDmaBufExportInfo);

	sDmaBufExportInfo.priv  = psPMRWrapper;
	sDmaBufExportInfo.ops   = &sPVRDmaBufOps;
	sDmaBufExportInfo.size  = PMR_LogicalSize(psPMR);
	sDmaBufExportInfo.flags = O_RDWR;
	sDmaBufExportInfo.resv  = &psPMRWrapper->sDmaResv;

	psDmaBuf = dma_buf_export(&sDmaBufExportInfo);

	iFd = dma_buf_fd(psDmaBuf, O_RDWR);
	*piFd = iFd;

	return PVRSRV_OK;
}
```

这一步得到的是标准 Linux dma-buf fd。用户态 compositor 可以把这个 fd 传给 KMS 设备，也就是 `sunxi-drm`。

### 5.2 PMR 导出为 PVR GEM handle

PVR 也可以把 PMR 包成 DRM GEM object，然后创建 GEM handle：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/physmem_dmabuf.c
PVRSRV_ERROR
PhysmemExportGemHandle(CONNECTION_DATA *psConnection,
		       PVRSRV_DEVICE_NODE *psDevNode,
		       PMR *psPMR,
		       IMG_UINT32 *puHandle)
{
	struct drm_device *psDRMDev = dev_get_drvdata(psDev);
	struct drm_file *psDRMFile = OSGetDRMFile(psConnection);
	PMR_DMA_BUF_GEM_OBJ *psGEMObj;

	psGEMObj->sBase.funcs = &sPhysmemGEMObjFuncs;
	psGEMObj->psPMRWrapper = psPMRWrapper;

	PMRRefPMR(psPMR);

	drm_gem_private_object_init(psDRMDev, &psGEMObj->sBase,
	                            PMR_LogicalSize(psPMR));

	iErr = drm_gem_handle_create(psDRMFile, &psGEMObj->sBase, puHandle);

	drm_gem_object_put(&psGEMObj->sBase);

	return PVRSRV_OK;
}
```

这个 GEM object 的 `export` 回调仍然会导出 dma-buf：

```c
static const struct drm_gem_object_funcs sPhysmemGEMObjFuncs = {
	.export = PhysmemGEMPrimeExport,
	.free = PhysmemGEMObjectFree,
};
```

对应的 GEM PRIME export：

```c
struct dma_buf *
PhysmemGEMPrimeExport(struct drm_gem_object *psObj, int iFlags)
{
	PMR_DMA_BUF_GEM_OBJ *psGEMObj = TO_PMR_DMA_BUF_GEM_OBJ(psObj);
	PMR_DMA_BUF_WRAPPER *psPMRWrapper = psGEMObj->psPMRWrapper;
	DEFINE_DMA_BUF_EXPORT_INFO(sDmaBufExportInfo);

	sDmaBufExportInfo.priv  = psObj;
	sDmaBufExportInfo.ops   = &sPVRDmaBufOpsGEM;
	sDmaBufExportInfo.size  = PMR_LogicalSize(psPMRWrapper->psPMR);
	sDmaBufExportInfo.flags = iFlags;
	sDmaBufExportInfo.resv  = &psPMRWrapper->sDmaResv;

	return drm_gem_dmabuf_export(psObj->dev, &sDmaBufExportInfo);
}
```

### 5.3 PVR dma-buf ops 提供给其他设备 attach/map

`sunxi-drm` 导入 PVR dma-buf 后，会走 dma-buf attach/map 流程。PVR 给 dma-buf 提供的 ops 是：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/physmem_dmabuf.c
static const struct dma_buf_ops sPVRDmaBufOps =
{
	.attach        = PVRDmaBufOpsAttach,
	.map_dma_buf   = PVRDmaBufOpsMap,
	.unmap_dma_buf = PVRDmaBufOpsUnmap,
	.release       = PVRDmaBufOpsRelease,
	.begin_cpu_access = PVRDmaBufOpsBeginCpuAccess,
	.end_cpu_access   = PVRDmaBufOpsEndCpuAccess,
	.mmap          = PVRDmaBufOpsMMap,
	.vmap          = PVRDmaBufOpsVMap,
	.vunmap        = PVRDmaBufOpsVUnMap,
};

static const struct dma_buf_ops sPVRDmaBufOpsGEM =
{
	.attach        = PVRDmaBufOpsAttachGEM,
	.map_dma_buf   = PVRDmaBufOpsMapGEM,
	.unmap_dma_buf = PVRDmaBufOpsUnmapGEM,
	.release       = drm_gem_dmabuf_release,
	.begin_cpu_access = PVRDmaBufOpsBeginCpuAccessGEM,
	.end_cpu_access   = PVRDmaBufOpsEndCpuAccessGEM,
	.mmap          = PVRDmaBufOpsMMapGEM,
	.vmap          = PVRDmaBufOpsVMapGEM,
	.vunmap        = PVRDmaBufOpsVUnMapGEM,
};
```

map 时根据 PMR 物理地址构造 scatterlist：

```c
static struct sg_table *PVRDmaBufOpsMapCommon(PMR_DMA_BUF_WRAPPER *psPMRWrapper,
                                              struct dma_buf_attachment *psAttachment,
                                              enum dma_data_direction eDirection)
{
	PMR *psPMR = psPMRWrapper->psPMR;
	struct sg_table *psTable;
	struct scatterlist *psSg;

	PMRLockSysPhysAddresses(psPMR);
	PMR_SetLayoutFixed(psPMR, IMG_TRUE);

	PMR_DevPhysAddr(psPMR,
	                 uiDevPageShift,
	                 uiNumVirtPages,
	                 0,
	                 psPAddr,
	                 pbValid,
	                 DEVICE_USE);

	sg_alloc_table(psTable, uiNents, GFP_KERNEL);

	sg_dma_address(psSg) = sPAddrPrev.uiAddr;
	sg_dma_len(psSg) = uiDevPageSize;

	psPMRWrapper->psTable = psTable;

	return psPMRWrapper->psTable;
}
```

所以从显示驱动角度看，PVR 渲染结果最终变成了一个普通 dma-buf：

```text
PVR PMR
  -> dma_buf_export()
  -> dma-buf fd
  -> sunxi-drm PRIME import
  -> drm_gem_object
  -> drm_framebuffer
  -> plane FB_ID
```

## 6. sunxi-drm 是真正的 KMS 显示驱动

`sunxi-drm` 注册的是 KMS display driver：

```c
// bsp/drivers/drm/sunxi_drm_drv.c
static struct drm_driver sunxi_drm_driver = {
	.driver_features = DRIVER_MODESET | DRIVER_GEM | DRIVER_ATOMIC,
	.fops = &sunxi_drm_driver_fops,
	.ioctls             = sunxi_drm_ioctls,
	.num_ioctls         = ARRAY_SIZE(sunxi_drm_ioctls),
	.name = DRIVER_NAME,
	.desc = DRIVER_DESC,
	.date = DRIVER_DATE,
	.major = DRIVER_MAJOR,
	.minor = DRIVER_MINOR,
	.gem_create_object = sunxi_gem_create_object,
	DRM_GEM_DMA_DRIVER_OPS_VMAP,
};
```

它的 mode_config 提供标准 KMS atomic commit 和 framebuffer 创建：

```c
// bsp/drivers/drm/sunxi_drm_drv.c
static const struct drm_mode_config_funcs sunxi_drm_mode_config_funcs = {
	.atomic_check = drm_atomic_helper_check,
	.atomic_commit = sunxi_drm_atomic_helper_commit,
	.fb_create = sunxi_drm_gem_fb_create,
};

struct drm_framebuffer *
sunxi_drm_gem_fb_create(struct drm_device *dev, struct drm_file *file,
			const struct drm_mode_fb_cmd2 *mode_cmd)
{
	return drm_gem_fb_create_with_funcs(dev, file, mode_cmd,
					    &sunxi_drm_gem_fb_funcs);
}
```

atomic commit tail 按 DRM helper 顺序执行：

```c
static void sunxi_drm_atomic_helper_commit_tail(struct drm_atomic_state *old_state)
{
	struct drm_device *dev = old_state->dev;

	drm_atomic_helper_commit_modeset_disables(dev, old_state);
	drm_atomic_helper_commit_modeset_enables(dev, old_state);
	drm_atomic_helper_commit_planes(dev, old_state, 0);
	drm_atomic_helper_fake_vblank(old_state);
	drm_atomic_helper_commit_hw_done(old_state);
	drm_atomic_helper_cleanup_planes(dev, old_state);
}
```

主设备 bind 时初始化 KMS 配置、绑定子组件、注册 DRM 设备：

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

	return 0;
}
```

这就是标准 KMS 对外提供 `/dev/dri/cardX`、plane/crtc/connector、AddFB2、atomic commit 的显示节点。

## 7. sunxi-drm 导入 dma-buf 后如何成为 framebuffer

用户态 compositor 通常做这几步：

```text
1. 从 PVR 得到 dma-buf fd
2. 对 sunxi-drm card 节点执行 DRM_IOCTL_PRIME_FD_TO_HANDLE
3. 得到 sunxi-drm GEM handle
4. 执行 DRM_IOCTL_MODE_ADDFB2
5. 得到 framebuffer id
6. atomic commit 把 framebuffer id 设置到某个 plane 的 FB_ID
```

`sunxi-drm` 的 GEM object 对 imported dma-buf 做了释放处理：

```c
// bsp/drivers/drm/sunxi_drm_gem.c
void sunxi_drm_prime_gem_destroy(struct drm_gem_object *obj,
				 struct sg_table *sg, enum dma_data_direction dir)
{
	struct dma_buf_attachment *attach;
	struct dma_buf *dma_buf;

	attach = obj->import_attach;
	if (sg)
		dma_buf_unmap_attachment_unlocked(attach, sg, dir);
	dma_buf = attach->dmabuf;
	dma_buf_detach(attach->dmabuf, attach);
	dma_buf_put(dma_buf);
}
```

GEM object 默认方向是 `DMA_TO_DEVICE`，也就是给显示硬件读取：

```c
// bsp/drivers/drm/sunxi_drm_gem.c
struct drm_gem_object *sunxi_gem_create_object(struct drm_device *dev, size_t size)
{
	struct sunxi_gem_object *sgem_obj;

	sgem_obj = kzalloc(sizeof(*sgem_obj), GFP_KERNEL);
	if (!sgem_obj)
		return ERR_PTR(-ENOMEM);

	/*
	 * set DMA_TO_DEVICE as default, and might be changed when dma-buf use as
	 * writeback output, to ensure cache coherence
	 */
	sgem_obj->dir = DMA_TO_DEVICE;
	sgem_obj->base.base.funcs = &sunxi_gem_funcs;

	return &sgem_obj->base.base;
}
```

AddFB2 之后，`drm_framebuffer` 里保存的 `fb->obj[]` 就是导入后的 GEM object。后续 plane 配置会通过 `fb->obj[]` 找到 DMA 地址，配置给 DE overlay/fbd/scaler 等硬件模块。

## 8. KMS plane 创建与 atomic_update

DE 的每个 display output 会创建一个 CRTC，并把 DE channel 映射成 DRM plane：

```c
// bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c
for (j = 0; j < display_out->ch_cnt; j++) {
	info.planes[j].name = display_out->ch_hdl[j]->name;
	info.planes[j].is_primary = j == 0;
	info.planes[j].index = j;
	info.planes[j].hdl = display_out->ch_hdl[j];
	info.planes[j].formats = display_out->ch_hdl[j]->formats;
	info.planes[j].format_count = display_out->ch_hdl[j]->format_count;
	info.planes[j].format_modifiers = display_out->ch_hdl[j]->format_modifiers_comb;
	info.planes[j].layer_cnt = display_out->ch_hdl[j]->layer_cnt;
}
display_out->scrtc = sunxi_drm_crtc_init_one(&info);
```

CRTC 初始化时，第一个 channel 作为 primary plane，其余 channel 作为 overlay plane：

```c
// bsp/drivers/drm/sunxi_drm_crtc.c
ret = sunxi_drm_plane_init(drm, scrtc, 0, &scrtc->plane[primary_index],
			   DRM_PLANE_TYPE_PRIMARY, info->hw_id,
			   plane);

drm_crtc_init_with_planes(drm, &scrtc->crtc,
			  &scrtc->plane[primary_index].plane, NULL,
			  &sunxi_crtc_funcs, "DE-%d", info->hw_id);

for (i = 0; i < info->plane_cnt; i++) {
	plane = &info->planes[i];
	if (plane->is_primary)
		continue;
	ret = sunxi_drm_plane_init(drm, scrtc, drm_crtc_mask(&scrtc->crtc),
			     &scrtc->plane[i], DRM_PLANE_TYPE_OVERLAY,
			     info->hw_id, plane);
}
```

plane 初始化使用标准 DRM universal plane：

```c
// bsp/drivers/drm/sunxi_drm_crtc.c
static int sunxi_drm_plane_init(struct drm_device *dev,
				struct sunxi_drm_crtc *scrtc,
				uint32_t possible_crtc,
				struct sunxi_drm_plane *plane, int type,
				unsigned int de_id, const struct sunxi_plane_info *info)
{
	plane->crtc = scrtc;
	plane->hdl = info->hdl;
	plane->index = info->index;
	plane->layer_cnt = info->layer_cnt;

	drm_universal_plane_init(dev, &plane->plane, possible_crtc,
				 &sunxi_plane_funcs, info->formats, info->format_count,
				 info->format_modifiers, type,
				 "plane-%d-%s(%d)", plane->index, info->name, de_id);

	drm_plane_helper_add(&plane->plane, &sunxi_plane_helper_funcs);
	sunxi_drm_plane_property_init(plane, scrtc->plane_cnt, info->afbc_rot_support);
	return 0;
}
```

plane helper 的核心是 `atomic_update`：

```c
// bsp/drivers/drm/sunxi_drm_crtc.c
static const struct drm_plane_helper_funcs sunxi_plane_helper_funcs = {
	.atomic_update = sunxi_plane_atomic_update,
	.atomic_async_check = sunxi_plane_atomic_async_check,
	.atomic_async_update = sunxi_plane_atomic_async_update,
};
```

实际 update 时，DRM plane state 被转换成 `display_channel_state`，然后交给 DE channel：

```c
// bsp/drivers/drm/sunxi_drm_crtc.c
static void sunxi_plane_atomic_update(struct drm_plane *plane,
				      struct drm_atomic_state *state)
{
	struct drm_plane_state *old_state = drm_atomic_get_old_plane_state(state, plane);
	struct display_channel_state *old_cstate = to_display_channel_state(old_state);
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

因此 KMS atomic commit 里设置的：

- `FB_ID`
- `CRTC_ID`
- `SRC_X/Y/W/H`
- `CRTC_X/Y/W/H`
- `zpos`
- `alpha`
- `rotation`
- `format modifier`

最终都会进入 `display_channel_state`，再转换成 DE 硬件配置。

## 9. DE channel 如何使用 framebuffer 配置硬件

`sunxi_de_channel_update()` 是 DRM plane 到 DE channel 的关键桥：

```c
// bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c
int sunxi_de_channel_update(struct sunxi_de_channel_update *info)
{
	struct sunxi_de_out *hwde = info->hwde;
	struct de_channel_handle *hdl = info->hdl;
	struct display_channel_state *new_state = info->new_state;
	struct display_channel_state *old_state = info->old_state;
	struct sunxi_display_engine *engine = dev_get_drvdata(hwde->dev);
	unsigned int old_zorder = old_state->base.normalized_zpos;
	unsigned int new_zorder = new_state->base.normalized_zpos;
	struct de_channel_output_info channel_out;
	struct de_output_info *output_info = &hwde->output_info;

	if (new_state->base.fb == NULL) {
		channel_apply(hdl, new_state, output_info, &channel_out,
			      engine->match_data->blending_in_rgb);
		de_bld_pipe_reset(hwde->bld_hdl, old_zorder, port_id);
		return 0;
	}

	channel_apply(hdl, new_state, output_info, &channel_out,
		      engine->match_data->blending_in_rgb);

	if (old_zorder != new_zorder)
		de_bld_pipe_reset(hwde->bld_hdl, old_zorder, port_id);

	de_bld_pipe_set_attr(hwde->bld_hdl, new_zorder, port_id,
			     &channel_out.disp_win, channel_out.is_premul);
	return 0;
}
```

`channel_apply()` 根据 framebuffer format、modifier、crop、scaler、alpha、color space 等信息配置 DE 子模块：

```c
// bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.c
int channel_apply(struct de_channel_handle *hdl, struct display_channel_state *state,
		    const struct de_output_info *de_info, struct de_channel_output_info *output,
		    bool rgb_out)
{
	struct de_ovl_cfg ovl_cfg;
	struct de_afbd_cfg afbd_cfg;
	struct de_tfbd_cfg tfbd_cfg;
	struct de_scaler_apply_cfg scaler_cfg;
	struct de_frontend_apply_cfg frontend_cfg;

	if (state->base.fb == NULL) {
		de_ovl_apply_lay(hdl->private->ovl, state, &ovl_cfg);
		de_scaler_apply(hdl->private->scaler, &scaler_cfg);
		de_frontend_disable(hdl->private->frontend);
		return 0;
	}

	cal_channel_enable_layer_cnt(hdl, state);
	de_rtmx_chn_data_attr(&hdl->private->info, state);
	de_rtmx_chn_blend_attr(&hdl->private->info, state, hdl->layer_cnt);
	de_rtmx_chn_calc_size(hdl, &hdl->private->info, state, hdl->layer_cnt);
	de_rtmx_chn_fix_size(hdl->private->scaler, &hdl->private->info,
			     de_info->width, de_info->height,
			     de_info->max_device_fps,
			     de_info->de_clk_freq,
			     de_info->htotal, de_info->pclk_khz);

	de_afbd_apply_lay(hdl->private->afbd, state, &afbd_cfg, &afbd_en);
	de_tfbd_apply_lay(hdl->private->tfbd, state, &tfbd_cfg, &tfbd_en);
	de_ovl_apply_lay(hdl->private->ovl, state, &ovl_cfg);
	de_scaler_apply(hdl->private->scaler, &scaler_cfg);
	de_frontend_apply(hdl->private->frontend, state, &frontend_cfg);

	drm_rect_init(&output->disp_win,
		      hdl->private->info.scn_win.left,
		      hdl->private->info.scn_win.top,
		      hdl->private->info.scn_win.width,
		      hdl->private->info.scn_win.height);
	return 0;
}
```

这里的 `state->base.fb` 就是 KMS plane 的 framebuffer。若这个 framebuffer 来自 PVR dma-buf，那么 DE 配置的就是 PVR 渲染结果对应的物理/DMA 地址。

## 10. CRTC atomic_flush 真正触发 DE 配置生效

plane update 只是把各个 channel 的新状态准备好。CRTC flush 阶段才会统一刷新到 DE：

```c
// bsp/drivers/drm/sunxi_drm_crtc.c
static const struct drm_crtc_helper_funcs sunxi_crtc_helper_funcs = {
	.atomic_enable = sunxi_crtc_atomic_enable,
	.atomic_disable = sunxi_crtc_atomic_disable,
	.atomic_check = sunxi_drm_crtc_atomic_check,
	.atomic_begin = sunxi_crtc_atomic_begin,
	.atomic_flush = sunxi_crtc_atomic_flush,
};
```

`sunxi_crtc_atomic_flush()` 中调用 `sunxi_de_atomic_flush()`：

```c
// bsp/drivers/drm/sunxi_drm_crtc.c
backend_data = scrtc_state->backend_blob ? scrtc_state->backend_blob->data : NULL;
sunxi_de_atomic_flush(scrtc->sunxi_de, backend_data, &cfg);

if (scrtc_state->atomic_flush)
	scrtc_state->atomic_flush(scrtc_state->output_dev_data);

sunxi_wb_commit_done(scrtc);
sunxi_crtc_finish_page_flip(crtc->dev, scrtc);
```

这一步可以理解为：

```text
atomic commit
  -> plane atomic_update: 填 channel/overlay/scaler/blender 配置
  -> crtc atomic_flush: 触发 DE 原子更新
  -> vblank/page flip event
```

## 11. encoder / connector 负责输出接口

以 DSI 为例，DSI 组件 bind 时创建 encoder 和 connector：

```c
// bsp/drivers/drm/sunxi_drm_dsi.c
static int sunxi_drm_dsi_bind(struct device *dev, struct device *master, void *data)
{
	struct sunxi_drm_dsi *dsi = dev_get_drvdata(dev);
	struct sunxi_drm_device *sdrm = &dsi->sdrm;
	struct drm_device *drm = (struct drm_device *)data;

	tcon_lcd_dev = drm_dsi_of_get_tcon(dsi->dev);
	tcon_id = sunxi_tcon_of_get_id(tcon_lcd_dev);

	sdrm->tcon_dev = tcon_lcd_dev;
	sdrm->tcon_id = tcon_id;
	sdrm->drm_dev = drm;

	drm_encoder_helper_add(&sdrm->encoder, &sunxi_dsi_encoder_helper_funcs);
	drm_simple_encoder_init(drm, &sdrm->encoder, DRM_MODE_ENCODER_DSI);

	sdrm->encoder.possible_crtcs =
		drm_of_find_possible_crtcs(drm, tcon_lcd_dev->of_node);

	drm_connector_helper_add(&sdrm->connector,
		&sunxi_dsi_connector_helper_funcs);

	drm_connector_init(drm, &sdrm->connector,
		&sunxi_dsi_connector_funcs,
		DRM_MODE_CONNECTOR_DSI);

	drm_connector_attach_encoder(&sdrm->connector, &sdrm->encoder);
	return 0;
}
```

encoder atomic enable 负责配置 TCON、DSI clock、PHY、panel：

```c
// bsp/drivers/drm/sunxi_drm_dsi.c
void sunxi_drm_dsi_encoder_atomic_enable(struct drm_encoder *encoder,
					struct drm_atomic_state *state)
{
	struct drm_crtc *crtc = encoder->crtc;
	int de_hw_id = sunxi_drm_crtc_get_hw_id(crtc);
	struct sunxi_drm_dsi *dsi = encoder_to_sunxi_drm_dsi(encoder);
	struct disp_output_config disp_cfg;

	drm_mode_to_sunxi_video_timings(&dsi->mode, &dsi->dsi_para.timings);

	memset(&disp_cfg, 0, sizeof(struct disp_output_config));
	memcpy(&disp_cfg.dsi_para, &dsi->dsi_para, sizeof(dsi->dsi_para));
	disp_cfg.type = INTERFACE_DSI;
	disp_cfg.de_id = de_hw_id;
	disp_cfg.irq_handler = sunxi_crtc_event_proc;
	disp_cfg.irq_data = scrtc_state->base.crtc;

	sunxi_tcon_mode_init(dsi->sdrm.tcon_dev, &disp_cfg);
	sunxi_dsi_clk_config_enable(dsi);
	sunxi_lcd_pin_set_state(dsi->dev, "active");
	phy_power_on(dsi->phy);
	phy_configure(dsi->phy, &dsi->phy_opts);
	dsi_cfg(&dsi->dsi_lcd, &dsi->dsi_para);
	drm_panel_prepare(dsi->sdrm.panel);
	sunxi_dsi_enable_output(dsi);
	drm_panel_enable(dsi->sdrm.panel);
}
```

HDMI、RGB、LVDS、eDP 也是同一类角色：

```text
connector:
  表示用户态可见的输出端口，负责 modes/edid/status/property

encoder:
  把 CRTC 像素流接到具体输出接口，负责接口 enable/disable/mode_set

TCON / PHY / panel:
  负责实际时序、电气层、面板上电初始化
```

## 12. 用户态标准调用顺序

一个典型 compositor 或 KMS client 的逻辑大概是：

```text
1. 打开 PVR render node
   open("/dev/dri/renderDxxx")

2. EGL/GLES/Vulkan 创建 render target
   用户态 PVR 库通过 bridge 创建 PMR/GPU VA/render context

3. 提交 GPU 渲染
   ioctl(PVR, DRM_IOCTL_PVR_SRVKM_CMD, RGXKickTA3D2)

4. 导出渲染结果
   PVR bridge -> PhysmemExportDmaBuf()
   得到 dma-buf fd

5. 打开 sunxi-drm KMS card
   open("/dev/dri/cardX")

6. 导入 dma-buf
   drmPrimeFDToHandle(card_fd, dma_buf_fd, &handle)

7. 创建 framebuffer
   drmModeAddFB2(card_fd, width, height, fourcc,
                 handles, pitches, offsets, &fb_id, flags)

8. 设置 plane
   atomic set plane.FB_ID = fb_id
   atomic set plane.CRTC_ID = crtc_id
   atomic set plane.SRC_* / CRTC_* / zpos / alpha ...

9. 原子提交
   drmModeAtomicCommit(card_fd, req,
                       DRM_MODE_ATOMIC_NONBLOCK |
                       DRM_MODE_PAGE_FLIP_EVENT,
                       user_data)

10. sunxi-drm 配置 DE/TCON/connector
    plane atomic_update -> DE channel
    crtc atomic_flush -> DE update
    encoder atomic_enable -> DSI/HDMI/RGB/LVDS/eDP output
```

如果是 Wayland/Weston 一类 compositor，通常这部分由 EGL dmabuf import/export、GBM、libdrm、KMS backend 组合完成；应用本身不一定直接调用 AddFB2/AtomicCommit。

## 13. 和 dc_sunxi 路径的关键差异

两条路径可以这样对比：

```text
dc_sunxi 路径：

PVR Display Class buffer
  -> dc_sunxi 从 registered_fb[] 获取 fbdev 显存
  -> GPU 直接渲染到 fbdev backing memory
  -> PVR DC present
  -> fb_pan_display()
  -> sunxi fbdev/disp2 scanout
```

```text
标准 DRM/KMS 路径：

PVR render buffer / PMR
  -> GPU 渲染完成
  -> dma-buf fd
  -> sunxi-drm PRIME import
  -> drm_framebuffer
  -> atomic plane update
  -> DE/TCON/connector scanout
```

核心区别：

- `dc_sunxi` 路径下，buffer 本来就是 fbdev 显存，present 是 fbdev 翻页。
- 标准 KMS 路径下，buffer 是跨驱动共享 dma-buf，present 是 DRM atomic commit。
- `dc_sunxi` 路径下，PVR Display Class 参与送显。
- 标准 KMS 路径下，PVR Display Class 不参与送显。
- `dc_sunxi` 路径的显示 owner 是 fbdev/disp2。
- 标准 KMS 路径的显示 owner 是 `sunxi-drm`。

## 14. 标准 KMS 路径中的同步关系

渲染和送显分属两个 DRM 设备时，同步非常关键：

```text
GPU render fence
  -> 表示 PVR 还在写 buffer
  -> KMS 不能提前扫描未完成内容

KMS release/page flip fence 或 event
  -> 表示某一帧已经完成 flip 或不再被当前 scanout 使用
  -> compositor 才能复用 buffer
```

PVR 当前配置打开了 native fence sync：

```make
SUPPORT_NATIVE_FENCE_SYNC := 1
```

PVR DRM ioctl 也包含 sync/fence 相关接口：

```c
// bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_drm.c
DRM_IOCTL_DEF_DRV(PVR_SYNC_RENAME_CMD, pvr_sync_rename_ioctl, DRM_RENDER_ALLOW),
DRM_IOCTL_DEF_DRV(PVR_SW_SYNC_CREATE_FENCE_CMD, pvr_sw_sync_create_fence_ioctl, DRM_RENDER_ALLOW),
DRM_IOCTL_DEF_DRV(PVR_SYNC_CREATE_EXPORT_FENCE_CMD,
		  pvr_export_fence_sync_create_fence_ioctl,
		  DRM_RENDER_ALLOW),
```

在 KMS 层，plane 有标准 `IN_FENCE_FD` 属性，atomic commit 可以带 acquire fence。这样 sunxi-drm 在提交当前 framebuffer 前，可以等待 PVR 渲染完成。

实际用户态一般会这样组织：

```text
PVR render submit
  -> 产生/导出 acquire fence fd
  -> KMS plane.IN_FENCE_FD = acquire_fence_fd
  -> atomic commit
  -> page flip event/release fence
  -> buffer 回收或复用
```

如果没有正确传递 fence，可能出现：

- 撕裂或显示上一帧残留
- DE 扫描到 GPU 尚未写完的 buffer
- buffer 被 compositor 过早复用

## 15. 本路径下 DISP/fbdev 驱动的位置

用户指定的 DISP 驱动目录是：

```text
bsp/drivers/video/sunxi
```

在旧路径里，`dc_sunxi` 会通过 fbdev 进入这个目录下的 disp/fbdev 栈。

但在标准 DRM/KMS 路径里，主显示路径走的是：

```text
bsp/drivers/drm
  -> sunxi_drm_drv.c
  -> sunxi_drm_crtc.c
  -> sunxi_drm_dsi/hdmi/rgb/lvds/edp.c
  -> sunxi_device/hardware/lowlevel_de/*
  -> sunxi_device/hardware/lowlevel_lcd/*
  -> sunxi_device/hardware/lowlevel_tcon/*
  -> sunxi_device/hardware/lowlevel_hdmi20/*
```

也就是说，`bsp/drivers/video/sunxi` 更多是旧 fbdev/disp 体系的显示路径。标准 KMS 送显时，关键源码在 `bsp/drivers/drm`。

## 16. 最终完整流程图

```text
              用户态
┌──────────────────────────────────────────────────────────────┐
│ App / GLES / EGL / Vulkan / compositor                       │
│                                                              │
│ 1. PVR render submit                                         │
│ 2. PVR export dma-buf                                        │
│ 3. sunxi-drm import dma-buf                                  │
│ 4. AddFB2 + AtomicCommit                                     │
└───────────────┬───────────────────────────────┬──────────────┘
                │                               │
                v                               v
        PVR DRM render node              sunxi-drm KMS card
        /dev/dri/renderD*                /dev/dri/cardX
                │                               │
                v                               v
┌──────────────────────────────┐      ┌──────────────────────────────┐
│ pvrsrvkm / PVR Services       │      │ DRM/KMS core                  │
│ - bridge dispatch             │      │ - framebuffer                 │
│ - PMR / devmem                │      │ - plane                       │
│ - RGX render context          │      │ - crtc                        │
│ - native fence sync           │      │ - encoder / connector         │
│ - dma-buf export              │      │ - atomic commit               │
└───────────────┬──────────────┘      └───────────────┬──────────────┘
                │                                      │
                v                                      v
┌──────────────────────────────┐      ┌──────────────────────────────┐
│ RGX/BXM GPU                   │      │ sunxi DE / TCON / PHY         │
│ - render to shared buffer     │      │ - overlay / scaler / blender  │
│ - signal render fence         │      │ - timing / scanout            │
└───────────────┬──────────────┘      └───────────────┬──────────────┘
                │                                      │
                └──────── shared dma-buf buffer ───────┘
                                                       │
                                                       v
                                            DSI / HDMI / RGB / LVDS / eDP
                                                       │
                                                       v
                                                   Panel / Monitor
```

## 17. 一句话总结

PVR 使用标准 DRM/KMS 作为显示输出时，PVR 侧不再通过 `dc_sunxi` 去翻 fbdev，而是把 GPU 渲染结果通过 dma-buf/PRIME 交给 `sunxi-drm`。`sunxi-drm` 把这个 dma-buf 导入成 GEM/framebuffer，再通过 DRM atomic commit 配置 plane、CRTC、encoder、connector，最终由 DE/TCON/DSI/HDMI 等显示硬件完成扫描输出。
