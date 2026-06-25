# Sunxi-gpio integration in fbtft-core
_Exported on 2026/3/31 at GMT+8 17:25:39 from Cursor (2.6.21)_

---

**User**

@fbtft-core.c 帮我分析一下为什么sunxi平台需要做出如下改动From c1a9cd465b8554ea70f1fdaaccd4dcbe24e789c3 Mon Sep 17 00:00:00 2001
From: CLD <cld.username@gmail.com>
Date: Fri, 19 Jul 2024 12:03:54 +0000
Subject: [PATCH] Make fbtft-core use sunxi-gpio

Change-Id: I03db3e1e509dc17b3d92f7100b5c86ca17a06854
---
 drivers/staging/fbtft/fbtft-core.c | 26 ++++++++++++++------------
 1 file changed, 14 insertions(+), 12 deletions(-)

diff --git a/drivers/staging/fbtft/fbtft-core.c b/drivers/staging/fbtft/fbtft-core.c
index 587f68aa..4b1e2d6f 100644
--- a/drivers/staging/fbtft/fbtft-core.c
+++ b/drivers/staging/fbtft/fbtft-core.c
@@ -40,6 +40,8 @@
 #include "fbtft.h"
 #include "internal.h"
 
+#include <linux/sunxi-gpio.h>
+
 static unsigned long debug;
 module_param(debug, ulong, 0);
 MODULE_PARM_DESC(debug, "override device debug level");
@@ -164,10 +166,10 @@ static int fbtft_request_one_gpio(struct fbtft_par *par,
 	struct device *dev = par->info->device;
 	struct device_node *node = dev->of_node;
 	int gpio, flags, ret = 0;
-	enum of_gpio_flags of_flags;
+	struct gpio_config gpio_of_flags;
 
 	if (of_find_property(node, name, NULL)) {
-		gpio = of_get_named_gpio_flags(node, name, index, &of_flags);
+		gpio = of_get_named_gpio_flags(node, name, index, (enum of_gpio_flags *)&gpio_of_flags);
 		if (gpio == -ENOENT)
 			return 0;
 		if (gpio == -EPROBE_DEFER)
@@ -179,7 +181,7 @@ static int fbtft_request_one_gpio(struct fbtft_par *par,
 		}
 
 		/* active low translates to initially low */
-		flags = (of_flags & OF_GPIO_ACTIVE_LOW) ? GPIOF_OUT_INIT_LOW :
+		flags = (gpio_of_flags.data & OF_GPIO_ACTIVE_LOW) ? GPIOF_OUT_INIT_LOW :
 							GPIOF_OUT_INIT_HIGH;
 		ret = devm_gpio_request_one(dev, gpio, flags,
 						dev->driver->name);
@@ -206,34 +208,34 @@ static int fbtft_request_gpios_dt(struct fbtft_par *par)
 	if (!par->info->device->of_node)
 		return -EINVAL;
 
-	ret = fbtft_request_one_gpio(par, "reset-gpios", 0, &par->gpio.reset);
+	ret = fbtft_request_one_gpio(par, "reset", 0, &par->gpio.reset);
 	if (ret)
 		return ret;
-	ret = fbtft_request_one_gpio(par, "dc-gpios", 0, &par->gpio.dc);
+	ret = fbtft_request_one_gpio(par, "dc", 0, &par->gpio.dc);
 	if (ret)
 		return ret;
-	ret = fbtft_request_one_gpio(par, "rd-gpios", 0, &par->gpio.rd);
+	ret = fbtft_request_one_gpio(par, "rd", 0, &par->gpio.rd);
 	if (ret)
 		return ret;
-	ret = fbtft_request_one_gpio(par, "wr-gpios", 0, &par->gpio.wr);
+	ret = fbtft_request_one_gpio(par, "wr", 0, &par->gpio.wr);
 	if (ret)
 		return ret;
-	ret = fbtft_request_one_gpio(par, "cs-gpios", 0, &par->gpio.cs);
+	ret = fbtft_request_one_gpio(par, "cs", 0, &par->gpio.cs);
 	if (ret)
 		return ret;
-	ret = fbtft_request_one_gpio(par, "latch-gpios", 0, &par->gpio.latch);
+	ret = fbtft_request_one_gpio(par, "latch", 0, &par->gpio.latch);
 	if (ret)
 		return ret;
 	for (i = 0; i < 16; i++) {
-		ret = fbtft_request_one_gpio(par, "db-gpios", i,
+		ret = fbtft_request_one_gpio(par, "db", i,
 						&par->gpio.db[i]);
 		if (ret)
 			return ret;
-		ret = fbtft_request_one_gpio(par, "led-gpios", i,
+		ret = fbtft_request_one_gpio(par, "led", i,
 						&par->gpio.led[i]);
 		if (ret)
 			return ret;
-		ret = fbtft_request_one_gpio(par, "aux-gpios", i,
+		ret = fbtft_request_one_gpio(par, "aux", i,
 						&par->gpio.aux[i]);
 		if (ret)
 			return ret;
-- 
2.25.1

---

**Cursor**

我来分析一下这个针对 sunxi 平台的 fbtft-core.c 修改。首先让我查看一下当前的文件内容。

现在让我搜索一下 sunxi-gpio.h 头文件，以了解 `struct gpio_config` 的定义：

现在让我查看一下标准的 `of_gpio_flags` 定义，以便更好地理解这个改动：

现在让我查看一下 sunxi 平台的 GPIO 驱动实现，以了解为什么需要这些改动：

让我直接查看 pinctrl-sunxi.c 文件的关键部分：

让我查看 pinctrl-sunxi.c 文件的内容：

让我搜索 sunxi 平台如何处理 GPIO 配置的关键函数：

让我搜索 xlate 函数，这是 GPIO 标志转换的关键：

让我直接搜索文件中关于 gpio_config 的使用：

让我查看 pinctrl-sunxi.h 头文件：

现在让我搜索 sunxi 平台如何扩展 of_get_named_gpio_flags 函数：

让我搜索 sunxi GPIO 驱动中对 of_get_named_gpio_flags 的实现或重载：

让我查看 of_gpio.c 的实现：

让我搜索 gpiolib-of.c：

让我直接读取 gpiolib-of.c 文件的关键部分：

太好了！现在我找到了关键信息。让我继续查看这个文件的更多内容：

完美！现在让我查看 sunxi pinctrl 驱动中的 xlate 函数实现：

让我搜索 sunxi_pinctrl_gpio_of_xlate：

让我搜索 gpio_chip 结构的初始化部分：

让我搜索 gpio_chip 的定义：

让我直接搜索文件中包含 xlate 的所有行：

让我使用 shell 命令来搜索：

太好了！现在让我查看 sunxi_pinctrl_gpio_of_xlate 函数：

完美！现在我已经掌握了所有关键信息。让我创建一个详细的分析文档：

根据我对代码的深入分析，我现在可以为您详细解释为什么 sunxi 平台需要做出这些改动：

## 分析总结

这个补丁的核心原因是：**sunxi 平台扩展了标准的 GPIO 设备树绑定，使用 `struct gpio_config` 结构来传递更丰富的 GPIO 配置信息，而不仅仅是标准的 `enum of_gpio_flags`。**

### 关键改动点分析：

#### 1. **数据结构变更**（第 167-179 行）

**原代码：**
```c
enum of_gpio_flags of_flags;
gpio = of_get_named_gpio_flags(node, name, index, &of_flags);
flags = (of_flags & OF_GPIO_ACTIVE_LOW) ? GPIOF_OUT_INIT_LOW : GPIOF_OUT_INIT_HIGH;
```

**修改后：**
```c
struct gpio_config gpio_of_flags;
gpio = of_get_named_gpio_flags(node, name, index, (enum of_gpio_flags *)&gpio_of_flags);
flags = (gpio_of_flags.data & OF_GPIO_ACTIVE_LOW) ? GPIOF_OUT_INIT_LOW : GPIOF_OUT_INIT_HIGH;
```

**原因：**

从 `sunxi-gpio.h` 可以看到，`struct gpio_config` 定义为：

```c
struct gpio_config {
    u32 data;        // 数据值：包含 GPIO 标志位
    u32 gpio;        // GPIO 全局索引
    u32 mul_sel;     // 多功能选择：0-输入，1-输出
    u32 pull;        // 上下拉配置
    u32 drv_level;   // 驱动能力等级
};
```

而标准的 `enum of_gpio_flags` 只有：

```c
enum of_gpio_flags {
    OF_GPIO_ACTIVE_LOW = 0x1,
    OF_GPIO_SINGLE_ENDED = 0x2,
};
```

**sunxi 平台的 xlate 函数**（`pinctrl-sunxi.c:1043`）会将设备树中的 6 个参数解析到 `gpio_config` 结构中：

```c
static int sunxi_pinctrl_gpio_of_xlate(struct gpio_chip *gc,
                const struct of_phandle_args *gpiospec,
                u32 *flags)
{
    struct gpio_config *config;
    // ...
    if (flags) {
        config = (struct gpio_config *)flags;
        config->gpio = base + gpiospec->args[1];
        config->mul_sel = gpiospec->args[2];    // 功能选择
        config->pull = gpiospec->args[3];       // 上下拉
        config->drv_level = gpiospec->args[4];  // 驱动能力
        config->data = gpiospec->args[5];       // 数据/标志
    }
    return pin;
}
```

这就是为什么需要使用 `struct gpio_config` 而不是简单的 `enum of_gpio_flags`。

#### 2. **设备树属性名称变更**（第 208-238 行）

**原代码：**
```c
ret = fbtft_request_one_gpio(par, "reset-gpios", 0, &par->gpio.reset);
ret = fbtft_request_one_gpio(par, "dc-gpios", 0, &par->gpio.dc);
// ...
```

**修改后：**
```c
ret = fbtft_request_one_gpio(par, "reset", 0, &par->gpio.reset);
ret = fbtft_request_one_gpio(par, "dc", 0, &par->gpio.dc);
// ...
```

**原因：**

查看 `gpiolib-of.c:140-148` 的代码：

```c
#ifdef CONFIG_ARCH_SUNXI
    struct gpio_config gpio_flags;
#endif

for (i = 0; i < ARRAY_SIZE(gpio_suffixes); i++) {
    if (con_id)
        snprintf(prop_name, sizeof(prop_name), "%s-%s", con_id, gpio_suffixes[i]);
    // ...
#ifdef CONFIG_ARCH_SUNXI
    desc = of_get_named_gpiod_flags(dev->of_node, prop_name, idx,
                    (enum of_gpio_flags *)&gpio_flags);
    of_flags = gpio_flags.data;
#endif
```

在 sunxi 平台上，GPIO 子系统会自动添加 `-gpios` 或 `-gpio` 后缀。`gpio_suffixes` 数组通常包含 `"gpios"` 和 `"gpio"`。

因此：
- 如果设备树中定义为 `reset`，系统会自动查找 `reset-gpios` 或 `reset-gpio`
- 如果代码中使用 `"reset-gpios"`，系统会查找 `reset-gpios-gpios`（错误！）

所以需要去掉 `-gpios` 后缀，让系统自动添加。

### 为什么 sunxi 需要这样做？

1. **更丰富的 GPIO 配置**：sunxi SoC 的 GPIO 控制器支持多种配置（功能复用、上下拉、驱动能力等），这些信息需要在设备树中传递。

2. **设备树兼容性**：sunxi 平台的设备树格式为：
   ```dts
   reset = <&pio 1 2 0 1 0 1>;  // 6个参数：bank, pin, function, pull, drive, data
   ```
   而标准格式只有：
   ```dts
   reset-gpios = <&gpio 10 GPIO_ACTIVE_LOW>;  // 3个参数
   ```

3. **平台特定的 GPIO 子系统**：sunxi 修改了 `gpiolib-of.c`，使其在 `CONFIG_ARCH_SUNXI` 定义时使用 `struct gpio_config` 而不是标准的 `enum of_gpio_flags`。

### 总结

这个补丁是为了让 fbtft 驱动能够正确地在 sunxi 平台上工作，因为：
1. sunxi 使用扩展的 GPIO 配置结构来支持更多硬件特性
2. sunxi 的设备树绑定约定与标准 Linux 不同
3. 需要适配 sunxi 特定的 GPIO 子系统实现

这是一个典型的**平台适配补丁**，用于解决供应商特定实现与上游标准驱动之间的兼容性问题。

```c
enum of_gpio_flags of_flags;
gpio = of_get_named_gpio_flags(node, name, index, &of_flags);
flags = (of_flags & OF_GPIO_ACTIVE_LOW) ? GPIOF_OUT_INIT_LOW : GPIOF_OUT_INIT_HIGH;
```

```c
struct gpio_config gpio_of_flags;
gpio = of_get_named_gpio_flags(node, name, index, (enum of_gpio_flags *)&gpio_of_flags);
flags = (gpio_of_flags.data & OF_GPIO_ACTIVE_LOW) ? GPIOF_OUT_INIT_LOW : GPIOF_OUT_INIT_HIGH;
```

```c
struct gpio_config {
    u32 data;        // 数据值：包含 GPIO 标志位
    u32 gpio;        // GPIO 全局索引
    u32 mul_sel;     // 多功能选择：0-输入，1-输出
    u32 pull;        // 上下拉配置
    u32 drv_level;   // 驱动能力等级
};
```

```c
enum of_gpio_flags {
    OF_GPIO_ACTIVE_LOW = 0x1,
    OF_GPIO_SINGLE_ENDED = 0x2,
};
```

```c
static int sunxi_pinctrl_gpio_of_xlate(struct gpio_chip *gc,
                const struct of_phandle_args *gpiospec,
                u32 *flags)
{
    struct gpio_config *config;
    // ...
    if (flags) {
        config = (struct gpio_config *)flags;
        config->gpio = base + gpiospec->args[1];
        config->mul_sel = gpiospec->args[2];    // 功能选择
        config->pull = gpiospec->args[3];       // 上下拉
        config->drv_level = gpiospec->args[4];  // 驱动能力
        config->data = gpiospec->args[5];       // 数据/标志
    }
    return pin;
}
```

```c
ret = fbtft_request_one_gpio(par, "reset-gpios", 0, &par->gpio.reset);
ret = fbtft_request_one_gpio(par, "dc-gpios", 0, &par->gpio.dc);
// ...
```

```c
ret = fbtft_request_one_gpio(par, "reset", 0, &par->gpio.reset);
ret = fbtft_request_one_gpio(par, "dc", 0, &par->gpio.dc);
// ...
```

```c
#ifdef CONFIG_ARCH_SUNXI
    struct gpio_config gpio_flags;
#endif

for (i = 0; i < ARRAY_SIZE(gpio_suffixes); i++) {
    if (con_id)
        snprintf(prop_name, sizeof(prop_name), "%s-%s", con_id, gpio_suffixes[i]);
    // ...
#ifdef CONFIG_ARCH_SUNXI
    desc = of_get_named_gpiod_flags(dev->of_node, prop_name, idx,
                    (enum of_gpio_flags *)&gpio_flags);
    of_flags = gpio_flags.data;
#endif
```

```dts
   reset = <&pio 1 2 0 1 0 1>;  // 6个参数：bank, pin, function, pull, drive, data
```

```dts
   reset-gpios = <&gpio 10 GPIO_ACTIVE_LOW>;  // 3个参数
```

---

**User**

我是否可以只使用reset-gpios = <&gpio 10 GPIO_ACTIVE_LOW>;类似这样的，再做一些ret = fbtft_request_one_gpio(par, "reset", 0, &par->gpio.reset);

ret = fbtft_request_one_gpio(par, "dc", 0, &par->gpio.dc);

// ...这些修改？

---

**Cursor**

很好的问题！让我分析一下您提出的简化方案是否可行。

完美！现在我找到了关键信息。让我给您一个明确的答案：

## 答案：**理论上可以，但实际上不推荐** ❌

让我详细解释原因：

### 1. **gpio_suffixes 的工作机制**

从 `gpiolib.h:93` 可以看到：

```c
static const char * const gpio_suffixes[] = { "gpios", "gpio" };
```

这意味着当您在代码中使用 `"reset"` 时，系统会自动尝试查找：
- `reset-gpios`
- `reset-gpio`

### 2. **您的简化方案分析**

**设备树：**
```dts
reset-gpios = <&pio 1 10 GPIO_ACTIVE_LOW>;
```

**代码：**
```c
ret = fbtft_request_one_gpio(par, "reset", 0, &par->gpio.reset);
```

**理论上的流程：**
1. 代码传入 `"reset"`
2. `of_find_gpio()` 会拼接后缀，查找 `"reset-gpios"`
3. 找到设备树中的 `reset-gpios` 属性 ✓

### 3. **但是存在的问题** ⚠️

#### 问题 A：`fbtft_request_one_gpio` 直接调用 `of_get_named_gpio_flags`

让我查看一下这个函数的实现：

```c
static const char * const gpio_suffixes[] = { "gpios", "gpio" };
```

```dts
reset-gpios = <&pio 1 10 GPIO_ACTIVE_LOW>;
```

```c
ret = fbtft_request_one_gpio(par, "reset", 0, &par->gpio.reset);
```

关键问题来了！看第 171 行：

```c
gpio = of_get_named_gpio_flags(node, name, index, &of_flags);
```

**`of_get_named_gpio_flags` 不会自动添加后缀！** 它会直接查找您传入的属性名。

只有 `of_find_gpio()` 函数（在 `gpiolib-of.c` 中）才会自动添加 `-gpios` 或 `-gpio` 后缀。

### 4. **验证：查看函数调用链**

```c
gpio = of_get_named_gpio_flags(node, name, index, &of_flags);
```

```c
gpio = of_get_named_gpio_flags(node, name, index, &of_flags);
```

看到了！`of_get_named_gpio_flags` 直接传递属性名，**不会添加后缀**。

只有 `of_find_gpio()` 才会遍历 `gpio_suffixes` 数组并添加后缀。

### 5. **结论与建议**

#### ❌ **您的简化方案不可行**

如果您这样做：

```c
// 设备树
reset-gpios = <&pio 1 10 GPIO_ACTIVE_LOW>;

// 代码
ret = fbtft_request_one_gpio(par, "reset", 0, &par->gpio.reset);
```

**结果：**
- `of_find_property(node, "reset", NULL)` → 返回 NULL（找不到 "reset" 属性）
- 函数直接返回 0，GPIO 不会被请求
- **驱动无法正常工作** ❌

#### ✅ **正确的方案有两种**

**方案 1：完全按照补丁修改（推荐）**

```c
// 设备树（sunxi 扩展格式，6个参数）
reset = <&pio 1 10 0 1 0 1>;  // bank, pin, function, pull, drive, data

// 代码
struct gpio_config gpio_of_flags;
gpio = of_get_named_gpio_flags(node, "reset", index, 
                               (enum of_gpio_flags *)&gpio_of_flags);
flags = (gpio_of_flags.data & OF_GPIO_ACTIVE_LOW) ? GPIOF_OUT_INIT_LOW : 
                                                     GPIOF_OUT_INIT_HIGH;
```

**方案 2：保持标准格式（不推荐，因为丢失 sunxi 特性）**

```c
// 设备树（标准格式）
reset-gpios = <&pio 1 10 GPIO_ACTIVE_LOW>;

// 代码（保持原样）
enum of_gpio_flags of_flags;
gpio = of_get_named_gpio_flags(node, "reset-gpios", index, &of_flags);
flags = (of_flags & OF_GPIO_ACTIVE_LOW) ? GPIOF_OUT_INIT_LOW : 
                                          GPIOF_OUT_INIT_HIGH;
```

但这样会丢失 sunxi 的扩展功能（上下拉、驱动能力等配置）。

### 6. **为什么必须完整应用补丁**

sunxi 平台的 `sunxi_pinctrl_gpio_of_xlate` 函数期望接收 **6 个参数**：

```c
config->gpio = base + gpiospec->args[1];      // GPIO 编号
config->mul_sel = gpiospec->args[2];          // 功能选择
config->pull = gpiospec->args[3];             // 上下拉配置
config->drv_level = gpiospec->args[4];        // 驱动能力
config->data = gpiospec->args[5];             // 数据/标志位
```

如果使用标准的 3 参数格式，会导致配置不完整，可能出现：
- GPIO 上下拉配置错误
- 驱动能力不足导致信号质量问题
- 功能复用配置错误

### 📋 **最终建议**

**完整应用补丁**，包括：
1. ✅ 修改数据结构为 `struct gpio_config`
2. ✅ 修改属性名去掉 `-gpios` 后缀
3. ✅ 在设备树中使用 sunxi 的 6 参数格式

这样才能充分利用 sunxi 平台的 GPIO 功能，确保硬件配置正确。

```c
// 设备树
reset-gpios = <&pio 1 10 GPIO_ACTIVE_LOW>;

// 代码
ret = fbtft_request_one_gpio(par, "reset", 0, &par->gpio.reset);
```

```c
// 设备树（sunxi 扩展格式，6个参数）
reset = <&pio 1 10 0 1 0 1>;  // bank, pin, function, pull, drive, data

// 代码
struct gpio_config gpio_of_flags;
gpio = of_get_named_gpio_flags(node, "reset", index, 
                               (enum of_gpio_flags *)&gpio_of_flags);
flags = (gpio_of_flags.data & OF_GPIO_ACTIVE_LOW) ? GPIOF_OUT_INIT_LOW : 
                                                     GPIOF_OUT_INIT_HIGH;
```

```c
// 设备树（标准格式）
reset-gpios = <&pio 1 10 GPIO_ACTIVE_LOW>;

// 代码（保持原样）
enum of_gpio_flags of_flags;
gpio = of_get_named_gpio_flags(node, "reset-gpios", index, &of_flags);
flags = (of_flags & OF_GPIO_ACTIVE_LOW) ? GPIOF_OUT_INIT_LOW : 
                                          GPIOF_OUT_INIT_HIGH;
```

```c
config->gpio = base + gpiospec->args[1];      // GPIO 编号
config->mul_sel = gpiospec->args[2];          // 功能选择
config->pull = gpiospec->args[3];             // 上下拉配置
config->drv_level = gpiospec->args[4];        // 驱动能力
config->data = gpiospec->args[5];             // 数据/标志位
```

```c
// 设备树
reset-gpios = <&pio 1 10 GPIO_ACTIVE_LOW>;

// 代码
ret = fbtft_request_one_gpio(par, "reset", 0, &par->gpio.reset);
```

```c
// 设备树（sunxi 扩展格式，6个参数）
reset = <&pio 1 10 0 1 0 1>;  // bank, pin, function, pull, drive, data

// 代码
struct gpio_config gpio_of_flags;
gpio = of_get_named_gpio_flags(node, "reset", index, 
                               (enum of_gpio_flags *)&gpio_of_flags);
flags = (gpio_of_flags.data & OF_GPIO_ACTIVE_LOW) ? GPIOF_OUT_INIT_LOW : 
                                                     GPIOF_OUT_INIT_HIGH;
```

```c
// 设备树（标准格式）
reset-gpios = <&pio 1 10 GPIO_ACTIVE_LOW>;

// 代码（保持原样）
enum of_gpio_flags of_flags;
gpio = of_get_named_gpio_flags(node, "reset-gpios", index, &of_flags);
flags = (of_flags & OF_GPIO_ACTIVE_LOW) ? GPIOF_OUT_INIT_LOW : 
                                          GPIOF_OUT_INIT_HIGH;
```

```c
config->gpio = base + gpiospec->args[1];      // GPIO 编号
config->mul_sel = gpiospec->args[2];          // 功能选择
config->pull = gpiospec->args[3];             // 上下拉配置
config->drv_level = gpiospec->args[4];        // 驱动能力
config->data = gpiospec->args[5];             // 数据/标志位
```

---

**User**

是否还需要去掉#include <linux/sunxi-gpio.h>换成#include <linux/of_gpio.h>？

GPIO驱动是如何区分使用这种形式reset-gpios = <&pio 1 10 GPIO_ACTIVE_LOW>;还是这种形式的reset = <&pio 1 10 0 1 0 1>; ？

---

**Cursor**

非常好的问题！让我详细解答这两个关键问题。

## 问题 1：是否需要替换头文件？

好的，现在我看到了完整的代码。让我详细回答您的两个问题：

## 问题 1：是否需要替换头文件？

### ❌ **不需要替换，需要添加**

看第 37 行，原代码已经包含了：

```c
#include <linux/of_gpio.h>
```

补丁是**添加**而不是替换：

```c
#include <linux/of_gpio.h>
#include <linux/sunxi-gpio.h>  // 新增这一行
```

**原因：**
- `<linux/of_gpio.h>` 提供标准的 `of_get_named_gpio_flags()` 函数声明和 `enum of_gpio_flags` 定义
- `<linux/sunxi-gpio.h>` 提供 sunxi 特定的 `struct gpio_config` 定义

**两个头文件都需要！** ✅

---

## 问题 2：GPIO 驱动如何区分两种格式？

这是一个非常好的问题！让我详细解释：

### 🔍 **区分机制：通过 `#gpio-cells` 属性**

设备树中的 GPIO 控制器节点会声明它需要多少个参数：

#### **标准 GPIO 控制器（3 个参数）**

```dts
gpio: gpio@1c20800 {
    compatible = "generic,gpio";
    #gpio-cells = <2>;  // 2个参数：pin编号 + 标志
    gpio-controller;
};

// 使用时
reset-gpios = <&gpio 10 GPIO_ACTIVE_LOW>;
//             ^^^^^ ^^  ^^^^^^^^^^^^^^^^
//             控制器 pin  标志位
```

#### **Sunxi GPIO 控制器（6 个参数）**

```dts
pio: pinctrl@1c20800 {
    compatible = "allwinner,sun50i-a133-pinctrl";
    #gpio-cells = <6>;  // 6个参数！
    gpio-controller;
};

// 使用时
reset = <&pio 1 10 0 1 0 1>;
//      ^^^^^ ^ ^^ ^ ^ ^ ^
//      控制器 bank pin func pull drive data
```

### 📋 **完整的解析流程**

```c
#include <linux/of_gpio.h>
```

```c
#include <linux/of_gpio.h>
#include <linux/sunxi-gpio.h>  // 新增这一行
```

```dts
gpio: gpio@1c20800 {
    compatible = "generic,gpio";
    #gpio-cells = <2>;  // 2个参数：pin编号 + 标志
    gpio-controller;
};

// 使用时
reset-gpios = <&gpio 10 GPIO_ACTIVE_LOW>;
//             ^^^^^ ^^  ^^^^^^^^^^^^^^^^
//             控制器 pin  标志位
```

```dts
pio: pinctrl@1c20800 {
    compatible = "allwinner,sun50i-a133-pinctrl";
    #gpio-cells = <6>;  // 6个参数！
    gpio-controller;
};

// 使用时
reset = <&pio 1 10 0 1 0 1>;
//      ^^^^^ ^ ^^ ^ ^ ^ ^
//      控制器 bank pin func pull drive data
```

完美！现在我可以给您一个完整的解释了。

## 🔍 **GPIO 驱动如何区分两种格式的详细机制**

### 1️⃣ **关键：`of_parse_phandle_with_args` 函数**

看 `gpiolib-of.c:82-85`：

```c
ret = of_parse_phandle_with_args(np, propname, "#gpio-cells", index,
                                 &gpiospec);
```

这个函数会：
1. 解析设备树属性（如 `reset = <&pio 1 10 0 1 0 1>`）
2. 找到引用的 GPIO 控制器节点（`&pio`）
3. **读取该控制器的 `#gpio-cells` 属性**
4. 根据 `#gpio-cells` 的值，从设备树中读取相应数量的参数

### 2️⃣ **设备树示例对比**

#### **标准 GPIO 控制器（2-3 个参数）**

```dts
gpio: gpio@1c20800 {
    compatible = "generic,gpio";
    gpio-controller;
    #gpio-cells = <2>;  // ← 告诉系统：我需要 2 个参数
    // ...
};

// 使用
some_device {
    reset-gpios = <&gpio 10 GPIO_ACTIVE_LOW>;
    //            ^^^^^ ^^  ^^^^^^^^^^^^^^^^
    //            phandle  2个参数（pin, flags）
};
```

#### **Sunxi GPIO 控制器（6 个参数）**

```dts
pio: pinctrl@1c20800 {
    compatible = "allwinner,sun50i-a133-pinctrl";
    gpio-controller;
    #gpio-cells = <6>;  // ← 告诉系统：我需要 6 个参数！
    // ...
};

// 使用
some_device {
    reset = <&pio 1 10 0 1 0 1>;
    //      ^^^^^ ^ ^^ ^ ^ ^ ^
    //      phandle  6个参数（bank, pin, func, pull, drive, data）
};
```

### 3️⃣ **完整的解析流程**

```
设备树: reset = <&pio 1 10 0 1 0 1>
         ↓
of_parse_phandle_with_args()
         ↓
1. 解析 phandle → 找到 pio 节点
2. 读取 pio 的 #gpio-cells = <6>
3. 从设备树读取 6 个参数 → gpiospec.args[0..5]
4. 设置 gpiospec.args_count = 6
         ↓
of_find_gpiochip_by_xlate(&gpiospec)
         ↓
找到对应的 gpio_chip（sunxi pinctrl 驱动注册的）
         ↓
chip->of_xlate(chip, &gpiospec, flags)
         ↓
调用 sunxi_pinctrl_gpio_of_xlate()  ← 在 pinctrl-sunxi.c:1043
         ↓
解析 6 个参数到 struct gpio_config:
    config->gpio      = args[0] * 32 + args[1]  // bank * 32 + pin
    config->mul_sel   = args[2]                  // 功能选择
    config->pull      = args[3]                  // 上下拉
    config->drv_level = args[4]                  // 驱动能力
    config->data      = args[5]                  // 数据/标志
```

### 4️⃣ **关键代码位置**

#### **A. 参数数量检查**（`gpiolib-of.c:48-50`）

```c
if (chip->of_gpio_n_cells != gpiospec->args_count)
    return ERR_PTR(-EINVAL);
```

这里会检查：
- `chip->of_gpio_n_cells`：GPIO 控制器驱动声明需要的参数数量
- `gpiospec->args_count`：设备树中实际提供的参数数量

如果不匹配，直接返回错误！

#### **B. Sunxi 的 xlate 函数**（`pinctrl-sunxi.c:1043-1065`）

```c
static int sunxi_pinctrl_gpio_of_xlate(struct gpio_chip *gc,
                const struct of_phandle_args *gpiospec,
                u32 *flags)
{
    struct gpio_config *config;
    int pin, base;

    base = PINS_PER_BANK * gpiospec->args[0];  // args[0] = bank
    pin = base + gpiospec->args[1];             // args[1] = pin
    pin = pin - gc->base;
    if (pin > gc->ngpio)
        return -EINVAL;

    if (flags) {
        config = (struct gpio_config *)flags;
        config->gpio = base + gpiospec->args[1];
        config->mul_sel = gpiospec->args[2];    // 功能选择
        config->pull = gpiospec->args[3];       // 上下拉
        config->drv_level = gpiospec->args[4];  // 驱动能力
        config->data = gpiospec->args[5];       // 数据/标志
    }

    return pin;
}
```

#### **C. 标准的 xlate 函数**（`gpiolib-of.c:340-360`）

```c
int of_gpio_simple_xlate(struct gpio_chip *gc,
             const struct of_phandle_args *gpiospec, u32 *flags)
{
    if (gc->of_gpio_n_cells < 2) {
        WARN_ON(1);
        return -EINVAL;
    }

    if (WARN_ON(gpiospec->args_count < gc->of_gpio_n_cells))
        return -EINVAL;

    if (gpiospec->args[0] >= gc->ngpio)
        return -EINVAL;

    if (flags)
        *flags = gpiospec->args[1];  // 只使用第2个参数作为标志

    return gpiospec->args[0];        // 第1个参数是 pin 编号
}
```

### 5️⃣ **总结对比表**

| 特性 | 标准 GPIO | Sunxi GPIO |
|------|----------|------------|
| **#gpio-cells** | 2 | 6 |
| **xlate 函数** | `of_gpio_simple_xlate` | `sunxi_pinctrl_gpio_of_xlate` |
| **flags 类型** | `enum of_gpio_flags` (简单整数) | `struct gpio_config` (复杂结构) |
| **参数含义** | pin, flags | bank, pin, func, pull, drive, data |
| **设备树示例** | `<&gpio 10 GPIO_ACTIVE_LOW>` | `<&pio 1 10 0 1 0 1>` |

### 6️⃣ **为什么需要完整应用补丁**

现在您应该明白了：

1. **必须添加 `#include <linux/sunxi-gpio.h>`**
   - 需要 `struct gpio_config` 的定义

2. **必须修改数据结构**
   - 从 `enum of_gpio_flags` 改为 `struct gpio_config`
   - 因为 sunxi 的 xlate 函数会填充整个结构体

3. **必须修改属性名**
   - 从 `"reset-gpios"` 改为 `"reset"`
   - 让 GPIO 子系统自动添加后缀

4. **设备树必须使用 6 参数格式**
   - 因为 sunxi pinctrl 驱动的 `#gpio-cells = <6>`
   - xlate 函数期望 6 个参数

**这是一个完整的生态系统，所有部分必须配合才能工作！** ✅

```c
ret = of_parse_phandle_with_args(np, propname, "#gpio-cells", index,
                                 &gpiospec);
```

```dts
gpio: gpio@1c20800 {
    compatible = "generic,gpio";
    gpio-controller;
    #gpio-cells = <2>;  // ← 告诉系统：我需要 2 个参数
    // ...
};

// 使用
some_device {
    reset-gpios = <&gpio 10 GPIO_ACTIVE_LOW>;
    //            ^^^^^ ^^  ^^^^^^^^^^^^^^^^
    //            phandle  2个参数（pin, flags）
};
```

```dts
pio: pinctrl@1c20800 {
    compatible = "allwinner,sun50i-a133-pinctrl";
    gpio-controller;
    #gpio-cells = <6>;  // ← 告诉系统：我需要 6 个参数！
    // ...
};

// 使用
some_device {
    reset = <&pio 1 10 0 1 0 1>;
    //      ^^^^^ ^ ^^ ^ ^ ^ ^
    //      phandle  6个参数（bank, pin, func, pull, drive, data）
};
```

```plaintext
设备树: reset = <&pio 1 10 0 1 0 1>
         ↓
of_parse_phandle_with_args()
         ↓
1. 解析 phandle → 找到 pio 节点
2. 读取 pio 的 #gpio-cells = <6>
3. 从设备树读取 6 个参数 → gpiospec.args[0..5]
4. 设置 gpiospec.args_count = 6
         ↓
of_find_gpiochip_by_xlate(&gpiospec)
         ↓
找到对应的 gpio_chip（sunxi pinctrl 驱动注册的）
         ↓
chip->of_xlate(chip, &gpiospec, flags)
         ↓
调用 sunxi_pinctrl_gpio_of_xlate()  ← 在 pinctrl-sunxi.c:1043
         ↓
解析 6 个参数到 struct gpio_config:
    config->gpio      = args[0] * 32 + args[1]  // bank * 32 + pin
    config->mul_sel   = args[2]                  // 功能选择
    config->pull      = args[3]                  // 上下拉
    config->drv_level = args[4]                  // 驱动能力
    config->data      = args[5]                  // 数据/标志
```

```c
ret = of_parse_phandle_with_args(np, propname, "#gpio-cells", index,
                                 &gpiospec);
```

```dts
gpio: gpio@1c20800 {
    compatible = "generic,gpio";
    gpio-controller;
    #gpio-cells = <2>;  // ← 告诉系统：我需要 2 个参数
    // ...
};

// 使用
some_device {
    reset-gpios = <&gpio 10 GPIO_ACTIVE_LOW>;
    //            ^^^^^ ^^  ^^^^^^^^^^^^^^^^
    //            phandle  2个参数（pin, flags）
};
```

```dts
pio: pinctrl@1c20800 {
    compatible = "allwinner,sun50i-a133-pinctrl";
    gpio-controller;
    #gpio-cells = <6>;  // ← 告诉系统：我需要 6 个参数！
    // ...
};

// 使用
some_device {
    reset = <&pio 1 10 0 1 0 1>;
    //      ^^^^^ ^ ^^ ^ ^ ^ ^
    //      phandle  6个参数（bank, pin, func, pull, drive, data）
};
```

```plaintext
设备树: reset = <&pio 1 10 0 1 0 1>
         ↓
of_parse_phandle_with_args()
         ↓
1. 解析 phandle → 找到 pio 节点
2. 读取 pio 的 #gpio-cells = <6>
3. 从设备树读取 6 个参数 → gpiospec.args[0..5]
4. 设置 gpiospec.args_count = 6
         ↓
of_find_gpiochip_by_xlate(&gpiospec)
         ↓
找到对应的 gpio_chip（sunxi pinctrl 驱动注册的）
         ↓
chip->of_xlate(chip, &gpiospec, flags)
         ↓
调用 sunxi_pinctrl_gpio_of_xlate()  ← 在 pinctrl-sunxi.c:1043
         ↓
解析 6 个参数到 struct gpio_config:
    config->gpio      = args[0] * 32 + args[1]  // bank * 32 + pin
    config->mul_sel   = args[2]                  // 功能选择
    config->pull      = args[3]                  // 上下拉
    config->drv_level = args[4]                  // 驱动能力
    config->data      = args[5]                  // 数据/标志
```

```c
if (chip->of_gpio_n_cells != gpiospec->args_count)
    return ERR_PTR(-EINVAL);
```

```c
static int sunxi_pinctrl_gpio_of_xlate(struct gpio_chip *gc,
                const struct of_phandle_args *gpiospec,
                u32 *flags)
{
    struct gpio_config *config;
    int pin, base;

    base = PINS_PER_BANK * gpiospec->args[0];  // args[0] = bank
    pin = base + gpiospec->args[1];             // args[1] = pin
    pin = pin - gc->base;
    if (pin > gc->ngpio)
        return -EINVAL;

    if (flags) {
        config = (struct gpio_config *)flags;
        config->gpio = base + gpiospec->args[1];
        config->mul_sel = gpiospec->args[2];    // 功能选择
        config->pull = gpiospec->args[3];       // 上下拉
        config->drv_level = gpiospec->args[4];  // 驱动能力
        config->data = gpiospec->args[5];       // 数据/标志
    }

    return pin;
}
```

```c
int of_gpio_simple_xlate(struct gpio_chip *gc,
             const struct of_phandle_args *gpiospec, u32 *flags)
{
    if (gc->of_gpio_n_cells < 2) {
        WARN_ON(1);
        return -EINVAL;
    }

    if (WARN_ON(gpiospec->args_count < gc->of_gpio_n_cells))
        return -EINVAL;

    if (gpiospec->args[0] >= gc->ngpio)
        return -EINVAL;

    if (flags)
        *flags = gpiospec->args[1];  // 只使用第2个参数作为标志

    return gpiospec->args[0];        // 第1个参数是 pin 编号
}
```

---

**User**

是不是想使用标准 GPIO的话还得重新适配sunxi框架？

---

**Cursor**

是的！您的理解非常正确！👍

让我详细解释一下为什么以及如何适配：

## 🎯 **核心问题：Sunxi 已经修改了整个 GPIO 框架**

看到了！第 20 行：

```dts
#gpio-cells = <6>;
```

这就是问题的根源！让我详细解释：

## ❌ **为什么不能直接使用标准 GPIO 格式**

### 1️⃣ **Sunxi 已经在底层修改了 GPIO 框架**

Sunxi 做了以下修改：

#### **A. 修改了 `gpiolib-of.c`**（我们之前看到的）

```c
#ifdef CONFIG_ARCH_SUNXI
    struct gpio_config gpio_flags;  // ← 使用扩展结构
#else
    enum of_gpio_flags of_flags;    // ← 标准结构
#endif
```

#### **B. 所有 GPIO 控制器都声明 `#gpio-cells = <6>`**

```dts
r_pio: pinctrl@07022000 {
    #gpio-cells = <6>;  // ← 强制要求 6 个参数！
}

pio: pinctrl@0300b000 {
    #gpio-cells = <6>;  // ← 所有 sunxi GPIO 都是这样
}
```

#### **C. xlate 函数期望 6 个参数**

`pinctrl-sunxi.c` 中的 `sunxi_pinctrl_gpio_of_xlate` 函数会访问 `gpiospec->args[0]` 到 `args[5]`。

### 2️⃣ **如果强行使用标准格式会发生什么？**

假设您在设备树中写：

```dts
reset-gpios = <&pio 10 GPIO_ACTIVE_LOW>;  // 只有 2 个参数
```

**结果：**

```
of_parse_phandle_with_args()
  ↓
读取 pio 的 #gpio-cells = <6>
  ↓
期望 6 个参数，但只找到 2 个
  ↓
gpiospec->args_count = 2
  ↓
of_xlate_and_get_gpiod_flags()
  ↓
检查: chip->of_gpio_n_cells (6) != gpiospec->args_count (2)
  ↓
返回 -EINVAL ❌
  ↓
GPIO 请求失败！
```

## 🔧 **要使用标准 GPIO 格式，需要做什么？**

### **方案 1：修改 Sunxi Pinctrl 驱动（大工程）** ⚠️

需要修改以下内容：

#### **1. 修改 `pinctrl-sunxi.c`**

```dts
#gpio-cells = <6>;
```

```c
#ifdef CONFIG_ARCH_SUNXI
    struct gpio_config gpio_flags;  // ← 使用扩展结构
#else
    enum of_gpio_flags of_flags;    // ← 标准结构
#endif
```

```dts
r_pio: pinctrl@07022000 {
    #gpio-cells = <6>;  // ← 强制要求 6 个参数！
}

pio: pinctrl@0300b000 {
    #gpio-cells = <6>;  // ← 所有 sunxi GPIO 都是这样
}
```

```dts
reset-gpios = <&pio 10 GPIO_ACTIVE_LOW>;  // 只有 2 个参数
```

```plaintext
of_parse_phandle_with_args()
  ↓
读取 pio 的 #gpio-cells = <6>
  ↓
期望 6 个参数，但只找到 2 个
  ↓
gpiospec->args_count = 2
  ↓
of_xlate_and_get_gpiod_flags()
  ↓
检查: chip->of_gpio_n_cells (6) != gpiospec->args_count (2)
  ↓
返回 -EINVAL ❌
  ↓
GPIO 请求失败！
```

完美！现在我可以给您一个完整的答案了。

## 📊 **要使用标准 GPIO 格式需要的改动**

### **方案 1：彻底改造 Sunxi GPIO 框架（不推荐）** ❌

需要修改的地方：

#### **1. 修改 `pinctrl-sunxi.c`（第 2555 行）**

```c
// 原代码
pctl->chip->of_gpio_n_cells = 6,

// 改为
pctl->chip->of_gpio_n_cells = 2,  // 标准格式
```

#### **2. 重写 `sunxi_pinctrl_gpio_of_xlate` 函数**

```c
// 原代码（期望 6 个参数）
static int sunxi_pinctrl_gpio_of_xlate(struct gpio_chip *gc,
                const struct of_phandle_args *gpiospec,
                u32 *flags)
{
    struct gpio_config *config;
    base = PINS_PER_BANK * gpiospec->args[0];
    pin = base + gpiospec->args[1];
    config->mul_sel = gpiospec->args[2];    // ← 需要 6 个参数
    config->pull = gpiospec->args[3];
    config->drv_level = gpiospec->args[4];
    config->data = gpiospec->args[5];
    // ...
}

// 改为标准格式（只用 2 个参数）
static int sunxi_pinctrl_gpio_of_xlate_standard(struct gpio_chip *gc,
                const struct of_phandle_args *gpiospec,
                u32 *flags)
{
    if (gpiospec->args_count < 2)
        return -EINVAL;
    
    if (gpiospec->args[0] >= gc->ngpio)
        return -EINVAL;
    
    if (flags)
        *flags = gpiospec->args[1];  // 只使用标志位
    
    return gpiospec->args[0];  // 返回 pin 编号
}
```

#### **3. 修改 `gpiolib-of.c`**

```c
// 移除 CONFIG_ARCH_SUNXI 的特殊处理
#ifdef CONFIG_ARCH_SUNXI
    struct gpio_config gpio_flags;  // ← 删除这些
#endif

// 统一使用标准格式
desc = of_get_named_gpiod_flags(dev->of_node, prop_name, idx, &of_flags);
```

#### **4. 修改所有设备树文件**

```dts
// 原格式
r_pio: pinctrl@07022000 {
    #gpio-cells = <6>;  // ← 改为 2
}

pio: pinctrl@0300b000 {
    #gpio-cells = <6>;  // ← 改为 2
}
```

#### **5. 修改所有使用 GPIO 的设备树节点**

```dts
// 原格式（6 个参数）
reset = <&pio 1 10 0 1 0 1>;

// 改为标准格式（2 个参数）
reset-gpios = <&pio 42 GPIO_ACTIVE_LOW>;  // 1*32+10=42
```

### **问题：会丢失什么？** ⚠️

如果改用标准格式，您将**丢失以下配置能力**：

1. ❌ **功能复用配置** (`mul_sel`)
2. ❌ **上下拉配置** (`pull`)
3. ❌ **驱动能力配置** (`drv_level`)
4. ❌ **初始数据值** (`data`)

这些配置只能通过其他方式（如 pinctrl 子系统）来设置，会变得非常复杂。

---

## ✅ **方案 2：保持 Sunxi 格式（强烈推荐）**

**直接应用补丁，使用 Sunxi 的 6 参数格式！**

### **为什么推荐这个方案？**

1. ✅ **无需修改底层框架** - 不会破坏现有系统
2. ✅ **保留所有硬件配置能力** - 可以精确控制 GPIO 特性
3. ✅ **与 Allwinner 官方保持一致** - 便于维护和升级
4. ✅ **只需修改应用层驱动** - 改动范围小，风险低

### **具体做法：**

#### **1. 应用补丁到 `fbtft-core.c`**

```c
// 添加头文件
#include <linux/sunxi-gpio.h>

// 修改数据结构
struct gpio_config gpio_of_flags;  // 替代 enum of_gpio_flags

// 修改属性名
ret = fbtft_request_one_gpio(par, "reset", 0, &par->gpio.reset);  // 去掉 -gpios
```

#### **2. 设备树使用 6 参数格式**

```dts
&pio {
    fbtft_pins: fbtft-pins {
        allwinner,pins = "PB1", "PB2", "PB3";
        allwinner,function = "gpio_out";
        allwinner,muxsel = <1>;
        allwinner,drive = <1>;
        allwinner,pull = <1>;
    };
};

&spi0 {
    st7735r@0 {
        compatible = "sitronix,st7735r";
        reg = <0>;
        
        // Sunxi 6 参数格式
        reset = <&pio 1 1 1 1 1 1>;   // PB1, 输出, 上拉, 驱动能力1, 初始高
        dc    = <&pio 1 2 1 1 1 0>;   // PB2, 输出, 上拉, 驱动能力1, 初始低
        // 参数含义: bank pin function pull drive data
        //           0-1  2-3  4-5      6-7  8-9   10-11
    };
};
```

---

## 🎯 **最终建议**

### **不要尝试改造 Sunxi 框架！**

原因：

1. **工作量巨大** - 需要修改内核核心代码、所有设备树文件
2. **风险极高** - 可能破坏其他驱动（LCD、触摸屏、音频等都用 GPIO）
3. **丢失功能** - 无法精确配置 GPIO 特性
4. **维护困难** - 与 Allwinner 官方分支不兼容

### **正确做法：拥抱 Sunxi 的扩展格式**

```bash
# 1. 应用补丁
cd lichee/linux-4.9/drivers/staging/fbtft
patch -p1 < fbtft-sunxi.patch

# 2. 在设备树中使用 6 参数格式
# 3. 享受更强大的 GPIO 配置能力！
```

**这就是为什么 Allwinner 要做这个扩展 - 为了更好地控制硬件！** 💪

---

## 📝 **总结**

| 方案 | 工作量 | 风险 | 功能完整性 | 推荐度 |
|------|--------|------|-----------|--------|
| 改造 Sunxi 框架 | 🔴 巨大 | 🔴 极高 | 🔴 功能缺失 | ❌ 不推荐 |
| 使用 Sunxi 格式 | 🟢 很小 | 🟢 很低 | 🟢 功能完整 | ✅ 强烈推荐 |

**答案：是的，要用标准格式需要重新适配整个 Sunxi 框架，但这完全没必要！直接用 Sunxi 的扩展格式更好！** 🎉

```c
// 原代码
pctl->chip->of_gpio_n_cells = 6,

// 改为
pctl->chip->of_gpio_n_cells = 2,  // 标准格式
```

```c
// 原代码（期望 6 个参数）
static int sunxi_pinctrl_gpio_of_xlate(struct gpio_chip *gc,
                const struct of_phandle_args *gpiospec,
                u32 *flags)
{
    struct gpio_config *config;
    base = PINS_PER_BANK * gpiospec->args[0];
    pin = base + gpiospec->args[1];
    config->mul_sel = gpiospec->args[2];    // ← 需要 6 个参数
    config->pull = gpiospec->args[3];
    config->drv_level = gpiospec->args[4];
    config->data = gpiospec->args[5];
    // ...
}

// 改为标准格式（只用 2 个参数）
static int sunxi_pinctrl_gpio_of_xlate_standard(struct gpio_chip *gc,
                const struct of_phandle_args *gpiospec,
                u32 *flags)
{
    if (gpiospec->args_count < 2)
        return -EINVAL;
    
    if (gpiospec->args[0] >= gc->ngpio)
        return -EINVAL;
    
    if (flags)
        *flags = gpiospec->args[1];  // 只使用标志位
    
    return gpiospec->args[0];  // 返回 pin 编号
}
```

```c
// 移除 CONFIG_ARCH_SUNXI 的特殊处理
#ifdef CONFIG_ARCH_SUNXI
    struct gpio_config gpio_flags;  // ← 删除这些
#endif

// 统一使用标准格式
desc = of_get_named_gpiod_flags(dev->of_node, prop_name, idx, &of_flags);
```

```dts
// 原格式
r_pio: pinctrl@07022000 {
    #gpio-cells = <6>;  // ← 改为 2
}

pio: pinctrl@0300b000 {
    #gpio-cells = <6>;  // ← 改为 2
}
```

```dts
// 原格式（6 个参数）
reset = <&pio 1 10 0 1 0 1>;

// 改为标准格式（2 个参数）
reset-gpios = <&pio 42 GPIO_ACTIVE_LOW>;  // 1*32+10=42
```

```c
// 原代码
pctl->chip->of_gpio_n_cells = 6,

// 改为
pctl->chip->of_gpio_n_cells = 2,  // 标准格式
```

```c
// 原代码（期望 6 个参数）
static int sunxi_pinctrl_gpio_of_xlate(struct gpio_chip *gc,
                const struct of_phandle_args *gpiospec,
                u32 *flags)
{
    struct gpio_config *config;
    base = PINS_PER_BANK * gpiospec->args[0];
    pin = base + gpiospec->args[1];
    config->mul_sel = gpiospec->args[2];    // ← 需要 6 个参数
    config->pull = gpiospec->args[3];
    config->drv_level = gpiospec->args[4];
    config->data = gpiospec->args[5];
    // ...
}

// 改为标准格式（只用 2 个参数）
static int sunxi_pinctrl_gpio_of_xlate_standard(struct gpio_chip *gc,
                const struct of_phandle_args *gpiospec,
                u32 *flags)
{
    if (gpiospec->args_count < 2)
        return -EINVAL;
    
    if (gpiospec->args[0] >= gc->ngpio)
        return -EINVAL;
    
    if (flags)
        *flags = gpiospec->args[1];  // 只使用标志位
    
    return gpiospec->args[0];  // 返回 pin 编号
}
```

```c
// 移除 CONFIG_ARCH_SUNXI 的特殊处理
#ifdef CONFIG_ARCH_SUNXI
    struct gpio_config gpio_flags;  // ← 删除这些
#endif

// 统一使用标准格式
desc = of_get_named_gpiod_flags(dev->of_node, prop_name, idx, &of_flags);
```

```dts
// 原格式
r_pio: pinctrl@07022000 {
    #gpio-cells = <6>;  // ← 改为 2
}

pio: pinctrl@0300b000 {
    #gpio-cells = <6>;  // ← 改为 2
}
```

```dts
// 原格式（6 个参数）
reset = <&pio 1 10 0 1 0 1>;

// 改为标准格式（2 个参数）
reset-gpios = <&pio 42 GPIO_ACTIVE_LOW>;  // 1*32+10=42
```

```c
// 添加头文件
#include <linux/sunxi-gpio.h>

// 修改数据结构
struct gpio_config gpio_of_flags;  // 替代 enum of_gpio_flags

// 修改属性名
ret = fbtft_request_one_gpio(par, "reset", 0, &par->gpio.reset);  // 去掉 -gpios
```

```dts
&pio {
    fbtft_pins: fbtft-pins {
        allwinner,pins = "PB1", "PB2", "PB3";
        allwinner,function = "gpio_out";
        allwinner,muxsel = <1>;
        allwinner,drive = <1>;
        allwinner,pull = <1>;
    };
};

&spi0 {
    st7735r@0 {
        compatible = "sitronix,st7735r";
        reg = <0>;
        
        // Sunxi 6 参数格式
        reset = <&pio 1 1 1 1 1 1>;   // PB1, 输出, 上拉, 驱动能力1, 初始高
        dc    = <&pio 1 2 1 1 1 0>;   // PB2, 输出, 上拉, 驱动能力1, 初始低
        // 参数含义: bank pin function pull drive data
        //           0-1  2-3  4-5      6-7  8-9   10-11
    };
};
```

```shellscript
# 1. 应用补丁
cd lichee/linux-4.9/drivers/staging/fbtft
patch -p1 < fbtft-sunxi.patch

# 2. 在设备树中使用 6 参数格式
# 3. 享受更强大的 GPIO 配置能力！
```

---

**User**

是不是主线的所有驱动都得这样改？sunxi自己设计框架的目的是什么？

---

**Cursor**

非常好的问题！这涉及到 Linux 内核生态系统中一个重要的话题。让我详细解答：

## 🎯 **是的，主线驱动都需要适配！**

### 1️⃣ **哪些驱动需要修改？**

**所有直接使用设备树 GPIO 绑定的主线驱动都需要适配：**

看到了！很多驱动都在使用。让我查看一个具体的例子：

让我再查看一个 Sunxi 自己的驱动是如何处理的：

完美！现在我可以给您一个全面的答案了。

## 📊 **主线驱动适配情况分析**

### 1️⃣ **需要修改的驱动类型**

从搜索结果看，以下类型的驱动都需要适配：

| 驱动类型 | 示例 | 是否需要改 |
|---------|------|-----------|
| **触摸屏驱动** | focaltech, tlsc6x, it7257 | ✅ 需要 |
| **显示驱动** | fbtft, LCD 驱动 | ✅ 需要 |
| **摄像头驱动** | sunxi-vin, sensor_power | ✅ 需要 |
| **输入设备** | GPIO 按键, 红外接收 | ✅ 需要 |
| **电源管理** | 充电器, 电池驱动 | ✅ 需要 |
| **音频驱动** | 使用 GPIO 控制的音频 | ✅ 需要 |

### 2️⃣ **对比：主线驱动 vs Sunxi 适配驱动**

#### **主线驱动（标准格式）**

```c
// focaltech 触摸屏驱动（主线）
pdata->reset_gpio = of_get_named_gpio_flags(np, "focaltech,reset-gpio",
                    0, &pdata->reset_gpio_flags);
// ↑ 使用 enum of_gpio_flags

// 设备树
focaltech,reset-gpio = <&gpio 10 GPIO_ACTIVE_LOW>;  // 2-3 个参数
```

#### **Sunxi 适配驱动**

```c
// sensor_power 驱动（Sunxi 适配）
static int sensor_get_gpio_info(struct device_node *np, const char *name,
                struct gpio_config *gc)  // ← 使用 struct gpio_config
{
    int gnum;
    gnum = of_get_named_gpio_flags(np, name, 0, 
                (enum of_gpio_flags *)gc);  // ← 强制转换
    // ...
}

// 设备树
reset = <&pio 1 10 1 1 1 1>;  // 6 个参数
```

---

## 🎯 **Sunxi 为什么要自己设计这个框架？**

### **核心原因：硬件复杂性 + 历史遗留**

#### **1. 硬件需求：更精细的 GPIO 控制** 🔧

Allwinner SoC 的 GPIO 控制器功能非常丰富：

```c
struct gpio_config {
    u32 gpio;       // GPIO 编号
    u32 mul_sel;    // 功能复用：0=输入, 1=输出, 2-7=特殊功能
    u32 pull;       // 上下拉：0=禁用, 1=上拉, 2=下拉
    u32 drv_level;  // 驱动能力：0=10mA, 1=20mA, 2=30mA, 3=40mA
    u32 data;       // 初始数据值 + 标志位
};
```

**标准 Linux GPIO 只支持：**
- Pin 编号
- Active Low/High 标志

**Sunxi 需要配置：**
- ✅ Pin 编号
- ✅ 功能复用（GPIO/UART/SPI/I2C 等）
- ✅ 上下拉电阻
- ✅ 驱动能力（影响信号质量）
- ✅ 初始电平
- ✅ Active Low/High

#### **2. 历史原因：sys_config 时代的遗留** 📜

```c
// focaltech 触摸屏驱动（主线）
pdata->reset_gpio = of_get_named_gpio_flags(np, "focaltech,reset-gpio",
                    0, &pdata->reset_gpio_flags);
// ↑ 使用 enum of_gpio_flags

// 设备树
focaltech,reset-gpio = <&gpio 10 GPIO_ACTIVE_LOW>;  // 2-3 个参数
```

```c
// sensor_power 驱动（Sunxi 适配）
static int sensor_get_gpio_info(struct device_node *np, const char *name,
                struct gpio_config *gc)  // ← 使用 struct gpio_config
{
    int gnum;
    gnum = of_get_named_gpio_flags(np, name, 0, 
                (enum of_gpio_flags *)gc);  // ← 强制转换
    // ...
}

// 设备树
reset = <&pio 1 10 1 1 1 1>;  // 6 个参数
```

```c
struct gpio_config {
    u32 gpio;       // GPIO 编号
    u32 mul_sel;    // 功能复用：0=输入, 1=输出, 2-7=特殊功能
    u32 pull;       // 上下拉：0=禁用, 1=上拉, 2=下拉
    u32 drv_level;  // 驱动能力：0=10mA, 1=20mA, 2=30mA, 3=40mA
    u32 data;       // 初始数据值 + 标志位
};
```

看到了关键注释！第 872-875 行：

```c
/*In sunxi platform, if the pin property is set 'default' by
 * sys_config,the param and arg will be zero, and then
 * sunxi_pconf_reg() will return -ENOTSUPP, we didn't handle
 * this fault before we abondon the old configurate ways by
 * sys_config, so return  0 now*/
```

现在我可以给您一个完整的答案了！

---

## 📚 **完整答案：主线驱动适配 + Sunxi 设计目的**

### 1️⃣ **是的，主线驱动都需要适配！**

从搜索结果看，已经有大量驱动被适配：

```bash
✅ 已适配的驱动（部分列表）：
- 触摸屏：focaltech, tlsc6x, it7257
- 摄像头：sunxi-vin, sensor_power, tvd
- 输入设备：GPIO 红外, 霍尔传感器
- 电源：充电器, 电池驱动
- 显示：fbtft（正在适配）
```

**适配模式：**

```c
// Sunxi 自己的驱动都这样写
static int sensor_get_gpio_info(struct device_node *np, const char *name,
                struct gpio_config *gc)  // ← 使用 gpio_config
{
    int gnum;
    gnum = of_get_named_gpio_flags(np, name, 0, 
                (enum of_gpio_flags *)gc);  // ← 强制转换
    // ...
}
```

---

### 2️⃣ **Sunxi 为什么要自己设计这个框架？**

#### **原因 1：历史遗留 - sys_config 时代** 📜

**早期 Allwinner 使用 sys_config.fex 配置系统：**

```ini
[gpio_para]
gpio_used = 1
gpio_num = 10
gpio_pin_1 = port:PB01<1><default><default><1>
           #      ^^^^ ^ ^^^^^^^ ^^^^^^^ ^
           #      pin  功能 上下拉  驱动能力 初始值
```

这种配置方式需要：
- 功能复用（0-7）
- 上下拉（0-2）
- 驱动能力（0-3）
- 初始数据值

**迁移到设备树时，Allwinner 保留了这种配置能力！**

#### **原因 2：硬件复杂性 - 需要精细控制** 🔧

**Allwinner SoC 的 GPIO 控制器非常复杂：**

| 配置项 | 标准 Linux | Sunxi 扩展 | 用途 |
|--------|-----------|-----------|------|
| Pin 编号 | ✅ | ✅ | 基本功能 |
| Active Low/High | ✅ | ✅ | 极性控制 |
| **功能复用** | ❌ | ✅ | GPIO/UART/SPI/I2C 等 |
| **上下拉** | ❌ | ✅ | 信号稳定性 |
| **驱动能力** | ❌ | ✅ | 10/20/30/40mA |
| **初始电平** | ❌ | ✅ | 启动时状态 |

**实际应用场景：**

```dts
// 高速 SPI 显示屏 - 需要强驱动能力
spi_pins: spi-pins {
    reset = <&pio 1 10 1 1 3 1>;  // 40mA 驱动，上拉
    dc    = <&pio 1 11 1 1 3 0>;  // 40mA 驱动，上拉
    //                    ^ ← 驱动能力 3 = 40mA（高速信号）
};

// 低功耗按键 - 使用弱驱动
button_pins: button-pins {
    key = <&pio 2 5 0 1 0 0>;  // 10mA 驱动，上拉，输入
    //                 ^ ← 驱动能力 0 = 10mA（省电）
};
```

#### **原因 3：兼容性 - 避免破坏现有生态** 🌍

Allwinner 有庞大的生态系统：
- 数百款开发板
- 数千个产品
- 大量的 BSP 代码

**如果改用标准格式：**
- ❌ 所有设备树需要重写
- ❌ 所有驱动需要修改
- ❌ 现有产品无法升级内核
- ❌ 开发者需要重新学习

**保持扩展格式：**
- ✅ 向后兼容
- ✅ 功能完整
- ✅ 生态稳定

---

### 3️⃣ **Sunxi 框架的优缺点**

#### **优点：** ✅

1. **功能强大** - 可以精确控制所有 GPIO 特性
2. **向后兼容** - 与 sys_config 时代保持一致
3. **生态稳定** - 不破坏现有代码
4. **硬件优化** - 充分利用硬件能力

#### **缺点：** ❌

1. **与主线不兼容** - 主线驱动需要适配
2. **学习成本高** - 开发者需要了解 Sunxi 特性
3. **维护负担重** - 每个主线驱动都要打补丁
4. **上游困难** - 难以合并到 Linux 主线

---

### 4️⃣ **业界对比**

| 厂商 | GPIO 参数数量 | 策略 |
|------|-------------|------|
| **Allwinner (Sunxi)** | 6 个参数 | 扩展格式，功能完整 |
| **Rockchip** | 2-3 个参数 | 标准格式 + pinctrl 子系统 |
| **NXP i.MX** | 2-3 个参数 | 标准格式 + pinctrl 子系统 |
| **Qualcomm** | 2-3 个参数 | 标准格式 + pinctrl 子系统 |

**其他厂商的做法：**

```dts
// Rockchip - 使用 pinctrl 子系统分离配置
&spi0 {
    pinctrl-names = "default";
    pinctrl-0 = <&spi0_pins>;  // ← 引用 pinctrl 配置
    
    reset-gpios = <&gpio1 10 GPIO_ACTIVE_LOW>;  // ← 标准格式
};

&pinctrl {
    spi0_pins: spi0-pins {
        rockchip,pins = <1 10 RK_FUNC_GPIO &pcfg_pull_up>;
        //                    ^^^^^^^^^^^^ ^^^^^^^^^^^^^^
        //                    功能复用      上下拉配置
    };
};
```

**Sunxi 的做法：**

```dts
// Sunxi - 所有配置在一起
&spi0 {
    reset = <&pio 1 10 1 1 3 1>;  // ← 一次性配置所有参数
    //              功能 拉 驱动 数据
};
```

---

### 5️⃣ **总结**

#### **为什么 Sunxi 要这样设计？**

1. **历史原因** - 从 sys_config 迁移，保持兼容性
2. **硬件需求** - GPIO 控制器功能丰富，需要精细配置
3. **生态考虑** - 避免破坏现有的庞大生态系统
4. **实用主义** - 简化配置，一次性设置所有参数

#### **是否需要适配所有主线驱动？**

**是的！** 但 Allwinner 已经做了大量工作：
- ✅ 修改了 `gpiolib-of.c` 核心代码
- ✅ 适配了自己的驱动（摄像头、触摸屏等）
- ⚠️ 第三方驱动（如 fbtft）需要手动适配

#### **最佳实践：**

对于 **Sunxi 平台开发者**：
- ✅ 接受并使用 Sunxi 的 6 参数格式
- ✅ 按照补丁模式适配第三方驱动
- ✅ 充分利用硬件的精细控制能力

对于 **跨平台驱动开发者**：
- 🤔 考虑添加 `#ifdef CONFIG_ARCH_SUNXI` 条件编译
- 🤔 或者要求用户打补丁
- 🤔 或者只支持标准平台

**这就是 Sunxi 生态的现状 - 功能强大但需要适配！** 🎯

```c
/*In sunxi platform, if the pin property is set 'default' by
 * sys_config,the param and arg will be zero, and then
 * sunxi_pconf_reg() will return -ENOTSUPP, we didn't handle
 * this fault before we abondon the old configurate ways by
 * sys_config, so return  0 now*/
```

```shellscript
✅ 已适配的驱动（部分列表）：
- 触摸屏：focaltech, tlsc6x, it7257
- 摄像头：sunxi-vin, sensor_power, tvd
- 输入设备：GPIO 红外, 霍尔传感器
- 电源：充电器, 电池驱动
- 显示：fbtft（正在适配）
```

```c
// Sunxi 自己的驱动都这样写
static int sensor_get_gpio_info(struct device_node *np, const char *name,
                struct gpio_config *gc)  // ← 使用 gpio_config
{
    int gnum;
    gnum = of_get_named_gpio_flags(np, name, 0, 
                (enum of_gpio_flags *)gc);  // ← 强制转换
    // ...
}
```

```c
/*In sunxi platform, if the pin property is set 'default' by
 * sys_config,the param and arg will be zero, and then
 * sunxi_pconf_reg() will return -ENOTSUPP, we didn't handle
 * this fault before we abondon the old configurate ways by
 * sys_config, so return  0 now*/
```

```shellscript
✅ 已适配的驱动（部分列表）：
- 触摸屏：focaltech, tlsc6x, it7257
- 摄像头：sunxi-vin, sensor_power, tvd
- 输入设备：GPIO 红外, 霍尔传感器
- 电源：充电器, 电池驱动
- 显示：fbtft（正在适配）
```

```c
// Sunxi 自己的驱动都这样写
static int sensor_get_gpio_info(struct device_node *np, const char *name,
                struct gpio_config *gc)  // ← 使用 gpio_config
{
    int gnum;
    gnum = of_get_named_gpio_flags(np, name, 0, 
                (enum of_gpio_flags *)gc);  // ← 强制转换
    // ...
}
```

```ini
[gpio_para]
gpio_used = 1
gpio_num = 10
gpio_pin_1 = port:PB01<1><default><default><1>
           #      ^^^^ ^ ^^^^^^^ ^^^^^^^ ^
           #      pin  功能 上下拉  驱动能力 初始值
```

```dts
// 高速 SPI 显示屏 - 需要强驱动能力
spi_pins: spi-pins {
    reset = <&pio 1 10 1 1 3 1>;  // 40mA 驱动，上拉
    dc    = <&pio 1 11 1 1 3 0>;  // 40mA 驱动，上拉
    //                    ^ ← 驱动能力 3 = 40mA（高速信号）
};

// 低功耗按键 - 使用弱驱动
button_pins: button-pins {
    key = <&pio 2 5 0 1 0 0>;  // 10mA 驱动，上拉，输入
    //                 ^ ← 驱动能力 0 = 10mA（省电）
};
```

```dts
// Rockchip - 使用 pinctrl 子系统分离配置
&spi0 {
    pinctrl-names = "default";
    pinctrl-0 = <&spi0_pins>;  // ← 引用 pinctrl 配置
    
    reset-gpios = <&gpio1 10 GPIO_ACTIVE_LOW>;  // ← 标准格式
};

&pinctrl {
    spi0_pins: spi0-pins {
        rockchip,pins = <1 10 RK_FUNC_GPIO &pcfg_pull_up>;
        //                    ^^^^^^^^^^^^ ^^^^^^^^^^^^^^
        //                    功能复用      上下拉配置
    };
};
```

```dts
// Sunxi - 所有配置在一起
&spi0 {
    reset = <&pio 1 10 1 1 3 1>;  // ← 一次性配置所有参数
    //              功能 拉 驱动 数据
};
```

---

**User**

 触摸屏：focaltech, tlsc6x, it7257

- 输入设备：GPIO 红外, 霍尔传感器

适配好的在哪里

---

**Cursor**

好问题！让我帮您找到这些已经适配好的驱动代码，看看它们是如何处理 Sunxi GPIO 的。

太好了！我找到了！让我给您展示已经适配好的驱动在哪里，以及它们是如何处理的：

## 📍 **已适配驱动的位置和代码示例**

### 1️⃣ **Focaltech 触摸屏驱动**（您正在查看的文件）

**位置：**
```
/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/linux-4.9/drivers/input/touchscreen/focaltech_touch/focaltech_core.c
```

**关键代码（第 2166-2175 行）：**

```c
/* reset, irq gpio info */
pdata->reset_gpio = of_get_named_gpio_flags(np, "focaltech,reset-gpio",
                    0, &pdata->reset_gpio_flags);
if (pdata->reset_gpio < 0)
    FTS_ERROR("Unable to get reset_gpio");

pdata->irq_gpio = of_get_named_gpio_flags(np, "focaltech,irq-gpio",
                  0, &pdata->irq_gpio_flags);
if (pdata->irq_gpio < 0)
    FTS_ERROR("Unable to get irq_gpio");
```

**注意：** ⚠️ **这个驱动还没有完全适配！**

它仍然使用标准的 `enum of_gpio_flags`，没有使用 `struct gpio_config`。这意味着：
- ✅ 可以工作（因为 sunxi 做了兼容处理）
- ❌ 但无法使用 sunxi 的扩展功能（上下拉、驱动能力等）

---

### 2️⃣ **Sunxi 摄像头传感器电源驱动**（完全适配）

**位置：**
```bash
/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor_power/sensor_power.c
```

让我查看这个文件：

```plaintext
/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/linux-4.9/drivers/input/touchscreen/focaltech_touch/focaltech_core.c
```

```c
/* reset, irq gpio info */
pdata->reset_gpio = of_get_named_gpio_flags(np, "focaltech,reset-gpio",
                    0, &pdata->reset_gpio_flags);
if (pdata->reset_gpio < 0)
    FTS_ERROR("Unable to get reset_gpio");

pdata->irq_gpio = of_get_named_gpio_flags(np, "focaltech,irq-gpio",
                  0, &pdata->irq_gpio_flags);
if (pdata->irq_gpio < 0)
    FTS_ERROR("Unable to get irq_gpio");
```

```shellscript
/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor_power/sensor_power.c
```

完美！现在我可以给您一个完整的对比和总结了：

## 📊 **已适配驱动的完整对比**

### ✅ **完全适配的驱动示例：Sunxi 摄像头传感器电源驱动**

**位置：**
```
/lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor_power/sensor_power.c
```

**关键适配代码（第 68-78 行）：**

```c
static int sensor_get_gpio_info(struct device_node *np, const char *name,
                 struct gpio_config *gc)  // ← 使用 struct gpio_config
{
    int gnum;

    gnum = of_get_named_gpio_flags(np, name, 0, (enum of_gpio_flags *)gc);
    //                                          ^^^^^^^^^^^^^^^^^^^^^^^^
    //                                          强制转换为 gpio_config
    if (!gpio_is_valid(gnum)) {
        gc->gpio = GPIO_INDEX_INVALID;
        sensor_power_dbg("fetch %s from device_tree failed\n", name);
        return -EINVAL;
    }

    return 0;
}
```

**如何使用 gpio_config（第 80-125 行）：**

```c
static int sensor_os_gpio_set(struct gpio_config *gc)
{
    char pin_name[32];
    __u32 config;

    if (gc == NULL)
        return -1;
    if (gc->gpio == GPIO_INDEX_INVALID)
        return -1;

    if (!IS_AXP_PIN(gc->gpio)) {
        sunxi_gpio_to_name(gc->gpio, pin_name);
        
        // 设置功能复用
        config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_FUNC, gc->mul_sel);
        pin_config_set(SUNXI_PINCTRL, pin_name, config);
        
        // 设置上下拉
        if (gc->pull != GPIO_PULL_DEFAULT) {
            config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_PUD, gc->pull);
            pin_config_set(SUNXI_PINCTRL, pin_name, config);
        }
        
        // 设置驱动能力
        if (gc->drv_level != GPIO_DRVLVL_DEFAULT) {
            config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DRV, gc->drv_level);
            pin_config_set(SUNXI_PINCTRL, pin_name, config);
        }
        
        // 设置初始数据
        if (gc->data != GPIO_DATA_DEFAULT) {
            config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DAT, gc->data);
            pin_config_set(SUNXI_PINCTRL, pin_name, config);
        }
    }
    return 0;
}
```

---

### ⚠️ **未完全适配的驱动：Focaltech 触摸屏**

**位置：**
```
/lichee/linux-4.9/drivers/input/touchscreen/focaltech_touch/focaltech_core.c
```

**问题代码（第 2166-2175 行）：**

```c
/* reset, irq gpio info */
pdata->reset_gpio = of_get_named_gpio_flags(np, "focaltech,reset-gpio",
                    0, &pdata->reset_gpio_flags);
//                     ^^^^^^^^^^^^^^^^^^^^^^
//                     仍然使用 enum of_gpio_flags，没有用 struct gpio_config

pdata->irq_gpio = of_get_named_gpio_flags(np, "focaltech,irq-gpio",
                  0, &pdata->irq_gpio_flags);
```

**为什么还能工作？**

因为 Sunxi 在 `gpiolib-of.c` 中做了兼容处理，会自动将 `gpio_config.data` 字段的值赋给标准的 `of_flags`。

---

## 📁 **其他已适配驱动的位置**

让我搜索更多已适配的驱动：

```plaintext
/lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor_power/sensor_power.c
```

```c
static int sensor_get_gpio_info(struct device_node *np, const char *name,
                 struct gpio_config *gc)  // ← 使用 struct gpio_config
{
    int gnum;

    gnum = of_get_named_gpio_flags(np, name, 0, (enum of_gpio_flags *)gc);
    //                                          ^^^^^^^^^^^^^^^^^^^^^^^^
    //                                          强制转换为 gpio_config
    if (!gpio_is_valid(gnum)) {
        gc->gpio = GPIO_INDEX_INVALID;
        sensor_power_dbg("fetch %s from device_tree failed\n", name);
        return -EINVAL;
    }

    return 0;
}
```

```c
static int sensor_os_gpio_set(struct gpio_config *gc)
{
    char pin_name[32];
    __u32 config;

    if (gc == NULL)
        return -1;
    if (gc->gpio == GPIO_INDEX_INVALID)
        return -1;

    if (!IS_AXP_PIN(gc->gpio)) {
        sunxi_gpio_to_name(gc->gpio, pin_name);
        
        // 设置功能复用
        config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_FUNC, gc->mul_sel);
        pin_config_set(SUNXI_PINCTRL, pin_name, config);
        
        // 设置上下拉
        if (gc->pull != GPIO_PULL_DEFAULT) {
            config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_PUD, gc->pull);
            pin_config_set(SUNXI_PINCTRL, pin_name, config);
        }
        
        // 设置驱动能力
        if (gc->drv_level != GPIO_DRVLVL_DEFAULT) {
            config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DRV, gc->drv_level);
            pin_config_set(SUNXI_PINCTRL, pin_name, config);
        }
        
        // 设置初始数据
        if (gc->data != GPIO_DATA_DEFAULT) {
            config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DAT, gc->data);
            pin_config_set(SUNXI_PINCTRL, pin_name, config);
        }
    }
    return 0;
}
```

```plaintext
/lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor_power/sensor_power.c
```

```c
static int sensor_get_gpio_info(struct device_node *np, const char *name,
                 struct gpio_config *gc)  // ← 使用 struct gpio_config
{
    int gnum;

    gnum = of_get_named_gpio_flags(np, name, 0, (enum of_gpio_flags *)gc);
    //                                          ^^^^^^^^^^^^^^^^^^^^^^^^
    //                                          强制转换为 gpio_config
    if (!gpio_is_valid(gnum)) {
        gc->gpio = GPIO_INDEX_INVALID;
        sensor_power_dbg("fetch %s from device_tree failed\n", name);
        return -EINVAL;
    }

    return 0;
}
```

```c
static int sensor_os_gpio_set(struct gpio_config *gc)
{
    char pin_name[32];
    __u32 config;

    if (gc == NULL)
        return -1;
    if (gc->gpio == GPIO_INDEX_INVALID)
        return -1;

    if (!IS_AXP_PIN(gc->gpio)) {
        sunxi_gpio_to_name(gc->gpio, pin_name);
        
        // 设置功能复用
        config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_FUNC, gc->mul_sel);
        pin_config_set(SUNXI_PINCTRL, pin_name, config);
        
        // 设置上下拉
        if (gc->pull != GPIO_PULL_DEFAULT) {
            config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_PUD, gc->pull);
            pin_config_set(SUNXI_PINCTRL, pin_name, config);
        }
        
        // 设置驱动能力
        if (gc->drv_level != GPIO_DRVLVL_DEFAULT) {
            config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DRV, gc->drv_level);
            pin_config_set(SUNXI_PINCTRL, pin_name, config);
        }
        
        // 设置初始数据
        if (gc->data != GPIO_DATA_DEFAULT) {
            config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DAT, gc->data);
            pin_config_set(SUNXI_PINCTRL, pin_name, config);
        }
    }
    return 0;
}
```

```plaintext
/lichee/linux-4.9/drivers/input/touchscreen/focaltech_touch/focaltech_core.c
```

```c
/* reset, irq gpio info */
pdata->reset_gpio = of_get_named_gpio_flags(np, "focaltech,reset-gpio",
                    0, &pdata->reset_gpio_flags);
//                     ^^^^^^^^^^^^^^^^^^^^^^
//                     仍然使用 enum of_gpio_flags，没有用 struct gpio_config

pdata->irq_gpio = of_get_named_gpio_flags(np, "focaltech,irq-gpio",
                  0, &pdata->irq_gpio_flags);
```

完美！现在我可以给您一个完整的总结了：

## 📋 **已适配驱动的完整列表和位置**

### ✅ **完全适配的驱动（使用 `struct gpio_config`）**

| 驱动类型 | 文件路径 | 说明 |
|---------|---------|------|
| **摄像头** | `/drivers/media/platform/sunxi-vin/modules/sensor_power/sensor_power.c` | ✅ 完美适配 |
| **摄像头** | `/drivers/media/platform/sunxi-vin/utility/config.c` | ✅ 完美适配 |
| **摄像头** | `/drivers/media/platform/sunxi-vin/utility/vin_os.c` | ✅ 完美适配 |
| **摄像头** | `/drivers/media/platform/sunxi-vfe/config.c` | ✅ 完美适配 |
| **摄像头传感器** | `/drivers/media/platform/sunxi-vin/modules/sensor/tp9950.c` | ✅ 完美适配 |
| **视频输入** | `/drivers/media/platform/sunxi-tvd/tvd.c` | ✅ 完美适配 |
| **红外接收** | `/drivers/media/rc/sunxi-gpio-ir.c` | ✅ 完美适配 |
| **红外接收** | `/drivers/input/keyboard/sunxi-gpio-ir-rx.c` | ✅ 完美适配 |
| **红外发射** | `/drivers/input/keyboard/sunxi-gpio-ir-tx.c` | ✅ 完美适配 |
| **霍尔传感器** | `/drivers/input/misc/hall_och175.c` | ✅ 完美适配 |
| **GPIO 按键** | `/drivers/input/keyboard/gpio_keys.c` | ✅ 完美适配 |
| **加速度传感器** | `/drivers/input/sensor/bma253/bma2x2.c` | ✅ 完美适配 |
| **接近传感器** | `/drivers/input/misc/stk3x1x.c` | ✅ 完美适配 |
| **电池驱动** | `/drivers/power/supply/cw2015_battery.c` | ✅ 完美适配 |
| **充电器** | `/drivers/power/supply/sy6974_charger.c` | ✅ 完美适配 |
| **AXP GPIO** | `/drivers/power/supply/axp/axp-gpio.c` | ✅ 完美适配 |
| **AXP GPIO 电源** | `/drivers/power/supply/axp2202_gpio_power.c` | ✅ 完美适配 |

---

## 🔍 **适配模式对比**

### **模式 1：完全适配（推荐）** ✅

**示例：sensor_power.c**

```c
// 1. 使用 struct gpio_config
static int sensor_get_gpio_info(struct device_node *np, const char *name,
                 struct gpio_config *gc)
{
    int gnum;
    gnum = of_get_named_gpio_flags(np, name, 0, (enum of_gpio_flags *)gc);
    // ...
}

// 2. 充分利用所有配置
static int sensor_os_gpio_set(struct gpio_config *gc)
{
    // 设置功能复用
    config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_FUNC, gc->mul_sel);
    pin_config_set(SUNXI_PINCTRL, pin_name, config);
    
    // 设置上下拉
    config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_PUD, gc->pull);
    pin_config_set(SUNXI_PINCTRL, pin_name, config);
    
    // 设置驱动能力
    config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DRV, gc->drv_level);
    pin_config_set(SUNXI_PINCTRL, pin_name, config);
    
    // 设置初始数据
    config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DAT, gc->data);
    pin_config_set(SUNXI_PINCTRL, pin_name, config);
}

// 3. 设备树使用 6 参数格式
sensor0_reset = <&pio 4 16 1 1 2 1>;  // PE16, 输出, 上拉, 30mA, 高电平
```

**优点：**
- ✅ 功能完整
- ✅ 可精确控制硬件
- ✅ 性能最优

---

### **模式 2：部分适配（兼容）** ⚠️

**示例：focaltech_core.c**

```c
// 仍然使用标准格式
pdata->reset_gpio = of_get_named_gpio_flags(np, "focaltech,reset-gpio",
                    0, &pdata->reset_gpio_flags);
//                     ^^^^^^^^^^^^^^^^^^^^^^
//                     enum of_gpio_flags（标准格式）

// 设备树也用标准格式
focaltech,reset-gpio = <&pio 1 10 GPIO_ACTIVE_LOW>;
```

**优点：**
- ✅ 可以工作（Sunxi 做了兼容）
- ✅ 代码简单

**缺点：**
- ❌ 无法使用扩展功能
- ❌ 无法精确控制硬件特性

---

## 📝 **如何查看具体的适配代码**

让我给您展示一个红外接收驱动的例子：

```c
// 1. 使用 struct gpio_config
static int sensor_get_gpio_info(struct device_node *np, const char *name,
                 struct gpio_config *gc)
{
    int gnum;
    gnum = of_get_named_gpio_flags(np, name, 0, (enum of_gpio_flags *)gc);
    // ...
}

// 2. 充分利用所有配置
static int sensor_os_gpio_set(struct gpio_config *gc)
{
    // 设置功能复用
    config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_FUNC, gc->mul_sel);
    pin_config_set(SUNXI_PINCTRL, pin_name, config);
    
    // 设置上下拉
    config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_PUD, gc->pull);
    pin_config_set(SUNXI_PINCTRL, pin_name, config);
    
    // 设置驱动能力
    config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DRV, gc->drv_level);
    pin_config_set(SUNXI_PINCTRL, pin_name, config);
    
    // 设置初始数据
    config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DAT, gc->data);
    pin_config_set(SUNXI_PINCTRL, pin_name, config);
}

// 3. 设备树使用 6 参数格式
sensor0_reset = <&pio 4 16 1 1 2 1>;  // PE16, 输出, 上拉, 30mA, 高电平
```

```c
// 仍然使用标准格式
pdata->reset_gpio = of_get_named_gpio_flags(np, "focaltech,reset-gpio",
                    0, &pdata->reset_gpio_flags);
//                     ^^^^^^^^^^^^^^^^^^^^^^
//                     enum of_gpio_flags（标准格式）

// 设备树也用标准格式
focaltech,reset-gpio = <&pio 1 10 GPIO_ACTIVE_LOW>;
```

```c
// 1. 使用 struct gpio_config
static int sensor_get_gpio_info(struct device_node *np, const char *name,
                 struct gpio_config *gc)
{
    int gnum;
    gnum = of_get_named_gpio_flags(np, name, 0, (enum of_gpio_flags *)gc);
    // ...
}

// 2. 充分利用所有配置
static int sensor_os_gpio_set(struct gpio_config *gc)
{
    // 设置功能复用
    config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_FUNC, gc->mul_sel);
    pin_config_set(SUNXI_PINCTRL, pin_name, config);
    
    // 设置上下拉
    config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_PUD, gc->pull);
    pin_config_set(SUNXI_PINCTRL, pin_name, config);
    
    // 设置驱动能力
    config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DRV, gc->drv_level);
    pin_config_set(SUNXI_PINCTRL, pin_name, config);
    
    // 设置初始数据
    config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DAT, gc->data);
    pin_config_set(SUNXI_PINCTRL, pin_name, config);
}

// 3. 设备树使用 6 参数格式
sensor0_reset = <&pio 4 16 1 1 2 1>;  // PE16, 输出, 上拉, 30mA, 高电平
```

```c
// 仍然使用标准格式
pdata->reset_gpio = of_get_named_gpio_flags(np, "focaltech,reset-gpio",
                    0, &pdata->reset_gpio_flags);
//                     ^^^^^^^^^^^^^^^^^^^^^^
//                     enum of_gpio_flags（标准格式）

// 设备树也用标准格式
focaltech,reset-gpio = <&pio 1 10 GPIO_ACTIVE_LOW>;
```

完美！现在我可以给您一个完整的总结了：

## 📊 **完整总结：已适配驱动的位置和代码模式**

### 🎯 **红外接收驱动适配示例**

**位置：**
```
/lichee/linux-4.9/drivers/input/keyboard/sunxi-gpio-ir-rx.c
```

**适配代码：**

```c
struct gpio_config config;  // ← 定义 gpio_config 结构

// 使用强制转换获取 GPIO 配置
rx_info->ir_rx_gpio = of_get_named_gpio_flags(dev->of_node,
                "gpio-rx", 0,
                (enum of_gpio_flags *)&config);  // ← 强制转换
//              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//              将 gpio_config 指针转换为 of_gpio_flags 指针
```

---

## 📁 **完整的已适配驱动列表**

### **1. 摄像头相关（7 个驱动）** 📷

```bash
✅ /drivers/media/platform/sunxi-vin/modules/sensor_power/sensor_power.c
✅ /drivers/media/platform/sunxi-vin/utility/config.c
✅ /drivers/media/platform/sunxi-vin/utility/vin_os.c
✅ /drivers/media/platform/sunxi-vin/utility/vin_supply.c
✅ /drivers/media/platform/sunxi-vin/vin.c
✅ /drivers/media/platform/sunxi-vfe/config.c
✅ /drivers/media/platform/sunxi-vfe/vfe_os.c
✅ /drivers/media/platform/sunxi-vin/modules/sensor/tp9950.c
✅ /drivers/media/platform/sunxi-tvd/tvd.c
```

### **2. 输入设备（6 个驱动）** ⌨️

```bash
✅ /drivers/input/keyboard/sunxi-gpio-ir-rx.c      # GPIO 红外接收
✅ /drivers/input/keyboard/sunxi-gpio-ir-tx.c      # GPIO 红外发射
✅ /drivers/media/rc/sunxi-gpio-ir.c               # 红外遥控
✅ /drivers/input/keyboard/gpio_keys.c             # GPIO 按键
✅ /drivers/input/misc/hall_och175.c               # 霍尔传感器
✅ /drivers/input/sensor/bma253/bma2x2.c           # 加速度传感器
✅ /drivers/input/misc/stk3x1x.c                   # 接近传感器
```

### **3. 电源管理（4 个驱动）** 🔋

```bash
✅ /drivers/power/supply/cw2015_battery.c          # 电池驱动
✅ /drivers/power/supply/sy6974_charger.c          # 充电器
✅ /drivers/power/supply/axp/axp-gpio.c            # AXP GPIO
✅ /drivers/power/supply/axp2202_gpio_power.c      # AXP GPIO 电源
```

### **4. 触摸屏（部分适配）** 👆

```bash
⚠️ /drivers/input/touchscreen/focaltech_touch/focaltech_core.c  # 未完全适配
⚠️ /drivers/input/touchscreen/tlsc6x/tlsc6x_main.c              # 未完全适配
⚠️ /drivers/input/touchscreen/it7257_ts.c                       # 未完全适配
```

---

## 🔧 **标准适配模板**

基于已适配驱动的分析，这是标准的适配模板：

### **步骤 1：包含头文件**

```c
#include <linux/of_gpio.h>
#include <linux/sunxi-gpio.h>  // ← 添加这个
```

### **步骤 2：定义 gpio_config 变量**

```c
struct gpio_config gpio_cfg;  // 替代 enum of_gpio_flags
```

### **步骤 3：获取 GPIO 配置**

```c
gpio_num = of_get_named_gpio_flags(np, "gpio-name", 0,
                (enum of_gpio_flags *)&gpio_cfg);
//              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//              强制转换为 gpio_config 指针
```

### **步骤 4：使用扩展配置（可选）**

```c
// 如果需要精确控制，可以使用 pinctrl 子系统
char pin_name[32];
u32 config;

sunxi_gpio_to_name(gpio_cfg.gpio, pin_name);

// 设置功能
config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_FUNC, gpio_cfg.mul_sel);
pin_config_set(SUNXI_PINCTRL, pin_name, config);

// 设置上下拉
config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_PUD, gpio_cfg.pull);
pin_config_set(SUNXI_PINCTRL, pin_name, config);

// 设置驱动能力
config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DRV, gpio_cfg.drv_level);
pin_config_set(SUNXI_PINCTRL, pin_name, config);
```

### **步骤 5：设备树配置**

```dts
&device {
    gpio-name = <&pio 1 10 1 1 2 1>;
    //          控制器 bank pin func pull drive data
    //          &pio   1    10  1    1    2     1
    //                 PB   10  输出 上拉 30mA  高电平
};
```

---

## 💡 **快速参考：6 个参数的含义**

```dts
gpio-name = <&pio  bank  pin  function  pull  drive  data>;
//          ^^^^   ^^^^  ^^^  ^^^^^^^^  ^^^^  ^^^^^  ^^^^
//          控制器  组    编号  功能复用  上下拉 驱动力 初始值

// 示例：
reset = <&pio 1 10 1 1 2 1>;
//      PB10, 输出模式, 上拉, 30mA驱动, 初始高电平
```

**参数详解：**
- **bank**: 0=PA, 1=PB, 2=PC, 3=PD, 4=PE, ...
- **pin**: 0-31（每组最多32个引脚）
- **function**: 0=输入, 1=输出, 2-7=特殊功能
- **pull**: 0=禁用, 1=上拉, 2=下拉
- **drive**: 0=10mA, 1=20mA, 2=30mA, 3=40mA
- **data**: 0=低电平, 1=高电平

---

## 🎓 **总结**

1. **已适配驱动数量**：约 **20+ 个驱动**已完全适配
2. **主要类别**：摄像头、输入设备、电源管理
3. **适配模式**：使用 `struct gpio_config` + 强制转换
4. **最佳实践**：参考 `sensor_power.c` 的完整实现

**对于 fbtft 驱动，您应该参考 `sensor_power.c` 的适配方式！** ✅

```plaintext
/lichee/linux-4.9/drivers/input/keyboard/sunxi-gpio-ir-rx.c
```

```c
struct gpio_config config;  // ← 定义 gpio_config 结构

// 使用强制转换获取 GPIO 配置
rx_info->ir_rx_gpio = of_get_named_gpio_flags(dev->of_node,
                "gpio-rx", 0,
                (enum of_gpio_flags *)&config);  // ← 强制转换
//              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//              将 gpio_config 指针转换为 of_gpio_flags 指针
```

```shellscript
✅ /drivers/media/platform/sunxi-vin/modules/sensor_power/sensor_power.c
✅ /drivers/media/platform/sunxi-vin/utility/config.c
✅ /drivers/media/platform/sunxi-vin/utility/vin_os.c
✅ /drivers/media/platform/sunxi-vin/utility/vin_supply.c
✅ /drivers/media/platform/sunxi-vin/vin.c
✅ /drivers/media/platform/sunxi-vfe/config.c
✅ /drivers/media/platform/sunxi-vfe/vfe_os.c
✅ /drivers/media/platform/sunxi-vin/modules/sensor/tp9950.c
✅ /drivers/media/platform/sunxi-tvd/tvd.c
```

```shellscript
✅ /drivers/input/keyboard/sunxi-gpio-ir-rx.c      # GPIO 红外接收
✅ /drivers/input/keyboard/sunxi-gpio-ir-tx.c      # GPIO 红外发射
✅ /drivers/media/rc/sunxi-gpio-ir.c               # 红外遥控
✅ /drivers/input/keyboard/gpio_keys.c             # GPIO 按键
✅ /drivers/input/misc/hall_och175.c               # 霍尔传感器
✅ /drivers/input/sensor/bma253/bma2x2.c           # 加速度传感器
✅ /drivers/input/misc/stk3x1x.c                   # 接近传感器
```

```shellscript
✅ /drivers/power/supply/cw2015_battery.c          # 电池驱动
✅ /drivers/power/supply/sy6974_charger.c          # 充电器
✅ /drivers/power/supply/axp/axp-gpio.c            # AXP GPIO
✅ /drivers/power/supply/axp2202_gpio_power.c      # AXP GPIO 电源
```

```shellscript
⚠️ /drivers/input/touchscreen/focaltech_touch/focaltech_core.c  # 未完全适配
⚠️ /drivers/input/touchscreen/tlsc6x/tlsc6x_main.c              # 未完全适配
⚠️ /drivers/input/touchscreen/it7257_ts.c                       # 未完全适配
```

```c
#include <linux/of_gpio.h>
#include <linux/sunxi-gpio.h>  // ← 添加这个
```

```c
struct gpio_config gpio_cfg;  // 替代 enum of_gpio_flags
```

```c
gpio_num = of_get_named_gpio_flags(np, "gpio-name", 0,
                (enum of_gpio_flags *)&gpio_cfg);
//              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//              强制转换为 gpio_config 指针
```

```c
// 如果需要精确控制，可以使用 pinctrl 子系统
char pin_name[32];
u32 config;

sunxi_gpio_to_name(gpio_cfg.gpio, pin_name);

// 设置功能
config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_FUNC, gpio_cfg.mul_sel);
pin_config_set(SUNXI_PINCTRL, pin_name, config);

// 设置上下拉
config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_PUD, gpio_cfg.pull);
pin_config_set(SUNXI_PINCTRL, pin_name, config);

// 设置驱动能力
config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DRV, gpio_cfg.drv_level);
pin_config_set(SUNXI_PINCTRL, pin_name, config);
```

```plaintext
/lichee/linux-4.9/drivers/input/keyboard/sunxi-gpio-ir-rx.c
```

```c
struct gpio_config config;  // ← 定义 gpio_config 结构

// 使用强制转换获取 GPIO 配置
rx_info->ir_rx_gpio = of_get_named_gpio_flags(dev->of_node,
                "gpio-rx", 0,
                (enum of_gpio_flags *)&config);  // ← 强制转换
//              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//              将 gpio_config 指针转换为 of_gpio_flags 指针
```

```shellscript
✅ /drivers/media/platform/sunxi-vin/modules/sensor_power/sensor_power.c
✅ /drivers/media/platform/sunxi-vin/utility/config.c
✅ /drivers/media/platform/sunxi-vin/utility/vin_os.c
✅ /drivers/media/platform/sunxi-vin/utility/vin_supply.c
✅ /drivers/media/platform/sunxi-vin/vin.c
✅ /drivers/media/platform/sunxi-vfe/config.c
✅ /drivers/media/platform/sunxi-vfe/vfe_os.c
✅ /drivers/media/platform/sunxi-vin/modules/sensor/tp9950.c
✅ /drivers/media/platform/sunxi-tvd/tvd.c
```

```shellscript
✅ /drivers/input/keyboard/sunxi-gpio-ir-rx.c      # GPIO 红外接收
✅ /drivers/input/keyboard/sunxi-gpio-ir-tx.c      # GPIO 红外发射
✅ /drivers/media/rc/sunxi-gpio-ir.c               # 红外遥控
✅ /drivers/input/keyboard/gpio_keys.c             # GPIO 按键
✅ /drivers/input/misc/hall_och175.c               # 霍尔传感器
✅ /drivers/input/sensor/bma253/bma2x2.c           # 加速度传感器
✅ /drivers/input/misc/stk3x1x.c                   # 接近传感器
```

```shellscript
✅ /drivers/power/supply/cw2015_battery.c          # 电池驱动
✅ /drivers/power/supply/sy6974_charger.c          # 充电器
✅ /drivers/power/supply/axp/axp-gpio.c            # AXP GPIO
✅ /drivers/power/supply/axp2202_gpio_power.c      # AXP GPIO 电源
```

```shellscript
⚠️ /drivers/input/touchscreen/focaltech_touch/focaltech_core.c  # 未完全适配
⚠️ /drivers/input/touchscreen/tlsc6x/tlsc6x_main.c              # 未完全适配
⚠️ /drivers/input/touchscreen/it7257_ts.c                       # 未完全适配
```

```c
#include <linux/of_gpio.h>
#include <linux/sunxi-gpio.h>  // ← 添加这个
```

```c
struct gpio_config gpio_cfg;  // 替代 enum of_gpio_flags
```

```c
gpio_num = of_get_named_gpio_flags(np, "gpio-name", 0,
                (enum of_gpio_flags *)&gpio_cfg);
//              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//              强制转换为 gpio_config 指针
```

```c
// 如果需要精确控制，可以使用 pinctrl 子系统
char pin_name[32];
u32 config;

sunxi_gpio_to_name(gpio_cfg.gpio, pin_name);

// 设置功能
config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_FUNC, gpio_cfg.mul_sel);
pin_config_set(SUNXI_PINCTRL, pin_name, config);

// 设置上下拉
config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_PUD, gpio_cfg.pull);
pin_config_set(SUNXI_PINCTRL, pin_name, config);

// 设置驱动能力
config = SUNXI_PINCFG_PACK(SUNXI_PINCFG_TYPE_DRV, gpio_cfg.drv_level);
pin_config_set(SUNXI_PINCTRL, pin_name, config);
```

```dts
&device {
    gpio-name = <&pio 1 10 1 1 2 1>;
    //          控制器 bank pin func pull drive data
    //          &pio   1    10  1    1    2     1
    //                 PB   10  输出 上拉 30mA  高电平
};
```

```dts
gpio-name = <&pio  bank  pin  function  pull  drive  data>;
//          ^^^^   ^^^^  ^^^  ^^^^^^^^  ^^^^  ^^^^^  ^^^^
//          控制器  组    编号  功能复用  上下拉 驱动力 初始值

// 示例：
reset = <&pio 1 10 1 1 2 1>;
//      PB10, 输出模式, 上拉, 30mA驱动, 初始高电平
```

