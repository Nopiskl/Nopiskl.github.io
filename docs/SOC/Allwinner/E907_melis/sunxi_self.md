# 全志私有源码及其作用
_Exported on 2026/3/31 at GMT+8 17:28:37 from Cursor (2.6.21)_

---

**User**

@melis-v3.0 melis系统中全志私有的源码是哪些？作用是什么？

---

**Cursor**

我来分析一下 melis-v3.0 目录结构，找出全志私有的源码。

`ekernel` 在 `source` 下，让我继续探索各子目录：

---

**User**

继续

---

**Cursor**

现在我已经收集了足够的信息，可以给出完整的分析。让我再看一下几个关键的全志私有模块：

现在我有足够的信息来给出完整分析了。以下是 melis-v3.0 中全志（Allwinner）私有源码的详细说明：

---

## melis-v3.0 中全志私有源码分析

### 一、总体结构

melis-v3.0 是全志基于开源 RTOS（RT-Thread）二次开发的嵌入式实时操作系统，专用于其 E907 RISC-V 协处理器核心。代码分为**全志私有**和**第三方开源**两大部分。

---

### 二、全志私有源码清单及作用

#### 1. `ekernel/arch/riscv/sunxi/` — 全志芯片平台初始化
- `startup.c` / `blobdata.S`：E907 核心上电后的低层启动代码，初始化堆栈、BSS 段、跳转到 `main`
- `va2pa.c`：虚拟地址到物理地址的转换，全志自定义内存映射
- `cpufreq.c`：CPU 调频支持
- `sun20iw3/init.c`、`sun20iw3_cpufreq.c`：针对 sun20iw3（V851/V853 系列）的具体芯片初始化和调频实现

#### 2. `ekernel/arch/riscv/rv32/e907/` — E907 核心支持
- `clic/ck_irq.c`：全志定制 CLIC（Core-Local Interrupt Controller）中断控制器驱动
- `cache.c`、`system.c`、`trap_c.c`：E907 Cache 管理、系统初始化、异常陷阱处理
- `startup_gcc.S`、`vectors.S`、`sleep.S`：汇编级启动向量表和低功耗 Sleep 指令序列

#### 3. `ekernel/drivers/drv/source/` — 全志外设驱动
| 驱动目录 | 作用 |
|---|---|
| `ccmu/drv_ccmu.c` | 时钟控制管理单元（CCU），管理全志芯片内所有外设时钟的开关与分频 |
| `dma/dma_drv.c` | DMA 控制器驱动，负责内存与外设间的数据搬运 |
| `gpio/drv_gpio.c` | GPIO 驱动，管理引脚复用（Pinmux）和电平控制 |
| `serial/uart_drv.c` | UART 串口驱动（调试输出/通信） |
| `spi/spi_drv.c` | SPI 总线驱动 |
| `twi/drv_twi.c` | TWI（I²C 兼容）总线驱动 |
| `pwm/drv_pwm.c` | PWM 输出驱动 |
| `rtc/drv_rtc.c` | RTC 实时时钟驱动 |
| `watchdog/drv_watchdog.c` | 硬件看门狗驱动 |
| `input/` | 触摸屏（CTP/RTP）、红外遥控（IR）、键盘等输入设备驱动 |
| `ledc/drv_ledc.c` | LED 控制器驱动 |
| `adc_power/adc_power.c` | ADC 电源检测驱动 |
| `regulator/core.c` | 电源调节器（PMIC）框架驱动 |
| `ram_dev/ramfs_device.c` | RAM 设备驱动（内存文件系统后端） |

#### 4. `ekernel/drivers/osal/` — 全志 OS 抽象层（OSAL）
- `hal_atomic.c`、`hal_cache.c`、`hal_mem.c`、`hal_interrupt.c` 等：将底层硬件操作封装为统一的 HAL API，屏蔽 RTOS 差异，供上层驱动调用

#### 5. `ekernel/components/aw/` — 全志私有系统组件

| 组件 | 作用 |
|---|---|
| `script_config/script.c`、`sys_config.c` | 解析 `sys_config.fex` 板级配置文件，类似 Linux 的 Device Tree，全志特有机制 |
| `standby/standby_e907.c`、`pm_notify.c` | E907 核心的低功耗待机/唤醒管理，与 ARM 主核协同休眠 |
| `rpbuf/rpbuf_core.c`、`rpbuf_controller.c` | **RPBuf**（Remote Processor Buffer）：全志私有的 ARM↔E907 核间共享内存缓冲区机制，用于双核间高效传递大块数据（如音视频帧） |
| `multi_console/rpmsg_console/` | 基于 RPMsg 协议的多路控制台，将 E907 的 Shell 输出通过核间通信转发到 ARM 侧 |
| `kallsyms/kallsyms.c` | 内核符号表支持，用于异常时打印函数名调用栈 |
| `debug/debug_backtrace.c` | 全志定制的栈回溯调试功能 |
| `virt_log/` | 虚拟日志系统，核间日志缓冲 |

#### 6. `source/projects/v853-e907-*/` — 板级配置工程
- 每个 `project` 对应一款全志芯片/板型，包含：
  - `configs/sys_config.fex`：全志私有的板级硬件配置描述文件（引脚、时钟、外设参数）
  - `configs/defconfig`：内核功能裁剪配置
  - `src/main.c`：E907 核心应用入口
  - `kernel.lds`：全志定制链接脚本

---

### 三、与开源部分的对比

| 部分 | 来源 | 说明 |
|---|---|---|
| `ekernel/core/rt-thread/` | **开源**（RT-Thread） | RTOS 内核调度、IPC、内存管理 |
| `ekernel/components/thirdparty/dfs/` | **开源**（RT-Thread DFS + FatFS/LittleFS） | 文件系统框架 |
| `ekernel/components/thirdparty/openamp/` | **开源**（OpenAMP） | RPMsg 核间通信基础框架 |
| `ekernel/components/thirdparty/pthreads/` | **开源** | POSIX 线程支持 |
| `ekernel/components/aw/` | **全志私有** | 在开源框架之上的私有扩展 |
| `ekernel/arch/riscv/sunxi/` | **全志私有** | 芯片级硬件适配 |
| `ekernel/drivers/drv/` | **全志私有** | 所有外设 HAL 驱动 |

---

### 核心总结

全志私有代码的核心价值在于三点：
1. **芯片适配**：E907 核心的启动、中断、Cache、低功耗管理（`arch/riscv/sunxi/`、`rv32/e907/`）
2. **外设驱动**：CCU/DMA/GPIO/UART/SPI 等全志自研外设的 HAL 驱动（`drivers/drv/`）
3. **双核协同**：RPBuf + RPMsg Console 实现 ARM 主核与 E907 协处理器之间的数据通信和控制联动（`components/aw/rpbuf/`、`multi_console/`），以及全志特有的 `sys_config.fex` 板级配置体系

