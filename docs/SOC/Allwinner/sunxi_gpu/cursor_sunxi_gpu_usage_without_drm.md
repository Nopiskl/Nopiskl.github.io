# Sunxi GPU usage without DRM
_Exported on 2026/4/4 at GMT+8 2:25:00 from Cursor (2.6.21)_

---

**User**

@package/libs/libgpu/ge8300 @lichee/linux-4.9/drivers/video/fbdev/sunxi 结合allwinner的sdk分析一下，为什么sunxi没有使用DRM，但是仍然能正常使用GPU？

---

**Cursor**

可以，结合你给的两个目录，这套 Allwinner SDK 的逻辑其实很清晰：

**结论先说**：  
`sunxi` 不用 DRM 也能正常用 GPU，是因为它走的是 **IMG Rogue(PowerVR) 的“私有图形栈 + fbdev 显示后端”**，不是 Mesa/DRM/KMS 那条标准 Linux 图形栈。

---

### 1) 这个 SDK 明确是 `nullws/fbdev` 路线，不是 DRM/KMS 路线

你这个 DDK 构建配置里默认窗口系统是 `nullws`（Null Window System），不是 X11/Wayland/DRM WS。  
同时包里是 `fbdev` 版用户态库（`package/libs/libgpu/ge8300/fbdev/...`），而且有 `libpvrNULL_WSEGL.so`，这就是典型的 fbdev/nullws 形态。

所以 EGL/GLES 并不依赖 `/dev/dri/card*` 或 GBM，而是走 IMG 自己的 WSEGL + DisplayClass 接口。

---

### 2) 内核里 GPU 驱动和显示驱动是“解耦 + 私有对接”

在 `img-rgx` 里可以看到两个关键模块关系：

- `pvrsrvkm`：GPU 核心服务模块（Rogue 内核驱动）
- `dc_sunxi`：Display Class 适配层（依赖 `pvrsrvkm`）

`dc_sunxi` 不是 DRM 驱动，它直接包含 `linux/fb.h`，并且代码里强依赖 `CONFIG_FB`。  
也就是说它是把 PowerVR 的显示输出对接到 Linux framebuffer（fbdev）上。

---

### 3) `dc_sunxi` 直接操作 fbdev，所以无需 DRM

`dc_sunxi` 的实现里做了这些事：

- 直接拿 `registered_fb[0]` 的 `fb_info`
- 从 `fb_info->fix.smem_start/smem_len/line_length` 获取显存信息
- 通过 `fb_pan_display()` 做翻页（page flip）
- 必要时用 `fb_set_var()` 扩 `yres_virtual` 以支持双缓冲/多缓冲

这说明显示提交路径是：

**GLES/EGL → pvrsrvkm → dc_sunxi → fbdev(sunxi disp2/lcd_fb) → 屏**

而不是：

**GLES/EGL(Mesa) → DRM/KMS(atomic) → 屏**

---

### 4) 你给的 `sunxi fbdev` 目录也印证了这一点

`lichee/linux-4.9/drivers/video/fbdev/sunxi/Makefile` 里挂的是：

- `disp2/disp`
- `lcd_fb`
- hdmi/tv/edp/eink 等 fbdev 体系

这本身就是 Allwinner 早期/定制 BSP 常见的 **DISP2 + FBDEV** 显示框架，不是 mainline 常见的 `drivers/gpu/drm/sun4i` 路线。

---

### 5) 为什么“没有 DRM 仍然正常”？

因为 GPU“能不能用”和“有没有 DRM”不是一回事：

- GPU 计算/渲染能力由 `pvrsrvkm + 用户态 libEGL/libGLESv2` 提供
- 显示扫描输出由 `sunxi fbdev` 提供
- 两者通过 `dc_sunxi` 适配层对接

所以只要这条私有链路完整，OpenGL ES/UI/视频都能跑。

---

### 6) 代价是什么？

这种方案能跑，但相对 DRM/KMS 有典型限制：

- 不走标准 atomic modeset
- 与现代 Wayland/GBM/通用 dmabuf 生态兼容性差
- 多显示/热插拔/同步机制不如 DRM 统一

但对 BSP 场景（固定硬件、追求可控和快速落地）是常见选择。

---

如果你愿意，我可以下一步帮你把这套 SDK 的完整调用链再画成一张“从应用到显示控制器”的模块图（含 `/dev` 节点和关键 ioctl/接口），你后续定位黑屏、撕裂、flip 失败会更快。

---

**User**

详细解释一下

2) 内核里 GPU 驱动和显示驱动是“解耦 + 私有对接”
在 img-rgx 里可以看到两个关键模块关系：

pvrsrvkm：GPU 核心服务模块（Rogue 内核驱动）
dc_sunxi：Display Class 适配层（依赖 pvrsrvkm）
dc_sunxi 不是 DRM 驱动，它直接包含 linux/fb.h，并且代码里强依赖 CONFIG_FB。
也就是说它是把 PowerVR 的显示输出对接到 Linux framebuffer（fbdev）上


---

**Cursor**

非常好，这一段是核心。你可以把它理解为：**GPU 驱动负责“算图”，显示驱动负责“出图”，中间靠 IMG 的私有 Display Class 接口粘起来**，而不是靠 Linux DRM/KMS 粘起来。

下面我按“模块职责 → 对接方式 → 实际调用链 → 为什么这叫解耦”来详细展开。

---

## 1) 两个模块各管什么（职责分离）

### `pvrsrvkm`（Rogue 内核核心）
它是 PowerVR 的核心内核模块，负责：

- GPU 设备管理
- 命令提交/同步
- 显存与 buffer 管理
- 给用户态 `libEGL/libGLESv2` 提供服务接口

从模块信息也能看到它是独立 GPU 模块（`platform:rgxsunxi`、`img,gpu` 设备匹配）。

---

### `dc_sunxi`（Display Class 适配层）
它不是 GPU 核心，而是把“渲染结果如何显示”这件事接到 sunxi 显示子系统上。  
关键点：

- 它依赖 `pvrsrvkm`（`depends=pvrsrvkm`）
- 它不是 DRM 驱动，而是 **fbdev 适配驱动**
- 直接 include `linux/fb.h`，并且 `#if !defined(CONFIG_FB)` 就报错退出

也就是说，`dc_sunxi` 的定位是：**把 IMG 的 DisplayClass API 翻译成 Linux framebuffer 操作**。

---

## 2) “私有对接”具体是怎么做的？

### A. 在初始化时把自己注册给 `pvrsrvkm` 的 DisplayClass 框架

`dc_sunxi` 里构造了一组 `DC_DEVICE_FUNCTIONS` 回调（如：

- `pfnContextConfigure`
- `pfnBufferAlloc`
- `pfnBufferAcquire`
- `pfnPanelQuery`
- 等）

然后调用 `DCRegisterDevice(...)` 把这套显示能力注册进去。  
这一步就是“私有对接点”——不是 DRM 的 `drm_driver` 注册，而是 IMG 自己的 DC 注册。

---

### B. 显示设备来源是 fbdev，不是 `/dev/dri/cardX`

`dc_sunxi` 初始化时直接取：

- `registered_fb[0]`
- `fb_info->var/fix`（分辨率、stride、显存起始地址、显存长度等）

还会检查 framebuffer 能否翻页（`ypan/ywrap`、`yres_virtual` 等条件）。

所以它的世界观是“系统里有 `fb0`，我就能显示”，不是“系统里有 KMS CRTC/Plane”。

---

### C. 真正切帧是 `fb_pan_display` / `fb_set_var`

在 `ContextConfigure` 中，它根据 buffer id 改 `yoffset`，然后：

- 优先 `fb_pan_display(...)` 做翻页
- 必要时 `fb_set_var(...)` 扩 `yres_virtual`

这就是典型 fbdev 双缓冲/翻页路径。

---

### D. Buffer 物理地址也直接来自 fbdev 显存信息

`BufferAcquire` 里用：

- `fix.smem_start`
- `fix.smem_len`
- `fix.line_length`

去拼每页物理地址传给 services。  
这和 DRM GEM/TTM/PRIME 那套对象模型完全不同。

---

## 3) 这条链路完整长什么样？

在你这套 SDK（A133 + ge8300）里，典型路径是：

1. 应用调用 EGL/GLES（`libEGL.so` / `libGLESv2.so`）
2. 用户态进入 IMG 用户库（`libsrv_um.so` 等）
3. 内核到 `pvrsrvkm` 做渲染与同步
4. 通过 DisplayClass 调到 `dc_sunxi`
5. `dc_sunxi` 调 fbdev（`fb_pan_display`）切到对应 buffer
6. sunxi 的 `disp2/lcd_fb` 输出到屏幕

---

## 4) 为什么这叫“解耦 + 私有对接”？

### 解耦
- **GPU 核心**（`pvrsrvkm`）不需要知道 sunxi 具体怎么扫屏
- **显示后端**（`dc_sunxi`）只实现一套 DC 回调接口即可
- 同一个 `pvrsrvkm` 可以配不同 DC 后端（`dc_fbdev`、`dc_sunxi` 等）

### 私有对接
- 对接协议是 IMG 的 DisplayClass（`DCRegisterDevice` + 一组回调）
- 不是 Linux 通用的 DRM/KMS UAPI/对象模型
- 所以系统不启 DRM 也能跑 GPU 图形

---

## 5) 再结合你包管理层的证据

`package/libs/libgpu/Makefile` 里：

- `a133 -> GPU_TYPE:=ge8300`
- 默认 `WINDOW_SYSTEM_TYPE:=fbdev`（只有 `CONFIG_WESTON_DRM=y` 才走 wayland 分支）
- 安装的是 `ge8300/fbdev/...` 下那套库和固件

这与内核 `dc_sunxi + fbdev` 路线完全一致，用户态/内核态是配套的。

---

如果你想，我下一步可以给你画一张**“模块+设备节点+数据流”的 ASCII 架构图**，再加上“若切换到 DRM 路线需要替换哪些环节”的迁移对照表。

---

**User**

结合具体package patches/SDK源码分析一下
1、allwinner的weston适配包是否有fbdev版本的？
2、A133是否能使用weston适配包的fbdev backend ？
3、A133走fbdevbackend的话是否支持GPU？
4、为什么A133有GPU+dc_sunxi桥接，可以用qt的NOEGL模式，而weston却没有fbdev+gpu的版本？

---

**Cursor**

你这个 4 连问非常好，我按你要的“结合 SDK 源码 + patches”直接给结论。

---

### 1）allwinner 的 weston 适配包是否有 fbdev 版本？

**有。**

从你 SDK 里的 `package/wayland/weston` 可以看到：

- `Config.in` 里有 `WESTON_FBDEV` 选项（默认 `n`）
- `Makefile` 里有：
  - `--enable-fbdev-compositor`（当 `WESTON_FBDEV=y`）
  - `WESTON_NATIVE_BACKEND=fbdev-backend.so`
- `weston.ini` 里也出现了 `--backend=fbdev-backend.so` 的用法（screen-share 段）

所以包本身支持编出 fbdev backend。

---

### 2）A133 是否能用这个 weston 适配包的 fbdev backend？

**能。**

但要区分：
- “能跑起来” ✅
- “能用 allwinner 那些 DE/overlay 特性” ❌（大概率不能）

因为你 `patches` 里核心 allwinner 适配（DE zorder/overlay/channel）基本都在改 `libweston/compositor-drm.c`，不是 `compositor-fbdev.c`。

---

### 3）A133 走 fbdev backend 是否支持 GPU？

**从你这套 SDK 现状看，结论是：大概率不走 GPU 合成，主要是 CPU/pixman。**

原因：
- allwinner 的 patch 重点是 DRM backend 的 plane/overlay 加速；
- 没看到针对 fbdev backend 的 GPU 合成改造；
- `dc_sunxi` 是 PVR DisplayClass ↔ fbdev 桥接，不等于 Weston fbdev 自动获得 GL 合成路径。

更严谨地说：  
理论上 fbdev backend 是否能用 GPU，要看 `EGL on fbdev` 是否完整可用并被 Weston 路径接入；你这套 SDK 没看到这条明确集成证据。

---

### 4）为什么 A133 有 GPU + `dc_sunxi`，Qt 可用 NOEGL，而 Weston 没有“fbdev+gpu”版本？

关键点在这里：**Qt 的 NOEGL 本质就是“不用 GPU/EGL”**。

- Qt NOEGL 能跑，是因为它直接走软件渲染到 framebuffer（linuxfb 思路）；
- 这跟 Weston 想要“fbdev + GPU 合成”不是一回事；
- `dc_sunxi` 的作用是给 PVR Services 的显示类桥接（到 fbdev），并不是给 Weston fbdev backend 提供一套现成的 GL/KMS 显示合成框架。

所以看起来“Qt 能（NOEGL）而 Weston 不能（fbdev+gpu）”并不矛盾，本质是两条不同技术路径。

---

如果你愿意，我可以下一步给你一份**A133 的可落地建议**（例如：  
- 继续用 `fbdev-backend + pixman` 的稳定方案，  
- 或者补齐显示 DRM/KMS 后切回你这些 allwinner DRM patches 的 DE overlay 路径）。

---

**User**

为什么qt可以这样
#qt env
export QTDIR=/usr/helperboard/qt
export LD_LIBRARY_PATH=$QTDIR/lib:/usr/lib/:$LD_LIBRARY_PATH
export QT_QPA_PLATFORM_PLUGIN_PATH=$QTDIR/plugins
export QML2_IMPORT_PATH=$QTDIR/qml
export QT_QPA_PLATFORM=linuxfb:tty=/dev/fb0
export QT_QPA_FONTDIR=/usr/share/fonts

#support gpu env
export QT_QPA_PLATFORM=eglfs
export QT_QPA_EGLFS_INTEGRATION=none

#support inputdevice env
:<<!
for InputDevices in /sys/class/input/input*
do
	event_value=`ls $InputDevices/ | grep "event*" | awk 'NR==1{print}'`
	cat $InputDevices/name 2>/dev/null | grep TSC2007
	if [ $? -eq "0" ]; then
		export TSLIB_CONSOLEDEVICE=none     
		export TSLIB_CONFFILE=/etc/ts.conf
		export TSLIB_CALIBFILE=/etc/pointercal
		export TSLIB_FBDEVICE=/dev/fb0
		export TSLIB_PLUGINDIR=/usr/lib/ts
#		export QT_QPA_EGLFS_TSLIB=1
		export QT_QPA_FB_TSLIB=1
		
		export TSLIB_TSDEVICE=/dev/input/$event_value
		if [ ! -f "/etc/pointercal" ]; then {
			export TSLIB_TSDEVICE=/dev/input/$event_value
			ts_calibrate
		}
		fi
		export QT_QPA_GENERIC_PLUGINS=tslib:/dev/input/$event_value
	fi
done
!
这样设置就可以正常使用GPU+fbdev？weston不能这样吗？
结合你之前的分析详细说一下

---

**Cursor**

你这个问题问得非常精准。先给一句核心结论：

**你这段 Qt 环境并不是“GPU+fbdev 同时启用”，而是二选一；最终生效的是 `eglfs`。**

---

### 先看你这段环境变量的关键点

你写了两次 `QT_QPA_PLATFORM`：

- 先 `linuxfb:tty=/dev/fb0`
- 后 `eglfs`

**后者会覆盖前者**，所以实际运行是 `eglfs` 路径，不是 `linuxfb` 路径。

也就是说：

- `linuxfb`：典型软件渲染直写 framebuffer（通常无 GPU）
- `eglfs`：单全屏 EGL/GLES 渲染（GPU 路径）

---

## 为什么 Qt 可以“看起来 fbdev + GPU”？

因为 Qt 的 `eglfs` 是**单应用直出模型**，常见链路是：

应用(QPainter/OpenGL) → Qt eglfs → `libEGL/libGLESv2`(厂商实现) → PVR Services → `dc_sunxi`/fbdev → 屏幕

这里“底层可能落到 fbdev 输出”，但上层模式是 **eglfs + GPU**，不是 `linuxfb + GPU`。

`QT_QPA_EGLFS_INTEGRATION=none` 的意思是：不强制用某个 Qt 专用 integration plugin，走默认 EGL 适配。只要厂商 EGL 实现能通，就能跑。

---

## 为什么 Weston 不能“照抄这种环境变量”？

因为 Weston 架构和 Qt QPA 完全不同：

1. Weston 是**合成器**（多客户端合成），需要 backend + renderer 协同；
2. 你这套 allwinner patch 主要改的是 `compositor-drm.c`（DRM backend 的 DE/plane/overlay）；
3. 不是改 `fbdev backend` 路径，所以 Weston's fbdev 后端吃不到这批硬件合成增强；
4. 没有显示 KMS 的情况下，Weston DRM backend 走不通；走 fbdev backend 又通常是 legacy/弱能力路径。

所以 Weston 不能像 Qt 一样“几个 env 就切到厂商 EGL 直出并完整受益”。

---

## 对你 4 点疑问的落地解释（对应你前文）

- Qt 能跑，是因为它可以是**单进程直出**（eglfs）
- A133 的 `dc_sunxi` 能给 PVR 提供 display class/fbdev 输出面
- 但 Weston 需要的是**合成器级后端能力**，而你现有 patch 主要绑定 DRM backend，不是 fbdev backend
- 因此出现“Qt 可用，Weston 同条件不等价可用”的现象

---

如果你愿意，我可以给你一版**A133 实机最小验证矩阵**（Qt linuxfb / Qt eglfs / Weston fbdev）和每种模式下“是否 GPU、是否多窗口合成、性能瓶颈在哪”的判定方法。

---

**User**

结合内核源码详细分析一下dc_sunxi为什么可以给 PVR 提供 display class/fbdev 输出面？

---

**Cursor**

Need read files.

Need read dc_sunxi specific lower অংশ maybe init and buffer acquire etc already got earlier from reads. Need maybe lines with registered_fb[0], DCRegisterDevice, fb_pan_display, DCDisplayConfigurationRetired. We have text. Need answer with detailed flow. maybe also compare dc_fbdev and dc_sunxi nearly same. maybe read chunk around init/exit in dc_sunxi if not available currently yes from prior reads offset580. maybe read from start with line numbers? Read tool returns no line numbers because maybe no pipe? Actually returns plain content. can't provide code reference with lines. We can avoid code blocks references. fine.

Need also show where disp2 fbdev driver in kernel. We have grep result with cmd_drivers/video/fbdev/sunxi/disp2/.. but that's build command output maybe from .cmd file not real source. better read actual source path existence. use Glob for drivers/video/fbdev/sunxi/disp2/**/dev_fb.c etc maybe in kernel tree maybe accessible. let's glob.


Need find register_framebuffer in dev_fb.c with grep simpler with exact terms maybe tool weird due regex OR? We'll use single pattern each call.

可以，结合你 SDK 里的内核源码，`dc_sunxi` 能给 PVR 提供 DisplayClass/fbdev 输出面的原因，本质是：

## 1) PVR 这套 DisplayClass 本来就是给“非原生 DRM/KMS 显示接口”准备的

在  
`lichee/linux-4.9/modules/gpu/img-rgx/linux/rogue_km/services/include/kerneldisplay.h`  
文件头就写得很清楚：这个接口用于 **3rd party display driver 不使用 Linux DRM/KMS 时** 的集成。

它定义了一整套 `DC_DEVICE_FUNCTIONS` 回调（必须实现的包括）：
- `pfnPanelQuery`
- `pfnFormatQuery`
- `pfnContextCreate/Destroy`
- `pfnContextConfigure`
- `pfnBufferAlloc/Acquire/Release/Free`
并通过 `DCRegisterDevice()` 把这套回调注册给 Services。

也就是说：**只要你把“某个显示子系统”包装成这些回调，PVR 就能把它当 display device 用。**

---

## 2) `dc_sunxi` 做的事情就是把这套回调“翻译”为 fbdev 操作

在  
`.../services/3rdparty/dc_sunxi/dc_sunxi.c`  
里可以看到典型桥接逻辑（你前面也看过）：

- 依赖 `linux/fb.h`，并要求 `CONFIG_FB`
- init 时拿 `registered_fb[0]`（即系统 fb0 对应的 `fb_info`）
- 根据 `fb_info->var/fix` 读取分辨率、像素格式、stride、显存范围
- 用 `DCRegisterDevice(&sDCFunctions, ...)` 把 `dc_sunxi` 注册给 PVR Services
- `ContextConfigure` 最终调用 `fb_pan_display` / `fb_set_var` 做翻页显示
- 配置完成后调用 `DCDisplayConfigurationRetired(...)` 告诉 Services “这帧配置退休了，可以继续队列”

这就是“DisplayClass -> fbdev”的关键桥。

---

## 3) 为什么它能落到 sunxi 的 disp2 输出

你的显示驱动在：
`lichee/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c`  
和对应 `Makefile`（`CONFIG_DISP2_SUNXI`）里。

这条驱动链负责提供 fbdev 设备（`/dev/fb0` 背后的 `fb_info`、显存映射、fb ops 等），而 `dc_sunxi` 正是绑定这个 `fb_info`。

所以数据链就是：

**PVR Services DisplayClass**  
→ `dc_sunxi` 回调层  
→ `fbdev(fb0)`  
→ `sunxi disp2/DE` 硬件输出

---

## 4) 再补一层：为什么这叫“输出面（scanout surface）”

`dc_sunxi` 的 `BufferAcquire` 会把显示 buffer 转成设备可访问的物理页地址（基于 `smem_start/screen_base`），`ContextConfigure` 决定当前显示哪个 buffer（通过 yoffset/pan）。  
这正是显示控制器 scanout 所需的“可扫描内存面”。

所以它不是 KMS plane 模型，但在 PVR DisplayClass 语义里，**它已经是一个可配置的 display surface provider**。

---

一句话总结：  
**`dc_sunxi` 能工作的根本不是“它懂 DRM”，而是“它把 sunxi fbdev（disp2）完整适配成了 PVR DisplayClass 所要求的回调协议”。**

---

**User**

为什么PVR的GPU驱动不需要依赖DRM显示框架？

---

**Cursor**

因为在这套架构里，**PVR 把“渲染”和“显示控制”解耦了**。

核心点：

1. **GPU 驱动的核心职责是渲染/内存/同步，不是必须做显示控制**  
   PVR Services 负责提交命令、管理 buffer、同步 fence 等，这部分不要求一定挂在显示 DRM/KMS 上。

2. **PVR 有自己的内核接口层（Services + Bridge + DisplayClass）**  
   它可以通过 `DCRegisterDevice` 对接一个“显示后端”，这个后端可以是：
   - DRM/KMS（如果平台有）
   - 也可以是 fbdev（你这边的 `dc_sunxi`）

3. **`dc_sunxi` 已经把 fbdev/disp2 封装成可用显示设备**  
   所以 PVR 不需要“显示 DRM”也能完成上屏链路：
   GPU 渲染结果 -> PVR DisplayClass -> `dc_sunxi` -> fbdev -> disp2

4. **DRM 在你平台上更多是“GPU 节点入口”，不是完整显示栈入口**  
   即使有 `card0`，也不代表它必须承担完整 KMS 显示职责。

---

一句话总结：  
**PVR 不是“不需要显示”，而是“不强制依赖 DRM 显示框架”；它可以通过 DisplayClass 适配层改走 fbdev/disp2。**

---

**User**

根据当前内核ge8300相关分析一下该GPU驱动注册时是否依赖DRM子系统

---

**Cursor**

Need read Kbuild.mk and pvr_platform_drv.c, pvr_drm.c already. Also ge8300 maybe in dts or config. search ge8300 string globally maybe no results due tool limitations. Use Grep on path with pattern ge8300 maybe none.

Need read tail of pvr_platform_drv for late_initcall.

是，**按你当前 A133/GE8300（RGX）这套内核源码，GPU 驱动在“注册阶段”明确依赖 DRM 子系统**。  
我基于你 SDK 里现有源码给结论如下：

## 结论
- **依赖 DRM（用于驱动注册、设备节点、ioctl 框架）**：是
- **依赖 DRM 显示/KMS（用于上屏）**：不一定；你这套显示走 `dc_sunxi + fbdev(disp2)`

---

## 证据链（来自当前源码）

1. `pvr_platform_drv.c`
- `late_initcall(pvr_init)`
- `pvr_init()` 里把 `pvr_drm_platform_driver = pvr_drm_generic_driver`
- `pvr_probe()` 里直接调用：
  - `drm_dev_alloc(...)`
  - `drm_dev_register(...)`
  - 老内核分支是 `drm_platform_init(...)`

这说明它注册设备就是走 DRM core。

2. `pvr_drm.c`
- 定义 `const struct drm_driver pvr_drm_generic_driver`
- `driver_features = DRIVER_MODESET | DRIVER_RENDER`
- 挂载 DRM ioctl 表（含 `DRM_IOCTL_DEF_DRV(PVR_SRVKM_CMD, ...)`）

说明该模块本体就是一个 DRM driver 形态。

3. `pvr_drv.h`
- 直接 `#include <drm/drmP.h>`

4. 编译产物命令文件（`.pvr_drm.o.cmd` / `.pvr_platform_drv.o.cmd`）
- 依赖头里包含 `include/drm/drmP.h`、`include/uapi/drm/drm.h`
- 证明构建层面也是 DRM 依赖。

---

## 你关心的“矛盾点”怎么理解

不矛盾：  
- **GPU 驱动注册**：依赖 DRM（这点是“是”）  
- **显示输出链路**：可以不走显示 DRM/KMS，而走 `dc_sunxi` 对接 fbdev/disp2（这点也是“是”）

所以准确说法是：

**GE8300/PVR 在你这套 BSP 是“DRM 注册 + DisplayClass/fbdev 显示桥接”的混合架构。**

---

**User**

结合驱动具体源码分析一下，为什么它走DRM框架注册但是还是可以不依赖DRM显示？

---

**Cursor**

你这个问题可以用一句话先概括：

**它把 DRM 当“GPU 设备注册/用户态入口框架”，把显示输出当“DisplayClass + fbdev 后端”来做，所以两者解耦。**

结合你当前 SDK 源码，具体是这样：

---

## 1) 为什么说“注册走 DRM”

在 `pvr_platform_drv.c` / `pvr_drm.c` 里，GPU 驱动注册路径明确是 DRM：

- `pvr_probe()` 调 `drm_dev_alloc()` + `drm_dev_register()`
- `pvr_drm_generic_driver` 是 `struct drm_driver`
- `file_operations` 走 `drm_open/drm_ioctl/drm_poll/...`
- 这部分主要把 `pvrsrvkm` 暴露为 `/dev/dri/cardX`（以及 render 节点）

也就是说：**DRM 在这里首先是“设备节点 + ioctl 框架”**。

---

## 2) 为什么说“显示不依赖 DRM/KMS”

关键在 `kerneldisplay.h` 的设计说明：

- 它明写了这套接口用于“3rd-party display driver 不使用 Linux DRM/KMS API”的场景。
- 通过 `DCRegisterDevice()` 注册一套 `DC_DEVICE_FUNCTIONS` 回调，Services 就能驱动显示，不要求 KMS CRTC/connector/plane。

所以：**PVR 的显示路径是可插拔的**，可接 DRM/KMS，也可接 fbdev。

---

## 3) 你这个平台接的是 `dc_sunxi`（fbdev 后端）

在 `services/3rdparty/dc_sunxi/dc_sunxi.c` 里：

- 依赖 `linux/fb.h`，且强制 `CONFIG_FB`
- init 时直接取 `registered_fb[0]`
- 构造 `sDCFunctions`（`pfnGetInfo/pfnPanelQuery/pfnContextConfigure/pfnBufferAcquire...`）
- 调 `DCRegisterDevice(...)` 把自己挂到 PVR Services
- 显示切换用 `fb_pan_display()` / `fb_set_var()`
- 退出时 `DCUnregisterDevice(...)`

这说明它是 **DisplayClass -> fbdev** 适配，不是 KMS atomic/modeset 路径。

---

## 4) 为什么“看起来矛盾”：`DRIVER_MODESET` 也设置了

`pvr_drm.c` 里 `driver_features` 包含 `DRIVER_MODESET | DRIVER_RENDER`，但你要看“实际实现内容”：

- 该驱动核心 ioctl 是 `DRM_IOCTL_PVR_SRVKM_CMD`（PVR bridge）
- 并没有看到完整 sunxi 显示 KMS 那套对象创建/显示管线实现（connector/crtc/encoder/plane 完整栈）
- 真正显示输出是 `dc_sunxi` 对 fbdev 的调用在做

所以它更像是：  
**DRM 外壳 + PVR 服务入口**，显示由 **DisplayClass 后端** 承担。

---

## 5) 最终架构图（你这套 BSP）

- GPU 注册/访问：`pvr_platform_drv` + `pvr_drm`（DRM）
- 渲染服务核心：`pvrsrvkm` / Services
- 显示后端：`dc_sunxi`
- 扫描输出：`fb0 -> sunxi disp2`

所以“走 DRM 注册但不依赖 DRM 显示”在这套代码里是完全成立的。

