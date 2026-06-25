
**Cursor**

我先查看 `do_pack_tina` 及其相关函数实现，再按你给的大纲对照分析。

我已经定位到函数实现。下面按“do_pack_tina 阶段做了什么、普通包和安全包差异、与官方大纲的对应关系”来分析。`do_pack_tina()` 是 Tina 打包流程中“把编译产物整理成 dragon 打包所需 `.fex` 文件，并在安全启动场景下完成签名准备”的阶段。它本身不直接生成最终 `.img`，最终镜像生成仍然在后面的 `do_finish()` / `do_dragon()` 阶段完成；但它会准备好 `boot.fex`、`rootfs.fex`、`kernel.fex`、`recovery.fex`、`toc0.fex`、`toc1.fex` 等关键输入文件。

对应源码位置在 `scripts/pack_img.sh` 的 `do_signature()` 和 `do_pack_tina()` 附近：

```1584:1672:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
function do_signature()
{
	# merge flag: '1' - merge atf/scp/uboot/optee in one package, '0' - do not merge.
	local merge_flag=0

	printf "prepare for signature by openssl\n"
	if [ "x${PACK_SIG}" = "xprev_refurbish" ] ; then
		if [ "x${ARCH}" = "xarm64" ] ; then
			if [ -f ${LONGAN_COMMON_DIR}/sign_config/dragon_toc_a64_no_secureos.cfg ]; then
				cp -v ${LONGAN_COMMON_DIR}/sign_config/dragon_toc_a64_no_secureos.cfg dragon_toc.cfg
			else
				cp -v ${TINA_CONFIG_DIR}/generic/sign_config/dragon_toc_a64_no_secureos.cfg dragon_toc.cfg
			fi
		else
			if [ -f ${LONGAN_COMMON_DIR}/sign_config/dragon_toc_no_secureos.cfg ]; then
				cp -v ${LONGAN_COMMON_DIR}/sign_config/dragon_toc_no_secureos.cfg dragon_toc.cfg
			else
				cp -v ${TINA_CONFIG_DIR}/generic/sign_config/dragon_toc_no_secureos.cfg dragon_toc.cfg
			fi
		fi
	else
		if [ "x${ARCH}" = "xarm64" ] ; then
			if [ -f ${LONGAN_CONFIG_DIR}/default/dragon_toc.cfg ] ; then
				cp -v ${LONGAN_CONFIG_DIR}/default/dragon_toc.cfg dragon_toc.cfg
			elif [ -f ${LONGAN_COMMON_DIR}/sign_config/dragon_toc_a64.cfg dragon_toc.cfg ] ; then
				cp -v ${LONGAN_COMMON_DIR}/sign_config/dragon_toc_a64.cfg dragon_toc.cfg
			else
				cp -v ${TINA_CONFIG_DIR}/generic/sign_config/dragon_toc_a64.cfg dragon_toc.cfg
			fi

			grep -r "\[package\]" dragon_toc.cfg > /dev/null
			if [ $? -eq 0 ]; then
				merge_flag=1
			fi
		else
			if [ -f ${LONGAN_CONFIG_DIR}/default/dragon_toc.cfg ] ; then
				cp -v ${LONGAN_CONFIG_DIR}/default/dragon_toc.cfg dragon_toc.cfg
			elif [ -f ${LONGAN_COMMON_DIR}/sign_config/dragon_toc.cfg dragon_toc.cfg ] ; then
				cp -v ${LONGAN_COMMON_DIR}/sign_config/dragon_toc.cfg dragon_toc.cfg
			else
				cp -v ${TINA_CONFIG_DIR}/generic/sign_config/dragon_toc.cfg dragon_toc.cfg
			fi
		fi
	fi
```

```1713:1800:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
function do_pack_tina()
{
	printf "packing for tina linux\n"

	rm -rf vmlinux.fex
	rm -rf boot.fex
	rm -rf rootfs.fex
	rm -rf rootfs_nor.fex
	rm -rf kernel.fex
	rm -rf rootfs_squashfs.fex
	rm -rf usr.fex
	rm -rf recovery.fex
	rm -rf rootfs-extract.fex
	#ln -s ${ROOT_DIR}/vmlinux.tar.bz2 vmlinux.fex
	if [ ! -f vmlinux.fex ]; then
		echo "vmlinux" > vmlinux.fex
	fi


	if [ -f ${ROOT_DIR}/boot_initramfs.img ]; then
		ln -s ${ROOT_DIR}/boot_initramfs.img        boot.fex
	else
		ln -s ${ROOT_DIR}/boot.img        boot.fex
	fi
	# sys_partition_nor.fex in longan may use kernel.fex
	ln -s boot.fex        kernel.fex

	if [ -f ${ROOT_DIR}/${PACK_BOARD}-Image.gz ] ; then
		cp ${ROOT_DIR}/${PACK_BOARD}-Image.gz Image.gz
	fi

	if [ -f Image.gz -a -f fit-image.its ] ; then
		mkimage -f fit-image.its fit-image.fex
	fi

	if [ "x${PACK_SIG}" = "xsecure" ] ; then
		cp -vf ${ROOT_DIR}/rootfs.img rootfs.fex
		[ -f dtbo.img ] &&
			cp -vf dtbo.img dtbo.fex

		# get sample from squashfs rootfs
		grep "CONFIG_TARGET_ROOTFS_SQUASHFS=y" ${PACK_TOPDIR}/.config > /dev/null && \
			grep "CONFIG_USE_UBOOT_VERIFY_SQUASHFS=y" ${PACK_TOPDIR}/.config > /dev/null
		if [ $? -eq 0 ]; then
			# get sample from squashfs rootfs
			local rootfs_per_MB=`grep "^rootfs_per_MB=" ${ROOT_DIR}/image/env.cfg | awk -F = '{printf $2}'`
			if [ -z $rootfs_per_MB ]; then
				echo "rootfs_per_MB is not defined in ${ROOT_DIR}/image/env.cfg, use default value 4096"
				rootfs_per_MB=4096
			fi

			extract_squashfs $rootfs_per_MB rootfs.fex rootfs-extract.fex
			if [ $? -ne 0 ]; then
				echo "extract squashfs error"
				exit 1;
			fi
		fi
	else
		ln -s ${ROOT_DIR}/rootfs.img     rootfs.fex
		[ -f dtbo.img ] &&
			ln -s dtbo.img        dtbo.fex
	fi
```

```1801:1840:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
	# tina don't need rootfs_nor.fex, but some sys_partition.fex for longan use it, so add one for compatibility
	ln -s rootfs.fex rootfs_nor.fex

	if [ -f ${ROOT_DIR}/usr.img ]; then
		ln -s ${ROOT_DIR}/usr.img    usr.fex
	fi

	if [ -f ${ROOT_DIR}/boot_initramfs_recovery.img ]; then
		ln -s ${ROOT_DIR}/boot_initramfs_recovery.img recovery.fex
	else
		touch recovery.fex
		echo "recovery part not used!" > recovery.fex
	fi
	# Those files is ready for SPINor.
	#ln -s ${ROOT_DIR}/uImage          kernel.fex
	#ln -s ${ROOT_DIR}/rootfs.squashfs rootfs_squashfs.fex

	# add for dm-verity block
	grep "CONFIG_USE_DM_VERITY=y" ${PACK_TOPDIR}/.config > /dev/null
	if [ $? -eq 0 ]; then
		cp -vf ${ROOT_DIR}/rootfs.img rootfs.fex
		${PACK_TOPDIR}/scripts/dm-verity-block.sh ${ROOT_DIR}/image/rootfs.fex
		if [ $? -ne 0 ]; then
			echo "error: generate verity block error!"
			exit
		fi
	fi

	if [ "x${PACK_SIG}" = "xsecure" ] ; then
		echo "secure"
		do_signature
	elif [ "x${PACK_SIG}" = "xprev_refurbish" ] ; then
		echo "prev_refurbish"
		do_signature
	else
		echo "normal"
	fi
```

```1841:1855:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/scripts/pack_img.sh
	if [ "x${PACK_SIG}" = "xsecure" ] ; then
		# append the signature to the behind of rootfs.fex
		grep "CONFIG_TARGET_ROOTFS_SQUASHFS=y" ${PACK_TOPDIR}/.config > /dev/null && \
			grep "CONFIG_USE_UBOOT_VERIFY_SQUASHFS=y" ${PACK_TOPDIR}/.config > /dev/null
		if [ $? -eq 0 ]; then
			update_squashfs ${ROOT_DIR}/image/rootfs.fex ${ROOT_DIR}/image/toc1/cert/rootfs.der
			if [ $? -ne 0 ]
			then
				pack_error "signature squashfs rootfs error."
				exit 1
			fi
		fi
	fi
}
```

---

## 1. 阶段入口：声明进入 Tina Linux 打包

函数一开始打印：

```bash
printf "packing for tina linux\n"
```

这说明当前进入的是 Tina Linux 平台特有的打包阶段。这个阶段的核心任务不是编译，而是把前面已经生成好的编译产物转换、链接或复制为后续 `dragon` 工具识别的 `.fex` 文件。

---

## 2. 清理旧的 `.fex` 中间文件

`do_pack_tina()` 首先删除一批旧文件：

```bash
rm -rf vmlinux.fex
rm -rf boot.fex
rm -rf rootfs.fex
rm -rf rootfs_nor.fex
rm -rf kernel.fex
rm -rf rootfs_squashfs.fex
rm -rf usr.fex
rm -rf recovery.fex
rm -rf rootfs-extract.fex
```

这些文件大多是后续 `image.cfg` 或 `sys_partition.fex` 中会引用到的打包输入文件。

作用是：

1. 避免上一次打包残留的软链接或文件影响本次结果。
2. 保证 `boot.fex`、`rootfs.fex`、`kernel.fex` 等文件重新指向当前构建产物。
3. 对安全包来说，后续可能会把 `boot.fex`、`rootfs.fex` 从软链接变成真实文件，因此必须先清理。

---

## 3. 生成占位 `vmlinux.fex`

源码中原本可能想链接 `vmlinux.tar.bz2`：

```bash
#ln -s ${ROOT_DIR}/vmlinux.tar.bz2 vmlinux.fex
```

但实际逻辑是：

```bash
if [ ! -f vmlinux.fex ]; then
	echo "vmlinux" > vmlinux.fex
fi
```

也就是说这里创建了一个占位文件 `vmlinux.fex`。

这说明在当前 Tina 打包流程中，`vmlinux.fex` 并不是核心启动文件，更多是为了满足某些配置文件或打包工具对该文件名的引用，避免缺文件导致打包失败。

---

## 4. 准备 `boot.fex`

这一段是 Tina 打包中非常关键的部分：

```bash
if [ -f ${ROOT_DIR}/boot_initramfs.img ]; then
	ln -s ${ROOT_DIR}/boot_initramfs.img        boot.fex
else
	ln -s ${ROOT_DIR}/boot.img        boot.fex
fi
```

含义是：

1. 如果根目录下存在 `boot_initramfs.img`，优先使用它作为 `boot.fex`。
2. 否则使用普通的 `boot.img` 作为 `boot.fex`。

也就是说：

| 条件 | `boot.fex` 指向 |
|---|---|
| 存在 `boot_initramfs.img` | `${ROOT_DIR}/boot_initramfs.img` |
| 不存在 `boot_initramfs.img` | `${ROOT_DIR}/boot.img` |

`boot.fex` 是后续固件分区中的启动镜像文件。安全签名时，`do_signature()` 也会直接对 `boot.fex` 做校验和签名。

---

## 5. 准备 `kernel.fex`

接着：

```bash
ln -s boot.fex        kernel.fex
```

这里并没有单独链接 `uImage`、`zImage` 或 `Image.gz`，而是让 `kernel.fex` 指向 `boot.fex`。

注释说明：

```bash
# sys_partition_nor.fex in longan may use kernel.fex
```

也就是说，Tina 本身未必需要单独的 `kernel.fex`，但是某些 Longan 或 NOR 分区配置可能还引用 `kernel.fex` 这个名字。为了兼容这类配置，脚本将 `kernel.fex` 软链接到 `boot.fex`。

因此这里的逻辑是兼容性处理：

```text
kernel.fex -> boot.fex -> boot.img 或 boot_initramfs.img
```

---

## 6. 准备 `Image.gz` 和 FIT 镜像

这部分逻辑是：

```bash
if [ -f ${ROOT_DIR}/${PACK_BOARD}-Image.gz ] ; then
	cp ${ROOT_DIR}/${PACK_BOARD}-Image.gz Image.gz
fi

if [ -f Image.gz -a -f fit-image.its ] ; then
	mkimage -f fit-image.its fit-image.fex
fi
```

含义：

1. 如果根目录存在 `${PACK_BOARD}-Image.gz`，则复制为当前 `image` 目录下的 `Image.gz`。
2. 如果同时存在 `Image.gz` 和 `fit-image.its`，则调用 `mkimage` 生成 `fit-image.fex`。

这说明当前平台可能支持 FIT image 打包方式。`fit-image.its` 是 FIT 镜像描述文件，`mkimage -f fit-image.its fit-image.fex` 会根据 its 配置生成 FIT 格式镜像。

不过这部分不是所有平台都会触发，只有存在相关文件时才会执行。

---

## 7. 准备 `rootfs.fex`：普通包和安全包不同

这是 `do_pack_tina()` 中最重要的分支之一。

### 7.1 安全包：复制 `rootfs.img`

当：

```bash
if [ "x${PACK_SIG}" = "xsecure" ] ; then
```

成立时，脚本执行：

```bash
cp -vf ${ROOT_DIR}/rootfs.img rootfs.fex
```

安全包这里使用 `cp`，而不是 `ln -s`。

原因是安全包后续可能要对 `rootfs.fex` 追加签名、生成校验块或修改内容。如果使用软链接，可能会直接影响原始 `rootfs.img`，或者造成签名追加行为不可控。因此安全包场景下先复制一份真实文件作为 `rootfs.fex`。

同时如果当前目录存在 `dtbo.img`，也复制为 `dtbo.fex`：

```bash
[ -f dtbo.img ] &&
	cp -vf dtbo.img dtbo.fex
```

### 7.2 普通包：软链接 `rootfs.img`

如果不是 `secure`，则执行：

```bash
ln -s ${ROOT_DIR}/rootfs.img     rootfs.fex
[ -f dtbo.img ] &&
	ln -s dtbo.img        dtbo.fex
```

普通包下 `rootfs.fex` 只是指向 `${ROOT_DIR}/rootfs.img` 的软链接。这样节省时间和空间，也不会对 rootfs 内容做安全签名追加。

---

## 8. 安全包下的 squashfs rootfs 抽样

安全包分支中还有这段：

```bash
grep "CONFIG_TARGET_ROOTFS_SQUASHFS=y" ${PACK_TOPDIR}/.config > /dev/null && \
	grep "CONFIG_USE_UBOOT_VERIFY_SQUASHFS=y" ${PACK_TOPDIR}/.config > /dev/null
```

如果同时满足：

1. `CONFIG_TARGET_ROOTFS_SQUASHFS=y`
2. `CONFIG_USE_UBOOT_VERIFY_SQUASHFS=y`

则说明 rootfs 是 squashfs，并且启用了 U-Boot 对 squashfs 的校验/验证。

之后脚本读取：

```bash
local rootfs_per_MB=`grep "^rootfs_per_MB=" ${ROOT_DIR}/image/env.cfg | awk -F = '{printf $2}'`
```

如果未定义，则默认：

```bash
rootfs_per_MB=4096
```

然后执行：

```bash
extract_squashfs $rootfs_per_MB rootfs.fex rootfs-extract.fex
```

这一步生成 `rootfs-extract.fex`。结合后面的 `do_signature()` 可以看到，启用 squashfs 校验时，脚本会把 `rootfs-extract.fex` 加入 `dragon_toc.cfg` 作为需要证书签名的对象。

在 `do_signature()` 中对应逻辑是：

```bash
sed -i '/^onlykey=boot/a\onlykey=rootfs,          rootfs-extract.fex,        SCPFirmwareContentCertPK' dragon_toc.cfg
```

也就是把 rootfs 相关证书项插入 TOC 配置。

---

## 9. 准备 `rootfs_nor.fex`

代码：

```bash
ln -s rootfs.fex rootfs_nor.fex
```

注释解释得很清楚：

```bash
# tina don't need rootfs_nor.fex, but some sys_partition.fex for longan use it, so add one for compatibility
```

也就是说，Tina 本身不需要 `rootfs_nor.fex`，但是某些 Longan 的 `sys_partition.fex` 可能引用该文件名。为了兼容这些分区配置，直接让：

```text
rootfs_nor.fex -> rootfs.fex
```

---

## 10. 准备 `usr.fex`

如果存在 `${ROOT_DIR}/usr.img`：

```bash
if [ -f ${ROOT_DIR}/usr.img ]; then
	ln -s ${ROOT_DIR}/usr.img    usr.fex
fi
```

说明系统可能存在单独的 `usr` 分区镜像。若存在，就链接成 `usr.fex`，供分区配置中的 `downloadfile = "usr.fex"` 使用。

---

## 11. 准备 `recovery.fex`

代码：

```bash
if [ -f ${ROOT_DIR}/boot_initramfs_recovery.img ]; then
	ln -s ${ROOT_DIR}/boot_initramfs_recovery.img recovery.fex
else
	touch recovery.fex
	echo "recovery part not used!" > recovery.fex
fi
```

含义：

| 条件 | `recovery.fex` 内容 |
|---|---|
| 存在 `boot_initramfs_recovery.img` | 软链接到 recovery 镜像 |
| 不存在 | 创建一个占位文件 |

这样做的目的也是避免某些配置引用 `recovery.fex` 时缺文件。

在安全签名阶段，`do_signature()` 也会根据是否存在 `${ROOT_DIR}/boot_initramfs_recovery.img` 来决定是否保留 recovery 证书配置：

```bash
if [ ! -f ${ROOT_DIR}/boot_initramfs_recovery.img ]; then
	printf "recovery img is not exist, remove recovery cert from dragon_toc.cfg"
	sed -i '/recovery/d' dragon_toc.cfg > /dev/null
fi
```

所以没有 recovery 镜像时：

1. `do_pack_tina()` 创建占位 `recovery.fex`。
2. `do_signature()` 从 `dragon_toc.cfg` 删除 recovery 证书项。
3. 避免后续签名工具因为找不到真实 recovery 或证书配置不匹配而失败。

---

## 12. dm-verity 处理

`do_pack_tina()` 后面检查：

```bash
grep "CONFIG_USE_DM_VERITY=y" ${PACK_TOPDIR}/.config > /dev/null
if [ $? -eq 0 ]; then
	cp -vf ${ROOT_DIR}/rootfs.img rootfs.fex
	${PACK_TOPDIR}/scripts/dm-verity-block.sh ${ROOT_DIR}/image/rootfs.fex
	if [ $? -ne 0 ]; then
		echo "error: generate verity block error!"
		exit
	fi
fi
```

如果启用了 `CONFIG_USE_DM_VERITY=y`，则：

1. 复制 `${ROOT_DIR}/rootfs.img` 为 `rootfs.fex`。
2. 调用 `dm-verity-block.sh` 对 `rootfs.fex` 生成 verity block。

这说明 dm-verity 会修改或追加 rootfs 相关数据，因此同样不能只依赖软链接，需要真实复制 rootfs 文件。

注意这里即使不是 `PACK_SIG=secure`，只要启用了 dm-verity，也会把 `rootfs.fex` 变成真实文件并处理。

---

## 13. 根据 `PACK_SIG` 判断是否进入安全签名

核心判断：

```bash
if [ "x${PACK_SIG}" = "xsecure" ] ; then
	echo "secure"
	do_signature
elif [ "x${PACK_SIG}" = "xprev_refurbish" ] ; then
	echo "prev_refurbish"
	do_signature
else
	echo "normal"
fi
```

也就是说：

| `PACK_SIG` | 行为 |
|---|---|
| `secure` | 执行 `do_signature()` |
| `prev_refurbish` | 执行 `do_signature()` |
| 其他 | 普通包，不签名 |

这里和官方文档大纲中的“如果需要打包成安全固件就会调用 `do_signature` 函数”一致。但源码里除了 `secure`，还有一个 `prev_refurbish` 模式也会走签名流程。

---

# `do_signature()` 详细分析

`do_pack_tina()` 安全相关工作的核心实际在 `do_signature()` 中完成。

## 14. 选择并生成 `dragon_toc.cfg`

`do_signature()` 首先根据 `PACK_SIG`、`ARCH`、配置目录选择不同的 `dragon_toc.cfg`。

### 14.1 `prev_refurbish` 模式

如果：

```bash
[ "x${PACK_SIG}" = "xprev_refurbish" ]
```

则使用 `no_secureos` 版本的 TOC 配置：

- arm64 使用 `dragon_toc_a64_no_secureos.cfg`
- 非 arm64 使用 `dragon_toc_no_secureos.cfg`

这说明 `prev_refurbish` 是一种特殊安全/翻新模式，可能不包含 secure os。

### 14.2 普通 secure 模式

如果不是 `prev_refurbish`，则：

- arm64 优先使用 `${LONGAN_CONFIG_DIR}/default/dragon_toc.cfg`
- 否则使用 common 或 generic 下的 `dragon_toc_a64.cfg`
- 非 arm64 使用 `dragon_toc.cfg`

同时 arm64 下还会检查 `dragon_toc.cfg` 中是否有 `[package]`：

```bash
grep -r "\[package\]" dragon_toc.cfg > /dev/null
if [ $? -eq 0 ]; then
	merge_flag=1
fi
```

如果存在 `[package]`，则后面会执行：

```bash
dragonsecboot -pack dragon_toc.cfg
```

用于生成安全 boot package。

---

## 15. recovery 证书项处理

如果没有 recovery 镜像：

```bash
if [ ! -f ${ROOT_DIR}/boot_initramfs_recovery.img ]; then
	printf "recovery img is not exist, remove recovery cert from dragon_toc.cfg"
	sed -i '/recovery/d' dragon_toc.cfg > /dev/null
fi
```

这一步避免 `dragonsecboot` 给不存在的 recovery 镜像生成证书。

---

## 16. rootfs squashfs 证书项处理

如果启用了：

```text
CONFIG_TARGET_ROOTFS_SQUASHFS=y
CONFIG_USE_UBOOT_VERIFY_SQUASHFS=y
```

则向 `dragon_toc.cfg` 追加 rootfs 签名项：

```bash
sed -i '/^onlykey=boot/a\onlykey=rootfs,          rootfs-extract.fex,        SCPFirmwareContentCertPK' dragon_toc.cfg
```

意思是：在 `onlykey=boot` 后面新增一个 `onlykey=rootfs`，目标文件是 `rootfs-extract.fex`，使用 `SCPFirmwareContentCertPK` 证书类型。

这和前面 `do_pack_tina()` 中生成 `rootfs-extract.fex` 是配套的。

---

## 17. 替换 secure 卡脚本

```bash
rm -f cardscript.fex
mv cardscript_secure.fex cardscript.fex
```

安全包使用 `cardscript_secure.fex` 替代普通 `cardscript.fex`。

如果 `cardscript_secure.fex` 不存在，则报错退出：

```bash
pack_error "dragon cardscript_secure.fex file is not exist"
exit 1
```

这说明安全固件烧录/启动脚本和普通固件不同。

---

## 18. 检查密钥目录

```bash
if [ ! -d ${ROOT_DIR}/keys ]; then
	echo ""
	pack_error "No key exist, please run './scripts/createkeys' to generate keys first."
	exit 1
fi
```

安全打包必须存在 `${ROOT_DIR}/keys`，否则无法签名。提示用户先执行：

```bash
./scripts/createkeys
```

---

## 19. 更新 `sboot.bin`

```bash
update_chip sboot.bin > /dev/null
```

这一步对安全启动相关的 `sboot.bin` 做芯片信息更新。类似普通启动流程中对 `boot0` 做 `update_chip`，这里是安全启动链路下对 `sboot.bin` 做处理。

---

## 20. 生成 `toc0.fex`

源码：

```bash
dragonsecboot -toc0 dragon_toc.cfg ${ROOT_DIR}/keys ${ROOT_DIR}/image/version_base.mk
```

这与官方大纲中的：

```bash
dragonsecboot -toc0 dragon_toc.cfg ${ROOT_DIR}/keys ${ROOT_DIR}/image/version_base.mk
```

一致。

`toc0.fex` 是安全启动链中的早期启动认证文件，通常对应 BootROM 验证的第一阶段安全启动内容。它由：

1. `dragon_toc.cfg`
2. 密钥目录 `${ROOT_DIR}/keys`
3. 版本信息 `${ROOT_DIR}/image/version_base.mk`

共同生成。

如果失败：

```bash
pack_error "dragon toc0 run error"
exit 1
```

---

## 21. 根据 `sys_config.bin` 更新 `toc0.fex`

源码：

```bash
update_toc0  toc0.fex           sys_config.bin
```

这也和官方大纲一致。

作用是从 `sys_config.bin` 中读取板级配置参数，更新 `toc0.fex` 头部或相关字段，例如官方文档中提到的：

- DRAM 参数
- UART 参数
- 存储启动参数
- 平台相关启动参数

失败则退出：

```bash
pack_error "update toc0 run error"
exit 1
```

---

## 22. 可选生成安全 boot package

如果前面检测到 `dragon_toc.cfg` 中有 `[package]`，则：

```bash
if [ ${merge_flag} == 1 ]; then
	printf "dragon boot package\n"
	dragonsecboot -pack dragon_toc.cfg
	if [ $? -ne 0 ]
	then
		pack_error "dragon boot_package run error"
		exit 1
	fi
fi
```

这个动作不是官方简化大纲里重点写的内容，但源码中确实存在。它用于按 `dragon_toc.cfg` 中的 package 配置打包 boot package，通常和 arm64 平台 ATF / SCP / U-Boot / OP-TEE 合包有关。

---

## 23. 可选更新 OP-TEE TA 公钥

源码：

```bash
if [ -f ${ROOT_DIR}/staging_dir/target/usr/dev_kit/arm-plat-${PACK_CHIP}/export-ta_arm32/keys/default_ta.pem ]; then
	${PACK_TOPDIR}/scripts/update_optee_pubkey.py \
		--in_file optee.fex --out_file optee-new.fex \
		--key ${ROOT_DIR}/staging_dir/target/usr/dev_kit/arm-plat-${PACK_CHIP}/export-ta_arm32/keys/default_ta.pem
```

如果存在 OP-TEE TA 默认公钥，则将其写入 `optee.fex`，生成 `optee-new.fex` 后再替换原 `optee.fex`。

这说明安全打包不仅签 kernel/rootfs，还可能涉及 OP-TEE 可信执行环境相关内容。

---

## 24. 生成 `toc1.fex`

选择 `cnf_base.cnf`：

```bash
if [ -f ${LONGAN_COMMON_DIR}/sign_config/cnf_base.cnf ] ; then
	CNF_BASE_FILE=${LONGAN_COMMON_DIR}/sign_config/cnf_base.cnf
else
	CNF_BASE_FILE=${TINA_CONFIG_DIR}/generic/sign_config/cnf_base.cnf
fi
```

然后生成 `toc1.fex`：

```bash
dragonsecboot -toc1 dragon_toc.cfg ${ROOT_DIR}/keys \
	${CNF_BASE_FILE} \
	${ROOT_DIR}/image/version_base.mk
```

这与官方大纲对应：

```bash
dragonsecboot -toc1 dragon_toc.cfg ${ROOT_DIR}/keys \
${CNF_BASE_FILE} \
${ROOT_DIR}/image/version_base.mk
```

`toc1.fex` 通常包含后续启动阶段的证书、镜像认证信息，例如 boot、recovery、rootfs 等证书。

---

## 25. 检查 `boot.fex` 是否为 Android boot image

生成 `toc1` 后，源码检查 `boot.fex` 的 magic：

```bash
local correct_boot_img_magic=$(echo -n "ANDROID!" | md5sum | cut -d " " -f 1)

local boot_fex_magic=$(dd if=boot.fex bs=1 count=8 | md5sum | cut -d " " -f 1)
if [ x$correct_boot_img_magic != x$boot_fex_magic ] ; then
	pack_error "boot.fex format error, magic not ANDROID!"
	exit 1
fi
```

这说明安全签名要求 `boot.fex` 是 Android boot image 格式，前 8 字节 magic 必须是：

```text
ANDROID!
```

如果不是这个格式，就不能继续执行 `sigbootimg`。

---

## 26. 对 `boot.fex` 追加证书签名

源码：

```bash
sigbootimg --image boot.fex --cert toc1/cert/boot.der --output boot_sig.fex
```

成功后：

```bash
mv -f boot_sig.fex boot.fex
```

也就是说最终 `boot.fex` 被替换为带证书的 `boot_sig.fex`。

这对应官方大纲中的：

```bash
sigbootimg --image boot.fex --cert toc1/cert/boot.der --output boot_sig.fex
```

不过当前源码还多做了一步：

```bash
mv -f boot_sig.fex boot.fex
```

所以后续打包工具实际使用的是签名后的 `boot.fex`。

---

## 27. 对 recovery 镜像追加证书

如果存在 `${ROOT_DIR}/boot_initramfs_recovery.img`，则也会处理 `recovery.fex`：

```bash
sigbootimg --image recovery.fex --cert toc1/cert/recovery.der --output recovery_sig.fex
```

成功后：

```bash
mv -f recovery_sig.fex recovery.fex
```

并且同样会检查 recovery 的 Android boot magic。

也就是说安全包不仅签 `boot.fex`，如果有 recovery，也会签 `recovery.fex`。

---

## 28. 关于官方大纲中的 `update_toc1`

你给的官方大纲里有：

```bash
update_toc1 toc1.fex sys_config.bin
```

但是当前 `scripts/pack_img.sh` 这份源码里的 `do_signature()` 没有看到 `update_toc1 toc1.fex sys_config.bin` 调用。

当前源码只调用了：

```bash
update_toc0  toc0.fex           sys_config.bin
```

而没有调用 `update_toc1`。

所以这里需要注意版本差异：

- 官方文档的大纲可能来自其他 Tina / Longan / BSP 版本。
- 当前这份脚本中，`toc0.fex` 会根据 `sys_config.bin` 更新。
- `toc1.fex` 由 `dragonsecboot -toc1` 生成后，当前脚本没有再调用 `update_toc1`。

因此如果你是在分析当前 SDK 的实际行为，应以源码为准：此版本 `do_signature()` 没有执行 `update_toc1`。

---

## 29. 安全包下 rootfs 签名追加

`do_pack_tina()` 在 `do_signature()` 返回后，如果是 secure 包，还会再次检查 squashfs rootfs 校验配置：

```bash
if [ "x${PACK_SIG}" = "xsecure" ] ; then
	grep "CONFIG_TARGET_ROOTFS_SQUASHFS=y" ${PACK_TOPDIR}/.config > /dev/null && \
		grep "CONFIG_USE_UBOOT_VERIFY_SQUASHFS=y" ${PACK_TOPDIR}/.config > /dev/null
	if [ $? -eq 0 ]; then
		update_squashfs ${ROOT_DIR}/image/rootfs.fex ${ROOT_DIR}/image/toc1/cert/rootfs.der
```

如果启用了 squashfs + U-Boot verify，则调用：

```bash
update_squashfs rootfs.fex toc1/cert/rootfs.der
```

作用是把 rootfs 的证书追加或写入到 `rootfs.fex` 中。

这和前面的流程对应：

1. `do_pack_tina()` 从 `rootfs.fex` 抽样生成 `rootfs-extract.fex`。
2. `do_signature()` 将 `rootfs-extract.fex` 加入 `dragon_toc.cfg`。
3. `dragonsecboot -toc1` 生成 `toc1/cert/rootfs.der`。
4. `do_pack_tina()` 调用 `update_squashfs` 把 rootfs 证书写回 `rootfs.fex`。

---

# 总体流程总结

`do_pack_tina()` 可以概括为下面几个阶段：

```text
do_pack_tina()
├── 清理旧的 fex 文件
├── 创建 vmlinux.fex 占位文件
├── 链接 boot.fex
│   ├── 优先 boot_initramfs.img
│   └── 否则 boot.img
├── 链接 kernel.fex -> boot.fex
├── 可选生成 fit-image.fex
├── 准备 rootfs.fex
│   ├── secure：复制 rootfs.img
│   └── normal：软链接 rootfs.img
├── 可选处理 dtbo.fex
├── secure + squashfs verify：生成 rootfs-extract.fex
├── 兼容 rootfs_nor.fex
├── 可选链接 usr.fex
├── 准备 recovery.fex
├── 可选 dm-verity 处理 rootfs.fex
├── 根据 PACK_SIG 判断是否 do_signature()
│   ├── secure：签名
│   ├── prev_refurbish：签名
│   └── normal：不签名
└── secure + squashfs verify：把 rootfs 证书写回 rootfs.fex
```

`do_signature()` 可以概括为：

```text
do_signature()
├── 选择 dragon_toc.cfg
│   ├── secure
│   ├── prev_refurbish
│   ├── arm64
│   └── non-arm64
├── 没有 recovery 时删除 recovery 证书项
├── squashfs verify 时追加 rootfs 证书项
├── 使用 cardscript_secure.fex 替换 cardscript.fex
├── 检查 keys 目录
├── update_chip sboot.bin
├── dragonsecboot -toc0 生成 toc0.fex
├── update_toc0 toc0.fex sys_config.bin
├── 可选 dragonsecboot -pack 生成 boot_package
├── 可选更新 optee 公钥
├── dragonsecboot -toc1 生成 toc1.fex
├── 检查 boot.fex Android magic
├── sigbootimg 给 boot.fex 追加 boot.der
├── 可选给 recovery.fex 追加 recovery.der
└── secure signature ok
```

---

# 和官方文档大纲的对应关系

你给的官方大纲和当前源码基本对应，但有几个差异点：

| 官方文档描述 | 当前源码情况 |
|---|---|
| 软链接 `boot.fex` | 是，普通情况下链接 `boot.img` 或 `boot_initramfs.img` |
| 软链接 `rootfs.fex` | 普通包是软链接；secure 包是复制 |
| 安全包调用 `do_signature` | 是，`secure` 和 `prev_refurbish` 都会调用 |
| `dragonsecboot -toc0` 生成 `toc0.fex` | 是 |
| `update_toc0 toc0.fex sys_config.bin` | 是 |
| `dragonsecboot -toc1` 生成 `toc1.fex` | 是 |
| `sigbootimg` 对 `boot.fex` 签名 | 是 |
| `update_toc1 toc1.fex sys_config.bin` | 当前源码未看到 |
| 对 rootfs 签名 | secure + squashfs verify 时会处理 |
| 对 recovery 签名 | 如果存在 recovery 镜像，会处理 |
| dm-verity | 当前源码有额外处理 |

所以如果写文档，可以补充一句：

> 官方文档中提到的 `update_toc1 toc1.fex sys_config.bin` 在当前脚本版本中未出现，当前实现只对 `toc0.fex` 执行了 `update_toc0`，`toc1.fex` 由 `dragonsecboot -toc1` 生成后直接用于提取证书并签名 `boot.fex` / `recovery.fex`。

