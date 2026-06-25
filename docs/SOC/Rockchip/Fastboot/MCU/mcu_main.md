# MCU project analysis in SDK
_Exported on 2026/4/21 at GMT+8 14:03:42 from Cursor (2.6.21)_

---

**User**

@RV1106_MCU_主流程.md @SDK/luckfox-pico/agent/MCU.md 
结合分析文档，帮我分析一下SDK/luckfox-pico/sysdrv/source/mcu
1、这个MCU工程在SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk配置下是如何编译的？如何被打包的？
2、整个MCU工程结构是怎样的，主流程是什么样的？入口函数以及调用链是怎样的？最好一步步来
3、固件如何被加载的


---

**Cursor**


---

# 一、在这个 BoardConfig 下，MCU 工程是如何编译、如何打包的

你指定的板级配置是：

`project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk`

这个配置里跟 MCU 强相关的点有两个：

```67:84:/home/alientek/RV1106/SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Busybox-RV1106_Luckfox_Pico_Ultra-IPC_FASTBOOT.mk
# Uboot defconfig
export RK_UBOOT_DEFCONFIG=luckfox_rv1106_uboot_emmc_tb_defconfig

# Uboot compile rkbin ini file path overlay
# export RK_UBOOT_RKBIN_INI_OVERLAY=RKBOOT/RV1106MINIALL_TB_SC3336_SC3338.ini
# build.sh mcu info --> rv1106_evb-SC3338-ADC
export RK_UBOOT_RKBIN_MCU_CFG=rv1106_evb-SC3338-ADC

# Kernel defconfig
export RK_KERNEL_DEFCONFIG=luckfox_rv1106_linux_tb_defconfig
...
# enable fastboot
export RK_ENABLE_FASTBOOT=y
```

这里的含义是：

- `RK_ENABLE_FASTBOOT=y`：启用 thunder boot / fastboot 路径
- `RK_UBOOT_RKBIN_MCU_CFG=rv1106_evb-SC3338-ADC`：告诉顶层构建系统，MCU 要按 `rv1106_evb-SC3338-ADC` 这个 BSP/defconfig 来编

---

## 1.1 顶层是在哪里触发 MCU 编译的

在 `project/build.sh` 的 `build_uboot()` 里，如果检测到 fastboot 开启且指定了 MCU 配置，就会先编 MCU，再编 U-Boot：

```706:737:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
	target_ini_dir=$SDK_SYSDRV_DIR/source/uboot/rkbin/RKBOOT/
	if [ "$RK_ENABLE_FASTBOOT" = "y" -a -n "$RK_UBOOT_RKBIN_MCU_CFG" ]; then
		uboot_rkbin_ini=$RK_PROJECT_PATH_FASTBOOT/rk_uboot_rkbin_rkboot_overlay.ini
		build_mcu $RK_UBOOT_RKBIN_MCU_CFG "__MCU_CONTINUE__"
		case $RK_BOOT_MEDIUM in
		emmc)
			tempfile=$target_ini_dir/RV1106MINIALL_EMMC_TB.ini
			;;
...
		if [ -f "$RK_PROJECT_FILE_SYSDRV_MCU_BIN" ]; then
			__modify_file $tempfile $uboot_rkbin_ini "Hpmcu=" "$RK_PROJECT_FILE_SYSDRV_MCU_BIN" "^"
		else
			msg_error "build mcu <$RK_UBOOT_RKBIN_MCU_CFG> failed"
			exit 1
		fi
	fi

	make uboot -C ${SDK_SYSDRV_DIR} UBOOT_CFG=${RK_UBOOT_DEFCONFIG} UBOOT_CFG_FRAGMENT=${RK_UBOOT_DEFCONFIG_FRAGMENT} SYSDRV_UBOOT_RKBIN_OVERLAY_INI=$uboot_rkbin_ini
```

这里做了 3 件关键事：

1. 调 `build_mcu rv1106_evb-SC3338-ADC`
2. 选出当前存储介质对应的 rkbin ini，这里是 `RV1106MINIALL_EMMC_TB.ini`
3. 把 ini 里的 `Hpmcu=` 临时改成“刚编出来的 MCU bin”

所以结论先说清楚：

**这个 BoardConfig 下，MCU 不是只用 rkbin 里预编译的固定 bin，而是会优先从 `sysdrv/source/mcu` 源码重新编一个 `rtthread.bin`，再覆盖进打包 ini。**

---

## 1.2 `build_mcu()` 实际做了什么

顶层 `build_mcu()` 在这里：

```885:924:/home/alientek/RV1106/SDK/luckfox-pico/project/build.sh
function build_mcu() {
	if [ ! -d "$SDK_SYSDRV_DIR/source/mcu" ]; then
		msg_info "Not found mcu [$SDK_SYSDRV_DIR/source/mcu], ignore"
		exit 1
	fi

	# sync gcc
	if [ ! -d "$SDK_SYSDRV_DIR/source/mcu/prebuilts/gcc" ]; then
		mkdir -p $SDK_SYSDRV_DIR/source/mcu/prebuilts/gcc/linux-x86/riscv64
		wget -P $SDK_SYSDRV_DIR/source/mcu/prebuilts/gcc/linux-x86/riscv64 \
			https://github.com/xpack-dev-tools/riscv-none-embed-gcc-xpack/releases/download/v10.2.0-1.2/xpack-riscv-none-embed-gcc-10.2.0-1.2-linux-x64.tar.gz
...
	$SDK_SYSDRV_DIR/source/mcu/build.sh lunch $build_opt
	$SDK_SYSDRV_DIR/source/mcu/build.sh clean
	mkdir -p $RK_PROJECT_PATH_MCU
	$SDK_SYSDRV_DIR/source/mcu/build.sh all $RK_PROJECT_PATH_MCU
```

它会：

- 准备 RISC-V 交叉编译器 `riscv-none-embed-gcc`
- 调 `sysdrv/source/mcu/build.sh lunch rv1106_evb-SC3338-ADC`
- 调 `clean`
- 调 `all <输出目录>`

---

## 1.3 MCU 子工程内部是怎么编的

MCU 子工程自己的构建脚本是：

`sysdrv/source/mcu/project/build.sh`

核心编译动作在 `build_all()`：

```272:289:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/project/build.sh
function build_all() {
	echo "============================================"
	choose_default_board

	cd ${SDK_ROOT_DIR}
	scons -C ${SDK_ROOT_DIR}/rt-thread/bsp/rockchip/rv1106-mcu -j${RK_JOBS}

	local _opt
	_opt=""
	if [ -d "$1" ];then
		_opt=$1
	fi
	build_firmware $_opt

	finish_build
}
```

它实际上是：

- 在 `rt-thread/bsp/rockchip/rv1106-mcu` 上跑 `scons`
- 产出 `rtthread.bin`

而 `build_firmware()` 会把 `rtthread.bin` 拷出去：

```296:303:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/project/build.sh
function build_firmware(){
	mkdir -p ${RK_PROJECT_OUTPUT_IMAGE}

	if [ -d "$1" ];then
		cp -rfa ${SDK_ROOT_DIR}/rt-thread/bsp/rockchip/rv1106-mcu/rtthread.bin  $1
	fi
	cp -rfa ${SDK_ROOT_DIR}/rt-thread/bsp/rockchip/rv1106-mcu/rtthread.bin  ${RK_PROJECT_OUTPUT_IMAGE}
	finish_build
}
```

也就是说最终 MCU 编译产物就是：

- `rt-thread/bsp/rockchip/rv1106-mcu/rtthread.bin`
- 同时拷到 `output/image/rtthread.bin`
- 顶层再把它当成 `Hpmcu=` 的输入文件

---

## 1.4 `lunch rv1106_evb-SC3338-ADC` 是怎么选板子的

`sysdrv/source/mcu/project/build.sh` 里会根据板名选对应 `defconfig`：

```50:69:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/project/build.sh
function choose_default_board
{
	RK_TARGET_BOARD_ARRAYtmp=( $(cd ${TARGET_PRODUCT_DIR}/board;find -type d -name "*evb*"| sort) )
	RK_TARGET_BOARD_ARRAY=( "${RK_TARGET_BOARD_ARRAYtmp[@]}" $(cd ${TARGET_PRODUCT_DIR}/board;find -type d -name "*-*-*" | grep -v "evb" | sort));

	if [  -f "${TARGET_PRODUCT_DIR}/rtconfig.h" ]; then
		CONFIGED_BOARD_NAME=$(cd ${TARGET_PRODUCT_DIR};cat rtconfig.h | grep RT_BOARD_NAME)
		CONFIGED_BOARD_NAME=${CONFIGED_BOARD_NAME:23:0-1}
		if [  -d "${TARGET_PRODUCT_DIR}/board/${CONFIGED_BOARD_NAME}" ]; then
			echo "find configed board ${CONFIGED_BOARD_NAME}"
			cd ${TARGET_PRODUCT_DIR}
			cp board/${CONFIGED_BOARD_NAME}/defconfig .config
			scons --useconfig=board/${CONFIGED_BOARD_NAME}/defconfig
```

这里实际就是把：

`board/rv1106_evb-SC3338-ADC/defconfig`

灌成当前 MCU BSP 的 `.config`。

---

## 1.5 它是怎么被“打包”进 loader 的

EMMC thunder boot 的默认 rkbin ini 是：

```1:21:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/uboot/rkbin/RKBOOT/RV1106MINIALL_EMMC_TB.ini
[CHIP_NAME]
NAME=RV1106
...
[LOADER_OPTION]
NUM=3
LOADER1=FlashData
LOADER2=Hpmcu
LOADER3=FlashBoot
FlashData=bin/rv11/rv1106_ddr_924MHz_tb_v1.15.bin
Hpmcu=bin/rv11/rv1106_hpmcu_tb_v1.01.bin
FlashBoot=bin/rv11/rv1106_spl_emmc_tb_v1.00.bin
[LOADER2_PARAM]
LOAD_ADDR=0x40000
FLAG=0x10007
```

可以看到 loader 里有三段：

- `FlashData`：DDR 初始化固件
- `Hpmcu`：MCU 固件
- `FlashBoot`：SPL/U-Boot 早期引导

默认 ini 里 `Hpmcu` 指向预编译固件；但在你的这套构建流程里，顶层脚本会生成一个 overlay ini，把这个 `Hpmcu=` 改成刚刚编出来的 `rtthread.bin`。

所以“被打包”的意思是：

- **MCU bin 被作为 rkbin loader 的第二段 `LOADER2=Hpmcu` 打进下载镜像 / idblock / boot loader 链路里**
- 它的加载地址在 ini 里给的是 `0x40000`

补一个 SC3338 专用 ini 也能看得更明确：

```1:20:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/uboot/rkbin/RKBOOT/RV1106MINIALL_TB_SC3336_SC3338.ini
[CHIP_NAME]
NAME=RV1106
...
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

---

# 二、整个 MCU 工程结构怎样，主流程是什么，入口和调用链怎样

下面按“目录结构 → 系统入口 → 设备注册 → 应用入口 → fast AE 主链路”来讲。

---

## 2.1 MCU 工程整体结构

`sysdrv/source/mcu` 顶层其实很简单：

- `project/`：构建脚本
- `rt-thread/`：真正的 MCU 固件源码

其中最关键的是：

### 1）BSP / 板级 / 启动
- `rt-thread/bsp/rockchip/rv1106-mcu/applications/main.c`
- `rt-thread/bsp/rockchip/rv1106-mcu/board/common/board_base.c`
- `rt-thread/bsp/rockchip/rv1106-mcu/board/rv1106_evb-SC3338-ADC/board.c`
- `rt-thread/bsp/rockchip/rv1106-mcu/board/rv1106_evb-SC3338-ADC/defconfig`

### 2）驱动层
- ISP3 驱动：`rt-thread/bsp/rockchip/common/drivers/isp3/drv_isp3.c`
- 相机驱动：`rt-thread/bsp/rockchip/common/drivers/camera/...`

### 3）应用层
- `rt-thread/applications/battery-ipc/stream.c`
- `rt-thread/applications/battery-ipc/fast_ae.c`
- `rt-thread/applications/battery-ipc/fast_ae.h`
- `rk_meta.h`
- `rk_meta_app_param.h`
- `rkaiq_parse_iq.c`

### 4）算法静态库
`battery-ipc` 不是纯源码算法工程，它还链接了两个静态库：

```1:9:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/applications/battery-ipc/SConscript
Import('RTT_ROOT')
Import('rtconfig')
from building import *

cwd     = GetCurrentDir()
src     = Glob('*.c')
CPPPATH = [cwd, str(Dir('#')), 'include/iq_parser_v2/', 'include/common']
LIBS    = ['libfastae_gcc.a','libfastawb_gcc.a']
```

所以：
- `fast_ae.c` 更多是“流程编排 + 参数处理 + 设备控制”
- 真正的 fast AE / fast AWB 核心算法在 `libfastae_gcc.a`、`libfastawb_gcc.a`

---

## 2.2 先看系统总入口：`main()`

RT-Thread MCU 固件的 C 入口在：

```13:56:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/bsp/rockchip/rv1106-mcu/applications/main.c
#include <stdio.h>
#include <string.h>
#include <rtthread.h>
#include "board_base.h"

void rtthread_startup(void)
{
...
    rt_hw_board_init();
...
    rt_application_init();
...
    rt_system_scheduler_start();
}

int main(void)
{
    /* startup RT-Thread RTOS */
    rtthread_startup();

    return 0;
}
```

所以最上层调用链是：

```text
main()
-> rtthread_startup()
   -> rt_hw_board_init()
   -> rt_application_init()
   -> rt_system_scheduler_start()
```

---

## 2.3 板级初始化干了什么：`rt_hw_board_init()`

在 `board_base.c`：

```89:118:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/bsp/rockchip/rv1106-mcu/board/common/board_base.c
static rt_bool_t sirq = RT_FALSE;
static void board_softirq_handler(int vector, void *param)
{
    COREGRF->MCU_CACHE_MISC = 0x00080000;
    sirq = RT_TRUE;
}

rt_bool_t sirq_status(void)
{
    return sirq;
}

void rt_hw_board_init(void)
{
    rt_system_heap_init((void *)HEAP_BEGIN, (void *)HEAP_END);
    rt_hw_interrupt_init();
    rt_soft_interrupt_install(board_softirq_handler, RT_NULL, "soft irq");
...
#ifdef RT_USING_ISP3
    cif_hw_config();
#endif
...
#ifdef RT_USING_COMPONENTS_INIT
    rt_components_board_init();
#endif
}
```

这里几个关键点：

1. 初始化堆、时钟、中断、串口、IOMUX
2. 安装一个 softirq 处理函数 `board_softirq_handler()`
3. 调 `cif_hw_config()` 配 CSI/DPHY/VICAP
4. 调 `rt_components_board_init()`，把各种 `INIT_DEVICE_EXPORT` / `INIT_APP_EXPORT` 注册的东西都跑起来

`sirq_status()` 很关键，后面 MCU 会靠它判断：

- “U-Boot 有没有通知我 meta/IQ 数据已经准备好了”

---

## 2.4 当前板型 `rv1106_evb-SC3338-ADC` 配了什么

板级文件在：

`board/rv1106_evb-SC3338-ADC/board.c`

```13:55:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/bsp/rockchip/rv1106-mcu/board/rv1106_evb-SC3338-ADC/board.c
#ifdef RT_USING_SC3338
const struct camera_board_desc camera_sc3338[] =
{
    {
        .i2c_addr = 0x30,
        .rst_gpio = { .gpio_pin = GPIO_PIN_C5, .gpio_group = GPIO3, },
        .pwdn_gpio = { .gpio_pin = GPIO_PIN_D2, .gpio_group = GPIO3, },
        .time_valid_delay = 2,
        .gain_valid_delay = 2,
        .mode_id = SC3338_1152X648,
        .isp_subdev_name = RK_ISP_MAIN_SUBDEV_NAME,
        .i2c_bus = "i2c4",
...
    },
    { /* sentinel */ }
};
#endif

#ifdef RT_USING_ISP3
void cif_hw_config(void)
{
...
    csi2_dphy->enable = true;
...
    csi2_dphy->csi2_dphy1.data_lanes = 2;
...
    csi_host_0->enable = true;
    vicap->enable = true;
}
#endif
```

也就是：

- sensor 是 `SC3338`
- 通过 `i2c4` 控制
- reset/pwdn GPIO 在 `GPIO3`
- CSI2 DPHY、CSI Host、VICAP 都打开

---

## 2.5 这个 BSP 的 defconfig 打开了哪些功能

你这个 MCU BSP 的 `defconfig` 里，和主流程最重要的开关有：

```137:216:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/bsp/rockchip/rv1106-mcu/board/rv1106_evb-SC3338-ADC/defconfig
CONFIG_RT_BOARD_NAME="rv1106_evb-SC3338-ADC"
CONFIG_RT_USING_CAM_STREAM_ON_LATE=y
...
CONFIG_RT_USING_ISP3=y
CONFIG_RT_USING_ISP_DDR_ADRESS=0x860000
CONFIG_RT_USING_ISP_DDR_SIZE=0x600000
...
CONFIG_RT_USING_CAMERA=y
```

另外文档里已经点出来的，还有：

- `CONFIG_RT_USING_SC3338=y`
- `CONFIG_RT_USING_RK_BATTERY_IPC=y`
- `CONFIG_RT_USING_META_DDR_ADRESS=0x800000`

所以这条路径可以概括为：

- MCU 使用 RT-Thread
- 打开 ISP3、CAMERA、SC3338、battery-ipc
- meta 区在 `0x800000`
- 共享 ISP/AE 数据区在 `0x860000`

---

## 2.6 ISP 驱动什么时候把共享内存地址塞进来

这是在 ISP 驱动初始化阶段做的：

```2911:2952:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/bsp/rockchip/common/drivers/isp3/drv_isp3.c
int rk_device_isp_init(void)
{
...
    struct config_param *param = &g_param;
    struct isp_init_info *isp_mem_config = &param->isp;
...
    isp_mem_config->share_mem_addr = RT_USING_ISP_DDR_ADRESS;
    isp_mem_config->share_mem_size = RT_USING_ISP_DDR_SIZE;
...
    ret = rk_isp_register(rk_ispdev, rk_ispdev->name);
...
}

INIT_DEVICE_EXPORT(rk_device_isp_init);
```

也就是说：

- 全局 `g_param.isp.share_mem_addr = 0x860000`
- `g_param.isp.share_mem_size = 0x600000`

这是后面 `stream.c` 能直接拿到共享内存地址的来源。

---

## 2.7 真正的应用入口：`isp_stream()`

`stream.c` 里的 `isp_stream()` 是 MCU 应用主入口。它通过 `INIT_APP_EXPORT(isp_stream)` 自动注册，在 `rt_application_init()` 时触发。

它的上层逻辑就是：

```text
rt_application_init()
-> isp_stream()
   -> start_stream()
   -> 预览/拉帧循环
   -> stop_stream()
   -> mailbox 通知 AP
   -> 关 cache / WFI
```

虽然你这次读出来的片段没直接含 `INIT_APP_EXPORT` 那一行，但从你的两份文档和现有源码上下文是一致的，这个函数就是 MCU 快启主业务入口。

---

## 2.8 `isp_stream()` 主流程怎么走

在 `stream.c` 中，能看到 `isp_stream()` 先拿共享内存、找到设备，然后开始快启：

```364:441:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/applications/battery-ipc/stream.c
extern struct config_param g_param;

static int isp_stream(void)
{
    struct config_param *param = &g_param;
    struct shared_data *share = (struct shared_data *)param->isp.share_mem_addr;
    static rk_device *dev;
...
    options.share = share;
```

### 关键步骤 1：`start_stream()`

```180:286:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/applications/battery-ipc/stream.c
static ret_err_t start_stream(rk_device *dev, struct config_param *param)
{
...
    ret = rk_device_open(dev, RT_DEVICE_OFLAG_RDWR);
...
    ret = rk_device_control(dev, RK_DEVICE_CTRL_ISP_SET_FMT, &options.pixformat);
...
    ret = rk_device_control(dev, RK_DEVICE_CTRL_ISP_REQBUF, &reqbuf);
...
    for (index = 0; index < reqbuf.count; index++)
        rk_device_control(dev, RK_DEVICE_CTRL_ISP_QBUF, &buf);
...
    tid = rt_thread_create("firstae_thread", firstae_thread, &firstae_param, 4096, RT_THREAD_PRIORITY_MAX / 2, 10);
...
    ret = rk_device_control(&subdev->parent, RK_DEVICE_CTRL_CAMERA_STREAM_ON, RK_NULL);
...
    ret = rk_semaphore_take(sem, RK_WAITING_FOREVER);
...
    ret = rk_device_control(dev, RK_DEVICE_CTRL_ISP_STREAM_ON, RK_NULL);
...
    ret = rk_device_control(&subdev->parent, RK_DEVICE_CTRL_CAMERA_STREAM_ON_LATE, RK_NULL);
#endif
    start_ae(dev, &subdev->parent);
```

这一步做的是：

1. 打开 ISP 设备
2. 配输出格式
3. 申请/入队 buffer
4. 启一个 `firstae_thread`
5. 先让 sensor stream on
6. 等待 `set_firstae()` 完成
7. 再让 ISP stream on
8. 启动 fast AE 线程

---

## 2.9 `set_firstae()` 是 MCU 主流程里最关键的一步

这个函数基本就是 thunder boot 快启的核心准备阶段：

```1637:1739:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/applications/battery-ipc/fast_ae.c
int32_t set_firstae(rk_device *isp, rk_device *sensor, struct shared_data *share, rt_sem_t *sem)
{
...
    // 1. PARSE META & AE PARAMS
    ret = parse_meta_params(&g_main_calib, &g_secondary_calib, &g_sensor_init, &g_secondary_sensor_init, &g_app_param, &g_fastae_init);

    g_fastae_init.is_hdr = (g_app_param.cam_hdr > NO_HDR) ? true : false;
    parse_ae_params(&g_main_calib, &g_fastae_init, g_iq_bin_mode);

    // 2 INIT SENSOR CONFIG
    if (g_sensor_init.cam_w && g_sensor_init.cam_h)
    {
        g_param.sensor.width = g_sensor_init.cam_w;
        g_param.sensor.height = g_sensor_init.cam_h;
...
        rt_device_control(sensor, RK_DEVICE_CTRL_CID_MATCH_CAM_CONFIG, &cam_config);
    }
...
    // 3. CALC & SET INIT EXPOSURE
    set_ae_init(sensor, &g_fastae_init, &g_sensor_init);
...
    rt_device_control(sensor,
                      RK_DEVICE_CTRL_CAMERA_SET_EXP_VAL,
                      &gInitExp.exp);

    // 4. ISP PARAMS FOR RTT
...
    set_params(isp, &isp_params);
...
    rk_semaphore_release(*sem);
```

把它拆开理解：

### 第一步：解析 U-Boot 准备好的 meta / IQ / app 参数
调用：
- `parse_meta_params()`
- `parse_ae_params()`

### 第二步：根据 meta 参数给 sensor 匹配配置
例如：
- 分辨率
- fps
- HDR
- mirror/flip

### 第三步：计算首帧曝光并立刻下发给 sensor
调用：
- `set_ae_init()`
- `RK_DEVICE_CTRL_CAMERA_SET_EXP_VAL`

### 第四步：提前把一批 ISP 参数下发给 RTT/共享内存
最后 `set_params(isp, &isp_params)`，并把信号量释放给 `start_stream()`

---

## 2.10 `parse_meta_params()` 是怎么等 U-Boot 的

这里很关键，它不是一开机就盲读，而是要等 U-Boot 通知“meta 数据准备好了”。

```832:875:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/applications/battery-ipc/fast_ae.c
int32_t parse_meta_params(...)
{
    struct meta_head *metahead_p = (struct meta_head *)(RT_USING_META_DDR_ADRESS);
...
#ifndef RT_USING_RK_AOV
    int i = 200;

    while (--i >= 0)
    {
        rt_hw_cpu_dcache_ops(RT_HW_CACHE_INVALIDATE, (void *)metahead_p, sizeof(struct meta_head));
        if ((sirq_status() == RT_TRUE) && (metahead_p->meta_flags == META_READ_DONE_FLAG))
        {
            metahead_p->meta_flags = 0;
            rt_hw_cpu_dcache_ops(RT_HW_CACHE_FLUSH, (void *)metahead_p, sizeof(struct meta_head));
            break;
        }
        HAL_DelayMs(1);
    }
    RT_ASSERT(i >= 0);
#endif
```

也就是说 MCU 在这里会轮询：

- `sirq_status() == RT_TRUE`
- `meta_flags == META_READ_DONE_FLAG`

这两个都满足，才开始读 meta 区。

---

## 2.11 fast AE 线程是怎么起来的

`start_ae()` 会起两个线程：

```767:794:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/applications/battery-ipc/fast_ae.c
int32_t start_ae(rk_device *isp, rk_device *sensor)
{
...
    tid = rt_thread_create("exp_thread", exp_thread, config, 4096, RT_THREAD_PRIORITY_MAX / 2, 10);
...
    tid = rt_thread_create("stat_thread", stat_thread, config, 4096, RT_THREAD_PRIORITY_MAX / 2, 10);
...
    gConfig = config;
    return 0;
}
```

这两个线程职责通常是：

- `exp_thread`：在合适时序把曝光/增益写给 sensor
- `stat_thread`：从 ISP 读取统计值，跑 fast AE / AWB 收敛

---

## 2.12 主线程什么时候停

在你前面文档和 `stream.c` 逻辑里，这条线是：

```text
isp_stream()
-> start_stream()
-> 循环 DQBUF/QBUF
-> 检查 isae_match() / isae_over_range()
-> 满足收敛条件或超范围/达到帧数上限
-> stop_stream()
```

`isae_match()` / `isae_over_range()` 最终就是看 `gConfig` 里的收敛状态：

```797:841:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/applications/battery-ipc/fast_ae.c
int32_t isae_match()
{
    struct iq_config *config = gConfig;
...
        return config->is_match;
...
}

int32_t isae_over_range()
{
    struct iq_config *config = gConfig;
...
        return config->is_over_range;
...
}
```

---

## 2.13 `stop_stream()` / `stop_ae()` 干了什么

停流收尾主要在这两步。

### `stop_stream()`
```288:318:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/applications/battery-ipc/stream.c
static void stop_stream(rk_device *dev, struct config_param *param, bool is_normal)
{
    struct shared_data *share = (struct shared_data *)param->isp.share_mem_addr;
...
    stop_ae(rkisp);
...
    rk_device_control(dev, RK_DEVICE_CTRL_ISP_STREAM_OFF, &is_force);
    rk_device_close(dev);

    share->complete = is_normal ? STREAM_OK : STREAM_NG;
...
    rt_hw_cpu_dcache_ops(RT_HW_CACHE_FLUSH, (void *)share, sizeof(struct shared_data) * share->camera_num);
}
```

### `stop_ae()`
```795:831:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/applications/battery-ipc/fast_ae.c
int32_t stop_ae(struct rk_isp_dev *ispdev)
{
...
    //ISP PARAMS FOR KERNEL
    gShare->md_flag = g_ae_md;
    gShare->width = g_sensor_init.cam_w;
    gShare->height = g_sensor_init.cam_h;
    set_isp_params_for_kernel(gShare, &g_main_calib, g_is_ie_effect, g_iq_bin_mode);
...
    config->stat_exit = 1;
...
    config->exp_exit = 1;
...
    rt_free(config);
    gConfig = NULL;
```

这一步最重要的是：

- 把最终 AE/AWB/ISP 参数整理进共享内存 `shared_data`
- 结束 `stat_thread`、`exp_thread`
- 让 Linux 后续接管时，直接用这些已经收敛过的初值

---

## 2.14 MCU 主流程总结成一条调用链

你可以把 MCU 工程主链路记成这条：

```text
Loader/SPL 释放 HPMCU
-> main()
-> rtthread_startup()
-> rt_hw_board_init()
   -> 安装 softirq
   -> CSI/DPHY/VICAP 板级初始化
   -> 设备注册
-> rt_application_init()
   -> isp_stream() 自动运行
      -> start_stream()
         -> open isp
         -> set fmt / reqbuf / qbuf
         -> firstae_thread -> set_firstae()
            -> parse_meta_params()
            -> parse_ae_params()
            -> sensor config
            -> set_ae_init()
            -> set initial exposure
            -> set initial isp params
         -> sensor stream on
         -> isp stream on
         -> start_ae()
            -> exp_thread
            -> stat_thread
      -> 主循环抓帧
         -> DQBUF/QBUF
         -> isae_match()/isae_over_range()
      -> stop_stream()
         -> stop_ae()
         -> 写共享内存结果
      -> mailbox 通知 AP
      -> 进入 wfi
```

---

# 三、固件如何被加载

这个问题要分成两个层次：

1. **MCU 固件本身如何被 loader/U-Boot 释放运行**
2. **MCU 运行后，启动参数 / IQ / meta 又是如何被 U-Boot 加载给 MCU 的**

---

## 3.1 MCU 固件本身如何被加载

前面已经看到，rkbin ini 里 MCU 固件是 `LOADER2=Hpmcu`，加载地址是 `0x40000`：

```10:18:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/uboot/rkbin/RKBOOT/RV1106MINIALL_EMMC_TB.ini
[LOADER_OPTION]
NUM=3
LOADER1=FlashData
LOADER2=Hpmcu
LOADER3=FlashBoot
...
[LOADER2_PARAM]
LOAD_ADDR=0x40000
FLAG=0x10007
```

U-Boot/SPL 阶段在 RV1106 平台上，会通过 `spl_fit_standalone_release()` 释放 MCU：

```548:566:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/uboot/u-boot/arch/arm/mach-rockchip/rv1106/rv1106.c
int spl_fit_standalone_release(char *id, uintptr_t entry_point)
{
	if (!strcmp(id, "mcu0")) {
		/* set the mcu uncache area, usually set the devices address */
		writel(0xff000, CORE_GRF_BASE + CORE_GRF_CACHE_PERI_ADDR_START);
		writel(0xffc00, CORE_GRF_BASE + CORE_GRF_CACHE_PERI_ADDR_END);
		/* Reset the hp mcu */
		writel(0x1e001e, CORECRU_BASE + CORECRU_CORESOFTRST_CON01);
		/* set the mcu addr */
		writel(entry_point, CORE_SGRF_BASE + CORE_SGRF_HPMCU_BOOT_ADDR);
		/* release the mcu */
		writel(0x1e0000, CORECRU_BASE + CORECRU_CORESOFTRST_CON01);
	}
```

这段非常关键，说明加载动作本质是：

1. loader/SPL 把 MCU bin 放到指定内存
2. 设置 HPMCU boot address
3. 拉起/释放 HPMCU reset
4. MCU 开始从那个入口地址执行

所以“固件如何被加载”的第一层答案是：

**它作为 `Hpmcu` 段被 loader/SPL 装到内存，并通过 `CORE_SGRF_HPMCU_BOOT_ADDR` 设置入口，然后释放 HPMCU 复位开始跑。**

---

## 3.2 U-Boot 如何把 meta / IQ / 参数加载给 MCU

这是第二层，也是 fastboot 能跑起来的关键。

在 `rk_meta.c` 的 `spl_load_meta()` 里，U-Boot 会从 `meta` 分区读取数据：

```145:183:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/uboot/u-boot/arch/arm/mach-rockchip/rk_meta.c
	/* load compress data */
	data = (char *)COMPRESS_LOAD_ADDR;
	meta_iq_item_size = meta_p->iq_item_size + meta.comp_size;
	if (meta_p->comp_type == META_COMPRESS_TYPE_GZ) {
...
		memcpy((void *)(meta_p->load + SENSOR_IQ_BIN_OFFSET), data, meta_p->iq_item_size);

		if (rk_meta_iq_decom((meta_p->load + meta_p->comp_off),
				     (unsigned long)(data + meta_p->comp_off -
							MAX_META_SEGMENT_SIZE),
					 meta.comp_size, &len)) {
...
	meta_p->meta_flags = META_READ_DONE_FLAG;
	flush_cache(meta_p->load, meta_p->size);
	rk_meta_process();
```

这里做了几件事：

1. 从 `meta` 分区读取 meta header、cmdline、压缩数据
2. 把 sensor IQ bin 拷到 `meta_p->load + SENSOR_IQ_BIN_OFFSET`
3. 必要时解压到指定内存
4. 设置：
   - `meta_p->meta_flags = META_READ_DONE_FLAG`
5. flush cache
6. 调 `rk_meta_process()`

---

## 3.3 `rk_meta_process()` 如何通知 MCU

在 RV1106 平台上，`rk_meta_process()` 是这么实现的：

```568:571:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/uboot/u-boot/arch/arm/mach-rockchip/rv1106/rv1106.c
void rk_meta_process(void)
{
	writel(0x00080008, CORE_GRF_BASE + CORE_GRF_MCU_CACHE_MISC);
}
```

这个写寄存器动作，会触发 MCU 侧 softirq。

而 MCU 侧已经在 `board_base.c` 里装好了 softirq 处理器：

```89:100:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/bsp/rockchip/rv1106-mcu/board/common/board_base.c
static rt_bool_t sirq = RT_FALSE;
static void board_softirq_handler(int vector, void *param)
{
    COREGRF->MCU_CACHE_MISC = 0x00080000;
    sirq = RT_TRUE;
}

rt_bool_t sirq_status(void)
{
    return sirq;
}
```

然后 `fast_ae.c` 的 `parse_meta_params()` 再去轮询这个状态：

```844:853:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/mcu/rt-thread/applications/battery-ipc/fast_ae.c
    while (--i >= 0)
    {
        rt_hw_cpu_dcache_ops(RT_HW_CACHE_INVALIDATE, (void *)metahead_p, sizeof(struct meta_head));
        if ((sirq_status() == RT_TRUE) && (metahead_p->meta_flags == META_READ_DONE_FLAG))
        {
            metahead_p->meta_flags = 0;
            rt_hw_cpu_dcache_ops(RT_HW_CACHE_FLUSH, (void *)metahead_p, sizeof(struct meta_head));
            break;
        }
```

所以 meta / IQ / app 参数的加载交接链路是：

```text
U-Boot spl_load_meta()
-> 从 meta 分区读出 meta/IQ/参数
-> 拷贝到 DDR 共享内存
-> meta_flags = META_READ_DONE_FLAG
-> rk_meta_process() 写寄存器
-> MCU softirq 触发
-> sirq_status() 变 true
-> parse_meta_params() 看到 flag 和 sirq
-> MCU 开始解析并使用这些参数
```

---

## 3.4 MCU 自己使用的是哪些共享内存地址

结合 defconfig 和驱动初始化：

- `RT_USING_META_DDR_ADRESS = 0x800000`
- `RT_USING_ISP_DDR_ADRESS = 0x860000`
- `RT_USING_ISP_DDR_SIZE = 0x600000`

其中：

- `0x800000`：meta / IQ / app 参数区域
- `0x860000`：MCU 写给 Linux 的 `shared_data` / ISP 参数 / AE 结果区域

---

# 四、给你一个最终版“从编译到运行”的总时序

如果把整个链路串起来，可以理解成这样：

```text
BoardConfig 指定:
  RK_ENABLE_FASTBOOT=y
  RK_UBOOT_RKBIN_MCU_CFG=rv1106_evb-SC3338-ADC

顶层 build.sh:
  -> build_mcu(rv1106_evb-SC3338-ADC)
     -> sysdrv/source/mcu/build.sh lunch rv1106_evb-SC3338-ADC
     -> scons 编译 RT-Thread BSP
     -> 生成 rtthread.bin
  -> 修改 rkbin ini 的 Hpmcu=
  -> make uboot，用 overlay ini 打包 loader

启动时:
  -> loader/SPL 装载 Hpmcu 到内存
  -> 设置 HPMCU boot addr
  -> 释放 HPMCU reset
  -> MCU 从 main() 开始跑 RT-Thread

RT-Thread:
  -> rt_hw_board_init()
     -> softirq handler 安装
     -> CSI/DPHY/VICAP 初始化
     -> ISP/camera 驱动注册
  -> rt_application_init()
     -> isp_stream() 自动启动

U-Boot 另一侧:
  -> 从 meta 分区加载 meta / IQ / cmdline
  -> 数据放到 0x800000 一带
  -> meta_flags = META_READ_DONE_FLAG
  -> 写 CORE_GRF_MCU_CACHE_MISC 通知 MCU

MCU 应用:
  -> start_stream()
  -> set_firstae()
     -> parse_meta_params()
     -> parse_ae_params()
     -> 设置 sensor 格式/HDR/FPS
     -> 设置首帧曝光
     -> 设置初始 ISP 参数
  -> ISP/sensor stream on
  -> start_ae()
     -> exp_thread
     -> stat_thread
  -> 跑若干帧直到 AE 收敛
  -> stop_ae()
     -> 把结果写入 shared_data(0x860000)
  -> 通知 AP/Linux
  -> MCU 进入 wfi
```

---

# 五、直接回答你的 3 个问题

## 1）这个 MCU 工程在该 BoardConfig 下如何编译、如何打包

- 由 `project/build.sh` 在 `build_uboot()` 阶段触发 `build_mcu()`
- `build_mcu()` 进入 `sysdrv/source/mcu/build.sh`
- 选择 `rv1106_evb-SC3338-ADC/defconfig`
- 用 `scons -C rt-thread/bsp/rockchip/rv1106-mcu` 编译
- 生成 `rtthread.bin`
- 顶层构建把 rkbin ini 中的 `Hpmcu=` 替换成该 `rtthread.bin`
- 然后作为 loader 的 `LOADER2=Hpmcu` 被打包进 boot/download 镜像

## 2）整个 MCU 工程结构、主流程、入口函数、调用链

- 工程结构：`project/` 构建 + `rt-thread/` 源码
- 系统入口：`main()` -> `rtthread_startup()`
- 板级入口：`rt_hw_board_init()`
- 设备注册：`INIT_DEVICE_EXPORT(...)`，例如 ISP 驱动
- 应用入口：`isp_stream()`
- 主调用链：
  - `isp_stream()`
  - `start_stream()`
  - `set_firstae()`
  - `start_ae()`
  - `exp_thread/stat_thread`
  - 主循环抓帧直到 `isae_match()`
  - `stop_stream()`
  - `stop_ae()`
  - 写共享内存、通知 AP、进入 `wfi`

## 3）固件如何被加载

分两部分：

### MCU 固件本身
- 作为 `Hpmcu` loader 段被装入内存
- `spl_fit_standalone_release()` 设置 `CORE_SGRF_HPMCU_BOOT_ADDR`
- 释放 HPMCU reset，MCU 开始执行

### MCU 运行需要的 meta / IQ / app 参数
- U-Boot 从 `meta` 分区读到 DDR
- 设置 `meta_flags = META_READ_DONE_FLAG`
- `rk_meta_process()` 写 `CORE_GRF_MCU_CACHE_MISC` 触发 softirq
- MCU 在 `parse_meta_params()` 里等到 softirq + flag 后开始解析使用

---

如果你愿意，我下一步可以继续帮你做两件很实用的事之一：

1. 画一张“MCU/U-Boot/Linux 三方交接时序图”
2. 单独把 `isp_stream() -> start_stream() -> set_firstae() -> start_ae()` 的函数级调用关系整理成树状图

你要的话我直接继续。

