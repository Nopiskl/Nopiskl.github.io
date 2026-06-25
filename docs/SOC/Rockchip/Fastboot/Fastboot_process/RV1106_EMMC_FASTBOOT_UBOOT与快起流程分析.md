# RV1106 EMMC IPC_FASTBOOT 的 U-Boot 与快起流程源码分析

## 1. 分析范围

本文只分析当前这套配置：

- `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk`

目标是把下面两个问题用源码讲清楚：

1. 这套 `IPC_FASTBOOT` 配置到底有没有“用到 U-Boot”。
2. 如果官方资料说“快起不用 uboot”，那在源码层面到底是什么意思。

## 2. 先看结论

结论可以先压缩成 4 句话：

1. 这套配置**明确使用了 U-Boot 工程、U-Boot SPL、U-Boot 打包脚本和 U-Boot 镜像产物**。
2. 这套配置的**正常快起路径**不是传统的 `SPL -> U-Boot proper -> Kernel`，而是优先走 **`SPL -> Kernel`**。
3. `uboot.img` 分区依然存在，也会被构建和打包；但它更像是**回退路径/兼容路径的正式产物**，而不是正常快起必经阶段。
4. 所以“快起不用 uboot”更准确的翻译应该是：**正常快起不进入完整 U-Boot proper 阶段，但仍然使用 U-Boot SPL 和 U-Boot 打包体系。**

## 3. 配置层证据

当前 `BoardConfig` 直接表明这就是一套 eMMC ThunderBoot/FASTBOOT 配置：

- 启动介质为 eMMC：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk:25`
- U-Boot 片段配置为 `rk-emmc.config`：
  `...IPC_FASTBOOT.mk:28`
- 分区表里显式保留了 `idblock`、`uboot`、`meta`、`boot`：
  `...IPC_FASTBOOT.mk:39`
- `boot` 分区文件系统被定义成 `erofs`，而不是独立 `rootfs` 分区：
  `...IPC_FASTBOOT.mk:50`
- 启用了 FASTBOOT：
  `...IPC_FASTBOOT.mk:132`
- 指定了 U-Boot defconfig：
  `...IPC_FASTBOOT.mk:82`
- 指定了 MCU 参与 ThunderBoot：
  `...IPC_FASTBOOT.mk:87`

当前分区定义是：

```text
32K(env),256K@32K(idblock),256K(uboot),384K(meta),36M(boot),3G(userdata)
```

从这个分区表本身就能先看到 3 个明显特征：

- `idblock` 还在，说明 BootROM 后面仍有 loader 级镜像。
- `uboot` 还在，说明工程没有把 U-Boot 产物彻底删掉。
- `boot` 变大且没有独立 `rootfs`，说明根文件系统会被打包进 `boot.img`。

## 4. U-Boot defconfig 直接说明了“谁在快起”

当前配置使用的 U-Boot defconfig 是：

- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/configs/luckfox_rv1106_uboot_emmc_tb_defconfig`

其中最关键的几项配置是：

- `CONFIG_LOADER_INI="RV1106MINIALL_EMMC_TB.ini"`
  `...luckfox_rv1106_uboot_emmc_tb_defconfig:15`
- `CONFIG_TRUST_INI="RV1106TOS_TB.ini"`
  `...luckfox_rv1106_uboot_emmc_tb_defconfig:16`
- `CONFIG_SPL_LOAD_FIT=y`
  `...luckfox_rv1106_uboot_emmc_tb_defconfig:29`
- `CONFIG_SPL_KERNEL_BOOT=y`
  `...luckfox_rv1106_uboot_emmc_tb_defconfig:47`
- `CONFIG_SPL_BLK_READ_PREPARE=y`
  `...luckfox_rv1106_uboot_emmc_tb_defconfig:83`
- `CONFIG_SPL_MISC_DECOMPRESS=y`
  `...luckfox_rv1106_uboot_emmc_tb_defconfig:94`
- `CONFIG_SPL_ROCKCHIP_HW_DECOMPRESS=y`
  `...luckfox_rv1106_uboot_emmc_tb_defconfig:95`

这些开关组合起来，含义已经非常明确：

- 这套系统不是“绕开 U-Boot”，而是**把快起能力放进了 U-Boot SPL**。
- `SPL` 要负责读取 FIT、预加载 ramdisk、做硬件解压，并直接启动内核。

U-Boot 自己的 Kconfig 也写得很直白：

- `CONFIG_SPL_KERNEL_BOOT` 的帮助文本就是 `Enable boot kernel in SPL`
  `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/common/spl/Kconfig:931`

`include/spl.h` 也明确说明了 `spl_start_uboot()` 的语义：

- 返回 `0`：SPL 启动 kernel
- 返回 `1`：SPL 启动 U-Boot

对应源码：

- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/include/spl.h:131`

所以从定义上讲，官方文档里“快起不用 uboot”的本意，本来就是：

- **不进入完整 U-Boot proper**
- **由 SPL 直接启动内核**

## 5. 构建系统仍然明确在“构建 U-Boot”

项目构建脚本没有把 U-Boot 从流程里拿掉。

### 5.1 `build.sh` 仍然会构建 U-Boot

`project/build.sh` 里的 `build_uboot()` 会：

1. 根据启动介质选择 `RKBOOT` ini
2. 在 FASTBOOT 模式下先编 MCU
3. 把 MCU 镜像路径覆盖进 loader ini
4. 再执行 `make uboot`

对应源码：

- `SDK/luckfox-pico/project/build.sh:692`
- `SDK/luckfox-pico/project/build.sh:706`
- `SDK/luckfox-pico/project/build.sh:710`
- `SDK/luckfox-pico/project/build.sh:729`
- `SDK/luckfox-pico/project/build.sh:737`

### 5.2 `sysdrv/Makefile` 仍然把 `uboot.img` 当正式产物输出

`sysdrv/Makefile` 中：

- `UBOOT_COMPILE_MAKE := $(UBOOT_DIR)/make.sh`
  `SDK/luckfox-pico/sysdrv/Makefile:264`
- 传给 `make.sh` 的参数是 `--spl-new`，不是 `--no-uboot`
  `SDK/luckfox-pico/sysdrv/Makefile:266`
- 真正执行时会调用：
  `pushd $(UBOOT_DIR);$(UBOOT_COMPILE_MAKE) $(UBOOT_COMPILE_MAKE_OPTS) ...`
  `SDK/luckfox-pico/sysdrv/Makefile:443`
- 之后把 `uboot.img` 复制到输出目录：
  `SDK/luckfox-pico/sysdrv/Makefile:444`

这说明两件事：

1. 当前工程**并没有停止生成 `uboot.img`**。
2. 从项目构建链上看，也**没有证据表明打包时显式用了 `--no-uboot` 去彻底剔除 U-Boot proper**。

换句话说，工程层面仍然认可：

- `idblock.img`
- `uboot.img`
- `boot.img`

都是正式交付镜像。

## 6. `idblock` 里是什么，`uboot` 里又是什么

### 6.1 `idblock` 对应的是前级 loader

当前 eMMC ThunderBoot 的 loader ini 是：

- `SDK/luckfox-pico/sysdrv/source/uboot/rkbin/RKBOOT/RV1106MINIALL_EMMC_TB.ini`

这个文件里最关键的是：

- `FlashData=...rv1106_ddr_924MHz_tb_v1.15.bin`
- `Hpmcu=...rv1106_hpmcu_tb_v1.01.bin`
- `FlashBoot=...rv1106_spl_emmc_tb_v1.00.bin`

对应源码：

- `RV1106MINIALL_EMMC_TB.ini:18`
- `RV1106MINIALL_EMMC_TB.ini:19`
- `RV1106MINIALL_EMMC_TB.ini:20`

所以 `idblock/loader` 这条链路至少包含：

- DDR 初始化代码
- HPMCU 固件
- SPL

这也是为什么快起方案里 MCU 能在很早阶段参与启动。

### 6.2 `uboot.img` 仍然是正式 FIT 打包产物

`fit.sh` 中只要 `ARG_INI_TRUST` 存在，就会：

- 生成 `uboot.itb`
- 再生成 `uboot.img`

对应源码：

- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/scripts/fit.sh:26`
- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/scripts/fit.sh:27`
- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/scripts/fit.sh:28`

这再次说明：

- `uboot.img` 不是“名义上保留但不生成”的空概念。
- 它是真正参与构建、打包、输出、烧写流程的。

但这仍然不能推出“正常快起一定会执行完整 U-Boot proper”。  
这要看运行时的 next-stage 选择逻辑。

## 7. 正常快起为什么会走 `SPL -> Kernel`

### 7.1 Rockchip SPL 的 next-stage 选择逻辑

`arch/arm/mach-rockchip/spl.c` 里 `spl_next_stage()` 的逻辑很关键：

- 按键进入下载模式时，进 `SPL_NEXT_STAGE_UBOOT`
- Ctrl+C 中断时，进 `SPL_NEXT_STAGE_UBOOT`
- 低电时，进 `SPL_NEXT_STAGE_UBOOT`
- Boot Mode 是 `BOOT_LOADER / BOOT_FASTBOOT / BOOT_CHARGING / BOOT_UMS / BOOT_DFU` 时，也进 `SPL_NEXT_STAGE_UBOOT`
- 其他正常情况，默认走 `SPL_NEXT_STAGE_KERNEL`

对应源码：

- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/arch/arm/mach-rockchip/spl.c:400`
- `.../spl.c:406`
- `.../spl.c:412`
- `.../spl.c:418`
- `.../spl.c:426`
- `.../spl.c:437`

这段源码基本就把“正常快起不跑完整 U-Boot”钉死了：

- **默认分支是 `KERNEL`**
- **`UBOOT` 是异常/人工介入/特定 boot mode 下的回退分支**

### 7.2 SPL 最终确实能直接跳 Linux

`common/spl/spl.c` 在处理加载结果时：

- 如果 `spl_image.os == IH_OS_U_BOOT`，跳 U-Boot
- 如果 `spl_image.os == IH_OS_LINUX` 并启用了 `CONFIG_SPL_KERNEL_BOOT`，就直接走 `boot_jump_linux()`

对应源码：

- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/common/spl/spl.c:590`
- `.../spl.c:618`
- `.../spl.c:624`

这说明“快起不用 uboot”不是一句文档口号，而是运行时真实分支。

## 8. `boot.img` 是怎么做出来的

当前 FASTBOOT 配置里：

- `RK_PARTITION_FS_TYPE_CFG=boot@IGNORE@erofs,userdata@/userdata@ext4`
  `...IPC_FASTBOOT.mk:50`

`project/build.sh` 的 `build_firmware()` 在 `RK_ENABLE_FASTBOOT=y` 时，不再去做独立 `rootfs.img`，而是直接：

- `build_mkimg boot $RK_PROJECT_PACKAGE_ROOTFS_DIR`

对应源码：

- `SDK/luckfox-pico/project/build.sh:2533`
- `SDK/luckfox-pico/project/build.sh:2537`

进入 `build_mkimg()` 的 `erofs` 分支后，会：

1. 把内核压成 `Image.gz`
2. 把根文件系统打成 `rootfs_erofs.img`
3. 再把它 gzip 成 `rootfs_erofs.img.gz`
4. 使用 `rv1106-boot-tb.its` 打成 `boot.img`

对应源码：

- `SDK/luckfox-pico/project/build.sh:2241`
- `SDK/luckfox-pico/project/build.sh:2248`
- `SDK/luckfox-pico/project/build.sh:2250`
- `SDK/luckfox-pico/project/build.sh:2252`
- `SDK/luckfox-pico/project/build.sh:2253`
- `SDK/luckfox-pico/project/build.sh:2277`

而 `rv1106-boot-tb.its` 里定义的内容就是：

- `fdt`
- `kernel`
- `ramdisk`
- `resource`

并且 `ramdisk` 带有：

- `preload = <1>;`
- `decomp-async;`

对应源码：

- `SDK/luckfox-pico/project/scripts/rv1106-boot-tb.its:12`
- `.../rv1106-boot-tb.its:25`
- `.../rv1106-boot-tb.its:40`
- `.../rv1106-boot-tb.its:46`
- `.../rv1106-boot-tb.its:49`
- `.../rv1106-boot-tb.its:56`

所以这套 `boot.img` 本质上是一个 ThunderBoot/FIT 容器，里面已经把：

- 内核
- 只读根文件系统
- 设备树
- resource

都打进去了，供 SPL 直接加载。

## 9. `meta` 分区为什么在快起里很重要

当前 FASTBOOT 分区里专门保留了 `meta` 分区：

- `...IPC_FASTBOOT.mk:39`

`project/build.sh` 在 FASTBOOT 模式下会主动构建 meta：

- `SDK/luckfox-pico/project/build.sh:2499`

U-Boot 侧 `rk_meta.c` 会：

1. 找到 `meta` 分区
2. 读取 meta header 和 IQ 数据
3. 必要时做解压
4. 把 `meta_flags` 置成 `META_READ_DONE_FLAG`
5. 调 `rk_meta_process()`

对应源码：

- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/arch/arm/mach-rockchip/rk_meta.c:127`
- `.../rk_meta.c:133`
- `.../rk_meta.c:150`
- `.../rk_meta.c:184`
- `.../rk_meta.c:186`

RV1106 SoC 侧的 `rk_meta_process()` 只是写一个寄存器去通知 MCU：

- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/arch/arm/mach-rockchip/rv1106/rv1106.c:568`

这说明这套 ThunderBoot 不只是“Linux 启动快”，还是：

- SPL 早起
- MCU 提前参与
- Meta/IQ 提前准备

共同组成的整套早启动链。

## 10. MCU 是在什么阶段被放飞的

`spl_fit.c` 在处理 FIT 的 `standalone` 镜像时，会调用：

- `spl_fit_standalone_release(desc, entry_point)`

对应源码：

- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/common/spl/spl_fit.c:655`
- `.../spl_fit.c:673`

RV1106 平台自己实现了这个函数：

- 当 `id == "mcu0"` 时：
  - 设置 MCU 非缓存区域
  - reset HPMCU
  - 写 boot 地址
  - release HPMCU

对应源码：

- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/arch/arm/mach-rockchip/rv1106/rv1106.c:548`
- `.../rv1106.c:550`
- `.../rv1106.c:552`
- `.../rv1106.c:555`
- `.../rv1106.c:557`
- `.../rv1106.c:559`

所以更完整的快起链是：

```text
BootROM
-> idblock / loader(DDR + HPMCU + SPL)
-> SPL 解析 FIT
-> SPL 释放 HPMCU standalone
-> SPL 读取/处理 meta
-> SPL 加载 boot.img 内的 kernel + ramdisk + fdt + resource
-> SPL 直接跳 Linux
```

## 11. `uboot` 分区在这套快起里到底扮演什么角色

可以把它理解成“**存在、构建、烧写，但默认不执行**”。

更精确一点说：

- **构建层面**：`uboot.img` 是正式产物。
- **分区层面**：`uboot` 分区被正式保留。
- **运行层面**：默认 next-stage 不是 U-Boot，而是 Kernel。
- **回退层面**：只要命中按键、串口中断、低电或特定 boot mode，SPL 仍然会转去 U-Boot。

因此，`uboot` 分区不是多余的，也不是假的；  
只是它在 ThunderBoot 场景里不再是“每次正常启动都必须经过的第二阶段”。

## 12. 为什么官方文档说“快起不用 uboot”

这句话最容易被误解。

结合上面的源码，更准确的表达应该是：

- **快起不用完整 U-Boot proper 作为常规启动第二阶段**
- **但快起仍然使用 U-Boot SPL、U-Boot FIT 打包、U-Boot loader/rkbin 体系**

如果把 “U-Boot” 拆成两个概念，就不会绕晕：

- `U-Boot SPL`
  这是快起真正的核心执行者之一。
- `U-Boot proper`
  这是正常快起路径里被默认绕开的那个阶段。

所以：

- 说“完全没用到 U-Boot”是不准确的。
- 说“正常快起不跑完整 U-Boot proper”才准确。

## 13. 最终回答

对于当前配置

- `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk`

可以给出最终结论：

1. **有用到 U-Boot。**
   具体体现在 U-Boot defconfig、U-Boot SPL、U-Boot FIT 打包、`uboot.img` 构建和 `uboot` 分区保留上。

2. **正常快起流程默认不会跑完整 U-Boot proper。**
   默认分支是 `SPL_NEXT_STAGE_KERNEL`，SPL 直接加载并启动 Linux。

3. **`uboot.img` 仍然是正式镜像，但主要承担回退/兼容/非正常快起分支的角色。**

4. **官方文档“快起不用 uboot”说的是“不走完整 U-Boot proper 启动路径”，而不是“工程里没有 U-Boot”。**

