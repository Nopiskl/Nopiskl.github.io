# Freescale Ethernet driver analysis
_Exported on 2026/3/26 at GMT+8 11:37:34 from Cursor (2.6.21)_

---

**User**

@drivers/net/ethernet/freescale 分析一下这个驱动

---

**Cursor**

Now I have enough context to provide a comprehensive analysis. Let me also quickly read the header file and the PTP file for completeness.

我已经读取了足够多的代码，可以给出完整分析了。以下是对 `drivers/net/ethernet/freescale` 目录下 FEC 驱动的详细分析：

---

## Freescale FEC 以太网驱动分析

### 一、目录结构概览

```
drivers/net/ethernet/freescale/
├── fec.h              # FEC 寄存器定义 + 私有数据结构声明
├── fec_main.c         # FEC 主驱动（核心文件，4076行）
├── fec_ptp.c          # PTP 硬件时间戳支持
├── fec_mpc52xx.c/h    # MPC52xx 平台专用实现
├── fec_mpc52xx_phy.c  # MPC52xx PHY 支持
├── gianfar.c/h        # Gianfar（eTSEC）控制器驱动
├── gianfar_ethtool.c  # Gianfar ethtool 接口
├── gianfar_ptp.c      # Gianfar PTP 支持
├── fsl_pq_mdio.c      # Freescale PowerQUICC MDIO 总线驱动
├── ucc_geth.c/h       # UCC Gigabit Ethernet（QE 子系统）
├── ucc_geth_ethtool.c # UCC ethtool 接口
├── xgmac_mdio.c       # 10G MAC MDIO 驱动
└── fs_enet/           # fs_enet 旧式驱动（MPC8xx/MPC82xx）
```

该目录包含多个独立以太网控制器驱动，核心是 **FEC（Fast Ethernet Controller）**，用于 i.MX 系列 ARM SoC。

---

### 二、FEC 驱动支持的平台

```c
static const struct of_device_id fec_dt_ids[] = {
    { .compatible = "fsl,imx25-fec",  ... },
    { .compatible = "fsl,imx27-fec",  ... },
    { .compatible = "fsl,imx28-fec",  ... },
    { .compatible = "fsl,imx6q-fec",  ... },
    { .compatible = "fsl,imx6sx-fec", ... },
    { .compatible = "fsl,imx6ul-fec", ... },
    ...
};
```

**目标平台**：i.MX25/27/28/6Q/6SX/6UL，本板（ALIENTEK 正点原子）使用的是 `imx6ul-fec`。

---

### 三、硬件特性标志（Quirks）

| 标志 | 含义 |
|---|---|
| `FEC_QUIRK_ENET_MAC` | 使用增强型 ENET MAC（vs 旧版 FEC） |
| `FEC_QUIRK_HAS_GBIT` | 支持千兆以太网 |
| `FEC_QUIRK_HAS_BUFDESC_EX` | 扩展 Buffer Descriptor（含时间戳字段） |
| `FEC_QUIRK_HAS_CSUM` | 硬件 TCP/UDP/IP 校验和卸载 |
| `FEC_QUIRK_HAS_VLAN` | 硬件 VLAN 支持 |
| `FEC_QUIRK_HAS_AVB` | 音视频桥接（IEEE 802.1Qav，多队列 QoS） |
| `FEC_QUIRK_SWAP_FRAME` | 帧字节序交换（i.MX28） |
| `FEC_QUIRK_ERR006358` | 硬件 errata 规避 |

`imx6ul-fec` 的配置：
```c
.driver_data = FEC_QUIRK_ENET_MAC | FEC_QUIRK_HAS_GBIT |
               FEC_QUIRK_HAS_BUFDESC_EX | FEC_QUIRK_HAS_CSUM |
               FEC_QUIRK_HAS_VLAN,
```

---

### 四、核心数据结构

**Buffer Descriptor（BD）环形队列**：
- 驱动使用 DMA 环形描述符链表管理收发包
- 每个 BD 包含：`cbd_sc`（状态控制）、`cbd_bufaddr`（DMA 地址）、`cbd_datlen`（数据长度）
- 扩展 BD（`bufdesc_ex`）额外包含 PTP 时间戳字段

**私有数据结构** `fec_enet_private`（定义在 `fec.h`）：
- `tx_queue[FEC_ENET_MAX_TX_QS]`：最多 3 个发送队列
- `rx_queue[FEC_ENET_MAX_RX_QS]`：最多 3 个接收队列
- `phy_dev`：PHY 设备指针
- `hwp`：硬件寄存器基地址（ioremap 后）
- `bufdesc_ex`：是否使用扩展 BD

---

### 五、发送路径（TX Path）

```
ndo_start_xmit()
    └── fec_enet_start_xmit()
            ├── skb_is_gso() → fec_enet_txq_submit_tso()   // TSO 大包分段
            └── else         → fec_enet_txq_submit_skb()   // 普通单包发送
                    ├── fec_enet_clear_csum()               // 硬件校验和清零
                    ├── fec_enet_txq_submit_frag_skb()      // 处理 SG 分散聚合
                    ├── dma_map_single()                    // 映射 DMA
                    └── writel(FEC_X_DES_ACTIVE)            // 触发硬件发送
```

**关键细节**：
- 支持 **TSO（TCP Segmentation Offload）**，最多 100 个 TCP 分段
- 支持 **Scatter-Gather**（`skb_shinfo->nr_frags`）
- 对齐问题：若 buffer 地址未对齐，则先 `memcpy` 到 bounce buffer
- 发送完成后通过 `dirty_tx` / `cur_tx` 指针维护 BD 环状态

---

### 六、接收路径（RX Path）

```
中断触发
    └── fec_enet_interrupt()
            └── napi_schedule() / tasklet
                    └── fec_enet_rx_queue()
                            ├── 检查 BD 状态（BD_ENET_RX_EMPTY）
                            ├── dma_unmap_single()
                            ├── skb_put() + netif_receive_skb()
                            └── 重新分配 skb，填充新 BD
```

**关键细节**：
- 使用 NAPI 机制，减少中断频率，提高吞吐量
- 支持 **RX 硬件校验和验证**（`FEC_RACC_IPDIS | FEC_RACC_PRODIS`）
- 支持 copybreak 优化（小于 256 字节直接 copy，避免 DMA 开销）

---

### 七、控制器初始化流程（`fec_restart`）

```
fec_restart()
    ├── 复位 MAC（写 FEC_ECNTRL）
    ├── 恢复 MAC 地址（FEC_ADDR_LOW/HIGH）
    ├── 清中断（FEC_IEVENT）
    ├── fec_enet_bd_init()        // 初始化 TX/RX BD 环
    ├── fec_enet_enable_ring()    // 配置 DMA 描述符起始地址
    ├── 配置双工/MII速度
    ├── 配置 RX 控制寄存器（RGMII/RMII/MII，流控）
    ├── 配置 PHY 接口速率（1G/100M/10M）
    ├── set_multicast_list()      // 组播过滤
    ├── 使能 ECNTRL（启动 MAC）
    ├── fec_enet_active_rxring()  // 激活 RX DMA
    ├── fec_ptp_start_cyclecounter() // 启动 PTP 时钟
    └── 使能中断（FEC_IMASK）
```

---

### 八、PHY 管理

- 通过 MDIO 总线与 PHY 芯片通信，使用标准 Linux PHY 框架（`linux/phy.h`）
- 支持 `RGMII / RMII / MII` 三种接口模式
- PHY 连接/断开时触发 `fec_restart()` / `fec_stop()` 重新配置 MAC
- i.MX6UL 板卡：PHY 地址、接口模式从设备树（DTS）解析

---

### 九、高级特性

| 特性 | 实现文件 | 说明 |
|---|---|---|
| PTP 硬件时间戳 | `fec_ptp.c` | IEEE 1588，精确时钟同步 |
| 中断合并（NAPI） | `fec_main.c` | `FEC_TXIC0/RXIC0` 寄存器控制 |
| Wake-on-LAN | `fec_main.c` | Magic Packet 唤醒，`FEC_ECR_MAGICEN` |
| 电源管理 | `fec_main.c` | `pm_runtime`，停止模式通过 GPR 寄存器控制 |
| 多队列（AVB） | `fec_main.c` | 3 个 TX/RX 队列，VLAN 优先级映射 |
| ethtool 支持 | `fec_main.c` | 统计、自协商、时间戳配置 |

---

### 十、i.MX6UL 特殊处理

在 `fec_probe()` 中可以看到正点原子的定制修改：
```c
// 设置 MX6UL_PAD_ENET1_TX_CLK 和 MX6UL_PAD_ENET2_TX_CLK
// 这两个 IO 的复用寄存器的 SION 位为 1
void __iomem *IMX6U_ENET1_TX_CLK;
void __iomem *IMX6U_ENET2_TX_CLK;
```
这是 i.MX6UL **特有的 ENET 时钟回环问题**的修复——需要将 `ENET_TX_CLK` 的 `SION`（Software Input On）位置 1，使 TX 时钟能被内部逻辑采样到，否则 RMII 模式下网络不通。

---

### 总结

该驱动是一个完整的 **工业级以太网驱动**，覆盖：
- 多平台/多速率支持（10M/100M/1G）
- 硬件校验和卸载、TSO、Scatter-Gather
- PTP 精确时间同步
- NAPI 高性能收包
- 完整电源管理（睡眠/唤醒/Magic Packet WoL）
- 多发送队列（AVB QoS）

---

**User**

@drivers/net/ethernet/freescale/fec_main.c 分析一下probe流程

---

**Cursor**

现在再读取 `fec_enet_init` 和 `fec_enet_mii_init` 的实现，补全 probe 流程的关键子函数。

数据已经足够，下面给出完整的 `fec_probe` 流程分析：

---

## `fec_probe` 流程详细分析

`fec_probe` 是平台驱动的入口函数，由内核在匹配到设备树节点 `fsl,imx6ul-fec` 时自动调用。整个流程分为以下几个阶段：

---

### 阶段一：ENET 时钟 IO 修复（正点原子定制）

```3700:3710:drivers/net/ethernet/freescale/fec_main.c
	void __iomem *IMX6U_ENET1_TX_CLK;
	void __iomem *IMX6U_ENET2_TX_CLK;

	IMX6U_ENET1_TX_CLK = ioremap(0X020E00DC, 4);
	writel(0X14, IMX6U_ENET1_TX_CLK);

	IMX6U_ENET2_TX_CLK = ioremap(0X020E00FC, 4);
	writel(0X14, IMX6U_ENET2_TX_CLK);
```

- 直接操作 IOMUXC 寄存器，将 `ENET1_TX_CLK` / `ENET2_TX_CLK` pad 的 **SION 位置 1**
- 写入值 `0x14` = `0b10100`：ALT4 复用功能 + SION=1（软件输入使能）
- **原因**：i.MX6UL 的 RMII 模式下，TX_CLK 需要回环到内部才能正常工作，否则网络不通

---

### 阶段二：分配网络设备 + 基础结构初始化

```3712:3745:drivers/net/ethernet/freescale/fec_main.c
	fec_enet_get_queue_num(pdev, &num_tx_qs, &num_rx_qs);

	/* Init network device */
	ndev = alloc_etherdev_mqs(sizeof(struct fec_enet_private),
							  num_tx_qs, num_rx_qs);
	if (!ndev)
		return -ENOMEM;

	SET_NETDEV_DEV(ndev, &pdev->dev);

	/* setup board info structure */
	fep = netdev_priv(ndev);

	of_id = of_match_device(fec_dt_ids, &pdev->dev);
	if (of_id)
		pdev->id_entry = of_id->data;
	fep->quirks = pdev->id_entry->driver_data;
```

- `fec_enet_get_queue_num()`：从设备树解析 `fsl,num-tx-queues` / `fsl,num-rx-queues`，默认各 1 个
- `alloc_etherdev_mqs()`：分配 `net_device` + `fec_enet_private` 私有数据，支持多队列
- 读取 `of_device_id` 匹配到的 `driver_data` 作为 quirks 标志位（如 `FEC_QUIRK_HAS_GBIT` 等）

---

### 阶段三：寄存器映射 + 设备树属性解析

```3749:3790:drivers/net/ethernet/freescale/fec_main.c
	r = platform_get_resource(pdev, IORESOURCE_MEM, 0);
	fep->hwp = devm_ioremap_resource(&pdev->dev, r);
	if (IS_ERR(fep->hwp))
	{
		ret = PTR_ERR(fep->hwp);
		goto failed_ioremap;
	}

	fep->pdev = pdev;
	fep->dev_id = dev_id++;

	platform_set_drvdata(pdev, ndev);

	fec_enet_of_parse_stop_mode(pdev);

	if (of_get_property(np, "fsl,magic-packet", NULL))
		fep->wol_flag |= FEC_WOL_HAS_MAGIC_PACKET;

	phy_node = of_parse_phandle(np, "phy-handle", 0);
```

- `devm_ioremap_resource()`：将 FEC 寄存器物理地址映射到内核虚拟地址，存入 `fep->hwp`
- `fec_enet_of_parse_stop_mode()`：解析设备树 `stop-mode` 属性，获取 GPR 寄存器句柄（用于低功耗停止模式）
- 解析 `fsl,magic-packet`：是否支持 WoL（Wake-on-LAN）
- `of_parse_phandle(np, "phy-handle")`：从设备树获取 PHY 节点引用

---

### 阶段四：时钟获取与使能

```2016:2075:drivers/net/ethernet/freescale/fec_main.c
static int fec_enet_clk_enable(struct net_device *ndev, bool enable)
{
	struct fec_enet_private *fep = netdev_priv(ndev);
	int ret;

	if (enable)
	{
		ret = clk_prepare_enable(fep->clk_ahb);
		// ...
		ret = clk_prepare_enable(fep->clk_ipg);
		// ...
		if (fep->clk_enet_out)
			ret = clk_prepare_enable(fep->clk_enet_out);
		if (fep->clk_ptp)
			ret = clk_prepare_enable(fep->clk_ptp);
		if (fep->clk_ref)
			ret = clk_prepare_enable(fep->clk_ref);
	}
```

probe 中依次获取并使能以下时钟：

| 时钟名 | 用途 | 是否必须 |
|---|---|---|
| `ipg` | 寄存器访问总线时钟 | 必须 |
| `ahb` | AHB DMA 总线时钟 | 必须 |
| `enet_out` | 向外部 PHY 提供参考时钟 | 可选 |
| `ptp` | PTP 精确时间戳时钟 | 可选 |
| `enet_clk_ref` | RMII 参考时钟 | 可选 |

---

### 阶段五：PHY 复位

```3566:3600:drivers/net/ethernet/freescale/fec_main.c
static void fec_reset_phy(struct platform_device *pdev)
{
	int err, phy_reset;
	int msec = 1;
	struct device_node *np = pdev->dev.of_node;
	// ...
	phy_reset = of_get_named_gpio(np, "phy-reset-gpios", 0);
	// ...
	err = devm_gpio_request_one(&pdev->dev, phy_reset,
								GPIOF_OUT_INIT_LOW, "phy-reset");
	// ...
	msleep(msec);
	gpio_set_value(phy_reset, 1);
	msleep(200); /* 复位结束后至少再延时 150ms 才能继续操作 SR8201F */
}
```

- 从设备树读取 `phy-reset-gpios` 和 `phy-reset-duration`
- 拉低 GPIO → 延时 → 拉高，完成 PHY 硬件复位
- 正点原子额外增加了 **200ms 延时**，确保 SR8201F PHY 芯片稳定

---

### 阶段六：`fec_enet_init` — BD 环与网卡参数初始化

```3452:3530:drivers/net/ethernet/freescale/fec_main.c
static int fec_enet_init(struct net_device *ndev)
{
	// 设置对齐掩码（ARM: 16字节对齐）
	fep->rx_align = 0xf;
	fep->tx_align = 0xf;

	fec_enet_alloc_queue(ndev);   // 分配 TX/RX 队列结构

	// 分配 BD 环的 DMA 一致性内存
	cbd_base = dma_alloc_coherent(NULL, bd_size, &bd_dma, GFP_KERNEL);

	// 获取 MAC 地址（从设备树/OCOTP eFuse/随机生成）
	fec_get_mac(ndev);
	fec_set_mac_address(ndev, NULL);  // 写入硬件寄存器

	// 为每个 RX/TX 队列分配 BD 基地址
	for (i = 0; i < fep->num_rx_queues; i++) { ... }
	for (i = 0; i < fep->num_tx_queues; i++) { ... }

	// 注册 ndo_ops（start_xmit, open, stop 等）
	// 注册 ethtool_ops
	// 初始化 NAPI
	netif_napi_add(ndev, &fep->napi, fec_enet_rx_napi, NAPI_POLL_WEIGHT);
```

---

### 阶段七：`fec_enet_mii_init` — MDIO 总线初始化

```2181:2260:drivers/net/ethernet/freescale/fec_main.c
static int fec_enet_mii_init(struct platform_device *pdev)
{
	// 计算 MDC 时钟分频：目标 2.5MHz
	mii_speed = DIV_ROUND_UP(clk_get_rate(fep->clk_ipg), 5000000);
	holdtime = DIV_ROUND_UP(clk_get_rate(fep->clk_ipg), 100000000) - 1;
	fep->phy_speed = mii_speed << 1 | holdtime << 8;

	// 写入 FEC_MII_SPEED 寄存器
	writel(fep->phy_speed, fep->hwp + FEC_MII_SPEED);

	// 分配并注册 mii_bus
	fep->mii_bus = mdiobus_alloc();
	// ...
	mdiobus_register(fep->mii_bus);
```

- 计算 MDIO 时钟分频值，使 MDC ≤ 2.5MHz（IEEE 802.3 要求）
- 注册 `mii_bus`，供 PHY 驱动通过 MDIO 读写寄存器

---

### 阶段八：中断申请

```3820:3845:drivers/net/ethernet/freescale/fec_main.c
	for (i = 0; i < FEC_IRQ_NUM; i++)
	{
		irq = platform_get_irq(pdev, i);
		ret = devm_request_irq(&pdev->dev, irq, fec_enet_interrupt,
							   0, pdev->name, ndev);
		fep->irq[i] = irq;
	}

	ret = of_property_read_u32(np, "fsl,wakeup_irq", &irq);
	if (!ret && irq < FEC_IRQ_NUM)
		fep->wake_irq = fep->irq[irq];
```

- 从设备树获取中断号（最多 `FEC_IRQ_NUM` 个）
- 注册中断处理函数 `fec_enet_interrupt`
- 配置 WoL 唤醒中断

---

### 阶段九：注册网络设备

```3855:3875:drivers/net/ethernet/freescale/fec_main.c
	/* Carrier starts down, phylib will bring it up */
	netif_carrier_off(ndev);
	fec_enet_clk_enable(ndev, false);          // 关闭时钟（省电）
	pinctrl_pm_select_sleep_state(&pdev->dev); // 切换 pinctrl 到睡眠状态

	ret = register_netdev(ndev);               // 注册到内核网络子系统

	device_init_wakeup(&ndev->dev, fep->wol_flag & FEC_WOL_HAS_MAGIC_PACKET);

	fep->rx_copybreak = COPYBREAK_DEFAULT;     // 256 字节
	INIT_WORK(&fep->tx_timeout_work, fec_enet_timeout_work);
```

- `netif_carrier_off()`：初始时链路状态为 DOWN，等待 phylib 检测到 PHY 连接后再 UP
- `register_netdev()`：在内核中注册 `eth0`/`eth1`，此后 `ifconfig`/`ip` 命令可见
- 关闭时钟、切换引脚到睡眠状态（`open` 时再重新打开）

---

### 完整流程图

```
fec_probe()
├── [1] ioremap ENET TX_CLK IOMUXC，置 SION 位（i.MX6UL 修复）
├── [2] fec_enet_get_queue_num()      解析 TX/RX 队列数量
├── [3] alloc_etherdev_mqs()          分配 net_device + 私有数据
├── [4] of_match_device()             匹配 quirks 标志
├── [5] devm_ioremap_resource()       映射 FEC 寄存器基地址 → fep->hwp
├── [6] fec_enet_of_parse_stop_mode() 解析低功耗停止模式
├── [7] of_parse_phandle("phy-handle") 获取 PHY 节点
├── [8] of_get_phy_mode()             获取 PHY 接口模式（RMII/RGMII/MII）
├── [9] devm_clk_get() × 5            获取 ipg/ahb/enet_out/ptp/ref 时钟
├── [10] fec_enet_clk_enable(true)    使能所有时钟
├── [11] regulator_enable(phy)        使能 PHY 电源
├── [12] fec_reset_phy()              GPIO 复位 PHY 芯片
├── [13] fec_ptp_init()               初始化 PTP 时钟（若支持）
├── [14] fec_enet_init()              分配 BD 环 DMA 内存，注册 ndo/ethtool/NAPI
├── [15] devm_request_irq() × N      申请中断，注册 fec_enet_interrupt
├── [16] fec_enet_mii_init()          计算 MDC 分频，注册 MDIO 总线
├── [17] netif_carrier_off()          初始链路 DOWN
├── [18] fec_enet_clk_enable(false)   关闭时钟（open 

---

**User**

是否可以理解为，这个net驱动向上注册为一个完善的net device，向下创建MDIO总线用于挂载PHY芯片？当上层调用net device的ops的时候这个驱动通过MDIO控制phy收发信息？

---

**Cursor**

这个理解方向是对的，但有一个关键细节需要修正。让我先确认一下驱动中 PHY 连接和数据收发的具体实现：

现在有了完整的证据，可以给出精确的回答：

---

## 你的理解基本正确，但需要补充一个关键层次

你的描述可以这样精化：

```
应用层 (socket / ifconfig / ip)
        │
        ▼
  Linux 网络核心子系统
        │  net_device ops（ndo_start_xmit, ndo_open 等）
        ▼
  FEC 驱动（fec_main.c）         ← 你说的"这个驱动"
   ├── 向上：register_netdev()    注册为完整 net_device ✓
   ├── 向下：mdiobus_register()   注册 MDIO 总线 ✓
   │           │
   │           ▼
   │       PHY 驱动（phylib，内核通用）
   │           │  通过 MDIO 读写 PHY 寄存器（协商速率/双工）
   │           ▼
   │       PHY 芯片（SR8201F 等，硬件）
   │
   └── 数据面：DMA BD 环 ←→ FEC MAC 硬件 ←→ 网线
```

---

## 关键修正：数据收发不经过 MDIO

MDIO 和数据收发是**两条完全独立的通路**：

### MDIO 总线的职责（控制面）
- 仅用于读写 PHY 的**控制/状态寄存器**（速率、双工、自协商、链路状态等）
- 数据量极小，速率只有 2.5MHz
- 由 `fec_enet_mii_init()` 创建总线，`fec_enet_mii_probe()` 连接 PHY

```3133:3165:drivers/net/ethernet/freescale/fec_main.c
	/* Probe and connect to PHY when open the interface */
	ret = fec_enet_mii_probe(ndev);
	if (ret)
		goto err_enet_mii_probe;

	napi_enable(&fep->napi);
	phy_start(fep->phy_dev);         // 启动 PHY 状态机（自协商）
	netif_tx_start_all_queues(ndev); // 开启发送队列
```

### 数据收发的职责（数据面）
- 实际以太网帧通过 **FEC MAC ↔ MII/RMII 信号线 ↔ PHY 芯片** 直接传输
- FEC 硬件用 **DMA BD 环**（Buffer Descriptor Ring）直接 DMA 到内存，完全不经过 MDIO
- 速率可达 100Mbps / 1Gbps

```1889:1950:drivers/net/ethernet/freescale/fec_main.c
static void fec_enet_adjust_link(struct net_device *ndev)
{
	// PHY 通过 MDIO 检测到链路变化后回调此函数
	// 根据协商结果（速率/双工）重新配置 MAC
	if (status_change)
	{
		napi_disable(&fep->napi);
		netif_tx_lock_bh(ndev);
		fec_restart(ndev);       // 重新配置 MAC 寄存器
		netif_wake_queue(ndev);
		netif_tx_unlock_bh(ndev);
		napi_enable(&fep->napi);
	}
```

---

## 完整的职责划分

| 层次 | 接口 | 职责 |
|---|---|---|
| 网络核心 → FEC 驱动 | `ndo_open/stop/start_xmit` | 上层控制网卡开关、发包 |
| FEC 驱动 → FEC MAC 硬件 | `writel/readl`（寄存器） + DMA BD 环 | 配置 MAC，收发以太网帧 |
| FEC MAC ↔ PHY 芯片 | **MII/RMII 信号线**（硬件直连） | 实际数据比特流传输 |
| FEC 驱动 → PHY 驱动 | `phy_connect / phy_start` | 委托 phylib 管理 PHY |
| PHY 驱动 → PHY 芯片 | **MDIO 总线**（软件控制） | 读写 PHY 寄存器，协商链路参数 |

---

## 一句话总结

**FEC 驱动向上注册 `net_device`，向下创建 MDIO 总线并委托 phylib 管理 PHY 协商。但数据收发走的是 FEC MAC 通过 MII/RMII 信号线与 PHY 芯片之间的硬件直连通路，与 MDIO 无关。MDIO 只负责"谈判"（协商速率/双工），MII/RMII 才负责"搬货"（传输数据帧）。**

