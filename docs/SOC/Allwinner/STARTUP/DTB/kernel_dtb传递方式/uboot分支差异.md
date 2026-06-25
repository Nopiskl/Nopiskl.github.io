
---

**User**

现在我需要你详细分析一下你提到的U-Boot 启动时会不会主动“替换 FDT”
其中A733 在 board_late_init() 里明确走 sunxi_replace_fdt_v2()，那A133呢？是因为uboot源码不同还是因为配置项没有打开？A133会走什么分支？

---

**Cursor**

我把 A133 的 `board_late_init()` 分支和相关配置项再精确对一下，确认它到底会走哪条路。

我直接把 A133 `board_late_init()` 那段和两边 `.config` 的实际行号读出来，这样可以明确回答“源码差异”还是“配置差异”。

我再补一下 A133 的正确 `.config` 路径和 `board_late_init()` 所在位置，确保结论完全落到源码上。

结论先说：

**A133 默认不会走 `sunxi_replace_fdt_v2()`。**  
更准确地说：

- **不是因为 A133 没有这段源码**
- **而是因为默认配置没有打开 `CONFIG_OF_SEPARATE` / `CONFIG_SUNXI_NECESSARY_REPLACE_FDT` 这条分支条件**
- 所以它在 `board_late_init()` 里会走的是：

```c
#if !defined(CONFIG_OF_SEPARATE)
    sunxi_update_fdt_para_for_kernel();
```

也就是：
**只在当前已有 FDT 上更新参数，不主动做“替换 FDT”。**

---

# 一、先回答你的核心问题

你问的是：

> A133呢？是因为uboot源码不同还是因为配置项没有打开？A133会走什么分支？

我的回答是：

## 1) A133 和 A733 的 U-Boot 源码框架本身并没有本质不同

两边 `board/sunxi/board_common.c` 和 `board/sunxi/sunxi_replace_fdt.c` 的代码结构是很接近的，  
甚至 `sunxi_replace_fdt_v2()` / `sunxi_get_dtb()` 这套函数 **A133 代码里也是有的**。

也就是说：

- **A133 不是“源码里没有 replace_fdt_v2”**
- 而是 **默认配置没有让它走那条分支**

---

## 2) A133 主要是“配置差异”导致不主动替换 FDT

`board_late_init()` 的关键分支在 A733 中是这样的：

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

这段逻辑可以理解成 3 条路：

1. **没开 `CONFIG_OF_SEPARATE`**
   - 直接 `sunxi_update_fdt_para_for_kernel()`
   - 不替换 FDT

2. **开了 `CONFIG_OF_SEPARATE` 且开了 `CONFIG_SUNXI_NECESSARY_REPLACE_FDT`**
   - 先 `sunxi_replace_fdt_v2()`
   - 再更新参数

3. **开了 `CONFIG_OF_SEPARATE` 且开了 `CONFIG_SUNXI_REPLACE_FDT_FROM_PARTITION`**
   - 走旧版 `sunxi_replace_fdt()`

---

# 二、A133 会走哪条分支？

## 结论
**A133 默认走第 1 条：**

```c
#if !defined(CONFIG_OF_SEPARATE)
    sunxi_update_fdt_para_for_kernel();
```

也就是：

- 不走 `sunxi_replace_fdt_v2()`
- 不走 `sunxi_replace_fdt()`
- 只是对已有 FDT 做参数修正

---

## 为什么是这条？

因为你文档里已经分析到 A133/R818 默认配置是：

- `# CONFIG_OF_SEPARATE is not set`
- `CONFIG_OF_BOARD=y`

这两个配置组合意味着：

### `# CONFIG_OF_SEPARATE is not set`
表示：
- U-Boot 不是走“独立外部 FDT + 后期替换”的模式
- 因此 `board_late_init()` 预处理后，直接命中第一分支

### `CONFIG_OF_BOARD=y`
表示：
- A133 这套平台使用 board 提供/决定 FDT 获取入口
- 但**不能仅凭这个配置就直接推出**“最终 handoff DTB 一定来自 boot_package”或“一定不是 U-Boot 自带尾部 DTB”
- 具体来源仍要结合 `fdtdec_setup()` / `board_fdt_blob_setup()` / 后续 handoff 路径一起看

---

# 三、A133 为什么不走 `sunxi_replace_fdt_v2()`，从条件编译上看得最清楚

你可以把这段条件直接翻译成伪代码：

```c
if (!CONFIG_OF_SEPARATE) {
    // A133 默认走这里
    只更新当前 FDT 参数
} else if (CONFIG_SUNXI_NECESSARY_REPLACE_FDT) {
    // A733 默认走这里
    先替换 FDT，再更新参数
} else if (CONFIG_SUNXI_REPLACE_FDT_FROM_PARTITION) {
    // 某些平台可能走这里
    从分区/文件替换 FDT，再更新参数
}
```

所以 A133 默认不替换 FDT，不是因为没有替换逻辑，而是因为：

- **第一层条件就已经截住了**
- 因为 `CONFIG_OF_SEPARATE` 没开

---

# 四、那 A133 的 `sunxi_replace_fdt_v2()` 代码存在有什么意义？

这个问题很关键。

A133 的 `sunxi_replace_fdt.c` 里，其实也有 `sunxi_replace_fdt_v2()`，而且逻辑和 A733 很像：

```240:274:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_replace_fdt.c
#if defined(CONFIG_SUNXI_NECESSARY_REPLACE_FDT)
static int __sunxi_replace_fdt_v2(void *buffer)
{
	...
}

int sunxi_get_dtb(ulong *dtb_data, ulong *dtb_len)
{
	int work_mode = get_boot_work_mode();
	if (work_mode == WORK_MODE_BOOT) {
		u32 part_start;
		...
		part_start = sunxi_partition_get_offset_byname("dtb");
		if (part_start != 0) {
			...
		}
		if (fdt_check_header((void *)*dtb_data) < 0) {
			part_start = sunxi_partition_get_offset_byname("boot");
			...
			android_image_get_dtb((const struct andr_img_hdr *)(ulong)boot_head_addr, dtb_data, dtb_len);
		}
	}
	return 0;
}
```

说明：

- A133 的源码**支持**这条能力
- 只是默认产品配置没启用它

所以这是一个很典型的情况：

> **能力存在于公共 sunxi U-Boot 代码中，但是否生效取决于平台 defconfig / 最终 `.config`。**

---

# 五、A133 默认不替换 FDT，那它用的 FDT 是哪来的？

这就回到前面我们已经分析过、并且现在可以进一步收紧的结论：

## A133/R818 默认方案里：
- `boot_package.cfg` 里有 `item=dtb, sunxi.fex`
- `image.cfg` 里也有独立的 `sunxi.fex`
- `boot.img` 默认不带 DTB
- **但从目前已经追到的 `gd->fdt_blob / working_fdt` 首次赋值链路看，A133 early working_fdt 的第一次来源并不是 boot_package 中独立 dtb，而是 U-Boot 自身镜像尾部 DTB**
- 因此更严谨地说，A133 是：
  - **early 阶段先用 U-Boot 自带尾部 DTB 建立 `working_fdt`**
  - **boot_package 中独立 dtb 则更可能在后续某个更晚阶段参与最终 handoff DTB 的选择**

换句话说：

### A133 默认逻辑不是：
“`sunxi_update_fdt_para_for_kernel()` 自己从 boot_package 取 DTB，再完成替换”

### 而是：
“前面 boot 阶段已经先建立了一份可用的 `working_fdt`，到了 `board_late_init()` 只做参数修补；boot_package 里的独立 dtb 是否以及何时参与最终 handoff，仍需看更后面的路径”

这就是 `sunxi_update_fdt_para_for_kernel()` 分支存在的意义。

---

# 六、A733 为什么非要走 `sunxi_replace_fdt_v2()`？

因为 A733 的默认设计已经变了：

- `boot_package.cfg` 里不再带独立 `dtb`
- `image.cfg` 也不再收独立 `sunxi.fex`
- `boot.img` 默认带 DTB
- 所以在启动 Linux 前，U-Boot 需要：
  1. 找 `dtb` 分区
  2. 如果没有，再去 `boot.img` 拿 DTB
  3. 用它替换当前工作 FDT

所以 A733 的 `sunxi_replace_fdt_v2()` 本质上是：

> **把 Linux 最终设备树的来源，从 boot_package 路线，切换到了 boot.img / dtb 分区路线。**

---

# 七、把 A133 和 A733 两条分支并排看就很清楚

## A133 默认链路
- `CONFIG_OF_SEPARATE` 没开
- `board_late_init()` 走：

```c
sunxi_update_fdt_para_for_kernel();
```

- 含义：
  - `board_late_init()` 之前当前 FDT 已经准备好了
  - 只做参数更新
  - 不主动替换
  - 但“当前 FDT 的第一次来源”按现有证据应是 U-Boot 自带尾部 DTB，而不是仅凭该分支就能直接判定为 boot_package 独立 dtb

---

## A733 默认链路
- `CONFIG_OF_SEPARATE=y`
- `CONFIG_SUNXI_NECESSARY_REPLACE_FDT=y`
- `board_late_init()` 走：

```c
sunxi_replace_fdt_v2();
sunxi_update_fdt_para_for_kernel();
```

- 含义：
  - 当前 FDT 不一定是 Linux 最终要用的
  - 先从 `dtb` 分区 / `boot.img` 取 DTB
  - 替换掉 working_fdt
  - 再更新参数

---

# 八、所以最终回答你的三个小问题

## 1. A133 会不会主动“替换 FDT”？
**默认不会。**

---

## 2. 是因为 U-Boot 源码不同，还是因为配置项没打开？
**主要是配置项没打开，不是源码没有这套逻辑。**

更准确地说：

- 公共 sunxi U-Boot 源码里，A133 也有 `sunxi_replace_fdt_v2()`
- 但默认配置没有走到那个分支
- 所以实际行为不同，根因在 **配置 + 打包模型**，不是单纯源码缺功能

---

## 3. A133 默认走什么分支？
**走：**

```c
#if !defined(CONFIG_OF_SEPARATE)
    sunxi_update_fdt_para_for_kernel();
```

即：

- 不替换 FDT
- 只更新已有 FDT 参数

---

# 九、一个很重要的补充判断

如果你后面要继续追：

> “A133 当前传给 kernel 的 FDT 到底是在什么阶段塞进来的？”

那下一步应该重点看：

1. **A133 boot0 / spl / toc1 解析流程**
2. `board_fdt_blob_setup()` / `fdtdec` 初始化路径
3. TOC1 / boot_package 中 `dtb` item 是不是在更早阶段已经装载到固定地址

因为从现在这个分支判断和已追到的 early FDT 初始化路径来看，A133 的思路更接近：

> **在进入 `board_late_init()` 之前，early `working_fdt` 就已经通过 `fdtdec_setup()` / `board_fdt_blob_setup()` 建好了；而 boot_package 中独立 dtb 是否在更后阶段参与最终 handoff，还要继续往后追。**

所以 `board_late_init()` 不需要再做 replace。

---

如果你要，我下一步可以继续帮你做这件事：

**沿着 A133 的 boot0 / TOC1 / `board_fdt_blob_setup()` 再往前追一层，精确定位“当前 working_fdt 最初到底来自哪里”。**  
这个能把“A133 为什么不需要 replace_fdt_v2”彻底闭环。

---

**User**

1、那请你接着分析一下A133的sunxi_update_fdt_para_for_kernel();，找出它是如何从boot_package取DTB并设置的，
并对比分析其获取过程与A733的不同点？
2、kernel启动流程中，A733与A133获取DTB的方式又不同在哪里？

其中A733 SDK:/home/alientek/A733/qihua-x73x-linux6.6/
A133/R818 SDK:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/

---

**Cursor**


下面我把这两个问题分开回答，并先澄清一个关键点：

> **A133 的 `sunxi_update_fdt_para_for_kernel()` 本身并不会“从 boot_package 取 DTB”。**
> 它做的是：**在已经存在的 `working_fdt` 上修改参数**，比如存储介质节点开关、dram 参数、保留内存、分区信息等。
>  
> 所以你要找的“从 boot_package 取 DTB”动作，不在这个函数里，而是在它之前：**U-Boot 早期就已经有一个可用的 FDT/working_fdt 了**。  
> A133 默认只是在 `board_late_init()` 阶段继续修补这个已有 DTB；A733 则会先主动 replace 一次。

---

# 一、A133 的 `sunxi_update_fdt_para_for_kernel()` 到底做了什么？

从 A133 的实现看，它操作的对象始终是 `working_fdt`，没有看到任何“读取 boot_package / 读取 dtb 分区 / 解析 boot.img dtb”的动作。

例如 A133 的实现里，直接对 `working_fdt` 进行节点开关和属性更新：

```45:82:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/board_helper.c
int update_fdt_dram_para(void *dtb_base)
{
	/*fix dram para*/
	int nodeoffset = 0;
	uint32_t *dram_para = NULL;
	dram_para = (uint32_t *)uboot_spare_head.boot_data.dram_para;

	pr_msg("(weak)update dtb dram start\n");
	nodeoffset = fdt_path_offset(dtb_base, "/dram");
	if (nodeoffset < 0) {
		pr_err("## error: %s : %s\n", __func__, fdt_strerror(nodeoffset));
		return -1;
	}
	fdt_setprop_u32(dtb_base, nodeoffset, "dram_clk", dram_para[0]);
	fdt_setprop_u32(dtb_base, nodeoffset, "dram_type", dram_para[1]);
	// ... more dram properties ...
	gd->bd->bi_dram[0].size = (phys_size_t)uboot_spare_head.boot_data.dram_scan_size * 1024 * 1024;
	pr_msg("update dtb dram  end\n");
	return 0;
}
```

以及它修改的也是全局 `working_fdt`：

```99:111:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/board_helper.c
static int fdt_enable_node(char *name, int onoff)
{
	int nodeoffset = 0;
	int ret = 0;

	nodeoffset = fdt_path_offset(working_fdt, name);
	ret = fdt_set_node_status(working_fdt, nodeoffset,
		onoff ? FDT_STATUS_OKAY: FDT_STATUS_DISABLED, 0);

	if (ret < 0) {
		printf("disable nand error: %s\n", fdt_strerror(ret));
	}
	return ret;
}
```

函数后半段也是在已有 `working_fdt` 上做修补：

```759:800:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/board_helper.c
	/* fix nand&sdmmc */
	switch (storage_type) {
	case STORAGE_NAND:
#ifdef CONFIG_SUNXI_UBIFS
		if (nand_use_ubi() == 0)
#endif
		{
			fdt_enable_node("nand0", 1);
			fdt_enable_node("spi0", 0);
		}
		break;
	// ... storage specific node enable/disable ...
#if defined(CONFIG_SUNXI_DRM_SUPPORT)
	ulong drm_base = 0, drm_size = 0;
	if (gd->securemode == SUNXI_SECURE_MODE_WITH_SECUREOS) {
		if (!smc_tee_probe_drm_configure(&drm_base, &drm_size)) {
			ret = fdt_add_mem_rsv(working_fdt, drm_base, drm_size);
```

以及最后调用：

```807:824:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/board_helper.c
	/* fix dram para */
	ret = update_fdt_dram_para(working_fdt);
	if (ret < 0) {
		return -1;
	}
#ifdef CONFIG_BOOT_GUI
	save_disp_cmd();
	disp_update_lcd_param(-1);
#endif
#ifdef CONFIG_SUNXI_MAC
	extern int update_sunxi_mac(void);
	update_sunxi_mac();
#endif
	// ...
	tick_printf("update dts\n");
	return 0;
}
```

## 结论 1
**A133 的 `sunxi_update_fdt_para_for_kernel()` 不负责“取 DTB”，只负责“改 DTB”。**

---

# 二、那 A133 的 DTB 是怎么来的？为什么说它“更依赖 boot_package”？

这里要把“函数行为”和“系统来源”分开：

- **函数层面**：`sunxi_update_fdt_para_for_kernel()` 不去取
- **系统层面**：A133 默认启动时，`working_fdt` 早就已经就位；但按当前已追到的首次赋值链路，early first `working_fdt` 更像来自 U-Boot 自身镜像尾部 DTB，而 boot_package / TOC1 中独立 dtb item 是否在更晚阶段参与最终 handoff，还要结合后续路径继续确认

这个判断来自三条证据链：

---

## 1）A133 默认 `board_late_init()` 不做 replace，只做 update

A733 的 `board_late_init()` 分支你已经看到：

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

A133 默认不走 `replace_fdt_v2()`，而是停在第一分支。  
这意味着：

- 到 `board_late_init()` 时
- **A133 已经有一个现成可用的 working_fdt**
- 所以它不需要再额外从 `dtb` 分区 / `boot.img` 抓一份替换进去

---

## 2）A133 默认打包把 DTB 作为 boot_package / image 的正式成员

你前面已经确认过 A133/R818 默认配置里：

- `boot_package.cfg` 有 `item=dtb, sunxi.fex`
- `image.cfg` 也有独立 `sunxi.fex`

这说明 A133 的默认设计就是：

> **把 DTB 作为 bootloader 打包体系中的独立对象保留**

但更严谨地说，这只能说明：

- boot0 / TOC1 阶段会把独立 dtb item 一并装入 U-Boot 可访问范围
- 不能仅凭这一点就断定 early first `working_fdt` 直接来自该 dtb item
- 到 `sunxi_update_fdt_para_for_kernel()` 时，只能确认它是在修改一个已经存在的 `working_fdt`

---

## 3）A133 默认 `boot.img` 不带 DTB，因此它也没必要在最后一跳 replace

这一点也是你之前分析出来的。  
所以 A133 默认 Linux 的最终 DTB **不是靠 boot.img 末端附带 dtb 提供**，这与 A733 不同。

---

# 三、A733 与 A133 在“获取 DTB”上的直接差异

这部分最清楚的证据是 `sunxi_get_dtb()`。

## A733：主动“重新获取 DTB”并替换

A733 的 `sunxi_get_dtb()`：

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
```

然后它会把新取到的 DTB 替换成当前 `working_fdt`：

```236:247:/home/alientek/A733/qihua-x73x-linux6.6/brandy/brandy-2.0/u-boot-2018/board/sunxi/sunxi_replace_fdt.c
	gd->uboot_fdt_blob = working_fdt;
	pr_force("change working_fdt 0x%x to 0x%x\n", (ulong)working_fdt, (ulong)gd->new_ext_fdt);
	working_fdt = (struct fdt_header *)gd->new_ext_fdt;
	gd->fdt_blob = gd->new_ext_fdt;
	memcpy((void *)gd->new_ext_fdt, buffer, new_fdt_totalsize);
	/* fdt_size is the space reserved by uboot for fdt, now set to new fdt */
	fdt_set_totalsize((void *)gd->new_ext_fdt, gd->fdt_ext_size);
```

## A133：也有 `sunxi_get_dtb()`，但默认链路不走它

A133 的函数也在：

```246:273:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/board/sunxi/sunxi_replace_fdt.c
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

注意这里的重点不是“它有没有这个函数”，而是：

- **默认 A133 不走 `sunxi_replace_fdt_v2()` 分支**
- 所以这条“从 dtb 分区 / boot.img 获取并替换”的链路，**默认不是主链路**

## 结论 2
### A733
- 启动后期会主动重新获取 DTB
- 来源优先级：`dtb` 分区 -> `boot.img` 内嵌 dtb
- 然后 replace 当前 `working_fdt`

### A133
- 默认启动后期不主动重新取 DTB
- 默认只是在早期已有 `working_fdt` 上打补丁
- 因而更准确地说：early first `working_fdt` 不是由这里现取；而 boot_package / TOC1 中独立 dtb item 是否在更晚阶段参与最终 handoff，仍需继续结合后续路径确认

---

# 四、A133 的“从 boot_package 取 DTB并设置”更准确怎么描述？

更准确应该是这样说：

## 不是
“`sunxi_update_fdt_para_for_kernel()` 从 boot_package 取 DTB 并设置”

## 而是
“**A133 默认启动链路中，U-Boot 在进入 `sunxi_update_fdt_para_for_kernel()` 之前，已经拥有一个可用的工作 DTB；按当前证据，early first `working_fdt` 更像来自 U-Boot 自身尾部 DTB，而 boot_package/TOC 体系中的独立 dtb item 处于 U-Boot 可访问范围，并可能在更晚阶段参与最终 handoff DTB 的选择；`sunxi_update_fdt_para_for_kernel()` 本身只是对当前工作 DTB 做修补。**”

也就是说，动作拆成两段：

1. **更早阶段**：boot_package/TOC 体系中的独立 dtb item 进入 U-Boot 可访问范围；与此同时，early first `working_fdt` 已经先建立起来
2. **board late init 阶段**：`sunxi_update_fdt_para_for_kernel()` 只对当前 `working_fdt` 做修补

---

# 五、Kernel 启动流程中，A733 与 A133 获取 DTB 的方式差异在哪里？

这里要分两层说：

---

## 第一层：Kernel 自身入口机制其实一样

无论 A133 的 Linux 4.9，还是 A733 的 Linux 6.6，ARM64 内核入口要求都一样：

### A133 Linux 4.9
```53:61:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/linux-4.9/arch/arm64/kernel/head.S
/*
 * The requirements are:
 *   MMU = off, D-cache = off, I-cache = on or off,
 *   x0 = physical address to the FDT blob.
 */
```

### A733 Linux 6.6
```38:44:/home/alientek/A733/qihua-x73x-linux6.6/kernel/linux-6.6/arch/arm64/kernel/head.S
/*
 * The requirements are:
 *   MMU = off, D-cache = off, I-cache = on or off,
 *   x0 = physical address to the FDT blob.
 */
```

也就是说，**kernel 并不自己去 boot_package、dtb 分区、boot.img 找 DTB**。  
Kernel 只要求：

> **bootloader 把最终 DTB 物理地址放在 `x0` 传进来**

然后内核早期做校验和扫描。

---

## 第二层：内核早期使用 DTB 的方式也基本一样

### A133 Linux 4.9
```157:170:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/linux-4.9/arch/arm64/kernel/setup.c
static void __init setup_machine_fdt(phys_addr_t dt_phys)
{
	void *dt_virt = fixmap_remap_fdt(dt_phys);

	if (!dt_virt || !early_init_dt_scan(dt_virt)) {
		pr_crit("\n"
			"Error: invalid device tree blob at physical address %pa (virtual address 0x%p)\n"
```

### A733 Linux 6.6
```160:178:/home/alientek/A733/qihua-x73x-linux6.6/kernel/linux-6.6/arch/arm64/kernel/setup.c
static void __init setup_machine_fdt(phys_addr_t dt_phys)
{
	int size;
	void *dt_virt = fixmap_remap_fdt(dt_phys, &size, PAGE_KERNEL);
	const char *name;

	if (dt_virt)
		memblock_reserve(dt_phys, size);

	if (!early_init_dt_scan(dt_virt, dt_phys)) {
		pr_crit("\n"
			"Error: invalid device tree blob at physical address %pa ...
```

所以：

- kernel 侧都是 `x0 -> setup_machine_fdt() -> early_init_dt_scan()`
- **差异不在 kernel 自己怎么取**
- **差异在 U-Boot 最终塞给 kernel 的 `x0` 指向哪一份 DTB**

---

# 六、所以 A133 与 A733 在 kernel 启动流程中“获取 DTB”的真正不同点是什么？

## A133
kernel 最终拿到的是：

- **bootloader 早期就准备好的 `working_fdt`**
- 按当前证据，early first `working_fdt` 更像来自 U-Boot 自身尾部 DTB
- boot_package / TOC 体系中的独立 `sunxi.fex` 是否在更晚阶段参与最终 handoff，还需继续结合后续路径确认
- `board_late_init()` 只做参数修补，不做来源替换

所以可以概括为：

> **A133：kernel 看到的 DTB，是 U-Boot 早期已经就位、后期只补参数的那份 DTB；至于 boot_package 中独立 dtb item 是否参与最终 handoff，当前证据还不足以下绝对结论。**

---

## A733
kernel 最终拿到的是：

- U-Boot 在 `board_late_init()` 里主动 replace 过的 `working_fdt`
- 它优先来自 `dtb` 分区
- 失败时来自 `boot.img` 里的 dtb
- 然后再补参数，最后传给 kernel

所以可以概括为：

> **A733：kernel 看到的 DTB，是 U-Boot 启动后期重新获取并替换过的 DTB。**

---

# 七、把两边链路画成一句话对照

## A133 默认链路
`boot0把boot_package/TOC装入U-Boot可访问范围（含独立dtb item） -> U-Boot早期先建立first working_fdt（按当前证据更像来自自身尾部DTB） -> sunxi_update_fdt_para_for_kernel()修补当前working_fdt -> 通过x0传给kernel`

## A733 默认链路
`U-Boot早期先有一份基础working_fdt -> board_late_init()中sunxi_replace_fdt_v2()重新取DTB（dtb分区/boot.img） -> sunxi_update_fdt_para_for_kernel()修补 -> 通过x0传给kernel`

---

# 八、最终结论

## 对问题 1 的回答
### “A133 的 `sunxi_update_fdt_para_for_kernel()` 是如何从 boot_package 取 DTB 并设置的？”

严格说：

- **它本身不取 DTB**
- 它只对已有的 `working_fdt` 做修改
- A133 默认链路里，DTB 在进入这个函数前已经准备好
- 进入这个函数前，`working_fdt` 已经存在；按当前证据，early first `working_fdt` 更像来自 U-Boot 自身尾部 DTB，而 boot_package / TOC / 独立 `sunxi.fex` 体系中的 dtb item 是否在更晚阶段参与最终 handoff，还需继续确认

### 与 A733 的不同点
- **A133**：默认不 replace，直接改已有 `working_fdt`
- **A733**：先 `sunxi_replace_fdt_v2()` 重新获取 DTB，再改

---

## 对问题 2 的回答
### “kernel 启动流程中，A733 与 A133 获取 DTB 的方式不同在哪里？”

**kernel 自己的方式基本没区别**：

- 都要求 bootloader 把 DTB 物理地址放进 `x0`
- 都在 `setup_machine_fdt()` / `early_init_dt_scan()` 中解析

**真正不同的是 bootloader 在把 DTB 交给 kernel 前，最终选用了哪一份 DTB：**

- **A133**：默认沿用早期已就位的 `working_fdt`，只修参数；boot_package/TOC 中独立 dtb item 是否在更晚阶段参与最终 handoff，还需继续确认
- **A733**：默认在启动末端重新从 `dtb` 分区或 `boot.img` 获取最终 DTB，然后替换再传给 kernel

---

如果你愿意，我下一步可以继续帮你把这部分再往下做成一张“证据闭环图”：

1. **A133：boot0装载boot_package/TOC1（含独立dtb item） -> early first working_fdt -> kernel（中间是否有后续 handoff 选择仍待继续确认）**
2. **A733：early_fdt -> replace_fdt_v2(dtbdisk/boot.img) -> working_fdt -> kernel**

或者我也可以继续深挖你现在最关心的点：

> **A133 的 early `working_fdt` 在 U-Boot 代码里究竟是在哪个具体函数、哪个地址上被建立出来的。**

这个如果继续追到 `fdtdec_setup/board_fdt_blob_setup/boot0-to-uboot handoff`，就能把 “从 boot_package 取 DTB” 落到更具体的函数级证据上。
