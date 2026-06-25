# Analysis of @package/wayland
_Exported on 2026/4/2 at GMT+8 12:57:45 from Cursor (2.6.21)_

---

**User**

@package/wayland 分析一下这个包

---

**Cursor**

我看了 `package/wayland`，这是一个**基于 OpenWrt/Tina SDK 打包体系的 Wayland 图形栈集合**，不是单一包，里面主要有 4 个子包：

- `wayland/`（核心协议库）
- `wayland-protocols/`（扩展协议）
- `weston/`（参考 compositor）
- `glmark2/`（图形性能测试）

---

### 总体定位

这个目录的作用是给板端提供完整 Wayland 运行环境：

- `wayland` 提供 client/server 基础库和 `wayland-scanner`
- `wayland-protocols` 提供协议 XML
- `weston` 作为实际显示合成器
- `glmark2` 用于 OpenGL ES 性能验证

并且明显做了很多 **Allwinner 平台定制**（DE 合成、video layer、NV21、IVI shell 等）。

---

### 版本和“年代感”

目前版本都偏老：

- `wayland`：`1.13.0`
- `wayland-protocols`：`1.7`
- `weston`：`2.0.0`
- `glmark2`：固定到某个 commit（`7215c0f...`）

这通常意味着：  
- 优点：和当前 BSP/驱动适配稳定  
- 缺点：上游功能与安全更新较旧，后续升级成本高

---

### 子包分析

#### 1) `wayland/`
特点：

- 同时构建 host 和 target（`wayland-scanner` 交叉编译链常见做法）
- 显式关闭 tests/documentation
- 带了 patch：`configure` 增加禁用 tests 选项，适合产品裁剪

结论：这部分偏标准，改动不算激进，主要是为交叉编译和体积优化服务。

---

#### 2) `wayland-protocols/`
特点：

- 依赖 `wayland`
- 打包逻辑简单：把 `usr/share` 协议文件安装到目标根文件系统

结论：比较“纯净”，主要是协议数据包。

---

#### 3) `weston/`（定制最重）
这里是核心风险点和价值点，patch 非常多（19 个），包含：

- DE 相关合成路径（overlay、zorder 等）
- NV21/YUV 相关支持
- `ivi-shell` 支持
- layer dump 工具
- 启动稳定性与显示同步修复
- “Use DE/GPU as compositor/default compositor”这类策略切换 patch

这说明它不是“原版 weston”，而是**深度 BSP 化的 weston 分支**。  
优点：适配硬件能力（尤其视频层/overlay）  
缺点：维护复杂度高，升级上游 weston 会很难。

另外：

- 默认配置里 `use-overlay=true`、`render-on-top=true`
- `weston` 启动脚本固定走 `drm-backend.so`
- `weston.ini` 放了多个重复 terminal launcher（像是演示/调试配置）

---

#### 4) `glmark2/`
特点：

- 支持可选 `fbdev` / `wayland` flavor
- 对特定 SoC 平台加了 `--img_gpu`
- patch 涉及 fbdev 适配、编译兼容修复、native-state 扩展

结论：主要用于验证 GPU/显示栈是否通畅，不是业务功能包。

---

### 依赖关系（简化）

- `weston` -> `wayland` + `wayland-protocols` + 输入/渲染相关库
- `glmark2` -> `wayland`（可选）+ GPU 库
- `wayland-protocols` -> `wayland`

---

### 我对这个包的判断

这是一个典型的 **“可量产 BSP 图形栈”** 目录：  
- 目标是“板子能稳定跑起来”，不是追新版本。  
- `weston` 改动很深，价值最大但技术债也最大。  
- 若你后续要升级 Wayland/Weston，最大阻力会在 `weston/patches` 这 19 个 patch 的重放和重构。

---

如果你愿意，我下一步可以直接给你做一版：
1. **patch 影响面清单**（按“功能增强/bugfix/平台适配”分类）  
2. **升级风险评估表**（低中高 + 原因）  
3. **最小可用裁剪建议**（比如只保留 DRM+GPU，去掉不必要模块）

---

**User**

@package/wayland/weston/patches 能否分析一下这些patches具体都做了什么适配吗？@lichee/linux-4.9/drivers/video/fbdev/sunxi 其中sunxi的显示驱动在这里

---

**Cursor**

Need need summarization and maybe read rest of sunxi header where layer config definitions. Read more lines beyond 320 likely includes disp_layer_config. Also maybe read dev_disp.c for ioctls DISP_LAYER_SET_CONFIG and HWC commit. and maybe sync_event_proc location. We'll read targeted files by Grep with simpler patterns maybe not regex huge to avoid failure. Use Grep for exact tokens.

可以，下面我按你要的两个点来讲：

1) `package/wayland/weston/patches` 每个 patch 在“适配什么”  
2) 这些改动和 `lichee/linux-4.9/drivers/video/fbdev/sunxi`（DE/显示驱动能力）的对应关系

---

## 一、weston 这 19 个 patch 逐个在做什么

我先按功能分组，再列到 patch 编号，便于你看全貌。

### A. 基础可编译/可运行修正

- `0001-os-compatibility-define-CLOCK_BOOTTIME...`
  - 给老 libc（如 uClibc）补 `CLOCK_BOOTTIME` 宏，解决编译兼容。

- `0010-weston-Fix-build-error.patch`
  - NV21 fb size 计算里用 `fb->height` 替代局部变量 `height`，纯修 bug。

- `0015-weston-Cancel-wayland-launch-error.patch`
  - `weston-launch.c` 里把 `error()` 相关调用注释掉，改成 `printf`，避免某些环境/库下 `error.h` 行为导致启动异常（属于“能跑起来优先”的处理）。

- `0008-weston-Downgrade-gdm-verstion-to-1.0.patch`
  - 实际是把 `gbm >= 10.2` 降到 `gbm >= 1.0` 检查，兼容 Mali 的旧 GBM DDK（注释里写了 Mali GBM 1.0）。

---

### B. NV21 / YUV 视频链路适配（非常关键）

- `0004-Add-NV21-video-format-surface-tests.patch`
  - 扩展 `simple-dmabuf-intel` 客户端测试：
    - 用 dumb buffer / dmabuf 流程构造 NV21 测试面。
    - 从 `renderD128` 改为 `card0`。
  - 目标：能喂出 NV21 surface 给 weston。

- `0005-Add-read-yuv-data-from-bin-in-simple-dmabuf-intel...`
  - 测试客户端直接读 `.yuv` 文件，灌进 buffer，方便验证视频层合成效果。

- `0006-Add-EGL_YUV-and-EGL_SAMPLE-attribs...`
  - 在 `eglCreateImage` 的 attrib 里补：
    - `EGL_YUV_COLOR_SPACE_HINT_EXT = REC601`
    - `EGL_SAMPLE_RANGE_HINT_EXT = NARROW`
  - 目标：兼容 Mali400 DDK 对 NV21 的采样/色彩空间需求。

- `0005-weston-Add-NV21-format-in-weston.patch`（编号上是 0005 名字）
  - `gl-renderer.c` 增加 `DRM_FORMAT_NV21` 描述，映射 Y/UV 平面格式（`R8` + `GR88`）。

- `0009-Add-DE-compose-video-layer.patch`
  - `drm_fb_get_from_bo` 增加 NV21 的第二 plane `offset/pitch` 处理；
  - overlay 选择策略从“先选 plane”改成“先 import BO 再按 format 选 plane”；
  - 放宽了 dmabuf 对 `n_planes/offset/flags` 的限制，适配视频面多平面。

---

### C. DE/overlay 硬件合成路径（核心适配）

- `0002-Add-DE-set-plane-zorder-feature.patch`
  - 在 DRM plane 上显式设置属性：
    - `"zpos"`
    - `"alpha_mode"`
    - `"alpha_value"`
  - 增加 `plane_zorder` 逻辑，把 weston 从上到下的 layer 顺序映射到硬件 zorder。

- `0003-Fix-display-sync-problem-and-improve-executing-efficiency.patch`
  - 把“每个 sprite 都单独 vblank”等待，改成“一帧统一 vblank 处理”；
  - 在同一个 vblank 回调里统一 release 所有 sprite fb，降低不同 plane 帧不同步概率。

- `0011-Use-DE-as-compositor.patch`
  - `b->sprites_are_broken = 0`，等价于“默认开启 overlay/sprite 硬件合成”。

- `0012-Refine-to-use-DE-to-compose.patch`
  - 对 0011 做细调，去掉一段多余判断，让 DE 路径更容易命中。

- `0013-Fix-weston-cannot-use-DE-to-compose.patch`
  - 适配 weston 2.0 接口签名变化：`drm_sprite_crtc_supported(output, s)`。

- `0014-Use-GPU-as-default-compositor.patch`
  - 与 0011 相反：`sprites_are_broken = 1`，默认退回 GPU 合成（可看作策略切换 patch）。

- `0017-Use-DE-as-default-compositor.patch`
  - 大 patch，核心是引入 `DRM_OVERLAY_SUPPORT` 相关完整 overlay manager：
    - 区分 video/UI channel
    - layer 分配、zorder、alpha/premultiply、channel 复用
    - 根据 buffer 类型/格式决定 GPU 还是 overlay 走向
  - 同时带了部分客户端/配置改动（比如 cairo operator、cairo egl define、并发出的结构性改动）。

---

### D. 其他功能扩展

- `0016-Increase-the-initial-window-position-setting-function.patch`
  - 给 `wl_shell_surface` 扩展了 `set_window_position`，并让 `desktop-shell` 支持按客户端指定初始位置。

- `0018-weston-support-ivi-shell.patch`
  - 强化 IVI shell 场景：
    - `ivi-shell/weston.ini.in` 改成目标机绝对路径
    - `use-overlay=true` 等配置
    - 程序路径和资源路径全改为部署路径
  - 也包含前面提到的大 patch 片段（它和 0017/0019 有连贯关系）。

- `0019-weston-support-layer-dump-tool.patch`
  - 新增 `weston-layer-dump` 工具（`clients/layer-dump.c`），通过 `/dev/mem` 映射物理地址导出 BMP，用于抓层内容调试。

---

## 二、这些 patch 对应 sunxi 显示驱动的哪些能力

你给的驱动目录核心在 `disp2/disp/de`，它的设计和 weston patch 很对齐。

### 1) 驱动天然有“channel/layer/alpha/zorder”抽象

在 `sunxi_display2.h` 里能看到 layer 配置结构：

- `disp_layer_info2`：
  - `zorder`
  - `alpha_mode`
  - `alpha_value`
  - `screen_win`
  - `fb.pre_multiply` 等
- `disp_layer_config2`：
  - `channel`
  - `layer_id`
- `disp_fb_info2`：
  - `fd`（dmabuf）
  - `format`
  - `color_space`
  - `crop`
  - `flags/scan/eotf/metadata`

这和 weston patches 在 plane 上处理 zpos/alpha、YUV、dmabuf 的方向是同一个模型。

---

### 2) 驱动明确区分 UI 通道和 Video 通道能力

`de_feat.c` 里有：

- `de_feat_get_num_vi_chns(disp)`（video channel 数）
- `de_feat_get_num_ui_chns(disp)`（ui channel 数）
- `de_feat_get_num_layers_by_chn(...)`（每通道 layer 数）

这就是 `0017` 里 overlay manager 做 “video layer 优先去 video channel、UI layer 去 UI channel、有限层数调度” 的硬件依据。  
也解释了补丁里提到的 “DE only support xx layer” 这类限制思路。

---

### 3) 驱动底层有 OVL + BLD（overlay + blender）模块

在 `de_ovl.h` / `de_bld.h`：

- `de_ovl_apply_lay()`：配置 overlay layer
- `de_bld_set_pipe_ctl()/set_blend_mode()`：配置混合管线
- 还有 premul 相关常量（`DE_OVL_PREMUL_*`）和 blend mode（`DE_BLD_MODE_SRCOVER` 等）

对应 weston patch 的关键点：

- zorder/alpha/premultiply 策略
- 视频层与 UI 层共存混合
- 需要时 fallback 到 GPU

---

### 4) 驱动有 HWC/同步栅栏机制，支持“提交-显示-释放”同步

`dev_composer.c` 里看到：

- `DISP_HWC_COMMIT`
- `HWC_NEW_CLIENT / HWC_ACQUIRE_FENCE / HWC_SUBMIT_FENCE`
- `sync_file_create` + fence timeline

这和 `0003` patch 的思路一致：  
weston 端做统一 vblank 释放，避免 plane 显示同步乱序；底层驱动本身也偏向“按提交帧”去管理同步。

---

### 5) 像素格式侧：驱动支持 YUV420 SP 的两种 UV 排列

在 `sunxi_display2.h` 的 `enum disp_pixel_format` 有：

- `DISP_FORMAT_YUV420_SP_UVUV`
- `DISP_FORMAT_YUV420_SP_VUVU`

其中 `VUVU` 本质上对应 NV21 的内存排列（VU 交错）。  
所以 weston patch 把 `DRM_FORMAT_NV21` 打通，正好能落到 sunxi 这类 YUV420 SP 能力上。

---

## 三、一句话总结“这套适配的本质”

这批 weston patch 不是简单修补，而是在做：

- **上层 weston 的 plane/overlay 决策逻辑**  
  ⟷  
- **sunxi DE 的 channel/layer/alpha/zorder/YUV/dmabuf 能力模型**

的“结构性对齐”。

也就是说，你现在这套更像是 **BSP 定制 compositor**，目标是让 DE 硬件承担更多合成（尤其视频层），减轻 GPU 压力并改善带宽/功耗/同步表现。

---

如果你愿意，我下一步可以继续给你做一版“更实用”的：

1. **按风险评级的 patch 清单**（升级 weston 时最先炸的是哪些）  
2. **和当前 `0017` 对应的关键代码路径图**（view -> layer -> channel -> plane -> vblank）  
3. **最小保留集建议**（如果你只要“稳定视频层 + 正常 UI”，哪些 patch 可以删）

