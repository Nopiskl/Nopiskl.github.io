
---

**User**

ISP是如何处理数据的？结合源码分析一下

---

**Cursor**


---

## RK ISP 数据处理流程分析

### 一、ISP 驱动整体架构（`rkisp_device` 核心结构）

`isp/dev.h` 中 `rkisp_device` 的成员清晰地揭示了 ISP 的功能分层：

```
rkisp_device
├── isp_sdev          (rkisp_isp_subdev)   — ISP核心子设备，负责裁剪/格式/3A配置
├── cap_dev           (rkisp_capture_device) — 输出捕获设备（MP/SP/FBC/BP等路径）
├── stats_vdev        (rkisp_isp_stats_vdev) — 3A统计数据输出节点
├── params_vdev       (rkisp_isp_params_vdev)— 3A参数输入节点
├── dmarx_dev         (rkisp_dmarx_device)  — RAW回读输入（HDR readback）
├── csi_dev           (rkisp_csi_device)    — MIPI CSI接收子设备
├── br_dev            (rkisp_bridge_device) — ISP→ISPP 桥接子设备
└── hdr               (rkisp_hdr)           — HDR多帧DMA管理
```

对应注册的 video 节点名称（`capture.h`）：

| 节点名称 | 枚举 | 用途 |
|---|---|---|
| `rkisp_mainpath` | `RKISP_STREAM_MP` | 主路输出（最高分辨率）|
| `rkisp_selfpath` | `RKISP_STREAM_SP` | 自身路输出（预览/编码辅路）|
| `rkisp_fbcpath` | `RKISP_STREAM_FBC` | FBC 压缩格式输出→ISPP |
| `rkisp_bypasspath` | `RKISP_STREAM_BP` | 旁路直通输出 |
| `rkisp_rawwr0~3` | `RKISP_STREAM_DMATX0~3` | RAW 写出（HDR 多帧存DDR）|
| `rkisp_ispdev` | stats/params | 3A统计读出 / 3A参数写入 |

---

### 二、数据输入路径：CIF → ISP 的对接机制

ISP 的数据输入来源由 `rkisp_isp_inp` 枚举定义，包含多种输入模式：

```
enum rkisp_isp_inp {
    INP_RAWRD0/1/2  — HDR readback 从DDR读回RAW帧
    INP_CSI         — MIPI CSI-2 在线输入
    INP_DVP         — 并行DVP输入
    INP_DMARX_ISP   — DMA直接注入
    INP_LVDS        — LVDS输入
    INP_CIF         — CIF(VICAP)→ISP 在线传输（sditf接口）
}
```

**CIF 与 ISP 的对接**通过 `sditf`（Sensor Data Interface）实现，对应 `cif/subdev-itf.h` 中的 `sditf_priv`：

```
rkcif_device
    └── sditf[i] (sditf_priv)
            ├── sd          — 注册为 v4l2_subdev（CIF侧暴露给ISP的接口）
            ├── cif_dev *   — 反向指向 rkcif_device
            ├── mode        — rkisp_vicap_mode（online/offline/rdbk）
            └── toisp_inf   — 目标 ISP 编号及通道映射
```

`sditf_priv` 注册为一个特殊的 `MEDIA_ENT_F_PROC_VIDEO_COMPOSER` 类型 subdev，ISP 的 `rkisp_create_links()` 将其识别为 `INP_CIF` 输入源：

```500:510:d:/Users/DELL/Desktop/rockchip/isp/dev.c
} else if (type == MEDIA_ENT_F_PROC_VIDEO_COMPOSER) {
    dev->isp_inp = INP_CIF;
    ret = media_create_pad_link(&sensor->sd->entity, pad,
        &dev->isp_sdev.sd.entity, RKISP_ISP_PAD_SINK, en);
}
```

---

### 三、ISP pipeline 启动流程

`rkisp_pipeline_set_stream()` 定义了完整的 stream on/off 时序：

```
Stream ON 顺序（isp → phy → sensor）:
1. v4l2_subdev_call(&dev->isp_sdev.sd, video, s_stream, true)
   — 配置ISP寄存器（裁剪、格式、3A模块使能）
2. for i in subdevs[]:
       v4l2_subdev_call(subdevs[i], video, s_stream, on)
   — 依次启动 MIPI PHY、CIF/sditf、最终 sensor

Stream OFF 顺序（sensor → phy → isp）:
1. 反向遍历 subdevs[] 关流
2. v4l2_subdev_call(&dev->isp_sdev.sd, video, s_stream, false)
```

ISP 时钟根据 sensor pixel rate 动态计算：

```200:245:d:/Users/DELL/Desktop/rockchip/isp/dev.c
/* calculate data rate */
data_rate = v4l2_ctrl_g_ctrl_int64(ctrl) *   // pixel_rate × bus_width
            dev->isp_sdev.in_fmt.bus_width;
data_rate >>= 3;   // bits→bytes
// 加25%余量后查表设置ISP时钟档位
data_rate += data_rate >> 2;
for (i = 0; i < hw_dev->num_clk_rate_tbl; i++)
    if (data_rate <= hw_dev->clk_rate_tbl[i].clk_rate)
        break;
rkisp_set_clk_rate(hw_dev->clks[0], hw_dev->clk_rate_tbl[i].clk_rate * 1000000UL);
```

---

### 四、ISP 内部数据处理流水线

结合 `rkisp.c` 注释中的裁剪区域示意图，ISP 对每帧数据的处理分三级：

```
Sensor RAW 数据
       │
       ▼
┌─────────────────────────────────────────────┐
│  ISP_ACQ（采集窗口 / in_crop）              │
│  — 黑电平校正区域起点                        │
│  — 对应寄存器: CIF_ISP_ACQ_H/V_OFFS/SIZE    │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │  ISP_IS（图像稳定裁剪 / out_crop）  │   │
│  │  — 最终送入后级处理的有效图像区域   │   │
│  │  — 对应: CIF_ISP_IS_H/V_OFFS/SIZE  │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
       │
       ▼
 ISP 3A 处理模块（并行运行）:
  ├── AE  — 自动曝光测光（统计亮度直方图）
  ├── AWB — 自动白平衡（统计色温）
  └── AF  — 自动对焦（统计对比度/相位差）
       │
       ▼ （3A统计结果）
  stats_vdev → /dev/rkisp_ispdev (用户态读取)
       │
       ▼ （用户态3A算法计算后写回参数）
  params_vdev ← /dev/rkisp_ispdev (用户态写入)
       │
       ▼
 ISP 图像处理模块（串行流水）:
  BLC → DPC → LSC → AWB_GAIN → CCM → GAMMA → TNR/NR → Sharpness
       │
       ▼
 输出路径分叉:
  ├── MP路径  → Resizer → /dev/rkisp_mainpath  （编码主流）
  ├── SP路径  → Resizer → /dev/rkisp_selfpath  （预览/辅流）
  ├── FBC路径 → FBC压缩 → bridge → ISPP       （进一步后处理）
  └── DMATX   → /dev/rkisp_rawwr0~3           （HDR RAW写出）
```

---

### 五、3A 参数/统计双向数据流

这是 ISP 与用户态 3A 算法库（如 RkAiq）交互的核心机制：

**统计输出（`stats_vdev`）**：

```
ISP 帧结束中断
    └── stats_vdev.ops->isr_hdl()
            └── 将统计数据封装进 rkisp_isp_readout_work
                    └── kfifo 队列 → rd_tasklet
                            └── send_meas() → vb2 buffer → 用户态 read()
```

`isp_stats.h` 中的关键结构：

```
struct rkisp_isp_stats_vdev {
    struct kfifo rd_kfifo;          // 中断→tasklet 的无锁队列
    struct tasklet_struct rd_tasklet; // 异步处理，避免中断上下文耗时
    struct rkisp_dummy_buffer stats_buf[]; // DDR 统计缓冲区
    bool rd_stats_from_ddr;        // ISP V30+ 支持统计数据直接DMA到DDR
}
```

**参数输入（`params_vdev`）**：

```
用户态 write() → vb2 buffer 入队
    └── params_vdev.ops->param_cfg(frame_id, type)
            ├── RKISP_PARAMS_ALL  — 全量参数（开流时）
            ├── RKISP_PARAMS_IMD  — 即时生效参数
            └── RKISP_PARAMS_SHD  — 下一帧生效（shadow寄存器）
```

支持多版本参数格式（通过 union 

```plaintext
rkisp_device
├── isp_sdev          (rkisp_isp_subdev)   — ISP核心子设备，负责裁剪/格式/3A配置
├── cap_dev           (rkisp_capture_device) — 输出捕获设备（MP/SP/FBC/BP等路径）
├── stats_vdev        (rkisp_isp_stats_vdev) — 3A统计数据输出节点
├── params_vdev       (rkisp_isp_params_vdev)— 3A参数输入节点
├── dmarx_dev         (rkisp_dmarx_device)  — RAW回读输入（HDR readback）
├── csi_dev           (rkisp_csi_device)    — MIPI CSI接收子设备
├── br_dev            (rkisp_bridge_device) — ISP→ISPP 桥接子设备
└── hdr               (rkisp_hdr)           — HDR多帧DMA管理
```

```plaintext
enum rkisp_isp_inp {
    INP_RAWRD0/1/2  — HDR readback 从DDR读回RAW帧
    INP_CSI         — MIPI CSI-2 在线输入
    INP_DVP         — 并行DVP输入
    INP_DMARX_ISP   — DMA直接注入
    INP_LVDS        — LVDS输入
    INP_CIF         — CIF(VICAP)→ISP 在线传输（sditf接口）
}
```

```plaintext
rkcif_device
    └── sditf[i] (sditf_priv)
            ├── sd          — 注册为 v4l2_subdev（CIF侧暴露给ISP的接口）
            ├── cif_dev *   — 反向指向 rkcif_device
            ├── mode        — rkisp_vicap_mode（online/offline/rdbk）
            └── toisp_inf   — 目标 ISP 编号及通道映射
```

```plaintext
} else if (type == MEDIA_ENT_F_PROC_VIDEO_COMPOSER) {
    dev->isp_inp = INP_CIF;
    ret = media_create_pad_link(&sensor->sd->entity, pad,
        &dev->isp_sdev.sd.entity, RKISP_ISP_PAD_SINK, en);
}
```

```plaintext
Stream ON 顺序（isp → phy → sensor）:
1. v4l2_subdev_call(&dev->isp_sdev.sd, video, s_stream, true)
   — 配置ISP寄存器（裁剪、格式、3A模块使能）
2. for i in subdevs[]:
       v4l2_subdev_call(subdevs[i], video, s_stream, on)
   — 依次启动 MIPI PHY、CIF/sditf、最终 sensor

Stream OFF 顺序（sensor → phy → isp）:
1. 反向遍历 subdevs[] 关流
2. v4l2_subdev_call(&dev->isp_sdev.sd, video, s_stream, false)
```

```plaintext
/* calculate data rate */
data_rate = v4l2_ctrl_g_ctrl_int64(ctrl) *   // pixel_rate × bus_width
            dev->isp_sdev.in_fmt.bus_width;
data_rate >>= 3;   // bits→bytes
// 加25%余量后查表设置ISP时钟档位
data_rate += data_rate >> 2;
for (i = 0; i < hw_dev->num_clk_rate_tbl; i++)
    if (data_rate <= hw_dev->clk_rate_tbl[i].clk_rate)
        break;
rkisp_set_clk_rate(hw_dev->clks[0], hw_dev->clk_rate_tbl[i].clk_rate * 1000000UL);
```

```plaintext
Sensor RAW 数据
       │
       ▼
┌─────────────────────────────────────────────┐
│  ISP_ACQ（采集窗口 / in_crop）              │
│  — 黑电平校正区域起点                        │
│  — 对应寄存器: CIF_ISP_ACQ_H/V_OFFS/SIZE    │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │  ISP_IS（图像稳定裁剪 / out_crop）  │   │
│  │  — 最终送入后级处理的有效图像区域   │   │
│  │  — 对应: CIF_ISP_IS_H/V_OFFS/SIZE  │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
       │
       ▼
 ISP 3A 处理模块（并行运行）:
  ├── AE  — 自动曝光测光（统计亮度直方图）
  ├── AWB — 自动白平衡（统计色温）
  └── AF  — 自动对焦（统计对比度/相位差）
       │
       ▼ （3A统计结果）
  stats_vdev → /dev/rkisp_ispdev (用户态读取)
       │
       ▼ （用户态3A算法计算后写回参数）
  params_vdev ← /dev/rkisp_ispdev (用户态写入)
       │
       ▼
 ISP 图像处理模块（串行流水）:
  BLC → DPC → LSC → AWB_GAIN → CCM → GAMMA → TNR/NR → Sharpness
       │
       ▼
 输出路径分叉:
  ├── MP路径  → Resizer → /dev/rkisp_mainpath  （编码主流）
  ├── SP路径  → Resizer → /dev/rkisp_selfpath  （预览/辅流）
  ├── FBC路径 → FBC压缩 → bridge → ISPP       （进一步后处理）
  └── DMATX   → /dev/rkisp_rawwr0~3           （HDR RAW写出）
```

```plaintext
ISP 帧结束中断
    └── stats_vdev.ops->isr_hdl()
            └── 将统计数据封装进 rkisp_isp_readout_work
                    └── kfifo 队列 → rd_tasklet
                            └── send_meas() → vb2 buffer → 用户态 read()
```

```plaintext
struct rkisp_isp_stats_vdev {
    struct kfifo rd_kfifo;          // 中断→tasklet 的无锁队列
    struct tasklet_struct rd_tasklet; // 异步处理，避免中断上下文耗时
    struct rkisp_dummy_buffer stats_buf[]; // DDR 统计缓冲区
    bool rd_stats_from_ddr;        // ISP V30+ 支持统计数据直接DMA到DDR
}
```

```plaintext
用户态 write() → vb2 buffer 入队
    └── params_vdev.ops->param_cfg(frame_id, type)
            ├── RKISP_PARAMS_ALL  — 全量参数（开流时）
            ├── RKISP_PARAMS_IMD  — 即时生效参数
            └── RKISP_PARAMS_SHD  — 下一帧生效（shadow寄存器）
```