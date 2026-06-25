
---

**User**

能否分析一下如果我烧录到SD卡上，全盘数据组成是什么样的

---

**Cursor**

可以，而且这个问题很关键。  
如果你把当前这套 `r818-sc3917` 镜像烧到 **SD 卡**，整盘数据可以分成两大块：

1) **启动保留区（分区表前/外）**：BootROM 直接读的引导数据  
2) **普通分区区（按 `sys_partition.fex`）**：boot/rootfs/数据分区等

---

## 1) 启动保留区（不等同于 Linux 可见分区）

按 Allwinner 打包逻辑（你当前是非 secure 常规路径），会写入这类内容：

- `boot0_sdcard.fex`（第一阶段引导，BootROM 从固定位置读）
- `boot_package.fex`（通常包含 `u-boot`、`monitor`、`scp`、`dtb`，见你现在的 `boot_package.cfg`）
- `sunxi_mbr.fex` / 分区描述相关信息
- 以及 `sys_config/config` 等打包元数据

这些通常不是你在 Linux 下 `lsblk` 看到的普通文件系统分区内容，而是卡前部的“raw 区域/保留区域”。

---

## 2) 普通分区区（你这版 `sys_partition.fex`）

你当前分区定义（单位是 512B 扇区）如下：

- `boot-resource` 4096 扇区 = 2 MiB（`boot-resource.fex`）
- `env` 1024 扇区 = 512 KiB（`env.fex`）
- `env-redund` 1024 扇区 = 512 KiB（`env.fex`）
- `boot` 30720 扇区 = 15 MiB（`boot.fex`）
- `rootfs` 105984 扇区 = 51.75 MiB（`rootfs.fex`）
- `rootfs_data` 8192 扇区 = 4 MiB（未指定 downloadfile，通常运行时用）
- `private` 1024 扇区 = 512 KiB
- `recovery` 32768 扇区 = 16 MiB（`recovery.fex`）
- `pstore` 1024 扇区 = 512 KiB
- `UDISK` 剩余全部空间（`size` 未写，表示吃满剩余容量）

> 固定大小分区合计约 **90.75 MiB**，其后全部给 `UDISK`。

---

## 3) “整盘视角”可以理解成这样

```text
[SD 卡起始]
  ├─ Boot 保留区（raw）
  │    ├─ boot0_sdcard.fex
  │    ├─ boot_package.fex（内含 u-boot/monitor/scp/dtb）
  │    └─ mbr/打包元数据
  └─ 按 sys_partition.fex 的分区区
       ├─ boot-resource (2M)
       ├─ env (512K)
       ├─ env-redund (512K)
       ├─ boot (15M)
       ├─ rootfs (51.75M)
       ├─ rootfs_data (4M)
       ├─ private (512K)
       ├─ recovery (16M)
       ├─ pstore (512K)
       └─ UDISK (剩余全部)
[SD 卡结束]
```

---

## 4) 你这套配置下的两个关键点

- 启动链主文件是 `boot0_sdcard.fex + boot_package.fex`（不是从 `boot` 分区直接起）
- `boot` 分区里的 `boot.fex` 是内核/ramdisk镜像，属于第二阶段启动内容

---

如果你愿意，我下一步可以直接按你这个分区表给你算一版“从起始扇区开始的每个分区 offset（sector/MB）”，做成可直接对照 `fdisk -l` 的表。


---

**User**

你结合uboot或者其他你能找到的SDK资料确认一下

---

**Cursor**



你这个追问很专业，我用你工程里的 U-Boot/SDK 源码再确认了一遍，结论如下：

## 结论（先说人话）
- **文件名层面**：eMMC 和 SD 在 pack 里都走 `boot0_sdcard.fex` 这条产物链（没有 `boot0_emmc.fex`）。
- **介质实例层面**：它们不是同一个控制器实例：  
  - SD 通常是 `card_no = 0`（SD0）  
  - eMMC 通常是 `card_no = 2`（SD2）  
- **因此更准确说法是**：  
  **“共用 SDMMC 类型 boot0 格式/文件名，但运行时按 storage_type/card_no 区分是 SD 还是 eMMC。”**

---

## 你工程里可直接对应的源码证据

1) `spare_head.h` 定义了启动来源和存储类型区分  
- `BOOT_FROM_SD0`、`BOOT_FROM_SD2`  
- `STORAGE_SD`、`STORAGE_EMMC`、`STORAGE_EMMC0`、`STORAGE_EMMC3`

文件：`lichee/brandy-2.0/u-boot-2018/include/spare_head.h`

2) `sunxi_flash.c` 明确把不同 storage_type 映射到不同 `card_no`  
- `STORAGE_SD -> card_no = 0`  
- `STORAGE_EMMC -> card_no = 2`  
- `STORAGE_EMMC0 -> card_no = 0`  
- `STORAGE_EMMC3 -> card_no = 3`

文件：`lichee/brandy-2.0/u-boot-2018/drivers/sunxi_flash/sunxi_flash.c`

3) `pack_img.sh` 对 `boot0_sdcard.fex` 使用 `SDMMC_CARD` 更新  
文件：`scripts/pack_img.sh`（`update_boot0 boot0_sdcard.fex ... SDMMC_CARD`）

---

## 为什么会容易误判
因为 BSP 历史命名里还保留了 `boot0_nand.fex`、`boot0_sdcard.fex` 两个名字，容易让人以为 eMMC 必须有一个 `boot0_emmc.fex`。  
实际上在你这套 SDK 里，eMMC 被归到 SDMMC 体系，区别主要在 `storage_type` 和 `card_no`，不是体现在文件名上。

---

如果你愿意，我可以下一步把“`storage_type=1(card0)` 和 `storage_type=2(card2)` 时，`boot0` 头里哪些字段会被 `update_boot0` 改写”也帮你继续追到工具源码级。

