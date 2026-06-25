

**User**

继续分析一下do_common阶段

---

**Cursor**


好，继续看 `do_common`。  
这个阶段可以概括为一句话：

**把 `do_prepare` 准备好的“文本配置 + 原始 boot 组件”，加工成可被 `dragon` 组包的标准 `.fex/.bin` 产物。**

---

## 1) `do_common` 的入口状态

进入 `do_common` 时，前面已经完成：

- `do_prepare`：`out/<board>/image/` 下有 `sys_config.fex / sys_partition.fex / env.cfg / boot0/u-boot/...`
- `do_ini_to_dts`：一般已生成 `sunxi.dtb`

`do_common` 直接 `cd ${ROOT_DIR}/image` 开始处理。

---

## 2) 第一段：基础文本转二进制

它先做最基础三件事：

1. 保证 `board_config.fex` 存在（没有就写 `[empty]`）
2. 对 `sys_config.fex / board_config.fex / sys_partition.fex` 做 `unix2dos + script` 转换
3. 生成：
   - `config.fex`（来自 `sys_config.bin`）
   - `board.fex`（来自 `board_config.bin`）

这一步的核心是把可读配置转成后续工具链吃得进去的二进制格式。

---

## 3) 第二段：NOR 专用分支（如果存在 `sys_partition_nor.fex`）

如果检测到 `sys_partition_nor.fex`，就走一套 SPINOR 处理：

- `sunxi.dtb -> sunxi.fex`（并可能更新 `scp.fex`）
- `sys_partition_nor.fex` 转 bin
- `update_boot0 boot0_spinor.fex ... SPINOR_FLASH`
- `update_chip boot0_spinor.fex`
- `update_uboot`（`linux-3.4` 用 `-merge`，其他用 `-no_merge`）
- 如果有 `boot_package_nor.cfg`，调用 `dragonsecboot -pack` 出 `boot_package_nor.fex`
- 生成 `env_nor.fex`
  - 若开了冗余环境：`mkenvimage -r ...`
  - 否则：`u_boot_env_gen env_nor.cfg env_nor.fex`
- 把 `env_nor.cfg` 里的 `boot_normal` 从 `boota` 强制改成 `bootm`（NOR 启动模式适配）

---

## 4) 第三段：通用 boot 组件二次更新（无论 NOR 与否都做）

后面还有一段“通吃”更新，会继续处理 NAND/SD 启动件：

- 保证 `u-boot-crash.fex` 存在（没有就造一个占位）
- 若有 `sunxi.dtb`：复制成 `sunxi.fex` 并 `update_dtb`
- 若有 `scp.fex`：`update_scp`
- `boot0_nand.fex` 和 `boot0_sdcard.fex`：
  - 有就 `update_boot0`
  - 没有就写占位文本（避免后续空缺）
- `update_uboot`（同样 3.4 merge / 非 3.4 no_merge）
- `update_fes1`
- `fsbuild boot-resource.ini split_xxxx.fex` 生成 boot-resource 相关镜像
- 若存在 `boot_package.cfg`，执行 `dragonsecboot -pack boot_package.cfg`

> 所以你会看到：即便是 NOR 方案，脚本也尽量把 NAND/SD 的文件维持完整，方便后续流程统一处理。

---

## 5) 第四段：生成最终 `env.fex`（你现在打开的 `env.cfg` 在这里生效）

这里是和你当前关注文件最直接相关的地方：

- 如果 `PACK_FUNC=prvt`，用 `env_burn.cfg` 生成 `env.fex`
- 否则用 `env.cfg` 生成 `env.fex`
- 生成方式取决于 `.config`：
  - `CONFIG_SUNXI_MAKE_REDUNDANT_ENV=y`：走 `mkenvimage -r ...`
  - 否则走 `u_boot_env_gen`

也就是说：  
**`do_prepare` 负责“改 env.cfg 内容”，`do_common` 负责“把它固化成 env.fex”。**

---

## 6) 第五段：ARISC 兼容处理

最后有个小兼容：

- 若存在 `arisc` 文件，则做 `arisc.fex` 软链。

---

## 7) 这个阶段产出的关键文件（对后续 `do_pack_tina/do_finish` 有效）

你会在 `out/r818-sc3917/image/` 看到它产出的核心文件：

- `config.fex`, `board.fex`
- `sys_partition.bin`
- `sunxi.fex`
- `boot0_nand.fex`, `boot0_sdcard.fex`, `boot0_spinor.fex`（视场景）
- `u-boot.fex`, `fes1.fex`, `boot_package.fex` / `boot_package_nor.fex`
- `env.fex`（以及可能的 `env_nor.fex`）

这些就是后续 `dragon` 打整包 img 的直接输入。

---

如果你愿意，下一步我可以继续按你当前目录里的实际文件（你这边 `image/` 已经有现成产物），给你做一版“**`do_common` 前后文件变化清单**”，这样你能马上看出哪个文件是在这一步被覆盖/生成的。


**User**

继续分析一下do_common阶段，帮我再分析一下，不管NOR路径

---

**Cursor**

好的，这次我只按 **非 NOR 路径** 来拆 `do_common()`。

你可以把它看成：  
**把 `image/` 里的文本配置和 boot 二进制，标准化为 dragon 打包可用的 `.fex/.bin` 文件。**

---

## 非 NOR 进入条件

`do_common` 里用这个判断分叉：

- 如果存在 `sys_partition_nor.fex` 走 NOR 分支
- **你现在要求的是“不管 NOR 路径”**，即按 `sys_partition_nor.fex` 不存在来分析

---

## 非 NOR 主流程（按执行顺序）

### 1) 初始化与基础转换
- 进入 `out/<board>/image`
- 若没有 `board_config.fex`，创建一个 `[empty]`
- 对以下文件做格式转换：
  - `sys_config.fex`
  - `board_config.fex`
  - `sys_partition.fex`
- 生成：
  - `config.fex`（来自 `sys_config.bin`）
  - `board.fex`（来自 `board_config.bin`）

script sys_config.fex 先生成 sys_config.bin，下一行马上 cp -f sys_config.bin config.fex

---

### 2) 非 NOR 的第一轮 boot0/update
在 `if [ -f sys_partition_nor.fex ] ... else ... fi` 的 `else` 分支里会先做：

- `update_boot0 boot0_nand.fex ... NAND`
- `update_boot0 boot0_sdcard.fex ... SDMMC_CARD`
- `update_chip boot0_nand.fex`
- `update_chip boot0_sdcard.fex`

这一步可以理解为：先把非 NOR 介质启动头按当前 `sys_config.bin` 刷一遍。

---

### 3) 通用收口（所有路径都会执行）
分支结束后继续执行这些：

- 确保 `u-boot-crash.fex` 存在（没有就创建占位）
- 若有 `sunxi.dtb`：
  - 复制成 `sunxi.fex`
  - `update_dtb sunxi.fex 4096`
- 若有 `scp.fex`：
  - `update_scp scp.fex sunxi.fex`

---

### 4) 非 NOR 的第二轮 boot0/update（重点）
后面还有一段 “Those files for Nand or Card”：

- 如果 `boot0_nand.fex` 存在，再执行一次 `update_boot0 ... NAND`
- 如果 `boot0_sdcard.fex` 存在，再执行一次 `update_boot0 ... SDMMC_CARD`
- 如果不存在，就写占位文本文件

> 也就是说，**非 NOR 场景下 boot0_nand/sdcard 可能会被 update 两次**（前面 else 一次，这里一次）。这是脚本本身的写法，不是你操作问题。

---

### 5) U-Boot / FES / boot-resource 处理--boot_package生成
- `update_uboot`
  - `linux-3.4` 用 `-merge`
  - 其他内核用 `-no_merge`
- `update_fes1 fes1.fex ...`
- `fsbuild boot-resource.ini split_xxxx.fex`
- 如果存在 `boot_package.cfg`：
  - `dragonsecboot -pack boot_package.cfg`
  - 生成/更新 `boot_package.fex`

---

### 6) 生成最终 `env.fex`
根据 `PACK_FUNC` 和 `.config` 来决定：

- `PACK_FUNC=prvt`：从 `env_burn.cfg` 生成 `env.fex`
- 否则：从 `env.cfg` 生成 `env.fex`
- 若 `CONFIG_SUNXI_MAKE_REDUNDANT_ENV=y`：
  - 用 `mkenvimage -r -s <CONFIG_SUNXI_REDUNDANT_ENV_SIZE>`
- 否则：
  - 用 `u_boot_env_gen`

---

### 7) 收尾
- 若存在 `arisc` 文件，则链接 `arisc.fex -> arisc`

---

## 非 NOR 路径的关键产物（你可重点核对）

在 `out/r818-sc3917/image/` 下，`do_common` 之后应重点关注：

- `sys_config.bin`, `config.fex`
- `board_config.bin`, `board.fex`
- `sys_partition.bin`
- `sunxi.fex`
- `boot0_nand.fex`, `boot0_sdcard.fex`
- `u-boot.fex`, `fes1.fex`, `boot_package.fex`
- `env.fex`

---

如果你要，我下一步可以专门结合你当前目录实际文件（你已经有 `sys_config.fex/env.cfg/env.fex/sunxi.fex`）做一版：  
**“非 NOR 场景下 do_common 的输入文件 -> 输出文件映射表”**，直接用于排查哪个环节把内容改掉了。


