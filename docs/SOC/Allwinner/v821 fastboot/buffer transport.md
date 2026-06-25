
---

## 1. `perf2_fastboot` 为什么和 E907 有关

`perf2_fastboot/sys_partition.fex` 里有 `riscv0` 分区：

```45:65:/home/alientek/v821/v821-tina-v12/device/config/chips/v821/configs/perf2_fastboot/sys_partition.fex
[partition]
    name         = boot
    size         = 131072
    downloadfile = "boot.fex"
    user_type    = 0x8000

[partition]
    name         = private
    size         = 1024
    ro           = 0
    user_type    = 0x8000

[partition]
    name         = riscv0
    size         = 4096
    downloadfile = "amp_rv0.fex"
    user_type    = 0x8000
```

这说明 fastboot 固件里包含 `amp_rv0.fex`，也就是 E907/RISC-V 侧固件。快速出图的核心就是：**Linux 还没完全起来时，E907 已经先把 sensor/VIN/ISP 跑起来并预先采图。**

但是这里要区分：

- E907 负责“启动采图链路”。
- 图像数据不是 E907 CPU 拷贝出来的。
- 图像数据是硬件 DMA 写到 DDR 的。

---

## 2. E907 侧：给 CSIC DMA 配置帧 buffer 物理地址

RTOS/E907 侧关键函数在：

`rtos/lichee/rtos-hal/hal/source/vin/vin_video/vin_video.c`

### 2.1 `vin_set_addr()`：把物理地址写入 DMA 寄存器

```18:57:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin_video/vin_video.c
int vin_set_addr(unsigned int id, unsigned long phy_addr)
{
	struct vin_core *vinc = global_vinc[id];
	struct vin_addr paddr;
	__maybe_unused int offset_width;

	paddr.y = phy_addr;
	paddr.cb = (unsigned long)(phy_addr + global_video[id].o_width * global_video[id].o_height);
	paddr.cr = 0;

	if (global_video[id].fourcc == V4L2_PIX_FMT_LBC_1_0X || global_video[id].fourcc == V4L2_PIX_FMT_LBC_1_5X ||
			global_video[id].fourcc == V4L2_PIX_FMT_LBC_2_0X || global_video[id].fourcc == V4L2_PIX_FMT_LBC_2_5X) {
		paddr.cb = 0;
		paddr.cr = 0;
	}

	if (vinc->large_image) {
		offset_width = global_video[id].o_width / 2;
		csic_dma_buffer_address(vinc->id - 1, CSI_BUF_0_A, paddr.y);
		csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_0_A, paddr.y + offset_width);
		if (paddr.cb) {
			csic_dma_buffer_address(vinc->id - 1, CSI_BUF_1_A, paddr.cb);
			csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_1_A, paddr.cb + (offset_width >> 1));
		} else {
			csic_dma_buffer_address(vinc->id - 1, CSI_BUF_1_A, paddr.cb);
			csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_1_A, paddr.cb);
		}

		csic_dma_buffer_address(vinc->id - 1, CSI_BUF_2_A, paddr.cr);
		csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_2_A, paddr.cr);
	} else {
		csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_0_A, paddr.y);
		csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_1_A, paddr.cb);
		csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_2_A, paddr.cr);
	}

	return 0;
}
```

这段非常关键。

`phy_addr` 是一帧图像的起始物理地址。代码把它拆成：

```text
Y  plane: phy_addr
Cb plane: phy_addr + width * height
Cr plane: 0，或者按格式另算
```

然后调用：

```c
csic_dma_buffer_address(..., CSI_BUF_0_A, paddr.y);
csic_dma_buffer_address(..., CSI_BUF_1_A, paddr.cb);
csic_dma_buffer_address(..., CSI_BUF_2_A, paddr.cr);
```

这说明 E907 做的事情是：

```text
把“DMA 下一帧应该写到哪个 DDR 物理地址”写进 CSIC DMA 寄存器。
```

不是：

```text
E907 从 ISP 读出图像，然后软件 memcpy 给 Linux。
```

---

## 3. E907 侧：帧 buffer 从哪里来

同一个文件里的 `buffer_queue()` 分配 YUV buffer：

```85:133:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin_video/vin_video.c
int buffer_queue(unsigned int id)
{
	unsigned int size;
	unsigned int i;
	unsigned int buffer_num;

	size = global_video[id].o_width * global_video[id].o_height * 3 / 2;

#ifdef DMA_USE_IRQ_BUFFER_QUEUE
#ifdef CONFIG_NOT_FRAME_LOSS
	buffer_num = 1;
#else
	if (global_vinc[id]->get_yuv_en)
		buffer_num = 2;
	else
		buffer_num = 1;
#endif
	for (i = 0; i < buffer_num; i++) {
#if defined CONFIG_KERNEL_FREERTOS
#ifdef CONFIG_NOT_FRAME_LOSS
		global_vinc[id]->buff[i].phy_addr = (void *)YUV_MEMRESERVE;
#else
		global_vinc[id]->buff[i].phy_addr = memheap_alloc_align(&isp_mempool, size, 0x1000);
#endif
#else
		global_vinc[id]->buff[i].phy_addr = rt_memheap_alloc_align(&isp_mempool, size, 0x1000);
#endif
		global_vinc[id]->buffer_size = size;
		if (global_vinc[id]->buff[i].phy_addr == NULL) {
			vin_err("%s:video%d:alloc bk buffer%d error\n", __func__, id, i);
			return -1;
		}
		vin_log(VIN_LOG_MD, "video%d: buffer[%d] phy_addr is 0x%p\n", id, i, global_vinc[id]->buff[i].phy_addr);
		if (global_vinc[id]->get_yuv_en)
			vin_print("video%d: buffer[%d] phy_addr is 0x%p\n", id, i, global_vinc[id]->buff[i].phy_addr);
	}
	vin_detect_buffer_cfg(global_vinc[id]);
```

关键点：

```c
size = width * height * 3 / 2;
```

这是典型 YUV420 一帧大小。

当 `get_yuv_en` 打开时：

```c
buffer_num = 2;
```

也就是 fastboot 预拍 YUV 时，普通路径下会准备两个 buffer。

buffer 物理地址来源：

```c
memheap_alloc_align(&isp_mempool, size, 0x1000);
```

或者 `CONFIG_NOT_FRAME_LOSS` 下直接使用：

```c
YUV_MEMRESERVE
```

所以 E907 侧的 buffer 是 reserved DDR / isp mempool 里的一块物理连续内存，后面 DMA 直接写这里。

---

## 4. E907 侧：把 YUV buffer 地址写到共享结构体

`buffer_queue()` 分配完 buffer 后调用：

```c
vin_detect_buffer_cfg(global_vinc[id]);
```

这个函数是 E907 和 Linux 协商“YUV 图像在哪”的核心：

```59:83:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin_video/vin_video.c
static void vin_detect_buffer_cfg(struct vin_core *vinc)
{
#if !defined NOT_USE_ISP
	int ispid = vinc->isp_sel;
	struct isp_autoflash_config_s *isp_autoflash_cfg = NULL;
	unsigned int sign;

	if (ispid == 0) {  /* isp0 */
		isp_autoflash_cfg = (struct isp_autoflash_config_s *)ISP0_NORFLASH_SAVE;
		sign = 0xAA11AA11;
	} else { /* isp1/isp2 */
		isp_autoflash_cfg = (struct isp_autoflash_config_s *)ISP1_NORFLASH_SAVE;
		sign = 0xBB11BB11;
	}

	if (vinc->get_yuv_en) {
		isp_autoflash_cfg->melisyuv_sign_id = sign;
		isp_autoflash_cfg->melisyuv_paddr = (unsigned int)vinc->buff[0].phy_addr;
		isp_autoflash_cfg->melisyuv_size = vinc->buffer_size;
#ifdef CONFIG_NOT_FRAME_LOSS
		isp_autoflash_cfg->not_frame_loss_flag = 1;
#endif
	} else {
		isp_autoflash_cfg->melisyuv_sign_id = 0xFFFFFFFF;
	}
#endif
}
```

这段说明：

- E907 不把图像数据发给 Linux。
- E907 只把 **YUV buffer 物理地址** 写入共享结构体：

```c
melisyuv_paddr = vinc->buff[0].phy_addr;
melisyuv_size  = vinc->buffer_size;
melisyuv_sign_id = 0xAA11AA11 或 0xBB11BB11;
```

也就是告诉 Linux：

```text
图像已经在这个物理地址里了，你自己去映射读。
```

---

## 5. 共享结构体 `isp_autoflash_config_s` 的地址和字段

结构体定义在：

`rtos/lichee/rtos-hal/hal/source/vin/vin_isp/isp_server/isp_server.h`

V821 对应 `CONFIG_ARCH_SUN300IW1`，sensor0 的 reserve 地址是：

```142:148:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin_isp/isp_server/isp_server.h
#if defined CONFIG_ARCH_SUN55IW3
#define VIN_SENSOR0_RESERVE_ADDR (0x613FE000) /*104~110 sector, size is 4k - 512b, boot0 read it and write to 0x613FE000*/
#define VIN_SENSOR1_RESERVE_ADDR (0x613FF000) /*112~118 sector, size is 4k - 512b, boot0 read it and write to 0x613FF000*/
#elif defined CONFIG_ARCH_SUN300IW1
#define VIN_SENSOR0_RESERVE_ADDR (0x81CEE000) /*104~110 sector, size is 4k - 512b, boot0 read it and write to 0x81EEE000*/
#define VIN_SENSOR1_RESERVE_ADDR (0x81CEF000) /*112~118 sector, size is 4k - 512b, boot0 read it and write to 0x81EEF000*/
```

后面定义 `ISP0_NORFLASH_SAVE`：

```210:213:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin_isp/isp_server/isp_server.h
/* kernel auto save isp parameter to flash, in order to use in next time */
#define ISP0_NORFLASH_SAVE (VIN_SENSOR0_RESERVE_ADDR + 512 * 7) /*111 sector, size is 512b, kernel write to flash and boot0 read it and write to ISP0_NORFLASH_SAVE*/
#define ISP1_NORFLASH_SAVE (VIN_SENSOR1_RESERVE_ADDR + 512 * 7) /*119 sector, size is 512b, kernel write to flash and boot0 read it and write to ISP1_NORFLASH_SAVE*/
```

结构体中跟 fastboot YUV 最相关的是这几个字段：

```215:232:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin_isp/isp_server/isp_server.h
#pragma pack(1)
struct isp_autoflash_config_s {
	//ISP_SET_SAVE_AE
	unsigned int ae_tble_idx;
	unsigned int ev_analog_gain;
	unsigned int ev_sensor_exp_line;
	unsigned int ev_short_analog_gain;
	unsigned int ev_short_sensor_exp_line;
	unsigned int reserv1[11];

	unsigned int melisyuv_sign_id;//id0: 0xAA11AA11, id1: 0xBB11BB11
	unsigned int melisyuv_paddr;
	unsigned int melisyuv_size;
	unsigned int not_frame_loss_flag;
```

这几个字段构成了 E907 → Linux 的“地址通知”：

| 字段 | 作用 |
|---|---|
| `melisyuv_sign_id` | YUV buffer 是否有效，sensor0 通常是 `0xAA11AA11` |
| `melisyuv_paddr` | YUV buffer 的物理起始地址 |
| `melisyuv_size` | YUV buffer 大小 |
| `not_frame_loss_flag` | 是否连续保帧模式 |

这不是传图结构体，而是**传地址和大小的元数据结构体**。

---

## 6. E907 侧：每帧中断时如何切帧

RTOS 侧中断函数在：

`rtos/lichee/rtos-hal/hal/source/vin/vin_video/vin_core.c`

核心是 `vsync_trig` 分支：

```122:153:/home/alientek/v821/v821-tina-v12/rtos/lichee/rtos-hal/hal/source/vin/vin_video/vin_core.c
	if (status.vsync_trig) {
		csic_dma_int_clear_status(vinc->vipp_sel, DMA_INT_VSYNC_TRIG);
#ifndef CONFIG_VIDEO_SUNXI_VIN_SPECIAL
#ifndef CONFIG_NOT_FRAME_LOSS
		if (vinc->first_frame == 0) {
			vinc->first_frame = 1;
			vin_print("video%d First Frame!\n", vinc->id);
		} else if (vinc->get_yuv_en && vinc->first_frame == 1) {
			vinc->first_frame = 2;
			vin_set_addr(vinc->id, (unsigned int)vinc->buff[1].phy_addr);
			vin_print("video%d second Frame!\n", vinc->id);
		} else if (vinc->get_yuv_en && vinc->first_frame == 2) {
			vinc->first_frame = 3;
			csic_dma_int_disable(vinc->vipp_sel, DMA_INT_ALL);
			vin_print("video%d third Frame!\n", vinc->id);
		}
#else
		vinc->frame_cnt++;
		if ((vinc->frame_cnt * vinc->buffer_size) < YUV_MEMRESERVE_SIZE)
			vin_set_addr(vinc->id, (unsigned int)vinc->buff[0].phy_addr + (vinc->frame_cnt) * vinc->buffer_size);
#endif
```

这段可以拆成两种 fastboot 预拍模式。

### 6.1 普通 `get_yuv_en` 双 buffer 模式

没有 `CONFIG_NOT_FRAME_LOSS` 时：

1. 第一帧：
   ```c
   first_frame = 1;
   ```
2. 第二帧前切到 `buff[1]`：
   ```c
   vin_set_addr(vinc->id, vinc->buff[1].phy_addr);
   ```
3. 第三次后关闭 DMA 中断：
   ```c
   csic_dma_int_disable(vinc->vipp_sel, DMA_INT_ALL);
   ```

这说明 E907 fastboot 阶段可能只抓少量几帧，然后停住，把图留在 DDR 里给 Linux 读。

### 6.2 `CONFIG_NOT_FRAME_LOSS` 连续保帧模式

如果打开 `CONFIG_NOT_FRAME_LOSS`：

```c
vinc->frame_cnt++;
if ((vinc->frame_cnt * vinc->buffer_size) < YUV_MEMRESERVE_SIZE)
    vin_set_addr(vinc->id, buff[0].phy_addr + frame_cnt * buffer_size);
```

这就是连续帧布局：

```text
base + 0 * frame_size  → 第 0 帧
base + 1 * frame_size  → 第 1 帧
base + 2 * frame_size  → 第 2 帧
...
```

每帧还是 DMA 写，只是 E907 在 VSYNC 时更新下一帧的 DMA 目标地址。

---

## 7. Linux 侧：不是接收帧，而是 remap 物理地址

Linux 侧关键函数在：

`bsp/drivers/vin/vin-video/vin_video.c`

函数名是 `vidioc_set_phy2vir_cfg()`。

它对应 ioctl 分发里的：

```4754:4773:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-video/vin_video.c
	case VIDIOC_GET_ISP_SEI_INFO:
		ret = vidioc_get_isp_sei_info(file, fh, param);
		break;
#endif
	case VIDIOC_SET_TDM_DEPTH:
		ret = vidioc_set_tdm_depth_cfg(file, fh, param);
		break;
	case VIDIOC_SET_PHY2VIR:
		ret = vidioc_set_phy2vir_cfg(file, fh, param);
		break;
	case VIDIOC_SET_D3DLBCRATIO:
		ret = vidioc_set_d3d_lbc_ratio(file, fh, param);
```

所以用户态应用调用 `VIDIOC_SET_PHY2VIR` 后，进入 `vidioc_set_phy2vir_cfg()`。

### 7.1 Linux 先映射共享配置区

```4174:4198:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-video/vin_video.c
static int vidioc_set_phy2vir_cfg(struct file *file, struct v4l2_fh *fh,
			struct isp_memremap_cfg *isp_memremap)
{
#if IS_ENABLED(CONFIG_VIN_INIT_MELIS)
	__maybe_unused struct vin_core *vinc = video_drvdata(file);
	unsigned long viraddr;
	struct vm_area_struct *vma;
	void *vaddr = NULL;
	__maybe_unused struct isp_autoflash_config_s *isp_autoflash_cfg = NULL;
	__maybe_unused unsigned int map_addr = 0;
	__maybe_unused unsigned int check_sign = 0;

#if !GET_RV_YUV
	if (vinc->mipi_sel == 0) {
		map_addr = VIN_SENSOR0_RESERVE_ADDR;
		check_sign = 0xAA11AA11;
	} else {
		map_addr = VIN_SENSOR1_RESERVE_ADDR;
		check_sign = 0xBB11BB11;
	}
```

这里 Linux 根据 `mipi_sel` 选择：

```text
sensor0 → VIN_SENSOR0_RESERVE_ADDR
sensor1 → VIN_SENSOR1_RESERVE_ADDR
```

并准备校验 `melisyuv_sign_id`：

```text
sensor0 → 0xAA11AA11
sensor1 → 0xBB11BB11
```

然后：

```4199:4213:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-video/vin_video.c
	vaddr = vin_map_kernel(map_addr, VIN_RESERVE_SIZE + VIN_THRESHOLD_PARAM_SIZE); /* map unit is page, page is align of 4k */
	if (vaddr == NULL) {
		vin_err("%s:map 0x%x paddr err!!!", __func__, map_addr);
		return -EFAULT;
	}

	isp_autoflash_cfg = (struct isp_autoflash_config_s *)(vaddr + VIN_RESERVE_SIZE);

	/* check id */
	if (isp_autoflash_cfg->melisyuv_sign_id != check_sign) {
		vin_warn("%s:sign is 0x%x but not 0x%x\n", __func__, isp_autoflash_cfg->sensorlist_sign_id, check_sign);
		vin_unmap_kernel(vaddr);
		return -EFAULT;
	}
```

这段证明 Linux 首先读的是 E907 写好的 `isp_autoflash_config_s`，检查：

```c
melisyuv_sign_id
```

如果 sign 不对，就说明 E907 没有准备好有效 YUV buffer。

### 7.2 Linux 把 E907 预拍 YUV 物理地址映射到用户态

最关键的是下面这几行：

```4215:4223:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-video/vin_video.c
	if (isp_memremap->en) {
		viraddr = vm_mmap(NULL, 0, isp_autoflash_cfg->melisyuv_size, PROT_READ, MAP_SHARED | MAP_NORESERVE, 0);
		vma = find_vma(current->mm, viraddr);
		remap_pfn_range(vma, vma->vm_start, __phys_to_pfn(isp_autoflash_cfg->melisyuv_paddr), isp_autoflash_cfg->melisyuv_size, vma->vm_page_prot);
		isp_memremap->vir_addr = (void *)viraddr;
		isp_memremap->size = isp_autoflash_cfg->melisyuv_size;
		vin_print("0x%x mmap viraddr is 0x%lx\n", isp_autoflash_cfg->melisyuv_paddr, viraddr);
	} else {
```

这段就是 fastboot 快速出图最核心证据：

```c
remap_pfn_range(
    vma,
    vma->vm_start,
    __phys_to_pfn(isp_autoflash_cfg->melisyuv_paddr),
    isp_autoflash_cfg->melisyuv_size,
    vma->vm_page_prot
);
```

意思是：

```text
把 E907 写在 isp_autoflash_cfg->melisyuv_paddr 里的物理 YUV buffer
直接映射到 Linux 当前进程用户态虚拟地址。
```

所以 Linux 用户态拿到的 `vir_addr` 指向的不是内核 copy 出来的一份图，而是直接指向那块物理 DDR 图像区。

---

## 8. Linux 侧 `GET_RV_YUV` 路径：直接映射整块 YUV_MEMRESERVE

如果走 `GET_RV_YUV` 路径，则不是读 `melisyuv_paddr`，而是直接映射固定 `YUV_MEMRESERVE`：

```4233:4243:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-video/vin_video.c
#else
	vaddr = vin_map_kernel(YUV_MEMRESERVE, YUV_MEMRESERVE_SIZE); /* map unit is page, page is align of 4k */ /* map unit is page, page is align of 4k */
	if (vaddr == NULL) {
		vin_err("%s:map 0x%x paddr err!!!", __func__, map_addr);
		return -EFAULT;
	}

	if (isp_memremap->en) {
		viraddr = vm_mmap(NULL, 0, YUV_MEMRESERVE_SIZE, PROT_READ, MAP_SHARED | MAP_NORESERVE, 0);
		vma = find_vma(current->mm, viraddr);
```

继续：

```4244:4255:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-video/vin_video.c
		remap_pfn_range(vma, vma->vm_start, __phys_to_pfn(YUV_MEMRESERVE), YUV_MEMRESERVE_SIZE, vma->vm_page_prot);
		isp_memremap->vir_addr = (void *)viraddr;
		isp_memremap->size = YUV_MEMRESERVE_SIZE;
		vin_print("0x%x mmap viraddr is 0x%lx\n", YUV_MEMRESERVE, viraddr);
	} else {
		if (isp_memremap->vir_addr && isp_memremap->size) {
			vm_munmap((unsigned long)isp_memremap->vir_addr, isp_memremap->size);
			vin_print("0x%x ummap viraddr is 0x%lx\n", YUV_MEMRESERVE, (unsigned long)isp_memremap->vir_addr);

			memblock_free(YUV_MEMRESERVE, YUV_MEMRESERVE_SIZE);
```

这和 E907 侧 `CONFIG_NOT_FRAME_LOSS` 那段对应：

```text
E907 每帧写 YUV_MEMRESERVE + frame_cnt * frame_size
Linux 映射整块 YUV_MEMRESERVE
用户态按 frame_size 偏移读多帧
```

---

## 9. Linux 释放 fastboot 预留 YUV 内存

Linux 侧在 `en == 0` 时会释放这块 reserved area：

```4224:4232:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-video/vin_video.c
		if (isp_memremap->vir_addr && isp_memremap->size) {
			vm_munmap((unsigned long)isp_memremap->vir_addr, isp_memremap->size);
			vin_print("0x%x ummap viraddr is 0x%lx\n", isp_autoflash_cfg->melisyuv_paddr, (unsigned long)isp_memremap->vir_addr);

			isp_autoflash_cfg->melisyuv_sign_id = 0XFFFFFFFF;
			memblock_free(isp_autoflash_cfg->melisyuv_paddr, isp_autoflash_cfg->melisyuv_size);
			free_reserved_area(__va(isp_autoflash_cfg->melisyuv_paddr), __va(isp_autoflash_cfg->melisyuv_paddr + isp_autoflash_cfg->melisyuv_size), -1, "isp_reserved");
		}
```

这也说明这块内存本来是 boot/RTOS/E907 阶段保留下来的。Linux 快速出图用完后可以把它释放回 Linux 内存管理。

---

## 10. 正常 Linux V4L2 路径对比：也是 DMA 写 DDR，但 buffer 来源不同

正常 Linux V4L2 采集时，用户态 `REQBUFS/QBUF/STREAMON` 后，Linux 驱动会拿 vb2 buffer 的物理地址，然后写给 CSIC DMA。

Linux 侧 `vin_set_addr()`：

```269:306:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-video/vin_video.c
int vin_set_addr(struct vin_core *vinc, struct vb2_buffer *vb,
		      struct vin_frame *frame, struct vin_addr *paddr)
{
	u32 pix_size, depth, y_stride, u_stride, v_stride;
	struct vb2_v4l2_buffer *vb2_v4l2;
	struct vin_buffer *buf;
	__maybe_unused int offset_width, offset_width_uv;
	__maybe_unused struct vin_core *vinc_bind = NULL;
	struct scaler_dev *scaler = NULL;

	vb2_v4l2 = container_of(vb, struct vb2_v4l2_buffer, vb2_buf);
	buf = container_of(vb2_v4l2, struct vin_buffer, vb);

	if (vinc->vid_cap.special_active == 1) {
		if (buf == NULL || buf->paddr == NULL)
			return -EINVAL;
	} else {
		if (vb == NULL || frame == NULL)
			return -EINVAL;
	}

#if IS_ENABLED(CONFIG_ARCH_SUN8IW21P1) || IS_ENABLED(CONFIG_ARCH_SUN300IW1P1)
	pix_size = ALIGN(frame->o_width, VIN_ALIGN_WIDTH) * ALIGN(frame->o_height, VIN_ALIGN_HEIGHT);
```

核心差别在这里：

```302:306:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-video/vin_video.c
	if (vinc->vid_cap.special_active == 1) {
		paddr->y = (vin_dma_addr_t)buf->paddr;
		frame->fmt.memplanes = 1;
	} else
		paddr->y = vb2_dma_contig_plane_dma_addr(vb, 0);
```

普通 V4L2 模式：

```c
paddr->y = vb2_dma_contig_plane_dma_addr(vb, 0);
```

意思是从 Linux vb2 分配的 DMA-contig buffer 取物理地址。

特殊模式：

```c
paddr->y = buf->paddr;
```

这个 `buf->paddr` 可以来自 dma-buf / special interface。

后面算 Cb/Cr：

```330:346:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-video/vin_video.c
			paddr->cb = (u32)(paddr->y + pix_size);
			/*  420  */
			if (frame->fmt.depth[0] == 12)
				paddr->cr = (u32)(paddr->cb + (pix_size >> 2));
			else /*  422  */
				paddr->cr = (u32)(paddr->cb + (pix_size >> 1));
			break;
		default:
			return -EINVAL;
		}
	} else if (!frame->fmt.mdataplanes) {
		if (frame->fmt.memplanes >= 2)
			paddr->cb = vb2_dma_contig_plane_dma_addr(vb, 1);

		if (frame->fmt.memplanes == 3)
			paddr->cr = vb2_dma_contig_plane_dma_addr(vb, 2);
```

最后仍然写入 CSIC DMA 寄存器：

```399:411:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-video/vin_video.c
		if (vinc->vid_cap.frame.fmt.fourcc == V4L2_PIX_FMT_YVU420) {
			csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_0_A, paddr->y);
			csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_2_A, paddr->cb);
			csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_1_A, paddr->cr);
		} else {
			csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_0_A, paddr->y);
			csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_1_A, paddr->cb);
			csic_dma_buffer_address(vinc->vipp_sel, CSI_BUF_2_A, paddr->cr);
		}
```

所以无论 fastboot 预拍还是正常 V4L2 采集，本质都是：

```text
CPU 配置 CSIC DMA 目标物理地址
CSIC DMA 写图像到 DDR
用户态 mmap 读 DDR
```

区别只是：

| 阶段 | 谁配置 DMA | buffer 来源 | Linux 怎么读 |
|---|---|---|---|
| fastboot 预拍 | E907 | E907/RTOS reserved DDR | `VIDIOC_SET_PHY2VIR` + `remap_pfn_range` |
| 正常 V4L2 | Linux VIN 驱动 | Linux vb2/dma-contig/CMA | 标准 V4L2 `mmap` + `DQBUF` |

---

## 11. special buffer 路径：Linux 侧 dma-buf 转物理地址

如果 Linux 侧 special interface 使用 dma-buf，则 `vin_qbuffer_special()` 里会把 dma-buf attach/map 后取物理地址：

```6290:6330:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-video/vin_video.c
	get_dma_buf(buf->dmabuf);

	attachment = dma_buf_attach(buf->dmabuf, dev);
	if (IS_ERR(attachment)) {
		vin_err("dma_buf_attach failed\n");
		goto err_buf_put;
	}

#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 6, 0)
	sgt = dma_buf_map_attachment_unlocked(attachment, DMA_BIDIRECTIONAL);
#else
	sgt = dma_buf_map_attachment(attachment, DMA_BIDIRECTIONAL);
#endif
	if (IS_ERR_OR_NULL(sgt)) {
		vin_warn("dma_buf_map_attachment failed\n");
		goto err_buf_detach;
	}

	buf->attachment = attachment;
	buf->sgt = sgt;

#if IS_ENABLED(CONFIG_SET_BK_BUF_OFFSET)
	buf->paddr = (void *)(uintptr_t)sg_dma_address(sgt->sgl) + buf->offset;
#else
	buf->paddr = (void *)(uintptr_t)sg_dma_address(sgt->sgl);
#endif
```

之后 `vin_set_addr()` 里如果 `special_active == 1`，就用这个 `buf->paddr` 作为 DMA 写入地址。

这进一步说明 Linux 侧也是围绕“物理地址给 DMA”工作，而不是 CPU 传帧。

---

## 12. 每帧的完整 fastboot 时序

结合上面的源码，`perf2_fastboot` 快速出图的时序可以写成：

```text
1. Boot 阶段加载 E907 固件 amp_rv0.fex
   来源：sys_partition.fex 的 riscv0 分区

2. E907/RTOS 初始化 sensor / MIPI / VIN / ISP

3. E907 根据输出宽高计算一帧大小：
   size = width * height * 3 / 2

4. E907 从 isp_mempool 或 YUV_MEMRESERVE 准备 YUV buffer

5. E907 调 vin_set_addr()
   把 Y/Cb/Cr 物理地址写入 CSIC DMA buffer address 寄存器

6. Sensor 输出 RAW 数据
   MIPI CSI → CSI Parser → ISP → VIPP/Scaler

7. CSIC DMA 根据寄存器中的目标地址
   直接把 YUV 写入 DDR buffer

8. VSYNC 中断触发
   E907 根据 first_frame/frame_cnt 更新下一帧 DMA 地址

9. E907 调 vin_detect_buffer_cfg()
   把 melisyuv_paddr/melisyuv_size/melisyuv_sign_id 写入共享配置区

10. Linux 启动后，用户态调用 VIDIOC_SET_PHY2VIR

11. Linux VIN 驱动读取 VIN_SENSOR0_RESERVE_ADDR + VIN_RESERVE_SIZE 处的
    isp_autoflash_config_s

12. Linux 校验 melisyuv_sign_id

13. Linux 用 remap_pfn_range()
    把 melisyuv_paddr 指向的物理 YUV buffer 映射给用户态

14. 用户态直接读 vir_addr，即可得到 E907 阶段预拍的 YUV 图
```

---

## 13. 一帧图像在内存里的布局

从 E907 `vin_set_addr()` 看，普通 YUV420 semi-planar 类布局大致是：

```text
phy_addr
  ↓
+---------------------------+
| Y plane                   |
| size = width * height     |
+---------------------------+
| Cb/UV plane               |
| paddr.cb = phy_addr + Y   |
+---------------------------+
```

如果是三平面 YUV420，则 Linux 侧普通路径里可能是：

```text
Y  = base
Cb = base + pix_size
Cr = Cb + pix_size / 4
```

对应源码：

```330:334:/home/alientek/v821/v821-tina-v12/bsp/drivers/vin/vin-video/vin_video.c
			paddr->cb = (u32)(paddr->y + pix_size);
			/*  420  */
			if (frame->fmt.depth[0] == 12)
				paddr->cr = (u32)(paddr->cb + (pix_size >> 2));
```

如果以 1280x720 YUV420 计算：

```text
Y  = 1280 * 720      = 921600 bytes
UV = 1280 * 720 / 2  = 460800 bytes

总大小 = 1280 * 720 * 3 / 2
       = 1382400 bytes
       ≈ 1.32 MiB
```

这也能解释为什么不可能用 RPMsg 来传完整帧。每帧一百多万字节，30fps 就是几十 MB/s，而 RPMsg 是小包控制通道。

---

## 14. 代码证据链总结

### 证据 1：E907 只配置 DMA 地址

RTOS `vin_set_addr()`：

```text
csic_dma_buffer_address(..., paddr.y/cb/cr)
```

说明是写 DMA 寄存器，不是传图。

### 证据 2：E907 buffer 是 DDR 物理地址

RTOS `buffer_queue()`：

```text
memheap_alloc_align(&isp_mempool, size, 0x1000)
```

或者：

```text
YUV_MEMRESERVE
```

说明图像落在 reserved DDR。

### 证据 3：E907 只把地址写给 Linux

RTOS `vin_detect_buffer_cfg()`：

```text
melisyuv_paddr = buff[0].phy_addr
melisyuv_size = buffer_size
```

说明共享的是地址和大小，不是图像内容。

### 证据 4：Linux 直接映射物理地址

Linux `vidioc_set_phy2vir_cfg()`：

```text
remap_pfn_range(... __phys_to_pfn(melisyuv_paddr) ...)
```

说明 Linux 直接把 E907 预拍 buffer 映射到用户态。

### 证据 5：正常 V4L2 也是 DMA 地址下发

Linux `vin_set_addr()`：

```text
vb2_dma_contig_plane_dma_addr()
csic_dma_buffer_address()
```

说明 Linux 正常采集也是“buffer 物理地址给 DMA”，而非 CPU 搬运。

---

## 15. 最终结论

`perf2_fastboot` 快速出图里的每帧图像传输机制是：

```text
Sensor 输出
  ↓
MIPI CSI / Parser / ISP / VIPP
  ↓
CSIC DMA 直接写 DDR YUV buffer
  ↓
Linux 通过共享结构体拿到物理地址
  ↓
Linux remap_pfn_range 映射到用户态
  ↓
用户态直接读取
```

所以回答“是不是 E907 传给大核”：

**不是。**

更准确说法是：

**E907 负责提前初始化和配置采图硬件，并把 DMA 写入的 YUV buffer 物理地址告诉 Linux；每帧图像数据本体由 CSIC DMA 直接写入共享 DDR。Linux 大核启动后直接映射同一块 DDR 读取，不经过 E907→Linux 的帧数据传输。**

