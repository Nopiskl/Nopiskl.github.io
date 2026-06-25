# PCILeech 架构分析

本文档基于当前仓库源码，对 PCILeech 与 LeechCore 的分层架构、关键数据流和核心设计点做整理。重点关注 `pcileech` CLI、`LeechCore`、`MEM_SCATTER`、FPGA 后端、KMD、MemProcFS/VMM 等模块之间的职责边界。

## 1. 总体架构

PCILeech 可以理解成一个“三层半”的设计：

```text
pcileech.exe CLI / Action Dispatcher
  |
  |  命令解析、任务编排、dump/search/patch/mount/tlp/kmd/agent 等动作
  v
pcileech/device.c 设备门面层
  |
  |  DeviceReadDMA / DeviceReadMEM / DeviceWriteMEM
  |  有 KMD 时优先走 KMD，没有 KMD 时走 LeechCore 原生 DMA/采集
  v
LeechCore API
  |
  |  LcCreate / LcRead / LcReadScatter / LcWrite / LcCommand / LcGetOption
  |  统一内存采集接口、内存映射、scatter/gather、远程代理、插件
  v
LeechCore device backend
  |
  |  device_fpga.c / device_usb3380.c / device_file.c / device_pmem.c / ...
  v
硬件/软件采集源
  FPGA TLP / FT601 / FT2232H / RawUDP / USB3380 / dump file / pmem / rpc
```

这里“半层”指的是 KMD、MemProcFS/VMM、VFS、Executor 等高级能力模块。它们不属于纯设备采集层，但会借助 `LeechCore` 提供的物理内存读写能力，在上层实现目标系统语义、内核模块通信、文件系统挂载、shellcode 执行等功能。

## 2. pcileech CLI 层

`pcileech.exe` 是命令行产品层。它关心的是“用户想做什么”，而不是“底层设备如何读内存”。

入口位于：

- `pcileech/pcileech.c`
- `main()`
- `PCILeechConfigIntialize()`

主流程大致如下：

```text
解析命令行参数
  -> 初始化 ctxMain 全局上下文
  -> 判断 action 类型
  -> DeviceOpen 打开采集设备
  -> 如有 -kmd，调用 KMDOpen
  -> switch(action) 分发到具体功能
  -> 清理 KMD / VMM / LeechCore / mount
```

CLI 层将用户输入映射为 `ACTION_TYPE`：

```text
dump             -> ActionMemoryDump()
write            -> ActionMemoryWrite()
display          -> ActionMemoryDisplay*
patch/search     -> ActionPatchAndSearch*
kmdload/kmdexit  -> KMDOpen / KMDUnload
tlp/tlploop      -> FPGA TLP 相关动作
probe            -> FPGA memory probe
regcfg           -> FPGA config/register 操作
mount            -> ActionMount()
pslist           -> MemProcFS/VMM 相关进程枚举
agent-execpy     -> LeechAgent 远程 Python 分析
```

这一层保留的是工具行为：

- 用户参数。
- 输出文件。
- 进度统计。
- 是否使用 KMD。
- 是否虚拟地址模式。
- 是否 force/retry。
- 外部命令模块。
- MemProcFS/VMM 句柄。

这些都属于 PCILeech 产品语义，不属于通用内存采集库语义。

## 3. ctxMain 全局上下文

PCILeech 使用一个全局上下文 `ctxMain` 串起各个模块。结构体位于 `pcileech/pcileech.h`：

```c
struct tdPCILEECH_CONTEXT {
    DWORD magic;
    DWORD version;
    CONFIG cfg;
    HANDLE hLC;
    LC_CONFIG dev;
    HANDLE hDevice;
    PKMDHANDLE phKMD;
    PKMDDATA pk;
    VFS_CONTEXT vfs;
    DWORD argc;
    char** argv;
    VMM_HANDLE hVMM;
};
```

重要字段含义：

| 字段 | 作用 |
| --- | --- |
| `cfg` | 命令行配置与 action 参数 |
| `hLC` | LeechCore handle |
| `dev` | LeechCore 的 `LC_CONFIG`，打开设备后会回填设备能力 |
| `phKMD` / `pk` | KMD 通信状态 |
| `vfs` | mount/VFS 状态 |
| `hVMM` | MemProcFS/VMM 句柄 |

这是典型 C 工具项目的“全局上下文 + 命令分发”设计。优点是调用简单，各 action 都能访问共享状态；缺点是模块间隐式依赖较多，测试和并发扩展会更难。

## 4. pcileech/device.c 门面层

`pcileech/device.c` 是 PCILeech CLI 和 LeechCore 之间的适配层。它既不是纯 CLI，也不是设备驱动，而是 PCILeech 自己的“设备访问策略层”。

关键函数：

- `DeviceOpen()`
- `DeviceReadDMA()`
- `DeviceReadMEM()`
- `DeviceWriteMEM()`
- `DeviceReadDMA_Retry()`
- `DeviceWriteDMA_Retry()`
- `DeviceWriteDMA_Verify()`

### 4.1 DeviceOpen

`DeviceOpen()` 做默认设备选择：

```text
如果用户没有指定 -device:
  先尝试 FPGA
  再尝试 USB3380

如果用户指定 -device:
  直接交给 LeechCore
```

它最终会调用：

```c
LcCreateEx(&ctxMain->dev, &pLcErrorInfo)
```

也就是说，真正的设备识别、设备打开、后端选择，都由 LeechCore 完成。

### 4.2 DeviceReadMEM / DeviceWriteMEM

这两个函数体现了 PCILeech 上层策略：

```text
如果 KMD 已加载且没有 -no-kmd-mem:
  使用 KMDReadMemory / KMDWriteMemory

否则:
  使用 LcRead / LcWrite
```

这点很巧妙。上层 action 调用 `DeviceReadMEM()` 时，不需要知道当前读写路径到底是：

- 原生 DMA。
- FPGA。
- USB3380。
- 内存 dump 文件。
- 远程 LeechAgent。
- KMD 辅助读写。

策略被集中在 `device.c`，上层功能保持干净。

### 4.3 DeviceReadDMA

`DeviceReadDMA()` 面向大块物理内存读取。它要求地址和长度是 4KB 对齐，然后构造 `MEM_SCATTER` 数组：

```c
cMEMs = cb >> 12;
LcAllocScatter2(cb, pb, cMEMs, &ppMEMs);

for(i = 0; i < cMEMs; i++) {
    ppMEMs[i]->qwA = pa + ((QWORD)i << 12);
}

LcReadScatter(ctxMain->hLC, cMEMs, ppMEMs);
```

这让上层一次表达“我要读很多页”，而不是一页一页调用 `LcRead()`。对于 FPGA、远程采集、文件 dump 来说，这是性能关键。

## 5. LeechCore 核心层

LeechCore 是一个独立的物理内存采集库。它关心的是“从哪里、怎样高效读写物理内存”，不关心 PCILeech 的具体用户命令。

公共 API 位于 `LeechCore/includes/leechcore.h`：

```c
LcCreate()
LcClose()
LcRead()
LcReadScatter()
LcWrite()
LcWriteScatter()
LcGetOption()
LcSetOption()
LcCommand()
```

这个 API 设计非常克制。它没有 `dump`、`patch`、`mount` 这类产品功能，只提供通用采集能力。

## 6. LC_CONTEXT 与后端函数指针

LeechCore 内部上下文 `LC_CONTEXT` 位于 `LeechCore/leechcore/leechcore_device.h`。它像一个手写的虚表：

```c
BOOL(*pfnCreate)(...);
VOID(*pfnReadScatter)(...);
VOID(*pfnReadContigious)(...);
VOID(*pfnWriteScatter)(...);
BOOL(*pfnWriteContigious)(...);
BOOL(*pfnGetOption)(...);
BOOL(*pfnSetOption)(...);
BOOL(*pfnCommand)(...);
VOID(*pfnClose)(...);
```

不同设备后端只需要在 `DeviceXXX_Open()` 中填充这些函数指针，就能接入统一 API。

设备选择逻辑在 `LcCreate_FetchDevice()`：

```text
fpga/rawudp      -> DeviceFPGA_Open
usb3380          -> Device3380_Open
file/livekd      -> DeviceFile_Open
pmem             -> DevicePMEM_Open
vmware           -> DeviceVMWare_Open
vmm://           -> DeviceVMM_Open
rpc/smb/grpc     -> LeechRpc_Open
external plugin  -> leechcore_device_xxxx.dll/.so
```

这就是 LeechCore 的多态机制。上层只拿 `hLC`，底层具体是谁由 `LC_CONFIG.szDevice` 决定。

## 7. MEM_SCATTER 是性能核心

`MEM_SCATTER` 是 LeechCore 最重要的设计点。它定义在 `LeechCore/includes/leechcore.h`：

```c
typedef struct tdMEM_SCATTER {
    DWORD version;
    BOOL f;       // TRUE 表示成功
    QWORD qwA;    // 地址
    PBYTE pb;     // 数据缓冲区
    DWORD cb;     // 长度
    DWORD iStack;
    QWORD vStack[MEM_SCATTER_STACK_SIZE];
} MEM_SCATTER;
```

它表达一个内存读写任务：

```text
从地址 qwA 读/写 cb 字节，buffer 是 pb，结果状态写入 f。
```

### 7.1 LcRead 与 LcReadScatter 的关系

`LcRead()` 是便利接口。它会把连续读拆成 page 粒度的 scatter 请求，然后调用 `LcReadScatter()`：

```text
LcRead(hLC, pa, cb, pb)
  -> 计算覆盖多少个 4KB page
  -> 构造 MEM_SCATTER 数组
  -> 首尾不对齐时用临时 page buffer
  -> LcReadScatter(hLC, cMEMs, ppMEMs)
  -> 所有页成功后拷回用户 buffer
```

所以真正高性能的读路径是 `LcReadScatter()`。

### 7.2 LcReadScatter 的流程

`LcReadScatter()` 的核心流程：

```text
LcReadScatter(hLC, cMEMs, ppMEMs)
  |
  |-- 如果是 remote 且有 pfnReadScatter:
  |      直接交给远程读
  |
  |-- 本地 LeechCore:
         1. 保存原始地址到 MEM_SCATTER stack
         2. LcMemMap_TranslateMEMs 做 memory map 翻译
         3. 加锁
         4. 调用设备后端 pfnReadScatter
            或者把 scatter 聚合成 contiguous read
         5. 解锁
         6. 恢复原始地址
```

关键点是地址会被临时改写：

```text
上层看到的是目标物理地址
LeechCore memmap 可能把它 remap 成设备后端地址
后端完成后再恢复原始地址
```

这样上层统计、日志、dump offset 仍然使用用户语义的物理地址；后端只处理翻译后的地址。

### 7.3 为什么 MEM_SCATTER 提升性能

如果 dump 16MB 内存，用 4KB 页粒度会有 4096 个页面。如果一页一页读，每页都要经历设备请求、等待、返回，固定开销极大。

使用 `MEM_SCATTER` 后，上层可以一次提交：

```text
4096 个 page 读请求
```

底层后端可以按自己的最佳方式处理：

| 后端 | 优化方式 |
| --- | --- |
| FPGA | 批量生成 MRd TLP，流水线接收 CplD |
| 文件 | 合并连续 offset，减少 seek/read |
| 远程 | 打包、压缩、传输 |
| contiguous 后端 | LeechCore 聚合相邻 scatter 成大块读 |

所以 `MEM_SCATTER` 不只是数据结构，而是 PCILeech/LeechCore 之间的性能协议。

## 8. Memory Map 设计

物理内存采集并不等于从 `0` 到 `paMax` 全部顺序可读。中间可能存在：

- MMIO。
- 保留区。
- 不存在的物理地址洞。
- dump 文件中的 offset remap。
- 用户指定的 memory map。

LeechCore 把 memory map 统一放在核心层处理，而不是让每个后端重复实现。

`LcReadScatter()` 中会调用：

```c
LcMemMap_TranslateMEMs(ctxLC, cMEMs, ppMEMs);
```

翻译后，每个 scatter 可能变成：

```text
有效地址:
  qwA 保持不变或 remap 成后端地址

无效地址:
  qwA = MEM_SCATTER_ADDR_INVALID
```

后端只需要跳过 invalid 请求。上层可以按页记录成功/失败，失败页通常会置零。

这个设计让地址合法性和 remap 规则成为 LeechCore 的公共能力，而不是散落在 FPGA、USB3380、file、pmem、remote 等后端中。

## 9. FPGA 后端

FPGA 后端位于 `LeechCore/leechcore/device_fpga.c`。这是最复杂的设备后端，负责把 LeechCore 的 scatter 读写任务转换成 PCIe TLP 流。

`DeviceFPGA_Open()` 主要流程：

```text
解析 fpga:// 参数
  |
  +-- udp=...      -> DeviceFPGA_InitializeUDP
  +-- ft2232h=...  -> DeviceFPGA_InitializeFT2232
  +-- 默认         -> DeviceFPGA_InitializeFT601 / custom driver
  |
读取 FPGA 版本和 PCIe Device ID
设置 PCIe speed / performance profile
分配 rxbuf / txbuf
注册 LeechCore 回调:
  pfnReadScatter  = DeviceFPGA_ReadScatter_DoLock
  pfnWriteScatter = DeviceFPGA_WriteScatter_DoLock
  pfnCommand      = DeviceFPGA_Command_DoLock
```

### 9.1 FPGA 读路径

读路径：

```text
LcReadScatter
  -> memory map 翻译
  -> DeviceFPGA_ReadScatter_DoLock
      -> Async2 模式: DeviceFPGA_Async2_ReadScatter
      -> Sync 模式:  DeviceFPGA_Synch_ReadScatter
          -> 为每个 MEM_SCATTER 生成 MRd32/MRd64 TLP
          -> 通过 FT601/UDP/FT2232 发送给 FPGA
          -> 从 FPGA 接收 Completion TLP
          -> 根据 tag 把 CplD payload 填回 MEM_SCATTER.pb
```

低于 4GB 的地址使用 `MRd32`，高于 4GB 的地址使用 `MRd64`。FPGA 后端用 TLP tag 把请求和 completion 对应起来。

### 9.2 Sync 与 Async2

同步读模式：

```text
发一批 Memory Read TLP
flush
等待一批 Completion TLP
回填 MEM_SCATTER
```

Async2 模式：

```text
维护 tag/credit
一边发新的 MRd
一边异步收之前的 CplD
完成后释放 tag/credit
继续推进队列
```

Async2 更依赖大量 scatter 请求，因为只有批量任务足够多，才能让 PCIe/USB 链路形成流水线。

### 9.3 FPGA 写路径

写路径：

```text
LcWrite / LcWriteScatter
  -> memory map 翻译
  -> DeviceFPGA_WriteScatter
      -> 拆成 MWr32/MWr64 TLP
      -> 处理 dword 对齐和 byte enable
      -> 按最大 128 字节 payload 切分
      -> flush
```

写入比读取少了 completion 回填，但需要严格处理 TLP payload、byte enable 和边界。

### 9.4 LcCommand 与 FPGA 高级能力

通用读写用 `LcRead/LcWrite`，FPGA 特有能力通过 `LcCommand()` 暴露，例如：

- 原始 TLP 写入。
- TLP 转字符串。
- TLP callback。
- BAR callback。
- BAR info。
- PCIe config space。
- FPGA config register。
- memory probe。

这类似 `ioctl` 风格：公共 API 保持稳定，设备特性通过命令通道扩展。

## 10. Dump 数据流

以 `pcileech dump` 为例：

```text
main
  -> DeviceOpen
  -> ActionMemoryDump
      -> ActionMemoryDump_Native 或 ActionMemoryDump_KMD_USB3380
          -> DeviceReadDMA / Util_Read16M
              -> LcReadScatter
                  -> FPGA/USB3380/File/Remote backend
          -> 后台文件写线程写出 raw dump
```

`memdump.c` 按 16MB 块推进：

```text
while paCurrent < paMax:
  读 16MB 到 buffer
  后台线程写入文件
  paCurrent += 16MB
```

读 16MB 时，`DeviceReadDMA()` 会将其拆成：

```text
4096 个 4KB MEM_SCATTER
```

这批 scatter 交给 LeechCore，再由底层后端批处理。与此同时，文件写入使用独立线程，所以读设备和写磁盘可以部分并行。

## 11. KMD 层

KMD 是 PCILeech 的高级能力层，不属于 LeechCore。KMD 相关代码主要在：

- `pcileech/kmd.c`
- `pcileech/pcileech.h`
- `pcileech_shellcode/`

KMD 的通信结构是 `KMDDATA`，它必须位于目标内存中的一个 4KB page 内。主要字段包括：

- magic。
- DMA buffer 地址。
- 命令状态。
- 输入输出参数。
- dataIn/dataOut。
- 函数指针表。
- `_op` 命令字段。

应用侧通过 DMA/LeechCore 读写这页内存，设置 `_op`，然后等待目标内核侧代码处理。

典型流程：

```text
PCILeech 写 KMDDATA 参数
  -> 设置 _op = KMD_CMD_READ / WRITE / EXEC
  -> 目标 KMD 执行命令
  -> PCILeech 轮询状态
  -> 读取结果
```

`DeviceReadMEM()` 和 `DeviceWriteMEM()` 会在 KMD 存在时优先走 KMD，这使上层 action 不需要关心当前是否通过 KMD 访问内存。

这个分层也很重要：LeechCore 保持通用物理内存采集库定位；KMD、shellcode、patch 等 PCILeech 特有逻辑没有污染 LeechCore。

## 12. MemProcFS/VMM 集成

MemProcFS/VMM 由 `pcileech/vmmx.c` 集成。`Vmmx_Initialize()` 传给 `VMMDLL_Initialize()` 的设备参数是：

```text
-device existing
```

这表示 MemProcFS 复用当前已经打开的 LeechCore 设备。

设计效果：

```text
PCILeech 打开 FPGA/USB3380/file/remote
  |
  +-- PCILeech 自己用 hLC 做 dump/write/tlp
  |
  +-- MemProcFS 复用同一个 hLC 做进程、虚拟地址、OS 结构解析
```

职责边界：

| 模块 | 职责 |
| --- | --- |
| LeechCore | 提供物理内存采集 |
| MemProcFS/VMM | 解释 OS 结构、进程、虚拟内存 |
| PCILeech CLI | 编排用户命令 |

这个设计避免了重复打开硬件，也让物理采集和 OS 语义解析保持独立。

## 13. 插件扩展设计

项目有两个扩展方向。

### 13.1 LeechCore 设备插件

LeechCore 支持外部设备插件：

```text
leechcore_device_xxxx.dll
leechcore_device_xxxx.so
```

插件需要实现：

```c
BOOL LcPluginCreate(PLC_CONTEXT ctx);
```

这适合新增采集设备或虚拟化后端。

### 13.2 PCILeech 命令插件

PCILeech CLI 支持外部命令模块：

```text
leechp_<command>.dll/.so
```

模块需要导出：

```c
DoAction(PPCILEECH_CONTEXT ctx)
```

这适合扩展用户命令，而不改主程序。

两个插件方向分别对应：

```text
新增采集设备:
  扩展 LeechCore device plugin

新增用户工作流:
  扩展 PCILeech command plugin
```

## 14. 分层巧妙之处

### 14.1 产品功能和采集能力分离

`pcileech` 做 action 编排，`LeechCore` 做 memory acquisition。CLI 不需要知道硬件细节，LeechCore 不需要知道用户要 dump 还是 patch。

### 14.2 少量稳定 API 承载多种设备

LeechCore 的 API 很少，但通过内部函数指针接入多种后端：

```text
LcRead/LcWrite/LcCommand
  -> pfnReadScatter/pfnWriteScatter/pfnCommand
  -> device_fpga/device_file/device_usb3380/device_pmem/remote
```

### 14.3 MEM_SCATTER 作为性能协议

上层批量表达需求，底层自由优化传输。FPGA 可以流水线 TLP，远程可以打包压缩，文件可以聚合 seek/read。

### 14.4 Memory Map 放在核心层统一处理

地址合法性、物理地址洞、remap 规则都在 LeechCore 中统一处理，避免各后端重复实现。

### 14.5 高级能力通过旁路模块组合

KMD、MemProcFS、VFS、Executor 都挂在主流程旁边，而不是塞进 LeechCore。LeechCore 因此能作为独立库被 MemProcFS、Python/C# binding 或其他程序复用。

### 14.6 复杂性被压到正确的位置

FPGA 后端非常复杂，但复杂性留在 `device_fpga.c`。上层 `memdump.c`、`device.c`、`pcileech.c` 仍然用统一接口读写内存。

## 15. 设计代价

这个架构也有一些明显代价。

### 15.1 ctxMain 带来隐式耦合

全局上下文让 action 实现简单，但模块间依赖不够显式。长期维护时，需要小心某个模块修改全局状态后影响其他模块。

### 15.2 device_fpga.c 认知负担很高

FPGA 后端把 transport、TLP、BAR、配置寄存器、异步读写、性能 profile 都集中在一个文件里。局部性好，但文件很大，阅读和修改都需要非常谨慎。

### 15.3 LcCommand 类型安全弱

`LcCommand()` 类似 ioctl，灵活但依赖命令编号和 buffer 协议。新增能力容易，调试参数错误较难。

### 15.4 并发和关闭路径复杂

LeechCore 有全局 handle 链表，FPGA 有 callback 线程、overlapped I/O、queue、critical section。close path 和线程退出时序是维护重点。

## 16. 总结

PCILeech 的核心架构可以概括为：

```text
pcileech.exe:
  用户命令和任务编排

pcileech/device.c:
  PCILeech 语义下的设备访问策略

LeechCore:
  通用物理内存采集引擎

MEM_SCATTER:
  高性能批量读写协议

device_fpga.c:
  将 scatter 读写转换为 PCIe TLP 流

KMD / MemProcFS / VFS / Executor:
  基于物理内存读写构建更高级的目标系统能力
```

最值得学习的设计点是：上层命令越来越多、底层设备越来越多，但中间始终通过 LeechCore 和 `MEM_SCATTER` 这条清晰契约连接。CLI 不需要理解每种设备，设备后端也不需要理解每个用户命令。这是 PCILeech 能长期支持多硬件、多系统、多采集方式的关键。
