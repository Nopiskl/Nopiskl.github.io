# KW33000 VIN Multi-VC Analysis

更新时间：2026-04-10

## 1. 文档目的

本文档基于全志 `sunxi-vin` vendor 框架源码，对 `KW33000` ToF Sensor 在 `V853 / sun8iw21` 平台上的接入方式做统一整理，重点回答以下问题：

- `KW33000` 当前 driver 的多 VC 配置实际处于什么状态
- `sunxi-vin` 是如何识别和分流不同 VC 的
- `ISP00 / ISP01 / ISP02 / ISP03` 分别是什么
- `isp@4` 为什么可以视为 bypass / logic ISP 节点
- `vincX_isp_sel` 和 `vincX_isp_tx_ch` 各自代表什么
- 如果 sensor 只声明 `CHANNEL_0`，而不是 `CHANNEL_0 | CHANNEL_1`，VIN 会怎样工作
- 当前输出文件的结构到底是什么

本文档以源码静态分析为主，结论主要来自下列文件：

- `self_driver/new_version/kw33000_mipi.c`
- `self_driver/new_version/board0.dts`
- `lichee/linux-4.9/drivers/media/platform/sunxi-vin`
- `lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi`
- `self_driver/output_image`

## 2. 核心结论

1. `KW33000` 当前 driver 已经把 `g_mbus_config()` 改成了 `V4L2_MBUS_CSI2_CHANNEL_0 | V4L2_MBUS_CSI2_CHANNEL_1`，因此 VIN 框架会把它当成 2 路 CSI-2 VC 来配置，而不是 1 路。
2. `board0.dts` 中 `vinc00` 和 `vinc10` 共用同一个 `mipi1/csi1/isp4`，但分别选择 `isp_tx_ch=0` 和 `isp_tx_ch=1`。这正是“同源多 VC 分流到两个 video 节点”的典型做法。
3. `ISP00~03` 不是 4 个独立 ISP，而是 `ISP600` 架构下“逻辑 ISP0”的 4 个虚拟 ISP 通道/端口。
4. `ISP4` 不是普通 ISP 处理节点，而是“逻辑 ISP1”的软件代表节点；在这套 SDK 中，它实际表现为一条 raw/bypass 路径。
5. `isp_tx_ch` 不是用来决定“有几个 VC”的。真正决定 `total_rx_ch` 的，是 sensor `g_mbus_config()` 里的 `CHANNEL_0/1/2/3` 标志；`isp_tx_ch` 只负责选择当前 `vinc` 从哪一个 ISP 输出通道取数据。
6. 如果 sensor 只声明 `CHANNEL_0`，VIN 只会建立 1 路接收和 1 条有效数据通路；这时通常只有 `isp_tx_ch=0` 这一路有实际意义，`tx_ch=1` 不会自动获得“剩余 MIPI 数据”。
7. 当前 `kw33000_mipi.c` 虽然已经声明了 2 路 VC，但 `width/height` 仍然按 `4VC` 叠高方式上报，这与“多节点分流”的建模思路并不一致。
8. `self_driver/output_image` 中两份 `640x960x16bit` 文件实际结构都是“上半 480 行有效、下半 480 行全 0”，因此它们不是“上下各一张灰度/深度图”，而是“单张有效图 + 半帧空洞”。

## 3. KW33000 当前 driver 状态

### 3.1 驱动中定义了 4 个 VC

`self_driver/new_version/kw33000_mipi.c:71-74`

```c
#define KW33000_PIXEL_H        (672)
#define KW33000_PIXEL_V        (496)
#define KW33000_EMBEDDED_LINES (2)
#define KW33000_VC_NUM         (4)
```

这说明 driver 作者最初是按“多 VC ToF Sensor”来建模的。

### 3.2 但当前宽高仍按“4VC 叠高”上报

`self_driver/new_version/kw33000_mipi.c:583-584`

```c
info->width        = KW33000_PIXEL_H;
info->height       = KW33000_PIXEL_V * KW33000_VC_NUM;
```

`self_driver/new_version/kw33000_mipi.c:691-692`

```c
info->width  = KW33000_PIXEL_H;
info->height = KW33000_PIXEL_V * KW33000_VC_NUM;
```

`self_driver/new_version/kw33000_mipi.c:967-968`

```c
.width      = KW33000_PIXEL_H,
.height     = KW33000_PIXEL_V * KW33000_VC_NUM,
```

这意味着当前 sensor 仍在把输出伪装成一张“大高图”，而不是“每个 VC 一张真实尺寸的图”。

### 3.3 当前 `g_mbus_config()` 已声明 2 路 VC

`self_driver/new_version/kw33000_mipi.c:988-993`

```c
cfg->type  = V4L2_MBUS_CSI2;
cfg->flags = 0 | V4L2_MBUS_CSI2_2_LANE |
             V4L2_MBUS_CSI2_CHANNEL_0 |
             V4L2_MBUS_CSI2_CHANNEL_1;
```

这说明：

- 前端链路现在按 2 个 VC 分流
- 但尺寸仍按 4 个 VC 叠高在报

这是当前 driver 最明显的“混合建模”问题。

### 3.4 Sensor ioctl 仍未完全对齐 VIN 常见调用

`self_driver/new_version/kw33000_mipi.c:901-925`

当前 `sensor_ioctl()` 只处理了：

- `GET_CURRENT_WIN_CFG`
- `SET_FPS`
- `VIDIOC_VIN_SENSOR_EXP_GAIN`
- `VIDIOC_VIN_SENSOR_CFG_REQ`

没有处理 `VIDIOC_VIN_GET_SENSOR_CODE`。

而 `vin_video` 启流时会调用：

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c:3801-3804`

```c
ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_SENSOR], core, ioctl,
                       VIDIOC_VIN_GET_SENSOR_CODE, &sensor_fmt_code);
if (ret < 0) {
    vin_err("get sensor mbus code fail");
    return ret;
}
```

因此当前 `kw33000_mipi.c` 仍不算一份完全齐整的 VIN sensor driver。

## 4. DTS 配置与节点关系

### 4.1 当前验证通过的关键绑定

`self_driver/new_version/board0.dts:164-174`

```dts
vinc00:vinc@0 {
    vinc0_csi_sel = <1>;
    vinc0_mipi_sel = <1>;
    vinc0_isp_sel = <4>;
    vinc0_isp_tx_ch = <0>;
    ...
    status = "okay";
};
```

`self_driver/new_version/board0.dts:213-223`

```dts
vinc10:vinc@4 {
    vinc4_csi_sel = <1>;
    vinc4_mipi_sel = <1>;
    vinc4_isp_sel = <4>;
    vinc4_isp_tx_ch = <1>;
    ...
    status = "okay";
};
```

这表示：

- `vinc00` 与 `vinc10` 共用 `CSI1/MIPI1/ISP4`
- 但分别取 `ISP TX channel 0` 和 `ISP TX channel 1`

### 4.2 参考 dtsi 中 `isp@0~4` 的定义差异

普通 ISP 节点：

`lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi:1404-1439`

```dts
isp00:isp@0 { reg = <...>; interrupts = <...>; work_mode = <0>;  device_id = <0>; };
isp01:isp@1 { reg = <...>;                     work_mode = <0xff>; device_id = <1>; };
isp02:isp@2 { reg = <...>;                     work_mode = <0xff>; device_id = <2>; };
isp03:isp@3 { reg = <...>;                     work_mode = <0xff>; device_id = <3>; };
```

`isp@4`：

`lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi:1441-1445`

```dts
isp10:isp@4 {
    compatible = "allwinner,sunxi-isp";
    device_id = <4>;
    iommus = <&mmu_aw 4 1>;
    status = "okay";
};
```

和普通 ISP 相比，`isp@4` 明显缺少：

- `reg`
- `interrupts`
- 常规 `work_mode`

这已经说明它不是普通意义上的可编程 ISP 处理节点。

## 5. ISP00 / ISP01 / ISP02 / ISP03 到底是什么

### 5.1 平台上虽然有 5 个 ISP 节点，但不等于 5 个独立 ISP

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/platform/sun8iw21p1_vin_cfg.h:43-49`

```c
#define VIN_MAX_DEV     16
#define VIN_MAX_CSI      3
#define VIN_MAX_MIPI     2
#define VIN_MAX_ISP      5
#define VIN_MAX_SCALER  16
```

同时，`ISP600` 里又定义：

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/isp600/isp600_reg_cfg.h:23`

```c
#define ISP_VIRT_NUM 4
```

这两个数字合起来说明：

- 软件里有 5 个 ISP 子设备 ID
- 但其中 `0~3` 是一组虚拟 ISP 通道

### 5.2 `isp01~03` 的 DTS 寄存器地址本身就很“像偏移量”

在 `sun8iw21p1.dtsi` 中：

- `isp@0` 基址是 `0x05900000`
- `isp@1` 基址是 `0x058ffffc`
- `isp@2` 基址是 `0x058ffff8`
- `isp@3` 基址是 `0x058ffff4`

这不是 4 段正常独立寄存器空间，更像“同一主基址向前回退了 4/8/12 字节”。

### 5.3 驱动会把这几个地址重新“加回同一个基址”

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/isp600/isp600_reg_cfg.c:29-35`

```c
int isp_virtual_find_ch[ISP600_MAX_NUM] = {
    0, 1, 2, 3,
};

int isp_virtual_find_logic[ISP600_MAX_NUM + 1] = {
    0, 0, 0, 0, 4
};
```

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/isp600/isp600_reg_cfg.c:98-100`

```c
void bsp_isp_map_reg_addr(unsigned long id, unsigned long base)
{
    base += isp_virtual_find_ch[id] * addr_base_offset;
```

而 `addr_base_offset = 0x4`。

于是：

- `isp@0`: `0x05900000 + 0x0 = 0x05900000`
- `isp@1`: `0x058ffffc + 0x4 = 0x05900000`
- `isp@2`: `0x058ffff8 + 0x8 = 0x05900000`
- `isp@3`: `0x058ffff4 + 0xC = 0x05900000`

最终都回到同一个 ISP 寄存器基址。

### 5.4 因此 `ISP00~03` 的正确理解

从软件模型和寄存器映射看：

- `ISP00` 是逻辑 ISP0 的主节点
- `ISP01~03` 是逻辑 ISP0 的 3 个虚拟 ISP 通道/端口
- 它们不是 4 颗独立 ISP

这和 `scaler00~03 / scaler10~13 / scaler20~23 / scaler30~33` 的 “logic + virtual” 组织方式是相似的。

## 6. `isp@4` 为什么可以视为 bypass / logic ISP 节点

### 6.1 `isp@4` 没有正常 ISP 资源

前面已经看到，`isp@4` 在 DTS 中只有 `device_id = <4>`，没有：

- 寄存器基址
- 中断
- 正常 `work_mode`

### 6.2 probe 时没有资源映射就会被标记成 `is_empty`

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c:3076-3080`

```c
isp->base = of_iomap(np, 0);
if (!isp->base) {
    isp->is_empty = 1;
} else {
    isp->is_empty = 0;
    ...
}
```

因此 `isp@4` 这种没有 `reg` 的节点，天然会被标记为 `is_empty`。

### 6.3 `sunxi_isp_sensor_type()` 会把 empty ISP 强制变成 `use_isp = 0`

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c:3211-3218`

```c
void sunxi_isp_sensor_type(struct v4l2_subdev *sd, int use_isp)
{
    struct isp_dev *isp = v4l2_get_subdevdata(sd);

    isp->use_isp = use_isp;
    if (isp->is_empty)
        isp->use_isp = 0;
}
```

这意味着：

- 即便上层认为这是一个 raw sensor
- 只要 ISP 节点本身是 empty
- 最终也会变成“不启用正常 ISP 处理”

### 6.4 RAW 输出分支会直接 return

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c:654-672`

```c
if (!isp->use_isp)
    return 0;

switch (res->res_pix_fmt) {
case V4L2_PIX_FMT_SBGGR8:
...
case V4L2_PIX_FMT_SRGGB12:
    vin_log(VIN_LOG_FMT, "%s output fmt is raw, return directly\n", __func__);
```

所以从行为上讲，`isp@4` 就是一条 logic ISP / bypass path，而不是一条完整的 ISP 图像处理链。

### 6.5 `isp_virtual_find_logic` 也支持这个判断

`isp_virtual_find_logic = {0, 0, 0, 0, 4}` 表明：

- `id=0~3` 都归属逻辑 ISP0
- `id=4` 是另一条单独的逻辑 ISP 路径

因此从软件结构上，`ISP4` 更接近“逻辑 ISP1 的 bypass/raw 路径代表节点”。

## 7. VIN 如何判断“有几个 VC”

### 7.1 `vin_video` 先向 sensor 获取 `g_mbus_config`

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c:1189-1224`

VIN 在 pipeline 建立时先向 sensor 读取 `g_mbus_config()`，再把这份配置传给 MIPI 和 CSI 子设备：

```c
ret = v4l2_subdev_call(sd, video, g_mbus_config, &mcfg);
...
ret = v4l2_subdev_call(sd, video, s_mbus_config, &mcfg);
...
vinc->total_rx_ch = csi->bus_info.ch_total_num;
```

因此：

- `total_rx_ch` 的源头是 sensor `g_mbus_config()`
- 不是 DTS 的 `isp_tx_ch`
- 也不是 `vinc0_isp_sel`

### 7.2 `sunxi_mipi` 只看 `CHANNEL_0..3`

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:858-874`

```c
mipi->csi2_cfg.total_rx_ch = 0;
...
if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_0))
    mipi->csi2_cfg.total_rx_ch++;
if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_1))
    mipi->csi2_cfg.total_rx_ch++;
if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_2))
    mipi->csi2_cfg.total_rx_ch++;
if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_3))
    mipi->csi2_cfg.total_rx_ch++;
```

也就是说：

- 只报 `CHANNEL_0` -> `total_rx_ch = 1`
- 报 `CHANNEL_0 | CHANNEL_1` -> `total_rx_ch = 2`

### 7.3 `sunxi_mipi` 直接按顺序把通道映射为 `VC0/VC1/...`

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c:604-607`

```c
for (i = 0; i < mipi->csi2_cfg.total_rx_ch; i++) {
    mipi->csi2_fmt.packet_fmt[i] = get_pkt_fmt(mf->code);
    mipi->csi2_fmt.field[i] = mf->field;
    mipi->csi2_fmt.vc[i] = i;
}
```

所以在这套框架里：

- 第 0 路 RX 对应 `VC0`
- 第 1 路 RX 对应 `VC1`
- 第 2 路 RX 对应 `VC2`
- 第 3 路 RX 对应 `VC3`

VIN 理解的是“VC 编号”，不是“灰度/深度”的业务语义。

### 7.4 `sunxi_csi` 也是同样的通道数统计方式

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-csi/sunxi_csi.c:518-527`

```c
csi->bus_info.ch_total_num = 0;
if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_0))
    csi->bus_info.ch_total_num++;
if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_1))
    csi->bus_info.ch_total_num++;
...
```

所以 `vinc->total_rx_ch = 2` 的根因，依然是 sensor 报了 `CHANNEL_0 | CHANNEL_1`。

## 8. `vincX_isp_sel` 到底是什么

### 8.1 它不是“选 VC”，而是选 ISP 路径

`vin_core.c` 会从 DTS 里把 `vincX_isp_sel` 读到 `vinc->isp_sel`：

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c:2289-2294`

```c
sprintf(property_name, "vinc%d_isp_sel", pdev->id);
...
sprintf(property_name, "vinc%d_isp_tx_ch", pdev->id);
```

### 8.2 在 `sun8iw21` 上，`isp_sel` 会被拆成“逻辑 ISP 号 + 虚拟输入口号”

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:1035-1036`

```c
for (i = 0; i < vinc->total_rx_ch; i++)
    csic_isp_input_select(vind->id,
                          vinc->isp_sel/ISP_VIRT_NUM,
                          vinc->isp_sel%ISP_VIRT_NUM + i,
                          vinc->csi_sel, i);
```

这里：

- `vinc->isp_sel / ISP_VIRT_NUM` -> 逻辑 ISP 号
- `vinc->isp_sel % ISP_VIRT_NUM + i` -> ISP 输入口号

在 `ISP_VIRT_NUM = 4` 的前提下：

- `isp_sel = 0` -> 逻辑 ISP0，输入起点 0
- `isp_sel = 1` -> 逻辑 ISP0，输入起点 1
- `isp_sel = 2` -> 逻辑 ISP0，输入起点 2
- `isp_sel = 3` -> 逻辑 ISP0，输入起点 3
- `isp_sel = 4` -> 逻辑 ISP1，输入起点 0

所以对你现在的 `vinc0_isp_sel = <4>` 来说，它的含义不是“选第 4 个 VC”，而是：

- 选择逻辑 ISP1
- 并从 ISP1 的 input0 开始接收数据

## 9. `vincX_isp_tx_ch` 到底是什么

### 9.1 它不是决定 VC 数量，而是决定当前 `vinc` 从哪个 ISP 输出口取数据

`vin.c` 在完成 ISP 输入绑定后，会继续做：

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:1039`

```c
csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM,
                       vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
```

而底层定义是：

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c:235-239`

```c
void csic_vipp_input_select(unsigned int sel, unsigned int vipp,
                unsigned int isp, unsigned int ch)
{
    vin_reg_writel(..., vipp_input[vipp][isp][ch]);
}
```

这说明 `isp_tx_ch` 的语义是：

- 当前这个 VIPP
- 从所选逻辑 ISP 的第 `ch` 路输出通道取数据

### 9.2 `top_reg.c` 的 mux 表也能看出来它是“ISP 输出通道号”

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c:109-110`

```c
/*vipp_id isp_id isp_ch*/
static char vipp_input[8][4][4] = {
```

这个数组维度已经直接说明：

- 第 1 维是 VIPP
- 第 2 维是 ISP
- 第 3 维是 ISP 输出通道 `isp_ch`

所以 `vinc0_isp_tx_ch = <0>` 的精确含义就是：

- 当前 `vinc0` 对应的 video 节点
- 从所选 ISP 路径的第 0 路输出通道取图

## 10. VIN 如何把不同 VC 送到不同 `isp_tx_ch`

### 10.1 先按 VC 建立 RX channel

如果 sensor 报：

```c
V4L2_MBUS_CSI2_CHANNEL_0 | V4L2_MBUS_CSI2_CHANNEL_1
```

那么 VIN 会建立：

- `RX ch0 <-> VC0`
- `RX ch1 <-> VC1`

### 10.2 再把 RX channel 送到 ISP 输入

`vin.c` 的核心逻辑：

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c:1032-1039`

```c
else {
    for (i = 0; i < vinc->total_rx_ch; i++)
        csic_isp_input_select(..., vinc->csi_sel, i);
}
csic_vipp_input_select(..., vinc->isp_tx_ch);
```

对你的配置：

- `isp_sel = 4`
- `total_rx_ch = 2`

就会得到：

- `VC0 -> CSI ch0 -> ISP1 input0`
- `VC1 -> CSI ch1 -> ISP1 input1`

### 10.3 最后由不同 `vinc` 选择不同 `isp_tx_ch`

如果 DTS 是：

- `vinc00`: `isp_sel=4`, `isp_tx_ch=0`
- `vinc10`: `isp_sel=4`, `isp_tx_ch=1`

那么最终路径就是：

```text
sensor VC0 -> MIPI RX ch0 -> CSI ch0 -> ISP1 input0 -> tx_ch0 -> vinc00 -> /dev/video0
sensor VC1 -> MIPI RX ch1 -> CSI ch1 -> ISP1 input1 -> tx_ch1 -> vinc10 -> /dev/video4
```

因此：

- `VC 的区分` 发生在前面的 MIPI/CSI 层
- `isp_tx_ch` 只是消费这些已经分好的路

## 11. 如果不配置 `CHANNEL_0 | CHANNEL_1`，默认会怎样

### 11.1 只配置 `CHANNEL_0` 时，VIN 只会建立 1 条有效通路

如果 sensor 只返回：

```c
cfg->flags = ... | V4L2_MBUS_CSI2_CHANNEL_0;
```

那么从 `sunxi_mipi` 和 `sunxi_csi` 的统计逻辑看：

- `total_rx_ch = 1`
- 只会有 `vc[0] = 0`

不会出现 `vc[1] = 1`。

### 11.2 这时并不是“所有 MIPI 数据都默认广播到 `tx_ch0`”

更准确的说法是：

- VIN 只建立了 1 路接收和 1 条数据通路
- 这条唯一有效的通路通常最终落在 `isp_tx_ch=0` 这一路
- `isp_tx_ch=1` 不会自动获得“未声明的 VC1 数据”

所以如果只配 `CHANNEL_0`：

- `/dev/video0` 往往能拿到数据
- `/dev/video4` 这种映射到 `isp_tx_ch=1` 的节点，通常不会自动得到第二路图像

### 11.3 这也是为什么 `isp_tx_ch` 不能代替 `CHANNEL_1`

即便你把 DTS 改成：

- `vinc00 -> isp_tx_ch=0`
- `vinc10 -> isp_tx_ch=1`

只要 sensor 没有报 `CHANNEL_1`，VIN 就不会为第二路建立真正的 RX / VC / ISP 输入映射。

## 12. 输出文件分析结论

分析对象：

- `self_driver/output_image/fb0_y13_640_960_1.bin`
- `self_driver/output_image/fb0_y13_640_960_2.bin`

### 12.1 文件尺寸

两份文件大小都为：

```text
640 * 960 * 2 = 1228800 bytes
```

也就是 `uint16` 容器的 `640x960` 帧。

### 12.2 实际有效区域

重新统计后的结果：

```text
fb0_y13_640_960_1.bin
- 元素数: 614400
- 上半 480 行 nonzero: 307200
- 下半 480 行 nonzero: 0
- 整体值域: 0..4095

fb0_y13_640_960_2.bin
- 元素数: 614400
- 上半 480 行 nonzero: 307200
- 下半 480 行 nonzero: 0
- 整体值域: 0..4095
```

这说明它们的真实结构是：

```text
buffer = 640 x 960 x 16bit

0   ~ 479 行   -> 有效单平面图像
480 ~ 959 行   -> 全 0 空洞
```

### 12.3 对输出结构的解释

因此当前输出不是：

- 不是“上半深度、下半灰度”
- 不是“VIN 已经自动把两个 VC 上下拼接”

而更像是：

- 只采到了 1 路有效图
- 剩余半帧没有被写入

这和之前“单节点大高图、后一半空”的判断是一致的。

## 13. 对“VIN 是否支持 RAW12”的补充说明

源码上看，这套 VIN 至少支持 Bayer RAW12 的 video/isp 枚举和处理分支。

### 13.1 `vin_core.c` 中有 RAW12 格式表项

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c:391-416`

```c
.name      = "RAW Bayer BGGR 12bit",
.fourcc    = V4L2_PIX_FMT_SBGGR12,
.mbus_code = MEDIA_BUS_FMT_SBGGR12_1X12,
...
.name      = "RAW Bayer RGGB 12bit",
.fourcc    = V4L2_PIX_FMT_SRGGB12,
```

### 13.2 `vin_core.c` 和 `sunxi_isp.c` 对 RAW12 都有分支

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c:704-707`

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c:666-669`

所以更准确的说法应该是：

- 这套 VIN 并非完全不支持 Bayer RAW12
- 但 ToF 的多 VC 数据类型和普通 Bayer RAW12 相机不是一回事
- vendor VIN 的多 VC 描述能力，和主线 `frame_desc / routing` 模型也并不等价

## 14. 当前方案的优点与风险

### 14.1 已被证明可行的部分

下面这套方案在框架机制上是成立的：

- DTS 同时打开 `vinc00` 和 `vinc10`
- 两者共用 `mipi1/csi1/isp4`
- `vinc00` 取 `isp_tx_ch=0`
- `vinc10` 取 `isp_tx_ch=1`
- sensor 使用 `CHANNEL_0 | CHANNEL_1`

这能实现“两个 `/dev/videoX` 分别拿两路 VC”。

### 14.2 仍然存在的主要风险

1. `kw33000_mipi.c` 仍按 `4VC` 叠高上报尺寸，这与“两路分流输出”思路不一致。
2. driver 定义了 `KW33000_VC_NUM = 4`，但当前只打开了 `VC0/VC1`，如果实际确有 `VC2/VC3`，它们仍未被接入。
3. `sunxi-vin` 的多 VC 支持是“按通道数 + 单一 mbus code”工作的，不是主线风格的多 route 描述。
4. 当前 `sensor_ioctl()` 还未完全对齐 VIN 常见调用路径。

## 15. 建议的整理方向

如果后续目标是把 `KW33000` 驱动整理成更稳定、更容易维护的版本，建议按下面顺序推进：

1. 明确 Sensor 实际输出的 VC 定义，例如 `VC0=灰度`、`VC1=深度`、`VC2/VC3=embedded/confidence` 等。
2. 如果当前项目只需要灰度和深度，可以保留两路方案，但应明确说明“只接收 VC0/VC1”。
3. 将 `kw33000_mipi.c` 中 `width/height` 改回“单 VC 真实尺寸”，不要再按 `KW33000_VC_NUM` 叠高。
4. 补齐与 VIN 交互的基础 ioctl，如 `VIDIOC_VIN_GET_SENSOR_CODE`。
5. 如果未来需要完整 4VC，并保留每路语义，则要继续评估 vendor VIN 的表达边界。

## 16. 最终结论

对于当前这套 SDK 和 `sunxi-vin` 4.9 vendor 框架：

- `ISP00~03` 应理解为逻辑 ISP0 的 4 个虚拟 ISP 通道，而不是 4 个独立 ISP；
- `ISP4` 应理解为逻辑 ISP1 的 bypass/raw path 代表节点；
- `vincX_isp_sel` 用于选择当前 `vinc` 走哪条 ISP 逻辑路径以及从哪个 ISP 输入口开始接收；
- `vincX_isp_tx_ch` 用于选择当前 `vinc` 从该 ISP 路径的哪个输出通道取数；
- 多 VC 的区分发生在前面的 `CHANNEL_n -> total_rx_ch -> vc[i]=i -> CSI ch i`；
- `isp_tx_ch` 不负责区分 VC，只负责取已经分好的那一路；
- 你当前这套 `KW33000` 的 2VC 分流方案在框架机制上是成立的；
- 但当前 driver 仍存在“多 VC 分流”和“伪装为大高图”两套建模混用的问题，后续建议统一到“单 VC 真实尺寸 + 多节点分流”的模型。

