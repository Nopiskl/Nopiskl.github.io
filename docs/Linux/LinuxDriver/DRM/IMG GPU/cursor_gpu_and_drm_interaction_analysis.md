# GPU and DRM interaction analysis
_Exported on 2026/4/4 at GMT+8 21:40:12 from Cursor (2.6.21)_

---

**User**

@bsp/drivers/drm 帮我结合sunxi官方DRM驱动+@bsp/modules/gpu/img-bxm 这个GPU驱动，分析一下GPU注册后如何与DRM交互实现buffer显示


**Cursor**

继续给你把链路完整串起来。先说结论：

**在你这套代码里，`img-bxm` GPU 驱动本身不是直接把 buffer 通过 KMS 提交到 `sunxi-drm` 的。**  
它更像是“**渲染节点 + dma-buf/GEM 提供者 + 自有 Display Class(DC)**”，而 `sunxi` 官方 DRM 是独立的显示控制器驱动。两者交互核心是 **dma-buf/PRIME + 同步 fence**，不是同一个 DRM 设备里的“GPU plane 直扫”。

---

## 1) sunxi DRM 这边：显示链路怎么吃 buffer

`sunxi-drm` 驱动注册为标准 KMS/GEM 驱动，支持 atomic：

```399:417:bsp/drivers/drm/sunxi_drm_drv.c
DEFINE_DRM_GEM_DMA_FOPS(sunxi_drm_driver_fops);
static struct drm_driver sunxi_drm_driver = {
	.driver_features = DRIVER_MODESET | DRIVER_GEM | DRIVER_ATOMIC,
	.fops = &sunxi_drm_driver_fops,
	...
	.gem_create_object = sunxi_gem_create_object,
	DRM_GEM_DMA_DRIVER_OPS_VMAP,
};
```

对象模型是 `drm_gem_dma_object`（6.1+）或 cma（老内核）：

```123:138:bsp/drivers/drm/sunxi_drm_gem.h
struct sunxi_gem_object {
#if LINUX_VERSION_CODE <= KERNEL_VERSION(6, 1, 0)
	struct drm_gem_cma_object base;
#else
	struct drm_gem_dma_object base;
#endif
	enum dma_data_direction dir;
};
```

FB 创建走 GEM framebuffer helper：

```103:112:bsp/drivers/drm/sunxi_drm_drv.c
struct drm_framebuffer *
sunxi_drm_gem_fb_create(struct drm_device *dev, struct drm_file *file,
			const struct drm_mode_fb_cmd2 *mode_cmd)
{
	return drm_gem_fb_create_with_funcs(dev, file, mode_cmd,
					    &sunxi_drm_gem_fb_funcs);
}
```

atomic 提交时，plane update -> de 通道更新；flush 时下发硬件：

```534:556:bsp/drivers/drm/sunxi_drm_crtc.c
static void sunxi_plane_atomic_update(struct drm_plane *plane,
				      struct drm_atomic_state *state)

{
	...
	sunxi_de_channel_update(&info);
	...
}
```

```2054:2104:bsp/drivers/drm/sunxi_drm_crtc.c
static void sunxi_crtc_atomic_flush(struct drm_crtc *crtc,
				    struct drm_atomic_state *state)
{
	...
	sunxi_de_atomic_flush(scrtc->sunxi_de, backend_data, &cfg);
	...
	sunxi_crtc_finish_page_flip(crtc->dev, scrtc);
	...
}
```

---

## 2) img-bxm 这边：它在 DRM 中扮演什么角色

PVR 驱动注册为 **render/modeset/gem/prime** 类型 DRM 设备（偏 GPU 渲染用途）：

```155:194:bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_drm.c
const struct drm_driver pvr_drm_generic_driver = {
	.driver_features	= DRIVER_MODESET | DRIVER_RENDER |
				  DRIVER_GEM | PVR_DRM_DRIVER_PRIME,
	...
	.ioctls			= pvr_drm_ioctls,
	.fops			= &pvr_drm_fops,
	...
};
```

它实现了大量 dma-buf ops（含 GEM 路径），用于导出/共享内存：

```751:796:bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/physmem_dmabuf.c
static const struct dma_buf_ops sPVRDmaBufOpsGEM =
{
	.attach        = PVRDmaBufOpsAttachGEM,
	.map_dma_buf   = PVRDmaBufOpsMapGEM,
	.unmap_dma_buf = PVRDmaBufOpsUnmapGEM,
	.release       = drm_gem_dmabuf_release,
	.begin_cpu_access = PVRDmaBufOpsBeginCpuAccessGEM,
	.end_cpu_access   = PVRDmaBufOpsEndCpuAccessGEM,
	...
};
```

---

## 3) 关键点：你这个 `dc_sunxi` 实际上是 fbdev DC 代码，不是 KMS 直连

你项目里的 `services/display/dc_sunxi/dc_sunxi.c` 内容是 `DC_FBDEV_*`，通过 `registered_fb[]/fb_pan_display` 驱动显示：

```466:486:bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
if (DCRegisterDevice(&sDCFunctions,
						 MAX_COMMANDS_IN_FLIGHT,
						 gpsDeviceData,
						 &gpsDeviceData->hSrvHandle) != PVRSRV_OK)
	goto err_kfree;
```

```96:143:bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
void DC_FBDEV_ContextConfigure(...)
{
	...
	err = fb_pan_display(psDeviceData->psLINFBInfo, &sVar);
	...
}
```

这说明当前组合更接近：
- PVR 渲染到其 DC 分配的 FB 区；
- 通过 fbdev pan/flip 显示；
- 并不走 `sunxi-drm` 用户态 atomic 提交这条标准 KMS 显示路径。

---

## 4) 那“GPU注册后如何与DRM交互实现buffer显示”可分两种模式

### 模式A（你当前代码主路径）
1. `pvr_drm` 注册 GPU DRM/render 节点，提供提交渲染和内存共享能力。  
2. `dc_sunxi(=fbdev)` 作为 PVR Display Class backend 注册设备。  
3. PVR 的 DC 回调里 `BufferAlloc/Acquire/ContextConfigure` 获取 fbdev 显存并 `fb_pan_display`。  
4. 显示由 fbdev/sunxi fb 层完成，不是直接 KMS plane 提交。

### 模式B（标准 DRM/KMS 协同，理论/可演进）
1. GPU 渲染结果导出 dma-buf fd（PVR GEM/PRIME）。  
2. 显示侧（用户态 compositor）把该 fd 通过 `drmModeAddFB2` + atomic commit 提交给 `sunxi-drm`。  
3. `sunxi-drm` 通过 GEM PRIME import/attachment 映射 sg_table，DE 扫描输出。  
4. fence 同步保证“渲染完成后再扫出”。

---

## 5) 你可重点验证的三个观察点

1. **设备节点层面**：是否同时有 `/dev/dri/renderD*`（PVR）和 `/dev/dri/card*`（sunxi）在协作。  
2. **用户态路径**：应用是走 fbdev（`/dev/fb0`）还是 kms atomic（libdrm/gbm/weston）。  
3. **buffer来源**：sunxi plane 的 FB 是本地 dumb/GEM，还是外部 dma-buf import（这决定是否真“GPU->DRM KMS”）。

---

如果你愿意，我下一步可以按你板子的实际配置再给一版**“可落地判定脚本+日志点位”**（看哪些 ioctl/节点被命中），快速判断现在跑的是 A 还是 B。

---

**User**

已知dc_sunxi是老平台适配全志DISP2(基于fbdev)显示框架的桥接驱动，正常的还是走标准DRM/KMS的，请你验证一下并根据” 模式B（标准 DRM/KMS 协同，理论/可演进）“结合具体源码详细分析一下

---

**Cursor**

我重新按你的前提做了验证，结论比较明确：

## 结论先说

### 1. `dc_sunxi` 确实只是老平台 `DISP2/fbdev` 桥接
它虽然目录名叫 `dc_sunxi`，但源码内容就是 `DC_FBDEV_*`，直接依赖 `fb_info` / `registered_fb[]` / `fb_pan_display()`，没有任何 KMS plane / CRTC / atomic 提交逻辑。

关键证据：

```1:25:bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
#include <linux/console.h>
#include <linux/fb.h>
#include <linux/mm.h>
#include <linux/module.h>
#include <linux/platform_device.h>

#include "kerneldisplay.h"
#include "powervr/imgpixfmts.h"
#include "pvrmodule.h" /* for MODULE_LICENSE() */

#if (LINUX_VERSION_CODE >= KERNEL_VERSION(6, 1, 0))
#error dc_fbdev is not supported for Linux version 6.1.0 or later.
#endif

#if !defined(CONFIG_FB)
#error dc_fbdev needs Linux framebuffer support. Enable it in your kernel.
#endif

#define DRVNAME					"dc_fbdev"
#define DEVNAME					DRVNAME
```

```418:482:bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
static
void DC_FBDEV_ContextConfigure(IMG_HANDLE hDisplayContext,
								   IMG_UINT32 ui32PipeCount,
								   PVRSRV_SURFACE_CONFIG_INFO *pasSurfAttrib,
								   IMG_HANDLE *ahBuffers,
								   IMG_UINT32 ui32DisplayPeriod,
								   IMG_HANDLE hConfigData)
{
	...
	if (psDeviceData->bCanFlip &&
		sVar.yres_virtual < sVar.yres * NUM_PREFERRED_BUFFERS)
	{
		...
		err = fb_set_var(psDeviceData->psLINFBInfo, &sVar);
		...
	}
	else
	{
		err = fb_pan_display(psDeviceData->psLINFBInfo, &sVar);
		...
	}
	...
}
```

```706:739:bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
static int DC_FBDEV_Probe(struct platform_device *psDev)
{
	...
	psLINFBInfo = registered_fb[gui32fb_devminor];
	...
}
```

并且它的构建文件也只是把这个单文件编成 `dc_sunxi.ko`：

```41:45:bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/Linux.mk
modules := dc_sunxi

dc_sunxi_type := kernel_module
dc_sunxi_target := dc_sunxi.ko
dc_sunxi_makefile := $(THIS_DIR)/Kbuild.mk
```

```41:45:bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/Kbuild.mk
ccflags-y += \
 -I$(TOP)/services/display/dc_sunxi

dc_sunxi-y += \
	services/display/dc_sunxi/dc_sunxi.o
```

所以这一点你说的是对的：**它只是老桥接，不是标准路径。**

---

## 2. 正常标准路径确实应该走 DRM/KMS
你这棵树里 `sunxi-drm` 是完整的 KMS 驱动，PVR 侧也具备 DRM render + GEM + PRIME/dma-buf 能力，因此标准协同路径应当是：

**PVR 渲染出 buffer → 导出 dma-buf fd → 用户态 compositor/KMS 客户端把 fd 导入到 `sunxi-drm` → `AddFB2/atomic commit` → DE 扫描输出**

下面我按具体源码把这个“模式B”详细串起来。

---

# 一、PVR 侧：提供渲染节点、GEM/PRIME、dma-buf 共享能力

PVR DRM 驱动不是显示控制器驱动，而是 GPU/render 驱动：

```523:551:bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_drm.c
const struct drm_driver pvr_drm_generic_driver = {
	.driver_features	= DRIVER_MODESET | DRIVER_RENDER |
				  DRIVER_GEM | PVR_DRM_DRIVER_PRIME,

	.load			= NULL,
	.unload			= NULL,
	.open			= pvr_drm_open,
	.postclose		= pvr_drm_release,

#if (LINUX_VERSION_CODE < KERNEL_VERSION(6, 6, 0))
	.prime_handle_to_fd	= drm_gem_prime_handle_to_fd,
	/* prime_fd_to_handle is not supported */
#endif

#if (LINUX_VERSION_CODE < KERNEL_VERSION(5, 9, 0))
	.gem_prime_export	= PhysmemGEMPrimeExport,
	.gem_free_object	= PhysmemGEMObjectFree,
#endif
	.ioctls			= pvr_drm_ioctls,
	.num_ioctls		= ARRAY_SIZE(pvr_drm_ioctls),
	.fops			= &pvr_drm_fops,
	...
};
```

这里有几个点要注意：

- `DRIVER_RENDER`：说明它主要提供 render node 能力。
- `DRIVER_GEM`：说明它用 GEM 管理 GPU buffer。
- `PVR_DRM_DRIVER_PRIME`：说明它支持 PRIME/dma-buf 共享。
- `.prime_handle_to_fd = drm_gem_prime_handle_to_fd`：允许把本驱动 GEM handle 导出成 dma-buf fd。

也就是说，**PVR 这边能把 GPU 渲染目标 buffer 导出给别的 DRM 设备使用。**

---

## PVR dma-buf 导出能力

`physmem_dmabuf.c` 明确实现了标准 dma-buf ops：

```762:788:bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/physmem_dmabuf.c
static const struct dma_buf_ops sPVRDmaBufOps =
{
	.attach        = PVRDmaBufOpsAttach,
	.map_dma_buf   = PVRDmaBufOpsMap,
	.unmap_dma_buf = PVRDmaBufOpsUnmap,
	.release       = PVRDmaBufOpsRelease,
	.begin_cpu_access = PVRDmaBufOpsBeginCpuAccess,
	.end_cpu_access   = PVRDmaBufOpsEndCpuAccess,
	...
	.mmap          = PVRDmaBufOpsMMap,
	.vmap          = PVRDmaBufOpsVMap,
	.vunmap        = PVRDmaBufOpsVUnMap,
};
```

对于 GEM 导出路径也有专门版本：

```799:815:bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/physmem_dmabuf.c
static int PVRDmaBufOpsAttachGEM(struct dma_buf *psDmaBuf,
...
{
	struct drm_gem_object *psObj = psDmaBuf->priv;
	PMR_DMA_BUF_GEM_OBJ *psGEMObj = TO_PMR_DMA_BUF_GEM_OBJ(psObj);
	PMR_DMA_BUF_WRAPPER *psPMRWrapper = psGEMObj->psPMRWrapper;

	return PVRDmaBufOpsAttachCommon(psPMRWrapper, psAttachment);
}

static struct sg_table *PVRDmaBufOpsMapGEM(struct dma_buf_attachment *psAttachment,
                                        enum dma_data_direction eDirection)
{
```

这说明：
- 其他设备导入 PVR 的 dma-buf 时，会走 `attach/map_dma_buf`；
- 导入方可以获得 `sg_table`；
- 同时还有 `begin/end_cpu_access` 负责 cache 同步。

所以 **PVR -> sunxi-drm 的跨设备 buffer 共享，在内核能力上是成立的。**

---

## PVR 同步能力

PVR 还带 DRM ioctl 风格的 sync/fence 接口：

```64:81:bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_drm.c
static struct drm_ioctl_desc pvr_drm_ioctls[] = {
	DRM_IOCTL_DEF_DRV(PVR_SRVKM_CMD, PVRSRV_BridgeDispatchKM,
			  DRM_RENDER_ALLOW),
	DRM_IOCTL_DEF_DRV(PVR_SRVKM_INIT, drm_pvr_srvkm_init,
			  DRM_RENDER_ALLOW),
#if defined(SUPPORT_NATIVE_FENCE_SYNC) && !defined(USE_PVRSYNC_DEVNODE)
	DRM_IOCTL_DEF_DRV(PVR_SYNC_RENAME_CMD, pvr_sync_rename_ioctl,
			  DRM_RENDER_ALLOW),
	...
	DRM_IOCTL_DEF_DRV(PVR_SYNC_CREATE_EXPORT_FENCE_CMD,
			  pvr_export_fence_sync_create_fence_ioctl,
			  DRM_RENDER_ALLOW),
#endif
};
```

`pvr_sync_ioctl_drm.c` 也说明它是走 DRM file/fence 体系：

```128:157:bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_sync_ioctl_drm.c
int pvr_sync_rename_ioctl(struct drm_device __maybe_unused *dev,
			  void *arg, struct drm_file *file)
{
	return pvr_sync_ioctl_common_rename(file->filp, arg);
}
...
int pvr_export_fence_sync_create_fence_ioctl(struct drm_device __maybe_unused *dev,
			  void *arg, struct drm_file *file)
{
	return pvr_sync_ioctl_common_create_export_fence(file->filp, arg);
}
```

这意味着在标准 DRM/KMS 路径中，**不仅 buffer 能共享，渲染完成的 fence 也能与显示提交流程配合。**

---

# 二、sunxi DRM 侧：它是真正的 KMS 显示控制器

`sunxi-drm` 驱动注册的是标准 modeset/GEM/atomic DRM 设备：

```399:417:bsp/drivers/drm/sunxi_drm_drv.c
DEFINE_DRM_GEM_DMA_FOPS(sunxi_drm_driver_fops);
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

驱动绑定时初始化 mode_config、组件、connector/crtc/encoder，再 `drm_dev_register()`：

```1122:1170:bsp/drivers/drm/sunxi_drm_drv.c
private = __devm_drm_dev_alloc(dev, &sunxi_drm_driver,
	  sizeof(*private) + sizeof(struct sunxi_drm_pri),
	    offsetof(struct sunxi_drm_private, base));
...
ret = drmm_mode_config_init(drm);
...
sunxi_drm_mode_config_init(drm);
sunxi_drm_property_create(private);
...
ret = component_bind_all(dev, drm);
...
drm_mode_config_reset(drm);
drm_kms_helper_poll_init(drm);
...
ret = drm_dev_register(drm, 0);
```

这就是标准 KMS card 节点。

---

# 三、标准模式B下，buffer 显示的完整协同链路

下面按“用户态 -> sunxi-drm -> lowlevel DE”的顺序说。

---

## 第1步：PVR 渲染出 GEM buffer，并导出 dma-buf fd

用户态通过 PVR render node 分配/渲染到一个 GEM buffer。  
随后通过 PRIME 把 handle 转成 fd。PVR 侧支持：

```532:535:bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_drm.c
#if (LINUX_VERSION_CODE < KERNEL_VERSION(6, 6, 0))
	.prime_handle_to_fd	= drm_gem_prime_handle_to_fd,
	/* prime_fd_to_handle is not supported */
#endif
```

所以用户态可以拿到 dma-buf fd。

---

## 第2步：用户态把 dma-buf fd 导入 sunxi-drm，并创建 framebuffer

在标准 DRM/KMS 用户态流程里，通常是：

1. `drmPrimeFDToHandle(card_fd, dma_buf_fd, &handle)`
2. `drmModeAddFB2(card_fd, width, height, format, handles, pitches, offsets, &fb_id, flags)`
3. `atomic commit` 绑定到 plane/crtc

`sunxi-drm` 的 `fb_create` 是：

```109:119:bsp/drivers/drm/sunxi_drm_drv.c
static const struct drm_framebuffer_funcs sunxi_drm_gem_fb_funcs = {
	.destroy = sunxi_drm_gem_fb_destroy,
	.create_handle = drm_gem_fb_create_handle,
};

struct drm_framebuffer *
sunxi_drm_gem_fb_create(struct drm_device *dev, struct drm_file *file,
			const struct drm_mode_fb_cmd2 *mode_cmd)
{
	return drm_gem_fb_create_with_funcs(dev, file, mode_cmd,
					    &sunxi_drm_gem_fb_funcs);
}
```

也就是：
- 用户态 `AddFB2` 传来的 GEM handle，会被封装成 `drm_framebuffer`
- 这个 framebuffer 后续就挂到 plane state 上

这里你要注意一个关键点：  
**sunxi-drm 本身没有自定义复杂 import 逻辑，主要依赖 `DRM_GEM_DMA_DRIVER_OPS_VMAP` 和 GEM DMA helper。**  
所以只要导入成该设备可用的 GEM 对象，后面 DE 就按普通 framebuffer 使用。

---

## 第3步：atomic commit 时，plane state 挂上这个 fb

在 `sunxi` 驱动中，用户态提交的 plane framebuffer 会进到 plane state：

```538:557:bsp/drivers/drm/sunxi_drm_crtc.c
static void sunxi_plane_atomic_update(struct drm_plane *plane,
				      struct drm_atomic_state *state)
{
	struct drm_plane_state *old_state = drm_atomic_get_old_plane_state(state, plane);
	...
	struct drm_plane_state *new_state = plane->state;
	struct display_channel_state *new_cstate = to_display_channel_state(new_state);
	...
	info.new_state = new_cstate;
	info.old_state = old_cstate;
	info.is_fbdev = false;
	info.fbdev_output = scrtc->fbdev_output;
	sunxi_de_channel_update(&info);
```

这里 `new_cstate->base.fb` / `new_cstate->fb[i]` 就是 atomic 用户态传下来的 framebuffer。

驱动本身也支持多 layer/overlay，通过扩展 property `FB_ID1/2/...` 来挂多个 FB：

```1290:1301:bsp/drivers/drm/sunxi_drm_crtc.c
		sprintf(name, "FB_ID%d", i + 1);
		prop = drm_property_create_object(dev, DRM_MODE_PROP_ATOMIC,
				name, DRM_MODE_OBJECT_FB);
		...
		private->prop_fb_id[i] = prop;
```

所以模式B下可以是：
- 主 layer 用 GPU 渲染 buffer
- 其他 layer 也可以是别的 dma-buf / 本地 buffer

---

## 第4步：`sunxi_de_channel_update()` 把 DRM state 翻译成 DE 硬件配置

`sunxi_plane_atomic_update()` 不直接写寄存器，而是把 `drm_plane_state` 转换成 `display_channel_state` 交给 lowlevel DE。

核心是：

```551:557:bsp/drivers/drm/sunxi_drm_crtc.c
	info.hdl = sunxi_plane->hdl;
	info.hwde = scrtc->sunxi_de;
	info.new_state = new_cstate;
	info.old_state = old_cstate;
	info.is_fbdev = false;
	info.fbdev_output = scrtc->fbdev_output;
	sunxi_de_channel_update(&info);
```

这里已经是 **KMS path**，因为 `is_fbdev = false`。

---

## 第5步：DE 底层从 framebuffer 里取 DMA 地址

真正决定“扫哪块内存”的地方在 lowlevel DE。  
`de_ovl_u_set_lay_layout()` 直接从 `drm_framebuffer` 取 GEM 对象，再取 DMA 地址：

```549:585:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/ovl/de_ovl.c
static int de_ovl_u_set_lay_layout(struct ovl_u_reg *reg, unsigned int x0, unsigned y0, int format, struct drm_framebuffer *fb, unsigned int layer_id)
{
	u32 bpp;
	u32 pitch = fb->pitches[0];
	u64 addr;
#if LINUX_VERSION_CODE <= KERNEL_VERSION(6, 1, 0)
	struct drm_gem_cma_object *gem;
#else
	struct drm_gem_dma_object *gem;
#endif
	u64 addr_tmp = 0;
	...
#if LINUX_VERSION_CODE <= KERNEL_VERSION(6, 1, 0)
	gem = drm_fb_cma_get_gem_obj(fb, 0);
	if (gem) {
		addr_tmp = (u64)(gem->paddr) + fb->offsets[0];
	}
#else
	gem = drm_fb_dma_get_gem_obj(fb, 0);
	if (gem) {
		addr_tmp = (u64)(gem->dma_addr) + fb->offsets[0];
	}
#endif
	addr = addr_tmp
		+ pitch * y0 + (x0 * bpp >> 3);
```

然后把地址写进 overlay layer 地址寄存器：

```586:600:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/ovl/de_ovl.c
	reg->lay[layer_id].pitch.dwval = pitch;
	reg->lay[layer_id].top_laddr.dwval = (u32)addr;
	reg->lay[layer_id].bot_laddr.dwval = 0;
	if (layer_id == 0) {
		reg->top_haddr.bits.haddr_lay0 = (u32)(addr >> 32);
		...
```

这段代码非常关键，它证明了：

### 在标准 KMS 路径下，sunxi DE 最终并不关心“这个 buffer 是 sunxi 自己分配的还是 GPU 导入的”
它只关心：
- `fb->pitches[0]`
- `fb->offsets[0]`
- `drm_fb_dma_get_gem_obj(fb, 0)->dma_addr`

只要导入后的 framebuffer 在 `sunxi-drm` 看起来是一个合法的 `drm_gem_dma_object`，DE 就能直接扫。

---

## 第6步：`atomic_flush` 统一提交到硬件，等待 vblank/pageflip 完成

所有 plane 更新完后，CRTC flush：

```2063:2101:bsp/drivers/drm/sunxi_drm_crtc.c
static void sunxi_crtc_atomic_flush(struct drm_crtc *crtc,
				    struct drm_atomic_state *state)
{
	...
	backend_data = scrtc_state->backend_blob ? scrtc_state->backend_blob->data : NULL;
	sunxi_de_atomic_flush(scrtc->sunxi_de, backend_data, &cfg);
	if (scrtc_state->atomic_flush)
		scrtc_state->atomic_flush(scrtc_state->output_dev_data);
	...
}
```

然后在中断里发 vblank / page flip event：

```1588:1616:bsp/drivers/drm/sunxi_drm_crtc.c
irqreturn_t sunxi_crtc_event_proc(int irq, void *crtc)
{
	...
	sunxi_de_event_proc(scrtc->sunxi_de, timeout);

	/* vblank common process */
	drm_crtc_handle_vblank(&scrtc->crtc);
	...
	if (!busy) {
		sunxi_crtc_finish_page_flip(scrtc->crtc.dev, scrtc);
	}
	return IRQ_HANDLED;
}
```

所以标准 KMS 模式下，完整显示提交闭环是存在的。

---

# 四、模式B里 PVR 与 sunxi DRM 的真实边界

这个边界非常重要，我给你明确一下：

## PVR 负责
- GPU 渲染
- GEM buffer 生命周期
- dma-buf 导出
- fence/sync 导出

## sunxi DRM 负责
- 接收导入 buffer
- 创建 KMS framebuffer
- plane/CRTC/connector atomic 提交
- 把 buffer 地址下发给 DE 硬件
- vblank/pageflip 完成通知

## 用户态/compositor 负责把两边串起来
通常是：
- 从 PVR render 节点拿到 buffer
- export dma-buf fd
- 向 `sunxi-drm` 导入并 `AddFB2`
- atomic commit 到 plane

也就是说，**PVR 和 sunxi-drm 在模式B里不是内核里直接互调，而是通过 dma-buf + fence 由用户态 KMS 客户端完成桥接。**

---

# 五、为什么我说这是“正常标准路径”

因为从源码上看：

### `sunxi-drm` 明确是完整 KMS 驱动
```399:417:bsp/drivers/drm/sunxi_drm_drv.c
.driver_features = DRIVER_MODESET | DRIVER_GEM | DRIVER_ATOMIC,
...
.gem_create_object = sunxi_gem_create_object,
DRM_GEM_DMA_DRIVER_OPS_VMAP,
```

### `pvr_drm` 明确支持 render/GEM/PRIME
```523:539:bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_drm.c
.driver_features	= DRIVER_MODESET | DRIVER_RENDER |
				  DRIVER_GEM | PVR_DRM_DRIVER_PRIME,
...
.prime_handle_to_fd	= drm_gem_prime_handle_to_fd,
...
.gem_prime_export	= PhysmemGEMPrimeExport,
```

### `dc_sunxi` 明确只是 fbdev/DC 旁路
```1:25:bsp/modules/gpu/img-bxm/linux/rogue_km/services/display/dc_sunxi/dc_sunxi.c
#include <linux/fb.h>
...
#define DRVNAME "dc_fbdev"
```

所以你的判断是对的：  
**生产/正常标准协同，不应该走 `dc_sunxi`，而是走标准 DRM/KMS + PRIME/dma-buf。**

---

# 六、还有一个实现层面的注意点

虽然模式B在架构上成立，但你这份 `sunxi-drm` lowlevel DE 取地址时直接用了：

```549:585:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/ovl/de_ovl.c
gem = drm_fb_dma_get_gem_obj(fb, 0);
addr_tmp = (u64)(gem->dma_addr) + fb->offsets[0];
```

这意味着它更偏向 **GEM DMA object 本地视角**。  
因此要想完全无缝支持“外部设备导入的 dma-buf”，前提是导入后在 `sunxi-drm` 这边最终落成了可被 `drm_fb_dma_get_gem_obj()` 识别的对象，并且 `dma_addr` 已经是对 DE 可访问的地址。

从通用 DRM helper 角度这通常是成立的，但如果你后面遇到：
- 导入成功但扫不出来
- IOMMU/地址域不一致
- imported GEM object 类型与 helper 假设不完全一致

那就要继续查 `GEM PRIME import` 最终对象类型和 `dma_addr` 赋值路径。

---

# 七、最后给你一个“模式B源码级时序图”

## 1. GPU 渲染侧
- 用户态打开 PVR render node
- 分配 GEM buffer
- GPU 渲染完成
- `drm_gem_prime_handle_to_fd()` 导出 dma-buf fd

## 2. 显示侧
- 用户态打开 `sunxi-drm` card node
- `drmPrimeFDToHandle()` 导入 dma-buf 为 `sunxi-drm` handle
- `drmModeAddFB2()` -> `sunxi_drm_gem_fb_create()`

```114:119:bsp/drivers/drm/sunxi_drm_drv.c
sunxi_drm_gem_fb_create(...)
{
	return drm_gem_fb_create_with_funcs(...);
}
```

## 3. atomic 提交
- plane state 绑定 `fb`
- `sunxi_plane_atomic_update()` -> `sunxi_de_channel_update()`

```538:557:bsp/drivers/drm/sunxi_drm_crtc.c
static void sunxi_plane_atomic_update(...)
{
	...
	sunxi_de_channel_update(&info);
}
```

## 4. lowlevel DE 取地址
- `de_ovl_u_set_lay_layout()` 取 `fb -> gem -> dma_addr`
- 算出实际 layer base address
- 写入寄存器

```549:600:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/ovl/de_ovl.c
gem = drm_fb_dma_get_gem_obj(fb, 0);
addr_tmp = (u64)(gem->dma_addr) + fb->offsets[0];
...
reg->lay[layer_id].top_laddr.dwval = (u32)addr;
```

## 5. flush + 中断完成
- `sunxi_crtc_atomic_flush()` -> `sunxi_de_atomic_flush()`
- vblank irq -> `drm_crtc_handle_vblank()` / `page_flip event`

---

如果你要，我下一步可以继续帮你做两件更落地的事之一：

1. **继续深挖 `sunxi-drm` 的 PRIME import 落点**：确认外部 dma-buf 导入后最终是不是 `drm_gem_dma_object`，以及 `dma_addr` 在哪一步建立；  
2. **按用户态路径分析**：结合常见 `libdrm/GBM/Weston` 流程，把 `PVR render node -> sunxi card node` 的 ioctl 序列完整列出来。

