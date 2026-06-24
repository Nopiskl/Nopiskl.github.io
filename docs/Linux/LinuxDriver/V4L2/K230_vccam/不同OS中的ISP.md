# K230 ISP 控制逻辑在 RTOS / RTOS+Linux / Linux V4L2 中的体现

本文参考路径：

```text
/home/nopiskl/K230/k230_sdk
/home/nopiskl/K230/canmv_k230
/home/nopiskl/K230/k230_linux_sdk
```

目的是把前面分析过的 Linux V4L2/MC private bridge，与 K230 原始 RTOS/RT-Smart MPP 里的 ISP 控制链路对应起来。

核心结论：

```text
RTOS/RT-Smart:
    应用直接调用 kd_mpi_vicap_* / kd_mpi_isp_* MPP API。
    MPP userapps 静态库内部直接驱动 sensor、vicap、ISP、CamEngine、CamerIc、HAL、isp_drv。
    没有 V4L2/MC 外壳，也没有 V4L2 private event daemon 这一层。

Linux V4L2:
    应用看到的是 /dev/videoX、/dev/mediaX、v4l2_subdev。
    内核 V4L2 层把标准 ioctl 转成 private ioctl/event。
    isp_media_server_debian 作为 daemon，承担了 RTOS/MPP 里 kd_mpi_vicap/kd_mpi_isp 这类用户态控制栈的角色。

RTOS+Linux:
    小核 Linux 与大核 RT-Smart 并存时，ISP/VICAP 更接近原始 MPP 模型：
    大核 RT-Smart 侧维护 VICAP/ISP runtime，Linux 侧更多是业务或协同侧。
```

换句话说：

```text
Linux V4L2 daemon 不是凭空出现的。
它更像是把 RTOS/RT-Smart MPP 里那套用户态 ISP 控制栈，包装成 Linux V4L2 private event 的服务端。
```

## 1. 三种形态的对照

### 1.1 RTOS / RT-Smart MPP 形态

典型上层应用路径：

```text
sample_vicap
    -> kd_mpi_vicap_get_sensor_info()
    -> kd_mpi_vicap_set_dev_attr()
    -> kd_mpi_vicap_set_chn_attr()
    -> kd_mpi_vicap_init()
    -> kd_mpi_vicap_start_stream()
```

`kd_mpi_vicap_*` 内部再调用：

```text
kd_mpi_sensor_*
kd_mpi_isp_*
kd_mpi_vicap_dw_*
kd_mpi_submodule_control()
CamEngine*
CamerIc*
BinderHal*
isp_drv*
```

### 1.2 RTOS+Linux 双系统形态

K230 常见是大核跑 RT-Smart，小核跑 Linux。媒体/ISP 这套 MPP 栈主要在大核 RT-Smart 侧：

```text
big core RT-Smart:
    mpp/kernel/lib/libvicap.a
    mpp/userapps/lib/libvicap.a
    mpp/userapps/lib/libcam_engine.a
    mpp/userapps/lib/libcameric_drv.a
    mpp/userapps/lib/libbinder.a
    mpp/userapps/lib/libisp_drv.a

little core Linux:
    可以作为业务系统、UI、网络或协同侧。
    不必天然承担 ISP register/control runtime。
```

这种形态下，ISP runtime pipeline 更接近 RTOS/MPP 原生路径，而不是 Linux V4L2/MC 路径。

### 1.3 only Linux / Linux V4L2 适配形态

`k230_linux_sdk/buildroot-overlay/package/vvcam` 里使用：

```text
vvcam_video
vvcam_isp_subdev
vvcam_isp
isp_media_server_debian
```

这条路径对应用暴露 Linux 标准对象：

```text
/dev/videoX
/dev/mediaX
/dev/v4l-subdevX
```

但真正 runtime 控制通过：

```text
VVCAM_PAD_* private ioctl
VVCAM_VIDEO_DEAMON_EVENT
VVCAM_ISP_DEAMON_EVENT
shared memory
ack/result
```

转给 `isp_media_server_debian`。

## 2. RTOS/RT-Smart 上层应用如何触发 ISP pipeline

`sample_vicap` 是最典型入口。它先获取 sensor 信息，再设置 vicap device attr：

```c
/* /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/sample/sample_vicap/sample_vicap.c */

if (device_obj[dev_num].input_type == VICAP_INPUT_TYPE_SENSOR) {
    dev_attr.input_type = VICAP_INPUT_TYPE_SENSOR;
    //vicap get sensor info
    ret = kd_mpi_vicap_get_sensor_info(device_obj[dev_num].sensor_type, &device_obj[dev_num].sensor_info);
    if (ret) {
        printf("sample_vicap, the sensor type not supported!\n");
        return ret;
    }
    memcpy(&dev_attr.sensor_info, &device_obj[dev_num].sensor_info, sizeof(k_vicap_sensor_info));

    device_obj[dev_num].in_width = device_obj[dev_num].sensor_info.width;
    device_obj[dev_num].in_height = device_obj[dev_num].sensor_info.height;
} else {
    dev_attr.input_type = VICAP_INPUT_TYPE_IMAGE;
    work_mode = VICAP_WORK_LOAD_IMAGE_MODE;
    device_obj[dev_num].ae_enable = 0;
    device_obj[dev_num].awb_enable = 0;
}

dev_attr.pipe_ctrl.data = pipe_ctrl;
dev_attr.pipe_ctrl.bits.af_enable = 0;
dev_attr.pipe_ctrl.bits.ae_enable = device_obj[dev_num].ae_enable;
dev_attr.pipe_ctrl.bits.awb_enable = device_obj[dev_num].awb_enable;

if(work_mode == VICAP_WORK_SW_TILE_MODE)
    dev_attr.pipe_ctrl.bits.dnr3_enable = 1;
else
    dev_attr.pipe_ctrl.bits.dnr3_enable = device_obj[dev_num].dnr3_enable;

dev_attr.pipe_ctrl.bits.ahdr_enable = device_obj[dev_num].hdr_enable;

ret = kd_mpi_vicap_set_dev_attr(dev_num, dev_attr);
if (ret) {
    printf("sample_vicap, kd_mpi_vicap_set_dev_attr failed.\n");
    return ret;
}
```

然后 init/start：

```c
/* /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/sample/sample_vicap/sample_vicap.c */

for (int dev_num = 0; dev_num < VICAP_DEV_ID_MAX; dev_num++) {
    if (!device_obj[dev_num].dev_enable)
        continue;

    printf("sample_vicap, vicap dev(%d) init\n", dev_num);
    ret = kd_mpi_vicap_init(dev_num);
    if (ret) {
        printf("sample_vicap, vicap dev(%d) init failed.\n", dev_num);
        goto app_exit;
    }
}

for (int dev_num = 0; dev_num < VICAP_DEV_ID_MAX; dev_num++) {
    if (!device_obj[dev_num].dev_enable)
        continue;

    printf("sample_vicap, vicap dev(%d) start stream\n", dev_num);
    ret = kd_mpi_vicap_start_stream(dev_num);
    if (ret) {
        printf("sample_vicap, vicap dev(%d) start stream failed.\n", dev_num);
        goto app_exit;
    }
}
```

这和 Linux V4L2 路径的含义对应如下：

| RTOS/MPP API | Linux V4L2 适配里的类似动作 |
| --- | --- |
| `kd_mpi_vicap_set_dev_attr()` | `VIDIOC_S_FMT` / `VVCAM_ISP_EVENT_SET_FMT` / pipeline 参数 |
| `kd_mpi_vicap_set_chn_attr()` | video node 格式、通道 buffer/format 配置 |
| `kd_mpi_vicap_init()` | `VVCAM_VEVENT_CREATE_PIPELINE` |
| `kd_mpi_vicap_start_stream()` | `VIDIOC_STREAMON` -> `VVCAM_PAD_S_STREAM` -> `VVCAM_ISP_EVENT_STREAMON` |
| `kd_mpi_vicap_stop_stream()` | `VIDIOC_STREAMOFF` -> `VVCAM_ISP_EVENT_STREAMOFF` |

但注意：这只是“语义对应”，不是完全相同的 API 层级。

## 3. RTOS/MPP API 定义

VICAP API：

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

ISP API：

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

这说明 RTOS/MPP 侧本来就有一个比 V4L2 更直接的 media pipeline API：

```text
VICAP:
    面向整个 capture pipeline。

ISP:
    面向 ISP device/channel、3A、tuning、stream、dump。

Sensor:
    面向 sensor power/init/stream/gain/exposure/white balance/test pattern。
```

## 4. `libvicap.a` 内部暴露的真实调用关系

当前 `k230_sdk` 目录中，`kd_mpi_vicap_*` 和 `kd_mpi_isp_*` 的 C 源码没有完整展开在 `userapps/src`，但静态库 `libvicap.a` 暴露了符号。

```sh
nm -C /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libvicap.a
```

可以看到：

```text
mpi_vicap.o:
    kd_mpi_vicap_init
    kd_mpi_vicap_deinit
    kd_mpi_vicap_set_dev_attr
    kd_mpi_vicap_set_chn_attr
    kd_mpi_vicap_start_stream
    kd_mpi_vicap_stop_stream

    U kd_mpi_isp_set_dev_attr
    U kd_mpi_isp_set_chn_attr
    U kd_mpi_isp_init
    U kd_mpi_isp_start_stream
    U kd_mpi_isp_stop_stream
    U kd_mpi_isp_register_3alib
    U kd_mpi_isp_unregister_3alib

mpi_isp.o:
    kd_mpi_isp_set_dev_attr
    kd_mpi_isp_set_chn_attr
    kd_mpi_isp_connect
    kd_mpi_isp_init
    kd_mpi_isp_start_stream
    kd_mpi_isp_stop_stream
    kd_mpi_isp_tuning

mpi_isp_submodule.o:
    kd_mpi_isp_ae_config
    kd_mpi_isp_awb_config
    kd_mpi_isp_wdr_config
    kd_mpi_isp_lsc_config
    kd_mpi_isp_ge_config
    kd_mpi_isp_dpcc_config
    kd_mpi_isp_dpf_config
    kd_mpi_isp_bls_config
    kd_mpi_submodule_control
```

`strings` 还能看到 `libvicap.a` 中的关键路径和报错：

```text
/dev/mem
/dev/vicap
open vicap failed.
kd_mpi_vicap_init
kd_mpi_sensor_open
kd_mpi_sensor_mirror_set
kd_mpi_sensor_mode_get
kd_mpi_sensor_power_set
kd_mpi_isp_set_dev_attr
kd_mpi_isp_set_chn_attr
kd_mpi_isp_init
kd_mpi_submodule_control
kd_mpi_isp_start_stream
kd_mpi_sensor_init
kd_mpi_sensor_stream_enable
kd_mpi_isp_ge_config
```

这说明 `kd_mpi_vicap_init()` 大致会做：

```text
open /dev/vicap
open/config sensor
set ISP dev attr
set ISP chn attr
init ISP
load/parse calibration database
kd_mpi_submodule_control()
register 3A
init dewarp if needed
```

`kd_mpi_vicap_start_stream()` 大致会做：

```text
kd_mpi_isp_start_stream()
kd_mpi_sensor_init()
kd_mpi_sensor_stream_enable()
```

这和 Linux V4L2 daemon 里收到 `VVCAM_ISP_EVENT_STREAMON` 后要做的事情高度对应。

## 5. RT-Smart kernel 侧：`/dev/vicap`、ISP device、sensor device

`k230_sdk/src/big/mpp/kernel/lib/libvicap.a` 是 RT-Smart kernel 侧 vicap/isp/vi/dewarp 模块的静态库。它没有完整 C 源码展开，但符号非常清楚：

```sh
nm -C /home/nopiskl/K230/k230_sdk/src/big/mpp/kernel/lib/libvicap.a
```

关键符号：

```text
vicap_mod.o:
    vicap_init
    vicap_exit
    vicap_device_open
    vicap_device_close
    vicap_device_ioctl
    vicap_do_ioctl
    vicap_mcm_do_ioctl
    csi_device_init
    isp_device_init
    sensor_device_init
    vi_device_init
    rt_device_register

vicap_input.o:
    vicap_do_ioctl
    vicap_data_send
    vicap_set_mclk
    kd_vicap_rst
    kd_vi_set_config
    kd_vi_bind_source
    kd_vicap_vi_set_drop_frame
    isp_tpg_enable
    isp_status_clear
    isp_status_show

isp_dev.o:
    isp_device_init
    isp_drv_dev_init
    isp_dev_ioctl
    isp_write_reg
    isp_read_reg
    isp_reset
    isp_tpg_enable
    isp_event_queue
    isp_event_subscribe
    isp_event_dequeue
    rt_device_register

isp_mcm.o:
    vicap_mcm_init
    vicap_mcm_do_ioctl
    vicap_start_mcm
    isp_mcm_write_reg
    isp_mcm_read_reg

vi.o:
    vi_device_init
    kd_vi_set_config
    kd_vi_bind_source
```

这个结构和 Linux V4L2 适配里的内核模块有一一对应关系：

| RT-Smart kernel | Linux V4L2 适配 |
| --- | --- |
| `vicap_mod.o` / `/dev/vicap` | `/dev/videoX` + `vvcam_video` + daemon bridge |
| `isp_dev.o` / ISP device | `/dev/vvcam-isp.0` + `vvcam_isp` |
| `isp_event.o` | `vvcam_isp_event.c` 的 private V4L2 event |
| `sensor_device_init()` | Linux sensor subdev 或 K230 vendor sensor lib |
| `vi_device_init()` | `vvcam_mipi` / `k230_csi` / `k230_vi` |
| `vicap_mcm_*` | Linux 侧 mcm pipeline / multi-channel mode |

差别在于：

```text
RT-Smart:
    `/dev/vicap` 是 MPP 自己的设备抽象。
    用户态 MPP API 直接 ioctl 到这个设备，并调用 ISP/CamEngine/CamerIc 静态库。

Linux V4L2:
    `/dev/videoX` 是 V4L2 标准对象。
    但标准 ioctl 先进入 private bridge，再由 daemon 调用 vendor ISP stack。
```

## 6. Sensor 控制在 RT-Smart 中的体现

RT-Smart sensor device 是实际可注册的 `rt_device`：

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

k_s32 sensor_drv_dev_init(struct sensor_driver_dev *pdriver_dev)
{
    struct rt_device *device;
    char dev_name[32];
    k_s32 ret = 0;

    device = &pdriver_dev->parent;
    rt_snprintf(dev_name, sizeof(dev_name), "sensor_%s", pdriver_dev->sensor_name);

    rt_mutex_init(&pdriver_dev->sensor_mutex, "sensor_mutex", RT_IPC_FLAG_PRIO);

    ret = rt_device_register(device, dev_name, RT_DEVICE_FLAG_RDWR);
    if (ret) {
        rt_kprintf("sensor device register fail\n");
        return ret;
    }

    device->fops = &sensor_dev_fops;
    device->user_data = pdriver_dev;
    return 0;
}
```

sensor private ioctl 里可以直接看到 power/init/reg/stream/gain/exposure 等控制：

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

这和 Linux V4L2 主线里的 sensor subdev 很像，但名字和接口是 K230 MPP 私有 ioctl，而不是 `v4l2_subdev_ops` / `V4L2_CID_ANALOGUE_GAIN` / `V4L2_CID_EXPOSURE` 这套主线控制接口。

## 7. ISP IP/HAL 静态库与 Linux daemon 的对应

在 `k230_sdk/src/big/mpp/userapps/lib` 和 `canmv_k230/src/rtsmart/mpp/userapps/lib` 中，可以看到完整 vendor ISP 栈的静态库：

```text
libvicap.a
libcam_engine.a
libcam_device.a
libcameric_drv.a
libcameric_reg_drv.a
libbinder.a
libisp_drv.a
libvirtual_hal.a
libhal.a
libauto_ctrol.a
lib3a.a
```

这些名字和 Linux `isp_media_server_debian` 二进制中暴露的函数名一致。

以 GE 为例：

```sh
nm -C /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libcameric_drv.a
```

可以看到：

```text
CamerIcIspGeInit
CamerIcIspGeRelease
CamerIcIspGeEnable
CamerIcIspGeDisable
CamerIcIspGeIsEnabled
CamerIcIspGeSetThreshold
CamerIcIspGeGetThreshold
CamerIcIspWriteReg
CamerIcIspReadReg
```

再看 HAL/binder/isp_drv：

```sh
nm -C \
  /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libbinder.a \
  /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libisp_drv.a \
  /home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libvirtual_hal.a
```

可以看到：

```text
BinderHalWriteReg
BinderHalReadReg
BinderGeneralWriteRegister
BinderGeneralReadRegister

VirtualHalWriteReg
VirtualHalReadReg
VirtualGeneralWriteRegister
VirtualGeneralReadRegister

isp_write_reg
isp_read_reg
isp_drv_write_reg
isp_drv_read_reg
```

`canmv_k230` 里的静态库也暴露同类符号：

```text
CamerIcIspGeSetThreshold
CamerIcIspWriteReg
BinderHalWriteReg
isp_drv_write_reg
```

并且字符串中带有原始源码路径：

```text
/home/gitlab/canmv_k230/src/rtsmart/mpp/userapps/src/vicap/src/isp/sdk/units/binder/api/source/binder_hal_api.c
src/isp/sdk/t_frameworks/t_shell_c/source/shell_green_equilibration.c
cameric_isp_ge.c
isp_drv_cmd.c
```

这与 Linux daemon 中 `addr2line` 看到的路径高度一致：

```text
buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp_ge.c
buildroot-overlay/isp_media/units/cameric_drv/base/source/cameric_isp.c
buildroot-overlay/isp_media/units/binder/api/source/binder_hal_api.c
buildroot-overlay/isp_media/units/isp_drv/source/isp_drv_cmd.c
```

所以可以判断：

```text
RTOS/MPP 的 ISP 静态库
    和
Linux daemon 内部的 ISP vendor stack

是同源或高度同构的一套代码。
```

## 8. GE control 的跨系统对应

### 8.1 Linux V4L2 路径

前面分析过：

```text
VIDIOC_S_CTRL(VVCAM_ISP_CID_GE_THRESHOLD)
    -> vvcam_vidioc_s_ctrl()
    -> VVCAM_PAD_S_CTRL
    -> vvcam_isp_s_ctrl()
    -> vvcam_isp_ge_s_ctrl()
    -> VVCAM_ISP_EVENT_S_CTRL
    -> isp_media_server_debian
    -> MediaIspGeSetCtrl()
    -> CamerIcIspGeSetThreshold()
    -> CamerIcIspWriteReg()
    -> BinderHalWriteReg() / isp_drv_write_reg()
    -> /dev/vvcam-isp.0
    -> writel()
```

### 8.2 RTOS/MPP 路径

在 RTOS/MPP 中没有 V4L2 control 和 `VVCAM_ISP_EVENT_S_CTRL` 这层。对应关系更接近：

```text
kd_mpi_vicap_init()
    -> kd_mpi_isp_init()
    -> calibration database load
    -> kd_mpi_submodule_control()
    -> kd_mpi_isp_ge_config()
    -> CamEngine / CamerIc GE config
    -> CamerIcIspGeSetThreshold()
    -> CamerIcIspWriteReg()
    -> BinderHalWriteReg() / isp_drv_write_reg()
    -> RT-Smart ISP device / mapped register
```

如果是运行时 tuning 或 shell 控制，则会走：

```text
kd_mpi_isp_tuning()
    -> TDriverUnits_isp_process()
    -> shell_green_equilibration / driver_units_green_equilibration
    -> CamerIcIspGe*
    -> register write
```

这说明：

```text
Linux V4L2:
    V4L2 control 是入口，daemon 把 control 转成 GE config。

RTOS/MPP:
    calibration database、submodule control、tuning shell 是入口，
    直接调用 GE config/IP driver。
```

两者底层汇合点都是：

```text
CamerIcIspGeSetThreshold()
    -> CamerIcIspWriteReg()
    -> BinderHalWriteReg()
    -> isp_drv_write_reg()
```

## 9. RTOS 和 Linux V4L2 的 pipeline 维护差异

| 维度 | RTOS/RT-Smart MPP | Linux V4L2 适配 |
| --- | --- | --- |
| 应用入口 | `kd_mpi_vicap_*` / `kd_mpi_isp_*` | `VIDIOC_*` / media graph / subdev |
| 拓扑表达 | MPP dev/chn/pipeline 参数 | MC entity/pad/link |
| pipeline 创建 | `kd_mpi_vicap_init()` | `VVCAM_VEVENT_CREATE_PIPELINE` -> daemon |
| stream on | `kd_mpi_vicap_start_stream()` | `VIDIOC_STREAMON` -> private event -> daemon |
| sensor 控制 | `kd_mpi_sensor_*` / `KD_IOC_SENSOR_*` | sensor subdev 或 daemon/vendor sensor lib |
| ISP module config | `kd_mpi_submodule_control()` / `kd_mpi_isp_*_config()` | V4L2 ctrl -> `VVCAM_ISP_EVENT_S_CTRL` -> daemon |
| 底层 IP driver | `CamerIc*` 静态库 | daemon 内同源 `CamerIc*` |
| 寄存器访问 | `BinderHal*` / `isp_drv*` / RT-Smart ISP device | `BinderHal*` / `isp_drv*` / `/dev/vvcam-isp.0` |
| 是否依赖 V4L2/MC | 否 | 是，作为 Linux 用户态接口外壳 |
| 是否依赖 daemon | 否，MPP API 自己就是用户态控制栈 | 是，daemon 是 V4L2 private RPC 服务端 |

## 10. 对 “daemon 是什么” 的再解释

参考 RTOS/MPP 后，可以更准确地描述 Linux daemon：

```text
daemon 不是普通意义上的“把 ioctl 转发到内核”的小服务。

它更像 RTOS/RT-Smart MPP 的 kd_mpi_vicap/kd_mpi_isp 控制栈在 Linux V4L2 世界里的替身。

Linux 内核 V4L2/MC 层负责：
    /dev/videoX
    /dev/mediaX
    video_device
    v4l2_subdev
    vb2
    private event bridge

daemon 负责：
    解释 private event 语义
    维护 ISP runtime pipeline
    读取 sensor calibration database
    调用 CamEngine/CamerIc/Binder/HAL/isp_drv
    完成寄存器级配置
    ack 内核侧同步等待
```

所以它和 RTOS/MPP 的关系可以画成：

```text
RTOS/RT-Smart:
    APP
      -> kd_mpi_vicap/kd_mpi_isp
      -> CamEngine/CamerIc/Binder/isp_drv
      -> RT-Smart kernel ISP/VICAP device
      -> register

Linux V4L2:
    APP
      -> VIDIOC_* / V4L2 control
      -> vvcam_video / vvcam_isp_subdev
      -> private event
      -> isp_media_server_debian
      -> CamEngine/CamerIc/Binder/isp_drv
      -> /dev/vvcam-isp.0
      -> register
```

## 11. 这对 Linux V4L2 主线化意味着什么

参考 RTOS/MPP 后，能更清楚看到 Linux 适配为什么和主线差异大：

```text
K230 原生 ISP 控制栈不是按 Linux V4L2 subdev driver 模型设计的。
它本来就是 MPP API + 用户态 ISP SDK + RT-Smart device/ioctl 的模型。

Linux vvcam 适配并没有把这套 ISP SDK 完整重写成主线 subdev driver。
它选择保留 vendor ISP SDK 在用户态运行，
然后用 V4L2/MC 外壳 + private event 把 Linux 应用接进来。
```

因此，若要把它改得更接近主线，需要做的不是简单删除 daemon，而是要把 RTOS/MPP 栈里这些职责拆回 Linux 内核标准对象：

```text
kd_mpi_vicap_init/start_stream
    -> media pipeline start/stop + vb2 + subdev .s_stream

kd_mpi_isp_set_dev_attr/set_chn_attr
    -> subdev pad set_fmt/set_selection/routing

kd_mpi_submodule_control / kd_mpi_isp_*_config
    -> v4l2_ctrl_handler + subdev controls + kernel IP drivers

CamerIcIsp* / BinderHal* / isp_drv*
    -> kernel-side ISP IP block driver / regmap-like access

sensor KD_IOC_SENSOR_*
    -> sensor v4l2_subdev_ops + standard controls
```

这是一项架构迁移，而不是简单 API 适配。

## 12. 可继续深挖的位置

当前可直接读到的源码：

```text
/home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/api/mpi_vicap_api.h
/home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/api/mpi_isp_api.h
/home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/sample/sample_vicap/sample_vicap.c
/home/nopiskl/K230/k230_sdk/src/big/mpp/kernel/sensor/src/sensor_dev.c
/home/nopiskl/K230/k230_sdk/src/big/mpp/kernel/sensor/src/sensor_comm.c
/home/nopiskl/K230/canmv_k230/src/rtsmart/mpp/userapps/api/mpi_vicap_api.h
/home/nopiskl/K230/canmv_k230/src/rtsmart/mpp/userapps/api/mpi_isp_api.h
```

当前主要只能通过静态库符号确认的部分：

```text
/home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libvicap.a
/home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libcam_engine.a
/home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libcameric_drv.a
/home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libbinder.a
/home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libisp_drv.a
/home/nopiskl/K230/k230_sdk/src/big/mpp/userapps/lib/libvirtual_hal.a
/home/nopiskl/K230/k230_sdk/src/big/mpp/kernel/lib/libvicap.a
/home/nopiskl/K230/canmv_k230/src/rtsmart/mpp/userapps/lib/libvicap.a
/home/nopiskl/K230/canmv_k230/src/rtsmart/mpp/userapps/lib/libcameric_drv.a
```

如果能拿到完整源码，优先找：

```text
src/big/mpp/userapps/src/vicap/src/isp/mpi_vicap.c
src/big/mpp/userapps/src/vicap/src/isp/mpi_isp.c
src/big/mpp/userapps/src/vicap/src/isp/mpi_isp_submodule.c
src/big/mpp/userapps/src/vicap/src/isp/sdk/units/cameric_drv/base/source/cameric_isp_ge.c
src/big/mpp/userapps/src/vicap/src/isp/sdk/units/cameric_drv/base/source/cameric_isp.c
src/big/mpp/userapps/src/vicap/src/isp/sdk/units/binder/api/source/binder_hal_api.c
src/big/mpp/userapps/src/vicap/src/isp/sdk/units/isp_drv/source/isp_drv_cmd.c
```

这些文件就是把 `kd_mpi_vicap_init()`、`kd_mpi_submodule_control()`、`kd_mpi_isp_ge_config()` 还原到具体寄存器位域的关键。

