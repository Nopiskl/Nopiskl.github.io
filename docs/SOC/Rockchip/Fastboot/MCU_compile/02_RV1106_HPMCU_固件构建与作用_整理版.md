# RV1106 HPMCU 固件（rv1106_hpmcu_tb_sc3336_sc3338_v1.91.bin）分析整理版

## 原始问题

**SDK/luckfox-pico/sysdrv/source/uboot/rkbin/bin/rv11/rv1106_hpmcu_tb_sc3336_sc3338_v1.91.bin**  
**帮我结合 SDK 的构建和打包流程分析一下，这个 MCU 固件是怎么被构建的，有什么用；如果参考了源码，把源码重要部分也发来。**

---

## 说明

这份文档是**根据你提供的 AI 答案原文整理**出来的，目的是把结构理顺，方便你后续直接保存、转发或继续深挖。  
这里保留了原答案中的核心判断、构建链路、打包位置、用途说明和关键源码片段。

---

## 整体结论

这颗 `rv1106_hpmcu_tb_sc3336_sc3338_v1.91.bin` 本质上是 **RV1106 上运行在 HPMCU / RISC-V 小核上的 RT-Thread 固件**，主要用于 **相机 thunder boot / fastboot** 场景。

它的核心用途不是“通用 MCU 控制”，而是：

- 在 Linux 接管前，先把 **sensor**
- **ISP**
- **首帧 AE/AWB**
- 部分 **ISP 参数**
- **共享内存数据**

提前准备好，从而让 Linux 接力后更快出图，减少：

- 首帧慢
- 首帧偏暗
- 启动首帧不稳定

从整理结果看：

- `rkbin/bin/...v1.91.bin` 本身是一个**预编译成品**
- 但如果你走 Luckfox 的完整 SDK 构建链，系统也支持：
  - 从源码重新编出 `rtthread.bin`
  - 再在 U-Boot 打包阶段把 `Hpmcu=` 替换成这个新编出来的固件

---

## 这个 MCU 固件是怎么被构建的

### 1. 板级配置先打开 fastboot，并指定 MCU 配置

例如板级配置里会有类似内容：

```make
RK_ENABLE_FASTBOOT=y
RK_UBOOT_RKBIN_MCU_CFG=rv1106_evb-SC3338-ADC
```

含义是：

- 启用 fastboot / thunderboot 相关流程
- 指定 MCU 侧使用哪套板级配置去编 RT-Thread 固件

---

### 2. 顶层 `project/build.sh` 在构建 U-Boot 前先调用 `build_mcu()`

整理结果指出：

- 顶层 `project/build.sh` 在构建 U-Boot 时
- 如果发现 `RK_ENABLE_FASTBOOT=y`
- 且 `RK_UBOOT_RKBIN_MCU_CFG` 已设置
- 就会优先执行 `build_mcu()`

也就是：

**先编 MCU 固件，再打包 U-Boot / loader。**

---

### 3. `build_mcu()` 会准备 RISC-V 工具链并调用 MCU 子构建脚本

整理结果给出的链路是：

1. 准备 `riscv-none-embed-gcc`
2. 执行：
   - `sysdrv/source/mcu/build.sh lunch rv1106_evb-SC3338-ADC`
3. 再执行清理
4. 再执行：
   - `all output/out/mcu_out`

这说明 MCU 固件并不是简单复制一个 bin，而是支持按板级配置重新构建。

---

### 4. MCU 实际是通过 RT-Thread BSP 用 `scons` 编译出来的

核心构建点是：

- 目标 BSP：
  - `rt-thread/bsp/rockchip/rv1106-mcu`
- 产物：
  - `rtthread.bin`

并且该产物还会复制到：

- `output/image/rtthread.bin`

也就是说，**最终 MCU 固件的源码构建核心其实是 RT-Thread BSP。**

---

## U-Boot 打包阶段是怎么用它的

### 1. 打包时不会死用 `rkbin/bin/...v1.91.bin`

整理结果说明：

- U-Boot 打包阶段会临时生成一个 overlay ini
- 然后把其中的 `Hpmcu=` 改成刚刚编好的：
  - `output/out/mcu_out/rtthread.bin`

这意味着：

- 如果你只看 `rkbin/bin/...v1.91.bin`，它像是固定预编译文件
- 但走 Luckfox 完整构建链时，**更常见的是“源码重编 + 打包替换”**

---

### 2. loader 里的三段内容

默认 fastboot ini 里，大致顺序为：

```ini
[LOADER_OPTION]
NUM=3
LOADER1=FlashData
LOADER2=Hpmcu
LOADER3=FlashBoot

FlashData=bin/rv11/rv1106_ddr_924MHz_tb_v1.15.bin
Hpmcu=bin/rv11/rv1106_hpmcu_tb_sc3336_sc3338_v1.91.bin
FlashBoot=bin/rv11/rv1106_spl_spi_nor_tb_v1.00.bin
```

可以理解为：

- `LOADER1 = FlashData`
  - DDR 初始化相关 bin
- `LOADER2 = Hpmcu`
  - 这颗 MCU 固件
- `LOADER3 = FlashBoot`
  - SPL

因此，这颗 MCU 固件在打包镜像里属于一个**独立 loader 段**，位置在 DDR 初始化之后、SPL 之前或并列于前级打包项中使用。

---

## 它到底有什么用

根据整理结果，这个 MCU 固件主要做下面 5 类事情。

### 1. 读取 U-Boot 放入 meta 区 / 内存里的启动信息

包括：

- 启动参数
- IQ bin
- sensor init 信息

相关源码位置在整理结果中提到：

- `rk_meta.c`
- `fast_ae.c`

这一步相当于让 MCU 侧先拿到后续相机快速启动需要的上下文。

---

### 2. 按板级配置初始化 camera / sensor / ISP

例如当前公开 BSP 更直接对应的是：

- `rv1106_evb-SC3338-ADC`

相关配置项示例：

```config
CONFIG_RT_USING_ISP3=y
CONFIG_RT_USING_CAMERA=y
CONFIG_RT_USING_SC3338=y
CONFIG_RT_USING_RK_BATTERY_IPC=y
```

这表示 MCU 固件会按板级配置启用：

- ISP
- Camera
- 对应 sensor 驱动
- 与 Linux / AP 侧通信所需机制

---

### 3. 先设置首帧 AE 和一批 ISP 参数，再开流

入口函数整理结果提到了：

- `set_firstae()`
- `isp_stream()`

也就是说，它不是等 Linux 完整起来后才做首帧曝光控制，而是在 MCU 侧提前完成一部分首帧图像质量准备。

---

### 4. 在 MCU 侧跑 fast AE，直到 AE 收敛或达到上限

整理结果给出的逻辑是：

- MCU 先拉起预览流
- 连续抓几帧
- 判断 AE 是否收敛
- 若收敛或超范围就退出
- 然后把曝光 / 增益 / ISP 参数写入共享内存 `shared_data`

这样 Linux 接手时，就不是“冷启动、从零调 AE”，而是拿到一个已经接近稳定的初始状态。

---

### 5. Linux 侧以 thunderboot 模式接管，避免重复完整初始化

例如 SC3338 驱动侧会：

- 跳过 sensor id check
- 对 reset / pwdn GPIO 使用 `GPIOD_ASIS`
- 保持当前硬件状态

这说明 thunderboot 模式的思想就是：

**MCU 先把现场搭好，Linux 直接接着跑，而不是重新上电、重新全流程初始化。**

---

## 关键判断：它是预编译固件，还是源码生成？

**准确答案是两者都存在，但分场景。**

### 只看 `rkbin`
如果你只看：

- `rkbin/bin/rv11/rv1106_hpmcu_tb_sc3336_sc3338_v1.91.bin`

那么它就是一个：

- **Rockchip 发布的预编译 MCU 成品**

### 走 Luckfox 完整 SDK 构建
如果你走整套工程构建，那么更常见的是：

1. 从 RT-Thread BSP 源码重新编出 `rtthread.bin`
2. 打包时把 `Hpmcu=` 替换成新的 `rtthread.bin`

所以更准确的说法应是：

> **这个 bin 可以作为预编译成品直接用；但在 Luckfox SDK 完整构建链里，也支持从源码重编后再替换进打包流程。**

---

## 关键源码整理

### 1. 顶层构建时先编 MCU，再替换 `Hpmcu=`

```sh
# project/build.sh
if [ "$RK_ENABLE_FASTBOOT" = "y" -a -n "$RK_UBOOT_RKBIN_MCU_CFG" ]; then
    uboot_rkbin_ini=$RK_PROJECT_PATH_FASTBOOT/rk_uboot_rkbin_rkboot_overlay.ini
    build_mcu $RK_UBOOT_RKBIN_MCU_CFG "__MCU_CONTINUE__"
    ...
    if [ -f "$RK_PROJECT_FILE_SYSDRV_MCU_BIN" ]; then
        __modify_file $tempfile $uboot_rkbin_ini "Hpmcu=" "$RK_PROJECT_FILE_SYSDRV_MCU_BIN" "^"
    fi
fi
```

这段逻辑体现的是：

- 先 build MCU
- 再把打包配置中的 `Hpmcu=` 动态改成新产物

---

### 2. MCU 自己的构建核心其实是 RT-Thread `scons`

```sh
# sysdrv/source/mcu/project/build.sh
choose_default_board
scons -C ${SDK_ROOT_DIR}/rt-thread/bsp/rockchip/rv1106-mcu -j${RK_JOBS}
cp -rfa ${SDK_ROOT_DIR}/rt-thread/bsp/rockchip/rv1106-mcu/rtthread.bin ${RK_PROJECT_OUTPUT_IMAGE}
```

核心含义：

- 编译的是 `rv1106-mcu` 这个 BSP
- 产物就是 `rtthread.bin`

---

### 3. 打包 ini 中 `Hpmcu` 是 loader 第二段

```ini
[LOADER_OPTION]
NUM=3
LOADER1=FlashData
LOADER2=Hpmcu
LOADER3=FlashBoot
FlashData=bin/rv11/rv1106_ddr_924MHz_tb_v1.15.bin
Hpmcu=bin/rv11/rv1106_hpmcu_tb_sc3336_sc3338_v1.91.bin
FlashBoot=bin/rv11/rv1106_spl_spi_nor_tb_v1.00.bin

[LOADER2_PARAM]
LOAD_ADDR=0x40000
FLAG=0x10007
```

这说明在 loader 视角里，这颗 bin 的角色是：

- **Hpmcu 载荷**
- 具有固定的加载地址与标志配置

---

### 4. fast AE / AWB 核心算法库并非全开源源码

整理结果提到：

```python
# battery-ipc/SConscript
LIBS = ['libfastae_gcc.a','libfastawb_gcc.a']
```

这说明：

- 可见源码里有流程胶水层
- 但 AE / AWB 核心算法部分是预编译静态库
- 所以你能看到流程，不一定能看到完整算法实现

---

### 5. MCU 侧首帧流程核心示例

```c
// fast_ae.c
int32_t set_firstae(rk_device *isp, rk_device *sensor, struct shared_data *share, rt_sem_t *sem)
{
    parse_meta_params(&g_main_calib, &g_secondary_calib, &g_sensor_init,
                      &g_secondary_sensor_init, &g_app_param, &g_fastae_init);

    parse_ae_params(&g_main_calib, &g_fastae_init, g_iq_bin_mode);

    rt_device_control(sensor, RK_DEVICE_CTRL_CID_MATCH_CAM_CONFIG, &cam_config);

    set_ae_init(sensor, &g_fastae_init, &g_sensor_init);
    rt_device_control(sensor, RK_DEVICE_CTRL_CAMERA_SET_EXP_VAL, &gInitExp.exp);

    set_bay3d_params_for_rtt(&isp_params.params.bay3d,
                             subdev->info.mbus_fmt.width,
                             subdev->info.mbus_fmt.height);
    set_params(isp, &isp_params);
}
```

这段反映了：

- 先解析 meta / AE 初始化参数
- 再把首帧 AE 与 ISP 参数下发给 sensor / ISP

---

### 6. MCU 侧开流并等待 AE 收敛

```c
// stream.c
ret = start_stream(dev, param);
...
do {
    ret = stream_mode_preview(dev, true, share);
    if (isae_match() || isae_over_range())
        break;
} while (share->frame_num < fastae_max_run_frame);

stop_stream(dev, param, is_normal);
```

这段逻辑很关键，它解释了为什么这颗固件能改善首帧体验：

- 不是只配置不跑
- 而是真的开流跑几帧，直到 AE 收敛或达到上限

---

### 7. U-Boot 将 meta / IQ 数据搬给 MCU

```c
// rk_meta.c
memcpy((void *)(meta_p->load + SENSOR_IQ_BIN_OFFSET), data, meta_p->iq_item_size);
...
meta_p->meta_flags = META_READ_DONE_FLAG;
flush_cache(meta_p->load, meta_p->size);
rk_meta_process();
```

这说明：

- U-Boot 负责把相机相关数据准备到共享区域
- 然后再通知 MCU 进入处理流程

---

### 8. Linux 驱动以 thunderboot 状态接管

```c
// sc3338.c
if (sc3338->is_thunderboot) {
    dev_info(dev, "Enable thunderboot mode, skip sensor id check\n");
    return 0;
}

sc3338->is_thunderboot = IS_ENABLED(CONFIG_VIDEO_ROCKCHIP_THUNDER_BOOT_ISP);
sc3338->reset_gpio = devm_gpiod_get(dev, "reset",
                    sc3338->is_thunderboot ? GPIOD_ASIS : GPIOD_OUT_LOW);
```

这段说明：

- thunderboot 模式下 Linux 驱动会尽量保留现场
- 避免重新折腾 sensor 硬件状态

---

## 一个需要特别注意的点

整理结果中特别提醒了一点：

当前 Luckfox 公开 MCU BSP 里，能直接一键对应上的板级配置更偏向：

- `rv1106_evb-SC3338-ADC`

而不是一个现成的：

- `...SC3336...`

所以需要注意：

1. `rv1106_hpmcu_tb_sc3336_sc3338_v1.91.bin` 是 Rockchip 发布时的成品命名
2. 当前 SDK 公开源码里，更容易直接对上的是 **SC3338** 这支
3. `SC3336` 驱动可能有源码，但未必有完全同名、现成可直接 lunch 的 defconfig

这意味着：

- “bin 文件命名覆盖了 SC3336/SC3338”
- 不等于“公开 SDK 中已经完整给出一套 SC3336 一键重编配置”

---

## 最后一句话总结

这颗 `rv1106_hpmcu_tb_sc3336_sc3338_v1.91.bin` 可以把它理解成：

> **一个运行在 RV1106 HPMCU/RISC-V 小核上的 RT-Thread 相机快速启动固件。**

它在系统启动早期负责：

- 读取 meta / IQ / sensor 初始化数据
- 初始化 sensor / ISP
- 跑几帧 fast AE / AWB
- 把结果写进共享内存
- 然后让 Linux 以 thunderboot 模式快速接管

所以它的本质作用是：

**缩短相机首帧启动时间，并改善首帧曝光效果。**
