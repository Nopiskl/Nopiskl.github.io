# 全志 VIN 中 sensor 驱动功能实现情况与主线差异分析

## 1. 结论概述

全志 VIN 框架中的 sensor 驱动，尤其是 `drivers/vin/modules/sensor/*.c` 这类驱动，本质上是服务于 VIN 私有采集流程的 sensor 适配层。它已经实现了让 VIN video node 能够拉起 sensor、选择 mode、写寄存器并完成基本采集所需的功能，但还没有完整实现主线 V4L2 Media Controller / libcamera 期望的标准 sensor subdev 能力描述和控制面。

可以概括为：

```text
VIN sensor 驱动已经实现：
  能被 VIN 调起来采集的最小闭环

主线 sensor 驱动还要求：
  能被标准 MC/subdev/libcamera 独立枚举、配置、建模和控制
```

因此，VIN 中的 sensor 驱动并不是完全缺失，而是更偏 BSP 内部模型；它和主线 sensor 驱动的差距主要体现在标准 controls、timing model、selection/crop 建模、runtime PM、fwnode endpoint、async subdev 绑定以及 TRY/ACTIVE 语义等方面。

---

## 2. VIN 中的 sensor 驱动主要实现了什么

以 `gc2053_mipi.c` 这类 sensor 为例，VIN 中的 sensor 驱动主要实现以下功能。

### 2.1 I2C 寄存器读写

sensor 驱动实现了基本的寄存器读写接口，用于：

- 读取 sensor chip ID。
- 写入初始化寄存器表。
- 写入不同分辨率 / 帧率对应的 mode 寄存器表。
- 设置曝光、增益等少量 sensor 控制寄存器。

这部分是 sensor 驱动最核心的底层能力。

---

### 2.2 上电、复位、初始化

VIN sensor 一般实现以下回调：

```c
.reset = sensor_reset,
.init = sensor_init,
.s_power = sensor_power,
```

这些函数负责完成：

- 电源上电 / 下电。
- reset / pwdn GPIO 控制。
- sensor 初始化。
- standby / wakeup 状态切换。

不过这里的电源模型更偏传统 BSP 风格，通常由 VIN 主流程主动调用，而不是完全主线化的 runtime PM 模型。

---

### 2.3 离散 mode 表

VIN sensor 通常使用 register-list 模型，也就是预先定义若干离散输出模式。例如：

```text
1920x1080 @ 20fps
1928x1088 @ 30fps
...
```

每个 mode 通常包含：

```text
width
height
hts
vts
pclk
mipi_bps
fps_fixed
regs
regs_size
vipp_w / vipp_h / vipp_hoff / vipp_voff
```

这说明 VIN sensor 并不是按用户任意请求动态组合所有时序，而是在预定义 mode 表中选择一个最接近的配置。

---

### 2.4 mbus code 和 frame size 枚举

VIN sensor 通常实现：

```c
.enum_mbus_code = sensor_enum_mbus_code,
.enum_frame_size = sensor_enum_frame_size,
```

用于告诉 VIN：

- sensor 能输出什么 media bus 格式。
- sensor 支持哪些分辨率。

例如 raw Bayer sensor 可能输出：

```text
MEDIA_BUS_FMT_SRGGB10_1X10
MEDIA_BUS_FMT_SBGGR10_1X10
...
```

这部分和主线 sensor 驱动比较接近，但通常枚举能力较简单。

---

### 2.5 get_fmt / set_fmt

VIN sensor 通常实现：

```c
.get_fmt = sensor_get_fmt,
.set_fmt = sensor_set_fmt,
```

`set_fmt` 的实际作用主要是：

1. 根据用户 / VIN 请求的 width、height、mbus code，选择一个合适的 `sensor_win_size`。
2. 设置当前 `info->current_wins`。
3. 设置当前 `info->fmt`。
4. 后续 `s_stream` 时按这个 mode 写寄存器表。

也就是说，VIN sensor 的 `set_fmt` 本质上是 mode 选择入口。

典型逻辑可以概括为：

```text
set_fmt
  -> sensor_try_format
  -> 选择 sensor_win_size
  -> 选择 sensor_format_struct
  -> ACTIVE 状态下保存 current_wins / fmt
```

---

### 2.6 MIPI bus config

VIN sensor 通常会实现：

```c
.get_mbus_config = sensor_g_mbus_config,
```

用于告诉 VIN sensor 的 MIPI CSI-2 输出配置，例如：

```text
bus type: V4L2_MBUS_CSI2_DPHY
lane 数: 2 lane
virtual channel: channel 0
```

不过这部分通常是固定返回值，不是完整的主线 link frequency / lane rate / endpoint model。

---

### 2.7 s_stream

VIN sensor 实现：

```c
.s_stream = sensor_s_stream,
```

在 VIN 执行 `VIDIOC_STREAMON` 后，VIN pipeline 会调用 sensor 的 `s_stream(1)`。

sensor 的 `s_stream(1)` 通常会：

1. 写 sensor 默认寄存器表。
2. 写当前 format 对应的寄存器表。
3. 写当前 window / mode 对应的寄存器表。
4. 设置当前 width / height。
5. 启动 sensor 输出。

在 VIN BSP 中，很多 sensor 的 stream on 才真正写入 mode 寄存器，因此 sensor 在 `set_fmt` 阶段只是选择 mode，实际硬件配置发生在 `s_stream` 阶段。

---

### 2.8 基本 controls

VIN sensor 通常只实现少量 sensor 控制，例如：

```text
V4L2_CID_GAIN
V4L2_CID_EXPOSURE
```

这些 controls 主要满足基本 AE 调节需求。

不过 controls 数量较少，很多主线 raw sensor 必需或常见的 controls 并没有完整实现。

---

### 2.9 私有 ioctl

VIN sensor 通常还实现一些 VIN 私有 ioctl，例如：

```text
GET_CURRENT_WIN_CFG
```

VIN video node 在 `S_FMT` 后会通过这个私有 ioctl 获取 sensor 当前 mode 的窗口信息，再用它去配置 CSI parser crop、VIPP/scaler crop 等 SoC 侧模块。

这说明在 VIN BSP 中，sensor 和 VIN 之间不仅通过标准 subdev pad format 交互，还依赖私有结构体传递 mode/window 信息。

---

## 3. VIN 中的 sensor 相对主线缺了什么

VIN sensor 已经能被 BSP VIN 拉起来采集，但如果和主线 sensor 驱动相比，还缺少不少标准化能力。

---

### 3.1 缺标准 timing controls

主线 raw sensor 通常需要暴露：

```text
V4L2_CID_PIXEL_RATE
V4L2_CID_LINK_FREQ
V4L2_CID_HBLANK
V4L2_CID_VBLANK
```

这些 controls 用于描述 sensor 的真实时序模型。

主线中，raw sensor 的帧间隔通常由以下关系推导：

```text
frame interval =
  (active width + horizontal blanking) *
  (active height + vertical blanking) /
  pixel rate
```

而 VIN sensor 通常只在私有 mode 表里保存：

```text
hts
vts
pclk
mipi_bps
fps_fixed
```

这些信息没有完整转化为标准 V4L2 controls。

影响是：

- libcamera 难以通过标准接口推导帧率。
- CSI receiver 难以通过标准接口获取 link frequency。
- 用户态无法标准化调整 vblank / exposure range / frame duration。
- sensor timing 仍然被 VIN 私有结构体隐藏。

---

### 3.2 缺完整 link frequency / pixel rate 暴露

VIN sensor 的 mode 表里通常已经有类似信息：

```text
pclk
mipi_bps
```

但主线更希望通过：

```text
V4L2_CID_PIXEL_RATE
V4L2_CID_LINK_FREQ
```

暴露给 bridge / CSI receiver / 用户态。

缺失这些 controls 后，VIN 或 libcamera 不能按标准方式得知：

- sensor 输出像素率。
- MIPI CSI-2 lane 速率。
- 当前 mode 对应的 link frequency menu。
- 不同 mode 下的时序变化。

---

### 3.3 缺完整 frame interval 模型

部分 VIN sensor helper 里可能有 frame interval 枚举函数，但具体 sensor 未必挂接：

```c
.enum_frame_interval = ...
```

如果 sensor 没有挂接这个 pad op，那么 video node 调用 `VIDIOC_ENUM_FRAMEINTERVALS` 时可能失败。

主线 raw sensor 不一定必须依赖 `enum_frame_interval`，但至少应该通过 pixel rate、hblank、vblank 等 controls 建立标准 timing 模型。

VIN sensor 的问题是：

```text
fps 信息存在于私有 mode 表中，
但没有完整暴露为标准 frame interval 或 timing controls。
```

---

### 3.4 缺 get_selection / crop bounds / native size 建模

主线 sensor subdev 通常需要用 selection API 表达 sensor 自身的像素阵列和裁剪关系，例如：

```text
V4L2_SEL_TGT_NATIVE_SIZE
V4L2_SEL_TGT_CROP_BOUNDS
V4L2_SEL_TGT_CROP_DEFAULT
V4L2_SEL_TGT_CROP
```

这些信息用于描述：

- sensor 原始像素阵列大小。
- 有效像素区域。
- 当前 analogue crop。
- 当前输出窗口。
- binning / skipping / scaling 前后的关系。

VIN sensor 通常没有完整实现这些 selection target，而是把类似信息放在 `sensor_win_size` 里，例如：

```text
width
height
hoffset
voffset
vipp_w
vipp_h
vipp_hoff
vipp_voff
```

然后通过私有 ioctl 交给 VIN 配 CSI/VIPP crop。

这对 BSP 是可用的，但不符合主线 MC/libcamera 对 sensor crop/native size 的建模方式。

---

### 3.5 缺 test pattern control

主线 sensor 常见会实现：

```text
V4L2_CID_TEST_PATTERN
```

用于让用户态或调试工具开启 sensor 内部测试图。

VIN sensor 通常没有标准实现这个 control。

影响是：

- 无法用标准方式验证 sensor -> CSI -> ISP 链路。
- libcamera pipeline handler 难以提供统一 test pattern 功能。
- 调试时更依赖私有寄存器写法或驱动修改。

---

### 3.6 缺 hflip / vflip / orientation 标准 controls

主线 sensor 常见会实现：

```text
V4L2_CID_HFLIP
V4L2_CID_VFLIP
V4L2_CID_CAMERA_SENSOR_ROTATION
V4L2_CID_CAMERA_SENSOR_ORIENTATION
```

VIN BSP 中，hflip/vflip 往往来自 board/module 配置，由 VIN video node 在 `S_INPUT` 时读取并保存，而不是作为 sensor subdev 的标准 controls 暴露。

影响是：

- 用户态无法通过标准 V4L2 control 查询或设置 sensor flip。
- libcamera 难以自动处理 camera orientation。
- 同一个 sensor driver 跨平台复用能力较差。

---

### 3.7 缺主线 runtime PM 电源模型

VIN sensor 通常有传统接口：

```c
.s_power = sensor_power,
.reset = sensor_reset,
.init = sensor_init,
```

但主线更希望 sensor driver 自己实现：

```text
runtime PM
regulator bulk enable/disable
clk prepare/enable
GPIO reset/pwdn
pm_runtime_get_sync / pm_runtime_put
```

并且 stream 生命周期和 runtime PM 状态保持一致。

VIN BSP 的问题是：

```text
电源管理主要受 VIN 主流程驱动，
sensor 自身不是完整独立的 runtime PM 设备模型。
```

影响是：

- 主线桥接驱动难以统一管理 pipeline power。
- 多 camera / suspend-resume / runtime suspend 场景更难标准化。
- sensor driver 跨 SoC 复用性较差。

---

### 3.8 缺标准 fwnode endpoint / async subdev 绑定模型

主线 camera pipeline 通常通过 DT graph 描述：

```text
sensor endpoint -> csi endpoint
```

bridge driver 通过 async notifier 绑定 sensor subdev。

VIN BSP 中，sensor 与 VIN 的绑定更多依赖私有 board 配置，例如：

```text
sensor*_mname
sensor_list
rear_sensor_sel / front_sensor_sel
vinc*_mipi_sel
vinc*_csi_sel
vinc*_isp_sel
```

这意味着 sensor 并不是完全通过标准 endpoint graph 被 bridge 自动发现和绑定。

影响是：

- media graph 不是唯一真实拓扑来源。
- 用户态通过 MEDIA_IOC_SETUP_LINK 修改 link，不一定能改变硬件路由。
- sensor driver 不够主线通用。

---

### 3.9 缺完整用户态 subdev 控制语义

VIN sensor 虽然注册成 v4l2 subdev，也有 pad ops，但实际控制路径通常是：

```text
/dev/videoX
  -> VIDIOC_S_INPUT
  -> VIDIOC_S_FMT
  -> VIN 内部遍历 pipeline
  -> 调 sensor/mipi/csi/isp/scaler set_fmt
  -> VIDIOC_STREAMON
```

而主线 MC-centric 模型更希望：

```text
/dev/mediaX
  -> 配 link

/dev/v4l-subdevX
  -> 配 sensor pad format
  -> 配 CSI/ISP/scaler pad format
  -> 配 selection/controls

/dev/videoX
  -> 只负责最终 capture format 和 buffer queue
```

因此，VIN sensor 的 subdev 接口虽然存在，但并不是完整的、用户态可独立控制的主线语义。

---

### 3.10 缺 TRY / ACTIVE 状态严格分离

主线 subdev API 中：

```text
TRY format:
  只影响当前 file handle 的 try state，不改变硬件 active state

ACTIVE format:
  改变当前 pipeline 的真实 active state
```

VIN BSP 中，video node 的 `TRY_FMT` 路径可能调用到 active format 设置逻辑，导致 TRY 操作也可能改变内部状态。

这会破坏 libcamera / media-ctl 这类用户态对 TRY 语义的假设。

---

### 3.11 缺标准化替代私有 GET_CURRENT_WIN_CFG 的接口

VIN sensor 会通过私有 ioctl 向 VIN 提供当前窗口配置，例如：

```text
GET_CURRENT_WIN_CFG
```

其中包含：

```text
sensor output width / height
sensor crop offset
vipp crop width / height
vipp crop offset
hts / vts / pclk / mipi_bps
```

主线更希望这些信息拆到标准接口：

```text
pad format
selection API
V4L2_CID_PIXEL_RATE
V4L2_CID_LINK_FREQ
V4L2_CID_HBLANK
V4L2_CID_VBLANK
```

因此，`GET_CURRENT_WIN_CFG` 这类私有 ioctl 是 BSP 可用但主线不友好的关键差异点。

---

## 4. 已实现与未实现功能对照表

| 分类 | VIN sensor 已实现 | 主线还需要补齐 |
| --- | --- | --- |
| 寄存器访问 | I2C 读写、寄存器表写入 | 基本一致 |
| 上电复位 | `s_power/reset/init` | runtime PM、regulator、clk、GPIO 标准模型 |
| mode 管理 | 离散 mode 表、`current_wins` | mode 与 controls / selection / timing 标准绑定 |
| 格式枚举 | `enum_mbus_code`、`enum_frame_size` | 更完整的 mbus code / size / crop 关系 |
| 格式设置 | `get_fmt/set_fmt` | TRY/ACTIVE 严格分离 |
| MIPI 配置 | 固定 lane / channel / DPHY | endpoint graph、link_freq、lane rate 标准表达 |
| streaming | `s_stream` 写寄存器表 | runtime PM 协同、stream state 标准化 |
| controls | gain、exposure | pixel_rate、link_freq、hblank、vblank、test_pattern、flip、orientation |
| frame interval | mode 表中有 fps 信息 | `enum_frame_interval` 或标准 timing controls |
| crop/selection | 私有 `sensor_win_size` | `get_selection/set_selection`、native size、crop bounds |
| sensor 与 VIN 交互 | 私有 ioctl，如 `GET_CURRENT_WIN_CFG` | 标准 pad format + selection + controls |
| 拓扑绑定 | VIN 私有 board 配置 | fwnode endpoint + async subdev |
| 用户态控制 | 主要由 `/dev/videoX` 间接驱动 | 可由 `/dev/v4l-subdevX` 独立配置 |
| libcamera 友好度 | 较低 | 需要完整 MC/subdev 语义 |

---

## 5. 主线化时 sensor 驱动应该补哪些内容

如果要把 VIN 中的 sensor 驱动改造成更接近主线的 sensor subdev，建议按以下顺序补齐。

### 5.1 第一阶段：补标准 controls

优先补：

```text
V4L2_CID_PIXEL_RATE
V4L2_CID_LINK_FREQ
V4L2_CID_HBLANK
V4L2_CID_VBLANK
V4L2_CID_EXPOSURE
V4L2_CID_ANALOGUE_GAIN
```

其中：

- `pixel_rate` 根据 mode 固定或可变。
- `link_freq` 用 menu control 表达不同 mode 的 MIPI 频率。
- `hblank` 通常由 `hts - width` 得出。
- `vblank` 通常由 `vts - height` 得出。
- exposure range 要随 vblank/vts 更新。

---

### 5.2 第二阶段：补 selection / crop 模型

把 `sensor_win_size` 中的：

```text
width
height
hoffset
voffset
```

转换为标准 selection 语义：

```text
NATIVE_SIZE
CROP_BOUNDS
CROP_DEFAULT
CROP
```

如果有 binning/skipping，还要明确：

```text
pixel array
analogue crop
binning/skipping
output size
```

---

### 5.3 第三阶段：去私有窗口 ioctl

逐步减少对：

```text
GET_CURRENT_WIN_CFG
```

的依赖。

把其中的信息拆到：

```text
get_fmt
get_selection
pixel_rate/link_freq/hblank/vblank controls
```

这样 VIN/CSI/VIPP 就可以通过标准接口拿到需要的信息。

---

### 5.4 第四阶段：补 runtime PM

将传统：

```text
sensor_power
sensor_reset
sensor_init
```

逐步改造成：

```text
runtime_resume:
  enable regulators
  enable xclk
  deassert reset/pwdn

runtime_suspend:
  assert reset/pwdn
  disable xclk
  disable regulators
```

stream on/off 使用：

```text
pm_runtime_resume_and_get()
pm_runtime_put()
```

---

### 5.5 第五阶段：补 endpoint graph 和 async subdev 注册

sensor driver 应从 fwnode endpoint 解析：

```text
bus type
data lanes
link frequencies
clock noncontinuous
remote endpoint
```

并通过标准 subdev sensor 注册流程接入 bridge。

VIN/bridge driver 则通过 async notifier 绑定 sensor。

---

### 5.6 第六阶段：补调试和方向类 controls

根据 sensor 能力补：

```text
V4L2_CID_TEST_PATTERN
V4L2_CID_HFLIP
V4L2_CID_VFLIP
V4L2_CID_CAMERA_SENSOR_ROTATION
V4L2_CID_CAMERA_SENSOR_ORIENTATION
```

这些对 libcamera、调试和产品化都很重要。

---

## 6. 对 VIN sensor 的最终判断

VIN 中的 sensor 驱动已经完成了 BSP 采集路径需要的核心功能：

```text
上电
复位
初始化
选择 mode
写寄存器表
输出 mbus 格式
启动 stream
提供窗口信息
设置 gain/exposure
```

但它没有完整实现主线 sensor subdev 需要的能力：

```text
标准 timing controls
标准 crop/native size/selection 模型
标准 link frequency / pixel rate 暴露
标准 runtime PM
标准 fwnode endpoint / async 绑定
标准 test pattern / flip / orientation controls
严格 TRY/ACTIVE 语义
去私有 ioctl 的 sensor-VIN 交互
```

所以，VIN sensor 的定位应理解为：

```text
当前 VIN sensor：
  BSP 私有 VIN pipeline 的 sensor 寄存器适配层

主线 sensor：
  可被任意 bridge/CSI/ISP 通过标准 MC/subdev API 使用的独立 sensor entity
```

如果目标只是让 `/dev/videoX` 能采集，当前 VIN sensor 已经足够；如果目标是进入主线、支持 libcamera 或被 media-ctl 标准控制，则还需要补齐上述主线化能力。
