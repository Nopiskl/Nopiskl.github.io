# SDK build script pack process analysis
_Exported on 2026/4/1 at GMT+8 19:48:00 from Cursor (2.6.21)_

---

**User**

帮我分析一下这个SDK的./build.sh pack流程

---

**Cursor**

{"id":"","input":{},"name":"","type":"tool_use"}

Need final part beyond 1500 maybe.

可以，我给你按**实际脚本调用链**把这个 SDK 的 `./build.sh pack` 流程拆开讲（你这个工程是 Tina/Allwinner 这套打包链路）。

---

## 1) 入口：`./build.sh pack*`

`build.sh` 本身只是壳，直接转到 `build/mkcommon.sh`。  
在 `mkcommon.sh` 里，`pack*` 会被解析成 `mk_pack` 动作，并把后缀选项转成参数：

- `pack_debug` → `-d card0`
- `pack_secure` → `-v secure`
- `pack_dump` → `-m dump`
- `pack_prvt` → `-f prvt`
- `pack_raw` → `-w programmer`
- `pack_verity` → `--verity`
- `pack_signfel` → `--signfel`
- 等等

然后执行 `mkcmd.sh` 里的 `mk_pack`。

---

## 2) `mk_pack` 做的事（`build/mkcmd.sh`）

`mk_pack` 核心就是拼好参数后调用 `build/pack`：

- 平台不是 android 时，`PACK_PLATFORM` 用 `LICHEE_LINUX_DEV`（比如 `bsp/buildroot/openwrt/...`）
- 更新 `LICHEE_POSSIBLE_BIN_PATH`
- 最终执行：
  - `./build/pack -i <ic> -c <chip> -p <platform> -b <board> -k <kernel> -n <flash> ...`

如果板级配置里设置了 `LICHEE_PACK_HOOK`，会改用自定义 hook 脚本打包。

---

## 3) 真正打包主流程：`build/pack` 的 `main()`

默认流程（不是 `--output_resources` / `--from_resources` 模式）：

1. `do_prepare`
2. `do_ini_to_dts`
3. `do_common`
4. `do_pack_${PACK_TYPE}`（linux/android/dragonboard/...）
5. `do_finish`

---

## 4) 各阶段在干什么

### A. `do_prepare`（准备 pack_out 资源）
这是最重的一步，主要做“收集+覆盖”：

- 清空并重建 `LICHEE_PACK_OUT_DIR`（通常是 `out/<ic>/<board>/pack_out`）
- 复制工具文件、基础配置、板级配置、平台配置
- 按优先级覆盖 `*.cfg/*.fex`（board > default > common）
- 拷贝 boot 资源（logo、wave 等）并处理 `lzma` 头
- 拷贝 boot 相关二进制（boot0/fes1/u-boot/bl31/scp/optee/...）
- 根据 `PACK_NOR` / `PACK_VSP` / `PACK_PROGRAMMER` / `PACK_MODE` 做差异化修改
- 处理 `sys_partition.fex`（例如把 `M/G` 这种尺寸换算成 block）

> 你当前打开的 `out/a733/x733mhn_aic8800/pack_out/boot_package.cfg`、`dragon_toc.cfg` 就是在这一阶段被准备/覆盖出来的关键输入。

---

### B. `do_ini_to_dts`（配置转 bin/dtb）
- `sys_config.fex` 先转 `sys_config.bin`（`script` 工具）
- 旧内核会从 ini+模板生成 `sunxi.dtb`
- 新内核（你是 `linux-6.6`）主要走已生成的 `sunxi.dtb`，并额外导出 `.sunxi.dts` 供调试
- 还会尝试把 `u-boot` 内置 fdt 拆分/合并更新

---

### C. `do_common`（统一打包前处理）
- 根据是否 secure 修改 `sys_config.fex`（如 `burn_secure_mode`）
- `sys_partition.fex` 转 bin
- 更新 boot0/fes1/u-boot/scp/optee 等头信息与参数
- 打包 `boot_package.fex`（调用 `dragonsecboot -pack boot_package.cfg`）
- 生成 `env.fex`（`u_boot_env_gen` 或 `mkenvimage`）
- NOR 情况会单独走 `sys_partition_nor.fex`、`boot_package_nor.cfg` 等分支

---

### D. `do_pack_linux`（按平台挂接镜像）
对于 linux 类平台：

- 链接 `boot.img -> boot.fex`
- 链接 `rootfs.ext4/rootfs.img -> rootfs.fex`
- 链接 `rootfs.ubifs -> rootfs-ubifs.fex`
- 如果 `PACK_SECURE=secure`，调用 `do_signature`

`do_signature` 会基于 `dragon_toc.cfg` 做 toc0/toc1 证书链、签名 boot/recovery/dsp/rv 等。

---

### E. `do_finish`（生成最终 img）
- 检查 `boot_package.fex/toc1.fex` 大小限制
- `update_mbr` 生成 `sunxi_mbr.fex` / `sunxi_gpt.fex`
- 执行 `dragon image.cfg sys_partition.fex` 产出最终 `*.img`
- 镜像落盘到：
  - `out/<ic>/<board>/<linux_dev>/<img>`
  - 并在 `out/` 下创建同名软链
- 若 `programmer` 模式，额外生成 `*_programmer.img`

---

## 5) 你这两个文件在流程里的作用

- `boot_package.cfg`：决定 `boot_package.fex` 里打哪些启动组件（u-boot、monitor、scp、optee...）
- `dragon_toc.cfg`：secure 签名拓扑（toc0/toc1、key/cert、各镜像签名关系）

简单说：  
`boot_package.cfg` 管“打包内容”；`dragon_toc.cfg` 管“安全签名结构”。

---

如果你愿意，我下一步可以直接按你这个 `a733/x733mhn_aic8800` 配置，帮你画一张**“输入文件 → 中间产物 → 最终镜像”**的定制流程图（会明确每个产物在哪个目录生成）。

