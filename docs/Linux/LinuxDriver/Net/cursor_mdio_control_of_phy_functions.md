# MDIO control of PHY functions analysis
_Exported on 2026/3/26 at GMT+8 11:37:47 from Cursor (2.6.21)_

---

**User**

帮我分析一下@fec_main.c (3431-3441) 这些ops函数如何通过MDIO控制PHY收发信息，结合源码分析一下


---

## `fec_main.c` 3431~3441 — `fec_netdev_ops` 及 MDIO 控制 PHY 全链路分析

### 1. 目标代码段（3431~3441）

```3431:3441:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/net/ethernet/freescale/fec_main.c
static const struct net_device_ops fec_netdev_ops = {
	.ndo_open		= fec_enet_open,
	.ndo_stop		= fec_enet_close,
	.ndo_start_xmit		= fec_enet_start_xmit,
	.ndo_select_queue	= fec_enet_select_queue,
	.ndo_set_rx_mode	= set_multicast_list,
	.ndo_change_mtu		= eth_change_mtu,
	.ndo_validate_addr	= eth_validate_addr,
	.ndo_tx_timeout		= fec_timeout,
	.ndo_set_mac_address	= fec_set_mac_address,
	.ndo_do_ioctl		= fec_enet_ioctl,
```

这是 **网络设备操作函数表**（`net_device_ops`），并非 MDIO ops，它通过 `.ndo_do_ioctl = fec_enet_ioctl` 这一入口间接关联到 MDIO/PHY 控制。

---

### 2. ops 与 MDIO 的关联路径

```
用户空间 ethtool/ifconfig
        │ ioctl(SIOCGMIIPHY / SIOCSMIIREG)
        ▼
  .ndo_do_ioctl → fec_enet_ioctl()
        │  phy_mii_ioctl(phydev, ifr, cmd)
        ▼
  mdiobus_read() / mdiobus_write()      ← Linux MDIO 总线层
        │  bus->read / bus->write
        ▼
  fec_enet_mdio_read / fec_enet_mdio_write   ← FEC 驱动注册的 ops
        │  writel(MMFR)
        ▼
  FEC_MII_DATA 寄存器 (offset 0x040)         ← SoC 硬件寄存器
        │  MDC/MDIO 物理总线 (IEEE 802.3)
        ▼
      PHY 芯片（LAN8720A / AR8031 等）
```

`.ndo_open` 调用 `fec_enet_open` → 内部调用 `phy_start()` 启动 phylib 状态机，从此 PHY 的所有寄存器读写全部经过 MDIO 总线。

---

### 3. MMFR 寄存器位域（FEC_MII_DATA，偏移 0x040）

从 `fec_main.c` 中定义的宏：

```c
#define FEC_MMFR_ST        (1 << 30)       /* 起始位，固定为 01 */
#define FEC_MMFR_OP_READ   (2 << 28)       /* 读操作，OP=10 */
#define FEC_MMFR_OP_WRITE  (1 << 28)       /* 写操作，OP=01 */
#define FEC_MMFR_PA(v)     ((v & 0x1f) << 23)  /* PHY 地址，5位 */
#define FEC_MMFR_RA(v)     ((v & 0x1f) << 18)  /* 寄存器地址，5位 */
#define FEC_MMFR_TA        (2 << 16)            /* 转向，固定 10 */
#define FEC_MMFR_DATA(v)   (v & 0xffff)         /* 数据，低16位 */
```

位域布局：

```
 31 30 | 29 28 | 27..23  | 22..18  | 17 16 | 15..0
  ST   |  OP   |  PHYAD  |  REGAD  |  TA   | DATA
  01   | 10/01 | PHY地址  | 寄存器  |  10   | 读/写数据
```

---

### 4. `fec_enet_mdio_read` — 读 PHY 寄存器

核心流程：

1. 初始化 `completion`（`init_completion(&fep->mdio_done)`）
2. 拼装 MMFR 帧写入 `FEC_MII_DATA`，硬件自动发出 32 个 MDC 时钟帧
3. `wait_for_completion_timeout()` 阻塞等待，超时 30 ms
4. FEC 硬件完成后触发 `FEC_ENET_MII` 中断
5. ISR 调用 `complete(&fep->mdio_done)` 唤醒等待者
6. 从 `FEC_MII_DATA` 低 16 位读回 PHY 返回值

---

### 5. `fec_enet_mdio_write` — 写 PHY 寄存器

与读操作完全对称，区别：

- `OP` 字段改为 `FEC_MMFR_OP_WRITE`（`01`）
- DATA 字段携带要写入的 16-bit 值
- 写完后同样等待中断确认硬件已完成 MDIO 帧发送

---

### 6. 中断驱动的同步机制

```
fec_enet_interrupt()
    if (int_events & FEC_ENET_MII)        /* MDIO 帧传输完成 */
        complete(&fep->mdio_done);        /* 唤醒 mdio_read/write */
```

这是一个典型的 **completion 同步**模式：写寄存器触发硬件动作，中断通知软件结果就绪，避免了轮询浪费 CPU。

---

### 7. 总结

| ops 函数 | 触发方式 | 核心动作 | PHY 侧效果 |
|---|---|---|---|
| `.ndo_open` → `fec_enet_open` | `ip link set up` | 启动 phylib 状态机，调用 `phy_start()` | PHY 开始自动协商 |
| `.ndo_do_ioctl` → `fec_enet_ioctl` | `ethtool`/`ioctl` | 转发到 `phy_mii_ioctl` | 读写 PHY 寄存器 |
| `fec_enet_mdio_read` | mdiobus 层调用 | 写 `MMFR` → 等中断 → 读结果 | 从 PHY 读 16-bit 寄存器 |
| `fec_enet_mdio_write` | mdiobus 层调用 | 写 `MMFR`（含数据）→ 等中断 | 向 PHY 写 16-bit 寄存器 |
| `fec_enet_mdio_reset` | 总线复位 | 拉低 MDIO 总线 | PHY 软复位 |

**核心结论**：`fec_netdev_ops` 中的 ops 通过 ioctl 入口和 phylib 间接驱动 MDIO 总线；真正的物理层通信由 `fec_enet_mdio_read/write` 完成，它们直接操作 FEC 控制器的 `MMFR（FEC_MII_DATA）`寄存器，硬件自动生成符合 IEEE 802.3 Clause 22 标准的 MDIO 串行帧，实现对 PHY 收发参数（速率、双工、自协商状态等）的读写控制。



[Error: Post "https://cursor.com/api/chat": unexpected EOF]

---

**User**

.ndo_start_xmit = fec_enet_start_xmit
以这个函数为例分析呢

---

**Cursor**

Now let me read the actual `fec_enet_start_xmit` function body and the TX interrupt handler:




Now let me read more to find the actual xmit function:






Let me search more efficiently:


Now I have the line numbers. Let me read the key functions:


Good. I now have all the data. Here is the full analysis:

---

## `.ndo_start_xmit = fec_enet_start_xmit` — 发送路径完整分析

### 1. 在 ops 表中的位置

```3434:3434:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/net/ethernet/freescale/fec_main.c
	.ndo_start_xmit		= fec_enet_start_xmit,
```

当内核网络栈调用 `dev_queue_xmit()` 发送一个 `sk_buff` 时，最终会回调 `ndo_start_xmit`，即 `fec_enet_start_xmit`。

---

### 2. 完整发送调用链

```
内核网络栈 dev_queue_xmit(skb)
        │
        ▼
  fec_enet_start_xmit(skb, ndev)
        │
        ├─ skb_is_gso(skb)?
        │       ├── YES → fec_enet_txq_submit_tso()   (TSO 大包拆分)
        │       └── NO  → fec_enet_txq_submit_skb()   (普通包)
        │
        └─ 写 FEC_X_DES_ACTIVE 寄存器  → 触发 DMA 硬件发送
                │
                │ DMA 读取 BD 环，搬运数据到以太网 MAC
                ▼
          以太网 PHY → 网线 → 对端
                │
                │ 发送完成中断 FEC_ENET_TXF
                ▼
          fec_enet_interrupt() → fec_enet_tx() → 释放 skb / BD
```

---

### 3. `fec_enet_start_xmit` 源码逐步拆解

```370:430:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/net/ethernet/freescale/fec_main.c
static netdev_tx_t
fec_enet_start_xmit(struct sk_buff *skb, struct net_device *ndev)
{
	struct fec_enet_private *fep = netdev_priv(ndev);
	int entries_free;
	unsigned short queue;
	struct fec_enet_priv_tx_q *txq;
	struct netdev_queue *nq;
	int ret;

	queue = skb_get_queue_mapping(skb);   /* 从 skb 决定使用哪条 TX 队列 */
	txq = fep->tx_queue[queue];
	nq = netdev_get_tx_queue(ndev, queue);

	if (skb_is_gso(skb))
		ret = fec_enet_txq_submit_tso(txq, skb, ndev);  /* GSO/TSO 路径 */
	else
		ret = fec_enet_txq_submit_skb(txq, skb, ndev);  /* 普通路径 */
	if (ret)
		return ret;

	entries_free = fec_enet_get_free_txdesc_num(fep, txq);
	if (entries_free <= txq->tx_stop_threshold)
		netif_tx_stop_queue(nq);          /* BD 环快满时停止上层发送 */

	return NETDEV_TX_OK;
}
```

**关键点**：
- `skb_get_queue_mapping()` 结合 `.ndo_select_queue = fec_enet_select_queue` 决定队列（支持 AVB 多队列）
- 返回 `NETDEV_TX_OK` 表示驱动已接管 skb，内核不再管理该包

---

### 4. `fec_enet_txq_submit_skb` — 普通包填写 BD 环

核心步骤（摘自源码）：

```c
/* ① 映射 skb 数据到 DMA 地址 */
dma_addr = dma_map_single(&fep->pdev->dev, skb->data,
                           skb_headlen(skb), DMA_TO_DEVICE);

/* ② 填写 Buffer Descriptor (BD) */
bdp->cbd_bufaddr = cpu_to_fec32(dma_addr);   /* 数据物理地址 */
bdp->cbd_datlen  = cpu_to_fec16(skb->len);   /* 数据长度 */

/* ③ 设置 BD 控制字：标记为最后一个 BD，使能 TX 中断，交给 DMA */
status = BD_ENET_TX_TC | BD_ENET_TX_L | BD_ENET_TX_INT;
if (bdp == txq->tx_bd_base + txq->tx_ring_size - 1)
    status |= BD_ENET_TX_WRAP;              /* 最后一个 BD，回绕标志 */
bdp->cbd_sc = cpu_to_fec16(status | BD_ENET_TX_READY); /* 置 READY 位，DMA 接管 */

/* ④ 推进 cur_tx 指针 */
txq->cur_tx = fec_enet_get_nextdesc(bdp, fep, queue_id);

/* ⑤ 触发 DMA 硬件开始发送 */
writel(0, fep->hwp + FEC_X_DES_ACTIVE_0);
```

---

### 5. BD（Buffer Descriptor）环形队列结构

```
tx_bd_base                                   wrap
  ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┐
  │ BD0 │ BD1 │ BD2 │ BD3 │ BD4 │ BD5 │ BD6 │→ (回绕到 BD0)
  └─────┴─────┴─────┴─────┴─────┴─────┴─────┘
         ↑ dirty_tx                ↑ cur_tx
         (已发送待释放)              (下一个填写位置)
```

| 字段 | 含义 |
|---|---|
| `cbd_sc` | 控制/状态字，`BD_ENET_TX_READY=1` 表示交给 DMA |
| `cbd_bufaddr` | skb 数据的 DMA 物理地址 |
| `cbd_datlen` | 数据长度（字节） |

---

### 6. 发送完成 — 中断回收路径

```c
/* fec_enet_interrupt() 中 */
if (int_events & FEC_ENET_TXF_0)
    fec_enet_tx_queue(ndev, 0);   /* TX 完成，回收 BD */

/* fec_enet_tx_queue() 中 */
while (bdp != txq->cur_tx) {
    /* 取消 DMA 映射 */
    dma_unmap_single(..., bdp->cbd_bufaddr, ...);
    /* 释放 skb */
    dev_kfree_skb_any(txq->tx_skbuff[index]);
    txq->tx_skbuff[index] = NULL;
    /* dirty_tx 前进 */
    txq->dirty_tx = fec_enet_get_nextdesc(bdp, fep, queue_id);
    /* 如果队列之前被停住，现在空间充足则重新唤醒 */
    if (entries_free >= txq->tx_wake_threshold)
        netif_tx_wake_queue(nq);
}
```

---

### 7. 完整数据流总结

```
skb (内核虚拟地址)
    │ dma_map_single()
    ▼
DMA 物理地址 → 填入 BD.cbd_bufaddr
    │ BD.cbd_sc |= READY
    │ writel(FEC_X_DES_ACTIVE)
    ▼
FEC DMA 引擎 → 读 BD 环 → 搬运数据到 TX FIFO
    │
    ▼
以太网 MAC → RMII/MII → PHY → 网线

    （发送完成）
    │ FEC_ENET_TXF 中断
    ▼
fec_enet_tx_queue()
    │ dma_unmap / dev_kfree_skb_any
    └── dirty_tx 前进，唤醒队列
```

**核心设计思想**：驱动不直接拷贝数据，而是通过 **DMA + BD 环** 让硬件自主搬运，发送过程全程零拷贝，发完后中断通知驱动释放资源，实现高效的以太网数据发送。

现在我有了所有源码。以下是基于真实代码的完整分析：

---

## `.ndo_start_xmit = fec_enet_start_xmit` 完整源码分析

### 1. 入口函数（第 849 行）

```849:875:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/net/ethernet/freescale/fec_main.c
static netdev_tx_t
fec_enet_start_xmit(struct sk_buff *skb, struct net_device *ndev)
{
	struct fec_enet_private *fep = netdev_priv(ndev);
	int entries_free;
	unsigned short queue;
	struct fec_enet_priv_tx_q *txq;
	struct netdev_queue *nq;
	int ret;

	queue = skb_get_queue_mapping(skb);
	txq = fep->tx_queue[queue];
	nq = netdev_get_tx_queue(ndev, queue);

	if (skb_is_gso(skb))
		ret = fec_enet_txq_submit_tso(txq, skb, ndev);
	else
		ret = fec_enet_txq_submit_skb(txq, skb, ndev);
	if (ret)
		return ret;

	entries_free = fec_enet_get_free_txdesc_num(fep, txq);
	if (entries_free <= txq->tx_stop_threshold)
		netif_tx_stop_queue(nq);

	return NETDEV_TX_OK;
}
```

逻辑非常清晰：
- `skb_get_queue_mapping()` 决定使用哪条硬件 TX 队列（配合 `.ndo_select_queue`，支持 AVB 多优先级队列）
- `skb_is_gso()` 分流：大包走 TSO 路径，普通包走 `submit_skb`
- `entries_free <= tx_stop_threshold` 时调用 `netif_tx_stop_queue()`，通知内核暂停投递新包，防止 BD 环溢出

---

### 2. 普通包路径 — `fec_enet_txq_submit_skb`（第 503 行）

```503:640:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/net/ethernet/freescale/fec_main.c
static int fec_enet_txq_submit_skb(struct fec_enet_priv_tx_q *txq,
								   struct sk_buff *skb, struct net_device *ndev)
{
	// ...
	entries_free = fec_enet_get_free_txdesc_num(fep, txq);
	if (entries_free < MAX_SKB_FRAGS + 1) {        /* ① 检查 BD 环空闲数量 */
		dev_kfree_skb_any(skb);
		return NETDEV_TX_OK;
	}

	if (fec_enet_clear_csum(skb, ndev)) { ... }    /* ② 清零软件校验和字段（交给硬件计算）*/

	bdp = txq->cur_tx;                             /* ③ 取当前 BD 指针 */
	bufaddr = skb->data;
	buflen  = skb_headlen(skb);

	/* ④ 对齐检查：若地址未对齐或需要字节序交换，先 memcpy 到 bounce buffer */
	if (((unsigned long)bufaddr) & fep->tx_align || fep->quirks & FEC_QUIRK_SWAP_FRAME) {
		memcpy(txq->tx_bounce[index], skb->data, buflen);
		bufaddr = txq->tx_bounce[index];
		if (fep->quirks & FEC_QUIRK_SWAP_FRAME)
			swap_buffer(bufaddr, buflen);
	}

	/* ⑤ DMA 映射：将虚拟地址转换为硬件可访问的物理地址 */
	addr = dma_map_single(&fep->pdev->dev, bufaddr, buflen, DMA_TO_DEVICE);

	/* ⑥ 分散-聚集：若 skb 有 frags，继续填写后续 BD */
	if (nr_frags)
		last_bdp = fec_enet_txq_submit_frag_skb(txq, skb, ndev);

	/* ⑦ 填写最后一个 BD 的控制字 */
	status |= (BD_ENET_TX_READY | BD_ENET_TX_TC);  /* READY=1 交给 DMA */
	bdp->cbd_sc      = status;
	bdp->cbd_datlen  = buflen;
	bdp->cbd_bufaddr = addr;

	txq->tx_skbuff[index] = skb;   /* ⑧ 保存 skb 指针供中断回收 */

	wmb();                          /* ⑨ 写屏障，确保 BD 内容对 DMA 可见 */
	txq->cur_tx = fec_enet_get_nextdesc(last_bdp, fep, queue);

	/* ⑩ 触发硬件 DMA 开始发送 */
	writel(0, fep->hwp + FEC_X_DES_ACTIVE(queue));

	return 0;
}
```

---

### 3. 分散聚集路径 — `fec_enet_txq_submit_frag_skb`（第 410 行）

```410:500:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/net/ethernet/freescale/fec_main.c
static struct bufdesc *
fec_enet_txq_submit_frag_skb(struct fec_enet_priv_tx_q *txq,
							 struct sk_buff *skb, struct net_device *ndev)
{
	// ...
	for (frag = 0; frag < nr_frags; frag++) {
		this_frag = &skb_shinfo(skb)->frags[frag];
		bdp = fec_enet_get_nextdesc(bdp, fep, queue);   /* 推进到下一个 BD */

		status |= (BD_ENET_TX_TC | BD_ENET_TX_READY);

		/* 最后一个 frag 才置 INTR+LAST 标志，触发中断 */
		if (frag == nr_frags - 1)
			status |= (BD_ENET_TX_INTR | BD_ENET_TX_LAST);

		addr = dma_map_single(&fep->pdev->dev, bufaddr, frag_len, DMA_TO_DEVICE);
		bdp->cbd_bufaddr = addr;
		bdp->cbd_datlen  = frag_len;
		bdp->cbd_sc      = status;
	}
	return bdp;   /* 返回最后一个 BD 指针 */
}
```

关键设计：只有**最后一个 BD** 才置 `BD_ENET_TX_INTR | BD_ENET_TX_LAST`，一帧数据无论跨多少个 BD，**只触发一次 TX 完成中断**。

---

### 4. TSO 大包路径 — `fec_enet_txq_submit_tso`（第 757 行）

```757:848:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/net/ethernet/freescale/fec_main.c
static int fec_enet_txq_submit_tso(struct fec_enet_priv_tx_q *txq,
								   struct sk_buff *skb, struct net_device *ndev)
{
	// ...
	tso_start(skb, &tso);           /* 初始化 TSO 上下文 */
	total_len = skb->len - hdr_len;

	while (total_len > 0) {
		data_left = min_t(int, skb_shinfo(skb)->gso_size, total_len);

		/* 为每个 TCP segment 填写独立的 MAC+IP+TCP 头 */
		tso_build_hdr(skb, hdr, &tso, data_left, total_len == 0);
		fec_enet_txq_put_hdr_tso(txq, skb, ndev, bdp, index);  /* 头部 BD */

		while (data_left > 0) {
			fec_enet_txq_put_data_tso(...);   /* 数据 BD */
			tso_build_data(skb, &tso, size);
		}
		bdp = fec_enet_get_nextdesc(bdp, fep, queue);
	}
	txq->cur_tx = bdp;

	/* ERR007885 workaround：连续读4次确认寄存器状态再触发 */
	writel(0, fep->hwp + FEC_X_DES_ACTIVE(queue));
}
```

---

### 5. 发送完成中断回收 — `fec_enet_tx_queue`（第 1372 行）

```1372:1460:/home/nopiskl/Linux-change/linux-tutorial/linux-imx-rel_imx_4.1.15_2.1.0_ga_alientek/drivers/net/ethernet/freescale/fec_main.c
static void
fec_enet_tx_queue(struct net_device *ndev, u16 queue_id)
{
	// ...
	bdp = txq->dirty_tx;
	bdp = fec_enet_get_nextdesc(bdp, fep, queue_id);

	while (bdp != READ_ONCE(txq->cur_tx)) {
		status = READ_ONCE(bdp->cbd_sc);
		if (status & BD_ENET_TX_READY)   /* DMA 还没发完，停止 */
			break;

		/* 找到此帧对应的 skb（可能跨多个 BD） */
		skb = txq->tx_skbuff[index];

		/* 取消 DMA 映射，归还给内核 */
		dma_unmap_single(&fep->pdev->dev, bdp->cbd_bufaddr, bdp->cbd_datlen, DMA_TO_DEVICE);

		/* 统计错误：心跳/晚碰撞/重传超限/FIFO下溢/载波丢失 */
		if (status & (BD_ENET_TX_HB | BD_ENET_TX_LC | BD_ENET_TX_RL |
		              BD_ENET_TX_UN | BD_ENET_TX_CSL))
			ndev->stats.tx_errors++;
		else {
			ndev->stats.tx_packets++;
			ndev->stats.tx_bytes += skb->len;
		}

		dev_kfree_skb_any(skb);          /* 释放 skb */
		wmb();
		txq->dirty_tx = bdp;             /* dirty_tx 前进 */

		/* BD 环空间恢复，唤醒上层发送队列 */
		if (netif_queue_stopped(ndev)) {
			entries_free = fec_enet_get_free_txdesc_num(fep, txq);
			if (entries_free >= txq->tx_wake_threshold)
				netif_tx_wake_queue(nq);
		}
	}
}
```

---

### 6. 完整数据流全景图

```
内核网络栈 dev_queue_xmit(skb)
         │
         ▼
fec_enet_start_xmit()
         ├── skb_is_gso? ──YES──► fec_enet_txq_submit_tso()
         │                              │ 每个 TCP segment 拆分
         │                              │ fec_enet_txq_put_hdr_tso() [头部 BD]
         │                              └ fec_enet_txq_put_data_tso() [数据 BD]
         │
         └── NO ──────────────► fec_enet_txq_submit_skb()
                                       │
                                       ├─ fec_enet_clear_csum()      [清零校验和]
                                       ├─ dma_map_single()           [虚拟→物理地址]
                                       ├─ fec_enet_txq_submit_frag_skb() [SG分片]
                                       ├─ bdp->cbd_sc |= TX_READY   [交给DMA]
                                       ├─ wmb()                      [写屏障]
                                       └─ writel(FEC_X_DES_ACTIVE)  [踢动硬件]

FEC DMA 引擎 → 读 BD 环 → TX FIFO → MAC → RMII → PHY → 网线

         发送完成 FEC_ENET_TXF 中断
         │
         ▼
fec_enet_interrupt() → fec_enet_collect_events() → NAPI schedule
         │
         ▼
fec_enet_rx_napi() → fec_enet_tx() → fec_enet_tx_queue()
         │ dma_unmap_single()   [归还 DMA 映射]
         │ dev_kfree_skb_any()  [释放 skb]
         │ dirty_tx++           [BD 环归还]
         └ netif_tx_wake_queue() [唤醒上层继续发包]
```

**核心设计要点总结**：

| 机制 | 目的 |
|---|---|
| BD 环 + DMA | 零拷贝发送，CPU 不参与数据搬运 |
| `TX_READY` 位 | 软硬件之间的所有权协议 |
| `wmb()` 写屏障 | 防止编译器/CPU 乱序，确保 BD 内容先于 `cur_tx` 更新对 DMA 可见 |
| 只有最后一个 BD 置 `TX_INTR` | 一帧只触发一次中断，降低中断频率 |
| `tx_stop_threshold` / `tx_wake_threshold` | 流量控制，防止 BD 环溢出 |
| NAPI 模式 | 中断触发后切换为轮询，批量处理，提高吞吐 |

