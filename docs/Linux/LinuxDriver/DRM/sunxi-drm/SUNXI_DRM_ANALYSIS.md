# 全志 DRM 驱动框架分析

基于代码树：

- `bsp/drivers/drm/`
- `bsp/configs/linux-6.6/sun60iw2p1.dtsi`

本文重点回答两个问题：

1. `bsp/drivers/drm/sunxi_drm_drv.c` 如何通过 component 框架注册、初始化、组装全部子设备
2. `bsp/drivers/drm/sunxi_device` 与 `bsp/drivers/drm/panel` 分别处于什么层级、负责什么、为什么要单独分目录

同时结合 `sun60iw2p1.dtsi` 把驱动层级和设备树 graph 关系串起来。

---

## 1. 先说结论

全志这套 DRM 不是“每个显示模块各自注册一个 DRM 设备”，而是：

1. `sunxi_drm_drv.c` 先注册一批 `platform_driver`
2. 这些 `platform_driver` 对应的 platform device 再通过 `component_add()` 进入 component 框架
3. `allwinner,sunxi-drm` 这个 master 设备在 `probe()` 里收集全部 component
4. master 的 `bind()` 中创建唯一的 `drm_device`
5. 通过 `component_bind_all()` 让 DE、TCON、DSI、LVDS、RGB、HDMI、eDP、TCON_TOP、DSI combo phy 等子设备一起绑定到同一个 `drm_device`
6. 真正完成 DRM 注册是在最后的 `drm_dev_register()`

这里有两个很容易混淆的点：

- `struct drm_driver sunxi_drm_driver` 只是驱动行为模板
- 真正的运行时实例是 `struct sunxi_drm_private` 里的 `base`，也就是唯一的 `struct drm_device`

---

## 2. 目录层级总览

建议把 `bsp/drivers/drm` 先拆成三层看：

### 2.1 DRM glue 层

主要是根目录这些文件：

- `sunxi_drm_drv.c`
- `sunxi_drm_crtc.c`
- `sunxi_drm_dsi.c`
- `sunxi_drm_rgb.c`
- `sunxi_drm_lvds.c`
- `sunxi_drm_hdmi.c`
- `sunxi_drm_edp.c`
- `sunxi_drm_gem.c`
- `sunxi_drm_intf.c`

这一层负责把全志显示硬件“翻译成” DRM 对象和 DRM 行为：

- `drm_device`
- `drm_crtc`
- `drm_plane`
- `drm_encoder`
- `drm_connector`
- `GEM`
- atomic 提交
- DRM 属性
- fbdev 接管

也就是说，这一层是“DRM 框架适配层”。

### 2.2 `sunxi_device` 层

目录：

- `bsp/drivers/drm/sunxi_device/`
- `bsp/drivers/drm/sunxi_device/hardware/`

这一层本质上是“全志 SoC 显示硬件控制层”。

它的职责不是直接向用户空间暴露 DRM 对象，而是负责：

- TCON/TCON_TOP/HDMI/eDP 这些 SoC 内部显示控制器的资源获取、时钟复位、寄存器映射
- 显示链路的硬件配置
- 各 lowlevel 模块的寄存器级编程
- DE、TCON、HDMI PHY、eDP PHY、DSI PHY 等底层能力

可以把它理解成：

- `sunxi_drm_*.c` 负责“DRM 语义”
- `sunxi_device/*.c` 和 `sunxi_device/hardware/*` 负责“硬件语义”

### 2.3 `panel` 层

目录：

- `bsp/drivers/drm/panel/`

这一层是标准 DRM panel 设备层，负责外部显示面板本身：

- 上电/下电
- prepare/enable/disable/unprepare
- 背光
- 面板时序
- 面板复位 GPIO
- 面板电源 GPIO/稳压器

它不是 SoC 内部显示管线的一部分，而是显示链路最末端的 sink。

所以 `panel/` 单独存放非常合理，因为它和 `sunxi_device/` 的抽象层级完全不同：

- `sunxi_device/` 是 SoC 内部显示硬件
- `panel/` 是外部屏模组

---

## 3. 从 Makefile 看层次划分

`bsp/drivers/drm/Makefile` 很直观地把这三层拆开了：

文件：`bsp/drivers/drm/Makefile`

```makefile
# base
sunxidrm-y += sunxi_drm_drv.o sunxi_drm_crtc.o sunxi_drm_intf.o sunxi_drm_notify.o
sunxidrm-y += sunxi_drm_gem.o

# de
include $(srctree)/$(obj)/sunxi_device/hardware/lowlevel_de/Makefile
sunxidrm-$(CONFIG_AW_DRM_DE) += $(de_obj)

# tcon
include $(srctree)/$(obj)/sunxi_device/hardware/lowlevel_tcon/Makefile
sunxidrm-$(CONFIG_AW_DRM_TCON) += $(tcon_obj) \
				  sunxi_device/sunxi_tcon.o \
				  sunxi_device/hardware/lowlevel_lcd/tcon_lcd.o

# dsi
sunxidrm-$(CONFIG_AW_DRM_DSI) += sunxi_drm_dsi.o \
				 sunxi_device/hardware/lowlevel_lcd/dsi_v1.o

# HDMI
sunxidrm-$(CONFIG_AW_DRM_HDMI_TX) += sunxi_drm_hdmi.o
sunxidrm-$(CONFIG_AW_DRM_HDMI_TX) += sunxi_device/sunxi_hdmi.o

# edp
sunxidrm-$(CONFIG_AW_DRM_EDP) += sunxi_drm_edp.o
sunxidrm-$(CONFIG_AW_DRM_EDP) += sunxi_device/sunxi_edp.o

# panel
obj-y += panel/
```

这里的含义非常清楚：

- `sunxi_drm_*.o` 是 DRM glue
- `sunxi_device/*.o` 和 `sunxi_device/hardware/*` 是 SoC 硬件控制层
- `panel/` 是单独子目录，按 panel 驱动方式编译

`panel/Makefile` 也体现了 panel 的独立性：

```makefile
obj-$(CONFIG_PANEL_EDP_GENERAL) += edp_general_panel.o
obj-$(CONFIG_PANEL_DSI_GENERAL) += panel-dsi.o
obj-$(CONFIG_PANEL_LVDS_GENERAL) += panel-lvds.o
obj-$(CONFIG_PANEL_RGB_GENERAL) += panel-rgb.o
```

---

## 4. `sunxi_drm_drv.c` 如何注册并组装全部子设备

这一节是整个框架的主线。

---

## 4.1 `drm_driver` 只是模板，不是运行时设备

文件：`bsp/drivers/drm/sunxi_drm_drv.c`

```c
static struct drm_driver sunxi_drm_driver = {
	.driver_features = DRIVER_MODESET | DRIVER_GEM | DRIVER_ATOMIC,
	.fops = &sunxi_drm_driver_fops,
	.ioctls             = sunxi_drm_ioctls,
	.num_ioctls         = ARRAY_SIZE(sunxi_drm_ioctls),
	.name = DRIVER_NAME,
	.desc = DRIVER_DESC,
	.date = DRIVER_DATE,
	.major = DRIVER_MAJOR,
	.minor = DRIVER_MINOR,
	.gem_create_object = sunxi_gem_create_object,
#if LINUX_VERSION_CODE <= KERNEL_VERSION(6, 1, 0)
	DRM_GEM_CMA_DRIVER_OPS_VMAP,
#else
	DRM_GEM_DMA_DRIVER_OPS_VMAP,
#endif
};
```

它定义的是：

- driver feature
- fops
- ioctl
- GEM 行为

真正运行时实例是在 `sunxi_drm_bind()` 中分配的。

---

## 4.2 全部子驱动先由 `sunxi_drm_drv_init()` 注册

文件：`bsp/drivers/drm/sunxi_drm_drv.c`

```c
static struct platform_driver *sunxi_drm_sub_drivers[] = {
	DRV_PTR(sunxi_tcon_top_platform_driver,		CONFIG_AW_DRM_TCON_TOP),
	DRV_PTR(sunxi_de_platform_driver,		CONFIG_AW_DRM_DE),
	DRV_PTR(sunxi_dsi_combo_phy_platform_driver,	CONFIG_AW_DRM_DSI_COMBOPHY),
	DRV_PTR(sunxi_dsi_platform_driver,		CONFIG_AW_DRM_DSI),
	DRV_PTR(sunxi_lvds_platform_driver,		CONFIG_AW_DRM_LVDS),
	DRV_PTR(sunxi_rgb_platform_driver,		CONFIG_AW_DRM_RGB),
	DRV_PTR(sunxi_hdmi_platform_driver,		CONFIG_AW_DRM_HDMI_TX),
	DRV_PTR(sunxi_drm_edp_platform_driver,		CONFIG_AW_DRM_EDP),
	DRV_PTR(sunxi_tcon_platform_driver,		CONFIG_AW_DRM_TCON),
};
```

```c
static int sunxi_drm_register_drivers(void)
{
	int i, ret;
	for (i = 0; i < ARRAY_SIZE(sunxi_drm_sub_drivers); ++i) {
		struct platform_driver *drv = sunxi_drm_sub_drivers[i];
		if (!drv)
			continue;

		ret = platform_driver_register(drv);
		if (ret)
			break;
	}

	/* add drm master device */
	ret = platform_driver_register(&sunxi_drm_platform_driver);

	return ret;
}
```

```c
module_init(sunxi_drm_drv_init);
module_exit(sunxi_drm_drv_exit);
```

这个阶段完成的事情是：

- 把 DE、TCON、TCON_TOP、DSI、LVDS、RGB、HDMI、eDP、combo phy 的平台驱动都挂进内核
- 最后再注册 master `sunxi_drm_platform_driver`

这说明 `sunxi_drm_drv.c` 是“总装厂”，先把零部件驱动都注册好，再注册总控。

---

## 4.3 master `probe()` 收集全部 component

文件：`bsp/drivers/drm/sunxi_drm_drv.c`

```c
static struct component_match *sunxi_drm_match_add(struct device *dev)
{
	struct component_match *match = NULL;
	int i;

	for (i = 0; i < ARRAY_SIZE(sunxi_drm_sub_drivers); ++i) {
		struct platform_driver *drv = sunxi_drm_sub_drivers[i];
		struct device *p = NULL, *d;

		if (!drv)
			continue;

		while ((d = platform_find_device_by_driver(p, &drv->driver))) {
			put_device(p);
			device_link_add(dev, d, DL_FLAG_STATELESS);
			component_match_add(dev, &match, compare_dev, d);
			p = d;
		}
		put_device(p);
	}

	return match ?: ERR_PTR(-ENODEV);
}
```

```c
static int sunxi_drm_platform_probe(struct platform_device *pdev)
{
	struct component_match *match;

	match = sunxi_drm_match_add(&pdev->dev);
	if (IS_ERR(match))
		return PTR_ERR(match);

	return component_master_add_with_match(&pdev->dev, &sunxi_drm_ops,
					       match);
}
```

这里的逻辑是：

1. 遍历 `sunxi_drm_sub_drivers[]`
2. 根据每个 `platform_driver` 找到已经存在的 platform device
3. 把这些 device 都加入 `component_match`
4. 把当前 `sunxi-drm` 设备注册成 component master

注意：

- 这里收集的是“设备”
- 真正是否作为 component 参与 bind，还要看子驱动自己是否调用了 `component_add()`

这也是为什么 DSI 可以做到“probe 完成了，但还不立刻进入 component bind”。

---

## 4.4 master `bind()` 中创建唯一的 `drm_device`

文件：`bsp/drivers/drm/sunxi_drm_drv.c`

```c
static int sunxi_drm_bind(struct device *dev)
{
	int ret;
	struct drm_device *drm;
	struct sunxi_drm_private *private;
	struct drm_encoder *encoder;
	unsigned int clone_mask = 0;

	private = __devm_drm_dev_alloc(dev, &sunxi_drm_driver,
		  sizeof(*private) + sizeof(struct sunxi_drm_pri),
		    offsetof(struct sunxi_drm_private, base));
	drm = &private->base;
	if (IS_ERR(private))
		return PTR_ERR(private);

	private->priv = ((void *)private) + sizeof(*private);
	ret = drmm_mode_config_init(drm);
	if (ret)
		return ret;

	sunxi_drm_mode_config_init(drm);
	sunxi_drm_property_create(private);

	get_boot_display_info(drm);

	ret = component_bind_all(dev, drm);
	if (ret)
		goto mode_config_clean;

	drm_for_each_encoder(encoder, drm) {
		clone_mask |= BIT(drm_encoder_index(encoder));
	}
	drm_for_each_encoder(encoder, drm) {
		encoder->possible_clones = clone_mask;
	}

	dev_set_drvdata(dev, drm);
	drm_mode_config_reset(drm);
	drm_kms_helper_poll_init(drm);
	...
	ret = drm_dev_register(drm, 0);
	...
	return 0;
}
```

这个函数是全志 DRM 真正的“总装入口”。

它做了几件关键的事：

1. 通过 `__devm_drm_dev_alloc()` 创建真正的 `drm_device`
2. 初始化 `mode_config`
3. 创建全志自定义 DRM 属性
4. 调用 `component_bind_all(dev, drm)`，把所有子模块都绑到这一个 `drm_device`
5. 重置 mode_config、初始化 hotplug poll
6. 最后 `drm_dev_register()`

因此必须明确：

- `component_bind_all()` 在前
- `drm_dev_register()` 在后

也就是说，**先把内部世界组装好，再向 DRM core 和用户空间发布**。

---

## 4.5 `sunxi_drm_private` 和 `sunxi_drm_device` 的区别

文件：`bsp/drivers/drm/sunxi_drm_drv.h`

```c
struct sunxi_drm_device {
	struct drm_connector connector;
	struct drm_encoder encoder;
	struct drm_device *drm_dev;
	struct drm_panel *panel;
	struct drm_bridge *bridge;
	struct device *tcon_dev;
	struct device *video_sys_dev;
	unsigned int tcon_id;
	unsigned int hw_id;
	void (*get_disp_para)(struct drm_device *dev, unsigned long *arg);
	void (*set_disp_para)(struct drm_device *dev, unsigned long *arg);
};

struct sunxi_drm_private {
	struct drm_device base;
	...
	struct sunxi_drm_pri *priv;
};
```

这里：

- `sunxi_drm_private.base` 才是真正的 `drm_device`
- `sunxi_drm_device` 只是全志给“输出设备”定义的公共壳，里面放 connector/encoder/panel/bridge/tcon 这些成员

所以 HDMI/DSI/LVDS/RGB/eDP 驱动里常见的 `sdrm` 不是 DRM core 的 `drm_device`，而是全志自定义的输出封装结构。

---

## 5. 子 component 是怎么分工的

全志的 component 不是全部都创建 DRM 对象，可以分成两类。

### 5.1 创建 DRM 对象的 component

- DE：创建 CRTC、plane、writeback
- HDMI / DSI / RGB / LVDS / eDP：创建 encoder、connector

### 5.2 不直接创建 DRM 对象，但提供硬件基础设施的 component

- TCON：提供时钟/模式初始化/中断/vblank/当前行等服务
- TCON_TOP：提供 top routing/时钟门控/寄存器基址
- DSI combo phy：提供 MIPI/PHY 资源

这一点特别重要，因为很多人看到 `component_add()` 以后，下意识会觉得“每个 component 都会创建 DRM object”，但这里并不是。

---

## 5.3 DE component：负责 CRTC/plane

文件：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c`

```c
static int sunxi_de_bind(struct device *dev, struct device *master, void *data)
{
	int i, j, ret;
	struct drm_device *drm = data;
	struct sunxi_display_engine *engine = dev_get_drvdata(dev);
	...
	for (i = 0; i < engine->display_out_cnt; i++) {
		display_out = &engine->display_out[i];
		...
		info.drm = drm;
		info.de_out = display_out;
		...
		info.plane_cnt = display_out->ch_cnt;
		info.planes = devm_kzalloc(dev, sizeof(*info.planes) * display_out->ch_cnt, GFP_KERNEL);
		for (j = 0; j < display_out->ch_cnt; j++) {
			info.planes[j].name = display_out->ch_hdl[j]->name;
			info.planes[j].is_primary = j == 0;
			info.planes[j].hdl = display_out->ch_hdl[j];
			...
		}
		display_out->scrtc = sunxi_drm_crtc_init_one(&info);
	}

	ret = drm_vblank_init(drm, drm->mode_config.num_crtc);
	...
	engine->wb.drm_wb = sunxi_drm_wb_init_one(&wb_info);
	...
	return 0;
}
```

对应的 `sunxi_drm_crtc_init_one()`：

文件：`bsp/drivers/drm/sunxi_drm_crtc.c`

```c
struct sunxi_drm_crtc *sunxi_drm_crtc_init_one(struct sunxi_de_info *info)
{
	...
	ret = sunxi_drm_plane_init(drm, scrtc, 0, &scrtc->plane[primary_index],
				   DRM_PLANE_TYPE_PRIMARY, info->hw_id,
				   plane);
	...
	drm_crtc_init_with_planes(drm, &scrtc->crtc,
				  &scrtc->plane[primary_index].plane, NULL,
				  &sunxi_crtc_funcs, "DE-%d", info->hw_id);
	...
	ret = sunxi_drm_plane_init(drm, scrtc, drm_crtc_mask(&scrtc->crtc),
			     &scrtc->plane[i], DRM_PLANE_TYPE_OVERLAY,
			     info->hw_id, plane);
	...
}
```

因此 DE 是全套显示管线里最核心的 DRM object provider：

- `display_out` -> `drm_crtc`
- `de_channel_handle` -> `drm_plane`

而 `display_channel_state` 也直接继承了 `drm_plane_state`：

文件：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.h`

```c
struct display_channel_state {
	struct drm_plane_state base;
	...
};
```

这说明 lowlevel DE 和 DRM plane 是直接一一咬合的。

---

## 5.4 TCON / TCON_TOP component：不创建 connector，而是提供“输出时序控制能力”

### TCON probe 与 component 注册

文件：`bsp/drivers/drm/sunxi_device/sunxi_tcon.c`

```c
static int sunxi_tcon_probe(struct platform_device *pdev)
{
	...
	tcon->id = sunxi_tcon_of_get_id(dev);
	tcon->type = get_dev_tcon_type(dev->of_node);
	ret = sunxi_tcon_parse_dts(dev);
	...
	ret = sunxi_tcon_get_tcon_top(tcon);
	...
	ret = component_add(&pdev->dev, &sunxi_tcon_component_ops);
	...
}
```

### TCON bind 本身几乎不创建 DRM 对象

```c
static int sunxi_tcon_bind(struct device *dev, struct device *master,
			   void *data)
{
	return sunxi_tcon_output_create(dev, (struct drm_device *)data);
}

static int sunxi_tcon_output_create(struct device *dev, struct drm_device *drm)
{
	return 0;
}
```

也就是说，TCON 作为 component 进入 master 生命周期，但它不是直接创建 connector/encoder。

它的核心价值在于：

- `sunxi_tcon_mode_init()`
- `sunxi_tcon_mode_exit()`
- `sunxi_tcon_enable_vblank()`
- `sunxi_tcon_get_current_line()`
- `sunxi_tcon_check_fifo_status()`

文件：`bsp/drivers/drm/sunxi_device/sunxi_tcon.c`

```c
int sunxi_tcon_mode_init(struct device *tcon_dev, struct disp_output_config *disp_cfg)
{
	...
	switch (ctrl->cfg.type) {
	case INTERFACE_EDP:
		return sunxi_tcon_edp_mode_init(tcon_dev);
	case INTERFACE_HDMI:
		return sunxi_tcon_hdmi_mode_init(tcon_dev);
	case INTERFACE_DSI:
		return sunxi_tcon_dsi_mode_init(tcon_dev);
	case INTERFACE_LVDS:
		return sunxi_tcon_lvds_mode_init(tcon_dev);
	case INTERFACE_RGB:
		return sunxi_tcon_rgb_mode_init(tcon_dev);
	default:
		break;
	}
	return 0;
}
```

这体现了 TCON 的真实角色：

- 它是时序控制器
- 是输出链路中“DE 和接口模块之间”的硬件桥
- 但不是 DRM connector 本身

### TCON_TOP 也是基础设施型 component

文件：`bsp/drivers/drm/sunxi_device/sunxi_tcon_top.c`

```c
static int sunxi_tcon_top_probe(struct platform_device *pdev)
{
	return component_add(&pdev->dev, &sunxi_tcon_top_component_ops);
}
```

```c
static int sunxi_tcon_top_bind(struct device *dev, struct device *master,
			       void *data)
{
	...
	top->sw_enable = sunxi_drm_check_tcon_top_boot_enabled(drm, top->top_data->id);
	...
	tcon_top_set_reg_base(top->top_data->id, top->reg_base);
	dev_set_drvdata(dev, top);
	return 0;
}
```

它主要负责：

- top 寄存器映射
- 时钟/复位
- runtime PM

同样不直接创建 DRM object。

---

## 5.5 RGB/LVDS/HDMI/eDP component：负责 encoder/connector

### RGB

文件：`bsp/drivers/drm/sunxi_drm_rgb.c`

```c
ret = drm_of_find_panel_or_bridge(dev->of_node, 1, -1,
		&rgb->sdrm.panel, &rgb->sdrm.bridge);
...
tcon_lcd_dev = drm_rgb_of_get_tcon(rgb->dev);
...
ret = drm_simple_encoder_init(drm, &sdrm->encoder, DRM_MODE_ENCODER_DPI);
...
ret = drm_connector_init(drm, &sdrm->connector,
		&sunxi_rgb_connector_funcs,
		DRM_MODE_CONNECTOR_DPI);
...
drm_connector_attach_encoder(&sdrm->connector, &sdrm->encoder);
```

### LVDS

文件：`bsp/drivers/drm/sunxi_drm_lvds.c`

```c
ret = drm_of_find_panel_or_bridge(dev->of_node, 1, -1,
		&lvds->sdrm.panel, &lvds->sdrm.bridge);
...
tcon_lcd_dev = drm_lvds_of_get_tcon(lvds->dev);
...
ret = drm_simple_encoder_init(drm, &sdrm->encoder, DRM_MODE_ENCODER_LVDS);
...
ret = drm_connector_init(drm, &sdrm->connector,
		&sunxi_lvds_connector_funcs,
		DRM_MODE_CONNECTOR_LVDS);
...
drm_connector_attach_encoder(&sdrm->connector, &sdrm->encoder);
```

### HDMI

文件：`bsp/drivers/drm/sunxi_drm_hdmi.c`

```c
ret = _sunxi_hdmi_init_get_tcon(dev);
...
ret = _sunxi_hdmi_init_drm(hdmi);
```

```c
ret = drm_simple_encoder_init(drm, encoder, DRM_MODE_ENCODER_TMDS);
...
ret = drm_connector_init_with_ddc(drm, connect,
		&sunxi_hdmi_connector_funcs, DRM_MODE_CONNECTOR_HDMIA,
		&hdmi->i2c_adap);
...
drm_connector_attach_encoder(connect, encoder);
```

### eDP

文件：`bsp/drivers/drm/sunxi_drm_edp.c`

```c
ret = drm_simple_encoder_init(sdrm->drm_dev, &sdrm->encoder, DRM_MODE_ENCODER_TMDS);
...
ret = drm_connector_init(sdrm->drm_dev, &sdrm->connector,
			 &sunxi_edp_connector_funcs,
			 drm_edp->desc->connector_type);
...
drm_connector_attach_encoder(&sdrm->connector, &sdrm->encoder);
```

所以可以总结成一句话：

- 输出驱动负责 `encoder + connector`
- TCON 负责时序控制
- DE 负责 `CRTC + plane`

---

## 5.6 DSI 是最特殊的一条链路

DSI 和 RGB/LVDS/eDP 的最大不同是：panel 不是通过 OF graph 的 output port 去找，而是通过 MIPI-DSI 总线 attach 进来的。

### DSI probe 只注册 host，不立刻 `component_add`

文件：`bsp/drivers/drm/sunxi_drm_dsi.c`

```c
static int sunxi_drm_dsi_probe(struct platform_device *pdev)
{
	...
	dsi->host.ops = &sunxi_drm_dsi_host_ops;
	dsi->host.dev = dev;
	...
	ret = mipi_dsi_host_register(&dsi->host);
	if (ret)
		return ret;

	return 0;

	/* return component_add(&pdev->dev, &sunxi_drm_dsi_component_ops); */
}
```

这句被注释掉的 `component_add()` 非常关键，说明作者有意不让 DSI 在 `probe()` 阶段过早进入 component bind。

### panel 驱动准备好以后，才 `mipi_dsi_attach()`

文件：`bsp/drivers/drm/panel/panel-dsi.c`

```c
drm_panel_add(&dsi_panel->panel);

dev_set_drvdata(dev, dsi_panel);
mipi_dsi_attach(dsi);
```

### DSI host 的 `.attach` 回调里才 `component_add()`

文件：`bsp/drivers/drm/sunxi_drm_dsi.c`

```c
static int sunxi_drm_dsi_host_attach(struct mipi_dsi_host *host,
				struct mipi_dsi_device *device)
{
	struct sunxi_drm_dsi *dsi = host_to_sunxi_drm_dsi(host);
	struct drm_panel *panel = of_drm_find_panel(device->dev.of_node);
	...
	dsi->sdrm.panel = panel;
	...
	ret = component_add(dsi->dev, &sunxi_drm_dsi_component_ops);
	...
	return 0;
}
```

### DSI bind 本身也明确要求 `panel` 已经存在

```c
if (!dsi->sdrm.panel) {
	DRM_ERROR("[DSI]Failed to find panel\n");
	return -EPROBE_DEFER;
}
```

因此 DSI 的时序是：

1. DSI 控制器 `probe`
2. 注册 `mipi_dsi_host`
3. panel 驱动 `probe`
4. panel 调 `mipi_dsi_attach`
5. DSI host `.attach`
6. 这时才 `component_add`
7. 最后 master `component_bind_all()` 时，DSI 才真正 bind

这样就避免了“panel 还没好，DSI component 就先 bind”的问题。

---

## 6. 设备树 `sun60iw2p1.dtsi` 如何描述整个显示链路

这一份 dtsi 是 SoC 级基础描述，它主要定义：

- master DRM 节点
- DE
- TCON/TCON_TOP
- DSI/LVDS/RGB/HDMI/eDP
- 它们之间的 OF graph 拓扑

但它没有把所有最终面板都描述完整，因为 SoC dtsi 只描述 SoC 通用部分，板级文件通常再补：

- `status = "okay"`
- pinctrl
- 具体 panel 节点
- eDP panel 远端 endpoint
- RGB/LVDS panel 或 bridge 的 output port
- DSI child panel

---

## 6.1 master 节点

文件：`bsp/configs/linux-6.6/sun60iw2p1.dtsi`

```dts
sunxi_drm: sunxi-drm {
	compatible = "allwinner,sunxi-drm";
	fb_base = <0>;
	status = "okay";
};
```

这对应 `sunxi_drm_platform_driver` 的 OF match：

文件：`bsp/drivers/drm/sunxi_drm_drv.c`

```c
static const struct of_device_id sunxi_of_match[] = {
	{ .compatible = "allwinner,sunxi-drm", },
	{},
};
```

它只是整个 component master 的入口，不直接描述 graph。

---

## 6.2 DE 节点：显示引擎源头

文件：`bsp/configs/linux-6.6/sun60iw2p1.dtsi`

```dts
de: de@5000000 {
	compatible = "allwinner,display-engine-v352";
	...
	ports {
		disp0: port@0 {
			disp0_out_tcon0: endpoint@0 { remote-endpoint = <&tcon0_in_disp0>; };
			disp0_out_tcon1: endpoint@1 { remote-endpoint = <&tcon1_in_disp0>; };
			disp0_out_tcon2: endpoint@2 { remote-endpoint = <&tcon2_in_disp0>; };
			disp0_out_tcon3: endpoint@3 { remote-endpoint = <&tcon3_in_disp0>; };
			disp0_out_tcon4: endpoint@4 { remote-endpoint = <&tcon4_in_disp0>; };
		};
		disp1: port@1 {
			disp1_out_tcon0: endpoint@0 { remote-endpoint = <&tcon0_in_disp1>; };
			disp1_out_tcon1: endpoint@1 { remote-endpoint = <&tcon1_in_disp1>; };
			disp1_out_tcon2: endpoint@2 { remote-endpoint = <&tcon2_in_disp1>; };
			disp1_out_tcon3: endpoint@3 { remote-endpoint = <&tcon3_in_disp1>; };
			disp1_out_tcon4: endpoint@4 { remote-endpoint = <&tcon4_in_disp1>; };
		};
	};
};
```

这个 graph 表达的是：

- DE 有两个输出口：`disp0` 和 `disp1`
- 每个输出口都可以路由到不同的 TCON 输入

也就是说，**DE 是显示数据源，TCON 是后级时序控制器**。

---

## 6.3 TCON_TOP 和 TCON

### TCON_TOP

```dts
vo0: vo0@5500000 {
	compatible = "allwinner,tcon-top0";
	...
};

vo1: vo1@5510000 {
	compatible = "allwinner,tcon-top1";
	...
};
```

### TCON LCD / TV

```dts
dlcd0: tcon0@5501000 {
	compatible = "allwinner,tcon-lcd";
	...
	top = <&vo0>;
	ports {
		tcon0_in: port@0 {
			tcon0_in_disp0: endpoint@0 { remote-endpoint = <&disp0_out_tcon0>; };
			tcon0_in_disp1: endpoint@1 { remote-endpoint = <&disp1_out_tcon0>; };
		};
		tcon0_out: port@1 {
			tcon0_out_dsi0: endpoint@0 { remote-endpoint = <&dsi0_in_tcon0>; };
			tcon0_out_dsi1: endpoint@1 { remote-endpoint = <&dsi1_in_tcon0>; };
			tcon0_out_lvds0: endpoint@2 { remote-endpoint = <&lvds0_in_tcon0>; };
			tcon0_out_rgb0: endpoint@3 { remote-endpoint = <&rgb0_in_tcon0>; };
		};
	};
};
```

```dts
tv0: tcon3@5730000 {
	compatible = "allwinner,tcon-tv";
	...
	top = <&vo1>;
	ports {
		tcon3_in: port@0 {
			tcon3_in_disp0: endpoint@0 { remote-endpoint = <&disp0_out_tcon3>; };
			tcon3_in_disp1: endpoint@1 { remote-endpoint = <&disp1_out_tcon3>; };
		};
		tcon3_out: port@1 {
			tcon3_out_hdmi0: endpoint@0 { remote-endpoint = <&hdmi0_in_tcon3>; };
		};
	};
};
```

从 graph 上看，TCON 是真正的“中继层”：

- 输入来自 DE
- 输出去往 DSI/LVDS/RGB/HDMI/eDP

这和驱动里的角色完全一致：

- DE 产生像素内容
- TCON 负责时序与输出控制
- 具体接口驱动再完成各自协议/物理层初始化

---

## 6.4 DSI / RGB / LVDS / HDMI / eDP 在 DTS 中的连接

### DSI

```dts
dsi0: dsi0@5506000 {
	compatible = "allwinner,dsi0";
	...
	ports {
		dsi0_in: port@0 {
			dsi0_in_tcon0: endpoint@0 {
				remote-endpoint = <&tcon0_out_dsi0>;
			};
		};
	};
};
```

驱动匹配：

```c
static const struct of_device_id sunxi_drm_dsi_match[] = {
	{ .compatible = "allwinner,dsi0", .data = &dsi0_data },
	{ .compatible = "allwinner,dsi1", .data = &dsi1_data },
	{},
};
```

DSI 的 panel 不走 `port@1` graph，而是走 MIPI-DSI 子设备 attach。这一点和 RGB/LVDS/eDP 不同。

### RGB

```dts
rgb0: rgb0@0001000 {
	compatible = "allwinner,rgb0";
	ports {
		rgb0_in: port@0 {
			rgb0_in_tcon0: endpoint@0 {
				remote-endpoint = <&tcon0_out_rgb0>;
			};
		};
	};
};
```

驱动会从 `port@0` 找输入 TCON，从 `port@1` 找 panel/bridge：

```c
tcon_lcd_dev = drm_rgb_of_get_tcon(rgb->dev);
ret = drm_of_find_panel_or_bridge(dev->of_node, 1, -1,
		&rgb->sdrm.panel, &rgb->sdrm.bridge);
```

注意：`sun60iw2p1.dtsi` 里只定义了 RGB 的输入端口，没有定义 `port@1` 输出端口，所以可以推断：

- RGB panel 通常会在板级 DTS 中补充 `port@1`
- 或者补 bridge 节点

### LVDS

```dts
lvds0: lvds0@0001000 {
	compatible = "allwinner,lvds0";
	...
	ports {
		lvds0_in: port@0 {
			lvds0_in_tcon0: endpoint@0 {
				remote-endpoint = <&tcon0_out_lvds0>;
			};
		};
	};
};
```

驱动逻辑与 RGB 类似：

```c
tcon_lcd_dev = drm_lvds_of_get_tcon(lvds->dev);
ret = drm_of_find_panel_or_bridge(dev->of_node, 1, -1,
		&lvds->sdrm.panel, &lvds->sdrm.bridge);
```

所以 LVDS 也是：

- SoC dtsi 定义输入链路
- 板级 DTS 补 panel/bridge 的输出端口

### HDMI

```dts
hdmi0: hdmi0@5520000 {
	compatible = "allwinner,sunxi-hdmi";
	...
	ports {
		hdmi_in: port@0 {
			hdmi0_in_tcon3: endpoint@0 {
				remote-endpoint = <&tcon3_out_hdmi0>;
			};
		};
	};
};
```

HDMI 一般不需要在 DTS 静态写一个固定 panel，因为它面对的是外部可热插拔显示器。

### eDP

```dts
edp0: edp0@5720000 {
	compatible = "allwinner,drm-edp";
	...
	ports {
		edp_in: port@0 {
			edp0_in_tcon4: endpoint@0 {
				remote-endpoint = <&tcon4_out_edp0>;
			};
		};
		edp_out: port@1 {
		};
	};
};
```

eDP 与 RGB/LVDS 不同的是：SoC dtsi 已经预留了 `port@1` 输出端，但没有填 remote-endpoint。

驱动明确会从 `port@1` 找 panel：

文件：`bsp/drivers/drm/sunxi_drm_edp.c`

```c
static struct device_node *drm_edp_of_get_panel_node(struct device *edp_dev)
{
	...
	edp_out_panel = of_graph_get_endpoint_by_regs(node, 1, 0);
	...
	panel_node = of_graph_get_remote_port_parent(edp_out_panel);
	...
}
```

也就是说：

- `sun60iw2p1.dtsi` 负责把 eDP controller 到 TCON 的链路搭好
- 板级 DTS 再把 `edp_out` 接到具体 eDP panel

---

## 6.5 结合 DTS 得到的整条数据通路

在 `sun60iw2p1.dtsi` 的当前定义下，SoC 级显示链路可以抽象成：

```text
sunxi-drm(master)
  |
  +-- DE(disp0/disp1)
        |
        +-- TCON0 ----> DSI0 / DSI1 / LVDS0 / RGB0
        +-- TCON1 ----> DSI1
        +-- TCON2 ----> LVDS1 / RGB1
        +-- TCON3 ----> HDMI0
        +-- TCON4 ----> eDP0
```

再往后：

- DSI -> child MIPI DSI panel
- RGB/LVDS -> board DTS 补 panel/bridge
- eDP -> board DTS 补 panel endpoint
- HDMI -> 外部热插拔显示器

---

## 7. `sunxi_device` 和 `panel` 到底是什么层级

这部分单独展开回答第二个问题。

---

## 7.1 `sunxi_device` 是 SoC 内部显示硬件层

它里面主要有两类内容：

### 一类是 controller 驱动

- `sunxi_tcon.c`
- `sunxi_tcon_top.c`
- `sunxi_hdmi.c`
- `sunxi_edp.c`

这些代码的风格很明显更偏硬件控制：

- 时钟/复位
- PM runtime
- 寄存器读写
- PHY / EDID / IRQ / link training

例如 `sunxi_device/sunxi_hdmi.c` 开头就是纯 HDMI 2.0 硬件层：

```c
struct sunxi_hdmi_plat_s sun60i_hdmi = {
	.version = HDMI_SUN60I_W2_P1,
	.use_top_phy            = SUNXI_HDMI_ENABLE,
	.phy_func.phy_init      = snps_phy_init,
	.phy_func.phy_config    = snps_phy_config,
	...
};
```

`sunxi_device/sunxi_edp.c` 开头也明显是 eDP core：

```c
/*
 * core function of edp driver
 */
u8 *sunxi_drm_find_edid_extension(const struct edid *edid,
				   int ext_id, int *ext_index)
{
	...
}
```

### 另一类是 lowlevel 寄存器层

例如：

- `sunxi_device/hardware/lowlevel_de/`
- `sunxi_device/hardware/lowlevel_tcon/`
- `sunxi_device/hardware/lowlevel_lcd/`
- `sunxi_device/hardware/lowlevel_hdmi20/`
- `sunxi_device/hardware/lowlevel_edp/`

这是最底层的寄存器抽象和硬件模块实现。

因此 `sunxi_device/` 单独分目录，是为了把：

- SoC 内部显示硬件控制
- DRM 框架适配

这两种不同抽象层明确隔离开。

---

## 7.2 `panel` 是显示末端设备层

`panel/` 中的驱动统一围绕 `drm_panel` 框架实现。

### RGB panel

文件：`bsp/drivers/drm/panel/panel-rgb.c`

```c
drm_panel_init(&rgb_panel->panel, rgb_panel->dev, &panel_rgb_funcs,
			DRM_MODE_CONNECTOR_DPI);
...
drm_panel_add(&rgb_panel->panel);
```

### LVDS panel

文件：`bsp/drivers/drm/panel/sunxi-panel-simple.c`

```c
drm_panel_init(&lvds->panel, lvds->dev, &panel_lvds_funcs,
	       DRM_MODE_CONNECTOR_LVDS);
...
drm_panel_add(&lvds->panel);
```

### eDP panel

文件：`bsp/drivers/drm/panel/edp_general_panel.c`

```c
drm_panel_init(&edp_panel->panel, edp_panel->dev, &general_panel_funcs,
	       DRM_MODE_CONNECTOR_eDP);
...
drm_panel_add(&edp_panel->panel);
```

### DSI panel

文件：`bsp/drivers/drm/panel/panel-dsi.c`

```c
drm_panel_init(&dsi_panel->panel, dev, &panel_dsi_funcs,
		DRM_MODE_CONNECTOR_DSI);
...
drm_panel_add(&dsi_panel->panel);
...
mipi_dsi_attach(dsi);
```

也就是说 `panel/` 的工作对象是“屏本身”，不是 SoC 显示 controller。

这就是它为什么必须单独成目录：

- 代码职责更聚焦
- 可以独立裁剪
- 可以替换成专用 panel 驱动
- 也更符合上游 Linux DRM 的抽象方式

---

## 7.3 为什么不把 `panel/` 合并进 `sunxi_device/`

如果强行合并，抽象边界会立刻混乱：

- `sunxi_device` 管的是 SoC 内部硬件
- `panel` 管的是外部显示器件

它们的设备树建模、驱动模型、生命周期都不一样：

- TCON/DE/HDMI/eDP/DSI 是 SoC 内部平台设备，通常 `platform_driver`
- DSI panel 还是 `mipi_dsi_driver`
- RGB/LVDS/eDP panel 是 `platform_driver + drm_panel`

所以单独目录不是“代码整理习惯”，而是架构上本来就属于两类设备。

---

## 8. 设备树与驱动绑定对照表

| 设备树 compatible | 驱动文件 | 在框架中的角色 |
| --- | --- | --- |
| `allwinner,sunxi-drm` | `sunxi_drm_drv.c` | component master，创建唯一 `drm_device` |
| `allwinner,display-engine-v352` | `sunxi_device/hardware/lowlevel_de/sunxi_de.c` | DE，创建 CRTC/plane/WB |
| `allwinner,tcon-top0` / `tcon-top1` | `sunxi_device/sunxi_tcon_top.c` | top routing/clock/PM |
| `allwinner,tcon-lcd` / `tcon-tv` | `sunxi_device/sunxi_tcon.c` | 时序控制器，供接口驱动调用 |
| `allwinner,dsi0` / `dsi1` | `sunxi_drm_dsi.c` | DSI encoder/connector glue + MIPI host |
| `allwinner,rgb0` / `rgb1` | `sunxi_drm_rgb.c` | RGB encoder/connector glue |
| `allwinner,lvds0` / `lvds1` | `sunxi_drm_lvds.c` | LVDS encoder/connector glue |
| `allwinner,sunxi-hdmi` | `sunxi_drm_hdmi.c` + `sunxi_device/sunxi_hdmi.c` | HDMI DRM glue + HDMI core |
| `allwinner,drm-edp` | `sunxi_drm_edp.c` + `sunxi_device/sunxi_edp.c` | eDP DRM glue + eDP core |
| `allwinner,sunxi-dsi-combo-phy*` | `phy/sunxi_dsi_combophy.c` | DSI/LVDS/RGB 相关 PHY 资源 |
| `allwinner,virtual-panel` | `panel/panel-dsi.c` | DSI 面板 |
| `sunxi-rgb` | `panel/panel-rgb.c` | RGB 面板 |
| `panel-lvds` | `panel/sunxi-panel-simple.c` | LVDS 面板 |
| `edp-general-panel` | `panel/edp_general_panel.c` | eDP 面板 |

---

## 9. 回答问题 1：`sunxi_drm_drv.c` 是如何通过 component 注册并组装全部子设备的

可以压缩成一条主线：

### 第一步：注册子 `platform_driver`

`sunxi_drm_drv_init()` -> `sunxi_drm_register_drivers()`

### 第二步：子驱动各自 `probe()`

它们做自己的资源初始化，并调用 `component_add()`

典型例子：

- DE：`component_add(&pdev->dev, &sunxi_de_component_ops);`
- RGB：`component_add(&pdev->dev, &sunxi_drm_rgb_component_ops);`
- LVDS：`component_add(&pdev->dev, &sunxi_drm_lvds_component_ops);`
- HDMI：`component_add(dev, &sunxi_hdmi_compoent_ops);`
- eDP：`component_add(&pdev->dev, &sunxi_drm_edp_component_ops);`
- TCON：`component_add(&pdev->dev, &sunxi_tcon_component_ops);`
- TCON_TOP：`component_add(&pdev->dev, &sunxi_tcon_top_component_ops);`
- DSI：延后到 panel attach 后 `component_add()`

### 第三步：master `probe()` 收集 match

`sunxi_drm_platform_probe()` -> `sunxi_drm_match_add()` -> `component_master_add_with_match()`

### 第四步：master `bind()` 创建唯一 `drm_device`

`sunxi_drm_bind()` 中：

- `__devm_drm_dev_alloc()`
- `drmm_mode_config_init()`
- `sunxi_drm_property_create()`
- `component_bind_all(dev, drm)`

### 第五步：各 component bind 到同一个 `drm_device`

这时子模块分别干自己的活：

- DE 创建 `CRTC/plane/WB`
- HDMI/DSI/RGB/LVDS/eDP 创建 `encoder/connector`
- TCON/TCON_TOP/PHY 提供底层硬件支持

### 第六步：master 做收尾并注册 DRM

- `drm_mode_config_reset()`
- `drm_kms_helper_poll_init()`
- `drm_dev_register()`

这就是完整的组装方式。

---

## 10. 回答问题 2：`sunxi_device` 和 `panel` 分别负责什么，为什么分目录

### `sunxi_device`

层级：

- SoC 内部硬件控制层

负责：

- TCON/TCON_TOP/HDMI/eDP 等 controller
- lowlevel 寄存器、时钟、复位、PHY、EDID、IRQ、链路训练
- 为 DRM glue 提供硬件服务接口

为什么单独分目录：

- 这一层不等于 DRM 对象层
- 它和 SoC 硬件实现强耦合
- 同一套硬件层可以被不同 DRM glue 代码复用

### `panel`

层级：

- 显示末端设备层

负责：

- 面板上下电
- 背光
- GPIO
- 时序
- `drm_panel` 注册

为什么单独分目录：

- panel 是外部器件，不是 SoC 内部显示 IP
- panel 驱动模型和 DSI/TCON/HDMI 这些 controller 完全不同
- 易于按具体屏型裁剪和替换

---

## 11. 一个很重要的理解方式

如果把整套代码按“从 DRM 到硬件”垂直分层，可以这么看：

```text
用户空间(KMS/Atomic)
    |
    v
DRM glue 层
  sunxi_drm_drv.c
  sunxi_drm_crtc.c
  sunxi_drm_{dsi,rgb,lvds,hdmi,edp}.c
    |
    v
SoC 内部硬件层
  sunxi_device/*.c
  sunxi_device/hardware/*
    |
    v
外部显示器件层
  panel/*
```

这个分层是理解全志 DRM 代码树最有效的方法。

---

## 12. 补充观察

### 12.1 `sun60iw2p1.dtsi` 更多是在定义 SoC 通用 graph，不是最终板级显示方案

例如：

- `rgb0/rgb1` 只定义了输入端口，没有 SoC 级固定 panel
- `lvds0/lvds1` 也是一样
- `edp0` 预留了 `port@1`，但没有填 remote-endpoint
- `dsi0/dsi1` 只定义控制器，具体 panel 要靠 MIPI DSI child device

因此板级 DTS 仍然很重要。

### 12.2 TCON/TCON_TOP 虽然是 component，但并不直接对应 DRM 对象

这点和很多上游 DRM 驱动不同，容易误判。

在全志这里，TCON 更像：

- “硬件时序服务提供者”
- “接口输出控制器”

而 DRM connector/encoder 仍然由各接口驱动自己创建。

---

## 13. 最终总结

### 关于 `sunxi_drm_drv.c`

它是整个全志 DRM 的总装入口：

- 注册所有子平台驱动
- 建立 component master
- 创建唯一的 `drm_device`
- 调用 `component_bind_all()` 统一组装全部子设备
- 最后 `drm_dev_register()`

### 关于 `sunxi_device`

它是 SoC 内部显示硬件控制层，不直接等同于 DRM 对象层。

### 关于 `panel`

它是显示末端器件层，使用标准 `drm_panel` 模型，和 SoC 内部控制器天然属于不同抽象层。

### 关于 `sun60iw2p1.dtsi`

它定义了 SoC 级显示 graph：

- `sunxi-drm` 为 master
- `DE` 为像素源
- `TCON/TCON_TOP` 为中继/时序层
- `DSI/RGB/LVDS/HDMI/eDP` 为接口输出层
- 最终 panel 通常要由板级 DTS 再补全

