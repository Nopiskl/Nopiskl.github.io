# A733 VIN Pipeline And `isp_sel` Analysis

## 1. 目的

本文结合当前工作区里的 DTS 和 `bsp/drivers/vin` 源码，整理以下问题：

1. `vinc8` 为什么还要单独配置 `vinc8_isp_sel`，不能“沿用” `vinc0` 的 ISP 选择。
2. 如果 `vinc0` 和 `vinc8` 都写 `isp_sel = <0>`，为什么在“二选一”使用时可以工作。
3. VIN 是否会在每次启动时重新构建 pipeline。
4. 为什么同一个 `isp_sel` 只适合互斥使用，不适合并发使用。

说明：

- 本文以 `device/config/chips/a733/configs/pro3/linux-6.6/board.dts` 为主。
- 你前面提到的 `ov13b10_mipi_b + gc05a2_mipi_f` 场景来自 `agent/1.dts`，其分析结论与 `pro3` 完全一致，只是 sensor 名称不同。

## 2. 先看当前 DTS

### 2.1 `pro3` 当前配置

当前 `pro3` 里与本文最相关的节点如下：

- `&vind0` 下启用了 `isp00`，并把 `work_mode = <1>`，即逻辑 ISP0 工作在 offline 模式。
  参考：`device/config/chips/a733/configs/pro3/linux-6.6/board.dts:2012-2054`
- `sensor0` 是 `ov13850_mipi`，`sensor2` 是 `gc05a2_mipi`。
  参考：`device/config/chips/a733/configs/pro3/linux-6.6/board.dts:2161-2233`
- `vinc0` 使用 `csi1/mipi1/isp0`，绑定 `sensor0`。
  参考：`device/config/chips/a733/configs/pro3/linux-6.6/board.dts:2291-2304`
- `vinc8` 使用 `csi0/mipi0/isp0`，绑定 `sensor2`。
  参考：`device/config/chips/a733/configs/pro3/linux-6.6/board.dts:2405-2418`

也就是说，在 `pro3` 里你关心的实际组合是：

- `vinc0 -> sensor0(ov13850_mipi) -> csi1 -> isp_sel 0`
- `vinc8 -> sensor2(gc05a2_mipi) -> csi0 -> isp_sel 0`

### 2.2 你前面提到的 `ov13b10 + gc05a2` 场景

在 `agent/1.dts` 中：

- `sensor0` 是 `ov13b10_mipi_b`
- `sensor2` 是 `gc05a2_mipi_f`
- `vinc0_isp_sel = <0>`
- `vinc8_isp_sel = <0>`

参考：

- `agent/1.dts:2-33`
- `agent/1.dts:66-95`
- `agent/1.dts:165-183`
- `agent/1.dts:327-345`

因此，虽然具体 sensor 名不同，但问题本质完全一样。

## 3. DTS 字段在 VIN 驱动中的含义

`vin_core.c` 在 `vinc` probe 时，会把 DTS 中的 `rear_sensor_sel`、`front_sensor_sel`、`csi_sel`、`mipi_sel`、`isp_sel`、`isp_tx_ch`、`tdm_rx_sel` 读入 `struct vin_core`：

参考：`bsp/drivers/vin/vin-video/vin_core.c:2139-2169`

这里有两个容易混淆的点：

1. `rear_sensor_sel/front_sensor_sel`
   它们表示这个 `vinc` 能切到哪个 sensor module。
   它们不是 ISP 绑定关系。

2. `isp_sel`
   它表示这个 `vinc` 的输出链路最终要走哪个 ISP 或虚拟 ISP 通道。
   它不是从别的 `vinc`“继承”的，也不是全局自动共享的。

另外，`utility/config.c` 会根据 `vincX_rear_sensor_sel` / `vincX_front_sensor_sel` 把 `vinc` 和相应 module 的 sensor 配置关联起来：

参考：`bsp/drivers/vin/utility/config.c:587-624`

所以：

- `sensor_sel` 决定“当前用哪个 sensor”
- `isp_sel` 决定“当前采集链最后接到哪个 ISP 通道”

这两件事是分开的。

## 4. VIN 框架分两层：静态图和运行时生效链路

这是理解整个问题的关键。

### 4.1 第一层：media graph 拓扑只在 probe 时创建一次

VIN probe 时会做三件事：

1. 注册所有 entity 和 subdev
2. 创建所有可能存在的 media links
3. 根据默认配置打开一部分默认链路

对应代码：

- `vin_md_register_entities()`
- `vin_create_media_links()`
- `vin_setup_default_links()`

参考：

- `bsp/drivers/vin/vin.c:2555-2588`
- `bsp/drivers/vin/vin.c:2042-2224`
- `bsp/drivers/vin/vin.c:2226-2268`

这一步的特点是：

- `sensor -> mipi/csi` 的候选 link 被创建出来
- `csi -> isp` 的候选 link 被创建出来
- `isp -> scaler` 的候选 link 也被创建出来
- 这些 link 大多是“先创建，再按需 enable/disable”

换句话说，probe 时建立的是“全量候选拓扑”，不是“每次开流都重新造一遍图”。

### 4.2 第二层：运行时会重新选择当前生效 route

虽然拓扑只建一次，但当前真正生效的链路会在运行时切换。

VIN 的思路不是“删除旧图再新建一张图”，而是：

- 候选 link 常驻
- 当前要用哪条 sensor 路、哪条 csi 路、哪条 isp 路，在 `S_INPUT / STREAMON / STREAMOFF / CLOSE` 时动态 enable/disable
- `cap->pipe.sd[]` 也会按当前已打开的 link 重新准备

## 5. probe 阶段到底创建了什么

### 5.1 `vin_create_media_links()`

`vin_create_media_links()` 会为每个 `vinc` 创建它可能用到的 sensor 路和 capture 路：

- `sensor -> mipi`
- `mipi -> csi`
- `csi -> isp`
- `isp -> scaler`
- `scaler -> vin subdev`
- `vin subdev -> video device`

参考：`bsp/drivers/vin/vin.c:2042-2224`

尤其重要的是两点：

1. `sensor_link_to_mipi_csi()` 会把 `rear_sensor` 和 `front_sensor` 对应的 sensor 候选 link 都建出来。
   参考：`bsp/drivers/vin/vin.c:2032-2038`

2. `csi -> isp`、`isp -> scaler` 也是候选 link，不是“一旦创建就永远表示当前正在走这条链”。

### 5.2 `vin_setup_default_links()`

`vin_setup_default_links()` 会按 `vinc->isp_sel` 和 `vinc->vipp_sel` 找到 `isp -> scaler` link，然后 enable。

参考：`bsp/drivers/vin/vin.c:2226-2268`

注意：

- 这里只是先把 `ISP -> 当前 vipp/scaler` 的默认 link 打开。
- 它不代表 sensor 输入侧已经最终确定。
- 真正的 sensor 选择、csi 选择、csi 到 isp 的生效关系，还是运行时再切。

## 6. 运行时流程：`open`、`S_INPUT`、`STREAMON`、`STREAMOFF`、`close`

## 6.1 `vin_open()` 只进入低功耗待机状态，不真正建当前链路

`vin_open()` 做的事情很轻：

- `VIN_LPM = 1`
- `VIN_BUSY = 1`
- 创建事件队列

参考：`bsp/drivers/vin/vin-video/vin_video.c:3688-3722`

也就是说：

- `open("/dev/videoX")` 并不会把当前 sensor 路完全拉起来
- 它只是告诉 VIN：“这个节点被打开了，后续可以切链路、开流”

## 6.2 `VIDIOC_S_INPUT` 才是真正选择当前 sensor 的关键入口

`VIDIOC_S_INPUT -> vidioc_s_input() -> __vin_s_input()`

参考：

- `bsp/drivers/vin/vin-video/vin_video.c:2476-2492`
- `bsp/drivers/vin/vin-video/vin_video.c:2368-2462`

在 `__vin_s_input()` 里，顺序非常明确：

1. 根据输入号决定 `vinc->sensor_sel = rear_sensor` 或 `front_sensor`
   参考：`vin_video.c:2368-2373`

2. 使能 `sensor -> mipi/csi` link
   调用 `__vin_sensor_setup_link(..., 1)`
   参考：`vin_video.c:2381-2384`

3. 使能 `csi -> isp` link
   调用 `__csi_isp_setup_link(..., 1)`
   参考：`vin_video.c:2385-2388`

4. 调 `vin_pipeline_call(open, ..., prepare=true)`
   参考：`vin_video.c:2394-2400`

5. 初始化 ISP、SCALER、SENSOR
   参考：`vin_video.c:2414-2462`

这里的重点是第 4 步。

## 6.3 `vin_md_prepare_pipeline()` 会根据当前已 enable 的 link 重新准备 `cap->pipe.sd[]`

`vin_pipeline_call(open)` 最终会进入 `__vin_pipeline_open()`。

如果 `prepare=true`，它会先调用 `vin_md_prepare_pipeline()`：

- 从 video entity 出发
- 顺着当前 remote pad 往上游回溯
- 把当前真正生效的 `sensor/mipi/csi/tdm/isp/scaler/capture` 填进 `p->sd[]`

参考：

- `bsp/drivers/vin/vin.c:1249-1278`
- `bsp/drivers/vin/vin.c:83-126`

这说明：

- media graph 不会每次新建
- 但是当前 pipeline 缓存 `cap->pipe.sd[]` 会根据“此刻已经打开的 link”重新准备

所以可以说：

- “拓扑”是静态的
- “当前 route”和 `pipe.sd[]` 是动态的

## 6.4 `VIDIOC_STREAMON` 会再次确认 link，并重写硬件 mux

`VIDIOC_STREAMON -> vidioc_streamon()`

参考：`bsp/drivers/vin/vin-video/vin_video.c:2140-2200`

如果当前还在 `VIN_LPM` 状态，它会先补做：

- `__vin_sensor_setup_link(..., 1)`
- `__csi_isp_setup_link(..., 1)`

然后再调用：

- `vin_pipeline_call(set_stream, &cap->pipe, ...)`

## 6.5 `__vin_pipeline_s_stream()` 每次开流都会重新写硬件输入选择

这是本文最关键的一段代码。

在 `__vin_pipeline_s_stream()` 中，只要准备开流，驱动会先做硬件 mux 选择：

- `csic_isp_input_select(...)`
- `csic_vipp_input_select(...)`

参考：`bsp/drivers/vin/vin.c:1428-1468`

然后才按顺序对各 subdev 调 `s_stream`：

- sensor
- mipi
- csi
- isp
- scaler
- capture

参考：`bsp/drivers/vin/vin.c:1482-1512`

这意味着：

- 每次 `STREAMON`，硬件层的“哪路 CSI 喂给哪个 ISP 通道”都会被重新编程
- 不是只在 probe 时配一次
- 也不是只在第一次开机时固定下来

## 6.6 `stream_count` 只防止重复调用 subdev `s_stream`，并不保护前面的 mux 选择

`__vin_subdev_set_stream()` 里有 `stream_count` 计数，作用是：

- 如果某个 subdev 已经在流状态，就不重复再调它的 `video.s_stream`

参考：`bsp/drivers/vin/vin.c:1311-1383`

但是请注意：

- `stream_count` 的判断发生在 `csic_isp_input_select()` 和 `csic_vipp_input_select()` 之后
- 也就是说，前面的硬件 mux 选择已经先被改掉了

这就是为什么“同一个 `isp_sel` 并发使用”会出问题。

## 6.7 `VIDIOC_STREAMOFF` 和 `close` 会把当前动态 link 撤掉

`VIDIOC_STREAMOFF` 时：

- 调 `vin_pipeline_call(set_stream, 0)` 停流
- `__csi_isp_setup_link(..., 0)` 关掉 `csi -> isp`
- `__vin_sensor_setup_link(..., 0)` 关掉 `sensor -> mipi/csi`
- 把状态置回 `VIN_LPM`

参考：`bsp/drivers/vin/vin-video/vin_video.c:2251-2294`

`vin_close()` 时，如果还没回到 LPM，还会再次做一遍 link disable，然后调用 `vin_pipeline_call(close)` 去断电：

参考：`bsp/drivers/vin/vin-video/vin_video.c:3725-3805`

因此，一个 `vinc` 完整关掉以后，它那条运行时生效链路会被撤销，后一个 `vinc` 可以重新把自己的链路打开。

## 7. 为什么两个 `vinc` 都写 `isp_sel = <0>`，在“二选一”场景下是可以工作的

答案是：因为它们不是同时占用，而是“前一个完整关闭，后一个重新建当前 route 并重写硬件 mux”。

具体过程如下：

1. `vinc0` 工作时：
   - 当前有效的是 `sensor0 -> mipi1 -> csi1 -> isp_sel 0 -> vipp0`
   - `STREAMON` 时已经把 `csic_isp_input_select(..., csi1, isp_sel0)` 写进硬件

2. `vinc0` 关闭时：
   - `STREAMOFF/CLOSE` 会关掉动态 link
   - 当前 route 被撤销

3. `vinc8` 开始工作时：
   - 重新打开 `sensor2 -> mipi0 -> csi0 -> isp_sel 0 -> vipp8`
   - `vin_md_prepare_pipeline()` 重新准备这次的 `cap->pipe`
   - `STREAMON` 时重新执行 `csic_isp_input_select(..., csi0, isp_sel0)`

因为整个过程是串行互斥的，所以虽然都写了 `isp_sel = <0>`，仍然可以正常使用。

换句话说：

- 这里的“复用”不是静态继承
- 而是运行时重新切换 route 和硬件寄存器

## 8. 为什么同一个 `isp_sel` 不适合并发

### 8.1 ISP600 的虚拟 ISP 映射

在 A733 这套 ISP600 配置里：

- `isp_virtual_find_logic[0..3] = 0`
- `isp_virtual_find_sel[0..3] = 0`
- `isp_ch_find[0..3] = 0,1,2,3`

参考：`bsp/drivers/vin/vin-isp/isp600/isp600_reg_cfg.c:32-47`

这表示：

- `isp_sel = 0/1/2/3` 本质上都属于同一个逻辑 ISP0
- 区别只是走 ISP0 的不同虚拟处理通道
- 如果两个 `vinc` 都写 `isp_sel = 0`，那它们实际上抢的是同一个逻辑 ISP0 的同一个虚拟输入通道

### 8.2 offline 模式允许虚拟通道存在，但不等于同一虚拟通道可以共享

`sunxi_isp.c` 对逻辑 ISP 和虚拟 ISP 的处理是：

- 逻辑 ISP 读取 `work_mode`
- 如果逻辑 ISP 是 offline，则其虚拟 ISP 可以参与工作
- `sunxi_isp_logic_s_stream()` 用 `logic_top_stream_count` 管理逻辑 ISP 顶层启停

参考：

- `bsp/drivers/vin/vin-isp/sunxi_isp.c:3300-3312`
- `bsp/drivers/vin/vin-isp/sunxi_isp.c:635-653`

这保证的是：

- 逻辑 ISP0 可以承载多个虚拟 ISP 通道

但它不表示：

- 两条 pipeline 可以同时共用同一个 `isp_sel`

### 8.3 并发冲突的根本原因

如果 `vinc0` 和 `vinc8` 同时都写 `isp_sel = <0>`：

1. `vinc0` 先开流，会把 `isp_sel 0` 指向自己的 `csi1`
2. `vinc8` 后开流，又会把同一个 `isp_sel 0` 改指到自己的 `csi0`
3. 即使 ISP subdev 因为 `stream_count` 不重复执行 `s_stream`，前面的 `csic_isp_input_select()` 已经把输入改掉了

所以并发时冲突发生在“硬件输入选择寄存器被重写”，而不是发生在 media graph 层。

一句话总结：

- `stream_count` 防的是重复启停 subdev
- 防不了多个 pipeline 对同一 `isp_sel` 的寄存器重编程

## 9. 结合 `pro3` 和 `agent/1.dts` 的具体结论

### 9.1 `pro3` 当前板级文件

当前 `pro3` 里：

- `vinc0` 绑定 `sensor0(ov13850_mipi)`，`isp_sel = 0`
- `vinc8` 绑定 `sensor2(gc05a2_mipi)`，`isp_sel = 0`

参考：

- `device/config/chips/a733/configs/pro3/linux-6.6/board.dts:2161-2233`
- `device/config/chips/a733/configs/pro3/linux-6.6/board.dts:2291-2304`
- `device/config/chips/a733/configs/pro3/linux-6.6/board.dts:2405-2418`

因此：

- 如果设计目标是“前后摄切换”，这个配置可以成立
- 如果设计目标是“前后摄并发”，这个配置不安全

### 9.2 你前面讨论的 `ov13b10 + gc05a2`

在 `agent/1.dts` 里：

- `vinc0` 对应 `ov13b10_mipi_b`
- `vinc8` 对应 `gc05a2_mipi_f`
- 二者同样都写了 `isp_sel = 0`

参考：

- `agent/1.dts:2-33`
- `agent/1.dts:66-95`
- `agent/1.dts:165-183`
- `agent/1.dts:327-345`

它与 `pro3` 的分析结论完全一致：

- 互斥可用
- 并发会抢同一个 ISP 虚拟输入通道

## 10. 最终结论

### 10.1 关于“VIN 每次启动会不会重新构建 pipeline”

准确说法是：

- media graph 拓扑不会每次重建，probe 时就已经创建好了
- 但当前生效的 sensor link、csi->isp link、`cap->pipe.sd[]`，会在 `S_INPUT/open/streamon` 时重新准备
- 硬件输入选择寄存器会在每次 `STREAMON` 时重新写入

### 10.2 关于“为什么 `vinc8` 还要再写 `isp_sel = 0`”

因为每个 `vinc` 都是一条独立 pipeline 描述：

- `vinc0_isp_sel` 只描述 `vinc0`
- `vinc8_isp_sel` 只描述 `vinc8`

驱动不会因为 `vinc0` 已经写了 ISP0，就自动把 `vinc8` 绑定到同一个 ISP。

### 10.3 关于“为什么二选一时可以都用 `isp_sel = 0`”

因为关闭前一路后：

- 动态 link 会被撤销
- 下一路会重新 enable 自己的 link
- `STREAMON` 时重新把 `isp_sel 0` 指到自己的 `csi_sel`

这属于运行时复用，不属于静态共享。

### 10.4 关于“为什么并发不行”

因为两个 `vinc` 若都使用同一个 `isp_sel`：

- 后开流的一路会重写前一路已经配置好的 `csic_isp_input_select()`
- 冲突点在硬件 mux，而不是 media graph

因此：

- 同一个 `isp_sel` 适合互斥复用
- 不适合同步并发

## 11. 可继续排查的方向

如果后续目标是做双摄并发，下一步建议重点核对：

1. 是否应该把不同并发 pipeline 分配到不同的 `isp_sel`
2. 这些 `isp_sel` 是否映射到不同虚拟 ISP 通道
3. `vipp_sel` 和 scaler 资源是否也存在类似共享冲突
4. 当前 `csi_sel/mipi_sel` 的硬件连线是否支持目标组合

如果需要，可以继续在这份文档基础上补一版“按 `pro3` DTS 逐节点画出 `vinc0` 和 `vinc8` 的完整 route 图”。 
