# RV1106 Luckfox Pico Ultra IPC CMA 与 reserved-memory 分析

本文以以下板级配置为例，分析 RV1106 Luckfox Pico Ultra IPC 方案中的 CMA 大小、DTS `reserved-memory` 实际占用，以及该配置如何同时兼顾 CIF/ISP 和 VPU/VENC 的内存需求。

目标板级配置：

```text
SDK/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-EMMC-Buildroot-RV1106_Luckfox_Pico_Ultra-IPC.mk
```

相关 DTS：

```text
SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/boot/dts/rv1106g-luckfox-pico-ultra.dts
SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/boot/dts/rv1106-luckfox-pico-ultra-ipc.dtsi
SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/boot/dts/rv1106.dtsi
SDK/luckfox-pico/sysdrv/source/kernel/arch/arm/boot/dts/rv1106-evb.dtsi
```

## 1. 板级配置入口

`BoardConfig-EMMC-Buildroot-RV1106_Luckfox_Pico_Ultra-IPC.mk` 中和内存/media 相关的关键配置如下：

```sh
export RK_CHIP=rv1106
export RK_APP_TYPE=RKIPC_RV1106

# Config CMA size in environment
export RK_BOOTARGS_CMA_SIZE="66M"

# Kernel dts
export RK_KERNEL_DTS=rv1106g-luckfox-pico-ultra.dts

# Kernel defconfig
export RK_KERNEL_DEFCONFIG=luckfox_rv1106_linux_defconfig
```

也就是说，这个板级最终使用：

```text
DTS:    rv1106g-luckfox-pico-ultra.dts
config: luckfox_rv1106_linux_defconfig
rootfs: Buildroot
CMA:    通过 bootargs 追加 rk_dma_heap_cma=66M
```

这里的 `RK_BOOTARGS_CMA_SIZE="66M"` 很关键，它并不是直接修改 DTS 中的 `linux,cma` 节点，而是在打包镜像时追加到 kernel cmdline。

## 2. DTS include 关系

`rv1106g-luckfox-pico-ultra.dts` 是最终入口 DTS：

```dts
/dts-v1/;
#include "rv1106.dtsi"
#include "rv1106-luckfox-pico-ultra-ipc.dtsi"
```

其分工如下：

```text
rv1106.dtsi
  定义 SoC 级硬件节点：
  rkcif、rkisp、mpp_srv、mpp_vcodec、rkvenc、rkvenc_pp、rkdvbm 等。

rv1106-luckfox-pico-ultra-ipc.dtsi
  定义板级 bootargs、reserved-memory、sensor/ISP/CIF 连接、panel 等。

rv1106-evb.dtsi
  被 rv1106-luckfox-pico-ultra-ipc.dtsi include，
  用于打开 mpp/vcodec/rkvenc/rga/rkdvbm 等公共 EVB 功能节点。
```

## 3. DTS 中的 reserved-memory

`rv1106-luckfox-pico-ultra-ipc.dtsi` 中的 `reserved-memory` 如下：

```dts
reserved_memory: reserved-memory {
    status = "okay";
    #address-cells = <1>;
    #size-cells = <1>;
    ranges;

    drm_logo: drm-logo@00000000 {
        compatible = "rockchip,drm-logo";
        reg = <0x0 0x0>;
    };

    linux,cma {
        status = "okay";
        compatible = "shared-dma-pool";
        inactive;
        reusable;
        size = <0xA00000>; //10M
        linux,cma-default;
    };

    mmc_ecsd: mmc@3f000 {
        reg = <0x3f000 0x00001000>;
    };
};
```

逐项计算：

```text
drm_logo:
  reg = <0x0 0x0>
  size = 0

linux,cma:
  size = <0xA00000>
  0xA00000 = 10 * 1024 * 1024 = 10 MiB

mmc_ecsd:
  reg = <0x3f000 0x00001000>
  size = 0x1000 = 4096 bytes = 4 KiB
```

因此 DTS 中显式声明的 `reserved-memory` 占用为：

```text
linux,cma  = 10 MiB
mmc_ecsd   = 4 KiB
drm_logo   = 0

合计       = 10 MiB + 4 KiB
```

其中真正有体量的是 `linux,cma = 10 MiB`。`mmc_ecsd` 只是 eMMC 扩展 CSD 信息的小保留区。

## 4. BoardConfig 中的 66M 到底是什么

`BoardConfig` 里配置的是：

```sh
export RK_BOOTARGS_CMA_SIZE="66M"
```

在 `project/build.sh` 中会被转换为：

```sh
if [ -n "$RK_BOOTARGS_CMA_SIZE" ]; then
    SYS_BOOTARGS="$SYS_BOOTARGS rk_dma_heap_cma=$RK_BOOTARGS_CMA_SIZE"
fi
```

因此最终 kernel cmdline 中会追加：

```text
rk_dma_heap_cma=66M
```

注意，这不是标准 Linux 参数 `cma=66M`，而是 Rockchip 自己的参数 `rk_dma_heap_cma`。

对应代码在：

```text
SDK/luckfox-pico/sysdrv/source/kernel/drivers/dma-buf/rk_heaps/rk-dma-cma.c
```

关键逻辑：

```c
#define RK_DMA_HEAP_CMA_DEFAULT_SIZE SZ_32M

static int __init early_dma_heap_cma(char *p)
{
    rk_dma_heap_size = memparse(p, &p);
    if (*p != '@')
        return 0;

    rk_dma_heap_base = memparse(p + 1, &p);
    return 0;
}
early_param("rk_dma_heap_cma", early_dma_heap_cma);

int __init rk_dma_heap_cma_setup(void)
{
    unsigned long size;

    if (rk_dma_heap_size)
        size = rk_dma_heap_size;
    else
        size = RK_DMA_HEAP_CMA_DEFAULT_SIZE;

    ret = cma_declare_contiguous(rk_dma_heap_base, PAGE_ALIGN(size), 0x0,
                                 PAGE_SIZE, 0, fix, "rk-dma-heap-cma",
                                 &rk_dma_heap_cma);
}
```

如果传入 `rk_dma_heap_cma=66M`，则会创建一个名为：

```text
rk-dma-heap-cma
```

的 Rockchip DMA heap CMA 区，大小为 66 MiB。

## 5. 实际存在的 CMA/保留类内存

这个板级中需要区分两类 CMA：

```text
1. DTS linux,cma
   大小：10 MiB
   来源：rv1106-luckfox-pico-ultra-ipc.dtsi
   作用：default Linux CMA，偏通用 DMA/display/fallback 场景。

2. Rockchip rk-dma-heap-cma
   大小：66 MiB
   来源：BoardConfig -> bootargs -> rk_dma_heap_cma=66M
   作用：Rockchip dma-buf heap，主要服务 media pipeline。
```

因此，如果按 128 MiB DDR 粗略估算：

```text
总 DDR                    = 128 MiB
DTS linux,cma             = 10 MiB
rk-dma-heap-cma           = 66 MiB
mmc_ecsd                  = 4 KiB

CMA/保留类媒体相关内存约 = 76 MiB + 4 KiB
普通 Linux 可用内存约    = 128 MiB - 76 MiB = 52 MiB
```

这说明该板级不是“宽裕配置”，而是典型小内存 IPC 方案：牺牲普通 Linux 可用内存，换取 media pipeline 的确定性。

## 6. CONFIG_CMA_INACTIVE 的影响

内核配置 `luckfox_rv1106_linux_defconfig` 中启用了：

```text
CONFIG_CMA=y
CONFIG_CMA_INACTIVE=y
CONFIG_DMA_CMA=y
CONFIG_CMA_SIZE_MBYTES=0
CONFIG_DMABUF_HEAPS_ROCKCHIP=y
CONFIG_DMABUF_HEAPS_ROCKCHIP_CMA_HEAP=y
CONFIG_DMABUF_RK_HEAPS_DEBUG=y
```

`CONFIG_CMA_SIZE_MBYTES=0` 表示标准 Linux CMA 大小不从 defconfig 默认值来，而是由 DTS 中的 `linux,cma` 或 cmdline 决定。

`CONFIG_CMA_INACTIVE` 的 Kconfig 说明是：

```text
This forbids the CMA to active its pages to system memory,
to keep page from CMA never be borrowed by system.
```

也就是说，这份内核的语义是：CMA 页不借给普通系统内存使用，避免普通用户态/page cache 长期占用并影响后续连续内存分配。

这对 RV1106 这种 128 MiB DDR 的平台非常关键：

```text
优点：
  media 侧申请大块连续 buffer 时更稳定，CIF/ISP/VENC 不容易因为内存碎片失败。

代价：
  普通 Linux 可用内存明显减少，系统必须保持小 rootfs、小常驻进程、低应用内存占用。
```

## 7. CIF/ISP 与 VPU/VENC 节点启用情况

### 7.1 SoC 中的 media 节点

`rv1106.dtsi` 中定义了 MPP/VCodec：

```dts
mpp_srv: mpp-srv {
    compatible = "rockchip,mpp-service";
    rockchip,taskqueue-count = <2>;
    status = "disabled";
};

mpp_vcodec: mpp-vcodec {
    compatible = "rockchip,vcodec";
    status = "disabled";
};
```

CIF/ISP 虚拟节点：

```dts
rkcif_mipi_lvds: rkcif-mipi-lvds {
    compatible = "rockchip,rkcif-mipi-lvds";
    rockchip,hw = <&rkcif>;
    status = "disabled";
};

rkcif_mipi_lvds_sditf: rkcif-mipi-lvds-sditf {
    compatible = "rockchip,rkcif-sditf";
    rockchip,cif = <&rkcif_mipi_lvds>;
    status = "disabled";
};

rkisp_vir0: rkisp-vir0 {
    compatible = "rockchip,rkisp-vir";
    rockchip,hw = <&rkisp>;
    dvbm = <&rkdvbm>;
    status = "disabled";
};
```

VENC 节点：

```dts
rkvenc: rkvenc@ffa50000 {
    compatible = "rockchip,rkv-encoder-rv1106";
    rockchip,srv = <&mpp_srv>;
    rockchip,taskqueue-node = <0>;
    dvbm = <&rkdvbm>;
    status = "disabled";
};

rkvenc_pp: rkvenc-pp@ffa60000 {
    compatible = "rockchip,rkvenc-pp-rv1106";
    rockchip,srv = <&mpp_srv>;
    rockchip,taskqueue-node = <1>;
    status = "disabled";
};

rkdvbm: rkdvbm@ffa70000 {
    compatible = "rockchip,rk-dvbm";
    status = "disabled";
};
```

### 7.2 板级打开 CIF/ISP

`rv1106-luckfox-pico-ultra-ipc.dtsi` 打开了 CIF/ISP 链路：

```dts
&rkcif {
    status = "okay";
};

&rkcif_mipi_lvds {
    status = "okay";
};

&rkcif_mipi_lvds_sditf {
    status = "okay";
};

&rkisp {
    status = "okay";
};

&rkisp_vir0 {
    status = "okay";
};
```

### 7.3 公共 EVB dtsi 打开 VENC/MPP

`rv1106-luckfox-pico-ultra-ipc.dtsi` include 了 `rv1106-evb.dtsi`。后者打开：

```dts
&mpp_srv {
    status = "okay";
};

&mpp_vcodec {
    status = "okay";
};

&rkdvbm {
    status = "okay";
};

&rkvenc {
    status = "okay";
};

&rkvenc_pp {
    status = "okay";
};
```

因此该板级的设计意图很明确：CIF/ISP 和 VPU/VENC 需要同时工作。

## 8. 为什么 66M 能同时兼顾 CIF/ISP 和 VPU/VENC

关键不是给 CIF/ISP 固定切一块 DDR、再给 VPU 固定切一块 DDR，而是通过同一个 Rockchip dma-buf/CMA heap 承载整条 media pipeline 的峰值 buffer。

理想链路：

```text
Sensor -> MIPI CSI2 -> CIF -> ISP -> VI dma-buf -> VENC import/consume -> bitstream
```

这里 ISP 输出的 YUV 帧可以作为 VENC 输入，不需要用户态再复制一份大图。

如果设计正确，内存中同时存在的主要是：

```text
VI/ISP 环形帧 buffer
VENC 码流 buffer
VENC 参考/重构/内部 buffer
ISP stats/params 小 buffer
RGA/OSD/对齐损耗/瞬时峰值
```

而不是：

```text
CIF 一份
ISP 一份
用户态 memcpy 一份
VENC 输入再一份
```

后者在 128 MiB DDR 上很容易失败。

## 9. 应用侧如何配合降低峰值内存

`project/app/component/fastboot_server/fastboot_server.c` 中可以看到典型小内存 pipeline 配置。

### 9.1 VI 使用 DMABUF

```c
vi_chn_attr.stIspOpt.enMemoryType = VI_V4L2_MEMORY_TYPE_DMABUF;
```

### 9.2 VI buffer count 很低

```c
int buf_cnt = 3;

if (g_bWrap == false) {
    buf_cnt = 1;
}

vi_chn_attr.stIspOpt.u32BufCount = buf_cnt;
```

含义：

```text
wrap 模式：    VI buffer = 3
非 wrap 模式：VI buffer = 1
```

### 9.3 VENC 使用 YUV420SP

```c
stAttr.stVencAttr.enPixelFormat = RK_FMT_YUV420SP;
stAttr.stVencAttr.u32PicWidth = width;
stAttr.stVencAttr.u32PicHeight = height;
stAttr.stVencAttr.u32VirWidth = width;
stAttr.stVencAttr.u32VirHeight = height;
```

### 9.4 VENC stream buffer 受控

```c
stAttr.stVencAttr.u32StreamBufCnt = 4;
stAttr.stVencAttr.u32BufSize = max_width * max_height;
```

### 9.5 VENC 参考帧共享

```c
stVencChnRefBufShare.bEnable = true;
RK_MPI_VENC_SetChnRefBufShareAttr(chnId, &stVencChnRefBufShare);
```

### 9.6 VI 直接绑定到 VENC

```c
stSrcChn.enModId = RK_ID_VI;
stSrcChn.s32DevId = 0;
stSrcChn.s32ChnId = 0;

stDestChn.enModId = RK_ID_VENC;
stDestChn.s32DevId = 0;
stDestChn.s32ChnId = 0;

RK_MPI_SYS_Bind(&stSrcChn, &stDestChn);
```

这些配置合起来，正是 `rk_dma_heap_cma=66M` 能够支撑高分辨率 IPC pipeline 的前提。

## 10. 按传感器分辨率估算媒体 buffer

该板级配置的 IQ 文件：

```sh
export RK_CAMERA_SENSOR_IQFILES="sc4336_OT01_40IRC_F16.json sc3336_CMK-OT2119-PC1_30IRC-F16.json mis5001_CMK-OT2115-PC1_30IRC-F16.json"
```

对应 sensor driver 里的典型分辨率：

```text
SC4336:  2560x1440
SC3336:  2304x1296
MIS5001: 2592x1944
```

YUV420SP/NV12 单帧大小近似：

```text
frame_size = width * height * 1.5
```

### 10.1 SC3336: 2304x1296

```text
单帧 NV12:
  2304 * 1296 * 1.5 = 4,478,976 bytes ~= 4.27 MiB

VI 3 帧:
  3 * 4.27 MiB ~= 12.81 MiB

VENC stream buffer:
  u32StreamBufCnt = 4
  u32BufSize = width * height = 2,985,984 bytes ~= 2.85 MiB
  4 * 2.85 MiB ~= 11.40 MiB

大头小计:
  12.81 MiB + 11.40 MiB ~= 24.21 MiB
```

### 10.2 SC4336: 2560x1440

```text
单帧 NV12:
  2560 * 1440 * 1.5 = 5,529,600 bytes ~= 5.27 MiB

VI 3 帧:
  3 * 5.27 MiB ~= 15.81 MiB

VENC stream buffer:
  u32StreamBufCnt = 4
  u32BufSize = width * height = 3,686,400 bytes ~= 3.52 MiB
  4 * 3.52 MiB ~= 14.06 MiB

大头小计:
  15.81 MiB + 14.06 MiB ~= 29.87 MiB
```

### 10.3 MIS5001: 2592x1944

```text
单帧 NV12:
  2592 * 1944 * 1.5 = 7,558,272 bytes ~= 7.21 MiB

VI 3 帧:
  3 * 7.21 MiB ~= 21.63 MiB

VENC stream buffer:
  u32StreamBufCnt = 4
  u32BufSize = width * height = 5,038,848 bytes ~= 4.81 MiB
  4 * 4.81 MiB ~= 19.24 MiB

大头小计:
  21.63 MiB + 19.24 MiB ~= 40.87 MiB
```

66 MiB 的 `rk-dma-heap-cma` 对 MIS5001 这种 5MP pipeline 来说，粗略余量为：

```text
66 MiB - 40.87 MiB ~= 25 MiB
```

这 25 MiB 需要覆盖：

```text
VENC 参考/重构/内部 buffer
ISP params/stats buffer
RGA/OSD buffer
dma-buf 管理开销
对齐损耗
瞬时峰值
```

这说明 66 MiB 是一个按高分辨率 IPC 链路压出来的工程值，而不是随意配置。

## 11. linux,cma 10M 的可能用途

该板级还配置了 720x720 RGB panel：

```dts
hactive = <720>;
vactive = <720>;
```

如果按 32bpp framebuffer 粗算：

```text
720 * 720 * 4 ~= 2.0 MiB
```

双 buffer 大约 4 MiB，三 buffer 大约 6 MiB。

因此 DTS 里的 `linux,cma = 10M` 更像是给以下场景保留：

```text
DRM/display framebuffer
drm logo
通用 DMA fallback
小规模 V4L2/vb2-cma 场景
```

主力视频采集/编码大块 buffer 则主要依赖：

```text
rk-dma-heap-cma = 66M
```

## 12. 板上验证方法

实际镜像启动后，应以板上信息为准。建议检查：

```sh
cat /proc/cmdline
cat /proc/meminfo | grep -E 'MemTotal|MemFree|MemAvailable|CmaTotal|CmaFree'
cat /proc/rk_cma/rk-dma-heap-cma
cat /proc/rk_dma_heap/dma_heap_info
cat /proc/rk_dmabuf/sgt
cat /proc/vcodec/enc/venc_info
dmesg | grep -iE 'cma|rk_dma_heap|dmabuf|venc|rkcif|rkisp|alloc'
```

重点确认：

```text
/proc/cmdline
  是否包含 rk_dma_heap_cma=66M

/proc/rk_cma/rk-dma-heap-cma
  Rockchip CMA heap 总量和当前空闲情况

/proc/rk_dma_heap/dma_heap_info
  当前 dma-buf 分配者、大小和总量

/proc/rk_dmabuf/sgt
  dma-buf attach 到哪些设备，是否存在泄漏

/proc/vcodec/enc/venc_info
  VENC 当前通道、buffer 和编码状态
```

SDK 中也有 Rockchip 自带脚本会查看这些节点：

```text
SDK/luckfox-pico/sysdrv/tools/board/rockchip_test/rockchip_test/cat_vcodec.sh
```

其中包含：

```sh
cat /proc/rk_dma_heap/dma_heap_info
cat /proc/rk_cma/rk-dma-heap-cma
cat /proc/rk_dmabuf/sgt
```

## 13. 风险点和调参原则

`rk_dma_heap_cma=66M` 可以支撑当前板级预期的 IPC pipeline，但它依赖若干前提：

```text
1. VI 使用 DMABUF
2. VI buffer count 不要随意增大
3. VI 直接 bind 到 VENC，避免用户态 memcpy 大图
4. VENC stream buffer count 不要随意增大
5. VENC ref buffer share 保持开启
6. Buildroot 系统保持小常驻内存
7. RGA/OSD/NPU/抓拍等额外模块要纳入峰值预算
```

以下改动都可能导致 66 MiB 不够：

```text
VI buffer count 从 3 增加到 5 或 6
用户态取帧后 memcpy 再送 VENC
同时开启多路 RGA 缩放/OSD
同时跑 NPU 大模型
双路 sensor 同时采集
开启大分辨率抓拍/JPEG
提高 VENC stream buffer count 或 buffer size
普通用户态进程占用过高
```

如果需要调小或调大，可从 BoardConfig 修改：

```sh
export RK_BOOTARGS_CMA_SIZE="66M"
```

例如：

```sh
export RK_BOOTARGS_CMA_SIZE="48M"
export RK_BOOTARGS_CMA_SIZE="64M"
export RK_BOOTARGS_CMA_SIZE="80M"
```

但在 128 MiB DDR 上，调大 `rk_dma_heap_cma` 会继续压缩普通 Linux 可用内存。是否可行必须结合实际运行时的：

```text
MemAvailable
rk-dma-heap-cma free
dma_heap_info total
VENC/VI/RGA/NPU 峰值占用
OOM 日志
```

来判断。

## 14. 总结

对 `BoardConfig-EMMC-Buildroot-RV1106_Luckfox_Pico_Ultra-IPC.mk` 这个板级：

```text
DTS reserved-memory:
  linux,cma = 10 MiB
  mmc_ecsd  = 4 KiB
  drm_logo  = 0

BoardConfig 追加:
  rk_dma_heap_cma = 66 MiB

合计 CMA/保留类媒体相关内存:
  约 76 MiB + 4 KiB

普通 Linux 可用内存粗略剩余:
  约 52 MiB
```

这个设计是典型 RV1106 小内存 IPC 配法：

```text
1. 普通 Linux 系统尽量小。
2. 媒体侧预留较大的 Rockchip dma-buf CMA heap。
3. CIF/ISP 与 VENC 通过 DMABUF 零拷贝共享 buffer。
4. 应用层压低 VI buffer count。
5. VENC 使用有限 stream buffer，并开启 ref buffer share。
6. 通过 VI -> VENC bind 避免额外大图拷贝。
```

因此，66 MiB 的 `rk-dma-heap-cma` 不是给 CIF/ISP 或 VPU 单方独占，而是给整条 CIF/ISP/VENC pipeline 的峰值 buffer 使用。它能同时兼顾两者的核心原因，是 **dma-buf 共享 + 零拷贝 + 低 buffer count + 小系统内存模型**。
