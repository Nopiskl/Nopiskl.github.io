# V853 offline/TDM 下 ISP slot 与 VIPP slot 的固定相位关系

## 结论

官方通路配置指南里类似：

- `ISP00 固定连接 VIPP00/VIPP10/VIPP20/VIPP30`
- `ISP01 固定连接 VIPP01/VIPP11/VIPP21/VIPP31`

这类表述，更像是在描述 V853 offline/TDM 分时复用体系中的 **虚拟 ISP slot 与虚拟 VIPP slot 的固定相位对应关系**，而不是说芯片内部真的存在四条独立、永久、只能这样走的物理直连线。

也就是说，它表达的是：

| 分时 slot | ISP 虚拟 slot | VIPP 虚拟 slot 组合 | 源码 ID 形态 |
| --- | --- | --- | --- |
| slot0 | ISP00 | VIPP00 / VIPP10 / VIPP20 / VIPP30 | 0 / 4 / 8 / 12 |
| slot1 | ISP01 | VIPP01 / VIPP11 / VIPP21 / VIPP31 | 1 / 5 / 9 / 13 |
| slot2 | ISP02 | VIPP02 / VIPP12 / VIPP22 / VIPP32 | 2 / 6 / 10 / 14 |
| slot3 | ISP03 | VIPP03 / VIPP13 / VIPP23 / VIPP33 | 3 / 7 / 11 / 15 |

因此，“固定连接”的重点不是“有四组独立物理 ISP 到 VIPP 直连线”，而是：

> 同一个分时 slot 编号，在 TDM -> ISP -> VIPP -> DMA/VIN 这条 offline pipeline 上保持对齐。

slot0 对 slot0，slot1 对 slot1，slot2 对 slot2，slot3 对 slot3。

## 1. 平台能力：一个物理 ISP 组，多个虚拟 slot

V853 对应 `sun8iw21p1`。平台配置里能看到一个 ISP 寄存器基地址和四个 VIPP 寄存器基地址：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/platform/sun8iw21p1_vin_cfg.h`
  - `ISP_REGS_BASE = 0x05900000`
  - `VIPP0_REGS_BASE = 0x05910000`
  - `VIPP1_REGS_BASE = 0x05910400`
  - `VIPP2_REGS_BASE = 0x05910800`
  - `VIPP3_REGS_BASE = 0x05910c00`
  - `VIN_MAX_TDM = 1`
  - `VIN_MAX_ISP = 5`
  - `VIN_MAX_SCALER = 16`
  - `MAX_CH_NUM = 4`

同时，V853 选用的模块版本是：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/platform/platform_cfg.h`
  - `VIPP_200`
  - `ISP_600`
  - `CSIC_DMA_VER_140_000`

对应模块里又明确给出了虚拟 slot 数：

- `vin-isp/isp600/isp600_reg_cfg.h`
  - `ISP_VIRT_NUM = 4`
- `vin-vipp/vipp200/vipp200_reg.h`
  - `VIPP_VIRT_NUM = 4`
- `vin-video/dma140/dma140_reg.h`
  - `DMA_VIRTUAL_NUM = 4`
- `vin-tdm/tdm200/tdm200_reg.h`
  - `TDM_RX_NUM = 4`

这说明源码的基本模型就是：物理模块按 group 存在，但每个 group 里有 4 个虚拟通道/分时 slot。

## 2. ISP：ISP00~ISP03 是逻辑 ISP0 下的虚拟 slot

ISP600 的虚拟映射在这里：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/isp600/isp600_reg_cfg.c`

关键数组：

```c
int isp_virtual_find_ch[ISP600_MAX_NUM] = {
	0, 1, 2, 3,
};

int isp_virtual_find_logic[ISP600_MAX_NUM + 1] = {
	0, 0, 0, 0, 4
};
```

含义是：

- `isp_sel = 0`，虚拟 channel 是 `0`，逻辑 ISP group 是 `0`
- `isp_sel = 1`，虚拟 channel 是 `1`，逻辑 ISP group 仍是 `0`
- `isp_sel = 2`，虚拟 channel 是 `2`，逻辑 ISP group 仍是 `0`
- `isp_sel = 3`，虚拟 channel 是 `3`，逻辑 ISP group 仍是 `0`

也就是：

| 源码 `isp_sel` | 可理解为 | 逻辑 ISP group | 虚拟 slot |
| --- | --- | --- | --- |
| 0 | ISP00 | ISP0 | slot0 |
| 1 | ISP01 | ISP0 | slot1 |
| 2 | ISP02 | ISP0 | slot2 |
| 3 | ISP03 | ISP0 | slot3 |

`bsp_isp_map_reg_addr()` 里也能看到同样逻辑：

```c
base += isp_virtual_find_ch[id] * addr_base_offset;
```

所以 `ISP00/ISP01/ISP02/ISP03` 更像是同一个逻辑 ISP 组下的四个虚拟上下文，而不是四个完全独立的 ISP 物理实例。

## 3. VIPP：VIPP00/VIPP10/VIPP20/VIPP30 共享同一个 slot0

VIPP200 的虚拟映射更直接：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/vipp200/vipp200_reg.c`

关键数组：

```c
int vipp_virtual_find_ch[16] = {
	0, 1, 2, 3,
	0, 1, 2, 3,
	0, 1, 2, 3,
	0, 1, 2, 3,
};

int vipp_virtual_find_logic[16] = {
	0, 0, 0, 0,
	4, 4, 4, 4,
	8, 8, 8, 8,
	12, 12, 12, 12,
};
```

这组数组刚好解释了官方文档中的命名方式：

| 源码 VIPP ID | 可理解为 | 逻辑 VIPP group | 虚拟 slot |
| --- | --- | --- | --- |
| 0 | VIPP00 | VIPP0 | slot0 |
| 1 | VIPP01 | VIPP0 | slot1 |
| 2 | VIPP02 | VIPP0 | slot2 |
| 3 | VIPP03 | VIPP0 | slot3 |
| 4 | VIPP10 | VIPP1 | slot0 |
| 5 | VIPP11 | VIPP1 | slot1 |
| 6 | VIPP12 | VIPP1 | slot2 |
| 7 | VIPP13 | VIPP1 | slot3 |
| 8 | VIPP20 | VIPP2 | slot0 |
| 9 | VIPP21 | VIPP2 | slot1 |
| 10 | VIPP22 | VIPP2 | slot2 |
| 11 | VIPP23 | VIPP2 | slot3 |
| 12 | VIPP30 | VIPP3 | slot0 |
| 13 | VIPP31 | VIPP3 | slot1 |
| 14 | VIPP32 | VIPP3 | slot2 |
| 15 | VIPP33 | VIPP3 | slot3 |

所以：

- `VIPP00/VIPP10/VIPP20/VIPP30` 的共同点不是同一个物理 VIPP，而是同一个虚拟 slot：`slot0`
- `VIPP01/VIPP11/VIPP21/VIPP31` 的共同点是 `slot1`
- `VIPP02/VIPP12/VIPP22/VIPP32` 的共同点是 `slot2`
- `VIPP03/VIPP13/VIPP23/VIPP33` 的共同点是 `slot3`

这正好支撑“ISP00 固定连接 VIPP00/VIPP10/VIPP20/VIPP30”应该按 **slot0 相位对齐** 来理解。

`bsp_vipp_map_reg_addr()` 也使用了虚拟 channel 偏移：

```c
vipp_base[id] += vipp_virtual_find_ch[id] * addr_base_offset;
```

此外，VIPP 的 enable、parameter ready、load address 等操作也都使用 `vipp_virtual_find_ch[id]`。这说明源码真正关心的是 “这个 VIPP ID 属于哪个虚拟 channel slot”。

## 4. CSIC TOP 路由：选择的是 group + channel，不是任意物理线

stream-on 时，VIN 会配置 CSIC TOP 的输入选择：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c`

V853 分支中有两类选择：

```c
csic_isp_input_select(
	vind->id,
	vinc->isp_sel / ISP_VIRT_NUM,
	vinc->isp_sel % ISP_VIRT_NUM + i,
	vinc->csi_sel,
	i);
```

这里 `isp_sel / ISP_VIRT_NUM` 是逻辑 ISP group，`isp_sel % ISP_VIRT_NUM` 是虚拟 ISP slot。

然后配置 VIPP 输入：

```c
csic_vipp_input_select(
	vind->id,
	vinc->vipp_sel / VIPP_VIRT_NUM,
	vinc->isp_sel / ISP_VIRT_NUM,
	vinc->isp_tx_ch);
```

注意这里传给 `csic_vipp_input_select()` 的是：

- 逻辑 VIPP group：`vipp_sel / VIPP_VIRT_NUM`
- 逻辑 ISP group：`isp_sel / ISP_VIRT_NUM`
- ISP 输出通道：`isp_tx_ch`

它没有把 `vipp_sel % VIPP_VIRT_NUM` 作为一个“任意连线选择”传进去。VIPP 的低两位虚拟 slot 是由 VIPP 自身的 `vipp_virtual_find_ch[id]` 参与寄存器/中断/参数加载来表达的。

底层寄存器写法在：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/top_reg.c`

相关结构是：

```c
isp_input[isp][in][psr][ch]
vipp_input[vipp][isp][ch]
```

也就是说，TOP 层面的选择更像是 “哪个 logical VIPP group 接哪个 logical ISP group 的哪个 ISP TX channel”，而不是 “任意 ISPxx 到任意 VIPPxx 的物理线矩阵”。

## 5. TDM：多路 RAW 以 RX slot/分时模式进入 offline pipeline

TDM200 明确有 4 个 RX：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-tdm/tdm200/tdm200_reg.h`

```c
#define TDM_RX_NUM 4
```

TDM 的 TX/RX 模式也围绕 channel 组合展开：

```c
enum tx_chn_cfg_mode {
	CH0_1 = 1,
	CH2_3 = 2,
	CH0_1_AND_CH2_3 = 3,
	CH0_1_2 = 4,
	CH0_1_2_3 = 5,
};

enum rx_chn_cfg_mode {
	LINEARx4 = 0,
	WDR_2F_AND_LINEARx2 = 1,
	WDR_2Fx2 = 2,
	WDR_3F_AND_LINEAR = 3,
};
```

`vin-tdm/vin_tdm.c` 里，offline 模式下会根据当前启用的 RX/WDR 组合计算 `rx_chn_mode` 和 `tx_chn_mode`，再配置 TDM top stream：

- `tdm_cal_rx_chn_cfg_mode()`
- `sunxi_tdm_top_s_stream()`
- `sunxi_tdm_subdev_s_stream()`
- `tdm_set_rx_cfg()`
- `tdm_set_tx_blank()`
- `tdm_set_rx_data_rate()`

这些函数共同完成：

- 根据 RX0~RX3 的使用情况选择 TDM 通道组合
- offline 模式下设置 TX blank/data rate
- 为每个 RX 配置数据格式、尺寸、buffer 地址、package/LBC/sync 等
- 启用 `csic_tdm_rx_tx_enable()`，让对应 RX 参与 TX 分时输出

这说明 TDM 的作用不是在 CPU ISR 里手工搬运每路 RAW，而是由硬件按 RX channel/slot 形成 offline 分时输出节奏。

需要注意：源码里的 TDM ISR 主要处理 RX/TX frame done 和错误状态：

- `tdm_irq_status.rx0_frm_done`
- `tdm_irq_status.rx1_frm_done`
- `tdm_irq_status.rx2_frm_done`
- `tdm_irq_status.rx3_frm_done`
- `tdm_irq_status.tx_frm_done`

因此更准确的说法是：

> TDM 硬件的分时 TX 边界形成 downstream frame/parameter 边界；ISP/VIPP 的参数重载发生在 ISP/VIPP 各自 ISR 中，而不是 TDM ISR 直接调用 ISP/VIPP reload。

## 6. ISP 参数上下文：在 PARA_LOAD/PARA_SAVE 边界切换

ISP 的每个虚拟设备都有自己的 `load_shadow` 和 `load_flag`：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.h`

```c
struct isp_dev {
	...
	int load_flag;
	...
	void *load_shadow;
	...
};
```

ISP600 资源分配时，还会分配 load/save buffer 和两个 load ping-pong 区域：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c`

相关逻辑：

```c
isp->isp_load.phy_addr = isp->isp_save.phy_addr + ISP_SAVE_DRAM_SIZE;
isp->load_para[0].phy_addr = isp->isp_load.phy_addr + ISP_SAVE_LOAD_DRAM_SIZE;
isp->load_para[1].phy_addr = isp->load_para[0].phy_addr + ISP_LOAD_DRAM_SIZE;
```

在 ISP600 ISR 里，`PARA_LOAD_PD` 是关键边界：

```c
if (isp_status & PARA_LOAD_PD) {
	bsp_isp_clr_irq_status(isp->id, PARA_LOAD_PD);
	...
	memcpy(isp->isp_load.vir_addr, isp->load_shadow, ISP_LOAD_DRAM_SIZE);
	...
	sunxi_isp_set_load_ddr(isp);
	...
	bsp_isp_set_load_addr(isp->id, isp->load_para[...].phy_addr);
	bsp_isp_set_para_ready(isp->id, PARA_READY);
}
```

`PARA_SAVE_PD` 则对应保存/帧同步边界：

```c
if (isp_status & PARA_SAVE_PD) {
	...
	isp->load_flag = 0;
}
```

这支撑了：

> ISP 在硬件参数 load/save 边界切换虚拟 ISP 的参数上下文。

在 offline/TDM 分时体系下，这个上下文切换与当前 slot 的输入节奏对齐。

## 7. VIPP 参数上下文：在 CHN0~3_REG_LOAD 边界切换

VIPP200 每个逻辑 VIPP group 内也有 4 个 channel 的 register-load interrupt：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/vipp200/vipp200_reg.h`

典型状态位：

```c
CHN0_REG_LOAD_PD
CHN1_REG_LOAD_PD
CHN2_REG_LOAD_PD
CHN3_REG_LOAD_PD
```

VIPP ISR 在这里：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/sunxi_scaler.c`

处理逻辑是：

- 收到 `CHN0_REG_LOAD_PD`，处理当前 `scaler->id`
- 收到 `CHN1_REG_LOAD_PD`，处理 `scaler->id + 1`
- 收到 `CHN2_REG_LOAD_PD`，处理 `scaler->id + 2`
- 收到 `CHN3_REG_LOAD_PD`，处理 `scaler->id + 3`

每个 channel 的处理都会把对应虚拟 VIPP 的 `vipp_reg` 拷贝到 ping-pong load buffer，然后更新 load 地址：

```c
memcpy(scalerX->load_para[...].vir_addr,
       scalerX->vipp_reg,
       VIPP_REG_SIZE);

vipp_set_reg_load_addr(scalerX->id,
                       scalerX->load_para[...].phy_addr);
```

当 scaler streaming 中参数变化时，也会按虚拟 channel 打开对应的 register-load interrupt：

```c
vipp_enable_irq_status(
	scaler->id,
	CHN0_REG_LOAD_EN <<
	(vipp_virtual_find_ch[scaler->id] * VIPP_CHN_INT_AMONG_OFFSET));
```

这说明 VIPP 的四个虚拟 slot 是通过 `CHN0~3_REG_LOAD` 这类边界来分别装载参数上下文的。

因此：

> VIPP00/VIPP10/VIPP20/VIPP30 属于不同逻辑 VIPP group，但它们都对应 VIPP virtual channel slot0。

这正是“ISP00 固定连接 VIPP00/VIPP10/VIPP20/VIPP30”的 slot 解释。

## 8. DMA/VIN offline ISR：按虚拟通道轮询处理输出 buffer

DMA140 也有与 VIPP 同形态的虚拟映射：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/dma140/dma140_reg.c`

```c
int dma_virtual_find_ch[16] = {
	0, 1, 2, 3,
	0, 1, 2, 3,
	0, 1, 2, 3,
	0, 1, 2, 3,
};

int dma_virtual_find_logic[16] = {
	0, 0, 0, 0,
	4, 4, 4, 4,
	8, 8, 8, 8,
	12, 12, 12, 12,
};
```

DMA status 读取也会先映射到虚拟 channel：

```c
csic_dma_int_get_status_internal(
	dma_virtual_find_ch[sel],
	status);
```

VIN 的主 ISR 在 offline 模式下不会只处理一个固定 video node，而是在同一个 logical group 的 4 个虚拟通道里轮询：

- `lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c`

核心逻辑：

```c
if (vinc->work_mode == BK_ONLINE) {
	csic_dma_int_get_status(vinc->vipp_sel, &status);
} else {
	work_mode = BK_OFFLINE;
	for (i = vinc->vir_prosess_ch; i < vinc->vir_prosess_ch + 4; i++) {
		j = i % (vinc->vipp_sel + 4);
		if (j < vinc->vipp_sel)
			j = vinc->vipp_sel;
		csic_dma_int_get_status(j, &status);
		if (status.frame_done || status.buf_0_overflow || ...)
			break;
	}
	vinc->vir_prosess_ch = j + 1;
	if (vinc->vir_prosess_ch >= vinc->vipp_sel + 4)
		vinc->vir_prosess_ch = vinc->vipp_sel;

	vinc = vin_core_gbl[j];
	cap = &vinc->vid_cap;
}
```

这段代码说明 offline DMA/VIN 处理方式也是 “同一个 logical group 内的 4 个虚拟 channel 轮询”。当某个虚拟 channel 出现 frame done 后，ISR 切换到对应 `vin_core_gbl[j]`，再处理这个 channel 的 buffer 完成和下一帧地址。

这与前面的 ISP/VIPP slot 模型完全一致。

## 9. 为什么这不是简单的“物理硬连线”证明

源码中确实存在固定的 group 和寄存器选择关系，但它不像是在表达 “ISP00 到 VIPP00/VIPP10/VIPP20/VIPP30 有四条永久物理直连线”。

原因有三点：

1. ISP/VIPP/DMA 都有明确的虚拟 channel 映射数组。

   `isp_virtual_find_ch[]`、`vipp_virtual_find_ch[]`、`dma_virtual_find_ch[]` 都把低两位解释为 `0~3` 的 slot。

2. VIPP 的官方组合刚好等于源码中的同 slot 集合。

   `VIPP00/VIPP10/VIPP20/VIPP30` 在源码 ID 上是 `0/4/8/12`，这些 ID 的 `vipp_virtual_find_ch[]` 全部是 `0`。

   `VIPP01/VIPP11/VIPP21/VIPP31` 在源码 ID 上是 `1/5/9/13`，这些 ID 的 `vipp_virtual_find_ch[]` 全部是 `1`。

3. media link 不是物理直连线证明。

   `vin.c` 里会创建 ISP 到 scaler 的 media link，而且看起来是多个 ISP 与多个 scaler 的组合。但这些 link 更像 Linux media graph 的软件拓扑/可选连接关系。实际 stream-on 时仍要通过 CSIC TOP、ISP/VIPP virtual channel、DMA virtual channel 的寄存器配置来落到具体 slot。

所以，“固定连接”更准确的读法是：

> 在 offline/TDM 分时体系中，某个 ISP virtual slot 只能与相同编号的 VIPP virtual slot 对齐工作。

它约束的是 slot 相位，不是任意物理连线。

## 10. 整体 pipeline 的分时复用模型

结合源码，可以把 V853 offline/TDM pipeline 概括为：

1. 多路 RAW 进入 TDM RX0~RX3。

   TDM 根据 `rx_chn_mode`、`tx_chn_mode`、blank、data rate 等配置，把多路输入组织成硬件分时输出。

2. TDM TX 把当前分时 slot 的 RAW 送入逻辑 ISP。

   `csic_isp_input_select()` 用 `isp_sel % ISP_VIRT_NUM` 表达 ISP virtual slot。

3. ISP 在 `PARA_LOAD_PD` / `PARA_SAVE_PD` 边界切换参数上下文。

   ISP600 ISR 会把对应虚拟 ISP 的 `load_shadow` 装载到 DDR load buffer，再设置 `PARA_READY`。

4. VIPP 在 `CHN0~3_REG_LOAD_PD` 边界切换参数上下文。

   VIPP ISR 根据 channel0~3 分别装载对应虚拟 VIPP 的 `vipp_reg`。

5. DMA/VIN offline ISR 按 4 个虚拟 channel 轮询处理 frame done 和 buffer。

   `vin_isr()` 在 offline 模式下通过 `vir_prosess_ch` 在同 logical group 的 4 个虚拟通道中轮询。

因此，官方文档中的固定连接可以整理成一句更贴近源码的话：

> `ISP0.slotN` 固定对应 `VIPPx.slotN`，其中 `N = 0..3`，`x = 0..3`。这是 offline/TDM 分时复用体系里的 slot 相位约束。

对应到官方命名就是：

```text
ISP00 -> VIPP00 / VIPP10 / VIPP20 / VIPP30
ISP01 -> VIPP01 / VIPP11 / VIPP21 / VIPP31
ISP02 -> VIPP02 / VIPP12 / VIPP22 / VIPP32
ISP03 -> VIPP03 / VIPP13 / VIPP23 / VIPP33
```

这比“芯片里有四条独立永久物理直连线”的解释更符合 SDK 里的虚拟 ISP、虚拟 VIPP、虚拟 DMA 和 TDM offline 分时处理代码。

