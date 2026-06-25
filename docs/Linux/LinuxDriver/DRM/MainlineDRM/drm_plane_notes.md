# Linux DRM 中的 plane、`drm_plane` 与 `drm_plane_state`

## 1. 什么是 DRM 里的 plane

在 Linux 图形栈里，DRM 的 **plane** 可以理解成：

> 一次独立的扫描输出图层。

更直白一点，显示控制器在往屏幕送数据时，不一定只会读一个 framebuffer。它可以同时读多个 buffer，把它们按位置、大小、混合规则叠到一起，最后输出到屏幕。
这些可被硬件单独取数、缩放、定位、混合的图层，就是 DRM 里的 **plane**。

---

## 2. plane 和 framebuffer / CRTC / connector 的关系

可以把这几个对象这样看：

- **framebuffer**：一块像素数据
- **plane**：拿着某个 framebuffer，决定“显示到哪里、怎么显示”
- **CRTC**：负责扫描时序和最终合成输出
- **connector**：输出接口，比如 HDMI、eDP、DP

所以常见关系是：

> framebuffer 绑定到 plane，plane 再挂到某个 CRTC 上，CRTC 通过 connector 输出到屏幕。

---

## 3. plane 具体管什么

一个 plane 通常会描述这些内容：

- 用哪个 framebuffer
- framebuffer 的哪个区域参与显示（source rect）
- 显示到屏幕的哪个位置（CRTC rect）
- 显示尺寸，是否缩放
- 像素格式是否支持
- 旋转、镜像、alpha、zpos 等属性（取决于硬件）

所以 plane 本质上是：

> 一个硬件层的配置对象，而不是像素本身。

---

## 4. 为什么需要 plane

因为很多显示控制器支持硬件合成。这样就不用 GPU 先把所有内容画成一张大图，再送显示器，而是可以：

- 底图一个 plane
- 视频一个 plane
- 光标一个 plane
- UI 叠加一个 plane

最后由显示硬件直接合成。

这样做的好处：

- 降低内存带宽
- 减少 GPU 合成开销
- 视频播放更高效
- 光标移动更丝滑

---

## 5. 常见的 plane 类型

### 5.1 Primary plane

主平面。
一般承载主显示内容，通常每个 CRTC 至少有一个 primary plane。

### 5.2 Overlay plane

叠加平面。
用于额外图层，比如视频层、UI 层等。

### 5.3 Cursor plane

光标平面。
专门给鼠标指针这种小图层用，通常支持快速更新位置。

---

## 6. 举个例子

比如桌面上播放视频：

- 桌面背景和窗口内容：primary plane
- 视频画面：overlay plane
- 鼠标指针：cursor plane

这样视频窗口移动时，不一定需要整屏重绘，只要调整对应 plane 的位置或内容即可。

---

## 7. 在 atomic DRM 里怎么理解 plane

在 atomic 模型下，plane 是一个可原子提交的对象。
你会给 plane 设置一组属性，例如：

- `FB_ID`
- `CRTC_ID`
- `SRC_X / SRC_Y / SRC_W / SRC_H`
- `CRTC_X / CRTC_Y / CRTC_W / CRTC_H`

然后和 CRTC、connector 的状态一起一次性提交。
这样就能保证一次更新里，多个 layer 的切换是同步生效的，不会出现撕裂或中间态错误。

---

## 8. `drm_plane` 和 `drm_plane_state` 分别是干什么的

在 DRM/KMS 里，这两个结构可以这样区分：

- **`drm_plane`**：描述“这个 plane 本身是什么、能做什么”
- **`drm_plane_state`**：描述“这个 plane 当前或目标要怎么用”

最简单的理解是：

- `drm_plane` 像是 **对象本体**
- `drm_plane_state` 像是 **对象在某一时刻的配置快照**

---

## 9. `drm_plane` 是干什么的

`drm_plane` 表示一个真实存在的显示硬件层。

它主要保存的是这个 plane 的**静态能力**和**身份信息**，比如：

- 这个 plane 支持哪些 pixel format
- 能挂到哪些 CRTC 上
- 它是什么类型
  - primary
  - overlay
  - cursor
- 它有哪些属性
- 它在 DRM 核心里的对象信息

所以 `drm_plane` 更像“硬件资源描述”。

你可以把它理解成：

> 系统里有一个 planeA，它是 overlay plane，支持 NV12/XRGB8888，能绑定到 crtc0/crtc1。

这些内容通常不是一帧一变的。

---

## 10. `drm_plane_state` 是干什么的

`drm_plane_state` 表示这个 plane **这次提交时的具体显示配置**。

它保存的是 plane 在一次 atomic commit 里的状态，例如：

- 绑定哪个 framebuffer：`fb`
- 挂到哪个 CRTC：`crtc`
- framebuffer 取哪一块区域：`src_x/y/w/h`
- 显示到屏幕哪个位置：`crtc_x/y/w/h`
- 旋转、alpha、zpos、颜色空间之类的运行时属性
- 可见性、缩放相关状态
- 驱动私有扩展状态

所以 `drm_plane_state` 更像：

> 这一次，我要把 fb0 的 `(0,0,1920,1080)` 显示到 crtc0 的 `(100,50,1280,720)` 区域。

这类信息是会频繁变化的。

---

## 11. 为什么要分成两个结构

因为 DRM atomic 模型要求把“对象本身”和“对象状态”分开。

这样做有几个好处：

### 11.1 便于原子更新

一次 commit 时，不直接改 `drm_plane` 本体，而是先构造新的 `drm_plane_state`，检查合法后再整体切换。

### 11.2 便于 old/new state 对比

驱动在 `atomic_check`、`atomic_update` 里经常需要比较：

- old plane state
- new plane state

例如：

- fb 变没变
- 显示位置变没变
- 是否需要重新编程缩放器
- 是否需要关掉 plane

### 11.3 避免中间态污染

如果直接改 plane 本体，检查失败后很难回滚。
而 state 是临时快照，失败就丢掉即可。

---

## 12. 一个形象类比

可以把它类比成“显示器支架”：

- **`drm_plane`**：这只支架本身，能承重多少、能否旋转、装在哪
- **`drm_plane_state`**：当前把哪块屏装上去了、转了多少度、摆在什么位置

---

## 13. 代码层面通常怎么配合

通常一个 `drm_plane` 里会有一个当前状态指针，大致可以理解为：

- `plane->state` 指向当前生效的 `drm_plane_state`

而在 atomic 提交流程里，会存在：

- old state
- new state

驱动会做这种事情：

1. 用户空间发起 atomic request
2. DRM core 为相关对象准备新的 state
3. 驱动执行 `atomic_check`
4. 检查通过后执行 `atomic_commit`
5. 用 new state 替换 old state

---

## 14. `drm_plane` 更偏“能力”，`drm_plane_state` 更偏“配置`

| 结构 | 作用 |
|---|---|
| `drm_plane` | plane 这个对象本身，描述硬件层能力、类型、支持格式、可挂接 CRTC 等 |
| `drm_plane_state` | plane 某次显示提交时的状态，描述 framebuffer、位置、裁剪、缩放、旋转等 |

---

## 15. 实际驱动里最常见的操作

### 15.1 在 `drm_plane` 侧

- 初始化 plane
- 注册 format / modifier
- 设置 helper funcs / funcs
- 指定 possible CRTCs
- 创建 plane property

### 15.2 在 `drm_plane_state` 侧

- 在 `atomic_check` 里检查新状态是否合法
- 在 `atomic_update` 里按新状态编程寄存器
- 在 `atomic_disable` 里关闭 plane
- 做状态复制、重置、销毁

---

## 16. 一个关键点

不要把 `drm_plane_state` 理解成“软件缓存而已”。
它不是随便存一份参数，而是 atomic KMS 的核心状态载体。驱动的检查、提交、同步，很多都围着它转。

---

## 17. 一句话总结

- **plane**：显示控制器中的一个硬件显示层
- **`drm_plane`**：这个 plane 是谁、有什么能力
- **`drm_plane_state`**：这个 plane 现在或下一次要怎么显示
