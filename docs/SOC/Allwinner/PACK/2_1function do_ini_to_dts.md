
---

## 1. 根目录 `build.sh` 到 `build/pack` 的关系

根目录 `build.sh` 本身不做具体编译/打包逻辑，只是转到 `build/mkcommon.sh`：

```1:30:/home/alientek/A733/tina-aiot/build.sh
#!/bin/bash
# Description:
# Allwinner compile tools usage
# ...
$(cd $(dirname $0) && pwd)/build/mkcommon.sh "$@"
```

所以执行根目录 `build.sh` 后，是否进入 `build/pack`，取决于你传给 `build.sh` 的动作/参数以及 `mkcommon.sh` 的调度。进入 `build/pack` 后，在 `main()` 里正常打包路径会按这个顺序执行：

```3015:3021:/home/alientek/A733/tina-aiot/build/pack
	if [ "$output_resources" == "false" ] && [ -z "$from_resources" ]; then
		do_prepare
		do_ini_to_dts
		do_common
		do_pack_${PACK_TYPE}
		do_finish
		return $?
	fi
```

也就是说 `do_ini_to_dts()` 位于：

```text
do_prepare 之后
do_common / do_pack_xxx / do_finish 之前
```

它是在文件准备好之后、正式更新 boot0/u-boot/生成 image 之前执行的设备树处理阶段。

---

## 2. `do_ini_to_dts()` 开始：进入打包输出目录并生成 `sys_config.bin`

函数一开始：

```834:842:/home/alientek/A733/tina-aiot/build/pack
function do_ini_to_dts()
{
	cd ${LICHEE_PACK_OUT_DIR}/

	maybe_busybox unix2dos sys_config.fex
	script  sys_config.fex > /dev/null

	local DTC_SRC_PATH=${LICHEE_PLAT_OUT}
	local DTC_COMPILER=${LICHEE_PLAT_OUT}/dtc
	local DTC_FLAGS=""
```

这里做了几件事：

### 2.1 进入 `LICHEE_PACK_OUT_DIR`

后续操作都基于打包输出目录。这里一般会有：

- `sys_config.fex`
- `sys_partition.fex`
- `u-boot.fex`
- `boot0_*.fex`
- `sunxi.fex`
- 其他打包中间文件

### 2.2 把 `sys_config.fex` 转成 DOS 格式

```bash
maybe_busybox unix2dos sys_config.fex
```

`maybe_busybox` 会优先调用 `busybox unix2dos`，失败则尝试系统命令。目的是保证全志的 `script` 工具能正确解析 `.fex`。

### 2.3 用 `script` 工具把 `sys_config.fex` 转成 `sys_config.bin`

```bash
script sys_config.fex > /dev/null
```

这个 `script` 不是 shell 的 `script` 命令，而是全志打包工具链里的配置转换工具。它会把文本形式的 `sys_config.fex` 转成二进制形式的 `sys_config.bin`。

这个 `sys_config.bin` 后面会被：

- `uboot_ini_to_dts()` 查询配置项；
- `do_common()` 更新 `boot0` / `fes1` / `u-boot`；
- 其他 update 工具使用。

---

## 3. 准备 DTC 环境

```841:843:/home/alientek/A733/tina-aiot/build/pack
	local DTC_SRC_PATH=${LICHEE_PLAT_OUT}
	local DTC_COMPILER=${LICHEE_PLAT_OUT}/dtc
	local DTC_FLAGS=""
```

这里指定：

| 变量 | 含义 |
|---|---|
| `DTC_SRC_PATH` | 设备树中间文件所在目录，指向平台输出目录 `LICHEE_PLAT_OUT` |
| `DTC_COMPILER` | 使用平台输出目录里的 `dtc` |
| `DTC_FLAGS` | 额外 dtc 参数，当前为空 |

注意这里不是直接使用系统 `/usr/bin/dtc`，而是用编译输出目录下的 `dtc`，因为全志的 `dtc` 很可能带有定制扩展参数，例如 `-F`、`-d` 这种标准 dtc 不一定支持的参数。

---

## 4. 先处理 U-Boot 内部 FDT：`uboot_ini_to_dts`

`do_ini_to_dts()` 接着调用：

```845:845:/home/alientek/A733/tina-aiot/build/pack
	uboot_ini_to_dts
```

`uboot_ini_to_dts()` 的作用是尝试把 `sys_config.fex` 的配置同步到 U-Boot 内部携带的 FDT。

### 4.1 U-Boot 2023 直接跳过

```760:763:/home/alientek/A733/tina-aiot/build/pack
	if [ x${LICHEE_BRANDY_UBOOT_VER} == x2023 ]; then
		pack_info "skip split fdt"
		return
	fi
```

如果使用的是 `LICHEE_BRANDY_UBOOT_VER=2023`，它不会拆分/合并 U-Boot FDT，直接返回。

### 4.2 根据是否 NOR 选择 U-Boot 文件

```780:784:/home/alientek/A733/tina-aiot/build/pack
	if [ "x${PACK_NOR}" == "xnor" ]; then
		TARGET_UBOOT=${LICHEE_PACK_OUT_DIR}/u-boot-spinor.fex
	else
		TARGET_UBOOT=${LICHEE_PACK_OUT_DIR}/u-boot.fex
	fi
```

- NOR 打包：处理 `u-boot-spinor.fex`
- 普通 NAND/eMMC/SD 打包：处理 `u-boot.fex`

### 4.3 拆分 U-Boot 和 FDT

```785:791:/home/alientek/A733/tina-aiot/build/pack
	sunxi_ubootools split ${TARGET_UBOOT} > /dev/null
	if [ $? -ne 0 ]
	then
		pack_warn "split uboot and fdt failed!!"
		return
	fi
```

这里用 `sunxi_ubootools split` 从 U-Boot 镜像中拆出：

- `temp_ubootnodtb.bin`：不带 DTB 的 U-Boot 主体
- `temp_fdt.dtb`：U-Boot 内嵌的 FDT/DTB

如果拆失败，只打印 warning 并返回，不会终止整个打包。

### 4.4 把 U-Boot 的 DTB 反编译成 DTS

```798:798:/home/alientek/A733/tina-aiot/build/pack
	$DTC_COMPILER ${DTC_FLAGS} -I dtb -O dts -o ${LICHEE_PACK_OUT_DIR}/.uboot.dtb.dts.tmp ${LICHEE_PACK_OUT_DIR}/temp_fdt.dtb  2>/dev/null
```

生成临时 DTS：

```text
${LICHEE_PACK_OUT_DIR}/.uboot.dtb.dts.tmp
```

### 4.5 dragonboard / dragonabts 增加测试标志

```803:814:/home/alientek/A733/tina-aiot/build/pack
	if [ "x${PACK_TYPE}" = "xdragonboard" -o "x${PACK_TYPE}" = "xdragonabts" ] ; then
		cat <<- EOF >> ${LICHEE_PACK_OUT_DIR}/.uboot.dtb.dts.tmp
		/{
			soc@${SOC_ADDR} {
				platform@${PLATFORM_ADDR} {
				dragonboard_test = <1>;
				};
			};
		};
		EOF
	fi
```

如果是测试固件类型，会往 U-Boot DTS 里追加：

```dts
dragonboard_test = <1>;
```

用于 DragonBoard/ABTS 测试模式识别。

### 4.6 重新编译 U-Boot 临时 DTB

```818:818:/home/alientek/A733/tina-aiot/build/pack
	$DTC_COMPILER ${DTC_FLAGS} -I dts -O dtb -o ${LICHEE_PACK_OUT_DIR}/temp_fdt.dtb ${LICHEE_PACK_OUT_DIR}/.uboot.dtb.dts.tmp  2>/dev/null
```

### 4.7 判断是否需要把 `sys_config` 合入 U-Boot FDT

```821:830:/home/alientek/A733/tina-aiot/build/pack
	sunxi_ubootools subkey_value sys_config.bin sunxi_ubootools update_to_ubootfdt > /dev/null
	if [ $? -eq 1 ]; then
		echo "uboot ini to dts"
		$DTC_COMPILER -p 2048 ${DTC_FLAGS} -@ -O dtb -o ${LICHEE_PACK_OUT_DIR}/new_fdt.dtb	\
			-b 0			\
			-i ${LICHEE_PACK_OUT_DIR}	\
			-F $DTC_INI_FILE \
			-d ${LICHEE_PACK_OUT_DIR}/temp_fdt.dtb ${LICHEE_PACK_OUT_DIR}/.uboot.dtb.dts.tmp 2>/dev/null
	else
		mv ${LICHEE_PACK_OUT_DIR}/temp_fdt.dtb  ${LICHEE_PACK_OUT_DIR}/new_fdt.dtb
	fi
```

这里逻辑比较关键：

它从 `sys_config.bin` 里查：

```text
[sunxi_ubootools]
update_to_ubootfdt
```

如果返回码为 `1`，则执行“uboot ini to dts”，用 `dtc -F` 把 ini/fex 配置合并进 U-Boot FDT，输出：

```text
new_fdt.dtb
```

否则只是把 `temp_fdt.dtb` 改名为 `new_fdt.dtb`，也就是不做 ini 到 U-Boot FDT 的合并。

不过这里有个值得注意的点：`uboot_ini_to_dts()` 中使用了 `$DTC_INI_FILE`，但 `do_ini_to_dts()` 里 `DTC_INI_FILE` 是在调用 `uboot_ini_to_dts` 之后才定义的。因此从当前代码看，如果真的走到 `-F $DTC_INI_FILE` 这个分支，`DTC_INI_FILE` 可能为空或依赖外部环境变量。这看起来像历史遗留问题或潜在 bug。实际是否触发，要看你的 `sys_config.fex` 里是否配置了 `sunxi_ubootools.update_to_ubootfdt`，以及 `sunxi_ubootools subkey_value` 的返回语义。

### 4.8 合并新的 FDT 回 U-Boot

```832:835:/home/alientek/A733/tina-aiot/build/pack
	sunxi_ubootools merge ${LICHEE_PACK_OUT_DIR}/temp_ubootnodtb.bin ${LICHEE_PACK_OUT_DIR}/new_fdt.dtb > /dev/null
	cp -vf ${LICHEE_PACK_OUT_DIR}/temp_ubootnodtb.bin ${TARGET_UBOOT}
	# .uboot.dts is the last dts of uboot
	$DTC_COMPILER ${DTC_FLAGS} -I dtb -O dts -o ${LICHEE_PACK_OUT_DIR}/.uboot.dts ${LICHEE_PACK_OUT_DIR}/new_fdt.dtb 2>/dev/null
```

最终：

- `new_fdt.dtb` 被合回 U-Boot；
- 更新后的结果覆盖原来的 `u-boot.fex` 或 `u-boot-spinor.fex`；
- 同时生成 `.uboot.dts`，方便调试查看最终 U-Boot 设备树内容。

---

## 5. 新内核分支：只反编译 `sunxi.dtb`，不重新生成

`uboot_ini_to_dts()` 返回后，`do_ini_to_dts()` 检查内核版本：

```847:861:/home/alientek/A733/tina-aiot/build/pack
	if [ "x${PACK_KERN}" == "xlinux-3.4" \
			-o "x${PACK_KERN}" == "xlinux-3.10" \
			-o "x${PACK_KERN}" == "xlinux-4.4" \
			-o "x${PACK_KERN}" == "xlinux-5.4" \
			-o "x${PACK_KERN}" == "xlinux-5.4-ansc" \
			-o "x${PACK_KERN}" == "xlinux-5.10" \
			-o "x${PACK_KERN}" == "xlinux-5.10-rt" \
			-o "x${PACK_KERN}" == "xlinux-5.10-origin" \
			-o "x${PACK_KERN}" == "xlinux-5.15" \
			-o "x${PACK_KERN}" == "xlinux-5.15-origin" ] || [[  ${PACK_KERN/linux-} > 5.15 ]]; then
		# For debug: sunxi.dtb -> .sunxi.dts
		$DTC_COMPILER ${DTC_FLAGS} -I dtb -O dts -o ${LICHEE_PLAT_OUT}/.sunxi.dts ${LICHEE_PLAT_OUT}/sunxi.dtb 2>/dev/null
		return
	fi
```

如果内核版本是：

- `linux-3.4`
- `linux-3.10`
- `linux-4.4`
- `linux-5.4`
- `linux-5.10`
- `linux-5.15`
- 或大于 `5.15`

那么这个函数**不会重新用 `sys_config.fex` 生成 `sunxi.dtb`**，只是执行：

```bash
dtc -I dtb -O dts -o ${LICHEE_PLAT_OUT}/.sunxi.dts ${LICHEE_PLAT_OUT}/sunxi.dtb
```

也就是把已经存在的 `sunxi.dtb` 反编译成：

```text
${LICHEE_PLAT_OUT}/.sunxi.dts
```

用于调试查看，然后直接 `return`。

这说明在这些新内核路径里，内核 DTB 一般已经由内核构建阶段生成，`pack` 阶段不再做老式的 `sys_config.fex -> dts/dtb` 转换。

---

## 6. 老内核/老流程分支：用 `sys_config.fex` 重新生成 `sunxi.dtb`

如果没有命中新内核分支，后面会走老式流程。

### 6.1 准备候选依赖文件和 DTS 源文件

```864:868:/home/alientek/A733/tina-aiot/build/pack
	local dtc_file_list=(
		.board.dtb.d.dtc.tmp:.board.dtb.dts.tmp
		.${PACK_CHIP}-${PACK_BOARD}.dtb.d.dtc.tmp:.${PACK_CHIP}-${PACK_BOARD}.dtb.dts.tmp
		.${PACK_CHIP}-${LICHEE_BUSSINESS}.dtb.d.dtc.tmp:.${PACK_CHIP}-${LICHEE_BUSSINESS}.dtb.dts.tmp
		.${PACK_CHIP}-soc.dtb.d.dtc.tmp:.${PACK_CHIP}-soc.dtb.dts.tmp)
```

这里维护了一组候选：

```text
依赖文件 : DTS 源文件
```

优先级是：

1. `.board.dtb.d.dtc.tmp` / `.board.dtb.dts.tmp`
2. `.${PACK_CHIP}-${PACK_BOARD}.dtb.d.dtc.tmp` / `.${PACK_CHIP}-${PACK_BOARD}.dtb.dts.tmp`
3. `.${PACK_CHIP}-${LICHEE_BUSSINESS}.dtb.d.dtc.tmp` / `.${PACK_CHIP}-${LICHEE_BUSSINESS}.dtb.dts.tmp`
4. `.${PACK_CHIP}-soc.dtb.d.dtc.tmp` / `.${PACK_CHIP}-soc.dtb.dts.tmp`

这些文件一般是内核或前面步骤生成的临时设备树源/依赖文件。

### 6.2 生成修正后的 `sys_config_fix.fex`

```870:877:/home/alientek/A733/tina-aiot/build/pack
	local DTC_INI_FILE_BASE=${LICHEE_PACK_OUT_DIR}/sys_config.fex
	local DTC_INI_FILE=${LICHEE_PACK_OUT_DIR}/sys_config_fix.fex

	cp $DTC_INI_FILE_BASE $DTC_INI_FILE
	sed -i "s/\(\[dram\)_para\(\]\)/\1\2/g" $DTC_INI_FILE
	sed -i "s/\(\[nand[0-9]\)_para\(\]\)/\1\2/g" $DTC_INI_FILE
```

它把：

```text
sys_config.fex
```

复制成：

```text
sys_config_fix.fex
```

然后修正两个类型的 section 名称：

```text
[dram_para]    -> [dram]
[nand0_para]   -> [nand0]
[nand1_para]   -> [nand1]
...
```

原因是 `dtc -F` 合并配置时，可能期望节点名是 `dram` / `nand0`，而不是老式 fex 里的 `dram_para` / `nand0_para`。

### 6.3 检查 `dtc` 是否存在

```879:882:/home/alientek/A733/tina-aiot/build/pack
	if [ ! -f $DTC_COMPILER ]; then
		pack_error "Script_to_dts: Can not find dtc compiler.\n"
		exit 1
	fi
```

如果 `${LICHEE_PLAT_OUT}/dtc` 不存在，直接终止打包。

### 6.4 选择第一个存在的 DTS 临时源

```884:891:/home/alientek/A733/tina-aiot/build/pack
	local DTC_DEP_FILE DTC_SRC_FILE
	for e in ${dtc_file_list[@]}; do
		DTC_DEP_FILE=$DTC_SRC_PATH/${e/:*}
		if [ -f $DTC_DEP_FILE ]; then
			DTC_SRC_FILE=$DTC_SRC_PATH/${e#*:}
			break
		fi
	done
```

遍历前面定义的候选列表，只要发现依赖文件存在，就选它对应的 DTS 源文件。

最终会得到：

```text
DTC_DEP_FILE = 某个 .dtb.d.dtc.tmp
DTC_SRC_FILE = 对应的 .dtb.dts.tmp
```

---

## 7. 核心动作：`dtc -F sys_config_fix.fex` 生成 `sunxi.dtb`

```893:899:/home/alientek/A733/tina-aiot/build/pack
	echo "sunxi_dtb create"
	$DTC_COMPILER -p 2048 ${DTC_FLAGS} -@ -O dtb -o ${LICHEE_PLAT_OUT}/sunxi.dtb	\
		-b 0			\
		-i $DTC_SRC_PATH	\
		-F $DTC_INI_FILE	\
		-d $DTC_DEP_FILE $DTC_SRC_FILE 2>/dev/null
```

这是老流程下 `do_ini_to_dts()` 的核心。

它调用全志定制 `dtc`：

```bash
dtc \
  -p 2048 \
  -@ \
  -O dtb \
  -o ${LICHEE_PLAT_OUT}/sunxi.dtb \
  -b 0 \
  -i ${LICHEE_PLAT_OUT} \
  -F ${LICHEE_PACK_OUT_DIR}/sys_config_fix.fex \
  -d ${DTC_DEP_FILE} \
  ${DTC_SRC_FILE}
```

可以理解为：

```text
DTS 临时源文件 + sys_config_fix.fex 配置覆盖/补丁 => 最终 sunxi.dtb
```

其中：

| 参数 | 作用 |
|---|---|
| `-O dtb` | 输出 DTB |
| `-o ${LICHEE_PLAT_OUT}/sunxi.dtb` | 输出内核最终使用的 `sunxi.dtb` |
| `-i $DTC_SRC_PATH` | include 搜索路径 |
| `-F $DTC_INI_FILE` | 全志扩展参数，用 `.fex/.ini` 配置修正 DTS/DTB |
| `-d $DTC_DEP_FILE` | 依赖文件 |
| `$DTC_SRC_FILE` | 输入 DTS 临时源 |

如果失败：

```901:904:/home/alientek/A733/tina-aiot/build/pack
	if [ $? -ne 0 ]; then
		pack_error "Conver script to dts failed"
		exit 1
	fi
```

会直接报错并退出。

---

## 8. dragonboard / dragonmat 恢复被备份的 dtsi

```907:915:/home/alientek/A733/tina-aiot/build/pack
	if [ "x${PACK_TYPE}" = "xdragonboard" \
		-o "x${PACK_TYPE}" = "xdragonmat" ]; then
		local DTS_PATH=${LICHEE_KERN_DIR}/arch/${LICHEE_ARCH}/boot/dts
		[ "x${LICHEE_ARCH}" = "xarm64" ] && DTS_PATH=${LICHEE_KERN_DIR}/arch/${LICHEE_ARCH}/boot/dts/sunxi
		if [ -f ${DTS_PATH}/${PACK_CHIP}_bak.dtsi ];then
			rm -f ${DTS_PATH}/${PACK_CHIP}.dtsi
			mv  ${DTS_PATH}/${PACK_CHIP}_bak.dtsi  ${DTS_PATH}/${PACK_CHIP}.dtsi
		fi
	fi
```

如果是 `dragonboard` 或 `dragonmat`，它会检查是否存在：

```text
${PACK_CHIP}_bak.dtsi
```

如果存在，就恢复为：

```text
${PACK_CHIP}.dtsi
```

这说明前面某些流程可能临时改过芯片 dtsi，`do_ini_to_dts()` 结束时负责恢复。

---

## 9. 最后生成调试用 `.sunxi.dts`

```917:921:/home/alientek/A733/tina-aiot/build/pack
	printf "Conver script to dts ok.\n"

	# It'is used for debug dtb
	$DTC_COMPILER ${DTC_FLAGS} -I dtb -O dts -o ${LICHEE_PLAT_OUT}/.sunxi.dts ${LICHEE_PLAT_OUT}/sunxi.dtb 2>/dev/null
```

不管老流程是否重新生成 `sunxi.dtb`，最后都会把 `sunxi.dtb` 反编译成：

```text
${LICHEE_PLAT_OUT}/.sunxi.dts
```

方便调试确认最终设备树内容。

---

## 10. 总结成一句话

`do_ini_to_dts()` 的作用是：

> 在打包阶段把 `sys_config.fex` 转成 `sys_config.bin`，尝试把相关配置合入 U-Boot 内部 FDT；对于老设备树流程，还会用全志定制 `dtc -F sys_config_fix.fex` 把 `.dts.tmp` 和 `sys_config.fex` 合成为最终的 `${LICHEE_PLAT_OUT}/sunxi.dtb`；对于新内核流程，则不再重建 `sunxi.dtb`，只反编译生成 `.sunxi.dts` 供调试。

可以按内核版本分成两类理解：

| 情况 | `do_ini_to_dts()` 对内核 `sunxi.dtb` 做什么 |
|---|---|
| `linux-3.4/3.10/4.4/5.4/5.10/5.15/更高` | 不重新生成，只把已有 `sunxi.dtb` 反编译成 `.sunxi.dts` |
| 未命中新内核列表的老流程 | 用 `sys_config_fix.fex` + `.dtb.dts.tmp` 重新生成 `sunxi.dtb` |

但无论哪种情况，它都会先调用 `uboot_ini_to_dts()`，尝试处理 U-Boot 镜像内部的 FDT。

