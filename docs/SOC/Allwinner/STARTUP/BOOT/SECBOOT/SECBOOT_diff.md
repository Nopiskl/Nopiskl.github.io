
**Cursor**

可以。我会先在 `lichee/brandy-2.0` 里定位 SPL、U-Boot、TOC/secure 相关入口和配置，再对比普通启动与安全启动链路。

我已经初步看到 `brandy-2.0` 下有独立的 `spl/nboot` 和 `spl/sboot`，分别对应普通 Boot0/SPL 与安全 SBoot/TOC0 路径；接下来读关键入口和头文件确认调用链。

接下来我需要看 `load_package/load_image`、`toc1_verify_and_run` 的实现，以及 U-Boot 入口接收这些信息的地方。

源码里一部分平台相关实现被打成了 `libsun50iw10p1_*.a` 静态库，我会再看符号表和 U-Boot 的 `boot_data` 使用点，这样能把路径补完整。

我还会查看一下静态库符号名和 U-Boot 中安全模式探测函数，确认 `sboot` 里隐藏在库中的 TOC1 校验加载函数。

当前系统没有全局的 `arm-linux-gnueabi-nm`，我改用仓库自带工具链里的 `nm` 看符号。

可以。结合 `lichee/brandy-2.0` 这份源码看，里面的第一阶段启动代码明显分成两套：

- 非安全启动：`spl/nboot`，产物是 `boot0_nand.fex` / `boot0_sdcard.fex` / `boot0_spinor.fex`
- 安全启动：`spl/sboot`，产物是 `sboot.bin`，再由打包阶段生成 `toc0.fex`，后续读取并校验 `toc1.fex`

也就是说，从源码组织上看：

```text
lichee/brandy-2.0/spl
├── nboot/   普通 Boot0/SPL 路径
└── sboot/   Secure Boot/SBoot 路径
```

---

## 1. 相关目录和构建目标

### 1.1 非安全启动 SPL：`nboot`

`nboot` 的 Makefile 负责编译普通 `boot0`：

```96:123:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/Makefile
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
	$(OBJCOPY) $(OBJCFLAGS) -O binary  boot0_nand.elf boot0_nand.bin
```

这里有三个普通启动产物：

| 构建目标 | 产物 |
|---|---|
| `mmc` | `boot0_sdcard.bin` |
| `nand` | `boot0_nand.bin` |
| `spinor` | `boot0_spinor.bin` |

普通启动根据介质不同，分别链接不同平台库：

```65:73:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/Makefile
LIBS-y  += arch/$(ARCH)/cpu/$(CPU)/libarch.o
LIBS-y += nboot/main/libmain.o
LIBS := $(addprefix $(TOPDIR)/,$(sort $(LIBS-y)))

COBJS-$(CFG_SUNXI_SDMMC)   += $(TOPDIR)/board/$(CP_BOARD)/lib$(PLATFORM)_sdcard.a
ifeq (x$(findstring y,$(CFG_SUNXI_NAND)$(CFG_SUNXI_SPINAND)), xy)
COBJS-y  += $(TOPDIR)/board/$(CP_BOARD)/lib$(PLATFORM)_nand.a
endif
COBJS-$(CFG_SUNXI_SPINOR)  += $(TOPDIR)/board/$(CP_BOARD)/lib$(PLATFORM)_spinor.a
```

对于你当前 `r818` 平台，`mmc.mk` 和 `nand.mk` 分别打开普通存储支持：

```1:12:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/board/r818/mmc.mk
#
#config file for sun50iw10
#
#stroage
FILE_EXIST=$(shell if [ -f $(TOPDIR)/board/$(PLATFORM)/common.mk ]; then echo yes; else echo no; fi;)
ifeq (x$(FILE_EXIST),xyes)
include $(TOPDIR)/board/$(PLATFORM)/common.mk
else
include $(TOPDIR)/board/$(CP_BOARD)/common.mk
endif

MODULE=mmc
CFG_SUNXI_SDMMC =y
```

```1:12:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/board/r818/nand.mk
#
#config file for sun50iw10
#
FILE_EXIST=$(shell if [ -f $(TOPDIR)/board/$(PLATFORM)/common.mk ]; then echo yes; else echo no; fi;)
ifeq (x$(FILE_EXIST),xyes)
include $(TOPDIR)/board/$(PLATFORM)/common.mk
else
include $(TOPDIR)/board/$(CP_BOARD)/common.mk
endif

MODULE=nand
CFG_SUNXI_NAND =y
```

---

### 1.2 安全启动 SPL：`sboot`

安全启动编译的是 `sboot.bin`：

```77:84:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/Makefile
all: sboot

sboot:	 $(LIBS) $(OBJS) sboot.lds
	$(Q)echo bootaddr is $(CFG_SBOOT_RUN_ADDR)
	$(LD) $(OBJS) $(LIBSPINOR) $(PLATFORM_LIBGCC) $(LDFLAGS) $(LDFLAGS_GC) -Tsboot.lds -o sboot.elf -Map sboot.map
	$(OBJCOPY) $(OBJCFLAGS) -O binary  sboot.elf sboot.bin
	@$(TOPDIR)/mk/gen_check_sum $(SRCTREE)/sboot/sboot.bin sboot_$(PLATFORM)$(DRAM_TYPE_NAME).bin > /dev/null
	@$(TOPDIR)/mk/encrypto_boot0 -f sboot_$(PLATFORM)$(DRAM_TYPE_NAME).bin  -c $(LICHEE_IC) >/dev/null
```

`sboot` 构建时链接的是专用安全启动库：

```62:66:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/Makefile
LIBS-y += arch/$(ARCH)/cpu/$(CPU)/libarch.o
LIBS-y += sboot/main/libmain.o
LIBS := $(addprefix $(TOPDIR)/,$(sort $(LIBS-y)))

COBJS-y += $(TOPDIR)/board/$(CP_BOARD)/lib$(PLATFORM)_sboot.a
```

当前 `r818` 的 `sboot.mk` 明确打开了安全启动相关配置：

```11:18:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/board/r818/sboot.mk
MODULE=sboot

CFG_SUNXI_MMC =y
CFG_SUNXI_NAND =y
CFG_SUNXI_CE_21 =y
CFG_SUNXI_EFUSE =y
CFG_SUNXI_SBOOT =y
CFG_SUNXI_ITEM_HASH =y
CFG_SUNXI_KEY_PROVISION =y
```

这里比普通 `mmc.mk` / `nand.mk` 多了明显的安全项：

| 配置 | 含义 |
|---|---|
| `CFG_SUNXI_CE_21=y` | 使用 CE 加密引擎相关能力 |
| `CFG_SUNXI_EFUSE=y` | 使用 eFuse，通常用于安全位、ROTPK 等 |
| `CFG_SUNXI_SBOOT=y` | 启用 sboot 路径 |
| `CFG_SUNXI_ITEM_HASH=y` | 启用 item hash 校验 |
| `CFG_SUNXI_KEY_PROVISION=y` | 启用 key provision 相关逻辑 |

---

## 2. 非安全启动路径

普通路径入口在 `spl/nboot/main/boot0_main.c`。

### 2.1 Boot0 文件头

普通 Boot0 的 magic 是 `eGON.BT0`：

```26:39:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/include/private_boot0.h
#define BOOT0_MAGIC                     "eGON.BT0"
#define DRAM_EXT_MAGIC                 "DRAM.ext"
#define SYS_PARA_LOG                    0x4d415244

/******************************************************************************/
/*                              file head of Boot                             */
/******************************************************************************/
typedef struct _Boot_file_head
{
	__u32  jump_instruction;   /* one intruction jumping to real code */
	__u8   magic[MAGIC_SIZE];  /* ="eGON.BT0" */
	__u32  check_sum;          /* generated by PC */
```

`boot0_head.c` 里构造 `BT0_head`：

```29:54:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_head.c
const boot0_file_head_t  BT0_head = {
	{
		/* jump_instruction*/
		JUMP_INSTRUCTION,
		BOOT0_MAGIC,
		STAMP_VALUE,
#ifdef ALIGN_SIZE_8K
		0x2000,
#else
		0x4000,
#endif
		sizeof(boot_file_head_t),
		BOOT_PUB_HEAD_VERSION,
		CONFIG_BOOT0_RET_ADDR,
		CONFIG_BOOT0_RUN_ADDR,
		0,
		{
		/*brom modify: nand-4bytes sdmmc-2bytes*/
		0, 0, 0, 0, '4', '.', '0', 0
		},
	},
```

非安全启动链路的第一阶段文件本质是：

```text
BootROM -> boot0_xxx.fex / boot0_xxx.bin
```

---

### 2.2 普通 Boot0 主流程

`boot0_main.c` 的主流程：

```21:99:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
void main(void)
{
	int dram_size;
	int status;
	phys_addr_t  uboot_base = 0, optee_base = 0, monitor_base = 0, \
				rtos_base = 0, opensbi_base = 0;
	u16 pmu_type = 0, key_input = 0; /* TODO: set real value */

	sunxi_board_init_early();
	sunxi_serial_init(BT0_head.prvt_head.uart_port, (void *)BT0_head.prvt_head.uart_ctrl, 6);
	printf("HELLO! BOOT0 is starting!\n");
	printf("BOOT0 commit : %s\n", BT0_head.hash);
	sunxi_set_printf_debug_mode(BT0_head.prvt_head.debug_mode);

	status = sunxi_board_init();
	if(status)
		goto _BOOT_ERROR;

	if (rtc_probe_fel_flag()) {
		rtc_clear_fel_flag();
		goto _BOOT_ERROR;
#ifdef CFG_SUNXI_PHY_KEY
	} else if (check_update_key(&key_input)) {
		goto _BOOT_ERROR;
#endif
	} else if (BT0_head.prvt_head.enable_jtag) {
		printf("enable_jtag\n");
		boot_set_gpio((normal_gpio_cfg *)BT0_head.prvt_head.jtag_gpio, 5, 1);
	}
```

接着初始化 DRAM、MMU、板级 late init，然后加载 boot package：

```50:75:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
#ifdef FPGA_PLATFORM
	dram_size = mctl_init((void *)BT0_head.prvt_head.dram_para);
#else
	dram_size = init_DRAM(0, (void *)BT0_head.prvt_head.dram_para);
#endif
	if(!dram_size)
		goto _BOOT_ERROR;
	else {
		printf("dram size =%d\n", dram_size);
	}

	char uart_input_value = get_uart_input();

	if (uart_input_value == '2') {
		sunxi_set_printf_debug_mode(3);
		printf("detected user input 2\n");
		goto _BOOT_ERROR;
	} else if (uart_input_value == 'd') {
		sunxi_set_printf_debug_mode(8);
		printf("detected user input d\n");
	}

	mmu_enable(dram_size);

	status = sunxi_board_late_init();
```

关键加载和跳转逻辑在这里：

```76:98:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
	if (status)
		goto _BOOT_ERROR;

	status = load_package();
	if(status == 0 )
		load_image(&uboot_base, &optee_base, &monitor_base, &rtos_base, &opensbi_base);
	else
		goto _BOOT_ERROR;

	update_uboot_info(uboot_base, optee_base, monitor_base, rtos_base, dram_size,
			pmu_type, uart_input_value, key_input);
	mmu_disable( );

	printf("Jump to second Boot.\n");
	if (opensbi_base) {
			boot0_jmp_opensbi(opensbi_base, uboot_base);
	} else if (monitor_base) {
		struct spare_monitor_head *monitor_head =
			(struct spare_monitor_head *)((phys_addr_t)monitor_base);
```

后续跳转：

```91:108:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
		monitor_head->secureos_base = optee_base;
		boot0_jmp_monitor(monitor_base);
	} else if (optee_base)
		boot0_jmp_optee(optee_base, uboot_base);
	else if (rtos_base) {
		printf("jump to rtos\n");
		boot0_jmp(rtos_base);
	}
	else
		boot0_jmp(uboot_base);

	while(1);
_BOOT_ERROR:
	boot0_clear_env();
	boot0_jmp(FEL_BASE);

}
```

所以非安全启动路径可以概括为：

```text
BootROM
  -> boot0_nand.fex / boot0_sdcard.fex / boot0_spinor.fex
      -> sunxi_board_init_early()
      -> UART 初始化
      -> sunxi_board_init()
      -> 检查 FEL / 按键 / JTAG
      -> init_DRAM()
      -> mmu_enable()
      -> sunxi_board_late_init()
      -> load_package()
      -> load_image()
          -> 得到 uboot_base/optee_base/monitor_base/rtos_base/opensbi_base
      -> update_uboot_info()
      -> 跳转：
          -> opensbi
          -> monitor
          -> optee
          -> rtos
          -> u-boot
```

需要注意：普通路径不是完全不能加载 OP-TEE / monitor，它也有 `optee_base`、`monitor_base` 判断。但这里没有看到 `sboot` 那套证书链校验流程。它主要是“加载 boot_package 并跳转”。

---

### 2.3 普通路径给 U-Boot 传递的信息

普通 Boot0 会把 DRAM、boot package 大小、OP-TEE/monitor 是否存在等信息写到 U-Boot 头部：

```111:137:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
static void update_uboot_info(phys_addr_t uboot_base, phys_addr_t optee_base,
		phys_addr_t monitor_base, phys_addr_t rtos_base, u32 dram_size,
		u16 pmu_type, u16 uart_input, u16 key_input)
{
	if (rtos_base)
		return;

	uboot_head_t  *header = (uboot_head_t *) uboot_base;
	struct sbrom_toc1_head_info *toc1_head = (struct sbrom_toc1_head_info *)CONFIG_BOOTPKG_BASE;

	header->boot_data.boot_package_size = toc1_head->valid_len;
	header->boot_data.dram_scan_size = dram_size;
	memcpy((void *)header->boot_data.dram_para, &BT0_head.prvt_head.dram_para, 32 * sizeof(int));

	if(monitor_base)
		header->boot_data.monitor_exist = 1;
	if(optee_base)
		header->boot_data.secureos_exist = 1;
#ifndef CONFIG_RISCV
	header->boot_data.func_mask |= get_uboot_func_mask(UBOOT_FUNC_MASK_ALL);
#endif
```

这里的 `uboot_head_t` 定义在 U-Boot 的 `private_uboot.h`，里面包含安全相关标志：

```52:70:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/include/private_uboot.h
	unsigned char               secureos_exist;
	unsigned char               monitor_exist;
	unsigned char               func_mask;              /* see enum UBOOT_FUNC_MASK_EN */
	unsigned char               res[1];
	unsigned int                uboot_start_sector_in_mmc;  /*use in OTA update */
	int                         dtb_offset;                 /*device tree in uboot */
	int                         boot_package_size;          /*boot package size, boot0 pass this value */
	unsigned int                dram_scan_size;             /*dram real size */
	int                         reserved[1];                /*reseved,256bytes align */
	/*expend boot_ext[0](int[4]) in uboot 2014*/
	uint16_t                    pmu_type;
	uint16_t                    uart_input;
	uint16_t                    key_input;
	uint8_t                     secure_mode; /*update by update_uboot*/
	uint8_t                     debug_mode;  /*update by update_uboot*/
	int                         reserved2[2];
```

也就是说，普通路径加载完 boot package 后，会把一部分启动上下文写进 U-Boot 头部，U-Boot 后续通过 `uboot_spare_head.boot_data` 使用这些字段。

---

## 3. 安全启动路径

安全启动入口在 `spl/sboot/main/sboot_main.c`。

### 3.1 SBoot 文件头

安全启动的 magic 不是 `eGON.BT0`，而是 `TOC0.GLH`：

```31:45:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_head.c
const sboot_file_head_t  sboot_head = {
	/* head */
	{
		JUMP_INSTRUCTION,
		TOC0_MAGIC,
		STAMP_VALUE,
		ALIGN_SIZE,
		sizeof(sboot_file_head_t),
		{
			0, 0, 0, 0
		},
		0,
		CFG_SBOOT_RUN_ADDR,
```

`TOC0_MAGIC` 的定义在 `private_toc.h`：

```26:32:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/include/private_toc.h
#define  TOC0_MAGIC             "TOC0.GLH"
#define  TOC_MAIN_INFO_MAGIC    0x89119800

#define  SECURE_SWITCH_OTHER   0
#define  SECURE_SWITCH_NORMAL  1
#define  SECURE_NON_SECUREOS   2
```

这对应打包阶段的：

```text
dragonsecboot -toc0 dragon_toc.cfg keys version_base.mk
```

也就是 `sboot.bin` 会被放进 `toc0.fex` 中，成为安全启动第一阶段。

---

### 3.2 SBoot 主流程

安全启动主函数：

```25:52:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_main.c
void sboot_main(void)
{
	toc0_private_head_t *toc0 = (toc0_private_head_t *)CONFIG_TOC0_HEAD_BASE;
	uint dram_size;
	u16 pmu_type = 0, key_input = 0; /* TODO: set real value */
	int  ret;

	sunxi_board_init_early();
	sunxi_serial_init(toc0_config->uart_port, toc0_config->uart_ctrl, 2);
	print_commit_log();

	ret = sunxi_board_init();
	if(ret)
		goto _BOOT_ERROR;

	if (rtc_probe_fel_flag()) {
		rtc_clear_fel_flag();
		goto _BOOT_ERROR;
#ifdef CFG_SUNXI_PHY_KEY
	} else if (check_update_key(&key_input)) {
		goto _BOOT_ERROR;
#endif
	}
```

和普通路径类似，也会初始化板级、UART、DRAM、MMU：

```54:86:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_main.c
	if (toc0_config->enable_jtag) {
		boot_set_gpio((normal_gpio_cfg *)toc0_config->jtag_gpio, 5, 1);
	}
#if CFG_SUNXI_JTAG_DISABLE
	else {
		sid_disable_jtag();
	}
#endif

	printf("try to probe rtc region\n");

	//dram init
#ifdef FPGA_PLATFORM
	dram_size = mctl_init((void *)toc0_config->dram_para);
#else
	dram_size = init_DRAM(0, (void *)toc0_config->dram_para);
#endif
	if (!dram_size) {
		printf("init dram fail\n");
		goto _BOOT_ERROR;
	}

	char uart_input_value = get_uart_input();

	if (uart_input_value == '2') {
		sunxi_set_printf_debug_mode(3);
```

但后面开始明显不同：

```87:117:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_main.c
	mmu_enable(dram_size);
	malloc_init(CONFIG_HEAP_BASE, CONFIG_HEAP_SIZE);

	ret = sunxi_board_late_init();
	if (ret)
		goto _BOOT_ERROR;

	if (toc0->platform[0] & 0xf0)
		printf("read toc0 from emmc backup\n");

	ret = sunxi_flash_init(toc0->platform[0] & 0x0f);
	if(ret)
		goto _BOOT_ERROR;

	ret = toc1_init();
	if(ret)
		goto _BOOT_ERROR;

	ret = toc1_verify_and_run(dram_size, pmu_type, uart_input_value, key_input);
	if(ret)
		goto _BOOT_ERROR;

_BOOT_ERROR:
	sboot_clear_env();
	boot0_jmp(SECURE_FEL_BASE);
}
```

安全路径不是 `load_package()` / `load_image()`，而是：

```text
sunxi_flash_init()
toc1_init()
toc1_verify_and_run()
```

因此安全启动路径可以概括为：

```text
BootROM / Secure BootROM
  -> toc0.fex
      -> sboot.bin
          -> sunxi_board_init_early()
          -> UART 初始化，参数来自 toc0_config
          -> sunxi_board_init()
          -> 检查 FEL / 按键
          -> 可选 JTAG；否则可禁用 JTAG
          -> init_DRAM()
          -> mmu_enable()
          -> malloc_init()
          -> sunxi_board_late_init()
          -> sunxi_flash_init()
          -> toc1_init()
          -> toc1_verify_and_run()
              -> 读取 toc1.fex
              -> 校验证书链/镜像签名/hash
              -> 加载 monitor/optee/u-boot/scp/dtb 等 item
              -> 跳转到 monitor/optee/u-boot
```

`sboot_toc.h` 也能看到 TOC1 的核心接口：

```15:24:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_toc.h
typedef struct {
	struct sbrom_toc1_item_info *key_certif;
	struct sbrom_toc1_item_info *bin_certif;
	struct sbrom_toc1_item_info *binfile;
	struct sbrom_toc1_item_info *normal;
} sbrom_toc1_item_group;

int toc1_init(void);
uint toc1_item_read(struct sbrom_toc1_item_info *p_toc_item, void * p_dest, u32 buff_len);
```

```26:30:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_toc.h
uint toc1_item_read_rootcertif(void * p_dest, u32 buff_len);
int toc1_item_probe_start(void);
int toc1_item_probe_next(sbrom_toc1_item_group *item_group);
int toc1_verify_and_run(u32 dram_size, u16 pmu_type, u16 uart_input, u16 key_input);
```

虽然 `toc1_init()`、`toc1_verify_and_run()` 的具体实现被编进了平台静态库 `libsun50iw10p1_sboot.a`，源码里没有展开，但函数命名和接口已经说明它的职责：初始化 TOC1、遍历 TOC1 item group、校验并运行。

---

### 3.3 安全证书接口

`sboot_ceritf.h` 中有证书校验接口：

```13:18:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_ceritf.h
#define RSA_BIT_WITDH 2048
int sunxi_certif_pubkey_check( sunxi_key_t  *pubkey );
int sunxi_pubkey_hash_cal(char *out_buf, sunxi_key_t *pubkey);
int sunxi_root_certif_pk_verify(sunxi_certif_info_t *sunxi_certif, u8 *buf, u32 len);
```

这里可以看出安全路径至少包含：

1. RSA 2048 公钥相关逻辑。
2. 公钥 hash 计算。
3. root certificate 公钥校验。

这正是普通 `nboot` 路径里没有的证书链校验逻辑。

---

### 3.4 TOC0 / TOC1 数据结构

`private_toc.h` 定义了 TOC0 和 TOC1 结构。

TOC0 私有头：

```34:56:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/include/private_toc.h
typedef struct {
	u8 name[8];    /*字符串，可以更改，没有作限制 */
	u32 magic;     /*必须是0x89119800 */
	u32 check_sum; /*整个数据的校验和，参考现在boot0做法 */

	u32 serial_num; /*序列号，可以更改，没有限制 */
	u32 status;     /*可以更改，没有限制 */

	u32 items_nr;     /*总的项目个数，对TOC0来说，必须是2 */
	u32 length;       /*TOC0的长度 */
	u8  platform[4];  /*toc_platform[0]标示启动介质 */
			/*0：nand；1：卡0；2：卡2；3：spinor */
	u32 reserved[2];  /*保留位 */
	u32 end;          /*表示头部结构体结束，必须是0x3b45494d */
```

TOC1 头：

```60:79:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/include/private_toc.h
typedef struct sbrom_toc1_head_info
{
	char name[16]	;	//user can modify
	u32  magic	;	//must equal TOC_U32_MAGIC
	u32  add_sum	;

	u32  serial_num	;	//user can modify
	u32  status		;	//user can modify,such as TOC_MAIN_INFO_STATUS_ENCRYP_NOT_USED

	u32  items_nr;	//total entry number
	u32  valid_len;
	u32  version_main;	//only one byte
	u32  version_sub;   //two bytes
	u32  reserved[3];	//reserved for future
```

TOC1 item：

```83:98:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/include/private_toc.h
typedef struct sbrom_toc1_item_info
{
	char name[64];			//such as ITEM_NAME_SBROMSW_CERTIF
	u32  data_offset;
	u32  data_len;
	u32  encrypt;			//0: no aes   //1: aes
	u32  type;				//0: normal file, dont care  1: key certif  2: sign certif 3: bin file
	u32  run_addr;          //if it is a bin file, then run on this address; if not, it should be 0
	u32  index;             //if it is a bin file, this value shows the index to run; if not
	                       //if it is a certif file, it should equal to the bin file index
	                       //that they are in the same group
```

这说明安全路径的二级加载不是简单的 boot package，而是带 item 类型、证书类型、运行地址、加密标志、index 分组关系的 TOC1 容器。

---

### 3.5 当前实际 `dragon_toc.cfg`

你当前打开的 `out/r818-sc3917/image/dragon_toc.cfg` 很关键，它说明安全包中 TOC0 / TOC1 具体包含哪些对象：

```1:23:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/out/r818-sc3917/image/dragon_toc.cfg
[key_rsa]
key=RootKey_Level_0
key=NOTWORLD_KEY
key=PRIMARY_DEBUG_KEY
key=SCPFirmwareContentCertPK
key=SecondaryDebugCertPK
key=SoCFirmwareContentCert_KEY
key=TrustedFirmwareContentCertPK
key=TWORLD_KEY
key=NonTrustedFirmwareContentCertPK


;item=Item_TOC_name,	Item_filename,	Key_Name
[toc0]
item=toc0,		sboot.bin,	RootKey_Level_0

[toc1]
rootkey=rootkey,	rootkey.der,	RootKey_Level_0
item=monitor,		monitor.fex,	TrustedFirmwareContentCertPK
item=optee,		optee.fex,	SoCFirmwareContentCert_KEY
item=u-boot,		u-boot.fex,	NonTrustedFirmwareContentCertPK
item=scp,             scp.fex,        SoCFirmwareContentCert_KEY
onlykey=recovery,       recovery.fex,   SCPFirmwareContentCertPK
onlykey=boot,		boot.fex,	SCPFirmwareContentCertPK
```

后面还有无签名数据项：

```24:30:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/out/r818-sc3917/image/dragon_toc.cfg
onlydata=dtb,		sunxi.fex       NULL
onlydata=board-cfg,	board.fex       NULL
;onlylogo=logo,              bootlogo.bmp.lzma          NULL
;onlylogo=shutdowncharge,    bempty.bmp.lzma            NULL
;onlylogo=androidcharge,    battery_charge.bmp.lzma    NULL
```

这个配置和前面 `pack_img.sh` 里的 `do_signature()` 正好对应：

```text
toc0:
  sboot.bin + RootKey_Level_0

toc1:
  rootkey.der
  monitor.fex
  optee.fex
  u-boot.fex
  scp.fex
  boot.fex 的证书
  recovery.fex 的证书
  dtb / board-cfg 数据
```

所以安全路径的实际固件结构是：

```text
toc0.fex
  └── sboot.bin

toc1.fex
  ├── rootkey.der
  ├── monitor.fex + cert
  ├── optee.fex + cert
  ├── u-boot.fex + cert
  ├── scp.fex + cert
  ├── boot.der
  ├── recovery.der
  ├── sunxi.fex
  └── board.fex
```

---

## 4. U-Boot 侧如何区分安全/非安全路径

U-Boot 里通过 `uboot_spare_head.boot_data` 判断启动模式。

`uboot_spare_head` 的定义：

```25:69:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/arch/arm/cpu/armv7/spare_head.c
struct spare_boot_head_t  uboot_spare_head = 
{
    {
        /* jump_instruction */          
        ( 0xEA000000 | ( ( ( sizeof( struct spare_boot_head_t ) + sizeof( int ) - 1 ) / sizeof( int ) - 2 ) & 0x00FFFFFF ) ),
        UBOOT_MAGIC,
        STAMP_VALUE,
        ALIGN_SIZE,
        0,
        0,
        UBOOT_VERSION,
        UBOOT_PLATFORM,
        {CONFIG_SYS_TEXT_BASE}
    },
    {
        { 0 },		//dram para
        1008,			//run core clock
        1200,			//run core vol
        0,			//uart port
        {             //uart gpio
            {0}, {0}
        },
```

其中 `secureos_exist`、`monitor_exist` 被 SPL/SBoot 填写后，U-Boot 使用这些字段：

```108:118:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/board_common.c
int sunxi_probe_secure_monitor(void)
{
	return uboot_spare_head.boot_data.monitor_exist ==
			       SUNXI_SECURE_MODE_USE_SEC_MONITOR ?
		       1 :
		       0;
}

int sunxi_probe_secure_os(void)
```

```119:122:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/board_common.c
int sunxi_probe_secure_os(void)
{
	return uboot_spare_head.boot_data.secureos_exist;
}
```

安全模式探测逻辑：

```141:178:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/board_common.c
int sunxi_probe_securemode(void)
{
	int secure_mode = 0;

	secure_mode = sunxi_get_secureboard();
	tick_printf("secure enable bit: %d\n", secure_mode);

	if (secure_mode) {
		// sbrom  set  secureos_exist flag,
		// 1: secure os exist 0: secure os not exist
		if (uboot_spare_head.boot_data.secureos_exist == 1) {
			gd->securemode = SUNXI_SECURE_MODE_WITH_SECUREOS;
			debug("secure mode: with secureos\n");
		} else {
			gd->securemode = SUNXI_SECURE_MODE_NO_SECUREOS;
			debug("secure mode: no secureos\n");
		}
		gd->bootfile_mode = SUNXI_BOOT_FILE_TOC;
	} else {
		//boot0  set  secureos_exist flag,
		//1: secure monitor exist 0: secure monitor  not exist
		int burn_secure_mode=0;

		gd->securemode = SUNXI_NORMAL_MODE;
		gd->bootfile_mode = SUNXI_BOOT_FILE_PKG;

		if (get_boot_work_mode() != WORK_MODE_BOOT) {
```

这里可以看出 U-Boot 侧的判断：

| 条件 | U-Boot 行为 |
|---|---|
| secure enable bit 为 1 | `gd->bootfile_mode = SUNXI_BOOT_FILE_TOC` |
| secure enable bit 为 0 | `gd->bootfile_mode = SUNXI_BOOT_FILE_PKG` |
| secure 且 `secureos_exist=1` | `SUNXI_SECURE_MODE_WITH_SECUREOS` |
| secure 且 `secureos_exist=0` | `SUNXI_SECURE_MODE_NO_SECUREOS` |
| normal 模式 | `SUNXI_NORMAL_MODE` |

这也是安全路径和普通路径在 U-Boot 层面的核心区别：

```text
普通启动：bootfile_mode = SUNXI_BOOT_FILE_PKG
安全启动：bootfile_mode = SUNXI_BOOT_FILE_TOC
```

---

## 5. 两条启动路径对比

### 5.1 非安全启动路径

```text
BootROM
  -> boot0_nand.fex / boot0_sdcard.fex / boot0_spinor.fex
      magic = eGON.BT0
      private head = boot0_private_head_t
      参数来自 BT0_head.prvt_head
      初始化 UART / DRAM / 存储
      load_package()
      load_image()
      update_uboot_info()
      跳转到：
        opensbi / monitor / optee / rtos / u-boot
  -> U-Boot
      bootfile_mode = SUNXI_BOOT_FILE_PKG
      securemode = SUNXI_NORMAL_MODE
```

### 5.2 安全启动路径

```text
Secure BootROM
  -> toc0.fex
      magic = TOC0.GLH
      item = sboot.bin
      root key = RootKey_Level_0
      参数来自 toc0_config
  -> sboot.bin
      初始化 UART / DRAM / 存储
      使用 eFuse / CE / key provision / item hash
      sunxi_flash_init()
      toc1_init()
      toc1_verify_and_run()
          读取 toc1.fex
          读取 rootkey.der
          校验 key cert / bin cert
          校验 monitor/optee/u-boot/scp 等 item
          加载并运行可信启动链中下一阶段
  -> monitor / OP-TEE / U-Boot
  -> U-Boot
      bootfile_mode = SUNXI_BOOT_FILE_TOC
      securemode = SUNXI_SECURE_MODE_WITH_SECUREOS
             或 SUNXI_SECURE_MODE_NO_SECUREOS
```

---

## 6. 安全路径比非安全路径多了哪些内容

### 6.1 多了 `toc0.fex` / `toc1.fex` 容器格式

普通路径使用：

```text
boot0_xxx.fex + boot_package.fex
```

安全路径使用：

```text
toc0.fex + toc1.fex
```

`TOC0` 负责安全第一阶段，里面包含 `sboot.bin`；`TOC1` 负责后续镜像和证书。

---

### 6.2 第一阶段从 `boot0` 变成 `sboot`

普通启动：

```text
BootROM -> boot0
```

安全启动：

```text
Secure BootROM -> toc0 -> sboot
```

普通文件头 magic：

```text
eGON.BT0
```

安全文件头 magic：

```text
TOC0.GLH
```

---

### 6.3 多了证书链和公钥校验

安全路径多了：

```text
rootkey.der
key certificate
bin certificate
RSA 2048
public key hash
root certificate public key verify
```

相关接口：

```15:18:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_ceritf.h
#define RSA_BIT_WITDH 2048
int sunxi_certif_pubkey_check( sunxi_key_t  *pubkey );
int sunxi_pubkey_hash_cal(char *out_buf, sunxi_key_t *pubkey);
int sunxi_root_certif_pk_verify(sunxi_certif_info_t *sunxi_certif, u8 *buf, u32 len);
```

普通 `nboot` 路径中没有看到这类证书校验入口。

---

### 6.4 多了 eFuse / ROTPK / 安全位判断

`sboot.mk` 启用了：

```text
CFG_SUNXI_EFUSE=y
CFG_SUNXI_KEY_PROVISION=y
```

U-Boot 也会读取 secure enable bit：

```145:149:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/board_common.c
	secure_mode = sunxi_get_secureboard();
	tick_printf("secure enable bit: %d\n", secure_mode);

	if (secure_mode) {
		// sbrom  set  secureos_exist flag,
```

安全路径依赖芯片安全位和 eFuse 里的根公钥 hash / ROTPK 等信息，普通路径不要求这些校验。

---

### 6.5 多了 CE 加密引擎支持

`sboot.mk` 打开：

```text
CFG_SUNXI_CE_21=y
```

这通常用于 hash、RSA、AES 等安全运算加速或硬件安全计算。普通 `mmc.mk` / `nand.mk` 没有开启这个安全配置。

---

### 6.6 多了 TOC1 item 的分组、证书和类型管理

TOC1 item 带有：

```text
name
data_offset
data_len
encrypt
type
run_addr
index
```

其中 `type` 支持：

```text
normal file
key certif
sign certif
bin file
```

普通路径的 boot package 加载没有这种严格的证书 item 分组校验模型。

---

### 6.7 多了对 `monitor`、`optee`、`scp`、`u-boot` 的分项签名

从你当前的 `dragon_toc.cfg` 看，安全固件中这些组件分别由不同 key 签名：

```text
monitor.fex -> TrustedFirmwareContentCertPK
optee.fex   -> SoCFirmwareContentCert_KEY
u-boot.fex  -> NonTrustedFirmwareContentCertPK
scp.fex     -> SoCFirmwareContentCert_KEY
boot.fex    -> SCPFirmwareContentCertPK
recovery.fex -> SCPFirmwareContentCertPK
```

普通启动虽然也可能加载 `monitor` / `optee` / `u-boot`，但不是通过 `toc1_verify_and_run()` 这一套证书链验证流程。

---

### 6.8 多了 `boot.fex` / `recovery.fex` 的证书追加

这部分在前面 `do_pack_tina()` / `do_signature()` 已经看到：

```text
sigbootimg --image boot.fex --cert toc1/cert/boot.der --output boot_sig.fex
sigbootimg --image recovery.fex --cert toc1/cert/recovery.der --output recovery_sig.fex
```

也就是说安全路径不仅校验 SPL 后面的 `u-boot/optee/monitor/scp`，还会为内核启动镜像 `boot.fex`、`recovery.fex` 生成并追加证书。

---

### 6.9 多了安全失败后的 `SECURE_FEL_BASE`

普通路径失败后跳到：

```97:108:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
	}
	else
		boot0_jmp(uboot_base);

	while(1);
_BOOT_ERROR:
	boot0_clear_env();
	boot0_jmp(FEL_BASE);

}
```

安全路径失败后跳到：

```111:118:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_main.c
	ret = toc1_verify_and_run(dram_size, pmu_type, uart_input_value, key_input);
	if(ret)
		goto _BOOT_ERROR;

_BOOT_ERROR:
	sboot_clear_env();
	boot0_jmp(SECURE_FEL_BASE);
}
```

普通失败进入 `FEL_BASE`，安全失败进入 `SECURE_FEL_BASE`。这说明安全启动失败后的异常路径也不同。

---

### 6.10 多了 JTAG 禁用逻辑

安全路径中：

```54:61:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_main.c
	if (toc0_config->enable_jtag) {
		boot_set_gpio((normal_gpio_cfg *)toc0_config->jtag_gpio, 5, 1);
	}
#if CFG_SUNXI_JTAG_DISABLE
	else {
		sid_disable_jtag();
	}
#endif
```

普通路径中只是根据 `enable_jtag` 打开 JTAG，没有看到对应的 `sid_disable_jtag()` 安全禁用逻辑：

```42:45:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
	} else if (BT0_head.prvt_head.enable_jtag) {
		printf("enable_jtag\n");
		boot_set_gpio((normal_gpio_cfg *)BT0_head.prvt_head.jtag_gpio, 5, 1);
	}
```

这也是安全路径额外的调试口管控。

---

## 7. 最终结论

### 非安全启动链路

```text
BootROM
  -> boot0_xxx.fex
  -> boot_package.fex
  -> U-Boot / OP-TEE / Monitor
  -> Kernel
```

核心特征：

- 使用 `eGON.BT0` 格式 Boot0。
- 按介质区分 `boot0_nand`、`boot0_sdcard`、`boot0_spinor`。
- 通过 `load_package()` / `load_image()` 加载二级启动包。
- U-Boot 侧 `bootfile_mode = SUNXI_BOOT_FILE_PKG`。
- 不走 TOC0/TOC1 证书链校验。

### 安全启动链路

```text
Secure BootROM
  -> toc0.fex
      -> sboot.bin
  -> toc1.fex
      -> rootkey.der
      -> monitor.fex + cert
      -> optee.fex + cert
      -> u-boot.fex + cert
      -> scp.fex + cert
      -> boot/recovery cert
      -> dtb/board-cfg
  -> Monitor / OP-TEE / U-Boot
  -> Kernel
```

核心特征：

- 使用 `TOC0.GLH` / TOC 格式。
- 第一阶段是 `sboot.bin`，不是普通 `boot0`。
- 通过 `toc1_init()` / `toc1_verify_and_run()` 加载和验证后续镜像。
- 引入 RSA、公钥 hash、root cert、bin cert、item hash。
- 引入 eFuse / ROTPK / secure enable bit。
- U-Boot 侧 `bootfile_mode = SUNXI_BOOT_FILE_TOC`。
- 可区分 `SUNXI_SECURE_MODE_WITH_SECUREOS` 和 `SUNXI_SECURE_MODE_NO_SECUREOS`。
- 失败进入 `SECURE_FEL_BASE`。
- 可禁用 JTAG。
- boot/recovery/rootfs 等后续镜像也可参与证书校验。

