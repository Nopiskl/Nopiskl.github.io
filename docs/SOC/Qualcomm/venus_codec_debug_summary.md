# Qualcomm Venus 编解码调试总结

> 基于本次对话整理，重点归纳：**探索过程中发现的问题、验证路径、阶段性结论、最终结论与对应解决方法**。

---

## 1. 背景

本次探索围绕 Qualcomm `qcom-venus` 硬件编解码链路展开，主要关注两类问题：

1. **硬件解码失败**：官方给出的 GStreamer 解码命令无法播放指定 MP4。
2. **硬件编码异常**：一旦触发 `enc`，系统会直接重启。

涉及的关键组件包括：

- GStreamer：`v4l2h264dec` / `v4l2h264enc`
- FFmpeg：`h264_v4l2m2m`
- V4L2 M2M 设备节点：`/dev/video*`
- Qualcomm Venus 固件：`qcom/vpu-2.0/venus.mbn`
- BIOS / SCM / TrustZone / remoteproc 安全链

---

## 2. 探索出的核心问题与解决方法

### 问题 A：官方硬件解码命令无法使用

#### 现象

原始测试命令：

```bash
gst-launch-1.0 -e filesrc location="/home/radxa/Project/test_video_10s.mp4" \
  ! qtdemux ! queue ! h264parse ! v4l2h264dec ! autovideosink
```

无法正常播放，表现为 `qtdemux` 动态 pad 链接失败。

#### 探索结论

问题**不是驱动坏了**，而是输入视频本身与 Venus 硬件解码器能力不兼容。

`/home/radxa/Project/test_video_10s.mp4` 的关键参数：

- H.264 Profile：**High 4:4:4 Predictive**
- 像素格式：**yuv444p10le**
- 色深：**10-bit**

而 `v4l2h264dec` 支持范围大致是：

- Profile：`baseline / constrained-baseline / main / high`
- 输出格式：NV12
- 色深：8-bit
- 色度采样：4:2:0

也就是说：

- **不支持 High 4:4:4 Predictive**
- **不支持 10-bit**
- **不支持 4:4:4**

#### 解决方法

**方法 1：换兼容视频**

使用重新生成的兼容文件：

```bash
gst-launch-1.0 -e filesrc location="/home/radxa/Project/test_video_hw_compat.mp4" \
  ! qtdemux ! queue ! h264parse ! v4l2h264dec ! autovideosink
```

**方法 2：把原视频转码为兼容格式**

```bash
ffmpeg -i test_video_10s.mp4 \
  -c:v libx264 -profile:v high -level 3.1 -pix_fmt yuv420p \
  test_video_10s_compat.mp4
```

**方法 3：无法转码时回退软件解码**

```bash
gst-launch-1.0 -e filesrc location="test_video_10s.mp4" \
  ! qtdemux ! queue ! h264parse ! avdec_h264 ! autovideosink
```

#### 最终结论

这个问题的本质是：

> **样例 MP4 的编码规格超出了硬件解码器支持范围。**

不是 `v4l2h264dec` 驱动本身坏掉。

---

### 问题 B：一测试硬件编码，系统就重启

#### 现象

只要尝试实际硬件编码，系统就会直接重启，例如：

```bash
gst-launch-1.0 -e videotestsrc num-buffers=30 \
  ! video/x-raw,format=NV12,width=640,height=480,framerate=30/1 \
  ! v4l2h264enc ! fakesink
```

以及：

```bash
ffmpeg -f lavfi -i color=c=blue:size=640x480:rate=30 -t 3 \
  -c:v h264_v4l2m2m -pix_fmt nv12 /tmp/test_enc.mp4
```

都会触发重启。

#### 早期探索中发现的线索

排查过程中陆续看到这些现象：

- `qcom-apm ... CMD timeout`
- `gcc-sc7280 clock-controller: Timed out. Forcing sync_state()`
- Venus 固件日志不完整或没有明显成功日志
- 重启后 `video` 设备节点顺序不固定
- 使用 journald / systemd service 做持久化抓日志

#### 中间阶段曾得到的判断

在一度的排查里，曾怀疑：

1. 运行时电源管理唤醒有问题
2. 固件加载路径有问题
3. 设备节点顺序变化导致工具选错设备
4. GStreamer / FFmpeg 的 V4L2 M2M 调用路径触发了驱动 bug
5. 可能是内核驱动与固件不匹配

这些判断在**当时是基于现象的合理怀疑**，但都不是最后被验证的根因。

#### 关键验证

后续做了更细的最小化验证：

- 直接写 C 程序，用 V4L2 ioctl 测试：
  - `open`
  - `VIDIOC_QUERYCAP`
  - `VIDIOC_S_FMT`
  - `REQBUFS`
  - `STREAMON`
  - `QBUF`
- 这些步骤都可以成功，说明：

> **Venus 编码器硬件本体并非完全不可用。**

这一步非常关键，它推翻了“编码硬件本身一定坏掉”的强结论。

---

### 问题 C：更新 BIOS 设置后，编解码设备节点直接消失

#### 现象

更新 BIOS 后，`/dev/video*` 中的 Venus 设备节点消失，日志里出现：

```text
qcom-venus aa00000.video-codec: error -22 initializing firmware qcom/vpu-2.0/venus.mbn
qcom-venus aa00000.video-codec: fail to load video firmware
qcom-venus aa00000.video-codec: probe with driver qcom-venus failed with error -22
```

进一步排查还出现：

```text
qcom_scm firmware:scm: scm storage not available: -22
```

以及：

```text
qcom_q6v5_pas ... remoteproc: reset broken and remoteproc not running during boot, exiting
```

#### 探索结论

这说明 BIOS 改动破坏了 Qualcomm 安全链路，导致：

- SCM 存储不可用
- TrustZone / 安全校验链异常
- Venus 固件无法通过安全校验加载
- remoteproc 子系统异常
- 最终 `qcom-venus` probe 失败，设备节点不出现

#### 解决方法

恢复 BIOS 中与安全链相关的设置，重点关注：

- fTPM / TPM
- Secure Boot
- UEFI 安全变量存储
- Measured Boot / Verified Boot
- 必要时恢复默认 BIOS 设置

#### 最终结果

在 BIOS 设置恢复后：

- Venus 设备节点重新出现
- 编码器节点恢复
- 解码器节点恢复

---

### 问题 D：最终 `enc` 是否真的可用？

#### 最终验证结果

在 BIOS 修正之后，最终验证显示：

1. `/dev/video*` 中 Venus 编码器、解码器节点恢复
2. FFmpeg 硬件编码成功
3. GStreamer 硬件编码成功
4. 硬件解码 + 硬件编码整条链路成功

也就是说：

> **最终结果表明，硬件编码能力是可用的。**

这很重要，因为它说明：

- 前面一度怀疑的“编码驱动必然有 bug”并不是最终结论
- 至少在 BIOS/安全链恢复后，当前系统已经可以正常完成硬件编码

---

## 3. 重要的最终结论

### 结论 1：解码报错的根因，不是驱动坏了，而是样例视频不兼容

- `test_video_10s.mp4`：High 4:4:4 Predictive + 10-bit + 4:4:4
- `test_video_hw_compat.mp4`：High + yuv420p + 8-bit

Venus 硬件解码器只能稳定处理主流的 8-bit 4:2:0 H.264 规格。

---

### 结论 2：前期“编码一测就重启”的问题，不能简单定性为驱动必现 bug

虽然中途曾怀疑驱动/固件匹配问题，但后续事实是：

- BIOS 相关设置改坏时，Venus 固件无法通过 SCM 安全链加载
- BIOS 恢复后，硬件编码恢复正常

因此更接近真实情况的总结应当是：

> **编码异常与平台初始化环境、BIOS 安全配置、固件安全加载链路高度相关，而不是单纯“编码驱动天生不可用”。**

---

### 结论 3：设备节点编号不固定，不能写死 `/dev/video0` / `/dev/video1`

探索过程中多次出现：

- 某次 `/dev/video0` 是编码器
- 某次 `/dev/video0` 变成 USB 摄像头
- 某次 `/dev/video2` / `/dev/video3` 才是 Venus 编解码器

因此：

> **不能依赖固定编号判断编解码设备。**

更稳妥的做法是：

- 用 `v4l2-ctl --list-devices` 识别
- 或用 udev 规则给 Venus 编码器 / 解码器创建固定别名

---

## 4. 这次探索里真正沉淀下来的方法论

### 方法 1：先区分“输入不兼容”还是“驱动故障”

解码失败时，先查：

- profile
- pixel format
- bit depth
- chroma subsampling

不要一上来就怀疑驱动。

---

### 方法 2：出现重启时，优先做“日志持久化”

因为系统重启会断开会话，所以要优先考虑：

- journald 持久化
- `journalctl -b -1` 查看上次启动日志
- systemd service 包装测试任务

否则很多问题根本抓不到现场。

---

### 方法 3：一定要做最小化验证

本次最关键的一步不是工具链测试，而是：

- 用最小 C 程序直接走 V4L2 ioctl

这一步帮助区分了：

- 是底层硬件/驱动完全坏了
- 还是更上层的工具链/环境/初始化路径出了问题

---

### 方法 4：Qualcomm 多媒体问题要把 BIOS / SCM / remoteproc 一起看

这次后期已经证明：

- BIOS 配置会影响 SCM 安全存储
- SCM 问题会连带影响 Venus 固件加载
- 还会波及 remoteproc

因此 Qualcomm 平台上的多媒体问题，不能只盯着 `qcom-venus` 驱动本身。

---

## 5. 推荐保留的可复用命令

### 5.1 检查当前 V4L2 设备

```bash
v4l2-ctl --list-devices
```

### 5.2 验证硬件解码（兼容视频）

```bash
gst-launch-1.0 -e filesrc location="/home/radxa/Project/test_video_hw_compat.mp4" \
  ! qtdemux ! queue ! h264parse ! v4l2h264dec ! autovideosink
```

### 5.3 原始视频转兼容格式

```bash
ffmpeg -i test_video_10s.mp4 \
  -c:v libx264 -profile:v high -level 3.1 -pix_fmt yuv420p \
  test_video_10s_compat.mp4
```

### 5.4 软件解码回退

```bash
gst-launch-1.0 -e filesrc location="test_video_10s.mp4" \
  ! qtdemux ! queue ! h264parse ! avdec_h264 ! autovideosink
```

### 5.5 查看上一次启动的日志

```bash
journalctl -b -1
```

---

## 6. 最后给出的简明版总结

这次对话最终探索出的结论可以浓缩为下面几条：

1. **解码失败的根因**：测试 MP4 的编码格式不兼容 Venus 硬解能力，不是驱动先天损坏。
2. **编码重启问题的排查过程**：中途曾怀疑电源管理、固件、设备节点、驱动 bug，但这些大多属于阶段性怀疑。
3. **真正被后续验证的重要因素**：BIOS / SCM / TrustZone / remoteproc 安全链状态会直接影响 Venus 固件加载和编码能力。
4. **最终结果**：在 BIOS 设置恢复正常后，Venus 编码器、解码器都恢复可用，FFmpeg 与 GStreamer 的硬件编码也可正常工作。
5. **工程经验**：以后遇到类似问题，优先检查
   - 输入视频格式是否兼容
   - `/dev/video*` 设备是否真的对应 Venus
   - BIOS/SCM/remoteproc 是否异常
   - 是否能用最小 V4L2 程序复现

---

## 7. 一句话结论

> 这次并不是单一“驱动坏了”的问题，而是**视频格式兼容性问题 + 平台安全链/BIOS 配置问题 + 调试路径逐步收敛**共同构成的一次完整排障过程；最终在 BIOS 恢复后，Venus 硬件编解码链路可以正常工作。
