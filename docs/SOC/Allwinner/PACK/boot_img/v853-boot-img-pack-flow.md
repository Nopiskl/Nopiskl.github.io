# V853 boot.img pack flow

本文记录原厂 Tina SDK 中 `v853-100ask` 板级方案的 `boot.img` 内容，以及它在 build/pack 流程中如何生成、如何进入最终固件镜像。

## 结论

当前 `out/v853-100ask/boot.img` 是一个 Android boot image 格式的内核容器，主要包含：

- Android boot image header
- Linux kernel `zImage`
- 一个占位用的 12 字节 fake ramdisk

它当前不包含：

- `rootfs.img` / `rootfs.fex`
- `sunxi.dtb` / `sunxi.fex`
- `boot-resource.fex`
- `u-boot.fex` / `boot_package.fex`
- `boot0_nand.fex` / `boot0_sdcard.fex` / `boot0_spinor.fex`
- `optee.fex`

这些文件在 pack 阶段作为其他分区或启动组件进入最终固件，并不在当前 `boot.img` 内部。

## 当前实测内容

当前产物：

```text
out/v853-100ask/boot.img
out/v853-100ask/v853-100ask-boot.img
out/v853-100ask/image/boot.fex
out/v853-100ask/image/kernel.fex
```

上述文件内容一致，`boot.fex` 和 `kernel.fex` 是 pack 阶段指向 `boot.img` 的镜像文件名。

解析 `out/v853-100ask/boot.img` 的 Android boot image header：

```text
magic                 = ANDROID!
boot.img size         = 3,960,832 bytes
board name            = v853-100ask
cmdline               = empty
page_size             = 2048
kernel_size           = 3,955,768 bytes
kernel_addr           = 0x40008000
ramdisk_size          = 12 bytes
ramdisk_addr          = 0x41000000
second_size           = 0
dt_size               = 0
kernel payload offset = 2048
ramdisk offset        = 3,958,784
```

其中 kernel payload 和以下文件完全一致：

```text
out/v853-100ask/compile_dir/target/linux-v853-100ask/zImage
```

fake ramdisk 来源于：

```text
target/allwinner/generic/image/ramdisk.img
```

该文件只有 12 字节，内容是：

```text
ramdisk.img\n
```

所以当前 `boot.img` 的实际内容可以简化理解为：

```text
[Android boot header, 2048 bytes]
[zImage payload, 3,955,768 bytes]
[padding to 2048-byte page]
[fake ramdisk payload, 12 bytes]
[padding to 2048-byte page]
```

## build 阶段如何生成 boot.img

普通情况下，`boot.img` 不是由 `pack_img.sh` 首次生成，而是在 OpenWrt/Tina image build 阶段生成。

核心规则在：

```text
target/allwinner/generic/image/Makefile
```

当前 ARM/v853 默认参数：

```make
LOAD_ADDRESS:=0x40008000
ENTRY_POINT:=0x40008000
BASE_ADDRESS:=0x40000000
KERNEL_OFFSET:=0x8000
RAMDISK_OFFSET:=0x01000000
IMAGE_DATA:=zImage
BOOTIMG_IMAGE_DATA:=zImage
RAMDISK:=ramdisk.img
UIMAGE_NAME:=uImage
BOOTIMG_NAME:=boot.img
```

`mkBootimg` 宏：

```make
define mkBootimg
mkbootimg --kernel $(1) \
	--ramdisk $(2) \
	--board $(3) \
	--base $(4) \
	--kernel_offset $(5) \
	--ramdisk_offset $(6) \
	-o $(7)
endef
```

当前配置未打开压缩内核直出模式：

```text
# CONFIG_SUNXI_MKBOOTIMG_WITH_COMPRESS_KERNEL is not set
```

因此 `Image/BuildKernel` 走普通 `mkBootimg` 分支：

```make
$(call mkBootimg, \
	$(KDIR)/$(BOOTIMG_IMAGE_DATA), \
	$(RAMDISK), \
	$(shell echo $(IMG_PREFIX) | cut -c 1-16 ), \
	${BASE_ADDRESS}, \
	${KERNEL_OFFSET}, \
	${RAMDISK_OFFSET}, \
	$(TARGET_OUT_DIR)/$(IMG_PREFIX)-$(BOOTIMG_NAME),\
	)
```

结合当前板级，等价命令大致是：

```sh
mkbootimg \
  --kernel out/v853-100ask/compile_dir/target/linux-v853-100ask/zImage \
  --ramdisk target/allwinner/generic/image/ramdisk.img \
  --board v853-100ask \
  --base 0x40000000 \
  --kernel_offset 0x8000 \
  --ramdisk_offset 0x01000000 \
  -o out/v853-100ask/v853-100ask-boot.img
```

当前 `.config` 中配置为 bootimg 格式：

```text
# CONFIG_SUNXI_SD_BOOT_KERNEL_FORMAT_UIMAGE is not set
CONFIG_SUNXI_SD_BOOT_KERNEL_FORMAT_BOOTIMG=y
# CONFIG_SUNXI_MKBOOTIMG_ADD_DTB is not set
```

所以 `Image/InstallKernel` 会把 `$(IMG_PREFIX)-boot.img` 复制为最终 build out 目录下的 `boot.img`：

```make
$(CP) $(TARGET_OUT_DIR)/$(IMG_PREFIX)-$(BOOTIMG_NAME) $(TARGET_OUT_DIR)/${TARGET_BOOT_IMG}
```

对应当前输出：

```text
out/v853-100ask/v853-100ask-boot.img
  -> out/v853-100ask/boot.img
```

## pack 阶段如何使用 boot.img

pack 入口在环境脚本的 `pack()` 函数中：

```text
build/envsetup.sh
```

它调用：

```sh
scripts/pack_img.sh -c $chip -p $platform -b $board \
	-d $debug -s $sigmode -m $mode -w $programmer -v $securemode -i $tar_image -t $T
```

`scripts/pack_img.sh` 的主流程末尾是：

```sh
do_prepare
do_ini_to_dts
mkdtbo
do_common

grep "CONFIG_SUNXI_MKBOOTIMG_ADD_DTB=y" ${PACK_TOPDIR}/.config > /dev/null
if [ $? -eq 0 ]; then
	do_mkbootimg_add_dtb
fi

do_pack_${PACK_PLATFORM}
do_finish
```

当前 platform 是 Tina/Linux，所以会执行：

```sh
do_pack_tina
```

在 `do_pack_tina()` 中，`boot.img` 被映射为 `boot.fex`：

```sh
if [ -f ${ROOT_DIR}/boot_initramfs.img ]; then
	ln -s ${ROOT_DIR}/boot_initramfs.img        boot.fex
else
	ln -s ${ROOT_DIR}/boot.img        boot.fex
fi

# sys_partition_nor.fex in longan may use kernel.fex
ln -s boot.fex        kernel.fex
```

当前 `.config` 未启用 initramfs rootfs：

```text
# CONFIG_TARGET_ROOTFS_INITRAMFS is not set
```

因此实际使用：

```text
out/v853-100ask/boot.img
  -> out/v853-100ask/image/boot.fex
  -> out/v853-100ask/image/kernel.fex
```

随后 `sys_partition.fex` 指定 `boot` 分区下载 `boot.fex`：

```ini
[partition]
    name         = boot
    ;size         = 4096
    size         = 25200
    downloadfile = "boot.fex"
    user_type    = 0x8000
```

最后 `do_finish()` 调用 `dragon` 生成最终固件：

```sh
do_dragon image.cfg sys_partition_for_dragon.fex
```

最终输出类似：

```text
out/v853-100ask/tina_v853-100ask_uart0.img
```

## dtb 是否进入 boot.img

当前没有进入。

依据是：

```text
# CONFIG_SUNXI_MKBOOTIMG_ADD_DTB is not set
```

并且当前 `boot.img` header 中：

```text
dt_size = 0
```

`pack_img.sh` 中确实有一个可选函数 `do_mkbootimg_add_dtb()`，当 `CONFIG_SUNXI_MKBOOTIMG_ADD_DTB=y` 时，它会在 pack 阶段删除已有 `boot.img` 并重新执行：

```sh
mkbootimg \
  --kernel ${KDIR}/${BOOTIMG_IMAGE_DATA} \
  --ramdisk ${RDIR}/${RAMDISK} \
  --dtb ${DTB} \
  --board ${CUT_PACK_BOARD_NAME} \
  --base ${BASE_ADDRESS} \
  --kernel_offset ${KERNEL_OFFSET} \
  --ramdisk_offse ${RAMDISK_OFFSET} \
  --dtb_offset ${DTB_OFFSET} \
  --header_version ${HEADER_VERSION} \
  -o ${ROOT_DIR}/boot.img
```

注意：脚本里 `--ramdisk_offse` 少了最后的 `t`。如果后续要启用 `CONFIG_SUNXI_MKBOOTIMG_ADD_DTB`，需要先确认当前 `mkbootimg` 工具是否兼容这个拼写，否则可能导致 pack 阶段生成失败。

## secure pack 对 boot.img 的影响

普通 pack 下，`boot.fex` 基本就是 `boot.img` 本体。

secure pack 下，`do_signature()` 会检查 `boot.fex` 的 magic 必须是 `ANDROID!`，然后调用：

```sh
sigbootimg --image boot.fex --cert toc1/cert/boot.der --output boot_sig.fex
mv -f boot_sig.fex boot.fex
```

也就是说 secure 模式会把证书/签名信息追加或封装到 `boot.fex`，但这属于 pack 签名阶段，不是普通 build 阶段 `boot.img` 的原始内容。

## 完整流程概览

```text
linux kernel build
  -> out/v853-100ask/compile_dir/target/linux-v853-100ask/zImage

target/allwinner/generic/image/Makefile
  -> mkbootimg --kernel zImage --ramdisk ramdisk.img ...
  -> out/v853-100ask/v853-100ask-boot.img

Image/InstallKernel
  -> out/v853-100ask/boot.img

pack()
  -> scripts/pack_img.sh

do_pack_tina()
  -> out/v853-100ask/image/boot.fex
  -> out/v853-100ask/image/kernel.fex

sys_partition.fex
  -> boot partition downloads boot.fex

dragon
  -> out/v853-100ask/tina_v853-100ask_uart0.img
```

## 常见混淆点

### boot.img 和 boot.fex

`boot.img` 是 build out 目录中的 Android boot image。

`boot.fex` 是 pack 阶段使用的下载文件名，当前内容与 `boot.img` 一致，用于写入 `boot` 分区。

### boot.img 和 boot_package.fex

这两个不是一回事。

`boot.img` 是 Linux kernel 容器，最终进入 `boot` 分区。

`boot_package.fex` 是 bootloader package，主要和 `u-boot`、`optee`、`dtb` 等启动链组件有关。当前 `boot_package.cfg` 中包含：

```ini
[package]
item=optee,                  optee.fex
item=u-boot,                 u-boot.fex
item=dtb,                    sunxi.fex
```

### boot.img 和 rootfs.img

当前不是 initramfs 启动模式，所以 rootfs 不在 `boot.img` 中。

rootfs 单独生成：

```text
out/v853-100ask/rootfs.img
```

pack 阶段映射为：

```text
out/v853-100ask/image/rootfs.fex
```

然后由 `sys_partition.fex` 写入 `rootfs` 分区。

## 关键文件索引

```text
build/envsetup.sh
  pack() 入口，调用 scripts/pack_img.sh

target/allwinner/generic/image/Makefile
  build 阶段生成 boot.img 的 mkbootimg 规则

target/allwinner/generic/image/ramdisk.img
  fake ramdisk，占位用

scripts/pack_img.sh
  pack 阶段把 boot.img 映射为 boot.fex，并调用 dragon 生成最终固件

out/v853-100ask/boot.img
  当前板级 build 阶段生成的 boot image

out/v853-100ask/image/boot.fex
  pack 阶段写入 boot 分区的文件

out/v853-100ask/image/sys_partition.fex
  分区布局，指定 boot 分区 downloadfile = "boot.fex"
```
