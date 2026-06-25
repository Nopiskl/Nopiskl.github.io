# Linux and FreeRTOS camera link initialization
_Exported on 2026/6/4 at GMT+8 20:16:53 from Cursor (2.6.21)_

---

**User**

@agent/cursor_linux_and_freertos_camera_link_i.md 结合文档与工作区具体源码，分析一下Linux和freertos如何配合初始化camera链路的

---

**Cursor**


## 1. 总体结论

这个工程里的 camera 初始化不是传统的“Linux 全权初始化 sensor/MIPI/CSI/ISP/VIPP”，而是更偏向：

**FreeRTOS/E907 先启动并抢先完成 camera 硬件链路的快速初始化、出帧、ISP 快速收敛和参数保存；Linux/A27 后启动时通过 RPMsg 通知机制等待或接管部分资源，再以 V4L2/VIN 框架对外提供视频节点和后续采集控制。**

可以概括为：

```text
BOOT0 / SPL
  └─ 加载 E907 FreeRTOS 固件 riscv0
      └─ FreeRTOS cpu0_app_entry()
          ├─ 启动 OpenAMP/RPMsg 线程
          ├─ csi_init()
          │   ├─ 读取 RTOS sys_config.fex 的 sensor/vinc 配置
          │   ├─ 初始化 VIN/CSI/ISP reserved mem
          │   ├─ 打开 VIN 电源、TWI、sensor
          │   ├─ 配置 MIPI/CSI/ISP/VIPP 路由
          │   ├─ stream on 等待出帧 / AE 收敛
          │   ├─ stream off，释放临时初始化资源
          │   └─ 保存/更新 ISP 参数
          └─ rpmsg_notify("twi0"/"isp0"/"scaler0"/"vinc0"...)
              └─ Linux VIN/ISP 驱动 delay_init 回调被唤醒
                  ├─ Linux 注册 IRQ / 释放 reserved memory / 建立 rpbuf
                  ├─ Linux VIN media graph / V4L2 video node 完成初始化
                  └─ 用户态 VIDIOC_STREAMON 时进入 Linux 侧正常采集链路
```

所以它的核心协同点有三个：

1. **FreeRTOS 负责 fastboot 阶段的 camera 早初始化和 ISP 快速收敛。**
2. **Linux 侧 VIN/ISP 驱动支持 `delay_init`，通过 `rpmsg_notify_add()` 等待 FreeRTOS 通知。**
3. **Linux 与 FreeRTOS 通过 RPMsg 传控制消息，通过 RPBuf 传 ISP load/save/tuning 等较大数据。**

---

## 2. FreeRTOS 侧：E907 的 camera 初始化入口

实际入口在：

`rtos/lichee/rtos/projects/v821_e907/perf2_fastboot/src/main.c`

关键代码是 `cpu0_app_entry()`：

```302:357:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos/projects/v821_e907/perf2_fastboot/src/main.c
void cpu0_app_entry(void *param)
{
	(void)param;

#ifdef CONFIG_COMPONENTS_RPBUF_UART
	extern int aglink_rpbuff_uart_init(int8_t uart_id);
	aglink_rpbuff_uart_init(CONFIG_RPBUFF_UART_PORT);
#endif

#ifdef CONFIG_COMPONENTS_PM
	pm_init(1, NULL);
#endif

#ifdef CONFIG_COMPONENTS_LOW_POWER_APP
	extern int low_power_app(void);
	low_power_app();
#endif

#ifdef CONFIG_COMPONENTS_OPENAMP
	void *thread;
	thread = hal_thread_create(openamp_init_thread, NULL,
							   "amp_init", 8 * 1024, HAL_THREAD_PRIORITY_SYS);
	if (thread != NULL)
		hal_thread_start(thread);
#endif
```

后面直接调用 VIN 初始化：

```341:377:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos/projects/v821_e907/perf2_fastboot/src/main.c
#ifdef CONFIG_DRIVERS_VIN
	int ret;

	ret = csi_init(0, NULL);
	if (ret) {
		rpmsg_notify("rt-media", NULL, 0);
		printf("csi init fail!\n");
	} else {
		rpmsg_notify("twi0", NULL, 0);
		rpmsg_notify("isp0", NULL, 0);
		rpmsg_notify("scaler0", NULL, 0);
		rpmsg_notify("scaler4", NULL, 0);
		rpmsg_notify("vinc0", NULL, 0);
		rpmsg_notify("vinc4", NULL, 0);
#if CONFIG_ISP_NUMBER >= 2
		rpmsg_notify("tdm0", NULL, 0);
		rpmsg_notify("isp1", NULL, 0);
		rpmsg_notify("scaler1", NULL, 0);
		rpmsg_notify("vinc1", NULL, 0);
		rpmsg_notify("scaler5", NULL, 0);
		rpmsg_notify("vinc5", NULL, 0);
#endif
		printf("csi init success!\n");
	}
#ifdef CONFIG_VIN_USE_PM
	csi_pm_init();
#endif
#endif
```

这段代码非常关键：

- `csi_init()` 是 FreeRTOS camera 链路初始化主体。
- 初始化成功后，用 `rpmsg_notify()` 通知 Linux 侧对应模块：
  - `twi0`
  - `isp0`
  - `scaler0`
  - `scaler4`
  - `vinc0`
  - `vinc4`
- 如果有第二路 ISP，也通知 `isp1/scaler1/vinc1/scaler5/vinc5/tdm0`。

这说明 Linux 侧驱动并不是盲目初始化，而是有一批子模块在等 E907 通知。

---

## 3. FreeRTOS camera 配置来自 RTOS 板级 `sys_config.fex`

当前 `perf2_fastboot` RTOS 配置里启用了单路 sensor：

`rtos/board/v821_e907/perf2_fastboot/configs/sys_config.fex`

```83:118:/home/alientek/v821/v821-tina-v12/rtos/board/v821_e907/perf2_fastboot/configs/sys_config.fex
[vind]

vind_user	= 1
csi_top	= 200000000
csi_top_parent = 1200000000

[vind/sensor0]
sensor0_used          = 1
sensor0_mname         = "gc1084_mipi"
sensor0_twi_cci_id    = 0
sensor0_twi_addr      = 0x6e
sensor0_mclk_id       = 0
sensor0_isp_used      = 1
sensor0_power_en      = port:PD12<default><default><default><default>
sensor0_pwdn          = port:PD12<default><default><default><default>
sensor0_reset         = port:PD12<1><0><1><0>
sensor0_sm_hs         = port:PD12<default><default><default><default>
sensor0_sm_vs         = port:PD12<default><default><default><default>
sensor0_ir_cut0       = port:PD12<default><default><default><default>
sensor0_ir_cut1       = port:PD12<default><default><default><default>
sensor0_ir_led        = port:PD12<default><default><default><default>
```

`vinc0` 绑定到了 `sensor0 + mipi0 + csi0 + isp0`：

```119:137:/home/alientek/v821/v821-tina-v12/rtos/board/v821_e907/perf2_fastboot/configs/sys_config.fex
[vind/vinc0]
vinc0_used          = 1
vinc0_csi_sel		= 0
vinc0_mipi_sel		= 0
vinc0_isp_sel		= 0
vinc0_isp_tx_ch		= 0
vinc0_tdm_rx_sel	= 0xff
vinc0_rear_sensor_sel	= 0
vinc0_front_sensor_sel	= 0
vinc0_width     = 1280
vinc0_height    = 720
vinc0_use_sensor_list   = 0
vinc0_mipi_num = 1
vinc0_work_mode		= 0
```

因此当前板级 fastboot camera 的实际链路是：

```text
GC1084 MIPI sensor0
  -> MIPI0
  -> CSI0
  -> ISP0
  -> VIPP / scaler / vinc0
```

---

## 4. FreeRTOS `csi_init()` 做了什么

`csi_init()` 在：

`rtos/lichee/rtos-hal/hal/source/vin/vin.c`

核心流程如下。

### 4.1 判断是否是重复初始化 / 唤醒重入

```1478:1526:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin.c
int csi_init(int argc, const char **argv)
{
	struct vin_core *vinc = NULL;
	unsigned long reg_base;
	unsigned long ccu_base;
	int ret = 0;
	int i;
	int sensor_id;
	int select_video_num = VIN_MAX_VIDEO; //VIN_MAX_VIDEO
	unsigned char ir_en = 0;
#ifdef CONFIG_NOT_FRAME_LOSS
	gpio_data_t gpio_data = 0;
#endif
	int sensor_enable = 1;

#ifdef CONFIG_VIN_WAIT_AMP_INIT
	vin_sem = hal_sem_create(0);
	if (vin_sem == NULL) {
		vin_err("creating vin sem failed.\n");
		return -1;
	}
#endif

#if defined CONFIG_ARCH_SUN20IW3 || defined CONFIG_ARCH_SUN55IW3 || defined CONFIG_ARCH_SUN8IW20
	if (hal_readl(rtc_base + 0x100 + 0x4 * RTC_NUM) & 0x2) {
		vin_print("rtc%d is 0x%x, csi_init is already init once, reinit isp server\n", RTC_NUM, hal_readl(rtc_base + 0x100 + 0x4 * RTC_NUM));
#else
	if (hal_readl(rtc_base) & 0x2) {
		vin_print("rt is 0x%x, csi_init is already init once, reinit isp server\n", hal_readl(rtc_base));
#endif
```

如果 RTC 标志表示已经初始化过，会走 `isp_reinit()` 路径。这是低功耗恢复、系统 reset 或 warm boot 场景下的优化。

### 4.2 读取 VIN 配置、初始化内存池和硬件基址

```1543:1573:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin.c
	vin_log(VIN_LOG_MD, "CSI start!\n");

	ret = vin_g_config();
	if (ret != 0) {
		vin_err("vin get config error\n");
		return -1;
	}

	ret = vin_g_status();
	if (ret != 0) {
		vin_err("There is no open CSI\n");
		return -1;
	}
#ifdef CONFIG_KERNEL_FREERTOS
	memheap_init(&isp_mempool, "isp-mempool", (void *)MEMRESERVE, MEMRESERVE_SIZE);
#else
	rt_memheap_init(&isp_mempool, "isp-mempool", (void *)MEMRESERVE, MEMRESERVE_SIZE);
#endif

	reg_base = sunxi_vin_get_top_base();
	csic_top_set_base_addr(reg_base);
	vin_log(VIN_LOG_MD, "reg is 0x%lx\n", reg_base);

	ccu_base = sunxi_vin_get_ccu_base();
	csic_ccu_set_base_addr(ccu_base);
```

这里做了几件重要事：

- `vin_g_config()`：从 RTOS 的 `sys_config.fex` 读取 sensor/vinc 配置。
- `vin_g_status()`：确认至少有一个 `global_video[i].used == 1`。
- 初始化 ISP/VIN reserved memory 的内存池。
- 设置 CSI TOP 和 CSI CCU 寄存器基址。

### 4.3 打开 VIN 电源和 TWI

```1575:1579:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin.c
	vin_md_set_power(PWR_ON);

	sunxi_twi_init(0);
	sunxi_twi_init(1);
```

这说明 sensor I2C/TWI 初始化由 FreeRTOS 先做。对当前配置，`sensor0_twi_cci_id = 0`，所以主要走 TWI0。

### 4.4 逐路初始化 sensor/vinc/ISP 路由并开流

```1594:1639:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin.c
	for (i = 0; i < select_video_num; i++) {
		if (global_video[i].used == 1) {
			sensor_id = global_video[i].rear_sensor;

			vin_set_from_partition(global_video[i].isp_sel, &ir_en);
#if defined CONFIG_COMPONENTS_RPBUF_UART
			int mode = aglink_get_mode();
			if ((mode == TAKE_PHOTO_MODE) || (mode == AI_MODE)) {
				global_video[i].large_image = 1;
				global_video[i].o_width = global_video[i].merge_width;
				global_video[i].o_height = global_video[i].merge_height;
#if !defined CONFIG_SENSOR_IMX219_MIPI
				isp_get_cfg[global_video[i].isp_sel].sensor_get_fps = 30;
#else
				isp_get_cfg[global_video[i].isp_sel].sensor_get_fps = 15;
#endif
				vin_print("use large mode\n");
				if (i % 2  == 0)
					continue;
			} else {
				global_video[i].large_image = 0;
				isp_get_cfg[global_video[i].isp_sel].sensor_get_fps = 30;
				if (i % 2 == 1) {
					global_video[i].used = 0;
					continue;
				}
			}
#endif
			if (global_video[i].large_image)
				vin_s_input(i - 1);
			vin_s_input(i);
			vinc = global_vinc[i];
```

`vin_s_input(i)` 的职责是建立单路 video 输入链路：

```1320:1352:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin.c
int vin_s_input(int id)
{
	int sensor_id, j;
	struct vin_core *vinc = NULL;

	sensor_id = global_video[id].rear_sensor;

	global_sensors[sensor_id].sensor_core = find_sensor_func(global_sensors[sensor_id].sensor_name);
	if (global_sensors[sensor_id].sensor_core == NULL) {
		vin_err("find sensor core function error\n");
		return -1;
	}

	if (global_video[id].use_sensor_list)
		vin_detect_sensor_list(sensor_id);

	vin_probe(id);
	vinc = global_vinc[id];
	vinc->large_image = global_video[id].large_image;
	vinc->get_yuv_en = isp_get_cfg[clamp(vinc->isp_sel, 0, ISP_GET_CFG_NUM - 1)].get_yuv_en;

	vin_subdev_ccu_en(id, PWR_ON);

	vin_pipeline_set_mbus_config(id);
```

再往下配置 CSI 到 ISP、ISP 到 VIPP 的路由：

```1352:1367:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin.c
	if (vinc->large_image) {
		if (vinc->isp_sel == 0)
			csic_isp_input_select(vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, 0);
		else if (vinc->isp_sel == 1)
			csic_isp_input_select(vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 1, vinc->csi_sel, 1);
		csic_vipp_input_select(vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
	} else {
		for (j = 0; j < vinc->total_rx_ch; j++) {
			csic_isp_input_select(vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + j, vinc->csi_sel, j);
		}
		csic_vipp_input_select(vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
	}
```

对当前单路配置就是：

```text
CSI0 channel -> ISP0 input -> VIPP/scaler output channel
```

然后 `csi_init()` 里 sensor 上电、读取格式、开流：

```1640:1668:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin.c
#ifdef CONFIG_ISP_FAST_CONVERGENCE
			if (global_sensors[sensor_id].sensor_core->s_ir_status) {
				if (ir_en)
					global_sensors[sensor_id].sensor_core->s_ir_status(sensor_id, IR_NIGHT);
				else
					global_sensors[sensor_id].sensor_core->s_ir_status(sensor_id, IR_DAY);
			}
#elif defined CONFIG_ISP_HARD_LIGHTADC || defined CONFIG_ISP_ONLY_HARD_LIGHTADC
			if (global_sensors[sensor_id].sensor_core->s_ir_status) {
				if (ir_en == 1)
					global_sensors[sensor_id].sensor_core->s_ir_status(sensor_id, IR_DAY);
				else if (ir_en == 2)
					global_sensors[sensor_id].sensor_core->s_ir_status(sensor_id, IR_NIGHT);
			}
#endif
#if !defined CONFIG_SENSOR_INIT_BEFORE_VIN
			if (global_sensors[sensor_id].sensor_core->sensor_power)
				global_sensors[sensor_id].sensor_core->sensor_power(sensor_id, PWR_ON);
#endif
			if (global_sensors[sensor_id].sensor_core->sensor_g_format)
				global_sensors[sensor_id].sensor_core->sensor_g_format(sensor_id, vinc->isp_sel, i);
```

```1669:1680:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin.c
			if (vinc->large_image) {
				ret = vin_s_stream(i - 1, PWR_ON);
				if (ret) {
					sensor_enable = 0;
					vin_err("find not sensor\n");
				}
			}
			ret = vin_s_stream(i, PWR_ON);
			if (ret) {
				sensor_enable = 0;
				vin_err("find not sensor\n");
			}
```

### 4.5 等待 YUV 帧和 ISP AE 收敛

`csi_init()` 不是简单配置完就返回，而是会等待出帧或 AE 收敛：

```1694:1723:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin.c
	for (i = 0; i < select_video_num; i++) {
		if (global_video[i].used == 1) {
			vinc = global_vinc[i];

			if (vinc->get_yuv_en) {
#ifdef CONFIG_NOT_FRAME_LOSS
				while (vinc->frame_cnt < (YUV_MEMRESERVE_SIZE / vinc->buffer_size - 1)) {
					if (global_sensors[vinc->rear_sensor].not_frame_loss_gpio != 0xffff) {
						hal_gpio_get_data(global_sensors[vinc->rear_sensor].not_frame_loss_gpio, &gpio_data);
						if(gpio_data) {
							vin_print("detect button up, start notify\n");
							break;
						}
					}
					vin_log(VIN_LOG_MD, "wait frame cnt\n");
					hal_usleep(500);
				}
#else
				while (vinc->frame_cnt != 2)
					hal_usleep(1000);
#endif
			}
```

```1724:1739:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin.c
			if (global_sensors[global_video[i].rear_sensor].use_isp && sensor_enable) {
				if (vinc->large_image && vinc->isp_sel % 2 == 0) {
					continue;
				}
				while (sunxi_isp_ae_done(vinc->isp_sel, 8) != 0) {
					hal_usleep(1000);
#if defined CONFIG_ISP_FAST_CONVERGENCE
					if (++global_sensors[i].check_fast_ae_done_frame >= 500) {
						vin_err("isp%d fast_ae_timeout\n", vinc->isp_sel);
						break;
					}
#endif
				}
			}
```

这是 fastboot camera 链路的关键：**E907 提前让 sensor 和 ISP 跑起来，等待 AE 收敛，后续 Linux 或应用拿到的画面更快稳定。**

### 4.6 临时开流后关闭并释放，保存 ISP 参数

随后 FreeRTOS 会关掉这次初始化用的流并释放 `vin_core`：

```1742:1754:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin.c
	for (i = 0; i < select_video_num; i++) {
		if (global_video[i].used == 1) {
			vinc = global_vinc[i];

			vin_print("close video%d\n", vinc->id);

			vin_s_stream(i, PWR_OFF);
			csic_isp_bridge_disable();

			vin_free(i);
		}
	}
```

之后更新 ISP server 和 sensor switch：

```1757:1778:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin.c
#if defined CONFIG_ISP_FAST_CONVERGENCE || defined CONFIG_ISP_HARD_LIGHTADC
	for (i = 0; i < select_video_num; i++) {
		if (global_video[i].used == 1) {
			vinc = &global_video[i]; //global_vinc is free
			sensor_id = vinc->mipi_sel;
#if defined CONFIG_COMPONENTS_RPBUF_UART
			if (vinc->large_image) {
				vinc->o_width = global_video[i].merge_width;
				vinc->o_height = global_video[i].merge_height;
			}
#endif
			if (global_sensors[sensor_id].sensor_core->sensor_g_switch_format)
				global_sensors[sensor_id].sensor_core->sensor_g_switch_format(sensor_id, vinc->isp_sel, i);
			sunxi_isp_update_server(vinc->isp_sel);
			if (global_video[i].large_image && (i % 2 == 1))
				continue;
			if (global_sensors[sensor_id].sensor_core->s_switch)
				global_sensors[sensor_id].sensor_core->s_switch(sensor_id);
```

最后等待 AMP/RPBuf 初始化，并保存参数：

```1801:1817:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin.c
	for (i = 0; i < select_video_num; i++) {
		if (global_video[i].used == 1) {
			vinc = &global_video[i]; //global_vinc is free
			sensor_id = vinc->mipi_sel;

			sunxi_isp_reset_server(vinc->isp_sel);
			vin_set_to_partition(vinc->isp_sel);

			if (isp_get_cfg[clamp(vinc->isp_sel, 0, ISP_GET_CFG_NUM - 1)].sensor_deinit) {
				if (vinc->mipi_sel != 0xff)
					sunxi_mipi_subdev_s_stream(vinc->mipi_sel, vinc->id, 0);
```

因此 FreeRTOS `csi_init()` 不是“持久在线采集”，更像是：

```text
短暂完整跑通 camera 链路
  -> 采几帧 / 等 3A
  -> 保存 ISP/AE 等参数
  -> 释放或关闭部分资源
  -> 通知 Linux 可以继续初始化
```

---

## 5. Linux 侧：通过 `delay_init` 等 FreeRTOS 通知

Linux ISP 驱动在：

`bsp/drivers/vin/vin-isp/sunxi_isp.c`

关键逻辑在 `isp_probe()`。

### 5.1 正常模式直接 request IRQ

如果不是 `CONFIG_VIN_INIT_MELIS` 或者 `delay_init == 0`，Linux 会直接申请 ISP IRQ：

```3898:3905:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-isp/sunxi_isp.c
#if !IS_ENABLED(CONFIG_VIN_INIT_MELIS)
		ret = request_irq(isp->irq, isp_isr, IRQF_SHARED, isp->pdev->name, isp);
		if (ret) {
			vin_err("isp%d request irq failed\n", isp->id);
			goto unmap;
		}
#else
```

### 5.2 fastboot/MELIS 初始化模式下走 `delay_init`

如果配置了 `CONFIG_VIN_INIT_MELIS`，驱动读取设备树属性 `delay_init`：

```3906:3927:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-isp/sunxi_isp.c
		of_property_read_u32(np, "delay_init", &isp->delay_init);
		if (isp->delay_init == 0) {
			ret = request_irq(isp->irq, isp_isr, IRQF_SHARED, isp->pdev->name, isp);
			if (ret) {
				vin_err("isp%d request irq failed\n", isp->id);
				goto unmap;
			}
		} else {
			sprintf(name, "isp%d", isp->id);
#if IS_ENABLED(CONFIG_ARCH_SUN55IW3)
			rpmsg_notify_add("7130000.e906_rproc", name, isp_enable_irq, isp);
#else
			of_property_read_string(np, "rpmsg-ser-name", &isp->rpmsg_ser_name);
			if (!isp->rpmsg_ser_name) {
				vin_err("isp%d get rpmsg_ser_name falid\n", isp->id);
				goto unmap;
			} else
				rpmsg_notify_add(isp->rpmsg_ser_name, name, isp_enable_irq, isp);
#endif
```

也就是说：

- Linux `isp_probe()` 并不立刻拿 IRQ。
- 如果 `delay_init = 1`，Linux 注册一个 `rpmsg_notify_add()` 回调。
- 回调名是 `isp0`、`isp1` 等。
- 这正好对应 FreeRTOS 成功后调用的 `rpmsg_notify("isp0", NULL, 0)`。

### 5.3 收到通知后 Linux 执行 `isp_enable_irq()`

回调函数是 `isp_enable_irq()`：

```3702:3771:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-isp/sunxi_isp.c
static int isp_enable_irq(void *dev, void *data, int len)
{
	struct isp_dev *isp = dev;
	int ret = 0;

#if !IS_ENABLED(CONFIG_RV_RUN_CAR_REVERSE)
	unsigned int phy_addr[2] = {0, 0};
	unsigned int buf_size[2] = {0, 0};
	unsigned int not_frame_loss_flag[2] = {0, 0};
	unsigned int total_size;

	isp_reserve_for_yuv(phy_addr, buf_size, not_frame_loss_flag);

	if (isp->isp_reserved_np && isp->reserved_r.start && isp->reserved_len) {
		/*2 * (VIN_RESERVE_SIZE + VIN_THRESHOLD_PARAM_SIZE) reserved for vin_set_from_partition*/
		total_size = isp->reserved_len - 2 * (VIN_RESERVE_SIZE + VIN_THRESHOLD_PARAM_SIZE);
```

这个函数有两类动作：

1. 根据 FreeRTOS 已经使用/保留的 YUV buffer，释放 Linux 可回收的 reserved memory。
2. 根据通知数据 `"return"` 或 `"get"` 决定申请/释放 IRQ：

```3759:3770:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-isp/sunxi_isp.c
	if (!data || !strncmp(data, "return", len)) {
#if IS_ENABLED(CONFIG_ARCH_SUN55IW3)
		vin_iommu_en(ISP_IOMMU_MASTER, true);
#endif
		ret = request_irq(isp->irq, isp_isr, IRQF_SHARED, isp->pdev->name, isp);
		if (ret)
			vin_err("isp%d request irq failed\n", isp->id);
	} else if (!strncmp(data, "get", len)) {
#if IS_ENABLED(CONFIG_ARCH_SUN55IW3)
		vin_iommu_en(ISP_IOMMU_MASTER, false);
#endif
		if (isp->irq)
			free_irq(isp->irq, isp);

	}
```

结合 RTOS 的 `rpmsg_notify("isp0", NULL, 0)`，`data == NULL`，所以 Linux 会执行 `request_irq()`。

这就是“FreeRTOS 初始化完成后，Linux ISP IRQ 才正式启用”的同步点。

---

## 6. Linux/FreeRTOS 的 RPMsg 控制权协议

RTOS 侧还有一个专门的 VIN RPMsg endpoint：

`rtos/lichee/rtos-hal/hal/source/vin/vin_rpmsg/vin_rpmsg.c`

endpoint 名称是：

```13:20:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin_rpmsg/vin_rpmsg.c
#include "vin_rpmsg.h"

#define VIN_RPMSG_SERVICE_NAME			"sunxi,notify"
#define VIN_RPMSG_NOTIFY_MAX_LEN		32
#define VIN_RPMSG_MAX_LEN			(512 -16)

#define VIN_PACKET_MAGIC				0x10244025
```

初始化时打开 RPMsg endpoint：

```136:157:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin_rpmsg/vin_rpmsg.c
int vin_rpmsg_init(void)
{
	struct rpmsg_endpoint *ept;

	rpmsg_vin.finish = hal_sem_create(0);
	if (!rpmsg_vin.finish) {
		printf("rpmsg vin failed to create sem\r\n");
		return -1;
	}

	ept = openamp_ept_open(VIN_RPMSG_SERVICE_NAME, 0, RPMSG_ADDR_ANY, RPMSG_ADDR_ANY,
					NULL, rpmsg_ept_callback, rpmsg_unbind_callback);
	if (ept == NULL) {
		vin_err("vin rpmsg Failed to Create Endpoint\r\n");
		return -1;
	}

	vin_ept = ept;
```

RPMsg 回调里维护 camera 控制权状态：

```96:125:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin_rpmsg/vin_rpmsg.c
static int rpmsg_ept_callback(struct rpmsg_endpoint *ept, void *data,
		size_t len, uint32_t src, void *priv)
{
	struct vin_packet *pack = data;
	int ret;

	if (pack->magic != VIN_PACKET_MAGIC || len != sizeof(*pack)) {
		vin_err("packet invalid magic or size %d %d %x\n", (int)len,
			(int)sizeof(*pack), pack->magic);
		return 0;
	}

	if (pack->type == RV_VIN_START_ACK) {
		rpmsg_vin.control = GET_BY_RTOS;
	} else if (pack->type == RV_VIN_STOP_ACK) {
		rpmsg_vin.control = GET_BY_NONE;
	} else if (pack->type == ARM_VIN_START) {
		rpmsg_vin.control = GET_BY_LINUX;
		vin_rpmsg_status_on_off(ARM_VIN_START_ACK);
	} else if (pack->type == ARM_VIN_STOP) {
		rpmsg_vin.control = GET_BY_NONE;
		vin_rpmsg_status_on_off(ARM_VIN_STOP_ACK);
	} else if (pack->type == ARM_RPMSG_READY) {
```

含义是：

- `RV_VIN_START_ACK`：RTOS 持有/启动 VIN。
- `ARM_VIN_START`：Linux 请求启动/接管 VIN。
- `ARM_VIN_STOP`：Linux 停止 VIN。
- `ARM_RPMSG_READY`：Linux 侧 RPMsg ready，释放等待信号量。

RTOS 可以向 Linux 发送状态：

```69:93:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin_rpmsg/vin_rpmsg.c
int vin_rpmsg_status_on_off(enum vin_packet_type type)
{
	char * msg = NULL;
	int len = 0;

	if (RV_VIN_START == type) {
		msg = "rv_start";
		len = 8;
	} else if (RV_VIN_STOP == type) {
		msg = "rv_stop";
		len = 7;
	} else if (ARM_VIN_START_ACK == type) {
		msg = "arm_start";
		len = 9;
	} else if (ARM_VIN_STOP_ACK == type) {
		msg = "arm_stop";
		len = 8;
	} else {
```

也可以显式归还/获取各模块控制权：

```44:65:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin_rpmsg/vin_rpmsg.c
void vin_return_control(int type)
{
	char * msg = NULL;
	int len = 0;

	if(!type) {
		msg = "get";
		len = 3;
	} else {
		msg = "return";
		len = 6;
	}

	vin_rpmsg_send("twi2", msg, len);
	vin_rpmsg_send("twi3", msg, len);
	vin_rpmsg_send("isp0", msg, len);
	vin_rpmsg_send("scaler0", msg, len);
```

这里的 `"get"` / `"return"` 与 Linux `isp_enable_irq()` 中的逻辑是对应的：

- `"return"` 或 `NULL`：Linux 可以启用 IRQ、接管资源。
- `"get"`：RTOS 要拿回控制权，Linux 释放 IRQ 或关闭部分访问。

---

## 7. Linux 侧 RPBuf：用于 ISP 参数/统计数据同步

Linux 文件：

`bsp/drivers/vin/vin-rp/vin_rp.c`

RPBuf 不是普通小消息，而是共享 buffer 机制，用于 ISP load/save/tuning 等大块数据。

例如 Linux 接收 FreeRTOS/Melis 传来的 ISP load buffer：

```22:61:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-rp/vin_rp.c
static int isp_rpbuf_rx_cb(struct rpbuf_buffer *buffer,
				    void *data, int data_len, void *priv)
{
	struct isp_dev *isp = priv;
	void *buf_va = rpbuf_buffer_va(buffer);
	int ret = 0;

	if (data_len > ISP_LOAD_DRAM_SIZE) {
		vin_err("melis ask for 0x%x data, it more than isp load_data 0x%x\n", data_len, ISP_LOAD_DRAM_SIZE);
		return -EINVAL;
	}

	if (data_len == ISP_SAVE_LOAD_STATISTIC_SIZE) {
		memcpy(isp->isp_save_load.vir_addr + ISP_SAVE_LOAD_REG_SIZE, buf_va, data_len);
		vin_log(VIN_LOG_RP, "isp%d receive save_load buffer from melis\n", isp->id);
		return 0;
	}

	if (isp->large_image == 3 && glb_isp[0]) {
```

普通模式下，收到 load 参数后写入 Linux ISP shadow buffer：

```88:96:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-rp/vin_rp.c
	} else {
		memcpy(&isp->load_shadow[0], buf_va, data_len);
	}
	isp->load_flag = 1;
	isp->load_save = 1;

	vin_log(VIN_LOG_RP, "isp%d frame number %d: receive load buffer from melis\n", isp->id, isp->isp_frame_number);
```

Linux ISP 中断 `PARA_LOAD_PD` 到来时，会把 `load_shadow` 更新进 ISP load DDR：

```2796:2844:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-isp/sunxi_isp.c
	if (bsp_isp_get_irq_status(isp->id, PARA_LOAD_PD)) {
		bsp_isp_clr_irq_status(isp->id, PARA_LOAD_PD);

#if IS_ENABLED(CONFIG_SOFTWARE_TDM_FOR_ISP)
		if (isp->id == SOFTWARE_TDM_ID)
			goto LOAD_SET_END;
#endif

		isp_stat_load_set(&isp->h3a_stat);

		if (isp->large_image == 3 && glb_isp[1]) {
			if (isp->id == 0 && isp->load_flag && !glb_isp[1]->load_buf_busy) {
				memcpy(glb_isp[1]->isp_load.vir_addr, &glb_isp[1]->load_shadow[0], ISP_LOAD_DRAM_SIZE);
				memcpy(isp->isp_load.vir_addr, &isp->load_shadow[0], ISP_LOAD_DRAM_SIZE);
				isp->load_flag = 0;
			}
		} else {
			if (isp->load_flag) {
				memcpy(isp->isp_load.vir_addr, &isp->load_shadow[0], ISP_LOAD_DRAM_SIZE);
				isp->load_flag = 0;
			}
		}
```

这说明：

- FreeRTOS/Melis 侧 ISP server 可以通过 RPBuf 把算法输出参数传给 Linux。
- Linux ISP ISR 在合适的硬件时序点更新 ISP 参数。
- 小控制走 RPMsg，大数据走 RPBuf。

---

## 8. Linux 用户态 `VIDIOC_STREAMON` 后的角色

Linux VIN video 驱动在：

`bsp/drivers/vin/vin-video/vin_video.c`

虽然我这次没有完整展开 `vidioc_streamon()` 的全部函数体，但从该文件和 VIN 框架结构看，Linux 用户态调用 `VIDIOC_STREAMON` 后会进入 Linux V4L2 pipeline：

```text
用户态
  -> /dev/videoX
  -> VIDIOC_REQBUFS / QBUF / STREAMON
  -> vin_video.c: vidioc_streamon()
  -> media graph 中依次对 sensor/mipi/csi/isp/scaler/capture 调 s_stream
  -> buffer queue 启动
  -> ISP/VIPP/CSI IRQ 处理帧完成
```

此时 FreeRTOS 的 fastboot 初始化已经完成，Linux 侧拿到的是一个已经过早期初始化、可同步 ISP 参数的硬件/软件状态。

需要注意：这个设计并不是“Linux 完全不碰硬件”。Linux 后续仍然有 VIN/ISP 驱动、IRQ、buffer queue、V4L2 节点、RPBuf 参数更新等职责。但在 fastboot camera 这个模式里，**第一轮 sensor/ISP 快速初始化由 E907 提前完成**，Linux 延迟启用或接管相关资源。

---

## 9. `riscv0` 与 `isp_param` 分区也参与初始化

`device/config/chips/v821/configs/perf2_fastboot/sys_partition.fex` 中有：

```51:64:/home/alientek/v821/v821-tina-v12/device/config/chips/v821/configs/perf2_fastboot/sys_partition.fex
[partition]
    name         = riscv0
    size         = 4096
    downloadfile = "amp_rv0.fex"
    user_type    = 0x8000

[partition]
    name         = rootfs
    size         = 1048576
    downloadfile = "rootfs.fex"
    user_type    = 0x8000

[partition]
    name         = isp_param
    size         = 128
    user_type    = 0x8000
```

含义：

- `riscv0`：E907 FreeRTOS 固件所在分区，文档里提到 BOOT0/SPL 会加载它。
- `isp_param`：用于 ISP 快速收敛/保存参数的分区。
- RTOS `csi_init()` 中调用了：
  - `vin_set_from_partition()`
  - `vin_set_to_partition()`

对应的功能就是从历史参数中恢复 AE/ISP 状态，再把本次初始化结果写回，提升下次启动 camera 出图速度。

---

## 10. 完整初始化时序图

结合文档和源码，可以整理成如下时序：

```text
阶段 0：固件/分区准备
  sys_partition.fex:
    riscv0      -> amp_rv0.fex，E907 固件
    isp_param   -> ISP 历史参数

阶段 1：BOOT0/SPL
  加载 riscv0 固件
  启动 E907 FreeRTOS
  可能预加载 isp_param 到 reserved DDR

阶段 2：E907 FreeRTOS 启动
  cpu0_app_entry()
    pm_init()
    openamp_init_thread()
      openamp_init()
      rpbuf_init()
      rpmsg_notify_init()
    flash_load_data_async()
    csi_init()

阶段 3：FreeRTOS camera early init
  csi_init()
    vin_g_config()
      读取 RTOS sys_config.fex
      sensor0 = gc1084_mipi
      vinc0 -> csi0/mipi0/isp0
    vin_g_status()
    memheap_init(isp_mempool)
    csic_top_set_base_addr()
    csic_ccu_set_base_addr()
    vin_md_set_power(PWR_ON)
    sunxi_twi_init(0/1)
    for each used vinc:
      vin_set_from_partition()
      vin_s_input()
        find_sensor_func()
        vin_probe()
        vin_subdev_ccu_en()
        vin_pipeline_set_mbus_config()
        csic_isp_input_select()
        csic_vipp_input_select()
      sensor_power(PWR_ON)
      sensor_g_format()
      vin_s_stream(PWR_ON)
    wait frame / wait AE done
    vin_s_stream(PWR_OFF)
    vin_free()
    sunxi_isp_update_server()
    sunxi_isp_reset_server()
    vin_set_to_partition()

阶段 4：FreeRTOS 通知 Linux
  rpmsg_notify("twi0")
  rpmsg_notify("isp0")
  rpmsg_notify("scaler0")
  rpmsg_notify("scaler4")
  rpmsg_notify("vinc0")
  rpmsg_notify("vinc4")

阶段 5：Linux VIN/ISP probe
  sunxi_isp.c: isp_probe()
    如果 delay_init == 1:
      rpmsg_notify_add(rpmsg_ser_name, "isp0", isp_enable_irq, isp)
    收到 FreeRTOS "isp0" 通知:
      isp_enable_irq()
        释放部分 reserved memory
        request_irq(isp->irq, isp_isr, ...)
    初始化 V4L2 subdev / media entity / rpbuf controller

阶段 6：Linux 用户态开始采集
  open /dev/videoX
  VIDIOC_REQBUFS
  VIDIOC_QBUF
  VIDIOC_STREAMON
    Linux VIN pipeline 开流
    ISP/VIPP/CSI IRQ 处理帧
    RPMsg/RPBuf 与 RTOS ISP server 同步控制和参数
```

---

## 11. 双方职责划分

| 模块 | FreeRTOS/E907 | Linux/A27 |
|---|---|---|
| 早期启动 | BOOT 后先运行 | 后启动 |
| sensor 上电/探测 | `sensor_power()`、`sensor_g_format()`、`sensor_test_i2c()` | 后续可通过 V4L2 sensor subdev 管理 |
| TWI/I2C | `sunxi_twi_init(0/1)` 早期使用 | delay notify 后再安全使用 |
| CSI/MIPI/ISP/VIPP 路由 | `vin_s_input()` 内配置 | V4L2 pipeline 中也维护 graph |
| ISP 快速收敛 | 等帧、等 AE done、读写 `isp_param` | 使用 RTOS 提供/保存的参数继续运行 |
| IRQ | 早期可能由 RTOS 占用或未交给 Linux | `rpmsg_notify` 后 `request_irq()` |
| 控制消息 | `rpmsg_notify()` / `vin_rpmsg_send()` | `rpmsg_notify_add()` / rpmsg endpoint |
| 大块参数 | 通过 shared memory/RPBuf | `vin_rp.c` 接收 load/save/tuning buffer |
| 对用户态接口 | 一般不直接暴露 Linux video 设备 | V4L2 `/dev/videoX` |

---

## 12. 关键点总结

1. **当前配置实际只启用了 RTOS `sensor0 + vinc0`：`gc1084_mipi`、1280x720、MIPI0、CSI0、ISP0。**
2. **FreeRTOS `cpu0_app_entry()` 里直接调用 `csi_init()`，这是 camera fastboot 链路最早的软件入口。**
3. **`csi_init()` 会真的打开 sensor、配置 CSI/ISP/VIPP、开流、等帧/AE、保存 ISP 参数，不只是简单初始化结构体。**
4. **Linux ISP 驱动支持 `delay_init`，不会马上 request IRQ，而是通过 `rpmsg_notify_add()` 等待 FreeRTOS 的 `rpmsg_notify("isp0")`。**
5. **FreeRTOS 通知成功后，Linux `isp_enable_irq()` 才申请 ISP IRQ，并处理 reserved memory 的释放/保留。**
6. **RPMsg 负责轻量控制和模块 ready 通知；RPBuf 负责 ISP load/save/tuning 等大数据同步。**
7. **最终用户态仍然通过 Linux V4L2 使用 camera，但其启动前置条件和 ISP 状态已经由 FreeRTOS 提前准备好。**

换句话说，这套设计的目的就是：**让 E907 在 Linux 完整启动前抢先完成 camera 出图和 ISP 3A 收敛，Linux 启动后再接入 V4L2 生态，从而缩短首帧时间并保持 Linux 用户态接口兼容。**

