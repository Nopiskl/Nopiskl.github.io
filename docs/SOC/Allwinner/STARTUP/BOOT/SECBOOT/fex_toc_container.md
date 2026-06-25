
---

**User**

请你结合上述分析帮我回答两个问题
1、SPL阶段nboot读取boot_package、sboot读取TOC1容器等，是运行时解压吗？还是他们有自己的分区或结构体？帮我找一下具体代码
2、能否帮我根据现有源码简要推理一下，所谓的签名+验证是怎么完成的？具体代码能找到吗？结合具体源码分析一下

---

**Cursor**

我会继续定位 `load_package/load_image`、`toc1_*` 和证书验证相关实现；如果源码被封装在静态库里，我会用符号和字符串把可确认的调用关系标出来。

我会再补充确认静态库里的成员名和符号名，因为这部分源码没有完全展开，很多实现被封装进 `libsun50iw10p1_*.a`。

`ar` 不能识别这些 `.a`，说明它们可能不是标准 archive 或被工具链特殊处理；我改用 `file/strings/nm` 做只读确认。

我还需要看 `u-boot` 里 `sunxi_image_verifier.c`，它很可能是 U-Boot 阶段验证 boot/rootfs/recovery 的代码。

我再看一下 `load_package/load_image` 和 `toc1_*` 的声明位置，以及 `pack_img.sh` 里签名生成端，方便把“生成签名”和“运行时验证”两边串起来。

下面按你两个问题分别回答。结论先说：

1. **不是运行时“解压”**。`nboot` 读取的是 `boot_package.fex` 这种 boot package 容器；`sboot` 读取的是 `toc1.fex` 这种 TOC1 容器。它们都有自己的头部和 item 表结构，运行时按结构表读取、校验、搬运、跳转，不是像 `tar/gzip/squashfs` 那样解压。
2. **签名 + 验证分成两段**：
   - 打包阶段：`dragonsecboot` 生成 `toc0.fex`、`toc1.fex`、证书；`sigbootimg` 把 `boot.der` / `recovery.der` 追加到 Android boot image 后面。
   - 运行阶段：`sboot` 校验 `toc1.fex` 中的证书链、hash、root key；U-Boot 后续还可以验证 `boot.fex`、`rootfs` 等镜像的 hash/cert。  
   但要注意：**SPL 阶段最核心的 `load_package()`、`load_image()`、`toc1_verify_and_run()` 的 C 实现源码没有展开在当前源码树里，而是被编进了 `libsun50iw10p1_sdcard.a`、`libsun50iw10p1_sboot.a` 这种 ELF relocatable 库里**。我们能看到调用点、头文件、结构体、符号和字符串，但看不到完整 C 源码。

---

# 1. `nboot` 读取 `boot_package`、`sboot` 读取 TOC1 是解压吗？

## 1.1 不是解压，而是读取容器结构

从现有源码看，`nboot` 和 `sboot` 都不是做运行时解压，而是读取某种**启动容器格式**：

| 路径 | 读取对象 | 容器类型 | 是否解压 |
|---|---|---|---|
| 非安全 `nboot` | `boot_package.fex` | boot package / TOC-like 容器 | 不是解压，是按 item 表加载 |
| 安全 `sboot` | `toc1.fex` | TOC1 容器 | 不是解压，是校验证书后按 item 表加载 |
| 内核 / rootfs | `boot.fex`、`rootfs.fex` | 分区镜像或 Android boot image | 后续 OS 层才涉及文件系统挂载/解压 |

这里的“容器”核心结构可以在 `private_toc.h` 看到。

TOC1 头部：

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

TOC1 item 表：

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
```

这个结构说明 TOC1 是一个典型“索引表 + 数据区”的容器：

```text
toc1.fex
├── sbrom_toc1_head_info
├── sbrom_toc1_item_info[items_nr]
│   ├── name
│   ├── data_offset
│   ├── data_len
│   ├── type
│   ├── run_addr
│   └── index
└── item data area
    ├── rootkey.der
    ├── monitor.fex
    ├── optee.fex
    ├── u-boot.fex
    ├── scp.fex
    ├── boot cert
    └── ...
```

所以运行时动作应该是：

```text
读 TOC1 头
校验 magic/checksum
遍历 item 表
根据 item.name / item.type / item.run_addr / item.data_offset / item.data_len
把对应数据读到目标地址
必要时做证书/hash校验
最后跳转
```

不是：

```text
读取压缩包
运行时解压成多个文件
```

---

## 1.2 `nboot` 读取 `boot_package` 的代码位置

`nboot` 入口在 `spl/nboot/main/boot0_main.c`。

关键调用：

```76:84:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
	if (status)
		goto _BOOT_ERROR;

	status = load_package();
	if(status == 0 )
		load_image(&uboot_base, &optee_base, &monitor_base, &rtos_base, &opensbi_base);
	else
		goto _BOOT_ERROR;
```

后面根据 `load_image()` 得到的地址跳转：

```86:99:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
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

```100:108:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
		monitor_head->secureos_base = optee_base;
		boot0_jmp_monitor(monitor_base);
	} else if (optee_base)
		boot0_jmp_optee(optee_base, uboot_base);
	else if (rtos_base) {
		printf("jump to rtos\n");
		boot0_jmp(rtos_base);
	}
	else
```

```109:116:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
		boot0_jmp(uboot_base);

	while(1);
_BOOT_ERROR:
	boot0_clear_env();
	boot0_jmp(FEL_BASE);

}
```

这里没有任何“解压”动作的语义，比如 `inflate`、`unzip`、`lzma`。它的动作是：

```text
load_package()
load_image()
boot0_jmp_xxx()
```

也就是读取 package、解析 image、跳转。

另外，`update_uboot_info()` 里把 `CONFIG_BOOTPKG_BASE` 强转成 `sbrom_toc1_head_info`：

```120:126:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
	uboot_head_t  *header = (uboot_head_t *) uboot_base;
	struct sbrom_toc1_head_info *toc1_head = (struct sbrom_toc1_head_info *)CONFIG_BOOTPKG_BASE;

	header->boot_data.boot_package_size = toc1_head->valid_len;
	header->boot_data.dram_scan_size = dram_size;
	memcpy((void *)header->boot_data.dram_para, &BT0_head.prvt_head.dram_para, 32 * sizeof(int));
```

这个很关键。它说明普通 `boot_package` 在内存里的头部布局也复用了 `sbrom_toc1_head_info` 这种 TOC-like 结构。也就是说，`boot_package.fex` 不是压缩包，而是一个带 `valid_len/items_nr/item table` 的启动容器。

---

## 1.3 `sboot` 读取 TOC1 的代码位置

`sboot` 入口在 `spl/sboot/main/sboot_main.c`。

关键流程：

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

`sboot` 读取的是 `toc1.fex`，不是 `boot_package.fex`。它通过：

```text
sunxi_flash_init()
toc1_init()
toc1_verify_and_run()
```

完成 TOC1 加载、解析、验证和跳转。

对应接口在 `sboot_toc.h`：

```15:30:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/sboot/main/sboot_toc.h
typedef struct {
	struct sbrom_toc1_item_info *key_certif;
	struct sbrom_toc1_item_info *bin_certif;
	struct sbrom_toc1_item_info *binfile;
	struct sbrom_toc1_item_info *normal;
} sbrom_toc1_item_group;

int toc1_init(void);
uint toc1_item_read(struct sbrom_toc1_item_info *p_toc_item, void * p_dest, u32 buff_len);

uint toc1_item_read_rootcertif(void * p_dest, u32 buff_len);
int toc1_item_probe_start(void);
int toc1_item_probe_next(sbrom_toc1_item_group *item_group);
int toc1_verify_and_run(u32 dram_size, u16 pmu_type, u16 uart_input, u16 key_input);
```

这里也能看出它不是“解压”，而是：

```text
toc1_init()
toc1_item_probe_start()
toc1_item_probe_next()
toc1_item_read()
toc1_verify_and_run()
```

也就是按 item 表枚举、读取、验证、运行。

---

## 1.4 它们有没有自己的分区？

更准确地说：

- 它们不是传统意义上的 Linux 分区。
- 它们是烧录在启动区域 / 固定偏移 / 特殊 boot 区域里的启动容器。
- 最终镜像打包时，安全与非安全使用的启动文件不同。

`do_pack_partition_file()` 里可以看出安全包和普通包包含的启动文件不同：

```1849:1853:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
	if [ "x${PACK_SIG}" = "xsecure" ];then
		tar_boot_file="./image/boot0_nand.fex ./image/toc0.fex ./image/toc1.fex"
	else
		tar_boot_file="./image/boot0_nand.fex ./image/boot_package.fex"
	fi
```

所以：

```text
普通包：
  boot0_nand.fex + boot_package.fex

安全包：
  boot0_nand.fex + toc0.fex + toc1.fex
```

注意这里安全包里虽然还带 `boot0_nand.fex`，但实际安全启动链核心是 `toc0.fex -> sboot.bin -> toc1.fex`。

U-Boot 侧也有 boot package 大小字段：

```52:60:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/include/private_uboot.h
	unsigned char               secureos_exist;
	unsigned char               monitor_exist;
	unsigned char               func_mask;              /* see enum UBOOT_FUNC_MASK_EN */
	unsigned char               res[1];
	unsigned int                uboot_start_sector_in_mmc;  /*use in OTA update */
	int                         dtb_offset;                 /*device tree in uboot */
	int                         boot_package_size;          /*boot package size, boot0 pass this value */
	unsigned int                dram_scan_size;             /*dram real size */
```

这说明 Boot0/SBoot 会把启动容器大小、DRAM 信息、安全 OS 信息等传给 U-Boot。

---

## 1.5 当前源码中找不到完整实现的部分

我检查了源码树，`load_package()`、`load_image()`、`toc1_verify_and_run()` 的调用点和声明能找到，但具体 C 实现没有展开在 `spl/**/*.c` 里。

实际符号存在于这些库里：

```text
lichee/brandy-2.0/spl/board/r818/libsun50iw10p1_sdcard.a
lichee/brandy-2.0/spl/board/r818/libsun50iw10p1_nand.a
lichee/brandy-2.0/spl/board/r818/libsun50iw10p1_sboot.a
```

这些文件虽然后缀是 `.a`，但 `file` 显示它们是：

```text
ELF 32-bit LSB relocatable, ARM, EABI5 version 1, not stripped
```

不是标准 `ar` archive，所以不能直接用 `ar t` 展开源码对象。但字符串和符号里能看到：

```text
load_package
load_image
load_toc1_from_sdmmc
toc1_flash_read
toc1_get_image_addr
toc1_init
toc1_item_read
toc1_item_read_rootcertif
toc1_item_probe_next
toc1_verify_and_run
sunxi_certif_verify_itself
sunxi_certif_pubkey_check
sunxi_root_certif_pk_verify
sid_read_rotpk
```

所以结论是：

> 具体 C 源码没有完全开放，但接口、结构体、调用链、运行语义都能从现有源码和二进制符号推断出来。

