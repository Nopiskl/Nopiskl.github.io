# Lichee/melis-v3.0 与 Linux 异构体系
_Exported on 2026/3/17 at GMT+8 11:17:01 from Cursor (2.3.34)_

---

**User**

能帮结合整个官方BSP我分析一下lichee/melis-v3.0是如何和Linux和做组成异构体系吗

---

**Cursor**

我来帮你分析一下这个V853芯片的异构体系架构。首先让我探索一下整个BSP的结构。

好的！现在我已经收集了足够的信息。让我为你详细分析V853芯片中lichee/melis-v3.0是如何与Linux组成异构体系的。

## V853异构体系架构分析

基于对整个BSP的分析，V853采用了**ARM Cortex-A7 + RISC-V E907双核异构架构**，通过OpenAMP框架实现核间通信。

### 1. **硬件架构**

```
┌─────────────────────────────────────────────────┐
│              V853 (sun8iw21p1)                  │
├─────────────────────────────────────────────────┤
│  ARM Cortex-A7          RISC-V E907            │
│  (主核)                  (协处理器)              │
│  运行 Linux              运行 Melis RTOS        │
│  @ 1008MHz              @ 600MHz                │
└─────────────────────────────────────────────────┘
           │                      │
           └──────────┬───────────┘
                      │
              ┌───────▼────────┐
              │   Msgbox       │  ← 硬件邮箱
              │  (0x03003000)  │
              │  (0x06020000)  │
              └────────────────┘
```

### 2. **内存布局**

从设备树可以看到内存分配：

```
总内存: 0x40000000 - 0x60000000 (512MB)

├─ 0x47000000 - 0x47040000  (256KB)  vdev0buffer (共享内存池)
├─ 0x47040000 - 0x47060000  (128KB)  vdev0vring0 (virtio ring0)
├─ 0x47060000 - 0x47080000  (128KB)  vdev0vring1 (virtio ring1)
└─ 0x48000000 - 0x48400000  (4MB)    E907 DRAM (RTOS运行内存)
```

### 3. **通信架构层次**

```
┌──────────────────────────────────────────────────────────┐
│                    应用层                                 │
├─────────────────────┬────────────────────────────────────┤
│   Linux侧           │         E907侧 (Melis)             │
├─────────────────────┼────────────────────────────────────┤
│ /dev/rpmsg_ctrl*    │  rpmsg_client API                  │
│ rpmsg_client_e907.c │  openamp_ept_open()                │
├─────────────────────┼────────────────────────────────────┤
│   RPMsg 层          │   RPMsg 层                         │
│ rpmsg_core.c        │  rpmsg.c / rpmsg_virtio.c          │
│ rpmsg_master.c      │  rpmsg_master.c                    │
├─────────────────────┼────────────────────────────────────┤
│   VirtIO 层         │   VirtIO 层                        │
│ remoteproc_virtio.c │  remoteproc_virtio.c               │
│ (Linux Kernel)      │  (OpenAMP)                         │
├─────────────────────┼────────────────────────────────────┤
│   RemoteProc 层     │   RemoteProc 层                    │
│ remoteproc_core.c   │  remoteproc.c                      │
│ sun8iw21-e907-rproc │  openamp_platform.c                │
├─────────────────────┼────────────────────────────────────┤
│   Mailbox 驱动      │   Mailbox HAL                      │
│ sunxi_msgbox.c      │  msgbox_amp.c                      │
│ (rpmsg/sunxi_msgbox)│  (rtos-hal/msgbox)                 │
├─────────────────────┼────────────────────────────────────┤
│   硬件 Msgbox       │   硬件 Msgbox                      │
│ 0x03003000 (ARM侧)  │  0x06020000 (RV侧)                 │
└─────────────────────┴────────────────────────────────────┘
```

### 4. **关键组件详解**

#### **4.1 Linux侧 (ARM Cortex-A7)**

**设备树配置** (`sun8iw21p1.dtsi` + `board.dts`):
```dts
// RemoteProc设备
e907_rproc: e907_rproc@0 {
    compatible = "allwinner,sun8iw21p1-e907-rproc";
    clock-frequency = <600000000>;
    mboxes = <&msgbox 0>;
    firmware-name = "melis-elf";  // E907固件
    ...
};

// Msgbox硬件邮箱
msgbox: msgbox@3003000 {
    compatible = "allwinner,sunxi-msgbox";
    reg = <0x0 0x03003000 0x0 0x1000>,  // ARM侧寄存器
          <0x0 0x06020000 0x0 0x1000>;  // RV侧寄存器
    interrupts = <GIC_SPI 0>, <GIC_SPI 1>;
    local_id = <0>;  // ARM是CPU0
};

// RPBuf控制器 (用于大数据传输)
rpbuf_controller0: rpbuf_controller@0 {
    compatible = "allwinner,rpbuf-controller";
    remoteproc = <&e907_rproc>;
};
```

**驱动栈**:
- `drivers/remoteproc/remoteproc_core.c` - 远程处理器管理
- `drivers/rpmsg/sunxi_msgbox.c` - Msgbox硬件抽象
- `drivers/rpmsg/rpmsg_master.c` - RPMsg主控制器
- `drivers/rpmsg/rpmsg_client_e907.c` - E907通信客户端
- `drivers/rpbuf/` - 大块数据传输（基于RPMsg）

#### **4.2 Melis侧 (RISC-V E907)**

**目录结构**:
```
lichee/melis-v3.0/
├── source/
│   ├── ekernel/
│   │   └── components/thirdparty/openamp/
│   │       ├── open-amp/          # OpenAMP核心库
│   │       │   ├── remoteproc/    # 远程处理器
│   │       │   ├── rpmsg/         # RPMsg协议
│   │       │   └── virtio/        # VirtIO实现
│   │       ├── libmetal/          # 硬件抽象层
│   │       ├── sunxi_helper/      # 全志平台适配
│   │       │   ├── openamp.c      # 初始化入口
│   │       │   ├── openamp_platform.c  # 平台实现
│   │       │   └── sunxi_rsc_tab.h     # 资源表
│   │       └── rpmsg_demo/        # 示例代码
│   └── projects/
│       └── v853-e907-perf4-board/ # V853项目配置
└── rtos-hal/
    └── hal/source/msgbox/
        └── msgbox_amp/
            └── msgbox_amp.c       # Msgbox HAL驱动
```

**核心API** (`openamp.h`):
```c
// 初始化OpenAMP框架
int openamp_init(void);

// 创建通信端点
struct rpmsg_endpoint *openamp_ept_open(
    const char *name,      // 端点名称
    int rpmsg_id,          // RPMsg设备ID
    uint32_t src_addr,     // 源地址
    uint32_t dst_addr,     // 目标地址
    void *priv,            // 私有数据
    rpmsg_ept_cb cb,       // 接收回调
    rpmsg_ns_unbind_cb unbind_cb
);

// 发送消息
int openamp_rpmsg_send(struct rpmsg_endpoint *ept, 
                       void *data, uint32_t len);
```

### 5. **启动流程**

```
1. U-Boot阶段
   └─ brandy-2.0/u-boot-2018/
      └─ 加载Linux内核和E907固件到内存

2. Linux启动
   ├─ 解析设备树，发现e907_rproc设备
   ├─ remoteproc驱动probe
   ├─ 加载melis-elf固件到0x48000000
   ├─ 配置E907时钟和复位
   ├─ 启动E907核心
   └─ 初始化msgbox和rpmsg通道

3. E907启动 (Melis RTOS)
   ├─ 从0x48000000开始执行
   ├─ 初始化RTOS内核
   ├─ 调用openamp_init_async()
   │   ├─ openamp_sunxi_create_rproc()
   │   ├─ openamp_sunxi_create_rpmsg_vdev()
   │   └─ 创建virtio设备和vring
   ├─ 初始化msgbox HAL (msgbox_amp.c)
   └─ 等待Linux侧建立RPMsg通道

4. 通信建立
   ├─ Linux: rpmsg_master创建/dev/rpmsg_ctrl0
   ├─ E907: 创建rpmsg endpoint
   ├─ 双方通过name service协商
   └─ 通道就绪，开始数据传输
```

### 6. **通信机制**

#### **6.1 Msgbox硬件邮箱**

```c
// 计算通道编号 (msgbox_amp.c)
// V853有8个通道，分组使用：
// 0,2,4,6 用于发送
// 1,3,5,7 用于接收

ARM (local=0) -> E907 (remote=2):
  发送通道: calculte_n(0, 2) = 1
  接收通道: calculte_n(0, 2) = 1

E907 (local=2) -> ARM (remote=0):
  发送通道: calculte_n(2, 0) = 0
  接收通道: calculte_n(2, 0) = 0
```

#### **6.2 VirtIO Ring缓冲区**

```
vdev0vring0 (ARM->E907):
┌────────────────────────────────┐
│  Descriptor Table              │
│  Available Ring                │
│  Used Ring                     │
└────────────────────────────────┘

vdev0vring1 (E907->ARM):
┌────────────────────────────────┐
│  Descriptor Table              │
│  Available Ring                │
│  Used Ring                     │
└────────────────────────────────┘

vdev0buffer (共享内存池):
┌────────────────────────────────┐
│  消息缓冲区 (最大512-16字节)    │
│  多个buffer循环使用             │
└────────────────────────────────┘
```

### 7. **典型应用场景**

1. **实时任务卸载**: Linux将实时性要求高的任务（如电机控制、传感器采样）交给E907处理
2. **多媒体协处理**: E907处理音频编解码、图像预处理
3. **低功耗管理**: E907在低功耗模式下保持运行，ARM休眠
4. **安全隔离**: 敏感操作在E907的RTOS环境中执行

### 8. **关键特性**

- **异步非对称多处理 (AMP)**: 两个核心运行不同OS，独立调度
- **基于VirtIO的零拷贝**: 通过共享内存减少数据拷贝
- **动态通道管理**: 支持运行时创建/销毁RPMsg通道
- **Name Service**: 自动服务发现和地址协商
- **RPBuf扩展**: 支持大块数据传输（超过512字节限制）

### 9. **开发接口**

**Linux用户态**:
```bash
# 查看RPMsg设备
ls /dev/rpmsg_ctrl*
ls /dev/rpmsg*

# 通过ioctl创建endpoint
# 参考: samples/rpmsg/rpmsg_client_sample.c
```

**E907 RTOS**:
```c
// 创建通信端点
struct rpmsg_endpoint *ept = openamp_ept_open(
    "sunxi,rpmsg_client",  // 与Linux侧匹配的名称
    0,                      // rpmsg设备ID
    RPMSG_ADDR_ANY,        // 自动分配地址
    RPMSG_ADDR_ANY,
    priv_data,
    rx_callback,
    NULL
);

// 发送数据
openamp_rpmsg_send(ept, data, len);
```

这就是V853的完整异构体系架构！通过OpenAMP框架，Linux和Melis RTOS实现了高效、灵活的核间通信，充分发挥了双核异构的优势。

```plaintext
┌─────────────────────────────────────────────────┐
│              V853 (sun8iw21p1)                  │
├─────────────────────────────────────────────────┤
│  ARM Cortex-A7          RISC-V E907            │
│  (主核)                  (协处理器)              │
│  运行 Linux              运行 Melis RTOS        │
│  @ 1008MHz              @ 600MHz                │
└─────────────────────────────────────────────────┘
           │                      │
           └──────────┬───────────┘
                      │
              ┌───────▼────────┐
              │   Msgbox       │  ← 硬件邮箱
              │  (0x03003000)  │
              │  (0x06020000)  │
              └────────────────┘
```

```plaintext
总内存: 0x40000000 - 0x60000000 (512MB)

├─ 0x47000000 - 0x47040000  (256KB)  vdev0buffer (共享内存池)
├─ 0x47040000 - 0x47060000  (128KB)  vdev0vring0 (virtio ring0)
├─ 0x47060000 - 0x47080000  (128KB)  vdev0vring1 (virtio ring1)
└─ 0x48000000 - 0x48400000  (4MB)    E907 DRAM (RTOS运行内存)
```

```plaintext
┌──────────────────────────────────────────────────────────┐
│                    应用层                                 │
├─────────────────────┬────────────────────────────────────┤
│   Linux侧           │         E907侧 (Melis)             │
├─────────────────────┼────────────────────────────────────┤
│ /dev/rpmsg_ctrl*    │  rpmsg_client API                  │
│ rpmsg_client_e907.c │  openamp_ept_open()                │
├─────────────────────┼────────────────────────────────────┤
│   RPMsg 层          │   RPMsg 层                         │
│ rpmsg_core.c        │  rpmsg.c / rpmsg_virtio.c          │
│ rpmsg_master.c      │  rpmsg_master.c                    │
├─────────────────────┼────────────────────────────────────┤
│   VirtIO 层         │   VirtIO 层                        │
│ remoteproc_virtio.c │  remoteproc_virtio.c               │
│ (Linux Kernel)      │  (OpenAMP)                         │
├─────────────────────┼────────────────────────────────────┤
│   RemoteProc 层     │   RemoteProc 层                    │
│ remoteproc_core.c   │  remoteproc.c                      │
│ sun8iw21-e907-rproc │  openamp_platform.c                │
├─────────────────────┼────────────────────────────────────┤
│   Mailbox 驱动      │   Mailbox HAL                      │
│ sunxi_msgbox.c      │  msgbox_amp.c                      │
│ (rpmsg/sunxi_msgbox)│  (rtos-hal/msgbox)                 │
├─────────────────────┼────────────────────────────────────┤
│   硬件 Msgbox       │   硬件 Msgbox                      │
│ 0x03003000 (ARM侧)  │  0x06020000 (RV侧)                 │
└─────────────────────┴────────────────────────────────────┘
```

```dts
// RemoteProc设备
e907_rproc: e907_rproc@0 {
    compatible = "allwinner,sun8iw21p1-e907-rproc";
    clock-frequency = <600000000>;
    mboxes = <&msgbox 0>;
    firmware-name = "melis-elf";  // E907固件
    ...
};

// Msgbox硬件邮箱
msgbox: msgbox@3003000 {
    compatible = "allwinner,sunxi-msgbox";
    reg = <0x0 0x03003000 0x0 0x1000>,  // ARM侧寄存器
          <0x0 0x06020000 0x0 0x1000>;  // RV侧寄存器
    interrupts = <GIC_SPI 0>, <GIC_SPI 1>;
    local_id = <0>;  // ARM是CPU0
};

// RPBuf控制器 (用于大数据传输)
rpbuf_controller0: rpbuf_controller@0 {
    compatible = "allwinner,rpbuf-controller";
    remoteproc = <&e907_rproc>;
};
```

```plaintext
lichee/melis-v3.0/
├── source/
│   ├── ekernel/
│   │   └── components/thirdparty/openamp/
│   │       ├── open-amp/          # OpenAMP核心库
│   │       │   ├── remoteproc/    # 远程处理器
│   │       │   ├── rpmsg/         # RPMsg协议
│   │       │   └── virtio/        # VirtIO实现
│   │       ├── libmetal/          # 硬件抽象层
│   │       ├── sunxi_helper/      # 全志平台适配
│   │       │   ├── openamp.c      # 初始化入口
│   │       │   ├── openamp_platform.c  # 平台实现
│   │       │   └── sunxi_rsc_tab.h     # 资源表
│   │       └── rpmsg_demo/        # 示例代码
│   └── projects/
│       └── v853-e907-perf4-board/ # V853项目配置
└── rtos-hal/
    └── hal/source/msgbox/
        └── msgbox_amp/
            └── msgbox_amp.c       # Msgbox HAL驱动
```

```c
// 初始化OpenAMP框架
int openamp_init(void);

// 创建通信端点
struct rpmsg_endpoint *openamp_ept_open(
    const char *name,      // 端点名称
    int rpmsg_id,          // RPMsg设备ID
    uint32_t src_addr,     // 源地址
    uint32_t dst_addr,     // 目标地址
    void *priv,            // 私有数据
    rpmsg_ept_cb cb,       // 接收回调
    rpmsg_ns_unbind_cb unbind_cb
);

// 发送消息
int openamp_rpmsg_send(struct rpmsg_endpoint *ept, 
                       void *data, uint32_t len);
```

```plaintext
1. U-Boot阶段
   └─ brandy-2.0/u-boot-2018/
      └─ 加载Linux内核和E907固件到内存

2. Linux启动
   ├─ 解析设备树，发现e907_rproc设备
   ├─ remoteproc驱动probe
   ├─ 加载melis-elf固件到0x48000000
   ├─ 配置E907时钟和复位
   ├─ 启动E907核心
   └─ 初始化msgbox和rpmsg通道

3. E907启动 (Melis RTOS)
   ├─ 从0x48000000开始执行
   ├─ 初始化RTOS内核
   ├─ 调用openamp_init_async()
   │   ├─ openamp_sunxi_create_rproc()
   │   ├─ openamp_sunxi_create_rpmsg_vdev()
   │   └─ 创建virtio设备和vring
   ├─ 初始化msgbox HAL (msgbox_amp.c)
   └─ 等待Linux侧建立RPMsg通道

4. 通信建立
   ├─ Linux: rpmsg_master创建/dev/rpmsg_ctrl0
   ├─ E907: 创建rpmsg endpoint
   ├─ 双方通过name service协商
   └─ 通道就绪，开始数据传输
```

```c
// 计算通道编号 (msgbox_amp.c)
// V853有8个通道，分组使用：
// 0,2,4,6 用于发送
// 1,3,5,7 用于接收

ARM (local=0) -> E907 (remote=2):
  发送通道: calculte_n(0, 2) = 1
  接收通道: calculte_n(0, 2) = 1

E907 (local=2) -> ARM (remote=0):
  发送通道: calculte_n(2, 0) = 0
  接收通道: calculte_n(2, 0) = 0
```

```plaintext
vdev0vring0 (ARM->E907):
┌────────────────────────────────┐
│  Descriptor Table              │
│  Available Ring                │
│  Used Ring                     │
└────────────────────────────────┘

vdev0vring1 (E907->ARM):
┌────────────────────────────────┐
│  Descriptor Table              │
│  Available Ring                │
│  Used Ring                     │
└────────────────────────────────┘

vdev0buffer (共享内存池):
┌────────────────────────────────┐
│  消息缓冲区 (最大512-16字节)    │
│  多个buffer循环使用             │
└────────────────────────────────┘
```

```shellscript
# 查看RPMsg设备
ls /dev/rpmsg_ctrl*
ls /dev/rpmsg*

# 通过ioctl创建endpoint
# 参考: samples/rpmsg/rpmsg_client_sample.c
```

```c
// 创建通信端点
struct rpmsg_endpoint *ept = openamp_ept_open(
    "sunxi,rpmsg_client",  // 与Linux侧匹配的名称
    0,                      // rpmsg设备ID
    RPMSG_ADDR_ANY,        // 自动分配地址
    RPMSG_ADDR_ANY,
    priv_data,
    rx_callback,
    NULL
);

// 发送数据
openamp_rpmsg_send(ept, data, len);
```

