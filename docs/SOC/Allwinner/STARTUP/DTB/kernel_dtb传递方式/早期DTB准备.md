
---

**Cursor**

我继续把两条链路往前追到 boot0/SPL 和打包脚本，分别确认：
1. A133 的独立 DTB 何时、由谁交给 U-Boot；
2. A733 早期基础 `working_fdt` 的来源，以及 `u-boot.fex` 尾部 DTB 的编译和打包路径。

---

# 1. A133：boot_package / TOC 独立 DTB 是何时交给 U-Boot 的？

## 1.1 boot0 阶段就把整个 boot package/TOC1 装进来了

A133 的 `boot0_main.c` 主流程非常关键：

```1:83:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
void main(void)
{
	...
	status = load_package();
	if(status == 0 )
		load_image(&uboot_base, &optee_base, &monitor_base, &rtos_base, &opensbi_base);
	else
		goto _BOOT_ERROR;

	update_uboot_info(uboot_base, optee_base, monitor_base, rtos_base, dram_size,
			pmu_type, uart_input_value, key_input);
	...
	else
		boot0_jmp(uboot_base);
}
```

这说明 boot0 的顺序是：

1. `load_package()`
2. `load_image()`
3. `update_uboot_info()`
4. 跳转 `uboot_base`

也就是说，**boot package 的装载发生在进入 U-Boot 之前**。

---

## 1.2 boot0 明确把 TOC1 头放在 `CONFIG_BOOTPKG_BASE`

更关键的是 `update_uboot_info()`：

```93:113:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/nboot/main/boot0_main.c
static void update_uboot_info(phys_addr_t uboot_base, phys_addr_t optee_base,
		phys_addr_t monitor_base, phys_addr_t rtos_base, u32 dram_size,
		u16 pmu_type, u16 uart_input, u16 key_input)
{
	...
	uboot_head_t  *header = (uboot_head_t *) uboot_base;
	struct sbrom_toc1_head_info *toc1_head = (struct sbrom_toc1_head_info *)CONFIG_BOOTPKG_BASE;

	header->boot_data.boot_package_size = toc1_head->valid_len;
	...
}
```

这里直接说明：

- boot0 认为 **`CONFIG_BOOTPKG_BASE` 上就是 TOC1/boot_package**
- 并且把它的 `valid_len` 写给了 U-Boot header 的 `boot_package_size`

这就能确认：

> **A133 的 boot0 在跳转二阶段 U-Boot 前，已经把整个 boot package/TOC1 放到 DRAM 固定地址了。**

---

## 1.3 A133 的 TOC1 结构里明确支持独立 `dtb` item

A133 的 `private_toc.h` 里：

```52:80:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/include/private_toc.h
typedef struct sbrom_toc1_head_info
{
	...
	u32  items_nr;
	u32  valid_len;
	...
} sbrom_toc1_head_info_t;

typedef struct sbrom_toc1_item_info
{
	char name[64];
	u32  data_offset;
	u32  data_len;
	...
} sbrom_toc1_item_info_t;
```

并且 item 名字里明确有：

```143:155:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/spl/include/private_toc.h
#define ITEM_PARAMETER_NAME             "parameter"
#define ITEM_OPTEE_NAME                 "optee"
#define ITEM_SCP_NAME                   "scp"
#define ITEM_MONITOR_NAME               "monitor"
#define ITEM_UBOOT_NAME                 "u-boot"
#define ITEM_RTOS_NAME                  "freertos"
#define ITEM_OPENSBI_NAME               "opensbi"
#define ITEM_LOGO_NAME                  "logo"
#define ITEM_DTB_NAME                   "dtb"
#define ITEM_DTBO_NAME                  "dtbo"
```

这说明：

- TOC1/boot package 内部 item 机制天然支持独立 `dtb`
- A133 的 boot0 装进来的不是“只有 u-boot 的包”，而是 **包含多 item 的 boot package**

---

## 1.4 A133 的 boot_package.cfg 确实把 `sunxi.fex` 作为独立 dtb item 放进去了

A133 实际产物配置：

```1:7:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/out/r818-sc3917/image/boot_package.cfg
[package]
;item=Item_TOC_name,         Item_filename,
item=u-boot,                 u-boot.fex
item=monitor,                monitor.fex
item=scp,             scp.fex
item=dtb,                    sunxi.fex
```

所以这条链路已经非常明确：

- `boot_package.cfg` 定义 `item=dtb, sunxi.fex`
- boot0 `load_package()` 把整个 TOC1/boot package 装到 `CONFIG_BOOTPKG_BASE`
- 然后二阶段 U-Boot 接手

---

## 1.5 所以 A133 的“独立 DTB 何时被交给 U-Boot”？

可以明确回答：

### 时间点
**在 boot0 阶段的 `load_package()` / `load_image()` 之后、跳转 `boot0_jmp(uboot_base)` 之前。**

### 交付形式
**不是“单独把 dtb 指针传给 U-Boot”**，而是：

- 先把整个 TOC1/boot package 放到 `CONFIG_BOOTPKG_BASE`
- 再把 `boot_package_size` 写进 U-Boot 头
- U-Boot 启动后即可继续基于这份 boot package 解析各 item，包括 `dtb`

---

## 1.6 但要特别注意一个边界

### 我现在能确认的
- **独立 DTB 已经在 boot0 阶段进入 DRAM，并交给了 U-Boot 可访问范围**

### 我还没 100% 抓到的
- **U-Boot 内部“哪个具体函数”把 TOC1 里的 `item=dtb` 抽出来并变成 early `working_fdt`**

所以目前最严谨的表达是：

> **A133 的独立 DTB 在 boot0 装载 TOC1/boot package 时，就已经交给了二阶段 U-Boot 可访问范围；但从目前已追到的 `gd->fdt_blob / working_fdt` 首次赋值链路看，early `working_fdt` 的第一次来源仍是 U-Boot 自身镜像尾部 DTB。`sunxi_update_fdt_para_for_kernel()` 只是后面对已有 `working_fdt` 的修补，不是取 DTB 的地方。**

---

# 2. A733：U-Boot 早期那份基础 `working_fdt` 是怎么来的？

这一条现在证据已经比较完整了。

---

## 2.1 A733 的 boot_package 默认已经不放独立 dtb item

A733 实际产物里：

```1:5:/home/alientek/A733/qihua-x73x-linux6.6/out/a733/x733mhn_aic8800/pack_out/boot_package.cfg
[package]
;item=Item_TOC_name,         Item_filename,
item=u-boot,                 u-boot.fex
item=monitor,                monitor.fex
item=scp,                   scp.fex
```

没有 `item=dtb, sunxi.fex`。

这意味着：

> **A733 默认不会像 A133 那样，把 Linux DTB 当成 boot package 的独立 item。**

---

## 2.2 但 A733 U-Boot 早期又必须先有一份可工作的 FDT

因为 A733 后面在 `board_late_init()` 里，只有在已经有一份 `working_fdt` 的前提下，才能 replace：

```821:828:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c
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

而 `sunxi_replace_fdt_v2()` 本身就是在“换掉当前 `working_fdt`”。

---

## 2.3 A733 的 `u-boot.fex` 里确实带了一份尾部 DTB

我对 `out/a733/x733mhn_aic8800/pack_out/u-boot.fex` 做了二进制检查，结果是：

- 文件里出现 **两个** FDT magic
- 第二个 FDT magic 在文件尾部附近
- 这个尾部 DTB 大小约 **42583 字节**
- 它的字符串内容与 `pack_out/.uboot.dtb.dts.tmp` 一致
- 但 **和 `sunxi.fex` 并不一致**

同时，`pack_out` 目录里确实存在这些文件：

- `u-boot.fex`
- `u-boot-sun60iw2p1.bin`
- `sunxi.fex`
- `.uboot.dts`
- `.uboot.dtb.dts.tmp`

这说明：

> **A733 的 `u-boot.fex` 尾部带的是一份 U-Boot 自己的 DTB，不是 Linux 的 `sunxi.fex`。**

---

## 2.4 这份 U-Boot 尾部 DTB 长什么样？

`pack_out/.uboot.dts` 与 `.uboot.dtb.dts.tmp` 的内容是这种风格：

```1:20:/home/alientek/A733/qihua-x73x-linux6.6/out/a733/x733mhn_aic8800/pack_out/.uboot.dts
/dts-v1/;

/ {
	model = "sun60iw2";
	compatible = "allwinner,a733\0arm,sun60iw2p1";
	#address-cells = <0x02>;
	#size-cells = <0x02>;

	clocks {
		compatible = "allwinner,clk-init";
		device_type = "clocks";
```

这个 DTB 的特征很明显：

- 有 `allwinner,clk-init`
- 更偏 U-Boot 早期时钟/平台初始化用途
- 体积小
- 不是完整 Linux 板级设备树

这就和 `sunxi.fex` 区分开了。

---

## 2.5 A733 的 `sunxi.fex` 又是什么？

我直接检查了 `pack_out/sunxi.fex`，它开头就是标准 DTB magic。  
而且 `pack_out/image_linux.cfg` 里也能看到它属于 Linux 镜像体系的一部分，不属于 boot package item。

同时，A733 的 `build/mkkernel.sh` 里有独立 DTS 编译逻辑，会为内核生成 `sunxi.dtb`。  
你当前这个 SDK 的产物目录里也确实出现了：

- `sunxi.fex`
- `new_fdt.dtb`

所以这里可以把两份 DTB 区分开：

### A733 的两份 DTB
1. **U-Boot 早期 DTB**
   - 在 `u-boot.fex` 尾部
   - 来自 U-Boot 侧 `.uboot.dtb.dts.tmp`
   - 用于 early working_fdt / 平台初始化

2. **Linux 最终 DTB**
   - `sunxi.fex`
   - 来自 kernel dts 编译产物
   - 后面由 `sunxi_replace_fdt_v2()` 替换进来

---

## 2.6 A733 的 `u-boot.fex` 尾部 DTB 是怎么被打进去的？

这块我分“能确定”和“高可信推断”两层说。

### 能确定的
- `pack_out` 里最终有 `u-boot-sun60iw2p1.bin` 和 `u-boot.fex`
- `u-boot.fex` 文件内部确实有尾部 U-Boot DTB
- `pack_img.sh` 会把 `board/.../bin/u-boot-${PACK_CHIP}.bin` 放到最终 `image/u-boot.fex`

`pack_img.sh` 里这条映射很直接：

```119:140:/home/alientek/A733/qihua-x73x-linux6.6/rtos/tools/scripts/pack_img.sh
boot_file_list=(
...
board/common/bin/u-boot-${PACK_CHIP}.bin:image/u-boot.fex
...
board/${PACK_PROJECT_PATH}/bin/u-boot-${PACK_CHIP}.bin:image/u-boot.fex
...
)
```

所以：

> **`u-boot.fex` 本质上就是打包阶段拿 `u-boot-${chip}.bin` 放进去。**

### 高可信推断
由于最终 `u-boot.fex` 已经带尾部 DTB，而 `mksunxiboot.c` 只处理 boot0/SPL 镜像头，不负责给 U-Boot 拼 DTB，因此：

> **这个尾部 DTB 更大概率是在 U-Boot 编译阶段就已经生成并附着到 `u-boot-${chip}.bin` 里了，pack 阶段只是原样带走。**

也就是说：

- **追加动作不太像 pack_img.sh 做的**
- **更像 U-Boot build 自己产出带尾 DTB 的 binary**

---

# 3. A733 的 Linux 最终 DTB 又是怎么进来的？

这部分源码是明确的。

A733 启动后期通过 `sunxi_get_dtb()` 重新取 Linux DTB：

```250:279:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/board/sunxi/sunxi_replace_fdt.c
int sunxi_get_dtb(ulong *dtb_data, ulong *dtb_len)
{
	...
		part_start = sunxi_partition_get_offset_byname("dtb");
		if (part_start != 0) {
			...
		}
		if (fdt_check_header((void *)*dtb_data) < 0) {
			char *boot_name = env_get("boot_partition");
			if (boot_name == NULL) {
				part_start = sunxi_partition_get_offset_byname("boot");
			} else {
				part_start = sunxi_partition_get_offset_byname(boot_name);
			}
			...
			android_image_get_dtb((const struct andr_img_hdr *)(ulong)boot_head_addr, dtb_data, dtb_len);
		}
```

然后替换掉当前 `working_fdt`：

```236:247:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/board/sunxi/sunxi_replace_fdt.c
	gd->uboot_fdt_blob = working_fdt;
	pr_force("change working_fdt 0x%x to 0x%x\n", (ulong)working_fdt, (ulong)gd->new_ext_fdt);
	working_fdt = (struct fdt_header *)gd->new_ext_fdt;
	gd->fdt_blob = gd->new_ext_fdt;
	memcpy((void *)gd->new_ext_fdt, buffer, new_fdt_totalsize);
```

所以 A733 的完整逻辑其实是：

1. 先用 `u-boot.fex` 尾部的小 U-Boot DTB 启动起来
2. 到 `board_late_init()` 再从 `dtb` 分区 / `boot.img` 拿 Linux 最终 DTB
3. 替换当前 `working_fdt`
4. 继续 `sunxi_update_fdt_para_for_kernel()`
5. 最后通过 `x0` 传给 kernel

---

# 4. 现在把两边链路重写成更严谨的版本

## A133 默认链路
**boot0 `load_package()` 把整个 TOC1/boot package 装到 `CONFIG_BOOTPKG_BASE`  
-> boot package 内含独立 `item=dtb,sunxi.fex`，因此该 dtb item 进入二阶段 U-Boot 可访问范围  
-> 二阶段 U-Boot 早期首先通过 `fdtdec_setup()` / `board_fdt_blob_setup()` 从自身镜像尾部 DTB 建立 first `gd->fdt_blob / working_fdt`  
-> boot package/TOC 体系中的独立 DTB 是否、以及在何时参与最终 handoff DTB 的选择，还需继续结合更后面的 handoff 路径确认  
-> `sunxi_update_fdt_para_for_kernel()` 只修补已有 `working_fdt`  
-> 通过 `x0` 传给 kernel**

### 目前仍待补的最后一点
- boot_package/TOC 中的独立 `dtb` item，究竟是否、以及是在 U-Boot 哪个更晚阶段参与了最终 handoff DTB 的选择/替换

---

## A733 默认链路
**U-Boot 编译产物 `u-boot-${chip}.bin` 本身就带一份尾部小 U-Boot DTB  
-> pack 阶段把它作为 `u-boot.fex` 带入 boot package  
-> U-Boot 早期用这份尾 DTB 形成基础 `working_fdt`  
-> `board_late_init()` 中 `sunxi_replace_fdt_v2()` 再从 `dtb` 分区 / `boot.img` 取 Linux 最终 DTB  
-> `sunxi_update_fdt_para_for_kernel()` 修补  
-> 通过 `x0` 传给 kernel**

---

# 5. 你这次问题的最终答案

## 问题 1：A133 的 boot_package / TOC 独立 DTB 是何时被取给 U-Boot？
**答：在 boot0 阶段。**

更准确说：

- `boot0_main.c` 先 `load_package()` / `load_image()`
- boot package/TOC1 被装到 `CONFIG_BOOTPKG_BASE`
- `update_uboot_info()` 再把 `boot_package_size` 写入 U-Boot header
- 最后跳转 U-Boot

所以独立 DTB 不是在 `sunxi_update_fdt_para_for_kernel()` 里被取，而是：

> **在 boot0 把整个 TOC1/boot package 交接给 U-Boot 时，已经一并交付了。**

---

## 问题 2：A733 的早期基础 `working_fdt` 怎么来的？`u-boot.fex` 尾部 dtb 是什么编出来的？怎么打包的？
**答：这份 early `working_fdt` 来自 `u-boot.fex` 尾部自带的小 U-Boot 专用 DTB。**

可以明确确认：

- 它不是 Linux 的 `sunxi.fex`
- 它对应 `pack_out/.uboot.dtb.dts.tmp` / `.uboot.dts`
- 内容偏 early clock/platform init
- 最终被包含在 `u-boot-${chip}.bin` / `u-boot.fex` 中
- pack 阶段只是把这个 binary 作为 `u-boot.fex` 带入

后面再由 `sunxi_replace_fdt_v2()` 换成 Linux 最终 DTB。

---

如果你愿意，我下一步可以继续做两件事中的一个：

1. **继续深挖 A133：把“TOC1 的 dtb item 变成 early working_fdt”的具体函数再追出来**  
   这一步我会继续沿 `CONFIG_BOOTPKG_BASE`、`ITEM_DTB_NAME`、`working_fdt/gd->fdt_blob` 去追。

2. **继续深挖 A733：把 U-Boot build 阶段生成尾部 `.uboot.dtb` 的具体 Makefile/规则找出来**  
   这样就能把“编译出来的、怎么拼进 `u-boot-${chip}.bin`”补成完全函数/规则级闭环。

