# VIN framework configuration analysis
_Exported on 2026/4/14 at GMT+8 21:39:29 from Cursor (2.6.21)_

---

**User**

1、@lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c@device/config/chips/v853/configs/100ask/board.dts  结合全志VIN框架，分析一下@board.dts (270-281) 类似这些配置的sel、ch选择是可以随意搭配的吗？还是遵循某些硬件流程，就比如vinc0_isp_sel = <0>;只能搭配vinc0_mipi_sel = <0>;？
2、你可以参考docs/V85x文档/差异化开发指南/V85X_Tina_Linux_Camera_通路配置指南.pdf中的配置指南，它说ISP00 固定连接 VIPP00、VIPP10、VIPP20 和 VIPP30
• ISP01 固定连接 VIPP01、VIPP11、VIPP21 和 VIPP31
• ISP02 固定连接 VIPP02、VIPP12、VIPP22 和 VIPP32
• ISP03 固定连接 VIPP02、VIPP12、VIPP22 和 VIPP32
支持四路 TDM_RX，分别对应四路 ISP 虚体，即 4 路线性：TDM_RX0 连接 ISP00、TDM_RX1 连
接 ISP01、TDM_RX2 连接 ISP02、TDM_RX3 连接 ISP03。
• 2F‑WDR + 2 路线性：TDM_RX0 连接 ISP00、TDM_RX2 连接 ISP02、TDM_RX3 连接 ISP03。
• 2F‑WDR + 2F‑WDR：TDM_RX0 连接 ISP00、TDM_RX2 连接 ISP02
等，为什么这么说？

---

**Cursor**

我结合你给的 `board.dts`、`vin.c` 和 VIN 结构体看了一遍，结论先说：

**这些 `sel/ch` 不是可以随意搭配的。**
它们表面上是 DTS 里的“选择项”，但本质上是在描述 **VIN 硬件内部固定/半固定的连接拓扑**。  
所以：

- 有些项只是“选哪个模块实例”，例如 `csi_sel`、`mipi_sel`、`tdm_rx_sel`
- 有些项是在“选 ISP 虚体 / ISP 输出通道”，例如 `isp_sel`、`isp_tx_ch`
- 这些值之间 **必须满足底层硬件的连线关系**
- 驱动里很多地方只是“照着你填的值去建链/配寄存器”，**不一定替你检查非法组合**

所以你问的这种：

> `vinc0_isp_sel = <0>;` 只能搭配 `vinc0_mipi_sel = <0>;` 吗？

**不一定是“只能”这一种一一绑定关系，但绝对不是任意乱配。**  
它遵循的是一条更底层的硬件数据流：

**sensor -> mipi/bt601 -> csi -> (可选 tdm_rx) -> isp(虚体) -> vipp/scaler -> video**

---

## 1. 先看你 `board.dts` 这段配置到底在表达什么

你现在 `100ask/board.dts` 270 行附近是：

```270:292:device/config/chips/v853/configs/100ask/board.dts
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

这段不是“驱动随便分配资源”，而是在告诉 VIN：

- `vinc0` 这一路视频节点，前端接 `CSI0`
- 物理输入来自 `MIPI0`
- 走 `ISP 虚体 0`
- ISP 输出取 `tx_ch 0`
- 如果启用了 TDM，则用 `TDM_RX0`

`vinc1` 同理：

- 接 `CSI1`
- 来自 `MIPI1`
- 走 `ISP 虚体 1`
- TDM 用 `RX1`

这本身已经表现出一种“成组对齐”的配置风格了，不是随便写的。

---

## 2. 驱动结构体里这些字段确实就是整个通路选择

`vin_core` 里直接就有这些字段：

```77:89:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.h
struct vin_core {
	...
	unsigned int sensor_sel;
	unsigned int csi_sel;
	unsigned int mipi_sel;
	unsigned int csi_ch;
	unsigned int isp_sel;
	unsigned int tdm_rx_sel;
	unsigned int vipp_sel;
	unsigned int isp_tx_ch;
	...
};
```

说明 DTS 里这些值最后就是进入 `vin_core`，作为 **这一路 vinc 的硬件通路描述**。

---

## 3. 从 `vin.c` 看，驱动是按你填的值去建媒体链路的

### 3.1 CSI -> TDM_RX -> ISP，或者 CSI -> ISP

`vin_create_media_links()` 里非常清楚：

```1678:1716:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
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

这里的意思是：

- 如果 `tdm_rx_sel` 有效，则链路是 `CSI -> TDM_RX -> ISP`
- 否则是 `CSI -> ISP`

这已经说明：
**`tdm_rx_sel`、`csi_sel`、`isp_sel` 是一条链路上的级联选择，不是互相独立的标签。**

---

### 3.2 ISP -> VIPP/scaler 的链接也是按对应选择走

默认 link 建立里：

```1820:1847:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		/*ISP*/
		if (vinc->isp_sel == 0xff)
			isp = NULL;
		else
			isp = vind->isp[vinc->isp_sel].sd;

		/*SCALER*/
		if (vinc->vipp_sel == 0xff)
			scaler = NULL;
		else
			scaler = vind->scaler[vinc->vipp_sel].sd;
		if (isp && scaler)
			link = media_entity_find_link(&isp->entity.pads[ISP_PAD_SOURCE],
						      &scaler->entity.pads[SCALER_PAD_SINK]);
```

说明 `vipp_sel` 也不是想接哪个 ISP 就接哪个 ISP，而是先找到 **你选中的 ISP 实体**，再去找它和 **对应 scaler/vipp** 的 link。

---

## 4. 更关键的一点：底层寄存器配置里已经体现“虚体/输出通道”的硬件映射关系

你前面 grep 到的关键调用其实最能说明问题：

```c
csic_isp_input_select(vind->id,
		      vinc->isp_sel/ISP_VIRT_NUM,
		      vinc->isp_sel%ISP_VIRT_NUM + 0,
		      vinc->csi_sel,
		      vinc->csi_ch & 0xf);
```

以及：

```c
csic_vipp_input_select(vind->id,
		       vinc->vipp_sel/VIPP_VIRT_NUM,
		       vinc->isp_sel/ISP_VIRT_NUM,
		       vinc->isp_tx_ch);
```

虽然这次没把完整上下文精确抓出来，但光这两个调用就足够说明架构了：

---

### 4.1 `isp_sel` 不是简单“ISP 编号”，而是“逻辑 ISP/虚体编号”

`isp_sel/ISP_VIRT_NUM`

说明驱动把 `isp_sel` 拆成两部分：

- 商：落到哪个 **物理 ISP**
- 余：落到该 ISP 下哪个 **虚体/虚通道**

也就是说：

**`isp_sel` 是“物理 ISP + 虚体号”的编码值，不是裸的 0/1/2/3 那么简单。**

这就和你文档里说的：

- ISP00 固定连接 VIPP00、VIPP10、VIPP20、VIPP30
- ISP01 固定连接 VIPP01、VIPP11、VIPP21、VIPP31
- ...

是完全一致的。

也就是：

- 每个物理 ISP 后面挂 4 个 VIPP 虚输出
- `isp_tx_ch` 决定取这个 ISP 的哪一个输出通道
- `vipp_sel` 决定你最终使用哪个 VIPP 实体

---

### 4.2 `csic_vipp_input_select(... isp_sel/ISP_VIRT_NUM, isp_tx_ch)` 说明 VIPP 输入来自“某个物理 ISP 的某个 tx 通道”

也就是说，VIPP 的输入不是随便从任意 ISP 来的，而是：

- 先确定一个物理 ISP
- 再从这个 ISP 的 `tx_ch` 中选择一路输出

所以如果你把：

- `isp_sel` 选到了某个物理 ISP
- 但 `vipp_sel`/`isp_tx_ch` 选到了不属于它那组的组合

那就和硬件内部固定 mux 拓扑冲突了。

---

## 5. 为什么文档会说 “ISP00 固定连接 VIPP00/10/20/30”？

这句话容易误解，我给你翻译成硬件视角：

### 它不是说：
“软件约定最好这么配”

### 而是在说：
“**芯片内部 crossbar / mux 就是这么布线的**”

也就是每个 ISP 物理核只连到一组固定编号规律的 VIPP 虚接口。

你可以把它理解成矩阵：

- `ISP00 -> VIPP00 / VIPP10 / VIPP20 / VIPP30`
- `ISP01 -> VIPP01 / VIPP11 / VIPP21 / VIPP31`
- `ISP02 -> VIPP02 / VIPP12 / VIPP22 / VIPP32`
- `ISP03 -> VIPP03 / VIPP13 / VIPP23 / VIPP33`

你贴的文档里最后一行 “ISP03 固定连接 VIPP02、VIPP12、VIPP22 和 VIPP32”  
**这个大概率是文档笔误**。按前面规律和架构一致性，正常应当是：

- `ISP03 -> VIPP03 / VIPP13 / VIPP23 / VIPP33`

否则 ISP02 和 ISP03 就重叠了，明显不合常理。

---

## 6. 为什么 TDM_RX 也说是固定接 ISP00/01/02/03？

文档说：

- `TDM_RX0 -> ISP00`
- `TDM_RX1 -> ISP01`
- `TDM_RX2 -> ISP02`
- `TDM_RX3 -> ISP03`

这也不是驱动策略，而是 **TDM 模块和 ISP 虚体之间的固定硬件连接关系**。

从功能上理解：

TDM 是为了多路/宽动态 RAW 输入做聚合和分发。  
每个 `TDM_RXx` 在硬件里就是接到某个固定 ISP 虚体入口。

所以：

- 你不能把 `tdm_rx_sel = 0`，同时又想让它喂给 `isp_sel = 3`
- 除非 `isp_sel=3` 在编码后实际仍映射到那个固定入口，否则就是错配

也就是说：

**TDM_RXx 和 ISPxx 是“定向连接”的，不是运行时可任意交换的。**

---

## 7. 所以 `vinc0_isp_sel = <0>;` 是否必须配 `vinc0_mipi_sel = <0>;`

### 结论：
**不应该简单理解成“必须严格相等”，而应该理解成“必须满足整条通路所在的硬件域一致”。**

---

### 7.1 `mipi_sel` 和 `isp_sel` 不是一个层级的资源

- `mipi_sel`：选前端 MIPI 接收器实例
- `csi_sel`：选 CSI parser/bridge
- `tdm_rx_sel`：选 TDM 接收口
- `isp_sel`：选 ISP 虚体
- `isp_tx_ch`：选 ISP 输出通道

所以它们不是“字段值必须相等”的关系。

比如理论上你要看的是：

**MIPIx 是否进得了 CSIy，CSIy 是否能连到 TDM_RXz / ISPn**

而不是只看 `mipi_sel == isp_sel` 这种表面数字。

---

### 7.2 但在 V853 的常见 linear/TDM 场景下，它们经常会“看起来对齐”

比如你现在的配置：

- `vinc0: csi0 / mipi0 / isp0 / tdm0`
- `vinc1: csi1 / mipi1 / isp1 / tdm1`

这是因为板级设计和默认硬件通路本身就是成组排列的，所以数字通常同步增长。  
**这是一种“硬件自然映射”，不是纯软件语法要求。**

所以：

- `vinc0_isp_sel = <0>` 经常配 `vinc0_mipi_sel = <0>`
- `vinc1_isp_sel = <1>` 经常配 `vinc1_mipi_sel = <1>`

但根因不是“DTS 字段必须相等”，而是：

> `MIPI0 -> CSI0 -> TDM_RX0 -> ISP00`  
> `MIPI1 -> CSI1 -> TDM_RX1 -> ISP01`

这条硬件链恰好对应了同号资源。

---

## 8. 你贴的文档那些模式为什么这样规定？

比如：

### 4 路线性
- `TDM_RX0 -> ISP00`
- `TDM_RX1 -> ISP01`
- `TDM_RX2 -> ISP02`
- `TDM_RX3 -> ISP03`

因为四路输入分别占用四个独立 ISP 虚体入口。

---

### 2F-WDR + 2 路线性
- `TDM_RX0 -> ISP00`
- `TDM_RX2 -> ISP02`
- `TDM_RX3 -> ISP03`

这类模式本质上是 **某些 ISP/TDM 资源要成对或按固定槽位占用**。

例如 2F-WDR 常常会占掉一个特定的 TDM/ISP 资源组，使得某些槽位不能再拿来当普通线性路由。  
所以可用组合不是 0/1/2/3 任意选四个，而是由 ISP 虚体组织方式和 WDR 合成逻辑决定。

---

### 2F-WDR + 2F-WDR
- `TDM_RX0 -> ISP00`
- `TDM_RX2 -> ISP02`

这说明 WDR 资源是按偶数组、按固定入口部署的。  
原因通常是：

- 一组 WDR 需要固定的多帧/长短曝光输入组织
- ISP 内部合成单元挂在固定虚体组上
- TDM 的 packing / channel merge 也只对应这些固定组

所以不是“驱动懒得支持别的组合”，而是 **硬件就是这么切分资源的**。

---

## 9. 从驱动角度看，为什么会让人误以为“可以随便配”？

因为 `vin.c` 里面很多代码是：

- 读 `vinc->xxx_sel`
- 然后直接拿这个编号去找 subdev、建 link、配 mux

例如前面的：

```1678:1706:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
if (vinc->tdm_rx_sel == 0xff)
	tdm_rx = NULL;
else
	tdm_rx = vind->tdm[vinc->tdm_rx_sel/TDM_RX_NUM].tdm_rx[vinc->tdm_rx_sel].sd;

if (vinc->isp_sel == 0xff)
	isp = NULL;
else
	isp = vind->isp[vinc->isp_sel].sd;
```

以及默认 ISP->VIPP link：

```1829:1843:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
if (vinc->vipp_sel == 0xff)
	scaler = NULL;
else
	scaler = vind->scaler[vinc->vipp_sel].sd;
if (isp && scaler)
	link = media_entity_find_link(&isp->entity.pads[ISP_PAD_SOURCE],
				      &scaler->entity.pads[SCALER_PAD_SINK]);
```

这里没有看到很强的“非法组合校验”，所以：
**DTS 里你写错了，驱动未必报得很明白，但最终链路可能不通、出帧异常、ISP 不工作、media link 找不到、或者图像错误。**

---

## 10. 对你这个板子的实际判断

你现在 `100ask` 这套默认配置：

- `vinc0: csi0 / mipi0 / isp0 / tx0 / tdm0`
- `vinc1: csi1 / mipi1 / isp1 / tx0 / tdm1`

这是非常典型的 **按硬件自然序号一一对应** 的写法，基本就是遵循了文档里的固定通路分配。

### 因此：
- **不是随意搭的**
- 也不是单纯要求 `isp_sel == mipi_sel`
- 而是遵循了整条链路的固定连接：
  - 前端物理输入归属
  - CSI parser 归属
  - TDM_RX 与 ISP 虚体固定归属
  - ISP 与 VIPP 输出组固定归属

---

## 11. 最后给你一个实用判断规则

以后看这类配置，不要问“数字能不能随便改”，而要按下面顺序判断：

### 第一层：前端输入
- `sensor` 接在哪个 `mipi/csi`

### 第二层：解析/聚合
- `csi_sel` 是否和前端输入对应
- 若启用 TDM，`tdm_rx_sel` 是否是这路输入可进入的 RX

### 第三层：ISP
- `isp_sel` 是否对应这个 `tdm_rx`/`csi` 可以送达的 ISP 虚体

### 第四层：输出
- `isp_tx_ch` 是否是这个 ISP 下有效输出
- `vipp_sel` 是否属于这个 ISP 固定连接组

---

## 12. 直接回答你的两个问题

### 问题 1
> `board.dts` 这些配置的 `sel/ch` 可以随意搭配吗？

**不可以。**  
它们必须服从 VIN 硬件固定的数据流和 mux 连接关系。

### 问题 1-补充
> 比如 `vinc0_isp_sel = <0>;` 只能搭配 `vinc0_mipi_sel = <0>;` 吗？

**不能机械理解成“必须等号绑定”**，但在你这个平台的常见连接里，往往确实是同号配套。  
真正约束它们的是整条链路的硬件归属，而不是字段数值字面相等。

---

### 问题 2
> 文档为什么说 ISP00 固定连 VIPP00/10/20/30，TDM_RX0 固定连 ISP00 等？

因为这反映的是 **芯片内部硬件布线/交叉开关的固定拓扑**，不是软件建议。  
驱动中的 `csic_isp_input_select(...)`、`csic_vipp_input_select(...)` 这类调用也正是在按这种拓扑去配置寄存器。

---

如果你愿意，我下一步可以继续帮你做两件事之一：

1. **把 V853 的 `vincX_csi_sel / mipi_sel / tdm_rx_sel / isp_sel / isp_tx_ch / vipp_sel` 关系画成一张表**
2. **直接结合你这个 `board.dts`，分析如果把 `vinc0_mipi_sel` 改成 `1`、或者把 `vinc1_isp_sel` 改成 `0`，具体会出现什么问题**

---

**User**

请你结合具体驱动，详细分析一下你提到的”因为板级设计和默认硬件通路本身就是成组排列的，所以数字通常同步增长。
这是一种“硬件自然映射”“，找出具体驱动层面的实现，并分析一下哪些是硬件连好的，而哪些是可以在驱动层动态配置的？

继续

---

**Cursor**

继续，我把这件事往“**具体驱动实现**”再掰开讲，并且明确区分：

1. **哪些是板级/芯片内部已经固定连好的**
2. **哪些是驱动层还能动态选路的**
3. **为什么在 `board.dts` 里经常看到 `0/1/2/...` 同步增长**

---

# 一、先看结论

你前面提到的：

> “因为板级设计和默认硬件通路本身就是成组排列的，所以数字通常同步增长。这是一种硬件自然映射”

如果结合驱动代码，实际上可以拆成两层：

---

## 第 1 层：**板级物理连接固定**
例如某颗 sensor 焊在：

- `MIPI0` 或 `MIPI1`
- 或并口接 `CSI0/1/2`
- GPIO、电源、reset、pwdn 都固定在某组引脚上

这一层不是驱动“选”出来的，而是 **硬件焊死 + DTS 描述**。

---

## 第 2 层：**芯片内部有一部分 mux 可配置，但不是全连接任意交叉**
也就是：

- `CSI/parser -> ISP` 不是完全自由
- `ISP -> VIPP` 也不是完全自由
- `TDM_RX -> ISP 虚体` 同样遵循固定资源组

驱动能做的是：
- 在 **芯片允许的拓扑范围内** 写寄存器做选择

驱动不能做的是：
- 把硬件根本没连通的路径“软件打通”

---

# 二、DTS 这组配置在驱动里对应什么

你当前 DTS 这一段：

```270:289:device/config/chips/v853/configs/100ask/board.dts
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

而 `vin_core` 里这些字段是整条链路的核心描述：

```83:98:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.h
unsigned char large_image;/*2:get merge yuv, 1: get pattern raw (save in kernel), 0: normal*/
unsigned int rear_sensor;
unsigned int front_sensor;
unsigned int sensor_sel;
unsigned int csi_sel;
unsigned int mipi_sel;
unsigned int csi_ch;
unsigned int isp_sel;
unsigned int tdm_rx_sel;
unsigned int vipp_sel;
unsigned int isp_tx_ch;
unsigned int vin_clk;
unsigned int delay_init;
```

也就是说，DTS 里的这些 `*_sel` 最终都会进入 `vin_core`，作为这一路 `vinc` 的通路选择参数。

---

# 三、先区分“sensor 物理归属”和“VIN 内部路由”

这个很关键，很多人会混在一起。

---

## 3.1 sensor 属于哪个 CSI，是在 `parse_modules_from_device_tree()` 里先落到 `modules[]/sensors` 的

看 `config.c`：

```872:903:lichee/linux-4.9/drivers/media/platform/sunxi-vin/utility/config.c
for_each_available_child_of_node(parent, child) {
	if (strcmp(child->name, "vinc"))
		continue;

	sprintf(property, "%s_rear_sensor_sel", child->type);
	if (get_value_int(child, property, &i))
		i = 0;
	module = &vind->modules[i];
	sensors = &module->sensors;
	sprintf(property, "%s_csi_sel", child->type);
	get_value_int(child, property, &sensors->csi_sel);

	if (sensors->use_sensor_list == 0xff) {
		sprintf(property, "%s_sensor_list", child->type);
		get_value_int(child, property, &sensors->use_sensor_list);
	}
	...
```

这里其实做了两件事：

1. 根据 `vincX_rear_sensor_sel / front_sensor_sel` 找到对应 `module`
2. 把 `vincX_csi_sel` 写回这个 sensor module 的 `sensors->csi_sel`

这说明：

- `rear_sensor_sel/front_sensor_sel` 是在选 **哪个 sensor 模块**
- `csi_sel` 同时也在告诉这个 sensor module：它属于哪个 CSI 域

---

## 3.2 但 `mipi_sel / isp_sel / tdm_rx_sel / isp_tx_ch / vipp_sel` 是另一层：VIN 内部数据通路选择

这些不是 sensor 模块自己的属性，而是某一路 `vinc` 的处理链路属性。  
也就是说：

- `rear_sensor_sel/front_sensor_sel` 更像“源头是谁”
- `csi/mipi/tdm/isp/vipp` 更像“数据怎么走”

---

# 四、哪些是“硬件固定连好的”

下面我按链路逐层拆。

---

## 4.1 sensor -> MIPI/CSI：**板级固定**

这个层面驱动只能“认领”，不能改线。

比如一个 sensor 焊在 `MIPI0`，你在软件里写成 `mipi_sel = 1`，不代表它会 magically 跑到 `MIPI1`。  
真正决定这一点的是：

- 板子的走线
- sensor 所接的 PHY / data lane
- 设备树里的 sensor 节点和电源/引脚/总线配置

所以：

### 硬件固定的部分
- 某个 sensor 接哪组 MIPI D-PHY / CSI 引脚
- 供电/复位/时钟/总线控制器

### 驱动可配置的部分
- 让哪个 `vinc` 去使用这个 sensor
- 设置 MIPI 模式/位宽/格式
- 建 media link

---

## 4.2 `CSI/parser -> ISP`：**不是完全自由，而是受 `isp_input[][][][]` 固定表约束**

这是你最关心的“硬件自然映射”的关键证据。

在 `top_reg.c` 里有一张静态查表：

```21:41:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
/*isp_id isp_input pasrer_id parser_ch*/
static char isp_input[4][4][4][4] = {
#if defined(CONFIG_ARCH_SUN50IW3P1) || defined(CONFIG_ARCH_SUN50IW6P1)
	/*isp0 input0~3*/
		/*parser0*/     /*parse1*/    /*parser2*/    /*parser3*/
	{
		{{0, 0, 0, 0}, {1, 2, 0, 0}, {0, 0, 0, 0}, {0, 0, 0, 0} },
		{{0, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 0, 0}, {0, 0, 0, 0} },
		...
	},
```

虽然这里不同 SoC 分支不同，但本质都是一样：

> **并不是驱动随便把 parser/ch 接到 ISP input，而是必须从这张预定义映射表里查一个值写进寄存器。**

对应的寄存器写法在这里：

```223:236:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
void csic_isp_input_select(unsigned int sel, unsigned int isp, unsigned int in,
				unsigned int psr, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_ISP0_IN0_REG_OFF + isp * 16 + in * 4,
			isp_input[isp][in][psr][ch]);
}
```

这行非常关键，含义是：

- 驱动传入 `isp / in / parser / ch`
- 但真正写入寄存器的值不是这些参数本身
- 而是 **查表 `isp_input[isp][in][psr][ch]` 得到的预定义编码**

### 这意味着什么？
这说明：

- `parser -> isp input` 的连接关系，**底层硬件是预布好的**
- 驱动只能在这些预定义入口中切换
- **不是任意 parser/ch 都能喂给任意 ISP input**

所以这就是“硬件自然映射”的第一个非常具体的驱动证据。

---

## 4.3 `ISP -> VIPP`：同样不是任意交叉，而是由 `vipp_input[][][]` 限定

同样在 `top_reg.c`：

```128:149:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
/*vipp_id isp_id isp_ch*/
static char vipp_input[8][4][4] = {
#if defined(CONFIG_ARCH_SUN50IW3P1) || defined(CONFIG_ARCH_SUN50IW6P1)
	/*vipp0*/
	/*isp0*/        /*isp1*/      /*isp2*/       /*isp3*/
	{{0, 0, 0, 0}, {1, 0, 0, 0}, {0, 0, 0, 0}, {0, 0, 0, 0} },

	{{0, 2, 0, 0}, {1, 3, 0, 0}, {0, 0, 0, 0}, {0, 0, 0, 0} },

	{{0, 0, 2, 0}, {1, 0, 3, 0}, {0, 0, 0, 0}, {0, 0, 0, 0} },

	{{0, 0, 0, 2}, {1, 4, 0, 3}, {0, 0, 0, 0}, {0, 0, 0, 0} },
...
```

然后对应寄存器写法：

```231:236:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
void csic_vipp_input_select(unsigned int sel, unsigned int vipp,
				unsigned int isp, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_VIPP0_IN_REG_OFF + vipp * 4,
			vipp_input[vipp][isp][ch]);
}
```

这说明：

- VIPP 的输入选择也不是“任意 ISP 任意 channel 都能接”
- 也是先查 `vipp_input[vipp][isp][ch]`
- 只有查表里定义过的组合才有意义

这正好对应你文档里那种说法：

- `ISP00` 固定挂某一组 VIPP
- `ISP01` 固定挂另一组 VIPP
- ...

所以：

### 硬件固定的部分
- 某个 VIPP 能看到哪些 ISP 输出
- 哪些 `isp_ch` 对应哪些 `vipp_id`

### 驱动可配置的部分
- 在允许的组合里，给某个 VIPP 选择输入源

---

## 4.4 `TDM_RX -> ISP 虚体`：也是固定组关系，不是全交叉

虽然 `vin.c` 里 TDM 链路创建看起来很“自由”：

```1680:1706:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
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
}
```

但这只是 **media graph 层面的“连线表达”**。  
它并不代表硬件里 `tdm_rx0` 真能去任意 `ispX`。

真正的限制来自：

- TDM 硬件内部组织方式
- ISP 虚体资源编号
- 文档规定的固定连接组

也就是说：

`vin.c` 这里只是把你 DTS 描述的拓扑注册到媒体图里。  
**媒体图能连，不等于硬件 crossbar 是全连的。**

---

# 五、哪些是驱动层可以动态配置的

现在说“可配置”的部分。

---

## 5.1 可以动态配置：在固定拓扑范围内，选择哪一路输入给 ISP

`csic_isp_input_select()` 就是典型例子：

```223:229:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
void csic_isp_input_select(unsigned int sel, unsigned int isp, unsigned int in,
				unsigned int psr, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_ISP0_IN0_REG_OFF + isp * 16 + in * 4,
			isp_input[isp][in][psr][ch]);
}
```

### 可以动态配置的是：
- 某个 `ISP`
- 某个 `input slot`
- 选择哪一个 `parser/ch`

### 但不能突破的是：
- 这个组合必须存在于 `isp_input[][][][]` 查表中

所以是：

> **可配置，但在固定硬件布线编码表约束下配置**

---

## 5.2 可以动态配置：某个 VIPP 从哪个 ISP channel 取数据

同理：

```231:236:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
void csic_vipp_input_select(unsigned int sel, unsigned int vipp,
				unsigned int isp, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_VIPP0_IN_REG_OFF + vipp * 4,
			vipp_input[vipp][isp][ch]);
}
```

### 可配置：
- `vipp`
- `isp`
- `isp channel`

### 不可突破：
- `vipp_input[][][]` 预定义的可达性

---

## 5.3 可以动态配置：选择 ISP 虚体编号、VIPP 虚体编号

这两个宏是关键：

```18:21:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/isp600/isp600_reg_cfg.h
#define ISP_VIRT_NUM 4
```

```28:31:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/vipp200/vipp200_reg.h
#define VIPP_VIRT_NUM 4
```

说明：

- 每个物理 ISP 下挂 4 个虚体/虚通道
- 每组 VIPP 也按 4 个虚体组织

因此驱动里会出现这种拆分逻辑（你前面已经 grep 到过）：

- `isp_sel / ISP_VIRT_NUM`
- `isp_sel % ISP_VIRT_NUM`
- `vipp_sel / VIPP_VIRT_NUM`

这类写法不是随便写着玩的，而是在把：

- “逻辑编号”
拆成
- “物理模块编号 + 虚通道编号”

### 所以驱动可动态配置的是
- 给 `vinc` 选择某个逻辑 ISP / 逻辑 VIPP

### 但底层固定的是
- 这个逻辑编号最终归属于哪个物理 ISP / 哪组 VIPP
- 以及物理 ISP 与 VIPP 之间的连接矩阵

---

# 六、为什么 DTS 里数字经常同步增长

现在回到你的核心问题：

> 为什么默认配置里总是 `csi0/mipi0/isp0/tdm0`、`csi1/mipi1/isp1/tdm1` 这样同步增长？

答案不是“驱动规定字段必须相等”，而是 **多层约束叠加后的自然结果**。

---

## 6.1 第一层：板级布线通常就是按组放的

比如第 0 路 sensor：

- 焊到 MIPI0
- 对应 CSI0
- 常规也走 ISP0 组
- 如果走 TDM，则也用 RX0

第 1 路 sensor：

- 焊到 MIPI1
- 对应 CSI1
- 对应 ISP1 组
- TDM 用 RX1

这就是板级 natural mapping。

---

## 6.2 第二层：芯片内部 ISP/VIPP/TDM 也按组组织

从驱动的查表和 `ISP_VIRT_NUM/VIPP_VIRT_NUM` 就能看出来：

- ISP 是按虚体组组织的
- VIPP 也是按虚体组组织的
- TDM 也是按 RX 组组织的

所以如果板级又恰好按 `0/1/2/3` 资源组排布，最终 DTS 自然就会写成同步增长。

---

## 6.3 第三层：`vin.c` 的媒体链路也默认按编号索引取 subdev

例如：

```1684:1691:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
if (vinc->tdm_rx_sel == 0xff)
	tdm_rx = NULL;
else
	tdm_rx = vind->tdm[vinc->tdm_rx_sel/TDM_RX_NUM].tdm_rx[vinc->tdm_rx_sel].sd;
/*isp*/
if (vinc->isp_sel == 0xff)
	isp = NULL;
else
	isp = vind->isp[vinc->isp_sel].sd;
```

以及：

```1828:1838:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
if (vinc->vipp_sel == 0xff)
	scaler = NULL;
else
	scaler = vind->scaler[vinc->vipp_sel].sd;
if (isp && scaler)
	link = media_entity_find_link(&isp->entity.pads[ISP_PAD_SOURCE],
				      &scaler->entity.pads[SCALER_PAD_SINK]);
```

所以从驱动层表现出来就是：

- 你填 0，它去拿第 0 个子设备
- 你填 1，它去拿第 1 个子设备

这又进一步强化了“同号对应”的使用习惯。

---

# 七、所以哪些“看起来能改”，其实不能乱改？

下面给你一个最实用的分类。

---

## A. 基本属于硬件固定 / 板级固定的

### 1) `mipi_sel`
如果 sensor 物理上就接在 `MIPI0`，那它通常不能随便改成 `1`。

### 2) `csi_sel`
如果这路前端物理 parser/CSI 域就是 `CSI0`，通常不能随便换到别的 CSI 域。

### 3) `rear_sensor_sel / front_sensor_sel`
这决定你选择哪个 sensor 模块，属于资源归属，不是 ISP 内部 mux。

---

## B. 受芯片内部固定拓扑约束，但驱动里可选

### 4) `isp_sel`
可选，但不是任意值都合法。  
因为它背后受：

- `ISP_VIRT_NUM`
- `csic_isp_input_select()`
- `isp_input[][][][]`

共同限制。

### 5) `isp_tx_ch`
可选，但必须是该 ISP 支持的通道，而且该通道能被目标 VIPP 接到。

### 6) `vipp_sel`
可选，但必须属于目标 ISP 那组可达 VIPP。

### 7) `tdm_rx_sel`
可选，但必须满足该路 CSI 输入可进入哪个 TDM_RX，以及该 TDM_RX 固定对应哪个 ISP 虚体组。

---

## C. 更偏软件策略 / 工作模式选择

### 8) `work_mode`
这个更多是 online/offline 流程策略，不是“改物理连线”。

虽然我这次没完整抓到 DTS 解析它的代码上下文，但从日志逻辑能看出它影响的是 **工作流程模式**，不是决定 parser/isp/vipp 的硬连接关系。

---

# 八、最容易误判的一点：`vin.c` 建 media link 看起来很自由，但不代表硬件真自由

例如这里：

```1678:1711:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
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
```

还有这里：

```1830:1843:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
if (vinc->vipp_sel == 0xff)
	scaler = NULL;
else
	scaler = vind->scaler[vinc->vipp_sel].sd;
if (isp && scaler)
	link = media_entity_find_link(&isp->entity.pads[ISP_PAD_SOURCE],
				      &scaler->entity.pads[SCALER_PAD_SINK]);
```

这些代码做的是：

- 在 Linux media framework 里创建实体关系
- 让 V4L2 pipeline “知道”这条路怎么走

但是：

> **media link 是软件图，不是硬件布线图本身。**

真正能不能跑通，最终还是看：

- 顶层 mux 寄存器写进去的值是否合法
- 那些值是否在 `top_reg.c` 的查表定义里
- 底层硬件有没有这条物理/逻辑通道

---

# 九、把它总结成一句话

你看到的“数字同步增长”不是巧合，也不是纯约定，而是 3 件事叠加：

1. **板级 sensor 到 MIPI/CSI 的物理连接通常按资源号成组**
2. **芯片内部 `CSI/TDM/ISP/VIPP` 只支持某些固定连接矩阵**
3. **驱动用编号索引子设备 + 用查表把编号翻译成合法硬件 mux 编码**

所以最终就呈现为：

- `vinc0 -> csi0 -> mipi0 -> isp0 -> tdm0`
- `vinc1 -> csi1 -> mipi1 -> isp1 -> tdm1`

这种“自然同号映射”。

---

# 十、直接回答你这次的问题

## 哪些是硬件连好的？
- sensor 到 MIPI/CSI 的板级连接
- 芯片内部 `parser -> isp input` 的可达关系  
  证据：`top_reg.c` 的 `isp_input[][][][]`
- 芯片内部 `isp -> vipp` 的可达关系  
  证据：`top_reg.c` 的 `vipp_input[][][]`
- TDM_RX 与 ISP 虚体组的绑定关系  
  这是文档与架构层面的固定组织，不是全交叉

---

## 哪些可以在驱动层动态配置？
- 在 **允许的连接矩阵内**，选择：
  - 哪个 parser/ch 喂给某个 ISP input
  - 哪个 ISP channel 喂给某个 VIPP
  - 哪个 `vinc` 使用哪个逻辑 `isp_sel / vipp_sel / tdm_rx_sel`
- online/offline 等工作模式选择
- media graph 链路启用/默认 link

---

## 哪些不能理解成“任意动态配置”？
- `mipi_sel`
- `csi_sel`
- `tdm_rx_sel`
- `isp_sel`
- `isp_tx_ch`
- `vipp_sel`

这些都不是“自由变量”，而是 **带硬件约束的选择变量**。

---

如果你愿意，我下一步可以继续做两件更具体的事：

1. **把 V853 上 `csi_sel / mipi_sel / tdm_rx_sel / isp_sel / isp_tx_ch / vipp_sel` 画成一张“固定连接 + 可配范围”表**
2. **继续往下追具体函数，找出 `vincX_mipi_sel / isp_sel / isp_tx_ch` 最终在哪个初始化路径里被写进 `vin_core` 并触发 `csic_isp_input_select()` / `csic_vipp_input_select()`**  
   这样就能把“DTS -> vin_core -> top_reg 寄存器”的全链路闭环完全串起来。

