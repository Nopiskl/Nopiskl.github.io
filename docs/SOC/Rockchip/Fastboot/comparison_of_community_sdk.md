# Comparison of community SDK and official SDK
_Exported on 2026/4/21 at GMT+8 15:06:03 from Cursor (2.6.21)_

---

**User**

请你对比https://github.com/LuckfoxTECH/luckfox-pico 的社区SDK，和我当前工作区官方SDK，分析一下社区SDK都做了什么改动？

---

**Cursor**

---

## Luckfox Pico 社区 SDK 与当前官方 RK356x SDK 对比分析

### 一、基本信息对比

| 对比项 | 官方 SDK (rk356x-linux) | 社区 SDK (luckfox-pico) |
|--------|------------------------|------------------------|
| 目标芯片 | RK3568 / RK3566 (Cortex-A55 四核) | RV1103 / RV1106 (ARM + RISC-V MCU) |
| 内核版本 | 5.10.160 | 5.10.160 (相同) |
| 架构 | ARM64 (aarch64) | ARM32 |
| 工具链 | aarch64-none-linux-gnu (glibc) | arm-rockchip830-linux-uclibcgnueabihf (uclibc) |
| 根文件系统 | Buildroot / Debian / Yocto | Buildroot / Busybox / Ubuntu |

两者虽然针对不同芯片，但都基于 Rockchip 官方 SDK 框架改造而来（Luckfox 在 README 中明确声明: "This SDK is modified based on the SDK provided by Rockchip"）。

---

### 二、目录结构的重大重组

这是社区 SDK 最显著的改动。Luckfox 对 Rockchip 标准 SDK 的目录结构进行了大幅精简和重组：

**官方 SDK 结构（您的工作区）：**
```
rk356x-linux/
├── kernel/           # 内核源码（顶层）
├── u-boot/           # U-Boot 源码（顶层）
├── buildroot/        # Buildroot 根文件系统
├── debian/           # Debian 根文件系统
├── yocto/            # Yocto 根文件系统
├── rkbin/            # Rockchip 二进制固件（DDR/loader等）
├── external/         # 外部库和组件
├── device/rockchip/  # 设备配置和构建脚本
├── app/              # 应用程序
├── tools/            # 打包/烧写工具
├── prebuilts/        # 预编译工具链
├── docs/             # 文档
└── uefi/             # UEFI 支持
```

**社区 SDK 结构：**
```
luckfox-pico/
├── sysdrv/           # 系统驱动（整合了kernel+uboot+mcu）
│   ├── source/
│   │   ├── kernel/   # 内核源码（嵌套在sysdrv下）
│   │   ├── uboot/    # U-Boot源码（嵌套在sysdrv下）
│   │   └── mcu/      # MCU RT-Thread RTOS（新增）
│   ├── cfg/          # 系统驱动配置
│   ├── drv_ko/       # 驱动模块
│   └── tools/        # sysdrv专用工具
├── media/            # 多媒体库（独立顶层目录）
│   ├── isp/          # ISP 图像信号处理
│   ├── mpp/          # 多媒体处理平台
│   ├── rga/          # 2D图形加速
│   ├── rockit/       # 多媒体框架
│   ├── luckfox/      # Luckfox定制库
│   └── samples/      # 示例代码
├── project/          # 构建系统（整合了构建脚本和配置）
│   ├── build.sh      # 主构建脚本
│   ├── cfg/          # 板级配置
│   ├── app/          # 应用程序
│   └── scripts/      # 辅助脚本
├── tools/            # 烧写和开发工具
│   ├── linux/        # Linux工具 + 交叉工具链
│   └── windows/      # Windows工具
├── build.sh -> ./project/build.sh  # 顶层符号链接
└── rkflash.sh        # 快速烧写脚本（新增）
```

**关键区别总结：**
- 官方 SDK 将 kernel、u-boot 放在顶层；社区 SDK 收入 `sysdrv/source/` 下
- 官方 SDK 构建系统在 `device/rockchip/common/scripts/`；社区 SDK 在 `project/`
- 社区 SDK 删除了 `debian/`、`yocto/`、`uefi/`、`rkbin/`、`external/` 等目录
- 社区 SDK 新增了 `media/` 顶层目录、`sysdrv/source/mcu/`

---

### 三、构建系统的完全重写

**官方 SDK 构建系统：**
- 基于 hook 机制 (`device/rockchip/common/scripts/build.sh`)
- 使用 `mk-*.sh` 模块化脚本
- 配置文件在 `device/rockchip/.chips/` 下

**社区 SDK 构建系统：**
- 采用 Android 风格的 `lunch` 菜单系统
- `./build.sh lunch` 提供三级选择：硬件型号 -> 存储介质(SD/NAND/eMMC) -> 系统类型
- 板级配置文件采用 `BoardConfig-{存储}-{系统}-{硬件}-{场景}.mk` 命名规范
- 新增 `buildrootconfig` 和 `kernelconfig` 快捷命令
- 新增 `rkflash.sh` 一键烧写脚本

这是一个面向小型开发板的用户友好型重构，降低了上手门槛。

---

### 四、MCU 支持（全新添加）

社区 SDK 在 `sysdrv/source/mcu/` 下新增了 **RT-Thread RTOS** 支持，这是官方 RK356x SDK 中不存在的。RV1106 芯片内置 RISC-V MCU 核心，Luckfox SDK 为其提供了：
- RT-Thread BSP (`rt-thread/bsp/rockchip/rv1106-mcu`)
- Rockchip HAL 库
- 电池 IPC 应用示例
- 独立的构建/menuconfig 支持

---

### 五、多媒体库的独立化

**官方 SDK：** 多媒体组件分散在 `external/` 目录下（如 `external/camera_engine_rkaiq/`、`external/rkmedia/` 等）

**社区 SDK：** 将 IPC 相关的多媒体组件集中到独立的 `media/` 顶层目录：
- `isp/` - 图像信号处理 (ISP)
- `mpp/` - 多媒体处理平台 (MPP)
- `rga/` - 2D 图形加速 (RGA)
- `rockit/` - 多媒体框架
- `ive/` - 智能视频引擎
- `iva/` - 智能视觉分析
- `common_algorithm/` - 通用算法
- `rkpostisp/` - 后处理 ISP
- `luckfox/` - Luckfox 专有库
- `samples/` - 示例代码
- `alsa-lib/`、`libdrm/`、`libv4l/` - 基础媒体库

这种组织方式更贴合 IPC (网络摄像头) 应用场景。

---

### 六、工具链差异

| 对比项 | 官方 SDK | 社区 SDK |
|--------|---------|---------|
| 路径 | `prebuilts/gcc/linux-x86/aarch64/` | `tools/linux/toolchain/` |
| 工具链 | gcc-arm-10.3-2021.07 (aarch64) | arm-rockchip830-linux-uclibcgnueabihf |
| C 库 | glibc | uclibc (更小的内存占用) |
| 位宽 | 64 位 | 32 位 |
| 初始化 | 预配置 | 需要运行 `env_install_toolchain.sh` 设置环境变量 |

社区 SDK 选择 uclibc 而非 glibc，是因为 RV1103/RV1106 是资源受限的小型 SoC，uclibc 能显著减少内存和存储占用。

---

### 七、烧写工具增强

**官方 SDK tools/ 目录：** 包含 boot_merger、Firmware_Merger、Linux_Upgrade_Tool、各种签名/安全工具等通用 Rockchip 工具。

**社区 SDK tools/ 目录新增：**
- `SocToolKit/` - SoC 工具套件
- `windows/` - Windows 烧写工具
- 顶层 `rkflash.sh` - 一键烧写脚本

---

### 八、板级支持的定制化

社区 SDK 针对 Luckfox Pico 系列开发板添加了大量定制：

- **支持 11 款硬件型号：** Pico、Pico Mini、Pico Plus、Pico WebBee、Pico Pro Max、Pico Ultra/Ultra W、Pico Pi/Pi W、Pico 86Panel/86Panel W
- **支持 3 种存储介质：** SD_CARD、SPI_NAND、eMMC
- **支持快速启动 (FastBoot)：** Busybox 方案的超快启动
- **WiFi 配置集成：** 板级配置文件中内置 WiFi SSID/PSK 配置
- **luckfox-config 工具：** 可在板端系统运行的引脚和接口配置工具
- **默认服务自启：** SSH (root/luckfox)、Samba (root/luckfox)、ADB

---

### 九、被移除的组件

社区 SDK 相比官方 SDK 删除了以下组件：
- `debian/` - Debian 根文件系统构建
- `yocto/` - Yocto 根文件系统构建
- `uefi/` - UEFI 引导支持
- `rkbin/` - 作为独立目录不再存在（可能整合进 sysdrv）
- `external/` - 外部组件目录（media 部分独立出来，其余精简）
- `prebuilts/` - 预编译工具链（移至 tools/linux/toolchain/）
- `docs/` - 文档目录
- `agent/` - 代理组件
- 大量不适用于 RV1103/RV1106 的 RK3568 特定配置

---

### 十、版本演进（从 V1.0 到 V1.4）

根据更新日志，社区 SDK 的主要迭代：

1. **V1.0** - 初次上传，默认 busybox 系统
2. **V1.1** - 迁移到 Buildroot，默认开启 Python3、SSH、Samba、ADB
3. **V1.2** - 添加 Ubuntu 系统兼容和 exFAT 支持
4. **V1.3** - 优化 lunch 选择流程、Buildroot 包管理、添加 kernelconfig/buildrootconfig、luckfox-config 工具
5. **V1.4** - U-Boot 快速启动支持、SD 卡兼容性优化、内核升级到 5.10.160、Buildroot 镜像源优化、自定义文件系统支持

---

### 总结

Luckfox 社区 SDK 本质上是对 Rockchip 官方 SDK 的一次**面向 IPC 小型开发板的深度定制和简化**。主要改动可以概括为：

1. **目录结构重组** - 更紧凑、更适合小型项目
2. **构建系统重写** - Android lunch 风格，降低使用门槛
3. **新增 MCU 支持** - RT-Thread RTOS 支持 RV1106 的 RISC-V MCU 核心
4. **多媒体库独立化** - 集中管理 IPC 相关组件
5. **工具链精简** - 从 glibc 转为 uclibc，减少资源占用
6. **板级高度定制** - 针对 Luckfox Pico 系列的开箱即用体验
7. **删除不需要的组件** - 移除 Debian/Yocto/UEFI 等对小型 SoC 不必要的支持

如果您的 RK3568 项目中有类似需求（如简化构建流程、优化 lunch 菜单等），可以借鉴社区 SDK 的一些设计思路。

---

**User**

请你继续对比社区SDK和当前SDK的构建和打包脚本等，分析一下社区SDK是自研sh还是缝合借鉴RK官方1sh

---

**Cursor**

结论先说：

## 结论

**社区 SDK 不是“完全自研的一套新 sh 构建系统”，而是明显“基于 Rockchip 官方 SDK 的脚本体系做了重组、裁剪、改壳和局部重写”的缝合型方案。**

更准确地说：

- **底层打包/烧录思路：高度继承 RK 官方**
- **顶层入口和用户交互：做了较明显的 Luckfox 自定义**
- **整体性质：`官方脚本体系 + 项目目录重组 + 板卡定制菜单 + 少量自写辅助脚本`**

所以如果非要二选一：
- 不是纯自研
- 更像 **“借鉴/移植/裁剪 RK 官方 1sh 多脚本体系，再包装成 Luckfox 风格入口”**

---

## 一、当前官方 SDK 的构建/打包脚本是什么形态

你当前工作区这套 RK356x SDK，核心是一个**分层 hook 化总控脚本**。

### 1) 主入口是一个“总调度器”

`device/rockchip/common/scripts/build.sh` 不是单纯一个 case 分发脚本，它有完整的：

- 环境初始化
- 日志系统
- 配置加载
- hook 扫描
- build/pre-build/post-build 阶段调度
- 各模块 `mk-*.sh` 自动注册

比如这里能直接看出它是“模块注册式”而不是硬编码式：

```1:22:/home/alientek/RK3568/rk356x-linux/device/rockchip/common/scripts/build.sh
usage()
{
	echo "Usage: $(basename $BASH_SOURCE) [OPTIONS]"
	echo "Available options:"

	run_build_hooks usage

	# Global options
	echo -e "cleanall                          \tcleanup"
	echo -e "clean[:module[:module]]...        \tcleanup modules"
	echo "    available modules:"
	grep -wl clean_hook "$SCRIPTS_DIR"/mk-*.sh | \
		sed "s/^.*mk-\(.*\).sh/\t\1/"
```

这说明：
- 官方 SDK 本身已经不是“单个 build.sh”
- 而是 `build.sh + mk-all.sh + mk-kernel.sh + mk-rootfs.sh + mk-firmware.sh + mk-updateimg.sh ...` 的框架

### 2) 官方 SDK 是 hook 驱动的模块体系

它会扫描目录里所有模块脚本运行 hook：

```159:188:/home/alientek/RK3568/rk356x-linux/device/rockchip/common/scripts/build.sh
run_hooks()
{
	DIR="$1"
	shift

	for dir in "$CHIP_DIR/$(basename "$DIR")/" "$DIR"; do
		[ -d "$dir" ] || continue

		for hook in $(find "$dir" -maxdepth 1 -name "*.sh" | sort); do
			"$hook" $@ && continue
			HOOK_RET=$?
			err_handler $HOOK_RET "${FUNCNAME[0]} $*" "$hook $*"
			exit $HOOK_RET
		done
	done
}
```

这是一套比较成熟的 RK 官方构建框架，不像个人从零自写的简单壳脚本。

### 3) 官方 `all` 是组合调用，不是自己重新实现

比如 `mk-all.sh`：

```7:41:/home/alientek/RK3568/rk356x-linux/device/rockchip/common/scripts/mk-all.sh
build_all()
{
	echo "=========================================="
	echo "          Start building all images"
	echo "=========================================="

	rm -rf "$RK_FIRMWARE_DIR" "$RK_SECURITY_FIRMWARE_DIR"
	mkdir -p "$RK_FIRMWARE_DIR" "$RK_SECURITY_FIRMWARE_DIR"

	if [ "$RK_RTOS" ]; then
		"$SCRIPTS_DIR/mk-loader.sh"
		"$SCRIPTS_DIR/mk-kernel.sh"
		"$SCRIPTS_DIR/mk-rtos.sh"
		"$SCRIPTS_DIR/mk-firmware.sh"
		finish_build
		return 0
	fi

	...
	"$SCRIPTS_DIR/mk-loader.sh"
	"$SCRIPTS_DIR/mk-firmware.sh"
	"$SCRIPTS_DIR/mk-updateimg.sh"
}
```

所以官方风格是：
- 顶层总控
- 模块分工
- 打包、loader、kernel、rootfs 各自独立

---

## 二、官方 SDK 的打包和烧录脚本特征

### 1) 固件打包逻辑非常典型 RK 风格

`mk-firmware.sh` 做的是：

- 链接 parameter
- 生成 misc
- 打包额外分区
- 输出 `rockdev`
- 校验镜像尺寸和分区大小

```95:115:/home/alientek/RK3568/rk356x-linux/device/rockchip/common/scripts/mk-firmware.sh
	rm -rf "$RK_ROCKDEV_DIR"
	ln -rsf "$FIRMWARE_DIR" "$RK_ROCKDEV_DIR"

	"$SCRIPTS_DIR/check-grow-align.sh"

	link_image "$CHIP_DIR/$RK_PARAMETER" "$RK_FIRMWARE_DIR/parameter.txt"
	pack_misc
```

这个思路很标准 Rockchip。

### 2) `update.img` 打包也是标准 RK 工具链

`mk-updateimg.sh` 直接调用：

- `afptool`
- `rkImageMaker`

```84:92:/home/alientek/RK3568/rk356x-linux/device/rockchip/common/scripts/mk-updateimg.sh
	TAG=RK$(hexdump -s 21 -n 4 -e '4 "%c"' MiniLoaderAll.bin | rev)
	"$RK_PACK_TOOL_DIR/afptool" -pack ./ update.raw.img
	"$RK_PACK_TOOL_DIR/rkImageMaker" -$TAG MiniLoaderAll.bin \
		update.raw.img update.img -os_type:androidos
```

这基本就是 RK 官方打包路径。

### 3) `rkflash.sh` 是很典型的 RK 脚本模板

你的当前 SDK 里这个脚本：

```1:27:/home/alientek/RK3568/rk356x-linux/device/rockchip/common/scripts/rkflash.sh
#!/bin/bash

COMMON_DIR=$(cd "$(dirname "$(realpath "$0")")/.."; pwd)
SDK_DIR=$(realpath $COMMON_DIR/../../..)
UPGRADETOOL=$SDK_DIR/tools/linux/Linux_Upgrade_Tool/Linux_Upgrade_Tool/upgrade_tool
ROCKDEV_DIR=$SDK_DIR/rockdev
LOADER=$ROCKDEV_DIR/MiniLoaderAll.bin
PARAMETER=$ROCKDEV_DIR/parameter.txt
UBOOT=$ROCKDEV_DIR/uboot.img
TRUST=$ROCKDEV_DIR/trust.img
BOOT=$ROCKDEV_DIR/boot.img
RECOVERY=$ROCKDEV_DIR/recovery.img
OEM=$ROCKDEV_DIR/oem.img
MISC=$ROCKDEV_DIR/misc.img
ROOTFS=$ROCKDEV_DIR/rootfs.img
USERDATA=$ROCKDEV_DIR/userdata.img
UPDATE=$ROCKDEV_DIR/update.img
```

后面一堆 `if [ $FLASH_TYPE = xxx ]` 的写法，非常像 Rockchip 生态里长期沿用的通用烧录模板。

---

## 三、社区 SDK 在构建/打包脚本上的变化

虽然我这次没有把社区 `project/build.sh` 全文完整拉下来，但已有信息足够判断其风格。

### 1) 顶层入口改成了 Luckfox 风格包装

社区仓库顶层 `build.sh` 只是一个软链接，直接指向：

- `./project/build.sh`

这说明 Luckfox 把官方那种 `device/rockchip/common/scripts/build.sh` 的位置和结构**改成了 project 内聚式入口**。

这属于明显的“重组织”而不是从零发明。

---

### 2) 社区脚本的用户界面改成了 `lunch` 菜单式

README 里暴露的命令体系是：

- `./build.sh lunch`
- `./build.sh uboot`
- `./build.sh kernel`
- `./build.sh rootfs`
- `./build.sh media`
- `./build.sh app`
- `./build.sh firmware`
- `./build.sh updateimg`

这套命令名字本身仍然是**Rockchip 官方语义集合**：
- uboot
- kernel
- rootfs
- firmware
- updateimg

只是前面多了一层：
- 板卡型号选择
- 存储介质选择
- 系统类型选择

这更像“官方命令体系上面套了一层 Luckfox 交互壳”。

---

### 3) 社区 `rkflash.sh` 和官方 `rkflash.sh` 高度同源

你给的社区 `project/rkflash.sh` 内容，和当前官方 SDK 的 `rkflash.sh` 对比，**几乎可以认为是同模板改出来的**。

#### 官方版开头：

```1:15:/home/alientek/RK3568/rk356x-linux/device/rockchip/common/scripts/rkflash.sh
#!/bin/bash

COMMON_DIR=$(cd "$(dirname "$(realpath "$0")")/.."; pwd)
SDK_DIR=$(realpath $COMMON_DIR/../../..)
UPGRADETOOL=$SDK_DIR/tools/linux/Linux_Upgrade_Tool/Linux_Upgrade_Tool/upgrade_tool
ROCKDEV_DIR=$SDK_DIR/rockdev
LOADER=$ROCKDEV_DIR/MiniLoaderAll.bin
PARAMETER=$ROCKDEV_DIR/parameter.txt
UBOOT=$ROCKDEV_DIR/uboot.img
TRUST=$ROCKDEV_DIR/trust.img
BOOT=$ROCKDEV_DIR/boot.img
```

#### 社区版开头：

```bash
#!/bin/bash

COMMON_DIR=$(cd "$(dirname "$(realpath "$0")")/.."; pwd)
SDK_DIR=$(realpath $COMMON_DIR)
UPGRADETOOL=$SDK_DIR/tools/linux/Linux_Upgrade_Tool/upgrade_tool
ROCKDEV_DIR=$SDK_DIR/output/image
LOADER=$ROCKDEV_DIR/download.bin
PARAMETER=$ROCKDEV_DIR/parameter.txt
UBOOT=$ROCKDEV_DIR/uboot.img
TRUST=$ROCKDEV_DIR/trust.img
BOOT=$ROCKDEV_DIR/boot.img
```

差异只有这些：

- 路径改了
  - 官方：`rockdev`
  - 社区：`output/image`
- loader 文件名改了
  - 官方：`MiniLoaderAll.bin`
  - 社区：`download.bin`
- `upgrade_tool` 路径层级略改
- 社区去掉了部分分区烧写命令

但**整体结构、变量名、分支判断、命令写法都是同一脉络**。

这已经不是“借鉴思路”，而是**直接沿官方脚本骨架改路径/改文件名/删减分支** 的级别。

---

### 4) 社区的恢复升级脚本是定制新增，但仍基于 RK OTA 机制

例如 `RkLunch-recovery.sh`：

- 自动扫描 SD 卡
- 寻找 `update_ota.tar`
- 解压后执行 `RK_OTA_update.sh`
- 失败时执行 `RK_OTA_erase_misc.sh`

这类脚本是 Luckfox 面向用户体验补出来的板卡级脚本，**这部分更像自写封装**。

但它依赖的 OTA 机制依然是 RK 体系：
- `misc`
- `update_ota.tar`
- `RK_OTA_update.sh`

所以它不是脱离官方生态的独立方案，而是**在 RK OTA 机制上写了一层设备恢复入口**。

---

### 5) 社区 `project/scripts/` 里的文件名也暴露了“半继承”特征

比如看到这些：

- `mk-fitimage.sh`
- `mk-tftp_sd_update.sh`
- `boot4recovery.its`
- `rv1106-boot-tb.its`
- `blank-misc.img`
- `recovery-misc.img`

这说明 Luckfox 并没有自己设计一套全新镜像打包格式，而是继续沿用 RK 固有体系：
- fitimage
- its
- misc
- update
- recovery

只是围绕 RV1106/Luckfox 板卡场景做了适配。

---

## 四、为什么我判断它不是“完全自研 sh”

核心依据有 5 条。

### 依据 1：命令词汇完全沿 RK 官方语义
社区还在用：
- uboot
- kernel
- rootfs
- firmware
- updateimg
- recovery

这不是巧合，说明底层构建概念完全承袭 RK 官方体系。

---

### 依据 2：打包工具链完全沿用 RK 原生工具
仍然是：
- `upgrade_tool`
- `afptool`
- `rkImageMaker`
- parameter.txt
- misc.img
- update.img

如果是完全自研，至少打包链路不会长得这么 RK 原汁原味。

---

### 依据 3：`rkflash.sh` 代码风格和变量布局高度同源
尤其是：
- `FLASH_TYPE`
- 一串 `if [ $FLASH_TYPE = xxx ]`
- `di -p` / `di -uboot` / `di -b` / `uf`
- 同名变量 `LOADER/PARAMETER/UBOOT/TRUST/BOOT/ROOTFS/USERDATA`

这已经接近“改模板”。

---

### 依据 4：社区增加的是“外壳交互层”，不是底层打包范式
Luckfox 真正改得多的是：
- lunch 菜单
- 板卡型号枚举
- WiFi 默认配置
- SD 卡恢复
- output/image 的成品路径组织

也就是**入口和板卡适配层**，而不是底层构建哲学。

---

### 依据 5：目录组织像“把官方多目录收拢再重命名”
例如：

- 官方 `kernel/`、`u-boot/`
- 社区放到 `sysdrv/source/kernel`、`sysdrv/source/uboot`

这是重构目录，不是从零设计构建系统。

---

## 五、那社区 SDK 到底“自研了什么”

如果更细分，可以这么看：

### A. 明显继承/借鉴 RK 官方的部分
1. 镜像打包模型
2. 分区和 parameter 体系
3. OTA/update.img 体系
4. upgrade_tool 烧录体系
5. 脚本命令命名习惯
6. 大部分构建阶段划分方式

### B. Luckfox 自己重写/定制较多的部分
1. `project/build.sh` 的用户交互入口
2. `lunch` 菜单和板卡选择逻辑
3. 面向 Luckfox 板卡的 BoardConfig 组织
4. SD 卡恢复升级脚本
5. WiFi、Pin 配置、板载外设默认策略
6. IPC/媒体/应用目录的重新组织

---

## 六、我的最终判断

### 用一句话概括
**社区 SDK 是“以 RK 官方 SDK 脚本体系为内核，外面套了 Luckfox 自己的项目结构和交互层”的方案。**

### 如果要给一个比例感受
我会主观估计：

- **底层构建/打包/烧录理念：70% 以上继承 RK 官方**
- **顶层入口、板卡菜单、用户体验脚本：Luckfox 自定义较多**

所以它更像：

> **“官方 1sh/多 mk 脚本体系的裁剪改造版”**
>
> 而不是
>
> **“从零自研的一套 shell build system”**

---

## 七、你如果要继续深挖，我建议下一步这样做

可以继续做两件事，我能帮你直接落地：

### 方案 1：精确找“社区 build.sh 与 RK 官方哪个版本最像”
做法：
- 拉社区 `project/build.sh` 全文
- 再对照一个 RV1106/RV1126 官方 Linux SDK 的 `build.sh`
- 按函数名、变量名、命令分发逐段比对

这样可以回答到：
- 它是基于哪个 RK 官方版本改的
- 改了多少
- 哪些函数基本原样搬运

### 方案 2：画一张两边脚本调用链图
例如：
- 当前 SDK：`build.sh -> hooks -> mk-all.sh -> mk-kernel/rootfs/firmware/updateimg`
- 社区 SDK：`build.sh -> lunch/config -> sysdrv/media/app -> output/image -> rkflash`

这样你以后移植社区功能到当前 SDK 会很方便。

如果你愿意，我下一步可以继续帮你做：
1. **把社区 `project/build.sh` 想办法完整抓出来**
2. **和你当前 SDK 的 `build.sh` 做逐函数对照表**  
这样就能把“缝了哪些官方脚本”说得更硬。

