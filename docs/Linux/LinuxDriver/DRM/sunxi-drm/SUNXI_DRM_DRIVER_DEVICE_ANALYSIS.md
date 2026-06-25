# 全志 DRM 中 `drm_driver` / `drm_device` / `platform_driver` 关系分析

## 1. 文档目标

本文基于以下代码树做分析：

- `bsp/drivers/drm/`
- `kernel/linux-6.6/drivers/gpu/drm/`
- `kernel/linux-6.6/include/drm/`

重点回答 4 个问题：

1. 全志 DRM 中，`drm_driver` 的具体实现是什么
2. 全志 DRM 中，`drm_device` 的具体实现是什么
3. 各个硬件模块既然已经作为 `platform_driver` 存在，为什么上层还需要一个 `drm_driver`
4. 为什么 `drm_driver` 不能没有

说明：

- `bsp/drivers/drm/` 中的代码本身带有多内核版本兼容判断，本文引用 DRM core 时主要参考 SDK 中的 `kernel/linux-6.6/`，因为它最完整，也最接近 `sunxi_drm_drv.c` 注释里提到的 atomic/helper 路径。
- 本文会同时放结论和关键源码片段，避免只讲抽象概念。

---

## 2. 先给结论

### 2.1 `drm_driver` 是什么

在全志这套实现里，`drm_driver` 的具体对象就是：

- `bsp/drivers/drm/sunxi_drm_drv.c`
- 变量：`static struct drm_driver sunxi_drm_driver`

它不是某个具体硬件模块的驱动，而是“这张 DRM 卡如何接入 DRM core”的总描述表，负责告诉 DRM core：

- 这块设备支持什么能力
- `/dev/dri/cardX` 打开时用哪套 `fops`
- 驱动私有 ioctl 有哪些
- GEM 对象怎么创建
- dumb buffer / PRIME 导入导出走哪套 helper

### 2.2 `drm_device` 是什么

在全志这套实现里，真正的 `drm_device` 实例并不是单独裸分配后再外挂私有数据，而是被内嵌在私有结构里：

- `bsp/drivers/drm/sunxi_drm_drv.h`
- 结构体：`struct sunxi_drm_private`
- 成员：`struct drm_device base`

也就是说：

- `struct sunxi_drm_private` 是全志私有扩展
- `struct drm_device base` 才是 DRM core 认识的那张卡

### 2.3 `struct sunxi_drm_device` 不是 `struct drm_device`

这个名字最容易误导。

`bsp/drivers/drm/sunxi_drm_drv.h` 里还有一个：

- `struct sunxi_drm_device`

但它不是 DRM core 的 `drm_device`，而是全志自己定义的“输出端包装对象”，内部放的是：

- `drm_connector`
- `drm_encoder`
- 指向主 `drm_device` 的指针 `drm_dev`

所以这里有两类 “device”：

- `drm_device`：整张 DRM 卡
- `sunxi_drm_device`：某个输出端口对应的 connector/encoder 包装体

### 2.4 `platform_driver` 和 `drm_driver` 不是重复关系

它们负责的层次不同：

- `platform_driver` 负责“硬件块如何 probe、拿资源、上下电、挂到 component 框架”
- `drm_driver` 负责“把这些硬件块组装成一张 DRM 卡，并接到 DRM core / 用户态 ABI”

如果只有各个 `platform_driver`，没有 `drm_driver`：

- 各硬件块也许能 probe 成功
- 但不会形成一张完整的 DRM 设备
- 不会有完整的 `/dev/dri/cardX` 语义
- 没有统一的 fops / ioctl / GEM / modeset 能力入口

---

## 3. 先看三个关键结构

### 3.1 全志自定义的输出端对象：`struct sunxi_drm_device`

文件：`bsp/drivers/drm/sunxi_drm_drv.h:41-53`

```c
struct sunxi_drm_device {
	struct drm_connector connector;
	struct drm_encoder encoder;
	struct drm_device *drm_dev;
	struct drm_panel *panel;
	struct drm_bridge *bridge;
	struct device *tcon_dev;
	struct device *video_sys_dev;
	unsigned int tcon_id;
	unsigned int hw_id;
	void (*get_disp_para)(struct drm_device *dev, unsigned long *arg);
	void (*set_disp_para)(struct drm_device *dev, unsigned long *arg);
};
```

这个结构说明：

- 一个输出模块会在这里内嵌自己的 `connector`
- 同时内嵌 `encoder`
- 再保存 `drm_dev` 指针，把自己挂到主 DRM 设备上

所以 DSI/LVDS/RGB/HDMI/eDP 这些输出模块，在 bind 时不是重新造一张卡，而是把自己的 connector/encoder 注册到同一个主 `drm_device` 上。

### 3.2 全志私有的主设备扩展：`struct sunxi_drm_private`

文件：`bsp/drivers/drm/sunxi_drm_drv.h:55-79`

```c
struct sunxi_drm_private {
	struct drm_device base;
	struct drm_property *prop_blend_mode[OVL_REMAIN];
	struct drm_property *prop_alpha[OVL_REMAIN];
	struct drm_property *prop_src_x[OVL_REMAIN], *prop_src_y[OVL_REMAIN];
	struct drm_property *prop_src_w[OVL_REMAIN], *prop_src_h[OVL_REMAIN];
	struct drm_property *prop_crtc_x[OVL_REMAIN], *prop_crtc_y[OVL_REMAIN];
	struct drm_property *prop_crtc_w[OVL_REMAIN], *prop_crtc_h[OVL_REMAIN];
	struct drm_property *prop_fb_id[OVL_REMAIN];
	struct drm_property *prop_color[OVL_MAX];
	struct drm_property *prop_layer_id;
	struct drm_property *prop_frontend_data;
	struct drm_property *prop_backend_data;
	struct drm_property *prop_sunxi_ctm;
	struct drm_property *prop_feature;
	struct drm_property *prop_eotf;
	struct drm_property *prop_color_space;
	struct drm_property *prop_color_format;
	struct drm_property *prop_color_depth;
	struct drm_property *prop_color_range;
	struct drm_property *prop_frame_rate_change;
	struct drm_property *prop_compressed_image_crop;
	struct sunxi_drm_pri *priv;
};
```

这个结构说明：

- `base` 就是实际的 `struct drm_device`
- 全志私有属性、boot 信息、私有链表等都挂在 `sunxi_drm_private` 里

也就是说：

- DRM core 看见的是 `base`
- 全志驱动自己看见的是 `sunxi_drm_private`

辅助宏也说明了这一点。

文件：`bsp/drivers/drm/sunxi_drm_drv.h:81`

```c
#define to_sunxi_drm_private(drm) container_of(drm, struct sunxi_drm_private, base)
```

### 3.3 DRM core 对 `struct drm_driver` 的定义

文件：`kernel/linux-6.6/include/drm/drm_drv.h:178-445`

这里不把整个结构全部抄出来，只摘和本问题最相关的字段：

```c
struct drm_driver {
	int (*open) (struct drm_device *, struct drm_file *);
	void (*postclose) (struct drm_device *, struct drm_file *);
	void (*lastclose) (struct drm_device *);
	void (*unload) (struct drm_device *);

	struct drm_gem_object *(*gem_create_object)(struct drm_device *dev,
						    size_t size);

	int (*dumb_create)(struct drm_file *file_priv,
			   struct drm_device *dev,
			   struct drm_mode_create_dumb *args);

	u32 driver_features;

	const struct drm_ioctl_desc *ioctls;
	int num_ioctls;

	const struct file_operations *fops;
};
```

这个结构很关键，它说明 `drm_driver` 不是“某个寄存器控制模块”，而是：

- 打开/关闭行为入口
- GEM/dumb buffer 行为入口
- driver private ioctl 分发表
- 字符设备 `fops`
- 功能位声明

换句话说，`drm_driver` 是 DRM core 和具体驱动之间的“总协议表”。

---

## 4. 全志 `drm_driver` 的具体实现

文件：`bsp/drivers/drm/sunxi_drm_drv.c:413-434`

```c
#if LINUX_VERSION_CODE <= KERNEL_VERSION(6, 1, 0)
DEFINE_DRM_GEM_CMA_FOPS(sunxi_drm_driver_fops);
#else
DEFINE_DRM_GEM_DMA_FOPS(sunxi_drm_driver_fops);
#endif

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

从这段代码可以直接看出，`sunxi_drm_driver` 负责了下面几件事。

### 4.1 声明驱动能力

```c
.driver_features = DRIVER_MODESET | DRIVER_GEM | DRIVER_ATOMIC,
```

这表示：

- 这是 KMS/modeset 设备
- 使用 GEM 作为 buffer 管理模型
- 支持 atomic userspace API

### 4.2 指定 DRM 设备节点的 `fops`

```c
.fops = &sunxi_drm_driver_fops,
```

而 `sunxi_drm_driver_fops` 不是手写的，而是由 DRM helper 宏展开的。

文件：`kernel/linux-6.6/include/drm/drm_gem_dma_helper.h:259-271`

```c
#define DEFINE_DRM_GEM_DMA_FOPS(name) \
	static const struct file_operations name = {\
		.owner		= THIS_MODULE,\
		.open		= drm_open,\
		.release	= drm_release,\
		.unlocked_ioctl	= drm_ioctl,\
		.compat_ioctl	= drm_compat_ioctl,\
		.poll		= drm_poll,\
		.read		= drm_read,\
		.llseek		= noop_llseek,\
		.mmap		= drm_gem_mmap,\
		DRM_GEM_DMA_UNMAPPED_AREA_FOPS \
	}
```

所以 `sunxi_drm_driver_fops` 本质上就是：

- `open -> drm_open`
- `ioctl -> drm_ioctl`
- `mmap -> drm_gem_mmap`
- `read/poll/release` 也统一走 DRM core

这正是 `/dev/dri/cardX` 用户态入口的一部分。

### 4.3 注册驱动私有 ioctl

文件：`bsp/drivers/drm/sunxi_drm_drv.c:409-421`

```c
static const struct drm_ioctl_desc sunxi_drm_ioctls[] = {
	DRM_IOCTL_DEF_DRV(SUNXI_PQ_PROC, sunxi_de_pq_ioctl, 0),
};

...

.ioctls             = sunxi_drm_ioctls,
.num_ioctls         = ARRAY_SIZE(sunxi_drm_ioctls),
```

也就是说，全志自己的 PQ ioctl 并不是 platform 层自己随便开一个字符设备，而是作为 DRM driver private ioctl，统一挂到 DRM 设备节点下面。

### 4.4 注册 GEM 对象构造器

文件：`bsp/drivers/drm/sunxi_drm_gem.c:173-188`

```c
struct drm_gem_object *sunxi_gem_create_object(struct drm_device *dev, size_t size)
{
	struct sunxi_gem_object *sgem_obj;

	sgem_obj = kzalloc(sizeof(*sgem_obj), GFP_KERNEL);
	if (!sgem_obj)
		return ERR_PTR(-ENOMEM);

	/*
	 * set DMA_TO_DEVICE as default, and might be changed when dma-buf use as
	 * writeback output, to ensure cache coherence
	 */
	sgem_obj->dir = DMA_TO_DEVICE;
	sgem_obj->base.base.funcs = &sunxi_gem_funcs;

	return &sgem_obj->base.base;
}
```

然后在 `sunxi_drm_driver` 中挂上：

```c
.gem_create_object = sunxi_gem_create_object,
```

这表示，后续走到 GEM helper 时，底层对象最终会由全志自己的 GEM 对象包装结构承接。

### 4.5 通过 helper 宏补齐 dumb/PRIME 能力

`sunxi_drm_driver` 里还有一个很容易被忽略的点：

```c
DRM_GEM_DMA_DRIVER_OPS_VMAP,
```

对应的宏定义在：

文件：`kernel/linux-6.6/include/drm/drm_gem_dma_helper.h:203-223`

```c
#define DRM_GEM_DMA_DRIVER_OPS_VMAP_WITH_DUMB_CREATE(dumb_create_func) \
	.dumb_create		   = (dumb_create_func), \
	.gem_prime_import_sg_table = drm_gem_dma_prime_import_sg_table_vmap

#define DRM_GEM_DMA_DRIVER_OPS_VMAP \
	DRM_GEM_DMA_DRIVER_OPS_VMAP_WITH_DUMB_CREATE(drm_gem_dma_dumb_create)
```

所以它实际上又为 `sunxi_drm_driver` 补上了：

- `.dumb_create = drm_gem_dma_dumb_create`
- `.gem_prime_import_sg_table = drm_gem_dma_prime_import_sg_table_vmap`

也就是说，`sunxi_drm_driver` 并不只是你表面看到的那几行，它还通过 helper 宏拿到了标准的 dumb buffer 和 PRIME import 能力。

---

## 5. 全志 `drm_device` 是怎么创建出来的

### 5.1 component master 的 bind 是总装入口

文件：`bsp/drivers/drm/sunxi_drm_drv.c:1111-1176`

```c
static int sunxi_drm_bind(struct device *dev)
{
	int ret;
	struct drm_device *drm;
	struct sunxi_drm_private *private;
	struct drm_encoder *encoder;
	unsigned int clone_mask = 0;

	private = __devm_drm_dev_alloc(dev, &sunxi_drm_driver,
		  sizeof(*private) + sizeof(struct sunxi_drm_pri),
		    offsetof(struct sunxi_drm_private, base));
	drm = &private->base;
	if (IS_ERR(private))
		return PTR_ERR(private);

	private->priv = ((void *)private) + sizeof(*private);
	ret = drmm_mode_config_init(drm);
	if (ret)
		return ret;

	sunxi_drm_mode_config_init(drm);
	sunxi_drm_property_create(private);

	get_boot_display_info(drm);

	ret = component_bind_all(dev, drm);
	if (ret)
		goto mode_config_clean;

	drm_for_each_encoder(encoder, drm) {
		clone_mask |= BIT(drm_encoder_index(encoder));
	}
	drm_for_each_encoder(encoder, drm) {
		encoder->possible_clones = clone_mask;
	}

	dev_set_drvdata(dev, drm);
	drm_mode_config_reset(drm);
	drm_kms_helper_poll_init(drm);
	...
	ret = drm_dev_register(drm, 0);
	...
	return 0;
}
```

从这段代码能看出：

1. `__devm_drm_dev_alloc()` 分配的是 `struct sunxi_drm_private`
2. 其中的 `base` 就是主 `drm_device`
3. `component_bind_all(dev, drm)` 把同一个 `drm_device *` 传给所有子模块
4. 最终 `drm_dev_register(drm, 0)` 才把它正式注册成一张 DRM 卡

所以，主 `drm_device` 只有一个。

### 5.2 这个 `drm_device` 不是 DSI/HDMI 各自独立创建的

子模块拿到的是同一个 `drm_device *`，再把自己的对象挂上去。

DSI 例子：

文件：`bsp/drivers/drm/sunxi_drm_dsi.c:1620-1685`

```c
static int sunxi_drm_dsi_bind(struct device *dev, struct device *master, void *data)
{
	struct sunxi_drm_dsi *dsi = dev_get_drvdata(dev);
	struct sunxi_drm_device *sdrm = &dsi->sdrm;
	struct drm_device *drm = (struct drm_device *)data;
	...
	sdrm->tcon_dev = tcon_lcd_dev;
	sdrm->tcon_id = tcon_id;
	sdrm->drm_dev = drm;

	drm_encoder_helper_add(&sdrm->encoder, &sunxi_dsi_encoder_helper_funcs);
	ret = drm_simple_encoder_init(drm, &sdrm->encoder, DRM_MODE_ENCODER_DSI);
	...
	ret = drm_connector_init(drm, &sdrm->connector,
			&sunxi_dsi_connector_funcs,
			DRM_MODE_CONNECTOR_DSI);
	...
	drm_connector_attach_encoder(&sdrm->connector, &sdrm->encoder);
	...
}
```

HDMI 例子：

文件：`bsp/drivers/drm/sunxi_drm_hdmi.c:3403-3479`

```c
connect->polled            = DRM_CONNECTOR_POLL_HPD;
connect->connector_type    = DRM_MODE_CONNECTOR_HDMIA;
connect->interlace_allowed = true;
connect->ycbcr_420_allowed = true;
drm_connector_helper_add(connect, &sunxi_hdmi_connector_helper_funcs);
ret = drm_connector_init_with_ddc(drm, connect,
		&sunxi_hdmi_connector_funcs, DRM_MODE_CONNECTOR_HDMIA,
		&hdmi->i2c_adap);
...
drm_connector_attach_encoder(connect, encoder);
...
drm = (struct drm_device *)data;
hdmi->dev = dev;
hdmi->sdrm.drm_dev = drm;
hdmi->sdrm.hw_id   = 0;
```

这两段代码说明：

- 子模块不是创建新的 `drm_device`
- 它们只是把 `connector/encoder` 注册到 master 传下来的同一个 `drm_device`

---

## 6. 全志的 CRTC / Plane 也是挂到这个主 `drm_device` 上

DE 不是单独做一张卡，而是给主 `drm_device` 创建 CRTC/plane。

### 6.1 DE bind 时调用 `sunxi_drm_crtc_init_one()`

文件：`bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c:1310-1338`

```c
info.plane_cnt = display_out->ch_cnt;
info.planes = devm_kzalloc(dev, sizeof(*info.planes) * display_out->ch_cnt, GFP_KERNEL);
for (j = 0; j < display_out->ch_cnt; j++) {
	info.planes[j].name = display_out->ch_hdl[j]->name;
	info.planes[j].is_primary = j == 0;
	info.planes[j].afbc_rot_support = display_out->ch_hdl[j]->afbc_rot_support;
	info.planes[j].index = j;
	info.planes[j].hdl = display_out->ch_hdl[j];
	info.planes[j].formats = display_out->ch_hdl[j]->formats;
	info.planes[j].format_count = display_out->ch_hdl[j]->format_count;
	info.planes[j].format_modifiers = display_out->ch_hdl[j]->format_modifiers_comb;
	info.planes[j].layer_cnt = display_out->ch_hdl[j]->layer_cnt;
}
display_out->scrtc = sunxi_drm_crtc_init_one(&info);
...
wb_info.drm = drm;
...
engine->wb.drm_wb = sunxi_drm_wb_init_one(&wb_info);
```

这里的 `info.drm` 就是前面 master 传进来的那个主 `drm_device`。

### 6.2 `sunxi_drm_crtc_init_one()` 在同一个 `drm_device` 下创建 plane/crtc

文件：`bsp/drivers/drm/sunxi_drm_crtc.c:1336-1357`

```c
static int sunxi_drm_plane_init(struct drm_device *dev,
				struct sunxi_drm_crtc *scrtc,
				uint32_t possible_crtc,
				struct sunxi_drm_plane *plane, int type,
				unsigned int de_id, const struct sunxi_plane_info *info)
{
	...
	if (drm_universal_plane_init(dev, &plane->plane, possible_crtc,
				     &sunxi_plane_funcs, info->formats, info->format_count,
				     info->format_modifiers, type,
				     "plane-%d-%s(%d)", plane->index, info->name, de_id)) {
		...
	}

	drm_plane_helper_add(&plane->plane, &sunxi_plane_helper_funcs);
	sunxi_drm_plane_property_init(plane, scrtc->plane_cnt, info->afbc_rot_support);
	return 0;
}
```

文件：`bsp/drivers/drm/sunxi_drm_crtc.c:2455-2532`

```c
struct sunxi_drm_crtc *sunxi_drm_crtc_init_one(struct sunxi_de_info *info)
{
	struct sunxi_drm_crtc *scrtc;
	struct drm_device *drm = info->drm;
	...
	ret = sunxi_drm_plane_init(drm, scrtc, 0, &scrtc->plane[primary_index],
				   DRM_PLANE_TYPE_PRIMARY, info->hw_id,
				   plane);
	...
	drm_crtc_init_with_planes(drm, &scrtc->crtc,
				  &scrtc->plane[primary_index].plane, NULL,
				  &sunxi_crtc_funcs, "DE-%d", info->hw_id);
	...
	ret = sunxi_drm_plane_init(drm, scrtc, drm_crtc_mask(&scrtc->crtc),
			     &scrtc->plane[i], DRM_PLANE_TYPE_OVERLAY,
			     info->hw_id, plane);
	...
	drm_crtc_helper_add(&scrtc->crtc, &sunxi_crtc_helper_funcs);
```

这说明：

- DE 负责的并不是一个独立字符设备
- 而是往主 `drm_device` 里注册 `CRTC + primary plane + overlay plane`

到这里就能看清整张卡的对象拼装关系了：

- DE 挂 CRTC/plane
- DSI/HDMI/eDP/LVDS/RGB 挂 connector/encoder
- 主 `drm_device` 把这些对象组织成完整的 KMS 拓扑

---

## 7. `sunxi_drm_driver` 不直接“写硬件”，但它仍然很重要

从前面的代码可以看到，真正具体的硬件初始化和运行逻辑，确实主要在：

- `platform_driver` 的 `probe/bind`
- `component_ops.bind`
- `crtc/plane/connector/encoder` 各自的 helper funcs
- `mode_config_funcs`

比如 `sunxi_drm_drv.c` 里，真正和 modeset 相关的是 `mode_config`。

文件：`bsp/drivers/drm/sunxi_drm_drv.c:179-223`

```c
static const struct drm_mode_config_funcs sunxi_drm_mode_config_funcs = {
	.atomic_check = drm_atomic_helper_check,
	.atomic_commit = sunxi_drm_atomic_helper_commit,
	.fb_create = sunxi_drm_gem_fb_create,
};

static const struct drm_mode_config_helper_funcs sunxi_mode_config_helpers = {
	.atomic_commit_tail = sunxi_drm_atomic_helper_commit_tail,
};

static void sunxi_drm_mode_config_init(struct drm_device *dev)
{
	dev->mode_config.min_width = 0;
	dev->mode_config.min_height = 0;
	dev->mode_config.normalize_zpos = true;
	dev->mode_config.max_width = 8192;
	dev->mode_config.max_height = 8192;
	dev->mode_config.funcs = &sunxi_drm_mode_config_funcs;
	dev->mode_config.helper_private = &sunxi_mode_config_helpers;
}
```

这说明现代 DRM 驱动里：

- `drm_driver` 更像 “顶层能力入口表”
- `drm_device->mode_config` 和 KMS 对象回调更像 “显示语义实现体”

所以看起来 `sunxi_drm_driver` 很薄，是正常现象，并不代表它不重要。

---

## 8. 为什么 `drm_driver` 不能没有

这一节直接用 DRM core 源码来证明。

### 8.1 `drm_device` 初始化时就必须绑定一个 `drm_driver`

文件：`kernel/linux-6.6/drivers/gpu/drm/drm_drv.c:603-690`

```c
static int drm_dev_init(struct drm_device *dev,
			const struct drm_driver *driver,
			struct device *parent)
{
	...
	kref_init(&dev->ref);
	dev->dev = get_device(parent);
	dev->driver = driver;
	...
	dev->driver_features = ~0u;
	...
	if (drm_core_check_feature(dev, DRIVER_COMPUTE_ACCEL)) {
		ret = drm_minor_alloc(dev, DRM_MINOR_ACCEL);
		...
	} else {
		if (drm_core_check_feature(dev, DRIVER_RENDER)) {
			ret = drm_minor_alloc(dev, DRM_MINOR_RENDER);
			...
		}

		ret = drm_minor_alloc(dev, DRM_MINOR_PRIMARY);
		...
	}
	...
	if (drm_core_check_feature(dev, DRIVER_GEM)) {
		ret = drm_gem_init(dev);
		...
	}
	...
}
```

这段代码说明：

1. `drm_device` 初始化时就要求传入 `driver`
2. `dev->driver = driver` 是初始化第一批关键动作之一
3. 后面的 minor 分配、GEM 初始化、功能判定，都依赖 `driver_features`

如果没有 `drm_driver`：

- `dev->driver` 没有来源
- `driver_features` 无法判定
- DRM primary/render/accel minor 无法按语义分配
- GEM 初始化也无从谈起

### 8.2 `drm_dev_register()` 依赖 `drm_driver` 完成设备发布

文件：`kernel/linux-6.6/drivers/gpu/drm/drm_drv.c:904-967`

```c
int drm_dev_register(struct drm_device *dev, unsigned long flags)
{
	const struct drm_driver *driver = dev->driver;
	int ret;

	if (!driver->load)
		drm_mode_config_validate(dev);

	ret = drm_minor_register(dev, DRM_MINOR_RENDER);
	...
	ret = drm_minor_register(dev, DRM_MINOR_PRIMARY);
	...
	ret = drm_minor_register(dev, DRM_MINOR_ACCEL);
	...

	dev->registered = true;

	if (driver->load) {
		ret = driver->load(dev, flags);
		...
	}

	if (drm_core_check_feature(dev, DRIVER_MODESET)) {
		ret = drm_modeset_register_all(dev);
		...
	}

	DRM_INFO("Initialized %s %d.%d.%d %s for %s on minor %d\n",
		 driver->name, driver->major, driver->minor,
		 driver->patchlevel, driver->date,
		 dev->dev ? dev_name(dev->dev) : "virtual device",
		 dev->primary ? dev->primary->index : dev->accel->index);
	...
}
```

这段代码说明：

- `drm_dev_register()` 直接读取 `dev->driver`
- 设备名、版本号来自 `driver->name/major/minor/date`
- 是否注册 modeset 对象来自 `DRIVER_MODESET`

所以没有 `drm_driver`，`drm_dev_register()` 连语义都不完整。

### 8.3 `/dev/dri/cardX` 的真正 open 路径最终取 `driver->fops`

文件：`kernel/linux-6.6/drivers/gpu/drm/drm_drv.c:1031-1058`

```c
static int drm_stub_open(struct inode *inode, struct file *filp)
{
	const struct file_operations *new_fops;
	struct drm_minor *minor;
	int err;

	minor = drm_minor_acquire(&drm_minors_xa, iminor(inode));
	if (IS_ERR(minor))
		return PTR_ERR(minor);

	new_fops = fops_get(minor->dev->driver->fops);
	if (!new_fops) {
		err = -ENODEV;
		goto out;
	}

	replace_fops(filp, new_fops);
	if (filp->f_op->open)
		err = filp->f_op->open(inode, filp);
	else
		err = 0;
	...
}
```

这里已经把逻辑写死了：

- DRM major 的 stub open 先找到 `minor`
- 再通过 `minor->dev->driver->fops` 拿到真正的设备 `fops`

如果没有 `drm_driver.fops`：

- `open("/dev/dri/card0")` 走不下去

### 8.4 `drm_open` 也明确说了它是驱动应使用的 open 方法

文件：`kernel/linux-6.6/drivers/gpu/drm/drm_file.c:397-453`

```c
/*
 * drm_open - open method for DRM file
 *
 * This function must be used by drivers as their &file_operations.open method.
 * It looks up the correct DRM device and instantiates all the per-file
 * resources for it. It also calls the &drm_driver.open driver callback.
 */
int drm_open(struct inode *inode, struct file *filp)
{
	struct drm_device *dev;
	struct drm_minor *minor;
	int retcode;
	int need_setup = 0;
	...
	dev = minor->dev;
	...
	retcode = drm_open_helper(filp, minor);
	...
}
```

再结合前面的 `DEFINE_DRM_GEM_DMA_FOPS`：

```c
.open = drm_open,
```

就能看出：

- `drm_driver.fops` 是用户态进入 DRM core 的总入口
- `drm_driver.open` 则是更细一层的 driver callback

### 8.5 driver private ioctl 分发依赖 `dev->driver->ioctls`

文件：`kernel/linux-6.6/drivers/gpu/drm/drm_ioctl.c:839-846`

```c
if (is_driver_ioctl) {
	unsigned int index = nr - DRM_COMMAND_BASE;

	if (index >= dev->driver->num_ioctls)
		goto err_i1;
	index = array_index_nospec(index, dev->driver->num_ioctls);
	ioctl = &dev->driver->ioctls[index];
}
```

这段代码已经非常直接：

- 驱动私有 ioctl 就是从 `dev->driver->ioctls` 查表

没有 `drm_driver`：

- 驱动私有 ioctl 无法注册
- 全志这里的 `SUNXI_PQ_PROC` 也无从分发

### 8.6 GEM / dumb buffer / PRIME 也依赖 `drm_driver`

在 `struct drm_driver` 中，本来就有：

```c
struct drm_gem_object *(*gem_create_object)(struct drm_device *dev, size_t size);
int (*dumb_create)(struct drm_file *file_priv,
		   struct drm_device *dev,
		   struct drm_mode_create_dumb *args);
```

全志则通过：

```c
.gem_create_object = sunxi_gem_create_object,
DRM_GEM_DMA_DRIVER_OPS_VMAP,
```

把 GEM / dumb / PRIME 能力一起挂了进去。

如果没有 `drm_driver`，就没有这些方法表入口。

---

## 9. 用一句话解释“为什么 platform driver 还不够”

因为 `platform_driver` 只解决“硬件块如何在 Linux 设备模型里存在”，而 `drm_driver` 解决的是“这些硬件块如何作为一张 DRM 卡被 DRM core 识别、注册、打开、ioctl、mmap、管理 GEM、暴露 KMS 能力”。

更具体地说：

- `platform_driver` 负责 probe 一个 DE、一个 DSI、一个 HDMI
- `component` 框架负责把这些块组织起来
- `drm_device` 负责承载整张卡的运行时对象
- `drm_driver` 负责给 DRM core 提供整张卡的行为入口表

这四者缺一不可。

---

## 10. 把整条调用链串起来

下面用一条简化链路把前面的关系收起来。

### 10.1 驱动注册阶段

文件：`bsp/drivers/drm/sunxi_drm_drv.c:1280-1317`

```c
static int sunxi_drm_register_drivers(void)
{
	...
	for (i = 0; i < ARRAY_SIZE(sunxi_drm_sub_drivers); ++i) {
		...
		ret = platform_driver_register(drv);
		...
	}

	ret = platform_driver_register(&sunxi_drm_platform_driver);
	return ret;
}

module_init(sunxi_drm_drv_init);
module_exit(sunxi_drm_drv_exit);
```

含义：

- 先注册 DE/DSI/HDMI/eDP/TCON 等子硬件驱动
- 最后注册 DRM master

### 10.2 master probe 收集 component

文件：`bsp/drivers/drm/sunxi_drm_drv.c:455-479`

```c
static struct component_match *sunxi_drm_match_add(struct device *dev)
{
	struct component_match *match = NULL;
	int i;

	for (i = 0; i < ARRAY_SIZE(sunxi_drm_sub_drivers); ++i) {
		struct platform_driver *drv = sunxi_drm_sub_drivers[i];
		struct device *p = NULL, *d;
		...
		while ((d = platform_find_device_by_driver(p, &drv->driver))) {
			put_device(p);
			device_link_add(dev, d, DL_FLAG_STATELESS);
			component_match_add(dev, &match, compare_dev, d);
			p = d;
		}
		...
	}

	return match ?: ERR_PTR(-ENODEV);
}
```

含义：

- master 把已经 probe 出来的各个硬件模块收集为 component match 列表

### 10.3 master bind 创建唯一的主 `drm_device`

文件：`bsp/drivers/drm/sunxi_drm_drv.c:1122-1142`

```c
private = __devm_drm_dev_alloc(dev, &sunxi_drm_driver,
	  sizeof(*private) + sizeof(struct sunxi_drm_pri),
	    offsetof(struct sunxi_drm_private, base));
drm = &private->base;
...
ret = component_bind_all(dev, drm);
```

含义：

- 创建唯一的主设备实例
- 把同一个 `drm_device *` 传给全部 component

### 10.4 DE/DSI/HDMI/eDP 把对象挂到主设备上

示意：

- DE：`drm_crtc_init_with_planes()`
- DSI：`drm_simple_encoder_init()` + `drm_connector_init()`
- HDMI：`drm_connector_init_with_ddc()`
- eDP：`drm_connector_init()`

### 10.5 最终注册为一张 DRM 卡

文件：`bsp/drivers/drm/sunxi_drm_drv.c:1168-1169`

```c
dev_register:
	ret = drm_dev_register(drm, 0);
```

到这里，用户态才真正能看到完整的 DRM 设备节点。

---

## 11. 最终关系图

```text
platform_driver (DE / DSI / HDMI / eDP / TCON ...)
        |
        v
component_add / component_match
        |
        v
sunxi_drm_platform_driver (master)
        |
        v
sunxi_drm_bind()
        |
        +--> __devm_drm_dev_alloc(..., &sunxi_drm_driver, ...)
        |        |
        |        v
        |   struct sunxi_drm_private
        |        |
        |        v
        |   struct drm_device base   <----- 这才是主 DRM 设备
        |
        +--> component_bind_all(dev, drm)
                 |
                 +--> DE bind    -> 注册 CRTC / plane / wb
                 +--> DSI bind   -> 注册 encoder / connector
                 +--> HDMI bind  -> 注册 encoder / connector
                 +--> eDP bind   -> 注册 encoder / connector
                 +--> LVDS/RGB   -> 注册 encoder / connector
        |
        v
drm_dev_register(drm, 0)
        |
        v
/dev/dri/cardX
        |
        +--> driver->fops -> drm_open / drm_ioctl / drm_gem_mmap
        +--> driver->ioctls -> SUNXI_PQ_PROC 等私有 ioctl
        +--> driver->gem_create_object / dumb_create / PRIME
```

---

## 12. 最后的结论

可以把全志 DRM 的分层理解成下面这句话：

`platform_driver` 负责驱动显示硬件块，`component` 负责把硬件块拼起来，`drm_device` 负责承载“整张卡”的运行时对象，`drm_driver` 负责把这张卡的能力和用户态入口注册给 DRM core。

因此：

- `drm_driver` 不是多余的一层
- 它也不是和 `platform_driver` 做同一件事
- 它是 DRM core 语义里不可缺少的“总入口表”

如果没有它：

- `drm_device` 无法完整初始化
- primary/render minor 无法按 DRM 语义分配
- `/dev/dri/cardX` 无法得到正确 `fops`
- driver private ioctl 无法分发
- GEM / dumb buffer / PRIME 无法标准化接入
- 整套 KMS/DRM 用户态接口都失去统一入口

所以“硬件模块都已经是 platform driver 了，为什么还要 `drm_driver`”的答案就是：

因为 platform 层只解决“硬件存在”，而 DRM 层还要解决“整张显示卡如何被内核 DRM core 和用户态共同理解并使用”。
