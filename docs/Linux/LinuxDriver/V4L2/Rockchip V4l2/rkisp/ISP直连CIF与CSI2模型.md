# RKISP 两种实际拓扑链路

本文总结 RK356x/Rockchip VI 驱动中常见的两种 ISP 输入链路。注意：media topology 图表达的是 V4L2/media framework 的数据路径抽象，不一定等同于芯片内部一根固定硬件连线。

## 1. CSI 直接进 ISP

典型链路：

```text
Sensor -> MIPI DPHY/CSI2 -> rkisp-csi-subdev -> rkisp-isp-subdev -> mainpath/selfpath/statistics
```

驱动状态：

```c
dev->isp_inp = INP_CSI;
```

代码位置：

```text
kernel/drivers/media/platform/rockchip/isp/dev.c
rkisp_create_links()
```

当上游 subdev 不是 CIF/VICAP，也不是 DVP/LVDS 直接输入时，ISP 驱动创建：

```c
sensor/source -> rkisp-csi-subdev:CSI_SINK
rkisp-csi-subdev:CSI_SRC_CH0 -> rkisp-isp-subdev:RKISP_ISP_PAD_SINK
```

`rkisp-csi-subdev` 不是独立 platform driver。它是 `rkisp` 内部注册的 V4L2 subdev，用来抽象 ISP 内部 CSI2RX 输入、VC/DT 选择、HDR/readback 相关寄存器配置。

相关代码：

```text
kernel/drivers/media/platform/rockchip/isp/csi.c
rkisp_register_csi_subdev()
csi_config()
rkisp_csi_config_patch()
```

它主要配置 ISP 内部寄存器，例如：

```text
CSI2RX_CTRL0
CSI2RX_CTRL1
CSI2RX_CTRL2
CSI2RX_DATA_IDS_1
CSI2RX_DATA_IDS_2
CSI2RX_MASK_*
ISP_HDRMGE_BASE
```

## 2. CSI 先进 CIF/VICAP，再送 ISP

典型链路：

```text
Sensor -> MIPI CSI2 HOST/DPHY -> CIF/VICAP -> rkisp-isp-subdev -> mainpath/selfpath/statistics
```

驱动状态：

```c
dev->isp_inp = INP_CIF;
```

你给出的 topology 图就是这种路径：

```text
rkcif-mipi-lvds2 -> rkisp-isp-subdev
```

这时图里没有 `rkisp-csi-subdev`，因为 MIPI/LVDS/CIF 接收和前端路由由 CIF/VICAP 侧完成，ISP 侧只把 `rkcif-mipi-lvds*` 暴露出来的 subdev 当作图像输入源。

相关代码：

```text
kernel/drivers/media/platform/rockchip/isp/dev.c
rkisp_create_links()
```

当上游 entity function 是：

```c
MEDIA_ENT_F_PROC_VIDEO_COMPOSER
```

驱动创建：

```c
rkcif-mipi-lvds* -> rkisp-isp-subdev:RKISP_ISP_PAD_SINK
```

CIF 侧真正的 MIPI CSI2 HOST 驱动在：

```text
kernel/drivers/media/platform/rockchip/cif/mipi-csi2.c
```

它是独立 platform driver，会匹配 DTS compatible，例如：

```text
rockchip,rk3568-mipi-csi2
rockchip,rk3568-mipi-csi2-hw
```

它负责 CSIHOST 层面的 lane、reset、clock、error interrupt 等配置。

## rkisp-isp-subdev pad 含义

`rkisp-isp-subdev` 的 pad 定义在：

```text
kernel/drivers/media/platform/rockchip/isp/rkisp.h
```

```c
RKISP_ISP_PAD_SINK         // pad 0: 图像输入
RKISP_ISP_PAD_SINK_PARAMS  // pad 1: ISP 参数输入
RKISP_ISP_PAD_SOURCE_PATH  // pad 2: 图像输出
RKISP_ISP_PAD_SOURCE_STATS // pad 3: 统计输出
```

因此常见 topology 可读成：

```text
pad 0 <- sensor / rkcif / rawrd*
pad 1 <- rkisp-input-params
pad 2 -> rkisp_mainpath / rkisp_selfpath / rkisp_fbcpath / rkisp_iqtool
pad 3 -> rkisp-statistics
```

## 结论

可以理解为：

```text
CSI2 可以直接服务 ISP，也可以服务 CIF/VICAP。
```

但更准确地说，当前走哪条链路由 DTS、media link 和平台硬件路由决定。CIF 里的 `mipi-csi2.c` 是真实 CSI2 HOST 驱动；ISP 里的 `csi.c` 是 RKISP 内部 CSI 输入/CSI2RX 抽象。
