# A733 VIN/ISP/VPU DDR 与 CMA/IOMMU 内存链路分析

本文整理 A733 SDK 中 VIN/ISP 与 VPU/VE 编解码链路的 DDR 分配机制，重点回答：

1. 用户态编码时 encoder 的 input/internal/VBV buffer 分别来自哪里。
2. 系统运行较大型程序时，VIN/ISP 如何获得所需 buffer，是否有硬保证。
3. 结合具体构建文件确认 Linux 中是否配置了全局 CMA，以及是否存在 VPU/VIN 专用预留内存。

分析范围基于当前 SDK 目录：

- 驱动：`bsp/drivers`
- DTS/DTSI：`bsp/configs/linux-6.6`、`device/config/chips/a733`
- 内核：`kernel/linux-6.6`
- 板级例子：`device/config/chips/a733/configs/pro3`

源码片段均摘自当前 SDK。为便于阅读，代码块只保留和结论直接相关的片段。

## 1. 总结论

A733 这份 Linux 6.6 SDK 中，没有看到给 VPU/VE、VIN/CIF/ISP 单独预留的 `reserved-memory`、`memory-region`、`linux,cma` 或专用 CMA pool。

Linux 确实配置了全局 CMA：

- pro3 buildroot/debian kernel defconfig 启用了 `CONFIG_CMA=y`、`CONFIG_DMA_CMA=y`、`CONFIG_DMABUF_HEAPS_CMA=y`。
- 当前编译产物 `out/a733/kernel/build/.config` 中也确认启用了 CMA。
- pro3 buildroot/debian 的启动参数默认带 `cma=8M`。

但这个 CMA 是全局 CMA，不是 VPU/VIN 专用预留池。pro3 常规启动参数下只有 8M，不能作为高分辨率 VIN + ISP + VENC 多 buffer 链路的主内存来源。

A733 媒体链路真正依赖的是：

```text
普通 DDR 页
  -> dma-buf heap(system/system-uncached)
  -> IOMMU 映射
  -> VIN/ISP/CSI/VE_ENC/VE_DEC 看到连续 IOVA
```

也就是说，A733 通过 IOMMU 把“设备需要连续地址”的问题转成“设备侧 IOVA 连续”，避免每个视频帧都必须占用大块物理连续 DDR/CMA。

这能显著降低 CMA 碎片和物理连续大块分配压力，但不能在系统普通内存被大型程序耗尽时提供绝对保证。若要求严格保证，需要产品侧额外做预分配、内存限制，或者新增 dedicated `reserved-memory/shared-dma-pool`。

## 2. DTS 是否有 VPU/VIN 专用 reserved memory

### 2.1 `reserved-memory` 只有 BL31

文件：`bsp/configs/linux-6.6/sun60iw2p1.dtsi`

```dts
reserved-memory {
	#address-cells = <2>;
	#size-cells = <2>;
	ranges;

	bl31 {
		reg = <0x0 0x48000000 0x0 0x01000000>;
	};
};

chosen {
	bootargs = "earlyprintk=sunxi-uart,0x2500000 loglevel=8 initcall_debug=0 console=ttyS0 init=/init";
	linux,initrd-start = <0x0 0x0>;
	linux,initrd-end = <0x0 0x0>;
	rng-seed;
	kaslr-seed;
};
```

未看到：

- `linux,cma`
- `shared-dma-pool`
- `linux,cma-default`
- `memory-region = <...>`
- VIN/ISP/VE 专用 reserved node

因此，DTS 层面没有给 VIN、ISP、CIF、VPU/VE 预留专用内存块。

### 2.2 IOMMU masters 覆盖 CSI/ISP/VE

文件：`bsp/configs/linux-6.6/sun60iw2p1.dtsi`

```dts
mmu_aw: iommu@3900000 {
	compatible = "allwinner,iommu-v20";
	#iommu-cells = <2>;
	version=<0x16>;
	tlb_prefetch = <0x3007f>;
	tlb_invalid_mode = <0x1>;
	ptw_invalid_mode = <0x1>;

	masters = "USB", "CSI", "ISP", "VE_ENC", "dummy04", "dummy05",
		"VE_DEC0", "VE_DEC1", "DE0","DI","G2D","EINK", "DEBUG_MODE";

	csi_iommu {
		iommu-master;
		id=<1>;
		power-domains = <&pd SUN60IW2_PCK_VI>;
	};

	isp_iommu {
		iommu-master;
		id=<2>;
		power-domains = <&pd SUN60IW2_PCK_VI>;
	};

	ve_enc_iommu {
		iommu-master;
		id=<3>;
		power-domains = <&pd SUN60IW2_PCK_VE_ENC>;
	};
};
```

这说明 A733 的 CSI、ISP、VE_ENC、VE_DEC 都被设计为 IOMMU master。

### 2.3 VE decode/encode 节点挂 IOMMU，没有 memory-region

文件：`bsp/configs/linux-6.6/sun60iw2p1.dtsi`

```dts
ve: ve@1c0e000 {
	compatible = "allwinner,sunxi-cedar-ve";
	reg = <0x0 0x01c0e000 0x0 0x3000>,
	      <0x0 0x03000000 0x0 0x10>;
	interrupts = <GIC_SPI 49 IRQ_TYPE_LEVEL_HIGH>;
	resets = <&ccu RST_BUS_VE_DEC>;
	reset-names = "reset_ve";
	operating-points-v2 = <&ve_opp_table>;
	iommus = <&mmu_aw 6 1>;
	nsi = <&nsi0 7>;
	power-domains = <&pd SUN60IW2_PCK_VE_DEC>;
};

ve1: ve1@1c0e000 {
	compatible = "allwinner,sunxi-cedar-ve1";
	iommus = <&mmu_aw 7 1>;
	nsi = <&nsi0 8>;
};

ve2: ve2@1c10000 {
	compatible = "allwinner,sunxi-cedar-ve2";
	reg = <0x0 0x01c10000 0x0 0x1000>,
	      <0x0 0x03000000 0x0 0x10>;
	interrupts = <GIC_SPI 48 IRQ_TYPE_LEVEL_HIGH>;
	resets = <&ccu RST_BUS_VE_ENC0>;
	reset-names = "reset_ve";
	operating-points-v2 = <&ve_opp_table>;
	iommus = <&mmu_aw 3 1>;
	nsi = <&nsi0 9>;
	power-domains = <&pd SUN60IW2_PCK_VE_ENC>;
	ve_top_reg_offset = <0x800>;
};
```

`ve/ve1/ve2` 都没有 `memory-region`。其中：

- `ve`：VE_DEC0，IOMMU master id 6
- `ve1`：VE_DEC1，IOMMU master id 7
- `ve2`：VE_ENC，IOMMU master id 3

### 2.4 VIN/ISP/CSI 节点挂 IOMMU，没有 memory-region

文件：`bsp/configs/linux-6.6/sun60iw2p1.dtsi`

```dts
tdm0: tdm@5908000 {
	compatible = "allwinner,sunxi-tdm";
	reg = <0x0 0x05908000 0x0 0x400>;
	interrupts = <GIC_SPI 134 IRQ_TYPE_LEVEL_HIGH>;
	work_mode = <0x0>;
	device_id = <0>;
	iommus = <&mmu_aw 2 0>;
	status = "okay";
};

isp00:isp@5900000 {
	compatible = "allwinner,sunxi-isp";
	reg = <0x0 0x05900000 0x0 0x1300>;
	interrupts = <GIC_SPI 129 IRQ_TYPE_LEVEL_HIGH>;
	work_mode = <0x0>;
	device_id = <0>;
	iommus = <&mmu_aw 2 0>;
	status = "okay";
};

scaler00:scaler@5910000 {
	compatible = "allwinner,sunxi-scaler";
	reg = <0x0 0x05910000 0x0 0x400>;
	interrupts = <GIC_SPI 121 IRQ_TYPE_LEVEL_HIGH>;
	work_mode = <0x0>;
	device_id = <0>;
	iommus = <&mmu_aw 1 0>;
	status = "okay";
};
```

其中：

- ISP/TDM 走 IOMMU master id 2。
- CSI/scaler/VINC 走 IOMMU master id 1。
- 同样没有 `memory-region`。

### 2.5 pro3 板级只 enable VIN/ISP/VINC，没有加内存区

文件：`device/config/chips/a733/configs/pro3/linux-6.6/board.dts`

```dts
&vind0 {
	csi_top = <600000000>;
	csi_isp = <540000000>;
	vind_mclkpin-supply = <&reg_bldo1>;
	vind_mclkpin_vol = <1800000>;
	vind_mcsipin-supply = <&reg_bldo1>;
	vind_mcsipin_vol = <1800000>;
	vind_mipipin-supply = <&reg_bldo1>;
	vind_mipipin_vol = <1800000>;

	status = "okay";

	csi1: csi@5821000 {
		pinctrl-0 = <>;
		pinctrl-1 = <>;
		status = "okay";
	};

	csi2: csi@5822000 {
		pinctrl-0 = <>;
		pinctrl-1 = <>;
		status = "okay";
	};

	tdm0:tdm@5908000 {
		work_mode = <1>;
	};

	isp00:isp@5900000 {
		work_mode = <1>;
	};
};
```

VINC 例子：

```dts
vinc00:vinc@5830000 {
	vinc0_csi_sel = <1>;
	vinc0_mipi_sel = <1>;
	vinc0_isp_sel = <0>;
	vinc0_isp_tx_ch = <0>;
	vinc0_tdm_rx_sel = <0>;
	vinc0_rear_sensor_sel = <0>;
	vinc0_front_sensor_sel = <0>;
	vinc0_sensor_list = <0>;
	device_id = <0>;
	work_mode = <0x1>;
	/* dma-coherent; */
	status = "okay";
};

vinc01:vinc@582fffc {
	vinc1_csi_sel = <1>;
	vinc1_mipi_sel = <1>;
	vinc1_isp_sel = <1>;
	vinc1_isp_tx_ch = <0>;
	vinc1_tdm_rx_sel = <1>;
	vinc1_rear_sensor_sel = <0>;
	vinc1_front_sensor_sel = <0>;
	vinc1_sensor_list = <0>;
	device_id = <1>;
	/* dma-coherent; */
	status = "okay";
};
```

板级文件仍未给 VIN/ISP/VINC 设置 `memory-region`。

## 3. Linux 是否配置了全局 CMA

### 3.1 pro3 使用的 kernel defconfig

文件：`device/config/chips/a733/configs/pro3/buildroot/BoardConfig.mk`

```makefile
LICHEE_BR_DEFCONF:=sun60iw2p1_aiot_defconfig
LICHEE_KERN_DEFCONF:=bsp_defconfig
LICHEE_KERN_DEFCONF_RECOVERY:=bsp_recovery_defconfig
```

文件：`device/config/chips/a733/configs/pro3/debian/BoardConfig.mk`

```makefile
LICHEE_KERN_DEFCONF:=bsp_defconfig
```

因此 pro3 buildroot/debian 常规内核配置入口是各自目录下的 `linux-6.6/bsp_defconfig`。

### 3.2 pro3 buildroot/debian defconfig 启用 CMA/IOMMU/VIN/VE

文件：`device/config/chips/a733/configs/pro3/buildroot/linux-6.6/bsp_defconfig`

```text
CONFIG_AW_IOMMU=y
CONFIG_AW_IOMMU_V2=y
CONFIG_AW_VIDEO_SUNXI_VIN=m
CONFIG_AW_VIDEO_ENCODER_DECODER=m
CONFIG_CMA=y
CONFIG_DMABUF_HEAPS=y
CONFIG_DMABUF_HEAPS_SYSTEM=y
CONFIG_DMABUF_HEAPS_CMA=y
CONFIG_DMA_CMA=y
```

文件：`device/config/chips/a733/configs/pro3/debian/linux-6.6/bsp_defconfig`

```text
CONFIG_AW_IOMMU=y
CONFIG_AW_IOMMU_V2=y
CONFIG_AW_VIDEO_SUNXI_VIN=m
CONFIG_AW_VIDEO_ENCODER_DECODER=m
CONFIG_CMA=y
CONFIG_DMABUF_HEAPS=y
CONFIG_DMABUF_HEAPS_SYSTEM=y
CONFIG_DMABUF_HEAPS_CMA=y
CONFIG_DMA_CMA=y
```

当前编译产物也确认了这些配置。

文件：`out/a733/kernel/build/.config`

```text
CONFIG_AW_IOMMU=y
CONFIG_AW_IOMMU_V2=y
CONFIG_AW_VIDEO_SUNXI_VIN=m
CONFIG_VIN_IOMMU=y
CONFIG_AW_VIDEO_ENCODER_DECODER=m
CONFIG_CMA=y
CONFIG_CMA_AREAS=7
CONFIG_DMABUF_HEAPS=y
CONFIG_DMABUF_HEAPS_SYSTEM=y
CONFIG_DMABUF_HEAPS_CMA=y
CONFIG_DMA_CMA=y
CONFIG_CMA_SIZE_MBYTES=16
```

### 3.3 运行时 CMA 大小由 bootargs 覆盖

文件：`device/config/chips/a733/configs/pro3/buildroot/env.cfg`

```text
cma=8M

setargs_nand=setenv bootargs ... cma=${cma} ...
setargs_mmc=setenv  bootargs ... cma=${cma} ...
setargs_ufs=setenv  bootargs ... cma=${cma} ...
```

文件：`device/config/chips/a733/configs/pro3/debian/env.cfg`

```text
cma=8M

setargs_nand=setenv bootargs ... cma=${cma} ...
setargs_mmc=setenv  bootargs ... cma=${cma} ...
setargs_ufs=setenv  bootargs ... cma=${cma} ...
```

文件：`device/config/chips/a733/configs/pro3/dragonboard/env.cfg`

```text
cma=64M

setargs_nor=setenv bootargs ... cma=${cma} ...
setargs_nand=setenv bootargs ... cma=${cma} ...
setargs_mmc=setenv  bootargs ... cma=${cma} ...
setargs_ufs=setenv  bootargs ... cma=${cma} ...
```

因此：

- pro3 buildroot/debian：运行时大概率 `cma=8M`
- pro3 dragonboard：运行时 `cma=64M`
- 如果 bootargs 没传 `cma=...`，则回退到 kernel config，例如当前产物 `CONFIG_CMA_SIZE_MBYTES=16`，或上游 arm64 defconfig 中的 `CONFIG_CMA_SIZE_MBYTES=32`

板上最终以如下命令为准：

```sh
cat /proc/cmdline | tr ' ' '\n' | grep '^cma='
grep -E 'CmaTotal|CmaFree' /proc/meminfo
dmesg | grep -i cma
```

## 4. VIN/ISP 内存分配路径

### 4.1 VIN_IOMMU 默认打开

文件：`bsp/drivers/vin/Kconfig`

```kconfig
config AW_VIDEO_SUNXI_VIN
       tristate "sunxi video input (camera csi/mipi isp vipp) driver"
       select MEDIA_SUPPORT
       default n

config CSI_VIN
	tristate "v4l2 new driver for SUNXI"
	depends on AW_VIDEO_SUNXI_VIN
	default m
	select VIDEOBUF2_DMA_CONTIG

config VIN_IOMMU
	bool "use IOMMU for memery alloc"
	depends on AW_VIDEO_SUNXI_VIN
	default y
```

当前 `out/a733/kernel/build/.config` 中也有：

```text
CONFIG_AW_VIDEO_SUNXI_VIN=m
CONFIG_VIN_IOMMU=y
```

### 4.2 VIN 辅助内存：IOMMU 模式走 system-uncached，非 IOMMU 才走 reserved

文件：`bsp/drivers/vin/utility/vin_os.c`

```c
int os_mem_alloc(struct device *dev, struct vin_mm *mem_man)
{
	int ret = -1;

	if (mem_man == NULL)
		return -1;

#ifdef SUNXI_MEM
#if IS_ENABLED(CONFIG_AW_IOMMU) && IS_ENABLED(CONFIG_VIN_IOMMU)
	/* DMA BUFFER HEAP (after linux 5.10) */
	mem_man->dmaHeap = dma_heap_find("system-uncached");
	if (!mem_man->dmaHeap) {
		vin_err("dma_heap_find failed\n");
		goto err_alloc;
	}
	mem_man->buf = dma_heap_buffer_alloc(mem_man->dmaHeap, mem_man->size, O_RDWR, 0);
	if (IS_ERR(mem_man->buf)) {
		vin_err("dma_heap_buffer_alloc failed\n");
		goto err_alloc;
	}
#else
	/* CMA or CARVEOUT */
	mem_man->dmaHeap = dma_heap_find("reserved");
	if (!mem_man->dmaHeap) {
		vin_err("dma_heap_find failed\n");
		goto err_alloc;
	}
	mem_man->buf = dma_heap_buffer_alloc(mem_man->dmaHeap, mem_man->size, O_RDWR, 0);
	if (IS_ERR(mem_man->buf)) {
		vin_err("dma_heap_buffer alloc failed\n");
		goto err_alloc;
	}
#endif

	ret = dma_buf_vmap(mem_man->buf, &map);
	if (ret) {
		vin_err("dma_buf_vmap failed!!");
		goto err_map_kernel;
	}
	mem_man->vir_addr = map.vaddr;

	/* IOMMU or CMA or CARVEOUT */
	ret = vin_get_ion_phys(dev, mem_man);
	if (ret) {
		vin_err("ion_phys failed!!");
		goto err_phys;
	}
	mem_man->dma_addr = mem_man->phy_addr;

	return ret;
#else
	mem_man->vir_addr = dma_alloc_coherent(dev, (size_t) mem_man->size,
					(dma_addr_t *)&mem_man->phy_addr,
					GFP_KERNEL);
	if (!mem_man->vir_addr) {
		vin_err("dma_alloc_coherent memory alloc failed\n");
		return -ENOMEM;
	}
	mem_man->dma_addr = mem_man->phy_addr;
	ret = 0;
	return ret;
#endif
}
```

关键点：

- `CONFIG_AW_IOMMU && CONFIG_VIN_IOMMU`：使用 `system-uncached` heap。
- 非 IOMMU：才使用 `reserved` heap，即 CMA/carveout 路径。
- `mem_man->phy_addr` 命名不完全准确，IOMMU 模式下应理解为设备可访问 DMA 地址/IOVA。

### 4.3 VIN 通过 dma-buf attach/map 获得设备地址

文件：`bsp/drivers/vin/utility/vin_os.c`

```c
attachment = dma_buf_attach(mem_man->buf, get_device(dev));
if (IS_ERR(attachment)) {
	pr_err("dma_buf_attach failed\n");
	goto err_buf_attach;
}

sgt = dma_buf_map_attachment(attachment, DMA_FROM_DEVICE);
if (IS_ERR_OR_NULL(sgt)) {
	pr_err("dma_buf_map_attachment failed\n");
	goto err_buf_map_attachment;
}

mem_man->phy_addr = (void *)sg_dma_address(sgt->sgl);
mem_man->sgt = sgt;
mem_man->attachment = attachment;
```

当设备挂在 IOMMU 后面时，`sg_dma_address()` 返回的是设备 DMA 地址，也就是 IOVA。

### 4.4 VIN 硬件 IOMMU 开关

文件：`bsp/drivers/vin/utility/vin_os.c`

```c
extern void sunxi_enable_device_iommu(unsigned int master_id, bool flag);

void vin_iommu_en(unsigned int mester_id, bool en)
{
#if IS_ENABLED(CONFIG_AW_IOMMU) && IS_ENABLED(CONFIG_VIN_IOMMU)
	sunxi_enable_device_iommu(mester_id, en);
#endif
}
EXPORT_SYMBOL_GPL(vin_iommu_en);
```

VIN 子模块中 CSI/ISP/scaler/tdm 会按 master id 调用这个接口打开/关闭 IOMMU。

### 4.5 V4L2 capture queue 使用 vb2_dma_contig

文件：`bsp/drivers/vin/vin-video/vin_video.c`

```c
q->io_modes = VB2_MMAP | VB2_USERPTR | VB2_DMABUF | VB2_READ;
q->drv_priv = cap;
q->buf_struct_size = sizeof(struct vin_buffer);
q->ops = &vin_video_qops;
q->mem_ops = &vb2_dma_contig_memops;
```

地址获取：

```c
paddr->y = vb2_dma_contig_plane_dma_addr(vb, 0);

if (planar_fmt) {
	paddr->cb = vb2_dma_contig_plane_dma_addr(vb, 1);
	paddr->cr = vb2_dma_contig_plane_dma_addr(vb, 2);
}

vb->planes[i].m.offset = vb2_dma_contig_plane_dma_addr(vb, i);
```

`vb2_dma_contig` 名字里有 `contig`，但对 IOMMU 设备而言，DMA API 可以提供连续 IOVA，而底层物理页不必是大块连续内存。

### 4.6 VIN online 模式可减少 buffer 数

文件：`bsp/drivers/vin/vin-video/vin_video.c`

```c
if (cap->vinc->ve_online_cfg.dma_buf_num == BK_TWO_BUFFER &&
    cap->vinc->id == CSI_VE_ONLINE_VIDEO && *nbuffers != 2) {
	*nbuffers = 2;
} else if (cap->vinc->ve_online_cfg.dma_buf_num == BK_ONE_BUFFER &&
	   cap->vinc->id == CSI_VE_ONLINE_VIDEO && *nbuffers != 1) {
	*nbuffers = 1;
}

alloc_devs[i] = cap->dev;
cap->vinc->vin_status.buf_cnt = *nbuffers;
cap->vinc->vin_status.buf_size = size;
```

这说明在线 VIN -> VE 场景下，SDK 有减少 capture buffer 数的策略，用于降低内存占用和延迟。非 online 常规采集仍按 V4L2 buffer 请求和驱动约束走。

## 5. VE/VPU 编解码驱动内存路径

### 5.1 VE 驱动被配置为模块

文件：`bsp/drivers/ve/cedar-ve/Kconfig`

```kconfig
config AW_VIDEO_ENCODER_DECODER
	tristate "sunxi video encoder and decoder support"
	select DMA_SHARED_BUFFER
	default y
	help
	  This is the driver for sunxi video decoder, including h264/
	  mpeg4/mpeg2/vc1/rmvb.
	  To compile this driver as a module, choose M here: the
	  module will be called cedar_dev.
```

pro3 buildroot/debian defconfig 和当前 `.config` 中均有：

```text
CONFIG_AW_VIDEO_ENCODER_DECODER=m
```

### 5.2 `/dev/cedar_dev` 把用户态 dma-buf fd 映射成 VE 可访问地址

文件：`bsp/drivers/ve/cedar-ve/cedar_ve.c`

```c
static int map_dma_buf_addr(struct cedar_dev *cedar_devp,
			    int fd, unsigned int *addr)
{
	struct sg_table *sgt;
	struct dma_buf_info *buf_info;

	buf_info = (struct dma_buf_info *)kmalloc(sizeof(*buf_info), GFP_KERNEL);
	if (buf_info == NULL) {
		VE_LOGE("malloc dma_buf_info error\n");
		return -1;
	}

	memset(buf_info, 0, sizeof(*buf_info));
	buf_info->dma_buf = dma_buf_get(fd);
	if (IS_ERR_OR_NULL(buf_info->dma_buf)) {
		VE_LOGE("ve get dma_buf error\n");
		goto BUF_FREE;
	}

	buf_info->attachment = dma_buf_attach(buf_info->dma_buf, cedar_devp->plat_dev);
	if (IS_ERR_OR_NULL(buf_info->attachment)) {
		VE_LOGE("ve get dma_buf_attachment error\n");
		goto BUF_PUT;
	}

#if (LINUX_VERSION_CODE >= KERNEL_VERSION(6, 6, 0))
	sgt = dma_buf_map_attachment_unlocked(buf_info->attachment, DMA_BIDIRECTIONAL);
#else
	sgt = dma_buf_map_attachment(buf_info->attachment, DMA_BIDIRECTIONAL);
#endif
	buf_info->sgt = sgt;
	if (IS_ERR_OR_NULL(buf_info->sgt)) {
		VE_LOGE("ve get sg_table error\n");
		goto BUF_DETATCH;
	}

	buf_info->addr = sg_dma_address(buf_info->sgt->sgl);
	buf_info->fd = fd;
	buf_info->p_id = current->tgid;
	buf_info->cedar_devp = cedar_devp;
```

ioctl 入口：

```c
case IOCTL_GET_IOMMU_ADDR: {
	/* just for compatible, kernel 5.4 should not use it */
	struct user_iommu_param parm;
	cedar_devp->bMemDevAttachFlag = 1;

	data_to_kernel((void *)&parm, (void *)arg, sizeof(parm), from_kernel);
	if (map_dma_buf_addr(cedar_devp, parm.fd, &parm.iommu_addr) != 0) {
		VE_LOGE("IOCTL_GET_IOMMU_ADDR map dma buf fail\n");
		return -EFAULT;
	}

	data_to_other((void *)arg, &parm, sizeof(parm), from_kernel);
	break;
}

case IOCTL_FREE_IOMMU_ADDR: {
	struct user_iommu_param parm;

	data_to_kernel((void *)&parm, (void *)arg, sizeof(parm), from_kernel);
	unmap_dma_buf_addr(cedar_devp, 0, parm.fd);
	break;
}

case IOCTL_MAP_DMA_BUF: {
	struct dma_buf_param parm;
	cedar_devp->bMemDevAttachFlag = 1;

	data_to_kernel((void *)&parm, (void *)arg, sizeof(parm), from_kernel);
	if (map_dma_buf_addr(cedar_devp, parm.fd, &parm.phy_addr) != 0) {
		VE_LOGE("IOCTL_GET_IOMMU_ADDR map dma buf fail\n");
		return -EFAULT;
	}
	data_to_other((void *)arg, &parm, sizeof(parm), from_kernel);
	break;
}
```

设备节点：

```c
static struct cedar_ve_quirks cedar_ve_quirk = {
	.ve_mod = VE_MODULE_NORMAL,
	.class_name = "cedar_ve",
	.dev_name = "cedar_dev",
};

static struct cedar_ve_quirks cedar_ve2_quirk = {
	.ve_mod = VE_MODULE_2,
	.class_name = "cedar_ve2",
	.dev_name = "cedar_dev_ve2",
};

static struct of_device_id sunxi_cedar_match[] = {
	{
		.compatible = "allwinner,sunxi-cedar-ve",
		.data = &cedar_ve_quirk,
	},
	{
		.compatible = "allwinner,sunxi-cedar-ve1",
		.data = &cedar_ve1_quirk,
	},
	{
		.compatible = "allwinner,sunxi-cedar-ve2",
		.data = &cedar_ve2_quirk,
	},
};
```

结论：

- 用户态分配 dma-buf fd。
- VE 驱动 attach/map 这个 fd。
- `sg_dma_address()` 给 VE 使用。
- IOMMU 打开时，这个地址是 IOVA。

## 6. 用户态 Cedar/libawion 的内存来源

### 6.1 A733 Cedar 编译参数倾向 IOMMU

文件：`buildroot/package/allwinner/multimedia/tina_multimedia/machinfo/a733/config.mk`

```makefile
MEDIA_TARGET_BOARD_PLATFORM=y
AUDIO_GAIN_TOOLCHAIN_OF_AARCH64=y
MEDIA_TARGET_PLATFORM=buildroot
TINA_CHIP_TYPE = A733
CEDARX_EXTRA_CXXFLAGS = -DCONF_H265_4K
CEDARC_EXTRA_CXXFLAGS += -DCONF_USE_IOMMU -D__LINUX__
VE_OFFSET = 0
```

这里明确给 A733 的 CedarC 加了 `-DCONF_USE_IOMMU`。

### 6.2 libcedarc/libcedarx 通过 `CONFIG_AW_ION_ALLOC_*` 选择 ION/CMA/IOMMU 类型

文件：`buildroot/package/allwinner/multimedia/tina_multimedia/libcedarc/Makefile`

```makefile
#config the cma type
ifeq ($(CONFIG_AW_ION_ALLOC_CMA),y)
    KERNEL_VERSION_ION = CONF_KERNEL_CMA
endif
ifeq ($(CONFIG_AW_ION_ALLOC_IOMMU),y)
    KERNEL_VERSION_ION = CONF_KERNEL_IOMMU
endif
```

同文件中还导出 libcedarc 内部 IOMMU 开关：

```makefile
#config if use iommu
ifeq ($(CONFIG_libcedarc_iommu),y)
    USE_IOMMU := true
else
    USE_IOMMU := false
endif
export USE_IOMMU
```

文件：`buildroot/package/allwinner/multimedia/tina_multimedia/libcedarx/Makefile`

```makefile
#config the cma type
ifeq ($(CONFIG_AW_ION_ALLOC_CMA),y)
    KERNEL_VERSION_ION = CONF_KERNEL_CMA
endif
ifeq ($(CONFIG_AW_ION_ALLOC_IOMMU),y)
    KERNEL_VERSION_ION = CONF_KERNEL_IOMMU
endif
```

注意：当前 `buildroot/buildroot-202205/configs/sun60iw2p1_aiot_defconfig` 中没有直接看到 `AW_ION_ALLOC_IOMMU=y`。因此最终用户态库是否一定带 `CONF_KERNEL_IOMMU`，要看最终 rootfs `.config` 或编译日志。内核和驱动侧已经为 IOMMU 路径准备好，A733 machinfo 也明确倾向 IOMMU。

### 6.3 libawion 在 Linux 5.15/6.6 使用 dma-heap

文件：`platform/allwinner/common/libawion/src/ion_alloc_5_15.c`

```c
#define DEV_NAME                "/dev/dma_heap/reserved" //for cma with cache, cma must be with cache!
#define DEV_NAME_CARVEOUT       "/dev/dma_heap/carveout" //for carveout with cache, cma must be with cache!
#define DEV_NAME_IOMMU          "/dev/dma_heap/system" //for iommu with cache
#define DEV_NAME_IOMMU_UNCACHED "/dev/dma_heap/system-uncached" //for iommu without cache
#define DEFAULT_IOMMU_DEV_NAME  "/dev/cedar_dev" //for iommu, cedar_ve can operate iommu too.
#define DEV_NAME_SIZE_POOL      "/dev/dma_heap/size_pool" //for size pool
```

### 6.4 pallocExtend 根据 heap type 分配

文件：`platform/allwinner/common/libawion/src/ion_alloc_5_15.c`

```c
void* sunxi_ion_alloc_pallocExtend(IonAllocAttr *pAttr)
{
	struct dma_heap_allocation_data alloc_data;
	struct user_iommu_param iommu_param;
	unsigned long addr_phy = 0;
	unsigned long addr_vir = 0;
	int ret = 0;

	memset(&alloc_data, 0, sizeof(alloc_data));

	alloc_data.len = (size_t)pAttr->nLen;
	alloc_data.fd_flags = O_RDWR | O_CLOEXEC;

	IonHeapType eIonHeapType = pAttr->eIonHeapType;
	int nHeapFd = 0;

	if(IonHeapType_IOMMU == eIonHeapType)
	{
		if(pAttr->bSupportCache)
		{
			nHeapFd = g_ion_alloc_context->iommuHeapFd;
		}
		else
		{
			nHeapFd = g_ion_alloc_context->iommuUncachedHeapFd;
		}
	}
	else if(IonHeapType_POOL == eIonHeapType)
	{
		nHeapFd = g_ion_alloc_context->sizepoolHeapFd;
	}
	else
	{
		nHeapFd = g_ion_alloc_context->cmaHeapfd;
	}

	ret = ioctl(nHeapFd, DMA_HEAP_IOCTL_ALLOC, &alloc_data);
	if (ret < 0)
	{
		loge("fatal error! AW_ION_IOC_NEW_ALLOC error\n");
		goto ALLOC_OUT;
	}

	/* mmap to user */
	addr_vir = (unsigned long)mmap(NULL, alloc_data.len,
		PROT_READ|PROT_WRITE, MAP_SHARED, alloc_data.fd, 0);

	/* get phy address */
	memset(&iommu_param, 0, sizeof(iommu_param));
	iommu_param.fd = alloc_data.fd;

	if (access("/dev/cedar_dev", F_OK) == 0)
	{
		ret = ioctl(g_ion_alloc_context->iommu_dev_fd,
			IOCTL_GET_IOMMU_ADDR, &iommu_param);
		if (ret)
		{
			loge("fatal error! GET_IOMMU_ADDR err, ret %d\n", ret);
			addr_phy = 0;
			addr_vir = 0;
			goto ALLOC_OUT;
		}
	}
```

这段说明：

- `IonHeapType_IOMMU`：使用 `system` 或 `system-uncached`。
- `IonHeapType_POOL`：使用 `size_pool`。
- 其它：使用 `cmaHeapfd`，即 `reserved/carveout`。
- 分配 fd 后，若 `/dev/cedar_dev` 存在，会通过 `IOCTL_GET_IOMMU_ADDR` 得到 VE IOVA。

### 6.5 默认 palloc 的 heap 选择

文件：`platform/allwinner/common/libawion/src/ion_alloc_5_15.c`

```c
void* sunxi_ion_alloc_palloc(int size)
{
	IonAllocAttr stAttr;
	memset(&stAttr, 0, sizeof(stAttr));
	stAttr.nLen = size;
#if defined(CONF_KERNEL_IOMMU)
	stAttr.eIonHeapType = IonHeapType_IOMMU;
#elif defined(CONF_AWION_SIZE_POOL_HEAP)
	stAttr.eIonHeapType = IonHeapType_POOL;
#else
	stAttr.eIonHeapType = IonHeapType_CARVEOUT;
#endif
	stAttr.bSupportCache = true;
	return sunxi_ion_alloc_pallocExtend(&stAttr);
}
```

因此普通用户态编码的输入 buffer 和编码库内部 buffer 大体有三种来源：

| 编译/运行路径 | heap | 设备地址来源 | 是否依赖 CMA |
|---|---|---|---|
| `CONF_KERNEL_IOMMU` | `/dev/dma_heap/system` 或 `system-uncached` | `/dev/cedar_dev` 映射 IOVA | 不依赖大块 CMA |
| `CONF_AWION_SIZE_POOL_HEAP` | `/dev/dma_heap/size_pool` | 取决于 size_pool 实现和 VE 映射 | 不按普通 CMA 理解 |
| 默认/非 IOMMU | `/dev/dma_heap/reserved` 或 `carveout` | 物理/CMA/carveout 地址 | 依赖 CMA/carveout |

## 7. Encoder 输入 buffer、内部 buffer、VBV buffer

### 7.1 camera online encode：VENC 使用 VIN/VI 输出 frame

文件：`bsp/drivers/rt-media/rt_media.c`

```c
if (recoder->vi_comp && recoder->venc_comp) {
	connect_flag = 1;
	comp_setup_tunnel(recoder->venc_comp, COMP_INPUT_PORT, recoder->vi_comp, connect_flag);
	comp_setup_tunnel(recoder->vi_comp, COMP_OUTPUT_PORT, recoder->venc_comp, connect_flag);
}
```

文件：`bsp/drivers/rt-media/component/rt_venc_component.c`

```c
memset(&base_config, 0, sizeof(VencBaseConfig));

base_config.bOnlineMode       = 1; //venc_comp->base_config.bOnlineMode;
base_config.bOnlineChannel    = venc_comp->base_config.bOnlineChannel;
base_config.nOnlineShareBufNum = venc_comp->base_config.share_buf_num;
base_config.bEncH264Nalu      = 0;
base_config.nInputWidth       = venc_comp->base_config.src_width;
base_config.nInputHeight      = venc_comp->base_config.src_height;
```

离线/普通 queue 逻辑中，VENC 使用当前 video frame 的地址：

```c
memset(&in_buf, 0, sizeof(VencInputBuffer));
in_buf.nID       = cur_video_frame.id;
in_buf.nPts      = cur_video_frame.pts;
in_buf.nFlag     = 0;
in_buf.pAddrPhyY = cur_video_frame.phy_addr[0];
in_buf.pAddrPhyC = cur_video_frame.phy_addr[1];
in_buf.pAddrVirY = (unsigned char *)cur_video_frame.vir_addr[0];
in_buf.pAddrVirC = (unsigned char *)cur_video_frame.vir_addr[1];

venc_comp->vencCallBack.empty_in_buffer_done = venc_empty_in_buffer_done;
VencSetCallbacks(venc_comp->vencoder, &venc_comp->vencCallBack,
	venc_comp, &cur_video_frame);

result = VencQueueInputBuf(venc_comp->vencoder, &in_buf);
if (result != 0) {
	RT_LOGE("fatal error! VencQueueInputBuf fail[%d]", result);
}
```

结论：

- 如果是 VIN/VI -> VENC online/tunnel，encoder input 可以复用 VIN/VI 传递来的 frame buffer。
- 这里的 `pAddrPhyY` 在 IOMMU 路径下应按 IOVA 理解。

### 7.2 普通用户态编码：input buffer 由应用/编码库自己分配或 import

如果用户态应用不是从 VIN 直接拿 dmabuf，而是自己准备 YUV input，例如：

- 从文件读 YUV
- 算法输出 raw frame
- 其它模块生成图像

则 input frame 不会天然来自 VIN。常见路径是：

1. 应用或 sample 调用 libawion/Cedar memory ops。
2. libawion 从 `system/system-uncached` 或 `reserved/carveout` 分配 dma-buf。
3. 通过 `/dev/cedar_dev` 获取 IOVA。
4. 把 virtual address + IOVA 填到 `VencInputBuffer`。
5. 调 `VencQueueInputBuf()`。

如果应用直接 import VIN dmabuf/share fd，则可以避免 input frame 额外拷贝和重新分配。

### 7.3 VBV/bitstream buffer 由 VENC/Cedar 分配，不来自 VIN

文件：`bsp/drivers/rt-media/component/rt_venc_component.c`

```c
case COMP_INDEX_VENC_CONFIG_GET_VBV_BUF_INFO: {
	KERNEL_VBV_BUFFER_INFO *param_vbv = (KERNEL_VBV_BUFFER_INFO *)param_data;
	VbvInfo vbv_info;
	int share_fd = 0;

	memset(&vbv_info, 0, sizeof(VbvInfo));

	if (venc_comp->vencoder_init_flag == 0) {
		RT_LOGD("get vbv info: vencoder not init");
		return ERROR_TYPE_ERROR;
	}

	VencGetParameter(venc_comp->vencoder, VENC_IndexParamVbvInfo, &vbv_info);
	param_vbv->size = vbv_info.vbv_size;

	VencGetParameter(venc_comp->vencoder, VENC_IndexParamGetVbvShareFd, &share_fd);
	param_vbv->share_fd = share_fd;

	RT_LOGW("get vbv info: share_fd = %d, size = %d", param_vbv->share_fd, param_vbv->size);
	break;
}
```

文件：`bsp/drivers/rt-media/rt_media.c`

```c
KERNEL_VBV_BUFFER_INFO venc_vbv_info;

memset(&venc_vbv_info, 0, sizeof(KERNEL_VBV_BUFFER_INFO));

error = comp_get_config(recoder->venc_comp,
	COMP_INDEX_VENC_CONFIG_GET_VBV_BUF_INFO, &venc_vbv_info);
if (error != ERROR_TYPE_OK) {
	RT_LOGI("get vbv buf info failed");
	return -1;
}
```

结论：

- VBV/bitstream buffer 是 encoder/Cedar 管理的 buffer。
- 它有自己的 share fd。
- 它不是 VIN/ISP capture buffer。
- 在 IOMMU 配置下，其底层也应走 libawion/dma-heap + VE IOVA 路径。

## 8. 大型程序运行时 VIN/ISP buffer 是否有硬保证

没有看到 SDK 通过专用 reserved memory 给 VIN/ISP 提供硬保证。

实际机制是：

1. VIN/ISP/CSI/VE 都挂 IOMMU。
2. VIN 辅助内存在 IOMMU 模式从 `system-uncached` 分配。
3. V4L2 capture buffer 通过 DMA/VB2 映射为设备可见地址。
4. VE 用户态 buffer 通过 libawion/dma-heap 分配，再由 `/dev/cedar_dev` 映射成 IOVA。
5. camera online encode 可以减少 buffer 数或复用 dmabuf，从而降低内存占用。

这种设计解决的是：

- 大块物理连续内存难分配。
- CMA 碎片导致高分辨率帧分配失败。
- VIN 和 VENC 之间重复拷贝/重复分配。

但它不解决：

- 系统总可用内存不足。
- 大型程序已经把普通内存吃光。
- 内存 cgroup/OOM 策略不合理导致媒体进程被压制。
- 应用启动太晚，无法申请到足够页。

因此，若大型程序已经造成严重内存压力，VIN/ISP 的 `REQBUFS`、`STREAMON`、内部 `dma_heap_buffer_alloc()` 或编码器 input/VBV 分配仍可能失败。

产品侧若需要稳定保证，建议：

1. 相机/编码链路尽早启动，提前申请并持有 buffer。
2. 使用 dmabuf zero-copy，避免 VIN -> VENC 额外 input buffer。
3. 限制大型应用内存，例如 cgroup、ulimit、OOM score、服务启动顺序。
4. 按分辨率、格式、buffer count 计算媒体链路峰值内存。
5. 如果必须硬隔离，新增 dedicated `reserved-memory/shared-dma-pool`，并在驱动/DTS 中绑定 `memory-region`。
6. 若回退到 CMA/carveout 路径，要显著增大 `cma=`，因为 pro3 默认 `cma=8M` 不足以支撑高分辨率多帧媒体链路。

## 9. 三个问题的直接回答

### 9.1 用户态编码需求时，encoder 分别用什么内存块

普通用户态 encoding 不会自动使用 VIN/ISP buffer。

encoder input buffer 来源取决于应用：

- 如果输入来自 VIN online/tunnel，则使用 VIN/VI 输出 frame buffer，VENC import/queue。
- 如果输入来自用户态 YUV/算法输出，则应用或编码库通过 libawion 分配 input frame buffer。
- 如果应用传入 dmabuf/share fd，则 VENC/cedar 驱动把这个 fd 映射成 IOVA 使用。

encoder 内部/reference/VBV buffer：

- 由 Cedar/VENC 库管理。
- 通过同一套 libawion/dma-heap 路径分配。
- IOMMU 配置下走 `/dev/dma_heap/system` 或 `system-uncached`，再通过 `/dev/cedar_dev` 获取 IOVA。
- 非 IOMMU/CMA 配置下走 `/dev/dma_heap/reserved` 或 `carveout`。

### 9.2 大程序运行时 VIN/ISP 怎么保证拿到 buffer

SDK 没有通过专用预留内存硬保证。

A733 的主要策略是 IOMMU：

- VIN/ISP/CSI/VE 看到连续 IOVA。
- 底层可以是普通 DDR 页，不要求大块物理连续。
- 因此不主要依赖 CMA 大块连续分配。

但如果系统普通内存耗尽，仍然会失败。要做到产品级保证，需要系统策略配合，例如提前申请、长期持有、限制大程序内存、使用 zero-copy、必要时新增 reserved-memory。

### 9.3 Linux 中是否配置有全局 CMA

有。

证据：

- pro3 buildroot/debian defconfig 有 `CONFIG_CMA=y`、`CONFIG_DMA_CMA=y`、`CONFIG_DMABUF_HEAPS_CMA=y`。
- 当前 `out/a733/kernel/build/.config` 有 `CONFIG_CMA=y`、`CONFIG_CMA_AREAS=7`、`CONFIG_CMA_SIZE_MBYTES=16`。
- pro3 buildroot/debian `env.cfg` 用 bootargs 设置 `cma=8M`。

但这个全局 CMA：

- 不是 VPU/VIN 专用。
- 不是 DTS reserved memory。
- 常规 pro3 启动参数下只有 8M。
- 不应被理解为 VIN/ISP/VE 高分辨率帧池。

## 10. 板上运行态确认命令

建议在目标板上执行：

```sh
cat /proc/cmdline | tr ' ' '\n' | grep '^cma='
grep -E 'CmaTotal|CmaFree' /proc/meminfo
dmesg | grep -i cma
ls -l /dev/dma_heap/
ls -l /dev/cedar_dev /dev/cedar_dev_ve2
cat /sys/kernel/debug/dma_buf/bufinfo 2>/dev/null | head
```

关键判断：

- 如果实际编码时使用 `/dev/dma_heap/system` 或 `/dev/dma_heap/system-uncached`，并通过 `/dev/cedar_dev` 映射 IOVA，则是 A733 预期的 IOMMU 路径。
- 如果实际使用 `/dev/dma_heap/reserved` 或 `/dev/dma_heap/carveout`，则是 CMA/carveout 路径。pro3 默认 `cma=8M` 对高分辨率 VIN + VENC 多 buffer 链路通常不足。

## 11. 最终判定

当前 A733 SDK 的 VIN/ISP/VPU DDR 分配设计不是“预留一块 VPU/VIN CMA 内存”，而是：

```text
全局 CMA 存在，但较小且非专用
        +
VIN/ISP/CSI/VE 全部挂 IOMMU
        +
dma-buf heap 提供 buffer fd
        +
cedar/vin 驱动 attach/map dma-buf
        +
硬件使用连续 IOVA 访问普通 DDR 页
```

这条链路能让 VIN/ISP/VE 在大多数场景下不依赖大块物理连续 CMA，从而获得足够 DDR 页。但它不是内核层面的绝对内存预留保障。对任意大型程序抢占内存的场景，仍需要产品级内存治理或显式 reserved-memory 设计。
