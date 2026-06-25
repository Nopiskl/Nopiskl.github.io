
---

**User**

为什么lichee/linux-4.9/drivers/media/platform/sunxi-vin/modules/sensor这里面的驱动一个注册get_selection回调的都没有？

---

**Cursor**

好问题，让我先验证一下这个目录里的 sensor 驱动是否真的没有注册 `get_selection`，同时看看它们的 pad_ops 注册了哪些回调。

确认了 sensor 目录下没有任何文件包含 `get_selection`。再看看这些 sensor 驱动的 pad_ops 里注册了哪些回调，以及 VIN 框架是如何处理 sensor 这一层的 selection 的：

现在信息已经非常清晰了，让我再看一下 vin_video.c 中 set_selection 的上下文，确认 sensor 层在整个 pipeline 中的位置：

现在已经有了完整的信息，可以给出详细解答：

---

## 为什么 sensor 驱动没有注册 `get_selection` 回调？

### 根本原因：**架构分层设计，crop/selection 不属于 sensor 层的职责**

整个 sunxi-vin 的图像处理 pipeline 是分层的：

```
[Sensor] → [CSI Parser] → [VIPP/Scaler] → [Video Output]
```

`selection`（裁剪）操作被刻意分配给了 pipeline 中的**中间处理节点**，而不是 sensor：

| 子设备 | 是否有 `get_selection` | 是否有 `set_selection` | 说明 |
|---|---|---|---|
| **sensor**（`modules/sensor/`） | 无 | 无 | 只负责输出原始图像 |
| **CSI Parser**（`vin-csi/sunxi_csi.c`） | 无 | 有（第 618 行） | 负责 parser 级裁剪 |
| **VIPP/Scaler**（`vin-vipp/sunxi_scaler.c`） | 有（第 662 行） | 有（第 663 行） | 负责最终的 crop + shrink |

### sensor 的职责范围

sensor 的 `pad_ops` 只注册了以下四个回调：

```c
static const struct v4l2_subdev_pad_ops sensor_pad_ops = {
    .enum_mbus_code  = sensor_enum_mbus_code,   // 枚举支持的总线格式
    .enum_frame_size = sensor_enum_frame_size,  // 枚举支持的分辨率
    .get_fmt         = sensor_get_fmt,          // 获取当前格式
    .set_fmt         = sensor_set_fmt,          // 设置格式（选择预设分辨率模式）
};
```

sensor 通过 `set_fmt` 切换内部预设的 **window mode**（如 `1920x1080`、`1280x720`），这是在寄存器级别选定 sensor 内部的输出区域，**不是软件层面的 crop**。

### 裁剪是怎么做的（调用路径）

从 `vin_video.c` 的 `vidioc_s_fmt`/`vin_set_fmt` 中可以看到，裁剪配置走的是这条路：

```
1. sensor → set_fmt        选定传感器输出分辨率（硬件 window）
2. CSI    → set_selection  对 parser 输入做裁剪（第 1351 行）
3. VIPP   → set_selection  对 scaler sink 做 crop（第 1371 行）
4. VIPP   → set_selection  对 scaler 做 shrink 缩小（第 1389 行）
```

### 总结

sensor 没有 `get_selection` 是**设计上正确的**：

1. **sensor 的"裁剪"通过 `set_fmt` 实现**，驱动内部维护预设的 `sensor_win_size` 数组，每个 mode 已经固定了输出分辨率，不需要动态 crop 接口
2. **真正的软件 crop** 由下游的 CSI Parser 和 VIPP Scaler 负责，它们才是 `selection` 的实现者
3. 这样的分层避免了 sensor 驱动的复杂性，sensor 只需关注寄存器时序和图像质量，裁剪逻辑集中在专用硬件模块中处理

```plaintext
[Sensor] → [CSI Parser] → [VIPP/Scaler] → [Video Output]
```

```c
static const struct v4l2_subdev_pad_ops sensor_pad_ops = {
    .enum_mbus_code  = sensor_enum_mbus_code,   // 枚举支持的总线格式
    .enum_frame_size = sensor_enum_frame_size,  // 枚举支持的分辨率
    .get_fmt         = sensor_get_fmt,          // 获取当前格式
    .set_fmt         = sensor_set_fmt,          // 设置格式（选择预设分辨率模式）
};
```

```plaintext
1. sensor → set_fmt        选定传感器输出分辨率（硬件 window）
2. CSI    → set_selection  对 parser 输入做裁剪（第 1351 行）
3. VIPP   → set_selection  对 scaler sink 做 crop（第 1371 行）
4. VIPP   → set_selection  对 scaler 做 shrink 缩小（第 1389 行）
```