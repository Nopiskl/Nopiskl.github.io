# MCU工程结构分析
_Exported on 2026/4/21 at GMT+8 14:41:01 from Cursor (2.6.21)_

---

**User**

能否帮我分析一下MCU工程结构？SDK/luckfox-pico/sysdrv/source/mcu

---

**Cursor**

我先看看 `mcu` 目录的整体结构，再挑关键文件做针对性分析。

我再定位一下 RV1106 MCU 实际板级工程入口，重点看构建脚本、BSP 目录和主程序。

我改用直接读取这些关键文件。

我再补两块：一是 BSP 的公共初始化层，二是你提到的 `battery-ipc` 应用层，这样能把“平台”和“业务”分开讲清楚。

可以，我先给你做一个“面向理解”的结构分析。  
你这个目录 `SDK/luckfox-pico/sysdrv/source/mcu` 本质上是一个基于 **RT-Thread** 的 MCU 子工程，重点服务于 **RV1106 上的 MCU 侧功能**，而不是 Linux A核那一侧。它的组织方式是：

- `project/`：外层构建入口
- `rt-thread/`：RT-Thread 源码 + Rockchip BSP + 应用
- 其中真正和 RV1106 MCU 强相关的核心都在  
  `rt-thread/bsp/rockchip/rv1106-mcu/`

---

## 1. 顶层目录职责

你这个 `mcu` 目录顶层非常简洁：

- `project/`
  - 提供统一构建脚本、输出路径、板级选择入口
- `rt-thread/`
  - RT-Thread 内核
  - 各架构支持
  - third_party
  - Rockchip RV1106 MCU BSP
  - 具体应用代码

从 `project/readme.txt` 看，官方也明确把入口指向这几个点：

- 选板：`./build.sh lunch`
- 编译：`./build.sh all`
- menuconfig：`./build.sh menuconfig`
- 输出：`output/image/rtthread.bin`
- 关键代码位置：
  - `battery ipc application: rt-thread/applications/battery-ipc/`
  - `rtthread bsp: rt-thread/bsp/rockchip/rv1106-mcu`
  - `rtthread hal: rt-thread/bsp/rockchip/common/hal`

---

## 2. 外层构建框架：`project/`

### 2.1 作用
`project/build.sh` 是整个 MCU 工程的总入口，它负责：

1. 设置环境变量
2. 指定输出目录
3. 指定目标 BSP 目录
4. 选择板级配置
5. 调用 `scons` 完成 RT-Thread 工程编译
6. 打包/保存镜像

里面一个关键变量是：

- `TARGET_PRODUCT_DIR=$SDK_ROOT_DIR/rt-thread/bsp/rockchip/rv1106-mcu/`

这说明整个 MCU 编译最终是落到 `rv1106-mcu` 这个 BSP 目录里的。

### 2.2 板级选择逻辑
`build.sh lunch` 的核心是扫描：

- `rt-thread/bsp/rockchip/rv1106-mcu/board/`

里面每个目录名都对应一个板级组合，命名规则脚本里也写得很清楚：

- `[board]-[sensor]-[lightsensor]`
- 即：
  - 板型
  - 图像传感器
  - 光敏器件类型

例如：

- `rv1106_evb-SC3338-ADC`
- `rv1106_evb2-SC231HAI-ADC`
- `battery_ipc_demo_v20-SC3338-ALS_LTR308`

这说明这个 MCU 工程不是单一板子，而是一个 **多板型/多sensor 变体的统一工程**。

---

## 3. 真正核心：`rt-thread/bsp/rockchip/rv1106-mcu`

这个目录可以理解为：

> “RV1106 MCU 的板级支持包 + 本工程的可执行入口”

你可以把它拆成 6 层来看。

---

## 4. `rv1106-mcu` 目录分层理解

### 4.1 `applications/`：BSP 内的启动入口
这里有：

- `main.c`
- `SConscript`

`main.c` 很关键，它不是业务逻辑，而是 **RT-Thread 系统启动入口**。

主流程非常标准：

1. 关中断
2. `rt_hw_board_init()` 板级初始化
3. 初始化 tick
4. 初始化内核对象
5. 初始化定时器系统
6. 初始化调度器
7. `rt_application_init()` 应用初始化
8. 启动 timer thread
9. 启动 idle thread
10. 启动调度器

所以你可以这么理解：

- `applications/main.c` = **MCU 固件入口**
- `rt_application_init()` 之后才进入更上层的应用组件初始化

---

### 4.2 `board/`：板级差异层
这是最重要的“定制层”。

里面包含：

- 各个板型目录
- `common/` 公共板级代码

每个板型目录一般都有：

- `board.c`
- `board.h`
- `iomux.c`
- `iomux.h`
- `defconfig`
- `Kconfig`
- `SConscript`

它们分工通常是：

#### `defconfig`
- 该板默认配置
- 相当于 RT-Thread 的板级裁剪入口
- 决定启用哪些驱动、组件、应用功能

#### `board.c`
- 板级外设初始化
- 时钟、电源、sensor、GPIO 等差异化配置

#### `iomux.c`
- 引脚复用配置
- 例如 UART/I2C/SPI/PWM/Camera pinmux

#### `Kconfig`
- 板级配置项定义

#### `SConscript`
- 把这一层源文件纳入构建

---

### 4.3 `board/common/`：公共板级框架
这里有：

- `board_base.c`
- `board_base.h`
- `board_cam.c`
- `board_cam.h`
- `iomux_base.c`
- `iomux_base.h`

这个层可以理解为：

> “所有 RV1106 MCU 板子的共性初始化逻辑”

例如 `board_base.c` 里能看到：

- 堆初始化：`rt_system_heap_init`
- 中断初始化：`rt_hw_interrupt_init`
- 软中断安装
- SysTick 配置
- UART 初始化
- console 设置
- iomux 配置
- ISP 相关初始化
- 组件初始化

所以分层关系大概是：

- `board/common/*`：平台公共能力
- `board/<具体板型>/*`：某块板的差异化覆盖/补充

这是很典型的 BSP 组织方式。

---

### 4.4 `cpu/`：CPU/核相关支持
这里文件不多：

- `riscv_csr_encoding.h`
- `scr1_specific.h`
- `SConscript`

说明 RV1106 这里的 MCU 侧是基于某个 **RISC-V/SCR1** 核相关环境做适配。

这层一般负责：

- CSR 定义
- 核特性寄存器
- 和启动/中断/底层 CPU 特性相关的补充定义

---

### 4.5 `drivers/`：BSP 私有驱动层
这里有：

- `int_mux.c/h`
- `timer.c/h`
- `config.h`
- `Kconfig`
- `SConscript`

这一层一般放：

- 该 BSP 自己封装的一层底层驱动
- 比如中断路由、timer、平台配置

注意它和 `common/hal` 的关系：

- `common/hal` 更底层、更通用，偏芯片 HAL
- `rv1106-mcu/drivers` 更接近本 BSP 的“工程适配驱动层”

可以粗略理解成：

- HAL = 芯片原厂底座
- drivers = 本板级工程拿来真正接 RT-Thread 的那层

---

### 4.6 工程配置与链接文件
这一层文件包括：

- `.config`
- `rtconfig.h`
- `rtconfig.py`
- `hal_conf.h`
- `link.lds`
- `Makefile`
- `SConstruct`
- `SConscript`

作用分别是：

#### `.config`
- 当前 menuconfig 生成的实际配置

#### `rtconfig.h`
- 配置导出的头文件
- C 代码里 `#ifdef RT_USING_XXX` 就靠它

#### `rtconfig.py`
- 编译器、flags、工具链配置

#### `hal_conf.h`
- HAL 裁剪开关

#### `link.lds`
- 链接脚本
- 决定代码/数据/堆栈/段布局

#### `SConstruct`
- SCons 顶层构建入口
- 调用 RT-Thread 的 `PrepareBuilding` / `DoBuilding`

---

## 5. `rt-thread/` 的更大层次

除了 `bsp/rockchip/rv1106-mcu`，`rt-thread/` 下面还有几个大层：

### 5.1 `src/`
RT-Thread 内核源码：

- `thread.c`
- `scheduler.c`
- `timer.c`
- `ipc.c`
- `mem.c`
- `device.c`
- `idle.c`
- 等

这层是 RTOS 内核，不是项目业务层。

---

### 5.2 `include/`
RT-Thread 核心头文件：

- `rtthread.h`
- `rthw.h`
- `rtdef.h`
- `rtservice.h`

---

### 5.3 `libcpu/`
多架构 CPU 适配层。  
这里包含大量 ARM/MIPS/RISC-V 等目录。

但对你当前 RV1106 MCU 工程来说，不需要全看，只需要关注实际启用的那一套 CPU port。  
这个目录更多是 RT-Thread 框架本身的通用资产。

---

### 5.4 `third_party/`
第三方组件，非常大，里面能看到：

- `audio/`
- `bt/`
- `cmsis/`
- `cypress/`
- `freertos/`
- `netutils/`

这说明当前 MCU 工程并不只是一个极简 bare-metal/RTOS demo，而是一个 **功能裁剪型产品工程底座**，可按配置启用：

- 音频
- 蓝牙
- Wi-Fi
- 网络工具
- 编解码器
- ISP/相机相关能力

---

### 5.5 `applications/`
这个目录是 **应用层总入口集合**。  
你这里已经能看到很多应用模块：

- `battery-ipc/`
- `clock_demo/`
- `lvgl_demo/`
- `recording_pen/`
- `rk_iot_app/`
- `pcba_test/`
- `start_app/`

这说明整个 RT-Thread 工程是个“平台化应用仓库”，不同产品功能在这里以模块组织。

---

## 6. 你当前最相关的应用：`applications/battery-ipc/`

从 `project/readme.txt` 的说明看，这个目录是当前官方重点指出的业务代码位置。

你给的最近打开文件里也有：

- `MCU.md`
- `RV1106_ThunderBoot_双线流程完整分析报告.md`

再结合这里的代码，说明这个 MCU 工程很可能服务于：

- 电池/低功耗/快启场景
- IPC 摄像头类产品
- MCU 与 AP/Linux 侧协同工作

### 从 `stream.c` 看出什么
`battery-ipc/stream.c` 明显是一个 **ISP 图像流控制模块**，代码里能看到：

- `RT_USING_ISP3`
- `rk_isp_dev`
- `RK_DEVICE_CTRL_ISP_*`
- `rk_camera_*`
- `shared_data`
- `fast_ae`
- `CMD_AP_SUSPEND / CMD_AP_RESUME`

这说明它不是普通 UI 应用，而是：

1. 操作 ISP 设备
2. 配置 sensor/分辨率/格式
3. 做预采图像帧处理
4. 与共享内存配合
5. 可能在 AP suspend/resume 场景下由 MCU 独立处理一部分图像/唤醒任务

换句话说：

> `battery-ipc` 更像一个“低功耗图像前处理/唤醒协同”业务模块。

---

## 7. 这套工程的“结构分层图”

可以用下面这个视角理解：

```text
sysdrv/source/mcu
├── project/                      # 外层编译入口
│   ├── build.sh                  # 选板、编译、打包
│   └── readme.txt
└── rt-thread/                    # RT-Thread 工程本体
    ├── src/                      # RT-Thread 内核
    ├── include/                  # RT-Thread 头文件
    ├── libcpu/                   # CPU 架构适配
    ├── third_party/              # 第三方组件
    ├── applications/             # 应用层模块
    │   └── battery-ipc/          # 当前重点业务
    └── bsp/rockchip/
        ├── common/hal/           # Rockchip HAL
        └── rv1106-mcu/           # RV1106 MCU BSP
            ├── applications/     # 固件主入口
            ├── board/            # 板级差异层
            │   ├── common/       # 公共板级逻辑
            │   └── <board>/      # 各具体板型
            ├── cpu/              # MCU核相关定义
            ├── drivers/          # BSP驱动适配层
            ├── link.lds          # 链接脚本
            ├── rtconfig.h        # 配置导出
            ├── .config           # menuconfig实际配置
            └── SConstruct        # BSP构建入口
```

---

## 8. 启动路径怎么走

如果只看“从编译到运行”的主线，大概是：

### 编译期
1. `project/build.sh`
2. 选择 `board/<xxx>/defconfig`
3. 生成 `.config` / `rtconfig.h`
4. 进入 `rt-thread/bsp/rockchip/rv1106-mcu`
5. `SConstruct` + SCons 编译
6. 生成 `rtthread.elf / rtthread.bin`

### 运行期
1. MCU 上电/唤醒
2. 进入 BSP 启动代码
3. 最终到 `applications/main.c`
4. 执行 `rtthread_startup()`
5. `rt_hw_board_init()` 做板级初始化
6. `rt_application_init()` 拉起应用组件
7. 进入 `applications/battery-ipc/` 等业务逻辑

---

## 9. 如果你要看“真正有价值”的文件，建议优先顺序

如果你现在想真正搞懂这个 MCU 工程，不建议一上来就扫整个 `rt-thread/`，太大了。  
建议按下面顺序看：

### 第一层：构建和选板
1. `project/build.sh`
2. `rt-thread/bsp/rockchip/rv1106-mcu/board/<你的板型>/defconfig`

### 第二层：启动入口
3. `rt-thread/bsp/rockchip/rv1106-mcu/applications/main.c`
4. `rt-thread/bsp/rockchip/rv1106-mcu/board/common/board_base.c`

### 第三层：板级差异
5. `rt-thread/bsp/rockchip/rv1106-mcu/board/<你的板型>/board.c`
6. `rt-thread/bsp/rockchip/rv1106-mcu/board/<你的板型>/iomux.c`

### 第四层：业务逻辑
7. `rt-thread/applications/battery-ipc/`
   - 尤其是和 stream / wakeup / shared memory / AE / IPC 相关文件

### 第五层：底层能力
8. `rt-thread/bsp/rockchip/common/hal/`
9. `rt-thread/bsp/rockchip/rv1106-mcu/drivers/`

---

## 10. 对这个工程结构的总体判断

我对这个工程的判断是：

### 它不是
- 一个纯 RT-Thread 教学 demo
- 一个简单单板小工程

### 它更像
- 一个 **Rockchip RV1106 MCU 产品化子系统工程**
- 支持多板型、多 sensor 组合
- 通过 RT-Thread 做 MCU 侧任务调度
- 面向 IPC/低功耗/快启/图像预处理场景
- 与 ISP、camera、共享内存、AP 协同密切相关

换句话说：

> 这个 MCU 工程的核心价值不在“RT-Thread 内核本身”，而在  
> `rv1106-mcu BSP + battery-ipc 业务 + common/hal`  
> 这三层的协同。

---

如果你愿意，我下一步可以继续帮你做两种更深入的分析之一：

1. **按目录继续深挖**
   - 我帮你把 `rv1106-mcu/board`、`drivers`、`applications/battery-ipc` 分别拆开讲

2. **按启动流程串起来**
   - 从 `build.sh -> defconfig -> main.c -> board init -> battery-ipc` 画出完整调用链

如果你想，我建议下一步直接看你当前板型对应的 `defconfig + board.c + iomux.c`，这样最容易把这个 MCU 工程吃透。

