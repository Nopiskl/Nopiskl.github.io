# RV1106 普通启动与 FASTBOOT 分区源码分析

## 1. 文档目的

这份文档把当前 SDK 里两种典型启动方式的分区差异、分区内容和打包链路放到一起说明：

- 普通启动：`BoardConfig-EMMC-Buildroot-RV1106_Luckfox_Pico_Ultra-IPC.mk`
- FASTBOOT/ThunderBoot：`BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk`

分析目标不是只看配置字符串，而是结合实际源码回答 3 个问题：

1. 两种启动方式的分区为什么不一样。
2. 每个分区里到底装了什么。
3. 这些内容是在哪段源码里被生成、打包和使用的。

## 2. 对比对象

### 2.1 普通启动配置

- 分区定义：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Buildroot-RV1106_Luckfox_Pico_Ultra-IPC.mk:38`
- 文件系统定义：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Buildroot-RV1106_Luckfox_Pico_Ultra-IPC.mk:49`
- 根文件系统类型：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Buildroot-RV1106_Luckfox_Pico_Ultra-IPC.mk:62`
- 应用安装到 OEM 分区：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Buildroot-RV1106_Luckfox_Pico_Ultra-IPC.mk:104`

### 2.2 FASTBOOT 配置

- 分区定义：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk:39`
- 文件系统定义：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk:50`
- 根文件系统类型：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk:63`
- 启用 ThunderBoot 内核配置：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk:82`
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk:90`
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk:93`
- 不再单独打 OEM 分区：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk:108`
- 启用 FASTBOOT：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk:132`
- 叠加 fastboot overlay：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk:135`

## 3. 先看结论

普通启动和 FASTBOOT 的根本区别，不在于分区表字符长短，而在于根文件系统放置位置完全不同：

- 普通启动把系统根文件系统放到独立 `rootfs` 分区中，`boot` 主要只承载内核启动镜像。
- FASTBOOT 把只读根文件系统做成 `erofs`，作为 ramdisk 一起打进 `boot.img`，运行时从 `/dev/rd0` 启动。

因此 FASTBOOT 天然会出现下面这些现象：

- `rootfs` 分区消失。
- `oem` 分区消失。
- `boot` 分区变大。
- 新增 `meta` 分区。
- `userdata` 成为主要的持久化可写分区。

## 4. 配置层直接差异

### 4.1 分区表

| 模式 | 分区表 |
| --- | --- |
| 普通启动 | `32K(env),512K@32K(idblock),256K(uboot),32M(boot),512M(oem),256M(userdata),6G(rootfs)` |
| FASTBOOT | `32K(env),256K@32K(idblock),256K(uboot),384K(meta),36M(boot),3G(userdata)` |

来源：

- 普通启动：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Buildroot-RV1106_Luckfox_Pico_Ultra-IPC.mk:38`
- FASTBOOT：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk:39`

### 4.2 文件系统定义

| 模式 | 文件系统定义 |
| --- | --- |
| 普通启动 | `rootfs@IGNORE@ext4,userdata@/userdata@ext4,oem@/oem@ext4` |
| FASTBOOT | `boot@IGNORE@erofs,userdata@/userdata@ext4` |

来源：

- 普通启动：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Buildroot-RV1106_Luckfox_Pico_Ultra-IPC.mk:49`
- FASTBOOT：
  `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk:50`

这里最关键的是 FASTBOOT 把 `boot` 标成了 `erofs`，而不是定义一个 `rootfs@ext4`。这不是写法差异，而是在告诉打包系统：

- 当前根文件系统不再对应一个独立块分区。
- 根文件系统要被作为 `boot.img` 内部的只读镜像来处理。

## 5. 构建系统如何把配置变成最终分区

### 5.1 `RK_PARTITION_CMD_IN_ENV` 会被写进 `env.img`

`project/build.sh` 里的 `parse_partition_env()` 和 `parse_partition_file()` 会把 `RK_PARTITION_CMD_IN_ENV` 解析为：

- `GLOBAL_PARTITIONS`
- `RK_PARTITION_ARGS`
- `SYS_BOOTARGS`

对应源码：

- `SDK/luckfox-pico/project/build.sh:1541`
- `SDK/luckfox-pico/project/build.sh:1698`
- `SDK/luckfox-pico/project/build.sh:1740`
- `SDK/luckfox-pico/project/build.sh:1750`

随后 `build_env()` 用 `mkenvimage` 生成 `env.img`：

- `SDK/luckfox-pico/project/build.sh:761`
- `SDK/luckfox-pico/project/build.sh:775`
- `SDK/luckfox-pico/project/build.sh:778`

`env.img` 里至少会包含：

- `blkdevparts=...`
- `sys_bootargs=...`
- `sd_parts=...`

### 5.2 `update.img` 最终带哪些分区，取决于 `env.img`

打包工具 `mk-update_pack.sh` 不是直接读 BoardConfig，而是先从 `env.img` 里反解分区名，再生成 `package-file`：

- 解析分区名：
  `SDK/luckfox-pico/tools/linux/Linux_Pack_Firmware/mk-update_pack.sh:124`
- 生成 `package-file`：
  `SDK/luckfox-pico/tools/linux/Linux_Pack_Firmware/mk-update_pack.sh:175`

这意味着：

- 普通启动配置里有 `rootfs/oem`，最终 `update.img` 也会带上它们。
- FASTBOOT 配置里没有 `rootfs/oem`，最终 `update.img` 也不会再把它们当独立分区处理。

## 6. 普通启动的启动镜像与分区内容

## 6.1 `boot` 分区内容

普通启动下，`build_kernel()` 不会把 ramdisk 输出到 fastboot 目录；内核构建完成后，`sysdrv/Makefile` 直接把生成好的 `boot.img` 复制到镜像输出目录：

- `SDK/luckfox-pico/project/build.sh:843`
- `SDK/luckfox-pico/sysdrv/Makefile:497`
- `SDK/luckfox-pico/sysdrv/Makefile:498`
- `SDK/luckfox-pico/sysdrv/Makefile:499`

普通启动用的 `boot.its` 只包含 3 个主体：

- `fdt`
- `kernel`
- `resource`

源码：

- `SDK/luckfox-pico/sysdrv/source/kernel/boot.its:7`

也就是说，普通启动的 `boot.img` 主要内容是：

1. 内核镜像
2. 设备树
3. `resource.img`

其中 `resource.img` 由下面几部分打包而成：

- DTB
- logo
- logo_kernel

源码：

- `SDK/luckfox-pico/sysdrv/source/kernel/scripts/mkimg:245`

所以普通启动的 `boot` 分区并不承载完整 rootfs。

## 6.2 `rootfs` 分区内容

普通启动的根文件系统来自 sysdrv 生成的 rootfs tar 包，再叠加项目资源：

- `app/root`
- `media/root`
- `external`
- 自动生成的 `sdkinfo`
- 自动生成的 `S20linkmount`

源码：

- `SDK/luckfox-pico/project/build.sh:1501`
- `SDK/luckfox-pico/project/build.sh:1510`
- `SDK/luckfox-pico/project/build.sh:1518`
- `SDK/luckfox-pico/project/build.sh:1520`
- `SDK/luckfox-pico/project/build.sh:1530`

普通启动最终会调用：

- `build_mkimg $GLOBAL_ROOT_FILESYSTEM_NAME $RK_PROJECT_PACKAGE_ROOTFS_DIR`

对应源码：

- `SDK/luckfox-pico/project/build.sh:2539`
- `SDK/luckfox-pico/project/build.sh:2540`

因为普通配置里 `rootfs@IGNORE@ext4`，所以最终 `rootfs.img` 是独立的 ext4 根文件系统镜像。

## 6.3 `oem` 分区内容

普通启动下 `RK_BUILD_APP_TO_OEM_PARTITION=y`，所以资源会单独打到 OEM 分区：

- `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Buildroot-RV1106_Luckfox_Pico_Ultra-IPC.mk:104`

OEM 内容来源是 `__PACKAGE_RESOURCES()`，包括：

- 内核 ko：`kernel_drv_ko`
- app 的 `bin/lib/share/usr/etc`
- media 的 `bin/lib/share/usr`
- IQ 文件
- AVS 标定文件/LUT

源码：

- `SDK/luckfox-pico/project/build.sh:1372`
- `SDK/luckfox-pico/project/build.sh:1382`
- `SDK/luckfox-pico/project/build.sh:1384`
- `SDK/luckfox-pico/project/build.sh:1389`
- `SDK/luckfox-pico/project/build.sh:1413`

普通启动在打固件时，OEM 最终会走独立打包：

- `SDK/luckfox-pico/project/build.sh:2516`
- `SDK/luckfox-pico/project/build.sh:2519`

运行时，rootfs 里的脚本会调用 `/oem/usr/bin/RkLunch.sh`：

- `SDK/luckfox-pico/project/build.sh:1463`
- `SDK/luckfox-pico/project/build.sh:1469`

## 6.4 `userdata` 分区内容

普通启动的 `userdata` 不是空分区。`__PACKAGE_USERDATA()` 会从下面两个目录收集内容：

- `project/app/install_to_userdata`
- `media/install_to_userdata`

源码：

- `SDK/luckfox-pico/project/build.sh:1484`
- `SDK/luckfox-pico/project/build.sh:1486`
- `SDK/luckfox-pico/project/build.sh:1490`
- `SDK/luckfox-pico/project/build.sh:1494`

然后生成独立 `userdata.img`：

- `SDK/luckfox-pico/project/build.sh:2545`
- `SDK/luckfox-pico/project/build.sh:2547`
- `SDK/luckfox-pico/project/build.sh:2549`

## 7. FASTBOOT 的启动镜像与分区内容

## 7.1 FASTBOOT 的根文件系统并不在独立分区里

FASTBOOT DTS 直接把启动参数写成：

- `rootfstype=erofs`
- `root=/dev/rd0`

源码：

- `SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/boot/dts/rv1106g-luckfox-pico-ultra-fastboot.dts:16`
- `SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/boot/dts/rv1106g-luckfox-pico-ultra-fastboot.dts:17`

同时 ThunderBoot 相关内核能力是显式打开的：

- `CONFIG_EROFS_FS=y`
- `CONFIG_ROCKCHIP_RAMDISK=y`
- `CONFIG_ROCKCHIP_THUNDER_BOOT=y`
- `CONFIG_ROCKCHIP_THUNDER_BOOT_MMC=y`

源码：

- `SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/configs/luckfox_rv1106-tb.config:4`
- `SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/configs/luckfox_rv1106-tb.config:14`
- `SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/configs/luckfox_rv1106-tb.config:16`
- `SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/configs/luckfox_rv1106-tb.config:39`

## 7.2 FASTBOOT 的 `boot.img` 内容

FASTBOOT 用的是 ThunderBoot 专用 FIT：

- `SDK/luckfox-pico/project/scripts/rv1106-boot-tb.its:12`

这个 ITS 里有 4 个主体：

1. `fdt`
2. `kernel`
3. `ramdisk`
4. `resource`

最关键的是 `ramdisk`：

- `SDK/luckfox-pico/project/scripts/rv1106-boot-tb.its:40`
- `SDK/luckfox-pico/project/scripts/rv1106-boot-tb.its:46`
- `SDK/luckfox-pico/project/scripts/rv1106-boot-tb.its:48`

而 `build_mkimg()` 在 FASTBOOT 下会先把根文件系统做成 `rootfs_erofs.img`，再 gzip，最后作为 `ramdisk` 塞进 `boot.img`：

- `SDK/luckfox-pico/project/build.sh:2241`
- `SDK/luckfox-pico/project/build.sh:2252`
- `SDK/luckfox-pico/project/build.sh:2253`
- `SDK/luckfox-pico/project/build.sh:2277`
- `SDK/luckfox-pico/project/build.sh:2282`

因此 FASTBOOT 的 `boot` 分区实际内容是：

1. 压缩后的 kernel
2. DTB
3. `resource.img`
4. 压缩后的 `erofs rootfs`

这就是它和普通启动最核心的分区内容差异。

## 7.3 `meta` 分区内容

`meta` 分区只在 FASTBOOT 模式下构建：

- `SDK/luckfox-pico/project/build.sh:2499`
- `SDK/luckfox-pico/project/build.sh:2500`

`build_meta.sh` 会把这些内容组织进 `meta.img`：

- `sensor_init`
- `sensor_iq_bin`
- `ae_awb_table`
- `cmdline`
- 其他 `meta_param`

源码：

- `SDK/luckfox-pico/project/make_meta/build_meta.sh:292`
- `SDK/luckfox-pico/project/make_meta/build_meta.sh:303`
- `SDK/luckfox-pico/project/make_meta/build_meta.sh:304`

所以 `meta` 分区本质上不是文件系统分区，而是相机/ThunderBoot 早期启动参数分区。

## 7.4 FASTBOOT 下 `/oem` 不再是单独分区

FASTBOOT 配置把：

- `RK_BUILD_APP_TO_OEM_PARTITION=n`

源码：

- `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk:108`

于是打包时不再生成独立 `oem.img`，而是把 `RK_PROJECT_PACKAGE_OEM_DIR` 的内容直接拷进 rootfs 的 `/oem`：

- `SDK/luckfox-pico/project/build.sh:2520`
- `SDK/luckfox-pico/project/build.sh:2522`

也就是说：

- 普通启动：`/oem` 来自独立 OEM 分区。
- FASTBOOT：`/oem` 来自内存根文件系统中的目录。

## 7.5 FASTBOOT 下 `userdata` 的角色

FASTBOOT 模式下 `__PACKAGE_USERDATA()` 不会执行，最终通常只生成空的 `userdata.img`：

- `SDK/luckfox-pico/project/build.sh:2545`
- `SDK/luckfox-pico/project/build.sh:2549`

运行时 `rcS` 会：

1. 先从 `/oem/usr/ko` 加载 ext4 相关模块。
2. 再执行 `/etc/init.d/S20linkmount start` 去挂载 `userdata`。

源码：

- `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/luckfox-rv1106-tb-emmc-post.sh:36`
- `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/luckfox-rv1106-tb-emmc-post.sh:40`
- `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/luckfox-rv1106-tb-emmc-post.sh:43`

FASTBOOT 叠加的 `inittab` 和 `fstab` 也说明了这点：

- `fstab` 只挂载基础 pseudo fs，没有声明独立 `oem/rootfs` 块分区。
- `rcS` 才是拉起用户态服务和挂载 `userdata` 的关键脚本。

源码：

- `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/overlay/overlay-luckfox-fastboot/etc/inittab:17`
- `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/overlay/overlay-luckfox-fastboot/etc/inittab:20`
- `SDK/luckfox-pico/project/cfg/BoardConfig_IPC/overlay/overlay-luckfox-fastboot/etc/fstab:1`

## 8. FASTBOOT 根文件系统如何变成 `/dev/rd0`

## 8.1 DTS 里已经定义了 ThunderBoot 内存区

FASTBOOT DTS 里为 `ramdisk_r` 和 `ramdisk_c` 预留了内存：

- `SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/boot/dts/rv1106g-luckfox-pico-ultra-fastboot.dts:244`
- `SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/boot/dts/rv1106g-luckfox-pico-ultra-fastboot.dts:248`

同时引入了 `rv1106-thunder-boot-emmc.dtsi`，其中定义：

- `memory-region-src = <&ramdisk_c>`
- `memory-region-dst = <&ramdisk_r>`

源码：

- `SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/boot/dts/rv1106-thunder-boot-emmc.dtsi:19`
- `SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/boot/dts/rv1106-thunder-boot-emmc.dtsi:24`
- `SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/boot/dts/rv1106-thunder-boot-emmc.dtsi:25`

## 8.2 ThunderBoot MMC 驱动会把压缩 rootfs 解到目标内存

内核早期的 `rockchip_thunderboot_mmc.c` 会读取 `memory-region-src` 和 `memory-region-dst`，然后启动硬件解压：

- `SDK/luckfox-pico/sysdrv/source/kernel/drivers/soc/rockchip/rockchip_thunderboot_mmc.c:74`
- `SDK/luckfox-pico/sysdrv/source/kernel/drivers/soc/rockchip/rockchip_thunderboot_mmc.c:93`

## 8.3 `rockchip_ramdisk` 把目标内存注册成块设备 `rd0`

`rockchip_ramdisk.c` 会把 `memory-region = <&ramdisk_r>` 那块内存做成一个块设备：

- 设备名：`rd0`
- 容量：来自 `ramdisk_r` 大小
- 支持 DAX

源码：

- `SDK/luckfox-pico/sysdrv/source/kernel/drivers/soc/rockchip/rockchip_ramdisk.c:263`
- `SDK/luckfox-pico/sysdrv/source/kernel/drivers/soc/rockchip/rockchip_ramdisk.c:273`
- `SDK/luckfox-pico/sysdrv/source/kernel/drivers/soc/rockchip/rockchip_ramdisk.c:294`
- `SDK/luckfox-pico/sysdrv/source/kernel/drivers/soc/rockchip/rockchip_ramdisk.c:332`

所以 FASTBOOT 运行时的 `/dev/rd0`，本质上就是：

- `boot.img` 中压缩 `erofs rootfs`
- 经过 ThunderBoot 解压后
- 落到 `ramdisk_r`
- 再被注册成块设备

## 9. 启动链公共分区的内容

下面这些分区，两种模式都有，但内部来源也有差异。

### 9.1 `env`

内容：

- 分区表字符串
- `sys_bootargs`
- 其他环境变量

生成来源：

- `SDK/luckfox-pico/project/build.sh:761`
- `SDK/luckfox-pico/project/build.sh:775`
- `SDK/luckfox-pico/project/build.sh:778`

### 9.2 `idblock`

内容本质：

- TPL
- SPL

U-Boot 打包脚本明确是用 `TPL_BIN:SPL_BIN` 生成 `idblock.bin`：

- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/make.sh:508`
- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/make.sh:532`

对于 RV1106：

- 普通 ini 只有 `FlashData + FlashBoot`
  `SDK/luckfox-pico/sysdrv/source/uboot/rkbin/RKBOOT/RV1106MINIALL.ini:13`
- ThunderBoot ini 额外加入了 `Hpmcu`
  `SDK/luckfox-pico/sysdrv/source/uboot/rkbin/RKBOOT/RV1106MINIALL_EMMC_TB.ini:13`
  `SDK/luckfox-pico/sysdrv/source/uboot/rkbin/RKBOOT/RV1106MINIALL_EMMC_TB.ini:16`

因此从下载链路角度看，FASTBOOT 的 bootloader 产物会额外把 HPMCU 一起纳入 loader 组合。

### 9.3 `uboot`

`uboot.img` 由 U-Boot 构建系统生成并复制到镜像目录：

- `SDK/luckfox-pico/sysdrv/Makefile:440`
- `SDK/luckfox-pico/sysdrv/Makefile:444`

U-Boot 自己的 FIT 打包脚本对它的描述是：

- `FIT with uboot, trust...`

源码：

- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/scripts/fit-core.sh:555`
- `SDK/luckfox-pico/sysdrv/source/uboot/u-boot/scripts/fit-core.sh:590`

因此 `uboot` 分区关注点主要是：

- U-Boot 主体
- Trust/BL31 等引导阶段镜像

它不是根文件系统分区。

## 10. 分区差异总结表

| 分区 | 普通启动 | FASTBOOT |
| --- | --- | --- |
| `env` | 有，保存分区表和 `sys_bootargs` | 有，作用相同 |
| `idblock` | 有，TPL+SPL | 有，ThunderBoot loader 组合里额外考虑 HPMCU |
| `uboot` | 有，`uboot.img` | 有，`uboot.img` |
| `meta` | 无 | 有，保存相机/meta/cmdline 等早期参数 |
| `boot` | `kernel + dtb + resource.img` | `kernel + dtb + resource.img + erofs rootfs ramdisk` |
| `rootfs` | 有，独立 ext4 根文件系统 | 无，根文件系统已并入 `boot.img` |
| `oem` | 有，独立 OEM 分区 | 无，OEM 内容直接并入 rootfs 的 `/oem` |
| `userdata` | 有，通常预装部分数据 | 有，主要承担持久化写入 |

## 11. 最终结论

这两种模式的分区差异，归根到底来自“根文件系统放在哪里”：

- 普通启动把根文件系统放在存储介质上的 `rootfs` 分区。
- FASTBOOT 把根文件系统放进 `boot.img` 的 ramdisk，并在启动早期解压到内存，形成 `/dev/rd0`。

因此：

- 普通启动适合传统 Linux 存储布局，`rootfs/oem/userdata` 边界清晰。
- FASTBOOT 适合追求更快起机，代价是分区布局会转成 `boot + meta + userdata` 这种更“启动链导向”的结构。

如果后续要继续追：

1. 普通启动下 `rootfs/oem/userdata` 的实际挂载顺序。
2. FASTBOOT 下 `meta` 如何和 MCU/ISP 初始化联动。
3. `download.bin`、`idblock.img`、`uboot.img` 三者在烧录流程里的具体落盘位置。

可以在这份文档基础上继续展开。
