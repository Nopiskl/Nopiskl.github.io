# Rockchip CIF driver explanation
_Exported on 2026/3/25 at GMT+8 19:10:16 from Cursor (2.3.34)_

---

**User**

@kernel/drivers/media/platform/rockchip/cif/dev.c 解释一下这个驱动的作用

---

**Cursor**

---

## `dev.c` — RK3568 CIF（Camera Interface）驱动核心文件

### 一、驱动整体定位

这个文件是 **Rockchip RK3568 CIF（Camera Interface）控制器**的核心设备驱动文件，位于 Linux V4L2 媒体子系统框架下。CIF 是 RK3568 SoC 上负责接收来自摄像头传感器图像数据的硬件模块，支持并行接口（DVP）和 MIPI CSI 接口。

---


## `dev.c` — Rockchip CIF 摄像头接口平台驱动核心文件

### 一、驱动整体定位

这是 **Rockchip CIF（Camera Interface）控制器** 的 Linux 平台驱动核心文件，基于 V4L2 + Media Controller 框架，负责将 RK3568 等芯片上的摄像头硬件接口抽象为标准 Linux 视频设备。

---

### 二、支持的接口类型

通过设备树 `compatible` 匹配两类接口：

```1984:1997:kernel/drivers/media/platform/rockchip/cif/dev.c
static const struct of_device_id rkcif_plat_of_match[] = {
	{
		.compatible = "rockchip,rkcif-dvp",
		.data = &rkcif_dvp_match_data,
	},
	{
		.compatible = "rockchip,rkcif-mipi-lvds",
		.data = &rkcif_mipi_lvds_match_data,
	},
	{},
};
```

- `rkcif-dvp`：并行 DVP 接口（BT656/BT1120/PARALLEL）
- `rkcif-mipi-lvds`：MIPI CSI-2 / LVDS 串行接口

---

### 三、主要功能模块详解

#### 1. sysfs 运行时调试属性（`/sys/devices/...`）

文件开头大量 `DEVICE_ATTR` 定义了可通过 sysfs 动态调整的参数：

| 属性文件 | 作用 |
|---|---|
| `compact_test` | 控制每路 stream 的紧凑模式（compact vs 16bit） |
| `wait_line` | 设置行中断触发的行号（用于提前唤醒 ISP） |
| `is_use_dummybuf` | 是否启用 dummy buffer（防止 DMA 访问无效地址） |
| `is_high_align` | 内存对齐方式（低对齐/高对齐/紧凑） |
| `scale_ch[0-3]_blc` | 缩放通道的黑电平补偿值（BLC pattern） |
| `fps` | 动态设置各路 stream 的帧率 |
| `rdbk_debug` | 回读调试开关 |

#### 2. 寄存器读写抽象层

提供统一的寄存器操作接口，内部处理多芯片的 CSI host 偏移差异：

```418:440:kernel/drivers/media/platform/rockchip/cif/dev.c
void rkcif_write_register(struct rkcif_device *dev,
			  enum cif_reg_index index, u32 val)
```

- `rkcif_write_register` / `rkcif_read_register`：普通寄存器读写
- `rkcif_write_register_or` / `rkcif_write_register_and`：带位操作的寄存器读改写
- `rkcif_write_grf_reg` / `rkcif_read_grf_reg`：GRF（General Register Files）系统寄存器读写，用于配置 IO 复用

针对不同芯片（RK3568/RK3588/RV1126/RV1106），MIPI CSI 寄存器的基地址偏移不同：
- RK3588：`csi_host_idx * 0x100`
- RV1106/RV1126：`csi_host_idx * 0x200`

#### 3. DVP 时钟边沿配置

```528:600:kernel/drivers/media/platform/rockchip/cif/dev.c
void rkcif_enable_dvp_clk_dual_edge(struct rkcif_device *dev, bool on)
```

支持配置 DVP PCLK 的采样边沿（上升沿/下降沿/双边沿），通过 GRF 寄存器写入，针对 RK3568/RK3588/RV1106 有各自的寄存器位定义。

#### 4. Media Pipeline 管理

```620:700:kernel/drivers/media/platform/rockchip/cif/dev.c
static int rkcif_pipeline_open(struct rkcif_pipeline *p,
			       struct media_entity *me,
				bool prepare)
```

- `__cif_pipeline_prepare`：遍历 Media Graph，从视频节点向上溯源，收集整条 pipeline 上的所有 sub-device（DPHY、sensor 等）
- `rkcif_pipeline_open` / `rkcif_pipeline_close`：引用计数式的 pipeline 开关
- `rkcif_pipeline_set_stream`：按顺序控制 pipeline 中各 sub-device 的 `s_stream`，stream-on 顺序为 **ISP → DPHY → Sensor**，stream-off 相反

#### 5. 多摄同步开流（Sync Mode）

```718:820:kernel/drivers/media/platform/rockchip/cif/dev.c
static void rkcif_set_sensor_streamon_in_sync_mode(struct rkcif_device *cif_dev)
```

支持多个 CIF 设备的同步启动（Master-Slave 模式）。只有当同组内所有设备都准备好后，才统一向传感器发送 `RKMODULE_SET_QUICK_STREAM` ioctl，实现硬件级同步触发。

#### 6. HDR 多帧模式支持

在 `rkcif_pipeline_set_stream` 中区分：
- `NO_HDR` / `HDR_COMPR`：单次开流即可
- `HDR_X2`：需要 2 路 stream 都 open 后才真正开流
- `HDR_X3`：需要 3 路 stream 都 open 后才真正开流

#### 7. Media Controller 链路创建

```960:1100:kernel/drivers/media/platform/rockchip/cif/dev.c
static int rkcif_create_link(struct rkcif_device *dev,
			     struct rkcif_sensor_info *sensor,
			     u32 stream_num,
			     bool *mipi_lvds_linked)
```

根据传感器总线类型，在 sensor sub-device 与 video node 之间创建 Media pad link：
- MIPI：sensor → stream[0~3]（4路虚拟通道）
- DVP BT656/PARALLEL：sensor → stream[pad]（按 pad 索引对应）
- LVDS（CCP2）：sensor → lvds_subdev → stream
- RK3588 额外支持 scale_vdev（缩放输出节点）
- RK1808 以上支持 tools_vdev（工具通道）

#### 8. V4L2 Async 子设备通知机制

```1150:1280:kernel/drivers/media/platform/rockchip/cif/dev.c
static int subdev_notifier_complete(struct v4l2_async_notifier *notifier)
```

- `rkcif_fwnode_parse`：解析设备树 endpoints，提取总线类型和 lane 数量
- `subdev_notifier_bound`：传感器 sub-device 绑定时保存其信息
- `subdev_notifier_complete`：所有 sub-device 就绪后完成链路创建、注册视频节点、设置默认格式
- `notifier_isp_thread`：独立内核线程，等待 notifier 完成后向 ISP 注册 CIF 作为 sub-device（CIF 与 ISP 级联场景）

#### 9. 平台驱动 probe/remove

```2030:2120:kernel/drivers/media/platform/rockchip/cif/dev.c
static int rkcif_plat_probe(struct platform_device *pdev)
```

`probe` 流程：
1. 匹配 DTS compatible，确定接口类型（DVP/MIPI）
2. `rkcif_attach_hw`：通过 DTS `rockchip,hw` phandle 找到共享 hw 设备，关联寄存器基地址、时钟等硬件资源
3. `rkcif_parse_dts`：读取 `wait-line` 等 DTS 属性
4. `rkcif_plat_init`：初始化 stream/scale/tools vdev，注册 V4L2 device 和 Media device，启动 async notifier
5. `rkcif_get_reserved_mem`：获取 thunderboot 预留内存（用于快速启动场景）
6. `rkcif_init_reset_monitor`：初始化看门狗定时器，用于 CSI 错误自动复位

#### 10. 运行时电源管理（Runtime PM）

```2145:2175:kernel/drivers/media/platform/rockchip/cif/dev.c
static int __maybe_unused rkcif_runtime_suspend(struct device *dev)
```

- `rkcif_runtime_suspend`：引用计数归零时，调用底层 hw 设备的 `pm_runtime_put_sync` 关闭时钟/电源
- `rkcif_runtime_resume`：恢复时重新上电，并执行 `rkcif_do_soft_reset` 软复位 CIF 控制器

---

### 四、整体架构图

```
用户态 (v4l2-ctl / GStreamer / libcamera)
         |
    /dev/video0~3  (stream vdev)
    /dev/video4~7  (scale vdev, RK3588/RV1106)
    /dev/video8~10 (tools vdev)
         |
    V4L2 + Media Controller 框架
         |
    rkcif_device (dev.c 核心结构)
    ├── rkcif_pipeline   → 管理 sensor/dphy/cif 的流控
    ├── rkcif_stream[4]  → 4路 MIPI 虚拟通道采集 (capture.c)
    ├── rkcif_scale_vdev → 缩放输出 (cif-scale.c)
    ├── rkcif_tools_vdev → 工具通道 (cif-tools.c)
    └── rkcif_hw         → 硬件寄存器操作 (hw.c)
         |
    Camera Sensor (通过 MIPI CSI2 / DVP 接口)
```

---

### 五、一句话总结

`dev.c` 是 Rockchip CIF 驱动的**平台层入口和框架胶水层**：负责设备树解析、硬件资源绑定、V4L2/Media Controller 注册、pipeline 流控、多摄同步、HDR 模式管理和电源管理，将底层摄像头硬件抽象为标准 Linux `/dev/videoX` 设备供应用层使用。

```c
static const struct of_device_id rkcif_plat_of_match[] = {
	{
		.compatible = "rockchip,rkcif-dvp",
		.data = &rkcif_dvp_match_data,
	},
	{
		.compatible = "rockchip,rkcif-mipi-lvds",
		.data = &rkcif_mipi_lvds_match_data,
	},
	{},
};
```

```plaintext
用户态 (v4l2-ctl / GStreamer / libcamera)
         |
    /dev/video0~3  (stream vdev)
    /dev/video4~7  (scale vdev, RK3588/RV1106)
    /dev/video8~10 (tools vdev)
         |
    V4L2 + Media Controller 框架
         |
    rkcif_device (dev.c 核心结构)
    ├── rkcif_pipeline   → 管理 sensor/dphy/cif 的流控
    ├── rkcif_stream[4]  → 4路 MIPI 虚拟通道采集 (capture.c)
    ├── rkcif_scale_vdev → 缩放输出 (cif-scale.c)
    ├── rkcif_tools_vdev → 工具通道 (cif-tools.c)
    └── rkcif_hw         → 硬件寄存器操作 (hw.c)
         |
    Camera Sensor (通过 MIPI CSI2 / DVP 接口)
```

