# A733 `image.cfg` / secure 与普通打包共用分析

## 1. 问题背景

当前 A733 默认配置里，`device/config/chips/a733/configs/default/image.cfg` 同时列出了下面两类 boot 相关条目：

- 普通启动链路条目：`boot0_*.fex`、`u-boot.fex`、`boot_package.fex`
- secure 启动链路条目：`toc0*.fex`、`toc1.fex`

看上去像是“普通包和 secure 包都共用同一个 `image.cfg`”，容易引出两个疑问：

1. 为什么不拆成两个 cfg？
2. 这样会不会把 secure 和普通的内容都塞进最终存储，造成浪费？

本文基于当前工作区源码、当前 A733 配置，以及当前已有 `pack_out` 产物做串联分析。

## 2. 先给结论

### 2.1 结论一：`image.cfg` 是“总镜像目录”，不是“芯片实际上电后的读取清单”

`image.cfg` 的职责是给 `dragon image.cfg sys_partition.fex` 这类打包工具提供一个总镜像 item 列表，让升级镜像 `.img` 里可以挂上各种可选条目。证据见：

- `device/config/chips/a733/configs/default/image.cfg`
- `build/pack:1500`

真正决定“烧录时从 `.img` 里取哪一个 item”以及“上电后从 flash 哪个区域启动”的，不是 `image.cfg` 本身，而是：

- 打包阶段的 `PACK_SECURE` 分支
- 烧录/升级阶段的 `gd->bootfile_mode`
- 芯片 secure bit / 当前启动介质 / 当前工作模式

### 2.2 结论二：不会把 secure 和普通两套 boot 区同时写进板子的实际 boot 存储

对板子实际落盘来说，不会。

普通链路最终写的是：

- `boot0`
- `boot_package` / boot1 区

secure 链路最终写的是：

- `toc0`
- `toc1`

烧录代码会二选一，不会同时把两套都写进同一块启动区域。证据见：

- `brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:204-243`
- `brandy/brandy-2.0/u-boot-2018/sprite/sprite_card.c:814-831`
- `brandy/brandy-2.0/u-boot-2018/sprite/sprite_card.c:914-1001`
- `brandy/brandy-2.0/u-boot-2018/sprite/sprite_download.c:163-192`

### 2.3 结论三：会有“镜像文件层面”的一定冗余，但主要浪费的是升级包体积，不是设备启动存储

这一点要分两层看：

- 对设备实际 flash/eMMC/UFS 启动区域：基本不浪费，因为只会烧一种格式
- 对 PC 侧/量产侧生成的总镜像 `.img`：可能会有冗余 item，被一起挂进容器里

也就是说，共用 `image.cfg` 主要带来的代价是“固件总包可能比最小必要集合更大”，而不是“板子最终多占了一份 boot 存储空间”。

## 3. `image.cfg` 在打包链路里到底是什么角色

### 3.1 `image.cfg` 只是总镜像 item 清单

默认 `image.cfg` 的 `[FILELIST]` 里同时声明了：

- `boot0_nand.fex`
- `boot0_sdcard.fex`
- `boot0_ufs.fex`
- `u-boot.fex`
- `boot_package.fex`
- `toc0.fex`
- `toc1.fex`
- `toc0_sdcard.fex`
- `toc0_nand.fex`
- `toc0_ufs.fex`

见：

- `device/config/chips/a733/configs/default/image.cfg:35-80`

最终打总包时，`build/pack` 直接调用：

```sh
dragon image.cfg sys_partition.fex
```

见：

- `build/pack:1500`

所以 `image.cfg` 更接近“总镜像目录/索引表”，而不是“启动时要从哪读”的最终决策表。

### 3.2 `boot_package.cfg` 和 `dragon_toc.cfg` 才是两条 boot 打包链路各自的内容定义

普通 boot1 包的内容来自：

- `device/config/chips/a733/configs/default/boot_package.cfg`

当前默认只打进：

- `u-boot.fex`
- `monitor.fex`
- `scp.fex`

secure TOC 的内容来自：

- `device/config/chips/a733/configs/default/dragon_toc.cfg`

其中：

- `toc0` 负责 `sboot`
- `toc1` 负责 `rootkey`、`monitor`、`u-boot`、`scp`
- `boot` 是以 `onlykey=boot` 的方式放证书关系，不是把 Linux `boot.img` 整体搬进 TOC1

见：

- `device/config/chips/a733/configs/default/boot_package.cfg:1-5`
- `device/config/chips/a733/configs/default/dragon_toc.cfg:31-46`
- `build/pack:2188-2199`
- `build/pack:2391-2397`

最后这组 `sigbootimg --image boot.fex --cert ...` 很关键，它说明 secure 情况下真正的 `boot.fex` 仍然是一个独立分区镜像，只是被附加/绑定了认证信息，不是变成了 TOC1 里的主载荷。

## 4. 为什么 secure 和普通会共用一个 `image.cfg`

### 4.1 因为 `build/pack` 的设计就是“一个总 manifest + 后续分支选择”

`build/pack` 在前面统一把各种可能用到的：

- config
- boot 文件
- secure 文件
- dtb
- tools

都拷到 `pack_out`，然后再根据：

- `PACK_SECURE`
- `PACK_NOR`
- `PACK_PLATFORM`

等参数做后续分流。

关键分支有：

- `build/pack:667-685`
- `build/pack:748-758`
- `build/pack:1350-1373`

其中最直观的是 programmer 镜像构造：

```sh
if [ "x${PACK_SECURE}" = "xsecure" ]; then
    programmer_img toc0_sdcard.fex toc1.fex ${out_img}
else
    programmer_img boot0_sdcard.fex boot_package.fex ${out_img}
fi
```

见：

- `build/pack:748-758`

这说明打包脚本作者的思路不是“secure 用一套 image.cfg，普通用另一套 image.cfg”，而是“总镜像里保留统一 item 名字，实际选择由分支和烧录逻辑完成”。

### 4.2 统一 item 名字可以减少工具链分叉

这么做的直接好处是：

- `dragon image.cfg ...` 这条总包命令保持不变
- 烧录工具、量产工具、卡烧工具可以用 item subtype 做分支
- 不同介质只需切换 `BOOT0_...` / `TOC0_...` 的 subtype，而不必维护多套总 manifest

从代码看，U-Boot sprite/烧录工具就是这么干的。

## 5. `.img` 在烧录时，如何选择其中哪一部分内容

这是回答你问题的核心。

### 5.1 先由 secure bit 和工作模式决定 `gd->bootfile_mode`

U-Boot 启动后，会先读 secure bit：

- `sunxi_get_secureboard()` 直接读 `SID_SECURE_MODE`
- 如果是 secure 芯片，`gd->bootfile_mode = SUNXI_BOOT_FILE_TOC`
- 如果是普通芯片，默认 `gd->bootfile_mode = SUNXI_BOOT_FILE_PKG`
- 如果当前不是正常启动而是在量产/烧录模式，并且检测到 `burn_secure_mode=1`，普通芯片也会切到 `SUNXI_BOOT_FILE_TOC`

见：

- `brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:172-175`
- `brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:199-243`
- `brandy/brandy-2.0/u-boot-2018/include/spare_head.h:83-90`

也就是说，真正驱动后续选择的是 `gd->bootfile_mode`，不是 `image.cfg`。

### 5.2 烧录 `.img` 时，boot1/uboot 部分按 `bootfile_mode` 选 item subtype

卡烧/量产逻辑里：

- 普通 legacy 模式取 `UBOOT_0000000000`
- A733 这种普通 package 模式取 `BOOTPKG-00000000`
- secure 模式取 `TOC1_00000000000`

见：

- `brandy/brandy-2.0/u-boot-2018/sprite/sprite_card.c:814-831`
- `brandy/brandy-2.0/u-boot-2018/sprite/sprite_card.c:964-970`

也就是：

```text
PKG 模式 -> 从 .img 里取 boot_package.fex
TOC 模式 -> 从 .img 里取 toc1.fex
```

### 5.3 烧录 `.img` 时，boot0/toc0 也按介质和模式选不同 subtype

普通模式会按介质选择：

- NAND: `BOOT0_0000000000`
- SD/eMMC: `1234567890BOOT_0`

secure 模式会按介质选择：

- SD/eMMC: `TOC0_SDCARD00000`
- NAND: `TOC0_NAND0000000`
- UFS: `TOC0_UFS00000000`

见：

- `brandy/brandy-2.0/u-boot-2018/sprite/sprite_card.c:875-899`
- `brandy/brandy-2.0/u-boot-2018/sprite/sprite_card.c:990-1001`

所以最终流程不是“都读”，而是“按 mode 和介质精确命中某个 subtype”。

### 5.4 落盘时写入的是同一个 boot 区槽位，不是两套并存

普通 package 和 secure toc，最终都走 `sunxi_sprite_download_toc()` 写 boot1/uboot 区，只是写进去的内容格式不同：

- `sunxi_sprite_download_uboot()` 检查 TOC magic 后统一调用 `sunxi_sprite_download_toc()`
- MMC 上写入 `TOC1` / `TOC1_BAK` 固定区域
- SPI NOR 上也写入 `TOC1` 固定偏移

见：

- `brandy/brandy-2.0/u-boot-2018/sprite/sprite_download.c:163-192`
- `brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/mmc/sdmmc.c:143-159`
- `brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/spinor/spinor.c:654-665`
- `brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/sunxi_flashmap.c:196-203`

这里非常关键：对普通 `boot_package.fex`，代码也把它当成一种 TOC-like boot1 容器处理，最终写到 boot1/TOC1 槽位；secure 的 `toc1.fex` 也是写到这个槽位。二者是替代关系，不是叠加关系。

## 6. 上电启动时，BootROM / boot0 / U-Boot 如何根据实际启动方式选择内容

### 6.1 关于 BootROM：仓库里没有完整 BootROM 源码，只能基于配套源码和工具做一致性推断

这个仓库里没有 A733 的 BootROM 全部源码，所以“BootROM 精确内部实现”无法逐行展开。

但下游代码和配套工具对 secure / normal 布局的处理是高度一致的，因此可以比较可靠地推断其启动选择逻辑。

### 6.2 从配套工具可见：secure 与普通使用的是不同 boot 区布局

`platform/allwinner/system/ota-burnboot/src/BurnSdBoot.c` 对 SD 卡启动布局的选择非常明确：

- secure 时：
  - `boot0` 区改为 `TOC0`
  - `boot1` 区改为 `TOC1`
- 普通时：
  - `boot0` 区还是 `BOOT0`
  - `boot1` 区还是普通 `UBOOT`

见：

- `platform/allwinner/system/ota-burnboot/src/BurnSdBoot.c:42-48`
- `platform/allwinner/system/ota-burnboot/src/BurnSdBoot.c:64-74`

这说明“实际启动介质上的读取位置”在 secure / normal 下本来就不是同一套格式。

### 6.3 U-Boot 自己也认为 secure 启动文件模式是 TOC，普通模式是 PKG

上面已经看到：

- secure 板：`gd->bootfile_mode = SUNXI_BOOT_FILE_TOC`
- 普通板：`gd->bootfile_mode = SUNXI_BOOT_FILE_PKG`

见：

- `brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:204-243`

这和烧录阶段的 item 选择完全一致，说明从“镜像容器选择”到“落盘后的启动格式选择”是一条贯穿的设计。

### 6.4 普通模式下，boot0 会把 boot package 信息传给 U-Boot

`private_uboot.h` 里有这个字段：

- `boot_package_size`，注释明确写着：`boot0 pass this value`

见：

- `brandy/brandy-2.0/u-boot-2018/include/private_uboot.h:70-72`

而 U-Boot 读取 boot package 的函数 `read_boot_package()` 会直接用这个大小，从固定 `TOC1` 区域把 boot package 读出来：

- `read_len = uboot_spare_head.boot_data.boot_package_size`
- MMC/SD 读 `sunxi_flashmap_offset(..., TOC1)`
- UFS 读 `TOC1`
- NOR 读 `TOC1`

见：

- `brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/sunxi_flash.c:877-935`

这再次说明：

- 板子启动时读的是“介质固定 boot 区”
- 不是回头去解析 PC 端总镜像 `.img`

### 6.5 secure 模式下，U-Boot 会把 TOC1 视作可信启动链的一部分

secure 模式时：

- `gd->securemode` 被设置成 secure
- 需要时会保存/校验 `CONFIG_SUNXI_BOOTPKG_BASE` 上的 TOC1

见：

- `brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:204-221`
- `brandy/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c:170-178`

这说明 secure 模式运行时真正参与信任链的是 `toc1`，不是普通 `boot_package.fex`。

## 7. A733 真正进入 Linux 时，又是怎么选内容的

这部分也很容易误解，因为很多人会把“bootloader 启动镜像”和“Linux boot 分区镜像”混在一起。

### 7.1 A733 默认 `boot_normal` 直接读 `boot` 分区

当前默认环境里：

```text
boot_normal=sunxi_flash read 4007f800 boot;bootm 0x4007f800
```

见：

- `device/config/chips/a733/configs/default/env.cfg:22-30`

也就是说，进入 Linux 时真正被读出来的是 `boot` 分区里的 `boot.fex`/`boot.img`，不是 `boot_package.fex`，也不是 `toc1.fex`。

### 7.2 A733 的 Linux DTB 默认来自 `boot.img` 或 `vendor_boot.img`

A733 defconfig 打开了：

- `CONFIG_ANDROID_BOOT_IMAGE=y`
- `CONFIG_SUNXI_ANDROID_BOOT=y`
- `CONFIG_SUNXI_NECESSARY_REPLACE_FDT=y`
- `CONFIG_SUNXI_SECURE_BOOT=y`

见：

- `brandy/brandy-2.0/u-boot-2018/configs/sun60iw2p1_a733_defconfig:6-24`

`sunxi_replace_fdt_v2()` 的顺序是：

1. 先尝试 `dtb` 分区
2. 如果没有有效 DTB，再回退到 `boot` 分区的 Android boot image

见：

- `brandy/brandy-2.0/u-boot-2018/board/sunxi/sunxi_replace_fdt.c:274-312`

`android_image_get_dtb()` 会进一步根据 boot image 版本选择：

- 新版 Android boot：从 `vendor_boot` 里取 DTB
- 旧版 Android boot：从 `boot.img` 尾部取 DTB

见：

- `brandy/brandy-2.0/u-boot-2018/common/image-android.c:581-620`
- `brandy/brandy-2.0/u-boot-2018/common/image-android.c:92-120`

所以对 A733 来说：

- `boot_package/toc1` 负责的是 bootloader 链路
- 最终 Linux 内核和 Linux DTB 的读取，默认是 `boot` / `vendor_boot` 分区链路

### 7.3 secure 启动时，Linux `boot` 镜像仍然来自 `boot` 分区，只是会被额外校验

secure 打包阶段会对 `boot.fex` 做签名封装：

- `build/pack:2391-2397`

运行时，`do_bootm()` 进入 `sunxi_android_boot()`，然后走：

- `sunxi_verify_os()`
- 或 AVB `verify_image_by_vbmeta()`

见：

- `brandy/brandy-2.0/u-boot-2018/cmd/bootm.c:243-247`
- `brandy/brandy-2.0/u-boot-2018/board/sunxi/android/sunxi_android_boot.c:81-225`
- `brandy/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c:61-100`

所以 secure 启动时：

- 不是“改成从 toc1 里加载 Linux boot.img”
- 而是“仍然从 `boot` 分区加载 boot.img，但用 secure 链路里的证书/公钥关系去验证它”

这也是为什么 `dragon_toc.cfg` 里 `boot` 是 `onlykey=boot`，而不是把整个 `boot.fex` 当作 `item=boot` 放进 TOC1 主载荷。

## 8. 当前工作区里的实际观察

当前已有产物：

- `out/a733/x733mhn_aic8800/pack_out/boot_package.fex` 约 `1.3M`
- `out/a733/x733mhn_aic8800/pack_out/boot0_sdcard.fex` 约 `240K`
- `out/a733/x733mhn_aic8800/pack_out/toc0.fex` / `toc1.fex` 都只有 `8B`

见：

- `out/a733/x733mhn_aic8800/pack_out/`

这说明当前工作区现有 `pack_out` 更像一次普通非 secure 打包结果：

- `boot_package.fex` 是有效主产物
- `toc0/toc1` 只是占位文件

所以对当前这个现成输出而言，共用 `image.cfg` 带来的额外成本基本可以忽略。

如果未来真用 `pack -v secure` 产 secure 包，那么根据 `build/pack` 源码，确实很可能同时生成：

- `boot_package.fex`
- `toc0*.fex`
- `toc1.fex`

这会让 PC 端总镜像 `.img` 增大一些，但板子实际启动存储仍只会写 secure 那一套。

## 9. 最后把整条链路串起来

### 9.1 普通打包

```text
boot_package.cfg -> boot_package.fex
image.cfg -> 把 boot_package.fex/boot0_*.fex 等挂进总镜像
烧录时 bootfile_mode=PKG -> 从 .img 取 BOOTPKG + BOOT0
落盘到 boot0 + boot1(TOC1 槽位)
上电后按普通链路启动
U-Boot 再从 boot 分区读取 boot.img 启动 Linux
```

### 9.2 secure 打包

```text
dragon_toc.cfg -> toc0*.fex + toc1.fex
boot.fex 再被签名
image.cfg -> 把 toc0/toc1 及其他 item 挂进总镜像
烧录时 bootfile_mode=TOC -> 从 .img 取 TOC0 + TOC1
落盘到 toc0 + toc1
上电后按 secure 链路启动并建立信任链
U-Boot 仍从 boot 分区读取 boot.img，但会先做 secure/AVB 校验
```

## 10. 对原问题的直接回答

### 10.1 为什么 secure 打包和普通打包都公用一个 `image.cfg`

因为这个 `image.cfg` 不是 secure/normal 启动决策文件，而是统一的总镜像 item manifest。真正的 secure/normal 分流发生在：

- `build/pack` 的 `PACK_SECURE` 分支
- 烧录阶段的 `gd->bootfile_mode`
- 芯片 secure bit 与当前工作模式

### 10.2 会不会造成存储空间浪费

如果你说的是板子最终启动存储空间：

- 基本不会，因为只会烧录一套 boot 格式，不会把 `boot_package` 和 `toc1` 两套都同时落到同一条启动链路里

如果你说的是 PC 侧生成的总镜像 `.img` 文件大小：

- 会有一定冗余的可能
- 但这是“总镜像包体积”的冗余，不是“设备 boot 存储布局”的冗余

### 10.3 启动流程如何根据实际启动方式选择读取 `.img` 中哪部分内容

严格说，上电启动并不会再去读 PC 端总镜像 `.img`。

更准确的说法是：

1. 烧录/升级阶段，U-Boot sprite 根据 `bootfile_mode` 从 `.img` 中挑选 `BOOTPKG/BOOT0` 或 `TOC1/TOC0`
2. 把选中的那一套写到设备固定 boot 区
3. 上电后，BootROM/boot0/U-Boot 只从这些固定 boot 区启动
4. Linux 阶段再从 `boot`/`vendor_boot` 分区读取真正的 OS 与 DTB

这就是为什么：

- `image.cfg` 可以共用
- 实际启动又不会混读 secure/normal 两套内容

