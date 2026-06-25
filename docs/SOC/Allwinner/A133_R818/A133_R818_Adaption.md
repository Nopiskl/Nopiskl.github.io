# Configuration file difference analysis
_Exported on 2026/5/7 at GMT+8 16:17:46 from Cursor (2.6.21)_

---

**User**

tmp/config-4.9
tmp/sun50iw10p1smp_defconfig

分析一下这两份config的区别

---

**Cursor**

我会先读取这两个配置文件的概况，然后按内核 `CONFIG_` 项逐项对比，区分新增、删除和值变化。

接下来我会用脚本把两份 `.config/defconfig` 规范化解析，统计所有差异并提取关键类别。

我还会再按子系统做一次归类，避免只给原始 diff。

对比结论：这两份文件不是同一层级的配置文件。

- `tmp/config-4.9`：完整展开后的内核 `.config`，包含大量由 Kconfig 自动推导出来的默认项和依赖项，共解析到 **3258** 个 `CONFIG_` 项。
- `tmp/sun50iw10p1smp_defconfig`：精简版 `defconfig`，只保存显式选择/覆盖的关键项，共解析到 **391** 个 `CONFIG_` 项。

所以差异数量很大是正常的：

| 类型 | 数量 | 含义 |
|---|---:|---|
| 仅 `config-4.9` 存在 | 2924 | 大多数是 Kconfig 自动展开项、默认项、依赖项 |
| 仅 `sun50iw10p1smp_defconfig` 存在 | 57 | defconfig 里显式写了，但当前完整 `.config` 没有这些项 |
| 两边都有但值不同 | 69 | 真正需要重点关注的配置差异 |

重点看后两类，尤其是 **69 个值不同项**。

---

## 1. 最重要差异：PMIC 电源芯片配置不同

```text
CONFIG_AXP803_POWER: n -> y
```

`sun50iw10p1smp_defconfig` 启用了 `AXP803`，而 `config-4.9` 没启用。

同时在 `config-4.9` 里可以看到：

```text
CONFIG_AXP2202_POWER=y
CONFIG_AXP803_POWER=n
CONFIG_AXP2101_POWER=n
```

这说明当前完整配置更偏向 `AXP2202`，而 defconfig 显式打开的是 `AXP803`。

这对板级启动、电源管理、供电 rail、RTC、电池/充电、休眠唤醒都可能有影响。  
结合你最近看的文件里有：

- `axp2101-i2c.c`
- `axp20x-i2c.c`
- `BoardConfig.mk`
- `kickpi-k5c.dts`

我建议重点确认你的实际板子用的是哪个 PMIC：

- AXP803？
- AXP2101？
- AXP2202？

如果 DTS 里写的是一个 PMIC，而 defconfig 里启的是另一个，可能导致 PMIC probe 失败、电源域异常、关机/重启/RTC 异常。

---

## 2. WiFi / 蓝牙驱动编译方式不同

这些项在两边都有，但值不同：

```text
CONFIG_AIC8800_WLAN_SUPPORT: y -> m
CONFIG_AIC8800_BTLPM_SUPPORT: y -> m
CONFIG_XR829_WLAN: n -> m
CONFIG_XR_BT_LPM: y -> m
```

含义：

- `config-4.9`：AIC8800 WiFi/BT 低功耗驱动直接编进内核。
- `sun50iw10p1smp_defconfig`：AIC8800、XR829、XR BT LPM 倾向于编译成模块。

影响：

- 如果根文件系统早期就需要 WiFi/BT，内建 `y` 更稳。
- 如果通过 Android/Linux 用户空间加载模块，`m` 更灵活。
- 如果模块没有被正确安装到 rootfs，`m` 会导致设备不可用。

这类差异对无线功能很关键。

---

## 3. 蓝牙接口支持 defconfig 更完整

`sun50iw10p1smp_defconfig` 打开了这些，而 `config-4.9` 没打开：

```text
CONFIG_BT_HCIBTSDIO: n -> y
CONFIG_BT_HCIUART_3WIRE: n -> y
CONFIG_BT_HCIUART_LL: n -> y
```

说明 defconfig 支持更多蓝牙 HCI 接口：

- SDIO 蓝牙
- UART 3-wire
- TI LL 协议类 UART 蓝牙

如果你的蓝牙芯片走 UART 或 SDIO，这些项会影响蓝牙能否正常初始化。

---

## 4. USB 功能 defconfig 更丰富

值不同项：

```text
CONFIG_USB_OTG: n -> y
CONFIG_USB_SERIAL: n -> y
CONFIG_USB_CONFIGFS_RNDIS: n -> y
CONFIG_USB_CONFIGFS_F_ACC: n -> y
CONFIG_USB_CONFIGFS_F_MIDI: n -> y
```

仅 defconfig 有：

```text
CONFIG_USB_OTG_FSM=y
CONFIG_USB_USBNET=y
CONFIG_USB_RTL8152=y
CONFIG_USB_SERIAL_OPTION=y
CONFIG_USB_NET_RNDIS_HOST=m
CONFIG_USB_VIDEO_CLASS=y
```

说明 `sun50iw10p1smp_defconfig` 对 USB 外设/主机功能支持更多，包括：

- USB OTG
- USB Gadget RNDIS
- USB MIDI / Android accessory
- USB 转串口
- USB 网卡
- RTL8152 USB 网卡
- USB 摄像头 UVC

如果你的系统需要 USB 网卡、USB 摄像头、USB gadget 网络共享，defconfig 更合适。

---

## 5. 存储、块设备、Android dm-verity 差异明显

值不同项：

```text
CONFIG_BLK_DEV_LOOP: n -> y
CONFIG_BLK_DEV_RAM: n -> y
CONFIG_MD: n -> y
```

仅 defconfig 有：

```text
CONFIG_BLK_DEV_DM=y
CONFIG_DM_CRYPT=y
CONFIG_DM_VERITY=y
CONFIG_DM_VERITY_AVB=y
CONFIG_DM_VERITY_FEC=y
CONFIG_ZRAM=y
CONFIG_DM_UEVENT=y
CONFIG_DM_ANDROID_VERITY_AT_MOST_ONCE_DEFAULT_ENABLED=y
```

这说明 `sun50iw10p1smp_defconfig` 更偏 Android/嵌入式系统完整功能，支持：

- loop 设备
- ramdisk
- device mapper
- dm-crypt
- dm-verity
- AVB verified boot
- zram

如果你跑 Android 或带 verified boot 的系统，defconfig 里的这些配置更重要。  
如果你只是跑普通 Linux 根文件系统，`dm-verity/AVB` 可能不是必须。

---

## 6. 文件系统支持 defconfig 更强

值不同项：

```text
CONFIG_FUSE_FS: m -> y
CONFIG_CUSE: n -> y
CONFIG_F2FS_FS: n -> y
CONFIG_EXT4_ENCRYPTION: n -> y
CONFIG_EXT4_FS_SECURITY: n -> y
CONFIG_EXT2_FS_XATTR: n -> y
CONFIG_SDCARD_FS: n -> y
```

仅 defconfig 有：

```text
CONFIG_F2FS_FS_ENCRYPTION=y
CONFIG_F2FS_FS_SECURITY=y
CONFIG_EXT2_FS_POSIX_ACL=y
CONFIG_EXT2_FS_SECURITY=y
```

说明 defconfig 对 Android/Linux 常用文件系统功能更完整：

- FUSE
- CUSE
- F2FS
- EXT4 encryption
- EXT4 security label
- sdcardfs

如果你的 rootfs、userdata 或 Android 分区使用 F2FS/EXT4 加密，defconfig 更合适。

---

## 7. NFS / 网络文件系统 defconfig 打开更多

值不同项：

```text
CONFIG_NFS_FS: n -> y
CONFIG_NFSD: n -> y
```

仅 defconfig 有：

```text
CONFIG_NFS_V4=y
CONFIG_NFS_V4_1=y
CONFIG_NFS_V4_2=y
CONFIG_NFS_SWAP=y
CONFIG_NFSD_V4=y
CONFIG_NFSD_V3_ACL=y
CONFIG_SUNRPC_DEBUG=y
```

`sun50iw10p1smp_defconfig` 支持 NFS client 和 server。

如果你通过 NFS 挂载根文件系统、调试 rootfs、或者板子作为 NFS 服务端，defconfig 更方便。

---

## 8. 网络协议功能 defconfig 更多

值不同项：

```text
CONFIG_ANDROID_PARANOID_NETWORK: y -> n
CONFIG_L2TP: n -> y
CONFIG_PPP_FILTER: n -> y
CONFIG_SLIP: n -> y
CONFIG_NET_KEY: n -> y
CONFIG_NET_IPGRE_DEMUX: n -> y
CONFIG_UNIX_DIAG: n -> y
CONFIG_IP_FIB_TRIE_STATS: n -> y
```

仅 defconfig 有：

```text
CONFIG_PPPOL2TP=y
CONFIG_PPTP=y
```

说明 defconfig 支持更多 VPN/隧道/调试协议：

- L2TP
- PPTP
- PPP filter
- GRE
- UNIX socket diagnostic
- IP routing trie stats

不过它关闭了：

```text
CONFIG_ANDROID_PARANOID_NETWORK: y -> n
```

这可能影响 Android 网络权限模型。  
如果是 Android 系统，需要确认这项是否符合你的平台安全策略。

---

## 9. 调试和日志行为不同

值不同项：

```text
CONFIG_DYNAMIC_DEBUG: n -> y
CONFIG_KALLSYMS_ALL: n -> y
CONFIG_PROFILING: n -> y
CONFIG_FTRACE: y -> n
CONFIG_LOG_CPU_MAX_BUF_SHIFT: 12 -> 17
CONFIG_PSTORE_CONSOLE: n -> y
CONFIG_PSTORE_PMSG: n -> y
CONFIG_PSTORE_RAM: n -> y
CONFIG_SUNXI_DUMP: n -> y
```

这组比较有意思：

`sun50iw10p1smp_defconfig` 开启了：

- dynamic debug
- kallsyms all
- profiling
- pstore console
- pstore pmsg
- pstore ram
- sunxi dump
- 更大的 per-cpu log buffer

但它关闭了：

```text
CONFIG_FTRACE: y -> n
```

影响：

- defconfig 更适合崩溃日志保留、panic 后分析。
- `config-4.9` 保留了 ftrace，更适合运行时函数追踪。
- 如果你要分析 kernel panic、重启原因，defconfig 的 PSTORE/SUNXI_DUMP 更有价值。
- 如果你要做函数调用跟踪，`config-4.9` 的 FTRACE 更有价值。

---

## 10. 输入设备、红外、LED、触摸差异

值不同项：

```text
CONFIG_INPUT_GPIO: n -> y
CONFIG_INPUT_UINPUT: n -> y
CONFIG_LEDS_GPIO: n -> y
CONFIG_LEDS_TRIGGER_CPU: n -> y
CONFIG_LEDS_TRIGGER_DEFAULT_ON: n -> y
CONFIG_LEDS_TRIGGER_HEARTBEAT: n -> y
CONFIG_TOUCHSCREEN_GT9XX_TS: n -> y
CONFIG_KEYBOARD_ATKBD: y -> n
```

仅 defconfig 有：

```text
CONFIG_IR_SUNXI=y
CONFIG_IR_TX_SUNXI=y
CONFIG_SUNXI_MULTI_IR_SUPPORT=y
CONFIG_RC_DEVICES=y
```

说明 defconfig 更偏具体板级外设：

- GPIO 输入
- uinput
- GPIO LED
- LED heartbeat/default-on/cpu trigger
- GT9XX 触摸屏
- sunxi 红外收发

同时 defconfig 关闭了 AT 键盘：

```text
CONFIG_KEYBOARD_ATKBD: y -> n
```

这对嵌入式板子是合理的，因为通常不需要 PS/2 AT keyboard。

---

## 11. RTC / 关机闹钟差异

```text
CONFIG_RTC_DRV_HYM8563: n -> y
CONFIG_RTC_SHUTDOWN_ALARM: n -> y
```

`sun50iw10p1smp_defconfig` 打开了 HYM8563 RTC 和关机闹钟。

如果板子上有 HYM8563 RTC，这个是关键项。  
如果实际没有这个芯片，打开也不一定有害，但 DTS 如果启用对应节点，probe 失败会有日志。

---

## 12. TEE / OP-TEE 差异

值不同项：

```text
CONFIG_TEE: n -> y
```

仅 defconfig 有：

```text
CONFIG_OPTEE=y
```

说明 defconfig 支持 OP-TEE。

如果系统使用 secure world、keymaster、widevine、安全存储、AVB 相关安全链路，这项很重要。

---

## 13. 命名空间 / Android 统计项

值不同项：

```text
CONFIG_NAMESPACES: n -> y
```

仅 defconfig 有：

```text
CONFIG_UTS_NS=n
CONFIG_IPC_NS=n
CONFIG_PID_NS=n
CONFIG_UID_SYS_STATS=y
CONFIG_MEMORY_STATE_TIME=y
```

defconfig 打开 namespace 框架，但显式关闭部分 namespace 子功能。

这比较像 Android/嵌入式定制配置。  
`UID_SYS_STATS`、`MEMORY_STATE_TIME` 对 Android 电量/资源统计有用。

---

## 14. 音视频/媒体差异

值不同项：

```text
CONFIG_MEDIA_RC_SUPPORT: n -> y
CONFIG_MEDIA_USB_SUPPORT: n -> y
CONFIG_SND_SUNXI_SOC_SUNXI_SPDIF: n -> y
CONFIG_VIDEO_ENCODER_DECODER_SUNXI: y -> n
```

仅 defconfig 有：

```text
CONFIG_USB_VIDEO_CLASS=y
```

这里要特别注意：

`config-4.9` 开了：

```text
CONFIG_VIDEO_ENCODER_DECODER_SUNXI=y
```

但 `sun50iw10p1smp_defconfig` 里是：

```text
CONFIG_VIDEO_ENCODER_DECODER_SUNXI=n
```

如果你需要 Allwinner VPU/视频编解码，这个差异很关键。  
defconfig 虽然打开了 USB 摄像头 UVC，但关闭了 sunxi 视频编解码。

---

## 15. 其他关键变化

```text
CONFIG_DMA_SUNXI_SUPPORT_4G: n -> y
```

defconfig 打开了 sunxi DMA 4G 支持。  
对 64-bit ARM、较大内存、DMA 地址能力可能有影响。

```text
CONFIG_CPU_FREQ_DEFAULT_GOV_USERSPACE: n -> y
```

defconfig 默认 CPUFreq governor 是 userspace。  
这意味着 CPU 频率策略可能更依赖用户空间控制。

```text
CONFIG_THERMAL_DEFAULT_GOV_USER_SPACE: n -> y
CONFIG_THERMAL_GOV_POWER_ALLOCATOR: n -> y
```

defconfig 打开 thermal userspace governor 和 power allocator。  
对温控策略有影响。

```text
CONFIG_SUN4I_TIMER: y -> n
```

defconfig 关闭了 SUN4I timer。  
如果平台使用其他 timer，这可能没问题；但如果启动计时器异常，需要注意。

---

# 总体判断

## `config-4.9` 更像当前完整构建产物

它包含完整展开项，且有一些和当前平台/构建结果相关的配置，例如：

- `CONFIG_AXP2202_POWER=y`
- `CONFIG_VIDEO_ENCODER_DECODER_SUNXI=y`
- `CONFIG_FTRACE=y`
- AIC8800 内建

它更能代表“当前实际编译出来的内核配置”。

---

## `sun50iw10p1smp_defconfig` 更像板级/产品 defconfig

它显式打开了很多产品功能：

- AXP803 PMIC
- F2FS / EXT4 encryption
- dm-verity / AVB
- OP-TEE
- USB OTG / USB 网卡 / USB 摄像头
- NFS/NFSD
- GT9XX 触摸
- HYM8563 RTC
- GPIO LED
- sunxi 红外
- PSTORE / SUNXI_DUMP

它更像面向 Android/产品化板子的 defconfig。

---

# 我建议重点核查的配置

如果你现在是在调 A133 KICKPI K5C 板子，我建议优先确认这些：

1. **PMIC 是否匹配实际硬件**

```text
CONFIG_AXP803_POWER
CONFIG_AXP2101_POWER
CONFIG_AXP2202_POWER
```

这是最高优先级。

2. **WiFi/BT 驱动是内建还是模块**

```text
CONFIG_AIC8800_WLAN_SUPPORT
CONFIG_AIC8800_BTLPM_SUPPORT
CONFIG_XR829_WLAN
CONFIG_XR_BT_LPM
```

要和 rootfs 里的模块安装、启动脚本匹配。

3. **视频编解码是否需要**

```text
CONFIG_VIDEO_ENCODER_DECODER_SUNXI
```

如果需要硬件编解码，defconfig 当前是关闭的。

4. **触摸屏/RTC/红外是否实际存在**

```text
CONFIG_TOUCHSCREEN_GT9XX_TS
CONFIG_RTC_DRV_HYM8563
CONFIG_IR_SUNXI
CONFIG_IR_TX_SUNXI
```

5. **Android 功能是否需要**

```text
CONFIG_DM_VERITY
CONFIG_DM_VERITY_AVB
CONFIG_OPTEE
CONFIG_SDCARD_FS
CONFIG_UID_SYS_STATS
CONFIG_MEMORY_STATE_TIME
CONFIG_ANDROID_PARANOID_NETWORK
```

6. **调试方式取舍**

```text
CONFIG_FTRACE
CONFIG_PSTORE_RAM
CONFIG_SUNXI_DUMP
CONFIG_DYNAMIC_DEBUG
```

---

# 简短结论

`tmp/config-4.9` 是完整展开后的实际内核配置；`tmp/sun50iw10p1smp_defconfig` 是精简 defconfig。  
真正有价值的差异主要是 **69 个同名项值不同** 和 **57 个 defconfig 独有项**。

最需要关注的是：

- PMIC 从 `AXP2202/非 AXP803` 倾向变成 `AXP803`
- WiFi/BT 从内建变成模块
- defconfig 增强了 USB、F2FS、dm-verity、OP-TEE、NFS、RTC、触摸、红外、PSTORE
- defconfig 关闭了 `FTRACE`
- defconfig 关闭了 `VIDEO_ENCODER_DECODER_SUNXI`

如果你的目标是“让当前编译结果回写成最小 defconfig”，应以 `config-4.9` 为输入执行类似：

```bash
make ARCH=arm64 savedefconfig
```

然后再人工合并板级必须项。

---

**User**

如果我想把tmp/sun50iw10p1smp_defconfig这个设备移植到用tmp/config-4.9环境的SDK上，给我一份最小的修改指南，尽量保留tmp/config-4.9原有的一些配置，能不改就不改

---

**Cursor**

我会再核对一下板级配置、DTS 和两份 config 里的关键硬件项，保证指南尽量只改“移植必需项”。

刚才的关键词匹配结果不够清晰，我再用更直接的方式提取两份配置里的移植候选项和 DTS 里的硬件线索。

我再读取几段 DTS 关键区域，方便把“为什么这些项是必改/可选”对应到实际硬件节点。

下面给你一份“最小修改指南”：目标是 **把 `tmp/sun50iw10p1smp_defconfig` 对应的设备/板级能力移植到当前 `tmp/config-4.9` 环境的 SDK 上**，原则是：

> **以 `tmp/config-4.9` 为基线，不整体替换 defconfig；只补齐该板 DTS 已经启用、但当前 kernel config 缺失的硬件驱动和必要系统能力。**

---

# 一、不要直接用 `tmp/sun50iw10p1smp_defconfig` 覆盖

不建议直接把 `tmp/sun50iw10p1smp_defconfig` 替换到当前 SDK，因为它会改变很多当前环境已有配置，例如：

```text
CONFIG_AIC8800_WLAN_SUPPORT: y -> m
CONFIG_AIC8800_BTLPM_SUPPORT: y -> m
CONFIG_XR_BT_LPM: y -> m
CONFIG_VIDEO_ENCODER_DECODER_SUNXI: y -> n
CONFIG_FTRACE: y -> n
```

这些不是“设备移植必需项”，而是原 SDK 和目标 defconfig 的策略差异。

尤其这两个建议保持 `config-4.9` 原样：

```text
CONFIG_VIDEO_ENCODER_DECODER_SUNXI=y
CONFIG_FTRACE=y
```

因为：

- `tmp/config-4.9` 已启用 sunxi 视频编解码，目标 defconfig 反而关闭了。
- `tmp/config-4.9` 已启用 `FTRACE`，目标 defconfig 反而关闭了。
- 这类改动容易引入功能倒退，不属于最小移植。

---

# 二、最小移植优先级

我建议分三档处理。

## A 档：强烈建议必须补齐

这些和 `kickpi-k5c.dts` 里已启用硬件直接对应，建议优先加入当前 SDK 的 kernel config。

### 1. AXP803 PMIC

DTS 明确使用 AXP803：

```384:390:/home/alientek/A133/KICKPI_A133/a133-linux/device/config/chips/a133/configs/c3/kickpi-k5c.dts
			pmu0: pmu@34 {
				compatible = "x-powers,axp803";
				reg = <0x34>;
				status = "okay";
				interrupts = <0 IRQ_TYPE_LEVEL_LOW>;
				interrupt-parent = <&nmi_intc>;
				x-powers,drive-vbus-en;
```

当前 `config-4.9` 是：

```text
# CONFIG_AXP803_POWER is not set
CONFIG_AXP2202_POWER=y
```

目标板 DTS 是 `x-powers,axp803`，所以最小必须补：

```text
CONFIG_AXP803_POWER=y
```

是否要关掉 `CONFIG_AXP2202_POWER`？

**最小原则下不建议先关。**

保留：

```text
CONFIG_AXP2202_POWER=y
```

理由：

- 只要 DTS 没有 `axp2202` 节点，驱动通常不会 probe。
- 关闭它可能影响当前 SDK 其他板型或默认环境。
- 先补 `AXP803`，不删原有 PMIC，是最小风险策略。

---

### 2. HYM8563 RTC

DTS 明确有 HYM8563：

```366:372:/home/alientek/A133/KICKPI_A133/a133-linux/device/config/chips/a133/configs/c3/kickpi-k5c.dts
			pcf8563@51 {
					compatible = "haoyu,hym8563";
					reg = <0x51>;
					interrupt-parent = <&pio>;
					interrupts = <PB 8 IRQ_TYPE_LEVEL_LOW>;
					status = "okay";
```

当前 `config-4.9` 未启用，目标 defconfig 启用了：

```text
CONFIG_RTC_DRV_HYM8563=y
CONFIG_RTC_SHUTDOWN_ALARM=y
```

建议补：

```text
CONFIG_RTC_DRV_HYM8563=y
CONFIG_RTC_SHUTDOWN_ALARM=y
```

其中 `RTC_SHUTDOWN_ALARM` 如果你不需要关机闹钟，可不加；但目标 DTS 里有 `wakeup-source`，建议一起加。

---

### 3. WiFi / BT 板级控制

DTS 里启用了 Allwinner WiFi/BT/btlpm 节点：

```1225:1255:/home/alientek/A133/KICKPI_A133/a133-linux/device/config/chips/a133/configs/c3/kickpi-k5c.dts
                wlan: wlan@0 {
                        compatible    = "allwinner,sunxi-wlan";
                        clocks;
                        pinctrl-0;
                        pinctrl-names;
                        wlan_busnum   = <0x1>;
                        wlan_power    = "axp803-dldo1";
                        wlan_io_regulator;
                        wlan_regon    = <&pio PG 10 1 0xffffffff 0xffffffff 1>;
                        wlan_hostwake = <&pio PG 13 6 0xffffffff 0xffffffff 0>;
                        //chip_en;
                        //power_en      = <&pio PG 10 1 0xffffffff 0xffffffff 0>;
                        status        = "okay";
                };

                bt: bt@0 {
                        compatible    = "allwinner,sunxi-bt";
			clocks        = <&clk_losc_out>, <&clk_dcxo_out>;
                        bt_power      = "axp803-dldo1";
                        bt_io_regulator;
                        bt_rst_n      = <&r_pio PH 11 1 0xffffffff 0xffffffff 0>;
                        status        = "okay";
                };

                btlpm: btlpm@0 {
                        compatible  = "allwinner,sunxi-btlpm";
```

当前 `config-4.9` 已经有：

```text
CONFIG_AIC8800_WLAN_SUPPORT=y
CONFIG_AIC8800_BTLPM_SUPPORT=y
CONFIG_XR_BT_LPM=y
```

目标 defconfig 是模块：

```text
CONFIG_AIC8800_WLAN_SUPPORT=m
CONFIG_AIC8800_BTLPM_SUPPORT=m
CONFIG_XR_BT_LPM=m
CONFIG_XR829_WLAN=m
```

最小原则建议：

**不要把已有的 `y` 改成 `m`。**

保留当前：

```text
CONFIG_AIC8800_WLAN_SUPPORT=y
CONFIG_AIC8800_BTLPM_SUPPORT=y
CONFIG_XR_BT_LPM=y
```

只额外考虑补：

```text
CONFIG_CFG80211_WEXT=y
CONFIG_BT_HCIBTSDIO=y
CONFIG_BT_HCIUART_3WIRE=y
CONFIG_BT_HCIUART_LL=y
```

如果你的实际 WiFi 是 XR829，再补：

```text
CONFIG_XR829_WLAN=m
```

但如果板子实际是 AIC8800，就不要为了和 defconfig 一致而打开 XR829。

最小建议：

```text
CONFIG_CFG80211_WEXT=y
CONFIG_BT_HCIBTSDIO=y
CONFIG_BT_HCIUART_3WIRE=y
CONFIG_BT_HCIUART_LL=y
```

可选：

```text
CONFIG_XR829_WLAN=m
```

---

### 4. GPIO LED

DTS 明确有 `gpio-leds`：

```1337:1351:/home/alientek/A133/KICKPI_A133/a133-linux/device/config/chips/a133/configs/c3/kickpi-k5c.dts
	leds {
			compatible = "gpio-leds";
			pinctrl-names = "default";
			status = "okay";

			sysled {
				label = "sysled";
				gpios = <&r_pio PL 10 1 0 1 1>;
				linux,default_trigger = "heartbeat";
			};

            spk_en {
                label = "spk_en";
```

当前 `config-4.9` 没启用 GPIO LED，目标 defconfig 启用了。

建议补：

```text
CONFIG_LEDS_GPIO=y
CONFIG_LEDS_TRIGGER_HEARTBEAT=y
CONFIG_LEDS_TRIGGER_DEFAULT_ON=y
```

如果你想保留 CPU trigger，也可补：

```text
CONFIG_LEDS_TRIGGER_CPU=y
```

---

### 5. 红外接收

DTS 明确启用了 `s_cir0`：

```1422:1439:/home/alientek/A133/KICKPI_A133/a133-linux/device/config/chips/a133/configs/c3/kickpi-k5c.dts
&s_cir0 {
	status = "okay";

	pinctrl-names = "default", "sleep";
	pinctrl-0 = <&s_cir0_pins_a>;
	pinctrl-1 = <&s_cir0_pins_a>;

	s_cir0_used = <1>;
	ir_power_key_code0 = <0x4d>;
	ir_addr_code0 = <0x4040>;
	ir_power_key_code1 = <0x51>;
```

目标 defconfig 有：

```text
CONFIG_IR_SUNXI=y
CONFIG_IR_TX_SUNXI=y
CONFIG_SUNXI_MULTI_IR_SUPPORT=y
CONFIG_MEDIA_RC_SUPPORT=y
```

最小建议补：

```text
CONFIG_MEDIA_RC_SUPPORT=y
CONFIG_IR_SUNXI=y
CONFIG_SUNXI_MULTI_IR_SUPPORT=y
```

`CONFIG_IR_TX_SUNXI=y` 是红外发射，如果板子只需要接收，可以先不加。  
如果硬件有红外发射，再加：

```text
CONFIG_IR_TX_SUNXI=y
```

---

### 6. USB gadget / RNDIS

DTS 的 `usbc0` 是 device 模式：

```893:907:/home/alientek/A133/KICKPI_A133/a133-linux/device/config/chips/a133/configs/c3/kickpi-k5c.dts
		usbc0:usbc0@0 {
			device_type = "usbc0";
			usb_port_type = <0x0>;
			usb_detect_type = <0x1>;
			usb_id_gpio = <&r_pio PL 9 0 0 0xffffffff 0xffffffff>;
			usb_det_vbus_gpio   = "axp_ctrl";
			usb_regulator_io = "nocare";
			det_vbus_supply = <&usb_power_supply>;
			usb_wakeup_suspend = <1>;
			usb_serial_unique = <0>;
			usb_serial_number = "20080411";
			rndis_wceis = <1>;
			status = "okay";
```

当前 `config-4.9` 没开：

```text
# CONFIG_USB_OTG is not set
# CONFIG_USB_CONFIGFS_RNDIS is not set
```

目标 defconfig 有：

```text
CONFIG_USB_OTG=y
CONFIG_USB_OTG_FSM=y
CONFIG_USB_CONFIGFS_RNDIS=y
```

最小建议补：

```text
CONFIG_USB_OTG=y
CONFIG_USB_CONFIGFS_RNDIS=y
```

如果 Kconfig 自动引出 `CONFIG_USB_OTG_FSM=y`，让它自动处理即可；不一定手工写。

另外 USB 串口/USB 网卡/USB 摄像头是外设需求，不属于板子必需启动项，放到 B 档。

---

## B 档：按实际产品需求补

这些不是板子点亮必需，但目标 defconfig 打开了，且常见于产品功能。

### 1. F2FS / EXT4 加密 / sdcardfs

如果你的系统是 Android，或者 userdata 使用 F2FS/加密，建议补：

```text
CONFIG_F2FS_FS=y
CONFIG_F2FS_FS_ENCRYPTION=y
CONFIG_F2FS_FS_SECURITY=y
CONFIG_EXT4_ENCRYPTION=y
CONFIG_EXT4_FS_SECURITY=y
CONFIG_SDCARD_FS=y
```

如果你只是普通 Linux rootfs，先不加也可以。

---

### 2. OP-TEE / TEE

目标 defconfig 有：

```text
CONFIG_TEE=y
CONFIG_OPTEE=y
```

如果你的启动链、Android keymaster、安全存储、AVB 或 TrustZone 功能依赖 OP-TEE，补：

```text
CONFIG_TEE=y
CONFIG_OPTEE=y
```

如果只是普通 Linux，先不加。

---

### 3. dm-verity / AVB / zram

Android 常用：

```text
CONFIG_BLK_DEV_DM=y
CONFIG_DM_CRYPT=y
CONFIG_DM_VERITY=y
CONFIG_DM_VERITY_AVB=y
CONFIG_DM_VERITY_FEC=y
CONFIG_ZRAM=y
```

如果你跑 Android 并启用 verified boot，建议补。  
如果普通 Linux，不建议先加，避免扩大变量。

---

### 4. USB 外设支持

如果需要 USB 转串口、4G 模块、USB 网卡、USB 摄像头，补：

```text
CONFIG_USB_SERIAL=y
CONFIG_USB_SERIAL_OPTION=y
CONFIG_USB_USBNET=y
CONFIG_USB_RTL8152=y
CONFIG_USB_VIDEO_CLASS=y
CONFIG_MEDIA_USB_SUPPORT=y
```

如果不需要这些外设，先不动。

---

### 5. 输入子系统辅助项

如果 Android 需要 uinput，或者用户空间需要虚拟输入设备：

```text
CONFIG_INPUT_UINPUT=y
```

如果需要 GPIO 按键/输入：

```text
CONFIG_INPUT_GPIO=y
```

---

### 6. PSTORE / 崩溃日志

如果你想保留 panic/reboot 日志，补：

```text
CONFIG_PSTORE_RAM=y
CONFIG_PSTORE_CONSOLE=y
CONFIG_PSTORE_PMSG=y
CONFIG_SUNXI_DUMP=y
```

这对量产调试很有用，但不属于点亮必需项。

---

### 7. NFS 调试

如果你需要 NFS rootfs 或板子作为 NFS 服务：

```text
CONFIG_NFS_FS=y
CONFIG_NFSD=y
```

普通产品系统可不加。

---

### 8. SPDIF

DTS 里 SPDIF 是 disabled：

```988:993:/home/alientek/A133/KICKPI_A133/a133-linux/device/config/chips/a133/configs/c3/kickpi-k5c.dts
		spdif:spdif-controller@0x05094000{
			status = "disabled";
		};

		sndspdif:sound@1{
			status = "disabled";
```

所以 `CONFIG_SND_SUNXI_SOC_SUNXI_SPDIF=y` 不是最小必需项。  
除非你后面打开 DTS 的 SPDIF，否则先不加。

---

## C 档：建议明确不要改

这些目标 defconfig 和当前 config 不一致，但建议保留当前 `tmp/config-4.9` 原样。

### 1. 不要把 AIC8800 从内建改模块

当前：

```text
CONFIG_AIC8800_WLAN_SUPPORT=y
CONFIG_AIC8800_BTLPM_SUPPORT=y
```

目标：

```text
CONFIG_AIC8800_WLAN_SUPPORT=m
CONFIG_AIC8800_BTLPM_SUPPORT=m
```

建议保留 `y`。  
这样可以避免 rootfs 里模块缺失导致 WiFi/BT 不工作。

---

### 2. 不要关闭 sunxi 视频编解码

当前：

```text
CONFIG_VIDEO_ENCODER_DECODER_SUNXI=y
```

目标：

```text
# CONFIG_VIDEO_ENCODER_DECODER_SUNXI is not set
```

建议保留 `y`。  
除非你明确不需要 VPU/VE。

---

### 3. 不要关闭 FTRACE

当前：

```text
CONFIG_FTRACE=y
```

目标：

```text
# CONFIG_FTRACE is not set
```

建议保留 `y`。  
移植阶段保留 ftrace 更方便排查问题。

---

### 4. 不建议改 CPUFreq / Thermal 默认策略

目标 defconfig 有：

```text
CONFIG_CPU_FREQ_DEFAULT_GOV_USERSPACE=y
CONFIG_THERMAL_DEFAULT_GOV_USER_SPACE=y
CONFIG_THERMAL_GOV_POWER_ALLOCATOR=y
```

当前没有。  
这属于策略项，不是硬件点亮必需。  
最小移植先不改。

---

# 三、推荐的最小补丁配置

如果只做最小硬件适配，我建议你先补这一组：

```text
CONFIG_AXP803_POWER=y

CONFIG_RTC_DRV_HYM8563=y
CONFIG_RTC_SHUTDOWN_ALARM=y

CONFIG_CFG80211_WEXT=y
CONFIG_BT_HCIBTSDIO=y
CONFIG_BT_HCIUART_3WIRE=y
CONFIG_BT_HCIUART_LL=y

CONFIG_LEDS_GPIO=y
CONFIG_LEDS_TRIGGER_HEARTBEAT=y
CONFIG_LEDS_TRIGGER_DEFAULT_ON=y

CONFIG_MEDIA_RC_SUPPORT=y
CONFIG_IR_SUNXI=y
CONFIG_SUNXI_MULTI_IR_SUPPORT=y

CONFIG_USB_OTG=y
CONFIG_USB_CONFIGFS_RNDIS=y
```

如果你确认需要红外发射，再加：

```text
CONFIG_IR_TX_SUNXI=y
```

如果你确认 WiFi 是 XR829，再加：

```text
CONFIG_XR829_WLAN=m
```

如果你确认是 Android 系统，建议再加：

```text
CONFIG_F2FS_FS=y
CONFIG_F2FS_FS_ENCRYPTION=y
CONFIG_F2FS_FS_SECURITY=y
CONFIG_EXT4_ENCRYPTION=y
CONFIG_EXT4_FS_SECURITY=y
CONFIG_SDCARD_FS=y

CONFIG_TEE=y
CONFIG_OPTEE=y

CONFIG_BLK_DEV_DM=y
CONFIG_DM_CRYPT=y
CONFIG_DM_VERITY=y
CONFIG_DM_VERITY_AVB=y
CONFIG_DM_VERITY_FEC=y
CONFIG_ZRAM=y

CONFIG_INPUT_UINPUT=y
CONFIG_UID_SYS_STATS=y
CONFIG_MEMORY_STATE_TIME=y
```

---

# 四、实际操作步骤

## 步骤 1：不要直接编辑 `tmp/config-4.9`

`tmp/config-4.9` 更像构建产生的完整 `.config` 临时文件。  
你应该改 SDK 实际使用的 defconfig。

从 `BoardConfig.mk` 看，当前 SDK 使用的是：

```1:5:/home/alientek/A133/KICKPI_A133/a133-linux/device/config/chips/a133/configs/default/BoardConfig.mk
LICHEE_CHIP:=sun50iw10p1
LICHEE_ARCH:=arm64
LICHEE_BRANDY_VER:=2.0
LICHEE_BRANDY_DEFCONF:=sun50iw10p1_defconfig
LICHEE_KERN_VER:=4.9
```

以及：

```6:6:/home/alientek/A133/KICKPI_A133/a133-linux/device/config/chips/a133/configs/default/BoardConfig.mk
LICHEE_KERN_DEFCONF:=sun50iw10p1smp_defconfig
```

所以应该改：

```text
kernel/linux-4.9/arch/arm64/configs/sun50iw10p1smp_defconfig
```

或者基于当前 SDK 的 defconfig 新建一个板级 defconfig，例如：

```text
sun50iw10p1_kickpi_k5c_defconfig
```

然后在 `BoardConfig.mk` 中改：

```make
LICHEE_KERN_DEFCONF:=sun50iw10p1_kickpi_k5c_defconfig
```

但如果你要最小变更，直接改现有 `sun50iw10p1smp_defconfig` 即可。

---

## 步骤 2：以 `config-4.9` 生成当前环境 defconfig 基线

在 kernel 目录下，建议先把当前 `.config` 变成最小 defconfig：

```bash
cd kernel/linux-4.9
cp ../../tmp/config-4.9 .config
make ARCH=arm64 olddefconfig
make ARCH=arm64 savedefconfig
cp defconfig arch/arm64/configs/sun50iw10p1smp_defconfig
```

这样得到的是 **当前 `config-4.9` 环境的最小 defconfig**。

然后再往这个 defconfig 里补上上面 A 档配置。

---

## 步骤 3：用 menuconfig 或 scripts/config 添加配置

推荐用 `menuconfig`：

```bash
cd kernel/linux-4.9
make ARCH=arm64 sun50iw10p1smp_defconfig
make ARCH=arm64 menuconfig
```

手动打开 A 档配置后：

```bash
make ARCH=arm64 savedefconfig
cp defconfig arch/arm64/configs/sun50iw10p1smp_defconfig
```

如果内核支持 `scripts/config`，也可以类似：

```bash
cd kernel/linux-4.9
cp ../../tmp/config-4.9 .config

scripts/config --enable AXP803_POWER
scripts/config --enable RTC_DRV_HYM8563
scripts/config --enable RTC_SHUTDOWN_ALARM
scripts/config --enable CFG80211_WEXT
scripts/config --enable BT_HCIBTSDIO
scripts/config --enable BT_HCIUART_3WIRE
scripts/config --enable BT_HCIUART_LL
scripts/config --enable LEDS_GPIO
scripts/config --enable LEDS_TRIGGER_HEARTBEAT
scripts/config --enable LEDS_TRIGGER_DEFAULT_ON
scripts/config --enable MEDIA_RC_SUPPORT
scripts/config --enable IR_SUNXI
scripts/config --enable SUNXI_MULTI_IR_SUPPORT
scripts/config --enable USB_OTG
scripts/config --enable USB_CONFIGFS_RNDIS

make ARCH=arm64 olddefconfig
make ARCH=arm64 savedefconfig
cp defconfig arch/arm64/configs/sun50iw10p1smp_defconfig
```

注意：不同 SDK 的 `scripts/config` 对依赖处理不完全一样，最终还是要跑：

```bash
make ARCH=arm64 olddefconfig
```

让 Kconfig 自动补齐依赖。

---

# 五、移植验证顺序

建议按这个顺序验证，不要一次性把所有 B 档配置都打开。

## 1. 编译验证

```bash
make ARCH=arm64 sun50iw10p1smp_defconfig
make ARCH=arm64 olddefconfig
make ARCH=arm64 -j$(nproc)
```

如果报 Kconfig 依赖错误，优先查新增项的依赖。

---

## 2. 启动日志验证 PMIC

重点看：

```bash
dmesg | grep -i -E "axp|pmu|regulator"
```

期望看到 AXP803 probe 成功。

如果还是看不到 AXP803，重点检查：

- DTS 是否确实使用 `kickpi-k5c.dts`
- I2C/TWI6 是否启用
- `CONFIG_AXP803_POWER=y` 是否进了最终 `.config`
- PMIC 驱动 compatible 是否匹配 `"x-powers,axp803"`

---

## 3. RTC 验证

```bash
dmesg | grep -i -E "rtc|hym|pcf8563"
ls /dev/rtc*
```

期望 HYM8563 注册成功。

---

## 4. WiFi / BT 验证

```bash
dmesg | grep -i -E "wlan|wifi|aic|xr829|bt|bluetooth|btlpm"
```

如果 AIC8800 是内建，确认固件路径和 rootfs 里的 firmware 是否匹配。  
如果你改成模块，还要确认模块是否被安装到 rootfs。

---

## 5. LED 验证

```bash
ls /sys/class/leds/
cat /sys/class/leds/sysled/trigger
```

至少应该看到 DTS 里定义的 `sysled`。

---

## 6. 红外验证

```bash
dmesg | grep -i -E "ir|cir|rc"
ls /dev/input/
```

---

## 7. USB gadget / RNDIS 验证

```bash
dmesg | grep -i -E "usb|udc|gadget|rndis"
ls /sys/class/udc/
```

---

# 六、推荐最终策略

你的目标是“尽量保留 `tmp/config-4.9` 原配置”，所以建议：

## 第一轮只做 A 档

```text
CONFIG_AXP803_POWER=y
CONFIG_RTC_DRV_HYM8563=y
CONFIG_RTC_SHUTDOWN_ALARM=y
CONFIG_CFG80211_WEXT=y
CONFIG_BT_HCIBTSDIO=y
CONFIG_BT_HCIUART_3WIRE=y
CONFIG_BT_HCIUART_LL=y
CONFIG_LEDS_GPIO=y
CONFIG_LEDS_TRIGGER_HEARTBEAT=y
CONFIG_LEDS_TRIGGER_DEFAULT_ON=y
CONFIG_MEDIA_RC_SUPPORT=y
CONFIG_IR_SUNXI=y
CONFIG_SUNXI_MULTI_IR_SUPPORT=y
CONFIG_USB_OTG=y
CONFIG_USB_CONFIGFS_RNDIS=y
```

## 明确不动

```text
CONFIG_AIC8800_WLAN_SUPPORT=y
CONFIG_AIC8800_BTLPM_SUPPORT=y
CONFIG_XR_BT_LPM=y
CONFIG_VIDEO_ENCODER_DECODER_SUNXI=y
CONFIG_FTRACE=y
CONFIG_AXP2202_POWER=y
```

## 按需再补 B 档

Android/AVB/F2FS/OPTEE/USB外设/NFS/PSTORE 这些功能等第一轮板子能正常启动后再逐项打开。

这样做风险最低，最符合“能不改就不改”的原则。

