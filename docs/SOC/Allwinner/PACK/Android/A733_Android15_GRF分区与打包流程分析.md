# A733 Android15 GRF 分区与打包流程分析

本文整理前面对 A733 Android15 SDK 的分析，重点回答两个问题：

1. 为什么已经修改了 `longan/device/config/chips/a733/configs/default/sys_partition.fex`，最终镜像里仍然出现 `boot.img`、`init_boot.img`、`vendor_boot.img`、`super.img` 等标准 Android 分区镜像。
2. `android15/device/softwinner/jupiter/a733-x733mhn/system/sys_partition.fex` 中定义的每个分区分别存放什么。

结论先行：

- Android15 当前使用的是 Android 产品侧的 `sys_partition.fex`，不是 longan default 目录下的那份。
- `sys_partition.fex` 控制的是最终烧录包里的外层物理分区表；它不会阻止 Android 编译系统生成 `boot.img`、`init_boot.img`、`vendor_boot.img`、`super.img` 等构建产物。
- `system/vendor/product/system_dlkm/vendor_dlkm` 没有作为外层物理分区单独出现，而是被打进 `super.img`，运行时由 dynamic partitions 映射成 logical partitions。
- 当前 `a733-x733mhn` 的分区布局是 Android Virtual A/B + dynamic partitions + AVB 布局，不是 Linux/Tina 的 `boot + rootfs` 布局。

## 1. 涉及的关键文件

当前工程根目录为：

```text
/home/szbaijie/A733/qihua-x733-android15
```

主要相关文件如下：

```text
android15/device/softwinner/jupiter/a733-x733mhn/system/sys_partition.fex
android15/device/softwinner/jupiter/a733-x733mhn_aic8800/system/sys_partition.fex
android15/device/softwinner/jupiter/BoardConfig.mk
android15/device/softwinner/common/config/vendorcommand.mk
android15/device/softwinner/common/scripts/func_pack.sh
android15/device/softwinner/common/scripts/func_make.sh
android15/device/softwinner/jupiter/common/storage/fstab.template
android15/device/softwinner/jupiter/common/system/env.cfg
android14/longan/build/pack
android14/longan/build/hook/pack/android13/android.conf
android14/longan/build/hook/pack/common.sh
```

另外，当前工程中的 `android15/longan` 实际指向 Android14 longan：

```text
android15/longan -> ../android14/longan
```

因此 Android15 的 longan pack 行为需要看 Android14 的 `longan/build` 脚本。

## 2. 为什么改 longan default 的 sys_partition 不生效

你之前修改的是类似下面这类路径：

```text
android15/longan/device/config/chips/a733/configs/default/sys_partition.fex
```

但在 Android Virtual A/B 产品配置中，真正参与 pack 的分区文件来自产品侧：

```text
android15/device/softwinner/jupiter/a733-x733mhn/system/sys_partition.fex
android15/device/softwinner/jupiter/a733-x733mhn_aic8800/system/sys_partition.fex
```

原因在 `android15/device/softwinner/jupiter/BoardConfig.mk` 中：

```make
ifeq ($(PRODUCT_VIRTUAL_AB),true)
    BOARD_ADD_PACK_CONFIG += $(TARGET_DEVICE_DIR)/system/sys_partition.fex
    BOARD_ADD_PACK_CONFIG += $(PRODUCT_PLATFORM_PATH)/common/system/env.cfg
    BOARD_ADD_PACK_CONFIG += $(PRODUCT_PLATFORM_PATH)/common/system/dragon_toc.cfg
endif
```

这说明只要 `PRODUCT_VIRTUAL_AB=true`，产品目录下的 `system/sys_partition.fex` 就会被加入 `BOARD_ADD_PACK_CONFIG`。

`vendorcommand.mk` 中的 `get_sys_partition_path` 也优先查找 `BOARD_ADD_PACK_CONFIG` 里有没有 `sys_partition.fex`：

```make
$(eval __exist := $(filter %/sys_partition.fex,$(BOARD_ADD_PACK_CONFIG)))
```

只有当 `BOARD_ADD_PACK_CONFIG` 没有提供 sys_partition 时，才会退回去找 longan 的 chip config 目录。

longan pack 脚本的顺序也印证了这一点：

1. 先复制 longan common/default/board config 到 `pack_out`。
2. 再处理 `PACK_ADD_FILES`，也就是 Android 侧传入的 `BOARD_ADD_PACK_CONFIG`。
3. 后拷贝的同名 `sys_partition.fex` 会覆盖前面 default 目录下的 `sys_partition.fex`。

所以对于这个 Android15 GRF 产品，longan default 下那份 `sys_partition.fex` 不是最终生效文件。真正应该改的是产品侧的：

```text
android15/device/softwinner/jupiter/a733-x733mhn/system/sys_partition.fex
```

如果当前 lunch/产品是 `a733_x733mhn_aic8800_arm64`，则对应：

```text
android15/device/softwinner/jupiter/a733-x733mhn_aic8800/system/sys_partition.fex
```

这两份当前内容相同。

## 3. 为什么仍然会生成 boot.img/init_boot.img/vendor_boot.img/super.img

这是 Android 编译流程和 longan 打包流程的分层导致的。

Android 编译阶段会根据 `BoardConfig.mk` 生成标准 Android 镜像：

```make
BOARD_BOOTIMAGE_PARTITION_SIZE := $(call get_partition_size,boot,$(PARTITION_CFG_FILE))
BOARD_INIT_BOOT_IMAGE_PARTITION_SIZE := $(call get_partition_size,init_boot,$(PARTITION_CFG_FILE))
BOARD_VENDOR_BOOTIMAGE_PARTITION_SIZE := $(call get_partition_size,vendor_boot,$(PARTITION_CFG_FILE))

BOARD_BUILD_SUPER_IMAGE_BY_DEFAULT := true
BOARD_SUPER_IMAGE_IN_UPDATE_PACKAGE := true
BOARD_SUPER_PARTITION_SIZE := $(call get_partition_size,super,$(PARTITION_CFG_FILE))
BOARD_SUPER_PARTITION_GROUPS := sb
BOARD_SB_PARTITION_LIST := system vendor product vendor_dlkm system_dlkm

BOARD_BOOTCONFIG += androidboot.dynamic_partitions=true
BOARD_BOOTCONFIG += androidboot.dynamic_partitions_retrofit=true
```

这些配置决定了 Android build 一定会产出：

```text
boot.img
init_boot.img
vendor_boot.img
dtbo.img
super.img
vbmeta.img
vbmeta_system.img
vbmeta_vendor.img
system.img
vendor.img
product.img
system_dlkm.img
vendor_dlkm.img
```

其中 `system.img/vendor.img/product.img/system_dlkm.img/vendor_dlkm.img` 会被组合进 `super.img`。

longan pack 阶段再根据最终的 `sys_partition.fex` 读取每个分区的 `downloadfile`：

```text
downloadfile = "boot.fex"
downloadfile = "init_boot.fex"
downloadfile = "vendor_boot.fex"
downloadfile = "super.fex"
```

然后将这些 `.fex` 链接到 Android 编译出来的 `.img`：

```text
boot.fex        -> boot.img
init_boot.fex   -> init_boot.img
vendor_boot.fex -> vendor_boot.img
super.fex       -> super.img
dtbo.fex        -> dtbo.img
vbmeta.fex      -> vbmeta.img
```

因此：

- `sys_partition.fex` 决定最终烧录包有哪些物理分区，以及每个分区烧哪个文件。
- Android `BoardConfig.mk` 决定 Android 编译阶段生成哪些 `.img`。
- 改 `sys_partition.fex` 不会自动让 Android build 停止生成 `boot.img/init_boot.img/vendor_boot.img/super.img`。

如果目标是完全改成 Linux/Tina 的 `boot + rootfs` 布局，仅修改一份 `sys_partition.fex` 不够，还需要同步调整 Android 产品配置、fstab、bootloader env、AVB、dynamic partitions、Virtual A/B、OTA/releasetools 等一整套配置。

## 4. 三层概念不要混在一起

分析这类问题时要把三层分开：

第一层：Android 编译产物。

```text
out/target/product/<product>/boot.img
out/target/product/<product>/init_boot.img
out/target/product/<product>/vendor_boot.img
out/target/product/<product>/super.img
out/target/product/<product>/vbmeta*.img
```

这些由 Android build/make/soong 和 BoardConfig 决定。

第二层：烧录包外层物理分区表。

```text
longan/out/<chip>/<board>/pack_out/sys_partition.fex
longan/out/<chip>/<board>/pack_out/sys_partition.bin
longan/out/<chip>/<board>/pack_out/sunxi_mbr.fex
longan/out/<chip>/<board>/pack_out/sunxi_gpt.fex
```

这些由最终生效的 `sys_partition.fex` 以及 longan pack 决定。

第三层：`super.img` 内部 logical partitions。

```text
system_a
system_b
vendor_a
vendor_b
product_a
product_b
system_dlkm_a
system_dlkm_b
vendor_dlkm_a
vendor_dlkm_b
```

这些由 Android dynamic partitions/lpmake 配置决定，不是外层 `sys_partition.fex` 逐个定义出来的。

## 5. a733-x733mhn/system/sys_partition.fex 分区说明

源文件：

```text
android15/device/softwinner/jupiter/a733-x733mhn/system/sys_partition.fex
```

该文件定义的是最终烧录包的外层物理分区。当前布局是 Android Virtual A/B + dynamic partitions。

### 5.1 mbr

```ini
[mbr]
    size = 16384
```

`size = 16384`，单位是 KiB，即 16MiB。它不是 Android 文件系统分区，而是给 Allwinner pack/MBR/GPT/分区表相关数据预留。

### 5.2 bootloader_a / bootloader_b

```ini
[partition]
    name         = bootloader_a
    size         = 32M
    downloadfile = "boot-resource.fex"
    user_type    = 0x8000

[partition]
    name         = bootloader_b
    size         = 32M
    user_type    = 0x8000
```

这里的 `bootloader_a` 名字容易误导。当前烧进去的是 `boot-resource.fex`，它更像启动资源分区，而不是 Android 的 `boot.img`。

实测现有 `pack_out/boot-resource.fex` 是 FAT16 资源镜像，里面能看到：

```text
BOOTLOGO.BMP
FONT24.SFT
FONT32.SFT
BAT
FASTBOOT*.BMP
MAGIC.BIN
```

所以它主要放 boot logo、充电图、fastboot 图、字体等启动显示资源。

`bootloader_b` 是 A/B 备用槽，初始没有单独 `downloadfile`。

真正的 boot0/TOC/u-boot 不是通过 Android `boot.img` 这种分区写入的，而是 longan pack 的 bootloader/TOC 流程处理。

### 5.3 env_a / env_b

```ini
[partition]
    name         = env_a
    size         = 256K
    downloadfile = "env.fex"
    user_type    = 0x8000

[partition]
    name         = env_b
    size         = 256K
    user_type    = 0x8000
```

存放 U-Boot 环境变量。来源是：

```text
android15/device/softwinner/jupiter/common/system/env.cfg
```

里面包含：

```text
slot_suffix=_a
ab_partition_list=bootloader,env,boot,vendor_boot,dtbo,vbmeta,vbmeta_system,vbmeta_vendor,init_boot
boot_normal=sunxi_flash read 4007F000 boot;bootm 4007F000
```

`env_b` 是 env 的备用槽。

### 5.4 boot_a / boot_b

```ini
[partition]
    name         = boot_a
    size         = 64M
    downloadfile = "boot.fex"
    user_type    = 0x8000

[partition]
    name         = boot_b
    size         = 64M
    user_type    = 0x8000
```

`boot_a` 存放 Android `boot.img`。

pack 后的映射是：

```text
boot.fex -> out/target/product/<product>/grf_target/IMAGES/boot.img
```

当前 `boot.img` 解包结果显示：

```text
boot magic: ANDROID!
boot image header version: 4
kernel_size: 37247488
ramdisk size: 2575714
```

也就是说 `boot.img` 中包含 kernel 和 ramdisk，是 Android GKI 启动链的一部分。

`boot_b` 是 A/B 备用槽，OTA 更新 inactive slot 时会用到。

### 5.5 vendor_boot_a / vendor_boot_b

```ini
[partition]
    name         = vendor_boot_a
    size         = 32M
    downloadfile = "vendor_boot.fex"
    user_type    = 0x8000

[partition]
    name         = vendor_boot_b
    size         = 32M
    user_type    = 0x8000
```

`vendor_boot_a` 存放 Android `vendor_boot.img`。

pack 后的映射是：

```text
vendor_boot.fex -> vendor_boot.img
```

当前 `vendor_boot.img` 解包结果显示：

```text
boot magic: VNDRBOOT
vendor boot image header version: 4
vendor ramdisk total size: 22767987
dtb size: 205610
vendor bootconfig size: 336
```

主要内容包括：

- vendor ramdisk
- DTB
- bootconfig
- vendor command line
- vendor ramdisk modules

`vendor_boot_b` 是备用槽。

### 5.6 init_boot_a / init_boot_b

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

`init_boot_a` 存放 Android 13+ GKI 引入的 `init_boot.img`。

pack 后的映射是：

```text
init_boot.fex -> init_boot.img
```

当前 `init_boot.img` 解包结果显示：

```text
boot magic: ANDROID!
boot image header version: 4
kernel_size: 0
ramdisk size: 3052590
```

也就是说它主要放 generic init ramdisk，不放 kernel。

`init_boot_b` 是备用槽。

### 5.7 super

```ini
[partition]
    name         = super
    size         = 4.5G
    downloadfile = "super.fex"
    user_type    = 0x8000
```

`super` 是 dynamic partitions 的物理容器。

pack 后的映射是：

```text
super.fex -> super.img
```

`super.img` 内部包含 logical partitions：

```text
system_a
system_b
vendor_a
vendor_b
product_a
product_b
vendor_dlkm_a
vendor_dlkm_b
system_dlkm_a
system_dlkm_b
```

当前实测 `super.img` 中 `_a` 槽有数据，`_b` 槽为空：

```text
system_a       有 extents
vendor_a       有 extents
product_a      有 extents
vendor_dlkm_a  有 extents
system_dlkm_a  有 extents

system_b       空
vendor_b       空
product_b      空
vendor_dlkm_b  空
system_dlkm_b  空
```

这符合 Virtual A/B full image 的常见布局：初始烧录当前槽，另一槽留给 OTA。

fstab 中的 `/system`、`/vendor`、`/product` 都是 logical + slotselect：

```text
system   /system       erofs  ... logical,slotselect,avb=vbmeta
vendor   /vendor       erofs  ... logical,slotselect
product  /product      erofs  ... logical,slotselect
```

### 5.8 misc

```ini
[partition]
    name         = misc
    size         = 16M
    downloadfile = "misc.fex"
    user_type    = 0x8000
```

`misc` 存放 Android misc/BCB 数据。

主要用途：

- bootloader message
- recovery 指令
- OTA 状态
- reboot reason
- bootloader 与 Android/recovery 之间传递启动命令

pack 后：

```text
misc.fex -> misc.img
```

当前 `misc.img` 起始能看到 `BCAB` 标记。

### 5.9 vbmeta_a / vbmeta_b

```ini
[partition]
    name         = vbmeta_a
    size         = 128K
    downloadfile = "vbmeta.fex"
    user_type    = 0x8000

[partition]
    name         = vbmeta_b
    size         = 128K
    user_type    = 0x8000
```

`vbmeta_a` 存放 AVB 顶层 `vbmeta.img`。

当前 `avbtool info_image` 显示它包含：

- chain partition: `vbmeta_system`
- chain partition: `vbmeta_vendor`
- `boot` hash descriptor
- `dtbo` hash descriptor
- `init_boot` hash descriptor
- `vendor_boot` hash descriptor
- `product/vendor_dlkm/system_dlkm` hashtree descriptor
- build fingerprint/security patch 等属性

`vbmeta_b` 是备用槽。

### 5.10 vbmeta_system_a / vbmeta_system_b

```ini
[partition]
    name         = vbmeta_system_a
    size         = 64K
    downloadfile = "vbmeta_system.fex"
    user_type    = 0x8000

[partition]
    name         = vbmeta_system_b
    size         = 64K
    user_type    = 0x8000
```

`vbmeta_system_a` 存放 `vbmeta_system.img`。

当前它主要描述 `system` logical partition 的 dm-verity hashtree。

`vbmeta_system_b` 是备用槽。

### 5.11 vbmeta_vendor_a / vbmeta_vendor_b

```ini
[partition]
    name         = vbmeta_vendor_a
    size         = 64K
    downloadfile = "vbmeta_vendor.fex"
    user_type    = 0x8000

[partition]
    name         = vbmeta_vendor_b
    size         = 64K
    user_type    = 0x8000
```

`vbmeta_vendor_a` 存放 `vbmeta_vendor.img`。

当前它主要描述 `vendor` logical partition 的 dm-verity hashtree。

`vbmeta_vendor_b` 是备用槽。

### 5.12 frp

```ini
[partition]
    name         = frp
    size         = 0.5M
    ro           = 0
    user_type    = 0x8000
    keydata      = 0x8000
```

`frp` 是 Factory Reset Protection / OEM unlock 相关持久分区。

系统属性中配置：

```text
ro.frp.pst=/dev/block/by-name/frp
```

fastboot 代码会读写：

```text
/dev/block/by-name/frp
```

用于判断 OEM unlock 能力和设备锁状态相关逻辑。

`keydata = 0x8000` 表明它属于保留/私有数据类，量产或升级时通常不希望像普通系统分区一样被覆盖。

### 5.13 empty

```ini
[partition]
    name         = empty
    size         = 15M
    ro           = 0
    user_type    = 0x8000
```

保留/填充分区，没有下载文件，也没有 fstab 挂载。

从位置看，它紧跟 `frp` 后面，`frp 0.5M + empty 15M` 大致用于预留和对齐。

### 5.14 metadata

```ini
[partition]
    name         = metadata
    size         = 16M
    user_type    = 0x8000
```

Android `/metadata` 分区。

fstab 中挂载方式：

```text
/dev/block/by-name/metadata /metadata ext4 nodev,noatime,nosuid,errors=panic wait,first_stage_mount,formattable,check
```

同时 `/data` 加密配置中指定：

```text
keydirectory=/metadata/vold/metadata_encryption
```

因此它与文件加密、vold metadata、checkpoint/加密状态等有关。

### 5.15 treadahead

```ini
[partition]
    name         = treadahead
    size         = 96M
    user_type    = 0x8000
```

Allwinner treadahead 功能分区。

fstab 中挂载：

```text
/dev/block/by-name/treadahead /treadahead ext4 ... wait,first_stage_mount,formattable,check
```

系统配置中也有：

```make
BOARD_ROOT_EXTRA_FOLDERS += treadahead
```

用途偏启动/IO 预读缓存或策略数据。

### 5.16 private

```ini
[partition]
    name         = private
    size         = 16M
    ro           = 0
    user_type    = 0x8000
```

厂商私有 vfat 分区。

fstab 中：

```text
/dev/block/by-name/private /private vfat noatime defaults
```

init 脚本中：

```text
on late-fs && property:ro.product.first_api_level=30
    mount vfat /dev/block/by-name/private /private rw noatime

on property:sys.boot_completed=1
    mount vfat /dev/block/by-name/private /private ro remount

on property:sys.lmk_top_app=com.longsys2.testdram
    mount vfat /dev/block/by-name/private /private rw remount
```

说明它主要是厂商私有数据区，开机阶段可写，开机完成后默认 remount 为只读。

### 5.17 dtbo_a / dtbo_b

```ini
[partition]
    name         = dtbo_a
    size         = 2M
    downloadfile = "dtbo.fex"
    user_type    = 0x8000

[partition]
    name         = dtbo_b
    size         = 2M
    user_type    = 0x8000
```

`dtbo_a` 存放 `dtbo.img`，即 Device Tree Overlay。

pack 后：

```text
dtbo.fex -> dtbo.img
```

BoardConfig 中设置：

```make
BOARD_PREBUILT_DTBOIMAGE := $(PRODUCT_PREBUILT_PATH)/dtbo.img
BOARD_DTBOIMG_PARTITION_SIZE := $(call get_partition_size,dtbo,$(PARTITION_CFG_FILE))
BOARD_INCLUDE_DTB_IN_BOOTIMG := true
BOARD_BOOTCONFIG += androidboot.dtbo_idx=0,1,2
```

`dtbo_b` 是备用槽。

### 5.18 media_data

```ini
[partition]
    name         = media_data
    size         = 16M
    user_type    = 0x8000
```

OEM/media 数据分区。

fstab 中：

```text
/dev/block/by-name/media_data /oem vfat ro,nodev,noatime,nosuid,context=u:object_r:oemfs:s0 wait,first_stage_mount,formattable,check
```

init 脚本里也能看到历史挂载逻辑：

```text
# mount vfat /dev/block/by-name/media_data /oem ro ...
```

当前通过 fstab first stage 挂载到 `/oem`，类型 vfat，默认只读。

### 5.19 pstore

```ini
[partition]
    name         = pstore
    size         = 32M
    user_type    = 0x8000
```

持久化日志/异常信息预留分区。

源码中 sepolicy 对 `/dev/block/by-name/pstore` 有标注，但当前 fstab 没有直接挂载它。

实际是否使用取决于内核 ramoops/pstore 或厂商日志服务配置。Android 通用 pstore 路径通常是：

```text
/sys/fs/pstore
```

### 5.20 UDISK

```ini
[partition]
    name         = UDISK
    user_type    = 0x8100
```

最后一个分区，没有显式 `size`，通常表示吃掉剩余存储空间。

`user_type = 0x8100` 是 Allwinner 对 UDISK/用户数据类分区的特殊类型。

需要注意一个细节：当前 fstab 模板中 `/data` 写的是：

```text
/dev/block/by-name/userdata /data f2fs ...
```

但 `sys_partition.fex` 最后定义的是：

```text
name = UDISK
```

fastboot 代码中也有兼容逻辑：

```cpp
open("/dev/block/by-name/userdata")
失败后 open("/dev/block/by-name/UDISK")
```

因此建议在板子上确认是否存在 `userdata -> UDISK` 的 by-name 别名：

```bash
ls -l /dev/block/by-name | grep -E 'UDISK|userdata'
cat /vendor/etc/fstab.sun60iw2p1
```

如果实际设备只有 `UDISK` 没有 `userdata` 别名，`/data` 挂载可能存在风险；如果有别名，则是厂商适配层已经兜住。

## 6. 分区总览表

| 分区 | 大小 | 初始烧录文件 | 主要内容 |
| --- | ---: | --- | --- |
| `bootloader_a` | 32MiB | `boot-resource.fex` | boot logo、字体、充电图、fastboot 图等启动资源 |
| `bootloader_b` | 32MiB | 无 | A/B 备用启动资源槽 |
| `env_a` | 256KiB | `env.fex` | U-Boot 环境变量、slot、bootcmd、ab_partition_list |
| `env_b` | 256KiB | 无 | env 备用槽 |
| `boot_a` | 64MiB | `boot.fex` | Android `boot.img`，kernel + ramdisk |
| `boot_b` | 64MiB | 无 | boot 备用槽 |
| `vendor_boot_a` | 32MiB | `vendor_boot.fex` | Android `vendor_boot.img`，vendor ramdisk、DTB、bootconfig |
| `vendor_boot_b` | 32MiB | 无 | vendor_boot 备用槽 |
| `init_boot_a` | 8MiB | `init_boot.fex` | Android `init_boot.img`，generic init ramdisk |
| `init_boot_b` | 8MiB | 无 | init_boot 备用槽 |
| `super` | 4.5GiB | `super.fex` | dynamic partitions 容器，包含 system/vendor/product/system_dlkm/vendor_dlkm |
| `misc` | 16MiB | `misc.fex` | Android BCB、recovery/OTA/bootloader message |
| `vbmeta_a` | 128KiB | `vbmeta.fex` | AVB 顶层 vbmeta |
| `vbmeta_b` | 128KiB | 无 | vbmeta 备用槽 |
| `vbmeta_system_a` | 64KiB | `vbmeta_system.fex` | system AVB/verity 元数据 |
| `vbmeta_system_b` | 64KiB | 无 | vbmeta_system 备用槽 |
| `vbmeta_vendor_a` | 64KiB | `vbmeta_vendor.fex` | vendor AVB/verity 元数据 |
| `vbmeta_vendor_b` | 64KiB | 无 | vbmeta_vendor 备用槽 |
| `frp` | 0.5MiB | 无 | FRP/OEM unlock 持久数据 |
| `empty` | 15MiB | 无 | 保留/填充分区 |
| `metadata` | 16MiB | 无 | Android `/metadata`，加密/metadata/vold 数据 |
| `treadahead` | 96MiB | 无 | Allwinner treadahead 预读数据 |
| `private` | 16MiB | 无 | 厂商私有 vfat 数据区，挂载 `/private` |
| `dtbo_a` | 2MiB | `dtbo.fex` | `dtbo.img`，Device Tree Overlay |
| `dtbo_b` | 2MiB | 无 | dtbo 备用槽 |
| `media_data` | 16MiB | 无 | vfat OEM/media 数据区，挂载 `/oem` |
| `pstore` | 32MiB | 无 | 持久化日志/异常信息预留 |
| `UDISK` | 剩余空间 | 无 | 用户数据/内部存储类分区，可能与 `/data` 的 `userdata` 别名相关 |

## 7. 修改分区时应该改哪里

如果只是调整当前 Android 产品的外层物理分区大小或顺序，优先修改：

```text
android15/device/softwinner/jupiter/a733-x733mhn/system/sys_partition.fex
```

如果当前 lunch 是 `a733_x733mhn_aic8800_arm64`，则修改：

```text
android15/device/softwinner/jupiter/a733-x733mhn_aic8800/system/sys_partition.fex
```

不要只改：

```text
android15/longan/device/config/chips/a733/configs/default/sys_partition.fex
```

因为它会被 Android 产品侧 `BOARD_ADD_PACK_CONFIG` 覆盖。

如果要调整 `boot/init_boot/vendor_boot/super` 等分区大小，还必须确保 BoardConfig 能读到正确大小：

```make
BOARD_BOOTIMAGE_PARTITION_SIZE
BOARD_INIT_BOOT_IMAGE_PARTITION_SIZE
BOARD_VENDOR_BOOTIMAGE_PARTITION_SIZE
BOARD_SUPER_PARTITION_SIZE
```

这些值来自 `get_partition_size`，它会解析最终产品侧 `sys_partition.fex`。

如果要彻底改成非 Android dynamic partitions 布局，例如 `boot + rootfs`，需要同步重构：

- `PRODUCT_VIRTUAL_AB`
- `BOARD_BUILD_SUPER_IMAGE_BY_DEFAULT`
- `BOARD_SUPER_PARTITION_*`
- `BOARD_SB_PARTITION_LIST`
- `BOARD_AVB_*`
- `BOARD_BOOTCONFIG` 中的 dynamic partitions 配置
- `fstab.template`
- `env.cfg`
- OTA/releasetools
- bootloader 启动参数
- Android 启动链中的 `boot/init_boot/vendor_boot` 依赖

这不是单独改 `sys_partition.fex` 能完成的。

## 8. 建议验证命令

确认最终 pack 使用的是哪份分区表：

```bash
grep -n "name\\s*=" android15/longan/out/a733/x733mhn_aic8800/pack_out/sys_partition.fex
```

确认 `.fex` 到 `.img` 的映射：

```bash
readlink -f android15/longan/out/a733/x733mhn_aic8800/pack_out/boot.fex
readlink -f android15/longan/out/a733/x733mhn_aic8800/pack_out/init_boot.fex
readlink -f android15/longan/out/a733/x733mhn_aic8800/pack_out/vendor_boot.fex
readlink -f android15/longan/out/a733/x733mhn_aic8800/pack_out/super.fex
```

查看 `super.img` 内部 logical partitions：

```bash
tmpdir=$(mktemp -d /tmp/a733_super.XXXXXX)
android15/out/host/linux-x86/bin/simg2img \
  android15/out/target/product/a733-x733mhn_aic8800/super.img \
  "$tmpdir/super.raw"
android15/out/host/linux-x86/bin/lpdump "$tmpdir/super.raw"
rm -rf "$tmpdir"
```

查看 AVB 描述：

```bash
android15/out/host/linux-x86/bin/avbtool info_image \
  --image android15/out/target/product/a733-x733mhn_aic8800/vbmeta.img

android15/out/host/linux-x86/bin/avbtool info_image \
  --image android15/out/target/product/a733-x733mhn_aic8800/vbmeta_system.img

android15/out/host/linux-x86/bin/avbtool info_image \
  --image android15/out/target/product/a733-x733mhn_aic8800/vbmeta_vendor.img
```

修改产品侧分区表后，建议清掉旧 pack 中间产物再重新编译/打包：

```bash
rm -rf android15/out/target/product/a733-x733mhn_aic8800/grf_target
rm -rf android15/longan/out/a733/x733mhn_aic8800/pack_out
```

如果实际产品不是 `a733-x733mhn_aic8800`，把上面路径替换为当前 lunch 对应的 product/board 名。
