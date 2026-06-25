# IOCTL calls and hardware register interaction
_Exported on 2026/4/23 at GMT+8 18:53:54 from Cursor (2.6.21)_

---

**User**

帮我基于全志DRM实现bsp/drivers/drm
帮我讲一下，当所有component被聚合完成，drm device被完全创建以后，上层应用通过IOCTL调用具体功能的时候，是如何一步步落到硬件寄存器的？请你选一些经典IOCTL为例，进行讲解

---

**Cursor**

我先把关键路径梳理出来，再结合几个典型 IOCTL 讲调用链。

我再定位几个关键函数：`component` 聚合、`ioctl` 分发表、以及原子提交最终写寄存器的位置。

我把这些函数的上下文读出来，方便按真实代码路径给你串起来。

我改用更小范围读取，避免大文件搜索超时。

我继续分段读取关键位置。

我再取一下精确行号，这样能直接按代码位置给你讲。

我已经拿到关键函数位置，接着读这些局部代码并按链路解释。

我再抓几段精确代码片段，方便你对着源文件看完整调用链。

我再补一下 `set_disp_para/get_disp_para` 和 PQ 数据最终下沉的位置，这样能把“用户态参数 -> connector/DE -> 寄存器”闭环讲完整。

搜索结果不够直接，我用精确的代码索引方式再抓一次。

我把 `SUNXI_PQ_PROC` 中间那段也补出来，避免漏掉 PQ ioctl 是怎么进入 atomic state 的。

可以。我按你这套全志 `bsp/drivers/drm` 的实现，站在“`component` 全部聚合完成，`drm_device` 已经注册完成”这个时点，给你讲：

1. `drm device` 是怎么完成创建的  
2. 上层应用发 `ioctl` 以后，调用是怎么一层层往下走  
3. 选几个经典 `ioctl` 例子：
   - `DRM_IOCTL_MODE_ATOMIC`：最经典，最终一定会落到显示硬件寄存器
   - `SUNXI_PQ_PROC`：全志私有扩展，能非常清楚看到“用户参数 -> DE/TCON/接口寄存器”
   - `DRM_IOCTL_MODE_CREATE_DUMB`：也很经典，但它主要落到内存分配，不直接写显示寄存器，我会顺带说明它为什么通常要再配合 atomic commit 才真正“打到硬件”

---

## 一、先看这个 BSP 里，`drm device` 是何时“完全创建好”的

### 1. master 设备 probe 后，开始收集所有 component

`sunxi-drm` 主平台驱动在 `probe` 里调用 `component_master_add_with_match()`，等所有子模块都准备好之后再统一 bind：

```1203:1219:bsp/drivers/drm/sunxi_drm_drv.c
static int sunxi_drm_platform_probe(struct platform_device *pdev)
{
	struct component_match *match;

	DRM_INFO("%s start\n", __FUNCTION__);
	match = sunxi_drm_match_add(&pdev->dev);
	if (IS_ERR(match)) {
		DRM_INFO("sunxi_drm_match_add fail\n");
		return PTR_ERR(match);
	}

#if IS_ENABLED(CONFIG_PROC_FS)
	sunxi_drm_procfs_create();
#endif

	return component_master_add_with_match(&pdev->dev, &sunxi_drm_ops,
					       match);
}
```

这里的 `match` 里收集的是 DE、TCON、DSI、LVDS、RGB、HDMI、EDP、TCON_TOP 等子驱动。

---

### 2. 当所有 component 聚合完成，进入 `sunxi_drm_bind`

真正“把 DRM 世界拼起来”的地方在这里：

```1111:1168:bsp/drivers/drm/sunxi_drm_drv.c
static int sunxi_drm_bind(struct device *dev)
{
	int ret;
	struct drm_device *drm;
	struct sunxi_drm_private *private;
	struct drm_encoder *encoder;
	unsigned int clone_mask = 0;

	DRM_INFO("%s start\n", __FUNCTION__);
	private = __devm_drm_dev_alloc(dev, &sunxi_drm_driver,
		  sizeof(*private) + sizeof(struct sunxi_drm_pri),
		    offsetof(struct sunxi_drm_private, base));
	drm = &private->base;
	if (IS_ERR(private))
		return PTR_ERR(private);

	private->priv = ((void *)private) + sizeof(*private);
	ret = drmm_mode_config_init(drm);
	if (ret) {
		DRM_ERROR("drmm_mode_config_init fail %d\n", ret);
		return ret;
	}

	sunxi_drm_mode_config_init(drm);
	sunxi_drm_property_create(private);

	get_boot_display_info(drm);

	ret = component_bind_all(dev, drm);
	if (ret)
		goto mode_config_clean;

	...
	dev_set_drvdata(dev, drm);
	drm_mode_config_reset(drm);

	drm_kms_helper_poll_init(drm);
	...
	ret = drm_dev_register(drm, 0);
```

这里发生了几件非常关键的事：

- `__devm_drm_dev_alloc(...)`：分配 `drm_device`
- `drmm_mode_config_init(...)`：初始化 KMS mode_config
- `sunxi_drm_property_create(...)`：创建全志自定义 property
- `component_bind_all(dev, drm)`：把所有子模块真正绑定进这个 `drm_device`
- `drm_mode_config_reset(drm)`：让 CRTC/plane/connector state 进入初始态
- `drm_dev_register(drm, 0)`：注册 `/dev/dri/cardX`

到 `drm_dev_register()` 成功之后，用户态就可以 `open("/dev/dri/card0")`，之后开始发各种 DRM `ioctl` 了。

---

### 3. 驱动自己的 ioctl 表是在这里挂上的

```409:434:bsp/drivers/drm/sunxi_drm_drv.c
static const struct drm_ioctl_desc sunxi_drm_ioctls[] = {
	DRM_IOCTL_DEF_DRV(SUNXI_PQ_PROC, sunxi_de_pq_ioctl, 0),
};

...
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
	...
};
```

这说明两类 `ioctl` 会同时存在：

- **DRM core 标准 ioctl**
  - 比如 `DRM_IOCTL_MODE_ATOMIC`
  - `DRM_IOCTL_MODE_CREATE_DUMB`
  - `DRM_IOCTL_MODE_ADDFB2`
  - `DRM_IOCTL_MODE_OBJ_SETPROPERTY`
- **sunxi 私有 ioctl**
  - 这里只有 `SUNXI_PQ_PROC`

---

# 二、从用户态 `ioctl(fd, cmd, arg)` 到驱动函数，通用路径是什么

你可以先把链路抽象成这样：

```text
userspace
  -> libc ioctl()
  -> sys_ioctl
  -> drm file_operations.unlocked_ioctl
  -> drm_ioctl()
  -> 按 cmd 分发
       -> 标准 DRM ioctl：进 drm core 的 modeset/gem/atomic 路径
       -> 驱动私有 ioctl：进 sunxi_drm_driver.ioctls[] 对应函数
  -> 驱动内部对象/状态更新
  -> atomic commit 或直接硬件访问
  -> DE/TCON/DSI/... 写寄存器
```

在这个 BSP 里：

- **私有 ioctl** 直接通过 `sunxi_drm_driver.ioctls[]` 落到 `sunxi_de_pq_ioctl`
- **标准 atomic ioctl** 不会走 `sunxi_drm_ioctls[]`，而是走 DRM core 通用实现，然后在关键时刻回调到你驱动注册的：
  - `mode_config.funcs.atomic_commit`
  - `crtc_helper_funcs.atomic_enable/begin/flush/disable`
  - plane/crtc/connector 的各种 helper

---

# 三、例子 1：`DRM_IOCTL_MODE_ATOMIC` 是怎样一步步落到寄存器的

这是最关键的一条路径，因为真正显示更新几乎都靠它。

---

## 1. 用户态做了什么

典型用户态会做这些事：

- 创建或导入 framebuffer
- 组装 atomic request：
  - 给 plane 设置 `FB_ID / CRTC_ID / SRC_X/Y/W/H / CRTC_X/Y/W/H`
  - 给 CRTC 设置 mode
  - 给 connector 绑定 CRTC
- 调用 `DRM_IOCTL_MODE_ATOMIC`

例如：

- Weston
- kmscube
- Android HWC 的 DRM backend
- 你自己写的 libdrm 原子提交程序

---

## 2. DRM core 收到 atomic ioctl 后，会调用驱动的 `atomic_commit`

这个驱动在 `mode_config` 里注册了：

```179:223:bsp/drivers/drm/sunxi_drm_drv.c
static const struct drm_mode_config_funcs sunxi_drm_mode_config_funcs = {
	.atomic_check = drm_atomic_helper_check,
	.atomic_commit = sunxi_drm_atomic_helper_commit,
	.fb_create = sunxi_drm_gem_fb_create,
};
```

所以 `DRM_IOCTL_MODE_ATOMIC`
最终会走到：

```130:176:bsp/drivers/drm/sunxi_drm_drv.c
for_each_oldnew_connector_in_state(state, conn, old_conn_state, new_conn_state, i) {
	...
}
for_each_oldnew_plane_in_state(state, plane, old_plane_state, new_plane_state, i) {
	...
}

return drm_atomic_helper_commit(dev, state, nonblock);
```

这层做的事主要是：

- 检查 nonblock commit 是否和前一帧冲突
- 然后交给 `drm_atomic_helper_commit(...)`

也就是说，**真正的“大流水线”还是 DRM 原子框架在跑**，sunxi 只是在关键节点插入自己的回调。

---

## 3. commit_tail 会依次触发 disable / enable / plane commit

这个驱动自定义了 `commit_tail`：

```186:209:bsp/drivers/drm/sunxi_drm_drv.c
static void sunxi_drm_atomic_helper_commit_tail(struct drm_atomic_state *old_state)
{
	struct drm_device *dev = old_state->dev;

	drm_atomic_helper_commit_modeset_disables(dev, old_state);

	drm_atomic_helper_commit_modeset_enables(dev, old_state);

	drm_atomic_helper_commit_planes(dev, old_state,
					0);

	drm_atomic_helper_fake_vblank(old_state);

	drm_atomic_helper_commit_hw_done(old_state);

	drm_atomic_helper_cleanup_planes(dev, old_state);
}
```

这里你要抓住一个核心点：

- **modeset enable/disable**：决定显示链路开关、时序、输出接口状态
- **commit_planes**：决定这一帧 plane/图层怎么显示
- 这些最终会回调到 `sunxi_crtc_helper_funcs` 和 plane helper

---

## 4. CRTC 使能时，先把 DE/TCON 输出链路拉起来

CRTC helper 里挂了几个核心回调：

```2296:2302:bsp/drivers/drm/sunxi_drm_crtc.c
static const struct drm_crtc_helper_funcs sunxi_crtc_helper_funcs = {
	.atomic_enable = sunxi_crtc_atomic_enable,
	.atomic_disable = sunxi_crtc_atomic_disable,
	.atomic_check = sunxi_drm_crtc_atomic_check,
	.atomic_begin = sunxi_crtc_atomic_begin,
	.atomic_flush = sunxi_crtc_atomic_flush,
};
```

当 atomic commit 里涉及 modeset enable 时，会进：

```1878:1960:bsp/drivers/drm/sunxi_drm_crtc.c
static void sunxi_crtc_atomic_enable(struct drm_crtc *crtc,
				     struct drm_atomic_state *state)
{
	...
	drm_property_blob_get(new_state->mode_blob);
	memcpy(&modeinfo, new_state->mode_blob->data,
	       new_state->mode_blob->length);
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
	...
	if (sunxi_de_enable(scrtc->sunxi_de, &cfg) < 0)
		DRM_ERROR("sunxi_de_enable failed\n");
```

这一步做的事情本质是：

- 从 atomic state 里拿到 mode/timing
- 整理成 `sunxi_de_out_cfg`
- 调 `sunxi_de_enable()`

`sunxi_de_enable()` 再往下就会：

- 配 DE 输出参数
- 配 TCON 输出时序
- 配接口层（DSI/LVDS/RGB/HDMI/EDP）
- 最终写这些模块的 MMIO 寄存器

所以 **第一次 modeset enable** 时，`DRM_IOCTL_MODE_ATOMIC` 就已经可以直接触发硬件寄存器配置了。

---

## 5. 每次 commit 开始，会进入 `atomic_begin`

```2018:2054:bsp/drivers/drm/sunxi_drm_crtc.c
static void sunxi_crtc_atomic_begin(struct drm_crtc *crtc,
			     struct drm_atomic_state *state)
{
	...
	if (crtc->state->event) {
		drm_crtc_vblank_get(crtc);
		...
		scrtc->event = crtc->state->event;
		...
		crtc->state->event = NULL;
	}
	...
	sunxi_de_atomic_begin(scrtc->sunxi_de);
	...
}
```

这里主要做两类事：

- 处理 vblank/page-flip event
- 通知 DE “本轮 atomic 更新开始了”

但在你这版里 `sunxi_de_atomic_begin()` 基本是空的：

```565:569:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c
void sunxi_de_atomic_begin(struct sunxi_de_out *hwde)
{
}
```

所以这个点更像是一个“阶段钩子”。

---

## 6. 真正把本次原子状态下沉给 DE，在 `atomic_flush`

最关键的是这里：

```2057:2123:bsp/drivers/drm/sunxi_drm_crtc.c
static void sunxi_crtc_atomic_flush(struct drm_crtc *crtc,
				    struct drm_atomic_state *state)
{
	...
	if (all_dirty || crtc->state->color_mgmt_changed) {
		...
		if (crtc->state->gamma_lut) {
			cfg.gamma_lut = crtc->state->gamma_lut->data;
			cfg.gamma_dirty = true;
		}
	}

	if (all_dirty || scrtc_state->sunxi_ctm_changed) {
		...
		cfg.ctm = scrtc_state->sunxi_ctm->data;
		cfg.ctm_dirty = true;
		...
	}

	if (all_dirty || scrtc_state->bcsh_changed) {
		cfg.brightness = scrtc_state->excfg.brightness;
		cfg.contrast = scrtc_state->excfg.contrast;
		cfg.saturation = scrtc_state->excfg.saturation;
		cfg.hue = scrtc_state->excfg.hue;
		cfg.bcsh_dirty = true;
		...
	}

	backend_data = scrtc_state->backend_blob ? scrtc_state->backend_blob->data : NULL;
	sunxi_de_atomic_flush(scrtc->sunxi_de, backend_data, &cfg);
	...
	sunxi_crtc_finish_page_flip(crtc->dev, scrtc);
}
```

你可以把这里理解成：

- 从 CRTC state 中取出本次提交生效的所有“后端显示参数”
- 例如：
  - gamma LUT
  - CTM
  - BCSH
  - backend blob
- 再统一交给 `sunxi_de_atomic_flush()`

所以 **DRM atomic 框架负责“状态管理与事务提交”，sunxi DE 层负责“把状态翻译成硬件寄存器更新”**。

---

## 7. `sunxi_de_atomic_flush`：从“软件状态”走向“硬件更新请求”

```695:777:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c
void sunxi_de_atomic_flush(struct sunxi_de_out *hwde, struct de_backend_data *data, struct sunxi_de_flush_cfg *cfg)
{
	...
	if ((cfg || data) && (unsigned long)cfg != FORCE_ATOMIC_FLUSH)
		sunxi_de_exconfig_check_and_update(hwde, data, cfg);

	...
	if (use_rcq) {
		...
		if (engine->match_data->rcq_wait_line)
			rcq_update_timer_start(hwde);
		else
			de_top_set_rcq_update(engine->top_hdl, hwde->id, 1);

		sunxi_drm_crtc_prepare_vblank_event(hwde->scrtc);
		...
	} else if (use_double_buffer) {
		de_update_ahb(hwde);
		de_top_set_double_buffer_ready(engine->top_hdl, hwde->id);
	}
	...
}
```

这一步已经非常接近硬件了。它做两件事：

### 第一件：先把“扩展配置”应用到 DE 各功能块
即：

```584:637:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c
static int sunxi_de_exconfig_check_and_update(struct sunxi_de_out *hwde, struct de_backend_data *data, struct sunxi_de_flush_cfg *cfg)
{
	...
	if (dirty)
		de_backend_apply(hwde->backend_hdl, data, &bcfg);
	sunxi_de_update_regs(hwde);
	return 0;
}
```

- `de_backend_apply(...)`：配置 backend 模块
- `sunxi_de_update_regs(...)`：把 channel/frontend/backend 里缓存的寄存器值刷到 RCQ buffer 或 shadow reg

---

### 第二件：触发真正的硬件生效
根据平台更新模式不同：

- `RCQ_MODE`
  - `de_top_set_rcq_update(...)`
- `DOUBLE_BUFFER_MODE`
  - `de_update_ahb(...)`
  - `de_top_set_double_buffer_ready(...)`

也就是说：

> 前面那堆 `apply/update_regs` 更多是在“准备寄存器内容”  
> 这里才是在“通知硬件这一批寄存器可以切换生效了”

---

## 8. backend/frontend 再继续拆成具体功能块

### backend 路径

```477:494:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_backend.c
int de_backend_apply(struct de_backend_handle *hdl, struct de_backend_data *data, struct de_backend_apply_cfg *cfg)
{
	de_backend_check_and_reconfig(hdl, cfg);

	de_backend_apply_crc(hdl);

	de_backend_apply_gamma(hdl, data, cfg);

	de_backend_apply_csc(hdl, data, cfg);

	de_backend_apply_deband(hdl, data);

	de_backend_apply_smbl(hdl, data);

	return 0;
}
```

backend 一般对应全局后处理模块，例如：

- gamma
- csc
- deband
- smbl

这些函数里面再往下就是模块级寄存器组装，最终 `writel()` 或写 RCQ buffer。

---

### frontend / channel 路径

plane 的图层配置最终会走到 channel，然后调 frontend：

```730:755:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.c
frontend_cfg.layer_en_cnt = hdl->private->info.layer_en_cnt;
...
frontend_cfg.de_out_cfg.width = de_info->width;
frontend_cfg.de_out_cfg.height = de_info->height;
...
de_frontend_apply(hdl->private->frontend, state, &frontend_cfg);
```

然后 frontend 再拆成各 PQ/缩放模块：

```861:880:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_frontend.c
s32 de_frontend_apply(struct de_frontend_handle *hdl, struct display_channel_state *cstate,
		 struct de_frontend_apply_cfg *frontend_cfg)
{
	de_frontend_check_and_reconfig(hdl, cstate, frontend_cfg);

	de_frontend_apply_fcm(hdl, cstate);

	de_frontend_apply_sharp(hdl, cstate);

	de_frontend_apply_asu(hdl, cstate);

	de_frontend_apply_snr(hdl, cstate);

	de_frontend_apply_dci(hdl, cstate);

	de_frontend_apply_dlc(hdl, cstate);

	de_frontend_apply_cdc_and_csc(hdl, cstate);

	return 0;
}
```

这就说明：

- plane 的 src/dst、format、crop、scale
- frontend PQ 模块（FCM、SNR、DLC、DCI、ASU、sharp）
- 最终都归并到 DE channel/frontend 的硬件配置

---

## 9. 所以 `DRM_IOCTL_MODE_ATOMIC` 的完整落地链路可以总结成

```text
用户态 DRM atomic ioctl
-> DRM core 解析 atomic request，生成 atomic state
-> sunxi_drm_mode_config_funcs.atomic_commit
-> drm_atomic_helper_commit
-> commit_tail
   -> modeset_disables
   -> modeset_enables
      -> sunxi_crtc_atomic_enable
         -> sunxi_de_enable
         -> TCON / 接口时序 / 输出通路寄存器配置
   -> commit_planes
      -> plane/crtc state 汇总
      -> sunxi_crtc_atomic_begin
      -> sunxi_crtc_atomic_flush
         -> sunxi_de_atomic_flush
            -> sunxi_de_exconfig_check_and_update
               -> de_backend_apply
               -> sunxi_de_update_regs
            -> de_top_set_rcq_update / de_top_set_double_buffer_ready
-> 硬件在合适时机切换寄存器生效
```

---

# 四、例子 2：`SUNXI_PQ_PROC`——最适合看“用户参数怎样直接落到寄存器”

这个是你这个 BSP 最有代表性的全志私有 ioctl。

---

## 1. 驱动如何把这个 ioctl 暴露给用户态

```409:410:bsp/drivers/drm/sunxi_drm_drv.c
static const struct drm_ioctl_desc sunxi_drm_ioctls[] = {
	DRM_IOCTL_DEF_DRV(SUNXI_PQ_PROC, sunxi_de_pq_ioctl, 0),
};
```

用户态发这个 ioctl 后，DRM core 会分发到 `sunxi_de_pq_ioctl()`。

---

## 2. `sunxi_de_pq_ioctl` 先解析用户传入的参数

```246:260:bsp/drivers/drm/sunxi_drm_drv.c
static int sunxi_de_pq_ioctl(struct drm_device *dev, void *data, struct drm_file *file)
{
	unsigned long *ubuffer = data;
	...
	int pq_type = ubuffer[0];
	int disp = ubuffer[1];
	void __user *user_para = (void __user *)ubuffer[2];
	int para_size = ubuffer[3];
```

可以看到这个私有协议很直接：

- `pq_type`：要做什么
- `disp`：操作哪个显示通路
- `user_para`：用户态参数结构体地址
- `para_size`：参数大小

---

## 3. 情况 A：`PQ_SET_REG / PQ_GET_REG`，直接走到 connector 对应接口驱动

这是最“直通硬件”的一类：

```266:292:bsp/drivers/drm/sunxi_drm_drv.c
case PQ_SET_REG:
	...
	if (copy_from_user(para, (void __user *)user_para, para_size)) ...
	conn = drm_get_disp_connector(dev, disp);
	...
	sdrm = connector_to_sunxi_drm_device(conn);
	if (sdrm->set_disp_para)
		sdrm->set_disp_para(dev, para);
	break;
```

```293:318:bsp/drivers/drm/sunxi_drm_drv.c
case PQ_GET_REG:
	...
	conn = drm_get_disp_connector(dev, disp);
	...
	sdrm = connector_to_sunxi_drm_device(conn);
	if (sdrm->get_disp_para)
		sdrm->get_disp_para(dev, para);

	if (copy_to_user((void __user *)user_para, para, para_size)) ...
	break;
```

这里的关键点是：

- 先按 `disp` 找到 connector
- 再从 connector 找到 `sunxi_drm_device`
- 调它的 `set_disp_para/get_disp_para`

而这些函数指针是在各接口驱动里注册的，比如 DSI：

```1991:1992:bsp/drivers/drm/sunxi_drm_dsi.c
dsi->sdrm.get_disp_para = sunxi_get_disp_dsi_para;
dsi->sdrm.set_disp_para = sunxi_set_disp_dsi_para;
```

LVDS/RGB 也是类似：

- `sunxi_drm_lvds.c`
- `sunxi_drm_rgb.c`

所以这条链路是：

```text
userspace SUNXI_PQ_PROC(PQ_SET_REG / PQ_GET_REG)
-> sunxi_de_pq_ioctl
-> drm_get_disp_connector
-> connector_to_sunxi_drm_device
-> sdrm->set_disp_para / get_disp_para
-> DSI/LVDS/RGB/HDMI/... 接口驱动自己的寄存器读写函数
-> 直接访问对应输出接口寄存器
```

### 这类 ioctl 的特点
- 不一定经过 atomic
- 更像“设备参数直通”
- 常用于面板、链路、PHY、TCON 接口侧的调参或寄存器抓取

---

## 4. 情况 B：`PQ_GAMMA / PQ_FCM / PQ_DCI / PQ_DLC / PQ_DEBAND ...`

这类不会立刻直接 `writel()`，而是**先进入 DRM state / DE shadow 配置**，等下一次 flush 时生效。

`sunxi_de_pq_ioctl` 中这段：

```340:372:bsp/drivers/drm/sunxi_drm_drv.c
...
cmd = (*(int *)para);

if (pq_type == PQ_GAMMA) {
	...
	gamma_tmp->lut = k_lut;
}

ret = sunxi_drm_crtc_pq_proc(dev, disp, pq_type, para);
if (ret)
	goto OUT;
```

真正往下走的是 `sunxi_drm_crtc_pq_proc()`，它再分成：

- CRTC/backend 类 PQ
- plane/frontend 类 PQ

从 `sunxi_drm_crtc.c` 可以看出这两条路。

---

### 4.1 backend 类 PQ：例如 `PQ_DEBAND`、`PQ_COLOR_MATRIX`

```140:197:bsp/drivers/drm/sunxi_drm_crtc.c
static int sunxi_crtc_pq_proc_locked(struct sunxi_drm_crtc *scrtc, enum sunxi_pq_type type, void *data)
{
	struct sunxi_crtc_state *state = to_sunxi_crtc_state(scrtc->crtc.state);
	struct de_backend_data *cur;
	...
	if (state->backend_blob) {
		state->backend_blob = drm_property_create_blob(scrtc->crtc.dev, sizeof(struct de_backend_data), NULL);
	}
	...
	cur = state->backend_blob->data;
	switch (type) {
	case PQ_DEBAND:
		cur->dirty |= DEBAND_DIRTY;
		cur->deband_para.dirty |= PQD_DIRTY_MASK;
		memcpy(&cur->deband_para.pqd, data, sizeof(cur->deband_para.pqd));
		if (cur->deband_para.pqd.cmd == PQ_READ) {
			sunxi_de_backend_get_pqd_config(scrtc->sunxi_de, cur);
			...
		}
		break;
	case PQ_COLOR_MATRIX:
		...
```

这里能看到典型模式：

- 用户参数先写进 `state->backend_blob`
- 设置 dirty 标志
- 如果是 `PQ_READ`，则从当前 DE backend 读回来

读取当前值时会到：

```557:562:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c
int sunxi_de_backend_get_pqd_config(struct sunxi_de_out *hwde, struct de_backend_data *data)
{
	if (hwde->backend_hdl) {
		return de_backend_get_pqd_config(hwde->backend_hdl, data);
	}
	return -ENODEV;
}
```

而写入值则要等后面的 `atomic_flush -> sunxi_de_atomic_flush -> de_backend_apply`

---

### 4.2 frontend / plane 类 PQ：例如 `PQ_FCM / PQ_DCI / PQ_DLC / PQ_SNR / PQ_ASU`

```232:307:bsp/drivers/drm/sunxi_drm_crtc.c
static int sunxi_plane_pq_proc_locked(struct drm_plane *plane, enum sunxi_pq_type type, void *data)
{
	struct display_channel_state *cstate = to_display_channel_state(plane->state);
	struct de_frontend_data *cur;
	...
	if (!cstate->frontend_blob) {
		cstate->frontend_blob = drm_property_create_blob(plane->dev, sizeof(struct de_frontend_data), NULL);
	}
	...
	cur = cstate->frontend_blob->data;

	switch (type) {
	case PQ_FCM:
		cur->dirty |= FCM_DIRTY;
		cur->fcm_para.dirty |= PQD_DIRTY_MASK;
		memcpy(&cur->fcm_para.pqd, data, sizeof(cur->fcm_para.pqd));
		if (cur->fcm_para.pqd.cmd == PQ_READ) {
			channel_get_pqd_config(splane->hdl, cstate);
			...
		}
		break;
	case PQ_DCI:
		...
```

这条路的核心是：

- 参数先写进 `plane state -> frontend_blob`
- 打 dirty 标志
- 真正生效要等 channel/frontend apply

读取当前值时会到 `channel_get_pqd_config(...)`。

---

## 5. PQ 参数最终在哪一层落到寄存器

### frontend 类 PQ
下一次图层/帧更新时，channel 会调用：

```739:755:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_channel.c
frontend_cfg.layer_en_cnt = hdl->private->info.layer_en_cnt;
...
de_frontend_apply(hdl->private->frontend, state, &frontend_cfg);
```

然后：

```861:880:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_frontend.c
de_frontend_apply_fcm(hdl, cstate);
de_frontend_apply_sharp(hdl, cstate);
de_frontend_apply_asu(hdl, cstate);
de_frontend_apply_snr(hdl, cstate);
de_frontend_apply_dci(hdl, cstate);
de_frontend_apply_dlc(hdl, cstate);
de_frontend_apply_cdc_and_csc(hdl, cstate);
```

### backend 类 PQ
下一次 CRTC flush 时调用：

```584:637:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c
if (dirty)
	de_backend_apply(hwde->backend_hdl, data, &bcfg);
sunxi_de_update_regs(hwde);
```

再进入：

```477:494:bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_backend.c
de_backend_apply_gamma(hdl, data, cfg);
de_backend_apply_csc(hdl, data, cfg);
de_backend_apply_deband(hdl, data);
de_backend_apply_smbl(hdl, data);
```

最后再通过 `update_regs + rcq/double-buffer trigger` 交给硬件。

---

## 6. 所以 `SUNXI_PQ_PROC` 有两种典型落地方式

### 路线 A：接口寄存器直达型
```text
userspace
-> SUNXI_PQ_PROC(PQ_SET_REG/PQ_GET_REG)
-> sunxi_de_pq_ioctl
-> connector -> sdrm->set_disp_para/get_disp_para
-> DSI/LVDS/RGB/... 驱动
-> 直接读写接口/TCON/PHY 寄存器
```

### 路线 B：DE PQ 模块延迟生效型
```text
userspace
-> SUNXI_PQ_PROC(PQ_FCM/PQ_DCI/PQ_DLC/PQ_GAMMA/PQ_DEBAND...)
-> sunxi_de_pq_ioctl
-> sunxi_drm_crtc_pq_proc
-> 写入 crtc_state.backend_blob 或 plane_state.frontend_blob
-> 标记 dirty
-> 下一次 atomic flush / channel apply
-> de_backend_apply / de_frontend_apply
-> update_regs
-> rcq / double buffer 触发
-> 寄存器真正生效
```

这也是全志 DE 里很典型的设计：  
**ioctl 先改“软件影子配置”，再在帧提交点统一刷入硬件。**

---

# 五、例子 3：`DRM_IOCTL_MODE_CREATE_DUMB` 为什么经典，但它本身不直接打寄存器

这个也很常见，上层程序经常先做：

- `CREATE_DUMB`
- `MAP_DUMB`
- `ADDFB2`
- 再 `ATOMIC`

---

## 1. 这个驱动支持 GEM/DMA 内存对象

`drm_driver` 里有：

```418:433:bsp/drivers/drm/sunxi_drm_drv.c
static struct drm_driver sunxi_drm_driver = {
	.driver_features = DRIVER_MODESET | DRIVER_GEM | DRIVER_ATOMIC,
	...
	.gem_create_object = sunxi_gem_create_object,
	...
};
```

GEM object 的创建函数：

```170:184:bsp/drivers/drm/sunxi_drm_gem.c
struct drm_gem_object *sunxi_gem_create_object(struct drm_device *dev, size_t size)
{
	struct sunxi_gem_object *sgem_obj;

	sgem_obj = kzalloc(sizeof(*sgem_obj), GFP_KERNEL);
	if (!sgem_obj)
		return ERR_PTR(-ENOMEM);

	sgem_obj->dir = DMA_TO_DEVICE;
	sgem_obj->base.base.funcs = &sunxi_gem_funcs;

	return &sgem_obj->base.base;
}
```

这说明 dumb buffer 创建时，主要是在搞：

- GEM object
- DMA/CMA 内存
- mmap / sg_table / dma_addr

而不是显示控制寄存器。

---

## 2. 为什么它本身不直接写显示硬件寄存器

因为 `CREATE_DUMB` 只是“造一块能给显示用的显存对象”。  
此时硬件还不知道：

- 这块 buffer 属于哪个 plane
- 输出到哪个 CRTC
- 在屏幕哪个位置显示
- 用什么格式
- 什么时候切换到它

这些都要等到：

- `ADDFB2` 把 GEM object 变成 framebuffer
- `ATOMIC` 把 framebuffer 绑到 plane/crtc 上

所以 `CREATE_DUMB` 的“终点”是内存分配，不是寄存器。

---

## 3. 真正打到寄存器还是要靠 atomic commit

也就是：

```text
CREATE_DUMB
-> 分配 GEM/DMA buffer

ADDFB2
-> 创建 framebuffer 对象

ATOMIC
-> plane state 引用该 fb
-> channel/frontend/scaler/backend 配置生成
-> DE/TCON 寄存器生效
```

所以如果你问“从 ioctl 到硬件寄存器”的完整故事，`CREATE_DUMB` 是前半段资源准备；`MODE_ATOMIC` 才是最终落硬件的那一下。

---

# 六、把这几个 ioctl 放在一起看，你就能抓住三种不同风格

---

## 风格 1：标准 KMS 原子提交型
代表：`DRM_IOCTL_MODE_ATOMIC`

特点：

- 由 DRM core 统一解析状态
- 驱动主要提供 helper 回调
- 最终经 `atomic_enable / atomic_flush / de_apply / update_regs`
- 最终写 DE/TCON/接口寄存器

这是**主路径**。

---

## 风格 2：驱动私有 PQ/寄存器控制型
代表：`SUNXI_PQ_PROC`

特点：

- 直接进驱动私有 ioctl
- 有些分支直接去 connector/output 驱动改寄存器
- 有些分支只改 shadow/blob，等下一帧 flush 时统一生效

这是**厂商增强路径**。

---

## 风格 3：资源对象创建型
代表：`DRM_IOCTL_MODE_CREATE_DUMB`

特点：

- 主要创建 GEM/DMA buffer
- 本身不打显示寄存器
- 必须再配合 `ADDFB2 + ATOMIC`

这是**资源准备路径**。

---

# 七、你可以这样理解“应用 ioctl 如何一步步落到硬件寄存器”

我给你一个最实用的总框图：

```text
用户态应用
  -> ioctl(fd, DRM_IOCTL_xxx, arg)

如果是标准 DRM ioctl:
  -> DRM core 通用分发
  -> modeset/gem/atomic 子系统
  -> 调用 sunxi 注册的 helper / driver callback
  -> sunxi_crtc_atomic_enable/flush
  -> sunxi_de_atomic_flush
  -> de_backend_apply / de_frontend_apply / channel_update_regs
  -> de_top_set_rcq_update 或 double-buffer ready
  -> 硬件在合适时机切换寄存器

如果是 sunxi 私有 ioctl:
  -> drm_driver.ioctls[] -> sunxi_de_pq_ioctl
  -> 分两类:
       A. 直接 connector/output hook
          -> DSI/LVDS/RGB/... 寄存器
       B. 写入 crtc/plane state 的 frontend/backend blob
          -> 等下一次 atomic flush 时落到 DE 模块寄存器
```

---

# 八、结合你这套代码，几个最值得盯的函数

如果你要自己继续深挖，我建议按这个顺序看：

1. `sunxi_drm_bind()`  
   看设备何时真正 ready  
   `bsp/drivers/drm/sunxi_drm_drv.c`

2. `sunxi_drm_driver` / `sunxi_drm_ioctls[]`  
   看 ioctl 表和 driver feature  
   `bsp/drivers/drm/sunxi_drm_drv.c`

3. `sunxi_crtc_atomic_enable()`  
   看 mode/timing 如何进 DE/TCON  
   `bsp/drivers/drm/sunxi_drm_crtc.c`

4. `sunxi_crtc_atomic_flush()`  
   看 color/gamma/backend blob 如何进入 DE flush  
   `bsp/drivers/drm/sunxi_drm_crtc.c`

5. `sunxi_de_atomic_flush()`  
   看真正硬件更新触发点  
   `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/sunxi_de.c`

6. `de_backend_apply()` / `de_frontend_apply()`  
   看具体 PQ/CSC/Gamma/Scaler 模块是怎么被配置的  
   `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_backend.c`  
   `bsp/drivers/drm/sunxi_device/hardware/lowlevel_de/de_frontend.c`

7. 各接口驱动里的 `set_disp_para/get_disp_para`  
   看私有 PQ ioctl 怎样直达输出接口寄存器  
   如 `sunxi_drm_dsi.c`

---

如果你愿意，我下一步可以继续帮你做两件事中的任意一个：

1. 画一张“`DRM_IOCTL_MODE_ATOMIC -> DE/TCON/DSI 寄存器`”的详细时序图  
2. 直接结合你当前这份代码，把 `sunxi_drm_crtc_pq_proc()` 和某个具体模块（比如 `PQ_GAMMA` 或 `PQ_DCI`）继续往下追到更底层的寄存器写函数。

