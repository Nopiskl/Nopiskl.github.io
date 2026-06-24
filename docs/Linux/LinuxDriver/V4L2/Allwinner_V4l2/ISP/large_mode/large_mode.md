
---

**User**

agent_output/large_mode_ref.md
请你结合这个文档+全志VIN驱动，分析一下为什么large_mode需要配置vinc01:vinc@1的@large_mode_ref.md (75-76) ？
是否有悖于我们之前的分析？

---

**Cursor**

结合你给的 `large_mode_ref.md` 和 VIN 驱动，我的结论是：

**large_mode 里要求打开 `vinc01:vinc@1`，并不违背我们前面的分析。**  
恰恰相反，它说明：

- 平时看到的 `csi0/mipi0/isp0/tdm0`、`csi1/mipi1/isp1/tdm1` 是**常规自然映射**
- 而 `large_mode` 是 **V85x 硬件专门支持的一种“单路输入 -> 双 ISP 并行处理”的特殊合法拓扑**
- 它不是“随便乱配”，而是**另一种同样受硬件约束的固定模式**

---

# 1. 这个文档 75-76 行本质在说什么

你这份 `large_mode_ref.md` 里面，`vinc01` 的关键配置是：

- `vinc1_csi_sel = <0>;`
- `vinc1_mipi_sel = <0>;`
- `vinc1_isp_sel = <1>;`
- `vinc1_tdm_rx_sel = <1>;`
- `vinc1_rear_sensor_sel = <0>;`
- `vinc1_front_sensor_sel = <0>;`

也就是：

> `vinc01` 和 `vinc00` 共用 **同一个 Sensor0、同一个 MIPI0、同一个 CSI0**，  
> 但后端不再走 `ISP0/TDM_RX0`，而是改走 **`ISP1/TDM_RX1`**。

这正符合文档前面对 2in1 的描述：

- 一路大图进来
- 拆成左右两半
- 左半给 `ISP0`
- 右半给 `ISP1`

所以 **`vinc01` 的存在，不是为了再接第二颗 sensor**，而是为了把**同一颗 sensor 的同一帧大图**引到**第二条 ISP 处理链**。

---

# 2. 为什么必须要有 `vinc01`，不能只配 `vinc00`

这里有一个很关键、很“驱动层”的原因：

在 `vin.c` 里，`vinc` 是按索引 `i` 建立自己的 scaler/capture 链的。

```1716:1734:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		cap_sd = &vinc->vid_cap.subdev;

		/* SCALER */
		scaler = vind->scaler[i].sd;
		if (scaler == NULL)
			continue;
		/*Link Vin Core*/
		source = &scaler->entity;
		sink = &cap_sd->entity;
		ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
					       sink, VIN_SD_PAD_SINK,
					       MEDIA_LNK_FL_ENABLED);
```

这段代码的意思非常直接：

- `vinc@0` 用的是 `scaler[0]`
- `vinc@1` 用的是 `scaler[1]`
- `vinc@4` 用的是 `scaler[4]`
- `vinc@5` 用的是 `scaler[5]`

所以在 2in1 / large_mode 里，如果你只开 `vinc00`：

- 你只能得到 `vinc00 -> scaler0 -> capture0` 这一条输出链
- 即便底层有 `ISP1` 在工作，也没有第二个 `vinc`/`scaler`/`capture` 对应出来

而文档要求同时开 `vinc01`，本质上就是为了把：

- 第二条 ISP 路
- 第二个 scaler/vipp 输出
- 第二个 video/capture 节点

一起拉起来。

---

# 3. 驱动怎么体现“同一个 CSI 源，可以分给两个 ISP”

这点在 `vin.c` 的媒体链里是能看出来的。  
`vin_create_media_links()` 在启用 TDM 时，会按 DTS 配置建：

- `CSI -> TDM_RX`
- `TDM_RX -> ISP`

```1678:1711:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
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

所以在 large_mode 里：

- `vinc00` 建的是  
  `CSI0 -> TDM_RX0 -> ISP0`
- `vinc01` 建的是  
  `CSI0 -> TDM_RX1 -> ISP1`

注意这里最关键的一点：

**两个 `vinc` 的 `csi_sel` 都是 0，是合理的。**  
因为 large_mode 不是“两路 sensor”，而是“**一路 sensor 的同一帧大图，被 TDM/ISP 双路并行处理**”。

---

# 4. 这是不是和我们之前说的“通常数字同步增长”矛盾？

**不矛盾。**

我们前面说的是：

> 在常规单路/双路 camera 配置里，板级设计和默认硬件通路常常成组排列，所以数字通常同步增长。

这个“通常”不是“永远”。

---

## 常规模式
常规情况下你会看到：

- `vinc00: csi0 / mipi0 / isp0 / tdm0`
- `vinc01: csi1 / mipi1 / isp1 / tdm1`

因为这是：

- 两颗 sensor
- 两套前端输入
- 两条互相独立的通路

---

## large_mode
large_mode 下变成：

- `vinc00: csi0 / mipi0 / isp0 / tdm0 / sensor0`
- `vinc01: csi0 / mipi0 / isp1 / tdm1 / sensor0`

这不是乱配，而是：

- **前端共享**
  - 同一个 sensor0
  - 同一个 MIPI0
  - 同一个 CSI0
- **后端分流**
  - 一路进 `TDM_RX0 -> ISP0`
  - 一路进 `TDM_RX1 -> ISP1`

所以 large_mode 实际上是在利用硬件支持的 **“单前端、双后端” 特殊通路**。

---

# 5. 为什么这里共享 `sensor0 / mipi0 / csi0` 是合理的

这个可以从 sensor 绑定逻辑看出来。  
`config.c` 里，`rear_sensor_sel/front_sensor_sel` 决定 `vinc` 选哪个 sensor module：

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
	...
```

所以当文档要求：

- `vinc0_rear_sensor_sel = <0>`
- `vinc1_rear_sensor_sel = <0>`

本质就是让 `vinc00` 和 `vinc01` **都取同一个 `sensor0` 作为源头**。

这正是 2in1 模式该有的语义：  
**不是两路相机，而是一路大图拆成两条 ISP 处理链。**

---

# 6. 为什么后端必须改成 `isp1 / tdm_rx1`

因为文档的目标是：

- `ISP0` 处理左半
- `ISP1` 处理右半

所以第二条链不能还用 `ISP0/TDM_RX0`，必须用另一组后端资源。

这也和驱动里的资源组织吻合：

- `ISP` 是按虚体/逻辑通道组织的
- `TDM_RX` 是按 RX 通道组织的
- 每条 `vinc` 最终要绑定到自己的 ISP/TDM/VIPP 输出链

从底层定义也能看出 ISP/VIPP 是按“每物理模块 4 个虚体”分组的：

```18:22:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/isp600/isp600_reg_cfg.h
#define ISP_VIRT_NUM 4

#define ISP_ADDR_BIT_R_SHIFT 2
```

```28:32:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/vipp200/vipp200_reg.h
#define VIPP_REG_SIZE 0x400
#define VIPP_VIRT_NUM 4
#define VIPP_CHN_INT_AMONG_OFFSET 6
```

这说明 large_mode 本来就是在占用：

- ISP0 这组
- ISP1 这组

两组后端资源。

---

# 7. 更底层地说：这仍然是“硬件允许范围内的可配置”，不是随意改出来的

你前面问过“哪些是硬件固定，哪些是驱动动态配置”。

large_mode 正好是最好的例子：

---

## 固定的部分
- sensor0 物理只接在 `MIPI0/CSI0`
- 2in1 模式的数据拆分能力，是 V85x 硬件/ISP/TDM 支持的固定能力
- `ISP0/ISP1` 是两套真实后端资源，不是软件虚构的

---

## 驱动配置的部分
驱动通过 top mux / media graph，把这条合法拓扑搭出来。

例如 top 层仍然是用固定表写 mux，而不是任意交叉：

```220:236:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
void csic_isp_input_select(unsigned int sel, unsigned int isp, unsigned int in,
				unsigned int psr, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_ISP0_IN0_REG_OFF + isp * 16 + in * 4,
			isp_input[isp][in][psr][ch]);
}

void csic_vipp_input_select(unsigned int sel, unsigned int vipp,
				unsigned int isp, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_VIPP0_IN_REG_OFF + vipp * 4,
			vipp_input[vipp][isp][ch]);
}
```

所以：

- large_mode 不是“反例”
- 它只是说明：**除了常规 one-sensor -> one-ISP 的自然映射外，芯片还支持 one-sensor -> two-ISP 的另一种固定模式**

---

# 8. 那为什么文档偏偏强调 `vinc01`，而不是只说 `ISP1`？

因为在 Allwinner 这套 VIN 框架里，**真正对外暴露和组织视频链的是 `vinc` 节点**，不是单独的 ISP 节点。

你不能只开一个 `isp@1`，还指望系统自动生成第二条完整视频管线。  
必须要有对应的：

- `vinc01`
- 它的 `vid_cap`
- 它的 scaler/vipp
- 它的 media link

这样第二半图的处理输出链才真正成立。

所以文档强调 `vinc01`，其实是站在 **完整 pipeline 配置** 的角度，而不是只盯着 ISP 一个模块。

---

# 9. 顺便说一下 `large_image`

`vin_core` 里确实有这个状态位：

```83:90:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.h
unsigned char stream_idx;
unsigned char fps_ds;
unsigned char use_timer;
unsigned char large_image;/*2:get merge yuv, 1: get pattern raw (save in kernel), 0: normal*/
unsigned int rear_sensor;
unsigned int front_sensor;
```

但从我这次沿 VIN 主通路往下看，**DTS 里 large_mode 是否成立，最直接的决定因素不是这个字段本身，而是你有没有把双 `vinc` + 双 `ISP/TDM` 的通路搭起来。**

也就是说：

- `large_image` 更像运行态/处理态标志
- 而 `vinc00 + vinc01` 这类 DTS 配置，才是在搭 large_mode 的硬件通路骨架

---

# 10. 最终结论

## 为什么 large_mode 需要配置 `vinc01:vinc@1`？
因为 large_mode 不是额外再接一颗 sensor，而是要把 **同一个 sensor0 的大图** 同时送进 **第二条 ISP 处理链**。  
在 Allwinner VIN 框架里，这第二条处理链必须通过 `vinc01` 这类第二个 `vinc` 实例来承载。

---

## 为什么它要和 `vinc00` 共用 `csi0/mipi0/sensor0`？
因为源头就是同一颗 sensor 的同一帧大图。  
large_mode 的本质就是：

- 前端共享
- 后端双 ISP 并行

---

## 是否有悖于我们之前的分析？
**没有。**

之前的分析结论依然成立：

- 这些 `sel` 不是随意搭配的
- 必须服从硬件通路

large_mode 只是说明：

- 除了常规“同号自然映射”以外
- 芯片还支持一种**硬件定义好的特殊合法模式**：
  - 同一 `CSI/MIPI/Sensor`
  - 分流到不同 `TDM_RX/ISP`

它不是推翻之前结论，而是补充了一个 **特殊但仍受硬件约束的模式**。

---

如果你愿意，我下一步可以继续帮你做两件很有价值的事：

1. **把 `large_mode` 的完整通路画成一张表**  
   `sensor0 -> MIPI0 -> CSI0 -> TDM_RX0 -> ISP0 -> vinc00/scaler0`  
   `sensor0 -> MIPI0 -> CSI0 -> TDM_RX1 -> ISP1 -> vinc01/scaler1`

2. **继续往驱动里深挖：找出 2in1/large image 的 split/merge 更具体是在 ISP 内核、VIPP 还是中间件哪一层完成的**

---

**User**

结合agent_output/wdr&multi_vc.md文档，分析一下为什么Largemode不像multi vc那样走一个ISP的不同通道，而是用两个不同的ISP？

---

**Cursor**

可以，结合 `agent_output/wdr&multi_vc.md` 和 VIN 驱动，核心结论是：

## 结论
**LargeMode 和 multi-VC 不是同一类问题，所以它们走的资源层级不同：**

- **multi-VC / WDR**
  - 本质是：**同一条 MIPI/CSI 输入流里，携带多个 VC（virtual channel）子流**
  - 这几路子流仍然属于**同一个前端输入域**
  - 目标通常是给**同一个 ISP 内部的不同处理通道/不同曝光链路**使用

- **LargeMode / 2in1**
  - 本质是：**单帧图像的空间尺寸太大，已经超过单个 ISP 的处理能力上限**
  - 不是“多路子流语义不同”，而是“**单路图像算力/尺寸超限**”
  - 所以必须把一张大图**按空间切成左右两块**，交给**两个不同的 ISP 实体**并行处理，再拼回来

所以：

> **multi-VC 解决的是“流的组织形式”问题；LargeMode 解决的是“单 ISP 算力/尺寸上限”问题。**

因此 LargeMode 不会像 multi-VC 那样优先走“一个 ISP 的不同通道”，而是直接上 **两个 ISP**。

---

# 1. 文档自己已经给出了最直接的原因：LargeMode 是“单 ISP 尺寸不够”

你给的 `large_mode_ref.md` 开头就写得很明确：

```1:10:agent_output/large_mode_ref.md
板级配置‑单目 2in1 模式
V85X 2in1 模式：支持（8M、12M、20M 像素等）高分辨率图像输入，SOC 在通路中将大图拆
分为小图分别处理后，最终拼接回源尺寸图像输出。如下图所示，原图分辨率：4032x3016，
ISP0/ISP1 分别处理左右半图（分辨率：2288x3016），其中蓝色区域为中间缝合区（分辨率：
272x3016，用于 ISP 处理中间图像效果，改善中间区域的拼接痕迹）。
PS：V85X ISP 能处理的最大分辨率为 3072x3072，所以高于这个分辨率的图像均需要开启 2in1 模
式来进行处理。
• CSI 接收源尺寸图像
• 按照比例原图拆分为左右部分，分别送给 ISP0/1 通道
```

这段话其实已经把问题定性了：

### LargeMode 的触发条件
不是因为 sensor 输出了多个 VC，
而是因为：

- 原图太大
- **单个 ISP 最大只能处理 \(3072 \times 3072\)**

所以必须：

- 先收一整张大图
- 再按空间切分
- 左右半图分别进 `ISP0/1`

这跟 multi-VC 的出发点完全不同。

---

# 2. multi-VC 的本质是“同一 CSI 输入里有多个 VC 子流”

从 `wdr&multi_vc.md` 里引用的驱动分析可以看到，multi-VC/WDR 的关键是 sensor 在 `g_mbus_config()` 里告诉上层：  
当前 CSI-2 总线上到底有几个 VC。

例如文档里引用的 `imx664`：

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

然后 CSI 驱动根据这些 flag 统计总共有几个接收通道：

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

然后这个信息继续传给 `vinc`：

```1219:1224:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
	media_entity_graph_walk_cleanup(&graph);

	csi = v4l2_get_subdevdata(pipe->sd[VIN_IND_CSI]);
	vinc->total_rx_ch = csi->bus_info.ch_total_num;
	vinc->vid_cap.frame.fmt.mbus_type = mcfg.type;
```

所以 multi-VC 的逻辑是：

- **sensor 输出多个 VC**
- `CSI` 识别出 `CHANNEL_0 / CHANNEL_1 / ...`
- `vinc->total_rx_ch` 变成 2、3、4...
- 后续 ISP/驱动在**同一前端输入链**里处理这些子流

---

# 3. 为什么 multi-VC 可以走“一个 ISP 的不同通道”

因为 multi-VC 的几路数据，本质上还是：

- 同一个 sensor
- 同一条 MIPI/CSI 总线
- 同一个 parser 输入域
- 只是 CSI-2 packet header 里的 **VC ID 不同**

也就是说，它是“**多路逻辑子流复用在同一物理接收链路上**”。

这类模式里，ISP 更像是在做：

- 多曝光帧对应
- 多 VC 拆包
- 同一图像/同一时刻不同曝光的联合处理

所以它天然适合在**同一个 ISP 的不同内部处理通道**里完成。

换句话说：

> multi-VC 更像“同一图像语义下的多子流输入”，  
> 而不是“单张图太大，需要两套 ISP 算力平摊”。

---

# 4. LargeMode 为什么不能复用“同一个 ISP 的不同通道”

因为 LargeMode 的瓶颈根本不是“输入流条数”，而是：

## 单个 ISP 的最大处理尺寸上限

文档已经明确说了：

```5:7:agent_output/large_mode_ref.md
PS：V85X ISP 能处理的最大分辨率为 3072x3072，所以高于这个分辨率的图像均需要开启 2in1 模
式来进行处理。
```

这句话的隐含意思是：

- 即便你把大图包装成不同 VC
- 即便你在一个 ISP 内部有多个 channel
- **这个 ISP 实体本身也还是那一个 ISP**
- 它的前端 RAW 处理、统计、去噪、插值、色彩链路，都还是受**单 ISP 最大输入尺寸**限制

所以：

### multi-VC 的“一个 ISP 不同通道”
是为了处理：
- 多路子流
- 多曝光
- 多 VC 复用

### LargeMode 的“两 ISP”
是为了处理：
- 单张超大图像
- 单 ISP 无法容纳的空间分辨率
- 需要两套真实 ISP 前端并行分担

这两个问题不在一个维度上。

---

# 5. 驱动层也支持这个判断：LargeMode 配置的是“同前端、双后端”

LargeMode 文档要求：

- `vinc00` 用 `CSI0/MIPI0/ISP0/TDM_RX0`
- `vinc01` 用 `CSI0/MIPI0/ISP1/TDM_RX1`

也就是说：

```75:86:agent_output/large_mode_ref.md
vinc01:vinc@1 { // vinc@1/5/9/13 配置一致
vinc1_csi_sel = <0>; // 配置 CSI0 通道，与vinc0保持一致
vinc1_mipi_sel = <0>; // 配置 MIPI0 通道，与vinc0保持一致
vinc1_isp_sel = <1>; // 选择 ISP1 通道
vinc1_isp_tx_ch = <0>;
vinc1_tdm_rx_sel = <1>; // 选择 tdm_rx1
vinc1_rear_sensor_sel = <0>; // 选择 Sensor0 作为数据来源，与vinc0保持一致
vinc1_front_sensor_sel = <0>; // 选择 Sensor0 作为数据来源，与vinc0保持一致
vinc1_sensor_list = <0>;
status = "okay";
};
```

这正说明：

- 前端输入并没有变成第二路 VC
- 还是同一个 `CSI0/MIPI0/sensor0`
- 变化的是后端资源：
  - `TDM_RX0 -> ISP0`
  - `TDM_RX1 -> ISP1`

而 `vin.c` 建链时，确实是按 `vinc` 的 `tdm_rx_sel / isp_sel` 去建立这两条后端链路：

```1678:1708:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
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

这说明 LargeMode 的设计就是：

> **一份前端大图输入，经过 TDM/拆分，喂给两个不同 ISP 实体。**

而不是“一个 ISP 的 channel0/channel1 分着吃”。

---

# 6. top 寄存器层也说明了：ISP 是“实体级”输入选择，不只是 ISP 内部 channel

顶层 mux 配置接口：

```220:229:lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
void csic_isp_input_select(unsigned int sel, unsigned int isp, unsigned int in,
				unsigned int psr, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_ISP0_IN0_REG_OFF + isp * 16 + in * 4,
			isp_input[isp][in][psr][ch]);
}
```

这里可以看到，配置维度是：

- `isp`
- `in`
- `parser`
- `ch`

也就是说，驱动确实是在给**某个 ISP 实体**配置输入来源。

而不是只在“同一个 ISP 内部的不同算法通道”间切换。

---

# 7. 还有一个更底层的证据：ISP/VIPP 的“通道”不是给 LargeMode 这种空间切图用的

VIN 里有：

```18:20:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/isp600/isp600_reg_cfg.h
#define ISP_VIRT_NUM 4
```

```30:32:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/vipp200/vipp200_reg.h
#define VIPP_VIRT_NUM 4
```

这些 `VIRT_NUM` 更偏向：

- 逻辑虚体/输出路组织
- ISP 输出和 VIPP 的映射组织

而不是说：

> 单个 ISP 可以把一张 4K+ RAW 图空间切成左右两块，各自跑完整前端处理链。

LargeMode 文档里明确要求：

- 左右半图分别送 `ISP0/1`
- 中间还有 overlap 区域做缝合优化

这已经是**两个完整 ISP 实体并行工作**的语义，不是单 ISP 多输出语义。

---

# 8. 用一句话概括两者区别

## multi-VC
像是：

> 一辆车上装了多个包裹（VC0/VC1/...），  
> 你先把包裹分出来，再交给同一个处理中心按不同流程处理。

## LargeMode
像是：

> 一件货物本身体积过大，单个处理台放不下，  
> 必须切成左右两块，放到两台处理机上同时加工，再拼回去。

所以：

- multi-VC 关心的是 **流复用**
- LargeMode 关心的是 **空间尺寸/算力上限**

这就是为什么 LargeMode 不是走“一个 ISP 的不同通道”，而是走“两个不同 ISP”。

---

# 9. 是否和我们之前的分析一致？

**完全一致。**

之前我们说过：

- `sel/ch` 不是随便搭配
- 必须服从硬件拓扑
- 常规模式下常见“同号自然映射”
- 特殊模式下可能出现“前端共享、后端分流”的合法配置

LargeMode 正是这个“特殊合法配置”的典型例子：

- 前端共享：
  - `sensor0 / mipi0 / csi0`
- 后端分流：
  - `tdm_rx0 -> isp0`
  - `tdm_rx1 -> isp1`

它不是随便绕过规则，而是**另一条硬件明确支持的路径**。

---

# 10. 最终回答

## 为什么 LargeMode 不像 multi-VC 那样走一个 ISP 的不同通道？
因为 **multi-VC 和 LargeMode 解决的不是同一种硬件问题**：

### multi-VC
- 问题：同一 MIPI/CSI 链路里有多个 VC 子流
- 方案：一个 ISP 内部按不同通道/不同曝光链处理即可

### LargeMode
- 问题：单帧图像尺寸已经超过单 ISP 最大可处理分辨率
- 方案：必须把图像按空间拆分，交给两个真实 ISP 实体并行处理

所以 LargeMode 用两个 ISP，不是因为它“不想复用 ISP 通道”，而是因为：

> **单 ISP 通道并不能突破“单 ISP 最大输入尺寸”这个硬限制。**

---

如果你愿意，我下一步可以继续帮你做一个更清楚的对照表：

1. **multi-VC / WDR / LargeMode 三种模式的“输入组织、CSI表现、ISP资源占用、DTS特征”对比表**
2. **继续沿驱动往下追：LargeMode 的“拆分/缝合”更可能落在哪一层实现，是 TDM、ISP 内核、还是 userspace/middleware**

