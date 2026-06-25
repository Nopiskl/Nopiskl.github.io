# 全志 A733 Fastboot 分析总结

本文整理当前 SDK 中关于全志 Android fastboot 的源码位置、运行阶段、进入流程、命令处理路径，以及 `misc` 分区缺失对 fastboot/recovery 入口的影响。

当前重点对象：

- SoC/平台：A733 / sun55iw3p1
- 板级配置：`x733mhn_aic8800`
- 系统类型：Buildroot
- U-Boot：`brandy/brandy-2.0/u-boot-2018`
- Kernel：`kernel/linux-6.6`
- 分区表：`device/config/chips/a733/configs/x733mhn_aic8800/buildroot/sys_partition.fex`

## 1. 核心结论

1. 设备进入当前 SDK 的 bootloader fastboot 后，**可以认为设备仍然运行在 U-Boot proper 中**。

   这里的 fastboot 不是 Linux kernel 中的功能，也不是 Buildroot 用户态中的 `fastboot` 工具，而是 U-Boot 里实现的 USB device 协议服务端。

2. 当前 SDK 的全志 fastboot 主实现位于：

   ```text
   brandy/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_fastboot.c
   ```

3. U-Boot fastboot 命令入口位于：

   ```text
   brandy/brandy-2.0/u-boot-2018/cmd/cmd_fastboot.c
   ```

4. 当前工程里同时保留了上游 U-Boot 标准 fastboot 框架：

   ```text
   brandy/brandy-2.0/u-boot-2018/drivers/fastboot/
   brandy/brandy-2.0/u-boot-2018/drivers/usb/gadget/f_fastboot.c
   ```

   但当前配置主要走的是 **全志自有 `sunxi_usb` fastboot 路径**，不是标准 USB gadget `f_fastboot` 路径。

5. Linux 6.6 内核中没有找到 Android fastboot 协议服务端。内核里搜到的 `fastboot` 大多是 F2FS、DRM、reboot-mode 或其它同名概念。

6. 当前 `x733mhn_aic8800/buildroot/sys_partition.fex` 没有定义 `misc` 分区。这不会影响正常启动，也不影响已经进入 U-Boot fastboot 后刷写普通分区，但会影响 `reboot bootloader`、`reboot recovery`、`fastboot reboot-fastboot` 等依赖 `misc` 的标准 Android 启动模式切换路径。

## 2. 当前 fastboot 是否运行在 U-Boot 中

答案：**是的，对当前 SDK 的 bootloader fastboot 来说，设备仍然在 U-Boot 中。**

更准确地说：

```text
BootROM / boot0 / SPL
    ↓
U-Boot proper
    ↓
执行 fastboot 命令
    ↓
注册全志 USB fastboot device
    ↓
PC 端 fastboot 工具通过 USB 与 U-Boot 通信
```

此时 Linux kernel 没有启动，rootfs 也没有挂载。PC 端执行：

```sh
fastboot devices
fastboot getvar all
fastboot flash boot boot.img
fastboot flash rootfs rootfs.img
fastboot reboot
```

实际通信对象是 U-Boot 中的 `usb_fastboot.c` 状态机。

需要特别区分：

```text
fastboot / reboot-bootloader
    通常指 bootloader fastboot，也就是 U-Boot fastboot。

fastboot reboot-fastboot
    Android 新语义中通常指 userspace fastbootd / recovery fastboot。
    当前 U-Boot 代码中会尝试写 misc: recovery\n--fastboot，然后重启到 recovery。
```

当前工程没有确认存在完整 recovery fastbootd 服务端；只看到 U-Boot 侧有 `reboot-fastboot` 的跳转动作。

## 3. 关键源码位置

### 3.1 U-Boot fastboot 命令入口

```text
brandy/brandy-2.0/u-boot-2018/cmd/cmd_fastboot.c
```

关键逻辑：

```c
if (sunxi_usb_dev_register(3) < 0) {
    printf("usb fastboot fail: not support sunxi fastboot\n");
    return -1;
}

sunxi_usb_main_loop(0);
```

这里的 `3` 对应：

```text
brandy/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_module.h
```

```c
#define SUNXI_USB_DEVICE_FASTBOOT 3
```

### 3.2 全志 fastboot 协议实现

```text
brandy/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_fastboot.c
```

核心函数：

```c
sunxi_fastboot_init()
sunxi_fastboot_state_loop()
__try_to_download()
__flash_to_part()
__flash_to_mbr()
__flash_to_boot0()
__flash_to_uboot()
__get_var()
__oem_operation()
__fastboot_reboot()
```

模块注册位置：

```c
sunxi_usb_module_init(SUNXI_USB_DEVICE_FASTBOOT,
                      sunxi_fastboot_init,
                      sunxi_fastboot_exit,
                      sunxi_fastboot_reset,
                      sunxi_fastboot_standard_req_op,
                      sunxi_fastboot_nonstandard_req_op,
                      sunxi_fastboot_state_loop,
                      sunxi_fastboot_usb_rx_dma_isr,
                      sunxi_fastboot_usb_tx_dma_isr);
```

### 3.3 全志 USB device 框架

```text
brandy/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_base_common.c
brandy/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_base_platform.c
brandy/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_module.h
```

`sunxi_usb_dev_register(3)` 会注册 fastboot device。

`sunxi_usb_main_loop()` 会不断调用当前 USB device 的 `state_loop()`：

```c
ret = sunxi_udev_active->state_loop(&sunxi_ubuf);
```

对 fastboot 来说，这个 `state_loop()` 就是 `sunxi_fastboot_state_loop()`。

### 3.4 bootcmd / bootmode 判断

```text
brandy/brandy-2.0/u-boot-2018/board/sunxi/board_helper.c
brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c
brandy/brandy-2.0/u-boot-2018/include/spare_head.h
```

fastboot boot flag：

```c
#define SUNXI_FASTBOOT_FLAG (0x5F)
```

U-Boot 根据 ADC key、RTC flag、misc 内容判断启动模式，然后可能把 `boot_normal` 替换成 `boot_fastboot`。

### 3.5 A733 当前环境变量

```text
device/config/chips/a733/configs/x733mhn_aic8800/buildroot/env.cfg
```

关键配置：

```text
boot_normal=sunxi_flash read 4007f800 ${boot_partition};bootm 0x4007f800
boot_fastboot=fastboot
bootcmd=run setargs_nand boot_normal
```

如果 U-Boot 判断当前要进入 fastboot，就会把默认 `bootcmd` 中的 `boot_normal` 替换为 `boot_fastboot`，最终执行 `fastboot` 命令。

### 3.6 Linux/Android 用户态 reboot 入口

```text
platform/thirdparty/libs/libcutils/src/android_reboot.c
platform/thirdparty/libs/libcutils/src/misc_rw.c
```

`ANDROID_RB_RESTART2` 时会：

```c
write_misc(arg);
reboot(RB_AUTOBOOT);
```

`write_misc()` 写入：

```text
/dev/block/by-name/misc
```

这就是 Android 标准的通过 `misc` 分区传递 bootloader/recovery 请求的机制。

## 4. 全志 fastboot 进入流程

### 4.1 从 Linux/Android 用户态进入

典型命令：

```sh
reboot bootloader
adb reboot bootloader
```

设计流程：

```text
Linux/Android 用户态
    ↓
android_reboot.c
    ↓
write_misc("bootloader")
    ↓
写 /dev/block/by-name/misc
    ↓
重启
    ↓
U-Boot 读取 misc
    ↓
发现 command 包含 bootloader
    ↓
设置 SUNXI_FASTBOOT_FLAG
    ↓
bootcmd: boot_normal -> boot_fastboot
    ↓
执行 fastboot
```

但当前 `x733mhn_aic8800/buildroot/sys_partition.fex` 没有 `misc` 分区，所以这条路径在当前 SDK 中不完整。

### 4.2 从 RTC bootmode flag 进入

U-Boot 会读取 RTC bootmode flag：

```c
bootmode_flag = rtc_get_bootmode_flag();
rtc_set_bootmode_flag(0);
```

如果读取到 `SUNXI_FASTBOOT_FLAG`，也会进入 fastboot。

全志 fastboot 中的 `fastboot reboot-bootloader` 就是走这个机制：

```c
__fastboot_reboot(SUNXI_FASTBOOT_FLAG);
```

`__fastboot_reboot()` 调用：

```c
sunxi_board_restart(word_mode);
```

而 `sunxi_board_restart()` 会：

```c
rtc_set_bootmode_flag(next_mode);
reset_cpu(0);
```

所以只要已经进入过 U-Boot fastboot，执行：

```sh
fastboot reboot-bootloader
```

通常仍可再次回到 U-Boot fastboot，即使没有 `misc` 分区。

### 4.3 从按键进入

`board_helper.c` 中存在 fastboot key 映射：

```c
{"fastboot", SUNXI_FASTBOOT_FLAG}
```

如果板级 ADC key 或相关配置触发 fastboot，也不依赖 `misc`。

### 4.4 从 U-Boot 命令行进入

如果能进入 U-Boot console，可以直接执行：

```text
fastboot
```

这会直接进入全志 U-Boot fastboot。

## 5. U-Boot fastboot 命令处理流程

真正的命令分发在：

```text
brandy/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_fastboot.c
```

状态机核心：

```text
SUNXI_USB_FASTBOOT_IDLE
    等待 USB RX 收到 PC fastboot 命令

SUNXI_USB_FASTBOOT_SETUP
    解析命令字符串并分发

SUNXI_USB_FASTBOOT_RECEIVE_DATA
    接收 download 阶段传来的镜像数据

完成后返回 OKAY / FAIL
```

### 5.1 reboot 类命令

```text
reboot-bootloader
    -> __fastboot_reboot(SUNXI_FASTBOOT_FLAG)
    -> 写 RTC bootmode flag
    -> reset
    -> 下次仍进 U-Boot fastboot

reboot
    -> __fastboot_reboot(0)
    -> 普通重启

reboot-fastboot
    -> 尝试写 misc: recovery\n--fastboot
    -> __fastboot_reboot(SUNXI_BOOT_RECOVERY_FLAG)
    -> 目标是进入 recovery/userspace fastbootd
```

注意：当前没有 `misc` 分区时，`reboot-fastboot` 路径会找不到 misc，无法完成写入。

### 5.2 download / flash

PC 端执行：

```sh
fastboot flash boot boot.img
```

实际协议通常是：

```text
download:<size>
    ↓
U-Boot 接收镜像到 trans_data.base_recv_buffer
    ↓
flash:boot
    ↓
U-Boot 将 buffer 写到 boot 分区
```

全志实现对 `flash:` 做了特殊分发：

```text
flash:u-boot / flash:toc1
    -> __flash_to_uboot()

flash:boot0 / flash:toc0
    -> __flash_to_boot0()

flash:mbr
    -> __flash_to_mbr()

其它分区
    -> __flash_to_part()
```

这点很重要：全志 fastboot 不仅能刷普通分区，还支持刷全志启动链相关对象：

```text
mbr
boot0 / toc0
u-boot / toc1
```

### 5.3 erase

```text
erase:<partition>
    -> __fastboot_erase_part()
```

目标分区必须存在于分区表中。

### 5.4 getvar

```text
getvar:<name>
    -> __get_var()
```

支持的典型变量：

```text
version
product
serialno
downloadsize
secure
max-download-size
partition-type:<name>
```

如果当前没有 `misc` 分区：

```sh
fastboot getvar partition-type:misc
```

会失败或返回 partition not found。

### 5.5 oem / flashing

```text
oem lock
oem unlock
flashing lock
flashing unlock
oem efex
```

入口：

```c
__oem_operation()
```

涉及：

```text
secure mode 判断
FRP unlock ability
fastboot_status_flag
device_unlock
擦除 userdata / metadata
AVB/vbmeta 检查
```

这些逻辑不直接依赖 `misc`，但依赖相关分区和 secure storage 支持。

## 6. 当前 sys_partition.fex 没有 misc 的影响

当前文件：

```text
device/config/chips/a733/configs/x733mhn_aic8800/buildroot/sys_partition.fex
```

实际分区：

```text
boot-resource
env
boot
rootfs
private
```

`recovery` 当前被注释，`misc` 没有定义。

### 6.1 不影响的部分

1. 正常启动不受影响。

   U-Boot 找不到 misc 时会打印：

   ```text
   no misc partition is found
   ```

   然后返回 0，继续默认启动流程。

2. 已经进入 U-Boot fastboot 后，刷已有分区不受 `misc` 缺失影响。

   例如：

   ```sh
   fastboot flash boot boot.img
   fastboot flash rootfs rootfs.img
   fastboot flash u-boot xxx
   fastboot flash boot0 xxx
   fastboot reboot
   fastboot reboot-bootloader
   ```

   其中 `reboot-bootloader` 走 RTC flag，不依赖 misc。

3. U-Boot console 手动执行 `fastboot` 不受影响。

4. 按键或 RTC flag 进入 fastboot 不受影响。

### 6.2 会受影响的部分

1. Linux/Android 下执行：

   ```sh
   reboot bootloader
   adb reboot bootloader
   ```

   预期是写 `misc` 后重启进入 U-Boot fastboot。没有 `misc` 时，写入失败，通常会退化成普通重启。

2. Linux/Android 下执行：

   ```sh
   reboot recovery
   adb reboot recovery
   ```

   同样依赖 misc，当前不完整。

3. U-Boot fastboot 中执行：

   ```sh
   fastboot reboot-fastboot
   ```

   代码会尝试写 `misc` 中的：

   ```text
   recovery
   --fastboot
   ```

   没有 `misc` 时会失败，且当前代码看起来没有优雅返回 `FAIL` 给 PC，可能表现为 host 端命令卡住或失败不明显。

4. recovery/sysrecovery/factory/efex 等通过 `misc` 传递的启动请求会缺失。

5. 以下 fastboot 操作会失败：

   ```sh
   fastboot flash misc misc.img
   fastboot erase misc
   fastboot getvar partition-type:misc
   ```

## 7. 是否建议增加 misc 分区

取决于产品目标。

### 7.1 可以不加 misc 的情况

如果产品只需要：

```text
正常启动
U-Boot console 手动进 fastboot
按键进 fastboot
RTC flag 进 fastboot
SWUpdate 在 Linux 下直接更新 boot0/u-boot/rootfs
量产工具或调试工具直接处理烧录
```

那么没有 `misc` 可以接受。它不是当前启动链的硬性依赖。

### 7.2 建议加 misc 的情况

如果需要这些 Android 风格能力：

```text
reboot bootloader
adb reboot bootloader
reboot recovery
adb reboot recovery
fastboot reboot-fastboot
recovery command
OTA/recovery 通过 bootloader_message 传参
标准 Android bootloader_message 机制
```

建议添加 `misc` 分区。

### 7.3 推荐分区示例

可以在 `env` 后、`boot` 前增加：

```ini
[partition]
    name         = misc
    size         = 32768
    user_type    = 0x8000
```

`32768` sector 等于 16 MiB，符合全志分区表注释里“分区大小最好 16M 对齐”的习惯。

注意：增加分区会改变后续分区偏移，必须同步确认：

```text
量产镜像
pack 输出
rootfs 中 /dev/block/by-name/misc
SWUpdate 分区更新逻辑
OTA 包
boot0/u-boot 是否依赖固定分区偏移
```

不能只改一个 `sys_partition.fex` 就认为完成。

## 8. 当前 SDK fastboot 主链路图

```text
方式 A：系统侧请求

Linux/Android 用户态
    ↓
reboot bootloader
    ↓
android_reboot.c
    ↓
write_misc("bootloader")
    ↓
/dev/block/by-name/misc
    ↓
重启
    ↓
U-Boot board_helper.c 读取 misc
    ↓
SUNXI_FASTBOOT_FLAG
    ↓
bootcmd: boot_normal -> boot_fastboot
    ↓
boot_fastboot=fastboot
    ↓
cmd_fastboot.c
    ↓
sunxi_usb_dev_register(3)
    ↓
sunxi_usb_main_loop()
    ↓
usb_fastboot.c / sunxi_fastboot_state_loop()

当前问题：
    x733mhn_aic8800/buildroot/sys_partition.fex 没有 misc，
    所以方式 A 不完整。
```

```text
方式 B：U-Boot/RTC/按键请求

RTC bootmode flag 或 fastboot key
    ↓
U-Boot board_helper.c
    ↓
SUNXI_FASTBOOT_FLAG
    ↓
bootcmd: boot_normal -> boot_fastboot
    ↓
boot_fastboot=fastboot
    ↓
进入 U-Boot fastboot

这个方式不依赖 misc。
```

```text
方式 C：U-Boot console

U-Boot 命令行
    ↓
fastboot
    ↓
cmd_fastboot.c
    ↓
sunxi_usb_dev_register(3)
    ↓
sunxi_usb_main_loop()
    ↓
usb_fastboot.c

这个方式不依赖 misc。
```

## 9. 和 SWUpdate / boot0 / u-boot 更新的关系

当前 fastboot 分析对 SWUpdate 更新 boot0/u-boot 有几个参考意义：

1. 全志 fastboot 中已经有 boot0/toc0、u-boot/toc1 的刷写逻辑。

   相关函数：

   ```text
   __flash_to_boot0()
   __flash_to_uboot()
   ```

2. 这些函数不是简单写普通分区，而是调用全志启动链相关接口，例如：

   ```text
   sunxi_sprite_download_boot0()
   sunxi_sprite_download_uboot()
   sunxi_flash_write_end()
   sunxi_flash_flush()
   ```

3. 如果 SWUpdate 要在 Linux 下更新 boot0/u-boot，不能只按普通 block 分区写入思路理解。需要参考全志 fastboot 或 sprite 对 boot0/u-boot 的处理方式，尤其是：

   ```text
   boot0/toc0 magic 校验
   toc1/sunxi-package 校验
   secure boot 下 root cert 校验
   storage_data 保留/迁移
   NAND/eMMC/NOR 不同写入路径
   写完后的 flush/end 操作
   ```

4. `misc` 分区是否存在，与直接更新 boot0/u-boot 不是强绑定；但它影响系统重启到 bootloader/recovery 的控制链路。如果 SWUpdate 策略需要“升级后重启到 recovery/fastboot 做二阶段处理”，则建议补齐 `misc` 或改用 RTC bootmode flag 等其它机制。

## 10. 最终建议

1. 如果当前产品不需要 Android 标准 `adb reboot bootloader` / `reboot recovery`，可以暂时不加 `misc`，但文档中要明确该能力缺失。

2. 如果希望 fastboot/recovery 行为完整，建议在 `sys_partition.fex` 中增加 `misc` 分区，并同步验证：

   ```text
   /dev/block/by-name/misc 是否生成
   reboot bootloader 是否进入 U-Boot fastboot
   reboot recovery 是否进入 recovery
   fastboot reboot-bootloader 是否仍正常
   fastboot reboot-fastboot 是否有预期行为
   SWUpdate 分区偏移是否受影响
   ```

3. 当前 SDK 的 U-Boot fastboot 主实现以 `usb_fastboot.c` 为准。分析刷写 boot0/u-boot 时，应优先参考其中的 `__flash_to_boot0()` 和 `__flash_to_uboot()`，不要误以为 Buildroot 的 `android-tools/fastboot` 包就是板端 fastboot 实现。

4. 对 `fastboot reboot-fastboot` 建议做一次实机验证。若仍不添加 `misc`，可以考虑在 U-Boot 代码中对无 misc 的情况明确返回 `FAILno misc partition`，避免 PC 端表现不清晰。

