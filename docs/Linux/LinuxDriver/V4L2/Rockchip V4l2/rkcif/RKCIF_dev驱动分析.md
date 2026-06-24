# RKCIF platform driver analysis
_Exported on 2026/4/16 at GMT+8 15:10:40 from Cursor (2.6.21)_

---

**User**

@kernel/drivers/media/platform/rockchip/cif/dev.c 帮我结合具体源码详细分析一下具体干了什么？
rkcif_plat_drv
　　->rkcif_plat_probe
　　　　->sysfs_create_group--创建一系列sysfs属性节点。
　　　　->rkcif_attach_hw--查找"rockchip,hw"对应数据结构，将其和struct rkcif_device匹配。
　　　　->rkcif_parse_dts--获取"wait-line"值。
　　　　->rkcif_plat_init
　　　　　　->rkcif_stream_init--初始化rkcif_stream设备。
　　　　　　->rkcif_init_scale_vdev--rkcif_scale_vdev初始化rkcif_scale_vdev设备。
　　　　　　->rkcif_init_tools_vdev--初始化rkcif_tools_vdev设备。
　　　　　　->v4l2_device_register
　　　　　　->media_device_init
　　　　　　->media_device_register
　　　　　　->rkcif_register_platform_subdevs
　　　　　　　　->rkcif_register_stream_vdevs--创建设备位于/sys/devices/platform/rkcif-mipi-lvds2/video4linux/videoX，共4个。
　　　　　　　　　　->rkcif_register_stream_vdev--依次创建4个RKCIF_STREAM_MIPI_IDx设备。
　　　　　　　　　　　　->rkcif_init_vb2_queue--初始化struct vb2_queue。
　　　　　　　　　　　　->video_register_device--注册v4l2设备，操作函数集为rkcif_fops和rkcif_v4l2_ioctl_ops。
　　　　　　　　　　　　->media_entity_pads_init--初始化一个Sink Pad。
　　　　　　　　->rkcif_register_scale_vdevs--对应VICAP的4个Scale设备，创建设备位于/sys/devices/platform/rkcif-mipi-lvds2/video4linux/videox。
　　　　　　　　　　->rkcif_register_scale_vdev--依次创建4个RKCIF_SCALE_CHx设备。
　　　　　　　　　　　　->rkcif_scale_init_vb2_queue
　　　　　　　　　　　　->media_entity_pads_init
　　　　　　　　　　　　->video_register_device--注册v4l2设备，操作函数集为rkcif_scale_fops和rkcif_scale_ioctl。
　　　　　　　　->rkcif_register_tools_vdevs
　　　　　　　　　　->rkcif_register_tools_vdev--依次创建3个RKCIF_TOOLS_CHx设备。
　　　　　　　　　　　　->rkcif_tools_init_vb2_queue
　　　　　　　　　　　　->media_entity_pads_init
　　　　　　　　　　　　->video_register_device--注册v4l2设备，操作函数集为rkcif_tools_fops和rkcif_tools_ioctl。
　　　　　　　　->cif_subdev_notifier
　　　　　　　　　　->v4l2_async_notifier_init
　　　　　　　　　　->v4l2_async_notifier_parse_fwnode_endpoints--解析/rkcif-mipi-lvds2/port下的endpoint。
　　　　　　　　　　->v4l2_async_notifier_register
　　　　　　->rkcif_register_luma_vdev
　　　　->rkcif_get_reserved_mem
　　　　->rkcif_proc_init--创建/proc/rkcif-mipi-lvds2，显示当前设备信息。
　　　　->rkcif_init_reset_monitor
按这个流程分析一下

---

**Cursor**

可以，我按你给的这条 `probe` 主线，结合 `dev.c` 以及相关 `capture.c`、`cif-scale.c`、`cif-tools.c`、`cif-luma.c`、`procfs.c` 的实际源码，给你做一遍“从平台驱动注册到各 video 节点落地”的详细分析。

---

# 1. 总体先看：`rkcif_plat_drv` 到底是什么

`rkcif_plat_drv` 是这个 Rockchip CIF 平台驱动的入口。它把设备树里匹配到的：

- `rockchip,rkcif-dvp`
- `rockchip,rkcif-mipi-lvds`

这两类节点，挂到同一个 platform driver 上。

`dev.c` 末尾可以看到：

```2200:2211:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
struct platform_driver rkcif_plat_drv = {
	.driver = {
		.name = CIF_DRIVER_NAME,
		.of_match_table = of_match_ptr(rkcif_plat_of_match),
		.pm = &rkcif_plat_pm_ops,
	},
	.probe = rkcif_plat_probe,
	.remove = rkcif_plat_remove,
};
```

也就是说：

- 设备树节点匹配成功后
- 内核进入 `rkcif_plat_probe()`
- 这里完成整个 CIF 设备的软件实例化、媒体拓扑建立、video 节点注册、异步绑定 sensor 等工作

你给出的流程基本是对的，但如果结合源码看，它不仅仅是“创建设备节点”，更重要的是：

1. 把 `cif_dev` 和底层共享硬件 `hw_dev` 绑定起来  
2. 初始化内部 stream/scale/tools/luma 这些软件对象  
3. 注册到 V4L2/Media 子系统  
4. 解析设备树 endpoint，等真正的 sensor subdev 异步绑上来  
5. 最终形成完整采集链路

---

# 2. `rkcif_plat_probe` 主流程总览

先看 `probe` 的骨架：

```2140:2193:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int rkcif_plat_probe(struct platform_device *pdev)
{
	...
	cif_dev = devm_kzalloc(dev, sizeof(*cif_dev), GFP_KERNEL);
	...
	dev_set_drvdata(dev, cif_dev);
	cif_dev->dev = dev;

	if (sysfs_create_group(&pdev->dev.kobj, &dev_attr_grp))
		return -ENODEV;

	ret = rkcif_attach_hw(cif_dev);
	if (ret)
		return ret;

	rkcif_parse_dts(cif_dev);

	ret = rkcif_plat_init(cif_dev, node, data->inf_id);
	if (ret) {
		rkcif_detach_hw(cif_dev);
		return ret;
	}

	ret = rkcif_get_reserved_mem(cif_dev);
	if (ret)
		return ret;

	if (rkcif_proc_init(cif_dev))
		dev_warn(dev, "dev:%s create proc failed\n", dev_name(dev));

	rkcif_init_reset_monitor(cif_dev);
	if (cif_dev->chip_id == CHIP_RV1106_CIF)
		rkcif_rockit_dev_init(cif_dev);
	pm_runtime_enable(&pdev->dev);

	return 0;
}
```

这段代码说明 probe 阶段主要分成 8 步：

1. 分配 `struct rkcif_device`
2. 创建 sysfs 属性
3. 挂接底层硬件 `hw_dev`
4. 解析 dts 参数
5. 做平台初始化 `rkcif_plat_init`
6. 获取 reserved memory
7. 创建 `/proc` 调试入口
8. 初始化 reset monitor 和 PM runtime

下面按你列的链路逐层分析。

---

# 3. `sysfs_create_group`：创建一组调试/控制属性

这个步骤对应：

```2147:2157:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
	dev_set_drvdata(dev, cif_dev);
	cif_dev->dev = dev;

	if (sysfs_create_group(&pdev->dev.kobj, &dev_attr_grp))
		return -ENODEV;
```

## 3.1 它创建了哪些属性

`dev_attr_grp` 定义在文件前面：

```476:488:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static struct attribute *dev_attrs[] = {
	&dev_attr_compact_test.attr,
	&dev_attr_wait_line.attr,
	&dev_attr_is_use_dummybuf.attr,
	&dev_attr_is_high_align.attr,
	&dev_attr_scale_ch0_blc.attr,
	&dev_attr_scale_ch1_blc.attr,
	&dev_attr_scale_ch2_blc.attr,
	&dev_attr_scale_ch3_blc.attr,
	&dev_attr_fps.attr,
	&dev_attr_rdbk_debug.attr,
	NULL,
};
```

也就是会在对应 platform 设备目录下生成这类节点：

- `compact_test`
- `wait_line`
- `is_use_dummybuf`
- `is_high_align`
- `scale_ch0_blc` ~ `scale_ch3_blc`
- `fps`
- `rdbk_debug`

## 3.2 这些属性具体控制什么

### `wait_line`
用于设置/显示 line interrupt 的阈值，和你后面 `rkcif_parse_dts` 读到的 `wait-line` 是一脉相承的。  
它会写到 `cif_dev->wait_line_cache`，用于 line wakeup 相关控制。

### `compact_test`
控制 `stream[0..3].is_compact`，也就是 RAW 数据是走 compact 存储还是 16bit 对齐存储。

### `is_high_align`
控制 `stream[i].is_high_align`，影响 CSI 路径下写 DDR 时的高位对齐。

### `is_use_dummybuf`
控制无有效 buffer 时是否使用 dummy buffer 兜底，避免 DMA 没地址。

### `scale_chx_blc`
设置每个 scale 通道的 BLC 参数。

### `fps`
给某些芯片上的 stream 动态设置帧率。

### `rdbk_debug`
回读/debug 标志位。

**结论：**  
这一步本质不是核心业务初始化，而是“给 driver 提前挂上一组运行时可调参数和调试开关”。

---

# 4. `rkcif_attach_hw`：把 `cif_dev` 挂到共享硬件实例上

你这里总结成：

> 查找 `"rockchip,hw"` 对应数据结构，将其和 `struct rkcif_device` 匹配

这个说法是对的，而且这是理解 RK CIF 驱动架构的关键点。

源码：

```1801:1835:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
int rkcif_attach_hw(struct rkcif_device *cif_dev)
{
	struct device_node *np;
	struct platform_device *pdev;
	struct rkcif_hw *hw;

	if (cif_dev->hw_dev)
		return 0;

	cif_dev->chip_id = CHIP_RV1126_CIF_LITE;
	np = of_parse_phandle(cif_dev->dev->of_node, "rockchip,hw", 0);
	if (!np || !of_device_is_available(np)) {
		dev_err(cif_dev->dev, "failed to get cif hw node\n");
		return -ENODEV;
	}

	pdev = of_find_device_by_node(np);
	...
	hw = platform_get_drvdata(pdev);
	if (!hw) {
		dev_err(cif_dev->dev, "failed attach cif hw\n");
		return -EINVAL;
	}

	hw->cif_dev[hw->dev_num] = cif_dev;
	hw->dev_num++;
	cif_dev->hw_dev = hw;
	cif_dev->chip_id = hw->chip_id;
	...
	return 0;
}
```

## 4.1 它到底干了什么

它从当前 CIF 节点的设备树属性：

- `rockchip,hw = <...>`

取到一个 phandle，找到对应 platform device，再取出该 device 的私有数据 `struct rkcif_hw`。

然后做两件事：

### 第一件：让 `cif_dev` 知道自己归哪个硬件块管
```c
cif_dev->hw_dev = hw;
cif_dev->chip_id = hw->chip_id;
```

### 第二件：让共享硬件 `hw` 也知道“我下面挂了哪些 cif 逻辑设备”
```c
hw->cif_dev[hw->dev_num] = cif_dev;
hw->dev_num++;
```

所以它本质上是在建立**双向关联**：

- `cif_dev -> hw_dev`
- `hw_dev -> cif_dev[]`

## 4.2 为什么要这样设计

因为 Rockchip 这里一般不是每个 video 节点都对应一套独立硬件寄存器，而是：

- 一个共享的 CIF 硬件 block
- 上面再分多个逻辑采集通道 / scale / tools / luma
- 多个 `rkcif_device` 可能共享一个 `rkcif_hw`

所以 `rkcif_device` 更像“一个平台实例/逻辑设备”，而 `rkcif_hw` 才更像“真正的底层寄存器硬件资源”。

## 4.3 附带动作：RV1106 还会挂 dphy_hw

如果是 RV1106 平台，还会继续挂 CSI DPHY 硬件：

```1774:1799:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static void rkcif_attach_dphy_hw(struct rkcif_device *cif_dev)
{
	...
	np = of_parse_phandle(dev->of_node, "rockchip,dphy_hw", 0);
	...
	dphy_hw = platform_get_drvdata(plat_dev);
	...
	cif_dev->dphy_hw = dphy_hw;
}
```

---

# 5. `rkcif_parse_dts`：解析 `wait-line`

源码很简单：

```2096:2107:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static void rkcif_parse_dts(struct rkcif_device *cif_dev)
{
	int ret = 0;
	struct device_node *node = cif_dev->dev->of_node;

	ret = of_property_read_u32(node,
			     OF_CIF_WAIT_LINE,
			     &cif_dev->wait_line);
	if (ret != 0)
		cif_dev->wait_line = 0;
	dev_info(cif_dev->dev, "rkcif wait line %d\n", cif_dev->wait_line);
}
```

## 5.1 它做的事
从设备树节点里读一个 `wait-line` 属性，存到：

- `cif_dev->wait_line`

如果没有，就置 0。

## 5.2 这个值后面怎么用
后面在 CSI 通道配置时会用到：

```3566:3583:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/capture.c
	if (detect_stream->is_line_wake_up) {
		rkcif_write_register_or(dev, CIF_REG_MIPI_LVDS_INTEN,
					CSI_LINE_INTEN(channel->id));
		wait_line = dev->wait_line;
	}
	rkcif_write_register(dev, CIF_REG_MIPI_LVDS_LINE_INT_NUM_ID0_1,
			     wait_line << 16 | wait_line);
	rkcif_write_register(dev, CIF_REG_MIPI_LVDS_LINE_INT_NUM_ID2_3,
			     wait_line << 16 | wait_line);
```

也就是说：

- 如果使能了 line wakeup / line interrupt
- 它会把 `wait_line` 编程到硬件寄存器中
- 让 CSI 在某一行到达时触发 line interrupt

**结论：**  
这不是一个普通调试参数，而是影响 CSI line 中断触发位置的硬件配置。

---

# 6. `rkcif_plat_init`：整个 probe 的核心初始化函数

这是整个流程最关键的部分。它不是简单“初始化一下结构体”，而是把整个 CIF 软件对象体系建立起来。

源码前半段：

```1865:1946:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
int rkcif_plat_init(struct rkcif_device *cif_dev, struct device_node *node, int inf_id)
{
	struct device *dev = cif_dev->dev;
	struct v4l2_device *v4l2_dev;
	int ret;

	cif_dev->hdr.hdr_mode = NO_HDR;
	cif_dev->inf_id = inf_id;

	mutex_init(&cif_dev->stream_lock);
	mutex_init(&cif_dev->scale_lock);
	mutex_init(&cif_dev->tools_lock);
	spin_lock_init(&cif_dev->hdr_lock);
	spin_lock_init(&cif_dev->buffree_lock);
	spin_lock_init(&cif_dev->reset_watchdog_timer.timer_lock);
	spin_lock_init(&cif_dev->reset_watchdog_timer.csi2_err_lock);
	atomic_set(&cif_dev->pipe.power_cnt, 0);
	atomic_set(&cif_dev->pipe.stream_cnt, 0);
	atomic_set(&cif_dev->power_cnt, 0);
	...
	cif_dev->pipe.open = rkcif_pipeline_open;
	cif_dev->pipe.close = rkcif_pipeline_close;
	cif_dev->pipe.set_stream = rkcif_pipeline_set_stream;
	cif_dev->isr_hdl = rkcif_irq_handler;
	...
	if (cif_dev->chip_id == CHIP_RV1126_CIF_LITE)
		cif_dev->isr_hdl = rkcif_irq_lite_handler;

	INIT_WORK(&cif_dev->err_state_work.work, rkcif_err_print_work);
	...
}
```

## 6.1 这一步先完成“软件骨架初始化”

包括：

- 锁
- atomic 计数
- pipeline 操作函数
- 中断处理函数入口
- workqueue 工作项
- 一堆状态变量清零

这些都是后面 stream on/off、IRQ、buffer 管理的基础。

---

# 7. `rkcif_stream_init`：初始化 stream 设备对象

你说：

> 初始化 `rkcif_stream` 设备

这个说法对，但要更准确一点：  
它初始化的是**每个采集通道对应的软件上下文**，还没注册成 `/dev/videoX`，只是把 stream 对象准备好。

在 `rkcif_plat_init()` 中，根据芯片和接口类型决定初始化几个 stream：

```1894:1909:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
	if (cif_dev->chip_id < CHIP_RV1126_CIF) {
		if (cif_dev->inf_id == RKCIF_MIPI_LVDS) {
			rkcif_stream_init(cif_dev, RKCIF_STREAM_MIPI_ID0);
			rkcif_stream_init(cif_dev, RKCIF_STREAM_MIPI_ID1);
			rkcif_stream_init(cif_dev, RKCIF_STREAM_MIPI_ID2);
			rkcif_stream_init(cif_dev, RKCIF_STREAM_MIPI_ID3);
		} else {
			rkcif_stream_init(cif_dev, RKCIF_STREAM_CIF);
		}
	} else {
		rkcif_stream_init(cif_dev, RKCIF_STREAM_MIPI_ID0);
		rkcif_stream_init(cif_dev, RKCIF_STREAM_MIPI_ID1);
		rkcif_stream_init(cif_dev, RKCIF_STREAM_MIPI_ID2);
		rkcif_stream_init(cif_dev, RKCIF_STREAM_MIPI_ID3);
	}
```

## 7.1 为什么有时 1 个 stream，有时 4 个 stream

- 旧一些芯片 + DVP：可能只有单 stream
- MIPI/LVDS：最多 4 路虚拟通道/ID
- RV1126/RK356x 以后，即使 BT656/BT1120/MIPI，也统一按多通道模型来管理

所以这里不是简单“固定创建 4 个”，而是由：

- `chip_id`
- `inf_id`

共同决定。

## 7.2 stream 初始化后承载什么

虽然你当前问题聚焦 probe，但从后续 `capture.c` 代码能看出来，一个 `rkcif_stream` 后面会承载：

- 当前输出格式 `pixm`
- 输入/输出格式信息 `cif_fmt_in/out`
- vb2 buffer 队列关联
- 当前/下一帧 buffer
- frame sequence 统计
- DMA enable 状态
- 与 tools/scale 的关联
- 该路 CSI channel 的配置

换句话说：

**stream 是“采集通道的软件核心对象”。**

---

# 8. `rkcif_init_scale_vdev`：初始化 Scale 通道软件对象

这一步只在支持 scale 的芯片上执行：

```1911:1918:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
	if (cif_dev->chip_id == CHIP_RK3588_CIF ||
	    cif_dev->chip_id == CHIP_RV1106_CIF ||
	    cif_dev->chip_id == CHIP_RK3562_CIF) {
		rkcif_init_scale_vdev(cif_dev, RKCIF_SCALE_CH0);
		rkcif_init_scale_vdev(cif_dev, RKCIF_SCALE_CH1);
		rkcif_init_scale_vdev(cif_dev, RKCIF_SCALE_CH2);
		rkcif_init_scale_vdev(cif_dev, RKCIF_SCALE_CH3);
	}
```

它的作用不是注册节点，而是初始化每个 `scale_vdev[ch]` 软件对象。

从 `cif-scale.c` 的逻辑看，它后面主要做这些事：

- 绑定所属 `cif_dev`
- 绑定上游 `stream`
- 设置默认像素格式和默认分辨率
- 初始化 buffer 链表
- 初始化 spinlock / waitqueue / work

后续 scale 工作时，它会把对应 stream 的数据做硬件缩放输出。  
而且它不是一个“独立摄像头源”，而是**基于现有 stream 的后级处理节点**。

另外它对输出格式有限制，`cif-scale.c` 一开始就能看到它支持的是一些 Bayer RAW 16bit 格式，不是通用 YUV 缩放节点。

---

# 9. `rkcif_init_tools_vdev`：初始化 Tools 通道软件对象

源码可见：

```782:805:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-tools.c
void rkcif_init_tools_vdev(struct rkcif_device *cif_dev, u32 ch)
{
	struct rkcif_tools_vdev *tools_vdev = &cif_dev->tools_vdev[ch];
	struct rkcif_stream *stream = &cif_dev->stream[ch];
	struct v4l2_pix_format_mplane pixm;

	memset(tools_vdev, 0, sizeof(*tools_vdev));
	...
	tools_vdev->cifdev = cif_dev;
	tools_vdev->stream = stream;
	stream->tools_vdev = tools_vdev;
	tools_vdev->ch = ch;
	...
	pixm.pixelformat = V4L2_PIX_FMT_SBGGR10;
	pixm.width = RKCIF_DEFAULT_WIDTH;
	pixm.height = RKCIF_DEFAULT_HEIGHT;
	tools_vdev->state = RKCIF_STATE_READY;
	INIT_LIST_HEAD(&tools_vdev->buf_head);
	INIT_LIST_HEAD(&tools_vdev->buf_done_head);
	INIT_LIST_HEAD(&tools_vdev->src_buf_head);
	spin_lock_init(&tools_vdev->vbq_lock);
	rkcif_tools_set_fmt(tools_vdev, &pixm, false);
	init_waitqueue_head(&tools_vdev->wq_stopped);
	INIT_WORK(&tools_vdev->work, rkcif_tools_work);
}
```

## 9.1 本质作用
它初始化的是一个“工具类输出节点”的软件描述。

### 特点：
- 每个 tools 通道绑定一个 stream
- 默认走 RAW Bayer 输出
- 维护独立 vb2 队列和完成队列
- 通过 workqueue 做数据搬运/回读处理

## 9.2 它和主 stream 的关系
从 `rkcif_tools_work()` 可以看出：

```771:780:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-tools.c
static void rkcif_tools_work(struct work_struct *work)
{
	struct rkcif_tools_vdev *tools_vdev = container_of(work,
						struct rkcif_tools_vdev,
						work);
	if (tools_vdev->stream->dma_en & RKCIF_DMAEN_BY_VICAP)
		rkcif_tools_buf_done(tools_vdev);
	else if (tools_vdev->stream->dma_en & RKCIF_DMAEN_BY_ISP)
		rkcif_tools_buf_done_rdbk(tools_vdev);
}
```

说明 tools 通道不是前端直接采集，而是依赖 stream 当前 DMA 数据来源：

- VICAP
- ISP 回读

去做后续 buffer 完成处理。

所以它更像“辅助输出口/工具数据口”。

---

# 10. `v4l2_device_register`：把 CIF 纳入 V4L2 框架

在 `rkcif_plat_init` 中：

```1994:2001:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
	v4l2_dev = &cif_dev->v4l2_dev;
	v4l2_dev->mdev = &cif_dev->media_dev;
	strlcpy(v4l2_dev->name, dev_name(dev), sizeof(v4l2_dev->name));

	ret = v4l2_device_register(cif_dev->dev, &cif_dev->v4l2_dev);
	if (ret < 0)
		return ret;
```

## 10.1 作用
这一步是把 `cif_dev->v4l2_dev` 注册到 V4L2 core。

没有这一步，后面这些都没法正常做：

- 注册 video device
- 注册 subdev
- async notifier
- subdev node

也就是说：  
**这是整个 CIF 实例成为 V4L2 设备管理树根节点的前提。**

---

# 11. `media_device_init` / `media_device_register`：把 CIF 纳入 Media Controller 拓扑

紧接着：

```2002:2009:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
	media_device_init(&cif_dev->media_dev);
	ret = media_device_register(&cif_dev->media_dev);
	if (ret < 0) {
		v4l2_err(v4l2_dev, "Failed to register media device: %d\n",
			 ret);
		goto err_unreg_v4l2_dev;
	}
```

## 11.1 作用
V4L2 解决的是“视频节点和 ioctl 访问”，  
Media Controller 解决的是“整个视频链路拓扑关系”。

注册后，`cif_dev` 这套节点就能出现在 `/dev/mediaX` 对应的 media graph 里，后续 sensor、cif stream、scale、tools、luma 等 entity/pad/link 都能被串起来。

**所以这一步是“让 CIF 成为一个媒体设备图的一部分”。**

---

# 12. `rkcif_register_platform_subdevs`：真正注册各类 video 节点 + 异步 sensor 绑定

这个函数是 `rkcif_plat_init()` 内部最关键的一步：

```2011:2014:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
	/* create & register platefom subdev (from of_node) */
	ret = rkcif_register_platform_subdevs(cif_dev);
	if (ret < 0)
		goto err_unreg_media_dev;
```

它不是只注册“subdev”，实际上还干了：

1. 注册 stream video 节点  
2. 注册 scale video 节点  
3. 注册 tools video 节点  
4. 初始化 notifier，解析 endpoint，等待 sensor 绑定

源码：

```1688:1738:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int rkcif_register_platform_subdevs(struct rkcif_device *cif_dev)
{
	int stream_num = 0, ret;

	...
	ret = rkcif_register_stream_vdevs(...);

	...
	ret = rkcif_register_scale_vdevs(...);

	...
	ret = rkcif_register_tools_vdevs(...);

	init_completion(&cif_dev->cmpl_ntf);
	kthread_run(notifier_isp_thread, cif_dev, "notifier isp");
	ret = cif_subdev_notifier(cif_dev);
	...
}
```

下面拆开看。

---

# 13. `rkcif_register_stream_vdevs`：创建主采集视频节点

你说：

> 创建设备位于 `/sys/devices/platform/rkcif-mipi-lvds2/video4linux/videoX`，共 4 个

这个是对的，但要注意“是否 4 个”取决于前面的 `stream_num`。

在 `rkcif_register_platform_subdevs()` 里：

- 老芯片 + DVP：可能只注册 1 个
- MIPI/LVDS 或较新芯片：一般 4 个

## 13.1 本质作用
它为每个 `rkcif_stream` 注册一个 `struct video_device`，也就是用户态最终看到的 `/dev/videoX` 主采集节点。

这些节点是“真正用来 VIDIOC_REQBUFS / QBUF / STREAMON 抓图”的主视频口。

---

# 14. `rkcif_register_stream_vdev`：逐个注册单个 stream 节点

虽然这次没直接把函数体完整读出来，但从整个驱动模式，以及 scale/tools/luma 的写法，可以确定 stream 也是同样套路：

- 填 `video_device`
- 绑 `ioctl_ops`
- 绑 `fops`
- 初始化 vb2 队列
- 初始化 media entity pad
- `video_register_device()`

你总结的三步是对的：

## 14.1 `rkcif_init_vb2_queue`
作用：初始化 `struct vb2_queue`，把这个 video 节点和 vb2 buffer 管理框架接起来。

这意味着后续用户态的：

- `REQBUFS`
- `QUERYBUF`
- `QBUF`
- `DQBUF`
- `STREAMON/OFF`

都会走这套 queue。

## 14.2 `video_register_device`
作用：真正注册 `/dev/videoX`

同时它绑定的操作函数是：

- `rkcif_fops`
- `rkcif_v4l2_ioctl_ops`

也就是说用户态 open/ioctl/poll/mmap 都从这里进。

## 14.3 `media_entity_pads_init`
作用：初始化这个 video entity 的 pad。

你这里说“初始化一个 Sink Pad”——从 scale/tools/luma 来看，确实都是 `MEDIA_PAD_FL_SINK`，stream 一般也是 media graph 里的一个接收端视频节点，用于从上游 sensor/subdev 接数据。

---

# 15. `rkcif_register_scale_vdevs`：注册 VICAP 的 Scale 节点

这个只在支持 scale 的芯片上进行：

```1706:1714:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
	if (cif_dev->chip_id == CHIP_RK3588_CIF ||
	    cif_dev->chip_id == CHIP_RV1106_CIF ||
	    cif_dev->chip_id == CHIP_RK3562_CIF) {
		ret = rkcif_register_scale_vdevs(cif_dev, RKCIF_MAX_SCALE_CH, true);
```

## 15.1 每个 scale 节点的注册过程
`cif-scale.c` 中：

```1091:1139:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-scale.c
static int rkcif_register_scale_vdev(struct rkcif_scale_vdev *scale_vdev, bool is_multi_input)
{
	...
	vdev->ioctl_ops = &rkcif_scale_ioctl;
	vdev->fops = &rkcif_scale_fops;
	...
	rkcif_scale_init_vb2_queue(&node->buf_queue,
				   scale_vdev,
				   V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE);
	...
	ret = media_entity_pads_init(&vdev->entity, 1, &node->pad);
	...
	ret = video_register_device(vdev, VFL_TYPE_VIDEO, -1);
```

### 可见这几个关键点：

- `fops = rkcif_scale_fops`
- `ioctl_ops = rkcif_scale_ioctl`
- `queue` 类型是 `VIDEO_CAPTURE_MPLANE`
- pad 是 `SINK`
- 最后注册 `/dev/videoX`

## 15.2 `rkcif_scale_init_vb2_queue`
源码：

```853:872:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-scale.c
static int rkcif_scale_init_vb2_queue(struct vb2_queue *q,
				      struct rkcif_scale_vdev *scale_vdev,
				      enum v4l2_buf_type buf_type)
{
	...
	q->io_modes = VB2_MMAP | VB2_DMABUF;
	q->drv_priv = scale_vdev;
	q->ops = &rkcif_scale_vb2_ops;
	q->mem_ops = hw_dev->mem_ops;
	...
	q->min_buffers_needed = CIF_SCALE_REQ_BUFS_MIN;
	...
	return vb2_queue_init(q);
}
```

说明 scale 节点是完整的 vb2 capture 设备，可 mmap / dmabuf。

## 15.3 Scale 的真实功能
它不是普通“裁剪一下”，而是单独配置硬件 scale channel：

```610:639:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-scale.c
static int rkcif_scale_channel_set(struct rkcif_scale_vdev *scale_vdev)
{
	...
	rkcif_assign_scale_buffer_pingpong(scale_vdev, RKCIF_YUV_ADDR_STATE_INIT, ch);
	...
	rkcif_write_register(dev, CIF_REG_SCL_BLC_CH0 + ch, val);
	rkcif_write_register(dev, get_reg_index_of_scale_vlw(ch),
			     scale_vdev->ch_info.vir_width);
	...
	rkcif_write_register_or(dev, CIF_REG_SCL_CH_CTRL, val);
	return 0;
}
```

也就是说 scale video 节点背后真有独立硬件缩放通道控制。

---

# 16. `rkcif_register_tools_vdevs`：注册 Tools 节点

你说创建 3 个 `RKCIF_TOOLS_CHx`，这一点从源码能直接验证：

```826:873:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-tools.c
static int rkcif_register_tools_vdev(struct rkcif_tools_vdev *tools_vdev, bool is_multi_input)
{
	...
	switch (tools_vdev->ch) {
	case RKCIF_TOOLS_CH0:
		vdev_name = CIF_TOOLS_CH0_VDEV_NAME;
		break;
	case RKCIF_TOOLS_CH1:
		vdev_name = CIF_TOOLS_CH1_VDEV_NAME;
		break;
	case RKCIF_TOOLS_CH2:
		vdev_name = CIF_TOOLS_CH2_VDEV_NAME;
		break;
	...
	}

	...
	vdev->ioctl_ops = &rkcif_tools_ioctl;
	vdev->fops = &rkcif_tools_fops;
	...
	rkcif_tools_init_vb2_queue(&node->buf_queue,
				   tools_vdev,
				   V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE);
	...
	ret = media_entity_pads_init(&vdev->entity, 1, &node->pad);
	...
	ret = video_register_device(vdev, VFL_TYPE_VIDEO, -1);
```

## 16.1 你说的三步也完全成立

### `rkcif_tools_init_vb2_queue`
初始化这个 tools 节点的 vb2 队列

### `media_entity_pads_init`
初始化 media entity 的 pad

### `video_register_device`
生成 `/dev/videoX`

## 16.2 Tools 节点到底干嘛
从 `cif-tools.c` 看，它比较像：

- 从主 stream 派生出的 RAW/调试/辅助输出口
- 可直接接 VICAP DMA 数据
- 也可接 ISP 回读数据
- 通过 workqueue 做 buffer 完成和数据拷贝

所以它更像“给算法/调试/回读链路预留的附加采集口”。

---

# 17. `cif_subdev_notifier`：解析 endpoint，等待 sensor 异步绑定

这一步很关键，因为前面虽然把 `/dev/videoX` 都注册了，但**真正的 sensor 还没连上来**。  
只有 notifier 绑定完成之后，整个媒体链才完整。

源码：

```1610:1630:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int cif_subdev_notifier(struct rkcif_device *cif_dev)
{
	struct v4l2_async_notifier *ntf = &cif_dev->notifier;
	struct device *dev = cif_dev->dev;
	int ret;

	v4l2_async_notifier_init(ntf);

	ret = v4l2_async_notifier_parse_fwnode_endpoints(
		dev, ntf, sizeof(struct rkcif_async_subdev), rkcif_fwnode_parse);

	...
	ntf->ops = &subdev_notifier_ops;

	ret = v4l2_async_notifier_register(&cif_dev->v4l2_dev, ntf);

	return ret;
}
```

## 17.1 `v4l2_async_notifier_init`
初始化 notifier 对象。

## 17.2 `v4l2_async_notifier_parse_fwnode_endpoints`
这一句就是你说的：

> 解析 `/rkcif-mipi-lvds2/port` 下的 endpoint

准确说是：

- 从当前 device 的 fwnode / OF graph 中
- 把所有 endpoint 解析出来
- 为每个 endpoint 构造一个异步 subdev 匹配项

并且在 `rkcif_fwnode_parse()` 中还会解析出：

- 总线类型
- lane 数
- mbus flags

源码：

```1568:1592:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int rkcif_fwnode_parse(struct device *dev,
			      struct v4l2_fwnode_endpoint *vep,
			      struct v4l2_async_subdev *asd)
{
	...
	rk_asd->mbus.type = vep->bus_type;

	if (vep->bus_type == V4L2_MBUS_CSI2_DPHY ||
	    vep->bus_type == V4L2_MBUS_CSI2_CPHY) {
		rk_asd->mbus.flags = vep->bus.mipi_csi2.flags;
		rk_asd->lanes = vep->bus.mipi_csi2.num_data_lanes;
	} else if (vep->bus_type == V4L2_MBUS_CCP2) {
		rk_asd->lanes = vep->bus.mipi_csi1.data_lane;
	} else {
		rk_asd->mbus.flags = bus->flags;
	}
```

## 17.3 `v4l2_async_notifier_register`
把 notifier 注册给 `cif_dev->v4l2_dev`，后续当 sensor subdev 注册时，会触发 `.bound` / `.complete` 回调。

---

# 18. notifier 的 `.bound` / `.complete` 后做了什么

## 18.1 `.bound`
源码：

```1539:1562:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int subdev_notifier_bound(struct v4l2_async_notifier *notifier,
				 struct v4l2_subdev *subdev,
				 struct v4l2_async_subdev *asd)
{
	struct rkcif_device *cif_dev = container_of(notifier,
					struct rkcif_device, notifier);
	...
	cif_dev->sensors[cif_dev->num_sensors].lanes = s_asd->lanes;
	cif_dev->sensors[cif_dev->num_sensors].mbus = s_asd->mbus;
	cif_dev->sensors[cif_dev->num_sensors].sd = subdev;
	++cif_dev->num_sensors;
	...
	return 0;
}
```

作用就是：  
把异步绑定到的 sensor subdev，记录到 `cif_dev->sensors[]` 数组里。

也就是说前面 parse endpoint 得到的是“预期会来哪些 sensor”，  
这里是真正把“实际到场的 sensor”登记到 `cif_dev` 中。

## 18.2 `.complete`
在 `subdev_notifier_complete()` 里，核心工作包括：

- 读取 sensor 的 mbus config
- 如果是 LVDS/BT656 等，注册对应辅助 subdev
- 调用 `rkcif_create_links(dev)` 建 media links
- `v4l2_device_register_subdev_nodes(&dev->v4l2_dev)`
- `_set_pipeline_default_fmt(dev)`
- 完成 `cmpl_ntf`

源码中这一段最关键：

```1494:1512:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
	ret = rkcif_create_links(dev);
	if (ret < 0)
		goto unregister_lvds;

	ret = v4l2_device_register_subdev_nodes(&dev->v4l2_dev);
	if (ret < 0)
		goto unregister_lvds;

	ret = _set_pipeline_default_fmt(dev);
	if (ret < 0)
		goto unregister_lvds;

	if (!completion_done(&dev->cmpl_ntf))
		complete(&dev->cmpl_ntf);
	v4l2_info(&dev->v4l2_dev, "Async subdev notifier completed\n");
```

### 这说明什么？
前面 `probe` 只是“把框架搭起来”，  
而 notifier complete 才是真正把：

- sensor
- cif stream
- 各 subdev
- media links
- 默认格式

串成完整 pipeline。

---

# 19. `rkcif_register_luma_vdev`：注册亮度统计节点

你列出来了这一项，这是对的，但要注意它**不是所有芯片都有**。

在 `rkcif_plat_init` 里：

```2015:2019:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
	if (cif_dev->chip_id == CHIP_RV1126_CIF ||
	    cif_dev->chip_id == CHIP_RV1126_CIF_LITE ||
	    cif_dev->chip_id == CHIP_RK3568_CIF)
		rkcif_register_luma_vdev(&cif_dev->luma_vdev, v4l2_dev, cif_dev);
```

## 19.1 它不是普通视频节点
从 `cif-luma.c` 看，它注册的是：

- `V4L2_CAP_META_CAPTURE`

不是普通图像帧采集，而是元数据采集节点。

```437:459:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-luma.c
	vdev->ioctl_ops = &rkcif_luma_ioctl;
	vdev->fops = &rkcif_luma_fops;
	...
	vdev->device_caps = V4L2_CAP_META_CAPTURE | V4L2_CAP_STREAMING;
	...
	rkcif_luma_init_vb2_queue(vdev->queue, luma_vdev);
	rkcif_init_luma_vdev(luma_vdev);
```

## 19.2 它采的是什么
是亮度统计信息。  
驱动会从硬件寄存器 `CIF_REG_Y_STAT_*` 读取每个 RAW 通道的 luma mean，然后通过 meta buffer 上送给用户态。

比如启动时：

```390:421:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/cif-luma.c
void rkcif_start_luma(struct rkcif_luma_vdev *luma_vdev, const struct cif_input_fmt *cif_fmt_in)
{
	...
	rkcif_write_register(luma_vdev->cifdev, CIF_REG_Y_STAT_CONTROL,
			     SW_Y_STAT_BAYER_TYPE(bayer) | SW_Y_STAT_EN);
	luma_vdev->enable = true;
}
```

**所以 luma 节点本质上是一个统计信息输出口，不是图像帧口。**

---

# 20. `rkcif_get_reserved_mem`：获取 thunderboot 预留内存

源码：

```2109:2133:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static int rkcif_get_reserved_mem(struct rkcif_device *cif_dev)
{
	...
	np = of_parse_phandle(dev->of_node, "memory-region-thunderboot", 0);
	if (!np) {
		dev_info(dev, "No memory-region-thunderboot specified\n");
		return 0;
	}
	...
	cif_dev->resmem_pa = r.start;
	cif_dev->resmem_size = resource_size(&r);
	cif_dev->is_thunderboot = true;
	...
}
```

## 20.1 干了什么
查设备树中的：

- `memory-region-thunderboot`

如果有，就取出预留内存的物理地址和大小，保存到：

- `cif_dev->resmem_pa`
- `cif_dev->resmem_size`

并置：

- `cif_dev->is_thunderboot = true`

## 20.2 用途
这是典型的快速启动 / thunderboot 场景用的保留内存，目的通常是：

- 开机早期复用已经准备好的采集/显示相关内存
- 降低重新分配的开销
- 加快 camera pipeline ready 时间

所以这一步不是 video node 创建必要条件，而是平台优化路径。

---

# 21. `rkcif_proc_init`：创建 `/proc/rkcif-xxx` 调试入口

源码：

```302:315:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/procfs.c
int rkcif_proc_init(struct rkcif_device *dev)
{
	dev->proc_dir = proc_create_data(dev_name(dev->dev), 0444,
					 NULL, &rkcif_proc_fops,
					 dev);
	if (!dev->proc_dir) {
		dev_err(dev->dev, "create proc/%s failed!\n",
			dev_name(dev->dev));
		return -ENODEV;
	}

	return 0;
}
```

## 21.1 创建结果
会创建：

- `/proc/<dev_name>`

你举的例子 `/proc/rkcif-mipi-lvds2` 是对的。

## 21.2 显示什么内容
读这个 proc 节点时，会调用：

- `rkcif_show_mixed_info`
- `rkcif_show_clks`
- `rkcif_show_format`

也就是显示：

- 驱动版本
- work mode
- monitor mode
- 时钟频率
- 输入 sensor 信息
- 输出格式、crop
- readout 时间
- fps
- irq 统计
- buffer 计数
- dma enable 状态

比如 `proc_show`：

```274:286:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/procfs.c
static int rkcif_proc_show(struct seq_file *f, void *v)
{
	struct rkcif_device *dev = f->private;

	if (dev) {
		rkcif_show_mixed_info(dev, f);
		rkcif_show_clks(dev, f);
		rkcif_show_format(dev, f);
	} else {
		seq_puts(f, "dev null\n");
	}

	return 0;
}
```

**所以 `/proc` 节点不是控制接口，而是“运行状态快照窗口”。**

---

# 22. `rkcif_init_reset_monitor`：初始化异常监控/自动复位机制

源码：

```1837:1863:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
static void rkcif_init_reset_monitor(struct rkcif_device *dev)
{
	struct rkcif_timer *timer = &dev->reset_watchdog_timer;

#if defined(CONFIG_ROCKCHIP_CIF_USE_MONITOR)
	timer->monitor_mode = CONFIG_ROCKCHIP_CIF_MONITOR_MODE;
	timer->err_time_interval = CONFIG_ROCKCHIP_CIF_MONITOR_KEEP_TIME;
	timer->frm_num_of_monitor_cycle = CONFIG_ROCKCHIP_CIF_MONITOR_CYCLE;
	timer->triggered_frame_num =  CONFIG_ROCKCHIP_CIF_MONITOR_START_FRAME;
	timer->csi2_err_ref_cnt = CONFIG_ROCKCHIP_CIF_MONITOR_ERR_CNT;
...
#else
	timer->monitor_mode = RKCIF_MONITOR_MODE_IDLE;
...
#endif
	...
	timer_setup(&timer->timer, rkcif_reset_watchdog_timer_handler, 0);

	INIT_WORK(&dev->reset_work.work, rkcif_reset_work);
}
```

## 22.1 它做的事情
初始化一个 reset watchdog 体系，包括：

- monitor mode
- 错误检测时间窗口
- 错误计数阈值
- 定时器
- reset workqueue

## 22.2 它的作用
在采集过程中，如果出现：

- CSI2 错误持续增长
- 帧中断异常
- buffer 长时间不更新
- 某些死锁/卡死状态

就可以触发 reset/恢复逻辑。

所以这一步是**稳定性保障机制**，不是节点注册逻辑的一部分。

---

# 23. 你这条流程里容易忽略的两个关键点

---

## 23.1 `rkcif_plat_init` 末尾会把 `cif_dev` 放入全局链表

```2021:2024:/home/alientek/RK3568/rk356x-linux/kernel/drivers/media/platform/rockchip/cif/dev.c
	mutex_lock(&rkcif_dev_mutex);
	list_add_tail(&cif_dev->list, &rkcif_device_list);
	mutex_unlock(&rkcif_dev_mutex);
```

这意味着系统里所有 CIF 设备实例都会挂到全局链表中，后面比如：

- `clr_unready_dev`
- 异步接口补注册
- 统一遍历处理

都靠这条链表。

---

## 23.2 `probe` 完成时，不代表 sensor 已经 ready

这点非常重要。

`rkcif_plat_probe()` 返回成功，只说明：

- `cif_dev` 软件实例建好了
- `/dev/videoX` 节点可能已经有了
- media device 注册好了
- notifier 也挂上了

但真正的 sensor 绑定、media links 建立、默认格式设置，要等 notifier `.complete`。

所以如果从时序看：

### probe 完成后
CIF 自己 ready 了

### sensor subdev 注册完成后
pipeline 才 fully ready

这也是为什么驱动里有：

- `completion`
- `notifier_isp_thread`
- `subdev_asyn_register_itf`

这些异步衔接逻辑。

---

# 24. 结合源码，按你给的调用链做一版“逐步解释”

下面我直接按你原来的层级，给一版更偏“源码语义”的解释：

---

## `rkcif_plat_drv`
这是 platform driver 描述符，匹配 `rockchip,rkcif-dvp` / `rockchip,rkcif-mipi-lvds`，probe 时进入 `rkcif_plat_probe()`。

---

## `-> rkcif_plat_probe`

### 1）`sysfs_create_group`
给 platform 设备创建一组 sysfs 属性节点，用于运行时调试和控制，包括：

- `wait_line`
- `compact_test`
- `is_use_dummybuf`
- `is_high_align`
- `fps`
- `scale_chx_blc`
- `rdbk_debug`

本质是给驱动增加调试/调参入口。

### 2）`rkcif_attach_hw`
从设备树 `rockchip,hw` phandle 找到底层 `rkcif_hw`，建立：

- `cif_dev->hw_dev = hw`
- `hw->cif_dev[hw->dev_num] = cif_dev`

也就是把“逻辑 CIF 设备”和“底层共享硬件块”绑定起来。

### 3）`rkcif_parse_dts`
读取设备树 `wait-line` 属性，保存到 `cif_dev->wait_line`。后续 CSI line interrupt 配置时会用它写硬件寄存器。

### 4）`rkcif_plat_init`
这是核心初始化：

- 初始化锁、计数器、pipeline 回调
- 设置中断处理函数
- 初始化 stream / scale / tools 软件对象
- 注册 `v4l2_device`
- 注册 `media_device`
- 注册各 video 节点
- 启动 async notifier，等待 sensor 绑定
- 某些芯片上再注册 luma metadata 节点

---

## `-> rkcif_stream_init`
初始化每个主采集通道的 `rkcif_stream` 软件对象。  
它承载：

- 当前采集格式
- buffer 状态
- DMA 状态
- frame 计数
- 与 channel / tools / scale 的关联

注意这一步只是“对象初始化”，不是 `/dev/videoX` 注册。

---

## `-> rkcif_init_scale_vdev`
初始化每个 scale 通道的软件对象，绑定对应 stream，设置默认格式/分辨率、buffer 链表、锁、等待队列等。

---

## `-> rkcif_init_tools_vdev`
初始化每个 tools 通道的软件对象，绑定 stream，准备 tools 回读/辅助输出的数据结构和 workqueue。

---

## `-> v4l2_device_register`
把 `cif_dev->v4l2_dev` 注册到 V4L2 core，使它成为可管理的 V4L2 根设备。后面 video device 和 subdev 都挂在它下面。

---

## `-> media_device_init`
初始化 `media_device` 结构。

## `-> media_device_register`
把 CIF 这套实体注册进 Media Controller 框架，后面可形成完整 media graph。

---

## `-> rkcif_register_platform_subdevs`

### `-> rkcif_register_stream_vdevs`
根据芯片和接口类型，注册 1 个或 4 个主采集 video 节点。

#### `-> rkcif_register_stream_vdev`
逐个创建 stream video 设备：

- `rkcif_init_vb2_queue`：初始化 vb2 队列
- `video_register_device`：生成 `/dev/videoX`
- `media_entity_pads_init`：初始化 media pad

这是主抓图节点。

---

### `-> rkcif_register_scale_vdevs`
在支持 scale 的芯片上，注册 4 个 scale 节点。

#### `-> rkcif_register_scale_vdev`
逐个创建 scale video 设备：

- `rkcif_scale_init_vb2_queue`
- `media_entity_pads_init`
- `video_register_device`

操作函数集是：

- `rkcif_scale_fops`
- `rkcif_scale_ioctl`

这些节点对应硬件 scale channel。

---

### `-> rkcif_register_tools_vdevs`
注册 3 个 tools 节点。

#### `-> rkcif_register_tools_vdev`
逐个创建 tools video 设备：

- `rkcif_tools_init_vb2_queue`
- `media_entity_pads_init`
- `video_register_device`

操作函数集是：

- `rkcif_tools_fops`
- `rkcif_tools_ioctl`

这些节点属于辅助/回读/工具输出通道。

---

### `-> cif_subdev_notifier`

#### `-> v4l2_async_notifier_init`
初始化异步 notifier。

#### `-> v4l2_async_notifier_parse_fwnode_endpoints`
解析当前 CIF 节点下 `port/endpoint`，提取：

- 总线类型
- lanes
- mbus flags

为未来要绑定的 sensor subdev 建立匹配项。

#### `-> v4l2_async_notifier_register`
注册 notifier。  
后续 sensor subdev 注册时触发 `.bound` / `.complete`：

- `.bound`：把 sensor 填进 `cif_dev->sensors[]`
- `.complete`：创建 media links、注册 subdev nodes、设置默认 pipeline format

---

## `-> rkcif_register_luma_vdev`
仅在部分芯片上注册 luma metadata 节点。  
这个不是图像帧节点，而是 `V4L2_CAP_META_CAPTURE` 元数据节点，用来导出亮度统计信息。

---

## `-> rkcif_get_reserved_mem`
解析 `memory-region-thunderboot`，拿到预留物理内存范围，供 thunderboot/快速启动场景使用。

---

## `-> rkcif_proc_init`
创建 `/proc/rkcif-xxx` 调试节点，用于查看：

- 输入/输出格式
- fps
- irq 统计
- clk
- readout 时间
- buffer 统计

---

## `-> rkcif_init_reset_monitor`
初始化 reset watchdog 和 error monitor，用于采集中检测 CSI 错误、卡死、buffer 不更新等异常，并触发恢复动作。

---

# 25. 一句话总结这整个 probe 到底“干了什么”

如果只用一句话概括：

**`rkcif_plat_probe()` 做的事情，就是把设备树里一个 Rockchip CIF 节点，实例化成一个完整的 V4L2/Media 采集设备：前端挂接到底层硬件，内部建立 stream/scale/tools/luma 软件对象，向内核注册 `/dev/videoX` 和 media graph，向外等待 sensor 异步接入，最终形成可工作的采集 pipeline。**

---

# 26. 再给你一个更偏“架构视角”的理解

你可以把这套驱动分成 4 层看：

### 第 1 层：底层共享硬件层
- `rkcif_hw`
- 寄存器、时钟、中断、DMA 能力

### 第 2 层：平台实例层
- `rkcif_device`
- 一个 CIF 逻辑设备实例
- 负责 V4L2/Media 注册、notifier、proc、sysfs、monitor

### 第 3 层：功能通道层
- `rkcif_stream[]`
- `rkcif_scale_vdev[]`
- `rkcif_tools_vdev[]`
- `rkcif_luma_vdev`

### 第 4 层：外部异步实体层
- sensor subdev
- lvds/dvp 辅助 subdev
- media links

这样你再看 probe，就很清楚：

- `attach_hw`：接第 1 层
- `plat_init`：建第 2/3 层
- `notifier`：接第 4 层

---

如果你愿意，我下一步可以继续帮你把这条链路再往后接一层，详细分析：

1. **sensor 绑定完成后，`subdev_notifier_complete()` 怎么创建 media link**
2. **用户态 `open("/dev/videoX") + STREAMON` 之后，具体如何一路走到 `rkcif_csi_channel_set()` 和寄存器配置**
3. **`wait_line`、`dummybuf`、`compact`、`high_align` 这些参数最终分别影响哪些寄存器和 DMA 行为**

如果你要，我可以继续按“**probe 完成后 -> open -> set_fmt -> reqbufs -> streamon -> irq 收帧**”这条完整数据流往下讲。

