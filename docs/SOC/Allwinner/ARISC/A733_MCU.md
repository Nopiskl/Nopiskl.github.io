# A733 MCU/SCP 技术分析

## 1. 文档目的

本文只基于当前工作区里的实际源码和当前 `out/` 产物来分析 A733 的 MCU 固件链路，不引用外部资料。

为了尽量严谨，下面的结论会区分为两类：

- 已证实：可以直接从当前 SDK 源码或当前构建产物中看到。
- 合理推断：源码没有把最后一环完全展开，但上下游证据已经足够支持该判断。

## 2. 结论先行

### 2.1 已证实的结论

1. 当前生效目标不是 `t736`，而是 `A733 + x733mhn_aic8800 + debian + linux-6.6`。证据见 `.buildconfig:1-27`、`.buildconfig:71-85`。
2. 当前 MCU 固件工程是 `brandy/arisc/ar100s`，平台 defconfig 是 `sun60iw2p1_defconfig`。证据见 `build/mkcmd.sh:2821-2855`、`device/config/chips/a733/tools/arisc_config_parse.sh:5-12`、`brandy/arisc/Makefile:8-11`。
3. 当前真正作为 MCU 固件参与打包的是 `scp.bin/scp.fex`，不是 `arisc.fex`。证据见 `brandy/arisc/ar100s/Makefile:199-207`、`build/pack:256`、`build/pack:290`、`device/config/chips/a733/configs/default/boot_package.cfg:3-5`、`device/config/chips/a733/configs/default/dragon_toc.cfg:40-46`。
4. 当前 `arisc.fex` 仍然存在，但在这条 A733 Linux 打包链里只是兼容性占位成员，不承载真实 MCU 固件内容。证据见 `build/mkkernel.sh:750-755`、`build/pack:272-290`、`device/config/chips/a733/configs/default/image_linux.cfg:87-93`，以及当前产物内容比对。
5. 当前 A733 的正常启动路径并不会在早期 boot 阶段调用 `sunxi_arisc_probe()`；因为 `CONFIG_ARISC_DEASSERT_BEFORE_KERNEL=y`，U-Boot 会在跳内核前通过 SMC 触发 `ARM_SVC_ARISC_STARTUP`。证据见 `brandy/brandy-2.0/u-boot-2018/configs/sun60iw2p1_a733_defconfig:73-74`、`brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:767-770`、`brandy/brandy-2.0/u-boot-2018/arch/arm/lib/bootm.c:400-405`、`brandy/brandy-2.0/u-boot-2018/drivers/smc/sunxi_smc_v2.c:45-50,157-165`。
6. `cpu/e907` 目录名并不能直接代表 A733 MCU 的真实内核命名。当前源码里同时出现了 `E902` 寄存器命名、`e907` 目录名、`e906` 编译 tune、`c906` 旧注释，明显是供应商复用通用 RISC-V 支持层后的历史残留。真正的 SoC 适配重点在 `plat-sun60iw2p1`、`pmu-sun60iw2p1`、`cpucfg-sun60iw2p1`、`standby-sun60iw2p1`。

### 2.2 合理推断

1. 当前 A733 上“谁真正把 `scp` 装载并启动到目标 MCU 地址空间”这一最后一步，主要发生在安全监控器/BL31 一侧，而不是普通 U-Boot C 代码里。
2. 做出这个判断的原因是：
   - `scp.fex` 明确出现在 `boot_package.cfg` 和 `dragon_toc.cfg` 中。
   - U-Boot 旧的“自己解析 arisc 镜像地址”的代码已经被 `#if 0` 注释掉，并写明 `boot load scp`。
   - 正常启动路径里，U-Boot 只发出 `ARM_SVC_ARISC_STARTUP` SMC 调用，然后交给更低层。
   - 当前树里只有预编译的 `device/config/chips/a733/bin/bl31.bin`，没有 BL31 对应源码。

更稳妥的说法是：当前源码可以确定 `scp` 是真实 MCU 固件，也可以确定 U-Boot 通过 SMC 请求启动它；但“BL31/ATF 内部如何解析并搬运 `scp`”这一段不在当前源码树中直接可见。

## 3. 当前实际构建目标

`.buildconfig` 已经把当前工作区状态写死得很明确：

- `LICHEE_LINUX_DEV=debian`，见 `.buildconfig:2`
- `LICHEE_KERN_NAME=linux-6.6`，见 `.buildconfig:3`
- `LICHEE_IC=a733`，见 `.buildconfig:4`
- `LICHEE_BOARD=x733mhn_aic8800`，见 `.buildconfig:5`
- `LICHEE_BRANDY_DEFCONF=sun60iw2p1_a733_defconfig`，见 `.buildconfig:19`
- `LICHEE_CHIP=sun60iw2p1`，见 `.buildconfig:27`
- `LICHEE_ARISC_PATH=.../brandy/arisc`，见 `.buildconfig:82`
- `LICHEE_DRAMLIB_PATH=.../brandy/dramlib`，见 `.buildconfig:83`

因此，后续所有 MCU 结论都应该以“当前 A733/sun60iw2p1/Linux-6.6 构建上下文”为准，而不是拿同仓库里的 `t736` 或旧平台配置来替代。

## 4. MCU 固件的构建链

### 4.1 顶层构建顺序

整机 Linux 构建入口在 `build/mkcmd.sh:2990-3028`：

```sh
build_linuxdev() {
    board_dts_create_link
    build_rtos
    build_dtbo
    build_arisc
    build_bootloader
    build_kernel
}
```

这里 `build_arisc` 明确发生在 `build_bootloader` 和 `build_kernel` 之前。

### 4.2 `build_arisc` 实际做了什么

`build/mkcmd.sh:2821-2855` 的 `build_arisc()` 逻辑很清楚：

1. 先找 `arisc.config`
2. 再执行芯片脚本 `device/config/chips/a733/tools/arisc_config_parse.sh`
3. 把得到的 `arisc.config` 复制到 `brandy/arisc/.config`
4. 最后 `make -C brandy/arisc`

需要注意的一点是：

- `device/config/chips/a733/tools/arisc_config_parse.sh:5-12` 生成的并不是最终 MCU Kconfig，而是两行 shell export：
  - `LICHEE_ARISC_DEFDIR=ar100s`
  - `LICHEE_ARISC_DEFCONFIG=sun60iw2p1_defconfig`
- `brandy/arisc/Makefile:8-11` 再根据这两个 export 去执行：
  - `make -C ar100s sun60iw2p1_defconfig`
  - `make -C ar100s`

也就是说：

- `brandy/arisc/.config` 只是顶层 wrapper 配置
- 真正 MCU 固件的 Kconfig 展开，是在 `brandy/arisc/ar100s/.config` 中完成的

### 4.3 `sun60iw2p1_defconfig` 到底选中了什么

`brandy/arisc/ar100s/arch/configs/sun60iw2p1_defconfig:1-12` 至少显式打开了这些能力：

- `CFG_SUN60IW2P1=y`
- `CFG_BMU_USED=y`
- `CFG_AXP8191_USED=y`
- `CFG_AXP515_USED=y`
- `CFG_HW_MSGBOX_EXTENDED_USED=y`
- `CFG_TIMER_EXTENDED_USED=y`
- `CFG_DRAM_DTS_PARA_V2=y`
- `CFG_DRAM_PARA_V2=y`
- `CFG_CLIC_USED=y`
- `CFG_DEBUG_INF=y`
- `CFG_DRAMFREQ_USED=y`
- `CFG_FDT_INIT_ARISC_UART_USED=y`

这里需要纠正一个常见误解：

- `sun60iw2p1_defconfig` 本身只显式写了 `CFG_SUN60IW2P1=y`
- `CFG_RISCV` 不是 defconfig 里直接写死的，而是 `brandy/arisc/ar100s/arch/Kconfig:56-60` 中 `SUN60IW2P1 -> select RISCV` 推导出来的

### 4.4 编译器与 ISA 选项

`brandy/arisc/ar100s/Makefile:35-49` 指定了 RISC-V 工具链和编译选项：

- `CC=riscv64-unknown-elf-gcc`
- `MARCH_FLAGS=-mtune=e906 -mcmodel=medany -mabi=ilp32e -march=rv32emc`

这说明当前固件是一个 32-bit RV32E/M/C 的小核固件，但也同时暴露出命名历史包袱：

- 目录名是 `cpu/e907`
- 编译 tune 是 `e906`
- 平台寄存器名是 `E902_*`
- 头文件/源码注释里还残留 `c906`

因此，单独拿任何一个名字都不能直接代表真实 MCU 型号。

## 5. `ar100s` 在 sun60iw2p1 上的分层

当前 A733 MCU 固件的代码分层可以概括为：

| 层级 | 路径 | 作用 | 备注 |
| --- | --- | --- | --- |
| 顶层封装 | `brandy/arisc/Makefile` | 选择子工程和 defconfig | 当前固定进 `ar100s + sun60iw2p1_defconfig` |
| 架构入口 | `arch/Makefile` | 根据 `CFG_RISCV` 进入 `arch/riscv/` | 见 `arch/Makefile:1-2` |
| RISC-V 公共 CPU 层 | `arch/riscv/cpu/e907/` | 通用 CPU/异常/中断支持 | 并不等于真实 MCU 命名 |
| SoC 平台层 | `arch/riscv/plat-sun60iw2p1/` | SoC 寄存器、链接脚本、IRQ 表 | 见 `arch/riscv/Makefile:1-6` |
| 芯片驱动层 | `driver/pmu/pmu-sun60iw2p1/`、`driver/cpucfg/cpucfg-sun60iw2p1/`、`driver/prcm/prcm-sun60iw2p1/` | PMU、CPU 热插拔/恢复、时钟复位 | 由 `CFG_CHIP_PLATFORM` 选择 |
| 待机服务层 | `service/standby/standby-sun60iw2p1/` | super standby / wakeup | 由 `CFG_CHIP_PLATFORM` 选择 |

对应的 make 选择关系也很清楚：

- `arch/riscv/Makefile:1-6`
- `arch/riscv/cpu/Makefile:1`
- `driver/cpucfg/Makefile:1`
- `driver/pmu/Makefile:11`
- `service/standby/Makefile:1-4`

### 5.1 为什么说 `cpu/e907` 不是最终硬件真相

下面这几条同时成立：

1. `arch/riscv/cpu/Makefile:1` 固定把 RISC-V CPU 公共层指到 `e907/`
2. `arch/riscv/cpu/e907/e907_com.h:1-9`、`e907_com.c:1-6` 顶部注释却写着 `c906`
3. `ar100s/Makefile:46` 的编译 tune 又是 `e906`
4. `arch/riscv/plat-sun60iw2p1/inc/platform_regs.h:35,50,341-342` 用的却是 `E902_CFG_BASE`、`E902_WAKEUP_MASK*`
5. `e907_com.c:3666-3680` 实际也直接在操作 `E902_WAKEUP_MASK0/1_REG`

因此更准确的结论是：

- `cpu/e907/` 在这套 SDK 里只是一个被复用的 RISC-V CPU 公共层目录名
- sun60iw2p1 的真实 SoC 绑定信息，应以 `plat-sun60iw2p1` 和各个 `*-sun60iw2p1` 专属目录为准
- 供应商没有为 A733 单独拆一个 `cpu/e902/` 目录，而是把差异都压在平台层和驱动层里

## 6. 板级 DTS 与 MCU 的接口契约

### 6.1 板级 alias

`device/config/chips/a733/configs/x733mhn_aic8800/linux-6.6/board.dts:12-17` 给 MCU 相关节点定义了别名：

- `standby_param = &standby_param`
- `arisc-config = &arisc_config`
- `pmu0 = &pmu0`
- `bat_supply = &bat_power_supply`

这几个别名不是装饰，它们会被固件源码直接按名字查找。

### 6.2 `standby_param` 被谁消费

板级节点定义见 `board.dts:29-45`，里面给出了多组待机电源位图和：

- `vdd-usb`
- `osc24m-on`

MCU 侧在 `service/standby/standby-sun60iw2p1/plat_standby.c:272-308` 中直接：

- `fdt_path_offset(fdt, "standby_param")`
- 逐项读取 `power_bitmap_array[]`
- 读取 `vdd-usb`
- 读取 `osc24m-on`

这说明 `standby_param` 的确是 MCU 待机策略的直接输入，不是单纯给 Linux 自己看的。

### 6.3 `arisc-config` 被谁消费

板级节点定义见 `board.dts:47-53`，当前只配置了 `s_uart_config`。

MCU 侧 `driver/uart/uart.c:19-71` 因为打开了 `CFG_FDT_INIT_ARISC_UART_USED`，会直接：

- `fdt_path_offset(fdt, "arisc-config")`
- 查找子节点 `s_uart_config`
- 读取 `pins`
- 读取 `function`
- 再去配管脚复用

因此，当前 A733 的 MCU UART 引脚配置确实是从 DTS 动态读出来的，而不是纯硬编码。

### 6.4 `pmu0` 的一个重要细节

`driver/pmu/pmu-sun60iw2p1/pmu.c:201-219` 里确实存在 `pmu_init_from_dts()`，并且会：

- `fdt_path_offset(fdt, "pmu0")`
- 读取 `reg`
- 覆盖 `pmu_runtime_addr`

但是当前 `sun60iw2p1_defconfig` 并没有打开 `CFG_FDT_INIT_ARISC_PMU_USED`。

也就是说：

- `pmu0` 这个 DTS alias 在板子上是存在的
- PMU 驱动里也有相应的 DTS 解析代码
- 但在“当前 A733 这份 defconfig”里，这段 PMU DTS 初始化代码并没有被编译使能

这个细节很重要，因为它说明“代码存在”不等于“当前配置实际生效”。

### 6.5 `msgbox` / `hwspinlock` 与 MCU 通信

板级 `board.dts` 只是把它们打开：

- `&msgbox { status = "okay"; }`，见 `board.dts:857-859`
- `&hwspinlock { status = "okay"; }`，见 `board.dts:861-863`

真正的 SoC 定义在 `bsp/configs/linux-6.6/sun60iw2p1.dtsi:2365-2392`：

- `hwspinlock@3005000`
- `msgbox@3004000`
- msgbox `reg = <0x03004000>, <0x07094000>`

而 MCU 平台头文件 `platform_regs.h:25-26` 也定义了完全对应的：

- `CPUX_HWMSGBOX_REG_BASE = 0x03004000`
- `CPUS_HWMSGBOX_REG_BASE = 0x07094000`

再加上：

- `hwmsgbox-extended.h:15-29`
- `prcm-sun60iw2p1/mclk.c:94-100`
- `prcm-sun60iw2p1/reset.c:85-91`

可以确认当前 A733 的 AP <-> MCU 运行时通信基础设施就是这套 extended hwmsgbox。

## 7. MCU 固件启动后的职责

### 7.1 初始化顺序

`system/daemon/daemon.c:151-204` 能直接看到 MCU 固件启动后的核心初始化顺序：

1. `arisc_para_init`
2. `debugger_init`
3. `twi_init`
4. `pmu_init`
5. `bmu_init`
6. `hwmsgbox_init`
7. `amp_msgbox_init`
8. `cpucfg_init`
9. `message_manager_init`
10. `timer_init`
11. `standby_init`
12. `watchdog_init`
13. `startup_state_notify(OK)`
14. `platform_dts_parse_late()`
15. `set_paras()`
16. `daemon_main()`

这说明它不是一个“只做待机”的极小裸固件，而是一个长期驻留的系统服务核。

### 7.2 当前明确能看到的运行时能力

`system/message_manager/message_manager.c:50-123` 明确处理这些消息类型：

- `CPU_OP_REQ`
- `SYS_OP_REQ`
- `CLEAR_WAKEUP_SRC_REQ`
- `SET_WAKEUP_SRC_REQ`
- `FAKE_POWER_OFF_REQ`
- `SET_DEBUG_LEVEL_REQ`
- `SET_UART_BAUDRATE`
- `SET_DRAM_CRC_PARAS`
- `SET_DDRFREQ`

这些消息号定义在 `include/messages.h:46-68`。

因此，当前 MCU 至少承担以下职责：

- CPU/cluster 相关操作
- 系统待机/恢复
- 唤醒源登记与清除
- fake poweroff
- UART 调试配置
- DRAM CRC 相关辅助
- DDR 频率切换

### 7.3 CPU 热插拔/恢复能力

`driver/cpucfg/cpucfg-sun60iw2p1/sunxi_cpu_ops.c:19-23,41-56,61-85` 直接显示：

- 可以设置 CPU `RVBAR`
- 可以设置 AArch64/32 启动状态
- 可以对 CPU 做 power on/off
- `cpucfg_cpu_suspend()` 会关 CPU0 并等待 cluster 下电
- `cpucfg_cpu_resume()` 会写 resume 地址、设为 AArch64、再重新拉起 CPU0

所以这颗 MCU 不只是“旁路 PMIC 控制器”，它还参与 CPU resume/standby 协调。

### 7.4 待机与唤醒能力

`service/standby/standby-sun60iw2p1/plat_standby.c` 中可以直接看到：

- 解析 `standby_param`，见 `272-308`
- 等待唤醒并在等待期间让 MCU 进入 doze，见 `311-330`
- USB standby 相关隔离/时钟/复位控制，见 `563-708`
- 根据 `INTC_R_USB_IRQ` 判断是否属于 `CPUS_WAKEUP_USB`，见 `1192-1202`

`service/standby/wakeup_source.c:116-205` 则表明 MCU 自己维护唤醒源：

- 支持按 IRQ 配置 wakeup source
- 支持按时间配置 wakeup timer
- 唤醒后会把 `wakeup_source` 回传给上层

## 8. `scp.bin`、`scp.fex`、`arisc.fex` 三者关系

### 8.1 `scp.bin` 是 `ar100s` 的直接产物

`brandy/arisc/ar100s/Makefile:199-207` 表明最终产物名就是 `scp.bin`，并且会复制到 `${LICHEE_BRANDY_OUT_DIR}`，也就是当前：

- `device/config/chips/a733/bin/scp.bin`

### 8.2 打包时 `scp.bin -> scp.fex`

`build/pack:256` 和 `build/pack:290` 都把 `scp.bin` 映射成 `scp.fex`。

这两条规则说明：

- 可以从芯片 bin 目录取 `scp.bin`
- 也可以从平台输出目录取 `scp.bin`

### 8.3 `arisc.fex` 的真实来源

`build/mkkernel.sh:754` 直接写死：

```sh
[ ! -f $STAGING_DIR/arisc ] && echo "arisc" > $STAGING_DIR/arisc
```

随后 `build/pack:273` 把这个文件复制成 `arisc.fex`。

所以在当前 A733 Linux 链路里：

- `arisc.fex` 并不是由 `ar100s` 编译出来的 MCU 固件
- 它只是由一个 6 字节文本占位文件转换而来

### 8.4 当前产物实测

我在当前工作区直接比对了这几份文件：

- `brandy/arisc/ar100s/scp.bin`
- `device/config/chips/a733/bin/scp.bin`
- `out/a733/x733mhn_aic8800/pack_out/scp.fex`

这 3 个文件的 md5 都是：

- `fae535c8abdce1b6bf61750f695818d4`

而下面两份：

- `out/a733/x733mhn_aic8800/debian/arisc`
- `out/a733/x733mhn_aic8800/pack_out/arisc.fex`

md5 都是：

- `f9f8acd107fc4eeda65a709c943c1212`

内容都是：

```text
arisc\n
```

因此可以直接确认：

- `scp.fex` 才是当前真实 MCU 固件
- `arisc.fex` 只是兼容占位

### 8.5 为什么镜像里还要保留 `arisc.fex`

`device/config/chips/a733/configs/default/image_linux.cfg:87-93` 仍然把 `arisc.fex` 放进最终镜像成员表里。

与此同时：

- `boot_package.cfg:3-5` 用的是 `scp.fex`
- `dragon_toc.cfg:40-46` 用的是 `scp.fex`
- `private_toc.h:153-156` 也把 `scp` 定义为正式 TOC item

因此更稳妥的判断是：

- `scp.fex` 是当前安全启动/固件启动链真正关心的 MCU 固件项
- `arisc.fex` 在镜像容器里保留，是为了兼容老的镜像格式/工具链约定
- 但在当前 A733 Linux 包中，它并不承载真实固件内容

另外还有一个很有意思的细节：

- `build/pack:1018-1023` 和 `1124-1128` 里有旧平台用的 `update_scp scp.fex sunxi.fex`
- 但这两段代码的前置条件是“芯片目录下不存在 `tools/arisc_config_parse.sh`”
- A733 恰好存在 `device/config/chips/a733/tools/arisc_config_parse.sh`

也就是说，A733 这条链路本身就在绕开旧的 `update_scp` 兼容路径。

## 9. 当前 A733 的实际启动链

### 9.1 U-Boot 配置

`brandy/brandy-2.0/u-boot-2018/configs/sun60iw2p1_a733_defconfig:73-74` 明确打开：

- `CONFIG_SUNXI_ARISC_EXIST=y`
- `CONFIG_ARISC_DEASSERT_BEFORE_KERNEL=y`

### 9.2 这两个配置在正常启动里意味着什么

`brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:767-770` 写得很直接：

```c
#ifdef CONFIG_SUNXI_ARISC_EXIST
#ifndef CONFIG_ARISC_DEASSERT_BEFORE_KERNEL
    sunxi_arisc_probe();
#endif
#endif
```

由于 A733 当前 defconfig **打开了** `CONFIG_ARISC_DEASSERT_BEFORE_KERNEL`，所以正常 boot 流程里这里不会执行 `sunxi_arisc_probe()`。

### 9.3 真正发生的启动动作

真正的动作在 `brandy/brandy-2.0/u-boot-2018/arch/arm/lib/bootm.c:400-405`：

```c
#ifdef CONFIG_ARISC_DEASSERT_BEFORE_KERNEL
    u32 ARM_SVC_ARISC_STARTUP = 0x8000ff10;
    sunxi_smc_call_atf(ARM_SVC_ARISC_STARTUP, (ulong)r2, 0, 0);
#endif
```

而 `brandy/brandy-2.0/u-boot-2018/drivers/smc/sunxi_smc_v2.c:45-50,157-165` 进一步把 `0x8000ff10` 命名为：

- `ARM_SVC_ARISC_STARTUP`

因此，当前 A733 正常启动链可以确定为：

1. U-Boot 自己不在早期 `board_common` 阶段调用 `sunxi_arisc_probe()`
2. 跳内核前通过 SMC 发出 `ARM_SVC_ARISC_STARTUP`
3. 随后跳转到内核

### 9.4 `drivers/arisc/arisc.c` 在当前 A733 上处于什么地位

`brandy/brandy-2.0/u-boot-2018/drivers/arisc/arisc.c` 里仍然保留了旧式 `sunxi_arisc_probe()` 路径：

- 会解析 DT
- 会组装 `dts_cfg_64`
- 会调用 `arm_svc_arisc_startup()`

但对当前 A733 来说，要非常注意两点：

1. 正常 boot 路径并不会先调用它
2. 文件顶部 `39-61` 已经把旧的镜像定位代码用 `#if 0` 注释掉，并明确写了：

```c
#if 0 //boot load scp,so not need this param
```

所以这份文件更像“保留下来的兼容驱动层”，而不是当前正常启动路径的主入口。

### 9.5 关机路径里 MCU 仍然会被用到

`brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:916-921` 的 `sunxi_board_shutdown()` 会调 `sunxi_platform_power_off(0)`。

`brandy/brandy-2.0/u-boot-2018/arch/arm/mach-sunxi/board_sun60iw2.c:27-42` 又明确写了：

- 关机前先 `arm_svc_arisc_startup(cfg_base)`
- 然后再 `arm_svc_poweroff()` 或 `arm_svc_poweroff_charge()`

这说明即使正常 boot 时绕过了 `sunxi_arisc_probe()`，A733 的 U-Boot 关机/掉电路径依然把 MCU 视为关键参与者。

## 10. 代码可见边界与预编译边界

### 10.1 当前源码可见、可改的部分

- `brandy/arisc/ar100s/` 的绝大部分源码
- `build/` 下的构建与打包脚本
- `device/config/chips/a733/` 下的板级配置、DTS、pack cfg
- `brandy/brandy-2.0/u-boot-2018/` 中与 ARISC/SMC/board 相关源码

### 10.2 当前树里明显是预编译交付的部分

- `brandy/dramlib/sun60iw2p1/arisc_liboem/libar100s.a`
- `brandy/dramlib/sun60iw2p1/spl_libdram/libdram`
- `device/config/chips/a733/bin/bl31.bin`

其中最关键的是：

- `libar100s.a` 会被 `library/liboem/sun60iw2p1/Makefile:9-13` 直接拷贝并参与链接
- `bl31.bin` 会被 `build/pack:254-255` 作为 `monitor.fex` 打包

这意味着：

- MCU 固件主体逻辑大部分源码可见
- 但 DRAM OEM 库和 BL31/安全监控器这两块，在当前树里不是源码形态
- 正好也是这两块让“最后谁真正装载 `scp`”无法在当前树里完全走通到最底层

需要特别强调：

- `scp.bin`、`u-boot-sun60iw2p1.bin` 这类 `.bin` 本身不能直接当成“闭源证据”
- 是否闭源/是否预编译，要看仓库中是否有其对应源代码和构建链

## 11. 最终判断

基于当前 SDK 实际源码，A733 的 MCU 链路可以总结为：

1. 当前目标平台是 `A733/x733mhn_aic8800/sun60iw2p1/debian/linux-6.6`。
2. MCU 固件工程是 `brandy/arisc/ar100s`，平台配置为 `sun60iw2p1_defconfig`，编译为一份 RV32 RISC-V 固件。
3. 当前真实 MCU 固件产物是 `scp.bin/scp.fex`；`arisc.fex` 只是镜像兼容占位项。
4. 当前 A733 正常启动时，U-Boot 并不走旧式 `sunxi_arisc_probe()` 主路径，而是在跳内核前通过 `ARM_SVC_ARISC_STARTUP` 请求更低层启动 MCU。
5. `e907/e906/E902/c906` 这些名字在源码里混杂出现，本质上是供应商复用通用 RISC-V 支持层后的历史残留；真正与 A733 绑定的，是 `sun60iw2p1` 专属平台层和驱动层，而不是某个目录名本身。

如果后面还要继续往下挖，最值得继续追的不是 `arisc.fex`，而是这三件事：

1. `bl31.bin` 对 `ARM_SVC_ARISC_STARTUP` 的真实实现。
2. `scp.fex` 在 secure boot / TOC1 中的运行地址与搬运时机。
3. Linux 内核侧与这颗 MCU 的 mailbox / standby / power 交互入口。
