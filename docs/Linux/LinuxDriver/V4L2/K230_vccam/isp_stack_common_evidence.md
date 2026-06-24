# K230 Linux daemon 与 RTOS/MPP ISP 栈同源/同构证据

本文回答一个具体问题：

```text
为什么说 Linux V4L2 适配里的底层 ISP 控制思想、CamerIc IP driver、Binder/HAL、isp_drv，
和 RTOS/MPP 侧是同源或高度同构的？
```

结论先行：

```text
当前源码树里没有完整展开 Linux daemon 的 isp_media 源码，
也没有完整展开 RTOS/MPP userapps/src/vicap/src/isp/sdk/units/... 源码。

所以不能做“两个 .c 文件逐行 diff”这种源码级证明。

但可以通过：
    1. Linux 启动脚本源码
    2. RTOS/MPP 应用构建源码
    3. RTOS/MPP API 头文件源码
    4. RTOS sensor/kernel 设备源码
    5. Linux daemon 的符号和 debug source path
    6. RTOS/MPP 静态库的符号和 source path 字符串

证明它们使用的是同源或高度同构的一套 vendor ISP 控制栈。
```

最关键的一行对照是：

```text
Linux daemon:
    MediaIspGeSetCtrl
      -> CamerIcIspGeSetThreshold
      -> CamerIcIspWriteReg
      -> BinderHalWriteReg
      -> isp_drv_write_reg

RTOS/MPP:
    kd_mpi_submodule_control / kd_mpi_isp_ge_config
      -> CamerIcIspGeSetThreshold
      -> CamerIcIspWriteReg
      -> BinderHalWriteReg
      -> isp_drv_write_reg
```

这说明两边的入口层不同，但底层汇合到了相同的 CamerIc/Binder/isp_drv 栈。

## 1. Linux 侧明确使用 vvcam 模块加 isp_media_server

Linux rootfs 启动脚本中，先加载 vvcam 内核模块，再启动用户态 `isp_media_server`：

```sh
/* buildroot-overlay/board/canaan/k230-soc/rootfs_overlay/etc/init.d/S99canaanboot */

#!/bin/sh
bootddev=$(cat /proc/cmdline  | sed  -n  "s#root=\(\/dev\/mmcblk[0-9]\).*#\1#p" )

mount ${bootddev}p1 /boot
modprobe vvcam_isp
modprobe vvcam_mipi
modprobe vvcam_vb
modprobe vvcam_isp_subdev
modprobe vvcam_video
ISP_MEDIA_SENSOR_DRIVER=/usr/lib/libvvcam.so /usr/bin/isp_media_server > /dev/null 2> /tmp/isp.err.log &


vo_init &

cat /etc/version/release_version
```

Debian 包里的启动脚本也是同样结构：

```sh
/* buildroot-overlay/package/vvcam/deb/etc/vvcam/isp_start.sh */

#!/bin/bash
/etc/vvcam/S99adb_mtp  start
modprobe vvcam_isp
modprobe vvcam_mipi
modprobe vvcam_vb
modprobe vvcam_isp_subdev
modprobe vvcam_video
#ISP_MEDIA_SENSOR_DRIVER=/usr/lib/libvvcam.so
ISP_MEDIA_SENSOR_DRIVER=/lib/riscv64-linux-gnu/libvvcam.so /usr/bin/isp_media_server_debian  >/tmp/isp.err.log  2>&1 &
```

这说明 Linux V4L2 适配不是只靠内核驱动闭环，而是明确依赖用户态 `isp_media_server` / `isp_media_server_debian`。

## 2. Linux daemon 中出现完整 vendor ISP 栈符号

对 Linux daemon 查看符号：

```sh
nm -C buildroot-overlay/package/vvcam/isp_media_server_debian | rg \
"(MediaIspGeSetCtrl|MediaIspGeGetCtrl|CamerIcIspGeSetThreshold|CamerIcIspWriteReg|BinderHalWriteReg|isp_drv_write_reg|isp_write_reg|CamerIcIspReadReg|BinderHalReadReg|isp_drv_read_reg)"
```

输出：

```text
00000000001087ec T BinderHalReadReg
0000000000108786 T BinderHalWriteReg
00000000000ee650 T CamerIcIspGeSetThreshold
00000000000eb04a T CamerIcIspReadReg
00000000000eafe0 T CamerIcIspWriteReg
00000000000669f2 T MediaIspGeGetCtrl
0000000000066522 T MediaIspGeSetCtrl
000000000011ef8e T isp_drv_read_reg
000000000011efce T isp_drv_write_reg
000000000011d76a T isp_write_reg
```

这些名字已经暴露出 daemon 内部的分层：

```text
MediaIspGeSetCtrl / MediaIspGeGetCtrl
    用户态 media pipeline / module control 层。

CamerIcIspGeSetThreshold
    CamerIc ISP GE IP block driver 层。

CamerIcIspWriteReg / CamerIcIspReadReg
    CamerIc ISP 通用寄存器访问层。

BinderHalWriteReg / BinderHalReadReg
    HAL / binder 层。

isp_drv_write_reg / isp_drv_read_reg
    底层 ISP driver command 层。
```

这不是 Linux 主线 V4L2 subdev driver 常见的命名风格，而是 vendor ISP SDK 的典型分层。

## 3. Linux daemon 的 debug info 指向 isp_media 源码路径

`isp_media_server_debian` 带 debug info，可以用 `addr2line` 反推出原始文件名和行号：

```sh
addr2line -f -C -e buildroot-overlay/package/vvcam/isp_media_server_debian \
  0x0066522 0x00ee650 0x00eafe0 0x0108786 0x011efce
```

输出：

```text
MediaIspGeSetCtrl
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/mediacontrol/media_pipeline/media_isp/source/sub_module/ge/media_isp_ge_ctrl.c:109

CamerIcIspGeSetThreshold
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp_ge.c:149

CamerIcIspWriteReg
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp.c:2399

BinderHalWriteReg
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/binder/api/source/binder_hal_api.c:164

isp_drv_write_reg
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/isp_drv/source/isp_drv_cmd.c:781
```

这些路径里的关键词非常关键：

```text
buildroot-overlay/isp_media
mediacontrol/media_pipeline/media_isp
units/cameric_drv
units/binder
units/isp_drv
```

说明 Linux daemon 内部并不是简单调用 `v4l2_subdev_ops`，而是链接了 `isp_media` 这套用户态 vendor ISP stack。

## 4. RTOS/MPP 应用显式链接同名 ISP 栈库

RTOS/MPP sample 的 CMake 中直接链接了同名组件：

```cmake
/* /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/sample/fastboot_app/CMakeLists.txt */

include_directories(${k230_sdk}/src/big/mpp/userapps/sample/sample_vo)

link_directories(${k230_sdk}/src/big/mpp/userapps/lib)
link_directories(${nncase_sdk_root}/riscv64/rvvlib/)
link_directories(${nncase_sdk_root}/riscv64/nncase/lib/)

add_executable(${bin} ${src})
target_link_libraries(${bin} -Wl,--start-group rvv Nncase.Runtime.Native nncase.rt_modules.k230 functional_k230 sys vicap vb cam_device cam_engine
 hal oslayer ebase fpga isp_drv binder auto_ctrol common cam_caldb isi 3a buffer_management cameric_drv video_in virtual_hal start_engine cmd_buffer
 switch cameric_reg_drv t_database_c t_mxml_c t_json_c t_common_c vo connector sensor atomic dma -Wl,--end-group)

install(TARGETS ${bin} DESTINATION fastboot_elf)
install(FILES ${data} DESTINATION fastboot_elf)
```

这里的库名与 Linux daemon 中暴露的层级高度一致：

```text
RTOS/MPP linked libs:
    vicap
    cam_device
    cam_engine
    isp_drv
    binder
    cameric_drv
    virtual_hal
    cameric_reg_drv
    cam_caldb
    3a

Linux daemon debug paths / symbols:
    isp_media
    media_pipeline/media_isp
    cameric_drv
    binder
    isp_drv
    MediaIsp*
    CamerIc*
    BinderHal*
    isp_drv*
```

这说明 RTOS/MPP 应用原本就链接同一类 vendor ISP SDK 组件。

## 5. RTOS/MPP 静态库中存在同名底层符号

对 RTOS/MPP 静态库查看符号：

```sh
nm -C \
  /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libcameric_drv.a \
  /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libbinder.a \
  /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libisp_drv.a \
  /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libvicap.a | rg \
"(kd_mpi_isp_ge_config|kd_mpi_submodule_control|CamerIcIspGeSetThreshold|CamerIcIspWriteReg|BinderHalWriteReg|isp_drv_write_reg|isp_write_reg|CamerIcIspReadReg|BinderHalReadReg|isp_drv_read_reg)"
```

输出摘录：

```text
                 U BinderHalReadReg
                 U BinderHalWriteReg
0000000000002d24 T CamerIcIspReadReg
0000000000002cb6 T CamerIcIspWriteReg
0000000000000162 T CamerIcIspGeSetThreshold
                 U BinderHalReadReg
                 U BinderHalWriteReg
0000000000000260 T BinderHalReadReg
00000000000001fa T BinderHalWriteReg
                 U isp_write_reg
0000000000001a00 T isp_drv_read_reg
0000000000001a44 T isp_drv_write_reg
0000000000000020 T isp_write_reg
                 U kd_mpi_submodule_control
                 U kd_mpi_submodule_control_h
0000000000003b92 t kd_mpi_isp_ge_config
0000000000007ac0 T kd_mpi_submodule_control
000000000000356a t kd_mpi_isp_ge_config_h
0000000000006f8e T kd_mpi_submodule_control_h
```

和 Linux daemon 的符号对照：

| 层级 | Linux daemon | RTOS/MPP 静态库 |
| --- | --- | --- |
| GE control 入口 | `MediaIspGeSetCtrl` | `kd_mpi_isp_ge_config` / `kd_mpi_submodule_control` |
| GE IP driver | `CamerIcIspGeSetThreshold` | `CamerIcIspGeSetThreshold` |
| 通用 ISP reg | `CamerIcIspWriteReg` | `CamerIcIspWriteReg` |
| Binder/HAL | `BinderHalWriteReg` | `BinderHalWriteReg` |
| isp drv cmd | `isp_drv_write_reg` | `isp_drv_write_reg` |

这就是“同源或高度同构”的最直接证据：入口层不同，但底层函数名和分层完全对得上。

## 6. RTOS/MPP 静态库字符串暴露同名源码文件

对 Linux daemon 和 RTOS/MPP 静态库查看字符串：

```sh
strings \
  buildroot-overlay/package/vvcam/isp_media_server_debian \
  /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libcameric_drv.a \
  /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libbinder.a \
  /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libisp_drv.a \
  /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libvicap.a | rg \
"(cameric_isp_ge\\.c|cameric_isp\\.c|binder_hal_api\\.c|isp_drv_cmd\\.c|mpi_isp\\.c|mpi_vicap\\.c|CamerIcIspGeSetThreshold|BinderHalWriteReg|isp_drv_write_reg|kd_mpi_isp_ge_config)"
```

输出摘录：

```text
BinderHalWriteReg
CamerIcIspGeSetThreshold
isp_drv_write_reg
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/binder/api/source/binder_hal_api.c
cameric_isp.c
cameric_isp_ge.c
binder_hal_api.c
isp_drv_cmd.c
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp.c
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp_ge.c
/home/wangjianxin/k230/k230_linux_sdk/buildroot-overlay/isp_media/units/isp_drv/source/isp_drv_cmd.c

/builds/maix_sw/k230_sdk/src/big/mpp/userapps/src/vicap/src/isp/sdk/units/binder/api/source/binder_hal_api.c
binder_hal_api.c
BinderHalWriteReg
isp_drv_write_reg
isp_drv_cmd.c
mpi_vicap.c
/builds/maix_sw/k230_sdk/src/big/mpp/userapps/src/vicap/src/isp/mpi_isp.c
mpi_isp.c
kd_mpi_isp_ge_config
kd_mpi_isp_ge_config_h
```

对比路径：

```text
Linux daemon:
    buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp_ge.c
    buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp.c
    buildroot-overlay/isp_media/units/binder/api/source/binder_hal_api.c
    buildroot-overlay/isp_media/units/isp_drv/source/isp_drv_cmd.c

RTOS/MPP:
    src/big/mpp/userapps/src/vicap/src/isp/sdk/units/binder/api/source/binder_hal_api.c
    cameric_isp_ge.c
    cameric_isp.c
    isp_drv_cmd.c
    mpi_isp.c
    mpi_vicap.c
```

根目录不同，但模块组织和文件名一致：

```text
units/cameric_drv/.../cameric_isp_ge.c
units/cameric_drv/.../cameric_isp.c
units/binder/api/source/binder_hal_api.c
units/isp_drv/source/isp_drv_cmd.c
```

这非常像同一套 vendor SDK 在两个工程中的不同集成路径。

## 7. RTOS/MPP API 层不是 V4L2，而是 kd_mpi_vicap/kd_mpi_isp

RTOS/MPP 的 VICAP API：

```c
/* /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/api/mpi_vicap_api.h */

k_s32 kd_mpi_vicap_set_dev_attr(k_vicap_dev dev_num, k_vicap_dev_attr dev_attr);
k_s32 kd_mpi_vicap_get_dev_attr(k_vicap_dev dev_num, k_vicap_dev_attr *dev_attr);
k_s32 kd_mpi_vicap_set_chn_attr(k_vicap_dev dev_num, k_vicap_chn chn_num, k_vicap_chn_attr chn_attr);
k_s32 kd_mpi_vicap_get_chn_attr(k_vicap_dev dev_num, k_vicap_chn chn_num, k_vicap_chn_attr *chn_attr);
k_s32 kd_mpi_vicap_init(k_vicap_dev dev_num);
k_s32 kd_mpi_vicap_deinit(k_vicap_dev dev_num);
k_s32 kd_mpi_vicap_start_stream(k_vicap_dev dev_num);
k_s32 kd_mpi_vicap_stop_stream(k_vicap_dev dev_num);
```

RTOS/MPP 的 ISP API：

```c
/* /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/api/mpi_isp_api.h */

k_s32 kd_mpi_isp_set_dev_attr(k_isp_dev dev_num, k_isp_dev_attr dev_attr);
k_s32 kd_mpi_isp_set_chn_attr(k_isp_dev dev_num, k_isp_chn chn_num, k_isp_chn_attr chn_attr);
k_s32 kd_mpi_isp_init(k_isp_dev dev_num, int fastboot, void *database);
k_s32 kd_mpi_isp_deinit(k_isp_dev dev_num, int fastboot);
k_s32 kd_mpi_isp_connect(k_isp_dev dev_num);
k_s32 kd_mpi_isp_disconnect(k_isp_dev dev_num);
k_s32 kd_mpi_isp_register_3alib(k_isp_dev dev_num, void *usr_awb_lib, void *usr_ae_lib, void *usr_af_lib);
k_s32 kd_mpi_isp_unregister_3alib(k_isp_dev dev_num);
k_s32 kd_mpi_isp_start_stream(k_isp_dev dev_num);
k_s32 kd_mpi_isp_stop_stream(k_isp_dev dev_num);
```

这证明 RTOS/MPP 侧的上层控制模型是私有 MPP API，而不是 V4L2。

Linux V4L2 适配中的 daemon 可以理解为：

```text
把 Linux V4L2 private event/control/buffer/stream 语义
转换成原本 RTOS/MPP 风格的 ISP runtime 控制语义。
```

## 8. RTOS sensor/kernel 侧也是私有 ioctl 设备模型

RTOS/RT-Smart sensor device 注册为 `rt_device`，通过 `.ioctl` 进入 `sensor_priv_ioctl()`：

```c
/* /home/nopiskl/K230/k230_sdk/src/big/mpp/kernel/sensor/src/sensor_dev.c */

static k_s32 sensor_dev_ioctl(struct dfs_fd *file, k_s32 cmd, void *args)
{
    struct rt_device *device;
    struct sensor_driver_dev *pdriver_dev;
    k_s32 ret = 0;

    device = file->fnode->data;
    if (device == NULL) {
        rt_kprintf("%s: device is null\n", __func__);
        return -ENOMEM;
    }

    pdriver_dev = (struct sensor_driver_dev *)device;

    rt_mutex_take(&pdriver_dev->sensor_mutex, RT_WAITING_FOREVER);
    ret = sensor_priv_ioctl(pdriver_dev, cmd, args);
    rt_mutex_release(&pdriver_dev->sensor_mutex);

    return ret;
}

static const struct dfs_file_ops sensor_dev_fops = {
    .open = sensor_dev_open,
    .close = sensor_dev_close,
    .ioctl = sensor_dev_ioctl,
};
```

`sensor_priv_ioctl()` 里处理 power/init/reg/stream/gain/exposure：

```c
/* /home/nopiskl/K230/k230_sdk/src/big/mpp/kernel/sensor/src/sensor_comm.c */

switch (cmd) {
case KD_IOC_SENSOR_S_POWER:
    ret = dev->sensor_func.sensor_power(dev, power_on);
    break;

case KD_IOC_SENSOR_S_INIT:
    ret = dev->sensor_func.sensor_init(dev, sensor_mode);
    break;

case KD_IOC_SENSOR_REG_READ:
    ret = sensor_reg_read(&dev->i2c_info, reg.addr, &reg_val);
    reg.val = reg_val;
    break;

case KD_IOC_SENSOR_REG_WRITE:
    ret = sensor_reg_write(&dev->i2c_info, reg.addr, reg.val);
    break;

case KD_IOC_SENSOR_S_STREAM:
    ret = dev->sensor_func.sensor_set_stream(dev, enable);
    break;

case KD_IOC_SENSOR_S_AGAIN:
    ret = dev->sensor_func.sensor_set_again(dev, gain);
    break;

case KD_IOC_SENSOR_S_INTG_TIME:
    ret = dev->sensor_func.sensor_set_intg_time(dev, time);
    break;
}
```

这说明 RTOS/MPP 原生模型就是：

```text
MPP API
    -> private device/ioctl
    -> sensor/VI/ISP/CamerIc/HAL/isp_drv
```

Linux V4L2 适配只是把入口换成：

```text
V4L2/MC
    -> private ioctl/event
    -> daemon
    -> sensor/VI/ISP/CamerIc/HAL/isp_drv
```

## 9. Linux daemon 与 RTOS/MPP 的调用入口差异

虽然底层栈同源/同构，但入口层不同。

RTOS/MPP：

```text
sample_vicap / app
    -> kd_mpi_vicap_set_dev_attr()
    -> kd_mpi_vicap_init()
    -> kd_mpi_submodule_control()
    -> kd_mpi_isp_ge_config()
    -> CamerIcIspGeSetThreshold()
    -> CamerIcIspWriteReg()
    -> BinderHalWriteReg()
    -> isp_drv_write_reg()
```

Linux V4L2：

```text
VIDIOC_S_CTRL / VIDIOC_STREAMON / VIDIOC_QBUF
    -> vvcam_video
    -> VVCAM_PAD_* private ioctl
    -> vvcam_isp_subdev
    -> VVCAM_ISP_EVENT_* private event
    -> isp_media_server_debian
    -> MediaIspGeSetCtrl()
    -> CamerIcIspGeSetThreshold()
    -> CamerIcIspWriteReg()
    -> BinderHalWriteReg()
    -> isp_drv_write_reg()
```

所以不是说 Linux 原封不动把 RTOS kernel driver 套了一层 V4L2；更准确是：

```text
Linux 侧重做了 V4L2/MC 外壳和 private event bridge。
但 private event 后面的用户态 ISP runtime，
使用的是与 RTOS/MPP 同源或高度同构的 vendor ISP SDK 栈。
```

## 10. 证据链总结

可以按强度排序：

```text
1. Linux daemon 和 RTOS/MPP 静态库同时存在完全相同的底层符号：
       CamerIcIspGeSetThreshold
       CamerIcIspWriteReg
       BinderHalWriteReg
       isp_drv_write_reg

2. Linux daemon debug info 指向：
       buildroot-overlay/isp_media/units/cameric_drv/...
       buildroot-overlay/isp_media/units/binder/...
       buildroot-overlay/isp_media/units/isp_drv/...

3. RTOS/MPP 静态库字符串指向：
       src/big/mpp/userapps/src/vicap/src/isp/sdk/units/...
       cameric_isp_ge.c
       binder_hal_api.c
       isp_drv_cmd.c

4. RTOS/MPP sample 明确链接：
       cam_engine
       cameric_drv
       binder
       isp_drv
       virtual_hal
       cameric_reg_drv
       cam_caldb
       3a

5. RTOS/MPP API 层是：
       kd_mpi_vicap_*
       kd_mpi_isp_*
       kd_mpi_submodule_control()

6. Linux V4L2 侧是：
       vvcam_video/vvcam_isp_subdev
       private ioctl/event
       isp_media_server_debian
```

因此，严谨结论是：

```text
现有源码树无法逐行证明 Linux daemon 和 RTOS/MPP 使用完全同一份 .c 文件，
因为关键 ISP SDK 源码没有完整展开。

但从函数符号、debug source path、静态库链接关系、模块命名、调用层级来看，
Linux daemon 内部的 ISP stack 与 RTOS/MPP 的 ISP stack 明显同源或高度同构。
```

