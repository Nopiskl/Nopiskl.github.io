# Fastboot operational modes analysis
_Exported on 2026/6/5 at GMT+8 12:06:39 from Cursor (2.6.21)_

---

**User**

@agent_docs/fastboot_design.md @agent_docs/fastboot.md 请你先结合这两份文档+SDK，分析一下快起有几种模式？每种模式分别是什么样的？例如Linux启动后takeoff 全程rtos接管等
注：文档信息可能有错，只用来参考，实际以具体SDK源码为准

---

**Cursor**

我会先把两份文档和 SDK 里的 fastboot/takeoff/RTOS 相关实现串起来核对，最后按“模式、启动链路、接管边界、适用场景、源码依据”总结。

接下来我会直接查 SDK 源码里的宏、状态机和 Linux 驱动接口，避免只复述文档里的结论。

全仓库搜索较大，我会缩小到 `freertos`、`fsbl`、`osdrv/interdrv/fast_image`、构建配置这些关键目录继续核对。

这些目录里有不少生成文件干扰，我会定位具体源码文件后逐个读取关键实现。

我会读取这些关键源码段来确认实际状态机和编译条件。

我还需要读配置下半部分、FSBL 初始化、以及 FreeRTOS 构建宏定义位置。

我会再补一轮针对性搜索：`CONFIG_FAST_IMAGE_TYPE` 是在哪里转换成 `RTOS_FAST_IMAGE_TYPE/FAST_IMAGE_ENABLE`，以及 `takeoff` 在这个 SDK 是否真实存在。

我已经定位到 `start_camera` 与堆大小配置，继续读取实现细节。

我会用更精确的命令在少数构建脚本中查一次宏来源，主要确认 `CONFIG_FAST_IMAGE_TYPE` 到 FSBL/FreeRTOS 编译宏的映射。

为了确认宏映射，我会在构建脚本里做一次限定范围的文本检索。

`rg` 在这个环境里没有安装；我会改用专用搜索工具并把范围缩到具体目录/文件。

我会查看 FSBL 和 FreeRTOS 的实际编译命令/生成配置，因为这些宏可能是在构建系统命令行里注入的。

我还会读一下 Linux `fast_image` 模块 probe/init 部分，确认 Linux 上线后如何标记状态、是否存在“完全接管”的代码路径。

我会查看 Linux 初始化结尾和相关设备树/模块配置，判断 fast_image 模块什么时候生效。

我会读取 DTS 中 `rtos_image` 节点和实际编译命令中宏，补齐证据。

结论先说：按这个 SDK 源码看，“快起”不是很多套完全独立方案，而是围绕 `CONFIG_ENABLE_FREERTOS` + `CONFIG_FAST_IMAGE_TYPE` 形成的几类运行形态。严格以源码为准，可分为 **3 大类 / 5 个配置档位**：

1. **无 FreeRTOS / NonOS 小核阶段**
2. **FreeRTOS 常驻协处理器模式，但不启用 fast image**
3. **FreeRTOS fast image 快起模式**
   - `JPEG`
   - `H264`
   - `H265`

其中你提到的“Linux 启动后 takeoff、全程 RTOS 接管”等，源码里我没有搜到名为 `takeoff` 的实际实现或开关；比较接近的是 **Linux probe 后通过 `fast_image` 驱动通知 RTOS 停止 ISR，然后 Linux 重新 enable VPU/JPU/ISP IRQ，完成资源/中断接管**。所以“takeoff”更像文档/口头描述，不是这个 SDK 里的源码概念名。

---

## 1. 源码里的总开关

当前工程实际配置在 `build/.config`：

```274:281:/home/nopiskl/tmp/duo-buildroot-sdk-v2/build/.config
# RTOS options
#
# CONFIG_ENABLE_BOOT0 is not set
CONFIG_ENABLE_FREERTOS=y
CONFIG_ENABLE_RTOS_DUMP_PRINT=y
CONFIG_DUMP_PRINT_SZ_IDX=17
CONFIG_FAST_IMAGE_TYPE=0
```

也就是说当前 SDK 配置是：

- 启用 FreeRTOS：`CONFIG_ENABLE_FREERTOS=y`
- 不启用 fast image：`CONFIG_FAST_IMAGE_TYPE=0`

所以当前实际是 **FreeRTOS 常驻协处理器模式，不是快起 camera 模式**。

---

## 2. fast image 的类型枚举

RTOS 和 Linux 两边共用的 `fast_image.h` 定义了图像类型：

```78:83:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/driver/fast_image/include/fast_image.h
enum E_IMAGE_TYPE {
	E_FAST_NONE = 0,
	E_FAST_JEPG = 1,
	E_FAST_H264,
	E_FAST_H265,
};
```

注意源码里拼写是 `E_FAST_JEPG`，不是 `JPEG`，应该是 typo，但实际枚举值是 `1`。

因此 `CONFIG_FAST_IMAGE_TYPE` 的语义基本是：

| `CONFIG_FAST_IMAGE_TYPE` | 源码枚举 | 含义 |
|---:|---|---|
| `0` | `E_FAST_NONE` | 不启用 fast image |
| `1` | `E_FAST_JEPG` | JPEG 快起 |
| `2` | `E_FAST_H264` | H264 快起 |
| `3` | `E_FAST_H265` | H265 快起 |

---

## 3. 状态机：T1/T2 的真实含义

源码中的状态定义如下：

```85:95:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/driver/fast_image/include/fast_image.h
enum _MUC_STATUS_E {
	MCU_STATUS_NONOS_INIT = 1,
	MCU_STATUS_NONOS_RUNNING,
	MCU_STATUS_NONOS_DONE,
	MCU_STATUS_RTOS_T1_INIT,  // before linux running
	MCU_STATUS_RTOS_T1_RUNNING,
	MCU_STATUS_RTOS_T2_INIT,  // after linux running
	MCU_STATUS_RTOS_T2_RUNNING,
	MCU_STATUS_LINUX_INIT,
	MCU_STATUS_LINUX_RUNNING,
};
```

这里比较关键：

- `RTOS_T1`：Linux 起来之前
- `RTOS_T2`：Linux 起来之后

不过在当前源码里，`MCU_STATUS_RTOS_T1_RUNNING` 明确被写入了，但我没有看到完整可靠地写 `RTOS_T2_RUNNING` 的路径。文档里说的 T2 状态可能是设计意图，但以当前源码看，Linux init done 后主要发生的是消息握手和资源映射，而不是完整状态切换。

RTOS CMDQU 任务启动时会标记 T1 running：

```144:145:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
	/* set mcu_status to type1 running*/
	transfer_config.mcu_status = MCU_STATUS_RTOS_T1_RUNNING;
```

Linux 上线后，会发送 `SYS_CMD_INFO_LINUX_INIT_DONE`，RTOS 回复 `SYS_CMD_INFO_RTOS_INIT_DONE`，把 `transfer_config` 地址回传给 Linux：

```235:239:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
			case SYS_CMD_INFO_LINUX_INIT_DONE:
				rtos_cmdq.cmd_id = SYS_CMD_INFO_RTOS_INIT_DONE;
				rtos_cmdq.param_ptr = &transfer_config;
				goto send_label;
				break;
```

Linux 侧 probe 里就是这么握手的：

```573:584:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	// TODO: send wait with block mode to freertos
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
```

---

# 快起/运行模式详解

## 模式 A：NonOS / 无 FreeRTOS 小核阶段

### 触发条件

理论上是 `CONFIG_ENABLE_FREERTOS` 未开启，或者 FSBL 没有带 `RTOS_ENABLE_FREERTOS` 编译宏。

### 形态

这个模式下，源码里的 `transfer_config` 初始化逻辑不会启用，FreeRTOS 的 `main_cvirtos()` 也不会作为小核常驻系统运行。

FSBL 里只有在 `RTOS_ENABLE_FREERTOS` 打开时才初始化通信结构：

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
	transfer_config_s.mcu_status = MCU_STATUS_NONOS_DONE;
```

### 是否 camera 快起？

不是。这个形态不是源码里 fast image 的主路径。

### 是否 Linux 接管？

不是 fast image 意义上的接管。它更像启动早期/裸机阶段。

---

## 模式 B：FreeRTOS 常驻协处理器模式，fast image 关闭

### 触发条件

当前 SDK 就是这个模式：

```text
CONFIG_ENABLE_FREERTOS=y
CONFIG_FAST_IMAGE_TYPE=0
```

对应 `image_type = E_FAST_NONE`。

### 启动流程

1. FSBL 初始化 `transfer_config`
2. 小核启动 FreeRTOS
3. FreeRTOS 注册 mailbox 中断
4. 不执行 `start_camera()`
5. 创建任务
6. Linux 起来后通过 mailbox 和 RTOS 交互

RTOS 主入口：

```118:136:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
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

关键点是：`start_camera(0)` 只有定义 `FAST_IMAGE_ENABLE` 才会编译进去。当前 `CONFIG_FAST_IMAGE_TYPE=0`，所以按设计它不会启用。

### 运行状态

RTOS 常驻，作为 Linux 的协处理器/实时任务处理端。任务包括：

```31:100:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
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
		.queLength = 1,
		.queHandle = NULL,
	},
	{
		.name = "VI",
		.stack_size = configMINIMAL_STACK_SIZE,
		.priority = tskIDLE_PRIORITY + 3,
		.runTask = NULL,
		.queLength = 1,
		.queHandle = NULL,
	},
```

但注意：很多任务 `runTask = NULL`，真正创建执行任务的主要是 `RGN`、`CMDQU`、`AUDIO` 等；VI/VCODEC/ISP 队列存在，但并不一定有独立任务函数。

### 是否 Linux 接管？

这个模式不是“快起后接管”，因为没有 fast image。Linux 是主系统，RTOS 是协处理器。

### 一句话总结

这是 **RTOS 常驻协处理模式**，不是 camera 快起模式。

---

## 模式 C：FreeRTOS fast image 快起模式（统一流程，编码类型仅是配置档位）

### 触发条件

```text
CONFIG_ENABLE_FREERTOS=y
CONFIG_FAST_IMAGE_TYPE=1/2/3
```

其中：

| `CONFIG_FAST_IMAGE_TYPE` | `image_type` | 配置语义 |
|---:|---|---|
| `1` | `E_FAST_JEPG` | JPEG fast image |
| `2` | `E_FAST_H264` | H264 fast image |
| `3` | `E_FAST_H265` | H265 fast image |

需要强调：从当前 SDK 源码看，`CONFIG_FAST_IMAGE_TYPE=1/2/3` 首先决定的是 `transfer_config.image_type` 和是否定义 `FAST_IMAGE_ENABLE`。它们不应被理解为当前源码已经完整实现了 RTOS 侧 JPEG/H264/H265 出图/编码闭环。

### 源码确认的 fast image 主流程

以当前源码为准，fast image 的真实流程更适合按“RTOS 预初始化 + Linux 映射共享 buffer + Linux 接管”理解，而不是按 JPEG/H264/H265 拆成三套独立流程。

整体链路如下：

```text
FSBL
  初始化 transfer_config：
    isp_buffer_addr / isp_buffer_size
    encode_img_addr / encode_img_size
    encode_buf_addr / encode_buf_size
    image_type = CONFIG_FAST_IMAGE_TYPE
  启动 FreeRTOS 小核

FreeRTOS T1，Linux 尚未完成启动：
  main_cvirtos()
    request_irq(mailbox)
    start_camera(0)              # FAST_IMAGE_ENABLE 时才执行
      初始化 sensor
      初始化 MIPI/CIF
      初始化 VI/ISP 基础链路
      sensor 开始 streaming 到硬件链路
    main_create_tasks()
    vTaskStartScheduler()

Linux 启动后：
  cvi-fast-image probe
    发送 SYS_CMD_INFO_LINUX_INIT_DONE
    RTOS 回复 SYS_CMD_INFO_RTOS_INIT_DONE + transfer_config 地址
    Linux 映射 RTOS reserved memory
    Linux 校验 transfer_config
    Linux 根据 transfer_config 映射/匹配 ISP、IMG、ENC ION buffer
    用户态或其他驱动可 ioctl 查询 buffer 地址/大小
    需要接管时调用 FAST_IMAGE_SEND_STOP_REC / cvi_stop_fast_image()
      Linux 通知 RTOS stop ISR
      Linux enable h264/h265/jpeg/isp IRQ
```

### FreeRTOS 侧实际做了什么？

RTOS 快起 camera 的入口是 `main_cvirtos()` 中的 `start_camera(0)`：

```124:126:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
#ifdef FAST_IMAGE_ENABLE
	start_camera(0);
#endif
```

`start_camera()` 会提前初始化 camera 硬件链路。ASIC 默认路径下当前源码 hardcode 了 GC4653，另有 IMX327 的 `#if 0` 测试路径：

```130:140:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/driver/sensor/src/camera.c
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

因此 FreeRTOS 确认做了：

- sensor 信息配置与 sensor 驱动初始化
- MIPI/CIF 初始化
- VI/ISP 基础链路初始化
- sensor clock/reset/MIPI dev attr 配置
- Linux 前的 camera 硬件链路预启动
- mailbox 通信任务与 `transfer_config` 地址回传

但当前源码没有看到完整实现：

- RTOS 侧持续从 VI/ISP 取帧
- RTOS 侧缓存多帧图像
- RTOS 侧预拍 N 张图供 Linux 读取
- RTOS 侧完整处理 `SYS_CMD_INFO_DUMP_JPG`
- RTOS 侧按 `E_FAST_JEPG/H264/H265` 分支完成对应编码输出

一个关键证据是 RTOS 侧 `SYS_CMD_INFO_DUMP_JPG` 为空实现：

```223:226:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
			case SYS_CMD_INFO_DUMP_JPG:
				break;
			case SYS_CMD_INFO_DUMP_EN:
				dump_uart_enable();
```

另外，当前 `gTaskCtx` 中 ISP/VI/VCODEC/CAMERA 队列存在，但 `runTask` 是 `NULL`，真正创建 task 的主要是 `RGN`、`CMDQU`、`AUDIO`。这也说明当前 `comm_main.c` 本身并没有挂上完整的 RTOS stream pipeline。

### Linux 如何从 FreeRTOS 获取图像/Buffer？

Linux 不是通过 mailbox 从 RTOS 拷贝图片，而是通过 mailbox 获取 `transfer_config` 地址，再映射同一批物理 buffer。

Linux probe 时发送 `SYS_CMD_INFO_LINUX_INIT_DONE`：

```573:584:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	// TODO: send wait with block mode to freertos
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
```

RTOS 回复 `&transfer_config`：

```235:239:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
			case SYS_CMD_INFO_LINUX_INIT_DONE:
				rtos_cmdq.cmd_id = SYS_CMD_INFO_RTOS_INIT_DONE;
				rtos_cmdq.param_ptr = &transfer_config;
				goto send_label;
				break;
```

Linux 映射并校验 `transfer_config`，如果 `image_type == E_FAST_NONE` 就返回；只有 fast image 类型不为 0 时才继续：

```803:807:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	pr_debug("transfer_config->image_type =%x\n", transfer_config->image_type);

	if (transfer_config->image_type == E_FAST_NONE) {
		return -1;
	}
```

之后 Linux 根据 `transfer_config` 中的物理地址匹配 ION buffer。以 `encode_img` 为例：

```814:824:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	if (transfer_config->encode_img_size) {
		img_ion.size = transfer_config->encode_img_size;
		ret = sys_ion_alloc(&img_ion.phys_addr, (void *)&img_ion.virt_base,
							 "fast_image_img", img_ion.size, 0);
		if (ret)
			pr_err("img_ion_fd alloc size(%llx)=%d fail\n", img_ion.size, ret);
		if (img_ion.phys_addr != transfer_config->encode_img_addr) {
			pr_err("img_ionbuf->paddr = %llx is not match transfer_config->encode_img_addr = %x\n",
				img_ion.phys_addr, transfer_config->encode_img_addr);
			cvi_fast_image_img_ion_free();
```

因此 Linux “获取图”的准确说法是：

```text
FreeRTOS/FSBL 提供共享 buffer 物理地址
Linux 获取 transfer_config
Linux 映射同一批物理 buffer
Linux 通过 ioctl/exported symbol 查询这些 buffer 的 PA/VA/size
```

当前源码没有证明存在“RTOS 通过 mailbox 把图片传给 Linux”的路径。

### Linux 接管点，也就是文档里所谓 takeoff

文档里说的 takeoff，最接近源码中的 `cvi_stop_fast_image()`：

```54:76:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
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
```

其设计含义是：

1. Linux 通知 RTOS 停止 fast image 相关 ISR
2. RTOS 依次通知 VI / VCODEC 停 ISR
3. Linux 重新 enable `h264/h265/jpeg/isp` 中断
4. 后续常规 stream / sensor / ISP 控制应回到 Linux 媒体栈

RTOS 侧 stop ISR 流程：

```240:258:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
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

不过当前源码存在疑点：`VI` 和 `VCODEC` 的 `runTask` 是 `NULL`，如果没有其他版本/条件编译补齐，那么 stop ISR 队列消息未必有人消费。这说明接管链路在当前公开源码中可能不完整，或者依赖其他分支/闭源部分。

### 对当前 fast image 实现程度的准确判断

当前 SDK fast image 更准确的实现状态是：

- 已实现/可确认：
  - fast image 配置类型与 `FAST_IMAGE_ENABLE`
  - RTOS 启动前 camera 硬件链路预初始化
  - `transfer_config` 共享配置
  - Linux fast_image probe 握手
  - Linux 映射共享/ION buffer
  - Linux 查询 buffer 地址/大小
  - Linux stop ISR / enable IRQ 接管框架

- 未在当前源码中看到完整闭环：
  - RTOS 侧预拍多帧图像
  - RTOS 侧持续 stream 出图
  - RTOS 侧按 JPEG/H264/H265 完整编码输出
  - RTOS 侧把图像元信息可靠返回给 Linux

因此，不能把 `CONFIG_FAST_IMAGE_TYPE=1/2/3` 分别描述为三套已经完整工作的 RTOS JPEG/H264/H265 快起出图流程。更准确的说法是：

> `CONFIG_FAST_IMAGE_TYPE=1/2/3` 是 fast image 的编码类型配置档位；当前源码确认的核心能力是 RTOS 预初始化 camera 硬件链路和 Linux 侧共享 buffer/中断接管，RTOS 侧完整出图、预拍照、编码闭环在当前源码中没有明确实现。

---

# 这几种模式的对比表

| 模式 | 配置 | Linux 启动前谁工作 | Linux 启动后关系 | Camera 是否快起 | 编码/出图实现状态 |
|---|---|---|---|---|---|
| NonOS / 无 FreeRTOS | `CONFIG_ENABLE_FREERTOS=n` 或 FSBL 未启 RTOS | 裸机/启动早期逻辑 | 不走 fast_image 主路径 | 否 | 无 |
| RTOS 协处理器 | `CONFIG_ENABLE_FREERTOS=y`, `CONFIG_FAST_IMAGE_TYPE=0` | FreeRTOS 启动，注册 mailbox，建任务 | Linux 主控，RTOS 协处理 | 否 | 无 |
| RTOS fast image | `CONFIG_FAST_IMAGE_TYPE=1/2/3` | RTOS `start_camera()` 先启 sensor/MIPI/CIF/VI/ISP | Linux 通过 fast_image 握手、映射 buffer、stop ISR 后接管 IRQ | 是，偏硬件链路预初始化 | 类型标记为 JPEG/H264/H265；当前源码未看到 RTOS 侧完整 stream/预拍/编码闭环 |

---

# 关于“RTOS 独占”和“Linux 接管”

## 1. RTOS 独占模式

源码里没有看到一个明确的、产品化的 `RTOS exclusive` / `RTOS only camera` 模式开关。

但从系统行为上，可以人为形成类似“RTOS 独占”：

- 启用 fast image
- RTOS 提前初始化 camera 硬件链路
- Linux 不加载/不使用 `fast_image` 驱动
- Linux 不发送 `SYS_CMD_INFO_LINUX_INIT_DONE`
- Linux 不调用 `FAST_IMAGE_SEND_STOP_REC`
- Linux 不接管 ISP/JPU/VPU IRQ

但这不是 SDK 明确抽象出来的模式，而是“不让 Linux 接管”的部署方式。并且以当前源码看，RTOS 侧完整 stream/预拍/编码闭环并不明确，因此不应直接理解为一个可产品化的“RTOS 全程出图模式”。

## 2. 快起后 Linux 接管模式

这是源码里最明确支持的路径：

- RTOS 先启动 camera
- Linux fast_image probe
- Linux 与 RTOS 通过 mailbox 握手
- Linux 映射共享 buffer
- Linux 通过 ioctl 获取地址/内容
- Linux 发送 stop ISR
- Linux enable 自己的 VPU/JPU/ISP IRQ

对应关键 ioctl：

```22:35:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/driver/fast_image/include/fast_image.h
	FAST_SEND_STOP_REC = CMDQU_SYSTEM_LIMIT,
	FAST_SEND_QUERY_ISP_PADDR,
	FAST_SEND_QUERY_ISP_VADDR,
	FAST_SEND_QUERY_ISP_SIZE,
	FAST_SEND_QUERY_ISP_CTXT,
	FAST_SEND_QUERY_IMG_PADDR,
	FAST_SEND_QUERY_IMG_VADDR,
	FAST_SEND_QUERY_IMG_SIZE,
	FAST_SEND_QUERY_IMG_CTXT,
	FAST_SEND_QUERY_ENC_PADDR,
	FAST_SEND_QUERY_ENC_VADDR,
	FAST_SEND_QUERY_ENC_SIZE,
	FAST_SEND_QUERY_ENC_CTXT,
	FAST_SEND_QUERY_FREE_ISP_ION,
```

---

# 文档与源码不一致/需要谨慎的点

## 1. `takeoff` 不是源码概念

我在 SDK 源码里没有找到 `takeoff` 文件、函数或宏。文档里如果说“takeoff”，大概率是对“Linux 接管 RTOS 快起资源”的流程描述，而非源码模块名。

## 2. T2 状态文档可能过度描述

状态枚举有：

```text
MCU_STATUS_RTOS_T2_INIT
MCU_STATUS_RTOS_T2_RUNNING
```

但当前关键源码里只明确看到：

```c
transfer_config.mcu_status = MCU_STATUS_RTOS_T1_RUNNING;
```

Linux init done 后 RTOS 回复了 `SYS_CMD_INFO_RTOS_INIT_DONE`，但我没有看到明确设置 `MCU_STATUS_RTOS_T2_RUNNING` 的路径。因此 T2 可能是设计预留，或者在其他分支/闭源部分实现。

## 3. VI/VCODEC stop ISR 可能不完整

`cvi_stop_fast_image()` 会让 RTOS 停 VI/VCODEC ISR，但当前 `gTaskCtx` 中 `VI` / `VCODEC` 的 `runTask` 是 `NULL`。这意味着当前公开源码看起来不完整，或者依赖其他条件编译/版本补齐。

## 4. 当前 `start_camera()` 是示例硬编码

ASIC 默认是 GC4653，IMX327 在 `#if 0`。所以文档里如果描述为通用 sensor 配置，和当前源码实际不完全一致。

---

# 最终归纳

如果按“用户能选择的 fast image 类型档位”来讲，是 **4 种档位**：

1. `FAST_IMAGE_TYPE=0`：不开 fast image
2. `FAST_IMAGE_TYPE=1`：fast image 类型标记为 JPEG
3. `FAST_IMAGE_TYPE=2`：fast image 类型标记为 H264
4. `FAST_IMAGE_TYPE=3`：fast image 类型标记为 H265

注意：`1/2/3` 在当前源码中首先是类型标记和 fast image 使能条件，不代表 RTOS 侧完整 JPEG/H264/H265 出图/编码流程已经闭环。

如果按“系统运行形态”来讲，是 **3 类模式**：

1. **无 RTOS / NonOS 早期阶段**
2. **RTOS 常驻协处理器，Linux 主控，无 camera 快起**
3. **RTOS 先快起 camera，Linux 启动后通过 fast_image 接管/协同**

你举的例子里：

- **“Linux 启动后 takeoff”**：对应源码中的 `fast_image` probe + `SYS_CMD_INFO_LINUX_INIT_DONE` + `cvi_stop_fast_image()` + Linux enable IRQ。
- **“全程 RTOS 接管”**：源码没有独立模式开关，只能通过产品集成方式让 Linux 不接管来实现；不是 SDK 明确定义的标准模式。
- **“RTOS 快起后 Linux 接管”**：这是 SDK fast image 最核心、最明确的设计路径。

