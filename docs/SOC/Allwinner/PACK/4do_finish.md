
---

**User**

继续详细分析一下do_finish

---

**Cursor**

好，继续把 `do_finish()` 详细拆开。  
这个阶段的核心作用是：

**把前面阶段准备好的分区/镜像，喂给 `dragon` 生成最终整包 `.img`，并可选再生成 programmer 镜像。**

---

## 1) `do_finish` 的位置与输入

调用顺序是：

`do_prepare -> do_ini_to_dts -> mkdtbo -> do_common -> do_pack_tina -> do_finish`

所以 `do_finish` 进入时，`image/` 目录里已经有：

- `sys_partition.bin / sys_partition.fex`
- `boot0_*.fex`, `u-boot*.fex`, `boot_package*.fex`
- `boot.fex`, `rootfs.fex`, `recovery.fex`
- `image.cfg`
- （可能）`sys_partition_nor.bin` / `sys_partition_nor.fex`

---

## 2) 第一层分支：是否存在 `sys_partition_nor.bin`

---

### A. 存在 `sys_partition_nor.bin`（NOR 相关收口）

会先：

1. `update_mbr sys_partition_nor.bin 1 sunxi_mbr_nor.fex`
2. 再按内核版本做不同处理：

#### A1) `linux-3.4` 路径
- 选择 `BOOT1_FILE=u-boot-spinor.fex`
- 计算默认偏移（可被 pre-pack hook 覆盖）：
  - `LOGIC_START=496`
  - `UBOOT_START=24`
- 选择 MBR 文件：
  - 若 `TARGET_UBOOT=u-boot-2018` 用 `sunxi_gpt.fex`
  - 否则 `sunxi_mbr_nor.fex`
- `merge_full_img --out full_img.fex ... --partition sys_partition_nor.bin`
- 删除 `sys_partition_for_dragon.fex`

#### A2) 非 `linux-3.4` 路径
- `BOOT1_FILE=boot_package_nor.fex`
- 同样走 `merge_full_img`
- 并把 `sys_partition_nor.fex -> sys_partition_for_dragon.fex`

最后统一执行：
- `cp sys_partition_nor.fex sys_partition.fex`

---

### B. 不存在 `sys_partition_nor.bin`（普通 NAND/eMMC 路径）

这是你当前更可能走到的路径（从你目录看没有 `sys_partition_nor.bin`）：

1. 若是 `linux-3.4` 且没有 `full_img.fex`，写个占位
2. `update_mbr sys_partition.bin 4`（生成标准 mbr）
3. `cp sys_partition.fex sys_partition_for_dragon.fex`

---

## 3) 第二层：调用 `dragon` 真正出整包镜像

`do_finish` 后半段无论上面哪个分支，都会走到：

- 如果有 `sys_partition_for_dragon.fex`：
  - `do_dragon image.cfg sys_partition_for_dragon.fex`
- 否则：
  - `do_dragon image.cfg`

而 `do_dragon()` 做了关键动作：

1. `show_partition_message` 打印分区信息
2. `do_check_pack_file` 检查关键 boot0/toc 文件不能全是无效占位
3. `dragon ...` 真正组包
4. 成功后把生成的 `${IMG_NAME}` 移到上一级（`out/<board>/`）
5. 打印最终镜像路径

---

## 4) 可选：programmer 镜像

如果 `PACK_PROGRAMMER=programmer`（也就是 pack 带了 `-w`）：

- 调 `img_to_programmer ${IMG_PROGRAMMER_NAME} ../${IMG_NAME}`
- secure 模式用 `toc0/toc1` 做 programmer 前导
- 普通模式用 `boot0_sdcard.fex + boot_package.fex`
- 最终把 `${IMG_PROGRAMMER_NAME}` 挪到 `out/<board>/`

---

## 5) `do_finish` 阶段最终产物

最关键的输出是：

- `out/<board>/${IMG_NAME}`（最终可烧录整包）
- 若 `-w`：`out/<board>/${IMG_PROGRAMMER_NAME}`

并且 `image/` 下会留下：

- `sunxi_mbr.fex`（或 nor 对应）
- `sys_partition_for_dragon.fex`
- 及所有中间输入文件

---

## 6) 结合你当前工程的实用结论（非 NOR 视角）

你现在目录里已有 `sys_partition_for_dragon.fex`、`sunxi_mbr.fex`，且没看到 `sys_partition_nor.bin`，基本符合 **`do_finish` 的普通分支** 行为：

- `update_mbr sys_partition.bin 4`
- `cp sys_partition.fex -> sys_partition_for_dragon.fex`
- `dragon image.cfg sys_partition_for_dragon.fex`

---

如果你愿意，我下一步可以继续拆 `do_dragon()`，把 `dragon` 入参里 `image.cfg` 的 `imagename/downloadfile` 如何解析、最终为什么产出你看到的那个 `*.img`，逐字段给你对应起来。

