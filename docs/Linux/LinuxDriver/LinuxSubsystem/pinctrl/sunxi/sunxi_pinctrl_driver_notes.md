# Sunxi Pinctrl 驱动设计学习笔记

> 这份笔记由原始问答整理而来，目标是把分散的讨论重排成一条更清晰的学习路径：先理解 pinctrl 的基本概念，再看 sunxi 驱动的数据结构，最后串起初始化、设备树配置、寄存器写入、GPIO 和 IRQ 支持。

---

## 0. 先抓住一条主线

Sunxi pinctrl 驱动的核心思想可以概括为：

> **用静态描述表描述 SoC 的硬件引脚能力，再在驱动 probe 时构建运行时索引和状态，最后通过 Linux pinctrl / pinmux / pinconf / gpio / irq 框架把设备树配置落到硬件寄存器。**

也就是说，它把问题拆成两层：

1. **芯片差异层**：不同 Allwinner SoC 有不同的引脚、复用功能、中断能力，这些用静态描述表表示。
2. **通用驱动层**：寄存器布局、pinctrl 框架回调、GPIO 操作、中断处理逻辑基本共用，放在 `pinctrl-sunxi.c` 中实现。

---

## 1. Sunxi pinctrl 的整体架构

Sunxi pinctrl 驱动采用典型的分层设计：

```text
drivers/pinctrl/sunxi/
├── pinctrl-sunxi.c        # 通用核心逻辑
├── pinctrl-sunxi.h        # 公共结构体、宏、寄存器计算函数
├── pinctrl-sun4i-a10.c    # 某个 SoC 的引脚描述
├── pinctrl-sun5i.c
├── pinctrl-sun8i-xxx.c
└── ...
```

### 1.1 核心层：`pinctrl-sunxi.c`

负责通用逻辑：

- 注册 pinctrl 设备
- 注册 GPIO chip
- 注册 IRQ domain
- 解析设备树 pinctrl 节点
- 实现 pinmux 配置
- 实现 pinconf 配置，例如 drive strength、pull up/down
- 根据 pin 编号计算寄存器地址和 bit offset
- 写硬件寄存器完成真正配置

### 1.2 芯片层：`pinctrl-sun4i-a10.c` 等

负责描述某个 SoC 的静态硬件能力：

- 有哪些 pin
- pin 名字是什么，例如 `PA0`、`PB3`
- 每个 pin 支持哪些 function
- 每个 function 对应的 muxval 是多少
- 哪些 pin 支持 IRQ
- IRQ bank 和 IRQ num 如何对应

这个分层的好处是：**新增一个 SoC 时，大部分时候只需要新增一份引脚描述表，而不用重写 pinctrl 主逻辑。**

---

## 2. Sunxi 硬件寄存器布局

Sunxi PIO 的寄存器布局比较规整。每个 bank 占用 `0x24` 字节，常见偏移如下：

```c
#define BANK_MEM_SIZE       0x24
#define MUX_REGS_OFFSET     0x0    // 功能复用寄存器
#define DATA_REGS_OFFSET    0x10   // 数据寄存器
#define DLEVEL_REGS_OFFSET  0x14   // 驱动能力寄存器
#define PULL_REGS_OFFSET    0x1c   // 上下拉寄存器
```

这意味着驱动只要知道 pin 编号，就可以推导出：

- 它属于哪个 bank
- 对应哪个寄存器
- 在寄存器中的 bit 偏移是多少

例如 mux 寄存器地址计算逻辑大致是：

```c
static inline u32 sunxi_mux_reg(u16 pin)
{
    u8 bank = pin / PINS_PER_BANK;
    u32 offset = bank * BANK_MEM_SIZE;

    offset += MUX_REGS_OFFSET;
    offset += pin % PINS_PER_BANK / MUX_PINS_PER_REG * 0x04;

    return round_down(offset, 4);
}

static inline u32 sunxi_mux_offset(u16 pin)
{
    u32 pin_num = pin % MUX_PINS_PER_REG;
    return pin_num * MUX_PINS_BITS;
}
```

所以 sunxi 驱动的寄存器访问很直接：

```text
pin 编号 -> bank -> 寄存器偏移 -> bit offset -> readl/writel 修改对应字段
```

---

## 3. Pinctrl 中 pins、groups、functions 是什么

这是理解 pinctrl 子系统的基础。

### 3.1 Pins：物理引脚

`pin` 是芯片上的物理引脚，是最小硬件资源单位。

在 sunxi 中，pin 通常用 bank + pin index 表示，例如：

```text
PA0, PA1, PA2, ...
PB0, PB1, PB2, ...
```

宏定义示意：

```c
#define PA_BASE 0
#define PB_BASE 32
#define PC_BASE 64

#define SUNXI_PINCTRL_PIN(bank, pin) \
    PINCTRL_PIN(P ## bank ## _BASE + (pin), "P" #bank #pin)
```

例如：

```c
SUNXI_PINCTRL_PIN(A, 0)
```

表示：

```text
pin number = 0
pin name   = "PA0"
```

---

### 3.2 Functions：引脚可复用的功能

`function` 表示一个 pin 可以切换成什么功能。

例如 PA0 可以配置成：

```c
SUNXI_PIN(SUNXI_PINCTRL_PIN(A, 0),
    SUNXI_FUNCTION(0x0, "gpio_in"),
    SUNXI_FUNCTION(0x1, "gpio_out"),
    SUNXI_FUNCTION(0x2, "emac"),
    SUNXI_FUNCTION(0x3, "spi1"),
    SUNXI_FUNCTION(0x4, "uart2"))
```

含义是：

| muxval | function | 含义 |
|---:|---|---|
| `0x0` | `gpio_in` | GPIO 输入 |
| `0x1` | `gpio_out` | GPIO 输出 |
| `0x2` | `emac` | 以太网 MAC 功能 |
| `0x3` | `spi1` | SPI1 功能 |
| `0x4` | `uart2` | UART2 功能 |

其中 `muxval` 就是最终要写入硬件 mux 寄存器的值。

---

### 3.3 Groups：引脚组

`group` 是 pinctrl 框架中的逻辑分组。

有些平台会把多个 pin 组成一个 group，例如一个 UART group 可能包含 TX、RX、CTS、RTS。  
但 sunxi 的设计更简单：

> **在 sunxi 中，基本上一个 group 就是一个 pin。**

例如：

```text
Group "PA0" -> pin PA0
Group "PA1" -> pin PA1
Group "PA2" -> pin PA2
```

因此设备树中写：

```dts
uart2_pins: uart2-pins {
    allwinner,pins = "PA2", "PA3";
    allwinner,function = "uart2";
};
```

可以理解为：

```text
把 group PA2 对应的 pin PA2 配成 uart2
把 group PA3 对应的 pin PA3 配成 uart2
```

---

## 4. pins / groups / functions 的关系

以 PA0 为例：

```text
Pin PA0
  |
  +-- Group "PA0"
  |
  +-- 支持的 Functions
        |
        +-- gpio_in   muxval = 0x0
        +-- gpio_out  muxval = 0x1
        +-- emac      muxval = 0x2
        +-- spi1      muxval = 0x3
        +-- uart2     muxval = 0x4
```

从另一个方向看，function 也需要知道自己能作用于哪些 group：

```text
Function "uart2"
  |
  +-- Group "PA0"
  +-- Group "PA1"
  +-- Group "PA2"
  +-- Group "PA3"
  +-- ...
```

这就是为什么 sunxi 驱动需要在运行时构建 `function -> groups` 的反向索引。

---

## 5. `pinctrl-sunxi.h` 中的结构体分类

可以把这些结构体分成两类：

1. **静态描述结构体**：描述 SoC 固有硬件能力，通常编译时确定。
2. **运行时管理结构体**：probe 时动态创建，用于保存运行时资源、索引和状态。

---

## 6. 静态描述结构体

### 6.1 `struct sunxi_desc_function`

```c
struct sunxi_desc_function {
    const char *name;
    u8          muxval;
    u8          irqbank;
    u8          irqnum;
};
```

它描述的是：**某个 pin 支持的某一个 function。**

字段含义：

| 字段 | 含义 |
|---|---|
| `name` | 功能名，例如 `gpio_in`、`gpio_out`、`uart2`、`spi1`、`irq` |
| `muxval` | 写入 mux 寄存器的值，用来切换引脚功能 |
| `irqbank` | 如果该功能是 IRQ，表示 IRQ bank 编号 |
| `irqnum` | 如果该功能是 IRQ，表示 bank 内的 IRQ 编号 |

例子：

```c
SUNXI_FUNCTION(0x4, "uart2")
```

表示当前 pin 可以被配置成 `uart2`，配置时需要把 mux 字段写成 `0x4`。

如果是中断功能，可能包含类似信息：

```text
name    = "irq"
muxval  = 0x6
irqbank = 0
irqnum  = 3
```

表示该 pin 可以作为 GPIO IRQ 使用，并映射到某个 IRQ bank / irqnum。

---

### 6.2 `struct sunxi_desc_pin`

```c
struct sunxi_desc_pin {
    struct pinctrl_pin_desc    pin;
    struct sunxi_desc_function *functions;
};
```

它描述的是：**一个 pin，以及这个 pin 支持的所有 function。**

字段含义：

| 字段 | 含义 |
|---|---|
| `pin` | Linux pinctrl 通用 pin 描述，包含 pin 编号和名字 |
| `functions` | 当前 pin 支持的 function 数组 |

例子：

```c
SUNXI_PIN(SUNXI_PINCTRL_PIN(A, 0),
    SUNXI_FUNCTION(0x0, "gpio_in"),
    SUNXI_FUNCTION(0x1, "gpio_out"),
    SUNXI_FUNCTION(0x2, "emac"),
    SUNXI_FUNCTION(0x3, "spi1"),
    SUNXI_FUNCTION(0x4, "uart2"))
```

可以读成：

```text
PA0 这个 pin 支持 gpio_in / gpio_out / emac / spi1 / uart2 这些功能，
每个功能分别有自己的 muxval。
```

---

### 6.3 `struct sunxi_pinctrl_desc`

```c
struct sunxi_pinctrl_desc {
    const struct sunxi_desc_pin *pins;
    int                         npins;
    unsigned                    pin_base;
    unsigned                    irq_banks;
    bool                        irq_read_needs_mux;
};
```

它描述的是：**整个 SoC 的 pinctrl 硬件能力。**

字段含义：

| 字段 | 含义 |
|---|---|
| `pins` | 指向该 SoC 的所有 pin 描述数组 |
| `npins` | pin 数量 |
| `pin_base` | pin 编号基址 |
| `irq_banks` | 支持多少个 IRQ bank |
| `irq_read_needs_mux` | 读取 IRQ/GPIO 状态时是否需要考虑 mux 配置，属于 SoC 差异项 |

一个 SoC 通常会提供一份这样的描述：

```c
static const struct sunxi_pinctrl_desc sun4i_a10_pinctrl_data = {
    .pins = sun4i_a10_pins,
    .npins = ARRAY_SIZE(sun4i_a10_pins),
    .pin_base = 0,
    .irq_banks = 1,
};
```

---

## 7. 运行时管理结构体

### 7.1 `struct sunxi_pinctrl_group`

```c
struct sunxi_pinctrl_group {
    const char    *name;
    unsigned long  config;
    unsigned       pin;
};
```

它描述的是：**运行时的一个 group。**

在 sunxi 中，一个 group 基本上对应一个 pin。

字段含义：

| 字段 | 含义 |
|---|---|
| `name` | group 名称，例如 `PA0` |
| `config` | 该 group 当前缓存的 pinconf 配置 |
| `pin` | 对应的 pin number |

构建时大致这样做：

```c
pctl->ngroups = pctl->desc->npins;

for (i = 0; i < pctl->desc->npins; i++) {
    const struct sunxi_desc_pin *pin = pctl->desc->pins + i;
    struct sunxi_pinctrl_group *group = pctl->groups + i;

    group->name = pin->pin.name;
    group->pin  = pin->pin.number;
}
```

也就是说：

```text
静态 pin 描述 -> 运行时 group 数组
```

---

### 7.2 `struct sunxi_pinctrl_function`

```c
struct sunxi_pinctrl_function {
    const char  *name;
    const char **groups;
    unsigned    ngroups;
};
```

它描述的是：**运行时的 function 到 groups 的反向索引。**

字段含义：

| 字段 | 含义 |
|---|---|
| `name` | function 名称，例如 `uart2` |
| `groups` | 支持该 function 的 group 名称数组 |
| `ngroups` | 支持该 function 的 group 数量 |

注意它和 `sunxi_desc_function` 的区别：

| 结构体 | 方向 | 作用 |
|---|---|---|
| `sunxi_desc_function` | pin -> function | 描述某个 pin 支持某个 function，以及 muxval |
| `sunxi_pinctrl_function` | function -> groups | 描述某个 function 可以作用在哪些 groups 上 |

例如静态描述是：

```text
PA0 -> uart2
PA1 -> uart2
PA2 -> uart2
PA3 -> uart2
```

运行时会整理成：

```text
uart2 -> PA0, PA1, PA2, PA3
```

这方便 pinctrl 框架查询：

```text
某个 function 可以用于哪些 group？
```

---

### 7.3 `struct sunxi_pinctrl`

```c
struct sunxi_pinctrl {
    void __iomem                    *membase;
    struct gpio_chip                *chip;
    const struct sunxi_pinctrl_desc *desc;
    struct device                   *dev;
    struct irq_domain               *domain;
    struct sunxi_pinctrl_function   *functions;
    unsigned                         nfunctions;
    struct sunxi_pinctrl_group      *groups;
    unsigned                         ngroups;
    int                             *irq;
    unsigned                        *irq_array;
    spinlock_t                       lock;
    struct pinctrl_dev              *pctl_dev;
};
```

它是整个驱动实例的核心运行时对象。

可以把它理解为：

> **某一个 sunxi pinctrl 控制器在系统运行时的上下文。**

字段可以分组理解：

### 硬件资源

| 字段 | 含义 |
|---|---|
| `membase` | PIO 寄存器映射后的虚拟地址 |
| `irq` | 每个 IRQ bank 对应的父中断号 |
| `domain` | GPIO IRQ 使用的 irq domain |
| `irq_array` | hwirq 到 pin number 的映射 |

### 框架对象

| 字段 | 含义 |
|---|---|
| `chip` | 注册给 gpiolib 的 `gpio_chip` |
| `pctl_dev` | 注册给 pinctrl 子系统的 `pinctrl_dev` |
| `dev` | Linux device 指针 |

### 描述和索引

| 字段 | 含义 |
|---|---|
| `desc` | 指向静态 SoC 描述，例如 sun4i-a10 的 pin 描述表 |
| `groups` / `ngroups` | 运行时 group 数组和数量 |
| `functions` / `nfunctions` | 运行时 function 数组和数量 |

### 同步保护

| 字段 | 含义 |
|---|---|
| `lock` | 保护寄存器 read-modify-write 的自旋锁 |

---

## 8. 为什么运行时结构不能全部编译时确定？

这是原讨论中的重点问题。

### 8.1 因为静态描述是 pin -> function，但框架还需要 function -> group

芯片描述表天然适合这样写：

```text
PA0 -> gpio_in, gpio_out, emac, spi1, uart2
PA1 -> gpio_in, gpio_out, emac, spi1, uart2
PA2 -> gpio_in, gpio_out, emac, spi1, uart2
```

但 pinctrl 框架也需要查询：

```text
uart2 支持哪些 groups？
spi1 支持哪些 groups？
emac 支持哪些 groups？
```

所以驱动会在运行时自动构建反向索引：

```text
uart2 -> PA0, PA1, PA2, PA3, ...
spi1  -> PA0, PA1, PA2, PA3, ...
emac  -> PA0, PA1, PA2, PA3, ...
```

如果编译时手工维护这两份数据，会有明显问题：

```c
// 第一份：pin -> function
PA0 supports uart2
PA1 supports uart2
PA2 supports uart2

// 第二份：function -> group
uart2 groups = { "PA0", "PA1", "PA2" }
```

一旦某个 pin 的功能有变，两处都要改，容易不一致。  
运行时自动构建可以保证：**单一数据源，自动生成索引。**

---

### 8.2 因为 pinconf 配置来自设备树

`sunxi_pinctrl_group` 中有一个运行时字段：

```c
unsigned long config;
```

它用于缓存当前 group 的配置，例如：

- drive strength
- pull up
- pull down
- bias disable

这些配置通常来自设备树：

```dts
uart2_pins: uart2-pins {
    allwinner,pins = "PA2", "PA3";
    allwinner,function = "uart2";
    allwinner,drive = <3>;
    allwinner,pull = <1>;
};
```

不同板级 DTS 可以给同一个 SoC 配不同的 drive / pull。  
所以这些状态不可能只靠编译时确定。

---

### 8.3 因为硬件资源只能 probe 时获取

`sunxi_pinctrl` 中很多字段必须运行时获取：

```c
void __iomem      *membase;
struct gpio_chip  *chip;
struct irq_domain *domain;
int               *irq;
spinlock_t         lock;
```

例如：

- `membase` 需要从设备树 `reg` 资源解析后 `ioremap`
- `irq` 需要从设备树 `interrupts` 解析
- `gpio_chip` 需要运行时注册到 gpiolib
- `irq_domain` 需要运行时创建
- `lock` 需要运行时初始化

这些都依赖 platform device 的 probe 过程，编译时不知道。

---

### 8.4 因为要支持多实例

如果一个系统中有多个 pinctrl 控制器，每个控制器都应该有自己的：

- 寄存器基地址
- IRQ 资源
- GPIO chip
- pinctrl dev
- 运行时配置状态

所以不能用一个全局静态对象保存所有运行时状态，而应该为每个 platform device 分配一个独立的 `struct sunxi_pinctrl`。

---

## 9. 初始化流程：从静态描述到运行时对象

整体流程可以这样理解：

```text
SoC 静态描述表
  |
  | probe 时传给 sunxi_pinctrl_init()
  v
分配 struct sunxi_pinctrl
  |
  +-- 获取寄存器资源，映射到 membase
  +-- 初始化 lock
  +-- 保存 desc 指针
  +-- 分配 irq_array
  |
  v
sunxi_pinctrl_build_state()
  |
  +-- 根据 desc->pins 构建 groups[]
  +-- 遍历所有 pin 的 functions
  +-- 构建 function -> groups 反向索引
  +-- 顺便构建 IRQ 到 pin 的映射
  |
  v
注册 pinctrl_dev
  |
  v
注册 gpio_chip
  |
  v
注册 irq_domain，设置 chained irq handler
```

关键点是：

```text
静态描述负责“硬件有什么能力”
运行时结构负责“当前系统如何使用这些能力”
```

---

## 10. 设备树配置如何落到寄存器

以 UART2 为例，设备树可能写：

```dts
uart2_pins: uart2-pins {
    allwinner,pins = "PA2", "PA3";
    allwinner,function = "uart2";
    allwinner,drive = <0>;
    allwinner,pull = <0>;
};
```

驱动处理过程大致是：

```text
1. 解析 allwinner,pins
   得到 group 名称：PA2、PA3

2. 解析 allwinner,function
   得到 function 名称：uart2

3. 查找 group
   PA2 -> pin number 2
   PA3 -> pin number 3

4. 查找 function
   uart2 -> 支持它的 groups 列表

5. 查找 pin 对应 function 的 muxval
   PA2 + uart2 -> muxval = 0x4
   PA3 + uart2 -> muxval = 0x4

6. 写 mux 寄存器
   把 PA2、PA3 的 mux 字段写成 0x4

7. 如果有 drive / pull 配置
   继续写 DLEVEL / PULL 寄存器
```

核心 pinmux 设置逻辑类似：

```c
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

这里的 `config` 就是前面说的 `muxval`。

---

## 11. GPIO 集成思路

Sunxi pinctrl 驱动同时注册了 GPIO chip。

GPIO 的方向设置、读写等操作最终还是围绕 pinctrl 和 PIO 寄存器完成。

典型接口：

```c
static int sunxi_pinctrl_gpio_request(struct gpio_chip *chip, unsigned offset)
{
    return pinctrl_request_gpio(chip->base + offset);
}

static void sunxi_pinctrl_gpio_free(struct gpio_chip *chip, unsigned offset)
{
    pinctrl_free_gpio(chip->base + offset);
}

static int sunxi_pinctrl_gpio_direction_input(struct gpio_chip *chip,
                                              unsigned offset)
{
    return pinctrl_gpio_direction_input(chip->base + offset);
}
```

可以理解为：

```text
GPIO request/free/direction -> pinctrl 框架 -> sunxi pinmux -> PIO 寄存器
```

---

## 12. IRQ 集成思路

Sunxi GPIO pin 也可以作为中断输入。

驱动中通过以下机制支持 GPIO IRQ：

- IRQ bank
- IRQ domain
- hwirq 到 pin 的映射
- edge irq chip
- level irq chip
- chained irq handler

运行时构建中会处理 `irq` function：

```text
如果某个 pin 的 function 名为 "irq"：
  irqnum = func->irqnum + func->irqbank * IRQ_PER_BANK
  pctl->irq_array[irqnum] = pin->pin.number
```

也就是建立：

```text
硬件 IRQ 编号 -> pin number
```

这样中断触发时，驱动就能从 IRQ 状态寄存器反推出具体哪个 pin 产生了中断。

---

## 13. 用一张图总结数据关系

```text
编译时静态数据
================

sunxi_pinctrl_desc
  |
  +-- pins[]
        |
        +-- sunxi_desc_pin: PA0
        |     |
        |     +-- sunxi_desc_function: gpio_in, muxval 0x0
        |     +-- sunxi_desc_function: gpio_out, muxval 0x1
        |     +-- sunxi_desc_function: uart2, muxval 0x4
        |
        +-- sunxi_desc_pin: PA1
        |     |
        |     +-- ...


probe 后运行时数据
==================

sunxi_pinctrl
  |
  +-- desc ------------------------> 指向静态 sunxi_pinctrl_desc
  |
  +-- groups[]
  |     |
  |     +-- group "PA0" -> pin 0
  |     +-- group "PA1" -> pin 1
  |
  +-- functions[]
  |     |
  |     +-- function "uart2" -> groups { "PA0", "PA1", ... }
  |     +-- function "spi1"  -> groups { "PA0", "PA1", ... }
  |
  +-- membase   -> PIO 寄存器基地址
  +-- chip      -> gpio_chip
  +-- domain    -> irq_domain
  +-- irq_array -> hwirq 到 pin 的映射
  +-- lock      -> 保护寄存器访问
```

---

## 14. 最重要的理解点

### 14.1 静态描述和运行时状态要分开

静态描述回答：

```text
这个 SoC 有哪些 pin？
每个 pin 支持哪些 function？
每个 function 对应哪个 muxval？
哪些 pin 支持 IRQ？
```

运行时状态回答：

```text
当前系统的寄存器基地址在哪里？
当前注册的 gpio_chip 是哪个？
当前 pinctrl_dev 是哪个？
某个 function 对应哪些 groups？
当前 group 缓存了什么 pinconf 配置？
```

---

### 14.2 `sunxi_pinctrl_function` 是反向索引

它不是重新描述硬件，而是为了方便框架查询：

```text
function -> groups
```

它由静态的：

```text
pin -> functions
```

自动整理而来。

---

### 14.3 `sunxi_pinctrl_group` 在 sunxi 中几乎等于单个 pin

很多平台的 group 是多个 pin 的组合，但 sunxi 更简单：

```text
group "PA2" -> pin PA2
group "PA3" -> pin PA3
```

因此设备树中 `allwinner,pins = "PA2", "PA3"` 很直观。

---

### 14.4 muxval 是落到硬件的关键

设备树写的是 function 名称：

```dts
allwinner,function = "uart2";
```

但硬件不认识字符串，它只认识寄存器字段值。

所以驱动要完成映射：

```text
PA2 + "uart2" -> muxval 0x4 -> 写 mux 寄存器
```

---

### 14.5 为什么运行时构建是合理的

因为它同时解决了：

1. 避免手工维护重复数据
2. 自动生成 function 到 group 的反向索引
3. 支持设备树里的动态 pinconf 配置
4. 支持 probe 时获取硬件资源
5. 支持多个 pinctrl 控制器实例
6. 让新增 SoC 的成本更低

---

## 15. 推荐阅读顺序

如果你继续看代码，建议按这个顺序读：

1. `pinctrl-sunxi.h`
   - 先看结构体定义
   - 再看寄存器 offset 计算 helper

2. 某个具体 SoC 文件，例如 `pinctrl-sun4i-a10.c`
   - 看 `SUNXI_PIN(...)` 如何描述 pin
   - 看 `SUNXI_FUNCTION(...)` 如何描述 muxval
   - 看 SoC 的 `sunxi_pinctrl_desc`

3. `sunxi_pinctrl_init()`
   - 看驱动如何分配 `struct sunxi_pinctrl`
   - 看如何注册 pinctrl / gpio / irq

4. `sunxi_pinctrl_build_state()`
   - 重点看 groups[] 和 functions[] 怎么从静态表构建出来

5. `sunxi_pmx_set_mux()` / `sunxi_pmx_set()`
   - 看 function 名称如何变成 muxval
   - 看 muxval 如何写入寄存器

6. `sunxi_pconf_group_set()`
   - 看 drive / pull 配置如何写入 DLEVEL / PULL 寄存器

7. IRQ 相关函数
   - 看 GPIO 中断如何映射和分发

---

## 16. 一句话复盘

Sunxi pinctrl 的设计并不复杂，核心就是：

> **芯片文件用静态表描述“每个 pin 能做什么”，核心驱动在运行时把这些表整理成 pinctrl 框架需要的 groups/functions 索引，并结合设备树配置，把 function、drive、pull、irq 等设置写进 PIO 寄存器。**

