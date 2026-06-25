# V853 `sunxi_mbr.fex` / `sunxi_gpt.fex` 分析报告

## 1. 结论

结合当前仓库里的打包脚本、配置文件和实际输出物，可以得出下面这几个结论：

1. `sys_partition.fex` 是人工维护的分区源配置。
2. `sys_partition.bin` 是 `script` 工具把 `sys_partition.fex` 编译后的二进制分区描述。
3. `sunxi_mbr.fex` 和 `sunxi_gpt.fex` 都不是 `sys_partition.bin` 的“改名版”或“原地修改版”，而是 `update_mbr` 以 `sys_partition.bin` 为输入生成的新的分区表文件。
4. `dragon` 的角色是把这些已经准备好的文件打进最终固件镜像；它不是前面那一步里负责生成 `sunxi_mbr.fex` / `sunxi_gpt.fex` 的工具。

更准确地说：

- `sys_partition.fex` 描述“想要什么分区”。
- `sys_partition.bin` 是这份描述的机器可读版本。
- `sunxi_mbr.fex` / `sunxi_gpt.fex` 是给后续烧录器、启动链或镜像格式使用的分区表产物。

## 2. 源码直接证据

### 2.1 `sys_partition.fex` 是分区源文件

`device/config/chips/v853/configs/100ask/linux/sys_partition.fex:30-77` 直接定义了分区名字、大小、下载文件，例如：

- `boot-resource`
- `env`
- `boot`
- `rootfs`
- `rootfs_data`
- `recovery`
- `UDISK`

这说明 `sys_partition.fex` 本质上是“分区布局描述文件”，不是最终写盘用的 MBR/GPT 表本身。

### 2.2 `sys_partition.fex -> sys_partition.bin -> sunxi_mbr.fex`

`scripts/pack_img.sh:611-616` 已经把这条链路写得很清楚：

```sh
#convert sys_partition.fex to sunxi_mbr.fex
sed -i '/^[ \t]*downloadfile/d' sys_partition_tmp.fex
/bin/busybox unix2dos sys_partition_tmp.fex
script  sys_partition_tmp.fex > /dev/null
update_mbr sys_partition_tmp.bin 1 sunxi_mbr_tmp.fex > /dev/null
```

这里发生了两步转换：

1. `script sys_partition_tmp.fex` 生成 `sys_partition_tmp.bin`
2. `update_mbr sys_partition_tmp.bin 1 sunxi_mbr_tmp.fex` 再生成 `sunxi_mbr_tmp.fex`

这已经足够说明：`sunxi_mbr.fex` 是基于 `sys_partition.bin` 生成的新文件，而不是对 `sys_partition.bin` 直接改出来的同一份文件。

### 2.3 eMMC/NAND 路径会继续生成 `sunxi_mbr.fex`

`scripts/pack_img.sh:1666-1679` 在正式收尾阶段又执行了一次：

```sh
update_mbr          sys_partition.bin 4
update_mbr sys_partition.bin 4 sunxi_mbr.fex dlinfo.fex 15269888 40960 0
```

从调用形式看得很明确：

- 输入文件是 `sys_partition.bin`
- 输出文件之一是 `sunxi_mbr.fex`

因此 `sunxi_mbr.fex` 是 `update_mbr` 依据 `sys_partition.bin` 重新组织、编码出来的产物。

### 2.4 `sunxi_gpt.fex` 是并列产物，不是摆设

`scripts/pack_img.sh:1570-1575`：

```sh
if [ -f sunxi_gpt.fex ] ; then
    programmer_img sys_partition.bin sunxi_mbr.fex ${out_img} ${in_img} sunxi_gpt.fex > /dev/null
else
    programmer_img sys_partition.bin sunxi_mbr.fex ${out_img} ${in_img} > /dev/null
fi
```

这里可以看出三点：

1. `sys_partition.bin` 和 `sunxi_mbr.fex` 是并列输入，而不是互相替代。
2. `sunxi_gpt.fex` 如果存在，也会被作为额外输入一起打包。
3. 所以 `sunxi_gpt.fex` 也是一个独立产物，不是 `sys_partition.bin` 的“别名”。

### 2.5 `u-boot-2018` 路径优先使用 GPT

`scripts/pack_img.sh:1612-1616` 和 `1644-1648`：

```sh
#if use uboot-2018, it not use mbr, but gpt
if [ "x${TARGET_UBOOT}" = "xu-boot-2018" ] ; then
    mbr_file=sunxi_gpt.fex
else
    mbr_file=sunxi_mbr_nor.fex
fi
```

这说明在部分启动链里，`sunxi_gpt.fex` 不是辅助文件，而是真正会被选中作为分区表使用的文件。

### 2.6 `dragon` 在当前流程里负责“封包”，不是“生成分区表”

`out/v853-100ask/aw_pack_src/aw_pack.sh:50-57`：

```sh
cp -lrf ${aw_pack_dir}/config/* ${aw_pack_dir}/tmp
cp -lrf ${aw_pack_dir}/image/* ${aw_pack_dir}/tmp
cp -lrf ${aw_pack_dir}/other/* ${aw_pack_dir}/tmp

cd ${aw_pack_dir}/tmp
../tools/dragon image.cfg sys_partition.fex
```

这段逻辑很关键：

- 先把 `config`、`image`、`other` 里的文件全部拷到临时目录
- 再调用 `dragon`

也就是说，`dragon` 调用前，`sunxi_mbr.fex` / `sunxi_gpt.fex` 就应该已经准备好了；`dragon` 更像“总装”和“封包”，不是前面那一步分区表生成器。

## 3. 当前工程里 `image.cfg` 为什么能看到 `sunxi_gpt.fex`

### 3.1 `tina` 平台会优先使用 `image_linux.cfg`

`scripts/pack_img.sh:207-208`：

```sh
PACK_PLATFORM_IMAGE_CFG=$PACK_PLATFORM
[ x"$PACK_PLATFORM" = x"tina" ] && PACK_PLATFORM_IMAGE_CFG="linux"
```

`scripts/pack_img.sh:849-852`：

```sh
# For example, mv out/image_linux.cfg out/image.cfg
find image/* -type f -a \( -name "*.fex" -o -name "*.cfg" \) -print | \
    sed "s#\(.*\)_${PACK_PLATFORM_IMAGE_CFG}\(\..*\)#mv -fv & \1\2#e" > /dev/null
```

这意味着当平台是 `tina` 时，打包过程会把 `image_linux.cfg` 覆盖/落成最终的 `image.cfg`。

### 3.2 源模板和当前输出文件的差异

源码模板 `device/config/chips/v853/configs/default/image_linux.cfg:82-84` 里已经列出了：

- `sunxi_gpt.fex`
- `sunxi_mbr.fex`
- `dlinfo.fex`

而当前构建输出 `out/v853-100ask/aw_pack_src/config/image.cfg:82-84` 也保留了同样的条目。

所以如果你在 `default/image.cfg` 里只看到 `sunxi_mbr.fex`，但在最终输出的 `aw_pack_src/config/image.cfg` 里又看到了 `sunxi_gpt.fex`，并不矛盾；这通常是 `image_linux.cfg -> image.cfg` 这层平台配置选择带来的结果。

## 4. 当前输出物也支持这个结论

当前打包目录 `out/v853-100ask/image/` 里可以看到：

- `sys_partition.bin`，大小 `2048`
- `sunxi_mbr.fex`，大小 `65536`
- `sunxi_gpt.fex`，大小 `8192`

这三个文件大小完全不同，也进一步说明它们不是“同一文件换个名字”。

## 5. `sunxi_gpt.fex` 与启动参数的关系

`device/config/chips/v853/configs/100ask/linux/env-4.9.cfg:24`：

```sh
setargs_nand_ubi=... partitions=${partitions} ... gpt=1
```

这里出现了 `gpt=1`，说明启动侧也明确考虑了 GPT 方案。这和 `pack_img.sh` 里 `u-boot-2018` 选择 `sunxi_gpt.fex` 的逻辑是互相呼应的。

## 6. `sunxi_mbr.fex` / `sunxi_gpt.fex` 各自更像什么

按当前源码关系，可以这样理解：

- `sys_partition.fex`
  - 面向人编辑
  - 负责描述分区布局和下载文件
- `sys_partition.bin`
  - 面向工具中间层
  - 是 `script` 编译后的结构化二进制
- `sunxi_mbr.fex`
  - 面向 MBR/sunxi 分区表消费者
  - 由 `update_mbr` 生成
- `sunxi_gpt.fex`
  - 面向 GPT 分区表消费者
  - 也是由 `update_mbr` 生成的并列产物

所以最准确的表述不是“`sunxi_mbr.fex`/`sunxi_gpt.fex` 是 `sys_partition.bin` 修改后的文件”，而是：

> `sunxi_mbr.fex` 和 `sunxi_gpt.fex` 是以 `sys_partition.bin` 为输入生成出来的新的下游分区表文件。

## 7. 建议记忆方式

可以把整条链记成下面这样：

```text
sys_partition.fex
    -> script
    -> sys_partition.bin
    -> update_mbr
    -> sunxi_mbr.fex / sunxi_gpt.fex
    -> programmer_img / dragon
    -> 最终 tina_xxx.img
```

## 8. 关于“源码证据边界”的说明

本仓库里可以直接阅读到的，是：

- `scripts/pack_img.sh`
- `image*.cfg`
- `sys_partition.fex`
- `aw_pack.sh`

这些文件足以证明调用关系和产物关系。

但 `tools/pack-bintools/src/update_mbr`、`programmer_img` 在当前仓库中是已编译好的二进制，不是可直接阅读的 C 源文件。因此下面这些内容只能作为“侧证”，不能算脚本级源码证据：

- `update_mbr` 二进制字符串里包含 `sunxi_gpt.fex`
- 包含 `update gpt file ok`
- 包含 `create_standard_gpt`
- 包含 `write_gpt_table`
- `programmer_img` 二进制字符串里包含 `gpt path=%s`、`use_gpt = %d`、`write_gpt_file`

这些侧证与脚本调用关系是吻合的，因此可以增强上面的判断，但本报告的主结论仍然是基于打包脚本和配置文件给出的。

## 9. 最终回答

针对你的原问题，可以直接回答为：

`sunxi_mbr.fex` / `sunxi_gpt.fex` 的作用是承载最终打包和启动链要消费的分区表信息。它们不是把 `sys_partition.bin` 改一改继续当同一份文件使用，而是由 `update_mbr` 读取 `sys_partition.bin` 后，重新生成出来的新的分区表文件；其中 `sunxi_mbr.fex` 面向 MBR/sunxi 场景，`sunxi_gpt.fex` 面向 GPT 场景。
