# Chromium VPU acceleration检查
_Exported on 2026/5/8 at GMT+8 0:51:46 from Cursor (2.6.21)_

---

**User**

我的root密码是root
下面请你先帮我检查一下为什么我的chromium是否启用了VPU加速？我使用的是厂商定制过的chromium，系统包名确实是 chromium-browser-sunxi，是厂商包安装的 /usr/local/chromium/bin/chromium-browser 和桌面启动器

---

**Cursor**

我会先检查 Chromium 启动器、实际二进制/包装脚本、包信息和运行时能力，再尽量通过 Chromium 自身诊断页面或命令行日志判断是否启用了硬件视频解码/VPU。

终端状态路径在当前环境里不是标准 Linux 路径；我先直接检查系统中的 Chromium 文件和包状态。

启动脚本支持通过环境变量打开媒体模块日志；接下来我会检查默认环境变量、包版本、二进制编译特征，以及系统是否有 VPU/视频解码设备节点。

当前文件浏览结果显示 `/dev` 下信息异常少，可能是当前会话的设备视图受限；我会用系统命令再交叉确认包、进程和设备节点。

我发现已有一个安装相关命令还在运行，但它与当前 Chromium 检查不是同一个任务。我会继续用只读命令收集关键诊断信息。

初步看，系统有 `/dev/cedar_dev`、`/dev/cedar_dev_ve2`、`/dev/media0` 和 `/dev/dma_heap`，这说明内核侧确实暴露了 Allwinner/Sunxi 视频硬件相关节点。下一步我会确认 Chromium 是否编译/链接了厂商解码路径，以及运行时是否真的走到这些路径。

二进制里已经能看到厂商路径关键词：`kVmxCedarc`、`VmxGstAudioCedarc`、`VmxGstVideoDecoder`，并且链接了 GStreamer/GBM/DRM。这说明这个 Chromium 包“具备厂商 VPU 解码适配代码”，但还不能证明播放时已经启用。现在我会检查 GStreamer 的厂商插件和 Chromium 特性开关。

当前会话没有 `DISPLAY`，所以不能直接读取已打开桌面会话里的 `chrome://gpu`；我会尝试定位本机图形会话并用临时 profile 启动一次带媒体日志的 Chromium，以便得到运行时证据。

我会在桌面 X11 会话 `:0` 下用临时用户数据目录启动一次 Chromium，避免改动现有 profile，并抓取 `chrome://gpu` 以及媒体/厂商模块日志。

这次临时启动显示 Chromium GPU 进程初始化失败：`GLX is not present`、`Initialization of all EGL display types failed`。这会影响 `chrome://gpu` 以及很多硬件加速路径判断。为避免误判，我再检查 OpenMAX/厂商解码组件和系统媒体插件配置。

检查结果：**你的 `chromium-browser-sunxi` 很可能“具备”厂商 VPU/硬解适配，但我目前不能证明“正在播放时已经启用 VPU 加速”。从当前实测看，自动启动诊断时 Chromium 的 GPU 进程初始化失败，因此当前运行态硬件加速状态不理想。**

关键发现如下。

1. **包和启动器确认无误**

- 已安装包：`chromium-browser-sunxi 120.0.6099.224-5 arm64`
- 桌面启动器：`/usr/share/applications/chromium-browser.desktop`
- 实际执行：`/usr/local/chromium/bin/chromium-browser`
- Chromium 版本：`Chromium 120.0.6099.224`

启动脚本默认只追加了：

```bash
--no-sandbox
```

也就是说桌面启动器本身没有显式加 `--enable-features=VaapiVideoDecoder`、`--ignore-gpu-blocklist` 之类参数。

2. **系统侧 VPU/媒体节点存在**

检测到这些关键设备节点：

- `/dev/cedar_dev`
- `/dev/cedar_dev_ve2`
- `/dev/media0`
- `/dev/dma_heap/system`
- `/dev/dma_heap/reserved`
- `/dev/dri/renderD128`

这说明内核/设备树侧确实暴露了 Sunxi/Allwinner 视频硬件相关接口。

但权限是：

- `/dev/cedar_dev`：`crw------- root root`
- `/dev/cedar_dev_ve2`：`crw------- root root`
- `/dev/dma_heap/*`：`crw------- root root`

你当前图形会话是 root，所以理论上能访问；但如果以后用普通用户启动 Chromium，**很可能因为权限问题无法用 VPU**。

3. **Chromium 二进制里确实有厂商硬解路径痕迹**

在 `/usr/local/chromium/bin/chrome` 里检出了这些字符串：

- `kVmxCedarc`
- `VmxGstAudioCedarc`
- `VmxGstVideoDecoder`
- `V4L2VideoDecoder`
- `VaapiVideoDecoder`
- `GStreamer`
- `libgstreamer-1.0.so.0`

这基本说明：**厂商 Chromium 并不是普通 Debian Chromium，它编进了 Vmx/Cedarc/GStreamer 相关适配。**

4. **GStreamer / OpenMAX Allwinner 硬解组件存在**

系统里有：

- `/usr/lib/aarch64-linux-gnu/libOmxCore.so`
- `/usr/lib/aarch64-linux-gnu/libOmxVdec.so`
- `/usr/lib/aarch64-linux-gnu/libvdecoder.so`
- `/usr/lib/aarch64-linux-gnu/libvideoengine.so`
- `/usr/lib/aarch64-linux-gnu/gstreamer-1.0/libgstomx-allwinner.so`
- `/etc/xdg/gstomx.conf`

`gstomx.conf` 里有 Allwinner 硬解组件配置，例如：

- `OMX.allwinner.video.decoder.avc`，H.264
- `OMX.allwinner.video.decoder.hevc`，H.265/HEVC
- `OMX.allwinner.video.decoder.vp8`
- `OMX.allwinner.video.decoder.vp9`
- `OMX.allwinner.video.decoder.mpeg2`
- `OMX.allwinner.video.decoder.mjpeg`

所以 **系统媒体栈具备 Allwinner VPU 解码能力**。

5. **但 Chromium 运行态 GPU 初始化失败**

我用临时 profile 在 `DISPLAY=:0` 下启动了 Chromium 诊断，结果出现了这些错误：

```text
ANGLE Display::initialize error 12289: GLX is not present.
eglInitialize OpenGL failed with error EGL_NOT_INITIALIZED
eglInitialize OpenGLES failed with error EGL_NOT_INITIALIZED
Initialization of all EGL display types failed.
GLDisplayEGL::Initialize failed.
Exiting GPU process due to errors during initialization
```

这说明至少在我这次自动诊断启动方式下：

- Chromium GPU 进程没有正常起来；
- `chrome://gpu` 这类结果会不可靠；
- 视频硬解是否真正工作，不能只凭二进制和插件存在来下结论。

6. **当前结论**

综合判断：

- **内核侧：有 VPU 设备节点。**
- **系统媒体栈：有 Allwinner OpenMAX/GStreamer VPU 解码插件。**
- **Chromium 包：有 Vmx/Cedarc/GStreamer 厂商硬解适配代码。**
- **默认桌面启动器：没有显式开启额外硬解 flags。**
- **实测运行态：GPU 进程初始化失败；尚未观察到实际播放时打开 `/dev/cedar_dev` 或使用 `VmxGstVideoDecoder`。**

所以目前最准确的结论是：

> 你的 Chromium **具备 VPU 加速条件和厂商适配代码**，但我还没有确认它在实际视频播放时已经启用了 VPU。当前自动诊断看到 GPU/EGL 初始化失败，这可能导致硬件加速路径回退或不可用。

建议下一步做一个“播放时实测”。可以在桌面终端执行：

```bash
DISPLAY=:0 \
CHROMIUM_DEBUG=1 \
LOG_LEVEL=0 \
VLOG_LEVEL=1 \
MODULE_LEVEL=3 \
CHROMIUM_EXT_FLAG="--ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --autoplay-policy=no-user-gesture-required" \
/usr/local/chromium/bin/chromium-browser
```

然后打开一个本地 H.264/H.265 视频页面播放，再看：

```bash
lsof /dev/cedar_dev /dev/cedar_dev_ve2 /dev/dma_heap/system /dev/dma_heap/reserved 2>/dev/null
```

以及日志里是否出现：

```text
VmxGstVideoDecoder
Cedarc
OMX.allwinner.video.decoder
hardware decoder
```

如果你给我一个本地测试视频路径，或者允许我创建一个本地 HTML 播放测试页，我可以继续帮你做“播放中是否真的打开 VPU 设备”的确认。

---

**User**

我的root密码是root，我在显示屏所在环境中启动了chrome，你能否根据chromium运行时输出或者自带chrome://分析一下？

---

**Cursor**

可以。我会先查看当前正在运行的 Chromium 进程参数、调试日志位置和是否开启了远程调试端口；如果能连上 DevTools，会直接读取 `chrome://gpu` / `chrome://media-internals` 信息，否则从运行时日志和进程打开的设备节点判断。

我已经看到正在运行的 Chromium 进程。关键点是：它没有开启远程调试端口，所以不能直接通过 DevTools 协议读取 `chrome://gpu`；但从进程参数和设备节点已经能判断一部分状态。我再读取 Chromium profile 中保存的 GPU 特性状态。

我再深入确认当前运行进程的实际文件句柄和 GPU/媒体相关状态；这不会重启或改动你已打开的 Chrome。

从当前进程已经看到比较关键的运行态证据：GPU 进程存在，但它是以 `--use-gl=disabled` 启动的，同时 renderer 有 `--disable-gpu-compositing`。我再找一下你启动它的终端输出，确认是否有 EGL/GPU 初始化失败日志。

我已经从当前运行中的 Chromium 进程拿到了主要运行态证据。为了确认“是否正在用 VPU”，我再检查一次当前页面/媒体数据库和 Chromium profile 设置。

可以，我已经根据你当前显示屏环境中正在运行的 Chromium 进程做了运行态分析。结论比较明确：

## 当前这个 Chromium 没有真正启用视频硬件/VPU 解码

从运行中的进程看，主进程是：

```text
/usr/local/chromium/bin/chrome --no-sandbox
```

也就是你是通过厂商脚本默认方式启动的，没有额外硬解相关参数。

关键证据是 GPU 进程：

```text
/usr/local/chromium/bin/chrome --type=gpu-process ... --use-gl=disabled
```

并且渲染进程里出现了：

```text
--disable-gpu-compositing
```

这两个参数非常关键：

- `--use-gl=disabled`：说明 Chromium 当前没有启用 GL/GLES 渲染路径。
- `--disable-gpu-compositing`：说明 GPU 合成也被禁用了。
- GPU 进程虽然存在，但它处于禁用 GL 的退化状态。

这通常对应 `chrome://gpu` 里会看到类似：

```text
Canvas: Software only
Compositing: Software only
Video Decode: Software only / disabled
WebGL: disabled / unavailable
```

## 当前没有看到 VPU 设备被 Chromium 打开

我检查了当前 Chromium 进程打开的设备节点。

GPU 进程打开了：

```text
/dev/dri/card0
/dev/dri/renderD128
```

但是没有任何 Chromium 进程打开：

```text
/dev/cedar_dev
/dev/cedar_dev_ve2
/dev/dma_heap/system
/dev/dma_heap/reserved
/dev/media0
```

对于 Allwinner/Sunxi 这类平台，如果真的在走 Cedar/VPU 硬解，播放视频时通常会看到 Chromium 或其媒体/GPU 子进程打开 `/dev/cedar_dev`、`/dev/cedar_dev_ve2`、`/dev/dma_heap/*` 等节点。

当前没有看到这些打开记录，所以从运行态看：**现在没有实际走 VPU 解码。**

## 当前没有开启调试日志或 DevTools 远程端口

我也检查了：

- 没有 `chrome_debug.log`
- 没有监听 `9222` / `9223` 之类 DevTools 远程调试端口
- 当前命令行没有 `--remote-debugging-port`

所以我不能直接从外部抓取 `chrome://gpu` 或 `chrome://media-internals` 的页面内容。

你可以在当前 Chromium 地址栏手动打开：

```text
chrome://gpu
```

重点看这些条目：

```text
Graphics Feature Status
Video Decode
Video Encode
Compositing
OpenGL
WebGL
WebGL2
```

如果我的判断正确，大概率会看到 `Video Decode` 不是 `Hardware accelerated`。

再打开：

```text
chrome://media-internals
```

播放一个视频后，点开对应播放器项，重点找：

```text
kVideoDecoderName
video_decoder
pipeline_state
```

如果是软件解码，可能会看到：

```text
FFmpegVideoDecoder
VpxVideoDecoder
Dav1dVideoDecoder
```

如果真的走厂商硬解，才可能看到类似：

```text
VmxGstVideoDecoder
Vmx
Cedarc
OMX.allwinner
```

## 当前判断

你的系统和 Chromium 包本身是有厂商 VPU 适配基础的：

- 有 `/dev/cedar_dev`
- 有 `/dev/cedar_dev_ve2`
- 有 Allwinner OpenMAX/GStreamer 插件
- Chromium 二进制里有 `VmxGstVideoDecoder` / `Cedarc` 字符串

但你当前正在运行的这个 Chromium 实例：

```text
--use-gl=disabled
--disable-gpu-compositing
没有打开 cedar/dma_heap 设备
没有媒体硬解日志
```

所以结论是：

> **当前运行中的 Chromium 没有实际启用 VPU 视频解码，至少现在没有证据表明它正在使用 VPU。更像是退回到了软件渲染/软件解码路径。**

## 建议你下一次这样启动，方便我继续分析

请关闭当前 Chromium，然后在显示屏所在终端里启动：

```bash
CHROMIUM_DEBUG=1 \
LOG_LEVEL=0 \
VLOG_LEVEL=1 \
MODULE_LEVEL=3 \
DEBUG_PORT=9222 \
CHROMIUM_EXT_FLAG="--ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --enable-features=VaapiVideoDecoder --autoplay-policy=no-user-gesture-required" \
/usr/local/chromium/bin/chromium-browser
```

然后播放一个本地 H.264/H.265 视频。

这样我就可以继续帮你检查：

- `chrome://gpu`
- `chrome://media-internals`
- `/root/.config/chromium/chrome_debug.log`
- 是否打开 `/dev/cedar_dev`
- 是否出现 `VmxGstVideoDecoder` / `Cedarc` / `OMX.allwinner.video.decoder.*`

目前这次运行态结果已经能说明：**默认启动方式下没有成功启用 VPU 硬解。**

---

**User**

我已经按要求播放了，root@localhost:~/Desktop# CHROMIUM_DEBUG=1 \
LOG_LEVEL=0 \
VLOG_LEVEL=1 \
MODULE_LEVEL=3 \
DEBUG_PORT=9222 \
CHROMIUM_EXT_FLAG="--ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --enable-features=VaapiVideoDecoder --autoplay-policy=no-user-gesture-required" \
/usr/local/chromium/bin/chromium-browser
Launching the chromium browser with extended flags --ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --enable-features=VaapiVideoDecoder --autoplay-policy=no-user-gesture-required
Launching the chromium browser with debugging flags
chromium flags:  --no-sandbox --enable-logging --log-level=0 --v=1 --vmodule=/*media/*=3,/*Vmx/*=3,/*Cedarc/*=3,/*GST/*=3 --remote-debugging-port=9222 --ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --enable-features=VaapiVideoDecoder --autoplay-policy=no-user-gesture-required
[37130:37130:0507/164633.725824:FATAL:spawn_subprocess.cc(236)] posix_spawn: No such file or directory (2)
[37123:37138:0507/164633.962034:ERROR:bus.cc(407)] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")
[37123:37138:0507/164633.962246:ERROR:bus.cc(407)] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")
[37123:37138:0507/164633.962428:ERROR:bus.cc(407)] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")
[37123:37138:0507/164633.962548:ERROR:bus.cc(407)] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")
[37123:37123:0507/164633.972761:ERROR:policy_logger.cc(156)] :components/enterprise/browser/controller/chrome_browser_cloud_management_controller.cc(161) Cloud management controller initialization aborted as CBCM is not enabled. Please use the `--enable-chrome-browser-cloud-management` command line flag to enable it if you are not using the official Google Chrome build.
[37123:37138:0507/164634.002813:ERROR:bus.cc(407)] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")
[37123:37138:0507/164634.003062:ERROR:bus.cc(407)] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")
[37153:37153:0507/164634.017587:ERROR:angle_platform_impl.cc(44)] Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
ERR: Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
[37153:37153:0507/164634.018163:ERROR:gl_display.cc(515)] EGL Driver message (Critical) eglInitialize: GLX is not present.
[37153:37153:0507/164634.018432:ERROR:gl_display.cc(786)] eglInitialize OpenGL failed with error EGL_NOT_INITIALIZED, trying next display type
[37153:37153:0507/164634.019390:ERROR:angle_platform_impl.cc(44)] Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
ERR: Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
[37153:37153:0507/164634.019776:ERROR:gl_display.cc(515)] EGL Driver message (Critical) eglInitialize: GLX is not present.
[37153:37153:0507/164634.020148:ERROR:gl_display.cc(786)] eglInitialize OpenGLES failed with error EGL_NOT_INITIALIZED
[37153:37153:0507/164634.020602:ERROR:gl_display.cc(820)] Initialization of all EGL display types failed.
[37153:37153:0507/164634.020931:ERROR:gl_ozone_egl.cc(26)] GLDisplayEGL::Initialize failed.
[37153:37153:0507/164634.022281:ERROR:angle_platform_impl.cc(44)] Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
ERR: Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
[37153:37153:0507/164634.022798:ERROR:gl_display.cc(515)] EGL Driver message (Critical) eglInitialize: GLX is not present.
[37153:37153:0507/164634.023364:ERROR:gl_display.cc(786)] eglInitialize OpenGL failed with error EGL_NOT_INITIALIZED, trying next display type
[37153:37153:0507/164634.024255:ERROR:angle_platform_impl.cc(44)] Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
ERR: Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
[37153:37153:0507/164634.024776:ERROR:gl_display.cc(515)] EGL Driver message (Critical) eglInitialize: GLX is not present.
[37153:37153:0507/164634.025042:ERROR:gl_display.cc(786)] eglInitialize OpenGLES failed with error EGL_NOT_INITIALIZED
[37153:37153:0507/164634.025230:ERROR:gl_display.cc(820)] Initialization of all EGL display types failed.
[37153:37153:0507/164634.026240:ERROR:gl_ozone_egl.cc(26)] GLDisplayEGL::Initialize failed.
[37153:37153:0507/164634.037227:ERROR:viz_main_impl.cc(196)] Exiting GPU process due to errors during initialization

DevTools listening on ws://127.0.0.1:9222/devtools/browser/d499892d-0e35-478b-8f81-8104e3ad1713
[37123:37138:0507/164634.084928:ERROR:bus.cc(407)] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")
[37123:37138:0507/164634.085043:ERROR:bus.cc(407)] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")
[37123:37217:0507/164634.381181:ERROR:object_proxy.cc(577)] Failed to call method: org.freedesktop.DBus.Properties.Get: object_path= /org/freedesktop/UPower: org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.UPower was not provided by any .service files
[37123:37217:0507/164634.383091:ERROR:object_proxy.cc(577)] Failed to call method: org.freedesktop.UPower.GetDisplayDevice: object_path= /org/freedesktop/UPower: org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.UPower was not provided by any .service files
[37123:37217:0507/164634.385378:ERROR:object_proxy.cc(577)] Failed to call method: org.freedesktop.UPower.EnumerateDevices: object_path= /org/freedesktop/UPower: org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.UPower was not provided by any .service files
[37210:37210:0507/164634.427465:ERROR:angle_platform_impl.cc(44)] Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
ERR: Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
[37210:37210:0507/164634.428165:ERROR:gl_display.cc(515)] EGL Driver message (Critical) eglInitialize: GLX is not present.
[37210:37210:0507/164634.428456:ERROR:gl_display.cc(786)] eglInitialize OpenGL failed with error EGL_NOT_INITIALIZED, trying next display type
[37210:37210:0507/164634.432409:ERROR:angle_platform_impl.cc(44)] Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
ERR: Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
[37210:37210:0507/164634.432844:ERROR:gl_display.cc(515)] EGL Driver message (Critical) eglInitialize: GLX is not present.
[37210:37210:0507/164634.433177:ERROR:gl_display.cc(786)] eglInitialize OpenGLES failed with error EGL_NOT_INITIALIZED
[37210:37210:0507/164634.433412:ERROR:gl_display.cc(820)] Initialization of all EGL display types failed.
[37210:37210:0507/164634.433624:ERROR:gl_ozone_egl.cc(26)] GLDisplayEGL::Initialize failed.
[37210:37210:0507/164634.434984:ERROR:angle_platform_impl.cc(44)] Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
ERR: Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
[37210:37210:0507/164634.435480:ERROR:gl_display.cc(515)] EGL Driver message (Critical) eglInitialize: GLX is not present.
[37210:37210:0507/164634.435730:ERROR:gl_display.cc(786)] eglInitialize OpenGL failed with error EGL_NOT_INITIALIZED, trying next display type
[37210:37210:0507/164634.436240:ERROR:angle_platform_impl.cc(44)] Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
ERR: Display.cpp:1052 (initialize): ANGLE Display::initialize error 12289: GLX is not present.
[37210:37210:0507/164634.436461:ERROR:gl_display.cc(515)] EGL Driver message (Critical) eglInitialize: GLX is not present.
[37210:37210:0507/164634.436579:ERROR:gl_display.cc(786)] eglInitialize OpenGLES failed with error EGL_NOT_INITIALIZED
[37210:37210:0507/164634.436699:ERROR:gl_display.cc(820)] Initialization of all EGL display types failed.
[37210:37210:0507/164634.436819:ERROR:gl_ozone_egl.cc(26)] GLDisplayEGL::Initialize failed.
[37210:37210:0507/164634.469175:ERROR:viz_main_impl.cc(196)] Exiting GPU process due to errors during initialization
[37224:37224:0507/164634.529170:ERROR:angle_platform_impl.cc(44)] Display.cpp:1052 (initialize): ANGLE Display::initialize error 0: Internal Vulkan error (-3): Initialization of an object could not be completed for implementation-specific reasons, in ../../../src/third_party/angle/src/libANGLE/renderer/vulkan/RendererVk.cpp, initialize:1711.
ERR: Display.cpp:1052 (initialize): ANGLE Display::initialize error 0: Internal Vulkan error (-3): Initialization of an object could not be completed for implementation-specific reasons, in ../../../src/third_party/angle/src/libANGLE/renderer/vulkan/RendererVk.cpp, initialize:1711.
[37224:37224:0507/164634.529581:ERROR:gl_display.cc(515)] EGL Driver message (Critical) eglInitialize: Internal Vulkan error (-3): Initialization of an object could not be completed for implementation-specific reasons, in ../../../src/third_party/angle/src/libANGLE/renderer/vulkan/RendererVk.cpp, initialize:1711.
[37224:37224:0507/164634.529711:ERROR:gl_display.cc(786)] eglInitialize SwANGLE failed with error EGL_NOT_INITIALIZED
[37224:37224:0507/164634.529909:ERROR:gl_display.cc(820)] Initialization of all EGL display types failed.
[37224:37224:0507/164634.530014:ERROR:gl_ozone_egl.cc(26)] GLDisplayEGL::Initialize failed.
[37224:37224:0507/164634.531689:ERROR:angle_platform_impl.cc(44)] Display.cpp:1052 (initialize): ANGLE Display::initialize error 0: Internal Vulkan error (-3): Initialization of an object could not be completed for implementation-specific reasons, in ../../../src/third_party/angle/src/libANGLE/renderer/vulkan/RendererVk.cpp, initialize:1711.
ERR: Display.cpp:1052 (initialize): ANGLE Display::initialize error 0: Internal Vulkan error (-3): Initialization of an object could not be completed for implementation-specific reasons, in ../../../src/third_party/angle/src/libANGLE/renderer/vulkan/RendererVk.cpp, initialize:1711.
[37224:37224:0507/164634.531877:ERROR:gl_display.cc(515)] EGL Driver message (Critical) eglInitialize: Internal Vulkan error (-3): Initialization of an object could not be completed for implementation-specific reasons, in ../../../src/third_party/angle/src/libANGLE/renderer/vulkan/RendererVk.cpp, initialize:1711.
[37224:37224:0507/164634.532033:ERROR:gl_display.cc(786)] eglInitialize SwANGLE failed with error EGL_NOT_INITIALIZED
[37224:37224:0507/164634.532139:ERROR:gl_display.cc(820)] Initialization of all EGL display types failed.
[37224:37224:0507/164634.532247:ERROR:gl_ozone_egl.cc(26)] GLDisplayEGL::Initialize failed.
[37224:37224:0507/164634.556168:ERROR:viz_main_impl.cc(196)] Exiting GPU process due to errors during initialization
DEBUG  : cedarc <CdcIniParserInit:41>: load conf file /etc/cedarc.conf ok!

DEBUG  : cedarc <AwOmxComponentInit:38>: OMXCORE: aw_omx_component_init 1f95c00

DEBUG  : omx_vdec <__AwOmxVdecInit:1186>: ++++++++++++++++++++++omx begin++++++++++++++++++
DEBUG  : omx_vdec <__AwOmxVdecInit:1187>: name = OMX.allwinner.video.decoder.avc
DEBUG  : omx_vdec_aw <OmxDecoderCreate:1887>: UseZeroCopyBuffer [1], ZeroCopyMode [1].
DEBUG  : cedarc <VeInitialize:1652>: ve init
DEBUG  : cedarc <veEnvInit:111>: VeContext 0x2001fbc140, encoder 0, decodec 1
INFO   : cedarc <veEnvInit:139>: open /dev/cedar_dev fd = 35
DEBUG  : cedarc <veEnvInit:150>: get ve_reg_addr = 0x7fa2b4b000
DEBUG  : cedarc <veEnvGetIcVersion:278>: ** address_macc 0x7fa2b4b000 ve_top_offset = 0x0
DEBUG  : cedarc <veEnvGetIcVersion:359>: *** ic_version = 0x3331000021320
DEBUG  : cedarc <checkFeatureSupport:1450>: bEnableVcuFuncFlag = 0, nEncoderFlag = 0
DEBUG  : cedarc <VeInitialize:1705>: address_macc = 0x7fa2b4b000, address_vetop = 0x7fa2b4b000
DEBUG  : cedarc <getSocInfo:1252>: not exist SocInfo plugin, use SocInfo node
DEBUG  : cedarc <getSocInfo:1340>: ve_default_freq = 624
INFO   : cedarc <VeInitialize:1708>: *** ic_version = 0x3331000021320,
DEBUG  : cedarc <VeInitialize:1748>: *** nPhyOffset = 0x0
DEBUG  : cedarc <VeSetSpeed:2218>: *** set ve freq to 624 Mhz ***
INFO   : cedarc <VeRelease:1865>: not malloc locks

DEBUG  : cedarc <VeRelease:1890>: ve release ok
DEBUG  : omx_vdec_aw <OmxDecoderCreate:1921>: ** nPhyOffset = 0
DEBUG  : ionAlloc <__GetIonMemOpsS:866>: *** get __GetIonMemOpsS ***
DEBUG  : cedarc <VeInitialize:1652>: ve init
DEBUG  : cedarc <veEnvInit:111>: VeContext 0x2001fbc140, encoder 0, decodec 1
INFO   : cedarc <veEnvInit:139>: open /dev/cedar_dev fd = 35
DEBUG  : cedarc <veEnvInit:150>: get ve_reg_addr = 0x7fa2b4b000
DEBUG  : cedarc <veEnvGetIcVersion:278>: ** address_macc 0x7fa2b4b000 ve_top_offset = 0x0
DEBUG  : cedarc <veEnvGetIcVersion:359>: *** ic_version = 0x3331000021320
DEBUG  : cedarc <checkFeatureSupport:1450>: bEnableVcuFuncFlag = 0, nEncoderFlag = 0
DEBUG  : cedarc <VeInitialize:1705>: address_macc = 0x7fa2b4b000, address_vetop = 0x7fa2b4b000
DEBUG  : cedarc <getSocInfo:1252>: not exist SocInfo plugin, use SocInfo node
DEBUG  : cedarc <getSocInfo:1340>: ve_default_freq = 624
INFO   : cedarc <VeInitialize:1708>: *** ic_version = 0x3331000021320,
DEBUG  : cedarc <VeInitialize:1748>: *** nPhyOffset = 0x0
DEBUG  : ionAlloc <ion_create_context:172>: pid: 37245, g_context = 0x2001f2f380
DEBUG  : cedarc <CdcIonOpen:302>: open ion, file_name = /dev/dma_heap/system
DEBUG  : cedarc <CdcIonOpen:302>: open ion, file_name = /dev/dma_heap/system
DEBUG  : cedarc <CdcMessageQueueCreate:58>: nMessageSize = 40
DEBUG  : cedarc <AwOmxComponentSetCallbacks:330>: OMXCORE: aw_omx_component_set_callbacks 1f95c00, 1a2c4d30 , 1d60460

DEBUG  : omx_vdec <__AwOmxVdecSetCallbacks:1965>: ===== vdec set callbacks
WARNING: omx_vdec <__AwOmxVdecSetParameter:1602>: Set Parameter called in valid state
DEBUG  : omx_vdec <AwOmxVdecPortGetDefinitioin:184>: port:<<<<<<<<in, width = 176, height = 144,nPortIndex[0], nBufferCountActual[2], nBufferCountMin[2], nBufferSize[6291456] Alignment[0], Contignuous[0], colorformat [0x0].
DEBUG  : omx_vdec <AwOmxVdecPortGetDefinitioin:184>: port:>>>>>>>out, width = 176, height = 144,nPortIndex[1], nBufferCountActual[4], nBufferCountMin[4], nBufferSize[38016] Alignment[0], Contignuous[0], colorformat [0x7f000002].
DEBUG  : omx_vdec <AwOmxVdecPortGetDefinitioin:184>: port:<<<<<<<<in, width = 176, height = 144,nPortIndex[0], nBufferCountActual[2], nBufferCountMin[2], nBufferSize[6291456] Alignment[0], Contignuous[0], colorformat [0x0].
DEBUG  : omx_vdec <AwOmxVdecPortSetDefinitioin:210>: port:<<<<<<<<in,nBufferCountActual = 2, mBufferCntActual = 2
DEBUG  : omx_vdec <AwOmxVdecPortGetDefinitioin:184>: port:<<<<<<<<in, width = 1920, height = 958,nPortIndex[0], nBufferCountActual[2], nBufferCountMin[2], nBufferSize[6291456] Alignment[0], Contignuous[0], colorformat [0x0].
DEBUG  : omx_vdec <AwOmxVdecPortGetDefinitioin:184>: port:<<<<<<<<in, width = 1920, height = 958,nPortIndex[0], nBufferCountActual[2], nBufferCountMin[2], nBufferSize[6291456] Alignment[0], Contignuous[0], colorformat [0x0].
DEBUG  : omx_vdec <AwOmxVdecPortSetDefinitioin:210>: port:<<<<<<<<in,nBufferCountActual = 2, mBufferCntActual = 2
DEBUG  : omx_vdec <AwOmxVdecPortGetDefinitioin:184>: port:<<<<<<<<in, width = 1920, height = 958,nPortIndex[0], nBufferCountActual[2], nBufferCountMin[2], nBufferSize[6291456] Alignment[0], Contignuous[0], colorformat [0x0].
DEBUG  : omx_vdec <AwOmxVdecPortGetDefinitioin:184>: port:>>>>>>>out, width = 176, height = 144,nPortIndex[1], nBufferCountActual[4], nBufferCountMin[4], nBufferSize[38016] Alignment[0], Contignuous[0], colorformat [0x7f000002].
DEBUG  : omx_vdec <AwOmxVdecPortGetDefinitioin:184>: port:<<<<<<<<in, width = 1920, height = 958,nPortIndex[0], nBufferCountActual[2], nBufferCountMin[2], nBufferSize[6291456] Alignment[0], Contignuous[0], colorformat [0x0].
ERROR  : omx_vdec <AwOmxVdecPortGetFormat:365>: erro: pParamData->nIndex > m_sPortFormatType.nIndex
DEBUG  : omx_vdec <AwOmxVdecPortGetDefinitioin:184>: port:<<<<<<<<in, width = 1920, height = 958,nPortIndex[0], nBufferCountActual[2], nBufferCountMin[2], nBufferSize[6291456] Alignment[0], Contignuous[0], colorformat [0x0].
DEBUG  : omx_vdec <controlSetState:441>: current state:OMX_StateLoaded, target state:OMX_StateIdle
DEBUG  : omx_vdec <doStateWaitforResources2Idle:656>: bEnabled[1],[1],bPopulated[0],[0]
DEBUG  : omx_vdec <AwOmxVdecPortAddBuffer:477>: <<<<<<<<in port add buffer: 0x2003a04000
DEBUG  : omx_vdec <AwOmxVdecPortAddBuffer:477>: <<<<<<<<in port add buffer: 0x2004204000
DEBUG  : omx_vdec <AwOmxVdecPortGetDefinitioin:184>: port:<<<<<<<<in, width = 1920, height = 958,nPortIndex[0], nBufferCountActual[2], nBufferCountMin[2], nBufferSize[6291456] Alignment[0], Contignuous[0], colorformat [0x0].
DEBUG  : omx_vdec <AwOmxVdecPortGetDefinitioin:184>: port:>>>>>>>out, width = 176, height = 144,nPortIndex[1], nBufferCountActual[4], nBufferCountMin[4], nBufferSize[38016] Alignment[0], Contignuous[0], colorformat [0x7f000002].
DEBUG  : ionAlloc <ion_alloc_palloc_base:382>: ion alloc fd:36 size:38016 heap:1, falgs:3
DEBUG  : ionAlloc <ion_alloc_palloc_base:426>: alloc succeed, addr_phy: 0xfef30000, addr_vir: 0x7fa2b41000, size: 38016 dma_buf_fd 40
DEBUG  : omx_vdec_aw <__liAllocatePortBuffer:1736>: META_DATA_IN_BUFFER. allocate buffer. share_fd: 0x28. phyaddress: 0xfef30000. viraddress: 0x7fa2b41000. pBuffer 0x2001fb1140.
DEBUG  : omx_vdec <AwOmxVdecPortAddBuffer:477>: >>>>>>>out port add buffer: 0x2001fb1140
DEBUG  : ionAlloc <ion_alloc_palloc_base:382>: ion alloc fd:36 size:38016 heap:1, falgs:3
DEBUG  : ionAlloc <ion_alloc_palloc_base:426>: alloc succeed, addr_phy: 0xfef20000, addr_vir: 0x7f1bf04000, size: 38016 dma_buf_fd 41
DEBUG  : omx_vdec_aw <__liAllocatePortBuffer:1736>: META_DATA_IN_BUFFER. allocate buffer. share_fd: 0x29. phyaddress: 0xfef20000. viraddress: 0x7f1bf04000. pBuffer 0x2001fb10e0.
DEBUG  : omx_vdec <AwOmxVdecPortAddBuffer:477>: >>>>>>>out port add buffer: 0x2001fb10e0
DEBUG  : ionAlloc <ion_alloc_palloc_base:382>: ion alloc fd:36 size:38016 heap:1, falgs:3
DEBUG  : ionAlloc <ion_alloc_palloc_base:426>: alloc succeed, addr_phy: 0xfef10000, addr_vir: 0x7f1a155000, size: 38016 dma_buf_fd 42
DEBUG  : omx_vdec_aw <__liAllocatePortBuffer:1736>: META_DATA_IN_BUFFER. allocate buffer. share_fd: 0x2a. phyaddress: 0xfef10000. viraddress: 0x7f1a155000. pBuffer 0x2001fb1080.
DEBUG  : omx_vdec <AwOmxVdecPortAddBuffer:477>: >>>>>>>out port add buffer: 0x2001fb1080
DEBUG  : ionAlloc <ion_alloc_palloc_base:382>: ion alloc fd:36 size:38016 heap:1, falgs:3
DEBUG  : ionAlloc <ion_alloc_palloc_base:426>: alloc succeed, addr_phy: 0xfef00000, addr_vir: 0x7f1a14b000, size: 38016 dma_buf_fd 43
DEBUG  : omx_vdec_aw <__liAllocatePortBuffer:1736>: META_DATA_IN_BUFFER. allocate buffer. share_fd: 0x2b. phyaddress: 0xfef00000. viraddress: 0x7f1a14b000. pBuffer 0x2001fb1020.
DEBUG  : omx_vdec <AwOmxVdecPortAddBuffer:477>: >>>>>>>out port add buffer: 0x2001fb1020
DEBUG  : omx_vdec <AwOmxVdecPortGetDefinitioin:184>: port:>>>>>>>out, width = 176, height = 144,nPortIndex[1], nBufferCountActual[4], nBufferCountMin[4], nBufferSize[38016] Alignment[0], Contignuous[0], colorformat [0x7f000002].
DEBUG  : omx_vdec <doStateWaitforResources2Idle:656>: bEnabled[1],[1],bPopulated[1],[1]
DEBUG  : omx_vdec <controlSetState:462>: Transit current state:OMX_StateLoaded --> target state:OMX_StateIdle --OK!
DEBUG  : omx_vdec <controlSetState:441>: current state:OMX_StateIdle, target state:OMX_StateExecuting
DEBUG  : omx_vdec <controlSetState:462>: Transit current state:OMX_StateIdle --> target state:OMX_StateExecuting --OK!
DEBUG  : omx_vdec_aw <liDealWithInitData:396>: fatal error! pInBufHdr is NULL, check code!
DEBUG  : omx_vdec <AwOmxVdecPortGetDefinitioin:184>: port:<<<<<<<<in, width = 1920, height = 958,nPortIndex[0], nBufferCountActual[2], nBufferCountMin[2], nBufferSize[6291456] Alignment[0

---

**Cursor**

可以，这次你贴出的运行时输出已经包含了决定性证据。我再通过当前运行进程和 DevTools 端口交叉确认一下 `chrome://media-internals` / 设备节点状态。

是的，这次你贴出来的运行时输出已经能确认一件事：

## 结论：视频解码侧已经调用了 Allwinner/Sunxi VPU/Cedarc 硬解

关键证据非常明确：

```text
DEBUG  : cedarc <CdcIniParserInit:41>: load conf file /etc/cedarc.conf ok!
DEBUG  : omx_vdec <__AwOmxVdecInit:1186>: ++++++++++++++++++++++omx begin++++++++++++++++++
DEBUG  : omx_vdec <__AwOmxVdecInit:1187>: name = OMX.allwinner.video.decoder.avc
```

这里说明 Chromium 播放的视频走到了：

```text
OMX.allwinner.video.decoder.avc
```

也就是 Allwinner 的 OpenMAX H.264/AVC 解码器。

更关键的是：

```text
INFO   : cedarc <veEnvInit:139>: open /dev/cedar_dev fd = 35
```

这说明进程已经实际打开了：

```text
/dev/cedar_dev
```

这是 Sunxi/Allwinner VPU/Cedarc 视频引擎设备节点。这个不是普通软件解码会打开的东西。

然后还有：

```text
DEBUG  : cedarc <VeInitialize:1652>: ve init
DEBUG  : cedarc <VeSetSpeed:2218>: *** set ve freq to 624 Mhz ***
```

这说明 VE，也就是 Video Engine，已经初始化，并且设置了频率。

再看内存分配：

```text
DEBUG  : cedarc <CdcIonOpen:302>: open ion, file_name = /dev/dma_heap/system
DEBUG  : ionAlloc <ion_alloc_palloc_base:426>: alloc succeed, addr_phy: ..., dma_buf_fd 40
```

这说明它还通过 dma-heap/ION 风格接口分配了硬件解码 buffer。

最后状态机进入执行态：

```text
DEBUG  : omx_vdec <controlSetState:462>: Transit current state:OMX_StateLoaded --> target state:OMX_StateIdle --OK!
DEBUG  : omx_vdec <controlSetState:462>: Transit current state:OMX_StateIdle --> target state:OMX_StateExecuting --OK!
```

这说明 OpenMAX 解码组件不只是被探测了一下，而是已经进入 `OMX_StateExecuting`。

所以这次可以确认：

> **Chromium 播放这个 H.264 视频时，已经启用了厂商 Allwinner/Sunxi Cedarc VPU 硬件视频解码路径。**

---

## 但 GPU 图形加速仍然失败

你日志前面仍然有大量 GPU/EGL 初始化失败：

```text
ANGLE Display::initialize error 12289: GLX is not present.
eglInitialize OpenGL failed with error EGL_NOT_INITIALIZED
eglInitialize OpenGLES failed with error EGL_NOT_INITIALIZED
Initialization of all EGL display types failed.
GLDisplayEGL::Initialize failed.
Exiting GPU process due to errors during initialization
```

这说明：

- Chromium 的 GL/EGL/GPU compositing 没有正常起来；
- `chrome://gpu` 里大概率仍然会显示很多图形能力是 disabled/software；
- WebGL / GPU raster / GPU compositing 可能不可用。

但这和“视频解码是否走 VPU”不是一回事。

你的情况是：

| 项目 | 当前状态 |
|---|---|
| 视频解码 VPU/Cedarc | **已启用** |
| H.264 AVC 硬解 | **已走 `OMX.allwinner.video.decoder.avc`** |
| `/dev/cedar_dev` | **已被打开** |
| `/dev/dma_heap/system` | **已被打开并分配 buffer** |
| GPU/EGL/GL 图形加速 | **失败/不可用** |
| GPU compositing | 大概率不可用 |
| `--enable-features=VaapiVideoDecoder` | 不是主要生效路径，实际走的是 Allwinner OMX/Cedarc |

---

## `chrome://gpu` 和这份日志可能会“看起来矛盾”

即使 `chrome://gpu` 显示：

```text
Video Decode: Software only / disabled
Compositing: Software only
OpenGL: disabled
```

也不能完全否定你这个厂商 Chromium 的 Cedarc 路径。

因为你的 Chromium 是厂商定制版，它看起来走的是：

```text
Chromium media pipeline
  -> GStreamer / OpenMAX
  -> OMX.allwinner.video.decoder.avc
  -> Cedarc / VE
  -> /dev/cedar_dev
  -> /dev/dma_heap/system
```

这条路径未必会被标准 `chrome://gpu` 的 `Video Decode` 状态完整识别出来。标准 Chromium 的 `chrome://gpu` 更偏向显示 Vaapi/V4L2/ANGLE/GPU process 状态，而你的硬解路径是厂商移植的 Cedarc/OpenMAX 路径。

所以这次应该以运行时日志为准。

---

## 那个 `fatal error! pInBufHdr is NULL` 怎么看？

你日志里有：

```text
DEBUG  : omx_vdec_aw <liDealWithInitData:396>: fatal error! pInBufHdr is NULL, check code!
```

这个名字里有 `fatal error`，但从上下文看，它不是 Chromium 进程级别的 fatal，也不是硬解完全失败的证据。因为在它之前，OpenMAX 已经成功：

```text
OMX_StateLoaded --> OMX_StateIdle --OK!
OMX_StateIdle --> OMX_StateExecuting --OK!
```

它更像是厂商 OMX 插件内部对某个初始化数据 buffer 为空的调试/错误打印。是否影响播放，要看后续有没有持续解码帧、有没有画面、有没有反复 fallback 到软件解码。

如果你后面还能看到类似这些内容，就更能确认持续解码成功：

```text
Decode
vdec
EmptyThisBuffer
FillThisBuffer
PortSettingsChanged
OMX_EventPortSettingsChanged
```

或者在 `chrome://media-internals` 里看到 decoder 名称类似：

```text
VmxGstVideoDecoder
OMX.allwinner.video.decoder.avc
```

---

## 最终判断

你这次播放时的日志已经足够下结论：

> **是的，Chromium 已经调用了厂商 VPU 加速。准确说，是通过 Allwinner OpenMAX/Cedarc 路径启用了 H.264 硬件视频解码。**

但同时也要注意：

> **GPU/EGL 图形加速仍然没有正常启用。也就是说“视频解码硬解已启用”，但“Chromium GPU 图形加速未成功”。**

这两个状态可以同时存在。

