# Send system call flow to fec_enet_start_xmit
_Exported on 2026/3/26 at GMT+8 11:50:30 from Cursor (2.6.21)_

---

**User**

你能否梳理一下上层调用send()系统调用一直到@drivers/net/ethernet/freescale/fec_main.c 里面的.ndo_start_xmit = fec_enet_start_xmit,发送的全流程吗

---

**Cursor**

---

## `send()` → `fec_enet_start_xmit` 完整发送流程

---

### 第一层：系统调用层 — `net/socket.c`

**`send()` 本质是 `sendto()` 的简化包装：**

```1672:1676:net/socket.c
SYSCALL_DEFINE4(send, int, fd, void __user *, buff, size_t, len,
		unsigned int, flags)
{
	return sys_sendto(fd, buff, len, flags, NULL, 0);
}
```

**`sendto()` 构建 `msghdr`，调用 `sock_sendmsg()`：**

```1628:1662:net/socket.c
SYSCALL_DEFINE6(sendto, int, fd, void __user *, buff, size_t, len,
		unsigned int, flags, struct sockaddr __user *, addr,
		int, addr_len)
{
	struct socket *sock;
	struct sockaddr_storage address;
	int err;
	struct msghdr msg;
	struct iovec iov;
	int fput_needed;

	err = import_single_range(WRITE, buff, len, &iov, &msg.msg_iter);
	if (unlikely(err))
		return err;
	sock = sockfd_lookup_light(fd, &err, &fput_needed);
	// ... 构建 msg 结构体，填充目标地址 ...
	err = sock_sendmsg(sock, &msg);
	// ...
}
```

**`sock_sendmsg()` → `sock_sendmsg_nosec()` → `sock->ops->sendmsg()`（协议层函数指针）：**

```611:625:net/socket.c
static inline int sock_sendmsg_nosec(struct socket *sock, struct msghdr *msg)
{
	int ret = sock->ops->sendmsg(sock, msg, msg_data_left(msg));
	BUG_ON(ret == -EIOCBQUEUED);
	return ret;
}

int sock_sendmsg(struct socket *sock, struct msghdr *msg)
{
	int err = security_socket_sendmsg(sock, msg,
					  msg_data_left(msg));

	return err ?: sock_sendmsg_nosec(sock, msg);
}
```

> `sock->ops->sendmsg` 是函数指针，TCP socket 对应 `tcp_sendmsg()`，UDP 对应 `udp_sendmsg()`。

---

### 第二层：传输层 TCP — `net/ipv4/tcp.c` + `net/ipv4/tcp_output.c`

**`tcp_sendmsg()`：将用户数据拷入 `sk_buff`，触发发送：**

```1067:1090:net/ipv4/tcp.c
int tcp_sendmsg(struct sock *sk, struct msghdr *msg, size_t size)
{
	struct tcp_sock *tp = tcp_sk(sk);
	struct sk_buff *skb;
	int flags, err, copied = 0;
	int mss_now = 0, size_goal, copied_syn = 0;
	bool sg;
	long timeo;

	lock_sock(sk);

	flags = msg->msg_flags;
	// ... 拷贝用户数据到 skb，管理发送队列 ...
	// 最终调用 tcp_push() → tcp_write_xmit()
```

**`tcp_write_xmit()`：拥塞控制、Nagle 算法、逐包调用 `tcp_transmit_skb()`：**

```2032:2060:net/ipv4/tcp_output.c
static bool tcp_write_xmit(struct sock *sk, unsigned int mss_now, int nonagle,
			   int push_one, gfp_t gfp)
{
	struct tcp_sock *tp = tcp_sk(sk);
	struct sk_buff *skb;
	unsigned int tso_segs, sent_pkts;
	int cwnd_quota;
	int result;
	bool is_cwnd_limited = false;
	u32 max_segs;

	// ... 拥塞窗口检查、TSO 分段 ...
	while ((skb = tcp_send_head(sk))) {
		// ...
		// 每个 skb 调用 tcp_transmit_skb()
```

**`tcp_transmit_skb()`：封装 TCP 头，调用 `ip_queue_xmit()`：**

```906:940:net/ipv4/tcp_output.c
static int tcp_transmit_skb(struct sock *sk, struct sk_buff *skb, int clone_it,
			    gfp_t gfp_mask)
{
	const struct inet_connection_sock *icsk = inet_csk(sk);
	struct inet_sock *inet;
	struct tcp_sock *tp;
	struct tcp_skb_cb *tcb;
	struct tcp_out_options opts;
	unsigned int tcp_options_size, tcp_header_size;
	struct tcp_md5sig_key *md5;
	struct tcphdr *th;
	int err;
	// ... 填充 TCP 头（序列号、ACK、窗口、校验和）...
	// 最终调用: icsk->icsk_af_ops->queue_xmit(skb, &inet->cork.fl)
	// 即 ip_queue_xmit()
```

---

### 第三层：网络层 IP — `net/ipv4/ip_output.c`

**`ip_queue_xmit()`：查路由、封装 IP 头、调用 `ip_local_out()`：**

```369:456:net/ipv4/ip_output.c
int ip_queue_xmit(struct sock *sk, struct sk_buff *skb, struct flowi *fl)
{
	// 1. 查路由表（路由缓存 or ip_route_output_ports）
	rt = (struct rtable *)__sk_dst_check(sk, 0);
	// ...
	// 2. 封装 IP 头: version/IHL/TTL/protocol/src/dst
	iph = ip_hdr(skb);
	*((__be16 *)iph) = htons((4 << 12) | (5 << 8) | (inet->tos & 0xff));
	// ...
	// 3. 发往本地输出路径
	res = ip_local_out(skb);
	return res;
}
```

**`ip_local_out()` → `__ip_local_out()` → netfilter OUTPUT 钩子 → `ip_output()`：**

```94:119:net/ipv4/ip_output.c
int __ip_local_out_sk(struct sock *sk, struct sk_buff *skb)
{
	// 经过 netfilter NF_INET_LOCAL_OUT 钩子
	// ...
}

int ip_local_out_sk(struct sock *sk, struct sk_buff *skb)
{
	int err;
	err = __ip_local_out(skb);
	// ...
}
```

**`ip_output()`：经过 netfilter POSTROUTING 钩子 → `ip_finish_output()`：**

```339:353:net/ipv4/ip_output.c
int ip_output(struct sock *sk, struct sk_buff *skb)
{
	struct net_device *dev = skb_dst(skb)->dev;

	IP_UPD_PO_STATS(dev_net(dev), IPSTATS_MIB_OUT, skb->len);

	skb->dev = dev;
	skb->protocol = htons(ETH_P_IP);

	return NF_HOOK_COND(NFPROTO_IPV4, NF_INET_POST_ROUTING, sk, skb,
			    NULL, dev,
			    ip_finish_output,
			    !(IPCB(skb)->flags & IPSKB_REROUTED));
}
```

**`ip_finish_output2()`：ARP/邻居查询，封装二层以太网头，调用 `dst_neigh_output()`：**

```171:210:net/ipv4/ip_output.c
static inline int ip_finish_output2(struct sock *sk, struct sk_buff *skb)
{
	struct dst_entry *dst = skb_dst(skb);
	struct rtable *rt = (struct rtable *)dst;
	struct net_device *dev = dst->dev;
	// ...
	rcu_read_lock_bh();
	nexthop = (__force u32) rt_nexthop(rt, ip_hdr(skb)->daddr);
	neigh = __ipv4_neigh_lookup_noref(dev, nexthop);
	if (unlikely(!neigh))
		neigh = __neigh_create(&arp_tbl, &nexthop, dev, false);
	if (!IS_ERR(neigh)) {
		int res = dst_neigh_output(dst, neigh, skb);  // 邻居/ARP输出
		rcu_read_unlock_bh();
		return res;
	}
	// ...
}
```

> `dst_neigh_output()` → `neigh_hh_output()`（有硬件头缓存快速路径）或 `neigh->output()`（慢速路径触发 ARP）→ 填充 MAC 地址后进入设备层。

---

### 第四层：流量控制 / 设备层 — `net/core/dev.c`

**`dev_queue_xmit()` → `__dev_queue_xmit()`：进入 Qdisc 队列或直接发送：**

```2926:2993:net/core/dev.c
static int __dev_queue_xmit(struct sk_buff *skb, void *accel_priv)
{
	struct net_device *dev = skb->dev;
	struct netdev_queue *txq;
	struct Qdisc *q;
	// ...
	txq = netdev_pick_tx(dev, skb, accel_priv);
	q = rcu_dereference_bh(txq->qdisc);
	// ...
	if (q->enqueue) {
		rc = __dev_xmit_skb(skb, q, dev, txq); // 入 Qdisc 队列
		goto out;
	}
	// 无队列设备直接发送:
	skb = dev_hard_start_xmit(skb, dev, txq, &rc);
	// ...
}
```

**`dev_hard_start_xmit()` → `xmit_one()` → `netdev_start_xmit()` → `ops->ndo_start_xmit()`：**

```2656:2654:net/core/dev.c
struct sk_buff *dev_hard_start_xmit(struct sk_buff *first, struct net_device *dev,
				    struct netdev_queue *txq, int *ret)
{
	// 循环处理 skb 链表
	while (skb) {
		rc = xmit_one(skb, dev, txq, next != NULL);
		// xmit_one → netdev_start_xmit → ops->ndo_start_xmit
		// ...
	}
}
```

```2640:2654:net/core/dev.c
	rc = netdev_start_xmit(skb, dev, txq, more);
	// netdev_start_xmit 定义于 include/linux/netdevice.h:
	// return ops->ndo_start_xmit(skb, dev);
```

---

### 第五层：FEC 驱动层 — `drivers/net/ethernet/freescale/fec_main.c`

**`fec_netdev_ops` 注册 `.ndo_start_xmit`：**

```3430:3439:drivers/net/ethernet/freescale/fec_main.c
static const struct net_device_ops fec_netdev_ops = {
	.ndo_open = fec_enet_open,
	.ndo_stop = fec_enet_close,
	.ndo_start_xmit = fec_enet_start_xmit,
	.ndo_select_queue = fec_enet_select_queue,
	.ndo_set_rx_mode = set_multicast_list,
	.ndo_change_mtu = eth_change_mtu,
	.ndo_validate_addr = eth_validate_addr,
	.ndo_tx_timeout = fec_timeout,
```

**`fec_enet_start_xmit()`：选队列、提交 skb、控制队列停止：**

```849:872:drivers/net/ethernet/freescale/fec_main.c
fec_enet_start_xmit(struct sk_buff *skb, struct net_device *ndev)
{
	struct fec_enet_private *fep = netdev_priv(ndev);
	int entries_free;
	unsigned short queue;
	struct fec_enet_priv_tx_q *txq;
	struct netdev_queue *nq;
	int ret;

	queue = skb_get_queue_mapping(skb);       // 选择发送队列
	txq = fep->tx_queue[queue];
	nq = netdev_get_tx_queue(ndev, queue);

	if (skb_is_gso(skb))
		ret = fec_enet_txq_submit_tso(txq, skb, ndev);  // TSO 大包
	else
		ret = fec_enet_txq_submit_skb(txq, skb, ndev);  // 普通包
	if (ret)
		return ret;

	entries_free = fec_enet_get_free_txdesc_num(fep, txq);
	if (entries_free <= txq->tx_stop_threshold)
		netif_tx_stop_queue(nq);               // BD 环满则停队列

	return NETDEV_TX_OK;
}
```

**`fec_enet_txq_submit_skb()` 的核心工作：DMA 映射 + 填写 BD 环 + 触发硬件：**

```
fec_enet_txq_submit_skb()
  ├── fec_enet_clear_csum()          // 硬件 checksum offload 清零
  ├── dma_map_single()               // 将 skb->data 映射到 DMA 地址
  ├── 填写 BD 描述符:
  │     bdp->cbd_bufaddr = addr;     // DMA 物理地址
  │     bdp->cbd_datlen  = buflen;   // 数据长度
  │     bdp->cbd_sc |= BD_ENET_TX_READY | BD_ENET_TX_TC;  // 交给硬件
  ├── writel(0, fep->hwp + FEC_X_DES_ACTIVE(queue))  // 写寄存器触发 DMA 发送
  └── txq->cur_tx = bdp;             // 更新 cur_tx 指针
```

---

### 完整调用链一览

```
用户空间 send(fd, buf, len, flags)
  │  [glibc syscall 指令]
  ▼
SYSCALL_DEFINE4(send)               net/socket.c:1672
  │  → sys_sendto(..., NULL, 0)
  ▼
SYSCALL_DEFINE6(sendto)             net/socket.c:1628
  │  → 构建 msghdr → sock_sendmsg()
  ▼
sock_sendmsg()                      net/socket.c:618
  │  → security 检查 → sock_sendmsg_nosec()
  ▼
sock_sendmsg_nosec()                net/socket.c:611
  │  → sock->ops->sendmsg()  [函数指针 → TCP]
  ▼
用户空间 send(fd, buf, len, flags)
  │  [glibc → syscall 指令]
  ▼
SYSCALL_DEFINE4(send)                        net/socket.c:1672
  │  → sys_sendto(..., NULL, 0)
  ▼
SYSCALL_DEFINE6(sendto)                      net/socket.c:1628
  │  → 构建 msghdr，sockfd_lookup_light() 找到 socket
  │  → sock_sendmsg(sock, &msg)
  ▼
sock_sendmsg()                               net/socket.c:618
  │  → security_socket_sendmsg() LSM 安全检查
  │  → sock_sendmsg_nosec(sock, msg)
  ▼
sock_sendmsg_nosec()                         net/socket.c:611
  │  → sock->ops->sendmsg()   ← 函数指针分发（TCP/UDP/RAW）
  ▼
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 以 TCP 为例 ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ▼
tcp_sendmsg()                                net/ipv4/tcp.c:1067
  │  → 等待连接建立（timeo）
  │  → 循环将用户数据 copy_from_user() 写入 sk_buff
  │  → 积累到 MSS 后调用 tcp_push()
  │  → tcp_push() → tcp_write_xmit()
  ▼
tcp_write_xmit()                             net/ipv4/tcp_output.c:2032
  │  → 拥塞窗口检查（cwnd_quota）
  │  → Nagle 算法判断
  │  → TSO 分段（tcp_tso_autosize）
  │  → 循环 tcp_send_head(sk) 取 skb
  │  → 对每个 skb 调用 tcp_transmit_skb()
  ▼
tcp_transmit_skb()                           net/ipv4/tcp_output.c:906
  │  → clone skb（引用计数）
  │  → 构建 TCP 头部：序列号、ACK、窗口大小、标志位
  │  → tcp_options_write()（SACK/timestamp/MSS 选项）
  │  → 计算 TCP checksum（硬件 offload 或软件）
  │  → icsk->icsk_af_ops->queue_xmit(skb, &inet->cork.fl)
  │       ↑ 对 IPv4 就是 ip_queue_xmit
  ▼
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 网络层 IP ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ▼
ip_queue_xmit()                              net/ipv4/ip_output.c:369
  │  → __sk_dst_check() 查路由缓存
  │  → 缓存无效则 ip_route_output_ports() 查路由表
  │  → skb_push() 预留 IP 头空间
  │  → 填充 IP 头：version=4, IHL, TOS, TTL, protocol, src/dst IP
  │  → ip_select_ident_segs() 填充报文 ID
  │  → ip_local_out(skb)
  ▼
ip_local_out() → __ip_local_out()            net/ipv4/ip_output.c:109
  │  → NF_HOOK(NF_INET_LOCAL_OUT)  ← netfilter OUTPUT 链（iptables OUTPUT）
  │  → 通过后调用 dst->output() = ip_output()
  ▼
ip_output()                                  net/ipv4/ip_output.c:339
  │  → 设置 skb->dev, skb->protocol = ETH_P_IP
  │  → NF_HOOK_COND(NF_INET_POST_ROUTING)  ← iptables POSTROUTING
  │  → 通过后调用 ip_finish_output()
  ▼
ip_finish_output()                           net/ipv4/ip_output.c:261
  │  → GSO 包 → ip_finish_output_gso()
  │  → 超 MTU → ip_fragment() 分片
  │  → 正常 → ip_finish_output2()
  ▼
ip_finish_output2()                          net/ipv4/ip_output.c:171
  │  → rt_nexthop() 获取下一跳 IP
  │  → __ipv4_neigh_lookup_noref() 查 ARP 缓存
  │  → 未命中则 __neigh_create() 触发 ARP 请求
  │  → dst_neigh_output(dst, neigh, skb)
  │       ├─ 有硬件头缓存(hh)：neigh_hh_output()  ← 快速路径
  │       └─ 无缓存：        neigh->output()      ← 慢速路径（等待 ARP 回应）
  │  → 填充以太网帧头（dst MAC、src MAC、EtherType=0x0800）
  │  → dev_queue_xmit(skb)
  ▼
━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 设备/流量控制层 ━━━━━━━━━━━━━━━━━━━━━━━━━
  ▼
dev_queue_xmit() / dev_queue_xmit_sk()       net/core/dev.c:3025
  │  → __dev_queue_xmit(skb, NULL)
  ▼
__dev_queue_xmit()                           net/core/dev.c:2926
  │  → netdev_pick_tx() 选择发送队列 txq
  │  → 获取 Qdisc q = txq->qdisc
  │  ├─ 有 Qdisc（如 pfifo_fast）：
  │  │    __dev_xmit_skb() → q->enqueue() 入队
  │  │    → __qdisc_run() → qdisc_restart()
  │  │    → sch_direct_xmit() → dev_hard_start_xmit()
  │  └─ 无 Qdisc（noqueue）：
  │       validate_xmit_skb() → dev_hard_start_xmit()
  ▼
dev_hard_start_xmit()                        net/core/dev.c:2656
  │  → 循环处理 skb 链表
  │  → xmit_one(skb, dev, txq, more)
  ▼
xmit_one()                                   net/core/dev.c:2640
  │  → dev_queue_xmit_nit()（packet socket 抓包钩子，tcpdump 在此）
  │  → netdev_start_xmit(skb, dev, txq, more)
  ▼
netdev_start_xmit()                          include/linux/netdevice.h:3613
  │  → ops->ndo_start_xmit(skb, dev)   ← 调用驱动注册的函数指针
  ▼
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ FEC 驱动层 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ▼
fec_enet_start_xmit()                        drivers/net/ethernet/freescale/fec_main.c:849
  │  （通过 fec_netdev_ops.ndo_start_xmit 注册，见 fec_main.c:3434）
  │  → skb_get_queue_mapping() 选择硬件发送队列（FEC 支持多队列）
  │  ├─ GSO 大包：fec_enet_txq_submit_tso()
  │  └─ 普通包：  fec_enet_txq_submit_skb()
  ▼
fec_enet_txq_submit_skb()
  │  → fec_enet_clear_csum()         // checksum offload 清零软件计算值
  │  → 取当前 BD（Buffer Descriptor）: bdp = txq->cur_tx
  │  → dma_map_single()              // 将 skb->data 映射为 DMA 物理地址
  │  → 若有 SG 分片：fec_enet_txq_submit_frag_skb()
  │  → 填写 BD 环各字段：
  │       bdp->cbd_bufaddr = addr     // 数据缓冲区物理地址
  │       bdp->cbd_datlen  = buflen   // 数据长度
  │       bdp->cbd_sc |= BD_ENET_TX_READY   // 标记交给硬件
  │                    | BD_ENET_TX_TC      // 追加 CRC
  │                    | BD_ENET_TX_LAST    // 最后一个 BD
  │                    | BD_ENET_TX_INTR    // 发送完成触发中断
  │  → wmb()                         // 写内存屏障，确保 BD 写入对硬件可见
  │  → txq->cur_tx = 下一个 BD       // 移动 cur_tx 指针
  │  → writel(0, fep->hwp + FEC_X_DES_ACTIVE(queue))
  │       ↑ 写寄存器，通知 FEC 硬件 DMA 开始取数据发送
  ▼
FEC 硬件（i.MX6ULL 片内以太网控制器）
  │  → DMA 引擎从 BD 环读取物理地址
  │  → 将数据帧发送到 MII/RMII PHY 接口
  │  → 发送完成后产生中断
  ▼
fec_enet_interrupt()  →  fec_enet_tx()
  │  → 解除 DMA 映射：dma_unmap_single()
  │  → 释放 skb：dev_kfree_skb_any()
  └  → 更新统计计数，唤醒发送队列（如之前停止）
```

---

### 关键数据结构流转总结

| 层次 | 关键动作 | 数据单元 |
|------|---------|---------|
| 系统调用层 | `copy_from_user()` 读用户数据 | `msghdr` + `iovec` |
| TCP 层 | 封装 TCP 头、拥塞控制、重传管理 | `sk_buff` |
| IP 层 | 封装 IP 头、路由查找、分片 | `sk_buff` + `rtable` |
| 邻居/ARP 层 | 封装以太网帧头、ARP 解析 | `sk_buff` + `neighbour` |
| Qdisc 层 | 流量整形、队列调度 | `sk_buff` 队列 |
| FEC 驱动 | DMA 映射、BD 环填写、触发硬件 | `bufdesc` (BD 环) |
| FEC 硬件 | 物理层发送到网线 | 以太网帧 |

