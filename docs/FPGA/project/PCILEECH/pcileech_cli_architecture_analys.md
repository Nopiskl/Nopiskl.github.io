# PCILeech CLI architecture analysis
_Exported on 2026/6/4 at GMT+8 1:30:36 from Cursor (2.6.21)_

---

**User**

@PCILEECH架构分析.md 
基于这个文档，解答我的一些问题
按照架构设计1，理论上pcileech cli只应该负责命令调度，但是为什么实际它还负责很多细节方面的操作
BOOL DeviceReadMEM(QWORD qwAddr, DWORD cb, PBYTE pb, BOOL fRetryOnFail)
{
    if(ctxMain->phKMD && !ctxMain->cfg.fNoKmdMem) {
        return KMDReadMemory(qwAddr, pb, cb);
    }
    return LcRead(ctxMain->hLC, qwAddr, cb, pb) ||
           (fRetryOnFail && LcRead(ctxMain->hLC, qwAddr, cb, pb));
}
例如这些
以及DeviceReadDMA
cMEMs = cb >> 12;
LcAllocScatter2(cb, pb, cMEMs, &ppMEMs);

for(i = 0; i < cMEMs; i++) {
    ppMEMs[i]->qwA = pa + ((QWORD)i << 12);
}

LcReadScatter(ctxMain->hLC, cMEMs, ppMEMs);
还需要分批次构造，这些为什么不解耦出来？

---

**Cursor**

我先看一下你提到的架构分析文档和相关代码位置，再结合实际实现回答。

文档后半部分可能有相关结论，我继续读取，同时定位 `device.c` 的实现细节。

你的理解基本是对的：**如果按一个非常理想化的分层架构，`pcileech` CLI 应该只做参数解析和 action 调度**。但当前源码里实际不是“纯 CLI”，而是：

```text
pcileech.exe 产品层
  ├─ pcileech.c        参数解析 / action 分发 / 生命周期
  ├─ memdump.c         dump 业务逻辑
  ├─ mempatch.c        patch/search 业务逻辑
  ├─ kmd.c             KMD 业务逻辑
  ├─ vmmx.c / vfs.c    VMM/VFS 业务逻辑
  └─ device.c          PCILeech 自己的设备访问策略门面
```

所以文档里说的 “pcileech CLI / Action Dispatcher” 更准确地讲是 **PCILeech 产品层**，不等于只有 `pcileech.c` 一个文件，也不等于它完全不包含任何策略逻辑。

---

## 1. `DeviceReadMEM()` 为什么在上层，而不是完全交给 LeechCore？

你举的这个函数：

```c
BOOL DeviceReadMEM(QWORD qwAddr, DWORD cb, PBYTE pb, BOOL fRetryOnFail)
{
    if(ctxMain->phKMD && !ctxMain->cfg.fNoKmdMem) {
        return KMDReadMemory(qwAddr, pb, cb);
    }
    return LcRead(ctxMain->hLC, qwAddr, cb, pb) ||
           (fRetryOnFail && LcRead(ctxMain->hLC, qwAddr, cb, pb));
}
```

它做的事情不是单纯“读内存”，而是 **PCILeech 产品语义下的读内存策略选择**：

1. 如果当前已经加载 KMD，并且用户没有指定 `-no-kmd-mem`，优先走 `KMDReadMemory()`。
2. 否则走 LeechCore 的 `LcRead()`。
3. 如果调用方允许失败重试，就再读一次。

这里的关键点是：**KMD 优先级、`-no-kmd-mem`、retry 策略都不是 LeechCore 的通用职责，而是 PCILeech CLI 工具自己的行为策略。**

LeechCore 只知道：

```text
给我一个 hLC，我从某个采集源读物理内存。
```

但它不应该知道：

```text
当前 PCILeech 是否加载了 KMD？
用户是否指定 -no-kmd-mem？
这个 action 是否想 retry？
KMD 路径和 DMA 路径谁优先？
```

所以 `DeviceReadMEM()` 放在 `pcileech/device.c` 是合理的。它不是底层设备驱动，而是 **PCILeech 对 LeechCore 和 KMD 的访问门面**。

更准确的职责划分应该是：

```text
action 层：
  我要读目标内存

pcileech/device.c：
  决定这次读应该走 KMD 还是 LeechCore
  决定是否 retry
  屏蔽 KMD / DMA 差异

LeechCore：
  如果走 DMA，负责具体采集源抽象

LeechCore backend：
  FPGA / USB3380 / file / pmem / remote 等具体实现
```

所以这不是 CLI 越界到硬件细节，而是 `device.c` 在做 **产品级访问策略**。

---

## 2. `DeviceReadDMA()` 为什么自己构造 `MEM_SCATTER`？

你提到的逻辑：

```c
cMEMs = cb >> 12;
LcAllocScatter2(cb, pb, cMEMs, &ppMEMs);

for(i = 0; i < cMEMs; i++) {
    ppMEMs[i]->qwA = pa + ((QWORD)i << 12);
}

LcReadScatter(ctxMain->hLC, cMEMs, ppMEMs);
```

表面看像是上层在处理 LeechCore 细节，但这里有几个实际原因。

---

### 原因一：`DeviceReadDMA()` 需要逐页统计成功/失败

`DeviceReadDMA()` 不只是读一块连续内存，它还会统计每一页是否成功：

```text
每个 4KB 页：
  成功 -> cbRead += pMEM->cb
  失败 -> ZeroMemory(...)
  如果有 pPageStat -> PageStatUpdate(...)
```

这就是为什么它不能简单调用：

```c
LcRead(ctxMain->hLC, pa, cb, pb)
```

因为 `LcRead()` 返回的是整体是否成功，抽象层更高。  
而 `DeviceReadDMA()` 需要拿到每个 `MEM_SCATTER` 的 `f` 字段，也就是逐页结果。

这个逐页结果对 dump、scan、统计、容错很重要。物理内存采集时，经常存在：

- 某些物理页不可读；
- memory hole；
- MMIO 区域；
- IOMMU / VT-d 影响；
- 设备 timeout；
- FPGA/USB 传输异常；
- memory map remap 后部分页无效。

如果只用 `LcRead()`，失败可能变成“整块失败”。  
但 dump 工具更希望：

```text
能读多少读多少；
失败页置零；
继续向后 dump；
统计成功/失败页面。
```

所以 `DeviceReadDMA()` 选择直接使用 `LcReadScatter()`。

---

### 原因二：`MEM_SCATTER` 是 LeechCore 暴露给上层的性能协议，不是内部细节

`MEM_SCATTER` 并不是 LeechCore 不小心泄漏出来的内部结构，而是它的核心公共 API 之一。

LeechCore 提供两类读接口：

```text
LcRead()
  简单连续读，适合普通调用

LcReadScatter()
  批量页读，适合高性能 dump / scan / 分散地址读取
```

也就是说，LeechCore 的设计本来就允许上层直接构造 scatter 请求。

原因是不同上层可能想表达不同的读模式：

```text
连续读：
  pa, pa+0x1000, pa+0x2000 ...

非连续读：
  page A, page B, page C ...

页表遍历：
  PML4E/PDPTE/PDE/PTE 分散读取

进程扫描：
  多个候选地址批量读取

dump：
  大范围连续页读取，但需要逐页成功状态
```

如果 LeechCore 把 scatter 完全隐藏掉，上层就失去了对批量读语义的控制。

---

### 原因三：`LcRead()` 其实已经帮你解耦了一次

文档里也提到过：`LcRead()` 本身内部会把连续读转换成 scatter，再调用 `LcReadScatter()`。

也就是说，如果只是普通读：

```c
DeviceReadMEM(...)
  -> LcRead(...)
     -> 内部构造 MEM_SCATTER
     -> LcReadScatter(...)
```

但 `DeviceReadDMA()` 不是普通读。它需要：

1. 要求地址和长度 4KB 对齐；
2. 明确按页读取；
3. 获取每页成功/失败；
4. 失败页置零；
5. 更新 `PAGE_STATISTICS`；
6. 返回实际成功读取字节数，而不是简单 BOOL。

这些都是 `LcRead()` 这个便利接口无法表达的。

所以 `DeviceReadDMA()` 直接构造 `MEM_SCATTER` 是为了拿到更细粒度控制。

---

## 3. 为什么不再解耦出一个独立模块？

你这个问题很关键。理论上当然可以进一步拆，比如：

```text
pcileech.c
  只负责 main/action dispatch

memory_access.c
  DeviceReadMEM / DeviceWriteMEM / KMD-vs-DMA 策略

dma_scatter.c
  连续页 -> MEM_SCATTER 构造
  scatter 结果统计
  失败页置零

kmd_access.c
  KMD read/write 包装

leechcore_adapter.c
  LcRead/LcWrite/LcReadScatter 封装
```

这样会更符合“干净架构”。

但当前项目没有这么拆，主要有几个现实原因。

---

### 3.1 这是历史演进型 C 工具项目，不是从零设计的框架

PCILeech 是一个长期演进的命令行工具。它最初的目标是：

```text
快速、直接、稳定地完成内存采集/写入/执行等任务。
```

这种 C 项目常见风格是：

```text
全局 ctxMain
+ 一批 action 文件
+ 一个 device.c 门面
+ LeechCore 作为真正可复用库
```

它追求的是工程实用性，而不是严格 Clean Architecture。

---

### 3.2 `device.c` 已经是一次解耦

虽然你觉得 CLI 做了很多细节，但注意这些代码并没有直接散落在 `pcileech.c` 的 action switch 里面，而是集中在 `pcileech/device.c`。

也就是说，作者已经做了一层：

```text
Action 代码
  不直接判断 KMD / DMA / LcRead / LcReadScatter

统一调用：
  DeviceReadMEM()
  DeviceWriteMEM()
  DeviceReadDMA()
  DeviceWriteDMA_Retry()
  DeviceWriteDMA_Verify()
```

这层的定位就是：

```text
PCILeech memory access facade
```

它不属于 LeechCore，因为里面有 PCILeech 专属策略；  
它也不完全属于 CLI dispatcher，因为它服务于多个 action。

所以与其说“没有解耦”，不如说它采用了一个比较粗粒度的解耦：

```text
pcileech.c       命令解析和调度
device.c         PCILeech 设备访问策略
LeechCore        通用采集库
backend          具体设备
```

只是没有继续拆得更细。

---

### 3.3 有些策略不能下沉到 LeechCore

比如 `DeviceReadMEM()` 里的这句：

```c
if(ctxMain->phKMD && !ctxMain->cfg.fNoKmdMem)
```

这个判断绝对不适合放进 LeechCore。

因为 LeechCore 是通用采集库，它可能被 MemProcFS、其他工具、RPC、插件使用。它不应该依赖 PCILeech 的：

```text
ctxMain
cfg
KMD handle
-no-kmd-mem
PCILeech action 语义
```

如果把这些塞进 LeechCore，反而会污染库边界。

---

### 3.4 `DeviceReadDMA()` 的页统计也是 PCILeech dump 语义

`PageStatUpdate()`、失败页置零、返回成功字节数，这些也是 PCILeech 工具行为，不是所有 LeechCore 用户都需要。

LeechCore 的职责是：

```text
这个 scatter 请求是否成功？
底层设备怎么完成？
memory map 怎么翻译？
```

PCILeech 的职责是：

```text
失败页要不要置零？
失败页怎么统计？
dump 进度怎么显示？
读失败是否影响整个 action？
```

所以这部分留在 PCILeech 层是合理的。

---

## 4. `DeviceReadDMA()` 构造 scatter 是“批量描述”，不是底层批次调度

你说“还需要分批次构造”，这里要区分两件事：

### 上层构造的是逻辑页请求

`DeviceReadDMA()` 构造的是：

```text
我要读 pa 开始的 N 个 4KB page。
```

也就是逻辑任务描述。

### 真正的设备批处理在 LeechCore/backend 内部

比如 FPGA 后端拿到 scatter 之后，才会进一步决定：

```text
一次发多少 MRd TLP？
如何流水线？
completion 怎么收？
timeout 怎么处理？
哪些地址跳过？
是否合并连续地址？
```

这些没有放在 `DeviceReadDMA()` 里面。

所以 `DeviceReadDMA()` 并没有负责真正底层批次调度，它只是把“连续大块读”转换成 LeechCore 能批量优化的 scatter 形式。

更准确地说：

```text
DeviceReadDMA:
  构造页级读请求列表

LcReadScatter:
  memory map 翻译、加锁、调用后端

FPGA/backend:
  设备级批处理、TLP/USB/file/RPC 实际执行
```

---

## 5. 为什么不用一个更高级的 API，比如 `LcReadPagesWithStats()`？

这是可以设计的，但作者没有这么做，可能是因为：

1. LeechCore 要保持 API 简洁；
2. `PAGE_STATISTICS` 是 PCILeech 自己的数据结构；
3. 失败页置零策略不一定适合所有调用者；
4. KMD/DMA 优先策略不属于 LeechCore；
5. scatter API 已经足够表达所有高级场景；
6. C API 过度封装会增加维护成本；
7. PCILeech 本身是 LeechCore 的主要上层之一，作者接受上层直接用 scatter。

如果设计一个新接口，大概会变成这样：

```c
DWORD DeviceReadPhysicalPages(
    QWORD pa,
    DWORD cb,
    PBYTE pb,
    PPAGE_STATISTICS pPageStat,
    DWORD flags
);
```

或者更抽象：

```c
BOOL MemoryAccess_Read(
    PMEMORY_ACCESS ctx,
    QWORD addr,
    DWORD cb,
    PBYTE pb,
    MEMORY_READ_MODE mode,
    PMEMORY_READ_RESULT result
);
```

但这样做会让项目更“架构化”，同时也更重。对当前 C 工具而言，作者可能觉得收益不够大。

---

## 6. 所以结论是什么？

一句话总结：

**PCILeech 的 CLI 层并不是纯粹的命令调度器，而是产品层；`device.c` 是 PCILeech 产品层中的设备访问策略门面。它保留了 KMD-vs-DMA、retry、失败页置零、页统计、scatter 构造这些上层策略；真正的设备抽象、memory map、后端批处理仍然在 LeechCore。**

你可以把它理解成三种边界：

```text
pcileech.c:
  用户命令是什么？

pcileech/device.c:
  PCILeech 应该用什么方式读写目标内存？
  KMD 还是 DMA？
  是否 retry？
  是否统计页成功率？
  失败页如何处理？

LeechCore:
  给定一组物理内存读写请求，如何通过当前采集源完成？

LeechCore backend:
  FPGA / USB3380 / file / pmem / remote 具体怎么执行？
```

所以它不是完全没有解耦，而是采用了这种划分：

```text
业务动作和设备访问策略解耦；
PCILeech 产品策略和 LeechCore 通用采集能力解耦；
但 PCILeech 内部没有进一步把 device.c 拆成很多小 service。
```

如果你从架构洁癖角度看，确实可以继续拆。  
如果从这个项目的历史、C 风格、性能路径和维护成本看，现在这样也有它的合理性。

