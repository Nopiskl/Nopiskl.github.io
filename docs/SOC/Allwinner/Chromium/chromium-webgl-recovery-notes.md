# Chromium WebGL 恢复排查记录

## 背景

系统环境为 ARM64 / Allwinner 平台，GPU 驱动栈为 PowerVR/IMG：

- 内核模块：`pvrsrvkm`
- DRM 显示设备：`sunxi-drm`
- GPU render node：`/dev/dri/renderD128`
- 浏览器包：`chromium-browser-sunxi 120.0.6099.224`
- Firefox：`Firefox ESR 140.10.1`

系统层面的 GLES/EGL 能力是存在的，`glmark2` 可以正常运行，说明 GPU 驱动并非完全不可用。问题集中在浏览器 WebGL 初始化路径。

---

## 最终结论

WebGL 不是因为 GPU 没有启用而失败，而是因为 Chromium 默认的 GPU 子进程初始化路径与当前 PowerVR/IMG EGL 驱动栈不兼容。

最终通过以下方式恢复 Chromium WebGL：

1. 修复 Chromium 启动脚本没有读取默认参数的问题；
2. 绕开 Chromium 外置 GPU 进程路径；
3. 强制 Chromium 使用原生 EGL；
4. 禁用 Vulkan 路线；
5. 使用 `--in-process-gpu` 让 GPU 初始化在浏览器主进程中完成。

最终可用参数为：

```bash
--ignore-gpu-blocklist
--use-gl=egl
--in-process-gpu
--disable-vulkan
--disable-features=Vulkan
--disable-gpu-driver-bug-workarounds
```

配置已写入：

```bash
/etc/chromium-browser/default
```

当前内容为：

```bash
# Chromium 默认启动参数
# PowerVR/IMG EGL 栈：外置 GPU 进程会因 passthrough/ANGLE 初始化失败崩溃，改用 in-process GPU + 原生 EGL

CHROMIUM_FLAGS="--ignore-gpu-blocklist \
--use-gl=egl \
--in-process-gpu \
--disable-vulkan \
--disable-features=Vulkan \
--disable-gpu-driver-bug-workarounds"
```

---

## 第一步：发现 Chromium 默认参数没有生效

系统中存在配置文件：

```bash
/etc/chromium-browser/default
```

里面原本定义的是：

```bash
CHROMIUM_FLAGS="..."
```

但是 Chromium 启动脚本：

```bash
/usr/local/chromium/bin/chromium-browser
```

原本只读取：

```bash
CHROMIUM_FLAG
CHROMIUM_EXT_FLAG
```

也就是说，`/etc/chromium-browser/default` 中配置的 GPU/WebGL 参数实际上没有传给 Chromium。

因此先修改启动脚本，使其读取 `/etc/chromium-browser/default`，并把 `CHROMIUM_FLAGS` 合并到实际启动参数中。

修复后的关键逻辑为：

```bash
source /etc/environment
if [ -f /etc/chromium-browser/default ]; then
    source /etc/chromium-browser/default
fi

if [ -n "${CHROMIUM_FLAGS}" ]; then
    CHROMIUM_FLAG="${CHROMIUM_FLAG} ${CHROMIUM_FLAGS}"
fi
```

验证启动参数已经生效：

```text
chromium flags: --ignore-gpu-blocklist --use-gl=egl --in-process-gpu --disable-vulkan --disable-features=Vulkan --disable-gpu-driver-bug-workarounds --no-sandbox
Chromium 120.0.6099.224
```

---

## 第二步：分析最初的 GPU 进程崩溃

最初使用普通 EGL 路线时，Chromium 日志出现：

```text
FATAL:gpu_init.cc(540)] Passthrough is not supported, GL is egl, ANGLE is
GPU process exited unexpectedly: exit_code=5
```

这说明：

- Chromium 已经尝试使用 EGL；
- 但是外置 GPU 进程中启用了 passthrough command decoder；
- 当前 PowerVR/IMG EGL 驱动不支持这条路径；
- GPU 进程直接崩溃；
- GPU 进程崩溃后 WebGL 无法创建。

随后 Chromium 会尝试 fallback 到 ANGLE / Vulkan / SwANGLE 路线，但继续失败：

```text
ANGLE Display::initialize error 0: Internal Vulkan error (-3)
eglInitialize SwANGLE failed with error EGL_NOT_INITIALIZED
Initialization of all EGL display types failed
GLDisplayEGL::Initialize failed
```

这说明当前系统上的 Chromium Vulkan/ANGLE fallback 路径也不可用。

---

## 第三步：测试原生 EGL/GLES2 路线

日志中曾显示 Chromium 内部允许的 GL implementation 为：

```text
[(gl=egl-angle,angle=default),(gl=egl-gles2,angle=none)]
```

因此尝试了：

```bash
--use-gl=egl-gles2
```

以及：

```bash
--use-gl=egl --use-angle=none
```

但这些参数在该 `chromium-browser-sunxi` 构建中并不能被命令行正确解析，结果变成：

```text
Requested GL implementation (gl=none,angle=none) not found in allowed implementations:
[(gl=egl-angle,angle=default),(gl=egl-gles2,angle=none)]
```

结论：虽然 `egl-gles2` 是 Chromium 内部 implementation 名称，但这个构建的命令行参数不能直接使用 `--use-gl=egl-gles2` 来选中它。

---

## 第四步：测试 ANGLE 路线

尝试过多种 ANGLE 组合：

```bash
--use-gl=angle
--use-gl=angle --use-angle=default
--use-gl=angle --use-angle=gles
--use-gl=angle --use-angle=gl
```

这些组合均失败，典型报错为：

```text
ANGLE Display::initialize error 12289: GLX is not present
eglInitialize OpenGL failed with error EGL_NOT_INITIALIZED
eglInitialize OpenGLES failed with error EGL_NOT_INITIALIZED
GLDisplayEGL::Initialize failed
```

也就是说：

- ANGLE OpenGL / GLES 路线初始化失败；
- GLX 相关路径在当前环境中不可用；
- ANGLE Vulkan fallback 也会因为 Vulkan 初始化失败而不可用。

因此 ANGLE 不是适合这台机器的 WebGL 恢复路线。

---

## 第五步：发现 `--in-process-gpu` 是关键

外置 GPU 进程模式下反复出现：

```text
GPU process exited unexpectedly
Passthrough is not supported
```

于是测试把 GPU 服务放到浏览器主进程中运行：

```bash
--in-process-gpu
```

测试命令核心为：

```bash
/usr/local/chromium/bin/chrome \
  --no-sandbox \
  --ignore-gpu-blocklist \
  --use-gl=egl \
  --in-process-gpu \
  --disable-vulkan \
  --disable-features=Vulkan
```

这条路线下：

- 没有再出现 `Passthrough is not supported`；
- 没有再出现 GPU 子进程反复崩溃；
- Chromium 能够完成 EGL 初始化；
- WebGL 上下文可以成功创建。

虽然日志中仍有：

```text
Vulkan not supported with in process gpu
```

但这不影响 WebGL，因为我们最终走的是 EGL/GLES，而不是 Vulkan。

---

## 第六步：实际验证 WebGL1 / WebGL2

为了避免只看 `chrome://gpu` 造成误判，创建了一个本地 WebGL 测试页面，并通过 Chromium DevTools 协议直接执行 JavaScript，验证上下文是否真的可以创建。

检测逻辑等价于：

```javascript
const result = {};

for (const name of ['webgl', 'webgl2', 'experimental-webgl']) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext(name, {
    failIfMajorPerformanceCaveat: false
  });

  result[name] = gl
    ? {
        ok: true,
        version: gl.getParameter(gl.VERSION),
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        extensionCount: gl.getSupportedExtensions().length
      }
    : {
        ok: false,
        reason: 'null context'
      };
}
```

最终返回结果为：

```json
{
  "webgl": {
    "ok": true,
    "version": "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
    "vendor": "WebKit",
    "renderer": "WebKit WebGL",
    "sl": "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
    "extCount": 23
  },
  "webgl2": {
    "ok": true,
    "version": "WebGL 2.0 (OpenGL ES 3.0 Chromium)",
    "vendor": "WebKit",
    "renderer": "WebKit WebGL",
    "sl": "WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)",
    "extCount": 10
  },
  "experimental-webgl": {
    "ok": true,
    "version": "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
    "vendor": "WebKit",
    "renderer": "WebKit WebGL",
    "sl": "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
    "extCount": 23
  }
}
```

说明：

- `webgl` 成功；
- `webgl2` 成功；
- `experimental-webgl` 成功。

---

## 为什么 `--in-process-gpu` 能解决问题

Chromium 默认会把 GPU 相关工作放到独立 GPU 进程中。这样做在普通桌面平台上更安全，因为 GPU 进程崩溃不会直接带崩浏览器主进程。

但是在当前平台上，独立 GPU 进程初始化 EGL/GLES 时触发了不兼容路径，具体表现为：

```text
Passthrough is not supported
GPU process exited unexpectedly
```

`--in-process-gpu` 会让 GPU 服务在浏览器主进程内运行，从而绕过这个独立 GPU 进程初始化问题。

这不是最理想的桌面浏览器架构，但在嵌入式 ARM / PowerVR / sunxi 这种驱动栈上，是常见的兼容性 workaround。

---

## 各参数作用说明

### `--ignore-gpu-blocklist`

忽略 Chromium 内置 GPU 黑名单。

嵌入式 GPU、非主流 Mesa/厂商 EGL 驱动、旧版 ARM GPU 很容易被 Chromium 认为不稳定，从而禁用 WebGL 或部分硬件加速。

### `--use-gl=egl`

强制 Chromium 使用 EGL，而不是 GLX 或其他 OpenGL 后端。

当前系统是 ARM + EGL/GLES 驱动栈，GLX 路线不可用或不完整。

### `--in-process-gpu`

让 GPU 服务运行在浏览器主进程中，绕过外置 GPU 进程崩溃问题。

这是恢复 WebGL 的关键参数。

### `--disable-vulkan`

禁用 Vulkan 路径。

之前日志显示 Vulkan 初始化失败：

```text
Internal Vulkan error (-3)
```

因此需要避免 Chromium / ANGLE fallback 到 Vulkan。

### `--disable-features=Vulkan`

进一步禁用 Chromium feature 层面的 Vulkan 启用逻辑。

### `--disable-gpu-driver-bug-workarounds`

禁用 Chromium 对某些驱动的自动 workaround。

在该环境中，配合 `--ignore-gpu-blocklist` 使用，避免 Chromium 因驱动识别或策略导致 WebGL 被禁用。

---

## 仍然可以忽略的日志

恢复 WebGL 后，启动 Chromium 仍可能看到以下日志：

```text
Failed to connect to the bus
UPower was not provided
Cloud management controller initialization aborted
```

这些与 WebGL 无关，通常是因为当前桌面/session 环境中没有完整 DBus、UPower 或 Chrome 企业管理服务。

还可能看到：

```text
spawn_subprocess.cc(236)] posix_spawn: No such file or directory
```

这看起来与 crashpad 或某个辅助子进程组件有关。目前它没有阻止 Chromium 启动，也没有阻止 WebGL 创建。

---

## 验证方法

### 方法一：打开 Chromium GPU 页面

```text
chrome://gpu
```

重点查看：

- `WebGL`
- `WebGL2`
- `Compositing`
- `GL_RENDERER`
- `Problems Detected`

### 方法二：访问 WebGL 测试页面

```text
https://get.webgl.org/
https://webglreport.com/
```

### 方法三：命令行启动并观察日志

```bash
export DISPLAY=:0
CHROMIUM_DEBUG=1 /usr/local/chromium/bin/chromium-browser
```

正常情况下，启动参数中应包含：

```text
--ignore-gpu-blocklist --use-gl=egl --in-process-gpu --disable-vulkan --disable-features=Vulkan
```

并且不应再反复出现：

```text
Passthrough is not supported
GPU process exited unexpectedly
```

---

## 当前最终状态

Chromium WebGL 已恢复，实测结果：

| API | 状态 |
| --- | --- |
| WebGL 1.0 | 可用 |
| WebGL 2.0 | 可用 |
| experimental-webgl | 可用 |

最终修复点：

1. 修复启动脚本读取 `CHROMIUM_FLAGS`；
2. 使用 EGL；
3. 禁用 Vulkan；
4. 使用 `--in-process-gpu` 绕过外置 GPU 进程崩溃。
