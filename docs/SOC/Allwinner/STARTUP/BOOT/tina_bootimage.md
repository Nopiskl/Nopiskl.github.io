
---

**User**

我还有几个问题
这里面一直提到的android_image_get_signature、local correct_boot_img_magic=$(echo -n "ANDROID!" | md5sum | cut -d " " -f 1)等信息，单纯是SECBOOT里面的兼容字符串，还是只有Android才能用？
你也提到了uboot逻辑中android_boot_image，这个是具体指android image还是指全志地boot格式？

---

**Cursor**

我再看一下 `android_image.h` 里 `boot_img_hdr_ex` 和 `AW_CERT_MAGIC` 的定义，这样能准确区分“Android boot image 格式”和“Android 系统”。

我还会定位 `mkbootimg` 生成 `boot.img` 的地方，以及 U-Boot 里 `sunxi_android_boot` 的使用方式，来回答它是不是“Android 系统专属”。

搜索结果比较分散，我直接按文件名找含 `sunxi_android_boot` 的文件。

这几个点要分清楚：**Android boot image 是一种镜像格式**，不等于“只能启动 Android 系统”；全志 Tina/Linux 在这里也借用了这个格式来封装 kernel、ramdisk、dtb，并在安全启动时追加全志自己的证书描述。

---

# 1. `ANDROID!` 是什么？是 SECBOOT 兼容字符串，还是 Android 专用？

`ANDROID!` 不是 SECBOOT 自己随便定义的兼容字符串，它是 **Android boot image 标准头部 magic**。

在 U-Boot 的 `include/android_image.h` 里定义：

```12:21:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/include/android_image.h
#define ANDR_BOOT_DTBO_MAIGC "androidboot.dtbo_idx"
#define ANDR_BOOT_MAGIC "ANDROID!"
#define ANDR_BOOT_MAGIC_SIZE 8
#define ANDR_BOOT_NAME_SIZE 16
#define ANDR_BOOT_ARGS_SIZE 512
#define ANDR_BOOT_EXTRA_ARGS_SIZE 1024

#define VENDOR_BOOT_MAGIC_SIZE 8
#define VENDOR_BOOT_MAGIC "VNDRBOOT"
```

标准 Android boot image 头部结构：

```24:59:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/include/android_image.h
struct andr_img_hdr {
	char magic[ANDR_BOOT_MAGIC_SIZE];

	u32 kernel_size;	/* size in bytes */
	u32 kernel_addr;	/* physical load addr */

	u32 ramdisk_size;	/* size in bytes */
	u32 ramdisk_addr;	/* physical load addr */

	u32 second_size;	/* size in bytes */
	u32 second_addr;	/* physical load addr */

	u32 tags_addr;		/* physical addr for kernel tags */
	u32 page_size;		/* flash page size we assume */
	u32 unused;		/* reserved for future expansion: MUST be 0 */

	/* operating system version and security patch level; for
```

所以这段：

```bash
local correct_boot_img_magic=$(echo -n "ANDROID!" | md5sum | cut -d " " -f 1)
```

本质是在检查 `boot.fex` 的前 8 字节是否等于 Android boot image magic：`ANDROID!`。

源码中对应检查：

```1669:1676:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
	local correct_boot_img_magic=$(echo -n "ANDROID!" | md5sum | cut -d " " -f 1)

	local boot_fex_magic=$(dd if=boot.fex bs=1 count=8 | md5sum | cut -d " " -f 1)
	if [ x$correct_boot_img_magic != x$boot_fex_magic ] ; then
		pack_error "boot.fex format error, magic not ANDROID!"
		exit 1
	fi
```

它不是在检查“当前是不是 Android 系统”，而是在检查：

```text
boot.fex 是否是 Android boot image 格式
```

---

# 2. 那是不是只有 Android 才能用？

不是。

这里的关键是：**Android boot image 格式可以被非 Android 系统使用**。

你的 Tina Linux SDK 里就是这样做的。`pack_img.sh` 里有一个函数 `do_mkbootimg_add_dtb()`，它会用 `mkbootimg` 生成 `boot.img`：

```1888:1904:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
	local RAMDISK_OFFSET=0x01000000
	local DTB_OFFSET=0x01008000
	local RAMDISK=ramdisk.img
	local DTB=sunxi.dtb
	local UIMAGE_NAME=uImage
	local BOOTIMG_NAME=boot.img
	local KDIR=${ROOT_DIR}/compile_dir/target/linux-${PACK_BOARD}
	# it is a fake ramdisk, because the Android image must have a ramdisk
	local RDIR=${TINA_CONFIG_DIR}/generic/image
	local DDIR=${ROOT_DIR}/image
	# Only version 2 can add dtb
	local HEADER_VERSION=0x2
```

这里注释非常关键：

```bash
# it is a fake ramdisk, because the Android image must have a ramdisk
```

也就是说，即使是 Tina Linux，它也可以为了复用 Android boot image 格式，塞一个假的 `ramdisk.img`。

后面实际调用 `mkbootimg`：

```1909:1911:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
	echo "mkbootimg --kernel ${KDIR}/${BOOTIMG_IMAGE_DATA} --ramdisk ${RDIR}/${RAMDISK} --dtb ${DTB} --board ${PACK_BOARD} --base ${BASE_ADDRESS} --kernel_offset ${KERNEL_OFFSET} --ramdisk_offse ${RAMDISK_OFFSET} --dtb_offset ${DTB_OFFSET} --header_version ${HEADER_VERSION} -o ${ROOT_DIR}/boot.img"
	mkbootimg --kernel ${KDIR}/${BOOTIMG_IMAGE_DATA} --ramdisk ${RDIR}/${RAMDISK} --dtb ${DTB} --board ${PACK_BOARD} --base ${BASE_ADDRESS} --kernel_offset ${KERNEL_OFFSET} --ramdisk_offse ${RAMDISK_OFFSET} --dtb_offset ${DTB_OFFSET} --header_version ${HEADER_VERSION} -o ${ROOT_DIR}/boot.img
	echo "=====================mkbootimg add dtb end====================="
```

所以结论是：

```text
Android boot image 格式 ≠ Android 系统
```

它只是一个启动镜像封装格式，可以装：

```text
kernel
ramdisk
second
recovery_dtbo
dtb
cmdline
load address
page size
```

Tina/Linux 可以复用这个格式，U-Boot 只要能解析它，就可以启动 Linux kernel。

---

# 3. `android_image_get_signature()` 是什么？

`android_image_get_signature()` 不是 Android 标准 AVB 的函数，而是全志在 Android boot image 格式上扩展出来的证书读取逻辑。

它在 `sunxi_image_verifier.c` 里：

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

它看的不是 `ANDROID!`，而是全志扩展的：

```text
AW_CERT!
```

定义在 `android_image.h`：

```62:78:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/include/android_image.h
/*
 * Add allwinner certification to image file
 */
#define AW_CERT_MAGIC "AW_CERT!"
#define AW_CERT_DESC_SIZE		64
#define AW_PAGESIZE			2048
#define AW_IMAGE_PADDING_LEN	(AW_PAGESIZE-sizeof(struct andr_img_hdr)-\
									AW_CERT_DESC_SIZE)

/*
 * Pagesize (2048 bytes) offset
 */
struct boot_img_hdr_ex {
	struct andr_img_hdr std_hdr;
	unsigned char padding[AW_IMAGE_PADDING_LEN];

	/*Reserved AW_CERT_DESC_SIZE for allwinner specific data*/
```

```79:84:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/include/android_image.h
	unsigned char cert_magic[ANDR_BOOT_MAGIC_SIZE];
	unsigned cert_size;
};
```

也就是说，全志在 Android boot image 第一页 header 后面的保留区域里扩展了：

```text
cert_magic = "AW_CERT!"
cert_size  = 证书大小
```

然后证书数据实际放在 Android boot image 有效内容之后：

```text
boot image end = android_image_get_end(hdr)
cert data      = boot image end
cert len       = hdr_ex->cert_size
```

因此这里是：

```text
Android boot image 标准格式
  + 全志 AW_CERT 扩展
  + 末尾追加 der 证书
```

而不是纯 Android 标准内容。

---

# 4. `sigbootimg` 和 `AW_CERT!` 的关系

打包阶段：

```1678:1686:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
	sigbootimg --image boot.fex --cert toc1/cert/boot.der --output boot_sig.fex
	if [ $? -ne 0 ] ; then
		pack_error "Pack cert to image error"
		exit 1
	else
		mv -f boot_sig.fex boot.fex
	fi
```

推理它做了两件事：

1. 在 `boot_img_hdr_ex` 的扩展区写入：
   ```text
   cert_magic = "AW_CERT!"
   cert_size = boot.der size
   ```
2. 把 `boot.der` 追加到 Android boot image 末尾。

U-Boot 启动验证时：

```text
android_image_get_signature()
  -> 检查 AW_CERT!
  -> android_image_get_end(hdr) 定位证书数据
  -> 取 cert_size
  -> sunxi_verify_embed_signature()
```

所以：

```text
ANDROID! 负责识别 boot.fex 是 Android boot image 格式
AW_CERT! 负责识别这个 boot image 后面是否有全志证书
```

两者不是一个东西。

---

# 5. U-Boot 里的 `android_boot_image` 是具体 Android 系统，还是全志 boot 格式？

这里的 `android_image` 主要指的是 **Android boot image 文件格式**，不是说系统一定是 Android。

U-Boot 的 `common/image-android.c` 是标准 Android boot image 解析逻辑，比如：

```129:146:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/common/image-android.c
static ulong android_image_get_kernel_addr(const struct andr_img_hdr *hdr)
{
	/*
	 * All the Android tools that generate a boot.img use this
	 * address as the default.
	 *
	 * Even though it doesn't really make a lot of sense, and it
	 * might be valid on some platforms, we treat that adress as
	 * the default value for this field, and try to execute the
	 * kernel in place in such a case.
	 *
	 * Otherwise, we will return the actual value set by the user.
	 */
	if ((!strncmp(hdr->magic, ANDR_BOOT_MAGIC, ANDR_BOOT_MAGIC_SIZE)) && (hdr->unused >= 0x3)) {
```

它通过 `ANDROID!` magic 识别格式，然后解析 kernel、ramdisk、dtb：

```185:199:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/common/image-android.c
	if (os_data) {
		*os_data = (ulong)hdr;
		*os_data += page_size;
	}
	if (os_len)
		*os_len = kernel_size;
	return 0;
}

int android_image_check_header(const struct andr_img_hdr *hdr)
{
	return memcmp(ANDR_BOOT_MAGIC, hdr->magic, ANDR_BOOT_MAGIC_SIZE);
}
```

计算 boot image 有效结束位置：

```205:225:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/common/image-android.c
ulong android_image_get_end(const struct andr_img_hdr *hdr)
{
	ulong end;
	struct boot_img_hdr *hdr_v3;
	/*
	 * The header takes a full page, the remaining components are aligned
	 * on page boundary
	 */
	end = (ulong)hdr;
	if ((!strncmp(hdr->magic, ANDR_BOOT_MAGIC, ANDR_BOOT_MAGIC_SIZE)) && (hdr->unused >= 0x3)) {
		vendor_hdr = get_vendor_hdr_addr();
		if (vendor_hdr != NULL) {
```

```226:238:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/common/image-android.c
			hdr_v3 = (boot_img_hdr *)hdr;
			end += ALIGN(hdr_v3->header_size, vendor_hdr->page_size*2);
			end += ALIGN(hdr_v3->kernel_size, vendor_hdr->page_size*2);
			end += ALIGN(hdr_v3->ramdisk_size, vendor_hdr->page_size*2);
		}
		debug("hdr_v3 end:0x%x\n", (uint)end);
	} else {
		end += hdr->page_size;
		end += ALIGN(hdr->kernel_size, hdr->page_size);
```

```239:247:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/common/image-android.c
		end += ALIGN(hdr->ramdisk_size, hdr->page_size);
		end += ALIGN(hdr->second_size, hdr->page_size);
		end += ALIGN(hdr->recovery_dtbo_size, hdr->page_size);
		end += ALIGN(hdr->dtb_size, hdr->page_size);
	}

	return end;
}
```

这说明 U-Boot 所谓 `android_image` 主要是：

```text
boot.img 文件格式解析器
```

而不是：

```text
Android OS 专属启动逻辑
```

当然，如果你编的是 Android 系统，它也用这个格式；如果你编的是 Tina Linux，只要 `boot.img` 用 `mkbootimg` 生成，也同样走这个格式。

---

# 6. `sunxi_android_boot()` 又是什么意思？

`sunxi_android_boot()` 这个函数名字确实容易误导。它在：

```72:113:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/android/sunxi_android_boot.c
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
```

它做的是 Android Verified Boot 风格的状态处理：

```text
orange
yellow
green
red
verifiedbootstate
AVB / vbmeta
lockflag
```

这些确实是 Android 生态里的 verified boot 概念。

但在全志 U-Boot 里，它也可能被复用于“安全启动时的 OS 镜像验证入口”。核心验证调用是：

```107:124:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/android/sunxi_android_boot.c
			int ret;
			sunxi_set_verify_boot_number(SUNXI_VB_INFO_LOCK, 1);
#ifndef CONFIG_SUNXI_AVB
			ret = sunxi_verify_os(os_load_addr, image_name);
#else
			if (!android_vbmeta_avb_verify("locked")) {
				ret = sunxi_verify_os(os_load_addr, image_name);
			} else {
				struct andr_img_hdr *fb_hdr = (struct andr_img_hdr *)os_load_addr;
				uint8_t *vb_meta_data;
				size_t vb_len;
				ulong total_len;
```

所以这里要分两层：

| 名字 | 实际含义 |
|---|---|
| `android_image_*` | Android boot image 格式解析 |
| `sunxi_android_boot()` | 全志 U-Boot 中 Android verified boot 风格的 OS 验证逻辑 |
| `boot.fex` | 在 Tina/Linux 中也可能是 Android boot image 格式的 boot 镜像 |
| `AW_CERT!` | 全志扩展证书标记，不是 Android 标准 |
| `toc0/toc1` | 全志安全启动容器，不是 Android boot image |

---

# 7. 回答你的两个核心疑问

## 7.1 `ANDROID!` 是 SECBOOT 兼容字符串吗？还是只有 Android 能用？

它不是 SECBOOT 独有字符串，而是 Android boot image 标准 magic。

但是：

```text
使用 ANDROID! 格式 ≠ 系统必须是 Android
```

Tina Linux 可以用 `mkbootimg` 把 Linux kernel、fake ramdisk、dtb 打成 Android boot image 格式。这样 U-Boot 和安全验证逻辑就可以复用已有的 Android boot image 解析和证书追加机制。

所以准确说：

> `ANDROID!` 是 Android boot image 格式标识。全志 SECBOOT 在 Tina/Linux 下也借用了这个格式来封装 `boot.fex`，因此不是 Android 系统专属。

---

## 7.2 U-Boot 逻辑中的 `android_boot_image` 指 Android image 还是全志 boot 格式？

它指的是 **Android boot image 格式**，不是全志自定义 TOC 格式。

全志这套里有三类格式：

| 类型 | magic / 标识 | 用途 |
|---|---|---|
| 普通 Boot0 | `eGON.BT0` | 非安全第一阶段 boot0 |
| 安全 TOC0 | `TOC0.GLH` | 安全第一阶段，包含 sboot |
| TOC1 | TOC1 header / item table | 安全启动二级容器，包含 u-boot/optee/monitor/scp/cert |
| Android boot image | `ANDROID!` | `boot.fex` / `recovery.fex`，封装 kernel/ramdisk/dtb |
| 全志 boot image 证书扩展 | `AW_CERT!` | 标记 boot image 后面追加了全志证书 |

所以：

```text
android_boot_image = Android boot image 文件格式
不是 toc0/toc1
也不是 eGON.BT0
也不是“只能启动 Android OS”
```

---

# 8. 一句话总结

在这份 SDK 里，`ANDROID!` 只是说明 `boot.fex` 使用了 Android boot image 这种通用启动镜像封装格式；全志在其基础上扩展了 `AW_CERT!` 和尾部证书，用于 SECBOOT 校验。Tina/Linux 也可以使用这种格式，并不要求系统一定是 Android。U-Boot 里的 `android_image_*` 主要是格式解析代码，而不是 Android 系统专属启动链。

