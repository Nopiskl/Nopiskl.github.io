# Sunxi DRM 主线与 BSP 架构分析

本文整理当前 SDK 中两套 Allwinner DRM 实现的关键差异：

- SOC 厂商私有实现：`bsp/drivers/drm`
- 主线早期 sun4i/sun8i 实现：`kernel/linux-6.6/drivers/gpu/drm/sun4i`

重点回答三个问题：

- 主线 `sun8i_ui_layer_atomic_update()` 是否覆盖了 Allwinner “一个 channel 内 4 个 layer”的硬件模型。
- BSP 为什么通过 encoder `atomic_check()` 填充 CRTC 回调，这种设计如何解耦 encoder 和 CRTC。
- 主线是如何通过 DTS graph、`possible_crtcs`、`best_encoder`、`encoder->crtc` 完成 encoder 与 CRTC 的连接和解耦。

## 结论摘要

1. 主线 Linux 6.6 的 sun8i mixer 代码并不是完全不知道硬件中的 `overlay/layer` 概念，因为 `sun8i_ui_layer` 和 `sun8i_vi_layer` 都有 `channel` 与 `overlay` 字段，寄存器宏也支持 `overlay` 参数。

2. 但是主线 6.6 实际注册 DRM plane 时，每个 VI/UI channel 只注册一个 plane，并且 `layer->overlay = 0`。也就是说，主线当前暴露的是：

```text
一个 DRM plane 约等于一个 DE channel 的 overlay0
```

而不是：

```text
一个 DE channel 内的 overlay0/1/2/3 都成为 DRM 可见 layer
```

3. BSP 的模型则是：

```text
一个 DRM plane 约等于一个 DE channel
一个 plane_state 内部额外携带 layer1/layer2/layer3 的 framebuffer、坐标、alpha、blend mode 等私有状态
```

4. BSP 通过 encoder `atomic_check()` 填充 `sunxi_crtc_state` 中的函数指针和输出格式信息。这是一种“输出设备服务注入”设计：CRTC 不直接知道后面接的是 HDMI/DSI/LVDS/RGB/eDP，只调用 encoder 填进来的回调。

5. 主线没有采用这种私有回调表。主线主要依赖标准 DRM 对象关系：

```text
DTS graph -> encoder->possible_crtcs -> connector best_encoder -> encoder->crtc -> CRTC mode_set_nofb 找到当前 encoder -> TCON 根据 encoder_type 配置输出
```

6. 主线的解耦边界更符合 DRM/KMS 标准对象模型，但对 Allwinner 后期 DE 的复杂 channel/layer、输出色彩格式、pixel mode、输出设备回调等厂商特性，BSP 的实现更直接，也更私有。

## 1. 主线 sun8i layer 模型

### 1.1 主线代码中存在 channel 和 overlay 字段

主线 `sun8i_ui_layer` 结构体中确实有 `channel` 和 `overlay`：

```c
/* kernel/linux-6.6/drivers/gpu/drm/sun4i/sun8i_ui_layer.h */
struct sun8i_ui_layer {
	struct drm_plane	plane;
	struct sun8i_mixer	*mixer;
	int			channel;
	int			overlay;
};
```

VI layer 也是同类结构：

```c
/* kernel/linux-6.6/drivers/gpu/drm/sun4i/sun8i_vi_layer.h */
struct sun8i_vi_layer {
	struct drm_plane	plane;
	struct sun8i_mixer	*mixer;
	int			channel;
	int			overlay;
};
```

寄存器宏也支持传入 `layer/overlay` 参数：

```c
/* kernel/linux-6.6/drivers/gpu/drm/sun4i/sun8i_ui_layer.h */
#define SUN8I_MIXER_CHAN_UI_LAYER_ATTR(base, layer) \
			((base) + 0x20 * (layer) + 0x0)
#define SUN8I_MIXER_CHAN_UI_LAYER_SIZE(base, layer) \
			((base) + 0x20 * (layer) + 0x4)
#define SUN8I_MIXER_CHAN_UI_LAYER_COORD(base, layer) \
			((base) + 0x20 * (layer) + 0x8)
#define SUN8I_MIXER_CHAN_UI_LAYER_PITCH(base, layer) \
			((base) + 0x20 * (layer) + 0xc)
#define SUN8I_MIXER_CHAN_UI_LAYER_TOP_LADDR(base, layer) \
			((base) + 0x20 * (layer) + 0x10)
```

因此不能说主线代码结构上完全没有 overlay 概念。它有这个字段，也把 overlay 传入寄存器访问函数。

### 1.2 但是主线实际只初始化 overlay0

UI layer 初始化时，`overlay` 被固定为 0：

```c
/* kernel/linux-6.6/drivers/gpu/drm/sun4i/sun8i_ui_layer.c */
struct sun8i_ui_layer *sun8i_ui_layer_init_one(struct drm_device *drm,
					       struct sun8i_mixer *mixer,
					       int index)
{
	enum drm_plane_type type = DRM_PLANE_TYPE_OVERLAY;
	int channel = mixer->cfg->vi_num + index;
	struct sun8i_ui_layer *layer;
	unsigned int plane_cnt;
	int ret;

	...

	drm_plane_helper_add(&layer->plane, &sun8i_ui_layer_helper_funcs);
	layer->mixer = mixer;
	layer->channel = channel;
	layer->overlay = 0;

	return layer;
}
```

VI layer 初始化也同样固定为 0：

```c
/* kernel/linux-6.6/drivers/gpu/drm/sun4i/sun8i_vi_layer.c */
struct sun8i_vi_layer *sun8i_vi_layer_init_one(struct drm_device *drm,
					       struct sun8i_mixer *mixer,
					       int index)
{
	...

	drm_plane_helper_add(&layer->plane, &sun8i_vi_layer_helper_funcs);
	layer->mixer = mixer;
	layer->channel = index;
	layer->overlay = 0;

	return layer;
}
```

这说明主线 6.6 的实际资源暴露是“每个 channel 只使用 overlay0”。

### 1.3 主线创建 plane 数量是 vi_num + ui_num

主线 mixer 初始化 plane 时，只按 VI channel 数加 UI channel 数创建 plane：

```c
/* kernel/linux-6.6/drivers/gpu/drm/sun4i/sun8i_mixer.c */
static struct drm_plane **sun8i_layers_init(struct drm_device *drm,
					    struct sunxi_engine *engine)
{
	struct drm_plane **planes;
	struct sun8i_mixer *mixer = engine_to_sun8i_mixer(engine);
	int i;

	planes = devm_kcalloc(drm->dev,
			      mixer->cfg->vi_num + mixer->cfg->ui_num + 1,
			      sizeof(*planes), GFP_KERNEL);
	if (!planes)
		return ERR_PTR(-ENOMEM);

	for (i = 0; i < mixer->cfg->vi_num; i++) {
		struct sun8i_vi_layer *layer;

		layer = sun8i_vi_layer_init_one(drm, mixer, i);
		...
		planes[i] = &layer->plane;
	}

	for (i = 0; i < mixer->cfg->ui_num; i++) {
		struct sun8i_ui_layer *layer;

		layer = sun8i_ui_layer_init_one(drm, mixer, i);
		...
		planes[mixer->cfg->vi_num + i] = &layer->plane;
	}

	return planes;
}
```

这里没有类似：

```c
for_each_channel(...)
	for_each_overlay(...)
		create_plane(channel, overlay);
```

所以主线没有把一个 channel 内的 4 个 overlay/layer 全部暴露为 DRM plane。

### 1.4 atomic_update 只更新当前 plane 对应的 channel/overlay

`sun8i_ui_layer_atomic_update()` 一次只处理当前 plane 的 state：

```c
/* kernel/linux-6.6/drivers/gpu/drm/sun4i/sun8i_ui_layer.c */
static void sun8i_ui_layer_atomic_update(struct drm_plane *plane,
					 struct drm_atomic_state *state)
{
	struct drm_plane_state *old_state = drm_atomic_get_old_plane_state(state,
									   plane);
	struct drm_plane_state *new_state = drm_atomic_get_new_plane_state(state,
									   plane);
	struct sun8i_ui_layer *layer = plane_to_sun8i_ui_layer(plane);
	unsigned int zpos = new_state->normalized_zpos;
	unsigned int old_zpos = old_state->normalized_zpos;
	struct sun8i_mixer *mixer = layer->mixer;

	if (!new_state->visible) {
		sun8i_ui_layer_enable(mixer, layer->channel,
				      layer->overlay, false, 0, old_zpos);
		return;
	}

	sun8i_ui_layer_update_coord(mixer, layer->channel,
				    layer->overlay, plane, zpos);
	sun8i_ui_layer_update_alpha(mixer, layer->channel,
				    layer->overlay, plane);
	sun8i_ui_layer_update_formats(mixer, layer->channel,
				      layer->overlay, plane);
	sun8i_ui_layer_update_buffer(mixer, layer->channel,
				     layer->overlay, plane);
	sun8i_ui_layer_enable(mixer, layer->channel, layer->overlay,
			      true, zpos, old_zpos);
}
```

这本身符合 DRM plane 模型。真正的问题不是“atomic_update 一次只处理一个 plane state”，而是主线只创建了 `overlay0` 对应的 plane。

### 1.5 主线 blender route 是按 channel 路由

主线启用 layer 时，写 blender route 用的是 channel，而不是 overlay：

```c
/* kernel/linux-6.6/drivers/gpu/drm/sun4i/sun8i_ui_layer.c */
if (enable) {
	val = SUN8I_MIXER_BLEND_PIPE_CTL_EN(zpos);

	regmap_update_bits(mixer->engine.regs,
			   SUN8I_MIXER_BLEND_PIPE_CTL(bld_base),
			   val, val);

	val = channel << SUN8I_MIXER_BLEND_ROUTE_PIPE_SHIFT(zpos);

	regmap_update_bits(mixer->engine.regs,
			   SUN8I_MIXER_BLEND_ROUTE(bld_base),
			   SUN8I_MIXER_BLEND_ROUTE_PIPE_MSK(zpos),
			   val);
}
```

这点很重要。硬件 global blender 看到的是 channel 输出，不是 channel 内部 overlay0/1/2/3 分别作为独立 pipe 输出。

这也是为什么“把 overlay1/2/3 直接注册成标准 DRM plane”不是简单循环创建 plane 就完事。DRM 用户空间会认为这些 plane 可以和其他 channel 的 plane 任意 zpos 交错，但硬件实际更像：

```text
channel 内 overlay0/1/2/3 先在 OVL 内部合成
整个 channel 的合成结果再作为一个 blender pipe 参与全局混合
```

主线如果完整表达这个硬件模型，需要额外约束或重新设计 plane 暴露方式。

## 2. BSP 的 channel -> 4 layer 模型

### 2.1 BSP 的 display_channel_state 扩展了 drm_plane_state

BSP 定义每个 channel 最多 4 个 layer：

```c
/* bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.h */
#define MAX_LAYER_NUM_PER_CHN		(4)
#define COMMIT_ALL_LAYER		(0xff)
```

`display_channel_state` 继承 `drm_plane_state`，并额外保存 layer1/2/3 的 framebuffer、坐标、alpha、blend mode 等：

```c
/* bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.h */
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
	struct drm_property_blob *frontend_blob;
	enum de_eotf eotf;
	enum de_color_space color_space;
	enum de_color_range color_range;
	uint32_t compressed_image_crop;
};

#define to_display_channel_state(x) \
	container_of(x, struct display_channel_state, base)
```

含义是：

- `base.fb/base.src/base.crtc` 表示 layer0。
- `fb[0]`、`src_x[0]`、`crtc_x[0]` 等表示 layer1。
- `fb[1]` 表示 layer2。
- `fb[2]` 表示 layer3。

### 2.2 BSP 对用户空间暴露额外私有属性

BSP 为 layer1/2/3 创建 `FB_IDn`、`SRC_Xn`、`CRTC_Xn`、`alphaN` 等私有 property：

```c
/* bsp/drivers/drm/sunxi_drm_crtc.c */
int sunxi_drm_plane_property_create(struct sunxi_drm_private *private)
{
	struct drm_device *dev = &private->base;
	struct drm_property *prop;
	char name[32];
	int i;

	prop = drm_property_create_range(dev, 0, "layer_id",
					 0, MAX_LAYER_NUM_PER_CHN);
	if (!prop)
		return -ENOMEM;
	private->prop_layer_id = prop;

	for (i = 0; i < OVL_REMAIN; i++) {
		...

		sprintf(name, "SRC_X%d", i + 1);
		prop = drm_property_create_signed_range(dev, DRM_MODE_PROP_ATOMIC,
				name, INT_MIN, INT_MAX);
		private->prop_src_x[i] = prop;

		...

		sprintf(name, "FB_ID%d", i + 1);
		prop = drm_property_create_object(dev, DRM_MODE_PROP_ATOMIC,
				name, DRM_MODE_OBJECT_FB);
		private->prop_fb_id[i] = prop;
	}

	return 0;
}
```

属性写入时，BSP 把这些 property 写入 `display_channel_state`：

```c
/* bsp/drivers/drm/sunxi_drm_crtc.c */
if (property == private->prop_src_x[i]) {
	cstate->src_x[i] = val;
	return 0;
}

...

if (property == private->prop_fb_id[i]) {
	struct drm_framebuffer *fb = drm_framebuffer_lookup(dev, NULL, val);
	if (fb) {
		drm_framebuffer_assign(&cstate->fb[i], fb);
		drm_framebuffer_put(fb);
		return 0;
	} else {
		drm_framebuffer_assign(&cstate->fb[i], NULL);
		return 0;
	}
}

...

if (property == private->prop_layer_id) {
	cstate->layer_id = val;
	return 0;
}
```

这就是 BSP 能在一个 DRM plane 上携带多个 layer 状态的原因。

### 2.3 BSP plane atomic_update 以 channel 为单位下发

BSP 的 plane atomic update 把当前 plane state 转成 `display_channel_state`，然后调用底层 DE channel update：

```c
/* bsp/drivers/drm/sunxi_drm_crtc.c */
static void sunxi_plane_atomic_update(struct drm_plane *plane,
				      struct drm_atomic_state *state)
{
	struct drm_plane_state *old_state =
		drm_atomic_get_old_plane_state(state, plane);
	struct display_channel_state *old_cstate =
		to_display_channel_state(old_state);
	struct drm_plane_state *new_state = plane->state;
	struct display_channel_state *new_cstate =
		to_display_channel_state(new_state);
	struct sunxi_drm_plane *sunxi_plane = to_sunxi_plane(plane);
	struct sunxi_drm_crtc *scrtc = sunxi_plane->crtc;
	struct sunxi_de_channel_update info;

	info.hdl = sunxi_plane->hdl;
	info.hwde = scrtc->sunxi_de;
	info.new_state = new_cstate;
	info.old_state = old_cstate;
	info.is_fbdev = false;
	info.fbdev_output = scrtc->fbdev_output;
	sunxi_de_channel_update(&info);
}
```

`sunxi_de_channel_update()` 再调用 `channel_apply()`：

```c
/* bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c */
int sunxi_de_channel_update(struct sunxi_de_channel_update *info)
{
	struct sunxi_de_out *hwde = info->hwde;
	struct de_channel_handle *hdl = info->hdl;
	struct display_channel_state *new_state = info->new_state;
	struct display_channel_state *old_state = info->old_state;
	struct sunxi_display_engine *engine = dev_get_drvdata(hwde->dev);
	unsigned int old_zorder = old_state->base.normalized_zpos;
	unsigned int new_zorder = new_state->base.normalized_zpos;
	struct de_channel_output_info channel_out;
	struct de_output_info *output_info = &hwde->output_info;
	unsigned int port_id;

	...

	if (new_state->base.fb == NULL) {
		channel_apply(hdl, new_state, output_info, &channel_out,
			      engine->match_data->blending_in_rgb);
		...
		return 0;
	}

	channel_apply(hdl, new_state, output_info, &channel_out,
		      engine->match_data->blending_in_rgb);

	if (old_zorder != new_zorder)
		de_bld_pipe_reset(hwde->bld_hdl, old_zorder, port_id);

	de_bld_pipe_set_attr(hwde->bld_hdl, new_zorder, port_id,
			     &channel_out.disp_win, channel_out.is_premul);
	return 0;
}
```

### 2.4 channel_apply 遍历一个 channel 内的多个 layer

BSP 通过 `hdl->layer_cnt` 遍历 channel 内 layer：

```c
/* bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.c */
static void cal_channel_enable_layer_cnt(struct de_channel_handle *hdl,
					 struct display_channel_state *state)
{
	int i;
	struct drm_framebuffer *fb;

	hdl->private->info.layer_en_cnt = 0;
	memset(hdl->private->info.layer_en, 0,
	       sizeof(hdl->private->info.layer_en));

	for (i = 0; i < hdl->layer_cnt; i++) {
		fb = i == 0 ? state->base.fb : state->fb[i - 1];
		if (fb) {
			hdl->private->info.layer_en_cnt++;
			hdl->private->info.layer_en[i] = true;
		}
	}
}
```

`channel_apply()` 先计算 channel 内所有 layer 的合成窗口、格式、premul、scaler、frontend，再下发 OVL、scaler、frontend：

```c
/* bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.c */
int channel_apply(struct de_channel_handle *hdl,
		  struct display_channel_state *state,
		  const struct de_output_info *de_info,
		  struct de_channel_output_info *output,
		  bool rgb_out)
{
	bool afbd_en = false, tfbd_en = false;
	struct de_ovl_cfg ovl_cfg;
	struct de_afbd_cfg afbd_cfg;
	struct de_tfbd_cfg tfbd_cfg;
	struct de_scaler_apply_cfg scaler_cfg;
	struct de_frontend_apply_cfg frontend_cfg;

	...

	/* cal chn info */
	cal_channel_enable_layer_cnt(hdl, state);
	de_rtmx_chn_data_attr(&hdl->private->info, state);
	de_rtmx_chn_blend_attr(&hdl->private->info, state, hdl->layer_cnt);
	de_rtmx_chn_calc_size(hdl, &hdl->private->info, state, hdl->layer_cnt);
	de_rtmx_chn_fix_size(hdl->private->scaler, &hdl->private->info,
			     de_info->width, de_info->height,
			     de_info->max_device_fps, de_info->de_clk_freq,
			     de_info->htotal, de_info->pclk_khz);

	...

	ovl_cfg.layer_en_cnt = (afbd_en | tfbd_en) ? 0 :
			       hdl->private->info.layer_en_cnt;

	if (!afbd_en && !tfbd_en)
		memcpy(ovl_cfg.layer_en, &hdl->private->info.layer_en,
		       sizeof(ovl_cfg.layer_en));
	memcpy(ovl_cfg.lay_premul, &hdl->private->info.lay_premul,
	       sizeof(ovl_cfg.lay_premul));
	memcpy(ovl_cfg.lay_win, &hdl->private->info.lay_win,
	       sizeof(ovl_cfg.lay_win));
	memcpy(&ovl_cfg.ovl_win, &hdl->private->info.ovl_win,
	       sizeof(ovl_cfg.ovl_win));
	memcpy(&ovl_cfg.ovl_out_win, &hdl->private->info.ovl_out_win,
	       sizeof(ovl_cfg.ovl_out_win));
	de_ovl_apply_lay(hdl->private->ovl, state, &ovl_cfg);

	scaler_cfg.scale_en = hdl->private->info.scale_en;
	scaler_cfg.glb_alpha = hdl->private->info.glb_alpha;
	scaler_cfg.px_fmt_space = hdl->private->info.px_fmt_space;
	scaler_cfg.yuv_sampling = hdl->private->info.yuv_sampling;
	scaler_cfg.px_fmt = hdl->private->info.px_fmt;
	...
	de_scaler_apply(hdl->private->scaler, &scaler_cfg);

	...
	de_frontend_apply(hdl->private->frontend, state, &frontend_cfg);

	output->is_premul =
		(hdl->private->info.alpha_mode & DE_ALPHA_MODE_PREMUL) ? 1 : 0;
	drm_rect_init(&output->disp_win,
		      hdl->private->info.scn_win.left,
		      hdl->private->info.scn_win.top,
		      hdl->private->info.scn_win.width,
		      hdl->private->info.scn_win.height);
	return 0;
}
```

BSP 这里的模型更贴近后期 DE 硬件：

```text
DE channel:
  OVL 内部 layer0/1/2/3
  AFBC/TFBC
  scaler
  frontend
  输出为一个 channel result

global blender:
  以 channel 为输入 pipe 做最终混合
```

## 3. BSP encoder atomic_check 填 CRTC 回调

### 3.1 CRTC state 中保存输出设备回调

BSP 在 `sunxi_crtc_state` 中保存了输出设备相关回调和输出色彩配置：

```c
/* bsp/drivers/drm/sunxi_drm_crtc.h */
typedef void (*vblank_enable_callback_t)(bool, void *);
typedef bool (*fifo_status_check_callback_t)(void *);
typedef bool (*is_sync_time_enough_callback_t)(void *);
typedef int (*get_cur_line_callback_t)(void *);
typedef void (*connector_atomic_flush)(void *);
typedef bool (*is_support_backlight_callback_t)(void *);
typedef void (*set_backlight_value_callback_t)(void *, int);
typedef int (*get_backlight_value_callback_t)(void *);

struct sunxi_crtc_state {
	struct drm_crtc_state base;
	enum de_format_space px_fmt_space;
	enum de_yuv_sampling yuv_sampling;
	enum de_eotf eotf;
	enum de_color_space color_space;
	enum de_color_range color_range;
	enum de_data_bits data_bits;
	struct drm_property_blob *backend_blob;
	struct drm_property_blob *sunxi_ctm;
	unsigned int tcon_id;
	unsigned long clk_freq;
	unsigned int pixel_mode;
	...
	vblank_enable_callback_t enable_vblank;
	fifo_status_check_callback_t check_status;
	is_sync_time_enough_callback_t is_sync_time_enough;
	get_cur_line_callback_t get_cur_line;
	connector_atomic_flush  atomic_flush;
	is_support_backlight_callback_t is_support_backlight;
	set_backlight_value_callback_t set_backlight_value;
	get_backlight_value_callback_t get_backlight_value;
	void *output_dev_data;
	struct sunxi_drm_wb *wb;
};
```

这就是 BSP 的核心解耦点：CRTC 不直接包含 HDMI/DSI/LVDS/RGB/eDP 结构体，而是保存一组回调和一个 `void *output_dev_data`。

### 3.2 DSI encoder atomic_check 的例子

DSI 在 encoder `atomic_check()` 中填充 CRTC state：

```c
/* bsp/drivers/drm/sunxi_drm_dsi.c */
int sunxi_drm_dsi_encoder_atomic_check(struct drm_encoder *encoder,
				       struct drm_crtc_state *crtc_state,
				       struct drm_connector_state *conn_state)
{
	struct sunxi_crtc_state *scrtc_state = to_sunxi_crtc_state(crtc_state);
	struct sunxi_drm_dsi *dsi = encoder_to_sunxi_drm_dsi(encoder);

	scrtc_state->tcon_id = dsi->sdrm.tcon_id;
	scrtc_state->enable_vblank = sunxi_dsi_enable_vblank;
	scrtc_state->check_status = sunxi_dsi_fifo_check;
	scrtc_state->is_sync_time_enough = sunxi_dsi_is_sync_time_enough;
	scrtc_state->get_cur_line = sunxi_dsi_get_current_line;
	scrtc_state->is_support_backlight = sunxi_dsi_is_support_backlight;
	scrtc_state->get_backlight_value = sunxi_dsi_get_backlight_value;
	scrtc_state->set_backlight_value = sunxi_dsi_set_backlight_value;
	scrtc_state->output_dev_data = dsi;

	if (conn_state->crtc) {
		dsi->sw_enable = sunxi_drm_check_if_need_sw_enable(conn_state->connector);
		scrtc_state->sw_enable = dsi->sw_enable;
	}

	if (dsi->adjusted_mode)
		drm_mode_copy(&crtc_state->adjusted_mode, dsi->adjusted_mode);

	return 0;
}
```

对应的 DSI 回调内部可以访问 DSI 自己的数据：

```c
/* bsp/drivers/drm/sunxi_drm_dsi.c */
static bool sunxi_dsi_fifo_check(void *data)
{
	struct sunxi_drm_dsi *dsi = (struct sunxi_drm_dsi *)data;
	int status;

	if (dsi->slave || (dsi->dsi_para.mode_flags & MIPI_DSI_SLAVE_MODE))
		status = sunxi_tcon_check_fifo_status(dsi->sdrm.tcon_dev);
	else
		status = dsi_get_status(&dsi->dsi_lcd);

	return status ? true : false;
}

static void sunxi_dsi_enable_vblank(bool enable, void *data)
{
	struct sunxi_drm_dsi *dsi = (struct sunxi_drm_dsi *)data;

	if (!dsi->enable) {
		dsi->pending_enable_vblank = enable;
		return;
	}

	if (dsi->slave || (dsi->dsi_para.mode_flags & MIPI_DSI_SLAVE_MODE))
		sunxi_tcon_enable_vblank(dsi->sdrm.tcon_dev, enable);
	else
		dsi_enable_vblank(&dsi->dsi_lcd, enable);
}
```

### 3.3 HDMI encoder atomic_check 的例子

HDMI 不只填回调，还把 HDMI 输出格式转换为 DE 输出格式：

```c
/* bsp/drivers/drm/sunxi_drm_hdmi.c */
static int _sunxi_drv_hdmi_filling_scrtc(struct sunxi_drm_hdmi *hdmi,
					 struct sunxi_crtc_state *scrtc)
{
	struct disp_device_config *info = NULL;

	...

	info = &hdmi->disp_config;

	/* convert disp format to de format */
	if (info->format == DISP_CSC_TYPE_YUV444) {
		scrtc->px_fmt_space = DE_FORMAT_SPACE_YUV;
		scrtc->yuv_sampling = DE_YUV444;
	} else if (info->format == DISP_CSC_TYPE_YUV422) {
		scrtc->px_fmt_space = DE_FORMAT_SPACE_YUV;
		scrtc->yuv_sampling = DE_YUV422;
	} else if (info->format == DISP_CSC_TYPE_YUV420) {
		scrtc->px_fmt_space = DE_FORMAT_SPACE_YUV;
		scrtc->yuv_sampling = DE_YUV420;
	} else {
		scrtc->px_fmt_space = DE_FORMAT_SPACE_RGB;
		scrtc->yuv_sampling = DE_YUV444;
	}

	/* convert disp bits to de bits */
	if (info->bits == DISP_DATA_10BITS)
		scrtc->data_bits = DE_DATA_10BITS;
	else if (info->bits == DISP_DATA_12BITS)
		scrtc->data_bits = DE_DATA_12BITS;
	else if (info->bits == DISP_DATA_16BITS)
		scrtc->data_bits = DE_DATA_16BITS;
	else
		scrtc->data_bits = DE_DATA_8BITS;

	...

	scrtc->tcon_id             = hdmi->sdrm.tcon_id;
	scrtc->sw_enable           = hdmi->hdmi_ctrl.drv_sw_enable;
	scrtc->output_dev_data     = hdmi;
	scrtc->check_status        = _shdmi_cb_check_status;
	scrtc->enable_vblank       = _shdmi_cb_enable_vblank;
	scrtc->is_sync_time_enough = _shdmi_cb_sync_time_enough;
	scrtc->get_cur_line        = _shdmi_cb_get_cur_line;
	scrtc->atomic_flush        = _shdmi_cb_atomic_flush;

	return 0;
}
```

HDMI encoder `atomic_check()` 最终调用这个填充函数：

```c
/* bsp/drivers/drm/sunxi_drm_hdmi.c */
static int _sunxi_drm_hdmi_check(struct drm_encoder *encoder,
				 struct drm_crtc_state *crtc_state,
				 struct drm_connector_state *conn_state)
{
	struct sunxi_crtc_state *scrtc_state = to_sunxi_crtc_state(crtc_state);
	struct sunxi_drm_hdmi *hdmi = drm_encoder_to_hdmi(encoder);
	int ret = 0, sw_enable = 0;

	...

	if (conn_state->crtc) {
		sw_enable = sunxi_drm_check_if_need_sw_enable(conn_state->connector);
		hdmi->hdmi_ctrl.drv_sw_enable = sw_enable;
	}

	if (hdmi->hdmi_ctrl.drv_sw_enable) {
		hdmi_inf("drm hdmi check sw enable.\n");
		goto exit_fill;
	}

	memcpy(&hdmi->drm_mode_adjust, &crtc_state->mode,
	       sizeof(struct drm_display_mode));

	ret = _sunxi_drv_hdmi_select_output(hdmi);
	...

exit_fill:
	ret = _sunxi_drv_hdmi_filling_scrtc(hdmi, scrtc_state);
	...
	return 0;
}
```

### 3.4 为什么 encoder atomic_check 填 CRTC state 能生效

BSP 的 mode config 使用 DRM helper：

```c
/* bsp/drivers/drm/sunxi_drm_drv.c */
static const struct drm_mode_config_funcs sunxi_drm_mode_config_funcs = {
	.atomic_check = drm_atomic_helper_check,
	.atomic_commit = sunxi_drm_atomic_helper_commit,
	.fb_create = sunxi_drm_gem_fb_create,
};
```

主线 DRM helper 的顺序是先 modeset check，再 plane/CRTC check：

```c
/* kernel/linux-6.6/drivers/gpu/drm/drm_atomic_helper.c */
int drm_atomic_helper_check(struct drm_device *dev,
			    struct drm_atomic_state *state)
{
	int ret;

	ret = drm_atomic_helper_check_modeset(dev, state);
	if (ret)
		return ret;

	if (dev->mode_config.normalize_zpos) {
		ret = drm_atomic_normalize_zpos(dev, state);
		if (ret)
			return ret;
	}

	ret = drm_atomic_helper_check_planes(dev, state);
	if (ret)
		return ret;

	...

	return ret;
}
```

在 modeset check 中，DRM helper 会调用 encoder `atomic_check()`：

```c
/* kernel/linux-6.6/drivers/gpu/drm/drm_atomic_helper.c */
bridge = drm_bridge_chain_get_first_bridge(encoder);
ret = drm_atomic_bridge_chain_check(bridge,
				    new_crtc_state,
				    new_conn_state);
if (ret) {
	drm_dbg_atomic(encoder->dev, "Bridge atomic check failed\n");
	return ret;
}

if (funcs && funcs->atomic_check) {
	ret = funcs->atomic_check(encoder, new_crtc_state,
				  new_conn_state);
	if (ret) {
		drm_dbg_atomic(encoder->dev,
			       "[ENCODER:%d:%s] check failed\n",
			       encoder->base.id, encoder->name);
		return ret;
	}
}
```

因此 BSP 的 CRTC `atomic_check()` 可以检查 encoder 是否已经填好了输出设备信息：

```c
/* bsp/drivers/drm/sunxi_drm_crtc.c */
static int sunxi_drm_crtc_atomic_check(struct drm_crtc *crtc,
				       struct drm_atomic_state *state)
{
	struct drm_crtc_state *crtc_state =
		drm_atomic_get_new_crtc_state(state, crtc);
	struct sunxi_drm_crtc *scrtc = to_sunxi_crtc(crtc);
	struct sunxi_crtc_state *scrtc_state = to_sunxi_crtc_state(crtc_state);

	if (crtc_state->enable && (!scrtc_state->output_dev_data ||
	    !scrtc_state->enable_vblank ||
	    !scrtc_state->check_status ||
	    !scrtc_state->get_cur_line)) {
		DRM_ERROR("invalid output device info\n");
		return -EINVAL;
	}

	...

	return 0;
}
```

### 3.5 CRTC enable 时把 state 回调复制到 CRTC

BSP 在 CRTC enable 阶段把 `sunxi_crtc_state` 中的回调复制到 `sunxi_drm_crtc`：

```c
/* bsp/drivers/drm/sunxi_drm_crtc.c */
static void sunxi_crtc_atomic_enable(struct drm_crtc *crtc,
				     struct drm_atomic_state *state)
{
	struct sunxi_drm_crtc *scrtc = to_sunxi_crtc(crtc);
	struct drm_crtc_state *new_state = crtc->state;
	struct sunxi_crtc_state *scrtc_state = to_sunxi_crtc_state(new_state);
	struct sunxi_de_out_cfg cfg;
	bool sw_enable = scrtc_state->sw_enable;

	...

	scrtc->enable_vblank = scrtc_state->enable_vblank;
	scrtc->check_status = scrtc_state->check_status;
	scrtc->is_sync_time_enough = scrtc_state->is_sync_time_enough;
	scrtc->get_cur_line = scrtc_state->get_cur_line;
	scrtc->is_support_backlight = scrtc_state->is_support_backlight;
	scrtc->get_backlight_value = scrtc_state->get_backlight_value;
	scrtc->set_backlight_value = scrtc_state->set_backlight_value;
	scrtc->output_dev_data = scrtc_state->output_dev_data;

	...

	cfg.hwdev_index = scrtc_state->tcon_id;
	cfg.width = modeinfo.hdisplay;
	cfg.height = modeinfo.vdisplay;
	cfg.device_fps = modeinfo.vrefresh;
	cfg.kHZ_pixelclk = modeinfo.clock;
	cfg.htotal = modeinfo.htotal;
	cfg.vtotal = modeinfo.vtotal;
	cfg.interlaced = !!(modeinfo.flags & DRM_MODE_FLAG_INTERLACE);
	cfg.px_fmt_space = scrtc_state->px_fmt_space;
	cfg.yuv_sampling = scrtc_state->yuv_sampling;
	cfg.eotf = scrtc_state->eotf;
	cfg.color_space = scrtc_state->color_space;
	cfg.color_range = scrtc_state->color_range;
	cfg.data_bits = scrtc_state->data_bits;
	cfg.pixel_mode = scrtc_state->pixel_mode;

	if (sunxi_de_enable(scrtc->sunxi_de, &cfg) < 0)
		DRM_ERROR("sunxi_de_enable failed\n");

	...
}
```

### 3.6 CRTC 运行期通过回调访问具体输出设备

enable vblank：

```c
/* bsp/drivers/drm/sunxi_drm_crtc.c */
static int sunxi_drm_crtc_enable_vblank(struct drm_crtc *crtc)
{
	struct sunxi_drm_crtc *scrtc = to_sunxi_crtc(crtc);

	DRM_DEBUG_DRIVER("%s\n", __func__);
	if (scrtc->enable_vblank == NULL) {
		DRM_ERROR("enable vblank is not registerd!\n");
		return -1;
	}
	scrtc->enable_vblank(true, scrtc->output_dev_data);
	return 0;
}
```

IRQ 中检查 FIFO 状态和安全同步时间：

```c
/* bsp/drivers/drm/sunxi_drm_crtc.c */
irqreturn_t sunxi_crtc_event_proc(int irq, void *crtc)
{
	struct sunxi_drm_crtc *scrtc = to_sunxi_crtc(crtc);
	bool timeout;
	bool busy = sunxi_de_query_de_busy(scrtc->sunxi_de, &scrtc->timings);

	scrtc->irqcnt++;
	if (scrtc->check_status(scrtc->output_dev_data)) {
		scrtc->fifo_err++;
		SUNXIDRM_TRACE_INT2("crtc-ERR", scrtc->hw_id,
				    scrtc->fifo_err & 1);
	}

	timeout = !scrtc->is_sync_time_enough(scrtc->output_dev_data);
	sunxi_de_event_proc(scrtc->sunxi_de, timeout);

	drm_crtc_handle_vblank(&scrtc->crtc);
	...
}
```

查询当前输出扫描行和背光：

```c
/* bsp/drivers/drm/sunxi_drm_crtc.c */
int sunxi_drm_crtc_get_output_current_line(struct sunxi_drm_crtc *scrtc)
{
	if (!scrtc) {
		DRM_ERROR("crtc is NULL\n");
		return -EINVAL;
	}
	return scrtc->get_cur_line(scrtc->output_dev_data);
}

bool sunxi_drm_crtc_is_support_backlight(struct sunxi_drm_crtc *scrtc)
{
	if (!scrtc) {
		DRM_ERROR("crtc is NULL\n");
		return -EINVAL;
	}

	return scrtc->is_support_backlight ?
		scrtc->is_support_backlight(scrtc->output_dev_data) : false;
}

int sunxi_drm_crtc_get_backlight(struct sunxi_drm_crtc *scrtc)
{
	if (!scrtc) {
		DRM_ERROR("crtc is NULL\n");
		return false;
	}
	return scrtc->get_backlight_value ?
		scrtc->get_backlight_value(scrtc->output_dev_data) : 0;
}

void sunxi_drm_crtc_set_backlight_value(struct sunxi_drm_crtc *scrtc,
					int backlight)
{
	if (!scrtc) {
		DRM_ERROR("crtc is NULL\n");
		return;
	}
	if (scrtc->set_backlight_value)
		scrtc->set_backlight_value(scrtc->output_dev_data, backlight);
}
```

### 3.7 BSP 设计评价

BSP 这种做法的优点：

- CRTC 不需要直接包含 HDMI/DSI/LVDS/RGB/eDP 的具体结构。
- 输出设备差异集中在各 encoder driver 中。
- 对厂商树来说扩展快，尤其是输出格式、pixel mode、sw enable、smooth config、背光、FIFO 状态等私有能力。

代价：

- `drm_crtc_state` 派生结构中保存函数指针和 `void *`，这比较私有，不是主线 DRM 常见风格。
- CRTC state 混入很多输出设备语义，状态边界不够标准。
- 如果一个 CRTC 将来允许多个 encoder 或 bridge chain 更复杂，函数指针注入模型需要更多约束。

## 4. 主线如何解耦 encoder 与 CRTC

主线 sun4i/sun8i 没有在 CRTC state 中保存输出设备函数指针。它更依赖标准 DRM 对象关系和 DTS graph。

### 4.1 CRTC mode_set_nofb 只读取当前 encoder

主线 CRTC 中有一个辅助函数，从所有 encoder 中找 `encoder->crtc == 当前 crtc` 的 encoder：

```c
/* kernel/linux-6.6/drivers/gpu/drm/sun4i/sun4i_crtc.c */
static struct drm_encoder *sun4i_crtc_get_encoder(struct drm_crtc *crtc)
{
	struct drm_encoder *encoder;

	drm_for_each_encoder(encoder, crtc->dev)
		if (encoder->crtc == crtc)
			return encoder;

	return NULL;
}
```

CRTC mode set 时把这个 encoder 传给 TCON：

```c
/* kernel/linux-6.6/drivers/gpu/drm/sun4i/sun4i_crtc.c */
static void sun4i_crtc_mode_set_nofb(struct drm_crtc *crtc)
{
	struct drm_display_mode *mode = &crtc->state->adjusted_mode;
	struct drm_encoder *encoder = sun4i_crtc_get_encoder(crtc);
	struct sun4i_crtc *scrtc = drm_crtc_to_sun4i_crtc(crtc);

	sun4i_tcon_mode_set(scrtc->tcon, encoder, mode);
	sunxi_engine_mode_set(scrtc->engine, mode);
}
```

这里不是实时查 DTS。DTS graph 已经在更早的 probe 和 atomic check/commit 过程中转化为 DRM 对象关系。

### 4.2 encoder->crtc 由 DRM atomic helper 在提交中设置

atomic check 阶段，helper 为 connector 找 encoder：

```c
/* kernel/linux-6.6/drivers/gpu/drm/drm_atomic_helper.c */
for_each_new_connector_in_state(state, connector, new_conn_state, i) {
	const struct drm_connector_helper_funcs *funcs =
		connector->helper_private;
	struct drm_encoder *new_encoder;

	if (!new_conn_state->crtc)
		continue;

	if (funcs->atomic_best_encoder)
		new_encoder = funcs->atomic_best_encoder(connector, state);
	else if (funcs->best_encoder)
		new_encoder = funcs->best_encoder(connector);
	else
		new_encoder = drm_connector_get_single_encoder(connector);

	...
}
```

commit 阶段设置运行时连接：

```c
/* kernel/linux-6.6/drivers/gpu/drm/drm_atomic_helper.c */
for_each_new_connector_in_state(old_state, connector, new_conn_state, i) {
	if (!new_conn_state->crtc)
		continue;

	if (WARN_ON(!new_conn_state->best_encoder))
		continue;

	connector->encoder = new_conn_state->best_encoder;
	connector->encoder->crtc = new_conn_state->crtc;
}
```

因此 `sun4i_crtc_get_encoder()` 找到的是 atomic commit 后已经建立好的运行时关系。

### 4.3 possible_crtcs 来自 DTS graph

CRTC 初始化时，主线把 CRTC 的 OF port 设置为 TCON 的输出 port：

```c
/* kernel/linux-6.6/drivers/gpu/drm/sun4i/sun4i_crtc.c */
/* Set crtc.port to output port node of the tcon */
scrtc->crtc.port = of_graph_get_port_by_id(scrtc->tcon->dev->of_node,
					   1);
```

DRM OF helper 通过 port 匹配 CRTC：

```c
/* kernel/linux-6.6/drivers/gpu/drm/drm_of.c */
uint32_t drm_of_crtc_port_mask(struct drm_device *dev,
			       struct device_node *port)
{
	unsigned int index = 0;
	struct drm_crtc *tmp;

	drm_for_each_crtc(tmp, dev) {
		if (tmp->port == port)
			return 1 << index;

		index++;
	}

	return 0;
}
```

encoder 侧通过扫描自己的 endpoint 找 remote port，再匹配 CRTC port：

```c
/* kernel/linux-6.6/drivers/gpu/drm/drm_of.c */
uint32_t drm_of_find_possible_crtcs(struct drm_device *dev,
				    struct device_node *port)
{
	struct device_node *remote_port, *ep;
	uint32_t possible_crtcs = 0;

	for_each_endpoint_of_node(port, ep) {
		remote_port = of_graph_get_remote_port(ep);
		if (!remote_port) {
			of_node_put(ep);
			return 0;
		}

		possible_crtcs |= drm_of_crtc_port_mask(dev, remote_port);

		of_node_put(remote_port);
	}

	return possible_crtcs;
}
```

sun8i DW HDMI probe 时填充 `encoder->possible_crtcs`：

```c
/* kernel/linux-6.6/drivers/gpu/drm/sun4i/sun8i_dw_hdmi.c */
encoder->possible_crtcs =
	sun8i_dw_hdmi_find_possible_crtcs(drm, dev->of_node);

if (encoder->possible_crtcs == 0)
	return -EPROBE_DEFER;
```

如果没有 `tcon-top`，最终走通用 helper：

```c
/* kernel/linux-6.6/drivers/gpu/drm/sun4i/sun8i_dw_hdmi.c */
static u32 sun8i_dw_hdmi_find_possible_crtcs(struct drm_device *drm,
					     struct device_node *node)
{
	struct device_node *port, *ep, *remote, *remote_port;
	u32 crtcs = 0;

	remote = of_graph_get_remote_node(node, 0, -1);
	if (!remote)
		return 0;

	if (sun8i_dw_hdmi_node_is_tcon_top(remote)) {
		...
	} else {
		crtcs = drm_of_find_possible_crtcs(drm, node);
	}

	...
	return crtcs;
}
```

### 4.4 A64 HDMI DTS graph 例子

A64 的 display-engine 声明两条 pipeline：

```dts
/* kernel/linux-6.6/arch/arm64/boot/dts/allwinner/sun50i-a64.dtsi */
de: display-engine {
	compatible = "allwinner,sun50i-a64-display-engine";
	allwinner,pipelines = <&mixer0>,
			      <&mixer1>;
	status = "disabled";
};
```

mixer0 可以输出到 tcon0 或 tcon1：

```dts
/* kernel/linux-6.6/arch/arm64/boot/dts/allwinner/sun50i-a64.dtsi */
mixer0_out: port@1 {
	#address-cells = <1>;
	#size-cells = <0>;
	reg = <1>;

	mixer0_out_tcon0: endpoint@0 {
		reg = <0>;
		remote-endpoint = <&tcon0_in_mixer0>;
	};

	mixer0_out_tcon1: endpoint@1 {
		reg = <1>;
		remote-endpoint = <&tcon1_in_mixer0>;
	};
};
```

tcon1 输入来自 mixer，输出到 HDMI：

```dts
/* kernel/linux-6.6/arch/arm64/boot/dts/allwinner/sun50i-a64.dtsi */
tcon1_in: port@0 {
	#address-cells = <1>;
	#size-cells = <0>;
	reg = <0>;

	tcon1_in_mixer0: endpoint@0 {
		reg = <0>;
		remote-endpoint = <&mixer0_out_tcon1>;
	};

	tcon1_in_mixer1: endpoint@1 {
		reg = <1>;
		remote-endpoint = <&mixer1_out_tcon1>;
	};
};

tcon1_out: port@1 {
	#address-cells = <1>;
	#size-cells = <0>;
	reg = <1>;

	tcon1_out_hdmi: endpoint@1 {
		reg = <1>;
		remote-endpoint = <&hdmi_in_tcon1>;
	};
};
```

HDMI 输入 endpoint 连回 tcon1 输出：

```dts
/* kernel/linux-6.6/arch/arm64/boot/dts/allwinner/sun50i-a64.dtsi */
hdmi: hdmi@1ee0000 {
	compatible = "allwinner,sun50i-a64-dw-hdmi",
		     "allwinner,sun8i-a83t-dw-hdmi";
	reg = <0x01ee0000 0x10000>;
	reg-io-width = <1>;
	interrupts = <GIC_SPI 88 IRQ_TYPE_LEVEL_HIGH>;
	clocks = <&ccu CLK_BUS_HDMI>, <&ccu CLK_HDMI_DDC>,
		 <&ccu CLK_HDMI>, <&rtc CLK_OSC32K>;
	clock-names = "iahb", "isfr", "tmds", "cec";
	resets = <&ccu RST_BUS_HDMI1>;
	reset-names = "ctrl";
	phys = <&hdmi_phy>;
	phy-names = "phy";
	status = "disabled";

	ports {
		#address-cells = <1>;
		#size-cells = <0>;

		hdmi_in: port@0 {
			reg = <0>;

			hdmi_in_tcon1: endpoint {
				remote-endpoint = <&tcon1_out_hdmi>;
			};
		};

		hdmi_out: port@1 {
			reg = <1>;
		};
	};
};
```

板级 DTS 再把 HDMI 输出连接到 `hdmi-connector`：

```dts
/* kernel/linux-6.6/arch/arm64/boot/dts/allwinner/sun50i-a64-pine64.dts */
hdmi-connector {
	compatible = "hdmi-connector";
	type = "a";

	port {
		hdmi_con_in: endpoint {
			remote-endpoint = <&hdmi_out_con>;
		};
	};
};

&hdmi {
	hvcc-supply = <&reg_dldo1>;
	status = "okay";
};

&hdmi_out {
	hdmi_out_con: endpoint {
		remote-endpoint = <&hdmi_con_in>;
	};
};
```

这个 DTS graph 表达的路径是：

```text
mixer0 或 mixer1
  -> tcon1 input
  -> tcon1 output
  -> hdmi input
  -> hdmi output
  -> hdmi-connector
```

对 HDMI encoder 来说，它的 `hdmi_in` remote endpoint 指向 `tcon1_out_hdmi`，remote port 是 `tcon1_out: port@1`。由于 CRTC 初始化时 `crtc->port` 也是 TCON 的 `port@1`，`drm_of_find_possible_crtcs()` 就能把 HDMI encoder 的 `possible_crtcs` 设置为包含 tcon1 对应的 CRTC。

### 4.5 TCON 根据 encoder_type 分发输出配置

CRTC 把 encoder 传给 TCON 后，TCON 按 encoder 类型配置不同输出：

```c
/* kernel/linux-6.6/drivers/gpu/drm/sun4i/sun4i_tcon.c */
void sun4i_tcon_mode_set(struct sun4i_tcon *tcon,
			 const struct drm_encoder *encoder,
			 const struct drm_display_mode *mode)
{
	switch (encoder->encoder_type) {
	case DRM_MODE_ENCODER_DSI:
		/* DSI is tied to special case of CPU interface */
		sun4i_tcon0_mode_set_cpu(tcon, encoder, mode);
		break;
	case DRM_MODE_ENCODER_LVDS:
		sun4i_tcon0_mode_set_lvds(tcon, encoder, mode);
		break;
	case DRM_MODE_ENCODER_NONE:
		sun4i_tcon0_mode_set_rgb(tcon, encoder, mode);
		sun4i_tcon_set_mux(tcon, 0, encoder);
		break;
	case DRM_MODE_ENCODER_TVDAC:
	case DRM_MODE_ENCODER_TMDS:
		sun4i_tcon1_mode_set(tcon, mode);
		sun4i_tcon_set_mux(tcon, 1, encoder);
		break;
	default:
		DRM_DEBUG_DRIVER("Unknown encoder type, doing nothing...\n");
	}
}
```

因此主线的解耦方式不是“encoder 把函数指针填给 CRTC”，而是：

```text
CRTC 只知道当前连接了哪个 encoder
TCON 根据 encoder_type 选择 TCON0/TCON1/CPU/LVDS/RGB/TMDS 等配置路径
具体 HDMI/DSI/RGB/LVDS 的 enable/disable/mode_valid 仍留在各自 encoder 或 bridge/panel driver 中
```

## 5. BSP 与主线设计对比

| 维度 | BSP 私有实现 | 主线 sun4i/sun8i |
| --- | --- | --- |
| DRM plane 与硬件关系 | 一个 DRM plane 表示一个 DE channel，plane_state 内挂多个 sub-layer | 一个 DRM plane 基本表示一个 channel 的 overlay0 |
| channel 内 4 layer | 通过 `display_channel_state` 私有数组和私有 property 表达 | 代码有 overlay 字段，但 6.6 实际固定 `overlay = 0` |
| blender 路由 | `channel_apply()` 先合成 channel，再作为 blender pipe | plane update 中直接按 channel 写 blender route |
| 输出设备到 CRTC 的关系 | encoder `atomic_check()` 填 CRTC state 回调和输出配置 | DTS graph 填 `possible_crtcs`，atomic commit 设置 `encoder->crtc` |
| CRTC 是否知道具体 encoder | CRTC 不知道具体类型，只调用回调 | CRTC 找当前 encoder，TCON 根据 `encoder_type` 分发 |
| vblank/fifo/current line | 通过 encoder 注入的回调实现 | CRTC/TCON 直接管理 vblank，TCON IRQ 处理 |
| 主线友好度 | 厂商私有扩展多，上游难度较高 | 符合 DRM/KMS 对象模型 |
| 厂商特性覆盖 | 覆盖更完整，包含 pixel mode、输出色彩、PQ、backlight、smooth config 等 | 覆盖较保守，适合早期 DE2/DE3 基础显示路径 |

## 6. 对移植或重构的含义

如果目标是理解当前 BSP：

- 把 `sunxi_drm_plane` 看成 DE channel。
- 把 `display_channel_state` 看成 channel 内 4 layer 的软件状态容器。
- 把 `channel_apply()` 看成 channel 内部 OVL/scaler/frontend 的统一配置入口。
- 把 encoder `atomic_check()` 看成输出设备对 CRTC 的服务注入点。

如果目标是向主线靠拢：

- channel 内 4 layer 不能简单变成 4 个标准 DRM plane，除非能表达“这些 plane 必须先在同一个 channel 内部合成，不能与其他 channel 任意 zpos 交错”的硬件约束。
- BSP 的 CRTC 回调注入可以被拆成更标准的 encoder/bridge/panel helper、connector/bridge state、TCON ops 或 SoC-specific private state。
- 输出色彩格式、pixel mode、YUV sampling、data bits 这类信息，在主线风格中更适合通过 connector/bridge atomic state、bus format、bridge chain check、encoder atomic_check 与 CRTC private state 的有限字段传递，而不是把大量函数指针放进 CRTC state。
- DTS graph 在主线中非常关键。它不只是描述拓扑，还参与 `possible_crtcs` 的计算，间接决定 atomic commit 中哪个 encoder 可以绑定到哪个 CRTC。

## 7. 一句话总结

主线 sun8i 6.6 的实现是“标准 DRM plane + TCON/encoder graph”的保守模型，实际只用每个 channel 的 overlay0；BSP 是“DE channel 为 DRM plane，channel 内 sub-layer 通过私有 plane state/property 表达”的厂商模型。BSP 的 encoder `atomic_check()` 通过填 CRTC 回调实现输出设备解耦，而主线则通过 DTS graph、`possible_crtcs`、`best_encoder`、`encoder->crtc` 和 TCON 的 `encoder_type` 分发来解耦。
