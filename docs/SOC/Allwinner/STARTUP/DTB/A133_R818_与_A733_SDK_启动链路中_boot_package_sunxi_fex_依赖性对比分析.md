# A133/R818 与 A733 SDK 启动链路中 `boot_package`/`sunxi.fex` 依赖性对比分析

## 1. 分析范围

本文基于以下代码与文档做对比：

- A133/R818 SDK：`/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1`
- A733 SDK：`/home/alientek/A733/qihua-x73x-linux6.6`
- 参考文档：`agent/a733_dtb_boot_summary_brief.md`

需要先说明一个边界：

- A133 侧本文以当前仓内最明确、最完整的 `r818-sc3917` 默认启动链路为观察对象。
- A733 侧本文以 `device/config/chips/a733/configs/default/` 对应的默认普通启动链路为观察对象。
- 因此文中的“R818/A133 需要 `sunxi.fex`”与“A733 没有 `sunxi.fex`”，都应理解为“默认启动链路对 `boot_package` 中独立 `dtb item` 的依赖差异”，而不是字面意义上仓库里完全有无该文件。
- A733 仓内没有和 A133 仓同粒度展开的 `spl/boot0` 源码，因此本文对 A733 的 boot0 装载 TOC1 细节不做过度推断；A733 的结论主要由打包脚本、U-Boot 配置和运行时代码共同佐证。

## 2. 先给结论

结论可以先压缩成 4 句话：

1. 两套 SDK 在打包阶段都会生成 DTB；A733 也会生成中间态 `sunxi.fex`，并不是完全没有。
2. R818/A133 默认链路里，`boot_package.fex` 明确保留 `item=dtb, sunxi.fex`，而且 `boot.img` 默认不带 DTB，U-Boot 也没有启用 `CONFIG_OF_SEPARATE + sunxi_replace_fdt_v2()` 这条新路径，所以它对 **boot_package 中独立 dtb item 的保留/可访问路径** 依赖更强；但这不等于 early first `working_fdt` 直接来自该 dtb item。
3. A733 默认链路里，U-Boot 自己的控制 DTB 被打回 `u-boot.fex`，Linux 最终使用的 DTB 又来自 `boot.img` 内嵌 DTB，因此普通 `boot_package.cfg` 已经不需要再放一个独立 `dtb` 条目。
4. 所以两边真正的差异不是“有没有 DTB”，而是“DTB 在谁手里、在哪个阶段交接给 Linux”。

## 3. 两套 SDK 的核心差异总表

| 对比项 | A133/R818 默认链路 | A733 默认链路 |
| --- | --- | --- |
| 打包脚本入口 | `scripts/pack_img.sh` | `build/pack` + `build/mkkernel.sh` |
| `sys_config.fex` 是否参与生成 DTB | 是 | 是 |
| 是否生成中间态 `sunxi.fex` | 是 | 是 |
| `boot_package.cfg` 是否包含 `item=dtb, sunxi.fex` | 是 | 否 |
| `image.cfg` 是否把 `sunxi.fex` 作为独立镜像项收录 | 是 | 否 |
| `boot.img` 是否默认带 DTB | 默认否 | 默认是 |
| U-Boot 是否启用 `CONFIG_OF_SEPARATE` | 否 | 是 |
| U-Boot 是否默认执行 `sunxi_replace_fdt_v2()` | 否 | 是 |
| Linux 最终生效 DTB 来源 | 默认不走 `boot.img` 路线；沿当前 `working_fdt` 更强，boot_package 中独立 dtb item 是否参与最终 handoff 仍待继续确认 | `boot.img` 路线 |
| 对 `boot_package` 中 `sunxi.fex` 的依赖 | 强 | 弱，普通链路基本不依赖 |

## 4. A133/R818：为什么默认链路更依赖 `boot_package` 中的 `sunxi.fex`

### 4.1 打包阶段：`sys_config.fex -> sunxi.dtb -> sunxi.fex -> boot_package.fex`

R818 的打包脚本 `scripts/pack_img.sh` 明确先把 `sys_config.fex` 转成 `sunxi.dtb`：

```sh
$DTC_COMPILER ${DTC_FLAGS} -O dtb -o ${ROOT_DIR}/image/sunxi.dtb \
    -b 0 \
    -i $DTC_SRC_PATH \
    -F $DTC_INI_FILE \
    -d $DTC_DEP_FILE $DTC_SRC_FILE
```

随后在 `do_common()` 中又把 `sunxi.dtb` 复制为 `sunxi.fex`，并执行 `update_dtb`：

```sh
if [ -f "sunxi.dtb" ]; then
    cp sunxi.dtb sunxi.fex
    update_dtb sunxi.fex 4096
fi
```

然后再用 `boot_package.cfg` 重新打 `boot_package.fex`：

```sh
if [ -f boot_package.cfg ]; then
    echo "pack boot package"
    busybox unix2dos boot_package.cfg
    dragonsecboot -pack boot_package.cfg
fi
```

而当前 R818 默认 `boot_package.cfg` 明确保留了独立 DTB 项：

```ini
item=u-boot,                 u-boot.fex
item=monitor,                monitor.fex
item=scp,                    scp.fex
item=dtb,                    sunxi.fex
```

同时，R818 的 `image.cfg` 也把 `sunxi.fex` 作为独立镜像项收录：

```ini
{filename = "sys_partition.fex",maintype = ITEM_COMMON, subtype = "SYS_CONFIG000000",},
{filename = "sunxi.fex",        maintype = ITEM_COMMON, subtype = "DTB_CONFIG000000",},
```

这说明在 R818 默认打包模型里，`sunxi.fex` 不是“可有可无的临时文件”，而是一个被显式保留并打进最终镜像体系的配置对象。

### 4.2 启动阶段：boot.img 默认不带 DTB，U-Boot 也不走 replace_fdt_v2

R818 这边虽然也用 `boot.img` 启动：

```sh
boot_normal=sunxi_flash read 45000000 boot;bootm 45000000
bootcmd=run setargs_nand boot_normal#default nand boot
```

但它的默认配置没有打开“把 DTB 打进 boot.img”的开关：

```kconfig
config SUNXI_MKBOOTIMG_ADD_DTB
    bool "mkbootimge add dtb to boot.img"
```

```config
CONFIG_SUNXI_SD_BOOT_KERNEL_FORMAT_BOOTIMG=y
# CONFIG_SUNXI_MKBOOTIMG_ADD_DTB is not set
```

而且虽然脚本里确实存在 `do_mkbootimg_add_dtb()`：

```sh
function do_mkbootimg_add_dtb()
{
    ...
    mkbootimg --kernel ${KDIR}/${BOOTIMG_IMAGE_DATA} --ramdisk ${RDIR}/${RAMDISK} \
        --dtb ${DTB} --board ${PACK_BOARD} --base ${BASE_ADDRESS} \
        --kernel_offset ${KERNEL_OFFSET} --dtb_offset ${DTB_OFFSET} \
        --header_version ${HEADER_VERSION} -o ${ROOT_DIR}/boot.img
}
```

但这个函数只有 `CONFIG_SUNXI_MKBOOTIMG_ADD_DTB=y` 时才会执行：

```sh
grep "CONFIG_SUNXI_MKBOOTIMG_ADD_DTB=y" ${PACK_TOPDIR}/.config > /dev/null
if [ $? -eq 0 ]; then
    do_mkbootimg_add_dtb
fi
```

也就是说，当前 `r818-sc3917` 默认链路里，`boot.img` 本身不是 DTB 的默认承载者。

再看 U-Boot 配置：

```config
# CONFIG_OF_SEPARATE is not set
CONFIG_OF_BOARD=y
```

对应的 `board_common.c` 启动逻辑也说明了这一点：

```c
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

换句话说，R818 默认链路不会像 A733 那样在启动末端再去“从 `boot.img` 抽 DTB 覆盖当前工作 FDT”。

### 4.3 需要区分：early first `working_fdt` 的首次来源，与 boot_package 中独立 dtb item 的依赖

U-Boot 获取初始 FDT 的方式仍然是：

```c
/* fdtdec.c */
gd->fdt_blob = board_fdt_blob_setup();
set_working_fdt_addr((ulong)gd->fdt_blob);
```

```c
/* board.c */
void * board_fdt_blob_setup(void)
{
    if (fdt_check_header(&_end) == 0)
        return (void *)&_end;

    return (void*)(CONFIG_SYS_TEXT_BASE + SUNXI_DTB_OFFSET);
}
```

同时，从 SPL/boot0 这侧也能看到老链路对 TOC1/boot_package 容器的依赖关系：

```c
ret = toc1_init();
if(ret)
    goto _BOOT_ERROR;

ret = toc1_verify_and_run(dram_size, pmu_type, uart_input_value, key_input);
```

```c
struct sbrom_toc1_head_info *toc1_head = (struct sbrom_toc1_head_info *)CONFIG_BOOTPKG_BASE;
header->boot_data.boot_package_size = toc1_head->valid_len;
```

```c
#define ITEM_UBOOT_NAME   "u-boot"
#define ITEM_DTB_NAME     "dtb"
#define ITEM_SOCCFG_NAME  "soc-cfg"
```

这至少说明两件事：

- 在这套老链路设计里，TOC1/boot_package 本来就是承载 `u-boot`/`dtb` 等启动项的正式容器
- `sunxi.fex` 不是一个“仅供最终 Linux 使用的普通文件”，而是 bootloader 容器模型中的正式成员

但这里要补一个边界：  
**按当前已追到的 U-Boot 首次建树代码，early first `working_fdt` 仍是先由 U-Boot 自身 control FDT 建起来，而不是在这里直接证明它首次来自 boot_package 中独立 dtb item。**

和 A733 不同的是，R818 的打包脚本里并没有看到类似 A733 那样的 `split u-boot / merge new_fdt.dtb` 流程；它更像是把板级 DTB 单独准备成 `sunxi.fex`，并通过 bootloader 容器路径保留。

从“默认启动配置不把 DTB 放进 `boot.img`”与“`boot_package.cfg` 明确保留 `dtb` 项”这两个事实结合来看，R818 当前默认链路对 `boot_package` 中独立 `sunxi.fex` 的依赖是明显更强的；只是这种“依赖”更准确应理解为 **bootloader 容器侧保留和可访问该 dtb item**，而不是已经证明 early first `working_fdt` 的首次来源就是它。

## 5. A733：为什么默认链路不再需要 `boot_package` 中独立 `sunxi.fex`

### 5.1 先纠正一个常见误解：A733 不是完全没有 `sunxi.fex`

A733 的 `build/pack` 也会生成 `sunxi.fex` 中间文件。

第一步，`do_ini_to_dts()` 生成 `sunxi.dtb`：

```sh
echo "sunxi_dtb create"
$DTC_COMPILER -p 2048 ${DTC_FLAGS} -@ -O dtb -o ${LICHEE_PLAT_OUT}/sunxi.dtb \
    -b 0 \
    -i $DTC_SRC_PATH \
    -F $DTC_INI_FILE \
    -d $DTC_DEP_FILE $DTC_SRC_FILE
```

第二步，`boot_file_list_2` 把 `sunxi.dtb` 拷到 `pack_out/sunxi.fex`：

```sh
boot_file_list_2=(
${LICHEE_PLAT_OUT}/arisc:${LICHEE_PACK_OUT_DIR}/arisc.fex
${LICHEE_PLAT_OUT}/sunxi.dtb:${LICHEE_PACK_OUT_DIR}/sunxi.fex
...
)
```

第三步，后续仍然会对 `sunxi.fex` 做一些打包期更新：

```sh
if [ -f "sunxi.fex" ]; then
    update_dtb sunxi.fex 4096
fi

if [ -f "scp.fex" ]; then
    update_scp scp.fex sunxi.fex >/dev/null
fi

if [ -f "optee.fex" ]; then
    update_optee optee.fex sunxi.fex >/dev/null
fi
```

所以更准确的说法不是“A733 没有 `sunxi.fex`”，而是：

- A733 默认普通启动链路里，`sunxi.fex` 不再作为独立 DTB 条目进入 `boot_package.fex`
- 它更多是打包期中间产物，以及若干 boot 组件更新时的输入

### 5.2 A733 已经把 U-Boot 自己的控制 DTB 打回到了 `u-boot.fex`

A733 的 `build/pack` 比 R818 多了一段非常关键的流程：`uboot_ini_to_dts()`。

```sh
sunxi_ubootools split ${TARGET_UBOOT} > /dev/null
...
$DTC_COMPILER ${DTC_FLAGS} -I dtb -O dts -o ${LICHEE_PACK_OUT_DIR}/.uboot.dtb.dts.tmp \
    ${LICHEE_PACK_OUT_DIR}/temp_fdt.dtb
...
$DTC_COMPILER -p 2048 ${DTC_FLAGS} -@ -O dtb -o ${LICHEE_PACK_OUT_DIR}/new_fdt.dtb \
    -b 0 \
    -i ${LICHEE_PACK_OUT_DIR} \
    -F $DTC_INI_FILE \
    -d ${LICHEE_PACK_OUT_DIR}/temp_fdt.dtb \
    ${LICHEE_PACK_OUT_DIR}/.uboot.dtb.dts.tmp
...
sunxi_ubootools merge ${LICHEE_PACK_OUT_DIR}/temp_ubootnodtb.bin \
    ${LICHEE_PACK_OUT_DIR}/new_fdt.dtb > /dev/null
cp -vf ${LICHEE_PACK_OUT_DIR}/temp_ubootnodtb.bin ${TARGET_UBOOT}
```

这段代码会：

1. `split` 当前 `u-boot.fex`
2. 取出 `temp_fdt.dtb`
3. 按当前板级配置重新生成 `new_fdt.dtb`
4. 再把新 DTB `merge` 回 `u-boot`

这一步非常关键，因为它意味着：

- A733 的 U-Boot 控制 FDT 已经随 `u-boot.fex` 自身维护
- 不需要再依赖 `boot_package` 里额外放一个单独 DTB，来给 U-Boot 提供控制树

### 5.3 A733 的普通 `boot_package.cfg` 已经不再打包独立 DTB

当前 A733 默认 `boot_package.cfg` 只有：

```ini
item=u-boot,                 u-boot.fex
item=monitor,                monitor.fex
item=scp,                    scp.fex
```

没有：

- `item=dtb, sunxi.fex`

当前 `image.cfg` 里也没有把 `sunxi.fex` 作为独立镜像项收进去：

```ini
{filename = "sys_config.fex",   maintype = ITEM_COMMON, subtype = "SYS_CONFIG100000",},
{filename = "config.fex",       maintype = ITEM_COMMON, subtype = "SYS_CONFIG_BIN00",},
{filename = "board.fex",        maintype = ITEM_COMMON, subtype = "BOARD_CONFIG_BIN",},
{filename = "sys_partition.fex",maintype = ITEM_COMMON, subtype = "SYS_CONFIG000000",},
...
{filename = "boot_package.fex", maintype = "12345678", subtype = "BOOTPKG-00000000",},
```

这说明在默认普通链路中：

- `boot_package.fex` 的职责已经收缩成 bootloader 组件容器
- 它不再承担“Linux 最终 DTB 载体”的角色

### 5.4 A733 把 Linux 最终 DTB 放进了 `boot.img`

A733 的 `build/mkkernel.sh` 会直接把 DTB 打进 `boot.img`：

```sh
${MKBOOTIMG} --kernel ${BIMAGE} \
    $(check_whether_use_ramdisk && echo "--ramdisk $RAMDISK") \
    --board ${CHIP}_${LICHEE_ARCH} \
    --base ${BASE} \
    --kernel_offset ${KERNEL_OFFSET} \
    $(check_whether_use_ramdisk && echo "--ramdisk_offset ${RAMDISK_OFFSET}") \
    --dtb ${DTB} \
    --dtb_offset ${DTB_OFFSET} \
    --header_version 2 \
    -o $STAGING_DIR/${IMAGE_NAME}
```

这和 R818 的默认配置正好相反。

所以在 A733 里，Linux DTB 的主承载体已经从：

- `boot_package` / `sunxi.fex`

转移到了：

- `boot.img`

### 5.5 A733 运行时会把当前工作 FDT 替换成 `boot.img` 中的 DTB

当前 A733 U-Boot 配置：

```config
CONFIG_SUNXI_NECESSARY_REPLACE_FDT=y
CONFIG_OF_SEPARATE=y
# CONFIG_OF_BOARD is not set
```

对应的启动逻辑：

```c
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

而 `sunxi_replace_fdt_v2()` 的 DTB 获取逻辑是：

```c
int sunxi_get_dtb(ulong *dtb_data, ulong *dtb_len)
{
    ...
    part_start = sunxi_partition_get_offset_byname("dtb");
    if (part_start != 0) {
        *dtb_data = CONFIG_SUNXI_FDT_ADDR;
        sunxi_flash_read(part_start, ..., (void *)(ulong)(*dtb_data));
        ...
    }
    if (fdt_check_header((void *)*dtb_data) < 0) {
        part_start = sunxi_partition_get_offset_byname("boot");
        sunxi_flash_read(part_start, ..., (void *)(ulong)boot_head_addr);
        android_image_get_dtb((const struct andr_img_hdr *)(ulong)boot_head_addr,
                              dtb_data, dtb_len);
    }
}
```

其顺序非常清楚：

1. 先尝试读取 `dtb` 分区
2. 如果没有有效 DTB，再退回到 `boot` 分区
3. 从 `boot.img` 中解析 DTB
   - 也就是调用 `android_image_get_dtb(...)`

而当前 A733 分区表中没有 `dtb` 分区：

```ini
[partition]
    name         = env
    downloadfile = "env.fex"

[partition]
    name         = boot
    downloadfile = "boot.fex"

[partition]
    name         = rootfs
    downloadfile = "rootfs.fex"
```

并且当前分区表中确实搜不到 `name = dtb`。

再结合默认启动命令：

```sh
boot_normal=sunxi_flash read 4007f800 boot;bootm 0x4007f800
bootcmd=run setargs_nand boot_normal#default nand boot
```

就可以得到 A733 当前默认启动链路：

`BootROM -> boot0 -> TOC1/boot_package -> U-Boot -> 读取 boot 分区 -> 从 boot.img 解析 DTB -> replace_fdt_v2 -> Linux`

也就是说，A733 的 Linux 最终生效 DTB 不是 `boot_package` 中的独立 `sunxi.fex`，而是 `boot.img` 里的 DTB。

## 6. 为什么 A733 不再需要 `boot_package` 中独立 `sunxi.fex`，而 A133/R818 还需要

### 6.1 原因一：DTB 责任从 TOC1/boot_package 迁移到了 boot.img

R818 默认：

- `boot.img` 不带 DTB
- `boot_package.cfg` 明确带 `dtb`

A733 默认：

- `boot.img` 直接 `--dtb`
- `boot_package.cfg` 去掉 `dtb`

这是最直接、最决定性的差异。

### 6.2 原因二：A733 把 U-Boot 控制 FDT 内聚进 `u-boot.fex`

A733 的 `uboot_ini_to_dts()` 会 `split -> 生成 new_fdt.dtb -> merge` 回 `u-boot.fex`。

因此 A733 里：

- U-Boot 自己需要的控制树，更多由 `u-boot.fex` 自身携带
- Linux 需要的最终 DTB，则由 `boot.img` 携带

boot_package 不再需要额外再背一份独立 DTB。

R818 当前默认脚本没有这一整套 U-Boot FDT 回灌流程，因此仍延续了“单独 `sunxi.fex`”的传统路径。

### 6.3 原因三：A733 默认启用了“运行时替换 FDT”，R818 没启用

R818：

- `# CONFIG_OF_SEPARATE is not set`
- `board_common.c` 不会进入 `sunxi_replace_fdt_v2()`

A733：

- `CONFIG_OF_SEPARATE=y`
- `CONFIG_SUNXI_NECESSARY_REPLACE_FDT=y`
- `board_common.c` 明确执行 `sunxi_replace_fdt_v2()`

这代表两边在启动后段的设计理念已经变了：

- R818 更偏“默认不走 `boot.img`+replace_fdt_v2 这条后半程显式切换链路，而是沿当前 `working_fdt` 继续修补；同时 boot_package 中独立 dtb item 被显式保留”
- A733 更偏“先启动 U-Boot，再在 boot 阶段用 boot.img 内 DTB 替换当前工作树”

### 6.4 原因四：A133/R818 仍保留了更强的“镜像显式收录 DTB”传统

R818 的 `image.cfg` 里有：

- `sunxi.fex`
  - 它作为 `DTB_CONFIG000000` 被显式收录

A733 的 `image.cfg` 里没有这项：

- 默认普通链路只收录 `sys_config.fex/config.fex/board.fex/sys_partition.fex` 等公共配置，以及 `boot_package.fex`

这说明 R818 这套打包思想仍然强调：

- DTB 是一个独立、可见、可被镜像系统直接追踪的对象

而 A733 已经把它拆成了两部分：

- 打包期中间态 `sunxi.fex`
- 运行期真正给 Linux 使用的 `boot.img` 内嵌 DTB

## 7. 对“依赖性”的准确表述

如果把“依赖性”拆成打包期依赖和运行期依赖，会更清楚。

### 7.1 A133/R818

打包期依赖：

- 强依赖 `sys_config.fex -> sunxi.dtb -> sunxi.fex`
- 强依赖 `boot_package.cfg` 中 `item=dtb, sunxi.fex`

运行期依赖：

- 默认链路更依赖 bootloader 侧已有 `working_fdt` 与 boot_package 中独立 dtb item 的保留/可访问路径
- 不依赖 `boot.img` 内嵌 DTB

### 7.2 A733

打包期依赖：

- 仍然会生成 `sunxi.fex`
- 仍会对它做 `update_dtb / update_scp / update_optee`

运行期依赖：

- 普通默认链路基本不依赖 `boot_package` 中独立 DTB
- 更依赖 `u-boot.fex` 内部控制 FDT 与 `boot.img` 内嵌 DTB

## 8. 一句话总结

R818/A133 默认链路之所以还需要 `boot_package` 里的 `sunxi.fex`，更准确地说，是因为它默认仍显式保留 **boot_package 中独立 dtb item**，且不像 A733 那样走 `boot.img` + `replace_fdt_v2()` 这条后半程显式切换路径；而 A733 默认链路之所以去掉这项，是因为它已经演进成“U-Boot 控制 DTB 内聚到 `u-boot.fex`，Linux 最终 DTB 改由 `boot.img` 提供”的架构。

因此：

- R818/A133：`sunxi.fex` 是 boot_package 设计中的主角色
- A733：`sunxi.fex` 仍存在，但更多是打包中间角色，普通启动时不再是 boot_package 的主角色

## 9. 相关源码位置

如果还要继续深挖，本文主要围绕这些文件展开：

- A133/R818：`scripts/pack_img.sh`
- A133/R818：`device/config/chips/r818/configs/default/boot_package.cfg`
- A133/R818：`device/config/chips/r818/configs/default/image.cfg`
- A133/R818：`device/config/chips/r818/configs/default/env.cfg`
- A133/R818：`target/allwinner/r818-sc3917/defconfig`
- A133/R818：`lichee/brandy-2.0/u-boot-2018/.config`
- A133/R818：`lichee/brandy-2.0/u-boot-2018/board/sunxi/board_common.c`
- A133/R818：`lichee/brandy-2.0/u-boot-2018/arch/arm/mach-sunxi/board.c`
- A133/R818：`lichee/brandy-2.0/u-boot-2018/lib/fdtdec.c`
- A133/R818：`lichee/brandy-2.0/spl/sboot/main/sboot_main.c`
- A133/R818：`lichee/brandy-2.0/spl/nboot/main/boot0_main.c`
- A133/R818：`lichee/brandy-2.0/spl/include/private_toc.h`
- A733：`build/pack`
- A733：`build/mkkernel.sh`
- A733：`device/config/chips/a733/configs/default/boot_package.cfg`
- A733：`device/config/chips/a733/configs/default/image.cfg`
- A733：`device/config/chips/a733/configs/default/env.cfg`
- A733：`out/pack_out/sys_partition.fex`
- A733：`brandy/brandy-2.0/u-boot-2018/.config`
- A733：`brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c`
- A733：`brandy/brandy-2.0/u-boot-2018/board/sunxi/sunxi_replace_fdt.c`
- A733：`brandy/brandy-2.0/u-boot-2018/arch/arm/mach-sunxi/board.c`
