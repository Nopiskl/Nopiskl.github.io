
---

**User**

@device/config/chips/v853/configs/100ask/board.dts 以这个dts为例，结合VIN驱动源码详细分析一下vin如何遍历+配置pipeline(vin_md_prepare_pipeline)的？CSI、TDM、ISP、scaler等模块是如何连接起来的？

---

**Cursor**

可以，这次我们就**严格结合 `device/config/chips/v853/configs/100ask/board.dts` 和 `vin.c` / `config.c`**，把 `vin_md_prepare_pipeline()` 是怎么“遍历 pipeline”的，以及 **CSI、TDM、ISP、scaler 是如何连起来的** 讲清楚。

先给结论：

> 在这个 V853 的 `board.dts` 例子里，DTS 并不是通过标准 `ports/endpoint` 去一段一段描述 media graph，而是通过 `vincX_*_sel`、`sensorX_*`、`tdm/isp/scaler` 节点参数来描述“逻辑绑定关系”。  
> `vin.c` 在 probe 时先解析这些参数，把 sensor、mipi、csi、tdm、isp、scaler、vin_core 都注册成 V4L2 subdev，再由 `vin_create_media_links()` 统一创建 media link。  
> 最后 `vin_md_prepare_pipeline()` 不是“按 DTS 再解析一遍”，而是**从已经建立好的 media graph 末端（video entity）反向沿 link 遍历**，把整条链上的 subdev 填进 `vin_pipeline->sd[]`。

---

# 一、先看这个 DTS 实际描述了什么

你这个 `board.dts` 里，VIN 的主体在 `vind0` 节点下：

```92:170:/home/ubuntu/v851s/tina-v853-100ask/device/config/chips/v853/configs/100ask/board.dts
		vind0:vind@0 {
			vind0_clk = <340000000>;
			status = "okay";

			csi2:csi@2 {
				pinctrl-names = "default","sleep";
				pinctrl-0 = <&ncsi_pins_a>;
				pinctrl-1 = <&ncsi_pins_b>;
				status = "disabled";
			};
		/*offline mode*/
            tdm0:tdm@0 {
		work_mode = <1>;
	    };

	    isp00:isp@0 {
		work_mode = <1>;
	    };

	    scaler00:scaler@0 {
		work_mode = <1>;
	    };

	    scaler10:scaler@4 {
		work_mode = <1>;
	    };

	    scaler20:scaler@8 {
		work_mode = <1>;
	    };

	    scaler30:scaler@12 {
		work_mode = <1>;
            };
...
			sensor0:sensor@0 {
				device_type = "sensor0";
				sensor0_mname = "gc2053_mipi";
				sensor0_twi_cci_id = <1>;
				sensor0_twi_addr = <0x6e>;
				sensor0_mclk_id = <0>;
				sensor0_pos = "rear";
				sensor0_isp_used = <1>;
				sensor0_fmt = <1>;
...
				status	= "okay";
			};
...
			sensor1:sensor@1 {
			    device_type = "sensor1";
			    sensor1_mname = "gc2053_mipi_2";
			    sensor1_twi_cci_id = <0>;
			    sensor1_twi_addr = <0x7f>;
			    sensor1_mclk_id = <1>;
			    sensor1_pos = "front";
			    sensor1_isp_used = <1>;
			    sensor1_fmt = <1>;
...
			    status	= "okay";
			};
```

这里可以先读出几层信息：

## 1）板子有一个 `vind0`
也就是 `vin.c` 里 `vin_probe()` 对应的顶层 VIN 媒体设备实例。

## 2）这个 VIN 顶层下挂了：
- `sensor0`
- `sensor1`
- `tdm0`
- `isp00`
- `scaler00/10/20/30`
- 多个 `vinc@x`

## 3）两个 sensor 都是 MIPI RAW sensor
例如：
- `sensor0_mname = "gc2053_mipi"`
- `sensor0_isp_used = <1>`
- `sensor0_fmt = <1>`

这里基本可理解为：
- 用 ISP
- 格式是 RAW Bayer
- 所以链路不是简单直通，而是要经过 ISP

---

# 二、DTS 里真正决定“谁连谁”的关键不是 `sensor` 节点，而是 `vinc@x`

在这个驱动架构里，**`vinc@x` 是逻辑 pipeline 的配置锚点**。

比如：

```220:308:/home/ubuntu/v851s/tina-v853-100ask/device/config/chips/v853/configs/100ask/board.dts
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

这里就已经明确了：

## `vinc0` 的链路选择
- `rear_sensor_sel = 0` → 用 `sensor0`
- `mipi_sel = 0` → 接 `mipi0`
- `csi_sel = 0` → 接 `csi0`
- `tdm_rx_sel = 0` → 接 `tdm0` 的 rx0
- `isp_sel = 0` → 接 `isp0`
- scaler 最终在 `vin.c` 里按 `vinc id` 对应启用

## `vinc1` 的链路选择
- `rear_sensor_sel = 1` → 用 `sensor1`
- `mipi_sel = 1` → 接 `mipi1`
- `csi_sel = 1` → 接 `csi1`
- `tdm_rx_sel = 1` → 接 `tdm0` 的 rx1 或逻辑 rx1
- `isp_sel = 1` → 接 `isp1`

所以这个 DTS 的“连线图”并不是通过 endpoint 写出来的，而是通过 `*_sel` 索引选择出来的。

---

# 三、DTS 是如何被 `vin` 驱动解析的

这一步在 `parse_modules_from_device_tree(vind)` 完成，它不在 `vin.c`，而在 `utility/config.c`。

## 1）先遍历 `sensor` 节点，建立 `vind->modules[i].sensors`

看这里：

```781:861:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/utility/config.c
	for_each_available_child_of_node(parent, child) {
		if (!strcmp(child->name, "sensor")) {
			cam = child;
			sscanf(cam->type, "sensor%d", &i);
			vin_log(VIN_LOG_CONFIG, "get sensor%d config for device tree\n", i);
			module = &vind->modules[i];
			sensors = &module->sensors;
		} else {
			continue;
		}
...
		for (j = 0; j < ARRAY_SIZE(fetch_camera); j++) {
			if (!fetch_camera[j].flag)
				continue;

			sprintf(property, "%s_%s",
				cam->type, fetch_camera[j].sub);
			fetch_camera[j].fun(cam,
				property, sensors);
		}
...
		sensors->detect_num = 1;
	}
```

这一步把 DTS 的：

- `sensor0_mname`
- `sensor0_twi_cci_id`
- `sensor0_twi_addr`
- `sensor0_mclk_id`
- `sensor0_pos`
- `sensor0_isp_used`
- `sensor0_fmt`
- 各类电源/复位/PDN GPIO

都解析进：

- `vind->modules[0].sensors`
- `vind->modules[1].sensors`

也就是说，**sensor 节点决定的是“相机模块自身信息”**。

---

## 2）再遍历 `vinc` 节点，把 sensor 和 csi 关联起来

接着看第二段：

```862:900:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/utility/config.c
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
		sprintf(property, "%s_front_sensor_sel", child->type);
		if (get_value_int(child, property, &i))
			i = 1;
		module = &vind->modules[i];
		sensors = &module->sensors;
		sprintf(property, "%s_csi_sel", child->type);
		get_value_int(child, property, &sensors->csi_sel);
...
	}
```

这段的意义是：

- `sensor` 节点只知道“我是哪个 sensor”
- `vinc` 节点告诉驱动“这个 sensor 应该挂在哪个 CSI 上”

比如：
- `vinc0_rear_sensor_sel = 0`
- `vinc0_csi_sel = 0`

于是 `modules[0].sensors.csi_sel = 0`

同理：
- `vinc1_rear_sensor_sel = 1`
- `vinc1_csi_sel = 1`

于是 `modules[1].sensors.csi_sel = 1`

所以：
- `sensor0` 最终属于 `CSI0`
- `sensor1` 最终属于 `CSI1`

---

# 四、`vin_probe()` 之后，`vin.c` 怎么把这些模块注册为实体

在 `vin_probe()` 里，先调：

```1993:2003:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
	if (dev->of_node) {
		ret = vin_md_register_entities(vind, dev->of_node);
	} else {
		vin_err("Device tree of_node is NULL!\n");
		ret = -ENOSYS;
		goto err_clk;
	}
```

而 `vin_md_register_entities()` 会依次注册：

- sensor / flash / actuator
- `vin_core`
- CSI
- TDM
- MIPI
- ISP
- scaler

见这里：

```1382:1481:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int vin_md_register_entities(struct vin_md *vind,
						struct device_node *parent)
{
...
	for (i = 0; i < VIN_MAX_DEV; i++) {
...
		for (j = 0; j < sensors->detect_num; j++) {
...
			if (__vin_register_module(vind, module, j)) {
				sensors->valid_idx = j;
				break;
			}
		}
...
	}

	for (i = 0; i < VIN_MAX_DEV; i++) {
...
		vind->vinc[i] = sunxi_vin_core_get_dev(i);
...
		vin_md_register_core_entity(vind, vind->vinc[i]);
	}

	for (i = 0; i < VIN_MAX_CSI; i++) {
		vind->csi[i].sd = sunxi_csi_get_subdev(i);
...
#ifdef SUPPORT_ISP_TDM
	for (i = 0; i < VIN_MAX_TDM; i++) {
...
			vind->tdm[i].tdm_rx[j].sd = sunxi_tdm_get_subdev(i, j);
...
	for (i = 0; i < VIN_MAX_MIPI; i++) {
		vind->mipi[i].sd = sunxi_mipi_get_subdev(i);
...
	for (i = 0; i < VIN_MAX_ISP; i++) {
		vind->isp[i].sd = sunxi_isp_get_subdev(i);
...
	for (i = 0; i < VIN_MAX_SCALER; i++) {
		vind->scaler[i].sd = sunxi_scaler_get_subdev(i);
...
```

此时只是“都注册进来”，**还没连成一条链**。

---

# 五、真正建立模块连接的是 `vin_create_media_links()`

这是整个问题的核心。

---

## 1）sensor 是怎么连到 MIPI / CSI 的

```1517:1553:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		/*MIPI*/
		if (vinc->mipi_sel == 0xff)
			mipi = NULL;
		else
			mipi = vind->mipi[vinc->mipi_sel].sd;
		/*CSI*/
		if (vinc->csi_sel == 0xff)
			csi = NULL;
		else
			csi = vind->csi[vinc->csi_sel].sd;

		if (mipi != NULL) {
			/*link MIPI sensor*/
			module = &vind->modules[vinc->rear_sensor];
			sensor_link_to_mipi_csi(module, mipi);
			if (vinc->rear_sensor != vinc->front_sensor) {
				module = &vind->modules[vinc->front_sensor];
				sensor_link_to_mipi_csi(module, mipi);
			}
...
			source = &mipi->entity;
			sink = &csi->entity;
			ret = media_create_pad_link(source, MIPI_PAD_SOURCE,
						       sink, CSI_PAD_SINK,
						       MEDIA_LNK_FL_ENABLED);
		} else {
			/*link Bt.601 sensor*/
...
			module = &vind->modules[vinc->rear_sensor];
			sensor_link_to_mipi_csi(module, csi);
```

逻辑是：

### 如果 `mipi_sel != 0xff`
链路是：

`sensor -> mipi -> csi`

### 如果 `mipi_sel == 0xff`
链路是：

`sensor -> csi`

也就是并口/Bt.601 这类不经过 MIPI 的情况。

---

### 对你这个 DTS 来说
`vinc0_mipi_sel = 0`、`vinc1_mipi_sel = 1`，所以是：

- `sensor0 -> mipi0 -> csi0`
- `sensor1 -> mipi1 -> csi1`

---

## 2）CSI 是怎么连到 TDM / ISP 的

看这里：

```1555:1585:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
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
			ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
						sink, VIN_SD_PAD_SINK,
						MEDIA_LNK_FL_ENABLED);
...
		} else {
			source = &csi->entity;
			sink = &isp->entity;
			ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
						sink, VIN_SD_PAD_SINK,
						MEDIA_LNK_FL_ENABLED);
		}
#endif
```

这说明：

### 有 TDM 时
链路是：

`CSI -> TDM_RX -> ISP`

### 没有 TDM 时
链路是：

`CSI -> ISP`

---

### 对你这个 DTS 来说
因为：
- `tdm0.work_mode = <1>`
- `isp00.work_mode = <1>`
- `scaler00/10/20/30.work_mode = <1>`
- `vinc0_tdm_rx_sel = <0>`
- `vinc1_tdm_rx_sel = <1>`

这个板子走的是 **offline 模式 + TDM 通道**，所以典型链路是：

- `sensor0 -> mipi0 -> csi0 -> tdm_rx0 -> isp0 -> scaler0 -> vinc0 -> video0`
- `sensor1 -> mipi1 -> csi1 -> tdm_rx1 -> isp1 -> scaler1 -> vinc1 -> video1`

注意：这里的 `tdm0` 是一个 TDM 设备，但里面通常有多个 `tdm_rx[x]` 子接收通道。  
所以 `vinc0_tdm_rx_sel = 0`、`vinc1_tdm_rx_sel = 1` 可以理解成用不同的 rx 入口。

---

## 3）ISP 是怎么连到 scaler 的

`vin_create_media_links()` 里会把 **每个 ISP 和每个 scaler 都创建一条可选 link**：

```1769:1790:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
	for (i = 0; i < VIN_MAX_ISP; i++) {
		isp = vind->isp[i].sd;
		if (isp == NULL)
			continue;
		source = &isp->entity;
...
		for (j = 0; j < VIN_MAX_SCALER; j++) {
			scaler = vind->scaler[j].sd;
			if (scaler == NULL)
				continue;
			sink = &scaler->entity;
			ret = media_create_pad_link(source, ISP_PAD_SOURCE,
						sink, SCALER_PAD_SINK, 0);
			vin_log(VIN_LOG_MD, "created link [%s] %c> [%s]\n",
				source->name, '-', sink->name);
		}
	}
```

这点非常关键：

- `ISP -> scaler` 不是只建一条
- 而是建很多“候选 link”
- 最后再在 `vin_setup_default_links()` 中按 `vinc->vipp_sel` 选一条默认使能

---

## 4）scaler 是怎么连到 capture/vinc 的

```1590:1615:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
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
...
		source = &cap_sd->entity;
		sink = &vinc->vid_cap.vdev.entity;
		ret = media_create_pad_link(source, VIN_SD_PAD_SOURCE,
					       sink, 0, MEDIA_LNK_FL_ENABLED);
```

这里有一个设计特点：

- `scaler` 的选择直接按 `i`，也就是当前 `vinc` 的 index 来取 `vind->scaler[i]`
- 然后：
  - `scaler -> cap_subdev`
  - `cap_subdev -> video node`

所以最终用户空间看到的是 `/dev/videoX`，但前一跳其实是 `vinc->vid_cap.subdev`。

---

# 六、`vin_setup_default_links()` 为什么还要再做一次

前面 `vin_create_media_links()` 建了很多 link，但有些是“候选链路”。  
真正默认启用的是这里：

```1792:1828:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int vin_setup_default_links(struct vin_md *vind)
{
...
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

		if (link) {
...
			ret = media_entity_setup_link(link, MEDIA_LNK_FL_ENABLED);
...
		}

		p = &vinc->vid_cap.pipe;
		vin_md_prepare_pipeline(p, &vinc->vid_cap.vdev.entity);
	}
```

它做两件事：

## 1）找到当前 `vinc` 选中的 `isp -> scaler` link
也就是：
- `vinc->isp_sel`
- `vinc->vipp_sel`

## 2）把它设为 enabled
然后立刻：

## 3）从 video node 开始做一次 `vin_md_prepare_pipeline()`
把整条 pipeline 缓存在 `vinc->vid_cap.pipe` 中。

---

# 七、现在重点看 `vin_md_prepare_pipeline()` 到底怎么“遍历 pipeline”

这是你问的核心。

函数本身：

```75:121:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static void vin_md_prepare_pipeline(struct vin_pipeline *p,
				  struct media_entity *me)
{
	struct v4l2_subdev *sd;
	int i;

	for (i = 0; i < VIN_IND_ACTUATOR; i++)
		p->sd[i] = NULL;

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

		if (pad == NULL)
			break;

		sd = media_entity_to_v4l2_subdev(pad->entity);
...
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
		case VIN_GRP_ID_SCALER:
			p->sd[VIN_IND_SCALER] = sd;
			break;
		case VIN_GRP_ID_CAPTURE:
			p->sd[VIN_IND_CAPTURE] = sd;
			break;
		default:
			break;
		}
		me = &sd->entity;
		if (me->num_pads == 1)
			break;
	}
}
```

---

## 它的遍历方式不是“遍历 DTS”
而是：

### 从当前 entity 出发
这里调用点是：

```1826:1827:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		p = &vinc->vid_cap.pipe;
		vin_md_prepare_pipeline(p, &vinc->vid_cap.vdev.entity);
```

也就是从 **video device entity** 开始。

---

## 它每一轮做什么？
### 第一步：找当前 entity 的 sink pad
```c
if (!(spad->flags & MEDIA_PAD_FL_SINK))
    continue;
```

### 第二步：通过 `media_entity_remote_pad(spad)` 找到这个 sink 对应的远端 source pad
也就是找到“上游是谁”。

### 第三步：把远端 entity 转成 `v4l2_subdev`
```c
sd = media_entity_to_v4l2_subdev(pad->entity);
```

### 第四步：根据 `grp_id` 记到 `p->sd[]`
比如：
- sensor 放到 `p->sd[VIN_IND_SENSOR]`
- mipi 放到 `p->sd[VIN_IND_MIPI]`
- csi 放到 `p->sd[VIN_IND_CSI]`
- tdm_rx 放到 `p->sd[VIN_IND_TDM_RX]`
- isp 放到 `p->sd[VIN_IND_ISP]`
- scaler 放到 `p->sd[VIN_IND_SCALER]`
- capture 放到 `p->sd[VIN_IND_CAPTURE]`

### 第五步：把当前遍历点切换到上游 entity
```c
me = &sd->entity;
```

### 第六步：继续往前找，直到没有更上游，或只有一个 pad
---

# 八、结合本 DTS，`vin_md_prepare_pipeline()` 的实际遍历路径

以 `vinc0` 为例，假设已经默认启用了：

- `sensor0 -> mipi0 -> csi0 -> tdm_rx0 -> isp0 -> scaler0 -> cap0 -> video0`

那么 `vin_md_prepare_pipeline(p, &video0_entity)` 的反向遍历过程就是：

---

## 第 0 步：起点是 `video0 entity`
它的 sink pad 来自 `cap0 subdev`

找到远端：
- `cap0`

记录：
- `p->sd[VIN_IND_CAPTURE] = cap0`

然后 `me = cap0`

---

## 第 1 步：当前是 `cap0 entity`
它的 sink pad 来自 `scaler0`

找到远端：
- `scaler0`

记录：
- `p->sd[VIN_IND_SCALER] = scaler0`

然后 `me = scaler0`

---

## 第 2 步：当前是 `scaler0 entity`
它的 sink pad 来自 `isp0`

找到远端：
- `isp0`

记录：
- `p->sd[VIN_IND_ISP] = isp0`

然后 `me = isp0`

---

## 第 3 步：当前是 `isp0 entity`
如果当前模式是 offline + TDM，`isp0` 的 sink 来自 `tdm_rx0`

找到远端：
- `tdm_rx0`

记录：
- `p->sd[VIN_IND_TDM_RX] = tdm_rx0`

然后 `me = tdm_rx0`

---

## 第 4 步：当前是 `tdm_rx0 entity`
它的 sink 来自 `csi0`

找到远端：
- `csi0`

记录：
- `p->sd[VIN_IND_CSI] = csi0`

然后 `me = csi0`

---

## 第 5 步：当前是 `csi0 entity`
它的 sink 来自 `mipi0`

找到远端：
- `mipi0`

记录：
- `p->sd[VIN_IND_MIPI] = mipi0`

然后 `me = mipi0`

---

## 第 6 步：当前是 `mipi0 entity`
它的 sink 来自 `sensor0`

找到远端：
- `sensor0`

记录：
- `p->sd[VIN_IND_SENSOR] = sensor0`

然后 `me = sensor0`

---

## 第 7 步：当前是 `sensor0 entity`
sensor 通常没有更上游的 sink remote pad，所以 `pad == NULL`，循环结束。

---

## 最终 `p->sd[]` 中就缓存了一整条链
对应关系大致是：

- `p->sd[SENSOR] = sensor0`
- `p->sd[MIPI] = mipi0`
- `p->sd[CSI] = csi0`
- `p->sd[TDM_RX] = tdm_rx0`
- `p->sd[ISP] = isp0`
- `p->sd[SCALER] = scaler0`
- `p->sd[CAPTURE] = cap0`

这就是后面开关电、开关流的基础。

---

# 九、为什么 `vin_md_prepare_pipeline()` 必须反向遍历，而不是正向？

因为它是从 **当前被打开的视频节点** 出发的。

驱动在运行态最明确知道的是：
- 用户打开了哪个 `/dev/videoX`

但这个 videoX 背后可能连接：
- 哪个 scaler
- 哪个 isp
- 哪个 csi
- 哪个 sensor

这些都取决于当前被使能的 media link。

所以最可靠的方式不是“猜配置”，而是：
> 从 video 节点沿已建立/已启用的 media graph 往上游回溯。

这正是 `vin_md_prepare_pipeline()` 的价值。

---

# 十、`vin_md_prepare_pipeline()` 和 DTS 的关系，到底是什么

这个关系要分清：

## DTS 的作用
DTS 负责提供：
- sensor 模块信息
- `vincX_*_sel` 选择关系
- 某些模块 offline/online 工作模式
- GPIO、电源、时钟参数

## `vin_create_media_links()` 的作用
根据 DTS 解析结果和 `vinc` 参数：
- 创建 graph 上的 link

## `vin_md_prepare_pipeline()` 的作用
不再看 DTS，直接看 **已经构建好的 media graph**
- 从 `video entity` 反向找到上游所有模块

所以可以说：

> DTS 决定“理论上该怎么连”，`vin_create_media_links()` 把理论变成 media link，`vin_md_prepare_pipeline()` 再从实际 media link 中恢复出当前 pipeline。

---

# 十一、你这个 DTS 下，CSI、TDM、ISP、scaler 的连接关系可以总结成什么

结合当前配置，比较典型的是两条主链：

## pipeline 0
- `sensor0 = gc2053_mipi`
- `mipi0`
- `csi0`
- `tdm_rx0`
- `isp0`
- `scaler0`
- `vinc0/capture0`
- `video0`

## pipeline 1
- `sensor1 = gc2053_mipi_2`
- `mipi1`
- `csi1`
- `tdm_rx1`
- `isp1`
- `scaler1`
- `vinc1/capture1`
- `video1`

而 `vin.c` 的连接方式是：

### 阶段 1：建立基础链
- `sensor -> mipi`
- `mipi -> csi`
- `csi -> tdm_rx`
- `tdm_rx -> isp`
- `isp -> scaler`
- `scaler -> capture`
- `capture -> video`

### 阶段 2：从 video 反向恢复 pipeline
- `video <- capture <- scaler <- isp <- tdm_rx <- csi <- mipi <- sensor`

---

# 十二、为什么 DTS 里 `work_mode = <1>` 很重要

你这个 DTS 明确写了：

```98:123:/home/ubuntu/v851s/tina-v853-100ask/device/config/chips/v853/configs/100ask/board.dts
		/*offline mode*/
            tdm0:tdm@0 {
		work_mode = <1>;
	    };

	    isp00:isp@0 {
		work_mode = <1>;
	    };

	    scaler00:scaler@0 {
		work_mode = <1>;
	    };
...
```

这说明是 **offline mode**。  
在 offline 模式下，TDM 会参与链路，典型上就是：

- CSI 先把输入送到 TDM RX
- TDM 做离线缓存/中转
- 再送 ISP
- ISP 再送 scaler

所以你在 `vin_create_media_links()` 里会看到 `CSI -> TDM_RX -> ISP` 这条链，而不是直接 `CSI -> ISP`。

如果没有 TDM 或者某模式不使用 TDM，那么链路就会简化为：
- `CSI -> ISP`

---

# 十三、这个 pipeline 结果最终拿来做什么

`vin_md_prepare_pipeline()` 填出来的 `p->sd[]`，后面直接被用于：

## 1）开关电源
```846:872:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int vin_pipeline_s_power(struct vin_pipeline *p, bool on)
```

## 2）open/close pipeline
```874:910:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int __vin_pipeline_open(...)
static int __vin_pipeline_close(...)
```

## 3）stream on/off
```913:1066:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int __vin_pipeline_s_stream(struct vin_pipeline *p, int on_idx)
```

也就是说，`vin_md_prepare_pipeline()` 的意义不是“看看链路”，而是：
> 生成一张运行时可直接控制的 pipeline 设备表。

---

# 十四、最后给你一个最直观的图

以 `vinc0` 为例，在这个 `board.dts` 配置下，可把逻辑理解为：

```text
DTS配置:
sensor0 + vinc0_csi_sel=0 + vinc0_mipi_sel=0 + vinc0_tdm_rx_sel=0 + vinc0_isp_sel=0

probe阶段:
parse_modules_from_device_tree()
    -> 解析sensor0信息
    -> 解析vinc0选择关系

注册阶段:
vin_md_register_entities()
    -> 注册 sensor0 / mipi0 / csi0 / tdm_rx0 / isp0 / scaler0 / vinc0

建图阶段:
vin_create_media_links()
    -> sensor0 -> mipi0
    -> mipi0   -> csi0
    -> csi0    -> tdm_rx0
    -> tdm_rx0 -> isp0
    -> isp0    -> scaler0
    -> scaler0 -> vinc0_capture
    -> vinc0_capture -> video0

准备pipeline:
vin_md_prepare_pipeline(video0)
    -> capture
    -> scaler0
    -> isp0
    -> tdm_rx0
    -> csi0
    -> mipi0
    -> sensor0
```

---

如果你愿意，我下一步可以继续帮你做两件事中的一个：

1. **继续深挖 `vinc@x` 到 `vin_core.c` 的映射**，把 `vinc0_csi_sel / vipp_sel / isp_sel` 是在 `vin_core` 里怎么变成 `vinc->xxx_sel` 的源码链路找出来；  
2. **结合 `gc2053_mipi.c + sunxi_mipi.c + sunxi_csi.c`**，继续分析从 `sensor s_stream` 到 MIPI/CSI 开始出数的具体执行顺序。

