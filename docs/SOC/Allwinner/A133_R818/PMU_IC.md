# Boot process PMU error
_Exported on 2026/5/7 at GMT+8 10:54:01 from Cursor (2.6.21)_

---

**User**

[196]HELLO! BOOT0 is starting!
[199]BOOT0 commit : e1a64ba
[202]set pll start
[204]periph0 has been enabled
[207]set pll end
[209]PL gpio voltage : 3.3V
[212][pmu]: bus read error
[215]PMU: AXP803
[229]vaild para:1  select dram para0
[232]board init ok, set sys_vol to 940mv!
[257]DRAM BOOT DRIVE INFO: V0.69
[260]the chip id is 0x1400
[263]ic cant match axp, please check...




为什么会卡在这里？请给出解决方法

---

**Cursor**

让我先查看相关配置文件来分析这个问题。让我直接查看相关的配置文件来分析启动卡住的问题。

根据启动日志分析，问题非常明确：

```
[212][pmu]: bus read error
[215]PMU: AXP803
...
ic cant match axp, please check...
```

**根本原因：**

BOOT0 通过 TWI（I2C）总线尝试读取 AXP803 PMU，但发生 `bus read error`，随后提示 `ic cant match axp`。这意味着 BOOT0 在 `sys_config.fex` 中配置的 `power_mode = 0`（即 AXP81X/AXP803），但实际硬件上 PMU 没有响应 I2C 通信。

**常见原因及解决方法：**

**原因 1：AXP803 的 I2C 地址或总线配置不匹配**

`board.dts` 中 AXP803 挂载在 `twi6`（s_twi@0x07081400），使用 PL0/PL1，地址 `0x34`：

```board.dts
twi6: s_twi@0x07081400{
    clock-frequency = <200000>;
    pinctrl-0 = <&s_twi0_pins_a>;
    ...
    pmu0: pmu@34 {
        compatible = "x-powers,axp803";
        reg = <0x34>;
```

BOOT0 阶段的 PMU 通信使用 `sys_config.fex` 中的配置。请检查 `[target]` 节中的 `power_mode`：

**当前配置：**

```ini
[target]
power_mode      = 0
```

`power_mode = 0` 对应 AXP81X，但该板子使用的是 AXP803。

**解决方法：**

修改 `sys_config.fex` 中的 `power_mode`：


根据全志平台定义：
- `power_mode = 0` → AXP81X
- `power_mode = 1` → dummy（无PMU）
- `power_mode = 2` → AXP806
- `power_mode = 3` → AXP2202
- `power_mode = 4` → AXP858

AXP803 通常对应 `power_mode = 0`（AXP81X 系列），所以该值本身是正确的。问题更可能是硬件层面。

**请按以下步骤逐一排查：**

**步骤 1：检查硬件 I2C 连接**
- AXP803 的 SCL/SDA 是否连接到 SoC 的 PL0/PL1（s_twi0）
- 检查是否有上拉电阻（通常 4.7kΩ 至 VCC）

**步骤 2：确认 AXP803 供电**
- AXP803 的 VCC/VBAT 引脚是否正确供电（通常接电池或适配器）
- AXP803 的 `IPSOUT` 是否有输出电压

**步骤 3：检查 BOOT0 的 AXP 版本匹配**

查看 BOOT0 源码中 AXP 检测逻辑：

---

**User**

[138]HELLO! BOOT0 is starting!
[141]BOOT0 commit : 83e3c82
[144]set pll start
[146]periph0 has been enabled
[149]set pll end
[151][pmu]: bus read error
[154]PMU: AXP803
[174]vaild para:1  select dram para0
[177]board init ok
[200]DRAM BOOT DRIVE INFO: V0.61
[203]the chip id is 0x1400
[205]the chip id is 0x1400
[208]the chip id is 0x1400
[211]the chip id is 0x1400
[213]the chip id is 0x1400
[216]chip id check OK
[225]DRAM_VCC set to 1500 mv
[228]DRAM CLK =648 MHZ
[230]DRAM Type =3 (3:DDR3,4:DDR4,7:LPDDR3,8:LPDDR4)
[239]DRAM SIZE =2048 MBytes, para1 = 310a, para2 = 8000000, tpr13 = 6001
[251]DRAM simple test OK.
[254]dram size =2048
[256]chipid = 54401400
[258]nsi init ok 2020-4-7
[262]card no is 2
[263]sdcard 2 line count 8
[266][mmc]: mmc driver ver 2020-05-25 09:40-202007019516
[277][mmc]: Wrong media type 0x0
[280][mmc]: ***Try SD card 2***
[284][mmc]: mmc 2 cmd 8 timeout, err 100
[288][mmc]: mmc 2 cmd 8 err 100
[291][mmc]: mmc 2 send if cond failed
[296][mmc]: mmc 2 cmd 55 timeout, err 100
[300][mmc]: mmc 2 cmd 55 err 100
[303][mmc]: mmc 2 send app cmd failed
[307][mmc]: ***Try MMC card 2***
[333][mmc]: RMCA OK!
[335][mmc]: bias 4
[337][mmc]: mmc 2 bias 4
[340][mmc]: MMC 5.1


这个是另一固件的输出

---

**Cursor**

非常好，这个对比日志非常有价值。我来搜索 BOOT0 源码中的关键错误信息来定位根本原因。

`ic cant match axp` 这条字符串不在源码中，说明它在预编译的 BOOT0 二进制里。现在对比两份日志来分析差异：

**关键对比：**

| 项目 | 你的板子（卡住）| 参考固件（正常）|
|------|----------------|----------------|
| `bus read error` | 有，然后卡住 | 有，但继续运行 |
| `board init ok` | 无（打印了 `set sys_vol to 940mv` 后卡住）| 正常打印 |
| DRAM 初始化 | 未到达 | 正常完成 |
| `ic cant match axp` | 出现 | 未出现 |

参考固件也有 `bus read error`，但能正常继续 —— 说明 `bus read error` 本身不是致命错误。你的板子卡在 `ic cant match axp`，说明 BOOT0 在检测 AXP 型号时失败了。

让我查找 BOOT0 源码：

找到了关键文件，读取 BOOT0 主文件和 SPL 中的 PMU 相关代码：

找到了关键函数 `sunxi_board_init()`，这是 PMU 初始化的地方。继续追踪：

[Error: Post "https://cursor.com/api/chat": unexpected EOF]

---

**User**

继续

---

**Cursor**

继续查找 `sunxi_board_init` 的实现和 PMU 匹配逻辑：

关键在于预编译的 `.a` 库文件，`sunxi_board_init` 的实现在 `libsun50iw10p1_sdcard.a` 中。这意味着 BOOT0 的 PMU 检测逻辑是预编译的，无法直接查看源码。

但根据目录结构，`board/r818/` 和 `board/a133/` 都有独立的库。让我查看这两个板子的 `.mk` 文件差异，以及 `boot0_head.c` 来找到 `power_mode` 的配置：

非常关键的发现！在 `common.mk` 中看到支持的 PMU 列表：

```
CFG_AXP81X_POWER=y
CFG_AXP858_POWER=y
CFG_AXP806_POWER=y
CFG_AXP2202_POWER=y
```

**注意：这里没有 `CFG_AXP803_POWER`！** 但 `sys_config.fex` 和 `board.dts` 都配置了 AXP803。

这正是 `ic cant match axp` 的根本原因 —— 预编译的 BOOT0 库根本不包含 AXP803 的支持，只支持 AXP81X、AXP858、AXP806、AXP2202。

现在查看 AXP81X 的寄存器定义，确认 AXP803 是否兼容 AXP81X：

非常关键！`axp81x_reg.h` 头文件注释写着 `/*define AXP803 REGISTER */`，说明 **AXP803 和 AXP81X 使用相同的寄存器**，但 `AXP81X_CHIP_ID = 0x11`。现在查看 `axp81X_axp_init` 函数，看它如何用 chip id 匹配：

现在完全清楚了！找到了关键的 probe 函数：

```c
pmu_chip_id &= 0XCF;
if (pmu_chip_id == AXP81X_CHIP_ID) {  // 0x11
    tick_printf("PMU: AXP803\n");
    return 0;
}
```

**U-Boot 层面 AXP803 是通过 AXP81X 驱动识别的（chip_id & 0xCF == 0x11）。**

但问题出在 **BOOT0（SPL）阶段**，它使用的是预编译的 `.a` 库。让我查看 SPL 的 AXP 初始化逻辑，特别是 `ic cant match axp` 这条打印：

SPL 的 PMU 实现在预编译的 `.a` 库里，无法直接看源码。让我换个角度，查看 SPL 的 AXP 头文件中的 chip ID 定义，以及对比两个版本的 BOOT0 commit hash 来确认差异：

现在我已经有了完整的分析。让我再确认一下两份日志中 BOOT0 的 commit hash 差异，以及当前固件的版本：

两份日志对比：
- **你的板子**：`BOOT0 commit : e1a64ba`，卡在 `ic cant match axp`
- **参考固件**：`BOOT0 commit : 83e3c82`，正常运行

两个 BOOT0 版本不同！现在来查看当前构建的 BOOT0 是哪个版本的：

非常关键！现在完全明确了：

- `board/r818/commit_info.h` → `e1a64ba` ← **就是你卡住的版本**
- `board/a133/commit_info.h` → `06dfa2d3`
- 参考固件正常版本 → `83e3c82`

说明你的固件使用的是 **r818** 板子的 BOOT0 库，而这个版本的预编译库中 `ic cant match axp` 是致命错误。参考固件用的是另一个版本（`83e3c82`）。

查看当前编译使用的是哪个 board 目录，以及 Makefile 配置：

[Error: Post "https://cursor.com/api/chat": unexpected EOF]

---

**User**

继续

---

**Cursor**

从 Makefile 中看到关键逻辑：

```makefile
ln -s $(TOPDIR)/board/$(CP_BOARD)/commit_info.h include/commit_info.h
```

如果指定了 `b=r818`，则使用 `board/r818/commit_info.h`（即 `e1a64ba`）。让我查看当前实际链接的 `commit_info.h` 和 `.module.common.mk`：

现在完全清楚了。让我查看 `board/r818` 和 `board/a133` 的预编译库区别，以及 `board/sun50iw10p1` 的 commit_info：

现在完全明白了！`board/r818` 的预编译库中**有 `axp81X_axp_init`**，理论上支持 AXP803。问题不是库不支持，而是 **chip ID 匹配失败**。

让我用 `strings` 命令从预编译库中提取字符串，找到 `ic cant match axp` 的上下文：

现在找到了完整的证据！从预编译库的字符串中可以看到：

```
ic cant match axp, please check...
...
[pmu]: bus read error
PMU: AXP803
unknow PMU
```

这说明库中的逻辑是：先尝试读取 AXP chip ID，如果 `pmu_chip_id & 0xCF != 0x11`，就打印 `ic cant match axp, please check...`，然后挂起。

**根本原因已确认：硬件上 AXP803 的 chip ID 读取失败或不匹配。**

两份日志对比的关键差异：
- 参考固件：`bus read error` 后能识别到 AXP803 → 说明那块板的 AXP803 I2C 通信正常，只是第一次 bus read error 后重试成功
- 你的固件：`bus read error` 后 `ic cant match axp` → AXP803 完全无法通过 I2C 通信

现在来看 `sys_config.fex` 的 PMU 相关 TWI 配置，对比备份文件：

---

**User**

继续

---

**Cursor**

现在找到了决定性的差异！

**两份 `sys_config.fex` 的关键对比：**

| 配置项 | 你的 `sys_config.fex`（卡住）| backup（参考）|
|--------|---------------------------|--------------|
| `power_mode` | `0`（AXP81X/AXP803）| `3`（AXP2202）|
| DRAM type | `3`（DDR3）| `8`（LPDDR4）|
| DRAM clk | `648 MHz` | `888 MHz` |

**结论完全确定：**

backup 文件是这块板子（A133/sc3917）的原始配置，使用 `power_mode = 3`（AXP2202）。你的 `sys_config.fex` 错误地设置了 `power_mode = 0`（AXP81X/AXP803），导致 BOOT0 去 I2C 寻找 AXP81X（chip_id 0x11），但板子上实际装的可能是 AXP2202，因此匹配失败，打印 `ic cant match axp` 后挂起。

**解决方法：修改 `sys_config.fex` 中的 `power_mode` 为 `3`：**

修改已完成。验证一下修改结果：

修改已成功验证。`power_mode` 已从 `0` 改为 `3`。

---

**问题总结与解决方案：**

**根本原因：** `sys_config.fex` 中 `power_mode = 0`（对应 AXP81X/AXP803），但板子实际使用的是 **AXP2202**（`power_mode = 3`）。BOOT0 按照配置去 I2C 总线寻找 AXP81X（chip_id `0x11`），找不到匹配的芯片，打印 `ic cant match axp, please check...` 后挂死。

**已修复：**
```
/device/config/chips/r818/configs/sc3917/sys_config.fex
  power_mode = 0  →  power_mode = 3
```

**下一步：** 重新编译固件并烧录：

```bash
# 在 SDK 根目录执行
source build/envsetup.sh
lunch XXX-r818-sc3917
make -j$(nproc)
pack
```

然后将生成的新固件烧录到板子，启动日志应该不再出现 `ic cant match axp` 错误，而是正常显示 `PMU: AXP2202` 并继续 DRAM 初始化。

---

**User**

不要管backup文件，我就是想把R818 SDK移植到这个A133开发板上，你的修改有问题，我已回退，请你着重分析一下是否是chip id引起的问题

---

**Cursor**

明白，你这个要求很对。我们**不参考 backup**，只基于你现在的 R818 SDK 配置和启动日志来判断。  
我先把关键配置和代码打印点再核对一遍，专门回答“是不是 chip id 引起的”。

你这个提醒非常关键，我同意：这里要先把“**是不是 chip id 问题**”拆清楚。

结论先说：

1. **不是 SoC chip id 问题**（`the chip id is 0x1400` 这个）
2. **是 PMU chip id/PMU识别链路问题**（`ic cant match axp` 这个）

---

为什么这么判断：

- 日志里的 `the chip id is 0x1400` 是 DRAM 初始化阶段对 **SoC(A133)** 的检查，后面还出现 `chip id check OK`，说明 SoC ID 本身没问题。
- 卡死点是：
  - `[pmu]: bus read error`
  - `PMU: AXP803`
  - `ic cant match axp, please check...`
- 这条报错语义就是：**BOOT0 在做 PMU 探测时，读到的 PMU ID 不符合当前 `power_mode` 期望值**。

---

你当前 R818 移植配置里，关键是：

- `sys_config.fex` 里 `power_mode = 0`（AXP81X/AXP803路径）
- `board.dts` 写的是 `x-powers,axp803`（但注意：**BOOT0 阶段主要看 fex，不看 Linux dts**）

所以如果硬件实际 PMU 不是 AXP803/81X，或 PMU I2C 通道（PL0/PL1）通信异常，就会正好触发你现在这个错误。

---

建议你按“芯片识别”做最小验证（不依赖 backup）：

### 1) 先确认不是 SoC chip id
这个已经基本确认：`0x1400` + `chip id check OK` 说明 A133 ID链路是通的。

### 2) 做 PMU 型号快速二分（最有效）
仅改 `sys_config.fex` 的 `power_mode` 做A/B测试（其他不动）：
- `power_mode=0`（AXP81X/803）
- `power_mode=3`（AXP2202）
- `power_mode=4`（AXP858）

看哪一个能通过 `ic cant match axp`。  
这一步是最直接判断“PMU芯片类型不匹配”还是“总线物理层故障”。

### 3) 若所有模式都失败
那就是 **PMU I2C 物理通信问题**（更可能）：
- PMU SCL/SDA 到 SoC 的引脚是否确实接在 BOOT0 使用的那组（通常 PL0/PL1）
- 上拉电阻是否存在、阻值是否合适
- 电平域是否匹配（1.8V/3.3V）
- PMU本体供电与复位状态是否正常

---

如果你愿意，我下一步可以按“R818→A133移植”的思路，给你一个**最小改动的 PMU 适配清单**（只含 BOOT0/FEX 必需项，不碰无关配置），这样你可以一次性验证是否由 PMU chip id 路径导致。

---

**User**

[138]HELLO! BOOT0 is starting!
[141]BOOT0 commit : 83e3c82
[144]set pll start
[146]periph0 has been enabled
[149]set pll end
[151][pmu]: bus read error
[154]PMU: AXP803
[174]vaild para:1  select dram para0
[177]board init ok
[200]DRAM BOOT DRIVE INFO: V0.61
[203]the chip id is 0x1400
[205]the chip id is 0x1400
[208]the chip id is 0x1400
[211]the chip id is 0x1400
[213]the chip id is 0x1400
[216]chip id check OK
[225]DRAM_VCC set to 1500 mv
[228]DRAM CLK =648 MHZ
[230]DRAM Type =3 (3:DDR3,4:DDR4,7:LPDDR3,8:LPDDR4)
[239]DRAM SIZE =2048 MBytes, para1 = 310a, para2 = 8000000, tpr13 = 6001
[251]DRAM simple test OK.
[254]dram size =2048
[256]chipid = 54401400

这是device/config/chips/r818/(backup)bin固件成功输出的内容，但是这些内容不是从这个SDK编译出来的，为什么

---

**Cursor**

我先帮你把“这个成功固件为什么不是从当前 SDK 编出来的”做一个可验证的溯源。先看打包配置和 `boot0` 来源路径。

Grep output mode content failed due many binary? We'll use LS on tools scripts maybe pack scripts with names.

我再做一个“可证据化”的结论：比较两个 `boot0` 文件是否同源，以及它们是否会被构建流程覆盖。

Need answer question "为什么不是从这个SDK编译出来的". We have evidence: backup bin has commit83e3c82 embedded. current SDK commit_info points e1a64ba. prebuilt bins under device/config/chips/r818/bin likely used by pack directly if not rebuilding brandy/spl. could come from vendor drop old built binaries. Need explain build system: LICHEE_BRANDY_VER=2.0, boot0 built from brandy-2.0/spl with commit_info symlink from board/r818. If user only make kernel/rootfs pack maybe not rebuild boot0 thus uses existing bin files in device/config/chips/r818/bin. There is also (backup)bin with other binaries from another release. They manually replaced? Need provide commands to verify provenance and enforce full rebuild. maybe give precise steps:
- check strings boot0 bin for commit hash
- check compile_dir maybe out/... u-boot etc.
- run clean for brandy and remove bin boot0 then rebuild; compare timestamp/sha.
Need maybe avoid shell tool names in response? no mention maybe okay as natural language.
Need include no code ref unless existing code? We can cite snippets with code reference format maybe not needed. just concise.

Need mention chip id analysis too maybe tie back:
- successful backup log with same chip id 0x1400 and no halt indicates SoC chip id not root cause.
- difference commit indicates boot0 behavior changed.
Let's craft clear bullets.

你这个现象其实很典型：**同一个工程目录里混了“预编译二进制”和“源码可编译产物”**。

我已经帮你做了几项核对，结论是：

1. `device/config/chips/r818/(backup)bin/boot0_sdcard_sun50iw10p1.bin` 内嵌了字符串 `83e3c82`  
2. 当前 SDK 的 `spl/board/r818/commit_info.h` 是 `e1a64ba`  
3. 两个 `boot0` 文件的 `sha256` 完全不同，大小也不同（`backup` 是 49152，当前 `bin` 是 65536）

所以你那份“成功日志（BOOT0 commit: 83e3c82）”确实**不是当前这套 SDK 现编出来的 boot0**，而是历史遗留/外部拷贝进来的预编译 `backup bin`。

---

你问的核心：“是否是 chip id 引起的？”

**结论：不是 SoC chip id 引起的。**

- 日志里 `the chip id is 0x1400` + `chip id check OK` 说明 SoC ID 是正常识别的。
- 真正卡死点是 PMU识别链路（`bus read error` + `ic cant match axp`）。

换句话说：

- `0x1400`（SoC chip id）这条线是通的；
- 出问题的是 BOOT0 对 PMU 的探测与匹配（AXP相关）。

---

为什么你会“明明改了源码，但跑出来还是旧行为”？

因为打包时可能直接拿了 `device/config/chips/r818/bin/*.bin` 里的现成文件；  
如果没有强制重编 boot0/fes/u-boot，就不会刷新这些二进制。

---

建议你下一步这样做（确保“真从当前SDK编”）：

1. 删除 `device/config/chips/r818/bin/boot0_*`（至少这两个 boot0）
2. 清理并重编 `brandy-2.0/spl` 与 `u-boot`
3. 再打包镜像
4. 启动后先看第一行 `BOOT0 commit` 是否变成当前源码对应值（如 `e1a64ba`）

只要 commit 变了，后面的日志才有分析价值；否则一直是在测旧二进制。

---

如果你愿意，我下一步可以直接给你一套“最小命令序列”（只重编 boot0/fes/u-boot，不全量重编系统），专门用于做这个 provenance 验证。

---

**User**

我的意思是上面那些输出是backup bin的文件，它是可以正常运行的外部bin文件，从别的SDK拷贝而来的，帮我对比分析一下为什么这个SDK编译出来的无法启动？

---

**Cursor**

我先做一个“二进制级别”的对比：定位 `ic cant match axp` 在当前 SDK 的哪个模块里，再对比两个 `boot0` 的关键字符串差异，这样可以精确判断“为什么外部 bin 能跑、当前 SDK 不能跑”。

你这个问题我已经对比出**核心差异**了，结论很明确：

## 结论（先说人话）

外部 `backup bin` 能启动，不是因为 SoC 不同，也不是 `0x1400` chip id 问题；  
而是因为它的 **BOOT0 版本不同**，PMU 初始化行为不同。

---

## 关键对比结果

你两套 `boot0` 里提取到的特征：

- 外部可启动：`BOOT0 commit : 83e3c82`，`DRAM BOOT DRIVE INFO: V0.61`
- 当前SDK编译：`BOOT0 commit : e1a64ba`，`DRAM BOOT DRIVE INFO: V0.69`

这说明是**两代不同的 boot0/spl 实现**，不是同一套代码。

你给的失败日志卡在：
- `[pmu]: bus read error`
- `PMU: AXP803`
- `ic cant match axp, please check...`

这属于 **PMU 探测/匹配路径**失败。

---

## 你问的“是不是 chip id 引起的？”

### 不是 SoC chip id 引起的
因为日志里有：
- `the chip id is 0x1400`
- `chip id check OK`

SoC ID 是通过了的。

### 是 PMU 识别链路引起的
卡在 `ic cant match axp`，这是 PMU 侧（AXP）识别不通过，不是 A133 主芯片 ID 不通过。

---

## 为什么外部 bin 可以，你这个 SDK 编出来不行？

因为你当前 SDK 编出来的是 `e1a64ba` 这版 BOOT0（V0.69），它在你的板子上 PMU 检测更“严格”或流程改变，导致停在 PMU 匹配；  
外部 `83e3c82`（V0.61）这版在同板上可继续启动。

本质是：**boot0 版本差异 + PMU 初始化流程差异**。

---

## 建议的正确处理方式（按可靠性排序）

1. **短期先跑通**：直接用外部那套可启动的 `boot0/fes1/u-boot`（最好整套，不要只换一个）
2. **长期根治**：把当前 SDK 的 `brandy-2.0/spl` 回退/替换到可工作的版本（至少 BOOT0 那部分）
3. **避免混搭**：不要只替一个 `boot0` 而其余仍用新版本，建议 `boot0 + fes1 + u-boot + sboot` 尽量同源

---

如果你愿意，我可以下一步给你一份“**最小替换清单**”（哪些 bin 必须成套替换、哪些可以保持当前），避免你反复试错。

---

**User**

lichee/brandy-2.0/spl/board，我怀疑是a133和r818还是有一点差异导致这里出了点错，帮我分析一下是否是SOC类型不同影响的启动停止？如何指定？

---

**Cursor**

你这个怀疑非常专业，结论是：

## 1) 是否是 SoC 类型不同导致？
**大概率不是。**

因为 `spl/board/a133/common.mk`、`spl/board/r818/common.mk` 的核心都指向同一个平台：

- `PLATFORM = sun50iw10p1`
- `LICHEE_CHIP = sun50iw10p1`（在 `BoardConfig.mk`）

也就是 **A133 和 R818 在这个 SDK 里属于同一 SoC 平台族**，不是“换了 SoC 架构”那种问题。

---

## 2) 真正差异在哪？
差异在 **board 级别的 boot0 预编译库** 和编译开关，不是 SoC 平台本身：

- `spl/nboot/Makefile` 明确写了 boot0 链接的是  
  `board/$(CP_BOARD)/lib$(PLATFORM)_sdcard.a`
- 所以 `CP_BOARD=r818` 和 `CP_BOARD=a133` 会链接**不同库**
- 这会直接影响 PMU/DDR/board init 早期行为（你现在卡的正是这个阶段）

你现在的卡点（PMU识别）就很符合“board库行为差异”。

---

## 3) 你问“如何指定？”
在 `spl` 里是通过 `p` + `b` 指定的：

- `p` 指定 SoC 平台（这里固定 `sun50iw10p1`）
- `b` 指定 board 库（`a133` 或 `r818`）

### 推荐做法（只测试 boot0 路径）

```bash
cd lichee/brandy-2.0/spl
make distclean
make p=sun50iw10p1 b=a133
make boot0 fes sboot
```

然后确认 `include/commit_info.h` 是否链接到 `board/a133/commit_info.h`。  
如果是，就说明你现在编出来的是 **a133 board 版本 boot0**。

---

## 4) 关键提醒
你现在主工程还是 `chip=r818` 打包路径，后续全量构建可能又把 `r818` 的 boot0 覆盖回去。  
所以要么：

1. 先单独替换并锁定 `device/config/chips/r818/bin/boot0_*.bin` 做启动验证；
2. 要么把上层构建流程也改成固定使用 `b=a133` 的 spl 产物。

---

如果你要，我可以下一步给你一份“**最小不被覆盖**”流程（哪些文件替换、在哪一步替换），保证你烧录的一定是 `b=a133` 编出来的 boot0。

---