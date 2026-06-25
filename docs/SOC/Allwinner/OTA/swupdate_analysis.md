# 全志 SWUpdate 写 Flash 与 boot0/uboot 更新机制分析

本文档单独整理本轮讨论的问题：

- 全志 SWUpdate 是如何具体把 OTA 内容更新到 flash 的？
- 为什么 `boot0`、`uboot` 没有普通分区，却仍然可以通过 SWUpdate 更新？
- `sw-description` 中 `device = "/dev/by-name/xxx"` 与 `type = "awboot0"/"awuboot"` 的区别是什么？

## 1. 核心结论

全志 SWUpdate 的 flash 更新路径分成两类：

1. 普通系统镜像更新

   例如：

   - `recovery`
   - `kernel` / `boot`
   - `rootfs`

   这类镜像通常通过 Linux 设备节点或 UBI volume 写入，例如：

   - `/dev/by-name/recovery`
   - `/dev/by-name/boot`
   - `/dev/by-name/rootfs`
   - UBI volume: `recovery`、`boot`、`rootfs`

2. 启动链镜像更新

   例如：

   - `boot0_emmc`
   - `boot0_nand`
   - `uboot`
   - 安全启动场景下的 `toc0` / `toc1` 类镜像

   这类镜像不是普通 Linux 分区，不通过 `/dev/by-name/boot0` 或 `/dev/by-name/uboot` 更新，而是通过全志给 SWUpdate 增加的专用 handler：

   - `type = "awboot0"`
   - `type = "awuboot"`

   然后由 `ota-burnboot` 库根据实际存储介质执行底层写入。

一句话概括：

> `boot0` / `uboot` 能升级，不是因为它们有普通分区，而是因为全志在 SWUpdate 中增加了专门的 bootloader 烧写 handler，最终通过 `ota-burnboot` 写入启动介质的保留区域、固定偏移、MTD 区域或 NAND 私有接口。

## 2. sw-description 中的两种写法

以 `target/a733/buildroot/x733mhn_aic8800/swupdate/sw-description-recovery` 为例，普通镜像和 bootloader 镜像的写法明显不同。

### 2.1 普通分区写法

例如 `recovery`：

```lua
{
    filename = "recovery";
    device = "/dev/by-name/recovery";
    installed-directly = true;
}
```

例如系统阶段的 `kernel` 和 `rootfs`：

```lua
{
    filename = "kernel";
    device = "/dev/by-name/boot";
    installed-directly = true;
}

{
    filename = "rootfs";
    device = "/dev/by-name/rootfs";
    installed-directly = true;
}
```

这类条目会走 SWUpdate 的 raw handler。

基本流程：

```text
xxx.swu
  -> sw-description
  -> 解析 filename/device
  -> open("/dev/by-name/xxx")
  -> copyimage()
  -> 写入对应块设备
```

### 2.2 boot0/uboot 写法

例如 eMMC 场景：

```lua
{
    filename = "uboot";
    type = "awuboot";
}

{
    filename = "boot0_emmc";
    type = "awboot0";
}
```

例如 NAND 场景：

```lua
{
    filename = "boot0_nand";
    type = "awboot0";
}
```

这里没有：

```lua
device = "/dev/by-name/boot0";
device = "/dev/by-name/uboot";
```

这是正常的。因为 `boot0` 和 `uboot` 不走普通 raw handler，而是由 `type` 指定全志自定义 handler。

## 3. 全志新增的 awboot handler

相关补丁：

```text
buildroot/buildroot-202205/package/swupdate/0001-swupdate-add-awboot_handler.patch
```

该补丁新增：

```text
handlers/awboot_handler.c
```

并注册两个 handler：

```c
register_handler("awuboot", install_awuboot, IMAGE_HANDLER, NULL);
register_handler("awboot0", install_awboot0, IMAGE_HANDLER, NULL);
```

因此：

```lua
type = "awuboot";
```

会进入：

```c
install_awuboot()
```

而：

```lua
type = "awboot0";
```

会进入：

```c
install_awboot0()
```

这两个函数的关键动作是：

1. 从 `.swu` 包中取出对应 payload；
2. 把 payload 写成临时文件；
3. 调用全志 `ota-burnboot` 库接口。

对应调用关系：

```c
OTA_burnuboot(filename);
OTA_burnboot0(filename);
```

所以真正决定 bootloader 镜像写到哪里的是 `ota-burnboot`，不是 `sw-description` 中的普通 `device` 字段。

## 4. ota-burnboot 的总体流程

相关源码目录：

```text
platform/allwinner/system/ota-burnboot/src/
```

核心入口：

```text
platform/allwinner/system/ota-burnboot/src/OTA_BurnBoot.c
```

主要接口：

```c
int OTA_burnboot0(const char *img_path);
int OTA_burnuboot(const char *img_path);
```

大致流程：

```text
读取 boot0/uboot 镜像到内存
  -> 初始化平台信息
  -> 检查 secure/gpt/ubi 等状态
  -> 判断 flash 类型
  -> 按介质类型调用具体烧写函数
```

介质判断主要来自：

```text
platform/allwinner/system/ota-burnboot/src/Utils.c
```

它会读取：

```text
/proc/cmdline
```

重点字段包括：

```text
boot_type=
root=
gpt=1
```

典型判断逻辑：

```text
root=/dev/mmcblk*     -> MMC/eMMC/SD
root=/dev/nand*       -> NAND
root=/dev/ubi*        -> NAND/UBI
root=/dev/mtdblock*   -> NOR
```

然后进入不同后端：

```text
eMMC/SD    -> BurnSdBoot.c
NAND       -> BurnNandBoot.c
SPI-NOR    -> BurnSpinor.c
```

## 5. eMMC/SD 场景：直接写启动介质固定偏移

相关文件：

```text
platform/allwinner/system/ota-burnboot/src/BurnSdBoot.c
```

关键常量：

```c
#define DEVNODE_PATH_SD "/dev/mmcblk0"
#define SECTOR_SIZE 512

#define SD_BOOT0_SECTOR_START 16
#define SD_BOOT0_SIZE_KBYTES 32

#define SD_UBOOT_SECTOR_START 32800
#define SD_UBOOT_SIZE_KBYTES 1024

#define SD_TOC0_SECTOR_START 16
#define SD_TOC0_SIZE_KBYTES 120

#define SD_TOC1_SECTOR_START 32800
#define SD_TOC1_SIZE_KBYTES 4080
```

非安全启动场景下，典型布局：

```text
boot0:
  device = /dev/mmcblk0
  offset = 16 * 512
  size   = 32 KB

uboot:
  device = /dev/mmcblk0
  offset = 32800 * 512
  size   = 1024 KB
```

安全启动场景下，通常对应：

```text
toc0:
  device = /dev/mmcblk0
  offset = 16 * 512
  size   = 120 KB

toc1:
  device = /dev/mmcblk0
  offset = 32800 * 512
  size   = 4080 KB
```

因此 eMMC/SD 下更新 `boot0` 的流程可以理解为：

```text
swupdate
  -> awboot0 handler
  -> OTA_burnboot0()
  -> burnSdBoot0()
  -> open("/dev/mmcblk0")
  -> lseek(16 * 512)
  -> write(boot0 image)
```

更新 `uboot` 的流程可以理解为：

```text
swupdate
  -> awuboot handler
  -> OTA_burnuboot()
  -> burnSdUboot()
  -> open("/dev/mmcblk0")
  -> lseek(32800 * 512)
  -> write(uboot / boot_package / toc1)
```

这就是 `boot0` / `uboot` 没有普通分区也能被更新的关键原因：

> 它们被写入 `/dev/mmcblk0` 的启动保留区域或固定偏移，而不是写入 `/dev/by-name/xxx` 分区。

### 5.1 boot0 写入前会保留部分旧参数

`burnSdBoot0()` 不是简单把新 boot0 文件完整覆盖进去。

它会先读取旧 boot0 区域，并把旧镜像中的部分存储参数、DDR 参数等信息合并到新 boot0 中，再重新计算校验和。

这样做的目的通常是保留与当前板子、当前存储介质相关的启动参数，降低直接覆盖导致无法启动的风险。

### 5.2 eMMC boot0 硬件区

代码中还可以看到：

```c
#define SD_BOOT0_PERMISSION "/sys/block/mmcblk0boot0/force_ro"
#define DEVNODE_PATH_SD_BOOT0 "/dev/mmcblk0boot0"
```

如果编译时启用了对应宏，例如：

```c
OTA_BURNBOOT0_TO_EMMC_BOOT_AREA
```

则可能会额外写入 eMMC 的硬件 boot0 区：

```text
echo 0 > /sys/block/mmcblk0boot0/force_ro
open("/dev/mmcblk0boot0")
write boot0
```

是否启用这条路径，需要结合实际编译选项确认。

## 6. NAND / SPI-NAND 场景：通过 NAND 驱动接口更新

相关文件：

```text
platform/allwinner/system/ota-burnboot/src/BurnNandBoot.c
```

关键设备节点：

```c
#define DEVNODE_PATH_NAND_MBR       "/dev/nanda"
#define DEVNODE_PATH_NAND_GPT       "/dev/nand0p1"
#define DEVNODE_PATH_NAND_MTD_BOOT0 "/dev/mtd0"
#define DEVNODE_PATH_NAND_MTD_BOOT1 "/dev/mtd1"

#define DEVNODE_PATH_NAND_CDEV      "/dev/rawnand_cdev"
#define DEVNODE_PATH_SPINAND_CDEV   "/dev/spinand_cdev"
```

关键 ioctl：

```c
#define NAND_BLKBURNBOOT0 _IO('v', 127)
#define NAND_BLKBURNUBOOT _IO('v', 128)
```

NAND 更新 boot0 的大致流程：

```text
检查 boot0 镜像合法性
  -> 判断 UBI / GPT / MBR 布局
  -> 优先尝试 /dev/rawnand_cdev 或 /dev/spinand_cdev
  -> 封装 burn_param_t
  -> write() 给 NAND 字符设备
  -> 若没有 cdev，则对 NAND 块设备发 ioctl(NAND_BLKBURNBOOT0)
```

NAND 更新 uboot 的大致流程：

```text
检查 uboot 镜像合法性
  -> 判断 UBI / GPT / MBR 布局
  -> 优先尝试 /dev/rawnand_cdev 或 /dev/spinand_cdev
  -> 封装 burn_param_t
  -> write() 给 NAND 字符设备
  -> 若没有 cdev，则对 NAND 块设备发 ioctl(NAND_BLKBURNUBOOT)
```

因此 NAND 下 `boot0` 和 `uboot` 的真实落盘位置、坏块处理、备份块处理等细节，主要由 NAND 驱动和 `ota-burnboot` 负责，而不是由 SWUpdate 直接处理。

## 7. SPI-NOR 场景：扫描 magic 后写 MTD 区域

相关文件：

```text
platform/allwinner/system/ota-burnboot/src/BurnSpinor.c
```

使用的设备节点：

```c
#define BOOT_SPINOR_PATH "/dev/mtdblock0"
```

关键 magic：

```c
#define BOOT0_MAGIC "eGON.BT0"
#define UBOOT_MAGIC "sunxi-package"
```

大致流程：

```text
读取 /dev/mtdblock0
  -> 扫描 boot0 magic
  -> 扫描 uboot magic
  -> 计算 boot0_offset / uboot_offset
  -> 擦写对应区域
```

也就是说，SPI-NOR 下同样不是依赖普通分区，而是在 boot MTD 区域中通过 magic 定位启动镜像。

## 8. image.cfg 中的 boot 镜像 item

相关文件：

```text
device/config/chips/a733/configs/default/image.cfg
```

其中可以看到类似 boot 镜像 item：

```text
boot0_nand.fex
boot0_sdcard.fex
boot0_ufs.fex
u-boot.fex
toc0.fex
toc1.fex
boot_package.fex
```

这些内容属于全志启动镜像体系的一部分，而不是 `sys_partition.fex` 中的普通分区。

普通分区通常由分区表描述，并在 Linux 中体现为：

```text
/dev/by-name/boot
/dev/by-name/rootfs
/dev/by-name/recovery
```

而 `boot0` 是 BootROM 早期加载对象，它在 Linux 分区体系之前就已经参与启动。它的位置由 SoC BootROM、存储介质和全志工具链约定。

因此，判断它能不能 OTA 更新，不能只看有没有 `/dev/by-name/boot0`。关键要看：

- SWUpdate 是否支持 `awboot0` handler；
- 是否链接了 `ota-burnboot`；
- 设备端是否暴露了底层 boot 介质节点；
- `ota-burnboot` 是否能正确识别当前 flash 类型并写入。

## 9. 与普通 raw/UBI handler 的区别

### 9.1 普通 raw handler

普通 raw 写入大致是：

```text
sw-description:
  filename = "rootfs";
  device = "/dev/by-name/rootfs";
  installed-directly = true;

SWUpdate:
  open("/dev/by-name/rootfs")
  copyimage()
  fsync()
```

适用于块设备分区。

### 9.2 UBI volume handler

UBI 场景大致是：

```text
sw-description:
  filename = "rootfs";
  volume = "rootfs";

SWUpdate:
  查找 UBI volume
  open("/dev/ubiX_Y")
  ubi_update_start()
  copyimage()
```

适用于 UBI volume。

### 9.3 awboot handler

boot0/uboot 场景大致是：

```text
sw-description:
  filename = "boot0_emmc";
  type = "awboot0";

SWUpdate:
  调用 awboot_handler
  payload 写临时文件
  OTA_burnboot0()
  由 ota-burnboot 决定怎么写底层介质
```

适用于全志启动链镜像。

## 10. 当前方案需要重点检查的条件

### 10.1 SWUpdate 是否启用了 awboot handler

相关配置：

```text
buildroot/buildroot-202205/package/swupdate/config/handlers/Config.in
```

其中有：

```text
config SWUPDATE_CONFIG_AWBOOT_HANDLER
    bool "allwinner boot0/uboot"
```

如果未启用该 handler，`sw-description` 中的：

```lua
type = "awboot0";
type = "awuboot";
```

就无法正常分发到全志 bootloader 更新逻辑。

### 10.2 是否启用了 ota-burnboot 包

相关文件：

```text
buildroot/buildroot-202205/package/swupdate/swupdate.mk
```

其中逻辑为：

```make
ifeq ($(BR2_PACKAGE_OTA_BURNBOOT),y)
SWUPDATE_DEPENDENCIES += ota-burnboot
SWUPDATE_MAKE_ENV += HAVE_OTA_BURNBOOT=y
endif
```

所以需要确认当前 Buildroot defconfig 中是否有：

```text
BR2_PACKAGE_OTA_BURNBOOT=y
```

### 10.3 设备端节点是否存在

eMMC/SD 场景建议检查：

```sh
ls -l /dev/mmcblk0
ls -l /dev/mmcblk0boot0
cat /sys/block/mmcblk0boot0/force_ro
```

NAND/SPI-NAND 场景建议检查：

```sh
ls -l /dev/rawnand_cdev
ls -l /dev/spinand_cdev
ls -l /dev/nanda
ls -l /dev/nand0p1
ls -l /dev/mtd0
ls -l /dev/mtd1
```

普通分区建议检查：

```sh
ls -l /dev/by-name/
```

### 10.4 cmdline 是否能被正确识别

建议检查：

```sh
cat /proc/cmdline
```

重点关注：

```text
boot_type=
root=
gpt=1
```

如果 `ota-burnboot` 判断错介质类型，可能会选择错误的烧写后端。

### 10.5 boot0/uboot 镜像是否匹配安全启动状态

`ota-burnboot` 会检查镜像 magic 和 checksum：

```text
boot0: eGON.BT0 或 TOC0
uboot: sunxi-package / TOC1 / old uboot magic
```

如果设备是安全启动链路，应确认使用的是匹配的 `toc0/toc1` 或安全镜像格式。

## 11. 风险点

boot0/uboot 更新属于高风险更新，原因是：

- 它们影响 BootROM 后的早期启动链；
- eMMC/SD 场景会直接写 `/dev/mmcblk0` 固定偏移；
- NAND 场景依赖驱动私有烧写接口；
- 写入过程中断电可能导致设备无法启动；
- 安全启动与非安全启动镜像混用可能导致启动失败；
- 错误介质判断可能导致写入错误位置。

因此实际量产升级时，应重点确认：

```text
boot0 文件与介质匹配
uboot 文件与安全启动状态匹配
ota-burnboot 能正确识别 flash type
设备端节点存在且权限正常
SWUpdate 已启用 awboot handler
Buildroot 已启用 ota-burnboot
recovery/system 阶段的 sw-description 条目符合实际分区
```

## 12. 最终流程总结

普通镜像更新：

```text
xxx.swu
  -> sw-description
  -> filename + device/volume
  -> raw handler / UBI handler
  -> 写 /dev/by-name/xxx 或 /dev/ubiX_Y
```

boot0/uboot 更新：

```text
xxx.swu
  -> sw-description
  -> type = awboot0 / awuboot
  -> awboot_handler
  -> OTA_burnboot0() / OTA_burnuboot()
  -> 判断 flash 类型
  -> eMMC/SD: 写 /dev/mmcblk0 固定偏移或 eMMC boot0 区
  -> NAND: 通过 /dev/rawnand_cdev、/dev/spinand_cdev 或 NAND ioctl 写入
  -> SPI-NOR: 扫描 magic 后写 /dev/mtdblock0
```

最终结论：

```text
boot0 / uboot 没有普通分区并不影响 OTA 更新。

它们不是通过分区表定位，而是通过全志专用的 awboot handler 和 ota-burnboot 库，按介质类型写入启动介质的保留区域或驱动定义的 boot 区域。
```

