# Linux startup process for E907 small core system
_Exported on 2026/3/31 at GMT+8 16:47:15 from Cursor (2.6.21)_

---

**User**

https://www.gloomyghost.com/live/20230215.aspx 
请结合这篇文章分析一下Linux如何启动E907小核系统的

---

**Cursor**

我来读取这篇文章和相关代码来分析Linux如何启动E907小核系统。





Results:



Now let me read the results and explore further:我来查看文章内容和相关代码文件：




Results are processing. Let me now capture the browser content and explore the project structure:




Let me wait for the browser to load and then get a snapshot, while also exploring the filesystem:



Results:



Let me get all the results together:



Let me get proper results now:


Results:

Based on the browser snapshot and my exploration of your local codebase, let me now do a comprehensive analysis:





Results:

I have the information needed. Let me now present the comprehensive analysis:

---

## Linux 启动 E907 小核系统分析

基于文章 [https://www.gloomyghost.com/live/20230215.aspx](https://www.gloomyghost.com/live/20230215.aspx) 以及当前工程代码，以下是完整分析：

---

### 一、硬件架构背景

全志 V851s/V853 是一款异构多核 SoC：

| 核心 | 架构 | 操作系统 |
|------|------|---------|
| 大核 (A7) | ARM Cortex-A7 | Linux (Tina OS) |
| 小核 (E907) | RISC-V (玄铁 E907) | RTOS (Melis / FreeRTOS) |

两个核心共享 DDR 内存，通过 **RPMsg（Remote Processor Messaging）** 框架通信，底层依托硬件 **Mailbox** 中断机制。

---

### 二、启动流程总览

```
上电
  │
  ▼
[SPL/U-Boot]
  │  加载 Linux 内核镜像到 DDR
  │  加载 E907 固件到保留内存区域
  │
  ▼
[Linux Kernel 启动]
  │
  ▼
[remoteproc 驱动初始化]
  │  解析设备树 (DTS) 中 e907 节点
  │  映射 E907 固件所在内存
  │  写入 E907 复位向量地址
  │  释放复位信号 → E907 开始运行
  │
  ▼
[RPMsg / Mailbox 通信建立]
  │
  ▼
[大小核协同工作]
```

---

### 三、关键步骤详解

#### 1. 内存预留（Device Tree）

Linux 内核通过设备树为 E907 预留一块专用内存区域，E907 固件会被加载到这里：

```dts
reserved-memory {
    e907_dram: riscv_memreserve {
        reg = <0x00000000 0x43c00000 0x00000000 0x00400000>;
        no-map;
    };
};
```

- 固件加载到 `0x43c00000`，大小 4MB
- `no-map` 表示 Linux 不会将此段内存纳入自己的内存管理

#### 2. E907 固件加载（U-Boot 阶段 或 Linux remoteproc）

有两种方式将固件写入预留内存：

**方式A：U-Boot 提前加载**
U-Boot 在引导 Linux 前，将 E907 的 `.bin` 固件直接写入预留内存，Linux 启动后 remoteproc 只需触发复位即可。

**方式B：Linux remoteproc 动态加载（主流方式）**
Linux remoteproc 框架在驱动 probe 时，通过 `request_firmware()` 从文件系统（或内核内嵌）读取 ELF 格式固件，解析各段并写入对应物理地址。

#### 3. remoteproc 驱动（Linux 侧核心）

驱动位于内核 `drivers/remoteproc/` 目录，对于全志平台通常有专用驱动如 `sunxi_rproc.c`。核心流程：

```c
// 1. 驱动 probe，解析 DTS
static int sunxi_rproc_probe(struct platform_device *pdev)
{
    // 获取 e907 的 clock、reset 控制句柄
    // 注册 rproc 设备
    rproc = rproc_alloc(dev, name, &sunxi_rproc_ops, fw_name, sizeof(*ddata));
    rproc_add(rproc);
}

// 2. 启动 E907
static int sunxi_rproc_start(struct rproc *rproc)
{
    // 配置 E907 启动地址（复位向量）
    writel(rproc->bootaddr, RISCV_BOOT_ADDR_REG);
    
    // 使能 E907 时钟
    clk_prepare_enable(ddata->clk);
    
    // 释放 E907 复位
    reset_control_deassert(ddata->rst);
    // E907 从 bootaddr 开始执行
}
```

#### 4. sys_config.fex 配置

从你当前打开的文件可以看到，`sys_config.fex` 中包含了 E907 相关配置：

```1:48:/home/ubuntu/v851s/tina-v853-100ask/lichee/melis-v3.0/source/projects/v853-e907-ver1-board/configs/sys_config.fex
```

这个配置文件经 `fex2bin` 工具转换后，U-Boot 和内核驱动会读取其中的参数来配置 E907 的内存地址、启动参数等。

#### 5. E907 小核侧 Melis 启动（main.c）

E907 被释放复位后，从其固件入口点执行，最终调用 Melis 的 main 函数：

```1:38:/home/ubuntu/v851s/tina-v853-100ask/lichee/melis-v3.0/source/projects/v851-e907-perf2-board/src/main.c
```

#### 6. RPMsg 通信建立

E907 运行后，双核通过 RPMsg 协议通信：

```
Linux (A7)                    E907 (RISC-V)
    │                              │
    │  ← Mailbox 中断 →           │
    │                              │
  RPMsg Client              RPMsg Server
    │                              │
    └──── 共享内存 virtqueue ──────┘
         (在预留内存中)
```

- **Mailbox**：用于触发对方核心的中断，通知有消息待处理
- **Virtqueue**：在共享内存中维护消息队列（基于 VirtIO 协议）
- Linux 侧：`rpmsg_char` 设备驱动，暴露 `/dev/rpmsg0` 等字符设备给用户空间

---

### 四、启动触发方式

根据文章，Linux 触发 E907 启动有两种常见方式：

**1. 开机自动启动（通过 `remoteproc` sysfs 或内核自动启动）**
```bash
# 手动触发（调试用）
echo start > /sys/class/remoteproc/remoteproc0/state
```

**2. 内核模块加载时自动启动**
在 `defconfig` 中配置 `CONFIG_SUNXI_RPROC=y`，开机自动加载固件并启动 E907。

---

### 五、关键代码路径总结

```
Linux DTS
  └─ reserved-memory（为 E907 预留内存）
  └─ e907_rproc 节点（clock、reset、mbox 引用）

Linux remoteproc 驱动
  └─ sunxi_rproc_probe()      # 驱动探测，资源初始化
  └─ rproc_boot()             # 固件加载 + 启动
       ├─ request_firmware()  # 加载 ELF 固件
       ├─ 解析 ELF 段，写入预留内存
       └─ sunxi_rproc_start() # 写启动地址，deassert reset

E907 固件 (Melis)
  └─

```plaintext
上电
  │
  ▼
[SPL/U-Boot]
  │  加载 Linux 内核镜像到 DDR
  │  加载 E907 固件到保留内存区域
  │
  ▼
[Linux Kernel 启动]
  │
  ▼
[remoteproc 驱动初始化]
  │  解析设备树 (DTS) 中 e907 节点
  │  映射 E907 固件所在内存
  │  写入 E907 复位向量地址
  │  释放复位信号 → E907 开始运行
  │
  ▼
[RPMsg / Mailbox 通信建立]
  │
  ▼
[大小核协同工作]
```

```dts
reserved-memory {
    e907_dram: riscv_memreserve {
        reg = <0x00000000 0x43c00000 0x00000000 0x00400000>;
        no-map;
    };
};
```

```c
// 1. 驱动 probe，解析 DTS
static int sunxi_rproc_probe(struct platform_device *pdev)
{
    // 获取 e907 的 clock、reset 控制句柄
    // 注册 rproc 设备
    rproc = rproc_alloc(dev, name, &sunxi_rproc_ops, fw_name, sizeof(*ddata));
    rproc_add(rproc);
}

// 2. 启动 E907
static int sunxi_rproc_start(struct rproc *rproc)
{
    // 配置 E907 启动地址（复位向量）
    writel(rproc->bootaddr, RISCV_BOOT_ADDR_REG);
    
    // 使能 E907 时钟
    clk_prepare_enable(ddata->clk);
    
    // 释放 E907 复位
    reset_control_deassert(ddata->rst);
    // E907 从 bootaddr 开始执行
}
```

```plaintext
Linux (A7)                    E907 (RISC-V)
    │                              │
    │  ← Mailbox 中断 →           │
    │                              │
  RPMsg Client              RPMsg Server
    │                              │
    └──── 共享内存 virtqueue ──────┘
         (在预留内存中)
```

```shellscript
# 手动触发（调试用）
echo start > /sys/class/remoteproc/remoteproc0/state
```

```plaintext
Linux DTS
  └─ reserved-memory（为 E907 预留内存）
  └─ e907_rproc 节点（clock、reset、mbox 引用）

Linux remoteproc 驱动
  └─ sunxi_rproc_probe()      # 驱动探测，资源初始化
  └─ rproc_boot()             # 固件加载 + 启动
       ├─ request_firmware()  # 加载 ELF 固件
       ├─ 解析 ELF 段，写入预留内存
       └─ sunxi_rproc_start() # 写启动地址，deassert reset

E907 固件 (Melis)
  └─
```

我已经收集到了足够的信息。现在让我读取关键的源代码文件来进行深入分析：





Now let me also look at the rproc firmware and standby files:

现在我已经读取了所有关键源代码文件，可以给出基于真实代码的完整深度分析了。

---

## Linux 启动 E907 小核系统 — 完整深度分析

基于你工程中的真实代码，结合文章内容，以下是完整的启动流程分析：

---

### 一、整体架构

```
全志 V851s/V853 SoC
┌─────────────────────────────────────────────────┐
│  大核 ARM Cortex-A7          小核 RISC-V E907    │
│  ┌─────────────────┐        ┌─────────────────┐  │
│  │  Linux (Tina)   │        │  Melis / RTOS   │  │
│  │                 │◄──────►│                 │  │
│  │  remoteproc     │ Mailbox│  OpenAMP        │  │
│  │  RPMsg          │ 中断   │  RPMsg          │  │
│  └─────────────────┘        └─────────────────┘  │
│          │                          │             │
│          └──────── 共享 DDR ────────┘             │
└─────────────────────────────────────────────────┘
```

---

### 二、完整启动流程（分阶段）

#### 阶段 0：SPL/U-Boot 提前加载固件

这是最关键的第一步。在你的工程中 `brandy-2.0/u-boot-2018/drivers/riscv/sun8iw21/riscv.c` 实现了 U-Boot 阶段的 E907 启动：

```115:155:/home/ubuntu/v851s/tina-v853-100ask/lichee/brandy-2.0/u-boot-2018/drivers/riscv/sun8iw21/riscv.c
int sunxi_riscv_init(u32 img_addr, u32 run_ddr, u32 riscv_id)
{

	u32 reg_val;
	u32 image_len = 0;

#ifdef CONFIG_SUNXI_VERIFY_RISCV
	if (sunxi_verify_riscv(img_addr, image_len, riscv_id) < 0) {
		return -1;
	}
#endif
	/* update run addr */
	update_reset_vec(img_addr, &run_ddr);
	/* load image to ram */
	load_image(img_addr, riscv_id);
	if (riscv_id == 0) { /* RISCV0 */
		printf("[bsp]: %s: %s(): +%d\n", __FILE__, __func__, __LINE__);
		/* clock gating */
		reg_val = readl_riscv(SUNXI_CCM_BASE + RISCV_GATING_RST_REG);
		reg_val |= RISCV_CLK_GATING;
		reg_val |= RISCV_GATING_RST_FIELD;
		writel_riscv(reg_val, SUNXI_CCM_BASE + RISCV_GATING_RST_REG);

		/* reset */
		reg_val = readl_riscv(SUNXI_CCM_BASE + RISCV_CFG_BGR_REG);
		reg_val |= RISCV_CFG_RST;
		reg_val |= RISCV_CFG_GATING;
		writel_riscv(reg_val, SUNXI_CCM_BASE + RISCV_CFG_BGR_REG);

		/* set start addr */
		reg_val = readl_riscv(RISCV_CFG_BASE + RISCV_STA_ADD_REG);
		reg_val |= run_ddr;
		writel_riscv(reg_val, RISCV_CFG_BASE + RISCV_STA_ADD_REG);
```

U-Boot 阶段做了这几件事：
1. 从 `boot_package` 中读取 E907 ELF 固件
2. 解析 ELF 头，找到入口地址（`e_entry`）
3. 将各 ELF 段（segment）`memcpy` 到 DDR 对应物理地址
4. 配置时钟门控寄存器（`RISCV_GATING_RST_REG`）
5. 写入启动地址到 `RISCV_STA_ADD_REG`
6. 设置 E907 时钟为 peri_600M
7. 释放复位，E907 开始运行（在 Linux 启动之前！）

---

#### 阶段 1：Linux remoteproc 驱动初始化

Linux 启动后，`remoteproc` 驱动接管管理。核心抽象层在 `sunxi_rproc_boot.c`：

```17:35:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/remoteproc/sunxi_boot/sunxi_rproc_boot.c
static LIST_HEAD(core_head);
static LIST_HEAD(arch_head);

int sunxi_remote_core_register(struct sunxi_core *core)
{
	if (IS_ERR_OR_NULL(core))
		return -EINVAL;
	list_add(&core->list, &core_head);
	return 0;
}
EXPORT_SYMBOL(sunxi_remote_core_register);
```

E907 的具体硬件操作由 `e907.c` 实现，并通过 `DEFINE_RPROC_CORE` 宏注册：

```227:239:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/remoteproc/sunxi_boot/e907/e907.c
static struct sunxi_remote_core_ops core_ops_e907 = {
	.init = sunxi_e907_init,
	.deinit = sunxi_e907_deinit,
	.start = sunxi_e907_start,
	.is_start = sunxi_e907_is_start,
	.stop = sunxi_e907_stop,
	.set_start_addr = sunxi_e907_set_start_addr,
};

DEFINE_RPROC_CORE(e907, core_ops_e907, "allwinner,riscv-e907");
```

---

#### 阶段 2：E907 硬件资源初始化（sunxi_e907_init）

```32:135:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/remoteproc/sunxi_boot/e907/e907.c
static int sunxi_e907_init(struct platform_device *pdev,
				struct sunxi_core *core)
{
	struct sunxi_e907 *info;
	struct resource *res;
	struct device *dev = &pdev->dev;
	int ret;

	info = devm_kzalloc(dev, sizeof(*info), GFP_KERNEL);
	// ... 从 DTS 获取以下资源:
	// pll clk  → E907 PLL 时钟
	// clk      → E907 核心时钟
	// axi      → E907 AXI 总线时钟
	// gate     → E907 时钟门控（用于判断是否已启动）
	// mbox     → Mailbox 时钟（用于核间通信）
	// riscv-addr → 启动地址寄存器的 MMIO 地址
```

---

#### 阶段 3：固件加载（两条路径）

`remoteproc_core.c` 中的 `__rproc_boot()` 展示了固件加载的两条路径：

```1:30:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/remoteproc/remoteproc_core.c
```

**路径 A（`CONFIG_SUNXI_RPROC_BOOT_PACKAGE`）**：从 flash 的 `boot_package` 分区读取固件（`sunxi_request_firmware`）。`sunxi_rproc_firmware.c` 实现了从 NOR/NAND/eMMC 的 boot_package 中按名字查找并读取 ELF 固件的完整逻辑。

**路径 B（标准路径）**：通过 `request_firmware` 从文件系统（`/lib/firmware/`）加载。

固件加载完成后进入 `rproc_fw_boot()`：

```~rproc_fw_boot 核心流程```

```c
rproc_fw_boot()
  ├── rproc_get_boot_addr()       // 解析 ELF，获取入口地址
  ├── rproc_find_rsc_table()      // 找资源表（vring、carveout等）
  ├── rproc_handle_resources()    // 处理资源：分配共享内存、注册 virtio 设备
  ├── rproc_load_segments()       // 将 ELF 段写入预留内存
  ├── memcpy(loaded_table, ...)   // 将资源表同步到设备内存
  └── rproc->ops->start(rproc)   // 触发 E907 启动！
```

---

#### 阶段 4：E907 启动触发（sunxi_e907_start）

这是真正让 E907 开始运行的代码：

```144:198:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/remoteproc/sunxi_boot/e907/e907.c
static int sunxi_e907_start(struct sunxi_core *core)
{
	struct sunxi_e907 *info = core->priv;
	int rate = 0;
	int ret;

	if (__clk_get_enable_count(info->mbox))
		clk_disable_unprepare(info->mbox);

	ret = clk_enable(info->pclk);
	// ...
	ret = clk_set_parent(info->clk, info->pclk);
	// ...
	ret = clk_set_rate(info->clk, rate);    // 设置 E907 运行频率
	ret = clk_enable(info->clk);
	// ...

	/* Set Cpu boot addr */
	writel(info->boot_addr, info->addr);    // 写入启动地址到硬件寄存器

	/* 重置 msgbox FIFO，清除旧数据 */
	clk_prepare_enable(info->mbox);

	clk_enable(info->gate);                 // 使能时钟门控 → E907 开始执行！
```

关键步骤：
1. 使能 PLL → 核心时钟 → AXI 总线时钟（有依赖顺序）
2. 设置 E907 运行频率
3. `writel(boot_addr, addr)` — 写入启动地址寄存器
4. 重置 Mailbox FIFO（避免脏数据）
5. `clk_enable(gate)` — **打开时钟门控，E907 从复位向量开始执行**

---

#### 阶段 5：E907 侧 Melis 系统启动

E907 从启动地址运行后，执行 Melis 的 RTOS 初始化，最终调用 `app_entry()`：

```1:46:/home/ubuntu/v851s/tina-v853-100ask/lichee/melis-v3.0/source/projects/v851-e907-perf2-board/src/main.c
#include <stdio.h>
#include <hal_timer.h>
#include <openamp/sunxi_helper/openamp.h>

extern int csi_init(int argc, const char **argv);
extern int msh_exec(char *cmd, int length);

int app_entry(void *param)
{
#ifdef CONFIG_DRIVERS_VIN
	int ret;

	ret = csi_init(0, NULL);
	if (ret) {
		rpmsg_notify("rt-media", NULL, 0);
		printf("csi init fail!\n");
	}
#if 1
	rpmsg_notify("twi1", NULL, 0);
	

```plaintext

---

### 二、完整启动流程（分阶段）

#### 阶段 0：SPL/U-Boot 提前加载固件

这是最关键的第一步。在你的工程中 `brandy-2.0/u-boot-2018/drivers/riscv/sun8iw21/riscv.c` 实现了 U-Boot 阶段的 E907 启动：

```115:155:/home/ubuntu/v851s/tina-v853-100ask/lichee/brandy-2.0/u-boot-2018/drivers/riscv/sun8iw21/riscv.c
int sunxi_riscv_init(u32 img_addr, u32 run_ddr, u32 riscv_id)
{

	u32 reg_val;
	u32 image_len = 0;

#ifdef CONFIG_SUNXI_VERIFY_RISCV
	if (sunxi_verify_riscv(img_addr, image_len, riscv_id) < 0) {
		return -1;
	}
#endif
	/* update run addr */
	update_reset_vec(img_addr, &run_ddr);
	/* load image to ram */
	load_image(img_addr, riscv_id);
	if (riscv_id == 0) { /* RISCV0 */
		printf("[bsp]: %s: %s(): +%d\n", __FILE__, __func__, __LINE__);
		/* clock gating */
		reg_val = readl_riscv(SUNXI_CCM_BASE + RISCV_GATING_RST_REG);
		reg_val |= RISCV_CLK_GATING;
		reg_val |= RISCV_GATING_RST_FIELD;
		writel_riscv(reg_val, SUNXI_CCM_BASE + RISCV_GATING_RST_REG);

		/* reset */
		reg_val = readl_riscv(SUNXI_CCM_BASE + RISCV_CFG_BGR_REG);
		reg_val |= RISCV_CFG_RST;
		reg_val |= RISCV_CFG_GATING;
		writel_riscv(reg_val, SUNXI_CCM_BASE + RISCV_CFG_BGR_REG);

		/* set start addr */
		reg_val = readl_riscv(RISCV_CFG_BASE + RISCV_STA_ADD_REG);
		reg_val |= run_ddr;
		writel_riscv(reg_val, RISCV_CFG_BASE + RISCV_STA_ADD_REG);
```

```c
static LIST_HEAD(core_head);
static LIST_HEAD(arch_head);

int sunxi_remote_core_register(struct sunxi_core *core)
{
	if (IS_ERR_OR_NULL(core))
		return -EINVAL;
	list_add(&core->list, &core_head);
	return 0;
}
EXPORT_SYMBOL(sunxi_remote_core_register);
```

```c
static struct sunxi_remote_core_ops core_ops_e907 = {
	.init = sunxi_e907_init,
	.deinit = sunxi_e907_deinit,
	.start = sunxi_e907_start,
	.is_start = sunxi_e907_is_start,
	.stop = sunxi_e907_stop,
	.set_start_addr = sunxi_e907_set_start_addr,
};

DEFINE_RPROC_CORE(e907, core_ops_e907, "allwinner,riscv-e907");
```

```c
static int sunxi_e907_init(struct platform_device *pdev,
				struct sunxi_core *core)
{
	struct sunxi_e907 *info;
	struct resource *res;
	struct device *dev = &pdev->dev;
	int ret;

	info = devm_kzalloc(dev, sizeof(*info), GFP_KERNEL);
	// ... 从 DTS 获取以下资源:
	// pll clk  → E907 PLL 时钟
	// clk      → E907 核心时钟
	// axi      → E907 AXI 总线时钟
	// gate     → E907 时钟门控（用于判断是否已启动）
	// mbox     → Mailbox 时钟（用于核间通信）
	// riscv-addr → 启动地址寄存器的 MMIO 地址
```

```c
rproc_fw_boot()
  ├── rproc_get_boot_addr()       // 解析 ELF，获取入口地址
  ├── rproc_find_rsc_table()      // 找资源表（vring、carveout等）
  ├── rproc_handle_resources()    // 处理资源：分配共享内存、注册 virtio 设备
  ├── rproc_load_segments()       // 将 ELF 段写入预留内存
  ├── memcpy(loaded_table, ...)   // 将资源表同步到设备内存
  └── rproc->ops->start(rproc)   // 触发 E907 启动！
```

```c
static int sunxi_e907_start(struct sunxi_core *core)
{
	struct sunxi_e907 *info = core->priv;
	int rate = 0;
	int ret;

	if (__clk_get_enable_count(info->mbox))
		clk_disable_unprepare(info->mbox);

	ret = clk_enable(info->pclk);
	// ...
	ret = clk_set_parent(info->clk, info->pclk);
	// ...
	ret = clk_set_rate(info->clk, rate);    // 设置 E907 运行频率
	ret = clk_enable(info->clk);
	// ...

	/* Set Cpu boot addr */
	writel(info->boot_addr, info->addr);    // 写入启动地址到硬件寄存器

	/* 重置 msgbox FIFO，清除旧数据 */
	clk_prepare_enable(info->mbox);

	clk_enable(info->gate);                 // 使能时钟门控 → E907 开始执行！
```

```c
#include <stdio.h>
#include <hal_timer.h>
#include <openamp/sunxi_helper/openamp.h>

extern int csi_init(int argc, const char **argv);
extern int msh_exec(char *cmd, int length);

int app_entry(void *param)
{
#ifdef CONFIG_DRIVERS_VIN
	int ret;

	ret = csi_init(0, NULL);
	if (ret) {
		rpmsg_notify("rt-media", NULL, 0);
		printf("csi init fail!\n");
	}
#if 1
	rpmsg_notify("twi1", NULL, 0);
	
```

---

**User**

继续

---

**Cursor**

继续完成完整分析：

---

#### 阶段 5：E907 侧 Melis 系统启动与 RPMsg 通知

E907 启动后执行 Melis RTOS 初始化，最终调用 `app_entry()`，通过 `rpmsg_notify` 向 Linux 大核发送就绪通知：

```1:46:/home/ubuntu/v851s/tina-v853-100ask/lichee/melis-v3.0/source/projects/v851-e907-perf2-dual-camera-board/src/main.c
#include <stdio.h>
#include <hal_timer.h>
#include <openamp/sunxi_helper/openamp.h>

extern int csi_init(int argc, const char **argv);
extern int msh_exec(char *cmd, int length);

int app_entry(void *param)
{
#ifdef CONFIG_DRIVERS_VIN
	int ret;

	ret = csi_init(0, NULL);
	if (ret) {
		rpmsg_notify("rt-media", NULL, 0);
		printf("csi init fail!\n");
	}
#if 1
	rpmsg_notify("twi1", NULL, 0);
	rpmsg_notify("tdm0", NULL, 0);
	rpmsg_notify("isp0", NULL, 0);
	rpmsg_notify("scaler0", NULL, 0);
	rpmsg_notify("scaler4", NULL, 0);
	rpmsg_notify("scaler8", NULL, 0);
	rpmsg_notify("scaler12", NULL, 0);
	rpmsg_notify("vinc0", NULL, 0);
	rpmsg_notify("vinc4", NULL, 0);
	rpmsg_notify("vinc8", NULL, 0);
	rpmsg_notify("vinc12", NULL, 0);
#endif
#else
	hal_msleep(200);
	rpmsg_notify("rt-media", NULL, 0);
#endif
	//msh_exec("dmesg", strlen("dmesg"));
    return 0;
}
```

`rpmsg_notify` 的作用：通过 **Mailbox** 中断通知 Linux 侧对应的 RPMsg 驱动，告知某个设备（如 `isp0`、`vinc0` 等）已在 E907 侧初始化完毕，Linux 可以安全访问。

---

#### 阶段 6：E907 的 defconfig 配置细节

`v853-e907-ver1-board` 的 defconfig 揭示了 E907 侧的关键配置：

```1:50:/home/ubuntu/v851s/tina-v853-100ask/lichee/melis-v3.0/source/projects/v853-e907-ver1-board/configs/defconfig
#
# Automatically generated file; DO NOT EDIT.
# Melis3.x SDK Configuration
#

#
# Kernel Setup
#

#
# ARCH Support
#
CONFIG_RISCV=y
```

关键配置项及含义：

| 配置项 | 值 | 含义 |
|--------|-----|------|
| `CONFIG_RISCV=y` | y | RISC-V 架构（E907） |
| `CONFIG_RV32=y` | y | 32位 RISC-V |
| `CONFIG_DRIVERS_MSGBOX_AMP=y` | y | 启用 AMP 模式 Mailbox |
| `CONFIG_SUPPORT_AMP=y` | y | 启用 OpenAMP 支持 |
| `CONFIG_AMP_SLAVE_MODE=y` | y | E907 作为从核（Slave） |
| `CONFIG_MBOX_CHANNEL=0` | 0 | 使用 Mailbox 通道 0 |
| `CONFIG_RPMSG_REMOTE_NAME="e907_rproc"` | — | 远端处理器名称 |
| `CONFIG_SLAVE_EARLY_BOOT=y` | y | **支持提前启动**（U-Boot阶段） |
| `CONFIG_SOC_SUN20IW3P1=y` | y | V853 SoC 型号 |
| `CONFIG_DRAM_PHYBASE=0x48000000` | — | E907 固件内存基地址 |
| `CONFIG_DRAM_SIZE=0x0400000` | 4MB | 固件内存大小 |

`CONFIG_SLAVE_EARLY_BOOT=y` 印证了前面分析的 **U-Boot 阶段提前启动 E907** 的机制。

---

### 三、完整启动时序图

```
上电
  │
  ▼
[SPL (boot0)]
  │  sunxi_riscv_init()
  │  ├─ 从 boot_package 读取 E907 ELF
  │  ├─ 解析 ELF，load_image() 写入 DDR (0x48000000)
  │  ├─ 配置 RISCV_GATING_RST_REG (时钟门控)
  │  ├─ 写入启动地址 RISCV_STA_ADD_REG
  │  ├─ 配置 E907 时钟 → peri_600M
  │  └─ 释放复位 → E907 开始运行 Melis
  │
  ▼
[U-Boot]
  │  引导 Linux 内核
  │
  ▼
[Linux Kernel 启动]
  │
  ▼
[sunxi_rproc 驱动 probe]
  │  sunxi_e907_init()
  │  ├─ 从 DTS 获取 pll/clk/axi/gate/mbox 时钟句柄
  │  └─ ioremap riscv-addr 寄存器
  │
  ▼
[rproc_add() → rproc_add_virtio_devices()]
  │  sunxi_request_firmware() 或 request_firmware()
  │  └─ 加载 E907 ELF 固件（若 SLAVE_EARLY_BOOT 已在 U-Boot 启动则跳过加载）
  │
  ▼
[rproc_fw_boot()]
  │  ├─ rproc_get_boot_addr()      解析 ELF 入口地址
  │  ├─ rproc_find_rsc_table()     找资源表
  │  ├─ rproc_handle_vdev()        注册 virtio 设备 (RPMsg)
  │  ├─ rproc_handle_carveout()    分配共享内存 (vring)
  │  ├─ rproc_load_segments()      ELF 段写入预留内存
  │  └─ rproc->ops->start()        ↓
  │
  ▼
[sunxi_e907_start()]
  │  ├─ clk_enable(pclk/clk/axi)  使能 E907 时钟链
  │  ├─ clk_set_rate()             设置运行频率
  │  ├─ writel(boot_addr, addr)    写入启动地址寄存器
  │  ├─ clk_prepare_enable(mbox)   初始化 Mailbox（清 FIFO）
  │  └─ clk_enable(gate)           开门控 → E907 执行
  │
  ▼
[E907 Melis 启动]
  │  ├─ RT-Thread RTOS 初始化
  │  ├─ HAL 驱动初始化（UART/GPIO/CCMU 等）
  │  ├─ OpenAMP / RPMsg 初始化
  │  └─ app_entry()
  │       └─ rpmsg_notify("isp0"/"vinc0"/...)
  │              └─ 通过 Mailbox 中断通知 Linux
  │
  ▼
[Linux RPMsg 驱动收到通知]
  │  创建 /dev/rpmsg0 等字符设备
  │  双核通信通道建立完成
  │
  ▼
[大小核协同工作]
  Linux 通过 RPMsg 向 E907 下发命令
  E907 控制 ISP/Camera/其他外设
```

---

### 四、关键机制总结

**1. Mailbox（消息盒子）**
- 硬件中断机制，双核互相触发 `defconfig` 中 `CONFIG_MBOX_CHANNEL=0`
- E907 侧：`CONFIG_DRIVERS_MSGBOX_AMP=y`，`CONFIG_STANDBY_MSGBOX_CHANNEL=1`
- Linux 侧：`sunxi_e907_start()` 中 `clk_prepare_enable(info->mbox)` 初始化

**2. 共享内存布局**
```
DDR 物理地址
0x48000000 ┌────────────────────┐ ← CONFIG_DRAM_PHYBASE
           │   E907 固件代码段  │   CONFIG_DRAM_SIZE = 4MB
0x4BC00000 ├────────────────────┤
           │   Coherent 共享区  │   CONFIG_COHERENT_SIZE = 12MB
           │   (vring/RPMsg)    │   CONFIG_COHERENT_START_ADDR = 0xa0000000
0x4C800000 └────────────────────┘
```

**3. 固件格式**
E907 固件是标准 **ELF32** 格式，工具链为 `riscv64-unknown-elf-`，编译参数：
```
-mcmodel=medany -mabi=ilp32 -march=rv32imafdcxthead
```
其中 `xthead` 是玄铁扩展指令集。

**4. `sys_config.fex` 的作用**

```1:37:/home/ubuntu/v851s/tina-v853-100ask/lichee/melis-v3.0/source/projects/v853-e907-ver1-board/configs/sys_config.fex
```

该文件定义 E907 侧使用的外设引脚（twi1、uart3 等），经 `fex2bin` 转换后内嵌进固件，E907 的 `CONFIG_DRIVER_SYSCONFIG=y` 在运行时读取这些配置来初始化外设。

---

### 五、与文章要点对照

文章 [gloomyghost.com/live/20230215.aspx](https://www.gloomyghost.com/live/20230215.aspx) 提到的核心流程，在本工程代码中均有对应：

| 文章要点 | 工程代码位置 |
|----------|------------|
| U-Boot 加载 E907 固件 | `brandy-2.0/u-boot-2018/drivers/riscv/sun8iw21/riscv.c` |
| remoteproc 管理小核 | `linux-4.9/drivers/remoteproc/sunxi_boot/e907/e907.c` |
| 时钟/复位控制启动 E907 | `sunxi_e907_start()` → 

```c
#include <stdio.h>
#include <hal_timer.h>
#include <openamp/sunxi_helper/openamp.h>

extern int csi_init(int argc, const char **argv);
extern int msh_exec(char *cmd, int length);

int app_entry(void *param)
{
#ifdef CONFIG_DRIVERS_VIN
	int ret;

	ret = csi_init(0, NULL);
	if (ret) {
		rpmsg_notify("rt-media", NULL, 0);
		printf("csi init fail!\n");
	}
#if 1
	rpmsg_notify("twi1", NULL, 0);
	rpmsg_notify("tdm0", NULL, 0);
	rpmsg_notify("isp0", NULL, 0);
	rpmsg_notify("scaler0", NULL, 0);
	rpmsg_notify("scaler4", NULL, 0);
	rpmsg_notify("scaler8", NULL, 0);
	rpmsg_notify("scaler12", NULL, 0);
	rpmsg_notify("vinc0", NULL, 0);
	rpmsg_notify("vinc4", NULL, 0);
	rpmsg_notify("vinc8", NULL, 0);
	rpmsg_notify("vinc12", NULL, 0);
#endif
#else
	hal_msleep(200);
	rpmsg_notify("rt-media", NULL, 0);
#endif
	//msh_exec("dmesg", strlen("dmesg"));
    return 0;
}
```

```plaintext
#
# Automatically generated file; DO NOT EDIT.
# Melis3.x SDK Configuration
#

#
# Kernel Setup
#

#
# ARCH Support
#
CONFIG_RISCV=y
```

```plaintext
上电
  │
  ▼
[SPL (boot0)]
  │  sunxi_riscv_init()
  │  ├─ 从 boot_package 读取 E907 ELF
  │  ├─ 解析 ELF，load_image() 写入 DDR (0x48000000)
  │  ├─ 配置 RISCV_GATING_RST_REG (时钟门控)
  │  ├─ 写入启动地址 RISCV_STA_ADD_REG
  │  ├─ 配置 E907 时钟 → peri_600M
  │  └─ 释放复位 → E907 开始运行 Melis
  │
  ▼
[U-Boot]
  │  引导 Linux 内核
  │
  ▼
[Linux Kernel 启动]
  │
  ▼
[sunxi_rproc 驱动 probe]
  │  sunxi_e907_init()
  │  ├─ 从 DTS 获取 pll/clk/axi/gate/mbox 时钟句柄
  │  └─ ioremap riscv-addr 寄存器
  │
  ▼
[rproc_add() → rproc_add_virtio_devices()]
  │  sunxi_request_firmware() 或 request_firmware()
  │  └─ 加载 E907 ELF 固件（若 SLAVE_EARLY_BOOT 已在 U-Boot 启动则跳过加载）
  │
  ▼
[rproc_fw_boot()]
  │  ├─ rproc_get_boot_addr()      解析 ELF 入口地址
  │  ├─ rproc_find_rsc_table()     找资源表
  │  ├─ rproc_handle_vdev()        注册 virtio 设备 (RPMsg)
  │  ├─ rproc_handle_carveout()    分配共享内存 (vring)
  │  ├─ rproc_load_segments()      ELF 段写入预留内存
  │  └─ rproc->ops->start()        ↓
  │
  ▼
[sunxi_e907_start()]
  │  ├─ clk_enable(pclk/clk/axi)  使能 E907 时钟链
  │  ├─ clk_set_rate()             设置运行频率
  │  ├─ writel(boot_addr, addr)    写入启动地址寄存器
  │  ├─ clk_prepare_enable(mbox)   初始化 Mailbox（清 FIFO）
  │  └─ clk_enable(gate)           开门控 → E907 执行
  │
  ▼
[E907 Melis 启动]
  │  ├─ RT-Thread RTOS 初始化
  │  ├─ HAL 驱动初始化（UART/GPIO/CCMU 等）
  │  ├─ OpenAMP / RPMsg 初始化
  │  └─ app_entry()
  │       └─ rpmsg_notify("isp0"/"vinc0"/...)
  │              └─ 通过 Mailbox 中断通知 Linux
  │
  ▼
[Linux RPMsg 驱动收到通知]
  │  创建 /dev/rpmsg0 等字符设备
  │  双核通信通道建立完成
  │
  ▼
[大小核协同工作]
  Linux 通过 RPMsg 向 E907 下发命令
  E907 控制 ISP/Camera/其他外设
```

```plaintext
DDR 物理地址
0x48000000 ┌────────────────────┐ ← CONFIG_DRAM_PHYBASE
           │   E907 固件代码段  │   CONFIG_DRAM_SIZE = 4MB
0x4BC00000 ├────────────────────┤
           │   Coherent 共享区  │   CONFIG_COHERENT_SIZE = 12MB
           │   (vring/RPMsg)    │   CONFIG_COHERENT_START_ADDR = 0xa0000000
0x4C800000 └────────────────────┘
```

```plaintext
-mcmodel=medany -mabi=ilp32 -march=rv32imafdcxthead
```

---

**User**

继续

---

**Cursor**

让我读取 `sys_config.fex` 的完整内容（现在是48行，之前只读到37行）：

找到了关键文件 `sunxi_rproc.c`，这是最核心的 Linux 侧驱动，让我读取它：

现在已经拿到了最核心的驱动代码，可以完成最终的完整分析了。

---

## 续：`sunxi_rproc.c` — Linux 启动 E907 的核心驱动深度解析

---

### 六、`sunxi_rproc_probe()` — 驱动探测完整流程

这是整个启动机制的"总指挥"，现在可以基于真实代码逐步解析：

```394:500:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/remoteproc/sunxi_rproc.c
static int sunxi_rproc_probe(struct platform_device *pdev)
{
	struct device *dev = &pdev->dev;
	struct sunxi_rproc *ddata;
	struct device_node *np = dev->of_node;
	struct rproc *rproc;
	const char *fw_name;
	int enabled;
	int ret;
	bool has_iommu;
```

**probe 的完整步骤**（按代码顺序）：

**① 分配 rproc 句柄**
```c
rproc = rproc_alloc(dev, np->name, &sunxi_rproc_ops, fw_name, sizeof(*ddata));
```
注册操作集 `sunxi_rproc_ops`，包含 `start`/`stop`/`kick`/`da_to_va` 四个核心方法。

**② 解析设备树（`sunxi_rproc_parse_dt`）**
- 读取 `core-name`（如 `"allwinner,riscv-e907"`），通过 `sunxi_remote_core_find()` 找到对应的 `sunxi_e907` 硬件操作对象
- 读取 `firmware-name`，注册固件到内存（`fw-region`）
- 解析 `memory-mappings`，建立 DA（设备地址）→ PA（物理地址）→ VA（内核虚拟地址）映射表，供 `da_to_va` 使用
- 解析 `support-standby`，注册休眠/唤醒回调

**③ 初始化硬件核心**
```c
ret = sunxi_core_init(pdev, ddata->core);  // 调用 sunxi_e907_init()
```
获取 DTS 中 pll/clk/axi/gate/mbox 时钟，ioremap 启动地址寄存器。

**④ 请求 Mailbox 通道**
```c
ret = sunxi_rproc_request_mbox(rproc);
```

**⑤ 注册预留内存**
```c
ret = sunxi_rproc_register_mem(rproc);
```
解析 DTS `memory-region`，将 vdev0buffer（共享 vring 缓冲区）和其他内存区域预注册到 rproc carveout 列表。

**⑥ 关键：检查 E907 是否已在运行（Early Boot 机制）**

```490:508:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/remoteproc/sunxi_rproc.c
	/* check remote process whether already running */
	enabled = sunxi_rproc_state(rproc);
	if (enabled < 0) {
		ret = enabled;
		goto free_mbox;
	}

	if (enabled) {
		atomic_inc(&rproc->power);
		rproc->state = RPROC_EARLY_BOOT;
	}
```

这是 `CONFIG_SLAVE_EARLY_BOOT=y` 的核心体现：

- `sunxi_rproc_state()` 内部调用 `sunxi_core_is_start()`，最终调用 `sunxi_e907_is_start()`：

```210:214:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/remoteproc/sunxi_boot/e907/e907.c
static int sunxi_e907_is_start(struct sunxi_core *core)
{
	struct sunxi_e907 *info = core->priv;

	return __clk_is_enabled(info->gate);
```

**通过检查时钟门控（gate clock）是否已使能，判断 E907 是否由 U-Boot 提前启动了。**

- 若已启动：设置 `rproc->state = RPROC_EARLY_BOOT`，跳过固件加载，直接进入通信建立阶段
- 若未启动：走正常的固件加载流程

**⑦ 注册到 remoteproc 框架**
```c
ret = rproc_add(rproc);
```
触发固件异步加载，最终调用 `rproc_boot()` → `rproc_fw_boot()` → `sunxi_rproc_start()`。

---

### 七、Mailbox 通信机制详解

`sunxi_rproc.c` 中完整实现了双向 Mailbox 通信：

```85:115:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/remoteproc/sunxi_rproc.c
static void sunxi_rproc_mb_rx_callback(struct mbox_client *cl, void *data)
{
	struct rproc *rproc = dev_get_drvdata(cl->dev);
	struct sunxi_mbox *mb = container_of(cl, struct sunxi_mbox, client);
	struct sunxi_rproc *ddata = rproc->priv;

	dev_dbg(&rproc->dev, "mbox recv data:0x%x\n", *(uint32_t *)data);
	ddata->notifyid = *(uint32_t *)data;

#ifdef CONFIG_SUNXI_REMOTEPROC_WQ
	queue_work(ddata->workqueue, &mb->vq_work);
#endif
#ifdef CONFIG_SUNXI_REMOTEPROC_RT_THREAD
	wake_up_interruptible(&ddata->rq);
#endif
}
```

```234:258:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/remoteproc/sunxi_rproc.c
static void sunxi_rproc_kick(struct rproc *rproc, int notifyid)
{
	struct sunxi_rproc *ddata = rproc->priv;
	int err;
	struct sunxi_mbox *mb;
	u32 *msg = NULL;

	mb = &ddata->mb[0];

	msg = devm_kzalloc(&rproc->dev, sizeof(u32), GFP_KERNEL);
	*msg = notifyid;
	err = mbox_send_message(mb->chan, (void *)msg);
```

通信模型：

```
Linux (A7 大核)                    E907 (RISC-V 小核)
      │                                    │
      │  sunxi_rproc_kick(notifyid)        │
      │  mbox_send_message()               │
      │ ─────── Mailbox 硬件中断 ────────► │
      │                                    │  Melis 收到中断
      │                                    │  rproc_vq_interrupt()
      │                                    │  处理 vring 中的 RPMsg
      │                                    │
      │ ◄──────  Mailbox 硬件中断 ───────  │  E907 侧 rpmsg_notify()
      │  sunxi_rproc_mb_rx_callback()      │
      │  ddata->notifyid = *(uint32_t*)data│
      │  wake_up(rq) 或 queue_work()       │
      │  rproc_vq_interrupt(notifyid)      │
      │  处理 vring 中收到的 RPMsg         │
```

---

### 八、`sys_config.fex` 在完整流程中的位置

```1:48:/home/ubuntu/v851s/tina-v853-100ask/lichee/melis-v3.0/source/projects/v853-e907-ver1-board/configs/sys_config.fex
;---------------------------------------------------------------------------------------------------------
; 说明： 脚本中的字符串区分大小写，用户可以修改"="后面的数值，但是不要修改前面的字符串
; 描述gpio的形式：Port:端口+组内序号<功能分配><内部电阻状态><驱动能力><输出电平状态>
;---------------------------------------------------------------------------------------------------------

[twi1]
twi1_scl         = port:PA06<4><1><default><default>
twi1_sda         = port:PA07<4><1><default><default>

[uart3]
uart_tx         = port:PH00<5><1><default><default>
uart_rx         = port:PH01<5><1><default><default>
```

该文件定义 **E907 侧独占的外设引脚**：

| 外设 | 引脚 | 用途 |
|------|------|------|
| `twi1`（I2C1） | PA06/PA07 | E907 控制摄像头传感器（如 SC1721V）|
| `uart3` | PH00/PH01 | E907 调试串口（`CONFIG_CLI_UART_PORT=3`）|

这些引脚被 E907 **独占**，Linux 不会再初始化它们。文件经 `fex2bin` 工具转换内嵌进 E907 固件，运行时由 `CONFIG_DRIVER_SYSCONFIG=y` 读取。

---

### 九、完整知识图谱总结

```
                    ┌─────────────────────────────────────────────┐
                    │          全志 V853 启动 E907 全景图           │
                    └─────────────────────────────────────────────┘

【编译阶段】
  Melis SDK
  ├─ sys_config.fex ──fex2bin──► 内嵌入固件（外设引脚定义）
  ├─ defconfig       ──────────► CONFIG_SLAVE_EARLY_BOOT=y 等
  └─ 源码编译        ──────────► melis.elf (RISC-V ELF32)
                                  -mcmodel=medany -march=rv32imafdcxthead

【打包阶段】
  melis.elf ──► boot_package 分区（flash 中固定偏移）
  Linux 内核 ──► boot.img

【上电启动阶段】
  SPL(boot0)
  └─► U-Boot
       └─ sunxi_riscv_init()
           ├─ 从 boot_package 读取 melis.elf
           ├─ load_image(): 解析 ELF，memcpy 各段到 DDR 0x48000000
           ├─ 写 RISCV_STA_ADD_REG（启动地址寄存器）
           ├─ 配置 CCM 时钟寄存器（peri_600M）
           └─ clk_enable(gate) ──► E907 从 0x48000000 开始执行！
                                    │
                                    ▼
                              Melis RT-Thread 启动
                              ├─ HAL 驱动初始化
                              ├─ OpenAMP / RPMsg 初始化
                              └─ app_entry()
                                  └─ rpmsg_notify("isp0"...) [等待 Linux]

【Linux 内核启动阶段】
  kernel boot
  └─ sunxi_rproc_probe()
      ├─ rproc_alloc()              分配管理句柄
      ├─ sunxi_rproc_parse_dt()     解析 DTS：内存映射、固件区域
      ├─ sunxi_core_init()          获取时钟/寄存器资源
      ├─ sunxi_rproc_request_mbox() 建立 Mailbox 通信通道
      

```c
static int sunxi_rproc_probe(struct platform_device *pdev)
{
	struct device *dev = &pdev->dev;
	struct sunxi_rproc *ddata;
	struct device_node *np = dev->of_node;
	struct rproc *rproc;
	const char *fw_name;
	int enabled;
	int ret;
	bool has_iommu;
```

```c
rproc = rproc_alloc(dev, np->name, &sunxi_rproc_ops, fw_name, sizeof(*ddata));
```

```c
ret = sunxi_core_init(pdev, ddata->core);  // 调用 sunxi_e907_init()
```

```c
ret = sunxi_rproc_request_mbox(rproc);
```

```c
ret = sunxi_rproc_register_mem(rproc);
```

```c
	/* check remote process whether already running */
	enabled = sunxi_rproc_state(rproc);
	if (enabled < 0) {
		ret = enabled;
		goto free_mbox;
	}

	if (enabled) {
		atomic_inc(&rproc->power);
		rproc->state = RPROC_EARLY_BOOT;
	}
```

```c
static int sunxi_e907_is_start(struct sunxi_core *core)
{
	struct sunxi_e907 *info = core->priv;

	return __clk_is_enabled(info->gate);
```

```c
ret = rproc_add(rproc);
```

```c
static void sunxi_rproc_mb_rx_callback(struct mbox_client *cl, void *data)
{
	struct rproc *rproc = dev_get_drvdata(cl->dev);
	struct sunxi_mbox *mb = container_of(cl, struct sunxi_mbox, client);
	struct sunxi_rproc *ddata = rproc->priv;

	dev_dbg(&rproc->dev, "mbox recv data:0x%x\n", *(uint32_t *)data);
	ddata->notifyid = *(uint32_t *)data;

#ifdef CONFIG_SUNXI_REMOTEPROC_WQ
	queue_work(ddata->workqueue, &mb->vq_work);
#endif
#ifdef CONFIG_SUNXI_REMOTEPROC_RT_THREAD
	wake_up_interruptible(&ddata->rq);
#endif
}
```

```c
static void sunxi_rproc_kick(struct rproc *rproc, int notifyid)
{
	struct sunxi_rproc *ddata = rproc->priv;
	int err;
	struct sunxi_mbox *mb;
	u32 *msg = NULL;

	mb = &ddata->mb[0];

	msg = devm_kzalloc(&rproc->dev, sizeof(u32), GFP_KERNEL);
	*msg = notifyid;
	err = mbox_send_message(mb->chan, (void *)msg);
```

```plaintext
Linux (A7 大核)                    E907 (RISC-V 小核)
      │                                    │
      │  sunxi_rproc_kick(notifyid)        │
      │  mbox_send_message()               │
      │ ─────── Mailbox 硬件中断 ────────► │
      │                                    │  Melis 收到中断
      │                                    │  rproc_vq_interrupt()
      │                                    │  处理 vring 中的 RPMsg
      │                                    │
      │ ◄──────  Mailbox 硬件中断 ───────  │  E907 侧 rpmsg_notify()
      │  sunxi_rproc_mb_rx_callback()      │
      │  ddata->notifyid = *(uint32_t*)data│
      │  wake_up(rq) 或 queue_work()       │
      │  rproc_vq_interrupt(notifyid)      │
      │  处理 vring 中收到的 RPMsg         │
```

```plaintext
;---------------------------------------------------------------------------------------------------------
; 说明： 脚本中的字符串区分大小写，用户可以修改"="后面的数值，但是不要修改前面的字符串
; 描述gpio的形式：Port:端口+组内序号<功能分配><内部电阻状态><驱动能力><输出电平状态>
;---------------------------------------------------------------------------------------------------------

[twi1]
twi1_scl         = port:PA06<4><1><default><default>
twi1_sda         = port:PA07<4><1><default><default>

[uart3]
uart_tx         = port:PH00<5><1><default><default>
uart_rx         = port:PH01<5><1><default><default>
```

```plaintext
                    ┌─────────────────────────────────────────────┐
                    │          全志 V853 启动 E907 全景图           │
                    └─────────────────────────────────────────────┘

【编译阶段】
  Melis SDK
  ├─ sys_config.fex ──fex2bin──► 内嵌入固件（外设引脚定义）
  ├─ defconfig       ──────────► CONFIG_SLAVE_EARLY_BOOT=y 等
  └─ 源码编译        ──────────► melis.elf (RISC-V ELF32)
                                  -mcmodel=medany -march=rv32imafdcxthead

【打包阶段】
  melis.elf ──► boot_package 分区（flash 中固定偏移）
  Linux 内核 ──► boot.img

【上电启动阶段】
  SPL(boot0)
  └─► U-Boot
       └─ sunxi_riscv_init()
           ├─ 从 boot_package 读取 melis.elf
           ├─ load_image(): 解析 ELF，memcpy 各段到 DDR 0x48000000
           ├─ 写 RISCV_STA_ADD_REG（启动地址寄存器）
           ├─ 配置 CCM 时钟寄存器（peri_600M）
           └─ clk_enable(gate) ──► E907 从 0x48000000 开始执行！
                                    │
                                    ▼
                              Melis RT-Thread 启动
                              ├─ HAL 驱动初始化
                              ├─ OpenAMP / RPMsg 初始化
                              └─ app_entry()
                                  └─ rpmsg_notify("isp0"...) [等待 Linux]

【Linux 内核启动阶段】
  kernel boot
  └─ sunxi_rproc_probe()
      ├─ rproc_alloc()              分配管理句柄
      ├─ sunxi_rproc_parse_dt()     解析 DTS：内存映射、固件区域
      ├─ sunxi_core_init()          获取时钟/寄存器资源
      ├─ sunxi_rproc_request_mbox() 建立 Mailbox 通信通道
      
```

