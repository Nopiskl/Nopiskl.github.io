# RV1106 ThunderBoot 双线流程完整分析报告

## 1. 分析目标

基于你提供的总结文档、流程图和当前工作区源码，回答两个问题：

1. 从 SPL 具体函数启用 MCU 开始，**SPL 自己继续做什么**，fastboot 模式下启动链如何精简，Linux 又如何接管 MCU 预初始化的硬件。
2. **MCU 如何被 irq/softirq 放行业务**，启用后调用哪些函数完成 MCU 阶段工作，最后如何与 AP/Linux 握手。

默认前提：

- 板级：`rv1106_evb-SC3338-ADC`
- 路径：非 AOV 的 `battery-ipc / thunderboot / fastboot`
- Sensor：`SC3338`
- ISP：`ISP3`

---

## 2. 一句话结论

这套方案本质上是：

**SPL 很早释放 HPMCU 运行，MCU 抢在 Linux 前完成 sensor/ISP/首帧 AE-AWB 的预热；SPL 自己则继续读取 meta、通知 MCU、并在 fastboot 正常路径下直接启动 Linux 内核；Linux 接管时面对的不是冷硬件，而是 MCU 已经准备好的寄存器状态和共享参数。**

---

## 3. 关键源码文件

### 启动链 / SPL / SoC / meta
- `SDK/luckfox-pico/sysdrv/source/uboot/rkbin/RKBOOT/RV1106MINIALL_TB_SC3336_SC3338.ini`
- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/arch/arm/mach-rockchip/spl.c`
- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/arch/arm/mach-rockchip/rk_meta.c`
- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/arch/arm/mach-rockchip/rv1106/rv1106.c`
- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/common/spl/spl.c`
- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/include/spl.h`
- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/common/spl/Kconfig`

### MCU RT-Thread / camera / ISP
- `SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/bsp/rockchip/rv1106-mcu/applications/main.c`
- `SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/bsp/rockchip/rv1106-mcu/board/common/board_base.c`
- `SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/bsp/rockchip/rv1106-mcu/board/rv1106_evb-SC3338-ADC/board.c`
- `SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/bsp/rockchip/common/drivers/camera/drv_sc3338.c`
- `SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/bsp/rockchip/common/drivers/isp3/drv_isp3.c`
- `SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/applications/battery-ipc/stream.c`
- `SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/applications/battery-ipc/fast_ae.c`

### fastboot 配置 / 构建
- `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk`
- `SDK/luckfox-pico/project/build.sh`
- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/configs/luckfox_rv1106_uboot_emmc_tb_defconfig`

---

## 4. 整体双线流程图

### AP/SPL/Linux 主线

`BootROM -> DDR -> SPL -> 释放 HPMCU -> 读取 meta -> 触发 MCU softirq -> 选择 next stage -> 直接跳 Kernel -> Linux 接管`

### HPMCU/RT-Thread 主线

`HPMCU 释放复位 -> RT-Thread 启动 -> 注册 board/sensor/ISP -> 等待 meta ready -> set_firstae -> sensor/ISP stream on -> fast AE/AWB 收敛 -> 写共享内存 -> mailbox 通知 AP -> wfi`

这两条线不是串行，而是并行推进。

---

# 第一部分：SPL 启用 MCU 后，SPL 自己继续做什么

## 5. Loader 里本来就有 HPMCU 和 SPL

`RV1106MINIALL_TB_SC3336_SC3338.ini` 里明确定义：

- `FlashData`：DDR 初始化镜像
- `Hpmcu`：`rv1106_hpmcu_tb_sc3336_sc3338_v1.91.bin`
- `FlashBoot`：SPL 镜像
- `Hpmcu LOAD_ADDR=0x40000`

说明 MCU 固件不是 Linux 再加载的，而是启动链本身的一部分。

## 6. SPL 的早期通用初始化

`arch/arm/mach-rockchip/spl.c` 的 `board_init_f()` 负责：

- 初始化 timer
- 初始化早期 UART
- 初始化 DRAM
- 初始化 console
- 执行 `arch_cpu_init()`
- 执行 `rk_board_init_f()`

所以 `spl.c` 是 SPL 框架入口，但真正和 MCU 强相关的动作在 RV1106 平台文件里。

## 7. 具体是哪个函数启用 MCU

关键函数在 `rv1106.c`：

- `spl_fit_standalone_release(char *id, uintptr_t entry_point)`

当 `id == "mcu0"` 时，它会：

1. 配置 MCU 非 cache 区
2. 对 HPMCU 做 soft reset
3. 写 `CORE_SGRF_HPMCU_BOOT_ADDR`
4. 释放复位

这就是“**SPL 具体函数启用 MCU**”的直接答案。

## 8. MCU 启动后，SPL 并不会停，而是继续自己的主线

SPL 放飞 MCU 后，会继续：

1. 读取 boot / fit / kernel 相关镜像
2. 读取 `meta` 分区
3. 装载 IQ 和启动参数到 DDR
4. 通知 MCU：meta 已经 ready
5. 判断下一个 stage 是 Kernel 还是 U-Boot proper
6. 在正常 fastboot 路径下直接跳 Linux

也就是说：

- MCU 在并行做相机首帧准备
- SPL 在并行做 AP 侧最短启动链

## 9. SPL/U-Boot 如何准备 meta 并通知 MCU

`rk_meta.c` 的 `spl_load_meta()` 会：

- 找到 `meta` 分区
- 读取 meta header
- 读取/解压 IQ 数据
- 将内容放入 `meta.load`
- 最后置 `meta_flags = META_READ_DONE_FLAG`
- `flush_cache()`
- 调 `rk_meta_process()`

而 RV1106 平台的 `rk_meta_process()` 在 `rv1106.c` 中，只做一件事：

- 写 `CORE_GRF_MCU_CACHE_MISC`

这就是对 MCU 的 softirq 触发。

所以分工很清楚：

- `spl_fit_standalone_release()`：让 MCU 核开始跑
- `spl_load_meta()` + `rk_meta_process()`：让 MCU 业务开始跑

---

# 第二部分：fastboot 模式下，启动链精简了什么

## 10. fastboot 不是“没用 U-Boot”，而是“不进完整 U-Boot proper”

从 `BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk` 可确认：

- `RK_ENABLE_FASTBOOT=y`
- 仍然有 `uboot` 分区
- 仍然有 `meta` 分区
- 仍然使用 U-Boot defconfig 和 rkbin 打包体系

但运行时正常路径不是 `SPL -> U-Boot proper -> Kernel`，而是 `SPL -> Kernel`。

## 11. 关键配置证据

`luckfox_rv1106_uboot_emmc_tb_defconfig` 中的关键选项：

- `CONFIG_SPL_LOAD_FIT=y`
- `CONFIG_SPL_KERNEL_BOOT=y`
- `CONFIG_SPL_BLK_READ_PREPARE=y`
- `CONFIG_SPL_MISC_DECOMPRESS=y`
- `CONFIG_SPL_ROCKCHIP_HW_DECOMPRESS=y`

`common/spl/Kconfig` 又明确写了：

- `SPL_KERNEL_BOOT: Enable boot kernel in SPL`

`include/spl.h` 说明：

- `spl_start_uboot()` 返回 `0` 表示 SPL 启动 kernel
- 返回 `1` 表示 SPL 启动 U-Boot

## 12. SPL 如何决定下一个阶段

`arch/arm/mach-rockchip/spl.c` 中的 `spl_next_stage()` 逻辑是：

以下情况进 `SPL_NEXT_STAGE_UBOOT`：

- 恢复键/下载键
- Ctrl+C
- 低电量
- `BOOT_LOADER / BOOT_FASTBOOT / BOOT_CHARGING / BOOT_UMS / BOOT_DFU`

其他正常情况：

- 默认 `SPL_NEXT_STAGE_KERNEL`

所以 fastboot 正常启动分支的核心不是“删了 U-Boot 源码”，而是：

> 默认 next stage 就是 Kernel。

## 13. SPL 最终如何直接跳 Linux

`common/spl/spl.c` 中，当 `spl_image.os == IH_OS_LINUX` 且启用 `CONFIG_SPL_KERNEL_BOOT` 时，会直接走 Linux 跳转路径，而不是进入完整 U-Boot proper。

### 这到底精简了什么

精简的不是内核本身，而是 **boot chain**：

- 去掉了 `U-Boot proper` 的常规启动阶段
- 由 SPL 直接完成 FIT 读取、镜像装载、必要解压、跳内核

所以更准确的说法是：

**fastboot 精简的是启动链前半段，而不是简单地“换了一个精简版 Linux 内核”。**

---

# 第三部分：MCU 是如何通过 irq/softirq 被启用并开始业务的

## 14. MCU 核启动 vs MCU 业务放行，要分开看

### 第一层：MCU 核启动

MCU 核本身是由 SPL 的 `spl_fit_standalone_release()` 写 boot address + release reset 启动的。

### 第二层：MCU 业务放行

MCU camera fastboot 业务不是一启动就直接跑到底，而是要等 AP/SPL 侧发来的 softirq 事件：

- SPL/U-Boot 读完 meta
- 写 `CORE_GRF_MCU_CACHE_MISC`
- MCU 侧 softirq handler 收到后把 `sirq` 置真
- `parse_meta_params()` 检测到 `sirq_status() == RT_TRUE` 且 `META_READ_DONE_FLAG` 为真，才继续执行

所以准确说法是：

**MCU 核是被 SPL 放飞的；MCU 的 fastboot camera 业务，是被 meta ready 对应的 softirq 放行的。**

## 15. MCU 软件第一个入口

MCU 入口在：

- `rt-thread/.../applications/main.c`

执行路径：

- `main()`
- `rtthread_startup()`
- `rt_hw_board_init()`
- `rt_system_tick_init()`
- `rt_system_object_init()`
- `rt_system_timer_init()`
- `rt_system_scheduler_init()`
- `rt_application_init()`
- `rt_system_scheduler_start()`

也就是说 MCU 先完成标准 RT-Thread 启动。

## 16. softirq 安装点在哪里

`board/common/board_base.c` 中：

- `board_softirq_handler()`：收到 softirq 后设置 `sirq = RT_TRUE`
- `sirq_status()`：返回 softirq 是否到达
- `rt_hw_board_init()`：通过 `rt_soft_interrupt_install()` 安装该 handler

这就是 MCU 侧等待 AP 通知的基础设施。

## 17. MCU 具体在哪里等这个软中断条件

关键函数在 `fast_ae.c` 的 `parse_meta_params()`。

非 AOV 路径下，它循环等待：

- `sirq_status() == RT_TRUE`
- `metahead_p->meta_flags == META_READ_DONE_FLAG`

满足后才开始解析：

- app 参数
- sensor_init 参数
- AE/AWB 参数
- IQ bin
- night mode / hdr / fps / flip/mirror 等

所以流程图中的“U-Boot 读完 meta 后触发 MCU 开始工作”，在源码里的准确落点就是这个判断。

---

# 第四部分：MCU 启用后会调用哪些函数完成 MCU 阶段工作

## 18. MCU 业务主入口：`isp_stream()`

真正自动运行的 MCU 应用入口在：

- `stream.c` 的 `isp_stream()`
- 通过 `INIT_APP_EXPORT(isp_stream)` 自动启动

它是整个 battery-ipc/thunderboot 主流程的中心。

## 19. `start_stream()`：把 first-frame 链路拉起来

`isp_stream()` 里首先调用 `start_stream(dev, param)`，它完成：

1. 打开 ISP 设备
2. 设置 ISP 输出格式
3. 申请 buffer
4. 全部 `QBUF`
5. 创建 `firstae_thread`
6. 触发 sensor `STREAM_ON`
7. 等待 `set_firstae()` 完成
8. 让 ISP `STREAM_ON`
9. 在 `CAM_STREAM_ON_LATE` 模式下执行 `STREAM_ON_LATE`
10. 调 `start_ae()` 启动 fast AE/AWB 线程

这一步把 sensor、ISP、first AE 三者的时序组织起来了。

## 20. `set_firstae()`：MCU 快起的第一核心函数

`set_firstae()` 主要完成四件事：

### 1）解析 meta
通过 `parse_meta_params()` 得到：
- 分辨率
- fps
- hdr
- flip/mirror
- night mode
- led/ircut/adc/als 配置
- IQ bin
- AE/AWB 初始化参数

### 2）把目标模式下发给 sensor
构造 `rk_camera_dst_config`，通过 `RK_DEVICE_CTRL_CID_MATCH_CAM_CONFIG` 让 SC3338 驱动匹配目标模式。

### 3）计算并写入首帧曝光
内部调用 `set_ae_init()`：
- 读 sensor timing
- FastAeInit
- 根据 ALS/ADC 判断昼夜
- 控制 IRCut / IR / 白灯
- 计算 `start_reg_time / start_reg_gain / start_dcg_mode`

随后通过 `RK_DEVICE_CTRL_CAMERA_SET_EXP_VAL` 把首帧曝光直接写入 sensor。

### 4）预设 ISP 参数
构造 `rkisp_params_buffer`，提前设置：
- BLS
- AWB gain
- 部分 NR/BAY3D 参数
- 共享缓冲区布局

这说明 MCU 并不是只算一个曝光值，而是把首帧相关的 sensor + ISP 初始状态都提前准备好了。

## 21. `start_ae()`：拉起 fast AE/AWB 的两个线程

`start_ae()` 创建两个线程：

- `exp_thread`
- `stat_thread`

### `exp_thread`
- 等待曝光信号量
- 在正确时刻把曝光写入 sensor
- 记录 `explog[]`

### `stat_thread`
- 获取 ISP stats
- 调 AWB
- 调 `calculate_ae()` / `FastAeRun()`
- 将结果写回共享内存
- 更新 `is_match` / `is_over_range`

主线程 `isp_stream()` 只需根据：

- `isae_match()`
- `isae_over_range()`
- `share->frame_num`

决定是否结束 fast AE 阶段。

## 22. `stop_ae()`：交接给 Linux 的第二核心函数

当收敛完成或到达帧数上限后，`stop_ae()` 会：

- 将最终结果写入 `gShare`
- 写 `md_flag`
- 写最终宽高
- 调 `set_isp_params_for_kernel(gShare, ...)`
- 双摄时映射第二路参数
- 停止 `stat_thread` 和 `exp_thread`

注意这个函数名已经说明目的：

> 这些参数是留给 kernel/Linux 继续使用的。

## 23. `isp_stream()` 退出前的最后整理

MCU 不会在 `stop_ae()` 后立刻退出，而是继续做 handoff 收尾：

- 根据目标分辨率设置 sensor format
- 设置 `dst_vts`
- 把最终 `exp_time_reg / exp_gain_reg / dcg_mode` 再写回 sensor

这一步非常关键，因为它说明 Linux 接手时，看到的是：

- **共享内存中已经准备好的 handoff 参数**
- **sensor 寄存器层面已经恢复到 Linux 预期状态**

## 24. mailbox 通知 + wfi

最后 `isp_stream()` 会：

- 通过 `HAL_MBOX_SendMsg2()` 给 AP 发消息
- 关闭 I/D cache
- 停 `sysTick`
- 进入 `wfi`

也就是说 MCU 阶段工作完成后，会把控制权留给 AP/Linux，自身进入等待态。

---

# 第五部分：Linux 是如何接管 MCU 初始化好的硬件

## 25. 先明确“接管”的三种含义

这里的“Linux 接管”不是单一函数，而是三层接力：

### 1）启动控制权接力
fastboot 正常路径下，SPL 默认直接跳 Kernel，所以控制权本身就是 `SPL -> Linux`。

### 2）硬件状态接力
MCU 已经把：
- sensor 模式
- vts
- 最终曝光寄存器

整理到了 Linux 易于继续运行的状态。

### 3）参数状态接力
`drv_isp3.c` 初始化时已把共享内存地址固定到：

- `share_mem_addr = RT_USING_ISP_DDR_ADRESS`
- `share_mem_size = RT_USING_ISP_DDR_SIZE`

在当前配置中可对应到：

- meta：`0x800000`
- ISP 共享区：`0x860000`
- 共享区大小：`0x600000`

MCU 的 `stop_ae()` 已经把最终曝光和 ISP 参数快照写进去了。

## 26. 当前源码能直接证实到哪一步

本次源码核对中，MCU 侧能明确证实：

- MCU 确实写了共享内存
- MCU 确实调用 `set_isp_params_for_kernel()`
- MCU 确实通过 mailbox 通知 AP
- MCU 确实把 sensor 调回 Linux 预期状态

而 Linux 侧“哪一个具体驱动函数逐项消费这块共享区”的代码，在当前工作区里没有 MCU 侧这样清晰、集中地直接串出来。

因此最严谨的结论是：

- **已被源码证实**：MCU 完成了 handoff 所需的硬件和数据准备
- **可由函数命名和架构明确推断**：Linux/ISP/rkaiq 后续会消费这份共享参数继续完成 camera pipeline

---

# 第六部分：最终回答两个问题

## 27. 问题 1：MCU 启动后，SPL 会继续做什么？

答案：

SPL 在 `spl_fit_standalone_release()` 启动 MCU 后，继续沿 AP 主线做这些事：

1. 继续处理 boot/FIT 镜像
2. 读取 `meta` 分区
3. 装载 IQ 和启动参数到 DDR
4. 置 `META_READ_DONE_FLAG`
5. 写 `CORE_GRF_MCU_CACHE_MISC` 触发 MCU softirq
6. 通过 `spl_next_stage()` 判断下一阶段
7. fastboot 正常路径默认直接走 `SPL_NEXT_STAGE_KERNEL`
8. SPL 直接启动 Linux kernel

fastboot 的核心精简是：

- 去掉了完整 `U-Boot proper` 的常规启动阶段
- 由 SPL 直接加载并跳 Linux

Linux 接管 MCU 初始化硬件的方式是：

- 继承 MCU 已经配置好的 sensor 硬件状态
- 继承共享内存中的 first AE / ISP handoff 参数
- 在更短的 boot chain 上继续完成自己的 camera 初始化

## 28. 问题 2：MCU 如何通过 irq 被启用？启用后调用哪些函数？如何与内核握手？

答案：

严格说 MCU 核不是靠 irq 启动，而是靠 SPL 的 `spl_fit_standalone_release()` 释放复位启动。

但 MCU 的 fastboot 业务确实依赖 softirq 放行：

- SPL/U-Boot 读完 meta
- `rk_meta_process()` 写 `CORE_GRF_MCU_CACHE_MISC`
- `board_softirq_handler()` 把 `sirq` 置真
- `parse_meta_params()` 看到 `sirq_status() == RT_TRUE` 且 `META_READ_DONE_FLAG` 生效，开始继续业务

之后 MCU 的主要调用链是：

- `main()`
- `rtthread_startup()`
- `rt_hw_board_init()`
- `isp_stream()`
- `start_stream()`
- `set_firstae()`
- `start_ae()`
- `exp_thread()` / `stat_thread()`
- `stop_ae()`
- `HAL_MBOX_SendMsg2()`
- `wfi`

握手分三次：

1. **AP -> MCU**：meta ready + softirq
2. **MCU -> AP**：共享内存写好 + mailbox 通知
3. **Linux 接管**：使用 MCU 已准备好的 sensor 状态和共享参数继续启动 camera pipeline

---

## 29. 最终总结

这套 RV1106 ThunderBoot 的核心，不是某一个单点函数，而是下面这条链：

`loader(DDR+HPMCU+SPL) -> spl_fit_standalone_release() -> spl_load_meta()/rk_meta_process() -> board_softirq_handler()/parse_meta_params() -> set_firstae() -> start_ae()/stop_ae() -> mailbox -> SPL 直启 Kernel -> Linux 接管`

最关键的 6 个落点：

- MCU 启动点：`spl_fit_standalone_release()`
- MCU 业务放行点：`rk_meta_process()` + `board_softirq_handler()`
- MCU 主业务入口：`isp_stream()`
- 首帧核心：`set_firstae()`
- 交接给内核的核心：`stop_ae()` + `set_isp_params_for_kernel()`
- fastboot 启动核心：默认 `SPL_NEXT_STAGE_KERNEL`，即 `SPL -> Kernel`
