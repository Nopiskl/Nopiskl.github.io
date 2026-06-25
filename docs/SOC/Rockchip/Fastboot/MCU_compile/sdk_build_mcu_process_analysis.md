# SDK build_mcu() process analysis
_Exported on 2026/6/5 at GMT+8 1:44:42 from Cursor (2.6.21)_

---

**User**

顶层 project/build.sh 在构建 U-Boot 前先调用 build_mcu()
请帮我分析一下SDK的build_mcu()简要流程

---

**Cursor**

我先查看顶层构建脚本以及 `build_mcu()` 的定义和调用链。

Need read files.

Need more lines in mcu build. Also top build function. Search maybe "mcu" exact.

我还需要定位 `build_mcu()` 在顶层脚本中的完整函数体，以及板级配置里传入 MCU 构建的参数。

顶层 `SDK/luckfox-pico/project/build.sh` 里，`build_mcu()` 主要是给 **fastboot 场景下的 U-Boot rkbin ini 注入 HPMCU 固件** 做准备：先编译出 `rtthread.bin`，再让 U-Boot 打包时把它作为 `Hpmcu=` 项带进去。

简要流程如下：

1. **`build_uboot()` 判断是否需要构建 MCU**

   在构建 U-Boot 时，如果同时满足：

   - `RK_ENABLE_FASTBOOT=y`
   - `RK_UBOOT_RKBIN_MCU_CFG` 非空

   就会先执行：

   ```bash
   build_mcu $RK_UBOOT_RKBIN_MCU_CFG "__MCU_CONTINUE__"
   ```

   你当前看的板级配置里，例如：

   - `RK_ENABLE_FASTBOOT=y`
   - `RK_UBOOT_RKBIN_MCU_CFG=rv1106_evb-SC3338-ADC`

   所以 U-Boot 构建前会先构建 MCU 固件。

2. **检查 MCU 源码目录是否存在**

   `build_mcu()` 首先检查：

   ```text
   SDK/luckfox-pico/sysdrv/source/mcu
   ```

   如果不存在，就提示忽略并退出。

3. **检查 / 下载 RISC-V GCC 工具链**

   MCU 工程使用的是 RISC-V 工具链。脚本检查：

   ```text
   sysdrv/source/mcu/prebuilts/gcc
   ```

   如果不存在，会自动创建目录并从 GitHub 下载：

   ```text
   xpack-riscv-none-embed-gcc-10.2.0-1.2-linux-x64.tar.gz
   ```

   下载后解压到：

   ```text
   sysdrv/source/mcu/prebuilts/gcc/linux-x86/riscv64
   ```

4. **解析传入的 MCU 板级配置名**

   `build_mcu()` 的第一个参数来自：

   ```text
   RK_UBOOT_RKBIN_MCU_CFG
   ```

   当前板级配置是：

   ```text
   rv1106_evb-SC3338-ADC
   ```

   脚本会在 `sysdrv/source/mcu` 下查找同名目录。如果能找到，就把它作为 `build_opt` 传给 MCU 子构建脚本。

5. **调用 MCU 子工程 `build.sh lunch` 选择配置**

   接着执行：

   ```text
   sysdrv/source/mcu/build.sh lunch rv1106_evb-SC3338-ADC
   ```

   MCU 子脚本的 `lunch` 流程会进入：

   ```text
   sysdrv/source/mcu/rt-thread/bsp/rockchip/rv1106-mcu
   ```

   然后根据 `board/rv1106_evb-SC3338-ADC/defconfig`：

   - 拷贝为 `.config`
   - 执行 `scons --useconfig=...`
   - 生成 / 更新 RT-Thread 配置，例如 `rtconfig.h`

6. **清理 MCU 构建产物**

   顶层 `build_mcu()` 随后调用：

   ```text
   sysdrv/source/mcu/build.sh clean
   ```

   MCU 子脚本里会：

   - 重新选择默认 / 当前板级配置
   - 执行 `scons -c`
   - 删除 MCU 子工程自己的 `output/image` 和 `output/out`

7. **正式编译 RT-Thread MCU 固件**

   然后创建顶层 MCU 输出目录：

   ```text
   SDK/luckfox-pico/output/out/mcu_out
   ```

   并执行：

   ```text
   sysdrv/source/mcu/build.sh all SDK/luckfox-pico/output/out/mcu_out
   ```

   MCU 子脚本的 `build_all()` 会：

   - `choose_default_board`
   - 执行：

     ```text
     scons -C sysdrv/source/mcu/rt-thread/bsp/rockchip/rv1106-mcu -j${RK_JOBS}
     ```

   - 编译生成：

     ```text
     sysdrv/source/mcu/rt-thread/bsp/rockchip/rv1106-mcu/rtthread.bin
     ```

   - 调用 `build_firmware` 把 `rtthread.bin` 复制到：

     ```text
     SDK/luckfox-pico/output/out/mcu_out/rtthread.bin
     ```

8. **返回 `build_uboot()` 继续构建 U-Boot**

   因为顶层调用时第二个参数是：

   ```text
   __MCU_CONTINUE__
   ```

   所以 `build_mcu()` 编译完成后不会 `exit 0`，而是 `return` 回 `build_uboot()`。

9. **把 MCU 固件写入 U-Boot rkbin overlay ini**

   回到 `build_uboot()` 后，脚本会根据启动介质选择基础 ini：

   - `emmc` → `RV1106MINIALL_EMMC_TB.ini`
   - `sd_card` → `RV1106MINIALL_SDMMC_TB.ini`
   - `spi_nor` → `RV1106MINIALL_SPI_NOR_TB.ini`
   - `spi_nand` / `slc_nand` → `RV1106MINIALL_SPI_NAND_TB.ini`

   你当前配置是：

   ```text
   RK_BOOT_MEDIUM=spi_nand
   ```

   所以会选：

   ```text
   sysdrv/source/uboot/rkbin/RKBOOT/RV1106MINIALL_SPI_NAND_TB.ini
   ```

   然后生成 overlay ini：

   ```text
   SDK/luckfox-pico/output/out/fastboot/rk_uboot_rkbin_rkboot_overlay.ini
   ```

   并把其中的：

   ```text
   Hpmcu=
   ```

   改成：

   ```text
   Hpmcu=SDK/luckfox-pico/output/out/mcu_out/rtthread.bin
   ```

10. **正式执行 U-Boot 构建**

   最后 `build_uboot()` 执行：

   ```text
   make uboot -C sysdrv \
     UBOOT_CFG=${RK_UBOOT_DEFCONFIG} \
     UBOOT_CFG_FRAGMENT=${RK_UBOOT_DEFCONFIG_FRAGMENT} \
     SYSDRV_UBOOT_RKBIN_OVERLAY_INI=${uboot_rkbin_ini}
   ```

   这样 U-Boot / rkbin 打包时就会把前面构建出的 MCU 固件作为 `Hpmcu` 一起处理。

总结一下：

```text
build_uboot()
  └─ 判断 fastboot + RK_UBOOT_RKBIN_MCU_CFG
      └─ build_mcu(rv1106_evb-SC3338-ADC, __MCU_CONTINUE__)
          ├─ 检查 sysdrv/source/mcu
          ├─ 准备 RISC-V GCC 工具链
          ├─ mcu/build.sh lunch rv1106_evb-SC3338-ADC
          ├─ mcu/build.sh clean
          ├─ mcu/build.sh all output/out/mcu_out
          └─ 生成 output/out/mcu_out/rtthread.bin
      └─ 修改 rkbin overlay ini 的 Hpmcu=rtthread.bin
  └─ make uboot ...
```

核心产物是：

```text
SDK/luckfox-pico/output/out/mcu_out/rtthread.bin
```

它最终会通过 U-Boot rkbin ini 的 `Hpmcu=` 字段被打包进启动相关镜像中。

