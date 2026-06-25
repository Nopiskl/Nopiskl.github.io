# Analysis of arisc directory and MCU compatibility
_Exported on 2026/4/22 at GMT+8 10:28:30 from Cursor (2.6.21)_

---

**User**

brandy/arisc
能否基于当前SDK目标A733+agent分析报告agent/a733_t736_mcu_support_analysis.md，分析一下
1、这个arisc目录是干什么的？有什么用？具体介绍一下brandy/arisc/ar100s
2、为什么其他C906、E907等MCU可以运行rtos目录下的rtos，而A733只能运行brandy/arisc/ar100s这个？


---

**Cursor**

可以，基于你给的分析报告和当前源码，我把这两个问题串起来解释一下。

先说结论：

1. `brandy/arisc` 不是普通意义上的“应用 RTOS 工程目录”，它本质上是 Allwinner 这套 SoC 里的“系统控制小核固件”工程，负责电源、待机唤醒、CPU 热插拔/上电、消息通信等偏底层的系统管理。
2. 对 A733 来说，当前 SDK 里小核固件并不走 `rtos/lichee/rtos` 这条“通用 RTOS 应用”路线，而是走 `brandy/arisc/ar100s` 这条“系统控制固件”路线。
3. 其他芯片上的 C906/E907 往往被当成“可编程业务 MCU / 协处理器”来跑 FreeRTOS；而 A733 上这颗小核在当前 SDK 里的定位更接近 SCP/ARISC 电源管理核，所以只能看到它运行 `ar100s`。

---

## 1. `brandy/arisc` 是干什么的？`brandy/arisc/ar100s` 有什么用？

### 1.1 `arisc` 的本质定位

从你这个 SDK 来看，`brandy/arisc` 是一套给“小系统控制核”使用的固件工程，不是给用户随便写业务逻辑的 MCU APP 框架。

它的职责更像：

- SoC 上电后的辅助控制核固件
- Linux/大核的系统管理协处理器
- 待机/唤醒/电源域/时钟域管理固件
- 大核和小核之间的消息中介

从 `ar100s` 的启动流程就能看出来，它初始化的不是 UI、网络、文件系统那一套，而是一堆系统控制组件：

```96:163:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/system/daemon/daemon.c
void startup_entry(void)
{
	dtb_base_init();

	jtag_init();

	notifier_init();
	save_state_flag(REC_HOTPULG | 0x0);

	ccu_init();
	save_state_flag(REC_HOTPULG | 0x1);

	pin_init();
	save_state_flag(REC_HOTPULG | 0x2);

	save_state_flag(REC_HOTPULG | 0x3);

	interrupt_init();
	save_state_flag(REC_HOTPULG | 0x4);

	arisc_para_init();
	save_state_flag(REC_HOTPULG | 0x5);

	debugger_init();
	save_state_flag(REC_HOTPULG | 0x6);

	twi_init();
	...
	pmu_init();
	bmu_init();
	...
	hwmsgbox_init();
	amp_msgbox_init();
	...
	cpucfg_init();
	...
	message_manager_init();
	...
	timer_init();
	...
	standby_init();
	...
	watchdog_init();
	...
	startup_state_notify(OK);
	...
	daemon_main();
}
```

这里初始化的核心能力包括：

- `ccu_init()`：时钟控制
- `pmu_init()/bmu_init()`：电源管理
- `hwmsgbox_init()`：和大核做硬件消息通信
- `cpucfg_init()`：CPU 上下电、启动地址配置
- `standby_init()`：待机唤醒
- `watchdog_init()`：看门狗
- `twi_init()`：I2C/TWI，用于 PMIC 等外设控制

所以它更像“片上系统管理固件”，而不是“通用 MCU FreeRTOS Demo”。

---

### 1.2 `ar100s` 这个名字的含义

`ar100s` 是 Allwinner 这套历史架构沿袭下来的名字。

早期 Allwinner SoC 里常见一个叫 `AR100` 的小控制核，负责：

- standby
- PMU/AXP 控制
- 唤醒源管理
- 和主 CPU 通信

虽然现在新平台底层 CPU 架构可能已经从早年的 OpenRISC、再到 RISC-V 变化了，但这套“系统控制固件框架”仍然沿用了 `ar100s` 这个目录名。

也就是说：

- `ar100s` 已经不一定意味着“CPU 就是 AR100 那颗老核”
- 更准确地说，它代表的是“ARISC/SCP 这类系统控制固件软件栈”

---

### 1.3 `ar100s` 的结构可以怎么理解

从目录结构看，`ar100s` 基本是一个“小型系统固件框架”：

- `arch/`：架构相关代码
- `driver/`：底层硬件驱动
- `service/`：系统服务，如 standby
- `system/`：系统框架，如 daemon、message manager、debugger
- `library/`：基础库
- `arch/configs/*_defconfig`：各芯片配置

你当前 A733 的平台选择也很明确：

```1:61:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/arch/Kconfig
config SUN60IW2P1
	bool
	imply CPUX_ARM64
	select RISCV
	select AR100S_OS
	prompt "AW1903 sun60iw2p1 A733 platform"
```

说明：

- A733 对应 `SUN60IW2P1`
- 这条线选择的是 `RISCV`
- 使用的是 `AR100S_OS`

也就是说，A733 的小核固件在 SDK 里被归类进 `ar100s` 这套系统。

---

### 1.4 A733 上 `ar100s` 具体在做什么

#### 1）负责和主核通信

消息处理入口在这里：

```34:94:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/system/message_manager/message_manager.c
static s32 process_message(struct message *pmessage)
{
	...
	switch (pmessage->type) {

	case CPU_OP_REQ:
		result = cpu_op(pmessage);
		break;

	case SYS_OP_REQ:
		result = sys_op(pmessage);
		break;

	case CLEAR_WAKEUP_SRC_REQ:
		result = clear_wakeup_src(pmessage);
		break;

	case SET_WAKEUP_SRC_REQ:
		result = set_wakeup_src(pmessage);
		break;

	case FAKE_POWER_OFF_REQ:
		result = fake_poweroff(pmessage);
		break;

	case SET_DEBUG_LEVEL_REQ:
		result = set_debug_level(pmessage->paras[0]);
		break;

	case SET_UART_BAUDRATE:
		result = uart_set_baudrate(pmessage->paras[0]);
		break;

	case SET_DRAM_CRC_PARAS:
		result = standby_set_dram_crc_paras(...);
		break;

	case SET_DDRFREQ:
		...
		result = mctl_mdfs_software(...);
		break;
```

这说明 Linux/大核会把这些“系统控制请求”发给小核：

- CPU 操作
- 系统操作
- 唤醒源设置
- 假关机
- 串口波特率调整
- DRAM CRC / DDR 频率

这就是典型的 SCP/PMU 核职责，不是普通 RTOS APP 职责。

---

#### 2）负责 CPU 热插拔/上电恢复

例如 A733 平台上的 CPU 控制代码：

```8:68:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/driver/cpucfg/cpucfg-sun60iw2p1/sunxi_cpu_ops.c
void sunxi_set_bootaddr(unsigned int cluster, unsigned int cpu, uintptr_t entry)
{
	mmio_write_32(SUNXI_CPUCFG_RVBAR_LO_REG(cpu), entry);
	mmio_write_32(SUNXI_CPUCFG_RVBAR_HI_REG(cpu), 0);
}
...
void sunxi_poweron_cpu(unsigned int cluster, unsigned int core)
{
	mmio_setbits_32(HOTPLUG_CONTROL_REG(core), HOTPLUG_EN);
	mmio_setbits_32(HOTPLUG_POWERMODE_REG(core), POWER_ON);

	while (!sunxi_get_cpu_powerstate(cluster, core)) {
	}
	...
}
...
int cpucfg_cpu_resume(unsigned int resume_addr)
{
	sunxi_set_bootaddr(0, 0, resume_addr);
	sunxi_init_archstate(0, 0, 1);
	sunxi_poweron_cpu(0, 0);

	return 0;
}
```

这里做的是：

- 设置主 CPU 恢复入口地址
- 设置主 CPU 运行架构状态
- 控制 CPU 上电/掉电

这完全是系统电源管理固件职责。

---

#### 3）负责待机和唤醒

A733 平台寄存器定义里直接出现了 E902 相关寄存器：

```18:45:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/arch/riscv/plat-sun60iw2p1/inc/platform_regs.h
#define R_INTC_REG_BASE		(0x07024000)
#define R_PIO_REG_BASE		(0x07025000)
#define E902_CFG_BASE		(0x07032000)
...
#define RV_CLK_16M		(0x82000000)

#define E902_AUTO_GATE_REG	(E902_CFG_BASE + 0x04)
```

这类寄存器一般就是为了：

- 小核本身低功耗控制
- standby 进入/退出流程
- 时钟切换
- 唤醒路径管理

所以 `ar100s` 在 A733 上直接承担了系统级 low-power controller 的角色。

---

### 1.5 `ar100s` 是不是 RTOS？

严格说，它不是你在 `rtos/lichee/rtos` 里看到的那套“通用 FreeRTOS 业务工程”。

但它又不是“纯裸机一坨代码”，它本身是有 OS 化组织的。比如在 Kconfig 里就有：

```1:61:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/arch/Kconfig
config AR100S_OS
	bool
```

它有：

- daemon 主循环
- notifier 机制
- message manager
- debugger
- service/driver/system 分层

所以可以把它理解成：

- 一套“专用系统固件 OS 框架”
- 目标不是跑业务应用，而是跑 SoC 管理逻辑

---

## 2. 为什么 C906、E907 可以运行 `rtos/`，而 A733 只能运行 `brandy/arisc/ar100s`？

这个问题本质上不是“CPU 指令集能不能跑 FreeRTOS”，而是：

**这个 SoC 里那颗小核被 SDK 定义成什么角色。**

---

### 2.1 `rtos/lichee/rtos` 本身就没有 A733 的平台入口

报告里已经指出，`rtos` 这套工程当前支持的平台是这些：

```1:55:/home/alientek/A733/qihua-x73x-linux6.6/rtos/lichee/rtos/arch/risc-v/Kconfig
config ARCH_SUN8IW20
	select ARCH_RISCV_C906

config ARCH_SUN20IW2
	select ARCH_RISCV_C906

config ARCH_SUN55IW3
	select ARCH_RISCV_E906

config ARCH_SUN55IW6
	select ARCH_RISCV_E907

config ARCH_SUN60IW1
	select ARCH_RISCV_E906
```

没有：

- `ARCH_SUN60IW2`
- 没有 A733 对应项
- 没有 E902 对应项

所以第一层原因很直接：

**当前 SDK 里的 `rtos/` 根本没给 A733/sun60iw2p1 留入口。**

---

### 2.2 `rtos/` 里的项目也不是面向 A733 的

项目侧也能印证这一点：

```1:31:/home/alientek/A733/qihua-x73x-linux6.6/rtos/lichee/rtos/projects/Kconfig
config PROJECT_T527_E906_DEMO
config PROJECT_T527_E906_DEMO_FASTBOOT
config PROJECT_T527_E906_DEMO_FASTBOOT_ANDROID
config PROJECT_T527_DEMO
```

没有 A733 项目，也没有 sun60iw2p1 项目。

说明 `rtos/` 当前的产品化落地场景，主要是：

- T527 E906
- 其他已有 C906/E906/E907 方案

而不是 A733。

---

### 2.3 A733 的构建脚本明确指定走 `ar100s`

A733 的板级脚本不是去生成 `rtos` 的配置，而是明确输出：

```1:10:/home/alientek/A733/qihua-x73x-linux6.6/device/config/chips/a733/tools/arisc_config_parse.sh
pmu_type_parse()
{
	rm -f $ARISC_CONFIG_FILE
	touch $ARISC_CONFIG_FILE
	echo "export LICHEE_ARISC_DEFDIR=ar100s" >> $ARISC_CONFIG_FILE
	echo "export LICHEE_ARISC_DEFCONFIG=sun60iw2p1_defconfig" >> $ARISC_CONFIG_FILE
}
```

T736 也是一样：

```1:10:/home/alientek/A733/qihua-x73x-linux6.6/device/config/chips/t736/tools/arisc_config_parse.sh
pmu_type_parse()
{
	rm -f $ARISC_CONFIG_FILE
	touch $ARISC_CONFIG_FILE
	echo "export LICHEE_ARISC_DEFDIR=ar100s" >> $ARISC_CONFIG_FILE
	echo "export LICHEE_ARISC_DEFCONFIG=sun60iw2p1_defconfig" >> $ARISC_CONFIG_FILE
}
```

这意味着：

- SDK 在产品层面已经把 A733/T736 的小核固件路线锁定到 `ar100s`
- 它不是“能不能跑 `rtos/`”的问题
- 而是“官方构建体系根本没把它接到 `rtos/` 上”

---

### 2.4 构建系统也明确编的是 `brandy/arisc`

`build/mkcmd.sh` 里把 `LICHEE_ARISC_PATH` 固定为：

```70:85:/home/alientek/A733/qihua-x73x-linux6.6/build/mkcmd.sh
export LICHEE_ARISC_PATH=${LICHEE_TOP_DIR}/brandy/arisc
```

结合报告描述，构建流程是：

- 板级脚本生成 `arisc.config`
- 拷贝到 `brandy/arisc/.config`
- 再 `make -C brandy/arisc`

所以 A733 当前整个小核固件链路，从配置到构建到打包，都是 `brandy/arisc`。

---

### 2.5 C906/E907 为什么常跑 `rtos/`？

因为在很多 Allwinner 芯片里，C906/E906/E907 的定位是：

- 通用协处理器
- 音频/算法/控制业务核
- 可以跑用户应用和组件
- 适合放 FreeRTOS 工程

比如 `rtos/` 里有完整的：

- FreeRTOS kernel
- HAL
- 组件
- network/audio/wifi/demo
- project/demo/fastboot 等工程

也就是说，这些核在 SDK 里被当成“可以做事情的业务 MCU”。

而 A733 当前这颗小核在 SDK 里的角色不是这个。

---

### 2.6 A733 为什么更像“系统控制核”而不是“业务 MCU”？

因为从它暴露出来的功能看，A733 小核当前负责的都是：

- standby / wakeup
- cpu power on/off
- ddr freq
- pmu / bmu
- hwmsgbox
- watchdog
- pin/clock/power

也就是：

**它是主系统的辅助控制器，不是一个独立业务执行环境。**

换句话说：

- C906/E907 在某些芯片里是“业务副核”
- A733 当前这颗 E902 更像“平台管理副核”

两者定位不同，所以 SDK 选择的软件栈也不同。

---

### 2.7 “A733 只能运行 ar100s”要怎么准确理解？

更准确的说法应该是：

> 在当前 SDK 和当前产品定义下，A733 对应的小核固件只提供了 `brandy/arisc/ar100s` 这条官方支持路径，而没有提供 `rtos/lichee/rtos` 这条通用 RTOS 路径。

不是说 E902 从硬件上绝对不能跑 FreeRTOS，而是说：

1. 当前 `rtos/` 目录没接入 `sun60iw2p1/E902`
2. 当前板级构建脚本没走 `rtos/`
3. 当前 SoC 产品定义把它当成 SCP/ARISC 管理核
4. Linux/主系统已经依赖这套 `ar100s` 协议和服务

所以你现在看到的结果就是：

- C906/E907：能跑 `rtos/`
- A733：跑 `ar100s`

这是 SDK 软件架构和产品角色划分导致的。

---

## 3. 一个很关键的补充：T736 和 A733 现在在小核链路上其实是同一代

这点很容易误解。

虽然报告里提到 `rtos/` 里还保留了 `sun60iw1 -> E906` 的旧线，但你现在 SDK 的板级脚本显示：

- A733 用 `sun60iw2p1_defconfig`
- T736 也用 `sun60iw2p1_defconfig`

所以从当前 SDK 实际构建链路看：

- A733 和 T736 的小核都已经统一到 `brandy/arisc/ar100s`
- 平台是 `sun60iw2p1`
- 这条线是 `RISCV`
- 并不是旧的 `rtos/sun60iw1/E906` 路线

也就是说，你不能简单理解成：

- “T736 是 E906 所以跑 rtos”
- “A733 是 E902 所以跑 ar100s”

在当前 SDK 里，**T736 也已经被纳入 `sun60iw2p1 -> ar100s` 这条链路**。

---

## 4. 最后用一句话概括这两个问题

### `brandy/arisc/ar100s` 是什么？
它是 A733/T736 当前 SDK 中的小核系统控制固件框架，主要负责电源管理、待机唤醒、CPU 热插拔、时钟/PMU 控制以及和 Linux 主核的消息通信，相当于 SoC 的 SCP/ARISC 固件。

### 为什么 A733 不跑 `rtos/`？
因为当前 SDK 把 A733 小核定义成“系统控制核”而不是“通用业务 MCU”，所以板级配置、构建脚本、平台支持、主核通信协议都围绕 `brandy/arisc/ar100s` 建立；而 `rtos/lichee/rtos` 当前并没有 `sun60iw2p1/E902` 的官方支持入口。

---

如果你愿意，我下一步可以继续帮你做两件事里的任意一个：

1. 进一步把 `brandy/arisc/ar100s` 的启动流程、消息机制、standby 流程画成一张结构图  
2. 进一步分析“如果想把 A733 的小核改成跑 `rtos/lichee/rtos`，源码层面至少要补哪些东西”

---

**User**

分析一下@brandy/arisc/ar100s/arch/openrisc @brandy/arisc/ar100s/arch/riscv ，对比这两个区别

---

**Cursor**

我先对比一下这两个架构目录的组织、平台绑定和启动实现。

我再补一下两个架构下 CPU 启动代码和平台覆盖范围，这样能更准确比较。

我再确认一下 `openrisc` 下有没有独立 CPU 实现文件，避免误判成“只有平台层”。

可以，这两个目录我看完后，结论很清晰：

**`arch/openrisc` 和 `arch/riscv` 的整体职责是一样的，都是 `ar100s` 的“架构适配层”；但当前 SDK 里二者的完整度、平台覆盖、CPU 启动实现暴露程度都不一样。**

我分几个层次对比。

---

## 一、先说总览结论

### 相同点
两者都是 `ar100s` 的架构层，负责：

- 选择对应平台目录 `plat-$(CFG_CHIP_PLATFORM)`
- 提供平台头文件与链接脚本
- 对接待机/恢复相关的内存布局
- 最终参与 `scp.bin` 构建

它们的顶层组织方式几乎一模一样：

```1:4:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/arch/openrisc/Makefile
obj-y += cpu/

obj-y += plat-$(CFG_CHIP_PLATFORM)/
CFLAGS-y += -Iarch/openrisc/plat-$(CFG_CHIP_PLATFORM)/inc
CFLAGS-y += -Iservice/standby/suspend_resume/mem-$(CFG_CHIP_PLATFORM)/
LINK_RAM-y := arch/openrisc/plat-$(CFG_CHIP_PLATFORM)/ram.ld
```

```1:4:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/arch/riscv/Makefile
obj-y += cpu/

obj-y += plat-$(CFG_CHIP_PLATFORM)/
CFLAGS-y += -Iarch/riscv/plat-$(CFG_CHIP_PLATFORM)/inc
CFLAGS-y += -Iservice/standby/suspend_resume/mem-$(CFG_CHIP_PLATFORM)/
LINK_RAM-y := arch/riscv/plat-$(CFG_CHIP_PLATFORM)/ram.ld
```

---

### 不同点
核心差异有 4 个：

1. **CPU 架构不同**
   - `openrisc`：老一代 ARISC 小核架构
   - `riscv`：新一代小核架构

2. **平台覆盖不同**
   - `openrisc`：覆盖老平台，如 `sun50iw10p1/sun50iw12p1/sun55iw3p1/sun60iw1p1`
   - `riscv`：覆盖新平台，如 `sun60iw2p1/sun65iw1p1`

3. **源码暴露程度不同**
   - `riscv`：CPU 启动、异常、tick、栈初始化代码都能看到
   - `openrisc`：当前树里只明显看到平台层，**没看到对应的 `arch/openrisc/cpu/` 源码目录**

4. **工具链不同**
   - `openrisc`：`or32-elf-*`
   - `riscv`：`riscv64-unknown-elf-*`

---

## 二、从 Kconfig 看：两者对应的是两代平台路线

`ar100s` 在 Kconfig 里已经明确把平台分成 OpenRISC 和 RISC-V 两类：

```13:52:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/arch/Kconfig
config SUN50IW10P1
	bool
	imply CPUX_ARM64
	select OPENRISC
	select AR100S_OS
	prompt "AW1855 sun50iw10p1 A100 platform"

config SUN50IW12P1
	bool
	imply CPUX_ARM64
	select OPENRISC
	select AR100S_OS
	prompt "AW1860 sun50iw12p1 TV303 platform"

config SUN55IW3P1
	bool
	imply CPUX_ARM64
	select OPENRISC
	select AR100S_OS
	prompt "AW1890 sun55iw3p1 A523 platform"

config SUN60IW1P1
	bool
	imply CPUX_ARM64
	select OPENRISC
	select AR100S_OS
	prompt "AW1885 sun60iw1p1 T736 platform"

config SUN60IW2P1
	bool
	imply CPUX_ARM64
	select RISCV
	select AR100S_OS
	prompt "AW1903 sun60iw2p1 A733 platform"

config SUN65IW1P1
	bool
	imply CPUX_ARM64
	select RISCV
	select AR100S_OS
	prompt "AW1919 sun65iw1p1 A537 platform"
```

这段已经直接说明：

- `openrisc` 对应的是一批较早的平台
- `riscv` 对应的是一批更新的平台
- **A733 是明确走 `RISCV` 线，不走 `OPENRISC` 线**

---

## 三、从工具链和编译参数看：两者是完全不同的架构目标

顶层 `Makefile` 里对两条线的工具链和编译参数分别处理：

```12:46:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/Makefile
ifneq ($(CFG_ARCH_PLATFORM),)
ifneq ($(CFG_OPENRISC),)
PATH :=$(CURDIR)/tools/or32-elf-gcc/toolchain/bin:$(PATH)
LD_LIBRARY_PATH:=$(LD_LIBRARY_PATH):$(CURDIR)/tools/or32-elf-gcc/toolchain/lib
CC=or32-elf-gcc
LD=or32-elf-ld
AR=or32-elf-ar
OBJC=or32-elf-objcopy
...
MARCH_FLAGS ?=-mhard-mul -msoft-div -msoft-float

else ifneq ($(CFG_RISCV),)
PATH :=$(CURDIR)/tools/riscv64-elf-x86_64-20201104/bin/:$(PATH)
CC=riscv64-unknown-elf-gcc
LD=riscv64-unknown-elf-ld
AR=riscv64-unknown-elf-ar
OBJC=riscv64-unknown-elf-objcopy
...
MARCH_FLAGS ?=-mtune=e906 -mcmodel=medany -mabi=ilp32e -march=rv32emc -fsingle-precision-constant
MARCH_LD_FLAGS ?=-melf32lriscv
```

这里能看出：

### `openrisc`
- 使用 `or32-elf-*`
- 明显是 OpenRISC 工具链
- 编译参数偏传统嵌入式 OpenRISC 风格

### `riscv`
- 使用 `riscv64-unknown-elf-*`
- 输出 32-bit RISC-V ELF
- ABI 是 `ilp32e`
- `-march=rv32emc`

也就是说，这不是“同一套 CPU 抽象换个平台头文件”这么简单，而是**编译目标架构本身就不同**。

---

## 四、从目录内容看：`riscv` 比 `openrisc` 完整得多

### 4.1 `riscv` 目录内容是完整可见的
当前 `riscv` 下有：

- `cpu/e907/`
- `crt0.S`
- `cpu_c.c`
- `time_ticks.c`
- `plat-sun60iw2p1/`
- `plat-sun65iw1p1/`

其中 CPU 目录明确只有一个实现入口：

```1:1:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/arch/riscv/cpu/Makefile
obj-y += e907/
```

虽然名字叫 `e907`，但它实际更像一套 **RISC-V 通用 CPU 公共实现层**，被 `sun60iw2p1` 和 `sun65iw1p1` 这些平台复用。

---

### 4.2 `openrisc` 当前只明显看到平台层
你让我对比时，我特意查了 `arch/openrisc/cpu/`，当前树里是空的：

- 没有找到 `arch/openrisc/cpu/Makefile`
- 没有找到对应 `crt0.S / cpu_c.c / time_ticks.c`

当前能看到的只有：

- `plat-sun50iw10p1/`
- `plat-sun50iw12p1/`
- `plat-sun55iw3p1/`
- `plat-sun60iw1p1/`
- `Makefile`

这说明至少在你这份源码快照里：

1. `openrisc` 的 CPU 公共层源码没放出来
2. 或者它通过别的方式生成/引入
3. 或者当前 SDK 实际主要维护重点已经转向 `riscv`

所以如果只看当前源码可读性：

- `riscv`：可以顺着代码一路读到底
- `openrisc`：更多只能看到平台壳子

---

## 五、从启动代码看：`riscv` 的启动链条是完整的

### 5.1 `riscv` 有明确的启动入口 `crt0.S`
`riscv` 的启动代码非常完整，做了这些事：

- 清寄存器
- 初始化 `gp/sp`
- 清空栈区
- 设置 trap 向量
- 开中断
- 清 BSS
- 跳到 `startup_entry`

例如：

```21:120:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/arch/riscv/cpu/e907/crt0.S
_start:
...
  la gp, __global_pointer

  .global cpu_0_sp
cpu_0_sp:
 la x2, metal_segment_stack_end
...
  la    a3,__trap_handler
  csrw  mtvec,a3
  csrw  mtvt,a3

  li   a3, 0x8
  csrs mstatus,a3

  jal	clean_bss
  jal	startup_entry
```

这说明 `riscv` 线已经是一套非常明确的“小核启动框架”。

---

### 5.2 `riscv` 的 CPU 层也完整
CPU 层代码里可以看到：

- `clean_bss`
- `cpu_init`
- 中断开关
- `wfi`
- delay

```1:52:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/arch/riscv/cpu/e907/cpu_c.c
void clean_bss(void)
{
	...
}

void cpu_init(void)
{
	daemon_register_service(cpu_stack_monitor);
}

s32 cpu_disable_int(void)
{
	return c906_irq_save();
}

void cpu_enable_int(s32 cpsr)
{
	c906_irq_restore(cpsr);
}

void cpu_enter_doze(void)
{
	__asm volatile("wfi");
}
```

这里还能看到一个细节：

- 文件路径叫 `e907`
- 但函数名里仍有 `c906_irq_save`

这说明这套 CPU 层存在明显“复用/演进痕迹”，不像是为单一核心重新从零写的。

---

### 5.3 `riscv` 的系统 tick 也在 CPU 层
```15:74:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/arch/riscv/cpu/e907/time_ticks.c
static HANDLE htimer;
volatile static u32 time_ticks;
...
u32 current_time_tick(void)
{
	return time_ticks;
}
...
s32 time_ticks_init(void)
{
	htimer = timer_request(timer_tick_server, NULL);
	...
	timer_start(htimer, period, TIMER_MODE_PERIOD);
```

也就是说：

- `riscv` 不只是“能起来”
- 它连时间基准、softtimer 机制都已经整合进来了

而 `openrisc` 这部分在当前源码里我没法直接对应看到。

---

## 六、从平台层看：二者的差异主要在“平台寄存器组”和“目标 SoC 代际”

### 6.1 两边平台头的风格类似
比如 `platform_config.h` 很像，说明平台公共接口基本保持一致：

```1:21:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/arch/riscv/plat-sun60iw2p1/inc/platform_config.h
#define TWI_CLOCK_FREQ		(200 * 1000)
#define TICK_PER_SEC		(100)
...
#define UART_BAUDRATE		(115200 / 2)
#define ARISC_DTS_SIZE		(0x00100000)
```

```1:22:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/arch/openrisc/plat-sun60iw1p1/inc/platform_config.h
#define TWI_CLOCK_FREQ                  (200 * 1000)
#define TICK_PER_SEC                    (100)
...
#define UART_BAUDRATE                   (115200 / 2)
#define ARISC_DTS_SIZE (0x00100000)
```

说明在 `ar100s` 上层看来：

- OpenRISC 平台
- RISC-V 平台

对外暴露的系统参数接口尽量保持一致。

---

### 6.2 但寄存器定义会出现架构代差
A733 的 `riscv` 平台寄存器里已经直接出现 E902 相关定义：

```18:36:/home/alientek/A733/qihua-x73x-linux6.6/brandy/arisc/ar100s/arch/riscv/plat-sun60iw2p1/inc/platform_regs.h
#define R_INTC_REG_BASE		(0x07024000)
#define R_PIO_REG_BASE		(0x07025000)
#define E902_CFG_BASE		(0x07032000)
...
#define RISCV_CLIC_BASE		(0xE0800000)
...
#define E902_AUTO_GATE_REG	(E902_CFG_BASE + 0x04)
```

这里有两个典型信息：

- `E902_CFG_BASE`
- `RISCV_CLIC_BASE`

说明 `sun60iw2p1` 这一代平台：
- 小核是 RISC-V 系
- 中断控制也走 RISC-V 风格（CLIC）

而旧的 `openrisc` 平台一般不会出现这类寄存器组合。

---

## 七、从“角色”上看：`openrisc` 更像历史线，`riscv` 更像当前主线

结合当前树来看，可以这样理解：

### `arch/openrisc`
更像：
- 老 ARISC 架构支持线
- 历史平台兼容层
- 平台目录还在，但 CPU 公共层源码在当前树中不明显

### `arch/riscv`
更像：
- 新一代 ARISC/SCP 实现主线
- 当前维护重点
- A733/A537 这类新平台都走这里
- 启动、CPU、tick、平台层都可直接追踪

---

## 八、如果用一句话总结两者区别

### `arch/openrisc`
- 面向老一代 ARISC 平台
- 平台覆盖老 SoC
- 当前源码里更多体现为平台适配层遗留
- CPU 通用实现层在这份源码快照中不完整/不可见

### `arch/riscv`
- 面向新一代 ARISC/SCP 平台
- 覆盖 A733 对应的 `sun60iw2p1`
- 具备完整可读的 CPU 启动和运行时实现
- 已经成为当前小核固件的实际主线

---

## 九、对你这个项目最关键的落点

对 A733 来说，真正相关的是：

- `brandy/arisc/ar100s/arch/riscv`
- 尤其是 `plat-sun60iw2p1`
- 再加上 `cpu/e907` 这一层公共 RISC-V CPU 框架

而 `arch/openrisc` 对 A733 基本没有直接运行意义，它更多是：

- 给旧平台保留的历史架构支持
- 用来对照 ARISC 框架的演进路线

---

如果你愿意，我下一步可以继续帮你做两种更深入的分析之一：

1. **把 `arch/openrisc` 和 `arch/riscv` 按“启动 / 中断 / 定时 / 平台寄存器 / 链接脚本 / 编译链”做成一张详细对照表**
2. **继续深挖 `arch/riscv/cpu/e907` 和 `plat-sun60iw2p1` 的关系，分析为什么 A733 平台明明是 E902，但公共 CPU 目录却复用了 `e907`**

