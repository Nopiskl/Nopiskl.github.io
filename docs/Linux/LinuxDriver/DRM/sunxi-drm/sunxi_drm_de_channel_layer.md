# A733 sunxi DRM 中 DE / channel / layer 关系源码问答

本文只基于 `bsp/drivers/drm` 相关源码来分析 sunxi DRM 驱动如何抽象 DE、channel、layer 之间的关系，并补充 A733 当前代码树里的实际 SoC/板级配置例子。

阅读范围主要包括：

- `bsp/drivers/drm/sunxi_drm_crtc.c`
- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c`
- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.c`
- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/bld/de_bld*.c`
- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/ovl/de_ovl*.c`
- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_frontend*.c`
- `bsp/include/video/sunxi_drm.h`

## 先给结论

在这套 sunxi DRM 实现里，抽象关系不是“一个硬件 layer 对一个 DRM plane”，而是下面这套层次：

```text
sunxi_display_engine
  -> sunxi_de_out[disp]
     -> de_bld_handle      // 输出侧 blender
     -> de_backend_handle  // 输出侧 backend PQ/gamma/csc/smbl/...
     -> de_fmt_handle      // 输出格式模块
     -> de_channel_handle[ch]
        -> de_ovl_handle
        -> de_afbd_handle / de_tfbd_handle
        -> de_scaler_handle
        -> de_frontend_handle
           -> snr / sharp / cdc / dci / dlc / fcm / csc ...

DRM 视角：
  CRTC  <-> sunxi_de_out
  Plane <-> de_channel_handle
  Layer <-> 一个 channel 内的 OVL 子层，不直接暴露成独立 DRM plane
```

也就是说：

- 一个 `DE 输出通路` 被抽象成一个 `CRTC`
- 一个 `channel` 被抽象成一个 `DRM plane`
- 一个 `channel` 内部最多 4 个 `layer`
- 这 4 个 layer 不是 4 个 DRM plane，而是塞进一个 `display_channel_state` 里

## A733 当前代码树里的实际背景是什么？

### Q1：A733 用的是哪一代 DE？

答：A733 在当前代码树里对应 `sun60iw2p1`，DE compatible 是 `allwinner,display-engine-v352`。

源码证据：

- `bsp/configs/linux-6.6/sun60iw2p1.dtsi:3740-3743`

```dts
de: de@5000000 {
	compatible = "allwinner,display-engine-v352";
```

这意味着 A733 走的是 `sunxi_de.c` 里的 `de352_data` 和 `de_top.c` 里的 `de352` 能力描述，而不是 v350/v355。

### Q2：A733 的 `chn_cfg_mode` 真正会影响什么？

答：它直接决定某个 blender 能接哪些 channel，也就决定了“每个 CRTC 下面有多少 plane、每个 plane 对应哪类 channel”。

源码证据：

- `sunxi_de_parse_dts()` 从 DTS 读取 `chn_cfg_mode`：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c:1084-1090`
- A733 PRO2 Linux 6.6 设成 `0`：`device/config/chips/a733/configs/pro2/linux-6.6/board.dts:1524-1526`
- A733 EVB1 Linux 6.6 设成 `2`：`device/config/chips/a733/configs/evb1/linux-6.6/board.dts:1604-1607`
- v352 的 blender 通道模式表：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/bld/de_bld_platform.c:257-342`

以 A733 的 v352 为例：

- `mode 0`
  - `bld0` 接 `v0 v1 v2 u0 u1 u2`
  - `bld1` 接 `u3`
- `mode 2`
  - `bld0` 接 `v0 v1 u0 u2`
  - `bld1` 接 `v2 u1 u3`

所以 A733 不同板型的 `chn_cfg_mode` 会直接改变两个 display pipeline 的 plane 拆分方式。

进一步换算成 DRM 对象数量就是：

- `mode 0`
  - `CRTC0` 下有 6 个 plane
  - `CRTC1` 下有 1 个 plane
- `mode 2`
  - `CRTC0` 下有 4 个 plane
  - `CRTC1` 下有 3 个 plane

原因是 bind 时直接取 `display_out->ch_cnt` 作为 `plane_cnt`：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c:1310-1323`

## DRM 顶层对象是怎么对上 DE 的？

### Q3：整个 DE 硬件在驱动里最顶层的对象是谁？

答：是 `struct sunxi_display_engine`，它代表整块 DE IP；而 `struct sunxi_de_out` 代表 DE 里的一个输出通路。

源码证据：

- `sunxi_display_engine` 定义：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c:132-158`
- `sunxi_de_out` 定义：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c:102-130`

其中：

- `sunxi_display_engine` 持有 `top_hdl`、`wb`、`display_out[]`、`chn_cfg_mode`、时钟/复位等全局资源
- `sunxi_de_out` 持有某一路输出的 `bld_hdl`、`backend_hdl`、`fmt_hdl`、`ch_hdl[]`

所以 DE 的抽象是“两层”的：

- 全局 DE：`sunxi_display_engine`
- 每路输出：`sunxi_de_out`

### Q4：为什么说一个 `sunxi_de_out` 就是一个 `CRTC`？

答：因为在 bind 阶段，驱动会遍历每个 `display_out`，为每一路都创建一个 `sunxi_drm_crtc`。

源码证据：

- 先用 DT `ports` 个数决定 `display_out_cnt`：`sunxi_de.c:1095-1108`, `sunxi_de.c:1163-1167`
- `sun60iw2p1` 的 DE 节点里确实有 `disp0`、`disp1` 两个 port：`bsp/configs/linux-6.6/sun60iw2p1.dtsi:3764-3798`
- bind 阶段给每个 `display_out` 调 `sunxi_drm_crtc_init_one()`：`sunxi_de.c:1293-1323`
- `sunxi_drm_crtc` 自身持有 `struct sunxi_de_out *sunxi_de`：`bsp/drivers/drm/sunxi_drm_crtc.c:57-77`

所以这里的映射关系非常直接：

```text
sunxi_de_out[0] -> CRTC0
sunxi_de_out[1] -> CRTC1
```

## channel 为什么被抽象成 DRM plane？

### Q5：一个 DRM plane 在这套驱动里到底对应什么硬件？

答：对应一个 `de_channel_handle`。

源码证据：

- `struct sunxi_drm_plane` 里直接挂了 `struct de_channel_handle *hdl`：`bsp/drivers/drm/sunxi_drm_crtc.c:109-115`
- bind 时把 `display_out->ch_hdl[j]` 填进 `sunxi_plane_info.hdl`：`sunxi_de.c:1310-1321`
- `sunxi_drm_plane_init()` 再把 `info->hdl` 赋给 `plane->hdl`：`sunxi_drm_crtc.c:1336-1357`

因此在这套实现里，DRM plane 本质上就是 channel 的软件壳。

再往前看一步，某个 CRTC 下面到底会创建多少 plane，也是直接由 `display_out->ch_cnt` 决定的：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c:1310-1323`

### Q6：`plane->index` 是硬件 channel id 吗？

答：不是，它更像是“当前 display_out 下的 plane 序号”，不一定等于硬件里的 `type_hw_id`。

源码证据：

- bind 时 `info.planes[j].index = j`：`sunxi_de.c:1312-1318`
- `sunxi_drm_plane_init()` 再把 `plane->index = info->index`：`sunxi_drm_crtc.c:1342-1345`
- 真正决定 channel 是视频类还是 UI 类、硬件 type id 是多少的，是 `hdl->is_video` 和 `hdl->type_hw_id`：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.h:118-135`
- blender mux 时用的是 `hdl->is_video` + `hdl->type_hw_id`，不是 `plane->index`：`sunxi_de.c:1739`, `de_bld.c:198-216`

这点非常关键：`plane->index` 是 DRM/本输出通路里的排序信息，硬件 mux 身份则保存在 `de_channel_handle` 里。

顺着这个逻辑还能看出另一个细节：primary plane 也不是“固定某个视频层”，而是“当前 `display_out` 里第 0 个 channel”。

源码证据：

- bind 时 `info.planes[j].is_primary = j == 0`：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c:1312-1315`
- `sunxi_drm_crtc_init_one()` 会在这些 plane 里找唯一的 primary：`bsp/drivers/drm/sunxi_drm_crtc.c:2489-2523`

所以在 A733 `chn_cfg_mode = 0` 时，第二路输出如果只分到 `u3`，那它的 primary plane 实际就是 UI channel `u3`，这完全是由 channel 分配结果决定的。

## 为什么不是“一层一个 plane”？

### Q7：layer 在这套驱动里为什么不是独立的 DRM plane？

答：因为驱动把“一个 channel 内部的 4 个 layer”折叠进了一个 `display_channel_state`，只把 channel 暴露成 plane。

源码证据：

- `display_channel_state` 继承自 `drm_plane_state`：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.h:91-114`
- 里面除了 `base` 这层，还额外放了：
  - `fb[3]`
  - `src_x/y/w/h[3]`
  - `crtc_x/y/w/h[3]`
  - `alpha[3]`
  - `pixel_blend_mode[3]`
  - `color[4]`

这里的语义是：

- `base.fb/base.src_*/base.crtc_*` 表示 layer0
- 数组 `fb[0..2]`、`src_*[0..2]`、`crtc_*[0..2]` 表示 layer1~layer3

所以驱动的真实抽象不是：

```text
1 layer = 1 plane
```

而是：

```text
1 channel = 1 plane
1 plane state = channel 内最多 4 个 layer 的合集
```

### Q8：这些额外 layer 怎么暴露给 userspace？

答：通过 plane 的自定义 atomic property，而不是新增 DRM plane。

源码证据：

- plane 公共/私有 property 创建：`sunxi_drm_crtc.c:1142-1250`
- plane 绑定这些 property：`sunxi_drm_crtc.c:1284-1333`
- set property 时写进 `display_channel_state`：`sunxi_drm_crtc.c:726-852`

额外 layer 相关属性包括：

- `FB_ID1/2/3`
- `SRC_X1/2/3`, `SRC_Y1/2/3`, `SRC_W1/2/3`, `SRC_H1/2/3`
- `CRTC_X1/2/3`, `CRTC_Y1/2/3`, `CRTC_W1/2/3`, `CRTC_H1/2/3`
- `alpha1/2/3`
- `pixel blend mode1/2/3`
- `COLOR`, `COLOR1`, `COLOR2`, `COLOR3`
- `layer_id`
- `FRONTEND_DATA`

这说明 userspace 若想操纵 channel 内的额外 layer，走的是“一组 property 填一份 `display_channel_state`”的思路。

### Q9：`layer_id` 这个 property 是干什么的？

答：它不是在描述“当前 plane 属于哪一层”，而是在描述“这次异步更新只想改 channel 内的哪一层”。

源码证据：

- 缺省值是 `COMMIT_ALL_LAYER`：`sunxi_drm_crtc.c:1040-1045`
- 如果 `layer_id != COMMIT_ALL_LAYER`，驱动走 async update 路径：`sunxi_drm_crtc.c:582-586`
- `sunxi_plane_atomic_precheck()` 和 `sunxi_plane_atomic_async_update()` 会围绕 `layer_id`、`fake_layer0` 做特殊处理：`sunxi_drm_crtc.c:571-724`

这段设计的核心目的，是允许在“一个 plane 对应一个 channel”的前提下，仍然能对 channel 内某个子 layer 做类似 cursor 的快速更新。

## 一个 channel 内部又是怎么继续拆 IP 的？

### Q10：`de_channel_handle` 里面到底有哪些硬件 IP？

答：一个 channel 不是单一 IP，而是一条小流水线。

源码证据：

- `de_channel.c` 开头的注释图：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.c:33-61`
- `de_channel_private` 成员：`de_channel.c:104-112`

channel 里的主要子模块是：

- `de_ovl_handle`
- `de_afbd_handle`
- `de_tfbd_handle`
- `de_scaler_handle`
- `de_frontend_handle`

也就是说，驱动对 channel 的理解不是一个“平面寄存器块”，而是：

```text
channel
  = 输入层聚合(OVL)
  + 压缩帧输入(AFBD/TFBD)
  + 缩放(Scaler)
  + 前处理(frontend PQ)
```

### Q11：channel 是怎么被构造出来的？

答：`de_channel_create()` 会按固定顺序创建子模块，并把每个子模块的寄存器 block、能力、modifier 支持合并到 `de_channel_handle` 里。

源码证据：

- `de_channel_create()`：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.c:1014-1164`

其中关键动作有：

1. 创建 `ovl`
2. 以 `ovl->channel_reg_base` 作为后续 channel 寄存器基址
3. 创建 `scaler`
4. 创建 `afbd`
5. 创建 `tfbd`
6. 创建 `frontend`
7. 汇总：
   - `formats`
   - `format_modifiers_comb`
   - `layer_cnt`
   - `mod`
   - `lbuf`
   - `block[]`

所以 `de_channel_handle` 本身就是“多个硬件 IP 的组合句柄”。

### Q12：frontend 又包含哪些模块？

答：frontend 不是一个单模块，而是一个 PQ 子系统容器。

源码证据：

- `de_frontend_private`：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_frontend.c:97-113`
- `de_frontend_create()`：`de_frontend.c:916-1048`

frontend 里会按硬件能力创建这些模块：

- `snr`
- `sharp`
- `cdc`
- `dci`
- `dlc`
- `gamma`
- `fcm`
- `csc1`
- `csc2`
- `asu` 来自 scaler 的 extra

并且 `de_frontend_apply()` 每次都会按固定顺序配置：

- `fcm`
- `sharp`
- `asu`
- `snr`
- `dci`
- `dlc`
- `cdc + csc`

对应源码：`de_frontend.c:861-880`

## layer / channel / blender 的关系怎么落到硬件？

### Q13：channel 内部的 layer 是怎么变成硬件寄存器配置的？

答：靠 `channel_apply()` 把 `display_channel_state` 翻译成整条 channel 流水线的配置。

源码证据：

- `channel_apply()`：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.c:654-761`

它做的事情大致分五步：

1. 从 `display_channel_state` 计算 `de_chn_info`
   - 哪些 layer enable
   - 输入像素格式 / 色域 / range
   - premult 状态
   - ovl/scaler 需要的尺寸参数
2. 按需启用 AFBD/TFBD
3. 配置 OVL，把一个 channel 里的多个 layer 叠成 channel 输入
4. 配置 scaler
5. 配置 frontend

最终还会产出 `de_channel_output_info`：

- `is_premul`
- `disp_win`

这两个值随后交给 blender。

### Q14：blender 里的 `port` 和 `pipe` 分别是什么？

答：

- `port` 是“这个 channel 该从 blender 的哪个输入口进来”
- `pipe` 是“这个 channel 当前按哪个 zpos 参与混合”

源码证据：

- `de_bld_get_chn_mux_port()`：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/bld/de_bld.c:198-216`
- `de_bld_pipe_set_attr()`：`de_bld.c:229-255`
- `sunxi_de_channel_update()`：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c:1719-1758`

`sunxi_de_channel_update()` 的逻辑非常直白：

1. 先根据 `hdl->is_video + hdl->type_hw_id` 找到固定 `port_id`
2. 再根据 `plane state` 的 `normalized_zpos` 决定当前 `pipe_id`
3. 如果 zpos 变化，先 reset 老 pipe
4. 再把 `pipe_id -> port_id` 路由起来，并写入显示位置

所以：

```text
channel 身份       -> port_id
plane zpos 顺序    -> pipe_id
```

这是理解 DE 混合路径最关键的一层。

## 硬件版本差异是怎么被抽象掉的？

### Q15：不同 DE 版本、不同 channel 拓扑，驱动是怎么统一抽象的？

答：靠一组“平台描述表 + 统一 create 接口”。

核心入口是 `module_create_info`：

- 定义：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_base.h:187-196`

里面带了：

- `de_version`
- `id`
- `reg_offset`
- `update_mode`
- `de_reg_base`
- `extra`

然后每个子模块都会用 `get_*_dsc()` 按 `de_version + id` 找到自己的平台描述。

典型例子：

- OVL 描述表：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/ovl/de_ovl_platform.c`
- Blender 描述表：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/bld/de_bld_platform.c`
- TOP 描述表：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_top.c:77-129`, `de_top.c:204-304`

这样上层不需要关心“某代 DE 有没有 `uch3`、某个 UI channel 只有 2 layer、某代有没有 share_scaler”，只要统一调用：

- `de_channel_create()`
- `de_blender_create()`
- `de_top_create()`
- `de_backend_create()`

就能拿到当前硬件版本对应的句柄。

### Q16：能不能举一个“版本差异已经被抽象掉”的具体例子？

答：有两个特别典型。

例子 1：channel 的 layer 数量

- v352 的 `uch0~uch3` 都是 4 layer：`de_ovl_platform.c:231-301`
- v355 的 `uch0~uch2` 只有 2 layer：`de_ovl_platform.c:99-145`

但上层 `sunxi_drm_plane_init()` 不需要知道这些细节，它只拿 `info->layer_cnt` 去决定 property 绑定和 feature blob 内容：`sunxi_drm_crtc.c:1336-1357`, `sunxi_drm_crtc.c:1252-1283`

例子 2：TOP 特性

- v355 标了 `share_scaler = 1`：`de_top.c:231-268`
- v352 没有 `share_scaler`，但支持 `pixel_mode`、`ONE_FRAME_DELAY` offline：`de_top.c:270-304`

最终这些特性会被塞进 `sunxi_de_info.feat` 和 CRTC feature blob：`sunxi_de.c:1302-1308`, `sunxi_drm_crtc.c:2324-2365`

## 输出侧 IP 是怎么抽象的？

### Q17：为什么说 backend / fmt / top 是“每个输出通路一份”，而不是“每个 channel 一份”？

答：因为它们都挂在 `sunxi_de_out` 上，不挂在 `de_channel_handle` 上。

源码证据：

- `sunxi_de_out` 里有 `bld_hdl/fmt_hdl/backend_hdl`：`sunxi_de.c:102-130`
- probe 时按 `display_out` 创建它们：`sunxi_de.c:1542-1568`
- enable 时先配置 top/display，再配置 bld output、fmt：`sunxi_de.c:794-868`

这背后的语义是：

- channel 负责“每路输入”
- blender/backend/fmt/top 负责“整路输出”

换句话说：

```text
多个 channel 先汇到一个 bld
再统一经过 backend/fmt/top
最后输出到对应的 tcon/connector
```

### Q18：backend 里都有什么？

答：backend 是输出侧的后处理容器，典型模块包括：

- `crc`
- `gamma`
- `dither`
- `smbl`
- `deband`
- `csc`

源码证据：

- `de_backend_private`：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_backend.c:36-45`
- `de_backend_create()`：`de_backend.c:521-628`

它和 frontend 的区别是：

- frontend 更像“每个 channel 的前处理/PQ”
- backend 更像“整路输出的后处理/PQ”

## 一次 atomic commit 是怎么穿透这些抽象层的？

### Q19：从 DRM atomic 到硬件寄存器，主路径长什么样？

答：主路径可以压缩成下面 6 步：

```text
plane state 改变
  -> sunxi_plane_atomic_update()
  -> sunxi_de_channel_update()
  -> channel_apply()
  -> de_bld_pipe_set_attr()
  -> sunxi_crtc_atomic_flush()
  -> sunxi_de_atomic_flush()
```

源码证据：

- plane update：`bsp/drivers/drm/sunxi_drm_crtc.c:538-569`
- channel update：`sunxi_de.c:1719-1758`
- channel apply：`de_channel.c:654-761`
- crtc flush：`sunxi_drm_crtc.c:2056-2123`
- de flush：`sunxi_de.c:695-792`

这条路径里，上层和下层的职责边界很清楚：

- `sunxi_drm_crtc.c` 负责把 DRM state 组织成 DE 可消费的数据
- `sunxi_de.c` 负责把多个 channel 和 backend/output 串起来
- 各 `de_xxx.c` 负责具体模块寄存器

### Q20：CRTC flush 时为什么还要再带 backend blob？

答：因为 plane 只管 channel 侧，CRTC flush 还要同时处理整路输出的 gamma、CTM、BCSH 和 backend PQ。

源码证据：

- CRTC state 里有 `backend_blob/sunxi_ctm/excfg`：`bsp/drivers/drm/sunxi_drm_crtc.h:36-64`
- CRTC property set/get：`sunxi_drm_crtc.c:1660-1734`
- flush 时把 gamma/ctm/bcsh/backend_data 交给 `sunxi_de_atomic_flush()`：`sunxi_drm_crtc.c:2063-2101`

所以在这套模型里：

- plane state = channel 级别状态
- crtc state = 输出级别状态

## 这些模块最后是怎么统一进 RCQ / 双缓冲更新的？

### Q21：驱动怎么把这么多子模块统一成一次硬件提交？

答：靠统一的 `de_reg_block` 抽象。

源码证据：

- `de_reg_block` 定义：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_base.h:178-185`
- channel handle 自己维护 `block_num/block[]`：`de_channel.h:118-135`
- backend/frontend/bld/top/fmt/wb 也都有自己的 `block_num/block[]`
- `de_rtmx_init_rcq()` 把这些 block 全部拼成一个 RCQ header：`sunxi_de.c:255-375`

也就是说，每个 IP 句柄的统一输出都是：

- 一组 shadow register buffer
- 一组 `de_reg_block`

DE 顶层不关心“这块寄存器属于 OVL 还是 CSC”，只关心把这些 block 拼起来，再触发一次：

- RCQ 更新
- 或者 double buffer ready
- 或者 AHB 写回

这就是这套 lowlevel DE 抽象最关键的工程化手法。

## feature blob 又在整个抽象里扮演什么角色？

### Q22：userspace 怎么知道某个 plane/channel、某个 CRTC/DE 支持哪些能力？

答：靠 `FEATURE` property blob。

源码证据：

- plane feature blob 生成：`sunxi_drm_crtc.c:1252-1283`
- CRTC feature blob 生成：`sunxi_drm_crtc.c:2324-2365`
- blob 对应的公开结构体：`bsp/include/video/sunxi_drm.h:546-612`

plane 的 `FEATURE` 里主要有：

- `de_channel_feature`
  - 支持哪些 frontend 模块
  - `layer_cnt`
  - `hw_id`
- `de_channel_linebuf_feature`
  - scaler line buffer 能力
  - AFBC rotate 能力

CRTC 的 `FEATURE` 里主要有：

- `de_disp_feature`
  - display 侧支持哪些 backend 模块
  - `share_scaler` 等全局特性

这使得 userspace 不必把不同 SoC 的 DE 能力硬编码死。

## 最后用一句话概括

### Q23：如果只记一句话，应该怎么记？

答：在 sunxi DRM 里，`CRTC` 表示一条 `DE 输出通路`，`plane` 表示一个 `channel`，而 `layer` 是这个 channel 内部 OVL 的子层；驱动再通过 `bld/backend/fmt/top + de_reg_block/RCQ` 把这些对象统一编排成一次硬件提交。

## 附：建议的阅读顺序

如果后面你要继续深挖，建议按下面顺序读源码，最容易建立整体感：

1. `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c`
   看 DE 全局对象、display_out、probe/bind、channel 分配、flush
2. `bsp/drivers/drm/sunxi_drm_crtc.c`
   看 DRM CRTC/plane 如何挂接到 `sunxi_de_out` 和 `de_channel_handle`
3. `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.c`
   看一个 channel 内部如何串 OVL/AFBD/TFBD/Scaler/Frontend
4. `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/bld/de_bld_platform.c`
   看不同 `chn_cfg_mode` 下 channel 是怎么分到不同输出的
5. `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/ovl/de_ovl_platform.c`
   看每种硬件 channel 有多少 layer、属于 video 还是 UI
