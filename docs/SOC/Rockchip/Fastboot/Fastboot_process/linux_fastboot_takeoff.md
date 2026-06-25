# 一、先给结论

`stop_ae()` 以后，Linux 侧并不是通过某个“MCU->Linux 统一接管接口”去把整个硬件对象移交给内核，而是通过两类机制完成接管：

## 1. 硬件层：保持硬件不被冷启动流程破坏
也就是 Linux 驱动 probe / power / stream-on 时，**尽量不 reset、不重新上电、不重写整套初始化寄存器**。

这主要体现在 sensor 驱动的 thunderboot 分支里。

## 2. 状态层：通过 reserved memory / shared memory 继承 MCU 算好的结果
也就是 Linux ISP 驱动从 **reserved memory** 里读取 MCU 写好的 thunderboot 结果，包括：

- complete 状态
- camera 数量/索引
- 宽高/帧信息
- 更关键的是 **ISP first params**
- v32 上还包括 `cfg` 参数块

然后内核把这批参数保存进 ISP 参数设备，作为 Linux 起来后的**第一份 ISP 配置**继续使用。

所以准确说：

**Linux 不是“接管 MCU 线程”，而是“接管 MCU 已经预热好的硬件状态 + 共享内存里的首帧参数结果”。**

---

# 二、Linux 真正共享到的是什么

从驱动实现看，共享内容不是抽象对象，而是两部分：

## A. 预热后的硬件现状
包括：

- sensor 已经在工作态或至少不是冷态；
- reset/pwdn GPIO 不再按普通路径重新拉；
- sensor id 检查可跳过；
- 全局 init regs 可跳过；
- runtime pm 状态直接置 active。

这些保证 Linux 不会把 MCU 已经带起来的 sensor/ISP 又“打回冷启动”。

### 证据：`sc3338` probe 时直接进入 thunderboot 模式

```1429:1453:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/i2c/sc3338.c
sc3338->is_thunderboot = IS_ENABLED(CONFIG_VIDEO_ROCKCHIP_THUNDER_BOOT_ISP);

sc3338->reset_gpio = devm_gpiod_get(dev, "reset", sc3338->is_thunderboot ? GPIOD_ASIS : GPIOD_OUT_LOW);
if (IS_ERR(sc3338->reset_gpio))
	dev_warn(dev, "Failed to get reset-gpios\n");

sc3338->pwdn_gpio = devm_gpiod_get(dev, "pwdn", sc3338->is_thunderboot ? GPIOD_ASIS : GPIOD_OUT_LOW);
if (IS_ERR(sc3338->pwdn_gpio))
	dev_warn(dev, "Failed to get pwdn-gpios\n");
```

这里最关键的是 `GPIOD_ASIS`：  
Linux 驱动在 thunderboot 下**不改 reset/pwdn 当前电平**，也就是尽量保持 MCU 预热后的硬件态。

---

## B. MCU 写入 reserved memory 的 thunderboot 结果
ISP 驱动会把一块 DT 里声明的 `memory-region-thunderboot` 当作共享区使用。

### 证据：ISP probe 时拿 reserved memory，并标记 `is_thunderboot`

```834:845:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/platform/rockchip/isp/dev.c
isp_dev->resmem_addr = dma_map_single(dev, phys_to_virt(r.start),
				      sizeof(struct rkisp_thunderboot_resmem_head),
				      DMA_BIDIRECTIONAL);
ret = dma_mapping_error(dev, isp_dev->resmem_addr);
isp_dev->is_thunderboot = true;
isp_dev->is_rtt_suspend = false;
isp_dev->is_rtt_first = true;
if (device_property_read_bool(dev, "rtt-suspend")) {
	isp_dev->is_rtt_suspend = true;
	if (!isp_dev->hw_dev->is_thunderboot) {
		isp_dev->is_thunderboot = false;
		isp_dev->is_rtt_first = false;
	}
}
```

这说明 Linux ISP 驱动在 probe 时就已经准备好了：

- 共享物理内存地址 `resmem_pa`
- DMA 映射地址 `resmem_addr`
- thunderboot 状态位 `is_thunderboot`

也就是说，**共享内存不是用户态再给的，而是内核驱动自己在 probe 阶段就绑定好的。**

---

# 三、sensor 驱动如何“共享并使用”这套预热硬件

这里的“共享”不是数据结构共享，而是**不破坏 MCU 已经完成的 sensor bring-up**。

以 `sc3338` 为例，Linux 驱动做了 5 个关键动作。

---

## 1. 跳过 sensor id 检查

```1367:1369:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/i2c/sc3338.c
if (sc3338->is_thunderboot) {
	dev_info(dev, "Enable thunderboot mode, skip sensor id check\n");
	return 0;
}
```

这意味着 Linux 不再假定 sensor 处于“标准冷上电后的可识别初态”，而是接受“它已经被 MCU 带起来”。

---

## 2. power_on 路径直接短路，不重新做完整上电序列

```978:983:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/i2c/sc3338.c
cam_sw_regulator_bulk_init(sc3338->cam_sw_inf, SC3338_NUM_SUPPLIES, sc3338->supplies);

if (sc3338->is_thunderboot)
	return 0;
```

这一步非常关键：  
**thunderboot 下，`__sc3338_power_on()` 早退**，Linux 不再重走完整 sensor 上电/复位流程。

---

## 3. `s_power()` 跳过全局初始化寄存器

```926:931:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/i2c/sc3338.c
if (!sc3338->is_thunderboot) {
	ret = sc3338_write_array(sc3338->client, sc3338_global_regs);
	if (ret) {
		v4l2_err(sd, "could not set init registers\n");
```

意思很明确：

- 普通路径：Linux 写 `sc3338_global_regs`
- thunderboot 路径：**不写**

所以 MCU 预热阶段已经配置好的那些寄存器不会被 Linux 立刻覆盖掉。

---

## 4. `start_stream()` 时跳过模式寄存器表重写

```928:931:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/i2c/sc3338.c
if (!sc3338->is_thunderboot) {
	ret = sc3338_write_array(sc3338->client, sc3338->cur_mode->reg_list);
	if (ret)
```

同理：

- 普通 stream-on：重写 mode 寄存器表
- thunderboot：**跳过这一步**

然后只做必要的 `CTRL_MODE` 切换即可。

---

## 5. 失败时允许回退到普通冷启动

如果 ISP 侧判断 thunderboot 结果无效，会把状态设成 `RKISP_TB_NG`。  
sensor stream-on 时会检测这个状态，必要时退回普通冷启动。

```883:886:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/i2c/sc3338.c
if (sc3338->is_thunderboot && rkisp_tb_get_state() == RKISP_TB_NG) {
	sc3338->is_thunderboot = false;
	__sc3338_power_on(sc3338);
}
```

这说明 Linux 不是盲信 MCU 结果，而是有**失败回退机制**。

---

## 6. first streamoff 后再退出 thunderboot

```861:865:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/i2c/sc3338.c
sc3338->has_init_exp = false;
if (sc3338->is_thunderboot) {
	sc3338->is_first_streamoff = true;
	pm_runtime_put(&sc3338->client->dev);
}
```

以及：

```1023:1026:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/i2c/sc3338.c
if (sc3338->is_thunderboot) {
	if (sc3338->is_first_streamoff) {
		sc3338->is_thunderboot = false;
		sc3338->is_first_streamoff = false;
```

这说明 thunderboot 不是永久模式，而是**只覆盖 Linux 接手初期**。  
一旦 Linux 完成首轮接管，它会退出这种特殊路径，恢复常规管理。

---

# 四、ISP 驱动如何共享并使用 MCU 留下的参数

真正“共享参数并继续使用”的核心在 ISP 驱动，不在 sensor 驱动。

---

## 1. 共享入口：`rkisp_chk_tb_over()`

这个函数就是 Linux ISP 侧把 MCU thunderboot 结果“吃进来”的核心入口。

先看它的前置条件：

```3973:3976:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/platform/rockchip/isp/rkisp.c
if (!isp_dev->is_thunderboot)
	return;

if (isp_dev->isp_ver == ISP_V32 && params_vdev->is_first_cfg)
```

只有 ISP 设备被标记为 thunderboot，Linux 才会走这个接管逻辑。

---

## 2. 它会从 reserved memory 里取出 thunderboot 头和参数块

```3925:3943:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/platform/rockchip/isp/rkisp.c
switch (isp_dev->isp_ver) {
case ISP_V32:
	size = sizeof(struct rkisp32_thunderboot_resmem_head);
	offset = size * isp_dev->dev_id;
	break;
default:
	break;
}

...
if (isp_dev->isp_ver == ISP_V32) {
	struct rkisp32_thunderboot_resmem_head *tmp = resmem_va + offset;

	param = &tmp->cfg;
	head = &tmp->head;
```

这段说明：

- reserved memory 里不是简单一个标志位；
- 对 V32，Linux 会按 `dev_id` 定位自己的那份 thunderboot 区块；
- 从中取出：
  - `head`
  - `cfg`

也就是说，**MCU 留下的不只是“完成了”这个状态，还包括实际 ISP 参数配置。**

---

## 3. Linux 会把这份 `cfg` 保存成 ISP 的第一份参数

```3936:3948:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/platform/rockchip/isp/rkisp.c
if (isp_dev->is_rtt_first)
	params_vdev->is_first_cfg = true;
if (isp_dev->isp_ver == ISP_V32) {
	struct rkisp32_thunderboot_resmem_head *tmp = resmem_va + offset;

	param = &tmp->cfg;
	head = &tmp->head;
	...
}
if (param && (isp_dev->isp_state & ISP_STOP)) {
	params_vdev->ops->get_param_size(params_vdev,
		&params_vdev->vdev_fmt.fmt.meta.buffersize);
	params_vdev->ops->save_first_param(params_vdev, param);
}
```

这就是最关键的证据。

不是“Linux 看了一眼状态，然后自己重新算”——而是：

**Linux 直接把 reserved memory 里的 `cfg` 保存为 ISP 参数设备的 first param。**

这可以严格表述为：

> MCU 在 `stop_ae()` 前后整理并写入 shared/reserved memory 的 ISP 参数，Linux ISP 驱动在 `rkisp_chk_tb_over()` 中读取该参数块，并通过 `save_first_param()` 纳入后续 ISP 参数流程。

这就是“共享并使用”的核心。

---

## 4. Linux 还会把 thunderboot head 拷入本地 `tb_head`

```3953:3958:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/platform/rockchip/isp/rkisp.c
} else if (size > isp_dev->resmem_size) {
	...
	head->complete = RKISP_TB_NG;
}
memcpy(&isp_dev->tb_head, head, sizeof(*head));
```

这意味着后续 Linux driver 的其它判断，不需要每次都去读 shared memory，可以直接看 `isp_dev->tb_head`。

---

## 5. Linux 会轮询 MCU 完成状态，并在完成后正式切到本地 IRQ/clock 管理

```4014:4033:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/platform/rockchip/isp/rkisp.c
tb_state = RKISP_TB_OK;
if (head->complete != RKISP_TB_OK) {
	head->frm_total = 0;
	tb_state = RKISP_TB_NG;
}

if (hw->is_thunderboot) {
	rkisp_register_irq(hw);
	rkisp_tb_set_state(tb_state);
	rkisp_tb_unprotect_clk();
	hw->is_thunderboot = false;
}
isp_dev->is_thunderboot = false;
```

这里有 3 个非常重要的动作：

1. `rkisp_register_irq(hw)`  
   Linux 开始接管自己的 ISP 中断。

2. `rkisp_tb_set_state(tb_state)`  
   把 thunderboot 成败结果写成全局状态，sensor 驱动可以据此决定是否回退。

3. `rkisp_tb_unprotect_clk()`  
   把 loader/thunderboot 阶段保护住的 ISP 时钟交还 Linux 正常管理。

这就是 MCU->Linux 交接在线内核里的真正完成点。

---

# 五、`rkisp_tb_helper` 在这里扮演什么角色

它不是算法层，而是**交接辅助层**。

---

## 1. loader/thunderboot 阶段先保护 ISP 时钟

```168:174:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/platform/rockchip/isp/rkisp_tb_helper.c
if (rkisp_tb_pdev) {
	pm_runtime_enable(&rkisp_tb_pdev->dev);
	pm_runtime_get_sync(&rkisp_tb_pdev->dev);
	if (rkisp_tb_clk_num) {
		ret = clk_bulk_prepare_enable(rkisp_tb_clk_num, rkisp_tb_clk);
```

也就是说，为了不让 MCU 预热好的 ISP 在 Linux 早期 probe / PM 过程中掉电，helper 会先把 runtime pm / clk 保住。

---

## 2. 完成接管后再 unprotect

前面 `rkisp_chk_tb_over()` 已经看到：

```4027:4031:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/platform/rockchip/isp/rkisp.c
if (hw->is_thunderboot) {
	rkisp_register_irq(hw);
	rkisp_tb_set_state(tb_state);
	rkisp_tb_unprotect_clk();
	hw->is_thunderboot = false;
```

所以它的作用非常明确：

- 预热期：保护 clock / PM
- 接管完成：解除保护，交还 Linux 正常管理

---

## 3. 它还能把共享物理内存包装成 `dma_buf`

在 `rkisp_ioctl()` 里：

```3625:3626:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/platform/rockchip/isp/rkisp.c
shmem = (struct rkisp_thunderboot_shmem *)arg;
ret = rkisp_tb_shm_ioctl(shmem);
```

这说明 Linux 还提供了一条 ioctl，把 thunderboot shared memory 包装成 `dma_buf fd`。  
这一部分更偏向用户态/跨模块共享，不是 MCU->kernel 接管的唯一主路径，但它说明：

**thunderboot 共享区在 Linux 内核里是被正式建模和导出的，不是临时野指针。**

---

# 六、CIF 层如何参与最后的切换

如果说 sensor 负责“不重置”，ISP 负责“吃参数”，那 CIF 负责的是 **stream-on 时与 MCU 完成最后的时序协调**。

看 `cif/dev.c`：

```1245:1250:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/platform/rockchip/cif/dev.c
if (p->subdevs[i] == cif_dev->terminal_sensor.sd &&
    on &&
    cif_dev->is_thunderboot &&
    !rk_tb_mcu_is_done()) {
	cif_dev->tb_client.data = p->subdevs[i];
	cif_dev->tb_client.cb = rkcif_sensor_streaming_cb;
```

这段的含义是：

- 当 Linux 侧要对 terminal sensor 做 `s_stream(on)`；
- 如果还是 thunderboot，并且 MCU 尚未声明 done；
- CIF **不立即按普通路径直接 stream-on sensor**；
- 而是注册一个 thunderboot client callback，等待 MCU 结束时序。

这说明 CIF 并不是无脑立即切，而是显式考虑了：

> MCU 也许还在收尾，Linux 不能抢着把 sensor 的 streaming 时序打乱。

另外，CIF 自己也会在 probe/reserved memory 阶段进入 thunderboot 状态：

```2268:2295:/home/alientek/RV1106/SDK/luckfox-pico/sysdrv/source/kernel/drivers/media/platform/rockchip/cif/dev.c
cif_dev->is_thunderboot = false;
...
if (IS_ENABLED(CONFIG_VIDEO_ROCKCHIP_THUNDER_BOOT_ISP))
	cif_dev->is_thunderboot = true;
dev_info(dev, "Allocated reserved memory, paddr: 0x%x, size 0x%x\n",
```

所以不是只有 ISP driver 感知 thunderboot，CIF 也在参与这套接管协议。

---

# 七、所以 Linux 到底是在“共享硬件”，还是“共享状态”？

严谨地说，是：

## 1. 共享硬件“当前态”
也就是：

- 当前电源/时钟/寄存器配置不被破坏；
- reset/pwdn 不乱动；
- stream-on/stream-off 按 thunderboot 特殊分支处理。

## 2. 共享 reserved memory 中的“首帧参数结果”
也就是：

- `tb_head`
- `cfg`
- complete / frm_total / camera_num / width / height 等信息

而不是：

- Linux 和 MCU 同时共同控制同一 ISP 算法线程；
- 或者 Linux 直接接管 MCU 的任务上下文。

所以最准确表述是：

> Linux driver 对 MCU 预热成果的接管，本质是“**硬件状态保持 + 共享内存参数继承 + 时钟/IRQ控制权回收**”。

---

# 八、把 `stop_ae()` 之后的 Linux 接管，压缩成一句话

可以精确写成：

> `stop_ae()` 之后，MCU 将收敛后的 thunderboot 头信息和 ISP 参数块写入 reserved/shared memory；Linux 在 ISP 驱动的 `rkisp_chk_tb_over()` 中轮询并读取这些结果，通过 `save_first_param()` 把 MCU 生成的 first ISP config 纳入本地参数系统，同时 sensor 驱动通过 thunderboot 分支跳过 reset/重新上电/全量寄存器初始化，CIF/ISP 再在 stream-on 和 IRQ/clock 管理上完成最终切换，从而实现从 MCU 预热态到 Linux 正常媒体栈的无冷启动接管。

---

# 九、最终回答你的问题

## 问：`stop_ae()` 以后，Linux 驱动层面是如何在 driver 中共享并使用这些预热好的硬件的？

### 答：

不是单点接口，而是 3 层配合：

### 第一层：sensor 驱动保持预热硬件态
- `GPIOD_ASIS` 保持 reset/pwdn
- 跳过 sensor id check
- 跳过 power_on 全流程
- 跳过 global regs / mode regs 重写
- 失败时再回退普通冷启动

关键证据在 `sc3338.c`。

---

### 第二层：ISP 驱动读取 reserved memory 中的 thunderboot 结果
- probe 时绑定 `memory-region-thunderboot`
- `rkisp_chk_tb_over()` 轮询 MCU 完成
- 从 `rkisp32_thunderboot_resmem_head` 里取 `head + cfg`
- 用 `save_first_param()` 保存 MCU 留下的 first ISP params
- 写入 `tb_head`
- 设置 thunderboot 成败状态给 sensor 驱动
- 注册本地 IRQ，解除 clock 保护，接回 Linux 控制

关键证据在 `isp/dev.c`、`rkisp.c`、`rkisp_tb_helper.c`。

---

### 第三层：CIF 在 stream-on 时与 MCU 完成时序协调
- 若 MCU 还没 done，CIF 不立即按普通路径直接触发 sensor stream
- 而是通过 thunderboot callback 等待 MCU 结束
- 避免 Linux 抢占 sensor/ISP 正在进行的预热收尾过程

关键证据在 `cif/dev.c`。

---

如果你愿意，我下一步可以继续做两件更细的事：

1. 把 **`stop_ae()` 在 MCU 里写 shared_data / resmem** 的字段，和 **Linux `rkisp_chk_tb_over()` 读到的字段** 一一对表；  
2. 进一步追 `save_first_param()` 之后，这份 first ISP cfg 在 `isp_params_v32.c` 里是怎么真正下发到 ISP 寄存器的。

