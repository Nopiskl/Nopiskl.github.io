# V853 boot-resource 打包与启动 Logo 分析

更新时间：2026-04-19

## 1. 文档目的

本文基于当前 SDK 源码与本地 `out/v853-100ask/image/` 产物，对以下问题做集中整理：

- `device/config/chips/v853/boot-resource` 在 pack 阶段是否被直接使用
- `boot-resource.fex` 在当前 Tina/Longan 打包链路中是如何生成的
- `boot_package.fex` 与 `u-boot.fex` 分别扮演什么角色
- U-Boot 启动时是如何选择并加载启动 Logo 的
- boot package 级别的 logo 有什么意义、从哪里取图、当前是否生效
- `v853/configs/100ask` 当前实际使用的是哪一张 Logo
- 为什么仓库里仍然保留 `device/config/chips/v853/boot-resource` 这个目录

## 2. 结论摘要

1. 当前 `100ask` 的正常启动镜像会创建单独的 `boot-resource` 分区，镜像文件名为 `boot-resource.fex`。对应分区配置见：
   - `device/config/chips/v853/configs/100ask/linux/sys_partition.fex:37`
   - `device/config/chips/v853/configs/100ask/linux/sys_partition.fex:39`

2. 当前 Tina 的 pack 流程并不会直接把 `device/config/chips/v853/boot-resource` 作为 `100ask` 的 `boot-resource` 来源。当前实际使用的是 `scripts/pack_img.sh` 中的 `boot_resource_list`，其来源优先级是：
   - `target/allwinner/generic/boot-resource`
   - `target/allwinner/${platform}-common/...`
   - `target/allwinner/${board}/configs/*.bmp`
   - `device/config/chips/v853/configs/default/boot-resource`
   - `device/config/chips/v853/configs/100ask/configs/*.bmp`

3. 当前 `100ask` 的 U-Boot Logo 加载优先级是：
   - advert 图片
   - boot package 内嵌 logo
   - `boot-resource`/`bootloader` 分区中的 `bootlogo.bmp`

4. 当前 `100ask` 最终打进去的 `bootlogo.bmp` 与以下文件哈希一致：
   - `target/allwinner/generic/boot-resource/boot-resource/bootlogo.bmp`
   - `device/config/chips/v853/configs/default/boot-resource/bootlogo.bmp`
   - `out/v853-100ask/image/boot-resource/bootlogo.bmp`

   三者 SHA256 都是：

   ```text
   278EE9E8CF62FE24E098BA8E8491169C67A1333CBB28CFFB4284EA0B2F847AFC
   ```

5. `device/config/chips/v853/boot-resource/boot-resource/bootlogo.bmp` 的哈希不同：

   ```text
   8DED2421E14A15B6E2ACA1528736187BEA1DB467AD6FC5048FB23BECE5CC38D2
   ```

   这说明当前 `100ask` 实际没有使用这个芯片级目录中的那张 Logo。

6. `device/config/chips/v853/boot-resource` 不是“只有开机图”的目录，而是一套更完整的启动/充电资源模板，里面还有：
   - `bat/*.bmp`
   - `font24.sft`
   - `font32.sft`
   - 低电量、充电、电池动画等资源

   因此它更像是历史上或其他产品线使用的“完整 boot-resource 模板”，而不是当前 `100ask` 这条打包链的直接输入目录。

7. 当前 pack 流程中还会额外生成 `boot_package.fex`。它不是另一份“重复的 U-Boot”，而是把 `u-boot.fex`、`optee.fex`、`sunxi.fex` 以及可选 logo 等内容封装起来的启动组合包。

8. 当前 SDK 没有单独的 “boot package logo 源目录”。默认做法是把 `out/v853-100ask/image/boot-resource/bootlogo.bmp` 压缩为 `out/v853-100ask/image/bootlogo.bmp.lzma`，然后由 `boot_package.cfg` 中的 `item=logo, bootlogo.bmp.lzma` 决定是否打进 `boot_package.fex`。

9. 当前 `100ask` 并没有真正启用 boot package logo，因为以下配置仍然是注释状态：
   - `device/config/chips/v853/configs/default/boot_package.cfg:8`
   - `device/config/chips/v853/configs/default/boot_package_nor.cfg:8`

   因此当前实际显示的仍然是 `boot-resource` 分区里的 `bootlogo.bmp`，不是 `boot_package.fex` 内嵌 logo。

10. 从目的上说，boot package logo 的意义是“更早、更少依赖地显示第一屏 Logo”：
    - 它可以在 U-Boot 更早阶段直接从预留内存里解压显示
    - 不必先去读 `bootloader/boot-resource` 分区和 FAT 文件
    - 因而比 `boot-resource` 路径更早、更稳，但也更依赖 pack 阶段把图正确塞进 boot package

## 3. Pack 阶段分析

### 3.1 `boot-resource` 的来源列表

`scripts/pack_img.sh:285` 定义了 `boot_resource_list`。与 `v853-100ask` 直接相关的关键来源有：

- `target/allwinner/generic/boot-resource/boot-resource -> image/`
- `target/allwinner/generic/boot-resource/boot-resource.ini -> image/`
- `device/config/chips/v853/configs/default/boot-resource -> image/`
- `device/config/chips/v853/configs/100ask/configs/*.bmp -> image/boot-resource/`

其中：

- `target/allwinner/generic/boot-resource` 是基础模板
- `configs/default/boot-resource` 是平台默认覆盖
- `configs/100ask/configs/*.bmp` 是板级单图覆盖

当前 `device/config/chips/v853/configs/100ask` 下并没有 `configs/*.bmp` 资源，因此没有触发最终板级覆盖。

### 3.2 `boot-resource` 被拷贝到 image 目录

`scripts/pack_img.sh:898-901` 负责把上述资源拷贝到：

- `out/v853-100ask/image/boot-resource/`
- `out/v853-100ask/image/boot-resource.ini`

当前本地产物中可以看到：

- `out/v853-100ask/image/boot-resource/bootlogo.bmp`
- `out/v853-100ask/image/boot-resource.ini`
- `out/v853-100ask/image/boot-resource.fex`

### 3.3 pack 脚本额外生成 `bootlogo.bmp.lzma`

`scripts/pack_img.sh:905-909` 会把：

- `image/boot-resource/bootlogo.bmp`

压缩生成：

- `image/bootlogo.bmp.lzma`

这是给 boot package / boot0 / U-Boot 预留的“压缩 logo 资源”。

### 3.4 `boot-resource.fex` 的真正生成点

`scripts/pack_img.sh:1536`：

```text
fsbuild boot-resource.ini split_xxxx.fex
```

这一步把 `image/boot-resource/` 目录按 `boot-resource.ini` 描述打成 FAT 格式的 `boot-resource.fex`。

### 3.5 `boot-resource.fex` 被写入分区

正常启动分区表中：

- `device/config/chips/v853/configs/100ask/linux/sys_partition.fex:37`
- `device/config/chips/v853/configs/100ask/linux/sys_partition.fex:39`

明确指定：

- 分区名：`boot-resource`
- 下载文件：`boot-resource.fex`

NOR 分区表中也是同样设置：

- `device/config/chips/v853/configs/100ask/linux/sys_partition_nor.fex:37`
- `device/config/chips/v853/configs/100ask/linux/sys_partition_nor.fex:39`

### 3.6 `boot_package.fex` 的生成与作用

除了 `boot-resource.fex` 之外，当前 pack 流程还会生成 `boot_package.fex`。

关键流程在：

- `scripts/pack_img.sh:1518-1541`

其中顺序是：

1. 先通过 `update_uboot` 处理 `u-boot.fex`
2. 再通过 `dragonsecboot -pack boot_package.cfg` 生成 `boot_package.fex`

也就是说，`boot_package.fex` 不是代替 `u-boot.fex` 的另一份文件，而是把现成的 `u-boot.fex`、`optee.fex`、`sunxi.fex` 等内容进一步封装后的启动容器。

当前默认配置：

- `device/config/chips/v853/configs/default/boot_package.cfg:4`
- `device/config/chips/v853/configs/default/boot_package.cfg:5`
- `device/config/chips/v853/configs/default/boot_package.cfg:6`

对应为：

```ini
item=optee,                  optee.fex
item=u-boot,                 u-boot.fex
item=dtb,                    sunxi.fex
```

这里的：

```ini
item=u-boot,                 u-boot.fex
```

含义不是“再生成一份 U-Boot”，而是：

- 条目名叫 `u-boot`
- 条目内容来自 `u-boot.fex`

从 pack 脚本的消费关系看，`boot_package.fex` 在非 secure 分支中是实际参与后续组合的启动包：

- `scripts/pack_img.sh:1568` 中，`programmer_img` 非 secure 分支直接使用 `boot0_sdcard.fex + boot_package.fex`
- `scripts/pack_img.sh:1636-1653` 中，新 NOR 分支把 `boot_package_nor.fex` 作为 `--boot1`
- `scripts/pack_img.sh:2207` 中，非 secure tar 包也直接带 `./image/boot_package.fex`

因此对当前 V853 流程来说：

- `u-boot.fex` 是单体中间产物
- `boot_package.fex` 是把它与其他启动组件组合后的容器产物

## 4. U-Boot 如何加载启动 Logo

### 4.1 总体优先级

`lichee/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:573-579` 明确写了注释：

```text
advert picture > bootlogo in boot package > bootlogo in boot-resources/bootloader
```

也就是说当前优先级是：

1. advert 图片
2. boot package 内嵌 Logo
3. `boot-resource` 或 `bootloader` 分区中的 `bootlogo.bmp`

### 4.2 boot package 路径

U-Boot 先尝试 boot package 内嵌 Logo。

相关代码：

- `lichee/brandy-2.0/u-boot-2018/board/sunxi/board.c:527`
- `lichee/brandy-2.0/u-boot-2018/board/sunxi/board.c:541-555`

这里的 `reserve_bootlogo()` 会检查：

- `UBOOT_FUNC_MASK_BIT_BOOTLOGO`
- 预留内存中的 `compressed_logo_size`

如果存在 boot package logo，就把压缩后的 logo 放到 `gd->boot_logo_addr`。

后续在：

- `lichee/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:603-610`
- `lichee/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:983-999`

通过 `sunxi_prepare_bpk_bootlogo()` 解压后显示。

但当前 `100ask` 的 boot package 配置中，logo 项是注释掉的：

- `out/v853-100ask/image/boot_package.cfg`
- `out/v853-100ask/image/boot_package_nor.cfg`

都可以看到：

```text
;item=logo,                   bootlogo.bmp.lzma
```

因此当前 `100ask` 实际不会优先走 boot package 内嵌 logo。

### 4.2.1 boot package logo 的来源与目的

当前 SDK 没有单独准备一套 “boot package 专用 logo 目录”。脚本默认是直接拿：

- `image/boot-resource/bootlogo.bmp`

压缩生成：

- `image/bootlogo.bmp.lzma`

对应 pack 代码见：

- `scripts/pack_img.sh:905-909`

也就是说，在不改脚本的前提下：

- `boot-resource` 路径用的 `bootlogo.bmp`
- boot package 路径用的 `bootlogo.bmp.lzma`

本质上来自同一张源图，只是后者是压缩版本。

把 logo 放进 boot package 的主要目的不是“多放一份图”，而是让 U-Boot 能在更早阶段直接显示 Logo。源码依据如下：

- `lichee/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:573-579`
  这里写明了优先级：`advert picture > bootlogo in boot package > bootlogo in boot-resources/bootloader`
- `lichee/brandy-2.0/u-boot-2018/board/sunxi/board.c:527-555`
  `reserve_bootlogo()` 会在启动早期从 boot package 预留区取出压缩 logo
- `lichee/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:603-610`
  若 `gd->boot_logo_addr` 有效，则优先走 boot package logo 显示路径
- `lichee/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:983-1000`
  `sunxi_prepare_bpk_bootlogo()` 会对 boot package 里的压缩 logo 做解压

所以它的价值是：

- 更早显示第一屏
- 更少依赖 `bootloader/boot-resource` 分区和 FAT 文件读取
- 启动路径更短

但前提是 `boot_package.cfg` 里真的把 `logo` 项打开。

### 4.2.2 当前 `100ask` 是否启用了 boot package logo

当前没有启用。

因为以下配置仍是注释状态：

- `device/config/chips/v853/configs/default/boot_package.cfg:8`
- `device/config/chips/v853/configs/default/boot_package_nor.cfg:8`

对应内容：

```ini
;item=logo,                   bootlogo.bmp.lzma
```

这意味着：

1. `scripts/pack_img.sh` 仍会生成 `out/v853-100ask/image/bootlogo.bmp.lzma`
2. 但这份压缩图当前不会被打入 `boot_package.fex`
3. 所以 U-Boot 最终还是会回退到 `boot-resource` 分区里的 `bootlogo.bmp`

### 4.3 `boot-resource` 分区回退路径

当 boot package 没有可用 logo 时，U-Boot 会走普通显示路径：

- `lichee/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:640`

调用：

```c
sunxi_bmp_display("bootlogo.bmp");
```

而 `sunxi_bmp_display()` 会在：

- `lichee/brandy-2.0/u-boot-2018/drivers/video/sunxi/logo_display/cmd_sunxi_bmp.c:313-318`

先找：

- `bootloader`

找不到再回退到：

- `boot-resource`

最终 `logo` 命令默认也是显示：

- `lichee/brandy-2.0/u-boot-2018/drivers/video/sunxi/logo_display/cmd_sunxi_bmp.c:544`

```c
return sunxi_bmp_display("bootlogo.bmp");
```

因此当前 `100ask` 的实际工作路径是：

`boot-resource` 分区 -> FAT 文件系统 -> `bootlogo.bmp` -> 显示

## 5. `bootlogo.fex` 的地位

`device/config/chips/v853/configs/100ask/linux/bootlogo.fex` 本身确实存在，并且也被拷到了：

- `out/v853-100ask/image/bootlogo.fex`

但它并不是当前正常启动使用的 Logo 分区文件。

原因是：

1. 正常启动分区表只启用了 `boot-resource` 分区，没有启用 `bootlogo` 分区。
2. NOR 分区表虽然保留了 `bootlogo` 分区模板，但被注释掉了：
   - `device/config/chips/v853/configs/100ask/linux/sys_partition_nor.fex:77`
   - `device/config/chips/v853/configs/100ask/linux/sys_partition_nor.fex:79`

所以当前 `100ask` 正常启动时显示的并不是 `bootlogo.fex` 里的内容。

## 6. 当前 `100ask` 实际使用的 Logo

### 6.1 本地产物校验结果

我对以下文件做了本地哈希比对：

- `target/allwinner/generic/boot-resource/boot-resource/bootlogo.bmp`
- `device/config/chips/v853/configs/default/boot-resource/bootlogo.bmp`
- `out/v853-100ask/image/boot-resource/bootlogo.bmp`
- `device/config/chips/v853/boot-resource/boot-resource/bootlogo.bmp`

结果：

- 前三个完全相同
- 第四个不同

### 6.2 结合 pack 优先级判断

结合 `boot_resource_list` 的顺序，当前 `100ask` 的 `bootlogo.bmp` 可以理解为：

- 先由 `target/allwinner/generic/boot-resource` 提供基础资源
- 再由 `device/config/chips/v853/configs/default/boot-resource/bootlogo.bmp` 做平台默认覆盖
- 由于 `configs/100ask/configs/*.bmp` 不存在，因此没有更高优先级的板级覆盖

由于当前仓库里：

- `target/allwinner/generic/.../bootlogo.bmp`
- `device/config/chips/v853/configs/default/.../bootlogo.bmp`

恰好是同一份内容，所以最终输出文件与两者哈希都一致。

### 6.3 当前运行时用图与 boot package 图的对应关系

把“当前到底在用哪张图”拆开看，会更清楚：

1. 当前正常显示使用的源图是：
   - `device/config/chips/v853/configs/default/boot-resource/bootlogo.bmp`

2. pack 后参与 `boot-resource` 分区的文件是：
   - `out/v853-100ask/image/boot-resource/bootlogo.bmp`

3. 启动运行时真正被 U-Boot 读取显示的是：
   - `boot-resource` 分区中的 `bootlogo.bmp`

4. 同时，pack 阶段还会生成一份压缩版：
   - `out/v853-100ask/image/bootlogo.bmp.lzma`

5. 但由于 `boot_package.cfg` 中的 `logo` 项仍是注释状态，这份压缩图当前只是“已生成但未生效”的 boot package 预备资源，不是实际显示路径。

6. 当前板级覆盖文件：
   - `device/config/chips/v853/configs/100ask/configs/bootlogo.bmp`

   在仓库中不存在，因此 `100ask` 没有自己的板级专属 logo 覆盖，实际继承的是 `configs/default/boot-resource/bootlogo.bmp`

## 7. 为什么仓库里还保留 `device/config/chips/v853/boot-resource`

这是当前问题的核心。

### 7.1 它是一套“完整 boot-resource 模板”

这个目录包含的不只是开机图，还有：

- `bootlogo.bmp`
- `font24.sft`
- `font32.sft`
- `bat/bat0.bmp ~ bat10.bmp`
- `bat/battery.bmp`
- `bat/battery_charge.bmp`
- `bat/bempty.bmp`
- `bat/low_pwr.bmp`

目录结构明显是为完整启动 GUI / 充电 GUI 准备的，而不是单纯为开机 Logo 准备的。

### 7.2 U-Boot 的确还保留了对这些资源的使用代码

例如在：

- `lichee/brandy-2.0/u-boot-2018/board/sunxi/power_manage.c:328`
- `lichee/brandy-2.0/u-boot-2018/board/sunxi/power_manage.c:338`
- `lichee/brandy-2.0/u-boot-2018/board/sunxi/power_manage.c:589`
- `lichee/brandy-2.0/u-boot-2018/board/sunxi/power_manage.c:603`
- `lichee/brandy-2.0/u-boot-2018/board/sunxi/power_manage.c:608`

可以看到它会显示：

- `bat\\bat0.bmp`
- `bat\\battery_charge.bmp`

这说明“完整 `boot-resource` 目录”这种资源组织方式在 U-Boot 侧仍然是有意义的。

### 7.3 但当前 `100ask` 这条打包链没有直接使用它

当前 `100ask` 实际打出来的 `out/v853-100ask/image/boot-resource/` 中只有：

- `bootlogo.bmp`

并没有把芯片级目录中的：

- `bat/`
- `font24.sft`
- `font32.sft`

这些资源一起打进去。

同时，`boot-resource.ini` 也能说明当前 pack 使用的并不是芯片级模板：

- `target/allwinner/generic/boot-resource/boot-resource.ini:24` 的 `size=8192`
- `device/config/chips/v853/boot-resource/boot-resource.ini:24` 的 `size=131072`

而当前产物：

- `out/v853-100ask/image/boot-resource.ini`

保持的是 `size=8192`，与 generic 一致，不是芯片级目录那份配置。

### 7.4 因此更合理的判断

`device/config/chips/v853/boot-resource` 大概率属于以下几类之一：

- 老版本 Longan/Tina 方案中直接使用的芯片级 boot-resource 模板
- 面向带完整充电/低电量 UI 的产品保留的通用资源包
- 给其他板型、其他 pack 流程或手工替换资源时使用的参考目录
- 当前 `100ask` 这条打包链下没有接入的历史保留目录

换句话说：

- 它不是“无意义文件夹”
- 但它也不是你当前 `100ask` pack 的直接输入源

## 8. 对后续修改的建议

### 8.1 如果只是改 `100ask` 的开机 Logo

最稳妥的方式是新增：

- `device/config/chips/v853/configs/100ask/configs/bootlogo.bmp`

这样可以直接命中当前 `scripts/pack_img.sh` 已经支持的板级覆盖规则，不影响别的板型。

### 8.2 如果希望把“充电动画/电池图/字体”也一起纳入当前 pack

那就不能只改 `bootlogo.bmp`，而要重新接入完整 `boot-resource` 模板。当前脚本默认不会把 `device/config/chips/v853/boot-resource` 整包拷进 `100ask` 的 `image/boot-resource/`。

这类需求通常需要：

- 修改 `scripts/pack_img.sh` 的 `boot_resource_list`
- 或把芯片级 `boot-resource` 的完整内容迁移到当前生效的 generic/default/board 资源路径下

## 9. 最终结论

对当前这份 SDK 和 `v853-100ask` 来说，可以把问题归纳成一句话：

> `device/config/chips/v853/boot-resource` 是一套仍有代码意义、但在当前 `100ask` pack 流程中没有被直接使用的完整启动资源模板；当前真正参与打包并被 U-Boot 读取的，是 `boot-resource.fex` 中的 `bootlogo.bmp`，而这张图当前来自 `generic/default` 这条生效资源链，而不是该芯片级目录。

如果把近期关于 `boot_package` 与 logo 的分析也一起纳入，那么更完整的结论是：

> 当前 V853 打包流程里同时存在 `boot-resource.fex` 和 `boot_package.fex` 两条链：前者负责 `boot-resource` 分区文件系统资源，后者负责启动组合包；当前 `100ask` 虽然会生成 `bootlogo.bmp.lzma`，但由于 `boot_package.cfg` 中的 `logo` 条目仍被注释，启动时实际显示的仍然是 `boot-resource` 分区中的 `bootlogo.bmp`，而不是 boot package 内嵌 logo。
