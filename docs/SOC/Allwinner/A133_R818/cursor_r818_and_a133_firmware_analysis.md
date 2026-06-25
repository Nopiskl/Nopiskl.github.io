# R818 and A133 firmware analysis
_Exported on 2026/5/7 at GMT+8 17:24:51 from Cursor (2.6.21)_

---

**User**

帮我分析一下如果我执行build sh编译R818的固件，但是不pack，然乎device/config/chips/r818/bin拿A133的bin替换这个目录（官网说A133是R818的超频版本，驱动都通用），然后再pack，在最后的固件有哪些是R818的，哪些是A133的？

---

**Cursor**


结论先说：**如果你先按 `r818-sc3917` 编译，不打包，然后只把 `device/config/chips/r818/bin/` 换成 A133 的 bin，再执行 pack，最终固件会变成“R818 系统 + A133 早期启动固件”的混合包。**

更准确地说：

- **A133 的部分**：主要是 BootROM 后面最早执行的 bootloader/固件二进制，如 `boot0`、`u-boot`、`bl31`、`scp`、`optee`、`fes1`、安全启动相关 `sboot` 等。
- **R818 的部分**：内核、rootfs、分区表、sys_config、board.dts 生成的 Linux DTB、boot 分区、rootfs 分区、env、boot-resource 等，仍然来自你前面 `build.sh` 编译出来的 R818 工程和 `r818-sc3917` 配置。

---

## 1. pack 时 `r818/bin` 目录具体影响哪些文件

`pack_img.sh` 里定义了 `possible_bin_path`，会从当前芯片配置目录下找这些 bin 目录：

```254:258:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
possible_bin_path=(
bin
configs/${PACK_BOARD#*-}/bin
configs/${PACK_BOARD#*-}/${PACK_PLATFORM_IMAGE_CFG}/bin
)
```

对 `r818-sc3917` 来说，`PACK_BOARD_PLATFORM` 是 `r818`，所以这里实际会从：

```text
device/config/chips/r818/bin
device/config/chips/r818/configs/sc3917/bin
device/config/chips/r818/configs/sc3917/linux/bin
```

里面找 boot 相关 bin。你说替换的是：

```text
device/config/chips/r818/bin
```

而当前这个目录里有：

```text
bl31.bin
boot0_nand_sun50iw10p1.bin
boot0_sdcard_sun50iw10p1.bin
fes1_sun50iw10p1.bin
optee_sun50iw10p1.bin
sboot_sun50iw10p1.bin
scp.bin
u-boot-sun50iw10p1.bin
```

这些正好会被 pack 阶段拷贝成 `out/r818-sc3917/image/` 下的 `.fex` 文件：

```260:277:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
boot_file_list=(
${LONGAN_CONFIG_DIR}/../\${BIN_PATH}/boot0_nand_${PACK_CHIP}.bin:${ROOT_DIR}/image/boot0_nand.fex
${LONGAN_CONFIG_DIR}/../\${BIN_PATH}/boot0_sdcard_${PACK_CHIP}.bin:${ROOT_DIR}/image/boot0_sdcard.fex
${LONGAN_CONFIG_DIR}/../\${BIN_PATH}/boot0_spinor_${PACK_CHIP}.bin:${ROOT_DIR}/image/boot0_spinor.fex
${LONGAN_CONFIG_DIR}/../\${BIN_PATH}/fes1_${PACK_CHIP}.bin:${ROOT_DIR}/image/fes1.fex
${LONGAN_CONFIG_DIR}/../\${BIN_PATH}/u-boot-${PACK_CHIP}.bin:${ROOT_DIR}/image/u-boot.fex
${LONGAN_CONFIG_DIR}/../\${BIN_PATH}/u-boot-crashdump-${PACK_CHIP}.bin:${ROOT_DIR}/image/u-boot-crash.fex
${LONGAN_CONFIG_DIR}/../\${BIN_PATH}/u-boot-crashdump-spinor-${PACK_CHIP}.bin:${ROOT_DIR}/image/u-boot-spinor-crash.fex
${LONGAN_CONFIG_DIR}/../\${BIN_PATH}/bl31.bin:${ROOT_DIR}/image/monitor.fex
${LONGAN_CONFIG_DIR}/../\${BIN_PATH}/scp.bin:${ROOT_DIR}/image/scp.fex
${LONGAN_CONFIG_DIR}/../\${BIN_PATH}/optee_${PACK_CHIP}.bin:${ROOT_DIR}/image/optee.fex
${LONGAN_CONFIG_DIR}/../\${BIN_PATH}/u-boot-spinor-${PACK_CHIP}.bin:${ROOT_DIR}/image/u-boot-spinor.fex
```

所以如果你把 `device/config/chips/r818/bin` 整个换成 A133 的 bin，那么这些 `.fex` 的“初始二进制来源”就是 A133：

| 最终 `out/.../image` 文件 | 来源 | 说明 |
|---|---|---|
| `boot0_nand.fex` | A133 `boot0_nand_sun50iw10p1.bin` | NAND 启动用 boot0 |
| `boot0_sdcard.fex` | A133 `boot0_sdcard_sun50iw10p1.bin` | SD/eMMC 启动用 boot0 |
| `fes1.fex` | A133 `fes1_sun50iw10p1.bin` | FEL/烧录阶段用 |
| `u-boot.fex` | A133 `u-boot-sun50iw10p1.bin` | U-Boot 主体 |
| `monitor.fex` | A133 `bl31.bin` | ARM Trusted Firmware / EL3 monitor |
| `scp.fex` | A133 `scp.bin` | 小核/系统控制固件 |
| `optee.fex` | A133 `optee_sun50iw10p1.bin` | OP-TEE，是否进包看配置 |
| `sboot.bin` | A133 `sboot_sun50iw10p1.bin` | secure boot 模式才相关 |

---

## 2. 但这些 A133 boot 文件会被 R818 配置再次修补

注意不是简单“原样把 A133 bin 塞进固件”。pack 后面会用 `r818-sc3917` 的 `sys_config.fex` 生成 `sys_config.bin`，然后修补 `boot0`、`u-boot`、`fes1` 等。

关键逻辑在这里：

```1112:1129:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
if [ -e boot0_nand.fex ]; then
	update_boot0 boot0_nand.fex	sys_config.bin NAND > /dev/null

	if [ $? -ne 0 ]; then
		pack_error "update_boot0 boot0_nand.fex run error"
		exit 1
	fi
else
	echo "boot0_nand.fex" > boot0_nand.fex
fi


if [ -e boot0_sdcard.fex ]; then
	update_boot0 boot0_sdcard.fex	sys_config.bin SDMMC_CARD > /dev/null
```

以及：

```1135:1141:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
if [ "x${PACK_KERN}" = "xlinux-3.4" ] ; then
	update_uboot -merge u-boot.fex sys_config.bin > /dev/null
else
	update_uboot -no_merge u-boot.fex sys_config.bin > /dev/null
fi
update_fes1  fes1.fex           sys_config.bin > /dev/null
```

所以实际结果应理解成：

```text
A133 boot0/u-boot/fes1 原始二进制
    + R818 sc3917 的 sys_config.bin 修补
    = 最终进入固件的 boot0/u-boot/fes1
```

也就是说：

- **二进制代码主体**：A133
- **打包注入的板级参数**：R818 `sc3917/sys_config.fex`

这点很关键。最终不是纯 A133 bootloader，也不是纯 R818 bootloader，而是 **A133 bootloader 代码 + R818 配置注入**。

---

## 3. boot_package 里哪些是 A133，哪些是 R818

当前 `boot_package.cfg` 是：

```1:8:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/out/r818-sc3917/image/boot_package.cfg
[package]
;item=Item_TOC_name,         Item_filename,
item=u-boot,                 u-boot.fex
item=monitor,                monitor.fex
item=scp,             scp.fex
;item=logo,                   bootlogo.bmp.lzma
;item=shutdowncharge,         bempty.bmp.lzma
;item=androidcharge,          battery_charge.bmp.lzma
item=dtb,                    sunxi.fex
```

pack 时会用它生成 `boot_package.fex`：

```1142:1151:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
fsbuild	     boot-resource.ini  split_xxxx.fex > /dev/null

if [ -f boot_package.cfg ]; then
		echo "pack boot package"
		busybox unix2dos boot_package.cfg
		dragonsecboot -pack boot_package.cfg
		if [ $? -ne 0 ]
		then
```

所以当前普通非 secure 包里，`boot_package.fex` 大概是这样混合的：

| boot_package item | 文件 | 实际归属 |
|---|---|---|
| `u-boot` | `u-boot.fex` | A133 U-Boot 主体 + R818 `sys_config.bin` 修补 |
| `monitor` | `monitor.fex` | A133 `bl31.bin` |
| `scp` | `scp.fex` | A133 `scp.bin`，后续可能被 R818 `sunxi.fex` 更新 |
| `dtb` | `sunxi.fex` | R818 的 Linux DTB，由 R818 DTS + R818 sys_config 生成 |

其中 `sunxi.fex` 不是从 `bin` 目录来的，而是 pack 时由 R818 的内核 DTS 和 R818 的 `sys_config.fex` 转出来的：

```1033:1038:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
$DTC_COMPILER ${DTC_FLAGS} -O dtb -o ${ROOT_DIR}/image/sunxi.dtb	\
	-b 0			\
	-i $DTC_SRC_PATH	\
	-F $DTC_INI_FILE	\
	-d $DTC_DEP_FILE $DTC_SRC_FILE &> /dev/null
```

然后：

```1092:1096:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
if [ -f "sunxi.dtb" ]; then
	cp sunxi.dtb sunxi.fex
	update_dtb sunxi.fex 4096
fi
```

所以 `boot_package.fex` 是一个典型混合体：

```text
boot_package.fex =
    A133 u-boot
  + A133 bl31
  + A133 scp
  + R818/sc3917 Linux DTB
```

---

## 4. 最终固件里明确属于 R818 的部分

你的编译动作是先 `build.sh` 编译 R818，所以下面这些仍然是 R818 的：

### 4.1 内核

`target/allwinner/r818-sc3917/Makefile` 指定当前目标：

```7:19:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/target/allwinner/r818-sc3917/Makefile
include $(TOPDIR)/rules.mk

ARCH:=aarch64
BOARD:=r818-sc3917
BOARDNAME:=r818-sc3917
FEATURES:=fpu ramdisk
CFLAGS:=-Os -pipe -fno-caller-saves
MAINTAINER:=Allwinner

KERNEL_PATCHVER:=4.9
UBOOT_PATCHVER:=2018
```

所以 `boot.fex`、`Image.gz`、`vmlinux.fex` 等内核相关内容，仍然是 `r818-sc3917` 编译产物。

### 4.2 rootfs

`rootfs.fex` 也来自前面 R818 编译出来的 OpenWrt/Tina rootfs，不会因为换 `device/config/chips/r818/bin` 而变成 A133。

### 4.3 分区表

当前分区配置仍然来自 R818：

```27:68:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/out/r818-sc3917/image/sys_partition.fex
[partition]
    name         = boot-resource
    size         = 4096
    downloadfile = "boot-resource.fex"
    user_type    = 0x8000

[partition]
    name         = env
    size         = 1024
    downloadfile = "env.fex"
    user_type    = 0x8000

[partition]
    name         = env-redund
    size         = 1024
    downloadfile = "env.fex"
    user_type    = 0x8000

[partition]
    name         = boot
    size         = 30720
    downloadfile = "boot.fex"
    user_type    = 0x8000

[partition]
    name         = rootfs
    size         = 105984
    downloadfile = "rootfs.fex"
    user_type    = 0x8000
```

所以这些分区内容仍是 R818：

| 分区 | 文件 | 归属 |
|---|---|---|
| `boot-resource` | `boot-resource.fex` | R818 配置/资源 |
| `env` | `env.fex` | R818 env.cfg 生成 |
| `env-redund` | `env.fex` | R818 env.cfg 生成 |
| `boot` | `boot.fex` | R818 kernel boot image |
| `rootfs` | `rootfs.fex` | R818 rootfs |
| `recovery` | `recovery.fex` | R818 recovery/空 recovery，取决于配置 |
| `rootfs_data` | 无 downloadfile | 运行时数据分区 |

### 4.4 `sys_config.fex` / `sys_config.bin`

仍然是 R818 `sc3917` 的配置。换 `bin` 不会改变这个文件的来源。

### 4.5 Linux DTB：`sunxi.fex`

仍然是 R818 DTS + R818 sys_config 生成的 DTB，也就是内核实际看到的硬件描述仍偏 R818/sc3917。

---

## 5. 最终固件里明确属于 A133 的部分

如果你替换的是整个 `device/config/chips/r818/bin`，并且 A133 文件名仍然叫 `*_sun50iw10p1.bin`，那么这些会变成 A133 来源：

| 固件组件 | 文件 | 是否进入最终固件 | 说明 |
|---|---|---|---|
| Boot0 NAND | `boot0_nand.fex` | 是 | A133 boot0 + R818 sys_config 修补 |
| Boot0 SD/eMMC | `boot0_sdcard.fex` | 是 | A133 boot0 + R818 sys_config 修补 |
| U-Boot | `u-boot.fex` | 是 | A133 U-Boot + R818 sys_config 修补 |
| ATF / BL31 | `monitor.fex` | 是，位于 `boot_package.fex` | A133 |
| SCP | `scp.fex` | 是，位于 `boot_package.fex` | A133，可能被 R818 DTB 更新 |
| FES1 | `fes1.fex` | 是，用于烧录/FEL | A133 + R818 sys_config 修补 |
| OP-TEE | `optee.fex` | 看 `boot_package.cfg` / secure 配置 | 当前普通 `boot_package.cfg` 没放进去 |
| SBoot | `sboot.bin` | secure/sign 模式才相关 | A133 |

---

## 6. 最后固件的大致归属总表

按“最终烧录包里的东西”分类，大概是这样：

| 类型 | 最终文件/内容 | 归属判断 |
|---|---|---|
| BootROM 后第一级 | `boot0_nand.fex` / `boot0_sdcard.fex` | **A133 主体 + R818 参数** |
| U-Boot | `u-boot.fex` | **A133 主体 + R818 参数** |
| ATF BL31 | `monitor.fex` | **A133** |
| SCP | `scp.fex` | **A133 主体，可能叠加 R818 DTB 信息** |
| OP-TEE | `optee.fex` | **A133**，但当前普通包未必使用 |
| FES1 | `fes1.fex` | **A133 主体 + R818 参数** |
| boot package | `boot_package.fex` | **A133 bootloader 固件 + R818 DTB 的混合体** |
| Linux DTB | `sunxi.fex` | **R818/sc3917** |
| 内核 | `boot.fex`、`Image.gz` | **R818 编译产物** |
| rootfs | `rootfs.fex` | **R818 编译产物** |
| recovery | `recovery.fex` | **R818 编译产物/配置产物** |
| env | `env.fex` | **R818 配置产物** |
| boot-resource | `boot-resource.fex` | **R818 配置/资源产物** |
| 分区表 | `sys_partition.fex`、`sunxi_mbr.fex`、`sunxi_gpt.fex` | **R818 配置产物** |
| sys_config | `sys_config.fex`、`sys_config.bin` | **R818/sc3917** |

一句话概括：

```text
最终固件 =
    A133 的早期启动链二进制
  + R818/sc3917 的板级配置注入
  + R818 的 kernel
  + R818 的 dtb
  + R818 的 rootfs
  + R818 的分区/env/resource
```

---

## 7. 风险点

虽然官网说 A133 是 R818 的超频版本、驱动通用，但这个替换方式风险主要不在 Linux 驱动，而在 **早期启动链**：

1. **DRAM 初始化风险**  
   `boot0` 负责很早期的 DDR/DRAM 初始化。即使 A133/R818 同属 `sun50iw10p1`，如果 A133 boot0 里的默认训练参数、频率、电压策略和你板子的 DDR 不完全匹配，可能直接不开机。

2. **电压/频率策略风险**  
   A133 作为“超频版本”，BL31、SCP、U-Boot 里可能带有更高频率或不同 DVFS/PMIC 假设。  
   R818 体质或板级供电不一定能承受。

3. **U-Boot DTS / sys_config 混合风险**  
   你最终会得到 “A133 U-Boot + R818 sys_config 修补”。这通常比纯 A133 包安全一些，但如果 A133 U-Boot 内部默认 DTS、默认 clock、PMIC、存储初始化逻辑有差异，仍可能异常。

4. **SCP/ARISC/电源管理风险**  
   `scp.bin` 这类固件可能影响待机、功耗、时钟、电源域管理。能启动不代表稳定。

5. **secure boot 风险**  
   如果启用 secure/sign，`sboot`、`optee`、`toc0/toc1` 也会参与，混用风险更高。

---

## 8. 建议验证方式

如果你只是想确认 A133 bin 能不能用于 R818，我建议按这个顺序试：

1. **先只替换 `u-boot-sun50iw10p1.bin`**  
   不动 `boot0`、`bl31`、`scp`，看 U-Boot 是否可用。

2. **再替换 `bl31.bin` / `scp.bin`**  
   看启动和系统稳定性。

3. **最后再替换 `boot0_*`**  
   因为 boot0 最危险，失败时可能连串口早期输出都没有。

4. **保留原始 `r818/bin` 备份**  
   方便快速回退。

5. **抓串口日志**  
   尤其关注：
   - `BOOT0`
   - DRAM init
   - U-Boot banner
   - ATF/BL31 输出
   - kernel 启动前后的 clock / regulator / cpufreq 信息

如果你的目标只是“让 R818 跑 A133 的高频参数”，更推荐定点比较/移植 `boot0`、U-Boot、SCP 里的频率/电压配置，而不是整包替换全部 bin。

