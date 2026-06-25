# FreeRTOS fast image 快起流程分析

本文基于 `agent_docs` 与当前 SDK 源码整理。这里不按 JPEG/H264/H265 分别分析编码实现，而是说明源码中可确认的 fast image 主流程：**FreeRTOS 预初始化 camera 硬件链路，Linux 启动后映射共享 buffer 并接管相关中断**。

---

## 1. 核心结论

当前 SDK 的 fast image 流程可以概括为：

```text
FSBL 初始化 transfer_config
  -> FreeRTOS 小核启动
  -> FreeRTOS 在 Linux 之前 start_camera(0)
  -> sensor / MIPI / CIF / VI / ISP 硬件链路提前初始化
  -> Linux cvi-fast-image 驱动 probe
  -> Linux 通过 mailbox 获取 transfer_config 地址
  -> Linux 映射同一批物理 buffer
  -> Linux 需要接管时通知 RTOS stop ISR
  -> Linux enable ISP/JPU/VPU IRQ，后续 stream 回到 Linux 媒体栈
```

因此，fast image 更准确的理解是：

- FreeRTOS 负责 camera 硬件链路预初始化。
- FSBL/RTOS/Linux 通过 `transfer_config_t` 共享 buffer 地址和 fast image 类型。
- Linux 启动后不是从 RTOS 拷贝图片，而是映射同一批物理 buffer。
- Linux 通过 `cvi_stop_fast_image()` / `FAST_IMAGE_SEND_STOP_REC` 执行接管。
- 当前源码没有呈现为 RTOS 侧完整预拍多帧、持续 stream 出图、按具体编码格式完整编码输出的流程。

---

## 2. fast image 类型档位

`fast_image.h` 中定义：

```80:95:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/driver/fast_image/include/fast_image.h
enum E_IMAGE_TYPE {
	E_FAST_NONE = 0,
	E_FAST_JEPG = 1,
	E_FAST_H264,
	E_FAST_H265,
};

enum _MUC_STATUS_E {
	MCU_STATUS_NONOS_INIT = 1,
	MCU_STATUS_NONOS_RUNNING,
	MCU_STATUS_NONOS_DONE,
	MCU_STATUS_RTOS_T1_INIT,  // before linux running
	MCU_STATUS_RTOS_T1_RUNNING,
	MCU_STATUS_RTOS_T2_INIT,  // after linux running
	MCU_STATUS_RTOS_T2_RUNNING,
```

| `CONFIG_FAST_IMAGE_TYPE` | 枚举 | 含义 |
|---:|---|---|
| `0` | `E_FAST_NONE` | 不启用 fast image |
| `1` | `E_FAST_JEPG` | fast image 类型标记为 JPEG |
| `2` | `E_FAST_H264` | fast image 类型标记为 H264 |
| `3` | `E_FAST_H265` | fast image 类型标记为 H265 |

这些值在当前源码中首先是 fast image 类型标记和使能条件，不应直接理解为 RTOS 侧已经完整实现三套独立编码出图流程。

当前 `.config` 中：

```303:308:/home/nopiskl/tmp/duo-buildroot-sdk-v2/build/.config
# RTOS options
#
# CONFIG_ENABLE_BOOT0 is not set
CONFIG_ENABLE_FREERTOS=y
CONFIG_ENABLE_RTOS_DUMP_PRINT=y
CONFIG_DUMP_PRINT_SZ_IDX=17
CONFIG_FAST_IMAGE_TYPE=0
```

当前默认配置启用了 FreeRTOS，但未启用 fast image。

---

## 3. 编译开关与构建影响

当 `CONFIG_FAST_IMAGE_TYPE > 0` 时，FreeRTOS 构建会定义 `FAST_IMAGE_ENABLE`：

```27:29:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/driver/CMakeLists.txt
if (CONFIG_FAST_IMAGE_TYPE STRGREATER "0")
add_compile_definitions(FAST_IMAGE_ENABLE)
endif()
```

主 task 链接库也会从普通协处理器模式扩展为包含 camera/VI/ISP/VCODEC：

```20:27:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/main/CMakeLists.txt
elseif (CHIP STREQUAL "cv181x" OR CHIP STREQUAL "cv180x")
if (CONFIG_FAST_IMAGE_TYPE STRGREATER "0")
    set(CVI_TASK_LIBS comm isp vi vcodec rgn audio camera)
else()
    set(CVI_TASK_LIBS comm rgn audio)
endif()
endif()
```

FreeRTOS heap 也会从 512 KiB 增加到 650 KiB。

---

## 4. FreeRTOS 启动阶段：提前拉起 camera 链路

FreeRTOS 的关键入口在 `main_cvirtos()`：

```137:154:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
void main_cvirtos(void)
{
	printf("create cvi task\n");

	request_irq(MBOX_INT_C906_2ND, prvQueueISR, 0, "mailbox", (void *)0);

#ifdef FAST_IMAGE_ENABLE
	start_camera(0);
#endif

	main_create_tasks();

	/* Start the tasks and timer running. */
	vTaskStartScheduler();
```

关键点：`start_camera(0)` 在 FreeRTOS scheduler 之前执行。也就是说，Linux 尚未完成启动时，小核已经开始初始化 camera 硬件链路。

`start_camera()` 主要完成：

- sensor 配置与初始化
- VI 配置
- ISP 创建
- CIF 初始化
- MIPI lane / pn_swap / clock / reset / dev attr 配置
- sensor 初始化回调

```252:274:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/driver/sensor/src/camera.c
	/************************************************
	 * step1:  Config VI
	 ************************************************/
	SAMPLE_COMM_VI_GetSensorInfo(&stViConfigSys);

	if (SensorInfoToViCfg(&SenInfo, &stViConfigSys) == CVI_FAILURE) {
		printf("SAMPLE_COMM_VI_InfoToViCfg failed\n");
		return;
	}
	/************************************************
	 * step2:  Config Sensor & ISP
	 ************************************************/
	if (SAMPLE_COMM_VI_StartSensor(&stViConfigSys) == CVI_FAILURE) {
		printf("SAMPLE_COMM_VI_StartSensor failed\n");
		return;
	}
	if (SAMPLE_COMM_VI_CreateIsp(&stViConfigSys) == CVI_FAILURE) {
		printf("SAMPLE_COMM_VI_CreateIsp failed\n");
		return;
	}
```

当前 ASIC 路径下 sensor 配置是示例式硬编码，默认 GC4653：

```137:148:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/driver/sensor/src/camera.c
	#else // test GC4653
	SENSOR_USR_CFG gc4653_info = {
		.name 		= "GCORE_GC4653_MIPI_4M_30FPS_10BIT",
		.devno 		= 0,
		.bus_id 	= 3,
		.slave_id	= 41,
		.lane_id	= {1, 2, 0, -1, -1},
		.pn_swap	= {1, 1, 1, 0, 0},
	};
	pSenCfg = &gc4653_info;
	SenInfo.header->dev_num = 1;
```

---

## 5. FreeRTOS 任务与 mailbox 角色

`comm_main.c` 中有 ISP、VCODEC、VI、CAMERA、RGN、CMDQU、AUDIO 等队列上下文。但当前 `riscv64/comm_main.c` 中 ISP、VCODEC、VI、CAMERA 的 `runTask` 为 `NULL`，实际创建执行任务的主要是 `RGN`、`CMDQU`、`AUDIO`。

```40:73:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
TASK_CTX_S gTaskCtx[E_QUEUE_MAX] = {
	{
		.name = "ISP",
		.stack_size = configMINIMAL_STACK_SIZE * 8,
		.priority = tskIDLE_PRIORITY + 3,
		.runTask = NULL,
		.queLength = 1,
		.queHandle = NULL,
	},
	{
		.name = "VCODEC",
		.stack_size = configMINIMAL_STACK_SIZE,
		.priority = tskIDLE_PRIORITY + 3,
		.runTask = NULL,
```

因此，当前 `comm_main.c` 更主要承担：

- 注册 mailbox 中断
- 创建通信队列
- 分发 Linux 发来的 mailbox 命令
- 响应系统级命令
- 把 `transfer_config` 地址返回给 Linux

Linux init done 的响应路径：

```235:240:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
			case SYS_CMD_INFO_LINUX_INIT_DONE:
				rtos_cmdq.cmd_id = SYS_CMD_INFO_RTOS_INIT_DONE;
				rtos_cmdq.param_ptr = &transfer_config;
				goto send_label;
				break;
```

---

## 6. 共享配置 `transfer_config_t`

FSBL 初始化 `transfer_config_t`，把 fast image 所需的物理地址和大小写入共享区域：

```8:29:/home/nopiskl/tmp/duo-buildroot-sdk-v2/fsbl/plat/cv181x/bl2/bl2_main.c
#ifdef RTOS_ENABLE_FREERTOS
int init_comm_info(int ret)
{
	struct transfer_config_t *transfer_config = (struct transfer_config_t *)MAILBOX_FIELD;
	struct transfer_config_t transfer_config_s;
	unsigned char *ptr = (unsigned char *)&transfer_config_s;
	unsigned short checksum = 0;
	/* mailbox field is 4 byte write access, and can not access byte by byte.
	 * so init parameters and copy all to mailbox field together.
	 */
	transfer_config_s.conf_magic = RTOS_MAGIC_HEADER;
	transfer_config_s.conf_size = ((uint64_t)&transfer_config_s.checksum - (uint64_t)&transfer_config_s.conf_magic);
	transfer_config_s.isp_buffer_addr = CVIMMAP_ISP_MEM_BASE_ADDR;
	transfer_config_s.isp_buffer_size = CVIMMAP_ISP_MEM_BASE_SIZE;
	transfer_config_s.encode_img_addr = CVIMMAP_H26X_BITSTREAM_ADDR;
	transfer_config_s.encode_img_size = CVIMMAP_H26X_BITSTREAM_SIZE;
	transfer_config_s.encode_buf_addr = CVIMMAP_H26X_ENC_BUFF_ADDR;
	transfer_config_s.encode_buf_size = CVIMMAP_H26X_ENC_BUFF_SIZE;
	transfer_config_s.dump_print_enable = RTOS_DUMP_PRINT_ENABLE;
	transfer_config_s.dump_print_size_idx = RTOS_DUMP_PRINT_SZ_IDX;
	transfer_config_s.image_type = RTOS_FAST_IMAGE_TYPE;
```

关键字段：

| 字段 | 作用 |
|---|---|
| `image_type` | fast image 类型档位 |
| `isp_buffer_addr/size` | ISP 相关共享 buffer |
| `encode_img_addr/size` | image buffer |
| `encode_buf_addr/size` | encode buffer |
| `mcu_status` | 小核状态 |
| `linux_status` | Linux 状态 |

---

## 7. Linux 获取共享 buffer 的方式

Linux 侧 `cvi-fast-image` probe 时，先向 RTOS 发送 `SYS_CMD_INFO_LINUX_INIT_DONE`，等待 `SYS_CMD_INFO_RTOS_INIT_DONE`：

```577:589:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	cmdq.ip_id = IP_SYSTEM;
	cmdq.cmd_id = SYS_CMD_INFO_LINUX_INIT_DONE;
	cmdq.param_ptr = 0;
	cmdq.resv.mstime = 200;
	ret = rtos_cmdqu_send_wait(&cmdq, SYS_CMD_INFO_RTOS_INIT_DONE);
	if (ret)
		pr_err("SYS_CMD_INFO_LINUX_INIT_DONE fail\n");
	mcu_transfer_config_offset = cmdq.param_ptr;
	pr_debug("mcu_transfer_config_offset = %x\n", mcu_transfer_config_offset);
	// get communication pa from rtos
	ret = cvi_allocate_mcu_shm(pdev);
	if (ret == 0)
		cvi_fast_image_ion_alloc();
```

如果 `image_type == E_FAST_NONE`，Linux 不继续 fast image buffer 处理：

```849:857:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	pr_debug("transfer_config->conf_size=%x\n", transfer_config->conf_size);
	pr_debug("transfer_config->isp_buffer_addr =%x\n", transfer_config->isp_buffer_addr);
	pr_debug("transfer_config->image_type =%x\n", transfer_config->image_type);

	if (transfer_config->image_type == E_FAST_NONE) {
		return -1;
	}
	return 0;
```

之后 Linux 按 `transfer_config` 中的地址映射/匹配 ION buffer。Linux 获取图像相关数据的方式可以概括为：

```text
RTOS/FSBL 提供共享 buffer 物理地址
Linux 通过 mailbox 获取 transfer_config 地址
Linux 映射 RTOS reserved memory
Linux 根据 transfer_config 映射同一批物理 buffer
Linux 通过 ioctl/exported symbol 查询 PA/VA/size
```

这不是大块图片数据通过 mailbox 从 RTOS 传给 Linux 的流程。

---

## 8. Linux 接管流程

Linux 接管 fast image 相关中断的入口是 `cvi_stop_fast_image()`：

```48:72:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
int cvi_stop_fast_image(void)
{
	// send command to rtos to stop irq
	cmdqu_t cmdq;
	int ret;

	cmdq.ip_id = IP_SYSTEM;
	cmdq.cmd_id = SYS_CMD_INFO_STOP_ISR;
	cmdq.param_ptr = 0;
	cmdq.resv.mstime = 100;
	// wait done
	ret = rtos_cmdqu_send_wait(&cmdq, SYS_CMD_INFO_STOP_ISR_DONE);
	if (ret)
		pr_err("SYS_CMD_INFO_STOP_ISR wait fail\n");
	pr_debug("%s enable_irq vcode h264 %d\n", __func__, vcodec_h264_irq);
	enable_irq(vcodec_h264_irq);
	pr_debug("%s enable_irq vcode h265 %d\n", __func__, vcodec_h265_irq);
	enable_irq(vcodec_h265_irq);
	pr_debug("%s enable_irq jpu %d\n", __func__, jpu_irq);
	enable_irq(jpu_irq);
	pr_debug("%s enable_irq isp %d\n", __func__, isp_irq);
	enable_irq(isp_irq);
```

RTOS 侧收到 `SYS_CMD_INFO_STOP_ISR` 后，按 VI、VCODEC 顺序推进停止：

```241:263:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
			case SYS_CMD_INFO_STOP_ISR:
				stop_ip = 0;
				rtos_cmdq.cmd_id = SYS_CMD_INFO_STOP_ISR;
				rtos_cmdq.ip_id = IP_VI;
				xQueueSend(gTaskCtx[E_QUEUE_VI].queHandle, &rtos_cmdq, 0U);
				break;
			case SYS_CMD_INFO_STOP_ISR_DONE:
				// stop interrupt in order to avoid losing frame
				if (rtos_cmdq.ip_id == IP_VI) {
					stop_ip |= STOP_CMD_DONE_VI;
					rtos_cmdq.ip_id = IP_VCODEC;
					rtos_cmdq.cmd_id = SYS_CMD_INFO_STOP_ISR;
					xQueueSend(gTaskCtx[E_QUEUE_VCODEC].queHandle, &rtos_cmdq, 0U);
					break;
				}
				if (rtos_cmdq.ip_id == IP_VCODEC)
					stop_ip |= STOP_CMD_DONE_VCODE;
```

接管流程：

```text
Linux -> RTOS: SYS_CMD_INFO_STOP_ISR
RTOS -> VI queue: stop ISR
RTOS -> VCODEC queue: stop ISR
RTOS -> Linux: SYS_CMD_INFO_STOP_ISR_DONE
Linux -> enable_irq(h264/h265/jpeg/isp)
```

文档中常说的 “takeoff” 更接近这个动作：Linux 启动后停止 RTOS fast image ISR，并重新打开 Linux 侧硬件中断处理。

---

## 9. Linux 启动后控制权

| 阶段 | sensor/MIPI/CIF/VI/ISP 状态 | 控制关系 |
|---|---|---|
| Linux 启动前 | FreeRTOS 调用 `start_camera(0)` 提前初始化 | FreeRTOS 负责预启动 |
| Linux fast_image probe 后 | Linux 获取 `transfer_config` 并映射 buffer | Linux 知道共享资源位置 |
| Linux stop fast image 后 | Linux enable ISP/JPU/VPU IRQ | 后续常规 stream 回到 Linux 媒体栈 |

默认设计不是 RTOS 永久独占 camera，而是：

```text
RTOS 先预初始化 camera 硬件链路
Linux 启动后获取共享 buffer 信息
Linux stop fast image 并接管后续 stream 控制
```

---

## 10. 当前源码能确认与不能确认的边界

源码可确认：

- `CONFIG_FAST_IMAGE_TYPE > 0` 会启用 `FAST_IMAGE_ENABLE`
- FreeRTOS 在 scheduler 前调用 `start_camera(0)`
- `start_camera()` 提前初始化 sensor/MIPI/CIF/VI/ISP 硬件链路
- FSBL/RTOS/Linux 通过 `transfer_config_t` 共享 fast image 配置和 buffer 地址
- Linux `cvi-fast-image` 驱动通过 mailbox 获取 `transfer_config`
- Linux 映射同一批物理 buffer 并提供 ioctl 查询
- Linux 可通过 `cvi_stop_fast_image()` 接管相关 IRQ

源码没有呈现为：

- RTOS 侧预拍多帧图像供 Linux 读取
- RTOS 侧通过 mailbox 传输图像数据给 Linux
- RTOS 侧持续承担 Linux 启动后的常规 stream 流程
- RTOS 侧按具体编码格式形成三套独立的完整快起出图流程

最终可以概括为：

> FreeRTOS 提前完成 camera 硬件链路预初始化，Linux 启动后通过共享 buffer 与 mailbox 握手获取 fast image 相关资源，并在 stop fast image 后接管后续 stream 与硬件中断控制。
