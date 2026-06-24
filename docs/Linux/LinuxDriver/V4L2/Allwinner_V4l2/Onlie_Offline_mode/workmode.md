
---

**User**

@device/config/chips/v853/configs/100ask/board.dts 请你结合VIN驱动分析一下各个VINC节点的work_mode = <0x1>;会影响什么？

---

**Cursor**

---

## `work_mode = <0x1>` 分析

### 一、枚举定义

```116:179:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.h
enum bk_work_mode {
	BK_ONLINE = 0,
	BK_OFFLINE = 1,
};
```

`work_mode = <0x1>` 即 `BK_OFFLINE`（离线模式），`0x0` 是 `BK_ONLINE`（在线模式）。

---

### 二、board.dts 中的配置全貌

```270:430:device/config/chips/v853/configs/100ask/board.dts
// 注释写明了 /*offline mode*/，整体框架：
// tdm0、isp00、scaler00/10/20/30 全部 work_mode = <1>（offline）
// VINC 节点中，每组的第 0 个（logic vinc）配置 offline：
//   vinc00(video0)  work_mode = <0x1>  → BK_OFFLINE（logic vinc）
//   vinc01(video1)  无 work_mode       → virtual vinc（挂载在 video0 下）
//   vinc10(video4)  work_mode = <0x1>  → BK_OFFLINE（logic vinc）
//   vinc11(video5)  无 work_mode       → virtual vinc
//   vinc20(video8)  work_mode = <0x1>  → BK_OFFLINE（logic vinc）
//   vinc21(video9)  无 work_mode       → virtual vinc
//   vinc30(video12) work_mode = <0x1>  → BK_OFFLINE（logic vinc）
//   vinc31(video13) 无 work_mode       → virtual vinc
```

---

### 三、驱动层面的影响（逐层分析）

#### 1. 初始化阶段（`vin_core.c:2308`）

```2308:2331:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c
if (of_property_read_u32(np, "work_mode", &vinc->work_mode)) {
    // 没有 work_mode 属性 → 报错（CSIC_DMA_VER_140_000 下必须配置）
}
if (vinc->id == dma_virtual_find_logic[vinc->id]) {
    // logic vinc：直接限定为 BK_ONLINE 或 BK_OFFLINE
    vinc->work_mode = clamp_t(..., BK_ONLINE, BK_OFFLINE);
} else if (vinc->work_mode == 0xff) {
    // virtual vinc：若 logic 是 BK_ONLINE，则该 virtual vinc 设置
    // noneed_register=1，不注册 video 设备，无法被用户空间访问
    if (logic_vinc->work_mode == BK_ONLINE) {
        vinc->noneed_register = 1;
        return 0; // 直接跳过注册
    }
}
```

**结论**：`vinc01/11/21/31` 这些 virtual vinc 没有配置 `work_mode`（DTS 中缺省），其 `work_mode` 读取失败时的行为取决于宏定义。由于 logic vinc 配置了 `BK_OFFLINE`，这些 virtual vinc **会被正常注册**为独立的 `/dev/videoX` 设备。

#### 2. stream on 阶段（`vin_video.c:6202`）

```6202:6214:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
if (logic_vinc->work_mode == BK_ONLINE && virtual_id != logic_id) {
    // online 模式下，virtual vinc 不允许 stream on → 报错
    vin_err("video%d work on online mode, video%d cannot to work!!\n",...);
    return -1;
}
// offline 模式：
csic_dma_mul_ch_enable(logic_id, logic_vinc->work_mode);
// → 写寄存器 MUL_CH_EN = 1，使能多通道 DMA
```

#### 3. 中断处理（`vin_core.c:1520`）

```1520:1545:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_core.c
if (vinc->work_mode == BK_ONLINE) {
    // online：单通道，直接读本 vipp 的中断状态
    csic_dma_int_get_status(vinc->vipp_sel, &status);
} else {
    // offline：轮询 4 个子通道（vipp_sel ~ vipp_sel+3），
    // 找到有中断的通道，切换到对应的 virtual vinc 上下文处理
    for (i = vinc->vir_prosess_ch; i < (vinc->vir_prosess_ch + 4); i++) {
        j = clamp(i ...);
        csic_dma_int_get_status(j, &status);
        vinc = vin_core_gbl[j]; // 切换到对应的 virtual vinc
        ...
    }
}
```

#### 4. VE online 功能（`vin_video.c:2983`）

```2983:2990:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-video/vin_video.c
if (vinc->work_mode == BK_OFFLINE) {
    vin_err("ve online mode need video%d work in online\n", vinc->id);
    return -1;
}
```

**`BK_OFFLINE` 模式下，VE（视频编码引擎）online 零拷贝功能不可用。**

---

### 四、Online vs Offline 核心区别总结

| 维度 | `BK_ONLINE (0x0)` | `BK_OFFLINE (0x1)` |
|---|---|---|
| **多通道 DMA** | 禁用（单通道） | 启用（`MUL_CH_EN=1`，最多4路） |
| **Virtual VINC** | 不注册（`noneed_register=1`） | 可独立注册为 `/dev/videoX` |
| **中断处理** | 单通道直接处理 | 轮询4个子通道，按需切换上下文 |
| **VE online** | 支持（零拷贝编码） | **不支持** |
| **典型用途** | 单路高帧率、低延迟 | **多路同时出图**（本 DTS 的配置目标） |

---

### 五、本 DTS 配置的意图

```
vinc00(offline) + vinc01(virtual) → camera0 出两路图（如预览 + 算法）
vinc10(offline) + vinc11(virtual) → camera1 出两路图
vinc20(offline) + vinc21(virtual) → camera2 出两路图
vinc30(offline) + vinc31(virtual) → camera3 出两路图
```

配合 `tdm0`、`isp00`、`scaler00/10/20/30` 全部配置为 `work_mode=<1>` offline 模式，整套 pipeline 工作在 **TDM offline + ISP offline + VIPP offline + DMA offline** 模式，支持多路摄像头同时采集并独立出图，是典型的多路 AI 视觉应用场景配置。

```plaintext
enum bk_work_mode {
	BK_ONLINE = 0,
	BK_OFFLINE = 1,
};
```

```dts
// 注释写明了 /*offline mode*/，整体框架：
// tdm0、isp00、scaler00/10/20/30 全部 work_mode = <1>（offline）
// VINC 节点中，每组的第 0 个（logic vinc）配置 offline：
//   vinc00(video0)  work_mode = <0x1>  → BK_OFFLINE（logic vinc）
//   vinc01(video1)  无 work_mode       → virtual vinc（挂载在 video0 下）
//   vinc10(video4)  work_mode = <0x1>  → BK_OFFLINE（logic vinc）
//   vinc11(video5)  无 work_mode       → virtual vinc
//   vinc20(video8)  work_mode = <0x1>  → BK_OFFLINE（logic vinc）
//   vinc21(video9)  无 work_mode       → virtual vinc
//   vinc30(video12) work_mode = <0x1>  → BK_OFFLINE（logic vinc）
//   vinc31(video13) 无 work_mode       → virtual vinc
```

```c
if (of_property_read_u32(np, "work_mode", &vinc->work_mode)) {
    // 没有 work_mode 属性 → 报错（CSIC_DMA_VER_140_000 下必须配置）
}
if (vinc->id == dma_virtual_find_logic[vinc->id]) {
    // logic vinc：直接限定为 BK_ONLINE 或 BK_OFFLINE
    vinc->work_mode = clamp_t(..., BK_ONLINE, BK_OFFLINE);
} else if (vinc->work_mode == 0xff) {
    // virtual vinc：若 logic 是 BK_ONLINE，则该 virtual vinc 设置
    // noneed_register=1，不注册 video 设备，无法被用户空间访问
    if (logic_vinc->work_mode == BK_ONLINE) {
        vinc->noneed_register = 1;
        return 0; // 直接跳过注册
    }
}
```

```c
if (logic_vinc->work_mode == BK_ONLINE && virtual_id != logic_id) {
    // online 模式下，virtual vinc 不允许 stream on → 报错
    vin_err("video%d work on online mode, video%d cannot to work!!\n",...);
    return -1;
}
// offline 模式：
csic_dma_mul_ch_enable(logic_id, logic_vinc->work_mode);
// → 写寄存器 MUL_CH_EN = 1，使能多通道 DMA
```

```c
if (vinc->work_mode == BK_ONLINE) {
    // online：单通道，直接读本 vipp 的中断状态
    csic_dma_int_get_status(vinc->vipp_sel, &status);
} else {
    // offline：轮询 4 个子通道（vipp_sel ~ vipp_sel+3），
    // 找到有中断的通道，切换到对应的 virtual vinc 上下文处理
    for (i = vinc->vir_prosess_ch; i < (vinc->vir_prosess_ch + 4); i++) {
        j = clamp(i ...);
        csic_dma_int_get_status(j, &status);
        vinc = vin_core_gbl[j]; // 切换到对应的 virtual vinc
        ...
    }
}
```

```c
if (vinc->work_mode == BK_OFFLINE) {
    vin_err("ve online mode need video%d work in online\n", vinc->id);
    return -1;
}
```

```plaintext
vinc00(offline) + vinc01(virtual) → camera0 出两路图（如预览 + 算法）
vinc10(offline) + vinc11(virtual) → camera1 出两路图
vinc20(offline) + vinc21(virtual) → camera2 出两路图
vinc30(offline) + vinc31(virtual) → camera3 出两路图
```

---

**User**

scaler的workmode又会影响什么？@board.dts (124-138) 要是这些scaler都被配置为work_mode = <0>会怎样？

---

**Cursor**

先读取 board.dts 的 124-138 行，同时深入分析 scaler 的 work_mode 处理逻辑：

再读取 `vipp_work_mode` 寄存器实现，以及 virtual scaler 在 online 模式下的行为细节：

现在信息已经完整，可以给出详细分析：

---

## scaler 的 `work_mode` 影响分析

### 一、枚举定义

```37:40:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/sunxi_scaler.h
enum vipp_work_mode {
	VIPP_ONLINE = 0,
	VIPP_OFFLINE = 1,
};
```

`work_mode = <1>` → `VIPP_OFFLINE`，`work_mode = <0>` → `VIPP_ONLINE`

---

### 二、`work_mode` 在各阶段的影响

#### 1. 初始化阶段 —— virtual scaler 是否注册

```937:955:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/sunxi_scaler.c
of_property_read_u32(np, "work_mode", &scaler->work_mode);
if (scaler->id == vipp_virtual_find_logic[scaler->id]) {
    // logic scaler：直接 clamp 为 VIPP_ONLINE 或 VIPP_OFFLINE
    scaler->work_mode = clamp_t(unsigned int, scaler->work_mode, VIPP_ONLINE, VIPP_OFFLINE);
} else if (scaler->work_mode == 0xff) {
    logic_scaler = glb_vipp[vipp_virtual_find_logic[scaler->id]];
    if (logic_scaler->work_mode == VIPP_ONLINE) {
        // logic scaler 是 ONLINE → virtual scaler 设 noneed_register=1，直接返回
        scaler->noneed_register = 1;
        return 0;
    }
}
```

**`VIPP_ONLINE` 模式下，virtual scaler（如 scaler01/02/03）会被标记 `noneed_register=1`，跳过完整初始化，无法独立工作。**

#### 2. stream on 阶段 —— 写入 VIPP 硬件寄存器

```416:431:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/sunxi_scaler.c
if (logic_scaler->work_mode == VIPP_ONLINE && virtual_id != logic_id) {
    // online 模式下 virtual scaler 试图 stream on → 报错拒绝
    vin_err("vipp%d work on online mode, vipp%d cannot to work!!\n",...);
    return -1;
}
// ...
vipp_work_mode(logic_scaler->id, logic_scaler->work_mode);
// 写寄存器 VIPP_WORK_MODE 位域：0=online, 1=offline
```

#### 3. s_stream enable 阶段 —— noneed_register 节点直接返回 -1

```470:476:lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin-vipp/sunxi_scaler.c
if (scaler->noneed_register) {
    if (enable && glb_vipp[vipp_virtual_find_logic[scaler->id]]->work_mode == VIPP_ONLINE
        && vipp_virtual_find_logic[scaler->id] != scaler->id) {
        vin_err("vipp%d work on online mode, vipp%d cannot to work!!\n",...);
    }
    return -1;
}
```

---

### 三、如果把 board.dts 中的 scaler 全部改为 `work_mode = <0>`，会发生什么？

当前配置（4 个 logic scaler 全是 offline）：

```124:138:device/config/chips/v853/configs/100ask/board.dts
scaler00:scaler@0  { work_mode = <1>; }   // VIPP_OFFLINE → 支持多路
scaler10:scaler@4  { work_mode = <1>; }
scaler20:scaler@8  { work_mode = <1>; }
scaler30:scaler@12 { work_mode = <1>; }
```

若改为 `work_mode = <0>`（`VIPP_ONLINE`），后果如下：

| 影响点 | 具体表现 |
|---|---|
| **virtual scaler 注册** | `scaler01/02/03`、`scaler11/12/13` 等所有 virtual scaler 在 probe 时被标记 `noneed_register=1`，跳过初始化 |
| **virtual vinc 无法出图** | 对应的 `vinc01/11/21/31`（virtual vinc）依赖 virtual scaler，scaler 不可用 → 这些 `/dev/videoX` 节点打开后 stream on 会返回 `-1` |
| **硬件寄存器** | `vipp_work_mode()` 写入 `VIPP_WORK_MODE=0`，VIPP 硬件工作在单通道 online 模式，只有 logic scaler 的通道（ch0）有效 |
| **多路出图失效** | 每个 ISP 只能输出一路图像，四路摄像头各自只剩一个可用 video 节点，多路 AI 算法同时拿图的方案无法实现 |
| **与 VINC work_mode 不匹配** | VINC 仍是 `BK_OFFLINE`（已配置），但 VIPP 变成 `VIPP_ONLINE`，pipeline 上下游模式不一致，**会导致图像异常或死锁** |

### 四、结论

`scaler work_mode = <0x1>` (VIPP_OFFLINE) 是本方案实现**多路出图**的关键配置，必须与 `vinc work_mode = <0x1>`、`tdm/isp work_mode = <1>` 保持一致，整条 pipeline 统一工作在 offline 模式。若单独将 scaler 改为 online（`<0>`），会导致 virtual scaler/vinc 无法使用，多路采集方案直接失效。

```plaintext
enum vipp_work_mode {
	VIPP_ONLINE = 0,
	VIPP_OFFLINE = 1,
};
```

```c
of_property_read_u32(np, "work_mode", &scaler->work_mode);
if (scaler->id == vipp_virtual_find_logic[scaler->id]) {
    // logic scaler：直接 clamp 为 VIPP_ONLINE 或 VIPP_OFFLINE
    scaler->work_mode = clamp_t(unsigned int, scaler->work_mode, VIPP_ONLINE, VIPP_OFFLINE);
} else if (scaler->work_mode == 0xff) {
    logic_scaler = glb_vipp[vipp_virtual_find_logic[scaler->id]];
    if (logic_scaler->work_mode == VIPP_ONLINE) {
        // logic scaler 是 ONLINE → virtual scaler 设 noneed_register=1，直接返回
        scaler->noneed_register = 1;
        return 0;
    }
}
```

```c
if (logic_scaler->work_mode == VIPP_ONLINE && virtual_id != logic_id) {
    // online 模式下 virtual scaler 试图 stream on → 报错拒绝
    vin_err("vipp%d work on online mode, vipp%d cannot to work!!\n",...);
    return -1;
}
// ...
vipp_work_mode(logic_scaler->id, logic_scaler->work_mode);
// 写寄存器 VIPP_WORK_MODE 位域：0=online, 1=offline
```

```c
if (scaler->noneed_register) {
    if (enable && glb_vipp[vipp_virtual_find_logic[scaler->id]]->work_mode == VIPP_ONLINE
        && vipp_virtual_find_logic[scaler->id] != scaler->id) {
        vin_err("vipp%d work on online mode, vipp%d cannot to work!!\n",...);
    }
    return -1;
}
```

```dts
scaler00:scaler@0  { work_mode = <1>; }   // VIPP_OFFLINE → 支持多路
scaler10:scaler@4  { work_mode = <1>; }
scaler20:scaler@8  { work_mode = <1>; }
scaler30:scaler@12 { work_mode = <1>; }
```

