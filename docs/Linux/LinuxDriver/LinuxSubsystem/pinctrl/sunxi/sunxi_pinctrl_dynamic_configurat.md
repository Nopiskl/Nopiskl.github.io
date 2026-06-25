# Sunxi pinctrl dynamic configuration analysis
_Exported on 2026/3/2 at GMT+8 16:09:01 from Cursor (2.3.34)_

---

**User**

drivers/pinctrl/sunxi
以sunxi pinctrl为例，分析一下内核是如何根据dts动态配置pin复用状态的，并中途遇到dev_pin_info的时候解释一下这个结构体的定义

---

**Cursor**

我来帮你分析 sunxi pinctrl 子系统如何根据 DTS 动态配置 pin 复用状态。让我先查看相关的代码文件。

好的,我来详细分析 sunxi pinctrl 子系统如何根据 DTS 动态配置 pin 复用状态。让我先查找 `dev_pin_info` 结构体的定义。

---

**User**

继续

---

**Cursor**

好的，现在让我查看 pinctrl 核心代码中如何使用 `dev_pin_info`：

---

**User**

继续

---

**Cursor**

好的，让我继续查看 pinctrl 核心代码中的关键函数：

好的，现在我已经收集了足够的信息。让我为你详细分析 sunxi pinctrl 子系统如何根据 DTS 动态配置 pin 复用状态。

## Sunxi Pinctrl 子系统 DTS 动态配置 Pin 复用分析

### 整体流程概览

内核通过以下步骤根据 DTS 配置 pin 复用：

**1. 设备驱动 probe 前的自动绑定** → **2. DTS 解析** → **3. 创建映射表** → **4. 应用 pinctrl 状态** → **5. 硬件寄存器配置**

---

### 详细流程分析

#### 阶段 1: 驱动 probe 前的自动绑定

当设备驱动即将 probe 时，设备核心层会自动调用 `pinctrl_bind_pins()`：

```291:291:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/base/dd.c
ret = pinctrl_bind_pins(dev);
```

这个函数在 `drivers/base/pinctrl.c` 中实现：

```22:85:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/base/pinctrl.c
int pinctrl_bind_pins(struct device *dev)
{
	int ret;

	dev->pins = devm_kzalloc(dev, sizeof(*(dev->pins)), GFP_KERNEL);
	if (!dev->pins)
		return -ENOMEM;

	dev->pins->p = devm_pinctrl_get(dev);
	if (IS_ERR(dev->pins->p)) {
		dev_dbg(dev, "no pinctrl handle
");
		ret = PTR_ERR(dev->pins->p);
		goto cleanup_alloc;
	}

	dev->pins->default_state = pinctrl_lookup_state(dev->pins->p,
					PINCTRL_STATE_DEFAULT);
	if (IS_ERR(dev->pins->default_state)) {
		dev_dbg(dev, "no default pinctrl state
");
		ret = 0;
		goto cleanup_get;
	}

	ret = pinctrl_select_state(dev->pins->p, dev->pins->default_state);
	if (ret) {
		dev_dbg(dev, "failed to activate default pinctrl state
");
		goto cleanup_get;
	}

#ifdef CONFIG_PM
	dev->pins->sleep_state = pinctrl_lookup_state(dev->pins->p,
					PINCTRL_STATE_SLEEP);
	if (IS_ERR(dev->pins->sleep_state))
		dev_dbg(dev, "no sleep pinctrl state
");

	dev->pins->idle_state = pinctrl_lookup_state(dev->pins->p,
					PINCTRL_STATE_IDLE);
	if (IS_ERR(dev->pins->idle_state))
		dev_dbg(dev, "no idle pinctrl state
");
#endif

	return 0;
	// ... 错误处理
}
```

---

### 关键结构体：`dev_pin_info`

在这里我们遇到了 `dev_pin_info` 结构体，它的定义在 `include/linux/pinctrl/devinfo.h`：

```23:35:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/include/linux/pinctrl/devinfo.h
struct dev_pin_info {
	struct pinctrl *p;
	struct pinctrl_state *default_state;
#ifdef CONFIG_PM
	struct pinctrl_state *sleep_state;
	struct pinctrl_state *idle_state;
#endif
};
```

**结构体成员说明：**

- `p`: pinctrl 句柄，指向该设备的 pinctrl 控制器实例
- `default_state`: 默认状态，设备正常工作时的 pin 配置
- `sleep_state`: 睡眠状态，设备进入睡眠时的 pin 配置（省电）
- `idle_state`: 空闲状态，设备空闲时的 pin 配置

这个结构体被嵌入到 `struct device` 中：

```745:747:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/include/linux/device.h
#ifdef CONFIG_PINCTRL
	struct dev_pin_info	*pins;
#endif
```

**作用：** 每个设备通过 `dev->pins` 来管理自己的 pin 配置状态，支持运行时在不同状态间切换（如 default/sleep/idle）。

---

#### 阶段 2: DTS 解析 - `pinctrl_dt_to_map()`

`devm_pinctrl_get()` 最终调用 `create_pinctrl()`，其中会调用 `pinctrl_dt_to_map()` 解析 DTS：

```213:295:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/pinctrl/devicetree.c
int pinctrl_dt_to_map(struct pinctrl *p)
{
	struct device_node *np = p->dev->of_node;
	int state, ret;
	char *propname;
	struct property *prop;
	const char *statename;
	const __be32 *list;
	int size, config;
	phandle phandle;
	struct device_node *np_config;

	// ... 省略部分代码

	/* For each defined state ID */
	for (state = 0; ; state++) {
		/* Retrieve the pinctrl-* property */
		propname = kasprintf(GFP_KERNEL, "pinctrl-%d", state);
		prop = of_find_property(np, propname, &size);
		kfree(propname);
		if (!prop)
			break;
		list = prop->value;
		size /= sizeof(*list);

		/* Determine whether pinctrl-names property names the state */
		ret = of_property_read_string_index(np, "pinctrl-names",
						    state, &statename);
		if (ret < 0) {
			statename = prop->name + 8;
		}

		/* For every referenced pin configuration node in it */
		for (config = 0; config < size; config++) {
			phandle = be32_to_cpup(list++);

			/* Look up the pin configuration node */
			np_config = of_find_node_by_phandle(phandle);
			// ...

			/* Parse the node */
			ret = dt_to_map_one_config(p, statename, np_config);
			// ...
		}
	}
	// ...
}
```

**DTS 示例：**

```dts
uart0: serial@01c28000 {
    pinctrl-names = "default";
    pinctrl-0 = <&uart0_pins_a>;
};

uart0_pins_a: uart0@0 {
    allwinner,pins = "PB22", "PB23";
    allwinner,function = "uart0";
    allwinner,drive = <0>;
    allwinner,pull = <1>;
};
```

---

#### 阶段 3: Sunxi 特定的 DTS 节点转换 - `sunxi_pctrl_dt_node_to_map()`

`dt_to_map_one_config()` 会调用 sunxi 驱动的 `dt_node_to_map` 回调：

```147:237:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/pinctrl/sunxi/pinctrl-sunxi.c
static int sunxi_pctrl_dt_node_to_map(struct pinctrl_dev *pctldev,
				      struct device_node *node,
				      struct pinctrl_map **map,
				      unsigned *num_maps)
{
	struct sunxi_pinctrl *pctl = pinctrl_dev_get_drvdata(pctldev);
	unsigned long *pinconfig;
	struct property *prop;
	const char *function;
	const char *group;
	int ret, nmaps, i = 0;
	u32 val;

	*map = NULL;
	*num_maps = 0;

	ret = of_property_read_string(node, "allwinner,function", &function);
	if (ret) {
		dev_err(pctl->dev,
			"missing allwinner,function property in node %s
",
			node->name);
		return -EINVAL;
	}

	nmaps = of_property_count_strings(node, "allwinner,pins") * 2;
	// ...

	*map = kmalloc(nmaps * sizeof(struct pinctrl_map), GFP_KERNEL);
	// ...

	of_property_for_each_string(node, "allwinner,pins", prop, group) {
		// ... 验证 group 和 function

		(*map)[i].type = PIN_MAP_TYPE_MUX_GROUP;
		(*map)[i].data.mux.group = group;
		(*map)[i].data.mux.function = function;

		i++;

		(*map)[i].type = PIN_MAP_TYPE_CONFIGS_GROUP;
		(*map)[i].data.configs.group_or_pin = group;

		// 解析 drive strength 和 pull 配置
		if (!of_property_read_u32(node, "allwinner,drive", &val)) {
			u16 strength = (val + 1) * 10;
			pinconfig[j++] =
				pinconf_to_config_packed(PIN_CONFIG_DRIVE_STRENGTH,
							 strength);
		}

		if (!of_property_read_u32(node, "allwinner,pull", &val)) {
			enum pin_config_param pull = PIN_CONFIG_END;
			if (val == 1)
				pull = PIN_CONFIG_BIAS_PULL_UP;
			else if (val == 2)
				pull = PIN_CONFIG_BIAS_PULL_DOWN;
			pinconfig[j++] = pinconf_to_config_packed(pull, 0);
		}

		(*map)[i].data.configs.configs = pinconfig;
		(*map)[i].data.configs.num_configs = configlen;

		i++;
	}

	*num_maps = nmaps;

	return 0;
}
```

这个函数为每个 pin 创建两个映射：
- **MUX_GROUP**: 设置 pin 的复用功能
- **CONFIGS_GROUP**: 设置 pin 的电气特性（驱动强度、上下拉）

---

#### 阶段 4: 应用 Pinctrl 状态 - `pinctrl_select_state()`

`pinctrl_bind_pins()` 会调用 `pinctrl_select_state()` 激活 default 状态：

```1149:1213:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/pinctrl/core.c
int pinctrl_select_state(struct pinctrl *p, struct pinctrl_state *state)
{
	struct pinctrl_setting *setting, *setting2;
	struct pinctrl_state *old_state = p->state;
	int ret;

	if (p->state == state)
		return 0;

	if (p->state) {
		list_for_each_entry(setting, &p->state->settings, node) {
			if (setting->type != PIN_MAP_TYPE_MUX_GROUP)
				continue;
			pinmux_disable_setting(setting);
		}
	}

	p->state = NULL;

	/* Apply all the settings for the new state */
	list_for_each_entry(setting, &state->settings, node) {
		switch (setting->type) {
		case PIN_MAP_TYPE_MUX_GROUP:
			ret = pinmux_enable_setting(setting);
			break;
		case PIN_MAP_TYPE_CONFIGS_PIN:
		case PIN_MAP_TYPE_CONFIGS_GROUP:
			ret = pinconf_apply_setting(setting);
			break;
		default:
			ret = -EINVAL;
			break;
		}

		if (ret < 0) {
			goto unapply_new_state;
		}
	}

	p->state = state;

	return 0;
	// ... 错误处理
}
```

---

#### 阶段 5: 硬件配置

**5.1 配置 Pin 复用 - `pinmux_enable_setting()` → `sunxi_pmx_set_mux()`**

```67:150:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/pinctrl/pinmux.c
int pinmux_enable_setting(struct pinctrl_setting const *setting)
{
	struct pinctrl_dev *pctldev = setting->pctldev;
	const struct pinctrl_ops *pctlops = pctldev->desc->pctlops;
	const struct pinmux_ops *ops = pctldev->desc->pmxops;
	// ...

	/* Try to allocate all pins in this group, one by one */
	for (i = 0; i < num_pins; i++) {
		ret = pin_request(pctldev, pins[i], setting->dev_name, NULL);
		// ...
	}

	/* Now that we have acquired the pins, encode the mux setting */
	for (i = 0; i < num_pins; i++) {
		desc = pin_desc_get(pctldev, pins[i]);
		// ...
		desc->mux_setting = &(setting->data.mux);
	}

	ret = ops->set_mux(pctldev, setting->data.mux.func,
			   setting->data.mux.group);
	// ...
}
```

Sunxi 的 `set_mux` 实现：

```333:352:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/pinctrl/sunxi/pinctrl-sunxi.c
static int sunxi_pmx_set_mux(struct pinctrl_dev *pctldev,
			     unsigned function,
			     unsigned group)
{
	struct sunxi_pinctrl *pctl = pinctrl_dev_get_drvdata(pctldev);
	struct sunxi_pinctrl_group *g = pctl->groups + group;
	struct sunxi_pinctrl_function *func = pctl->functions + function;
	struct sunxi_desc_function *desc =
		sunxi_pinctrl_desc_find_function_by_name(pctl,
							 g->name,
							 func->name);

	if (!desc)
		return -EINVAL;

	sunxi_pmx_set(pctldev, g->pin, desc->muxval);

	return 0;
}
```

核心寄存器操作函数 `sunxi_pmx_set()`：

```315:331:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/pinctrl/sunxi/pinctrl-sunxi.c
static void sunxi_pmx_set(struct pinctrl_dev *pctldev,
				 unsigned pin,
				 u8 config)
{
	struct sunxi_pinctrl *pctl = pinctrl_dev_get_drvdata(pctldev);
	unsigned long flags;
	u32 val, mask;

	spin_lock_irqsave(&pctl->lock, flags);

	pin -= pctl->desc->pin_base;
	val = readl(pctl->membase + sunxi_mux_reg(pin));
	mask = MUX_PINS_MASK << sunxi_mux_offset(pin);
	writel((val & ~mask) | config << sunxi_mux_offset(pin),
		pctl->membase + sunxi_mux_reg(pin));

	spin_unlock_irqrestore(&pctl->lock, flags);
}
```

**寄存器计算（在 pinctrl-sunxi.h 中）：**

```169:178:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/pinctrl/sunxi/pinctrl-sunxi.h
static inline u32 sunxi_mux_reg(u16 pin)
{
	u8 bank = pin / PINS_PER_BANK;
	u32 offset = bank * BANK_MEM_SIZE;
	offset += MUX_REGS_OFFSET;
	offset += pin % PINS_PER_BANK / MUX_PINS_PER_REG * 0x04;
	return round_down(offset, 4);
}
```

**5.2 配置 Pin 电气特性 - `sunxi_pconf_group_set()`**

```268:313:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/pinctrl/sunxi/pinctrl-sunxi.c
static int sunxi_pconf_group_set(struct pinctrl_dev *pctldev,
				 unsigned group,
				 unsigned long *configs,
				 unsigned num_configs)
{
	struct sunxi_pinctrl *pctl = pinctrl_dev_get_drvdata(pctldev);
	struct sunxi_pinctrl_group *g = &pctl->groups[group];
	unsigned long flags;
	unsigned pin = g->pin - pctl->desc->pin_base;
	u32 val, mask;
	u16 strength;
	u8 dlevel;
	int i;

	spin_lock_irqsave(&pctl->lock, flags);

	for (i = 0; i < num_configs; i++) {
		switch (pinconf_to_config_param(configs[i])) {
		case PIN_CONFIG_DRIVE_STRENGTH:
			strength = pinconf_to_config_argument(configs[i]);
			// ... 驱动强度转换
			dlevel = strength / 10 - 1;
			val = readl(pctl->membase + sunxi_dlevel_reg(pin));
			mask = DLEVEL_PINS_MASK << sunxi_dlevel_offset(pin);
			writel((val & ~mask)
				| dlevel << sunxi_dlevel_offset(pin),
				pctl->membase + sunxi_dlevel_reg(pin));
			break;
		case PIN_CONFIG_BIAS_PULL_UP:
			val = readl(pctl->membase + sunxi_pull_reg(pin));
			mask = PULL_PINS_MASK << sunxi_pull_offset(pin);
			writel((val & ~mask) | 1 << sunxi_pull_offset(pin),
				pctl->membase + sunxi_pull_reg(pin));
			break;
		case PIN_CONFIG_BIAS_PULL_DOWN:
			val = readl(pctl->membase + sunxi_pull_reg(pin));
			mask = PULL_PINS_MASK << sunxi_pull_offset(pin);
			writel((val & ~mask) | 2 << sunxi_pull_offset(pin),
				pctl->membase + sunxi_pull_reg(pin));
			break;
		}
		g->config = configs[i];
	}

	spin_unlock_irqrestore(&pctl->lock, flags);

	return 0;
}
```

---

### 完整调用链总结

```
设备 probe
  └─> pinctrl_bind_pins() [drivers/base/pinctrl.c]
       ├─> 分配 dev->pins (dev_pin_info 结构体)
       ├─> devm_pinctrl_get()
       │    └─> create_pinctrl()
       │         └─> pinctrl_dt_to_map() [drivers/pinctrl/devicetree.c]
       │              ├─> 解析 pinctrl-0, pinctrl-1...
       │              ├─> 解析 pinctrl-names
       │              └─> dt_to_map_one_config()
       │                   └─> ops->dt_node_to_map()
       │                        └─> sunxi_pctrl_dt_node_to_map() [sunxi 驱动]
       │                             ├─> 解析 allwinner,pins
       │                             ├─> 解析 allwinner,function
       │                             ├─> 解析 allwinner,drive
       │                             ├─> 解析 allwinner,pull
       │                             └─> 创建 pinctrl_map 数组
       │
       ├─> pinctrl_lookup_state(p, "default")
       │    └─> 查找 dev->pins->default_state
       │
       └─> pinctrl_select_state(p, default_state)
            └─> 遍历 state->settings
                 ├─> pinmux_enable_setting()
                 │    └─> ops->set_mux()
                 │         └─> sunxi_pmx_set_mux()
                 │              └─> sunxi_pmx_set()
                 │                   └─> 写 MUX 寄存器
                 │
                 └─> pinconf_apply_setting()
                      └─> ops->pin_config_group_set()
                           └─> sunxi_pconf_group_set()
                                ├─> 写 DLEVEL 寄存器（驱动强度）
                                └─> 写 PULL 寄存器（上下拉）
```

