# A733 boot.img pack流程简要说明

本文基于当前工程配置：

```text
LICHEE_IC=a733
LICHEE_BOARD=x733mhn_aic8800
LICHEE_LINUX_DEV=debian
LICHEE_KERN_VER=linux-6.6
LICHEE_ARCH=arm64
LICHEE_CHIP=sun60iw2p1
LICHEE_NO_RAMDISK_NEEDED=y
```

## 1. 结论

原厂 SDK 的 `boot.img` 是一个 Android boot image v2 格式的 Linux 启动镜像。

当前 A733 Debian 配置下，`boot.img` 只包含：

```text
Android boot image header
kernel: bImage
dtb: sunxi.dtb
```

当前 `boot.img` 不包含：

```text
ramdisk
rootfs
boot-resource/logo/font/battery 图片
U-Boot
ATF/BL31
SCP
OP-TEE
```

其中 `U-Boot/ATF/SCP` 在 `boot_package.fex`，启动 logo 等资源在 `boot-resource.fex`，根文件系统在 `rootfs.fex`。

## 2. 当前 boot.img 内容

当前文件：

```text
out/a733/x733mhn_aic8800/debian/boot.img
```

解析结果：

```text
format          : Android boot image
header version  : 2
page size       : 2048
board           : sun60i_arm64
base            : 0x40000000
kernel offset   : 0x00080000
kernel addr     : 0x40080000
dtb offset      : 0x01800000
dtb addr        : 0x41800000
ramdisk size    : 0
cmdline         : empty
```

当前布局：

```text
0x00000000 - 0x000007ff  Android boot image header
0x00000800 - ...         bImage
0x01563000 - ...         sunxi.dtb
```

当前大小：

```text
boot.img   : 22628352 bytes
bImage     : 22421512 bytes
sunxi.dtb  :   202655 bytes
```

由于 `.buildconfig` 中 `LICHEE_NO_RAMDISK_NEEDED=y`，所以 `build/mkkernel.sh` 生成 `boot.img` 时没有加入 `ramdisk`。

## 3. boot.img 如何生成

`boot.img` 的真正生成位置不是 `build/pack`，而是 kernel 构建阶段：

```text
build/mkkernel.sh
  output_build()
  bootimg_build()
```

常见入口：

```text
./build.sh bootimg
  -> build/mkcmd.sh: build_bootimg()
    -> build/mkkernel.sh bootimg
      -> output_build()
      -> bootimg_build()
```

正常执行 `./build.sh` 或 `./build.sh kernel` 时，也会在 kernel 构建完成后调用 `bootimg_build()`。

当前等价生成命令可以理解为：

```bash
tools/pack/pctools/linux/android/mkbootimg \
  --kernel bImage \
  --board sun60i_arm64 \
  --base 0x40000000 \
  --kernel_offset 0x80000 \
  --dtb sunxi.dtb \
  --dtb_offset 0x1800000 \
  --header_version 2 \
  -o boot.img
```

如果需要 ramdisk，条件是：

```text
LICHEE_NO_RAMDISK_NEEDED != y
```

或者构建 recovery kernel。此时脚本会额外传入：

```bash
--ramdisk ramfs.cpio.gz
--ramdisk_offset <calculated offset>
```

## 4. pack 阶段如何使用 boot.img

`build/pack` 不重新生成 `boot.img`。它在 Linux pack 分支里把平台输出目录的 `boot.img` 链接成 `boot.fex`：

```text
build/pack: do_pack_linux()
  boot.fex -> ${LICHEE_PLAT_OUT}/boot.img
```

当前实际链接：

```text
out/a733/x733mhn_aic8800/pack_out/boot.fex -> ./../debian/boot.img
```

分区配置：

```text
device/config/chips/a733/configs/x733mhn_aic8800/debian/sys_partition.fex

[partition]
    name         = boot
    size         = 196608
    downloadfile = "boot.fex"
    user_type    = 0x8000
```

最终整包阶段：

```text
build/pack: do_finish()
  dragon image.cfg sys_partition.fex
```

所以主流程是：

```text
bImage + sunxi.dtb
  -> mkbootimg
    -> out/.../debian/boot.img
      -> pack_out/boot.fex
        -> final image 的 boot 分区
```

## 5. boot_package.fex 和 boot-resource.fex 的区别

`boot_package.fex` 是启动链前半段镜像包，由 `dragonsecboot -pack boot_package.cfg` 生成。

当前 A733 默认配置：

```text
device/config/chips/a733/configs/default/boot_package.cfg

item=u-boot,   u-boot.fex
item=monitor,  monitor.fex
item=scp,      scp.fex
;item=optee,   optee.fex
```

`boot-resource.fex` 是启动资源分区镜像，由下面命令生成：

```text
fsbuild boot-resource.ini split_xxxx.fex
```

主要包含：

```text
bootlogo.bmp
fastbootlogo.bmp
font24.sft
font32.sft
bat/*.bmp
```

两者都不属于 `boot.img` 内容。

## 6. U-Boot 启动方式

当前 env：

```text
device/config/chips/a733/configs/x733mhn_aic8800/debian/env.cfg

boot_normal=sunxi_flash read 4007f800 boot;bootm 0x4007f800
```

地址关系：

```text
0x4007f800 = 0x40080000 - 0x800
```

`0x800` 是 Android boot image header 的 2048 字节大小。U-Boot 将整个 `boot.img` 读到 `0x4007f800` 后，header 后面的 kernel payload 正好落到 `0x40080000`。

由于当前 `boot.img` 的 cmdline 为空，内核启动参数主要来自 `env.cfg` 中的：

```text
setargs_nand
setargs_mmc
setargs_ufs
```

## 7. 关键文件

```text
.buildconfig
  当前工程配置。

build/mkkernel.sh
  boot.img 真正生成脚本，核心函数是 bootimg_build()。

build/mkcmd.sh
  build.sh bootimg/kernel 的命令入口。

build/pack
  pack 阶段脚本，负责将 boot.img 链接成 boot.fex，并调用 dragon 生成最终固件。

device/config/chips/a733/configs/x733mhn_aic8800/debian/sys_partition.fex
  boot 分区配置，downloadfile 是 boot.fex。

device/config/chips/a733/configs/x733mhn_aic8800/debian/env.cfg
  U-Boot 启动命令和 kernel cmdline 配置。

device/config/chips/a733/configs/default/boot_package.cfg
  boot_package.fex 的组成配置。

device/config/chips/a733/boot-resource/boot-resource.ini
  boot-resource.fex 的资源配置。
```
