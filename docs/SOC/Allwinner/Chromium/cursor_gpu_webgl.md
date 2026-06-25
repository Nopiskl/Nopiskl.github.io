# GPU与WebGL识别问题
_Exported on 2026/5/10 at GMT+8 2:58:53 from Cursor (2.6.21)_

---

**User**

为什么我的GPU能正常运行glmark2，而且桌面也已经启用GPU，但是就是浏览器打不开webgl，是为什么？
运行firefox和chromium均无法识别webgl存在，请你帮我看一下

---

**Cursor**

我先检查一下系统的 GPU、Mesa/驱动、浏览器 WebGL 黑名单/沙盒相关信息，再根据结果判断原因。

我会运行几条只读诊断命令，确认浏览器看到的 GPU 能力和系统 OpenGL 状态。

初步信息显示这是 `aarch64` 系统，`/dev/dri/renderD128` 权限是 `root:render 660`；浏览器如果不是以 `render` 组用户运行，可能无法访问 render node，从而 WebGL 初始化失败。我继续确认当前用户、环境和浏览器 GPU 日志。

上一条命令里有一段 shell 语法在当前环境不兼容，我拆开检查。

系统确认是 Allwinner 平台的 PowerVR/IMG GPU（`pvrsrvkm`），不是常见 PC PCI GPU。现在重点看浏览器进程实际环境和错误日志。

我这里的命令环境本身是 `tty`，没有继承桌面会话的 `DISPLAY/WAYLAND_DISPLAY`，所以不能直接代表你图形桌面里的浏览器状态；但系统层面已经能看到 GPU 和 EGL。接下来我查一下 GLES 扩展与浏览器依赖库。

`es2_info` 在当前非图形会话里挂住了，我先跳过它，只检查库和 Firefox 图形诊断能力。

这里有一个关键信号：安装的是 `chromium-browser-sunxi`，但命令名不是标准 `chromium`；同时系统存在两套 GL/EGL/GLES/GBM 库路径（`/lib/aarch64-linux-gnu` 和 `/usr/local/lib`），这类 PowerVR 平台很容易出现浏览器加载到 Mesa stub/错误 EGL vendor，而 `glmark2` 加载到厂商 GLES 后正常。继续看 Chromium 启动脚本。

我需要从桌面启动方式确认 Chromium 是否带了禁用 GPU 的参数，以及 Firefox 是否有系统策略禁用 WebGL。

找到一个明显问题：`/etc/chromium-browser/default` 里定义的是 `CHROMIUM_FLAGS`（复数），但启动脚本实际只读取 `CHROMIUM_FLAG`（单数）和 `CHROMIUM_EXT_FLAG`，所以那些 `--use-gl=egl`、`--ignore-gpu-blocklist` 根本没被传给 Chromium。继续读取这个文件并检查 Firefox 可用 EGL。

我发现 Chromium 的启动脚本和配置文件变量名不匹配：配置写了 `CHROMIUM_FLAGS`，启动脚本却只使用 `CHROMIUM_FLAG`，因此你的 GPU/WebGL 强制参数没有生效。我先帮你把启动脚本改成读取 `/etc/chromium-browser/default` 里的参数。

继续检查修改后的启动脚本和 shell 语法。

Chromium 参数现在已经能正确传递了。我再读取修改后的关键段，方便确认。

我看了一下，结论是：**GPU 本身大概率没问题，主要问题在浏览器启动配置/图形栈适配上**。

你这台机器是 `aarch64`，GPU 是 Allwinner 平台上的 PowerVR/IMG：

- DRM 显示：`sunxi-drm`
- GPU 驱动：`pvrsrvkm`
- render node：`/dev/dri/renderD128`
- 系统 EGL 能看到 Mesa/PowerVR 相关库
- `glmark2` 能跑，说明 GLES/EGL 基础链路是通的

但浏览器 WebGL 不工作，原因通常不是“GPU 没启用”，而是：

1. 浏览器没有正确加载 EGL/GLES 参数；
2. 浏览器走到了错误的 GL 后端；
3. 浏览器 GPU 黑名单/驱动 workaround 阻止 WebGL；
4. PowerVR/IMG 这类嵌入式 GPU 的浏览器兼容性比桌面 Mesa/Intel/AMD/NVIDIA 差，需要专门参数；
5. Firefox ESR 对这种非主流 ARM GPU 栈支持可能不如厂商 Chromium 包。

我已经发现并修了一个明确问题：  
`/etc/chromium-browser/default` 里写的是：

```bash
CHROMIUM_FLAGS="..."
```

但 `/usr/local/chromium/bin/chromium-browser` 启动脚本原来只读取：

```bash
CHROMIUM_FLAG
CHROMIUM_EXT_FLAG
```

也就是说，你配置文件里的这些关键参数之前**根本没有传给 Chromium**：

```bash
--ignore-gpu-blocklist
--enable-gpu-rasterization
--enable-zero-copy
--use-gl=egl
--disable-gpu-driver-bug-workarounds
```

我已把 `/usr/local/chromium/bin/chromium-browser` 修改为会读取 `/etc/chromium-browser/default`，并把 `CHROMIUM_FLAGS` 合并进实际启动参数。验证结果现在已经能看到参数生效：

```text
chromium flags: --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy --enable-features=VaapiVideoDecoder --use-gl=egl --enable-accelerated-video-decode --enable-accelerated-mjpeg-decode --disable-gpu-driver-bug-workarounds --no-sandbox
Chromium 120.0.6099.224
```

你现在请重新打开 Chromium，然后访问：

```text
chrome://gpu
```

重点看这些项：

- `WebGL`
- `WebGL2`
- `Canvas`
- `Compositing`
- `GL_RENDERER`
- `Problems Detected`

如果还是不行，可以先用这个命令从图形桌面终端启动 Chromium 测试：

```bash
CHROMIUM_DEBUG=1 /usr/local/chromium/bin/chromium-browser
```

然后看日志：

```bash
~/.config/chromium/chrome_debug.log
```

另外，你可以尝试在 `/etc/chromium-browser/default` 里把参数调整为更直接的 WebGL 组合：

```bash
CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--enable-gpu-rasterization \
--enable-zero-copy \
--use-gl=egl \
--enable-webgl \
--enable-webgl2 \
--disable-gpu-driver-bug-workarounds"
```

对于 Firefox，情况更复杂。你现在装的是：

```text
Firefox 140.10.1esr
```

Firefox 在 ARM + PowerVR 专有/半专有 EGL 栈上经常会被 blocklist 或 glxtest 判定失败。可以在 `about:config` 尝试这些设置：

```text
webgl.force-enabled = true
webgl.disabled = false
gfx.webrender.all = true
layers.acceleration.force-enabled = true
```

如果 Firefox 仍然打不开 WebGL，而 Chromium 修复后可以，那基本可以判断是 **Firefox ESR 对当前 PowerVR/IMG EGL 栈兼容性不好或被 blocklist**，不是 GPU 本身故障。

还有一个重要提示：我当前诊断命令运行环境是 `tty`，没有继承桌面图形会话的：

```text
DISPLAY
WAYLAND_DISPLAY
```

所以我不能直接在这里完整模拟你桌面里打开浏览器后的 GPU 状态。你需要在实际桌面环境里重新打开浏览器测试。

建议下一步：

1. 关闭所有 Chromium。
2. 重新打开 Chromium。
3. 打开 `chrome://gpu`。
4. 如果 WebGL 仍然 disabled，把 `chrome://gpu` 页面里的 `Graphics Feature Status` 和 `Problems Detected` 内容发我，我可以继续精确判断是 EGL 初始化失败、GPU blocklist、ANGLE 后端问题，还是 PowerVR 驱动扩展缺失。

---

**User**

你可以看看 @\root\.cursor\projects\root-Desktop\terminals\4.txt:7-97 

---

**Cursor**

我看到了，关键报错不是普通 DBus/UPower，那些可以忽略；真正导致 WebGL/GPU 进程崩溃的是 Chromium 的 GL 命令解码器和 ANGLE/Vulkan 回退路径。我先把 Chromium 参数改成适合这种 ARM + PowerVR EGL 栈的组合。

我会把默认参数中的几个容易触发崩溃的项替换掉：禁用 passthrough command decoder，禁用 Vulkan/ANGLE Vulkan，保留 EGL。

现在验证参数是否正确传入。

`--version` 这次没有快速退出，可能 Chromium 进程挂在初始化里了。我先确认是否残留了 Chromium 进程。

我看了你贴的日志，关键问题很明确：

```text
FATAL:gpu_init.cc(540)] Passthrough is not supported, GL is egl, ANGLE is
GPU process exited unexpectedly: exit_code=5
```

以及后面这个：

```text
ANGLE Display::initialize error 0: Internal Vulkan error (-3)
eglInitialize SwANGLE failed with error EGL_NOT_INITIALIZED
Initialization of all EGL display types failed.
```

这说明：

1. 你现在已经把 `--use-gl=egl` 传进去了；
2. 但是 Chromium 默认启用了 **Passthrough Command Decoder**；
3. 当前这个 sunxi / PowerVR / IMG EGL 驱动不支持 Chromium 的 passthrough 路径；
4. Chromium GPU 进程因此直接崩溃；
5. GPU 进程崩溃后，Chromium 又尝试走 ANGLE / Vulkan / SwANGLE fallback；
6. 但你的 Vulkan/ANGLE fallback 也初始化失败；
7. 所以 WebGL 最终不可用。

也就是说，原因不是 GPU 没有工作，而是：

**Chromium 使用了当前 PowerVR 驱动不支持的 GPU 初始化路径。**

我已经帮你把 `/etc/chromium-browser/default` 改成更适合这种 ARM + PowerVR EGL 栈的参数：

```bash
CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--enable-gpu-rasterization \
--enable-zero-copy \
--use-gl=egl \
--use-angle=gl \
--disable-vulkan \
--disable-features=Vulkan,DefaultPassthroughCommandDecoder \
--use-cmd-decoder=validating \
--disable-gpu-driver-bug-workarounds"
```

关键变化是这几个：

```bash
--use-cmd-decoder=validating
--disable-features=DefaultPassthroughCommandDecoder
--disable-vulkan
--use-angle=gl
```

它们分别用于：

- 禁用 Chromium 的 passthrough command decoder；
- 改用旧的 validating command decoder；
- 避免 ANGLE/Vulkan 初始化；
- 强制 ANGLE 不走 Vulkan 后端。

你现在需要做：

```bash
pkill -f /usr/local/chromium/bin/chrome
pkill -f chromium-browser
export DISPLAY=:0
CHROMIUM_DEBUG=1 /usr/local/chromium/bin/chromium-browser
```

然后看日志里是否还出现：

```text
Passthrough is not supported
```

如果这行消失，说明方向对了。

然后打开：

```text
chrome://gpu
```

重点看：

```text
WebGL
WebGL2
Compositing
GL_RENDERER
Problems Detected
```

如果 WebGL 还是不行，但是不再报 `Passthrough is not supported`，下一步可以再试一个更保守的组合，把 `/etc/chromium-browser/default` 改成：

```bash
CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--use-gl=egl \
--use-angle=gl \
--disable-vulkan \
--disable-features=Vulkan,DefaultPassthroughCommandDecoder \
--use-cmd-decoder=validating \
--disable-gpu-rasterization \
--disable-zero-copy"
```

也就是先关掉：

```bash
--enable-gpu-rasterization
--enable-zero-copy
```

因为某些 PowerVR GBM/EGL 栈可以跑 GLES demo，但不一定能稳定支持 Chromium 的 zero-copy / GPU raster 路径。

你日志里的这些可以暂时忽略：

```text
Failed to connect to the bus
UPower was not provided
Cloud management controller initialization aborted
```

它们不是 WebGL 失败的核心原因。

真正核心就是这两组：

```text
Passthrough is not supported, GL is egl
```

和：

```text
ANGLE Vulkan error
eglInitialize SwANGLE failed
```

我已经先按这个方向修了 Chromium 参数。你再跑一次，把新的日志贴给我，我可以继续判断是否还需要关 `zero-copy`、换 `--ozone-platform=x11`，或者强制 Chromium 走 SwiftShader/软件 WebGL 作为兜底。

---

**User**

@\root\.cursor\projects\root-Desktop\terminals\4.txt:7-182 你可以看看，我的root密码是root，你可以直接帮我调试分析

---

**Cursor**

我看到了第二次日志，新的关键点是这行：

```text
Requested GL implementation (gl=none,angle=none) not found in allowed implementations: [(gl=egl-angle,angle=default),(gl=egl-gles2,angle=none)].
```

这说明我上次给的 `--use-angle=gl` 在这个 sunxi Chromium 120 构建里不是合法组合。它只允许两种 GL 后端：

- `gl=egl-angle, angle=default`
- `gl=egl-gles2, angle=none`

所以我们应该改成 **直接走原生 EGL/GLES2**，也就是 `--use-gl=egl-gles2`，不要再传 `--use-angle=gl`。我先用临时 profile 测试几组参数，确认哪组 GPU 进程能起来。

第一组原生 `egl-gles2` 后端没有再打印 GPU 初始化错误，说明这个方向更对。我再确认 Chromium 是否立刻退出、是否写入日志。

测试结果说明 `--use-angle=gl` 不适合这个构建；这个 Chromium 允许的原生后端是 `egl-gles2`。我现在把配置改成这个合法组合。

我再验证一次启动脚本输出的参数。

我看了你新的日志，这次信息非常关键。之前我让你加的 `--use-angle=gl` 在你这个 `chromium-browser-sunxi` 构建里是**不支持的**。

日志里说得很清楚：

```text
Requested GL implementation (gl=none,angle=none) not found in allowed implementations:
[(gl=egl-angle,angle=default),(gl=egl-gles2,angle=none)].
```

也就是说，这个 Chromium 只允许两个组合：

```text
gl=egl-angle, angle=default
gl=egl-gles2, angle=none
```

而 `--use-angle=gl` 导致 Chromium 解析后变成了非法组合，所以 GPU 进程还是起不来。

我已经帮你把 `/etc/chromium-browser/default` 改成了正确方向：**不用 ANGLE，直接走原生 EGL/GLES2**。

当前配置已经改成：

```bash
CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--enable-gpu-rasterization \
--enable-zero-copy \
--use-gl=egl-gles2 \
--disable-vulkan \
--disable-features=Vulkan,DefaultPassthroughCommandDecoder \
--use-cmd-decoder=validating \
--disable-gpu-driver-bug-workarounds"
```

我也验证了启动脚本现在会传入正确参数：

```text
chromium flags: --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy --use-gl=egl-gles2 --disable-vulkan --disable-features=Vulkan,DefaultPassthroughCommandDecoder --use-cmd-decoder=validating --disable-gpu-driver-bug-workarounds --no-sandbox
Chromium 120.0.6099.224
```

这次应该不会再出现：

```text
Passthrough is not supported, GL is egl
```

也不会再因为 `--use-angle=gl` 出现：

```text
Requested GL implementation ... not found
```

你现在执行：

```bash
pkill -f /usr/local/chromium/bin/chrome
pkill -f chromium-browser
export DISPLAY=:0
CHROMIUM_DEBUG=1 /usr/local/chromium/bin/chromium-browser
```

然后打开：

```text
chrome://gpu
```

如果这次 WebGL 仍然不可用，请重点看有没有以下几类报错。

第一类，如果还有：

```text
eglInitialize failed
GLDisplayEGL::Initialize failed
```

那说明原生 EGL/GLES2 后端仍初始化失败，可能是库路径或 EGL vendor 加载错。

第二类，如果没有 GPU 进程崩溃，但 WebGL disabled，可能是 GPU blacklist 仍然拦截，虽然我们已经加了：

```bash
--ignore-gpu-blocklist
```

第三类，如果页面能打开但部分加速异常，下一步建议关掉更激进的两个参数：

```bash
--enable-gpu-rasterization
--enable-zero-copy
```

也就是改成更保守配置：

```bash
CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--use-gl=egl-gles2 \
--disable-vulkan \
--disable-features=Vulkan,DefaultPassthroughCommandDecoder \
--use-cmd-decoder=validating \
--disable-gpu-driver-bug-workarounds"
```

目前我的判断是：

**你的 WebGL 失败主要不是 GPU 驱动完全不可用，而是 Chromium 默认走了当前 sunxi PowerVR 栈不兼容的 GL/ANGLE/passthrough 初始化路径。现在已经改到该 Chromium 构建支持的原生 `egl-gles2` 路径。**

你再跑一次，把新的日志或 `chrome://gpu` 的 `Graphics Feature Status` / `Problems Detected` 发我，我继续帮你往下调。

---

**User**

请你继续结合报错分析帮我检测一下，你可以直接启动chrome并帮直接我调试好，免得我手动一直启动

---

**Cursor**

我继续直接在本机用 `DISPLAY=:0` 启动 Chromium、抓日志并迭代参数；我会尽量用临时 profile 测试，避免污染你当前浏览器配置。

先跑一轮带远程调试端口的测试，这样我可以直接读取 `chrome://gpu` 的页面内容。

刚才那条命令里的进程清理方式可能匹配到了当前命令本身，导致测试过早结束。我换一种不会误杀自身的方式继续测。

`--use-gl=egl-gles2` 这个值虽然出现在 Chromium 内部 allowed list 里，但作为命令行参数在这个构建里会被解析成 `gl=none`，所以失败。下一步我改为测试“命令行可接受的写法”：`--use-gl=egl --use-angle=none`，看它是否映射到内部的 `egl-gles2`。

刚才批量测试命令超时了，我拆成单个组合并把浏览器放到后台，避免 GUI 进程阻塞 shell。先清理残留进程。

我写一个临时测试脚本，逐个组合启动、等待、采集日志、再关闭，用来稳定比较结果。

这些测试确认了两个事实：

1. `--use-gl=egl-gles2` / `--use-angle=none` 在这个构建里会被命令行解析成非法 `gl=none`；
2. 单纯 `--use-cmd-decoder=validating` 没有阻止它走 passthrough，所以还需要找这个 Chromium 构建真正接受的开关或用软件 WebGL 兜底。

我继续检查 Chromium 包里是否带 SwiftShader/ANGLE/Vulkan 组件，以及二进制实际支持的参数名。

`strings` 结果显示这个包没有单独打包 `libvk_swiftshader.so`，而日志又显示 ANGLE fallback 会碰 Vulkan 初始化错误，所以软件 SwiftShader 兜底可能也不完整。现在我测试这个构建真正接受的 ANGLE 入口：`--use-gl=angle` 系列。

测试结果又推进了一步：所有外置 GPU 进程方案都会崩，但 `--in-process-gpu --use-gl=egl` 是目前唯一没有立即报 `Passthrough is not supported` 或 `Requested GL implementation` 的路线。我继续围绕这个路线测试 WebGL 是否能创建上下文。

下一步我用 `--in-process-gpu` 打开一个本地 WebGL 测试页，并通过远程调试接口直接执行 JavaScript 判断 `webgl` 上下文是否创建成功。

这个路线很有希望：`--in-process-gpu --use-gl=egl` 启动后没有 GPU 子进程反复崩溃，也没有 `Passthrough is not supported`。我现在直接通过调试端口执行页面里的 WebGL 检测脚本。

系统没有 Python websocket 模块，我改用 Chromium 自身打开 `chrome://gpu` 并解析 profile/日志，另外测试页面现在已经在桌面上打开了；我继续用更严格的日志看 WebGL 创建时有没有失败。

我已经把最有希望的配置跑起来了：`--in-process-gpu --use-gl=egl`。现在浏览器没有再反复 GPU 进程崩溃；我继续直接通过 DevTools 协议读取测试页里的 WebGL 结果。

已经有突破：我通过 DevTools 直接执行检测脚本，`--in-process-gpu --use-gl=egl` 下 **WebGL2 已经成功创建**。之前脚本里 WebGL1 是 `null` 是因为同一个 canvas 先创建了 WebGL2 后不能再切换成 WebGL1；我再用独立 canvas 验证一次，并把这个配置固化。

确认成功：WebGL1、WebGL2、experimental-webgl 都能创建。现在我把启动配置固化成这个可用组合。

配置已固化。我最后用启动脚本验证参数，并清理我启动的测试浏览器进程。

我已经继续帮你直接调好了，结论是：

**Chromium 的 WebGL 已经可以工作。**

我实际用 DevTools 协议执行了 WebGL 检测，结果如下：

```json
{
  "webgl": {
    "ok": true,
    "version": "WebGL 1.0 (OpenGL ES 2.0 Chromium)"
  },
  "webgl2": {
    "ok": true,
    "version": "WebGL 2.0 (OpenGL ES 3.0 Chromium)"
  },
  "experimental-webgl": {
    "ok": true,
    "version": "WebGL 1.0 (OpenGL ES 2.0 Chromium)"
  }
}
```

也就是说：

- WebGL1：成功
- WebGL2：成功
- experimental-webgl：成功

---

## 根因

你的这个 `chromium-browser-sunxi` 在当前 PowerVR / IMG EGL 驱动上，**外置 GPU 进程模式会崩**。

之前失败主要有几类：

### 1. 普通 `--use-gl=egl` 会触发 passthrough 崩溃

日志里有：

```text
Passthrough is not supported, GL is egl, ANGLE is
GPU process exited unexpectedly: exit_code=5
```

说明 Chromium 默认 GPU 子进程路径里使用了当前 PowerVR 栈不支持的 passthrough command decoder。

### 2. `--use-gl=egl-gles2` 在这个构建里不是合法命令行参数

虽然日志里 allowed implementations 显示：

```text
[(gl=egl-angle,angle=default),(gl=egl-gles2,angle=none)]
```

但是命令行传：

```bash
--use-gl=egl-gles2
```

会被解析成非法组合：

```text
Requested GL implementation (gl=none,angle=none) not found
```

所以这条路不通。

### 3. ANGLE 路线也不通

`--use-gl=angle` / `--use-angle=gles` / `--use-angle=gl` 都会遇到：

```text
GLX is not present
```

或者：

```text
ANGLE Display::initialize error
eglInitialize failed
```

也就是 ANGLE 这条路在你的系统上也不稳定。

---

## 最终可用方案

最终能工作的组合是：

```bash
--ignore-gpu-blocklist
--use-gl=egl
--in-process-gpu
--disable-vulkan
--disable-features=Vulkan
--disable-gpu-driver-bug-workarounds
```

关键是这个：

```bash
--in-process-gpu
```

它绕开了崩溃的外置 GPU 子进程路径，让 Chromium 在主进程内初始化 EGL/GLES。这样 WebGL1/WebGL2 都能成功创建。

---

## 我已经固化到配置文件

我已经把 `/etc/chromium-browser/default` 改成：

```bash
CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--use-gl=egl \
--in-process-gpu \
--disable-vulkan \
--disable-features=Vulkan \
--disable-gpu-driver-bug-workarounds"
```

启动脚本也确认会正确读取这些参数。

---

## 你现在怎么用

直接正常启动 Chromium 即可：

```bash
/usr/local/chromium/bin/chromium-browser
```

或者从桌面图标打开也可以，因为桌面入口就是调用这个脚本。

如果你想验证：

打开：

```text
chrome://gpu
```

或者访问任意 WebGL 测试页面，例如：

```text
https://get.webgl.org/
https://webglreport.com/
```

---

## 需要注意

现在日志里还会有一些无关报错，比如：

```text
Failed to connect to the bus
UPower was not provided
Cloud management controller initialization aborted
```

这些不是 WebGL 问题，可以忽略。

还有这个：

```text
spawn_subprocess.cc posix_spawn: No such file or directory
```

它看起来像 crashpad / subprocess 辅助组件缺失，但并没有阻止 WebGL 工作。真正影响 WebGL 的 GPU 初始化问题已经绕过了。

---

## 当前状态

我已经完成：

- 直接启动 Chromium 测试；
- 对比多组 GL/ANGLE/EGL 参数；
- 找到唯一可用路线；
- 通过脚本验证 WebGL1/WebGL2 创建成功；
- 把可用参数写入 `/etc/chromium-browser/default`；
- 清理了我启动的测试 Chromium 进程。

你现在再打开 Chromium，WebGL 应该已经可用了。

---

**User**

能否解释一下你通过什么样的方式恢复了WEBGL？详细创建一份md文档

---

**Cursor**

我会在桌面创建一份 Markdown 文档，记录排查过程、关键报错、测试矩阵、最终参数和原理说明。

已创建详细文档：

`/root/Desktop/chromium-webgl-recovery-notes.md`

里面包含：

- 系统/GPU 背景；
- 最初 WebGL 失败原因；
- Chromium 启动脚本变量名不匹配问题；
- 关键报错解释；
- 各种失败参数组合分析；
- 为什么 `--in-process-gpu` 能解决；
- 最终可用参数；
- WebGL1/WebGL2 实测结果；
- 后续验证方法；
- 可忽略日志说明。

最终恢复 WebGL 的核心方式是：

```bash
--ignore-gpu-blocklist
--use-gl=egl
--in-process-gpu
--disable-vulkan
--disable-features=Vulkan
--disable-gpu-driver-bug-workarounds
```

其中最关键的是：

```bash
--in-process-gpu
```

它绕过了当前 PowerVR/IMG EGL 栈下 Chromium 外置 GPU 进程崩溃的问题。

---

**User**

chromium-browser-gst_120.0.6099.224-5_arm64.deb
这个是我制作镜像时使用的sunxi chromium适配包，解释一下哪里出现了问题导致了你分析中的错误？

---

**Cursor**

我会直接从这个 `.deb` 包里解包查看控制文件、启动脚本、默认参数、打包文件列表，判断问题是包内配置、启动器脚本，还是缺失组件导致。

现在我查看包内启动脚本和 desktop 文件，并对比当前系统上修改后的版本。

包内启动脚本确实没有读取 `/etc/chromium-browser/default`，而且包本身也没有安装这个默认配置文件。继续检查包是否缺少 crashpad/sandbox/SwiftShader/Vulkan ICD 等组件，以及 `chrome` 动态依赖。

我再确认二进制是否真的不包含 SwiftShader 动态库、crashpad handler 文件，这能解释日志里的 fallback 和 `posix_spawn` 问题。

我解包看了你这个：

`/root/Desktop/chromium-browser-gst_120.0.6099.224-5_arm64.deb`

结论是：**问题主要不是你镜像的 GPU 驱动坏了，而是这个 sunxi Chromium 适配包打包/启动配置不完整，导致 Chromium 以错误的 GPU 初始化路径启动。**

---

## 这个 `.deb` 包里有什么

包信息：

```text
Package: chromium-browser-sunxi
Version: 120.0.6099.224-5
Architecture: arm64
Maintainer: OpenSEA <OpenSEA@allwinnertech.com>
Description: Chromium Web Browser for sunxi
```

包里核心文件只有这些：

```text
/usr/local/chromium/bin/chrome
/usr/local/chromium/bin/chromium-browser
/usr/local/chromium/bin/libEGL.so
/usr/local/chromium/bin/libGLESv2.so
/usr/share/applications/chromium-browser.desktop
```

重点是：这个包只放了 Chromium 主程序和两个 GL 相关库：

```text
libEGL.so
libGLESv2.so
```

但没有包含很多 Chromium 正常运行时可能会调用的辅助组件，例如：

```text
chrome_crashpad_handler
chrome-sandbox
libvk_swiftshader.so
vk_swiftshader_icd.json
```

而二进制 `chrome` 里确实引用了这些名字：

```text
chrome-sandbox
chrome_crashpad_handler
libvk_swiftshader.so
vk_swiftshader_icd.json
swiftshader
swiftshader-webgl
```

这解释了日志中的一部分报错。

---

# 主要问题 1：包内启动脚本没有读取 `/etc/chromium-browser/default`

包里的启动脚本是：

```bash
#!/bin/bash
source /etc/environment

if [ -n "${CHROMIUM_EXT_FLAG}" ]; then
    echo "Launching the chromium browser with extended flags ${CHROMIUM_EXT_FLAG}"
fi

if [ "${CHROMIUM_DEBUG}" == "1" ]; then
    echo "Launching the chromium browser with debugging flags"
    ...
fi

CHROMIUM_FLAG="${CHROMIUM_FLAG} --no-sandbox"
CHROMIUM_FLAG="${CHROMIUM_FLAG} $CHROMIUM_DEBUG_FLAG $CHROMIUM_EXT_FLAG"
echo "chromium flags: ${CHROMIUM_FLAG}"

LD_LIBRARY_PATH=/usr/local/chromium/lib:$LD_LIBRARY_PATH /usr/local/chromium/bin/chrome $CHROMIUM_FLAG "$@"
```

它只读取：

```bash
/etc/environment
```

然后只使用：

```bash
CHROMIUM_FLAG
CHROMIUM_EXT_FLAG
CHROMIUM_DEBUG_FLAG
```

但是你系统中之前配置的是：

```bash
/etc/chromium-browser/default
```

里面定义的是：

```bash
CHROMIUM_FLAGS="..."
```

注意是复数：

```bash
CHROMIUM_FLAGS
```

而启动脚本实际使用的是单数：

```bash
CHROMIUM_FLAG
```

所以你的镜像里虽然可能准备了 Chromium GPU 参数，但这个 `.deb` 包里的启动脚本**根本不会读取它们**。

这就是为什么一开始日志里只有：

```text
--no-sandbox
```

或者后来你手动加了参数才有变化。

---

# 主要问题 2：默认没有为 sunxi / PowerVR 栈设置正确 WebGL 参数

这个包是 sunxi 适配包，但启动脚本默认只加了：

```bash
--no-sandbox
```

没有默认加这些对当前平台关键的参数：

```bash
--ignore-gpu-blocklist
--use-gl=egl
--in-process-gpu
--disable-vulkan
--disable-features=Vulkan
```

在你的 PowerVR/IMG EGL 栈上，Chromium 默认 GPU 初始化路径会失败。

最初失败日志是：

```text
FATAL:gpu_init.cc(540)] Passthrough is not supported, GL is egl, ANGLE is
GPU process exited unexpectedly: exit_code=5
```

这说明 Chromium 外置 GPU 进程尝试用 EGL，但走到了当前驱动不支持的 passthrough command decoder 路线。

随后 Chromium fallback 到 ANGLE / Vulkan / SwiftShader 路线，又失败：

```text
ANGLE Display::initialize error 0: Internal Vulkan error (-3)
eglInitialize SwANGLE failed with error EGL_NOT_INITIALIZED
Initialization of all EGL display types failed
GLDisplayEGL::Initialize failed
```

所以 WebGL 最终不可用。

---

# 主要问题 3：包没有带完整 SwiftShader / Vulkan fallback 文件

我在包内没有看到：

```text
libvk_swiftshader.so
vk_swiftshader_icd.json
```

但 `chrome` 二进制里有引用：

```text
libvk_swiftshader.so
./vk_swiftshader_icd.json
swiftshader
swiftshader-webgl
```

这意味着当 Chromium 的硬件 GPU 路线失败后，它尝试 fallback 到 SwiftShader / SwANGLE / Vulkan 软件渲染路线时，运行时环境并不完整。

这与日志吻合：

```text
eglInitialize SwANGLE failed with error EGL_NOT_INITIALIZED
Internal Vulkan error (-3)
```

也就是说，这个包并没有提供一个完整可靠的 fallback 路线。

不过最后我们恢复 WebGL 不是靠 SwiftShader，而是靠：

```bash
--in-process-gpu --use-gl=egl
```

绕开外置 GPU 进程失败路径，直接让原生 EGL/GLES 工作起来。

---

# 主要问题 4：包没有 `chrome_crashpad_handler`，导致 `posix_spawn` 报错

日志里反复出现：

```text
FATAL:spawn_subprocess.cc(236)] posix_spawn: No such file or directory (2)
```

我检查包内容，没有看到：

```text
chrome_crashpad_handler
```

但 `chrome` 二进制里确实引用了：

```text
chrome_crashpad_handler
```

所以这个错误大概率就是 Chromium 尝试启动 crashpad helper，但包里没有带这个文件。

这个问题不是 WebGL 失败的主因，但说明这个 `.deb` 包确实不是完整的标准 Chromium runtime 包。

它会造成：

- crash reporter 启动失败；
- 日志里出现 `posix_spawn` fatal；
- 某些辅助子进程功能不完整。

但目前它没有阻止 WebGL 恢复。

---

# 主要问题 5：包控制文件过于简陋，没有依赖声明和 postinst 配置

这个 `.deb` 的 control 文件只有：

```text
Package: chromium-browser-sunxi
Version: 120.0.6099.224-5
Section: web
Priority: optional
Architecture: arm64
Maintainer: OpenSEA <OpenSEA@allwinnertech.com>
Description: Chromium Web Browser for sunxi
```

没有看到：

```text
Depends:
```

也没有 maintainer scripts：

```text
postinst
prerm
postrm
conffiles
```

这说明它没有声明运行依赖，也没有在安装时自动创建/修正：

```text
/etc/chromium-browser/default
/usr/bin/chromium-browser
alternatives
desktop integration
sandbox permissions
crashpad files
```

所以这个包更像是“把构建产物塞进 `/usr/local/chromium`”的简易包，而不是完整 Debian 风格 Chromium 包。

---

# 为什么 `glmark2` 正常，但 Chromium WebGL 不正常

`glmark2` 通常直接使用 EGL/GLES 创建上下文，路径比较简单。

但 Chromium WebGL 涉及更多层：

```text
Browser process
Renderer process
GPU process
Command decoder
ANGLE
EGL
GLES
Skia/Viz
Sandbox
GPU blocklist
Fallback renderer
```

你的 GPU 驱动能跑 GLES demo，不代表 Chromium 默认的 GPU 子进程 + passthrough command decoder + ANGLE fallback 路径也能跑。

当前这个包的问题就是：**它没有为 sunxi PowerVR 平台默认选择合适的 Chromium GPU 路径。**

---

# 我实际修复了什么

## 1. 修改 `/usr/local/chromium/bin/chromium-browser`

让它读取：

```bash
/etc/chromium-browser/default
```

并兼容：

```bash
CHROMIUM_FLAGS
```

修复逻辑是：

```bash
source /etc/environment
if [ -f /etc/chromium-browser/default ]; then
    source /etc/chromium-browser/default
fi

if [ -n "${CHROMIUM_FLAGS}" ]; then
    CHROMIUM_FLAG="${CHROMIUM_FLAG} ${CHROMIUM_FLAGS}"
fi
```

否则你写在 `/etc/chromium-browser/default` 的参数永远不会生效。

---

## 2. 修改 `/etc/chromium-browser/default`

最终配置为：

```bash
CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--use-gl=egl \
--in-process-gpu \
--disable-vulkan \
--disable-features=Vulkan \
--disable-gpu-driver-bug-workarounds"
```

最关键是：

```bash
--in-process-gpu
```

它绕过了这个包在当前驱动栈下会崩溃的外置 GPU 进程路径。

---

# 如果你要重新制作镜像，建议改包

你这个 `.deb` 包建议至少做这些修改。

## 1. 包内启动脚本直接读取 `/etc/chromium-browser/default`

把包里的：

```bash
source /etc/environment
```

改成：

```bash
source /etc/environment

if [ -f /etc/chromium-browser/default ]; then
    source /etc/chromium-browser/default
fi

if [ -n "${CHROMIUM_FLAGS}" ]; then
    CHROMIUM_FLAG="${CHROMIUM_FLAG} ${CHROMIUM_FLAGS}"
fi
```

## 2. 包内安装默认配置文件

新增：

```text
/etc/chromium-browser/default
```

内容：

```bash
CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--use-gl=egl \
--in-process-gpu \
--disable-vulkan \
--disable-features=Vulkan \
--disable-gpu-driver-bug-workarounds"
```

## 3. 如果可能，补齐 Chromium runtime 文件

尤其是：

```text
chrome_crashpad_handler
chrome-sandbox
libvk_swiftshader.so
vk_swiftshader_icd.json
```

如果你不打算支持 sandbox / crashpad / SwiftShader，也可以接受当前状态，但要知道这些日志会继续存在。

## 4. control 文件补 Depends

至少应该声明 Chromium 运行所需的基础库，例如：

```text
Depends: libc6, libstdc++6, libnss3, libnspr4, libdrm2, libgbm1, libx11-6, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxrandr2, libxkbcommon0, libgtk-3-0, libglib2.0-0, libdbus-1-3
```

具体依赖需要用 `ldd /usr/local/chromium/bin/chrome` 在目标 rootfs 上核对。

---

# 一句话总结

这个包的问题主要在于：

**它只是打包了 sunxi Chromium 主程序和少量库，但没有把适配 sunxi PowerVR WebGL 所需的启动参数、默认配置读取逻辑、完整 fallback 组件和运行依赖一起打包好。**

因此 Chromium 按默认路径启动时走到了：

```text
外置 GPU 进程 + EGL + passthrough command decoder
```

这条路径在当前 PowerVR/IMG 栈上失败，导致 WebGL 不可用。

最后通过：

```bash
--use-gl=egl --in-process-gpu --disable-vulkan
```

绕开这条失败路径，WebGL 才恢复。

---

**User**

/etc/chromium-browser/default
这个是你自己创建的吗

---

**Cursor**

不是我创建的。

`/etc/chromium-browser/default` 在我开始排查时就已经存在了。我当时读取到它的原始内容大概是：

```bash
# Chromium 默认启动参数
# 启用硬件加速和 WebGL

CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--enable-gpu-rasterization \
--enable-zero-copy \
--enable-features=VaapiVideoDecoder \
--use-gl=egl \
--enable-accelerated-video-decode \
--enable-accelerated-mjpeg-decode \
--disable-gpu-driver-bug-workarounds"
```

我做的事情是：

1. **发现这个文件已经存在**；
2. 发现里面写的是 `CHROMIUM_FLAGS`；
3. 但 `/usr/local/chromium/bin/chromium-browser` 启动脚本原本没有读取这个文件，也没有使用 `CHROMIUM_FLAGS`；
4. 所以我修改了启动脚本，让它读取 `/etc/chromium-browser/default`；
5. 后来我又把这个文件里的参数改成最终可用的 WebGL 参数。

现在它的内容是我改过的：

```bash
CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--use-gl=egl \
--in-process-gpu \
--disable-vulkan \
--disable-features=Vulkan \
--disable-gpu-driver-bug-workarounds"
```

所以准确说：

- `/etc/chromium-browser/default`：**不是我创建的**；
- 里面原本已经有 Chromium GPU 参数；
- 但原来的 `.deb` 包启动脚本不会读取它；
- 我修改了启动脚本和这个配置文件的内容。

---

**User**

1、--enable-gpu-rasterization \
--enable-zero-copy \
--enable-features=VaapiVideoDecoder \
--enable-accelerated-video-decode \
--enable-accelerated-mjpeg-decode \
你删掉的这些对我们问题影响大吗？能帮我找出最小适配的脚本吗？
2、而且请你再次确认一下原版脚本/etc/chromium-browser/default是谁创建的？已确认初始镜像不会存在/etc/chromium-browser/default，其他agent分析是/etc/chromium-browser/default
不是当前 SDK 构建出来的文件
不是 chromium-browser-gst.deb 安装出来的文件
不是 base rootfs 或 overlay 带进来的文件
而是在目标系统启动后，WebGL 调试过程中被创建/修改的文件
3、能否分析一下原版/etc/chromium-browser/default是否被完整传递给了chromium？

---

**Cursor**

我来重新核实三件事：当前 `/etc/chromium-browser/default` 的来源线索、原版参数是否曾被传递、以及在已知可用的 `--in-process-gpu --use-gl=egl` 基础上逐项加回你列出的参数，找最小且尽量保留功能的配置。

从元数据看，这个文件当前不属于任何 Debian 包，创建时间早于我这轮修改，但我不能仅凭现有系统证明是谁创建的；我会把证据和不确定性区分开。接下来先做最小参数矩阵测试。

我现在用直接调用 `chrome` 的方式做参数矩阵，不经过当前 wrapper，也不受 `/etc/chromium-browser/default` 影响。每个 case 都用独立临时 profile 启动、通过 DevTools 协议执行 WebGL 检测，然后关闭。

结论分三部分回答。

---

## 1. 我删掉的这些参数，对 WebGL 问题影响大吗？

你列的这些：

```bash
--enable-gpu-rasterization
--enable-zero-copy
--enable-features=VaapiVideoDecoder
--enable-accelerated-video-decode
--enable-accelerated-mjpeg-decode
```

**对“WebGL 能否创建成功”不是关键。**

我刚才重新做了参数矩阵测试，直接调用 `/usr/local/chromium/bin/chrome`，绕过 wrapper 和 `/etc/chromium-browser/default`，逐项测试。

测试结果是：

| 参数组合 | WebGL1 | WebGL2 | 是否出现关键 GPU 崩溃 |
|---|---:|---:|---:|
| `--use-gl=egl --in-process-gpu` | 成功 | 成功 | 无 |
| 加 `--ignore-gpu-blocklist` | 成功 | 成功 | 无 |
| 加 `--disable-vulkan` | 成功 | 成功 | 无 |
| 加 `--disable-features=Vulkan` | 成功 | 成功 | 无 |
| 加 `--disable-gpu-driver-bug-workarounds` | 成功 | 成功 | 无 |
| 再加 `--enable-gpu-rasterization` | 成功 | 成功 | 无 |
| 再加 `--enable-zero-copy` | 成功 | 成功 | 无 |
| 再加 `--enable-features=VaapiVideoDecoder` | 成功 | 成功 | 无 |
| 再加视频解码 flags | 成功 | 成功 | 无 |

所以，**真正决定 WebGL 恢复的是这两个参数：**

```bash
--use-gl=egl
--in-process-gpu
```

其中最关键是：

```bash
--in-process-gpu
```

它绕过了外置 GPU 进程路径中的崩溃。

---

### 那这些被删掉的参数有没有用？

有可能有用，但不是 WebGL 的核心。

#### `--enable-gpu-rasterization`

作用：让页面栅格化更多地走 GPU。

影响：

- 对 WebGL 创建成功不是必要条件；
- 可能提升页面渲染性能；
- 在不稳定 GPU 驱动上也可能引入额外问题。

这次测试显示它不会破坏 WebGL，可以保留。

#### `--enable-zero-copy`

作用：尝试减少 CPU/GPU 间拷贝，提高图像/纹理路径效率。

影响：

- 对 WebGL 创建成功不是必要条件；
- 对视频、Canvas、纹理上传可能有性能帮助；
- 在嵌入式 GPU / GBM / DMA-BUF 栈上，有时可能引发兼容性问题。

这次测试显示它不会破坏 WebGL，可以保留，但如果后续出现画面花屏、黑块、视频异常，可以优先关掉它。

#### `--enable-features=VaapiVideoDecoder`

作用：启用 VAAPI 视频解码路径。

影响：

- 与 WebGL 基本无关；
- 主要影响硬件视频解码；
- 但 sunxi 平台通常不一定走标准 VAAPI，可能是 V4L2、Cedarc、GStreamer 或厂商路径；
- 如果 Chromium 构建没有对应 VAAPI 后端，这个参数可能只是无效参数。

这次测试显示它不会破坏 WebGL，但不代表它真的启用了硬解。

#### `--enable-accelerated-video-decode`

作用：旧版 Chromium 中用于启用硬件视频解码。

影响：

- 与 WebGL 创建无关；
- 在 Chromium 120 上可能部分过时或平台相关；
- 不影响这次 WebGL 修复。

#### `--enable-accelerated-mjpeg-decode`

作用：尝试启用 MJPEG 硬解。

影响：

- 与 WebGL 无关；
- 只影响 MJPEG 解码路径；
- 可以保留，但不是修复 WebGL 的必要参数。

---

## 最小适配参数

### 绝对最小 WebGL 可用参数

实测 WebGL1/WebGL2 成功的最小组合是：

```bash
--use-gl=egl
--in-process-gpu
```

再加上原脚本已有的：

```bash
--no-sandbox
```

也就是：

```bash
/usr/local/chromium/bin/chrome \
  --no-sandbox \
  --use-gl=egl \
  --in-process-gpu
```

这已经可以创建 WebGL1/WebGL2。

---

### 推荐最小稳定参数

为了避免 Chromium 继续尝试 Vulkan、GPU blocklist 或其他驱动 workaround，我建议镜像里使用这个“推荐最小稳定版”：

```bash
--ignore-gpu-blocklist
--use-gl=egl
--in-process-gpu
--disable-vulkan
--disable-features=Vulkan
```

如果你希望保守一点，再加：

```bash
--disable-gpu-driver-bug-workarounds
```

完整推荐：

```bash
CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--use-gl=egl \
--in-process-gpu \
--disable-vulkan \
--disable-features=Vulkan \
--disable-gpu-driver-bug-workarounds"
```

---

### 如果你希望尽量保留原版视频/渲染优化参数

可以用这个版本：

```bash
CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--use-gl=egl \
--in-process-gpu \
--disable-vulkan \
--disable-features=Vulkan \
--disable-gpu-driver-bug-workarounds \
--enable-gpu-rasterization \
--enable-zero-copy \
--enable-features=VaapiVideoDecoder \
--enable-accelerated-video-decode \
--enable-accelerated-mjpeg-decode"
```

我刚才实测这组也不会破坏 WebGL。

但从“最小适配”的角度，我不建议一开始就加这么多。建议先用：

```bash
--ignore-gpu-blocklist
--use-gl=egl
--in-process-gpu
--disable-vulkan
--disable-features=Vulkan
```

视频硬解另开一轮测试验证。

---

## 2. `/etc/chromium-browser/default` 到底是谁创建的？

这里我要更正并严格区分“事实”和“推断”。

### 当前系统上能确认的事实

我刚才查了：

```bash
stat /etc/chromium-browser /etc/chromium-browser/default
dpkg -S /etc/chromium-browser/default /etc/chromium-browser
```

结果显示：

```text
dpkg-query: no path found matching pattern /etc/chromium-browser/default
dpkg-query: no path found matching pattern /etc/chromium-browser
```

也就是说：

**`/etc/chromium-browser/default` 不属于任何已安装 Debian 包。**

它不是 `chromium-browser-gst.deb` 安装出来的，因为我解包你的 `.deb` 也确认里面没有：

```text
/etc/chromium-browser/default
```

你的 `.deb` 只包含：

```text
/usr/local/chromium/bin/chrome
/usr/local/chromium/bin/chromium-browser
/usr/local/chromium/bin/libEGL.so
/usr/local/chromium/bin/libGLESv2.so
/usr/share/applications/chromium-browser.desktop
```

没有 `/etc/chromium-browser/default`。

---

### 当前文件时间戳

当前系统显示：

```text
/etc/chromium-browser
Birth: 2026-05-07 15:56:04
Modify: 2026-05-07 15:56:04

/etc/chromium-browser/default
Birth: 2026-05-07 15:56:04
Modify: 2026-05-09 18:17:15
```

这说明：

- 目录和文件最早创建时间是 `2026-05-07 15:56:04`；
- 文件内容后来在 `2026-05-09 18:17:15` 被修改过；
- 我本轮最终改参数时确实修改过它；
- 但它的创建时间早于我刚才这轮操作。

不过你说“初始镜像没有这个文件”，并且其他 agent 分析它不是 SDK、不是 deb、不是 base rootfs、不是 overlay 带进来的，这和当前证据是吻合的：

**它很可能是在目标系统启动后、某次 WebGL 调试过程中被创建的。**

---

### 我是否创建了它？

在我这次排查过程中，我第一次读取它时，它已经存在，并且里面已有原版内容：

```bash
# Chromium 默认启动参数
# 启用硬件加速和 WebGL

CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--enable-gpu-rasterization \
--enable-zero-copy \
--enable-features=VaapiVideoDecoder \
--use-gl=egl \
--enable-accelerated-video-decode \
--enable-accelerated-mjpeg-decode \
--disable-gpu-driver-bug-workarounds"
```

所以严格说：

- **我没有在这次最终修复步骤中从零创建这个文件；**
- 但当前证据不能排除它是在之前某次调试流程中被我或其他 agent 创建的；
- 既然你确认初始镜像没有，那它就不应该被视为 SDK 或 `.deb` 的原生配置；
- 它应该被视为“目标系统调试过程中生成/修改的外部配置文件”。

我之前说“不是我创建的”，更准确的说法应该是：

> 在我开始这轮 WebGL 修复排查时，这个文件已经存在；但它不是系统包安装的文件，也不是你的 `chromium-browser-gst.deb` 内置文件。它很可能来自此前某次手工或 agent 调试过程。

---

## 3. 原版 `/etc/chromium-browser/default` 是否被完整传递给 Chromium？

没有。

**原版 `/etc/chromium-browser/default` 即使存在，也没有被原版启动脚本传递给 Chromium。**

原因有两个。

---

### 原因一：原版 wrapper 根本不读取这个文件

你的 `.deb` 包内原版脚本是：

```bash
#!/bin/bash
source /etc/environment

if [ -n "${CHROMIUM_EXT_FLAG}" ]; then
    echo "Launching the chromium browser with extended flags ${CHROMIUM_EXT_FLAG}"
fi

...

CHROMIUM_FLAG="${CHROMIUM_FLAG} --no-sandbox"
CHROMIUM_FLAG="${CHROMIUM_FLAG} $CHROMIUM_DEBUG_FLAG $CHROMIUM_EXT_FLAG"
echo "chromium flags: ${CHROMIUM_FLAG}"

LD_LIBRARY_PATH=/usr/local/chromium/lib:$LD_LIBRARY_PATH /usr/local/chromium/bin/chrome $CHROMIUM_FLAG "$@"
```

它只 source 了：

```bash
/etc/environment
```

没有：

```bash
source /etc/chromium-browser/default
```

所以 `/etc/chromium-browser/default` 文件里的内容不会被读取。

---

### 原因二：变量名也不匹配

原版 `/etc/chromium-browser/default` 里写的是：

```bash
CHROMIUM_FLAGS="..."
```

注意是复数：

```bash
CHROMIUM_FLAGS
```

但原版 wrapper 使用的是单数：

```bash
CHROMIUM_FLAG
```

所以即使某种方式 source 了这个文件，如果 wrapper 不专门处理：

```bash
CHROMIUM_FLAGS
```

它也不会自动进入最终命令行。

---

### 结论

原版 `/etc/chromium-browser/default` 的参数：

```bash
--ignore-gpu-blocklist
--enable-gpu-rasterization
--enable-zero-copy
--enable-features=VaapiVideoDecoder
--use-gl=egl
--enable-accelerated-video-decode
--enable-accelerated-mjpeg-decode
--disable-gpu-driver-bug-workarounds
```

**没有被原版 `/usr/local/chromium/bin/chromium-browser` 完整传递给 Chromium。**

准确说，原版脚本完全不会读取 `/etc/chromium-browser/default`，所以这些参数基本等于没有生效。

除非你额外在环境中设置了：

```bash
CHROMIUM_FLAG=...
```

或者：

```bash
CHROMIUM_EXT_FLAG=...
```

否则启动时真正传入的主要就是：

```bash
--no-sandbox
```

---

## 建议你在 SDK / deb 中放入的最小适配脚本

如果你要重新打包 `chromium-browser-gst.deb`，我建议不要依赖一个系统外部可能不存在的 `/etc/chromium-browser/default`。可以让 wrapper 同时支持默认内置参数和外部覆盖。

推荐脚本核心如下：

```bash
#!/bin/bash

source /etc/environment

DEFAULT_CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--use-gl=egl \
--in-process-gpu \
--disable-vulkan \
--disable-features=Vulkan"

if [ -f /etc/chromium-browser/default ]; then
    source /etc/chromium-browser/default
fi

if [ -n "${CHROMIUM_FLAGS}" ]; then
    CHROMIUM_FLAG="${CHROMIUM_FLAG} ${CHROMIUM_FLAGS}"
else
    CHROMIUM_FLAG="${CHROMIUM_FLAG} ${DEFAULT_CHROMIUM_FLAGS}"
fi

if [ -n "${CHROMIUM_EXT_FLAG}" ]; then
    echo "Launching the chromium browser with extended flags ${CHROMIUM_EXT_FLAG}"
fi

if [ "${CHROMIUM_DEBUG}" == "1" ]; then
    echo "Launching the chromium browser with debugging flags"

    LOG_LEVEL_DEFAULT="1"
    if [ -n "${LOG_LEVEL}" ]; then
        LOG_LEVEL_DEFAULT="${LOG_LEVEL}"
    fi

    VLOG_LEVEL_DEFAULT="1"
    if [ -n "${VLOG_LEVEL}" ]; then
        VLOG_LEVEL_DEFAULT="${VLOG_LEVEL}"
    fi

    MODULE_LEVEL_DEFAULT="1"
    if [ -n "${MODULE_LEVEL}" ]; then
        MODULE_LEVEL_DEFAULT="${MODULE_LEVEL}"
    fi

    LOG_MODULE_DEFAULT="--vmodule=/*media/*=${MODULE_LEVEL_DEFAULT},/*Vmx/*=${MODULE_LEVEL_DEFAULT},/*Cedarc/*=${MODULE_LEVEL_DEFAULT},/*GST/*=${MODULE_LEVEL_DEFAULT}"
    if [ -n "${LOG_MODULE_CUSTOM}" ]; then
        LOG_MODULE_DEFAULT="${LOG_MODULE_CUSTOM}"
    fi

    REMOTE_DEBUGGING=""
    if [ -n "${DEBUG_PORT}" ]; then
        REMOTE_DEBUGGING="--remote-debugging-port=$DEBUG_PORT"
    fi

    CHROMIUM_DEBUG_FLAG="--enable-logging --log-level=${LOG_LEVEL_DEFAULT} --v=${VLOG_LEVEL_DEFAULT} ${LOG_MODULE_DEFAULT} ${REMOTE_DEBUGGING}"
fi

CHROMIUM_FLAG="${CHROMIUM_FLAG} --no-sandbox"
CHROMIUM_FLAG="${CHROMIUM_FLAG} ${CHROMIUM_DEBUG_FLAG} ${CHROMIUM_EXT_FLAG}"

echo "chromium flags: ${CHROMIUM_FLAG}"

LD_LIBRARY_PATH=/usr/local/chromium/lib:${LD_LIBRARY_PATH} \
    /usr/local/chromium/bin/chrome ${CHROMIUM_FLAG} "$@"
```

如果你还想保留原来的优化参数，可以把默认 flags 改成：

```bash
DEFAULT_CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--use-gl=egl \
--in-process-gpu \
--disable-vulkan \
--disable-features=Vulkan \
--enable-gpu-rasterization \
--enable-zero-copy \
--enable-features=VaapiVideoDecoder \
--enable-accelerated-video-decode \
--enable-accelerated-mjpeg-decode"
```

---

## 最终建议

如果目标是“最小 WebGL 修复”，用：

```bash
--use-gl=egl
--in-process-gpu
```

如果目标是“镜像中稳定默认可用”，用：

```bash
--ignore-gpu-blocklist
--use-gl=egl
--in-process-gpu
--disable-vulkan
--disable-features=Vulkan
```

如果目标是“保留原始视频/渲染优化”，可以再加回：

```bash
--enable-gpu-rasterization
--enable-zero-copy
--enable-features=VaapiVideoDecoder
--enable-accelerated-video-decode
--enable-accelerated-mjpeg-decode
```

但这几个不是 WebGL 修复的核心。

---

**User**

我感觉这个更像是chromium运行后产生的调试文件？能否帮我分析一下chromium deb包默认脚本启动的时候，是否默认携带了原版/etc/chromium-browser/default里面的参数，而不是显式从default里面读取的？

---

**Cursor**

我再用“原版包内 wrapper”做一次干净环境模拟，确认它在不显式读取 `/etc/chromium-browser/default` 的情况下到底会不会自带那些参数。

临时解包目录已经被清理了，我重新解包后再模拟原版 wrapper。

是的，你这个判断更合理：  
`/etc/chromium-browser/default` **不像是 Chromium 自己运行后自动生成的调试文件**，但它也**不是你的 `chromium-browser-gst.deb` 包安装出来的文件**。更准确地说，它像是：

> 某次调试或某个外部脚本/agent 手动创建的 Chromium 启动参数配置文件。

而且我重新模拟了 **原版 `.deb` 包里的启动脚本**，可以确认：

> 原版 `chromium-browser-gst.deb` 的 wrapper 默认启动时，**不会携带 `/etc/chromium-browser/default` 里面的那些参数**，除非这些参数已经通过环境变量 `CHROMIUM_FLAG` 显式注入。

---

# 1. Chromium 自己会不会生成 `/etc/chromium-browser/default`？

基本可以判断：**不会。**

Chromium 正常运行时会写这些位置：

```text
/root/.config/chromium/
~/.config/chromium/
~/.cache/chromium/
临时 profile 目录
```

例如：

```text
/root/.config/chromium/chrome_debug.log
/root/.config/chromium/Default/Preferences
/root/.config/chromium/Local State
```

但 Chromium 不会主动创建：

```text
/etc/chromium-browser/default
```

原因：

1. `/etc` 是系统配置目录，普通 Chromium 运行时不会往这里写；
2. Chromium 本身没有“生成 `/etc/chromium-browser/default`”的逻辑；
3. 这个文件内容是 shell 风格配置：

```bash
CHROMIUM_FLAGS="..."
```

这更像启动脚本配置，不像 Chromium runtime 生成文件；
4. 你的 `.deb` 包中也没有这个文件。

所以它不是 Chromium 浏览器运行后自然生成的调试文件。

更可能是：

- 某次人工调试创建；
- 某个 agent 创建；
- 某个系统初始化脚本创建；
- 某个非当前 `.deb` 包的外部配置残留。

---

# 2. 原版 `.deb` 脚本是否默认读取 `/etc/chromium-browser/default`？

我重新解包了你的 `.deb`，原版脚本是：

```bash
#!/bin/bash
source /etc/environment

if [ -n "${CHROMIUM_EXT_FLAG}" ]; then
    echo "Launching the chromium browser with extended flags ${CHROMIUM_EXT_FLAG}"
fi

if [ "${CHROMIUM_DEBUG}" == "1" ]; then
    echo "Launching the chromium browser with debugging flags"
    ...
fi

CHROMIUM_FLAG="${CHROMIUM_FLAG} --no-sandbox"
CHROMIUM_FLAG="${CHROMIUM_FLAG} $CHROMIUM_DEBUG_FLAG $CHROMIUM_EXT_FLAG"
echo "chromium flags: ${CHROMIUM_FLAG}"

LD_LIBRARY_PATH=/usr/local/chromium/lib:$LD_LIBRARY_PATH /usr/local/chromium/bin/chrome $CHROMIUM_FLAG "$@"
```

里面只读取了：

```bash
/etc/environment
```

没有读取：

```bash
/etc/chromium-browser/default
```

所以结论很明确：

**原版 `.deb` wrapper 不会显式读取 `/etc/chromium-browser/default`。**

---

# 3. 原版脚本是否可能“默认携带” `/etc/chromium-browser/default` 里的参数？

我做了干净环境模拟，直接运行 `.deb` 里的原版 wrapper。

## 干净环境运行原版 wrapper

模拟命令本质是：

```bash
env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  HOME=/root \
  DISPLAY=:0 \
  bash /tmp/chromium-browser-gst-deb/data/usr/local/chromium/bin/chromium-browser --version
```

输出：

```text
chromium flags:  --no-sandbox
Chromium 120.0.6099.224
```

说明原版脚本默认只带：

```bash
--no-sandbox
```

没有这些：

```bash
--ignore-gpu-blocklist
--enable-gpu-rasterization
--enable-zero-copy
--enable-features=VaapiVideoDecoder
--use-gl=egl
--enable-accelerated-video-decode
--enable-accelerated-mjpeg-decode
--disable-gpu-driver-bug-workarounds
```

---

## 开启 debug 环境运行原版 wrapper

模拟：

```bash
CHROMIUM_DEBUG=1 bash chromium-browser --version
```

输出：

```text
Launching the chromium browser with debugging flags
chromium flags:  --no-sandbox --enable-logging --log-level=1 --v=1 --vmodule=/*media/*=1,/*Vmx/*=1,/*Cedarc/*=1,/*GST/*=1
Chromium 120.0.6099.224
```

说明 debug 模式只额外加了日志参数：

```bash
--enable-logging
--log-level=1
--v=1
--vmodule=...
```

还是没有 `/etc/chromium-browser/default` 那些 GPU/WebGL 参数。

---

# 4. 如果环境变量里有 `CHROMIUM_FLAG`，原版脚本会传递吗？

会。

我模拟了：

```bash
CHROMIUM_FLAG='--foo-test-flag'
```

原版 wrapper 输出：

```text
chromium flags: --foo-test-flag --no-sandbox
Chromium 120.0.6099.224
```

说明原版脚本确实会继承环境变量：

```bash
CHROMIUM_FLAG
```

注意是单数：

```bash
CHROMIUM_FLAG
```

---

# 5. 如果环境变量里有 `CHROMIUM_FLAGS`，原版脚本会传递吗？

不会。

我模拟了：

```bash
CHROMIUM_FLAGS='--foo-plural-flag'
```

原版 wrapper 输出仍然是：

```text
chromium flags:  --no-sandbox
Chromium 120.0.6099.224
```

说明原版脚本不识别复数变量：

```bash
CHROMIUM_FLAGS
```

而你之前 `/etc/chromium-browser/default` 里面写的是：

```bash
CHROMIUM_FLAGS="..."
```

所以即使某个地方 source 了这个文件，只要 wrapper 不专门处理 `CHROMIUM_FLAGS`，这些参数也不会自动传入 Chromium。

---

# 6. 那原版 `/etc/chromium-browser/default` 里面的参数有没有被完整传递？

没有。

原因有两个：

## 原因一：原版 wrapper 不读取这个文件

没有：

```bash
source /etc/chromium-browser/default
```

## 原因二：变量名不匹配

文件里是：

```bash
CHROMIUM_FLAGS
```

原版 wrapper 用的是：

```bash
CHROMIUM_FLAG
```

因此，原版 `/etc/chromium-browser/default` 中的参数不会被完整传递。

除非满足下面某个额外条件：

### 情况 A：有人在 `/etc/environment` 里写了 `CHROMIUM_FLAG`

例如：

```bash
export CHROMIUM_FLAG="--ignore-gpu-blocklist --use-gl=egl ..."
```

但我当前看到的 `/etc/environment` 是：

```bash
export LD_LIBRARY_PATH=$LD_LIBRARY_PATH:/usr/local/lib
```

没有 `CHROMIUM_FLAG`。

### 情况 B：启动 Chromium 前手动导出了 `CHROMIUM_FLAG`

例如：

```bash
export CHROMIUM_FLAG="--ignore-gpu-blocklist --use-gl=egl"
chromium-browser
```

这种会生效。

### 情况 C：桌面环境或 systemd user session 注入了 `CHROMIUM_FLAG`

理论上可能，但当前没有证据。

---

# 7. 所以你这个猜测怎么修正？

你说：

> 我感觉这个更像是 chromium 运行后产生的调试文件？

我建议修正为：

> `/etc/chromium-browser/default` 更像是 WebGL 调试过程中人为或 agent 创建的 Chromium 参数配置文件，不是 Chromium 自己运行后生成的调试文件，也不是 `chromium-browser-gst.deb` 原生文件。

它不像 Chromium 自动生成文件，因为：

- 位置在 `/etc`；
- 内容是 shell 变量；
- Chromium 不负责生成这个文件；
- `.deb` 包没有安装它；
- dpkg 也不拥有它。

---

# 8. 原版 `.deb` 默认实际启动参数是什么？

在干净环境下，原版 `.deb` wrapper 默认实际启动参数就是：

```bash
--no-sandbox
```

如果设置：

```bash
CHROMIUM_DEBUG=1
```

则是：

```bash
--no-sandbox
--enable-logging
--log-level=1
--v=1
--vmodule=/*media/*=1,/*Vmx/*=1,/*Cedarc/*=1,/*GST/*=1
```

如果设置：

```bash
CHROMIUM_EXT_FLAG="..."
```

也会附加。

如果设置：

```bash
CHROMIUM_FLAG="..."
```

也会附加。

但它不会自动读取：

```bash
/etc/chromium-browser/default
```

也不会自动使用：

```bash
CHROMIUM_FLAGS
```

---

# 9. 这对 WebGL 问题意味着什么？

这说明之前 `/etc/chromium-browser/default` 里即使有：

```bash
--ignore-gpu-blocklist
--enable-gpu-rasterization
--enable-zero-copy
--enable-features=VaapiVideoDecoder
--use-gl=egl
--enable-accelerated-video-decode
--enable-accelerated-mjpeg-decode
--disable-gpu-driver-bug-workarounds
```

它们在原版 `.deb` 脚本下**根本没有参与 Chromium 启动**。

所以原始 WebGL 失败时，Chromium 大概率是以接近这个参数启动的：

```bash
/usr/local/chromium/bin/chrome --no-sandbox
```

或者 debug 时：

```bash
/usr/local/chromium/bin/chrome \
  --no-sandbox \
  --enable-logging \
  --log-level=1 \
  --v=1 \
  --vmodule=...
```

这也解释了为什么 Chromium 会走默认 GPU 初始化路径，然后触发：

```text
Passthrough is not supported
GPU process exited unexpectedly
ANGLE / Vulkan fallback failed
```

---

# 10. 最小修复思路

如果你不想依赖 `/etc/chromium-browser/default`，可以直接在 `.deb` 的 wrapper 里内置最小参数：

```bash
CHROMIUM_FLAG="${CHROMIUM_FLAG} --ignore-gpu-blocklist"
CHROMIUM_FLAG="${CHROMIUM_FLAG} --use-gl=egl"
CHROMIUM_FLAG="${CHROMIUM_FLAG} --in-process-gpu"
CHROMIUM_FLAG="${CHROMIUM_FLAG} --disable-vulkan"
CHROMIUM_FLAG="${CHROMIUM_FLAG} --disable-features=Vulkan"
CHROMIUM_FLAG="${CHROMIUM_FLAG} --no-sandbox"
```

如果想保留外部可覆盖能力，再支持：

```bash
/etc/chromium-browser/default
```

但那应该是你主动设计的，而不是假设 Chromium 会自动读取。

---

**User**

你能否分析一下为什么原本的外置GPU初始进程会有问题？崩溃点在什么地方？是环境引起的吗

---

**Cursor**

可以。根据我们前面的日志和测试，原本的“外置 GPU 进程”问题不是单一原因，而是 **Chromium 120 的 GPU 子进程初始化策略 + 这个 sunxi Chromium 构建方式 + PowerVR/IMG EGL 驱动栈 + 包内 fallback 组件不完整** 共同导致的。

最核心的崩溃点是这一句：

```text
FATAL:gpu_init.cc(540)] Passthrough is not supported, GL is egl, ANGLE is
```

这不是普通 warning，而是 Chromium GPU 进程主动 `FATAL` 退出。

---

# 1. 什么是“外置 GPU 进程”？

Chromium 默认不是在主进程里直接操作 GPU，而是会启动一个单独的 GPU 子进程，类似：

```text
browser process
 ├── renderer process
 ├── utility process
 └── gpu process
```

WebGL、Canvas 加速、合成、视频纹理等 GPU 相关工作，会通过 IPC 交给这个 GPU process。

这种设计在桌面平台上更安全：

- GPU 进程崩溃不会直接带崩浏览器主进程；
- GPU sandbox 可以隔离驱动问题；
- renderer 不能直接访问底层 GPU 驱动。

但是在嵌入式 ARM / PowerVR / 厂商 EGL 栈上，GPU 子进程模式经常比普通 GLES demo 更容易出问题。

---

# 2. 原始崩溃点在哪里？

关键日志是：

```text
[11655:11655:0509/172031.956514:FATAL:gpu_init.cc(540)] Passthrough is not supported, GL is egl, ANGLE is
```

这说明崩溃发生在 Chromium 的 GPU 初始化阶段，大致流程是：

```text
启动 GPU process
  ↓
选择 GL implementation
  ↓
当前选择结果：GL = egl
  ↓
检查 command decoder 类型
  ↓
发现当前路径要用 passthrough command decoder
  ↓
但是 native EGL 路径不支持 passthrough
  ↓
FATAL 退出 GPU process
```

也就是说，崩溃不是 WebGL 页面代码导致的，而是 **GPU process 启动时还没真正跑 WebGL，就在初始化阶段主动退出了**。

---

# 3. `Passthrough is not supported, GL is egl, ANGLE is` 是什么意思？

这句话里有三个关键信息。

## `GL is egl`

说明 Chromium 选中了 EGL 后端。

在你的机器上这是合理的，因为你是 ARM / PowerVR / IMG GPU，桌面 GLX 路线不完整，系统主要是 EGL/GLES 栈。

## `ANGLE is` 为空

说明当前不是通过 ANGLE 后端跑的，而是 native EGL/GLES 路线。

也就是：

```text
Chromium → native EGL/GLES → PowerVR/IMG driver
```

不是：

```text
Chromium → ANGLE → Vulkan/OpenGL/GLES
```

## `Passthrough is not supported`

这是核心。

Chromium 的 WebGL/GPU command buffer 有不同 decoder 路线：

- validating command decoder
- passthrough command decoder

现代 Chromium 越来越倾向 passthrough command decoder，尤其在桌面 ANGLE 路线上。

但 passthrough decoder 对 GL backend 有要求。你的日志显示当前组合是：

```text
GL = egl
ANGLE = none
```

这个组合下 Chromium 判断 passthrough 不支持，于是直接 FATAL。

所以问题可以简化为：

> Chromium GPU process 默认启用了 passthrough command decoder，但当前 native EGL/GLES 后端不支持它。

---

# 4. 为什么 `glmark2` 能跑，但 Chromium GPU process 会崩？

因为它们走的路径复杂度完全不同。

`glmark2` 大概率是：

```text
glmark2
  ↓
EGL / GLES
  ↓
PowerVR driver
```

而 Chromium WebGL 是：

```text
Chromium browser process
  ↓ IPC
GPU process
  ↓
GPU sandbox / command buffer
  ↓
command decoder
  ↓
ANGLE 或 native EGL
  ↓
Skia / Viz / shared image / mailbox / texture backing
  ↓
EGL / GLES
  ↓
PowerVR driver
```

所以：

```text
glmark2 成功
```

只能证明：

```text
EGL/GLES 基础驱动可用
```

不能证明：

```text
Chromium GPU process + command decoder + WebGL + shared image + fallback 路线全部可用
```

你的问题正好卡在 Chromium GPU process 初始化的中间层，不是底层 GPU 完全不可用。

---

# 5. 为什么加 `--in-process-gpu` 后好了？

`--in-process-gpu` 会改变架构：

默认模式：

```text
browser process
  └── gpu process
        └── EGL/GLES 初始化
```

使用 `--in-process-gpu` 后：

```text
browser process
  └── GPU service 在主进程内初始化 EGL/GLES
```

我们实测：

```bash
--use-gl=egl --in-process-gpu
```

可以成功创建：

```text
WebGL 1.0
WebGL 2.0
experimental-webgl
```

说明底层 EGL/GLES 是能用的。

所以 `--in-process-gpu` 并不是“修好了 GPU 驱动”，而是绕开了外置 GPU process 里面那条触发 FATAL 的初始化路径。

换句话说：

```text
外置 GPU process 路线：崩
主进程内 GPU service 路线：可用
```

---

# 6. 是环境引起的吗？

答案要分层看。

## 不是这些普通环境问题导致的

这些日志不是核心原因：

```text
Failed to connect to the bus
UPower was not provided
Cloud management controller initialization aborted
```

这些和 WebGL/GPU process FATAL 没直接关系。

`DISPLAY=:0` 也不是根因。你设置 `DISPLAY=:0` 后 Chromium 已经能启动并进入 GPU 初始化阶段，说明 X11 连接至少不是主故障点。

权限也不是主要问题，因为当前是 root，且 root 在：

```text
video
render
```

组里，能访问：

```text
/dev/dri/renderD128
```

---

## 但它确实和“运行环境/驱动栈”有关

更准确地说，是：

> Chromium 120 的 GPU process 默认路径与当前 sunxi PowerVR/IMG 用户态 EGL/GLES 驱动栈不兼容。

这个环境包括：

- PowerVR/IMG 专有或半专有 EGL/GLES 用户态库；
- `/usr/local/lib` 中的 PVR/Mesa WSI 库；
- `/usr/local/chromium/bin/libEGL.so`、`libGLESv2.so`；
- Chromium 构建时启用的 GPU/ANGLE/command decoder 选项；
- 包里缺少完整 fallback 组件；
- X11/GLX 不完整；
- Vulkan fallback 不可用。

所以它不是“某个环境变量写错”那种问题，而是 **运行时图形栈组合不兼容**。

---

# 7. 为什么 ANGLE fallback 也失败？

GPU process 崩溃后，Chromium 试图 fallback 到 ANGLE / Vulkan / SwANGLE，但日志显示：

```text
ANGLE Display::initialize error 0: Internal Vulkan error (-3)
eglInitialize SwANGLE failed with error EGL_NOT_INITIALIZED
Initialization of all EGL display types failed
GLDisplayEGL::Initialize failed
```

这说明 fallback 路径也不可用。

原因可能包括：

1. Vulkan 驱动不完整；
2. `libvk_swiftshader.so` / `vk_swiftshader_icd.json` 没有随包提供；
3. ANGLE 在该平台上尝试 Vulkan 或 GLX，但两者都不可用；
4. 该 Chromium 构建更偏向厂商特定媒体/GST 路线，而不是完整桌面 Chromium runtime。

我们解包时也看到 `.deb` 里没有：

```text
libvk_swiftshader.so
vk_swiftshader_icd.json
chrome_crashpad_handler
chrome-sandbox
```

但 `chrome` 二进制里确实引用了：

```text
libvk_swiftshader.so
vk_swiftshader_icd.json
chrome_crashpad_handler
```

所以 fallback 组件并不完整。

---

# 8. 为什么 `--use-cmd-decoder=validating` 没有解决？

理论上，如果问题是 passthrough command decoder，可以尝试：

```bash
--use-cmd-decoder=validating
```

但我们测试过，这个参数没有阻止外置 GPU process 继续报：

```text
Passthrough is not supported
```

原因可能是：

1. Chromium 120 中该参数已经被弱化、忽略或不再覆盖所有路径；
2. 这个 sunxi Chromium 构建对 command decoder 的选择被编译期配置固定；
3. GPU process 初始化阶段还没进入该参数能影响的路径；
4. 相关 feature/field trial 覆盖了命令行参数。

所以在这个构建里，最有效的不是强行切 validating decoder，而是绕过外置 GPU process：

```bash
--in-process-gpu
```

---

# 9. 外置 GPU process 的实际崩溃链路

结合日志，可以还原成这样：

```text
Chromium 启动
  ↓
启动独立 GPU process
  ↓
GPU process 选择 GL implementation
  ↓
选择 native EGL
  ↓
ANGLE 为空
  ↓
Chromium 默认/内部选择 passthrough command decoder
  ↓
检查发现 native EGL 路线不支持 passthrough
  ↓
gpu_init.cc(540) FATAL
  ↓
GPU process exit_code=5
  ↓
Browser process 尝试重启 GPU process
  ↓
重复崩溃数次
  ↓
尝试 ANGLE / Vulkan / SwANGLE fallback
  ↓
Vulkan / SwANGLE 初始化失败
  ↓
WebGL disabled / 无法创建 context
```

核心点：

```text
gpu_init.cc(540)
```

而不是 WebGL 页面层面的 `getContext()`。

---

# 10. 为什么加回 `--enable-gpu-rasterization` 等参数不影响 WebGL？

因为这些参数作用在更后面的渲染/视频路径。

例如：

```bash
--enable-gpu-rasterization
```

影响页面 raster 是否走 GPU。

```bash
--enable-zero-copy
```

影响 buffer/texture 传递路径。

```bash
--enable-features=VaapiVideoDecoder
```

影响视频解码路线。

它们不是 GPU process 初始化成功与否的关键。

我们实测过，在已经使用：

```bash
--use-gl=egl --in-process-gpu
```

后，再加这些参数，WebGL 仍然可用。

所以 WebGL 崩溃的最小根因不是这些参数，而是：

```bash
外置 GPU process + native EGL + passthrough command decoder
```

这个组合不兼容。

---

# 11. 这是不是 `.deb` 包的问题？

部分是。

`.deb` 包本身的问题是：

1. 默认 wrapper 只加：

```bash
--no-sandbox
```

2. 没有给 sunxi / PowerVR 栈设置合适默认参数：

```bash
--use-gl=egl
--in-process-gpu
--disable-vulkan
```

3. 没有完整 fallback 文件：

```text
libvk_swiftshader.so
vk_swiftshader_icd.json
chrome_crashpad_handler
```

4. 没有依赖/配置机制确保目标系统图形栈完整。

但 `.deb` 包不是唯一责任。因为根本原因还包括 Chromium 120 和当前 PowerVR EGL 驱动栈之间的兼容性问题。

---

# 12. 总结一句话

原本的外置 GPU 初始化进程会出问题，是因为：

```text
Chromium GPU process 在 native EGL 后端上启用了或选择了 passthrough command decoder，
但当前 sunxi PowerVR/IMG EGL/GLES 驱动栈 + Chromium 构建不支持这个组合，
于是 GPU process 在 gpu_init.cc(540) 主动 FATAL 退出。
```

这不是 GPU 硬件坏，也不是 `glmark2` 层面的 GLES 不可用，而是 Chromium GPU process 初始化路径和当前平台图形栈不兼容。

最终通过：

```bash
--use-gl=egl
--in-process-gpu
```

绕开外置 GPU process 的崩溃路径，让 WebGL 直接在主进程内通过 EGL/GLES 初始化成功。

