# Radxa u-boot-aw2501 与当前官方 SDK Brandy/U-Boot 构建流程源码分析

本文对比两个工程：

- 当前工作区：`/home/alientek/A733/tina-aiot`
- Radxa 仓库：`https://github.com/radxa-pkg/u-boot-aw2501`

分析重点是 bootloader/brandy/U-Boot 构建，不展开内核、GPU、rootfs 的细节。

截至本文分析时，Radxa `u-boot-aw2501` 最新公开 release 为 `2018.07-17`，发布时间为 `2026-04-29`。其主工程通过 submodule 固定 U-Boot、device、tools、arisc、dramlib、spl-pub 等组件版本。当前工作区则是完整 Tina/Allwinner SDK，`brandy` 只是完整固件构建链中的 bootloader 阶段。

## 1. 一句话总览

官方 SDK 是完整固件流水线：

```text
./build.sh config
  -> 生成 .buildconfig

./build.sh 或 ./build.sh tina
  -> build_rtos
  -> build_dtbo
  -> build_arisc
  -> build_bootloader
  -> build_kernel
  -> build_rootfs

./build.sh pack
  -> 收集 boot0/u-boot/bl31/scp/kernel/rootfs/分区表/资源
  -> update_boot0/update_uboot/update_sboot/dragonsecboot
  -> 生成完整固件镜像
```

Radxa `u-boot-aw2501` 是 bootloader Debian 包工程：

```text
make deb
  -> debuild -b
  -> make build
  -> 构建 radxa-cubie-a5e/radxa-cubie-a7a/radxa-cubie-a7z
  -> 生成 out/<product>/*
  -> 打包进 /usr/lib/u-boot/<product>/
```

最大差别：官方 SDK 面向完整固件镜像，Radxa 工程面向可独立发布的 U-Boot/bootloader 包。

## 2. 工程结构差异

### 2.1 官方 SDK 的目录假设

当前官方 SDK 中，bootloader 相关目录集中在：

```text
brandy/
  brandy-2.0/
    build.sh -> tools/build.sh
    u-boot-2018/
    opensbi/
    tools/
  arisc/
  dramlib/

device/config/chips/a733/
  bin/
    boot0_sdcard_sun60iw2p1.bin
    boot0_ufs_sun60iw2p1.bin
    boot0_spinor_sun60iw2p1.bin
    bl31.bin
    scp.bin
    u-boot-sun60iw2p1.bin
  configs/<board>/
    sys_config.fex
    uboot-board.dts
    debian/BoardConfig.mk
    linux-5.15/BoardConfig.mk

build/
  mkcommon.sh
  mkcmd.sh
  pack
```

官方 SDK 依赖 `.buildconfig` 作为全局上下文。当前工作区 `.buildconfig` 里与 bootloader 直接相关的变量包括：

```text
LICHEE_PLATFORM=linux
LICHEE_LINUX_DEV=debian
LICHEE_IC=a733
LICHEE_BOARD=cubie_a7z
LICHEE_CHIP=sun60iw2p1
LICHEE_BRANDY_VER=2.0
LICHEE_BRANDY_DEFCONF=radxa-cubie-a7z_defconfig
LICHEE_BRANDY_BUILD_OPTION=uboot
LICHEE_BRANDY_DIR=/home/alientek/A733/tina-aiot/brandy/brandy-2.0
LICHEE_BRANDY_OUT_DIR=/home/alientek/A733/tina-aiot/device/config/chips/a733/bin
LICHEE_PLAT_OUT=/home/alientek/A733/tina-aiot/out/a733/cubie_a7z/debian
LICHEE_PACK_OUT_DIR=/home/alientek/A733/tina-aiot/out/a733/cubie_a7z/pack_out
```

也就是说，官方 SDK 的 U-Boot 构建和 pack 阶段都默认知道“当前芯片、板子、系统、输出目录、工具目录”在哪里。

### 2.2 Radxa 的目录重组

Radxa `u-boot-aw2501` 不保留完整 Tina SDK 目录，而是把 bootloader 需要的组件拆成 submodule：

```text
u-boot-aw2501/
  Makefile
  Makefile.extra
  .github/local/Makefile.local
  debian/
  src/             # radxa/u-boot, branch cubie-aiot-v1.4.6
  device-a733/     # radxa/allwinner-device, branch device-a733-v1.4.6
  device-a527/
  tools/
  arisc/
  dramlib/
  spl-pub/
  awbs/
  setup/
  out/
```

Radxa 的 `.gitmodules` 显示：

```text
src          -> https://github.com/radxa/u-boot.git
device-a733  -> https://github.com/radxa/allwinner-device.git
tools        -> https://gitlab.com/tina5.0_aiot/lichee/tools.git
arisc        -> https://gitlab.com/tina5.0_aiot/lichee/arisc.git
dramlib      -> https://gitlab.com/tina5.0_aiot/lichee/dramlib.git
spl-pub      -> https://gitlab.com/tina5.0_aiot/lichee/brandy-2.0/spl-pub.git
awbs         -> https://github.com/radxa/awbs.git
```

这个结构没有顶层 `build/mkcmd.sh`，没有 SDK 根目录 `.buildconfig`，也没有完整 `device/config/chips/...` 层级。所以 Radxa 的主要适配工作，就是把官方 SDK 的隐式全局环境拆成显式 Makefile 变量和依赖规则。

## 3. Radxa 为适配自身工程结构做了哪些修改

### 3.1 外层构建入口：用 Makefile.extra 替代 build.sh/mkcmd.sh

Radxa 顶层 `Makefile` 会包含：

```make
-include .github/local/Makefile.local
-include Makefile.extra
```

`Makefile.extra` 定义通用 U-Boot 调用器 `UMAKE`。其核心含义是：

```text
make -C src
  ARCH=<arch>
  CROSS_COMPILE=<toolchain>
  UBOOTVERSION=<debian-version>-boot-aw2501
```

源码参考：

- Radxa `Makefile.extra`: `https://github.com/radxa-pkg/u-boot-aw2501/blob/main/Makefile.extra`

官方 SDK 对应入口是：

- `build.sh -> build/top_build.sh -> build/mkcommon.sh`
- `build/mkcommon.sh` 根据命令选择 `build_bootloader`、`mk_pack` 等动作
- `build/mkcmd.sh` 的 `build_bootloader()` 再进入 `brandy/brandy-2.0/build.sh`

源码参考：

- `build/top_build.sh`
- `build/mkcommon.sh`
- `build/mkcmd.sh`
- `brandy/brandy-2.0/build.sh`

官方 SDK 的调用链是“命令解析 + .buildconfig + 自动推导”。Radxa 的调用链是“产品目标 + 显式依赖 + Debian 包装”。

### 3.2 用 CUSTOM_MAKE_DEFINITIONS 填补官方 SDK 的全局变量

Radxa `.github/local/Makefile.local` 开头定义：

```make
CROSS_COMPILE := $(CURDIR)/toolchains/.../arm-linux-gnueabi-
CUSTOM_MAKE_DEFINITIONS := DTS_PATH=arch/arm/dts \
        LICHEE_CHIP_CONFIG_DIR=/tmp \
        LICHEE_PLAT_OUT=/tmp \
        TARGETDIR=/tmp \
        EXTRA_CFLAGS=...
```

源码参考：

- Radxa `.github/local/Makefile.local`: `https://github.com/radxa-pkg/u-boot-aw2501/blob/main/.github/local/Makefile.local`

这几项的作用：

- `CROSS_COMPILE`：由 Radxa 外层工程统一控制工具链。
- `DTS_PATH`：显式告诉 U-Boot DTS 路径，避免依赖官方 SDK 的推导。
- `LICHEE_CHIP_CONFIG_DIR=/tmp`、`LICHEE_PLAT_OUT=/tmp`：让 U-Boot 原本的 SDK 复制逻辑有变量可用，但不污染真实 `device-*` 或 `out/<product>` 目录。
- `EXTRA_CFLAGS`：屏蔽较新 GCC 下 Allwinner/Radxa U-Boot 老代码常见告警。

官方 U-Boot Makefile 的 SDK 依赖可以从本地源码看到：

```make
buildconfig = ../../../.buildconfig
LICHEE_CHIP_CONFIG_DIR = 从 .buildconfig 读取
LICHEE_PLAT_OUT        = 从 .buildconfig 读取
```

源码位置：

- `brandy/brandy-2.0/u-boot-2018/Makefile:86`
- `brandy/brandy-2.0/u-boot-2018/Makefile:89`
- `brandy/brandy-2.0/u-boot-2018/Makefile:94`

U-Boot 构建结束后，官方 Makefile 会把 `u-boot-$(CONFIG_SYS_CONFIG_NAME).bin` 复制到：

```text
$(LICHEE_CHIP_CONFIG_DIR)/.../bin/
$(LICHEE_PLAT_OUT)/
```

源码位置：

- `brandy/brandy-2.0/u-boot-2018/Makefile:1116`
- `brandy/brandy-2.0/u-boot-2018/Makefile:1122`
- `brandy/brandy-2.0/u-boot-2018/Makefile:1123`

Radxa 把 `LICHEE_CHIP_CONFIG_DIR` 和 `LICHEE_PLAT_OUT` 设到 `/tmp`，说明它不想沿用官方 SDK 的“U-Boot 自己复制到 SDK 输出目录”的产物管理方式，而是由外层 `out/<product>/` 规则统一收口。

### 3.3 删除 U-Boot 内部强绑定工具链逻辑

Radxa Debian patch：

```text
debian/patches/u-boot/0001-fix-disable-Allwinner-cross-toolchain.patch
```

删除了 `src/Makefile` 里一段 Allwinner 风格的工具链逻辑，内容包括：

- 根据 `CONFIG_RISCV`/`CONFIG_ARM` 选择 in-tree toolchain。
- 如果工具链目录不存在，就从 `../tools/toolchain/*.tar.*` 解压。
- 直接覆盖 `CROSS_COMPILE` 和 `DTS_PATH`。

源码参考：

- `https://github.com/radxa-pkg/u-boot-aw2501/blob/main/debian/patches/u-boot/0001-fix-disable-Allwinner-cross-toolchain.patch`

这个 patch 的意义很大：它把工具链选择权从 `src/Makefile` 交还给外层 packaging Makefile。否则 Radxa 顶层指定的 `CROSS_COMPILE` 会被 U-Boot 内部 Makefile 再次覆盖，无法稳定复现 Debian 包构建环境。

官方 SDK 这边仍保留类似思路。`brandy/brandy-2.0/build.sh` 中：

```text
uboot_prepare_toolchain()
  -> 读取 .config 中 CONFIG_ARM/CONFIG_ARM64/CONFIG_RISCV
  -> parse_cross_compiler()
  -> 准备/解压工具链
  -> 设置 TARGET_CROSS_COMPILE
```

源码位置：

- `brandy/brandy-2.0/build.sh:69`
- `brandy/brandy-2.0/build.sh:129`
- `brandy/brandy-2.0/build.sh:167`
- `brandy/brandy-2.0/build.sh:209`

### 3.4 把官方 SDK 的隐式板级选择改成产品目标

官方 SDK 的板级选择来自 `BoardConfig.mk` 和 `.buildconfig`：

```text
LICHEE_IC=a733
LICHEE_BOARD=cubie_a7z
LICHEE_BRANDY_DEFCONF=radxa-cubie-a7z_defconfig
LICHEE_BRANDY_BUILD_OPTION=uboot
```

然后 `build_bootloader()` 拼出：

```text
brandy/brandy-2.0/build.sh -p radxa-cubie-a7z -b a733 -o uboot
```

源码位置：

- `build/mkcmd.sh:2167`
- `build/mkcmd.sh:2287`
- `build/mkcmd.sh:2295`

Radxa 则把产品目标直接写到 Makefile 中：

```text
UBOOT_PRODUCTS = radxa-cubie-a5e radxa-cubie-a7a radxa-cubie-a7z
```

每个产品再拆成：

```text
<product>_defconfig
<product>_build
<product>_pack
<product>
```

以 `radxa-cubie-a7z` 为例：

```text
radxa-cubie-a7z_defconfig
  -> make -C src radxa-cubie-a7z_defconfig

radxa-cubie-a7z_build
  -> make -C src LICHEE_BOARD_CONFIG_DIR=device-a733/configs/cubie_a7z all

radxa-cubie-a7z_pack
  -> radxa-cubie-a7z_build
  -> src/boot_package-radxa-cubie-a7z.fex

radxa-cubie-a7z
  -> boot_package
  -> boot0_sdcard
  -> boot0_ufs
  -> boot0_spinor
  -> sys_partition_nor
  -> copy setup scripts
```

源码参考：

- Radxa `.github/local/Makefile.local`

这就是两者最根本的构建模型差异：

```text
官方 SDK:
  选板 -> 写 .buildconfig -> 脚本推导要构建什么

Radxa:
  目标名就是产品 -> Makefile 显式声明所有依赖
```

### 3.5 用 awbs/临时环境适配 update_chip 等 Allwinner 工具

官方 SDK 的 `update_chip`、`update_boot0`、`dragonsecboot` 等工具通常在完整 SDK 环境里运行，能拿到：

```text
LICHEE_CHIP_CONFIG_DIR
LICHEE_TOOLS_DIR
LICHEE_CHIP
LICHEE_IC
LICHEE_OUT_DIR
```

Radxa 没有完整 SDK，于是在 Makefile 规则中临时构造环境。例如 A733 boot0 规则会先链接 `monitor.fex`，再调用 `awbs/awbs` 生成所需输出目录变量，最后运行 `update_chip`。

其效果可以概括成：

```text
cp device-a733/bin/boot0_*.bin out/<product>/boot0_*.bin
update_boot0 out/<product>/boot0_*.bin sys_config.bin <storage>
临时提供 LICHEE_* 环境
update_chip out/<product>/boot0_*.bin
```

源码参考：

- Radxa `.github/local/Makefile.local`

这说明 Radxa 并没有重写 Allwinner pack 工具，而是给这些工具补足最低限度的 SDK 上下文。

## 4. Radxa 具体产物是怎么编译出来的

### 4.1 顶层 build 到产品目标

Radxa `Makefile.extra` 的通用 build 目标：

```text
build:
  -> out/
  -> src/
  -> pre_build
  -> $(UBOOT_PRODUCTS)
  -> post_build
```

`UBOOT_PRODUCTS` 在 `.github/local/Makefile.local` 中定义为：

```text
radxa-cubie-a5e
radxa-cubie-a7a
radxa-cubie-a7z
```

所以 `make build` 会依次生成这些产品目录。

### 4.2 U-Boot proper 的生成

以 A7Z 为例：

```text
radxa-cubie-a7z_build
  -> radxa-cubie-a7z_defconfig
  -> clean_sunxi_challenge
  -> make -C src LICHEE_BOARD_CONFIG_DIR=$(CURDIR)/device-a733/configs/cubie_a7z all
```

U-Boot proper 输出是：

```text
src/u-boot-sun60iw2p1.bin
```

官方 SDK 中，同类产物则由 `brandy/brandy-2.0/build.sh` 生成，并复制到：

```text
device/config/chips/a733/bin/u-boot-sun60iw2p1.bin
out/a733/cubie_a7z/debian/u-boot-sun60iw2p1.bin
```

源码位置：

- `brandy/brandy-2.0/build.sh:177`
- `brandy/brandy-2.0/build.sh:225`
- `brandy/brandy-2.0/u-boot-2018/Makefile:1116`
- `brandy/brandy-2.0/u-boot-2018/Makefile:1122`
- `brandy/brandy-2.0/u-boot-2018/Makefile:1123`

### 4.3 sys_config.bin 的生成

Radxa 对 `sys_config.fex` 的转换是显式 Makefile 规则：

```text
device-a733/configs/cubie_a7z/sys_config.fex
  -> unix2dos
  -> tools/pack/pctools/linux/mod_update/script
  -> device-a733/configs/cubie_a7z/sys_config.bin
```

官方 SDK 中类似动作发生在 pack 阶段：

```text
pack_out/sys_config.fex
  -> script sys_config.fex
  -> pack_out/sys_config.bin
```

源码位置：

- `build/pack:839`
- `build/pack:843`
- `build/pack:844`

差异在于：Radxa 在产品 Makefile 中按需生成，官方 SDK 在 `pack_out` 目录统一生成。

### 4.4 boot0 的生成和注入

Radxa A733 的 boot0 产物包括：

```text
out/radxa-cubie-a7z/boot0_sdcard.bin
out/radxa-cubie-a7z/boot0_ufs.bin
out/radxa-cubie-a7z/boot0_spinor.bin
```

生成逻辑是：

```text
复制 device-a733/bin/boot0_<storage>_sun60iw2p1.bin
用 update_boot0 注入 sys_config.bin
用 update_chip 补芯片相关信息
```

这不是完整重编 boot0，而是“预置 boot0 二进制 + 板级配置注入”。Radxa Makefile 里还保留了 `spl-pub` 的 open-source BOOT0 规则，但 A733 产品目标实际依赖的是 `out/<product>/boot0_*` 闭源 boot0 路径。

官方 SDK pack 阶段做同类事情：

```text
boot0_sdcard.fex <- boot0_sdcard_sun60iw2p1.bin
update_boot0 boot0_sdcard.fex sys_config.bin SDMMC_CARD
update_chip boot0_sdcard.fex
```

源码位置：

- `build/pack:240`
- `build/pack:242`
- `build/pack:1028`
- `build/pack:1107`
- `build/pack:1108`
- `build/pack:1109`

差异在于：

```text
Radxa:
  out/<product>/boot0_*.bin 是最终发布件之一

官方 SDK:
  pack_out/boot0_*.fex 是完整固件 pack 的中间件/输入件
```

### 4.5 SCP/ARISC 固件生成

Radxa 的 SCP 规则：

```text
device-a733/configs/cubie_a7z/arisc.config
  -> tools/arisc_config_parse.sh

device-a733/configs/cubie_a7z/scp.bin
  -> make -C arisc
  -> mv arisc/ar100s/scp.bin
```

然后复制成：

```text
src/scp-a733-cubie_a7z.bin
```

再进入 `boot_package`。

官方 SDK 则在完整构建阶段先执行：

```text
build_arisc()
  -> 选择 arisc.config
  -> cp 到 brandy/arisc/.config
  -> make -C brandy/arisc
```

源码位置：

- `build/mkcmd.sh:2782`
- `build/mkcmd.sh:2814`
- `build/mkcmd.sh:2815`
- `brandy/arisc/Makefile:8`

官方 pack 阶段还会收集：

```text
LICHEE_PLAT_OUT/arisc -> pack_out/arisc.fex
LICHEE_CHIP_CONFIG_DIR/bin/scp.bin -> pack_out/scp.fex
```

源码位置：

- `build/pack:256`
- `build/pack:273`
- `build/pack:290`

### 4.6 boot_package.fex 的生成

Radxa 直接为每个产品生成最小 boot package 配置。A7Z 的逻辑是：

```text
src/boot_package-radxa-cubie-a7z.cfg
  depends on:
    src/bl31-a733.bin
    src/u-boot-sun60iw2p1.bin
    src/scp-a733-cubie_a7z.bin

cfg 内容:
  item=u-boot
  item=monitor
  item=scp

dragonsecboot -pack
  -> src/boot_package-radxa-cubie-a7z.fex
```

官方 SDK 则在 `build/pack` 中处理 `boot_package.cfg`。它会在 `pack_out` 中先完成：

```text
update_uboot
update_fes1
update_sboot
fsbuild boot-resource.ini
dragonsecboot -pack boot_package.cfg
```

源码位置：

- `build/pack:1136`
- `build/pack:1140`
- `build/pack:1153`
- `build/pack:1155`
- `build/pack:1162`
- `build/pack:1174`
- `build/pack:1195`

差异非常明确：

```text
Radxa boot_package:
  只聚合 bootloader 需要的最小项，形成独立发布件。

官方 SDK boot_package:
  是完整固件 pack 流程的一部分，会受平台、存储介质、签名、DTBO、boot-resource 等更多因素影响。
```

### 4.7 NOR 分区占位产物

Radxa Makefile 里还有：

```text
src/sys_partition_nor.bin
```

它通过 `sgdisk` 和 `dd` 生成一个小的 GPT 占位，用于抑制 boot 警告，并被复制到：

```text
out/<product>/sys_partition_nor.bin
```

官方 SDK 中 `sys_partition_nor.bin` 来自 `sys_partition_nor.fex` 经过 `script` 工具转换，并参与 NOR 镜像合成。

源码位置：

- `build/pack:1025`
- `build/pack:1026`
- `build/pack:1027`

## 5. Radxa 产物怎么管理

### 5.1 Radxa 的产物目录

Radxa 对外产物收口在：

```text
out/radxa-cubie-a7z/
  boot0_sdcard.bin
  boot0_ufs.bin
  boot0_spinor.bin
  boot_package.fex
  sys_partition_nor.bin
  setup.sh
  setup.ps1
```

`setup/u-boot_setup-allwinner-a733.sh` 中定义安装动作。例如 A733：

```text
update_bootloader <device>
  -> boot0_sdcard.bin 写入 seek=256
  -> boot0_ufs.bin 写入 seek=2064
  -> boot_package.fex 写入 seek=24576

update_spinor
  -> 组装 8M spi.img
  -> 写 boot0_spinor.bin
  -> 写 boot_package.fex
  -> 写 sys_partition_nor.bin
```

源码参考：

- Radxa `setup/u-boot_setup-allwinner-a733.sh`: `https://github.com/radxa-pkg/u-boot-aw2501/blob/main/setup/u-boot_setup-allwinner-a733.sh`

这说明 Radxa 发布的不是整盘镜像，而是可被安装脚本写入目标介质固定偏移的 bootloader bundle。

### 5.2 Debian 包管理

Radxa `debian/u-boot-aw2501.install` 的核心规则：

```text
out/* usr/lib/u-boot/
```

所以 `.deb` 安装后会得到：

```text
/usr/lib/u-boot/radxa-cubie-a5e/
/usr/lib/u-boot/radxa-cubie-a7a/
/usr/lib/u-boot/radxa-cubie-a7z/
```

`debian/u-boot-aw2501.links` 还把：

```text
/usr/lib/u-boot/radxa-cubie-a7a -> /usr/lib/u-boot/radxa-a733
```

作为 A733 系列的 meta 名称。

源码参考：

- Radxa `debian/u-boot-aw2501.install`
- Radxa `debian/u-boot-aw2501.links`
- Radxa `debian/control`

官方 SDK 没有这个 Debian 包管理层。它的产物管理是：

```text
device/config/chips/a733/bin/
  保存/更新 bootloader 基础二进制

out/a733/cubie_a7z/debian/
  保存当前平台构建产物

out/a733/cubie_a7z/pack_out/
  保存 pack 阶段临时件和最终输入件

out/a733/cubie_a7z/debian/*.img
  最终固件镜像
```

当前工作区中已经存在：

```text
out/a733/cubie_a7z/debian/u-boot-sun60iw2p1.bin
out/a733/cubie_a7z/pack_out/u-boot.fex
out/a733/cubie_a7z/pack_out/boot0_sdcard.fex
out/a733/cubie_a7z/pack_out/boot_package.fex
out/a733/cubie_a7z/pack_out/sys_config.bin
```

## 6. 官方 SDK 的完整 bootloader/pack 流程

### 6.1 build_bootloader

官方 SDK 的 `build_bootloader()` 先判断 brandy 版本：

```text
LICHEE_BRANDY_VER=2.0
  -> brandy_path=${LICHEE_BRANDY_DIR}
```

然后检查重编条件：

```text
u-boot-2018 是否更新
u-boot-bsp 是否更新
spl/spl-pub 是否更新
dramlib 是否更新
uboot-board.dts 是否更新
```

最后拼出 `brandy/brandy-2.0/build.sh` 参数：

```text
-p ${LICHEE_BRANDY_DEFCONF%%_def*}
-b ${LICHEE_IC}
-o ${LICHEE_BRANDY_BUILD_OPTION}
```

当前 `.buildconfig` 下等价于：

```bash
cd brandy/brandy-2.0
./build.sh -p radxa-cubie-a7z -b a733 -o uboot
```

源码位置：

- `build/mkcmd.sh:2167`
- `build/mkcmd.sh:2218`
- `build/mkcmd.sh:2237`
- `build/mkcmd.sh:2287`
- `build/mkcmd.sh:2295`

### 6.2 brandy/brandy-2.0/build.sh

`build.sh` 的关键流程：

```text
读取 ../../.buildconfig
解析 -o/-p/-b/-u/-a
默认 UBOOT_VER=2018
UBOOT_DIR=u-boot-2018
build_uboot 或 build_all
```

当传入 `-o uboot` 时，只执行 `build_uboot`。当前工作区 `LICHEE_BRANDY_BUILD_OPTION=uboot`，且 `brandy/brandy-2.0` 里没有顶层 `spl`/`spl-pub` 目录，所以当前默认并不重编 boot0/spl。

源码位置：

- `brandy/brandy-2.0/build.sh:620`
- `brandy/brandy-2.0/build.sh:622`
- `brandy/brandy-2.0/build.sh:663`
- `brandy/brandy-2.0/build.sh:671`
- `brandy/brandy-2.0/build.sh:698`

### 6.3 U-Boot proper 编译

`build_uboot_once()` 的核心动作：

```text
进入 u-boot-2018/
make distclean
make <defconfig>
uboot_prepare_toolchain
make CROSS_COMPILE=<selected-toolchain> -j
```

源码位置：

- `brandy/brandy-2.0/build.sh:177`
- `brandy/brandy-2.0/build.sh:206`
- `brandy/brandy-2.0/build.sh:207`
- `brandy/brandy-2.0/build.sh:209`
- `brandy/brandy-2.0/build.sh:210`

产物复制逻辑在 U-Boot Makefile：

```text
u-boot-sun60iw2p1.bin
  -> device/config/chips/a733/bin/
  -> out/a733/cubie_a7z/debian/
```

源码位置：

- `brandy/brandy-2.0/u-boot-2018/Makefile:1116`
- `brandy/brandy-2.0/u-boot-2018/Makefile:1122`
- `brandy/brandy-2.0/u-boot-2018/Makefile:1123`

### 6.4 pack 收集和二次处理

官方 `build/pack` 会把 bootloader 相关文件复制到 `pack_out`：

```text
boot0_nand/sdcard/ufs/spinor
fes1
u-boot
bl31 -> monitor.fex
scp -> scp.fex
optee/sboot/opensbi
sunxi.dtb -> sunxi.fex
```

源码位置：

- `build/pack:240`
- `build/pack:250`
- `build/pack:254`
- `build/pack:256`
- `build/pack:272`
- `build/pack:286`

然后它对不同存储介质处理：

```text
NOR:
  update_boot0 boot0_spinor.fex sys_config.bin SPINOR_FLASH
  update_uboot u-boot-spinor.fex sys_config.bin
  dragonsecboot -pack boot_package_nor.cfg

NAND/Card/UFS:
  update_boot0 boot0_nand.fex   sys_config.bin NAND
  update_boot0 boot0_sdcard.fex sys_config.bin SDMMC_CARD
  update_boot0 boot0_ufs.fex    sys_config.bin UFS
  update_uboot u-boot.fex       sys_config.bin
  dragonsecboot -pack boot_package.cfg
```

源码位置：

- `build/pack:1028`
- `build/pack:1039`
- `build/pack:1077`
- `build/pack:1107`
- `build/pack:1108`
- `build/pack:1109`
- `build/pack:1140`
- `build/pack:1195`

## 7. Radxa 和官方 SDK 的关键差异对照

| 维度 | 官方 SDK | Radxa u-boot-aw2501 |
| --- | --- | --- |
| 构建入口 | `./build.sh`、`./build.sh pack` | `make build`、`make deb` |
| 配置中心 | `.buildconfig` + `BoardConfig.mk` | `.github/local/Makefile.local` 产品目标 |
| U-Boot 源码位置 | `brandy/brandy-2.0/u-boot-2018` | `src` submodule |
| device 目录 | `device/config/chips/a733` | `device-a733` submodule |
| 工具链 | `brandy build.sh` 自动选择/准备 | 顶层 Makefile 显式指定，并 patch 掉内部覆盖 |
| boot0 | SDK bin + pack 阶段注入 | `device-a733/bin` 复制后按产品注入 |
| SCP | `build_arisc` + pack 收集 | Makefile 规则按产品生成 `scp.bin` |
| boot_package | pack 阶段综合生成 | 每个产品生成最小 `boot_package-*.cfg` |
| 输出目录 | `out/<ic>/<board>/<linuxdev>`、`pack_out` | `out/<product>` |
| 发布形式 | 完整固件镜像 | Debian 包 `/usr/lib/u-boot/<product>` |
| 安装方式 | 烧录完整 image | `setup.sh` 把 bootloader 写入固定偏移 |

## 8. 对 Radxa 改造意图的判断

Radxa 的目标不是替代完整 Tina SDK，而是把 bootloader 从完整 SDK 中剥离出来，做成可持续发布的 Debian 包。为了做到这一点，它做了几件很有针对性的事情：

1. 固定 submodule，保证 U-Boot、device、tools、arisc、dramlib 版本可追踪。
2. 用外层 Makefile 显式声明产品依赖，替代官方 SDK 的 `.buildconfig` 推导。
3. patch U-Boot Makefile，禁止内部强制选择/解压 Allwinner 工具链。
4. 用 `CUSTOM_MAKE_DEFINITIONS` 给 U-Boot 和工具提供最低限度的 SDK 变量。
5. 用 `awbs/awbs` 和临时 `LICHEE_*` 环境适配 `update_chip` 这类仍依赖 SDK 语境的工具。
6. 把产物集中到 `out/<product>`，再用 Debian install 规则安装到 `/usr/lib/u-boot`。
7. 提供 `setup.sh/setup.ps1`，让用户在已运行系统上更新 bootloader，而不是每次重新烧完整固件。

这套结构的优点是发布、升级、CI 都更清晰；缺点是它只覆盖 bootloader 包场景，不能替代官方 SDK 的完整镜像构建链。比如 rootfs、kernel、分区镜像、boot-resource、完整 `pack_out` 签名策略，仍属于官方 SDK 的职责。

## 9. 当前工作区与 Radxa 最新分支的一个具体差异

当前本地：

```text
brandy/brandy-2.0/u-boot-2018/configs/radxa-cubie-a7z_defconfig
  CONFIG_DEFAULT_DEVICE_TREE="sun60iw2p1-soc-system"
```

Radxa 远端 `cubie-aiot-v1.4.6` 分支中：

```text
configs/radxa-cubie-a7z_defconfig
  CONFIG_DEFAULT_DEVICE_TREE="sun60i-a733-cubie-a7z"
  CONFIG_DISTRO_DEFAULTS=y
```

A7A 远端还额外启用了 `CONFIG_RADXA_UNIFIED_IMAGE` 等选项。

这说明 Radxa 的定制不只是外层构建脚本，也包括板级 defconfig、DTS 命名、启动策略的持续演进。若要让当前官方 SDK 的 bootloader 行为对齐 Radxa 最新包，需要同时比较：

```text
brandy/brandy-2.0/u-boot-2018/configs/radxa-cubie-a7*.defconfig
brandy/brandy-2.0/u-boot-2018/arch/arm/dts/
device/config/chips/a733/configs/cubie_a7*/sys_config.fex
device/config/chips/a733/configs/cubie_a7*/uboot-board.dts
```

而不仅仅是比较 `build.sh`。

## 10. 结论

Radxa 定制版相当于把官方 SDK 的 bootloader 子系统“产品化”和“包化”：

```text
官方 SDK:
  完整固件工程
  全局 .buildconfig
  build_bootloader + build_kernel + build_rootfs + pack
  输出完整 image

Radxa u-boot-aw2501:
  bootloader 发布工程
  产品 Makefile 目标
  U-Boot + boot0 + SCP + BL31 + boot_package
  输出 Debian 包和 /usr/lib/u-boot/<product>
```

最核心的技术适配是：

```text
把官方 SDK 的隐式上下文
  .buildconfig / LICHEE_* / device/config/chips / pack_out

改造成 Radxa 工程里的显式依赖
  device-a733 / src / tools / arisc / out/<product> / debian install
```

所以 Radxa 的构建不是简单“换个 Makefile”，而是重新定义了 bootloader 的工程边界和产物生命周期。

