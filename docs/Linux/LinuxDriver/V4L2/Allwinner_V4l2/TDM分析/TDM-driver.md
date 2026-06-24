# 全志VIN框架下的vin-tdm驱动分析
_Exported on 2026/4/14 at GMT+8 21:39:37 from Cursor (2.6.21)_

---

**User**

帮我基于全志VIN框架详细分析一下lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm
这个驱动程序

---

**Cursor**

下面我基于全志 `sunxi-vin` 框架，对 `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm` 这个驱动做一次“框架位置 + 文件拆解 + 数据流 + 关键函数 + 中断/异常 + V100/V200差异”的详细分析。

---

# 1. 先说结论：`vin-tdm` 在 VIN 框架里是干什么的

`vin-tdm` 本质上是 **VIN 硬件中的 TDM（Time Division Multiplexing / 多路时分复用）子模块驱动**。  
它的职责不是直接接 sensor，也不是最终输出 `/dev/videoX`，而是作为 **V4L2 subdev** 挂在 VIN media pipeline 中，位于 CSI/ISP/后级视频节点之间，完成：

1. **RAW 数据的时分复用接收与发送**
2. **多路 RX 通道管理**
3. **WDR（2帧/3帧 DOL）场景下多通道拆分/协同**
4. **在线/离线两种工作模式切换**
5. **buffer 分配、DMA 地址下发**
6. **TDM 异常检测和 reset 恢复**
7. 某些配置下支持 **LBC 压缩**、**pkg 打包**、**offline raw handle**

你可以把它理解成 VIN 里的一个“**多路 RAW 中转与调度器**”。

---

# 2. 在整个 VIN 框架中的位置

从 `vin.h` 可以看到，VIN 顶层设备 `vin_md` 把各个子模块统一组织起来，其中就包含了 TDM：

```64:79:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.h
struct vin_tdm_rx_info{
	struct v4l2_subdev *sd;
	int id;
};

struct vin_tdm_info {
	struct vin_tdm_rx_info tdm_rx[TDM_RX_NUM];
	int id;
};
```

并且 `vin.h` 直接包含了 `vin-tdm/vin_tdm.h`：

```17:24:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.h
#include "vin-video/vin_video.h"
#include "vin-video/vin_core.h"
#include "vin-csi/sunxi_csi.h"
#include "vin-isp/sunxi_isp.h"
#include "vin-vipp/sunxi_scaler.h"
#include "vin-mipi/sunxi_mipi.h"
#include "vin-tdm/vin_tdm.h"
#include "platform/platform_cfg.h"
```

这说明 `vin-tdm` 和 `CSI / MIPI / ISP / VIPP / VIN core` 一样，是 VIN 框架的标准子模块之一。

---

# 3. `vin-tdm` 目录结构解读

目录很清晰：

- `vin_tdm.c`  
  核心驱动，实现 platform driver、subdev、stream on/off、中断、buffer 管理、reset 恢复等。
- `vin_tdm.h`  
  驱动内部核心结构体定义。
- `tdm100/tdm_reg.[ch]`  
  第一代 TDM 硬件寄存器封装。
- `tdm200/tdm200_reg.[ch]`  
  第二代 TDM 硬件寄存器封装，能力更强。

目录结构：

```1:8:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.h
#ifdef TDM_V200
#include "tdm200/tdm200_reg.h"
#else
#include "tdm100/tdm_reg.h"
#endif
#include "../vin-video/vin_core.h"
```

也就是说：

- 编译时定义 `TDM_V200` → 使用 `tdm200`
- 否则走 `tdm100`

---

# 4. 两代硬件差异：V100 vs V200

这是理解这个驱动最关键的一点。

## 4.1 TDM100
`tdm100/tdm_reg.h` 里定义：

```22:24:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/tdm100/tdm_reg.h
#define TDM_RX_NUM   2
```

特点：
- 只有 2 个 RX 通道
- 功能相对简单
- 主要是基本的 RX/TX、DMA buffer、异常中断
- 代码路径更短

## 4.2 TDM200
`tdm200/tdm200_reg.h` 里定义：

```24:24:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/tdm200/tdm200_reg.h
#define TDM_RX_NUM   4
```

并引入更多模式：

```26:39:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/tdm200/tdm200_reg.h
enum  tx_chn_cfg_mode {
	TX_NONE = 0x0,
	CH0_1,
	CH2_3,
	CH0_1_AND_CH2_3,
	CH0_1_2,
	CH0_1_2_3,
};

enum  rx_chn_cfg_mode {
	LINEARx4 = 0x0,
	WDR_2F_AND_LINEARx2,
	WDR_2Fx2,
	WDR_3F_AND_LINEAR,
};
```

还支持：
- `online/offline` 工作模式
- `speed down`
- `LBC`
- `pkg`
- 多路 WDR 组合
- 更复杂的 TX/RX FIFO 和状态检测

所以你在分析时可以把 `vin_tdm.c` 视为：
- 一个上层公共逻辑
- 内部按 `#ifdef TDM_V200` 分裂成两套能力模型  
其中 **V200 才是当前更核心、更复杂的实现**。

---

# 5. 核心数据结构分析

---

## 5.1 `struct tdm_buffer`
表示一个 TDM 使用的缓冲区：

```34:48:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.h
struct tdm_buffer {
	void *virt_addr;
	void *dma_addr;
	u32 buf_size;
	u8 empty;

	struct dma_buf *dmabuf;
	void *user_viraddr;
	struct list_head list;
	enum tdmstat_buf_state_t state;
	u8 id;
};
```

作用：
- `virt_addr`：CPU 虚拟地址
- `dma_addr`：给硬件 DMA 的地址
- `dmabuf`：离线 raw 处理时可能导出共享
- `state`：buffer 生命周期状态

状态机：

```28:32:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.h
enum tdmstat_buf_state_t {
	TDMSTAT_IDLE = 0,
	TDMSTAT_RX_SET,
	TDMSTAT_NPU_SET,
	TDMSTAT_TX_SET,
};
```

大概语义：
- `IDLE`：空闲
- `RX_SET`：TDM RX 填好了，等待上层/NPU处理
- `NPU_SET`：上层已取走/处理中
- `TX_SET`：处理完成，重新回到发送/可复用流程

---

## 5.2 `struct tdm_rx_dev`
代表一个 TDM RX 通道，对应一个 V4L2 subdev 实体：

```87:117:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.h
struct tdm_rx_dev {
	unsigned char id;
	struct v4l2_subdev subdev;
	struct media_pad tdm_pads[TDM_PAD_NUM];
	struct mutex subdev_lock;
	struct tdm_format *tdm_fmt;
	struct v4l2_mbus_framefmt format;
	u32 stream_cnt;
	u32 width;
	u32 height;
	u32 sensor_fps;
	u32 max_delay_line;
	u32 buffer_loop_cnt;
	u32 isp_clk;
	u32 event_type;
	u32 vts;
	char large_image;
#ifdef TDM_V200
	bool streaming;
	struct rx_work_status ws;
	struct tdm_rx_lbc lbc;
	struct list_head *list;

	void (*tdm_buffer_done_callback)(struct vin_isp_tdm_event_status *status);
#endif
	/* Buffer */
	u32 buf_size;
	u8 buf_cnt;
	u8 set_buf_cnt;
	struct vin_mm ion_man[TDM_BUFS_NUM];
	struct tdm_buffer buf[TDM_BUFS_NUM];
};
```

它是最关键的 per-channel 对象，包含：

### 基础身份
- `id`
- `subdev`
- `pads`

### 格式信息
- `tdm_fmt`
- `format`

### 运行态
- `stream_cnt`
- `width/height`
- `sensor_fps`
- `isp_clk`
- `vts`
- `large_image`

### V200 扩展
- `streaming`
- `ws`：rx 工作状态
- `lbc`：LBC 压缩参数
- `list`：挂到当前工作链表里

### 缓冲区资源
- `buf_size`
- `buf_cnt`
- `ion_man[]`
- `buf[]`

---

## 5.3 `struct tdm_dev`
代表一个完整的 TDM 硬件实例：

```123:153:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.h
struct tdm_dev {
	void __iomem *base;
	unsigned char id;
	int irq;
	char is_empty;
	struct platform_device *pdev;
	spinlock_t slock;

	struct tdm_rx_dev tdm_rx[TDM_RX_NUM];
	bool tdm_rx_buf_en[TDM_RX_NUM];
	bool tdm_rx_reset[TDM_RX_NUM];

	/* Control */
	bool configured;
	enum tdm_state_t state;
	u32 stream_cnt;
	u32 delay_init;
#ifdef TDM_V200
	struct tdm_work_status ws;
	struct tdm_tx_cfg tx_cfg;
	struct list_head working_chn_fmt;
	struct work_struct tdm_reset_task;
	bool tdm_task_resetting_flag;
	u32 work_mode;
	u32 bitmap_chn_use;
	u32 rx_stream_cnt[TDM_RX_NUM];
	u32 tx_frame_cnt;
	u32 nup_frame_cnt[TDM_RX_NUM];
	struct list_head rx_active[TDM_RX_NUM];
	struct list_head rx_done[TDM_RX_NUM];
	bool not_npu_mode[TDM_RX_NUM];
#endif
};
```

这说明 `tdm_dev` 是：
- 一个物理 TDM 控制器
- 包含多个 `tdm_rx_dev`
- 统一管理 base/irq/stream 状态
- V200 下增加多通道调度、reset workqueue、buffer list、带宽控制等

---

# 6. 驱动入口：platform driver 层

`vin_tdm.c` 最后注册为一个 platform driver：

```3020:3029:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static struct platform_driver tdm_platform_driver = {
	.probe = tdm_probe,
	.remove = tdm_remove,
	.driver = {
		.name = TDM_MODULE_NAME,
		.owner = THIS_MODULE,
		.of_match_table = sunxi_tdm_match,
	}
};
```

设备树匹配：

```3015:3018:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static const struct of_device_id sunxi_tdm_match[] = {
	{.compatible = "allwinner,sunxi-tdm",},
	{},
};
```

所以 TDM 是通过 DTS 节点 `compatible = "allwinner,sunxi-tdm"` 挂载进来的。

---

# 7. `tdm_probe()` 做了什么

`tdm_probe()` 是硬件实例初始化核心。

关键流程：

## 7.1 分配 `tdm_dev`
```2912:2923:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
tdm = kzalloc(sizeof(struct tdm_dev), GFP_KERNEL);
...
of_property_read_u32(np, "device_id", &pdev->id);
...
tdm->id = pdev->id;
tdm->pdev = pdev;
tdm->stream_cnt = 0;
```

## 7.2 V200 读取工作模式
```2925:2931:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
tdm->work_mode = 0xff;
of_property_read_u32(np, "work_mode", &tdm->work_mode);
tdm->work_mode = clamp_t(unsigned int, tdm->work_mode, TDM_ONLINE, TDM_OFFLINE);
INIT_LIST_HEAD(&tdm->working_chn_fmt);
INIT_WORK(&tdm->tdm_reset_task, __sunxi_tdm_reset_v2_handle);
```

说明设备树里可以指定 TDM 在线/离线模式。

## 7.3 映射寄存器和 IRQ
```2932:2958:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
tdm->base = of_iomap(np, 0);
...
tdm->irq = irq_of_parse_and_map(np, 0);
...
ret = request_irq(tdm->irq, tdm_isr, IRQF_SHARED, tdm->pdev->name, tdm);
```

## 7.4 建立寄存器基址映射
```2963:2963:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
csic_tdm_set_base_addr(tdm->id, (unsigned long)tdm->base);
```

## 7.5 初始化每个 RX 子设备
```2965:2973:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
for (i = 0; i < TDM_RX_NUM; i++) {
	tdm->tdm_rx[i].id = i;
	ret = __tdm_init_subdev(&tdm->tdm_rx[i]);
	...
	tdm->tdm_rx[i].stream_cnt = 0;
	tdm->tdm_rx_buf_en[i] = 0;
}
```

## 7.6 保存全局句柄
```2976:2977:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
platform_set_drvdata(pdev, tdm);
glb_tdm[tdm->id] = tdm;
```

---

# 8. subdev 层：为什么说 TDM 不是 video 节点，而是一个 pipeline 节点

每个 `tdm_rx` 都被初始化成一个 `v4l2_subdev`：

```1679:1701:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static int __tdm_init_subdev(struct tdm_rx_dev *tdm_rx)
{
	struct v4l2_subdev *sd = &tdm_rx->subdev;
	...
	v4l2_subdev_init(sd, &sunxi_tdm_subdev_ops);
	sd->grp_id = VIN_GRP_ID_TDM_RX;
	sd->flags |= V4L2_SUBDEV_FL_HAS_EVENTS | V4L2_SUBDEV_FL_HAS_DEVNODE;
	snprintf(sd->name, sizeof(sd->name), "sunxi_tdm_rx.%u", tdm_rx->id);
	v4l2_set_subdevdata(sd, tdm_rx);

	tdm_rx->tdm_pads[TDM_PAD_SINK].flags = MEDIA_PAD_FL_SINK;
	tdm_rx->tdm_pads[TDM_PAD_SOURCE].flags = MEDIA_PAD_FL_SOURCE;
	sd->entity.function = MEDIA_ENT_F_IO_V4L;

	ret = media_entity_pads_init(&sd->entity, TDM_PAD_NUM, tdm_rx->tdm_pads);
	...
}
```

这意味着：
- 每个 RX 通道在 media graph 中都是一个实体
- 有 `sink/source` pad
- 可参与 format 传播、stream 控制、事件机制

subdev ops：

```1664:1677:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static const struct v4l2_subdev_video_ops sunxi_tdm_subdev_video_ops = {
	.s_stream = sunxi_tdm_subdev_s_stream,
	.s_parm = sunxi_tdm_subdev_s_parm,
};

static const struct v4l2_subdev_pad_ops sunxi_tdm_subdev_pad_ops = {
	.get_fmt = sunxi_tdm_subdev_get_fmt,
	.set_fmt = sunxi_tdm_subdev_set_fmt,
};
```

所以这个驱动最核心的上层接口就是：
- `set_fmt/get_fmt`
- `s_stream`
- `s_parm`
- 某些配置下 `ioctl/event`

---

# 9. format 管理：支持哪些 RAW 输入

`sunxi_tdm_formats[]` 说明它支持 Bayer RAW 8/10/12bit：

```33:92:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static struct tdm_format sunxi_tdm_formats[] = {
	{ .code = MEDIA_BUS_FMT_SBGGR8_1X8,  .input_type = INPUTTPYE_8BIT,  .input_bit_width = RAW_8BIT,  .raw_fmt = BAYER_BGGR, },
	{ .code = MEDIA_BUS_FMT_SGBRG8_1X8,  .input_type = INPUTTPYE_8BIT,  .input_bit_width = RAW_8BIT,  .raw_fmt = BAYER_GBRG, },
	...
	{ .code = MEDIA_BUS_FMT_SRGGB12_1X12, .input_type = INPUTTPYE_12BIT, .input_bit_width = RAW_12BIT, .raw_fmt = BAYER_RGGB, }
};
```

TDM 只关心原始 Bayer 排列和 bit-width，不管 YUV/RGB 输出格式。  
它更像是 RAW 中间处理硬件，而不是最终像素输出设备。

---

# 10. `set_fmt/get_fmt` 的逻辑

## 10.1 `__tdm_try_format()`
根据 mbus code 匹配内部支持格式：

```1424:1438:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static struct tdm_format *__tdm_try_format(struct v4l2_mbus_framefmt *mf)
{
	struct tdm_format *tdm_fmt = NULL;
	int i;

	for (i = 0; i < ARRAY_SIZE(sunxi_tdm_formats); i++)
		if (mf->code == sunxi_tdm_formats[i].code)
			tdm_fmt = &sunxi_tdm_formats[i];

	if (tdm_fmt == NULL)
		tdm_fmt = &sunxi_tdm_formats[0];

	mf->code = tdm_fmt->code;
	return tdm_fmt;
}
```

## 10.2 `sunxi_tdm_subdev_set_fmt()`
- 写入当前 `tdm_rx->format`
- 保存 `tdm_rx->tdm_fmt`
- V200 下如果是 WDR 模式，还会把格式复制给配套通道

```1456:1483:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
if (fmt->which == V4L2_SUBDEV_FORMAT_ACTIVE) {
	tdm_rx->tdm_fmt = tdm_fmt;
#ifdef TDM_V200
	res = (void *)mf->reserved;
	tdm_rx->ws.wdr_mode = res->res_wdr_mode;
	if (res->res_wdr_mode == ISP_DOL_WDR_MODE) {
		if (tdm_rx->id == 0)
			glb_tdm[tdm->id]->tdm_rx[1].tdm_fmt = tdm_fmt;
		else if (tdm_rx->id == 2)
			glb_tdm[tdm->id]->tdm_rx[3].tdm_fmt = tdm_fmt;
	} else if (res->res_wdr_mode == ISP_3FDOL_WDR_MODE) {
		if (tdm_rx->id == 0) {
			glb_tdm[tdm->id]->tdm_rx[1].tdm_fmt = tdm_fmt;
			glb_tdm[tdm->id]->tdm_rx[2].tdm_fmt = tdm_fmt;
		}
	}
#endif
}
```

这说明 TDM 的 WDR 设计是：
- 一个主 rx 配置会隐式带动若干附属 rx 通道

---

# 11. `s_stream`：整个驱动的控制核心

`sunxi_tdm_subdev_s_stream()` 是整个驱动的主控制入口。

---

## 11.1 先过滤 RAW 输出场景
如果 `res_pix_fmt` 本身就是 RAW，则直接返回，不走 TDM：

```1063:1079:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
switch (res->res_pix_fmt) {
case V4L2_PIX_FMT_SBGGR8:
...
case V4L2_PIX_FMT_SRGGB12:
	vin_log(VIN_LOG_FMT, "%s output fmt is raw, return directly\n", __func__);
	return 0;
default:
	break;
}
```

说明 TDM 更偏向服务于“RAW 被进一步搬运/重整”的场景，而不是简单 RAW pass-through。

---

## 11.2 V200 的 stream on：先做模式判定

### 1）记录 WDR 模式
```1082:1083:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
tdm_rx->ws.wdr_mode = res->res_wdr_mode;
```

### 2）检查该通道是否允许工作
```1084:1092:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
if (tdm_check_wdr_mode(tdm_rx)) {
	tdm_rx->streaming = false;
	return 0;
}
...
if (tdm_cal_rx_chn_cfg_mode(tdm_rx, &tdm->ws.rx_chn_mode)) {
	vin_err("tdm%d get rx chn fail\n", tdm->id);
	tdm_rx->streaming = false;
	return 0;
}
```

这两个函数非常关键：

- `tdm_check_wdr_mode()`：检查当前 RX 与已有 RX 的兼容关系
- `tdm_cal_rx_chn_cfg_mode()`：推导硬件应设置成哪种 RX 通道组合模式

---

# 12. WDR 通道管理是怎么做的

这是 `vin-tdm` 的核心价值之一。

## 12.1 通道占用位图
V200 用 `bitmap_chn_use` 管理通道占用：

```325:344:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static int set_chn_use(struct tdm_dev *tdm, unsigned int bits)
{
	return tdm->bitmap_chn_use |= bits;
}

static void clr_chn_use(struct tdm_dev *tdm, unsigned int bits)
{
	tdm->bitmap_chn_use &= ~bits;
}

static int get_chn_can_use(struct tdm_dev *tdm, unsigned int bits)
{
	return tdm->bitmap_chn_use & bits & 0xf;
}
```

## 12.2 WDR 兼容性检查
例如：
- online 模式下只允许更严格的组合
- 2帧 WDR 只能落在 `rx0/rx1` 或 `rx2/rx3`
- 3帧 WDR 只能从 `rx0` 开始占 `rx0/rx1/rx2`

相关逻辑在 `tdm_check_wdr_mode()` 里。

## 12.3 保存当前工作通道格式
```433:445:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static void tdm_save_wdr_mode(struct tdm_rx_dev *tdm_rx, struct rx_chn_fmt *chn_fmt)
{
	...
	list_add_tail(&chn_fmt->list, &tdm->working_chn_fmt);
	if (tdm_rx->ws.wdr_mode == ISP_DOL_WDR_MODE)
		ret = set_chn_use(tdm, 0x3 << ((tdm_rx->id / 2) * 2));
	else if (tdm_rx->ws.wdr_mode == ISP_3FDOL_WDR_MODE)
		ret = set_chn_use(tdm, 0x7 << (tdm_rx->id / 3));
	else
		ret = set_chn_use(tdm, 0x1 << tdm_rx->id);
}
```

这说明：
- 普通模式占 1 个通道
- 2帧 WDR 占 2 个通道
- 3帧 WDR 占 3 个通道

## 12.4 计算硬件的 RX 组合模式
`tdm_cal_rx_chn_cfg_mode()` 最终会得到：

- `LINEARx4`
- `WDR_2F_AND_LINEARx2`
- `WDR_2Fx2`
- `WDR_3F_AND_LINEAR`

这些值直接写入硬件全局配置寄存器。

---

# 13. stream on 时不同模式的行为

在 `sunxi_tdm_subdev_s_stream()` 中，V200 的分支非常有代表性。

---

## 13.1 3帧 WDR
```1100:1129:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
if (tdm_rx->ws.wdr_mode == ISP_3FDOL_WDR_MODE) {
	tdm->ws.tdm_en = 1;
	tdm->tx_cfg.data_depth = 512/3;
	tdm->tx_cfg.head_depth = 32/3;
	tdm_rx->ws.tx_func_en = 1;
	tdm_rx->ws.pkg_en = 1;
	...
	tdm_rx1 = &tdm->tdm_rx[1];
	tdm_rx2 = &tdm->tdm_rx[2];
	tdm_rx_cpy(tdm_rx, tdm_rx1);
	tdm_rx_cpy(tdm_rx, tdm_rx2);
	...
}
```

即：
- 一个主配置扩展成 `rx0/rx1/rx2`
- TX/RX FIFO 深度按 3 路均分
- 附属 rx 通道复制主通道格式和尺寸

---

## 13.2 2帧 WDR
```1130:1163:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
} else if (tdm_rx->ws.wdr_mode == ISP_DOL_WDR_MODE) {
	tdm->ws.tdm_en = 1;
	tdm->tx_cfg.data_depth = 512/2;
	tdm->tx_cfg.head_depth = 32/2;
	tdm_rx->ws.tx_func_en = 1;
	if (tdm_rx->id == 0) {
		tdm_rx->ws.pkg_en = 0;
		tdm_rx->ws.lbc_en = 1;
		...
		tdm_rx1 = &tdm->tdm_rx[1];
		tdm_rx_cpy(tdm_rx, tdm_rx1);
	} else if (tdm_rx->id == 2) {
		tdm_rx->ws.pkg_en = 1;
		tdm_rx->ws.lbc_en = 0;
		...
		tdm_rx3 = &tdm->tdm_rx[3];
		tdm_rx_cpy(tdm_rx, tdm_rx3);
	}
}
```

典型特点：
- 2帧 WDR 使用两路 RX
- `rx0` 作为 2F WDR 时，会启用 LBC
- `rx2` 作为 2F WDR 时则更偏向 pkg

---

## 13.3 normal 模式
```1164:1198:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
} else {
	...
	if (tdm->work_mode == TDM_OFFLINE) {
		tdm->ws.tdm_en = 1;
		tdm->tx_cfg.data_depth = 512;
		tdm->tx_cfg.head_depth = 32;
		tdm_rx->ws.tx_func_en = 1;
		if (tdm_rx->id == 0) {
#ifdef CONFIG_TDM_OFFLINE_HANDLE_RAW
			tdm_rx->ws.pkg_en = 1;
			tdm_rx->ws.lbc_en = 0;
#else
			tdm_rx->ws.pkg_en = 0;
			tdm_rx->ws.lbc_en = 1;
#endif
			tdm_rx->ws.sync_en = 0;
		} else {
			tdm_rx->ws.pkg_en = 1;
			tdm_rx->ws.lbc_en = 0;
			tdm_rx->ws.sync_en = 0;
		}
	} else {
		...
		tdm_rx->ws.tx_func_en = 0;
		tdm_rx->ws.pkg_en = 0;
		tdm_rx->ws.lbc_en = 0;
		tdm_rx->ws.sync_en = 0;
		if (!tdm->ws.speed_dn_en)
			return 0;
	}
}
```

可见：
- **offline 模式** 下更积极使用 TDM 的 TX/RX/压缩/打包能力
- **online 模式** 下如果不开 `speed_dn`，很多 normal 场景实际上直接不需要 TDM 工作

---

# 14. 顶层 stream 控制：`sunxi_tdm_top_s_stream()`

这个函数控制整个 TDM 控制器层面的开关，而不是单个 RX。

关键逻辑：

```826:903:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
if (enable) {
	csic_tdm_top_enable(tdm->id);
	if (tdm->ws.tdm_en)
		csic_tdm_enable(tdm->id);
	...
	csic_tdm_set_rx_chn_cfg_mode(tdm->id, tdm->ws.rx_chn_mode);
	csic_tdm_set_tx_chn_cfg_mode(tdm->id, tdm->ws.tx_chn_mode);
	csic_tdm_set_work_mode(tdm->id, tdm->work_mode);
	csic_tdm_set_speed_dn(tdm->id, tdm->ws.speed_dn_en);
	...
	tdm_set_tx_blank(tdm);
	csic_tdm_set_tx_t1_cycle(...);
	csic_tdm_set_tx_fifo_depth(...);
	csic_tdm_set_tx_t2_cycle(...);
	...
	csic_tdm_int_clear_status(tdm->id, TDM_INT_ALL);
	csic_tdm_int_enable(tdm->id, ini_en);
}
```

它主要干：
1. 使能 top / core
2. 写入工作模式
3. 配置 TX blank
4. 配置 TX FIFO / 时序参数
5. 使能中断

这个函数只在“第一个流打开/最后一个流关闭”时起作用，避免重复 init/deinit。

---

# 15. RX 配置：`tdm_set_rx_cfg()`

这是单个 RX 通道最核心的硬件配置函数。

---

## 15.1 配输入属性
```496:504:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
csic_tdm_rx_set_min_ddr_size(tdm->id, tdm_rx->id, DDRSIZE_512b);
csic_tdm_rx_input_bit(tdm->id, tdm_rx->id, tdm_rx->tdm_fmt->input_type);
csic_tdm_rx_input_fmt(tdm->id, tdm_rx->id, tdm_rx->tdm_fmt->raw_fmt);
csic_tdm_rx_input_size(tdm->id, tdm_rx->id, tdm_rx->format.width, tdm_rx->format.height);
```

## 15.2 配 FIFO 深度
根据：
- online / offline
- 用户是否显式设置 depth
- 通道编号
- 是否均分 FIFO

做不同设置。

## 15.3 配功能位：pkg / lbc / sync
```536:565:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
if (tdm_rx->ws.pkg_en) {
	csic_tdm_rx_pkg_enable(...);
	...
} else if (tdm_rx->ws.lbc_en) {
	csic_tdm_rx_lbc_enable(...);
	tdm_rx_lbc_cal_para(tdm_rx);
	...
	csic_tdm_lbc_cfg(...);
	...
} else if (tdm_rx->ws.sync_en) {
	csic_tdm_rx_sync_enable(...);
}
```

说明 RX 通道可以工作在：
- 打包模式
- LBC 压缩模式
- sync 模式

---

# 16. buffer 分配机制

---

## 16.1 buffer 分配函数
普通分配：

```94:141:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static int tdm_rx_bufs_alloc(struct tdm_rx_dev *tdm_rx, u32 size, u32 count)
```

循环映射分配（V200 + online WDR delay line 优化）：

```179:219:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static int tdm_rx_bufs_loop_alloc(struct tdm_rx_dev *tdm_rx, u32 size, u32 count, u32 loop_cnt)
```

## 16.2 分配的 buffer 数量怎么决定
`tdm_set_rx_cfg()` 中根据模式决定：
- online 且 pkg/lbc：通常 1 个
- offline：2~16 个，取决于 fps / 配置项
- 特定编译配置可强制单 buffer

## 16.3 大小怎么计算
### pkg 模式
```625:630:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
size = ALIGN(tdm_rx->width * tdm_rx->tdm_fmt->input_bit_width, 512) * tdm_rx->height / 8 + ALIGN(tdm_rx->height, 64);
```

### lbc 模式
基于 `rx_pkg_line_words`、height、line header 等计算。

### online + DOL WDR
如果设置了 `max_delay_line`，会走 loop alloc，减少内存压力。

---

# 17. LBC 参数计算

V200 的一个重要扩展是 LBC 压缩。

`tdm_rx_lbc_cal_para()` 用输入位宽、宽度和压缩比推导压缩参数：

```224:286:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static void tdm_rx_lbc_cal_para(struct tdm_rx_dev *tdm_rx)
{
	...
	if (TDM_LBC_RATIO != 1024 && tdm_rx->tdm_fmt->input_bit_width == RAW_10BIT)
		lbc->cmp_ratio = 342;
	else
		lbc->cmp_ratio = clamp(TDM_LBC_RATIO, 256, 1024);
	...
	lbc->mb_num = clamp((int)DIV_ROUND_UP(tdm_rx->format.width, mb_len), 3, 88);
	...
	lbc->line_tar_bits = ...
	lbc->line_max_bit = ...
	lbc->mb_min_bit = ...
}
```

这部分实际上是在为硬件 LBC 单元准备：
- 压缩率
- QP 初值
- macro block 个数
- 行目标 bit 数
- 行最大 bit 数等

之后写入寄存器：

```563:563:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
csic_tdm_lbc_cfg(tdm->id, tdm_rx->id, &tdm_rx->lbc);
```

---

# 18. speed down 带宽控制

V200 中还有一个很有意思的机制：**TDM TX 速率控制**。

`tdm_set_rx_data_rate()` 的作用是根据：
- 各路流的 width/height/fps
- vblank
- isp_clk

反推出 TX 的 `valid_num / invalid_num`，也就是传输占空比：

```916:1038:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
tdm->tx_cfg.valid_num = ...
tdm->tx_cfg.invalid_num = 255 - tdm->tx_cfg.valid_num;
csic_tdm_set_tx_data_rate(tdm->id, tdm->tx_cfg.valid_num, tdm->tx_cfg.invalid_num);
```

寄存器层对应：

```293:299:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/tdm200/tdm200_reg.c
void csic_tdm_set_tx_data_rate(unsigned int sel, unsigned int valid_num, unsigned int invalid_num)
{
	unsigned int num;
	num = ((valid_num & 0xff) << TDM_TX_VALID_NUM) + ((invalid_num & 0xff) << TDM_TX_INVALID_NUM);
	vin_reg_writel(csic_tdm_base[sel] + TMD_TX_OFFSET + TDM_TX_DATA_RATE_REG_OFF, num);
}
```

本质是：
- 给 TX 插入“无效周期”
- 控制吞吐，匹配 ISP 带宽
- 避免 FIFO over/underflow

---

# 19. 中断处理：`tdm_isr()`

这是另一个最核心部分。

入口：

```2538:2538:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static irqreturn_t tdm_isr(int irq, void *priv)
```

它首先读取 TDM 汇总中断状态：

```2554:2555:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
memset(&status, 0, sizeof(struct tdm_int_status));
csic_tdm_int_get_status(tdm->id, &status);
```

---

## 19.1 异常类中断
包括：

- `rx_frm_lost`
- `rx_frm_err`
- `rx_btype_err`
- `rx_buf_full`
- `rx_hb_short`
- `rx_fifo_full`
- `tx_fifo_under`
- `tdm_lbc_err`
- `tdm_lbc_fifo_full`

出错后通常流程是：
1. 清中断
2. 读取 internal status，定位 RX0/RX1/RX2/RX3
3. 打 log
4. 标记 `tdm_rx_reset[]`
5. 调 reset 恢复

例如帧丢失：

```2560:2588:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
if (status.rx_frm_lost) {
	csic_tdm_int_clear_status(tdm->id, RX_FRM_LOST_INT_EN);
	...
	tdm_rx_set_reset(tdm, 0/1/2/3);
	...
	__sunxi_tdm_reset(tdm);
}
```

---

## 19.2 帧完成类中断
V200 有：
- `RX0_FRM_DONE`
- `RX1_FRM_DONE`
- `RX2_FRM_DONE`
- `RX3_FRM_DONE`
- `TX_FRM_DONE`

这不仅用于统计，也用于 offline raw handle buffer 状态流转。

例如 `RX0_FRM_DONE`：

```2736:2763:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
if (status.rx0_frm_done) {
	csic_tdm_int_clear_status(tdm->id, RX0_FRM_DONE_INT_EN);
	...
#ifdef CONFIG_TDM_OFFLINE_HANDLE_RAW
	buf = list_entry(tdm->rx_active[0].next, struct tdm_buffer, list);
	buf->state = TDMSTAT_RX_SET;
	list_move_tail(&buf->list, &tdm->rx_done[0]);
	...
	isp_tdm_queue_event(&tdm->tdm_rx[0], buf);
#endif
}
```

含义：
- 某个 active buffer 被硬件 RX 填满
- 状态改为 `RX_SET`
- 移到 `rx_done`
- 通知上层去处理

而 `TX_FRM_DONE`：

```2788:2825:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
if (status.tx_frm_done) {
	csic_tdm_int_clear_status(tdm->id, TX_FRM_DONE_INT_EN);
	tdm->tx_frame_cnt++;
	...
	buf = list_entry(tdm->rx_done[0].next, struct tdm_buffer, list);
	buf->state = TDMSTAT_TX_SET;
	list_move_tail(&buf->list, &tdm->rx_active[0]);
	...
}
```

即：
- 已处理好的 buffer 回到 active 队列
- 构成循环队列

---

# 20. reset 恢复机制

`vin-tdm` 的恢复逻辑相当重，因为 TDM 在异常后要重新带起一整条媒体链路。

---

## 20.1 简单 reset
`__sunxi_tdm_reset()`  
V100 和部分 V200 场景都可能直接走这个函数。

它会做：
1. 停 parser/csi
2. 停 tdm rx/tx/top
3. 停 isp/vipp/dma/lbc
4. 清状态
5. 重新按顺序 enable

也就是说它不是只 reset TDM，而是 reset 一整段 capture pipeline。

---

## 20.2 V200 workqueue reset
更完整的 V200 恢复在：

```2065:2065:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static void __sunxi_tdm_reset_v2_handle(struct work_struct *work)
```

特点：
- 在 workqueue 中做，不在中断上下文里完成大动作
- 遍历所有 `vin_core`
- 查找使用了该 `tdm_rx` 的 video 节点
- 依次关闭：
  - parser capture
  - isp bridge
  - tdm rx
  - isp
  - dma/lbc
  - vipp
- 然后重新 enable

这是一个典型的“**从 media pipeline 视角做故障恢复**”的实现。

---

# 21. offline raw handle 特殊支持

如果定义了 `CONFIG_TDM_OFFLINE_HANDLE_RAW`，驱动会多出一套“事件 + ioctl + buffer 流转”的逻辑。

关键接口：

```1624:1642:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static long sunxi_tdm_subdev_ioctl(struct v4l2_subdev *sd, unsigned int cmd, void *arg)
{
	switch (cmd) {
	case VIDIOC_VIN_TDM_MAP:
		...
	case VIDIOC_VIN_TDM_DQBUF:
		...
	case VIDIOC_VIN_TDM_REQ_DATA:
		...
	}
}
```

## 21.1 `VIDIOC_VIN_TDM_DQBUF`
让上层/NPU取走某个 TDM buffer，状态从 `RX_SET -> NPU_SET`

## 21.2 `VIDIOC_VIN_TDM_REQ_DATA`
把 buffer 拷贝到用户空间

## 21.3 事件通知
`isp_tdm_queue_event()` 会向 subdev devnode 发 `V4L2_EVENT_VIN_TDM`：

```1644:1661:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
event.type = tdm_rx->event_type;
v4l2_event_queue(vdev, &event);
```

所以这个场景下，TDM 不只是 pipeline 的透明节点，还能主动把原始 buffer 交给上层离线处理模块。

---

# 22. 寄存器封装层怎么看

`tdm100/tdm_reg.c` 和 `tdm200/tdm200_reg.c` 是典型的“寄存器访问抽象层”。

特点：
- 不做策略
- 只做 bitfield 写入/读取
- 上层 `vin_tdm.c` 负责时序和状态控制

例如 V200 的全局模式配置：

```97:110:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/tdm200/tdm200_reg.c
void csic_tdm_set_rx_chn_cfg_mode(unsigned int sel, enum  rx_chn_cfg_mode mode)
{
	vin_reg_clr_set(csic_tdm_base[sel] + TDM_GOLBAL_CFG0_REG_OFF,
			RX_CHN_CFG_MODE_MASK, mode << RX_CHN_CFG_MODE);
}

void csic_tdm_set_tx_chn_cfg_mode(unsigned int sel, enum  tx_chn_cfg_mode mode)
{
	vin_reg_clr_set(csic_tdm_base[sel] + TDM_GOLBAL_CFG0_REG_OFF,
			TX_CHN_CFG_MODE_MASK, mode << TX_CHN_CFG_MODE);
}
```

RX 配置：

```465:484:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/tdm200/tdm200_reg.c
void csic_tdm_rx_input_fmt(unsigned int sel, unsigned int ch, enum tdm_input_fmt fmt)
{
	vin_reg_clr_set(..., TDM_RX_INPUT_FMT_MASK, fmt << TDM_RX_INPUT_FMT);
}

void csic_tdm_rx_input_bit(unsigned int sel, unsigned int ch, enum input_image_type_sel input_tpye)
{
	vin_reg_clr_set(..., TDM_INPUT_BIT_MASK, input_tpye << TDM_INPUT_BIT);
}
```

LBC 配置：

```549:568:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/tdm200/tdm200_reg.c
void csic_tdm_lbc_cfg(unsigned int sel, unsigned int ch, struct tdm_rx_lbc *lbc)
{
	vin_reg_clr_set(..., IS_LOSSY_MASK, lbc->is_lossy << IS_LOSSY);
	...
	vin_reg_clr_set(..., LINE_TAR_BIT_MASK, lbc->line_tar_bits << LINE_TAR_BIT);
	vin_reg_clr_set(..., LINE_MAX_BIT_MASK, lbc->line_max_bit << LINE_MAX_BIT);
}
```

所以分析 bug 时，一般是：
- 先看 `vin_tdm.c` 是否给了正确策略
- 再看 reg 层是否正确落寄存器

---

# 23. 这个驱动的典型数据流

我给你按 V200 离线模式画一个逻辑流：

## 23.1 初始化
- `tdm_probe()`
- 建立 `tdm_dev`
- 建立多个 `tdm_rx_dev`
- request irq

## 23.2 pipeline 组装后设置格式
- `set_fmt()`
- 决定 Bayer 格式、bit 宽、WDR 模式

## 23.3 stream on
- `s_stream(enable=1)`
- 检查 WDR 合法性
- 计算 `rx_chn_mode`
- 决定是否附带 `rx1/rx2/rx3`
- `sunxi_tdm_top_s_stream()`
- `tdm_set_rx_data_rate()`
- `tdm_set_rx_cfg()`
- 写 buffer 地址
- `csic_tdm_rx_enable/cap_enable`

## 23.4 运行中
- TDM RX 收到数据
- 写入 buffer
- 产生 `RXx_FRM_DONE`
- 若开启 offline raw handle，则发 event 给上层
- 上层通过 ioctl 或 callback 取走 buffer
- TDM TX 完成后 buffer 重新入 active 队列

## 23.5 异常
- ISR 检测 FIFO full / frame err / hb short / lbc err / tx under
- 标记需要 reset 的 rx
- 执行 reset work

## 23.6 stream off
- disable rx/rx_cap
- 关闭 top/tx/int
- 回收 buffer
- 从 working_chn_fmt 删除占用信息

---

# 24. 这个驱动的设计特点

---

## 24.1 强烈依赖全志整套 VIN 管线
你会看到很多跨模块调用：
- `csic_prs_*`
- `bsp_isp_*`
- `vipp_*`
- `csic_dma_*`
- `csic_isp_bridge_*`

这说明 TDM 不是孤立模块，而是深深嵌在 Allwinner VIN 全链路里。

---

## 24.2 V4L2 subdev 外表，平台耦合内核
对上层它是标准 media subdev；  
对底层它又大量调用 SoC 专用接口，所以可移植性并不高。

---

## 24.3 重点服务多曝光/WDR
从代码量和逻辑复杂度看，TDM 最大的应用场景就是：
- 2F DOL WDR
- 3F DOL WDR
- 多通道 RAW 编排
- 带宽整形

---

## 24.4 reset 逻辑非常“重”
这类驱动不是简单清某个寄存器，而是直接重启一段硬件链路。  
这往往意味着：
- 硬件容错不足
- 驱动作者更倾向于全链路重启保活

---

# 25. 如果你要读这个驱动，建议按什么顺序看

建议顺序如下：

## 第一层：先看结构
1. `vin_tdm.h`
2. `tdm200/tdm200_reg.h`

目的是搞清：
- 有哪些对象
- TDM_RX_NUM 是多少
- 支持哪些模式

## 第二层：看主流程
1. `tdm_probe()`
2. `__tdm_init_subdev()`
3. `sunxi_tdm_subdev_set_fmt()`
4. `sunxi_tdm_subdev_s_stream()`
5. `sunxi_tdm_top_s_stream()`
6. `tdm_set_rx_cfg()`

这几步能把“怎么启动”的问题看明白。

## 第三层：看异常恢复
1. `tdm_isr()`
2. `tdm_rx_set_reset()`
3. `__sunxi_tdm_reset()`
4. `__sunxi_tdm_reset_v2_handle()`

这几步能把“为什么会重启、怎么重启”看明白。

## 第四层：看高级特性
1. `tdm_set_rx_data_rate()`
2. `tdm_rx_lbc_cal_para()`
3. offline raw handle 的 ioctl / event 逻辑

---

# 26. 一句话概括每个核心函数

- `tdm_probe()`：创建一个 TDM 控制器实例
- `__tdm_init_subdev()`：把每个 RX 通道注册成 V4L2 subdev
- `sunxi_tdm_subdev_set_fmt()`：设置 RAW Bayer/bit-width/WDR 格式
- `sunxi_tdm_subdev_s_stream()`：按模式启动/停止某个 RX 通道
- `sunxi_tdm_top_s_stream()`：启动/停止整个 TDM 硬件顶层
- `tdm_set_rx_cfg()`：下发 RX 通道详细硬件配置和 buffer
- `tdm_set_rx_data_rate()`：根据带宽计算 TX 占空比
- `tdm_rx_lbc_cal_para()`：计算 LBC 压缩参数
- `tdm_isr()`：处理中断、异常和 buffer 事件
- `__sunxi_tdm_reset_v2_handle()`：在 workqueue 中做全链路恢复

---

# 27. 如果从“驱动角色”角度总结

我会把 `vin-tdm` 定义成：

> **一个处于 Allwinner VIN 中间层的 RAW 多路调度/时分复用驱动，负责在 V4L2 media pipeline 中完成多 RX 通道组织、WDR 帧协同、带宽整形、buffer 管理和异常恢复。**

它不是：
- sensor 驱动
- csi 接收驱动
- isp 算法驱动
- video 输出驱动

而是这几者之间的 **硬件中介层**。

---

如果你愿意，我下一步可以继续帮你做两件事中的任意一个：

1. **画出 `vin-tdm` 在全志 VIN 框架里的完整数据通路图**  
   （从 sensor → CSI → TDM → ISP/VIPP → video）
2. **逐函数精读 `vin_tdm.c`**  
   我可以按函数顺序一段一段给你讲，适合你后面自己改驱动。

