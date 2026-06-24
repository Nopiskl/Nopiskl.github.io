
---

**User**

请你对比一下lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/imx664_mipi.c，解释一下为什么对于imx664，WDR的配置也有@imx664_mipi.c (1287-1292) ？上层会有区分吗？

---

**Cursor**

Optimizing conversation history

可以，这个问题在 `imx664_mipi.c` 里其实是能串起来的。

## 先说结论

对于 `imx664`，`WDR` 配置里之所以也有你看到的这段 `g_mbus_config()`：

```1282:1292:lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/imx664_mipi.c
static int sensor_g_mbus_config(struct v4l2_subdev *sd,
				struct v4l2_mbus_config *cfg)
{
	struct sensor_info *info = to_state(sd);

	cfg->type = V4L2_MBUS_CSI2;
	if (info->isp_wdr_mode == ISP_DOL_WDR_MODE)
		cfg->flags = 0 | V4L2_MBUS_CSI2_4_LANE | V4L2_MBUS_CSI2_CHANNEL_0 | V4L2_MBUS_CSI2_CHANNEL_1;
	else
		cfg->flags = 0 | V4L2_MBUS_CSI2_4_LANE | V4L2_MBUS_CSI2_CHANNEL_0;
```

本质原因是：

> **IMX664 的 DOL-WDR 本身就是通过同一条 MIPI CSI-2 链路输出多路 VC 数据。**  
> 所以上层必须通过 `g_mbus_config()` 知道：当前不是普通单 VC，而是 `CHANNEL_0 | CHANNEL_1`。

也就是说，这里不是“普通多 VC”专用写法，而是：

- **DOL-WDR 模式下，sensor 输出格式本来就是多 VC**
- 所以 `g_mbus_config()` 必须把这个事实告诉 VIN/CSI

---

# 一、为什么 IMX664 的 WDR 也会带 VC 配置？

因为这个驱动里，WDR 不是“单流+额外 metadata”，而是明确声明成 **`MIPI_VC_WDR_MODE + ISP_DOL_WDR_MODE`**。

看 `sensor_win_sizes[]` 里的 WDR 档位：

```1193:1218:lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/imx664_mipi.c
	//DOL HDR
	{
		.width = 2688,
		.height = 1520,
		.hoffset = 0,
		.voffset = 0,
		.hts = 750,
		.vts = 1650,
		.pclk = 74250000,
		.mipi_bps = 1188 * 1000 * 1000,
		.fps_fixed = 30,
		.bin_factor = 1,
		//.lp_mode = SENSOR_LP_DISCONTINUOUS,
		.if_mode = MIPI_VC_WDR_MODE,
		.wdr_mode = ISP_DOL_WDR_MODE,
		.intg_min = 1 << 4,
		.intg_max = (1650 - 4) << 4,
        // ...
	},
```

这里已经明说了两层含义：

- `if_mode = MIPI_VC_WDR_MODE`
  - 说明 **接口层** 是 VC 形式的 WDR
- `wdr_mode = ISP_DOL_WDR_MODE`
  - 说明 **ISP 处理语义** 是 DOL-WDR

所以对 `imx664` 来说：

> **WDR 本身就是通过多 VC 承载的。**

因此 `sensor_g_mbus_config()` 在 WDR 模式下返回：

- `V4L2_MBUS_CSI2_CHANNEL_0`
- `V4L2_MBUS_CSI2_CHANNEL_1`

这是完全一致的，不冲突。

---

# 二、上层会不会区分？

## 会，而且区分分两层：

### 1）链路/接收层区分：看 `g_mbus_config()` 返回的 CSI-2 channel flags
### 2）ISP/WDR 处理层区分：看 `wdr_mode / isp_wdr_mode`

这两层不是一回事，但会同时存在。

---

## 1）链路层区分：CSI 通过 channel flags 知道是 1VC 还是 2VC

`sunxi_csi.c` 里会根据 `cfg->flags` 去统计到底有几个 CSI2 channel：

```513:529:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-csi/sunxi_csi.c
static int sunxi_csi_s_mbus_config(struct v4l2_subdev *sd,
				   const struct v4l2_mbus_config *cfg)
{
	struct csi_dev *csi = v4l2_get_subdevdata(sd);

	if (cfg->type == V4L2_MBUS_CSI2 || cfg->type == V4L2_MBUS_SUBLVDS ||
	    cfg->type == V4L2_MBUS_HISPI) {
		csi->bus_info.bus_if = V4L2_MBUS_CSI2;
		csi->bus_info.ch_total_num = 0;
		if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_0))
			csi->bus_info.ch_total_num++;
		if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_1))
			csi->bus_info.ch_total_num++;
		if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_2))
			csi->bus_info.ch_total_num++;
		if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_3))
			csi->bus_info.ch_total_num++;
```

所以对 IMX664：

- 普通模式：只报 `CHANNEL_0` → `ch_total_num = 1`
- DOL-WDR：报 `CHANNEL_0 | CHANNEL_1` → `ch_total_num = 2`

然后这个值继续传到 VIN：

```1219:1224:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
	}
	media_entity_graph_walk_cleanup(&graph);

	csi = v4l2_get_subdevdata(pipe->sd[VIN_IND_CSI]);
	vinc->total_rx_ch = csi->bus_info.ch_total_num;
```

所以**上层接收链路 definitely 会区分**。

---

## 2）ISP 处理层区分：看 `isp_wdr_mode`

`imx664` 驱动里不仅 `g_mbus_config()` 区分，曝光控制逻辑也明确区分了 WDR 和普通模式。

例如 `sensor_s_exp()`：

```779:818:lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/imx664_mipi.c
	if (info->isp_wdr_mode == ISP_DOL_WDR_MODE) {
		// LEF
		exptime = (imx664_sensor_vts<<1) - (exp_val>>4);
		// ...
		// IMX664 SHR0
		sensor_write(sd, 0x3050, explow);
		sensor_write(sd, 0x3051, expmid);
		sensor_write(sd, 0x3052, exphigh);
		// SEF
		exp_val_m = exp_val / DOL_RATIO;
		// ...
		// IMX664 SHR1
		sensor_write(sd, 0x3054, explow);
		sensor_write(sd, 0x3055, expmid);
		sensor_write(sd, 0x3056, exphigh);
	} else {
		exptime = imx664_sensor_vts - (exp_val >> 4) - 2;
        // ...
	}
```

这里已经很清楚了：

- WDR 模式下，驱动会同时配置长曝光/短曝光寄存器
- 普通模式下，只配单曝光

所以**上层不只是“看到 2 个 VC”而已**，它还会在 sensor/ISP 配置语义上区分是不是 DOL-WDR。

---

# 三、那 `g_mbus_config()` 和 `wdr_mode` 是什么关系？

你可以把它理解成：

## `wdr_mode / isp_wdr_mode`
回答的是：
> “这是不是 WDR？如果是，属于哪种 WDR 处理模式？”

## `g_mbus_config() -> cfg->flags`
回答的是：
> “这一路 sensor 在物理 CSI-2 总线上，实际送出了几个 VC？”

对 `imx664` 而言，这两个问题的答案刚好联动：

- 若 `ISP_DOL_WDR_MODE`
- 则总线上就是 `VC0 + VC1`

所以驱动写成：

```1287:1290:lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/imx664_mipi.c
	cfg->type = V4L2_MBUS_CSI2;
	if (info->isp_wdr_mode == ISP_DOL_WDR_MODE)
		cfg->flags = 0 | V4L2_MBUS_CSI2_4_LANE | V4L2_MBUS_CSI2_CHANNEL_0 | V4L2_MBUS_CSI2_CHANNEL_1;
```

这是非常合理的。

---

# 四、`info->isp_wdr_mode` 从哪里体现“上层区分”？

`imx664` 驱动里 `sensor_info` 结构本身就有这个字段：

```86:132:lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/camera.h
struct sensor_info {
	struct v4l2_subdev sd;
    // ...
	unsigned int combo_mode;
	unsigned int time_hs;
	unsigned int deskew;
	unsigned int wdr_time_hs;
	unsigned int isp_wdr_mode;
	unsigned int magic_num;
	unsigned int lane_num;
	unsigned int bit_width;
```

而且 `sensor_ioctl()` 里也能看到，上层会拿当前窗口配置，也会下发 sensor config 请求：

```1140:1161:lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/imx664_mipi.c
	case GET_CURRENT_WIN_CFG:
		if (info->current_wins != NULL) {
			memcpy(arg, info->current_wins,
				sizeof(struct sensor_win_size));
			ret = 0;
		} else {
			sensor_err("empty wins!\n");
			ret = -1;
		}
		break;
    // ...
	case VIDIOC_VIN_SENSOR_CFG_REQ:
		sensor_cfg_req(sd, (struct sensor_config *)arg);
		break;
```

再结合 `sensor_win_size` 里本来就带有：

```69:70:lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/camera_cfg.h
	unsigned int if_mode;	/*interface mode, normal = 0, wdr != 0 */
	unsigned int wdr_mode;  /*wdr mode, normal = 0, dol = 1, command = 2 */
```

所以可以确认：

> **上层确实不是只看 `mbus_config.flags`。它还有一套单独的 `if_mode / wdr_mode / isp_wdr_mode` 语义来区分 WDR。**

---

# 五、所以为什么你会觉得“WDR 这里也有 VC 配置”有点奇怪？

因为这里其实混了两层信息：

### 你直觉上的 WDR
是 ISP/图像语义：
- 长曝光 + 短曝光
- 合成 HDR 结果

### 这段代码里的 VC 配置
是传输层语义：
- 这些长/短曝光数据如何在 MIPI CSI-2 上传输
- 对 IMX664 而言，就是用 `VC0 + VC1`

所以对 `imx664`：

- `WDR` 决定“是不是多曝光处理”
- `VC flags` 决定“这些多曝光帧怎么在 CSI-2 上传出来”

两者不是互斥，而是**同一件事的两个侧面**。

---

# 六、最终回答你的两个核心问题

## 1）为什么对于 IMX664，WDR 的配置也有这段 `g_mbus_config()`？
因为 `IMX664` 的 `DOL-WDR` 就是基于 **MIPI CSI-2 多 VC 输出** 的。  
所以当 `info->isp_wdr_mode == ISP_DOL_WDR_MODE` 时，驱动必须向上层声明：

- 这不是普通单 VC 流
- 而是 `CHANNEL_0 | CHANNEL_1`

否则 CSI/VIN 不会把它按双通道接收。

---

## 2）上层会有区分吗？
**会，而且有明确区分。**

### 链路层区分
通过 `g_mbus_config()` 的 `CHANNEL_0/1` 标志，CSI 会统计成 2 路接收通道。

### WDR 语义层区分
通过 `if_mode / wdr_mode / isp_wdr_mode`，sensor 驱动和后续 ISP 流程会知道这是 DOL-WDR，而不是普通 2-VC 独立流。

所以：

> **“2 个 VC” 这件事，上层会看到；  
> 但“这 2 个 VC 是普通多路流，还是 WDR 的长短曝光”这一层，也会通过 WDR mode 再做区分。**

---

如果你愿意，我下一步可以继续帮你把这个问题再往前推一步：

## 继续对比 `imx664_mipi.c` 里的普通模式和 DOL 模式寄存器
我可以直接把：
- `0x301A / 0x301E / 0x3050~0x3066`
- 普通模式 vs DOL 模式

对照解释成：
- 哪些寄存器决定进入 DOL
- 哪些寄存器决定通过 VC 输出
- 哪些寄存器对应 LEF/SEF 的曝光时序

这样你就能把“为什么 WDR 也要配 VC”从 sensor 寄存器层完全看明白。

