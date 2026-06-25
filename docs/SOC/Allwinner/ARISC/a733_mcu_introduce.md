# MCU firmware analysis for A733 SDK
_Exported on 2026/4/22 at GMT+8 12:40:10 from Cursor (2.6.21)_

---

**User**

基于这个目录brandy/arisc+其他agent的分析agent/A733_MCU.md
结合SDK源码详细分析一下
1、我当前SDK目标版型A733 sun60iw2p1对应的MCU固件源码的整体流程
2、MCU固件如何被加载并被启用？
2、Linux如何与MCU通信+实现具体功能？
如果参考了相关源码，把源码重要部分也一并发来

---

**Cursor**

---

# A733 MCU (SCP) 固件全链路深度分析

## 一、MCU 固件源码整体流程

### 1.1 构建链路概览

当前 A733 的 MCU 固件工程路径是 `brandy/arisc/ar100s`，平台 defconfig 为 `sun60iw2p1_defconfig`。编译产物为 `scp.bin`。

```12:12:brandy/arisc/ar100s/arch/configs/sun60iw2p1_defconfig
CFG_SUN60IW2P1=y
```

整机构建时，`build_arisc` 先于 `build_bootloader` 和 `build_kernel` 执行。构建通过 `brandy/arisc/ar100s/Makefile` 用 RISC-V 交叉编译工具链编译：

```35:47:brandy/arisc/ar100s/Makefile
PATH :=$(CURDIR)/tools/riscv64-elf-x86_64-20201104/bin/:$(PATH)
CC=riscv64-unknown-elf-gcc
LD=riscv64-unknown-elf-ld
// ...
MARCH_FLAGS ?=-mtune=e906 -mcmodel=medany -mabi=ilp32e -march=rv32emc -fsingle-precision-constant
```

最终产物是 RV32E/M/C 的 32 位小核固件。

### 1.2 固件入口与初始化序列

MCU 固件的 C 语言入口是 `startup_entry()`，位于 `system/daemon/daemon.c`。以下是完整的初始化顺序及每一步的作用：

```126:206:brandy/arisc/ar100s/system/daemon/daemon.c
void startup_entry(void)
{
	dtb_base_init();       // 读取 DTB 基地址，供后续 DTS 解析使用

	jtag_init();           // JTAG 调试接口初始化

	notifier_init();       // 通知链初始化
	save_state_flag(REC_HOTPULG | 0x0);

	ccu_init();            // 时钟控制单元初始化
	// ...
	pin_init();            // GPIO 引脚初始化
	// ...
	interrupt_init();      // 中断控制器(CLIC)初始化
	// ...
	arisc_para_init();     // ARISC 参数初始化
	// ...
	debugger_init();       // 调试器/UART 初始化
	// ...
	twi_init();            // TWI(I2C) 总线初始化，用于与 PMU 通信
	// ...
	pmu_init();            // PMU (AXP8191) 初始化
	bmu_init();            // BMU (电池管理) 初始化
	// ...
	hwmsgbox_init();       // 硬件邮箱初始化 —— AP <-> MCU 通信核心
	amp_msgbox_init();     // AMP 邮箱初始化
	// ...
	cpucfg_init();         // CPU 配置初始化，用于 CPU 热插拔/恢复
	// ...
	message_manager_init();// 消息管理器初始化
	// ...
	timer_init();          // 定时器初始化
	// ...
	standby_init();        // 待机服务初始化
	// ...
	watchdog_init();       // 看门狗初始化
	// ...

	/* 向 AP(AC327) 反馈启动状态 */
	startup_state_notify(OK);

	platform_dts_parse_late(); // 晚期 DTS 解析（如 DRAM 参数）

	set_paras();

	/* 进入守护进程主循环 */
	daemon_main();

	while (1); // 永远不应到达
}
```

### 1.3 守护进程主循环

初始化完成后，MCU 进入一个永不退出的主循环 `daemon_main()`：

```93:110:brandy/arisc/ar100s/system/daemon/daemon.c
static void daemon_main(void)
{
	cpu_init();

	while (1) {
		/* 消息轮询处理 */
		message_process_loop();

		/* 周期性守护任务 */
		if (((current_time_tick()) % DAEMON_ONCE_TICKS) == 0) {
			notifier_notify(&daemon_list, DAEMON_RUN_NOTIFY, 0);
		}
	}
}
```

`message_process_loop()` 不断轮询硬件邮箱，一旦收到来自 AP 的消息就分发处理。

### 1.4 消息处理中心

`message_manager.c` 中的 `process_message()` 是消息分发核心：

```50:106:brandy/arisc/ar100s/system/message_manager/message_manager.c
static s32 process_message(struct message *pmessage)
{
	s32 result;

	switch (pmessage->type) {
	case CPU_OP_REQ:         // CPU 操作（待机/恢复）
		result = cpu_op(pmessage);
		break;
	case SYS_OP_REQ:         // 系统操作（关机/重启）
		result = sys_op(pmessage);
		break;
	case CLEAR_WAKEUP_SRC_REQ: // 清除唤醒源
		result = clear_wakeup_src(pmessage);
		break;
	case SET_WAKEUP_SRC_REQ:   // 设置唤醒源
		result = set_wakeup_src(pmessage);
		break;
	case FAKE_POWER_OFF_REQ:   // 假关机
		result = fake_poweroff(pmessage);
		break;
	case SET_DEBUG_LEVEL_REQ:  // 设置调试等级
		result = set_debug_level(pmessage->paras[0]);
		break;
	case SET_UART_BAUDRATE:    // 设置 UART 波特率
		result = uart_set_baudrate(pmessage->paras[0]);
		break;
	case SET_DRAM_CRC_PARAS:   // 设置 DRAM CRC 参数
		result = standby_set_dram_crc_paras(...);
		break;
	case SET_DDRFREQ:          // DDR 调频
		result = mctl_mdfs_software(...);
		break;
	// ...
	}

	/* 同步消息需要反馈结果 */
	if (pmessage->attr & (MESSAGE_ATTR_SOFTSYN | MESSAGE_ATTR_HARDSYN))
		hwmsgbox_feedback_message(pmessage, SEND_MSG_TIMEOUT);
}
```

对应的消息号定义：

```46:68:brandy/arisc/ar100s/include/messages.h
#define SSTANDBY_ENTER_REQ          (MESSAGE_BASE + 0x00)
#define SSTANDBY_RESTORE_NOTIFY     (MESSAGE_BASE + 0x01)
#define ESSTANDBY_ENTER_REQ         (MESSAGE_BASE + 0x06)
#define FAKE_POWER_OFF_REQ          (MESSAGE_BASE + 0x09)
#define CPU_OP_REQ                  (MESSAGE_BASE + 0x12)
#define SYS_OP_REQ                  (MESSAGE_BASE + 0x14)
#define CLEAR_WAKEUP_SRC_REQ        (MESSAGE_BASE + 0x15)
#define SET_WAKEUP_SRC_REQ          (MESSAGE_BASE + 0x16)
#define SET_DEBUG_LEVEL_REQ         (MESSAGE_BASE + 0x50)
#define SET_UART_BAUDRATE           (MESSAGE_BASE + 0x52)
#define SET_DRAM_CRC_PARAS          (MESSAGE_BASE + 0x54)
#define SET_DDRFREQ                 (MESSAGE_BASE + 0x86)
#define AR100_STARTUP_NOTIFY        (MESSAGE_BASE + 0x80)
```

---

## 二、MCU 固件如何被加载并启用

### 2.1 固件打包

MCU 编译产物 `scp.bin` 被打包为 `scp.fex`，放入 `boot_package` 和 `dragon_toc` 中作为安全启动链的正式成员。注意 `arisc.fex` 只是一个 6 字节占位文件，不承载真实固件。

### 2.2 BL31/ATF 加载

`scp.fex` 被写入 `boot_package.cfg` 和 `dragon_toc.cfg`。在安全启动流程中，BL31（ARM Trusted Firmware）负责解析 TOC 镜像并将 `scp.bin` 搬运到 MCU 的运行地址空间。当前 SDK 树中 `bl31.bin` 是预编译交付的，因此这一步的具体实现不在源码树中可见。

### 2.3 U-Boot 触发 MCU 启动

A733 的 U-Boot defconfig 打开了两个关键配置：

```
CONFIG_SUNXI_ARISC_EXIST=y
CONFIG_ARISC_DEASSERT_BEFORE_KERNEL=y
```

由于 `CONFIG_ARISC_DEASSERT_BEFORE_KERNEL=y`，正常 boot 流程里 **不会** 走旧式 `sunxi_arisc_probe()` 路径：

```767:770:brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c
#ifdef CONFIG_SUNXI_ARISC_EXIST
#ifndef CONFIG_ARISC_DEASSERT_BEFORE_KERNEL
    sunxi_arisc_probe();   // A733 上跳过此分支
#endif
#endif
```

真正的启动动作发生在跳转内核之前：

```400:405:brandy/brandy-2.0/u-boot-2018/arch/arm/lib/bootm.c
#ifdef CONFIG_ARISC_DEASSERT_BEFORE_KERNEL
    u32 ARM_SVC_ARISC_STARTUP = 0x8000ff10;
    /* load and de-assert cpus before kernel */
    sunxi_smc_call_atf(ARM_SVC_ARISC_STARTUP, (ulong)r2, 0, 0);
#endif
```

这个 SMC 调用将 DTB 地址传给 BL31，由 BL31 完成：
1. 将 `scp.bin` 搬运到 MCU 运行地址
2. 解除 MCU 复位（de-assert）
3. MCU 开始从 `startup_entry()` 执行

SMC 函数号的定义在 `sunxi_smc_v2.c` 中：

```45:47:brandy/brandy-2.0/u-boot-2018/drivers/smc/sunxi_smc_v2.c
#define ARM_SVC_ARISC_STARTUP                   0x8000ff10
#define ARM_SVC_ARISC_WAIT_READY                0x8000ff11
#define ARM_SVC_ARISC_READ_PMU                  0x8000ff12
```

### 2.4 启动通知

MCU 初始化完成后，通过硬件邮箱向 AP 发送 `AR100_STARTUP_NOTIFY` 消息：

```38:68:brandy/arisc/ar100s/system/daemon/daemon.c
static s32 startup_state_notify(s32 result)
{
    struct message message;
    u32 arisc_version[13] = {0};

    message.type = AR100_STARTUP_NOTIFY;
    message.attr = MESSAGE_ATTR_HARDSYN;  // 硬件同步，等待 AP 确认
    message.result = result;
    message.count = sizeof(arisc_version) / sizeof(u32);
    message.paras = arisc_version;

    strncpy((char *)(arisc_version), SUB_VER, sizeof(arisc_version) - 1);

    ret = hwmsgbox_send_message(&message, SEND_MSG_TIMEOUT);
    // ...
}
```

### 2.5 整体启动时序图

```
Boot ROM -> SPL -> U-Boot -> BL31(ATF)
                               |
                     [加载 scp.bin 到 MCU 地址空间]
                               |
                   U-Boot: SMC(ARM_SVC_ARISC_STARTUP)
                               |
                     [BL31 解除 MCU 复位]
                               |
                    MCU: startup_entry()
                               |
         [初始化: CCU->PIN->INT->TWI->PMU->MSGBOX->CPUCFG->...]
                               |
               MCU: startup_state_notify(OK) --> AP
                               |
                    MCU: daemon_main() 消息循环
                               |
                   U-Boot: 跳转到 Linux 内核
```

---

## 三、Linux 如何与 MCU 通信 + 实现具体功能

### 3.1 通信硬件基础：Hardware Mailbox

AP 与 MCU 的通信基于 **硬件邮箱 (Hardware Msgbox)**，物理地址分两个视角：

```25:26:brandy/arisc/ar100s/arch/riscv/plat-sun60iw2p1/inc/platform_regs.h
#define CPUX_HWMSGBOX_REG_BASE  (0x03004000)  // AP 侧地址
#define CPUS_HWMSGBOX_REG_BASE  (0x07094000)  // MCU 侧地址
```

MCU 侧的邮箱寄存器定义：

```15:29:brandy/arisc/ar100s/driver/hwmsgbox/hwmsgbox-extended/hwmsgbox-extended.h
#define CPUX_MSGBOX_REG_BASE_EXT                (CPUX_HWMSGBOX_REG_BASE)
#define CPUS_MSGBOX_REG_BASE_EXT                (CPUS_HWMSGBOX_REG_BASE)
#define MSGBOX_ARM_TO_RISC_IRQ_STATUS_REG       (CPUS_MSGBOX_REG_BASE_EXT + 0x24)
#define MSGBOX_ARM_TO_RISC_MSG_STATUS_REG(m)    (CPUS_MSGBOX_REG_BASE_EXT + 0x60 + (0x4 * m))
#define MSGBOX_RISC_TO_ARM_MSG_STATUS_REG(m)    (CPUX_MSGBOX_REG_BASE_EXT + 0x60 + (0x4 * m))
#define MSGBOX_ARM_TO_RISC_MSG_REG(m)           (CPUS_MSGBOX_REG_BASE_EXT + 0x70 + (0x4 * m))
#define MSGBOX_RISC_TO_ARM_MSG_REG(m)           (CPUX_MSGBOX_REG_BASE_EXT + 0x70 + (0x4 * m))

#define HWMSGBOX_RISC_ASYN_TX_CH       (3)
#define HWMSGBOX_RISC_ASYN_RX_CH       (3)
#define HWMSGBOX_RISC_SYN_TX_CH        (3)
#define HWMSGBOX_RISC_SYN_RX_CH        (3)
#define HWMSGBOX_ARM_SYN_TX_CH         (3)
#define HWMSGBOX_ARM_SYN_RX_CH         (3)
```

消息协议格式（每条消息）：
1. **Header word**: `state[7:0] | attr[15:8] | type[23:16] | result[31:24]`
2. **Count word**: 参数数量
3. **Parameter words**: N 个 32 位参数

支持两种模式：
- **硬件同步 (HARDSYN)**：发送后等待对方通过专用通道反馈
- **异步 (ASYN)**：发后不等

### 3.2 Linux 侧通信路径

#### 路径一：通过 SMC 间接通信（主要路径）

Linux 内核侧主要通过 **SMC (Secure Monitor Call)** 间接与 MCU 通信，由 BL31/ATF 中转。关键接口定义在 `bsp/include/sunxi-sip.h`：

```42:60:bsp/include/sunxi-sip.h
#define SUNXI_BASE              (0x10)
#define CLEAR_WAKEUP_SRC_REQ    (SUNXI_BASE + 0x15)
#define SET_WAKEUP_SRC_REQ      (SUNXI_BASE + 0x16)
#define SET_DEBUG_DRAM_CRC_PARAS_REQ (SUNXI_BASE + 0x54)
#define SUNXI_DDRFREQ           (SUNXI_BASE + 0x86)

#define CLEAR_WAKEUP_SRC        (ARM_SVC_BASE + CLEAR_WAKEUP_SRC_REQ)
#define SET_WAKEUP_SRC          (ARM_SVC_BASE + SET_WAKEUP_SRC_REQ)
#define SET_DEBUG_DRAM_CRC_PARAS (ARM_SVC_BASE + SET_DEBUG_DRAM_CRC_PARAS_REQ)
#define ARM_SVC_SUNXI_DDRFREQ   (ARM_SVC_BASE + SUNXI_DDRFREQ)
```

调用方式：

```63:71:bsp/include/sunxi-sip.h
static inline int invoke_scp_fn_smc(u64 function_id, u64 arg1, u64 arg2, u64 arg3)
{
    struct arm_smccc_res res;
    arm_smccc_smc(function_id, arg1, arg2, arg3, 0, 0, 0, 0, &res);
    return res.a0;
}
```

注意这里的消息号与 MCU 侧 `messages.h` 中的定义完全一致，说明 BL31 在中间做了消息透传。

#### 路径二：通过 sunxi-msgbox 驱动直接通信

Linux 侧的 `bsp/drivers/msgbox/sunxi-msgbox.c` 实现了标准的 Linux `mailbox_controller` 框架驱动，用于 AP 与 MCU 之间的直接邮箱通信：

```31:44:bsp/drivers/msgbox/sunxi-msgbox.c
#define SUNXI_MSGBOX_OFFSET(n)          (0x100 * (n))
#define SUNXI_MSGBOX_READ_IRQ_ENABLE(n) (0x20 + SUNXI_MSGBOX_OFFSET(n))
#define SUNXI_MSGBOX_READ_IRQ_STATUS(n) (0x24 + SUNXI_MSGBOX_OFFSET(n))
#define SUNXI_MSGBOX_WRITE_IRQ_ENABLE(n)(0x30 + SUNXI_MSGBOX_OFFSET(n))
#define SUNXI_MSGBOX_WRITE_IRQ_STATUS(n)(0x34 + SUNXI_MSGBOX_OFFSET(n))
#define SUNXI_MSGBOX_MSG_STATUS(n, p)   (0x60 + SUNXI_MSGBOX_OFFSET(n) + 0x4 * (p))
#define SUNXI_MSGBOX_MSG_FIFO(n, p)     (0x70 + SUNXI_MSGBOX_OFFSET(n) + 0x4 * (p))
```

### 3.3 具体功能实现详解

#### 功能一：系统待机 (Suspend/Standby)

这是 MCU 最核心的职责。当 Linux 发起 suspend 请求时，通过 PSCI -> BL31 -> MCU 链路发送 `CPU_OP_REQ`。

MCU 侧的 `cpu_op()` 收到后，判断 `system_state == arisc_power_off` 则进入 `standby_entry()`：

```
cpu_op()  ->  standby_entry()  ->  standby_process_init()  ->  wait_wakeup()  ->  standby_process_exit()
```

**进入待机的完整流程**（`standby_process_init`）：

```1209:1234:brandy/arisc/ar100s/service/standby/standby-sun60iw2p1/plat_standby.c
static s32 standby_process_init(struct message *pmessage)
{
    cpucfg_cpu_suspend();      // 1. 关闭 CPU0，等待 cluster 下电
    device_suspend();          // 2. 设备挂起（TWI/PMU/邮箱/SMC/USB/时间戳）
    cpu_pll_off();             // 3. 关闭 CPU PLL
    dram_suspend();            // 4. DRAM 自刷新（可选 CRC 校验）
    clk_suspend();             // 5. 切换至 RC16M，关闭所有 PLL
    system_suspend();          // 6. 模拟/数字域隔离、USB 隔离
    rtc_vccio_det_suspend();   // 7. 关闭 VCC-IO 检测
    dm_suspend();              // 8. 按 DTS 配置关闭各电源域
}
```

**等待唤醒**：

```311:330:brandy/arisc/ar100s/service/standby/standby-sun60iw2p1/plat_standby.c
static void wait_wakeup(void)
{
    wakeup_timer_start();
    while (1) {
        if (wakeup_source != NO_WAKESOURCE) {
            break;
        }
        cpu_enter_doze();  // MCU 自身进入低功耗等待
    }
    wakeup_timer_stop();
}
```

**恢复流程**（`standby_process_exit`，顺序与挂起相反）：

```1236:1269:brandy/arisc/ar100s/service/standby/standby-sun60iw2p1/plat_standby.c
static s32 standby_process_exit(struct message *pmessage)
{
    dm_resume();               // 恢复电源域
    rtc_vccio_det_resume();    // 恢复 VCC-IO 检测
    clk_resume_early();        // 恢复 DCXO 24MHz
    system_resume();           // 解除域隔离
    ppu_resume();              // PPU 恢复
    clk_resume();              // 恢复所有 PLL 和总线时钟
    dram_resume();             // DRAM 恢复（可选 CRC 校验）
    nsi_resume();              // NSI 总线恢复
    cpu_pll_on();              // 恢复 CPU PLL
    device_resume();           // 设备恢复
    cpucfg_cpu_resume(resume_entry); // 恢复 CPU0
    wait_cpu0_resume();        // 等待 AP 恢复确认
}
```

#### 功能二：CPU 热插拔协调

MCU 可以控制 CPU 的上电/下电，实现 CPU 热插拔：

```1:85:brandy/arisc/ar100s/driver/cpucfg/cpucfg-sun60iw2p1/sunxi_cpu_ops.c
void sunxi_set_bootaddr(unsigned int cluster, unsigned int cpu, uintptr_t entry)
{
    mmio_write_32(SUNXI_CPUCFG_RVBAR_LO_REG(cpu), entry);
    mmio_write_32(SUNXI_CPUCFG_RVBAR_HI_REG(cpu), 0);
}

void sunxi_poweron_cpu(unsigned int cluster, unsigned int core)
{
    mmio_setbits_32(HOTPLUG_CONTROL_REG(core), HOTPLUG_EN);
    mmio_setbits_32(HOTPLUG_POWERMODE_REG(core), POWER_ON);
    while (!sunxi_get_cpu_powerstate(cluster, core)) {}
    mmio_clrbits_32(HOTPLUG_CONTROL_REG(core), HOTPLUG_EN);
}

int cpucfg_cpu_resume(unsigned int resume_addr)
{
    sunxi_set_bootaddr(0, 0, resume_addr);  // 设置启动地址
    sunxi_init_archstate(0, 0, 1);          // 设为 AArch64
    sunxi_poweron_cpu(0, 0);                // 上电 CPU0
    return 0;
}
```

#### 功能三：系统关机/重启

```
Linux -> PSCI -> BL31 -> MCU: SYS_OP_REQ
```

MCU 侧处理：

```1285:1318:brandy/arisc/ar100s/service/standby/standby-sun60iw2p1/plat_standby.c
int sys_op(struct message *pmessage)
{
    u32 state = pmessage->paras[0];
    switch (state) {
    case arisc_system_shutdown:
        pmu_charging_reset();
        system_shutdown();   // -> pmu_shutdown(): 通过 TWI 控制 AXP8191 关机
        break;
    case arisc_system_reset:
    case arisc_system_reboot:
        system_reset();      // -> pmu_reset(): 通过 TWI 控制 AXP8191 重启
        break;
    }
}
```

#### 功能四：唤醒源管理

Linux 通过 SMC 调用设置/清除唤醒源：

```68:72:bsp/drivers/standby/standby_debug.c
	invoke_scp_fn_smc(SET_WAKEUP_SRC,
			SET_WAKEUP_TIME_MS(time_to_wakeup_ms), 0, 0);
```

MCU 侧 `set_wakeup_src()` 解析参数：

```117:172:brandy/arisc/ar100s/service/standby/wakeup_source.c
s32 set_wakeup_src(struct message *pmessage)
{
    wakeup_src_type = (pmessage->paras[0] >> 30) & 0x3;
    wakeup_root_irq = pmessage->paras[0] & 0x3FF;

    if (wakeup_src_type == 0x3) {
        // 定时唤醒
        time_to_wakeup = pmessage->paras[0] & 0x3fffffff;
        wakeup_timer.cycle = msec_to_ticks(time_to_wakeup);
    } else {
        // IRQ 唤醒：映射 CPUX IRQ -> CPUS IRQ，注册中断处理函数
        irq_no = CPUX_IRQ_MAPTO_CPUS(wakeup_root_irq);
        irq_wakesource_init(irq_no, group_irq_init, ..., default_wakeup_handler, NULL);
    }
}
```

#### 功能五：DDR 调频

Linux 通过 SMC 发送 `SET_DDRFREQ` 消息：

```
invoke_scp_fn_smc(ARM_SVC_SUNXI_DDRFREQ, freq_level, 0, 0);
```

MCU 侧直接调用 DRAM 库执行调频：

```97:103:brandy/arisc/ar100s/system/message_manager/message_manager.c
    case SET_DDRFREQ:
        if (platform_dram_para)
            result = mctl_mdfs_software((void *)platform_dram_para, pmessage->paras[0]);
        else
            result = mctl_mdfs_software(&arisc_para.dram_para, pmessage->paras[0]);
        break;
```

#### 功能六：DRAM CRC 校验调试

Linux 通过 sysfs 接口设置 DRAM CRC 参数：

```92:99:bsp/drivers/standby/standby_debug.c
    invoke_scp_fn_smc(SET_DEBUG_DRAM_CRC_PARAS,
            debug_dram_crc_en,
            debug_dram_crc_srcaddr,
            debug_dram_crc_len);
```

MCU 在进入/退出待机时执行 DRAM CRC 校验，确保待机期间内存数据完整性。

### 3.4 Linux <-> MCU 通信架构总结

```
+------------------+                              +------------------+
|   Linux Kernel   |                              |   MCU (SCP)      |
|                  |                              |                  |
| standby_debug.c  |  invoke_scp_fn_smc()         |  daemon_main()   |
| irq-wakeupgen.c  |  ──────────────────>         |    |             |
| ccu-ddr.c        |  arm_smccc_smc()     SMC     |    v             |
| pinctrl-sunxi.c  |  ──────────────>  BL31/ATF   |  message_process |
| thermal handler  |                   (中转)     |  _loop()         |
|                  |                    |         |    |             |
| sunxi-msgbox.c   |  <--- HW Mailbox -->         |  hwmsgbox_query  |
|  (mbox framework)|  直接硬件邮箱通信             |  _message()      |
+------------------+                              +------------------+
       |                                                  |
       |  msgbox@0x03004000 (AP视角)                       |
       |  msgbox@0x07094000 (MCU视角)                      |
       +--------------------------------------------------+
                    Hardware Mailbox FIFO
```

### 3.5 MCU 完整职责清单

| 职责 | 消息/机制 | 具体实现 |
|------|-----------|---------|
| 系统待机/恢复 | `CPU_OP_REQ` | 关闭 CPU/PLL/DRAM/时钟/电源域，等待唤醒后恢复 |
| 系统关机 | `SYS_OP_REQ` (shutdown) | 通过 TWI 控制 AXP8191 PMIC 关机 |
| 系统重启 | `SYS_OP_REQ` (reset/reboot) | 通过 TWI 控制 AXP8191 PMIC 复位 |
| CPU 热插拔 | `CPU_OP_REQ` | 设置 RVBAR/上电/下电 CPU |
| 唤醒源管理 | `SET_WAKEUP_SRC_REQ` / `CLEAR_WAKEUP_SRC_REQ` | 配置 IRQ 唤醒或定时唤醒 |
| DDR 调频 | `SET_DDRFREQ` | 调用 DRAM 库执行 MDFS |
| DRAM CRC 调试 | `SET_DRAM_CRC_PARAS` | 待机前后校验 DRAM 数据完整性 |
| UART 调试控制 | `SET_UART_BAUDRATE` / `SET_DEBUG_LEVEL_REQ` | 动态调整 MCU 调试输出 |
| 假关机 | `FAKE_POWER_OFF_REQ` | 模拟关机状态 |
| 启动通知 | `AR100_STARTUP_NOTIFY` | MCU 初始化完成后通知 AP |

以上就是基于 SDK 源码的完整分析。总结核心要点：

1. **MCU 固件流程**：`startup_entry()` 完成全部硬件初始化后进入 `daemon_main()` 无限循环，不断轮询硬件邮箱处理来自 AP 的消息。

2. **加载与启用**：`scp.bin` 通过 `boot_package` 被 BL31 加载到 MCU 地址空间，U-Boot 在跳转内核前通过 SMC 调用 `ARM_SVC_ARISC_STARTUP (0x8000ff10)` 触发 BL31 解除 MCU 复位，MCU 开始运行。

3. **Linux 通信**：Linux 主要通过 `invoke_scp_fn_smc()` 发起 SMC 调用，经 BL31 中转将消息写入硬件邮箱传递给 MCU。MCU 核心职责是管理待机/恢复全流程（包括 CPU 下电、PLL 关闭、DRAM 自刷新、电源域管理、唤醒源监听、CPU 恢复），以及系统关机/重启和 DDR 调频。

