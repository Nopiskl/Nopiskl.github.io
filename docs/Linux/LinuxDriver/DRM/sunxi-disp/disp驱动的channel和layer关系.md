# 全志disp驱动的channel和layer关系分析
_Exported on 2026/3/18 at GMT+8 17:37:23 from Cursor (2.3.34)_

---

**User**

@bsp/drivers/video/sunxi 帮我分析一下全志disp驱动的channel/layer的关系

---

**Cursor**

我来分析一下全志 disp 驱动中 channel/layer 的关系，先看看目录结构。

现在我已经收集了足够的信息，来给你详细分析全志 disp 驱动中 channel/layer 的关系。

---

## 全志 disp 驱动 Channel / Layer 关系分析

### 一、整体层级结构

全志 disp 驱动（DE2，Display Engine 2.x）采用了四级层级结构：

```
DE (Display Engine)
└── Screen / Manager (disp)          — 一个 DE 对应一路显示屏
    └── Channel (chn)                — 一个 Screen 下有多个通道
        └── Layer (layer_id)         — 一个 Channel 下有多个图层
```

用 `disp_get_layer(u32 disp, u32 chn, u32 layer_id)` 三元组来唯一定位一个 layer，正对应这三级索引。

---

### 二、Channel 的两种类型

Channel 分为两类，在 `de_feat.h` 中定义：

```
CHN_NUM         = 总 channel 数
VI_CHN_NUM      = 视频 channel 数（Video Input Channel）
UI_CHN_NUM      = CHN_NUM - VI_CHN_NUM（UI Channel）
```

| Channel 类型 | 说明 | 典型特性 |
|---|---|---|
| **VI Channel**（视频通道）| 编号靠前，如 CH0 | 支持 VEP（视频增强处理）、YUV 格式、缩放（scaler）、支持多 layer 叠加 |
| **UI Channel**（UI 通道）| 编号靠后 | 主要处理 ARGB/RGB 格式的 UI 图层，支持基本 alpha blend |

从 `de_feat.c` 的 `is_support_vep[]` 数组可以看到，**只有 VI Channel（CH0）才支持 VEP（视频增强处理）**，例如：

```c
static const int sun50iw2_de_is_support_vep[] = {
    /* DISP0 CH0 */ 1,   // VI channel，支持 VEP
    /* DISP0 CH1 */ 0,   // UI channel
    /* DISP0 CH2 */ 0,
    /* DISP0 CH3 */ 0,
    ...
};
```

---

### 三、具体平台数量举例

以代码中常见平台为例：

| 平台 | DE 数 | DISP0 CHN | DISP0 VI_CHN | 每 CHN Layer 数 | 总 Layer 数(DISP0) |
|---|---|---|---|---|---|
| sun50iw2 | 2 | 4 | 1 | 4 | 16 |
| sun8iw20/sun20iw1 | 2 | 2 | 1 | 4 | 8 |
| sun50iw10 | 2 | 4 | 2 | 4 | 16 |
| sun50iw8 | 1 | 2 | 0（纯UI）| 4 | 8 |
| sun8iw15 | 1 | 4 | 1 | 4 | 16 |

---

### 四、Layer 的编址方式

Layer 通过三元组 `(disp, chn, layer_id)` 寻址，在内核中用 `struct disp_layer_id` 描述：

```c
// disp_private.h
struct disp_layer_id {
    unsigned int disp;       // 显示屏索引
    unsigned int channel;    // 通道索引
    unsigned int layer_id;   // 通道内图层索引
    unsigned int type;       // 1:layer, 2:trd(3D), 4:atw
};
```

用户空间配置 layer 时，`disp_layer_config` 和 `disp_layer_config2` 也使用同样的 `channel` + `layer_id` 字段，最终通过 `__disp_config_transfer2inner()` 转换到内部格式。

---

### 五、Channel/Layer 的 Blend（混合）关系

从 `de_rtmx.h` 中的 `de_rtmx_set_route()`、`de_rtmx_set_pipe_cfg()` 可以看出底层 Blend 机制：

```
每个 Channel → 先把本通道内的多个 Layer 做 Overlay（叠加）→ 输出一路 pipe
多个 Channel 的 pipe → 再经过 Blender（混合器）→ 最终合成画面
```

关键数据结构 `__bld_ch_para_t`（blend channel 参数）有字段 `route`（路由/z-order），控制不同 channel 的前后叠加顺序。

---

### 六、Layer 配置关键参数

在 `__lay_para_t` 结构体中，一个 Layer 包含：

| 字段 | 含义 |
|---|---|
| `en` | 是否使能 |
| `fmt` | 像素格式（RGB/YUV 等）|
| `alpha_mode` / `alpha` | Alpha 混合模式和值 |
| `laddr_t[]` / `haddr_t[]` | 帧缓冲地址（低32位/高8位，支持大内存）|
| `pitch[]` | 每行字节数（3个 plane）|
| `layer` | 源图像在 channel overlay 中的位置/大小 |
| `lbc_en` / `lbc_info` | LBC（Lossless Buffer Compression）使能 |
| `fcolor_en` | 纯色填充使能 |

---

### 七、总结关系图

```
disp (Screen/Manager)
│
├── VI Channel 0   (支持 YUV、VEP、缩放、3D)
│   ├── Layer 0   (最底层，z-order 最低)
│   ├── Layer 1
│   ├── Layer 2
│   └── Layer 3
│
├── UI Channel 1   (支持 RGB/ARGB、alpha blend)
│   ├── Layer 0
│   ├── Layer 1
│   ├── Layer 2
│   └── Layer 3
│
├── UI Channel 2
│   └── ...
│
└── UI Channel 3
    └── ...
         │
         ▼
    Blender（混合器，de_rtmx）
         │
         ▼
    TCON（Timing Controller）→ 屏幕/HDMI/TV 输出
```

**核心规律：**
- 同一 Channel 内的多个 Layer 做**Overlay 叠加**（硬件按 z-order 合并为一路）
- 不同 Channel 的输出再经过**Blender 混合**输出最终画面
- VI Channel 专门处理视频流（YUV、缩放、视频增强），UI Channel 处理界面图层（ARGB）
- 每个 Channel 最多 4 个 Layer，`LAYER_MAX_NUM_PER_CHN = 4`

```plaintext
DE (Display Engine)
└── Screen / Manager (disp)          — 一个 DE 对应一路显示屏
    └── Channel (chn)                — 一个 Screen 下有多个通道
        └── Layer (layer_id)         — 一个 Channel 下有多个图层
```

```plaintext
CHN_NUM         = 总 channel 数
VI_CHN_NUM      = 视频 channel 数（Video Input Channel）
UI_CHN_NUM      = CHN_NUM - VI_CHN_NUM（UI Channel）
```

```c
static const int sun50iw2_de_is_support_vep[] = {
    /* DISP0 CH0 */ 1,   // VI channel，支持 VEP
    /* DISP0 CH1 */ 0,   // UI channel
    /* DISP0 CH2 */ 0,
    /* DISP0 CH3 */ 0,
    ...
};
```

```c
// disp_private.h
struct disp_layer_id {
    unsigned int disp;       // 显示屏索引
    unsigned int channel;    // 通道索引
    unsigned int layer_id;   // 通道内图层索引
    unsigned int type;       // 1:layer, 2:trd(3D), 4:atw
};
```

```plaintext
每个 Channel → 先把本通道内的多个 Layer 做 Overlay（叠加）→ 输出一路 pipe
多个 Channel 的 pipe → 再经过 Blender（混合器）→ 最终合成画面
```

```plaintext
disp (Screen/Manager)
│
├── VI Channel 0   (支持 YUV、VEP、缩放、3D)
│   ├── Layer 0   (最底层，z-order 最低)
│   ├── Layer 1
│   ├── Layer 2
│   └── Layer 3
│
├── UI Channel 1   (支持 RGB/ARGB、alpha blend)
│   ├── Layer 0
│   ├── Layer 1
│   ├── Layer 2
│   └── Layer 3
│
├── UI Channel 2
│   └── ...
│
└── UI Channel 3
    └── ...
         │
         ▼
    Blender（混合器，de_rtmx）
         │
         ▼
    TCON（Timing Controller）→ 屏幕/HDMI/TV 输出
```
