# PCILeech KMD 相关分析总结

本文基于当前仓库源码，对 PCILeech 中 KMD（Kernel Module Assisted DMA）的作用、数据结构、通信流程、内存读写路径以及 `memdump` 中相关分支进行整理。

> 注意：本文是源码阅读和架构理解笔记，重点解释 PCILeech 内部 KMD 机制，不讨论具体攻击场景或第三方目标使用方式。

## 1. KMD 的定位

PCILeech 支持两类主要访问模式：

1. **Native DMA 模式**
   - PCILeech 设备或 LeechCore 后端直接对目标物理地址执行 DMA 读写。
   - 典型调用路径是 `LcRead()` / `LcWrite()` / `LcReadScatter()`。
   - FPGA 设备可以支持较大的物理地址空间；USB3380 native 模式通常受 32-bit 地址能力限制。

2. **KMD 模式**
   - KMD 是被放入目标系统内核态运行的一段 helper / shellcode。
   - 宿主端 PCILeech 通过 DMA 和 KMD 通信。
   - KMD 在目标内核侧执行读写、获取物理内存 map、执行扩展命令等操作。

因此 KMD 的核心定位是：

```text
目标机内核态代理 + DMA 数据交换通道
```

Native DMA 是“PCILeech 设备直接读写目标物理地址”；KMD 模式则是“目标内核里的 KMD 代替 PCILeech 读写内存，再通过 DMA buffer 把数据交给宿主端”。

## 2. KMD 解决的问题

Native DMA 直接扫描目标物理地址空间时，会遇到一些问题：

- 目标物理地址空间中存在 MMIO、PCIe 设备映射区、空洞区、保留区。
- 直接读取某些 MMIO 区域可能失败，甚至导致目标机异常。
- 不同硬件后端能力不同，例如 USB3380 对 4GB 以上地址支持有限。
- Native DMA 默认并不知道目标 OS 认为哪些物理页是真正可用 RAM。
- 一些功能需要目标 OS 内核视角，例如虚拟地址访问、内核侧执行、VFS 支持等。

KMD 的价值在于：

- 让目标内核报告物理内存 map。
- 只在 kernel-reported RAM 范围内执行读写，除非用户指定 `-force`。
- 由目标 OS / 内核侧代码完成实际内存访问。
- 支持物理内存读写、虚拟地址读写、内核侧执行、KMD 卸载等命令。

## 3. 关键源码位置

KMD 相关入口和数据结构主要分布在：

- `pcileech/pcileech.h`
  - `KMDDATA`
  - `KMDHANDLE`
  - `KMD_CMD_*`
  - `KMDDATA_MAGIC`
- `pcileech/kmd.h`
  - KMD 对外接口声明。
- `pcileech/kmd.c`
  - KMD 打开、加载、通信、读写、卸载等主要实现。
- `pcileech/device.c`
  - `DeviceReadMEM()` / `DeviceWriteMEM()` 中的 KMD 转发逻辑。
- `pcileech/memdump.c`
  - dump 动作中 KMD 路径和 native 路径的分支。
- `pcileech/util.c`
  - `Util_Read16M()` 中 KMD 模式下的分块 fallback 读取逻辑。

## 4. KMD 对外接口

`pcileech/kmd.h` 中暴露的主要接口如下：

```c
BOOL KMDOpen();
VOID KMDUnload();
VOID KMDClose();

BOOL KMDReadMemory(QWORD qwAddress, PBYTE pb, DWORD cb);
BOOL KMDWriteMemory(QWORD qwAddress, PBYTE pb, DWORD cb);

BOOL KMD_SubmitCommand(QWORD op);
```

含义：

- `KMDOpen()`：打开或加载 KMD。
- `KMDUnload()`：通知目标内核中的 KMD 退出，并清理本地状态。
- `KMDClose()`：只释放宿主端保存的 KMD handle，不一定通知目标侧卸载。
- `KMDReadMemory()`：通过 KMD 代理读取目标物理内存。
- `KMDWriteMemory()`：通过 KMD 代理写入目标物理内存。
- `KMD_SubmitCommand()`：向目标 KMD 提交命令。

## 5. KMD 的打开方式

`KMDOpen()` 会根据配置选择不同打开方式：

```c
BOOL KMDOpen()
{
    if(ctxMain->cfg.paKMD) {
        return KMDOpen_LoadExisting();
    } else if(ctxMain->cfg.paCR3 || ctxMain->cfg.fPageTableScan) {
        return KMDOpen_PageTableHijack();
    } else if(0 == _stricmp(ctxMain->cfg.szKMDName, "WIN10_X64")) {
        return KMDOpen_HalHijack();
    } else if(0 == _stricmp(ctxMain->cfg.szKMDName, "WIN10_X64_2")) {
        return KMDOpen_WINX64_2_VMM();
    } else if((0 == _stricmp(ctxMain->cfg.szKMDName, "WIN10_X64_3")) || (0 == _stricmp(ctxMain->cfg.szKMDName, "WIN11_X64"))) {
        return KMDOpen_WINX64_3_VMM();
    } else if(0 == _stricmp(ctxMain->cfg.szKMDName, "LINUX_X64_EFI")) {
        return KMDOpen_LinuxEfiRuntimeServicesHijack();
    } else if(0 == _stricmp(ctxMain->cfg.szKMDName, "UEFI_EXIT_BOOT_SERVICES")) {
        return KMDOpen_UEFI(0xe8);
    } else if(0 == _stricmp(ctxMain->cfg.szKMDName, "UEFI_SIGNAL_EVENT")) {
        return KMDOpen_UEFI(0x68);
    } else {
        return KMDOpen_MemoryScan();
    }
}
```

可以归纳为几类：

- **加载已有 KMD**
  - 用户通过 `-kmd 0x...` 指定已经存在的 KMD 控制页地址。
  - 走 `KMDOpen_LoadExisting()`。

- **通过页表或内核结构劫持插入 KMD**
  - 例如 page table hijack、HAL hijack、Windows VMM 相关方式。

- **通过 EFI / UEFI 相关方式插入 KMD**
  - 例如 Linux EFI Runtime Services hijack、UEFI hook。

- **通过内存扫描方式寻找可插入位置**
  - 默认 fallback 到 `KMDOpen_MemoryScan()`。

本文重点关注 KMD 加载成功后的通信和读写机制。

## 6. `KMDDATA`：宿主端和 KMD 的通信页

KMD 和 PCILeech 宿主端之间通过一个 4KB 页面通信，该页面中的结构是 `KMDDATA`：

```c
typedef struct tdKMDDATA {
    QWORD MAGIC;
    QWORD AddrKernelBase;
    QWORD AddrKallsymsLookupName;
    QWORD DMASizeBuffer;
    QWORD DMAAddrPhysical;
    QWORD DMAAddrVirtual;
    QWORD _status;
    QWORD _result;
    QWORD _address;
    QWORD _size;
    QWORD OperatingSystem;
    QWORD ReservedKMD[8];
    QWORD ReservedFutureUse1[13];
    QWORD dataInExtraLength;
    QWORD dataInExtraOffset;
    QWORD dataInExtraLengthMax;
    QWORD dataInConsoleBuffer;
    QWORD dataIn[28];
    QWORD dataOutExtraLength;
    QWORD dataOutExtraOffset;
    QWORD dataOutExtraLengthMax;
    QWORD dataOutConsoleBuffer;
    QWORD dataOut[28];
    QWORD fn[32];
    CHAR dataInStr[MAX_PATH];
    CHAR ReservedFutureUse2[252];
    CHAR dataOutStr[MAX_PATH];
    CHAR ReservedFutureUse3[252];
    QWORD ReservedFutureUse4[255];
    QWORD _op;
} KMDDATA, *PKMDDATA;
```

关键字段含义：

| 字段 | 作用 |
|---|---|
| `MAGIC` | 标识该页是否为有效 KMD 控制页 |
| `DMASizeBuffer` | KMD 分配或使用的 DMA buffer 大小 |
| `DMAAddrPhysical` | DMA buffer 的物理地址，宿主端通过 DMA 访问 |
| `DMAAddrVirtual` | 同一块 DMA buffer 在目标内核中的虚拟地址 |
| `_op` | 当前命令，放在 4KB 页最后 8 字节 |
| `_status` | 当前命令状态 |
| `_result` | 当前命令结果 |
| `_address` | 本次命令操作的目标地址 |
| `_size` | 本次命令操作的数据长度 |
| `OperatingSystem` | KMD 识别出的目标系统类型 |
| `dataIn*` / `dataOut*` | 扩展执行、输入输出、console buffer 等使用 |
| `fn[32]` | KMD shellcode 保存函数指针 |

`_op` 放在 4KB 页末尾，说明这页被当作一个简单 mailbox 使用：

```text
host 写入参数 + _op
target KMD 执行命令
target KMD 写回 _status / _result / _op
host 轮询读取完成状态
```

## 7. KMD 命令类型

KMD 命令定义如下：

```c
#define KMD_CMD_VOID                        0xffff
#define KMD_CMD_COMPLETED                   0
#define KMD_CMD_READ                        1
#define KMD_CMD_WRITE                       2
#define KMD_CMD_TERMINATE                   3
#define KMD_CMD_MEM_INFO                    4
#define KMD_CMD_EXEC                        5
#define KMD_CMD_READ_VA                     6
#define KMD_CMD_WRITE_VA                    7
#define KMD_CMD_EXEC_EXTENDED               8
```

主要命令含义：

| 命令 | 含义 |
|---|---|
| `KMD_CMD_READ` | KMD 读取目标物理内存到 DMA buffer |
| `KMD_CMD_WRITE` | KMD 将 DMA buffer 数据写入目标物理内存 |
| `KMD_CMD_TERMINATE` | 通知 KMD 终止 |
| `KMD_CMD_MEM_INFO` | 获取目标系统物理内存 map |
| `KMD_CMD_EXEC` | 执行内核侧代码 |
| `KMD_CMD_READ_VA` | 读取虚拟地址 |
| `KMD_CMD_WRITE_VA` | 写入虚拟地址 |
| `KMD_CMD_EXEC_EXTENDED` | 扩展执行，支持 callback / console buffer 等 |

## 8. `KMDHANDLE`：宿主端保存的 KMD 状态

宿主端用 `KMDHANDLE` 保存 KMD 状态：

```c
typedef struct tdKMDHANDLE {
    DWORD dwPageAddr32;
    QWORD cPhysicalMap;
    PPHYSICAL_MEMORY_RANGE pPhysicalMap;
    PKMDDATA pk;
    BYTE pbPageData[4096];
} KMDHANDLE, *PKMDHANDLE;
```

字段含义：

| 字段 | 作用 |
|---|---|
| `dwPageAddr32` | KMD 控制页在目标物理内存中的地址 |
| `cPhysicalMap` | 目标物理内存 map 条目数量 |
| `pPhysicalMap` | 目标物理内存 map 数组 |
| `pk` | 指向本地 `pbPageData` 的 `KMDDATA *` |
| `pbPageData[4096]` | 宿主端本地缓存的 KMD 控制页 |

主上下文中保存：

```c
PKMDHANDLE phKMD;
PKMDDATA pk;
```

因此，`ctxMain->phKMD != NULL` 基本就是当前已进入 KMD 模式的标志。

## 9. KMD 命令提交流程

命令提交函数是 `KMD_SubmitCommand()`：

```c
BOOL KMD_SubmitCommand(QWORD op)
{
    ctxMain->pk->_op = op;

    if(!LcWrite(ctxMain->hLC, ctxMain->phKMD->dwPageAddr32, 4096, ctxMain->phKMD->pbPageData)) {
        return FALSE;
    }

    do {
        while(!DeviceReadDMA_Retry(ctxMain->hLC, ctxMain->phKMD->dwPageAddr32, 4096, ctxMain->phKMD->pbPageData)) {
            ...
        }

        if(ctxMain->pk->_op == KMD_CMD_EXEC_EXTENDED) {
            fResultCB = Exec_Callback(&hCallback);
        }
    } while(((ctxMain->pk->_op != KMD_CMD_COMPLETED) || (ctxMain->pk->_status != 1)) &&
            (ctxMain->pk->_status < 0x0fffffff) &&
            fResultCB);

    return TRUE;
}
```

流程可以概括为：

```text
1. 宿主端设置 KMDDATA._op
2. 宿主端通过 LcWrite() 把 4KB 控制页写入目标物理地址
3. 目标内核中的 KMD 看到命令后执行
4. KMD 更新 _status / _result，并把 _op 设置为 KMD_CMD_COMPLETED
5. 宿主端循环 DMA 读取控制页，直到命令完成
```

所以 KMD 通信不是复杂协议，而是一个基于 DMA 读写 4KB mailbox 页的同步命令机制。

## 10. KMD 获取物理内存 map

KMD 初始化后会调用 `KMD_GetPhysicalMemoryMap()`：

```c
BOOL KMD_GetPhysicalMemoryMap()
{
    KMD_SubmitCommand(KMD_CMD_MEM_INFO);

    ctxMain->phKMD->pPhysicalMap =
        LocalAlloc(LMEM_ZEROINIT, (ctxMain->pk->_size + 0x1000) & 0xfffff000);

    DeviceReadDMA(
        ctxMain->pk->DMAAddrPhysical,
        (DWORD)((ctxMain->pk->_size + 0x1000) & 0xfffff000),
        (PBYTE)ctxMain->phKMD->pPhysicalMap,
        NULL);

    ctxMain->phKMD->cPhysicalMap =
        ctxMain->pk->_size / sizeof(PHYSICAL_MEMORY_RANGE);

    ...
}
```

含义：

1. 宿主端提交 `KMD_CMD_MEM_INFO`。
2. KMD 在目标内核侧查询物理内存范围。
3. KMD 把物理内存 map 放到 DMA buffer。
4. 宿主端通过 `DeviceReadDMA()` 从 `DMAAddrPhysical` 把 map 读回来。
5. 宿主端保存到 `ctxMain->phKMD->pPhysicalMap`。

之后 KMD 读写都会检查目标地址是否处于该 map 内：

```c
BOOL KMD_IsRangeInPhysicalMap(PKMDHANDLE phKMD, QWORD qwBaseAddress, QWORD qwNumberOfBytes)
{
    for(i = 0; i < phKMD->cPhysicalMap; i++) {
        pmr = phKMD->pPhysicalMap[i];
        if(((pmr.BaseAddress <= qwBaseAddress) &&
            (pmr.BaseAddress + pmr.NumberOfBytes >= qwBaseAddress + qwNumberOfBytes))) {
            return TRUE;
        }
    }
    return FALSE;
}
```

如果不在 map 内，并且用户没有指定 `-force`，KMD 读写会失败返回。

## 11. KMD 读物理内存流程

普通读入口是 `DeviceReadMEM()`：

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

也就是说，只要：

```text
ctxMain->phKMD != NULL
并且没有指定 -no-kmd-mem
```

普通内存读就会被转发到 `KMDReadMemory()`。

`KMDReadMemory()` 按 `DMASizeBuffer` 分块：

```c
BOOL KMDReadMemory(QWORD qwAddress, PBYTE pb, DWORD cb)
{
    DWORD dwDMABufferSize = (DWORD)ctxMain->pk->DMASizeBuffer;
    DWORD o = cb;

    dwDMABufferSize = dwDMABufferSize ? dwDMABufferSize : 0x01000000;

    while(TRUE) {
        if(o <= dwDMABufferSize) {
            return KMDReadMemory_DMABufferSized(qwAddress + cb - o, pb + cb - o, o);
        } else if(!KMDReadMemory_DMABufferSized(qwAddress + cb - o, pb + cb - o, dwDMABufferSize)) {
            return FALSE;
        }
        o -= dwDMABufferSize;
    }
}
```

真正每块读取在 `KMDReadMemory_DMABufferSized()`：

```c
BOOL KMDReadMemory_DMABufferSized(QWORD qwAddress, PBYTE pb, DWORD cb)
{
    if(!KMD_IsRangeInPhysicalMap(ctxMain->phKMD, qwAddress, cb) && !ctxMain->cfg.fForceRW) {
        return FALSE;
    }

    ctxMain->pk->_size = cb;
    ctxMain->pk->_address = qwAddress;

    KMD_SubmitCommand(KMD_CMD_VOID);
    KMD_SubmitCommand(KMD_CMD_READ);

    return (cb == DeviceReadDMA(ctxMain->pk->DMAAddrPhysical, cb, pb, NULL)) &&
           ctxMain->pk->_result;
}
```

流程图：

```text
host 设置 _address / _size
        |
        v
host 提交 KMD_CMD_READ
        |
        v
target KMD 在内核侧读取目标物理内存
        |
        v
target KMD 把数据拷贝到 DMA buffer
        |
        v
host 通过 DeviceReadDMA() 从 DMAAddrPhysical 读回数据
```

因此 KMD 模式下读物理内存不是直接读目标地址，而是：

```text
目标物理地址 -> KMD -> DMA buffer -> PCILeech host
```

## 12. KMD 写物理内存流程

普通写入口是 `DeviceWriteMEM()`：

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

KMD 写入每块数据时：

```c
BOOL KMDWriteMemory_DMABufferSized(QWORD qwAddress, PBYTE pb, DWORD cb)
{
    if(!KMD_IsRangeInPhysicalMap(ctxMain->phKMD, qwAddress, cb) && !ctxMain->cfg.fForceRW) {
        return FALSE;
    }

    result = LcWrite(ctxMain->hLC, ctxMain->pk->DMAAddrPhysical, cb, pb);
    if(!result) {
        return FALSE;
    }

    ctxMain->pk->_size = cb;
    ctxMain->pk->_address = qwAddress;

    KMD_SubmitCommand(KMD_CMD_VOID);
    return KMD_SubmitCommand(KMD_CMD_WRITE) && ctxMain->pk->_result;
}
```

流程图：

```text
host 先把待写数据 DMA 写入 KMD 的 DMA buffer
        |
        v
host 设置 _address / _size
        |
        v
host 提交 KMD_CMD_WRITE
        |
        v
target KMD 在内核侧把 DMA buffer 写入目标物理地址
```

所以 KMD 写入路径是：

```text
PCILeech host -> DMA buffer -> KMD -> 目标物理地址
```

## 13. `-no-kmd-mem` 的意义

`-no-kmd-mem` 对应配置字段：

```c
ctxMain->cfg.fNoKmdMem
```

它的效果是：

```text
即使 KMD 已加载，也不要让普通 DeviceReadMEM()/DeviceWriteMEM() 通过 KMD 代理。
```

对应判断：

```c
if(ctxMain->phKMD && !ctxMain->cfg.fNoKmdMem) {
    return KMDReadMemory(...);
}
```

关闭 KMD memory proxy 后，普通内存访问会回到 `LcRead()` / `LcWrite()`。

这说明 KMD 有两个层面的作用：

1. 提供 KMD action / exec / VFS 等内核侧能力。
2. 作为普通内存读写的代理层。

`-no-kmd-mem` 主要关闭第 2 点。

## 14. KMD 对 `memdump` 的影响

`pcileech/memdump.c` 中入口如下：

```c
VOID ActionMemoryDump()
{
    if(ctxMain->phKMD || PCILEECH_DEVICE_EQUALS("usb3380")) {
        ActionMemoryDump_KMD_USB3380();
    } else {
        ActionMemoryDump_Native();
    }
}
```

该分支说明：

- 如果 KMD 已加载，走 `ActionMemoryDump_KMD_USB3380()`。
- 如果设备是 USB3380，也走 `ActionMemoryDump_KMD_USB3380()`。
- 其他情况走 `ActionMemoryDump_Native()`。

这里 `KMD_USB3380` 不是说 KMD 和 USB3380 底层机制一样，而是二者使用相似的顺序 dump 策略：

```text
从 paMin 到 paMax，按 16MB 块顺序读。
```

### 14.1 KMD / USB3380 dump 路径

`ActionMemoryDump_KMD_USB3380()` 中核心逻辑：

```c
while(!pfw->fTerminated && (paCurrent < paMax)) {
    pd = &pfw->Data[pfw->iWrite % MEMDUMP_NUM_BUFFER];
    pd->cb = (DWORD)min(MEMDUMP_DATABUFFER_SIZE, paMax - paCurrent);
    pd->pa = paCurrent;

    if(!Util_Read16M(pd->pb, paCurrent, pStat)) {
        printf("Memory Dump: Failed. Cannot dump any sequential data in 16MB - terminating.\n");
        goto fail;
    }

    InterlockedIncrement64(&pfw->iWrite);
    paCurrent += pd->cb;
}
```

KMD 模式下，`Util_Read16M()` 里面调用的 `DeviceReadMEM()` 会转发到 `KMDReadMemory()`。

### 14.2 KMD 下 `Util_Read16M()` 的 fallback 策略

`Util_Read16M()` 在 KMD 模式下会逐级降级读取：

1. 先尝试一次读 16MB。
2. 如果失败，清零 16MB buffer。
3. 分成 4 个 4MB 块尝试读取。
4. 失败的 4MB 块再按 1MB 处理。
5. 1MB 内部再尝试 128KB。
6. 失败的 128KB 再按 4KB page 读取。

相关逻辑：

```c
if((qwBaseAddress + 0x01000000 <= ctxMain->cfg.paAddrMax) &&
   DeviceReadMEM(qwBaseAddress, 0x01000000, pbBuffer16M, FALSE)) {
    PageStatUpdate(pPageStat, qwBaseAddress + 0x01000000, 4096, 0);
    return TRUE;
}

memset(pbBuffer16M, 0, 0x01000000);

for(i = 0; i < 4; i++) {
    o = 0x00400000 * i;
    isSuccess[i] =
        (qwBaseAddress + o + 0x00400000 <= ctxMain->cfg.paAddrMax) &&
        DeviceReadMEM(qwBaseAddress + o, 0x00400000, pbBuffer16M + o, FALSE);
}
```

这样做的意义是：

- 如果某个大块失败，不代表整个 16MB 都不可读。
- KMD 模式可以尽量把可读 page 读出来。
- 不可读部分保持为 0，统计为 failed pages。

### 14.3 Native dump 路径

`ActionMemoryDump_Native()` 主要面向 FPGA native DMA：

```c
fSaferDump = PCILEECH_DEVICE_EQUALS("fpga") && (paMin == 0) && (paMax > MEMDUMP_4GB);
paCurrent = fSaferDump ? MEMDUMP_4GB : paMin;
...
DeviceReadDMA(pd->pa, pd->cb, pd->pb, pStat);
```

特点：

- 直接调用 `DeviceReadDMA()`。
- 不经过 `DeviceReadMEM()`。
- 因此不会走 `KMDReadMemory()`。
- FPGA 且 dump 范围超过 4GB 时，先 dump 4GB 以上，再回头 dump 0 到 4GB。

KMD 不能走这条路径，因为它会绕过 KMD memory proxy。

## 15. KMD 和 USB3380 为什么在 `memdump` 中同一分支

这个问题容易误解。

`ActionMemoryDump_KMD_USB3380()` 不是表示 KMD 和 USB3380 底层读法相同，而是表示它们采用同一类 dump 策略：

```text
线性 16MB 块顺序读取，不使用 FPGA native safer dump 策略。
```

原因分别是：

- **KMD**
  - 必须通过 `DeviceReadMEM()` 触发 `KMDReadMemory()`。
  - 需要利用 KMD 获取到的物理内存 map。
  - 需要 KMD 的分块 fallback 和 DMA buffer 机制。
  - 不能直接走 `ActionMemoryDump_Native()` 中的 `DeviceReadDMA()`。

- **USB3380**
  - 硬件 native 地址能力有限，通常按 32-bit 地址工作。
  - LeechCore 中 USB3380 的 `paMax` 默认限制到 `0xffffffff`。
  - 不适合 FPGA 那种超过 4GB 后先高地址再低地址的 safer dump 策略。
  - 适合线性读取，遇到连续 16MB 都读不到时终止。

所以该分支是按“dump 策略”分组，不是按“底层实现”分组。

## 16. KMD 生命周期

### 16.1 加载或打开

如果命令行指定 KMD，主流程会在 action 之前调用 `KMDOpen()`：

```c
if(ctxMain->cfg.szKMDName[0] || ctxMain->cfg.paKMD) {
    result = KMDOpen();
    if(!result) {
        printf("PCILEECH: Failed to load kernel module.\n");
        ...
    }
}
```

### 16.2 初始化 stage3

`KMD_SetupStage3()` 会：

1. 将 stage3 shellcode 写到目标地址。
2. 分配 `KMDHANDLE`。
3. 设置 `ctxMain->phKMD` 和 `ctxMain->pk`。
4. 读取 KMD 控制页。
5. 调用 `KMD_GetPhysicalMemoryMap()`。
6. 保存 KMD 控制页物理地址到 `ctxMain->cfg.paKMD`。

简化逻辑：

```c
LcWrite(ctxMain->hLC, dwPhysicalAddress + 0x1000ULL, cbStage3, pbStage3);

ctxMain->phKMD = LocalAlloc(...);
ctxMain->phKMD->pk = (PKMDDATA)ctxMain->phKMD->pbPageData;
ctxMain->pk = ctxMain->phKMD->pk;
ctxMain->phKMD->dwPageAddr32 = dwPhysicalAddress;

LcRead(ctxMain->hLC, ctxMain->phKMD->dwPageAddr32, 4096, ctxMain->phKMD->pbPageData);

KMD_GetPhysicalMemoryMap();
```

### 16.3 卸载

程序结束时，如果 KMD 是本次自动加载的，并且不是 `kmdload` 动作，也不是用户显式指定已有 KMD 地址，则会卸载：

```c
if(ctxMain && ctxMain->phKMD &&
   (ctxMain->cfg.tpAction != KMDLOAD) &&
   !ctxMain->cfg.fAddrKMDSetByArgument) {
    KMDUnload();
    printf("KMD: Hopefully unloaded.\n");
}
```

`KMDUnload()`：

```c
VOID KMDUnload()
{
    if(ctxMain->phKMD) {
        KMD_SubmitCommand(KMD_CMD_TERMINATE);
        KMDClose();
    }
}
```

如果用户通过 `-kmd 0x...` 指定已有 KMD，程序退出时通常不会自动卸载它。

## 17. KMD 模式和 Native 模式对比

| 项目 | Native DMA | KMD 模式 |
|---|---|---|
| 执行位置 | PCILeech 设备 / LeechCore 后端 | 目标系统内核态 |
| 物理内存读 | 设备直接 DMA 读目标物理地址 | KMD 读目标内存，再放入 DMA buffer |
| 物理内存写 | 设备直接 DMA 写目标物理地址 | 宿主端写 DMA buffer，KMD 再写目标内存 |
| 是否使用目标 OS 内存 map | 通常不直接依赖 | 使用 KMD 获取的 kernel-reported physical map |
| 对 MMIO / 空洞处理 | 需要设备策略或用户指定 memmap | 默认检查物理内存 map |
| 高地址支持 | 取决于硬件，FPGA 较强，USB3380 受限 | 取决于 KMD 和目标内核能力 |
| 虚拟地址访问 | 需要额外页表解析 | KMD 可以提供内核侧支持 |
| 内核侧执行 | 不属于普通 native DMA 能力 | 支持 `KMD_CMD_EXEC` / `KMD_CMD_EXEC_EXTENDED` |
| 数据交换 | 直接从目标地址读写 | 通过 KMD 控制页和 DMA buffer |

## 18. 总结

KMD 是 PCILeech 的内核辅助层。加载成功后，宿主端不再只是依赖 PCIe 设备对目标物理地址进行直接 DMA，而是可以通过目标内核中的 KMD 完成更高层的访问。

核心机制可以压缩成一句话：

```text
PCILeech host 通过 DMA 写 KMDDATA 控制页提交命令，目标内核 KMD 执行命令，并通过 DMA buffer 返回数据。
```

在内存 dump 场景中，KMD 的影响尤其明显：

- `ctxMain->phKMD` 存在时，`DeviceReadMEM()` 会转发到 `KMDReadMemory()`。
- `KMDReadMemory()` 会利用 KMD 获取的物理内存 map 做范围检查。
- KMD 把目标内存读取到 DMA buffer 后，宿主端再通过 `DeviceReadDMA()` 取回。
- `memdump` 因此必须走 `ActionMemoryDump_KMD_USB3380()`，而不是直接走 native `DeviceReadDMA()` 路径。

所以 KMD 的本质不是“另一个 DMA 设备”，而是：

```text
目标内核态代理 + 控制页 mailbox + DMA buffer 数据通道
```

