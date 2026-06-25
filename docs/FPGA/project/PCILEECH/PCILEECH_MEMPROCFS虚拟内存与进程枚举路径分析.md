# PCILeech / LeechCore / MemProcFS 虚拟内存与进程枚举路径分析

本文接续 `PCILEECH架构分析.md`，重点解释 PCILeech CLI 调用 MemProcFS 后，目标物理内存是怎么被读取的，Windows 内核结构是怎么被识别出来的，`pslist` 的 PID 信息从哪里来，虚拟地址读取如何完成，以及 KMD 在这些流程中到底是不是必需。

核心结论先放在前面：

```text
MemProcFS 的核心不是让目标系统帮它枚举对象，
而是只要求底层能读目标物理内存，然后在主机侧重建操作系统视图。

KMD 是 PCILeech 的可选内核辅助，不是 pslist、虚拟地址读取、Windows 结构识别的基本依赖。
```

---

## 1. 总体分层关系

PCILeech、MemProcFS 和 LeechCore 的边界非常清晰：

```text
PCILeech CLI
  -> 命令行解析、动作分发、输出展示

MemProcFS / VMMDLL
  -> OS 语义解析、进程表、虚拟地址翻译、VAD、模块、句柄、注册表等结构

LeechCore
  -> 统一物理内存读写抽象，屏蔽 FPGA、文件、远程、PMEM、VMWare 等后端
```

对应源码层次：

```text
pcileech/
  -> CLI 命令和动作，例如 umd.c、memdump.c、device.c、vmmx.c

MemProcFS/vmm/
  -> VMMDLL API、VMM 初始化、Windows 结构解析、页表翻译、进程表

LeechCore/leechcore/
  -> LcCreateEx、LcReadScatter、后端设备函数指针
```

这个分层的关键点是：

- PCILeech CLI 不直接实现完整 Windows 内核结构解析。
- LeechCore 不理解 Windows，不知道 `EPROCESS`、PID、PEB、VAD 是什么。
- MemProcFS 拿到底层“可读物理内存”的能力后，在主机侧把内存解释成操作系统对象。

---

## 2. `pslist` 的源码入口

`pcileech.exe pslist` 最终进入 `pcileech/umd.c` 的 `Action_UmdPsList()`：

```c
VOID Action_UmdPsList()
{
    ...
    if(!Vmmx_Initialize(FALSE, FALSE)) {
        printf("UMD: Failed initializing required MemProcFS/vmm.dll\n");
        goto fail;
    }

    if(!VMMDLL_PidList(ctxMain->hVMM, pdwPIDs, &cPIDs)) {
        printf("UMD: Failed list PIDs.\n");
    } else {
        qsort(pdwPIDs, cPIDs, sizeof(DWORD), UmdCompare32);
        for(i = 0; i < cPIDs; i++) {
            ...
            if(VMMDLL_ProcessGetInformation(ctxMain->hVMM, pdwPIDs[i], pProcInfo, ...)) {
                printf("  %6i %s %s\n", ...);
            }
        }
    }
    Vmmx_Close();
}
```

调用链可以概括为：

```text
pcileech.exe pslist
  -> Action_UmdPsList()
  -> Vmmx_Initialize(FALSE, FALSE)
  -> VMMDLL_Initialize("-device existing")
  -> VMMDLL_PidList()
  -> VMMDLL_ProcessGetInformation()
```

这里要注意：`Action_UmdPsList()` 没有发一个“让 KMD 枚举进程”的命令，也没有从某个 KMD DMA buffer 里取 PID。它直接调用 MemProcFS 的 VMMDLL API。

---

## 3. `-device existing` 的意义

`pcileech/vmmx.c` 中的 `Vmmx_Initialize()` 使用了：

```c
LPCSTR szParams[] = { "", "-device", "existing", "", "", "" };
ctxMain->hVMM = VMMDLL_Initialize(cParams, szParams);
```

这个 `existing` 是关键。它表示：MemProcFS 不重新打开一个设备，而是复用 PCILeech 当前已经打开好的 LeechCore handle。

对应 LeechCore 的 `LcCreateEx()` 在 `LeechCore/leechcore/leechcore.c` 中特判了 `existing`：

```c
if(!pLcCreateConfig->szRemote[0] &&
   (0 == _strnicmp("existing", pLcCreateConfig->szDevice, 8))) {
    ...
    InterlockedIncrement(&ctxLC->dwHandleCount);
    return ctxLC;
}
```

所以真实关系是：

```text
PCILeech 先打开 FPGA / 文件 / 远程 / 其他设备
  -> ctxMain->hLC
  -> MemProcFS 初始化时传入 -device existing
  -> LeechCore::LcCreateEx() 找到已有 handle
  -> 增加引用计数并复用
```

这让 PCILeech 和 MemProcFS 可以共享同一个底层采集设备。MemProcFS 后面读目标内存时，本质上还是通过 PCILeech 已经打开的 LeechCore 设备读。

---

## 4. MemProcFS 读取目标物理内存的底层路径

MemProcFS 的物理读最终会落到 `LcReadScatter()`。

常见调用链是：

```text
VmmRead()
  -> 拆成 page 粒度 MEM_SCATTER
  -> VmmReadScatterPhysical()
  -> LcReadScatter(H->hLC, ...)
  -> LeechCore memory map 翻译
  -> 设备后端 pfnReadScatter()
```

`MemProcFS/vmm/vmm.c` 中的 `VmmRead()` 会按页组织请求：

```c
if(pProcess) {
    VmmReadScatterVirtual(H, pProcess, ppMEMs, cMEMs, flags);
} else {
    VmmReadScatterPhysical(H, ppMEMs, cMEMs, flags);
}
```

物理读路径在 `VmmReadScatterPhysical()` 里：

```c
// 3: read!
LcReadScatter(H->hLC, cpMEMsPhys, ppMEMsPhys);
```

然后进入 `LeechCore/leechcore/leechcore.c` 的 `LcReadScatter()`：

```c
// 1: TRANSLATE
LcMemMap_TranslateMEMs(ctxLC, cMEMs, ppMEMs);

// 2: FETCH
if(ctxLC->pfnReadScatter) {
    ctxLC->pfnReadScatter(ctxLC, cMEMs, ppMEMs);
} else if(ctxLC->RC.fActive) {
    LcReadContigious_ReadScatterGather(ctxLC, cMEMs, ppMEMs);
}
```

这层做两件事：

```text
1. 根据 LeechCore memory map 翻译或过滤物理地址请求。
2. 调用具体设备后端的 pfnReadScatter。
```

不同后端的含义不同：

```text
FPGA 后端
  -> 批量 PCIe Memory Read TLP

文件 / dump 后端
  -> 批量 seek/read

远程后端
  -> RPC / 压缩传输

PMEM / VMWare 后端
  -> 对应后端自己的物理内存读取实现
```

MemProcFS 不需要知道“这个页是 FPGA TLP 读来的，还是文件 seek/read 得到的”。它只依赖 `LcReadScatter()` 提供的统一物理页读取能力。

---

## 5. 虚拟地址读取路径

用户经常会用类似命令读进程虚拟地址：

```text
pcileech.exe display -pid 5064 -vamin 0x123DCCB8 -vamax 0x123DCCCC ...
```

这里的 `0x123DCCB8` 是进程虚拟地址。FPGA/DMA 不能直接理解虚拟地址，真正发给 FPGA 的一定是物理地址。

MemProcFS 的虚拟读路径是：

```text
VMMDLL_MemRead / display -pid
  -> VmmRead()
  -> VmmReadScatterVirtual()
  -> 使用进程 paDTB 做 VA -> PA 翻译
  -> VmmReadScatterPhysical()
  -> LcReadScatter()
```

`MemProcFS/vmm/vmm.c` 的 `VmmReadScatterVirtual_New()` 中可以看到核心逻辑：

```c
pV2Ps[cV2P].paPT = pProcess->paDTB;
pV2Ps[cV2P].va = pMEM_Virt->qwA;
...
H->vmm.fnMemoryModel.pfnVirt2PhysEx(H, pV2Ps, cV2P, pProcess->fUserOnly, -1);
...
VmmReadScatterPhysical(H, ppMEMs, cPhys, flags);
```

所以虚拟地址读取的真实流程是：

```text
PID 5064
  -> MemProcFS 找 PVMM_PROCESS
  -> 从进程对象中取 paDTB / CR3
  -> 主机侧遍历目标页表
  -> 把 VA 0x123DCCB8 翻译成 PA
  -> LcReadScatter 读取物理页
  -> CLI 显示结果
```

如果页面没有物理 backing，例如页面被换出、页表无效、地址不属于该进程、读取被 IOMMU 或设备限制挡住，则读取会失败、返回空洞或被 zeropad。

---

## 6. MemProcFS 如何识别 Windows

MemProcFS 初始化 OS 解析的入口在 `MemProcFS/vmm/vmmproc.c`：

```c
BOOL VmmProcInitialize(_In_ VMM_HANDLE H)
{
    ...
    result = VmmWinInit_TryInitialize(H, H->cfg.paCR3);
    ...
}
```

Windows 初始化主线在 `MemProcFS/vmm/vmmwininit.c` 的 `VmmWinInit_TryInitialize()`：

```text
VmmProcInitialize()
  -> VmmWinInit_TryInitialize()
  -> 找 DTB / CR3
  -> 找 ntoskrnl.exe
  -> 初始化 paging
  -> 找 PsInitialSystemProcess
  -> 找 System EPROCESS
  -> 定位 EPROCESS 字段偏移
  -> 遍历 ActiveProcessLinks
  -> 建立 MemProcFS 进程表
  -> 初始化 PDB、KDBG、PsLoadedModuleList、Registry 等辅助结构
```

这条路径的核心思想是：

```text
从物理内存中找页表根
  -> 通过页表根读内核虚拟地址
  -> 从内核镜像中找关键全局变量
  -> 从 System EPROCESS 出发枚举进程
```

---

## 7. 找 DTB / CR3：是否先 dump 内存？

找 DTB 时，MemProcFS 确实会读取低地址内存的一部分做扫描，但不是先 dump 全内存。

`VmmWinInit_DTB_FindValidate()` 会读低地址物理内存：

```c
LcRead(H->hLC, 0x1000, 0x9f000, pb16M + 0x1000);
```

如果 x64 low stub 路径没有找到，还会继续读低 16MB 的剩余部分：

```c
LcRead(H->hLC, 0x00100000, 0x00f00000, pb16M + 0x00100000);
```

然后在主机侧检查哪些页像合法页表：

```text
x64
  -> VmmWinInit_DTB_FindValidate_X64_LowStub()
  -> VmmWinInit_DTB_FindValidate_X64()

x86 PAE
  -> VmmWinInit_DTB_FindValidate_X86PAE()

x86
  -> VmmWinInit_DTB_FindValidate_X86()

ARM64
  -> VmmWinInit_DTB_FindValidate_ARM64()
```

DTB 查找优先级大致是：

```text
1. 用户通过 -dtb 显式指定。
2. LeechCore 后端提供 LC_OPT_MEMORYINFO_OS_DTB。
3. 用户指定 DTB range 时，在该范围内查找。
4. 自动扫描低地址内存寻找合法 DTB。
5. ARM64 场景可能需要更大范围扫描。
```

因此可以这样理解：

```text
不是先让 FPGA dump 完整内存。
而是 MemProcFS 按初始化需要，发出具体物理地址读请求。
FPGA 场景下，这些请求最终变成对对应物理地址的 PCIe Memory Read TLP。
```

---

## 8. 找 ntoskrnl.exe

找到 DTB 后，MemProcFS 先临时创建 PID 4 的 System 进程对象，因为后续要用 System DTB 做内核虚拟地址翻译。

`VmmWinInit_FindNtosScan()` 中有：

```c
pObSystemProcess = VmmProcessCreateEntry(
    H,
    TRUE,
    4,
    0,
    0,
    H->vmm.kernel.paDTB,
    0,
    "System         ",
    FALSE,
    NULL,
    0);

VmmProcessCreateFinish(H);
VmmTlbSpider(H, pObSystemProcess);
```

之后尝试定位 `ntoskrnl.exe` 基址：

```text
1. 从 LeechCore memory info 中取 kernel base hint。
2. 如果没有 hint，尝试 kernel entry / PsActiveProcessHead / PsLoadedModuleList 等 hint。
3. 如果仍没有，扫描内核虚拟地址空间。
4. 验证 PE 结构，确定 ntoskrnl.exe base 和 size。
```

找 `ntoskrnl.exe` 的原因是：

```text
需要解析 PE 导出表。
需要找 PsInitialSystemProcess。
需要获取 CodeView/PDB 信息。
需要后续定位 PsLoadedModuleList、KDBG、内核全局变量等。
```

---

## 9. PE 导出符号和 System EPROCESS

早期找 `System EPROCESS` 时，MemProcFS 优先解析目标内存里的 `ntoskrnl.exe` PE 导出表，而不是直接依赖 PDB。

`VmmWinInit_FindSystemEPROCESS()` 中：

```c
vaPsInitialSystemProcess = PE_GetProcAddress(
    H,
    pSystemProcess,
    H->vmm.kernel.vaBase,
    "PsInitialSystemProcess");

if(VmmRead(H, pSystemProcess, vaPsInitialSystemProcess, (PBYTE)&vaSystemEPROCESS, 8)) {
    ...
    goto success;
}
```

这一步的含义是：

```text
1. 从 ntoskrnl.exe 的 PE export directory 里找到 PsInitialSystemProcess 的 VA。
2. 读取这个 VA 处的指针值。
3. 得到 System 进程的 EPROCESS 地址。
```

如果导出路径失败，还有 fallback：

```text
1. 初始化 PDB 子系统。
2. 用 PDB_GetSymbolPTR() 查 PsInitialSystemProcess。
3. 如果仍失败，扫描 ALMOSTRO section，找疑似 System EPROCESS 指针。
4. 验证候选 EPROCESS 中的 DTB 是否等于 kernel.paDTB。
```

因此 System EPROCESS 的来源不是 KMD 返回的对象，也不是 Windows API 枚举结果，而是从目标内存里的内核镜像和全局变量解析出来的。

---

## 10. PDB 调试符号是怎么来的

PDB 符号不是从目标内存里“dump 出来的符号表”。目标内存中的 `ntoskrnl.exe` 通常只包含 CodeView debug 信息，其中有：

```text
PDB 文件名
GUID
Age
```

`MemProcFS/vmm/pe.c` 的 `PE_GetCodeViewInfo()` 会读 PE Debug Directory，并检查 CodeView `RSDS` 签名：

```c
VmmRead(H, pProcess, vaModuleBase + pDebugDirectory->AddressOfRawData, ...);
...
pCodeViewInfo->CodeView.Signature == 0x53445352
```

`0x53445352` 即 ASCII 的 `RSDS`。

如果 PE Debug Directory 路径失败，`MemProcFS/vmm/pdb.c` 的 `PDB_Initialize_Async_Kernel_ScanForPdbInfo()` 还有 fallback：

```c
VmmReadEx(
    H,
    pSystemProcess,
    H->vmm.kernel.vaBase,
    pb,
    0x00800000,
    &cbRead,
    VMM_FLAG_ZEROPAD_ON_FAIL);

for(i = 0; i < 0x00800000 - sizeof(PE_CODEVIEW); i += 4) {
    pPdb = (PPE_CODEVIEW)(pb + i);
    if(pPdb->Signature == 0x53445352) {
        ...
    }
}
```

这里确实会读取 `ntoskrnl` 开头约 8MB，但仍然是：

```text
kernel VA
  -> System DTB 翻译为 PA
  -> LcReadScatter
  -> FPGA TLP / 文件读 / 远程读
```

拿到 PDB 文件名、GUID、Age 之后，真正的 PDB 加载和符号查询在主机侧完成。

`PDB_Initialize()` 会初始化本机符号子系统：

```c
ctx->mspdb.hModuleSymSrv = LoadLibraryU(szPathSymSrv);
ctx->mspdb.hModuleDbgHelp = LoadLibraryU(szPathDbgHelp);
...
ctx->mspdb.pfn.SymInitialize(ctx->mspdb.hSym, H->pdb.szSymbolPath, FALSE);
```

如果 Microsoft `dbghelp.dll` / `symsrv.dll` 路径不可用，还会 fallback 到 `libpdbcrust`：

```c
LoadLibraryU("libpdbcrust...");
```

所以 PDB 路径可以概括为：

```text
目标内存 ntoskrnl
  -> 读 CodeView RSDS 信息
  -> 得到 ntkrnlmp.pdb / GUID / Age
  -> 主机侧从本地 cache 或 symbol path / symbol server 加载 PDB
  -> 主机侧查 _EPROCESS 字段偏移、全局变量 offset
```

注意区分两类 PDB 查询：

```text
查结构字段偏移：
  PDB_GetTypeChildOffsetShort("_EPROCESS", "UniqueProcessId", ...)
  -> 主机侧 PDB 查询即可，不需要读目标内存。

查内核全局变量的值：
  PDB_GetSymbolPTR("PsInitialSystemProcess", pSystemProcess, ...)
  -> 先从 PDB 得到 symbol offset
  -> 再读目标内存中 kernel.vaBase + offset 处的值。
```

---

## 11. EPROCESS 字段偏移如何确定

进程枚举需要知道 `EPROCESS` 和 `KPROCESS` 里的关键字段偏移。

`MemProcFS/vmm/vmmwin.c` 的 `VmmWinProcess_Enum64()` 中：

```c
if(!po->fValid) {
    VmmWinProcess_OffsetLocator64(H, pSystemProcess);
    VmmWinProcess_OffsetLocator_Print(H);
    if(!po->fValid) {
        VmmLog(H, MID_PROCESS, LOGLEVEL_VERBOSE, "Unable to fuzz EPROCESS offsets - trying debug symbols");
        VmmWinProcess_OffsetLocatorSYMSERV(H, pSystemProcess);
        VmmWinProcess_OffsetLocator_Print(H);
    }
    if(!po->fValid) {
        VmmLog(H, MID_PROCESS, LOGLEVEL_CRITICAL, "Unable to locate EPROCESS offsets");
        return FALSE;
    }
}
```

也就是说，它优先尝试启发式 / fuzz / pattern 定位；失败后再用 PDB 符号。

PDB 路径 `VmmWinProcess_OffsetLocatorSYMSERV()` 会查询：

```c
PDB_GetTypeChildOffsetShort(H, PDB_HANDLE_KERNEL, "_KPROCESS", "DirectoryTableBase", &po->DTB);
PDB_GetTypeChildOffsetShort(H, PDB_HANDLE_KERNEL, "_KPROCESS", "UserDirectoryTableBase", &po->DTB_User);
PDB_GetTypeChildOffsetShort(H, PDB_HANDLE_KERNEL, "_EPROCESS", "ImageFileName", &po->Name);
PDB_GetTypeChildOffsetShort(H, PDB_HANDLE_KERNEL, "_EPROCESS", "UniqueProcessId", &po->PID);
PDB_GetTypeChildOffsetShort(H, PDB_HANDLE_KERNEL, "_EPROCESS", "InheritedFromUniqueProcessId", &po->PPID);
PDB_GetTypeChildOffsetShort(H, PDB_HANDLE_KERNEL, "_EPROCESS", "ActiveProcessLinks", &po->FLink);
PDB_GetTypeChildOffsetShort(H, PDB_HANDLE_KERNEL, "_EPROCESS", "Peb", &po->PEB);
PDB_GetTypeChildOffsetShort(H, PDB_HANDLE_KERNEL, "_EPROCESS", "VadRoot", &po->VadRoot);
PDB_GetTypeChildOffsetShort(H, PDB_HANDLE_KERNEL, "_EPROCESS", "ObjectTable", &po->ObjectTable);
```

这些字段分别用于：

```text
_EPROCESS.UniqueProcessId
  -> PID

_EPROCESS.InheritedFromUniqueProcessId
  -> PPID

_EPROCESS.ImageFileName
  -> 进程短名

_KPROCESS.DirectoryTableBase
  -> 进程 DTB / CR3

_KPROCESS.UserDirectoryTableBase
  -> 用户态 DTB

_EPROCESS.ActiveProcessLinks
  -> 进程链表遍历

_EPROCESS.Peb
  -> 用户态 PEB

_EPROCESS.VadRoot
  -> 虚拟地址空间区域

_EPROCESS.ObjectTable
  -> 句柄表
```

---

## 12. 进程枚举：ActiveProcessLinks 遍历

拿到 System EPROCESS 和字段偏移后，MemProcFS 开始枚举进程。

入口是 `VmmWinProcess_Enumerate()`：

```c
if(H->vmm.tpMemoryModel == VMM_MEMORYMODEL_X64 || H->vmm.tpMemoryModel == VMM_MEMORYMODEL_ARM64) {
    fResult = VmmWinProcess_Enum64(H, pSystemProcess, fRefreshTotal, psvaNoLinkEPROCESS);
} else if(H->vmm.tpMemoryModel == VMM_MEMORYMODEL_X86 || H->vmm.tpMemoryModel == VMM_MEMORYMODEL_X86PAE) {
    fResult = VmmWinProcess_Enum32(H, pSystemProcess, fRefreshTotal, psvaNoLinkEPROCESS);
}
```

x64 路径中，`VmmWinProcess_Enum64()` 会沿 `ActiveProcessLinks` 链表遍历：

```c
VmmWin_ListTraversePrefetch(
    H,
    pSystemProcess,
    FALSE,
    &ctx,
    1,
    &pSystemProcess->win.EPROCESS.va,
    H->vmm.offset.EPROCESS.FLink,
    H->vmm.offset.EPROCESS.cbMaxOffset,
    (VMMWIN_LISTTRAVERSE_PRE_CB)VmmWinProcess_Enum64_Pre,
    (VMMWIN_LISTTRAVERSE_POST_CB)VmmWinProcess_Enum64_Post,
    H->vmm.pObCCachePrefetchEPROCESS);
```

这一步可以理解为：

```text
System EPROCESS
  -> ActiveProcessLinks.Flink
  -> 下一个 EPROCESS
  -> 继续遍历
  -> 每个节点读出 EPROCESS bytes
  -> 解析 PID / PPID / Name / DTB / PEB
  -> VmmProcessCreateEntry()
```

`VmmWinProcess_Enum64_Post()` 负责从读出的 `EPROCESS` bytes 里解析字段：

```c
pdwState = (PDWORD)(pb + po->State);
pdwPID = (PDWORD)(pb + po->PID);
pdwPPID = (PDWORD)(pb + po->PPID);
ppaDTB_Kernel = (PQWORD)(pb + po->DTB);
ppaDTB_User = (PQWORD)(pb + po->DTB_User);
szName = (LPSTR)(pb + po->Name);
pqwPEB = (PQWORD)(pb + po->PEB);
```

然后创建 MemProcFS 自己的进程对象：

```c
pObProcess = VmmProcessCreateEntry(
    H,
    ctx->fTotalRefresh,
    *pdwPID,
    *pdwPPID,
    *pdwState,
    *ppaDTB_Kernel & ~0xfff,
    po->DTB_User ? (*ppaDTB_User & ~0xfff) : 0,
    szName,
    fUser,
    pb,
    cb);
```

`VmmWin_ListTraversePrefetch()` 中的 `Prefetch` 很重要。它不是一个进程一个进程慢慢同步读，而是在链表遍历过程中预取相关页，配合 LeechCore 的 `MEM_SCATTER` 批量读模型，提高 FPGA、远程后端和高延迟后端的性能。

---

## 13. `VMMDLL_PidList` / `VMMDLL_ProcessGetInformation` 的数据来源

进程枚举完成后，MemProcFS 会提交进程表。

`VmmProcessCreateFinish()`：

```c
ObMap_SortEntryIndexByKey(ptNew->pObProcessMap);
ObContainer_SetOb(H->vmm.pObCPROC, ptNew);
```

也就是说，MemProcFS 先构建一个新的 process map，完成后一次性替换当前进程表：

```text
解析 EPROCESS 链表
  -> VmmProcessCreateEntry()
  -> 临时 new process map
  -> VmmProcessCreateFinish()
  -> H->vmm.pObCPROC 指向新表
```

`VMMDLL_PidList()` 的实现是：

```c
BOOL VMMDLL_PidList_Impl(...)
{
    VmmProcessListPIDs(H, pPIDs, pcPIDs, 0);
    return (*pcPIDs ? TRUE : FALSE);
}
```

`VmmProcessListPIDs()` 遍历的是：

```text
H->vmm.pObCPROC
  -> pObProcessMap
  -> PVMM_PROCESS
  -> dwPID
```

`VMMDLL_ProcessGetInformation()` 则从 `PVMM_PROCESS` 填充用户可见结构：

```c
pInfo->dwPID = dwPID;
pInfo->dwPPID = pObProcess->dwPPID;
pInfo->dwState = pObProcess->dwState;
pInfo->paDTB = pObProcess->paDTB;
pInfo->paDTB_UserOpt = pObProcess->paDTB_UserOpt;
memcpy(pInfo->szName, pObProcess->szName, sizeof(pInfo->szName));
...
pInfo->win.vaEPROCESS = pObProcess->win.EPROCESS.va;
pInfo->win.vaPEB = pObProcess->win.vaPEB;
```

所以 `pslist` 的 PID、进程名、DTB、PEB 信息来自：

```text
目标物理内存中的 EPROCESS
  -> MemProcFS 主机侧解析
  -> H->vmm.pObCPROC 进程表
  -> VMMDLL_PidList / VMMDLL_ProcessGetInformation
```

不是来自：

```text
KMD 调 Windows API 枚举进程
  -> 写入 DMAAddrBuffer
  -> FPGA 读回 PID 列表
```

---

## 14. PID 进程表什么时候刷新

如果底层设备是 live / volatile 设备，例如 FPGA，MemProcFS 会启动后台刷新线程。

`VmmProcInitialize()` 中：

```c
if(result && H->dev.fVolatile && !H->cfg.fDisableBackgroundRefresh) {
    H->vmm.ThreadProcCache.fEnabled = TRUE;
    VmmWork_Value(H, VmmProcCacheUpdaterThread, 0, 0, VMMWORK_FLAG_PRIO_NORMAL);
}
```

注释中也说明了：

```c
// set up cache maintenance in the form of a separate eternally running
// worker thread in case the backend is a volatile device (FPGA).
// If the underlying device isn't volatile then there is no need to update!
// NB! Files are not considered to be volatile.
```

本地 volatile 设备默认周期在 `vmmproc.c` 中：

```c
#define VMMPROC_UPDATERTHREAD_LOCAL_PERIOD              100
#define VMMPROC_UPDATERTHREAD_LOCAL_MEM                 (300 / VMMPROC_UPDATERTHREAD_LOCAL_PERIOD)              // 0.3s
#define VMMPROC_UPDATERTHREAD_LOCAL_TLB                 (2 * 1000 / VMMPROC_UPDATERTHREAD_LOCAL_PERIOD)         // 2s
#define VMMPROC_UPDATERTHREAD_LOCAL_FAST                (5 * 1000 / VMMPROC_UPDATERTHREAD_LOCAL_PERIOD)         // 5s
#define VMMPROC_UPDATERTHREAD_LOCAL_MEDIUM              (15 * 1000 / VMMPROC_UPDATERTHREAD_LOCAL_PERIOD)        // 15s
#define VMMPROC_UPDATERTHREAD_LOCAL_SLOW                (5 * 60 * 1000 / VMMPROC_UPDATERTHREAD_LOCAL_PERIOD)    // 5m
```

刷新层次如下：

```text
VmmProcRefresh_MEM()
  -> 刷新物理内存 cache，默认约 0.3 秒

VmmProcRefresh_TLB()
  -> 刷新页表 cache，默认约 2 秒

VmmProcRefresh_Fast()
  -> fast refresh，包含 partial process refresh，默认约 5 秒

VmmProcRefresh_Medium()
  -> medium refresh，包含 full process refresh，默认约 15 秒

VmmProcRefresh_Slow()
  -> slow refresh，包含 registry/user/service/pool/physmem map 等慢速对象刷新，默认约 5 分钟
```

`VmmProcRefresh_Fast()` 和 `VmmProcRefresh_Medium()` 都会进入：

```c
VmmProc_RefreshProcesses(H, fRefreshTotal)
```

Windows 路径会再次调用：

```c
pObProcessSystem = VmmProcessGet(H, 4);
fResult = VmmWinProcess_Enumerate(H, pObProcessSystem, fRefreshTotal, NULL);
```

所以 PID 表刷新机制是：

```text
初始化：
  VmmWinProcess_Enumerate(..., TRUE)
  -> 完整枚举 EPROCESS
  -> VmmProcessCreateFinish()
  -> 提交进程表

运行中，volatile 设备：
  Fast refresh，默认约 5 秒
    -> partial process refresh

  Medium refresh，默认约 15 秒
    -> full process refresh

  Slow refresh，默认约 5 分钟
    -> medium refresh + 更多慢速对象刷新

文件 / dump 等非 volatile 后端：
  默认不需要后台周期刷新
```

远程设备默认刷新周期更慢：

```text
REMOTE_MEM     5s
REMOTE_TLB     2min
REMOTE_FAST    15s
REMOTE_MEDIUM  3min
REMOTE_SLOW    10min
```

---

## 15. PDB 符号表什么时候刷新

PDB 和 PID 进程表不同。PDB 符号信息是某个二进制版本的静态信息，不是 live memory state，因此它不是按 5 秒、15 秒这种周期刷新。

`PDB_Initialize()` 中有：

```c
if(H->pdb.fInitialized) {
    return;
}
```

也就是说，PDB 子系统初始化后会缓存。

kernel PDB 可以异步加载：

```c
if(fInitializeKernelAsync) {
    VmmWork_Ob(H, PDB_Initialize_Async_Kernel_ThreadProc, ...);
} else {
    PDB_Initialize_Async_Kernel_ThreadProc(H, pObKernelParameters);
}
```

后续如果需要某个模块的 PDB，`PDB_GetHandleFromModuleAddress()` 会先看 PDB database 中是否已有该模块：

```c
if(vaModuleBase == pObPdbEntry->vaModuleBase) {
    return qwPdbHash;
}
```

没有才读取该模块 PE CodeView 信息，并加入 PDB database：

```c
PE_GetCodeViewInfo(H, pProcess, vaModuleBase, NULL, &CodeViewInfo);
PDB_AddModuleEntry(...);
```

所以 PDB 生命周期是：

```text
首次 PDB_Initialize
  -> 初始化符号引擎
  -> 读取 kernel CodeView 信息
  -> 主机侧加载 kernel PDB
  -> 缓存在 H->vmm.pObPdbContext

后续模块符号：
  -> 按需读取模块 CodeView
  -> 主机侧加载/缓存对应 PDB

不会像 PID 表一样周期刷新
```

---

## 16. KMD 在这些流程中的真实作用

KMD 命令定义在 `pcileech/pcileech.h`：

```c
#define KMD_CMD_READ                        1
#define KMD_CMD_WRITE                       2
#define KMD_CMD_TERMINATE                   3
#define KMD_CMD_MEM_INFO                    4
#define KMD_CMD_EXEC                        5
#define KMD_CMD_READ_VA                     6
#define KMD_CMD_WRITE_VA                    7
#define KMD_CMD_EXEC_EXTENDED               8
```

指定 `-kmd` 时，PCILeech 会尝试连接已有 KMD。`pcileech/kmd.c` 的 `KMDOpen_LoadExisting()`：

```c
ctxMain->phKMD->dwPageAddr32 = (DWORD)ctxMain->cfg.paKMD;
ctxMain->pk = ctxMain->phKMD->pk = (PKMDDATA)ctxMain->phKMD->pbPageData;

if(!DeviceReadDMA_Retry(ctxMain->hLC, ctxMain->phKMD->dwPageAddr32, 4096, ctxMain->phKMD->pbPageData)) {
    ...
}

if(ctxMain->phKMD->pk->MAGIC != KMDDATA_MAGIC) {
    ...
}

if(!KMD_GetPhysicalMemoryMap()) {
    ...
}
```

`KMD_GetPhysicalMemoryMap()` 发的是：

```c
KMD_SubmitCommand(KMD_CMD_MEM_INFO);
```

也就是说，KMD 在这里主要是：

```text
1. 被 PCILeech 连接和校验。
2. 可用于获取物理内存 map。
3. 可用于某些 KMD read/write/exec/read_va/write_va 命令。
```

但 `pslist` 常规路径并不依赖 KMD 调 Windows API 枚举进程。

---

## 17. 为什么不是“KMD 调 Windows API 枚举进程”

常见误解路径是：

```text
CLI
  -> USB / FPGA / TLP
  -> KMD
  -> Windows kernel API 枚举进程
  -> KMD 把 PID 放进 DMAAddrBuffer
  -> FPGA 读回 PID 列表
```

实际路径是：

```text
CLI
  -> MemProcFS / VMMDLL
  -> LeechCore
  -> FPGA 读取目标物理内存
  -> 主机侧解析 DTB / ntoskrnl / PsInitialSystemProcess / EPROCESS
  -> 构建 H->vmm.pObCPROC
  -> VMMDLL_PidList / VMMDLL_ProcessGetInformation
```

原设计更巧妙的地方在于：

```text
不要求目标机执行代码
  -> 可以用于 dump 文件、休眠文件、VM 内存、远程采集

不信任目标系统 API
  -> 更适合取证，减少 hook/rootkit 对 API 结果的影响

设备层保持纯粹
  -> LeechCore 后端只管读写物理内存，不需要理解 Windows

OS 解析集中在 MemProcFS
  -> 进程、模块、VAD、句柄、注册表、网络等能力共享同一套页表翻译和 cache

性能路径统一
  -> 所有高层结构解析最终都能利用 MEM_SCATTER / LcReadScatter 批量读

KMD 风险隔离
  -> 避免把 pslist 这类基础分析能力绑定到目标内核执行、IRQL、锁、PatchGuard、版本兼容等问题上
```

这也是 MemProcFS 能同时支持 live DMA、内存镜像、crash dump、hibernation file、远程 LeechAgent、VMWare 等来源的原因。

---

## 18. 是否一定需要 KMD

结论：

```text
不一定需要 KMD。
```

MemProcFS 常规分析需要的是：

```text
1. 有可用 LeechCore 物理内存读取后端。
2. 能找到或指定 DTB / CR3。
3. Windows 内核结构没有损坏到无法解析。
4. 目标内存区域没有被 IOMMU / 设备限制 / memory map 限制完全阻断。
```

KMD 适合的场景是：

```text
需要目标内核侧执行代码。
需要某些特殊读写。
需要辅助获取物理内存 map。
使用传统 PCILeech KMD load / exec / shellcode 流程。
```

MemProcFS 的常规 `pslist`、虚拟地址读取、模块枚举、VAD 解析等，不以 KMD 为基本依赖。

---

## 19. 结合游戏虚拟地址读取例子

以前面的例子：

```text
pcileech.exe display -pid 5064 -vamin 0x123DCCB8 -vamax 0x123DCCCC -kmd 0x7fffe000 -device FPGA://ft2232h=true -v
```

虽然命令里带了 `-kmd`，但常规 MemProcFS 虚拟地址读取路径仍然是：

```text
PID 5064
  -> MemProcFS 找 PVMM_PROCESS
  -> 取进程 paDTB / CR3
  -> VA 0x123DCCB8 按页翻译到 PA
  -> LcReadScatter 读取物理页
  -> FPGA 对物理地址发 TLP
  -> 返回数据
  -> CLI 显示内存内容
```

这里需要强调：

```text
0x123DCCB8 是进程虚拟地址。
FPGA 不直接读取这个虚拟地址。
真正发给 FPGA 的是翻译后的物理地址。
KMD 地址 0x7fffe000 是 KMD shellcode/control page 的地址，不是进程虚拟地址翻译的根。
```

如果读取失败，常见原因包括：

```text
PID 不正确或进程已退出。
VA 不属于该进程有效地址空间。
页表项无效或页面被换出。
MemProcFS 没有正确识别目标 DTB。
IOMMU / DMA 限制 / memory map 导致目标物理页不可读。
```

---

## 20. 总览图

```text
pcileech.exe pslist / display -pid
        |
        v
PCILeech CLI action
        |
        v
Vmmx_Initialize("-device existing")
        |
        v
VMMDLL / MemProcFS
        |
        |  Windows 结构解析:
        |  DTB -> ntoskrnl -> PsInitialSystemProcess
        |  -> System EPROCESS -> ActiveProcessLinks
        |  -> H->vmm.pObCPROC
        |
        v
VmmRead / VmmReadScatterVirtual / VmmReadScatterPhysical
        |
        v
LeechCore LcReadScatter
        |
        v
FPGA / file / remote / dump / PMEM backend
        |
        v
目标物理内存数据
```

---

## 21. 一句话总结

```text
PCILeech CLI 负责发起动作；
LeechCore 负责统一读取物理内存；
MemProcFS 负责在主机侧把这些物理页解释成 Windows 的页表、进程、模块、VAD、句柄等对象。

pslist 的 PID 信息来自 MemProcFS 解析 EPROCESS 后维护的进程表；
虚拟地址读取来自进程 DTB 的 VA->PA 翻译；
PDB 只提供主机侧符号和字段偏移辅助；
KMD 是可选辅助，不是这些常规路径的必要条件。
```
