
**User**

先详细分析一下A. do_prepare

---

**Cursor**



好，我们只聚焦 `do_prepare()`，把它拆成“输入、阶段、输出、风险点”来讲。  
你可以把它理解成：**把所有打包原料收集/修正到 `out/<board>/image/`，并把后续打包策略写进配置文件**。

---

## 一、`do_prepare` 的定位

在 `pack_img.sh` 主流程里，它是第一个核心步骤（后面才是 `do_ini_to_dts` / `do_common` / `do_pack_tina`）。  
所以它本质是“**预制打包工作目录**”。

---

## 二、它依赖的输入（进入函数前就应确定）

来自 `pack_img.sh` 前面参数解析和变量初始化：

- `PACK_CHIP / PACK_PLATFORM / PACK_BOARD / PACK_KERN / PACK_SIG / PACK_SECURE / PACK_MODE / PACK_DEBUG ...`
- `ROOT_DIR=out/${PACK_BOARD}`
- 配置根目录：
  - `TINA_CONFIG_DIR=target/allwinner`
  - `LONGAN_CONFIG_DIR=device/config/chips/${PACK_BOARD_PLATFORM}/configs`
  - `LICHEE_CHIP_CONFIG_DIR=device/config/chips/${PACK_BOARD_PLATFORM}`
- 文件候选列表数组：
  - `tools_file_list`
  - `configs_file_list`
  - `boot_resource_list`
  - `boot_file_list`
  - `possible_bin_path`

---

## 三、`do_prepare` 分阶段详细行为

### 1) 参数和板目录有效性检查
- 检查 `PACK_CHIP/PACK_PLATFORM/PACK_BOARD` 非空，否则直接退出。
- 检查板级目录至少有一种存在：
  - `target/allwinner/<board>/configs`
  - 或 `device/config/chips/<platform>/configs/<plan>/linux`
- 失败会 `show_boards` 然后 `exit 1`。

**作用**：尽早失败，避免后续复制一堆空文件。

---

### 2) 自动推导内核版本（若未传 `-k`）
- 调 `get_kernel()` 读 `target/allwinner/<board>/Makefile` 里的 `KERNEL_PATCHVER`
- 设置：
  - `PACK_KERN=linux-<ver>`
  - `ENV_SUFFIX=<ver>`（后面会用于 `env-<ver>.cfg -> env.cfg`）

---

### 3) 清理并重建工作目录
- 删除 `out/<board>/image`
- 重新创建 `out/<board>/image`

这是整个 pack 的“沙盒目录”。

---

### 4) 调平台预钩子
- `call_platform_pack_prepare_hook`
- 若存在 `target/allwinner/<board>/hooks/pack_prepare_hook.sh` 会执行。

---

### 5) 拷贝工具文件、配置文件（关键：覆盖顺序）
先复制 `tools_file_list`，再复制 `configs_file_list`。  
每项都 `cp -f ... 2>/dev/null`，所以：

- 不存在就静默跳过
- 同名后拷会覆盖前拷（这就是优先级机制）

你可以把优先级理解为：**通用 -> common -> 板级/plan 级，后者覆盖前者**。

---

### 6) 内核版本专属 sys_config 覆盖
若存在 `sys_config_${PACK_KERN}.fex`，就覆盖成 `sys_config.fex`。  
例如可能是 `sys_config_linux-4.9.fex -> sys_config.fex`。

---

### 7) 平台后缀文件“去后缀覆盖”
函数里有一段 `find + sed`，会把 `*_linux.cfg/fex` 重命名覆盖为无后缀版本。  
例如：

- `image_linux.cfg -> image.cfg`
- `sys_partition_linux.fex -> sys_partition.fex`

这一步直接实现了“平台变体优先于默认文件”。

---

### 8) 根据 `storage_type` 选择 NOR 还是 NAND/eMMC 流程
从 `image/sys_config.fex` 解析 `storage_type`：

- `storage_type=3`（NOR）
  - 若有 `image_nor.cfg`，替换为 `image.cfg`
  - `image_instruction="image is for nor"`
  - `IMG_FLASH="_nor"`（影响最终镜像命名）
- 其他值（NAND/eMMC）
  - 删除 `sys_partition_nor.fex`、`image_nor.cfg` 避免误用

---

### 9) 选择分区模板（模式切换）
- `PACK_MODE=dump`：
  - `sys_partition_dump.fex -> sys_partition.fex`
  - `usbtool_test.fex -> usbtool.fex`
- `PACK_FUNC=prvt`：
  - `sys_partition_private.fex -> sys_partition.fex`
- 若 `.config` 有 `CONFIG_USE_DM_VERITY=y`
  - 强制 `sys_partition_secure.fex -> sys_partition.fex`

> 注意：后面的覆盖会覆盖前面的结果，最后生效的是“最后一次拷贝”。

---

### 10) 拷贝 boot-resource 并压缩 logo
- 按 `boot_resource_list` 拷贝到 `image/boot-resource/...`
- 额外执行：
  - `lzma e bootlogo.bmp -> bootlogo.bmp.lzma`

---

### 11) 拷贝 boot 二进制（boot0/u-boot/scp/optee 等）
遍历 `possible_bin_path`：

- `bin`
- `configs/<plan>/bin`
- `configs/<plan>/<platform>/bin`

在 `device/config/chips/<platform>/` 下找可用目录，命中后通过 `boot_file_list` 批量复制成标准名到 `image/`（如 `boot0_nand.fex`、`u-boot.fex`）。

如果一个 `BIN_PATH` 都没命中，直接报错退出：`No BIN_PATH found!`。

---

### 12) secure 模式补拷安全启动文件
若 `PACK_SECURE=secure` 或 `PACK_SIG=secure/prev_refurbish`，额外拷贝 `arm/arm64_boot_file_secure` 里的文件（`sboot/optee/secure u-boot` 等）。

---

### 13) 平台定制脚本二次修补
如果存在以下脚本会执行：

- `device/config/chips/<platform>/tools/plat_config.sh`
- `target/allwinner/<platform>-common/tools/plat_config.sh`

这一步常用于按板特性动态改 `sys_config.fex`、`env.cfg` 等。

---

### 14) 写入安全标志到 `sys_config.fex`
- secure：`burn_secure_mode=1`，`secure_without_OS=0`
- prev_refurbish：`burn_secure_mode=1`，`secure_without_OS=1`
- 普通模式：删除这两个字段

---

### 15) debug 口切换（card0）
若 `PACK_DEBUG=card0` 且不是 `dump/prvt`，调用 `uart_switch` 改 pin/uart 配置。  
否则恢复 `auto_print_used` 行。

---

### 16) 清洗 `image.cfg/boot-resource.ini` 格式
做路径斜杠和 `imagename` 行处理，避免旧配置污染。

---

### 17) 生成最终镜像名 `IMG_NAME`
基础名：

- `${PACK_PLATFORM}_${PACK_BOARD}_${PACK_DEBUG}`

然后按模式追加后缀（`secure`、`dump`、`_nor`、版本号 `v<MAIN_VERSION>` 等），最后写回 `image/image.cfg` 的 `imagename = ...`。

---

### 18) 调整 `env.cfg`（由 `.config` 驱动）
根据开关改启动参数：

- `CONFIG_BOOT_TIME_OPTIMIZATION`
- `CONFIG_TARGET_ROOTFS_SQUASHFS/EXT4FS`
- `CONFIG_SYSTEM_INIT_BUSYBOX`
- `CONFIG_SUNXI_SMALL_STORAGE_OTA`
- `CONFIG_USE_SELINUX`

并备份一份 `env_bk.cfg`。

---

### 19) 生成额外分区镜像并把分区信息回填 `sys_config.fex`
- `make_boottone_fex`
- `make_user_res`
- `make_app_res`
- `make_data_res`
- `update_mbr_to_sys_config`

如果存在 `sys_partition_nor.fex` 就按 NOR 分区做；否则按普通 `sys_partition.fex` 做。

---

## 四、`do_prepare` 的输出结果（后续步骤依赖这些）

最重要的是 `out/<board>/image/` 里准备好了：

- 主配置：`sys_config.fex`, `sys_partition.fex`, `image.cfg`, `env.cfg`
- 启动件：`boot0_*`, `u-boot.fex`, `scp.fex`, `optee.fex`, `boot_package*.fex`（视模式）
- 资源：`boot-resource/...`, `bootlogo.bmp.lzma`
- 可选分区镜像：`user-resource.fex`, `app.fex`, `data.fex` 等
- 最终镜像名已经写入 `image.cfg`

后续 `do_ini_to_dts` / `do_common` 基本都围绕这个目录继续加工。

---

如果你愿意，我下一步可以按你当前 `r818-sc3917` 的实际目录，给你列一张“**每个关键文件最终来源路径对照表**”（例如你现在的 `env.cfg`、`sys_partition.fex` 到底来自 default 还是 sc3917/linux），这个对定位“改了文件但不生效”特别有用。



---

**User**

分析一下do_prepare都复制了哪些文件

---

**Cursor**

可以，`do_prepare` 里“复制文件”主要分 4 大类，我按你这个板 `r818-sc3917` 给你串起来：

---

## 1) 复制工具文件到 `out/r818-sc3917/image/`

来自 `tools_file_list`，目标目录都是 `image/` 根目录。典型包括：

- `split_xxxx.fex`
- `usbtool.fex` / `usbtool_test.fex` / `usbtool_crash.fex`
- `cardtool.fex`
- `cardscript.fex` / `cardscript_secure.fex`
- `aultools.fex` / `aultls32.fex`

来源按“候选列表顺序 + 后拷覆盖前拷”，主要会从这些路径取：

- `target/allwinner/generic/tools/`
- `device/config/common/tools/`
- `target/allwinner/r818-common/tools/`（若存在）
- `device/config/chips/r818/tools/`

---

## 2) 复制配置文件到 `image/`

来自 `configs_file_list`，常见被拷进去的有：

- `toc0.fex` / `toc1.fex`
- `sunxi.fex`
- `image.cfg`、`image_android.cfg`、`image_dragonboard.cfg`…
- `sys_partition.fex`、`sys_partition_dump.fex`、`sys_partition_private.fex`
- `boot_package.cfg`（你当前正在看这个）
- `env.cfg` / `env_burn.cfg` / `env_dragon.cfg`
- `fit-image.its`
- `version_base.mk`
- `parameter.fex`、`diskfs.fex` 等

对你板子，重点来源通常是：

- `device/config/chips/r818/configs/default/`
- `device/config/chips/r818/configs/sc3917/`
- `device/config/chips/r818/configs/sc3917/linux/`
- 再叠加 `target/allwinner/generic/...`

另外还有一步“平台后缀覆盖”：
- `*_linux.cfg/fex` 会覆盖成无后缀名（例如 `image_linux.cfg -> image.cfg`）

---

## 3) 复制 boot-resource（资源文件）

来自 `boot_resource_list`，会复制到：

- `image/boot-resource/`
- 或 `image/`

典型是：

- `boot-resource/` 整个目录（logo、电量图等）
- `boot-resource.ini`
- 板级 bmp（你提到的 `bootlogo.bmp` 就在这里进入）
- 然后 `do_prepare` 还会把 `boot-resource/bootlogo.bmp` 压成 `bootlogo.bmp.lzma`（这一步是生成，不是复制）

---

## 4) 复制 boot 二进制到标准名字（最关键）

来自 `boot_file_list`，会在 `BIN_PATH` 候选中找现成 bin，然后复制成 `image/*.fex`：

- `boot0_nand_*.bin -> boot0_nand.fex`
- `boot0_sdcard_*.bin -> boot0_sdcard.fex`
- `fes1_*.bin -> fes1.fex`
- `u-boot-*.bin -> u-boot.fex`
- `u-boot-crashdump-*.bin -> u-boot-crash.fex`
- `bl31.bin -> monitor.fex`
- `scp.bin -> scp.fex`
- `optee_*.bin -> optee.fex`
- （还有 spinor / ota_test / dsp 相关可选项）

`BIN_PATH` 会在这几个目录里找（相对 `device/config/chips/r818/`）：

- `bin`
- `configs/sc3917/bin`
- `configs/sc3917/linux/bin`

你现在 `image/` 里看到 `boot0_nand.fex/u-boot.fex/monitor.fex/scp.fex/optee.fex/fes1.fex`，就是这一步拷进来的。

---

## 额外说明（不是“复制”，但和你排查相关）

`do_prepare` 还会按模式做“替换拷贝”：

- dump 模式：`sys_partition_dump.fex -> sys_partition.fex`
- private 模式：`sys_partition_private.fex -> sys_partition.fex`
- dm-verity 开启：`sys_partition_secure.fex -> sys_partition.fex`（若存在）

---

如果你要，我可以下一步按你当前 `out/r818-sc3917/image/` 实际文件，给你做一份“**每个文件的最终来源路径**”清单（逐个文件对应 source path）。这对改配置后验证是否生效非常直接。

