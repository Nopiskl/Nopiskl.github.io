# Allwinner Buildroot Recovery Analysis

本文基于当前 A733 `x733mhn_aic8800` Buildroot 配置，整理全志 Buildroot 正常系统与 recovery 系统的构建、启动、init 选择和 SWUpdate 流程。

重点结论：

- `buildroot/config/buildroot/busybox/init` 和 `buildroot/config/buildroot/busybox/rdinit` 都不是 BusyBox 的 C 语言 init 程序，而是全志放进 initramfs 顶层 `/init` 的 shell 脚本。
- 真正的 BusyBox init 是 Buildroot 编译 BusyBox 后提供的 `/sbin/init` applet，配合 `/etc/inittab` 和 `/etc/init.d/rcS` 工作。
- 当前 A733 正常 Buildroot 系统不使用 initramfs 过渡启动，因为 `LICHEE_NO_RAMDISK_NEEDED:=y`。
- 当前 A733 recovery 系统强制使用 ramdisk/initramfs，顶层 `/init` 来自 `busybox/rdinit`。
- recovery 系统主要运行 `swupdate-progress`、`swupdate_cmd.sh` 和 `swupdate`，用于执行 OTA 升级。

## 1. 板级构建入口

当前板级 Buildroot 配置位于：

```text
device/config/chips/a733/configs/x733mhn_aic8800/buildroot/BoardConfig.mk
```

关键内容：

```make
LICHEE_BUILDING_SYSTEM:=buildroot
LICHEE_BR_VER:=202205
LICHEE_BR_DEFCONF:=sun60iw2p1_x733_defconfig
LICHEE_KERN_DEFCONF:=bsp_defconfig
LICHEE_NO_RAMDISK_NEEDED:=y
LICHEE_KERN_DEFCONF_RECOVERY:=bsp_recovery_defconfig
LICHEE_BR_RAMFS_CONF:=sun60iw2p1_recovery_ramfs_defconfig
```

含义如下：

- 正常 Buildroot rootfs 使用 `sun60iw2p1_x733_defconfig`。
- 正常 kernel 使用 `bsp_defconfig`。
- 正常 boot 不需要 ramdisk：`LICHEE_NO_RAMDISK_NEEDED:=y`。
- recovery kernel 使用 `bsp_recovery_defconfig`。
- recovery ramfs 使用 `sun60iw2p1_recovery_ramfs_defconfig`。

## 2. 构建时如何选择 init 或 rdinit

构建时并不是运行时自动判断 `init` 或 `rdinit`，而是由 Buildroot defconfig 里的 `BR2_ROOTFS_POST_BUILD_SCRIPT` 直接决定。

### 2.1 正常系统 defconfig

文件：

```text
buildroot/buildroot-202205/configs/sun60iw2p1_x733_defconfig
```

关键片段：

```make
BR2_aarch64=y
BR2_cortex_a76=y
BR2_TOOLCHAIN_EXTERNAL=y
BR2_TARGET_GENERIC_HOSTNAME="Longan"
BR2_TARGET_GENERIC_ISSUE="Welcome to Allwinner Longan Platform"
BR2_ROOTFS_DEVICE_CREATION_DYNAMIC_EUDEV=y
BR2_SYSTEM_BIN_SH_BASH=y
# BR2_TARGET_GENERIC_GETTY is not set
BR2_ROOTFS_OVERLAY="../../target/common/overlay ../../target/$(LICHEE_IC)/common/overlay ../../target/$(LICHEE_IC)/buildroot/common/overlay ../../target/$(LICHEE_IC)/buildroot/$(LICHEE_BOARD)/overlay"
BR2_ROOTFS_POST_BUILD_SCRIPT="$(TOPDIR)/../config/buildroot/post_build.sh"
```

正常 rootfs 的 post-build 脚本是：

```text
buildroot/config/buildroot/post_build.sh
```

它主要修改 `/etc/inittab`，插入 `/etc/preinit`，并处理串口 getty/shell：

```sh
add_preinit_to_inittab(){
	if [ -e ${TARGET_DIR}/etc/inittab ]; then
		#insert preinit
		grep "::sysinit:/etc/preinit" ${TARGET_DIR}/etc/inittab >/dev/null
		if [ $? -eq 0 ]; then
			echo "preinit is already in inittab!"
		else
			echo "preinit is not in inittab, add it!"
			sed -i '/Startup the system/a ::sysinit:/etc/preinit' ${TARGET_DIR}/etc/inittab
		fi

		local getty_enable=$(grep "BR2_TARGET_GENERIC_GETTY=y" ${BR2_CONFIG})
		echo "getty_enable:${getty_enable}"
		if [ x"${getty_enable}" != x"" ]; then
			echo "getty is already commented by package/sysvinit"
			echo "tips: BR2_TARGET_GENERIC_GETTY_PORT should be console"
			sed -i '/::respawn:-\/bin\/sh/d' ${TARGET_DIR}/etc/inittab
			return 0
		fi

		echo "BR2_TARGET_GENERIC_GETTY is not set"
		sed -i "s/.*\(# GENERIC_SERIAL\)/\1/" ${TARGET_DIR}/etc/inittab
	fi
}

add_preinit_to_inittab
```

注意：`post_build.sh` 不会拷贝 `buildroot/config/buildroot/busybox/init`，也不会拷贝 `rdinit`。它面向的是正常 rootfs，不是 recovery ramfs。

### 2.2 Recovery ramfs defconfig

文件：

```text
buildroot/buildroot-202205/configs/sun60iw2p1_recovery_ramfs_defconfig
```

关键片段：

```make
BR2_aarch64=y
BR2_TOOLCHAIN_EXTERNAL=y
BR2_TARGET_GENERIC_HOSTNAME="Longan"
BR2_TARGET_GENERIC_ISSUE="Welcome to Allwinner Longan Platform"
BR2_ROOTFS_DEVICE_CREATION_DYNAMIC_EUDEV=y
BR2_SYSTEM_BIN_SH_BASH=y
BR2_TARGET_GENERIC_GETTY_PORT="ttyS0"
BR2_TARGET_GENERIC_GETTY_BAUDRATE_115200=y
BR2_ROOTFS_OVERLAY="../../target/common/overlay ../../target/$(LICHEE_IC)/common/overlay ../../target/$(LICHEE_IC)/buildroot/common/overlay ../../target/$(LICHEE_IC)/buildroot/$(LICHEE_BOARD)/overlay"
BR2_ROOTFS_POST_BUILD_SCRIPT="$(TOPDIR)/../config/buildroot/post_rdinit.sh"
BR2_PACKAGE_BUSYBOX_INIT_BASE_FILES=y
BR2_PACKAGE_OTA_BURNBOOT=y
BR2_PACKAGE_DOSFSTOOLS=y
BR2_PACKAGE_DOSFSTOOLS_MKFS_FAT=y
BR2_PACKAGE_EXFAT=y
BR2_PACKAGE_EXFAT_UTILS=y
BR2_PACKAGE_MTD=y
BR2_PACKAGE_MTD_MKFSJFFS2=y
BR2_PACKAGE_NTFS_3G=y
BR2_PACKAGE_NTFS_3G_ENCRYPTED=y
BR2_PACKAGE_NTFS_3G_NTFSPROGS=y
BR2_PACKAGE_SQUASHFS=y
BR2_PACKAGE_MESA3D=y
BR2_PACKAGE_UBOOT_TOOLS=y
BR2_PACKAGE_LIBCONFIG=y
BR2_PACKAGE_SWUPDATE=y
SWUPDATE_CONFIG_MTD=y
SWUPDATE_CONFIG_UBIVOL=y
BR2_TARGET_ROOTFS_CPIO=y
BR2_TARGET_ROOTFS_CPIO_GZIP=y
```

recovery ramfs 的 post-build 脚本是：

```text
buildroot/config/buildroot/post_rdinit.sh
```

源码片段：

```sh
#!/bin/bash

pwd=`cd $(dirname $0);pwd -P`

add_init_to_ramfs()
{
	rm -rf ${TARGET_DIR}/init
	cp -f ${pwd}/busybox/rdinit ${TARGET_DIR}/init
}

add_init_to_ramfs
```

因此 recovery ramfs 顶层 `/init` 明确来自：

```text
buildroot/config/buildroot/busybox/rdinit
```

### 2.3 post_init.sh 是另一套旧/可选路径

文件：

```text
buildroot/config/buildroot/post_init.sh
```

源码片段：

```sh
#!/bin/bash

pwd=`cd $(dirname $0);pwd -P`

add_init_to_ramfs()
{
	if [ -L ${TARGET_DIR}/init ]; then
		rm ${TARGET_DIR}/init
		cp -f ${pwd}/busybox/init ${TARGET_DIR}/init
	else
		cp -f ${pwd}/busybox/init ${TARGET_DIR}/init
	fi
}

add_init_to_ramfs
```

如果某个平台 defconfig 使用：

```make
BR2_ROOTFS_POST_BUILD_SCRIPT="$(TOPDIR)/../config/buildroot/post_init.sh"
```

那么 ramfs 顶层 `/init` 会来自：

```text
buildroot/config/buildroot/busybox/init
```

但当前 A733 `x733mhn_aic8800` 正常系统和 recovery 都没有使用 `post_init.sh`。

## 3. Buildroot 原生 BusyBox init

Buildroot 原生的 init 系统选择在：

```text
buildroot/buildroot-202205/system/Config.in
```

源码片段：

```kconfig
choice
	prompt "Init system"
	default BR2_INIT_BUSYBOX

config BR2_INIT_BUSYBOX
	bool "BusyBox"
	select BR2_PACKAGE_BUSYBOX
	select BR2_PACKAGE_INITSCRIPTS
	select BR2_PACKAGE_SKELETON_INIT_SYSV if BR2_ROOTFS_SKELETON_DEFAULT

config BR2_INIT_SYSV
	bool "systemV"
	depends on BR2_USE_MMU # sysvinit
	select BR2_PACKAGE_BUSYBOX_SHOW_OTHERS # sysvinit
	select BR2_PACKAGE_INITSCRIPTS
	select BR2_PACKAGE_SYSVINIT
```

当前 defconfig 没有显式选择 systemd/sysvinit/openrc，所以默认是 BusyBox init。

BusyBox 包里会打开 `CONFIG_INIT`，文件：

```text
buildroot/buildroot-202205/package/busybox/busybox.mk
```

源码片段：

```make
ifeq ($(BR2_INIT_BUSYBOX),y)

define BUSYBOX_SET_INIT
	$(call KCONFIG_ENABLE_OPT,CONFIG_INIT)
endef

ifeq ($(BR2_TARGET_GENERIC_GETTY),y)
define BUSYBOX_SET_GETTY
	$(SED) '/# GENERIC_SERIAL$$/s~^.*#~$(SYSTEM_GETTY_PORT)::respawn:/sbin/getty -L $(SYSTEM_GETTY_OPTIONS) $(SYSTEM_GETTY_PORT) $(SYSTEM_GETTY_BAUDRATE) $(SYSTEM_GETTY_TERM) #~' \
		$(TARGET_DIR)/etc/inittab
endef
else
define BUSYBOX_SET_GETTY
	$(SED) '/# GENERIC_SERIAL$$/s~^.*#~#ttyS0::respawn:/sbin/getty -L ttyS0 115200 vt100 #~' $(TARGET_DIR)/etc/inittab
endef
endif # BR2_TARGET_GENERIC_GETTY

BUSYBOX_TARGET_FINALIZE_HOOKS += BUSYBOX_SET_GETTY
BUSYBOX_TARGET_FINALIZE_HOOKS += SYSTEM_REMOUNT_ROOT_INITTAB

endif # BR2_INIT_BUSYBOX
```

并安装 `/etc/inittab`：

```make
ifeq ($(BR2_INIT_BUSYBOX),y)
define BUSYBOX_INSTALL_INITTAB
	if test ! -e $(TARGET_DIR)/etc/inittab; then \
		$(INSTALL) -D -m 0644 package/busybox/inittab $(TARGET_DIR)/etc/inittab; \
	fi
endef
endif
```

因此需要区分：

```text
Buildroot/BusyBox 原生 init:
  /sbin/init
  /etc/inittab
  /etc/init.d/rcS

全志额外 ramfs 顶层 init 脚本:
  buildroot/config/buildroot/busybox/init
  buildroot/config/buildroot/busybox/rdinit
```

## 4. 正常 Buildroot 是否先加载 initramfs

对当前 A733 `x733mhn_aic8800/buildroot` 来说，正常系统不是先加载 initramfs 再切到 rootfs。

原因是 `BoardConfig.mk` 中有：

```make
LICHEE_NO_RAMDISK_NEEDED:=y
```

ramdisk 是否使用由以下函数判断，文件：

```text
build/mkkernel.sh
```

源码片段：

```sh
# check whether use ramdisk from BoardConfig.mk
# If don't want to use ramdisk,please add LICHEE_NO_RAMDISK_NEEDED=y to BoardConfig.mk
# return 0 when use ramdisk otherwise return 1
function check_whether_use_ramdisk()
{
    if [ "$LICHEE_NO_RAMDISK_NEEDED" != "y" -o "$LICHEE_KERN_SYSTEM" == "kernel_recovery" ]; then
        return 0;
    else
        return 1;
    fi
}
```

解释：

```text
正常 boot:
  LICHEE_NO_RAMDISK_NEEDED=y
  LICHEE_KERN_SYSTEM 不是 kernel_recovery
  => 不使用 ramdisk

recovery boot:
  LICHEE_KERN_SYSTEM=kernel_recovery
  => 强制使用 ramdisk
```

boot/recovery 镜像打包处：

```sh
if [ "${LICHEE_KERN_SYSTEM}" = "kernel_recovery" ]; then
    IMAGE_NAME="recovery.img"
else
    IMAGE_NAME="boot.img"
fi

${MKBOOTIMG} --kernel ${BIMAGE} \
    $(check_whether_use_ramdisk && echo "--ramdisk $RAMDISK") \
    --board ${CHIP}_${LICHEE_ARCH} \
    --base ${BASE} \
    --kernel_offset ${KERNEL_OFFSET} \
    $(check_whether_use_ramdisk && echo "--ramdisk_offset ${RAMDISK_OFFSET}") \
    --dtb ${DTB} \
    --dtb_offset ${DTB_OFFSET} \
    --header_version 2 \
    -o $STAGING_DIR/${IMAGE_NAME}
```

`mkrecovery()` 会设置 `LICHEE_KERN_SYSTEM=kernel_recovery`，文件：

```text
build/mkcmd.sh
```

源码片段：

```sh
function mkrecovery()
{
	mk_info "build recovery ..."

	local build_script="scripts/build.sh"

	LICHEE_KERN_SYSTEM="kernel_recovery"

	prepare_toolchain
	prepare_mkkernel

	(cd ${KERNEL_BUILD_SCRIPT_DIR} && [ -x ${KERNEL_BUILD_SCRIPT} ] && ./${KERNEL_BUILD_SCRIPT} $@)
}
```

所以 recovery 即使板级配置写了 `LICHEE_NO_RAMDISK_NEEDED:=y`，仍然会带 ramdisk。

## 5. 正常 Buildroot 启动路径

正常系统启动参数在：

```text
device/config/chips/a733/configs/x733mhn_aic8800/buildroot/env.cfg
```

关键片段：

```sh
#kernel command arguments
earlyprintk=sunxi-uart,0x02500000
initcall_debug=0
console=ttyS0,115200
nand_root=/dev/nand0p4
mmc_root=/dev/mmcblk1p4
ufs_root=/dev/sda4
init=/init
loglevel=8
selinux=0
cma=8M
boot_partition=boot
root_partition=rootfs

setargs_mmc=setenv  bootargs earlyprintk=${earlyprintk} initcall_debug=${initcall_debug} console=${console} loglevel=${loglevel} root=${mmc_root}  init=${init} partitions=${partitions} cma=${cma} snum=${snum} mac_addr=${mac} wifi_mac=${wifi_mac} bt_mac=${bt_mac} selinux=${selinux} specialstr=${specialstr} gpt=1 arm-smmu-v3.disable_bypass=${arm-smmu-v3}

boot_normal=sunxi_flash read 4007f800 ${boot_partition};bootm 0x4007f800
```

当前正常启动路径：

```text
U-Boot
  -> sunxi_flash read boot 分区
  -> bootm boot.img
  -> boot.img 只有 kernel + dtb，不带 ramdisk
  -> kernel 按 bootargs root=/dev/mmcblk1p4 挂载真实 rootfs
  -> kernel 执行 init=/init
  -> 进入正常 Buildroot 用户空间
```

注意：这里的 `init=/init` 指向的是真实 rootfs 里的 `/init`，不是 recovery ramfs 里的 `/init`。

## 6. Recovery 启动路径

recovery ramfs 由 Buildroot 单独构建。Buildroot 构建 ramfs 的入口在：

```text
buildroot/buildroot-202205/build.sh
```

源码片段：

```sh
LICHEE_BR_RAMFS_OUT=${LICHEE_PLAT_OUT}/ramfs

build_ramfs()
{
    local config=$1

    if [ ! -d ${LICHEE_BR_RAMFS_OUT} ]; then
        mkdir ${LICHEE_BR_RAMFS_OUT}
    fi

    if [ "x" = "x${config}" ]; then
        if [ "x" != "x${LICHEE_BR_RAMFS_CONF}" ]; then
            config=${LICHEE_BR_RAMFS_CONF}
        else
            echo "ramfs config not found"
            return
        fi
    fi

    if [ ! -f ${LICHEE_BR_RAMFS_OUT}/.config ] ; then
        printf "\nUsing default config ...${config}\n\n"
        make O=${LICHEE_BR_RAMFS_OUT} ${config}
    fi

    make O=${LICHEE_BR_RAMFS_OUT}
}
```

全志 SWUpdate recovery 镜像构建入口在：

```text
build/buildbase.sh
```

源码片段：

```sh
function make_buildroot_recovery_cpio()
{
	local LICHEE_PLAT_OUT=$(cat ${TINA_TOPDIR}/.buildconfig | sed -n 's/^.*LICHEE_PLAT_OUT=\(.*\)$/\1/g'p)

	local ramdisk="${LICHEE_PLAT_OUT}/ramfs/images/rootfs.cpio.gz"
	echo "ramdisk:${ramdisk}"

	local br_ota_def=$(cat ${TINA_TOPDIR}/.buildconfig | sed -n 's/^.*LICHEE_BR_RAMFS_CONF=\(.*\)$/\1/g'p)
	local br_out_dir=$(cat ${TINA_TOPDIR}/.buildconfig | sed -n 's/^.*LICHEE_BR_OUT=\(.*\)$/\1/g'p)

	if [ x"${br_ota_def}" = x"" ]; then
		print_red "should define LICHEE_BR_RAMFS_CONF in Boardconfig.mk"
		print_red "such as: LICHEE_BR_RAMFS_CONF=sunxi_recovery_ramfs_defconfig"
		return 1
	fi

	mkdir -p ${br_out_dir}/ramfs
	${TINA_TOPDIR}/build.sh buildroot_rootfs ramfs
}
```

recovery 镜像构建函数：

```sh
function swupdate_make_recovery_img()
{
	local LICHEE_LINUX_DEV=$(cat ${TINA_TOPDIR}/.buildconfig | sed -n 's/^.*LICHEE_LINUX_DEV=\(.*\)$/\1/g'p)
	if [ x"${LICHEE_LINUX_DEV}" = x"openwrt" ]; then
		make_openwrt_recovery_img $@
	fi

	if [ x"${LICHEE_LINUX_DEV}" = x"buildroot" ]; then
		make_buildroot_recovery_cpio $@
	fi

	${TINA_TOPDIR}/build.sh recovery
}
```

recovery 启动路径：

```text
U-Boot
  -> 读 recovery 分区里的 recovery.img
  -> recovery.img 带 kernel + dtb + ramdisk
  -> kernel 解开 ramdisk
  -> 执行 ramdisk 顶层 /init
  -> /init 来自 buildroot/config/buildroot/busybox/rdinit
  -> rdinit 执行 /etc/init.d/rcS
  -> rcS 执行 S99swupdate_autorun
  -> 启动 swupdate-progress 和 swupdate_cmd.sh
```

## 7. rdinit 做了什么

文件：

```text
buildroot/config/buildroot/busybox/rdinit
```

关键源码片段：

```sh
#!/bin/sh

mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs none /dev

#env use
mkdir -p /var/lock
mkdir -p /run/lock

exec < /dev/console > /dev/console 2>&1

for parm in $(cat /proc/cmdline); do
	case $parm in
	ramfs)
		RAMFS_MODE=1
		;;
	root=*)
		ROOT_DEVICE=`echo $parm | awk -F\= '{print $2}'`
		;;
	esac
done

if [ "x$ROOT_DEVICE" = "x" ]; then
	ROOT_DEVICE=autoconfig
fi
echo [$0]: RootDevice is \"recovery\"
```

它后面虽然保留了挂载真实 rootfs 的函数，但对 `/dev/nand*` 和 `/dev/mmc*` 的直接挂载调用被注释掉：

```sh
case $ROOT_DEVICE in
	/dev/nand*|/dev/system)
##		load_nand
		;;
	/dev/mmc*)
##		load_emmc
		;;
	autoconfig*)
		sleep 1;
        if cat /proc/partitions|grep "mmcblk0p5" >/dev/null;then
            magic_num=$(hexdump -s 1292 -n 2 -x /dev/mmcblk0p5|head -1|awk '{print $2 }')
            if echo $magic_num|grep "f30a" >/dev/null;then
				load_emmc
            fi
        else
			load_nand
		fi
		;;
	*)
		echo [$0]: "Use default type"
		;;
esac
```

最后执行 `/etc/init.d/rcS`，但不 `switch_root`：

```sh
[ -x /etc/init.d/rcS ] && {
	/etc/init.d/rcS
}
##[ -x /mnt/sbin/init ] && exec switch_root /mnt /sbin/init
/sbin/getty -L `cat /proc/cmdline | awk -F ",115200" '{print $1}' | awk -F "console=" '{print $2}'` 115200 vt100 -n -l /bin/ash
```

这说明 recovery 会停留在 ramfs 环境里运行升级逻辑，而不是切换到正常 rootfs。

## 8. busybox/init 做了什么

文件：

```text
buildroot/config/buildroot/busybox/init
```

这个脚本用于“initramfs 先启动，然后切到真实 rootfs”的模式。

关键源码片段：

```sh
#!/bin/sh

mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs none /dev

exec < /dev/console > /dev/console 2>&1

for parm in $(cat /proc/cmdline); do
	case $parm in
	ramfs)
		RAMFS_MODE=1
		;;
	root=*)
		ROOT_DEVICE=`echo $parm | awk -F\= '{print $2}'`
		;;
	esac
done
```

与 `rdinit` 最大区别在最后：

```sh
if [ -f /usr/bin/rootfs_update ]; then
	chmod +x /usr/bin/rootfs_update
	/usr/bin/rootfs_update
fi

[ -x /mnt/sbin/init ] && exec switch_root /mnt /sbin/init
/sbin/getty -L ttyS0 115200 vt100 -n -l /bin/ash
```

即：

```text
busybox/init:
  尝试挂载真实 rootfs 到 /mnt
  如果 /mnt/sbin/init 存在，则 switch_root 到真实 rootfs

busybox/rdinit:
  执行 ramfs 内 /etc/init.d/rcS
  不 switch_root
```

当前 A733 recovery 使用 `rdinit`，当前 A733 正常系统不使用 initramfs，因此也不使用这个 `busybox/init` 路径。

## 9. SWUpdate 在 recovery 中如何运行

SWUpdate 包安装逻辑在：

```text
buildroot/buildroot-202205/package/swupdate/swupdate.mk
```

源码片段：

```make
define SWUPDATE_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/swupdate $(TARGET_DIR)/sbin
	$(INSTALL) -D -m 0755 $(@D)/tools/swupdate-progress $(TARGET_DIR)/sbin
	cp -rf ./package/swupdate/swupdate_cmd.sh $(TARGET_DIR)/sbin
	mkdir -p $(TARGET_DIR)/etc/init.d
	cp -rf ./package/swupdate/swupdate_autorun.init $(TARGET_DIR)/etc/init.d/S99swupdate_autorun
endef
```

启动脚本：

```text
buildroot/buildroot-202205/package/swupdate/swupdate_autorun.init
```

源码片段：

```sh
#!/bin/sh

PROG=/sbin/swupdate_cmd.sh
PROG_PROGRESS=/sbin/swupdate-progress

start_swupdate(){
    $PROG_PROGRESS -w > /dev/console 2>&1 &
    $PROG &
}

case "$1" in
	start|"")
		start_swupdate
		;;
	*)
		echo "Usage: $0"
		exit 1
		;;
esac
```

因此 recovery 启动后核心进程关系是：

```text
/init
  -> /etc/init.d/rcS
       -> /etc/init.d/S99swupdate_autorun
            -> /sbin/swupdate-progress -w
            -> /sbin/swupdate_cmd.sh
```

`swupdate_cmd.sh` 文件：

```text
buildroot/buildroot-202205/package/swupdate/swupdate_cmd.sh
```

关键源码片段：

```sh
swupdate_cmd()
{
    while true
    do
        swu_param=$(fw_printenv -n swu_param 2>/dev/null)
        swu_software=$(fw_printenv -n swu_software 2>/dev/null)
        swu_mode=$(fw_printenv -n swu_mode 2>/dev/null)
        swu_version=$(fw_printenv -n swu_version 2>/dev/null)
        echo "swu_param: ##$swu_param##"
        echo "swu_software: ##$swu_software##"
        echo "swu_mode: ##$swu_mode##"

        check_version_para=""
        [ x"$swu_version" != x"" ] && {
            echo "now version is $swu_version"
            check_version_para="-N $swu_version"
        }

        [ x"$swu_mode" = x"" ] && {
            echo "no swupdate_cmd to run, wait for next swupdate"
            return
        }

        echo "###now do swupdate###"
        echo "###log in $swupdate_log_file###"

        echo "## swupdate -v $check_version_para $swu_param -e $swu_software,$swu_mode ##"
        swupdate -v $check_version_para $swu_param -e "$swu_software,$swu_mode" >> "$swupdate_log_file" 2>&1

        swu_next=$(fw_printenv -n swu_next 2>/dev/null)
        echo "swu_next: ##$swu_next##"
        if [ x"$swu_next" = "xreboot" ]; then
            fw_setenv swu_next
            reboot -f
        fi

        sleep 1
    done
}
```

它从 U-Boot env 中读取：

```text
swu_param
swu_software
swu_mode
swu_version
swu_next
```

如果 `swu_mode` 为空，就退出；如果有值，就执行：

```sh
swupdate -v $check_version_para $swu_param -e "$swu_software,$swu_mode"
```

## 10. Recovery OTA 描述文件

当前 A733 recovery OTA 说明：

```text
target/a733/buildroot/x733mhn_aic8800/swupdate/readme.txt
```

关键内容：

```text
1.recovery系统使用swupdate_make_recovery_img -j32编译，分区表中打开recovery分区后打包。

2.打包recovery OTA升级包命令，根据sw-subimgs.cfg文件的后缀：

例：sw-subimgs-recovery.cfg使用的打包，命令为swupdate_pack_swu -recovery；

3.差分升级，以ab升级举例，menuconfig中选中rdiff选项。

注意buildroot的rootfs是可读写的，不做差分升级。

4.自适应nand/emmc升级，默认功能不开启，所以使用命令时，升级命令最后需加上_emmc、_ubinand 或 _rawnand
```

recovery OTA 包文件列表：

```text
target/a733/buildroot/x733mhn_aic8800/swupdate/sw-subimgs-recovery.cfg
```

源码片段：

```sh
swota_file_list=(
target/${LICHEE_IC}/buildroot/${LICHEE_BOARD}/swupdate/sw-description-recovery:sw-description
${LICHEE_PACK_OUT_DIR}/boot0_sdcard.fex:boot0_emmc
${LICHEE_PACK_OUT_DIR}/boot0_nand.fex:boot0_nand
${LICHEE_PACK_OUT_DIR}/boot_package.fex:uboot
${LICHEE_PACK_OUT_DIR}/boot.fex:kernel
${LICHEE_PACK_OUT_DIR}/rootfs.fex:rootfs
${LICHEE_PACK_OUT_DIR}/recovery.fex:recovery
)
```

OTA 描述文件：

```text
target/a733/buildroot/x733mhn_aic8800/swupdate/sw-description-recovery
```

第一阶段 `upgrade_recovery_emmc`：

```cfg
upgrade_recovery_emmc = {
    /* upgrade recovery */
    images: (
        {
            filename = "recovery";
            device = "/dev/by-name/recovery";
            installed-directly = true;
        },
        {
            filename = "uboot";
            type = "awuboot";
        },
        {
            filename = "boot0_emmc";
            type = "awboot0";
        }
    );

    bootenv: (
        {
            name = "swu_mode";
            value = "upgrade_system_emmc";
        },
        {
            name = "boot_partition";
            value = "recovery";
        },
        {
            name = "swu_next";
            value = "reboot";
        }
    );
}
```

含义：

- 先写 recovery 分区。
- 再更新 uboot。
- 再更新 boot0。
- 设置 `swu_mode=upgrade_system_emmc`。
- 设置 `boot_partition=recovery`。
- 设置 `swu_next=reboot`，触发重启。

第二阶段 `upgrade_system_emmc`：

```cfg
upgrade_system_emmc = {
    /* upgrade kernel,rootfs */
    images: (
        {
            filename = "kernel";
            device = "/dev/by-name/boot";
            installed-directly = true;
        },
        {
            filename = "rootfs";
            device = "/dev/by-name/rootfs";
            installed-directly = true;
        }
    );

    bootenv: (
        {
            name = "swu_mode";
            value = "";
        },
        {
            name = "boot_partition";
            value = "boot";
        },
        {
            name = "swu_next";
            value = "reboot";
        }
    );
}
```

含义：

- 在 recovery 系统里更新 `boot` 和 `rootfs`。
- 清空 `swu_mode`。
- 把 `boot_partition` 改回 `boot`。
- 设置重启。

## 11. 当前分区表状态

当前 A733 Buildroot 分区表：

```text
device/config/chips/a733/configs/x733mhn_aic8800/buildroot/sys_partition.fex
```

其中 recovery 分区仍然被注释：

```ini
;[partition]
;    name         = recovery
;    size         = 131072
;    downloadfile = "recovery.fex"
;	user_type    = 0x8000
```

因此当前这份配置如果不修改分区表，是没有 `/dev/by-name/recovery` 分区给 recovery OTA 使用的。

若要实际使用 recovery OTA，需要打开 recovery 分区，或者准备独立的 `sys_partition-recovery.fex` 并在打包/OTA 流程中切换。

## 12. 总结流程

正常 Buildroot 当前 A733 流程：

```text
BoardConfig.mk
  LICHEE_BR_DEFCONF=sun60iw2p1_x733_defconfig
  LICHEE_NO_RAMDISK_NEEDED=y

Buildroot
  BR2_ROOTFS_POST_BUILD_SCRIPT=post_build.sh
  BR2_INIT_BUSYBOX 默认启用

boot.img
  kernel + dtb
  不带 ramdisk

Kernel
  root=/dev/mmcblk1p4 或 nand/ufs root
  init=/init

User space
  进入真实 rootfs
```

Recovery Buildroot 当前 A733 流程：

```text
BoardConfig.mk
  LICHEE_BR_RAMFS_CONF=sun60iw2p1_recovery_ramfs_defconfig
  LICHEE_KERN_DEFCONF_RECOVERY=bsp_recovery_defconfig

Buildroot ramfs
  BR2_ROOTFS_POST_BUILD_SCRIPT=post_rdinit.sh
  /init = buildroot/config/buildroot/busybox/rdinit

recovery.img
  kernel + dtb + ramdisk

Kernel
  解开 ramdisk
  执行 /init

Recovery user space
  rdinit
    -> /etc/init.d/rcS
       -> S99swupdate_autorun
          -> swupdate-progress
          -> swupdate_cmd.sh
             -> swupdate
```

核心判断一句话：

```text
正常系统是否先走 initramfs，取决于 LICHEE_NO_RAMDISK_NEEDED 和 check_whether_use_ramdisk()。

当前 A733:
  正常 boot: 不走 initramfs
  recovery: 强制走 initramfs
```

