
**User**

fes.fex是什么？结合https://linux-sunxi.org/FES 
分析一下，为什么烧录必须执行fes初始化dram？boot0不是负责初始化dram的吗

---

**Cursor**

我会结合本地 `pack` 配置、`fes1.fex` 的来源，以及 linux-sunxi 对 FES 的说明来解释它和 Boot0 的分工。

搜索结果没直接命中该页面，我会换一个查询方式确认 FES/FEL 页面中的关键描述。

我会再从本地源码里找 `fes1` 的构建和入口代码，以便把 “FES 初始化 DRAM” 和 SDK 实际文件对应起来。

我再直接打开该页面确认页面文字，以免只凭记忆解释。

`fes1.fex` 是 **Allwinner FES/FEL USB 烧录链路中的第一阶段小程序**。它的核心作用不是正常启动 Linux，而是：**在 FEL 模式下由 PC 通过 USB 下载到 SoC 内部 SRAM 执行，初始化 DRAM，然后让后续更大的 USB 烧录程序/u-boot 能被加载到 DRAM 中运行**。

你问的关键点是：

> Boot0 不是负责初始化 DRAM 吗？为什么烧录还必须执行 FES 初始化 DRAM？

答案是：**正常从 Flash/SD 启动时，是 Boot0 初始化 DRAM；但 USB 烧录/FEL 模式下，Boot0 通常根本没有被执行成功，或者被刻意绕开，所以必须由 FES 小程序来初始化 DRAM。**

---

## 1. `fes1.fex` 是什么？

从 linux-sunxi 的 FES 页面描述看，FES 是 LiveSuit/PhoenixSuit 使用的低层 USB 烧录接口，工作在 FEL 之上。它的 Boot 2.0 流程是：

1. 先进入 FEL 模式；
2. PC 通过 FEL 把 `fes1.fex` 写到 SRAM 地址 `0x2000`；
3. 执行 `0x2000`；
4. 如果成功，就可以访问设备 DRAM；
5. 再把 `u-boot.fex` 写到 DRAM，例如 `0x4a000000`；
6. 设置 u-boot 工作模式为 USB/FES 模式；
7. 跳转执行 u-boot；
8. 后续通过 FES 命令完成 Flash/SD/eMMC 擦写。

linux-sunxi 页面原文核心意思是：

```text
FES is a low-level USB interface used by LiveSuit to flash firmware to the device.
It works on top of FEL. Thus you must activate FEL mode first, then you can enter FES mode using FEL commands.
```

Boot 2.0 流程中也明确写了：

```text
Write fes1.fex at 0x2000
Execute code at 0x2000. If everything goes well you can access device's DRAM
Write u-boot.fex at 0x4a000000
Set work mode of u-boot to USB mode
Execute code at 0x4a000000
```

所以 `fes1.fex` 的本质是：

```text
FEL 模式下运行在 SRAM 中的 DRAM 初始化小程序
```

不是 Linux kernel，不是普通 bootloader，也不是最终烧录到 boot 分区的东西。

---

## 2. SDK 里 `fes1.fex` 从哪里来？

在 `pack_img.sh` 中，`fes1.fex` 是从板级 boot bin 目录拷贝出来的：

```294:304:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
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
```

也就是说：

```text
device/config/chips/r818/.../fes1_r818.bin
  -> out/r818-sc3917/image/fes1.fex
```

然后 `image.cfg` 里把它作为最终烧录包 item 放进去：

```61:69:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/out/r818-sc3917/image/image.cfg
    ;-->boot文件
    {filename = "boot0_nand.fex",   maintype = ITEM_BOOT,         subtype = "BOOT0_0000000000",},
    {filename = "boot0_sdcard.fex", maintype = "12345678",        subtype = "1234567890BOOT_0",},
    {filename = "u-boot.fex",       maintype = "12345678",        subtype = "UBOOT_0000000000",},
    {filename = "u-boot-crash.fex", maintype = "12345678",        subtype = "UBOOT_CRASH_0000",},
    {filename = "toc1.fex",         maintype = "12345678",        subtype = "TOC1_00000000000",},
    {filename = "toc0.fex",         maintype = "12345678",        subtype = "TOC0_00000000000",},
    {filename = "fes1.fex",         maintype = ITEM_FES,          subtype = "FES_1-0000000000",},
    {filename = "boot_package.fex", maintype = "12345678",        subtype = "BOOTPKG-00000000",},
```

`maintype = ITEM_FES`，`subtype = "FES_1-0000000000"`，说明它就是烧录工具识别的 FES 阶段程序。

---

## 3. `fes1.fex` 自己做了什么？

源码在：

`lichee/brandy-2.0/spl/fes/main/fes1_main.c`

核心逻辑很直接：

```1:48:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/fes/main/fes1_main.c
/*
 * (C) Copyright 2018
 * wangwei <wangwei@allwinnertech.com>
 */

#include <common.h>
#include <private_boot0.h>
#include <private_uboot.h>
#include <private_toc.h>
#include <arch/clock.h>
#include <arch/uart.h>
#include <arch/dram.h>



static void  note_dram_log(int dram_init_flag);


int main(void)
{
	int dram_size=0;
	int status;

	sunxi_serial_init(fes1_head.prvt_head.uart_port, (void *)fes1_head.prvt_head.uart_ctrl, 2);
	printf("fes begin commit:%s\n", fes1_head.hash);
	status = sunxi_board_init();
	if(status)
		return 0;

	printf("beign to init dram\n");
#ifdef FPGA_PLATFORM
	dram_size = mctl_init((void *)fes1_head.prvt_head.dram_para);
#else
	dram_size = init_DRAM(0, (void *)fes1_head.prvt_head.dram_para);
#endif

	if (dram_size){
		note_dram_log(1);
		printf("init dram ok\n");
	} else {
```

然后：

```49:61:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/fes/main/fes1_main.c
		note_dram_log(0);
		printf("init dram fail\n");
#ifdef CFG_ARCH_RISCV
		asm volatile("j .");
#else
		asm volatile("b .");
#endif
	}

	mdelay(10);

	return dram_size;
}
```

可以看到 `fes1.fex` 的主体就是：

```text
初始化串口
初始化板级基础资源
初始化 DRAM
记录 DRAM 参数和结果
返回 dram_size
```

它不像 Boot0 那样继续加载 boot package、校验 toc、跳转 u-boot。它只负责把内存环境准备好。

---

## 4. Boot0 不是也初始化 DRAM 吗？

是的。正常启动时 Boot0 确实负责初始化 DRAM。

你打开的 `boot0_main.c` 里就有：

```21:54:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
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
```

DRAM 初始化在这里：

```55:65:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
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
```

所以你的理解没有错：**正常启动路径确实由 Boot0 初始化 DRAM**。

---

## 5. 那为什么烧录时还要 FES 初始化 DRAM？

因为烧录路径不是正常启动路径。

### 正常启动路径

```text
BROM / BootROM
  -> 从 NAND/eMMC/SD 读取 boot0
  -> 执行 boot0
       -> 初始化 DRAM
       -> 读取 boot_package / u-boot / toc1
       -> 跳转 u-boot
  -> u-boot
  -> kernel
```

这时 Boot0 会初始化 DRAM。

---

### USB 烧录路径

```text
BROM / BootROM
  -> 进入 FEL USB 模式
  -> PC 通过 USB 下载 fes1.fex 到 SRAM
  -> 执行 fes1.fex
       -> 初始化 DRAM
  -> PC 下载 u-boot.fex 到 DRAM
  -> 执行 u-boot.fex，进入 FES/烧录工作模式
  -> PC 通过 FES 命令写 Flash/eMMC/NAND
```

在这个路径下，Boot0 没有从 Flash 成功启动。常见原因包括：

- 板子是空片，没有 boot0；
- boot0 损坏；
- 用户按键/工具让芯片进入 FEL；
- RTC/FEL flag 触发；
- 烧录工具主动要求进入 USB 下载模式；
- secure/量产流程中需要先通过 USB 下载临时程序。

此时 SoC 刚进 FEL 时只有 BootROM 和片内 SRAM 可用，外部 DRAM 还没有初始化。

而 `u-boot.fex` 通常很大，不能只放在 SRAM 里执行，必须先有 DRAM。所以需要：

```text
fes1.fex 先初始化 DRAM
u-boot.fex 再加载到 DRAM 运行
```

这就是 FES 初始化 DRAM 的原因。

---

## 6. BootROM/FEL 为什么不直接初始化 DRAM？

因为 BootROM 是芯片内部固化代码，它通常不知道你板子的具体 DRAM 参数。

DRAM 初始化依赖板级参数，例如：

```text
dram_clk
dram_type
dram_zq
dram_odt_en
dram_para
dram_tpr0...
```

这些参数和板子的 DDR 型号、走线、容量、频率有关，不可能全部固化在 BootROM 里。

所以 BootROM/FEL 只能做非常基础的事情：

```text
USB 通信
SRAM 读写
执行 SRAM 中的小程序
```

它不能可靠地直接初始化外部 DRAM。

因此 Allwinner 的做法是：

```text
PC 通过 FEL 下载一个带有板级 DRAM 参数的小程序 fes1.fex
让 fes1.fex 初始化 DRAM
```

这也是 linux-sunxi 页面说 “Boot 2.0 需要 `fes1.fex` 和 `u-boot.fex`” 的原因。

---

## 7. FES 和 Boot0 都初始化 DRAM，会不会重复？

不会在同一个启动路径里重复。

### 正常启动

执行的是：

```text
Boot0 初始化 DRAM
```

一般不会执行 `fes1.fex`。

### FEL/烧录启动

执行的是：

```text
fes1.fex 初始化 DRAM
```

一般不会执行正常 Flash 中的 Boot0。

也就是说：

```text
Boot0 和 FES 都有 DRAM 初始化代码
但它们服务于不同启动路径
```

它们不是“正常启动时 Boot0 初始化后又 FES 初始化一次”。

---

## 8. 为什么 Boot0 出错会跳到 FEL？

你的 `boot0_main.c` 里也能看到：

```83:102:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
	status = sunxi_board_late_init();
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
```

出错路径：

```103:115:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
	if (opensbi_base) {
			boot0_jmp_opensbi(opensbi_base, uboot_base);
	} else if (monitor_base) {
		struct spare_monitor_head *monitor_head =
			(struct spare_monitor_head *)((phys_addr_t)monitor_base);
		monitor_head->secureos_base = optee_base;
		boot0_jmp_monitor(monitor_base);
	} else if (optee_base)
		boot0_jmp_optee(optee_base, uboot_base);
	else if (rtos_base) {
		printf("jump to rtos\n");
```

最后 `_BOOT_ERROR` 是：

```116:125:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
	else
		boot0_jmp(uboot_base);

	while(1);
_BOOT_ERROR:
	boot0_clear_env();
	boot0_jmp(FEL_BASE);

}
```

也就是说，Boot0 正常启动失败时也会跳到 `FEL_BASE`，让 PC 工具接管。

但注意：如果 Boot0 已经执行到这个阶段，DRAM 可能已经初始化过；如果是 BootROM 直接进入 FEL，DRAM 没有初始化。为了统一和安全，烧录工具仍然按自己的 FES 流程下载 `fes1.fex`，确保 DRAM 状态是它期望的。

---

## 9. 安全启动 `sboot` 也类似

你打开的 `sboot_main.c` 也有 DRAM 初始化：

```37:68:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_main.c
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
```

继续：

```55:74:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_main.c
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
```

出错时跳到 secure FEL：

```110:125:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_main.c
_BOOT_ERROR:
	sboot_clear_env();
	boot0_jmp(SECURE_FEL_BASE);
}

static int sboot_clear_env(void)
{
	sunxi_board_exit();
	sunxi_board_clock_reset();
	mmu_disable();
	mdelay(10);
	return 0;
}
```

说明安全启动链也是：

```text
正常启动：sboot/boot0 初始化 DRAM
烧录/恢复：跳到 FEL/secure FEL 后，由 USB 下载阶段接管
```

---

## 10. 一句话总结

`fes1.fex` 是 **FEL USB 烧录阶段运行在 SRAM 中的 DRAM 初始化程序**。

Boot0 也初始化 DRAM，但它用于：

```text
正常从 Flash/SD/eMMC 启动
```

而 `fes1.fex` 用于：

```text
BootROM/FEL USB 烧录启动
```

烧录时必须执行 `fes1.fex` 初始化 DRAM，是因为：

```text
刚进入 FEL 时只有 SRAM 可用，DRAM 未初始化；
后续 u-boot.fex 和烧录逻辑太大，必须放到 DRAM；
Boot0 在 FEL 烧录路径中通常没有被执行或不能依赖；
所以需要 fes1.fex 先把 DRAM 初始化起来。
```

可以把它们理解为同一功能在两条链路中的两个实现：

```text
正常启动链：Boot0 / sboot 初始化 DRAM
USB 烧录链：FES1 初始化 DRAM
```

