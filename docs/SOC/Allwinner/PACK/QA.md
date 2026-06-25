
---

**User**

boot_package.fex是什么？如何生成的？

---

**Cursor**

`boot_package.fex` 可以理解成：**二级启动打包文件（Boot Package）**。  
它把若干启动阶段必须的组件合成一个包，供烧录镜像和启动链使用。

---

### 1) 它里面通常装什么（你当前板）

你当前 `boot_package.cfg` 内容是：

- `u-boot.fex`
- `monitor.fex`（通常是 ATF/BL31）
- `scp.fex`
- `sunxi.fex`（dtb）

所以 `boot_package.fex` 本质是把这些 boot 组件按 Allwinner 格式封装起来。

---

### 2) 它是怎么生成的

在 `pack_img.sh` 的 `do_common` 阶段会执行：

- 检查 `image/boot_package.cfg` 是否存在
- 存在则先做文本格式处理（`unix2dos`）
- 然后调用：

`dragonsecboot -pack boot_package.cfg`

生成 `boot_package.fex`。

---

### 3) `boot_package.cfg` 从哪来

在 `do_prepare` 阶段，脚本会把配置文件拷到 `out/<board>/image/`。  
你现在这个板子的 `boot_package.cfg` 来自：

- `device/config/chips/r818/configs/default/boot_package.cfg`  
（当前内容和你 `out/r818-sc3917/image/boot_package.cfg` 一致）

如果板级目录有同名覆盖文件，也可能被后拷贝覆盖。

---

### 4) 生成后在哪被使用

`image.cfg` 的 `FILELIST` 里有：

- `boot_package.fex`（子类型 `BOOTPKG-00000000`）

最终 `do_finish -> dragon` 打整包 `.img` 时会把它纳入镜像。  
另外做 programmer 镜像时（普通模式）也会用到 `boot_package.fex`。

---

如果你愿意，我可以下一步再帮你把 `boot_package.fex` 与 `u-boot.fex/boot0_nand.fex` 在启动阶段的职责边界再细分一下（谁在 BootROM 阶段被读取，谁在后续阶段生效）。

---

**User**

sunxi_mbr.fex如何生成的

---

**Cursor**

`sunxi_mbr.fex` 是在 **`do_finish` 阶段**由 `update_mbr` 工具生成的，核心输入是 `sys_partition.bin`。

---

### 生成链路（非 NOR，你当前板主要是这条）

1. 在 `do_common` 里先把分区文本转二进制：

- `sys_partition.fex`  
  \(\rightarrow\) `script sys_partition.fex`  
  \(\rightarrow\) `sys_partition.bin`

2. 到 `do_finish` 里执行：

- `update_mbr sys_partition.bin 4`

这条命令会生成（或更新）`sunxi_mbr.fex`（同时用于后续 `dragon` 打包）。

---

### NOR 分支补充（你问的是机制，顺便给全）

如果走 NOR 路径，会是：

- `update_mbr sys_partition_nor.bin 1 sunxi_mbr_nor.fex`

也就是显式指定输出成 `sunxi_mbr_nor.fex`，然后按后续逻辑继续。

---

### `sunxi_mbr.fex` 后续怎么用

在 `do_finish -> do_dragon image.cfg ...` 时，`image.cfg` 的 `FILELIST` 里有 `sunxi_mbr.fex`，  
它会被打进最终整包 `*.img`，并且在部分流程（如导出 tar 包）也作为关键元数据文件。

---

如果你愿意，我可以下一步再帮你把 `sys_partition.fex` 里每个分区项（`name/size/downloadfile`）如何映射到 `sunxi_mbr.fex` 的字段规则列出来。

---

**User**

 image.cfg的作用是什么

---

**Cursor**

`image.cfg` 的作用可以一句话概括：

**它是 `dragon` 打最终固件 `.img` 的“清单 + 元数据配置文件”。**

---

具体说，它负责这几件事：

1. **定义要打包哪些文件**（`[FILELIST]`）
   - 例如：`boot0_nand.fex`、`u-boot.fex`、`boot_package.fex`、`sys_partition.fex`、`sunxi_mbr.fex`、`boot.fex`、`rootfs.fex` 等
2. **给每个文件标注类型信息**
   - `maintype` / `subtype`，供打包工具识别用途
3. **定义镜像级元信息**（`[IMAGE_CFG]`）
   - `version`、`pid`、`vid`、`hardwareid`、`firmwareid`
4. **指定最终输出镜像名**
   - `imagename = tina_r818-sc3917_uart0.img`（你当前就是这个）
5. **告诉 `dragon` 用哪个 filelist**
   - `filelist = FILELIST`

---

在流程里它出现的位置是：

- `do_prepare` 会把它拷到 `out/.../image/` 并追加/修改 `imagename`
- `do_finish` 调 `do_dragon image.cfg ...`
- `dragon` 读取 `image.cfg`，按里面定义把各 `.fex` 组装成最终 `*.img`

---

所以你可以把它理解成固件打包阶段的“总控清单”。  
`sys_partition.fex` 决定“分区布局”，`image.cfg` 决定“镜像里有哪些组成文件及其类型/输出名”。
