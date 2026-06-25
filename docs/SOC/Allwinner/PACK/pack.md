# Source build envsetup.sh 分析
_Exported on 2026/4/1 at GMT+8 18:38:29 from Cursor (2.6.21)_

---

**User**

帮我分析一下source build/envsetup.sh，lunch以后pack的全流程
不允许你执行已有脚本，只能根据现有SDK分析

---

**Cursor**

好的，我按“**不执行脚本，只看现有 SDK 代码**”给你梳理了 `source build/envsetup.sh` 到 `lunch` 再到 `pack` 的完整链路。下面是你这个 SDK（Tina/Allwinner）里的实际流程。

---

## 1) `source build/envsetup.sh` 之后发生了什么

你执行 `source build/envsetup.sh` 时，文件底部会自动调用 `envsetup`，它主要做四件事：

1. **校验当前目录必须是 SDK 根目录**，并设置 `TINA_TOP`  
2. 清空并重建菜单变量：
   - `LUNCH_MENU_CHOICES`
   - `VARIANT_CHOICES=tina`
   - `PLATFORM_CHOICES`（从 `target/allwinner/*` 目录名推导）
3. 搜索并 `source` 各板级 `vendorsetup.sh`，往菜单里 `add_lunch_combo`
4. 注册补全（`lunch` / `m`）

关键逻辑在 `build/envsetup.sh` 的 `envsetup()` 和 `add_lunch_combo()`。

---

## 2) `lunch` 选择后，环境是如何确定的

### 2.1 菜单来源
你当前板卡 `r818-sc3917` 的菜单来自：

- `target/allwinner/r818-sc3917/vendorsetup.sh` 里：
  - `add_lunch_combo r818_sc3917-tina`

### 2.2 `lunch` 解析 combo
`lunch` 接受 `product-variant`，例如 `r818_sc3917-tina`，然后：

- `platform`：从 combo 的 product 前缀推（`r818`）
- `product`：`r818_sc3917`
- `variant`：`tina`

接着做三重校验：
- `check_platform`
- `check_product`
- `check_variant`

### 2.3 `lunch` 导出的核心变量（最关键）
`lunch` 成功后会导出：

- `TARGET_PRODUCT`
- `TARGET_PLATFORM`
- `TARGET_BOARD=$(get_build_var TARGET_DEVICE)`（例如 `r818-sc3917`）
- `TARGET_PLAN=${TARGET_BOARD#*-}`（例如 `sc3917`）
- `TARGET_KERNEL_VERSION=$(get_kernel)`（来自 `target/allwinner/<board>/Makefile`）
- `TARGET_UBOOT=u-boot-$(get_uboot)`（同上）
- `TARGET_CHIP=$(get_chip)`（从 board kernel config 里解析 `sun50iw10p1` 这种）
- `TINA_TARGET_ARCH=$(get_arch)`
- `TINA_BUILD_TOP`

另外还有打包强相关路径：
- `LICHEE_CHIP_CONFIG_DIR=device/config/chips/${TARGET_PLATFORM}`
- `LICHEE_BOARD_CONFIG_DIR=.../configs/${TARGET_PLAN}`
- `LICHEE_PACK_OUT_DIR=out/${TARGET_BOARD}/image`
- `LICHEE_PLAT_OUT=out/${TARGET_BOARD}`

---

## 3) `lunch` 后与 pack 相关的“预处理”

### 3.1 `parse_boardconfig()`
它会按 `storage_type` 选择默认/特化 `BoardConfig.mk`（NOR 和非 NOR 分流），并导出：

- `LICHEE_BRANDY_DEFCONF`
- `LICHEE_BRANDY_SPL`
- `LICHEE_BOARD`
- `LICHEE_REDUNDANT_ENV_SIZE`
- 等

这些变量会影响后续 `mboot/muboot` 以及 `pack_img.sh` 的 boot 文件选择和 env 打包。

### 3.2 `fix_after_lunch()`
自动修正配置目录里的软链接：
- `board.dts -> linux-${TARGET_KERNEL_VERSION}/board.dts`
- `linux -> linux-${TARGET_KERNEL_VERSION}`

确保 pack 找到正确版本 DTS/配置。

---

## 4) pack 的入口调用链（你最关心）

在 `envsetup.sh` 里：

- `p()` => `pack $@`
- `pd()` => `p -d`
- `mp()` => `m && p`
- `mpd()` => `m && pd`

真正 `pack()` 函数在 `envsetup.sh` 里，主要做：

1. 组装参数：`chip/platform/board/debug/sigmode/secure/mode/programmer/tar_image`
2. `check_parameters`（确保有 `TARGET_CHIP`）
3. 调用核心脚本：

```bash
$T/scripts/pack_img.sh -c $chip -p $platform -b $board \
  -d $debug -s $sigmode -m $mode -w $programmer -v $securemode -i $tar_image -t $T
```

---

## 5) `scripts/pack_img.sh` 的完整阶段化流程

脚本最后主流程非常清晰：

1. `do_prepare`
2. `do_ini_to_dts`
3. `mkdtbo`
4. `do_common`
5. （可选）`do_mkbootimg_add_dtb`
6. `do_pack_${PACK_PLATFORM}`（你这边 `tina` => `do_pack_tina`）
7. `do_finish`
8. （可选）`do_pack_partition_file`（`-i`）
9. 执行 `scripts/.hooks/post-pack`（若存在）

---

## 6) 每个阶段实际干了什么

### A. `do_prepare`
- 清理并创建 `out/<board>/image`
- 按优先级拷贝 tools/config/boot-resource/boot bin 到 `image/`
- 读取 `sys_config.fex` 的 `storage_type`，决定 NOR / NAND/eMMC 分支
- 处理 `image_nor.cfg/sys_partition_nor.fex`
- 处理 debug（`-d card0` 会改 uart 到卡口）
- 生成最终 `IMG_NAME`（含 secure/dump/nor 等后缀）
- 根据 `.config` 调整 `env.cfg`（优化、init、selinux、small ota 等）
- 构造 user/app/data 分区镜像（如果 sys_partition 有对应项）
- 更新分区信息到 `sys_config.fex`

### B. `do_ini_to_dts`
- 将 `sys_config.fex` 转换成 `sunxi.dtb`（调用内核 dtc + 依赖模板）

### C. `mkdtbo`
- 如有 dtbo 配置，编译 `.dts -> .dtbo -> dtbo.img`

### D. `do_common`
- 把 `.fex` 做 script 转换，生成 `sys_config.bin` 等
- `update_boot0/update_uboot/update_fes1/update_chip/update_scp/update_dtb`
- 处理 NOR 专用流程（`boot0_spinor`、`boot_package_nor`、`env_nor` 等）
- 生成 `env.fex`（支持 redundant env）

### E. `do_pack_tina`
- 链接/拷贝核心镜像为打包输入：
  - `boot.fex`（来自 `boot.img` 或 `boot_initramfs.img`）
  - `rootfs.fex`（来自 `rootfs.img`）
  - `recovery.fex`
  - `usr.fex`（若有）
- secure 模式走 `do_signature`（toc0/toc1/cert/签名注入）

### F. `do_finish`
- 生成/更新 `sunxi_mbr.fex`，NOR 场景可能生成 `full_img.fex`
- 调 `dragon image.cfg ...` 产出最终整包 `.img`
- 若 `-w`，再做 programmer 镜像

---

## 7) 配置优先级（非常关键，决定你改哪里生效）

`pack_img.sh` 头部注释和数组定义可以总结为：

1. **板级专用** > 平台 common > generic  
2. 带平台后缀文件（如 `_linux`）会覆盖通用名  
3. `device/config/chips/<platform>/configs/<plan>/...` 是 Longan/Tina 融合后最常用定制入口  
4. boot bin 来源会在多个 `BIN_PATH` 中探测（`bin/`, `configs/<plan>/bin`, `configs/<plan>/linux/bin`）

---

## 8) 产物位置

最终都在：

- `out/${TARGET_BOARD}/`
- 关键中间目录：`out/${TARGET_BOARD}/image/`
- 最终固件：`out/${TARGET_BOARD}/*.img`
- 可选 tar：`out/${TARGET_BOARD}/img_*.tar.gz`

---

## 9) 你这个 SDK 的一个现实结论

你的 `pack()` 默认把 `chip` 先置为 `sun5i`，但实际打包脚本主要依赖：
- `board/platform` 找配置
- `boot bin` 实际文件命名（如 `*_sun50iw10p1.bin`）
- `lunch` 导出的 `TARGET_*` 环境

所以**能否正常 pack 的关键不是这个默认字面值本身，而是 lunch 后变量 + 配置树是否匹配**。如果你后面遇到“找不到 boot0/u-boot 对应 bin”，优先查 `device/config/chips/<platform>/bin` 与 `configs/<plan>/...` 的文件名是否匹配当前 chip 后缀。

---

如果你愿意，我下一步可以基于你当前板 `r818-sc3917`，给你画一张“**这个板子的文件覆盖路径图**”（具体到 `sys_partition.fex`、`image.cfg`、`env.cfg`、`boot_package.cfg` 各自最终来自哪里），这样你改配置时不会踩优先级坑。



**User**

结合当前板级配置文件，根据之前分析穿起来讲一下img固件生成全过程

---

**Cursor**

Need maybe read image.cfg and env.cfg current output to tie board-specific. and vendorsetup maybe not needed.
Let's read current out files صغيرة.

好，我把你这个板子（`r818-sc3917`）的实际配置，和我们前面拆的 `do_prepare/do_common/do_pack_tina/do_finish` 串成一条完整“落地流程”。

---

## 0) 先定板级事实（你当前工程）

从你现有文件可确定：

- 板：`r818-sc3917`
- 架构：`aarch64`
- 内核：`4.9`
- U-Boot：`2018`
- Rootfs：`squashfs`
- 安全相关：
  - `CONFIG_USE_DM_VERITY` 未开
  - `CONFIG_USE_UBOOT_VERIFY_SQUASHFS` 未开
  - `CONFIG_USE_SELINUX` 未开
- env：
  - 开了 `CONFIG_SUNXI_MAKE_REDUNDANT_ENV=y`
  - `CONFIG_SUNXI_REDUNDANT_ENV_SIZE="0x20000"`
- `sys_config.fex` 中 `storage_type=-1`（自动探测，不是固定 NOR）
- 当前 `image.cfg` 里最终镜像名是：`tina_r818-sc3917_uart0.img`

---

## 1) source + lunch 阶段（确定目标和路径）

`source build/envsetup.sh` 后，`lunch r818_sc3917-tina` 会导出关键变量：

- `TARGET_BOARD=r818-sc3917`
- `TARGET_PLATFORM=r818`
- `TARGET_KERNEL_VERSION=4.9`
- `TARGET_UBOOT=u-boot-2018`
- `TARGET_CHIP`（由内核配置解析，通常是 `sun50iw10p1`）
- 输出目录：`out/r818-sc3917/`

这些变量就是后续 `pack` 的输入上下文。

---

## 2) 调用 pack 入口

`p`/`pack` 最终调用的是：

- `scripts/pack_img.sh -c ... -p tina -b r818-sc3917 ... -t <TOP>`

在你当前情形（默认打包）下等价于：
- 普通模式（非 dump/非 secure/非 programmer）
- debug 模式 `uart0`

---

## 3) do_prepare：收集并“定版”打包素材

这个阶段把各种配置/资源拷贝到 `out/r818-sc3917/image/`，并做策略归一：

1. 清空重建 `image/`
2. 复制 tools/config/boot-resource/boot bin
3. 处理平台后缀覆盖（`*_linux.cfg/fex -> *.cfg/fex`）
4. 解析 `sys_config.fex`：
   - 你的 `storage_type=-1`，因此走**非 NOR 常规路径**
5. 选中分区模板（你的情况一般用普通 `sys_partition.fex`，不切 dump/private/secure）
6. 生成镜像命名并写入 `image.cfg`  
   你当前结果是 `tina_r818-sc3917_uart0.img`
7. 按 `.config` 修正 `env.cfg`（你这边无 dm-verity/selinux/small_ota 特殊改动）
8. 准备额外分区信息并更新到 `sys_config.fex`

---

## 4) do_ini_to_dts：把 sys_config 编进 dtb

把 `image/sys_config.fex` 转成：

- `image/sunxi.dtb`
- 调试反编译文件 `.sunxi.dts`

后续 `do_common` 会把它变成 `sunxi.fex` 并更新到 boot 组件里。

---

## 5) do_common：把文本配置 + boot件变成标准 fex/bin（非 NOR视角）

你要求“不管 NOR”，那就是普通路径：

1. `sys_config.fex / board_config.fex / sys_partition.fex` 转 bin
   - 产出 `config.fex`, `board.fex`, `sys_partition.bin`
2. 更新启动组件：
   - `boot0_nand.fex`, `boot0_sdcard.fex`
   - `u-boot.fex`
   - `fes1.fex`
   - `scp.fex`（若存在）
   - `sunxi.fex`（由 `sunxi.dtb` 更新）
3. 用 `boot_package.cfg` 打包 `boot_package.fex`
4. 生成 `env.fex`：
   - 你的配置开了冗余 env，所以走 `mkenvimage -r -s 0x20000`
   - `env` 和 `env-redund` 分区都指向同一个 `env.fex`（你的 `sys_partition*.fex` 就是这么配的）

---

## 6) do_pack_tina：组系统镜像层

这里把系统镜像“挂接”为打包输入：

1. `boot.fex -> boot.img`（或 initramfs boot）
2. `kernel.fex -> boot.fex`（兼容引用）
3. `rootfs.fex -> rootfs.img`
4. `rootfs_nor.fex -> rootfs.fex`（兼容）
5. `recovery.fex`：
   - 有 `boot_initramfs_recovery.img` 就链接
   - 没有就放占位文本（你的分区里 recovery 仍可存在）
6. 你的配置没开 `dm-verity`、没开 secure 签名，所以：
   - 不跑 `dm-verity-block.sh`
   - 不跑 `do_signature`
   - 就是“normal”路径

---

## 7) do_finish：生成最终 img

你当前是非 NOR普通路径，核心是：

1. `update_mbr sys_partition.bin 4` -> `sunxi_mbr.fex`
2. `sys_partition.fex -> sys_partition_for_dragon.fex`
3. 调 `dragon image.cfg sys_partition_for_dragon.fex`
4. 产出最终整包到 `out/r818-sc3917/`：
   - `tina_r818-sc3917_uart0.img`

这和你现在 `image.cfg` 中的 `imagename` 一致。

---

## 8) 和你当前目录能对上的关键证据

你当前 `out/r818-sc3917/image/` 已有这些，说明链路是通的：

- `env.cfg` / `env.fex`
- `sys_config.fex` / `sunxi.fex`
- `sys_partition.fex` / `sys_partition_for_dragon.fex`
- `boot_package.fex`
- `image.cfg` 中 `imagename=tina_r818-sc3917_uart0.img`

这正对应：`do_prepare -> do_common -> do_pack_tina -> do_finish` 的标准非 NOR结果。

---

如果你下一步想做“可控修改”，我建议优先改这三处（影响最直接）：

1. `device/config/chips/r818/configs/sc3917/linux/sys_partition.fex`（分区布局）
2. `device/config/chips/r818/configs/sc3917/sys_config.fex`（平台/启动参数）
3. `out/r818-sc3917/image/env.cfg` 的源模板（通常在 config 目录对应文件）  

我也可以继续帮你画“**某个参数改动 -> 最终进哪个 fex/img**”的追踪表。

