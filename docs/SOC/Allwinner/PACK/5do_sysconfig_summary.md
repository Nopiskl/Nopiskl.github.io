# r818 `sys_config.fex` / `config.fex` 精简总结

## 结论

- `config.fex` 确实来自 `sys_config.bin`。
- 在当前 SDK 里，`sys_config.bin` 是由 `sys_config.fex` 经过 `script` 工具生成，再直接拷贝为 `config.fex`。
- `image.cfg` 同时收录 `sys_config.fex` 和 `config.fex`，不是因为两个来源不同，而是因为它们代表同一份板级配置的两种形态：
  - `sys_config.fex`：文本版
  - `config.fex`：二进制版
- 当前 `r818` 板级 `boot_package.cfg` 不打包这两个文件；“同时收录”发生在最终总镜像 `image.cfg` 这一层。

## 打包链路

1. `build/envsetup.sh` 调用 `scripts/pack_img.sh`
2. `do_prepare()` 把板级配置拷到 `out/<board>/image/`
3. `do_ini_to_dts()` 使用 `sys_config.fex` 参与生成 `sunxi.dtb`
4. `do_common()` 执行：
   - `script sys_config.fex` -> `sys_config.bin`
   - `cp sys_config.bin config.fex`
   - `update_boot0/update_uboot/update_fes1 ... sys_config.bin`
5. `do_finish()` 调 `dragon image.cfg ...` 打最终整包镜像

## 两个文件各自的角色

### `sys_config.fex`

- 是打包过程中的文本源配置
- 打包脚本会直接修改它
- `do_ini_to_dts()` 用它生成 `sunxi.dtb`
- 在最终镜像里以 `SYS_CONFIG100000` 收录

### `config.fex`

- 是 `sys_config.fex` 编译后的二进制配置
- 实际由 `sys_config.bin` 直接拷贝得到
- `update_boot0/update_uboot/update_fes1` 明确使用这份二进制配置
- 在最终镜像里以 `SYS_CONFIG_BIN00` 收录

## 为什么 `image.cfg` 要同时收录

可以把它理解为“同时保留可读源配置和可执行二进制配置”：

- `config.fex` 是启动链和 boot 组件更新工具真正依赖的格式
- `sys_config.fex` 更像是随镜像保留的文本快照，便于兼容、解包查看和调试

从现有脚本能明确证明：

- `config.fex` 是启动链要用的
- `sys_config.fex` 在打包阶段要用来生成 DTB

但在最终镜像落地后，仓内没有明显证据表明启动阶段还会直接读取 `sys_config.fex`；因此它更偏向“保留文本版配置”的历史兼容项。

## 为什么不是 `boot_package.cfg`

当前板级文件：

- `device/config/chips/r818/configs/default/boot_package.cfg`

只包含：

- `u-boot.fex`
- `monitor.fex`
- `scp.fex`
- `sunxi.fex`

它没有包含 `sys_config.fex`，也没有包含 `config.fex`。

虽然 common 模板：

- `device/config/common/imagecfg/boot_package.cfg`

里有 `soc-cfg = config.fex`，但它已经被 `r818` 的板级 `boot_package.cfg` 覆盖了。

## 关键代码位置

- `scripts/pack_img.sh`
  - `do_prepare()`：拷贝配置并决定最终使用哪份 `sys_config.fex`
  - `do_ini_to_dts()`：`sys_config.fex` -> `sunxi.dtb`
  - `do_common()`：`sys_config.fex` -> `sys_config.bin` -> `config.fex`
  - `do_finish()`：`dragon image.cfg ...`
- `device/config/chips/r818/configs/default/image.cfg`
  - 同时收录 `sys_config.fex` 和 `config.fex`
- `device/config/chips/r818/configs/default/boot_package.cfg`
  - 当前板级 boot package 不收录这两个文件

