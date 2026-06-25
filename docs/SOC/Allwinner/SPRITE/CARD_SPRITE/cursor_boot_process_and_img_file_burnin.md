# Boot process and IMG file burning analysis
_Exported on 2026/4/22 at GMT+8 20:46:51 from Cursor (2.6.21)_

---

**User**

@agent/a733_image_cfg_secure_boot_analysis.md 
请你结合SDK源码+我给你的分析文档，解决以下问题
1、为什么在normal启动过程中，也经常见到TOC1等名词？例如##“而 U-Boot 读取 boot package 的函数 read_boot_package() 会直接用这个大小，从固定 TOC1 区域把 boot package 读出来：
read_len = uboot_spare_head.boot_data.boot_package_size
MMC/SD 读 sunxi_flashmap_offset(..., TOC1)
UFS 读 TOC1
NOR 读 TOC1”##
2、请你结合相关烧录工具+UBOOT相关源码，分析一下具体烧录的过程中会怎样烧写IMG文件？


其中A733 SDK:/home/alientek/A733/qihua-x73x-linux6.6/
A133/R818 SDK:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/

---

**Cursor**

## 先给总答案

### 1）为什么 normal 启动里也经常看到 `TOC1`

核心原因就一句话：

**在全志这套链路里，`TOC1` 不仅是“secure 启动的术语”，它同时还是“boot1/U-Boot 二级启动包在介质上的固定槽位名/固定区域名”。**

所以即使是 **normal 启动**，只要代码在处理“二级启动包的落盘位置、读取位置、备份位置”，就很容易看到 `TOC1`。

更准确地说，`TOC1` 在这套代码里其实有 3 层含义：

1. **镜像容器里的一个 item 名字**：`toc1.fex`
2. **flash map 里的固定区域名**：`TOC1` / `TOC1_BAK`
3. **一种 boot package 外层头格式**：很多 normal 包也复用了 TOC1 头格式，而不是只有 secure 才能用

也就是说：

- **normal 模式下，`.img` 里选出来的是 `boot_package.fex`**
- 但**烧到介质时**，它依然被写进 **`TOC1` 固定区域**
- 上电后再读出来时，代码也会从 **`TOC1` 固定偏移**去读

所以你会看到：
- `boot_package`
- `TOC1`
- `toc magic`
- `valid_len`

这些词在 normal 和 secure 两条链路里都出现。

---

### 2）具体烧录 `.img` 时，会怎样烧写

也一句话概括：

**PC 侧烧录工具传的是一个总 `.img` 容器；真正决定“从 `.img` 里取哪个 boot item、写到 flash 哪个固定位置”的关键逻辑，在设备侧 U-Boot sprite 下载链路。**

流程是：

1. `build/pack` 先把 `boot0`、`boot_package`、`toc0`、`toc1`、分区表等都准备到 `pack_out`
2. 再用 `image.cfg` 把它们组织成一个总 `.img`
3. 烧录时，设备侧 U-Boot 根据 `gd->bootfile_mode` 判断：
   - normal/package 模式：从 `.img` 里取 `BOOTPKG-00000000`
   - secure 模式：从 `.img` 里取 `TOC1_00000000000`
4. 取到数据后，统一走 `sunxi_sprite_download_uboot()`
5. 这个函数要求数据头是 `TOC` 格式，然后按 `valid_len` 写入介质的 **`TOC1` 固定区域**
6. MMC/UFS 还会再写一份到 `TOC1_BAK`
7. boot0/toc0 也是类似：normal 写 `boot0_*`，secure 写 `toc0_*`
8. 最后系统分区、GPT/MBR、各分区镜像再按 partition 表写入逻辑分区区间

---

# 一、为什么 normal 启动里也会看到 TOC1

## 1. `image.cfg` 本来就同时挂了 `boot_package.fex` 和 `toc1.fex`

A733 的总镜像配置里，普通与 secure 的 boot item 是一起声明的：

```53:64:/home/alientek/A733/qihua-x73x-linux6.6/out/pack_out/image_linux.cfg
  ;-->固定不变的
    {filename = "sys_config.fex",   maintype = ITEM_COMMON,       subtype = "SYS_CONFIG100000",},
    {filename = "config.fex",       maintype = "12345678",        subtype = "SYS_CONFIG_BIN00",},
    {filename = "board.fex",        maintype = "12345678",        subtype = "BOARD_CONFIG_BIN",},
    {filename = "sys_partition.fex",maintype = ITEM_COMMON,       subtype = "SYS_CONFIG000000",},

    ;-->boot文件
    {filename = "boot0_nand.fex",   maintype = ITEM_BOOT,         subtype = "BOOT0_0000000000",},
    {filename = "boot0_sdcard.fex", maintype = "12345678",        subtype = "1234567890BOOT_0",},
    {filename = "boot0_ufs.fex", maintype = "12345678",		subtype = "1234567890BUFS_0",},
    {filename = "u-boot.fex",       maintype = "12345678",        subtype = "UBOOT_0000000000",},
    {filename = "u-boot-crash.fex", maintype = "12345678",        subtype = "UBOOT_CRASH_0000",},
```

你前面的分析文档已经指出了这一点：`image.cfg` 更像是**总 manifest**，不是“上电后 BootROM 必须读取的唯一清单”。

---

## 2. normal/secure 的真正分流点不是 `image.cfg`，而是 `gd->bootfile_mode`

U-Boot 启动后，会根据 secure bit、当前工作模式等，设置 `gd->bootfile_mode`：

```201:218:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c
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
#ifdef CONFIG_SUNXI_ANTI_BRUSH
		if (get_boot_work_mode() == WORK_MODE_BOOT) {
			debug("init preserve toc1\n");
			if (sunxi_verify_preserve_toc1((void *)CONFIG_SUNXI_BOOTPKG_BASE)) {
```

这段的含义非常明确：

- **secure 板**：`gd->bootfile_mode = SUNXI_BOOT_FILE_TOC`
- **normal 板**：`gd->bootfile_mode = SUNXI_BOOT_FILE_PKG`

所以 normal 启动不是“没有 TOC1 概念”，而是：
- **镜像 item 选的是 `boot_package`**
- **介质固定槽位仍然可能叫 `TOC1`**

---

## 3. normal 模式下，从 `.img` 里取的是 `BOOTPKG`，不是 `toc1.fex`

烧录时，设备侧 U-Boot sprite 是按 `bootfile_mode` 选 `.img` 里的 item subtype 的：

```815:838:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/sprite/sprite_card.c
{
	char *buffer;
	buffer = (char *)memalign(CONFIG_SYS_CACHELINE_SIZE, ALIGN(4 * 1024 * 1024, CONFIG_SYS_CACHELINE_SIZE));
	uint item_original_size;
	if (gd->bootfile_mode == SUNXI_BOOT_FILE_NORMAL) {
		imgitemhd = Img_OpenItem(imghd, "12345678", "UBOOT_0000000000");
	} else if (gd->bootfile_mode == SUNXI_BOOT_FILE_PKG) {
		if (get_boot_storage_type() != STORAGE_NOR) {
			imgitemhd = Img_OpenItem(imghd, "12345678",
						 "BOOTPKG-00000000");
		} else {
			imgitemhd = Img_OpenItem(imghd, "12345678",
						 "BOOTPKG-NOR00000");
		}
	} else {
		imgitemhd = Img_OpenItem(imghd, "12345678", "TOC1_00000000000");
	}

	if (!imgitemhd) {
		printf("sprite update error: fail to open uboot item\n");
		return -1;
	}
	//uboot长度
	item_original_size = Img_GetItemSize(imghd, imgitemhd);
```

也就是：

- `PKG` 模式 -> 取 `BOOTPKG-00000000`
- `TOC` 模式 -> 取 `TOC1_00000000000`

所以**normal 模式不是直接从 `.img` 取 `toc1.fex`**。

---

## 4. 但 `BOOTPKG` 取出来后，仍然按 TOC 头格式解析，并写入 `TOC1` 区域

关键点在这里。

`sunxi_sprite_download_uboot()` 并不把它当“普通裸 u-boot bin”，而是把它当 **TOC 头格式包** 来处理：

```163:184:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/sprite/sprite_download.c
int sunxi_sprite_download_uboot(void *buffer, int production_media, int generate_checksum)
{
	u32 length = 0;

	sbrom_toc1_head_info_t *toc1 = (sbrom_toc1_head_info_t *)buffer;

	if(toc1->magic != TOC_MAIN_INFO_MAGIC)
	{
		printf("sunxi sprite: toc magic is error\n");
		printf("need %s image\n", gd->bootfile_mode == SUNXI_BOOT_FILE_TOC ? "secure" : "normal");
		return -1;
	}
	length = toc1->valid_len;
	if(generate_checksum) {
		toc1->add_sum = sunxi_sprite_generate_checksum(buffer,
					toc1->valid_len,toc1->add_sum);
	}

	printf("uboot size = 0x%x\n", length);
	printf("storage type = %d\n", production_media);
#if defined(CONFIG_SUNXI_BURN_ROTPK_ON_SPRITE) || \
	defined(CONFIG_SUNXI_ROTPK_BURN_ENABLE_BY_TOOL)
```

这说明：

- **normal 的 `boot_package.fex` 外层也长得像 `TOC1` 包**
- 它同样有 `magic`
- 同样有 `valid_len`

所以你在 normal 流程里看到：
- `toc magic`
- `valid_len`
- `TOC1`

完全正常。

---

## 5. 介质上的固定区域名就叫 `TOC1`

flash map 把二级启动包固定区域定义成 `TOC1`：

```196:215:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/sunxi_flashmap.c
		.maps[TOC1] = {
			.start = SUNXI_MMC_TOC_START_ADDRS,
			.size = 4096
		},
		.maps[TOC1_BAK] = {
			.start = UBOOT_BACKUP_START_SECTOR_IN_SDMMC,
			.size = 4096
		},
		.maps[SEC_STORAGE] = {
			.start = SDMMC_SECURE_STORAGE_START_ADD,
			.size = 512
		},
		.maps[MMC_TUNING] = {
			.start = TUNING_ADD,
			.size = TUNING_LEN
		}
	},
	[FLASHMAP_SPI_NAND] = {
		.maps[TOC1] = {
			.start = DEFAULT_SPINAND_UBOOT_OFFSET,
```

所以**即使是 normal boot package**，只要是“写二级启动包到介质”，底层就很容易出现 `TOC1`。

---

## 6. MMC/NOR 的实际写入目标就是 `TOC1`

MMC：

```143:160:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/mmc/sdmmc.c
sunxi_flash_mmc_download_toc(unsigned char *buf, int len,  unsigned int ext)
{
	if (!mmc_boot->block_dev.block_write(&mmc_boot->block_dev,
					       sunxi_flashmap_offset(FLASHMAP_SDMMC, TOC1),
					       len / 512, buf)) {
		pr_err("%s: write main uboot failed\n", __func__);
		return -1;
	}

	if (!mmc_boot->block_dev.block_write(
		    &mmc_boot->block_dev, sunxi_flashmap_offset(FLASHMAP_SDMMC, TOC1_BAK),
		    len / 512, buf)) {
		pr_err("%s: write back uboot failed\n", __func__);
		return -1;
	}

	return 0;
}
```

SPI NOR：

```654:667:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/spinor/spinor.c
sunxi_flash_spinor_download_toc(unsigned char *buffer, int len,  unsigned int ext)
{
	if (len / 512 + sunxi_flashmap_offset(FLASHMAP_SPI_NOR, TOC1) >
	    sunxi_flashmap_logical_offset(FLASHMAP_SPI_NOR, LINUX_LOGIC_OFFSET)) {
		printf("toc last block :0x%x, over write logical sector starts at block:0x%x\n"
		       "stop toc download\n",
		       sunxi_flashmap_offset(FLASHMAP_SPI_NOR, TOC1) + len / 512,
		       sunxi_flashmap_logical_offset(FLASHMAP_SPI_NOR, LINUX_LOGIC_OFFSET));
		return -1;
	}
	return (len/512) == _sunxi_flash_spinor_write(sunxi_flashmap_offset(FLASHMAP_SPI_NOR, TOC1), len/512, buffer) ? 0 : -1;
}
```

这就直接解释了你文档里的那句话：

> normal 启动里 read_boot_package() 也经常从固定 TOC1 区域读取

原因不是“normal 变 secure 了”，而是：

**normal 的 boot_package 本来就被放在 `TOC1` 这个二级启动固定槽位里。**

---

## 7. normal 的 `boot_package` 与 secure 的 `toc1`，内容不同，但“槽位/外层格式”高度共用

normal 的 `boot_package.cfg`：

```1:5:/home/alientek/A733/qihua-x73x-linux6.6/device/config/chips/a733/configs/default/boot_package.cfg
[package]
;item=Item_TOC_name,         Item_filename,
item=u-boot,                 u-boot.fex
item=monitor,                monitor.fex
item=scp,                   scp.fex
```

secure 的 `dragon_toc.cfg` 里 `toc1`：

```38:45:/home/alientek/A733/qihua-x73x-linux6.6/device/config/chips/a733/configs/default/dragon_toc.cfg
;item=Item_TOC_name,    Item_filename,  Cert_Name
[toc1]
rootkey=rootkey,	NULL,		rootkey.crtpt
item=monitor,		monitor.fex,	monitor.crtpt
item=optee,		optee.fex,	optee.crtpt
item=u-boot,		u-boot.fex,	u-boot.crtpt
onlykey=boot,		boot.fex,	boot.crtpt
item=scp,		scp.fex,	scp.crtpt
```

所以：

- **normal boot_package**：装的是 `u-boot/monitor/scp`
- **secure toc1**：装的是 `rootkey/cert/u-boot/optee/scp...`

但二者都属于“二级启动容器”，底层实现上共用了：
- TOC 头格式
- TOC1 固定存储区域
- `valid_len` 等字段
- 统一下载函数

这就是为什么 normal 流程里老能见到 `TOC1`。

---

# 二、具体烧录时，IMG 文件是怎么被烧进介质的

下面按“打包侧 -> `.img` 容器 -> 设备侧烧录 -> 落盘位置”串起来。

---

## 1. `build/pack` 先准备 `pack_out` 里的各个 `*.fex`

A733 的 `build/pack` 会把很多 boot 相关产物都准备到 `pack_out`，包括：

- `boot0_sdcard.fex`
- `boot0_nand.fex`
- `boot0_ufs.fex`
- `u-boot.fex`
- `monitor.fex`
- `scp.fex`
- `boot_package.fex`
- `toc0*.fex`
- `toc1.fex`

你当前 `pack_out/image_linux.cfg` 里也能直接看到这些 item 定义。

---

## 2. 打包脚本会根据 `PACK_SECURE` 选择 normal 还是 secure 的 programmer 镜像

最关键的分叉在这里：

```746:763:/home/alientek/A733/qihua-x73x-linux6.6/build/pack
	cd ${LICHEE_PACK_OUT_DIR}/

	if [ "x${PACK_SECURE}" = "xsecure" ]; then
		if [ -f toc0_sdcard.fex ] ; then
			programmer_img toc0_sdcard.fex toc1.fex ${out_img} > /dev/null
		elif [ -f toc0_nand.fex ] ; then
			programmer_img toc0_nand.fex toc1.fex ${out_img} > /dev/null
		else
			programmer_img toc0.fex toc1.fex ${out_img} > /dev/null
		fi
	else
		programmer_img boot0_sdcard.fex boot_package.fex ${out_img} > /dev/null
	fi

	if [ -f sunxi_gpt.fex ] ; then
		#create_img for sunxi_gpt.fex
		programmer_img sys_partition.bin sunxi_mbr.fex ${out_img} ${in_img} sunxi_gpt.fex > /dev/null
	else
```

这说明：

### normal 打包时
- boot0 用：`boot0_sdcard.fex`
- 二级启动包用：`boot_package.fex`

### secure 打包时
- boot0 用：`toc0_sdcard.fex` / `toc0_*`
- 二级启动包用：`toc1.fex`

---

## 3. 总 `.img` 里并不是“只能有一种 boot item”

`image.cfg` 本身是一个总清单，所以一个总 `.img` 容器里可以同时带：
- `boot_package.fex`
- `toc1.fex`
- `boot0_*`
- `toc0_*`
- 分区表
- 工具 item

这也是为什么你会看到 `.img` 容器层面有一些“普通 + secure 并存”的现象。

但要注意：

**“都打进总 `.img`” ≠ “都写入板子启动区”**

真正烧到设备上时，还是要看 `bootfile_mode` 和当前介质类型做二选一。

---

## 4. 烧录工具本质上是在传输 `.img` 容器；真正拆 item、选 subtype、写入 flash 的核心在设备侧 U-Boot sprite

你提到“结合烧录工具 + U-Boot 源码”。

从 SDK 结构看，这一代工具链大体是：
- PC 侧：PhoenixSuit / LiveSuit / card tool / usb tool 一类
- 设备侧：FEL/efex 进下载模式后，进入 U-Boot sprite 下载逻辑

**真正按 subtype 从 `.img` 中取 item 并写介质的关键逻辑，在设备侧 `sprite`。**

也就是说，PC 工具更多是在做：
- 把 `.img` 发给设备
- 发下载命令
- 控制烧录流程

而设备侧 U-Boot 决定：
- 打开哪一个 item
- 校验什么头
- 写到哪个固定偏移
- 是否写备份

---

## 5. 设备侧烧录时，normal 和 secure 选择不同的 IMG item

还是这段最关键：

```815:838:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/sprite/sprite_card.c
{
	char *buffer;
	buffer = (char *)memalign(CONFIG_SYS_CACHELINE_SIZE, ALIGN(4 * 1024 * 1024, CONFIG_SYS_CACHELINE_SIZE));
	uint item_original_size;
	if (gd->bootfile_mode == SUNXI_BOOT_FILE_NORMAL) {
		imgitemhd = Img_OpenItem(imghd, "12345678", "UBOOT_0000000000");
	} else if (gd->bootfile_mode == SUNXI_BOOT_FILE_PKG) {
		if (get_boot_storage_type() != STORAGE_NOR) {
			imgitemhd = Img_OpenItem(imghd, "12345678",
						 "BOOTPKG-00000000");
		} else {
			imgitemhd = Img_OpenItem(imghd, "12345678",
						 "BOOTPKG-NOR00000");
		}
	} else {
		imgitemhd = Img_OpenItem(imghd, "12345678", "TOC1_00000000000");
	}
```

也就是烧录时实际做的是：

### normal/package 模式
- 从 `.img` 打开 `BOOTPKG-00000000`
- 读入内存

### secure 模式
- 从 `.img` 打开 `TOC1_00000000000`
- 读入内存

---

## 6. 但这两种包最后都统一走 `sunxi_sprite_download_uboot()`

```163:184:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/sprite/sprite_download.c
int sunxi_sprite_download_uboot(void *buffer, int production_media, int generate_checksum)
{
	u32 length = 0;

	sbrom_toc1_head_info_t *toc1 = (sbrom_toc1_head_info_t *)buffer;

	if(toc1->magic != TOC_MAIN_INFO_MAGIC)
	{
		printf("sunxi sprite: toc magic is error\n");
		printf("need %s image\n", gd->bootfile_mode == SUNXI_BOOT_FILE_TOC ? "secure" : "normal");
		return -1;
	}
	length = toc1->valid_len;
	if(generate_checksum) {
		toc1->add_sum = sunxi_sprite_generate_checksum(buffer,
					toc1->valid_len,toc1->add_sum);
	}
```

这里已经说明：
- `boot_package.fex` 和 `toc1.fex` 在下载阶段都被当作 **TOC1 类容器**
- 都从 `magic` / `valid_len` 取长度
- 然后统一下载到 boot1 固定区域

---

## 7. 最终写入介质固定 boot 区，而不是写到普通文件分区

### MMC/eMMC/SD
写：
- `TOC1`
- `TOC1_BAK`

```143:160:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/mmc/sdmmc.c
sunxi_flash_mmc_download_toc(unsigned char *buf, int len,  unsigned int ext)
{
	if (!mmc_boot->block_dev.block_write(&mmc_boot->block_dev,
					       sunxi_flashmap_offset(FLASHMAP_SDMMC, TOC1),
					       len / 512, buf)) {
		pr_err("%s: write main uboot failed\n", __func__);
		return -1;
	}

	if (!mmc_boot->block_dev.block_write(
		    &mmc_boot->block_dev, sunxi_flashmap_offset(FLASHMAP_SDMMC, TOC1_BAK),
		    len / 512, buf)) {
		pr_err("%s: write back uboot failed\n", __func__);
		return -1;
	}
```

### SPI NOR
写：
- `TOC1` 固定偏移

```654:667:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/spinor/spinor.c
sunxi_flash_spinor_download_toc(unsigned char *buffer, int len,  unsigned int ext)
{
	if (len / 512 + sunxi_flashmap_offset(FLASHMAP_SPI_NOR, TOC1) >
	    sunxi_flashmap_logical_offset(FLASHMAP_SPI_NOR, LINUX_LOGIC_OFFSET)) {
		printf("toc last block :0x%x, over write logical sector starts at block:0x%x\n"
		       "stop toc download\n",
		       sunxi_flashmap_offset(FLASHMAP_SPI_NOR, TOC1) + len / 512,
		       sunxi_flashmap_logical_offset(FLASHMAP_SPI_NOR, LINUX_LOGIC_OFFSET));
		return -1;
	}
	return (len/512) == _sunxi_flash_spinor_write(sunxi_flashmap_offset(FLASHMAP_SPI_NOR, TOC1), len/512, buffer) ? 0 : -1;
}
```

所以：
- **normal 烧的是 `boot_package.fex`**
- **落盘位置仍然是 `TOC1` 区域**
- secure 的 `toc1.fex` 也是写这个槽位

两者是**替代关系**，不是并存关系。

---

## 8. boot0/toc0 也是同样逻辑：取不同 item，写同一类固定启动槽位

虽然你这次重点问的是 `TOC1`，但 boot0/toc0 的处理方式也类似：
- normal 模式：取 `boot0_*`
- secure 模式：取 `toc0_*`

所以整个启动区的本质是：

### normal
- 第一阶段：`boot0`
- 第二阶段：`boot_package`，落到 `TOC1`

### secure
- 第一阶段：`toc0`
- 第二阶段：`toc1`

---

## 9. 分区镜像再按 MBR/GPT 与 sys_partition 继续烧写

`build/pack` 在生成 programmer 镜像时，还会继续加入：
- `sys_partition.bin`
- `sunxi_mbr.fex`
- `sunxi_gpt.fex`

也就是除了启动区外，后续还会烧：
- GPT/MBR
- 各逻辑分区镜像

这部分和启动区是两套不同层次：
- **启动区**：`boot0/toc0` + `boot_package/toc1`
- **逻辑分区区**：boot/recovery/rootfs/vendor/userdata 等

---

# 三、把整个烧录流程串成一句“时序图”

你可以把 A733 的 `.img` 烧录理解成下面这条链：

## A. 打包阶段
1. 编译生成 `boot0/u-boot/monitor/scp/optee/...`
2. 普通模式用 `boot_package.cfg` 组 `boot_package.fex`
3. secure 模式用 `dragon_toc.cfg` 组 `toc0.fex + toc1.fex`
4. 用 `image.cfg` 把这些 item 和分区表一起封装进总 `.img`

## B. 进入烧录模式
1. PC 工具通过 FEL/efex/卡烧方式把 `.img` 与命令送到设备
2. 设备侧 U-Boot sprite 负责真正解析 `.img`

## C. 烧写 boot 区
1. 读取 secure bit / 工作模式
2. 设置 `gd->bootfile_mode`
3. 从 `.img` 中选：
   - normal -> `BOOTPKG`
   - secure -> `TOC1`
4. 校验 TOC 头
5. 写入 `TOC1` 固定区域
6. MMC/UFS 再写 `TOC1_BAK`

## D. 烧写一阶段启动块
1. normal -> `boot0_*`
2. secure -> `toc0_*`

## E. 烧写分区表与普通分区
1. 写 GPT/MBR
2. 按 sys_partition 写各分区镜像

---

# 四、和 A133/R818 老 SDK 的关系

你给的 A133/R818 SDK 也能看到同样的继承关系：

- 老 SDK 的 `image.cfg` 里也同时带：
  - `boot_package.fex`
  - `toc1.fex`
- 说明这不是 A733 新加的偶发现象，而是全志这套镜像/烧录架构一直如此

也就是说：

**A733 只是把这套“普通包 + secure 包共用总 manifest、烧录时由 mode 分流、介质上统一使用 TOC1 槽位”的机制延续了下来。**

---

# 五、直接回答你的两个问题

## 问题 1：为什么 normal 启动过程中，也经常见到 TOC1？

因为 `TOC1` 在这套 SDK/UBoot 里不是单纯“secure 启动专属名词”，而是：

1. 二级启动容器格式名
2. 介质上 boot1/U-Boot 固定槽位名
3. flash map 区域名

因此 **normal 模式下的 `boot_package.fex`**：
- 虽然不是 secure 的 `toc1.fex`
- 但它仍然可能使用 TOC 头格式
- 并且最终仍然写到/读自 `TOC1` 固定区域

所以 normal 启动里频繁看到 `TOC1` 是**架构复用导致的正常现象**，不代表系统实际上走了 secure 启动链。

---

## 问题 2：具体烧录 IMG 文件时会怎样烧写？

### normal 镜像时
- 从 `.img` 取 `boot0_sdcard.fex`
- 从 `.img` 取 `boot_package.fex`
- `boot_package.fex` 校验 TOC 头后，写入介质 `TOC1`
- 同时写 `TOC1_BAK`
- 再写 GPT/MBR 和普通分区

### secure 镜像时
- 从 `.img` 取 `toc0_sdcard.fex` 或其他介质版 `toc0_*`
- 从 `.img` 取 `toc1.fex`
- `toc1.fex` 写入介质 `TOC1`
- 同时写 `TOC1_BAK`
- 再写 GPT/MBR 和普通分区

### 所以最终差异是
- `.img` 内选哪个 boot item 不同
- boot0/toc0 内容不同
- toc1/boot_package 内容不同
- **但二级启动包最终都可能落到同一个 `TOC1` 固定区域**

---

如果你愿意，我下一步可以继续帮你做两件事中的任意一种：

1. 画一张 **A733 normal/secure 启动与烧录对照流程图**
2. 继续把你文档里的 `read_boot_package()` 那段，精确追到 **A733 具体源码文件和调用链**，把“启动读取 TOC1”的调用栈完整拉出来。

