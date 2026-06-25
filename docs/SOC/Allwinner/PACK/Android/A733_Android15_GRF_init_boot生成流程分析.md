# A733 Android15 GRF init_boot.img 生成流程分析

本文是 `A733_Android15_GRF分区与打包流程分析.md` 的后续补充，专门分析当前原厂 SDK / GRF 模式下 `init_boot.img` 是如何生成、签名、进入 GRF 镜像目录，并最终被 longan pack 成 `init_boot.fex` 的。

结论先行：

- 当前 SDK 中，`init_boot.img` 不是 longan 生成的，也不是 BSP 私有工具手工生成的，而是走 AOSP `build/make/core/Makefile` 中的标准 `mkbootimg` 规则。
- `init_boot.img` 的输入是 `ramdisk.img`，而 `ramdisk.img` 来自 Android generic ramdisk，即 `TARGET_RAMDISK_OUT`。
- A733 配置了 `BOARD_RAMDISK_USE_LZ4 := true`，所以 `ramdisk.img` 是 `mkbootfs` 输出后再用 `lz4` 压缩得到的。
- A733 配置了 `BOARD_INIT_BOOT_IMAGE_PARTITION_SIZE` 和 `BOARD_MKBOOTIMG_INIT_ARGS += --header_version 4`，因此 AOSP 会生成 header v4 的 `init_boot.img`。
- GRF framework 构建阶段会重新生成 `init_boot.img`；但 `boot.img` 在当前 GRF 输出里是从 vendor target_files 抽出来的 `frozen-boot.raw` 直接复制的。
- 因此当前产物里会出现一个重要现象：`boot.img` 是 Android14 vendor frozen boot，`init_boot.img` 是 Android15 framework 侧现编。
- longan pack 不生成 `init_boot.img`，它只是根据 `sys_partition.fex` 中的 `downloadfile = "init_boot.fex"` 把 `init_boot.fex` 链接到已有的 `init_boot.img`。

## 1. 关键文件

本次分析涉及以下文件：

```text
android15/build/make/core/board_config.mk
android15/build/make/core/Makefile
android15/build/make/core/main.mk
android15/build/make/target/product/generic_ramdisk.mk
android15/build/make/tools/releasetools/add_img_to_target_files.py
android15/build/make/tools/releasetools/common.py

android15/device/softwinner/jupiter/BoardConfig.mk
android15/device/softwinner/jupiter/common/system/config.mk
android15/device/softwinner/common/grf/config.mk
android15/device/softwinner/common/grf/boot.mk
android15/device/softwinner/common/scripts/func_make.sh
android15/device/softwinner/common/scripts/func_pack.sh

android14/longan/build/pack
android14/longan/build/hook/pack/android13/android.conf
```

当前已有产物路径以 `a733-x733mhn_aic8800` 为例：

```text
android15/out/target/product/a733-x733mhn_aic8800/ramdisk.img
android15/out/target/product/a733-x733mhn_aic8800/init_boot.img
android15/out/target/product/a733-x733mhn_aic8800/boot.img
android15/out/target/product/a733-x733mhn_aic8800/frozen-boot.raw
android15/out/target/product/a733-x733mhn_aic8800/grf_target/IMAGES/init_boot.img
android15/longan/out/a733/x733mhn_aic8800/pack_out/init_boot.fex
```

## 2. AOSP 什么时候会生成 init_boot.img

AOSP 中是否生成 `init_boot.img`，由 `BUILDING_INIT_BOOT_IMAGE` 变量决定。判断逻辑在：

```text
android15/build/make/core/board_config.mk
```

关键逻辑：

```make
BUILDING_INIT_BOOT_IMAGE :=
ifeq ($(PRODUCT_BUILD_INIT_BOOT_IMAGE),)
  ifeq ($(BOARD_USES_RECOVERY_AS_BOOT),true)
    BUILDING_INIT_BOOT_IMAGE :=
  else ifdef BOARD_PREBUILT_INIT_BOOT_IMAGE
    BUILDING_INIT_BOOT_IMAGE :=
  else ifdef BOARD_INIT_BOOT_IMAGE_PARTITION_SIZE
    BUILDING_INIT_BOOT_IMAGE := true
  endif
else ifeq ($(PRODUCT_BUILD_INIT_BOOT_IMAGE),true)
  ifeq ($(BOARD_USES_RECOVERY_AS_BOOT),true)
    $(error PRODUCT_BUILD_INIT_BOOT_IMAGE is true, but so is BOARD_USES_RECOVERY_AS_BOOT. Use only one option.)
  else
    BUILDING_INIT_BOOT_IMAGE := true
  endif
endif
```

也就是说，默认情况下满足以下条件就会生成：

```text
PRODUCT_BUILD_INIT_BOOT_IMAGE 没有被显式设为 false
BOARD_USES_RECOVERY_AS_BOOT != true
没有定义 BOARD_PREBUILT_INIT_BOOT_IMAGE
定义了 BOARD_INIT_BOOT_IMAGE_PARTITION_SIZE
```

A733 平台正好满足这些条件。

## 3. A733 如何打开 init_boot.img

A733 平台 BoardConfig 中定义了 `BOARD_INIT_BOOT_IMAGE_PARTITION_SIZE`：

```text
android15/device/softwinner/jupiter/BoardConfig.mk
```

关键配置：

```make
BOARD_BOOTIMAGE_PARTITION_SIZE := $(call get_partition_size,boot,$(PARTITION_CFG_FILE))
# init_boot is added in Android13, required by GKI2.0
BOARD_INIT_BOOT_IMAGE_PARTITION_SIZE := $(call get_partition_size,init_boot,$(PARTITION_CFG_FILE))
```

这里的 `get_partition_size,init_boot` 会从产品侧 `sys_partition.fex` 中读取 `init_boot_a` 的大小。

对应分区配置：

```ini
[partition]
    name         = init_boot_a
    size         = 8M
    downloadfile = "init_boot.fex"
    user_type    = 0x8000

[partition]
    name         = init_boot_b
    size         = 8M
    user_type    = 0x8000
```

因此：

```text
BOARD_INIT_BOOT_IMAGE_PARTITION_SIZE = 8M = 8388608 bytes
```

BoardConfig 中还明确设置了 init_boot header 版本：

```make
# init_boot
BOARD_INIT_BOOT_HEADER_VERSION := 4
BOARD_MKBOOTIMG_INIT_ARGS += --header_version $(BOARD_INIT_BOOT_HEADER_VERSION)
```

也就是：

```text
BOARD_MKBOOTIMG_INIT_ARGS = --header_version 4
```

另外，A733 BoardConfig 中特别注释了不能打开 `BOARD_USES_RECOVERY_AS_BOOT`：

```make
# BOARD_USES_RECOVERY_AS_BOOT is needed for devices launching with Android12
# For devices launching with Andorid13, we use init_boot, this option must be turned off.
# Otherwise, build system won't build init_boot.img
# BOARD_USES_RECOVERY_AS_BOOT := true
```

这正好对应 AOSP `board_config.mk` 中的判断：如果 `BOARD_USES_RECOVERY_AS_BOOT=true`，就不会生成 `init_boot.img`。

## 4. init_boot.img 的输入是 ramdisk.img

`init_boot.img` 的输入不是某个 boot.img，也不是 vendor_boot.img，而是：

```text
$(INSTALLED_RAMDISK_TARGET)
```

展开到当前产品就是：

```text
android15/out/target/product/a733-x733mhn_aic8800/ramdisk.img
```

`ramdisk.img` 的生成规则在：

```text
android15/build/make/core/Makefile
```

关键规则：

```make
BUILT_RAMDISK_TARGET := $(PRODUCT_OUT)/ramdisk.img

ifeq ($(BOARD_RAMDISK_USE_LZ4),true)
COMPRESSION_COMMAND_DEPS := $(LZ4)
COMPRESSION_COMMAND := $(LZ4) -l -12 --favor-decSpeed
RAMDISK_EXT := .lz4
else
COMPRESSION_COMMAND_DEPS := $(GZIP)
COMPRESSION_COMMAND := $(GZIP)
RAMDISK_EXT := .gz
endif

INSTALLED_RAMDISK_TARGET := $(BUILT_RAMDISK_TARGET)
$(INSTALLED_RAMDISK_TARGET): PRIVATE_DIRS := debug_ramdisk dev metadata mnt proc second_stage_resources sys
$(INSTALLED_RAMDISK_TARGET): $(MKBOOTFS) $(RAMDISK_NODE_LIST) $(INTERNAL_RAMDISK_FILES) $(INSTALLED_FILES_FILE_RAMDISK) | $(COMPRESSION_COMMAND_DEPS)
	$(hide) mkdir -p $(addprefix $(TARGET_RAMDISK_OUT)/,$(PRIVATE_DIRS))
ifeq (true,$(BOARD_USES_GENERIC_KERNEL_IMAGE))
	$(hide) mkdir -p $(addprefix $(TARGET_RAMDISK_OUT)/first_stage_ramdisk/,$(PRIVATE_DIRS))
endif
	$(hide) $(MKBOOTFS) -n $(RAMDISK_NODE_LIST) -d $(TARGET_OUT) $(TARGET_RAMDISK_OUT) | $(COMPRESSION_COMMAND) > $@
```

A733 在 Virtual A/B 时设置：

```make
BOARD_RAMDISK_USE_LZ4 := true
```

所以当前 `ramdisk.img` 的实际生成命令是：

```bash
out/host/linux-x86/bin/mkbootfs \
  -n out/target/product/a733-x733mhn_aic8800/ramdisk_node_list \
  -d out/target/product/a733-x733mhn_aic8800/system \
  out/target/product/a733-x733mhn_aic8800/ramdisk \
| out/host/linux-x86/bin/lz4 -l -12 --favor-decSpeed \
> out/target/product/a733-x733mhn_aic8800/ramdisk.img
```

当前 `file` 结果也能验证：

```text
ramdisk.img: LZ4 compressed data
```

## 5. ramdisk.img 的内容来自 generic ramdisk

A733 产品配置中继承了 AOSP generic ramdisk：

```text
android15/device/softwinner/jupiter/common/system/config.mk
```

关键配置：

```make
$(call inherit-product, $(SRC_TARGET_DIR)/product/generic_ramdisk.mk)
```

`generic_ramdisk.mk` 中至少加入：

```make
PRODUCT_PACKAGES += \
    init_first_stage \
    snapuserd_ramdisk
```

当前 `ramdisk/` 目录中的实物内容主要包括：

```text
init
system/bin/snapuserd_ramdisk
system/bin/snapuserd -> snapuserd_ramdisk
system/etc/init/snapuserd.rc
system/etc/ramdisk/build.prop
dev/
proc/
sys/
metadata/
mnt/
debug_ramdisk/
second_stage_resources/
first_stage_ramdisk/
```

用 `lz4 -dc ramdisk.img | cpio -it` 查看，能看到：

```text
dev
dev/null
dev/console
dev/urandom
debug_ramdisk
first_stage_ramdisk
init
metadata
mnt
proc
second_stage_resources
sys
system
system/bin
system/bin/snapuserd
system/bin/snapuserd_ramdisk
system/etc
system/etc/init
system/etc/init/snapuserd.rc
system/etc/ramdisk
system/etc/ramdisk/build.prop
```

因此 `init_boot.img` 中的 ramdisk 是 Android generic ramdisk，不是 vendor ramdisk。

两者区别：

```text
generic ramdisk -> init_boot.img
vendor ramdisk  -> vendor_boot.img
```

如果要修改 `init_boot.img` 的内容，应当修改 generic ramdisk 输入；如果要修改驱动模块、vendor first stage fstab、vendor init rc 等，通常影响的是 `vendor_boot.img`。

## 6. init_boot.img 的 mkbootimg 规则

真正生成 `init_boot.img` 的规则在：

```text
android15/build/make/core/Makefile
```

关键规则：

```make
ifeq ($(BUILDING_INIT_BOOT_IMAGE),true)

INSTALLED_INIT_BOOT_IMAGE_TARGET := $(PRODUCT_OUT)/init_boot.img
$(INSTALLED_INIT_BOOT_IMAGE_TARGET): $(MKBOOTIMG) $(INSTALLED_RAMDISK_TARGET)

INTERNAL_INIT_BOOT_IMAGE_ARGS := --ramdisk $(INSTALLED_RAMDISK_TARGET)

ifdef BOARD_KERNEL_PAGESIZE
  INTERNAL_INIT_BOOT_IMAGE_ARGS += --pagesize $(BOARD_KERNEL_PAGESIZE)
endif

ifeq ($(BOARD_AVB_ENABLE),true)
$(INSTALLED_INIT_BOOT_IMAGE_TARGET): $(AVBTOOL) $(BOARD_AVB_INIT_BOOT_KEY_PATH)
	$(call pretty,"Target init_boot image: $@")
	$(MKBOOTIMG) $(INTERNAL_INIT_BOOT_IMAGE_ARGS) $(INTERNAL_MKBOOTIMG_VERSION_ARGS) $(BOARD_MKBOOTIMG_INIT_ARGS) --output "$@"
	$(call assert-max-image-size,$@,$(BOARD_INIT_BOOT_IMAGE_PARTITION_SIZE))
	$(AVBTOOL) add_hash_footer \
           --image $@ \
	   $(call get-partition-size-argument,$(BOARD_INIT_BOOT_IMAGE_PARTITION_SIZE)) \
	   --partition_name init_boot $(INTERNAL_AVB_INIT_BOOT_SIGNING_ARGS) \
	   $(BOARD_AVB_INIT_BOOT_ADD_HASH_FOOTER_ARGS)
endif
```

对当前 A733 产品展开后，实际 `mkbootimg` 命令是：

```bash
out/host/linux-x86/bin/mkbootimg \
  --ramdisk out/target/product/a733-x733mhn_aic8800/ramdisk.img \
  --header_version 4 \
  --output out/target/product/a733-x733mhn_aic8800/init_boot.img
```

这里没有 `--kernel`，所以 `init_boot.img` 不包含 kernel，只包含 ramdisk。

当前实测解包结果：

```text
boot magic: ANDROID!
kernel_size: 0
ramdisk size: 3052590
os version: None
os patch level: None
boot image header version: 4
command line args:
boot.img signature size: 0
```

这和 Android 13+ GKI2.0 的设计一致：

```text
boot.img       放 kernel
init_boot.img  放 generic ramdisk
vendor_boot.img 放 vendor ramdisk、DTB、bootconfig
```

## 7. AVB footer 如何加到 init_boot.img

A733 平台启用了 AVB：

```make
BOARD_AVB_ENABLE := true
```

所以 `mkbootimg` 生成初始 `init_boot.img` 后，会继续调用：

```bash
avbtool add_hash_footer
```

当前实际命令为：

```bash
out/host/linux-x86/bin/avbtool add_hash_footer \
  --image out/target/product/a733-x733mhn_aic8800/init_boot.img \
  --partition_size 8388608 \
  --partition_name init_boot \
  --prop com.android.build.init_boot.os_version:15 \
  --prop com.android.build.init_boot.fingerprint:$(cat out/target/product/a733-x733mhn_aic8800/build_fingerprint.txt) \
  --prop com.android.build.init_boot.security_patch:2025-06-05
```

这些 AVB property 来自 AOSP Makefile 中自动追加的配置：

```make
INIT_BOOT_OS_VERSION ?= $(PLATFORM_VERSION_LAST_STABLE)
BOARD_AVB_INIT_BOOT_ADD_HASH_FOOTER_ARGS += \
    --prop com.android.build.init_boot.os_version:$(INIT_BOOT_OS_VERSION)

BOARD_AVB_INIT_BOOT_ADD_HASH_FOOTER_ARGS += \
    --prop com.android.build.init_boot.fingerprint:$(BUILD_FINGERPRINT_FROM_FILE)

ifdef INIT_BOOT_SECURITY_PATCH
BOARD_AVB_INIT_BOOT_ADD_HASH_FOOTER_ARGS += \
    --prop com.android.build.init_boot.security_patch:$(INIT_BOOT_SECURITY_PATCH)
else ifdef BOOT_SECURITY_PATCH
BOARD_AVB_INIT_BOOT_ADD_HASH_FOOTER_ARGS += \
    --prop com.android.build.init_boot.security_patch:$(BOOT_SECURITY_PATCH)
endif
```

最终 `init_boot.img` 大小被填充/限制到 `init_boot` 分区大小：

```text
8388608 bytes = 8M
```

当前实物：

```text
ramdisk.img    约 3.0M
init_boot.img  8.0M
```

## 8. GRF 模式下 boot.img 和 init_boot.img 不是同源

这是本次新增分析中最重要的点。

当前 GRF framework 构建阶段，`boot.img` 是 prebuilt/frozen，`init_boot.img` 是当前 framework 侧现编。

全志 GRF 配置：

```text
android15/device/softwinner/common/grf/boot.mk
```

关键配置：

```make
ifeq ($(CONFIG_AW_BUILD_FRAMEWORK_TARGET_FILE_ONLY),true)
BOARD_PREBUILT_BOOTIMAGE := $(PRODUCT_OUT)/frozen-boot.raw
TARGET_NO_KERNEL := true
BOARD_USES_GENERIC_KERNEL_IMAGE := true
BOARD_MOVE_GSI_AVB_KEYS_TO_VENDOR_BOOT := true

BOARD_PREBUILT_VENDORIMAGE := $(PRODUCT_OUT)/frozen-vendor.raw
BOARD_PREBUILT_VENDOR_DLKMIMAGE := $(PRODUCT_OUT)/frozen-vendor_dlkm.raw
BOARD_PREBUILT_SYSTEM_DLKMIMAGE := $(PRODUCT_OUT)/frozen-system_dlkm.raw
BOARD_PREBUILT_DTBOIMAGE := $(PRODUCT_OUT)/frozen-dtbo.raw
BOARD_PREBUILT_VENDOR_BOOTIMAGE := $(PRODUCT_OUT)/frozen-vendor_boot.raw
BOARD_DTBOIMG_PARTITION_SIZE := $(call get_partition_size,dtbo,$(PARTITION_CFG_FILE))
endif
```

这里设置了：

```text
BOARD_PREBUILT_BOOTIMAGE
BOARD_PREBUILT_VENDOR_BOOTIMAGE
BOARD_PREBUILT_DTBOIMAGE
BOARD_PREBUILT_VENDORIMAGE
BOARD_PREBUILT_VENDOR_DLKMIMAGE
BOARD_PREBUILT_SYSTEM_DLKMIMAGE
```

但没有设置：

```text
BOARD_PREBUILT_INIT_BOOT_IMAGE
```

所以：

```text
boot.img       走 frozen/prebuilt
vendor_boot.img 走 frozen/prebuilt
init_boot.img  走当前 Android15 framework 现编
```

## 9. boot.img 为什么仍然带 ramdisk

正常 AOSP 源码现编 `boot.img` 时，如果 `BUILDING_INIT_BOOT_IMAGE=true`，`boot.img` 不会再带 generic ramdisk。规则在：

```text
android15/build/make/core/Makefile
```

关键逻辑：

```make
ifndef BOARD_PREBUILT_BOOTIMAGE

ifneq ($(strip $(TARGET_NO_KERNEL)),true)
INTERNAL_BOOTIMAGE_ARGS := \
	$(addprefix --second ,$(INSTALLED_2NDBOOTLOADER_TARGET))

ifneq ($(BUILDING_INIT_BOOT_IMAGE),true)
  INTERNAL_BOOTIMAGE_ARGS += --ramdisk $(INSTALLED_RAMDISK_TARGET)
endif
```

也就是说：

```text
如果现编 boot.img，且 BUILDING_INIT_BOOT_IMAGE=true，则 boot.img 不加 --ramdisk。
```

但是当前 GRF 构建没有走现编 boot 分支，而是走 `BOARD_PREBUILT_BOOTIMAGE` 分支。

实际 ninja 中能看到：

```bash
cp out/target/product/a733-x733mhn_aic8800/frozen-boot.raw \
   out/target/product/a733-x733mhn_aic8800/boot.img
```

实测当前 `boot.img` 和 `frozen-boot.raw` 解包结果一致：

```text
boot magic: ANDROID!
kernel_size: 37247488
ramdisk size: 2575714
os version: 14.0.0
os patch level: 2025-06
boot image header version: 4
command line args:
boot.img signature size: 0
```

因此当前 `boot.img` 带 ramdisk，不是 Android15 AOSP 规则主动加的，而是 vendor/frozen boot 本来就带。

## 10. 当前产物存在 Android14 boot + Android15 init_boot 的组合

从当前 `vbmeta.img` 可以看到：

```text
Prop: com.android.build.boot.os_version -> '14'
Prop: com.android.build.boot.fingerprint -> 'Allwinner/...:14/UP1A.231105.001.A1/...'

Prop: com.android.build.init_boot.os_version -> '15'
Prop: com.android.build.init_boot.fingerprint -> 'Allwinner/...:15/AP3A.241105.008/...'
```

同时 `vbmeta.img` 中包含：

```text
Partition Name: boot
Partition Name: init_boot
Partition Name: vendor_boot
```

这说明最终 AVB 校验链同时包含：

```text
Android14 frozen boot.img
Android15 framework init_boot.img
vendor_boot.img
```

这不是 longan 造成的，而是 GRF 构建模型造成的：

```text
vendor target_files 提供 frozen boot/vendor/dtbo/vendor_boot 等镜像
framework build 重新生成 system/product/super/init_boot/vbmeta 等镜像
最终 vbmeta 重新把这些镜像纳入 AVB
```

## 11. GRF vendor-only 阶段对 init_boot 的处理

全志 GRF 配置中，vendor target file only 阶段会禁掉 `init_boot.img`：

```text
android15/device/softwinner/common/grf/config.mk
```

关键配置：

```make
ifeq ($(CONFIG_AW_BUILD_VENDOR_TARGET_FILE_ONLY),true)
PRODUCT_BUILD_SYSTEM_IMAGE := false
PRODUCT_BUILD_PRODUCT_IMAGE := false
PRODUCT_BUILD_SYSTEM_EXT_IMAGE := false
PRODUCT_BUILD_PVMFW_IMAGE := false

PRODUCT_BUILD_SUPER_PARTITION := false
PRODUCT_BUILD_SUPER_EMPTY_IMAGE := false
PRODUCT_BUILD_INIT_BOOT_IMAGE := false
endif
```

而 framework target file only 阶段会禁掉 vendor 侧镜像：

```make
ifeq ($(CONFIG_AW_BUILD_FRAMEWORK_TARGET_FILE_ONLY),true)
PRODUCT_BUILD_BOOT_IMAGE := false
PRODUCT_BUILD_DEBUG_BOOT_IMAGE := false
PRODUCT_BUILD_DEBUG_VENDOR_BOOT_IMAGE := false
PRODUCT_BUILD_VENDOR_BOOT_IMAGE := false
PRODUCT_BUILD_VENDOR_DLKM_IMAGE := false
PRODUCT_BUILD_SYSTEMDLKM_IMAGE := false
PRODUCT_BUILD_VENDOR_IMAGE := false
PRODUCT_BUILD_VENDOR_KERNEL_BOOT_IMAGE := false
PRODUCT_BUILD_DTBO_IMAGE := false

PRODUCT_BUILD_RECOVERY_IMAGE := false
PRODUCT_BUILD_ODM_DLKM_IMAGE := false
PRODUCT_BUILD_ODM_IMAGE := false
PRODUCT_BUILD_USERDATA_IMAGE := false
PRODUCT_BUILD_CACHE_IMAGE := false
PRODUCT_BUILD_SUPER_EMPTY_IMAGE := false
else
PRODUCT_BUILD_VENDOR_BOOT_IMAGE := true
endif
```

结合 `grf/boot.mk`，framework 阶段会使用 frozen/prebuilt boot、vendor_boot、vendor、dtbo 等，但没有 frozen/prebuilt init_boot。

因此当前 GRF 模型可以理解为：

```text
vendor-only 阶段：不负责最终 init_boot.img
framework-only 阶段：按 Android15 AOSP 规则生成最终 init_boot.img
```

## 12. func_make.sh 中 init_boot.img 如何进入 GRF IMAGES

GRF merge/build 流程位于：

```text
android15/device/softwinner/common/scripts/func_make.sh
```

framework build 前，会从 vendor target_files 抽取 frozen 镜像：

```bash
_update_prebuilt_image $vendor_target_files boot.img        $OUT/frozen-boot.raw
_update_prebuilt_image $vendor_target_files dtbo.img        $OUT/frozen-dtbo.raw
_update_prebuilt_image $vendor_target_files vendor.img      $OUT/frozen-vendor.raw
_update_prebuilt_image $vendor_target_files vendor_dlkm.img $OUT/frozen-vendor_dlkm.raw
_update_prebuilt_image $vendor_target_files system_dlkm.img $OUT/frozen-system_dlkm.raw
_update_prebuilt_image $vendor_target_files vendor_boot.img $OUT/frozen-vendor_boot.raw
```

注意这里没有：

```bash
_update_prebuilt_image $vendor_target_files init_boot.img $OUT/frozen-init_boot.raw
```

framework build 之后，会把这些镜像链接到 `grf_target/IMAGES`：

```bash
local framework_img_list=(super.img boot.img init_boot.img vendor_boot.img dtbo.img vbmeta.img vbmeta_vendor.img vbmeta_system.img)
mkdir -p $target_images_out

for e in ${framework_img_list[@]}; do
    _relative_link $OUT/$e $target_images_out/$e
done
```

所以当前：

```text
grf_target/IMAGES/init_boot.img -> out/target/product/.../init_boot.img
```

实测 `readlink -f` 也是指向：

```text
android15/out/target/product/a733-x733mhn_aic8800/init_boot.img
```

## 13. longan pack 如何处理 init_boot.img

longan pack 不重新制作 `init_boot.img`。它只是根据最终 `sys_partition.fex` 里的 `downloadfile` 做 `.fex -> .img` 链接。

产品侧分区表中：

```ini
[partition]
    name         = init_boot_a
    size         = 8M
    downloadfile = "init_boot.fex"
    user_type    = 0x8000
```

longan pack 中 `do_pack_android()` 的逻辑：

```bash
local fex_list=($(gawk '$0~"^[[:space:]]*downloadfile[[:space:]]*="{print $NF}' sys_partition.fex | sed 's/[",\r,\n]//g'))

for fex_name in ${fex_list[@]}; do
    img_name=${fex_name%\.fex}.img
    if [ -f ${ANDROID_IMAGE_OUT}/${img_name} ]; then
        ln -sf ${link_real}/${img_name} ${fex_name}
        LOGD "link ${img_name} -> ${fex_name}"
    fi
done
```

所以：

```text
init_boot.fex -> init_boot.img
```

当前 `pack.log` 中也能看到：

```text
link init_boot.img -> init_boot.fex
```

也就是说，最终烧录到 `init_boot_a` 的内容，就是 Android build 阶段已经生成好的 `init_boot.img`。

## 14. target_files / OTA 中的重建路径

除直接 make 生成 `out/.../init_boot.img` 之外，target_files/releasetools 中还有一条可重建 `init_boot.img` 的路径。

打 target_files 时，AOSP 会把 generic ramdisk 内容放进：

```text
INIT_BOOT/RAMDISK
META/init_boot_filesystem_config.txt
META/ramdisk_node_list
```

规则在 `build/make/core/Makefile`：

```make
ifdef BUILDING_INIT_BOOT_IMAGE
	$(hide) $(call package_files-copy-root, $(TARGET_RAMDISK_OUT),$(zip_root)/INIT_BOOT/RAMDISK)
	$(hide) $(call fs_config,$(zip_root)/INIT_BOOT/RAMDISK,) > $(zip_root)/META/init_boot_filesystem_config.txt
	$(hide) cp $(RAMDISK_NODE_LIST) $(zip_root)/META/ramdisk_node_list
ifdef BOARD_KERNEL_PAGESIZE
	$(hide) echo "$(BOARD_KERNEL_PAGESIZE)" > $(zip_root)/INIT_BOOT/pagesize
endif
endif
```

`add_img_to_target_files.py` 检测到 `misc_info.txt` 中有：

```text
init_boot=true
```

就会构造 `IMAGES/init_boot.img`：

```python
if has_init_boot:
  init_boot_image = common.GetBootableImage(
      "IMAGES/init_boot.img", "init_boot.img", OPTIONS.input_tmp, "INIT_BOOT",
      dev_nodes=True)
```

`common.py` 中对 `init_boot` 的处理是：

```python
elif partition_name == "init_boot":
    pass
```

这代表 `init_boot` 不需要 kernel。

后续使用 `mkbootimg_init_args`：

```python
elif partition_name == "init_boot":
    args = info_dict.get("mkbootimg_init_args")
```

并追加 ramdisk：

```python
if has_ramdisk:
  cmd.extend(["--ramdisk", ramdisk_img.name])
```

再通过 AVB：

```python
avbtool add_hash_footer --partition_name init_boot
```

因此 target_files/releasetools 中的重建路径与 make 阶段的逻辑一致：

```text
INIT_BOOT/RAMDISK
  -> mkbootfs
  -> lz4/gzip
  -> mkbootimg --ramdisk ... --header_version 4
  -> avbtool add_hash_footer --partition_name init_boot
```

## 15. 当前实测命令与结果

当前 ninja 中实际生成 `ramdisk.img` 的命令：

```bash
out/host/linux-x86/bin/mkbootfs \
  -n out/target/product/a733-x733mhn_aic8800/ramdisk_node_list \
  -d out/target/product/a733-x733mhn_aic8800/system \
  out/target/product/a733-x733mhn_aic8800/ramdisk \
| out/host/linux-x86/bin/lz4 -l -12 --favor-decSpeed \
> out/target/product/a733-x733mhn_aic8800/ramdisk.img
```

当前 ninja 中实际生成 `init_boot.img` 的命令：

```bash
out/host/linux-x86/bin/mkbootimg \
  --ramdisk out/target/product/a733-x733mhn_aic8800/ramdisk.img \
  --header_version 4 \
  --output out/target/product/a733-x733mhn_aic8800/init_boot.img
```

当前 ninja 中实际加 AVB footer 的命令：

```bash
out/host/linux-x86/bin/avbtool add_hash_footer \
  --image out/target/product/a733-x733mhn_aic8800/init_boot.img \
  --partition_size 8388608 \
  --partition_name init_boot \
  --prop com.android.build.init_boot.os_version:15 \
  --prop com.android.build.init_boot.fingerprint:$(cat out/target/product/a733-x733mhn_aic8800/build_fingerprint.txt) \
  --prop com.android.build.init_boot.security_patch:2025-06-05
```

当前文件大小：

```text
ramdisk.img    约 3.0M
init_boot.img  8.0M
boot.img       64M
frozen-boot.raw 64M
```

当前 `init_boot.img` 解包：

```text
boot magic: ANDROID!
kernel_size: 0
ramdisk size: 3052590
os version: None
os patch level: None
boot image header version: 4
```

当前 `boot.img` 解包：

```text
boot magic: ANDROID!
kernel_size: 37247488
ramdisk size: 2575714
os version: 14.0.0
os patch level: 2025-06
boot image header version: 4
```

当前 `vbmeta.img` 中的版本信息：

```text
com.android.build.boot.os_version -> 14
com.android.build.init_boot.os_version -> 15
```

这证明当前 `boot.img` 与 `init_boot.img` 来自不同阶段：

```text
boot.img      -> vendor frozen/prebuilt
init_boot.img -> Android15 framework build
```

## 16. 如果要修改 init_boot.img，应该改哪里

如果目标是修改 `init_boot.img` 里的内容，应优先看：

```text
android15/build/make/target/product/generic_ramdisk.mk
安装到 TARGET_RAMDISK_OUT 的模块
ramdisk_available / ramdisk variant 模块
out/target/product/<product>/ramdisk/
out/target/product/<product>/ramdisk.img
```

常见影响 init_boot 的内容：

```text
init_first_stage
snapuserd_ramdisk
ramdisk build.prop
ramdisk_node_list
安装到 ramdisk 分区的 init rc / binary
```

如果目标是修改 vendor 早期启动内容，例如：

```text
vendor fstab
vendor first stage init rc
vendor kernel modules
vendor ramdisk modules
DTB
bootconfig
```

通常应该改：

```text
vendor_boot.img
```

而不是 `init_boot.img`。

## 17. 是否建议使用 vendor 的 init_boot.img

理论上可以把 GRF 改成也使用 vendor target_files 中的 `init_boot.img`：

```make
BOARD_PREBUILT_INIT_BOOT_IMAGE := $(PRODUCT_OUT)/frozen-init_boot.raw
```

并在 `func_make.sh` 中增加：

```bash
_update_prebuilt_image $vendor_target_files init_boot.img $OUT/frozen-init_boot.raw
```

但不建议贸然这么做。

原因是 `init_boot.img` 里的 generic ramdisk 与 Android framework 版本绑定较紧，尤其涉及：

```text
first_stage init
snapuserd
Virtual A/B snapshot/merge
ramdisk build.prop
AVB property
Android 版本兼容
```

GRF 模式让 `init_boot.img` 由当前 Android15 framework 侧重新生成，正是为了避免升级 framework 后还使用旧 generic ramdisk 带来的启动兼容问题。

除非已经确认 vendor 的 `init_boot.img` 与当前 Android15 framework、snapshot/snapuserd、first stage init、AVB 属性完全兼容，否则不建议改成 frozen init_boot。

## 18. 总结链路

当前 A733 Android15 GRF 下，`init_boot.img` 的完整链路为：

```text
generic_ramdisk.mk
  -> init_first_stage / snapuserd_ramdisk 等模块安装到 TARGET_RAMDISK_OUT
  -> out/target/product/.../ramdisk/
  -> mkbootfs
  -> lz4 -l -12 --favor-decSpeed
  -> ramdisk.img
  -> mkbootimg --ramdisk ramdisk.img --header_version 4
  -> init_boot.img
  -> avbtool add_hash_footer --partition_name init_boot --partition_size 8388608
  -> out/target/product/.../init_boot.img
  -> grf_target/IMAGES/init_boot.img
  -> longan pack: init_boot.fex -> init_boot.img
  -> 烧录到 init_boot_a
```

当前 GRF 下 `boot.img` 的链路则不同：

```text
vendor target_files
  -> boot.img
  -> frozen-boot.raw
  -> cp frozen-boot.raw boot.img
  -> grf_target/IMAGES/boot.img
  -> longan pack: boot.fex -> boot.img
  -> 烧录到 boot_a
```

所以不要用当前 `boot.img` 是否带 ramdisk 来反推 Android15 AOSP 的 init_boot 行为。当前 `boot.img` 带 ramdisk，是因为它来自 vendor frozen boot；当前 `init_boot.img` 则是 Android15 framework 按 AOSP 标准规则重新生成的。
