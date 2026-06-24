
---

**User**

1、@lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/gc2053_mipi.c +@device/config/chips/v853/configs/100ask/board.dts 
以gc2053_mipi为例，帮我分析这个dts中TDM如何发挥作用的？结合具体TDM源码分析
2、还是以normal为例，没有配置wdr的情况下，TDM如何接收多路csi数据并输出给ISP？
3、WDR模式是什么？为什么X帧 WDR 使用X路 RX？

---

**Cursor**

下面我按你的 3 个问题，**结合 `gc2053_mipi.c` + `board.dts` + `vin.c` + `vin_tdm.c`** 来讲。  
这次我尽量不只停留在概念层，而是直接对应你这套 V853/100ask 配置。

---

# 1. 以 `gc2053_mipi` 为例，`board.dts` 中 TDM 是如何发挥作用的？

先说结论：

> 在你这个 `100ask/board.dts` 里，`gc2053_mipi` 的数据路径是  
> **sensor → MIPI → CSI → TDM RX → ISP → scaler/vin_core → video**  
> 其中 TDM 不是“可有可无”的配置项，而是被 `vin.c` 在 media graph 里显式插到 `CSI` 和 `ISP` 之间。

---

## 1.1 先看 DTS 里最关键的节点

### 1）TDM 设为 offline 模式

```113:115:device/config/chips/v853/configs/100ask/board.dts
tdm0:tdm@0 {
	work_mode = <1>;
};
```

而在 `tdm200_reg.h` 里：

```100:103:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/tdm200/tdm200_reg.h
enum tdm_work_mode {
	TDM_ONLINE = 0,
	TDM_OFFLINE = 1,
};
```

所以这块板子上 `tdm0` 是 **offline mode**。

---

### 2）两个 GC2053 传感器都启用，并且都走 ISP

```181:200:device/config/chips/v853/configs/100ask/board.dts
sensor0:sensor@0 {
	device_type = "sensor0";
	sensor0_mname = "gc2053_mipi";
	...
	sensor0_isp_used = <1>;
	sensor0_fmt = <1>;
	...
	status	= "okay";
};
```

```239:258:device/config/chips/v853/configs/100ask/board.dts
sensor1:sensor@1 {
	device_type = "sensor1";
	sensor1_mname = "gc2053_mipi_2";
	...
	sensor1_isp_used = <1>;
	sensor1_fmt = <1>;
	...
	status	= "okay";
};
```

这里有两个关键信息：

- `sensor*_mname` 对应的就是具体 sensor 驱动，如 `gc2053_mipi.c`
- `sensor*_isp_used = <1>` 表示这路传感器会走 ISP 流程，不是绕过 ISP 的裸输出

---

### 3）vinc 节点把每一路视频管线绑定到各自的 csi / mipi / isp / tdm_rx

比如 `vinc00`：

```260:269:device/config/chips/v853/configs/100ask/board.dts
vinc00:vinc@0 {
	vinc0_csi_sel = <0>;
	vinc0_mipi_sel = <0>;
	vinc0_isp_sel = <0>;
	vinc0_isp_tx_ch = <0>;
	vinc0_tdm_rx_sel = <0>;
	vinc0_rear_sensor_sel = <0>;
	vinc0_front_sensor_sel = <0>;
	vinc0_sensor_list = <0>;
	work_mode = <0x1>;
	status = "okay";
};
```

再看 `vinc01`：

```272:281:device/config/chips/v853/configs/100ask/board.dts
vinc01:vinc@1 {
	vinc1_csi_sel = <1>;
	vinc1_mipi_sel = <1>;
	vinc1_isp_sel = <1>;
	vinc1_isp_tx_ch = <0>;
	vinc1_tdm_rx_sel = <1>;
	vinc1_rear_sensor_sel = <1>;
	vinc1_front_sensor_sel = <1>;
	vinc1_sensor_list = <0>;
	status = "okay";
};
```

这两个节点非常重要，它们告诉 VIN：

- `sensor0(gc2053_mipi)` → `mipi0` → `csi0` → `tdm_rx0` → `isp0`
- `sensor1(gc2053_mipi_2)` → `mipi1` → `csi1` → `tdm_rx1` → `isp1`

也就是说，在 DTS 的“逻辑绑定”里，**TDM RX 已经明确成为每路视频链路中的一环**。

---

## 1.2 sensor 驱动本身提供了什么给 TDM

`gc2053_mipi.c` 里可以看到它确实是 MIPI RAW 传感器，1080p 典型参数例如：

```707:711:lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/gc2053_mipi.c
/*
 * window_size=1920*1080 mipi@2lane
 * mclk=24mhz, mipi_clk=594Mbps
 * pixel_line_total=2640, line_frame_total=1125
 * row_time=35.55us, frame_rate=25fps
 */
```

并且寄存器配置最后明确写了 MIPI 输出部分：

```842:854:lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/gc2053_mipi.c
/****DVP & MIPI****/
{0xfe, 0x01},
{0x9a, 0x06},
{0xfe, 0x00},
{0x7b, 0x2a},
{0x23, 0x2d},
{0xfe, 0x03},
{0x01, 0x27},
{0x02, 0x56},
{0x03, 0x8e},
{0x12, 0x80},
{0x13, 0x07},
{0x15, 0x12},
```

而且默认是 RAW 输出，代码里有 `RAW10` 开关：

```33:40:lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/gc2053_mipi.c
#ifdef CONFIG_SENSOR_GC2053_8BIT_MIPI
#define RAW10 0 //raw8 select
#else
#define RAW10 1 //raw10 select
#endif
```

所以对于 TDM 来说，GC2053 提供的是：
- MIPI 输入
- Bayer RAW
- 8bit/10bit（这套配置默认更偏 10bit）

TDM 后面根据 `set_fmt()` 解析到 `MEDIA_BUS_FMT_SBGGR10_1X10` 之类的 code，然后配置：
- `input_bit_width`
- `input_type`
- `raw_fmt`

---

## 1.3 `vin.c` 如何把 TDM 插进 media graph

你要看懂 “DTS 中 TDM 如何发挥作用”，关键不只是 DTS 本身，而是 DTS 中的 `vinc*_tdm_rx_sel` 最后如何被 `vin.c` 消化。

### 1）先注册所有 TDM subdev

```1468:1478:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
#ifdef SUPPORT_ISP_TDM
for (i = 0; i < VIN_MAX_TDM; i++) {
	/*Register TDM subdev */
	vind->tdm[i].id = i;
	for (j = 0; j < TDM_RX_NUM; j++) {
		vind->tdm[i].tdm_rx[j].sd = sunxi_tdm_get_subdev(i, j);
		ret = v4l2_device_register_subdev(&vind->v4l2_dev,
						vind->tdm[i].tdm_rx[j].sd);
```

说明：  
`tdm_probe()` 建好的 `tdm_rx0 ~ tdm_rx3`，在 VIN 顶层都被注册成可参与 graph 的实体。

---

### 2）创建媒体链路时，如果配置了 `tdm_rx_sel`，就走 CSI→TDM→ISP

```1660:1688:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
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
	...
	source = &tdm_rx->entity;
	sink = &isp->entity;
	...
} else {
	source = &csi->entity;
	sink = &isp->entity;
	...
}
#endif
```

这段代码非常关键：

- 如果 `vinc->tdm_rx_sel != 0xff`，就说明这一条链路 **使用 TDM**
- 那么 link 不是 `CSI -> ISP`
- 而是 `CSI -> TDM_RX -> ISP`

所以在你这个 DTS 里，`vinc0_tdm_rx_sel = <0>`、`vinc1_tdm_rx_sel = <1>` 的直接含义就是：

- `vinc00` 强制把 `csi0` 输出接到 `tdm_rx0`
- `vinc01` 强制把 `csi1` 输出接到 `tdm_rx1`

这就是 DTS 中 TDM “发挥作用”的真正落点。

---

## 1.4 `vin_md_prepare_pipeline()` 也明确识别 TDM 作为管线节点

```91:105:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
switch (sd->grp_id) {
case VIN_GRP_ID_SENSOR:
	p->sd[VIN_IND_SENSOR] = sd;
	break;
case VIN_GRP_ID_MIPI:
	p->sd[VIN_IND_MIPI] = sd;
	break;
case VIN_GRP_ID_CSI:
	p->sd[VIN_IND_CSI] = sd;
	break;
case VIN_GRP_ID_TDM_RX:
	p->sd[VIN_IND_TDM_RX] = sd;
	break;
case VIN_GRP_ID_ISP:
	p->sd[VIN_IND_ISP] = sd;
	break;
```

说明从 VIN pipeline 视角，TDM 是正式成员，不是隐含硬件。

---

## 1.5 所以对 `gc2053_mipi` 来说，TDM 到底做了什么？

以 `vinc00` 这路 `gc2053_mipi` 为例，实际链路是：

1. `gc2053_mipi.c` 把 sensor 配成 MIPI RAW 输出
2. `mipi0` 接收 D-PHY 数据
3. `csi0` 把 MIPI 数据整理成 CSI 子系统内部格式
4. `tdm_rx0` 接收来自 `csi0` 的 RAW 图像流
5. `tdm0` 根据当前模式（这里 DTS 是 offline）决定：
   - 是否启用内部 TX
   - 是否做 pkg/lbc
   - 是否分配 DMA buffer
   - 是否将数据再送到 ISP
6. `isp0` 再做后续 RAW 处理

所以 TDM 在这里的作用可以概括为：

> **它是 CSI 到 ISP 之间的 RAW 中转调度层。**

---

# 2. 以 normal 为例，没有配置 WDR 的情况下，TDM 如何接收多路 CSI 数据并输出给 ISP？

你问的是 normal 模式，也就是：
- `res_wdr_mode != ISP_DOL_WDR_MODE`
- `res_wdr_mode != ISP_3FDOL_WDR_MODE`

对应 `vin_tdm.c` 里的 `else` 分支。

---

## 2.1 normal 模式在 `s_stream()` 中的处理

看这里：

```1166:1197:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
} else {
	vin_log(VIN_LOG_FMT, "rx%d wdr mode is normal\n", tdm_rx->id);
	if (tdm->work_mode == TDM_OFFLINE) {
		tdm->ws.tdm_en = 1;
		tdm->tx_cfg.data_depth = 512;
		tdm->tx_cfg.head_depth = 32;
		tdm_rx->ws.tx_func_en = 1;
		if (tdm_rx->id == 0) {
#ifdef CONFIG_TDM_OFFLINE_HANDLE_RAW
			tdm_rx->ws.pkg_en = 1;
			tdm_rx->ws.lbc_en = 0;
#else
			tdm_rx->ws.pkg_en = 0;
			tdm_rx->ws.lbc_en = 1;
#endif
			tdm_rx->ws.sync_en = 0;
		} else {
			tdm_rx->ws.pkg_en = 1;
			tdm_rx->ws.lbc_en = 0;
			tdm_rx->ws.sync_en = 0;
		}
	} else {
		tdm->ws.tdm_en = 1;
		tdm->tx_cfg.data_depth = 512;
		tdm->tx_cfg.head_depth = 32;
		tdm_rx->ws.tx_func_en = 0;
		tdm_rx->ws.pkg_en = 0;
		tdm_rx->ws.lbc_en = 0;
		tdm_rx->ws.sync_en = 0;
		if (!tdm->ws.speed_dn_en)
			return 0;
	}
}
```

### 这段的核心含义：

### 在 **offline 模式** 下：
- `tdm_en = 1`
- `tx_func_en = 1`
- `rx0` 常常用 `lbc`
- `rx1/rx2/rx3` 常常用 `pkg`

### 在 **online 模式** 下：
- normal 模式通常不需要 TX 功能
- 如果不开 `speed_dn`，很多情况下会直接 return

而你这套 DTS 明确是 `work_mode = <1>`，即 **offline**，所以会走第一条。

---

## 2.2 TDM 如何接收多路 CSI 数据

先强调一点：

> TDM 不是把“多个 CSI 物理口的数据混成一路再分开”  
> 它是有 **多个 RX 通道** 的，每个 RX 通道独立接一条输入流。

V200 硬件定义：

```24:24:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/tdm200/tdm200_reg.h
#define TDM_RX_NUM   4
```

所以可以理解成：
- `tdm_rx0`
- `tdm_rx1`
- `tdm_rx2`
- `tdm_rx3`

每个 `vinc` 绑定其中一个 RX。

在你的板级配置里：
- `vinc00` 用 `tdm_rx0`
- `vinc01` 用 `tdm_rx1`

所以“多路 CSI 数据”不是在一个 RX 里多路复用，而是：

- `csi0 -> tdm_rx0`
- `csi1 -> tdm_rx1`

分别进入 TDM 的不同 RX 通道。

---

## 2.3 RX 硬件配置怎么下发

在 `tdm_set_rx_cfg()` 中，TDM 会对每个 RX 做这些事：

```496:504:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
csic_tdm_rx_set_min_ddr_size(tdm->id, tdm_rx->id, DDRSIZE_512b);
csic_tdm_rx_input_bit(tdm->id, tdm_rx->id, tdm_rx->tdm_fmt->input_type);
csic_tdm_rx_input_fmt(tdm->id, tdm_rx->id, tdm_rx->tdm_fmt->raw_fmt);
csic_tdm_rx_input_size(tdm->id, tdm_rx->id, tdm_rx->format.width, tdm_rx->format.height);
```

也就是对每路 RX 分别配置：
- bit width
- Bayer 格式
- width/height
- DDR buffer 策略

然后根据 normal 模式下的 `pkg_en/lbc_en` 决定额外功能。

---

## 2.4 然后给每个 RX 分配自己的 buffer

`tdm_set_rx_cfg()` 后面会算每路 buffer 数量和大小，然后调用：

- `tdm_rx_bufs_alloc()`
- 或 `tdm_rx_bufs_loop_alloc()`

并把地址写到 RX 通道对应的 FIFO：

```666:675:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
ret = tdm_rx_bufs_alloc(tdm_rx, size, tdm_buf_num);
...
csic_tdm_rx_set_buf_num(tdm->id, tdm_rx->id, tdm_buf_num - 1);
for (i = 0; i < tdm_buf_num; i++) {
	csic_tdm_rx_set_address(tdm->id, tdm_rx->id, (unsigned long)tdm_rx->buf[i].dma_addr);
}
```

所以本质上每个 RX 都有自己的 DMA 缓冲区队列。

---

## 2.5 normal 模式下如何“输出给 ISP”

这个要分两个层面看：

---

### 层面 A：media graph 层面
`vin.c` 已经创建了链路：

- `CSI -> TDM_RX`
- `TDM_RX -> ISP`

所以从框架视角，数据输出目标就是 ISP。

---

### 层面 B：TDM 硬件层面
在 offline normal 模式下：
- `tdm_en = 1`
- `tx_func_en = 1`

也就是说，TDM 不只是 RX 抓到内存，还会启用 **TDM 内部 TX 路径** 把 RX 的结果继续送后级。

你可以把它理解成：
- RX 从 CSI 接原始流
- TDM 内部做必要的打包/压缩/缓存
- TX 再把这路数据按 ISP 需要的时序送出去
- ISP 从 TDM 的输出端取数据

这也是为什么它要同时配置：
- `tdm_set_tx_blank()`
- `csic_tdm_tx_fifo_depth()`
- `csic_tdm_set_tx_data_rate()`
- `csic_tdm_tx_enable()`

例如顶层开启时：

```837:879:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
csic_tdm_set_rx_chn_cfg_mode(tdm->id, tdm->ws.rx_chn_mode);
csic_tdm_set_tx_chn_cfg_mode(tdm->id, tdm->ws.tx_chn_mode);
csic_tdm_set_work_mode(tdm->id, tdm->work_mode);
...
tdm_set_tx_blank(tdm);
csic_tdm_set_tx_t1_cycle(...);
...
csic_tdm_tx_enable(tdm->id);
```

这说明 TDM 硬件内部本来就有“RX 端”和“TX 端”两部分。

---

## 2.6 那 normal 模式下“多路”是怎么组织的？

V200 提供了：

```37:39:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/tdm200/tdm200_reg.h
enum  rx_chn_cfg_mode {
	LINEARx4 = 0x0,
	WDR_2F_AND_LINEARx2,
	WDR_2Fx2,
	WDR_3F_AND_LINEAR,
};
```

normal 模式下最终会选 `LINEARx4`。

意思不是“4 路合成 1 路图”，而是：

> TDM 当前工作在“四路线性输入通道模式”  
> 每个 RX 通道都按普通线性 RAW 采集方式独立工作。

也就是说在 normal 模式下，多路 CSI → 多路 TDM RX，本质是 **并行独立接收**，不是 WDR 式的多帧拼接。

---

## 2.7 对你这块板的具体解释

在 `100ask/board.dts` 中两个 GC2053 同时工作时，TDM 的角色就是：

- `gc2053_mipi` → `mipi0` → `csi0` → `tdm_rx0` → `isp0`
- `gc2053_mipi_2` → `mipi1` → `csi1` → `tdm_rx1` → `isp1`

此时 `tdm0` 作为一个控制器，同时管理多个 RX 通道。  
在 normal 模式下：
- `rx_chn_cfg_mode = LINEARx4`
- `rx0`、`rx1` 都按线性模式工作
- 各自从各自 CSI 收数据
- 各自配置 buffer
- 各自再送给各自 ISP 路径

---

# 3. WDR 模式是什么？为什么 X 帧 WDR 使用 X 路 RX？

这个问题很关键，我分成“图像意义”和“驱动实现意义”两部分说。

---

## 3.1 WDR 是什么

WDR = **Wide Dynamic Range**，宽动态范围。

它要解决的问题是：

- 同一个场景里同时有很亮和很暗的区域
- 单次曝光无法同时兼顾高光和暗部
- 曝光长了，高光过曝
- 曝光短了，暗部全黑

### 所以 WDR 的做法是：
拍多张不同曝光的 RAW 帧，然后融合。

典型情况：

- **2帧 WDR**  
  一张短曝光（保高光） + 一张长曝光（保暗部）
- **3帧 WDR**  
  短曝光 + 中曝光 + 长曝光

最后 ISP 再把这些 RAW 帧融合为一帧动态范围更大的图像。

---

## 3.2 为什么叫 2F / 3F

驱动里你能看到：

- `ISP_DOL_WDR_MODE`
- `ISP_3FDOL_WDR_MODE`

这里的 `2F / 3F` 就是 2-frame / 3-frame。

---

## 3.3 为什么 X 帧 WDR 要用 X 路 RX

先给结论：

> 因为 TDM 硬件需要把每一个曝光帧当成一条独立的 RAW 输入流来接收、缓存、调度。  
> 所以 2 帧 WDR 需要 2 个 RX，3 帧 WDR 需要 3 个 RX。

这是由 **硬件接收模型** 决定的，不只是概念上“有 2 张图”。

---

## 3.4 从驱动代码上看最清楚

### 3帧 WDR：主通道复制到 `rx1/rx2`

```1098:1128:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
if (tdm_rx->ws.wdr_mode == ISP_3FDOL_WDR_MODE) {
	...
	tdm_rx1 = &tdm->tdm_rx[1];
	tdm_rx2 = &tdm->tdm_rx[2];
	tdm_rx_cpy(tdm_rx, tdm_rx1);
	tdm_rx_cpy(tdm_rx, tdm_rx2);
	...
}
```

说明 3F WDR 时：
- `rx0`：主通道
- `rx1`：第二曝光帧
- `rx2`：第三曝光帧

---

### 2帧 WDR：主通道复制到 `rx1` 或 `rx3`

```1129:1163:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
} else if (tdm_rx->ws.wdr_mode == ISP_DOL_WDR_MODE) {
	...
	if (tdm_rx->id == 0) {
		...
		tdm_rx1 = &tdm->tdm_rx[1];
		tdm_rx_cpy(tdm_rx, tdm_rx1);
	} else if (tdm_rx->id == 2) {
		...
		tdm_rx3 = &tdm->tdm_rx[3];
		tdm_rx_cpy(tdm_rx, tdm_rx3);
	}
}
```

说明 2F WDR 时：
- 如果从 `rx0` 启动，则配对占用 `rx0 + rx1`
- 如果从 `rx2` 启动，则配对占用 `rx2 + rx3`

---

## 3.5 通道模式定义也明确说明了这个关系

```33:39:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/tdm200/tdm200_reg.h
enum  rx_chn_cfg_mode {
	LINEARx4 = 0x0,
	WDR_2F_AND_LINEARx2,
	WDR_2Fx2,
	WDR_3F_AND_LINEAR,
};
```

这些模式的含义是：

- `LINEARx4`  
  四路都当普通线性输入
- `WDR_2F_AND_LINEARx2`  
  两路组成一组 2F WDR，剩下两路做普通 linear
- `WDR_2Fx2`  
  两组 2F WDR
- `WDR_3F_AND_LINEAR`  
  三路做 3F WDR，剩一路普通 linear

这已经从硬件模式层面说明了：  
**X 帧 WDR 必须占 X 路 RX。**

---

## 3.6 为什么不能“一个 RX 接三帧”？

因为在 TDM 这个硬件设计里，RX 是：
- 独立配置 width/height/格式/buffer/FIFO 的接收通道
- 每一路 RX 在硬件上有自己的状态、DMA、错误统计

WDR 的多帧虽然来自同一颗 sensor，但在 TDM 视角，这些帧需要被：
- 分别缓存
- 分别管理行/帧边界
- 分别参与后续 TX 或 ISP 输入组织

所以最自然、也最稳定的硬件实现方式就是：
- 每个曝光帧占一个 RX 通道

这也是为什么驱动里要做：
- `tdm_rx_cpy()`：复制主通道的格式/尺寸到其他 RX
- `bitmap_chn_use`：标记多个 RX 已被一个 WDR 流占用
- `tdm_check_wdr_mode()`：防止冲突占用

---

## 3.7 图像算法角度再直观一点

假设你有 2F WDR：

- `Frame S`：短曝光
- `Frame L`：长曝光

ISP 融合时需要：
- 同时知道 S 和 L
- 对齐两帧的内容
- 逐像素融合高光和暗部信息

如果驱动/硬件没有把它们分成两个独立输入流，那后面就很难同步、缓存和处理。  
所以从 ISP 输入模型上，也很自然地对应为 2 路 RX。

同理 3F：
- `S` / `M` / `L`
- 对应 3 路 RX

---

# 4. 结合你这个 `gc2053_mipi` 场景，WDR 当前有没有真正用上？

从你给的 `board.dts` 来看，**没有看到显式开启 gc2053 的 WDR 模式**，而且 `gc2053_mipi.c` 目前你给我看到的这部分也主要是 normal 的线性模式寄存器组。

所以在你当前板级配置下，更符合的是：

- 两颗 GC2053
- 两条独立 normal 流
- 通过 `tdm_rx0` / `tdm_rx1` 分别接入 TDM
- 最终分别进入 `isp0` / `isp1`

也就是说目前 TDM 的作用更偏向：

- 作为 `CSI -> ISP` 的统一中间层
- 做 offline mode 下的 RAW 接收/缓存/传递
- 统一支持以后切到 WDR、多路同步、offline raw handle 的能力

而不是当前就在做多帧 WDR 聚合。

---

# 5. 最后给你一个“对这块板的最简理解图”

## 5.1 当前 normal 模式，两颗 GC2053

```text
gc2053_mipi      -> mipi0 -> csi0 -> tdm0.rx0 -> isp0 -> scaler/vinc -> video
gc2053_mipi_2    -> mipi1 -> csi1 -> tdm0.rx1 -> isp1 -> scaler/vinc -> video
```

这里：
- `tdm0` 是同一个控制器
- `rx0/rx1` 是两个独立接收通道
- DTS 中 `vinc*_tdm_rx_sel` 决定每条链路走哪个 RX

---

## 5.2 如果以后切到 2F WDR

假设某一路 sensor 开 2F WDR，则会变成类似：

```text
sensor0(2F WDR) -> csi0 -> tdm0.rx0 + tdm0.rx1 -> isp0(wdr merge)
```

其中：
- `rx0` 接一帧曝光
- `rx1` 接另一帧曝光

---

## 5.3 如果以后切到 3F WDR

```text
sensor0(3F WDR) -> csi0 -> tdm0.rx0 + tdm0.rx1 + tdm0.rx2 -> isp0(wdr merge)
```

---

# 6. 针对你的三个问题，压缩总结一句话

### 问题1：DTS 中 TDM 如何发挥作用？
答：  
通过 `vinc*_tdm_rx_sel` 把每条 video pipeline 明确路由成 `CSI -> TDM_RX -> ISP`，`vin.c` 会据此建立 media link，`vin_tdm.c` 再负责具体 RX/TX/buffer/中断控制。

### 问题2：normal 模式下 TDM 如何接收多路 CSI 并输出 ISP？
答：  
不是一条 RX 接多路，而是 **一个 TDM 控制器下有多路 RX 通道**；每路 CSI 绑定一个 RX，TDM 对每个 RX 分别收 RAW、配 buffer、必要时经内部 TX 再送 ISP。

### 问题3：WDR 是什么，为什么 X 帧 WDR 要占 X 路 RX？
答：  
WDR 是多曝光融合；X 帧 WDR 本质上有 X 张不同曝光 RAW 帧要同时被接收、缓存、同步、送往 ISP 融合，因此硬件上最自然的实现就是占用 X 个 RX 通道。

---

如果你愿意，我下一步可以继续帮你做两件更深入的事：

1. **把你这份 `100ask/board.dts` 里的 `vinc00/vinc01` 逐节点映射成完整 media pipeline 图**  
2. **继续结合 `gc2053_mipi.c` 深挖：这颗 sensor 如果要改成 WDR，需要改哪些寄存器和 VIN/TDM 哪些配置**

