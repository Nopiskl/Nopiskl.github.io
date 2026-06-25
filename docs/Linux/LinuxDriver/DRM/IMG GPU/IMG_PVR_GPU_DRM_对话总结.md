# IMG PVR GPU / DRM / fbdev / dc_sunxi 对话总结

本文汇总本次关于 `bsp/modules/gpu/img-bxm/linux/rogue_km`、`pvrsrvkm.ko`、PVR DRM 注册、`dc_sunxi` 历史路径，以及当前 `bsp/drivers/drm` 显示栈的分析结论。

## 1. 总体结论

当前 BXM/IMG GPU 驱动不是一个简单的单文件 DRM 驱动，而是一整套 Imagination PowerVR Rogue DDK。它把 GPU 核心、Linux 适配、SoC 板级资源、用户态 bridge、显示后端拆成多层，目的是让同一套 GPU DDK 能复用到不同 GPU core、不同 SoC、不同 OS、不同窗口系统。

当前 SoC 已经转向 `bsp/drivers/drm` 这套 Allwinner DRM/KMS 显示栈。此时 PVR 侧主要承担 GPU render、GEM/PRIME/dma-buf、sync、ioctl bridge；真正的显示 scanout owner 是 `sunxi-drm`，不是 PVR 的 `dc_sunxi`。

`dc_sunxi` 是早期 Allwinner `disp/fbdev` 方案下的历史适配模块，本质是 PVR Display Class 到 Linux fbdev/disp2 的桥接。当前 `sunxi_linux/Makefile` 中它已经被注释掉。

## 2. IMG DDK 为什么这样分层

PVR DDK 的分层不是为了把代码写复杂，而是为了隔离变化点：

- `services/server/common/`：PowerVR Services 通用服务层，负责连接、内存、同步、PMR、bridge、DC server 等。
- `services/server/devices/rogue/`：RGX/BXM GPU 核心逻辑，比如固件、MMU、RGX 初始化、TA/3D、HWPerf。
- `services/server/env/linux/`：Linux 适配层，包括 `pvr_drm.c`、`pvr_platform_drv.c`、ioctl、mmap、dma-buf、sync。
- `services/system/rogue/rgx_sunxi/`：Sunxi SoC 适配层，解析 DTS、获取寄存器、IRQ、clock、reset、regulator、DVFS。
- `services/display/dc_sunxi/`：旧 fbdev/disp 显示后端，作为 PVR Display Class 设备接入。
- `generated/`：自动生成的 bridge 代码，用户态 PVR 库通过 bridge ioctl 调用内核服务。
- `build/linux/`：IMG 自带独立构建系统，用 `WINDOW_SYSTEM`、`PVR_SYSTEM`、`KERNEL_COMPONENTS` 等变量裁剪目标平台。

这样拆分后，GPU 核心代码可以跨平台复用；Linux 相关逻辑集中在 `env/linux`；SoC 差异集中在 `system/rogue/rgx_sunxi`。

## 3. `pvrsrvkm.ko` 是什么

`pvrsrvkm.ko` 是 PowerVR Services Kernel Module，也就是 IMG GPU 内核驱动的主模块。它不是源码文件，而是最终 `.ko` 编译产物。

在本 SDK 里，它既可以由源码重新编译生成，也随包带了一份已生成的二进制：

```text
bsp/modules/gpu/img-bxm/linux/rogue_km/binary_sunxi_linux_nulldrmws_release/target_aarch64/pvrsrvkm.ko
```

BXM 的构建入口在：

```make
# bsp/modules/gpu/Makefile
GPU_BUILD_DIR = img-bxm/$(CONFIG_OS_TYPE)/rogue_km/build/linux/sunxi_$(CONFIG_OS_TYPE)
GPU_KO_NAME = $(KO_DIR)/pvrsrvkm.ko
```

当前 Sunxi BXM 目标只构建主服务模块：

```make
# bsp/modules/gpu/img-bxm/linux/rogue_km/build/linux/sunxi_linux/Makefile
WINDOW_SYSTEM := nulldrmws
PVR_SYSTEM := rgx_sunxi
KERNEL_COMPONENTS := srvkm

#DISPLAY_CONTROLLER := dc_sunxi
#KERNEL_COMPONENTS += $(DISPLAY_CONTROLLER)
```

所以当前主线里 `pvrsrvkm.ko` 包含 PVR DRM 外壳、PVRSRV 服务层、RGX 设备层和 Sunxi `sysconfig`，但不包含 `dc_sunxi.ko`。

## 4. PVR 如何注册为 `drm_driver` / `drm_device`

PVR 的 DRM 外壳定义在：

```text
bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_drm.c
```

关键结构：

```c
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

platform 驱动入口在：

```text
bsp/modules/gpu/img-bxm/linux/rogue_km/services/server/env/linux/pvr_platform_drv.c
```

模块初始化流程：

```c
static int __init pvr_init(void)
{
	pvr_drm_platform_driver = pvr_drm_generic_driver;
	err = PVRSRVDriverInit();
	err = platform_driver_register(&pvr_platform_driver);
	return pvr_devices_register();
}

late_initcall(pvr_init);
```

probe 时创建并注册 `drm_device`：

```c
static int pvr_probe(struct platform_device *pdev)
{
	struct drm_device *ddev;

	ddev = drm_dev_alloc(&pvr_drm_platform_driver, &pdev->dev);
	ret = pvr_drm_load(ddev, 0);
	ret = drm_dev_register(ddev, 0);
	return 0;
}
```

`pvr_drm_load()` 里才进入 PVR Services 的设备创建和初始化：

```c
dev_set_drvdata(ddev->dev, ddev);
srv_err = PVRSRVCommonDeviceCreate(ddev->dev, deviceId, &priv->dev_node);
err = PVRSRVDeviceInit(priv->dev_node);
drm_mode_config_init(ddev);
```

Sunxi 硬件资源则在：

```text
bsp/modules/gpu/img-bxm/linux/rogue_km/services/system/rogue/rgx_sunxi/sysconfig.c
```

典型内容：

```c
sunxi_platform_init(dev);
psDevConfig->sRegsCpuPBase.uiAddr = sunxi_data->reg_base;
psDevConfig->ui32RegsSize = sunxi_data->reg_size;
psDevConfig->ui32IRQ = sunxi_data->irq_num;
psDevConfig->pfnPrePowerState = sunxiPrePowerState;
psDevConfig->pfnPostPowerState = sunxiPostPowerState;
```

## 5. 为什么放在 `bsp/modules/gpu`，不是内核 `drivers/gpu`

这套 PVR 驱动是 IMG 原厂 DDK 外置包，有自己的构建系统和平台配置，并不完全按主线内核 `drivers/gpu/drm/...` 组织。

放在 `bsp/modules/gpu` 的实际意义是：

- BSP 可以按 `GPU_TYPE` 选择 Mali、SGX、RGX、BXM 等不同 GPU 包。
- GPU 驱动可作为 out-of-tree kernel module 独立构建。
- 避免把一整套厂商 DDK 深度侵入内核主目录。
- DDK 本身也提供 `copy-to-kernel.sh`，说明它支持另一种模式：把源码复制进 kernel tree，例如 `drivers/gpu/drm/img-rogue/`。

所以它不是“不能放进 `drivers/gpu`”，而是当前 SDK 采用了 BSP 外置模块集成方式。

## 6. 旧 fbdev/disp 路径：PVR + Display Class + `dc_sunxi`

旧路径是：

```text
PVR 用户态库
  -> /dev/dri/cardX 或 renderD*
  -> pvrsrvkm.ko
  -> PVR Services / Display Class
  -> dc_sunxi.ko
  -> Linux fbdev registered_fb[]
  -> bsp/drivers/video/sunxi/disp2/disp
```

`dc_sunxi` 文件虽然叫 `dc_sunxi.c`，但源码内容本质是 `DC_FBDEV_*`：

```c
#include <linux/fb.h>

#if !defined(CONFIG_FB)
#error dc_fbdev needs Linux framebuffer support. Enable it in your kernel.
#endif
```

probe 时直接使用 fbdev：

```c
psLINFBInfo = registered_fb[gui32fb_devminor];
```

然后向 PVR Services 注册 Display Class 设备：

```c
DCRegisterDevice(&sDCFunctions,
		 MAX_COMMANDS_IN_FLIGHT,
		 gpsDeviceData,
		 &gpsDeviceData->hSrvHandle);
```

真正显示切换是 fbdev 操作：

```c
fb_set_var(psDeviceData->psLINFBInfo, &sVar);
fb_pan_display(psDeviceData->psLINFBInfo, &sVar);
```

这说明旧方案里显示 owner 是 fbdev/disp2，不是 DRM/KMS。

## 7. 当前 DRM/KMS 路径：PVR render + `sunxi-drm` scanout

当前标准路径应理解为：

```text
PVR GPU
  -> 渲染到 GEM/PMR buffer
  -> PRIME/dma-buf 导出
  -> 用户态 compositor / KMS client
  -> sunxi-drm 导入 dma-buf
  -> AddFB2 / atomic commit
  -> plane / crtc / connector
  -> DE/TCON/HDMI/DSI/LVDS/eDP scanout
```

`sunxi-drm` 是真正的 KMS 显示控制器驱动：

```c
// bsp/drivers/drm/sunxi_drm_drv.c
static struct drm_driver sunxi_drm_driver = {
	.driver_features = DRIVER_MODESET | DRIVER_GEM | DRIVER_ATOMIC,
	.fops = &sunxi_drm_driver_fops,
};
```

它会初始化 mode config、绑定 DE/TCON/HDMI/DSI 等组件，并注册 DRM 设备：

```c
sunxi_drm_mode_config_init(drm);
component_bind_all(dev, drm);
drm_dev_register(drm, 0);
```

同时，`sunxi-drm` 自己还提供 fbdev 兼容层：

```text
bsp/drivers/drm/sunxi_drmfb_core.c
bsp/drivers/drm/sunxi_fbdev_core.c
bsp/drivers/drm/sunxi_fbdev_platform.c
```

这部分是 `sunxi-drm` 内部的 fbdev compatibility，不等同于 PVR 旧 `dc_sunxi.ko`。

## 8. “同时支持 fbdev + DRM”到底是什么意思

这里要分清两种“同时支持”：

第一种是旧 IMG/PVR DDK 的兼容能力：

```text
PVR DRM/render 负责 GPU 接入
PVR Display Class + dc_sunxi 负责接旧 fbdev/disp 显示
```

这种模式下 GPU 侧可以有 DRM 设备节点，但显示输出不走 DRM/KMS。

第二种是当前 Allwinner DRM 显示栈的兼容能力：

```text
sunxi-drm 负责 KMS 显示
sunxi-drm 内部额外提供 fbdev 兼容接口
```

这种模式下显示 owner 是 DRM/KMS，fbdev 只是兼容接口。

当前 `sunxi_linux/Makefile` 选择的是第二种方向：`WINDOW_SYSTEM := nulldrmws`、`SUPPORT_DISPLAY_CLASS := 0`、`SUPPORT_KMS := 1`，并且 `dc_sunxi` 没有加入 `KERNEL_COMPONENTS`。

## 9. `DRIVER_MODESET` 是否和 `dc_sunxi` 历史遗留有关

结论：没有直接代码因果关系。

`dc_sunxi` 走的是 PVR Display Class + fbdev，注册点是 `DCRegisterDevice()`，不是 DRM plane/crtc/connector，也不依赖 PVR `drm_driver` 的 KMS object。

PVR 申请 `DRIVER_MODESET` 更像 IMG DDK 的通用 DRM 包装策略，用同一个 `pvr_drm_generic_driver` 覆盖多平台、多窗口系统、多显示接入方式。当前 `nulldrmws` 配置还会设置：

```make
SUPPORT_DISPLAY_CLASS := 0
SUPPORT_NATIVE_FENCE_SYNC := 1
SUPPORT_KMS := 1
```

但 PVR 自己的 `pvr_drm.c` 中只看到：

```c
drm_mode_config_init(ddev);
```

没有创建 Allwinner 显示栈里的 plane/crtc/connector，也没有 atomic commit 链路。因此不能因为 PVR 设置了 `DRIVER_MODESET`，就认为 PVR GPU 本身负责 scanout。

更准确地说：

```text
dc_sunxi 历史遗留
  -> 解释旧平台为什么 GPU 可走 PVR，显示却走 fbdev/disp。

PVR DRIVER_MODESET
  -> 解释 IMG DDK 的通用 DRM/KMS 兼容包装和当前 KMS/GBM/WS 配置需求。
```

二者有历史背景上的关联，但当前代码路径上没有直接因果。

## 10. 如何快速判断当前到底走哪条显示路径

不要只看是否有 `/dev/dri/cardX`，也不要只看 `DRIVER_MODESET`。真正判断显示 owner，要看以下几点：

- 如果最终进入 `fb_pan_display()`、`registered_fb[]`、`bsp/drivers/video/sunxi/disp2/disp`，这是旧 fbdev/disp 路径。
- 如果最终进入 `drm_atomic_commit()`、plane/crtc/connector、`bsp/drivers/drm/sunxi_drm_*`，这是当前 DRM/KMS 路径。
- 如果 `KERNEL_COMPONENTS` 包含 `dc_sunxi`，说明 PVR Display Class fbdev 后端参与构建。
- 如果 `WINDOW_SYSTEM := nulldrmws` 且 `SUPPORT_DISPLAY_CLASS := 0`、`SUPPORT_KMS := 1`，说明 PVR 侧倾向 DRM/KMS/GBM 路径，不走 Display Class。
- 如果 `sunxi-drm` 的 plane state 里拿到外部 dma-buf 对应的 framebuffer，说明标准 PVR render -> dma-buf -> sunxi KMS scanout 路径成立。

## 11. 最终心智模型

最重要的一句话：

```text
GPU 负责画，Display Controller 负责播；DRM 可以同时管理两者，但不强制 GPU 和显示控制器必须在同一个 DRM 驱动里。
```

在当前 SDK 里：

- PVR/BXM GPU：负责 render、GPU 内存、sync、dma-buf、PVR bridge。
- `sunxi-drm`：负责 KMS 显示对象、atomic commit、DE/TCON/接口输出。
- `dc_sunxi`：旧 fbdev/disp 时代的 PVR Display Class 桥接模块，当前 BXM 配置未启用。
- `DRIVER_MODESET`：只能说明该 DRM driver 声明了 modeset 相关能力或兼容姿态，不能单独证明实际 scanout 由它完成。

