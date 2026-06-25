# DISP2 与 DRM 显示驱动层 DE-Channel-Layer 管理差异分析

## 1. 文档目标

本文只讨论一条主线：

```text
DE output -> channel -> layer
```

重点回答 4 个问题：

1. `DISP2` 和 `DRM` 分别把 `channel/layer` 抽象成什么软件对象。
2. `DRM` 为什么不是“一个硬件 layer 对应一个 plane”。
3. `DRM` 如何把一个 channel 里的多个 layer 折叠进一个 plane。
4. 上层 ioctl / atomic 到底该怎么用；当前这棵 `linux-6.6` 代码树里实际上又能用到哪一步。

本文刻意删掉了与主线无关的内容，不展开：

- connector / encoder / panel / bridge
- gamma / ctm / backend PQ
- 通用 DRM 框架介绍

## 2. 结论先行

### 2.1 一句话结论

硬件层次没有变，变化的是驱动把谁当成“一等对象”：

- `DISP2`：`layer` 是显式对象，用户也按 `(channel, layer_id)` 直接配置 layer。
- `DRM`：`channel` 先被做成 `plane`，`layer` 不再是独立 DRM object，而是被塞进 `plane` 的私有状态。

更准确地说，在这套 sunxi DRM 实现里：

```text
1 display_out = 1 CRTC
1 channel     = 1 plane
1 plane state = 1 个 channel 内全部 layer 的状态集合
```

### 2.2 当前代码树最关键的限制

这次最重要的新发现不是“内部有没有多 layer 支持”，而是“userspace 是否真的能摸到它”：

- 内核内部已经有 `display_channel_state` 来承载一个 channel 内最多 4 个 layer。
- OVL / channel 层也确实会把这些字段写进硬件 `reg->lay[i]`。
- 但当前 `linux-6.6` 代码树里，`DRM_OBJECT_MAX_PROPERTY` 只有 `24`，而 sunxi 驱动只在 `>= 57` 时才把 `FB_ID1~3`、`SRC_*1~3`、`CRTC_*1~3`、`alpha1~3`、`pixel blend mode1~3` 这些额外 layer property attach 到 plane 上。

所以结论必须分成两层：

1. 从“驱动内部建模”看，`DRM` 已经支持“一个 plane 内打包多个 layer”。
2. 从“当前 userspace 可见 UAPI”看，这棵树里上层大概率只能稳定使用 `layer0`，`layer1~3` 设计存在，但未完整暴露。

## 3. 先统一硬件语义

### 3.1 A733 / de352 平台上，一个 channel 有 4 个 layer

`de352` 的 OVL 描述符直接写出了每个 channel 的 `layer_cnt = 4`：

```c
static struct de_ovl_dsc de352_ovls[] = {
	{ .name = "vch0", .layer_cnt = 4, ... },
	{ .name = "vch1", .layer_cnt = 4, ... },
	{ .name = "vch2", .layer_cnt = 4, ... },
	{ .name = "uch0", .layer_cnt = 4, ... },
	...
};
```

源码位置：

- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/ovl/de_ovl_platform.c:231-295`

`de_channel_create()` 随后把这个能力抄到 channel 句柄上：

```c
hdl->layer_cnt = hdl->private->ovl->layer_cnt;
```

源码位置：

- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.c:1029-1067`

这说明“一个 channel 里有几层”来自底层 OVL 描述，而不是 DRM plane 层拍脑袋定死。

### 3.2 但框架本身并不假定永远是 4 层

同一个 `de_ovl_platform.c` 里，`de355` 的部分 UI channel 就只有 `layer_cnt = 2`：

- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/ovl/de_ovl_platform.c:100-145`

所以后面文档里说“最多 4 层”，是因为当前 A733 / `de352` 平台如此，不是 DRM 框架的永恒前提。

## 4. DISP2：layer 是显式的一等对象

### 4.1 `disp_layer` 是按 `(disp, chn, layer_id)` 真正创建出来的

`disp_init_lyr()` 的初始化方式很直接：遍历每个 `disp`、每个 `channel`、每个 `layer_id`，为每个组合构造一个独立 `disp_layer`。

```c
for (disp = 0; disp < num_screens; disp++) {
	num_channels = bsp_disp_feat_get_num_channels(disp);
	for (chn = 0; chn < num_channels; chn++) {
		num_layers = bsp_disp_feat_get_num_layers_by_chn(disp, chn);
		for (layer_id = 0; layer_id < num_layers; layer_id++, layer_index++) {
			struct disp_layer *lyr = &lyrs[layer_index];
			...
			lyr->disp = disp;
			lyr->chn = chn;
			lyr->id = layer_id;
			...
		}
	}
}
```

源码位置：

- `bsp/drivers/video/sunxi/disp2/disp/de/disp_manager.c:796-907`

### 4.2 `disp_get_layer()` 也是按三元组直接定位

`DISP2` 里查 layer 不是“先找 channel 再找内部槽位”，而是直接用 `(disp, chn, layer_id)` 检索：

```c
if ((lyr->disp == disp) && (lyr->chn == chn) && (lyr->id == layer_id))
	return lyr;
```

源码位置：

- `bsp/drivers/video/sunxi/disp2/disp/de/disp_manager.c:102-129`

这就决定了 `DISP2` 的思维方式天然是：

```text
layer 是对象
channel / layer_id 是 layer 的地址
```

### 4.3 manager 会把所有 layer 纳入自己的管理域

`disp_init_connections()` 会把当前 display 下的所有 layer 连接到对应 manager：

```c
num_layers = bsp_disp_feat_get_num_layers(disp);
for (layer_id = 0; layer_id < num_layers; layer_id++) {
	lyr = disp_get_layer_1(disp, layer_id);
	if (lyr != NULL)
		lyr->set_manager(lyr, mgr);
}
```

源码位置：

- `bsp/drivers/video/sunxi/disp2/disp/de/disp_display.c:496-506`

因此 `DISP2` 的对象关系更像：

```text
disp_manager
  -> disp_layer(channel0, layer0)
  -> disp_layer(channel0, layer1)
  -> disp_layer(channel1, layer0)
  -> ...
```

### 4.4 上层 UAPI 也是直接“提交 layer 配置数组”

`disp_layer_config2` 里直接带 `channel` 和 `layer_id`：

```c
struct disp_layer_config2 {
	struct disp_layer_info2 info;
	bool enable;
	unsigned int channel;
	unsigned int layer_id;
};
```

源码位置：

- `bsp/include/uapi/video/sunxi_display2.h:560-572`

内核侧的私有 ioctl `DISP_LAYER_SET_CONFIG2` 也是直接收这组结构体数组：

- `bsp/drivers/video/sunxi/disp2/disp/dev_disp.c:4724-4772`

### 4.5 DISP2 的提交流程是“按 layer 找对象，再统一 apply”

`disp_mgr_set_layer_config2()` 的关键动作：

1. 用 `disp_get_layer(mgr->disp, config1->channel, config1->layer_id)` 找到目标 layer。
2. 调 `lyr->save_and_dirty_check2(lyr, config1)` 保存配置并标脏。
3. 后续由 `mgr->apply(mgr)` 统一下发。

关键代码：

```c
lyr = disp_get_layer(mgr->disp, config1->channel, config1->layer_id);
if (lyr)
	lyr->save_and_dirty_check2(lyr, config1);
```

源码位置：

- `bsp/drivers/video/sunxi/disp2/disp/de/disp_manager.c:2421-2536`

`disp_mgr_apply()` 会遍历 manager 旗下 layer 的 dirty 状态，并调用：

```c
disp_al_layer_apply(mgr->disp, lyr_cfg, num_layers);
```

源码位置：

- `bsp/drivers/video/sunxi/disp2/disp/de/disp_manager.c:3010-3065`

`disp_al_layer_apply()` 再继续调用：

```c
de_rtmx_layer_apply(disp, data, layer_num);
```

源码位置：

- `bsp/drivers/video/sunxi/disp2/disp/de/lowlevel_v35x/disp_al_de.c:72-118`
- `bsp/drivers/video/sunxi/disp2/disp/de/lowlevel_v35x/de35x/de_rtmx.c:1713-1759`

所以 `DISP2` 的主线可以压缩成：

```text
userspace
  -> DISP_LAYER_SET_CONFIG2
  -> disp_mgr_set_layer_config2()
  -> disp_get_layer(channel, layer_id)
  -> disp_layer.save_and_dirty_check2()
  -> disp_mgr_apply()
  -> disp_al_layer_apply()
  -> de_rtmx_layer_apply()
  -> 硬件 channel/layer
```

## 5. DRM：channel 变成 plane，layer 被折叠进 plane 私有状态

### 5.1 DRM 先创建 channel，再把 channel 挂到 output

`sunxi_de_probe()` 里并没有先创建 layer，而是循环创建 `de_channel_handle`：

```c
for (i = 0; ; i++) {
	cinfo.id = i;
	ch_hdl = de_channel_create(&cinfo);
	if (!ch_hdl)
		break;
	for (j = 0; j < engine->display_out_cnt; j++) {
		display_out = &engine->display_out[j];
		if (de_bld_get_chn_mux_port(...) >= 0) {
			display_out->ch_hdl[display_out->ch_cnt] = ch_hdl;
			display_out->ch_cnt++;
			break;
		}
	}
}
```

源码位置：

- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c:1576-1593`

这里有两个非常关键的事实：

- `channel` 是先于 `plane` 被创建出来的。
- 某个 channel 属于哪个 `display_out`，由 `de_bld_get_chn_mux_port()` 和 `chn_cfg_mode` 决定，不是写死的。

### 5.2 `display_out->ch_cnt` 直接变成 `plane_cnt`

创建 CRTC 时，驱动直接把 `display_out` 下的 channel 数量映射成 plane 数量：

```c
info.plane_cnt = display_out->ch_cnt;
...
info.planes[j].hdl = display_out->ch_hdl[j];
info.planes[j].layer_cnt = display_out->ch_hdl[j]->layer_cnt;
display_out->scrtc = sunxi_drm_crtc_init_one(&info);
```

源码位置：

- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c:1293-1323`

所以在这套实现里：

```text
1 display_out = 1 CRTC
1 channel     = 1 plane
```

而不是：

```text
1 layer = 1 plane
```

### 5.3 `sunxi_drm_plane` 保存的也是 channel 级静态信息

`struct sunxi_drm_plane` 里没有任何“单个 layer 对象”的定义，保存的是 channel 级静态信息：

```c
struct sunxi_drm_plane {
	struct drm_plane plane;
	struct de_channel_handle *hdl;
	unsigned int index;
	unsigned int layer_cnt;
	struct sunxi_drm_crtc *crtc;
};
```

源码位置：

- `bsp/drivers/drm/sunxi_drm_crtc.c:109-115`

随后 `sunxi_drm_plane_init()` 把 `info->hdl` 和 `info->layer_cnt` 填给 plane：

- `bsp/drivers/drm/sunxi_drm_crtc.c:1336-1357`

`sunxi_drm_crtc_init_one()` 再把第一个 channel 做成 primary plane，其余 channel 做成 overlay plane：

- `bsp/drivers/drm/sunxi_drm_crtc.c:2455-2525`

### 5.4 真正承载“多 layer”的，是 `display_channel_state`

`DRM` 里多 layer 不是拆成多个 plane，而是塞进 `display_channel_state`：

```c
struct display_channel_state {
	struct drm_plane_state base;
	bool fake_layer0;
	unsigned int layer_id;
	u16 alpha[MAX_LAYER_NUM_PER_CHN - 1];
	uint16_t pixel_blend_mode[MAX_LAYER_NUM_PER_CHN - 1];
	uint32_t src_x[MAX_LAYER_NUM_PER_CHN - 1], src_y[MAX_LAYER_NUM_PER_CHN - 1];
	uint32_t src_w[MAX_LAYER_NUM_PER_CHN - 1], src_h[MAX_LAYER_NUM_PER_CHN - 1];
	uint32_t crtc_x[MAX_LAYER_NUM_PER_CHN - 1], crtc_y[MAX_LAYER_NUM_PER_CHN - 1];
	uint32_t crtc_w[MAX_LAYER_NUM_PER_CHN - 1], crtc_h[MAX_LAYER_NUM_PER_CHN - 1];
	struct drm_framebuffer *fb[MAX_LAYER_NUM_PER_CHN - 1];
	uint32_t color[MAX_LAYER_NUM_PER_CHN];
	...
};
```

源码位置：

- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.h:20-21`
- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.h:91-114`

字段语义可以直接整理成表：

| 逻辑 layer | 对应状态字段 |
| --- | --- |
| `layer0` | `base.fb`、`base.src_*`、`base.crtc_*`、`base.alpha`、`base.pixel_blend_mode` |
| `layer1` | `fb[0]`、`src_*[0]`、`crtc_*[0]`、`alpha[0]`、`pixel_blend_mode[0]` |
| `layer2` | `fb[1]`、`src_*[1]`、`crtc_*[1]`、`alpha[1]`、`pixel_blend_mode[1]` |
| `layer3` | `fb[2]`、`src_*[2]`、`crtc_*[2]`、`alpha[2]`、`pixel_blend_mode[2]` |

也就是说，sunxi DRM 的真实建模是：

```text
plane state = 一个 channel 内所有 layer 的集合
```

### 5.5 plane property 是怎么把这些 layer 槽位写进 state 的

sunxi 驱动确实专门创建了额外 layer property：

- `layer_id`
- `FB_ID1~3`
- `SRC_X1~3` / `SRC_Y1~3` / `SRC_W1~3` / `SRC_H1~3`
- `CRTC_X1~3` / `CRTC_Y1~3` / `CRTC_W1~3` / `CRTC_H1~3`
- `alpha1~3`
- `pixel blend mode1~3`
- `COLOR` / `COLOR1` / `COLOR2` / `COLOR3`

源码位置：

- `bsp/drivers/drm/sunxi_drm_crtc.c:1142-1250`

而 `sunxi_atomic_plane_set_property()` 会把这些 property 写回 `display_channel_state`：

```c
if (property == private->prop_fb_id[i]) {
	struct drm_framebuffer *fb = drm_framebuffer_lookup(dev, NULL, val);
	...
	drm_framebuffer_assign(&cstate->fb[i], fb);
	return 0;
}

if (property == private->prop_src_x[i]) {
	cstate->src_x[i] = val;
	return 0;
}

if (property == private->prop_layer_id) {
	cstate->layer_id = val;
	return 0;
}
```

源码位置：

- `bsp/drivers/drm/sunxi_drm_crtc.c:726-852`

这一步已经能证明：驱动设计意图非常明确，就是要让 userspace 通过一个 plane 的扩展 property 去描述 channel 内额外 layer。

### 5.6 `layer0` 在 DRM 里不仅是“第 0 层”，还是 channel 的锚点

这一点非常关键。

`channel_apply()` 一上来就先看 `state->base.fb`：

```c
if (state->base.fb == NULL) {
	...
	de_ovl_apply_lay(hdl->private->ovl, state, &ovl_cfg);
	...
	return 0;
}
hdl->private->info.enable = true;
```

源码位置：

- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.c:654-684`

这表示：

- 对 sunxi DRM 来说，`channel` 是否“开启”，首先由 `base.fb` 决定。
- `base.fb` 对应的正是 `layer0`。

所以 `layer0` 并不只是数组意义上的第 0 项，它还是整条 channel 的 enable anchor。

### 5.7 `fake_layer0` 是为了在只改 `layer1~3` 时维持 channel 存活

因为 `channel_apply()` 会把 `base.fb == NULL` 视为“关闭整个 channel”，驱动只能引入 `fake_layer0` 来处理“只更新 layer1~3”的场景。

`sunxi_plane_atomic_precheck()` 的核心逻辑是：

1. 如果 `layer_id != COMMIT_ALL_LAYER`，就把这次提交当成 async update。
2. 如果只更新 `layer1~3`，但 `new_state->fb` 为空，就临时给 plane 塞一个 fake 的 layer0 anchor。

关键代码：

```c
if (cstate->layer_id != COMMIT_ALL_LAYER)
	new_state->state->legacy_cursor_update = true;

if (!cstate->fake_layer0 && !new_state->fb) {
	drm_atomic_set_fb_for_plane(new_state, fb);
	ret = drm_atomic_set_crtc_for_plane(new_state, &scrtc->crtc);
	...
	cstate->fake_layer0 = true;
}
```

源码位置：

- `bsp/drivers/drm/sunxi_drm_crtc.c:571-664`

而在真正写 OVL 寄存器时，如果 `i == 0 && state->fake_layer0`，驱动又会把 layer0 控制位写成关闭：

```c
if (i == 0 && state->fake_layer0)
	dwval = 0;
else
	dwval = 0x1;
```

源码位置：

- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/ovl/de_ovl.c:484-488`
- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/ovl/de_ovl.c:653-657`

也就是说，`fake_layer0` 的真实含义是：

```text
让 plane/CRTC 关系继续成立，
但不真的把 layer0 作为一个可见硬件层打开
```

### 5.8 atomic commit 到硬件的完整路径

这一段如果不串起来，`display_channel_state` 很容易看成只是“概念数组”；但源码说明它最终会直接落到硬件 layer 寄存器。

#### 第一步：plane update 进入 DE channel 更新

`sunxi_plane_atomic_update()` 把当前 plane 对应的 channel 句柄和新旧 `display_channel_state` 打包进 `sunxi_de_channel_update`：

```c
info.hdl = sunxi_plane->hdl;
info.hwde = scrtc->sunxi_de;
info.new_state = new_cstate;
info.old_state = old_cstate;
sunxi_de_channel_update(&info);
```

源码位置：

- `bsp/drivers/drm/sunxi_drm_crtc.c:532-558`

#### 第二步：DE 层按 channel 处理

`sunxi_de_channel_update()` 内部继续调用 `channel_apply()`：

```c
if (new_state->base.fb == NULL) {
	channel_apply(hdl, new_state, output_info, &channel_out, ...);
	...
	return 0;
}

channel_apply(hdl, new_state, output_info, &channel_out, ...);
```

源码位置：

- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c:1719-1758`

#### 第三步：channel 层把 `base.fb + fb[]` 当成同一个 channel 的多 layer 计算

`cal_channel_enable_layer_cnt()` 明确按 `i = 0..hdl->layer_cnt-1` 遍历：

```c
for (i = 0; i < hdl->layer_cnt; i++) {
	fb = i == 0 ? state->base.fb : state->fb[i - 1];
	if (fb) {
		hdl->private->info.layer_en_cnt++;
		hdl->private->info.layer_en[i] = true;
	}
}
```

源码位置：

- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.c:205-218`

随后 `channel_apply()` 再把这些计算结果传给 OVL：

```c
de_ovl_apply_lay(hdl->private->ovl, state, &ovl_cfg);
```

源码位置：

- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.c:693-724`

#### 第四步：OVL 最终写到 `reg->lay[i]`

无论 VI channel 还是 UI channel，OVL 都是按 layer 循环：

```c
for (i = 0; i < priv->dsc->layer_cnt; ++i) {
	if (i == 0) {
		fb = state->base.fb;
		...
	} else {
		fb = state->fb[i - 1];
		...
	}
	...
	reg->lay[i].ctl.dwval = dwval;
	...
}
```

源码位置：

- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/ovl/de_ovl.c:440-527`
- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/ovl/de_ovl.c:608-695`

因此，`display_channel_state` 里的额外数组字段并不是“给上层看的装饰”，而是硬件 `layer1~3` 的直接软件映射。

## 6. 从 userspace 角度看：DISP2 和 DRM 分别该怎么用

### 6.1 DISP2：直接按 `(channel, layer_id)` 提交

`DISP2` 的使用方式最直接：

1. 准备 `disp_layer_config2` 数组。
2. 每项显式填写 `channel`、`layer_id`、`enable` 以及 layer 内容。
3. 通过 `DISP_LAYER_SET_CONFIG2` 一次提交。

这和 `DISP2` 内核侧“layer 是显式对象”的建模完全一致。

### 6.2 DRM：设计意图是“一个 plane 表示一个 channel，额外 layer 用私有 property 表达”

如果只从驱动设计意图出发，userspace 的理想用法应该是：

1. 先找到目标 plane。
2. `layer0` 用标准 plane 属性：
   `FB_ID`、`CRTC_ID`、`SRC_X/Y/W/H`、`CRTC_X/Y/W/H`、`alpha`、`pixel blend mode`。
3. `layer1~3` 用 sunxi 私有属性：
   `FB_ID1~3`、`SRC_*1~3`、`CRTC_*1~3`、`alpha1~3`、`pixel blend mode1~3`。
4. 通过 `DRM_IOCTL_MODE_ATOMIC` 或 `drmModeAtomicCommit()` 一次性提交。

可以把它想成下面这种伪代码：

```c
drmModeAtomicAddProperty(req, plane_id, FB_ID, fb0);      // layer0
drmModeAtomicAddProperty(req, plane_id, CRTC_ID, crtc_id);
drmModeAtomicAddProperty(req, plane_id, SRC_X, ...);
drmModeAtomicAddProperty(req, plane_id, CRTC_X, ...);

drmModeAtomicAddProperty(req, plane_id, FB_ID1, fb1);     // layer1
drmModeAtomicAddProperty(req, plane_id, SRC_X1, ...);
drmModeAtomicAddProperty(req, plane_id, CRTC_X1, ...);
drmModeAtomicAddProperty(req, plane_id, alpha1, ...);

drmModeAtomicCommit(fd, req, flags, NULL);
```

这里有一个补充点：驱动还通过 `FEATURE` blob 把 `layer_cnt` 等能力导出给 plane。

源码位置：

- `bsp/drivers/drm/sunxi_drm_drv.c:481-565`
- `bsp/drivers/drm/sunxi_drm_crtc.c:1252-1281`

### 6.3 `layer_id` 的真实语义不是“这个 plane 属于哪层”

`layer_id` 在这套实现里更接近“这次只想更新哪个子 layer”的 commit selector。

默认值来自：

```c
#define COMMIT_ALL_LAYER (0xff)
...
state->layer_id = COMMIT_ALL_LAYER;
```

源码位置：

- `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.h:20-21`
- `bsp/drivers/drm/sunxi_drm_crtc.c:1015-1045`

当 `layer_id != COMMIT_ALL_LAYER` 时，驱动会走 async update 的特殊路径：

- `bsp/drivers/drm/sunxi_drm_crtc.c:571-724`

所以它不是“声明 plane 身份”的 property，而是“声明本次提交只想局部更新某个子 layer”的 property。

### 6.4 只用 legacy `drmModeSetPlane()` 或标准 plane 基本属性，实际上只能碰到 `layer0`

原因很简单：

- 标准 KMS plane 只天然覆盖 `layer0` 对应的 `base` 字段。
- `layer1~3` 全部依赖 sunxi 私有扩展 property。

因此，如果 userspace 只走：

- `drmModeSetPlane()`
- 或 atomic 里只设置标准 `FB_ID` / `CRTC_*` / `SRC_*`

那么它本质上只能配置 `display_channel_state.base`，也就是 `layer0`。

## 7. 当前 `linux-6.6` 代码树里的真实可用性

### 7.1 property 对象创建了，不等于 property 已经挂到 plane 上

`sunxi_drm_property_create()` 确实会先创建这些 property 对象，最后还会调用：

```c
return sunxi_drm_plane_property_create(private);
```

源码位置：

- `bsp/drivers/drm/sunxi_drm_drv.c:481-565`

但真正决定 userspace 能不能看到这些 property 的，是 `sunxi_drm_plane_property_init()` 里的 attach 阶段。

### 7.2 attach 条件直接卡死在 `DRM_OBJECT_MAX_PROPERTY`

驱动代码里写得很明确：

```c
#if DRM_OBJECT_MAX_PROPERTY >= 57
	for (i = 0; i < plane->layer_cnt - 1 && plane->layer_cnt > 1; i++) {
		drm_object_attach_property(... prop_blend_mode[i] ...);
		drm_object_attach_property(... prop_alpha[i] ...);
		drm_object_attach_property(... prop_src_x[i] ...);
		...
		drm_object_attach_property(... prop_fb_id[i] ...);
	}
#endif

#if DRM_OBJECT_MAX_PROPERTY > 24
	drm_object_attach_property(&plane->plane.base, pri->prop_layer_id, COMMIT_ALL_LAYER);
#endif
```

源码位置：

- `bsp/drivers/drm/sunxi_drm_crtc.c:1284-1333`

而当前内核头文件里：

```c
#define DRM_OBJECT_MAX_PROPERTY 24
```

源码位置：

- `kernel/linux-6.6/include/drm/drm_mode_object.h:63`

这直接推出两个结果：

1. `FB_ID1~3`、`SRC_*1~3`、`CRTC_*1~3`、`alpha1~3`、`pixel blend mode1~3` 这批 property 在当前树里不会 attach 到 plane。
2. 连 `layer_id` 也不会 attach，因为条件是 `> 24`，而当前正好等于 `24`。

### 7.3 这就是“内部支持”和“UAPI 可达”之间的断层

所以当前代码树必须这样理解：

- `display_channel_state` 已经能在内核里容纳 4 层。
- `channel_apply()` / `de_ovl_apply_lay()` 也已经能按 4 层去写硬件。
- 但 userspace 未必拿得到驱动原本设想的那批扩展 property。

换句话说：

```text
kernel internal: 支持一个 channel 内多 layer
userspace UAPI : 当前大概率只能稳定触达 layer0
```

### 7.4 `layer_id` 还有一个源码层面的不一致点

`layer_id` property 创建时的合法范围是：

```c
drm_property_create_range(dev, 0, "layer_id", 0, MAX_LAYER_NUM_PER_CHN);
```

也就是 `0..4`。

源码位置：

- `bsp/drivers/drm/sunxi_drm_crtc.c:1149-1153`

但内部默认值却是：

```c
state->layer_id = COMMIT_ALL_LAYER;   // 0xff
```

源码位置：

- `bsp/drivers/drm/sunxi_drm_crtc.c:1043-1044`

这说明即便将来补齐 property attach，这里仍然存在一个语义不对齐的问题：

- 内部“全量提交”用 `0xff`
- property 可接受范围却是 `0..4`

所以如果将来 userspace 真能看到 `layer_id`，更合理的使用方式也应该是：

- 不设置 `layer_id`，保持默认“全量提交”
- 只在想做局部 layer async update 时，才显式设置 `0/1/2/3`

## 8. 最终结论

### 8.1 对象模型差异

- `DISP2`：`layer` 是独立对象，`channel + layer_id` 是 layer 地址。
- `DRM`：`channel` 是独立对象，先变成 `plane`；`layer` 被折叠进 `plane state`。

### 8.2 DRM 里的真实映射关系

```text
CRTC = display_out
plane = channel
plane state = channel 内所有 layer
```

其中：

- `layer0` 走 `drm_plane_state base`
- `layer1~3` 走 `display_channel_state` 的数组字段

### 8.3 为什么你会感觉 DRM “看起来只有 plane，没有 layer”

因为 DRM 并没有把每个硬件 layer 做成单独的 `drm_plane`。

它做的是另一件事：

```text
把一个硬件 channel 做成一个 plane，
再把这个 channel 里的多个硬件 layer 塞进 plane 的私有状态
```

### 8.4 当前这棵树对上层的实际影响

- 从源码设计上看，sunxi DRM 试图让 userspace 通过扩展 plane property 使用 `layer1~3`。
- 从当前 `linux-6.6` 的实际 attach 条件看，这批 property 并没有完整暴露。
- 因此当前树里，userspace 能稳定依赖的仍主要是 `layer0`。

如果后续要真正把 `layer1~3` 作为用户可用能力打通，至少还需要补齐两件事：

1. 解决 `DRM_OBJECT_MAX_PROPERTY` 与 plane property attach 条件不匹配的问题。
2. 明确 `layer_id` 的 UAPI 语义和默认值，避免 `0..4` 与 `0xff` 的不一致。
