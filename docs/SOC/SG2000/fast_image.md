
---

**User**

先不管具体编码格式
freertos/cvitek/task/comm/src/riscv64/comm_main.c
我需要你着重于这几点分析
1、Freertos具体干了什么，让Linux具有快速启动功能？比如是否有ISP预热、预拍几份图让Linux读取等方面？
2、Linux具体做了什么，从freertos那里获取图？在Linux启动后，sensor、isp等控制劝是否还在linux上？

---

**Cursor**

我会围绕 `riscv64/comm_main.c` 的实际控制流，再对照 Linux `fast_image.c`，把“FreeRTOS 提前做了什么”和“Linux 上来后如何拿资源/接管控制权”分开说明。

我再补一段 Linux 侧共享内存/ION 映射和模块初始化代码，确认 Linux 是“读 FreeRTOS 图”还是“拿到同一物理 buffer 的 Linux 映射”。

下面先只围绕你指定的 `freertos/cvitek/task/comm/src/riscv64/comm_main.c`，再结合 Linux 侧 `osdrv/interdrv/fast_image/fast_image.c` 来回答这两个问题。

## 总体结论

从当前 SDK 源码看，FreeRTOS 让 Linux 具备“快速启动图像能力”的核心不是在 `comm_main.c` 里做复杂算法，而是做了三类事情：

1. **Linux 启动前提前初始化 camera 硬件链路**  
   `main_cvirtos()` 在 FreeRTOS scheduler 启动前调用 `start_camera(0)`，提前初始化 sensor、MIPI/CIF、VI、ISP，使 camera 链路在 Linux 启动过程中已经开始工作。

2. **通过共享内存 `transfer_config` 把 fast image buffer 地址告诉 Linux**  
   FreeRTOS/FSBL/Linux 共用 `transfer_config_t`，Linux 启动后通过 mailbox 向 FreeRTOS 要这个结构地址，然后映射同一批物理 buffer。

3. **Linux 启动后通过 `fast_image` 驱动接管相关中断/资源**  
   Linux 发送 `SYS_CMD_INFO_STOP_ISR` 给 FreeRTOS，理论上让 FreeRTOS 停掉 VI/VCODEC 等中断处理，然后 Linux `enable_irq()`，让 ISP/JPU/VPU 等中断回到 Linux 控制。

但是，**当前源码中没有看到 FreeRTOS 明确“预拍几份图给 Linux 读取”的完整实现**。Linux 侧有查询/dump 图像的接口，但 RTOS 侧 `SYS_CMD_INFO_DUMP_JPG` 是空实现。因此：

- **有 camera/ISP 预初始化、预启动、预 streaming 的框架。**
- **有共享 buffer 交接框架。**
- **没有在当前源码中看到完整的“FreeRTOS 预拍 N 张图 -> Linux 读取 N 张图”的闭环。**

---

# 1. FreeRTOS 具体干了什么，让 Linux 具有快速启动功能？

## 1.1 `comm_main.c` 中最关键动作：scheduler 前调用 `start_camera(0)`

`riscv64/comm_main.c` 的核心入口是：

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

这说明 fast image 模式下，FreeRTOS 做的第一件关键事情是：

```text
先注册 mailbox IRQ
然后立即 start_camera(0)
再创建任务
最后启动 FreeRTOS scheduler
```

这个顺序很重要。`start_camera(0)` 不是普通 FreeRTOS task 里异步跑的，而是在调度器启动前同步执行。这意味着 Linux 还没起来时，小核已经把 camera 链路拉起来了。

所以 FreeRTOS 对“快起”的最大贡献是：

> 把 Linux 本来要做的 camera sensor/MIPI/CIF/VI/ISP 初始化提前到 C906 FreeRTOS 阶段做。

---

## 1.2 `start_camera()` 做了 camera 链路预初始化，某种意义上就是“ISP 预热”

虽然你这次重点是 `comm_main.c`，但 `comm_main.c` 里真正影响 camera 的调用只有 `start_camera(0)`，所以必须看它的效果。

`start_camera()` 后半段做了：

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

这里至少包括：

- 获取 VI sensor 配置。
- 根据 sensor 信息填 VI 配置。
- `SAMPLE_COMM_VI_StartSensor()` 启动 sensor 抽象层。
- `SAMPLE_COMM_VI_CreateIsp()` 创建 ISP pipeline。

然后继续：

```275:330:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/driver/sensor/src/camera.c
	/************************************************
	 * step3:  Start ISP driver
	 ************************************************/
	SAMPLE_COMM_VI_GetDevAttrBySns(pSenCfg->devno, *pSnsType, &stViDevAttr);
	CVI_VI_SetDevAttr(pSenCfg->devno, &stViDevAttr);
	/************************************************
	 * step4:  Sensor streaming
	 ************************************************/
	/*
	 * do cif init
	*/
	if (cif_open(&SenInfo) != CVI_SUCCESS) {
		printf("cif init fail\n");
		return;
	}

	// update rx_attr
	stDevAttr.input_mode = SenInfo.vi_mode;
	SenInfo.pstSnsObj->pfnGetRxAttr(pSenCfg->devno, &stDevAttr);

	stDevAttr.devno = pSenCfg->devno;
	// stDevAttr.img_size.width = SenInfo.width;
	// stDevAttr.img_size.height = SenInfo.height;
	SenInfo.width = stDevAttr.img_size.width;
	SenInfo.height = stDevAttr.img_size.height;
	stDevAttr.mclk.cam = (pSenCfg->mclk_en > 0) ? (pSenCfg->mclk_en - 1) : 0;
	if (SenInfo.vi_mode == INPUT_MODE_MIPI) {
		if (pSenCfg->hs_settle) {
			stDevAttr.mipi_attr.dphy.hs_settle = pSenCfg->hs_settle;
			stDevAttr.mipi_attr.dphy.enable = 1;
		}
	}
	for (i = 0; i < SEN_MAX_LANE_NUM; i++) {
		if (SenInfo.vi_mode == INPUT_MODE_MIPI) {
			stDevAttr.mipi_attr.lane_id[i] = pSenCfg->lane_id[i];
			stDevAttr.mipi_attr.pn_swap[i] = pSenCfg->pn_swap[i];
		} else if (SenInfo.vi_mode == INPUT_MODE_SUBLVDS) {
			stDevAttr.lvds_attr.lane_id[i] = pSenCfg->lane_id[i];
		}
	}

	cif_ioctl(pSenCfg->devno, CVI_MIPI_RESET_SENSOR, 0);
	cif_ioctl(pSenCfg->devno, CVI_MIPI_RESET_MIPI, 0);
	cif_ioctl(pSenCfg->devno, CVI_MIPI_SET_DEV_ATTR, (unsigned long) &stDevAttr);
	cif_ioctl(pSenCfg->devno, CVI_MIPI_ENABLE_SENSOR_CLOCK, 0);
	udelay(20);
	// cif_ioctl(pSenCfg->devno, CVI_MIPI_UNRESET_SENSOR, 0);
	// mdelay(20);

	SenInfo.pstSnsObj->pfnExpSensorCb(&stSnsrSensorFunc);
	if (stSnsrSensorFunc.pfn_cmos_sensor_init)
		stSnsrSensorFunc.pfn_cmos_sensor_init(pSenCfg->devno);
```

这里继续做：

- 设置 VI device attr。
- 初始化 CIF。
- 获取 sensor RX 属性。
- 配置 MIPI lane id。
- 配置 PN swap。
- reset sensor。
- reset MIPI。
- 设置 MIPI dev attr。
- enable sensor clock。
- 调 sensor 驱动初始化寄存器。

所以可以说，FreeRTOS 做了 **camera pipeline 预初始化**。如果把“ISP 预热”理解为：

- sensor 提前上电；
- MIPI 提前开始收流；
- VI/ISP 相关硬件提前初始化；
- Linux 起来时不用从冷态初始化 camera；

那么源码上是支持这个结论的。

但如果把“ISP 预热”理解为：

- 3A 算法已经跑了一段时间；
- AE/AWB 已经收敛；
- ISP 已经缓存多帧；
- Linux 读取时直接拿稳定画面；

那当前源码里没有看到明确证据。

---

## 1.3 FreeRTOS 创建了哪些 task？真正处理 camera 的 task 在当前文件中并没有挂上

`comm_main.c` 定义了这些队列：

```40:94:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
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

继续看 VI/CAMERA：

```54:73:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
	{
		.name = "VI",
		.stack_size = configMINIMAL_STACK_SIZE,
		.priority = tskIDLE_PRIORITY + 3,
		.runTask = NULL,
		.queLength = 1,
		.queHandle = NULL,
	},
	{
		.name = "CAMERA",
		.stack_size = configMINIMAL_STACK_SIZE,
		.priority = tskIDLE_PRIORITY + 3,
		.runTask = NULL,
```

真正有 `runTask` 的是：

```75:94:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
	{
		.name = "RGN",
		.stack_size = configMINIMAL_STACK_SIZE,
		.priority = tskIDLE_PRIORITY + 3,
		.runTask = prvRGNRunTask,
		.queLength = 10,
		.queHandle = NULL,
	},
	{
		.name = "CMDQU",
		.stack_size = configMINIMAL_STACK_SIZE,
		.priority = tskIDLE_PRIORITY + 5,
		.runTask = prvCmdQuRunTask,
```

以及 AUDIO：

```95:102:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
	{
		.name = "AUDIO",
		.stack_size = configMINIMAL_STACK_SIZE*15,
		.priority = tskIDLE_PRIORITY + 3,
		.runTask = prvAudioRunTask,
		.queLength = 10,
		.queHandle = NULL,
```

所以当前 `riscv64/comm_main.c` 中：

| 队列 | 是否创建 queue | 是否创建 task |
|---|---:|---:|
| ISP | 是 | 否，`runTask=NULL` |
| VCODEC | 是 | 否，`runTask=NULL` |
| VI | 是 | 否，`runTask=NULL` |
| CAMERA | 是 | 否，`runTask=NULL` |
| RGN | 是 | 是 |
| CMDQU | 是 | 是 |
| AUDIO | 是 | 是 |

这说明当前这个文件本身主要负责：

- Mailbox 通信；
- CMDQU 命令收发；
- RGN/AUDIO task；
- fast image 模式下在 scheduler 前启动 camera。

它**没有**在这个文件中启动一个“持续采图 task”或“预拍 N 帧 task”。

---

## 1.4 是否“预拍几份图让 Linux 读取”？

从 `comm_main.c` 看，**没有明确实现**。

最接近“让 Linux 读取图”的命令是 `SYS_CMD_INFO_DUMP_JPG`，但 RTOS 侧处理是空的：

```223:226:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
			case SYS_CMD_INFO_DUMP_JPG:
				break;
			case SYS_CMD_INFO_DUMP_EN:
				dump_uart_enable();
```

Linux 侧确实有 `FAST_IMAGE_QUERY_DUMP_JPG_INFO`、`FAST_IMAGE_QUERY_DUMP_JPG` 这类接口，但 RTOS 侧这里没有返回图片元信息。

因此源码层面结论是：

> 当前 `comm_main.c` 没有实现“预拍几份图让 Linux 读取”。它只预留了 dump jpg 命令入口，但实现为空。

如果后续某些库或闭源对象里补了逻辑，那另说；但以当前源码树看，没有证据。

---

## 1.5 FreeRTOS 真正给 Linux 的“快起价值”是什么？

以当前源码看，它给 Linux 的价值更像是：

```text
冷启动 camera 初始化时间
    从 Linux 阶段转移到 RTOS/Linux 并行启动阶段
```

也就是：

- Linux 正在解压/启动内核/加载驱动时；
- C906 FreeRTOS 已经初始化 sensor/MIPI/CIF/ISP；
- Linux 上来后通过 fast_image 驱动拿到共享 buffer 地址；
- 然后 Linux 接管中断和后续控制。

所以这不是简单“RTOS 拍几张图放那儿”，而是：

> RTOS 先把 camera 硬件链路跑起来，Linux 上来后少做冷启动工作，并复用 RTOS 阶段已经建立的 buffer/硬件状态。

但目前“复用已经拍好的图”这部分源码不完整。

---

# 2. Linux 具体做了什么，从 FreeRTOS 那里获取图？

## 2.1 Linux 不是通过 mailbox 拷贝图片，而是拿共享物理 buffer 的映射

Linux `fast_image` 驱动 probe 时：

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

流程是：

1. Linux 发送 `SYS_CMD_INFO_LINUX_INIT_DONE`。
2. FreeRTOS 回复 `SYS_CMD_INFO_RTOS_INIT_DONE`。
3. 回复参数 `param_ptr` 是 `&transfer_config`。
4. Linux 根据这个地址去映射 MCU shared memory。
5. Linux 根据 `transfer_config` 里面的物理地址重新获取/映射 ION buffer。

FreeRTOS 侧对应代码：

```235:240:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
			case SYS_CMD_INFO_LINUX_INIT_DONE:
				rtos_cmdq.cmd_id = SYS_CMD_INFO_RTOS_INIT_DONE;
				rtos_cmdq.param_ptr = &transfer_config;
				goto send_label;
				break;
```

所以 Linux 并不是“向 FreeRTOS 请求图片数据，然后 FreeRTOS 通过 mailbox 把图片发过来”。

正确理解是：

> FreeRTOS 告诉 Linux：我的 `transfer_config` 在哪里；Linux 再从 `transfer_config` 中拿到 fast image buffer 的物理地址，并映射这些同一块物理内存。

---

## 2.2 Linux 映射 `transfer_config`

Linux 侧 `cvi_allocate_mcu_shm()` 先映射 RTOS reserved memory：

```790:822:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	res = platform_get_resource(pdev, IORESOURCE_MEM, 0);
	if (res == NULL) {
		pr_err("failed to retrieve rtos region\n");
		return -ENXIO;
	}
	pr_debug("res->start=%pa res->end=%pa\n", &res->start, &res->end);
	s_mcu_shm.phys_addr = res->start;
	s_mcu_shm.size = (res->end - res->start + 1);

#if (KERNEL_VERSION(5, 10, 0) <= LINUX_VERSION_CODE)
#ifdef __LP64__
	s_mcu_shm.virt_base = (u64)devm_ioremap(&pdev->dev, res->start,
							res->end - res->start + 1);
```

然后用 `mcu_transfer_config_offset` 计算 Linux 侧虚拟地址：

```832:841:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	if (mcu_transfer_config_offset == 0) {
		pr_err("communicate with rtos fail\n");
		return -1;
	}
#ifdef __LP64__
	transfer_config = (struct transfer_config_t *)
		 (s_mcu_shm.virt_base + mcu_transfer_config_offset - s_mcu_shm.phys_addr);
#else
	transfer_config = (struct transfer_config_t *)
```

之后校验 magic 和 checksum，并检查 `image_type`：

```846:853:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	} else {
		pr_err("transfer_config->conf_magic fail (%x)\n", transfer_config->conf_magic);
		return -1;
	}
	pr_debug("transfer_config->magic=%x\n", transfer_config->conf_magic);
	pr_debug("transfer_config->conf_size=%x\n", transfer_config->conf_size);
	pr_debug("transfer_config->isp_buffer_addr =%x\n", transfer_config->isp_buffer_addr);
	pr_debug("transfer_config->image_type =%x\n", transfer_config->image_type);
```

若 `image_type == E_FAST_NONE`，直接返回：

```855:857:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	if (transfer_config->image_type == E_FAST_NONE) {
		return -1;
	}
```

---

## 2.3 Linux 获取“图”的方式：查询或映射这些 buffer

Linux 侧 fast image ioctl 支持查询三类 buffer：

### ISP buffer

```308:329:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	case FAST_IMAGE_QUERY_ISP_PADDR:
		addr = cvi_fast_image_isp_buf_pa();
		pr_debug("FAST_IMAGE_QUERY_ISP_PADDR %llx\n", addr);
		ret = copy_to_user((phys_addr_t __user *)arg,
		&addr,
		sizeof(phys_addr_t));
		break;
	case FAST_IMAGE_QUERY_ISP_VADDR:
		addr = cvi_fast_image_isp_buf_va();
		pr_debug("FAST_IMAGE_QUERY_ISP_VADDR %llx\n", addr);
		ret = copy_to_user((phys_addr_t __user *)arg,
		&addr,
		sizeof(phys_addr_t));
		break;
	case FAST_IMAGE_QUERY_ISP_SIZE:
```

### encode image buffer

```341:363:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	case FAST_IMAGE_QUERY_IMG_PADDR:
		addr = cvi_fast_image_encode_img_pa();
		pr_debug("FAST_IMAGE_QUERY_IMG_PADDR %llx\n", addr);
		ret = copy_to_user((phys_addr_t __user *)arg,
		&addr,
		sizeof(struct cmdqu_t));
		break;
	case FAST_IMAGE_QUERY_IMG_VADDR:
		addr = cvi_fast_image_encode_img_va();
		pr_debug("FAST_IMAGE_QUERY_IMG_VADDR %llx\n", addr);
		ret = copy_to_user((phys_addr_t __user *)arg,
		&addr,
		sizeof(phys_addr_t));
		break;
```

### encode bitstream buffer

```375:398:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	case FAST_IMAGE_QUERY_ENC_PADDR:
		addr = cvi_fast_image_encode_buf_pa();
		pr_debug("FAST_IMAGE_QUERY_ENC_PADDR %llx\n", addr);
		ret = copy_to_user((phys_addr_t __user *)arg,
		&addr,
		sizeof(phys_addr_t));
		break;
	case FAST_IMAGE_QUERY_ENC_VADDR:
		addr = cvi_fast_image_encode_buf_va();
		pr_debug("FAST_IMAGE_QUERY_ENC_VADDR %llx\n", addr);
		ret = copy_to_user((phys_addr_t __user *)arg,
		&addr,
		sizeof(phys_addr_t));
		break;
```

所以 Linux “从 FreeRTOS 获取图”的实际方式是：

```text
FreeRTOS/FSBL 共享 transfer_config
  -> Linux 获取 transfer_config 地址
  -> Linux 从 transfer_config 读取物理 buffer 地址
  -> Linux 用 ION/ioremap 映射这些物理地址
  -> Linux 或用户态通过 ioctl 查询这些地址/内容
```

不是 mailbox 传输图片。

---

## 2.4 Linux 侧 ION 映射要求物理地址必须匹配

Linux 重新获取 fast image buffer 时，要求分配到的物理地址和 `transfer_config` 中一致：

```860:876:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
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
		} else
			pr_debug("img_ion phys_addr = %llx virt_base = %llx size =%llx\n",
```

这进一步说明 Linux 读取的是**同一块物理内存**，不是 FreeRTOS 拷贝过来的新内存。

---

# 3. Linux 启动后 sensor、ISP 等控制权还在 Linux 上吗？

## 3.1 意图上：Linux 启动后要接管 ISP/JPU/VPU/VI 相关中断

Linux 侧 `cvi_stop_fast_image()` 是接管动作：

```66:85:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
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
```

然后 enable IRQ：

```80:89:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	enable_irq(vcodec_h264_irq);
	pr_debug("%s enable_irq vcode h265 %d\n", __func__, vcodec_h265_irq);
	enable_irq(vcodec_h265_irq);
	pr_debug("%s enable_irq jpu %d\n", __func__, jpu_irq);
	enable_irq(jpu_irq);
	pr_debug("%s enable_irq isp %d\n", __func__, isp_irq);
	enable_irq(isp_irq);
```

这说明 Linux 接管的至少包括：

- H264 IRQ
- H265 IRQ
- JPU/JPEG IRQ
- ISP IRQ

Linux fast image 模块初始化时，会临时 probe 这些设备拿 IRQ，并设置 `IRQ_NOAUTOEN`：

```630:663:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
static int vpu_probe(struct platform_device *pdev)
{
	const struct of_device_id *match;

	pr_debug("%s\n", __func__);
	match = of_match_device(cvi_vpu_match_table, &pdev->dev);
	if (!match)
		return -EINVAL;

	vcodec_h264_irq = GetIrq(pdev, "h264");
	if (vcodec_h264_irq < 0) {
		pr_err("vcodec h264 irq = %d\n", vcodec_h264_irq);
		return -EINVAL;
	}

	irq_set_status_flags(vcodec_h264_irq, IRQ_NOAUTOEN);
```

JPU 和 VIP/ISP 也是同样：

```668:705:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
static int jpu_probe(struct platform_device *pdev)
{
	const struct of_device_id *match;

	pr_debug("%s\n", __func__);
	match = of_match_device(cvi_jpu_match_table, &pdev->dev);
	if (!match)
		return -EINVAL;

	jpu_irq = GetIrq(pdev, "jpeg");
	if (jpu_irq < 0) {
		pr_err("jpu irq = %d\n", jpu_irq);
		return -EINVAL;
	}

	irq_set_status_flags(jpu_irq, IRQ_NOAUTOEN);

	return 0;
}

static int vip_probe(struct platform_device *pdev)
{
```

```693:708:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	isp_irq = GetIrq(pdev, "isp");
	if (isp_irq < 0) {
		pr_err("isp irq = %d\n", isp_irq);
		return -EINVAL;
	}

	irq_set_status_flags(isp_irq, IRQ_NOAUTOEN);

	return 0;
}
```

也就是说，fast image 模式下 Linux 的策略是：

```text
先不要自动打开 ISP/JPU/VPU IRQ
等 RTOS 停止 fast image ISR 后
Linux 再 enable_irq()
```

这就是“控制权交接”。

---

## 3.2 RTOS 侧如何响应 Linux 接管请求？

Linux 发 `SYS_CMD_INFO_STOP_ISR`，RTOS 侧处理：

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

停止完成标志定义为：

```10:14:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/include/comm_def.h
#define STOP_CMD_DONE_NONE      0x00
#define STOP_CMD_DONE_ISP       0x01
#define STOP_CMD_DONE_VI        0x02
#define STOP_CMD_DONE_VCODE     0x04
#define STOP_CMD_DONE_ALL       (STOP_CMD_DONE_VI | STOP_CMD_DONE_VCODE)
```

注意这里 `STOP_CMD_DONE_ALL` 只包含：

- VI
- VCODEC

不包含 ISP，虽然有 `STOP_CMD_DONE_ISP` 定义。

因此当前交接流程设计是：

```text
Linux -> RTOS: SYS_CMD_INFO_STOP_ISR
RTOS -> VI queue: stop ISR
VI -> RTOS CMDQU: SYS_CMD_INFO_STOP_ISR_DONE, ip=IP_VI
RTOS -> VCODEC queue: stop ISR
VCODEC -> RTOS CMDQU: SYS_CMD_INFO_STOP_ISR_DONE, ip=IP_VCODEC
RTOS -> Linux: SYS_CMD_INFO_STOP_ISR_DONE
Linux -> enable_irq(h264/h265/jpu/isp)
```

但是一个很关键的问题是：当前 `gTaskCtx` 中 `VI` 和 `VCODEC` 的 `runTask` 都是 `NULL`。也就是说：

- 队列存在；
- 但没有创建 VI/VCODEC task；
- `xQueueSend()` 之后是否有人消费，当前文件里看不到。

因此，**这个接管流程在当前源码中看起来也是框架/预留，完整性存疑**。如果外部库或别的初始化代码没有补上 VI/VCODEC task，Linux 等 `SYS_CMD_INFO_STOP_ISR_DONE` 可能超时。

---

## 3.3 Linux 启动后 sensor/ISP 控制权到底在哪？

分阶段看更准确。

### 阶段 A：Linux 未启动或 fast image 未 stop 前

控制权主要在 FreeRTOS 侧。

理由：

- FreeRTOS 先调用 `start_camera(0)`。
- FreeRTOS 初始化 sensor/MIPI/CIF/ISP。
- Linux 此时尚未正常加载完整 camera stack。
- Linux fast image 驱动还没发 stop 命令。

所以这一阶段：

| 资源 | 控制方 |
|---|---|
| sensor 初始化 | FreeRTOS |
| MIPI/CIF 初始化 | FreeRTOS |
| VI/ISP early init | FreeRTOS |
| fast image buffer 写入 | 理论上 FreeRTOS |
| Linux | 尚未接管 |

### 阶段 B：Linux `cvi-fast-image` probe 后

Linux 做了：

- 和 RTOS 握手；
- 获取 `transfer_config`；
- 映射 shared memory；
- 分配/映射 fast image ION buffer；
- 注册 `/dev/cvi-fast-image`。

这时候 Linux 已经知道图像 buffer 在哪里，但不一定已经接管 camera 硬件控制权。

### 阶段 C：Linux 调用 `FAST_IMAGE_SEND_STOP_REC` 或 `cvi_stop_fast_image()`

这时才进入真正接管：

```300:304:/home/nopiskl/tmp/duo-buildroot-sdk-v2/osdrv/interdrv/fast_image/fast_image.c
	switch (cmd) {
	case FAST_IMAGE_SEND_STOP_REC:
		pr_debug("FAST_IMAGE_SEND_STOP_REC\n");
		cvi_stop_fast_image();
		break;
```

接管完成后：

| 资源 | 控制方 |
|---|---|
| ISP IRQ | Linux |
| JPU IRQ | Linux |
| VPU H264/H265 IRQ | Linux |
| 后续 sensor/ISP 正常驱动控制 | 应该由 Linux camera stack 接管 |
| FreeRTOS | 继续作为协处理器/通信端存在，但不应继续占用 fast image 中断 |

所以回答你的问题：

> Linux 启动后，sensor、ISP 等控制权是否还在 Linux 上？

**设计意图上：是的，Linux 启动并执行 fast image stop/接管后，sensor/ISP/JPU/VPU 的后续控制权应该回到 Linux。**

但必须加两个限定：

1. **不是 Linux 一启动就天然接管，而是通过 `cvi_stop_fast_image()` / `FAST_IMAGE_SEND_STOP_REC` 触发接管。**
2. **当前源码中 RTOS 侧 VI/VCODEC stop task 链路不完整，实际接管是否顺畅需要跑日志确认。**

---

# 4. 针对你两个问题的直接回答

## 问题 1：FreeRTOS 具体干了什么，让 Linux 具有快速启动功能？

当前源码确定做了：

1. **提前启动 camera 链路**  
   `main_cvirtos()` 在 scheduler 前调用 `start_camera(0)`。

2. **提前初始化 sensor**  
   包括 sensor 类型选择、I2C 信息、lane、pn_swap、sensor init callback。

3. **提前初始化 MIPI/CIF**  
   包括 reset MIPI、set MIPI attr、enable sensor clock。

4. **提前初始化 VI/ISP 基础链路**  
   `SAMPLE_COMM_VI_StartSensor()`、`SAMPLE_COMM_VI_CreateIsp()`、`CVI_VI_SetDevAttr()`。

5. **建立与 Linux 的 mailbox 通信机制**  
   FreeRTOS 通过 `prvQueueISR()` 接收 Linux 命令，通过 `prvCmdQuRunTask()` 回复 Linux。

6. **Linux 启动后把 `transfer_config` 地址返回给 Linux**  
   Linux 通过这个结构知道 fast image buffer 的物理地址和大小。

7. **提供 stop ISR 接管机制**  
   Linux 要接管时，RTOS 理论上停止 VI/VCODEC ISR，然后 Linux enable 自己的 IRQ。

当前源码没有明确做：

1. **没有看到预拍多张图的完整实现。**
2. **没有看到 `SYS_CMD_INFO_DUMP_JPG` 在 RTOS 侧返回图片元信息。**
3. **没有看到在 `comm_main.c` 中持续采图或缓存 N 帧的 task。**
4. **没有看到明确的 AE/AWB/ISP 3A 预热收敛逻辑。**

所以更准确的说法是：

> FreeRTOS 主要做的是 camera/ISP 硬件链路的提前初始化和共享内存/控制权交接准备，而不是在当前源码中明确实现“预拍多张图给 Linux”。

---

## 问题 2：Linux 具体做了什么，从 FreeRTOS 那里获取图？Linux 启动后 sensor、ISP 控制权是否在 Linux 上？

Linux 做了：

1. **加载 `cvi-fast-image` 驱动。**
2. **发送 `SYS_CMD_INFO_LINUX_INIT_DONE` 给 RTOS。**
3. **等待 RTOS 回复 `SYS_CMD_INFO_RTOS_INIT_DONE`。**
4. **从回复中拿到 `transfer_config` 的物理/偏移地址。**
5. **映射 RTOS reserved memory。**
6. **读取并校验 `transfer_config`。**
7. **根据其中的 `isp_buffer_addr`、`encode_img_addr`、`encode_buf_addr` 映射/分配 ION buffer。**
8. **通过 ioctl 或 exported symbol 查询这些 buffer 的 PA/VA/size。**
9. **需要接管时，调用 `cvi_stop_fast_image()`，通知 RTOS 停止 ISR。**
10. **Linux `enable_irq()`，重新打开 ISP/JPU/VPU 中断。**

Linux 获取图的方式不是 mailbox 拷贝，而是：

```text
RTOS/FSBL 写 transfer_config
Linux 通过 mailbox 拿 transfer_config 地址
Linux 映射同一批物理 buffer
Linux 读取这些 buffer 内容
```

Linux 启动后控制权：

- **接管前**：camera 早期初始化和 fast image 相关控制在 FreeRTOS。
- **接管后**：Linux 应该控制 ISP/JPU/VPU IRQ，并由 Linux camera stack 继续控制 sensor/ISP。
- **当前源码风险**：RTOS 侧 VI/VCODEC stop task 在 `comm_main.c` 里没有实际 `runTask`，所以接管闭环可能不完整，需要实机日志确认。

最终可以总结为一句话：

> FreeRTOS 负责“提前把 camera 硬件链路跑起来并把 buffer 地址交给 Linux”，Linux 负责“启动后映射这些 buffer、读取 fast image 数据，并通过 stop ISR/enable IRQ 接回 ISP/JPU/VPU 等控制权”；但当前 SDK 源码没有完整证明 FreeRTOS 已经实现了预拍多帧图像供 Linux 读取。

---

**User**

也就是目前fastboot流程中，freertos只负责驱动预加载，而所有的stream流程都在linux进行，rtos侧没有相关出图、预拍照实现？

---

**Cursor**

基本可以这么理解，但要稍微精确一点：

**以当前 SDK 源码为准，fastboot/fast image 流程里 FreeRTOS 确认做的是 camera 相关硬件链路的“提前初始化/预加载/预启动”，而没有看到完整的 RTOS 侧 stream 出图、缓存帧、预拍照并交给 Linux 的实现。后续真正的常规 stream 流程设计上应回到 Linux 侧进行。**

更细分地说：

## 1. FreeRTOS 侧确认做了什么

在 `freertos/cvitek/task/comm/src/riscv64/comm_main.c` 中：

```137:147:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
void main_cvirtos(void)
{
	printf("create cvi task\n");

	request_irq(MBOX_INT_C906_2ND, prvQueueISR, 0, "mailbox", (void *)0);

#ifdef FAST_IMAGE_ENABLE
	start_camera(0);
#endif
```

也就是 fast image 打开时，FreeRTOS 会在 scheduler 前执行 `start_camera(0)`。

`start_camera()` 里会做 sensor、MIPI/CIF、VI/ISP 相关初始化，并调用 sensor init。这个可以称为：

- sensor 预初始化；
- MIPI/CIF 预配置；
- VI/ISP 预初始化；
- camera 链路预热/预加载。

所以 FreeRTOS 的主要作用是：

```text
Linux 还没起来时，先把 camera 硬件链路从冷态拉起来。
```

## 2. FreeRTOS 侧没有看到完整 stream/预拍照实现

当前源码里没有看到这些关键闭环：

- RTOS 侧持续从 VI/ISP 取帧；
- RTOS 侧把多帧图像保存到 ring buffer；
- RTOS 侧执行“预拍几张图”；
- RTOS 侧返回图像元信息给 Linux；
- RTOS 侧实现完整 `SYS_CMD_INFO_DUMP_JPG`。

相反，在 `comm_main.c` 中：

```223:226:/home/nopiskl/tmp/duo-buildroot-sdk-v2/freertos/cvitek/task/comm/src/riscv64/comm_main.c
			case SYS_CMD_INFO_DUMP_JPG:
				break;
			case SYS_CMD_INFO_DUMP_EN:
				dump_uart_enable();
```

`SYS_CMD_INFO_DUMP_JPG` 是空的，这说明至少在当前源码里，没有实现“Linux 来取 RTOS 预拍图片”的返回逻辑。

另外，`gTaskCtx` 里 `ISP`、`VI`、`VCODEC`、`CAMERA` 的 `runTask` 都是 `NULL`，没有实际创建处理这些 stream/stop 命令的 task：

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

所以不能说当前 RTOS 侧已经有完整 stream pipeline。

## 3. Linux 侧负责后续 stream 和接管

Linux `fast_image.c` 做的是：

1. probe `cvi-fast-image`；
2. 通过 mailbox 向 RTOS 获取 `transfer_config`；
3. 映射 fast image 相关 shared/ION buffer；
4. 提供 ioctl 查询 buffer；
5. 调 `cvi_stop_fast_image()` 通知 RTOS 停止 fast image ISR；
6. `enable_irq()` 打开 Linux 侧 ISP/JPU/VPU IRQ。

也就是说 Linux 的职责是：

```text
启动后拿到 RTOS/FSBL 预留的 buffer 信息，
然后接管相关硬件中断和后续 camera/media stream 流程。
```

## 4. 准确结论

你的总结可以改成下面这句更准确：

> 当前 SDK 的 fastboot/fast image 流程中，FreeRTOS 主要负责 camera/sensor/MIPI/CIF/VI/ISP 的提前初始化和共享 buffer 信息交接；当前源码没有看到 RTOS 侧完整出图、预拍照、缓存多帧再给 Linux 读取的实现。Linux 启动后通过 fast_image 驱动获取共享 buffer 信息，并在 stop fast image 后接管 ISP/JPU/VPU 中断，后续常规 stream 流程应由 Linux 侧完成。

唯一要保留的谨慎点是：

**`start_camera()` 可能已经让 sensor 开始 streaming 到硬件链路里了，但这不等于 RTOS 侧实现了完整“取帧/预拍照/交图给 Linux”的软件流程。**

