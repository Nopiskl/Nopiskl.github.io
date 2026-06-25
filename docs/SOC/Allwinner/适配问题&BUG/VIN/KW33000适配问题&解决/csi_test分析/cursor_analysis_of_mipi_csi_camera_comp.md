# Analysis of MIPI CSI camera components
_Exported on 2026/3/16 at GMT+8 20:04:42 from Cursor (2.3.34)_

---

**User**

@lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin_test/mplane_image_userptr/csi_test_mplane.c 分析一下这个测试程序，并解释一下全志VIN的MIPI CSI摄像头被该程序读取要经过哪些组件（例如ISP、TDM），就以@device/config/chips/v853/configs/100ask/board.dts 的GC2053为例

---

**Cursor**

我来分析这个测试程序和全志VIN的MIPI CSI摄像头数据流。

让我继续读取更多相关文件以便深入分析。

现在我已经掌握了足够的信息，可以给出完整的分析。以下是详细说明：

---

## `csi_test_mplane.c` 程序分析

### 程序功能概述

该程序是全志 VIN（Video Input Node）子系统的用户态测试工具，基于标准 **V4L2 multi-plane API** 进行摄像头采集测试。程序流程如下：

```
main()
  └─► main_test(sel, mode)
        ├─► camera_init()       // 打开 /dev/videoX，设置输入源、帧率、ISP模式
        ├─► camera_fmt_set()    // VIDIOC_S_FMT 设置分辨率和像素格式
        ├─► req_frame_buffers() // VIDIOC_REQBUFS + VIDIOC_QUERYBUF + VIDIOC_QBUF
        ├─► VIDIOC_STREAMON     // 启动数据流
        └─► 循环 read_frame()
              ├─► VIDIOC_DQBUF  // 从驱动取出已填充帧
              ├─► 保存/显示帧
              └─► VIDIOC_QBUF   // 归还 buffer 给驱动
```

**内存模式**支持三种（由 `buf_type` 参数控制）：
- `V4L2_MEMORY_MMAP`：默认，内核分配，用户 `mmap` 映射
- `V4L2_MEMORY_USERPTR`：用户态通过 ION 分配物理连续内存后传给驱动
- `V4L2_MEMORY_DMABUF`：通过 `ion_vir2fd()` 传递 DMA-buf fd

**典型调用示例（GC2053，1920×1080，NV12）：**
```bash
csi_test_mplane 0 0 1920 1080 /mnt/sdcard 1 20 30
#               ^  ^  分辨率       保存路径  ^ 帧数 fps
#            videoX  输入索引             mode=1(NV12)
```

---

## GC2053 MIPI CSI 数据流路径（以 board.dts 为例）

从 DTS 中的 `sensor0`（gc2053_mipi，后摄）+ `vinc00`（/dev/video0）出发，完整数据链路如下：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        GC2053 图像传感器                                 │
│  · I2C 地址: 0x6e (twi1, CCI id=1)                                     │
│  · MCLK: mclk0 (PA12)                                                   │
│  · 输出: RAW Bayer 10bit，MIPI CSI-2 协议                               │
│  · RESET: PA18,  PWDN: PA19                                             │
│  · 供电: IOVDD=1.8V(aldo2), AVDD=2.8V(bldo2), DVDD=1.2V(dldo2)        │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ MIPI D-PHY 差分信号（2-lane）
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    MIPI D-PHY / Combo RX（vin-mipi）                    │
│  · 子设备: sunxi_mipi.c → /dev/v4l-subdevX                             │
│  · 接收 MIPI CSI-2 数据包，恢复时钟和数据                               │
│  · vinc0_mipi_sel = <0>  →  使用 MIPI0                                 │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ 解包后的像素数据流
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         CSI 控制器（vin-csi）                           │
│  · 子设备: sunxi_csi.c → /dev/v4l-subdevX                              │
│  · vinc0_csi_sel = <0>  →  使用 CSI0                                   │
│  · 负责接收时序对齐、数据打包，送入后级                                 │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ RAW 像素数据
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          TDM（Time Division Multiplexer）               │
│  · 子设备: vin_tdm.c                                                    │
│  · vinc0_tdm_rx_sel = <0>  →  使用 TDM RX0                            │
│  · board.dts: tdm0 { work_mode = <1>; }  →  offline（离线）模式        │
│  · 作用：将 RAW 数据缓存到 DDR，解耦传感器帧率与 ISP 处理速率          │
│  · 在 offline 模式下，RAW 帧先写入 TDM 内部 buffer（TDM_BUFS_NUM=16）  │
│    再由 TDM TX 端按节奏送给 ISP，支持 WDR 多帧合并等                   │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ RAW 数据（从 DDR 读回）
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           ISP（图像信号处理器）                          │
│  · 子设备: sunxi_isp.c → /dev/v4l-subdevX（sunxi_isp.0）               │
│  · vinc0_isp_sel = <0>  →  使用 ISP0                                   │
│  · vinc0_isp_tx_ch = <0>  →  ISP 输出通道 0                           │
│  · board.dts: isp00 { work_mode = <1>; }  →  offline 模式              │
│  · sensor0_isp_used = <1>  →  GC2053 开启 ISP 处理                    │
│  · 完成：去马赛克(demosaic)、白平衡、曝光控制(AE)、降噪(NR)、          │
│          色彩校正(CCM)、Gamma、自动对焦统计(AF)等                       │
│  · ISP 算法库通过 VIDIOC_SET_SENSOR_ISP_CFG / VIDIOC_S_EXT_CTRLS 控制 │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ 处理后的 YUV 数据
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      VIPP / Scaler（缩放裁剪器）                        │
│  · 子设备: sunxi_scaler.c                                               │
│  · board.dts: scaler00/10/20/30 { work_mode = <1>; }                   │
│  · 对 ISP 输出做缩放、裁剪，支持多路输出不同分辨率                      │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ 最终 YUV/RAW 数据
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     VIN DMA（vin-video，/dev/video0）                   │
│  · vin_core.c + vin_video.c                                             │
│  · work_mode = <0x1>（vinc00）                                          │
│  · 将帧 DMA 写入用户通过 VIDIOC_REQBUFS 申请的 buffer                  │
│  · 支持 MMAP / USERPTR（ION）/ DMABUF 三种内存模式                     │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ VIDIOC_DQBUF
                                      ▼
               ┌──────────────────────────────────┐
               │   用户态 csi_test_mplane 程序     │
               │   read_frame() → 保存 .bin 文件  │
               │   或通过 /dev/disp 显示到屏幕     │
               └──────────────────────────────────┘
```

---

## 关键 DTS 配置对应关系（vinc00 → GC2053）

| DTS 属性 | 值 | 含义 |
|---|---|---|
| `vinc0_csi_sel` | 0 | 连接 CSI0 |
| `vinc0_mipi_sel` | 0 | 连接 MIPI0 |
| `vinc0_isp_sel` | 0 | 使用 ISP0 |
| `vinc0_isp_tx_ch` | 0 | ISP 输出通道 0 |
| `vinc0_tdm_rx_sel` | 0 | 使用 TDM RX0 |
| `vinc0_rear_sensor_sel` | 0 | 后摄 sensor0（gc2053_mipi） |
| `sensor0_isp_used` | 1 | 启用 ISP |
| `sensor0_fmt` | 1 | MIPI 格式 |
| `tdm0 work_mode` | 1 | TDM 离线模式 |
| `isp00 work_mode` | 1 | ISP 离线模式 |

---

## 测试程序中对 ISP 的控制

在 `camera_init()` 中，程序通过两个专有 ioctl 控制 ISP 行为：

```c
// 设置帧率（ISP 算法根据此调整曝光策略）
parms.parm.capture.timeperframe.denominator = fps;
parms.parm.capture.reserved[1] = wdr_mode; // 0:普通 1:WDR 2:命令模式
ioctl(fd, VIDIOC_S_PARM, &parms);

// 设置 ISP WDR 模式
sensor_isp_cfg.isp_wdr_mode = wdr_mode;
ioctl(fd, VIDIOC_SET_SENSOR_ISP_CFG, &sensor_isp_cfg);
```

若编译时开启 `SUBDEV_TEST` 宏，还可直接操作 `sunxi_isp.0` 子设备，动态调整 R/G/B/Gr 增益（`V4L2_CID_R_GAIN`）、AE 窗口（`V4L2_CID_AE_WIN_X1`）等 ISP 参数。

```plaintext
main()
  └─► main_test(sel, mode)
        ├─► camera_init()       // 打开 /dev/videoX，设置输入源、帧率、ISP模式
        ├─► camera_fmt_set()    // VIDIOC_S_FMT 设置分辨率和像素格式
        ├─► req_frame_buffers() // VIDIOC_REQBUFS + VIDIOC_QUERYBUF + VIDIOC_QBUF
        ├─► VIDIOC_STREAMON     // 启动数据流
        └─► 循环 read_frame()
              ├─► VIDIOC_DQBUF  // 从驱动取出已填充帧
              ├─► 保存/显示帧
              └─► VIDIOC_QBUF   // 归还 buffer 给驱动
```

```shellscript
csi_test_mplane 0 0 1920 1080 /mnt/sdcard 1 20 30
#               ^  ^  分辨率       保存路径  ^ 帧数 fps
#            videoX  输入索引             mode=1(NV12)
```

```plaintext
┌─────────────────────────────────────────────────────────────────────────┐
│                        GC2053 图像传感器                                 │
│  · I2C 地址: 0x6e (twi1, CCI id=1)                                     │
│  · MCLK: mclk0 (PA12)                                                   │
│  · 输出: RAW Bayer 10bit，MIPI CSI-2 协议                               │
│  · RESET: PA18,  PWDN: PA19                                             │
│  · 供电: IOVDD=1.8V(aldo2), AVDD=2.8V(bldo2), DVDD=1.2V(dldo2)        │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ MIPI D-PHY 差分信号（2-lane）
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    MIPI D-PHY / Combo RX（vin-mipi）                    │
│  · 子设备: sunxi_mipi.c → /dev/v4l-subdevX                             │
│  · 接收 MIPI CSI-2 数据包，恢复时钟和数据                               │
│  · vinc0_mipi_sel = <0>  →  使用 MIPI0                                 │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ 解包后的像素数据流
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         CSI 控制器（vin-csi）                           │
│  · 子设备: sunxi_csi.c → /dev/v4l-subdevX                              │
│  · vinc0_csi_sel = <0>  →  使用 CSI0                                   │
│  · 负责接收时序对齐、数据打包，送入后级                                 │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ RAW 像素数据
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          TDM（Time Division Multiplexer）               │
│  · 子设备: vin_tdm.c                                                    │
│  · vinc0_tdm_rx_sel = <0>  →  使用 TDM RX0                            │
│  · board.dts: tdm0 { work_mode = <1>; }  →  offline（离线）模式        │
│  · 作用：将 RAW 数据缓存到 DDR，解耦传感器帧率与 ISP 处理速率          │
│  · 在 offline 模式下，RAW 帧先写入 TDM 内部 buffer（TDM_BUFS_NUM=16）  │
│    再由 TDM TX 端按节奏送给 ISP，支持 WDR 多帧合并等                   │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ RAW 数据（从 DDR 读回）
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           ISP（图像信号处理器）                          │
│  · 子设备: sunxi_isp.c → /dev/v4l-subdevX（sunxi_isp.0）               │
│  · vinc0_isp_sel = <0>  →  使用 ISP0                                   │
│  · vinc0_isp_tx_ch = <0>  →  ISP 输出通道 0                           │
│  · board.dts: isp00 { work_mode = <1>; }  →  offline 模式              │
│  · sensor0_isp_used = <1>  →  GC2053 开启 ISP 处理                    │
│  · 完成：去马赛克(demosaic)、白平衡、曝光控制(AE)、降噪(NR)、          │
│          色彩校正(CCM)、Gamma、自动对焦统计(AF)等                       │
│  · ISP 算法库通过 VIDIOC_SET_SENSOR_ISP_CFG / VIDIOC_S_EXT_CTRLS 控制 │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ 处理后的 YUV 数据
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      VIPP / Scaler（缩放裁剪器）                        │
│  · 子设备: sunxi_scaler.c                                               │
│  · board.dts: scaler00/10/20/30 { work_mode = <1>; }                   │
│  · 对 ISP 输出做缩放、裁剪，支持多路输出不同分辨率                      │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ 最终 YUV/RAW 数据
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     VIN DMA（vin-video，/dev/video0）                   │
│  · vin_core.c + vin_video.c                                             │
│  · work_mode = <0x1>（vinc00）                                          │
│  · 将帧 DMA 写入用户通过 VIDIOC_REQBUFS 申请的 buffer                  │
│  · 支持 MMAP / USERPTR（ION）/ DMABUF 三种内存模式                     │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ VIDIOC_DQBUF
                                      ▼
               ┌──────────────────────────────────┐
               │   用户态 csi_test_mplane 程序     │
               │   read_frame() → 保存 .bin 文件  │
               │   或通过 /dev/disp 显示到屏幕     │
               └──────────────────────────────────┘
```

```c
// 设置帧率（ISP 算法根据此调整曝光策略）
parms.parm.capture.timeperframe.denominator = fps;
parms.parm.capture.reserved[1] = wdr_mode; // 0:普通 1:WDR 2:命令模式
ioctl(fd, VIDIOC_S_PARM, &parms);

// 设置 ISP WDR 模式
sensor_isp_cfg.isp_wdr_mode = wdr_mode;
ioctl(fd, VIDIOC_SET_SENSOR_ISP_CFG, &sensor_isp_cfg);
```

