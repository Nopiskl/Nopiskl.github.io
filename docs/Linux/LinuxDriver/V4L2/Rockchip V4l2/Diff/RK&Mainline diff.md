

---

**User**

那对比RK的实现和标准主线规定，又有什么差别？

---

**Cursor**

有，而且差别还挺明显。  
如果上一轮是：

- **全志 VIN vs RK BSP**

那这一轮可以理解为：

- **RK BSP camera 驱动 vs 标准主线 V4L2/media 实现范式**

我先给一句结论：

**RK 这套实现已经明显比全志更接近主线了，但它依然不是“纯主线风格”，而是“主线框架外壳 + Rockchip 私有扩展内核”。**

可以从 6 个层面看。

---

# 1. DTS/拓扑描述：RK 这一点已经很接近主线

这部分 RK 基本是符合主线思路的。

你这个 DTS 就是典型的 media graph 写法：

```1:33:/home/alientek/RK3568/rk356x-linux/kernel/arch/arm64/boot/dts/rockchip/rk3568-kickpi-mipi-camera-gc5035.dtsi
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

sensor 节点也有标准 `port/endpoint`：

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

## 和标准主线相比

### 一致的地方
- 用 `ports/endpoint/remote-endpoint`
- 用 `data-lanes`
- 设备节点职责清晰：sensor / dphy / isp 各自独立

### 不一样的地方
- RK DTS 里仍然保留不少 Rockchip 特有元数据，比如：
  - `rockchip,camera-module-index`
  - `rockchip,camera-module-facing`
  - `rockchip,camera-module-name`
  - `rockchip,camera-module-lens-name`

这些不是主线通用 camera binding 的核心内容，更偏厂商生态和用户态栈配套。

---

# 2. 链路组织：主线更强调 async notifier / fwnode，RK 更强调“已有 graph 上的运行时回溯”

标准主线 camera 驱动里，典型模式是：

1. 用 fwnode / of_graph 解析 endpoint
2. 用 `v4l2_async_notifier` 把远端 subdev 异步绑定起来
3. bind 完以后建立 media entity link
4. pipeline 再通过标准 subdev ops 协同工作

RK 这套代码里，虽然也用了 graph 体系，但你能看到它大量是在**运行时沿着 media graph 倒推上下游**。

比如 `mipi-csi2.c`：

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

以及 `cif/dev.c`：

```919:941:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
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
```

## 这和主线的差别是

主线通常更强调：

- **probe/bind 阶段**就把异步连接关系建清楚
- 各 subdev 的角色更固定
- pipeline 结构更“声明式”

而 RK 更像：

- 链路虽然也是 graph
- 但很多逻辑依赖运行时去“找 terminal sensor / 找 upstream pad / 回溯 graph”

### 一句话
- **主线**：更偏“先绑定，再运行”
- **RK BSP**：更偏“先有 graph，再运行时去图里找对象”

---

# 3. 控制接口：RK 大量使用私有 `ioctl`，主线更倾向标准 controls / standard ops

这个是 RK 和主线差异里非常关键的一点。

看 `subdev-itf.c`：

```12:31:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/subdev-itf.c
static void sditf_get_hdr_mode(struct sditf_priv *priv)
{
	struct rkcif_device *cif_dev = priv->cif_dev;
	struct rkmodule_hdr_cfg hdr_cfg;
	int ret = 0;

	if (!cif_dev->terminal_sensor.sd)
		rkcif_update_sensor_info(&cif_dev->stream[0]);

	if (cif_dev->terminal_sensor.sd) {
		ret = v4l2_subdev_call(cif_dev->terminal_sensor.sd,
				       core, ioctl,
				       RKMODULE_GET_HDR_CFG,
				       &hdr_cfg);
		if (!ret)
			priv->hdr_cfg = hdr_cfg;
```

这里直接用了：

- `RKMODULE_GET_HDR_CFG`

而 `dev.c` 里还有：

```1008:1016:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
				if (dev->sditf_cnt == 1) {
					ret = v4l2_subdev_call(dev->terminal_sensor.sd, core, ioctl,
							       RKMODULE_SET_QUICK_STREAM, &on);
					if (ret)
						dev_info(dev->dev,
							 "set RKMODULE_SET_QUICK_STREAM failed\n");
				} else {
```

还有 `mipi-csi2.c` 里获取 DSI/CSI 选择：

```99:107:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/mipi-csi2.c
	get_remote_terminal_sensor(&csi2->sd, &terminal_sensor_sd);
	ret = v4l2_subdev_call(terminal_sensor_sd, core, ioctl,
				RKMODULE_GET_CSI_DSI_INFO, &csi2->dsi_input_en);
	if (ret) {
		v4l2_dbg(1, csi2_debug, &csi2->sd, "get CSI/DSI sel failed, default csi!\n");
		csi2->dsi_input_en = 0;
	}
```

## 主线通常怎么做

主线更倾向：

- 标准 pad ops：`get_fmt` / `set_fmt` / `enum_mbus_code`
- 标准 video ops：`s_stream`
- 标准 controls：曝光、增益、测试图、HDR 模式等
- 尽量避免大规模厂商私有 `core.ioctl`

### 所以 RK 在这点上明显偏 BSP

因为它依赖一套 Rockchip 专有 sensor/module 协议：

- `RKMODULE_GET_HDR_CFG`
- `RKMODULE_SET_QUICK_STREAM`
- `RKMODULE_GET_CSI_DSI_INFO`

这说明它的 sensor 驱动、CIF、ISP 是**一整套 Rockchip 私有协作生态**，并不完全是主线通用语义。

---

# 4. pipeline 能力模型：RK 里带很多平台私有能力，主线一般不会把这些揉得这么深

在 RK 的 `subdev-itf.c` 里，HDR 和 stream 配置是深度耦合在 CIF 逻辑里的：

```70:80:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/subdev-itf.c
	if (cif_dev->active_sensor) {
		sensor_sd = cif_dev->active_sensor->sd;
		return v4l2_subdev_call(sensor_sd, pad, get_mbus_config, 0, config);
	} else {
		config->type = V4L2_MBUS_CSI2_DPHY;
		config->flags = V4L2_MBUS_CSI2_CHANNEL_0 |
				V4L2_MBUS_CSI2_CONTINUOUS_CLOCK;
		return 0;
	}
```

以及后面会根据 `HDR_X2/HDR_X3` 去配多个 stream。  
这类能力在主线不是不能做，但通常会尽量：

- 放在更标准的 format / route / stream API 语义里
- 或拆成更明确的独立 entity / state machine

而 RK 这里的感觉是：

- graph 是标准壳子
- 里面的“如何多路 HDR、如何 quick stream、如何 sync mode”是 Rockchip 自己定义的能力模型

---

# 5. SoC 适配方式：RK 在公共驱动里保留了大量芯片分支，主线一般更克制

看 `dev.c`，一个公共函数里就有很多 SoC 分支：

```601:639:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
	if (dev->inf_id == RKCIF_MIPI_LVDS &&
	   index >= CIF_REG_MIPI_LVDS_ID0_CTRL0 &&
	   index <= CIF_REG_MIPI_ON_PAD) {
		if (dev->chip_id == CHIP_RK3588_CIF) {
			csi_offset = dev->csi_host_idx * 0x100;
		} else if (dev->chip_id == CHIP_RV1106_CIF) {
			csi_offset = dev->csi_host_idx * 0x200;
		} else if (dev->chip_id == CHIP_RK3562_CIF) {
			if (dev->csi_host_idx < 3)
				csi_offset = dev->csi_host_idx * 0x200;
			else
				csi_offset = 0x500;
		}
	}
```

还有 GRF 配置、采样边沿、DVP pin 复用等很多平台细节。

## 和主线相比

主线当然也会有 SoC 差异，但通常会更倾向：

- `match_data`
- ops table
- variant data
- 将平台差异往更清晰的硬件抽象层收敛

RK 这套则更明显保留了 BSP 常见风格：

- 大公共文件里塞很多 `chip_id == XXX`
- 兼容多个芯片世代
- 便于厂商快速维护，但代码风格不够“主线化”

---

# 6. 用户态/生态协同：RK 更像“完整平台方案”，主线更像“通用内核接口”

RK 代码里这些字段和接口都在说明：  
它不是单纯做一个 Linux camera driver，而是服务 Rockchip 整个平台方案。

比如 DTS 里这些字段：

```43:49:/home/alientek/RK3568/rk356x-linux/kernel/arch/arm64/boot/dts/rockchip/rk3568-kickpi-mipi-camera-gc5035.dtsi
		rockchip,camera-module-index = <0>;
		rockchip,camera-module-facing = "front";
		rockchip,camera-module-name = "default";
		rockchip,camera-module-lens-name = "PC5322-M5";
```

这些往往会被：

- ISP IQ 工具链
- 厂商 camera app/framework
- HAL/中间件

一起消费。

而主线的目标更多是：

- 给出通用 V4L2/media 抽象
- 不强绑定厂商专有上层生态

---

# 归纳一下：RK 和标准主线到底差在哪？

我给你一个更直接的表：

| 维度 | 标准主线 V4L2/media | RK 当前实现 |
|---|---|---|
| DTS 拓扑 | `ports/endpoint` 标准 graph | 这点基本接近主线 |
| subdev 绑定 | 更强调 async notifier / fwnode 绑定 | 更依赖 graph 建好后运行时回溯 |
| 控制接口 | 标准 controls / pad ops / stream ops | 大量 `RKMODULE_*` 私有 `ioctl` |
| 平台差异 | 倾向 variant/ops 抽象 | 公共代码里保留较多 `chip_id` 分支 |
| HDR/同步/快启流 | 尽量标准化表达 | 明显 Rockchip 私有能力模型 |
| 用户态生态 | 通用 Linux 接口 | 兼容 Rockchip 自家 camera 方案 |

---

# 结论怎么理解最准确？

我建议你把 RK 这套定义成：

## “半主线化 BSP”
或者更准确一点：

## “主线 media graph 外形 + 厂商私有 camera pipeline 内核”

也就是说：

### 它比全志更主线
因为它至少：
- 用了 graph DTS
- 用了 media entity / pad / link
- 用了 subdev 语义
- pipeline 组织方式更接近 V4L2 MC

### 但它又没完全主线化
因为它仍然：
- 强依赖 Rockchip 私有 `ioctl`
- 强依赖 Rockchip sensor/module 协议
- 带较强的平台分支和 BSP 维护风格
- 某些能力不是通用 V4L2 语义，而是 Rockchip 自定义语义

---

# 如果你从“迁移/重构到主线风格”的角度看，RK 主要还差这几步

1. **减少 `RKMODULE_*` 私有 ioctl**
   - 尽量用标准 control / 标准 subdev API 表达

2. **把 SoC 分支再抽成更清晰的 variant ops**
   - 减少 `if (chip_id == ...)`

3. **减少 pipeline 里对 terminal sensor 的专有回溯依赖**
   - 更多在 bind 阶段固定对象关系

4. **把 HDR / quick-stream / sync-mode 这类能力标准化或模块化**
   - 不要深埋在厂商内部协议里

---

如果你愿意，我下一步可以继续两种方向之一：

1. **按“主线化差距清单”继续细化 RK3568 CIF 代码里哪些地方最 BSP、哪些地方最接近主线**
2. **直接拿 `kernel/drivers/media/platform/rockchip/cif/dev.c` 给你做一版“如果要往主线风格改，应该怎么拆”的结构分析**

你要的话，我可以继续往“代码级主线化差距”展开。

---

**User**

@kernel/drivers/media/platform/rockchip/cif/dev.c 对于rkcif的驱动，7. Media Controller 链路创建
static int rkcif_create_link(struct rkcif_device *dev,
			     struct rkcif_sensor_info *sensor,
			     u32 stream_num,
			     bool *mipi_lvds_linked)
根据传感器总线类型，在 sensor sub-device 与 video node 之间创建 Media pad link
对于rkcif，上层有一个同一驱动专门负责建立media graph与link，这种思想也是主线支持的吗？

---

**Cursor**

是的，**这种“由一个上层/桥接驱动统一创建 media graph 和 link”的思想，本身就是主线支持的**。  
但要注意两点：

1. **主线支持的是“桥接/聚合/receiver 驱动在合适时机建链”**
2. **不是支持“随便搞一个完全脱离 graph/fwnode 的私有总控框架”**

你这个 `rkcif` 属于前者，只不过带了一些 Rockchip BSP 风格的私有扩展。

---

# 先看 `rkcif` 现在是怎么做的

从 `dev.c` 可以看到，`rkcif` 不是 sensor 驱动自己去建整张图，而是：

- `rkcif` 自己先通过 async notifier 找到所有远端 sensor subdev
- 在 notifier complete 阶段收集总线类型、lane 信息
- 然后统一调用 `rkcif_create_links(dev)`
- 最后注册 subdev nodes

这段流程很清楚：

```1493:1592:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int subdev_notifier_complete(struct v4l2_async_notifier *notifier)
{
	struct rkcif_device *dev;
	struct rkcif_sensor_info *sensor;
	struct v4l2_subdev *sd;
	struct v4l2_device *v4l2_dev = NULL;
	int ret, index;

	dev = container_of(notifier, struct rkcif_device, notifier);

	v4l2_dev = &dev->v4l2_dev;

	for (index = 0; index < dev->num_sensors; index++) {
		sensor = &dev->sensors[index];
		// ...
		if (sensor->mbus.type == V4L2_MBUS_CCP2) {
			ret = rkcif_register_lvds_subdev(dev);
			// ...
			break;
		}

		if (sensor->mbus.type == V4L2_MBUS_PARALLEL ||
		    sensor->mbus.type == V4L2_MBUS_BT656) {
			ret = rkcif_register_dvp_sof_subdev(dev);
			// ...
			break;
		}
	}

	ret = rkcif_create_links(dev);
	if (ret < 0)
		goto unregister_lvds;

	ret = v4l2_device_register_subdev_nodes(&dev->v4l2_dev);
	// ...
}
```

而 async notifier 也是标准 V4L2 MC 的套路：

```1594:1650:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int subdev_notifier_bound(struct v4l2_async_notifier *notifier,
				 struct v4l2_subdev *subdev,
				 struct v4l2_async_subdev *asd)
{
	struct rkcif_device *cif_dev = container_of(notifier,
					struct rkcif_device, notifier);
	struct rkcif_async_subdev *s_asd = container_of(asd,
					struct rkcif_async_subdev, asd);

	// ...
	cif_dev->sensors[cif_dev->num_sensors].lanes = s_asd->lanes;
	cif_dev->sensors[cif_dev->num_sensors].mbus = s_asd->mbus;
	cif_dev->sensors[cif_dev->num_sensors].sd = subdev;
	++cif_dev->num_sensors;

	return 0;
}
```

以及它确实是从 fwnode/endpoint 解析出来的：

```1652:1700:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int rkcif_fwnode_parse(struct device *dev,
			      struct v4l2_fwnode_endpoint *vep,
			      struct v4l2_async_subdev *asd)
{
	struct rkcif_async_subdev *rk_asd =
			container_of(asd, struct rkcif_async_subdev, asd);
	struct v4l2_fwnode_bus_parallel *bus = &vep->bus.parallel;

	if (vep->bus_type != V4L2_MBUS_BT656 &&
	    vep->bus_type != V4L2_MBUS_PARALLEL &&
	    vep->bus_type != V4L2_MBUS_CSI2_DPHY &&
	    vep->bus_type != V4L2_MBUS_CSI2_CPHY &&
	    vep->bus_type != V4L2_MBUS_CCP2)
		return 0;

	rk_asd->mbus.type = vep->bus_type;
	// ...
	return 0;
}
```

再往下看，它启动 notifier 的方式也是标准套路：

```1702:1720:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int cif_subdev_notifier(struct rkcif_device *cif_dev)
{
	struct v4l2_async_notifier *ntf = &cif_dev->notifier;
	struct device *dev = cif_dev->dev;
	int ret;

	v4l2_async_notifier_init(ntf);

	ret = v4l2_async_notifier_parse_fwnode_endpoints(
		dev, ntf, sizeof(struct rkcif_async_subdev), rkcif_fwnode_parse);

	if (ret < 0) {
		v4l2_err(&cif_dev->v4l2_dev,
			 "%s: parse fwnode failed\n", __func__);
		return ret;
	}

	ntf->ops = &subdev_notifier_ops;
```

---

# 这是不是主线支持的思想？

## 结论：是，完全支持

在主线 media controller 语义里，**“谁来创建 link”并没有规定必须是 sensor 自己**。  
通常反而是**bridge / receiver / aggregator / ISP front-end 这类中间或上游控制驱动**负责：

- 解析 graph/fwnode
- 异步等待远端 subdev 就绪
- 调用 `media_create_pad_link()` 建链
- 决定默认启用哪个 link

这在主线是非常常见、也非常合理的。

因为 sensor 自己通常只知道“我有个 source pad”，但真正知道整条系统怎么拼的人，往往是：

- CSI receiver
- camera bridge
- ISP front-end
- capture controller

而 `rkcif` 就正是这种角色。

---

# 主线支持的“统一建链”，本质是什么？

主线支持的是下面这种模式：

## 模式 A：桥接驱动作为 graph owner / pipeline owner

职责通常包括：

1. 解析本节点的 endpoint / remote-endpoint
2. 通过 notifier 等待 remote sensor probe 完成
3. 在 `.bound` / `.complete` 时把双方 pad 链起来
4. 需要时再补充内部 entity 之间的 link

这个模式和 `rkcif` 很像。

---

# 但要注意：主线支持“统一建链”，不等于支持“私有总控大包大揽”

这里要和你前面提到的全志 VIN 区分。

## 主线认可的统一建链
- 建链依据来自 **DTS graph / fwnode graph**
- 设备关系是 **标准 media entity + pad**
- 发现远端使用 **v4l2 async notifier**
- 上下游协同使用 **标准 subdev ops**

## 主线不太喜欢的方式
- 不依赖 graph/fwnode
- 只靠私有编号和 `*_sel`
- 中心驱动自己臆造拓扑
- 运行时再“硬编码拼图”

所以：

- **`rkcif` 这种“桥接驱动统一建链”是主线支持的**
- **但前提是它建立在标准 graph/fwnode/media entity 之上**

而 `rkcif` 现在确实满足这一大前提。

---

# 你这个问题里最关键的一点：`rkcif_create_link()` 的思想是否合理？

我认为是合理的，而且是主线常见思路。

你描述的是：

> 根据传感器总线类型，在 sensor sub-device 与 video node 之间创建 Media pad link

这类事情让 `rkcif` 做，本质原因是：

- `rkcif` 知道自己有哪些 video node
- `rkcif` 知道 sensor 是 DVP / BT656 / CSI2 / LVDS 哪种总线
- `rkcif` 知道自己内部是否还要插入额外 subdev，比如 LVDS、DVP SOF、MIPI/LVDS host

这些信息 sensor 自己并不知道，所以让 `rkcif` 做 link orchestration 是合理的。

---

# 那它和“纯主线风格”差在哪？

虽然“统一建链”这件事是主线支持的，但 `rkcif` 还是有一些 BSP 味道。

## 1. 它不只是建“外部链路”，还顺手做了很多平台判断
例如在 notifier complete 阶段，根据 `mbus.type` 决定要不要注册额外的 LVDS/DVP 子设备：

```1528:1553:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
		if (sensor->mbus.type == V4L2_MBUS_CCP2) {
			ret = rkcif_register_lvds_subdev(dev);
			if (ret < 0) {
				v4l2_err(&dev->v4l2_dev,
					 "Err: register lvds subdev failed!!!\n");
				goto notifier_end;
			}
			break;
		}

		if (sensor->mbus.type == V4L2_MBUS_PARALLEL ||
		    sensor->mbus.type == V4L2_MBUS_BT656) {
			ret = rkcif_register_dvp_sof_subdev(dev);
			if (ret < 0) {
				v4l2_err(&dev->v4l2_dev,
					 "Err: register dvp sof subdev failed!!!\n");
				goto notifier_end;
			}
			break;
		}
```

这类逻辑不是不能做，但主线一般更倾向：
- entity 拓扑固定
- variant 差异更清晰
- 注册流程尽量少靠运行时总线类型分叉

---

## 2. `rkcif` 还会沿 graph 回溯 pipeline，对象关系偏“运行时发现”
比如：

```909:941:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int __cif_pipeline_prepare(struct rkcif_pipeline *p,
				  struct media_entity *me)
{
	// ...
	while (1) {
		struct media_pad *pad = NULL;

		for (i = 0; i < me->num_pads; i++) {
			struct media_pad *spad = &me->pads[i];

			if (!(spad->flags & MEDIA_PAD_FL_SINK))
				continue;
			pad = media_entity_remote_pad(spad);
			if (pad)
				break;
		}
		// ...
	}
```

这在主线也能接受，但更“教科书”的写法往往会让 entity 角色和 link 更明确，而不是频繁靠运行时遍历 graph 找对象。

---

## 3. RK 的内部协同仍然带不少私有协议
比如 `RKMODULE_GET_HDR_CFG`、`RKMODULE_SET_QUICK_STREAM` 这些私有 `ioctl`。  
这和“统一建链”不是一回事，但说明它整体还是 BSP camera stack，不是纯主线范式。

---

# 所以，这个问题最准确的回答是：

## 是，主线支持“由上层桥接驱动统一建立 media graph/link”

而且这不是特例，反而是很多复杂 camera pipeline 的正常做法。

但主线支持的前提是：

- 拓扑来源于 `fwnode/of_graph`
- 设备对象是标准 `v4l2_subdev` / `media_entity` / `media_pad`
- 设备发现通过 `v4l2_async_notifier`
- link 创建使用标准 `media_create_pad_link()`

`rkcif` 这条线在“建链机制”上是符合这个思想的。

---

# 你可以把它理解成两层

## 第一层：理念层
“由 bridge / receiver / capture controller 统一建链”  
→ **主线支持**

## 第二层：实现细节层
“统一建链时夹带很多 RK 私有逻辑、私有 ioctl、平台分支”  
→ **这是 BSP 化，不是最纯的主线风格**

---

# 用一句更工程化的话说

`rkcif_create_link()` 这种函数的存在本身**不违背主线思想**；  
相反，它很像一个 **media-controller bridge driver** 在 `.bound/.complete` 阶段做的正常工作。

真正和主线距离拉开的，不是“统一建 link”这个动作本身，而是：

- link 之外的私有能力模型
- 私有 sensor 协议
- 运行时动态拼装过多
- SoC / bus type 分支耦合较深

---

如果你愿意，我下一步可以继续两种方向：

1. **直接把 `rkcif_create_link()` 这段代码拆开，逐行分析它哪些是主线常规写法，哪些是 RK 私有处理**
2. **给你画一个“主线推荐的 camera bridge 建链流程”对照 `rkcif` 的流程图**

你要的话，我建议下一步直接看 `rkcif_create_link()` 本体，这样最直观。

---

**User**

主线：更偏“先绑定，再运行”
RK BSP：更偏“先有 graph，再运行时去图里找对象”

请你根据具体源码帮我解释一下

---

**Cursor**

可以，我用你现在这份 RK 源码，具体把这句话拆开讲：

- **主线：更偏“先绑定，再运行”**
- **RK BSP：更偏“先有 graph，再运行时去图里找对象”**

先说结论：

**RK 并不是完全没做“先绑定”**，它其实也做了标准的 async notifier 绑定；  
但和更“主线化”的写法相比，它后续运行阶段仍然频繁依赖：

- 沿 media graph 回溯
- 运行时查 terminal sensor
- 打开 pipeline 时再收集上游 subdev

所以它呈现出来的风格就是：

> **绑定做了，但对象关系没有在绑定阶段完全固化；运行时还要继续“顺着图找人”。**

---

# 1. 先看 RK 里“先绑定”的部分

这部分其实很标准，`rkcif` 并不是乱来的。

它先通过 fwnode endpoint 解析远端 sensor 信息：

```1652:1675:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int rkcif_fwnode_parse(struct device *dev,
			      struct v4l2_fwnode_endpoint *vep,
			      struct v4l2_async_subdev *asd)
{
	struct rkcif_async_subdev *rk_asd =
			container_of(asd, struct rkcif_async_subdev, asd);
	struct v4l2_fwnode_bus_parallel *bus = &vep->bus.parallel;

	if (vep->bus_type != V4L2_MBUS_BT656 &&
	    vep->bus_type != V4L2_MBUS_PARALLEL &&
	    vep->bus_type != V4L2_MBUS_CSI2_DPHY &&
	    vep->bus_type != V4L2_MBUS_CSI2_CPHY &&
	    vep->bus_type != V4L2_MBUS_CCP2)
		return 0;

	rk_asd->mbus.type = vep->bus_type;
```

然后注册 async notifier：

```1695:1712:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int cif_subdev_notifier(struct rkcif_device *cif_dev)
{
	struct v4l2_async_notifier *ntf = &cif_dev->notifier;
	struct device *dev = cif_dev->dev;
	int ret;

	v4l2_async_notifier_init(ntf);

	ret = v4l2_async_notifier_parse_fwnode_endpoints(
		dev, ntf, sizeof(struct rkcif_async_subdev), rkcif_fwnode_parse);
	// ...
	ntf->ops = &subdev_notifier_ops;

	ret = v4l2_async_notifier_register(&cif_dev->v4l2_dev, ntf);
```

sensor 绑定成功时，把远端 subdev 记到 `cif_dev->sensors[]` 里：

```1584:1607:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int subdev_notifier_bound(struct v4l2_async_notifier *notifier,
				 struct v4l2_subdev *subdev,
				 struct v4l2_async_subdev *asd)
{
	struct rkcif_device *cif_dev = container_of(notifier,
					struct rkcif_device, notifier);
	struct rkcif_async_subdev *s_asd = container_of(asd,
					struct rkcif_async_subdev, asd);

	// ...
	cif_dev->sensors[cif_dev->num_sensors].lanes = s_asd->lanes;
	cif_dev->sensors[cif_dev->num_sensors].mbus = s_asd->mbus;
	cif_dev->sensors[cif_dev->num_sensors].sd = subdev;
	++cif_dev->num_sensors;
```

等所有 subdev 都齐了，再做 complete 阶段的事情：

```1480:1561:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int subdev_notifier_complete(struct v4l2_async_notifier *notifier)
{
	// ...
	for (index = 0; index < dev->num_sensors; index++) {
		sensor = &dev->sensors[index];
		// 重新读 mbus config、判断 lanes、决定注册哪类中间 subdev
	}
	ret = rkcif_create_links(dev);
	// ...
	ret = v4l2_device_register_subdev_nodes(&dev->v4l2_dev);
	// ...
}
```

---

## 这部分为什么叫“先绑定，再运行”？

因为在这个阶段，驱动已经完成了几件主线很典型的事：

1. **根据 fwnode/of_graph 找远端 endpoint**
2. **通过 async notifier 等待远端 sensor probe 完成**
3. **把远端 sensor subdev 指针保存下来**
4. **在 complete 阶段统一建 link**

这正是“先绑定”的含义：

- 对象是谁，先找出来
- 关系怎么连，先建立好
- 运行的时候尽量不要再临时猜

如果一个实现更加“主线化”，往往会希望：
**绑定完成后，后面 stream/pipeline 代码直接拿现成对象和链路工作。**

---

# 2. 但 RK 为何又说“先有 graph，再运行时去图里找对象”？

因为它虽然绑定了，但**运行期并没有完全依赖绑定阶段保存好的对象关系**，而是还在很多地方继续沿 media graph 做回溯查找。

这就是 RK BSP 味道更重的地方。

---

# 3. 典型例子一：打开 pipeline 时，再沿 graph 回溯一遍上游 subdev

看 `__cif_pipeline_prepare()`：

```909:941:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
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

然后 `rkcif_pipeline_open()` 在运行时调用它：

```944:960:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int rkcif_pipeline_open(struct rkcif_pipeline *p,
			       struct media_entity *me,
				bool prepare)
{
	// ...
	/* go through media graphic and get subdevs */
	if (prepare)
		__cif_pipeline_prepare(p, me);

	if (!p->num_subdevs)
		return -EINVAL;
```

---

## 这里体现了什么？

如果一个实现更偏“先绑定，再运行”，常见预期是：

- pipeline 参与者在 bind/complete 阶段基本已经确定
- 运行时直接用已缓存的 pipeline 成员
- 不需要每次 open 时再从当前 entity 沿 link 一路往上找

但 RK 这里做法是：

- media graph 先存在
- 到真正 `pipeline_open()` 的时候
- 再从当前 `media_entity` 出发
- 通过 `media_entity_remote_pad()` 一路向上遍历，收集 subdev

这就是我说的：

> **它不是完全依赖“绑定阶段确定好的对象表”，而是运行时依赖 graph 现状去找对象。**

所以它更像：

- graph 是真相源
- 运行时按 graph 现状重新组织 pipeline

---

# 4. 典型例子二：`mipi-csi2` 运行时去图里找 terminal sensor

看 `mipi-csi2.c`：

```51:64:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/mipi-csi2.c
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
```

以及更典型的：

```66:91:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/mipi-csi2.c
static void get_remote_terminal_sensor(struct v4l2_subdev *sd,
				       struct v4l2_subdev **sensor_sd)
{
	struct media_graph graph;
	struct media_entity *entity = &sd->entity;
	struct media_device *mdev = entity->graph_obj.mdev;
	int ret;

	/* Walk the graph to locate sensor nodes. */
	mutex_lock(&mdev->graph_mutex);
	ret = media_graph_walk_init(&graph, mdev);
	if (ret) {
		mutex_unlock(&mdev->graph_mutex);
		*sensor_sd = NULL;
		return;
	}

	media_graph_walk_start(&graph, entity);
	while ((entity = media_graph_walk_next(&graph))) {
		if (entity->function == MEDIA_ENT_F_CAM_SENSOR)
			break;
	}
```

然后在 `csi2_update_sensor_info()` 里实际调用：

```93:111:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/mipi-csi2.c
static void csi2_update_sensor_info(struct csi2_dev *csi2)
{
	struct v4l2_subdev *terminal_sensor_sd = NULL;
	struct csi2_sensor_info *sensor = &csi2->sensors[0];
	struct v4l2_mbus_config mbus;
	int ret = 0;

	ret = v4l2_subdev_call(sensor->sd, pad, get_mbus_config, 0, &mbus);
	// ...

	get_remote_terminal_sensor(&csi2->sd, &terminal_sensor_sd);
	ret = v4l2_subdev_call(terminal_sensor_sd, core, ioctl,
				RKMODULE_GET_CSI_DSI_INFO, &csi2->dsi_input_en);
```

---

## 这里为什么是“运行时去图里找对象”？

因为 `csi2_update_sensor_info()` 本质是一个运行过程中的信息同步函数。  
它并没有完全依赖某个“在 bind 时就固定好的 terminal sensor 指针”，而是：

1. 从当前 `csi2->sd` 出发
2. `media_graph_walk_start()`
3. 在整张 media graph 里找 `MEDIA_ENT_F_CAM_SENSOR`
4. 找到之后再发 `ioctl`

这非常典型地说明：

**graph 在 RK 里不只是“初始化时用来建 link 的配置来源”，而且是运行时的“对象发现机制”。**

---

# 5. 再看一个细节：RK 绑定完成后，仍然要动态补全 sensor 信息

在 `subdev_notifier_bound()` 里，它只是先把 `subdev`、`lanes`、`mbus` 存下来。  
但到了 `subdev_notifier_complete()`，它又重新遍历了一遍 `v4l2_dev->subdevs`，再调一次 `get_mbus_config()`：

```1489:1510:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
	for (index = 0; index < dev->num_sensors; index++) {
		sensor = &dev->sensors[index];

		list_for_each_entry(sd, &v4l2_dev->subdevs, list) {
			if (sd->ops) {
				if (sd == sensor->sd) {
					ret = v4l2_subdev_call(sd,
							       pad,
							       get_mbus_config,
							       0,
							       &sensor->mbus);
					if (ret)
						v4l2_err(v4l2_dev,
							 "get mbus config failed for linking\n");
				}
			}
		}
```

这说明它的风格不是：

- bound 时拿到对象就认为关系完全确定

而是：

- bound 先收一轮
- complete 再整理一轮
- run 时还会继续从 graph 查

这种实现当然可行，但它体现出来的是一种**运行期重确认**的风格，而不是“绑定后就把对象模型完全固化”。

---

# 6. 所以“主线更偏先绑定，再运行”到底是什么意思？

结合这份代码，最准确的理解应该是：

## 主线理想风格
更倾向于在以下阶段完成主要对象关系确定：

- parse fwnode
- async bound
- notifier complete
- media link create

之后运行阶段：

- pipeline 里尽量直接使用已建立的对象引用
- 少做图遍历
- 少做“再从 graph 找 terminal sensor”
- 少做“根据当前图状态重新推导对象”

也就是说：

> **graph 更偏初始化/描述手段；运行靠已经绑定好的对象。**

---

# 7. RK 当前代码为什么看起来更偏“先有 graph，再运行时去图里找对象”？

因为它在运行时还做了下面这些事情：

## 7.1 打开 pipeline 时回溯 graph
`rkcif_pipeline_open()` -> `__cif_pipeline_prepare()`  
不是直接用一张预组好的 pipeline 对象表，而是顺着 `remote_pad` 往上爬。

## 7.2 MIPI CSI2 配置时再找 terminal sensor
`get_remote_terminal_sensor()` 用 `media_graph_walk_*()` 在图里找 sensor。

## 7.3 部分 sensor 信息是按当前图状态动态更新的
例如 `csi2_update_sensor_info()` 里再读 `mbus`、再查终端 sensor，再拿私有信息。

所以 RK 的实际风格是：

> **先把 graph 建起来，然后很多运行期逻辑把 graph 当作“查询数据库”去用。**

---

# 8. 这两种风格不是绝对对立，而是“重心不同”

这个地方你要注意，不要理解成：

- 主线 = 完全不遍历 graph
- RK = 完全不绑定

不是这样的。

更准确是：

## RK 也做了“先绑定”
上面 `cif_subdev_notifier()` / `.bound` / `.complete` 就是证据。

## 但 RK 的运行时重心仍然落在 graph 查询上
这在 `__cif_pipeline_prepare()` 和 `get_remote_terminal_sensor()` 里特别明显。

所以我前面那句话，最好展开成这样：

### 主线化实现更倾向
- 把 graph 解析、异步绑定、link 创建放在 probe/bind 阶段完成
- 运行时主要依赖已经绑定好的对象关系

### RK BSP 当前实现更倾向
- bind 阶段先把 graph 建起来
- 运行时仍然经常沿 graph 回溯、查询、补全对象关系

---

# 9. 用一句最贴近这份源码的话总结

如果只看这份 `rkcif` / `mipi-csi2` 源码，我会这样重新表述那句话：

## 主线偏好的思路
“**在 notifier bound/complete 阶段尽量把 pipeline 对象关系定死，运行时少做 graph 搜索。**”

## RK BSP 当前思路
“**notifier 阶段把 graph 和 link 搭起来，但 pipeline open、CSI2 更新、terminal sensor 获取等运行逻辑，仍然依赖 media graph 动态回溯。**”

---

# 10. 你可以把这几个函数当作证据链

## 更像“先绑定”的证据
- `rkcif_fwnode_parse()`
- `cif_subdev_notifier()`
- `subdev_notifier_bound()`
- `subdev_notifier_complete()`
- `rkcif_create_links()`

## 更像“运行时去图里找对象”的证据
- `__cif_pipeline_prepare()`
- `rkcif_pipeline_open()`
- `get_remote_sensor()`
- `get_remote_terminal_sensor()`
- `csi2_update_sensor_info()`

---

如果你愿意，我下一步可以继续帮你做两件更具体的事：

1. **把 `rkcif_create_link()`、`rkcif_create_links()` 也纳入这条证据链，完整画出 `probe -> bind -> create_link -> stream on` 的时序**
2. **直接对照主线 camera bridge 的典型写法，指出 RK 这几个函数哪些地方如果“主线化”会怎么改**

如果你要，我建议下一步做第 1 个，会最直观。

