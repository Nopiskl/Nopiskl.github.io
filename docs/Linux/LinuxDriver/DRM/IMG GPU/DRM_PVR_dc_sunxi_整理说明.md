# DRM / KMS / PVR / dc_sunxi 关系整理

## 一、先给结论

你当前这套 BSP 之所以会出现：

- **GPU 驱动走标准 DRM 注册**
- **显示输出却不走 DRM/KMS，而走第三方 disp/fbdev**

并不矛盾，原因在于：

> **DRM 是大框架，KMS 只是 DRM 里负责显示输出的一个子模型。**

所以可以只使用 DRM 中的：

- 设备注册
- `/dev/dri/cardX` / `renderD*` 节点
- ioctl 框架
- buffer / 同步 / 渲染访问入口

而**不使用** DRM 中的：

- Plane
- CRTC
- Encoder
- Connector
- Atomic modeset

也就是说：

> **可以“GPU 走 DRM”，但“显示不走 DRM/KMS”。**

你这套 PVR + `dc_sunxi` 的 BSP，本质上就是这种混合架构。

---

## 二、为什么很多资料把 DRM 画成你看到的那张图？

很多资料会把 DRM 画成如下结构：

- Framebuffer
- Plane
- CRTC
- Encoder
- Connector
- Monitor

这张图本身**没有错**，但它描述的其实不是“整个 DRM 的全部”，而是：

> **DRM 中 KMS（Kernel Mode Setting）显示管线的标准对象模型。**

它回答的是这个问题：

> **一块图像数据，如何经过显示控制器，最终输出到屏幕上？**

所以它天然是“显示驱动视角”的图，而不是“所有使用 DRM 的 GPU/图形驱动都必须长成这样”的总图。

### 2.1 这张图强调的是显示链路

它重点描述的是：

- framebuffer 如何被扫描输出
- 一个 CRTC 驱动一个显示时序
- encoder 负责把像素流转成具体接口信号
- connector 代表最终连接端口
- plane 作为硬件图层叠加来源

因此它特别适合解释：

- 分辨率切换
- 双屏输出
- 热插拔
- page flip
- atomic commit
- overlay plane

这也是为什么很多文章讲 DRM 时，一上来就用这张图。

### 2.2 但这不等于 DRM 只有这一部分

更准确地说，DRM 可以粗分成三块：

1. **DRM Core / UAPI 层**
   - 设备注册
   - 文件节点
   - ioctl 框架
   - buffer / memory object
   - 同步 / fence
   - 用户态访问接口

2. **DRM Render / GPU 接入层**
   - render node
   - 命令提交
   - GPU buffer 管理
   - 图形加速访问入口

3. **DRM KMS 显示层**
   - plane
   - crtc
   - encoder
   - connector
   - modeset / atomic

所以你看到的图，实际上只是在讲第 3 部分。

---

## 三、DRM 和 KMS 到底是什么关系？

很多人把这两个词混用，这是理解误区的根源。

### 3.1 DRM

DRM（Direct Rendering Manager）是 Linux 内核里的图形设备管理框架。它并不只负责显示输出，而是为图形设备提供统一的：

- 设备节点
- 用户态访问入口
- ioctl 调用框架
- buffer 管理
- 同步机制
- GPU / 显示相关的内核抽象

### 3.2 KMS

KMS（Kernel Mode Setting）是 DRM 内部专门负责**显示模式设置与扫描输出**的子系统。

它主要解决：

- 谁来扫 framebuffer
- 分辨率怎么切换
- 输出到 HDMI/DSI/LVDS 还是 LCD
- 哪些 plane 叠到哪个 CRTC 上
- 如何原子提交新的显示状态

所以：

> **DRM 是总框架，KMS 是其中“显示输出”那一部分。**

因此：

- 一个驱动可以使用 DRM Core + Render
- 但不一定要使用 DRM KMS

这就是你当前 BSP 能成立的理论基础。

---

## 四、为什么 GPU 可以只走 DRM 注册？

因为从硬件职责上看：

### 4.1 GPU 负责“画”

GPU 的主要职责是：

- 执行 3D / 2D 图形命令
- shader 计算
- 纹理采样
- 光栅化
- 把渲染结果写入某个 buffer

也就是说，GPU 主要负责的是：

> **把一块图画出来，写到内存或显存里。**

### 4.2 Display Controller 负责“播”

显示控制器（DE / TCON / LCDC / Display Engine）的职责则是：

- 周期性读取某块 framebuffer
- 按时序生成输出
- 驱动 LCD / HDMI / DSI / eDP 等接口
- 扫描到屏幕上

它负责的是：

> **把已经存在的那块 buffer，按显示时序送到面板。**

### 4.3 二者本来就不是同一件事

所以从根上说：

- **GPU = 生产图像内容**
- **显示控制器 = 输出图像内容**

它们可以在一个统一框架里协同，也可以拆开。

因此一个系统完全可以这样实现：

- GPU 通过 DRM 提供标准访问入口
- 显示控制器继续走私有 fbdev / disp 框架

这并不违反 DRM 设计。

---

## 五、你当前 BSP 的真实结构是什么？

你的 BSP 不是“完整 DRM/KMS 显示栈”，而是：

> **DRM 负责 GPU 接入，第三方显示后端负责扫描输出。**

也就是两段式结构。

### 5.1 第一段：GPU 接入 DRM

PVR 相关驱动中，`pvr_platform_drv.c / pvr_drm.c` 做的事情主要是：

- `drm_dev_alloc()`
- `drm_dev_register()`
- 注册 `struct drm_driver`
- 提供 `drm_open / drm_ioctl / drm_poll / ...`
- 暴露 `/dev/dri/cardX` 与可能的 `renderD*`
- 通过 PVR bridge ioctl 把请求转发给 `pvrsrvkm`

这层的意义是：

> **给用户态图形栈一个标准 Linux GPU 访问入口。**

所以这里的 DRM 主要扮演的是：

- 设备节点框架
- ioctl 分发框架
- 图形设备标准注册入口

而不是显示输出控制器本身。

### 5.2 第二段：显示走 dc_sunxi / fbdev

你提供的信息表明，`services/3rdparty/dc_sunxi/dc_sunxi.c`：

- 依赖 `linux/fb.h`
- 强制 `CONFIG_FB`
- 初始化时直接使用 `registered_fb[0]`
- 构造 `DC_DEVICE_FUNCTIONS`
- 通过 `DCRegisterDevice()` 向 PVR Services 注册显示后端
- 显示切换通过 `fb_pan_display()` / `fb_set_var()`
- 退出时 `DCUnregisterDevice()`

这说明：

> **真正负责把图送上屏的，不是 DRM/KMS，而是 fbdev + sunxi 私有显示栈。**

也就是说你的 BSP 里最终点亮屏、翻页、改显示参数的 owner 是：

- `dc_sunxi`
- `fbdev`
- `sunxi disp2`

而不是 DRM KMS 对象模型。

---

## 六、为什么这不算“绕过 DRM”，而是“只用了 DRM 的一部分”？

表面上看，好像是：

- GPU 注册进了 DRM
- 却没走 DRM 显示对象链

所以看起来像“绕过 DRM”了。

但准确地说不是绕过，而是：

> **它本来就只想用 DRM 的 GPU/设备接入部分，没有打算用 DRM 的 KMS 显示部分。**

换句话说，它不是违反规则，而是在规则允许的范围内**只取 DRM 的一部分能力**。

### 6.1 你可以把它理解成“分层使用”

系统把图形路径分成两段：

#### A. 渲染段

应用 / EGL / GLES  
→ PVR 用户态库  
→ `pvr_drm` 提供的 `/dev/dri/cardX` 或 render node  
→ `pvrsrvkm`  
→ GPU 渲染出 buffer

#### B. 显示段

渲染结果 buffer  
→ PVR Services / DisplayClass  
→ `dc_sunxi`  
→ fbdev / `fb_pan_display()` / `fb_set_var()`  
→ sunxi disp2 / 显示控制器  
→ LCD / HDMI / 面板输出

所以这不是一条“全 DRM”链，而是一条“DRM + 私有显示后端”的混合链。

---

## 七、那张 DRM/KMS 图和你这套 BSP 的区别到底在哪？

### 7.1 标准 DRM/KMS 全栈模型

标准主线式的显示栈一般是：

应用 / 合成器  
→ DRM framebuffer / GEM buffer  
→ plane  
→ crtc  
→ encoder  
→ connector  
→ 屏幕

这套模型里：

- 显示控制器已经被包装成 DRM/KMS 对象
- page flip / modeset / vblank / atomic commit 都在 DRM 里做
- 用户态直接和 KMS 交互控制显示

### 7.2 你当前 BSP 的模型

你当前这套更像：

应用 / EGL / GLES  
→ PVR DRM 节点（设备注册、ioctl、render 接口）  
→ GPU 渲染出 buffer  
→ DisplayClass / `dc_sunxi`  
→ fbdev / sunxi disp2  
→ 屏幕

也就是说：

- **GPU 接入是现代化的 DRM 方式**
- **显示输出仍然是老式 fbdev / 私有 disp 方式**

所以它不是“标准 DRM/KMS 全栈”，而是“DRM core + 第三方显示后端”。

---

## 八、为什么很多厂商 BSP 会故意这么设计？

因为这是现实工程里的折中方案。

### 8.1 把 GPU 接进 DRM 的好处

GPU 接进 DRM 后，用户态图形栈更容易适配：

- 可以有标准 `/dev/dri/*` 节点
- 更容易承接 EGL / GLES / 某些 Mesa 或 vendor userspace
- 更贴近 Linux 图形栈通用习惯
- 用户态不必全靠一套极其私有的字符设备接口

### 8.2 但把显示栈改成完整 DRM/KMS 代价很高

如果要把原有私有 disp/fbdev 显示框架全部改造成标准 DRM/KMS，通常需要补齐：

- `drm_mode_config`
- plane/crtc/encoder/connector 对象
- fb import/export
- vblank
- page flip
- atomic check/commit
- format / modifier
- multi-plane / overlay
- 热插拔路由
- 多屏组合

这通常工作量非常大。

### 8.3 所以厂商常选折中方案

于是很多 BSP 会采用下面这个策略：

- **GPU 先接入标准 DRM**
- **显示继续沿用旧 fbdev / disp 框架**

优点是：

- 接入成本低
- 老显示驱动不用大改
- 可以尽快让 3D 加速跑起来

缺点是：

- 图形栈割裂
- 显示路径不标准
- 和现代 Wayland / GBM / atomic KMS 的兼容性较差
- 调试时容易让人误以为“已经是完整 DRM 方案”

---

## 九、`DRIVER_MODESET` 为什么会让人误解？

你提到 `pvr_drm.c` 里 `driver_features` 包含：

- `DRIVER_MODESET`
- `DRIVER_RENDER`

这确实很容易让人以为：

> “既然有 DRIVER_MODESET，那一定完整走 DRM/KMS 显示了。”

但实际判断不能只看这个标志。

### 9.1 标志位只是“宣称能力”或模板继承

很多厂商 BSP 代码：

- 来自通用 vendor 模板
- 共用一套框架代码
- 某些 flag 会统一打开
- 但并不代表该平台实际完整接通了对应能力

所以 `DRIVER_MODESET` 被置位，最多只能说明：

- 它自称可以支持某类 modeset 能力
- 或者代码框架保留了 modeset 壳子

但**不能直接证明**：

- 已经实现完整的 KMS 对象图
- 实际 page flip/modeset 真由 DRM 执行
- 这个 BSP 的显示控制器真的挂在 DRM KMS 下面

### 9.2 真正判断是否“走 DRM 显示”的关键

要判断是不是完整走 DRM/KMS，应该看是否真正存在并被使用：

- `drm_mode_config`
- plane / crtc / encoder / connector 对象初始化
- `atomic_check()` / `atomic_commit()`
- vblank / page flip
- modeset 最终是否驱动显示控制器

如果这些都没有成为实际显示主通路，而出图仍依赖：

- `registered_fb[]`
- `fb_pan_display()`
- `fb_set_var()`
- 私有 disp ioctl / 私有 layer 管理

那就说明：

> **真正的显示 owner 不是 DRM/KMS，而是 fbdev / 私有 disp。**

---

## 十、为什么你会觉得“GPU 不是也应该属于那张图里吗”？

这是因为很多人会把“渲染结果所在的 framebuffer”和“显示控制器扫描的 framebuffer”混成一个概念。

实际上这两者虽然可能指向同一块内存，但逻辑角色不同。

### 10.1 从职责上分开看

#### GPU 看这块 buffer

GPU 把它当作：

- render target
- color buffer
- surface
- texture 输出目标

重点是：

> **我要往这里画。**

#### 显示控制器看这块 buffer

显示控制器把它当作：

- scanout buffer
- framebuffer
- 当前显示内容源

重点是：

> **我要从这里按时序读，并输出到屏。**

所以同一块内存，可以同时有两个身份：

- 对 GPU 来说是渲染目标
- 对显示控制器来说是扫描源

### 10.2 谁来接管这块 buffer，是架构问题

在完整 DRM/KMS 全栈里，这块 buffer 会纳入 DRM/KMS 管线管理：

- 变成 DRM framebuffer
- 绑定到 plane
- 再送到 crtc / encoder / connector

而在你现在这套 BSP 里，这块 buffer 并不是交给 DRM/KMS 去 scanout，而是交给：

- PVR Services 的 DisplayClass
- `dc_sunxi`
- fbdev / disp

所以问题不在于“有没有 framebuffer”，而在于：

> **最终是谁在管理 scanout 这条链。**

---

## 十一、用一句最核心的话总结整个问题

你现在这套代码之所以成立，是因为：

> **DRM 不只包含显示 KMS，也包含图形设备注册和渲染访问框架；PVR 只用了 DRM 的 GPU 接入部分，而把显示输出交给了第三方 fbdev/disp 后端。**

所以：

- 你看到的那张图没错，但它是 **DRM/KMS 显示模型图**
- 你手上的 BSP 也没错，但它实现的是 **DRM core + vendor DisplayClass + fbdev/disp** 的混合方案

这两者并不冲突。

---

## 十二、把两个模型放在一起对照

### 12.1 标准 DRM/KMS 全栈

```text
应用/合成器
   ↓
DRM buffer / framebuffer
   ↓
Plane
   ↓
CRTC
   ↓
Encoder
   ↓
Connector
   ↓
显示器
```

特点：

- 显示对象全部在 DRM/KMS 里
- page flip / modeset / atomic 在 DRM 内完成
- 是现代主线显示驱动常见做法

### 12.2 你当前 PVR + dc_sunxi BSP

```text
应用 / EGL / GLES
   ↓
PVR 用户态库
   ↓
pvr_drm (/dev/dri/cardX, renderD*)
   ↓
pvrsrvkm / GPU
   ↓
渲染结果 buffer
   ↓
PVR DisplayClass
   ↓
dc_sunxi
   ↓
fbdev / sunxi disp2
   ↓
面板 / HDMI / LCD
```

特点：

- DRM 负责 GPU 设备接入
- DisplayClass 负责显示后端对接
- 最终 scanout 不在 DRM/KMS 中完成
- 是典型 BSP 厂商折中实现

---

## 十三、以后如何快速判断一个 BSP 到底是不是“真 DRM 显示栈”？

不要只看：

- 有没有 `struct drm_driver`
- 有没有 `/dev/dri/card0`
- 有没有 `DRIVER_MODESET`

这些只能说明“它和 DRM 有关系”，不能说明“显示一定由 DRM/KMS 接管”。

真正应该看的是：

### 13.1 看是否有完整 KMS 对象链

是否有：

- `drm_mode_config`
- plane
- crtc
- encoder
- connector
- atomic state

### 13.2 看显示提交流程是否真的进入 DRM KMS

是否经过：

- `atomic_check`
- `atomic_commit`
- page flip
- vblank
- modeset

### 13.3 看最终扫屏是谁做的

如果最终还是靠：

- `registered_fb[]`
- `fb_pan_display()`
- `fb_set_var()`
- 私有 disp / layer / ioctl

那说明实际显示链还是老的 fbdev/私有框架。

### 13.4 一句判断法

- **如果 scanout owner 是 plane/crtc/connector → 这是 DRM/KMS 显示**
- **如果 scanout owner 是 fbdev/disp → 这是第三方显示后端**

---

## 十四、最终总括

你现在的困惑，可以压缩成一句话：

> 为什么我学到的 DRM 架构图是 framebuffer → plane → crtc → encoder → connector，而实际 PVR GPU 却能只在 DRM 注册，然后把显示交给第三方 disp？

答案就是：

> 因为你学到的是 DRM 的 **KMS 显示架构图**，而不是 DRM 的全部；PVR 只使用了 DRM 的设备注册/渲染访问部分，并没有要求显示输出也必须走 DRM/KMS，所以它可以和 `dc_sunxi` 这种第三方 fbdev 显示后端组合使用。

再精炼一点：

> **GPU 负责画，Display Controller 负责播；DRM 能管两者，但不强制两者必须都由 DRM/KMS 管。**

