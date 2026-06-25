# 全志DISP驱动架构分析
_Exported on 2026/3/18 at GMT+8 17:07:58 from Cursor (2.3.34)_

---

**User**

@bsp/drivers/video/sunxi 请分析一下全志DISP驱动架构

---

**Cursor**

我来分析一下全志DISP驱动架构，先看看目录结构。

现在我已经收集了足够的信息来分析全志DISP驱动架构。让我再看一下关键的硬件抽象层文件。

现在我已经收集了足够的信息，可以对全志DISP驱动架构做一个完整的分析了。

---

## 全志 DISP2 显示驱动架构分析

### 一、整体目录结构

```
bsp/drivers/video/sunxi/
├── disp2/              ← 主显示驱动（DISP2框架）
│   ├── disp/           ← 核心驱动
│   │   ├── de/         ← Display Engine（显示引擎）中间层
│   │   │   ├── lowlevel_v2x/   ← DE2.0 硬件抽象层（多平台）
│   │   │   ├── lowlevel_v33x/  ← DE3.3 硬件抽象层
│   │   │   ├── lowlevel_v35x/  ← DE3.5 硬件抽象层
│   │   │   ├── lowlevel_v21x/  ← DE2.1 硬件抽象层
│   │   │   └── ...
│   │   ├── lcd/        ← LCD面板驱动（大量具体屏型号驱动）
│   │   ├── pq/         ← 图像质量（PQ）调节
│   │   ├── dev_disp.c  ← 驱动入口、字符设备、ioctl
│   │   ├── fb_top.c    ← Framebuffer顶层
│   │   ├── fb_core.c   ← Framebuffer核心
│   │   └── fb_platform.c ← Framebuffer平台适配
│   ├── hdmi2/          ← HDMI驱动
│   ├── edp/edp2/       ← eDP驱动
│   ├── eink200/        ← eInk驱动
│   └── tv/             ← TV输出驱动
├── lcd_fb/             ← 轻量级LCD-FB驱动（独立路径）
└── dec/                ← 视频解码相关
```

---

### 二、驱动架构分层模型

```
┌─────────────────────────────────────────────────────┐
│              用户空间 (User Space)                   │
│        /dev/disp   /dev/fb0   ioctl/mmap            │
└───────────────────┬─────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────┐
│           驱动入口层 (Platform Driver Layer)          │
│   dev_disp.c  ← platform_driver, cdev, ioctl分发    │
│   fb_top.c / fb_core.c / fb_platform.c ← fbdev      │
└───────────────────┬─────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────┐
│           BSP显示核心层 (BSP Display Core)           │
│  de/disp_display.c  ← bsp_disp_init() 总初始化入口  │
│  de/disp_manager.c  ← disp_manager（图层合成管理）  │
│  de/disp_lcd.c      ← LCD设备抽象                   │
│  de/disp_hdmi.c     ← HDMI设备抽象                  │
│  de/disp_edp.c      ← eDP设备抽象                   │
│  de/disp_device.c   ← 统一显示设备注册/管理         │
│  de/disp_enhance.c  ← 图像增强                      │
│  de/disp_capture.c  ← 帧捕获/写回(RTWB)            │
└───────────────────┬─────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────┐
│         硬件抽象层 (HAL / lowlevel_vXX)              │
│  lowlevel_v2x/disp_al.c   ← AL统一接口              │
│  lowlevel_v2x/de_hal.c    ← DE寄存器操作封装        │
│  lowlevel_v2x/de_rtmx.c   ← RealTime Mixer(混合器)  │
│  lowlevel_v2x/de_enhance.c← 增强模块(FCC/FCE/LTI等) │
│  lowlevel_v2x/de_smbl.c   ← 智能背光控制            │
│  lowlevel_v2x/de_wb.c     ← WriteBack回写           │
│  lowlevel_v2x/de_lcd.c    ← TCON寄存器控制          │
│  lowlevel_v2x/de_dsi.c    ← MIPI DSI PHY            │
│  lowlevel_v2x/de_clock.c  ← 时钟管理               │
└───────────────────┬─────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────┐
│              硬件 (Hardware)                         │
│   Display Engine (DE)  ←→  TCON  ←→  LCD/HDMI/DSI  │
└─────────────────────────────────────────────────────┘
```

---

### 三、核心数据结构关系

```
disp_drv_info (g_disp_drv)          ← 全局驱动信息
  ├── disp_init_para                 ← 启动参数（output_type/mode等）
  ├── disp_manager *mgr[]            ← 每个屏的图层管理器
  ├── clk_de[] / clk_tcon[]         ← 时钟资源
  ├── rst_bus_de[] / rst_bus_tcon[] ← 复位控制
  └── disp_vsync                    ← Vsync事件管理

disp_manager                        ← 图层合成管理器（每屏一个）
  ├── disp_manager_private_data      ← 私有数据
  │   ├── clk/rst/reg_base/irq_no   ← DE硬件资源
  │   ├── disp_manager_data *cfg    ← 当前图层配置
  │   └── dmabuf_list               ← DMA buffer链表
  └── → disp_device                 ← 关联的输出设备

disp_device                         ← 输出设备（LCD/HDMI/eDP等）
  ├── disp_device_func / ops        ← 操作函数集
  └── disp_lcd_cfg / timings        ← 时序/配置信息

disp_dev_t (gdisp)                  ← BSP全局显示状态
  ├── disp_bsp_init_para init_para  ← 初始化参数（reg_base/irq等）
  └── screen[N]                     ← 每屏任务队列/tasklet
```

---

### 四、关键数据流与初始化流程

```
platform_driver probe()
    └── disp_init()                    [dev_disp.c]
         ├── 解析DTS: reg/clk/rst/irq
         ├── bsp_disp_init()           [de/disp_display.c]
         │    ├── disp_init_feat()     ← 特性初始化（支持哪些DE版本）
         │    ├── disp_init_al()       ← HAL层初始化（寄存器映射）
         │    ├── disp_init_lcd()      ← LCD设备注册
         │    ├── disp_init_hdmi()     ← HDMI设备注册（可选）
         │    ├── disp_init_edp()      ← eDP设备注册（可选）
         │    ├── disp_init_mgr()      ← Manager初始化（图层合成）
         │    ├── disp_init_enhance()  ← 图像增强模块
         │    ├── disp_init_smbl()     ← 智能背光
         │    └── disp_init_capture()  ← 帧捕获
         ├── fb_init()                 ← 注册framebuffer设备
         └── composer_init()           ← HWC Composer初始化（可选）
```

---

### 五、显示刷新路径（Vsync同步流程）

```
DE硬件触发中断 (FRAME_END / RCQ_FINISH)
    └── DRV_disp_int_process(sel)      [dev_disp.c]
         └── disp_tasklet()            ← tasklet异步处理
              ├── disp_sync_proc_list  ← 执行注册的sync回调
              └── disp_composer_proc() [de/disp_manager.c]
                   ├── unmap旧dmabuf
                   ├── 应用新图层配置 (disp_al_manager_apply)
                   └── update_timeline ← 通知fence/sync完成
```

---

### 六、多平台DE版本适配机制

`disp_features.h` 和 `disp_private.h` 通过编译宏实现多平台适配：

| 宏定义 | 对应HAL目录 | 适用平台 |
|---|---|---|
| `DE_VERSION_V33X` | `lowlevel_v33x/` | sun50iw9 等 |
| `DE_VERSION_V35X` | `lowlevel_v35x/` | sun55iw3 等 |
| `DE_VERSION_V21X` | `lowlevel_v21x/` | 新一代 |
| `CONFIG_ARCH_SUN50IW2` | `lowlevel_v2x/` | DE2.0通用 |
| `CONFIG_ARCH_SUN50IW3/6` | `lowlevel_v3x/` | DE3.0 |

所有平台统一通过 `disp_al.h` 暴露相同接口，上层代码无需关心底层差异。

---

### 七、与DRM驱动的关系

该项目同时存在两套显示驱动：

| 维度 | DISP2（disp2/） | DRM（drm/） |
|---|---|---|
| 接口 | 私有ioctl + fbdev | 标准DRM/KMS |
| 核心抽象 | disp_manager + disp_device | CRTC + Plane + Connector |
| 文件 | dev_disp.c | sunxi_drm_drv.c |
| 适用场景 | 老框架，向后兼容 | 新框架，标准Linux显示栈 |

两套驱动可通过 `CONFIG_AW_DRM` 宏选择编译，`disp_lcd.h` 中也有针对DRM的 `lcd_fix_power` 字段支持，说明两套架构存在部分共用。

---

### 总结

全志DISP2驱动采用**四层架构**：
1. **驱动入口层**（dev_disp.c + fbdev）：字符设备、ioctl、framebuffer注册
2. **BSP核心层**（de/disp_*.c）：设备无关的显示逻辑、图层管理、设备抽象
3. **HAL层**（lowlevel_vXX/）：针对不同DE版本的寄存器级操作
4. **硬件层**：DE引擎 → TCON控制器 → 物理接口（DSI/HDMI/RGB/eDP）

核心设计亮点是通过编译宏实现**多DE版本一套上层代码**的跨平台复用，以及通过 `disp_manager` + `disp_device` 的抽象将**合成逻辑与输出设备彻底解耦**。

```plaintext
bsp/drivers/video/sunxi/
├── disp2/              ← 主显示驱动（DISP2框架）
│   ├── disp/           ← 核心驱动
│   │   ├── de/         ← Display Engine（显示引擎）中间层
│   │   │   ├── lowlevel_v2x/   ← DE2.0 硬件抽象层（多平台）
│   │   │   ├── lowlevel_v33x/  ← DE3.3 硬件抽象层
│   │   │   ├── lowlevel_v35x/  ← DE3.5 硬件抽象层
│   │   │   ├── lowlevel_v21x/  ← DE2.1 硬件抽象层
│   │   │   └── ...
│   │   ├── lcd/        ← LCD面板驱动（大量具体屏型号驱动）
│   │   ├── pq/         ← 图像质量（PQ）调节
│   │   ├── dev_disp.c  ← 驱动入口、字符设备、ioctl
│   │   ├── fb_top.c    ← Framebuffer顶层
│   │   ├── fb_core.c   ← Framebuffer核心
│   │   └── fb_platform.c ← Framebuffer平台适配
│   ├── hdmi2/          ← HDMI驱动
│   ├── edp/edp2/       ← eDP驱动
│   ├── eink200/        ← eInk驱动
│   └── tv/             ← TV输出驱动
├── lcd_fb/             ← 轻量级LCD-FB驱动（独立路径）
└── dec/                ← 视频解码相关
```

```plaintext
┌─────────────────────────────────────────────────────┐
│              用户空间 (User Space)                   │
│        /dev/disp   /dev/fb0   ioctl/mmap            │
└───────────────────┬─────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────┐
│           驱动入口层 (Platform Driver Layer)          │
│   dev_disp.c  ← platform_driver, cdev, ioctl分发    │
│   fb_top.c / fb_core.c / fb_platform.c ← fbdev      │
└───────────────────┬─────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────┐
│           BSP显示核心层 (BSP Display Core)           │
│  de/disp_display.c  ← bsp_disp_init() 总初始化入口  │
│  de/disp_manager.c  ← disp_manager（图层合成管理）  │
│  de/disp_lcd.c      ← LCD设备抽象                   │
│  de/disp_hdmi.c     ← HDMI设备抽象                  │
│  de/disp_edp.c      ← eDP设备抽象                   │
│  de/disp_device.c   ← 统一显示设备注册/管理         │
│  de/disp_enhance.c  ← 图像增强                      │
│  de/disp_capture.c  ← 帧捕获/写回(RTWB)            │
└───────────────────┬─────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────┐
│         硬件抽象层 (HAL / lowlevel_vXX)              │
│  lowlevel_v2x/disp_al.c   ← AL统一接口              │
│  lowlevel_v2x/de_hal.c    ← DE寄存器操作封装        │
│  lowlevel_v2x/de_rtmx.c   ← RealTime Mixer(混合器)  │
│  lowlevel_v2x/de_enhance.c← 增强模块(FCC/FCE/LTI等) │
│  lowlevel_v2x/de_smbl.c   ← 智能背光控制            │
│  lowlevel_v2x/de_wb.c     ← WriteBack回写           │
│  lowlevel_v2x/de_lcd.c    ← TCON寄存器控制          │
│  lowlevel_v2x/de_dsi.c    ← MIPI DSI PHY            │
│  lowlevel_v2x/de_clock.c  ← 时钟管理               │
└───────────────────┬─────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────┐
│              硬件 (Hardware)                         │
│   Display Engine (DE)  ←→  TCON  ←→  LCD/HDMI/DSI  │
└─────────────────────────────────────────────────────┘
```

```plaintext
disp_drv_info (g_disp_drv)          ← 全局驱动信息
  ├── disp_init_para                 ← 启动参数（output_type/mode等）
  ├── disp_manager *mgr[]            ← 每个屏的图层管理器
  ├── clk_de[] / clk_tcon[]         ← 时钟资源
  ├── rst_bus_de[] / rst_bus_tcon[] ← 复位控制
  └── disp_vsync                    ← Vsync事件管理

disp_manager                        ← 图层合成管理器（每屏一个）
  ├── disp_manager_private_data      ← 私有数据
  │   ├── clk/rst/reg_base/irq_no   ← DE硬件资源
  │   ├── disp_manager_data *cfg    ← 当前图层配置
  │   └── dmabuf_list               ← DMA buffer链表
  └── → disp_device                 ← 关联的输出设备

disp_device                         ← 输出设备（LCD/HDMI/eDP等）
  ├── disp_device_func / ops        ← 操作函数集
  └── disp_lcd_cfg / timings        ← 时序/配置信息

disp_dev_t (gdisp)                  ← BSP全局显示状态
  ├── disp_bsp_init_para init_para  ← 初始化参数（reg_base/irq等）
  └── screen[N]                     ← 每屏任务队列/tasklet
```

```plaintext
platform_driver probe()
    └── disp_init()                    [dev_disp.c]
         ├── 解析DTS: reg/clk/rst/irq
         ├── bsp_disp_init()           [de/disp_display.c]
         │    ├── disp_init_feat()     ← 特性初始化（支持哪些DE版本）
         │    ├── disp_init_al()       ← HAL层初始化（寄存器映射）
         │    ├── disp_init_lcd()      ← LCD设备注册
         │    ├── disp_init_hdmi()     ← HDMI设备注册（可选）
         │    ├── disp_init_edp()      ← eDP设备注册（可选）
         │    ├── disp_init_mgr()      ← Manager初始化（图层合成）
         │    ├── disp_init_enhance()  ← 图像增强模块
         │    ├── disp_init_smbl()     ← 智能背光
         │    └── disp_init_capture()  ← 帧捕获
         ├── fb_init()                 ← 注册framebuffer设备
         └── composer_init()           ← HWC Composer初始化（可选）
```

```plaintext
DE硬件触发中断 (FRAME_END / RCQ_FINISH)
    └── DRV_disp_int_process(sel)      [dev_disp.c]
         └── disp_tasklet()            ← tasklet异步处理
              ├── disp_sync_proc_list  ← 执行注册的sync回调
              └── disp_composer_proc() [de/disp_manager.c]
                   ├── unmap旧dmabuf
                   ├── 应用新图层配置 (disp_al_manager_apply)
                   └── update_timeline ← 通知fence/sync完成
```

---

**User**

@bsp/drivers/drm 对比一下全志DRM实现，分析一下全志DISP和DRM设计理念上的不同

---

**Cursor**

现在已经收集了足够的信息，可以做全面的对比分析了。

---

## 全志 DISP2 vs DRM 驱动架构对比分析

### 一、整体架构对比

```
┌──────────────────────────────────────────────────────────────────────┐
│                        用户空间 (User Space)                          │
├─────────────────────────────┬────────────────────────────────────────┤
│        DISP2 接口            │            DRM 接口                    │
│  /dev/disp  (私有ioctl)      │  /dev/dri/card0  (标准KMS ioctl)      │
│  /dev/fb0   (fbdev)          │  /dev/fb0  (drm fbdev emulation)      │
└──────────────┬──────────────┴──────────────────┬─────────────────────┘
               │                                  │
┌──────────────▼──────────────┐  ┌───────────────▼─────────────────────┐
│       DISP2 驱动框架         │  │         DRM/KMS 驱动框架             │
│                              │  │                                      │
│  dev_disp.c  (字符设备入口)  │  │  sunxi_drm_drv.c (DRM驱动主入口)    │
│     ↓ ioctl分发              │  │     ↓ component框架组装              │
│  de/disp_display.c           │  │  sunxi_drm_crtc.c (CRTC/Plane)     │
│  de/disp_manager.c           │  │     ↓ atomic commit                  │
│  de/disp_device.c            │  │  sunxi_device/sunxi_tcon.c           │
│     ↓ tasklet同步            │  │  sunxi_device/sunxi_hdmi.c           │
│  lowlevel_v2x/disp_al.c      │  │     ↓ 标准encoder/connector          │
│  lowlevel_v2x/de_rtmx.c      │  │  sunxi_device/hardware/lowlevel_de/  │
│                              │  │  sunxi_device/hardware/lowlevel_tcon/│
└──────────────────────────────┘  └──────────────────────────────────────┘
```

---

### 二、核心设计理念对比

#### 1. 抽象模型

| 维度 | DISP2 | DRM |
|---|---|---|
| **核心抽象** | `disp_manager` + `disp_device`（全志自定义） | `drm_crtc` + `drm_plane` + `drm_connector` + `drm_encoder`（Linux标准KMS） |
| **图层模型** | `disp_layer_config` / `disp_layer_config2` | `drm_plane_state`（标准Plane属性） |
| **输出设备** | `disp_device`（LCD/HDMI/eDP统一抽象） | `drm_connector` + `drm_encoder`（物理分离） |
| **合成管理** | `disp_manager`（私有合成逻辑） | `drm_atomic_state`（原子状态机） |
| **用户接口** | 私有ioctl（`DISP_xxx`命令字） | 标准KMS ioctl（`DRM_IOCTL_MODE_*`） |

---

#### 2. 提交/同步机制

**DISP2 — 命令式 + tasklet异步**：
```
用户 ioctl(DISP_LAYER_SET_CONFIG)
    └── disp_manager->apply()         ← 立即写配置到shadow寄存器
         └── 中断触发 FRAME_END
              └── DRV_disp_int_process()
                   └── tasklet → disp_composer_proc()
                        ├── unmap旧dmabuf
                        ├── disp_al_manager_apply()  ← 真正刷新HW
                        └── update_timeline()         ← fence通知
```

**DRM — 原子状态机 + commit线程**：
```
用户 DRM_IOCTL_MODE_ATOMIC
    └── drm_atomic_helper_check()     ← 验证整体状态合法性
         └── sunxi_drm_atomic_helper_commit()
              └── drm_atomic_helper_commit_tail()
                   ├── commit_modeset_disables()
                   ├── commit_modeset_enables()
                   ├── commit_planes()             ← 批量提交所有Plane
                   └── drm_atomic_helper_fake_vblank()
                        └── vblank IRQ → drm_crtc_send_vblank_event()
                             └── fence signal / flip_done completion
```

**关键差异**：DISP2 是**命令式逐次提交**，DRM 是**声明式原子提交**——整个显示状态（所有CRTC/Plane/Connector）作为一个原子事务一次性检查并提交，要么全部成功要么全部回滚。

---

#### 3. 硬件组织方式

**DISP2 硬件层**（`lowlevel_v2x/`）：
```
disp_al.c           ← 统一AL接口（单一入口）
  ├── de_rtmx.c     ← DE RealTime Mixer（图层混合）
  ├── de_enhance.c  ← 增强（FCC/FCE/LTI/PEAK/ASE）
  ├── de_smbl.c     ← 智能背光
  ├── de_wb.c       ← WriteBack回写
  ├── de_lcd.c      ← TCON寄存器（LCD时序）
  └── de_clock.c    ← 时钟管理
```

**DRM 硬件层**（`sunxi_device/hardware/lowlevel_de/`）：
```
sunxi_de.c          ← DE顶层管理（component设备）
  ├── de_channel.c  ← 通道管理（每个Plane对应一个channel）
  ├── de_frontend.c ← 前端处理（缩放/格式转换）
  ├── de_backend.c  ← 后端处理（CSC/Gamma/Dither/BCSH）
  ├── de_top.c      ← DE顶层控制（时钟/路由）
  ├── ovl/          ← Overlay混合器
  ├── scaler/       ← 缩放器
  ├── csc/          ← 色彩空间转换
  ├── gamma/        ← Gamma校正
  ├── fcm/          ← 色彩管理
  ├── smbl/         ← 智能背光
  └── wb/           ← WriteBack
```

**关键差异**：DRM把DE的功能拆成了独立子模块（每个功能一个目录），与 `drm_plane`（frontend/ovl）和 `drm_crtc`（backend）一一对应，模块边界更清晰。DISP2 的 `disp_al` 是单一扁平入口，所有功能集中调用。

---

#### 4. 多设备组织方式

**DISP2 — 静态初始化**：
```c
// dev_disp.c / disp_display.c: 手动逐一初始化
bsp_disp_init()
  ├── disp_init_lcd()    // 直接调用
  ├── disp_init_hdmi()   // 直接调用
  ├── disp_init_edp()    // 直接调用
  └── disp_init_mgr()    // 直接调用
```

**DRM — component框架动态绑定**：
```c
// sunxi_drm_drv.c: 声明依赖组件
static struct platform_driver sunxi_de_platform_driver;
static struct platform_driver sunxi_tcon_platform_driver;
static struct platform_driver sunxi_hdmi_platform_driver;
// ...

// component_master_add_with_match() 等待所有组件就绪后
// 统一调用 drm_dev_register()
```

**关键差异**：DRM 使用 Linux `component` 框架，各子设备（DE/TCON/HDMI/DSI）独立注册为 platform_driver，主驱动等待所有组件就绪后才完成初始化。DISP2 是在单一 platform_driver 的 probe 中手动串行初始化所有子模块，耦合度更高。

---

#### 5. 属性/配置传递

**DISP2**：
```c
// 私有结构体，通过ioctl从用户空间拷贝
struct disp_layer_config2 {
    struct disp_layer_info2 info;
    bool enable;
    unsigned int channel;
    unsigned int layer_id;
};
// 用户直接填充私有结构传入内核
ioctl(fd, DISP_LAYER_SET_CONFIG2, &lyr_cfg2);
```

**DRM**：
```c
// 标准drm_property，通过KMS属性系统传递
struct sunxi_drm_private {
    struct drm_property *prop_eotf;
    struct drm_property *prop_color_space;
    struct drm_property *prop_color_format;
    struct drm_property *prop_color_depth;
    struct drm_property *prop_backend_data;  // blob属性
    struct drm_property *prop_frontend_data; // blob属性
    // ...
};
// 用户通过标准DRM property接口设置，框架保证原子性
```

**关键差异**：DRM 的属性通过 `drm_property` 系统管理，每个属性都有类型检查、版本兼容性保证，且与原子状态机深度集成。DISP2 的私有ioctl结构体直接暴露内核内部数据结构，版本兼容维护成本高。

---

### 三、设计哲学总结

```
┌─────────────────────────────────────────────────────────────────┐
│                         设计哲学对比                              │
├──────────────────────────┬──────────────────────────────────────┤
│         DISP2            │              DRM                      │
├──────────────────────────┼──────────────────────────────────────┤
│ 命令式（Imperative）      │ 声明式（Declarative）                 │
│ "告诉驱动做什么"           │ "告诉驱动期望的状态是什么"             │
├──────────────────────────┼──────────────────────────────────────┤
│ 私有接口                  │ 标准接口                              │
│ 全志自定义ioctl            │ 

```plaintext
┌──────────────────────────────────────────────────────────────────────┐
│                        用户空间 (User Space)                          │
├─────────────────────────────┬────────────────────────────────────────┤
│        DISP2 接口            │            DRM 接口                    │
│  /dev/disp  (私有ioctl)      │  /dev/dri/card0  (标准KMS ioctl)      │
│  /dev/fb0   (fbdev)          │  /dev/fb0  (drm fbdev emulation)      │
└──────────────┬──────────────┴──────────────────┬─────────────────────┘
               │                                  │
┌──────────────▼──────────────┐  ┌───────────────▼─────────────────────┐
│       DISP2 驱动框架         │  │         DRM/KMS 驱动框架             │
│                              │  │                                      │
│  dev_disp.c  (字符设备入口)  │  │  sunxi_drm_drv.c (DRM驱动主入口)    │
│     ↓ ioctl分发              │  │     ↓ component框架组装              │
│  de/disp_display.c           │  │  sunxi_drm_crtc.c (CRTC/Plane)     │
│  de/disp_manager.c           │  │     ↓ atomic commit                  │
│  de/disp_device.c            │  │  sunxi_device/sunxi_tcon.c           │
│     ↓ tasklet同步            │  │  sunxi_device/sunxi_hdmi.c           │
│  lowlevel_v2x/disp_al.c      │  │     ↓ 标准encoder/connector          │
│  lowlevel_v2x/de_rtmx.c      │  │  sunxi_device/hardware/lowlevel_de/  │
│                              │  │  sunxi_device/hardware/lowlevel_tcon/│
└──────────────────────────────┘  └──────────────────────────────────────┘
```

```plaintext
用户 ioctl(DISP_LAYER_SET_CONFIG)
    └── disp_manager->apply()         ← 立即写配置到shadow寄存器
         └── 中断触发 FRAME_END
              └── DRV_disp_int_process()
                   └── tasklet → disp_composer_proc()
                        ├── unmap旧dmabuf
                        ├── disp_al_manager_apply()  ← 真正刷新HW
                        └── update_timeline()         ← fence通知
```

```plaintext
用户 DRM_IOCTL_MODE_ATOMIC
    └── drm_atomic_helper_check()     ← 验证整体状态合法性
         └── sunxi_drm_atomic_helper_commit()
              └── drm_atomic_helper_commit_tail()
                   ├── commit_modeset_disables()
                   ├── commit_modeset_enables()
                   ├── commit_planes()             ← 批量提交所有Plane
                   └── drm_atomic_helper_fake_vblank()
                        └── vblank IRQ → drm_crtc_send_vblank_event()
                             └── fence signal / flip_done completion
```

```plaintext
disp_al.c           ← 统一AL接口（单一入口）
  ├── de_rtmx.c     ← DE RealTime Mixer（图层混合）
  ├── de_enhance.c  ← 增强（FCC/FCE/LTI/PEAK/ASE）
  ├── de_smbl.c     ← 智能背光
  ├── de_wb.c       ← WriteBack回写
  ├── de_lcd.c      ← TCON寄存器（LCD时序）
  └── de_clock.c    ← 时钟管理
```

```plaintext
sunxi_de.c          ← DE顶层管理（component设备）
  ├── de_channel.c  ← 通道管理（每个Plane对应一个channel）
  ├── de_frontend.c ← 前端处理（缩放/格式转换）
  ├── de_backend.c  ← 后端处理（CSC/Gamma/Dither/BCSH）
  ├── de_top.c      ← DE顶层控制（时钟/路由）
  ├── ovl/          ← Overlay混合器
  ├── scaler/       ← 缩放器
  ├── csc/          ← 色彩空间转换
  ├── gamma/        ← Gamma校正
  ├── fcm/          ← 色彩管理
  ├── smbl/         ← 智能背光
  └── wb/           ← WriteBack
```

```c
// dev_disp.c / disp_display.c: 手动逐一初始化
bsp_disp_init()
  ├── disp_init_lcd()    // 直接调用
  ├── disp_init_hdmi()   // 直接调用
  ├── disp_init_edp()    // 直接调用
  └── disp_init_mgr()    // 直接调用
```

```c
// sunxi_drm_drv.c: 声明依赖组件
static struct platform_driver sunxi_de_platform_driver;
static struct platform_driver sunxi_tcon_platform_driver;
static struct platform_driver sunxi_hdmi_platform_driver;
// ...

// component_master_add_with_match() 等待所有组件就绪后
// 统一调用 drm_dev_register()
```

```c
// 私有结构体，通过ioctl从用户空间拷贝
struct disp_layer_config2 {
    struct disp_layer_info2 info;
    bool enable;
    unsigned int channel;
    unsigned int layer_id;
};
// 用户直接填充私有结构传入内核
ioctl(fd, DISP_LAYER_SET_CONFIG2, &lyr_cfg2);
```

```c
// 标准drm_property，通过KMS属性系统传递
struct sunxi_drm_private {
    struct drm_property *prop_eotf;
    struct drm_property *prop_color_space;
    struct drm_property *prop_color_format;
    struct drm_property *prop_color_depth;
    struct drm_property *prop_backend_data;  // blob属性
    struct drm_property *prop_frontend_data; // blob属性
    // ...
};
// 用户通过标准DRM property接口设置，框架保证原子性
```

```plaintext
┌─────────────────────────────────────────────────────────────────┐
│                         设计哲学对比                              │
├──────────────────────────┬──────────────────────────────────────┤
│         DISP2            │              DRM                      │
├──────────────────────────┼──────────────────────────────────────┤
│ 命令式（Imperative）      │ 声明式（Declarative）                 │
│ "告诉驱动做什么"           │ "告诉驱动期望的状态是什么"             │
├──────────────────────────┼──────────────────────────────────────┤
│ 私有接口                  │ 标准接口                              │
│ 全志自定义ioctl            │ 
```

---

**User**

 继续

---

**Cursor**

继续完成对比分析的剩余部分：

---

### 三、设计哲学总结（续）

```
┌─────────────────────────────────────────────────────────────────────┐
│                          设计哲学对比                                 │
├───────────────────────────┬─────────────────────────────────────────┤
│          DISP2            │               DRM                        │
├───────────────────────────┼─────────────────────────────────────────┤
│ 命令式（Imperative）       │ 声明式（Declarative）                    │
│ "告诉驱动做什么"            │ "告诉驱动期望的状态是什么"               │
├───────────────────────────┼─────────────────────────────────────────┤
│ 私有接口                   │ 标准接口                                 │
│ 全志自定义 ioctl            │ Linux KMS 标准 ioctl                    │
├───────────────────────────┼─────────────────────────────────────────┤
│ 单一驱动单体架构            │ component 框架，松耦合微内核式           │
│ probe 内手动串行初始化      │ 各子设备独立 platform_driver 动态绑定   │
├───────────────────────────┼─────────────────────────────────────────┤
│ 平台差异靠编译宏隔离        │ 平台差异靠设备树 + component 动态绑定   │
│ #ifdef DE_VERSION_V33X     │ DT compatible → 对应 lowlevel 实现      │
├───────────────────────────┼─────────────────────────────────────────┤
│ 中断 → tasklet → 回调      │ 中断 → vblank event → fence signal      │
│ 自研 fence/timeline 机制   │ 复用内核标准 sync_file / dma-fence      │
├───────────────────────────┼─────────────────────────────────────────┤
│ 图层配置逐帧命令式下发      │ 原子状态机：check → commit → cleanup    │
│ 部分图层失败不影响其他      │ 整体事务：全部成功或全部回滚            │
├───────────────────────────┼─────────────────────────────────────────┤
│ fbdev 原生支持              │ DRM fbdev emulation 兼容层              │
├───────────────────────────┼─────────────────────────────────────────┤
│ 面向嵌入式/快速启动优化     │ 面向通用 Linux 生态兼容性优化           │
└───────────────────────────┴─────────────────────────────────────────┘
```

---

### 四、硬件分层对比

```
DISP2 硬件层次（扁平化）              DRM 硬件层次（功能模块化）
─────────────────────────            ──────────────────────────────
disp_al.c  ← 单一总入口              sunxi_de.c ← DE顶层（component设备）
  │                                    ├── de_channel.c   ←→ drm_plane
  ├── de_rtmx.c (RTMX混合)            │    ├── de_frontend.c（缩放/格式）
  ├── de_enhance.c (图像增强)          │    │    ├── scaler/
  ├── de_smbl.c (智能背光)            │    │    ├── fmt/
  ├── de_wb.c (WriteBack)             │    │    └── afbd/（AFBC压缩）
  ├── de_lcd.c (TCON时序)             │    └── ovl/（混合叠加）
  └── de_clock.c (时钟)               │
                                       └── de_backend.c  ←→ drm_crtc
sunxi_tcon.c（集成于disp2/lcd/）            ├── csc/（色彩空间）
  └── de_dsi.c, de_lcd.c              │    ├── gamma/
                                       │    ├── fcm/（色彩管理）
                                       │    ├── dci/（动态对比）
                                       │    ├── smbl/
                                       │    └── wb/
                                       │
                                       sunxi_tcon.c（独立 component）
                                         ├── lowlevel_tcon/
                                         └── lowlevel_lcd/（DSI/LVDS/RGB）
```

---

### 五、关键技术路线差异深析

#### 5.1 原子提交 vs 命令式提交

DISP2 存在一个根本性问题：**图层配置与显示输出不是原子的**。当应用同时修改多个图层时，可能在某帧中看到部分图层是新配置、部分是旧配置的"撕裂"中间态。

DRM 的 `drm_atomic_state` 将所有 CRTC/Plane/Connector 的状态打包为一个事务：

```
atomic_check()   ← 验证：新状态合法吗？硬件能支持吗？
    ↓ 通过
atomic_commit()  ← 提交：全部更新，或因错误全部回滚
    ↓
vblank 边界生效  ← 保证用户看到的永远是完整一帧的状态
```

#### 5.2 WriteBack（回写）支持方式

| | DISP2 | DRM |
|---|---|---|
| 实现 | `disp_capture.c` + `disp_rtwb.c` | `drm_writeback_connector`（标准WB接口） |
| 用户接口 | 私有ioctl `DISP_CAPTURE_START` | 标准 `DRM_MODE_CONNECTOR_WRITEBACK` |
| 同步 | 自研 timeline | `drm_writeback_signal_completion()` |

#### 5.3 多屏/异步显示

DISP2 通过 `g_disp_drv.mgr[N]` 数组直接管理多屏，屏间逻辑完全由驱动自己实现。

DRM 中每个独立显示路径都是一个 `drm_crtc`，`drm_atomic_state` 天然支持多 CRTC 的同步提交（`DRM_MODE_ATOMIC_NONBLOCK`），主线内核的 `drm_vblank` 框架统一处理各屏 vblank 时序。

---

### 六、生态兼容性与演进路径

```
DISP2                               DRM
  │                                   │
  ├── 只支持全志自己的 HAL             ├── 兼容 Mesa 

```plaintext
┌─────────────────────────────────────────────────────────────────────┐
│                          设计哲学对比                                 │
├───────────────────────────┬─────────────────────────────────────────┤
│          DISP2            │               DRM                        │
├───────────────────────────┼─────────────────────────────────────────┤
│ 命令式（Imperative）       │ 声明式（Declarative）                    │
│ "告诉驱动做什么"            │ "告诉驱动期望的状态是什么"               │
├───────────────────────────┼─────────────────────────────────────────┤
│ 私有接口                   │ 标准接口                                 │
│ 全志自定义 ioctl            │ Linux KMS 标准 ioctl                    │
├───────────────────────────┼─────────────────────────────────────────┤
│ 单一驱动单体架构            │ component 框架，松耦合微内核式           │
│ probe 内手动串行初始化      │ 各子设备独立 platform_driver 动态绑定   │
├───────────────────────────┼─────────────────────────────────────────┤
│ 平台差异靠编译宏隔离        │ 平台差异靠设备树 + component 动态绑定   │
│ #ifdef DE_VERSION_V33X     │ DT compatible → 对应 lowlevel 实现      │
├───────────────────────────┼─────────────────────────────────────────┤
│ 中断 → tasklet → 回调      │ 中断 → vblank event → fence signal      │
│ 自研 fence/timeline 机制   │ 复用内核标准 sync_file / dma-fence      │
├───────────────────────────┼─────────────────────────────────────────┤
│ 图层配置逐帧命令式下发      │ 原子状态机：check → commit → cleanup    │
│ 部分图层失败不影响其他      │ 整体事务：全部成功或全部回滚            │
├───────────────────────────┼─────────────────────────────────────────┤
│ fbdev 原生支持              │ DRM fbdev emulation 兼容层              │
├───────────────────────────┼─────────────────────────────────────────┤
│ 面向嵌入式/快速启动优化     │ 面向通用 Linux 生态兼容性优化           │
└───────────────────────────┴─────────────────────────────────────────┘
```

```plaintext
DISP2 硬件层次（扁平化）              DRM 硬件层次（功能模块化）
─────────────────────────            ──────────────────────────────
disp_al.c  ← 单一总入口              sunxi_de.c ← DE顶层（component设备）
  │                                    ├── de_channel.c   ←→ drm_plane
  ├── de_rtmx.c (RTMX混合)            │    ├── de_frontend.c（缩放/格式）
  ├── de_enhance.c (图像增强)          │    │    ├── scaler/
  ├── de_smbl.c (智能背光)            │    │    ├── fmt/
  ├── de_wb.c (WriteBack)             │    │    └── afbd/（AFBC压缩）
  ├── de_lcd.c (TCON时序)             │    └── ovl/（混合叠加）
  └── de_clock.c (时钟)               │
                                       └── de_backend.c  ←→ drm_crtc
sunxi_tcon.c（集成于disp2/lcd/）            ├── csc/（色彩空间）
  └── de_dsi.c, de_lcd.c              │    ├── gamma/
                                       │    ├── fcm/（色彩管理）
                                       │    ├── dci/（动态对比）
                                       │    ├── smbl/
                                       │    └── wb/
                                       │
                                       sunxi_tcon.c（独立 component）
                                         ├── lowlevel_tcon/
                                         └── lowlevel_lcd/（DSI/LVDS/RGB）
```

```plaintext
atomic_check()   ← 验证：新状态合法吗？硬件能支持吗？
    ↓ 通过
atomic_commit()  ← 提交：全部更新，或因错误全部回滚
    ↓
vblank 边界生效  ← 保证用户看到的永远是完整一帧的状态
```

```plaintext
DISP2                               DRM
  │                                   │
  ├── 只支持全志自己的 HAL             ├── 兼容 Mesa 
```

---

**User**

帮我对比分析一下DRM如何将DISP中的部分细致化的，具体对比
举个例子：比如DISP中的layer/channel和DRM的panel的关系等等

---

**Cursor**

现在已有足够信息，可以做详细的细粒度对比分析了。

---

## DISP2 vs DRM 细粒度概念映射对比分析

### 一、Layer/Channel → drm_plane 的映射关系

这是最核心的差异，值得深入展开。

#### DISP2 的 Layer/Channel 模型

DISP2 中硬件概念是**二级结构**：

```
disp (屏N)
  └── channel 0   ← 一个硬件混合通道
        ├── layer 0   ← 通道内图层0（主图层，有缩放器）
        ├── layer 1   ← 通道内图层1（无独立缩放）
        ├── layer 2
        └── layer 3
  └── channel 1
        ├── layer 0
        └── ...
  └── channel N...
```

用户配置时需要同时指定三个维度：

```c
// DISP2: 三元组寻址
struct disp_layer_id {
    unsigned int disp;      // 第几块屏
    unsigned int channel;   // 第几个通道
    unsigned int layer_id;  // 通道内第几个图层
    unsigned int type;      // 1:layer, 2:trd(3D), 4:atw
};

// 用户必须手动管理 channel/layer 分配
struct disp_layer_config2 lyr_cfg2[MAX_LAYERS];
// 填写 lyr_cfg2[i].info.channel = 0;
// 填写 lyr_cfg2[i].info.id = 0;
ioctl(fd, DISP_LAYER_SET_CONFIG2, lyr_cfg2);
```

#### DRM 的 Plane/Channel 模型

DRM 将 channel 直接抽象为 `drm_plane`，channel 内的多个 layer 作为 plane 的**扩展属性**（blob property）：

```c
// DRM: 一个 channel = 一个 drm_plane
struct sunxi_drm_plane {
    struct drm_plane plane;          // 标准DRM plane
    struct de_channel_handle *hdl;   // 对应一个硬件channel
    unsigned int index;              // channel编号
    unsigned int layer_cnt;          // 该channel内layer数量（最多4个）
    struct sunxi_drm_crtc *crtc;
};

// channel内的多个layer通过扩展state管理
struct display_channel_state {
    struct drm_plane_state base;         // 标准plane state（对应layer0）
    unsigned int layer_id;               // 激活哪个layer
    // layer1~3 的属性作为扩展字段
    u16   alpha[MAX_LAYER_NUM_PER_CHN - 1];       // layer1~3 alpha
    uint32_t src_x[MAX_LAYER_NUM_PER_CHN - 1];   // layer1~3 源区域
    uint32_t crtc_x[MAX_LAYER_NUM_PER_CHN - 1];  // layer1~3 目标区域
    uint32_t fb_id[MAX_LAYER_NUM_PER_CHN - 1];   // layer1~3 帧缓冲
    // ...
};
```

**对应关系一览**：

```
DISP2                          DRM
─────────────────────          ──────────────────────────────────
channel 0 (4 layers)    ←→    sunxi_drm_plane[0] (PRIMARY)
  layer 0 (主图层)       ←→      drm_plane_state.base (fb/src/crtc rect)
  layer 1               ←→      display_channel_state.src_x/fb_id[0]
  layer 2               ←→      display_channel_state.src_x/fb_id[1]
  layer 3               ←→      display_channel_state.src_x/fb_id[2]

channel 1 (4 layers)    ←→    sunxi_drm_plane[1] (OVERLAY)
channel 2               ←→    sunxi_drm_plane[2] (OVERLAY)
...
```

**DRM 的提升点**：DISP2 用户必须自己管理 channel/layer 分配，容易出错；DRM 用户只操作标准 `drm_plane`，内核自动映射到硬件 channel，用户无需感知底层结构。

---

### 二、DE 图像处理流水线对比

#### DISP2 的处理流水（扁平化）

```
disp_al_layer_cfg()     ← 一个函数配置所有：OVL/scaler/enhance
    └── de_rtmx.c       ← RTMX统一处理混合+缩放
    └── de_enhance.c    ← 统一增强（FCC/FCE/LTI/PEAK全在一起）
```

配置路径是**命令式、顺序调用**，没有明确的流水线阶段划分。

#### DRM 的处理流水（模块化流水线）

`de_channel.c` 的注释精确描述了硬件流水线：

```
channel N:
  +-- ovl --+
  +- afbc --+-- SNR -- scaler -- frontend
  +- tfbc --+

frontend 内部：
  CSC_2 -- SHARP -- CDC -- DCI -- FCM -- CSC_1
```

对应到代码模块：

```
de_channel.c
  ├── de_ovl       (ovl/)       ← Overlay混合，对应DISP2的de_rtmx图层混合部分
  ├── de_afbd      (afbd/)      ← AFBC压缩帧缓冲解码（DISP2无独立模块）
  ├── de_tfbd      (tfbd/)      ← TFBC压缩帧缓冲解码（DISP2无独立模块）
  ├── de_scaler    (scaler/)    ← 缩放器，对应DISP2的de_vsu/de_gsu
  └── de_frontend  (frontend)   ← 前端增强流水线
       ├── snr/    (SNR)        ← 降噪，DISP2无单独抽象
       ├── sharp/  (SHARP)      ← 锐化，对应DISP2 de_enhance中的LTI/PEAK
       ├── cdc/    (CDC)        ← 色彩细节增强
       ├── dci/    (DCI)        ← 动态对比度增强，对应DISP2的de_fce/de_bws
       ├── fcm/    (FCM)        ← 色彩管理，对应DISP2的de_fcc
       └── csc/    (CSC)        ← 色彩空间转换，对应DISP2的de_ccsc/de_dcsc

de_backend.c                    ← CRTC级后端（每屏一个，非每channel）
  ├── gamma/                    ← Gamma校正（DISP2无独立gamma模块）
  ├── dither/                   ← 抖动处理
  ├── deband/                   ← 去色带
  ├── smbl/                     ← 智能背光，对应DISP2的de_smbl
  └── csc/                      ← 输出CSC（DISP2的de_dcsc）
```

**关键差异**：DRM 将 DISP2 `de_enhance.c` 中**混在一起的所有图像增强**拆分为独立的硬件子模块，每个模块有自己的 `create/apply/update_regs` 生命周期，职责清晰，可独立使能/禁用。

---

### 三、Panel/LCD 驱动对比

#### DISP2 的 Panel 模型

```c
// disp2/disp/lcd/panels.h
struct __lcd_panel {
    char name[32];
    struct disp_lcd_panel_fun func;  // 函数表：直接操作GPIO/寄存器
};

// 函数表：全志私有回调
struct disp_lcd_panel_fun {
    void (*cfg_panel_info)(struct panel_extend_para *);
    s32  (*cfg_open_flow)(u32 sel);   // 开屏时序序列
    s32  (*cfg_close_flow)(u32 sel);  // 关屏时序序列
    s32  (*lcd_user_defined_func)(u32 sel, u32 para1, ...);
};

// 驱动注册：静态数组
extern struct __lcd_panel *panel_array[];
// LCD驱动直接调用 LCD_OPEN_FUNC/LCD_CLOSE_FUNC 注册时序步骤
```

每个屏型号（如 `ili9881c.c`、`jd9366ab_3.c`）实现上述函数表，**直接耦合到全志DISP2框架**，无法在其他平台复用。

#### DRM 的 Panel 模型

```c
// drm/panel/panel-dsi.h: 基于标准 drm_panel 框架
struct panel_dsi {
    struct drm_panel panel;          // Linux标准drm_panel基类
    struct mipi_dsi_device *dsi;     // 标准MIPI DSI设备

    struct panel_desc *desc;         // 纯数据描述（时序/初始化序列）
    struct regulator *supply[10];    // 标准regulator框架
    struct gpio_desc *reset_gpio;    // 标准GPIO框架

    struct panel_dsi_helper_funcs *funcs;  // 可选扩展回调
};

// 初始化序列：数据驱动，从DTS/二进制描述加载
struct panel_cmd_seq {
    struct panel_cmd_desc *cmds;   // 命令序列（纯数据）
    unsigned int cmd_cnt;
};

struct reset_sequence {
    u32 items;
    struct gpio_timing *timing;    // 复位时序（纯数据）
};
```

**对应关系**：

```
DISP2                              DRM
─────────────────────────          ─────────────────────────────────────
disp_lcd_panel_fun.cfg_open_flow   panel_dsi.desc->rst_on_seq (数据驱动)
LCD_OPEN_FUNC() 注册时序步骤        drm_panel_prepare() / drm_panel_enable()
panel_array[] 静态数组注册          compatible = "vendor,model" DTS匹配
GPIO直接操作（全志私有API）          gpiod_set_value()（标准GPIO descriptor API）
私有背光控制                        drm_panel.backlight (标准drm_backlight)
```

**关键提升**：DRM panel 驱动基于 `drm_panel` 标准基类，可直接复用 mainline 中其他厂商的 panel 驱动；时序参数从 DTS 加载，无需重新编译内核。DISP2 的 panel 驱动与全志框架强绑定，无法移植。

---

### 四、输出设备（LCD/HDMI/eDP）对比

```
DISP2                              DRM
─────────────────────────────      ──────────────────────────────────────
disp_device                        drm_encoder + drm_connector (分离)
  

```plaintext
disp (屏N)
  └── channel 0   ← 一个硬件混合通道
        ├── layer 0   ← 通道内图层0（主图层，有缩放器）
        ├── layer 1   ← 通道内图层1（无独立缩放）
        ├── layer 2
        └── layer 3
  └── channel 1
        ├── layer 0
        └── ...
  └── channel N...
```

```c
// DISP2: 三元组寻址
struct disp_layer_id {
    unsigned int disp;      // 第几块屏
    unsigned int channel;   // 第几个通道
    unsigned int layer_id;  // 通道内第几个图层
    unsigned int type;      // 1:layer, 2:trd(3D), 4:atw
};

// 用户必须手动管理 channel/layer 分配
struct disp_layer_config2 lyr_cfg2[MAX_LAYERS];
// 填写 lyr_cfg2[i].info.channel = 0;
// 填写 lyr_cfg2[i].info.id = 0;
ioctl(fd, DISP_LAYER_SET_CONFIG2, lyr_cfg2);
```

```c
// DRM: 一个 channel = 一个 drm_plane
struct sunxi_drm_plane {
    struct drm_plane plane;          // 标准DRM plane
    struct de_channel_handle *hdl;   // 对应一个硬件channel
    unsigned int index;              // channel编号
    unsigned int layer_cnt;          // 该channel内layer数量（最多4个）
    struct sunxi_drm_crtc *crtc;
};

// channel内的多个layer通过扩展state管理
struct display_channel_state {
    struct drm_plane_state base;         // 标准plane state（对应layer0）
    unsigned int layer_id;               // 激活哪个layer
    // layer1~3 的属性作为扩展字段
    u16   alpha[MAX_LAYER_NUM_PER_CHN - 1];       // layer1~3 alpha
    uint32_t src_x[MAX_LAYER_NUM_PER_CHN - 1];   // layer1~3 源区域
    uint32_t crtc_x[MAX_LAYER_NUM_PER_CHN - 1];  // layer1~3 目标区域
    uint32_t fb_id[MAX_LAYER_NUM_PER_CHN - 1];   // layer1~3 帧缓冲
    // ...
};
```

```plaintext
DISP2                          DRM
─────────────────────          ──────────────────────────────────
channel 0 (4 layers)    ←→    sunxi_drm_plane[0] (PRIMARY)
  layer 0 (主图层)       ←→      drm_plane_state.base (fb/src/crtc rect)
  layer 1               ←→      display_channel_state.src_x/fb_id[0]
  layer 2               ←→      display_channel_state.src_x/fb_id[1]
  layer 3               ←→      display_channel_state.src_x/fb_id[2]

channel 1 (4 layers)    ←→    sunxi_drm_plane[1] (OVERLAY)
channel 2               ←→    sunxi_drm_plane[2] (OVERLAY)
...
```

```plaintext
disp_al_layer_cfg()     ← 一个函数配置所有：OVL/scaler/enhance
    └── de_rtmx.c       ← RTMX统一处理混合+缩放
    └── de_enhance.c    ← 统一增强（FCC/FCE/LTI/PEAK全在一起）
```

```plaintext
channel N:
  +-- ovl --+
  +- afbc --+-- SNR -- scaler -- frontend
  +- tfbc --+

frontend 内部：
  CSC_2 -- SHARP -- CDC -- DCI -- FCM -- CSC_1
```

```plaintext
de_channel.c
  ├── de_ovl       (ovl/)       ← Overlay混合，对应DISP2的de_rtmx图层混合部分
  ├── de_afbd      (afbd/)      ← AFBC压缩帧缓冲解码（DISP2无独立模块）
  ├── de_tfbd      (tfbd/)      ← TFBC压缩帧缓冲解码（DISP2无独立模块）
  ├── de_scaler    (scaler/)    ← 缩放器，对应DISP2的de_vsu/de_gsu
  └── de_frontend  (frontend)   ← 前端增强流水线
       ├── snr/    (SNR)        ← 降噪，DISP2无单独抽象
       ├── sharp/  (SHARP)      ← 锐化，对应DISP2 de_enhance中的LTI/PEAK
       ├── cdc/    (CDC)        ← 色彩细节增强
       ├── dci/    (DCI)        ← 动态对比度增强，对应DISP2的de_fce/de_bws
       ├── fcm/    (FCM)        ← 色彩管理，对应DISP2的de_fcc
       └── csc/    (CSC)        ← 色彩空间转换，对应DISP2的de_ccsc/de_dcsc

de_backend.c                    ← CRTC级后端（每屏一个，非每channel）
  ├── gamma/                    ← Gamma校正（DISP2无独立gamma模块）
  ├── dither/                   ← 抖动处理
  ├── deband/                   ← 去色带
  ├── smbl/                     ← 智能背光，对应DISP2的de_smbl
  └── csc/                      ← 输出CSC（DISP2的de_dcsc）
```

```c
// disp2/disp/lcd/panels.h
struct __lcd_panel {
    char name[32];
    struct disp_lcd_panel_fun func;  // 函数表：直接操作GPIO/寄存器
};

// 函数表：全志私有回调
struct disp_lcd_panel_fun {
    void (*cfg_panel_info)(struct panel_extend_para *);
    s32  (*cfg_open_flow)(u32 sel);   // 开屏时序序列
    s32  (*cfg_close_flow)(u32 sel);  // 关屏时序序列
    s32  (*lcd_user_defined_func)(u32 sel, u32 para1, ...);
};

// 驱动注册：静态数组
extern struct __lcd_panel *panel_array[];
// LCD驱动直接调用 LCD_OPEN_FUNC/LCD_CLOSE_FUNC 注册时序步骤
```

```c
// drm/panel/panel-dsi.h: 基于标准 drm_panel 框架
struct panel_dsi {
    struct drm_panel panel;          // Linux标准drm_panel基类
    struct mipi_dsi_device *dsi;     // 标准MIPI DSI设备

    struct panel_desc *desc;         // 纯数据描述（时序/初始化序列）
    struct regulator *supply[10];    // 标准regulator框架
    struct gpio_desc *reset_gpio;    // 标准GPIO框架

    struct panel_dsi_helper_funcs *funcs;  // 可选扩展回调
};

// 初始化序列：数据驱动，从DTS/二进制描述加载
struct panel_cmd_seq {
    struct panel_cmd_desc *cmds;   // 命令序列（纯数据）
    unsigned int cmd_cnt;
};

struct reset_sequence {
    u32 items;
    struct gpio_timing *timing;    // 复位时序（纯数据）
};
```

```plaintext
DISP2                              DRM
─────────────────────────          ─────────────────────────────────────
disp_lcd_panel_fun.cfg_open_flow   panel_dsi.desc->rst_on_seq (数据驱动)
LCD_OPEN_FUNC() 注册时序步骤        drm_panel_prepare() / drm_panel_enable()
panel_array[] 静态数组注册          compatible = "vendor,model" DTS匹配
GPIO直接操作（全志私有API）          gpiod_set_value()（标准GPIO descriptor API）
私有背光控制                        drm_panel.backlight (标准drm_backlight)
```

```plaintext
DISP2                              DRM
─────────────────────────────      ──────────────────────────────────────
disp_device                        drm_encoder + drm_connector (分离)
  
```

---

**User**

请你结合具体的例子，比如缩放的IOCTL，解释一下DISP和DRM的处理方式的异同

---

**Cursor**

现在已经有了足够的代码细节，可以做一个深入具体的缩放处理对比分析了。

---

## 以"图层缩放"为例：DISP2 vs DRM 处理方式全链路对比

### 一、用户接口层对比

#### DISP2：私有 ioctl 命令式配置

```c
// 用户空间调用（来自 dev_disp.c ioctl 分发）
// 步骤1：填充私有结构体（用户必须手动指定 channel/layer）
struct disp_layer_config2 cfg = {
    .channel  = 0,           // 必须手动选 channel
    .layer_id = 0,           // 必须手动选 layer
    .enable   = 1,
    .info = {
        .fb = {
            .addr = { phy_addr },
            .format = DISP_FORMAT_YUV420_SP_UVUV,
            // 源裁剪区域（定点数，<<32）
            .crop = {
                .x = 0, .y = 0,
                .width  = (u64)1920 << 32,
                .height = (u64)1080 << 32,
            },
        },
        // 目标显示区域（直接像素坐标）
        .screen_win = { .x=0, .y=0, .width=1280, .height=720 },
        .zorder = 0,
        .alpha_mode = 1,
        .alpha_value = 0xff,
    },
};
// 步骤2：一个 ioctl 下发，内核立即处理
ioctl(fd, DISP_LAYER_SET_CONFIG2, &cfg);
```

**内核收到后立即进入处理链**（无原子检查）：

```
ioctl(DISP_LAYER_SET_CONFIG2)
  └── disp_mgr_set_layer_config2()        [de/disp_manager.c]
       └── mgr->set_layer_config2()
            └── disp_al_layer_cfg()        [lowlevel_v2x/disp_al.c]
                 └── 下一帧 Vsync 中断时
                      └── disp_al_manager_apply()
                           └── de_rtmx_calc_chn_scale()  ← 计算缩放参数
```

---

#### DRM：标准 KMS 原子提交

```c
// 用户空间调用（libdrm 标准接口）
// 步骤1：无需关心 channel，只需操作 plane
drmModeAtomicAddProperty(req, plane_id,
    prop_src_x,    0);               // 源区域（16.16定点数）
drmModeAtomicAddProperty(req, plane_id,
    prop_src_y,    0);
drmModeAtomicAddProperty(req, plane_id,
    prop_src_w,    1920 << 16);      // 标准KMS格式
drmModeAtomicAddProperty(req, plane_id,
    prop_src_h,    1080 << 16);
drmModeAtomicAddProperty(req, plane_id,
    prop_crtc_x,   0);               // 目标区域（整像素）
drmModeAtomicAddProperty(req, plane_id,
    prop_crtc_y,   0);
drmModeAtomicAddProperty(req, plane_id,
    prop_crtc_w,   1280);
drmModeAtomicAddProperty(req, plane_id,
    prop_crtc_h,   720);
drmModeAtomicAddProperty(req, plane_id,
    prop_fb_id,    fb_id);

// 步骤2：原子提交（可非阻塞）
drmModeAtomicCommit(fd, req, DRM_MODE_ATOMIC_NONBLOCK, NULL);
```

**内核原子状态机处理链**：

```
DRM_IOCTL_MODE_ATOMIC
  └── drm_atomic_helper_check()          ← 先验证整体合法性
       └── sunxi_drm_atomic_helper_commit()
            └── drm_atomic_helper_commit_planes()
                 └── sunxi_crtc_atomic_flush()
                      └── de_channel_update()     [lowlevel_de/de_channel.c]
                           ├── de_rtmx_chn_scale_attr()   ← 计算缩放参数
                           ├── de_rtmx_chn_fix_size()     ← HW能力校正
                           └── de_scaler_apply()           ← 写缩放寄存器
```

---

### 二、缩放参数计算逻辑对比

#### DISP2 的缩放计算（`lowlevel_v2x/de_rtmx.c`）

DISP2 的缩放计算**集中在 `de_rtmx.c` 一个文件中**，输入是全志私有结构体：

```c
// 输入：disp_layer_config2 转换后的内部结构
//   ovl_win  = 源图像区域（经OVL混合后的尺寸）
//   scn_win  = 目标屏幕区域

// 缩放判断：源尺寸 == 目标尺寸 → 不开缩放
if (ovl_win.w == scn_win.w && ovl_win.h == scn_win.h)
    scale_en = 0;
else
    scale_en = 1;

// 计算步长（step = src/dst，16.16 定点数）
ypara.hstep = (ovl_win.w << 16) / scn_win.w;
ypara.vstep = (ovl_win.h << 16) / scn_win.h;
// YUV色度分量单独计算（采样率不同）
cpara.hstep = ypara.hstep * yuv_hfactor;
cpara.vstep = ypara.vstep * yuv_vfactor;
```

缩放和图层混合、格式转换**混合在同一函数 `de_rtmx_chn_cfg()`** 里，难以单独测试和替换。

---

#### DRM 的缩放计算（`lowlevel_de/de_channel.c`）

DRM 将缩放拆为**独立的三步流水**，每步职责清晰：

**第一步：`de_rtmx_chn_scale_attr()` — 计算理想缩放窗口**

```c
// 从标准 drm_plane_state 读取（src 是 16.16 定点数）
crop64.left   = (state->base.src_x >> 16) << 32; // 转为 32.32
crop64.width  = (state->base.src_w >> 16) << 32;
// 处理旋转：90/270度时宽高互换
if (rotation & DRM_MODE_ROTATE_90 || rotation & DRM_MODE_ROTATE_270) {
    crop64.width  = state->base.src_h >> 16 << 32;
    crop64.height = state->base.src_w >> 16 << 32;
}
// 目标窗口直接来自 crtc_x/crtc_w（整像素）
lay_scn_win.left  = state->base.crtc_x;
lay_scn_win.width = state->base.crtc_w;

// 调用专用缩放计算器，计算每层的 ovl 输入坐标
de_scaler_calc_lay_scale_para(scaler,
    &cal_lay_cfg, &crop64, &lay_scn_win,
    &crop32[i], &ypara[i], &cpara[i]);
```

**第二步：`de_rtmx_chn_fix_size()` — 硬件能力校正（DISP2 无此机制）**

```c
// DRM 独有：检查 DE 处理性能是否足以支撑此缩放比
// 计算：源像素数 × 像素时钟 ÷ 效率 vs 刷新带宽
frame_pixel_process_required_time =
    ovl_win.width * ovl_win.height * dclk_khz * 100 / efficiency(90%);
refresh_zone_time =
    htotal * scn_win.height * de_freq_khz;

if (required > available) {
    // 自动裁减输入高度以适配硬件能力
    *fix_height = ovl_win.height * refresh_zone_time / required;
    return RTMX_CUT_INHEIGHT;  // 通知上层已修正
}

// 同时检查最小/最大缩放比限制
de_scaler_fix_tiny_size();   // 防止缩放比过小
de_scaler_fix_big_size();    // 防止缩放比过大
```

**第三步：`de_scaler_apply()` — 写入硬件寄存器**

```c
// 独立的 scaler 模块，只负责写寄存器
de_scaler_calc_scale_para(hdl, fix_size_result,
    px_fmt_space, yuv_sampling,
    &scn_win, &ovl_out_win, &c_win,
    &ovl_ypara, &ovl_cpara);
// 调用专用 de_scaler_apply() 写 VSU/GSU 硬件寄存器
```

---

### 三、缩放与后续流水线衔接对比

```
DISP2 缩放后的数据流：
  de_rtmx（混合+缩放）→ de_enhance（增强，统一入口）→ TCON 输出
  [所有步骤在一个函数调用链中串行完成，无明确阶段边界]

DRM 缩放后的数据流：
  ovl（混合）→ [AFBC/TFBC解码] → SNR（降噪）→ scaler（缩放）
    → frontend（per-channel增强流水线）
         └── CSC_2 → SHARP → CDC → DCI → FCM → CSC_1
    → backend（per-CRTC后处理）
         └── gamma → dither → deband → SMBL → 输出CSC
    → TCON 输出
  [每个阶段独立 apply/update_regs，可单独 enable/disable]
```

---

### 四、格式转换（drm_to_de_format）对比

这是 DRM 代码中最直观的一个**显式映射层**，DISP2 没有：

```c
// DRM de_channel.c: 标准 DRM fourcc → 全志 DE 内部格式 显式转换
int drm_to_de_format(uint32_t format) {
    switch (format) {
    case DRM_FORMAT_ARGB8888:  return DE_FORMAT_ARGB_8888;
    case DRM_FORMAT_NV12:      return DE_FORMAT_YUV420_SP_UVUV;
    case DRM_FORMAT_P010:      return DE_FORMAT_YUV420_SP_UVUV_10BIT;
    // ... 覆盖所有标准 DRM 格式
    }
}
```

DISP2 直接在私有 ioctl 结构体中使用 `DISP_FORMAT_*` 全志私有枚举，用户空间必须使用全志私有头文件，无法使用标准 `DRM_FORMAT_*`。

---

### 五、总结对比表

| 维度 | DISP2（以缩放为例） | DRM（以缩放为例） |
|---|---|---|
| **用户接口** | `ioctl(DISP_LAYER_SET_CONFIG2, cfg)` 私有结构体 | `drmModeAtomicAddProperty()` 标准 KMS prop |
| **格式描述** | `DISP_FORMAT_YUV420_SP_UVUV`（全志私有） | `DRM_FORMAT_NV12`（Linux标准fourcc） |
| **channel 分配** | 

```c
// 用户空间调用（来自 dev_disp.c ioctl 分发）
// 步骤1：填充私有结构体（用户必须手动指定 channel/layer）
struct disp_layer_config2 cfg = {
    .channel  = 0,           // 必须手动选 channel
    .layer_id = 0,           // 必须手动选 layer
    .enable   = 1,
    .info = {
        .fb = {
            .addr = { phy_addr },
            .format = DISP_FORMAT_YUV420_SP_UVUV,
            // 源裁剪区域（定点数，<<32）
            .crop = {
                .x = 0, .y = 0,
                .width  = (u64)1920 << 32,
                .height = (u64)1080 << 32,
            },
        },
        // 目标显示区域（直接像素坐标）
        .screen_win = { .x=0, .y=0, .width=1280, .height=720 },
        .zorder = 0,
        .alpha_mode = 1,
        .alpha_value = 0xff,
    },
};
// 步骤2：一个 ioctl 下发，内核立即处理
ioctl(fd, DISP_LAYER_SET_CONFIG2, &cfg);
```

```plaintext
ioctl(DISP_LAYER_SET_CONFIG2)
  └── disp_mgr_set_layer_config2()        [de/disp_manager.c]
       └── mgr->set_layer_config2()
            └── disp_al_layer_cfg()        [lowlevel_v2x/disp_al.c]
                 └── 下一帧 Vsync 中断时
                      └── disp_al_manager_apply()
                           └── de_rtmx_calc_chn_scale()  ← 计算缩放参数
```

```c
// 用户空间调用（libdrm 标准接口）
// 步骤1：无需关心 channel，只需操作 plane
drmModeAtomicAddProperty(req, plane_id,
    prop_src_x,    0);               // 源区域（16.16定点数）
drmModeAtomicAddProperty(req, plane_id,
    prop_src_y,    0);
drmModeAtomicAddProperty(req, plane_id,
    prop_src_w,    1920 << 16);      // 标准KMS格式
drmModeAtomicAddProperty(req, plane_id,
    prop_src_h,    1080 << 16);
drmModeAtomicAddProperty(req, plane_id,
    prop_crtc_x,   0);               // 目标区域（整像素）
drmModeAtomicAddProperty(req, plane_id,
    prop_crtc_y,   0);
drmModeAtomicAddProperty(req, plane_id,
    prop_crtc_w,   1280);
drmModeAtomicAddProperty(req, plane_id,
    prop_crtc_h,   720);
drmModeAtomicAddProperty(req, plane_id,
    prop_fb_id,    fb_id);

// 步骤2：原子提交（可非阻塞）
drmModeAtomicCommit(fd, req, DRM_MODE_ATOMIC_NONBLOCK, NULL);
```

```plaintext
DRM_IOCTL_MODE_ATOMIC
  └── drm_atomic_helper_check()          ← 先验证整体合法性
       └── sunxi_drm_atomic_helper_commit()
            └── drm_atomic_helper_commit_planes()
                 └── sunxi_crtc_atomic_flush()
                      └── de_channel_update()     [lowlevel_de/de_channel.c]
                           ├── de_rtmx_chn_scale_attr()   ← 计算缩放参数
                           ├── de_rtmx_chn_fix_size()     ← HW能力校正
                           └── de_scaler_apply()           ← 写缩放寄存器
```

```c
// 输入：disp_layer_config2 转换后的内部结构
//   ovl_win  = 源图像区域（经OVL混合后的尺寸）
//   scn_win  = 目标屏幕区域

// 缩放判断：源尺寸 == 目标尺寸 → 不开缩放
if (ovl_win.w == scn_win.w && ovl_win.h == scn_win.h)
    scale_en = 0;
else
    scale_en = 1;

// 计算步长（step = src/dst，16.16 定点数）
ypara.hstep = (ovl_win.w << 16) / scn_win.w;
ypara.vstep = (ovl_win.h << 16) / scn_win.h;
// YUV色度分量单独计算（采样率不同）
cpara.hstep = ypara.hstep * yuv_hfactor;
cpara.vstep = ypara.vstep * yuv_vfactor;
```

```c
// 从标准 drm_plane_state 读取（src 是 16.16 定点数）
crop64.left   = (state->base.src_x >> 16) << 32; // 转为 32.32
crop64.width  = (state->base.src_w >> 16) << 32;
// 处理旋转：90/270度时宽高互换
if (rotation & DRM_MODE_ROTATE_90 || rotation & DRM_MODE_ROTATE_270) {
    crop64.width  = state->base.src_h >> 16 << 32;
    crop64.height = state->base.src_w >> 16 << 32;
}
// 目标窗口直接来自 crtc_x/crtc_w（整像素）
lay_scn_win.left  = state->base.crtc_x;
lay_scn_win.width = state->base.crtc_w;

// 调用专用缩放计算器，计算每层的 ovl 输入坐标
de_scaler_calc_lay_scale_para(scaler,
    &cal_lay_cfg, &crop64, &lay_scn_win,
    &crop32[i], &ypara[i], &cpara[i]);
```

```c
// DRM 独有：检查 DE 处理性能是否足以支撑此缩放比
// 计算：源像素数 × 像素时钟 ÷ 效率 vs 刷新带宽
frame_pixel_process_required_time =
    ovl_win.width * ovl_win.height * dclk_khz * 100 / efficiency(90%);
refresh_zone_time =
    htotal * scn_win.height * de_freq_khz;

if (required > available) {
    // 自动裁减输入高度以适配硬件能力
    *fix_height = ovl_win.height * refresh_zone_time / required;
    return RTMX_CUT_INHEIGHT;  // 通知上层已修正
}

// 同时检查最小/最大缩放比限制
de_scaler_fix_tiny_size();   // 防止缩放比过小
de_scaler_fix_big_size();    // 防止缩放比过大
```

```c
// 独立的 scaler 模块，只负责写寄存器
de_scaler_calc_scale_para(hdl, fix_size_result,
    px_fmt_space, yuv_sampling,
    &scn_win, &ovl_out_win, &c_win,
    &ovl_ypara, &ovl_cpara);
// 调用专用 de_scaler_apply() 写 VSU/GSU 硬件寄存器
```

```plaintext
DISP2 缩放后的数据流：
  de_rtmx（混合+缩放）→ de_enhance（增强，统一入口）→ TCON 输出
  [所有步骤在一个函数调用链中串行完成，无明确阶段边界]

DRM 缩放后的数据流：
  ovl（混合）→ [AFBC/TFBC解码] → SNR（降噪）→ scaler（缩放）
    → frontend（per-channel增强流水线）
         └── CSC_2 → SHARP → CDC → DCI → FCM → CSC_1
    → backend（per-CRTC后处理）
         └── gamma → dither → deband → SMBL → 输出CSC
    → TCON 输出
  [每个阶段独立 apply/update_regs，可单独 enable/disable]
```

```c
// DRM de_channel.c: 标准 DRM fourcc → 全志 DE 内部格式 显式转换
int drm_to_de_format(uint32_t format) {
    switch (format) {
    case DRM_FORMAT_ARGB8888:  return DE_FORMAT_ARGB_8888;
    case DRM_FORMAT_NV12:      return DE_FORMAT_YUV420_SP_UVUV;
    case DRM_FORMAT_P010:      return DE_FORMAT_YUV420_SP_UVUV_10BIT;
    // ... 覆盖所有标准 DRM 格式
    }
}
```

---

**User**

DISP的lowlevel和DRM的lowlevel一样吗？

---

**Cursor**

现在有了充分的对比信息，可以给出精准的回答。

---

## DISP 的 lowlevel 和 DRM 的 lowlevel 一样吗？

**答案：不一样，是两套完全独立重写的实现，但操作的是同一块硬件。**

---

### 一、关系全景图

```
同一块 DE 硬件（寄存器地址相同）
         ▲                    ▲
         │                    │
 DISP2 lowlevel          DRM lowlevel
 (disp2/disp/de/         (drm/sunxi_device/
  lowlevel_v2x/)          hardware/lowlevel_de/)
         │                    │
   扁平化设计              模块化设计
   私有接口调用            drm_plane/crtc 驱动
```

---

### 二、文件级对比（功能相同，代码不同）

| 硬件功能 | DISP2 lowlevel_v2x | DRM lowlevel_de | 关系 |
|---|---|---|---|
| **VSU/GSU 缩放器** | `de_vsu.c` / `de_gsu.c` | `scaler/de_scaler.c` | **同硬件，重新封装** |
| 缩放类型定义 | `de_vsu_type.h`（`VSU_CTRL_REG`） | `scaler/de_scaler_type.h`（`vsu8_ctl_reg`） | 寄存器 layout 相同，命名不同 |
| **OVL 图层混合** | `de_rtmx.c`（内含 OVL 逻辑） | `ovl/de_ovl.c` | **同硬件，DRM 独立拆出** |
| **图像增强** | `de_enhance.c`（全部增强在一起） | `sharp/` `dci/` `fcm/` `cdc/` `snr/`（各自独立） | **同硬件，DRM 细粒度拆分** |
| **CSC 色彩转换** | `de_ccsc.c` / `de_dcsc.c` | `csc/de_csc.c` | **同硬件，重新封装** |
| **SmBL 智能背光** | `de_smbl.c` | `smbl/de_smbl.c` | **同硬件，两套独立实现** |
| **WriteBack** | `de_wb.c` | `wb/de_wb.c` | **同硬件，两套独立实现** |
| **TCON/DSI** | `de_lcd.c` / `de_dsi.c` | `lowlevel_tcon/` / `lowlevel_lcd/` | **同硬件，完全独立实现** |
| **HAL 总入口** | `disp_al.c`（统一调用入口） | 无对应，由 `de_channel.c`/`de_backend.c` 分别驱动 | **架构不同** |
| **AFBC 压缩解码** | 无独立模块（混在 rtmx） | `afbd/de_afbd.c` | **DRM 新增独立支持** |
| **TFBC 压缩解码** | 无 | `tfbd/de_tfbd.c` | **DRM 新增** |
| **Gamma 校正** | 无独立模块 | `gamma/de_gamma.c` | **DRM 新增** |
| **Dither 抖动** | 无独立模块 | `dither/de_dither.c` | **DRM 新增** |
| **Deband 去色带** | 无独立模块 | `deband/de_deband.c` | **DRM 新增** |

---

### 三、最关键差异：寄存器结构体命名风格

两套代码操作**同一块寄存器**，但封装方式完全不同：

**DISP2 lowlevel（`de_vsu_type.h`）**：
```c
// 老式命名风格，全大写 union
union VSU_CTRL_REG {
    unsigned int dwval;
    struct {
        unsigned int en:1;
        unsigned int res0:3;
        unsigned int coef_switch_rdy:1;
        unsigned int res1:25;
        unsigned int reset:1;
        unsigned int bist:1;
    } bits;
};

// 静态全局数组，按 [DE_NUM][VI_CHN_NUM] 索引
static volatile struct __vsu_reg_t *vsu_dev[DE_NUM][VI_CHN_NUM];
static struct de_reg_blocks vsu_glb_block[DE_NUM][VI_CHN_NUM];
```

**DRM lowlevel（`scaler/de_scaler_type.h`）**：
```c
// 新式命名风格，小写 union，显式 vsu8 版本号
union vsu8_ctl_reg {
    u32 dwval;
    struct {
        u32 en:1;
        u32 res0:29;
        u32 reset:1;
        u32 res1:1;
    } bits;
};

// 通过 module_create_info + handle 动态分配，OOP 风格
struct de_scaler_handle {
    struct module_create_info cinfo;
    unsigned int linebuff_share_ids;
    unsigned int linebuff_yuv;
    unsigned int linebuff_rgb;
    // ...
};
```

---

### 四、架构设计理念差异

**DISP2 lowlevel 的设计理念**：

```
静态全局数组 + 函数参数传 sel（屏号）
─────────────────────────────────────
static struct de_reg_blocks vsu_glb_block[DE_NUM][VI_CHN_NUM];

// 调用方式：传 sel 索引，访问全局数组
de_vsu_set_para(unsigned int sel, unsigned int chno, ...)
    → vsu_dev[sel][chno]->ctrl.dwval = ...
```

**DRM lowlevel 的设计理念**：

```
动态 handle + 面向对象封装
─────────────────────────────────────
struct de_scaler_handle *scaler = de_scaler_create(&cinfo);

// 调用方式：传 handle 指针，handle 内含寄存器基址
de_scaler_apply(scaler, ...)
    → scaler->private->base_addr + offset = ...
```

这意味着 DRM 的 lowlevel **天然支持多实例**（多个 DE 硬件），而 DISP2 通过静态数组 + 下标索引实现多屏，扩展性较差。

---

### 五、结论

| 维度 | 结论 |
|---|---|
| 操作的硬件 | **相同**（同一块 DE/TCON 寄存器） |
| 代码是否复用 | **完全没有复用**，是两套独立重写 |
| 寄存器 layout | 本质相同，但命名和封装风格完全不同 |
| 功能覆盖 | DRM 覆盖更多（AFBC/TFBC/Gamma/Dither/Deband 是新增） |
| 模块划分 | DISP2 扁平集中，DRM 细粒度独立子目录 |
| 实例管理 | DISP2 静态数组，DRM 动态 handle（更灵活） |
| 接口风格 | DISP2 面向过程（sel + 全局状态），DRM 面向对象（handle 指针） |

简单说：**两套驱动是同一块硬件的两种不同"翻译方式"，互不依赖，代码零复用。** 全志在从 DISP2 向 DRM 迁移时，选择了完全重写 lowlevel 层，而不是复用旧代码，目的是彻底切换到更符合 Linux DRM 规范的架构风格。

```plaintext
同一块 DE 硬件（寄存器地址相同）
         ▲                    ▲
         │                    │
 DISP2 lowlevel          DRM lowlevel
 (disp2/disp/de/         (drm/sunxi_device/
  lowlevel_v2x/)          hardware/lowlevel_de/)
         │                    │
   扁平化设计              模块化设计
   私有接口调用            drm_plane/crtc 驱动
```

```c
// 老式命名风格，全大写 union
union VSU_CTRL_REG {
    unsigned int dwval;
    struct {
        unsigned int en:1;
        unsigned int res0:3;
        unsigned int coef_switch_rdy:1;
        unsigned int res1:25;
        unsigned int reset:1;
        unsigned int bist:1;
    } bits;
};

// 静态全局数组，按 [DE_NUM][VI_CHN_NUM] 索引
static volatile struct __vsu_reg_t *vsu_dev[DE_NUM][VI_CHN_NUM];
static struct de_reg_blocks vsu_glb_block[DE_NUM][VI_CHN_NUM];
```

```c
// 新式命名风格，小写 union，显式 vsu8 版本号
union vsu8_ctl_reg {
    u32 dwval;
    struct {
        u32 en:1;
        u32 res0:29;
        u32 reset:1;
        u32 res1:1;
    } bits;
};

// 通过 module_create_info + handle 动态分配，OOP 风格
struct de_scaler_handle {
    struct module_create_info cinfo;
    unsigned int linebuff_share_ids;
    unsigned int linebuff_yuv;
    unsigned int linebuff_rgb;
    // ...
};
```

```plaintext
静态全局数组 + 函数参数传 sel（屏号）
─────────────────────────────────────
static struct de_reg_blocks vsu_glb_block[DE_NUM][VI_CHN_NUM];

// 调用方式：传 sel 索引，访问全局数组
de_vsu_set_para(unsigned int sel, unsigned int chno, ...)
    → vsu_dev[sel][chno]->ctrl.dwval = ...
```

```plaintext
动态 handle + 面向对象封装
─────────────────────────────────────
struct de_scaler_handle *scaler = de_scaler_create(&cinfo);

// 调用方式：传 handle 指针，handle 内含寄存器基址
de_scaler_apply(scaler, ...)
    → scaler->private->base_addr + offset = ...
```

---

**User**

@code block (1-10) 以DRM管理channel/panel为例，DRM上层只认panel，但是全志DRM中是把channel对应drm的panel，那channel里面的layer怎么管理呢？UI layer和Video layer又该怎么管理呢？

---

**Cursor**

现在有了足够信息，可以给出完整精准的回答。

---

## 全志 DRM 中 channel/layer/UI/Video 的管理机制

### 一、核心问题的解答

**问题的前提理解**：DRM 标准中 `drm_plane` 是最小的图层单元，但全志硬件中一个 channel 内有 4 个 layer（layer0~3），且 VI channel（视频通道）和 UI channel（图形通道）是不同类型的硬件。

全志 DRM 的解决方案是：**一个 channel = 一个 `drm_plane`，channel 内的 layer1~3 作为 plane 的扩展属性（私有 property + 扩展 state），layer0 复用标准 `drm_plane_state`。**

---

### 二、硬件 channel 类型 → drm_plane 类型的映射

```
全志 DE 硬件                          DRM 抽象
────────────────────────────          ─────────────────────────────────
VI channel 0 (Video Input)    ──→    PRIMARY plane   (支持YUV/RGB/缩放/AFBC)
  layer 0 (主图层，有VSU缩放)
  layer 1
  layer 2
  layer 3

VI channel 1                  ──→    OVERLAY plane   (支持YUV/RGB)
  layer 0 ~ 3

UI channel 0 (UI/Graphic)     ──→    OVERLAY plane   (仅RGB/ARGB，无VSU)
  layer 0 ~ 3

UI channel 1                  ──→    OVERLAY plane
  ...
```

对应到 `sunxi_de_out` 的结构：

```c
// sunxi_de.c
struct sunxi_de_out {
    unsigned int ch_cnt;
    struct de_channel_handle *ch_hdl[CHANNEL_MAX];  // 最多6个channel
    struct de_bld_handle *bld_hdl;                  // Blender：负责所有channel合成
    struct de_backend_handle *backend_hdl;           // 后端：Gamma/CSC/SMBL
    // ...
};
```

每个 `de_channel_handle` 对应一个 `sunxi_drm_plane`：

```c
// sunxi_drm_crtc.c
struct sunxi_drm_plane {
    struct drm_plane plane;
    struct de_channel_handle *hdl;   // ← 指向一个硬件 channel
    unsigned int index;              // channel 编号
    unsigned int layer_cnt;          // 该 channel 支持几个 layer（最多4）
    struct sunxi_drm_crtc *crtc;
};
```

---

### 三、channel 内 4 个 layer 的管理方式

全志用扩展 `display_channel_state` 来管理 channel 内多个 layer，**layer0 用标准字段，layer1~3 用扩展数组**：

```c
// de_channel.h
#define MAX_LAYER_NUM_PER_CHN  4
#define OVL_REMAIN             3   // layer1~3

struct display_channel_state {
    // ── layer0：复用标准 drm_plane_state ──────────────────────
    struct drm_plane_state base;        // base.fb / base.src_x/y/w/h
                                        // base.crtc_x/y/w/h
                                        // base.alpha / base.pixel_blend_mode
    bool fake_layer0;                   // layer0 无内容时填充占位用

    // ── layer1~3：私有扩展数组（对应 OVL_REMAIN = 3）──────────
    unsigned int layer_id;             // 当前异步更新哪个 layer（COMMIT_ALL_LAYER=全部）
    struct drm_framebuffer *fb[MAX_LAYER_NUM_PER_CHN - 1]; // layer1~3 的 fb

    u16      alpha[OVL_REMAIN];
    uint16_t pixel_blend_mode[OVL_REMAIN];
    uint32_t src_x[OVL_REMAIN], src_y[OVL_REMAIN];
    uint32_t src_w[OVL_REMAIN], src_h[OVL_REMAIN];
    uint32_t crtc_x[OVL_REMAIN], crtc_y[OVL_REMAIN];
    uint32_t crtc_w[OVL_REMAIN], crtc_h[OVL_REMAIN];
    // ...
};
```

用户空间通过**私有 DRM property（blob）**设置 layer1~3，对应 `sunxi_drm_private` 中：

```c
struct sunxi_drm_private {
    // layer1~3 各自的私有 property（每个 OVERLAY plane 有 OVL_REMAIN 套）
    struct drm_property *prop_blend_mode[OVL_REMAIN];
    struct drm_property *prop_alpha[OVL_REMAIN];
    struct drm_property *prop_src_x[OVL_REMAIN], *prop_src_y[OVL_REMAIN];
    struct drm_property *prop_src_w[OVL_REMAIN], *prop_src_h[OVL_REMAIN];
    struct drm_property *prop_crtc_x[OVL_REMAIN], *prop_crtc_y[OVL_REMAIN];
    struct drm_property *prop_crtc_w[OVL_REMAIN], *prop_crtc_h[OVL_REMAIN];
    struct drm_property *prop_fb_id[OVL_REMAIN];
    // ...
};
```

---

### 四、UI Layer 和 Video Layer 的区分管理

全志 DRM 通过 `de_channel_handle` 中记录的 channel 类型特性来区分，在 `sunxi_de_channel_update()` 时根据 channel 能力走不同路径：

```
VI channel (Video)              UI channel (Graphic)
─────────────────────────       ──────────────────────────────
支持 YUV 格式输入               只支持 RGB/ARGB 格式
  NV12/P010/YUV420等             ARGB8888/RGB565等
有独立 VSU 缩放器               有 GSU 缩放器（能力弱）
支持 AFBC/TFBC 压缩帧缓冲       通常不支持 AFBC
有 SNR 降噪模块                 无 SNR
前端流水：                       前端流水：
  OVL→AFBC→SNR→VSU→frontend      OVL→GSU→frontend（简化）
drm_plane_type = PRIMARY        drm_plane_type = OVERLAY
  （第一个 VI channel）
```

在 `sunxi_plane_info`（`sunxi_de.h`）中初始化时声明每个 plane 支持的格式列表：

```c
struct sunxi_plane_info {
    const char *name;
    bool is_primary;                  // VI channel 0 为 PRIMARY
    struct de_channel_handle *hdl;
    bool afbc_rot_support;            // VI channel 才有
    const uint32_t *formats;         // VI: 含YUV格式; UI: 仅RGB格式
    unsigned int format_count;
    const uint64_t *format_modifiers; // VI: 含AFBC modifier; UI: 仅LINEAR
    unsigned int layer_cnt;           // 最多4
};
```

用户空间（如 Android HWC）在调用 `drmModeGetPlaneResources` 时，通过查询每个 plane 支持的 `formats` 列表来判断哪个 plane 是 Video plane（支持 NV12），哪个是 UI plane（只支持 ARGB）。

---

### 五、layer 的异步更新机制（`layer_id` 字段）

全志扩展了一个重要机制：**单独更新 channel 内某一个 layer，不触发全量原子提交**：

```c
// sunxi_drm_crtc.c: sunxi_plane_atomic_precheck()
if (cstate->layer_id != COMMIT_ALL_LAYER) {
    // 只更新指定 layer，标记为 legacy_cursor_update（轻量异步路径）
    new_state->state->legacy_cursor_update = true;
}

// 当 layer0 的 fb 被禁用，但 layer1~3 还有内容时：
// 自动创建 fake_layer0 占位，保持 channel 激活
if (!fb) {
    // layer1~3 中还有 fb？
    if (remain_enable) {
        cstate->fake_layer0 = true;  // 填充占位 layer0
        drm_atomic_set_fb_for_plane(new_state, fb); // 用 layer1 的 fb 占位
    }
}
```

这意味着：**Video layer（layer0，主图层）可以独立切换内容，UI layer（layer1~3）也可以单独异步更新**，不需要每次都走全量 `drm_atomic_commit`，降低了延迟。

---

### 六、完整层次总结

```
用户空间 (HWC/Wayland compositor)
  │
  ├── drmModeAtomicAddProperty(VI_plane, fb=yuv_fb)    ← Video 内容
  ├── drmModeAtomicAddProperty(UI_plane, fb=argb_fb)   ← UI 内容
  ├── drmModeAtomicAddProperty(UI_plane, prop_fb_id[0], fb2) ← UI layer2
  └── drmModeAtomicCommit()
           │
           ▼
  display_channel_state (per plane/channel)
    base.fb         → layer0 (Video主图层 或 UI主图层)
    fb[0]           → layer1 (同channel内叠加)
    fb[1]           → layer2
    fb[2]           → layer3
           │
           ▼
  de_channel_update()
    ├── de_ovl_apply()      ← OVL寄存器：4个layer的坐标/格式/地址
    ├── de_scaler_apply()   ← VSU/GSU缩放寄存器
    └── de_frontend_apply() ← SNR/SHARP/CSC等图像处理
           │
           ▼
  de_bld (Blender)          ← 所有channel（VI+UI）在此最终合成
           │
           ▼
  de_backend (CRTC级)       ← Gamma/Dither/输出CSC
           │
           ▼
  TCON → 物理接口输出
```

**核心设计要点**：DRM 标准不感知 layer1~3 的存在，全志通过**私有 property + 扩展 plane state** 将其透明地塞入标准 `drm_plane` 框架中；VI/UI 的区分通过 plane 的 `formats` 列表在用户空间感知，内核侧根据 channel 硬件能力自动走不同的处理路径。

```plaintext
全志 DE 硬件                          DRM 抽象
────────────────────────────          ─────────────────────────────────
VI channel 0 (Video Input)    ──→    PRIMARY plane   (支持YUV/RGB/缩放/AFBC)
  layer 0 (主图层，有VSU缩放)
  layer 1
  layer 2
  layer 3

VI channel 1                  ──→    OVERLAY plane   (支持YUV/RGB)
  layer 0 ~ 3

UI channel 0 (UI/Graphic)     ──→    OVERLAY plane   (仅RGB/ARGB，无VSU)
  layer 0 ~ 3

UI channel 1                  ──→    OVERLAY plane
  ...
```

```c
// sunxi_de.c
struct sunxi_de_out {
    unsigned int ch_cnt;
    struct de_channel_handle *ch_hdl[CHANNEL_MAX];  // 最多6个channel
    struct de_bld_handle *bld_hdl;                  // Blender：负责所有channel合成
    struct de_backend_handle *backend_hdl;           // 后端：Gamma/CSC/SMBL
    // ...
};
```

```c
// sunxi_drm_crtc.c
struct sunxi_drm_plane {
    struct drm_plane plane;
    struct de_channel_handle *hdl;   // ← 指向一个硬件 channel
    unsigned int index;              // channel 编号
    unsigned int layer_cnt;          // 该 channel 支持几个 layer（最多4）
    struct sunxi_drm_crtc *crtc;
};
```

```c
// de_channel.h
#define MAX_LAYER_NUM_PER_CHN  4
#define OVL_REMAIN             3   // layer1~3

struct display_channel_state {
    // ── layer0：复用标准 drm_plane_state ──────────────────────
    struct drm_plane_state base;        // base.fb / base.src_x/y/w/h
                                        // base.crtc_x/y/w/h
                                        // base.alpha / base.pixel_blend_mode
    bool fake_layer0;                   // layer0 无内容时填充占位用

    // ── layer1~3：私有扩展数组（对应 OVL_REMAIN = 3）──────────
    unsigned int layer_id;             // 当前异步更新哪个 layer（COMMIT_ALL_LAYER=全部）
    struct drm_framebuffer *fb[MAX_LAYER_NUM_PER_CHN - 1]; // layer1~3 的 fb

    u16      alpha[OVL_REMAIN];
    uint16_t pixel_blend_mode[OVL_REMAIN];
    uint32_t src_x[OVL_REMAIN], src_y[OVL_REMAIN];
    uint32_t src_w[OVL_REMAIN], src_h[OVL_REMAIN];
    uint32_t crtc_x[OVL_REMAIN], crtc_y[OVL_REMAIN];
    uint32_t crtc_w[OVL_REMAIN], crtc_h[OVL_REMAIN];
    // ...
};
```

```c
struct sunxi_drm_private {
    // layer1~3 各自的私有 property（每个 OVERLAY plane 有 OVL_REMAIN 套）
    struct drm_property *prop_blend_mode[OVL_REMAIN];
    struct drm_property *prop_alpha[OVL_REMAIN];
    struct drm_property *prop_src_x[OVL_REMAIN], *prop_src_y[OVL_REMAIN];
    struct drm_property *prop_src_w[OVL_REMAIN], *prop_src_h[OVL_REMAIN];
    struct drm_property *prop_crtc_x[OVL_REMAIN], *prop_crtc_y[OVL_REMAIN];
    struct drm_property *prop_crtc_w[OVL_REMAIN], *prop_crtc_h[OVL_REMAIN];
    struct drm_property *prop_fb_id[OVL_REMAIN];
    // ...
};
```

```plaintext
VI channel (Video)              UI channel (Graphic)
─────────────────────────       ──────────────────────────────
支持 YUV 格式输入               只支持 RGB/ARGB 格式
  NV12/P010/YUV420等             ARGB8888/RGB565等
有独立 VSU 缩放器               有 GSU 缩放器（能力弱）
支持 AFBC/TFBC 压缩帧缓冲       通常不支持 AFBC
有 SNR 降噪模块                 无 SNR
前端流水：                       前端流水：
  OVL→AFBC→SNR→VSU→frontend      OVL→GSU→frontend（简化）
drm_plane_type = PRIMARY        drm_plane_type = OVERLAY
  （第一个 VI channel）
```

```c
struct sunxi_plane_info {
    const char *name;
    bool is_primary;                  // VI channel 0 为 PRIMARY
    struct de_channel_handle *hdl;
    bool afbc_rot_support;            // VI channel 才有
    const uint32_t *formats;         // VI: 含YUV格式; UI: 仅RGB格式
    unsigned int format_count;
    const uint64_t *format_modifiers; // VI: 含AFBC modifier; UI: 仅LINEAR
    unsigned int layer_cnt;           // 最多4
};
```

```c
// sunxi_drm_crtc.c: sunxi_plane_atomic_precheck()
if (cstate->layer_id != COMMIT_ALL_LAYER) {
    // 只更新指定 layer，标记为 legacy_cursor_update（轻量异步路径）
    new_state->state->legacy_cursor_update = true;
}

// 当 layer0 的 fb 被禁用，但 layer1~3 还有内容时：
// 自动创建 fake_layer0 占位，保持 channel 激活
if (!fb) {
    // layer1~3 中还有 fb？
    if (remain_enable) {
        cstate->fake_layer0 = true;  // 填充占位 layer0
        drm_atomic_set_fb_for_plane(new_state, fb); // 用 layer1 的 fb 占位
    }
}
```

```plaintext
用户空间 (HWC/Wayland compositor)
  │
  ├── drmModeAtomicAddProperty(VI_plane, fb=yuv_fb)    ← Video 内容
  ├── drmModeAtomicAddProperty(UI_plane, fb=argb_fb)   ← UI 内容
  ├── drmModeAtomicAddProperty(UI_plane, prop_fb_id[0], fb2) ← UI layer2
  └── drmModeAtomicCommit()
           │
           ▼
  display_channel_state (per plane/channel)
    base.fb         → layer0 (Video主图层 或 UI主图层)
    fb[0]           → layer1 (同channel内叠加)
    fb[1]           → layer2
    fb[2]           → layer3
           │
           ▼
  de_channel_update()
    ├── de_ovl_apply()      ← OVL寄存器：4个layer的坐标/格式/地址
    ├── de_scaler_apply()   ← VSU/GSU缩放寄存器
    └── de_frontend_apply() ← SNR/SHARP/CSC等图像处理
           │
           ▼
  de_bld (Blender)          ← 所有channel（VI+UI）在此最终合成
           │
           ▼
  de_backend (CRTC级)       ← Gamma/Dither/输出CSC
           │
           ▼
  TCON → 物理接口输出
```

---

**User**

1、那DRM的标准state如何添加全志自己的layer属性的？
2、标准的plane结构体是被sunxi又封装了一层从而管理layer的吗？请找出具体代码辅佐
3、上层怎么通过libdrm调用这种被修改过的drm plane

---

**Cursor**

现在已有全部关键代码，可以做完整精准的回答了。

---

## 三个问题的具体代码分析

---

### 问题一：DRM 标准 state 如何添加全志自己的 layer 属性？

全志用 **C语言结构体继承（首成员嵌入）+ `drm_plane_funcs` 虚函数表钩子** 这两个机制配合实现。

#### 第一步：扩展 `drm_plane_state` — 结构体"继承"

```c
// de_channel.h
struct display_channel_state {
    // ① 第一个成员必须是标准 drm_plane_state（C语言"继承"惯用法）
    struct drm_plane_state base;

    // ② 全志私有扩展字段（layer1~3 的属性）
    bool fake_layer0;
    unsigned int layer_id;                              // 异步更新哪个layer
    struct drm_framebuffer *fb[MAX_LAYER_NUM_PER_CHN - 1]; // layer1~3 fb

    u16      alpha[OVL_REMAIN];
    uint16_t pixel_blend_mode[OVL_REMAIN];
    uint32_t src_x[OVL_REMAIN], src_y[OVL_REMAIN];
    uint32_t src_w[OVL_REMAIN], src_h[OVL_REMAIN];
    uint32_t crtc_x[OVL_REMAIN], crtc_y[OVL_REMAIN];
    uint32_t crtc_w[OVL_REMAIN], crtc_h[OVL_REMAIN];
    // ...
};

// 转换宏：从标准指针降型到全志扩展指针
#define to_display_channel_state(x) \
    container_of(x, struct display_channel_state, base)
```

#### 第二步：注册自定义 state 生命周期钩子

DRM 框架通过 `drm_plane_funcs` 虚函数表调用驱动自定义的 state 操作：

```c
// sunxi_drm_crtc.c
static const struct drm_plane_funcs sunxi_plane_funcs = {
    .reset                = sunxi_atomic_plane_reset,          // ← 分配扩展state
    .atomic_duplicate_state = sunxi_atomic_plane_duplicate_state, // ← 深拷贝扩展字段
    .atomic_destroy_state = sunxi_atomic_plane_destroy_state,  // ← 释放扩展字段
    .atomic_set_property  = sunxi_atomic_plane_set_property,   // ← 写私有property→扩展state
    .atomic_get_property  = sunxi_atomic_plane_get_property,   // ← 读扩展state→私有property
    .update_plane         = drm_atomic_helper_update_plane,    // 标准实现
    .disable_plane        = drm_atomic_helper_disable_plane,   // 标准实现
    .format_mod_supported = sunxi_plane_format_mod_supported,
    .atomic_print_state   = sunxi_plane_atomic_print_state,
};
```

**`reset`：分配扩展 state，初始化私有字段**

```c
// sunxi_drm_crtc.c
static void sunxi_atomic_plane_reset(struct drm_plane *plane)
{
    struct display_channel_state *state;

    // 分配的是全志扩展结构体，而非标准 drm_plane_state
    state = kzalloc(sizeof(*state), GFP_KERNEL);

    // 初始化私有字段
    state->frontend_blob = drm_property_create_blob(...);
    for (i = 0; i < MAX_LAYER_NUM_PER_CHN - 1; i++) {
        state->alpha[i] = DRM_BLEND_ALPHA_OPAQUE;
        state->pixel_blend_mode[i] = DRM_MODE_BLEND_PREMULTI;
    }
    state->eotf = DE_EOTF_BT709;
    state->layer_id = COMMIT_ALL_LAYER;
    state->fake_layer0 = false;

    // 最后用标准helper初始化 base 部分
    __drm_atomic_helper_plane_reset(plane, &state->base);
}
```

**`duplicate_state`：深拷贝时处理私有字段的引用计数**

```c
static struct drm_plane_state *sunxi_atomic_plane_duplicate_state(struct drm_plane *plane)
{
    old = to_display_channel_state(plane->state);
    new = kmemdup(old, sizeof(*new), GFP_KERNEL); // 整体复制扩展结构体

    // layer1~3 的 fb 引用计数+1
    for (i = 0; i < OVL_REMAIN; i++) {
        if (new->fb[i])
            drm_framebuffer_get(new->fb[i]);
    }
    if (new->frontend_blob)
        drm_property_blob_get(new->frontend_blob);

    // 标准 base 部分的引用计数处理
    __drm_atomic_helper_plane_duplicate_state(plane, &new->base);
    return &new->base; // 返回 base 指针，框架不感知扩展部分
}
```

#### 第三步：创建并注册私有 property（在 `sunxi_drm_plane_property_create` 中）

```c
// sunxi_drm_crtc.c: sunxi_drm_plane_property_create()
int sunxi_drm_plane_property_create(struct sunxi_drm_private *private)
{
    // layer_id property：控制异步更新哪个layer
    prop = drm_property_create_range(dev, 0, "layer_id", 0, MAX_LAYER_NUM_PER_CHN);
    private->prop_layer_id = prop;

    // 为 layer1~3（OVL_REMAIN=3）各创建一套属性
    for (i = 0; i < OVL_REMAIN; i++) {
        // 混合模式
        create_extra_blend_mode_prop(private, i, ...);   // "pixel blend mode1/2/3"

        // alpha
        sprintf(name, "alpha%d", i + 1);
        private->prop_alpha[i] = drm_property_create_range(dev, 0, name, 0, 0xffff);

        // 源区域（16.16定点数）
        sprintf(name, "SRC_X%d", i + 1);
        private->prop_src_x[i] = drm_property_create_signed_range(
            dev, DRM_MODE_PROP_ATOMIC, name, INT_MIN, INT_MAX);
        // SRC_Y1/2/3, SRC_W1/2/3, SRC_H1/2/3 同理...

        // 目标区域
        sprintf(name, "CRTC_X%d", i + 1);
        private->prop_crtc_x[i] = drm_property_create_signed_range(
            dev, DRM_MODE_PROP_ATOMIC, name, INT_MIN, INT_MAX);
        // CRTC_Y1/2/3, CRTC_W1/2/3, CRTC_H1/2/3 同理...

        // fb_id（帧缓冲ID）
        sprintf(name, "fb_id%d", i + 1);
        private->prop_fb_id[i] = drm_property_create_range(dev, 0, name, 0, UINT_MAX);
    }
    // ...还有 frontend_data blob, eotf, color_space 等
}
```

**`set_property` / `get_property`：property 值写入/读出扩展 state**

```c
static int sunxi_atomic_plane_set_property(struct drm_plane *plane,
    struct drm_plane_state *state, struct drm_property *property, uint64_t val)
{
    struct display_channel_state *cstate = to_display_channel_state(state);

    for (i = 0; i < OVL_REMAIN; i++) {
        if (property == private->prop_src_x[i]) {
            cstate->src_x[i] = val;   // 写入私有扩展字段
            return 0;
        }
        if (property == private->prop_fb_id[i]) {
            struct drm_framebuffer *fb = drm_framebuffer_lookup(dev, NULL, val);
            drm_framebuffer_assign(&cstate->fb[i], fb); // 管理fb引用
            return 0;
        }
        // ... 其他字段
    }
}
```

---

### 问题二：标准 plane 结构体被 sunxi 封装了一层管理 layer 吗？

**是的，有两层封装**，且目的不同：

**第一层：`sunxi_drm_plane` 封装 `drm_plane`（管理 plane 与 channel 的对应关系）**

```c
// sunxi_drm_crtc.c（内部结构，不暴露给框架）
struct sunxi_drm_plane {
    struct drm_plane plane;          // ① 标准DRM plane（首成员，C"继承"）
    struct de_channel_handle *hdl;   // ② 对应的硬件channel句柄
    unsigned int index;              // channel编号
    unsigned int layer_cnt;          // 该channel支持几个layer
    struct sunxi_drm_crtc *crtc;     // 所属CRTC反向引用
};

// 转换宏
#define to_sunxi_plane(x) container_of(x, struct sunxi_drm_plane, plane)
```

**第二层：`display_channel_state` 封装 `drm_plane_state`（管理channel内多个layer的状态）**

```c
struct display_channel_state {
    struct drm_plane_state base;    // layer0 用标准字段
    // layer1~3 用扩展私有数组
    struct drm_framebuffer *fb[MAX_LAYER_NUM_PER_CHN - 1];
    uint32_t src_x[OVL_REMAIN], ...;
    // ...
};
```

**两层封装的职责分工**：

```
sunxi_drm_plane        → 静态结构：记录 plane ↔ channel 的绑定关系
display_channel_state  → 动态状态：记录每帧 layer0~3 的显示参数
```

---

### 问题三：上层如何通过 libdrm 调用这种被修改过的 drm plane？

上层（HWC/Wayland合成器）通过**标准 DRM atomic API + 私有 property 名字查询**来使用，完全不需要修改 libdrm 本身：

```c
// 用户空间伪代码（基于 libdrm）

// ① 枚举所有 plane 和它们的 property
drmModePlaneRes *plane_res = drmModeGetPlaneResources(fd);
for (int i = 0; i < plane_res->count_planes; i++) {
    drmModePlane *plane = drmModeGetPlane(fd, plane_res->planes[i]);
    drmModeObjectProperties *props =
        drmModeObjectGetProperties(fd, plane->plane_id, DRM_MODE_OBJECT_PLANE);

    // ② 查找全志私有 property 的 ID（按名字查）
    for (int j = 0; j < props->count_props; j++) {
        drmModePropertyRes *prop = drmModeGetProperty(fd, props->props[j]);
        // 找到 "SRC_X2"、"fb_id2"、"layer_id" 等全志私有属性
        if (strcmp(prop->name, "fb_id2") == 0)
            fb_id2_prop = prop->prop_id;
        if (strcmp(prop->name, "SRC_X2") == 0)
            src_x2_prop = prop->prop_id;
        // ...
    }
}

// ③ 创建 layer1~3 的帧缓冲
uint32_t fb2_id;
drmModeAddFB2(fd, width, height, DRM_FORMAT_ARGB8888, handles, ...);

// ④ 原子提交：标准属性 + 私有属性混合设置
drmModeAtomicReqPtr req = drmModeAtomicAlloc();

// layer0（标准方式）
drmModeAtomicAddProperty(req, plane_id, fb_id_prop, fb1_id);
drmModeAtomicAddProperty(req, plane_id, src_x_prop,  0);
drmModeAtomicAddProperty(req, plane_id, src_w_prop,  1920 << 16);
drmModeAtomicAddProperty(req, plane_id, crtc_w_prop, 1920);

// layer2（全志私有属性）
drmModeAtomicAddProperty(req, plane_id, fb_id2_prop,  fb2_id); // "fb_id2"
drmModeAtomicAddProperty(req, plane_id, src_x2_prop,  0);       // "SRC_X2"
drmModeAtomicAddProperty(req, plane_id, src_w2_prop,  1920 << 16);
drmModeAtomicAddProperty(req, plane_id, crtc_x2_prop, 0);       // "CRTC_X2"
drmModeAtomicAddProperty(req, plane_id, crtc_w2_prop, 1920);

// 异步更新 layer2（不触发完整原子提交）
drmModeAtomicAddProperty(req, plane_id, layer_id_prop, 2); // "layer_id"=2

drmModeAtomicCommit(fd, req, DRM_MODE_ATOMIC_NONBLOCK, NULL);
```

**内核侧响应流程**：

```
drmModeAtomicCommit()
  └── DRM_IOCTL_MODE_ATOMIC
       └── drm_atomic_set_property()
            └── plane->funcs->atomic_set_property()
                

```c
// de_channel.h
struct display_channel_state {
    // ① 第一个成员必须是标准 drm_plane_state（C语言"继承"惯用法）
    struct drm_plane_state base;

    // ② 全志私有扩展字段（layer1~3 的属性）
    bool fake_layer0;
    unsigned int layer_id;                              // 异步更新哪个layer
    struct drm_framebuffer *fb[MAX_LAYER_NUM_PER_CHN - 1]; // layer1~3 fb

    u16      alpha[OVL_REMAIN];
    uint16_t pixel_blend_mode[OVL_REMAIN];
    uint32_t src_x[OVL_REMAIN], src_y[OVL_REMAIN];
    uint32_t src_w[OVL_REMAIN], src_h[OVL_REMAIN];
    uint32_t crtc_x[OVL_REMAIN], crtc_y[OVL_REMAIN];
    uint32_t crtc_w[OVL_REMAIN], crtc_h[OVL_REMAIN];
    // ...
};

// 转换宏：从标准指针降型到全志扩展指针
#define to_display_channel_state(x) \
    container_of(x, struct display_channel_state, base)
```

```c
// sunxi_drm_crtc.c
static const struct drm_plane_funcs sunxi_plane_funcs = {
    .reset                = sunxi_atomic_plane_reset,          // ← 分配扩展state
    .atomic_duplicate_state = sunxi_atomic_plane_duplicate_state, // ← 深拷贝扩展字段
    .atomic_destroy_state = sunxi_atomic_plane_destroy_state,  // ← 释放扩展字段
    .atomic_set_property  = sunxi_atomic_plane_set_property,   // ← 写私有property→扩展state
    .atomic_get_property  = sunxi_atomic_plane_get_property,   // ← 读扩展state→私有property
    .update_plane         = drm_atomic_helper_update_plane,    // 标准实现
    .disable_plane        = drm_atomic_helper_disable_plane,   // 标准实现
    .format_mod_supported = sunxi_plane_format_mod_supported,
    .atomic_print_state   = sunxi_plane_atomic_print_state,
};
```

```c
// sunxi_drm_crtc.c
static void sunxi_atomic_plane_reset(struct drm_plane *plane)
{
    struct display_channel_state *state;

    // 分配的是全志扩展结构体，而非标准 drm_plane_state
    state = kzalloc(sizeof(*state), GFP_KERNEL);

    // 初始化私有字段
    state->frontend_blob = drm_property_create_blob(...);
    for (i = 0; i < MAX_LAYER_NUM_PER_CHN - 1; i++) {
        state->alpha[i] = DRM_BLEND_ALPHA_OPAQUE;
        state->pixel_blend_mode[i] = DRM_MODE_BLEND_PREMULTI;
    }
    state->eotf = DE_EOTF_BT709;
    state->layer_id = COMMIT_ALL_LAYER;
    state->fake_layer0 = false;

    // 最后用标准helper初始化 base 部分
    __drm_atomic_helper_plane_reset(plane, &state->base);
}
```

```c
static struct drm_plane_state *sunxi_atomic_plane_duplicate_state(struct drm_plane *plane)
{
    old = to_display_channel_state(plane->state);
    new = kmemdup(old, sizeof(*new), GFP_KERNEL); // 整体复制扩展结构体

    // layer1~3 的 fb 引用计数+1
    for (i = 0; i < OVL_REMAIN; i++) {
        if (new->fb[i])
            drm_framebuffer_get(new->fb[i]);
    }
    if (new->frontend_blob)
        drm_property_blob_get(new->frontend_blob);

    // 标准 base 部分的引用计数处理
    __drm_atomic_helper_plane_duplicate_state(plane, &new->base);
    return &new->base; // 返回 base 指针，框架不感知扩展部分
}
```

```c
// sunxi_drm_crtc.c: sunxi_drm_plane_property_create()
int sunxi_drm_plane_property_create(struct sunxi_drm_private *private)
{
    // layer_id property：控制异步更新哪个layer
    prop = drm_property_create_range(dev, 0, "layer_id", 0, MAX_LAYER_NUM_PER_CHN);
    private->prop_layer_id = prop;

    // 为 layer1~3（OVL_REMAIN=3）各创建一套属性
    for (i = 0; i < OVL_REMAIN; i++) {
        // 混合模式
        create_extra_blend_mode_prop(private, i, ...);   // "pixel blend mode1/2/3"

        // alpha
        sprintf(name, "alpha%d", i + 1);
        private->prop_alpha[i] = drm_property_create_range(dev, 0, name, 0, 0xffff);

        // 源区域（16.16定点数）
        sprintf(name, "SRC_X%d", i + 1);
        private->prop_src_x[i] = drm_property_create_signed_range(
            dev, DRM_MODE_PROP_ATOMIC, name, INT_MIN, INT_MAX);
        // SRC_Y1/2/3, SRC_W1/2/3, SRC_H1/2/3 同理...

        // 目标区域
        sprintf(name, "CRTC_X%d", i + 1);
        private->prop_crtc_x[i] = drm_property_create_signed_range(
            dev, DRM_MODE_PROP_ATOMIC, name, INT_MIN, INT_MAX);
        // CRTC_Y1/2/3, CRTC_W1/2/3, CRTC_H1/2/3 同理...

        // fb_id（帧缓冲ID）
        sprintf(name, "fb_id%d", i + 1);
        private->prop_fb_id[i] = drm_property_create_range(dev, 0, name, 0, UINT_MAX);
    }
    // ...还有 frontend_data blob, eotf, color_space 等
}
```

```c
static int sunxi_atomic_plane_set_property(struct drm_plane *plane,
    struct drm_plane_state *state, struct drm_property *property, uint64_t val)
{
    struct display_channel_state *cstate = to_display_channel_state(state);

    for (i = 0; i < OVL_REMAIN; i++) {
        if (property == private->prop_src_x[i]) {
            cstate->src_x[i] = val;   // 写入私有扩展字段
            return 0;
        }
        if (property == private->prop_fb_id[i]) {
            struct drm_framebuffer *fb = drm_framebuffer_lookup(dev, NULL, val);
            drm_framebuffer_assign(&cstate->fb[i], fb); // 管理fb引用
            return 0;
        }
        // ... 其他字段
    }
}
```

```c
// sunxi_drm_crtc.c（内部结构，不暴露给框架）
struct sunxi_drm_plane {
    struct drm_plane plane;          // ① 标准DRM plane（首成员，C"继承"）
    struct de_channel_handle *hdl;   // ② 对应的硬件channel句柄
    unsigned int index;              // channel编号
    unsigned int layer_cnt;          // 该channel支持几个layer
    struct sunxi_drm_crtc *crtc;     // 所属CRTC反向引用
};

// 转换宏
#define to_sunxi_plane(x) container_of(x, struct sunxi_drm_plane, plane)
```

```c
struct display_channel_state {
    struct drm_plane_state base;    // layer0 用标准字段
    // layer1~3 用扩展私有数组
    struct drm_framebuffer *fb[MAX_LAYER_NUM_PER_CHN - 1];
    uint32_t src_x[OVL_REMAIN], ...;
    // ...
};
```

```plaintext
sunxi_drm_plane        → 静态结构：记录 plane ↔ channel 的绑定关系
display_channel_state  → 动态状态：记录每帧 layer0~3 的显示参数
```

```c
// 用户空间伪代码（基于 libdrm）

// ① 枚举所有 plane 和它们的 property
drmModePlaneRes *plane_res = drmModeGetPlaneResources(fd);
for (int i = 0; i < plane_res->count_planes; i++) {
    drmModePlane *plane = drmModeGetPlane(fd, plane_res->planes[i]);
    drmModeObjectProperties *props =
        drmModeObjectGetProperties(fd, plane->plane_id, DRM_MODE_OBJECT_PLANE);

    // ② 查找全志私有 property 的 ID（按名字查）
    for (int j = 0; j < props->count_props; j++) {
        drmModePropertyRes *prop = drmModeGetProperty(fd, props->props[j]);
        // 找到 "SRC_X2"、"fb_id2"、"layer_id" 等全志私有属性
        if (strcmp(prop->name, "fb_id2") == 0)
            fb_id2_prop = prop->prop_id;
        if (strcmp(prop->name, "SRC_X2") == 0)
            src_x2_prop = prop->prop_id;
        // ...
    }
}

// ③ 创建 layer1~3 的帧缓冲
uint32_t fb2_id;
drmModeAddFB2(fd, width, height, DRM_FORMAT_ARGB8888, handles, ...);

// ④ 原子提交：标准属性 + 私有属性混合设置
drmModeAtomicReqPtr req = drmModeAtomicAlloc();

// layer0（标准方式）
drmModeAtomicAddProperty(req, plane_id, fb_id_prop, fb1_id);
drmModeAtomicAddProperty(req, plane_id, src_x_prop,  0);
drmModeAtomicAddProperty(req, plane_id, src_w_prop,  1920 << 16);
drmModeAtomicAddProperty(req, plane_id, crtc_w_prop, 1920);

// layer2（全志私有属性）
drmModeAtomicAddProperty(req, plane_id, fb_id2_prop,  fb2_id); // "fb_id2"
drmModeAtomicAddProperty(req, plane_id, src_x2_prop,  0);       // "SRC_X2"
drmModeAtomicAddProperty(req, plane_id, src_w2_prop,  1920 << 16);
drmModeAtomicAddProperty(req, plane_id, crtc_x2_prop, 0);       // "CRTC_X2"
drmModeAtomicAddProperty(req, plane_id, crtc_w2_prop, 1920);

// 异步更新 layer2（不触发完整原子提交）
drmModeAtomicAddProperty(req, plane_id, layer_id_prop, 2); // "layer_id"=2

drmModeAtomicCommit(fd, req, DRM_MODE_ATOMIC_NONBLOCK, NULL);
```

```plaintext
drmModeAtomicCommit()
  └── DRM_IOCTL_MODE_ATOMIC
       └── drm_atomic_set_property()
            └── plane->funcs->atomic_set_property()
                
```

