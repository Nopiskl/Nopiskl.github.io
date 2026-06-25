# MCU build process differences in fastboot and normal modes
_Exported on 2026/4/21 at GMT+8 14:38:37 from Cursor (2.6.21)_

---

**User**

@SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk @SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Buildroot-RV1106_Luckfox_Pico_Ultra_W-IPC.mk 
帮我结合源码详细分析一下fastboot和正常模式下，MCU构建过程有什么区别？

---

**Cursor**


## 结论先说

**fastboot 和正常模式下，MCU“构建过程”的本质区别是：**

1. **fastboot 模式会在顶层构建里显式触发 MCU 源码编译**
   - 先编出 `rtthread.bin`
   - 再把这个新产物覆盖到 U-Boot/rkbin 的 `Hpmcu=` 打包项里
   - 最终生成的 loader/boot 流程里，MCU 固件是这次构建产出的

2. **正常模式在顶层构建里不会触发 MCU 源码编译**
   - 不会调用 `build_mcu`
   - 板级配置里也没有指定 `RK_UBOOT_RKBIN_MCU_CFG`
   - 因此从 Luckfox 顶层构建链路看，**正常模式没有独立的 MCU 源码构建步骤**

3. **更深一层的功能差异是：**
   - fastboot 下 MCU 不是“可有可无”，而是 **thunder boot/fast AE 的核心参与者**
   - 正常模式下，相机初始化、AE/AWB、ISP 接管主要回到 Linux/kernel/userspace 侧，MCU 不再承担这条快起主流程

---

# 一、先看两个板级配置，差异其实已经很明显了

## 1）fastboot 板级配置明确打开了 fastboot，并指定 MCU 板型

在你给的 fastboot 配置里：

```109:128:/home/alientek/RV1106/SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk
# specify post.sh for delete/overlay files
export RK_POST_BUILD_SCRIPT=luckfox-rv1106-tb-emmc-post.sh

# specify pre-oem.sh for delete/overlay files before packaging oem.img
export RK_PRE_BUILD_OEM_SCRIPT=luckfox-rv1106-tb-pre-oem.sh

# enable fastboot
export RK_ENABLE_FASTBOOT=y
```

并且前面还专门指定了 MCU 选择：

```67:79:/home/alientek/RV1106/SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk
# Uboot defconfig
export RK_UBOOT_DEFCONFIG=luckfox_rv1106_uboot_emmc_tb_defconfig

# Uboot compile rkbin ini file path overlay
# export RK_UBOOT_RKBIN_INI_OVERLAY=RKBOOT/RV1106MINIALL_TB_SC3336_SC3338.ini
# build.sh mcu info --> rv1106_evb-SC3338-ADC
export RK_UBOOT_RKBIN_MCU_CFG=rv1106_evb-SC3338-ADC

# Kernel defconfig
export RK_KERNEL_DEFCONFIG=luckfox_rv1106_linux_tb_defconfig
```

这里有三个关键信号：

- `RK_ENABLE_FASTBOOT=y`
- `RK_UBOOT_RKBIN_MCU_CFG=rv1106_evb-SC3338-ADC`
- U-Boot / Kernel 都是 `*_tb_*defconfig`

这说明 fastboot 不是只改了 rootfs，而是**整条启动链都切到了 thunder boot 体系**。

---

## 2）正常模式配置里没有打开 fastboot，也没有 MCU 构建入口参数

正常模式配置里是这样：

```67:79:/home/alientek/RV1106/SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Buildroot-RV1106_Luckfox_Pico_Ultra_W-IPC.mk
# Uboot defconfig
export RK_UBOOT_DEFCONFIG=luckfox_rv1106_uboot_defconfig

# Kernel defconfig
export RK_KERNEL_DEFCONFIG=luckfox_rv1106_linux_defconfig

# Kernel defconfig fragment
export RK_KERNEL_DEFCONFIG_FRAGMENT=rv1106-bt.config
```

而且整个文件里：

- **没有** `RK_ENABLE_FASTBOOT=y`
- **没有** `RK_UBOOT_RKBIN_MCU_CFG=...`
- kernel/uboot 也不是 `tb` defconfig

这就决定了：**顶层构建不会走 MCU 快启链路**。

---

# 二、顶层 `project/build.sh` 是怎么把 MCU 接进 fastboot 构建链的

核心逻辑在 `build_uboot()`。

## fastboot 时：会先编 MCU，再替换 `Hpmcu=`

```706:737:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
	if [ "$RK_ENABLE_FASTBOOT" = "y" -a -n "$RK_UBOOT_RKBIN_MCU_CFG" ]; then
		uboot_rkbin_ini=$RK_PROJECT_PATH_FASTBOOT/rk_uboot_rkbin_rkboot_overlay.ini
		build_mcu $RK_UBOOT_RKBIN_MCU_CFG "__MCU_CONTINUE__"
		case $RK_BOOT_MEDIUM in
		emmc)
			tempfile=$target_ini_dir/RV1106MINIALL_EMMC_TB.ini
			;;
		sd_card)
			tempfile=$target_ini_dir/RV1106MINIALL_SDMMC_TB.ini
			;;
		spi_nor)
			tempfile=$target_ini_dir/RV1106MINIALL_SPI_NOR_TB.ini
			;;
		spi_nand | slc_nand)
			tempfile=$target_ini_dir/RV1106MINIALL_SPI_NAND_TB.ini
			;;
		*)
			echo "build uboot Not support storage medium type: $RK_BOOT_MEDIUM"
			finish_build
			exit 1
			;;
		esac

		if [ -f "$RK_PROJECT_FILE_SYSDRV_MCU_BIN" ]; then
			__modify_file $tempfile $uboot_rkbin_ini "Hpmcu=" "$RK_PROJECT_FILE_SYSDRV_MCU_BIN" "^"
		else
			msg_error "build mcu <$RK_UBOOT_RKBIN_MCU_CFG> failed"
			exit 1
		fi
	fi
```

这段逻辑可以直接翻译成：

- 若启用 fastboot 且定义了 `RK_UBOOT_RKBIN_MCU_CFG`
- 则：
  1. 执行 `build_mcu`
  2. 选取对应介质的 `*_TB.ini`
  3. 把 ini 文件里的 `Hpmcu=` 替换成这次刚编出来的 MCU 固件路径

所以 **fastboot 的 MCU 是“源码参与构建 + 动态注入打包”**。

---

## 正常模式时：这整段逻辑根本不会进

因为正常模式配置里没有：

- `RK_ENABLE_FASTBOOT=y`
- `RK_UBOOT_RKBIN_MCU_CFG=...`

所以这整个 `if` 不成立。

结果就是：

- 不会调用 `build_mcu`
- 不会生成 `rk_uboot_rkbin_rkboot_overlay.ini`
- 不会主动替换 `Hpmcu=`

所以从顶层构建系统角度，**正常模式没有 MCU 源码构建步骤**。

---

# 三、`build_mcu()` 到底做了什么

看 `project/build.sh` 里的 `build_mcu()`：

```885:927:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
function build_mcu() {
	if [ ! -d "$SDK_SYSDRV_DIR/source/mcu" ]; then
		msg_info "Not found mcu [$SDK_SYSDRV_DIR/source/mcu], ignore"
		exit 1
	fi

	# sync gcc
	if [ ! -d "$SDK_SYSDRV_DIR/source/mcu/prebuilts/gcc" ]; then
		mkdir -p $SDK_SYSDRV_DIR/source/mcu/prebuilts/gcc/linux-x86/riscv64

		wget -P $SDK_SYSDRV_DIR/source/mcu/prebuilts/gcc/linux-x86/riscv64 \
			https://github.com/xpack-dev-tools/riscv-none-embed-gcc-xpack/releases/download/v10.2.0-1.2/xpack-riscv-none-embed-gcc-10.2.0-1.2-linux-x64.tar.gz
...
	$SDK_SYSDRV_DIR/source/mcu/build.sh lunch $build_opt
	$SDK_SYSDRV_DIR/source/mcu/build.sh clean
	mkdir -p $RK_PROJECT_PATH_MCU
	$SDK_SYSDRV_DIR/source/mcu/build.sh all $RK_PROJECT_PATH_MCU
```

这里说明 fastboot 构建时 MCU 的完整动作是：

1. 检查 `source/mcu` 目录
2. 准备 `riscv-none-embed-gcc`
3. `source/mcu/build.sh lunch <board>`
4. `clean`
5. `all <output-path>`

也就是说它不是简单拿预编译 bin，而是**真的走了一遍 MCU RT-Thread BSP 编译**。

---

# 四、MCU 子工程内部又是怎么编的

看 `sysdrv/source/mcu/project/build.sh`：

```272:289:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/project/build.sh
function build_all() {
	echo "============================================"
	choose_default_board

	cd ${SDK_ROOT_DIR}
	scons -C ${SDK_ROOT_DIR}/rt-thread/bsp/rockchip/rv1106-mcu -j${RK_JOBS}

	local _opt
	_opt=""
	if [ -d "$1" ];then
		_opt=$1
	fi
	build_firmware $_opt

	finish_build
}
```

以及它拷贝产物：

```300:307:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/project/build.sh
function build_firmware(){
	mkdir -p ${RK_PROJECT_OUTPUT_IMAGE}

	if [ -d "$1" ];then
		cp -rfa ${SDK_ROOT_DIR}/rt-thread/bsp/rockchip/rv1106-mcu/rtthread.bin  $1
	fi
	cp -rfa ${SDK_ROOT_DIR}/rt-thread/bsp/rockchip/rv1106-mcu/rtthread.bin  ${RK_PROJECT_OUTPUT_IMAGE}
```

也就是说 MCU 子工程的真实构建对象就是：

- `rt-thread/bsp/rockchip/rv1106-mcu`
- 最终产物是 `rtthread.bin`

所以 fastboot 的 MCU 构建链可以概括为：

```text
BoardConfig_FASTBOOT
-> project/build.sh build_uboot()
-> build_mcu(rv1106_evb-SC3338-ADC)
-> sysdrv/source/mcu/build.sh
-> scons 编译 rv1106-mcu BSP
-> 产出 rtthread.bin
-> 回填到 rkbin ini 的 Hpmcu=
-> 与 DDR/SPL 一起打包进 loader
```

---

# 五、为什么 fastboot 模式下 MCU 必须参与：因为 loader 里就有 `Hpmcu`

你打开的 `RKBOOT` ini 已经直接说明了这一点。以 eMMC thunder boot 为例：

```12:20:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/uboot/rkbin/RKBOOT/RV1106MINIALL_EMMC_TB.ini
[LOADER_OPTION]
NUM=3
LOADER1=FlashData
LOADER2=Hpmcu
LOADER3=FlashBoot
FlashData=bin/rv11/rv1106_ddr_924MHz_tb_v1.15.bin
Hpmcu=bin/rv11/rv1106_hpmcu_tb_v1.01.bin
FlashBoot=bin/rv11/rv1106_spl_emmc_tb_v1.00.bin
```

这里 `LOADER2=Hpmcu` 很关键，说明 thunder boot loader 结构里 MCU 固件本来就是二级装载项之一。

而 fastboot 的顶层构建不是直接用这个默认值，而是把 `Hpmcu=` 换成刚编出来的 `rtthread.bin`。

所以：

- **fastboot = MCU 固件是启动镜像的正式组成部分**
- **正常模式 = 顶层构建不主动编这个组成部分**

---

# 六、MCU 编的到底是什么：不是通用小程序，而是 thunder boot 相机快启固件

fastboot 里指定的 MCU 板型是 `rv1106_evb-SC3338-ADC`。它的 defconfig 很能说明用途：

```220:239:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/bsp/rockchip/rv1106-mcu/board/rv1106_evb-SC3338-ADC/defconfig
#
# RT-Thread rockchip isp driver
#
# CONFIG_RT_USING_ISP is not set
CONFIG_RT_USING_ISP3=y
CONFIG_RT_USING_ISP_DDR_ADRESS=0x860000
CONFIG_RT_USING_ISP_DDR_SIZE=0x600000
CONFIG_RT_USING_CHANNEL_MIPI=y
# CONFIG_RT_USING_CHANNEL_DVP is not set
# CONFIG_RT_USING_CHANNEL_LVDS is not set
```

再往下看：

```258:277:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/bsp/rockchip/rv1106-mcu/board/rv1106_evb-SC3338-ADC/defconfig
#
# RT-Thread application
#
# CONFIG_RT_USING_ROCKCHIP_DEMO is not set
CONFIG_RT_USING_RK_BATTERY_IPC=y

#
# RT-Thread Application Rockchip Battery IPC
#
CONFIG_RT_USING_META_DDR_ADRESS=0x800000
# CONFIG_RT_USING_RK_IOT_APP is not set
# CONFIG_ENABLE_DUAL_TRACKING is not set
```

这说明 fastboot 下编出来的 MCU 固件，核心是：

- ISP3
- Camera
- Meta DDR
- RK_BATTERY_IPC（实际就是 thunder boot 那套 camera/AE/共享内存交接逻辑）

它不是普通的“MCU 辅助控制程序”，而是**为 fastboot 相机快起服务的专用 RT-Thread 固件**。

---

# 七、因此“构建过程”上的区别，可以分成 4 层理解

---

## 层 1：顶层触发条件不同

### fastboot
满足条件：

- `RK_ENABLE_FASTBOOT=y`
- `RK_UBOOT_RKBIN_MCU_CFG=rv1106_evb-SC3338-ADC`

所以触发：

- `build_mcu`
- `Hpmcu=` 覆盖
- `*_TB.ini` 打包

### 正常模式
不满足条件，所以：

- 不触发 `build_mcu`
- 不做 `Hpmcu=` 覆盖
- 不走 thunder boot 这条 MCU 注入路径

---

## 层 2：MCU 产物来源不同

### fastboot
MCU 固件来源是：

- `sysdrv/source/mcu` 源码
- `scons` 编出来的 `rtthread.bin`

### 正常模式
从 Luckfox 顶层构建流程看：

- 没有 MCU 源码构建产物参与
- MCU 不是这条构建链的显式输出项

---

## 层 3：与 U-Boot/rkbin 的耦合程度不同

### fastboot
MCU 固件会被塞进 loader 里，并且作为 `Hpmcu` 二级加载项参与启动。

### 正常模式
至少从你给的这套板级配置和顶层脚本看，**没有这条“编 MCU -> 回填 Hpmcu”的动作**。

---

## 层 4：MCU 运行职责不同

### fastboot
MCU 负责：

- 提前读取 meta / IQ
- 提前初始化 sensor / ISP
- 跑 fast AE / fast AWB
- 把结果写共享内存
- Linux 再接管

### 正常模式
这些流程大部分回到：

- Linux kernel 驱动
- ISP 驱动
- 用户态 IPC/rkaiq 等组件

也就是说，**正常模式不是“也编 MCU，只是功能少一点”**，而是**整条职责链本身就换边了**。

---

# 八、你这两个配置里，哪些内容是“会影响 MCU 构建”的，哪些其实只是陪跑

## 真正影响 MCU 构建的关键项

### fastboot 配置里的这些最关键：

```67:79:/home/alientek/RV1106/SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk
export RK_UBOOT_DEFCONFIG=luckfox_rv1106_uboot_emmc_tb_defconfig
export RK_UBOOT_RKBIN_MCU_CFG=rv1106_evb-SC3338-ADC
export RK_KERNEL_DEFCONFIG=luckfox_rv1106_linux_tb_defconfig
```

以及：

```121:128:/home/alientek/RV1106/SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk
# enable fastboot
export RK_ENABLE_FASTBOOT=y

# declare overlay directory
export RK_POST_OVERLAY=overlay-luckfox-fastboot
```

其中真正直接驱动 MCU 编译的是：

- `RK_ENABLE_FASTBOOT`
- `RK_UBOOT_RKBIN_MCU_CFG`

---

## 不直接决定 MCU 构建，但体现模式切换的项

例如：

- `LF_TARGET_ROOTFS=busybox` vs `buildroot`
- 分区不同
- app type 不同
- overlay 不同

这些会影响整机镜像组织、根文件系统、应用层，但**不是 MCU 源码编译触发条件本身**。

所以你问“MCU 构建过程有什么区别”，核心不要被 `busybox/buildroot` 带偏，真正的分水岭是：

- 是否 `RK_ENABLE_FASTBOOT=y`
- 是否配置 `RK_UBOOT_RKBIN_MCU_CFG`
- 是否采用 `tb` 启动链

---

# 九、可以把两种模式的 MCU 构建链，直接画成对照表

| 对比项 | fastboot 模式 | 正常模式 |
|---|---|---|
| BoardConfig 是否开启 fastboot | 开启 | 未开启 |
| 是否指定 MCU 板型 | `RK_UBOOT_RKBIN_MCU_CFG=rv1106_evb-SC3338-ADC` | 无 |
| 顶层是否调用 `build_mcu()` | 会 | 不会 |
| MCU 是否从源码编译 | 会，编 `rtthread.bin` | 顶层流程不会 |
| 是否覆盖 rkbin `Hpmcu=` | 会 | 不会 |
| U-Boot/rkbin 是否走 `*_TB.ini` 注入路径 | 会 | 不走这条路径 |
| MCU 运行职责 | fast AE / sensor / ISP 快启 | 不承担这条快起主流程 |
| Linux 接管方式 | 接共享内存和 thunder boot 状态 | 正常冷启初始化 |

---

# 十、最容易误解的一个点

你可能会看到某些 `RKBOOT/*.ini` 里本来就有 `Hpmcu=`，比如 eMMC TB ini 里就有：

```12:18:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/uboot/rkbin/RKBOOT/RV1106MINIALL_EMMC_TB.ini
[LOADER_OPTION]
NUM=3
LOADER1=FlashData
LOADER2=Hpmcu
LOADER3=FlashBoot
FlashData=bin/rv11/rv1106_ddr_924MHz_tb_v1.15.bin
Hpmcu=bin/rv11/rv1106_hpmcu_tb_v1.01.bin
```

但这不代表“正常模式也等价地构建 MCU”。

**区别在于：**

- fastboot：顶层构建会 **主动重编 MCU 并替换它**
- 正常模式：顶层构建 **根本不进入这条 MCU 构建和替换逻辑**

也就是说，fastboot 下 MCU 是“构建链中的活动产物”，正常模式下 MCU 至少在这套 Luckfox 顶层构建体系里不是。

---

# 十一、把话说得更工程化一点

如果你从 CI / 编译系统的角度定义“MCU 构建过程”：

## fastboot
属于：

- **显式子工程构建**
- 有单独 toolchain 依赖
- 有单独 `lunch` 选板
- 有独立产物 `rtthread.bin`
- 有 U-Boot 打包注入动作

## 正常模式
属于：

- **没有 MCU 子工程构建**
- 没有 `rtthread.bin` 作为这次构建结果参与镜像
- 没有 fastboot 的 meta/shared-memory/AE 交接链路

---

# 十二、最终总结一句话

**fastboot 模式下，MCU 是“被源码构建、被注入 loader、并参与首帧快启”的核心组件；正常模式下，MCU 不进入这条顶层构建链，首帧初始化职责回到 Linux 常规启动路径。**

---

如果你愿意，我下一步可以继续给你补两部分之一：

1. **把 fastboot 下 MCU 从 `build.sh` 到 `rtthread.bin` 再到 `Hpmcu` 打包的完整调用链画成时序图**
2. **继续分析“正常模式下为什么不需要 MCU 参与相机首帧快起”，把 Linux 侧接管路径也串出来**

如果你要，我可以直接按你这两个配置再做一版“fastboot vs 正常模式启动时序对照图”。

