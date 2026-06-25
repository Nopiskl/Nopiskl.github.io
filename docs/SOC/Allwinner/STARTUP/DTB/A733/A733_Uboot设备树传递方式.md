# A733 中 U-Boot DTB 与 Linux DTB 分工说明

## 1. 文档目的

本文聚焦回答两个问题：

1. A733 的 `build/pack` 为什么要在 `uboot_ini_to_dts()` 中把 `u-boot.fex` 拆开、更新 DTB、再合回去
2. 为什么不把方案设计成“U-Boot 从启动一开始就直接使用 Linux DTB”

本文基于当前工作区源码分析：

- A733 SDK：`/home/alientek/A733/qihua-x73x-linux6.6`
- 参考文档：
  - `agent/a133_r818_vs_a733_boot_package_sunxi_fex_dependency_analysis.md`
  - `agent/a733_boot_dtb_flow.md`
  - `agent/a133_r818_no_fdt_replacement_explanation.md`

分析对象以当前默认普通启动链路为主：

- `device/config/chips/a733/configs/default/`

本文的配套对照文档是：

- `agent/a133_r818_no_fdt_replacement_explanation.md`

如果想同时看清 A733 的“双树切换模型”和 A133/R818 的“单树沿用模型”，建议两篇一起阅读。

## 2. 先给结论

可以先压缩成 4 句话：

1. A733 不是“重复保存同一份 DTB”，而是明确维护了两类 DTB：U-Boot 控制 DTB 与 Linux 运行 DTB。
2. `uboot_ini_to_dts()` 的作用，是把当前打包配置同步回 `u-boot.fex` 自带的控制 DTB，而不是简单重复生成一份 Linux DTB。
3. A733 运行时并不是从上电开始就只依赖 Linux DTB；U-Boot 先使用自己的控制 DTB 启动和执行板级逻辑，临近启动内核前才切换到 Linux DTB。
4. 当前默认分区表里没有独立 `dtb` 分区，因此 A733 最终会从 `boot.img` 中提取 DTB 覆盖当前工作 FDT，但这一步是“职责切换”，不是前面工作都白做了。

## 3. A733 默认链路里到底有哪两棵树

### 3.1 U-Boot 控制 DTB

U-Boot 启动早期需要一棵自己的控制树。

`board_fdt_blob_setup()` 会优先从 U-Boot 自身镜像尾部取 DTB；如果尾部没有有效 DTB，则退回固定偏移：

- `brandy/brandy-2.0/u-boot-2018/arch/arm/mach-sunxi/board.c:170-177`

`fdtdec_setup()` 随后把这棵树设为 `gd->fdt_blob`，并调用 `set_working_fdt_addr()`：

- `brandy/brandy-2.0/u-boot-2018/lib/fdtdec.c:1453-1457`

同时，A733 这套 sunxi U-Boot 在 Kconfig 中选择了 `OF_SEPARATE`：

- `brandy/brandy-2.0/u-boot-2018/arch/arm/Kconfig:810-824`
- `brandy/brandy-2.0/u-boot-2018/dts/Kconfig:73-79`

这说明 A733 的 U-Boot 本身就预期携带一份独立 control DTB。

### 3.2 Linux 运行 DTB

A733 的 `build/mkkernel.sh` 在生成 `boot.img` 时固定使用：

```sh
${MKBOOTIMG} --kernel ${BIMAGE} \
    ...
    --dtb ${DTB} \
    --dtb_offset ${DTB_OFFSET} \
    --header_version 2 \
    -o $STAGING_DIR/${IMAGE_NAME}
```

见：

- `build/mkkernel.sh:690-699`

所以 Linux 运行时那棵 DTB 是跟着 `boot.img` 走的。

## 4. `uboot_ini_to_dts()` 到底做了什么

### 4.1 代码路径

`build/pack` 中 `uboot_ini_to_dts()` 的核心流程如下：

1. `sunxi_ubootools split ${TARGET_UBOOT}`
2. 取出 `temp_fdt.dtb`
3. 反编译成 `.uboot.dtb.dts.tmp`
4. 根据当前打包配置重新生成 `new_fdt.dtb`
5. `sunxi_ubootools merge ... new_fdt.dtb`
6. 把更新后的结果覆盖回 `u-boot.fex`

对应代码：

- `build/pack:770-836`

其中最关键的几行是：

```sh
sunxi_ubootools split ${TARGET_UBOOT}
$DTC_COMPILER -I dtb -O dts -o .../.uboot.dtb.dts.tmp .../temp_fdt.dtb
sunxi_ubootools subkey_value sys_config.bin sunxi_ubootools update_to_ubootfdt
$DTC_COMPILER ... -F $DTC_INI_FILE -d .../temp_fdt.dtb .../.uboot.dtb.dts.tmp
sunxi_ubootools merge .../temp_ubootnodtb.bin .../new_fdt.dtb
```

### 4.2 这不是“重复编一份 DTB”，而是“在原 U-Boot DTB 上做增量修正”

这段流程最重要的意义，是它先保留了 `u-boot.fex` 原本自带的控制树，再把当前板级配置同步回去。

证据有两点：

1. 代码不是直接从零只靠 `sys_config.fex` 生成一棵 U-Boot DTB，而是先从 `u-boot.fex` 中拆出 `temp_fdt.dtb`。
2. 随后又把这棵树反编译成 `.uboot.dtb.dts.tmp`，并在其基础上继续生成 `new_fdt.dtb`。

也就是说，这更像是：

`原 U-Boot 控制 DTB + 当前 sys_config/打包信息 -> 更新后的 U-Boot 控制 DTB`

而不是：

`sys_config.fex -> 重新制造一棵与 U-Boot 无关的新树`

### 4.3 它解决的核心问题

`uboot_ini_to_dts()` 至少解决了 3 类问题。

#### 4.3.1 让打包期板级配置真正进入 U-Boot 运行时

U-Boot 里大量板级逻辑直接读取 `working_fdt`。

最直接的入口就是 `script_parser_fetch()`：

- `brandy/brandy-2.0/u-boot-2018/board/sunxi/sys_config.c:1839-1856`

它本质上就是：

```c
nodeoffset = fdt_path_offset(working_fdt, node_path);
ret = fdt_getprop_u32(working_fdt, nodeoffset, prop_name, ...);
```

也就是说，如果 `sys_config.fex` 里的变化没有同步回 `u-boot.fex`，那么 U-Boot 运行时看到的仍可能是旧控制树。

#### 4.3.2 保留 U-Boot 专有节点与属性

A733 板级目录本身就单独维护了 `uboot-board.dts`，说明厂商默认认为 U-Boot DTS 和 Linux DTS 不完全等价。

例如 `device/config/chips/a733/configs/pro3/uboot-board.dts` 中可以看到：

- `/soc/platform` 下的 `eraseflag`、`next_work`、`debug_mode`
- `/soc/target` 下的 `boot_clock`、`storage_type`、`burn_key`、`dragonboard_test`

见：

- `device/config/chips/a733/configs/pro3/uboot-board.dts:328-339`

这些属性显然更偏 bootloader 运行期，而不是 Linux 设备描述。

`build/pack` 甚至还会在打包期专门向 U-Boot DTS 注入 `dragonboard_test = <1>`：

- `build/pack:805-814`

这进一步说明 `uboot_ini_to_dts()` 的目标不是“让 U-Boot 服从 Linux DTB”，而是“维护 U-Boot 自己那棵树”。

#### 4.3.3 避免每次改板级配置都重编 U-Boot

`uboot_ini_to_dts()` 处理的是已经生成好的 `u-boot.fex`，更像打包期补丁流程。

这让 `sys_config.fex` 或某些板级打包变量的变更，可以直接反映到最终 `u-boot.fex`，而不一定要求完整重编 U-Boot。

## 5. 为什么不让 U-Boot 从一开始就直接用 Linux DTB

### 5.1 A733 其实已经“读 Linux DTB”，但发生在启动后半程

A733 默认打开了：

- `CONFIG_SUNXI_NECESSARY_REPLACE_FDT=y`

见：

- `brandy/brandy-2.0/u-boot-2018/configs/sun60iw2p1_a733_defconfig:20-25`

所以 `board_common.c` 在启动流程中会执行：

```c
#elif defined(CONFIG_SUNXI_NECESSARY_REPLACE_FDT)
        sunxi_replace_fdt_v2();
        sunxi_update_fdt_para_for_kernel();
```

见：

- `brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:823-830`

`sunxi_replace_fdt_v2()` 的取 DTB 顺序是：

1. 先读 `dtb` 分区
2. 如果无效，再去 `boot` 分区的 `boot.img` 里取 DTB

见：

- `brandy/brandy-2.0/u-boot-2018/board/sunxi/sunxi_replace_fdt.c:274-312`

而当前默认分区表没有单独 `dtb` 分区：

- `device/config/chips/a733/configs/default/sys_partition.fex:36-61`

所以当前默认场景实际会回退到 `boot.img`。

换句话说，A733 不是“不读取 Linux DTB”，而是“不从启动一开始就只依赖 Linux DTB”。

### 5.2 启动早期就需要 control DTB，等不到 `boot.img`

U-Boot 很多逻辑发生在真正解析 `boot.img` 之前。

例如当前源码里有大量直接依赖 `working_fdt` 的访问：

- 按键相关：`sunxi_lradc_vol.c`
- 启动 GPIO：`board_common.c`
- 串口特性：`sunxi_serial.c`
- 恢复与模式判断：`board_helper.c`
- 各种 `script_parser_fetch()` 入口：`sys_config.c`

这些文件都直接对 `working_fdt` 做 `fdt_path_offset()` 或属性访问。

如果设计成“U-Boot 先什么都没有，等读到 `boot.img` 再拿 Linux DTB”，那启动早期依赖的板级描述就会缺位。

### 5.3 U-Boot 需要的是“能控制自己”的树，不只是“能描述 Linux 设备”的树

当前 A733 的 `uboot-board.dts` 里含有很多更偏 bootloader 控制语义的属性。

例如：

- `/soc/target/boot_clock`
- `/soc/target/storage_type`
- `/soc/target/burn_key`
- `/soc/target/dragonboard_test`
- `/soc/platform/debug_mode`

见：

- `device/config/chips/a733/configs/pro3/uboot-board.dts:328-339`

这些属性在 Linux DTB 中未必有，或者即使存在，也未必适合作为 Linux 运行树的一部分长期维护。

所以厂商把 U-Boot control DTB 与 Linux runtime DTB 分开，是符合这套 SDK 实际工程边界的。

### 5.4 可靠性更高

如果 U-Boot 从一开始完全依赖 `boot.img` 才能拿到控制树，那么 `boot` 分区损坏时，bootloader 早期行为也会被牵连。

当前 A733 的做法是：

1. U-Boot 先带着自己的 control DTB 启起来
2. 到启动内核前，再切到 Linux DTB

这让 bootloader 早期路径与 kernel/boot.img 版本绑定关系适度解耦。

### 5.5 便于 kernel 与 bootloader 分开维护

Linux DTB 与 `boot.img` 强绑定，是合理的，因为 kernel 和 DTB 通常需要版本配套。

U-Boot control DTB 与 `u-boot.fex` 绑定，也是合理的，因为 bootloader 需要自己的配置和节点。

因此 A733 选择的不是“只保留一棵树”，而是“在正确阶段切换到正确的树”。

## 6. 为什么说“替换 current working FDT”不是浪费

### 6.1 替换前后的树职责不同

切换前：

- `working_fdt` 主要服务 U-Boot 自己的驱动与板级逻辑

切换后：

- `working_fdt` 变成最终传给 Linux 的那棵树

`sunxi_replace_fdt_v2()` 会把旧 `working_fdt` 保存到 `gd->uboot_fdt_blob`，再把新的树放到 `gd->new_ext_fdt`：

- `brandy/brandy-2.0/u-boot-2018/board/sunxi/sunxi_replace_fdt.c:262-269`

这说明设计者明确知道两棵树并不等价，旧树不是简单废弃，而是被保留下来备用。

### 6.2 替换后仍有代码显式回看 U-Boot 原始 DTB

例如 `board_helper.c` 中关于 `dragonboard_test` 的逻辑，就会同时参考：

- `gd->uboot_fdt_blob`
- 当前 `working_fdt`

见：

- `brandy/brandy-2.0/u-boot-2018/board/sunxi/board_helper.c:1144-1152`

这进一步说明 A733 不是把两棵树当成完全重复的内容。

### 6.3 体积代价不大，但带来的解耦收益很实用

当前工作区产物里，相关体积大致为：

- `out/pack_out/u-boot.fex` 约 `1.1M`
- `out/pack_out/sunxi.fex` 约 `202K`
- `out/a733/kernel/staging/sunxi.dtb` 约 `198K`
- 某次 `new_fdt.dtb` 约 `42K`

也就是说，额外空间成本相对整个启动镜像并不高，但换来了：

- bootloader 早期可独立运行
- kernel DTB 与 `boot.img` 绑定升级
- 打包期板级配置能同步回 U-Boot

## 7. 和“主线很多板子直接用 Linux DTB”怎么理解

这个观察没有错，但需要区分几种不同层次：

1. 共用同一套 DTS 源
2. U-Boot 在后期加载 Linux DTB
3. U-Boot 从上电一开始就完全没有自己的 control DTB

这三件事不能混为一谈。

U-Boot 自己的文档里就明确把 control DTB 的来源区分为：

- `CONFIG_OF_SEPARATE`
- `CONFIG_OF_EMBED`
- `CONFIG_OF_BOARD`

见：

- `brandy/brandy-2.0/u-boot-2018/doc/README.fdt-control:120-147`

所以“主线板子最后也传 Linux DTB”并不等于“启动一开始完全不需要 U-Boot 自己的 control DTB”。

对 A733 这套厂商 SDK 来说，更贴切的描述是：

- U-Boot 前半程使用自己的 control DTB
- Linux 启动前切换到 runtime DTB

这是一种分层设计，而不是设计失误。

## 8. 最终结论

针对两个原始问题，可以直接归纳为：

### 问题 1：为什么 `uboot_ini_to_dts()` 要拆 U-Boot、改 DTB、再合回去

因为 A733 的 `u-boot.fex` 自带一棵 U-Boot control DTB。  
`uboot_ini_to_dts()` 的作用，是保留这棵 control DTB 的 U-Boot 专有结构，再把当前 `sys_config.fex` 和打包期板级信息同步回去，避免最终 U-Boot 运行时读取到过期配置。

### 问题 2：为什么不让 U-Boot 从头直接使用 Linux DTB

因为 U-Boot 在真正解析 `boot.img` 之前，就已经需要依赖 FDT 执行大量板级逻辑；同时 A733 的 U-Boot 还存在明显偏 bootloader 的专有节点和属性。  
因此 A733 采用的是：

`先用 U-Boot control DTB 启动自己 -> 启动内核前再切换到 Linux DTB`

这不是重复劳动，而是将 bootloader 控制树与 Linux 运行树分工管理。
