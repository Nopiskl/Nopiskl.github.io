# SDK fastboot构建与打包流程分析
_Exported on 2026/4/21 at GMT+8 14:50:05 from Cursor (2.6.21)_

---

**User**

能否帮我分析一下整个SDK的fastboot构建与打包流程，以@SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk 这个fastboot配置文件为例

---

**Cursor**

**这个 SDK 的 fastboot 流程，本质上是：**
1. `BoardConfig-...FASTBOOT.mk` 定义板级参数；
2. `project/build.sh` 读取这些参数，生成分区布局、bootargs、文件系统类型；
3. 分别编译 `uboot / kernel / rootfs / recovery / media / app`；
4. 再把 app、media、驱动、IQ 文件等灌入一个“待打包根文件系统目录”；
5. 对 fastboot 模式，不再生成传统 `rootfs.img`，而是把 **内核 + dtb + resource + 压缩后的 erofs rootfs** 一起封到 `boot.img`；
6. 同时生成 `env.img / userdata.img / meta.img / misc.img` 等；
7. 最后调用 Rockchip 打包工具，依据 `env.img` 里解析出的分区表生成 `package-file`，再打成 `update.img`。

---

## 1. 这个 FASTBOOT 板级配置文件在控制什么

你给的配置文件是：

`project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk`

它的关键内容如下：

```1:136:/home/alientek/RV1106/SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk
export RK_CHIP=rv1106
export RK_APP_TYPE="RK_FASTBOOT_SERVER SMART_DOOR_RV1106_NORMAL"
export RK_BOOTARGS_CMA_SIZE="38M"
export RK_KERNEL_DTS=rv1106g-luckfox-pico-ultra-fastboot.dts
export RK_BOOT_MEDIUM=emmc
export RK_UBOOT_DEFCONFIG_FRAGMENT=rk-emmc.config
export RK_PARTITION_CMD_IN_ENV="32K(env),256K@32K(idblock),256K(uboot),384K(meta),36M(boot),3G(userdata)"
export RK_PARTITION_FS_TYPE_CFG=boot@IGNORE@erofs,userdata@/userdata@ext4
export LF_TARGET_ROOTFS=busybox
export RK_ARCH=arm
export RK_TOOLCHAIN_CROSS=arm-rockchip830-linux-uclibcgnueabihf
export RK_MISC=wipe_all-misc.img
export RK_UBOOT_DEFCONFIG=luckfox_rv1106_uboot_emmc_tb_defconfig
export RK_UBOOT_RKBIN_MCU_CFG=rv1106_evb-SC3338-ADC
export RK_KERNEL_DEFCONFIG=luckfox_rv1106_linux_tb_defconfig
export RK_KERNEL_DEFCONFIG_FRAGMENT="luckfox_rv1106-tb.config rv1106-smart-door.config rv1106-rndis.config"
export RK_RECOVERY_KERNEL_DEFCONFIG_FRAGMENT="rv1106-tb.config rv1106-recovery.config"
export RK_CAMERA_SENSOR_IQFILES="sc3338_FKO1_30IRC-F16.bin"
export RK_BUILD_APP_TO_OEM_PARTITION=n
export RK_AIISP_MODEL=NONE
export RK_AUDIO_MODEL=NONE
export RK_NPU_MODEL=NONE
export RK_POST_BUILD_SCRIPT=luckfox-rv1106-tb-emmc-post.sh
export RK_PRE_BUILD_OEM_SCRIPT=luckfox-rv1106-tb-pre-oem.sh
export RK_ENABLE_FASTBOOT=y
export RK_POST_OVERLAY=overlay-luckfox-fastboot
export RK_TINY_META=n
export RK_META_PARAM=" \
 --rk_cam_mirror_flip=0 \
 --rk_cam_fps=25 \
 --rk_cam_hdr=0 \
 --rk_led_value=20 \
 --rk_night_mode=0 \
"
export RK_ENABLE_RNDIS=y
```

### 这几个变量最关键

#### 1) `RK_ENABLE_FASTBOOT=y`
这是整个流程切换成 fastboot 模式的总开关。

它会直接影响：
- kernel 构建输出路径；
- uboot 的 rkbin ini 选择；
- recovery 的打包方式；
- firmware 阶段到底打 `boot.img` 还是 `rootfs.img`；
- 最终 update.img 中包含哪些分区镜像。

#### 2) `RK_PARTITION_CMD_IN_ENV`
定义分区布局：

```text
32K(env),256K@32K(idblock),256K(uboot),384K(meta),36M(boot),3G(userdata)
```

这意味着这个 fastboot 配置下，**没有单独 rootfs 分区**，核心启动分区就是 `boot`，再加 `userdata`。

#### 3) `RK_PARTITION_FS_TYPE_CFG`
定义各分区文件系统类型：

```text
boot@IGNORE@erofs,userdata@/userdata@ext4
```

即：
- `boot` 分区是 `erofs`
- `userdata` 分区是 `ext4`

但要注意：在 **fastboot 模式** 下，`boot` 分区不是“单纯一个 erofs 文件系统镜像”，而是被进一步封成 **FIT boot.img**。

#### 4) `LF_TARGET_ROOTFS=busybox`
说明用户态根文件系统不是 buildroot 完整 rootfs，而是 busybox 体系。

#### 5) `RK_APP_TYPE="RK_FASTBOOT_SERVER ..."`
说明 app 侧会编译 `fastboot_server` 这一套应用，最终打进 rootfs/oem 目录。

#### 6) `RK_KERNEL_DTS / RK_KERNEL_DEFCONFIG / RK_UBOOT_DEFCONFIG`
这三个决定内核和 uboot 的板级配置。

---

## 2. `build.sh` 怎么把这个 BoardConfig 接进来

`project/build.sh` 启动后，会先确保 `.BoardConfig.mk` 存在；如果没有，就让你 `lunch` 选板。之后直接 `source` 这个板级配置文件：

```256:320:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
if [ ! -e "$BOARD_CONFIG" ]; then
	if [ "$1" = "clean" ]; then
		msg_info "The $BOARD_CONFIG is missing, and the SDK has not been built yet."
		exit 1
	else
		build_select_board
	fi
fi
[ -L "$BOARD_CONFIG" ] && source $BOARD_CONFIG
__LINK_DEFCONFIG_FROM_BOARD_CFG
export RK_PROJECT_BOARD_DIR=$(dirname $(realpath $BOARD_CONFIG))
export RK_PROJECT_TOOLCHAIN_CROSS=$RK_TOOLCHAIN_CROSS
export PATH="${SDK_ROOT_DIR}/tools/linux/toolchain/${RK_PROJECT_TOOLCHAIN_CROSS}/bin":$PATH
...
build_check
__PREPARE_BOARD_CFG
```

也就是说：

- `.BoardConfig.mk` 实际是一个软链接，指向你选中的 `BoardConfig-...mk`
- `source` 之后，所有 `RK_*` 变量都进入当前 shell 环境
- 后面的所有构建逻辑都靠这些变量驱动

---

## 3. 整个流程的总入口

如果你跑的是默认 `./build.sh`，实际默认会走 `allsave`，而 `allsave` 内部先 `build_all`：

```79:108:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
function build_all() {
	echo "============================================"
	echo "TARGET_ARCH=$RK_ARCH"
	echo "TARGET_UBOOT_CONFIG=$RK_UBOOT_DEFCONFIG $RK_UBOOT_DEFCONFIG_FRAGMENT"
	echo "TARGET_SPL_CONFIG=$RK_SPL_DEFCONFIG"
	echo "TARGET_KERNEL_CONFIG=$RK_KERNEL_DEFCONFIG $RK_KERNEL_DEFCONFIG_FRAGMENT"
	echo "TARGET_KERNEL_DTS=$RK_KERNEL_DTS"
	echo "TARGET_RECOVERY_CONFIG=$RK_CFG_RECOVERY"
	echo "TARGET_RAMBOOT_CONFIG=$RK_CFG_RAMBOOT"
	echo "============================================"

	build_sysdrv
	build_media
	build_app
	build_firmware

	finish_build
}
```

所以主链路是：

1. `build_sysdrv`
2. `build_media`
3. `build_app`
4. `build_firmware`

---

# 4. fastboot 的构建阶段分析

---

## 4.1 `build_sysdrv`：先编系统底座

`build_sysdrv` 会做：

```145:170:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
function build_sysdrv() {
	...
	build_uboot
	build_kernel
	build_rootfs
	build_recovery
	...
}
```

也就是先出：
- U-Boot
- Kernel
- 基础 rootfs
- Recovery

---

## 4.2 `build_uboot`：fastboot 模式下会额外编 MCU，并改 rkbin ini

这一段非常关键：

```1:39:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
if [ "$RK_ENABLE_FASTBOOT" = "y" -a -n "$RK_UBOOT_RKBIN_MCU_CFG" ]; then
	uboot_rkbin_ini=$RK_PROJECT_PATH_FASTBOOT/rk_uboot_rkbin_rkboot_overlay.ini
	build_mcu $RK_UBOOT_RKBIN_MCU_CFG "__MCU_CONTINUE__"
	case $RK_BOOT_MEDIUM in
	emmc)
		tempfile=$target_ini_dir/RV1106MINIALL_EMMC_TB.ini
		;;
	...
	esac

	if [ -f "$RK_PROJECT_FILE_SYSDRV_MCU_BIN" ]; then
		__modify_file $tempfile $uboot_rkbin_ini "Hpmcu=" "$RK_PROJECT_FILE_SYSDRV_MCU_BIN" "^"
	else
		msg_error "build mcu <$RK_UBOOT_RKBIN_MCU_CFG> failed"
		exit 1
	fi
fi

make uboot -C ${SDK_SYSDRV_DIR} UBOOT_CFG=${RK_UBOOT_DEFCONFIG} UBOOT_CFG_FRAGMENT=${RK_UBOOT_DEFCONFIG_FRAGMENT} SYSDRV_UBOOT_RKBIN_OVERLAY_INI=$uboot_rkbin_ini
```

### 这里在做什么？

对于你的配置：

- `RK_ENABLE_FASTBOOT=y`
- `RK_UBOOT_RKBIN_MCU_CFG=rv1106_evb-SC3338-ADC`
- `RK_BOOT_MEDIUM=emmc`

所以会：

1. 先编 MCU 固件；
2. 选 `rkbin/RKBOOT/RV1106MINIALL_EMMC_TB.ini` 作为 ThunderBoot/Fastboot 模板；
3. 把 MCU bin 填进这个 ini 的 `Hpmcu=` 项；
4. 再拿这个 overlay ini 去编 uboot。

### 输出结果
这一阶段最终产出的是一套 bootloader 相关文件，典型会在 `output/out/sysdrv_out/board_*` 或 `output/image` 后续被整理：
- `download.bin`
- `uboot.img`
- 可能还有 idblock / loader 相关中间产物

---

## 4.3 `build_kernel`：fastboot 模式下，内核输出到 `output/out/fastboot`

```120:145:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
function build_kernel() {
	...
	local kernel_build_options
	if [ "$RK_ENABLE_FASTBOOT" = "y" ]; then
		kernel_build_options="OUTPUT_SYSDRV_RAMDISK_DIR=$RK_PROJECT_PATH_FASTBOOT"
		mkdir -p $RK_PROJECT_PATH_FASTBOOT
	fi
	make kernel -C ${SDK_SYSDRV_DIR} \
		$kernel_build_options \
		KERNEL_DTS=${RK_KERNEL_DTS} \
		KERNEL_CFG=${RK_KERNEL_DEFCONFIG} \
		KERNEL_CFG_FRAGMENT=${RK_KERNEL_DEFCONFIG_FRAGMENT}
	...
}
```

对于 fastboot，这里会把一些本该给 ramdisk/boot image 用的产物直接输出到：

- `output/out/fastboot/`

通常这里会放：
- `Image`
- `*.dtb`
- `resource.img`

这些后面会被 `mk-fitimage.sh` 打进 `boot.img`。

---

## 4.4 `build_rootfs`：先生成基础 busybox rootfs tar，再解到工作目录

```145:184:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
function build_rootfs() {
	check_config RK_BOOT_MEDIUM || return 0

	make rootfs -C ${SDK_SYSDRV_DIR}
	__LINK_DEFCONFIG_FROM_BOARD_CFG

	local rootfs_tarball rootfs_out_dir
	rootfs_tarball="$RK_PROJECT_PATH_SYSDRV/rootfs_${RK_LIBC_TPYE}_${RK_CHIP}.tar"
	rootfs_out_dir="$RK_PROJECT_OUTPUT/rootfs_${RK_LIBC_TPYE}_${RK_CHIP}"
	...
	tar xf $rootfs_tarball -C $RK_PROJECT_OUTPUT
	...
}
```

这一步的本质是：

- 先让 `sysdrv` 侧产出基础 rootfs tar
- 再解包到一个目录里，作为后续“二次打包”的基础底板

对你的配置，rootfs 是 busybox，所以这一步得到的是一个最小 Linux 用户态根目录骨架。

---

## 4.5 `build_recovery`：fastboot 模式下 recovery 也会走 erofs + fitimage

这段也很关键：

```94:148:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
# build recovery for fastboot
if [ "$RK_ENABLE_FASTBOOT" = "y" ]; then
	ramdisk_file="recovery_erofs.img"
	case "$RK_ARCH" in
	arm)
		kernel_image="$RK_PROJECT_PATH_RAMDISK/Image.gz"
		gzip -9 -c $RK_PROJECT_PATH_RAMDISK/Image >$kernel_image
		;;
	...
	esac
	cp -fa $PROJECT_TOP_DIR/scripts/$RK_CHIP-boot-tb.its $RK_PROJECT_PATH_RAMDISK/boot4recovery.its

	# package rootfs in erofs for fastboot if necessary
	$RK_PROJECT_TOOLS_MKFS_EROFS $RK_PROJECT_PATH_RAMDISK/tiny_rootfs $RK_PROJECT_PATH_RAMDISK/$ramdisk_file
else
	...
fi

...
$RK_PROJECT_PATH_PC_TOOLS/mk-fitimage.sh \
	$RK_PROJECT_PATH_RAMDISK/boot4recovery.its \
	$RK_PROJECT_PATH_RAMDISK/${ramdisk_file} \
	$kernel_image \
	$kernel_dtb_file \
	$RK_PROJECT_PATH_RAMDISK/resource.img \
	$RK_PROJECT_OUTPUT_IMAGE/recovery.img \
	$RK_ARCH \
	$fit_target_optional_param
```

### 说明
在非 fastboot 模式下 recovery 通常更像传统 `kernel + cpio ramdisk`；
但这里因为 `RK_ENABLE_FASTBOOT=y`，所以 recovery 也换成：

- tiny_rootfs -> `recovery_erofs.img`
- 再 gzip
- 再和 `kernel + dtb + resource` 一起封成 `recovery.img`

这说明整个 SDK 的 fastboot 思路是统一的：**尽量围绕 FIT 镜像 + 压缩只读文件系统**。

---

# 5. firmware 打包阶段：这是最核心的地方

`build_firmware` 决定最后出哪些 img，以及 fastboot 和普通模式有何差异。

---

## 5.1 先根据 `RK_PARTITION_CMD_IN_ENV` 解析分区和 bootargs

`__PREPARE_BOARD_CFG` 里先做：

```126:137:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
function __PREPARE_BOARD_CFG() {
	parse_partition_file
	__GET_TARGET_PARTITION_FS_TYPE
	if [ "$RK_ENABLE_FASTBOOT" = "y" ]; then
		SYS_BOOTARGS="$SYS_BOOTARGS $RK_PARTITION_ARGS"
	fi
	__GET_BOOTARGS_FROM_BOARD_CFG

	export RK_KERNEL_CMDLINE_FRAGMENT=${SYS_BOOTARGS#sys_bootargs=}
}
```

### `parse_partition_file`
它会把：

```text
32K(env),256K@32K(idblock),256K(uboot),384K(meta),36M(boot),3G(userdata)
```

转换为：
- 十六进制偏移/大小形式的 `GLOBAL_PARTITIONS`
- 对应 boot medium 的 `RK_PARTITION_ARGS`

例如 eMMC 下会变成：

```text
RK_PARTITION_ARGS="blkdevparts=mmcblk0:..."
```

并写入 `ENV_CFG_FILE`。

### `__GET_TARGET_PARTITION_FS_TYPE`
它会根据：

```text
boot@IGNORE@erofs,userdata@/userdata@ext4
```

为分区建立文件系统属性，并生成挂载脚本。

---

## 5.2 `build_env`：把分区表和 bootargs 做成 `env.img`

```61:80:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
function build_env() {
	...
	echo "$SYS_BOOTARGS" >>$ENV_CFG_FILE
	echo "sd_parts=mmcblk0:16K@512(env),512K@32K(idblock),4M(uboot)" >>$ENV_CFG_FILE
	$RK_PROJECT_PATH_PC_TOOLS/mkenvimage -s $ENV_SIZE -p 0x0 -o $env_cfg_img $ENV_CFG_FILE
	...
}
```

### 这里的意义
`env.img` 里包含：
- 分区参数
- 内核 bootargs
- 其他 uboot 环境变量

后续 Rockchip 打 `update.img` 时，甚至会直接从 `env.img` 里反推分区列表。

---

## 5.3 `build_meta`：fastboot 下额外生成 `meta.img`

`build_firmware` 一开头就有：

```210:218:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
function build_firmware() {
	check_config RK_PARTITION_CMD_IN_ENV || return 0

	build_env

	if [ "$RK_ENABLE_FASTBOOT" = "y" ]; then
		build_meta
	fi
```

你的分区里有 `meta`：

```text
384K(meta)
```

所以 fastboot 模式下 `meta.img` 会被构建出来。  
内容通常来自 sensor/camera/meta 参数，比如你配置里的：

- `RK_META_PARAM`
- `RK_CAMERA_SENSOR_IQFILES`

这也是 ThunderBoot/快速启动场景比较常见的一部分。

---

## 5.4 `__PACKAGE_ROOTFS` / `__PACKAGE_OEM`：把 app、media、ko、IQ 文件灌进根文件系统目录

打镜像前，并不是直接拿基础 rootfs tar 去封，而是要先往里面塞资源。

### `__PACKAGE_RESOURCES`
会拷这些东西：

```1:54:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
__COPY_FILES $RK_PROJECT_PATH_SYSDRV/kernel_drv_ko/ $_install_dir/ko
__COPY_FILES $RK_PROJECT_PATH_APP/bin $_install_dir/bin/
__COPY_FILES $RK_PROJECT_PATH_APP/lib $_install_dir/lib/
__COPY_FILES $RK_PROJECT_PATH_APP/share $_install_dir/share/
__COPY_FILES $RK_PROJECT_PATH_APP/usr $_install_dir/
__COPY_FILES $RK_PROJECT_PATH_APP/etc $_install_dir/etc/

__COPY_FILES $RK_PROJECT_PATH_MEDIA/bin $_install_dir/bin/
__COPY_FILES $RK_PROJECT_PATH_MEDIA/lib $_install_dir/lib/
__COPY_FILES $RK_PROJECT_PATH_MEDIA/share $_install_dir/share/
__COPY_FILES $RK_PROJECT_PATH_MEDIA/usr $_install_dir/
```

并且还会拷：
- `isp_iqfiles`
- 校准文件
- 外部资源等

### 对你这个 fastboot 配置的特点
由于：

```text
RK_BUILD_APP_TO_OEM_PARTITION=n
```

所以 app 资源**不会单独做成 `oem.img`**，而是最终会并入 rootfs 内的 `/oem` 目录。

---

## 5.5 fastboot 最关键：`build_mkimg boot ...`

这一步决定了为何 fastboot 配置只有 `boot` 分区，没有 `rootfs` 分区。

### 在 `build_firmware` 中：

```233:248:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
if [ -n "$GLOBAL_INITRAMFS_BOOT_NAME" ]; then
	build_mkimg boot $RK_PROJECT_PACKAGE_ROOTFS_DIR
fi

if [ "$RK_ENABLE_FASTBOOT" = "y" ]; then
	if [ "$RK_ENABLE_RAMDISK_PARTITION" = "y" ]; then
		build_mkimg $GLOBAL_ROOT_FILESYSTEM_NAME $RK_PROJECT_PACKAGE_ROOTFS_DIR
	else
		build_mkimg boot $RK_PROJECT_PACKAGE_ROOTFS_DIR
		fi
else
	build_mkimg $GLOBAL_ROOT_FILESYSTEM_NAME $RK_PROJECT_PACKAGE_ROOTFS_DIR
fi
```

你的配置没有 `rootfs` 分区，只有 `boot`，所以这里会执行：

```bash
build_mkimg boot $RK_PROJECT_PACKAGE_ROOTFS_DIR
```

---

## 5.6 `build_mkimg` 在 fastboot + erofs + boot 分区时到底做了什么

看最关键这一段：

```134:184:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
case $fs_type in
erofs)
	if [ $part_name == "boot" -o "$RK_ENABLE_RAMDISK_PARTITION" = "y" ]; then
		local kernel_dtb_file="$RK_PROJECT_PATH_FASTBOOT/${RK_KERNEL_DTS/%.dts/.dtb}"

		if [ "$RK_BOOT_MEDIUM" = "spi_nand" ]; then
			cat $RK_PROJECT_PATH_FASTBOOT/Image | $RK_PROJECT_PATH_PC_TOOLS/compress_tool -9 >$RK_PROJECT_PATH_FASTBOOT/Image.gz
		else
			cat $RK_PROJECT_PATH_FASTBOOT/Image | $RK_PROJECT_PATH_PC_TOOLS/compress_tool -f -5 >$RK_PROJECT_PATH_FASTBOOT/Image.gz
		fi
		cp -fa $PROJECT_TOP_DIR/scripts/$RK_CHIP-boot-tb.its $RK_PROJECT_PATH_FASTBOOT/boot-tb.its

		$RK_PROJECT_TOOLS_MKFS_EROFS $src $RK_PROJECT_PATH_FASTBOOT/rootfs_erofs.img
		cat $RK_PROJECT_PATH_FASTBOOT/rootfs_erofs.img | gzip -n -f -9 >$RK_PROJECT_PATH_FASTBOOT/rootfs_erofs.img.gz

		$RK_PROJECT_PATH_PC_TOOLS/mk-fitimage.sh \
			$RK_PROJECT_PATH_FASTBOOT/boot-tb.its \
			$(realpath $RK_PROJECT_PATH_FASTBOOT/rootfs_erofs.img.gz) \
			$(realpath $RK_PROJECT_PATH_FASTBOOT/Image.gz) \
			$(realpath $kernel_dtb_file) \
			$(realpath $RK_PROJECT_PATH_FASTBOOT/resource.img) \
			$dst \
			$RK_ARCH \
			$fit_target_optional_param
```

### 这一步可以理解为三层封装

#### 第 1 层：先把“最终 rootfs 目录”做成 `rootfs_erofs.img`
也就是把：
- busybox 基础 rootfs
- app
- media
- ko
- IQ 文件
- overlay
- post build 处理后的内容

一起做成一个 `erofs` 镜像。

#### 第 2 层：再把 `rootfs_erofs.img` 压成 `rootfs_erofs.img.gz`

#### 第 3 层：用 `mk-fitimage.sh` 封成 `boot.img`
把下面这些一起放进去：
- `rootfs_erofs.img.gz`
- `Image.gz`
- `dtb`
- `resource.img`
- `its` 描述文件

### 所以对于你的 FASTBOOT 配置，最终 `boot.img` 实际包含：
- kernel
- dtb
- resource
- 压缩 erofs rootfs

这就是 fastboot 方案和传统 rootfs 分区方案最大的区别。

---

# 6. `userdata.img` 怎么做

后面 `build_firmware` 还会无论如何打一个 `userdata.img`：

```250:257:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
mkdir -p $RK_PROJECT_PACKAGE_USERDATA_DIR
if [ "$RK_ENABLE_FASTBOOT" != "y" ]; then
	__PACKAGE_USERDATA
	__RUN_POST_BUILD_USERDATA_SCRIPT
fi
build_mkimg userdata $RK_PROJECT_PACKAGE_USERDATA_DIR
```

由于你的配置是 fastboot：
- `__PACKAGE_USERDATA` 不执行
- 但仍然会生成空的 `userdata.img`

结合 `RK_PARTITION_FS_TYPE_CFG=... userdata@/userdata@ext4`，它会是一个 **ext4 空分区镜像**，用于首次烧写时初始化 `userdata`。

---

# 7. 最终 `update.img` 是怎么打出来的

---

## 7.1 `build_updateimg`

在 `build_firmware` 最后会调：

```98:108:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
function build_updateimg() {
	check_config ENV_SIZE || return 0

	IMAGE_PATH=$RK_PROJECT_OUTPUT_IMAGE
	PACK_TOOL_PATH=$SDK_ROOT_DIR/tools/linux/Linux_Pack_Firmware

	$PACK_TOOL_PATH/mk-update_pack.sh -id $RK_CHIP -i $IMAGE_PATH
}
```

即对 `output/image` 目录中的所有 img 进行二次封装。

---

## 7.2 `mk-update_pack.sh` 怎么知道要打哪些分区

它不是写死的，而是**从 `env.img` 中解析分区表**：

```101:128:/home/alientek/RV1106/SDK/luckfox-pico/tools/linux/Linux_Pack_Firmware/mk-update_pack.sh
function get_partition_names()
{
	part_file=$IMAGE_PATH/$PARTITION_FILE
	boot_mediums="blkdevparts=mmcblk0,blkdevparts=mmcblk1,mtdparts=sfc_nor,mtdparts=spi-nand0,mtdparts=rk-nand"

	IFS=,
	for medium in $boot_mediums;
	do
		part_lines=$(strings $part_file | grep -i $medium)
		[ ! -z "$part_lines" ] && part_lines=${part_lines##*${medium}:} && break
	done
	...
	for part in $part_lines;
	do
		part_size=`echo $part | cut -d '@' -f1`
		part_name=`echo $part | cut -d '(' -f2|cut -d ')' -f1`

		[[ $part_size =~ "-" ]] && continue
		PARTITIONS="$part_name,$PARTITIONS"
	done
}
```

### 也就是说
它会从 `env.img` 里抽出类似：

```text
blkdevparts=mmcblk0:32K(env),256K@32K(idblock),256K(uboot),384K(meta),36M(boot),3G(userdata)
```

然后得到分区名：
- env
- idblock
- uboot
- meta
- boot
- userdata

---

## 7.3 然后自动生成 `package-file`

```151:176:/home/alientek/RV1106/SDK/luckfox-pico/tools/linux/Linux_Pack_Firmware/mk-update_pack.sh
function create_package_file()
{
	IFS=,
	for part in $SPECIAL_PARTITIONS $PARTITIONS;
	do
		case $part in
			package-file)
				PACKAGE_CFG="$part	package-file\n$PACKAGE_CFG"
				;;
			bootloader)
				__package_file download.bin Essential
				;;
			parameter)
				__package_file $PARTITION_FILE Essential
				;;
			rootfs)
				__package_file $part
				[ $? -eq 1 ] && __package_file rootfs_base.img
				;;
			*)
				__package_file $part
				;;
		esac
	done
	...
	echo -e $PACKAGE_CFG > $IMAGE_PATH/package-file
}
```

对你的 fastboot 配置，它最终大致会组织出这样的映射：

- `bootloader -> download.bin`
- `package-file -> package-file`
- `parameter -> env.img`（这里它拿 env.img 作为分区描述源）
- `env -> env.img`
- `idblock -> idblock.img` 或对应文件
- `uboot -> uboot.img`
- `meta -> meta.img`
- `boot -> boot.img`
- `userdata -> userdata.img`

### 注意
因为你这个配置没有 `rootfs` 分区，所以 update.img 里也不会出现传统 `rootfs.img`。

---

## 7.4 最后调用 Rockchip 打包工具生成 `update.img`

```181:188:/home/alientek/RV1106/SDK/luckfox-pico/tools/linux/Linux_Pack_Firmware/mk-update_pack.sh
$cwd/afptool -pack $IMAGE_PATH $IMAGE_PATH/update_tmp.img || pause
$cwd/rkImageMaker $CHIP_ID $IMAGE_PATH/download.bin $IMAGE_PATH/update_tmp.img  $IMAGE_PATH/update.img -os_type:androidos || pause
```

所以最终：
- `afptool` 先把 package-file 中列出的镜像打成临时包
- `rkImageMaker` 再加上 bootloader 信息生成标准 Rockchip `update.img`

---

# 8. 用这份 FASTBOOT 配置时，最终典型产物有哪些

对你这个配置，我理解最终 `output/image/` 里比较关键的应该是：

- `env.img`
- `download.bin`
- `uboot.img`
- `meta.img`
- `boot.img`
- `userdata.img`
- `recovery.img`（若启用 recovery）
- `misc.img`（某些条件下）
- `update.img`

### 其中最值得注意的是：
**`boot.img` 取代了传统 `rootfs.img`。**

---

# 9. 这个 FASTBOOT 配置和普通 Buildroot/eMMC 配置最大的区别

可以概括成 5 点：

## 1) 分区表更精简
普通方案常见是：
- env
- idblock
- uboot
- boot
- oem
- userdata
- rootfs

而你这个 fastboot 方案是：
- env
- idblock
- uboot
- meta
- boot
- userdata

没有单独 `rootfs`。

## 2) 根文件系统被封进 `boot.img`
普通方案：
- `boot.img` 放 kernel/dtb
- `rootfs.img` 单独放根文件系统

fastboot 方案：
- rootfs 先做成 `erofs`
- 再和 kernel/dtb/resource 一起做 FIT `boot.img`

## 3) uboot 会走 ThunderBoot/fastboot 特化路径
包括：
- 专用 `RV1106MINIALL_EMMC_TB.ini`
- MCU 固件注入
- 更快启动链路

## 4) 有 `meta` 分区
用于快速启动相关元数据/相机参数等。

## 5) app 类型也切成 fastboot server
你的配置里：

```text
RK_APP_TYPE="RK_FASTBOOT_SERVER SMART_DOOR_RV1106_NORMAL"
```

说明用户态服务不是普通 IPC app 组合，而是有 fastboot server 特化。

---

# 10. 你这个配置的一条“完整时序链”

如果用一句顺序图式的话，可以写成：

## 阶段 A：加载配置
- `source BoardConfig-...FASTBOOT.mk`
- 设置芯片、介质、分区、fs、dts、defconfig、fastboot 开关

## 阶段 B：预处理
- `parse_partition_env`
- `parse_partition_file`
- 生成 `GLOBAL_PARTITIONS`
- 生成 `SYS_BOOTARGS`
- 生成挂载脚本
- 生成 `RK_KERNEL_CMDLINE_FRAGMENT`

## 阶段 C：编译
- `build_uboot`
  - 编 MCU
  - 选 `RV1106MINIALL_EMMC_TB.ini`
  - 编出 bootloader
- `build_kernel`
  - 输出 fastboot 专用 kernel/dtb/resource 到 `output/out/fastboot`
- `build_rootfs`
  - 产出并解包基础 busybox rootfs
- `build_recovery`
  - fastboot 风格 recovery 打包

## 阶段 D：收集文件系统内容
- 把 app/media/ko/IQ 等复制到 rootfs 工作目录
- 执行 pre/post build 脚本
- 应用 overlay

## 阶段 E：生成各分区镜像
- `build_env` -> `env.img`
- `build_meta` -> `meta.img`
- `build_mkimg boot ...` -> `boot.img`
  - rootfs 目录 -> `rootfs_erofs.img`
  - gzip
  - 和 kernel/dtb/resource -> FIT `boot.img`
- `build_mkimg userdata ...` -> `userdata.img`

## 阶段 F：总包
- `mk-update_pack.sh`
- 从 `env.img` 解析分区
- 自动生成 `package-file`
- `afptool`
- `rkImageMaker`
- 得到 `update.img`

---

# 11. 你可以怎么验证我的分析

如果你想在本地进一步对照，我建议重点看这几个位置：

### 1) 板级 fastboot 配置
`project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk`

### 2) 配置加载与入口
`project/build.sh` 末尾：
- `source $BOARD_CONFIG`
- `__PREPARE_BOARD_CFG`

### 3) fastboot 特化点
`project/build.sh` 中：
- `build_uboot`
- `build_kernel`
- `build_recovery`
- `build_firmware`
- `build_mkimg`

### 4) 最终 update.img 打包
`tools/linux/Linux_Pack_Firmware/mk-update_pack.sh`

---

如果你愿意，我下一步可以继续帮你做两件事之一：

1. **画一张“fastboot 构建/打包流程图”**，按函数调用和产物流向画出来；  
2. **结合你这个 RV1106 ThunderBoot 场景，继续深挖 boot.img 内部组成与启动链**，比如从 ROM -> idblock -> uboot -> boot.img -> kernel -> fastboot server 的实际启动路径。

