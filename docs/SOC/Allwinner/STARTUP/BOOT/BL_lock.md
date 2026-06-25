# Secure boot and non-secure boot paths
_Exported on 2026/5/14 at GMT+8 1:47:34 from Cursor (2.6.21)_

---

**User**

结合帮我找一下lichee/brandy-2.0中spl、uboot的相关内容，找出安全启动与非安全启动路径，并解释一下为什么我Android设备显示开启了secure enable bit(但没有烧 ROTPK)，仍然能启动修改后的内核boot.img镜像？是有什么特殊分支吗？

---

**Cursor**

我会先在 `lichee/brandy-2.0` 和打包脚本里定位 SPL、U-Boot、secure boot 相关分支，然后梳理启动路径和你提到的 “secure enable bit 已开但未烧 ROTPK 仍能启动改过的 boot.img” 的原因。

目录列表接口没有返回可用结果，我改用文件名与内容搜索来定位。

需要继续看打包脚本安全分支和 U-Boot Android 启动验证相关文件。

我看了一下这个 SDK 里的 `lichee/brandy-2.0`，这里确实有两套启动链路：普通 `nboot/boot0 + boot_package`，以及安全 `sboot/toc0 + toc1`。你遇到的现象核心原因是：**secure enable bit 只让 BootROM/SBROM 走安全启动入口，但 Android `boot.img` 是否被拒绝，还取决于 U-Boot 里的 verified boot 分支、lock 状态、AVB/vbmeta 或 boot cert/hash 是否配置完整；未烧 ROTPK 时，信任根通常没有闭环，某些分支会退化成 orange/unlocked 或仅上报状态，不会阻止修改后的 boot.img。**

## 1. 非安全启动路径

非安全路径对应 `spl/nboot`，入口是 `boot0_main.c`。

关键流程：

```1:93:lichee/brandy-2.0/spl/nboot/main/boot0_main.c
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

	// ... DRAM/init/misc ...

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
```

非安全启动大致是：

```text
BROM
  -> boot0_nand.fex / boot0_sdcard.fex
  -> load_package()
  -> boot_package.fex
  -> U-Boot / OP-TEE / monitor / RTOS
  -> U-Boot 加载 boot.img
  -> kernel
```

打包脚本中普通分支会生成 `boot0_*` 和 `boot_package.fex`：

```1185:1210:scripts/pack_img.sh
	else
		update_boot0 boot0_nand.fex     sys_config.bin NAND > /dev/null
		update_boot0 boot0_sdcard.fex   sys_config.bin SDMMC_CARD > /dev/null
		echo update_chip
		update_chip boot0_nand.fex >/dev/null
		update_chip boot0_sdcard.fex >/dev/null
	fi

	// ...

	if [ -f boot_package.cfg ]; then
			echo "pack boot package"
			busybox unix2dos boot_package.cfg
			dragonsecboot -pack boot_package.cfg
			if [ $? -ne 0 ]
			then
				pack_error "dragon pack run error"
				exit 1
			fi
	fi
```

## 2. 安全启动路径

安全路径对应 `spl/sboot`，入口是 `sboot_main.c`。

关键流程：

```35:107:lichee/brandy-2.0/spl/sboot/main/sboot_main.c
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

	// ... DRAM/init/misc ...

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

安全启动大致是：

```text
SBROM / secure BROM
  -> toc0.fex / sboot.bin
  -> toc1_init()
  -> toc1_verify_and_run()
  -> toc1.fex 中的 root cert / u-boot / optee / monitor 等
  -> U-Boot
  -> U-Boot 再决定是否验证 Android boot.img
  -> kernel
```

打包脚本里 `-s secure` 会走 `do_signature()`，生成/更新 `toc0.fex`、`toc1.fex`，并给 `boot.fex` 追加证书：

```1524:1629:scripts/pack_img.sh
function do_signature()
{
	# merge flag: '1' - merge atf/scp/uboot/optee in one package, '0' - do not merge.
	local merge_flag=0

	printf "prepare for signature by openssl\n"

	// ... 选择 dragon_toc.cfg ...

	rm -f cardscript.fex
	mv cardscript_secure.fex cardscript.fex
	if [ $? -ne 0 ]
	then
		pack_error "dragon cardscript_secure.fex file is not exist"
		exit 1
	fi

	if [ ! -d ${ROOT_DIR}/keys ]; then
		echo ""
		pack_error "No key exist, please run './scripts/createkeys' to generate keys first."
		exit 1
	fi

	update_chip sboot.bin > /dev/null
	dragonsecboot -toc0 dragon_toc.cfg ${ROOT_DIR}/keys ${ROOT_DIR}/image/version_base.mk
	if [ $? -ne 0 ]
	then
		pack_error "dragon toc0 run error"
		exit 1
	fi

	update_toc0  toc0.fex           sys_config.bin

	// ...

	dragonsecboot -toc1 dragon_toc.cfg ${ROOT_DIR}/keys \
		${CNF_BASE_FILE} \
		${ROOT_DIR}/image/version_base.mk
	if [ $? -ne 0 ]
	then
		pack_error "dragon toc1 run error"
		exit 1
	fi

	local correct_boot_img_magic=$(echo -n "ANDROID!" | md5sum | cut -d " " -f 1)

	local boot_fex_magic=$(dd if=boot.fex bs=1 count=8 | md5sum | cut -d " " -f 1)
	if [ x$correct_boot_img_magic != x$boot_fex_magic ] ; then
		pack_error "boot.fex format error, magic not ANDROID!"
		exit 1
	fi

	sigbootimg --image boot.fex --cert toc1/cert/boot.der --output boot_sig.fex
	if [ $? -ne 0 ] ; then
		pack_error "Pack cert to image error"
		exit 1
	else
		mv -f boot_sig.fex boot.fex
	fi
```

最终 tar 分支也能看出普通和安全产物不同：

```1835:1842:scripts/pack_img.sh
	if [ "x${PACK_SIG}" = "xsecure" ];then
		tar_boot_file="./image/boot0_nand.fex ./image/toc0.fex ./image/toc1.fex"
	else
		tar_boot_file="./image/boot0_nand.fex ./image/boot_package.fex"
	fi
```

注意这里安全包仍然可能带 `boot0_nand.fex`，但真正安全链路核心是 `toc0.fex/toc1.fex`，而不是普通 `boot_package.fex`。

## 3. U-Boot 如何判断 secure mode

U-Boot 在 `board_init()` 里调用 `sunxi_probe_securemode()`：

```150:156:lichee/brandy-2.0/u-boot-2018/board/sunxi/board.c
int sunxi_plat_init(void)
{
	sunxi_probe_securemode();
#ifdef CONFIG_SUNXI_DMA
	sunxi_dma_init();
#endif
```

`sunxi_probe_securemode()` 会读取 secure enable bit，然后设置 `gd->securemode` 和 `gd->bootfile_mode`：

```130:187:lichee/brandy-2.0/u-boot-2018/board/sunxi/board_common.c
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
			debug("check if downloading secure img\n");
			if (script_parser_fetch("/soc/target",
						"burn_secure_mode",
						&burn_secure_mode, 1))
				burn_secure_mode = uboot_spare_head.boot_data.secure_mode;

			if (burn_secure_mode != 1) {
				return 0;
			}
			printf("normal mode: download secure firmware\n");
			gd->bootfile_mode = SUNXI_BOOT_FILE_TOC;
		}
	}
	return 0;
}
```

所以你看到的 `secure enable bit: 1` 基本说明：**U-Boot 读到 eFuse/安全寄存器的 secure mode bit 已经置位，因此 `gd->securemode != SUNXI_NORMAL_MODE`。**

但这还不等价于 “Android boot.img 一定会被强制验签且失败即拒绝”。拒绝 boot.img 的逻辑在另一个地方。

## 4. Android boot.img 验证路径

Android 启动验证在 `sunxi_android_boot()`：

```76:211:lichee/brandy-2.0/u-boot-2018/board/sunxi/android/sunxi_android_boot.c
int sunxi_android_boot(const char *image_name, ulong os_load_addr)
{
	uint count		= 0;
	uint wait_for_power_key = 1;
	if (gd->securemode) {
		/* ORANGE, indicating a device may be freely modified.
		 * Device integrity is left to the user to verify out-of-band.
		 * The bootloader displays a warning to the user before allowing
		 * the boot process to continue.*/
		if (gd->lockflag == SUNXI_UNLOCKED) {
			sunxi_set_verify_boot_number(SUNXI_VB_INFO_LOCK, 0);
			sunxi_set_verify_boot_number(
				SUNXI_VB_INFO_BOOTSTATE,
				KM_VERIFIED_BOOT_UNVERIFIED);
			env_set("verifiedbootstate", "orange");
			pr_msg("Your device software can't be checked for corruption.\n");
			pr_msg("Please lock the bootloader.\n");
			sunxi_bmp_display("orange_warning.bmp");
#ifdef CONFIG_SUNXI_AVB
			android_vbmeta_avb_verify("unlocked");
#endif
			do {
				// ...
			} while (count < 5);
			// ...
		} else {
			int ret;
			sunxi_set_verify_boot_number(SUNXI_VB_INFO_LOCK, 1);
#ifndef CONFIG_SUNXI_AVB
			ret = sunxi_verify_os(os_load_addr, image_name);
#else
			if (!android_vbmeta_avb_verify("locked")) {
				ret = sunxi_verify_os(os_load_addr, image_name);
			} else {
				// 通过 vbmeta 验 boot.img
				ret = verify_image_by_vbmeta(
						image_name,
						(uint8_t *)os_load_addr,
						total_len, vb_meta_data, vb_len,
						"vbmeta");
			}
#endif /*CONFIG_SUNXI_AVB*/

			// ...

			if (ret) {
				pr_msg("boota: verify the %s failed\n",
				       image_name);
				env_set("verifiedbootstate", "red");
				sunxi_set_verify_boot_number(SUNXI_VB_INFO_BOOTSTATE, KM_VERIFIED_BOOT_FAILED);
				pr_msg("Your device is corrupt.It can't be truseted and will not boot.\n");
				sunxi_bmp_display("red_warning.bmp");
				mdelay(30000);
				sunxi_board_shutdown();
				return -1;
			}
		}
	}
#ifdef CONFIG_SUNXI_AVB
	else {
		// 非 securemode 下，有 vbmeta 也只是 setup AVB info
	}
#endif

	return 0;
}
```

这里分支非常关键：

### securemode = 1 且 `gd->lockflag == SUNXI_UNLOCKED`

走 orange 分支：

```text
securemode = 1
  lockflag = UNLOCKED
    -> verifiedbootstate=orange
    -> 可自由修改
    -> 不调用 sunxi_verify_os() 强制拒绝 boot.img
```

这能直接解释一种情况：**设备显示 secure enable bit 开启，但 bootloader 是 unlocked/orange 状态，修改 boot.img 仍然能启动。**

### securemode = 1 且 `gd->lockflag != SUNXI_UNLOCKED`

走 locked 分支：

```text
securemode = 1
  lockflag = locked
    -> CONFIG_SUNXI_AVB 未开：sunxi_verify_os(boot)
    -> CONFIG_SUNXI_AVB 已开：
         先 android_vbmeta_avb_verify("locked")
         若 vbmeta AVB 不成立，则退回 sunxi_verify_os(boot)
         若 vbmeta AVB 成立，则 verify_image_by_vbmeta(boot)
    -> ret != 0 才 red 并关机/拒绝
```

所以只有 locked 分支才会强制验 boot.img 并在失败时停机。

## 5. boot.img 的非 AVB 验证机制

非 AVB 或 fallback 时走 `sunxi_verify_os()`：

```17:57:lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
int sunxi_verify_os(ulong os_load_addr, const char *cert_name)
{
	struct blk_desc *desc;
	disk_partition_t info = { 0 };
	ulong total_len = 0;
	ulong sign_data, sign_len;
	int ret;
	struct andr_img_hdr *fb_hdr = (struct andr_img_hdr *)os_load_addr;

#ifdef CONFIG_SUNXI_SWITCH_SYSTEM
	char *part_name = env_get("boot_partition");
#else
	const char *part_name = cert_name;
#endif

	desc = blk_get_devnum_by_typename("sunxi_flash", 0);
	if (desc == NULL)
		return -ENODEV;

	ret = sunxi_flash_try_partition(desc, part_name, &info);
	if (ret < 0)
		return -ENODEV;

	total_len = android_image_get_end(fb_hdr) - (ulong)fb_hdr;

	pr_msg("kernel len:%ld, part len:%ld\n", total_len, info.size * 512);
	if (total_len > info.size * 512) {
		pr_err("invalid kernel len\n");
		return -1;
	}
	if (android_image_get_signature(fb_hdr, &sign_data, &sign_len))
		ret = sunxi_verify_embed_signature((void *)os_load_addr,
						   (unsigned int)total_len,
						   cert_name, (void *)sign_data,
						   sign_len);
	else
		ret = sunxi_verify_signature((void *)os_load_addr,
					     (unsigned int)total_len,
					     cert_name);
	return ret;
}
```

有两种验法：

1. `boot.img` 后面附带了 Allwinner cert：`sunxi_verify_embed_signature()`
2. 没附带 cert：`sunxi_verify_signature()`，让 OP-TEE / rootcert 检查 hash

嵌入证书分支会校验 boot hash，再检查公钥是否在 rootcert 中：

```127:189:lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
static int sunxi_verify_embed_signature(void *buff, uint len,
					const char *cert_name, void *cert,
					unsigned cert_len)
{
	u8 hash_of_file[32];
	int ret;
	sunxi_certif_info_t sub_certif;
	void *cert_buf;

	// ...

	sunxi_ss_open();
	ret = sunxi_sha_calc(hash_of_file, 32, buff, len);
	if (ret) {
		printf("sunxi_verify_signature err: calc hash failed\n");
		goto __ERROR_END;
	}
	if (sunxi_certif_verify_itself(&sub_certif, cert_buf, cert_len)) {
		printf("%s error: cant verify the content certif\n", __func__);
		printf("cert dump\n");
		sunxi_dump(cert_buf, cert_len);
		goto __ERROR_END;
	}

	if (memcmp(hash_of_file, sub_certif.extension.value[0], 32)) {
		printf("hash compare is not correct\n");
		printf(">>>>>>>hash of file<<<<<<<<<<\n");
		sunxi_dump(hash_of_file, 32);
		printf(">>>>>>>hash in certif<<<<<<<<<<\n");
		sunxi_dump(sub_certif.extension.value[0], 32);
		goto __ERROR_END;
	}

	/*Approvel certificate by trust-chain*/
	if (check_public_in_rootcert(cert_name, &sub_certif)) {
		printf("check rootpk[%s] in rootcert fail\n", cert_name);
		goto __ERROR_END;
	}
```

普通 hash 分支则调用 TEE 检查 hash：

```191:226:lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
static int sunxi_verify_signature(void *buff, uint len, const char *cert_name)
{
	u8 hash_of_file[32];
	int ret;

	memset(hash_of_file, 0, 32);
	sunxi_ss_open();
	ret = sunxi_sha_calc(hash_of_file, 32, buff, len);
	if (ret) {
		printf("sunxi_verify_signature err: calc hash failed\n");
		//sunxi_ss_close();

		return -1;
	}
	//sunxi_ss_close();
	pr_msg("show hash of file\n");

	ret = smc_tee_check_hash(cert_name, hash_of_file);
	if (ret == 0xFFFF000F) {
		sunxi_dump(hash_of_file, 32);
		pr_err("optee return hash invalid\n");
		return -1;
	} else if (ret == 0) {
		pr_msg("image %s hash valid\n", cert_name);
		// ...
		return 0;
	} else {
		sunxi_dump(hash_of_file, 32);
		pr_err("image %s hash not found\n", cert_name);
		return -1;
	}
}
```

## 6. ROTPK 在这里起什么作用

ROTPK 相关逻辑在 `board_common.c` 和 `sunxi_image_verifier.c`。

`sunxi_verify_get_rotpk_hash()` 从 toc1 root cert 算出 root public key hash：

```249:279:lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
int sunxi_verify_get_rotpk_hash(void *hash_buf)
{
	struct sbrom_toc1_item_info *toc1_item;
	sunxi_certif_info_t root_certif;
	u8 *buf;
	int ret;
	void *toc1_base;

	if (preserved_toc1 == NULL) {
		toc1_base = (void *)SUNXI_CFG_TOC1_STORE_IN_DRAM_BASE;
	} else {
		toc1_base = preserved_toc1;
	}
	toc1_item =
		(struct sbrom_toc1_item_info
			 *)(toc1_base + sizeof(struct sbrom_toc1_head_info));

	/*Parse root certificate*/
	buf = (u8 *)(toc1_base + toc1_item->data_offset);
	ret = sunxi_certif_verify_itself(&root_certif, buf,
					 toc1_item->data_len);

	ret = sunxi_certif_pubkey_check(&root_certif.pubkey, hash_buf);
	if (ret < 0) {
		printf("fail to cal pubkey hash\n");
		return -1;
	}

	return 0;
}
```

`sunxi_set_secure_mode()` 则有一个很重要的前置检查：烧 secure bit 前要求 ROTPK 还是全 0；如果启用了烧 ROTPK 功能，会先烧 ROTPK，再烧 secure bit。

```281:330:lichee/brandy-2.0/u-boot-2018/board/sunxi/board_common.c
int sunxi_set_secure_mode(void)
{
	int mode;
	u8  hash[32] = {0},hash_tmp[32] = {0};
	int hash_len = 0;

	if ((gd->securemode == SUNXI_NORMAL_MODE) &&
	    (gd->bootfile_mode == SUNXI_BOOT_FILE_TOC)) {
		mode = sid_probe_security_mode();
		if (!mode) {
			if (sunxi_efuse_read("rotpk", hash, &hash_len)) {
				printf("read puk hash fail\n");
				return -1;
			}
			printf("read puk finished,len:%d\n", hash_len);
			if (memcmp(hash, hash_tmp, sizeof(hash))) {
				printf("puk hash not zero,fail\n");
				return -1;
			}

#if defined(CONFIG_SUNXI_BURN_ROTPK_ON_SPRITE) || \
	defined(CONFIG_SUNXI_ROTPK_BURN_ENABLE_BY_TOOL)
			if (sunxi_burn_rotpk())
				return -1;
#endif

			if (sid_set_security_mode()) {
				printf("burn secure bit fail\n");
				return -1;
			}
			gd->bootfile_mode = SUNXI_BOOT_FILE_TOC;
			printf("burn done, now secure bit is:%d\n",
			       sid_probe_security_mode());
		} else {
			printf("secure chip, don't repeat burn secure bit\n");
		}
	}

	return 0;
}
```

这说明 Allwinner 正常期望的闭环是：

```text
toc1 root cert 公钥 hash
  -> 烧入 efuse ROTPK
  -> 再烧 secure enable bit
  -> 后续 SBROM/SBOOT/U-Boot/TEE 都围绕这个 root key 验证
```

如果你只烧了 secure enable bit，没有烧 ROTPK，就会出现“芯片看起来处于 secure mode，但信任根为空/未绑定”的状态。这个状态在量产上是不完整甚至危险的。

## 7. 为什么 secure enable bit 开了、没烧 ROTPK，仍能启动修改后的 boot.img

结合代码，我认为主要有这几种可能，按概率排序：

### 情况 A：bootloader 处于 unlocked/orange 状态

这是最直接的解释。

`sunxi_android_boot()` 里只要：

```c
gd->securemode != 0
gd->lockflag == SUNXI_UNLOCKED
```

就进入 orange 分支。注释明确写着：

```text
ORANGE, indicating a device may be freely modified.
Device integrity is left to the user to verify out-of-band.
```

也就是说：**secure enable bit 开了，但 bootloader unlock，则 Android boot 分区不会被强制拒绝。**

这就是你问的“是不是有什么特殊分支”：是的，`gd->lockflag == SUNXI_UNLOCKED` 这个 orange 分支就是特殊分支。

建议你看串口 log 有没有：

```text
Your device software can't be checked for corruption.
Please lock the bootloader.
orange state
verifiedbootstate=orange
```

如果有，答案基本确定。

### 情况 B：U-Boot 确认 securemode，但 Android verified boot 没有真正闭环

即使 secure bit 已开，`boot.img` 验证也不是 BootROM 直接做的。BootROM/SBROM主要负责前级：

```text
toc0/sboot -> toc1/U-Boot/OP-TEE
```

Android `boot.img` 是后级 U-Boot 逻辑验的：

```text
sunxi_android_boot()
  -> sunxi_verify_os()
  -> sunxi_verify_embed_signature() / sunxi_verify_signature()
```

如果 `gd->lockflag`、AVB、vbmeta、toc1 cert、TEE hash database 配置没有进入强制验签路径，就可能继续启动。

### 情况 C：`CONFIG_SUNXI_AVB` 分支只做 AVB 信息上报或 fallback

代码里 `CONFIG_SUNXI_AVB` 开启时：

- secure + locked：尝试 AVB/vbmeta 验证，失败才 fallback 到 `sunxi_verify_os()`
- non-secure：有 vbmeta 时只是 `android_vbmeta_avb_verify()` 设置 Android AVB 信息，不阻止启动

在 secure + unlocked 下，即使有 AVB，也调用：

```c
android_vbmeta_avb_verify("unlocked");
```

但不会因为 boot.img 修改而拒绝启动。

### 情况 D：ROTPK 未烧导致 root key 未硬绑定，secure bit 只改变前级路径

未烧 ROTPK 时，硬件/TEE 没有一个不可变的 root public key hash 来约束 toc1/root cert。这样系统可能仍走 `toc0/toc1`，但 root cert 不被 efuse ROTPK 约束。根据具体 SoC/SBROM/OP-TEE实现，它可能：

1. 接受当前 toc1/root cert；
2. 只依赖 toc1 内部证书链；
3. 或后级 U-Boot 仅靠 bootloader lock 决定是否严格验 boot.img。

所以你能启动修改后的 `boot.img` 并不矛盾：**secure enable bit 不是 Android boot.img 的唯一开关；ROTPK 和 lock/verified boot 状态才决定是否形成完整拒绝链。**

## 8. 总结路径图

### 非安全启动

```text
BROM
  -> boot0_nand.fex / boot0_sdcard.fex
  -> load_package()
  -> boot_package.fex
  -> U-Boot
  -> 如果 gd->securemode == 0：
       Android boot.img 默认不强制拒绝
       若有 CONFIG_SUNXI_AVB/vbmeta，可能只上报 AVB 状态
  -> kernel
```

### 安全启动但未锁定

```text
SBROM
  -> toc0.fex / sboot.bin
  -> toc1.fex
  -> U-Boot
  -> gd->securemode = 1
  -> gd->lockflag == SUNXI_UNLOCKED
  -> orange 分支
  -> 不强制 sunxi_verify_os()
  -> 修改 boot.img 仍可启动
```

### 完整安全启动且锁定

```text
SBROM
  -> toc0/sboot
  -> toc1 root cert / U-Boot / OP-TEE 验证
  -> U-Boot
  -> gd->securemode = 1
  -> gd->lockflag != SUNXI_UNLOCKED
  -> sunxi_verify_os() 或 AVB verify_image_by_vbmeta()
  -> 验证失败：
       verifiedbootstate=red
       shutdown
  -> 验证成功：
       green/yellow
       kernel
```

## 9. 你可以怎么确认

建议从串口 log 里查这些关键字：

```text
secure enable bit:
secure mode: with secureos
secure mode: no secureos
Your device software can't be checked for corruption.
Please lock the bootloader.
orange
yellow
green
red
boota: verify the boot failed
image boot hash valid
image boot hash not found
optee return hash invalid
rotpk not found
```

如果看到：

```text
secure enable bit: 1
Your device software can't be checked for corruption.
Please lock the bootloader.
```

那就是 secure mode + unlocked/orange，修改 `boot.img` 可启动是代码预期行为。

如果想让修改后的 `boot.img` 被拒绝，通常需要同时满足：

1. 用 `-s secure` 正确打安全包，生成并使用 `toc0.fex/toc1.fex`；
2. 烧入正确 ROTPK，而不是只烧 secure enable bit；
3. 设置 bootloader lock 状态，不走 `SUNXI_UNLOCKED`；
4. `boot.img` 使用匹配的 Allwinner cert 或 AVB/vbmeta 链；
5. U-Boot 编译配置中相关验证功能开启，比如 `CONFIG_SUNXI_AVB` 或非 AVB 的 `sunxi_verify_os()` 链路可用。

