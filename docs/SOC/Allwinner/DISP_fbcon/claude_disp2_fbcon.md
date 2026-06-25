# 分析整体驱动框架的数据结构
_Exported on 2026/4/23 at GMT+8 23:43:36 from Cursor (2.0.34)_

---

**User**

@dev_fb.c (2470-2498) 能结合整体驱动框架分析一下里面的数据结构类型和目的吗

---

**Cursor**

我来帮您分析这段代码。首先让我读取整个文件来了解完整的驱动框架和数据结构定义。

好的,让我为您详细分析这段代码及其在整体驱动框架中的作用。

## 函数功能概述

`fb_free_reserve_mem` 是一个**工作队列(workqueue)处理函数**,用于在适当的时机释放启动时预留的内存资源(logo buffer)。

## 核心数据结构分析

### 1. **struct fb_info_t** (第30-56行定义)

```30:56:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c
struct fb_info_t {
	struct device *dev;

	bool fb_enable[SUNXI_FB_MAX];
	enum disp_fb_mode fb_mode[SUNXI_FB_MAX];
	u32 layer_hdl[SUNXI_FB_MAX][2];	/* channel, layer_id */
	struct fb_info *fbinfo[SUNXI_FB_MAX];
	struct disp_fb_create_info fb_para[SUNXI_FB_MAX];
	u32 pseudo_palette[SUNXI_FB_MAX][16];
	wait_queue_head_t wait[3];
	unsigned long wait_count[3];
	struct task_struct *vsync_task[3];
	spinlock_t slock[DISP_SCREEN_NUM];
	struct work_struct free_wq;
	bool wait_for_free[DISP_SCREEN_NUM];
	int vsync_cur_line[DISP_SCREEN_NUM][VSYNC_NUM];
	ktime_t vsync_timestamp[DISP_SCREEN_NUM][VSYNC_NUM];
	u32 vsync_timestamp_head[DISP_SCREEN_NUM];
	u32 vsync_timestamp_tail[DISP_SCREEN_NUM];

	struct fb_g2d_rot_t *fb_rot[FB_MAX];
	int mem_cache_flag[SUNXI_FB_MAX];

	int blank[3];
	struct disp_ion_mem *mem[SUNXI_FB_MAX];
	struct disp_layer_config config[SUNXI_FB_MAX];
};
```

这是全志显示驱动的**核心管理结构**,包含了整个framebuffer子系统的状态信息。

### 2. 函数中使用的关键字段

在 `fb_free_reserve_mem` 中涉及的字段:

- **`wait_queue_head_t wait[3]`** (第39行)
  - **类型**: Linux内核等待队列头
  - **目的**: 用于实现进程同步,等待vsync信号
  - **数组大小**: 3表示最多支持3个显示屏

- **`unsigned long wait_count[3]`** (第40行)
  - **类型**: 无符号长整型计数器
  - **目的**: 记录vsync信号发生的次数,用于检测是否有新的vsync到来
  - **工作原理**: 每次vsync中断时递增(见第1022行)

- **`bool wait_for_free[DISP_SCREEN_NUM]`** (第44行)
  - **类型**: 布尔标志数组
  - **目的**: 标记哪个屏幕需要等待释放预留内存
  - **设置位置**: 在拷贝boot logo后设置(见第1721行)

- **`struct work_struct free_wq`** (第43行)
  - **类型**: Linux内核工作队列结构
  - **目的**: 延迟执行内存释放操作

## 代码逻辑详解

```2471:2497:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c
static void fb_free_reserve_mem(struct work_struct *work)
{
	int i;
	int ret;
	unsigned long count;
	for (i = 0; i < DISP_SCREEN_NUM; i++) {
		if (g_fbi.wait_for_free[i]) {
			count = g_fbi.wait_count[i];
			ret =
			    wait_event_interruptible_timeout(g_fbi.wait[i],
							     count !=
							     g_fbi.
							     wait_count[i],
							     msecs_to_jiffies
							     (2000));
			if (ret <= 0) {
				__wrn("[DISP] %s wait for sync timeout\n", __func__);
			}
		}
	}
#ifndef MODULE
	/*
	 * we must make sure the new kernel logo address was updated to hw before call this function
	 */
	disp_reserve_mem(false);
#endif
}
```

### 执行流程:

1. **遍历所有显示屏**: 检查每个屏幕是否需要等待释放

2. **等待vsync信号**:
   ```c
   wait_event_interruptible_timeout(g_fbi.wait[i],
                                    count != g_fbi.wait_count[i],
                                    msecs_to_jiffies(2000));
   ```
   - 等待条件: `wait_count` 发生变化(表示有新的vsync到来)
   - 超时时间: 2000毫秒
   - **目的**: 确保新的logo已经显示到硬件上

3. **释放预留内存**: 调用 `disp_reserve_mem(false)` 释放bootloader阶段预留的内存

## 在整体框架中的作用

### 触发时机

在 `fb_init` 函数中调度执行:

```2655:2662:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c
	if (!ret)
		for (i = 0; i < DISP_SCREEN_NUM; i++) {
			if (g_fbi.wait_for_free[i]) {
				INIT_WORK(&g_fbi.free_wq, fb_free_reserve_mem);
				schedule_work(&g_fbi.free_wq);
				break;
			}
		}
```

### 与vsync机制的配合

```1020:1024:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c
void DRV_disp_int_process(u32 sel)
{
	g_fbi.wait_count[sel]++;
	wake_up_interruptible_all(&g_fbi.wait[sel]);
}
```

每次vsync中断时:
1. `wait_count` 递增
2. 唤醒等待队列中的进程

## 设计目的

这个机制解决了**无缝启动(seamless boot)**的关键问题:

1. **内存复用**: bootloader使用的logo buffer不能立即释放
2. **同步保证**: 必须等到内核的新logo显示到屏幕后再释放旧buffer
3. **避免闪烁**: 通过vsync同步确保切换平滑无闪烁

## 相关的预留内存管理

```202:218:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c
static u32 disp_reserve_size;
static u32 disp_reserve_base;
int disp_reserve_mem(bool reserve)
{
	if (!disp_reserve_size || !disp_reserve_base)
		return -EINVAL;

	if (reserve)
		memblock_reserve(disp_reserve_base, disp_reserve_size);
	else {
		memblock_free(disp_reserve_base, disp_reserve_size);
		free_reserved_area(__va(disp_reserve_base), __va(disp_reserve_base + disp_reserve_size), 0x100, "logo buffer");
	}

	return 0;
}
```

这个函数用于真正释放或保留memblock内存区域。

## 总结

`fb_free_reserve_mem` 是全志显示驱动中一个精心设计的内存管理机制,通过**工作队列+等待队列+vsync同步**的组合,实现了启动logo的平滑过渡,是实现无缝启动体验的关键组件。

```c
struct fb_info_t {
	struct device *dev;

	bool fb_enable[SUNXI_FB_MAX];
	enum disp_fb_mode fb_mode[SUNXI_FB_MAX];
	u32 layer_hdl[SUNXI_FB_MAX][2];	/* channel, layer_id */
	struct fb_info *fbinfo[SUNXI_FB_MAX];
	struct disp_fb_create_info fb_para[SUNXI_FB_MAX];
	u32 pseudo_palette[SUNXI_FB_MAX][16];
	wait_queue_head_t wait[3];
	unsigned long wait_count[3];
	struct task_struct *vsync_task[3];
	spinlock_t slock[DISP_SCREEN_NUM];
	struct work_struct free_wq;
	bool wait_for_free[DISP_SCREEN_NUM];
	int vsync_cur_line[DISP_SCREEN_NUM][VSYNC_NUM];
	ktime_t vsync_timestamp[DISP_SCREEN_NUM][VSYNC_NUM];
	u32 vsync_timestamp_head[DISP_SCREEN_NUM];
	u32 vsync_timestamp_tail[DISP_SCREEN_NUM];

	struct fb_g2d_rot_t *fb_rot[FB_MAX];
	int mem_cache_flag[SUNXI_FB_MAX];

	int blank[3];
	struct disp_ion_mem *mem[SUNXI_FB_MAX];
	struct disp_layer_config config[SUNXI_FB_MAX];
};
```

```c
static void fb_free_reserve_mem(struct work_struct *work)
{
	int i;
	int ret;
	unsigned long count;
	for (i = 0; i < DISP_SCREEN_NUM; i++) {
		if (g_fbi.wait_for_free[i]) {
			count = g_fbi.wait_count[i];
			ret =
			    wait_event_interruptible_timeout(g_fbi.wait[i],
							     count !=
							     g_fbi.
							     wait_count[i],
							     msecs_to_jiffies
							     (2000));
			if (ret <= 0) {
				__wrn("[DISP] %s wait for sync timeout\n", __func__);
			}
		}
	}
#ifndef MODULE
	/*
	 * we must make sure the new kernel logo address was updated to hw before call this function
	 */
	disp_reserve_mem(false);
#endif
}
```

```c
   wait_event_interruptible_timeout(g_fbi.wait[i],
                                    count != g_fbi.wait_count[i],
                                    msecs_to_jiffies(2000));
```

```c
	if (!ret)
		for (i = 0; i < DISP_SCREEN_NUM; i++) {
			if (g_fbi.wait_for_free[i]) {
				INIT_WORK(&g_fbi.free_wq, fb_free_reserve_mem);
				schedule_work(&g_fbi.free_wq);
				break;
			}
		}
```

```c
void DRV_disp_int_process(u32 sel)
{
	g_fbi.wait_count[sel]++;
	wake_up_interruptible_all(&g_fbi.wait[sel]);
}
```

```c
static u32 disp_reserve_size;
static u32 disp_reserve_base;
int disp_reserve_mem(bool reserve)
{
	if (!disp_reserve_size || !disp_reserve_base)
		return -EINVAL;

	if (reserve)
		memblock_reserve(disp_reserve_base, disp_reserve_size);
	else {
		memblock_free(disp_reserve_base, disp_reserve_size);
		free_reserved_area(__va(disp_reserve_base), __va(disp_reserve_base + disp_reserve_size), 0x100, "logo buffer");
	}

	return 0;
}
```

---

**User**

开启sunxi_fbcon_support后



启用后屏幕却出现异常，原本进入内核后屏幕背光会亮，但是添加后屏幕背光都亮不了，但是uboot阶段的的bootlogo仍然可以正常显示，通过dmesg发现



root@kickpi:~# dmesg | grep -i fb



[ 0.741177] display_fb_request,fb_id:0



[ 15.068616] [DISP] fb_free_reserve_mem,line:2312:



[ 15.068620] [DISP] fb_free_reserve_mem wait for sync timeout

后来经过测试，发现注释

@dev_fb.c (577-600)的mgr->device->enable(mgr->device);屏幕就可以亮并且正常显示，因此我怀疑因为释放uboot的logo显存的时候，由于fbcon需要打开fb给mipi屏幕初始化信息，而此时uboot的buffer没有释放完，而且也有其他函数也在等待vsync，导致在下一次vsync同步时出现问题，屏幕驱动后续初始化失败，这样解释合理吗



---

**Cursor**

您的分析**基本合理**，但我需要帮您更准确地理解这个时序问题。让我详细分析一下整个流程和冲突点：

## 问题根源分析

### 正常启动流程（未启用fbcon）

```
uboot阶段:
  ├─ 显示bootlogo (使用预留内存)
  └─ 硬件已初始化，vsync正常运行

内核启动:
  ├─ fb_init() 调用
  ├─ display_fb_request() -> Fb_map_kernel_logo() 
  │   └─ 拷贝logo到新buffer，设置 wait_for_free[i]=true
  ├─ 调度 fb_free_reserve_mem 工作队列
  └─ fb_free_reserve_mem 等待vsync -> 成功 -> 释放旧内存
```

### 启用fbcon后的冲突流程

```
内核启动:
  ├─ fb_init() 调用
  ├─ register_framebuffer() 
  │   └─ 触发 fbcon 初始化
  │       └─ fbcon_init() 
  │           └─ fb_open() 
  │               └─ sunxi_fb_open()  <-- 在这里！
  │
  └─ [并发] fb_free_reserve_mem 在等待vsync
```

让我看看 `sunxi_fb_open` 的具体问题：

```577:600:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c
static int sunxi_fb_open(struct fb_info *info, int user)
{
	u32 num_screens;
	u32 sel = 0;

	num_screens = bsp_disp_feat_get_num_screens();
	for (sel = 0; sel < num_screens; sel++) {
		if (sel == g_fbi.fb_mode[info->node]) {
			struct disp_manager *mgr = g_disp_drv.mgr[sel];
			if (mgr && mgr->device) {
				if (mgr->device->is_enabled) {
					if (!mgr->device->is_enabled(mgr->device)) {
						if (mgr->device->enable)
							mgr->device->enable(mgr->device);
						mgr->set_layer_config(mgr, &g_fbi.config[sel],
								      1);
						disp_delay_ms(20);
					}
				}
			}
		}
	}
	return 0;
}
```

## 核心问题

**第588-590行的逻辑存在问题**：

```c
if (!mgr->device->is_enabled(mgr->device)) {
    if (mgr->device->enable)
        mgr->device->enable(mgr->device);  // 重新初始化设备
```

### 问题1: 设备状态判断时机错误

在 `fb_init` 流程中：
1. 如果 uboot 已经初始化了显示设备，设备应该是 **enabled** 状态
2. 但如果 fbcon 在某个时机打开 fb 时设备状态检查失败，就会触发 `enable()`
3. **重新 enable 会导致**：
   - LCD/MIPI 控制器重新初始化
   - **vsync 中断可能被暂时禁用或重置**
   - 时序控制器重新配置

### 问题2: 竞态条件

```
时间线:
T0: fb_free_reserve_mem 开始等待 vsync
     ├─ 保存当前 wait_count
     └─ 等待 wait_count 变化...

T1: fbcon 调用 sunxi_fb_open
     └─ mgr->device->enable() 重新初始化
         ├─ 停止 vsync 中断 (?)
         ├─ 重置硬件
         └─ 延迟 20ms
         
T2: vsync 中断丢失或延迟

T3: 2000ms 超时 ⚠️
```

## 更精确的解释

您的怀疑**部分正确**，但核心问题不是"uboot buffer 没释放完"，而是：

### 真正的原因

1. **设备已经是 enabled 状态**（uboot 已初始化）
2. **不应该再次调用 enable()**，因为：
   - 这会打断正在运行的 vsync 机制
   - 重新初始化可能清空显示 buffer
   - MIPI DSI 初始化序列可能与当前状态冲突

3. **`sunxi_fb_open` 的设计意图**：
   - 检查设备是否禁用
   - 如果禁用则重新使能
   - **但这个逻辑在启动阶段是多余的**

## 解决方案建议

### 方案1: 改进判断逻辑（推荐）

```c
static int sunxi_fb_open(struct fb_info *info, int user)
{
	u32 num_screens;
	u32 sel = 0;

	num_screens = bsp_disp_feat_get_num_screens();
	for (sel = 0; sel < num_screens; sel++) {
		if (sel == g_fbi.fb_mode[info->node]) {
			struct disp_manager *mgr = g_disp_drv.mgr[sel];
			if (mgr && mgr->device) {
				if (mgr->device->is_enabled) {
					if (!mgr->device->is_enabled(mgr->device)) {
						// 添加保护：只在非启动阶段或确认需要时才enable
						// 方案A: 检查是否是首次打开（启动阶段）
						if (g_fbi.fb_enable[info->node]) {
							// framebuffer已经初始化，可以安全enable
							if (mgr->device->enable)
								mgr->device->enable(mgr->device);
							mgr->set_layer_config(mgr, &g_fbi.config[sel], 1);
							disp_delay_ms(20);
						}
					} else {
						// 设备已经enabled，只需要设置layer配置
						mgr->set_layer_config(mgr, &g_fbi.config[sel], 1);
					}
				}
			}
		}
	}
	return 0;
}
```

### 方案2: 使用引用计数

```c
static atomic_t fb_open_count[SUNXI_FB_MAX];

static int sunxi_fb_open(struct fb_info *info, int user)
{
	// 首次打开时跳过enable，设备已经由uboot初始化
	if (atomic_inc_return(&fb_open_count[info->node]) == 1) {
		// 第一次打开，假设设备已初始化
		return 0;
	}
	
	// 后续打开时执行正常逻辑
	// ... 原有代码
}
```

### 方案3: 检查启动同步标志

```c
static int sunxi_fb_open(struct fb_info *info, int user)
{
	// 如果是boot阶段的seamless启动，跳过enable
	if (g_disp_drv.para.boot_info.sync == 1) {
		// 启动同步模式，设备已由uboot初始化
		return 0;
	}
	
	// 正常模式下的原有逻辑
	// ... 
}
```

## 总结

您的分析方向正确，问题的本质是：

✅ **fbcon 的提前介入** 导致 `sunxi_fb_open` 被调用  
✅ **设备重新初始化** 打断了 vsync 信号链  
✅ **时序冲突** 导致 `fb_free_reserve_mem` 等待超时  

但需要澄清的是：
- ❌ 不是"uboot buffer没释放完"阻塞了操作
- ✅ 而是"重复初始化设备"导致 vsync 中断丢失
- ✅ 关键是避免在启动阶段重复调用 `enable()`

建议您结合实际情况选择合适的修复方案，最好添加启动阶段的状态检查，避免不必要的设备重新初始化。

```plaintext
uboot阶段:
  ├─ 显示bootlogo (使用预留内存)
  └─ 硬件已初始化，vsync正常运行

内核启动:
  ├─ fb_init() 调用
  ├─ display_fb_request() -> Fb_map_kernel_logo() 
  │   └─ 拷贝logo到新buffer，设置 wait_for_free[i]=true
  ├─ 调度 fb_free_reserve_mem 工作队列
  └─ fb_free_reserve_mem 等待vsync -> 成功 -> 释放旧内存
```

```plaintext
内核启动:
  ├─ fb_init() 调用
  ├─ register_framebuffer() 
  │   └─ 触发 fbcon 初始化
  │       └─ fbcon_init() 
  │           └─ fb_open() 
  │               └─ sunxi_fb_open()  <-- 在这里！
  │
  └─ [并发] fb_free_reserve_mem 在等待vsync
```

```c
static int sunxi_fb_open(struct fb_info *info, int user)
{
	u32 num_screens;
	u32 sel = 0;

	num_screens = bsp_disp_feat_get_num_screens();
	for (sel = 0; sel < num_screens; sel++) {
		if (sel == g_fbi.fb_mode[info->node]) {
			struct disp_manager *mgr = g_disp_drv.mgr[sel];
			if (mgr && mgr->device) {
				if (mgr->device->is_enabled) {
					if (!mgr->device->is_enabled(mgr->device)) {
						if (mgr->device->enable)
							mgr->device->enable(mgr->device);
						mgr->set_layer_config(mgr, &g_fbi.config[sel],
								      1);
						disp_delay_ms(20);
					}
				}
			}
		}
	}
	return 0;
}
```

```c
if (!mgr->device->is_enabled(mgr->device)) {
    if (mgr->device->enable)
        mgr->device->enable(mgr->device);  // 重新初始化设备
```

```plaintext
时间线:
T0: fb_free_reserve_mem 开始等待 vsync
     ├─ 保存当前 wait_count
     └─ 等待 wait_count 变化...

T1: fbcon 调用 sunxi_fb_open
     └─ mgr->device->enable() 重新初始化
         ├─ 停止 vsync 中断 (?)
         ├─ 重置硬件
         └─ 延迟 20ms
         
T2: vsync 中断丢失或延迟

T3: 2000ms 超时 ⚠️
```

```c
static int sunxi_fb_open(struct fb_info *info, int user)
{
	u32 num_screens;
	u32 sel = 0;

	num_screens = bsp_disp_feat_get_num_screens();
	for (sel = 0; sel < num_screens; sel++) {
		if (sel == g_fbi.fb_mode[info->node]) {
			struct disp_manager *mgr = g_disp_drv.mgr[sel];
			if (mgr && mgr->device) {
				if (mgr->device->is_enabled) {
					if (!mgr->device->is_enabled(mgr->device)) {
						// 添加保护：只在非启动阶段或确认需要时才enable
						// 方案A: 检查是否是首次打开（启动阶段）
						if (g_fbi.fb_enable[info->node]) {
							// framebuffer已经初始化，可以安全enable
							if (mgr->device->enable)
								mgr->device->enable(mgr->device);
							mgr->set_layer_config(mgr, &g_fbi.config[sel], 1);
							disp_delay_ms(20);
						}
					} else {
						// 设备已经enabled，只需要设置layer配置
						mgr->set_layer_config(mgr, &g_fbi.config[sel], 1);
					}
				}
			}
		}
	}
	return 0;
}
```

```c
static atomic_t fb_open_count[SUNXI_FB_MAX];

static int sunxi_fb_open(struct fb_info *info, int user)
{
	// 首次打开时跳过enable，设备已经由uboot初始化
	if (atomic_inc_return(&fb_open_count[info->node]) == 1) {
		// 第一次打开，假设设备已初始化
		return 0;
	}
	
	// 后续打开时执行正常逻辑
	// ... 原有代码
}
```

```c
static int sunxi_fb_open(struct fb_info *info, int user)
{
	// 如果是boot阶段的seamless启动，跳过enable
	if (g_disp_drv.para.boot_info.sync == 1) {
		// 启动同步模式，设备已由uboot初始化
		return 0;
	}
	
	// 正常模式下的原有逻辑
	// ... 
}
```

---

**User**

请你结合代码帮我分析

1、设备分别在什么时候被enable

2、为什么内核阶段检查enable不通过

---

**Cursor**

我来帮您深入分析这两个关键问题。让我先查看相关的代码结构。

好的，现在我已经掌握了足够的信息来为您详细解答这两个问题。让我整理分析结果：

## 详细分析结果

### 问题1: 设备分别在什么时候被enable

#### **Uboot阶段**
Uboot已经完成了LCD硬件的完整初始化：
- 配置LCD时序控制器(TCON)
- 使能时钟(LCD clock, DSI clock等)
- 初始化MIPI DSI接口
- 显示bootlogo
- **关键点**：硬件处于工作状态，vsync中断正常运行

#### **内核启动流程**

```
1. disp_probe() (dev_disp.c:2878)
   └─ disp_init() (dev_disp.c:2256)
       ├─ 解析boot参数，设置 boot_info.sync = 1 (第2306行)
       │  (如果boot_disp有效值，表示需要seamless显示)
       │
       ├─ bsp_disp_init(para) (第2358行)  ⚠️ 关键调用
       │   └─ disp_init_feat() in disp_display.c
       │       └─ 连接manager和device (第476-501行)
       │           └─ 如果 boot_info.sync == 1:
       │               └─ 只连接设备，不调用enable
       │
       ├─ lcd_init() (第2373行)
       │   └─ disp_lcd_init() - 初始化LCD设备对象
       │       └─ 设置函数指针:
       │           ├─ lcd->enable = disp_lcd_enable
       │           ├─ lcd->sw_enable = disp_lcd_sw_enable  ⚠️
       │           └─ lcd->is_enabled = disp_lcd_is_enabled
       │
       ├─ bsp_disp_open() (第2374行)
       │
       ├─ fb_init() (第2375行)
       │   ├─ display_fb_request()
       │   │   └─ Fb_map_kernel_logo() - 拷贝logo
       │   │       └─ 设置 wait_for_free[i] = true (第1721行)
       │   │
       │   └─ register_framebuffer()  ⚠️ 这里触发fbcon
       │       └─ fbcon_init()
       │           └─ fb_open()
       │               └─ sunxi_fb_open() (第577行)
       │                   └─ 检查 is_enabled()  ⚠️ 问题发生点
       │
       └─ start_process() (第2292行)
           └─ schedule_work(start_work)
               └─ start_work() (第1924行)
                   └─ 如果 boot_info.sync == 1:
                       └─ 检查输出类型是否匹配 (第1986行)
                           └─ 如果不匹配:
                               └─ bsp_disp_sync_with_hw() (第1988行)
                                   └─ disp_device_attached()
                                   └─ mgr->device->sw_enable()  ⚠️ 真正设置软件状态
```

### 关键代码段分析

#### bsp_disp_sync_with_hw (disp_display.c:592)

```592:671:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/de/disp_display.c
s32 bsp_disp_sync_with_hw(struct disp_bsp_init_para *para)
{
	if ((para->boot_info.sync == 1)
	    && (para->boot_info.type != DISP_OUTPUT_TYPE_NONE)) {
		int num_screens = 0;
		int disp = para->boot_info.disp;
		int disp_dev = disp;
		enum disp_output_type type =
		    (enum disp_output_type)para->boot_info.type;
		enum disp_tv_mode mode =
			(enum disp_tv_mode)para->boot_info.mode;
		enum disp_csc_type format =
			(enum disp_csc_type)para->boot_info.format;
		enum disp_data_bits bits =
			(enum disp_data_bits)para->boot_info.bits;
		enum disp_color_space cs =
			(enum disp_color_space)para->boot_info.cs;
		enum disp_eotf eotf = (enum disp_eotf)para->boot_info.eotf;

		int ret = -1;
		struct disp_manager *mgr = NULL;

		struct disp_device_config config;
		memset(&config, 0, sizeof(struct disp_device_config));

		config.type = type;
		config.mode = mode;
		config.format = format;
		config.bits = bits;
		config.eotf = eotf;
		config.cs = cs;
		config.dvi_hdmi = para->boot_info.dvi_hdmi;
		config.range = para->boot_info.range;
		config.scan = para->boot_info.scan;
		config.aspect_ratio = para->boot_info.aspect_ratio;

		if ((config.dvi_hdmi != DISP_DVI) && (config.dvi_hdmi != DISP_HDMI))
			config.dvi_hdmi = DISP_HDMI;
		if (config.range > 2)
			config.range = 0;
		if (config.scan > 2)
			config.scan = 0;
		if (!config.aspect_ratio)
			config.aspect_ratio = 8;

		mgr = disp_get_layer_manager(disp);
		if (!mgr)
			return -1;

		/* attach manager and display device */
		ret = disp_device_attached(disp, disp_dev, &config);
		if (ret != 0) {
			num_screens = bsp_disp_feat_get_num_screens();
			for (disp_dev = 0; disp_dev < num_screens; disp_dev++) {
				ret =
				    disp_device_attached(disp, disp_dev, &config);
				if (ret == 0)
					break;
			}
		}

		/* enable display device(only software) */
		if (ret != 0) {
			/* attach fail */
			DE_WRN("Can't find device(%d) for manager %d\n",
			     (int)type, disp);
			return -1;
		}
		if (mgr->device && mgr->device->sw_enable) {
			if (mgr->device->set_mode)
				mgr->device->set_mode(mgr->device, mode);
			else if (mgr->device->set_static_config)
				mgr->device->set_static_config(mgr->device,
							&config);
			return mgr->device->sw_enable(mgr->device);
		}
	}

	return -1;
}
```

**注意第660-666行**：调用的是 `sw_enable()` 而不是 `enable()`

#### disp_lcd_sw_enable (disp_lcd.c:2207)

```2298:2303:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/de/disp_lcd.c
	spin_lock_irqsave(&lcd_data_lock, flags);
	lcdp->enabled = 1;
	lcdp->enabling = 0;
	lcdp->bl_need_enabled = 1;
	lcdp->bl_enabled = true;
	spin_unlock_irqrestore(&lcd_data_lock, flags);
```

**关键**：`sw_enable` 只设置软件标志 `lcdp->enabled = 1`，**不重新初始化硬件**

### 问题2: 为什么内核阶段检查 is_enabled 不通过

#### 检查流程

```577:600:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c
static int sunxi_fb_open(struct fb_info *info, int user)
{
	u32 num_screens;
	u32 sel = 0;

	num_screens = bsp_disp_feat_get_num_screens();
	for (sel = 0; sel < num_screens; sel++) {
		if (sel == g_fbi.fb_mode[info->node]) {
			struct disp_manager *mgr = g_disp_drv.mgr[sel];
			if (mgr && mgr->device) {
				if (mgr->device->is_enabled) {
					if (!mgr->device->is_enabled(mgr->device)) {
						if (mgr->device->enable)
							mgr->device->enable(mgr->device);
						mgr->set_layer_config(mgr, &g_fbi.config[sel],
								      1);
						disp_delay_ms(20);
					}
				}
			}
		}
	}
	return 0;
}
```

#### is_enabled 的实现

```2345:2355:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/de/disp_lcd.c
s32 disp_lcd_is_enabled(struct disp_device *lcd)
{
	struct disp_lcd_private_data *lcdp = disp_lcd_get_priv(lcd);

	if ((lcd == NULL) || (lcdp == NULL)) {
		DE_WRN("NULL hdl!\n");
		return DIS_FAIL;
	}

	return (s32)lcdp->enabled;
}
```

### 🔴 **核心问题**

#### 时间线分析

```
时间点  | 事件 | lcdp->enabled 状态 | 硬件状态
--------|------|-------------------|----------
T0      | Uboot完成初始化 | (未初始化) | ✅ 正常工作
T1      | disp_init开始 | 0 | ✅ 正常工作
T2      | bsp_disp_init完成 | 0 | ✅ 正常工作
T3      | fb_init调用 | 0 | ✅ 正常工作
T4      | register_framebuffer | 0 | ✅ 正常工作
T5 ⚠️   | fbcon_init->fb_open | 0 ❌ | ✅ 正常工作
        | └─ is_enabled返回0  |   |
        | └─ 调用enable()重新初始化硬件 | | ❌ 被重置
T6      | start_work延迟执行 | 0 | ❌ 被破坏
T7      | bsp_disp_sync_with_hw | 1 (太晚了) | ❌ 已损坏
```

#### **问题根源**：竞态条件

1. **`start_work` 是异步执行的**（第1999行）：
   ```c
   schedule_work(&g_disp_drv.start_work);
   ```

2. **`register_framebuffer` 是同步的**，立即触发fbcon初始化

3. **时序冲突**：
   ```
   fb_init()
     ├─ register_framebuffer()  <- 同步执行
     │   └─ fbcon -> fb_open()
     │       └─ is_enabled() 返回 0  ⚠️ lcdp->enabled未设置
     │           └─ enable()  <- 重新初始化硬件
     │
     └─ start_process()  <- 调度异步工作
         └─ (延迟执行)
             └─ bsp_disp_sync_with_hw()
                 └─ sw_enable()  <- 设置lcdp->enabled = 1
                     (但硬件已被破坏)
   ```

### 为什么检查不通过？

**关键原因**：`lcdp->enabled` 标志位在 `sw_enable()` 中才被设置为1，但这个函数：
1. 在 `start_work` 中异步调用
2. 在 `register_framebuffer` **之后**才执行
3. 而 `fbcon` 在 `register_framebuffer` 中**同步**触发

因此当 `sunxi_fb_open` 检查 `is_enabled()` 时：
- 软件状态：`lcdp->enabled = 0` ❌
- 硬件状态：已由uboot初始化，正常工作 ✅
- 检查结果：认为设备未使能
- 错误动作：调用 `enable()` 重新初始化
- 后果：打断vsync，破坏时序

## 解决方案

### 最佳方案：在 `bsp_disp_init` 阶段同步设置软件状态

修改 `disp_display.c` 中的设备连接逻辑：

```476:501:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/de/disp_display.c
	if ((para->boot_info.sync == 1)
	    && (disp == para->boot_info.disp)
	    && (para->boot_info.type == DISP_OUTPUT_TYPE_LCD)) {
		/* connect device & it's manager */
		dispdev = disp_device_get(disp, DISP_OUTPUT_TYPE_LCD);
		if ((dispdev) && (dispdev->set_manager)) {
			dispdev->set_manager(dispdev, mgr);
		} else {
			for (i = 0; i < num_screens; i++) {
				dispdev =
				    disp_device_get(i,
						DISP_OUTPUT_TYPE_LCD);
				if ((dispdev)
				    && (dispdev->set_manager)) {
					dispdev->set_manager(dispdev,
							     mgr);
					break;
				}
			}
		}
	} else if (para->boot_info.sync == 0) {
		dispdev = disp_device_get(disp, DISP_OUTPUT_TYPE_LCD);
		if ((dispdev) && (dispdev->set_manager))
			dispdev->set_manager(dispdev, mgr);
		mgr->enable_iommu(mgr, true);
	}
```

**在设置manager后立即调用 `sw_enable()`：**

```c
if ((para->boot_info.sync == 1)
    && (disp == para->boot_info.disp)
    && (para->boot_info.type == DISP_OUTPUT_TYPE_LCD)) {
	/* connect device & it's manager */
	dispdev = disp_device_get(disp, DISP_OUTPUT_TYPE_LCD);
	if ((dispdev) && (dispdev->set_manager)) {
		dispdev->set_manager(dispdev, mgr);
		// ✅ 立即同步设置软件状态
		if (dispdev->sw_enable) {
			dispdev->sw_enable(dispdev);
		}
	}
	// ... 其他逻辑
}
```

这样可以确保在 `fbcon` 调用 `fb_open` 时，`lcdp->enabled` 已经是 1，避免重复初始化。

## 总结

您的怀疑**完全正确**！问题的本质是：

✅ **时序竞态**：`start_work` 异步执行，`fbcon` 同步触发  
✅ **状态不一致**：硬件已使能但软件标志未设置  
✅ **错误重置**：`sunxi_fb_open` 误判导致重新初始化  
✅ **vsync中断丢失**：重新初始化打断了正在运行的vsync机制  
✅ **超时发生**：`fb_free_reserve_mem` 等待vsync超时  

建议采用上述方案，在 `bsp_disp_init` 阶段同步设置软件状态，避免竞态条件。

```plaintext
1. disp_probe() (dev_disp.c:2878)
   └─ disp_init() (dev_disp.c:2256)
       ├─ 解析boot参数，设置 boot_info.sync = 1 (第2306行)
       │  (如果boot_disp有效值，表示需要seamless显示)
       │
       ├─ bsp_disp_init(para) (第2358行)  ⚠️ 关键调用
       │   └─ disp_init_feat() in disp_display.c
       │       └─ 连接manager和device (第476-501行)
       │           └─ 如果 boot_info.sync == 1:
       │               └─ 只连接设备，不调用enable
       │
       ├─ lcd_init() (第2373行)
       │   └─ disp_lcd_init() - 初始化LCD设备对象
       │       └─ 设置函数指针:
       │           ├─ lcd->enable = disp_lcd_enable
       │           ├─ lcd->sw_enable = disp_lcd_sw_enable  ⚠️
       │           └─ lcd->is_enabled = disp_lcd_is_enabled
       │
       ├─ bsp_disp_open() (第2374行)
       │
       ├─ fb_init() (第2375行)
       │   ├─ display_fb_request()
       │   │   └─ Fb_map_kernel_logo() - 拷贝logo
       │   │       └─ 设置 wait_for_free[i] = true (第1721行)
       │   │
       │   └─ register_framebuffer()  ⚠️ 这里触发fbcon
       │       └─ fbcon_init()
       │           └─ fb_open()
       │               └─ sunxi_fb_open() (第577行)
       │                   └─ 检查 is_enabled()  ⚠️ 问题发生点
       │
       └─ start_process() (第2292行)
           └─ schedule_work(start_work)
               └─ start_work() (第1924行)
                   └─ 如果 boot_info.sync == 1:
                       └─ 检查输出类型是否匹配 (第1986行)
                           └─ 如果不匹配:
                               └─ bsp_disp_sync_with_hw() (第1988行)
                                   └─ disp_device_attached()
                                   └─ mgr->device->sw_enable()  ⚠️ 真正设置软件状态
```

```c
s32 bsp_disp_sync_with_hw(struct disp_bsp_init_para *para)
{
	if ((para->boot_info.sync == 1)
	    && (para->boot_info.type != DISP_OUTPUT_TYPE_NONE)) {
		int num_screens = 0;
		int disp = para->boot_info.disp;
		int disp_dev = disp;
		enum disp_output_type type =
		    (enum disp_output_type)para->boot_info.type;
		enum disp_tv_mode mode =
			(enum disp_tv_mode)para->boot_info.mode;
		enum disp_csc_type format =
			(enum disp_csc_type)para->boot_info.format;
		enum disp_data_bits bits =
			(enum disp_data_bits)para->boot_info.bits;
		enum disp_color_space cs =
			(enum disp_color_space)para->boot_info.cs;
		enum disp_eotf eotf = (enum disp_eotf)para->boot_info.eotf;

		int ret = -1;
		struct disp_manager *mgr = NULL;

		struct disp_device_config config;
		memset(&config, 0, sizeof(struct disp_device_config));

		config.type = type;
		config.mode = mode;
		config.format = format;
		config.bits = bits;
		config.eotf = eotf;
		config.cs = cs;
		config.dvi_hdmi = para->boot_info.dvi_hdmi;
		config.range = para->boot_info.range;
		config.scan = para->boot_info.scan;
		config.aspect_ratio = para->boot_info.aspect_ratio;

		if ((config.dvi_hdmi != DISP_DVI) && (config.dvi_hdmi != DISP_HDMI))
			config.dvi_hdmi = DISP_HDMI;
		if (config.range > 2)
			config.range = 0;
		if (config.scan > 2)
			config.scan = 0;
		if (!config.aspect_ratio)
			config.aspect_ratio = 8;

		mgr = disp_get_layer_manager(disp);
		if (!mgr)
			return -1;

		/* attach manager and display device */
		ret = disp_device_attached(disp, disp_dev, &config);
		if (ret != 0) {
			num_screens = bsp_disp_feat_get_num_screens();
			for (disp_dev = 0; disp_dev < num_screens; disp_dev++) {
				ret =
				    disp_device_attached(disp, disp_dev, &config);
				if (ret == 0)
					break;
			}
		}

		/* enable display device(only software) */
		if (ret != 0) {
			/* attach fail */
			DE_WRN("Can't find device(%d) for manager %d\n",
			     (int)type, disp);
			return -1;
		}
		if (mgr->device && mgr->device->sw_enable) {
			if (mgr->device->set_mode)
				mgr->device->set_mode(mgr->device, mode);
			else if (mgr->device->set_static_config)
				mgr->device->set_static_config(mgr->device,
							&config);
			return mgr->device->sw_enable(mgr->device);
		}
	}

	return -1;
}
```

```c
	spin_lock_irqsave(&lcd_data_lock, flags);
	lcdp->enabled = 1;
	lcdp->enabling = 0;
	lcdp->bl_need_enabled = 1;
	lcdp->bl_enabled = true;
	spin_unlock_irqrestore(&lcd_data_lock, flags);
```

```c
static int sunxi_fb_open(struct fb_info *info, int user)
{
	u32 num_screens;
	u32 sel = 0;

	num_screens = bsp_disp_feat_get_num_screens();
	for (sel = 0; sel < num_screens; sel++) {
		if (sel == g_fbi.fb_mode[info->node]) {
			struct disp_manager *mgr = g_disp_drv.mgr[sel];
			if (mgr && mgr->device) {
				if (mgr->device->is_enabled) {
					if (!mgr->device->is_enabled(mgr->device)) {
						if (mgr->device->enable)
							mgr->device->enable(mgr->device);
						mgr->set_layer_config(mgr, &g_fbi.config[sel],
								      1);
						disp_delay_ms(20);
					}
				}
			}
		}
	}
	return 0;
}
```

```c
s32 disp_lcd_is_enabled(struct disp_device *lcd)
{
	struct disp_lcd_private_data *lcdp = disp_lcd_get_priv(lcd);

	if ((lcd == NULL) || (lcdp == NULL)) {
		DE_WRN("NULL hdl!\n");
		return DIS_FAIL;
	}

	return (s32)lcdp->enabled;
}
```

```plaintext
时间点  | 事件 | lcdp->enabled 状态 | 硬件状态
--------|------|-------------------|----------
T0      | Uboot完成初始化 | (未初始化) | ✅ 正常工作
T1      | disp_init开始 | 0 | ✅ 正常工作
T2      | bsp_disp_init完成 | 0 | ✅ 正常工作
T3      | fb_init调用 | 0 | ✅ 正常工作
T4      | register_framebuffer | 0 | ✅ 正常工作
T5 ⚠️   | fbcon_init->fb_open | 0 ❌ | ✅ 正常工作
        | └─ is_enabled返回0  |   |
        | └─ 调用enable()重新初始化硬件 | | ❌ 被重置
T6      | start_work延迟执行 | 0 | ❌ 被破坏
T7      | bsp_disp_sync_with_hw | 1 (太晚了) | ❌ 已损坏
```

```c
   schedule_work(&g_disp_drv.start_work);
```

```plaintext
   fb_init()
     ├─ register_framebuffer()  <- 同步执行
     │   └─ fbcon -> fb_open()
     │       └─ is_enabled() 返回 0  ⚠️ lcdp->enabled未设置
     │           └─ enable()  <- 重新初始化硬件
     │
     └─ start_process()  <- 调度异步工作
         └─ (延迟执行)
             └─ bsp_disp_sync_with_hw()
                 └─ sw_enable()  <- 设置lcdp->enabled = 1
                     (但硬件已被破坏)
```

```c
	if ((para->boot_info.sync == 1)
	    && (disp == para->boot_info.disp)
	    && (para->boot_info.type == DISP_OUTPUT_TYPE_LCD)) {
		/* connect device & it's manager */
		dispdev = disp_device_get(disp, DISP_OUTPUT_TYPE_LCD);
		if ((dispdev) && (dispdev->set_manager)) {
			dispdev->set_manager(dispdev, mgr);
		} else {
			for (i = 0; i < num_screens; i++) {
				dispdev =
				    disp_device_get(i,
						DISP_OUTPUT_TYPE_LCD);
				if ((dispdev)
				    && (dispdev->set_manager)) {
					dispdev->set_manager(dispdev,
							     mgr);
					break;
				}
			}
		}
	} else if (para->boot_info.sync == 0) {
		dispdev = disp_device_get(disp, DISP_OUTPUT_TYPE_LCD);
		if ((dispdev) && (dispdev->set_manager))
			dispdev->set_manager(dispdev, mgr);
		mgr->enable_iommu(mgr, true);
	}
```

```c
if ((para->boot_info.sync == 1)
    && (disp == para->boot_info.disp)
    && (para->boot_info.type == DISP_OUTPUT_TYPE_LCD)) {
	/* connect device & it's manager */
	dispdev = disp_device_get(disp, DISP_OUTPUT_TYPE_LCD);
	if ((dispdev) && (dispdev->set_manager)) {
		dispdev->set_manager(dispdev, mgr);
		// ✅ 立即同步设置软件状态
		if (dispdev->sw_enable) {
			dispdev->sw_enable(dispdev);
		}
	}
	// ... 其他逻辑
}
```

---

**User**

请你帮我解释一下真正初始化并启用设备的主要流程，以及mgr->device->enable(mgr->device);都干了什么

---

**Cursor**

我来为您详细解释设备真正初始化并启用的主要流程，以及 `enable()` 函数的具体工作。

好的，现在我可以为您详细解释完整的设备初始化和启用流程了。

## 一、完整的设备初始化并启用流程

### 📋 整体架构图

```
驱动加载阶段
    ├─ disp_probe()
    │   └─ disp_init()
    │       ├─ 解析设备树参数
    │       ├─ bsp_disp_init() - BSP层初始化
    │       │   └─ disp_init_feat() - 连接manager和device
    │       ├─ lcd_init() - LCD设备初始化  
    │       └─ fb_init() - Framebuffer初始化
    │           └─ display_fb_request()
    │               └─ Fb_map_kernel_logo() - 拷贝logo
    │
    └─ start_work() - 异步工作队列
        └─ bsp_disp_sync_with_hw()
            └─ sw_enable() - 软件状态同步
```

### 🔧 详细流程分解

#### **阶段1: 驱动初始化 (disp_init)**

```2256:2375:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/dev_disp.c
static s32 disp_init(struct platform_device *pdev)
{
	struct disp_bsp_init_para *para;
	int i, disp, num_screens;
	unsigned int value, value1, value2, output_type, output_mode;
	unsigned int output_format, output_bits, output_eotf, output_cs;

	__inf("%s !\n", __func__);

	INIT_WORK(&g_disp_drv.resume_work[0], resume_work_0);
#if DISP_SCREEN_NUM > 1
	INIT_WORK(&g_disp_drv.resume_work[1], resume_work_1);
#endif
	/* INIT_WORK(&g_disp_drv.resume_work[2], resume_work_2); */
	INIT_WORK(&g_disp_drv.start_work, start_work);
	INIT_LIST_HEAD(&g_disp_drv.sync_proc_list.list);
	INIT_LIST_HEAD(&g_disp_drv.sync_finish_proc_list.list);
	INIT_LIST_HEAD(&g_disp_drv.ioctl_extend_list.list);
	INIT_LIST_HEAD(&g_disp_drv.compat_ioctl_extend_list.list);
	INIT_LIST_HEAD(&g_disp_drv.stb_cb_list.list);
	mutex_init(&g_disp_drv.mlock);
	spin_lock_init(&sync_finish_lock);
	parser_disp_init_para(pdev->dev.of_node, &g_disp_drv.disp_init);
	para = &g_disp_drv.para;

	memset(para, 0, sizeof(struct disp_bsp_init_para));
	for (i = 0; i < DISP_MOD_NUM; i++) {
		para->reg_base[i] = g_disp_drv.reg_base[i];
		para->irq_no[i] = g_disp_drv.irq_no[i];
		para->mclk[i] = g_disp_drv.mclk[i];
		__inf("mod %d, base=0x%lx, irq=%d, mclk=0x%p\n", i,
		      para->reg_base[i], para->irq_no[i], para->mclk[i]);
	}

	para->disp_int_process = disp_sync_finish_process;
	para->vsync_event = drv_disp_vsync_event;
	para->start_process = start_process;

	value = disp_boot_para_parse("boot_disp");
	value1 = disp_boot_para_parse("boot_disp1");
	value2 = disp_boot_para_parse("boot_disp2");
	output_type = (value >> 8) & 0xff;
	output_mode = (value) & 0xff;

	output_format = (value1 >> 0) & 0xff;
	output_bits = (value1 >> 8) & 0xff;
	output_cs = (value1 >> 16) & 0xffff;
	output_eotf = (value2 >> 0) & 0xff;

	if (output_type != (int)DISP_OUTPUT_TYPE_NONE) {
		para->boot_info.sync = 1;
		para->boot_info.disp = 0;	/* disp0 */
		para->boot_info.type = output_type;
		para->boot_info.mode = output_mode;
		para->boot_info.format = output_format;
		para->boot_info.bits = output_bits;
		para->boot_info.cs = output_cs;
		para->boot_info.eotf = output_eotf;
	} else {
		output_type = (value >> 24) & 0xff;
		output_mode = (value >> 16) & 0xff;
		if (output_type != (int)DISP_OUTPUT_TYPE_NONE) {
			para->boot_info.sync = 1;
			para->boot_info.disp = 1;	/* disp1 */
			para->boot_info.type = output_type;
			para->boot_info.mode = output_mode;
			para->boot_info.format = output_format;
			para->boot_info.bits = output_bits;
			para->boot_info.cs = output_cs;
			para->boot_info.eotf = output_eotf;
		}
	}

	para->boot_info.dvi_hdmi =
		g_disp_drv.disp_init.output_dvi_hdmi[para->boot_info.disp];
	para->boot_info.range =
		g_disp_drv.disp_init.output_range[para->boot_info.disp];
	para->boot_info.scan =
		g_disp_drv.disp_init.output_scan[para->boot_info.disp];
	para->boot_info.aspect_ratio =
		g_disp_drv.disp_init.output_aspect_ratio[para->boot_info.disp];

	if (para->boot_info.sync == 1) {
		__wrn("smooth display screen:%d type:%d mode:%d\n", para->boot_info.disp,
		      para->boot_info.type, para->boot_info.mode);
		g_disp_drv.disp_init.disp_mode = para->boot_info.disp;
		g_disp_drv.disp_init.output_type[para->boot_info.disp] =
		    output_type;
		g_disp_drv.disp_init.output_mode[para->boot_info.disp] =
							output_mode;
		g_disp_drv.disp_init.output_format[para->boot_info.disp] =
							output_format;
		g_disp_drv.disp_init.output_bits[para->boot_info.disp] =
							output_bits;
		g_disp_drv.disp_init.output_cs[para->boot_info.disp] =
							output_cs;
		g_disp_drv.disp_init.output_eotf[para->boot_info.disp] =
							output_eotf;
	}

	para->feat_init.chn_cfg_mode = g_disp_drv.disp_init.chn_cfg_mode;

	bsp_disp_init(para);

#if defined(CONFIG_SUNXI_DISP2_PQ)
	pq_init(para);
#endif

	/*if (bsp_disp_check_device_enabled(para) == 0)
		para->boot_info.sync = 0;
	*/
	num_screens = bsp_disp_feat_get_num_screens();
	for (disp = 0; disp < num_screens; disp++)
		g_disp_drv.mgr[disp] = disp_get_layer_manager(disp);
#if defined(SUPPORT_EINK)
	g_disp_drv.eink_manager[0] = disp_get_eink_manager(0);
#endif
	lcd_init();
	bsp_disp_open();

	fb_init(pdev);
```

关键步骤：
1. **第2306行**：解析uboot传递的参数，设置 `boot_info.sync = 1`（表示需要seamless显示）
2. **第2358行**：调用 `bsp_disp_init()` - 初始化BSP层
3. **第2373行**：调用 `lcd_init()` - 初始化LCD设备对象
4. **第2375行**：调用 `fb_init()` - 初始化framebuffer

#### **阶段2: LCD设备对象初始化 (lcd_init)**

在这个阶段，创建LCD设备对象并设置函数指针：

```3140:3148:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/de/disp_lcd.c
	lcd->unset_manager = disp_device_unset_manager;
	lcd->get_resolution = disp_device_get_resolution;
	lcd->get_timings = disp_device_get_timings;
	lcd->enable = disp_lcd_enable;
	lcd->sw_enable = disp_lcd_sw_enable;
	lcd->fake_enable = disp_lcd_fake_enable;
	lcd->disable = disp_lcd_disable;
	lcd->is_enabled = disp_lcd_is_enabled;
	lcd->check_if_enabled = disp_lcd_check_if_enabled;
```

注意：
- `lcd->enable` 指向 `disp_lcd_enable` - 完整的硬件初始化
- `lcd->sw_enable` 指向 `disp_lcd_sw_enable` - 仅软件状态同步
- `lcd->is_enabled` 指向 `disp_lcd_is_enabled` - 检查 `lcdp->enabled` 标志

## 二、mgr->device->enable(mgr->device) 详细分析

这个函数实际上调用的是 `disp_lcd_enable()`，让我逐步解析：

```2003:2126:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/de/disp_lcd.c
static s32 disp_lcd_enable(struct disp_device *lcd)
{
	unsigned long flags;
	struct disp_lcd_private_data *lcdp = disp_lcd_get_priv(lcd);
	int i;
	struct disp_manager *mgr = NULL;
	unsigned bl;
	int ret = 0;

	if ((lcd == NULL) || (lcdp == NULL)) {
		DE_WRN("NULL hdl!\n");
		return DIS_FAIL;
	}

	if (!disp_lcd_is_used(lcd)) {
		return DIS_FAIL;
	}

	__inf("lcd %d\n", lcd->disp);
	mgr = lcd->manager;
	if (mgr == NULL) {
		DE_WRN("mgr is NULL!\n");
		return DIS_FAIL;
	}
	if (disp_lcd_is_enabled(lcd) == 1)
		return 0;

	disp_lcd_cal_fps(lcd);
	if (mgr->enable)
		mgr->enable(mgr);

	/* init fix power */
	for (i = 0; i < LCD_POWER_NUM; i++) {
		if (lcdp->lcd_cfg.lcd_fix_power_used[i] == 1)
			disp_sys_power_enable(lcdp->lcd_cfg.lcd_fix_power[i]);
	}

#if defined(SUPPORT_DSI) && defined(DSI_VERSION_40)
	if ((lcdp->panel_info.lcd_if == LCD_IF_DSI)
	    && (lcdp->irq_no_dsi != 0)) {
		if (lcdp->panel_info.lcd_dsi_if == LCD_DSI_IF_COMMAND_MODE) {
			disp_sys_register_irq(lcdp->irq_no, 0, disp_lcd_event_proc,
					      (void *)lcd, 0, 0);
			disp_sys_enable_irq(lcdp->irq_no);
		} else {
			disp_sys_register_irq(lcdp->irq_no_dsi, 0, disp_lcd_event_proc,
					      (void *)lcd, 0, 0);
			disp_sys_enable_irq(lcdp->irq_no_dsi);
		}
	} else
#endif
	{
		disp_sys_register_irq(lcdp->irq_no, 0, disp_lcd_event_proc,
				      (void *)lcd, 0, 0);
		disp_sys_enable_irq(lcdp->irq_no);
	}
	spin_lock_irqsave(&lcd_data_lock, flags);
	lcdp->enabling = 1;
	lcdp->bl_need_enabled = 0;
	spin_unlock_irqrestore(&lcd_data_lock, flags);

	lcdp->panel_extend_info.lcd_gamma_en = lcdp->panel_info.lcd_gamma_en;
	disp_lcd_gpio_init(lcd);
	ret = lcd_clk_enable(lcd);
	if (ret != 0)
		return DIS_FAIL;
	ret = cal_real_frame_period(lcd);
	if (ret)
		DE_WRN("cal_real_frame_period fail:%d\n", ret);

	if (lcdp->panel_info.lcd_pwm_used && !lcdp->pwm_info.dev)
		lcdp->pwm_info.dev =
			disp_sys_pwm_request(lcdp->panel_info.lcd_pwm_ch);

	disp_sys_pwm_config(lcdp->pwm_info.dev, lcdp->pwm_info.duty_ns,
			    lcdp->pwm_info.period_ns);
	disp_sys_pwm_set_polarity(lcdp->pwm_info.dev, lcdp->pwm_info.polarity);
	disp_check_timing_param(&lcdp->panel_info);
	disp_al_lcd_cfg(lcd->hwdev_index, &lcdp->panel_info,
		&lcdp->panel_extend_info_set);
	lcd_calc_judge_line(lcd);
	lcdp->open_flow.func_num = 0;
#if defined(CONFIG_DISP2_LCD_ESD_DETECT)
	if (lcdp->lcd_panel_fun.set_esd_info) {
		lcdp->lcd_panel_fun.set_esd_info(&lcdp->esd_inf);
	} else {
		/*default value*/
		lcdp->esd_inf.level = 0;
		lcdp->esd_inf.freq = 60;
		lcdp->esd_inf.esd_check_func_pos = 0;
		lcdp->esd_inf.cnt = 0;
	}
#endif
	if (lcdp->lcd_panel_fun.cfg_open_flow)
		lcdp->lcd_panel_fun.cfg_open_flow(lcd->disp);
	else
		DE_WRN("lcd_panel_fun[%d].cfg_open_flow is NULL\n", lcd->disp);

	if (lcdp->panel_info.lcd_gsensor_detect == 0)
		skip_open_backlight = 0;

	for (i = 0; i < lcdp->open_flow.func_num - skip_open_backlight; i++) {
		if (lcdp->open_flow.func[i].func) {
			lcdp->open_flow.func[i].func(lcd->disp);
			DE_INF("open flow:step %d finish, to delay %d\n", i,
			       lcdp->open_flow.func[i].delay);
			if (lcdp->open_flow.func[i].delay != 0)
				disp_delay_ms(lcdp->open_flow.func[i].delay);
		}
	}
	skip_open_backlight = 0; /*only skip one time*/

	spin_lock_irqsave(&lcd_data_lock, flags);
	lcdp->enabled = 1;
	lcdp->enabling = 0;
	spin_unlock_irqrestore(&lcd_data_lock, flags);
	bl = disp_lcd_get_bright(lcd);
	disp_lcd_set_bright(lcd, bl);
#if defined(CONFIG_DISP2_LCD_ESD_DETECT)
	atomic_set(&lcdp->lcd_resetting, 0);
#endif

	return 0;
}
```

### 🔍 enable() 函数的详细步骤

#### **步骤1: 前置检查 (第2027-2032行)**
```c
if (disp_lcd_is_enabled(lcd) == 1)
    return 0;  // 已经使能，直接返回

disp_lcd_cal_fps(lcd);
if (mgr->enable)
    mgr->enable(mgr);  // 使能Display Engine Manager
```

#### **步骤2: 电源初始化 (第2034-2038行)**
```c
/* init fix power */
for (i = 0; i < LCD_POWER_NUM; i++) {
    if (lcdp->lcd_cfg.lcd_fix_power_used[i] == 1)
        disp_sys_power_enable(lcdp->lcd_cfg.lcd_fix_power[i]);
}
```
打开LCD的固定电源轨（如VCC、VDD等）

#### **步骤3: 注册和使能中断 (第2040-2058行)**
```c
disp_sys_register_irq(lcdp->irq_no, 0, disp_lcd_event_proc,
              (void *)lcd, 0, 0);
disp_sys_enable_irq(lcdp->irq_no);
```
注册LCD的vsync中断处理函数

#### **步骤4: GPIO初始化 (第2065行)**

```2461:2493:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/de/disp_lcd.c
s32 disp_lcd_gpio_init(struct disp_device *lcd)
{
	struct disp_lcd_private_data *lcdp = disp_lcd_get_priv(lcd);
	int i = 0;

	if ((lcd == NULL) || (lcdp == NULL)) {
		DE_WRN("NULL hdl!\n");
		return DIS_FAIL;
	}

	/* io-pad */
	for (i = 0; i < LCD_GPIO_REGU_NUM; i++) {
		if (!
		    ((!strcmp(lcdp->lcd_cfg.lcd_gpio_power[i], ""))
		     || (!strcmp(lcdp->lcd_cfg.lcd_gpio_power[i], "none"))))
			disp_sys_power_enable(lcdp->lcd_cfg.lcd_gpio_power[i]);
	}

	for (i = 0; i < LCD_GPIO_NUM; i++) {
		lcdp->lcd_cfg.gpio_hdl[i] = 0;

		if (lcdp->lcd_cfg.lcd_gpio_used[i]) {
			struct disp_gpio_set_t gpio_info[1];

			memcpy(gpio_info, &(lcdp->lcd_cfg.lcd_gpio[i]),
			       sizeof(struct disp_gpio_set_t));
			lcdp->lcd_cfg.gpio_hdl[i] =
			    disp_sys_gpio_request(gpio_info, 1);
		}
	}

	return 0;
}
```
初始化LCD所需的GPIO（如复位GPIO、使能GPIO等）

#### **步骤5: 时钟使能 (第2066行)**

```717:781:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/de/disp_lcd.c
static s32 lcd_clk_enable(struct disp_device *lcd)
{
	struct disp_lcd_private_data *lcdp = disp_lcd_get_priv(lcd);
	int ret = 0;
	u32 i = 0, j = 0;
	u32 dsi_num = 0;

	if ((lcd == NULL) || (lcdp == NULL)) {
		DE_WRN("NULL hdl!\n");
		return -1;
	}
	lcd_clk_config(lcd);
	if (!__clk_get_enable_count(lcdp->clk)) {
		ret = clk_prepare_enable(lcdp->clk);
		if (ret != 0) {
			DE_WRN("fail enable lcd's clock!\n");
			goto exit;
		}
	}

	if (lcdp->panel_info.lcd_if == LCD_IF_LVDS) {
		if (lcdp->lvds_clk)
			ret = clk_prepare_enable(lcdp->lvds_clk);
		if (ret != 0) {
			DE_WRN("fail enable lvds's clock!\n");
			goto exit;
		}
#ifdef SUPPORT_COMBO_DPHY
		if (lcd->hwdev_index == 0)
			clk_prepare_enable(lcdp->dsi_clk[0]);
#endif
	} else if (lcdp->panel_info.lcd_if == LCD_IF_DSI) {
		dsi_num = (lcdp->panel_info.lcd_tcon_mode == DISP_TCON_DUAL_DSI)
			      ? 2
			      : 1;
		/*the num of dsi clk to use for current disp*/
		dsi_num *= CLK_NUM_PER_DSI;

		for (i = dsi_num * lcd->disp, j = 0; i < CLK_DSI_NUM; ++i) {
			if (lcdp->dsi_clk[i]) {
				ret = clk_prepare_enable(lcdp->dsi_clk[i]);
				if (ret != 0) {
					DE_WRN("fail enable dsi's clock%d!\n",
					       i);
					goto exit;
				}
				++j;
			} else {
				DE_WRN("dsi's clock%d is NULL!\n", i);
				goto exit;
			}
			if (j == dsi_num)
				break;
		}
	} else if (lcdp->panel_info.lcd_if == LCD_IF_EDP) {
		ret = clk_prepare_enable(lcdp->edp_clk);
		if (ret != 0) {
			DE_WRN("fail enable edp's clock!\n");
			goto exit;
		}
	}

exit:
	return ret;
}
```
使能LCD时钟、MIPI DSI时钟等

#### **步骤6: PWM配置 (第2073-2079行)**
```c
if (lcdp->panel_info.lcd_pwm_used && !lcdp->pwm_info.dev)
    lcdp->pwm_info.dev =
        disp_sys_pwm_request(lcdp->panel_info.lcd_pwm_ch);

disp_sys_pwm_config(lcdp->pwm_info.dev, lcdp->pwm_info.duty_ns,
            lcdp->pwm_info.period_ns);
disp_sys_pwm_set_polarity(lcdp->pwm_info.dev, lcdp->pwm_info.polarity);
```
配置背光PWM

#### **步骤7: TCON配置 (第2081-2082行)**
```c
disp_check_timing_param(&lcdp->panel_info);
disp_al_lcd_cfg(lcd->hwdev_index, &lcdp->panel_info,
    &lcdp->panel_extend_info_set);
```
配置LCD时序控制器（TCON）寄存器，设置：
- 时钟分频
- 行列时序
- 同步信号极性
- RGB接口/MIPI DSI接口配置

#### **步骤8: Panel Open Flow执行 (第2096-2112行)**

这是**最关键的部分**，执行Panel驱动定义的开启流程：

```c
if (lcdp->lcd_panel_fun.cfg_open_flow)
    lcdp->lcd_panel_fun.cfg_open_flow(lcd->disp);

for (i = 0; i < lcdp->open_flow.func_num - skip_open_backlight; i++) {
    if (lcdp->open_flow.func[i].func) {
        lcdp->open_flow.func[i].func(lcd->disp);
        DE_INF("open flow:step %d finish, to delay %d\n", i,
               lcdp->open_flow.func[i].delay);
        if (lcdp->open_flow.func[i].delay != 0)
            disp_delay_ms(lcdp->open_flow.func[i].delay);
    }
}
```

### 🎬 Open Flow 机制详解

Panel驱动通过 `LCD_OPEN_FUNC` 宏定义开启流程，例如：

```c
// 典型的Panel驱动open flow定义
static s32 lcd_open_flow(u32 sel)
{
    LCD_OPEN_FUNC(sel, lcd_power_on, 10);        // 步骤1: 上电，延迟10ms
    LCD_OPEN_FUNC(sel, lcd_panel_init, 10);      // 步骤2: 初始化序列，延迟10ms  
    LCD_OPEN_FUNC(sel, sunxi_lcd_tcon_enable, 50); // 步骤3: 使能TCON，延迟50ms
    LCD_OPEN_FUNC(sel, lcd_bl_open, 0);          // 步骤4: 打开背光，无延迟
    return 0;
}
```

`LCD_OPEN_FUNC` 的实现：

```1592:1600:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/de/disp_display.c
void LCD_OPEN_FUNC(u32 disp, LCD_FUNC func, u32 delay)
{
	struct disp_device *lcd;

	lcd = disp_get_lcd(disp);

	if (lcd && lcd->set_open_func)
		lcd->set_open_func(lcd, func, delay);
}
```

每个步骤的典型内容：

1. **lcd_power_on**: 打开LCD电源（VCC、VLED等）
2. **lcd_panel_init**: 发送初始化命令序列（通过MIPI DSI或SPI）
3. **sunxi_lcd_tcon_enable**: 使能TCON输出
4. **lcd_bl_open**: 打开背光

#### **步骤9: 设置使能标志 (第2115-2118行)**
```c
spin_lock_irqsave(&lcd_data_lock, flags);
lcdp->enabled = 1;        // ✅ 设置使能标志
lcdp->enabling = 0;
spin_unlock_irqrestore(&lcd_data_lock, flags);
```

#### **步骤10: 设置背光亮度 (第2119-2120行)**
```c
bl = disp_lcd_get_bright(lcd);
disp_lcd_set_bright(lcd, bl);
```

## 三、为什么启用fbcon后会出问题

### 问题关键点

1. **`lcdp->enabled` 标志的设置时机**：
   - 在 `disp_lcd_enable()` 的**第2116行**才设置为1
   - 但 `sunxi_fb_open()` 在 **register_framebuffer** 时就被调用了

2. **时序图**：

```
时间轴：
T0: disp_init() 开始
T1: bsp_disp_init() 完成 (lcdp->enabled = 0)
T2: lcd_init() 完成 (lcdp->enabled = 0)
T3: fb_init() -> register_framebuffer()
T4: ├─ fbcon_init() 同步触发
    └─ sunxi_fb_open() 
        └─ is_enabled() 返回 0 ❌
            └─ enable() 被调用 ⚠️ 重新初始化硬件
                ├─ 重置TCON
                ├─ 重新配置时钟
                ├─ 重新注册中断
                └─ vsync中断被打断
T5: start_work() 异步执行
    └─ bsp_disp_sync_with_hw()
        └─ sw_enable() (lcdp->enabled = 1, 但为时已晚)
```

3. **冲突后果**：
   - `enable()` 重新初始化硬件，导致vsync中断链被打断
   - `fb_free_reserve_mem` 等待vsync超时
   - 屏幕显示异常

### 解决方案总结

最佳方案是在 `disp_init_feat()` 阶段（连接manager和device时），如果检测到 `boot_info.sync == 1`，立即同步调用 `sw_enable()` 设置软件状态，确保 `lcdp->enabled = 1`，避免后续的 `sunxi_fb_open()` 误判导致重复初始化。

希望这个详细的解释能帮助您理解整个流程！

```plaintext
驱动加载阶段
    ├─ disp_probe()
    │   └─ disp_init()
    │       ├─ 解析设备树参数
    │       ├─ bsp_disp_init() - BSP层初始化
    │       │   └─ disp_init_feat() - 连接manager和device
    │       ├─ lcd_init() - LCD设备初始化  
    │       └─ fb_init() - Framebuffer初始化
    │           └─ display_fb_request()
    │               └─ Fb_map_kernel_logo() - 拷贝logo
    │
    └─ start_work() - 异步工作队列
        └─ bsp_disp_sync_with_hw()
            └─ sw_enable() - 软件状态同步
```

```c
static s32 disp_init(struct platform_device *pdev)
{
	struct disp_bsp_init_para *para;
	int i, disp, num_screens;
	unsigned int value, value1, value2, output_type, output_mode;
	unsigned int output_format, output_bits, output_eotf, output_cs;

	__inf("%s !\n", __func__);

	INIT_WORK(&g_disp_drv.resume_work[0], resume_work_0);
#if DISP_SCREEN_NUM > 1
	INIT_WORK(&g_disp_drv.resume_work[1], resume_work_1);
#endif
	/* INIT_WORK(&g_disp_drv.resume_work[2], resume_work_2); */
	INIT_WORK(&g_disp_drv.start_work, start_work);
	INIT_LIST_HEAD(&g_disp_drv.sync_proc_list.list);
	INIT_LIST_HEAD(&g_disp_drv.sync_finish_proc_list.list);
	INIT_LIST_HEAD(&g_disp_drv.ioctl_extend_list.list);
	INIT_LIST_HEAD(&g_disp_drv.compat_ioctl_extend_list.list);
	INIT_LIST_HEAD(&g_disp_drv.stb_cb_list.list);
	mutex_init(&g_disp_drv.mlock);
	spin_lock_init(&sync_finish_lock);
	parser_disp_init_para(pdev->dev.of_node, &g_disp_drv.disp_init);
	para = &g_disp_drv.para;

	memset(para, 0, sizeof(struct disp_bsp_init_para));
	for (i = 0; i < DISP_MOD_NUM; i++) {
		para->reg_base[i] = g_disp_drv.reg_base[i];
		para->irq_no[i] = g_disp_drv.irq_no[i];
		para->mclk[i] = g_disp_drv.mclk[i];
		__inf("mod %d, base=0x%lx, irq=%d, mclk=0x%p\n", i,
		      para->reg_base[i], para->irq_no[i], para->mclk[i]);
	}

	para->disp_int_process = disp_sync_finish_process;
	para->vsync_event = drv_disp_vsync_event;
	para->start_process = start_process;

	value = disp_boot_para_parse("boot_disp");
	value1 = disp_boot_para_parse("boot_disp1");
	value2 = disp_boot_para_parse("boot_disp2");
	output_type = (value >> 8) & 0xff;
	output_mode = (value) & 0xff;

	output_format = (value1 >> 0) & 0xff;
	output_bits = (value1 >> 8) & 0xff;
	output_cs = (value1 >> 16) & 0xffff;
	output_eotf = (value2 >> 0) & 0xff;

	if (output_type != (int)DISP_OUTPUT_TYPE_NONE) {
		para->boot_info.sync = 1;
		para->boot_info.disp = 0;	/* disp0 */
		para->boot_info.type = output_type;
		para->boot_info.mode = output_mode;
		para->boot_info.format = output_format;
		para->boot_info.bits = output_bits;
		para->boot_info.cs = output_cs;
		para->boot_info.eotf = output_eotf;
	} else {
		output_type = (value >> 24) & 0xff;
		output_mode = (value >> 16) & 0xff;
		if (output_type != (int)DISP_OUTPUT_TYPE_NONE) {
			para->boot_info.sync = 1;
			para->boot_info.disp = 1;	/* disp1 */
			para->boot_info.type = output_type;
			para->boot_info.mode = output_mode;
			para->boot_info.format = output_format;
			para->boot_info.bits = output_bits;
			para->boot_info.cs = output_cs;
			para->boot_info.eotf = output_eotf;
		}
	}

	para->boot_info.dvi_hdmi =
		g_disp_drv.disp_init.output_dvi_hdmi[para->boot_info.disp];
	para->boot_info.range =
		g_disp_drv.disp_init.output_range[para->boot_info.disp];
	para->boot_info.scan =
		g_disp_drv.disp_init.output_scan[para->boot_info.disp];
	para->boot_info.aspect_ratio =
		g_disp_drv.disp_init.output_aspect_ratio[para->boot_info.disp];

	if (para->boot_info.sync == 1) {
		__wrn("smooth display screen:%d type:%d mode:%d\n", para->boot_info.disp,
		      para->boot_info.type, para->boot_info.mode);
		g_disp_drv.disp_init.disp_mode = para->boot_info.disp;
		g_disp_drv.disp_init.output_type[para->boot_info.disp] =
		    output_type;
		g_disp_drv.disp_init.output_mode[para->boot_info.disp] =
							output_mode;
		g_disp_drv.disp_init.output_format[para->boot_info.disp] =
							output_format;
		g_disp_drv.disp_init.output_bits[para->boot_info.disp] =
							output_bits;
		g_disp_drv.disp_init.output_cs[para->boot_info.disp] =
							output_cs;
		g_disp_drv.disp_init.output_eotf[para->boot_info.disp] =
							output_eotf;
	}

	para->feat_init.chn_cfg_mode = g_disp_drv.disp_init.chn_cfg_mode;

	bsp_disp_init(para);

#if defined(CONFIG_SUNXI_DISP2_PQ)
	pq_init(para);
#endif

	/*if (bsp_disp_check_device_enabled(para) == 0)
		para->boot_info.sync = 0;
	*/
	num_screens = bsp_disp_feat_get_num_screens();
	for (disp = 0; disp < num_screens; disp++)
		g_disp_drv.mgr[disp] = disp_get_layer_manager(disp);
#if defined(SUPPORT_EINK)
	g_disp_drv.eink_manager[0] = disp_get_eink_manager(0);
#endif
	lcd_init();
	bsp_disp_open();

	fb_init(pdev);
```

```c
	lcd->unset_manager = disp_device_unset_manager;
	lcd->get_resolution = disp_device_get_resolution;
	lcd->get_timings = disp_device_get_timings;
	lcd->enable = disp_lcd_enable;
	lcd->sw_enable = disp_lcd_sw_enable;
	lcd->fake_enable = disp_lcd_fake_enable;
	lcd->disable = disp_lcd_disable;
	lcd->is_enabled = disp_lcd_is_enabled;
	lcd->check_if_enabled = disp_lcd_check_if_enabled;
```

```c
static s32 disp_lcd_enable(struct disp_device *lcd)
{
	unsigned long flags;
	struct disp_lcd_private_data *lcdp = disp_lcd_get_priv(lcd);
	int i;
	struct disp_manager *mgr = NULL;
	unsigned bl;
	int ret = 0;

	if ((lcd == NULL) || (lcdp == NULL)) {
		DE_WRN("NULL hdl!\n");
		return DIS_FAIL;
	}

	if (!disp_lcd_is_used(lcd)) {
		return DIS_FAIL;
	}

	__inf("lcd %d\n", lcd->disp);
	mgr = lcd->manager;
	if (mgr == NULL) {
		DE_WRN("mgr is NULL!\n");
		return DIS_FAIL;
	}
	if (disp_lcd_is_enabled(lcd) == 1)
		return 0;

	disp_lcd_cal_fps(lcd);
	if (mgr->enable)
		mgr->enable(mgr);

	/* init fix power */
	for (i = 0; i < LCD_POWER_NUM; i++) {
		if (lcdp->lcd_cfg.lcd_fix_power_used[i] == 1)
			disp_sys_power_enable(lcdp->lcd_cfg.lcd_fix_power[i]);
	}

#if defined(SUPPORT_DSI) && defined(DSI_VERSION_40)
	if ((lcdp->panel_info.lcd_if == LCD_IF_DSI)
	    && (lcdp->irq_no_dsi != 0)) {
		if (lcdp->panel_info.lcd_dsi_if == LCD_DSI_IF_COMMAND_MODE) {
			disp_sys_register_irq(lcdp->irq_no, 0, disp_lcd_event_proc,
					      (void *)lcd, 0, 0);
			disp_sys_enable_irq(lcdp->irq_no);
		} else {
			disp_sys_register_irq(lcdp->irq_no_dsi, 0, disp_lcd_event_proc,
					      (void *)lcd, 0, 0);
			disp_sys_enable_irq(lcdp->irq_no_dsi);
		}
	} else
#endif
	{
		disp_sys_register_irq(lcdp->irq_no, 0, disp_lcd_event_proc,
				      (void *)lcd, 0, 0);
		disp_sys_enable_irq(lcdp->irq_no);
	}
	spin_lock_irqsave(&lcd_data_lock, flags);
	lcdp->enabling = 1;
	lcdp->bl_need_enabled = 0;
	spin_unlock_irqrestore(&lcd_data_lock, flags);

	lcdp->panel_extend_info.lcd_gamma_en = lcdp->panel_info.lcd_gamma_en;
	disp_lcd_gpio_init(lcd);
	ret = lcd_clk_enable(lcd);
	if (ret != 0)
		return DIS_FAIL;
	ret = cal_real_frame_period(lcd);
	if (ret)
		DE_WRN("cal_real_frame_period fail:%d\n", ret);

	if (lcdp->panel_info.lcd_pwm_used && !lcdp->pwm_info.dev)
		lcdp->pwm_info.dev =
			disp_sys_pwm_request(lcdp->panel_info.lcd_pwm_ch);

	disp_sys_pwm_config(lcdp->pwm_info.dev, lcdp->pwm_info.duty_ns,
			    lcdp->pwm_info.period_ns);
	disp_sys_pwm_set_polarity(lcdp->pwm_info.dev, lcdp->pwm_info.polarity);
	disp_check_timing_param(&lcdp->panel_info);
	disp_al_lcd_cfg(lcd->hwdev_index, &lcdp->panel_info,
		&lcdp->panel_extend_info_set);
	lcd_calc_judge_line(lcd);
	lcdp->open_flow.func_num = 0;
#if defined(CONFIG_DISP2_LCD_ESD_DETECT)
	if (lcdp->lcd_panel_fun.set_esd_info) {
		lcdp->lcd_panel_fun.set_esd_info(&lcdp->esd_inf);
	} else {
		/*default value*/
		lcdp->esd_inf.level = 0;
		lcdp->esd_inf.freq = 60;
		lcdp->esd_inf.esd_check_func_pos = 0;
		lcdp->esd_inf.cnt = 0;
	}
#endif
	if (lcdp->lcd_panel_fun.cfg_open_flow)
		lcdp->lcd_panel_fun.cfg_open_flow(lcd->disp);
	else
		DE_WRN("lcd_panel_fun[%d].cfg_open_flow is NULL\n", lcd->disp);

	if (lcdp->panel_info.lcd_gsensor_detect == 0)
		skip_open_backlight = 0;

	for (i = 0; i < lcdp->open_flow.func_num - skip_open_backlight; i++) {
		if (lcdp->open_flow.func[i].func) {
			lcdp->open_flow.func[i].func(lcd->disp);
			DE_INF("open flow:step %d finish, to delay %d\n", i,
			       lcdp->open_flow.func[i].delay);
			if (lcdp->open_flow.func[i].delay != 0)
				disp_delay_ms(lcdp->open_flow.func[i].delay);
		}
	}
	skip_open_backlight = 0; /*only skip one time*/

	spin_lock_irqsave(&lcd_data_lock, flags);
	lcdp->enabled = 1;
	lcdp->enabling = 0;
	spin_unlock_irqrestore(&lcd_data_lock, flags);
	bl = disp_lcd_get_bright(lcd);
	disp_lcd_set_bright(lcd, bl);
#if defined(CONFIG_DISP2_LCD_ESD_DETECT)
	atomic_set(&lcdp->lcd_resetting, 0);
#endif

	return 0;
}
```

```c
if (disp_lcd_is_enabled(lcd) == 1)
    return 0;  // 已经使能，直接返回

disp_lcd_cal_fps(lcd);
if (mgr->enable)
    mgr->enable(mgr);  // 使能Display Engine Manager
```

```c
/* init fix power */
for (i = 0; i < LCD_POWER_NUM; i++) {
    if (lcdp->lcd_cfg.lcd_fix_power_used[i] == 1)
        disp_sys_power_enable(lcdp->lcd_cfg.lcd_fix_power[i]);
}
```

```c
disp_sys_register_irq(lcdp->irq_no, 0, disp_lcd_event_proc,
              (void *)lcd, 0, 0);
disp_sys_enable_irq(lcdp->irq_no);
```

```c
s32 disp_lcd_gpio_init(struct disp_device *lcd)
{
	struct disp_lcd_private_data *lcdp = disp_lcd_get_priv(lcd);
	int i = 0;

	if ((lcd == NULL) || (lcdp == NULL)) {
		DE_WRN("NULL hdl!\n");
		return DIS_FAIL;
	}

	/* io-pad */
	for (i = 0; i < LCD_GPIO_REGU_NUM; i++) {
		if (!
		    ((!strcmp(lcdp->lcd_cfg.lcd_gpio_power[i], ""))
		     || (!strcmp(lcdp->lcd_cfg.lcd_gpio_power[i], "none"))))
			disp_sys_power_enable(lcdp->lcd_cfg.lcd_gpio_power[i]);
	}

	for (i = 0; i < LCD_GPIO_NUM; i++) {
		lcdp->lcd_cfg.gpio_hdl[i] = 0;

		if (lcdp->lcd_cfg.lcd_gpio_used[i]) {
			struct disp_gpio_set_t gpio_info[1];

			memcpy(gpio_info, &(lcdp->lcd_cfg.lcd_gpio[i]),
			       sizeof(struct disp_gpio_set_t));
			lcdp->lcd_cfg.gpio_hdl[i] =
			    disp_sys_gpio_request(gpio_info, 1);
		}
	}

	return 0;
}
```

```c
static s32 lcd_clk_enable(struct disp_device *lcd)
{
	struct disp_lcd_private_data *lcdp = disp_lcd_get_priv(lcd);
	int ret = 0;
	u32 i = 0, j = 0;
	u32 dsi_num = 0;

	if ((lcd == NULL) || (lcdp == NULL)) {
		DE_WRN("NULL hdl!\n");
		return -1;
	}
	lcd_clk_config(lcd);
	if (!__clk_get_enable_count(lcdp->clk)) {
		ret = clk_prepare_enable(lcdp->clk);
		if (ret != 0) {
			DE_WRN("fail enable lcd's clock!\n");
			goto exit;
		}
	}

	if (lcdp->panel_info.lcd_if == LCD_IF_LVDS) {
		if (lcdp->lvds_clk)
			ret = clk_prepare_enable(lcdp->lvds_clk);
		if (ret != 0) {
			DE_WRN("fail enable lvds's clock!\n");
			goto exit;
		}
#ifdef SUPPORT_COMBO_DPHY
		if (lcd->hwdev_index == 0)
			clk_prepare_enable(lcdp->dsi_clk[0]);
#endif
	} else if (lcdp->panel_info.lcd_if == LCD_IF_DSI) {
		dsi_num = (lcdp->panel_info.lcd_tcon_mode == DISP_TCON_DUAL_DSI)
			      ? 2
			      : 1;
		/*the num of dsi clk to use for current disp*/
		dsi_num *= CLK_NUM_PER_DSI;

		for (i = dsi_num * lcd->disp, j = 0; i < CLK_DSI_NUM; ++i) {
			if (lcdp->dsi_clk[i]) {
				ret = clk_prepare_enable(lcdp->dsi_clk[i]);
				if (ret != 0) {
					DE_WRN("fail enable dsi's clock%d!\n",
					       i);
					goto exit;
				}
				++j;
			} else {
				DE_WRN("dsi's clock%d is NULL!\n", i);
				goto exit;
			}
			if (j == dsi_num)
				break;
		}
	} else if (lcdp->panel_info.lcd_if == LCD_IF_EDP) {
		ret = clk_prepare_enable(lcdp->edp_clk);
		if (ret != 0) {
			DE_WRN("fail enable edp's clock!\n");
			goto exit;
		}
	}

exit:
	return ret;
}
```

```c
if (lcdp->panel_info.lcd_pwm_used && !lcdp->pwm_info.dev)
    lcdp->pwm_info.dev =
        disp_sys_pwm_request(lcdp->panel_info.lcd_pwm_ch);

disp_sys_pwm_config(lcdp->pwm_info.dev, lcdp->pwm_info.duty_ns,
            lcdp->pwm_info.period_ns);
disp_sys_pwm_set_polarity(lcdp->pwm_info.dev, lcdp->pwm_info.polarity);
```

```c
disp_check_timing_param(&lcdp->panel_info);
disp_al_lcd_cfg(lcd->hwdev_index, &lcdp->panel_info,
    &lcdp->panel_extend_info_set);
```

```c
if (lcdp->lcd_panel_fun.cfg_open_flow)
    lcdp->lcd_panel_fun.cfg_open_flow(lcd->disp);

for (i = 0; i < lcdp->open_flow.func_num - skip_open_backlight; i++) {
    if (lcdp->open_flow.func[i].func) {
        lcdp->open_flow.func[i].func(lcd->disp);
        DE_INF("open flow:step %d finish, to delay %d\n", i,
               lcdp->open_flow.func[i].delay);
        if (lcdp->open_flow.func[i].delay != 0)
            disp_delay_ms(lcdp->open_flow.func[i].delay);
    }
}
```

```c
// 典型的Panel驱动open flow定义
static s32 lcd_open_flow(u32 sel)
{
    LCD_OPEN_FUNC(sel, lcd_power_on, 10);        // 步骤1: 上电，延迟10ms
    LCD_OPEN_FUNC(sel, lcd_panel_init, 10);      // 步骤2: 初始化序列，延迟10ms  
    LCD_OPEN_FUNC(sel, sunxi_lcd_tcon_enable, 50); // 步骤3: 使能TCON，延迟50ms
    LCD_OPEN_FUNC(sel, lcd_bl_open, 0);          // 步骤4: 打开背光，无延迟
    return 0;
}
```

```c
void LCD_OPEN_FUNC(u32 disp, LCD_FUNC func, u32 delay)
{
	struct disp_device *lcd;

	lcd = disp_get_lcd(disp);

	if (lcd && lcd->set_open_func)
		lcd->set_open_func(lcd, func, delay);
}
```

```c
spin_lock_irqsave(&lcd_data_lock, flags);
lcdp->enabled = 1;        // ✅ 设置使能标志
lcdp->enabling = 0;
spin_unlock_irqrestore(&lcd_data_lock, flags);
```

```c
bl = disp_lcd_get_bright(lcd);
disp_lcd_set_bright(lcd, bl);
```

```plaintext
时间轴：
T0: disp_init() 开始
T1: bsp_disp_init() 完成 (lcdp->enabled = 0)
T2: lcd_init() 完成 (lcdp->enabled = 0)
T3: fb_init() -> register_framebuffer()
T4: ├─ fbcon_init() 同步触发
    └─ sunxi_fb_open() 
        └─ is_enabled() 返回 0 ❌
            └─ enable() 被调用 ⚠️ 重新初始化硬件
                ├─ 重置TCON
                ├─ 重新配置时钟
                ├─ 重新注册中断
                └─ vsync中断被打断
T5: start_work() 异步执行
    └─ bsp_disp_sync_with_hw()
        └─ sw_enable() (lcdp->enabled = 1, 但为时已晚)
```

---

**User**

@dev_disp.c (1937-1981) 为什么这里当boot_info.sync == 0的分支没有看到enable

---

**Cursor**

好问题！让我帮您查看 `disp_device_set_config` 函数的实现，看看它内部做了什么。

太好了！现在我找到答案了。让我为您详细解释：

## 为什么 `boot_info.sync == 0` 分支没有显式看到 enable，但实际上**有调用**

### 📍 调用链分析

```
boot_info.sync == 0 分支:
    └─ disp_device_set_config()  (第1958行)
        └─ bsp_disp_device_set_config()  (第1921行)
            └─ disp_device_attached_and_enable()  (第365行) ⚠️ 关键!
                └─ mgr->device->enable()  (第231行) ✅ 这里调用了!
```

### 🔍 详细代码分析

#### 第1步：`start_work()` 中调用 `disp_device_set_config`

```1958:1959:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/dev_disp.c
					disp_device_set_config(
							       &g_disp_drv.disp_init, screen_id);
```

#### 第2步：`disp_device_set_config` 调用 `bsp_disp_device_set_config`

```1895:1922:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/dev_disp.c
int disp_device_set_config(struct disp_init_para *init,
				unsigned int screen_id)
{
	struct disp_device_config config;

	if (screen_id >= DISP_SCREEN_NUM) {
		__wrn("Out of range of screen index\n");
		return -1;
	}

	memset(&config, 0, sizeof(struct disp_device_config));
	config.type = init->output_type[screen_id];
	config.mode = init->output_mode[screen_id];
	config.format = init->output_format[screen_id];
	config.bits = init->output_bits[screen_id];
	config.eotf = init->output_eotf[screen_id];
	config.cs = init->output_cs[screen_id];
	config.dvi_hdmi = init->output_dvi_hdmi[screen_id];
	config.range = init->output_range[screen_id];
	config.scan = init->output_scan[screen_id];
	config.aspect_ratio = init->output_aspect_ratio[screen_id];
	if (!init->using_device_config)
		return bsp_disp_device_switch(screen_id,
					      config.type,
					      config.mode);
	else
		return bsp_disp_device_set_config(screen_id, &config);
}
```

#### 第3步：`bsp_disp_device_set_config` 调用 `disp_device_attached_and_enable`

```340:378:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/de/disp_display.c
s32 bsp_disp_device_set_config(int disp, struct disp_device_config *config)
{
	int num_screens = 0;
	int disp_dev;
	int ret = -1;

	if ((config->dvi_hdmi != DISP_DVI) && (config->dvi_hdmi != DISP_HDMI))
		config->dvi_hdmi = DISP_HDMI;
	if (config->range > 2)
		config->range = 0;
	if (config->scan > 2)
		config->scan = 0;
	if (!config->aspect_ratio)
		config->aspect_ratio = 8;
	if ((config->type == DISP_OUTPUT_TYPE_HDMI)
		&& (!config->cs)) {
		if (config->mode >= DISP_TV_MOD_720P_50HZ)
			config->cs = DISP_BT709;
		else
			config->cs = DISP_BT601;

		if (!config->eotf)
			config->eotf = DISP_EOTF_GAMMA22;
	}

	ret = disp_device_attached_and_enable(disp, disp, config);
	if (ret != 0) {
		num_screens = bsp_disp_feat_get_num_screens();
		for (disp_dev = 0; disp_dev < num_screens; disp_dev++) {
			ret = disp_device_attached_and_enable(disp,
							      disp_dev,
							      config);
			if (ret == 0)
				break;
		}
	}

	return ret;
}
```

**关键点**：第365行调用了 `disp_device_attached_and_enable`

#### 第4步：`disp_device_attached_and_enable` 内部调用 `enable()`

```167:265:kernel/linux-4.9/drivers/video/fbdev/sunxi/disp2/disp/de/disp_display.c
s32 disp_device_attached_and_enable(int disp_mgr, int disp_dev,
				    struct disp_device_config *config)
{
	struct disp_manager *mgr = NULL;
	struct disp_device *dispdev = NULL;
	int ret = 0;

	mgr = disp_get_layer_manager(disp_mgr);
	if (!mgr)
		return -1;

	if (mgr->device && mgr->device->type != config->type) {
		if (mgr->device->is_enabled(mgr->device))
			mgr->device->disable(mgr->device);

		if (mgr->device->unset_manager)
			mgr->device->unset_manager(mgr->device);
	}

	if ((!mgr->device) && (config->type != DISP_OUTPUT_TYPE_NONE)) {
		dispdev = disp_device_get(disp_dev, config->type);
		if (dispdev && dispdev->set_manager) {
			dispdev->set_manager(dispdev, mgr);
		} else {
			ret = -1;
			goto exit;
		}
	}

	if (mgr->device) {
		disp_config_update_t update = DISP_NORMAL_UPDATE;

		if (mgr->device->check_config_dirty)
			update = mgr->device->check_config_dirty(mgr->device,
								 config);

		if (update == DISP_NORMAL_UPDATE) {
			static char const *fmt_name[] = {
				"rgb",
				"yuv444",
				"yuv422",
				"yuv420"
			};
			static char const *bits_name[] = {
				"8bits",
				"10bits",
				"12bits",
				"16bits"
			};
			if (mgr->device->is_enabled(mgr->device))
				mgr->device->disable(mgr->device);

			if (mgr->device->set_static_config)
				ret = mgr->device->set_static_config(mgr->device,
							config);
			if (ret != 0)
				goto exit;

			if (config->type == DISP_OUTPUT_TYPE_TV)
				disp_delay_ms(300);

			if (config->type == DISP_OUTPUT_TYPE_HDMI)
				disp_delay_ms(1000);

			ret = mgr->device->enable(mgr->device);
			DE_WRN("attached %s, mgr%d<-->dev%d\n",
				(ret == 0) ? "ok" : "fail",
				disp_mgr, disp_dev);
			DE_WRN("type:%d,mode:%d,fmt:%s,bits:%s,eotf:%d,cs:%d dvi_hdmi:%d, range:%d scan:%d ratio:%d\n",
				config->type,
				config->mode,
				(config->format < 4) ?
				    fmt_name[config->format] : "undef",
				(config->bits < 4) ?
				    bits_name[config->bits] : "undef",
				config->eotf,
				config->cs,
				config->dvi_hdmi,
				config->range,
				config->scan,
				config->aspect_ratio);
			if (ret != 0)
				goto exit;

		} else if (update == DISP_SMOOTH_UPDATE) {
			if (mgr->device->set_static_config)
				ret = mgr->device->set_static_config(mgr->device,
							config);
				mgr->device->smooth_enable(mgr->device);
			if (ret != 0)
				goto exit;
		}
	}

	return 0;

exit:
	return ret;
}
```

**✅ 第231行：这里调用了 `mgr->device->enable(mgr->device)`！**

## 两个分支的对比

### `boot_info.sync == 0`（非seamless启动）

```
disp_device_set_config()
  └─ bsp_disp_device_set_config()
      └─ disp_device_attached_and_enable()
          ├─ 连接设备
          ├─ 配置参数
          └─ mgr->device->enable()  ✅ 完整的硬件初始化
```

**特点**：
- 从头开始初始化设备
- 调用完整的 `enable()` 函数
- 执行完整的 panel open flow
- 适用于：冷启动、没有uboot显示的情况

### `boot_info.sync == 1`（seamless启动）

```
bsp_disp_sync_with_hw()
  └─ disp_device_attached()
      ├─ 连接设备
      └─ mgr->device->sw_enable()  ⚠️ 仅软件状态同步
```

**特点**：
- 硬件已由uboot初始化
- 只调用 `sw_enable()` 设置软件标志
- 不重新初始化硬件
- 适用于：seamless显示，平滑过渡

## 为什么设计成这样？

### 设计理念

1. **`sync == 0`（正常启动）**：
   - 设备可能未初始化或需要重新配置
   - 需要完整的硬件初始化流程
   - 调用 `enable()` → 配置时钟、电源、TCON、Panel初始化等

2. **`sync == 1`（seamless启动）**：
   - 硬件已由uboot配置好
   - 只需要同步软件状态
   - 调用 `sw_enable()` → 仅设置 `lcdp->enabled = 1` 标志

### 时序对比

```
正常启动 (sync=0):
T0: start_work执行 (异步)
T1: disp_device_set_config
T2: └─ enable() 完整初始化硬件
T3: 设备开始工作

Seamless启动 (sync=1):
T0: [uboot已初始化硬件，正在显示]
T1: start_work执行 (异步)  
T2: bsp_disp_sync_with_hw
T3: └─ sw_enable() 仅同步状态
T4: 硬件继续工作，无中断
```

## 总结

**您的问题的答案**：

`boot_info.sync == 0` 的分支**确实有 enable 调用**，只是它隐藏在调用链的深处：

```
disp_device_set_config
  → bsp_disp_device_set_config  
    → disp_device_attached_and_enable
      → mgr->device->enable()  ← 这里！
```

而 `boot_info.sync == 1` 的分支使用：

```
bsp_disp_sync_with_hw
  → disp_device_attached
    → mgr->device->sw_enable()  ← 不是 enable()
```

这就是为什么 seamless 启动时如果 fbcon 提前调用 `enable()`，会破坏正在运行的硬件状态！

```plaintext
boot_info.sync == 0 分支:
    └─ disp_device_set_config()  (第1958行)
        └─ bsp_disp_device_set_config()  (第1921行)
            └─ disp_device_attached_and_enable()  (第365行) ⚠️ 关键!
                └─ mgr->device->enable()  (第231行) ✅ 这里调用了!
```

```c
					disp_device_set_config(
							       &g_disp_drv.disp_init, screen_id);
```

```c
int disp_device_set_config(struct disp_init_para *init,
				unsigned int screen_id)
{
	struct disp_device_config config;

	if (screen_id >= DISP_SCREEN_NUM) {
		__wrn("Out of range of screen index\n");
		return -1;
	}

	memset(&config, 0, sizeof(struct disp_device_config));
	config.type = init->output_type[screen_id];
	config.mode = init->output_mode[screen_id];
	config.format = init->output_format[screen_id];
	config.bits = init->output_bits[screen_id];
	config.eotf = init->output_eotf[screen_id];
	config.cs = init->output_cs[screen_id];
	config.dvi_hdmi = init->output_dvi_hdmi[screen_id];
	config.range = init->output_range[screen_id];
	config.scan = init->output_scan[screen_id];
	config.aspect_ratio = init->output_aspect_ratio[screen_id];
	if (!init->using_device_config)
		return bsp_disp_device_switch(screen_id,
					      config.type,
					      config.mode);
	else
		return bsp_disp_device_set_config(screen_id, &config);
}
```

```c
s32 bsp_disp_device_set_config(int disp, struct disp_device_config *config)
{
	int num_screens = 0;
	int disp_dev;
	int ret = -1;

	if ((config->dvi_hdmi != DISP_DVI) && (config->dvi_hdmi != DISP_HDMI))
		config->dvi_hdmi = DISP_HDMI;
	if (config->range > 2)
		config->range = 0;
	if (config->scan > 2)
		config->scan = 0;
	if (!config->aspect_ratio)
		config->aspect_ratio = 8;
	if ((config->type == DISP_OUTPUT_TYPE_HDMI)
		&& (!config->cs)) {
		if (config->mode >= DISP_TV_MOD_720P_50HZ)
			config->cs = DISP_BT709;
		else
			config->cs = DISP_BT601;

		if (!config->eotf)
			config->eotf = DISP_EOTF_GAMMA22;
	}

	ret = disp_device_attached_and_enable(disp, disp, config);
	if (ret != 0) {
		num_screens = bsp_disp_feat_get_num_screens();
		for (disp_dev = 0; disp_dev < num_screens; disp_dev++) {
			ret = disp_device_attached_and_enable(disp,
							      disp_dev,
							      config);
			if (ret == 0)
				break;
		}
	}

	return ret;
}
```

```c
s32 disp_device_attached_and_enable(int disp_mgr, int disp_dev,
				    struct disp_device_config *config)
{
	struct disp_manager *mgr = NULL;
	struct disp_device *dispdev = NULL;
	int ret = 0;

	mgr = disp_get_layer_manager(disp_mgr);
	if (!mgr)
		return -1;

	if (mgr->device && mgr->device->type != config->type) {
		if (mgr->device->is_enabled(mgr->device))
			mgr->device->disable(mgr->device);

		if (mgr->device->unset_manager)
			mgr->device->unset_manager(mgr->device);
	}

	if ((!mgr->device) && (config->type != DISP_OUTPUT_TYPE_NONE)) {
		dispdev = disp_device_get(disp_dev, config->type);
		if (dispdev && dispdev->set_manager) {
			dispdev->set_manager(dispdev, mgr);
		} else {
			ret = -1;
			goto exit;
		}
	}

	if (mgr->device) {
		disp_config_update_t update = DISP_NORMAL_UPDATE;

		if (mgr->device->check_config_dirty)
			update = mgr->device->check_config_dirty(mgr->device,
								 config);

		if (update == DISP_NORMAL_UPDATE) {
			static char const *fmt_name[] = {
				"rgb",
				"yuv444",
				"yuv422",
				"yuv420"
			};
			static char const *bits_name[] = {
				"8bits",
				"10bits",
				"12bits",
				"16bits"
			};
			if (mgr->device->is_enabled(mgr->device))
				mgr->device->disable(mgr->device);

			if (mgr->device->set_static_config)
				ret = mgr->device->set_static_config(mgr->device,
							config);
			if (ret != 0)
				goto exit;

			if (config->type == DISP_OUTPUT_TYPE_TV)
				disp_delay_ms(300);

			if (config->type == DISP_OUTPUT_TYPE_HDMI)
				disp_delay_ms(1000);

			ret = mgr->device->enable(mgr->device);
			DE_WRN("attached %s, mgr%d<-->dev%d\n",
				(ret == 0) ? "ok" : "fail",
				disp_mgr, disp_dev);
			DE_WRN("type:%d,mode:%d,fmt:%s,bits:%s,eotf:%d,cs:%d dvi_hdmi:%d, range:%d scan:%d ratio:%d\n",
				config->type,
				config->mode,
				(config->format < 4) ?
				    fmt_name[config->format] : "undef",
				(config->bits < 4) ?
				    bits_name[config->bits] : "undef",
				config->eotf,
				config->cs,
				config->dvi_hdmi,
				config->range,
				config->scan,
				config->aspect_ratio);
			if (ret != 0)
				goto exit;

		} else if (update == DISP_SMOOTH_UPDATE) {
			if (mgr->device->set_static_config)
				ret = mgr->device->set_static_config(mgr->device,
							config);
				mgr->device->smooth_enable(mgr->device);
			if (ret != 0)
				goto exit;
		}
	}

	return 0;

exit:
	return ret;
}
```

```plaintext
disp_device_set_config()
  └─ bsp_disp_device_set_config()
      └─ disp_device_attached_and_enable()
          ├─ 连接设备
          ├─ 配置参数
          └─ mgr->device->enable()  ✅ 完整的硬件初始化
```

```plaintext
bsp_disp_sync_with_hw()
  └─ disp_device_attached()
      ├─ 连接设备
      └─ mgr->device->sw_enable()  ⚠️ 仅软件状态同步
```

```plaintext
正常启动 (sync=0):
T0: start_work执行 (异步)
T1: disp_device_set_config
T2: └─ enable() 完整初始化硬件
T3: 设备开始工作

Seamless启动 (sync=1):
T0: [uboot已初始化硬件，正在显示]
T1: start_work执行 (异步)  
T2: bsp_disp_sync_with_hw
T3: └─ sw_enable() 仅同步状态
T4: 硬件继续工作，无中断
```

```plaintext
disp_device_set_config
  → bsp_disp_device_set_config  
    → disp_device_attached_and_enable
      → mgr->device->enable()  ← 这里！
```

```plaintext
bsp_disp_sync_with_hw
  → disp_device_attached
    → mgr->device->sw_enable()  ← 不是 enable()
```

