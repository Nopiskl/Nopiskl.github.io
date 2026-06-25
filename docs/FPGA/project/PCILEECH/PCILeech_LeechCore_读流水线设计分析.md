# PCILeech/LeechCore 读流水线设计分析

本文档整理前面对 PCILeech/LeechCore 中 `MEM_SCATTER`、FPGA 后端、PCIe MRd/CplD、tag/credit 窗口、Async2 流水调度以及 `acorn_ft2232h` FPGA 工程的讨论。重点解释：为什么 `MEM_SCATTER` 能提升性能，流水线性质如何体现，以及为什么真正的 scatter 调度、tag 分配、CplD 对应关系主要发生在 PC 端 LeechCore 的 `device_fpga.c` 中。

## 1. 总体结论

PCILeech 的高性能读路径可以概括为：

```text
上层连续读 / dump
  -> LcRead() 拆成 4KB MEM_SCATTER
  -> LcReadScatter() 做地址翻译和后端分发
  -> device_fpga.c 把 MEM_SCATTER 转成 PCIe MRd TLP
  -> PC 端维护 tag/credit/outstanding read 窗口
  -> FPGA 侧转发 TLP 流
  -> 目标主机返回 CplD
  -> PC 端根据 CplD.Tag 找回 MEM_SCATTER
  -> memcpy 到 pMEM->pb
  -> 释放 tag/credit，继续补发 MRd
```

核心不是“一个函数叫 pipeline”，而是形成了一个动态闭环：

```text
批量 scatter 队列
  -> 连续发出多个 MRd
  -> tag/credit 形成 outstanding window
  -> CplD 批量/异步返回
  -> 根据 tag 回填 pMEM
  -> 释放 tag/credit
  -> 继续补发新的 MRd
```

这就是流水线性质。

## 2. `MEM_SCATTER` 为什么是性能协议

`MEM_SCATTER` 表面上是一个读写任务结构：

```c
typedef struct tdMEM_SCATTER {
    DWORD version;
    BOOL f;
    QWORD qwA;
    PBYTE pb;
    DWORD cb;
    DWORD iStack;
    QWORD vStack[MEM_SCATTER_STACK_SIZE];
} MEM_SCATTER;
```

它表达：

```text
从地址 qwA 读/写 cb 字节，buffer 是 pb，完成状态写入 f。
```

但它更重要的意义是：上层可以一次性提交很多页读请求，让底层后端有机会批量优化。

例如 dump 16MB：

```text
16MB / 4KB = 4096 页
```

如果一页一页读，就是：

```text
读 page0 -> 等完成
读 page1 -> 等完成
读 page2 -> 等完成
...
读 page4095 -> 等完成
```

每页都要经历设备请求、等待、返回、解析、拷贝等固定开销。

使用 `MEM_SCATTER` 后，上层一次提交：

```text
4096 个 page 读请求
```

底层后端可以按设备特性优化：

| 后端 | 优化方式 |
| --- | --- |
| FPGA | 批量生成 MRd TLP，流水线接收 CplD |
| 文件 | 合并连续 offset，减少 seek/read |
| 远程 | 打包、压缩、传输 |
| contiguous 后端 | LeechCore 聚合相邻 scatter 成大块读 |

所以 `MEM_SCATTER` 不是简单数据结构，而是 PCILeech/LeechCore 与各设备后端之间的性能协议：

```text
上层表达“我要读哪些页”
底层决定“如何最快读完这些页”
```

## 3. `LcRead()`、`LcReadScatter()` 和 `device_fpga.c` 的分层

### 3.1 `LcRead()`：连续读拆成页级 scatter

`LcRead()` 是便利接口。它会计算连续读覆盖多少个 4KB page，然后构造 `MEM_SCATTER` 数组：

```text
LcRead(hLC, pa, cb, pb)
  -> 计算 cMEMs
  -> LcAllocScatter3()
  -> 为每个 ppMEMs[i] 设置 qwA
  -> LcReadScatter(hLC, cMEMs, ppMEMs)
```

所以 `LcRead()` 负责把“连续读”变成“页级 scatter 请求”。

### 3.2 `LcReadScatter()`：通用抽象层

`LcReadScatter()` 的核心流程：

```text
LcReadScatter(hLC, cMEMs, ppMEMs)
  -> 保存原始地址到 MEM_SCATTER stack
  -> LcMemMap_TranslateMEMs 做地址翻译
  -> 加 LeechCore 锁
  -> 调用 ctxLC->pfnReadScatter
  -> 解锁
  -> 恢复原始地址
```

这一层负责的是设备无关的事情：

- 管理 `MEM_SCATTER` 数组。
- 做 memory map 翻译。
- 调用设备后端。
- 统计读调用。
- 恢复上层语义地址。

它不关心：

- MRd32 还是 MRd64。
- PCIe tag 用哪个。
- 一个 4KB MRd 会返回几个 CplD。
- CplD payload 写到 `pMEM->pb` 的哪个 offset。
- FT2232H/FT601/UDP 如何收发。
- outstanding read window 如何控制。

### 3.3 `device_fpga.c`：FPGA/PCIe 传输协议层

FPGA 后端注册：

```text
ctxLC->pfnReadScatter = DeviceFPGA_ReadScatter_DoLock
```

进入 FPGA 后端后，问题变成：

```text
给定 N 个 MEM_SCATTER，如何把它们变成 PCIe MRd TLP？
如何维护 tag -> MEM_SCATTER 的映射？
如何处理 CplD 乱序返回？
如何判断某个 4KB 页已经收齐？
如何释放 tag/credit 并继续补发？
```

所以 `LcReadScatter()` 和 `device_fpga.c` 都看起来在“管理 4KB”，但含义不同：

| 层 | 4KB 的含义 | 职责 |
| --- | --- | --- |
| `LcRead()` | 连续读拆分单位 | 构造页级 `MEM_SCATTER` |
| `LcReadScatter()` | 通用请求列表 | 地址翻译、锁、后端分发 |
| `device_fpga.c` | PCIe outstanding read 事务 | MRd/CplD、tag、credit、回填 |
| FPGA HDL | TLP 字节流 | FIFO、跨时钟域、TLP 转发 |

这不是重复管理，而是不同层级的管理。

## 4. PCIe MRd/CplD 流水线基础

PCIe 读请求由 Memory Read Request TLP 发起，返回由 Completion TLP 完成：

| TLP | 含义 |
| --- | --- |
| `MRd32` / `MRd64` | Memory Read Request，读请求 |
| `CplD` | Completion with Data，携带返回数据 |
| `Cpl` | Completion without Data，常用于异常/状态场景 |

如果没有流水线，读路径类似：

```text
发送 MRd(page0)
等待 CplD(page0)
发送 MRd(page1)
等待 CplD(page1)
...
```

流水线方式则是：

```text
发送 MRd(page0, tag=0x01)
发送 MRd(page1, tag=0x02)
发送 MRd(page2, tag=0x03)
发送 MRd(page3, tag=0x04)
...

CplD(tag=0x02) 返回 -> 回填 page1
CplD(tag=0x01) 返回 -> 回填 page0
CplD(tag=0x03) 返回 -> 回填 page2
```

因为返回可能乱序，所以必须依赖 tag：

```text
MRd.Tag = X
CplD.Tag = X
```

PC 端根据 `CplD.Tag` 查表找到对应 `MEM_SCATTER`。

## 5. Async2 的 tag 表和 scatter 上下文

`device_fpga.c` 中 Async2 的核心结构包括：

```c
typedef enum tdFPGA_NEWASYNC2_TAG_TYPE {
    FPGA_NEWASYNC2_TAG_TYPE_NONE = 0,
    FPGA_NEWASYNC2_TAG_TYPE_4K = 1,
    FPGA_NEWASYNC2_TAG_TYPE_TINY = 2
} FPGA_NEWASYNC2_TAG_TYPE;

typedef struct tdFPGA_NEWASYNC2_TAG_ENTRY {
    FPGA_NEWASYNC2_TAG_TYPE tp;
    WORD oMEM;
    union { WORD cbTag; WORD cCpl; };
    PMEM_SCATTER pMEM;
    PFPGA_NEWASYNC2_MEM_CONTEXT pMemContext;
} FPGA_NEWASYNC2_TAG_ENTRY;

typedef struct tdFPGA_NEWASYNC2_CONTEXT {
    BOOL fEnabled;
    BOOL fOldAsync;
    OVERLAPPED oOverlapped;
    POB_MAP pmQueue;
    BYTE iTag;
    DWORD cAvailTags;
    DWORD cbAvailCredits;
    FPGA_NEWASYNC2_TAG_ENTRY Tags[0x100];
} FPGA_NEWASYNC2_CONTEXT;
```

其中最重要的是：

```text
ctx->async2.Tags[tag].pMEM
```

这就是：

```text
tag -> MEM_SCATTER
```

的映射表。

每次 scatter 批量读会被包装成一个 `FPGA_NEWASYNC2_MEM_CONTEXT`：

```text
MemCtx.cMEM     = 本批 MEM_SCATTER 数量
MemCtx.ppMEMs   = MEM_SCATTER 指针数组
MemCtx.iMem     = 当前已调度到第几个 MEM
MemCtx.cMemCpl  = 已完成多少个 MEM
```

这些结构都在 PC 端 LeechCore 内存里。FPGA HDL 不知道 `MEM_SCATTER`，也不维护 `tag -> pMEM`。

## 6. tag 分配和 MRd 构造

Async2 使用 `DeviceFPGA_Async2_Read_TxTlp_NextTag()` 找空闲 tag：

```text
从 ctx->async2.iTag 开始递增
跳过保留范围
找到 Tags[iTag].tp == NONE 的项
返回 iTag
```

对于普通 4KB 页读，`DeviceFPGA_Async2_Read_TxTlpSingle()` 做：

```text
pMEM = pTX->ppMEMs[pTX->iMem]
iTag = NextTag()
pTag = &ctx->async2.Tags[iTag]
pTag->tp = FPGA_NEWASYNC2_TAG_TYPE_4K
pTag->pMemContext = pTX
pTag->pMEM = pMEM
ctx->async2.cbAvailCredits -= 0x1000
ctx->async2.cAvailTags--
DeviceFPGA_Async2_Read_TxTlpSingle_MrdTlp(..., iTag, pMEM->qwA)
```

这一步建立了：

```text
tag X -> pMEM
```

然后构造 MRd TLP：

```text
hdrRd32/hdrRd64->TypeFmt     = TLP_MRd32 或 TLP_MRd64
hdrRd32/hdrRd64->Length      = wTlpDwLength
hdrRd32/hdrRd64->RequesterID = ctx->wDeviceId
hdrRd32/hdrRd64->Tag         = iTag
hdrRd32/hdrRd64->Address     = pMEM->qwA
```

所以 tag 是 PC 端分配并写入 TLP 的。

## 7. CplD 回填和 tag 释放

CplD 返回后，PC 端解析 TLP：

```text
hdrC = (PTLP_HDR_CplD)pb
pTag = ctx->async2.Tags + hdrC->Tag
pMEM = pTag->pMEM
```

对于 4KB completion：

```text
o = 0x1000 - (hdrC->ByteCount ? hdrC->ByteCount : 0x1000)
c = hdr->Length << 2
memcpy(pMEM->pb + o, pb + 12, c)
MEM_SCATTER_STACK_ADD(pMEM, 1, c)
```

当该 `pMEM` 收满：

```text
pTag->pMemContext->cMemCpl++
```

然后释放 tag/credit：

```text
ctx->async2.cAvailTags++
ctx->async2.cbAvailCredits += 0x1000
pTag->tp = NONE
pTag->pMemContext = NULL
pTag->pMEM = NULL
```

这就是流水线滑动窗口：

```text
发出 MRd -> 消耗 tag/credit
收到 CplD -> 回填数据 -> 释放 tag/credit
释放窗口 -> 继续补发 MRd
```

## 8. 流水线性质在源码中的体现

流水性主要体现在三个方面。

### 8.1 TX 循环连续发送多个 MRd

`DeviceFPGA_Async2_Read_TxTlp()` 中有：

```text
while(pTX->iMem < pTX->cMEM) {
    if tag/credit 不够:
        break
    DeviceFPGA_Async2_Read_TxTlpSingle(...)
    pTX->iMem++
}
```

它不是一次只发一个页，而是在窗口允许时连续推进多个 `MEM_SCATTER`。

### 8.2 tag/credit 是 outstanding window

发送时：

```text
ctx->async2.cAvailTags--
ctx->async2.cbAvailCredits -= 0x1000
```

完成时：

```text
ctx->async2.cAvailTags++
ctx->async2.cbAvailCredits += 0x1000
```

这类似 TCP 滑动窗口：

```text
窗口未满 -> 继续发
窗口满了 -> 暂停
CplD 返回 -> 窗口释放 -> 继续发
```

### 8.3 主循环 RX 和 TX 交错

`DeviceFPGA_Async2_ReadScatter_DoWork()` 的核心循环顺序是：

```text
先发第一批 MRd
读取 FPGA 返回 buffer
解析已收到的 CplD
继续发送新的 MRd
继续读取返回
直到 cMemCpl == cMEM
```

关键逻辑是：

```text
DeviceFPGA_Async2_Read_RxTlpFromBuffer(...)
DeviceFPGA_Async2_Read_TxTlp(...)
```

即：

```text
处理返回 -> 释放窗口 -> 补发请求
```

这正是流水线性质。

## 9. Sync 路径也有批处理，但流水程度较弱

如果 Async2 未启用，走 `DeviceFPGA_Synch_ReadScatter()`。

同步路径也会批量生成 MRd，并用 `TLP_CallbackMRd_Scatter()` 根据 tag 回填 scatter：

```text
rxbuf.pph = ppMEMs + i
bTag = 0 或 0x80
MRd.Tag = bTag
CplD.Tag -> pBufferMrd_Scatter->pph[tag & 0x7f]
memcpy(pMEM->pb + offset, payload, length)
```

但 Sync 更接近：

```text
发一批 MRd
flush
等待一批 CplD
处理返回
下一批
```

Async2 更接近真正流水：

```text
一边处理返回
一边继续补发
```

## 10. `acorn_ft2232h` FPGA 工程中的角色

`acorn_ft2232h` 工程主要由这些模块组成：

```text
pcileech_acorn_top
  -> pcileech_com
  -> pcileech_fifo
  -> pcileech_pcie_a7
      -> pcileech_pcie_tlp_a7
      -> Xilinx pcie_7x_0 core
```

### 10.1 Host -> FPGA -> PCIe

MRd 发送路径：

```text
PC / LeechCore 构造 MRd TLP
  -> FT2232H/FT245 8-bit bus
  -> pcileech_com 8-bit -> 64-bit
  -> pcileech_fifo 根据 magic/type 路由到 TLP
  -> pcileech_pcie_tlp_a7 32-bit DWORD -> 64-bit AXI-Stream
  -> Xilinx PCIe Core s_axis_tx
  -> PCIe link
```

### 10.2 PCIe -> FPGA -> Host

CplD 返回路径：

```text
PCIe link
  -> Xilinx PCIe Core m_axis_rx
  -> pcileech_pcie_tlp_a7 RX FIFO
  -> pcileech_fifo mux port0
  -> pcileech_com 256-bit -> 32-bit -> 8-bit
  -> FT2232H/FT245
  -> PC / LeechCore
```

FPGA 侧主要负责：

- TLP 流转发。
- 跨时钟域 FIFO。
- 发送/接收缓冲。
- TLP/CFG/CMD/loopback 路由。
- 返回数据打包。

FPGA 侧不负责：

- `MEM_SCATTER` 队列管理。
- tag 分配。
- `tag -> pMEM` 映射。
- CplD payload 回填到哪个 `MEM_SCATTER.pb`。

这些都在 PC 端 `device_fpga.c` 中。

## 11. FT2232H 下的流水特点

`acorn_ft2232h` 使用 FT2232H，属于 USB2.0 + 8-bit FT245 接口。其带宽远低于 PCIe x1 Gen2。

因此在 FT2232H 上，流水线的收益主要是：

- 减少每页一次请求/等待的往返开销。
- 保持 FPGA 输入 FIFO 有数据。
- 保持 PCIe Core 能连续收到 MRd。
- 让 CplD 返回尽量形成连续流。
- 通过 tag/credit 控制避免无限制堆积。

源码里 Async2 有：

```text
fAsync = !ctx->dev.f2232h
```

这说明 FT2232H 下不使用 Windows overlapped async read。但这不等于没有流水。FT2232H 下仍然有：

```text
多个 MRd outstanding
tag 表
credit 窗口
CplD 返回后释放 tag
继续补发 MRd
FPGA 内部 FIFO
FT245 收发状态机
```

只是 USB pipe 读取方式更同步，流水程度不如 FT601/USB3 充分。

## 12. 为什么 `device_fpga.c` 需要继续管理 4KB 读

`LcReadScatter()` 已经管理了 4KB 页级请求，但它只管理“内存请求抽象”。

`device_fpga.c` 继续管理 4KB，是因为 4KB 在 PCIe 后端层变成了：

```text
一个 outstanding read transaction
可能由一个 MRd 发起
可能由多个 CplD 返回
需要 tag 跟踪
需要 offset 拼接
需要 completion 计数
需要失败和 retry 处理
```

因此：

```text
LcReadScatter() 的 4KB = 软件 API 层的页粒度请求
device_fpga.c 的 4KB = PCIe 后端的 outstanding read 事务单位
```

同一个 4KB，在不同层语义不同。

## 13. 完整读流水示例

以 16MB dump 为例：

```text
16MB -> 4096 个 4KB MEM_SCATTER
```

完整流程：

```text
1. LcRead() 或上层 dump 构造 4096 个 MEM_SCATTER。
2. LcReadScatter() 做地址翻译和后端分发。
3. DeviceFPGA_Async2_ReadScatter() 创建 MemCtx。
4. DeviceFPGA_Async2_Read_TxTlp() 开始调度 ppMEMs。
5. 对 page0 分配 tag0，登记 Tags[tag0].pMEM = page0。
6. 构造 MRd(page0, tag0)，发给 FPGA。
7. 对 page1 分配 tag1，登记 Tags[tag1].pMEM = page1。
8. 构造 MRd(page1, tag1)，发给 FPGA。
9. 持续发送，直到 tag/credit 窗口不足。
10. FPGA 通过 PCIe Core 发出 MRd。
11. 目标主机返回 CplD。
12. FPGA 把 CplD 打包送回 PC。
13. PC 解析 CplD.Tag。
14. pMEM = Tags[CplD.Tag].pMEM。
15. memcpy 到 pMEM->pb + offset。
16. 如果 pMEM 收满，cMemCpl++，释放 tag/credit。
17. TX 调度继续补发后续 page 的 MRd。
18. 直到 cMemCpl == cMEM。
```

## 14. 最终总结

PCILeech/LeechCore 的读性能来自多层流水：

```text
软件 API 层：
  LcRead -> 4KB MEM_SCATTER 批量请求

LeechCore 通用层：
  LcReadScatter -> 地址翻译、统一后端分发

FPGA 后端软件层：
  device_fpga.c -> MRd 构造、tag 分配、credit 窗口、CplD 回填

FPGA 硬件层：
  acorn_ft2232h -> FT245/FIFO/PCIe Core TLP 流转发

PCIe 协议层：
  多个 MRd outstanding，CplD 按 tag 返回
```

最核心的性能闭环是：

```text
MEM_SCATTER pMEM
  -> 分配 iTag
  -> Tags[iTag].pMEM = pMEM
  -> MRd.Tag = iTag
  -> CplD.Tag = iTag
  -> pMEM = Tags[CplD.Tag].pMEM
  -> memcpy(pMEM->pb + offset, CplD.payload, length)
  -> 释放 tag/credit
  -> 补发新的 MRd
```

这就是“流水”的本质：

> 始终保持多个读请求在 PCIe/FPGA/USB 通道中飞行，用 tag/credit 控制 outstanding window，用 CplD 返回释放窗口并继续补发，从而隐藏单个读请求的等待时间，提高整体吞吐。
