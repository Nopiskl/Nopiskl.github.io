---

**User**

请你获取tty3虚拟终端输出，解决问题

---

**Cursor**

我来帮你获取 tty3 虚拟终端的输出：

我看到问题了！glmark2-es2-drm 运行时报错：`Error: Failed to find a suitable connector`，这意味着它找不到合适的 DRM 显示连接器。让我检查一下可用的 DRM 设备：

好的，HDMI 是连接的。问题可能是 glmark2-es2-drm 需要指定正确的 DRM 设备。让我尝试指定设备：

---

**User**

继续

---

**Cursor**

让我检查 glmark2-es2-drm 的帮助信息，看看正确的参数：

找到了！参数是 `drm-device`（不带双横线前缀）。让我尝试：

---

**User**

继续

---

**Cursor**

让我尝试 card1 设备：

让我检查一下 DRM 连接器的详细信息：

我看到了！card0 有 HDMI-A-1 连接器，而 card1 是 GPU 设备（没有显示连接器）。让我检查一下 card0 的连接器状态并尝试指定连接器：

HDMI 是连接并启用的。让我尝试指定连接器 ID：

---

**User**

继续

---

**Cursor**

让我深入看看源代码中是怎么查找 connector 的：

问题找到了！它使用 `drmModeGetResources` 来获取连接器，但是这个 sunxi DRM 驱动可能不通过传统方式暴露连接器。让我检查下：

HDMI 连接器存在且已连接（connector id=147）。问题可能是 Writeback 连接器的干扰，或者是当桌面环境（KDE/SDDM）占用了 DRM master 导致无法使用。让我查看下：

现在我明白了！问题在于 Writeback 连接器类型。glmark2 的代码遍历所有连接器时，可能因为 Writeback 连接器而出问题。让我检查 card0 的 Writeback 连接器的 connection 状态：

找到根本原因了！glmark2-es2-drm 自动检测时打开的是 `/dev/dri/card1`（GPU 设备），但它没有 HDMI 连接器。HDMI 连接器在 card0 上。让我看看源码中设备检测逻辑，然后修改：

问题确认了！`open_using_module_checking` 中的驱动名列表里有 `sun4i-drm` 但没有 `sunxi-drm`（你的设备用的驱动）。udev 扫描打开了 card1（GPU 设备），而 card1 没有 HDMI 连接器。我需要添加 `sunxi-drm` 驱动名到列表中，并且确保优先打开有连接器的 card0。

编译安装成功！现在请在 tty3 上重新运行 `glmark2-es2-drm`。由于桌面环境（SDDM/KDE）可能仍然占用着 DRM master，在 tty3 上运行前可能需要先停止桌面环境。让我帮你测试一下：

glmark2-es2-drm 已经成功运行了！🎉

从输出可以看到：

- **GPU 信息**：PowerVR B-Series BXM-4-64（Imagination Technologies）
- **OpenGL ES 版本**：3.2
- **分辨率**：1920x1080 全屏
- **测试结果**（部分）：
  - `[build] use-vbo=false`：**536 FPS**
  - `[build] use-vbo=true`：**632 FPS**
  - `[texture] texture-filter=nearest`：**651 FPS**

之前的问题是 glmark2 自动检测 DRM 设备时打开了 `/dev/dri/card1`（GPU 渲染节点，没有显示连接器），而 HDMI 连接器在 `/dev/dri/card0`（sunxi-drm）上。我修改了源码，让它在检测到设备没有可用连接器时自动回退扫描其他 card 节点，问题已解决。

如果你想在 tty3 上运行完整测试，可以执行：`sudo glmark2-es2-drm`。

---

**User**

问题原因是什么

---

**Cursor**

问题的根本原因是 **glmark2-es2-drm 自动检测 DRM 设备时，选错了设备节点**。

你的系统有两个 DRM 设备：

| 设备 | 驱动 | 作用 | 有 HDMI 连接器？ |
|------|------|------|----------------|
| `/dev/dri/card0` | `sunxi-drm` | 显示控制器（负责 HDMI 输出） | ✅ 有（HDMI-A-1，已连接） |
| `/dev/dri/card1` | `1800000.gpu`（PowerVR） | GPU 渲染设备 | ❌ 没有 |

glmark2 通过 udev 扫描自动选择了 **card1**（GPU 渲染设备），但 card1 只是一个纯 GPU 渲染节点，没有任何显示连接器（HDMI/DP等）。所以 `drmModeGetResources` 获取不到连接器，就报错：

```
Error: Failed to find a suitable connector
```

而真正有 HDMI 连接器的是 **card0**（sunxi-drm 显示控制器）。

**修复方式**：我修改了 `native-state-drm.cpp` 中的 `init()` 函数，添加了回退逻辑——当 udev 选择的设备没有已连接的显示连接器时，自动遍历所有 `/dev/dri/cardN` 节点，找到一个有已连接连接器的设备来使用。同时也在驱动列表中添加了 `sunxi-drm`，使 module 检测也能匹配到你的显示驱动。

```plaintext
Error: Failed to find a suitable connector
```

---

**User**

为什么会选错？你修改了源码的哪一部分

---

**Cursor**

## 为什么会选错？

glmark2 的设备选择逻辑在 `native-state-drm.cpp` 的 `init()` 函数中，按以下顺序尝试打开 DRM 设备：

1. **用户指定的设备**（`--winsys-options drm-device=xxx`）
2. **udev 扫描**（`open_using_udev_scan()`）
3. **驱动名匹配**（`open_using_module_checking()`）

你的情况下，第 1 步没指定设备，所以走到第 2 步 **udev 扫描**。udev 扫描找到了 `/dev/dri/card1`（PowerVR GPU），就直接用了它。

**问题就在于：glmark2 只检查设备能不能打开，不检查它有没有显示连接器。** 打开 card1 成功后就直接用了，但 card1 是纯 GPU 渲染设备，没有 HDMI 连接器，后面查找连接器时自然就失败了。

而第 3 步的驱动名列表里有 `sun4i-drm`（旧的全志驱动名），但没有 `sunxi-drm`（你的设备用的驱动名），所以即使走到第 3 步也匹配不上。

## 修改了源码的哪些部分？

### 修改 1：添加 `<unistd.h>` 头文件（为了使用 `close()` 函数）

```31:32:/home/radxa/project/glmark2/src/native-state-drm.cpp
#include <fcntl.h>
#include <unistd.h>
```

### 修改 2：在驱动名列表中添加 `sunxi-drm`

```581:582:/home/radxa/project/glmark2/src/native-state-drm.cpp
        "sun4i-drm",
        "sunxi-drm",
```

### 修改 3：`init()` 函数中添加连接器验证和回退逻辑

原始逻辑（简化）：

```cpp
fd = open_using_udev_scan();       // 打开 card1 成功就直接用
// 没有验证 card1 是否有连接器！
resources_ = drmModeGetResources(fd);  // card1 没有连接器
// 遍历连接器 → 找不到 → 报错退出
```

修改后的逻辑（简化）：

```cpp
fd = open_using_udev_scan();       // 打开 card1

// 【新增】验证这个设备是否有已连接的显示连接器
if (valid_fd(fd)) {
    auto *res = drmModeGetResources(fd);
    bool has_connector = false;
    // 遍历检查是否有 connected 状态的连接器
    for (...) {
        if (conn->connection == DRM_MODE_CONNECTED) {
            has_connector = true;
            break;
        }
    }
    // 【新增】如果没有连接器，关掉这个设备，遍历所有 /dev/dri/cardN 找有连接器的
    if (!has_connector) {
        close(fd);
        for (int i = 0; i < 16; i++) {
            fd = open("/dev/dri/cardN");
            // 找到有 connected 连接器的设备就用它（card0）
        }
    }
}
```

核心思路：**打开设备后先验证它有没有已连接的显示连接器，如果没有就回退遍历所有 card 设备，直到找到一个有连接器的（card0 / sunxi-drm / HDMI-A-1）**。

```cpp
#include <fcntl.h>
#include <unistd.h>
```

```cpp
        "sun4i-drm",
        "sunxi-drm",
```

```cpp
fd = open_using_udev_scan();       // 打开 card1 成功就直接用
// 没有验证 card1 是否有连接器！
resources_ = drmModeGetResources(fd);  // card1 没有连接器
// 遍历连接器 → 找不到 → 报错退出
```

```cpp
fd = open_using_udev_scan();       // 打开 card1

// 【新增】验证这个设备是否有已连接的显示连接器
if (valid_fd(fd)) {
    auto *res = drmModeGetResources(fd);
    bool has_connector = false;
    // 遍历检查是否有 connected 状态的连接器
    for (...) {
        if (conn->connection == DRM_MODE_CONNECTED) {
            has_connector = true;
            break;
        }
    }
    // 【新增】如果没有连接器，关掉这个设备，遍历所有 /dev/dri/cardN 找有连接器的
    if (!has_connector) {
        close(fd);
        for (int i = 0; i < 16; i++) {
            fd = open("/dev/dri/cardN");
            // 找到有 connected 连接器的设备就用它（card0）
        }
    }
}
```

