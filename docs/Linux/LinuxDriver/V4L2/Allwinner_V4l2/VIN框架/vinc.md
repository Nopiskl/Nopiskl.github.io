
## `vinc00` 节点各字段详解

```270:281:device/config/chips/v853/configs/100ask/board.dts
vinc00:vinc@0 {
    vinc0_csi_sel       = <0>;
    vinc0_mipi_sel      = <0>;
    vinc0_isp_sel       = <0>;
    vinc0_isp_tx_ch     = <0>;
    vinc0_tdm_rx_sel    = <0>;
    vinc0_rear_sensor_sel  = <0>;
    vinc0_front_sensor_sel = <0>;
    vinc0_sensor_list   = <0>;
    work_mode = <0x1>;
    status = "okay";
};
```

驱动用 `pdev->id`（即节点序号，这里是 `0`）动态拼接属性名读取，例如 `"vinc0_csi_sel"`：

```2277:2299:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c
sprintf(property_name, "vinc%d_csi_sel", pdev->id);
// ...
sprintf(property_name, "vinc%d_mipi_sel", pdev->id);
// ...
sprintf(property_name, "vinc%d_isp_sel", pdev->id);
// ...
sprintf(property_name, "vinc%d_isp_tx_ch", pdev->id);
// ...
sprintf(property_name, "vinc%d_tdm_rx_sel", pdev->id);
```

---

### 每个字段的含义

#### `vinc0_csi_sel = <0>` — 选择 CSI Parser 编号

指定本路 VINC 使用哪个 **CSI Parser（并行/串行接口解析器）**，对应硬件上的 `csi0`、`csi1`、`csi2`...

- `<0>` → 使用 `csi0`

完整 pipeline 打印中会体现为：
```
vi0: sensor => mipi0 => csi0 => tdm_rx0 => isp0 => vipp0
```

---

#### `vinc0_mipi_sel = <0>` — 选择 MIPI D-PHY 编号

指定连接哪个 **MIPI CSI-2 控制器**（D-PHY 接口）。

- `<0>` → 使用 `mipi0`
- `<0xff>` → 不使用 MIPI（DVP 并行接口，pipeline 中跳过 mipi 节点）

---

#### `vinc0_isp_sel = <0>` — 选择 ISP 编号

指定图像数据送入哪个 **ISP（图像信号处理器）** 处理（去噪、AWB、AE、去马赛克等）。

- `<0>` → 使用 `isp0`

---

#### `vinc0_isp_tx_ch = <0>` — ISP 输出通道

指定 ISP 的输出通道编号（ISP 支持多路输出，`tx_ch` 选择其中一路送给下游 TDM/VIPP）。

- `<0>` → 使用 ISP tx channel 0

---

#### `vinc0_tdm_rx_sel = <0>` — 选择 TDM RX 通道

指定使用哪个 **TDM（时分复用）接收通道**。TDM 在 offline 模式下负责在 ISP 和 VIPP 之间缓冲/仲裁多路数据。

- `<0>` → 使用 `tdm_rx0`
- `<0xff>` → 不经过 TDM（直连 ISP→VIPP）

---

#### `vinc0_rear_sensor_sel = <0>` — 后摄传感器索引

指定"后摄"对应的 **sensor 在 sensor list 中的序号**，用于通过 `/dev/videoX` 打开摄像头时驱动自动匹配到哪个物理 sensor。

- `<0>` → sensor list 中第 0 个（通常是主摄）

---

#### `vinc0_front_sensor_sel = <0>` — 前摄传感器索引

指定"前摄"对应的 sensor 序号，与 `rear_sensor_sel` 配合，驱动根据应用层请求的摄像头方向（前/后）自动切换。

- 本节点前后摄均为 `<0>`，说明这一路只有一个 sensor 且共用

---

#### `vinc0_sensor_list = <0>` — sensor 列表选择

指定使用哪套 **sensor_list 配置表**（board.dts 中可以配多组 sensor 列表，不同平台/产品形态选不同列表）。

- `<0>` → 使用第 0 套 sensor list

---

### 总结：vinc00 构成的完整 pipeline

根据以上配置，vinc00（`/dev/video0`）的硬件数据流为：

```
Sensor(rear_sensor=0)
    → MIPI D-PHY 0  (mipi_sel=0)
    → CSI Parser 0  (csi_sel=0)
    → TDM RX 0      (tdm_rx_sel=0)
    → ISP 0         (isp_sel=0, tx_ch=0)
    → VIPP/Scaler 0 (vipp_sel = vinc->id = 0)
    → DMA → /dev/video0  (work_mode=offline)
```

```dts
vinc00:vinc@0 {
    vinc0_csi_sel       = <0>;
    vinc0_mipi_sel      = <0>;
    vinc0_isp_sel       = <0>;
    vinc0_isp_tx_ch     = <0>;
    vinc0_tdm_rx_sel    = <0>;
    vinc0_rear_sensor_sel  = <0>;
    vinc0_front_sensor_sel = <0>;
    vinc0_sensor_list   = <0>;
    work_mode = <0x1>;
    status = "okay";
};
```

```c
sprintf(property_name, "vinc%d_csi_sel", pdev->id);
// ...
sprintf(property_name, "vinc%d_mipi_sel", pdev->id);
// ...
sprintf(property_name, "vinc%d_isp_sel", pdev->id);
// ...
sprintf(property_name, "vinc%d_isp_tx_ch", pdev->id);
// ...
sprintf(property_name, "vinc%d_tdm_rx_sel", pdev->id);
```

```plaintext
vi0: sensor => mipi0 => csi0 => tdm_rx0 => isp0 => vipp0
```

```plaintext
Sensor(rear_sensor=0)
    → MIPI D-PHY 0  (mipi_sel=0)
    → CSI Parser 0  (csi_sel=0)
    → TDM RX 0      (tdm_rx_sel=0)
    → ISP 0         (isp_sel=0, tx_ch=0)
    → VIPP/Scaler 0 (vipp_sel = vinc->id = 0)
    → DMA → /dev/video0  (work_mode=offline)
```

---

**User**

这些VINC节点究竟代表什么？能否结合驱动详细分析一下

---

**Cursor**

先读取 board.dts 的 VINC 节点全貌，同时读取驱动中 VINC 的核心数据结构：

现在已有所有关键信息，可以给出完整深度分析。

---

## VINC 节点到底代表什么？

### 一、硬件资源总览（V853/V851S = sun8iw21p1）

```
VIN_MAX_DEV     = 16   → 最多 16 个 VINC 节点（/dev/video0 ~ /dev/video15）
VIN_MAX_CSI     = 3    → 3 个 CSI Parser（csi0/1/2）
VIN_MAX_MIPI    = 2    → 2 个 MIPI D-PHY（mipi0/1）
VIN_MAX_ISP     = 5    → 5 个 ISP 实例（isp0~4，但物理只有1个，其余是虚拟）
VIN_MAX_SCALER  = 16   → 16 个 VIPP/Scaler 实例
VIN_MAX_TDM     = 1    → 1 个 TDM

物理 VIPP 寄存器基地址只有 4 个：
  VIPP0: 0x05910000
  VIPP1: 0x05910400
  VIPP2: 0x05910800
  VIPP3: 0x05910c00

物理 DMA 控制器只有 4 个：
  CSI_DMA0: 0x05830000
  CSI_DMA1: 0x05831000
  CSI_DMA2: 0x05832000
  CSI_DMA3: 0x05833000
```

---

### 二、16 个 VINC 与 4 个物理硬件的映射关系

这是理解 VINC 的核心。驱动用两张查找表将 16 个虚拟 VINC 映射到 4 个物理 DMA/VIPP 控制器：

```36:39:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/dma140/dma140_reg.c
// 虚拟通道号（0~3）→ 对应物理 DMA 控制器内的子通道
int dma_virtual_find_ch[16]    = { 0, 1, 2, 3,  0, 1, 2, 3,  0, 1, 2, 3,  0, 1, 2, 3 };

// 虚拟 VINC ID → 对应哪个物理 logic VINC（即哪个物理 DMA 控制器）
int dma_virtual_find_logic[16] = { 0, 0, 0, 0,  4, 4, 4, 4,  8, 8, 8, 8, 12,12,12,12 };
```

```35:37:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/vipp200/vipp200_reg.c
// 虚拟 scaler ID → 对应哪个物理 logic scaler（即哪个物理 VIPP 寄存器组）
int vipp_virtual_find_logic[16] = { 0, 0, 0, 0,  4, 4, 4, 4,  8, 8, 8, 8, 12,12,12,12 };
```

这两张表揭示了 VINC 的本质分组：

```
┌─────────────────────────────────────────────────────┐
│  物理硬件组 0: DMA0 + VIPP0                          │
│    logic VINC: vinc00 (video0)  → ch0               │
│    virtual:    vinc01 (video1)  → ch1               │
│    virtual:    vinc02 (video2)  → ch2               │
│    virtual:    vinc03 (video3)  → ch3               │
├─────────────────────────────────────────────────────┤
│  物理硬件组 1: DMA1 + VIPP1                          │
│    logic VINC: vinc10 (video4)  → ch0               │
│    virtual:    vinc11 (video5)  → ch1               │
│    virtual:    vinc12 (video6)  → ch2               │
│    virtual:    vinc13 (video7)  → ch3               │
├─────────────────────────────────────────────────────┤
│  物理硬件组 2: DMA2 + VIPP2                          │
│    logic VINC: vinc20 (video8)  → ch0               │
│    virtual:    vinc21 (video9)  → ch1               │
│    virtual:    vinc22 (video10) → ch2               │
│    virtual:    vinc23 (video11) → ch3               │
├─────────────────────────────────────────────────────┤
│  物理硬件组 3: DMA3 + VIPP3                          │
│    logic VINC: vinc30 (video12) → ch0               │
│    virtual:    vinc31 (video13) → ch1               │
│    virtual:    vinc32 (video14) → ch2               │
│    virtual:    vinc33 (video15) → ch3               │
└─────────────────────────────────────────────────────┘
```

---

### 三、logic VINC vs virtual VINC 的本质区别

| 属性 | logic VINC（x0）| virtual VINC（x1/x2/x3）|
|---|---|---|
| **对应物理硬件** | 直接拥有 DMA 控制器 + VIPP 寄存器 | 复用 logic VINC 的硬件，只占一个 DMA 子通道 |
| **work_mode 配置** | 必须显式配置（`BK_ONLINE/BK_OFFLINE`） | 读取 `0xff`，从属于 logic VINC 的模式 |
| **offline 模式下** | 注册为 `/dev/videoX`，可独立 stream on | 也注册为独立 `/dev/videoX`，可独立 stream on |
| **online 模式下** | 注册为 `/dev/videoX`，可 stream on | `noneed_register=1`，不注册，用户看不到 |
| **中断处理** | 拥有 ISR，轮询4个子通道分发给对应 virtual | 没有独立 ISR，由 logic VINC 的 ISR 转发 |
| **pipeline 配置** | 决定整组 CSI/MIPI/ISP 选择 | 有自己的 pipeline 配置，可接不同 sensor/ISP |

---

### 四、VINC 节点的完整含义

**一个 VINC 节点 = 一个 `/dev/videoX` 设备 = 一路独立的图像输出通道**

它不是一个摄像头，而是一个**图像数据的出口端点**，通过 `*_sel` 字段声明自己连接到 pipeline 中哪些硬件模块：

```
vinc00 配置含义（board.dts 当前配置）：
  csi_sel=0  → 连接 CSI Parser 0
  mipi_sel=0 → 通过 MIPI D-PHY 0 接收数据
  isp_sel=0  → 使用 ISP 实例 0 处理
  tdm_rx_sel=0 → 经过 TDM RX 通道 0（V853 上实际不走）
  rear_sensor_sel=0 → 后摄用 sensor list 中第 0 号 sensor
  vipp_sel=0（自动=pdev->id）→ 使用 VIPP0 输出
  work_mode=1 → BK_OFFLINE，多通道 DMA 使能
```

最终形成完整 pipeline：

```
sensor0 → MIPI0 → CSI0 → ISP0 → VIPP0-ch0 → DMA0 → /dev/video0 (vinc00, logic)
                                             VIPP0-ch1 → DMA0 → /dev/video1 (vinc01, virtual)
                                             VIPP0-ch2 → DMA0 → /dev/video2 (vinc02, virtual, disabled)
                                             VIPP0-ch3 → DMA0 → /dev/video3 (vinc03, virtual, disabled)
```

**同一路 sensor 的数据经过同一个 ISP/VIPP，在 offline 模式下可以同时输出 4 路不同格式/分辨率的图像到 4 个独立的 `/dev/videoX`**，这就是 VINC 节点设计的核心价值。

```plaintext
VIN_MAX_DEV     = 16   → 最多 16 个 VINC 节点（/dev/video0 ~ /dev/video15）
VIN_MAX_CSI     = 3    → 3 个 CSI Parser（csi0/1/2）
VIN_MAX_MIPI    = 2    → 2 个 MIPI D-PHY（mipi0/1）
VIN_MAX_ISP     = 5    → 5 个 ISP 实例（isp0~4，但物理只有1个，其余是虚拟）
VIN_MAX_SCALER  = 16   → 16 个 VIPP/Scaler 实例
VIN_MAX_TDM     = 1    → 1 个 TDM

物理 VIPP 寄存器基地址只有 4 个：
  VIPP0: 0x05910000
  VIPP1: 0x05910400
  VIPP2: 0x05910800
  VIPP3: 0x05910c00

物理 DMA 控制器只有 4 个：
  CSI_DMA0: 0x05830000
  CSI_DMA1: 0x05831000
  CSI_DMA2: 0x05832000
  CSI_DMA3: 0x05833000
```

```c
// 虚拟通道号（0~3）→ 对应物理 DMA 控制器内的子通道
int dma_virtual_find_ch[16]    = { 0, 1, 2, 3,  0, 1, 2, 3,  0, 1, 2, 3,  0, 1, 2, 3 };

// 虚拟 VINC ID → 对应哪个物理 logic VINC（即哪个物理 DMA 控制器）
int dma_virtual_find_logic[16] = { 0, 0, 0, 0,  4, 4, 4, 4,  8, 8, 8, 8, 12,12,12,12 };
```

```c
// 虚拟 scaler ID → 对应哪个物理 logic scaler（即哪个物理 VIPP 寄存器组）
int vipp_virtual_find_logic[16] = { 0, 0, 0, 0,  4, 4, 4, 4,  8, 8, 8, 8, 12,12,12,12 };
```

```plaintext
┌─────────────────────────────────────────────────────┐
│  物理硬件组 0: DMA0 + VIPP0                          │
│    logic VINC: vinc00 (video0)  → ch0               │
│    virtual:    vinc01 (video1)  → ch1               │
│    virtual:    vinc02 (video2)  → ch2               │
│    virtual:    vinc03 (video3)  → ch3               │
├─────────────────────────────────────────────────────┤
│  物理硬件组 1: DMA1 + VIPP1                          │
│    logic VINC: vinc10 (video4)  → ch0               │
│    virtual:    vinc11 (video5)  → ch1               │
│    virtual:    vinc12 (video6)  → ch2               │
│    virtual:    vinc13 (video7)  → ch3               │
├─────────────────────────────────────────────────────┤
│  物理硬件组 2: DMA2 + VIPP2                          │
│    logic VINC: vinc20 (video8)  → ch0               │
│    virtual:    vinc21 (video9)  → ch1               │
│    virtual:    vinc22 (video10) → ch2               │
│    virtual:    vinc23 (video11) → ch3               │
├─────────────────────────────────────────────────────┤
│  物理硬件组 3: DMA3 + VIPP3                          │
│    logic VINC: vinc30 (video12) → ch0               │
│    virtual:    vinc31 (video13) → ch1               │
│    virtual:    vinc32 (video14) → ch2               │
│    virtual:    vinc33 (video15) → ch3               │
└─────────────────────────────────────────────────────┘
```

```plaintext
vinc00 配置含义（board.dts 当前配置）：
  csi_sel=0  → 连接 CSI Parser 0
  mipi_sel=0 → 通过 MIPI D-PHY 0 接收数据
  isp_sel=0  → 使用 ISP 实例 0 处理
  tdm_rx_sel=0 → 经过 TDM RX 通道 0（V853 上实际不走）
  rear_sensor_sel=0 → 后摄用 sensor list 中第 0 号 sensor
  vipp_sel=0（自动=pdev->id）→ 使用 VIPP0 输出
  work_mode=1 → BK_OFFLINE，多通道 DMA 使能
```

```plaintext
sensor0 → MIPI0 → CSI0 → ISP0 → VIPP0-ch0 → DMA0 → /dev/video0 (vinc00, logic)
                                             VIPP0-ch1 → DMA0 → /dev/video1 (vinc01, virtual)
                                             VIPP0-ch2 → DMA0 → /dev/video2 (vinc02, virtual, disabled)
                                             VIPP0-ch3 → DMA0 → /dev/video3 (vinc03, virtual, disabled)
```

---

**User**

VIPP是干什么的？和VINC的关系是什么

---

**Cursor**

现在信息完整，可以给出深入分析：

---

## VIPP 是什么？与 VINC 的关系是什么？

### 一、VIPP 的全称与定位

**VIPP = Video Input Post Processor（视频输入后处理器）**

它位于 ISP 输出之后、DMA 写入 DDR 之前，是整个 pipeline 的最后一级硬件处理模块：

```
Sensor → MIPI → CSI → ISP → [VIPP] → DMA → DDR → /dev/videoX
                              ↑
                        VIPP 在这里
```

---

### 二、VIPP 的硬件功能（6 大功能）

从寄存器结构可以看出 VIPP 能做什么：

```179:200:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/vipp200/vipp200_reg.h
struct vipp_scaler_config  → 缩放参数（水平/垂直缩放比）
struct vipp_scaler_size    → 输出分辨率
struct vipp_osd_config     → OSD 叠加层配置
struct vipp_osd_overlay    → 图片叠加（overlay）
struct vipp_osd_cover      → 色块遮挡（cover/马赛克）
struct vipp_osd_orl        → 目标框标注（ORL，最多16个）
```

| 功能 | 说明 |
|---|---|
| **Crop 裁剪** | 从 ISP 输出中截取 ROI 区域（`VIPP_CROP_START/SIZE` 寄存器） |
| **Scale 缩放** | 对图像做缩小（`vipp_scaler_cfg/output_size`），注意只能缩不能放大 |
| **格式转换** | YUV422 → YUV420（`vipp_chroma_ds_en`），或透传 RAW/RGB |
| **OSD Overlay** | 硬件叠加 ARGB 图片（如水印、UI），最多若干层 |
| **OSD Cover** | 硬件色块遮挡（隐私保护/马赛克） |
| **ORL 目标框** | 硬件绘制矩形框（最多 **16个**，AI 检测结果直接叠加到图像上）|

对于 RAW 格式输出，VIPP **直接透传**，不做任何处理：

```478:492:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/sunxi_scaler.c
case V4L2_PIX_FMT_SBGGR8/10/12:
case V4L2_PIX_FMT_RGB24:
    vin_log("output fmt is raw, return directly\n");
    return 0;   // RAW 格式跳过所有 VIPP 处理
```

---

### 三、VIPP 的物理结构：1 个物理核心 + 4 路通道

V853 只有 **4 个物理 VIPP 寄存器组**，但每个物理 VIPP 内有 **4 个独立通道（ch0~ch3）**，通过地址偏移区分：

```29:61:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/vipp200/vipp200_reg.c
#define addr_base_offset 0x4   // 每个通道寄存器偏移 4 字节

int vipp_virtual_find_ch[16] = {
    0, 1, 2, 3,   // vipp0/1/2/3 对应物理 VIPP0 的 ch0/1/2/3
    0, 1, 2, 3,   // vipp4/5/6/7 对应物理 VIPP1 的 ch0/1/2/3
    0, 1, 2, 3,   // vipp8/9/10/11 对应物理 VIPP2 的 ch0/1/2/3
    0, 1, 2, 3,   // vipp12/13/14/15 对应物理 VIPP3 的 ch0/1/2/3
};
// 初始化时：vipp_base[id] += vipp_virtual_find_ch[id] * addr_base_offset
```

---

### 四、VIPP 与 VINC 的关系

这是最关键的部分：

```
vinc->vipp_sel = pdev->id   // VINC 的 ID 就是它使用的 VIPP ID
```

**VINC 和 VIPP 是 1:1 绑定的**，VINC 的编号直接就是 VIPP 的编号：

```
vinc00 (id=0)  ←绑定→ vipp0  (物理VIPP0 ch0)
vinc01 (id=1)  ←绑定→ vipp1  (物理VIPP0 ch1)
vinc02 (id=2)  ←绑定→ vipp2  (物理VIPP0 ch2)
vinc03 (id=3)  ←绑定→ vipp3  (物理VIPP0 ch3)
vinc10 (id=4)  ←绑定→ vipp4  (物理VIPP1 ch0)
vinc11 (id=5)  ←绑定→ vipp5  (物理VIPP1 ch1)
...
```

---

### 五、完整的职责分工

```
┌────────────────────────────────────────────────────────┐
│  ISP                                                    │
│  负责：3A、去噪、去马赛克、色彩校正 → 输出 YUV/RAW    │
└──────────────────┬─────────────────────────────────────┘
                   │ 同一份 ISP 输出数据
         ┌─────────┼─────────┐
         ▼         ▼         ▼
      VIPP ch0   VIPP ch1  VIPP ch2  ...（同一物理 VIPP 的不同通道）
      裁剪/缩放  裁剪/缩放  透传RAW
      1080p出图  720p出图   RAW出图
         │         │         │
      DMA ch0   DMA ch1   DMA ch2
         │         │         │
    /dev/video0 /dev/video1 /dev/video2
    (vinc00)    (vinc01)    (vinc02)
```

**总结：VIPP 是图像的"最后一道工序"硬件，VINC 是对应的"软件控制句柄 + DMA 出口"。每个 VINC 独占一个 VIPP 通道，通过 VIPP 对图像做裁剪/缩放/格式转换/OSD 后写入 DDR，最终呈现给用户空间的 `/dev/videoX`。**

```plaintext
Sensor → MIPI → CSI → ISP → [VIPP] → DMA → DDR → /dev/videoX
                              ↑
                        VIPP 在这里
```

```plaintext
struct vipp_scaler_config  → 缩放参数（水平/垂直缩放比）
struct vipp_scaler_size    → 输出分辨率
struct vipp_osd_config     → OSD 叠加层配置
struct vipp_osd_overlay    → 图片叠加（overlay）
struct vipp_osd_cover      → 色块遮挡（cover/马赛克）
struct vipp_osd_orl        → 目标框标注（ORL，最多16个）
```

```c
case V4L2_PIX_FMT_SBGGR8/10/12:
case V4L2_PIX_FMT_RGB24:
    vin_log("output fmt is raw, return directly\n");
    return 0;   // RAW 格式跳过所有 VIPP 处理
```

```c
#define addr_base_offset 0x4   // 每个通道寄存器偏移 4 字节

int vipp_virtual_find_ch[16] = {
    0, 1, 2, 3,   // vipp0/1/2/3 对应物理 VIPP0 的 ch0/1/2/3
    0, 1, 2, 3,   // vipp4/5/6/7 对应物理 VIPP1 的 ch0/1/2/3
    0, 1, 2, 3,   // vipp8/9/10/11 对应物理 VIPP2 的 ch0/1/2/3
    0, 1, 2, 3,   // vipp12/13/14/15 对应物理 VIPP3 的 ch0/1/2/3
};
// 初始化时：vipp_base[id] += vipp_virtual_find_ch[id] * addr_base_offset
```

```plaintext
vinc->vipp_sel = pdev->id   // VINC 的 ID 就是它使用的 VIPP ID
```

```plaintext
vinc00 (id=0)  ←绑定→ vipp0  (物理VIPP0 ch0)
vinc01 (id=1)  ←绑定→ vipp1  (物理VIPP0 ch1)
vinc02 (id=2)  ←绑定→ vipp2  (物理VIPP0 ch2)
vinc03 (id=3)  ←绑定→ vipp3  (物理VIPP0 ch3)
vinc10 (id=4)  ←绑定→ vipp4  (物理VIPP1 ch0)
vinc11 (id=5)  ←绑定→ vipp5  (物理VIPP1 ch1)
...
```

```plaintext
┌────────────────────────────────────────────────────────┐
│  ISP                                                    │
│  负责：3A、去噪、去马赛克、色彩校正 → 输出 YUV/RAW    │
└──────────────────┬─────────────────────────────────────┘
                   │ 同一份 ISP 输出数据
         ┌─────────┼─────────┐
         ▼         ▼         ▼
      VIPP ch0   VIPP ch1  VIPP ch2  ...（同一物理 VIPP 的不同通道）
      裁剪/缩放  裁剪/缩放  透传RAW
      1080p出图  720p出图   RAW出图
         │         │         │
      DMA ch0   DMA ch1   DMA ch2
         │         │         │
    /dev/video0 /dev/video1 /dev/video2
    (vinc00)    (vinc01)    (vinc02)
```

