---

# 2. 签名 + 验证是怎么完成的？

这里分成三个层次：

1. **打包阶段生成签名/证书**
2. **SBoot 阶段验证 TOC1 中的启动组件**
3. **U-Boot 阶段验证 boot/rootfs 等后续镜像**

---

## 2.1 打包阶段：`dragonsecboot` 生成 TOC0/TOC1 和证书

安全签名入口在 `scripts/pack_img.sh` 的 `do_signature()`。

先检查 key 目录，然后生成 `toc0.fex`：

```1618:1630:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
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
```

然后用 `sys_config.bin` 更新 `toc0.fex`：

```1631:1636:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
	update_toc0  toc0.fex           sys_config.bin
	if [ $? -ne 0 ]
	then
		pack_error "update toc0 run error"
		exit 1
	fi
```

生成 `toc1.fex`：

```1656:1667:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
	if [ -f ${LONGAN_COMMON_DIR}/sign_config/cnf_base.cnf ] ; then
		CNF_BASE_FILE=${LONGAN_COMMON_DIR}/sign_config/cnf_base.cnf
	else
		CNF_BASE_FILE=${TINA_CONFIG_DIR}/generic/sign_config/cnf_base.cnf
	fi
	dragonsecboot -toc1 dragon_toc.cfg ${ROOT_DIR}/keys \
		${CNF_BASE_FILE} \
		${ROOT_DIR}/image/version_base.mk
	if [ $? -ne 0 ]
```

也就是说，签名生成端核心是：

```text
dragonsecboot -toc0
dragonsecboot -toc1
```

`dragon_toc.cfg` 决定哪些 item 被放进 TOC0/TOC1，用哪些 key 签。

你当前的 `dragon_toc.cfg`：

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

这表示：

```text
toc0:
  sboot.bin 由 RootKey_Level_0 相关链路保护

toc1:
  rootkey.der
  monitor.fex 使用 TrustedFirmwareContentCertPK
  optee.fex 使用 SoCFirmwareContentCert_KEY
  u-boot.fex 使用 NonTrustedFirmwareContentCertPK
  scp.fex 使用 SoCFirmwareContentCert_KEY
  recovery.fex 只生成 key/cert
  boot.fex 只生成 key/cert
```

后面还有非签名数据项：

```24:30:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/out/r818-sc3917/image/dragon_toc.cfg
onlydata=dtb,		sunxi.fex       NULL
onlydata=board-cfg,	board.fex       NULL
;onlylogo=logo,              bootlogo.bmp.lzma          NULL
;onlylogo=shutdowncharge,    bempty.bmp.lzma            NULL
;onlylogo=androidcharge,    battery_charge.bmp.lzma    NULL
```

---

## 2.2 `boot.fex` / `recovery.fex` 的证书追加

`dragonsecboot -toc1` 生成 TOC1 后，会在 `toc1/cert/` 下生成证书，例如：

```text
toc1/cert/boot.der
toc1/cert/recovery.der
toc1/cert/rootfs.der
```

然后 `sigbootimg` 把证书追加到 Android boot image：

```1678:1691:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
	sigbootimg --image boot.fex --cert toc1/cert/boot.der --output boot_sig.fex
	if [ $? -ne 0 ] ; then
		pack_error "Pack cert to image error"
		exit 1
	else
		mv -f boot_sig.fex boot.fex
	fi

	# add cert behind recovery image
	if [ -f ${ROOT_DIR}/boot_initramfs_recovery.img ]; then
		local recovery_fex_magic=$(dd if=recovery.fex bs=1 count=8 | md5sum | cut -d " " -f 1)
```

recovery 同理：

```1694:1706:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
		du -b -L recovery.fex
		sigbootimg --image recovery.fex --cert toc1/cert/recovery.der --output recovery_sig.fex
		if [ $? -ne 0 ] ; then
			pack_error "Pack cert to image error"
			exit 1
		else
			mv -f recovery_sig.fex recovery.fex
		fi
		du -b recovery.fex
	fi
```

所以 `boot.fex` 的安全形态是：

```text
boot.fex 原始 Android boot image
  + toc1/cert/boot.der 追加证书
```

如果启用了 squashfs rootfs 验证，还会把 rootfs 证书追加到 rootfs：

```1808:1819:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
	if [ "x${PACK_SIG}" = "xsecure" ] ; then
		# append the signature to the behind of rootfs.fex
		grep "CONFIG_TARGET_ROOTFS_SQUASHFS=y" ${PACK_TOPDIR}/.config > /dev/null && \
			grep "CONFIG_USE_UBOOT_VERIFY_SQUASHFS=y" ${PACK_TOPDIR}/.config > /dev/null
		if [ $? -eq 0 ]; then
			update_squashfs ${ROOT_DIR}/image/rootfs.fex ${ROOT_DIR}/image/toc1/cert/rootfs.der
			if [ $? -ne 0 ]
			then
				pack_error "signature squashfs rootfs error."
```

---

## 2.3 SBoot 阶段：验证 TOC1 并运行

`sboot_main()` 里核心就是：

```94:107:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_main.c
	ret = sunxi_flash_init(toc0->platform[0] & 0x0f);
	if(ret)
		goto _BOOT_ERROR;

	ret = toc1_init();
	if(ret)
		goto _BOOT_ERROR;

	ret = toc1_verify_and_run(dram_size, pmu_type, uart_input_value, key_input);
	if(ret)
		goto _BOOT_ERROR;
```

从 `sboot_toc.h` 可以看到它会按 item group 遍历 TOC1：

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

结合 `sbrom_toc1_item_info.type` 的定义：

```87:94:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/include/private_toc.h
	u32  data_offset;
	u32  data_len;
	u32  encrypt;			//0: no aes   //1: aes
	u32  type;				//0: normal file, dont care  1: key certif  2: sign certif 3: bin file
	u32  run_addr;          //if it is a bin file, then run on this address; if not, it should be 0
	u32  index;             //if it is a bin file, this value shows the index to run; if not
	                       //if it is a certif file, it should equal to the bin file index
```

可以推理出 `toc1_verify_and_run()` 的逻辑大致是：

```text
读取 toc1 head
校验 toc1 magic / checksum
读取 rootkey.der
验证 root cert 自签名
遍历 TOC1 item group
  对每组：
    key_certif：验证公钥证书是否被 root cert 授权
    bin_certif：验证镜像证书本身
    binfile：读取二进制镜像，计算 hash
    比较镜像 hash 与证书 extension 里的 hash
    验证通过后搬运到 run_addr
最后跳转 monitor/optee/u-boot
```

这个推理不是凭空来的。虽然 `toc1_verify_and_run()` 源码被封在库里，但 `libsun50iw10p1_sboot.a` 里字符串可以看到这些错误信息和函数符号：

```text
toc1_verify_and_run
toc1_item_probe_next
toc1_item_read_rootcertif
sunxi_certif_verify_itself
sunxi_root_certif_pk_verify
sunxi_certif_pubkey_check
sunxi_pubkey_hash_cal
sid_read_rotpk
certif verify failed
root certif pk verify failed
root certif verify itself failed
hash compare is not correct
have rotpk, do check
don't have rotpk, skip check
fail to check the public key hash against efuse
```

这些字符串和符号说明 SBoot 确实做了：

```text
证书解析
证书自验证
root cert 校验
公钥 hash 计算
ROTPK/eFuse 校验
镜像 hash 比较
TOC1 item 遍历
```

源码里能看到证书相关接口声明：

```13:18:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_ceritf.h
#define RSA_BIT_WITDH 2048
int sunxi_certif_pubkey_check( sunxi_key_t  *pubkey );
int sunxi_pubkey_hash_cal(char *out_buf, sunxi_key_t *pubkey);
int sunxi_root_certif_pk_verify(sunxi_certif_info_t *sunxi_certif, u8 *buf, u32 len);
```

所以 SPL/SBoot 阶段的验证代码能“定位到接口和二进制符号”，但完整 C 实现不在当前开放源码中。

---

## 2.4 U-Boot 阶段：验证 `boot.fex` / rootfs / 分区

U-Boot 里有更完整的验证源码：`board/sunxi/sunxi_image_verifier.c`。

### 2.4.1 验证 OS 镜像

入口函数：

```18:52:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
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
```

它先根据 Android boot image 计算实际镜像长度：

```34:43:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
	total_len = android_image_get_end(fb_hdr) - (ulong)fb_hdr;

	pr_msg("kernel len:%ld, part len:%ld\n", total_len, info.size * 512);
	if (total_len > info.size * 512) {
		pr_err("invalid kernel len\n");
		return -1;
	}
	if (android_image_get_signature(fb_hdr, &sign_data, &sign_len))
```

然后根据是否有内嵌证书，选择两种验证方式：

```44:51:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
		ret = sunxi_verify_embed_signature((void *)os_load_addr,
						   (unsigned int)total_len,
						   cert_name, (void *)sign_data,
						   sign_len);
	else
		ret = sunxi_verify_signature((void *)os_load_addr,
					     (unsigned int)total_len,
					     cert_name);
```

这正好对应打包阶段的 `sigbootimg`：

```text
如果 boot.fex 后面追加了 cert：
  sunxi_verify_embed_signature()

如果 cert 不在镜像后面：
  sunxi_verify_signature()，通过 OP-TEE/TOC1 中保存的 hash 验证
```

---

### 2.4.2 从 Android boot image 后面取证书

`android_image_get_signature()`：

```54:74:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
static int android_image_get_signature(const struct andr_img_hdr *hdr,
				       ulong *sign_data, ulong *sign_len)
{
	struct boot_img_hdr_ex *hdr_ex;
	ulong addr = 0;

	hdr_ex = (struct boot_img_hdr_ex *)hdr;
	if (strncmp((void *)(hdr_ex->cert_magic), AW_CERT_MAGIC,
		    strlen(AW_CERT_MAGIC))) {
		printf("No cert image embeded, image %s\n", hdr_ex->cert_magic);
		return 0;
	}

	addr = android_image_get_end(hdr);

	*sign_data = (ulong)addr;
	*sign_len  = hdr_ex->cert_size;
```

也就是说，证书不是“解压出来”的，而是：

```text
Android boot image 末尾紧跟 cert 数据
hdr_ex->cert_magic 标识存在证书
hdr_ex->cert_size 记录证书大小
android_image_get_end(hdr) 找到 cert 起始地址
```

这和 `sigbootimg --image boot.fex --cert boot.der --output boot_sig.fex` 完全对应。

---

### 2.4.3 验证内嵌证书镜像

核心函数 `sunxi_verify_embed_signature()`：

```113:149:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
static int sunxi_verify_embed_signature(void *buff, uint len,
					const char *cert_name, void *cert,
					unsigned cert_len)
{
	u8 hash_of_file[32];
	int ret;
	sunxi_certif_info_t sub_certif;
	void *cert_buf;

	cert_buf = malloc(cert_len);
	if (!cert_buf) {
		printf("out of memory\n");
		return -1;
	}
	memcpy(cert_buf, cert, cert_len);

	memset(hash_of_file, 0, 32);
	sunxi_ss_open();
	ret = sunxi_sha_calc(hash_of_file, 32, buff, len);
	if (ret) {
		printf("sunxi_verify_signature err: calc hash failed\n");
		goto __ERROR_END;
	}
```

第一步：对镜像本体算 SHA256：

```text
hash_of_file = SHA256(image)
```

第二步：验证证书自身：

```134:139:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
	if (sunxi_certif_verify_itself(&sub_certif, cert_buf, cert_len)) {
		printf("%s error: cant verify the content certif\n", __func__);
		printf("cert dump\n");
		sunxi_dump(cert_buf, cert_len);
		goto __ERROR_END;
	}
```

第三步：比较镜像 hash 与证书 extension 里的 hash：

```141:148:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
	if (memcmp(hash_of_file, sub_certif.extension.value[0], 32)) {
		printf("hash compare is not correct\n");
		printf(">>>>>>>hash of file<<<<<<<<<<\n");
		sunxi_dump(hash_of_file, 32);
		printf(">>>>>>>hash in certif<<<<<<<<<<\n");
		sunxi_dump(sub_certif.extension.value[0], 32);
		goto __ERROR_END;
```

第四步：验证证书公钥是否属于 root cert 信任链：

```150:156:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
	/*Approvel certificate by trust-chain*/
	if (check_public_in_rootcert(cert_name, &sub_certif)) {
		printf("check rootpk[%s] in rootcert fail\n", cert_name);
		goto __ERROR_END;
	}
	free(cert_buf);
```

所以 U-Boot 里内嵌证书验证逻辑非常清楚：

```text
1. 从 boot image 尾部取 cert
2. 对 boot image 本体计算 SHA256
3. 解析并验证 cert 自身
4. 取 cert extension 中记录的目标 hash
5. 比较 SHA256(image) == hash_in_cert
6. 通过 OP-TEE 检查该 cert 公钥是否在 root cert 信任链中
```

---

### 2.4.4 公钥 hash 校验

`sunxi_certif_pubkey_check()` 计算公钥 hash：

```76:108:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
#define RSA_BIT_WITDH 2048
static int sunxi_certif_pubkey_check(sunxi_key_t *pubkey, u8 *hash_buf)
{
	ALLOC_CACHE_ALIGN_BUFFER(char, rotpk_hash, 256);
	char all_zero[32];
	char pk[RSA_BIT_WITDH / 8 * 2 + 256]; /*For the stupid sha padding */

	memset(all_zero, 0, 32);
	memset(pk, 0x91, sizeof(pk));
	char *align = (char *)(((u32)pk + 63) & (~63));
	if (*(pubkey->n)) {
		memcpy(align, pubkey->n, pubkey->n_len);
		memcpy(align + pubkey->n_len, pubkey->e, pubkey->e_len);
	} else {
```

```94:107:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
		memcpy(align, pubkey->n + 1, pubkey->n_len - 1);
		memcpy(align + pubkey->n_len - 1, pubkey->e, pubkey->e_len);
	}
	if (sunxi_sha_calc((u8 *)rotpk_hash, 32, (u8 *)align,
			   RSA_BIT_WITDH / 8 * 2)) {
		printf("sunxi_sha_calc: calc  pubkey sha256 with hardware err\n");
		return -1;
	}
	memcpy(hash_buf, rotpk_hash, 32);

	return 0;
}
```

这里公钥 hash 的计算方式是：

```text
pubkey.n + pubkey.e
  -> SHA256
  -> key_hash
```

然后通过 OP-TEE 检查这个 key hash 是否可信：

```110:128:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
static int check_public_in_rootcert(const char *name,
				    sunxi_certif_info_t *sub_certif)
{
	int ret;
	uint8_t key_hash[32];
	char request_key_name[16];

	sunxi_certif_pubkey_check(&sub_certif->pubkey, key_hash);

	strcpy(request_key_name, name);
	strcat(request_key_name, "-key");

	ret = smc_tee_check_hash(request_key_name, key_hash);
```

```121:130:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
	if (ret == 0xFFFF000F) {
		printf("optee return pubkey hash invalid\n");
		return -1;
	} else if (ret == 0) {
		printf("pubkey %s valid\n", name);
		return 0;
	} else {
		printf("pubkey %s not found\n");
		return -1;
	}
```

所以 U-Boot 阶段的 trust chain 是：

```text
证书里的公钥
  -> 计算公钥 hash
  -> smc_tee_check_hash("boot-key" / "recovery-key" / ...)
  -> OP-TEE 判断该 key hash 是否来自 TOC1/root cert
```

---

### 2.4.5 非内嵌证书的 hash 验证

如果镜像后面没有内嵌证书，则走 `sunxi_verify_signature()`：

```164:189:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
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
```

```190:204:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
	if (ret == 0xFFFF000F) {
		sunxi_dump(hash_of_file, 32);
		pr_err("optee return hash invalid\n");
		return -1;
	} else if (ret == 0) {
		pr_msg("image %s hash valid\n", cert_name);
#ifdef COFNIG_SUNXI_VERIFY_BOOT_INFO
		sunxi_set_verify_boot_blob(SUNXI_VB_INFO_KEY, hash_of_file, 32);
#endif
		return 0;
	} else {
		sunxi_dump(hash_of_file, 32);
```

这条路径更简单：

```text
SHA256(image)
  -> smc_tee_check_hash(cert_name, hash)
  -> OP-TEE 查 TOC1/root cert 中保存的合法 hash
```

---

## 2.5 rootfs / 分区验证

`sunxi_verify_partion()` 用于分区级验证，比如 rootfs。

它先获取分区信息，再计算 squashfs 实际长度：

```346:383:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
int sunxi_verify_partion(struct sunxi_image_verify_pattern_st *pattern,
			const char *part_name, const char *cert_name, int full)
{
	int ret = 0;
	disk_partition_t info = { 0 };
	int i;
	uint8_t *p		      = 0;
	uint8_t *unaligned_sample_buf = 0;
	void *cert_buf;
	uint32_t cert_len;
	uint64_t part_len;
	uint32_t whole_sample_len;

	if (sunxi_partition_get_info(part_name, &info)) {
		printf("get part: %s info failed\n", part_name);
		return -ENODEV;
	}

	part_len = cal_partioin_len(&info);
```

然后从分区中读样本或全量数据：

```384:411:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
	if (full == 1) {
		whole_sample_len = part_len;
	} else {
		if (pattern->cnt == -1) {
			if (part_len == -1) {
				return -1;
			}
			pattern->cnt = part_len / pattern->interval;
		}
		whole_sample_len = pattern->cnt * pattern->size;
	}

#if 0
	pr_msg("pattern size:%d, interval:%d,cnt:%d, whole_sample_len:%d, "
		"cert_name : %s, full: %d\n", pattern->size, pattern->interval,
		pattern->cnt, whole_sample_len, cert_name, full);
#endif

	unaligned_sample_buf = (uint8_t *)malloc(whole_sample_len + 256);
```

最后读取分区尾部的证书，并调用 `sunxi_verify_embed_signature()`：

```424:443:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
#define SUNXI_X509_CERTIFF_MAX_LEN 4096
	cert_buf = malloc(ALIGN(SUNXI_X509_CERTIFF_MAX_LEN + 4, SECTOR_SIZE));
	if (!cert_buf) {
		printf("not enough meory\n");
	} else {
		memset(cert_buf, 0, SUNXI_X509_CERTIFF_MAX_LEN + 4);
		sunxi_flash_read(info.start + (part_len / SECTOR_SIZE),
			(ALIGN(SUNXI_X509_CERTIFF_MAX_LEN + 4, SECTOR_SIZE)) /
				SECTOR_SIZE, cert_buf);
		memcpy(&cert_len, cert_buf, sizeof(cert_len));
		memcpy(cert_buf, cert_buf + 4, cert_len);
		ret = sunxi_verify_embed_signature(p,
						   whole_sample_len,
						   cert_name,
```

这和打包阶段的：

```bash
update_squashfs rootfs.fex toc1/cert/rootfs.der
```

对应。

也就是说 rootfs 验证流程是：

```text
打包阶段：
  rootfs.fex 后面追加 rootfs.der

运行阶段：
  U-Boot 从 rootfs 分区尾部读取 cert_len + cert
  对 rootfs 样本或全量数据算 hash
  验证 cert
  比较 hash
  检查 cert 公钥是否在 root cert 信任链里
```

---

# 3. 简要推理完整安全启动链

结合当前源码，可以把“签名 + 验证”推理成下面这条链。

## 3.1 打包生成链

```text
输入：
  sboot.bin
  monitor.fex
  optee.fex
  u-boot.fex
  scp.fex
  boot.fex
  recovery.fex
  rootfs.fex
  keys/
  dragon_toc.cfg

do_signature()
  -> dragonsecboot -toc0
       生成 toc0.fex
       toc0 里包含 sboot.bin
       sboot.bin 受 RootKey_Level_0 保护

  -> update_toc0 toc0.fex sys_config.bin
       把 DRAM/UART/storage 等板级参数写入 toc0

  -> dragonsecboot -toc1
       生成 toc1.fex
       生成 rootkey.der
       给 monitor/optee/u-boot/scp 生成证书和 hash
       给 boot/recovery/rootfs 生成 cert

  -> sigbootimg
       把 boot.der 追加到 boot.fex
       把 recovery.der 追加到 recovery.fex

  -> update_squashfs
       把 rootfs.der 追加到 rootfs.fex
```

---

## 3.2 芯片启动链

```text
Secure BootROM
  -> 读取 toc0.fex
  -> 校验 toc0 / sboot.bin
  -> 运行 sboot.bin
```

这部分 BootROM 代码当然不在源码里，但从 `TOC0_MAGIC`、`sboot_head`、`dragonsecboot -toc0` 可以确认这个设计。

`sboot_head.c` 里使用 `TOC0_MAGIC`：

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

---

## 3.3 SBoot 验证链

```text
sboot_main()
  -> sunxi_flash_init()
  -> toc1_init()
  -> toc1_verify_and_run()
       -> 读 toc1.fex
       -> 校验 toc1 head
       -> 读取 rootkey.der
       -> 验证 root cert
       -> 遍历 TOC1 item
       -> 对每个 bin：
            读取 key cert
            读取 bin cert
            读取 binfile
            验证 cert 自身签名
            计算 binfile hash
            比较 cert extension 中的 hash
            检查公钥 hash / rotpk / efuse
            加载到 run_addr
       -> 跳转 monitor/optee/u-boot
```

源码能看到的入口：

```99:107:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_main.c
	ret = toc1_init();
	if(ret)
		goto _BOOT_ERROR;

	ret = toc1_verify_and_run(dram_size, pmu_type, uart_input_value, key_input);
	if(ret)
		goto _BOOT_ERROR;
```

完整实现不在开放 C 文件中，但库中符号和字符串高度吻合这个流程。

---

## 3.4 U-Boot 验证链

U-Boot 验证 boot image：

```text
sunxi_verify_os()
  -> android_image_get_signature()
       如果 boot.fex 后面有 cert：
          sunxi_verify_embed_signature()
       否则：
          sunxi_verify_signature()
```

`sunxi_verify_embed_signature()` 逻辑：

```text
SHA256(image)
sunxi_certif_verify_itself(cert)
比较 SHA256(image) 和 cert extension hash
check_public_in_rootcert()
  -> 计算 cert pubkey hash
  -> smc_tee_check_hash()
```

对应源码：

```129:156:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_image_verifier.c
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
```

---

# 4. 最终回答你的两个问题

## 问题 1：`nboot` 读取 `boot_package`、`sboot` 读取 TOC1，是运行时解压吗？还是有自己的分区或结构体？

**不是运行时解压。**

它们读取的是启动容器：

```text
nboot:
  读取 boot_package.fex
  使用 TOC-like header / item table
  load_package()
  load_image()

sboot:
  读取 toc1.fex
  使用 sbrom_toc1_head_info / sbrom_toc1_item_info
  toc1_init()
  toc1_item_probe_next()
  toc1_item_read()
  toc1_verify_and_run()
```

它们不是普通 Linux 分区，但在镜像里有固定的启动区域/烧录位置。普通包和安全包打进去的启动文件不同：

```text
普通：
  boot0_nand.fex + boot_package.fex

安全：
  boot0_nand.fex + toc0.fex + toc1.fex
```

核心结构体是：

```text
sbrom_toc1_head_info
sbrom_toc1_item_info
toc0_private_head_t
sbrom_toc0_config_t
```

所以更准确地说：

> `boot_package.fex` / `toc1.fex` 是启动容器，不是压缩包；运行时是解析 header + item table，然后读取 item 到内存并跳转。

---

## 问题 2：签名 + 验证是怎么完成的？具体代码能找到吗？

### 能找到的部分

能找到：

1. 打包阶段生成签名的脚本逻辑：`scripts/pack_img.sh`
2. SBoot 调用 TOC1 验证的入口：`sboot_main.c`
3. TOC1 结构体和 item 结构体：`private_toc.h`
4. SBoot 证书接口声明：`sboot_ceritf.h`
5. U-Boot 阶段验证 boot/rootfs 的完整代码：`sunxi_image_verifier.c`

### 找不到完整 C 源码的部分

找不到完整 C 实现：

```text
load_package()
load_image()
toc1_init()
toc1_verify_and_run()
sunxi_certif_verify_itself()
sunxi_root_certif_pk_verify()
```

这些实现被编进了平台库：

```text
libsun50iw10p1_sdcard.a
libsun50iw10p1_nand.a
libsun50iw10p1_sboot.a
```

不过从符号和字符串能确认它们确实存在并执行证书、hash、ROTPK、eFuse 相关验证。

### 签名 + 验证的简化流程

```text
打包阶段：
  dragonsecboot -toc0
    -> 生成 toc0.fex，包含 sboot.bin

  dragonsecboot -toc1
    -> 生成 toc1.fex
    -> 生成 rootkey.der
    -> 生成 monitor/optee/u-boot/scp/boot/recovery/rootfs 等证书

  sigbootimg
    -> 把 boot.der 追加到 boot.fex
    -> 把 recovery.der 追加到 recovery.fex

  update_squashfs
    -> 把 rootfs.der 追加到 rootfs.fex

启动阶段：
  Secure BootROM
    -> 校验 toc0 / sboot

  sboot
    -> 读取 toc1
    -> 校验 root cert
    -> 校验 item cert
    -> 计算 bin hash
    -> 比较 hash
    -> 检查公钥 hash / ROTPK / eFuse
    -> 加载并跳转 monitor/optee/u-boot

  U-Boot
    -> 验证 boot image / rootfs
    -> SHA256(image)
    -> 验证 cert 自身
    -> 比较 cert 中 hash
    -> smc_tee_check_hash() 检查信任链
```

一句话总结：

> 安全启动并不是“把镜像解压出来再校验”，而是打包阶段把各启动组件组织成 TOC0/TOC1 容器并生成证书；运行时 BootROM/SBoot/U-Boot 按容器 item 表读取数据，逐级验证证书链、hash、公钥 hash/ROTPK，验证通过后才搬运和跳转。

