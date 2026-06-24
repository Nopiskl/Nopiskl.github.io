# V853 Tina Linux 4.9 VIN 驱动说明文档：`sensor0_isp_used` 与 `vinc0_isp_sel = 4(bypass)` 的区别，以及输出是 YUV 还是 Bayer RAW

## 1. 文档目的

本文档用于说明 V853 平台 Tina Linux 4.9 中 `sunxi-vin` 驱动框架里两个常见配置项的真实含义与差异：

- `sensor0_isp_used`
- `vinc0_isp_sel`

重点回答以下问题：

1. `sensor0_isp_used` 到底控制什么。
2. 在已知 `isp10` 为 bypass 节点、`vinc0_isp_sel = <4>` 即选中 bypass 的前提下，为什么：
   - `vinc0_isp_sel = 4` 也表现为“不做普通 ISP 处理”
   - `sensor0_isp_used = 0` 也表现为“不做普通 ISP 处理”
   - 但两者本质上并不相同。
3. 在当前 `100ask + gc2053_mipi` 这类 RAW sensor 场景下，这两种配置最终更应理解为输出 YUV，还是 Bayer RAW。

本文尽量以**源码路径、字段流向、调用链行为**为主线组织内容，避免问答式表述。

---

## 2. 适用前提与范围

### 2.1 平台与代码范围

- 平台：Allwinner V853
- SDK / 内核：Tina Linux 4.9
- 分析目录：`lichee/linux-4.9/drivers/media/platform/sunxi-vin`

### 2.2 本文使用的已知前提

本文在以下前提下分析：

> **设备树中的 `isp10` 是 bypass 节点，`vinc0_isp_sel = <4>` 即表示 `vinc0` 选择 bypass 节点。**

这个前提是用户已明确给出的系统约束。本文先在此约束下分析驱动行为，并在后文补充源码旁证，说明这一前提与 dtsi / 驱动实现是吻合的。

---

## 3. 结论摘要

先给出最终结论，后文再展开源码依据。

### 3.1 结论 1：`sensor0_isp_used` 控制的是 ISP 的运行模式，不是 VIN 的路由目标

`sensor0_isp_used` 在设备树解析后进入 `sensor_instance.is_isp_used`，起流时进一步传递给 ISP 子设备内部的 `isp->use_isp`。

因此它控制的是：

> **当前选中的 ISP 节点，是否按“真正启用 ISP”的方式工作。**

它不是用来决定 `vinc0` 接哪个 ISP 节点的。

---

### 3.2 结论 2：`vinc0_isp_sel = 4` 控制的是 `vinc0` 选择哪个 ISP 节点

`vinc0_isp_sel` 最终进入 `vinc->isp_sel`，驱动据此决定：

- `vinc0` 绑定哪个 ISP subdev
- 默认 graph 中启用哪条与 ISP 相关的链路

在本文前提下：

> `vinc0_isp_sel = 4` 表示 `vinc0` 绑定到 `isp10(bypass)` 节点。

因此它改的是：

> **链路拓扑 / 路由目标**

---

### 3.3 结论 3：两者都可能表现为“不处理数据”，但“不处理”的层级不同

- `vinc0_isp_sel = 4`：**改路由，进入 bypass 节点**
- `sensor0_isp_used = 0`：**不改路由，只让当前 ISP 节点内部不真正执行 ISP 行为**

也就是说：

- 一个是**换路**
- 一个是**同一路上不让 ISP 干活**

---

### 3.4 结论 4：对当前 RAW Sensor 而言，两者都更应按 Bayer RAW 理解，而不是按 YUV 理解

在 `100ask` 默认板级配置中，`sensor0` 使用的是 `gc2053_mipi`，并且 `sensor0_fmt = <1>`，即 RAW Bayer 传感器输入。

因此只要**普通 ISP 没有真正工作**，这条链路上就没有模块负责把 Bayer RAW 做成常规 YUV。  
在这个前提下：

- `vinc0_isp_sel = 4`：由于走的是 bypass/empty ISP 节点，数据语义上应按 **Bayer RAW** 理解
- `sensor0_isp_used = 0`：由于当前 ISP 节点被切到 no-op / non-ISP 模式，数据语义上也更应按 **Bayer RAW** 理解

但需要注意：

> **“数据语义都更像 RAW”不等于“对用户态表现完全一样”。**

`sensor0_isp_used` 还会额外影响 `support_raw`、部分 `try_fmt` 路径、`s_parm` 下发以及 control 行为，因此两者在驱动软件语义层面仍然不完全等价。

---

## 4. `sensor0_isp_used` 的源码路径与语义

本节从字段来源、运行时传播、最终效果三个层面说明 `sensor0_isp_used`。

---

### 4.1 设备树解析：`sensor0_isp_used -> inst->is_isp_used`

在 `utility/config.c` 中，驱动通过 `get_isp_used()` 读取设备树属性并写入 `sc->inst[0].is_isp_used`：

```419:427:lichee/linux-4.9/drivers/media/platform/sunxi-vin/utility/config.c
static int get_isp_used(struct device_node *np, const char *name,
			struct sensor_list *sc)
{
	return get_value_int(np, name, &sc->inst[0].is_isp_used);
}
static int get_fmt(struct device_node *np, const char *name,
		   struct sensor_list *sc)
{
	return get_value_int(np, name, &sc->inst[0].is_bayer_raw);
}
```

`fetch_camera[]` 中也明确注册了这个字段：

```588:596:lichee/linux-4.9/drivers/media/platform/sunxi-vin/utility/config.c
static struct FetchFunArr fetch_camera[] = {
	{"mname", 0, get_mname,},
	{"twi_addr", 0, get_twi_addr,},
	{"twi_cci_spi", 1, get_twi_cci_spi,},
	{"twi_cci_id", 1, get_twi_id,},
	{"mclk_id", 1, get_mclk_id,},
	{"pos", 1, get_pos,},
	{"isp_used", 1, get_isp_used,},
	{"fmt", 1, get_fmt,},
	{"vflip", 1, get_vflip,},
```

设备树节点遍历时按 `sensorX_xxx` 形式逐个解析：

```792:795:lichee/linux-4.9/drivers/media/platform/sunxi-vin/utility/config.c
			sprintf(property, "%s_%s",
				cam->type, fetch_camera[j].sub);
			fetch_camera[j].fun(cam,
				property, sensors);
```

因此在常规 DTS 直配路径下：

- `sensor0_isp_used = <0>` → `inst->is_isp_used = 0`
- `sensor0_isp_used = <1>` → `inst->is_isp_used = 1`

这说明：

## `sensor0_isp_used` 是有效配置项，且它的直接目标字段就是 `is_isp_used`

---

### 4.2 `cam_type` 为什么不是当前 DTS 场景的主导因素

`vin.c` 中存在一个根据 `cam_type` 推导 `is_isp_used` 的函数：

```1223:1235:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
static int __vin_handle_sensor_info(unsigned int i, struct sensor_instance *inst)
{
#ifndef CONFIG_VIN_INIT_MELIS
	if (inst->cam_type == SENSOR_RAW) {
		inst->is_bayer_raw = 1;
		inst->is_isp_used = 1;
	} else if (inst->cam_type == SENSOR_YUV) {
		inst->is_bayer_raw = 0;
		inst->is_isp_used = 0;
	} else {
		inst->is_bayer_raw = 0;
		inst->is_isp_used = 0;
	}
```

但这个函数只在 `use_sensor_list == 1` 时才会调用：

```1423:1427:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		sensors->valid_idx = NO_VALID_SENSOR;
		for (j = 0; j < sensors->detect_num; j++) {
			if (sensors->use_sensor_list == 1)
				__vin_handle_sensor_info(i, &sensors->inst[j]);
```

因此在常见的 DTS 直配路径中：

- `sensor0_isp_used` 直接决定 `inst->is_isp_used`
- `cam_type` 不构成主导覆盖逻辑

这也是为什么原始讨论里“`sensor0_isp_used` 是有效的”这一点是正确的。

---

### 4.3 运行时传播：`inst->is_isp_used -> isp->use_isp`

在 `vin-video/vin_video.c` 的 `__vin_s_input()` 中，驱动在 pipeline open 后，将 `inst->is_isp_used` 传递给 ISP 子设备：

```2553:2555:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
	inst = &module->sensors.inst[valid_idx];
	sunxi_isp_sensor_type(cap->pipe.sd[VIN_IND_ISP], inst->is_isp_used);
	vinc->support_raw = inst->is_isp_used;
```

对应的 ISP 侧实现是：

```3211:3218:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
void sunxi_isp_sensor_type(struct v4l2_subdev *sd, int use_isp)
{
	struct isp_dev *isp = v4l2_get_subdevdata(sd);

	isp->use_isp = use_isp;
	if (isp->is_empty)
		isp->use_isp = 0;
}
```

因此 `sensor0_isp_used` 在运行时的真正落点是：

> **ISP 子设备内部的 `isp->use_isp`**

---

### 4.4 最终效果：控制 ISP 子设备是否真正执行其内部逻辑

`sunxi_isp.c` 中大量 ISP 核心动作都先检查 `isp->use_isp`。

例如 `s_stream`：

```649:655:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
	if (!isp->use_isp)
		return 0;
```

例如 `init`：

```1054:1059:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
{
	struct isp_dev *isp = v4l2_get_subdevdata(sd);
	struct vin_md *vind = dev_get_drvdata(isp->subdev.v4l2_dev->dev);

	if (!isp->use_isp)
		return 0;
```

这说明当 `sensor0_isp_used = 0` 时：

- ISP 节点仍然存在于当前 pipeline 中
- 驱动仍然会进入 ISP 子设备相关调用链
- 但 ISP 子设备内部大量动作直接 return，不做真正 ISP 处理

因此：

## `sensor0_isp_used = 0` 的真实含义是“当前 ISP 节点进入 non-ISP / no-op 模式”，而不是“切换到 bypass 路由”。

---

### 4.5 对上层行为的附加影响

`is_isp_used` 不只影响 ISP 内部，也会影响上层是否继续给 ISP 下发参数。

例如 `s_parm`：

```2693:2698:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
	if (inst->is_isp_used) {
		ret = v4l2_subdev_call(cap->pipe.sd[VIN_IND_ISP], video, s_parm,
					parms);
		if (ret < 0)
			vin_warn("v4l2 subdev isp s_parm error!\n");
	}
```

所以 `sensor0_isp_used` 会影响：

- ISP 参数是否继续下发
- 部分 control / RAW 流程是否按 ISP 模式处理
- 上层对该流的语义理解（例如 `support_raw`）

例如 `support_raw` 就在 `__vin_s_input()` 中直接由 `inst->is_isp_used` 决定：

```2553:2555:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
	inst = &module->sensors.inst[valid_idx];
	sunxi_isp_sensor_type(cap->pipe.sd[VIN_IND_ISP], inst->is_isp_used);
	vinc->support_raw = inst->is_isp_used;
```

而 `try_fmt` 路径也会参考这个标志：

```1077:1080:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
	mask = (*fmt_id)->flags;
	if ((mask & VIN_FMT_YUV) && (vinc->support_raw == 0))
		mask = VIN_FMT_YUV;
```

这说明 `sensor0_isp_used` 不只是“ISP 内部开不开工”的问题，它还会改变一部分格式协商与上层软件语义。  
相对地，`vinc0_isp_sel = 4` 主要改变的是**链路拓扑**，不会自动同步改变这些上层标志位。

这进一步说明它是一个：

> **运行模式标志**

而不是：

> **ISP 节点选择器**

---

## 5. `vinc0_isp_sel = 4` 的源码路径与语义

本节说明 `vinc0_isp_sel` 为什么属于路由层参数。

---

### 5.1 `vinc->isp_sel` 决定绑定哪个 ISP subdev

在 `vin.c` 的 media graph 构建过程中，驱动直接依据 `vinc->isp_sel` 选择 ISP subdev：

```1684:1688:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		/*isp*/
		if (vinc->isp_sel == 0xff)
			isp = NULL;
		else
			isp = vind->isp[vinc->isp_sel].sd;
```

默认 link 选择阶段同样依据它：

```1827:1831:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		/*ISP*/
		if (vinc->isp_sel == 0xff)
			isp = NULL;
		else
			isp = vind->isp[vinc->isp_sel].sd;
```

因此 `vinc0_isp_sel` 决定的是：

- `vinc0` 最终绑定哪个 ISP 节点
- 默认 pipeline 中启用哪一个 ISP 相关链路

这显然属于：

> **链路选择 / 节点绑定 / 图拓扑层面的控制**

---

### 5.2 在当前已知前提下，`vinc0_isp_sel = 4` 的含义

用户已经明确给出前提：

> `isp10` 为 bypass 节点，`vinc0_isp_sel = <4>` 即选择 bypass 节点

因此在本文约束下：

- `vinc0_isp_sel = 0`：普通 ISP 节点
- `vinc0_isp_sel = 4`：`isp10(bypass)` 节点

这意味着：

## `vinc0_isp_sel = 4` 的本质是“把 `vinc0` 的目标 ISP 节点切换成 bypass 节点”

这里发生的是：

- 路由对象改变
- pipeline 中的目标节点改变
- 后续对 `VIN_IND_ISP` 的调用虽然仍存在，但节点身份已不同

---

### 5.3 源码旁证：`vinc0_isp_sel = 4` 对应的 `isp10` 确实符合 bypass / empty 节点特征

虽然本文一开始把“`isp10` 是 bypass 节点”当作已知前提，但从源码和 dtsi 也能看到这个前提与实际实现是吻合的。

在 `sun8iw21p1.dtsi` 中，`isp10` 对应的就是 `device_id = <4>`：

```1441:1444:lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi
			isp10:isp@4 {
				compatible = "allwinner,sunxi-isp";
				device_id = <4>;
```

与 `isp00` 相比，`isp10` 没有普通 ISP 节点那样的 `reg`、`interrupts`、`work_mode` 等资源描述；而普通 `isp00` 明确带有这些资源：

```1405:1410:lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi
			isp00:isp@0 {
				compatible = "allwinner,sunxi-isp";
				reg = <0x0 0x05900000 0x0 0x1300>,
					<0x0 0x03000000 0x0 0x10>;
				interrupts = <GIC_SPI 108 IRQ_TYPE_LEVEL_HIGH>;
				work_mode = <0>;
```

驱动 probe 时，如果 ISP 节点取不到寄存器基址，就会把该 ISP 记为 `is_empty = 1`：

```3091:3095:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
	isp->base = of_iomap(np, 0);
	if (!isp->base) {
		isp->is_empty = 1;
	} else {
```

而后续在 `sunxi_isp_sensor_type()` 中，空 ISP 会被强制置为 `use_isp = 0`：

```3211:3217:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
void sunxi_isp_sensor_type(struct v4l2_subdev *sd, int use_isp)
{
	struct isp_dev *isp = v4l2_get_subdevdata(sd);

	isp->use_isp = use_isp;
	if (isp->is_empty)
		isp->use_isp = 0;
}
```

因此从源码角度可以把它总结为：

- `vinc0_isp_sel = 4` 绑定到 `device_id = 4`，也就是 `isp10`
- `isp10` 在 dtsi 中没有普通 ISP 所需的硬件资源
- 驱动会把这类节点识别为 `is_empty`
- `is_empty` ISP 在运行时会被强制视作 **non-ISP / bypass-like** 节点

这也正好解释了为什么它在行为上表现为 bypass。

---

## 6. 两者为什么都像“不处理数据”，但本质完全不同

这是整个问题里最容易混淆、也最重要的部分。

---

### 6.1 `vinc0_isp_sel = 4`：不处理，是因为“走 bypass 路”

在本文前提下，`vinc0_isp_sel = 4` 等于选择 `isp10(bypass)`。

因此其“不处理普通 ISP 数据”的含义是：

> **数据流已经改走 bypass 节点，不再走普通 ISP 节点所代表的常规处理路径。**

换句话说，这是：

- 路由级变化
- 节点级变化
- 拓扑级 bypass

---

### 6.2 `sensor0_isp_used = 0`：不处理，是因为“仍在当前 ISP 节点上，但它不干活”

当 `vinc0_isp_sel` 仍然选普通 ISP 节点时，`sensor0_isp_used = 0` 并不会改掉：

- 当前 `VIN_IND_ISP` 是哪个节点
- pipeline 图上是否还挂着 ISP
- `vinc0` 到底绑定的是普通 ISP 还是 bypass ISP

它做的是：

- 让 `isp->use_isp = 0`
- 使 ISP 内部很多动作直接 return
- 上层很多参数也不再继续往 ISP 路径下发

因此其“不处理普通 ISP 数据”的含义是：

> **数据仍然经过当前 ISP 节点，但该节点被软件切成 no-op / non-ISP 模式。**

这不是路由 bypass，而是：

- 行为级禁用
- 运行模式级禁用
- 软件语义上的“不要当真 ISP 用”

---

### 6.3 最精炼的区分方式

可以用下面两句话区分：

#### `vinc0_isp_sel = 4`
> 选择 bypass 节点，改的是“数据走哪条路”

#### `sensor0_isp_used = 0`
> 不改路，只改“当前路上的 ISP 节点是否真正启用 ISP 行为”

如果用更直观的类比：

- `vinc0_isp_sel = 4`：**改走旁路车道**
- `sensor0_isp_used = 0`：**还在原车道，但把收费站/检查站关闭**

因此两者都可能表现为“没有普通 ISP 图像处理”，但底层原因完全不同。

---

## 7. 典型组合解释

下面给出四种最典型的组合，帮助理解这两个参数是如何协同影响系统行为的。

### 7.1 组合 A：`vinc0_isp_sel = 0` + `sensor0_isp_used = 1`

- 路由：普通 ISP 节点
- 运行模式：真正启用 ISP
- 含义：标准 RAW → ISP 处理链

这是最典型的普通 ISP 工作模式。

---

### 7.2 组合 B：`vinc0_isp_sel = 0` + `sensor0_isp_used = 0`

- 路由：普通 ISP 节点
- 运行模式：ISP 子设备内部大部分逻辑不执行
- 含义：**不是 bypass**，而是普通 ISP 节点上的“软禁用”

这种情况下，媒体图与节点绑定没有变，只是该节点内部不真正做 ISP 工作。

---

### 7.3 组合 C：`vinc0_isp_sel = 4` + `sensor0_isp_used = 1`

- 路由：bypass 节点
- 运行模式：软件仍按“启用 ISP”语义对待该流
- 含义：路由与软件语义不一致，容易导致理解或调试混淆

这类配置可能“能跑”，但逻辑上不够一致。

---

### 7.4 组合 D：`vinc0_isp_sel = 4` + `sensor0_isp_used = 0`

- 路由：bypass 节点
- 运行模式：软件也按 non-ISP 模式处理
- 含义：**最一致的 bypass 语义组合**

这通常是“硬件/节点级 bypass”与“软件行为级 non-ISP”同时一致的最清晰配置。

---

## 8. 推荐理解方式

综合源码与行为，可以用以下分层方式理解：

### 第 1 层：路由层
由 `vinc0_isp_sel` 决定。

问题是：

> **`vinc0` 接哪个 ISP 节点？**

在当前前提下，`4` 的答案是：

> **接 `isp10(bypass)`**

---

### 第 2 层：行为层
由 `sensor0_isp_used` 决定。

问题是：

> **当前被选中的 ISP 节点，要不要按“真正 ISP”方式工作？**

答案是：

- `1`：要
- `0`：不要

---

## 9. 实际配置建议

如果目标是：

> **明确走 bypass 节点，同时软件层也不要再按真 ISP 的语义驱动这路流**

则推荐配置为：

- `vinc0_isp_sel = 4`
- `sensor0_isp_used = 0`

原因是：

- `vinc0_isp_sel = 4`：保证链路层进入 `isp10(bypass)`
- `sensor0_isp_used = 0`：保证 ISP 子设备内部和上层行为都按 non-ISP 模式处理

也就是说：

- **主决定因素**：`vinc0_isp_sel = 4`
- **配套语义因素**：`sensor0_isp_used = 0`

---

## 10. 当前板级配置下：输出是 YUV 还是 Bayer RAW？

这一节专门回答“当前源码与板级配置下，`vinc0_isp_sel = 4` 和 `sensor0_isp_used = 0` 到底输出什么”。

---

### 10.1 先看 `sensor0` 本身是不是 RAW sensor

`100ask` 板级配置里，`sensor0` 使用的是 `gc2053_mipi`，并且 `sensor0_fmt = <1>`：

```184:192:device/config/chips/v853/configs/100ask/board.dts
			sensor0:sensor@0 {
				device_type = "sensor0";
				sensor0_mname = "gc2053_mipi";
				...
				sensor0_isp_used = <1>;
				sensor0_fmt = <1>;
```

而 `config.c` 中，`sensorX_fmt` 正是写入 `inst->is_bayer_raw` 的来源：

```423:427:lichee/linux-4.9/drivers/media/platform/sunxi-vin/utility/config.c
static int get_fmt(struct device_node *np, const char *name,
		   struct sensor_list *sc)
{
	return get_value_int(np, name, &sc->inst[0].is_bayer_raw);
}
```

`gc2053_mipi.c` 本身也明确表明这是一颗 RAW camera：

```1:10:lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/gc2053_mipi.c
/*
 * A V4L2 driver for Raw cameras.
 */
```

并且它导出的 sensor format 只有 RAW Bayer：

```2022:2032:lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor/gc2053_mipi.c
static struct sensor_format_struct sensor_formats[] = {
	{
		.desc      = "Raw RGB Bayer",
#if RAW10
		.mbus_code = MEDIA_BUS_FMT_SRGGB10_1X10,
#else
		.mbus_code = MEDIA_BUS_FMT_SRGGB8_1X8,
#endif
```

因此这一路 sensor 的**源数据语义**很明确：

> **它本来就是 Bayer RAW，不是原生 YUV sensor。**

---

### 10.2 只要普通 ISP 没真正工作，就不应期待得到常规 YUV

对 RAW sensor 来说，YUV 不是“天然输出”，而是 RAW 在 ISP 中经过去马赛克、颜色校正、色彩空间变换等处理后的结果。

所以一旦出现以下任一情况：

- `vinc0_isp_sel = 4`，链路进入 `isp10(bypass)` / empty ISP
- `sensor0_isp_used = 0`，当前 ISP 节点被切到 non-ISP / no-op 模式

都意味着：

> **这条链路上没有“真正工作的普通 ISP”来把 Bayer RAW 转成常规 YUV。**

在这种前提下，就不应把结果理解成标准 ISP 处理后的 YUV，而应理解成：

> **更接近 Bayer RAW（也就是常说的 RAWA / RAW Bayer）**

---

### 10.3 为什么说“两者在数据语义上都更像 RAW”，但仍不能简单说“完全一样”

从**数据路径语义**看：

- `vinc0_isp_sel = 4`：是 bypass，RAW sensor 数据没有进入普通 ISP 处理链
- `sensor0_isp_used = 0`：虽然还挂在原 ISP 节点上，但该节点也没有真正执行普通 ISP 处理

所以在当前 `gc2053_mipi` RAW sensor 场景下，两者都更应按 **Bayer RAW** 理解，而不是按 YUV 理解。

但从**驱动软件行为**看，它们仍然不完全等价：

- `vinc0_isp_sel = 4`：主改链路
- `sensor0_isp_used = 0`：还会额外影响 `support_raw`、`s_parm`、control 分支、部分 `try_fmt` 语义

因此更准确的表述应该是：

> **两者在当前 RAW sensor 场景下，最终“数据语义”都更像 Bayer RAW；但在驱动内部的软件标志和用户态观测行为上，并不保证完全一致。**

---

## 11. 总结

本文可以收敛为以下五条结论：

1. `sensor0_isp_used` 设置的是**当前 ISP 节点的运行模式**，不是**VIN 路由选择哪个 ISP 节点**。
2. `vinc0_isp_sel = 4`（在本文已知前提下）设置的是**把 `vinc0` 路由到 `isp10 bypass` 节点**。
3. 两者都可能表现为“没有普通 ISP 图像处理”，但本质上：
   - 一个是**改路**
   - 一个是**同一路上不让 ISP 干活**
4. 在当前 `100ask + gc2053_mipi` 这类 RAW sensor 场景下，只要普通 ISP 没有真正工作，结果就更应按 **Bayer RAW** 理解，而不是按常规 YUV 理解。
5. 即便最终数据语义都更像 RAW，`sensor0_isp_used = 0` 仍会比 `vinc0_isp_sel = 4` 额外改变更多驱动软件语义，因此二者不能简单视为“完全等价配置”。
