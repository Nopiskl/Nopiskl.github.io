# Chromium webgl 加速问题
_Exported on 2026/5/8 at GMT+8 0:11:09 from Cursor (2.6.21)_

---

**User**

我的root密码是root
下面请你先帮我检查一下为什么我的chromium无法使用webgl加速？

---

**Cursor**

我先做一些只读检查，确认 Chromium、GPU、WebGL 和系统图形栈的状态，再根据结果判断是驱动、沙箱、启动参数还是虚拟化/无头环境导致的。

我看到桌面上已有 WebGL 相关脚本和说明，先读取它们并检查系统环境。

接下来我会运行诊断命令，重点看 `/dev/dri`、当前用户组、GL/Vulkan 信息、Chromium 实际启动脚本与日志。

诊断里已经看到一个关键异常：当前会话的 `root` 仍然只有 `root` 组，没有 `video/render`，因此 Chromium 进程无法打开 `/dev/dri/renderD128`。我再确认系统组配置、Chromium 启动参数和图形库实际状态。

`/etc/group` 里显示 `root` 已在 `video`，但没有看到 `render` 组包含 `root`，而当前登录会话也没刷新组。继续检查 EGL/OpenGL 是否能直接访问 GPU。

上一个 EGL 检查超时，可能是 `eglinfo` 在当前显示/DRM 环境下卡住。我改用短超时分段检查，并避免让它阻塞。

当前进程虽然 `id` 没显示新组，但因为是 `root`，对 `/dev/dri/renderD128` 实际可读写；`/etc/group` 中 `root` 已在 `render`。我继续检查 Mesa DRI 驱动和 Chromium 日志里的 GPU 初始化错误。

我还需要确认 Chromium 是怎么被系统启动的，以及内核/图形驱动有没有报错。前面日志里出现了一个很可疑的点：内核启动参数 `cma=8M`，这对 ARM GPU 图形加速通常太小，可能会导致 GPU 分配缓冲失败。

我再做最后一组内核与 GPU 设备检查，确认是否是 Mali/Panfrost 驱动、CMA 内存或 Chromium 自带库的问题。

目前基本能定位到不是单纯“缺少启动参数”。我再查一下 Chromium 是否链接到了随包的 EGL/GLES 库，以及当前是否有显示会话在运行。

检查结果显示，当前 Chromium 不能使用 WebGL 硬件加速的直接原因是：**实际运行中的 Chromium GPU 进程已经被 Chromium 自己以 `--use-gl=disabled` 启动了**，也就是 GPU GL 后端被禁用了。

关键证据：

```text
/usr/local/chromium/bin/chrome --type=gpu-process ... --use-gl=disabled ...
/usr/local/chromium/bin/chrome --type=renderer ... --disable-gpu-compositing ...
```

这说明现在不是 WebGL 页面本身的问题，而是 Chromium 启动后 GPU 初始化失败或没有拿到正确的加速参数，于是退回到禁用 GL/GPU compositing。

我看到几个具体问题。

## 1. 当前 Chromium 实际没有带上 WebGL 加速参数

你已有 `/etc/chromium-browser/default`，里面写的是：

```bash
CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--enable-gpu-rasterization \
--enable-zero-copy \
--enable-features=VaapiVideoDecoder \
--use-gl=egl \
..."
```

但实际正在运行的 Chromium 主进程是：

```text
/usr/local/chromium/bin/chrome --no-sandbox
```

没有看到 `--ignore-gpu-blocklist`、`--use-gl=egl`、`--enable-gpu-rasterization` 等参数。

原因大概率是：你平时启动的是 `/usr/local/chromium/bin/chromium-browser`，而这个启动脚本只读取 `/etc/environment`，并使用变量名 `CHROMIUM_FLAG`，不是 `CHROMIUM_FLAGS`。

也就是说：

- `/etc/chromium-browser/default` 里的 `CHROMIUM_FLAGS` 只有 `/usr/local/bin/chromium-webgl` 会读取；
- 原始 `/usr/local/chromium/bin/chromium-browser` 不读取这个文件；
- 如果桌面图标或系统启动项仍然调用 `/usr/local/chromium/bin/chromium-browser`，你的修复参数不会生效。

这是当前最明确的问题。

## 2. 当前 GPU 进程显示 GL 被禁用

运行中的 GPU 进程里有：

```text
--use-gl=disabled
```

渲染进程里有：

```text
--disable-gpu-compositing
```

这通常表示 Chromium 的 GPU 初始化失败，可能是以下原因之一：

1. 没有传入 `--use-gl=egl`；
2. GPU 被 Chromium blocklist 禁用；
3. EGL/GLES 用户态库不匹配；
4. 当前 ARM 板卡的 PVR 驱动和 Chromium 120 的 GPU 进程兼容性不好；
5. CMA 显存预留太小，导致 GPU buffer 分配失败。

## 3. 权限问题已经不是主要原因，但当前会话组信息没有刷新

系统组配置中已经有：

```text
video:x:44:guest,root
render:x:107:root
```

`/dev/dri` 设备也存在：

```text
/dev/dri/card0
/dev/dri/card1
/dev/dri/renderD128
```

`renderD128` 是：

```text
crw-rw---- root render
```

当前 shell 的 `id` 仍显示只有：

```text
groups=0(root)
```

但由于你是 `root`，实际读写 `/dev/dri/renderD128` 是可行的。因此这不是现在最主要的阻塞点。不过如果后续用普通用户启动 Chromium，就必须确保该用户在 `video` 和 `render` 组里，并重新登录。

## 4. 你的 GPU 不是 Panfrost，而是 PVR/PowerVR 驱动

内核里看到：

```text
/sys/class/drm/card1/device/driver -> .../drivers/pvrsrvkm
[drm] Initialized pvr 24.2.6603887 ...
```

也就是说 GPU 驱动是 `pvrsrvkm` / PowerVR，不是 Panfrost/Mali 开源驱动。

系统里同时存在 Mesa DRI 驱动和 PVR 用户态库：

```text
/lib/libGLESv2_PVR_MESA.so
/lib/libsrv_um.so
/lib/libusc.so
/usr/local/lib/libpvr_mesa_wsi.so
/usr/local/lib/libEGL.so
/usr/local/lib/libGLESv2.so
```

这类环境很容易因为 Chromium 使用了错误的 EGL/GLES/GBM 库而导致初始化失败。你这个 Chromium 还自带了：

```text
/usr/local/chromium/bin/libEGL.so
/usr/local/chromium/bin/libGLESv2.so
```

但启动脚本设置的是：

```bash
LD_LIBRARY_PATH=/usr/local/chromium/lib:$LD_LIBRARY_PATH
```

注意它没有把 `/usr/local/chromium/bin` 放进 `LD_LIBRARY_PATH`，而系统又有 `/usr/local/lib/libEGL.so` 和 `/lib/aarch64-linux-gnu/libEGL.so`。所以 Chromium 实际使用哪套 EGL/GLES 需要进一步确认，但这里确实存在“库选择混乱”的风险。

## 5. `cma=8M` 很可疑，可能影响硬件加速

内核启动参数里有：

```text
cma=8M
```

内存信息显示：

```text
CmaTotal: 8192 kB
CmaFree: 5604 kB
```

对 ARM 板卡的 GPU、DRM、GBM、视频解码、零拷贝来说，**8MB CMA 通常非常小**。WebGL/GPU compositing 可能需要分配连续内存 buffer，CMA 太小可能导致 GPU 初始化或 buffer 分配失败。

这不是当前唯一问题，但它是一个强烈风险点。一般 ARM 图形环境常见 CMA 是 `64M`、`128M`、`256M` 甚至更高，具体取决于板卡和显示分辨率。

## 结论

目前最可能的原因排序是：

1. **实际启动 Chromium 时没有带上加速参数**，所以 GPU 进程最后变成了 `--use-gl=disabled`。
2. **启动脚本变量不一致**：配置文件写的是 `CHROMIUM_FLAGS`，原始启动器用的是 `CHROMIUM_FLAG`。
3. **桌面/系统实际启动的不是 `/usr/local/bin/chromium-webgl`**，而是 `/usr/local/chromium/bin/chromium-browser`。
4. **PVR/PowerVR EGL/GLES 库和 Chromium 使用的库可能不匹配**。
5. **内核 `cma=8M` 太小**，可能导致 GPU buffer 分配失败。

建议下一步先修启动参数，让实际 Chromium 进程出现类似：

```text
--ignore-gpu-blocklist --use-gl=egl --enable-gpu-rasterization
```

而不是现在的：

```text
--use-gl=disabled
```

如果你愿意，我下一步可以直接帮你把启动链修好：让 `/usr/local/chromium/bin/chromium-browser` 自动读取 `/etc/chromium-browser/default`，并统一 `CHROMIUM_FLAG/CHROMIUM_FLAGS`，然后重新启动 Chromium 验证 `chrome://gpu`。

---

**User**

首先我使用的是厂商定制过的chromium，叫sunxi-chromium，然后我可以在正常通过glmark2-es2执行看到结果，请你帮我先调试一下

---

**Cursor**

明白，既然 `glmark2-es2` 能正常跑，说明内核 DRM/GPU 用户态栈至少在独立 GLES 程序里是可用的。现在重点要调试的是 `sunxi-chromium` 这套厂商 Chromium 为什么没有走同一套 EGL/GLES 加速路径。我先确认 `sunxi-chromium` 的实际二进制、启动脚本、链接库和运行日志。

系统包名确实是 `chromium-browser-sunxi`，入口不是叫 `sunxi-chromium`，而是厂商包安装的 `/usr/local/chromium/bin/chromium-browser` 和桌面启动器。我继续读取包文件列表与启动器，并跑一次 `glmark2-es2` 的库加载对比。

我已经确认厂商包名是 `chromium-browser-sunxi`，桌面入口是 `Sunxi Chromium Browser`，执行的是 `/usr/local/chromium/bin/chromium-browser`。接下来我直接检查正在运行的厂商 Chromium 进程环境和 GPU 子进程实际加载了哪些库。

这个发现很重要：厂商 Chromium 的 GPU 进程虽然命令行显示 `--use-gl=disabled`，但进程内已经加载了 PVR GPU 用户态库：

```text
/usr/lib/libGLESv2_PVR_MESA.so.24.2.6603887
/usr/lib/libsrv_um.so.24.2.6603887
/usr/lib/libpvr_dri_support.so.24.2.6603887
/usr/local/lib/libgbm.so.1.0.0
```

这说明它不是完全没接触 GPU 栈，而是 Chromium 内部最后把 GL/WebGL 判定为 disabled。我要进一步取它的启动环境、GPU 日志和 `chrome://gpu` 信息。先从已有进程的父进程环境查起。

已有进程确认是在 X11 桌面里启动的，`DISPLAY=:0.0`，所以不是无显示环境问题。我现在会用临时 profile 启动一份独立的厂商 Chromium，开启 GPU/GL 详细日志，不影响当前 profile。

日志已经抓到核心错误了：

```text
FATAL:gpu_init.cc(540)] Passthrough is not supported, GL is egl, ANGLE is
GPU process exited unexpectedly
```

这表示厂商 Chromium 默认走了 Chromium 新版的 **passthrough command decoder**，但当前使用 `--use-gl=egl` 且没有 ANGLE 后端时不支持 passthrough，于是 GPU 进程直接崩溃。现在我验证一个关键参数：强制使用旧的 validating command decoder。

`--use-cmd-decoder=validating` 没生效，GPU 进程仍然报 passthrough。我要确认这个厂商 Chromium 支持的相关开关名称，然后测试禁用 passthrough 的另一个开关。

这个厂商 Chromium 里确实有 `use-cmd-decoder`，但日志显示“validating command decoder 在这个平台不支持”，所以它仍然强制走 passthrough。那就要换思路：让 passthrough 使用 ANGLE 后端，而不是裸 `egl`。我开始测试 `--use-gl=angle --use-angle=gles`。

`--use-gl=angle --use-angle=gles` 也失败了，但错误不同：

```text
ANGLE Display::initialize error 12289: GLX is not present.
eglInitialize OpenGLES failed
```

也就是说这版 Chromium/ANGLE 在 X11 下尝试了 GLX 路径，但当前 PVR/X11 环境没有可用 GLX。现在我对比 `glmark2-es2` 实际加载库，确认它为什么能跑。

`glmark2-es2` 这个包可能是静态/延迟加载 EGL，`LD_DEBUG` 没抓到。用 `glmark2-es2-drm` 和 `strace` 更能看出它打开了哪些驱动文件。

我已经按“厂商定制版 `sunxi-chromium` / `chromium-browser-sunxi`”的方向调试了一轮，结论比较明确。

## 结论

你的 GPU / GLES 栈本身不是坏的。`glmark2-es2` 能跑，内核里 `pvrsrvkm` 也正常初始化：

```text
[drm] Initialized pvr 24.2.6603887 20170530 for 1800000.gpu on minor 1
```

真正导致 `sunxi-chromium` WebGL/GPU 加速失败的是：

**Chromium 120 的 GPU 进程默认使用 passthrough command decoder，但你当前这个厂商 PVR EGL 路径在 `--use-gl=egl` 下不支持 passthrough，于是 GPU 进程直接崩溃。**

抓到的核心日志是：

```text
FATAL:gpu_init.cc(540)] Passthrough is not supported, GL is egl, ANGLE is
ERROR:gpu_process_host.cc(992)] GPU process exited unexpectedly: exit_code=5
WARNING:gpu_process_host.cc(1362)] The GPU process has crashed 1 time(s)
```

这就是为什么你最后看到 Chromium 运行时 GPU 子进程变成：

```text
--use-gl=disabled
```

以及 renderer 进程带着：

```text
--disable-gpu-compositing
```

也就是说：**不是 GPU 没有驱动，也不是 WebGL 网站的问题，而是 Chromium GPU 初始化阶段失败后自动禁用了 GL。**

## 我验证过的几个点

### 1. 厂商 Chromium 入口

包名是：

```text
chromium-browser-sunxi 120.0.6099.224-5
```

桌面入口是：

```text
Name= Sunxi Chromium Browser
Exec=/usr/local/chromium/bin/chromium-browser
```

实际启动脚本是：

```text
/usr/local/chromium/bin/chromium-browser
```

### 2. 当前 Chromium 确实加载到了 PVR 用户态库

运行中的 GPU 进程 maps 里已经有：

```text
/usr/lib/libGLESv2_PVR_MESA.so.24.2.6603887
/usr/lib/libsrv_um.so.24.2.6603887
/usr/lib/libpvr_dri_support.so.24.2.6603887
/usr/local/lib/libgbm.so.1.0.0
/usr/lib/aarch64-linux-gnu/libdrm.so.2.4.0
```

所以它不是完全没找到 GPU 库。

### 3. 强制 `--use-gl=egl` 会触发致命错误

我用临时 profile 启动，不影响你当前用户数据：

```bash
CHROMIUM_EXT_FLAG='--ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy --use-gl=egl ...'
```

结果核心错误是：

```text
FATAL:gpu_init.cc(540)] Passthrough is not supported, GL is egl, ANGLE is
```

### 4. 尝试 `--use-cmd-decoder=validating` 没能解决

我也测试了：

```bash
--use-cmd-decoder=validating
```

但这版 Chromium 仍然报同样错误，说明它没有切到 validating decoder，或者这个平台/构建不支持 validating decoder。

二进制字符串里也有提示：

```text
Ignoring request for the validating command decoder. It is not supported on this platform.
```

### 5. 尝试 ANGLE GLES 也失败

我测试了：

```bash
--use-gl=angle --use-angle=gles
```

结果变成：

```text
ANGLE Display::initialize error 12289: GLX is not present.
eglInitialize OpenGLES failed with error EGL_NOT_INITIALIZED
```

说明在当前 X11 + PVR 环境下，ANGLE GLES 路径也走不通。

## 为什么 `glmark2-es2` 能跑但 Chromium 不行？

`glmark2-es2` 是直接 EGL/GLES 程序，路径比较简单。

而 Chromium 120 的 GPU 架构更复杂：

- GPU process
- command decoder
- ANGLE / EGL / GLES backend
- shared image
- Viz compositor
- WebGL sandbox / robustness checks

你的 PVR GLES 栈可以满足普通 GLES 程序，但 `sunxi-chromium` 这版默认组合是：

```text
passthrough command decoder + EGL + no ANGLE
```

这在当前构建里直接被 Chromium 判定为不支持：

```text
Passthrough is not supported, GL is egl, ANGLE is
```

所以 `glmark2-es2` 成功并不能保证 Chromium WebGL 一定成功。

## 当前最可能的修复方向

优先级从高到低：

### 方案 A：找到厂商推荐的 Chromium 启动参数

对这个错误而言，最关键是解决：

```text
Passthrough is not supported, GL is egl, ANGLE is
```

通常需要让 Chromium 使用合适的 command decoder / ANGLE 路径。但目前：

```bash
--use-cmd-decoder=validating
```

没有生效，`--use-gl=angle --use-angle=gles` 也失败。

所以可能需要厂商定制版对应的私有参数，或者厂商打包时有指定组合。

### 方案 B：换一个支持 non-passthrough / validating decoder 的 Chromium 构建

如果这个 `chromium-browser-sunxi 120.0.6099.224-5` 构建里 validating decoder 在该平台不可用，那启动参数可能无解。需要换厂商修过的 Chromium 包，或者降级到一个还能在 EGL 下用 validating decoder 的版本。

### 方案 C：让 Chromium 走厂商预期的 Ozone/DRM/Wayland 路径，而不是当前 X11 路径

当前桌面会话是：

```text
XDG_SESSION_TYPE=x11
DISPLAY=:0.0
```

`glmark2-es2-drm` 在本机因为 connector 问题没跑起来：

```text
Error: Failed to find a suitable connector
```

如果厂商 Chromium 主要适配的是 DRM/GBM 或 Wayland，而不是 X11 + GLX，那么当前 XFCE/X11 环境也可能不是它的最佳运行路径。

### 方案 D：检查/增加 CMA

这个不是这次日志里的直接 fatal 原因，但你系统现在：

```text
cma=8M
CmaTotal: 8192 kB
```

对 ARM GPU/GBM/WebGL 来说偏小。即使修过 passthrough 问题，后续也可能遇到 buffer 分配失败。建议最终改到至少 `cma=128M` 或 `cma=256M`，但这不是当前第一阻塞点。

## 当前阶段的明确诊断

一句话总结：

**`sunxi-chromium` 不是因为 GPU 驱动不可用而不能 WebGL；它是 GPU process 在初始化 Chromium 的 passthrough command decoder + EGL 后端时直接 fatal，导致 Chromium 自动禁用 GPU/WebGL 加速。**

核心错误就是：

```text
Passthrough is not supported, GL is egl, ANGLE is
```

下一步我建议继续做两件事之一：

1. 我帮你继续枚举测试可行的 Chromium GPU 参数组合，例如 `--ozone-platform=x11/wayland/drm`、`--use-angle=gl-egl`、`--disable-features=...` 等；
2. 我直接修改启动脚本，加入一个“调试版启动入口”，方便你反复启动并收集 `chrome://gpu` 状态。

