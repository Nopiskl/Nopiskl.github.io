# 整体系统架构分析
_Exported on 2026/3/31 at GMT+8 16:47:22 from Cursor (2.6.21)_

---

**User**

帮我分析一下@melis-v3.0 ​整个系统架构

---

**Cursor**

我来分析 melis-v3.0 的整个系统架构，先浏览目录结构。

继续深入探索各个子目录结构。

继续深入探索核心子目录。

继续深入探索关键目录。

继续深入探索更多关键目录。

再深入查看几个关键文件。

再读取几个关键配置和构建文件来完善分析。

现在我已经收集了足够的信息，可以对 melis-v3.0 整个系统架构进行全面分析。

---

## Melis v3.0 系统架构分析

### 一、整体概述

Melis v3.0 是全志科技（Allwinner）为其 SoC 产品（V851/V853 系列）开发的一套**RTOS嵌入式实时操作系统 SDK**，专门运行在异构多核芯片的**协处理器核心（E907，RISC-V架构）**上，与运行 Linux 的主核（ARM/A 核）协同工作，构成 AMP（非对称多处理）系统。

---

### 二、顶层目录结构

```
melis-v3.0/
├── source/          # 核心源码
├── tools/           # 交叉编译工具链 (xcompiler)
└── LICENSE
```

---

### 三、源码层次架构（source/）

整体分为 **5 大模块**，从下到上构成完整的软件栈：

```
source/
├── ekernel/         # 内核核心（E核心）
├── drivers/         # 驱动层（HAL + 平台驱动）
├── projects/        # 板级工程（BSP）
├── include/         # 公共头文件
└── scripts/         # 构建脚本
```

---

### 四、内核层（ekernel/）— 核心层次

```
ekernel/
├── arch/            # 体系架构支持
│   └── riscv/
│       ├── rv32/        # RV32 指令集支持
│       ├── csp/         # 片上系统 UART 底层驱动
│       ├── compressed/  # 内核压缩启动
│       ├── standby/     # 待机/休眠
│       └── sunxi/       # 全志平台相关（sun20iw3/）
│           ├── startup.c    # 启动入口
│           ├── cpufreq.c    # CPU频率管理
│           └── va2pa.c      # 虚拟/物理地址转换
│
├── core/            # RTOS 内核
│   └── rt-thread/       # RT-Thread 实时操作系统
│       ├── thread.c     # 线程管理
│       ├── scheduler.c  # 调度器（32优先级抢占式）
│       ├── ipc.c        # 线程间通信（信号量/互斥量/邮箱/消息队列）
│       ├── mem.c/slab.c # 内存管理（SLAB分配器）
│       ├── timer.c      # 定时器
│       ├── irq.c        # 中断管理
│       └── device.c     # 设备对象模型
│
├── components/      # 软件组件
│   ├── aw/          # 全志自研组件
│   │   ├── debug/       # 调试支持
│   │   ├── openamp/     # AMP 通信（含 rpbuf/rpmsg）
│   │   ├── standby/     # 待机管理
│   │   ├── kallsyms/    # 内核符号表
│   │   ├── virt_log/    # 虚拟日志
│   │   └── newlib/      # C 库桥接
│   └── thirdparty/  # 第三方组件
│       ├── openamp/     # OpenAMP（libmetal + open-amp）
│       ├── finsh_cli/   # Finsh/MSH 命令行 Shell
│       ├── dfs/         # 虚拟文件系统（FAT等）
│       ├── pthreads/    # POSIX 线程接口
│       ├── devicetree/  # 设备树解析
│       ├── mmap/        # 内存映射
│       └── rbtree/      # 红黑树
│
├── subsys/          # 子系统
│   ├── libc/        # C 标准库
│   └── aw/
│       └── multi_console/ # 多控制台支持
│
└── drivers/         # 内核内置驱动（指向 source/drivers 的镜像）
```

---

### 五、驱动层（drivers/）— 双层驱动架构

采用了**两层驱动设计**：

#### 1. HAL 层（rtos-hal/）— 硬件抽象层
```
drivers/rtos-hal/hal/source/
├── ccmu/      # 时钟控制管理单元
├── gpio/      # GPIO 驱动
├── uart/      # 串口驱动
├── twi/       # I2C 驱动
├── spi/       # SPI 驱动
├── dma/       # DMA 控制器
├── pwm/       # PWM 驱动
├── rtc/       # 实时时钟
├── gpadc/     # 通用 ADC
├── msgbox/    # 消息盒（AMP 核间通信）
├── vin/       # 视频输入（ISP + MIPI Camera）
└── common/    # 公共 HAL 接口
```

#### 2. 平台驱动层（drv/source/）— RT-Thread 设备框架
```
drivers/drv/source/
├── serial/    # 串口设备驱动
├── gpio/      # GPIO 设备驱动
├── twi/       # I2C 设备驱动
├── spi/       # SPI 设备驱动
├── dma/       # DMA 设备驱动
├── ccmu/      # 时钟设备驱动
├── timer/     # 定时器驱动
├── watchdog/  # 看门狗
├── rtc/       # RTC 设备驱动
├── pwm/       # PWM 设备驱动
├── ledc/      # LED 控制器
├── regulator/ # 电源调节器
└── ram_dev/   # RAM 设备
```

---

### 六、AMP 通信架构（OpenAMP）

这是 Melis v3.0 最核心的特性之一：**E907（RISC-V）与 ARM A 核之间的 AMP 通信**。

```
ARM A核 (Linux)          E907核 (Melis/RT-Thread)
     |                          |
     |<--- RPMsg 消息通道 ------>|
     |<--- RPBuf 共享缓冲区 ---->|
     |<--- Share IRQ 共享中断 -->|
     |                          |
  [MSGBOX硬件邮箱]          [MSGBOX驱动]
     |______________________________|
              物理消息通道
```

- **rpmsg_notify**：轻量级事件通知（main.c 中大量使用，通知 twi1/tdm0/isp0/scaler 等设备就绪）
- **RPBuf**：共享内存 Buffer，用于大块数据传输（如图像数据）
- **libmetal**：OpenAMP 底层金属抽象层
- **Heartbeat**：核间心跳检测机制

---

### 七、板级工程（projects/）— BSP 支持

支持多款全志 SoC 的板级配置：

| 工程名 | 芯片 | 特性 |
|--------|------|------|
| `v851-e907-perf2-board` | V851 | 单摄像头性能板 |
| `v851-e907-perf2-dual-camera-board` | V851 | 双摄像头 |
| `v853-e907-perf4-board` | V853 | 高性能板 |
| `v851s3-e907-perf2-board` | V851S3 | S3 变体 |
| `r853-e907-scanp-board` | R853 | 扫描应用板 |

每个工程包含：
- `configs/defconfig` — Kconfig 配置
- `configs/sys_config.fex` — 板级硬件配置（引脚/外设）
- `src/main.c` — 应用入口（`app_entry`）
- `kernel.lds` — 链接脚本

---

### 八、应用入口分析（main.c）

```1:37:melis-v3.0/source/projects/v851-e907-perf2-board/src/main.c
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
	// ...
#endif
```

`app_entry` 是 E907 核启动后的用户入口：初始化 CSI（摄像头）驱动，然后通过 `rpmsg_notify` 依次通知 ARM A 核各设备已就绪。

---

### 九、构建系统

- 基于 **Linux Kernel Kbuild 风格**（Makefile + Kconfig）
- 交叉编译工具链：`riscv64-unknown-elf-`（RV32 模式）
- 架构标志：`-mcmodel=medany -mabi=ilp32d -march=rv32imafdcxthead`（T-Head 扩展指令集）
- 版本：**Melis SDK 4.0.0**
- 构建产物：`melis30.elf` → 压缩为 `zImage` → 打包进 Tina Linux 固件

---

### 十、整体架构图

```
┌─────────────────────────────────────────────────────┐
│                   应用层 (projects/)                 │
│         app_entry → csi_init → rpmsg_notify         │
├─────────────────────────────────────────────────────┤
│              组件层 (ekernel/components/)            │
│  finsh_cli | openamp | dfs | pthreads | newlib      │
├──────────────────────┬──────────────────────────────┤
│   RTOS核心           │       子系统                  │
│  (RT-Thread)         │  libc | multi_console        │
│  调度/IPC/内存/设备  │                               │
├──────────────────────┴──────────────────────────────┤
│              平台驱动层 (drivers/drv/)               │
│   serial | gpio | twi | spi | dma | timer | ...    │
├─────────────────────────────────────────────────────┤
│              HAL 抽象层 (drivers/rtos-hal/)          │
│   uart | gpio | twi | spi | dma | vin | msgbox      │
├─────────────────────────────────────────────────────┤
│              体系架构层 (ekernel/arch/riscv/)        │
│   startup | 中断向量 | MMU | 待机 | 压缩启动         │
├─────────────────────────────────────────────────────┤
│         硬件：全志 V851/V853 SoC E907(RISC-V)        │
└─────────────────────────────────────────────────────┘
         ↑↓  OpenAMP (RPMsg + RPBuf + MsgBox)
┌─────────────────────────────────────────────────────┐
│         ARM A 核：Linux (Tina OS)                    │
└─────────────────────────────────────────────────────┘
```

---

### 十一、关键特性总结

| 特性 | 说明 |
|------|------|
| **内核** | RT-Thread v3.x，32级优先级抢占调度 |
| **架构** | RISC-V RV32（T-Head E907），含FPU/双精度浮点 |
| **AMP通信** | OpenAMP（RPMsg + RPBuf + 共享中断） |
| **摄像头** | VIN子系统（ISP + MIPI CSI，支持GC4663等传感器） |
| **文件系统** | DFS 虚拟文件系统（FAT支持） |
| **Shell** | Finsh/MSH 命令行 |
| **C库** | Newlib |
| **构建** | Kbuild + Kconfig（类Linux内核风格） |
| **多板支持** | 16款不同板卡配置 |

```plaintext
melis-v3.0/
├── source/          # 核心源码
├── tools/           # 交叉编译工具链 (xcompiler)
└── LICENSE
```

```plaintext
source/
├── ekernel/         # 内核核心（E核心）
├── drivers/         # 驱动层（HAL + 平台驱动）
├── projects/        # 板级工程（BSP）
├── include/         # 公共头文件
└── scripts/         # 构建脚本
```

```plaintext
ekernel/
├── arch/            # 体系架构支持
│   └── riscv/
│       ├── rv32/        # RV32 指令集支持
│       ├── csp/         # 片上系统 UART 底层驱动
│       ├── compressed/  # 内核压缩启动
│       ├── standby/     # 待机/休眠
│       └── sunxi/       # 全志平台相关（sun20iw3/）
│           ├── startup.c    # 启动入口
│           ├── cpufreq.c    # CPU频率管理
│           └── va2pa.c      # 虚拟/物理地址转换
│
├── core/            # RTOS 内核
│   └── rt-thread/       # RT-Thread 实时操作系统
│       ├── thread.c     # 线程管理
│       ├── scheduler.c  # 调度器（32优先级抢占式）
│       ├── ipc.c        # 线程间通信（信号量/互斥量/邮箱/消息队列）
│       ├── mem.c/slab.c # 内存管理（SLAB分配器）
│       ├── timer.c      # 定时器
│       ├── irq.c        # 中断管理
│       └── device.c     # 设备对象模型
│
├── components/      # 软件组件
│   ├── aw/          # 全志自研组件
│   │   ├── debug/       # 调试支持
│   │   ├── openamp/     # AMP 通信（含 rpbuf/rpmsg）
│   │   ├── standby/     # 待机管理
│   │   ├── kallsyms/    # 内核符号表
│   │   ├── virt_log/    # 虚拟日志
│   │   └── newlib/      # C 库桥接
│   └── thirdparty/  # 第三方组件
│       ├── openamp/     # OpenAMP（libmetal + open-amp）
│       ├── finsh_cli/   # Finsh/MSH 命令行 Shell
│       ├── dfs/         # 虚拟文件系统（FAT等）
│       ├── pthreads/    # POSIX 线程接口
│       ├── devicetree/  # 设备树解析
│       ├── mmap/        # 内存映射
│       └── rbtree/      # 红黑树
│
├── subsys/          # 子系统
│   ├── libc/        # C 标准库
│   └── aw/
│       └── multi_console/ # 多控制台支持
│
└── drivers/         # 内核内置驱动（指向 source/drivers 的镜像）
```

```plaintext
drivers/rtos-hal/hal/source/
├── ccmu/      # 时钟控制管理单元
├── gpio/      # GPIO 驱动
├── uart/      # 串口驱动
├── twi/       # I2C 驱动
├── spi/       # SPI 驱动
├── dma/       # DMA 控制器
├── pwm/       # PWM 驱动
├── rtc/       # 实时时钟
├── gpadc/     # 通用 ADC
├── msgbox/    # 消息盒（AMP 核间通信）
├── vin/       # 视频输入（ISP + MIPI Camera）
└── common/    # 公共 HAL 接口
```

```plaintext
drivers/drv/source/
├── serial/    # 串口设备驱动
├── gpio/      # GPIO 设备驱动
├── twi/       # I2C 设备驱动
├── spi/       # SPI 设备驱动
├── dma/       # DMA 设备驱动
├── ccmu/      # 时钟设备驱动
├── timer/     # 定时器驱动
├── watchdog/  # 看门狗
├── rtc/       # RTC 设备驱动
├── pwm/       # PWM 设备驱动
├── ledc/      # LED 控制器
├── regulator/ # 电源调节器
└── ram_dev/   # RAM 设备
```

```plaintext
ARM A核 (Linux)          E907核 (Melis/RT-Thread)
     |                          |
     |<--- RPMsg 消息通道 ------>|
     |<--- RPBuf 共享缓冲区 ---->|
     |<--- Share IRQ 共享中断 -->|
     |                          |
  [MSGBOX硬件邮箱]          [MSGBOX驱动]
     |______________________________|
              物理消息通道
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
	rpmsg_notify("tdm0", NULL, 0);
	rpmsg_notify("isp0", NULL, 0);
	rpmsg_notify("scaler0", NULL, 0);
	// ...
#endif
```

```plaintext
┌─────────────────────────────────────────────────────┐
│                   应用层 (projects/)                 │
│         app_entry → csi_init → rpmsg_notify         │
├─────────────────────────────────────────────────────┤
│              组件层 (ekernel/components/)            │
│  finsh_cli | openamp | dfs | pthreads | newlib      │
├──────────────────────┬──────────────────────────────┤
│   RTOS核心           │       子系统                  │
│  (RT-Thread)         │  libc | multi_console        │
│  调度/IPC/内存/设备  │                               │
├──────────────────────┴──────────────────────────────┤
│              平台驱动层 (drivers/drv/)               │
│   serial | gpio | twi | spi | dma | timer | ...    │
├─────────────────────────────────────────────────────┤
│              HAL 抽象层 (drivers/rtos-hal/)          │
│   uart | gpio | twi | spi | dma | vin | msgbox      │
├─────────────────────────────────────────────────────┤
│              体系架构层 (ekernel/arch/riscv/)        │
│   startup | 中断向量 | MMU | 待机 | 压缩启动         │
├─────────────────────────────────────────────────────┤
│         硬件：全志 V851/V853 SoC E907(RISC-V)        │
└─────────────────────────────────────────────────────┘
         ↑↓  OpenAMP (RPMsg + RPBuf + MsgBox)
┌─────────────────────────────────────────────────────┐
│         ARM A 核：Linux (Tina OS)                    │
└─────────────────────────────────────────────────────┘
```

