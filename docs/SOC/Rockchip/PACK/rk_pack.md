# RK SDK build.sh pack process analysis
_Exported on 2026/4/19 at GMT+8 13:12:07 from Cursor (2.6.21)_

---

**User**

帮我分析一下RK SDK的build.sh pack全过程

---

**Cursor**

我先定位 `build.sh` 和 `pack` 相关脚本，再顺着调用链梳理全过程。

继续读取 `build.sh` 主流程，重点看 `pack` 命令是怎么分发出去的。

现在已经看到主框架了：`build.sh` 本身不直接打包，而是通过 `support-cmds / pre-build / build / post-build` 这套 hook 机制，把 `pack` 分发给各个 `mk-*.sh`。接下来我读取和镜像打包最相关的几个脚本。

我再确认一下你说的 `pack` 在这个 SDK 里对应哪条命令链。很多 Rockchip SDK 里口语上的“pack”其实对应 `firmware` 或 `updateimg` 两段。先把命令注册机制和相关子模块再串一下。

为了解释“pack 全过程”，还需要把 `firmware` 之前各个关键镜像是怎么准备出来的补齐：至少 `loader / kernel / rootfs / recovery`。我把最相关脚本读一下，然后给你按时序串成一条线。

我再补两块：一是分区表/额外挂载分区怎样影响打包，二是 `update.img` 的 `package-file` 是怎么从参数文件推导出来的。这样就能把“pack 全过程”闭环。

下面我按“主入口 -> hook 分发 -> 镜像准备 -> firmware 打包 -> update.img 打包 -> 关键配置/分支”的顺序，把这个 RK SDK 里 `build.sh pack` 的全过程给你串起来。

先说结论：

- 这个 SDK 里没有一个直接叫 `pack` 的总命令。
- 通常大家口语里说的“pack”实际对应两段：
  1. `mk-firmware.sh`：把各分区镜像整理到 `output/firmware` / `rockdev`
  2. `mk-updateimg.sh`：再把这些镜像打成 `update.img`
- 如果你执行的是默认 `./build.sh` 或 `./build.sh allsave`，它最后会自动走到这两步。

---

## 1. 总体架构：`build.sh` 只是调度器，不直接打包

主入口是：

```1:40:device/rockchip/common/scripts/build.sh
#!/bin/bash

if [ -z "$BASH_SOURCE" ]; then
	echo "Not in bash, switching to it..."
	case "${@:-shell}" in
		shell) ./build.sh shell ;;
		*)
			./build.sh $@
			bash
			;;
	esac
fi

usage()
{
	echo "Usage: $(basename $BASH_SOURCE) [OPTIONS]"
	echo "Available options:"
```

它的核心不是自己去 build/pack，而是：

1. 初始化环境变量
2. 读取 `output/.config`
3. 解析分区表
4. 通过 `run_build_hooks` 把命令分发到各个 `mk-*.sh`

关键分发点在这里：

```404:415:device/rockchip/common/scripts/build.sh
	# Pre-build stage (submodule configuring, etc.)
	run_build_hooks pre-build $OPTIONS

	# No need to go further
	CMDS="$(run_build_hooks support-cmds build post-build | xargs)"
	option_check "$CMDS" $OPTIONS || return 0

	# Build stage (building, etc.)
	run_build_hooks build $OPTIONS

	# No need to go further
	CMDS="$(run_build_hooks support-cmds post-build | xargs)"
	option_check "$CMDS" $OPTIONS || return 0

	# Post-build stage (firmware packing, etc.)
	run_build_hooks post-build $OPTIONS
```

也就是说它有三段：

- `init`
- `pre-build`
- `build`
- `post-build`

而“打包”主要发生在 `post-build`。

---

## 2. hook 机制怎么工作

每个 `mk-*.sh` 都会声明自己支持哪些命令，比如：

- `BUILD_CMDS`
- `POST_BUILD_CMDS`
- `INIT_CMDS`
- `PRE_BUILD_CMDS`

然后由 `build-helper` 统一解析。

关键逻辑：

```105:138:device/rockchip/common/build-hooks/build-helper
	case "$1" in
	help | h | -h | --help | \?) usage ;;
	make-targets) make_targets; exit 0 ;;
	make-usage) make_usage; exit 0 ;;
	usage) usage_hook; exit 0 ;;
	support-cmds)
		shift
		{
			ALL_CMDS="$INIT_CMDS $PRE_BUILD_CMDS $BUILD_CMDS \
				$POST_BUILD_CMDS"
			for stage in ${@:-all}; do
				case $stage in
					init) echo "$INIT_CMDS" ;;
					pre-build) echo "$PRE_BUILD_CMDS" ;;
					build) echo "$BUILD_CMDS" ;;
					post-build) echo "$POST_BUILD_CMDS" ;;
					all) echo "$ALL_CMDS" ;;
				esac
			done
		} | xargs -n 1 | grep -v "^default$" | xargs || true
		exit 0
		;;
```

所以 `build.sh` 会先问所有 `mk-*.sh`：

- 你们支持什么命令？
- 当前命令在哪个 stage 执行？

然后再把命令派发给对应脚本。

---

## 3. 默认构建为什么最后一定会走到“pack”

默认命令是 `allsave`。在 `mk-all.sh` 里：

```95:114:device/rockchip/common/scripts/mk-all.sh
usage_hook()
{
	echo -e "all                               \tbuild all images"
	echo -e "save                              \tsave images and build info"
	echo -e "allsave                           \tbuild all images and save them"
}

BUILD_CMDS="all allsave all_multi_dtb"
build_hook()
{
	case "$1" in
		all) build_all ;;
		allsave) build_allsave $@ ;;
		all_multi_dtb) build_all_multi_dtb ;;
	esac
}
```

真正关键是 `build_all()`：

```9:40:device/rockchip/common/scripts/mk-all.sh
build_all()
{
	echo "=========================================="
	echo "          Start building all images"
	echo "=========================================="

	rm -rf "$RK_FIRMWARE_DIR" "$RK_SECURITY_FIRMWARE_DIR"
	mkdir -p "$RK_FIRMWARE_DIR" "$RK_SECURITY_FIRMWARE_DIR"

	if [ "$RK_RTOS" ]; then
		"$SCRIPTS_DIR/mk-loader.sh"
		"$SCRIPTS_DIR/mk-kernel.sh"
		"$SCRIPTS_DIR/mk-rtos.sh"
		"$SCRIPTS_DIR/mk-firmware.sh"
		finish_build
		return 0
	fi
```

非 RTOS 常规 Linux 路径继续往下：

```24:39:device/rockchip/common/scripts/mk-all.sh
	if [ "$RK_KERNEL_CFG" ]; then
		"$SCRIPTS_DIR/mk-kernel.sh" $KERNEL_ARGC
		"$SCRIPTS_DIR/mk-rootfs.sh"
		"$SCRIPTS_DIR/mk-recovery.sh"
	fi

	if [ "$RK_SECURITY" ]; then
		"$SCRIPTS_DIR/mk-security.sh" security_ramboot
	fi

	# Will repack boot and recovery images when security enabled
	"$SCRIPTS_DIR/mk-loader.sh"

	"$SCRIPTS_DIR/mk-firmware.sh"
	"$SCRIPTS_DIR/mk-updateimg.sh"
```

所以完整主链是：

```text
build.sh
  -> mk-all.sh build_all
      -> mk-kernel.sh
      -> mk-rootfs.sh
      -> mk-recovery.sh
      -> mk-loader.sh
      -> mk-firmware.sh
      -> mk-updateimg.sh
```

这里最后两步就是你想看的“pack 全过程”。

---

## 4. pack 之前：先准备各分区镜像

### 4.1 kernel / boot.img

`mk-kernel.sh` 负责内核和 `boot.img`。

关键结果：

```184:189:device/rockchip/common/scripts/mk-kernel.sh
	if echo $1 | grep -q "^kernel"; then
		ln -rsf "kernel/$RK_BOOT_IMG" "$RK_FIRMWARE_DIR/boot.img"
		#"$SCRIPTS_DIR/check-power-domain.sh"
	fi
```

也就是：
- 内核编完后，`kernel/$RK_BOOT_IMG`
- 被软链成 `output/firmware/boot.img`

如果启用了 FIT/initrd，会在 rootfs 阶段再特殊处理。

---

### 4.2 rootfs / rootfs.img

`mk-rootfs.sh` 负责根文件系统。

buildroot / debian / yocto 都最终统一到 `ROOTFS_DIR/rootfs.${RK_ROOTFS_TYPE}`。

关键打包出口：

```195:201:device/rockchip/common/scripts/mk-rootfs.sh
	if [ "$RK_ROOTFS_INITRD" ]; then
		/usr/bin/time -f "you take %E to pack initrd image" \
			"$SCRIPTS_DIR/mk-ramdisk.sh" "$ROOTFS_DIR/$ROOTFS_IMG" \
			"$ROOTFS_DIR/boot.img" "$RK_BOOT_FIT_ITS"
		ln -rsf "$ROOTFS_DIR/boot.img" "$RK_FIRMWARE_DIR/boot.img"
	else
		ln -rsf "$ROOTFS_DIR/$ROOTFS_IMG" "$RK_FIRMWARE_DIR/rootfs.img"
	fi
```

即：

- 普通 rootfs：生成 `rootfs.img`
- initrd 模式：把 rootfs 打进 boot，最终不再单独给 `rootfs.img`

---

### 4.3 recovery.img

`mk-recovery.sh` 负责 recovery：

```24:29:device/rockchip/common/scripts/mk-recovery.sh
	/usr/bin/time -f "you take %E to pack recovery image" \
		"$SCRIPTS_DIR/mk-ramdisk.sh" "$DST_DIR/rootfs.cpio.gz" \
		"$DST_DIR/recovery.img" "$RK_RECOVERY_FIT_ITS"
	ln -rsf "$DST_DIR/recovery.img" "$RK_FIRMWARE_DIR"
```

结果是 `output/firmware/recovery.img`。

---

### 4.4 loader / uboot / trust / MiniLoaderAll.bin

`mk-loader.sh` 会编译 U-Boot 并把 loader 文件链接到 firmware 目录：

```63:69:device/rockchip/common/scripts/mk-loader.sh
	LOADER="$(echo u-boot/*_loader_*.bin | head -1)"
	ln -rsf "$LOADER" "$RK_FIRMWARE_DIR"/MiniLoaderAll.bin

	ln -rsf u-boot/uboot.img "$RK_FIRMWARE_DIR"
	[ ! -e u-boot/trust.img ] || \
		ln -rsf u-boot/trust.img "$RK_FIRMWARE_DIR"
```

所以在 pack 前，至少会准备这些核心文件：

- `MiniLoaderAll.bin`
- `uboot.img`
- `trust.img`（如果有）
- `boot.img`
- `rootfs.img` 或 initrd boot
- `recovery.img`（如果有）

---

## 5. 第一层 pack：`mk-firmware.sh`

这一步不是最终生成 `update.img`，而是把各镜像整理成可打包固件目录。

### 5.1 入口与输出目录

核心入口：

```80:99:device/rockchip/common/scripts/mk-firmware.sh
build_firmware()
{
	if ! which fakeroot &>/dev/null; then
		echo "fakeroot not found! (sudo apt-get install fakeroot)"
		exit 1
	fi

	mkdir -p "$RK_FIRMWARE_DIR" "$RK_SECURITY_FIRMWARE_DIR"
	if [ "$RK_SECURITY" ]; then
		FIRMWARE_DIR="$RK_SECURITY_FIRMWARE_DIR"
	else
		FIRMWARE_DIR="$RK_FIRMWARE_DIR"
	fi

	rm -rf "$RK_ROCKDEV_DIR"
	ln -rsf "$FIRMWARE_DIR" "$RK_ROCKDEV_DIR"
```

重点：

- 普通场景输出目录：`output/firmware`
- 安全启动场景可能使用：`output/security-firmware`
- `rockdev` 最终被链接到实际固件目录
- 后续 `mk-updateimg.sh` 就是从 `rockdev/` 里取东西

也就是说：

```text
output/firmware  <->  rockdev
```

---

### 5.2 parameter.txt 先放进去

```100:102:device/rockchip/common/scripts/mk-firmware.sh
	"$SCRIPTS_DIR/check-grow-align.sh"

	link_image "$CHIP_DIR/$RK_PARAMETER" "$RK_FIRMWARE_DIR/parameter.txt"
```

这里把板级目录下的参数文件链接成：

- `output/firmware/parameter.txt`

这个文件非常关键，后面：

- 校验分区大小
- 生成 `package-file`
- 决定 update.img 包含哪些分区

都依赖它。

---

### 5.3 misc.img 处理

`pack_misc()` 负责生成或链接 `misc.img`：

```21:43:device/rockchip/common/scripts/mk-firmware.sh
pack_misc() {
	rm -f "$RK_FIRMWARE_DIR/misc.img"
	MISC_SIZE=$(partition_size_kb misc)

	if [ "$MISC_SIZE" -eq 0 -o -z "$RK_MISC" ]; then
		[ -z "$RK_MISC" ] || message "Misc ignored"
		return 0
	fi

	if [ "$RK_MISC_BLANK" ]; then
		message "Generating blank misc..."
		"$SCRIPTS_DIR/mk-misc.sh" "$RK_FIRMWARE_DIR/misc.img"
		return 0
	fi
```

分支有三种：

- 没有 misc 分区或没配置 `RK_MISC`：不打
- `RK_MISC_BLANK`：生成空白 misc
- `RK_MISC_RECOVERY`：生成带 recovery 标记的 misc
- 否则：直接链接现成 misc 镜像

并且有一个安全检查：

```39:42:device/rockchip/common/scripts/mk-firmware.sh
	if grep -wq boot-recovery "$RK_FIRMWARE_DIR/misc.img" && \
		[ -z "$(rk_partition_size recovery)" ]; then
		fatal "This misc would not work without recovery partition!"
	fi
```

---

### 5.4 只对 buildroot rootfs 继续 pack

这里是一个非常重要的分支：

```103:108:device/rockchip/common/scripts/mk-firmware.sh
	if [[ $RK_ROOTFS_SYSTEM =~ "buildroot" ]];then
		echo -e "\e[35mIs buildroot fs, continue packing firmware\e[0m"
	else
		echo -e "\e[35mNot buildroot fs, No need continue packing firmware\e[0m"
		exit 0
	fi
```

这意味着当前这套 `mk-firmware.sh` 的“继续打额外镜像”逻辑，主要针对 buildroot 路径。

也就是：

- debian/ubuntu 这种 rootfs 可以通过前面已有的镜像参与 updateimg
- 但 `pack_extra_partitions()` 这里会直接退出，不继续做 buildroot 的额外分区打包

---

### 5.5 额外分区打包 `pack_extra_partitions()`

这一段很关键，很多厂家定制分区都是这里打出来的。

```45:77:device/rockchip/common/scripts/mk-firmware.sh
pack_extra_partitions() {
	for idx in $(seq 1 "$(rk_extra_part_num)"); do
		PART_NAME="$(rk_extra_part_name $idx)"
		FS_TYPE="$(rk_extra_part_fstype $idx)"
		SIZE="$(rk_extra_part_size $idx)"
		FAKEROOT_SCRIPT="$(rk_extra_part_fakeroot_script $idx)"
		OUTDIR="$(rk_extra_part_outdir $idx)"
		DST="$(rk_extra_part_img $idx)"

		rk_extra_part_prepare $idx

		if rk_extra_part_builtin $idx; then
			echo "Skip packing $PART_NAME (builtin)"
			continue
		fi

		if rk_extra_part_nopack $idx; then
			echo "Skip packing $PART_NAME (not packing)"
			continue
		fi
```

流程是：

1. 读取 `RK_EXTRA_PARTITION_*` 配置
2. 准备一个该分区的临时目录
3. 把若干来源目录 merge 进去
4. 生成 fakeroot 脚本
5. 调 `mk-image.sh` 做文件系统镜像

关键执行：

```68:76:device/rockchip/common/scripts/mk-firmware.sh
		sed -i '/mk-image.sh/d' "$FAKEROOT_SCRIPT"
		echo "\"$SCRIPTS_DIR/mk-image.sh\" \
			\"$OUTDIR\" \"$DST\" \"$FS_TYPE\" \
			\"$SIZE\" \"$PART_NAME\"" >> "$FAKEROOT_SCRIPT"

		message "Packing $DST from $FAKEROOT_SCRIPT"
		cd "$OUTDIR"
		fakeroot -- "$FAKEROOT_SCRIPT"
```

### 5.6 `mk-image.sh` 真正生成 `.img`

`mk-image.sh` 是底层镜像构造器，支持：

- `ext2/3/4`
- `fat/vfat`
- `ntfs`
- `ubi/ubifs`
- `squashfs`
- `jffs2`

例如 ext4：

```79:92:device/rockchip/common/scripts/mk-image.sh
    case $FS_TYPE in
        ext[234])
            if mke2fs -h 2>&1 | grep -wq "\-d"; then
                mke2fs -t $FS_TYPE $TARGET -d $SRC_DIR ${SIZE_KB}K \
                    || return 1
            else
                echo "Detected old mke2fs(doesn't support '-d' option)!"
                mke2fs -t $FS_TYPE $TARGET ${SIZE_KB}K || return 1
                copy_to_image || return 1
            fi
            tune2fs -c 0 -i 0 $TARGET ${LABEL:+-L $LABEL}
```

所以 extra partition 的本质是：

```text
目录内容 -> mk-image.sh -> xxx.img
```

---

### 5.7 固件目录内镜像大小检查

最后它会遍历所有 `.img`，检查是否超过 parameter 分区表限制：

```133:157:device/rockchip/common/scripts/mk-firmware.sh
		echo "$NAME" | grep -q ".img$" || continue

		PART_NAME="${NAME%.img}"
		PART_SIZE_KB="$(partition_size_kb "$PART_NAME")"

		if [ "$PART_NAME" = rootfs -a "$PART_SIZE_KB" -eq 0 ]; then
			PART_NAME=system
			PART_SIZE_KB="$(partition_size_kb "$PART_NAME")"
		fi

		[ ! "$PART_SIZE_KB" -eq 0 ] || continue

		FILE_SIZE_KB="$(( $(stat -Lc "%s" "$f") / 1024 ))"
		if [ "$PART_SIZE_KB" -lt "$FILE_SIZE_KB" ]; then
			fatal "error: $NAME's size exceed parameter's $PART_NAME partition size limit!"
		fi
	done
```

这一步很重要，很多 pack 失败就是这里：

- `rootfs.img` 超过 `system` 分区
- 某额外分区 img 超过 parameter 中对应定义

---

## 6. 第二层 pack：`mk-updateimg.sh`

这一层才是生成 Rockchip 升级包 `update.img`。

### 6.1 前提检查：firmware 和 loader 必须就绪

```38:53:device/rockchip/common/scripts/mk-updateimg.sh
build_updateimg()
{
	check_config RK_UPDATE || return 0

	TARGET="${1:-$RK_ROCKDEV_DIR/update.img}"
	TYPE="${2:-update}"
	PKG_FILE="${3:-$RK_PACKAGE_FILE}"
	OUT_DIR="$RK_OUTDIR/$TYPE"
	IMAGE_DIR="$OUT_DIR/Image"

	# Make sure that the firmware is ready
	if [ ! -r "$RK_ROCKDEV_DIR/parameter.txt" ]; then
		echo "Firmware is not ready, building it..."
		"$SCRIPTS_DIR/mk-firmware.sh"
	fi

	# Make sure that the loader is ready
	if [ ! -r "$RK_ROCKDEV_DIR/MiniLoaderAll.bin" ]; then
		echo "Loader is not ready, building it..."
		"$SCRIPTS_DIR/mk-loader.sh"
	fi
```

所以 `updateimg` 会自动补前置依赖。

---

### 6.2 先把 rockdev 内容链接到 `output/update/Image`

```60:66:device/rockchip/common/scripts/mk-updateimg.sh
	rm -rf "$TARGET" "$OUT_DIR"
	mkdir -p "$IMAGE_DIR"
	cd "$IMAGE_DIR"

	# Prepare images
	ln -rsf "$RK_ROCKDEV_DIR"/* .
	rm -f update.img
```

也就是：

- `rockdev/*` 全部链接到 `output/update/Image/`

这里的 `Image/` 就是 `afptool` 的输入目录。

---

### 6.3 生成 `package-file`

如果没有自定义 `RK_PACKAGE_FILE`，就自动根据 `parameter.txt` 生成。

生成逻辑在：

```5:34:device/rockchip/common/scripts/mk-updateimg.sh
gen_package_file()
{
	TYPE="${1:-update}"
	PARAMETER="${2:-parameter.txt}"
	PKG_FILE="${3:-package-file}"

	{
		echo -e "# NAME\tPATH"
		echo -e "package-file\tpackage-file"
		echo -e "parameter\tparameter.txt"
	} > "$PKG_FILE"

	if [ "$TYPE" = template -o -r MiniLoaderAll.bin ]; then
		echo -e "bootloader\tMiniLoaderAll.bin" >> "$PKG_FILE"
	fi

	for part in $(rk_partition_parse_names "$PARAMETER"); do
```

分区到镜像名的映射规则：

```20:32:device/rockchip/common/scripts/mk-updateimg.sh
		case $part in
			backup)
				echo -e "backup\tRESERVED" >> "$PKG_FILE"
				continue
				;;
			system|system_[ab]) IMAGE=rootfs.img ;;
			*_a) IMAGE="${part%_a}.img" ;;
			*_b) IMAGE="${part%_b}.img" ;;
			*) IMAGE="$part.img" ;;
		esac
```

也就是：

- `system` -> `rootfs.img`
- `boot_a` -> `boot.img`
- `boot_b` -> `boot.img`
- `vendor` -> `vendor.img`
- `backup` -> `RESERVED`

如果是 OTA 包，还会跳过 `_b` 分区：

```15:19:device/rockchip/common/scripts/mk-updateimg.sh
		if echo $part | grep -q "_b$"; then
			# Not packing *_b partition for ota
			if [ "$TYPE" = ota ]; then
				continue
			fi
		fi
```

---

### 6.4 用 `afptool + rkImageMaker` 生成 `update.img`

核心命令：

```82:85:device/rockchip/common/scripts/mk-updateimg.sh
	TAG=RK$(hexdump -s 21 -n 4 -e '4 "%c"' MiniLoaderAll.bin | rev)
	"$RK_PACK_TOOL_DIR/afptool" -pack ./ update.raw.img
	"$RK_PACK_TOOL_DIR/rkImageMaker" -$TAG MiniLoaderAll.bin \
		update.raw.img update.img -os_type:androidos
```

可理解成两层封装：

1. `afptool -pack ./ update.raw.img`
   - 把当前目录里的 `package-file + parameter + 各img`
   - 打成 `update.raw.img`

2. `rkImageMaker`
   - 再把 `MiniLoaderAll.bin + update.raw.img`
   - 封成最终可刷机的 `update.img`

其中 `TAG` 从 `MiniLoaderAll.bin` 中解析出平台标识，用于 `rkImageMaker -RKxx` 这种参数。

---

### 6.5 最终链接和命名

```86:90:device/rockchip/common/scripts/mk-updateimg.sh
	ln -rsf "$IMAGE_DIR/package-file" "$OUT_DIR"
	ln -rsf "$IMAGE_DIR/update.img" "$OUT_DIR"
	ln -rsf "$IMAGE_DIR/update.img" "$TARGET"
```

所以常见产物位置有：

- `output/update/Image/update.img`
- `output/update/update.img`
- `rockdev/update.img`

另外它还会生成一个带板型和日期的链接名：

```94:98:device/rockchip/common/scripts/mk-updateimg.sh
	echo "${RK_FIRMWARE_DIR}/update-${RK_KERNEL_DTS_NAME/\//-}-$RK_ROOTFS_SYSTEM-$LCD_NAME-$DATE.img"
	rm -rf "${RK_FIRMWARE_DIR}"/update-*.img
	ln -rsf "$IMAGE_DIR/update.img" "${RK_FIRMWARE_DIR}/update-${RK_KERNEL_DTS_NAME/\//-}-$RK_ROOTFS_SYSTEM-$LCD_NAME-$DATE.img"
```

---

## 7. 分区表在 pack 过程里的作用

`partition-helper` 是整条 pack 链的基础。

初始化发生在 `build.sh`：

```355:356:device/rockchip/common/scripts/build.sh
	source "$PARTITION_HELPER"
	rk_partition_init
```

它会把 `parameter` 里的 `CMDLINE:` 解析成内部表。

比如：

- `rk_partition_parse_names`
- `rk_partition_size`

供后续使用。

### pack 中具体用途有三类：

#### 7.1 控制 `package-file` 里要打哪些分区

`mk-updateimg.sh` 用 `rk_partition_parse_names "$PARAMETER"` 生成打包条目。

#### 7.2 控制每个镜像的最大允许大小

`mk-firmware.sh` 用 `rk_partition_size "$PART_NAME"` 做镜像大小校验。

#### 7.3 控制 extra partition 的 max/autosize

如果某额外分区配置成 `max`：

```58:67:device/rockchip/common/scripts/mk-firmware.sh
		if [ "$SIZE" = max ]; then
			SIZE="$(partition_size_kb "$PART_NAME")K"
			if [ "$SIZE" = 0K ]; then
				if [ "$FS_TYPE" != ubi ]; then
					fatal "Unable to detect max size of $PART_NAME"
				fi
```

它会去 parameter 表里反查这个分区的大小，作为镜像大小上限。

---

## 8. A/B 更新分支

如果启用了 `RK_AB_UPDATE`，`updateimg` 不是普通模式，而是走 A/B。

入口：

```107:119:device/rockchip/common/scripts/mk-updateimg.sh
build_ab_updateimg()
{
	check_config RK_AB_UPDATE || return 0

	build_ota_updateimg

	echo "Make A/B update image"

	build_updateimg "$RK_ROCKDEV_DIR/update_ab.img" ab
```

对应：

- `otapackage` -> 生成 `update_ota.img`
- `updateimg` -> A/B 时会先生成 ota，再生成 `update_ab.img`

`package-file` 生成时：
- `ota` 类型会跳过 `_b`
- `ab` 类型则会保留 A/B 分区

---

## 9. security 分支

如果启用 `RK_SECURITY`，流程多一层：

- 先做 security check / ramboot
- 再 `mk-loader.sh`
- `mk-loader.sh` 会把安全相关的 `boot.img/recovery.img` 放进 `output/security-firmware`
- `mk-firmware.sh` 会优先把 `rockdev` 链到 `output/security-firmware`

关键切换点：

```88:93:device/rockchip/common/scripts/mk-firmware.sh
	if [ "$RK_SECURITY" ]; then
		FIRMWARE_DIR="$RK_SECURITY_FIRMWARE_DIR"
	else
		FIRMWARE_DIR="$RK_FIRMWARE_DIR"
	fi

	rm -rf "$RK_ROCKDEV_DIR"
	ln -rsf "$FIRMWARE_DIR" "$RK_ROCKDEV_DIR"
```

这意味着：

- 非安全启动：`rockdev -> output/firmware`
- 安全启动：`rockdev -> output/security-firmware`

---

## 10. 你可以把整个“pack 全过程”理解成这张链路

### 普通 Linux 默认 `./build.sh`

```text
build.sh
  -> 读取 output/.config
  -> 读取并解析 parameter 分区表
  -> mk-all.sh build_all
      -> mk-kernel.sh
           生成 boot.img
      -> mk-rootfs.sh
           生成 rootfs.img 或 initrd boot.img
      -> mk-recovery.sh
           生成 recovery.img
      -> mk-loader.sh
           生成 MiniLoaderAll.bin / uboot.img / trust.img
      -> mk-firmware.sh
           组装 output/firmware
           链接 parameter.txt
           处理 misc.img
           打额外分区 *.img
           校验各 img 是否超出分区大小
           建立 rockdev -> firmware
      -> mk-updateimg.sh
           复制/链接 rockdev/* 到 output/update/Image
           根据 parameter 生成 package-file
           afptool 打出 update.raw.img
           rkImageMaker + MiniLoaderAll.bin 封装 update.img
```

---

## 11. 最重要的几个目录和产物

### 输入侧
- `output/.config`：RK 构建配置
- `device/rockchip/.chip/.../parameter*.txt`：分区表
- `u-boot/`：loader 构建输出
- `kernel/`：boot.img 来源
- `output/rootfs/`：rootfs 来源

### 中间产物
- `output/firmware/`
- `output/security-firmware/`
- `rockdev/`

### 最终产物
- `rockdev/update.img`
- `output/update/Image/update.img`
- `output/update/package-file`
- `output/firmware/update-xxx.img`（软链接名）

---

## 12. 常见失败点

### 12.1 rootfs 或某分区镜像超尺寸
报错点通常在 `mk-firmware.sh`：
- `xxx.img's size exceed parameter's xxx partition size limit`

原因：
- parameter 分区太小
- rootfs 变大
- extra partition 内容过多

---

### 12.2 `MiniLoaderAll.bin` 缺失
`mk-updateimg.sh` 会直接失败或先触发 `mk-loader.sh`。

---

### 12.3 `fakeroot` 未安装
`mk-firmware.sh` 一开始就检查：

```81:84:device/rockchip/common/scripts/mk-firmware.sh
	if ! which fakeroot &>/dev/null; then
		echo "fakeroot not found! (sudo apt-get install fakeroot)"
		exit 1
	fi
```

---

### 12.4 package-file 与 parameter 不一致
如果你自定义了 `RK_PACKAGE_FILE`，但里面条目和实际分区不一致，可能会导致：
- update 包漏分区
- 升级异常
- A/B 包不正确

---

### 12.5 Debian/Ubuntu 路径与 buildroot 路径行为不同
这个 SDK 明显偏向 buildroot 打包链：
- `mk-firmware.sh` 里非 buildroot 会提前退出“继续打包额外分区”的流程
- 所以如果你用 Debian/Ubuntu，某些额外分区逻辑不一定自动走全

---

## 13. 如果你专门想看“pack”最核心的三个脚本

按优先级建议你重点看这三个：

1. `device/rockchip/common/scripts/mk-firmware.sh`
   - 整理固件目录
   - 打额外分区
   - 校验镜像大小

2. `device/rockchip/common/scripts/mk-updateimg.sh`
   - 生成 `package-file`
   - 调 `afptool/rkImageMaker`
   - 生成 `update.img`

3. `device/rockchip/common/scripts/partition-helper`
   - 决定 pack 的分区集合和大小约束

---

## 14. 一句话总结

这个 RK SDK 的 `build.sh pack` 本质不是单一命令，而是一条两阶段封装链：

- 第一阶段 `mk-firmware.sh`：把各分区镜像按 `parameter.txt` 组织成 `rockdev/`
- 第二阶段 `mk-updateimg.sh`：用 `package-file + parameter.txt + MiniLoaderAll.bin` 调 `afptool` 和 `rkImageMaker` 生成最终 `update.img`

如果你愿意，我下一步可以继续帮你做两件事里的任意一种：

1. 结合你这个 SDK 的实际板级配置，画一张“RK3568 当前工程的 pack 时序图”
2. 逐行分析 `mk-updateimg.sh` 和 `package-file / parameter.txt` 的对应关系，告诉你每个分区最终怎么进 `update.img`

