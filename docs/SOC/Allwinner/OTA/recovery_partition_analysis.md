# 全志 SDK 中 recovery 分区用途及 Android/TinaLinux 关系分析

本文档整理本轮讨论的问题：

- 在全志 SDK 中，`recovery` 分区是否只能用于 OTA？
- 当前讨论的 `recovery` 分区能否用于 Android？
- `recovery` 是否 TinaLinux / Buildroot 专属？
- Android recovery、Tina/Buildroot recovery、`sysrecovery` 之间有什么区别？

## 1. 核心结论

全志 SDK 中的 `recovery` 分区并不是只能用于 OTA。

更准确地说，`recovery` 是一个被 U-Boot 特殊识别、可以单独启动的备用启动分区。

它可以用于：

- OTA 第二阶段升级；
- 系统救援；
- 恢复出厂；
- 工厂测试；
- 诊断维护；
- Android recovery；
- TinaLinux / Buildroot recovery；
- SWUpdate recovery 环境。

在当前分析的 Buildroot/SWUpdate 方案中，`recovery` 分区主要被设计为 OTA recovery 环境。但这是当前方案的使用方式，不代表全志 SDK 规定 `recovery` 只能用于 OTA。

一句话概括：

```text
recovery 分区不是 TinaLinux 专属，也不是 OTA 专属。
它本质上是一个可由 U-Boot 单独启动的备用系统/恢复环境分区。
```

## 2. 当前 Buildroot/SWUpdate 场景中的 recovery 用途

在当前 A733 Buildroot/SWUpdate 方案中，`recovery` 分区用于两阶段 OTA。

典型流程：

```text
正常系统
  -> swupdate upgrade_recovery_emmc
  -> 写 recovery 分区
  -> 设置 boot_partition=recovery
  -> 设置 swu_mode=upgrade_system_emmc
  -> reboot

U-Boot
  -> 根据 boot_partition=recovery
  -> 从 recovery 分区启动

recovery 系统
  -> 自动运行 swupdate_cmd.sh
  -> 执行 upgrade_system_emmc
  -> 写 boot/rootfs
  -> 设置 boot_partition=boot
  -> 清理 swu_mode
  -> reboot

正常系统
  -> 从 boot/rootfs 启动
```

因此在当前 SWUpdate recovery OTA 设计里，`recovery` 分区承担的是：

```text
升级中转系统 + 救援系统 + 第二阶段 OTA 执行环境
```

它不是用户正常业务系统，也不是 Android recovery。

## 3. 当前 x733mhn_aic8800 Buildroot 分区中 recovery 默认被注释

当前板级 Buildroot 分区配置中，`recovery` 分区默认是注释状态。

相关文件：

```text
device/product/configs/x733mhn_aic8800/buildroot/sys_partition.fex
device/config/chips/a733/configs/x733mhn_aic8800/buildroot/sys_partition.fex
```

内容类似：

```text
;[partition]
;    name         = recovery
;    size         = 131072
;    downloadfile = "recovery.fex"
;    user_type    = 0x8000
```

这说明在当前 `x733mhn_aic8800/buildroot` 配置中，`recovery` 是一个可选分区。

如果要让 SWUpdate recovery OTA 真正工作，需要满足：

```text
1. sys_partition.fex 中启用 recovery 分区；
2. 打包时生成 recovery.fex；
3. 设备端存在 /dev/by-name/recovery；
4. sw-description 中 recovery 写入路径正确；
5. U-Boot 能够通过 boot_partition=recovery 或 boot_recovery 命令启动 recovery。
```

否则即使 `.swu` 包中包含 `recovery` payload，设备端也没有对应分区可写。

## 4. U-Boot 如何启动 recovery 分区

全志 U-Boot 环境变量中通常会定义正常启动和 recovery 启动。

例如某些 A733 配置中：

```text
boot_normal=sunxi_flash read 45000000 boot;bootm 45000000
boot_recovery=sunxi_flash read 45000000 recovery;bootm 45000000
```

含义是：

```text
正常启动：
  从 boot 分区读取镜像到 0x45000000
  执行 bootm 0x45000000

recovery 启动：
  从 recovery 分区读取镜像到 0x45000000
  执行 bootm 0x45000000
```

所以在 U-Boot 看来，`recovery` 和 `boot` 都是可以读取并启动的镜像分区。

区别是：

```text
boot      -> 正常系统入口
recovery  -> 备用系统/恢复环境入口
```

至于 `recovery` 分区里面放什么，取决于产品方案：

- 放 Tina/Buildroot recovery 镜像；
- 放 Android recovery 镜像；
- 放工厂测试系统；
- 放救援系统；
- 放自定义维护系统。

## 5. 当前 Tina/Buildroot recovery 镜像如何生成

当前 Buildroot/SWUpdate 场景下，recovery 镜像通常通过：

```sh
./build.sh recovery
```

生成。

在 `build/buildbase.sh` 中，`swupdate_make_recovery_img()` 会根据当前 Linux 发行版类型处理 recovery rootfs。

大致逻辑：

```sh
if [ x"${LICHEE_LINUX_DEV}" = x"openwrt" ]; then
    make_openwrt_recovery_img $@
fi

if [ x"${LICHEE_LINUX_DEV}" = x"buildroot" ]; then
    make_buildroot_recovery_cpio $@
fi

${TINA_TOPDIR}/build.sh recovery
```

对 Buildroot 来说，通常是：

```text
先构建 recovery ramfs/rootfs.cpio.gz
再调用 build.sh recovery
最终生成 recovery.img / recovery.fex
```

这个 recovery 镜像的内容通常包括：

- Linux kernel recovery 配置；
- recovery initramfs；
- BusyBox 或基础用户空间；
- `swupdate`；
- `swupdate_cmd.sh`；
- `S99swupdate_autorun`；
- SWUpdate 需要的证书、公钥或配置。

因此它本质上是一个小型 Linux recovery 系统。

## 6. 当前 SWUpdate OTA 包如何携带 recovery

当前板级 SWUpdate recovery 包配置中，`recovery.fex` 会被打入 `.swu` 包。

例如：

```text
target/a733/buildroot/x733mhn_aic8800/swupdate/sw-subimgs-recovery.cfg
```

典型内容：

```text
${LICHEE_PACK_OUT_DIR}/recovery.fex:recovery
```

打包后，`.swu` 包中会有一个名为 `recovery` 的 payload。

然后在 `sw-description-recovery` 中写入设备端 recovery 分区：

```lua
{
    filename = "recovery";
    device = "/dev/by-name/recovery";
    installed-directly = true;
}
```

因此当前 Buildroot/SWUpdate 场景下的 recovery 更新链路是：

```text
recovery.fex
  -> 打入 xxx.swu，payload 名称为 recovery
  -> sw-description 指定 device=/dev/by-name/recovery
  -> SWUpdate raw handler 写入 recovery 分区
  -> U-Boot 后续从 recovery 分区启动
```

## 7. recovery 分区能否用于 Android

可以。

全志 SDK 中的 `recovery` 分区不是 TinaLinux 专属。Android 本身也有标准的 recovery 分区和 recovery 启动模式。

在 SDK 中也能看到 Android 打包配置把 `recovery` 纳入关键镜像和 AVB 范围。

例如：

```text
build/hook/pack/android10/android.conf
```

内容包括：

```text
BOARD_AVB_INCLUDE_PARTITON=boot product recovery
BOARD_ESSITIAL_IMAGE=system vendor product boot recovery
```

这说明 Android 方案中，`recovery` 是正式参与打包、签名或 AVB 校验的镜像之一。

此外，全志部分 U-Boot 板级 DTS 注释中也明确出现了 Android recovery 语义，例如 recovery 按键模式中有：

```text
2: 安卓recovery
3: 安卓恢复出厂设置
```

所以结论很明确：

```text
recovery 分区可以用于 Android。
它不是只能用于 TinaLinux / Buildroot。
```

## 8. Android recovery 与 Tina/Buildroot recovery 不能直接混用

虽然 Android 和 Tina/Buildroot 都可以使用名为 `recovery` 的分区，但它们不能简单混用。

它们共用的是：

```text
分区名 recovery
U-Boot 可选择从 recovery 启动
可作为备用恢复系统入口
```

它们不同的是：

```text
镜像格式
启动命令
ramdisk 内容
init 流程
用户空间工具
升级机制
签名/校验体系
分区模型
misc/bootloader message 语义
```

Tina/Buildroot SWUpdate recovery 通常是：

```text
Linux kernel
  + initramfs/rootfs.cpio.gz
  + busybox/init
  + swupdate
  + swupdate_cmd.sh
  + S99swupdate_autorun
```

主要用途：

```text
启动小型 Linux 环境
自动运行 SWUpdate
更新 boot/rootfs
```

Android recovery 通常是：

```text
Android recovery image
  + Android boot image 格式
  + recovery ramdisk
  + recovery binary
  + fstab
  + adb sideload / wipe / factory reset / OTA 逻辑
  + AVB 或 Android 签名校验链路
```

主要用途：

```text
Android OTA
恢复出厂
wipe data/cache
adb sideload
处理 misc 分区中的 boot-recovery 命令
```

所以不能简单认为：

```text
当前 Buildroot 的 recovery.fex 可以直接当 Android recovery 使用
```

也不能简单认为：

```text
Android recovery.img 可以直接放进当前 Buildroot SWUpdate recovery 流程里使用
```

需要同时匹配：

- 镜像格式；
- U-Boot 启动命令；
- 分区布局；
- kernel cmdline；
- ramdisk/init；
- OTA 工具链；
- 签名和校验策略。

## 9. bootm 与 boota 的区别

在 Tina/Buildroot Linux 方案中，经常看到：

```text
boot_recovery=sunxi_flash read 45000000 recovery;bootm 45000000
```

这里使用的是 `bootm`。

它更偏向传统 Linux/uImage/全志 Linux 镜像启动路径，适合当前 Buildroot/Tina recovery 镜像。

而 Android 场景中，常见的是：

```text
boot_recovery=sunxi_flash read 45000000 recovery;boota 45000000 recovery
```

`boota` 更偏 Android boot image / recovery image 启动路径，通常会处理 Android boot image 的头部、ramdisk、cmdline、分区名等 Android 语义。

因此：

```text
同一个 recovery 分区，可以用于 Android，也可以用于 Tina/Buildroot。
但 recovery 分区中的镜像格式必须和 U-Boot 启动命令匹配。
```

如果当前 U-Boot 使用 `bootm`，则应放入 `bootm` 能识别的 Linux recovery 镜像。

如果当前 U-Boot 使用 `boota`，则应放入 Android boot/recovery 格式镜像。

## 10. recovery 与 sysrecovery 的区别

全志 SDK 中还存在一个容易混淆的概念：

```text
sysrecovery
```

它和普通 `recovery` 分区不是同一个东西。

`recovery` 通常是：

```text
一个可启动的 recovery 镜像分区。
U-Boot 可以从 recovery 读取镜像并启动。
```

`sysrecovery` 更偏全志 sprite/量产/系统恢复镜像机制。

相关文件包括：

```text
device/config/chips/a733/configs/default/sysrecovery.fex
device/product/configs/default/sysrecovery.fex
brandy/brandy-2.0/u-boot-2018/sprite/sprite_recovery.c
```

U-Boot 中有专门处理 `sysrecovery` 的逻辑，例如：

```text
sprite_form_sysrecovery()
sunxi_partition_get_info_byname("sysrecovery", ...)
```

所以在讨论 SWUpdate recovery OTA 时，重点是：

```text
recovery 分区
```

而不是：

```text
sysrecovery 分区
```

二者名字相近，但用途和处理链路不同。

## 11. 当前方案的定位

结合当前路径：

```text
target/a733/buildroot/x733mhn_aic8800/swupdate/
buildroot/buildroot-202205/package/swupdate/
build/buildbase.sh
device/product/configs/x733mhn_aic8800/buildroot/
device/config/chips/a733/configs/x733mhn_aic8800/buildroot/
```

当前分析对象明显是 Buildroot/Tina Linux 的 SWUpdate recovery OTA 方案。

它的 recovery 分区定位是：

```text
SWUpdate recovery 环境
```

职责是：

```text
1. 正常系统中升级 recovery 分区；
2. 设置 boot_partition=recovery；
3. 重启进入 recovery；
4. recovery 自动运行 swupdate_cmd.sh；
5. 更新 boot/rootfs；
6. 设置 boot_partition=boot；
7. 重启回正常系统。
```

这套设计和 Android recovery 在概念上都叫 recovery，但不是同一个用户空间，也不是同一套 OTA 机制。

## 12. 最终回答

问题 1：

```text
在全志 SDK 中，recovery 分区是否只能用来 OTA？
```

答案：

```text
不是。
recovery 分区本质上是一个可由 U-Boot 单独启动的备用系统/恢复环境分区。
OTA 只是 Tina/Buildroot SWUpdate 场景下的一种典型用途。
```

问题 2：

```text
我们现在说的 recovery 分区能否用于 Android？还是只能用于 TinaLinux？
```

答案：

```text
可以用于 Android。
recovery 分区不是 TinaLinux 专属。
Android 本身也有 recovery 分区，全志 Android 打包配置也会把 recovery 纳入关键镜像和 AVB 范围。
```

工程限制：

```text
同一个固件方案中，recovery 分区中只能放一种与当前启动链匹配的 recovery 镜像。

Buildroot/SWUpdate recovery 适合 TinaLinux / Buildroot OTA；
Android recovery 适合 Android OTA / wipe / sideload / factory reset。

二者可以复用分区名和 U-Boot recovery 入口，但不能不修改镜像格式、启动命令和用户空间逻辑就直接混用。
```

