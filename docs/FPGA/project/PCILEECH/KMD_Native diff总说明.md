# PCILeech KMD 总说明

> 本文基于两份材料 `agent.txt` 与 `KMD相关分析总结.md`，并结合前面对 LeechCore、MEM_SCATTER、memory map、native DMA、KMD 读写路径和 MemProcFS 虚拟地址路径的分析整理。本文用于源码理解、架构学习和防护视角梳理，不提供面向第三方目标的操作指南。

---

## 1. 核心结论

PCILeech 里的 KMD（Kernel Module Assisted DMA）不是让 DMA “能够发生”的前提。Native DMA 本身就可以让 PCIe/FPGA/USB3380/LeechCore 后端直接读写目标物理地址。

KMD 的价值在于把低层 DMA 读写原语升级成目标内核态代理：

```text
Native DMA:
    外部设备/LeechCore 后端直接读写目标物理地址

KMD:
    host 通过 DMA 写 KMD 控制页提交命令
    目标内核里的 KMD 执行读写/查询/执行等操作
    KMD 通过 DMA buffer 把结果返回给 host
```

因此更准确的理解是：

```text
Native DMA 解决“能不能碰物理内存”；
KMD 解决“能不能从目标内核视角更可靠、更高层地操作目标系统”。
```

---

## 2. Native DMA 与 KMD 的分层

### 2.1 Native DMA 模式

Native DMA 模式中，PCILeech 设备或 LeechCore 后端直接对目标物理地址执行读写。

典型路径：

```text
DeviceReadDMA()
    -> LcReadScatter()
        -> LeechCore memory map 翻译
        -> 设备后端 pfnReadScatter()
```

或者：

```text
LcRead()
LcWrite()
LcReadScatter()
LcWriteScatter()
```

Native DMA 的特点：

- 面向物理地址或 bus/DMA 地址。
- 不经过目标 OS 的普通系统调用路径。
- 不理解目标 OS 的高层语义。
- 性能可以很高，尤其 FPGA 后端配合 MEM_SCATTER 批量发 TLP。
- 对 MMIO、hole、保留区等地址需要额外策略处理。
- 能力受硬件后端限制，例如某些 USB3380 native 路径对 4GB 以上地址支持有限。

### 2.2 KMD 模式

KMD 模式中，目标系统内核态运行一段 helper/shellcode。host 通过 DMA 与这段 KMD 通信。

抽象模型：

```text
PCILeech host
    |
    | DMA 写 4KB KMDDATA 控制页
    v
目标内核 KMD
    |
    | 内核态执行命令
    v
KMD DMA buffer
    |
    | host DMA 读/写
    v
PCILeech host
```

KMD 的本质：

```text
目标内核态代理 + 控制页 mailbox + DMA buffer 数据通道
```

---

## 3. LeechCore 背景：MEM_SCATTER 与 memory map

### 3.1 MEM_SCATTER

`MEM_SCATTER` 是 LeechCore 的批量内存 I/O 单元。它大致表达：

```text
从 qwA 读 cb 字节到 pb，完成后用 f 表示成功或失败。
```

它的价值不是结构体本身，而是让上层一次提交很多 page 级任务：

```text
上层:
    这里有 4096 个 page 要读

FPGA 后端:
    批量发 Memory Read TLP
    异步收 Completion
    用 tag 回填对应 MEM_SCATTER
```

因此 MEM_SCATTER 是 LeechCore 的性能核心之一。没有它，工具会退化成大量小 read/write，很难打满 PCIe/USB/远程链路。

### 3.2 LeechCore memory map 不是 MMU 页表

LeechCore memory map 是工具内部的软件地址翻译表，不是 CPU MMU 页表，也不是 IOMMU 页表。

它做的是：

```text
上层看到的目标物理地址
    -> 后端实际访问地址或 offset
```

例如：

```text
上层请求目标物理地址 0x00103000
dump 文件后端实际 seek offset 0x00023000
```

`LcReadScatter()` 会先保存原始 `qwA`，调用 memory map 翻译后临时改写 `qwA`，交给后端读，完成后再恢复原始 `qwA`。这样上层始终看到“目标物理地址语义”，而后端看到的是“自己实际可访问的地址语义”。

---

## 4. KMD 关键源码位置

| 文件 | 作用 |
|---|---|
| `pcileech/pcileech.h` | `KMDDATA`、`KMDHANDLE`、`KMD_CMD_*` |
| `pcileech/kmd.h` | KMD 对外接口声明 |
| `pcileech/kmd.c` | KMD 打开、加载、通信、读写、卸载 |
| `pcileech/device.c` | `DeviceReadMEM()` / `DeviceWriteMEM()` 中的 KMD 转发逻辑 |
| `pcileech/memdump.c` | dump 中 native/KMD 分支 |
| `pcileech/util.c` | `Util_Read16M()` 的 KMD fallback |
| `pcileech/vfs.c` | mount、`liveram-kmd.raw`、`/files` |
| `pcileech/executor.c` | KMD exec、`Exec_ExecSilent()` |
| MemProcFS `vmm/*` | 虚拟地址路径，通常不走 PCILeech 的 KMD wrapper |

---

## 5. KMD 的核心数据结构

### 5.1 `KMDDATA`

`KMDDATA` 是 host 与目标 KMD 之间的 4KB 通信页。核心字段：

| 字段 | 含义 |
|---|---|
| `MAGIC` | 标识有效 KMD 控制页 |
| `DMASizeBuffer` | KMD 管理的 DMA buffer 大小 |
| `DMAAddrPhysical` | DMA buffer 物理地址，host 用 DMA 访问 |
| `DMAAddrVirtual` | DMA buffer 在目标内核中的虚拟地址 |
| `_op` | 当前命令 |
| `_status` | 命令状态 |
| `_result` | 命令结果 |
| `_address` | 本次命令目标地址 |
| `_size` | 本次命令数据长度 |
| `OperatingSystem` | KMD 识别出的目标系统类型 |
| `dataIn*` / `dataOut*` | 扩展执行的输入输出 |
| `fn[32]` | KMD shellcode 保存的函数指针 |

控制页可以理解成 mailbox：

```text
host 写入参数 + _op
target KMD 执行命令
target KMD 写回 _status / _result
target KMD 设置 _op = KMD_CMD_COMPLETED
host 轮询读取控制页
```

### 5.2 `KMDHANDLE`

宿主端用 `KMDHANDLE` 保存 KMD 状态：

| 字段 | 含义 |
|---|---|
| `dwPageAddr32` | KMD 控制页在目标物理内存中的地址 |
| `cPhysicalMap` | 目标物理内存 map 条目数 |
| `pPhysicalMap` | 目标物理内存 map 数组 |
| `pk` | 指向本地 `pbPageData` 的 `KMDDATA *` |
| `pbPageData[4096]` | 本地缓存的 KMD 控制页 |

判断当前是否进入 KMD 模式的关键通常是：

```c
ctxMain->phKMD != NULL
```

---

## 6. KMD 命令

常见命令：

| 命令 | 含义 |
|---|---|
| `KMD_CMD_VOID` | 空命令/同步 |
| `KMD_CMD_COMPLETED` | 命令完成 |
| `KMD_CMD_READ` | KMD 读物理内存到 DMA buffer |
| `KMD_CMD_WRITE` | KMD 从 DMA buffer 写目标物理内存 |
| `KMD_CMD_TERMINATE` | 通知 KMD 终止 |
| `KMD_CMD_MEM_INFO` | 获取目标物理内存 map |
| `KMD_CMD_EXEC` | 执行内核侧代码 |
| `KMD_CMD_READ_VA` | 读虚拟地址，定义存在但主路径不常用 |
| `KMD_CMD_WRITE_VA` | 写虚拟地址，定义存在但主路径不常用 |
| `KMD_CMD_EXEC_EXTENDED` | 扩展执行，支持 callback/console buffer 等 |

需要注意：虽然 KMD 定义了 `READ_VA` / `WRITE_VA`，PCILeech 常规虚拟地址读写更多走 MemProcFS：先 VA->PA，再调用 LeechCore 的 `LcReadScatter()` / `LcWriteScatter()`。

---

## 7. KMD 生命周期

### 7.1 打开或加载

主程序解析 `-kmd` 参数后，在 action dispatcher 前调用 `KMDOpen()`。

`KMDOpen()` 根据配置选择不同打开方式：

```text
已有 KMD 控制页地址 -> KMDOpen_LoadExisting()
页表相关方式       -> KMDOpen_PageTableHijack()
Windows HAL/VMM   -> KMDOpen_HalHijack() / KMDOpen_WINX64_*()
Linux EFI / UEFI  -> KMDOpen_LinuxEfiRuntimeServicesHijack() / KMDOpen_UEFI()
默认扫描方式       -> KMDOpen_MemoryScan()
```

其中部分 Windows VMM 相关方式在 KMD 尚未加载前，会先借助 MemProcFS 的虚拟地址能力定位目标模块、函数或写入点。

### 7.2 初始化 stage3

KMD 初始化大致做：

```text
写入 stage3 shellcode
分配 KMDHANDLE
设置 ctxMain->phKMD 和 ctxMain->pk
读取 KMD 控制页
调用 KMD_GetPhysicalMemoryMap()
保存 KMD 控制页物理地址
```

### 7.3 卸载

结束时，如果 KMD 是本次自动加载的，并且不是 `kmdload` 动作，也不是用户显式指定已有 KMD 地址，则会尝试：

```text
KMDUnload()
    -> KMD_SubmitCommand(KMD_CMD_TERMINATE)
    -> KMDClose()
```

如果用户通过地址指定已有 KMD，程序通常不会自动卸载目标侧 KMD。

---

## 8. KMD 命令提交机制

`KMD_SubmitCommand()` 是 host 与 KMD 的同步命令入口。

简化流程：

```text
1. host 设置 ctxMain->pk->_op = op
2. host 通过 LcWrite() 把 4KB 控制页写到目标物理地址
3. 目标 KMD 看到命令后执行
4. KMD 更新 _status / _result，并设置 _op = COMPLETED
5. host 循环 DMA 读取控制页，直到完成
```

因此 KMD 通信机制是：

```text
4KB 控制页 mailbox + DMA 轮询 + DMA buffer 数据交换
```

---

## 9. KMD 获取物理内存 map

KMD 初始化后会通过 `KMD_CMD_MEM_INFO` 获取目标内核认为有效的物理内存范围：

```text
host 提交 KMD_CMD_MEM_INFO
    -> KMD 查询目标内核物理内存范围
    -> KMD 把 map 写入 DMA buffer
    -> host 从 DMAAddrPhysical 读回 map
    -> 保存到 ctxMain->phKMD->pPhysicalMap
```

之后 KMD 读写会调用类似 `KMD_IsRangeInPhysicalMap()` 的逻辑，判断目标地址是否落在 kernel-reported RAM 范围内。

如果不在 map 内，并且没有指定 `-force`，KMD 读写会失败返回。

这解决了 native DMA 的一个核心问题：

```text
native DMA 默认只知道“地址”，不知道这个地址是不是目标 OS 认可的 RAM；
KMD 可以从目标内核视角提供 physical memory map。
```

---

## 10. KMD 读物理内存流程

普通物理读入口是 `DeviceReadMEM()`：

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

核心判断：

```text
如果有 KMD 且没有 -no-kmd-mem:
    DeviceReadMEM -> KMDReadMemory
否则:
    DeviceReadMEM -> LcRead
```

`KMDReadMemory()` 会按 `DMASizeBuffer` 分块。每块读的流程：

```text
1. 检查目标地址范围是否在 KMD physical map 内
2. 设置 _address = 目标物理地址
3. 设置 _size = 长度
4. 提交 KMD_CMD_READ
5. 目标 KMD 在内核态读取目标物理内存
6. KMD 把数据复制到 DMA buffer
7. host 通过 DeviceReadDMA(DMAAddrPhysical, ...) 读回数据
8. 检查 _result
```

也就是：

```text
目标物理地址 -> KMD -> DMA buffer -> PCILeech host
```

---

## 11. KMD 写物理内存流程

普通物理写入口是 `DeviceWriteMEM()`：

```c
BOOL DeviceWriteMEM(QWORD qwAddr, DWORD cb, PBYTE pb, BOOL fRetryOnFail)
{
    if(ctxMain->phKMD && !ctxMain->cfg.fNoKmdMem) {
        return KMDWriteMemory(qwAddr, pb, cb);
    }
    return LcWrite(ctxMain->hLC, qwAddr, cb, pb) ||
           (fRetryOnFail && LcWrite(ctxMain->hLC, qwAddr, cb, pb));
}
```

KMD 写流程：

```text
1. 检查目标地址是否在 KMD physical map 内
2. host 先把待写数据 DMA 写入 KMD 的 DMA buffer
3. 设置 _address / _size
4. 提交 KMD_CMD_WRITE
5. 目标 KMD 从 DMA buffer 复制数据到目标物理地址
6. host 检查 _result
```

也就是：

```text
PCILeech host -> DMA buffer -> KMD -> 目标物理地址
```

---

## 12. 为什么需要 KMD DMA buffer 中转？

这是 KMD 机制的关键。

### 12.1 控制页只适合传命令

`KMDDATA` 控制页是 mailbox，适合传：

```text
命令
地址
长度
状态
返回值
少量参数
```

大块数据不能都塞进控制页，所以需要 DMA buffer。

### 12.2 外部设备不一定稳定访问任意目标地址

Native DMA 理论上可以读写物理地址，但现实中可能受限于：

```text
硬件地址宽度
高地址支持
MMIO / hole / 保留区
TLP 大小与对齐
平台地址映射差异
某些区域读取副作用
```

KMD 让外部设备只稳定访问一块已知 DMA buffer，真正复杂的目标地址访问交给目标内核完成。

### 12.3 KMD 可以使用目标内核机制

KMD 在目标内核态运行，可以基于目标内核的 memory map、direct map、ioremap、memcpy 等机制完成访问。这样比外部设备盲目发 TLP 更 OS-aware。

### 12.4 性能不是唯一目标

KMD 路径多了一次内核态 memcpy 和命令同步：

```text
读:
    目标地址 -> KMD memcpy -> DMA buffer -> host DMA read

写:
    host DMA write -> DMA buffer -> KMD memcpy -> 目标地址
```

所以 KMD 不一定比 native DMA 快。它换来的是可靠性、可达性和目标内核语义。

---

## 13. `-no-kmd-mem` 的意义

`-no-kmd-mem` 关闭 KMD 作为普通内存读写代理的能力。

默认有 KMD 时：

```text
DeviceReadMEM  -> KMDReadMemory
DeviceWriteMEM -> KMDWriteMemory
```

指定 `-no-kmd-mem` 后：

```text
DeviceReadMEM  -> LcRead
DeviceWriteMEM -> LcWrite
```

这说明 KMD 有两层作用：

1. **memory proxy 层**：普通物理读写通过 KMD。
2. **KMD action / exec / VFS 层**：KMD 提供内核侧命令执行、VFS、files 等能力。

`-no-kmd-mem` 主要关闭第一层，不等于 KMD 不存在。

---

## 14. memdump 中的 KMD 分支

`ActionMemoryDump()` 里有关键分支：

```text
if(ctxMain->phKMD || device == usb3380)
    ActionMemoryDump_KMD_USB3380()
else
    ActionMemoryDump_Native()
```

### 14.1 Native dump

Native dump 走：

```text
ActionMemoryDump_Native()
    -> DeviceReadDMA()
        -> LcReadScatter()
```

它不经过 `DeviceReadMEM()`，因此不会走 `KMDReadMemory()`。

### 14.2 KMD dump

KMD dump 走：

```text
ActionMemoryDump_KMD_USB3380()
    -> Util_Read16M()
        -> DeviceReadMEM()
            -> KMDReadMemory()
```

KMD 不能走 native dump 路径，因为 native 路径会绕过 KMD memory proxy。

### 14.3 `Util_Read16M()` fallback

KMD 模式下，`Util_Read16M()` 会逐级降级读取：

```text
16MB -> 4MB -> 1MB -> 128KB -> 4KB page
```

意义：

```text
大块失败不等于全部失败；
尽量保留可读 page；
不可读部分清零；
记录 failed pages。
```

---

## 15. 哪些操作走 KMD？

快速判断规则：

```text
调用 DeviceReadMEM() / DeviceWriteMEM()
    -> 可能走 KMD

调用 KMD_SubmitCommand()
    -> 明确走 KMD

调用 VMMDLL_MemRead() / VMMDLL_MemWrite()
    -> 通常走 MemProcFS，不走 PCILeech 的 KMD wrapper

调用 LcReadScatter() / LcWriteScatter()
    -> LeechCore 层，本身不知道 ctxMain->phKMD
```

总表：

| 操作 | KMD 关系 |
|---|---|
| `-kmd ...` | action 前统一 `KMDOpen()` |
| `kmdload` | KMD 专用，加载后保留 |
| `kmdexit` | KMD 专用，提交 `KMD_CMD_TERMINATE` |
| `dump` | 有 KMD 时走 `ActionMemoryDump_KMD_USB3380()` |
| 物理 `write` | `DeviceWriteMEM()` -> `KMDWriteMemory()` |
| 虚拟 `write` | 走 `VMMDLL_MemWrite()`，不走 KMD wrapper |
| 物理 `display` | `DeviceReadMEM()` -> `KMDReadMemory()` |
| 虚拟 `display` | 走 `VMMDLL_MemRead()`，不走 KMD wrapper |
| 物理 `search/patch` | 读写可通过 KMD |
| 虚拟 `search/patch` | 走 MemProcFS |
| `EXEC_KMD` | 强制 KMD，走 `KMD_CMD_EXEC` |
| `EXEC_UMD` | 不走 KMD，走 MemProcFS/UMD 路径 |
| `mount` | `/files` 和 `liveram-kmd.raw` 需要 KMD |
| `testmemread/write` | 有 KMD 时拒绝，因为测试 native DMA |
| `pt_phys2virt/pt_virt2phys` | 页表读取用 `DeviceReadMEM()`，间接受 KMD 影响 |
| `pslist/psvirt2phys` | 走 MemProcFS，不走 KMD wrapper |
| `probe` | 基本偏 native/device probe |

---

## 16. MemProcFS 虚拟地址路径与 KMD 的关系

这是最容易混淆的地方：

> 虚拟地址读写最后确实回到 LeechCore，但回到的是 `LcReadScatter()` / `LcWriteScatter()`，不是 PCILeech 的 `DeviceReadMEM()` / `DeviceWriteMEM()`。

虚拟读路径：

```text
ActionMemoryDisplayVirtual()
    -> VMMDLL_MemRead()
        -> VmmReadEx()
            -> VmmReadScatterVirtual()
                -> VmmVirt2Phys()
                -> VmmReadScatterPhysical()
                    -> LcReadScatter()
                        -> LeechCore backend
```

虚拟写路径：

```text
ActionMemoryWrite() virtual
    -> VMMDLL_MemWrite()
        -> VmmWriteScatterVirtual()
            -> VmmVirt2Phys()
            -> VmmWriteScatterPhysical()
                -> LcWriteScatter()
                    -> LeechCore backend
```

这里没有：

```text
DeviceReadMEM()
DeviceWriteMEM()
KMDReadMemory()
KMDWriteMemory()
```

所以即使命令行带了 `-kmd`，虚拟 display/write/search/patch 也不一定走 KMD。因为 KMD 判断只在 PCILeech 自己的 `DeviceReadMEM()` / `DeviceWriteMEM()` wrapper 中。

---

## 17. 为什么 native DMA 能做很多事，但仍需要 KMD？

Native DMA 已经能做：

```text
物理内存 dump
物理地址 read/write
物理模式 search/patch
配合 MemProcFS 做 VA->PA 后读写虚拟地址
利用 MEM_SCATTER 高性能批量采集
```

但 KMD 仍有必要，因为它解决的是另一层问题。

### 17.1 目标 OS 物理内存 map

Native DMA 默认不知道哪些地址是目标 OS 认可的 RAM。KMD 能从目标内核获取 physical memory map，从而避开 MMIO、hole、保留区。

### 17.2 硬件地址限制

某些后端 native 地址能力有限。KMD 可以让设备只访问 DMA buffer，由目标内核访问真正目标地址。

### 17.3 固定通信区与 bounce buffer

KMD 把外部设备的复杂访问变成：

```text
设备 <-> KMD DMA buffer
KMD <-> 目标地址
```

这样外设不必直接面对整个复杂物理地址空间。

### 17.4 内核侧执行

Native DMA 能写内存，但不等于可以自然地让目标内核执行一个命令。KMD 提供 `KMD_CMD_EXEC` / `KMD_CMD_EXEC_EXTENDED`，可以作为内核态 RPC agent。

### 17.5 OS 语义能力

VFS、`/files`、文件系统视图、内核对象等不是裸物理地址语义。KMD 能在目标内核态执行逻辑，因此支持这些高级功能。

### 17.6 稳定 fallback

KMD dump 可以逐级 fallback，尽量读出可读 page，而不是因为一个大块失败就整体失败。

总结：

```text
能 native DMA 的地方，KMD 不是必须；
需要目标内核视角、物理内存 map、高地址代理、VFS/files、内核侧执行、稳定 fallback 时，KMD 就变成核心组件。
```

---

## 18. 性能与“OS 无感”边界

### 18.1 性能

KMD 不一定更快。KMD 读写会多一次中转：

```text
读:
    目标内存 -> KMD memcpy -> DMA buffer -> host DMA read

写:
    host DMA write -> DMA buffer -> KMD memcpy -> 目标内存
```

如果目标只是高速 dump 大块物理内存，FPGA native path + MEM_SCATTER 通常更直接。

KMD 的价值更偏：

```text
可靠性
OS-aware
高地址/硬件能力补偿
内核执行
VFS/files 语义
```

### 18.2 “OS 无感”不是绝对不可检测

Native DMA 不经过普通系统调用、进程 API、文件 I/O，也不走 CPU MMU 的进程权限检查，所以很多传统 OS 监控看不到。

但 KMD 一旦进入目标内核，就会引入内核侧痕迹：

```text
控制页
DMA buffer
未知内核代码
内核态执行
可能的页权限变化
可能的内存修改
```

所以更准确的说法是：

```text
PCILeech 的 DMA 路径可绕过很多传统 OS 监控；
KMD 模式并不等于绝对不可检测。
```

---

## 19. 常见误区

### 误区 1：KMD 是 DMA 的前提

不是。Native DMA 不需要 KMD。KMD 是在已有 DMA 能力基础上建立的高层代理。

### 误区 2：KMD 读就是设备直接读目标地址

不是。KMD 读是：

```text
KMD 读目标地址 -> 拷贝到 DMA buffer -> host 读 DMA buffer
```

### 误区 3：带了 `-kmd` 所有读写都走 KMD

不是。只有经过 `DeviceReadMEM()` / `DeviceWriteMEM()` 的路径才判断 KMD。MemProcFS 虚拟路径通常不走这个 wrapper。

### 误区 4：KMD 一定更快

不是。KMD 往往更稳定、更 OS-aware，但可能比 native FPGA dump 慢。

### 误区 5：LeechCore memory map 是 MMU 映射

不是。它只是 LeechCore 内部的软件地址重定位表。

---

## 20. 推荐源码阅读顺序

1. `pcileech/device.c`
   - `DeviceReadMEM()` / `DeviceWriteMEM()`
   - 先理解 KMD 判断在哪里发生。

2. `pcileech/kmd.h`
   - KMD 对外接口。

3. `pcileech/pcileech.h`
   - `KMDDATA`、`KMDHANDLE`、`KMD_CMD_*`。

4. `pcileech/kmd.c`
   - `KMDOpen()`
   - `KMD_SubmitCommand()`
   - `KMD_GetPhysicalMemoryMap()`
   - `KMDReadMemory()` / `KMDWriteMemory()`。

5. `pcileech/memdump.c`
   - `ActionMemoryDump()`
   - `ActionMemoryDump_Native()`
   - `ActionMemoryDump_KMD_USB3380()`。

6. `pcileech/util.c`
   - `Util_Read16M()` fallback。

7. `pcileech/vfs.c`
   - mount、`liveram-kmd.raw`、`/files`。

8. `pcileech/executor.c`
   - `ActionExecShellcode()`、`Exec_ExecSilent()`。

9. MemProcFS `vmm/*`
   - `VMMDLL_MemRead()`、`VmmReadScatterVirtual()`、`VmmVirt2Phys()`、`LcReadScatter()`。

10. LeechCore `leechcore.c` / `memmap.c`
    - `LcReadScatter()`、`LcWriteScatter()`、`LcMemMap_TranslateMEMs()`、MEM_SCATTER。

---

## 21. 最终总结

KMD 可以压缩成一句话：

```text
KMD = 目标内核态代理
    + 4KB 控制页 mailbox
    + DMA buffer 中转
    + KMD_CMD_* 命令协议
    + kernel-reported physical memory map
    + 内核侧执行能力
```

三层关系可以这样理解：

```text
LeechCore / Native DMA:
    提供底层物理内存访问能力

MemProcFS:
    基于物理内存访问做 VA->PA、进程、模块、页表等分析

PCILeech KMD:
    在目标内核态建立代理，提供 OS-aware 读写、执行和 VFS/files 等高级能力
```

最终判断规则：

```text
只需要高速物理内存采集:
    优先理解 native DMA + MEM_SCATTER

需要目标内核视角、RAM map、高地址代理、VFS/files、内核执行:
    KMD 是核心组件

需要分析进程虚拟地址:
    多数情况下看 MemProcFS 的 VA->PA 路径，而不是 KMD wrapper
```
