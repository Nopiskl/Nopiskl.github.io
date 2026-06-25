# Radxa linux-a733 与当前官方 SDK 内核构建流程源码分析

本文基于当前工作区 `/home/alientek/A733/tina-aiot` 与临时克隆的 Radxa 仓库 `/tmp/radxa-linux-a733` 分析。

Radxa 仓库版本信息：

```text
linux-a733 HEAD: 18dcb68d3d7ba61df51835ffa2f142b40bae21f9
bsp:            2045a3ca2a01f088c0314dc924bda59d154e363e
device-a733:    6d911d1582dcccdb5a4c38be8d3c1ee851019795
src:            e41499895c17074874f4c48ff04041c57d8dfd99
tag/version:    5.15.147-21
```

## 1. 一句话总览

官方 SDK 是完整固件流水线：

```text
./build.sh config/tina/kernel/pack
  -> build/mkcommon.sh
  -> build/mkcmd.sh
  -> build/mkkernel.sh
  -> out/a733/kernel/{build,staging}
  -> out/a733/<board>/<linuxdev>
  -> out/a733/<board>/pack_out
  -> 最终烧录镜像
```

Radxa `linux-a733` 是 Debian 内核包工程：

```text
make deb
  -> debuild -b
  -> make build
  -> pre_build 拼接 src/bsp、DTS、dtsi、dt-bindings、bsp.config
  -> make -C src defconfig radxa.config radxa_custom.config
  -> make -C src all
  -> make -C src bindeb-pkg
  -> 父目录 ../*.deb
```

所以两者最大的差别不是内核 Kbuild 本身，而是外层工程组织与产物管理：官方 SDK 面向固件镜像，Radxa 面向 Debian/Apt 内核包。

## 2. 官方 SDK：入口、配置、BSP 接入

### 2.1 `build.sh` 只是入口包装

当前工作区 `build.sh` 的实际动作非常薄：

```sh
$(cd $(dirname $0) && pwd)/build/mkcommon.sh "$@"
```

对应文件：

- `/home/alientek/A733/tina-aiot/build.sh`
- `/home/alientek/A733/tina-aiot/build/mkcommon.sh`

`mkcommon.sh` 根据参数选择动作。内核相关入口包括 `kernel`、`modules`、`dts`、`bootimg`、`pack*`：

```sh
dtb|brandy|bootloader|arisc|dts|kernel|modules|bootimg|rtos|dsp)
    ACTION="build_${1} ${@:2};"
    ;;
pack*)
    ACTION="mk_pack ${mode};"
    ;;
```

### 2.2 BoardConfig 解析：官方 SDK 的配置中心

官方 SDK 不直接在顶层 Makefile 写死板级信息，而是解析多层 `BoardConfig.mk`：

```sh
default_config="${LICHEE_CHIP_CONFIG_DIR}/configs/default/BoardConfig.mk"
special_config_linux="${LICHEE_BOARD_CONFIG_DIR}/${LICHEE_LINUX_DEV}/BoardConfig.mk"
special_config="${LICHEE_BOARD_CONFIG_DIR}/BoardConfig.mk"
config_list=($default_config $special_config $special_config_linux)
```

然后用 `make -f` 方式解析变量：

```sh
cfgval="$(echo '__unique:;@echo ${'"$cfgkey"'}' | make $includes -f - $fpare_list --no-print-directory __unique)"
```

源码位置：

- `/home/alientek/A733/tina-aiot/build/mkcmd.sh:1196`
- `/home/alientek/A733/tina-aiot/build/mkcmd.sh:1215`
- `/home/alientek/A733/tina-aiot/build/mkcmd.sh:1275`

A733/Cubie A7A 当前官方配置里的典型变量：

```make
LICHEE_CHIP:=sun60iw2p1
LICHEE_ARCH:=arm64
LICHEE_BRANDY_VER:=2.0
LICHEE_USE_INDEPENDENT_BSP=true
LICHEE_KERN_DEFCONF:=cubie_a7a_defconfig
LICHEE_BRANDY_DEFCONF:=radxa-cubie-a7a_defconfig
LICHEE_NO_RAMDISK_NEEDED:=y
```

源码位置：

- `/home/alientek/A733/tina-aiot/device/config/chips/a733/configs/default/BoardConfig.mk`
- `/home/alientek/A733/tina-aiot/device/config/chips/a733/configs/cubie_a7a/debian/BoardConfig.mk`
- `/home/alientek/A733/tina-aiot/device/config/chips/a733/configs/cubie_a7a/linux-5.15/BoardConfig.mk`

### 2.3 `.buildconfig` 是官方 SDK 后续构建的事实输入

`mk_config/autoconfig` 最终生成 `.buildconfig`。这里面会固化：

```sh
export LICHEE_KERN_DIR=/home/alientek/A733/tina-aiot/kernel/linux-5.15
export LICHEE_BSP_DIR=/home/alientek/A733/tina-aiot/bsp
export LICHEE_PLAT_OUT=/home/alientek/A733/tina-aiot/out/a733/cubie_a7a/debian
export LICHEE_PACK_OUT_DIR=/home/alientek/A733/tina-aiot/out/a733/cubie_a7a/pack_out
export LICHEE_KERN_DEFCONF_ABSOLUTE=.../cubie_a7a_defconfig
```

这就是官方 SDK 后续脚本不再反复询问板卡/平台/内核版本的原因。

### 2.4 独立 BSP 接入：`bsp.sh setup`

官方 SDK 的关键适配是把仓库根目录 `bsp` 软链接进内核树：

```sh
function setup_bsp()
{
    pushd "${KER_DIR}" >/dev/null
    rm -rf bsp
    ln -sr ${BSP_DIR} bsp
    popd >/dev/null
}
```

源码位置：

- `/home/alientek/A733/tina-aiot/build/bsp.sh:52`

调用点在 `prepare_mkkernel`：

```sh
# setup bsp code to kernel
bsp_action setup
board_dts_create_link
```

源码位置：

- `/home/alientek/A733/tina-aiot/build/mkcmd.sh:1846`

软链接之后，当前工作区实际是：

```text
kernel/linux-5.15/bsp -> ../../bsp
```

### 2.5 内核 Makefile 已经给 BSP 留好入口

内核树里有 Allwinner/Radxa 需要的 BSP Kbuild 钩子。

包含 BSP 头文件：

```make
LINUXINCLUDE := \
        -I$(srctree)/arch/$(SRCARCH)/include \
        -I$(objtree)/arch/$(SRCARCH)/include/generated \
        -I$(srctree)/bsp/include \
        $(USERINCLUDE)
```

把 `bsp/` 纳入内核递归构建：

```make
drivers-y := drivers/ sound/
drivers-y += bsp/
```

导出 BSP uapi 头文件：

```make
hdr-inst-bsp := -f $(srctree)/bsp/scripts/Makefile.headersinst obj
ifneq ($(wildcard $(srctree)/bsp/scripts/Makefile.headersinst),)
        $(Q)$(MAKE) $(hdr-inst-bsp)=bsp/include/uapi
endif
```

源码位置：

- `/home/alientek/A733/tina-aiot/kernel/linux-5.15/Makefile:514`
- `/home/alientek/A733/tina-aiot/kernel/linux-5.15/Makefile:675`
- `/home/alientek/A733/tina-aiot/kernel/linux-5.15/Makefile:1346`

## 3. 官方 SDK：内核实际怎么编译并管理产物

### 3.1 `prepare_toolchain` 决定用哪个 kernel build script

当前 A733 走通用 `build/mkkernel.sh`：

```sh
KERNEL_BUILD_SCRIPT_DIR=$LICHEE_BUILD_DIR
KERNEL_BUILD_SCRIPT=mkkernel.sh
KERNEL_BUILD_OUT_DIR=$LICHEE_OUT_DIR/$LICHEE_IC/kernel/build
KERNEL_STAGING_DIR=$LICHEE_OUT_DIR/$LICHEE_IC/kernel/staging
```

源码位置：

- `/home/alientek/A733/tina-aiot/build/mkcmd.sh:1578`

### 3.2 `mkkernel.sh` 设置 Kbuild 输出目录和 staging

```sh
KERNEL_SRC=$LICHEE_KERN_DIR
BUILD_OUT_DIR=$LICHEE_OUT_DIR/$LICHEE_IC/kernel/build
STAGING_DIR=$LICHEE_OUT_DIR/$LICHEE_IC/kernel/staging
MAKE+=" ARCH=${LICHEE_KERNEL_ARCH} -j${LICHEE_JLEVEL} O=${BUILD_OUT_DIR}"
MAKE+=" KERNEL_SRC=$KERNEL_SRC INSTALL_MOD_PATH=${STAGING_DIR}"
```

源码位置：

- `/home/alientek/A733/tina-aiot/build/mkkernel.sh:86`

如果 `.config` 不存在或 defconfig 更新，就用 SDK 解析出的板级 defconfig：

```sh
${MAKE} defconfig KBUILD_DEFCONFIG=${LICHEE_KERN_DEFCONF_RELATIVE}
```

源码位置：

- `/home/alientek/A733/tina-aiot/build/mkkernel.sh:127`

### 3.3 官方 SDK 的 kernel target

```sh
local MAKE_ARGS="modules"
if [ "${LICHEE_KERNEL_ARCH}" = "arm" ]; then
    MAKE_ARGS+=" uImage dtbs LOADADDR=0x40008000"
else
    MAKE_ARGS+=" all"
fi
MAKE_ARGS+=" INSTALL_HDR_PATH=$BUILD_OUT_DIR/user_headers headers_install"
${MAKE} $MAKE_ARGS
INSTALL_MOD_STRIP=1 ${MAKE} modules_install
```

源码位置：

- `/home/alientek/A733/tina-aiot/build/mkkernel.sh:352`

这说明官方 SDK 的 `kernel` 不是只编 `Image`，而是同时编：

- 内核镜像；
- 内核模块；
- dtbs；
- headers；
- modules_install 到 staging。

### 3.4 官方 SDK 的 DTS 编译方式

独立 BSP 模式下，DTS 不是简单用内核 `arch/arm64/boot/dts/allwinner/*.dts`，而是 SDK 自己用 `cpp + dtc` 处理 `device/config/.../board.dts`：

```sh
dtsfile=${LICHEE_BOARD_CONFIG_DIR}/board.dts
die_dtsi_file=${LICHEE_BSP_DIR}/configs/${LICHEE_KERN_VER}/${LICHEE_CHIP}.dtsi
cpp -I ${LICHEE_KERN_DIR}/include -I ${LICHEE_KERN_DIR}/bsp/include \
    -I ${die_dtsi_path} -I ${chip_dtsi_path} \
    -o ${dep}/.${outname}.dts.tmp ${dtsfile}
$DTC -O dtb -o ${outpath}/${outname} ... ${dep}/.${outname}.dts.tmp
```

源码位置：

- `/home/alientek/A733/tina-aiot/build/mkkernel.sh:207`

最终 staging 文件名固定是：

```text
out/a733/kernel/staging/sunxi.dtb
```

### 3.5 官方 SDK 的 output/staging 管理

`output_build` 会把 Kbuild 产物收拢到 staging：

```sh
$BUILD_OUT_DIR/arch/${LICHEE_KERNEL_ARCH}/boot/Image:$STAGING_DIR/bImage
$BUILD_OUT_DIR/.config:$STAGING_DIR/.config
$BUILD_OUT_DIR/System.map:$STAGING_DIR/System.map
$BUILD_OUT_DIR/scripts/dtc/dtc:$LICHEE_PLAT_OUT/dtc
```

然后复制到平台输出：

```sh
rm -rf ${LICHEE_PLAT_OUT}/lib ${LICHEE_PLAT_OUT}/dist
cp -rax $STAGING_DIR/. ${LICHEE_PLAT_OUT}
(cd ${LICHEE_PLAT_OUT} && ln -sf lib/modules/$KERNEL_VERSION dist)
```

源码位置：

- `/home/alientek/A733/tina-aiot/build/mkkernel.sh:710`
- `/home/alientek/A733/tina-aiot/build/mkkernel.sh:837`

### 3.6 官方 SDK 生成 `boot.img`

```sh
${MKBOOTIMG} --kernel ${BIMAGE} \
    --board ${CHIP}_${LICHEE_ARCH} \
    --base ${BASE} \
    --kernel_offset ${KERNEL_OFFSET} \
    --dtb ${DTB} \
    --dtb_offset ${DTB_OFFSET} \
    --header_version 2 \
    -o $STAGING_DIR/${IMAGE_NAME}
cp $STAGING_DIR/${IMAGE_NAME} ${LICHEE_PLAT_OUT}
```

源码位置：

- `/home/alientek/A733/tina-aiot/build/mkkernel.sh:681`

### 3.7 官方 SDK 完整固件打包

`mk_pack` 调 `build/pack`：

```sh
$PACK_CMD -i ${LICHEE_IC} -c ${LICHEE_CHIP} -p ${PACK_PLATFORM} \
    -b ${LICHEE_BOARD} -k ${LICHEE_KERN_VER} -n ${LICHEE_FLASH} $@
```

源码位置：

- `/home/alientek/A733/tina-aiot/build/mkcmd.sh:3068`

Linux 平台的 pack 会把平台输出目录里的文件软链接为 fex：

```sh
ln -sf ${link_real}/boot.img        boot.fex
ln -sf ${link_real}/rootfs.ext4     rootfs.fex
ln -sf ${link_real}/rootfs.ubifs    rootfs-ubifs.fex
```

源码位置：

- `/home/alientek/A733/tina-aiot/build/pack:2930`

最后 `dragon image.cfg sys_partition.fex` 生成最终镜像，并移动到：

```text
out/a733/<board>/<linuxdev>/<image>.img
out/<image>.img
```

## 4. Radxa：仓库结构适配源码

### 4.1 顶层 Makefile：先 include local，再 include extra

```make
-include .github/local/Makefile.local
-include Makefile.extra

all: build
deb: debian pre_debuild debuild post_debuild
debuild:
        $(CUSTOM_DEBUILD_ENV) debuild ... --no-sign -b $(CUSTOM_DEBUILD_ARG)
```

源码位置：

- `/tmp/radxa-linux-a733/Makefile:5`
- `/tmp/radxa-linux-a733/Makefile:107`

这说明 `make deb` 先进入 Debian packaging 世界，再由 debhelper 调回顶层 `make build`。

### 4.2 Radxa 的 KMAKE

```make
KERNEL_FORK ?= a733
ARCH ?= arm64
CROSS_COMPILE ?= aarch64-linux-gnu-
KMAKE ?= $(CUSTOM_ENV_DEFINITIONS) $(MAKE) -C "$(SRC-KERNEL)" -j$(shell nproc) \
        $(CUSTOM_MAKE_DEFINITIONS) \
        ARCH=$(ARCH) CROSS_COMPILE=$(CROSS_COMPILE) HOSTCC=$(CROSS_COMPILE)gcc \
        KDEB_COMPRESS="xz" KDEB_CHANGELOG_DIST="unstable" DPKG_FLAGS=$(DPKG_FLAGS) \
        LOCALVERSION=-$(shell dpkg-parsechangelog -S Version | cut -d "-" -f 2)-$(KERNEL_FORK) \
        KERNELRELEASE=$(shell dpkg-parsechangelog -S Version)-$(KERNEL_FORK) \
        KDEB_PKGVERSION=$(shell dpkg-parsechangelog -S Version)
```

源码位置：

- `/tmp/radxa-linux-a733/Makefile.extra:5`
- `/tmp/radxa-linux-a733/Makefile.extra:14`

以 `5.15.147-21` 为例：

```text
KERNELRELEASE = 5.15.147-21-a733
LOCALVERSION  = -21-a733
```

这直接决定了 Debian 包名和 `/lib/modules/<release>` 目录名。

### 4.3 Radxa 的 build 目标

```make
build: pre_build build-defconfig build-bindeb post_build
build-defconfig:
        $(KMAKE) $(KERNEL_DEFCONFIG)
build-all:
        $(KMAKE) all
build-bindeb: $(SRC-KERNEL) build-all
        $(KMAKE) bindeb-pkg
        mv linux-*_arm64.deb linux-upstream*_arm64.changes linux-upstream*_arm64.buildinfo ../
```

源码位置：

- `/tmp/radxa-linux-a733/Makefile.extra:27`

这和官方 SDK 的区别非常明显：

- 官方 SDK：`kernel_build -> output_build -> bootimg_build -> rootfs/pack`
- Radxa：`defconfig/fragments -> all -> bindeb-pkg -> ../*.deb`

### 4.4 `Makefile.local` 是 Radxa 适配官方 SDK 结构的核心

```make
CUSTOM_MAKE_DEFINITIONS := BSP_TOP=bsp/ LICHEE_KERN_DIR=./ KBUILD_DEFCONFIG=bsp.config
KERNEL_DEFCONFIG := defconfig radxa.config radxa_custom.config
SUPPORT_CLEAN := false
```

源码位置：

- `/tmp/radxa-linux-a733/.github/local/Makefile.local:1`

含义：

- `BSP_TOP=bsp/`：告诉 BSP Kbuild 自己在 kernel tree 下的相对位置。
- `LICHEE_KERN_DIR=./`：让若干 BSP 脚本/Makefile 以 `src` 作为内核根。
- `KBUILD_DEFCONFIG=bsp.config`：`make defconfig` 不用默认 `defconfig`，而用 Radxa 生成的 `bsp.config`。
- `KERNEL_DEFCONFIG := defconfig radxa.config radxa_custom.config`：先基础 defconfig，再叠加 Radxa 通用 fragment 与定制 fragment。

### 4.5 Radxa 临时拼接 `src/bsp`

```make
src/bsp: $(SRC-KERNEL)
        ln -sf ../bsp $@
```

源码位置：

- `/tmp/radxa-linux-a733/.github/local/Makefile.local:16`

这等价于官方 SDK 的：

```sh
cd kernel/linux-5.15
ln -sr ../../bsp bsp
```

只是官方 SDK 由 `build/bsp.sh setup` 完成，Radxa 由 Makefile target 完成。

### 4.6 Radxa 临时拼接 defconfig

```make
src/arch/arm64/configs/bsp.config: $(SRC-KERNEL)
        ln -sf ../../../../device-a733/configs/default/linux-5.15/bsp_defconfig $@
```

源码位置：

- `/tmp/radxa-linux-a733/.github/local/Makefile.local:19`

官方 SDK 的 A7A 原来是：

```make
LICHEE_KERN_DEFCONF:=cubie_a7a_defconfig
```

Radxa 的 `device-a733` 改成：

```make
LICHEE_KERN_DEFCONF:=bsp_defconfig
```

也就是说，Radxa 不再维护 `cubie_a7a_defconfig` 这种板级完整 defconfig，而是用统一 BSP defconfig 加 fragments。

### 4.7 Radxa 临时拼接 DTS

```make
src/arch/arm64/boot/dts/allwinner/sun60i-a733-cubie-a7a.dts:
        ln -sf ../../../../../../device-a733/configs/cubie_a7a/linux-5.15/board.dts $@
```

同理还有 A7S/A7Z。

源码位置：

- `/tmp/radxa-linux-a733/.github/local/Makefile.local:28`

官方 SDK 独立 BSP 模式下，DTS 是 SDK 外部编译成固定名 `sunxi.dtb`；Radxa 则把 `board.dts` 伪装成标准内核 DTS，进入 `make dtbs/dtbs_install`。

### 4.8 Radxa 复制 dtsi 与 dt-bindings

```make
src/arch/arm64/boot/dts/allwinner:
        cp -aR bsp/configs/linux-5.15/*.dtsi $@

src/include/dt-bindings:
        cp -aR bsp/include/dt-bindings/. $@
```

源码位置：

- `/tmp/radxa-linux-a733/.github/local/Makefile.local:37`

这是因为 Radxa 没有官方 SDK 的 `cpp -I bsp/configs/linux-5.15` 那套外部 DTS 编译脚本；它必须把 include 依赖放到内核 dtbs 构建能找到的位置。

### 4.9 Radxa 为 BSP 准备 ramfs 与版本头

```make
bsp/ramfs/ramfs_aarch64.cpio.gz:
        cd bsp/ramfs/ramfs_aarch64 && find . | fakeroot cpio -o -Hnewc | gzip > ../ramfs_aarch64.cpio.gz

bsp/include/sunxi-autogen.h:
        echo "#define AW_BSP_VERSION \"... RadxaOS SDK\"" > $@
```

源码位置：

- `/tmp/radxa-linux-a733/.github/local/Makefile.local:22`

官方 SDK 也会准备 ramfs；但官方 SDK 的产物最后会进 `boot.img`，Radxa 的 ramfs 更多是满足 BSP/内核构建期依赖，最终 Debian 系统启动一般依赖 distro 的 initramfs hooks。

## 5. Radxa：Kconfig fragment 合并机制

Radxa 的：

```make
KERNEL_DEFCONFIG := defconfig radxa.config radxa_custom.config
```

会对应 Linux Kconfig 规则：

```make
defconfig:
        conf --defconfig=arch/$(SRCARCH)/configs/$(KBUILD_DEFCONFIG) $(Kconfig)

%.config:
        merge_config.sh -m .config $(configfiles)
        make olddefconfig
```

源码位置：

- `/tmp/radxa-linux-a733/src/scripts/kconfig/Makefile:84`
- `/tmp/radxa-linux-a733/src/scripts/kconfig/Makefile:96`

因此实际配置顺序是：

```text
1. make defconfig
   KBUILD_DEFCONFIG=bsp.config
   bsp.config -> device-a733/configs/default/linux-5.15/bsp_defconfig

2. make radxa.config
   合并 src/arch/arm64/configs/radxa.config

3. make radxa_custom.config
   合并 src/arch/arm64/configs/radxa_custom.config

4. olddefconfig 补齐默认值
```

`radxa_custom.config` 的关键内容：

```diff
+CONFIG_PREEMPT_VOLUNTARY=n
+CONFIG_PREEMPT=y
+CONFIG_CPUFREQ_DT=n
+CONFIG_DRM_PANFROST=n
```

源码位置：

- `/tmp/radxa-linux-a733/debian/patches/linux/0002-feat-Radxa-custom-kernel-config.patch:17`

这里的意图很直接：

- `CONFIG_PREEMPT=y`：避免 Allwinner BSP 模块因为内联 spinlock 链接失败。
- `CONFIG_CPUFREQ_DT=n`：避免主线 `cpufreq-dt` 和 Allwinner `CONFIG_AW_CPUFREQ_DT` 冲突。
- `CONFIG_DRM_PANFROST=n`：避免主线 Panfrost 和 Allwinner 自带 GPU/DRM fork 冲突。

## 6. Radxa：DTS 进入内核 dtbs 的补丁

Radxa 把三个板子的 DTB 加到内核 `allwinner/Makefile`：

```diff
+dtb-$(CONFIG_ARCH_SUNXI) += sun60i-a733-cubie-a7a.dtb
+dtb-$(CONFIG_ARCH_SUNXI) += sun60i-a733-cubie-a7s.dtb
+dtb-$(CONFIG_ARCH_SUNXI) += sun60i-a733-cubie-a7z.dtb
```

源码位置：

- `/tmp/radxa-linux-a733/debian/patches/linux/0004-fix-add-device-tree.patch:15`

这一步配合前面的 DTS symlink，才能让 `make all` 或 `make dtbs_install` 看到这些 board dts。

## 7. Radxa：Debian 包如何生成

### 7.1 `bindeb-pkg` 入口

内核自带 packaging 规则：

```make
bindeb-pkg:
        $(CONFIG_SHELL) $(srctree)/scripts/package/mkdebian
        +dpkg-buildpackage ... -b -nc -uc
```

源码位置：

- `/tmp/radxa-linux-a733/src/scripts/Makefile.package:80`

### 7.2 `builddeb` 安装内核、DTB、modules、headers

安装内核镜像：

```sh
cp System.map "$tmpdir/boot/System.map-$version"
cp $KCONFIG_CONFIG "$tmpdir/boot/config-$version"
cp "$($MAKE -s -f $srctree/Makefile image_name)" "$tmpdir/$installed_image_path"
```

安装 DTB：

```sh
$MAKE -f $srctree/Makefile INSTALL_DTBS_PATH="$tmpdir/usr/lib/$packagename" dtbs_install
```

安装 modules：

```sh
INSTALL_MOD_PATH="$tmpdir" $MAKE -f $srctree/Makefile modules_install
```

生成 headers/libc-dev/image 包：

```sh
create_package linux-headers-$version debian/linux-headers
create_package linux-libc-dev debian/linux-libc-dev
create_package "$packagename" "$tmpdir"
```

源码位置：

- `/tmp/radxa-linux-a733/src/scripts/package/builddeb:140`
- `/tmp/radxa-linux-a733/src/scripts/package/builddeb:152`
- `/tmp/radxa-linux-a733/src/scripts/package/builddeb:159`
- `/tmp/radxa-linux-a733/src/scripts/package/builddeb:211`

### 7.3 Radxa 对 `builddeb` 的重要改动：headers 包包含 BSP 头文件

当前 Radxa `builddeb` 比本地官方 SDK 的 `builddeb` 多了 `bsp/include`：

```sh
find include scripts bsp/include -type f -o -type l
```

源码位置：

- `/tmp/radxa-linux-a733/src/scripts/package/builddeb:61`

本地官方 SDK 对比只有：

```sh
find include scripts -type f -o -type l
```

这说明 Radxa 解决的是 Debian `linux-headers-*` 包的外部模块编译问题。官方 SDK 不主要依赖 `linux-headers` deb 包，所以这个差异在 SDK 固件流程里不突出。

## 8. Radxa meta 包

Radxa 顶层 `debian/control` 定义的是板级 meta 包，例如 A7A：

```debcontrol
Package: linux-image-radxa-cubie-a7a
Architecture: all
Depends: radxa-overlays-dkms,
         linux-image-${binary:Version}-a733,
         ${misc:Depends},
```

headers/libc-dev 也类似：

```debcontrol
Package: linux-headers-radxa-cubie-a7a
Depends: linux-headers-${binary:Version}-a733

Package: linux-libc-dev-radxa-cubie-a7a
Depends: linux-libc-dev-${binary:Version}-a733
```

源码位置：

- `/tmp/radxa-linux-a733/debian/control:19`
- `/tmp/radxa-linux-a733/debian/control:30`
- `/tmp/radxa-linux-a733/debian/control:40`

因此 Radxa 产物分两层：

```text
真实内核包：
  linux-image-5.15.147-21-a733_*.deb
  linux-headers-5.15.147-21-a733_*.deb
  linux-libc-dev_*.deb 或等价版本包

板级 meta 包：
  linux-image-radxa-cubie-a7a_*.deb
  linux-headers-radxa-cubie-a7a_*.deb
  linux-libc-dev-radxa-cubie-a7a_*.deb
  linux-image-radxa-a733_*.deb
```

真实内核包来自 `src/scripts/package/builddeb`；meta 包来自顶层 `debian/control + debhelper`。

## 9. 两边源码级差异总结

### 9.1 BSP 接入方式不同

官方 SDK：

```text
build/mkcmd.sh -> bsp_action setup -> build/bsp.sh -> kernel/linux-5.15/bsp symlink
```

Radxa：

```text
Makefile.local pre_build -> src/bsp symlink
```

两者最终目的相同：让 Kbuild 在 kernel tree 根目录看到 `bsp/`。

### 9.2 DTS 编译路径不同

官方 SDK：

```text
device/config/.../board.dts
  + bsp/configs/linux-5.15/sun60iw2p1.dtsi
  + cpp/dtc wrapper
  -> out/a733/kernel/staging/sunxi.dtb
  -> out/a733/<board>/<linuxdev>/sunxi.dtb
  -> mkbootimg --dtb sunxi.dtb
```

Radxa：

```text
device-a733/.../board.dts
  -> symlink as src/arch/arm64/boot/dts/allwinner/sun60i-a733-cubie-a7a.dts
  -> make dtbs
  -> make dtbs_install
  -> linux-image deb: /usr/lib/linux-image-<version>/*.dtb
```

### 9.3 defconfig 策略不同

官方 SDK：

```text
BoardConfig.mk -> LICHEE_KERN_DEFCONF=cubie_a7a_defconfig
make defconfig KBUILD_DEFCONFIG=<relative path to cubie_a7a_defconfig>
```

Radxa：

```text
src/arch/arm64/configs/bsp.config -> device-a733/configs/default/linux-5.15/bsp_defconfig
make defconfig radxa.config radxa_custom.config
```

这使 Radxa 更像发行版内核：统一基础配置 + 通用发行版功能 + 少量冲突修正。

### 9.4 版本号来源不同

官方 SDK：

```text
内核版本主要来自 kernel Makefile + utsrelease
LOCALVERSION 被清空，避免自动追加 +
```

源码位置：

- `/home/alientek/A733/tina-aiot/build/mkkernel.sh:388`

Radxa：

```text
版本来自 debian/changelog
KERNELRELEASE=<dpkg version>-a733
KDEB_PKGVERSION=<dpkg version>
```

源码位置：

- `/tmp/radxa-linux-a733/Makefile.extra:17`

### 9.5 产物管理不同

官方 SDK：

```text
out/a733/kernel/build      Kbuild O= 输出
out/a733/kernel/staging    临时收拢区
out/a733/<board>/debian    平台输出，含 boot.img/rootfs/ext/dtb/modules
out/a733/<board>/pack_out  pack 中间件与 fex
out/*.img                  最终固件镜像快捷链接
```

Radxa：

```text
src/debian/linux-image      builddeb 临时安装树
src/debian/linux-headers    headers 临时安装树
../*.deb                    最终包
GitHub Release / APT repo   发布管理
```

## 10. 用一条命令模拟 Radxa 的核心内核编译

在 Radxa 仓库里，`make deb` 包含外层 debhelper。如果只看内核本体，核心等价于：

```sh
make pre_build
make -C src -j$(nproc) \
  ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- \
  BSP_TOP=bsp/ LICHEE_KERN_DIR=./ KBUILD_DEFCONFIG=bsp.config \
  KDEB_COMPRESS=xz KDEB_CHANGELOG_DIST=unstable \
  LOCALVERSION=-21-a733 KERNELRELEASE=5.15.147-21-a733 KDEB_PKGVERSION=5.15.147-21 \
  defconfig radxa.config radxa_custom.config
make -C src -j$(nproc) ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- all
make -C src -j$(nproc) ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- bindeb-pkg
```

官方 SDK 对应的核心则近似：

```sh
./build.sh config
./build.sh kernel
./build.sh pack
```

但 `./build.sh kernel` 内部会走：

```text
prepare_toolchain
prepare_mkkernel
build/mkkernel.sh kernel
  -> kernel_build
  -> output_build
  -> bootimg_build
```

而 Radxa 不生成 `boot.img/rootfs.ext4/pack_out`，它生成的是 Debian kernel packages。

## 11. 对你当前工作区的直接启发

如果你想把当前官方 SDK 改成 Radxa 风格，不是主要改驱动，而是补一层 packaging/拼接规则：

1. 顶层引入 `src`/`bsp`/`device-a733` 三个目录概念，或在当前 tree 中模拟这些路径。
2. 用 Makefile target 替代 `bsp.sh setup`，创建 `src/bsp`。
3. 把 `board.dts` 转成标准 `arch/arm64/boot/dts/allwinner/<board>.dts` 路径。
4. 把 `bsp/configs/linux-5.15/*.dtsi` 与 `bsp/include/dt-bindings` 放到内核 dtbs 可搜索路径。
5. 用 `bsp_defconfig + radxa.config + radxa_custom.config` 替代板级完整 defconfig。
6. 改 `scripts/package/builddeb`，确保 `linux-headers` 包含 `bsp/include`。
7. 用 `KERNELRELEASE=<version>-a733` 固定 ABI 目录与 Debian 包名。

如果你想在官方 SDK 中保持现有固件产物，就不要照搬 Radxa 的 `bindeb-pkg` 作为主流程；可以把 `.deb` 构建作为旁路目标，否则会绕开 SDK 的 `boot.img/rootfs/pack` 管理。

## 12. Radxa 对官方 SDK 各阶段的等价替换

这一节把两边的“同一件事”按源码阶段对齐。这样看会更清楚：Radxa 不是重写了内核构建逻辑，而是把官方 SDK 的环境准备步骤压缩成了少量 Makefile target。

### 12.1 配置解析阶段

官方 SDK：

```text
./build.sh config/autoconfig
  -> parse_boardconfig
  -> init_global_variable
  -> save_config_to_buildconfig
  -> .buildconfig
```

关键变量来自 `BoardConfig.mk`，然后固化到 `.buildconfig`。后续所有构建脚本都从 `.buildconfig` 读：

```sh
LICHEE_KERN_DIR
LICHEE_BSP_DIR
LICHEE_BOARD_CONFIG_DIR
LICHEE_KERN_DEFCONF_ABSOLUTE
LICHEE_PLAT_OUT
LICHEE_PACK_OUT_DIR
```

Radxa：

```text
make deb
  -> debuild
  -> dpkg-source/quilt 应用 debian/patches
  -> make build
  -> Makefile.extra + Makefile.local
```

Radxa 没有 `.buildconfig` 这个中心状态文件，而是把必要信息拆到：

```text
Makefile.extra:
  ARCH
  CROSS_COMPILE
  KERNEL_FORK
  KERNELRELEASE
  KDEB_PKGVERSION

.github/local/Makefile.local:
  BSP_TOP
  LICHEE_KERN_DIR
  KBUILD_DEFCONFIG
  KERNEL_DEFCONFIG
  pre_build 拼接规则
```

源码对应：

- 官方：`build/mkcmd.sh:1196` 到 `build/mkcmd.sh:1305`
- Radxa：`/tmp/radxa-linux-a733/Makefile.extra:5` 到 `Makefile.extra:20`
- Radxa：`/tmp/radxa-linux-a733/.github/local/Makefile.local:1` 到 `Makefile.local:14`

### 12.2 BSP 接入阶段

官方 SDK：

```text
prepare_mkkernel
  -> bsp_action setup
  -> build/bsp.sh setup
  -> kernel/linux-5.15/bsp -> ../../bsp
```

Radxa：

```text
pre_build
  -> src/bsp
  -> src/bsp -> ../bsp
```

两边最后得到的 Kbuild 视图几乎一样：

```text
<kernel-root>/bsp/Kconfig
<kernel-root>/bsp/Makefile
<kernel-root>/bsp/drivers
<kernel-root>/bsp/include
```

这解释了为什么 Radxa 不需要大规模修改 BSP Kbuild。只要 `src` 根目录下能看到 `bsp/`，`src/Makefile` 中已有的 `source "bsp/Kconfig"`、`drivers-y += bsp/`、`-I$(srctree)/bsp/include` 就会继续生效。

### 12.3 defconfig 阶段

官方 SDK：

```text
BoardConfig.mk
  -> LICHEE_KERN_DEFCONF=cubie_a7a_defconfig
  -> LICHEE_KERN_DEFCONF_RELATIVE=../../../../../device/config/...
  -> make defconfig KBUILD_DEFCONFIG=<relative board defconfig>
```

Radxa：

```text
pre_build
  -> src/arch/arm64/configs/bsp.config
  -> device-a733/configs/default/linux-5.15/bsp_defconfig

build-defconfig
  -> make -C src defconfig radxa.config radxa_custom.config
```

差异点：

- 官方 SDK 偏向“板级完整 defconfig”，例如 `cubie_a7a_defconfig`。
- Radxa 偏向“统一 BSP defconfig + 发行版 fragment”，也就是 `bsp.config + radxa.config + radxa_custom.config`。

这个策略让 A7A/A7S/A7Z 共享更多内核配置，板级差异主要放到 DTS 和 overlay/DKMS 层。

### 12.4 DTS 阶段

官方 SDK 独立 BSP 模式：

```text
device/config/chips/a733/configs/cubie_a7a/linux-5.15/board.dts
  + bsp/configs/linux-5.15/sun60iw2p1.dtsi
  + cpp -I kernel/include -I kernel/bsp/include -I bsp/configs/linux-5.15
  + dtc
  -> out/a733/kernel/staging/sunxi.dtb
  -> out/a733/cubie_a7a/debian/sunxi.dtb
```

Radxa：

```text
device-a733/configs/cubie_a7a/linux-5.15/board.dts
  -> src/arch/arm64/boot/dts/allwinner/sun60i-a733-cubie-a7a.dts
  + copy bsp/configs/linux-5.15/*.dtsi into dts/allwinner
  + copy bsp/include/dt-bindings into src/include/dt-bindings
  -> make dtbs
  -> dtbs_install
  -> linux-image deb 内的 /usr/lib/linux-image-<version>/allwinner/*.dtb
```

这个差异很关键。官方 SDK 的板级 DTB 名字固定成 `sunxi.dtb`，并塞进 `boot.img`；Radxa 则使用 Linux 标准多板 DTB 安装模式，包内可以同时包含 A7A/A7S/A7Z 的 DTB。

### 12.5 ramfs/initramfs 阶段

官方 SDK：

```text
prepare_tar_ramfs
output_build
bootimg_build
```

官方 SDK 会把 `bsp/ramfs/ramfs_aarch64.cpio.gz` 作为 boot image 的候选 ramdisk。若 `LICHEE_NO_RAMDISK_NEEDED=y`，则 `bootimg_build` 不带 ramdisk。

Radxa：

```text
Makefile.local:
  bsp/ramfs/ramfs_aarch64.cpio.gz:
      cd bsp/ramfs/ramfs_aarch64 && find . | fakeroot cpio ...
```

Radxa 生成这个 cpio.gz 更像是满足 BSP/kernel 构建环境期望。真正系统启动时的 initramfs 通常由 Debian/RadxaOS 的内核安装 hooks、initramfs-tools 或镜像构建系统处理，而不是这个 `linux-a733` 包工程自己打 `boot.img`。

### 12.6 输出收拢阶段

官方 SDK：

```text
Kbuild O=out/a733/kernel/build
  -> out/a733/kernel/staging
  -> out/a733/<board>/<linuxdev>
```

Radxa：

```text
src/
  -> src/debian/linux-image
  -> src/debian/linux-headers
  -> src/debian/linux-libc-dev
  -> ../*.deb
```

官方 SDK 的 `output_build` 是 SDK 自己的 staging 管理；Radxa 则直接复用 Linux `scripts/package/builddeb` 的临时安装树。

### 12.7 pack/发布阶段

官方 SDK：

```text
./build.sh pack
  -> build/pack
  -> boot.fex/rootfs.fex/rootfs-ubifs.fex/boot_package.fex
  -> dragon image.cfg sys_partition.fex
  -> out/<image>.img
```

Radxa：

```text
make deb
  -> ../*.deb
  -> GitHub Actions upload artifacts
  -> GitHub Release
  -> APT repo
```

所以 Radxa 的“最终交付物”不是烧录镜像，而是可被 RSDK/RadxaOS 镜像构建器或已安装系统消费的包。

## 13. `.deb` 包内文件布局推导

从 `/tmp/radxa-linux-a733/src/scripts/package/builddeb` 可以推导真实内核包的安装布局。

### 13.1 `linux-image-<version>-a733`

`version=$KERNELRELEASE`，所以以 `5.15.147-21` 为例，实际版本目录是：

```text
5.15.147-21-a733
```

包名：

```text
linux-image-5.15.147-21-a733
```

包内关键文件：

```text
/boot/vmlinuz-5.15.147-21-a733
/boot/System.map-5.15.147-21-a733
/boot/config-5.15.147-21-a733
/lib/modules/5.15.147-21-a733/*.ko
/lib/modules/5.15.147-21-a733/modules.*
/usr/lib/linux-image-5.15.147-21-a733/allwinner/sun60i-a733-cubie-a7a.dtb
/usr/lib/linux-image-5.15.147-21-a733/allwinner/sun60i-a733-cubie-a7s.dtb
/usr/lib/linux-image-5.15.147-21-a733/allwinner/sun60i-a733-cubie-a7z.dtb
```

DTB 路径里的 `allwinner/` 来自 `scripts/Makefile.dtbinst` 的递归安装规则：子目录会保留下来。

### 13.2 `linux-headers-<version>-a733`

包名：

```text
linux-headers-5.15.147-21-a733
```

包内关键文件：

```text
/usr/src/linux-headers-5.15.147-21-a733/.config
/usr/src/linux-headers-5.15.147-21-a733/Makefile
/usr/src/linux-headers-5.15.147-21-a733/include
/usr/src/linux-headers-5.15.147-21-a733/scripts
/usr/src/linux-headers-5.15.147-21-a733/bsp/include
/lib/modules/5.15.147-21-a733/build -> /usr/src/linux-headers-5.15.147-21-a733
```

这里 `bsp/include` 是 Radxa 对 `builddeb` 的补丁点。如果不带它，外部模块或 DKMS 编译时包含 `<sunxi-*.h>`、`bsp/include/...` 相关头文件会失败。

### 13.3 `linux-libc-dev` 与 meta 包的一个命名细节

按当前 `src/scripts/package/builddeb` 源码，libc headers 的真实包名仍是：

```text
linux-libc-dev
```

而顶层 `debian/control` 里 meta 包写的是：

```text
linux-libc-dev-radxa-cubie-a7a
  Depends: linux-libc-dev-${binary:Version}-a733
```

从本仓库源码直接看，`linux-image-*` 和 `linux-headers-*` 的真实包名能自然匹配 `-a733` 后缀；`linux-libc-dev` 这一项则不像 image/headers 那样由 `KERNELRELEASE` 拼进包名。实际发布仓库可能用外部仓库布局或历史兼容包解决这个依赖，但仅从 `linux-a733` 源码看，这是一个需要单独核对的命名点。

对内核构建主流程影响不大，因为 image/headers 才是启动和 DKMS 最核心的包；但如果你要复刻 Radxa 的 APT 发布结构，这个细节要验证。

## 14. Radxa 为什么不生成 `boot.img`

官方 SDK 的启动链路偏 Android/Allwinner 固件风格：

```text
bootloader/uboot
  -> boot.img
       kernel=bImage/Image
       dtb=sunxi.dtb
       optional ramdisk
  -> rootfs 分区
```

所以官方 SDK 必须在 kernel 阶段之后生成 `boot.img`，pack 阶段再把它链接成 `boot.fex`。

RadxaOS/Debian 的启动链路更接近发行版风格：

```text
kernel package 安装 /boot/vmlinuz-<version>
kernel package 安装 /usr/lib/linux-image-<version>/*.dtb
postinst hooks / image builder / bootloader package 决定如何复制或引用内核和 DTB
```

`device-a733/boot-resource/extlinux/extlinux.conf` 里可以看到一种板级启动配置：

```text
kernel /extlinux/Image
devicetree /extlinux/sunxi.dtb
```

但 `linux-a733` 本身没有把 `vmlinuz` 重命名成 `/extlinux/Image`、也没有把具体板级 DTB 重命名成 `/extlinux/sunxi.dtb`。这通常是镜像构建系统、bootloader 资源包或安装 hooks 的责任。

因此，Radxa 的 kernel package 更像“提供内核原材料”，不是“直接产出 Allwinner 固件启动分区”。

## 15. `debian/patches` 在 Radxa 流程中的时机

Radxa 的 `debian/source/format` 是：

```text
3.0 (quilt)
```

补丁列表：

```text
linux/0001-feat-Radxa-common-kernel-config.patch
linux/0002-feat-Radxa-custom-kernel-config.patch
linux/0003-fix-use-the-correct-header-path.patch
linux/0004-fix-add-device-tree.patch
```

这带来一个容易忽略的点：

```text
make deb
  -> debuild
  -> dpkg-source --before-build
  -> 应用 debian/patches
  -> debhelper 调用 make build
```

也就是说，`radxa.config`、`radxa_custom.config`、DTS Makefile 里的 A7A/A7S/A7Z 条目，都是 Debian build 前由 quilt patch 应用进去的。

如果你在 Radxa 仓库里直接跑：

```sh
make build
```

而不是：

```sh
make deb
```

那可能会遇到 `radxa.config` 或 `radxa_custom.config` 不存在、DTB target 不存在等问题，除非你已经手动 `quilt push -a` 或 `dpkg-source --before-build .`。这也是为什么 Radxa 文档推荐的是 `make deb`，不是裸 `make build`。

## 16. 迁移到当前 SDK 时最容易踩的点

### 16.1 不能只复制 `Makefile.local`

`Makefile.local` 只是拼接层，真正依赖还有：

```text
debian/patches/linux/0001...
debian/patches/linux/0002...
debian/patches/linux/0003...
debian/patches/linux/0004...
src/scripts/package/builddeb 的 bsp/include 改动
device-a733/configs/default/linux-5.15/bsp_defconfig
device-a733/configs/<board>/linux-5.15/board.dts
bsp/configs/linux-5.15/*.dtsi
bsp/include/dt-bindings
```

缺任何一块，`make -C src all` 都可能能编过一部分，但最终 headers、DTB 或模块安装会出问题。

### 16.2 DTS include 路径不能混用

官方 SDK 的 `board.dts` 可以依赖外部 `cpp -I ${LICHEE_BSP_DIR}/configs/${LICHEE_KERN_VER}`。

Radxa 的 `board.dts` 进入标准 Kbuild 后，就要满足内核 dtbs 的 include 搜索习惯。Radxa 的解决方法是复制：

```text
bsp/configs/linux-5.15/*.dtsi -> src/arch/arm64/boot/dts/allwinner/
bsp/include/dt-bindings/.     -> src/include/dt-bindings/
```

如果只建立 DTS symlink，而不复制 dtsi/dt-bindings，dtc 会找不到 include。

### 16.3 `sunxi.dtb` 与标准 DTB 名称的转换边界

官方 SDK 的下游脚本默认关心：

```text
sunxi.dtb
boot.img
boot.fex
```

Radxa kernel package 默认给的是：

```text
sun60i-a733-cubie-a7a.dtb
sun60i-a733-cubie-a7s.dtb
sun60i-a733-cubie-a7z.dtb
```

如果把 Radxa 编出来的 `.deb` 用回官方 SDK 的 `pack`，中间必须增加“选择板级 DTB 并重命名/复制为 `sunxi.dtb` 或重新生成 `boot.img`”这一步。

### 16.4 `KERNELRELEASE` 会改变模块 ABI 目录

官方 SDK 当前输出的模块目录通常来自 `UTS_RELEASE`，例如类似：

```text
/lib/modules/5.15.147
```

Radxa 强制：

```text
KERNELRELEASE=5.15.147-21-a733
```

因此模块目录变成：

```text
/lib/modules/5.15.147-21-a733
```

如果 rootfs、initramfs、DKMS、depmod 或 boot scripts 仍然按官方 SDK 的目录找模块，就会找不到。

### 16.5 `LOCALVERSION=""` 与 Radxa 固定 ABI 的差异

官方 SDK 在 `kernel_build` 里：

```sh
export LOCALVERSION=""
```

目的是避免 Git dirty 状态导致内核版本后面自动追加 `+`。

Radxa 则反过来明确把 Debian revision 放进 ABI：

```make
LOCALVERSION=-21-a733
KERNELRELEASE=5.15.147-21-a733
```

这对 APT 升级很重要：每次发布一个新 `debian/changelog` 版本，包名/模块目录/headers 目录都能稳定对应。

## 17. 一个更精确的源码调用图

官方 SDK：

```text
build.sh
└── build/mkcommon.sh
    ├── config/autoconfig
    │   └── build/mkcmd.sh:mk_config
    │       ├── parse_boardconfig
    │       ├── init_global_variable
    │       ├── bsp_action setup
    │       ├── init_defconf
    │       └── save_config_to_buildconfig
    ├── kernel
    │   └── build/mkcmd.sh:build_kernel
    │       ├── prepare_toolchain
    │       ├── prepare_mkkernel
    │       │   ├── bsp_action setup
    │       │   └── board_dts_create_link
    │       └── build/mkkernel.sh kernel
    │           ├── build_setup
    │           ├── kernel_build
    │           ├── output_build
    │           │   └── dts_build false
    │           └── bootimg_build
    └── pack
        └── build/mkcmd.sh:mk_pack
            └── build/pack
                ├── do_pack_linux
                └── dragon image.cfg sys_partition.fex
```

Radxa：

```text
make deb
└── Makefile:debuild
    └── debuild -b
        ├── dpkg-source/quilt applies debian/patches
        └── debhelper
            └── make build
                ├── pre_build
                │   ├── src/bsp symlink
                │   ├── bsp.config symlink
                │   ├── board.dts symlink as sun60i-a733-*.dts
                │   ├── copy *.dtsi
                │   ├── copy dt-bindings
                │   ├── generate ramfs_aarch64.cpio.gz
                │   └── generate sunxi-autogen.h
                ├── build-defconfig
                │   └── make -C src defconfig radxa.config radxa_custom.config
                └── build-bindeb
                    ├── make -C src all
                    ├── make -C src bindeb-pkg
                    │   ├── scripts/package/mkdebian
                    │   └── scripts/package/builddeb
                    └── mv linux-*_arm64.deb ../
```

这张图基本就是两套工程的本质区别：官方 SDK 把 kernel 当固件流水线的一环，Radxa 把 kernel 当 Debian 包流水线的一环。
