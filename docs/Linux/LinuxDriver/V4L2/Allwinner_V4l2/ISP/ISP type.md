# V853 ISP virtualization and bypass analysis
_Exported on 2026/4/15 at GMT+8 14:18:11 from Cursor (2.6.21)_

---

**User**

请你根据VIN源码lichee/linux-4.9/drivers/media/platform/sunxi-vin和ISP源码lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp+设备树@sun8iw21p1.dtsi (1404-1446) 详细分析一下
已知官方文档信息：
V853只有一个物理ISP，但是被分时复用为4个虚拟ISP，可以处理4路RAW流，ISP10为bypass节点，用于直通RAW->VIPP
结合已有信息与源码分析一下：
1、在offline模式分时复用下，一个物理ISP怎么被分时复用分成4个虚拟ISP的？每个ISP虚拟节点的配置是怎么被分时管理的？
2、ISP10作为bypass节点，是怎么处理数据的？

---

**Cursor**

下面我基于你给的三个信息源一起分析：

- `VIN` 源码：`lichee/linux-4.9/drivers/media/platform/sunxi-vin`
- `ISP` 源码：`lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp`
- 设备树：`sun8iw21p1.dtsi` 1404-1446
- 已知前提：V853 只有 1 个物理 ISP，被分时复用成 4 个虚拟 ISP；`isp10` 是 bypass 节点，用于 `RAW -> VIPP`

先给结论，再展开。

---

## 总结结论

### 1）offline 分时复用下，一个物理 ISP 是怎么分成 4 个“虚拟 ISP”的？

**本质上并不是硬件里真有 4 个 ISP 核，而是：**

- 设备树和驱动把它**抽象成 4 个逻辑 ISP 节点**：`isp00~isp03`
- 其中只有 `isp00` 对应真正的物理寄存器和中断
- `isp01~isp03` 的 `reg/work_mode=0xff` 只是作为**虚拟上下文/逻辑通道**
- 这 4 个逻辑节点共享同一个物理 ISP，通过：
  1. 顶层路由把不同 RAW 流送到 ISP 的不同 virtual input；
  2. 每个虚拟 ISP 各自维护一套 `load/save/stat` 参数/状态内存；
  3. 物理 ISP 在帧边界/参数加载点上，从对应虚拟上下文加载配置，再处理对应 RAW 流；
  4. 处理结果再路由到对应的 VIPP

也就是说，**“4 个虚拟 ISP” = 1 个物理 ISP 核 + 4 份逻辑配置上下文 + 4 路输入/输出路由编号 + 帧级时分调度**。

---

### 2）每个虚拟 ISP 节点的配置是怎么被分时管理的？

驱动层能看到两个关键事实：

- 每个 `isp@N` 都会各自 probe 成一个 `struct isp_dev`
- 每个 `isp_dev` 都会分配自己独立的：
  - `isp_load`
  - `isp_save`
  - `isp_stat`
  - 对于 ISP600/V853，还包括 `isp_save_load`、`load_para[2]` 等

所以**配置不是存在一个全局上下文里轮流覆盖**，而是**每个虚拟 ISP 都有自己独立的一份参数内存镜像**。  
物理 ISP 真正工作时，是通过参数加载机制，把当前被调度的那一路虚拟 ISP 的配置送进硬件。

换句话说：

- `isp00~isp03` 在软件上是 4 个 `isp_dev`
- 每个 `isp_dev` 各自保存自己的算法参数、寄存器 shadow、统计缓冲区
- 硬件只执行 1 个 ISP pipeline，但输入路由上有 4 个 virtual input 号，输出也能对应到不同后级
- 在 offline 模式下，RAW 先缓存/排队，再按时隙送入这个 ISP 物理核处理

---

### 3）`isp10` bypass 节点怎么处理数据？

`isp10` 不是第 5 个真正参与 RAW ISP 算法处理的虚拟 ISP。  
它是一个**不经过 ISP 算法链路、只做拓扑占位/路由选择的 bypass 节点**，作用就是：

- 接收 RAW 数据通路
- 不进入真正的 ISP 图像处理流水
- 直接把 RAW 输出到 VIPP/后级 DMA

所以它的用途就是文档说的：**RAW 直通到 VIPP**。

从源码上也能看出它和 `isp00~isp03` 明显不同：

- 设备树里 `isp10` 没有 `reg`
- 没有 `interrupts`
- 没有 `work_mode`
- 这说明它**不是一个真实可运行的 ISP 核实例**，而是一个逻辑节点/旁路节点

---

---

## 一、先看设备树：4 个虚拟 ISP + 1 个 bypass ISP

设备树这一段非常关键：

```1404:1446:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/arch/arm/boot/dts/sun8iw21p1.dtsi
			isp00:isp@0 {
				compatible = "allwinner,sunxi-isp";
				reg = <0x0 0x05900000 0x0 0x1300>,
					<0x0 0x03000000 0x0 0x10>;
				interrupts = <GIC_SPI 108 IRQ_TYPE_LEVEL_HIGH>;
				work_mode = <0>;
				device_id = <0>;
				iommus = <&mmu_aw 4 1>;
				status = "okay";
			};
			isp01:isp@1 {
				compatible = "allwinner,sunxi-isp";
				reg = <0x0 0x058ffffc 0x0 0x1304>;
				interrupts = <GIC_SPI 109 IRQ_TYPE_LEVEL_HIGH>;
				work_mode = <0xff>;
				device_id = <1>;
				iommus = <&mmu_aw 4 1>;
				status = "okay";
			};
			isp02:isp@2 {
				compatible = "allwinner,sunxi-isp";
				reg = <0x0 0x058ffff8 0x0 0x1308>;
				interrupts = <GIC_SPI 110 IRQ_TYPE_LEVEL_HIGH>;
				work_mode = <0xff>;
				device_id = <2>;
				iommus = <&mmu_aw 4 1>;
				status = "okay";
			};
			isp03:isp@3 {
				compatible = "allwinner,sunxi-isp";
				reg = <0x0 0x058ffff4 0x0 0x130c>;
				interrupts = <GIC_SPI 111 IRQ_TYPE_LEVEL_HIGH>;
				work_mode = <0xff>;
				device_id = <3>;
				iommus = <&mmu_aw 4 1>;
				status = "okay";
			};
			isp10:isp@4 {
				compatible = "allwinner,sunxi-isp";
				device_id = <4>;
				iommus = <&mmu_aw 4 1>;
				status = "okay";
			};
```

### 这里能读出几个强信号

#### 1. `isp00~isp03` 是一组
- `device_id = 0~3`
- `isp00.work_mode = 0`
- `isp01~03.work_mode = 0xff`

这非常像：
- `isp00` 是**逻辑主节点 / 物理对应节点**
- `isp01~03` 是**跟随这个逻辑主节点的虚拟实例**

#### 2. `isp01~03` 的 `reg` 很可疑
它们地址是：

- `0x058ffffc`
- `0x058ffff8`
- `0x058ffff4`

这不是正常独立模块寄存器块的排布，更像是：
- 为了让 platform driver 能 probe 多个节点
- 人工给的占位寄存器地址
- 真正有效的物理 ISP 寄存器还是 `isp00` 的 `0x05900000`

#### 3. `isp10` 完全不一样
`isp10` 只有：

- compatible
- device_id
- iommu
- status

**没有 reg / interrupt / work_mode**

这说明它本身不是一个真正跑 ISP 算法中断流程的硬件实体，更像一个**逻辑 bypass 端点**。

---

## 二、V853 平台确实只有 1 组物理 ISP 资源

平台配置里，V853 定义了：

```40:49:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/platform/sun8iw21p1_vin_cfg.h
#define VIN_MAX_DEV			16
#define VIN_MAX_CSI			3
#define VIN_MAX_CCI			3
#define VIN_MAX_TDM			1
#define VIN_MAX_MIPI			2
#define VIN_MAX_ISP			5
#define VIN_MAX_SCALER			16

#define MAX_CH_NUM			4
```

这里有两个重点：

- `VIN_MAX_ISP = 5`：也就是软件层面有 5 个 ISP 节点（4 个虚拟 + 1 个 bypass）
- `MAX_CH_NUM = 4`：说明 ISP 的虚拟处理通道数就是 4

而物理 ISP 基地址只有一个：

```1:18:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/platform/sun8iw21p1_vin_cfg.h
#define ISP_REGS_BASE				0x05900000
```

所以从平台定义看得很清楚：

- **物理 ISP 寄存器块只有一套**
- **软件允许 5 个 ISP 实例号**
- 其中 4 个是虚拟处理上下文，1 个是 bypass

---

## 三、虚拟 ISP 是怎么在驱动里“成立”的？

### 1. 每个 `isp@N` 都会被 probe 成一个 `struct isp_dev`

`isp_probe()` 里直接按 `device_id` 创建实例：

```3000:3073:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
{
	struct device_node *np = pdev->dev.of_node;
	struct isp_dev *isp = NULL;
	__maybe_unused struct isp_dev *logic_isp = NULL;
	__maybe_unused char name[16];
	int ret = 0;

	...
	of_property_read_u32(np, "device_id", &pdev->id);
	...
	isp->id = pdev->id;
	isp->pdev = pdev;
	...
#if defined ISP_600
	of_property_read_u32(np, "work_mode", &isp->work_mode);
	...
		if (isp->id == isp_virtual_find_logic[isp->id]) {
			isp->work_mode = clamp_t(unsigned int, isp->work_mode, ISP_ONLINE, ISP_OFFLINE);
		} else if (isp->work_mode == 0xff) {
			logic_isp = glb_isp[isp_virtual_find_logic[isp->id]];
			if (logic_isp->work_mode == ISP_ONLINE) {
				vin_log(VIN_LOG_VIDEO, "isp%d work in online mode, isp%d cannot to work!\n", logic_isp->id, isp->id);
				isp->is_empty = 1;
				goto init;
			}
		}
	}
#endif
```

这里说明：

- 驱动明确区分了：
  - **logic isp**（逻辑主 ISP）
  - **virtual isp**（虚拟 ISP）
- `isp_virtual_find_logic[]` 是“虚拟 ISP -> 所属逻辑物理 ISP”的映射表
- 如果逻辑 ISP 工作在 `ONLINE`，那么它的虚拟 ISP 就不能启用  
  这正是“同一物理 ISP 不能同时做在线直通和离线分时复用”的软件约束

---

### 2. 每个虚拟 ISP 都有自己独立的上下文内存

`struct isp_dev` 本身就带了大量 per-instance 资源：

```82:122:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.h
struct isp_dev {
	...
	struct vin_mm isp_stat;
	struct vin_mm isp_load;
	struct vin_mm isp_save;
	...
#if defined ISP_600
	struct vin_mm isp_save_load;
	struct vin_mm load_para[2];
	...
	unsigned int logic_top_stream_count;
	unsigned int work_mode;
	...
	bool load_select;
	...
#endif
	...
	unsigned char id;
	...
	char load_flag;
	...
	char load_shadow[ISP_LOAD_DRAM_SIZE];
	...
};
```

这意味着每个虚拟 ISP 实例都保存了自己的：

- 统计缓冲区 `isp_stat`
- 配置加载区 `isp_load`
- 保存区 `isp_save`
- ISP600 还额外有 `isp_save_load`、双缓冲 `load_para[2]`
- `load_shadow` 软件镜像

**这就是“每个虚拟 ISP 的配置怎么被分时管理”的核心：**
> 不是 4 路共用一份配置，而是 4 路各有自己的参数上下文；物理 ISP 在轮到哪一路时，就装载那一路的参数。

---

### 3. probe 时每个虚拟 ISP 都会做自己的资源分配

`isp_probe()` 后面继续：

```3073:3129:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
	isp->base = of_iomap(np, 0);
	if (!isp->base) {
		isp->is_empty = 1;
	} else {
		...
		if (isp_resource_alloc(isp) < 0) {
			ret = -ENOMEM;
			goto freeirq;
		}
		bsp_isp_map_reg_addr(isp->id, (unsigned long)isp->base);
		bsp_isp_map_load_dram_addr(isp->id, (unsigned long)isp->isp_load.vir_addr);
#if defined ISP_600
		bsp_isp_map_save_load_dram_addr(isp->id, (unsigned long)isp->isp_save_load.vir_addr);
		if (isp->id == 0) {
			isp->syscfg_base = of_iomap(np, 1);
			...
		}
#endif
	}
```

这里说明：

- 每个 `isp->id` 都会被登记一套：
  - reg 映射
  - load buffer 映射
  - save/load buffer 映射
- 即便底层物理只 1 套，驱动也按 `id` 维护独立软件视图

这就是“虚拟 ISP 节点”的软件实体化。

---

## 四、offline 分时复用到底怎么做？

### 1. 顶层路由不是直接选“唯一 ISP”，而是选“物理 ISP + virtual input号”

VIN 建链时，有一句最关键：

```271:271:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
				csic_isp_input_select(vind->id, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_sel%ISP_VIRT_NUM + 0, vinc->csi_sel, vinc->csi_ch & 0xf);
```

这句非常重要：

- `vinc->isp_sel / ISP_VIRT_NUM`：选**物理 ISP 组**
- `vinc->isp_sel % ISP_VIRT_NUM`：选这个物理 ISP 下的**第几个虚拟输入**

这已经直接证明：

> 驱动的模型不是 “有 4 个独立 ISP”，而是 “1 个物理 ISP，下面有 4 个 virtual input/context slot”。

也就是说，`isp_sel` 编码里本身就包含：
- 物理 ISP 号
- 虚拟 ISP 号

---

### 2. ISP 输出到 VIPP 也按“物理 ISP + channel”路由

对应还有：

```273:273:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin.c
		csic_vipp_input_select(vind->id, vinc->vipp_sel/VIPP_VIRT_NUM, vinc->isp_sel/ISP_VIRT_NUM, vinc->isp_tx_ch);
```

说明 VIPP 取数时也不是简单“连某个 ISP 节点名”，而是：

- 先选物理 VIPP 组
- 再选来自哪个物理 ISP
- 再选 ISP 的哪个输出通道 `isp_tx_ch`

所以拓扑上，虚拟 ISP 更像是**逻辑上下文号 / 输入槽位号**，而不是完整复制的一套 ISP 硬件。

---

### 3. `csic_isp_input_select()` 本身就是“物理 ISP + 输入口”的编程接口

`top_reg.c`：

```230:238:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/top_reg.c
void csic_isp_input_select(unsigned int sel, unsigned int isp, unsigned int in,
				unsigned int psr, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_ISP0_IN0_REG_OFF + isp * 16 + in * 4,
			isp_input[isp][in][psr][ch]);
}

void csic_vipp_input_select(unsigned int sel, unsigned int vipp,
				unsigned int isp, unsigned int ch)
{
	vin_reg_writel(csic_top_base[sel] + CSIC_VIPP0_IN_REG_OFF + vipp * 4,
			vipp_input[vipp][isp][ch]);
}
```

这里 `isp, in` 两级含义特别清晰：

- `isp`：物理 ISP 编号
- `in`：该 ISP 的第几个输入口（也就是 virtual input）

这正好和前面 `vinc->isp_sel / ISP_VIRT_NUM`、`% ISP_VIRT_NUM` 对上。

---

## 五、每个虚拟 ISP 配置是如何“分时管理”的？

这部分我拆成“软件上下文”和“硬件切换点”两层。

---

### A. 软件上下文：每路虚拟 ISP 各有自己参数区

从 `struct isp_dev` 和 `isp_resource_alloc()` 可以确定：每个 `isp_dev` 都会分配自己的 load/save/stat 区。

这表示每路 RAW 对应的 ISP 参数，例如：

- 曝光统计相关状态
- AWB/AE/AF 统计区
- 3DNR/WDR 等模块参数
- LUT / load shadow / save state

都不是共享一个结构，而是**按虚拟 ISP 分开存放**。

因此：

- 路 0 RAW 用 `isp00` 的参数上下文
- 路 1 RAW 用 `isp01` 的参数上下文
- 路 2 RAW 用 `isp02` 的参数上下文
- 路 3 RAW 用 `isp03` 的参数上下文

---

### B. 硬件切换点：在帧边界/参数加载中断时切换

ISP ISR 里有典型的参数加载流程：

```2524:2556:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
	if (bsp_isp_get_irq_status(isp->id, PARA_LOAD_PD)) {
		bsp_isp_clr_irq_status(isp->id, PARA_LOAD_PD);
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

含义是：

- 到了 `PARA_LOAD_PD` 这个时刻，驱动把当前上下文的 load 参数送到硬件
- 然后更新 ISP table/module 状态
- 再让 ISP 按这套参数处理后续帧

如果你把 `isp->id` 理解成“当前 virtual ISP context 编号”，那逻辑就通了：

> 分时调度的本质，就是在每一帧/每次参数装载点，装入某一路虚拟 ISP 的参数上下文，让物理 ISP 用这套上下文工作。

---

### C. offline 为什么能分时，online 为什么不行？

`isp_probe()` 已经直接写了限制：

```3030:3039:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
		if (isp->id == isp_virtual_find_logic[isp->id]) {
			isp->work_mode = clamp_t(unsigned int, isp->work_mode, ISP_ONLINE, ISP_OFFLINE);
		} else if (isp->work_mode == 0xff) {
			logic_isp = glb_isp[isp_virtual_find_logic[isp->id]];
			if (logic_isp->work_mode == ISP_ONLINE) {
				vin_log(VIN_LOG_VIDEO, "isp%d work in online mode, isp%d cannot to work!\n", logic_isp->id, isp->id);
				isp->is_empty = 1;
				goto init;
			}
		}
```

意思是：

- 如果逻辑主 ISP 是 `ONLINE`
- 那么同组的虚拟 ISP 节点都不能真正工作

原因很简单：

- `ONLINE`：数据是实时直通，物理 ISP 被单一路流持续占用，没法在帧间插别的流
- `OFFLINE`：RAW 已经落到内存/TDM 缓冲，可以一帧一帧轮流喂给 ISP

所以**虚拟 ISP 分时复用只对 offline 成立**。

---

## 六、VIPP 也是同样的“虚拟化”配套设计

scaler/VIPP 的 probe 几乎是同一套路：

```920:952:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/sunxi_scaler.c
#if defined VIPP_200
	of_property_read_u32(np, "work_mode", &scaler->work_mode);
	...
		if (scaler->id == vipp_virtual_find_logic[scaler->id]) {
			scaler->work_mode = clamp_t(unsigned int, scaler->work_mode, VIPP_ONLINE, VIPP_OFFLINE);
		} else if (scaler->work_mode == 0xff) {
			logic_scaler = glb_vipp[vipp_virtual_find_logic[scaler->id]];
			if (logic_scaler->work_mode == VIPP_ONLINE) {
				vin_log(VIN_LOG_VIDEO, "scaler%d work in online mode, scaler%d cannot to work!\n", logic_scaler->id, scaler->id);
				...
				scaler->noneed_register = 1;
				return 0;
			}
		}
	}
#endif
```

这说明：

- 不仅 ISP 被做成“1 物理 + 多虚拟上下文”
- VIPP 也是同样的抽象
- 所以整个链路是：
  - 多路 RAW offline 缓冲
  - 轮流进入 1 个物理 ISP 的 4 个虚拟上下文
  - 再进入相应 VIPP 虚拟后级

这和官方“一个物理 ISP 分时成 4 个虚拟 ISP，可处理 4 路 RAW”完全一致。

---

## 七、`isp10` 为什么判断它是 bypass 节点？

### 1. 设备树上它没有物理资源
前面提过，`isp10` 没有：

- `reg`
- `interrupts`
- `work_mode`

这意味着它不是正常的 ISP 运算节点。

---

### 2. `isp_probe()` 对没有 `reg` 的节点会变成 empty node

`isp_probe()`：

```3070:3080:/home/ubuntu/v851s/tina-v853-100ask/lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-isp/sunxi_isp.c
	isp->base = of_iomap(np, 0);
	if (!isp->base) {
		isp->is_empty = 1;
	} else {
		isp->is_empty = 0;
		/*get irq resource */
		isp->irq = irq_of_parse_and_map(np, 0);
		...
	}
```

`isp10` 没有 `reg`，所以 `of_iomap(np, 0)` 拿不到真正寄存器，最终只能成为：

- 有一个 `isp_dev`
- 但 `is_empty = 1`
- 没有真实 ISR/硬件寄存器映射

这恰好符合“bypass 逻辑节点”的特征：**参与媒体图拓扑与链路选择，但不承担真正 ISP 运算。**

---

### 3. 它的作用是给 RAW 直通 VIPP 提供一个“ISP 类型的占位节点”
因为整个 VIN graph 里，很多路径默认是：

- sensor / csi / tdm
- -> isp
- -> scaler(vipp)
- -> capture

如果某一路想**不做 ISP 图像处理，只把 RAW 交给 VIPP / DMA 后级**，软件图上仍然需要一个“ISP 位置”的节点来保持媒体拓扑统一。  
这时 `isp10` 就充当这个 bypass 节点。

所以 `isp10` 的语义不是：
- “第五个虚拟 ISP”

而是：
- “RAW bypass ISP node”
- “不走 ISP 算法，只走 ISP 位置的直通路径”

---

## 八、`isp10` 的数据流到底怎么走？

结合文档语义“RAW->VIPP”，可以把它理解为：

### 正常 ISP 路径
`RAW -> 物理ISP算法处理 -> ISP输出 -> VIPP -> DMA`

### bypass 路径
`RAW -> bypass节点(isp10) -> VIPP -> DMA`

这里 bypass 节点本身不做：

- demosaic
- AE/AWB/AF 统计
- 3DNR
- WDR
- color pipeline

而只是完成**图结构上的连接与路由选择**。

---

## 九、为什么 `isp10` 还能叫 ISP？

因为在 VIN 媒体框架里，很多地方是按“pipeline 里有 ISP pad / subdev”来组织的。  
做一个 `compatible = "allwinner,sunxi-isp"` 的 `isp10`，有几个好处：

1. 能复用同一套媒体图/连接逻辑
2. 用户空间看到的 graph 更统一
3. 部分控制流程不需要为“无 ISP”单独开一条完全不同的代码路径
4. 通过 `is_empty`/无 reg/无 irq 实现“逻辑上是 ISP，物理上是 bypass”

这是一种典型的驱动抽象手法。

---

## 十、回答你的两个问题

---

## 问题1：offline 模式分时复用下，一个物理 ISP 怎么被分成 4 个虚拟 ISP？每个 ISP 虚拟节点的配置怎么被分时管理？

### 我的结论

### ① 硬件层
V853 只有一个物理 ISP 核，但这个 ISP 支持 **4 个 virtual input / context slot**。  
VIN 顶层路由在配置时不是简单选 ISP，而是：

- 选物理 ISP 编号
- 再选这个 ISP 的第几个 virtual input

这一点在 `csic_isp_input_select()` 的调用方式已经证明了。

---

### ② 设备树层
设备树把它抽象成：

- `isp00`：逻辑主/物理对应节点
- `isp01~isp03`：同一物理 ISP 下的 3 个虚拟节点

`work_mode=0xff` 代表这些节点不是独立物理 ISP，而是从属于逻辑主 ISP 的虚拟实例。

---

### ③ 驱动层
每个虚拟 ISP 节点都会 probe 成一个独立的 `struct isp_dev`，并各自拥有：

- `isp_load`
- `isp_save`
- `isp_stat`
- `load_shadow`
- `load_para[]`（ISP600）

所以每一路虚拟 ISP 都维护自己独立的算法参数和状态缓存。

---

### ④ 分时管理方式
offline 下，多路 RAW 先落内存/缓冲；调度时按帧轮流送入物理 ISP。  
在每帧参数装载点（如 `PARA_LOAD_PD`）：

- 把当前虚拟 ISP 的 `load_shadow/load` 参数送入 ISP
- ISP 用这一路上下文处理当前 RAW
- 完成后再切下一个虚拟 ISP 上下文

所以“分成 4 个虚拟 ISP”的本质是：

> **1 个物理 ISP + 4 份独立的软件参数上下文 + 4 个 virtual input 路由号 + 帧级时分调度**

并不是 4 个硬件 ISP 同时并行。

---

## 问题2：`ISP10` 作为 bypass 节点，是怎么处理数据的？

### 我的结论

`isp10` 本身不是能运行 ISP 算法的真实 ISP 实例，它是一个**逻辑 bypass 节点**。

它的特征是：

- 设备树无 `reg`
- 无 `interrupts`
- 无 `work_mode`
- probe 后不会形成真正的可运算 ISP 硬件实例

它的作用是：

- 在媒体图中占据 ISP 这个位置
- 让 RAW 数据可以通过“ISP旁路路径”直接送到 VIPP
- 实现官方说的 `RAW -> VIPP` bypass

也就是：

> `isp10` 不处理图像算法，只做路径直通/路由占位。

因此它适用于：

- 不需要 ISP 算法，只想保留 RAW
- 或某些特殊直通场景，让 VIPP/后级直接消费 RAW

---

## 最后给一句最浓缩的判断

### 对 V853 来说：

- `isp00~isp03`：**一个物理 ISP 的 4 个虚拟上下文**
- `isp10`：**不参与 ISP 算法的 RAW bypass 节点**

### offline 分时复用的本质：

- 多路 RAW 不是同时在 4 个 ISP 上处理
- 而是**在同一个物理 ISP 上，按帧轮流加载 4 路各自的参数上下文进行处理**

### `isp10` 的本质：

- 不是“第五个 ISP”
- 是“ISP 位置上的 bypass 通道”

---

如果你愿意，我下一步可以继续帮你做两件更深入的事之一：

1. **把 V853 上 `isp_sel / vipp_sel / isp_tx_ch` 的编号关系彻底展开**，画成一张“虚拟 ISP / 虚拟 VIPP / 物理 ISP”的映射表。  
2. **继续沿着 `vin_tdm.c + vin_core.c + media link` 追 offline RAW 的完整数据路径**，把“RAW 从 CSI/TDM 落地，到 ISP 分时处理，再到 VIPP 输出”的完整调用链梳理出来。

