# 安全模式下sboot.bin与nboot的比较
_Exported on 2026/5/13 at GMT+8 21:30:32 from Cursor (2.6.21)_

---

**User**

能否帮我分析一下为什么lichee/brandy-2.0/spl的安全模式只用sboot.bin即可，而nboot会编译出具体介质的boot0？

---

**Cursor**

我先查看相关目录和构建脚本，确认 `sboot.bin`、`nboot/boot0` 在工程里的生成与打包路径。

刚才全局搜索命中太宽，我改为只在 `brandy-2.0/spl` 和打包脚本里看关键规则。

需要直接读几个核心 Makefile 和入口源码来对比。

还要看 nboot/sboot 的 flash 抽象，以及板级库构成，确认安全启动是否从 TOC0 配置拿介质类型。

我再定位 `sunxi_flash_init`、`load_package` 等实现，它们通常体现“介质差异是在编译期还是运行期选择”。

源码里可能有非 `.c` 或通过库/板级目录生成，我按符号查文件名和对象规则。

需要读 board mk。

我还看一下已生成镜像里的 `dragon_toc.cfg`，确认安全启动链里 `sboot/toc0/toc1` 的打包关系。

我最后确认一下打包脚本在安全/非安全模式下选择哪个一阶段文件。

可以。核心原因是：**安全启动链里，介质差异主要由 BootROM + TOC0 配置 + `sboot` 运行期识别/抽象处理；而非安全 `nboot/boot0` 是按启动介质编译出来的裸一阶段加载器，介质驱动和后续加载逻辑在编译期就被固化了。**

## 1. `nboot` 为什么会编译出具体介质的 `boot0`

`nboot` 的 Makefile 会根据目标 `mmc` / `nand` / `spinor` 包含不同的板级介质配置：

```18:20:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/Makefile
include $(TOPDIR)/mk/config.mk
include $(TOPDIR)/.module.common.mk
include $(TOPDIR)/board/$(PLATFORM)/$(MAKECMDGOALS).mk
```

比如 `mmc.mk` 只打开 SDMMC：

```11:12:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/board/r818/mmc.mk
MODULE=mmc
CFG_SUNXI_SDMMC =y
```

而 `nand.mk` 打开 NAND / SPINAND：

```10:13:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/board/r818/nand.mk
MODULE=nand
CFG_SUNXI_NAND =y
CFG_SUNXI_SPINAND =y
```

所以 `nboot` 在链接时会按这些宏选择不同的板级库：

```61:68:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/Makefile
COBJS-$(CFG_SUNXI_SDMMC)   += $(TOPDIR)/board/$(CP_BOARD)/lib$(PLATFORM)_sdcard.a
ifeq (x$(findstring y,$(CFG_SUNXI_NAND)$(CFG_SUNXI_SPINAND)), xy)
COBJS-y  += $(TOPDIR)/board/$(CP_BOARD)/lib$(PLATFORM)_nand.a
endif
COBJS-$(CFG_SUNXI_SPINOR)  += $(TOPDIR)/board/$(CP_BOARD)/lib$(PLATFORM)_spinor.a
COBJS-y += $(TOPDIR)/nboot/main/boot0_main.o
```

然后分别生成不同介质的 `boot0`：

```92:114:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/Makefile
spinor:	 $(LIBS) $(LIBSPINOR) boot0.lds
	$(Q)echo bootaddr is $(CFG_BOOT0_RUN_ADDR)
	$(LD) $(OBJS) $(LIBSPINOR) $(PLATFORM_LIBGCC) $(LDFLAGS) $(LDFLAGS_GC) -Tboot0.lds -o boot0_spinor.elf -Map boot0_spinor.map
	$(OBJCOPY) $(OBJCFLAGS) -O binary  boot0_spinor.elf boot0_spinor.bin
	@$(TOPDIR)/mk/gen_check_sum $(SRCTREE)/nboot/boot0_spinor.bin boot0_spinor_$(PLATFORM)$(DRAM_TYPE_NAME).bin > /dev/null
	@$(TOPDIR)/mk/encrypto_boot0 -f boot0_spinor_$(PLATFORM)$(DRAM_TYPE_NAME).bin  -c $(LICHEE_IC) >/dev/null
	@-cp -v boot0_spinor_$(PLATFORM)$(DRAM_TYPE_NAME).bin $(TARGETDIR)/

mmc:	 $(LIBS) $(LIBMMC) boot0.lds
	$(Q)echo bootaddr is $(CFG_BOOT0_RUN_ADDR)
	$(LD) $(OBJS) $(LIBMMC) $(PLATFORM_LIBGCC) $(LDFLAGS) $(LDFLAGS_GC) -Tboot0.lds -o boot0_sdcard.elf -Map boot0_sdcard.map
	$(OBJCOPY) $(OBJCFLAGS) -O binary  boot0_sdcard.elf boot0_sdcard.bin
	@$(TOPDIR)/mk/gen_check_sum boot0_sdcard.bin boot0_sdcard_$(PLATFORM)$(DRAM_TYPE_NAME).bin > /dev/null
	@$(TOPDIR)/mk/encrypto_boot0 -f boot0_sdcard_$(PLATFORM)$(DRAM_TYPE_NAME).bin  -c $(LICHEE_IC) >/dev/null
	@-cp -v boot0_sdcard_$(PLATFORM)$(DRAM_TYPE_NAME).bin $(TARGETDIR)/

nand:	 $(LIBS) $(LIBNAND) boot0.lds
	$(Q)echo bootaddr is $(CFG_BOOT0_RUN_ADDR)
	$(LD) $(OBJS) $(LIBNAND) $(PLATFORM_LIBGCC) $(LDFLAGS) $(LDFLAGS_GC) -Tboot0.lds -o boot0_nand.elf -Map boot0_nand.map
```

也就是说，非安全模式下的 `boot0` 本身就是“介质相关”的一阶段程序：

- `boot0_sdcard_xxx.bin`
- `boot0_nand_xxx.bin`
- `boot0_spinor_xxx.bin`

它们里面链接的介质初始化、读扇区/读页、后续包加载逻辑不一样。

## 2. `sboot` 为什么只需要一个 `sboot.bin`

`sboot` 的 Makefile 不像 `nboot` 那样根据 `mmc/nand/spinor` 目标切换不同规则，而是统一编译 `sboot`：

```81:87:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/Makefile
sboot:	 $(LIBS) $(OBJS) sboot.lds
	$(Q)echo bootaddr is $(CFG_SBOOT_RUN_ADDR)
	$(LD) $(OBJS) $(LIBSPINOR) $(PLATFORM_LIBGCC) $(LDFLAGS) $(LDFLAGS_GC) -Tsboot.lds -o sboot.elf -Map sboot.map
	$(OBJCOPY) $(OBJCFLAGS) -O binary  sboot.elf sboot.bin
	@$(TOPDIR)/mk/gen_check_sum $(SRCTREE)/sboot/sboot.bin sboot_$(PLATFORM)$(DRAM_TYPE_NAME).bin > /dev/null
	@$(TOPDIR)/mk/encrypto_boot0 -f sboot_$(PLATFORM)$(DRAM_TYPE_NAME).bin  -c $(LICHEE_IC) >/dev/null
```

而 `r818/sboot.mk` 里同时打开了 MMC 和 NAND 支持：

```11:19:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/board/r818/sboot.mk
MODULE=sboot

CFG_SUNXI_MMC =y
CFG_SUNXI_NAND =y
CFG_SUNXI_CE_21 =y
CFG_SUNXI_EFUSE =y
CFG_SUNXI_SBOOT =y
CFG_SUNXI_ITEM_HASH =y
CFG_SUNXI_KEY_PROVISION =y
```

`sboot` 链接的是统一的 sboot 板级库：

```61:66:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/Makefile
LIBS-y += arch/$(ARCH)/cpu/$(CPU)/libarch.o
LIBS-y += sboot/main/libmain.o
LIBS := $(addprefix $(TOPDIR)/,$(sort $(LIBS-y)))

COBJS-y += $(TOPDIR)/board/$(CP_BOARD)/lib$(PLATFORM)_sboot.a
COBJS-y += $(TOPDIR)/sboot/main/sboot_main.o
```

所以对 `sboot` 来说，介质不是通过 `make mmc` / `make nand` 分别编译决定，而是被包含进统一的 `sboot` 能力里，再由运行期信息决定走哪条路径。

关键点在 `sboot_main.c`：

```19:20:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_main.c
sbrom_toc0_config_t *toc0_config = (sbrom_toc0_config_t *)(CONFIG_TOC0_CFG_ADDR);
int mmc_config_addr = (int)(((sbrom_toc0_config_t *)CONFIG_TOC0_CFG_ADDR)->storage_data + 160);
```

这里 `sboot` 使用的是 BootROM / TOC0 留下来的安全启动配置区，而不是像普通 `boot0` 那样完全依赖自身私有头。

之后 `sboot` 根据 TOC0 头里的平台/介质信息初始化 flash：

```73:79:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_main.c
	if (toc0->platform[0] & 0xf0)
		printf("read toc0 from emmc backup\n");

	ret = sunxi_flash_init(toc0->platform[0] & 0x0f);
	if(ret)
		goto _BOOT_ERROR;
```

也就是说，安全模式下的介质选择被后移到了运行期：

```c
sunxi_flash_init(toc0->platform[0] & 0x0f);
```

`toc0->platform[0] & 0x0f` 里携带 BootROM / TOC0 传递的启动介质类型。`sboot` 只要内置对应介质支持，就能根据这个类型去读后续的 `toc1`。

## 3. 安全启动时 `sboot.bin` 不是普通裸 `boot0`

你当前生成的 `dragon_toc.cfg` 也能说明这一点：

```14:16:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/out/r818-sc3917/image/dragon_toc.cfg
[toc0]
item=toc0,		sboot.bin,	RootKey_Level_0
```

安全模式下，`sboot.bin` 是作为 `toc0` 里的一个 item 被打包、签名、认证的。也就是说启动链更像这样：

```text
BootROM
  -> 读取并认证 TOC0
  -> 从 TOC0 中取出 sboot.bin
  -> 执行 sboot
  -> sboot 初始化 DRAM / flash
  -> 读取、认证并运行 TOC1
  -> monitor / optee / u-boot / scp ...
```

而非安全启动更像：

```text
BootROM
  -> 从具体介质固定位置读取 boot0
  -> boot0 初始化 DRAM
  -> boot0 从同一介质读取 boot package / u-boot
  -> 跳转
```

所以非安全 `boot0` 必须是介质相关的；安全 `sboot` 则作为 TOC0 认证后的通用安全一阶段，介质类型由 TOC0/BootROM 信息传给它。

## 4. 从配置看，启动介质可以是自动扫描

你的 `sys_config.fex` 里：

```21:24:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/out/r818-sc3917/image/sys_config.fex
[target]
boot_clock       = 1008
storage_type     = -1
burn_key         = 0
```

注释里说明：

```14:17:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/out/r818-sc3917/image/sys_config.fex
;[target]  system bootup configuration
;boot_clock	= CPU boot frequency, Unit: MHz
;storage_type	= boot medium, 0-nand, 1-card0, 2-card2, -1(defualt)auto scan
;burn_key  1:support burn key; 0:not support burn key
```

`storage_type = -1` 表示自动扫描。安全启动时，BootROM 找到 TOC0 后，会把相关启动介质/配置传给后续 `sboot`，所以 `sboot` 不需要预先拆成 `sboot_mmc.bin`、`sboot_nand.bin` 这种形式。

## 5. 总结一句话

`nboot/boot0` 是 **非安全裸启动的一阶段加载器**，需要在编译期按介质链接不同驱动和加载逻辑，所以会有 `boot0_sdcard`、`boot0_nand`、`boot0_spinor`。

`sboot.bin` 是 **安全启动 TOC0 里的认证 payload**，BootROM 已经负责找到并认证 TOC0，`sboot` 再通过 TOC0/BootROM 传入的介质信息运行期初始化 flash 并加载 TOC1；因此一个 `sboot.bin` 就可以覆盖多种启动介质，前提是它编译时包含了对应介质支持。

---

**User**

既然BROM有能力从具体介质加载，为什么boot0还要大费周章地搞那么多版本？

---

**Cursor**

关键点是：**BROM“能从介质加载”不等于它“能完整管理介质并加载系统镜像”**。BROM 只负责把很小的一阶段程序弄进片内 SRAM；`boot0` 负责在 DRAM 初始化后，按具体介质规则把后续 boot package / U-Boot / OP-TEE / monitor 等加载出来。

可以把职责分成两段看：

```text
BROM:
  从启动介质的固定位置，用最小能力读取 boot0/sboot 到 SRAM

boot0/sboot:
  初始化板级电源、时钟、DRAM
  初始化具体存储介质
  读取后续 boot package / toc1 / u-boot / optee / monitor
  传递启动参数
  跳转到下一阶段
```

所以 BROM 和 `boot0` 虽然都“读介质”，但读的东西、复杂度、约束完全不同。

---

## 1. BROM 只需要读很小的第一阶段

BROM 是芯片 ROM，固化在硅片里，不能升级，代码空间也极小。它通常只实现：

- 从 NAND / SD / eMMC / SPI NOR 等介质的固定位置探测启动头；
- 做最小化初始化；
- 把一小段 boot code 读入片内 SRAM；
- 校验 checksum 或安全模式下做签名认证；
- 跳转。

它不适合也不应该实现完整介质栈。比如 NAND 上的坏块管理、ECC、页大小差异、备份区、分区布局，eMMC 上的 boot0/boot1/user area，SD 卡普通扇区读取，SPI NOR 的 command set，这些如果全部放到 BROM 里，会让 ROM 复杂度、风险和不可修复 bug 都非常高。

所以 BROM 的目标是：**只要能可靠读到 boot0/sboot 就够了。**

---

## 2. `boot0` 要读的是“后续系统包”，复杂得多

非安全 `boot0` 的主流程里，DRAM 初始化完成后，会调用 `load_package()` 和 `load_image()` 去加载后续镜像：

```56:68:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
	mmu_enable(dram_size);

	status = sunxi_board_late_init();
	if (status)
		goto _BOOT_ERROR;

	status = load_package();
	if(status == 0 )
		load_image(&uboot_base, &optee_base, &monitor_base, &rtos_base, &opensbi_base);
	else
		goto _BOOT_ERROR;
```

这一步和 BROM 读 `boot0` 不是一回事。这里要处理：

- 从当前启动介质读取 boot package；
- 识别包头、镜像条目；
- 加载 U-Boot、OP-TEE、monitor、RTOS、OpenSBI 等；
- 给 U-Boot 填充启动参数；
- 处理介质参数、备份区、偏移、扇区/页大小等；
- 出错时进入 FEL。

所以 `boot0` 里的介质代码不是重复 BROM 的简单读取能力，而是承担“正式启动加载器”的职责。

---

## 3. 为什么非安全 `boot0` 不做成一个通用版？

理论上可以做一个通用 `boot0`，里面同时带 MMC、NAND、SPI NOR 等驱动，运行时判断介质。但现实里有几个限制。

### 第一，片内 SRAM 空间非常小

`boot0` 运行在片内 SRAM，大小限制很严格。你的工程里 `boot0` 默认运行地址和 SRAM 大小是：

```7:9:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/board/r818/common.mk
CFG_BOOT0_RUN_ADDR=0x20000
CFG_SYS_INIT_RAM_SIZE=0x10000
CFG_FES1_RUN_ADDR=0x28000
```

`CFG_SYS_INIT_RAM_SIZE=0x10000`，也就是 64 KiB 级别。这里面不只要放介质驱动，还要放：

- 入口代码；
- 时钟初始化；
- PMIC/电源初始化；
- UART 调试；
- GPIO；
- DRAM 初始化；
- 包加载逻辑；
- 异常/FEL 逻辑；
- 必要的数据结构。

如果把 NAND、SPINAND、SDMMC、SPI NOR 全塞进去，很容易超尺寸。

所以非安全 `boot0` 选择“按介质编译”，本质是为了 **省空间、降低复杂度**。

### 第二，NAND 和 MMC 差异太大

BROM 读第一阶段可以用非常固定的启动规则，但 `boot0` 读后续镜像时要面对更复杂的介质布局。

比如：

- SD/eMMC 通常按 block/sector 读；
- NAND 要处理 page/block、坏块、ECC、备份块；
- SPI NAND 和 raw NAND 又不一样；
- SPI NOR 是线性地址，但命令、dummy cycle、频率配置不同；
- eMMC 还可能涉及 boot partition/user partition 差异。

这些逻辑如果全做成运行期分支，不只是体积变大，也会增加早期启动不确定性。

### 第三，`boot0` 的构建系统本来就是按介质链接不同库

你的 `nboot/Makefile` 已经体现得很清楚。它根据 `mmc` / `nand` / `spinor` 目标链接不同库：

```61:66:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/Makefile
COBJS-$(CFG_SUNXI_SDMMC)   += $(TOPDIR)/board/$(CP_BOARD)/lib$(PLATFORM)_sdcard.a
ifeq (x$(findstring y,$(CFG_SUNXI_NAND)$(CFG_SUNXI_SPINAND)), xy)
COBJS-y  += $(TOPDIR)/board/$(CP_BOARD)/lib$(PLATFORM)_nand.a
endif
COBJS-$(CFG_SUNXI_SPINOR)  += $(TOPDIR)/board/$(CP_BOARD)/lib$(PLATFORM)_spinor.a
```

然后分别生成：

```92:114:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/Makefile
spinor:	 $(LIBS) $(LIBSPINOR) boot0.lds
	$(Q)echo bootaddr is $(CFG_BOOT0_RUN_ADDR)
	$(LD) $(OBJS) $(LIBSPINOR) $(PLATFORM_LIBGCC) $(LDFLAGS) $(LDFLAGS_GC) -Tboot0.lds -o boot0_spinor.elf -Map boot0_spinor.map
	$(OBJCOPY) $(OBJCFLAGS) -O binary  boot0_spinor.elf boot0_spinor.bin
	@$(TOPDIR)/mk/gen_check_sum $(SRCTREE)/nboot/boot0_spinor.bin boot0_spinor_$(PLATFORM)$(DRAM_TYPE_NAME).bin > /dev/null
	@$(TOPDIR)/mk/encrypto_boot0 -f boot0_spinor_$(PLATFORM)$(DRAM_TYPE_NAME).bin  -c $(LICHEE_IC) >/dev/null
	@-cp -v boot0_spinor_$(PLATFORM)$(DRAM_TYPE_NAME).bin $(TARGETDIR)/

mmc:	 $(LIBS) $(LIBMMC) boot0.lds
	$(Q)echo bootaddr is $(CFG_BOOT0_RUN_ADDR)
	$(LD) $(OBJS) $(LIBMMC) $(PLATFORM_LIBGCC) $(LDFLAGS) $(LDFLAGS_GC) -Tboot0.lds -o boot0_sdcard.elf -Map boot0_sdcard.map
	$(OBJCOPY) $(OBJCFLAGS) -O binary  boot0_sdcard.elf boot0_sdcard.bin
	@$(TOPDIR)/mk/gen_check_sum boot0_sdcard.bin boot0_sdcard_$(PLATFORM)$(DRAM_TYPE_NAME).bin > /dev/null
```

这说明 `boot0_sdcard.bin`、`boot0_nand.bin`、`boot0_spinor.bin` 不是同一个东西改个名字，而是链接了不同介质库的不同程序。

---

## 4. 那为什么安全模式 `sboot` 可以统一？

因为安全启动链变了。

安全模式下 BROM 不是简单读裸 `boot0`，而是读 `TOC0`，并从 `TOC0` 里认证、加载 `sboot.bin`。你的 `dragon_toc.cfg` 里就是：

```14:16:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/out/r818-sc3917/image/dragon_toc.cfg
[toc0]
item=toc0,		sboot.bin,	RootKey_Level_0
```

`sboot` 本身不是普通非安全 `boot0`，它处在安全启动 TOC 框架里。`sboot` 可以从 TOC0/BootROM 传来的信息中知道启动介质，然后运行时初始化 flash：

```73:76:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_main.c
	if (toc0->platform[0] & 0xf0)
		printf("read toc0 from emmc backup\n");

	ret = sunxi_flash_init(toc0->platform[0] & 0x0f);
```

`sboot` 的板级配置里也同时打开了多个能力：

```11:16:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/board/r818/sboot.mk
MODULE=sboot

CFG_SUNXI_MMC =y
CFG_SUNXI_NAND =y
CFG_SUNXI_CE_21 =y
CFG_SUNXI_EFUSE =y
```

所以 `sboot` 是“一个安全启动场景下的通用安全一阶段”，它愿意为安全链多放一些通用逻辑，因为它要服务 TOC0/TOC1 认证流程。

---

## 5. 本质区别

| 项目 | BROM | 非安全 `boot0` | 安全 `sboot` |
|---|---|---|---|
| 存放位置 | 芯片 ROM | 外部介质 | TOC0 item |
| 是否可升级 | 不可升级 | 可升级 | 可升级 |
| 主要任务 | 找到并加载第一阶段 | 初始化 DRAM，加载 boot package | 初始化 DRAM，认证/加载 TOC1 |
| 介质能力 | 最小启动读取 | 完整后续加载 | 安全 TOC 框架下的后续加载 |
| 介质选择 | 芯片固化扫描逻辑 | 编译期区分 `mmc/nand/spinor` | 运行期根据 TOC0/BootROM 信息 |
| 为什么这样设计 | ROM 越小越可靠 | SRAM 小，按介质裁剪 | 安全链需要统一认证框架 |

---

所以答案是：

**BROM 的介质加载能力只够把第一阶段加载起来；`boot0` 还要负责初始化 DRAM 后读取完整后续镜像包，这部分介质差异很大，而且受 SRAM 大小限制，因此非安全 `boot0` 按介质拆成多个版本。**

而安全模式下，`sboot` 处在 TOC0/TOC1 安全启动框架中，可以通过 TOC0/BootROM 传递的介质信息运行期选择加载路径，所以表现为一个 `sboot.bin`。

