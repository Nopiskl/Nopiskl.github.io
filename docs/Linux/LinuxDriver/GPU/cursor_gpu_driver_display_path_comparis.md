# GPU driver display path comparison
_Exported on 2026/4/5 at GMT+8 12:51:54 from Cursor (2.6.21)_

---

**User**

@bsp/modules/gpu @bsp/drivers/drm 
请基于具体源码做深入对比分析，目标是解释：

对于同一个 GPU 驱动体系，为什么 `dc_sunxi + disp2(fbdev)` 能把标准 DRM GPU buffer 直接桥接到 `disp2` 显示路径，而不依赖 DRM/KMS；而另一条路径 `pvrdriver + DRM/KMS` 却通常依赖 DRM 的 GEM/PRIME/dma-buf/KMS 机制来完成显示输出。

请严格按下面要求分析：

【分析对象】
1. `dc_sunxi + disp2(fbdev)` 路径
2. `pvrdriver + DRM/KMS` 路径
3. DRM 导出 dma-buf fd 的标准路径（GEM/PRIME/export/import/KMS framebuffer）

【核心问题】
1. `dc_sunxi` 为什么可以不经过 KMS，直接把 GPU 产出的 buffer 交给 `disp2(fbdev)` 显示？
2. 这里“直接桥接”的前提是什么：
   - 共享的是物理地址、ION handle、dma-buf、还是厂商私有 buffer 对象？
   - `disp2` 消费 buffer 时依赖的元数据是什么（paddr/iova/format/stride/modifier/sync fence）？
3. 这种路径为什么不需要标准 DRM/KMS 的 atomic/modeset/framebuffer 管理？
4. 对比 `pvrdriver + DRM/KMS`，后者为什么往往必须经过：
   - GEM/BO 创建
   - PRIME 导出/导入 dma-buf fd
   - drmModeAddFB(2) / atomic commit / page flip
5. “DRM 导出 dma-buf fd”本质解决了什么问题？它和 `dc_sunxi + disp2` 这种直连方式相比，多了哪些抽象层，少了哪些厂商耦合？
6. 两条路径在以下方面的差距是什么：
   - buffer ownership
   - buffer allocation
   - buffer sharing/import/export
   - display pipeline binding
   - 同步机制（fence/reservation）
   - userspace API
   - 多进程共享
   - upstream 标准化程度
   - 移植性/维护成本
   - 零拷贝能力
   - 调试复杂度

【证据要求】
- 必须结合源码，不要只讲概念
- 对每个关键结论给出对应源码证据：
  - 关键结构体
  - 关键函数
  - 调用链
  - ioctl 定义
  - buffer 导出/导入接口
  - framebuffer 创建或 layer 配置路径
- 尽量指出以下内容：
  - GPU buffer 在哪里分配
  - buffer 句柄如何在模块间传递
  - 最终 display controller 拿到的是哪类对象
  - 是谁做 cache/sync/fence 处理
  - 是谁决定 format/stride/addr
- 如果源码里没有明确 dma-buf，而是私有接口，请明确指出私有机制及其替代了 DRM/KMS 的哪一部分



### 1. 现有链路
核心路径是：

- `DC_SUNXI_init()`：初始化 fbdev 显示设备，并判断是否支持 flip
- `DC_SUNXI_BufferAlloc()`：按 `width * ui32BPP` 计算 stride 和 buffer 大小
- `DC_SUNXI_BufferAcquire()`：按 `bufferID * ui32ByteSize` 推出物理地址
- `DC_SUNXI_ContextConfigureCheck()`：校验 crop/display/buffer 尺寸
- `DC_SUNXI_ContextConfigure()`：通过 `fb_pan_display()` / `fb_set_var()` 做翻页

相关代码位置如下。

`ContextConfigureCheck` 里的尺寸检查：

```248:293:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/services/3rdparty/dc_sunxi/dc_sunxi.c
	if(pasSurfAttrib[0].sCrop.sDims.ui32Width  != psVar->xres ||
	   pasSurfAttrib[0].sCrop.sDims.ui32Height != psVar->yres ||
	   pasSurfAttrib[0].sCrop.i32XOffset != 0 ||
	   pasSurfAttrib[0].sCrop.i32YOffset != 0)
	{
		eError = PVRSRV_ERROR_DC_INVALID_CROP_RECT;
		goto err_unlock;
	}

	if(pasSurfAttrib[0].sDisplay.sDims.ui32Width !=
	   pasSurfAttrib[0].sCrop.sDims.ui32Width ||
	   pasSurfAttrib[0].sDisplay.sDims.ui32Height !=
	   pasSurfAttrib[0].sCrop.sDims.ui32Height ||
	   pasSurfAttrib[0].sDisplay.i32XOffset !=
	   pasSurfAttrib[0].sCrop.i32XOffset ||
	   pasSurfAttrib[0].sDisplay.i32YOffset !=
	   pasSurfAttrib[0].sCrop.i32YOffset)
	{
		eError = PVRSRV_ERROR_DC_INVALID_DISPLAY_RECT;
		goto err_unlock;
	}

	if(psBuffer->ui32Width  != psVar->xres &&
	   psBuffer->ui32Height != psVar->yres)
	{
		eError = PVRSRV_ERROR_DC_INVALID_BUFFER_DIMS;
		goto err_unlock;
	}
```

`BufferAlloc` / `BufferAcquire`：

```436:514:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/services/3rdparty/dc_sunxi/dc_sunxi.c
	psBuffer->psDeviceContext = psDeviceContext;
	psBuffer->ui32ByteStride =
		psSurfInfo->sDims.ui32Width * psCreateInfo->ui32BPP;

	psBuffer->ui32Width = psSurfInfo->sDims.ui32Width;
	psBuffer->ui32Height = psSurfInfo->sDims.ui32Height;

	if (!DC_SUNXI_GetBufferID(psDeviceContext, &psBuffer->ui32BufferID))
	{
		eError = PVRSRV_ERROR_OUT_OF_MEMORY;
		goto err_free;
	}

	ui32ByteSize = psBuffer->ui32ByteStride * psBuffer->ui32Height;

	*puiLog2PageSize = PAGE_SHIFT;
	*pui32PageCount	 = BYTE_TO_PAGES(ui32ByteSize);
	*pui32PhysHeapID = DC_PHYS_HEAP_ID;
	*pui32ByteStride = psBuffer->ui32ByteStride;
	*phBuffer	 = psBuffer;
...
	uiStartAddr += psBuffer->ui32BufferID * ui32ByteSize;
	ui32MaxLen = psDeviceData->psLINFBInfo->fix.smem_len -
				 psBuffer->ui32BufferID * ui32ByteSize;
```

`FlipPossible` 里 flip 能力判断是基于 `fix.line_length * yres`：

```540:588:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/services/3rdparty/dc_sunxi/dc_sunxi.c
	if((psLINFBInfo->fix.line_length * sVar.yres) % PAGE_SIZE != 0)
	{
		pr_err("Line length (in bytes) x yres is not a multiple of "
			   "page size. Flipping disabled.\n");
		return false;
	}
...
	if(psLINFBInfo->fix.smem_len < psLINFBInfo->fix.line_length * sVar.yres_virtual)
	{
		pr_err("'fix' not re-allocated with sufficient buffer space. "
			   "Flipping disabled.\n");
		return false;
	}
```

---

### 2. 这里有两个关键疑点

#### 疑点 A：`ContextConfigureCheck()` 的尺寸判断条件写错了
这段：

```c
if(psBuffer->ui32Width  != psVar->xres &&
   psBuffer->ui32Height != psVar->yres)
```

这里用了 `&&`，意思是“宽和高都不等时才报错”。

但从上下文语义看，应该是只要宽或高任意一个不匹配，就应该判 invalid，也就是 `||`。

否则会出现：

- 宽不对、高对：放过
- 宽对、高不对：放过
- 只有宽高都不对才拦截

这明显不符合前面对 crop/display 的严格全匹配逻辑，也很容易让后面 `BufferAcquire()` 按错误的 `ui32ByteSize` 去切 framebuffer。

这个点我认为已经足够像一个实打实 bug。

---

#### 疑点 B：buffer 大小/偏移使用的是 `width * bpp`，但 flip 能力校验使用的是 `fix.line_length`
这两边不一致：

- `FlipPossible()` 认为单帧大小是 `fix.line_length * yres`
- `BufferAlloc()` / `BufferAcquire()` 认为单帧大小是 `width * ui32BPP * height`

如果 fbdev 的实际 stride 有 padding，那么：

- 真正每帧内存跨度应是 `fix.line_length * yres`
- 但当前 `Acquire` 用的是更小的 `ui32ByteSize`
- 那么 `bufferID = 1` 时起始地址会落在前一帧“中间”而不是下一帧开头

这会直接导致：
- 翻页偏移和 GPU 认为的 buffer 物理布局不一致
- 显示内容错行/撕裂/花屏
- 或者上层某些校验、映射和实际 scanout 不匹配

这一点比 A 更“结构性”，但要不要改，要看 `psCreateInfo->ui32BPP` 的语义和 PVR DC 对 `byteStride` 的预期，不能直接拍脑袋动。

不过从当前代码内部自洽性来看，它确实不一致。

---

### 3. 我建议的下一步
如果你要我继续推进，我建议先做最小且确定性的修复：

#### 先修 A
把：

```c
if(psBuffer->ui32Width  != psVar->xres &&
   psBuffer->ui32Height != psVar->yres)
```

改成：

```c
if(psBuffer->ui32Width  != psVar->xres ||
   psBuffer->ui32Height != psVar->yres)
```

这是低风险、逻辑明确的修复。

#### 然后再验证 B
继续往下查两件事：

1. `DC_BUFFER_CREATE_INFO.ui32BPP` 的单位到底是 byte/pixel 还是 bit/pixel  
2. 上游/同类 DC 实现里，`pui32ByteStride` 和 `BufferAcquire` 的页布局是否应当基于 `fix.line_length`

如果确认 stride 应该跟 fb 的 `fix.line_length` 对齐，那下一步可能要把：
- `psBuffer->ui32ByteStride`
- `ui32ByteSize`
- `uiStartAddr += bufferID * ui32ByteSize`

统一切到 fb 实际 stride 上。

---

如果你愿意，我下一步可以直接：
1. 先把这个 `&& -> ||` 修掉；
2. 然后继续追 `DC_BUFFER_CREATE_INFO.ui32BPP` 的定义和同类实现，对 stride 问题给出能下结论的版本。

---

**User**

不用管错误，直接按照之前我给你发的问题完整分析就行了

---

**Cursor**

明白，那我不纠结修错，直接把这条链按“你之前给的那个问题”做一次完整分析。  
我这里把重点放在 `dc_sunxi.c` 这几个接口的真实作用、调用关系、内存模型、和它跟下层显示驱动的关系上。

---

# 一、先说结论

`dc_sunxi.c` 本质上不是一个真正的 DRM/KMS 显示驱动，它只是 **PVR Rogue Services 的一个 DC 适配层**，把 GPU 侧的显示接口“嫁接”到 Linux 的 `fbdev` 上。

也就是说，它的工作模式是：

1. PVR Services 向这个 DC 驱动申请显示设备
2. 申请显示 buffer
3. 这个驱动并不自己分配真正的新显示内存，而是把 **fbdev 的显存区域** 切片后“伪装成”多个 buffer
4. 最后通过 `fb_pan_display()` 改 `yoffset` 实现翻页

所以它的核心假设不是“多块独立 framebuffer”，而是：

- 同一块连续 framebuffer 显存
- 按固定 stride 和固定高度切成第 0 帧、第 1 帧……
- 翻页只改 `yoffset`

这点非常关键。  
只要这个假设和底下实际 fbdev/drmfb 的内存布局不一致，整个链路就会出问题。

---

# 二、这几个函数在整条链里的角色

你提到的几个点，基本正好就是整条显示提交链。

---

## 1. `DC_SUNXI_Init`：设备探测与能力建立

这个函数做了几件事：

### ① 拿第一个 fbdev 设备
它直接取：

- `registered_fb[0]`

这意味着它默认系统里 **第一个注册的 fbdev** 就是它要接管的显示设备。

这个假设很强，问题也很明显：

- 如果系统里有多个 framebuffer
- 或者第 0 个不是实际目标显示设备
- 或者 DRM fb emulation 和真实硬件 fb 的顺序不一致

那它可能接错对象。

### ② 检查 fbdev 是否“像一个能被 PVR 利用的扫描输出面”
它要求：

- `smem_len` 非 0
- `line_length` 非 0
- packed pixels
- truecolor
- pixel format 只能认固定几种

也就是说，它只接受非常传统的线性 framebuffer。

### ③ 判断能不能 flip
`DC_SUNXI_FlipPossible()` 的逻辑不是检查“硬件 page flip 能力”，而是检查：

- fbdev 是否支持 pan/ywrap
- 一帧大小是否页对齐
- `yres_virtual` 是否足够容纳多帧
- `smem_len` 是否真的有足够显存

如果满足，它就认为可以双缓冲/多缓冲翻页。

### ④ 向 PVR Services 注册一组回调
注册的就是：

- query info
- create/destroy context
- alloc/acquire/free buffer
- configure display

这说明 `dc_sunxi.c` 只是 Services DC 的 callback provider。

---

## 2. `DC_SUNXI_BufferAlloc`：不是“分配显存”，而是“声明一个 buffer 视图”

这个函数名字叫 `BufferAlloc`，但实际上它几乎没做真正的显存分配。

它做的是：

- 分配一个 `DC_SUNXI_BUFFER` 结构体
- 记录 width / height / stride / bufferID
- 根据 bufferID 表示“这是第几帧槽位”
- 把 page count / stride / heap id 返回给上层

也就是说：

### 它只是分配“元数据对象”
真正的底层显存，来自 `fb_info->fix.smem_start/smem_len`。

### 它的 bufferID 才是关键
`DC_SUNXI_GetBufferID()` 用 bitmask 从 `0 ~ NUM_PREFERRED_BUFFERS-1` 里找一个空槽。

所以这里的 buffer 本质是：

- buffer 0 = framebuffer 第 0 段
- buffer 1 = framebuffer 第 1 段
- …

不是独立内存块。

---

## 3. `DC_SUNXI_BufferAcquire`：把这个“槽位”映射成物理页数组

这个函数是整条链最核心的内存解释逻辑。

它会：

1. 取 framebuffer 起始地址  
   - `screen_base` 或 `fix.smem_start`
2. 计算当前 buffer 的起始地址  
   - `start = fb_base + bufferID * ui32ByteSize`
3. 再把这一段地址切成按页排列的 `pasDevPAddr[]`
4. 返回给 Services 作为这个 buffer 的物理页列表

换句话说，PVR 上层看到的是：

- “我拿到一个显示 buffer，它有自己的物理页数组”

但实际上这里并没有真的独立 buffer，  
只是从同一块 fb 显存中按偏移量切出来的一段。

---

## 4. `DC_SUNXI_ContextConfigureCheck`：配置前约束检查

这个函数定义了它支持的显示模型：

### ① 只支持 1 pipe
多 pipe 直接拒绝。

### ② 只支持全屏 crop
要求 crop：

- 宽 = `xres`
- 高 = `yres`
- offset = 0

说明它不支持局部显示，不支持 source crop。

### ③ display rect 必须和 crop 完全一致
也就是说：

- 不支持缩放
- 不支持 reposition
- 不支持 overlay 式输出

### ④ buffer dim 必须匹配屏幕
这代表这个 DC 只接受“和当前 mode 一样大的 framebuffer”。

所以它不是一个通用 display controller，只是一个“全屏主平面”。

---

## 5. `DC_SUNXI_ContextConfigure`：真正执行翻页

这个函数最后干的事很简单：

- 默认 `yoffset = 0`
- 如果有 buffer，并且 `bCanFlip`
- 那么 `yoffset = yres * bufferID`
- 再调用：
  - `fb_pan_display()`，或者
  - 特殊情况下 `fb_set_var()`

所以它不是通过切换 address register 完成 flip，  
而是走 fbdev 的 pan 机制，让底层显示设备扫描到不同的垂直偏移位置。

### 这说明整个模型是：
- framebuffer 是一张“高得多”的大图
- 第 0 帧在 `0 ~ yres-1`
- 第 1 帧在 `yres ~ 2*yres-1`
- 通过 `yoffset` 选择显示哪一块

---

# 三、这条链跟下层 sunxi DRM/eDP 的真实关系

你现在打开的是 `sunxi_drm_edp.c`，但从当前这条链看：

## `dc_sunxi.c` 并不会直接调用 `sunxi_drm_edp.c`
它调用的是 fbdev 接口：

- `fb_set_var`
- `fb_pan_display`

因此中间还有一层：

### 实际链路更像这样
`PVR Services`
→ `dc_sunxi`
→ `fbdev`
→ fbdev 的实现者（可能是 sunxi DRM fb emulation，也可能是别的 framebuffer 驱动）
→ DRM CRTC/plane/encoder
→ eDP 硬件

所以：

- `dc_sunxi.c` 是 **上游 GPU 显示适配层**
- `sunxi_drm_edp.c` 是 **更下游的输出路径之一**
- 两者不是直接函数调用关系，而是通过 fbdev 间接串起来

这也是为什么你如果在查问题，不能只看 `sunxi_drm_edp.c`，  
因为很多问题在到 eDP 之前，可能已经在 `dc_sunxi` 的 buffer 布局阶段就歪了。

---

# 四、这个实现依赖的几个核心假设

这是理解问题的重点。`dc_sunxi.c` 能正常工作，依赖以下假设同时成立。

---

## 假设 1：fbdev 显存是连续且可按帧均匀切片的
也就是：

- framebuffer base 固定
- 每帧大小固定
- 第 N 帧地址 = base + N * frame_size

如果底层不是这种布局，比如：

- 有对齐 padding
- stride 与 width*bpp 不一致
- 显存不是它以为的线性连续块

那么 `BufferAcquire()` 返回的页列表就和实际扫描布局对不上。

---

## 假设 2：显示翻页用 `yoffset = yres * bufferID` 就足够
这要求：

- 每帧在垂直方向整齐堆叠
- `xoffset` 不参与
- 不存在 tiled/compressed layout
- 不存在 per-plane 独立地址

这是一种非常老式、非常 fbdev 的模型。

---

## 假设 3：PVR 的 buffer stride 与 fb 的实际 stride 一致
但代码里这里其实有潜在冲突：

- `FlipPossible()` 用的是 `fix.line_length`
- `BufferAlloc()` 用的是 `width * ui32BPP`

这两边不一定相等。

如果实际 `line_length > width * bytes_per_pixel`，  
就意味着每行有 padding。

这种情况下：

- PVR 认为一帧大小 = `width * bpp * height`
- fbdev 实际一帧跨度 = `line_length * height`

那么 buffer 1 的起始地址就会算错。

这个问题是这份代码里最值得怀疑的结构性风险之一。

---

## 假设 4：翻页提交和 retire 时序足够粗糙也不会出问题
`ContextConfigure()` 里在 pan/set_var 后，会把上一个 config retire。

这说明它的 retire 语义不是“真正等到 vblank scanout 完成后再 retire”，  
而更像“我已经把请求提交到底层了，可以认为前一个配置结束”。

对于简单 fbdev 也许能跑，  
但从严格时序看，它没有显式 fence / vblank completion 机制。

这意味着：

- 上层如果期望精准显示完成时序，可能不满足
- 在某些平台上可能会存在 tearing / retire 时机偏早

---

# 五、逐项分析你提到的几个函数

---

## `DC_SUNXI_Init`
### 功能定位
- 建立 PVR 显示设备
- 绑定 fbdev
- 判断格式
- 判断 flip 能力

### 关键特点
- 强依赖 `registered_fb[0]`
- 只支持固定 truecolor linear framebuffer
- 通过 `DCRegisterDevice()` 暴露给 Services

### 风险点
- 绑定错 fb
- fbdev 能工作，但其实并不适合 page-flip 式使用
- DRM fb emulation 行为不完全符合老 fbdev 预期

---

## `DC_SUNXI_BufferAlloc`
### 功能定位
- 为 PVR 创建一个逻辑 buffer handle
- 计算 stride / page count / heap id

### 实际语义
不是 alloc 真内存，而是：
- 给已有 fb memory 划一个逻辑槽位

### 风险点
- stride 按 `width * ui32BPP` 算
- 如果与 `fix.line_length` 不一致，就埋雷

---

## `DC_SUNXI_BufferAcquire`
### 功能定位
- 把 buffer handle 转成设备物理页数组

### 实际语义
- 从 framebuffer base 起按偏移取一段内存
- 交给 GPU/DC 上层作为可显示 buffer

### 风险点
- 以 `ui32ByteSize` 为帧跨度
- 如果实际扫描帧跨度不是这个值，会错位

这是内存解释问题的核心点。

---

## `DC_SUNXI_FlipPossible`
### 功能定位
- 判断能不能依靠 fbdev 的 pan 机制实现多 buffer flip

### 它校验的其实是
- fb 能否 pan
- 帧大小是否页对齐
- 虚拟高度是否足够
- 显存长度是否足够

### 风险点
它的校验口径和 `BufferAlloc/Acquire` 的内存口径不完全一致。  
这个不一致本身就说明实现存在“理论模型不统一”的问题。

---

## `DC_SUNXI_ContextConfigure`
### 功能定位
- 根据当前 bufferID 选择要显示哪一帧
- 通过 `fb_pan_display()` 切换可见窗口

### 优点
- 简单直接
- 对老 fbdev 平台比较容易 work

### 局限
- 不支持复杂 plane/scale/crop
- 不支持异步精确完成时序
- 全依赖 fbdev 对 pan 的实现质量

---

# 六、从“上游接口调用”角度看整条时序

如果从 PVR Services 往下看，时序大概是：

1. `DC_SUNXI_init()` 注册显示设备
2. 上层 query panel / format / dim
3. 上层 create display context
4. 上层 `BufferAlloc()` 申请若干显示 buffer
5. 上层 `BufferAcquire()` 得到物理页
6. GPU 渲染到这些页对应的内存
7. 上层调用 `ContextConfigureCheck()`
8. 上层调用 `ContextConfigure()`
9. 驱动设置 `yoffset`
10. fbdev 再把这个 pan 请求下发到底层显示路径

这条链的特点是：

### 它把“显示 buffer”与“scanout memory”混成了一回事
在现代 DRM 里，通常是：
- GEM/BO
- framebuffer object
- plane state
- atomic commit

而这里是：
- 直接拿 fbdev 的 scanout memory 给 GPU 用
- 通过 pan 显示不同内存段

所以它比现代 DRM 路径粗糙得多，也更依赖底层实现细节。

---

# 七、如果回到你原来问题本身，这份代码最值得关注的点有哪些

如果你是让我“完整分析问题”，那我认为最该盯的不是单个语法错误，而是下面这几类问题。

---

## 1. 尺寸检查逻辑不严
`ContextConfigureCheck()` 里 buffer 尺寸判断写得偏松，  
会导致某些不完全匹配的 buffer 漏过去。

这是逻辑层面的明显瑕疵。

---

## 2. stride / frame size 口径不统一
这是最重要的结构性问题。

代码里同时存在两套 frame size 定义：

### 定义 A：按 `width * ui32BPP * height`
用于：
- `BufferAlloc`
- `BufferAcquire`

### 定义 B：按 `fix.line_length * yres`
用于：
- `FlipPossible`

这两套如果不等价，就说明：

- buffer 地址计算
- page count
- frame 间距
- flip 位置

可能不是在描述同一块真实内存布局。

这个比单点 bug 更像你问题的根。

---

## 3. 这个 DC 只适用于“老式 fbdev 线性翻页模型”
一旦底层实际上是：

- DRM fb emulation
- stride 有额外对齐
- buffer 生命周期不完全受 fbdev 约束
- pan 只是兼容接口而不是主通路

那它工作虽可能“看起来能跑”，但边界场景会出问题。

---

## 4. 它没有现代显示同步语义
没有真正的 atomic state
没有显式 fence
没有严格 vblank-complete retire

这意味着它更像“尽量兼容跑起来”，  
而不是严格正确的现代显示栈实现。

---

# 八、和 `sunxi_drm_edp.c` 的关系该怎么理解

你现在聚焦的 `sunxi_drm_edp.c`，如果从整条链上看，更多是：

- 负责下游 eDP 输出控制
- link training / audio / panel / irq / HPD / mode 等

而 `dc_sunxi.c` 是更上面一层：

- 把 GPU 渲染结果交给“显示设备”
- 这个显示设备恰好通过 fbdev 间接通向 sunxi DRM/eDP

所以如果现象是：

- 花屏
- buffer 错位
- 翻页异常
- 只有某些分辨率正常
- 开双缓冲才异常

那第一嫌疑其实应该先回到 `dc_sunxi.c` 的 frame layout 假设，  
而不是先怀疑 eDP 链路本身。

因为 eDP 那边可能只是“忠实地显示了上面传下来的错误内存”。

---

# 九、最终归纳

如果把这份代码一句话概括：

> `dc_sunxi.c` 是一个把 PVR Services 显示接口桥接到 Linux fbdev 的简化适配层，它通过把同一块 framebuffer 内存按固定帧大小切片，并借助 `fb_pan_display()` 改 `yoffset` 实现显示 buffer 切换。

它的实现成立依赖于几个前提：

- fbdev 是线性连续显存
- 每帧布局固定
- stride 与它的计算一致
- pan/ywrap 可用
- `yres_virtual` 足够
- 下层 fbdev 能正确把 pan 落到真实显示硬件

而你前面盯的这些函数，正好对应这条链上的四个关键节点：

- `Init`：建立设备与能力
- `BufferAlloc`：定义 buffer 逻辑形态
- `BufferAcquire`：把逻辑 buffer 映射成物理内存页
- `ContextConfigure`：把某个 buffer 真正切到屏幕上

其中最值得警惕的不是“它会不会调用到 eDP 某个函数”，而是：

1. **它对 framebuffer 内存布局的理解是否和底层一致**
2. **它对 stride/frame size 的定义是否自洽**
3. **它把 fbdev 当成 page-flip backend 这件事，在当前 sunxi DRM 环境里是否仍然成立**

---

如果你愿意，我下一步可以继续按“完整分析”往下做两种方向之一：

1. **继续纯分析版**：把 `DC_BUFFER_CREATE_INFO`、`ui32BPP`、PVR Services 上游调用语义也串起来，完整回答“上游怎么调用到这里、这里再怎么落到 fbdev”；  
2. **下钻版**：专门围绕 `sunxi_drm_edp.c` 看它对应的 fbdev/drm 路径，分析 `fb_pan_display()` 最终是不是会走到这条 eDP 输出链。

---

**User**

我想让你对比一下
1、为什么PVR的GPU走的是标准DRM框架注册的，却可以外部定义一些函数使用GPU能力，结合具体源码分析
2、它这种方式跟标准DRM/KMS显示的区别

---

**Cursor**

可以，这两个问题其实正好对应 PVR 里两套“并存但不相同”的架构：

- 一套是 **GPU 作为 DRM 设备** 对外注册
- 另一套是 **显示路径并不一定走标准 DRM/KMS 原子显示栈**，而是走 PVR 自己的 Services Display Class/DC 抽象，再桥接到 fbdev 或者别的后端

所以你看到“PVR 明明按标准 DRM 注册了，为什么外面还能自定义一些函数来使用 GPU 能力”，本质原因是：

> **DRM 在这里主要承担的是设备节点、mmap、ioctl 分发、render node 入口；而真正的 GPU 业务能力和显示能力，并不是完全由 DRM/KMS 框架本身定义的，而是由 PVR 自己的 Services 层再往外暴露/回调。**

下面我结合你这个代码树里的具体源码，分两部分讲。

---

# 1. 为什么 PVR 的 GPU 走的是标准 DRM 注册，却还能外部定义函数来使用 GPU 能力？

---

## 1.1 先看：它确实是按标准 DRM 设备注册思路在做

`pvr_drm.c` 里很清楚，PVR 把自己包装成了一个标准 `drm_driver`。

例如：

```255:298:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/kernel/drivers/staging/imgtec/pvr_drm.c
static const struct file_operations pvr_drm_fops = {
	.owner			= THIS_MODULE,
	.open			= drm_open,
	.release		= drm_release,
	.unlocked_ioctl		= drm_ioctl,
#if defined(CONFIG_COMPAT)
	.compat_ioctl		= pvr_compat_ioctl,
#endif
	.mmap			= PVRSRV_MMap,
	.poll			= drm_poll,
	.read			= drm_read,
#if (LINUX_VERSION_CODE < KERNEL_VERSION(3, 12, 0))
	.fasync			= drm_fasync,
#endif
};

const struct drm_driver pvr_drm_generic_driver = {
	.driver_features	= DRIVER_MODESET | DRIVER_RENDER,
	.open			= pvr_drm_open,
	.postclose		= pvr_drm_release,
	.ioctls			= pvr_drm_ioctls,
	.num_ioctls		= ARRAY_SIZE(pvr_drm_ioctls),
	.fops			= &pvr_drm_fops,
	.name			= PVR_DRM_DRIVER_NAME,
	.desc			= PVR_DRM_DRIVER_DESC,
	.date			= PVR_DRM_DRIVER_DATE,
	.major			= PVRVERSION_MAJ,
	.minor			= PVRVERSION_MIN,
	.patchlevel		= PVRVERSION_BUILD,
};
```

这说明：

- 它有标准 DRM `file_operations`
- 用户态通过 `/dev/dri/cardX` 或 `renderDxxx` 打开
- `ioctl` 走 DRM 分发
- `mmap` 也挂在 DRM 节点下

也就是说，**入口层** 是标准 DRM 的。

---

## 1.2 但 DRM 在这里更像“壳”，核心能力在 PVR Services

看 `pvr_drm_load()`：

```94:138:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/kernel/drivers/staging/imgtec/pvr_drm.c
int pvr_drm_load(struct drm_device *ddev, unsigned long flags)
{
	struct pvr_drm_private *priv;
	enum PVRSRV_ERROR srv_err;
	int err, deviceId;

	dev_set_drvdata(ddev->dev, ddev);
...
	if (ddev->render)
		deviceId = ddev->render->index;
	else
		deviceId = ddev->primary->index;
...
	srv_err = PVRSRVDeviceCreate(ddev->dev, deviceId, &priv->dev_node);
...
	err = PVRSRVCommonDeviceInit(priv->dev_node);
...
	drm_mode_config_init(ddev);

	return 0;
}
```

这里关键不在 `drm_mode_config_init()`，而在：

- `PVRSRVDeviceCreate()`
- `PVRSRVCommonDeviceInit()`

说明真正的设备能力初始化是在 **PVRSRV/Services 内核层** 里完成的。  
DRM 只是：

- 给它一个 Linux/DRM 世界可见的设备节点
- 给用户态一个标准 open/ioctl/mmap 通道
- 把请求转进 PVR 自己的 server/common/services

所以你可以把它理解为：

### DRM 提供“门面”
- 设备节点
- `drm_open`
- `drm_ioctl`
- `drm mmap`

### PVR Services 提供“内核能力本体”
- 设备创建
- 内存管理
- job 提交
- 同步
- 显示类/DC
- bridge dispatch

---

## 1.3 用户态到内核态的核心业务，并不是标准 KMS ioctl，而是 PVR 自己的 bridge ioctl

看这个 ioctl 表：

```226:228:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/kernel/drivers/staging/imgtec/pvr_drm.c
static struct drm_ioctl_desc pvr_drm_ioctls[] = {
	DRM_IOCTL_DEF_DRV(PVR_SRVKM_CMD, PVRSRV_BridgeDispatchKM, DRM_RENDER_ALLOW | DRM_UNLOCKED)
};
```

这行非常关键。

它说明：

- 虽然走的是 DRM ioctl 框架
- 但真正的命令分发函数是 `PVRSRV_BridgeDispatchKM`

也就是说，用户态不是主要在调“标准 DRM/KMS 的那套 ioctls”，  
而是在借用 DRM 设备节点后，进入 **PVR 自己定义的 Bridge 命令系统**。

所以“为什么外部还能定义一些函数使用 GPU 能力”？

答案就是：

### 因为 GPU 能力不是靠 DRM core 固定 API 暴露出来的
而是靠 PVR 自己的 Services/Bridge 层暴露的：

- 用户态通过 DRM 节点进来
- 内核态通过 `PVRSRV_BridgeDispatchKM` 转发到 PVR Services
- PVR Services 再调用它自己的设备管理、内存、同步、渲染、显示接口

所以标准 DRM 只是 transport/入口，不是能力定义者。

---

## 1.4 “外部定义函数”本质上是 PVR 内部留出的可插拔接口

你说的“外部定义一些函数使用 GPU 能力”，在这套代码里主要有两种表现。

---

### 表现 A：通过头文件声明的 Services API，外部模块可以接入
比如 `services_kernel_client.h` 里就声明了大量 PVR 服务接口：

```166:174:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/kernel/drivers/staging/imgtec/services_kernel_client.h
enum PVRSRV_ERROR PVRSRVDeviceCreate(void *pvOSDevice,
	int i32UMIdentifier,
	struct _PVRSRV_DEVICE_NODE_ **ppsDeviceNode);
enum PVRSRV_ERROR PVRSRVDeviceDestroy(
	struct _PVRSRV_DEVICE_NODE_ *psDeviceNode);
const char *PVRSRVGetErrorString(enum PVRSRV_ERROR eError);
```

这意味着：

- 只要别的内核模块包含这些头、链接到对应符号
- 就可以调用 PVR Services 的能力入口

也就是说，PVR 自己除了 DRM 入口，还保留了 **内核内部 API 层**。

---

### 表现 B：显示后端通过函数表注册进 PVR，而不是反过来受 DRM/KMS 约束
这在 `dc_sunxi.c` 里最典型。

看它初始化时注册的函数表：

```623:638:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/services/3rdparty/dc_sunxi/dc_sunxi.c
	static DC_DEVICE_FUNCTIONS sDCFunctions =
	{
		.pfnGetInfo					= DC_SUNXI_GetInfo,
		.pfnPanelQueryCount			= DC_SUNXI_PanelQueryCount,
		.pfnPanelQuery				= DC_SUNXI_PanelQuery,
		.pfnFormatQuery				= DC_SUNXI_FormatQuery,
		.pfnDimQuery				= DC_SUNXI_DimQuery,
		.pfnSetBlank				= NULL,
		.pfnSetVSyncReporting		= NULL,
		.pfnLastVSyncQuery			= NULL,
		.pfnContextCreate			= DC_SUNXI_ContextCreate,
		.pfnContextDestroy			= DC_SUNXI_ContextDestroy,
		.pfnContextConfigure		= DC_SUNXI_ContextConfigure,
		.pfnContextConfigureCheck	= DC_SUNXI_ContextConfigureCheck,
		.pfnBufferAlloc				= DC_SUNXI_BufferAlloc,
		.pfnBufferAcquire			= DC_SUNXI_BufferAcquire,
```

这套 `DC_DEVICE_FUNCTIONS` 不是 DRM/KMS 的对象模型，  
而是 **PVR 自己定义的显示抽象接口**。

也就是说：

- DRM 设备节点是标准注册的
- 但显示/缓冲区/翻页能力，是通过 PVR 自己的 callback table 组织的
- 外部模块只要按它要求实现这套函数表，就能给 PVR 提供显示能力

这就是你看到“为什么外部还能定义一些函数”的根源：  
**因为 PVR 在 DRM 之上又搭了一层自己的抽象。**

---

## 1.5 所以这不是“违反标准 DRM”，而是“只把 DRM 当入口”
总结成一句话：

> PVR 并不是把所有 GPU/显示能力都委托给 DRM core，而是把 DRM 用作设备节点与 ioctl/mmap 容器；真正的 GPU 服务和显示后端接入，是通过它自己的 PVRSRV Services + Bridge + DC function table 完成的。

所以它既可以：

- 对 Linux 看起来是标准 DRM 设备
- 又可以在内部/外部模块里定义自己的函数接口、回调表和能力模型

这两者并不冲突。

---

# 2. 它这种方式跟标准 DRM/KMS 显示的区别

这个问题最关键。

简单讲：

> **标准 DRM/KMS 是“显示子系统主导”**  
> **PVR 这套是“GPU Services 主导，显示只是一个被接入的后端”**

下面分层对比。

---

## 2.1 标准 DRM/KMS 的对象模型：plane / crtc / encoder / connector / fb

在你树里的 `drm_pdp_modeset.c`，就能看到比较标准的 KMS 写法。

比如：

```221:273:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/kernel/drivers/staging/imgtec/tc/drm_pdp_modeset.c
int pdp_modeset_early_init(struct pdp_drm_private *dev_priv)
{
	struct drm_device *dev = dev_priv->dev;
	int err;

	drm_mode_config_init(dev);

	dev->mode_config.funcs = &pdp_mode_config_funcs;
...
	dev_priv->plane = pdp_plane_create(dev, DRM_PLANE_TYPE_PRIMARY);
...
	dev_priv->crtc = pdp_crtc_create(dev, 0, dev_priv->plane);
...
	dev_priv->connector = pdp_dvi_connector_create(dev);
...
	dev_priv->encoder = pdp_tmds_encoder_create(dev);
...
	err = drm_connector_attach_encoder(dev_priv->connector,
					   dev_priv->encoder);
...
	return 0;
}
```

这就是典型 DRM/KMS：

- `drm_mode_config_init`
- primary plane
- crtc
- connector
- encoder
- attach encoder

它的显示世界是由 DRM core 对象模型定义的。

如果开 atomic，还会有：

```221:226:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/kernel/drivers/staging/imgtec/tc/drm_pdp_modeset.c
static const struct drm_mode_config_funcs pdp_mode_config_funcs = {
	.fb_create = pdp_fb_create,
	.output_poll_changed = NULL,
#if defined(PDP_USE_ATOMIC)
	.atomic_check = drm_atomic_helper_check,
	.atomic_commit = drm_atomic_helper_commit,
#endif
};
```

也就是：

- `fb_create`
- `atomic_check`
- `atomic_commit`

这就是标准 KMS/Atomic Display 的范式。

---

## 2.2 PVR 的 `dc_sunxi` 并不是这种对象模型

`dc_sunxi.c` 里根本没有：

- plane
- crtc
- encoder
- connector
- atomic state
- drm framebuffer object

它暴露给 PVR Services 的模型是：

- panel query
- format query
- dim query
- context create/destroy
- buffer alloc/acquire/free
- context configure

也就是：

### 标准 DRM/KMS 问的是：
- 这台显示控制器有哪些 plane？
- 哪些 crtc？
- 哪个 connector 接哪个 encoder？
- framebuffer object 是哪个 GEM/BO？
- 本次 atomic state 合法吗？
- commit 什么时候生效？

### PVR DC 问的是：
- 这个显示面板多大？
- 支持什么格式？
- 给我一个 buffer
- 给我 buffer 对应物理页
- 把这个 buffer 显示出来

两者抽象层级不一样。

---

## 2.3 标准 DRM/KMS 的显示提交是“状态机提交”
标准 DRM/KMS 尤其 atomic 模式，核心是：

- 创建 framebuffer
- 绑定 plane state
- 指定 crtc/connector state
- 做 atomic_check
- atomic_commit
- vblank/fence/flip complete

而 `dc_sunxi` 这种方式，显示提交基本就是：

- 申请一个 buffer handle
- 取得对应页地址
- `ContextConfigure()`
- 里面直接 `fb_pan_display()` 或 `fb_set_var()`

它不维护完整显示状态树，不做通用 atomic state 校验。  
它更像是：

> “我已经有一块 scanout memory 了，你帮我切到第 N 帧去显示”

所以它是 **buffer 切换模型**，不是 **KMS state commit 模型**。

---

## 2.4 标准 DRM/KMS 里 framebuffer 通常是 GEM/BO 对象
看 `drm_pdp_modeset.c` 里 framebuffer 创建：

```91:129:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/kernel/drivers/staging/imgtec/tc/drm_pdp_modeset.c
pdp_framebuffer_create(struct drm_device *dev,
		       struct drm_file *file,
		       struct drm_mode_fb_cmd2 *mode_cmd)
{
	struct drm_gem_object *obj;
...
	obj = drm_gem_object_lookup(file, mode_cmd->handles[0]);
...
	drm_helper_mode_fill_fb_struct(dev_priv->dev, &pdp_fb->base, mode_cmd);
...
	err = drm_framebuffer_init(dev_priv->dev, &pdp_fb->base,
				   &pdp_framebuffer_funcs);
```

这说明标准 KMS 的 framebuffer 是：

- 基于 GEM object
- 有 framebuffer 对象
- 由 DRM core 跟踪生命周期

而 `dc_sunxi` 并不是这样。

它的 `BufferAlloc()` 并不真正创建 GEM/FB object，而是拿 `fbdev` 已有显存做切片。  
`BufferAcquire()` 直接从 `fb_info->fix.smem_start` 推出页地址。

这说明它不是标准 DRM framebuffer 管理方式，而是：

> 直接复用底层 framebuffer 内存作为 scanout buffer。

---

## 2.5 标准 DRM/KMS 显示后端直接驱动硬件；`dc_sunxi` 是“套娃”到 fbdev 上
标准 DRM/KMS 路径通常是：

- userspace atomic commit
- drm core
- driver plane/crtc callbacks
- 寄存器编程
- encoder/connector/hpd/vblank

而 `dc_sunxi` 是：

- PVR Services
- DC callback
- `fb_pan_display()` / `fb_set_var()`
- fbdev 实现者
- 再由 fbdev 背后的驱动去改硬件

也就是说，`dc_sunxi` 不是直接控制显示硬件，  
而是**把显示工作再委托给 fbdev**。

从源码也能看到它强依赖 fbdev：

```1:18:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/services/3rdparty/dc_sunxi/dc_sunxi.c
#include <linux/console.h>
#include <linux/module.h>
#include <linux/fb.h>

#include "kerneldisplay.h"
...
#if !defined(CONFIG_FB)
#error dc_sunxi needs Linux framebuffer support. Enable it in your kernel.
#endif
```

以及初始化直接抓：

```645:651:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/services/3rdparty/dc_sunxi/dc_sunxi.c
	psLINFBInfo = registered_fb[0];
	if(!psLINFBInfo)
	{
		pr_err("No Linux framebuffer (fbdev) device is registered!\n"
...
```

这跟标准 DRM/KMS “自己就是显示框架主体”是完全不同的。

---

## 2.6 标准 DRM/KMS 更通用；`dc_sunxi` 只支持一个非常窄的显示模型
`dc_sunxi` 的限制很多：

- 只支持 1 pipe
- crop 必须全屏
- display rect 必须等于 crop
- buffer 维度必须匹配当前屏幕
- flip 本质靠 `yoffset`
- 显示内存必须是连续 framebuffer 且适合垂直平铺

也就是说它只支持：

> 一个全屏主平面 + 固定分辨率 + 线性 framebuffer + fbdev pan flip

而标准 DRM/KMS 可以天然表达：

- 多 plane
- overlay
- cursor plane
- scaling
- rotation
- modifier
- multi-connector
- bridge/panel chain
- atomic state

所以两者的能力范围不是一个等级。

---

## 2.7 同步语义也不同
标准 DRM/KMS 尤其 atomic 路径，会更强调：

- vblank
- page flip event
- fence
- commit completion
- state rollback/check

而 `dc_sunxi` 这边的 retire 语义比较粗：

- 配完就 retire 上一次 config
- 主要靠 fbdev 能否 pan 成功
- 没有完整 atomic/vblank completion 体系

这意味着它更像“尽量跑通”的兼容路径，  
而不是现代 DRM/KMS 那种严格显示时序模型。

---

# 3. 把两个问题合在一起，真正的架构关系是什么？

可以把你这套代码理解成三层：

---

## 第一层：Linux 标准 DRM 外壳
这层由 `pvr_drm.c` 提供：

- `drm_driver`
- `open/release/ioctl/mmap`
- render node / primary node
- 标准 `/dev/dri/*` 入口

用途：**把 PVR GPU 暴露给 Linux 用户态和内核框架**

---

## 第二层：PVR 自己的 Services 核心
这层由 `PVRSRVDeviceCreate`、`PVRSRVCommonDeviceInit`、`PVRSRV_BridgeDispatchKM` 等组成：

- 真正的 GPU 服务逻辑
- 内存/同步/渲染/bridge
- display class 抽象

用途：**定义真正的 GPU 能力模型**

---

## 第三层：显示后端适配
这层可以是：

- 标准 DRM/KMS 风格后端，比如 `drm_pdp_*`
- 也可以是 `dc_sunxi` 这种 PVR DC + fbdev 桥接

用途：**把 PVR 产出的显示 buffer，落到具体平台的显示设备上**

---

所以它和标准 DRM/KMS 的最大区别是：

> 标准 DRM/KMS：显示框架是主轴，GPU/显示对象都服从 DRM/KMS 模型  
> PVR 这套：PVR Services 是主轴，DRM 只是入口，而显示可以接成标准 KMS，也可以接成私有 DC/fbdev 后端

---

# 4. 最后给你一个最直观的对比表

## PVR 这种方式
- DRM 用来注册设备节点
- 真正业务 ioctl 走 `PVRSRV_BridgeDispatchKM`
- GPU 能力由 PVR Services 自己定义
- 显示后端通过 `DC_DEVICE_FUNCTIONS` 之类回调接入
- 可以桥接到 fbdev，不必完整实现 DRM/KMS 对象模型

## 标准 DRM/KMS 方式
- DRM 不只是入口，而是显示抽象本身
- 显示能力通过 plane/crtc/encoder/connector/fb 暴露
- 提交通过 atomic_check/atomic_commit
- framebuffer 基于 GEM/BO 生命周期管理
- 驱动直接作为 KMS provider 管控显示硬件

---

# 5. 一句话回答你的两个问题

## 问题 1
**为什么 PVR 走标准 DRM 注册，却还能外部定义函数用 GPU 能力？**

因为它只是“借用 DRM 作为设备入口”，真正的 GPU 能力和显示能力是由 PVR 自己的 Services/Bridge/DC 抽象定义的；外部模块实现或调用这些 PVR 定义的接口即可，不需要完全受 DRM/KMS 约束。

## 问题 2
**它这种方式跟标准 DRM/KMS 显示的区别？**

标准 DRM/KMS 是以 DRM 显示对象模型和 atomic state 为核心；PVR 这套则是以 PVR Services 为核心，显示只是一个可插拔后端，甚至可以像 `dc_sunxi` 一样通过 fbdev 的 `fb_pan_display()` 实现“伪 KMS”式显示切换，而不是真正的 DRM/KMS 原子显示路径。

---

如果你愿意，我下一步可以继续帮你做一版更“贴你当前 sunxi 平台”的对比：

1. **PVR render DRM 节点 → PVRSRV_BridgeDispatchKM → Services** 的完整调用链图  
2. **`dc_sunxi` → fbdev → sunxi DRM/eDP** 的下行链路图

这样你就能把“GPU 标准注册”和“显示非标准接法”在同一张图上看清楚。

---

**User**

那如果我启用sunxi_drm这个标准DRM/KMS实现途径，而不用DISP2(fbdev)的话，@bsp/drivers/drm ，PVR的GPU用的还是PVR Services吗？如果不是，那它怎么通过DRM/KMS实现的？结合源码具体分析一下

---

**Cursor**

会，而且从你这份源码看，**即使你启用 `sunxi_drm` 这套标准 DRM/KMS 路径、不再走 DISP2/fbdev，PVR 的 GPU 渲染侧仍然还是走 PVR Services**。  
变化的不是“GPU 服务层”，而是“显示提交后端”。

更准确地说：

- **PVR render/compute 提交**：还是 `PVR DRM node + PVR Services + Bridge`
- **显示扫描输出**：
  - 以前 `dc_sunxi`/DISP2(fbdev) 模式：PVR Services 的 Display Class 接到 `fbdev`
  - 现在 `sunxi_drm` 模式：显示由 `sunxi_drm` 自己的 GEM + FB + atomic KMS 接管

所以如果你不用 DISP2(fbdev)，那不是 PVR Services 整体消失了，而是：

> **PVR 的“Display Class 那条老显示桥接路径”不再是主路径；标准显示改由 `sunxi_drm` DRM/KMS 完成。**

下面我结合源码把这个结论拆开。

---

# 1. 先给结论图

---

## 方案 A：走 DISP2 / fbdev / `dc_sunxi`
链路大致是：

`应用/图形栈`
→ `PVR DRM 节点`
→ `PVRSRV_BridgeDispatchKM`
→ `PVR Services`
→ `Display Class (DC)`
→ `dc_sunxi`
→ `fbdev`
→ `DISP2 / 输出硬件`

这里：

- GPU 还是 PVR Services
- 显示也被 PVR Services 的 DC 管起来
- `dc_sunxi` 是一个“把 PVR Display Class 桥接到 fbdev”的后端

---

## 方案 B：走 `sunxi_drm` 标准 DRM/KMS
链路变成：

`应用/Wayland/DRM client`
→ `sunxi_drm` 的 GEM/FB/atomic commit
→ `DE/CRTC/connector/eDP/HDMI`

与此同时：

`OpenGL ES / Vulkan / PVR 用户态`
→ `PVR DRM render 节点`
→ `PVRSRV_BridgeDispatchKM`
→ `PVR Services`
→ GPU 渲染

这里：

- **GPU 渲染侧还是 PVR Services**
- **显示侧改成 sunxi_drm KMS**
- 两边如果要衔接，就需要靠共享 buffer 机制，比如 GEM/dma-buf/PRIME 这类机制；不再是 `dc_sunxi` 那种直接拿 fbdev 的显存切片翻页

---

# 2. 为什么我说“PVR GPU 还是走 PVR Services”？

这个可以直接从 `pvr_drm.c` 看出来。

---

## 2.1 PVR DRM 驱动本身就是 Services 的入口壳
看 `pvr_drm_load()`：

```95:138:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/kernel/drivers/staging/imgtec/pvr_drm.c
int pvr_drm_load(struct drm_device *ddev, unsigned long flags)
{
	struct pvr_drm_private *priv;
	enum PVRSRV_ERROR srv_err;
	int err, deviceId;

	dev_set_drvdata(ddev->dev, ddev);
...
	if (ddev->render)
		deviceId = ddev->render->index;
	else
		deviceId = ddev->primary->index;
...
	srv_err = PVRSRVDeviceCreate(ddev->dev, deviceId, &priv->dev_node);
...
	err = PVRSRVCommonDeviceInit(priv->dev_node);
...
	drm_mode_config_init(ddev);

	return 0;
}
```

这里很清楚：

- DRM 设备加载时会调用 `PVRSRVDeviceCreate`
- 然后 `PVRSRVCommonDeviceInit`

也就是说，**真正的 GPU 设备初始化在 PVR Services 里**，不是在标准 DRM render helper 里单独完成的。

---

## 2.2 PVR 的核心 ioctl 也是进 Services bridge
看它的 ioctl 表：

```226:228:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/kernel/drivers/staging/imgtec/pvr_drm.c
static struct drm_ioctl_desc pvr_drm_ioctls[] = {
	DRM_IOCTL_DEF_DRV(PVR_SRVKM_CMD, PVRSRV_BridgeDispatchKM, DRM_RENDER_ALLOW | DRM_UNLOCKED)
};
```

这意味着：

- 用户态虽然是通过 DRM ioctl 进入
- 但实际命令分发函数是 `PVRSRV_BridgeDispatchKM`

所以 PVR 的 GPU 能力不是用标准 KMS ioctl 在驱动，而是：

> **DRM 只当“设备门口”，真正的命令协议还是 PVR Services 的 bridge 协议。**

---

## 2.3 `services_kernel_client.h` 也证明了 Services 是核心层
头文件里直接声明了设备创建等 Services API：

```166:171:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/kernel/drivers/staging/imgtec/services_kernel_client.h
enum PVRSRV_ERROR PVRSRVDeviceCreate(void *pvOSDevice,
	int i32UMIdentifier,
	struct _PVRSRV_DEVICE_NODE_ **ppsDeviceNode);
enum PVRSRV_ERROR PVRSRVDeviceDestroy(
	struct _PVRSRV_DEVICE_NODE_ *psDeviceNode);
```

这说明 PVR 的内核设备能力组织，是围绕 `PVRSRVDevice*` 这套做的。

所以只要 `img-rgx` 这一套还在用，你切到 `sunxi_drm` 也**不会让 GPU render path 自动变成“纯标准 DRM GPU 驱动”**。  
它仍然是 PVR Services 驱动模型。

---

# 3. 那“不走 DISP2(fbdev)”以后，变掉的到底是哪一部分？

变的是 **显示输出路径**，不是 PVR GPU 核心服务层。

---

## 3.1 `kerneldisplay.h` 已经明说：这套 DC 接口是给“不是原生 DRM/KMS”的显示集成用的
这个注释非常关键：

```58:66:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/services/include/kerneldisplay.h
This interface should be used and implemented if the 3rd party display driver
is not using a native OS interface such as the Linux DRM/KMS API.

...
- Callbacks that need an implementation by the 3rd party display driver and
that are used by the Services server, some of them optional (kerneldisplay.h)
```

这段话的意思几乎就是在直接回答你的问题：

### `kerneldisplay.h` / Display Class 这套
是给 **不走原生 DRM/KMS** 的显示驱动接入用的。

也就是说：

- 如果你是 `fbdev`、私有显示栈、非 DRM/KMS 后端
- 那么可以实现 `DC_DEVICE_FUNCTIONS`
- 让 PVR Services 来管理显示 buffer / flip

反过来说：

### 如果你已经启用标准 `sunxi_drm` DRM/KMS
那理论上就**不应该再依赖这套 DC 显示桥接接口作为主显示路径**。

---

## 3.2 `dc_sunxi` 就是这类“非原生 DRM/KMS”的桥接实现
它注册一组 `DC_DEVICE_FUNCTIONS` 给 Services：

```623:638:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/services/3rdparty/dc_sunxi/dc_sunxi.c
	static DC_DEVICE_FUNCTIONS sDCFunctions =
	{
		.pfnGetInfo					= DC_SUNXI_GetInfo,
		.pfnPanelQueryCount			= DC_SUNXI_PanelQueryCount,
		.pfnPanelQuery				= DC_SUNXI_PanelQuery,
		.pfnFormatQuery				= DC_SUNXI_FormatQuery,
		.pfnDimQuery				= DC_SUNXI_DimQuery,
		.pfnSetBlank				= NULL,
		.pfnSetVSyncReporting		= NULL,
		.pfnLastVSyncQuery			= NULL,
		.pfnContextCreate			= DC_SUNXI_ContextCreate,
		.pfnContextDestroy			= DC_SUNXI_ContextDestroy,
		.pfnContextConfigure		= DC_SUNXI_ContextConfigure,
		.pfnContextConfigureCheck	= DC_SUNXI_ContextConfigureCheck,
		.pfnBufferAlloc				= DC_SUNXI_BufferAlloc,
		.pfnBufferAcquire			= DC_SUNXI_BufferAcquire,
```

而且它完全建立在 fbdev 上：

```1:18:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/services/3rdparty/dc_sunxi/dc_sunxi.c
#include <linux/console.h>
#include <linux/module.h>
#include <linux/fb.h>
...
#if !defined(CONFIG_FB)
#error dc_sunxi needs Linux framebuffer support. Enable it in your kernel.
#endif
```

以及：

```645:651:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/services/3rdparty/dc_sunxi/dc_sunxi.c
	psLINFBInfo = registered_fb[0];
	if(!psLINFBInfo)
	{
		pr_err("No Linux framebuffer (fbdev) device is registered!\n"
```

所以 `dc_sunxi` 这条路径的本质是：

- 让 PVR Services 通过 DC 接口驱动一个 fbdev 显示后端
- 再由 fbdev 去更新显示硬件

这条路径天然就是“非标准 KMS 主路径”。

---

# 4. 如果启用 `sunxi_drm`，标准 DRM/KMS 是怎么实现显示的？

这部分在 `bsp/drivers/drm` 里已经非常明确了。

---

## 4.1 `sunxi_drm` 自己就是一个完整 DRM/KMS 驱动
看 `sunxi_drm_drv.c` 的 `drm_driver`：

```348:362:/home/alientek/A733/qihua-x73x-linux6.6/bsp/drivers/drm/sunxi_drm_drv.c
static struct drm_driver sunxi_drm_driver = {
	.driver_features = DRIVER_MODESET | DRIVER_GEM | DRIVER_ATOMIC,
	.fops = &sunxi_drm_driver_fops,
	.ioctls             = sunxi_drm_ioctls,
	.num_ioctls         = ARRAY_SIZE(sunxi_drm_ioctls),
	.name = DRIVER_NAME,
	.desc = DRIVER_DESC,
	.date = DRIVER_DATE,
	.major = DRIVER_MAJOR,
	.minor = DRIVER_MINOR,
	.gem_create_object = sunxi_gem_create_object,
#if LINUX_VERSION_CODE <= KERNEL_VERSION(6, 1, 0)
	DRM_GEM_CMA_DRIVER_OPS_VMAP,
#else
	DRM_GEM_DMA_DRIVER_OPS_VMAP,
#endif
};
```

这里说明：

- `DRIVER_MODESET`
- `DRIVER_GEM`
- `DRIVER_ATOMIC`

也就是一个**标准 atomic KMS 驱动**。

它不是 fbdev 的壳，也不是靠 PVR 的 DC function table 驱动显示。

---

## 4.2 它的 framebuffer 是标准 GEM framebuffer
看 `sunxi_drm_gem_fb_create()`：

```95:101:/home/alientek/A733/qihua-x73x-linux6.6/bsp/drivers/drm/sunxi_drm_drv.c
struct drm_framebuffer *
sunxi_drm_gem_fb_create(struct drm_device *dev, struct drm_file *file,
			const struct drm_mode_fb_cmd2 *mode_cmd)
{
	return drm_gem_fb_create_with_funcs(dev, file, mode_cmd,
					    &sunxi_drm_gem_fb_funcs);
}
```

这说明 `sunxi_drm` 的 fb 是：

- 通过 `drm_mode_fb_cmd2`
- 基于 GEM object
- 由 DRM framebuffer helper 创建

这就是标准 KMS buffer 模型。

---

## 4.3 它的提交是 atomic commit
看 mode config funcs：

```165:169:/home/alientek/A733/qihua-x73x-linux6.6/bsp/drivers/drm/sunxi_drm_drv.c
static const struct drm_mode_config_funcs sunxi_drm_mode_config_funcs = {
	.atomic_check = drm_atomic_helper_check,
	.atomic_commit = sunxi_drm_atomic_helper_commit,
	.fb_create = sunxi_drm_gem_fb_create,
};
```

以及 commit tail：

```171:188:/home/alientek/A733/qihua-x73x-linux6.6/bsp/drivers/drm/sunxi_drm_drv.c
static void sunxi_drm_atomic_helper_commit_tail(struct drm_atomic_state *old_state)
{
	struct drm_device *dev = old_state->dev;

	drm_atomic_helper_commit_modeset_disables(dev, old_state);
	drm_atomic_helper_commit_modeset_enables(dev, old_state);
	drm_atomic_helper_commit_planes(dev, old_state, 0);
	drm_atomic_helper_fake_vblank(old_state);
	drm_atomic_helper_commit_hw_done(old_state);
	drm_atomic_helper_cleanup_planes(dev, old_state);
}
```

这已经是非常标准的 DRM/KMS 提交流程了：

- atomic check
- modeset disable/enable
- plane commit
- hw done
- cleanup

也就是说，**sunxi_drm 的显示是 DRM atomic KMS 自己完成的，不依赖 PVR Services 的 DC 显示抽象。**

---

## 4.4 它的内存对象也是 DRM GEM / DMA/CMA 模型
`sunxi_drm_gem.c` 里：

```1:18:/home/alientek/A733/qihua-x73x-linux6.6/bsp/drivers/drm/sunxi_drm_gem.c
#include <linux/dma-buf.h>
#include <linux/dma-direction.h>
#include <drm/drm.h>
#include <drm/drm_fb_helper.h>
#include <drm/drm_gem.h>
#include <drm/drm_prime.h>
```

并且对象本身就是：

```24:31:/home/alientek/A733/qihua-x73x-linux6.6/bsp/drivers/drm/sunxi_drm_gem.h
struct sunxi_gem_object {
#if LINUX_VERSION_CODE <= KERNEL_VERSION(6, 1, 0)
	struct drm_gem_cma_object base;
#else
	struct drm_gem_dma_object base;
#endif
	enum dma_data_direction dir;
};
```

这说明 `sunxi_drm` 的扫描输出 buffer 是标准：

- GEM CMA / GEM DMA
- 兼容 dma-buf / PRIME 的方向

所以它和 `dc_sunxi` 那种“直接抓 fbdev 显存切片”的模型是完全不同的。

---

# 5. 那么如果不用 DISP2(fbdev)，PVR 怎么通过 DRM/KMS 实现？

这里要把“PVR GPU 渲染”和“显示扫描输出”拆开看。

---

## 5.1 不是 PVR Services 自己突然变成了标准 KMS 显示驱动
从你这份代码来看，没有看到 PVR 在 `img-rgx/linux/...` 这里去直接驱动 `sunxi_drm` 的 plane/crtc/connector。

相反，`kerneldisplay.h` 明确说它那套 DC 接口是给**非原生 DRM/KMS** 场景的。  
这基本说明：

- PVR Services 的 Display Class 与 `dc_sunxi` 是老桥接路
- 标准 `sunxi_drm` KMS 则是另外一套显示体系

所以如果你启用 `sunxi_drm`，不是说“PVR Services 自动用 atomic commit 去驱动 sunxi_drm plane”，  
而更像是：

### PVR 负责渲染出 buffer
### `sunxi_drm` 负责把这个 buffer 当成 DRM framebuffer 扫出来

这中间通常需要一个 buffer sharing 机制，而不是 `dc_sunxi` 那种内部私有 DC buffer。

---

## 5.2 这类衔接在标准架构里一般靠 GEM / dma-buf / PRIME
`sunxi_drm` 这边已经具备标准共享 buffer 基础：

- `DRIVER_GEM`
- `drm_gem_fb_create_with_funcs`
- `drm_prime.h`
- `dma-buf` 支持
- GEM DMA/CMA object

例如 `sunxi_drm_gem.c` 明确处理了 imported dma-buf 的释放路径：

```24:41:/home/alientek/A733/qihua-x73x-linux6.6/bsp/drivers/drm/sunxi_drm_gem.c
void sunxi_drm_prime_gem_destroy(struct drm_gem_object *obj,
				 struct sg_table *sg, enum dma_data_direction dir)
{
	struct dma_buf_attachment *attach;
	struct dma_buf *dma_buf;

	attach = obj->import_attach;
...
	dma_buf = attach->dmabuf;
	dma_buf_detach(attach->dmabuf, attach);
	dma_buf_put(dma_buf);
}
```

这说明 `sunxi_drm` 至少从设计上是准备好接入 dma-buf imported buffer 的。

---

## 5.3 但你这份 PVR 代码里，没有看到它直接对 `sunxi_drm` 做标准 KMS 提交
从当前你给的源码范围里，我看到的是：

- PVR DRM 侧：`PVRSRV_BridgeDispatchKM`
- PVR 显示适配侧：`dc_sunxi`, `dc_fbdev`, `dc_pdp` 等 Display Class 后端
- `sunxi_drm` 侧：自己独立完整的 atomic DRM/KMS 实现

**没有看到一个“PVR -> sunxi_drm atomic plane commit”的直接绑定层。**

所以如果你问：

> “如果不是 PVR Services，那它怎么通过 DRM/KMS 实现的？”

我的源码级回答是：

### 不是“PVR Services 消失了”
而是：

1. **PVR Services 继续承担 GPU 渲染服务**
2. **显示不再通过 PVR DC 接口**
3. **显示改由独立的 `sunxi_drm` KMS 驱动用 GEM framebuffer / atomic commit 完成**
4. **PVR 产出的图像若要显示到 `sunxi_drm`，通常应通过标准共享 buffer 机制接入，而不是靠 `dc_sunxi` 那套 fbdev 翻页**

---

# 6. 你代码里还有一个关键线索：`sunxi_drm` 甚至带了自己的 fbdev 兼容层，但它不是 `dc_sunxi`
这点很容易混淆。

`sunxi_drm` 下有：

- `sunxi_drmfb_core.c`
- `sunxi_fbdev_core.c`

比如：

```116:125:/home/alientek/A733/qihua-x73x-linux6.6/bsp/drivers/drm/sunxi_drmfb_core.c
int sunxi_fbdev_init(struct drm_device *drm, struct display_channel_state *out_state)
{
	int ret;

	ret = drm_fb_config(drm, &create_info);
	if (ret)
		goto OUT;
	ret = drm_fb_init(&create_info, out_state);
OUT:
	return ret;
}
```

和：

```57:67:/home/alientek/A733/qihua-x73x-linux6.6/bsp/drivers/drm/sunxi_fbdev_core.c
int sunxi_fbdev_init(struct drm_device *drm, struct display_channel_state *out_state)
{
	int ret;

	ret = fb_config_init(drm, &create_info);
	if (ret)
		goto OUT;
	ret = fb_core_init(&create_info, out_state);
OUT:
	return ret;
}
```

这说明：

- `sunxi_drm` 自己也可以提供 fbdev/helper/兼容层
- 但这和 `PVR dc_sunxi -> registered_fb[0]` 不是一回事

也就是说：

### “sunxi_drm 带 fbdev helper”
≠
### “PVR 继续通过 dc_sunxi 控制显示”

前者是 **sunxi_drm 自己的兼容输出层**；  
后者是 **PVR Services 的 Display Class 后端**。

这两条不要混了。

---

# 7. 最终回答你的问题

---

## 问：如果我启用 `sunxi_drm` 标准 DRM/KMS，而不用 DISP2(fbdev)，PVR 的 GPU 用的还是 PVR Services 吗？

**是，仍然是。**

依据：

- `pvr_drm_load()` 仍然调用 `PVRSRVDeviceCreate()` / `PVRSRVCommonDeviceInit()`  
- PVR ioctl 仍然走 `PVRSRV_BridgeDispatchKM`
- 这说明 render/gpu 服务核心仍然是 PVR Services

---

## 问：如果不是，那它怎么通过 DRM/KMS 实现的？

更准确地说，不是“PVR Services 不用了”，而是：

### 1）GPU render 仍是 PVR Services
入口仍在 `pvr_drm.c`：

```95:138:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/kernel/drivers/staging/imgtec/pvr_drm.c
	srv_err = PVRSRVDeviceCreate(ddev->dev, deviceId, &priv->dev_node);
...
	err = PVRSRVCommonDeviceInit(priv->dev_node);
```

### 2）显示改由 `sunxi_drm` KMS 完成
入口在 `sunxi_drm_drv.c`：

```348:362:/home/alientek/A733/qihua-x73x-linux6.6/bsp/drivers/drm/sunxi_drm_drv.c
static struct drm_driver sunxi_drm_driver = {
	.driver_features = DRIVER_MODESET | DRIVER_GEM | DRIVER_ATOMIC,
...
	.gem_create_object = sunxi_gem_create_object,
...
};
```

提交模型是 atomic：

```165:169:/home/alientek/A733/qihua-x73x-linux6.6/bsp/drivers/drm/sunxi_drm_drv.c
static const struct drm_mode_config_funcs sunxi_drm_mode_config_funcs = {
	.atomic_check = drm_atomic_helper_check,
	.atomic_commit = sunxi_drm_atomic_helper_commit,
	.fb_create = sunxi_drm_gem_fb_create,
};
```

### 3）PVR 的旧显示桥接接口反而不再是主路
`kerneldisplay.h` 明确说明它适合“非原生 DRM/KMS”：

```58:61:/home/alientek/A733/qihua-x73x-linux6.6/bsp/modules/gpu/img-rgx/linux/rogue_km/services/include/kerneldisplay.h
This interface should be used and implemented if the 3rd party display driver
is not using a native OS interface such as the Linux DRM/KMS API.
```

所以启用 `sunxi_drm` 后，主显示路径应该是 `sunxi_drm` 自己的 GEM/FB/atomic，而不是 `dc_sunxi`。

---

# 8. 一句话收束

如果你切到 `@bsp/drivers/drm` 这套 `sunxi_drm` 标准 DRM/KMS：

- **PVR GPU 还是 PVR Services**
- **但 PVR Services 的 Display Class/fbdev 桥接显示路径不再是主显示路径**
- **真正的扫描输出由 `sunxi_drm` 的 GEM framebuffer + atomic KMS 完成**
- **两者衔接应走标准共享 buffer 路径，而不是 `dc_sunxi` 那种直接拿 fbdev 显存翻页**

---

如果你愿意，我下一步可以继续帮你把这个问题再往下落一层，专门做这两个方向之一：

1. **继续查你当前代码里有没有“PVR buffer → sunxi_drm framebuffer” 的实际共享链路**  
   也就是找是否真的用了 dma-buf/PRIME/导入导出；

2. **直接按启动/显示现象排查当前板子到底跑的是哪条路**  
   例如从 Kconfig、模块编译项、设备节点、init 日志和 probe 路径判断：
   - 是 `dc_sunxi + fbdev`
   - 还是 `sunxi_drm atomic`
   - 还是两者都在但只有一条真正生效。

