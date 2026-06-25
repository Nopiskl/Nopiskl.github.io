**User**

@kw33000_mipi.c (348-365) 我原本的程序就算sensor_detect失败也会有打印，但是我这里一点输出都没有，请分析一下，而且不要修改任何文件

---

**Cursor**

先读取 kw33000_mipi.c 第 348 行附近的完整内容：

再查看 sensor_dbg 和 sensor_err 的宏定义，以及 VIN 框架的日志级别控制：

查看 sensor_helper.h 和 camera.h 中的宏定义：

关键证据找到了，再看 sensor_helper.h 第 40-50 行的完整条件编译：

根因完全清楚了，不需要再查任何文件。

---

## 分析结论

**为什么 `sensor_detect` 失败也没有任何打印输出？**

看 `sensor_helper.h` 第 40-44 行：

```c
#define DEV_DBG_EN   0         // ← 调试开关，默认是 0（关闭）

#if (DEV_DBG_EN == 1)
#define sensor_dbg(x, arg...) printk(KERN_DEBUG "[%s]" x, SENSOR_NAME, ## arg)
#else
#define sensor_dbg(x, arg...)  // ← DEV_DBG_EN=0 时，sensor_dbg 是空宏，什么都不输出
#endif

#define sensor_err(x, arg...) pr_err("[%s] error, " x, SENSOR_NAME, ## arg)
```

`sensor_dbg` 在 `DEV_DBG_EN=0` 时是**完全空的宏**，编译后没有任何代码。所以：

- `sensor_init` 里的 `sensor_dbg("sensor_init\n")` —— **无输出**
- `sensor_detect` 里的 `sensor_dbg("KW33000 version=0x%02x\n", ver)` —— **无输出**

而 `sensor_err` 用的是 `pr_err`，理论上应该有输出，但前提是 `sensor_detect` 被调用到了。

---

**为什么连 `sensor_err` 也没有输出？**

这说明 **`sensor_init` 根本没有被调用到**。`sensor_init` 是在 `VIDIOC_S_INPUT` 时由 VIN 框架调用的，而客户目前的测试是直接用 `v4l2-ctl --list-formats-ext`，这个命令**不触发 `VIDIOC_S_INPUT`**，它只调用 `VIDIOC_ENUM_FMT`，所以整个 `sensor_init → sensor_detect` 调用链根本没有执行。

---

## 完整调用链对比

| 操作 | 是否触发 sensor_init |
|------|---------------------|
| `v4l2-ctl --list-formats-ext` | **不触发**，只走 `VIDIOC_ENUM_FMT` |
| `camerademo` / `v4l2-ctl --set-input=0` | **触发**，走 `VIDIOC_S_INPUT → __vin_s_input → sensor_init → sensor_detect` |

所以：
1. `sensor_dbg` 没输出 → 正常，`DEV_DBG_EN=0` 时该宏为空
2. `sensor_err` 没输出 → `sensor_detect` 根本没被调用，因为 `VIDIOC_S_INPUT` 没有被执行
3. `scaler get_selection error` → `v4l2-ctl --list-formats-ext` 的枚举过程中，pipeline 未经 `S_INPUT` 初始化，scaler formats 全零，`get_selection` 返回 `-EINVAL`

**结论**：当前看到的现象完全正常，问题不在 `sensor_detect` 的打印，而在于需要先让 `VIDIOC_S_INPUT` 成功（即让 `kw33000_power.ko` 在 TCA9535 就绪后加载），之后再测试。

```c
#define DEV_DBG_EN   0         // ← 调试开关，默认是 0（关闭）

#if (DEV_DBG_EN == 1)
#define sensor_dbg(x, arg...) printk(KERN_DEBUG "[%s]" x, SENSOR_NAME, ## arg)
#else
#define sensor_dbg(x, arg...)  // ← DEV_DBG_EN=0 时，sensor_dbg 是空宏，什么都不输出
#endif

#define sensor_err(x, arg...) pr_err("[%s] error, " x, SENSOR_NAME, ## arg)
```

---

**User**

好的，printk以后输出如下@self_driver/printk_output/dmesg.log03.txt 

---

**Cursor**

日志信息非常完整，现在可以给出精确分析，不需要再查任何文件。

---

## 当前状态分析

### 好消息：S_INPUT 已经成功了

```
[35.254138] [kw33000_mipi]PWR_ON!
[35.284362] [kw33000_mipi]sensor_init
[35.288830] [kw33000_mipi]KW33000 version=0x35   ← detect 成功，版本 0x35 >= 0x0a ✅
[35.293815] [kw33000_mipi]PWR_OFF!
```

加载驱动时 `sensor_init → sensor_detect` 读到版本 `0x35`（十进制 53），满足 `>= 0x0a`，**detect 成功**。`S_INPUT` 不再失败。TCA9535 等待机制已经生效。

---

### 剩余问题：`vin_pipeline_try_format failed` + `set fmt0 error`

camerademo2 运行时：

```
[133.719303] PWR_ON!
[133.749292] sensor_init
[133.754700] KW33000 version=0x35          ← S_INPUT 成功 ✅
[133.762613] vin is not support this pixelformat  ← 连续 20 次
[133.915081] vin_pipeline_try_format failed
[133.923267] set fmt0 error
[133.930144] PWR_OFF!
```

**根本原因**：camerademo2 内部调用 `VIDIOC_S_FMT` 时传入的像素格式是 `NV21`（YUV），但 KW33000 驱动声明的 mbus 格式是 `MEDIA_BUS_FMT_Y12_1X12`（RAW 12-bit）。

VIN 框架在 `vin_pipeline_try_format` 中枚举所有 VIN 支持的输出格式，逐一调用 `vin_pixfmt_to_mbusfmt()`，每一种 YUV 格式都转换为 `MEDIA_BUS_FMT_YVYU8_2X8`，与 sensor 的 `Y12_1X12` 不匹配，打印 20 次 `vin is not support this pixelformat`，最终 `set_fmt` 失败。

---

### 日志中另一个关键信息

```
[6.798114] sunxi_i2c_do_xfer()2046 - [i2c4] incomplete xfer (status: 0x48, dev addr: 0x20)
[6.807516] pca953x 4-0020: failed writing register
```

启动时（6 秒）TCA9535 第一次 probe 仍有一次失败，但 S39mpp 的 `wait_for_tca9535` 等到 34 秒才加载 `kw33000_power.ko`，此时 TCA9535 已经就绪，所以后续完全成功。**时序问题已解决。**

---

## 现在唯一的剩余问题

camerademo2 是针对 YUV sensor 写的，**无法直接用于 RAW ToF sensor**。需要用 `v4l2-ctl` 以正确格式测试：

```bash
# 用 Y12 格式采一帧原始数据
v4l2-ctl -d /dev/video0 \
    --set-fmt-video=width=672,height=1984,pixelformat=Y12 \
    --stream-mmap \
    --stream-to=/tmp/frame.raw \
    --stream-count=1

# 或者只验证格式是否支持
v4l2-ctl -d /dev/video0 --list-formats-ext
```

如果客户坚持要用 camerademo2 测试，需要修改 camerademo2 的源码，将默认请求格式从 `V4L2_PIX_FMT_NV21` 改为 `V4L2_PIX_FMT_Y12`，分辨率设为 `672x1984`。

```plaintext
[35.254138] [kw33000_mipi]PWR_ON!
[35.284362] [kw33000_mipi]sensor_init
[35.288830] [kw33000_mipi]KW33000 version=0x35   ← detect 成功，版本 0x35 >= 0x0a ✅
[35.293815] [kw33000_mipi]PWR_OFF!
```

```plaintext
[133.719303] PWR_ON!
[133.749292] sensor_init
[133.754700] KW33000 version=0x35          ← S_INPUT 成功 ✅
[133.762613] vin is not support this pixelformat  ← 连续 20 次
[133.915081] vin_pipeline_try_format failed
[133.923267] set fmt0 error
[133.930144] PWR_OFF!
```

```plaintext
[6.798114] sunxi_i2c_do_xfer()2046 - [i2c4] incomplete xfer (status: 0x48, dev addr: 0x20)
[6.807516] pca953x 4-0020: failed writing register
```

```shellscript
# 用 Y12 格式采一帧原始数据
v4l2-ctl -d /dev/video0 \
    --set-fmt-video=width=672,height=1984,pixelformat=Y12 \
    --stream-mmap \
    --stream-to=/tmp/frame.raw \
    --stream-count=1

# 或者只验证格式是否支持
v4l2-ctl -d /dev/video0 --list-formats-ext
```

---

**User**

我执行后发现报错：
root@(none）:/home#
root@(none）:/home#
root@(none):/home#
root@(none）:/home#
root@(none):/home#
root@(none):/home#
root@(none):/home#v4l2-ctl-d/dev/video0\
--set-fmt-video=width=672,height=1984,pixelformat=Y12
--stream-mmap\
--stream-to=/tmp/frame.raw\
-stream-count=1
The pixelformat 'Y12' is invalid
root@(none）:/home#
root@(none):/home#v4l2-ctl-d/dev/video0--list-formats-ext
620.5o540o] [VIN_ERR]v4l2sub device scaler get_selection error!
ioctl:VIDIOC_ENUM_FMT[ 620.513820][VIN_ERR]v4l2 sub device scaler get_selection error!
Type: Video Capture
620.522633] [VIN_ERR]kw33000_mipi is not used,video0cannot be close!
root@(none）:/home#
是什么原因

---

**Cursor**

先查看 VIN 框架支持的像素格式和 mbus 格式转换表：

找到关键线索，查看 `vin_mbusfmt_to_pixfmt` 函数和第 6308 行附近：

关键信息找到了。再查 `vin_mbusfmt_to_pixfmt` 函数，确认 Y12 的 mbus 到 pixfmt 映射：

再查 vin_fmt_tbl 的定义，确认 VIN 框架实际注册了哪些格式：

找到了，查看 `vin_core.c` 中 `vin_formats[]` 的完整定义：

继续看 vin_formats[] 的剩余部分，找 RAW 格式：

现在已经得到了所有需要的信息，可以给出完整结论。

---

## 根本原因：`vin_formats[]` 中**没有** `MEDIA_BUS_FMT_Y12_1X12` 对应的条目

通过完整扫描 `vin_formats[]`，全志 VIN 框架支持的格式列表中：

- RAW Bayer 8/10/12bit：`SBGGR`、`SGBRG`、`SGRBG`、`SRGGB` 各种排列 ✅
- YUV 各种格式 ✅
- GREY（8-bit 灰度）`V4L2_PIX_FMT_GREY` ↔ `MEDIA_BUS_FMT_Y8_1X8` ✅
- **`V4L2_PIX_FMT_Y10` / `V4L2_PIX_FMT_Y12` —— 完全没有** ❌

`kw33000_mipi.c` 声明的 mbus 格式是 `MEDIA_BUS_FMT_Y12_1X12`，而 `vin_find_format()` 在 `vin_formats[]` 里找不到与之匹配的条目，所以：

1. `v4l2-ctl --list-formats-ext` 枚举时：`vidioc_enum_fmt` 调用 `enum_mbus_code` 得到 `MEDIA_BUS_FMT_Y12_1X12`，再调用 `vin_mbusfmt_to_pixfmt()` 转换，但该函数的 switch-case 里没有 `MEDIA_BUS_FMT_Y12_1X12` 分支，落入 `default` → 打印 `vin is not support this pixelformat` → 返回 `-EINVAL`
2. `pixelformat=Y12` 传给 `v4l2-ctl` 时：`vin_find_format()` 在 `vin_formats[]` 中找不到 `V4L2_PIX_FMT_Y12`，返回 NULL → 报 `The pixelformat 'Y12' is invalid`

---

## 解决方案：修改 `kw33000_mipi.c`，将 mbus 格式改为 VIN 框架实际支持的 RAW 12bit 格式

`vin_formats[]` 中有完整的 RAW Bayer 12bit 支持，`MEDIA_BUS_FMT_SBGGR12_1X12` 对应 `V4L2_PIX_FMT_SBGGR12`。KW33000 虽然不是 Bayer sensor，但其输出本质是 12-bit 灰度数据，选用 `SBGGR12` 作为容器格式可以让 VIN 框架正确分配 12-bit 宽的缓冲区。

修改 `kw33000_mipi.c` 中两处：

**第一处：`sensor_formats[]`**

```c
// 原来：
static struct sensor_format_struct sensor_formats[] = {
    {
        .desc      = "Raw Y 12-bit",
        .mbus_code = MEDIA_BUS_FMT_Y12_1X12,   // ← VIN 不支持
        .regs      = sensor_fmt_raw,
        .regs_size = ARRAY_SIZE(sensor_fmt_raw),
        .bpp       = 1
    },
};

// 改为：
static struct sensor_format_struct sensor_formats[] = {
    {
        .desc      = "Raw 12-bit",
        .mbus_code = MEDIA_BUS_FMT_SBGGR12_1X12,  // ← VIN 支持，fourcc: V4L2_PIX_FMT_SBGGR12
        .regs      = sensor_fmt_raw,
        .regs_size = ARRAY_SIZE(sensor_fmt_raw),
        .bpp       = 1
    },
};
```

**第二处：`sensor_g_mbus_config()`**

```c
// 保持不变，这里只是 MIPI 总线配置，不影响格式
static int sensor_g_mbus_config(struct v4l2_subdev *sd,
                                struct v4l2_mbus_config *cfg)
{
    cfg->type  = V4L2_MBUS_CSI2;
    cfg->flags = 0 | V4L2_MBUS_CSI2_1_LANE | V4L2_MBUS_CSI2_CHANNEL_0;
    return 0;
}
```

修改后，`v4l2-ctl` 测试命令改为：

```bash
# 枚举格式，应该能看到 BA12 (SBGGR12)
v4l2-ctl -d /dev/video0 --list-formats-ext

# 采图
v4l2-ctl -d /dev/video0 \
    --set-fmt-video=width=672,height=1984,pixelformat=BA12 \
    --stream-mmap \
    --stream-to=/tmp/frame.raw \
    --stream-count=1
```

`BA12` 是 `V4L2_PIX_FMT_SBGGR12` 的 fourcc 字符串，即 `vin_formats[]` 中已有的 RAW Bayer BGGR 12bit 格式。

```c
// 原来：
static struct sensor_format_struct sensor_formats[] = {
    {
        .desc      = "Raw Y 12-bit",
        .mbus_code = MEDIA_BUS_FMT_Y12_1X12,   // ← VIN 不支持
        .regs      = sensor_fmt_raw,
        .regs_size = ARRAY_SIZE(sensor_fmt_raw),
        .bpp       = 1
    },
};

// 改为：
static struct sensor_format_struct sensor_formats[] = {
    {
        .desc      = "Raw 12-bit",
        .mbus_code = MEDIA_BUS_FMT_SBGGR12_1X12,  // ← VIN 支持，fourcc: V4L2_PIX_FMT_SBGGR12
        .regs      = sensor_fmt_raw,
        .regs_size = ARRAY_SIZE(sensor_fmt_raw),
        .bpp       = 1
    },
};
```

```c
// 保持不变，这里只是 MIPI 总线配置，不影响格式
static int sensor_g_mbus_config(struct v4l2_subdev *sd,
                                struct v4l2_mbus_config *cfg)
{
    cfg->type  = V4L2_MBUS_CSI2;
    cfg->flags = 0 | V4L2_MBUS_CSI2_1_LANE | V4L2_MBUS_CSI2_CHANNEL_0;
    return 0;
}
```

```shellscript
# 枚举格式，应该能看到 BA12 (SBGGR12)
v4l2-ctl -d /dev/video0 --list-formats-ext

# 采图
v4l2-ctl -d /dev/video0 \
    --set-fmt-video=width=672,height=1984,pixelformat=BA12 \
    --stream-mmap \
    --stream-to=/tmp/frame.raw \
    --stream-count=1
```

