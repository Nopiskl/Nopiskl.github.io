# A733 DSI Panel Analysis

## 背景

本文结合以下文件，分析 `agent/dts.lhs` 中为什么会出现两个 `panel`，以及全志 DRM BSP 最终如何决定实际使用哪一个面板配置。

- `agent/dts.lhs`
- `bsp/drivers/drm/panel/panel-dsi.c`
- `bsp/drivers/drm/sunxi_drm_dsi.c`
- `brandy/brandy-2.0/u-boot-2018/drivers/video/drm/panels/panel-dsi.c`
- `brandy/brandy-2.0/u-boot-2018/drivers/video/drm/sunxi_drm_dsi.c`
- `device/config/chips/a733/configs/pro3/linux-6.6/board.dts`
- `device/config/chips/a733/configs/pro3/uboot-board.dts`

## 结论

`agent/dts.lhs` 里不是“同时挂了两块屏”，而是：

1. `dsi0` 先连接到一个 `allwinner,virtual-panel`
2. 这个 `virtual-panel` 再通过 `panel_out` 端口二选一，指向两个候选 `allwinner,panel-dsi`
3. 内核 DRM 最终只会解析并启用其中一个真实 panel 配置
4. 选择依据是 `panel-out-reg`
5. `panel-out-reg` 通常由 U-Boot 在启动阶段决定并回写到内核 DT

如果没有额外写入 `panel-out-reg`，按当前内核代码的默认行为，会选第 0 个输出端点，也就是 `panel_output_0` 对应的第一个 panel。

## 一、`agent/dts.lhs` 的显示拓扑

`agent/dts.lhs` 里的 `dsi0` 并不是直接连接真实 panel，而是先连接一个 `virtual-panel`：

来源：`agent/dts.lhs:6951-7012`

```dts
ports {
	port@0 {
		endpoint@0 {
			remote-endpoint = <0xdd>;
		};
	};

	port@1 {
		endpoint {
			remote-endpoint = <0xde>;
		};
	};
};

panel@0 {
	compatible = "allwinner,virtual-panel";
	...
	ports {
		port@0 {
			endpoint@0 {
				remote-endpoint = <0xdf>;
			};
		};

		port@1 {
			endpoint@0 {
				remote-endpoint = <0xe0>;
			};

			endpoint@1 {
				remote-endpoint = <0xe1>;
			};
		};
	};
};
```

这表示链路是：

`dsi0 -> virtual-panel -> endpoint@0 或 endpoint@1`

而这两个输出端点分别连到两个真实 panel 节点。

### 候选 panel 0

来源：`agent/dts.lhs:8062-8124`

```dts
ICNL9951R_JT109WXL001_A02_hd@0 {
	compatible = "allwinner,panel-dsi";
	...
	display-timings { ... };
	port {
		endpoint@0 {
			remote-endpoint = <0x128>;
		};
	};
};
```

### 候选 panel 1

来源：`agent/dts.lhs:8127-8188`

```dts
HX83102G_C00ZJ1091X24401_hd@0 {
	compatible = "allwinner,panel-dsi";
	...
	display-timings { ... };
	port {
		endpoint@0 {
			remote-endpoint = <0x12a>;
		};
	};
};
```

### 别名也说明它们是两个候选入口

来源：`agent/dts.lhs:8751-8758`

```dts
ICNL9951R_JT109WXL001_A02_hd = "/ICNL9951R_JT109WXL001_A02_hd@0";
panel0_in = "/ICNL9951R_JT109WXL001_A02_hd@0/port/endpoint@0";
HX83102G_C00ZJ1091X24401_hd = "/HX83102G_C00ZJ1091X24401_hd@0";
panel1_in = "/HX83102G_C00ZJ1091X24401_hd@0/port/endpoint@0";
```

## 二、为什么要配两个 panel

从 DTS 内容可以看出，这两个 panel 的板级资源高度一致：

- 都是 `compatible = "allwinner,panel-dsi"`
- 都是 4 lane DSI
- `width-mm` / `height-mm` 一致
- 供电资源一致
- 复位 GPIO / 使能 GPIO 一致
- 背光引用一致

真正不同的主要是：

- `panel-init-sequence`
- `display-timings`

这通常意味着同一块板子可能兼容两种不同料号、不同驱动 IC、或者不同时序参数的屏。  
所以 DTS 不是在描述“双屏同时显示”，而是在描述“一条 DSI 硬件链路可以兼容两种面板参数”。

## 三、内核 DRM 如何选择实际 panel

### 1. `virtual-panel` 是 DSI 侧真正匹配到的设备

来源：`bsp/drivers/drm/panel/panel-dsi.c:828-842`

```c
static const struct of_device_id dsi_of_match[] = {
	{
		.compatible = "allwinner,virtual-panel",
		.data = NULL,
	},
};

static const struct of_device_id platform_of_match[] = {
	{
		.compatible = "allwinner,panel-dsi",
		.data = NULL,
	},
};
```

这里说明：

- `virtual-panel` 走的是 DSI panel driver
- 真正的 `panel-dsi` 节点更像“参数来源节点”

### 2. 内核通过 `panel-out-reg` 选择 child panel

来源：`bsp/drivers/drm/panel/panel-dsi.c:77-107`

```c
static struct device *sunxi_of_get_child_panel(struct device *dev)
{
	struct device_node *node = dev->of_node;
	...
	u32 reg = 0;

	of_property_read_u32(node, "panel-out-reg", &reg);
	panel_node = of_graph_get_endpoint_by_regs(node, 1, reg);
	...
	child_node = of_graph_get_remote_port_parent(panel_node);
	...
	child_panel_dev = &pdev->dev;
```

这里的关键点是：

- 从 `virtual-panel` 节点读取 `panel-out-reg`
- 在 `port@1` 下按编号查找 `endpoint`
- 找到这个端点连接到的真实 panel 节点

因此内核不会同时使用两个 panel，而是只会选择一个 child panel。

### 3. `panel_dsi_probe()` 只解析被选中的那个 panel

来源：`bsp/drivers/drm/panel/panel-dsi.c:849-945`

```c
panel_dev = sunxi_of_get_child_panel(dev);
if (panel_dev) {
	...
	np = panel_dev->of_node;
	dsi_panel->panel_dev = panel_dev;
} else {
	...
	np = dev->of_node;
	dsi_panel->panel_dev = dev;
}

ret = panel_dsi_of_get_desc_data(dev, d, np);
...
dsi_panel->panel.dev = dsi_panel->panel_dev;
ret = drm_panel_of_backlight(&dsi_panel->panel);
...
mipi_dsi_attach(dsi);
```

这里说明：

- `np = panel_dev->of_node`，也就是后续读取的是被选中的真实 panel 节点
- 模式、初始化序列、背光、供电、GPIO 都来自这个被选中的 panel

### 4. 供电 / GPIO / 背光也是从被选中的 child panel 读取

来源：`bsp/drivers/drm/panel/panel-dsi.c:512-611`

```c
np = dsi_panel->panel_dev->of_node;
of_property_read_u32(np, "power-num", &dsi_panel->power_num);
...
dsi_panel->supply[i] =
	devm_regulator_get_optional(dsi_panel->panel_dev, power_name);
...
dsi_panel->enable_gpio[i] =
	devm_gpiod_get_optional(dsi_panel->panel_dev, gpio_name, GPIOD_OUT_HIGH);
...
dsi_panel->reset_gpio =
	devm_gpiod_get_optional(dsi_panel->panel_dev, "reset", GPIOD_OUT_HIGH);
```

这进一步确认：内核驱动最终只围绕一个已选中的 `panel-dsi` 节点取资源。

### 5. DRM connector 只拿当前 panel 的 mode

来源：`bsp/drivers/drm/sunxi_drm_dsi.c:1386-1390`

```c
static int sunxi_dsi_connector_get_modes(struct drm_connector *connector)
{
	struct sunxi_drm_dsi *dsi = connector_to_sunxi_drm_dsi(connector);

	return drm_panel_get_modes(dsi->sdrm.panel, connector);
}
```

而 `panel_dsi_get_modes()` 会遍历当前 panel 的 `display-timings`：

来源：`bsp/drivers/drm/panel/panel-dsi.c:173-205`

```c
static int panel_dsi_get_modes(struct drm_panel *panel,
				struct drm_connector *connector)
{
	struct panel_dsi *dsi_panel = to_panel_dsi(panel);
	const struct panel_desc *desc = dsi_panel->desc;
	...
	for (i = 0; i < desc->timings->num_timings; i++) {
		...
		timing = display_timings_get(desc->timings, i);
		...
		drm_mode_probed_add(connector, mode);
	}
```

因此从模式枚举角度看，也只会看到被选中的那个 panel 的时序。

### 6. DSI host attach 的对象也是 `virtual-panel`

来源：`bsp/drivers/drm/sunxi_drm_dsi.c:1728-1756`

```c
static int sunxi_drm_dsi_host_attach(struct mipi_dsi_host *host,
				struct mipi_dsi_device *device)
{
	struct sunxi_drm_dsi *dsi = host_to_sunxi_drm_dsi(host);
	struct drm_panel *panel = of_drm_find_panel(device->dev.of_node);
	struct panel_dsi *dsi_panel = dev_get_drvdata(panel->dev);
	...
	dsi->sdrm.panel = panel;
	...
	dsi->dsi_para.vrr_setp = dsi_panel->vrr_setp;
	dsi->pll_ss_permille = dsi_panel->pll_ss_permille;
```

这里再次说明：DSI 侧拿到的是那个已经绑定好的 panel 对象，不会同时拿两个 panel 实例。

## 四、U-Boot 如何决定 `panel-out-reg`

### 1. U-Boot 侧支持多 panel 节点探测

来源：`brandy/brandy-2.0/u-boot-2018/drivers/video/drm/panels/panel-dsi.c:866-925`

```c
node = sunxi_of_get_panel_node(dsi_panel->dev, 1);
if (!node) {
	node = sunxi_of_get_panel_node(dsi_panel->dev, 0);
	...
} else
	while (true) {
		node = sunxi_of_get_panel_node(dsi_panel->dev, i);
		...
		data = ofnode_get_property(np_to_ofnode(node), "panel-id-value", &len);
		if (!data || len != 2) {
			...
			break;
		}
		id_reg = data[0];
		id_value = data[1];
		mipi_dsi_dcs_read(dsi_panel->dsi, id_reg, &value, 1);
		...
		if (value == id_value)
			break;
		i++;
	}
...
dsi_panel->dsi->out_reg = i;
```

这段代码的意义是：

- 如果只有一个 panel 节点，就直接使用第 0 个
- 如果存在多个 panel 节点，U-Boot 可以通过 `panel-id-value` 读屏 ID 来判断选哪一个
- 最终把选中的索引保存到 `out_reg`

### 2. U-Boot 把选择结果回写到内核 DT

来源：`brandy/brandy-2.0/u-boot-2018/drivers/video/drm/sunxi_drm_dsi.c:111-112, 596-598`

```c
dsi->panel_out_reg = device->out_reg;
...
fdt_appendprop_u32(working_fdt, node, "panel-out-reg",
		   (uint32_t)dsi->panel_out_reg);
```

这说明启动链路通常是：

1. U-Boot 先决定屏是哪一类
2. U-Boot 把结果写回 `panel-out-reg`
3. 内核 `virtual-panel` 再据此只绑定一个 child panel

## 五、当前 `agent/dts.lhs` 的默认行为

在 `bsp/drivers/drm/panel/panel-dsi.c` 中：

```c
u32 reg = 0;
of_property_read_u32(node, "panel-out-reg", &reg);
panel_node = of_graph_get_endpoint_by_regs(node, 1, reg);
```

如果 `panel-out-reg` 不存在，那么 `reg` 保持默认值 `0`。

而 `agent/dts.lhs` 里 `virtual-panel` 的两个输出是：

- `endpoint@0 -> panel0_in -> ICNL9951R_JT109WXL001_A02_hd@0`
- `endpoint@1 -> panel1_in -> HX83102G_C00ZJ1091X24401_hd@0`

因此单看 `agent/dts.lhs` 当前内容，如果没有 U-Boot 或别处补写 `panel-out-reg`，默认会走第 0 个输出，也就是：

`ICNL9951R_JT109WXL001_A02_hd@0`

## 六、和 `pro3` 标准板级 DTS 的对比

### Linux DTS 中，`pro3` 只有一个 panel 输出

来源：`device/config/chips/a733/configs/pro3/linux-6.6/board.dts:1865-1884`

```dts
panel: panel@0 {
	// panel-out-reg = <0x00000001>; /* TODO: need to be fixed in the uboot */
	compatible = "allwinner,virtual-panel";
	...
	panel_out: port@1 {
		reg = <1>;
		panel_output_0: endpoint@0 {
			reg = <0>;
			remote-endpoint = <&panel0_in>;
		};
	};
};
```

同时对应的真实 panel 也只有一个：

来源：`device/config/chips/a733/configs/pro3/linux-6.6/board.dts:93-378`

```dts
panel_0: panel_0@0 {
	compatible = "allwinner,panel-dsi";
	...
	port {
		panel0_in: endpoint@0 {
			reg = <0>;
			remote-endpoint = <&panel_output_0>;
		};
	};
};
```

### U-Boot DTS 中，`pro3` 也只有一个 panel 输出

来源：`device/config/chips/a733/configs/pro3/uboot-board.dts:653-669`

```dts
panel: panel@0 {
	compatible = "allwinner,virtual-panel";
	...
	panel_out: port@1 {
		reg = <1>;
		panel_output_0: endpoint@0 {
			reg = <0>;
			remote-endpoint = <&panel0_in>;
		};
	};
};
```

这说明：

- `pro3` 标准板级配置是固定单 panel
- `agent/dts.lhs` 则是保留了两个 panel 候选配置
- 因而 `agent/dts.lhs` 更像是兼容多种屏料的一份定制化 DT

## 七、为什么 `agent/dts.lhs` 会比 `pro3` 多一个 panel

结合 DTS 和驱动逻辑，可以推断 `agent/dts.lhs` 多出的第二个 panel，目的是：

- 为同一套板级硬件兼容第二种面板料号
- 保持 DSI 控制器、电源、GPIO、背光资源不变
- 仅切换 panel 初始化序列和时序参数
- 由启动阶段或后续配置决定到底启用哪一套参数

它的设计目标是“多面板兼容”，不是“双 panel 并行”。

## 八、最终结论

`agent/dts.lhs` 配两个 panel 的本质原因是：

- `allwinner,virtual-panel` 作为中间路由层
- 后面挂两个候选 `allwinner,panel-dsi`
- 运行时只选择其中一个

从当前源码链路来看：

1. 内核 DRM 不会同时点亮两个 panel
2. 真正使用哪个 panel，由 `panel-out-reg` 决定
3. `panel-out-reg` 的正常来源是 U-Boot
4. 如果没有额外设置，内核默认会选择索引 0
5. 因此 `agent/dts.lhs` 当前默认更可能落到第一个 panel，即 `ICNL9951R_JT109WXL001_A02_hd@0`

## 九、可直接验证的观察点

如果后续要继续确认系统实际选择了哪个 panel，可以优先检查：

1. 最终运行时 DT 中 `dsi0/panel@0` 是否存在 `panel-out-reg`
2. U-Boot 日志里是否打印过 panel ID 读取结果
3. 内核启动日志里 `panel_dsi_probe` 对应的 child panel 是哪个 `of_node`
4. `/sys/class/dsi/dsi/attr` 下的接口是否能反推出当前绑定的 panel 参数

