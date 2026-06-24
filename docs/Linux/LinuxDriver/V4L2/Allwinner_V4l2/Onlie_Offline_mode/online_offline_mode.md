
---

**User**

请你结合之前输入，在结合lichee/linux-4.9/drivers/media/platform/sunxi-vin驱动框架总体分析一下
online模式是什么？offline模式是什么？

---

**Cursor**

可以。  
这一问如果只看单个文件，很容易把 `online/offline` 理解成“是否开 TDM”或者“是否走 DDR”；但结合 `sunxi-vin` 整个驱动框架去看，`online/offline` 实际上是 **VIN 子系统的数据组织方式**，会同时体现在：

- `VIN core` 的工作模式
- `ISP` 的工作模式
- `VIPP` 的工作模式
- `TDM` 的工作模式
- 以及 `pipeline` 的连接和数据节拍方式

我下面按“框架整体视角”来总结。

---

# 一、先给结论：online / offline 的本质定义

## 1）online 模式是什么？

**online 模式 = 前级输入数据到后级处理模块之间，按实时直通的方式工作。**

也就是：

- Sensor/MIPI/CSI parser 进来的 RAW
- 尽量直接送到 ISP / VIPP / DMA
- 中间不依赖 TDM 对多路 RAW 做排队、缓存、分时发送
- 一般是一条实时链路独占一套硬件处理资源

对 V853 来说，online 的典型理解就是：

> **一条流实时穿过 VIN 子系统，物理 ISP 不做多路时分复用。**

---

## 2）offline 模式是什么？

**offline 模式 = 前级输入与后级处理解耦，数据先进入中间缓存/调度模块，再送给后级处理。**

在 V853 上，这个“中间缓存/调度模块”主要就是 `TDM`。

因此 offline 在 V853 上更准确地说是：

- RAW 先被 TDM 接住
- TDM 负责 buffer / pack / lbc / 速率控制 / 分时发送
- 再把多路 RAW 轮流送给唯一的物理 ISP
- ISP 用不同虚拟 ISP 上下文分别处理

所以 V853 的 offline 本质是：

> **通过 TDM 把“采集”和“ISP处理”解耦，从而让一个物理 ISP 分时处理多路 RAW。**

---

# 二、从驱动框架看，online/offline 是多层统一的概念

不是只有 ISP 才有 online/offline，驱动里多个模块都定义了这个概念。

---

## 1）ISP 自己有 online/offline

`sunxi_isp.h` 里明确写了：

```48:55:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.h
enum isp_work_mode {
	ISP_ONLINE = 0,
	ISP_OFFLINE = 1,
};
```

说明 ISP 层面已经明确区分：

- `ISP_ONLINE`
- `ISP_OFFLINE`

---

## 2）VIPP 也有 online/offline

`sunxi_scaler.h` 里：

```37:40:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/sunxi_scaler.h
enum vipp_work_mode {
	VIPP_ONLINE = 0,
	VIPP_OFFLINE = 1,
};
```

这表示 VIPP/Scaler 也不是单纯“总在 ISP 后面吃数据”，而是和前级工作模式绑定的。

---

## 3）VIN core 也有 online/offline

`vin_core.c` 读取设备树 `work_mode`：

```2308:2331:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c
if (of_property_read_u32(np, "work_mode", &vinc->work_mode)) {
	vin_err("vinc%d get work mode fail\n", vinc->id);
	...
}
...
vin_log(VIN_LOG_VIDEO, "vinc%d work on %s mode\n", vinc->id,
	vinc->work_mode == 0xff ? (logic_vinc->work_mode ? "offline":"online"):(vinc->work_mode ? "offline":"online"));
```

这个日志已经很直白了：

- `work_mode ? "offline":"online"`

说明在 VIN capture core 看来：

- `0 = online`
- `1 = offline`

并且虚拟节点 `0xff` 会继承逻辑节点模式。

---

# 三、从 pipeline 框架看：online/offline 的区别到底在哪里？

`vin.c` 里的 `pipeline` 是最好的观察点，因为它是整个 `sunxi-vin` 的调度中枢。

---

## 1）不管 online/offline，pipeline 都会创建同样的媒体链

`vin.c` 在开流时会统一做：

- route select
- subdev `set_stream`
- pipeline open/close

例如设置 ISP 和 VIPP 路由：

```1026:1039:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
csic_isp_input_select(...);
...
csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
```

以及统一调用各 subdev 开流：

```1065:1065:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
ret = __vin_subdev_set_stream(p->sd[idx], idx, on);
```

所以从框架看：

> `online/offline` **不是两套完全不同的媒体图**，而是在同一套 VIN pipeline 下面，采用两种不同的数据流动策略。

---

## 2）online 和 offline 的区别不在“有没有 pipeline”，而在“数据是在模块间直通，还是先经过调度缓冲再送后级”

这点非常关键。

### online：
- pipeline 打开后
- 前级模块直接向后级持续送流
- 不强调多路时分调度
- 一般资源是独占的

### offline：
- pipeline 同样打开
- 但数据不会被后级直接实时消费
- 会通过 TDM 这种中间模块重新整形、缓存、节拍控制，再送给 ISP

---

# 四、从 V853 架构角度看：online/offline 在 V853 上分别意味着什么？

这才是最落地的解释。

---

## 1）V853 的 online 模式

### 特征
- 一个物理 ISP 只服务一条实时链路
- 不做 4 路虚拟 ISP 的分时复用
- 相关虚拟 ISP/VIPP 节点不能同时成立

这一点在 probe 阶段就有限制。

### ISP 虚拟节点在 online 下会失效
我们前面已经分析过 `isp_probe()`。当 logic ISP 工作在 online 时，虚拟 ISP 节点不能工作。

这意味着：

> **online 模式下，物理 ISP 不能拿来做多上下文轮转。**

所以 online 的本质是：
- 资源实时直通
- 一路流独占处理

---

## 2）V853 的 offline 模式

### 特征
- parser 接到 RAW 后，不要求立刻被 ISP 消费
- TDM 把 RAW 存入自身 rx buffer / lbc buffer
- 再按时分策略把不同 `tdm_rx` 的数据轮流送给 ISP
- ISP 用不同 virtual context 分别处理

这就是 V853 官方所说：
- 1 个 physical ISP
- 4 个 virtual ISP
- 4 路 RAW offline 分时处理

所以 V853 的 offline，核心就是：

> **引入 TDM 作为采集端与 ISP 端之间的中介调度层。**

---

# 五、从 TDM 看：online/offline 到底区别在哪里？

这是最能把概念落地的文件之一。

---

## 1）TDM online：本质是“非多路离线调度”
`sunxi_tdm_top_s_stream()` 一开头就限制：

```820:823:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
if (tdm->work_mode == TDM_ONLINE && rx->id != 0) {
	vin_err("tdm%d work on online mode, tdm_rx%d cannot to work!!\n", tdm->id, rx->id);
	return -1;
}
```

这句非常说明问题：

- `TDM_ONLINE` 下只有 `rx0` 能工作
- 其他 `tdm_rx1~3` 都不能启用

也就是说：

> **TDM online 不是“4 路一起在线”，而是基本退化为单路实时工作。**

这和 ISP online 的资源独占逻辑完全一致。

---

## 2）TDM offline：本质是“允许多 rx 通道参与分时”

TDM 顶层启动时会把模式写给硬件：

```838:842:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
csic_tdm_set_work_mode(tdm->id, tdm->work_mode);
...
csic_tdm_set_speed_dn(tdm->id, tdm->ws.speed_dn_en);
```

而在 offline 下，驱动会继续算发送速率：

```958:958:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
if (tdm->work_mode == TDM_ONLINE || !tdm->ws.speed_dn_en)
	return;
```

也就是说：

- **online 下不做这套多路速率分配**
- **offline 下才根据多路 width/height/fps/vts/isp_clk 计算 TDM TX 的发送速率**

继续往下可以看到：

```1029:1029:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/vin_tdm.c
tdm->tx_cfg.valid_num = DIV_ROUND_UP(...)
```

这说明 offline 的关键特征是：

- 多路 rx 总带宽汇总
- 统一根据 ISP 时钟预算来计算 `valid_num/invalid_num`
- 再据此进行时分发送

所以在 TDM 层面：

### online
- 单路、实时、少缓冲、无多路节拍分配

### offline
- 多路、缓存、带宽预算、时分发送

---

# 六、从 ISP 看：online/offline 到底区别在哪里？

---

## 1）online：ISP 更接近“实时直通消费者”

如果系统工作在 online，ISP 这边更像：

- parser/TDM 前端一旦有实时输入
- ISP 就直接消费
- 不要求为多路虚拟 context 轮流切换

---

## 2）offline：ISP 是“被 TDM 轮流喂数据的处理器”

在 ISP 启动流程里，驱动会同时拉起：

- ISP capture
- TDM RX
- parser capture

```1619:1648:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
if (flags) {
	bsp_isp_set_para_ready(isp->id, PARA_READY);
	bsp_isp_capture_start(isp->id);
	isp->isp_frame_number = 0;

	csic_isp_bridge_enable(0);

#if defined SUPPORT_ISP_TDM
	...
		csic_tdm_rx_enable(...);
		csic_tdm_rx_cap_enable(...);
	...
#endif
	csic_prs_enable(vinc->csi_sel);
	...
	csic_prs_capture_start(vinc->csi_sel, csi->bus_info.ch_total_num, &mode);
```

这说明 offline 下 ISP 的位置是：

- 不是直接从 parser 实时吃单路 RAW
- 而是处于 **TDM 调度链之后**
- 等 TDM 把当前时段该送的那一路 RAW 送进来

---

## 3）offline 下 ISP 还要做上下文装载

这点是 online/offline 最大差别之一。

在 ISP ISR 中：

```2517:2556:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
if (bsp_isp_get_irq_status(isp->id, PARA_LOAD_PD)) {
	...
	bsp_isp_set_para_ready(isp->id, PARA_NOT_READY);
	if (isp->load_flag)
		memcpy(isp->isp_load.vir_addr, &isp->load_shadow[0], ISP_LOAD_DRAM_SIZE);
	...
	bsp_isp_update_table(isp->id, (unsigned short)load_val);
	...
	bsp_isp_set_para_ready(isp->id, PARA_READY);
}
```

以及处理完成：

```2561:2584:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
if (bsp_isp_get_irq_status(isp->id, FINISH_PD)) {
	isp->isp_frame_number++;
	...
	sunxi_isp_frame_sync_isr(&isp->subdev);
	...
	isp->load_flag = 0;
}
```

这意味着 offline 模式下的 ISP，不只是“处理图像”，还承担了：

- 多虚拟 ISP context 的参数装载
- 帧间同步
- 统计/事件推进

所以你可以这么理解：

### online 模式下的 ISP
更像一条实时 pipeline 中的固定处理单元

### offline 模式下的 ISP
更像一个被多个虚拟上下文轮流占用的共享处理器

---

# 七、从驱动框架总体给出一个统一定义

如果把 `sunxi-vin` 当成一个整体框架，那么：

---

## online 模式

### 驱动框架定义
**各模块以实时直通方式组成单路处理链，后级直接消费前级输出。**

### 典型特征
- 一路流基本独占硬件处理资源
- TDM 不承担多路时分发送
- virtual ISP / virtual VIPP 不做真正并发/复用
- 更强调低延迟和实时性

### 在 V853 上的实际意义
- 物理 ISP 服务单路实时 RAW
- 不能同时承载 4 路虚拟 ISP offline 复用

---

## offline 模式

### 驱动框架定义
**前后级模块通过中间缓存/调度层解耦，数据不要求实时直通，而是按系统带宽和后级能力重新组织后再送入处理模块。**

### 典型特征
- 引入 TDM 做缓冲/整形/分时发送
- 多路 RAW 可以共用一个物理 ISP
- ISP 通过 `PARA_LOAD_PD / FINISH_PD` 在帧边界切换虚拟上下文
- 更强调资源复用，而不是最低延迟

### 在 V853 上的实际意义
- 1 个 physical ISP
- 4 个 virtual ISP context
- TDM 把 4 路 RAW 分时送给 ISP
- ISP 分别按 4 套配置处理

---

# 八、你可以记成一句工程上最好用的话

## online
**前级产出后，后级立刻吃。**

## offline
**前级先存/排队，后级按自己的节奏再吃。**

---

# 九、结合你之前的问题，再补一句最贴近 V853 的说法

对 V853：

### online 模式
就是：
- `RAW -> ISP -> VIPP`
- 以实时直通方式跑
- 一路占用 ISP

### offline 模式
就是：
- `RAW -> TDM(rx buffer/lbc/pkg) -> TDM(tx 分时) -> ISP(虚拟上下文切换) -> VIPP`
- 通过 TDM + 虚拟 ISP context，让一个物理 ISP 复用服务多路 RAW

---

如果你愿意，我下一步可以继续帮你把这个问题再往前推进两步中的任意一步：

1. **画一张 `sunxi-vin` 驱动框架总图**：  
   `sensor -> mipi -> csi parser -> tdm -> isp -> vipp -> dma/video`，并把 online/offline 分别标在图上。  
2. **单独把 V853 的 online 路径和 offline 路径分别列成详细调用链**，从 `VIDIOC_STREAMON` 一直跟到各 subdev `s_stream()`。

