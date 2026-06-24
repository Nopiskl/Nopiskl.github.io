
---

**User**

请你继续根据现有源码+之前分析，跟进解答一下
1、ISP模块如何协调TDM进行分时复用的？(具体可以讲一下时间片划分，csi端的数据如何传递到TDM，TDM如何分时间片发送给ISP端？)
2、每段时间内VIN/ISP驱动如何处理使物理ISP处理虚拟ISP收到的数据？

---

**Cursor**

可以，继续往下追后，结合 `vin.c`、`vin_tdm.c`、`sunxi_isp.c`，现在基本能把 **V853 offline 分时复用** 的主线讲清楚了。

我先给一个总判断：

---

## 先说核心结论

### 结论1：TDM 不是“软件每隔 N us 手动切一次”的调度器，而是**硬件时分复用发送器**
在 offline 模式下，驱动做的不是：

- 软件定时器轮询
- 每 1ms/2ms 强行切换一路

而是：

- 把多路 `tdm_rx` 配置进 TDM
- 设置 TDM 的 `rx channel mode / tx channel mode / work mode`
- 根据所有路的分辨率、fps、vts、ISP 时钟，计算一个 `valid_num / invalid_num`
- 让 TDM 用这个速率把不同 `rx channel` 的 RAW **按硬件时分方式串行送给 ISP**

所以“时间片”本质不是软件概念上的固定时钟中断切片，而是：
> **由 TDM 的发送节拍、blank、speed-down 比例、rx_chn_mode 共同定义的一段段硬件发送窗口。**

---

### 结论2：CSI 到 TDM 不是“先 CSI DMA 落 DDR，再 CPU 搬给 TDM”
这条链路里，**CPU 不搬运 RAW**。  
驱动配置的是 VIN 顶层/Parser/TDM/ISP 的硬件路径，数据由硬件模块流动。

在 offline + TDM 场景里，流程更接近：

- Sensor/MIPI/CSI Parser 接收 RAW
- Parser 侧开始采集
- TDM `rxN` 接收对应 RAW，并写入自己的 buffer/LBC buffer
- TDM `tx` 再按分时规则把这些 `rxN` 的数据送往 ISP
- ISP 在对应 virtual input/context 上处理
- 最后输出到 VIPP

也就是：
> **Parser 负责把输入 RAW 收进来，TDM 负责缓存/整形/分时发送，ISP 负责在不同 virtual context 上消费。**

---

### 结论3：物理 ISP 之所以能处理“虚拟 ISP 收到的数据”，靠的是两层机制同时成立
1. **前端数据层面**：TDM 把不同路 RAW 分时送到 ISP 的不同 virtual input  
2. **参数层面**：每个虚拟 ISP 节点有各自独立的 `load/save/stat` 上下文，ISP 在 `PARA_LOAD_PD` / `FINISH_PD` 这样的帧边界点加载当前上下文

所以实际上是：

> **TDM 决定“当前哪一路 RAW 进来”**  
> **ISP 参数装载机制决定“当前用哪一路 ISP 配置去处理它”**

---

下面按你的两个问题展开。

---

# 1、ISP 模块如何协调 TDM 进行分时复用？

---

## 1.1 VIN 打开 pipeline 时，先把“路由关系”建好

VIN 在 `set_stream` 里会先把：

- CSI/Parser -> ISP
- ISP -> VIPP

的拓扑路由设置好。

关键代码：

```1018:1046:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
#if defined (CONFIG_ARCH_SUN8IW21P1)
		if (vinc->large_image == 3) {
			/* parserx ch0--isp0 ch0, parserx ch1-- isp1 ch0 */
			if (vinc->isp_sel == 0)
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, 0);
			else if (vinc->isp_sel == 1)
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, 1);
			else
				vin_warn("large image mode not support isp%d\n", vinc->isp_sel);
		} else {
			if ((vinc->csi_ch != 0xff) && (vinc->csi_ch & 0x10))
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, vinc->csi_ch & 0xf);
			else {
				for (i = 0; i < vinc->total_rx_ch; i++)
					csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + i, vinc->csi_sel, i);
			}
		}
		csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
#endif
```

这段的意义是：

- `csic_isp_input_select()`：把 **parser/csi channel** 接到某个 **物理 ISP 的某个 virtual input**
- `csic_vipp_input_select()`：把 ISP 输出接到对应 VIPP

所以，VIN 在流开始前已经确定了：
- 数据未来要送到哪个 physical ISP
- 在 physical ISP 内部占用哪个 virtual input/context 槽位

---

## 1.2 TDM stream on 时，先决定“当前 TDM 要工作成什么复用模式”

TDM 真正启动是在 `sunxi_tdm_subdev_s_stream()` 中完成的。

```1075:1158:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static int sunxi_tdm_subdev_s_stream(struct v4l2_subdev *sd, int enable)
{
	...
	if (enable) {
#ifdef TDM_V200
		tdm_rx->ws.wdr_mode = res->res_wdr_mode;
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
		...
		if (tdm_rx->ws.wdr_mode == ISP_3FDOL_WDR_MODE) {
			...
			tdm->tx_cfg.data_depth = 512/3;
			tdm->tx_cfg.head_depth = 32/3;
			...
		} else if (tdm_rx->ws.wdr_mode == ISP_DOL_WDR_MODE) {
			...
			tdm->tx_cfg.data_depth = 512/2;
			tdm->tx_cfg.head_depth = 32/2;
			...
		} else {
			...
			tdm->tx_cfg.data_depth = 512;
			tdm->tx_cfg.head_depth = 32;
			...
		}
```

这里先做三件事：

### A. 检查当前 TDM 是否允许这路加入
`tdm_check_wdr_mode()` 会判断：
- 当前有没有其他 `rx` 已经占用
- WDR 模式是否跟已有配置冲突
- 哪些 `rx` 能组合工作

### B. 计算 `rx_chn_mode`
也就是当前 TDM 硬件应该按什么复用形态工作，比如：
- `LINEARx4`
- `WDR_2Fx2`
- `WDR_2F_AND_LINEARx2`
- `WDR_3F_AND_LINEAR`

这个函数非常关键：

```715:783:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static int tdm_cal_rx_chn_cfg_mode(struct tdm_rx_dev *tdm_rx, enum rx_chn_cfg_mode *mode)
{
	...
	if (tdm->work_mode == TDM_OFFLINE) {
		switch (wdr_mode) {
		case ISP_3FDOL_WDR_MODE:
			...
				*mode = WDR_3F_AND_LINEAR;
			...
		case ISP_DOL_WDR_MODE:
			...
					*mode = WDR_2F_AND_LINEARx2;
			} else if (tdm_rx->ws.wdr_mode == ISP_DOL_WDR_MODE)
				*mode = WDR_2Fx2;
			...
		default:
			if (tdm_rx->ws.wdr_mode == ISP_NORMAL_MODE)
				*mode = LINEARx4;
			...
		}
	}
	...
}
```

也就是说，**时间片的大框架首先由 `rx_chn_mode` 定义**。  
例如：
- `LINEARx4`：4 路普通 RAW 轮流发
- `WDR_2Fx2`：两组 2F WDR 轮流发
- `WDR_3F_AND_LINEAR`：一组 3F WDR + 一路 linear

---

### C. 为不同路设置 tx_func/pkg/lbc/sync
不同 `rx` 通道是不是参与 TDM 向 ISP 发送、是打包发送还是 LBC 压缩发送，都在这里决定。

例如 normal/offline 模式：

```1158:1238:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
		} else {
			vin_log(VIN_LOG_FMT, "rx%d wdr mode is normal\n", tdm_rx->id);
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
			} ...
		}

		/*reg int*/
		sunxi_tdm_top_s_stream(tdm_rx, enable);
		tdm_set_rx_data_rate(tdm_rx, enable);
		tdm->tdm_rx_reset[tdm_rx->id] = 0;
		tdm_set_rx_cfg(tdm_rx, 1);
		csic_tdm_rx_enable(tdm->id, tdm_rx->id);
		csic_tdm_rx_cap_enable(tdm->id, tdm_rx->id);
```

---

## 1.3 “时间片划分”到底在哪里体现？

这是你最关心的点。

### 先说结论：
源码里**没有看到一个“固定 4 等分时间片表”**；  
看到的是一个**基于 ISP 带宽预算的速率控制模型**。

核心就在 `tdm_set_rx_data_rate()`：

```911:1004:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static void tdm_set_rx_data_rate(struct tdm_rx_dev *tdm_rx, unsigned int en)
{
	...
	if (tdm->work_mode == TDM_ONLINE || !tdm->ws.speed_dn_en)
		return;
	...
	for (i = 0; i < TDM_RX_NUM; i++) {
		...
		wh_fps += (width[i] * height[i] * fps[i]);
		hh_fps += (TDM_TX_HBLANK_OFFLINE * height[i] * fps[i]);
		vw_fps += (TDM_TX_VBLANK * width[i] * fps[i]);
		vh_fps += (TDM_TX_HBLANK_OFFLINE * TDM_TX_VBLANK * fps[i]);
	}
	...
	tdm->tx_cfg.valid_num = ...
	...
	if (tdm->tx_cfg.valid_num)
		tdm->tx_cfg.invalid_num = 255 - tdm->tx_cfg.valid_num;
	else
		tdm->tx_cfg.invalid_num = 0;
	csic_tdm_set_tx_data_rate(tdm->id, tdm->tx_cfg.valid_num, tdm->tx_cfg.invalid_num);
```

### 这段实际上在做什么？
它把所有已启用 `rx channel` 的：

- 分辨率 `width/height`
- 帧率 `fps`
- blank 开销
- 传感器 `vts`
- ISP 可用时钟 `isp_clk`

合起来，算出一个 TDM TX 发送节拍：

- `valid_num`
- `invalid_num`

这就是 TDM 的“占空比式时间片”。

### 换句话说：
TDM 不是“第1路 250us、第2路 250us……”这种软件切片；
而是：

- 在 TX 时钟流上
- 用 `valid_num / invalid_num`
- 再结合 `hblank / vblank / rx channel mode`
- 把不同路 RAW 交错送给 ISP

所以更准确地说：
> **时间片是硬件发送窗口，不是软件 timer slice。**

---

## 1.4 TDM top stream on 时，还会设置 blank / fifo / 中断 / speed-down

`sunxi_tdm_top_s_stream()` 是 TDM 顶层真正启动的地方：

```815:907:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static int sunxi_tdm_top_s_stream(struct tdm_rx_dev *rx, int enable)
{
	...
	if (enable) {
		csic_tdm_top_enable(tdm->id);
		if (tdm->ws.tdm_en)
			csic_tdm_enable(tdm->id);
		...
		csic_tdm_set_rx_chn_cfg_mode(tdm->id, tdm->ws.rx_chn_mode);
		csic_tdm_set_tx_chn_cfg_mode(tdm->id, tdm->ws.tx_chn_mode);
		csic_tdm_set_work_mode(tdm->id, tdm->work_mode);
		csic_tdm_set_speed_dn(tdm->id, tdm->ws.speed_dn_en);

		tdm_set_tx_blank(tdm);
		csic_tdm_set_tx_t1_cycle(tdm->id, tdm->tx_cfg.t1_cycle = 0x40);
		...
		if (tdm->ws.speed_dn_en) {
			csic_tdm_set_tx_data_rate(tdm->id, tdm->tx_cfg.valid_num, tdm->tx_cfg.invalid_num);
		}
		csic_tdm_tx_enable(tdm->id);
		...
		csic_tdm_int_enable(tdm->id, ini_en);
```

这意味着 TDM 发射“时间片”的真正构成由这些参数共同决定：

- `rx_chn_mode`
- `tx_chn_mode`
- `work_mode`
- `speed_dn_en`
- `valid_num/invalid_num`
- `hblank/vblank`
- fifo depth

其中：

### `tdm_set_tx_blank()`：
```259:266:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static void tdm_set_tx_blank(struct tdm_dev *tdm)
{
	csic_tdm_omode(tdm->id, 1);
	if (tdm->work_mode == TDM_OFFLINE)
		csic_tdm_set_hblank(tdm->id, TDM_TX_HBLANK_OFFLINE);
	else
		csic_tdm_set_hblank(tdm->id, TDM_TX_HBLANK);
	csic_tdm_set_bblank_fe(tdm->id, TDM_TX_VBLANK/2);
	csic_tdm_set_bblank_be(tdm->id, TDM_TX_VBLANK/2);
}
```

说明 offline 模式下：
- TDM 专门使用 `TDM_TX_HBLANK_OFFLINE`
- 也就是发送时每帧/每段之间留出更适配 ISP 分时消费的 blank 区间

这也是“时间片边界”的硬件基础之一。

---

## 1.5 CSI 端的数据如何传递到 TDM？

从驱动调用顺序看，**CSI Parser 与 TDM 都是同时打开的硬件模块**，数据不是软件搬过去的。

看 ISP 启动时的操作：

```1610:1648:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
			if (flags) {
				bsp_isp_set_para_ready(isp->id, PARA_READY);
				bsp_isp_capture_start(isp->id);
				isp->isp_frame_number = 0;

				csic_isp_bridge_enable(0);

#if defined SUPPORT_ISP_TDM
				if (isp->wdr_mode == ISP_DOL_WDR_MODE || isp->wdr_mode == ISP_3FDOL_WDR_MODE) {
					csic_tdm_rx_enable(vinc->tdm_rx_sel/TDM_RX_NUM, vinc->tdm_rx_sel);
					csic_tdm_rx_cap_enable(vinc->tdm_rx_sel/TDM_RX_NUM, vinc->tdm_rx_sel);
					csic_tdm_rx_enable(vinc->tdm_rx_sel/TDM_RX_NUM, vinc->tdm_rx_sel + 1);
					csic_tdm_rx_cap_enable(vinc->tdm_rx_sel/TDM_RX_NUM, vinc->tdm_rx_sel + 1);
					...
				} else {
					if (vinc->tdm_rx_sel != 0xff) {
						csic_tdm_rx_enable(vinc->tdm_rx_sel/TDM_RX_NUM, vinc->tdm_rx_sel);
						csic_tdm_rx_cap_enable(vinc->tdm_rx_sel/TDM_RX_NUM, vinc->tdm_rx_sel);
					}
				}
#endif
				csic_prs_enable(vinc->csi_sel);
				csi = container_of(vinc->vid_cap.pipe.sd[VIN_IND_CSI], struct csi_dev, subdev);
				csic_prs_capture_start(vinc->csi_sel, csi->bus_info.ch_total_num, &mode);
```

这里顺序很关键：

1. 先 `bsp_isp_capture_start()`
2. 再开 `csic_isp_bridge_enable()`
3. 再开 `tdm_rx_enable()/tdm_rx_cap_enable()`
4. 最后 `csic_prs_enable()`、`csic_prs_capture_start()`

这说明驱动期望的数据通路是：

- Parser 开始吐 RAW
- TDM RX 端已经就绪，可接收
- TDM 再把数据组织成对 ISP 友好的时分流
- ISP bridge/ISP capture 已经就绪，可以消费

所以可以合理地理解为：
> **CSI/Parser 把 RAW 输入送到 TDM RX；TDM RX 存入 buffer 或 LBC buffer；TDM TX 再按复用规则送进 ISP。**

---

## 1.6 TDM 如何“分时间片发送给 ISP”？

这部分最准确的说法是：

### 不是软件逐帧手动切，而是 TDM 硬件按当前 `rx_chn_mode + tx_data_rate + blank` 自动时分发送

驱动里能看到的控制点有三类：

---

### 第一类：选择复用拓扑
`tdm_cal_rx_chn_cfg_mode()` 决定是：

- `LINEARx4`
- `WDR_2Fx2`
- `WDR_2F_AND_LINEARx2`
- `WDR_3F_AND_LINEAR`

这决定“有哪些输入通道参与轮转”。

---

### 第二类：设置各通道发送属性
`sunxi_tdm_subdev_s_stream()` 给各 `rx` 设置：

- `tx_func_en`
- `pkg_en`
- `lbc_en`
- `sync_en`

比如 normal/offline 下，rx0 可能走 LBC，其它路走 pkg。  
这决定“每路数据进入 TDM 后以什么形式进入发送队列”。

---

### 第三类：设置发送节拍
`tdm_set_rx_data_rate()` 算出：

- `valid_num`
- `invalid_num`

然后 `sunxi_tdm_top_s_stream()` 调 `csic_tdm_set_tx_data_rate()` 下发。

这相当于给 TDM TX 一个节拍器：
- valid 段发数据
- invalid 段停/空转
- 配合 hblank/vblank，形成一个 ISP 能吃下的输入流速

所以“分时间片发送”可以理解为：
> TDM 在时钟域里按 duty cycle 和 channel mode 把多个 rx channel 轮流送到 ISP，而不是 CPU 在软件里做显式切换。

---

# 2、每段时间内 VIN/ISP 驱动如何处理，使物理 ISP 处理虚拟 ISP 收到的数据？

这部分要分成：

- **前端：哪一路 RAW 被送进来**
- **后端：ISP 用哪一路上下文处理**

---

## 2.1 VIN 先把“物理 ISP + virtual input”绑定好

还是回到 VIN 路由：

```1018:1046:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
...
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + i, vinc->csi_sel, i);
...
		csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
```

这表示：
- 某一路 `vinc`
- 会绑定到某个 physical ISP
- 再绑定到 physical ISP 下的某个 virtual input

因此，当 TDM 在某个时间窗里发出这一路数据时，ISP 前端已经知道它应该进入哪个 virtual slot。

---

## 2.2 ISP stream on 时，驱动把 TDM RX、Parser、ISP 一起拉起来

刚才那段 `sunxi_isp.c` 启动代码说明：

- 先把 ISP 置为 `PARA_READY`
- 开始 capture
- 开启 bridge
- 开 TDM RX cap
- 开 parser capture

这意味着在一个分时系统里，驱动并不会在每个 slice 来临时再重新 stream on/off ISP。  
而是：

> **整条链路保持工作，靠 TDM 的发送节拍和 ISP 的参数加载点来完成 slice-to-slice 的切换。**

也就是说，stream on 是“大启动”，不是“每片启动”。

---

## 2.3 每个虚拟 ISP 自己保存一套上下文，物理 ISP 在参数加载点装入当前上下文

这是 ISP 侧最关键的处理机制。

在 `PARA_LOAD_PD` 中断里：

```2517:2556:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
	if (bsp_isp_get_irq_status(isp->id, PARA_LOAD_PD)) {
		bsp_isp_clr_irq_status(isp->id, PARA_LOAD_PD);
		...
		bsp_isp_set_para_ready(isp->id, PARA_NOT_READY);
		if (isp->load_flag)
			memcpy(isp->isp_load.vir_addr, &isp->load_shadow[0], ISP_LOAD_DRAM_SIZE);
		isp->isp_ob.set_cnt++;
		load_val = bsp_isp_load_update_flag(isp->id);
		...
		bsp_isp_set_size(isp->id, &isp->isp_ob);
		bsp_isp_update_table(isp->id, (unsigned short)load_val);
		...
		bsp_isp_set_para_ready(isp->id, PARA_READY);
	}
```

这里做了：

1. 把参数 ready 拉低
2. 如有新参数，把 `load_shadow` 拷进 `isp_load`
3. 更新模块表、size、WDR 等
4. 参数 ready 拉高

这本质上就是：
> **在当前时间片/当前帧要处理之前，把属于这个 virtual ISP 的寄存器上下文装进物理 ISP。**

---

## 2.4 `FINISH_PD` 表示当前这次处理结束，驱动在这里推进下一轮同步

在 `FINISH_PD` 里：

```2561:2584:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
	if (bsp_isp_get_irq_status(isp->id, FINISH_PD)) {
		isp->isp_frame_number++;
		bsp_isp_clr_irq_status(isp->id, FINISH_PD);
		...
		if (!isp->f1_after_librun) {
			sunxi_isp_frame_sync_isr(&isp->subdev);
			if (isp->h3a_stat.stat_en_flag)
				isp->f1_after_librun = 1;
		} else {
			if (isp->load_flag || (isp->event_lost_cnt == 10)) {
				sunxi_isp_frame_sync_isr(&isp->subdev);
				isp->event_lost_cnt = 0;
			} else {
				isp->event_lost_cnt++;
			}
		}
		isp->load_flag = 0;
	}
```

这说明每处理完一帧/一轮数据后，驱动会：

- 记 frame number
- 触发 frame sync 事件
- 清掉 `load_flag`

所以在 slice 之间，ISP 侧的推进节拍其实就是：

- `PARA_LOAD_PD`：装下一次处理所需参数
- `FINISH_PD`：当前一次处理结束，同步统计/事件，准备下一次

---

## 2.5 VIN 驱动本身不会“每片切 ISP”，而是维护 virtual pipeline 的路由和 DMA 侧状态

VIN 侧真正持续在跑的是：
- parser/csi
- vipp/dma
- media pipeline stream state

比如 offline DMA ISR 里，会轮询虚拟处理通道：

```1118:1140:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c
#if defined CSIC_DMA_VER_140_000
	if (vinc->work_mode == BK_ONLINE) {
		...
	} else {
		work_mode = BK_OFFLINE;
		for (i = vinc->vir_prosess_ch; i < (vinc->vir_prosess_ch + 4); i++) {
			j = clamp(i >= (vinc->vipp_sel + 4) ? i - 4 : i, vinc->vipp_sel, vinc->vipp_sel + 4);
			csic_dma_int_get_status(j, &status);
			if (!status.mask) {
				vinc->vir_prosess_ch = (j + 1) >= (vinc->vipp_sel + 4) ? j + 1 - 4 : j + 1;
				return IRQ_HANDLED;
			}
			vinc->vir_prosess_ch = (j + 1) >= (vinc->vipp_sel + 4) ? j + 1 - 4 : j + 1;
			vinc = vin_core_gbl[j];
			cap = &vinc->vid_cap;
			...
			break;
		}
	}
#endif
```

这段反映的是：
- VIN/DMA 在 offline 模式下本身也有“虚拟通道轮询”的意识
- 但它处理的是 **后端 DMA/视频节点** 的虚拟通道状态
- 真正把 RAW 轮流喂给 ISP 的，还是 TDM + ISP 硬件链路

所以可以理解为：
- **TDM/ISP 负责前处理分时**
- **VIN/DMA 负责后端虚拟视频节点的接收和完成**

---

## 2.6 你可以把“每段时间内”的处理理解成下面这个顺序

下面我把一段“时间片”抽象成一个处理周期：

---

### 阶段A：VIN/TDM/ISP 整体已 stream on
驱动已经完成：

- `csic_isp_input_select()`
- `csic_vipp_input_select()`
- `tdm rx/tx/work mode` 配置
- ISP `capture_start`
- Parser `capture_start`

---

### 阶段B：某一路 RAW 被 Parser 接收，进入 TDM RX
- Parser 把 RAW 流输入到 TDM RX
- `tdm_set_rx_cfg()` 提前配置好的 buffer/LBC/pkg 规则生效
- 数据进入该 `tdm_rx` 的 DMA buffer 或 LBC buffer

相关配置代码：

```472:590:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static int tdm_set_rx_cfg(struct tdm_rx_dev *tdm_rx, unsigned int en)
{
	...
		csic_tdm_rx_input_bit(tdm->id, tdm_rx->id, tdm_rx->tdm_fmt->input_type);
		csic_tdm_rx_input_fmt(tdm->id, tdm_rx->id, tdm_rx->tdm_fmt->raw_fmt);
		csic_tdm_rx_input_size(tdm->id, tdm_rx->id, tdm_rx->format.width, tdm_rx->format.height);
		...
		if (tdm_rx->ws.pkg_en) {
			csic_tdm_rx_pkg_enable(tdm->id, tdm_rx->id);
			...
		} else if (tdm_rx->ws.lbc_en) {
			...
			csic_tdm_rx_lbc_enable(tdm->id, tdm_rx->id);
			...
		} else if (tdm_rx->ws.sync_en) {
			csic_tdm_rx_sync_enable(tdm->id, tdm_rx->id);
		}
```

---

### 阶段C：TDM TX 轮到这个 channel 的发送窗口
- 根据 `rx_chn_mode`
- 根据 `valid_num/invalid_num`
- 根据 blank/fifo 配置

TDM 把这个 `rx channel` 的数据送到 ISP。

---

### 阶段D：物理 ISP 在 `PARA_LOAD_PD` 把当前 virtual ISP 的参数装进去
- 载入 `isp_load`
- 更新表项
- 设置 size / module enable

然后当前送来的这段 RAW 就按该 virtual ISP 的配置被处理。

---

### 阶段E：ISP 处理结束，`FINISH_PD`
- frame count++
- frame sync
- 统计同步
- 清 `load_flag`

然后等待 TDM 下一次发送窗口，对应下一路或下一帧。

---

# 最后，把你的两个问题压缩成一句最本质的话

---

## 问题1本质答案
**TDM 负责“数据时分复用”，ISP 负责“参数上下文切换”。**

- CSI/Parser 把多路 RAW 收进来
- TDM 把它们按 `rx_chn_mode + valid/invalid + blank` 分时送出
- 这里的“时间片”是硬件发送窗口，不是软件 timer 片

---

## 问题2本质答案
**VIN/ISP 驱动不会每个时间片都重新起停 ISP，而是在整条链保持开启的情况下，通过 ISP 的参数加载中断，把当前 virtual ISP 的配置装载给唯一的 physical ISP。**

所以 physical ISP 在每段时间里能处理对应 virtual ISP 数据，是因为：

1. 这段时间里 TDM 正在送那一路 RAW  
2. 这段时间里 ISP 已经装入那一路的参数上下文

---

如果你愿意，我下一步可以继续给你补两块你大概率还会关心的内容：

1. **把“offline 模式下 4 路 linear RAW”的完整时序图画出来**：  
   `parser -> tdm_rx0/1/2/3 -> tdm_tx -> isp virtual input0/1/2/3 -> vipp`
2. **继续深挖 TDM 中断（尤其 `TX_FRM_DONE / RX0_FRM_DONE`）与 ISP 帧同步之间的对应关系**，把“哪一个中断标志着一个时间片结束”讲得更细。

**User**

你说的还是不明白
TDM是一直接收RAW数据吗？数据是怎么被按找对应的时间片发送给对应虚拟ISP的？时间片是软中断还是其他方式？


---

**Cursor**

你这个问题，我这次只抓最核心的点讲，不绕。

---

# 先直接回答

## 1）TDM 是一直接收 RAW 数据吗？

**是，但要加条件：**

- 不是“系统上电后永远一直收”
- 而是**在对应 `tdm_rx` 被 `enable + cap_enable` 后，它就持续接收这一路 RAW**
- 只要这一路 sensor/csi/parser 还在出数据，TDM RX 就持续吃数据

也就是：

> **stream on 之后，TDM RX 是连续收流的，不是“等到某个时间片来了才开始收”。**

源码里 ISP 启动时，明确把 TDM RX 和 Parser 一起拉起来：

```1618:1641:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
#if defined SUPPORT_ISP_TDM
				if (isp->wdr_mode == ISP_DOL_WDR_MODE || isp->wdr_mode == ISP_3FDOL_WDR_MODE) {
					csic_tdm_rx_enable(vinc->tdm_rx_sel/TDM_RX_NUM, vinc->tdm_rx_sel);
					csic_tdm_rx_cap_enable(vinc->tdm_rx_sel/TDM_RX_NUM, vinc->tdm_rx_sel);
					csic_tdm_rx_enable(vinc->tdm_rx_sel/TDM_RX_NUM, vinc->tdm_rx_sel + 1);
					csic_tdm_rx_cap_enable(vinc->tdm_rx_sel/TDM_RX_NUM, vinc->tdm_rx_sel + 1);
					...
				} else {
					if (vinc->tdm_rx_sel != 0xff) {
						csic_tdm_rx_enable(vinc->tdm_rx_sel/TDM_RX_NUM, vinc->tdm_rx_sel);
						csic_tdm_rx_cap_enable(vinc->tdm_rx_sel/TDM_RX_NUM, vinc->tdm_rx_sel);
					}
				}
#endif
				csic_prs_enable(vinc->csi_sel);
				csic_prs_capture_start(vinc->csi_sel, csi->bus_info.ch_total_num, &mode);
```

这说明：

- `csic_prs_capture_start()` 后，Parser 开始出 RAW
- `csic_tdm_rx_enable()/cap_enable()` 后，TDM RX 开始持续接收

---

## 2）数据怎么按时间片发给对应虚拟 ISP？

**关键点：不是软件靠中断“切片发送”的。**

真正的机制是：

### 第一步：各路 RAW 先被 TDM RX 持续接收
每个 `tdm_rx0~3` 对应一路输入。  
TDM 先把这些 RAW 收进自己的 RX buffer / LBC buffer。

这在 `tdm_set_rx_cfg()` 里很清楚：

```472:548:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static int tdm_set_rx_cfg(struct tdm_rx_dev *tdm_rx, unsigned int en)
{
	...
		csic_tdm_rx_input_bit(tdm->id, tdm_rx->id, tdm_rx->tdm_fmt->input_type);
		csic_tdm_rx_input_fmt(tdm->id, tdm_rx->id, tdm_rx->tdm_fmt->raw_fmt);
		csic_tdm_rx_input_size(tdm->id, tdm_rx->id, tdm_rx->format.width, tdm_rx->format.height);
		...
		if (tdm_rx->ws.pkg_en) {
			csic_tdm_rx_pkg_enable(tdm->id, tdm_rx->id);
			...
		} else if (tdm_rx->ws.lbc_en) {
			csic_tdm_rx_lbc_enable(tdm->id, tdm_rx->id);
			...
		}
```

所以 TDM 先做的是：

- 收每一路 RAW
- 存起来
- 做 pkg/LBC 整形

---

### 第二步：TDM TX 再把这些 RX 通道的数据“轮流送”给 ISP
这个“轮流送”，是**TDM 硬件内部做的时分复用**，不是 CPU 一个个搬。

TDM 顶层启动时，会设置：

- `rx_chn_mode`
- `tx_chn_mode`
- `work_mode`
- `speed_dn`
- `tx fifo depth`
- `blank`
- `tx_data_rate`

看这里：

```815:878:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
static int sunxi_tdm_top_s_stream(struct tdm_rx_dev *rx, int enable)
{
	...
		csic_tdm_set_rx_chn_cfg_mode(tdm->id, tdm->ws.rx_chn_mode);
		csic_tdm_set_tx_chn_cfg_mode(tdm->id, tdm->ws.tx_chn_mode);
		csic_tdm_set_work_mode(tdm->id, tdm->work_mode);
		csic_tdm_set_speed_dn(tdm->id, tdm->ws.speed_dn_en);

		tdm_set_tx_blank(tdm);
		...
		if (tdm->ws.speed_dn_en) {
			csic_tdm_set_tx_data_rate(tdm->id, tdm->tx_cfg.valid_num, tdm->tx_cfg.invalid_num);
		}
		csic_tdm_tx_enable(tdm->id);
```

这里的意思非常重要：

> **“时间片”是 TDM 硬件发送器自己形成的发送窗口。**

不是 Linux 驱动用软中断在切。

---

## 3）时间片到底是什么？是软中断吗？

**不是软中断。**

### 不是：
- 不是 `timer`
- 不是 `tasklet`
- 不是 `softirq`
- 不是 CPU 每隔 N us 调度一次

### 而是：
- **TDM 硬件 TX 发送时序**
- 由这些硬件参数共同决定：
  - `rx_chn_mode`
  - `valid_num / invalid_num`
  - `hblank / vblank`
  - `fifo depth`
  - `speed_dn_en`

---

# 你可以把它想成“铁路调度”

- 4 路 RAW = 4 条支线
- `tdm_rx0~3` = 4 个候车站，一直在收各自来的车
- `tdm_tx` = 只有 1 条主线出口
- 物理 ISP = 只有 1 个处理厂

那怎么进厂？

不是站长（CPU）吹哨一辆一辆放行，  
而是**铁路信号系统（TDM 硬件时序）**规定：

- 这一段时间主线给 rx0
- 下一段时间主线给 rx1
- 再下一段给 rx2
- …

这就是“时间片”。

---

# 那“对应虚拟 ISP”又是怎么对应上的？

这里有两个层次：

---

## A. 路由关系是 VIN 提前配好的，不是发送时临时决定

VIN 在 stream on 前就把：

- 哪一路 parser/csi
- 接到哪个 physical ISP
- 的哪个 virtual input

设好了：

```1018:1039:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		} else {
			if ((vinc->csi_ch != 0xff) && (vinc->csi_ch & 0x10))
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, vinc->csi_ch & 0xf);
			else {
				for (i = 0; i < vinc->total_rx_ch; i++)
					csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + i, vinc->csi_sel, i);
			}
		}
		csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
```

这里已经把：

- physical ISP
- virtual input 编号

固定下来了。

所以不是“时间片来了再查表决定发给谁”，而是：

> **这一路数据本来就绑定在某个 virtual input 上。**

---

## B. ISP 在处理这段数据时，用对应 virtual ISP 的参数上下文

物理 ISP 只有一个，但每个虚拟 ISP 有各自参数。

在 `PARA_LOAD_PD` 时，ISP 会把当前上下文参数装进去：

```2517:2556:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
	if (bsp_isp_get_irq_status(isp->id, PARA_LOAD_PD)) {
		...
		bsp_isp_set_para_ready(isp->id, PARA_NOT_READY);
		if (isp->load_flag)
			memcpy(isp->isp_load.vir_addr, &isp->load_shadow[0], ISP_LOAD_DRAM_SIZE);
		...
		bsp_isp_set_size(isp->id, &isp->isp_ob);
		bsp_isp_update_table(isp->id, (unsigned short)load_val);
		...
		bsp_isp_set_para_ready(isp->id, PARA_READY);
	}
```

所以完整理解应该是：

- **TDM 决定当前哪一路 RAW 正在被送**
- **ISP 参数装载机制决定当前用哪一路 virtual ISP 参数去处理**

---

# 再回答你那句最关键的话

## “TDM 是一直接收 RAW 数据吗？”
**是。**
只要对应 `tdm_rx` 开着，Parser 在吐 RAW，TDM RX 就持续接收。

---

## “数据怎么按时间片发给对应虚拟 ISP？”
**不是软件发。**
而是：

1. TDM RX 持续收各路 RAW
2. TDM TX 硬件按 `rx_chn_mode + valid/invalid + blank` 做时分复用
3. ISP 前端路由已经把这一路绑定到某个 virtual input
4. ISP 在参数加载点装入对应 virtual ISP 的上下文

---

## “时间片是软中断还是其他方式？”
**不是软中断。**
是 **TDM 硬件发送时序**。

### 中断在这里干嘛？
中断只是：

- 报告 `TX_FRM_DONE`
- 报告 `RXx_FRM_DONE`
- 报告 overflow / error
- 供驱动观察状态、stop 时等待、安全回收 buffer

不是用来“生成时间片”的。

从 `sunxi_tdm_top_s_stream()` 也能看出，驱动只是开中断：

```864:878:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
		ini_en = RX_FRM_LOST_INT_EN | RX_FRM_ERR_INT_EN | RX_BTYPE_ERR_INT_EN |
				RX_BUF_FULL_INT_EN | RX_HB_SHORT_INT_EN | RX_FIFO_FULL_INT_EN |
				TDM_LBC_ERR_INT_EN | TDM_FIFO_UNDER_INT_EN | SPEED_DN_FIFO_FULL_INT_EN |
				SPEED_DN_HSYNC_INT_EN | RX_CHN_CFG_MODE_INT_EN | TX_CHN_CFG_MODE_INT_EN |
				RDM_LBC_FIFO_FULL_INT_EN;
#ifdef CONFIG_TDM_OFFLINE_HANDLE_RAW
		ini_en |= TX_FRM_DONE_INT_EN | RX0_FRM_DONE_INT_EN;
#endif
		csic_tdm_int_clear_status(tdm->id, TDM_INT_ALL);
		csic_tdm_int_enable(tdm->id, ini_en);
```

这更像“状态上报”，不是“调度执行”。

---

# 最后我给你一个最简时序图

## offline 4 路 RAW 时

### 启动阶段
- VIN 配好 `parser -> ISP virtual input`
- TDM 配好 `rx_chn_mode / tx_data_rate / blank`
- ISP 开 capture
- Parser 开 capture
- TDM RX 开接收

### 运行阶段
- `tdm_rx0~3` 持续收各路 RAW
- TDM TX 硬件轮流送：
  - 一小段送 rx0
  - 一小段送 rx1
  - 一小段送 rx2
  - 一小段送 rx3
- 物理 ISP 按当前 input/context 处理
- 到 `PARA_LOAD_PD / FINISH_PD` 时切参数/记帧

### 停止阶段
- 驱动等 `TX_FRM_DONE`
- 再关 TDM/ISP/Parser
- 回收 buffer

---

如果你愿意，我下一条可以专门只做一件事：

**我给你画一个“4路 linear RAW + 1个 physical ISP + 4个 virtual ISP + TDM”的纯文字时序图**，  
按 `t0/t1/t2/t3` 标出来每个时刻到底是谁在收、谁在发、谁在处理。  
那样会比读源码更直观。

---

# 补充澄清：为什么 media graph 是 `csi -> tdm_rx -> isp`，但 `csic_isp_input_select()` 还在选 parser？

这是这条链路里最容易混淆的地方。  
要把它彻底讲清，需要把下面三层分开：

1. **media graph / subdev 拓扑层**
2. **CSIC TOP 路由寄存器层**
3. **TDM 物理收发与时分发送层**

如果把这三层混成一层，就会得出“既然 ISP 物理输入是 TDM，为什么还要让 ISP 关心 CSI/Parser”这种看起来矛盾的结论。

---

## 先给最终结论

### 结论1：`media_create_pad_link()` 描述的是“逻辑拓扑”
在 media graph 里，如果配置了 `tdm_rx_sel`，驱动建的确实是：

```text
csi -> tdm_rx -> isp
```

对应源码：

```c
/* lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c */
if (tdm_rx != NULL) {
	source = &csi->entity;
	sink = &tdm_rx->entity;
	ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
				sink, VIN_SD_PAD_SINK, ...);

	source = &tdm_rx->entity;
	sink = &isp->entity;
	ret = media_create_pad_link(source, SCALER_PAD_SOURCE,
				sink, VIN_SD_PAD_SINK,
				MEDIA_LNK_FL_ENABLED);
}
```

也就是说，**从 V4L2/media 拓扑视角看，TDM 就是 ISP 前面的中间实体**。

---

### 结论2：`csic_isp_input_select()` 配的不是“电气入口”，而是“逻辑来源绑定”
虽然 ISP 的像素数据在 offline/TDM 模式下确实是由 TDM TX 送进去的，  
但 `csic_isp_input_select()` 配置的不是“物理线上是谁接到 ISP”，而是：

> **这个 ISP virtual input/context 归属于哪个 parser 的哪个 channel。**

从 `top_reg.c` 可以直接看出来：

```c
/* isp_id isp_input pasrer_id parser_ch */
static char isp_input[4][4][4][4] = { ... };

void csic_isp_input_select(unsigned int sel, unsigned int isp,
			   unsigned int in, unsigned int psr, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_ISP0_IN0_REG_OFF + isp * 16 + in * 4,
		       isp_input[isp][in][psr][ch]);
}
```

这里 `psr` 和 `ch` 已经把语义写死了：

- `psr` = parser id
- `ch` = parser channel

所以它本来就是一个：

> **“把 parserX chY 绑定到 ISP 的 input slot Z”**

的函数，而不是：

> “选择 TDM 是否作为 ISP 物理输入”

---

### 结论3：TDM 负责“搬运和时分”，不负责“来源身份定义”
TDM 这边你能看到的是：

- `rx enable`
- `rx cap enable`
- `rx_tx_enable`
- `pkg_en / lbc_en / sync_en`
- `rx_chn_mode / tx_chn_mode`
- `valid_num / invalid_num`
- `blank / fifo / speed_dn`

比如：

```c
if (tdm_rx->ws.tx_func_en)
	csic_tdm_rx_tx_enable(tdm->id, tdm_rx->id);
else
	csic_tdm_rx_tx_disable(tdm->id, tdm_rx->id);
```

以及：

```c
csic_tdm_set_rx_chn_cfg_mode(tdm->id, tdm->ws.rx_chn_mode);
csic_tdm_set_tx_chn_cfg_mode(tdm->id, tdm->ws.tx_chn_mode);
csic_tdm_set_work_mode(tdm->id, tdm->work_mode);
csic_tdm_set_speed_dn(tdm->id, tdm->ws.speed_dn_en);
csic_tdm_set_tx_data_rate(tdm->id, tdm->tx_cfg.valid_num, tdm->tx_cfg.invalid_num);
csic_tdm_tx_enable(tdm->id);
```

这些都说明：

> **TDM 决定的是“这一路要不要送”“什么时候送”“按什么节拍送”**，
> 而不是“这一路是谁”。

---

## 为什么 ISP 明明吃的是 TDM 数据，软件里还要绑定 parser？

因为对 ISP 来说，真正重要的不只是“当前有一股 RAW 数据来了”，而是：

- 这股 RAW 本来属于哪一路 parser/channel
- 它应该落到哪个 `virtual input`
- 这一帧该套哪一套 ISP 参数上下文

也就是说，ISP 需要的不只是“物理数据流”，还需要“这路数据的身份”。

而在当前这套硬件/驱动实现里，这个“身份”是用：

```text
parser_id + parser_channel
```

来表达的，不是用：

```text
tdm_rx id
```

来表达的。

所以更准确的理解应该是：

- **TDM 物理上把数据送到 ISP**
- **Parser 逻辑上定义这路数据是谁**
- **`csic_isp_input_select()` 负责把这个“是谁”绑定到 ISP 的 virtual input**

这三件事是同时成立的，不冲突。

---

## 这也是为什么 `large_image == 3` 时，代码写的是 `parser ch0/ch1 -> isp`

在 `large_image == 3` 下，CSI parser 已经先把大图拆成两路：

```c
if (csi->large_image == 3) {
	csic_prs_ch_en(csi->id, 1);
	csi->bus_info.ch_total_num = 2;
	...
	if (i == 0) {
		csi->out_size.hor_start = 0;
	} else {
		csi->out_size.hor_start = mf->width/2 - overlayer;
	}
}
```

因此在 `vin.c` 里才会看到：

```c
/* parserx ch0--isp0 ch0, parserx ch1-- isp1 ch0 */
if (vinc->isp_sel == 0)
	csic_isp_input_select(..., vinc->csi_sel, 0);
else if (vinc->isp_sel == 1)
	csic_isp_input_select(..., vinc->csi_sel, 1);
```

这段代码表达的不是：

> “绕过 TDM，直接让 parser 进 ISP”

而是：

> “左半图这一路的逻辑来源身份是 parser ch0，右半图这一路的逻辑来源身份是 parser ch1”

后面即便这两路数据再进入各自的 `tdm_rx0/1`，再由 TDM 发给 ISP，  
**它们的逻辑归属仍然是 parser ch0 / ch1。**

---

## 用一句话区分这三层

### 1. media graph 层
回答的是：

> **模块之间怎么串起来？**

这里是：

```text
csi -> tdm_rx -> isp
```

---

### 2. CSIC TOP 路由层
回答的是：

> **这个 ISP input slot 归属于哪个 parser/channel？**

这里由 `csic_isp_input_select()` 完成。

---

### 3. TDM 层
回答的是：

> **这几路 RAW 怎么缓存、整形、按时分节拍送给 ISP？**

这里由：

- `rx_tx_enable`
- `rx_chn_mode`
- `tx_chn_mode`
- `valid_num / invalid_num`
- `blank / fifo`

这些机制完成。

---

## 所以“ISP 物理接口输入是 TDM，为什么还要关心 CSI/Parser？”的最短答案

最短答案就是：

> **ISP 物理上接收的是 TDM 送来的像素流，但逻辑上仍然要知道这股像素流原本属于哪个 parser/channel，才能把它放进正确的 virtual input/context，并装入对应的 ISP 参数。**

也可以换成更口语的一句：

> **TDM 负责“把数据送过来”，Parser 负责“告诉 ISP 这是谁的数据”。**

---

## 如果继续往下深挖，这里最值得记住的判断标准

以后再看类似代码时，可以用下面这个标准区分：

### 如果一个函数在改这些东西：
- `media_create_pad_link`
- `media_entity_setup_link`
- `VIN_IND_*`

那它大概率在描述：

> **media / subdev 逻辑拓扑**

### 如果一个函数在改这些东西：
- `CSIC_ISP0_IN0_REG_OFF`
- `CSIC_VIPP0_IN_REG_OFF`
- `isp_input[isp][in][psr][ch]`

那它大概率在描述：

> **CSIC TOP 的来源绑定关系**

### 如果一个函数在改这些东西：
- `TDM_RX_TX_EN`
- `TDM_TX_DATA_RATE`
- `RX_CHN_CFG_MODE`
- `TX_CHN_CFG_MODE`
- `TDM_TX_H_BLANK`

那它大概率在描述：

> **TDM 的硬件收发和时分调度**

---

## 最后用一张最简对照图收束

```text
[逻辑来源身份层]
parser0 ch0 ----------------------> ISP virtual input0
parser0 ch1 ----------------------> ISP virtual input1

[media graph 拓扑层]
sensor -> mipi -> csi -> tdm_rx0/1 -> isp -> vipp

[物理数据流层]
parser输出 -> tdm_rx缓存 -> tdm_tx时分发送 -> ISP物理前端
```

所以不要把下面两句话当成互相矛盾：

1. **media graph 上，ISP 前面是 TDM**
2. **CSIC TOP 上，ISP virtual input 绑定的是 parser/channel**

它们描述的是同一条链路的不同层次。

---

## 速查修正：最近几轮分析的最简结论

这一节只保留最容易混淆、但最关键的 4 个判断。

---

### 1. TDM 更像什么？

TDM 更像：

> **带时分发送器的专用搬运模块 / 时分 DMA**

它做的主要是：

- `rx` 收数据
- 写自己的 buffer
- 按 `rx_chn_mode / tx_chn_mode / valid_num / blank` 组织发送
- 把多路 RAW 时分送到 ISP

最小代码证据：

```c
/* TDM RX 参与不参与 TX */
if (tdm_rx->ws.tx_func_en)
	csic_tdm_rx_tx_enable(tdm->id, tdm_rx->id);
else
	csic_tdm_rx_tx_disable(tdm->id, tdm_rx->id);
```

```c
/* TDM TX 的时分调度参数 */
csic_tdm_set_rx_chn_cfg_mode(tdm->id, tdm->ws.rx_chn_mode);
csic_tdm_set_tx_chn_cfg_mode(tdm->id, tdm->ws.tx_chn_mode);
csic_tdm_set_work_mode(tdm->id, tdm->work_mode);
csic_tdm_set_speed_dn(tdm->id, tdm->ws.speed_dn_en);
csic_tdm_set_tx_data_rate(tdm->id, tdm->tx_cfg.valid_num, tdm->tx_cfg.invalid_num);
csic_tdm_tx_enable(tdm->id);
```

但它**不是透明 DMA**：

- 数据面上，CSI/ISP 不必理解它内部怎样切时间片
- 控制面上，VIN/ISP 仍然必须显式启停和管理它

比如 ISP 起流时会直接开 TDM：

```c
csic_tdm_top_enable(vinc->tdm_rx_sel/TDM_RX_NUM);
csic_tdm_enable(vinc->tdm_rx_sel/TDM_RX_NUM);
csic_tdm_tx_enable(vinc->tdm_rx_sel/TDM_RX_NUM);
csic_tdm_rx_enable(vinc->tdm_rx_sel/TDM_RX_NUM, vinc->tdm_rx_sel);
```

---

### 2. 为什么寄存器层暴露给软件的“源”是 `parser_id + parser_ch`，不是 `tdm_id`？

因为 **CSIC TOP 这层硬件本来就只认识 parser/channel 作为 ISP 输入来源**。

最直接的代码证据：

```c
/* isp_id isp_input pasrer_id parser_ch */
static char isp_input[4][4][4][4] = { ... };

void csic_isp_input_select(unsigned int sel, unsigned int isp,
			   unsigned int in, unsigned int psr, unsigned int ch)
{
	vin_reg_writel(..., isp_input[isp][in][psr][ch]);
}
```

这里的 source 维度就是：

```text
parser_id + parser_ch
```

而不是：

```text
tdm_id
```

反过来看 TDM 的寄存器能力，它只有：

- `rx_tx_enable`
- `rx/tx chn mode`
- `work_mode`
- `tx_data_rate`

没有看到：

> “把 ISP 输入源选成 tdmX”

这种 CSIC TOP 级别的 mux 定义。

---

### 3. 为什么 `tdm_id` 不适合做“来源身份”？

因为 `tdm_rx id` 更像：

> **TDM 内部收发/调度槽位**

而不是全链路稳定的来源身份。

原因有两个：

#### A. 真正稳定的来源身份在 parser 侧

CSI 会先确定 parser 输出通道数：

```c
if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_0))
	csi->bus_info.ch_total_num++;
if (IS_FLAG(cfg->flags, V4L2_MBUS_CSI2_CHANNEL_1))
	csi->bus_info.ch_total_num++;
...
```

`large_image == 3` 时甚至会直接在 parser 层拆成两路：

```c
if (csi->large_image == 3) {
	csic_prs_ch_en(csi->id, 1);
	csi->bus_info.ch_total_num = 2;
	...
}
```

所以“这路数据原本是谁”在 parser 层就确定了。

#### B. `tdm_rx id` 在 WDR 下并不稳定

一个源在 TDM 里可能扩成多个 RX 槽位：

```c
tdm_rx1 = &tdm->tdm_rx[1];
tdm_rx2 = &tdm->tdm_rx[2];
tdm_rx_cpy(tdm_rx, tdm_rx1);
tdm_rx_cpy(tdm_rx, tdm_rx2);
```

或者：

```c
tdm_rx1 = &tdm->tdm_rx[1];
tdm_rx_cpy(tdm_rx, tdm_rx1);
```

这说明 `tdm_rx id` 在很多模式下只是内部复用槽位，不适合承担“原始来源身份”。

---

### 4. `PARA_LOAD_PD` 为什么没直接看到 parser->ISP 绑定表？

因为 `PARA_LOAD_PD` 干的不是“做绑定”，而是：

> **给当前这个 `isp` 实例加载自己的参数上下文**

最小代码证据：

```c
if (bsp_isp_get_irq_status(isp->id, PARA_LOAD_PD)) {
	bsp_isp_set_para_ready(isp->id, PARA_NOT_READY);
	if (isp->load_flag)
		memcpy(isp->isp_load.vir_addr, &isp->load_shadow[0], ISP_LOAD_DRAM_SIZE);
	...
	bsp_isp_update_table(isp->id, (unsigned short)load_val);
	bsp_isp_set_para_ready(isp->id, PARA_READY);
}
```

它确实**没有直接查** `parser -> ISP` 绑定表。  
两者的关联是在更上层通过同一个 `isp_sel / isp->id` 串起来的：

```text
vinc->isp_sel
  -> csic_isp_input_select(...)
     把 parser/ch 绑定到某个 ISP virtual input

vinc->isp_sel
  -> vind->isp[vinc->isp_sel].sd
     取到对应 isp_dev

isp_dev
  -> 自己持有 load_shadow

PARA_LOAD_PD
  -> 把这个 isp_dev 的 load_shadow 装进 ISP
```

所以更严谨的说法应该是：

- **绑定表** 解决“这路数据归哪个 ISP virtual input”
- **`PARA_LOAD_PD`** 解决“这个 ISP 实例现在该装哪套参数”

它们不是同一段代码，但通过同一个 `isp_sel` 串到一起。

---

### 最后只记一句话就够了

> **Parser 定义数据身份，TDM 负责时分搬运，ISP virtual input 决定归属槽位，`PARA_LOAD_PD` 负责加载该槽位对应的参数上下文。**
