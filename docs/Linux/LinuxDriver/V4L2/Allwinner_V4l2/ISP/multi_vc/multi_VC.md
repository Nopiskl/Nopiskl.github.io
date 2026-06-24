
---

**User**

官方给出的示例如下
此场景为典型 CDR 场景，1 路 MIPI/DVP 输入（YUV）4 路输出，其中输入源是 1 个转换芯片
（MIPI/DVP），这个转换芯片连接了 4 个后拉摄像头；这个场景 TDM 关闭、ISP0、VIPP0 和
DMA0、VIPP1 和 DMA1、VIPP2 和 DMA2、VIPP3 和 DMA3
vnc00:vinc@0 { // 对应软件上的 video0 结点，vinc@0/4/8/12 配置一致
vinc0_csi_sel = <2>; // 配置 CSI0 通道
vinc0_mipi_sel = <0xff>; // 配置 MIPI0 通道
vinc0_isp_sel = <4>; // 选择 ISP0 通道
vinc0_isp_tx_ch = <0>; // 表示第一路后拉摄像头数据源
vinc0_tdm_rx_sel = <0xff>; // 关闭 TDM 配置
vinc0_rear_sensor_sel = <0>; // 选择 Sensor0 作为数据来源
vinc0_front_sensor_sel = <0>; // 选择 Sensor0 作为数据来源
vinc0_sensor_list = <0>;
work_mode = <0x0>; // 配置在线模式
status = "okay";
};
vinc10:vinc@4 { // 对应软件上的 video4 结点
vinc4_csi_sel = <2>;
vinc4_mipi_sel = <0xff>;
vinc4_isp_sel = <4>;
vinc4_isp_tx_ch = <1>; // 表示第二路后拉摄像头数据源
vinc4_tdm_rx_sel = <0xff>;
vinc4_rear_sensor_sel = <0>;
vinc4_front_sensor_sel = <0>;
vinc4_sensor_list = <0>;
work_mode = <0x0>;
status = "okay";
};
vinc20:vinc@8 { // 对应软件上的 video8 结点
vinc8_csi_sel = <2>;
vinc8_mipi_sel = <0xff>;
vinc8_isp_sel = <4>;
vinc8_isp_tx_ch = <2>; // 表示第三路后拉摄像头数据源
vinc8_tdm_rx_sel = <0xff>;
vinc8_rear_sensor_sel = <0>;
vinc8_front_sensor_sel = <0>;
vinc8_sensor_list = <0>;
work_mode = <0x0>;
status = "okay";
};
vinc30:vinc@12 { // 对应软件上的 video12 结点
vinc12_csi_sel = <2>;
vinc12_mipi_sel = <0xff>;
vinc12_isp_sel = <4>;
vinc12_isp_tx_ch = <3>; // 表示第四路后拉摄像头数据源
vinc12_tdm_rx_sel = <0xff>;
vinc12_rear_sensor_sel = <0>;
vinc12_front_sensor_sel = <0>;
vinc12_sensor_list = <0>;
work_mode = <0x0>;
status = "okay";
};
请你结合具体驱动源码分析一下，为什么驱动中声明V4L2_MBUS_CSI2_CHANNEL_0 | V4L2_MBUS_CSI2_CHANNEL_1就可以让 VIN 框架会把它当成 2 路 CSI-2 VC 来配置，而不是 1 路？分离后的两路数据会怎样在VIN的统领下通过CSI MIPI 到TDM最后到ISP的？

---

**Cursor**

可以。结合源码，结论其实很清楚：

## 先说结论

如果传感器驱动在 `g_mbus_config()` 里声明：

```c
V4L2_MBUS_CSI2_CHANNEL_0 | V4L2_MBUS_CSI2_CHANNEL_1
```

那么 VIN 框架之所以会把它当成 **2 路 CSI-2 VC**，不是因为它“猜测”了有 2 路，而是因为：

1. **sensor 的 `g_mbus_config()` 把这个能力显式告诉了上层**
2. `vin_video.c` 会把这个 `mcfg` 原样下发给 `MIPI` 和 `CSI`
3. `sunxi_mipi.c` / `sunxi_csi.c` 会根据这些 `CHANNEL_x` 标志去**计数**
4. `vin_video.c` 再把 `csi->bus_info.ch_total_num` 赋给 `vinc->total_rx_ch`
5. `vin.c` 在开流时根据 `vinc->total_rx_ch` 循环配置 `csic_isp_input_select(...)`

所以，**`CHANNEL_0 | CHANNEL_1` 最终会变成 `total_rx_ch = 2`，从而按 2 路来配 CSI/ISP 路由。**

---

# 1）VIN 是从哪里知道“有几路 VC”的？

关键入口在 sensor 的 `g_mbus_config()`。

你当前自己的 `kw33000_mipi.c` 里实际上还是只声明了 `CHANNEL_0`：

```987:993:self_driver/new_version/kw33000_mipi.c
static int sensor_g_mbus_config(struct v4l2_subdev *sd,
				struct v4l2_mbus_config *cfg)
{
	cfg->type  = V4L2_MBUS_CSI2;
	cfg->flags = 0 | V4L2_MBUS_CSI2_1_LANE | V4L2_MBUS_CSI2_CHANNEL_0;
	return 0;
}
```

所以**按你当前这份驱动，VIN 只会把它当成 1 路 CSI-2 channel**，不会当成 2 路。

---

## 如果你改成这样：

```c
cfg->flags = V4L2_MBUS_CSI2_1_LANE |
             V4L2_MBUS_CSI2_CHANNEL_0 |
             V4L2_MBUS_CSI2_CHANNEL_1;
```

那么 VIN 框架就会按 2 路处理。

---

# 2）这个 `mcfg` 是怎么传到 VIN 里的？

`vin_video.c` 在 pipeline 配置时，先向 sensor 取 `g_mbus_config()`，然后把结果下发给整条链上的 MIPI 和 CSI：

```1192:1222:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
static int vin_pipeline_set_mbus_config(struct vin_core *vinc)
{
	struct vin_pipeline *pipe = &vinc->vid_cap.pipe;
	struct v4l2_subdev *sd = pipe->sd[VIN_IND_SENSOR];
	struct v4l2_mbus_config mcfg;
	// ...

	ret = v4l2_subdev_call(sd, video, g_mbus_config, &mcfg);
	if (ret < 0) {
		vin_err("%s g_mbus_config error!\n", sd->name);
		goto out;
	}
	/* s_mbus_config on all mipi and csi */
	// ...
		if ((sd == pipe->sd[VIN_IND_MIPI]) ||
		    (sd == pipe->sd[VIN_IND_CSI])) {
			ret = v4l2_subdev_call(sd, video, s_mbus_config, &mcfg);
```

也就是说：

- sensor 决定 `mcfg.flags`
- mipi/csi 根据这个 `flags` 去配置自己

---

# 3）为什么 `CHANNEL_0 | CHANNEL_1` 会变成“2 路”？

因为 `MIPI` 和 `CSI` 驱动里都在**直接数这些 bit**。

---

## 3.1 MIPI 里：把 `CHANNEL_x` 转成 `total_rx_ch`

`sunxi_mipi.c`：

```860:877:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c
	mipi->csi2_cfg.total_rx_ch = 0;
	mipi->cmb_csi_cfg.total_rx_ch = 0;
	if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_0)) {
		mipi->csi2_cfg.total_rx_ch++;
		mipi->cmb_csi_cfg.total_rx_ch++;
	}
	if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_1)) {
		mipi->csi2_cfg.total_rx_ch++;
		mipi->cmb_csi_cfg.total_rx_ch++;
	}
	if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_2)) {
		mipi->csi2_cfg.total_rx_ch++;
		mipi->cmb_csi_cfg.total_rx_ch++;
	}
	if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_3)) {
		mipi->csi2_cfg.total_rx_ch++;
		mipi->cmb_csi_cfg.total_rx_ch++;
	}
```

这段是最直接的证据：

- 有 `CHANNEL_0`，加 1
- 再有 `CHANNEL_1`，再加 1

所以：
- `CHANNEL_0` → `total_rx_ch = 1`
- `CHANNEL_0 | CHANNEL_1` → `total_rx_ch = 2`

并且 MIPI 初始化时还会把这个 `total_rx_ch` 下发给底层 combo/mipi 端口配置：

你前面搜到的调用就是：

- `cmb_port_mipi_set_field(mipi->id, mipi->cmb_csi_cfg.total_rx_ch, &mipi->cmb_csi_cfg);`

这说明 **MIPI 接收端也会按“总接收通道数”来配置。**

---

## 3.2 CSI parser 里：同样数一次 `CHANNEL_x`

`sunxi_csi.c`：

```513:526:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-csi/sunxi_csi.c
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

这里又做了一遍相同逻辑：

- `cfg->flags` 里声明几个 `CHANNEL_x`
- `csi->bus_info.ch_total_num` 就是几路

---

## 3.3 最终落到 `vinc->total_rx_ch`

`vin_video.c`：

```1223:1225:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
	csi = v4l2_get_subdevdata(pipe->sd[VIN_IND_CSI]);
	vinc->total_rx_ch = csi->bus_info.ch_total_num;
	vinc->vid_cap.frame.fmt.mbus_type = mcfg.type;
```

这就把“sensor 声明的多 VC”最终落到 `vinc` 里了。

所以**VIN 并不是直接理解 `CHANNEL_0|CHANNEL_1` 的语义，而是通过 MIPI/CSI 统计后，得到 `total_rx_ch=2`。**

---

# 4）为什么 `total_rx_ch=2` 后，VIN 就会按两路去配？

关键在开流时 `vin.c` 的路由配置。

```1018:1040:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
#if defined (CONFIG_ARCH_SUN8IW21P1)
		if (vinc->large_image == 3) {
			// ...
		} else {
			if ((vinc->csi_ch != 0xff) && (vinc->csi_ch & 0x10))
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, vinc->csi_ch & 0xf);
			else {
				for (i = 0; i < vinc->total_rx_ch; i++)
					csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + i, vinc->csi_sel, i);
			}
		}
		csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
#endif
```

这里最重要的是这个循环：

```c
for (i = 0; i < vinc->total_rx_ch; i++)
    csic_isp_input_select(..., ..., ..., vinc->csi_sel, i);
```

如果：
- `total_rx_ch = 1`，只配 `i = 0`
- `total_rx_ch = 2`，就配 `i = 0, 1`
- `total_rx_ch = 4`，就配 `i = 0, 1, 2, 3`

所以 `CHANNEL_0 | CHANNEL_1` 最终就会让 VIN 框架把 **parser channel 0 和 1** 都接到 ISP 这一侧去。

---

# 5）这说明了什么？

说明 VIN 的“多 VC 处理”逻辑本质上是：

## 不是“看到了一个大图，猜测里面其实有两路”
而是：

## “sensor 明确告诉我支持 VC0/VC1，于是我把 parser 的 0/1 通道都打开，并把它们路由到后级”

也就是说，**多 VC 是通过 `mbus_config.flags` 显式声明出来的能力**，而不是后端自动识别。

---

# 6）分离后的两路数据，怎么走到后面？

你问的核心是：

> 分离后的两路数据会怎样在 VIN 的统领下通过 CSI MIPI 到 TDM 最后到 ISP？

这里要分两种情况。

---

## 情况 A：像你给的官方 CDR 示例，`TDM` 关闭

官方例子里：

- `vinc*_tdm_rx_sel = <0xff>;`

这表示 **不走 TDM**。

源码里 `vin_core.c` 的调试路径打印也明确区分了这两种链路：

### 不走 TDM：
```1680:1688:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c
		if (vinc->tdm_rx_sel == 0xff) {
			count += scnprintf(buf + count, size - count, "vi%u:\n%s => csi%d => isp%d => vipp%d\n",
				vinc->id, vinc->vid_cap.pipe.sd[VIN_IND_SENSOR]->name,
				vinc->csi_sel, vinc->isp_sel, vinc->vipp_sel);
		} else {
			count += scnprintf(buf + count, size - count, "vi%u:\n%s => csi%d => tdm_rx%d => isp%d => vipp%d\n",
```

### 走 MIPI 且不走 TDM：
```1692:1700:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c
		if (vinc->tdm_rx_sel == 0xff) {
			count += scnprintf(buf + count, size - count, "vi%u:\n%s => mipi%d => csi%d => isp%d => vipp%d\n",
				vinc->id, vinc->vid_cap.pipe.sd[VIN_IND_SENSOR]->name,
				vinc->mipi_sel, vinc->csi_sel, vinc->isp_sel, vinc->vipp_sel);
		} else {
			count += scnprintf(buf + count, size - count, "vi%u:\n%s => mipi%d => csi%d => tdm_rx%d => isp%d => vipp%d\n",
```

所以**官方那个 1 路输入 4 路输出的 YUV CDR 场景**，真实链路是：

```text
sensor/转换芯片
  -> MIPI
  -> CSI parser
  -> ISP4(bypass)
  -> VIPP0/1/2/3
  -> DMA0/1/2/3
  -> video0/4/8/12
```

这里 **TDM 是关闭的**，不是必须经过 TDM。

---

## 情况 B：开启 TDM 时

media link 创建时，VIN 框架会根据 `tdm_rx_sel` 判断是否插入 TDM：

```772:801:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
#ifdef SUPPORT_ISP_TDM
		/*tdm*/
		if (vinc->tdm_rx_sel == 0xff)
			tdm_rx = NULL;
		else
			tdm_rx = vind->tdm[vinc->tdm_rx_sel/TDM_RX_NUM].tdm_rx[vinc->tdm_rx_sel].sd;
		/*isp*/
		if (vinc->isp_sel == 0xff)
			isp = NULL;
		else
			isp = vind->isp[vinc->isp_sel].sd;

		if (tdm_rx != NULL) {
			source = &csi->entity;
			sink = &tdm_rx->entity;
            // csi -> tdm_rx

			source = &tdm_rx->entity;
			sink = &isp->entity;
            // tdm_rx -> isp
		} else {
			source = &csi->entity;
			sink = &isp->entity;
            // csi -> isp
		}
#endif
```

这就很明确了：

- `tdm_rx_sel == 0xff` → `CSI -> ISP`
- `tdm_rx_sel != 0xff` → `CSI -> TDM_RX -> ISP`

---

# 7）那么“2 路 VC”时，数据在链路中的真实流向是什么？

如果 sensor 驱动声明：

```c
CHANNEL_0 | CHANNEL_1
```

那么链路语义是：

## 第一步：MIPI 接收端
MIPI D-PHY / CSI-2 Receiver 接收所有 packet，其中包含：
- VC0 的数据包
- VC1 的数据包

`sunxi_mipi.c` 根据 `cfg->flags` 知道总共有 2 路 RX channel，要按 2 路方式开接收。

---

## 第二步：CSI parser
`sunxi_csi.c` 把 `ch_total_num` 配成 2。  
随后 `vin.c` 在开流时会做：

- `csic_isp_input_select(... ch=0)`
- `csic_isp_input_select(... ch=1)`

也就是把 **parser channel 0 / 1** 分别接入后面的 ISP 路由。

---

## 第三步：是否进 TDM
- 若 `tdm_rx_sel == 0xff`：直接进 ISP/bypass ISP
- 若 `tdm_rx_sel != 0xff`：先进入 TDM，再由 TDM 输出给 ISP

但这里要强调：

### 对你给的官方 CDR 示例
**TDM 是关闭的**，所以路径不是：
`MIPI -> CSI -> TDM -> ISP`

而是：
`MIPI -> CSI -> ISP4(bypass) -> VIPP/DMA`

---

## 第四步：ISP / bypass ISP
之后 `isp_sel` 决定挂到哪个 ISP 节点：

- `0~3`：正常 ISP 分时复用节点
- `4`：bypass ISP

---

## 第五步：VIPP 取哪一路
最后：

```1038:1039:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		}
		csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
```

这里 `isp_tx_ch` 决定：

> 当前这个 `vinc/videoX` 从选定 ISP 组里的哪一路 channel 取数据

所以在 CDR / 多 VC 场景里：

- `isp_tx_ch = 0` → 取 VC0 / 第一后拉
- `isp_tx_ch = 1` → 取 VC1 / 第二后拉
- ...

---

# 8）为什么官方例子里 `isp_sel=4`，`isp_tx_ch=0/1/2/3`？

因为那个场景本质上是 **1 路 MIPI/DVP 输入，内部复用了 4 路子流**。

所以：

- `isp_sel = 4`：选 bypass ISP 这条旁路链
- `isp_tx_ch = 0/1/2/3`：选这 4 路子流中的哪一路给当前 `vinc`

这和你前面理解是一致的：

- `isp_sel`：选节点/路径
- `isp_tx_ch`：选该路径下的子通道/子源

---

# 9）一个非常重要的纠偏：你当前 `kw33000` 代码其实**还没告诉 VIN 有 2 路 VC**

你现在 `kw33000_mipi.c` 里是：

```987:993:self_driver/new_version/kw33000_mipi.c
static int sensor_g_mbus_config(struct v4l2_subdev *sd,
				struct v4l2_mbus_config *cfg)
{
	cfg->type  = V4L2_MBUS_CSI2;
	cfg->flags = 0 | V4L2_MBUS_CSI2_1_LANE | V4L2_MBUS_CSI2_CHANNEL_0;
	return 0;
}
```

并且你的注释写的是：

```960:963:self_driver/new_version/kw33000_mipi.c
/*
 * KW33000: 672x496 per VC, 4 VCs bundled vertically => 672x1984 @20fps
 * 1-lane MIPI CSI-2. Adjust pclk/mipi_bps/hts/vts to match hardware.
 */
```

这两者其实有点冲突：

- 注释说“4 VCs bundled vertically”
- 但 `g_mbus_config()` 只上报了 `CHANNEL_0`

这意味着 **当前 VIN 框架并不会把它当成 4 路 VC 输入来拆**。  
它会把它看成 **1 路 CSI-2 stream**。

所以如果你想让 VIN 走“多 VC 配置逻辑”，仅仅 sensor 实际输出多 VC 还不够，**驱动还必须在 `g_mbus_config()` 正确声明这些 `CHANNEL_x`。**

---

# 10）最终归纳成一句话

## 为什么声明 `V4L2_MBUS_CSI2_CHANNEL_0 | V4L2_MBUS_CSI2_CHANNEL_1` 就会被当成 2 路？
因为 VIN 框架会把这个 `flags` 传给 MIPI/CSI，后者在 `s_mbus_config()` 里直接按 `CHANNEL_x` bit 个数统计 `total_rx_ch/ch_total_num`，最终 `vinc->total_rx_ch = 2`，开流时按 2 路去配置 `csic_isp_input_select()`。

---

## 两路数据怎么走？
在 V853 上：

### TDM 关闭时
```text
Sensor -> MIPI -> CSI(parser ch0/ch1) -> ISP/ISP4(bypass) -> VIPP -> DMA -> videoX
```

### TDM 开启时
```text
Sensor -> MIPI -> CSI(parser ch0/ch1) -> TDM_RX -> ISP -> VIPP -> DMA -> videoX
```

---

如果你愿意，我下一步可以继续帮你把这件事做得更落地一点：

1. **直接基于你的 `kw33000_mipi.c`，给出“改成 2VC / 4VC”的最小修改点**
2. **继续往下追 parser 寄存器/TDM 寄存器，看看 VC0/VC1 最后分别落到哪些硬件选择寄存器上**

---

**User**

请基于你的分析，结合具体源码帮我分析一下
1、多VC配置和多sensor配置有什么区别？
2、声明CHANNEL_0 | CHANNEL_1变成两路以后，驱动配置具体比单channel多在什么地方？

---

**Cursor**

可以，这两个问题其实正好能把 `multi-VC` 和 `multi-sensor` 的本质差异说清楚。

我先给结论，再结合源码展开。

---

# 结论先说

## 1）多 VC 配置和多 sensor 配置的区别

### 多 VC 配置
是 **同一个 sensor / 同一个 MIPI 链路 / 同一个 CSI 输入** 上，携带多个 CSI-2 Virtual Channel 数据流。  
在 VIN 框架里，它主要体现为：

- `sensor -> g_mbus_config()` 里声明多个 `V4L2_MBUS_CSI2_CHANNEL_X`
- `MIPI/CSI` 根据这些 bit 统计出 `total_rx_ch / ch_total_num`
- `VIN` 再根据 `total_rx_ch` 把 **同一个 csi_sel** 下的多个 parser channel 接到后级

也就是说，**多 VC 是“一个来源，多路子流”**。

---

### 多 sensor 配置
是 **多个独立 sensor 实体**，每个 sensor 作为单独的 V4L2 subdev 出现在 media graph 里。  
在 VIN 框架里，它主要体现为：

- DTS 里有多个 `sensor@x`
- 每个 `vincX` 通过 `rear_sensor_sel/front_sensor_sel` 选自己的 sensor
- VIN 建链时把不同 sensor 分别 link 到对应 mipi/csi
- 本质上是 **多个来源，多个独立前端实体**

也就是说，**多 sensor 是“多个来源”**，不是一个来源里的多个 VC。

---

## 2）`CHANNEL_0 | CHANNEL_1` 变成两路后，驱动比单 channel 多配置了什么？

核心只多了两类配置：

### A. MIPI/CSI 的“接收通道数”从 1 变 2
- `sunxi_mipi.c` 里 `total_rx_ch++`
- `sunxi_csi.c` 里 `ch_total_num++`

### B. VIN 开流时不再只配置一个 parser/ISP 输入，而是循环配置两路
- 单 channel：只配 `ch=0`
- 双 channel：会配 `ch=0` 和 `ch=1`

换句话说：

> `CHANNEL_0 | CHANNEL_1` 并不会凭空多出一个 sensor，也不会多出一个 mipi 端口；  
> 它只是让同一条 CSI-2 输入路径被 VIN 当成“2 路接收子通道”来配置。

---

---

# 一、先看多 VC 是怎么进框架的

你当前自己的 sensor 驱动里是这样：

```987:993:self_driver/new_version/kw33000_mipi.c
static int sensor_g_mbus_config(struct v4l2_subdev *sd,
				struct v4l2_mbus_config *cfg)
{
	cfg->type  = V4L2_MBUS_CSI2;
	cfg->flags = 0 | V4L2_MBUS_CSI2_1_LANE | V4L2_MBUS_CSI2_CHANNEL_0;
	return 0;
}
```

如果你改成：

```c
cfg->flags = V4L2_MBUS_CSI2_1_LANE |
             V4L2_MBUS_CSI2_CHANNEL_0 |
             V4L2_MBUS_CSI2_CHANNEL_1;
```

那 VIN 才会把它理解成两路 CSI-2 channel。

---

`vin_video.c` 会先从 sensor 取这个配置，再下发给整条链路上的 MIPI 和 CSI：

```1192:1225:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
static int vin_pipeline_set_mbus_config(struct vin_core *vinc)
{
	struct vin_pipeline *pipe = &vinc->vid_cap.pipe;
	struct v4l2_subdev *sd = pipe->sd[VIN_IND_SENSOR];
	struct v4l2_mbus_config mcfg;
	// ...

	ret = v4l2_subdev_call(sd, video, g_mbus_config, &mcfg);
	// ...

	while ((me = media_entity_graph_walk_next(&graph)) &&
		me != &vinc->vid_cap.subdev.entity) {
		sd = media_entity_to_v4l2_subdev(me);
		if ((sd == pipe->sd[VIN_IND_MIPI]) ||
		    (sd == pipe->sd[VIN_IND_CSI])) {
			ret = v4l2_subdev_call(sd, video, s_mbus_config, &mcfg);
```

最后：

```1223:1225:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
	csi = v4l2_get_subdevdata(pipe->sd[VIN_IND_CSI]);
	vinc->total_rx_ch = csi->bus_info.ch_total_num;
	vinc->vid_cap.frame.fmt.mbus_type = mcfg.type;
```

所以：

- 多 VC 的入口在 `g_mbus_config.flags`
- 最后落到 `vinc->total_rx_ch`

---

# 二、多 VC 和多 sensor 的根本区别

---

## 1. 多 VC：一个 sensor subdev，多个 CSI-2 channel bit

多 VC 的本质是：

- `sensor` 还是**一个**
- `mipi_sel` 还是**一个**
- `csi_sel` 还是**一个**
- 只是 `cfg->flags` 里声明多个 `CHANNEL_X`

也就是：

```text
1个 sensor
 -> 1条 MIPI
 -> 1个 CSI parser
 -> 内部有多个 VC/channel
```

在 `sunxi_mipi.c` 里，它只是按 `CHANNEL_X` 去累加接收通道数：

```860:877:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-mipi/sunxi_mipi.c
	mipi->csi2_cfg.total_rx_ch = 0;
	mipi->cmb_csi_cfg.total_rx_ch = 0;
	if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_0)) {
		mipi->csi2_cfg.total_rx_ch++;
		mipi->cmb_csi_cfg.total_rx_ch++;
	}
	if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_1)) {
		mipi->csi2_cfg.total_rx_ch++;
		mipi->cmb_csi_cfg.total_rx_ch++;
	}
	if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_2)) {
		mipi->csi2_cfg.total_rx_ch++;
		mipi->cmb_csi_cfg.total_rx_ch++;
	}
	if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_3)) {
		mipi->csi2_cfg.total_rx_ch++;
		mipi->cmb_csi_cfg.total_rx_ch++;
	}
```

CSI 也是一样：

```513:526:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-csi/sunxi_csi.c
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

你可以看出，这里根本没有“多个 sensor”的概念，只是在统计 **同一条 CSI2 输入里有几个 channel**。

---

## 2. 多 sensor：多个 sensor subdev，多个来源选择

多 sensor 则完全不同。  
DTS 里就是多个独立 sensor 节点，比如：

```1600:1635:lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi
			sensor0:sensor@0 {
				device_type = "sensor0";
				compatible = "allwinner,sunxi-sensor";
				// ...
				device_id = <0>;
				status	= "okay";
			};
			sensor1:sensor@1 {
				device_type = "sensor1";
				compatible = "allwinner,sunxi-sensor";
				// ...
				device_id = <1>;
				status	= "okay";
			};
```

而某个 `vinc` 通过 DTS 属性选它要绑定哪个 sensor：

```1659:1671:lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi
			vinc00:vinc@0 {
				device_type = "vinc0";
				compatible = "allwinner,sunxi-vin-core";
				// ...
				vinc0_rear_sensor_sel = <0>;
				vinc0_front_sensor_sel = <0>;
				vinc0_sensor_list = <0>;
```

VIN probe 时也把这些属性读进来：

```2268:2278:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c
	sprintf(property_name, "vinc%d_rear_sensor_sel", pdev->id);
	if (of_property_read_u32(np, property_name, &vinc->rear_sensor))
		vinc->rear_sensor = 0;

	sprintf(property_name, "vinc%d_front_sensor_sel", pdev->id);
	if (of_property_read_u32(np, property_name, &vinc->front_sensor))
		vinc->front_sensor = 1;
```

之后建链时，把选中的 sensor link 到 mipi/csi：

```1778:1787:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
			module = &vind->modules[vinc->rear_sensor];
			sensor_link_to_mipi_csi(module, csi);
			if (vinc->rear_sensor != vinc->front_sensor) {
				module = &vind->modules[vinc->front_sensor];
				sensor_link_to_mipi_csi(module, csi);
			}
```

所以多 sensor 的关键是：

- 多个 `sensor@x`
- `rear_sensor_sel/front_sensor_sel`
- media graph 上有多个前端实体

这和多 VC 完全不是同一个层次。

---

## 所以一句话总结差异

### 多 VC
是 **一个 sensor subdev 里声明多个 CSI-2 channel**

### 多 sensor
是 **多个 sensor subdev 被 DTS 和 media graph 分别管理**

---

# 三、`CHANNEL_0 | CHANNEL_1` 变两路以后，比单 channel 具体多了什么配置？

这是第二个问题的重点。

---

## 单 channel 时

如果 sensor 只声明：

```c
V4L2_MBUS_CSI2_CHANNEL_0
```

那么：

- `mipi->total_rx_ch = 1`
- `csi->ch_total_num = 1`
- `vinc->total_rx_ch = 1`

开流时在 `vin.c` 中：

```1013:1040:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		} else {
			if ((vinc->csi_ch != 0xff) && (vinc->csi_ch & 0x10))
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, vinc->csi_ch & 0xf);
			else {
				for (i = 0; i < vinc->total_rx_ch; i++)
					csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + i, vinc->csi_sel, i);
			}
		}
```

这时循环只执行一次：

- `i = 0`

所以只会配置：

- `csic_isp_input_select(..., ch = 0)`

---

## 双 channel 时

如果声明：

```c
CHANNEL_0 | CHANNEL_1
```

那么：

- `mipi->total_rx_ch = 2`
- `csi->ch_total_num = 2`
- `vinc->total_rx_ch = 2`

于是开流时上面这个循环执行两次：

- `i = 0`
- `i = 1`

也就是会额外多出一次：

- `csic_isp_input_select(..., ch = 1)`

---

## 换句话说，具体“多配置”的地方有两个

---

### 1）MIPI / CSI 的通道数量统计多了

#### MIPI 多配了 `total_rx_ch`
原来 1 路时：
- `total_rx_ch = 1`

变 2 路后：
- `total_rx_ch = 2`

而且这个值会继续用于 MIPI 硬件端配置。

---

### 2）VIN 路由多配了 1 组 parser->ISP 输入映射

单通道：

```text
parser ch0 -> isp input 0
```

双通道：

```text
parser ch0 -> isp input 0
parser ch1 -> isp input 1
```

这正是这段循环的意义：

```1018:1037:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		} else {
			if ((vinc->csi_ch != 0xff) && (vinc->csi_ch & 0x10))
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, vinc->csi_ch & 0xf);
			else {
				for (i = 0; i < vinc->total_rx_ch; i++)
					csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + i, vinc->csi_sel, i);
			}
		}
```

---

# 四、哪些地方没有变化？

这个也很重要。

声明 `CHANNEL_0 | CHANNEL_1` 以后，**并不会**自动多出这些东西：

- 不会多一个 sensor 节点
- 不会多一个 mipi 端口
- 不会多一个 csi 控制器
- 不会自动多一个 `vinc`
- 不会自动多一个 `videoX`

也就是说，多 VC 只是让**同一条输入链路**被按多路 channel 来接收和路由。

要想最终变成多路 video 设备，你还得结合：
- 多个 `vinc`
- 不同的 `isp_tx_ch`
- 或者不同的 `csi_ch/tdm_rx_sel`
- 或官方那种 `isp_sel = 4` + `isp_tx_ch = 0/1/2/3`

---

# 五、用“多 VC”和“多 sensor”对比着看，最容易明白

---

## 多 VC 场景
```text
1个 sensor
  -> 1个 MIPI
  -> 1个 CSI
  -> 2个/4个 VC 子流
  -> VIN 用 total_rx_ch 按多路配置
```

关键配置在：
- `g_mbus_config.flags = CHANNEL_0 | CHANNEL_1 ...`

---

## 多 sensor 场景
```text
sensor0
sensor1
sensor2
  -> 各自独立作为 subdev 存在
  -> vinc 通过 rear/front_sensor_sel 选择绑定哪个
```

关键配置在：
- `sensor0/sensor1/...`
- `vincX_rear_sensor_sel`
- `vincX_front_sensor_sel`

---

# 六、把第二个问题再压缩成一句最直接的话

> 声明 `CHANNEL_0 | CHANNEL_1` 以后，驱动具体比单 channel 多在哪里？

最直接的回答就是：

1. `sunxi_mipi_s_mbus_config()` 中多把 `total_rx_ch` 从 1 计到 2  
2. `sunxi_csi_s_mbus_config()` 中多把 `ch_total_num` 从 1 计到 2  
3. `vin_pipeline_set_mbus_config()` 中把 `vinc->total_rx_ch` 设为 2  
4. `vin.c` 开流时 `for (i = 0; i < vinc->total_rx_ch; i++)` 从跑 1 次变成跑 2 次，因此多配置了一路 `csic_isp_input_select(..., ch=1)`

---

如果你愿意，我下一步可以继续帮你做两件很实用的事：

1. **直接按你的 `kw33000_mipi.c` 给出“改成 2VC/4VC”的具体修改建议**
2. **继续顺着 parser 寄存器看 `ch=0/ch=1` 分别写到了哪几个寄存器地址**，把“多出来的那一路配置”落到寄存器级别讲清楚。

---

**User**

请你继续跟进以下，相比于单sensor单channel来说，声明 CHANNEL_0 | CHANNEL_1 以后，TDM和ISP方面有什么改动？

---

**Cursor**

可以继续。  
这次把问题收紧到你问的点：

> 相比于“单 sensor、单 channel”，当 sensor 声明 `CHANNEL_0 | CHANNEL_1` 以后，**TDM** 和 **ISP** 这两部分到底改了什么？

我先给一个最关键的结论：

---

# 总结结论

## 1）TDM 本身**不会因为多 VC 自动开启**
是否经过 TDM，**只由** `vincX_tdm_rx_sel` 决定，和你声明 `CHANNEL_0 | CHANNEL_1` 没有直接绑定关系。

- `tdm_rx_sel == 0xff`：**不走 TDM**
- `tdm_rx_sel != 0xff`：**走 TDM**

所以：

### 对比“单 sensor 单 channel”
- 如果你 **不启用 TDM**，那多 VC 对 TDM 这一级基本**没有新增功能路径**，因为根本不经过它。
- 如果你 **启用 TDM**，那 TDM 接收到的 parser capture 通道数会从 1 变成 2，**但 TDM 的插入与否不是由 VC 数决定的，而是由 DTS 的 `tdm_rx_sel` 决定的。**

---

## 2）ISP 侧的变化是**实打实存在的**
当 `CHANNEL_0 | CHANNEL_1` 让 `total_rx_ch = 2` 后，VIN 在 `CSI -> ISP` 这一步会从：

- 配 1 路 `csic_isp_input_select(..., ch=0)`

变成：

- 配 2 路  
  `csic_isp_input_select(..., ch=0)`  
  `csic_isp_input_select(..., ch=1)`

所以相对于单 channel，**ISP 侧真正多出来的是：多配置了一组 parser channel 到 ISP input 的路由。**

---

下面分开讲。

---

# 一、先明确：多 VC 后，TDM 会不会变？

## 1. TDM 是否插入链路，只看 `tdm_rx_sel`

在 `vin.c` 建 media link 时，代码写得非常直白：

```1765:1792:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
#ifdef SUPPORT_ISP_TDM
		/*tdm*/
		if (vinc->tdm_rx_sel == 0xff)
			tdm_rx = NULL;
		else
			tdm_rx = vind->tdm[vinc->tdm_rx_sel/TDM_RX_NUM].tdm_rx[vinc->tdm_rx_sel].sd;
		/*isp*/
		if (vinc->isp_sel == 0xff)
			isp = NULL;
		else
			isp = vind->isp[vinc->isp_sel].sd;

		if (tdm_rx != NULL) {
			source = &csi->entity;
			sink = &tdm_rx->entity;
            // csi -> tdm_rx

			source = &tdm_rx->entity;
			sink = &isp->entity;
            // tdm_rx -> isp
		} else {
			source = &csi->entity;
			sink = &isp->entity;
            // csi -> isp
		}
#endif
```

这段说明得很清楚：

- **有 TDM**：`CSI -> TDM_RX -> ISP`
- **没 TDM**：`CSI -> ISP`

所以“多 VC”并不会自动让链路从 `CSI -> ISP` 变成 `CSI -> TDM -> ISP`。  
真正决定是否插入 TDM 的，是 `vinc->tdm_rx_sel`。

---

## 2. 调试输出也证明了这点

`vin_core.c` 打印链路时分两种情况：

### 不走 TDM
```1680:1688:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c
		if (vinc->tdm_rx_sel == 0xff) {
			count += scnprintf(buf + count, size - count, "vi%u:\n%s => csi%d => isp%d => vipp%d\n",
				vinc->id, vinc->vid_cap.pipe.sd[VIN_IND_SENSOR]->name,
				vinc->csi_sel, vinc->isp_sel, vinc->vipp_sel);
		} else {
			count += scnprintf(buf + count, size - count, "vi%u:\n%s => csi%d => tdm_rx%d => isp%d => vipp%d\n",
```

### 走 MIPI 且走 TDM
```1692:1700:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c
		if (vinc->tdm_rx_sel == 0xff) {
			count += scnprintf(buf + count, size - count, "vi%u:\n%s => mipi%d => csi%d => isp%d => vipp%d\n",
				vinc->id, vinc->vid_cap.pipe.sd[VIN_IND_SENSOR]->name,
				vinc->mipi_sel, vinc->csi_sel, vinc->isp_sel, vinc->vipp_sel);
		} else {
			count += scnprintf(buf + count, size - count, "vi%u:\n%s => mipi%d => csi%d => tdm_rx%d => isp%d => vipp%d\n",
```

所以：

- **多 VC ≠ 一定走 TDM**
- **TDM 是独立选择项**

---

# 二、多 VC 后，TDM 真正会受什么影响？

如果你**已经启用了 TDM**，那多 VC 带来的变化主要在 parser capture 启动参数上。

---

## 1. TDM 启动时，parser capture 用的是 `csi->bus_info.ch_total_num`

在 `vin_tdm.c` 里：

```1891:1893:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
				csi = container_of(vinc->vid_cap.pipe.sd[VIN_IND_CSI], struct csi_dev, subdev);
				csic_prs_capture_start(vinc->csi_sel, csi->bus_info.ch_total_num, &mode);
				flags = 0;
```

这里第二个参数就是：

- `csi->bus_info.ch_total_num`

而这个值来自 `sunxi_csi_s_mbus_config()` 对 `CHANNEL_x` 的统计：

```513:526:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-csi/sunxi_csi.c
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

所以：

### 单 channel
- `ch_total_num = 1`

### `CHANNEL_0 | CHANNEL_1`
- `ch_total_num = 2`

这意味着如果链路走了 TDM，那么 **TDM 前面的 parser capture start 会按 2 路去启动**。

---

## 2. 但是 TDM 自己没有看到“专门针对 VC 多一套配置”的代码

从现有代码看，TDM 的核心逻辑更多是：
- 按 `tdm_rx_sel` 选 RX
- 按 WDR / offline / online 管理多个 `tdm_rx`
- 处理中间缓存、reset、tx/rx enable

比如 reset/start 时，主要围绕 `tdm_rx_sel` 做：

```1784:1817:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
		tdm_rx = &tdm->tdm_rx[vind->vinc[i]->tdm_rx_sel];

		if (vind->vinc[i]->tdm_rx_sel == tdm_rx->id) {
			vinc = vind->vinc[i];
            // ...
			if (flags) {
                // stop parser / isp / tdm / dma ...
			}
            // ...
		}
```

以及：

```1878:1912:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
				csic_tdm_rx_enable(0, vinc->tdm_rx_sel);
				csic_tdm_rx_cap_enable(0, vinc->tdm_rx_sel);
				vin_print("%s:tdm_rx%d reset!!!\n", __func__, vinc->tdm_rx_sel + 1);
				csic_tdm_rx_enable(0, vinc->tdm_rx_sel + 1);
				csic_tdm_rx_cap_enable(0, vinc->tdm_rx_sel + 1);
				if (tdm_rx->ws.wdr_mode == ISP_3FDOL_WDR_MODE) {
					vin_print("%s:tdm_rx%d reset!!!\n", __func__, vinc->tdm_rx_sel + 2);
					csic_tdm_rx_enable(0, vinc->tdm_rx_sel + 2);
					csic_tdm_rx_cap_enable(0, vinc->tdm_rx_sel + 2);
				}
				csic_prs_enable(vinc->csi_sel);

				csi = container_of(vinc->vid_cap.pipe.sd[VIN_IND_CSI], struct csi_dev, subdev);
				csic_prs_capture_start(vinc->csi_sel, csi->bus_info.ch_total_num, &mode);
```

这里你能看到：
- TDM 的“多路开启”更多是围绕 `tdm_rx_sel + 1/+2`
- 这更像 WDR / TDM RX 组管理
- **不是专门给 CSI-2 VC 做独立一套 TDM 配置**

### 所以更准确的说法是：
多 VC 对 TDM 的影响主要是：

> **如果你用了 TDM，TDM 前面的 parser capture 会按 `ch_total_num=2` 启动。**

但：

> **TDM 本身是否启用、启哪一路 RX、后面接哪个 ISP，不是由 `CHANNEL_0|CHANNEL_1` 决定，而是由 `tdm_rx_sel` 和整个 TDM/WDR 工作模式决定。**

---

# 三、多 VC 后，ISP 侧到底变了什么？

这个变化比 TDM 清楚得多，而且是你最该关注的。

---

## 1. `vinc->total_rx_ch` 会从 1 变成 2

`vin_video.c`：

```1192:1225:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
	ret = v4l2_subdev_call(sd, video, g_mbus_config, &mcfg);
    // ...
	csi = v4l2_get_subdevdata(pipe->sd[VIN_IND_CSI]);
	vinc->total_rx_ch = csi->bus_info.ch_total_num;
```

所以：

- 单 channel：`total_rx_ch = 1`
- `CHANNEL_0 | CHANNEL_1`：`total_rx_ch = 2`

---

## 2. 开流时，`CSI -> ISP` 输入路由会从 1 次变成 2 次

这是最关键的一段：

```1018:1040:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
#elif defined (CONFIG_ARCH_SUN8IW21P1)
		if (vinc->large_image == 3) {
            // ...
		} else {
			if ((vinc->csi_ch != 0xff) && (vinc->csi_ch & 0x10))
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, vinc->csi_ch & 0xf);
			else {
				for (i = 0; i < vinc->total_rx_ch; i++)
					csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + i, vinc->csi_sel, i);
			}
		}
		csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
```

看这句循环：

```c
for (i = 0; i < vinc->total_rx_ch; i++)
    csic_isp_input_select(..., ..., ..., vinc->csi_sel, i);
```

### 单 channel 时
只执行一次：

- `i = 0`

也就是只配：

- `parser ch0 -> ISP input`

### 双 channel 时
执行两次：

- `i = 0`
- `i = 1`

也就是多配了一组：

- `parser ch1 -> ISP input`

---

## 3. `csic_isp_input_select()` 确实是在写 ISP 输入 mux

`top_reg.c`：

```228:232:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
void csic_isp_input_select(unsigned int sel, unsigned int isp, unsigned int in,
				unsigned int psr, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_ISP0_IN0_REG_OFF + isp * 16 + in * 4,
			isp_input[isp][in][psr][ch]);
}
```

也就是说：

- `ch=0` 时写一次 mux
- `ch=1` 时再写一次 mux

因此相对单 channel，**ISP 这边真正新增的是一条 parser channel 到 ISP input 的映射配置**。

---

# 四、那 `VIPP` / `isp_tx_ch` 会不会因为多 VC 自动变化？

## 不会自动变化

`csic_vipp_input_select()` 还是只看 `isp_tx_ch`：

```1038:1039:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		}
		csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
```

底层：

```235:239:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
void csic_vipp_input_select(unsigned int sel, unsigned int vipp,
				unsigned int isp, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_VIPP0_IN_REG_OFF + vipp * 4,
			vipp_input[vipp][isp][ch]);
}
```

所以多 VC 带来的**直接变化**在 ISP 输入侧，而不是自动改 `isp_tx_ch`。  
`isp_tx_ch` 仍然是你用来决定：

> 这个 `vinc/videoX` 从 ISP 组下哪一路 channel 取数据

如果你不改 `isp_tx_ch`，VIN 不会自动帮你把第二路 VC 分给另一个 video 节点。

---

# 五、把它跟“单 sensor 单 channel”做一个明确对比

---

## 情况 A：单 sensor + 单 channel + 不走 TDM

链路：

```text
sensor -> mipi -> csi(ch0) -> isp -> vipp
```

配置上：
- `ch_total_num = 1`
- `total_rx_ch = 1`
- 只执行一次 `csic_isp_input_select(... ch=0)`

---

## 情况 B：单 sensor + 双 VC + 不走 TDM

链路：

```text
sensor -> mipi -> csi(ch0/ch1) -> isp -> vipp
```

配置上：
- `ch_total_num = 2`
- `total_rx_ch = 2`
- 执行两次 `csic_isp_input_select(...)`
  - 一次 `ch=0`
  - 一次 `ch=1`

### 对 ISP 的变化
有，且明确：**多了一路 parser->ISP 输入映射**

### 对 TDM 的变化
没有，因为根本没走 TDM

---

## 情况 C：单 sensor + 双 VC + 走 TDM

链路：

```text
sensor -> mipi -> csi(ch0/ch1) -> tdm_rx -> isp -> vipp
```

配置上：
- `ch_total_num = 2`
- `csic_prs_capture_start(..., 2, ...)`

### 对 TDM 的变化
- parser capture start 的通道数从 1 变成 2
- 但 TDM 插入链路本身还是由 `tdm_rx_sel` 决定
- 没看到“因为 2VC 所以自动多开某个 tdm_rx”的通用逻辑

### 对 ISP 的变化
- 最终仍然表现为 ISP 前面接收到的是 2 路 parser channel

---

# 六、所以你这个问题的最精准回答

## 1）TDM 方面有什么改动？
### 结论：
**没有“自动启用 TDM”或“自动新增 TDM 路”的改动。**

多 VC 后，TDM 方面最直接的变化只是：

- 如果链路本来就走 TDM，
- 那么 `csic_prs_capture_start()` 里的通道数参数从 1 变成 2

对应代码：

```1891:1893:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
				csi = container_of(vinc->vid_cap.pipe.sd[VIN_IND_CSI], struct csi_dev, subdev);
				csic_prs_capture_start(vinc->csi_sel, csi->bus_info.ch_total_num, &mode);
				flags = 0;
```

而 `csi->bus_info.ch_total_num` 是否为 2，来自：

```513:526:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-csi/sunxi_csi.c
		if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_0))
			csi->bus_info.ch_total_num++;
		if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_1))
			csi->bus_info.ch_total_num++;
```

---

## 2）ISP 方面有什么改动？
### 结论：
**ISP 输入路由会从单路变双路。**

具体就是：

- 单 channel 时只配 `parser ch0`
- 双 channel 时会多配 `parser ch1`

对应代码：

```1029:1037:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		} else {
			if ((vinc->csi_ch != 0xff) && (vinc->csi_ch & 0x10))
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, vinc->csi_ch & 0xf);
			else {
				for (i = 0; i < vinc->total_rx_ch; i++)
					csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + i, vinc->csi_sel, i);
			}
		}
```

而 `vinc->total_rx_ch` 来自：

```1223:1225:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
	csi = v4l2_get_subdevdata(pipe->sd[VIN_IND_CSI]);
	vinc->total_rx_ch = csi->bus_info.ch_total_num;
	vinc->vid_cap.frame.fmt.mbus_type = mcfg.type;
```

---

# 七、最后一句最实用的话

相对于“单 sensor、单 channel”：

- **TDM**：  
  只有在你本来就启用了 `tdm_rx_sel` 的前提下，parser capture 的通道数会从 1 变成 2；  
  否则 TDM 完全不参与。

- **ISP**：  
  会明确从“只接 parser ch0”变成“同时接 parser ch0 和 ch1”，也就是 **多配置一组 `CSI -> ISP` 输入路由**。

---

如果你愿意，我下一步可以继续往更底层追一层：

1. **把 `csic_isp_input_select(..., ch=0/1)` 最终写到哪些寄存器地址算出来**
2. **结合你的 `kw33000_mipi.c`，直接给出“2VC 场景下 DTS + sensor 驱动应该怎么配”的最小可用方案**

---

**User**

你是否能结合VIN源码，找到证据证明普通 2-VC 场景下 ISP 会自动对每路 VC 产出一条独立 output chn 数据流？

---

**Cursor**

可以下结论：**基于目前这份 VIN 源码，我找不到“普通 2-VC 场景下 ISP 会自动为每路 VC 产出一条独立 output chn 数据流”的证据。**  
相反，我能找到的源码证据更支持下面这个判断：

> **VIN 会自动把多 VC 当成多路 ISP 输入来配置；但 ISP 输出给哪一路 `vinc/VIPP`，仍然是由 `isp_tx_ch` 手工选择，而不是因为有 2 个 VC 就自动生成 2 条独立 output channel。**

下面我按“证据链”说。

---

# 一、VIN 自动做的事情：是“多路输入接入 ISP”，不是“多路输出自动分配”

最核心的代码在 `vin.c`。

当 `vinc->total_rx_ch > 1` 时，VIN 会循环调用 `csic_isp_input_select()`：

```1018:1039:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
#elif defined (CONFIG_ARCH_SUN8IW21P1)
		if (vinc->large_image == 3) {
			/* parserx ch0--isp0 ch0, parserx ch1-- isp1 ch0 */
			if (vinc->isp_sel == 0)
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, 0);
			else if (vinc->isp_sel == 1)
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, 1);
			else
				vin_warn("large image mode not support isp%d\n", vinc->isp_sel);
		} else {
			if ((vinc->csi_ch != 0xff) && (vinc->csi_ch & 0x10))
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, vinc->csi_ch & 0xf);
			else {
				for (i = 0; i < vinc->total_rx_ch; i++)
					csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + i, vinc->csi_sel, i);
			}
		}
		csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
```

这里非常关键：

- 对输入，代码会根据 `total_rx_ch` 循环：
  - `i=0`
  - `i=1`
  - ...
- 也就是 **多 VC -> 多个 parser ch 接入 ISP**

但注意最后一行：

```c
csic_vipp_input_select(..., vinc->isp_tx_ch);
```

这里只有**一个** `isp_tx_ch` 被用于当前 `vinc` 的输出选择。  
没有任何“for 每个 VC 自动配一个输出 channel”的逻辑。

---

# 二、`total_rx_ch` 只是让 ISP 看到“有几路输入”

`total_rx_ch` 从哪里来？来自 CSI 对 `CHANNEL_x` 的统计，然后传给 `vinc`：

```1198:1225:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
	ret = v4l2_subdev_call(sd, video, g_mbus_config, &mcfg);
	// ...
	csi = v4l2_get_subdevdata(pipe->sd[VIN_IND_CSI]);
	vinc->total_rx_ch = csi->bus_info.ch_total_num;
	vinc->vid_cap.frame.fmt.mbus_type = mcfg.type;
```

所以：

- `CHANNEL_0` → `total_rx_ch = 1`
- `CHANNEL_0 | CHANNEL_1` → `total_rx_ch = 2`

这能证明：

> VIN 自动知道“有两路输入”

但这**只能证明输入侧多路配置**，不能证明输出侧自动变成两条独立流。

---

# 三、ISP 输出到 VIPP 的选择不是自动的，而是显式依赖 `isp_tx_ch`

`top_reg.c` 里更能看出这一点。

## 1）ISP 输入选择接口
```228:232:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
void csic_isp_input_select(unsigned int sel, unsigned int isp, unsigned int in,
				unsigned int psr, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_ISP0_IN0_REG_OFF + isp * 16 + in * 4,
			isp_input[isp][in][psr][ch]);
}
```

这个函数是：
- 选哪个 parser
- 选哪个 parser channel
- 送到哪个 ISP input

它服务的是**输入接入**。

---

## 2）VIPP 输入选择接口
```233:239:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
void csic_vipp_input_select(unsigned int sel, unsigned int vipp,
				unsigned int isp, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_VIPP0_IN_REG_OFF + vipp * 4,
			vipp_input[vipp][isp][ch]);
}
```

这个函数服务的是：
- 某个 `vipp`
- 从某个 `isp`
- 取某个 `ch`

也就是说，**输出选择明确要靠 `ch` 参数传进来**。  
这个 `ch` 在 `vin.c` 里就是 `vinc->isp_tx_ch`，不是“自动按 total_rx_ch 展开”。

---

# 四、`vipp_input` 是静态查表，不存在“见到 2VC 自动一分为二”的逻辑

`top_reg.c` 里的 `vipp_input` 本质是一个静态路由表：

```110:134:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
static char vipp_input[8][4][4] = {
#if defined(CONFIG_ARCH_SUN50IW3P1) || defined(CONFIG_ARCH_SUN50IW6P1)
	/*vipp0*/
	/*isp0*/        /*isp1*/      /*isp2*/       /*isp3*/
	{{0, 0, 0, 0}, {1, 0, 0, 0}, {0, 0, 0, 0}, {0, 0, 0, 0} },

	{{0, 2, 0, 0}, {1, 3, 0, 0}, {0, 0, 0, 0}, {0, 0, 0, 0} },

	{{0, 0, 2, 0}, {1, 0, 3, 0}, {0, 0, 0, 0}, {0, 0, 0, 0} },

	{{0, 0, 0, 2}, {1, 4, 0, 3}, {0, 0, 0, 0}, {0, 0, 0, 0} },
```

重点是它的索引维度：

- `vipp`
- `isp`
- `ch`

你要得到哪个输出映射，必须明确给出 `ch`。

也就是说源码模型是：

> **输出通道选择是显式参数驱动的，不是由“检测到多 VC”自动推导的。**

---

# 五、`isp_tx_ch` 来自 DTS/属性，说明这是“人工指定输出去向”

`vin_core.c` 里 `isp_tx_ch` 是从每个 `vinc` 的属性读出来的：

```2280:2298:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c
	sprintf(property_name, "vinc%d_isp_sel", pdev->id);
	if (of_property_read_u32(np, property_name, &vinc->isp_sel))
		vinc->isp_sel = 0;

	sprintf(property_name, "vinc%d_isp_tx_ch", pdev->id);
	if (of_property_read_u32(np, property_name, &vinc->isp_tx_ch))
		vinc->isp_tx_ch = 0;

	sprintf(property_name, "vinc%d_tdm_rx_sel", pdev->id);
	if (of_property_read_u32(np, property_name, &vinc->tdm_rx_sel))
		vinc->tdm_rx_sel = 0;
```

这说明什么？

说明对于每个 `vinc`：

- 你要自己指定 `isp_sel`
- 你要自己指定 `isp_tx_ch`

如果 ISP 真会“普通 2-VC 自动给每路 VC 产出一条独立 output chn 数据流”，那么至少我们应该期待看到：
- 自动根据 `total_rx_ch` 给多个 `vinc` 分配不同 `isp_tx_ch`
- 或者自动建立多条 `csic_vipp_input_select` 路由

但代码里完全没有这种自动分配逻辑。

---

# 六、DTS 默认配置也说明：输出通道不是自动从 VC 数推导出来的

看 `sun8iw21p1.dtsi` 里每个 `vinc` 都是手工写的：

```1659:1697:lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi
			vinc00:vinc@0 {
				device_type = "vinc0";
				compatible = "allwinner,sunxi-vin-core";
				reg = <0x0 0x05830000 0x0 0x1000>;
				interrupts = <GIC_SPI 95 4>;
				vinc0_csi_sel = <0>;
				vinc0_mipi_sel = <0>;
				vinc0_isp_sel = <0>;
				vinc0_isp_tx_ch = <0>;
				vinc0_tdm_rx_sel = <0>;
				// ...
			};

			vinc01:vinc@1 {
				// ...
				vinc1_isp_sel = <1>;
				vinc1_isp_tx_ch = <1>;
				vinc1_tdm_rx_sel = <1>;
				// ...
			};

			vinc02:vinc@2 {
				// ...
				vinc2_isp_sel = <2>;
				vinc2_isp_tx_ch = <2>;
```

可以看到：

- `isp_tx_ch` 是板级/场景配置的一部分
- 不是从 VC 信息自动算出来的

---

# 七、能证明“普通 2-VC 自动输出两路”的源码，我现在没找到；反而有反证

反证就是：

## 1）输入是循环自动配置的
有 `for (i = 0; i < vinc->total_rx_ch; i++)`

## 2）输出不是循环自动配置的
只有一条：

```1039:1039:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
```

这说明：
- 输入：会因 `2VC` 自动变两路
- 输出：**不会因 `2VC` 自动变两路**

---

# 八、所以“普通 2VC 场景”更合理的判断是什么？

更合理的判断是：

## VIN 自动做的：
- 把 `VC0/VC1` 作为两路 parser/ISP 输入接进来

## 但不会自动做的：
- 自动给 `VC0`、`VC1` 各生成一条独立 ISP output chn 并分别送到不同 `vinc`

如果想让两路子流分别出去，通常还需要：
- 多个 `vinc`
- 分别配置 `isp_tx_ch`
- 或使用官方那种 bypass/聚合场景配置

---

# 九、最终结论

**我不能基于这份 VIN 源码，证明“普通 2-VC 场景下 ISP 会自动对每路 VC 产出一条独立 output chn 数据流”。**

相反，源码更能证明的是：

1. `CHANNEL_0 | CHANNEL_1` 会让 VIN 自动把两路 VC 当成 **两路 ISP 输入** 配置；
2. 但 ISP 输出到 VIPP/视频节点时，依然只使用当前 `vinc` 的单个 `isp_tx_ch`；
3. 没有看到“按每路 VC 自动生成一条独立 output chn 并自动分配给不同 `vinc`”的实现。

---

如果你愿意，我下一步可以继续做两件更深入的事：

1. **继续查 `parser_reg` / `combo_csi` / `isp600_reg_cfg`，看看 VC 是不是在更底层硬件里已经天然分 lane/分 stream，只是上层没显式表现出来**
2. **结合你这个 V853 平台，给出一个“如果想把 2VC 真正变成两个 video 节点，需要哪些 DTS/驱动条件”的推导方案**

---

**User**

那 ISP output chn是怎么分配的？怎么被决定输出？

---

**Cursor**

可以。基于这份 VIN 源码，`ISP output chn` 的“分配”和“决定输出”可以概括成一句话：

> **它不是 ISP 根据输入 VC 自动分配的，而是由每个 `vinc` 的 `isp_tx_ch` 配置项显式指定，最后通过 `csic_vipp_input_select()` 写入 TOP 路由寄存器，决定某个 `VIPP/videoX` 从该 ISP 组的哪一路 channel 取数据。**

下面按“是谁决定、在哪里读、怎么生效、最终去哪里”来讲。

---

# 1）谁决定 ISP output chn？

## 直接决定者：`vincX_isp_tx_ch`

在 `vin_core.c` probe 时，每个 `vinc` 都会从 DTS 读取：

```2280:2298:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c
	sprintf(property_name, "vinc%d_isp_sel", pdev->id);
	if (of_property_read_u32(np, property_name, &vinc->isp_sel))
		vinc->isp_sel = 0;

	sprintf(property_name, "vinc%d_isp_tx_ch", pdev->id);
	if (of_property_read_u32(np, property_name, &vinc->isp_tx_ch))
		vinc->isp_tx_ch = 0;

	sprintf(property_name, "vinc%d_tdm_rx_sel", pdev->id);
	if (of_property_read_u32(np, property_name, &vinc->tdm_rx_sel))
		vinc->tdm_rx_sel = 0;
```

也就是说：

- `isp_sel`：决定挂哪个 ISP 节点/ISP 组
- `isp_tx_ch`：决定从该 ISP 组的哪个 output channel 取数据

所以 **ISP output chn 的分配，本质上是 DTS/板级配置决定的，不是运行时自动推导的。**

---

# 2）`isp_tx_ch` 存在于哪？

`vin_core` 结构体里有这两个关键字段：

```94:100:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.h
	unsigned int sensor_sel;
	unsigned int csi_sel;
	unsigned int mipi_sel;
	unsigned int csi_ch;
	unsigned int isp_sel;
	unsigned int tdm_rx_sel;
	unsigned int vipp_sel;
	unsigned int isp_tx_ch;
```

所以从软件模型上，VIN 早就把“选哪个 ISP”和“取哪个 ISP 输出 channel”分成了两个维度。

---

# 3）它是怎么被用来决定输出的？

核心代码在 `vin.c` 的开流路由配置里：

```1018:1039:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
#elif defined (CONFIG_ARCH_SUN8IW21P1)
		if (vinc->large_image == 3) {
			/* parserx ch0--isp0 ch0, parserx ch1-- isp1 ch0 */
			if (vinc->isp_sel == 0)
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, 0);
			else if (vinc->isp_sel == 1)
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, 1);
			else
				vin_warn("large image mode not support isp%d\n", vinc->isp_sel);
		} else {
			if ((vinc->csi_ch != 0xff) && (vinc->csi_ch & 0x10))
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, vinc->csi_ch & 0xf);
			else {
				for (i = 0; i < vinc->total_rx_ch; i++)
					csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + i, vinc->csi_sel, i);
			}
		}
		csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
```

这里分两步：

---

## 第一步：`csic_isp_input_select(...)`
这一步决定：

- 哪个 `CSI/parser`
- 哪个 parser `ch`
- 接到哪个 `ISP input`

这是“输入侧”的路由。

---

## 第二步：`csic_vipp_input_select(..., vinc->isp_tx_ch)`
这一步才决定：

- 当前这个 `VIPP`
- 从哪个 `ISP`
- 取哪个 `ch`

也就是“输出侧”的路由。

所以严格说：

> **ISP output chn 不是在 ISP 内部自动分配出来再通知 VIN，而是 VIN 用 `isp_tx_ch` 主动去选的。**

---

# 4）`csic_vipp_input_select()` 到底做了什么？

`top_reg.c`：

```233:239:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
void csic_vipp_input_select(unsigned int sel, unsigned int vipp,
				unsigned int isp, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_VIPP0_IN_REG_OFF + vipp * 4,
			vipp_input[vipp][isp][ch]);
}
```

这说明：

- 它最终就是往 TOP 路由寄存器写一个值
- 这个值来自 `vipp_input[vipp][isp][ch]`

也就是说：

> **输出 channel 的本质，是一个由 `vipp + isp + ch` 共同决定的硬件 mux 选择值。**

---

# 5）这个 `ch` 是不是自动来的？不是，是你传进去的 `isp_tx_ch`

还是上面那句：

```1039:1039:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
```

最后一个参数就是：

- `vinc->isp_tx_ch`

而 `vinc->isp_tx_ch` 来自 DTS。

所以链条很清楚：

```text
DTS 的 vincX_isp_tx_ch
 -> vinc->isp_tx_ch
 -> csic_vipp_input_select(..., ch)
 -> 写 TOP 路由寄存器
 -> 决定 VIPP 从 ISP 哪一路输出取数
```

---

# 6）`vipp_input` 查表说明 output chn 是“静态路由选择”，不是自动分流

`top_reg.c` 里的表：

```110:134:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
static char vipp_input[8][4][4] = {
#if defined(CONFIG_ARCH_SUN50IW3P1) || defined(CONFIG_ARCH_SUN50IW6P1)
	/*vipp0*/
	/*isp0*/        /*isp1*/      /*isp2*/       /*isp3*/
	{{0, 0, 0, 0}, {1, 0, 0, 0}, {0, 0, 0, 0}, {0, 0, 0, 0} },

	{{0, 2, 0, 0}, {1, 3, 0, 0}, {0, 0, 0, 0}, {0, 0, 0, 0} },

	{{0, 0, 2, 0}, {1, 0, 3, 0}, {0, 0, 0, 0}, {0, 0, 0, 0} },

	{{0, 0, 0, 2}, {1, 4, 0, 3}, {0, 0, 0, 0}, {0, 0, 0, 0} },
```

虽然不同平台映射表不同，但结构不变：

- 第一维：`vipp`
- 第二维：`isp`
- 第三维：`ch`

所以 `ISP output chn` 实际上就是这个第三维索引。  
你给它传 `0`，就选 `ch0`；传 `1`，就选 `ch1`。

这也再次说明：

> **它不是根据“当前有几个 VC”自动为你分配好的，而是你要显式指定当前 `vipp/videoX` 想吃哪一路。**

---

# 7）那 `isp_sel` 和 `isp_tx_ch` 的关系是什么？

可以理解成两级选择：

## 第一级：`isp_sel`
决定接哪个 ISP 逻辑节点/ISP 组。

## 第二级：`isp_tx_ch`
决定从这个 ISP 组的哪一路 output channel 取数。

所以：

- `isp_sel` 决定“在哪个池子里选”
- `isp_tx_ch` 决定“从池子里的哪一路拿”

---

# 8）为什么官方 CDR 示例里要手工写 `0/1/2/3`？

因为 output channel 就是这么分配的：**手工指定**。

比如你前面给的官方场景，本质就是：

- `video0` 选 `isp_tx_ch = 0`
- `video4` 选 `isp_tx_ch = 1`
- `video8` 选 `isp_tx_ch = 2`
- `video12` 选 `isp_tx_ch = 3`

这个写法本身就是证据：  
如果 ISP output chn 是自动按 VC 分配的，那 DTS 就没必要对每个 `vinc` 再单独写 `isp_tx_ch` 了。

---

# 9）那普通 2VC 场景下，output chn 会自动等于 VC 吗？

**源码里看不到这个“自动等于”的逻辑。**

能看到的只有：

- `total_rx_ch` 决定会把多少路 parser 输入接到 ISP
- `isp_tx_ch` 决定当前 `vipp` 取 ISP 的哪一路输出

但是看不到类似下面这种代码：

```c
if (total_rx_ch == 2) {
    vinc0->isp_tx_ch = 0;
    vinc1->isp_tx_ch = 1;
}
```

或者：

```c
for each vc:
    auto create one output chn
```

所以更可信的结论是：

> **ISP output chn 由 VIN 配置选择，而不是由 VC 自动映射。**

---

# 10）一句最直接的话回答你

## ISP output chn 是怎么分配的？
**由每个 `vinc` 的 `isp_tx_ch` 配置项分配。**

## 怎么被决定输出？
VIN 在开流时调用：

```1039:1039:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
```

然后通过：

```233:239:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
void csic_vipp_input_select(unsigned int sel, unsigned int vipp,
				unsigned int isp, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_VIPP0_IN_REG_OFF + vipp * 4,
			vipp_input[vipp][isp][ch]);
}
```

把这个选择写进 TOP 路由寄存器，从而决定：

- 这个 `VIPP/videoX`
- 从哪个 `ISP`
- 的哪个 `output chn`
- 取数据。

---

如果你愿意，我下一步可以继续帮你追两层：

1. **把 V853 上 `isp_sel/ISP_VIRT_NUM`、`vipp_sel/VIPP_VIRT_NUM` 的分组关系再算清楚**
2. **结合你当前想做的 2VC 场景，推导“如果要让两个 VC 各对应一个 video 设备，DTS 至少要怎么写”**

