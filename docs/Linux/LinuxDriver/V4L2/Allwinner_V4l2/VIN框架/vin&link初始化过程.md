# VIN框架上层驱动分析
_Exported on 2026/4/10 at GMT+8 18:06:18 from Cursor (2.6.21)_

---

**User**

能否结合VIN框架源码lichee\linux-4.9\drivers\media\platform\sunxi-vin，先详细分析一下lichee\linux-4.9\drivers\media\platform\sunxi-vin\vin.c上层驱动的作用？

---

**Cursor**

可以，先给你一个结论：

`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c` 不是某个具体硬件模块的“底层采集驱动”，而是 **整个 Allwinner VIN 框架的上层总控/媒体管理驱动**。  
它的核心职责是：

1. **把 sensor / mipi / csi / isp / scaler / vin_core 这些子模块统一注册到 V4L2 Media Controller 框架里**
2. **创建各个 subdev 之间的 media graph 链路**
3. **在打开视频节点、启动采集、停止采集时，按照 pipeline 顺序统一做电源、时钟、stream 控制**
4. **作为 platform driver 读取 device tree、时钟、GPIO、模块配置，完成 VIN 整体实例化**
5. **向上给用户空间暴露一个完整的 camera pipeline，而不是单独暴露某个硬件块**

也就是说，`vin.c` 更像“导演/调度器”，而不是“演员”。  
真正干活的硬件模块驱动分别在这些目录里：

- `vin-csi/`：CSI parser
- `vin-mipi/`：MIPI D-PHY / CSI-2 接收
- `vin-isp/`：ISP
- `vin-vipp/`：scaler / vipp
- `vin-video/`：video node / capture 输出
- `modules/sensor/`：具体 sensor 驱动
- `vin-cci/`：CCI/I2C 控制

---

## 一、先从 VIN 整体框架看 `vin.c` 在什么位置

从目录结构就能看出来，`sunxi-vin` 是一个分层架构：

- **模块层**
  - sensor、flash、actuator
- **硬件处理链路层**
  - MIPI / CSI / ISP / SCALER
- **视频输出层**
  - `vin-video/vin_core.c`
- **顶层管理层**
  - `vin.c`

`vin.h` 里的 `struct vin_md` 基本就定义了这个顶层管理对象，它集中持有所有子模块对象和媒体框架对象：

```101:173:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.h
struct vin_md {
	struct vin_csi_info csi[VIN_MAX_CSI];
	struct vin_mipi_info mipi[VIN_MAX_MIPI];
	struct vin_cci_info cci[VIN_MAX_CCI];
	struct vin_isp_info isp[VIN_MAX_ISP];
	struct vin_tdm_info tdm[VIN_MAX_TDM];
	struct vin_stat_info stat[VIN_MAX_ISP];
	struct vin_scaler_info scaler[VIN_MAX_SCALER];
	struct vin_core *vinc[VIN_MAX_DEV];
	struct vin_clk_info clk[VIN_MAX_CLK];
	struct vin_clk_info mipi_clk[VIN_MIPI_MAX_CLK];
	struct vin_mclk_info mclk[VIN_MAX_CCI];
	struct vin_clk_info isp_clk[VIN_ISP_MAX_CLK];
	struct modules_config modules[VIN_MAX_DEV];
	struct csic_feature_list csic_fl;
	struct csic_version csic_ver;
	unsigned int isp_ver_major;
	unsigned int isp_ver_minor;
	unsigned int is_empty;
	unsigned int id;
	unsigned int irq;
	int use_count;
	void __iomem *base;
	void __iomem *ccu_base;
	void __iomem *cmb_top_base;
	struct media_device media_dev;
	struct v4l2_device v4l2_dev;
	struct platform_device *pdev;
	bool user_subdev_api;
	spinlock_t slock;
	bool sensor_power_on;
	bool clk_en;
};
```

这里最关键的是两点：

- `media_dev`：媒体设备，负责整个 media graph
- `v4l2_dev`：V4L2 核心设备，subdev 都挂到这里
- `csi/mipi/isp/scaler/vinc/modules`：统一由 `vin_md` 管理

所以 `vin.c` 本质上就是围绕 `vin_md` 做生命周期管理。

---

## 二、`vin.c` 的定位：V4L2 Media Controller 上层编排器

文件头部自己也写得很直白：

```1:10:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
/*
 * vin.c for all v4l2 subdev manage
 *
 * Copyright (c) 2017 by Allwinnertech Co., Ltd.  http://www.allwinnertech.com
 *
 * Authors:  Zhao Wei <zhaowei@allwinnertech.com>
 *	Yang Feng <yangfeng@allwinnertech.com>
 */
```

这里的关键词是：`all v4l2 subdev manage`。  
说明这个文件就是管理所有 V4L2 subdev 的。

### 它不是直接采图
真正的采图 DMA、buffer 管理、video 节点 ioctl 更多在 `vin-video/vin_core.c`、`vin_video.c` 中完成。

### 它也不是直接驱动 sensor
sensor 驱动在 `modules/sensor/*.c` 中，每个 sensor 是单独的 subdev。

### 它负责把这些拼起来
把分散的模块组织成一条可工作的 pipeline，比如：

`sensor -> mipi -> csi -> isp -> scaler -> vin_core -> video node`

---

## 三、`vin_init()`：先把整个 VIN 家族子驱动注册起来

`vin.c` 的入口非常关键：

```2162:2245:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int __init vin_init(void)
{
	int ret;

	vin_log(VIN_LOG_MD, "Welcome to Video Input driver\n");
	ret = sunxi_csi_platform_register();
	if (ret) {
		vin_err("Sunxi csi driver register failed\n");
		return ret;
	}

#ifdef SUPPORT_ISP_TDM
	ret = sunxi_tdm_platform_register();
	if (ret) {
		vin_err("Sunxi tdm driver register failed\n");
		return ret;
	}
#endif

	ret = sunxi_isp_platform_register();
	if (ret) {
		vin_err("Sunxi isp driver register failed\n");
		return ret;
	}

	ret = sunxi_mipi_platform_register();
	if (ret) {
		vin_err("Sunxi mipi driver register failed\n");
		return ret;
	}

	ret = sunxi_flash_platform_register();
	if (ret) {
		vin_err("Sunxi flash driver register failed\n");
		return ret;
	}

	ret = sunxi_scaler_platform_register();
	if (ret) {
		vin_err("Sunxi scaler driver register failed\n");
		return ret;
	}

	ret = sunxi_vin_core_register_driver();
	if (ret) {
		vin_err("Sunxi vin register driver failed!\n");
		return ret;
	}
...
	ret = platform_driver_register(&vin_driver);
```

这个初始化顺序体现了 `vin.c` 的“上层调度”属性：

1. 先注册各个硬件子模块 driver
2. 再注册 `vin_core`
3. 最后才注册 `vin_driver` 自己

### 为什么这么做？
因为 `vin_probe()` 里要去拿这些子设备对象，比如：

- `sunxi_csi_get_subdev(i)`
- `sunxi_mipi_get_subdev(i)`
- `sunxi_isp_get_subdev(i)`
- `sunxi_scaler_get_subdev(i)`
- `sunxi_vin_core_get_dev(i)`

也就是说，`vin.c` 自己并不创建这些模块，而是 **等这些模块先就绪，再统一把它们纳入媒体框架**。

这就是典型的“上层框架驱动”行为。

---

## 四、`vin_probe()`：顶层驱动真正开始搭台

`vin_probe()` 是理解 `vin.c` 的核心。

### 1）分配 `vin_md` 并映射顶层寄存器

```1860:1897:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int vin_probe(struct platform_device *pdev)
{
	struct device *dev = &pdev->dev;
	struct device_node *np = pdev->dev.of_node;
	struct v4l2_device *v4l2_dev;
	struct vin_md *vind;
...
	vind = devm_kzalloc(dev, sizeof(*vind), GFP_KERNEL);
...
	of_property_read_u32(np, "device_id", &pdev->id);
...
	vind->base = of_iomap(np, 0);
...
	csic_top_set_base_addr(vind->id, (unsigned long)vind->base);

	vind->ccu_base = of_iomap(np, 1);
...
```

说明 `vin.c` 负责顶层 `CSIC TOP/CCU` 基地址管理。  
这不是具体 CSI/ISP 私有模块内部的寄存器，而是 VIN 总体公共资源的寄存器入口。

---

### 2）读取模块配置：device tree + module_param

`vin.c` 既支持模块参数覆盖，也支持从 dts 解析 camera 拓扑。

```1898:1938:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
	for (num = 0; num < VIN_MAX_DEV; num++) {
#ifdef CONFIG_FLASH_MODULE
		vind->modules[num].modules.flash.type = VIN_MODULE_TYPE_GPIO;
#endif
		vind->modules[num].sensors.inst[0].cam_addr = i2c0_addr;
		strcpy(vind->modules[num].sensors.inst[0].cam_name, ccm0);
		vind->modules[num].sensors.inst[0].act_addr = act_slave;
		strcpy(vind->modules[num].sensors.inst[0].act_name, act_name);
		vind->modules[num].sensors.use_sensor_list = use_sensor_list;
...
	}
...
	parse_modules_from_device_tree(vind);
```

这里说明：

- `ccm0/ccm1`、`i2c0_addr/i2c1_addr`、`act_name/act_slave` 可以通过模块参数传入
- 但主体配置仍来自 `parse_modules_from_device_tree(vind)`

所以 `vin.c` 负责把“板级 camera 资源描述”转成内部 `modules_config`。

这一步很重要，因为后续：
- 注册哪个 sensor
- sensor 挂哪个总线
- 用哪个 mclk
- 对应哪个 csi/mipi/isp/vipp
都依赖这里的配置结果。

---

### 3）建立 V4L2 + Media Device 顶层对象

```1942:1963:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
	strlcpy(vind->media_dev.model, "Allwinner Vin",
		sizeof(vind->media_dev.model));

	vind->media_dev.ops = &media_device_ops;
	vind->media_dev.dev = dev;

	v4l2_dev = &vind->v4l2_dev;
	v4l2_dev->mdev = &vind->media_dev;
	strlcpy(v4l2_dev->name, "sunxi-vin", sizeof(v4l2_dev->name));

	ret = v4l2_device_register(dev, &vind->v4l2_dev);
...
	media_device_init(&vind->media_dev);
	ret = media_device_register(&vind->media_dev);
```

这一步意味着：

- `vin.c` 是整个 camera media graph 的宿主
- 所有 subdev 最终都归这个 `v4l2_device` 管
- 用户空间通过 media controller 能看到完整拓扑

也就是说，`vin.c` 是 **媒体设备级别的总入口**。

---

## 五、`vin_md_register_entities()`：把所有 subdev 纳管

这是 `vin.c` 最核心的职责之一：**统一注册实体**。

```1363:1480:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int vin_md_register_entities(struct vin_md *vind,
						struct device_node *parent)
{
	int i, j, ret;

	vin_log(VIN_LOG_MD, "%s\n", __func__);

	for (i = 0; i < VIN_MAX_DEV; i++) {
		struct modules_config *module = NULL;
		struct sensor_list *sensors = NULL;
...
		for (j = 0; j < sensors->detect_num; j++) {
			if (sensors->use_sensor_list == 1)
				__vin_handle_sensor_info(i, &sensors->inst[j]);

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
		ret = v4l2_device_register_subdev(&vind->v4l2_dev,
							vind->csi[i].sd);
	}
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

### 这段代码做了什么？
#### 第一层：注册外部器件
- sensor
- actuator
- flash

#### 第二层：注册内部硬件 subdev
- CSI
- MIPI
- ISP
- scaler
- stat
- tdm（可选）

#### 第三层：注册 capture 核心
- `vin_core` 对应 capture subdev/video 输出

### 它的意义
这一步把原本分散的设备都接入了 V4L2 的 subdev 世界。  
没有这一步，后面的 media graph、link、stream/power 级联都无从谈起。

---

## 六、`vin_create_media_links()`：真正把 pipeline 连起来

实体注册完，还只是“每个模块都在”。  
真正让它们成为“采集链路”的，是建 link。

```1592:1760:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int vin_create_media_links(struct vin_md *vind)
{
	struct v4l2_subdev *mipi, *csi, *isp, *scaler, *cap_sd;
...
	for (i = 0; i < VIN_MAX_DEV; i++) {
		vinc = vind->vinc[i];
...
		if (mipi != NULL) {
			module = &vind->modules[vinc->rear_sensor];
			sensor_link_to_mipi_csi(module, mipi);
...
			source = &mipi->entity;
			sink = &csi->entity;
			ret = media_create_pad_link(source, MIPI_PAD_SOURCE,
						       sink, CSI_PAD_SINK,
						       MEDIA_LNK_FL_ENABLED);
		} else {
			module = &vind->modules[vinc->rear_sensor];
			sensor_link_to_mipi_csi(module, csi);
		}
...
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
...
	}

	for (i = 0; i < VIN_MAX_CSI; i++) {
...
		for (j = 0; j < VIN_MAX_ISP; j++) {
			ret = media_create_pad_link(source, CSI_PAD_SOURCE,
						       sink, ISP_PAD_SINK, 0);
		}
	}

	for (i = 0; i < VIN_MAX_ISP; i++) {
...
		for (j = 0; j < VIN_MAX_SCALER; j++) {
			ret = media_create_pad_link(source, ISP_PAD_SOURCE,
						sink, SCALER_PAD_SINK, 0);
		}
	}
```

### 这说明 `vin.c` 是做什么的？
它不是简单“注册设备”，而是 **建立整个媒体管线拓扑**。

你可以把它理解成：

- sensor 输出 pad 接到 mipi 或 csi
- mipi 输出 pad 接 csi
- csi 输出 pad 接 isp
- isp 输出 pad 接 scaler
- scaler 输出 pad 接 vin_core capture subdev
- capture subdev 再接 video node

### 为什么说这是“上层驱动”？
因为这些 link 不是任何单个子模块自己能决定的。  
这是 **站在全局视角** 才能完成的工作，所以一定在 `vin.c` 里做。

---

## 七、`vin_setup_default_links()`：给默认通路上电路由

创建 link 只是“可连接”，默认还要启用实际使用那条。

```1762:1799:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int vin_setup_default_links(struct vin_md *vind)
{
...
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

### 作用
- 选定默认的 ISP -> SCALER 路由
- 为 `vin_core` 对应的视频设备预先准备 pipeline

换句话说，`vin.c` 连“默认工作链路”也帮你选好了。

---

## 八、`vin_md_prepare_pipeline()`：从视频节点反向梳理整条采集链

这是一个典型的 Media Controller 风格函数：  
从最终视频输出 entity 往前遍历，找到整个 pipeline 上有哪些 subdev。

```58:108:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static void vin_md_prepare_pipeline(struct vin_pipeline *p,
				  struct media_entity *me)
{
	struct v4l2_subdev *sd;
	int i;

	for (i = 0; i < VIN_IND_ACTUATOR; i++)
		p->sd[i] = NULL;

	while (1) {
		struct media_pad *pad = NULL;
...
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
...
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

### 它的意义
这个函数把 pipeline 上涉及的模块归类到：

- sensor
- mipi
- csi
- tdm_rx
- isp
- scaler
- capture

后续开关电、开关流，都是基于这张 pipeline 表来做。

这体现出 `vin.c` 是 **pipeline manager**。

---

## 九、`vin.c` 统一管理“电源时钟”而不是让每个模块各自乱来

### 1）顶层时钟获取：`vin_md_get_clocks()`

前面你看到的长函数 `vin_md_get_clocks()`，主要负责：

- 取 top clk
- 取 mclk
- 取 isp clk
- 取 mipi clk
- 设置 parent / rate

它是 VIN 顶层资源管理者。

### 2）顶层总电源控制：`vin_md_set_power()`

```365:450:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static void vin_md_set_power(struct vin_md *vind, int on)
{
...
	if (on) {
		vin_md_clk_enable(vind);
...
		csic_top_enable(vind->id);
		csic_top_version_read_en(vind->id, 1);
		csic_feature_list_get(vind->id, &vind->csic_fl);
		csic_version_get(vind->id, &vind->csic_ver);
...
	} else {
...
		csic_top_disable(vind->id);
...
		vin_md_clk_disable(vind);
	}
}
```

### 它控制什么？
- VIN top 时钟
- ISP/MIPI 相关总时钟
- CSIC top enable/disable
- 平台级 CCU gating
- 版本与 feature 读取

这不是 sensor 驱动能做的事，也不是 CSI/ISP 单独能决定的。  
它一定是上层总控做的。

---

## 十、`vin_pipeline_s_power()`：按 pipeline 顺序开关 subdev 电源

这个函数很关键，它决定了 pipeline 的上电/下电顺序：

```846:872:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int vin_pipeline_s_power(struct vin_pipeline *p, bool on)
{
	static const u8 seq[2][VIN_IND_MAX] = {
		{ VIN_IND_ISP, VIN_IND_SENSOR, VIN_IND_CSI, VIN_IND_MIPI,
			VIN_IND_SCALER, VIN_IND_CAPTURE  },
		{ VIN_IND_CAPTURE, VIN_IND_MIPI, VIN_IND_CSI, VIN_IND_SENSOR,
			VIN_IND_ISP, VIN_IND_SCALER},
	};
...
		ret = __vin_subdev_set_power(p->sd[idx], idx, on);
...
}
```

### 这说明什么？
`vin.c` 作为上层驱动，负责：
- 决定谁先上电
- 决定谁后下电
- 统一调用各个 subdev 的 `core->s_power`

这就是“编排”而不是“执行”。

---

## 十一、`__vin_pipeline_open()` / `__vin_pipeline_close()`：打开视频设备时的整链路准备

```874:910:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int __vin_pipeline_open(struct vin_pipeline *p,
				struct media_entity *me, bool prepare)
{
...
	if (prepare)
		vin_md_prepare_pipeline(p, me);

	vind = entity_to_vin_mdev(me);
	if (vind)
		vin_md_set_power(vind, 1);

	ret = vin_pipeline_s_power(p, 1);
...
}

static int __vin_pipeline_close(struct vin_pipeline *p)
{
...
	if (p->sd[VIN_IND_SENSOR])
		ret = vin_pipeline_s_power(p, 0);

	vind = entity_to_vin_mdev(&sd->entity);
	if (vind)
		vin_md_set_power(vind, 0);
...
}
```

### 含义
打开视频节点时：

1. 找到 pipeline 上的所有 subdev
2. 开 VIN 顶层电源/时钟
3. 再依次给各个 subdev 上电

关闭时反过来。

### 这体现出 `vin.c` 与 `vin_core` 的关系
`vin_core` 更像 capture 输出端。  
而 `vin.c` 是 capture 背后整个 pipeline 的控制器。

---

## 十二、`__vin_pipeline_s_stream()`：统一启动/停止流

这是 `vin.c` 的另一个关键点：**统一做 stream on/off 调度**。

```913:1066:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int __vin_pipeline_s_stream(struct vin_pipeline *p, int on_idx)
{
	static const u8 seq[5][VIN_IND_MAX] = {
		/*close*/
		{ VIN_IND_CAPTURE, VIN_IND_SCALER, VIN_IND_ISP, VIN_IND_TDM_RX, VIN_IND_CSI,
			VIN_IND_MIPI, VIN_IND_SENSOR },/*online*/
...
	};

	struct v4l2_mbus_config mcfg;
	struct vin_core *vinc = NULL;
	struct vin_md *vind = NULL;
...
	if (on_idx) {
		v4l2_subdev_call(p->sd[VIN_IND_SENSOR], video, g_mbus_config, &mcfg);
...
		if (vinc->vin_clk && (vinc->vin_clk != vind->clk[VIN_TOP_CLK].frequency)) {
			__vin_set_top_clk_rate(vind, vinc->vin_clk);
			vind->clk[VIN_TOP_CLK].frequency = vinc->vin_clk;
		}
...
		csic_isp_input_select(...)
		csic_vipp_input_select(...)
	}
...
	for (i = 0; i < VIN_IND_ACTUATOR; i++) {
		unsigned int idx = seq[on_idx][i];
...
		ret = __vin_subdev_set_stream(p->sd[idx], idx, on);
...
	}
```

### 这段体现了 `vin.c` 的几个上层职责：

#### 1. 根据 sensor 的 mbus 配置调整顶层时钟
不是 sensor 自己调，也不是 ISP 自己调，而是 `vin.c` 统一协调。

#### 2. 配置模块间输入路由
例如：
- `csic_isp_input_select()`
- `csic_vipp_input_select()`

这说明 `vin.c` 还负责 **跨模块数据路径选择**。

#### 3. 按顺序调用每个 subdev 的 `s_stream`
这一步是真正开始采集数据。

所以，`vin.c` 不只是在“注册阶段”起作用，**运行态 streaming 也由它统筹**。

---

## 十三、`vin_md_register_core_entity()`：把 `vin_core` 接入顶层 pipeline 控制

```1343:1361:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int vin_md_register_core_entity(struct vin_md *vind,
					struct vin_core *vinc)
{
	struct v4l2_subdev *sd;
	int ret;
...
	sd = &vinc->vid_cap.subdev;
	v4l2_set_subdev_hostdata(sd, (void *)&vin_pipe_ops);

	ret = v4l2_device_register_subdev(&vind->v4l2_dev, sd);
	if (!ret) {
		vind->vinc[vinc->id] = vinc;
		vinc->vid_cap.user_subdev_api = vind->user_subdev_api;
	}
```

这里最关键的是：

- 把 `vin_pipe_ops` 挂给 `vin_core` 对应 subdev

而 `vin_pipe_ops` 是：

```1068:1072:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static const struct vin_pipeline_ops vin_pipe_ops = {
	.open		= __vin_pipeline_open,
	.close		= __vin_pipeline_close,
	.set_stream	= __vin_pipeline_s_stream,
};
```

这表示：

- `vin_core` 在打开/关闭/流控时，最终回调到 `vin.c`
- 所以 `vin_core` 是前台视频接口
- `vin.c` 是后台 pipeline manager

这就是“上层驱动”的直接证据。

---

## 十四、`vin_remove()` / `vin_exit()`：统一回收整套 VIN 资源

### `vin_remove()`
```2101:2123:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int vin_remove(struct platform_device *pdev)
{
	struct vin_md *vind = (struct vin_md *)dev_get_drvdata(&pdev->dev);

	device_remove_file(&pdev->dev, &dev_attr_subdev_api);
	vin_md_put_clocks(vind);
	vin_gpio_release(vind);
	vin_md_unregister_entities(vind);
	v4l2_device_unregister(&vind->v4l2_dev);
	media_device_unregister(&vind->media_dev);
	media_device_cleanup(&vind->media_dev);
...
}
```

### `vin_exit()`
```2247:2265:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static void __exit vin_exit(void)
{
	vin_log(VIN_LOG_MD, "vin_exit\n");
	platform_driver_unregister(&vin_driver);
	sunxi_mipi_debug_unregister_driver();
	sunxi_isp_reg_debug_unregister_driver();
	sunxi_vin_debug_unregister_driver();
	sunxi_vin_core_unregister_driver();
	sunxi_csi_platform_unregister();
#ifdef SUPPORT_ISP_TDM
	sunxi_tdm_platform_unregister();
#endif
	sunxi_isp_platform_unregister();
	sunxi_mipi_platform_unregister();
	sunxi_flash_platform_unregister();
	sunxi_scaler_platform_unregister();
...
}
```

这再次说明 `vin.c` 是“总装配者”：
- probe 时统一组装
- remove/exit 时统一拆解

---

# 十五、可以把 `vin.c` 的作用总结成 6 个层面

---

## 1）平台资源管理者
负责：
- device tree 解析
- 顶层寄存器映射
- clock 获取与设置
- GPIO 请求释放
- 顶层中断申请（如 multi-frame）

即：**把板级资源准备好**

---

## 2）模块发现与注册管理者
负责：
- 根据配置找到 sensor/actuator/flash
- 获取 CSI/MIPI/ISP/SCALER/VIN_CORE subdev
- 注册到统一的 `v4l2_device`

即：**把分散模块纳入统一框架**

---

## 3）media graph 构建者
负责：
- 创建 sensor -> mipi/csi -> isp -> scaler -> capture -> video 的 link
- 设置默认使能 link

即：**把孤立模块连成一条可工作的数据链路**

---

## 4）pipeline 生命周期管理者
负责：
- prepare pipeline
- open/close pipeline
- stream on/off pipeline

即：**在用户打开视频节点时，管理整条链路而不是单点设备**

---

## 5）全局电源时钟协调者
负责：
- 顶层 clk enable/disable
- 各 subdev `s_power`
- 各 subdev `s_stream`
- top/isp/mipi 路由与时钟配置

即：**保证各模块按照正确顺序工作**

---

## 6）用户空间接口背后的总控
虽然用户空间最终常见的是 `/dev/videoX`，但背后真正把链路拉起来的是 `vin.c`。

- `vin_core` 面向 video node
- `vin.c` 面向全 pipeline

---

# 十六、它和 `vin_core.c` 的边界怎么分？

这是很多人最容易混淆的地方。

## `vin.c`
偏“系统级/框架级/上层”
- 组织所有 subdev
- 管 media graph
- 管 pipeline
- 管顶层时钟/电源
- 管整体 probe/remove

## `vin_core.c`
偏“视频节点/采集输出级”
- video device 注册
- vb2 buffer 队列
- ioctl / qbuf / dqbuf / streamon
- capture 子设备与具体输出行为

可以简单理解为：

- `vin_core.c`：前台营业窗口
- `vin.c`：后台总调度中心

---

# 十七、如果结合 V853/V851 这类平台实际看，`vin.c` 为什么特别重要？

因为这类 SoC 的 camera 并不是“sensor 直出到 video 节点”这么简单，而是中间可能经过：

- CCI/I2C 控 sensor
- MIPI/并口输入
- CSI parser
- ISP
- scaler/VIPP
- DMA/capture

而且不同板子、不同传感器、不同接口的组合都不一样。

所以必须有一个上层驱动来解决：

1. **当前板子到底挂了哪个 sensor**
2. **这个 sensor 走 MIPI 还是 DVP**
3. **这个 VIN 设备应该接哪条 CSI / ISP / VIPP**
4. **stream on 时顺序怎么排**
5. **clock 应该升到多少**
6. **link 默认该启哪条**

这些都不是单个子驱动能独立完成的。  
`vin.c` 就是为了解决这个“多模块拼装与协同”问题而存在的。

---

# 十八、最后一句话概括 `vin.c`

`vin.c` 的本质作用可以概括为：

> **它是 sunxi VIN 框架的顶层媒体管理驱动，负责把 sensor、MIPI、CSI、ISP、Scaler、Capture 等多个 V4L2 subdev 组织成一条完整的视频输入 pipeline，并统一管理其注册、链路、时钟、电源和流控制。**

---

如果你愿意，我下一步可以继续结合 `sun8iw21p1.dtsi` 和 `vin-video/vin_core.c`，再给你画一张 **V853 平台 VIN 从 DTS 到 `/dev/videoX` 的完整调用链/数据流图**，这样你后面再看 `gc2053_mipi.c`、`sunxi_mipi.c`、`sunxi_csi.c` 就会非常清楚。

