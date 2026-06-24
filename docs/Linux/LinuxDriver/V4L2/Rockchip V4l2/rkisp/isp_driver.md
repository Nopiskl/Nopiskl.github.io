# RK3588 ISP driver detailed analysis
_Exported on 2026/4/18 at GMT+8 13:13:21 from Cursor (2.6.21)_

---

**User**

请你结合@kernel/drivers/media/platform/rockchip rk的驱动具体源码，并参考博客的分析
platform_driver_register--注册rockchip,rkisp-vir虚拟设备。
　　rkisp_plat_drv--
　　　　rkisp_plat_probe
　　　　　　rkisp_attach_hw--获取子节点"rockchip,hw"的信息。
　　　　　　v4l2_ctrl_handler_init
　　　　　　v4l2_device_register
　　　　　　media_device_init
　　　　　　media_device_register
　　　　　　rkisp_register_platform_subdevs
　　　　　　　　->rkisp_register_isp_subdev--创建Media Entity名称为rkisp-isp-subdev的v4l2_subdev设备。
　　　　　　　　　　->v4l2_subdev_init--初始化subdev，函数集为rkisp_isp_sd_ops。
　　　　　　　　　　->media_entity_pads_init
　　　　　　　　　　->v4l2_device_register_subdev
　　　　　　　　->rkisp_register_csi_subdev--ISP_V30跳过此函数。
　　　　　　　　->rkisp_register_bridge_subdev--未配置ISPP，跳过此函数。
　　　　　　　　->rkisp_register_stream_vdevs
　　　　　　　　　　->rkisp_register_stream_v30
　　　　　　　　　　　　->rkisp_stream_init
　　　　　　　　　　　　　　->rkisp_init_vb2_queue
　　　　　　　　　　　　　　　　->vb2_queue_init--初始化vb2 buffer，操作函数集为rkisp_vb2_ops。
　　　　　　　　　　　　　　->rkisp_register_stream_vdev--创建4个stream v4l2设备：RKISP_STREAM_MP、RKISP_STREAM_SP、RKISP_STREAM_FBC、RKISP_STREAM_VIR。
　　　　　　　　　　　　　　　　->video_register_device--注册video设备，操作函数集为rkisp_fops和rkisp_v4l2_ioctl_ops。
　　　　　　　　　　　　　　　　->media_entity_pads_init
　　　　　　　　　　　　　　　　->media_create_pad_link
　　　　　　　　->rkisp_register_dmarx_vdev--创建3个类型DMA类型v4l2设备：RKISP_STREAM_RAWRD0、RKISP_STREAM_RAWRD2、RKISP_STREAM_RAWRD1。Entity名称为rkisp_rawrd0_m、rkisp_rawrd2_s、rkisp_rawrd1_1，每个Entity包含一个SourcePad。
　　　　　　　　　　->dmarx_init
　　　　　　　　　　　　->rkisp_register_dmarx_video
　　　　　　　　　　　　　　->rkisp_init_vb2_queue
　　　　　　　　　　　　　　->video_register_device--创建v4l2设备rkisp-statistics，操作函数集为rkisp_fops和rkisp_dmarx_ioctl。
　　　　　　　　　　　　　　->media_entity_pads_init
　　　　　　　　　　　　->media_create_pad_link
　　　　　　　　->rkisp_register_stats_vdev--创建1个Statistics类型v4l2设备。Entity名称为rkisp-statistics，仅包含一个Sink Pad。
　　　　　　　　　　->rkisp_stats_init_vb2_queue
　　　　　　　　　　->rkisp_init_stats_vdev
　　　　　　　　　　->media_entity_pads_init
　　　　　　　　　　->video_register_device--操作函数集为rkisp_stats_fops和rkisp_stats_ioctl。
　　　　　　　　　　->media_create_pad_link
　　　　　　　　->rkisp_register_params_vdev
　　　　　　　　　　->rkisp_params_init_vb2_queue
　　　　　　　　　　->rkisp_init_params_vdev
　　　　　　　　　　->media_entity_pads_init
　　　　　　　　　　->video_register_device--创建1个v4l2设备rkisp-input-params，操作函数集为rkisp_params_fops和rkisp_params_ioctl。
　　　　　　　　　　->media_create_pad_link
　　　　　　　　->rkisp_register_luma_vdev
　　　　　　　　->isp_subdev_notifier
　　　　　　　　　　->v4l2_async_notifier_init
　　　　　　　　　　->v4l2_async_notifier_parse_fwnode_endpoints--解析/rkisp0-vir0/port/下的endpoint。
　　　　　　　　　　->v4l2_async_notifier_register
　　　　　　->rkisp_proc_init--创建/proc/rkisp0-vir0节点，显示时钟、中断、输入等信息。
按这个思路帮我分析一下rk isp驱动的详细分析，以SOC类型为RK3588为例，不用考虑多SOC分支

---

**Cursor**

我先把 RK3588 相关的 `rkisp` 平台驱动主线源码读出来，再按你给的调用链整理成一份“probe 到 media graph 建立”的详细分析。

我再把 `probe`、各个 subdev/video 注册函数以及 RK3588 对应的 `compatible`/设备树入口位置读出来，整理成按调用链展开的源码级分析。

我已经定位到主文件在 `kernel/drivers/media/platform/rockchip/isp/rkisp.c`，接下来直接按符号名精确抓取这些函数定义和 RK3588 设备树节点，避免遗漏版本分支。

我还需要把这些关键函数的精确代码段和行号取出来，这样可以按源码位置给你串完整条 `rkisp0_vir0` 在 RK3588 上的注册与拓扑建立过程。

`rg` 在这个环境里不可用，我改成直接读取关键源码段，按函数定义所在位置逐段展开。

我已经把主流程确认出来了。为了给你一份能直接对照源码阅读的分析，我再补抓几个关键函数附近的带行号代码段，然后按 `RK3588 / rkisp0_vir0` 的实际初始化链路展开。

我补一下 `rkisp_attach_hw()` 的源码位置，因为它决定了 `rkisp0_vir0` 如何挂到 `rkisp0` 真实硬件节点上，这一步对 RK3588 的理解很关键。

我再把 `rkisp_attach_hw()` 和 RK3588 的 `rkisp0/rkisp0_vir0` 设备树节点本体读出来，最后把“虚拟节点 -> 真实硬件 -> media graph -> video 节点”的关系彻底串起来。

下面我按你给的那条思路，结合这份内核里 `kernel/drivers/media/platform/rockchip/isp/` 的实际源码，对 **RK3588 上的 RK ISP 驱动**做一版“从 `rkisp-vir` 平台设备注册，到 media graph 建立，再到后续 stream-on”的详细分析。

我这里**只聚焦 RK3588**，也就是你说的“不考虑多 SoC 分支”。因此重点看这一套：

- 虚拟 ISP 平台驱动：`kernel/drivers/media/platform/rockchip/isp/dev.c`
- ISP subdev / stream / dmarx / stats / params：`kernel/drivers/media/platform/rockchip/isp/rkisp.c`
- 数据结构定义：`kernel/drivers/media/platform/rockchip/isp/rkisp.h`
- RK3588 设备树：`kernel/arch/arm64/boot/dts/rockchip/rk3588s.dtsi`
- 具体板级示例：`kernel/arch/arm64/boot/dts/rockchip/rk3588-evb1-imx415.dtsi`

你给的博客式分析主线基本是对的，但有几点要按这份源码校正：
1. `platform_driver_register()` 在这份代码里是通过 `struct platform_driver rkisp_plat_drv` 定义，按驱动装载机制完成注册，不是源码里手写单独一行 `platform_driver_register(...)`。
2. `rkisp_register_csi_subdev()` 在 RK3588 上**并不是简单“ISP_V30 跳过”**。RK3588 这套驱动里，`rkisp_create_links()` 仍然可能建立 `sensor/phy -> csi subdev -> isp subdev` 这条媒体链，是否真正生效取决于输入拓扑。
3. 你写的 `rkisp_register_dmarx_vdev` 下 `video_register_device--创建v4l2设备rkisp-statistics` 这句不对。  
   `rkisp-statistics` 是 `stats vdev`，不是 `dmarx vdev`。
4. RK3588 常见实际链路中，**ISP 输入很多时候不是直接连 sensor，而是经过 CIF SDITF 转给 rkisp-vir**，这也是 `rkisp0_vir0` 名字里 “vir” 的核心意义。

---

# 1. 先看 RK3588 上的整体硬件/软件拓扑

以板级示例 `rk3588-evb1-imx415.dtsi` 为例，典型链路是：

`imx415 sensor`
-> `csi2 dphy`
-> `mipi0_csi2`
-> `rkcif_mipi_lvds`
-> `rkcif_mipi_lvds_sditf`
-> `rkisp0_vir0`

也就是：

**Sensor 并不是直接挂到 `rkisp0_vir0` 上，而是先进入 CIF，再通过 SDITF 方式送给 ISP 虚拟节点。**

从设备树上能看到这个关键连接关系：

- `imx415_out0 -> mipi_in_ucam0`
- `csidcphy0_out -> mipi0_csi2_input`
- `mipi0_csi2_output -> cif_mipi_in0`
- `mipi_lvds_sditf -> isp0_vir0`

所以在 RK3588 平台上，`rkisp0_vir0` 常常代表的是：

**一个“面向媒体框架的虚拟 ISP 实例”**，它自己是 platform device，但背后会去绑定真实 ISP 硬件 `rkisp0`，同时它的上游不一定是 sensor，而可能是 CIF 的 SDITF 输出。

---

# 2. 驱动入口：`rockchip,rkisp-vir` 匹配与 probe

驱动入口在 `kernel/drivers/media/platform/rockchip/isp/dev.c`。

这个文件里有 `rkisp_plat_of_match[]`，其中匹配：

- `rockchip,rkisp-vir`

然后 `rkisp_plat_drv.probe = rkisp_plat_probe`。

所以 RK3588 上设备树里的 `rkisp0_vir0` / `rkisp1_vir0` 一旦 `status = "okay"`，就会进入：

- `rkisp_plat_probe()`

这个 probe 是整个虚拟 ISP 实例的软件入口。

---

# 3. `rkisp_plat_probe()`：虚拟 ISP 实例的主初始化流程

你给的博客主线和源码基本一致，按源码展开如下：

## 3.1 分配 `rkisp_device`

在 `rkisp_plat_probe()` 里，先 `devm_kzalloc()` 分配 `struct rkisp_device`，这是整个 ISP 实例的核心对象，后续所有 subdev、video、media device 都挂在这里。

同时：
- `dev_set_drvdata(dev, isp_dev);`
- `isp_dev->dev = dev;`

---

## 3.2 `rkisp_attach_hw()`：把 `rkisp-vir` 绑定到真实 ISP 硬件

这是 RK3588 上最关键的一步之一。

你给的博客只写“获取子节点 rockchip,hw 的信息”，但源码含义更深：

### 它做的本质工作是：
**让 `rkisp0_vir0` 这个虚拟 platform device 找到背后的真实 ISP 硬件资源。**

这里通常会从设备树里的 `rockchip,hw` phandle 找到真实硬件节点，例如：
- `&rkisp0`
- 或对应 ISP 硬件资源节点

然后建立：
- `isp_dev->hw_dev`
- `isp_dev->dev_id`
- `isp_dev->base_addr`
- `isp_dev->isp_ver`

对 RK3588 而言，重点是最终把 ISP 版本识别为 **V30/V32 这一代 3x 架构**。  
从这份驱动行为和 RK3588 实际平台看，初始化逻辑主要走 **ISP_V30/V32 这类 3x 分支**，而不是老的 ISP1/ISP2x 路径。

### 这一步决定了后面几个关键分支：
- 是否启用 `stream_v30`
- dmarx/raw readback 的行为
- 输入尺寸上限
- unite 模式
- 时钟调节/DVFS 方式
- 3A、stats、params、luma 等模块的组合

所以可以把 `rkisp_attach_hw()` 理解成：

**“把软件里的 `rkisp0_vir0`，映射到真实的 RK3588 ISP 硬件能力模型。”**

---

## 3.3 初始化软件寄存器缓存 / VS IRQ / 名字

`rkisp_plat_probe()` 后续还会做：

- 给 `sw_base_addr` 分配一块软件寄存器镜像缓存
- `rkisp_vs_irq_parse()`：尝试解析 `vsirq` GPIO 中断
- 设置媒体设备名和驱动名

这里 `media_dev.model` 一般类似：
- `rkisp0`
或统一名字风格

如果是 unite 模式则会带 `rkisp-uniteX` 风格。

---

## 3.4 初始化 V4L2 / Media 核心对象

这一部分是你给的博客流程里最准确的一段：

### 1）`v4l2_ctrl_handler_init()`
初始化 `isp_dev->ctrl_handler`。

### 2）`v4l2_device_register()`
注册 `v4l2_device`。

这一步的意义是：
- 后续注册所有 subdev/video device 时，都挂到这个 `v4l2_device` 下。

### 3）`media_device_init()`
初始化 `media_device`。

### 4）`media_device_register()`
把整个 media device 注册到 media controller 框架。

所以到这里为止，**RK3588 的这个虚拟 ISP 实例，已经成为一个完整的 media device 容器**，但里面的子实体还没全部挂上去。

---

## 3.5 `rkisp_register_platform_subdevs()`
这一步就是你博客式梳理的主体。

源码顺序是：

1. `rkisp_register_isp_subdev()`
2. `rkisp_register_csi_subdev()`
3. `rkisp_register_bridge_subdev()`
4. `rkisp_register_stream_vdevs()`
5. `rkisp_register_dmarx_vdev()`
6. `rkisp_register_stats_vdev()`
7. `rkisp_register_params_vdev()`
8. `rkisp_register_luma_vdev()`
9. `isp_subdev_notifier()`

这是整个 RK ISP 软件拓扑的“静态注册阶段”。

---

# 4. `rkisp_register_isp_subdev()`：核心 ISP subdev

这个函数在 `kernel/drivers/media/platform/rockchip/isp/rkisp.c`。

它创建的是整个 ISP pipeline 的核心子设备：

- entity 名称：`rkisp-isp-subdev`

你博客这一点是对的。

## 4.1 `v4l2_subdev_init()`
初始化 `v4l2_subdev`，函数集绑定到 ISP subdev 的 ops。

这个 subdev 不只是“一个纯 ISP 算法块”，源码里注释写得很明确：

> ISP Subdev 不只是描述 ISP 模块本身，也承担 virtual route device 的角色。

也就是说它既是：
- ISP 配置/格式协商点
也是：
- 媒体图里的路由中心

---

## 4.2 pad 初始化

`rkisp.h` 里定义了 ISP subdev 的 pads：

- `RKISP_ISP_PAD_SINK`
- `RKISP_ISP_PAD_SINK_PARAMS`
- `RKISP_ISP_PAD_SOURCE_PATH`
- `RKISP_ISP_PAD_SOURCE_STATS`

所以这个 ISP subdev 至少扮演四类端口角色：

1. 图像输入口
2. 参数输入口（给 3A / IQ 配置）
3. 图像主输出口
4. 统计信息输出口

然后通过 `media_entity_pads_init()` 把 pads 交给 media entity。

---

## 4.3 `v4l2_device_register_subdev()`
把 `rkisp-isp-subdev` 挂到前面 probe 里注册好的 `v4l2_device` 下。

### 到这一步的意义
媒体图里出现了一个**真正可见的 ISP 核心节点**，以后：
- sensor/cif 会往它的 sink 连
- stream/stats/params 会和它建 link

---

# 5. `rkisp_register_csi_subdev()`：RK3588 上的 CSI 中间层

你原文写“ISP_V30 跳过此函数”，但从这份 RK3588 驱动看，不能这么绝对说。

因为在 `rkisp_create_links()` 里，如果上游不是直接 DVP sensor，而是 MIPI/PHY 类型，会建立：

- `sensor/phy -> csi subdev -> isp subdev`

说明：
**软件模型里 CSI subdev 仍然是一个可能参与 media graph 的实体。**

但在 RK3588 常见 `rkcif_sditf -> rkisp_vir` 的链路中，ISP 上游很多时候变成了 `rkcif` 风格的输入，而不是传统“sensor 直接进 isp csi”。

所以更准确的说法是：

- `rkisp_register_csi_subdev()` 在驱动注册阶段通常仍会执行；
- 但**在 RK3588 的实际拓扑里，它未必一定成为活跃数据通路的关键一环**；
- 真正起决定作用的是后面 notifier 完成后，根据远端 entity 类型动态创建 link。

---

# 6. `rkisp_register_bridge_subdev()`：ISPP/Bridge 相关

这个模块主要面向某些桥接输出路径，比如主路径和后级处理器之间的桥。

如果平台未启用对应 bridge/ISPP 拓扑，那么这个子设备虽然可能注册，但未必形成有效工作链路。

所以你写“未配置 ISPP，跳过此函数”更准确应该改为：

- **注册流程里会尝试注册 bridge subdev**
- 但在 RK3588 具体板级拓扑不启用 bridge 时，它不会成为有效的媒体链路参与者

---

# 7. `rkisp_register_stream_vdevs()`：创建 ISP 输出视频节点

这部分非常关键，它对应用户空间最常见的 `/dev/videoX` 输出端。

对 RK3588 这类 3x ISP，核心走的是：
- `rkisp_register_stream_v30()`

这和你博客给的思路一致。

---

## 7.1 `rkisp_stream_init()`
每个 stream 初始化时都会做：

- stream 结构体初始化
- 绑定 stream ops
- 初始化 buffer 队列
- 设置默认格式/裁剪等属性

---

## 7.2 `rkisp_init_vb2_queue()`
这一步调用 `vb2_queue_init()`，作用是初始化视频缓冲队列，后续 `VIDIOC_REQBUFS/QBUF/DQBUF/STREAMON` 都依赖它。

所以这里本质上是：
**给每个 video 节点接上 vb2 内存管理框架。**

---

## 7.3 `rkisp_register_stream_vdev()`
这个函数给每个输出流创建 `video_device`。

你说 RK3588 上创建四个 stream v4l2 设备，这个思路基本没错，常见包括：

- `RKISP_STREAM_MP`：Main Path
- `RKISP_STREAM_SP`：Self Path
- `RKISP_STREAM_FBC`
- `RKISP_STREAM_VIR`

某些平台还可能有 BP / MPDS / BPDS 等，取决于 ISP 版本和编译配置。

### 注册过程包括：
- `video_register_device()`  
  注册 video 节点，文件操作通常是 `rkisp_fops`，ioctl 为 `rkisp_v4l2_ioctl_ops`
- `media_entity_pads_init()`  
  初始化这个 video entity 的 pad
- `media_create_pad_link()`  
  把 ISP subdev 的 source pad 连到该 stream video entity

### 所以流输出的本质关系是：
`rkisp-isp-subdev SOURCE_PATH`  
-> `mp/sp/fbc/vir video entity`

也就是说，这些 `/dev/videoX` 不是孤立节点，而是 media graph 上 **ISP 输出端的消费终点**。

---

# 8. `rkisp_register_dmarx_vdev()`：RAW Readback / DMA 输入侧视频节点

这部分你已经抓住重点了，但有几个细节我帮你修正一下。

## 8.1 它创建的不是 statistics 节点，而是 dmarx/raw readback 节点

在 RK3588/ISP3x 体系里，这些节点用于：
- 从 DDR 读 RAW 回 ISP
- HDR readback
- 在线/离线复用
- AIQ/回灌路径

常见是 3 个 raw read 节点：

- `RKISP_STREAM_RAWRD0`
- `RKISP_STREAM_RAWRD1`
- `RKISP_STREAM_RAWRD2`

你提到的 entity 名字：
- `rkisp_rawrd0_m`
- `rkisp_rawrd2_s`
- `rkisp_rawrd1_1`

这是对的，说明这几个 DMA read 节点在 media graph 里是**独立 entity**。

---

## 8.2 `dmarx_init()` / `rkisp_register_dmarx_video()`
每个 dmarx video 节点也会做：

- `rkisp_init_vb2_queue()`
- `video_register_device()`
- `media_entity_pads_init()`

然后和 ISP subdev 建 pad link。

### 它们在 graph 里的角色
这些 rawrd 节点本质是：
- **作为 ISP 的另一种输入源**
- 当启用 HDR readback / 离线回灌时，ISP 的输入不一定来自实时 sensor，而可能来自这些 dmarx video queue

这就是为什么在 `rkisp_subdev_link_setup()` 里，`RAWRD0/1/2` 会影响：
- `dev->isp_inp`
- `dev->dmarx_dev.trigger`
- `dev->is_rdbk_auto`

---

# 9. `rkisp_register_stats_vdev()`：统计节点

这部分是 3A 最重要的出口之一。

它创建一个 statistics 类型 video 节点，entity 名一般就是：

- `rkisp-statistics`

你这点是对的。

## 9.1 它的 pad 角色
源码逻辑上它是一个**Sink Pad** 类型实体，接收来自 ISP subdev 的 statistics 输出。

即：

`rkisp-isp-subdev SOURCE_STATS`
-> `rkisp-statistics`

---

## 9.2 初始化过程
包括：

- `rkisp_stats_init_vb2_queue()`
- `rkisp_init_stats_vdev()`
- `media_entity_pads_init()`
- `video_register_device()`
- `media_create_pad_link()`

### 用户空间含义
这个节点一般由 AIQ / 3A 算法读取：
- AE / AWB / AF 统计
- histogram 等

所以它不是图像输出节点，而是**算法统计输出节点**。

---

# 10. `rkisp_register_params_vdev()`：参数输入节点

这是和 stats 对偶的另一个 3A 核心节点。

它创建：
- `rkisp-input-params`

这是一个参数输入 video 节点，用户空间 AIQ 会把 ISP 参数通过这个节点送回内核。

初始化过程包括：

- `rkisp_params_init_vb2_queue()`
- `rkisp_init_params_vdev()`
- `media_entity_pads_init()`
- `video_register_device()`
- `media_create_pad_link()`

### graph 关系
这里本质是：

`rkisp-input-params`
-> `rkisp-isp-subdev SINK_PARAMS`

也就是说：
- stats 负责把统计结果送出去
- params 负责把新一帧 ISP 参数送进来

两者组成典型 3A 闭环。

---

# 11. `rkisp_register_luma_vdev()`：亮度统计/辅助节点

这是 RK 新版 ISP 常见的辅助视频节点，用于亮度或某类简化统计信息输出。

它不一定是所有上层应用都直接用到，但在完整图里会被注册出来。

---

# 12. `isp_subdev_notifier()`：异步发现上游子设备

这一部分是 RK3588 上理解 media graph 自动拼接的核心。

你给的博客流程：

- `v4l2_async_notifier_init`
- `v4l2_async_notifier_parse_fwnode_endpoints`
- `v4l2_async_notifier_register`

和源码完全一致。

---

## 12.1 `v4l2_async_notifier_parse_fwnode_endpoints()`

它会解析 **当前 `rkisp0_vir0` 节点下 port/endpoint 描述的远端连接**。

以 `rk3588-evb1-imx415.dtsi` 为例：

- `rkisp0_vir0` 的 endpoint 远端是 `rkcif_mipi_lvds_sditf` 的 endpoint

所以 notifier 并不一定直接发现 sensor，它先发现的是：
- 这个 vir ISP 在设备树 graph 中连接到谁

在 RK3588 常见场景中，这个“谁”往往是：
- `rkcif` 的 sditf 输出端

---

## 12.2 `bound` 回调：收集异步子设备

当远端 subdev 准备就绪时，`subdev_notifier_bound()` 会把它挂入：

- `isp_dev->sensors[]`
- `isp_dev->num_sensors++`

这里名字叫 `sensors`，但实际上在 RK3588 的 CIF 透传场景里，**它里面不一定真是物理 sensor subdev，也可能是中间路由 subdev / video composer 类实体**。

也就是说，源码里这个数组是“上游入口实体集合”，不必狭义理解成纯 sensor。

---

## 12.3 `complete` 回调：正式搭媒体链
当所有异步实体绑定完成，就会执行：

- `subdev_notifier_complete()`

这个函数里顺序非常关键：

1. `rkisp_create_links(dev)`
2. `v4l2_device_register_subdev_nodes(&dev->v4l2_dev)`
3. `rkisp_update_sensor_info(dev)`（有输入时）
4. `_set_pipeline_default_fmt(dev, true)`

这才是真正把整个 graph 串起来的时刻。

---

# 13. `rkisp_create_links()`：把图真正连起来

这是你博客思路里最值得展开的一点。

这个函数会遍历 `isp_dev->sensors[]` 里的上游实体，根据它们的 `entity.function` 和 mbus 类型来决定如何连线。

---

## 13.1 如果上游是直接 sensor
则直接建立：

`sensor -> rkisp-isp-subdev`

并把 `dev->isp_inp = INP_DVP`

---

## 13.2 如果上游是 video composer / CIF 类实体
则建立：

`remote entity -> rkisp-isp-subdev`

并设置：

- `dev->isp_inp = INP_CIF`

这对 RK3588 尤其重要，因为很多实际项目里就是这条路：
- sensor 数据先由 rkcif 接收
- 再通过 sditf 提供给 rkisp-vir

也就是在 RK3588 上，**ISP 的直接上游往往是 CIF 输出，而不是 sensor 本体。**

---

## 13.3 如果是 MIPI/PHY 类型
则可能建立：

`phy -> csi subdev -> isp subdev`

并设置：
- `dev->isp_inp = INP_CSI`

---

# 14. `rkisp_update_sensor_info()`：获取当前输入源的格式/总线信息

链路建立后，驱动需要知道当前输入到底是什么格式、分辨率、总线类型，于是会执行：

- `rkisp_update_sensor_info()`

它会做几件事：

1. 找到 `rkisp-isp-subdev` 的实际远端输入实体
2. 获取 `mbus` 配置
3. 获取 active format
4. 获取 frame interval
5. 更新 `dev->active_sensor`

在 RK3588 上，哪怕上游不是“纯 sensor”，这一步依然是为了最终拿到：
- 输入宽高
- bus code
- fps
- mipi vc/dt 等

这些信息后面用于：
- 默认裁剪
- 默认输出格式
- 时钟计算
- stream 默认分辨率设置

---

# 15. `_set_pipeline_default_fmt()`：设置默认 pipeline 格式

这一步很重要，但很多博客会一笔带过。

它做的事情是：

## 15.1 给 ISP sink pad 设置输入格式
来自上游 sensor/cif 的当前 active format。

## 15.2 给 ISP sink pad 设置 crop
调用 `rkisp_align_sensor_resolution()` 计算默认裁剪窗口。

对于不同 ISP 版本，`rkisp.h` 里定义了不同最大输入尺寸。

例如：
- `CIF_ISP_INPUT_W_MAX_V30 = 4672`
- `CIF_ISP_INPUT_H_MAX_V30 = 3504`

RK3588 对应 3x 架构，所以这类 V30/V32 上限生效。

---

## 15.3 给 ISP source path 设置输出格式
如果输入是 Bayer RAW，默认 source path 会先转成 YUYV 这类 YUV 输出模型，再给 MP/SP 设默认格式。

---

## 15.4 给各 stream 设置默认格式
例如：

- `MP` 默认 NV12
- `SP` 默认 NV12
- `FBC` 默认 FBC0
- `RAWRD0/1/2` 默认 raw 对应格式

所以这一步之后，即使用户空间还没显式 `S_FMT`，整条 pipeline 已经有了一套可工作的初始格式。

---

# 16. `rkisp_proc_init()`：创建 `/proc` 节点

这是你提到的最后一步。

probe 完成后会创建类似：
- `/proc/rkisp0-vir0`

这个 proc 节点一般用于调试：
- 时钟
- 中断
- 输入状态
- 运行统计

它不影响功能路径，但非常方便排查 ISP 初始化和运行问题。

---

# 17. 到 probe 结束时，RK3588 上到底注册出了哪些实体？

按 RK3588 这份驱动源码，可以把 `rkisp0_vir0` probe 完成后的软件对象归纳成：

## 17.1 一个 media device
整个 ISP 实例的容器。

## 17.2 一个核心 ISP subdev
- `rkisp-isp-subdev`

## 17.3 若干 stream video device
常见：
- MP
- SP
- FBC
- VIR
以及某些版本下的 BP / MPDS / BPDS

## 17.4 三个 raw dmarx video device
- `RAWRD0`
- `RAWRD1`
- `RAWRD2`

## 17.5 一个 statistics video device
- `rkisp-statistics`

## 17.6 一个 params video device
- `rkisp-input-params`

## 17.7 一个 luma video device
用于某些亮度/辅助统计

## 17.8 可能的 CSI / bridge subdev
是否成为活跃链路要看实际拓扑

---

# 18. RK3588 上 `rkisp0_vir0` 的“vir”到底是什么含义？

这是很多人读 RK3588 camera 驱动时最容易混乱的点。

我的理解结合这份源码可以总结为：

## 它不是“假的 ISP”
`rkisp0_vir0` 最终还是绑定真实 `rkisp0` 硬件资源的，`rkisp_attach_hw()` 就是干这个。

## 它叫 vir，是因为它是“媒体框架视角下的虚拟 ISP 实例入口”
这个入口：
- 不直接等同于底层寄存器块节点
- 负责承接上游 graph 连接
- 负责注册 V4L2/media 对象
- 负责把真实 ISP 能力包装成一个 media pipeline

在 RK3588 上，由于 camera 前端引入了：
- CSI2 DPHY
- MIPI CSI2 Host
- RKCIF
- SDITF

所以 ISP 在软件上不再是“sensor 直连的唯一入口”，而更像是一个**后级处理引擎实例**。  
因此 `rkisp-vir` 这个命名是很合理的。

---

# 19. probe 结束后，后续 stream-on 时又发生什么？

你这次主要问的是驱动初始化，但为了让整个图闭环，我把后续也补一下。

真正开始采流时，关键流程在 `rkisp_pipeline_*` 和 `rkisp_isp_start()` 这几组函数里。

---

## 19.1 `rkisp_pipeline_open()`
作用：
- 遍历 media graph，找到当前启用链路上的所有 subdev
- 准备 pipeline
- 计算 ISP clock
- 做必要的 CSI patch/config

这里会先走 `__isp_pipeline_prepare()`，沿 media graph 从当前实体往上游回溯，把活跃 subdev 收集到 `p->subdevs[]`。

---

## 19.2 `rkisp_pipeline_set_stream(true)`
stream-on 顺序在源码注释写得很清楚：

- 先 `isp_subdev`
- 再 `mipi dphy`
- 最后 `sensor`

即：
1. `v4l2_subdev_call(&dev->isp_sdev.sd, video, s_stream, true)`
2. 再对上游 subdev 逐个 `s_stream(true)`

这个顺序体现了 RK ISP 的设计思路：
- 先让后级 ISP 准备好
- 再打开前级数据源
- 避免数据先到、后级还没 ready

---

## 19.3 `rkisp_isp_start()`
这一步是硬件真正开始跑的入口，主要完成：

- 使能 ISP 中断
- 配置 MIPI/路径
- 设置 `CIF_ISP_CTRL`
- 打开 ISP/MI 等硬件模块
- 准备 3A 相关状态

---

## 19.4 `rkisp_config_cif()`
内部会继续做：

- `rkisp_config_isp()`
- `rkisp_config_path()`
- `rkisp_config_ism()`

### 其中最关键的是 `rkisp_config_path()`
它根据 `dev->isp_inp` 判定当前输入来源：

- `INP_CSI`
- `INP_DVP`
- `INP_LVDS`
- `INP_DMARX_ISP`
- `INP_CIF`

对 RK3588 常见板级：
**多半最终会走 `INP_CIF` 或 `INP_CSI` 相关路径。**

---

# 20. 用 RK3588 实际项目视角，整个初始化链可以怎么理解？

你可以把整个 RK3588 ISP 初始化理解成五层。

---

## 第 1 层：设备树 graph 描述物理连接
例如：

`IMX415 -> DPHY -> CSI2 -> RKCIF -> SDITF -> RKISP0_VIR0`

---

## 第 2 层：`rkisp-vir` probe 绑定真实 ISP 硬件
`rkisp_plat_probe()`
-> `rkisp_attach_hw()`

把 `rkisp0_vir0` 映射到真实 ISP0。

---

## 第 3 层：注册 media/v4l2 软件实体
`rkisp_register_platform_subdevs()`

创建：
- ISP subdev
- stream video
- dmarx video
- stats/params/luma video
- csi/bridge subdev

---

## 第 4 层：异步发现上游并自动建图
`isp_subdev_notifier()`
-> `rkisp_create_links()`
-> `rkisp_update_sensor_info()`
-> `_set_pipeline_default_fmt()`

这一步让 graph 从“零散实体”变成“可工作的媒体拓扑”。

---

## 第 5 层：stream-on 时配置真实硬件
`rkisp_pipeline_open()`
-> `rkisp_pipeline_set_stream()`
-> `rkisp_isp_start()`
-> `rkisp_config_cif()/rkisp_config_isp()/rkisp_config_path()`

最终让数据真的从上游流进 ISP，再从 MP/SP/FBC/VIR 输出，统计走 stats，参数走 params。

---

# 21. 按你给的博客格式，整理一版 RK3588 专用“精简主线”

下面这版可以直接作为你后续笔记骨架：

### 1）平台驱动注册
`rkisp_plat_drv`
-> 匹配 `rockchip,rkisp-vir`
-> 进入 `rkisp_plat_probe`

### 2）`rkisp_plat_probe`
- 分配 `rkisp_device`
- `rkisp_attach_hw`：根据 `rockchip,hw` 绑定真实 ISP 硬件
- `v4l2_ctrl_handler_init`
- `v4l2_device_register`
- `media_device_init`
- `media_device_register`
- `rkisp_register_platform_subdevs`
- `rkisp_proc_init`

### 3）`rkisp_register_platform_subdevs`
- `rkisp_register_isp_subdev`  
  创建核心 `rkisp-isp-subdev`
- `rkisp_register_csi_subdev`
- `rkisp_register_bridge_subdev`
- `rkisp_register_stream_vdevs`
  - `rkisp_register_stream_v30`
  - `rkisp_stream_init`
  - `rkisp_init_vb2_queue`
  - `rkisp_register_stream_vdev`
  - 创建 MP/SP/FBC/VIR 等 video 节点
- `rkisp_register_dmarx_vdev`
  - 创建 `RAWRD0/1/2`
- `rkisp_register_stats_vdev`
  - 创建 `rkisp-statistics`
- `rkisp_register_params_vdev`
  - 创建 `rkisp-input-params`
- `rkisp_register_luma_vdev`
- `isp_subdev_notifier`

### 4）`isp_subdev_notifier`
- `v4l2_async_notifier_init`
- `v4l2_async_notifier_parse_fwnode_endpoints`
  - 解析 `rkisp0_vir0/port/endpoint`
- `v4l2_async_notifier_register`

### 5）异步绑定完成后
`subdev_notifier_complete`
- `rkisp_create_links`
- `v4l2_device_register_subdev_nodes`
- `rkisp_update_sensor_info`
- `_set_pipeline_default_fmt`

### 6）RK3588 典型链路
`Sensor -> DPHY -> CSI2 -> RKCIF -> SDITF -> RKISP0_VIR0`

所以：
- `rkisp0_vir0` 是 media 框架视角下的 ISP 虚拟实例入口
- 背后仍绑定真实 ISP0 硬件
- 上游常见不是直接 sensor，而是 `rkcif_sditf`

---

# 22. 你那段原始分析里，建议修正的几句话

我帮你直接改成更适合 RK3588 的版本：

### 原说法 1
> `rkisp_attach_hw--获取子节点"rockchip,hw"的信息。`

建议改成：

> `rkisp_attach_hw`：解析 `rockchip,hw`，把 `rkisp-vir` 虚拟节点绑定到真实 ISP 硬件节点，建立 `hw_dev/base_addr/isp_ver/dev_id` 等核心硬件上下文。

---

### 原说法 2
> `rkisp_register_csi_subdev--ISP_V30跳过此函数。`

建议改成：

> `rkisp_register_csi_subdev`：在注册阶段仍会创建 CSI 相关 subdev；但在 RK3588 常见 `RKCIF SDITF -> RKISP_VIR` 拓扑里，它不一定成为最终活跃数据链路的关键节点。

---

### 原说法 3
> `rkisp_register_dmarx_vdev ... video_register_device--创建v4l2设备rkisp-statistics`

建议改成：

> `rkisp_register_dmarx_vdev`：创建 `RAWRD0/1/2` 这类 raw readback DMA video 节点；  
> `rkisp_register_stats_vdev` 才是创建 `rkisp-statistics` 节点。

---

# 23. 最后的结论

如果只站在 **RK3588** 这个 SoC 上理解，这套 RK ISP 驱动可以概括为：

## 一句话版
**`rkisp-vir` 是 RK3588 上 ISP 在 V4L2/Media 框架中的“软件实例入口”，probe 时先绑定真实 ISP 硬件，再注册 ISP subdev、stream/stats/params/dmarx 等媒体实体，最后通过 async notifier 按设备树 graph 自动把上游 CIF/CSI/sensor 链接起来。**

## 再展开一点
它不是简单的“ISP 硬件驱动初始化”，而是同时完成了三件事：

1. **硬件绑定**  
   `rkisp_attach_hw` 把虚拟节点绑定到真实 ISP0/ISP1。

2. **媒体实体建模**  
   把 ISP 处理链拆成：
   - ISP subdev
   - 输出 stream video
   - raw dmarx video
   - stats / params / luma video

3. **图拓扑自动拼接**  
   通过设备树 endpoint + async notifier，自动把上游 `sensor / csi / rkcif_sditf` 连到 ISP。

对 RK3588 特别要记住的一点是：

**很多实际工程里，`rkisp0_vir0` 的直接上游不是 sensor，而是 `rkcif_mipi_lvds_sditf`。**  
所以看 RK3588 camera 驱动时，不能只盯着 ISP，要把：
- sensor
- csi2 dphy
- mipi csi2 host
- rkcif
- sditf
- rkisp-vir

当成一个整体 pipeline 来看。

---