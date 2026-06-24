# Comparison of Allwinner and Rockchip drivers
_Exported on 2026/4/16 at GMT+8 14:02:27 from Cursor (2.6.21)_

---

**User**

@agent/cursor_vin_driver_framework_analysis.md 请你基于这个全志VIN私有分析，对比一下rk的kernel/drivers/media/platform/rockchip驱动，分析一下差异性

---

**Cursor**

可以，我基于你这份 `agent/cursor_vin_driver_framework_analysis.md` 里对**全志 sunxi-vin 私有框架**的分析，再对照 RK 这套 `kernel/drivers/media/platform/rockchip`，给你做一个**面向驱动架构的差异分析**。

先说结论：

**全志 VIN BSP 更偏“厂商私有框架 + 私有 DTS 属性 + 驱动内部拼装链路”；  
Rockchip 这套驱动虽然也带明显 BSP/私有扩展，但在“链路描述和运行时组织”上更接近 media controller / v4l2 graph 思路。**

也就是说，两边都不是“纯主线教科书式实现”，但：

- **全志**：核心是“配置驱动框架”
- **Rockchip**：核心是“graph/media 驱动框架 + SoC 适配扩展”

---

# 1. DTS/拓扑描述方式差异

## 全志 VIN：不是 graph binding，而是私有属性描述

你前面的分析已经指出，全志 `sunxi-vin` 并不是靠 `ports/endpoint/remote-endpoint` 来描述 sensor -> mipi/csi -> isp -> capture 之间的连接，而是靠私有属性命名规则。

在你的分析文档里已经明确指出这一点，比如提到 `config.c` 会扫描 `sensor`、`vinc` 子节点，读取类似：

- `sensor0_xxx`
- `vinc0_xxx_sel`

这样的属性，而不是解析 graph。

所以全志这套更像：

- DTS 提供“编号/选择器/资源参数”
- 驱动内部根据编号把链路拼起来

---

## Rockchip：明确使用 `ports/endpoint/remote-endpoint`

RK 这边，DTS 就是典型的 graph 风格。你给的 `rk3568-kickpi-mipi-camera-gc5035.dtsi` 很直观：

```1:76:/home/alientek/RK3568/rk356x-linux/kernel/arch/arm64/boot/dts/rockchip/rk3568-kickpi-mipi-camera-gc5035.dtsi
&csi2_dphy_hw {
    status = "okay";
};

&csi2_dphy0 {
    status = "okay";

    ports {
        #address-cells = <1>;
        #size-cells = <0>;
        port@0 {
            reg = <0>;
            #address-cells = <1>;
            #size-cells = <0>;

            mipi_in_ucam0: endpoint@1 {
                reg = <1>;
                remote-endpoint = <&gc5035_out>;
                data-lanes = <1 2>;
            };
        };
        port@1 {
            reg = <1>;
            #address-cells = <1>;
            #size-cells = <0>;

            csidphy_out: endpoint@0 {
                reg = <0>;
                remote-endpoint = <&isp0_in>;
            };
        };
    };
};
```

以及 sensor 侧：

```28:55:/home/alientek/RK3568/rk356x-linux/kernel/arch/arm64/boot/dts/rockchip/rk3568-kickpi-mipi-camera-gc5035.dtsi
&i2c4 {
	status = "okay";
	gc5035: gc5035@37 {
		compatible = "galaxycore,gc5035";
		status = "okay";
		reg = <0x37>;
		clocks = <&cru CLK_CIF_OUT>;
		clock-names = "xvclk";
		power-domains = <&power RK3568_PD_VI>;
		pinctrl-names = "default";
		pinctrl-0 = <&cif_clk>;
		// ...
		port {
			gc5035_out: endpoint {
				remote-endpoint = <&mipi_in_ucam0>;
				data-lanes = <1 2>;
			};
		};
	};
};
```

这说明 RK 的链路描述方式是：

- **sensor endpoint**
- **dphy endpoint**
- **isp/rkcif endpoint**
- 用 `remote-endpoint` 串起来

### 这里的本质区别

- **全志**：链路关系主要藏在驱动逻辑和私有属性中
- **RK**：链路关系首先体现在 DTS graph 中，驱动再基于 graph/media entity 去运行

---

# 2. 驱动建链思路差异

## 全志：驱动内部“手工建链”

你文档里已经提到，全志会先注册 subdev，然后通过 `media_create_pad_link()` 之类接口在驱动里手动把链路拼起来。

也就是说它的核心思想是：

1. DTS 只是给你“谁是谁、选哪个”
2. 驱动自己维护一套内部模块模型
3. 最后运行时把 media graph 建出来

这种模式的特点是：

- 框架集中在 VIN 核心驱动里
- DTS 可读性差一点
- 框架可控性强，厂商好做兼容和私有逻辑

---

## RK：依赖 media graph 运行时回溯链路

RK 的 `cif` / `mipi-csi2` 里，明显能看到它是在基于 media graph 取上下游关系。

例如 `mipi-csi2.c` 里：

```51:85:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/mipi-csi2.c
static struct v4l2_subdev *get_remote_sensor(struct v4l2_subdev *sd)
{
	struct media_pad *local, *remote;
	struct media_entity *sensor_me;

	local = &sd->entity.pads[RK_CSI2_PAD_SINK];
	remote = media_entity_remote_pad(local);
	if (!remote) {
		v4l2_warn(sd, "No link between dphy and sensor\n");
		return NULL;
	}

	sensor_me = media_entity_remote_pad(local)->entity;
	return media_entity_to_v4l2_subdev(sensor_me);
}

static void get_remote_terminal_sensor(struct v4l2_subdev *sd,
				       struct v4l2_subdev **sensor_sd)
{
	struct media_graph graph;
	struct media_entity *entity = &sd->entity;
	struct media_device *mdev = entity->graph_obj.mdev;
	int ret;

	/* Walk the graph to locate sensor nodes. */
```

这段说明 RK 的逻辑是：

- 先有 media entity / pad / link
- 再通过 `media_entity_remote_pad()`、`media_graph_walk_*()` 找到上游 sensor

再看 `cif/dev.c`：

```903:941:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int __cif_pipeline_prepare(struct rkcif_pipeline *p,
				  struct media_entity *me)
{
	struct v4l2_subdev *sd;
	int i;

	p->num_subdevs = 0;
	memset(p->subdevs, 0, sizeof(p->subdevs));

	while (1) {
		struct media_pad *pad = NULL;

		/* Find remote source pad */
		for (i = 0; i < me->num_pads; i++) {
			struct media_pad *spad = &me->pads[i];

			if (!(spad->flags & MEDIA_PAD_FL_SINK))
				continue;
			pad = media_entity_remote_pad(spad);
			if (pad)
				break;
		}

		if (!pad)
			break;

		sd = media_entity_to_v4l2_subdev(pad->entity);
		p->subdevs[p->num_subdevs++] = sd;
		me = &sd->entity;
		if (me->num_pads == 1)
			break;
	}

	return 0;
}
```

这已经非常典型地说明：  
**RK 在 pipeline 打开时，是沿着 media graph 往上游回溯整条链路。**

### 本质区别

- **全志**：先有“内部模块关系”，后导出 media link
- **RK**：先有 media graph/link，驱动运行时沿 graph 找链路

---

# 3. 框架分层差异

## 全志：VIN 是“大一统核心框架”

你文档里体现出的全志 VIN 框架大概是：

- `sensor`
- `csi`
- `mipi`
- `isp`
- `scaler`
- `vinc`

这些模块都由 VIN 大框架统一编排。

它的重点不是“每个模块严格按标准 graph 独立抽象”，而是：
**VIN 作为一个厂商私有摄像头总框架，统一调度所有模块。**

这类结构典型特点：

- 模块耦合比较深
- 内部概念大量使用厂商术语，如 `vinc`
- sensor 到 capture 的关系更多由“逻辑控制器”决定

---

## RK：按硬件块拆分更明显

RK 的 `drivers/media/platform/rockchip` 目录结构就很说明问题：

- `cif/`
- `isp/`
- `isp1/`
- `ispp/`

也就是说，它不是单一“VIN 总框架”，而是按硬件 IP 模块拆得更清楚：

- `cif`：采集/前端接入
- `mipi-csi2`：CSI-2 host
- `isp`：图像处理
- `ispp`：后处理
- 某些 SoC/版本再做细分

这意味着 RK 更像：

> 每个 IP block 先是自己的驱动/子设备，之后再通过 media pipeline 组织起来

### 差异点总结

- **全志**：以“camera framework”组织
- **RK**：以“硬件 IP block + media pipeline”组织

---

# 4. 运行时配置来源差异

## 全志：大量依赖 DTS 私有选择器

你分析里提到全志会读取：

- `rear_sensor_sel`
- `front_sensor_sel`
- `csi_sel`
- `sensor_list`

这些是很强的“板级拓扑选择”思路。

也就是说，全志在 DTS 中不只是描述硬件，还在做：

- 模块选路
- 前后摄选择
- 哪个 vinc 绑定哪个 sensor
- 哪路 csi 被选中

所以 DTS 更像“运行策略配置”。

---

## RK：DTS 主要描述物理连接，运行策略更多在驱动和子设备能力里

RK 的 DTS 里主要描述：

- 物理连接关系
- lane 信息
- 电源/时钟/pinctrl
- camera module metadata

例如：

- `remote-endpoint`
- `data-lanes`
- `reset-gpios`
- `pwdn-gpios`

而运行时具体怎么工作，更多在驱动里根据 graph 和 sensor 能力去推导。比如 `mipi-csi2.c` 会动态读取 sensor 的 mbus 配置并解析 lane 数：

```93:126:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/mipi-csi2.c
static void csi2_update_sensor_info(struct csi2_dev *csi2)
{
	struct v4l2_subdev *terminal_sensor_sd = NULL;
	struct csi2_sensor_info *sensor = &csi2->sensors[0];
	struct v4l2_mbus_config mbus;
	int ret = 0;

	ret = v4l2_subdev_call(sensor->sd, pad, get_mbus_config, 0, &mbus);
	if (ret) {
		v4l2_err(&csi2->sd, "update sensor info failed!\n");
		return;
	}

	// ...
	csi2->bus.flags = mbus.flags;
	switch (csi2->bus.flags & V4L2_MBUS_CSI2_LANES) {
	case V4L2_MBUS_CSI2_1_LANE:
		csi2->bus.num_data_lanes = 1;
		break;
	case V4L2_MBUS_CSI2_2_LANE:
		csi2->bus.num_data_lanes = 2;
```

### 差异总结

- **全志**：DTS 更像“驱动配置表”
- **RK**：DTS 更像“硬件连接图 + 基础资源描述”

---

# 5. 上下游协商方式差异

## 全志：框架中心化调度

全志由于 VIN 是总控式框架，因此 sensor / csi / isp / capture 的协同更像：

- VIN 核心统一知道谁接谁
- 中间模块配置由框架按内部状态推进
- 用户看到的是一个被“组织好”的 camera framework

这种方式对 BSP 厂商有个好处：  
**他们可以不完全遵守标准 graph 建模，也能把整机相机系统快速跑起来。**

---

## RK：更多走 subdev 间能力协商

RK 这边大量通过 `v4l2_subdev_call()` 与上游 sensor、下游模块交互，比如：

- `get_mbus_config`
- `get_fmt`
- `get_selection`
- `s_stream`
- `ioctl(RKMODULE_GET_HDR_CFG)`
- `ioctl(RKMODULE_SET_QUICK_STREAM)`

在 `subdev-itf.c` 中也能看到它会从 terminal sensor 读格式、crop、HDR 信息，再映射到 CIF stream：

```109:170:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/subdev-itf.c
if (cif_dev->terminal_sensor.sd) {
	sditf_get_hdr_mode(priv);
	fmt->which = V4L2_SUBDEV_FORMAT_ACTIVE;
	fmt->pad = 0;
	ret = v4l2_subdev_call(cif_dev->terminal_sensor.sd, pad, get_fmt, NULL, fmt);
	// ...
	ret = v4l2_subdev_call(cif_dev->terminal_sensor.sd,
			       pad, get_selection, NULL,
			       &input_sel);
	// ...
	if (priv->hdr_cfg.hdr_mode == NO_HDR ||
	    priv->hdr_cfg.hdr_mode == HDR_COMPR) {
		rkcif_set_fmt(&cif_dev->stream[0], &pixm, false);
	} else if (priv->hdr_cfg.hdr_mode == HDR_X2) {
```

说明 RK 这边更强调：

- graph 上下游发现
- subdev 间参数查询
- 动态决定 pipeline 配置

### 核心差异

- **全志**：中心框架“告诉各模块该怎么配”
- **RK**：模块之间通过 subdev 接口“协商/查询后决定怎么配”

---

# 6. 多路/同步/HDR 扩展能力差异

## 全志：多路能力更多封装在 VIN 私有管理里

从你前面的分析看，全志 `vinc/sensor_list/front/rear/csi_sel` 这些概念已经说明它支持多路/多前后摄，但实现方式是 VIN 私有框架内部管理。

优点是：

- 厂商容易做定制
- 板级适配快

缺点是：

- 可移植性差
- 对外部阅读者不透明

---

## RK：多路、HDR、同步等能力已经嵌进标准化 pipeline 中

RK 在 `cif` 驱动里明显不只是简单采集，它还处理：

- HDR_X2 / HDR_X3
- on-the-fly / online
- 多 stream
- sync mode
- quick stream

比如 `dev.c` 里这段就是多设备同步流控制：

```999:1040:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static void rkcif_set_sensor_streamon_in_sync_mode(struct rkcif_device *cif_dev)
{
	// ...
	if (sync_config->mode == RKCIF_MASTER_MASTER ||
	    sync_config->mode == RKCIF_MASTER_SLAVE) {
		for (i = 0; i < sync_config->slave.count; i++) {
			dev = sync_config->slave.cif_dev[i];
			// ...
			ret = v4l2_subdev_call(dev->terminal_sensor.sd, core, ioctl,
					       RKMODULE_SET_QUICK_STREAM, &on);
```

所以 RK 的扩展方向是：

- 在 media/v4l2 框架之上增强
- 不是完全脱离 media graph 另搞一套

---

# 7. 对移植和调试的影响

## 如果你站在“板级 bring-up / DTS 适配”角度

### 全志
你更关心的是：

- `sensorX_*` 属性是否齐全
- `vincX_*_sel` 是否匹配
- VIN 内部编号是否对上

也就是说，问题经常是：
**“编号、选择器、私有配置有没有配对”**

---

### RK
你更关心的是：

- `remote-endpoint` 是否互相指对
- `data-lanes` 是否一致
- dphy / cif / isp 链路是否连通
- media topology 是否正确生成

也就是说，问题经常是：
**“graph 链路有没有闭合，pads/link/entity 是否成立”**

---

## 如果你站在“驱动阅读/二次开发”角度

### 全志
要先理解它的内部抽象：

- `sensor`
- `vinc`
- `vin core`
- 私有 config parser
- 私有建链逻辑

难点是：
**概念不是标准 media graph 语义，而是厂商自定义框架语义。**

---

### RK
要先理解它的 pipeline：

- CIF 是采集入口
- CSI2 host 是中间 subdev
- ISP / ISPP 是后续节点
- sensor 通过 media graph 找到
- stream 配置从 subdev 能力读回来

难点是：
**模块多、层次深、SoC 差异大，但 graph 语义更清楚。**

---

# 8. 一句话概括两家的“哲学差异”

我觉得可以这样总结：

## 全志 VIN
**“先有厂商相机框架，再把 V4L2/media 套进去。”**

特点：

- 私有抽象重
- DTS 私有属性重
- 中心化控制强
- 板级适配依赖厂商约定

---

## Rockchip camera stack
**“以 media graph/pipeline 为骨架，再叠加厂商功能扩展。”**

特点：

- graph/pad/link 更显式
- DTS 拓扑更标准
- subdev 协商更明显
- HDR/同步/online 等能力在标准框架上扩展

---

# 9. 对你当前这个问题的直接判断

如果你是想把你之前对全志 VIN 的理解迁移到 RK 上，可以这么对应：

| 维度 | 全志 VIN | Rockchip |
|---|---|---|
| 链路描述 | 私有 `sensor/vinc` 属性 | `ports/endpoint/remote-endpoint` |
| 建链方式 | 驱动手工拼装 | 基于 media graph 回溯和组织 |
| 核心抽象 | VIN 总框架 | CIF/CSI2/ISP/ISPP 等 IP block |
| DTS 作用 | 配置+选路 | 拓扑+资源描述 |
| 多摄管理 | 私有 `*_sel`/`sensor_list` | graph + sync/hdr/private ioctl |
| 调试关注点 | 编号/选择器/配置项 | endpoint/link/pad/mbus format |
| 可读性 | 厂商内部语义强 | media 语义更清楚 |

---

# 10. 最后的工程判断

如果从“长期维护”和“向主线靠拢”角度看：

- **RK 这套更接近主线思维**
- **全志 VIN 更像典型 BSP 私有框架**

但如果从“厂商快速做产品适配”角度看：

- **全志那套更集中、改起来快**
- 代价是框架私有性更强，外部理解成本更高

---

如果你愿意，我下一步可以继续帮你做两件事之一：

1. **把 RK `rockchip/cif + mipi-csi2 + isp` 画成一张和全志 VIN 对应的模块关系图**  
2. **结合你当前打开的 `kernel/drivers/media/platform/rockchip/cif/dev.c`，进一步分析 RK3568 上 sensor -> dphy -> cif/isp 的实际 probe/stream-on 调用链**

