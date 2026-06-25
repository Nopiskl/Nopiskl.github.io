

**User**

基于SDK解释一下toc1/toc2/monitor/scp/fes都是什么

---

**Cursor**

可以，按你这个 SDK（你当前 `pack_out` 里的配置）来解释最清楚：

### 1) `toc1` 是什么
在这套 Allwinner 打包链里，安全启动主要是 `toc0 + toc1`，不是 `toc2`。  
你当前 `dragon_toc.cfg` 里能看到 `[toc1]`，里面定义了要被认证/签名的内容，比如：

- `scp.fex`
- `monitor.fex`
- `optee.fex`
- `boot.fex`
- `u-boot.fex`
- 以及 `dtb/config/logo` 等

**作用**：`toc1` 本质是“二阶段可信内容清单 + 证书容器”，告诉安全链要验证哪些镜像、用什么证书关系验证。

---

### 2) `toc2` 是什么（结合你这个 SDK）
就你当前 SDK/板级配置看，pack 流程实际使用的是 `toc0/toc1`，我没看到 `toc2` 在这条链路里参与。  
所以这里可以理解为：

- **你这个 SDK 主流程没有启用 toc2**
- `toc2` 可能是别的 SoC/别的安全方案版本里的概念，但**不在你当前这套打包主路径**

---

### 3) `monitor` 是什么
`monitor.fex` 通常来自 `bl31.bin`（ATF/Trusted Firmware-A 的 EL3 monitor）。

**作用**：
- 负责 EL3 世界的初始化和切换（secure monitor）
- 在 secure/non-secure 世界之间做入口调度
- 是安全启动链条中的关键一环

你 `boot_package.cfg` 里有：
- `item=monitor, monitor.fex`

说明它会被打进 boot package。

---

### 4) `scp` 是什么
`scp.fex` 是系统控制处理器固件（System Control Processor firmware），常用于低功耗/时钟/电源等协处理控制（具体到芯片实现可能是 ARISC/M33 等）。

**作用**：
- 早期上电后的系统控制任务
- 运行在独立小核/协处理器上
- 和主 CPU 启动链并行配合

你 `boot_package.cfg` 也明确打包了 `scp.fex`。

---

### 5) `fes` 是什么
你问的 `fes` 在这套 SDK 里主要是 `fes1`（还有 `fes1_uart`）：

- `fes1.fex`：量产/烧写/恢复早期阶段使用的引导工具镜像之一
- `fes1_uart.fex`：UART 相关场景版本
- 另外常见 `u-boot-efex.fex`：用于 FEL/EFEX 下载烧写流程的 u-boot 变体

**作用**：
- 面向“下载/烧录/救砖”流程的早期启动组件
- 不等同于系统正常启动的 `boot.fex/u-boot.fex`
- 在 secure 场景下也可以单独签名（你这套 `pack` 里有 `--signfel` 相关逻辑）

---

## 一句话总结（按你这个 SDK）
- **安全链核心是 `toc0 + toc1`**
- `monitor` = EL3 安全监控固件（通常 ATF BL31）
- `scp` = 系统控制协处理器固件
- `fes` = 烧写/恢复链路的早期引导工具镜像（`fes1`/`fes1_uart`/`efex`）
- **`toc2` 不在你当前这条打包主流程里**

如果你要，我可以下一步结合你当前 `a733/x733mhn_aic8800` 的 `pack_out`，给你画一张“上电到内核”的实际启动顺序图（把 `boot0/fes/toc0/toc1/monitor/scp/u-boot/boot.img` 串起来）。


---

**User**

rootfs.img和boot.img是怎么生成的

---

**Cursor**

这个问题非常关键，结论先说：

- `boot.img` 和 `rootfs.img` **不是** `pack_img.sh` 现生成的  
- 它们是前面 `m`（`make`）阶段在 OpenWrt/Tina 的 `image` 构建流程里生成的  
- `pack_img.sh` 在 `do_pack_tina` 只是把它们链接/拷贝成 `boot.fex/rootfs.fex` 再进最终打包

---

## 1) `rootfs.img` 怎么来的

你当前 `defconfig` 里是：

- `CONFIG_TARGET_ROOTFS_SQUASHFS=y`

所以 rootfs 文件类型是 squashfs。  
在 `build/image.mk` 的 `Image/Build` 逻辑里，最终会做：

- 先生成 `$(KDIR)/root.$(fs)`（这里就是 `root.squashfs`）
- 再用 `dd` 转成输出目录里的 `rootfs.img`

也就是：

\[
root.squashfs \xrightarrow{dd\;conv=sync} out/r818-sc3917/rootfs.img
\]

这就是你现在看到的 `out/r818-sc3917/rootfs.img` 来源。

---

## 2) `boot.img` 怎么来的

你的配置里有：

- `CONFIG_SUNXI_SD_BOOT_KERNEL_FORMAT_BOOTIMG=y`
- `CONFIG_TARGET_ROOTFS_INITRAMFS` 未开启（普通 rootfs，不是 initramfs rootfs）

在 allwinner 的 image 逻辑中（你工程里当前产物也能印证），boot 构建流程是：

1. 先把内核做成 `uImage`（你现在有 `r818-sc3917-uImage`）
2. 再用 `mkbootimg` 生成 `r818-sc3917-boot.img`
3. 安装阶段再落成最终 `boot.img`（你目录里同时有前缀版和最终版）

你现在 `out/r818-sc3917` 里同时有：

- `r818-sc3917-uImage`
- `r818-sc3917-boot.img`
- `boot.img`

这正是这条链路的典型结果。

---

## 3) 它们怎么进入最终固件 `.img`

在 `pack_img.sh -> do_pack_tina` 里：

- `boot.fex -> ${ROOT_DIR}/boot.img`（软链）
- `rootfs.fex -> ${ROOT_DIR}/rootfs.img`（软链，非 secure 时）
- 然后 `do_finish` 调 `dragon image.cfg ...`，把 `boot.fex/rootfs.fex` 按 `sys_partition.fex` 写入最终整包 `tina_r818-sc3917_uart0.img`

---

## 4) 一句话串起来

`make` 先产出 `boot.img/rootfs.img` → `pack` 把它们映射成 `boot.fex/rootfs.fex` → `dragon` 根据分区表打成最终 `*.img`。  

如果你愿意，我下一步可以再给你画一版“从 `KDIR/root.squashfs` 到最终分区 `rootfs`”的字段级映射（含 `sys_partition.fex` 的 `downloadfile` 对应关系）。
