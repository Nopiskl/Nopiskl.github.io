
---

**User**

继续解释一下，文档中为什么有LcRead，它会自动处理4KB读
但是DeviceReadDMA()仍然选择自己调用LcReadScatter

---

**Cursor**

我再对照一下 `LcRead()` 的实际实现，避免只按文档抽象解释。

这个问题可以从 **“`LcRead()` 是便利接口，而 `DeviceReadDMA()` 是 dump/DMA 专用接口”** 来理解。

虽然 `LcRead()` 内部确实会自动按 4KB page 构造 `MEM_SCATTER`，但它的语义和 `DeviceReadDMA()` 需要的语义不一样。

---

## 1. `LcRead()` 自动处理 4KB 的目的是什么？

`LcRead()` 是 LeechCore 给普通调用者用的 **连续内存读取便利接口**。

它允许调用者这样读：

```c
LcRead(hLC, pa, cb, pb);
```

调用者不需要关心：

```text
pa 是否 4KB 对齐
cb 是否 4KB 对齐
是否跨页
首尾页怎么处理
底层是否需要 scatter
```

它内部大致会做：

```text
1. 计算这次读取覆盖多少个 4KB page
2. 如果首尾不对齐，用临时 4KB buffer
3. 构造 MEM_SCATTER
4. 调用 LcReadScatter()
5. 检查所有 page 是否成功
6. 如果所有 page 成功，把首尾临时 buffer 拷贝回用户 buffer
7. 返回 TRUE / FALSE
```

源码里的核心逻辑就是：

```c
cMEMs = ((pa & 0xfff) + cb + 0xfff) >> 12;
fFirst = (pa & 0xfff) || (cb < 0x1000);
fLast = (cMEMs > 1) && ((pa + cb) & 0xfff);
...
LcReadScatter(hLC, (DWORD)cMEMs, ppMEMs);
for(i = 0; i < cMEMs; i++) {
    if(!ppMEMs[i]->f) { goto fail; }
}
...
fResult = TRUE;
```

所以 `LcRead()` 的语义是：

```text
请读取这一段连续地址。
只要其中任意一个 page 失败，整个 LcRead() 就失败。
```

它返回的是整体成功/失败。

---

## 2. `DeviceReadDMA()` 需要的不是这个语义

`DeviceReadDMA()` 的用途更偏向：

```text
大块物理内存 dump / DMA 扫描 / 页级统计
```

它要求：

```c
if((pa & 0xfff) || !cb || (cb & 0xfff)) { return 0; }
```

也就是说它只接受：

```text
起始地址 4KB 对齐
长度 4KB 对齐
```

所以它不需要 `LcRead()` 处理非对齐读。

然后它自己构造每个 4KB 页：

```c
cMEMs = cb >> 12;
LcAllocScatter2(cb, pb, cMEMs, &ppMEMs);

for(i = 0; i < cMEMs; i++) {
    ppMEMs[i]->qwA = pa + ((QWORD)i << 12);
}
```

之后调用：

```c
LcReadScatter(ctxMain->hLC, cMEMs, ppMEMs);
```

关键区别在后面：

```c
for(i = 0; i < cMEMs; i++) {
    pMEM = ppMEMs[i];
    if(pMEM->f) {
        cbRead += pMEM->cb;
    } else {
        ZeroMemory(pMEM->pb, pMEM->cb);
    }
    if(pPageStat) {
        PageStatUpdate(...);
    }
}
```

它不是要求所有页都成功，而是：

```text
成功一页算一页；
失败页置零；
继续处理后面的页；
最后返回成功读取了多少字节；
可选更新页统计信息。
```

这和 `LcRead()` 的语义完全不同。

---

## 3. 最核心区别：`LcRead()` 是 all-or-nothing，`DeviceReadDMA()` 是 partial success

可以这样对比：

| 项目 | `LcRead()` | `DeviceReadDMA()` |
|---|---|---|
| 读取类型 | 任意连续地址 | 4KB 对齐的大块 DMA |
| 是否处理非对齐 | 是 | 否，直接拒绝 |
| 内部是否使用 scatter | 是 | 是 |
| 调用方式 | 调用者不接触 scatter | 调用者直接使用 scatter |
| 成功语义 | 所有 page 成功才返回 TRUE | 部分页成功也算读取成功 |
| 失败处理 | 任意 page 失败则整体失败 | 失败页置零 |
| 结果粒度 | 一个 BOOL | 成功字节数 + 页统计 |
| 适合场景 | 小范围普通读、结构体读、KMD 辅助读 | dump、scan、大范围物理内存采集 |

所以问题不在于“`LcRead()` 能不能自动处理 4KB”，而在于：

```text
LcRead() 自动处理 4KB 后，把每页细节隐藏掉了；
DeviceReadDMA() 恰恰需要这些每页细节。
```

---

## 4. 为什么 dump 场景不能简单用 `LcRead()`？

假设要 dump 16MB：

```text
16MB = 4096 个 4KB page
```

其中第 100 页、第 233 页、第 3000 页读失败。

如果用 `LcRead()`：

```c
BOOL ok = LcRead(hLC, pa, 16 * 1024 * 1024, pb);
```

只要其中一个 page 失败，`LcRead()` 就会返回 `FALSE`。

这对 dump 不友好，因为真实物理内存读取中，失败页很常见：

```text
memory hole
MMIO 区域
不可达物理地址
设备 timeout
IOMMU/VT-d 限制
目标系统响应异常
```

dump 工具更希望：

```text
能读的页保留下来；
不能读的页填 0；
继续 dump；
最后告诉用户成功/失败比例。
```

这就是 `DeviceReadDMA()` 的价值。

---

## 5. 为什么不用循环多次调用 `LcRead()` 每页读？

理论上可以：

```c
for(i = 0; i < cMEMs; i++) {
    if(LcRead(ctxMain->hLC, pa + i * 0x1000, 0x1000, pb + i * 0x1000)) {
        cbRead += 0x1000;
    } else {
        ZeroMemory(pb + i * 0x1000, 0x1000);
    }
}
```

但这样性能会差很多。

因为每次 `LcRead()` 都会：

```text
构造 scatter
调用 LcReadScatter
做 memory map 翻译
加锁
调用后端
释放资源
统计
```

如果读 4096 页，就会进入 4096 次 LeechCore 调用路径。

而 `DeviceReadDMA()` 是：

```text
一次构造 4096 个 MEM_SCATTER
一次调用 LcReadScatter()
底层一次批量处理
```

这样 FPGA、remote、file、contiguous 后端都有机会优化：

```text
FPGA: 批量 TLP / pipeline
remote: 一次打包传输
file: 合并连续 offset
contiguous backend: 聚合成大块顺序读
```

所以 `DeviceReadDMA()` 直接调用 `LcReadScatter()` 同时解决了两个问题：

```text
保留逐页结果；
保持批量性能。
```

---

## 6. `LcRead()` 和 `DeviceReadDMA()` 的定位不同

你可以把它们理解成两个不同层级的 API：

```text
LcRead()
  面向“我只想读一段内存，成功/失败给我一个结果”
  简单、安全、隐藏页细节

LcReadScatter()
  面向“我想批量提交很多 page，并且关心每个 page 的状态”
  高性能、细粒度、适合 dump/scan

DeviceReadDMA()
  PCILeech 基于 LcReadScatter 做的产品级封装
  增加了失败页置零、统计、成功字节数等 dump 语义
```

所以不是：

```text
既然 LcRead 会自动处理 4KB，DeviceReadDMA 就没必要用 LcReadScatter
```

而是：

```text
LcRead 正因为隐藏了 4KB 细节，所以不适合 DeviceReadDMA 这种需要页级结果的场景。
```

---

## 7. 可以用一个比喻

`LcRead()` 像是：

```text
帮我下载这个文件，下载失败就告诉我失败。
```

`LcReadScatter()` 像是：

```text
帮我下载这 4096 个分片，每个分片成功失败都告诉我。
```

`DeviceReadDMA()` 像是：

```text
我要做镜像备份：
成功的分片写入；
失败的分片填 0；
记录坏块统计；
不要因为一个坏块就终止整个备份。
```

所以 `DeviceReadDMA()` 必须用 `LcReadScatter()`，而不是 `LcRead()`。

---

## 8. 最终结论

`LcRead()` 确实会自动按 4KB page 转换成 `LcReadScatter()`，但它是一个 **普通连续读取便利函数**，语义是：

```text
全部页成功才成功。
```

`DeviceReadDMA()` 是 PCILeech dump/DMA 场景的专用封装，语义是：

```text
按 4KB 页批量读取；
保留每页成功/失败状态；
失败页清零；
更新页统计；
返回成功读取字节数；
不中断整个大块读取。
```

因此它不能直接用 `LcRead()`，而要自己构造 `MEM_SCATTER` 并调用 `LcReadScatter()`。

