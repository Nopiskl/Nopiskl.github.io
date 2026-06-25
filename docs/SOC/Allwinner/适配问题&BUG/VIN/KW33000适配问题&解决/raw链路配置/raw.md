

---

**User**

问题1：sensor0_isp_used = <0> 与 pipeline 模式冲突
isp_used = <0> 的含义是不经过 ISP 做图像处理，期望输出 RAW 数据。但整个 pipeline 配置的是：
tdm0/isp00/scaler00 全部 work_mode = <1>（offline 模式）
在 offline 模式下，数据流强制经过 TDM→ISP→VIPP 的完整链路。vinc0_tdm_rx_sel = <0xff> 跳过 TDM 在 offline 模式下行为不确定——offline 模式的 ISP 依赖 TDM 作为数据缓冲中间件，直接跳过 TDM 会导致 ISP 无法接收数据。
问题2：sensor0_isp_used = <0> 仅控制 ISP 算法，不影响硬件路径
isp_used 只是告诉驱动是否启用 ISP 的 3A/图像处理算法（软件层面），不会绕过 ISP 硬件模块。数据仍然要经过 ISP 硬件通道，只是不做算法处理。因此即使 isp_used=0，硬件上数据依然走 ISP→VIPP→DMA。
问题3：VIPP（scaler）无法输出 RAW 格式
根据之前分析，VIPP/Scaler 的输出格式在 sunxi_scaler_subdev_s_stream 中根据像素格式选择输出模式：
case V4L2_PIX_FMT_SBGGR8/10/12:case V4L2_PIX_FMT_SGBRG8/10/12:// RAW 格式走专门路径
VIPP 硬件本身支持透传 RAW 数据，前提是上层 set_fmt 时请求 RAW 格式，且 sensor 输出必须是 RAW Bayer 格式。sensor0_fmt = <1> 表明 sensor 输出 RAW，这一点是对的。

别的agent指出这些问题，请你根据源码详细分析一下是否合理

---

**Cursor**

我来深入查看源码，逐一核实这三个问题的说法是否准确。

继续深入查看 `is_isp_used`、`support_raw`、`tdm_rx_sel=0xff` 的具体处理逻辑。

关键在于 `support_raw` 和 `sunxi_isp_sensor_type` 的实际行为，以及 `tdm_rx_sel=0xff` 时 offline 模式的路径。继续查看。

关键发现！`support_raw = inst->is_isp_used`，当 `isp_used=0` 时 `support_raw=0`。再看第 1079 行的逻辑，以及 `sunxi_isp_sensor_type` 的实现。

现在查看 `isp->use_isp` 在 ISP stream 路径中的具体作用，以及 offline 模式下 `tdm_rx_sel=0xff` 的路径。

现在查看 ISP 的 `use_isp=0` 时具体走什么路径，以及 offline 模式下 `tdm_rx_sel=0xff` 的 streamon 路径。

现在已经有了足够的源码证据，可以对三个问题逐一做出准确判断。

现在看 `__csi_isp_setup_link` 和 `tdm_rx_sel=0xff` 时的 streamon 核心路径。

现在查看 `__csi_isp_setup_link` 的完整实现，以及 `tdm_rx_sel=0xff` 时的具体 media link 连接方式。

现在再看 `SUPPORT_ISP_TDM` 宏是否在 V853 的 config 中定义，以及 `tdm_rx_sel=0xff` 时 `__csi_isp_setup_link` 在 TDM 分支中返回 -1 的问题。

现在确认 V853 的 defconfig 是否开启了 `SUPPORT_ISP_TDM`。

现在已经有了所有关键证据，可以给出完整的源码级分析。

---

## 三个问题的源码级验证结论

### 问题1："offline 模式强制走 TDM→ISP→VIPP，tdm_rx_sel=0xff 会导致 ISP 无法接收数据"

**结论：此说法对 V853/V851S 平台是错误的。**

通过 `.config` 确认：

```
# CONFIG_SUPPORT_ISP_TDM is not set
```

`SUPPORT_ISP_TDM` **未开启**。这意味着 `__csi_isp_setup_link` 走的是 `#ifndef SUPPORT_ISP_TDM` 分支，即直接建立 **CSI → ISP** 的 media link，完全不涉及 TDM：

```2212:2260:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
#ifndef SUPPORT_ISP_TDM
    /*CSI*/
    csi = vind->csi[vinc->csi_sel].sd;
    /*ISP*/
    isp = vind->isp[vinc->isp_sel].sd;
    // 直接建立 CSI -> ISP link
    link = media_entity_find_link(&csi->entity.pads[CSI_PAD_SOURCE],
                                  &isp->entity.pads[ISP_PAD_SINK]);
```

因此 `vinc0_tdm_rx_sel = <0xff>` 在这个平台上是正确且无害的——TDM 模块根本不参与数据路径。offline/online 的 `work_mode` 影响的是 VIPP DMA 的工作方式，不依赖 TDM。**问题1 的说法不适用于 V853 平台。**

---

### 问题2："isp_used=0 仅控制 ISP 算法，数据硬件上仍走 ISP→VIPP→DMA"

**结论：此说法基本正确，但需补充一个关键副作用。**

源码中有两处关联赋值：

```2554:2555:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
sunxi_isp_sensor_type(cap->pipe.sd[VIN_IND_ISP], inst->is_isp_used);
vinc->support_raw = inst->is_isp_used;
```

当 `isp_used=0` 时：
- `isp->use_isp = 0`，ISP 的 `s_stream` 回调在各处都做了 `if (!isp->use_isp) return 0` 的短路返回，ISP 硬件寄存器不被配置，ISP 以 bypass 透传模式运行
- **但同时 `support_raw = 0`**

`support_raw=0` 带来了一个致命问题，见第 1079 行：

```1079:1080:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
if ((mask & VIN_FMT_YUV) && (vinc->support_raw == 0))
    mask = VIN_FMT_YUV;
```

这段逻辑的含义是：当 `support_raw=0` 且应用请求 YUV 格式时，强制 mask 为 `VIN_FMT_YUV`。看起来对 RAW 格式无影响。但更严重的问题在于，`vin_find_format` 用 `mask` 过滤格式表，当你请求 `V4L2_PIX_FMT_SBGGR12` 时，`mask` 传入的是 `VIN_FMT_RAW`，不受 `support_raw` 影响，因此 RAW 格式查找不受此限制。

**ISP bypass 路径是可用的，数据确实经过 ISP 硬件但不做处理，直达 VIPP/DMA 输出 RAW。**

---

### 问题3："VIPP/Scaler 无法输出 RAW 格式，前提是上层请求 RAW"

**结论：此说法正确，VIPP 支持 RAW 透传，当前配置也满足前提条件。**

源码中 VIPP 对 `V4L2_PIX_FMT_SBGGR12` 有明确的处理路径：

```6347:6348:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
case V4L2_PIX_FMT_SBGGR12:
```

以及 ISP s_stream 中对 RAW 格式的处理（`use_isp=1` 时）：

```654:680:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
if (!isp->use_isp)
    return 0;

case V4L2_PIX_FMT_SBGGR12:
    vin_log(VIN_LOG_FMT, "%s output fmt is raw, return directly\n", __func__);
    return 0;  // RAW 格式直接返回，不做ISP处理
```

即便 `use_isp=1`，只要输出格式是 RAW，ISP 也直接返回不处理。**`sensor0_fmt=<1>` + `MEDIA_BUS_FMT_SBGGR12_1X12` + `csi_test_mplane mode=13` 的组合是完全正确的路径。**

---

## 综合总结

| 问题 | 原始说法 | 源码验证结论 |
|---|---|---|
| 问题1：offline+tdm_rx_sel=0xff 冲突 | 说有问题 | **无问题**，V853 未启用 `SUPPORT_ISP_TDM`，CSI 直连 ISP，TDM 不参与 |
| 问题2：isp_used=0 只控制算法 | 基本正确 | 正确，但还导致 `support_raw=0`，需确认不影响 RAW 格式请求路径（经分析不影响） |
| 问题3：VIPP 支持 RAW 输出 | 正确 | 正确，`SBGGR12` 有完整硬件路径支持 |

**当前最需要做的一件事**：将 `mbus_code` 从 `MEDIA_BUS_FMT_Y12_1X12` 改为 `MEDIA_BUS_FMT_SBGGR12_1X12`，这是 `vin is not support this pixelformat` 报错的直接原因，修复后用 `mode=13` 运行 `csi_test_mplane` 应能正常采集到 RAW 数据。

```plaintext
# CONFIG_SUPPORT_ISP_TDM is not set
```

```c
#ifndef SUPPORT_ISP_TDM
    /*CSI*/
    csi = vind->csi[vinc->csi_sel].sd;
    /*ISP*/
    isp = vind->isp[vinc->isp_sel].sd;
    // 直接建立 CSI -> ISP link
    link = media_entity_find_link(&csi->entity.pads[CSI_PAD_SOURCE],
                                  &isp->entity.pads[ISP_PAD_SINK]);
```

```c
sunxi_isp_sensor_type(cap->pipe.sd[VIN_IND_ISP], inst->is_isp_used);
vinc->support_raw = inst->is_isp_used;
```

```c
if ((mask & VIN_FMT_YUV) && (vinc->support_raw == 0))
    mask = VIN_FMT_YUV;
```

```c
case V4L2_PIX_FMT_SBGGR12:
```

```c
if (!isp->use_isp)
    return 0;

case V4L2_PIX_FMT_SBGGR12:
    vin_log(VIN_LOG_FMT, "%s output fmt is raw, return directly\n", __func__);
    return 0;  // RAW 格式直接返回，不做ISP处理
```

