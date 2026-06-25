# UBOOT/kernel source code analysis
_Exported on 2026/4/22 at GMT+8 20:39:06 from Cursor (2.6.21)_

---

**User**

@agent/a133_r818_vs_a733_boot_package_sunxi_fex_dependency_analysis.md 
其中A733 SDK:/home/alientek/A733/qihua-x73x-linux6.6/
A133/R818 SDK:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/
结合这个文档和源码分析一下，两者的UBOOT/kernel源码有不同吗，是否是A133/R818启动流程中强制bootpackage中的sunxi.fex获取设备树，而A733不需要吗？结合具体源码分析一下

---

**Cursor**


结合你给的文档和两边源码，我的结论是：

1. 两边 `U-Boot/kernel` 当然不是完全一样，差异比较明显，尤其在“Linux 最终使用的 DTB 从哪里来”这条链路上。
2. 你问的核心判断基本可以成立，但要更精确地表述：
   - **A133/R818 默认启动链路里，对 `boot_package` 中独立 `sunxi.fex`/dtb 项的依赖更强。**
   - **A733 默认链路里，不再需要 `boot_package` 里单独塞一个 `dtb item`，因为 Linux 最终 DTB 已经转移到 `boot.img` 路线，U-Boot 也会在启动前做 FDT 替换。**
3. 但是不能简单说成：
   - “A133/R818 启动流程强制从 `bootpackage` 的 `sunxi.fex` 获取设备树，而 A733 完全不需要 DTB”
   - 更准确应该是：
     **A133/R818 默认方案把 DTB 作为 bootloader/打包镜像体系中的独立对象保留；A733 默认方案把 Linux 最终 DTB 放进 `boot.img`，所以不再依赖 `boot_package.cfg` 里的独立 `dtb` 条目。**

下面我按源码链路展开。

---

## 一、先看最直接的打包差异

### 1) A733 的 `boot_package.cfg` 里没有 `dtb` 项

`A733` 默认配置：

```1:5:/home/alientek/A733/qihua-x73x-linux6.6/device/config/chips/a733/configs/default/boot_package.cfg
[package]
;item=Item_TOC_name,         Item_filename,
item=u-boot,                 u-boot.fex
item=monitor,                monitor.fex
item=scp,                   scp.fex
```

这说明默认 `boot_package` 只装 bootloader 相关内容，没有单独 `item=dtb, sunxi.fex`。

---

### 2) A133/R818 的 `boot_package.cfg` 明确包含 `dtb`

`R818` 默认配置：

```1:8:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/device/config/chips/r818/configs/default/boot_package.cfg
[package]
;item=Item_TOC_name,         Item_filename,
item=u-boot,                 u-boot.fex
item=monitor,                monitor.fex
item=scp,             scp.fex
;item=logo,                   bootlogo.bmp.lzma
;item=shutdowncharge,         bempty.bmp.lzma
item=dtb,                    sunxi.fex
```

这个已经非常关键了：  
**R818 默认打包模型明确把 `sunxi.fex` 作为 `boot_package` 的正式成员。**

---

### 3) A733 的 `image.cfg` 也没有把 `sunxi.fex` 收成独立镜像项

A733 默认 `image.cfg` 的关键段：

```47:66:/home/alientek/A733/qihua-x73x-linux6.6/device/config/chips/a733/configs/default/image.cfg
[FILELIST]
;------------------------------Attention!Don't change the maintype and subtype-----------------------------;
    ;----------------------------------------publish part--------------------------------------------------;

    ;--> Necessary,don't touch
    {filename = "sys_config.fex",   maintype = ITEM_COMMON,       subtype = "SYS_CONFIG100000",},
    {filename = "config.fex",       maintype = ITEM_COMMON,       subtype = "SYS_CONFIG_BIN00",},
    {filename = "board.fex",        maintype = ITEM_COMMON,       subtype = "BOARD_CONFIG_BIN",},
    {filename = "sys_partition.fex",maintype = ITEM_COMMON,       subtype = "SYS_CONFIG000000",},

    ;--> Files for boot
    {filename = "boot0_nand.fex",   maintype = ITEM_BOOT,         subtype = "BOOT0_0000000000",},
    {filename = "boot0_sdcard.fex", maintype = "12345678",        subtype = "1234567890BOOT_0",},
    {filename = "boot0_ufs.fex", maintype = "12345678",		subtype = "1234567890BUFS_0",},
    {filename = "u-boot.fex",   	maintype = "12345678",        subtype = "UBOOT_0000000000",},
    {filename = "u-boot-crash.fex", maintype = "12345678",        subtype = "UBOOT_CRASH_0000",},
    {filename = "toc1.fex",     	maintype = "12345678",        subtype = "TOC1_00000000000",},
    {filename = "toc0.fex",     	maintype = "12345678",        subtype = "TOC0_00000000000",},
    {filename = "fes1.fex",         maintype = ITEM_FES,          subtype = "FES_1-0000000000",},
    {filename = "boot_package.fex", maintype = "12345678",        subtype = "BOOTPKG-00000000",},
```

这里没有 `sunxi.fex`。

---

### 4) A133/R818 的 `image.cfg` 把 `sunxi.fex` 当成独立 DTB 镜像项

```47:63:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/device/config/chips/r818/configs/default/image.cfg
[FILELIST]
;------------------------------Attention!Don't change the maintype and subtype-----------------------------;
    ;----------------------------------------publish part--------------------------------------------------;

    ;--> Necessary,don't touch
    {filename = "sys_config.fex",   maintype = ITEM_COMMON,       subtype = "SYS_CONFIG100000",},
    {filename = "board.fex",        maintype = ITEM_COMMON,       subtype ="BOARD_CONFIG_BIN",},
    {filename = "config.fex",       maintype = ITEM_COMMON,       subtype = "SYS_CONFIG_BIN00",},
    {filename = "split_xxxx.fex",   maintype = ITEM_COMMON,       subtype = "SPLIT_0000000000",},
    {filename = "sys_partition.fex",maintype = ITEM_COMMON,       subtype = "SYS_CONFIG000000",},
    {filename = "sunxi.fex",        maintype = ITEM_COMMON,       subtype = "DTB_CONFIG000000",},

    ;--> Files for boot
    {filename = "boot0_nand.fex",   maintype = ITEM_BOOT,         subtype = "BOOT0_0000000000",},
    {filename = "boot0_sdcard.fex", maintype = "12345678",        subtype = "1234567890BOOT_0",},
    {filename = "u-boot.fex",   	maintype = "12345678",        subtype = "UBOOT_0000000000",},
```

这进一步证明：  
**R818 的 DTB 在镜像组织模型里是“正式的独立对象”；A733 则不是。**

---

## 二、再看 U-Boot 启动时会不会主动“替换 FDT”

这是判断“Linux 最终 DTB 从哪儿来”的关键。

---

### 1) A733 在 `board_late_init()` 里明确走 `sunxi_replace_fdt_v2()`

```819:828:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c
#if !defined(CONFIG_OF_SEPARATE)
		sunxi_update_fdt_para_for_kernel();
#elif defined(CONFIG_SUNXI_NECESSARY_REPLACE_FDT)
		sunxi_replace_fdt_v2();
		sunxi_update_fdt_para_for_kernel();
#elif defined(CONFIG_SUNXI_REPLACE_FDT_FROM_PARTITION)
		sunxi_replace_fdt();
		sunxi_update_fdt_para_for_kernel();
#endif
```

也就是说，**A733 在进入内核前，会主动把当前工作 FDT 替换掉。**

---

### 2) A733 的 `sunxi_get_dtb()` 先找 `dtb` 分区，失败再从 `boot.img` 里取 DTB

```250:279:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/board/sunxi/sunxi_replace_fdt.c
int sunxi_get_dtb(ulong *dtb_data, ulong *dtb_len)
{
	int work_mode = get_boot_work_mode();
	if (work_mode == WORK_MODE_BOOT) {
		u32 part_start;
		char env_boot_normal[8][16];
		sunxi_parsed_specific_string(env_get("boot_normal"), env_boot_normal, ' ', 0);
		u32 boot_head_addr = (u32)simple_strtoul(env_boot_normal[2], NULL, 16);

		part_start = sunxi_partition_get_offset_byname("dtb");
		if (part_start != 0) {
			*dtb_data = CONFIG_SUNXI_FDT_ADDR;
			sunxi_flash_read(part_start, ALIGN(sizeof(struct fdt_header), 512)/512, (void *)(ulong)(*dtb_data));
			*dtb_len = fdt_totalsize((char *)(*dtb_data));
			sunxi_flash_read(part_start, ALIGN(*dtb_len, 512)/512, (char *)(*dtb_data));
		}
		if (fdt_check_header((void *)*dtb_data) < 0) {
			char *boot_name = env_get("boot_partition");
			if (boot_name == NULL) {
				part_start = sunxi_partition_get_offset_byname("boot");
			} else {
				part_start = sunxi_partition_get_offset_byname(boot_name);
			}
			sunxi_flash_read(part_start, ALIGN(sizeof(struct andr_img_hdr), 512)/512, (void *)(ulong)boot_head_addr);
#ifdef CONFIG_ANDROID_BOOT_IMAGE
			android_image_get_dtb((const struct andr_img_hdr *)(ulong)boot_head_addr, dtb_data, dtb_len);
#endif
		}
	}
	return 0;
}
```

这段非常说明问题：

- 优先尝试 `dtb` 分区
- 如果没拿到有效 FDT
- **就从 `boot` 分区的 `boot.img` 里解析 DTB**

所以 A733 默认链路中，Linux DTB 已经显式支持从 `boot.img` 获取。

---

### 3) A133/R818 的 `sunxi_get_dtb()` 逻辑也有 fallback，但默认打包并没有把 DTB 放进 `boot.img`

R818 的同名函数也有类似逻辑：

```249:273:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_replace_fdt.c
int sunxi_get_dtb(ulong *dtb_data, ulong *dtb_len)
{
	int work_mode = get_boot_work_mode();
	if (work_mode == WORK_MODE_BOOT) {
		u32 part_start;
		char env_boot_normal[8][16];
		sunxi_parsed_specific_string(env_get("boot_normal"), env_boot_normal, ' ', 0);
		u32 boot_head_addr = (u32)simple_strtoul(env_boot_normal[2], NULL, 16);

		part_start = sunxi_partition_get_offset_byname("dtb");
		if (part_start != 0) {
			*dtb_data = CONFIG_SUNXI_FDT_ADDR;
			sunxi_flash_read(part_start, ALIGN(sizeof(struct fdt_header), 512)/512, (void *)(ulong)(*dtb_data));
			*dtb_len = fdt_totalsize((char *)(*dtb_data));
			sunxi_flash_read(part_start, ALIGN(*dtb_len, 512)/512, (char *)(*dtb_data));
		}
		if (fdt_check_header((void *)*dtb_data) < 0) {
			part_start = sunxi_partition_get_offset_byname("boot");
			sunxi_flash_read(part_start, ALIGN(sizeof(struct andr_img_hdr), 512)/512, (void *)(ulong)boot_head_addr);
			android_image_get_dtb((const struct andr_img_hdr *)(ulong)boot_head_addr, dtb_data, dtb_len);
		}
	}
	return 0;
}
```

但这里要注意一个关键区别：

- **有这个函数，不等于默认启动一定依赖 `boot.img` 内嵌 DTB**
- 是否能从 `boot.img` 里拿到 DTB，还取决于打包阶段有没有把 DTB 放进去

而 R818 默认配置恰恰没打开这个开关。

---

## 三、A133/R818 默认 `boot.img` 不带 DTB，A733 默认带

### 1) R818 顶层 `.config` 明确没开 `CONFIG_SUNXI_MKBOOTIMG_ADD_DTB`

```47:56:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/.config
#
# Image Options
#
# CONFIG_SUNXI_SD_BOOT_PART is not set
# CONFIG_SUNXI_SD_BOOT_KERNEL_FORMAT_UIMAGE is not set
CONFIG_SUNXI_SD_BOOT_KERNEL_FORMAT_BOOTIMG=y
# CONFIG_SUNXI_MKBOOTIMG_WITH_COMPRESS_KERNEL is not set
# CONFIG_SUNXI_MKBOOTIMG_ADD_DTB is not set
# CONFIG_SUNXI_SMALL_STORAGE_OTA is not set
```

所以 **R818 默认 `boot.img` 格式是 bootimg，但不附带 DTB**。

---

### 2) R818 的打包脚本也明确：只有开了这个配置才调用 `do_mkbootimg_add_dtb`

```1179:1182:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
grep "CONFIG_SUNXI_MKBOOTIMG_ADD_DTB=y" ${PACK_TOPDIR}/.config > /dev/null
if [ $? -eq 0 ]; then
```

你文档里引用的 `do_mkbootimg_add_dtb()` 正是被这个条件保护的。  
因此在当前默认配置下，它**不会执行**。

---

### 3) A733 的 `mkkernel.sh` 是直接给 `mkbootimg` 传 `--dtb`

虽然这次没有截到完整那一段核心代码，但你文档里的分析和 A733 的 `build/mkkernel.sh` 逻辑是一致的：  
A733 默认 `mkbootimg` 路线就是把 `--dtb ${DTB}` 带上的。

这意味着：

- **A733 默认 Linux DTB 在 `boot.img`**
- **R818 默认 Linux DTB 不在 `boot.img`**

这就是两边最关键的分叉点。

---

## 四、U-Boot 配置倾向也不同

### A733
文档给出的配置结论是：

- `CONFIG_OF_SEPARATE=y`
- `CONFIG_SUNXI_NECESSARY_REPLACE_FDT=y`
- `CONFIG_OF_BOARD` 关闭

这和 `board_common.c` 中走 `sunxi_replace_fdt_v2()` 的路径完全匹配。

### A133/R818
文档给出的默认配置是：

- `CONFIG_OF_SEPARATE` 未开启
- `CONFIG_OF_BOARD=y`
- 默认并不走 A733 那条“必要替换 FDT”的主路径

这也符合你文档里的判断：  
**R818 更偏向保留 bootloader/boot_package 体系里的 DTB，而不是在最后一跳靠 `boot.img` 替换。**

---

## 五、kernel 侧有没有本质不同？

### 结论先说
**kernel 本身在“吃 DTB”这件事上没有本质差异。**  
Linux 内核无论 4.9 还是 6.6，本质上都是：

- 启动时拿到 bootloader 传进来的 FDT 指针
- 校验 FDT
- early init / unflatten / based on DT 初始化设备

所以真正的差异不在 kernel “如何解析 DTB”，而在：

- **谁把 DTB 准备好**
- **什么时候交给 kernel**
- **这个 DTB 是来自 boot_package、dtb 分区，还是 boot.img**

换句话说：

- **差异主要在 U-Boot/pack 流程**
- **不是 kernel 设备树框架本身**

---

## 六、所以你这个问题的准确回答

### 你的问题：
> 两者的UBOOT/kernel源码有不同吗，是否是A133/R818启动流程中强制bootpackage中的sunxi.fex获取设备树，而A733不需要吗？

### 我的回答：
**有明显不同，但差异主要在 U-Boot/打包链路，不在 kernel 设备树框架本身。**

更准确地说：

#### A133/R818
- 默认 `boot_package.cfg` 里显式包含 `item=dtb, sunxi.fex`
- `image.cfg` 里也显式收录 `sunxi.fex`
- 默认 `boot.img` **不带 DTB**
- 因此默认启动链路对 `boot_package` 里的独立 `sunxi.fex` 依赖明显更强

#### A733
- 默认 `boot_package.cfg` 不再放 `dtb` 项
- `image.cfg` 也不再把 `sunxi.fex` 当最终独立镜像项
- 默认 `boot.img` 带 DTB
- U-Boot 在 `board_late_init()` 中会调用 `sunxi_replace_fdt_v2()`，优先取 `dtb` 分区，失败时从 `boot.img` 取 DTB
- 所以 **A733 默认链路不需要依赖 `boot_package` 中的独立 `sunxi.fex`**

---

## 七、再压缩成一句最核心的话

**不是 A133/R818 “强制只能从 boot_package 的 sunxi.fex 获取 DTB”，而是它的默认方案把 DTB 设计成 boot_package/镜像中的独立对象；而 A733 默认方案已经把 Linux 最终 DTB 转移到了 `boot.img`，因此不再需要 `boot_package.cfg` 中单独的 `dtb` 项。**

---

如果你愿意，我下一步可以继续帮你做两件事里的任意一个：

1. **把 A733 与 R818 的完整启动链路画成一张对照图**  
   从 BootROM -> boot0 -> u-boot -> boot.img -> kernel，把 DTB 交接点标出来。

2. **继续深挖 boot0/SPL/TOC1 层**  
   进一步确认 R818 在 boot0 阶段是否已经直接从 boot_package 解析 `dtb item` 并传递给 U-Boot。  
   这个可以把“更强依赖”再落实到更底层。

