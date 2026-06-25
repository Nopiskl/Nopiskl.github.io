---

**User**

@lichee/linux-4.9/drivers/media/platform/sunxi-vin/vin_test/mplane_image_userptr/csi_test_mplane.c 驱动有测试文件，请你分析一下这个测试工具如何使用？怎么实现的？

---

**Cursor**

读取测试文件：

代码已完整读取，现在给出分析。

---

## csi_test_mplane.c 分析

### 工具用途

这是全志 VIN 框架官方提供的摄像头测试程序，基于 **V4L2 Multi-plane API**（`V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE`），支持 MMAP、USERPTR、DMABUF 三种内存模式，可以采图并保存到文件，同时支持通过 `/dev/disp` 实时显示画面。

---

### 命令行参数

```
./csi_test_mplane [dev_id] [sel] [width] [height] [path] [mode] [test_cnt] [fps] [wdr_mode] [buf_type]
```

| 参数位置 | 含义 | 默认值 |
|----------|------|--------|
| argv[1] | video 设备号，如 `0` → `/dev/video0` | 0 |
| argv[2] | `VIDIOC_S_INPUT` 的 index，摄像头选择 | 0 |
| argv[3] | 采图宽度 | 640 |
| argv[4] | 采图高度 | 480 |
| argv[5] | 保存路径 | `/mnt/sdcard` |
| argv[6] | **格式 mode**（见下表） | 1 (NV12) |
| argv[7] | 采集帧数 `test_cnt` | 1 |
| argv[8] | fps | 30 |
| argv[9] | wdr_mode（0=普通，1=WDR） | 0 |
| argv[10] | buf_type（0=MMAP，1=USERPTR，2=DMABUF） | 0 |

---

### mode 参数对应格式

| mode | 像素格式 | 说明 |
|------|----------|------|
| 0 | `YUV420P` | YUV 4:2:0 planar |
| 1 | `NV12` | YUV 4:2:0 semi-planar UV |
| 2 | `NV21` | YUV 4:2:0 semi-planar VU |
| 3 | `YUV420M` | YUV 4:2:0 multi-plane |
| 4 | `NV12M` | NV12 multi-plane |
| 5 | `NV21M` | NV21 multi-plane |
| 6 | `YUV422P` | YUV 4:2:2 planar |
| 7 | `NV16` | YUV 4:2:2 semi-planar |
| 8 | `NV61` | YUV 4:2:2 semi-planar VU |
| 9 | `NV16M` | NV16 multi-plane |
| 10 | `NV61M` | NV61 multi-plane |
| 11 | `SBGGR8` | RAW Bayer 8bit |
| 12 | `SBGGR10` | RAW Bayer 10bit |
| **13** | **`SBGGR12`** | **RAW Bayer 12bit ← KW33000 应用此模式** |
| 14 | `LBC_2_5X` | 全志私有压缩格式 |

---

### 保存文件逻辑（save_flag）

`test_cnt` 的大小决定保存行为：

| test_cnt 范围 | save_flag | 行为 |
|---------------|-----------|------|
| < 20 | 0 | 只保存第 `read_num/2` 帧（分文件保存各 plane） |
| 20 ~ 999 | 1 | 每帧追加写入同一个 `.bin` 文件 |
| 1000 ~ 9999 | 3 | 不保存，只跑通 pipeline |
| ≥ 10000 | 2 | 实时显示到屏幕，不保存文件 |

保存文件名格式：
- 单 plane：`fb{dev_id}_y{mode}_{width}_{height}_{count}.bin`
- 双 plane：`fb{dev_id}_y{mode}_{w}_{h}.bin` + `fb{dev_id}_uv{mode}_{w}_{h}.bin`
- 三 plane：分别保存 Y、U、V 三个文件

---

### 针对 KW33000 的使用命令

根据前面的分析，`kw33000_mipi.c` 需要将 `mbus_code` 改为 `MEDIA_BUS_FMT_SBGGR12_1X12` 后，用 **mode=13** 测试：

```bash
# 基本采图测试（采 5 帧，保存到 /tmp）
./csi_test_mplane 0 0 672 1984 /tmp 13 5

# 采图并追加保存多帧
./csi_test_mplane 0 0 672 1984 /tmp 13 50 20

# 指定 fps=20，使用 MMAP 内存
./csi_test_mplane 0 0 672 1984 /tmp 13 5 20 0 0
```

保存产生的文件：
```
/tmp/fb0_y13_672_1984_2.bin   ← 完整 RAW12 帧数据（672×1984×2 字节）
```

---

### 内部执行流程

```
main()
  └─ main_test(sel=0, mode=13)
       ├─ camera_init()
       │    ├─ open("/dev/video0")
       │    ├─ VIDIOC_S_INPUT(0)      ← 触发 sensor_init/detect
       │    └─ VIDIOC_S_PARM(fps=20)
       ├─ camera_fmt_set(mode=13)
       │    └─ VIDIOC_S_FMT(SBGGR12, 672×1984)
       ├─ req_frame_buffers(MMAP)
       │    ├─ VIDIOC_REQBUFS(5帧)
       │    ├─ VIDIOC_QUERYBUF × 5
       │    ├─ mmap() × 5
       │    └─ VIDIOC_QBUF × 5       ← 将所有 buffer 入队
       ├─ VIDIOC_STREAMON
       ├─ 循环 read_num 次:
       │    ├─ select() 等待帧就绪
       │    └─ read_frame()
       │         ├─ VIDIOC_DQBUF     ← 取出一帧
       │         ├─ fwrite() 保存
       │         └─ VIDIOC_QBUF      ← 归还 buffer
       ├─ VIDIOC_STREAMOFF
       └─ free_frame_buffers()       ← munmap + VIDIOC_REQBUFS(0)
```

```plaintext
./csi_test_mplane [dev_id] [sel] [width] [height] [path] [mode] [test_cnt] [fps] [wdr_mode] [buf_type]
```

```shellscript
# 基本采图测试（采 5 帧，保存到 /tmp）
./csi_test_mplane 0 0 672 1984 /tmp 13 5

# 采图并追加保存多帧
./csi_test_mplane 0 0 672 1984 /tmp 13 50 20

# 指定 fps=20，使用 MMAP 内存
./csi_test_mplane 0 0 672 1984 /tmp 13 5 20 0 0
```

```plaintext
/tmp/fb0_y13_672_1984_2.bin   ← 完整 RAW12 帧数据（672×1984×2 字节）
```

```plaintext
main()
  └─ main_test(sel=0, mode=13)
       ├─ camera_init()
       │    ├─ open("/dev/video0")
       │    ├─ VIDIOC_S_INPUT(0)      ← 触发 sensor_init/detect
       │    └─ VIDIOC_S_PARM(fps=20)
       ├─ camera_fmt_set(mode=13)
       │    └─ VIDIOC_S_FMT(SBGGR12, 672×1984)
       ├─ req_frame_buffers(MMAP)
       │    ├─ VIDIOC_REQBUFS(5帧)
       │    ├─ VIDIOC_QUERYBUF × 5
       │    ├─ mmap() × 5
       │    └─ VIDIOC_QBUF × 5       ← 将所有 buffer 入队
       ├─ VIDIOC_STREAMON
       ├─ 循环 read_num 次:
       │    ├─ select() 等待帧就绪
       │    └─ read_frame()
       │         ├─ VIDIOC_DQBUF     ← 取出一帧
       │         ├─ fwrite() 保存
       │         └─ VIDIOC_QBUF      ← 归还 buffer
       ├─ VIDIOC_STREAMOFF
       └─ free_frame_buffers()       ← munmap + VIDIOC_REQBUFS(0)
```

