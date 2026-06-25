# V821 `perf2_fastboot` Fastboot Camera 快起流程分析

本文基于当前 SDK 代码和 `device/config/chips/v821/configs/perf2_fastboot` 板级配置整理，并横向核对 `device/config/chips/v821/configs` 下 fastboot 与非 fastboot 配置的 RISC-V/E907 启动方式。`agent/` 目录中其他低级 agent 的分析可作为线索，但需要以源码为准校正以下结论：E907 RTOS 并不是只运行 ISP server；`csi_init()` 首次启动并不是持续保持 sensor 实时出流到 Linux 接管；`CFG_EARLY_BOOT_RISCV` 关闭不等于 E907 不会在 Linux 前启动。

核心结论：

- `perf2_fastboot` 的 camera 快起由四部分组成：BOOT0/SPL 在 Linux 前启动 E907 RTOS，E907 预热 sensor/ISP，Linux VIN 通过 delay-init 与 rpmsg/rpbuf 接续，initramfs 在正式 rootfs 前执行采集 demo。
- E907 RTOS 侧同时做 sensor 控制、VIN/CSI/MIPI/ISP/VIPP pipeline 初始化、ISP server/3A 预热、参数保存，并通过 rpmsg/rpbuf 与 Linux 建立控制面。
- Linux 侧 VIN 驱动在 `CONFIG_VIN_INIT_MELIS`/`CONFIG_ISP_SERVER_MELIS` 下不会在 probe 阶段立即接管全部硬件初始化；`delay_init = <1>` 的节点先注册 notify，等 E907 `rpmsg_notify("isp0")`、`rpmsg_notify("vinc0")` 等通知后再挂 IRQ/标记设备可用。
- `rdinit` 在真正 rootfs 挂载前执行 `demo_video_in -n 40 -s0 1280x720 -f0 0`，这是应用层早于正式系统启动 camera 的关键；它依赖前面 E907 预热、Linux VIN 设备注册和 notify 链路已完成。

## 1. 板级配置入口

`perf2_fastboot` 关键配置：

- 板级工程：`device/config/chips/v821/configs/perf2_fastboot/BoardConfig.mk`
  - `LICHEE_CHIP := sun300iw1p1`
  - `LICHEE_ARCH := riscv32`
  - `LICHEE_RTOS_PROJECT_NAME := v821_e907_perf2_fastboot`
  - `LICHEE_BOOT0_BIN_NAME := mmcfastboot`
  - `LICHEE_NO_RAMDISK_NEEDED := y`

- RTOS 配置：`rtos/lichee/rtos/projects/v821_e907/perf2_fastboot/defconfig`
  - `CONFIG_DRIVERS_VIN=y`
  - `CONFIG_ISP_NUMBER=1`
  - `CONFIG_VIN_WAIT_AMP_INIT=y`
  - `CONFIG_VIN_WAIT_AMP_INIT_SEM_TIMEOUT=3500`
  - `CONFIG_ISP_MEMRESERVE_ADDR=0x816a6000`
  - `CONFIG_ISP_MEMRESERVE_LEN=0x65a000`
  - `CONFIG_SENSOR_INIT_BEFORE_VIN` 未打开，所以 `vin_s_stream()` 会在 pipeline 末尾直接调用 sensor `s_stream`。
  - `CONFIG_VIDEO_SUNXI_VIN_SPECIAL` 未打开，所以 RTOS 的 special V4L2 风格接口不是本板主路径。

- Linux 配置：`device/config/chips/v821/configs/perf2_fastboot/linux-5.4-ansc/bsp_defconfig`
  - `CONFIG_ISP_SERVER_MELIS=y`
  - `CONFIG_VIN_INIT_MELIS=y`
  - `CONFIG_AW_RPBUF_CONTROLLER_SUNXI=y`

- initramfs 启动脚本源文件：`device/config/chips/v821/configs/perf2_fastboot/ramdisk/init`。bootargs 中入口写为 `rdinit=/rdinit`，因此运行时入口名以打包结果为准。
  - 先挂 `proc/sysfs/tmpfs/devtmpfs`
  - 第一个 camera 相关命令就是 `demo_video_in -n 40 -s0 1280x720 -f0 0`
  - 然后才通过 deferred device 放开 SPIF，并挂载 `/dev/mtdblock7` 上的 squashfs rootfs。

## 2. 内存与分区布局

Linux DTS 的 reserved-memory 明确了 AMP 和 camera 快起需要的共享/保留区：

```text
0x81000000 - 0x81380000  rv_ddr_reserved       E907/RTOS DDR
0x81380000 - 0x813C0000  rv_vdev0buffer        RPMsg virtio buffer
0x813C0000 - 0x813C2000  rv_vdev0vring0
0x813C2000 - 0x813C4000  rv_vdev0vring1
0x813C4000 - 0x81644000  e907_mem_fw           E907 固件加载区
0x81644000 - 0x81646000  e907_share_irq_table
0x81646000 - 0x816A6000  e907_rpbuf_reserved   RPBuf 共享内存，384 KiB
0x816A6000 - 0x81D00000  isp_dram_reserved     ISP/camera 保留区，0x65A000
0x82000000 - 0x83400000  size_pool             ION size pool
```

依据：`board.dts` reserved-memory 中 `rv_vdev0buffer`、`e907_mem_fw`、`e907_rpbuf_reserved`、`isp_dram_reserved`，以及 `rpbuf_controller0` 绑定 `e907_rproc` 和 `e907_rpbuf_reserved`。

Flash 分区里 camera 相关的两个点：

- `riscv0` 分区下载 `amp_rv0.fex`，即 E907 RTOS 固件。
- `isp_param` 分区存在于 `/dev/mtd8`，DTS 中 `isp_param@0` 指向 `/dev/mtd8`，并设置 `preload_addr = <0x81cee000>`。BOOT0/内核/RTOS 都围绕这个地址交换 sensor/ISP 参数。

## 3. BOOT0/SPL 如何在 Linux 前启动 E907

本节回答两个问题：

- `perf2_fastboot` 是否由 SPL 直接引导 E907：是。
- `device/config/chips/v821/configs` 下所有非 fastboot 配置是否也都是 SPL 直接引导 E907：不能一概而论。显式选择 `mmcpmc/spinorpmc/mmcpmcver/spinorpmcver` 的配置会通过 SPL 路径启动 E907；仅在 U-Boot 环境中定义 `boot_riscv=bootrv ...` 的配置，如果默认 `bootcmd` 未执行 `boot_riscv`，则不能据此判定为 SPL 直接启动。若后续 quick_config 或手工环境把 `boot_riscv` 加入 `bootcmd`，那是 U-Boot `bootrv` 路径，不是 SPL 路径。

### 3.1 SPL 公共条件

V821 的 SPL 公共配置 `brandy/brandy-2.0/spl/board/sun300iw1p1/common.mk` 打开了：

```make
CFG_RISCV_E907=y
CFG_DEFAULT_BOOT_RTOS=y
```

这两个宏提供了 SPL 启动 E907 的公共能力：

- `CFG_RISCV_E907` 使 `boot_riscv()` 最终调用 `boot_e907()`。
- `CFG_DEFAULT_BOOT_RTOS` 使非 early 路径在 `load_and_run_fastboot()` 中尝试从 `riscv0` 分区加载 RTOS 固件。

`boot_e907()` 的实际动作在 `brandy/brandy-2.0/spl/board/sun300iw1p1/board.c`：

```text
sunxi_e907_clock_reset()
elf_get_entry_addr(base)
load_elf_image(base)
flush_dcache_all()
sunxi_e907_clock_init(run_addr)
```

也就是说，SPL 路径会解析 `amp_rv0.fex` ELF 入口，把 ELF 加载到目标地址，然后设置 E907 启动地址并释放复位。

### 3.2 SPL 标准路径：`load_and_run_fastboot()`

BOOT0/NBOOT 主流程在 `brandy/brandy-2.0/spl/nboot/main/boot0_main.c` 中：

```text
flash_init()
sunxi_board_late_init()
load_package()
load_image()
update_uboot_info()
load_and_run_fastboot()
jump OpenSBI / kernel path
```

`load_and_run_fastboot()` 在 `brandy/brandy-2.0/spl/common/board_helper.c` 中。只要不是 `CFG_SUNXI_PMBOOT`，并且没有启用 `CFG_EARLY_BOOT_RISCV`，它会在 `CFG_DEFAULT_BOOT_RTOS` 下执行：

```text
load_rtos_partition("riscv0", CONFIG_RTOS_LOAD_ADDR)
cpus_rtos_base = CONFIG_RTOS_LOAD_ADDR
boot_riscv(cpus_rtos_base, working_fdt)
```

`load_rtos_partition()` 通过 GPT 查找 `riscv0` 分区并调用 `spl_flash_read()` 读取固件；`boot_riscv()` 再根据 `CFG_RISCV_E907` 调到 `boot_e907()`。这条路径发生在 SPL 跳转 OpenSBI/Linux 前。

以 `perf2_fastboot/BoardConfig.mk` 为例：

```make
LICHEE_BOOT0_BIN_NAME := mmcfastboot
```

`brandy/brandy-2.0/spl/board/sun300iw1p1/mmcfastboot.mk` 中：

```make
CFG_BOOT0_LOAD_KERNEL=y
CFG_BOOT0_LOAD_FLASH=y
CFG_BOOT0_LOAD_ISPPARM=y
#CFG_EARLY_BOOT_RISCV=y
```

因此 `perf2_fastboot` 的 MMC 版本不是 early hook，而是标准 SPL fastboot 路径：`load_and_run_fastboot()` 先加载并启动 E907，再进入 `load_and_run_kernel()`/OpenSBI/Linux 路径。

### 3.3 SPL early 路径：`CFG_EARLY_BOOT_RISCV`

部分 fastboot BOOT0 镜像打开 `CFG_EARLY_BOOT_RISCV`。对应代码在 `brandy/brandy-2.0/spl/board/sun300iw1p1/board.c` 的 `sunxi_board_late_init()`：

```text
init_gpt()
fw_env_open()
early_fastboot_boot_riscv(NULL)
```

`early_fastboot_boot_riscv()` 位于 `brandy/brandy-2.0/spl/solution/solution_common/sunxi_bootimage.c`，它从环境变量 `riscv_partition` 取得分区名，默认对应 `riscv0`，再执行：

```text
get_part_info_by_name(riscv_name, &riscv_start, &riscv_size)
spl_flash_read(riscv_start, riscv_size, CONFIG_RTOS_LOAD_ADDR)
boot_riscv(CONFIG_RTOS_LOAD_ADDR, working_fdt)
```

这条路径比 `load_and_run_fastboot()` 更早启动 E907。因为 `load_and_run_fastboot()` 中有 `#ifndef CFG_EARLY_BOOT_RISCV` 保护，early 路径已启动后不会重复启动。

典型配置：

- `perf2_fastboot/BoardConfig_nor.mk`：`LICHEE_BOOT0_BIN_NAME := spinorfastboot`，`spinorfastboot.mk` 打开 `CFG_EARLY_BOOT_RISCV=y`。
- `perf2b_fastboot/BoardConfig_nor.mk`：`spinorfastbootpmc` 打开 `CFG_EARLY_BOOT_RISCV=y`。
- `aiglass/BoardConfig.mk` 与 `BoardConfig_nor.mk`：`mmcfastbootaiglass`、`spinorfastbootaiglass` 均打开 `CFG_EARLY_BOOT_RISCV=y`。

### 3.4 U-Boot `bootrv` 路径不是 SPL 路径

U-Boot 也支持启动 RISC-V/E907。命令实现位于 `brandy/brandy-2.0/u-boot-2018/cmd/sunxi_bootrv.c`：

```text
bootrv <tmp_addr> <tmp_size> <riscv_id> <partition...>
  -> do_sunxi_flash_read(partition, tmp_addr, tmp_size)
  -> sunxi_riscv_init(tmp_addr, 0, riscv_id)
```

`sunxi_riscv_init()` 在 U-Boot 驱动中复位 E907、加载 ELF、设置启动地址并释放复位。它和 SPL 的 `boot_e907()` 作用相近，但时机不同：U-Boot `bootrv` 发生在 U-Boot 阶段，晚于 SPL；如果目标是 camera fastboot，让 E907 与 Linux 启动并行，SPL 路径更早。

### 3.5 当前 `configs` 下的分类

下表只根据当前目录中的 `BoardConfig*.mk` 与 `env*.cfg` 判断，不推断构建系统外部覆盖项。

| 配置目录 | `LICHEE_BOOT0_BIN_NAME` | 当前判断 |
| --- | --- | --- |
| `perf2_fastboot` | `mmcfastboot` / `spinorfastboot` | SPL 直接启动 E907。MMC 走 `load_and_run_fastboot()`；NOR 走 `CFG_EARLY_BOOT_RISCV`。 |
| `perf2b_fastboot` | `mmcfastbootpmc` / `spinorfastbootpmc` | SPL 直接启动 E907。MMC 走 `load_and_run_fastboot()`；NOR 走 `CFG_EARLY_BOOT_RISCV`。 |
| `aiglass` | `mmcfastbootaiglass` / `spinorfastbootaiglass` | SPL 直接启动 E907，BOOT0 mk 打开 `CFG_EARLY_BOOT_RISCV`。 |
| `sc1745v` | `mmcfastboot` / `spinorfastboot` | 虽然目录名不含 fastboot，但 BOOT0 镜像是 fastboot 系列；SPL 直接启动 E907。 |
| `perf2b` | `mmcpmc` / `spinorpmc` | 非 fastboot 目录，但显式选择 NBOOT `pmc` 镜像；这些 mk 未定义 `CFG_SUNXI_PMBOOT`，会经过 `load_and_run_fastboot()`，因此 SPL 直接启动 E907。 |
| `ver1` | `mmcpmcver` / `spinorpmcver` | 同 `perf2b`，SPL 直接启动 E907。 |
| `perf2` / `default` / `aitoy` / `ipc` | 当前 `BoardConfig*.mk` 未显式设置 | 不能仅凭当前 `BoardConfig` 判定为 SPL 直接启动。其 env 定义了 `boot_riscv=bootrv ...`，但当前默认 `bootcmd` 是 `run setargs_nand boot_normal`，没有执行 `boot_riscv`。如果通过 quick_config 或手工环境改成 `run boot_riscv boot_normal`，那属于 U-Boot `bootrv` 路径。 |

因此，对“fastboot 快起和非 fastboot 快起，它们的 RISC-V 程序是否都是 SPL 直接引导”的确认结果是：

- fastboot camera 相关配置是 SPL 直接引导 E907，只是存在标准路径和 early 路径两种启动点。
- 非 fastboot 配置不是全部都能概括为同一种路径。`perf2b/ver1` 这类显式使用 `mmcpmc/spinorpmc` 的配置仍是 SPL 直接引导；`perf2/default/aitoy/ipc` 这类当前未显式指定 BOOT0 镜像且默认 `bootcmd` 不运行 `boot_riscv` 的配置，不能按当前文件认定为 SPL 直接引导，若运行 `bootrv` 则是 U-Boot 阶段引导。

## 4. E907 RTOS 主线程与 OpenAMP 线程

E907 工程入口在 `rtos/lichee/rtos/projects/v821_e907/perf2_fastboot/src/main.c`。

`cpu0_app_entry()` 中先创建 OpenAMP 初始化线程，然后主线程继续执行 `csi_init()`：

```text
cpu0_app_entry()
  -> hal_thread_create(openamp_init_thread)
  -> flash_load_data_async()        如果打开 CONFIG_WAIT_SPIF_CONTROLLER
  -> csi_init(0, NULL)
      -> 成功后 rpmsg_notify("twi0"/"isp0"/"scaler0"/"vinc0"...)
```

`openamp_init_thread()` 走：

```text
init_amp_framework()
  -> openamp_init()
init_amp_app()
  -> rpbuf_init()
  -> vin_continue_init()
  -> rpmsg_notify_init()
  -> rpmsg_ctrldev_create()
  -> multiple_console_init()
```

这说明 E907 上至少有两条并行线：

- camera 预热线：`csi_init()` 初始化 VIN/camera pipeline；
- AMP 通信线：`openamp_init()` 等 Linux 侧 virtio/rpmsg 就绪，随后 `rpbuf_init()` 建立 RPBuf 服务，再 `vin_continue_init()` 释放 `csi_init()` 中的等待点。

## 5. RTOS 中到底做 sensor 控制，还是只做 ISP server

源码显示：`perf2_fastboot` 的 E907 RTOS 同时做 sensor 控制和 ISP server，不只是 ISP server。

证据链在 `rtos/lichee/rtos-hal/hal/source/vin/vin.c`：

1. `csi_init()` 首次启动会初始化 VIN 配置、内存池、VIN top/CCU base、电源和 TWI：

```text
vin_g_config()
vin_g_status()
memheap_init(&isp_mempool, MEMRESERVE, MEMRESERVE_SIZE)
csic_top_set_base_addr()
csic_ccu_set_base_addr()
vin_md_set_power(PWR_ON)
sunxi_twi_init(0)
sunxi_twi_init(1)
```

2. 对每个启用的 `global_video[i]`：

```text
sensor_id = global_video[i].rear_sensor
vin_set_from_partition(isp_sel, &ir_en)
vin_s_input(i)
sensor_core->sensor_power(sensor_id, PWR_ON)
sensor_core->sensor_g_format(sensor_id, isp_sel, i)
vin_s_stream(i, PWR_ON)
vin_set_lightadc_from_partition(...)
```

3. `vin_s_input()` 会通过 sensor name 找 RTOS sensor 驱动函数，并执行 `vin_probe()`、`vin_pipeline_set_mbus_config()`、`csic_isp_input_select()`、`csic_vipp_input_select()`。

4. `vin_s_stream()` 的 enable 路径按硬件顺序拉起：

```text
TDM stream on          如果 tdm_rx_sel 有效
MIPI stream on
ISP stream on
Scaler/VIPP stream on
VIN DMA stream on
CSI stream on
sensor_core->s_stream(sensor_id, isp_sel, PWR_ON)
```

这最后一步是直接调用 sensor 驱动的 `s_stream`，而且 `CONFIG_SENSOR_INIT_BEFORE_VIN` 未打开，因此 sensor 不是 Linux 先控制，也不是仅由 ISP server 间接管理。

5. sensor 驱动也在 RTOS 源码中，例如 `rtos/lichee/rtos-hal/hal/source/vin/modules/sensor/gc1084_mipi.c`。当前 DTS 的 `sensor0_mname = "gc1084_mipi"`、`sensor0_twi_cci_id = <0>`、`sensor0_twi_addr = <0x6e>`、`sensor0_reset = <&pio PD 12 GPIO_ACTIVE_LOW>` 与 RTOS 中的 sensor 控制路径相匹配。

## 6. `csi_init()` 首次启动的真实行为

`csi_init()` 有两条路径：

### 6.1 RTC 标志已置位：reinit ISP server

函数开头创建 `vin_sem`。如果 RTC 标志表示已经初始化过一次：

```text
hal_sem_timedwait(vin_sem, CONFIG_VIN_WAIT_AMP_INIT_SEM_TIMEOUT)
isp_reinit(global_video[i].isp_sel)
return
```

这条路径用于 standby/二次初始化一类场景：必须先等 OpenAMP/RPBuf 就绪，再 `isp_reinit()`。

### 6.2 RTC 标志未置位：首次 fastboot 预热

首次启动不是直接 `isp_reinit()`，而是完整预热：

```text
vin_g_config()
vin_g_status()
memheap_init()
vin_md_set_power(PWR_ON)
sunxi_twi_init(0/1)
for each used video:
  vin_set_from_partition()
  vin_s_input()
  sensor_power(PWR_ON)
  sensor_g_format()
  vin_s_stream(PWR_ON)
  vin_set_lightadc_from_partition()
wait frame / wait AE done
for each used video:
  vin_s_stream(PWR_OFF)
  csic_isp_bridge_disable()
  vin_free()
wait vin_sem   // 等 openamp 线程 rpbuf_init + vin_continue_init
sunxi_isp_reset_server()
vin_set_to_partition()
optional sensor_deinit close
sunxi_twi_exit(0/1)
set RTC init flag
```

这里有两个重要修正：

- 首次 fastboot 预热会启动 sensor 和 pipeline，并等待帧或 AE 收敛；这证明 RTOS 做了真实 camera 硬件控制。
- 但随后代码明确执行 `vin_s_stream(PWR_OFF)`、`vin_free()`，所以不能笼统说“RTOS 一直保持 video DMA 出流，Linux 直接读实时流”。实际是否保留 YUV 预拍缓冲取决于 `get_yuv_en` 和 `isp_autoflash_config_s`，而实时 stream 主体会停掉，再由 Linux 侧应用触发 V4L2 流程。

## 7. `vin_continue_init()` 与 `rpbuf_init()` 的作用

`vin_continue_init()` 很短：

```text
while cnt < CONFIG_VIN_CONTINUE_INIT_TRY_TIMES:
  if vin_sem:
    hal_sem_post(vin_sem)
    return 0
  hal_msleep(1)
return -1
```

它不是 camera 初始化本体，只是给 `csi_init()` 中的 `vin_sem` 解锁。

在 `init_amp_app()` 里顺序是：

```text
rpbuf_init()
vin_continue_init()
rpmsg_notify_init()
rpmsg_ctrldev_create()
```

这个顺序决定了后续同步关系：先建立 RPBuf controller 服务，再释放 VIN 继续执行 `sunxi_isp_reset_server()`、`vin_set_to_partition()` 等需要与 Linux/RPBuf 协同的后半段。

注意当前源码中，`rpmsg_notify_init()` 在 `vin_continue_init()` 之后，而 `csi_init()` 成功后才调用 `rpmsg_notify("isp0")`/`rpmsg_notify("vinc0")`。所以更准确的时序是：

```text
E907 openamp 线程: openamp_init -> rpbuf_init -> vin_continue_init -> rpmsg_notify_init
E907 camera 主线:  csi_init 预热 -> 等 vin_sem -> 保存/复位 ISP server -> 返回
E907 camera 主线:  rpmsg_notify("isp0"/"scaler0"/"vinc0"...)
Linux VIN 驱动:   对 delay_init 节点注册 rpmsg_notify_add，收到 notify 后启用 IRQ/ready
```

## 8. Linux 侧 delay-init 如何接管

Linux 侧 camera 并非完全不操作硬件，而是在 Melis/RTOS 初始化模式下延迟关键 IRQ/硬件接入，避免与 E907 在早期阶段重复初始化同一硬件链路。

DTS 中：

```dts
tdm0 {
    rpmsg-ser-name = "43030000.e907_rproc";
    delay_init = <1>;
};

isp00 {
    rpbuf = <&rpbuf_controller0>;
    isp-region = <&isp_dram_reserved>;
    rpmsg-ser-name = "43030000.e907_rproc";
    delay_init = <1>;
};

scaler00/scaler10 {
    rpmsg-ser-name = "43030000.e907_rproc";
    delay_init = <1>;
};
```

VIN core、ISP、Scaler 驱动在 `CONFIG_VIN_INIT_MELIS` 下都会读 `delay_init`：

- `bsp/drivers/vin/vin-video/vin_core.c`：`delay_init == 0` 才立即 `request_irq()`；否则 `rpmsg_notify_add(rpmsg-ser-name, "vinc%d", vinc_irq_enable, vinc)`。
- `bsp/drivers/vin/vin-isp/sunxi_isp.c`：`delay_init == 0` 才立即 request ISP IRQ；否则 `rpmsg_notify_add(..., "isp%d", isp_enable_irq, isp)`。
- `bsp/drivers/vin/vin-vipp/sunxi_scaler.c`：同理注册 `scaler%d` notify。

Linux VIN 总入口 `bsp/drivers/vin/vin.c` 会：

```text
sunxi_mipi_platform_register()
sunxi_flash_platform_register()
sunxi_scaler_platform_register()
sunxi_isp_platform_register()
register_rpmsg_driver(&rpmsg_vin_client)   // CONFIG_ISP_SERVER_MELIS
sunxi_vin_core_register_driver()
platform_driver_register(&vin_driver)
```

`rpmsg_vin_client` 在 `bsp/drivers/vin/vin-rp/vin_rp.c` 中匹配 ISP rpmsg endpoint，保存到 `glb_isp[isp_id]->rpmsg`，用于后续 V4L2 控制转发。

## 9. RPBuf/RPMsg 在 camera 快起中的位置

Linux `isp_rpbuf_create()` 会从 DTS 的 `rpbuf_controller0` 上分配三类 buffer：

```text
isp0_load_rpbuf
isp0_save_rpbuf
isp0_ldci_rpbuf
```

这些 buffer 基于 `e907_rpbuf_reserved`，用于 Linux 与 E907 ISP server 之间传递 load/save/LDCI 等数据。`rpbuf_wait_controller_ready(isp->controller, 1000)` 说明 Linux 侧需要等 E907 侧 `rpbuf_init()` 后 controller ready。

RPMsg 主要承载控制命令：

- Linux V4L2 控制到 RTOS：`sunxi_isp_s_ctrl()` 中若 H3A 状态已启用，会发送 `VIN_SET_V4L2_IOCTL`。
- ISP frame sync/统计请求：`__isp_rpmsg_send_handle()` 发送 `VIN_SET_FRAME_SYNC`，随后请求 statistics。
- RTOS 到 Linux 的设备就绪通知：E907 `rpmsg_notify("isp0")`、`rpmsg_notify("vinc0")` 等触发 Linux delay-init 回调。

因此 RPBuf 是大块数据共享通道，RPMsg/notify 是控制与就绪信号通道。

## 10. 预拍 YUV 与 `isp_autoflash_config_s`

当前 RTOS defconfig 未打开 `CONFIG_NOT_FRAME_LOSS`，但 `get_yuv_en` 来自 ISP 参数区：

```text
vin_set_from_partition()
  -> isp_get_cfg[id].sensor_deinit
  -> isp_get_cfg[id].get_yuv_en
```

如果 `get_yuv_en` 为真，RTOS 的 `buffer_queue()` 会在 `isp_mempool` 中分配 buffer，并通过 `vin_detect_buffer_cfg()` 写 `isp_autoflash_config_s`：

```text
melisyuv_sign_id = 0xAA11AA11 / 0xBB11BB11
melisyuv_paddr   = vinc->buff[0].phy_addr
melisyuv_size    = vinc->buffer_size
```

Linux 侧有对应的 `VIDIOC_SET_PHY2VIR`/`vin_isp_memremap()` 路径，会从 `VIN_SENSOR0_RESERVE_ADDR + VIN_RESERVE_SIZE` 读 `isp_autoflash_config_s`，检查 `melisyuv_sign_id`，再把 `melisyuv_paddr` 映射给用户态。

这个机制解释了“fastboot 预拍 YUV”可能如何被用户态拿到。但就当前源码而言，它是一个条件路径：必须 `get_yuv_en` 为真，且用户态程序调用对应私有 ioctl。`rdinit` 中的 `demo_video_in` 是否走这条私有 ioctl，需要 demo 源码或运行日志确认；当前 SDK 能确认的是 demo 被放在 initramfs 里最早执行。

## 11. `rdinit` 为什么能早跑 `demo_video_in`

`board.dts` bootargs 中有：

```text
root=/dev/mtdblock7 rootwait init=/files/init rdinit=/rdinit
linux,initrd-start = <0x83c00000>
linux,initrd-end   = <0x84000000>
```

initramfs 源脚本 `ramdisk/init` 的顺序是：

```sh
mount proc/sysfs/tmpfs/devtmpfs
exec < /dev/console > /dev/console 2>&1
demo_video_in -n 40 -s0 1280x720 -f0 0
...
echo 44f00000.spif > /proc/sys/kernel/deferred_device
mount -t squashfs /dev/mtdblock7 /mnt
switch_root /mnt /files/init
```

也就是说 camera demo 跑在正式 rootfs 之前。此时能成功的前提是：

- E907 已在 Linux 前完成 sensor/ISP 预热并保存必要参数；
- Linux VIN/V4L2 设备节点已通过平台驱动注册出来；
- `delay_init` 节点已经通过 E907 notify 启用 IRQ 或标记 ready；
- RPMsg/RPBuf 通道足够早建立，ISP server 控制面可用。

快起价值不在于省略所有 camera 初始化，而在于把最耗时、最不适合等到用户空间再执行的 sensor/ISP 预热提前到 Linux 启动并行阶段，并把 demo 放进 initramfs，使采集优先于正式 rootfs 挂载执行。

## 12. 完整时序图

```text
BROM
  |
  v
BOOT0 / mmcfastboot
  |-- init DRAM / flash
  |-- load_package / load_image
  |-- load_and_run_fastboot()       // perf2_fastboot MMC 标准路径
  |     |-- load_rtos_partition("riscv0", CONFIG_RTOS_LOAD_ADDR)
  |     `-- boot_riscv() -> boot_e907()
  |
  `-- jump OpenSBI / Linux boot path

E907 RTOS
  |-- cpu0_app_entry()
  |-- start openamp_init_thread()
  |     |-- openamp_init()
  |     |-- rpbuf_init()
  |     |-- vin_continue_init()
  |     `-- rpmsg_notify_init()
  |
  `-- csi_init()
        |-- read sensor/ISP config from preload/isp_param area
        |-- init VIN top/CCU/power/TWI
        |-- sensor_power(PWR_ON)
        |-- sensor_g_format()
        |-- TDM/MIPI/ISP/VIPP/VIN/CSI stream on
        |-- sensor s_stream(PWR_ON)
        |-- wait frame / wait AE done
        |-- stream off + vin_free
        |-- wait vin_sem from openamp thread
        |-- reset/save ISP server state
        |-- optional sensor_deinit
        |-- set RTC init flag
        `-- rpmsg_notify("isp0"/"scaler0"/"vinc0"...)

Linux kernel
  |-- remoteproc/rpmsg/rpbuf framework
  |-- VIN init
  |     |-- platform register mipi/scaler/isp/vin
  |     |-- register rpmsg_vin_client
  |     |-- delay_init nodes register rpmsg_notify_add()
  |     `-- receive E907 notify -> request IRQ / device ready
  |
  `-- initramfs /rdinit
        |-- mount proc/sysfs/tmpfs/devtmpfs
        |-- demo_video_in -n 40 -s0 1280x720 -f0 0
        |-- release deferred spif
        |-- mount rootfs
        `-- switch_root /files/init
```

## 13. 建议的调试观察点

串口/内核日志中可以重点找：

- BOOT0: `load_rtos_partition`、`boot_riscv`
- E907: `CSI start!`、`video0 First Frame!`、`second Frame`、`csi init success!`
- E907: `vin wait rpbuf init timeout` 是否出现
- Linux: `isp0 rpmsg probe!`
- Linux: `rpmsg_notify_add` 对 `isp0`、`vinc0`、`scaler0`
- Linux: `vin init end`
- initramfs: `/rdinit` 中 `demo_video_in` 的输出
- SPIF: `deferred_device` 中 `44f00000.spif` 是否在 demo 后释放

如果要确认是否走预拍 YUV 路径，建议抓 `demo_video_in` 的 ioctl 序列，重点看是否调用 `VIDIOC_SET_PHY2VIR`，以及 `isp_autoflash_config_s.melisyuv_sign_id` 是否为 `0xAA11AA11`。
