# V851S 64MB DDR：CMA、开流风险与 `tmp/yolov8` 运行原因分析

本文独立整理三个问题：

- 当前 `v851s/lizard/openwrt` 构建为什么不能解释为“靠 10 MiB CMA 保证 1080P VIN/ISP + Cedar VPU + 屏显同时工作”。
- 如果上层大程序已经吃满系统 DDR，再开 VIN/VENC/VO/NPU 流是否会遇到 buffer 分配问题。
- `tmp/yolov8` 为什么能正常运行，以及它是否说明系统 DDR 余量很足。

结论先放前面：

- 当前构建的主机制不是 10 MiB CMA，而是 IOMMU/Ion/system heap 加上受控 buffer 数。
- IOMMU 解决“硬件地址连续性”问题，不解决“总 DDR 容量不足”问题。
- 如果用户态或 NPU 已经吃掉大量 DDR，再开流仍然可能在 `VIDIOC_REQBUFS`、Ion、OpenCV Mat、VENC/NPU buffer 阶段失败。
- `tmp/yolov8` 能跑，主要因为它默认是 OpenCV V4L2 640x480 输入、320x320 NPU 输入、单线程逐帧处理、没有 1080P VENC，也没有 MPP 1080P 原始帧池。
- 它能跑不代表 DDR 余量很足；更像是当前链路比较轻，峰值刚好被压住。

## 1. 当前构建不是靠 10 MiB CMA 保证媒体链路

当前最终 kernel 配置：

```text
# kernel/linux-4.9/.config
CONFIG_CMA=y
# CONFIG_DMA_CMA is not set
CONFIG_VIN_IOMMU=y
CONFIG_VIDEO_ENCODER_DECODER_SUNXI=y
CONFIG_ION=y
CONFIG_ION_SUNXI=y
CONFIG_SUNXI_IOMMU=y
CONFIG_SUNXI_MPP=y
```

这里需要区分 `CONFIG_CMA` 和 `CONFIG_DMA_CMA`：

- `CONFIG_CMA=y`：CMA 基础框架存在。
- `CONFIG_DMA_CMA=y`：Linux DMA-CMA 全局连续内存池和 `cma=` bootarg 相关逻辑才会作为 DMA-CMA 路径编译进来。

内核编译条件：

```make
# kernel/linux-4.9/drivers/base/Makefile
obj-$(CONFIG_DMA_CMA) += dma-contiguous.o
```

`cma=` 参数解析在 `dma-contiguous.c`：

```c
// kernel/linux-4.9/drivers/base/dma-contiguous.c
early_param("cma", early_cma);
```

但最终配置里：

```text
# kernel/linux-4.9/.config
# CONFIG_DMA_CMA is not set
```

所以当前这份构建不能把 `cma=10M` 当成主解释。`drivers/base/dma-contiguous.c` 不会以 `CONFIG_DMA_CMA` 路径进入内核。

板级 env 确实把 `${cma}` 拼进 bootargs：

```text
# device/config/chips/v851s/configs/lizard/env.cfg
setargs_nor=setenv bootargs ... cma=${cma} coherent_pool=${coherent_pool} ion_carveout_list=${reserve_list}
setargs_nand=setenv bootargs ... cma=${cma} ... coherent_pool=${coherent_pool} ion_carveout_list=${reserve_list}
setargs_mmc=setenv bootargs ... cma=${cma} ... coherent_pool=${coherent_pool} ion_carveout_list=${reserve_list}
```

但 lizard 正常 env 中没有实际启用的 `cma=10M` 赋值，`reserve_list` 也是注释状态：

```text
# device/config/chips/v851s/configs/lizard/env.cfg
#reserve_list=30M@64M,78M@128M,200M@512M
```

`openwrt/target/v851s/v851s-lizard/swupdate/env_ab.cfg` 中有 `cma=256M`，但这不适合 64 MiB DDR，也不是当前 `out/v851s/lizard/pack_out/env.cfg` 正常启动环境的证据。

因此，当前 SDK 不能解释为：

```text
10 MiB CMA 承载了 VIN/ISP + Cedar VPU + 屏显所有大 buffer。
```

更准确的解释是：

```text
IOMMU/Ion system heap
+ MPP bind 传递 buffer 引用
+ 控制 VIN buffer 数
+ 屏显不是 1080P framebuffer 池
+ 可选 online/LBC 压低输入侧帧池
```

如果没有 IOMMU，仅靠 10 MiB CMA 支撑 1080P NV21 采集 + 显示 + 编码是不现实的。仅 3 个 1080P NV21 buffer 就接近：

```text
1920 * 1088 * 1.5 * 3 ~= 9 MiB
```

10 MiB 即使存在，也只能作为少量物理连续 DMA 的兜底池，不可能容纳完整媒体链路的所有原始帧池和编码内部 buffer。

## 2. 上层吃满 DDR 后再开流，仍可能分配失败

会失败，而且这是 64 MiB 系统最需要管控的风险。

IOMMU 降低的是“硬件访问时需要连续地址”的难度。它不能凭空增加系统 DDR 容量。VIN、VENC、VO、NPU、OpenCV 最终都要消耗真实内存。

如果上层程序已经把可回收内存和可用页压得很低，再开流时可能在以下阶段失败：

- `VIDIOC_REQBUFS`：VIN/V4L2 buffer 申请失败。
- Ion/system heap：Cedar、NPU 或其它 DMA buffer 申请失败。
- OpenCV：`cv::Mat`、`clone()`、`resize()`、`cvtColor()` 临时内存分配失败。
- VENC：创建通道、内部参考帧、VBV/bitstream buffer 分配失败。
- 系统整体：direct reclaim 卡顿、丢帧，严重时 OOM kill。

VIN/V4L2 buffer 申请路径：

```c
// out/v851s/lizard/openwrt/build_dir/target/libAWIspApi/src/libisp/isp_dev/video.c
rb.count = pool->nbufs;
rb.type = video->type;
rb.memory = video->memtype;

ret = ioctl(video->entity->fd, VIDIOC_REQBUFS, &rb);
if (ret < 0) {
	ISP_ERR("%s: unable to request buffers (%d).\n", video->entity->devname,
	       errno);
	goto done;
}
```

Cedar Ion 分配失败路径：

```c
// kernel/linux-4.9/drivers/media/cedar-ve/codec/memory/ion_mem/ion_mem.c
node->handle = ion_alloc(client, size, align, heap_mask, flags);

if (IS_ERR_OR_NULL(node->handle)) {
	logd("ion_alloc failed, size=%d 0x%p!", size, node->handle);
	return NULL;
}
```

所以，判断能不能开流，不能只看是否有 IOMMU，也不能只看是否有 CMA。关键是开流瞬间系统还有多少可用 DDR，以及这次开流需要申请多少 buffer。

建议：

- 先开媒体流，再启动大模型或大应用，让 VIN/VENC buffer 先占住。
- 监控 `/proc/meminfo` 中的 `MemAvailable`、`Slab`、`SUnreclaim`、`Cached`。
- 优先降低 `vi_buffer_num`。
- 能用 LBC/online 就不要用普通 NV21 多 buffer。
- OpenCV 路径避免 1080P 大图 `clone()`、多队列缓存和重复颜色转换。
- 失败时看 `dmesg` 中的 `ion_alloc failed`、`VIDIOC_REQBUFS`、`vb2`、`Out of memory`。

## 3. `tmp/yolov8` 的实际运行路径

`tmp/yolov8` 的主程序没有走 1080P MPP/VENC 链路，而是：

```text
OpenCV VideoCapture -> BGR Mat -> clone/preProcess 到 320x320 -> NPU -> postProcess -> draw box -> resize 到 LCD -> BGR565 写 /dev/fb0
```

主循环代码：

```c
// tmp/yolov8/src/main.cpp
cv::VideoCapture videoCapture;

videoCapture.open(0, cv::VideoCaptureAPIs::CAP_V4L2);
...
cv::Mat frame;

while (!isDone)
{
	videoCapture >> frame;

	auto results = nnRuntime.run(
		[&frame, &yoloV8Processor]
		(int bufferIndex, void *buffer, NeuralNetworkRuntime::InputDataFormat elementDataFormat)
		{
			auto inputFrame = frame.clone();
			yoloV8Processor.preProcess(inputFrame);
			...
		}
	);

	auto detections = yoloV8Processor.postProcess(CV_32FC1, (void *)result.data());

	yoloV8Processor.drawBoundingBox(frame, detections);

	cv::resize(frame, frame, displaySize);

	cv::cvtColor(frame, frame, cv::COLOR_BGR2BGR565);

	ofs.seekp(0);
	ofs.write(reinterpret_cast<char*>(frame.data), frame.total() * frame.elemSize());
}
```

注意两个关键点：

- 它没有显式设置 `CAP_PROP_FRAME_WIDTH` 和 `CAP_PROP_FRAME_HEIGHT`，所以不是主动请求 1080P。
- 它使用的是 `main.cpp` 单线程循环，没有创建 `VideoObjectDetectionPipeline` 这个多线程 pipeline。

`VideoObjectDetectionPipeline` 虽然存在，但 `main.cpp` 没有使用它。pipeline 内部队列最大值是 1：

```c
// tmp/yolov8/src/VideoObjectDetectionPipeline.cpp
Impl(VideoObjectDetectionPipeline::Config& config) :
	yoloV8Processor(createYoloV8Processor(config)),
	nnRuntime(createNeuralNetworkRuntime(config)),
	done(false),
	preprocessQueue(1),
	inferenceQueue(1),
	resultQueue(1),
	detectionQueue(1)
{
}
```

这意味着即使使用 pipeline 版本，也不会无限堆积帧；而当前 `main.cpp` 路径更轻，因为它是顺序处理。

## 4. OpenCV V4L2 默认不是 1080P

当前 OpenCV V4L2 后端默认值：

```c
// out/v851s/lizard/openwrt/build_dir/target/opencv-4.9.0/modules/videoio/src/cap_v4l.cpp
#define DEFAULT_V4L_WIDTH  640
#define DEFAULT_V4L_HEIGHT 480
#define DEFAULT_V4L_FPS 30

#define MAX_V4L_BUFFERS 10
#define DEFAULT_V4L_BUFFERS 4
```

打开摄像头时会使用默认 640x480、4 个 buffer：

```c
// out/v851s/lizard/openwrt/build_dir/target/opencv-4.9.0/modules/videoio/src/cap_v4l.cpp
bool CvCaptureCAM_V4L::open(const char* _deviceName)
{
	...
	width = DEFAULT_V4L_WIDTH;
	height = DEFAULT_V4L_HEIGHT;
	width_set = height_set = 0;
	bufferSize = DEFAULT_V4L_BUFFERS;
	fps = DEFAULT_V4L_FPS;
	convert_rgb = true;
	...
}
```

OpenCV patch 让 V4L2 优先尝试 NV21/NV12：

```c
// out/v851s/lizard/openwrt/build_dir/target/opencv-4.9.0/modules/videoio/src/cap_v4l.cpp
__u32 try_order[] = {
	V4L2_PIX_FMT_NV21,
	V4L2_PIX_FMT_NV12,
	V4L2_PIX_FMT_YVU420,
	V4L2_PIX_FMT_YUV420,
	V4L2_PIX_FMT_YUV411P,
	V4L2_PIX_FMT_YUYV,
	V4L2_PIX_FMT_UYVY,
	V4L2_PIX_FMT_BGR24,
	V4L2_PIX_FMT_RGB24,
	...
};
```

如果 `REQBUFS` 内存不足，OpenCV 还会自动降低 V4L buffer 数：

```c
// out/v851s/lizard/openwrt/build_dir/target/opencv-4.9.0/modules/videoio/src/cap_v4l.cpp
bool CvCaptureCAM_V4L::requestBuffers()
{
	unsigned int buffer_number = bufferSize;
	while (buffer_number > 0) {
		if (requestBuffers(buffer_number) && req.count >= buffer_number)
		{
			break;
		}

		buffer_number--;
		CV_LOG_DEBUG(NULL, "VIDEOIO(V4L2:" << deviceName << "): Insufficient buffer memory -- decreasing buffers: " << buffer_number);
	}
	if (buffer_number < 1) {
		CV_LOG_WARNING(NULL, "VIDEOIO(V4L2:" << deviceName << "): Insufficient buffer memory");
		return false;
	}
	bufferSize = req.count;
	return true;
}
```

OpenCV 还会申请两个 special buffer，用于原始格式和 RGB/BGR 转换：

```c
// out/v851s/lizard/openwrt/build_dir/target/opencv-4.9.0/modules/videoio/src/cap_v4l.cpp
if (maxLength > 0) {
	maxLength *= num_planes;
	buffers[MAX_V4L_BUFFERS].memories[MEMORY_ORIG].start = malloc(maxLength);
	buffers[MAX_V4L_BUFFERS].memories[MEMORY_ORIG].length = maxLength;
	buffers[MAX_V4L_BUFFERS].memories[MEMORY_RGB].start = malloc(maxLength);
	buffers[MAX_V4L_BUFFERS].memories[MEMORY_RGB].length = maxLength;
}
```

对 640x480 来说，这些 buffer 都是 MiB 以下或一两 MiB 级别，不是 1080P 级别。

## 5. NPU 输入是 320x320，不是原始摄像头分辨率

`tmp/yolov8` 主程序把 YOLO 输入设成 320x320：

```c
// tmp/yolov8/src/main.cpp
YoloV8Processor::Config yoloV8ProcessorConfig = {
	.classes = std::move(classes),
	.imgSize = {320, 320},
};
```

预处理会把图缩放/pad 到目标尺寸：

```c
// tmp/yolov8/src/YoloV8Processor.cpp
void preProcess(cv::Mat &img)
{
	int imgHeight = img.rows;
	int imgWidth = img.cols;

	if (imgHeight == config.imgSize.height && imgWidth == config.imgSize.width) {
		return;
	}

	scaleRatio = min( (float)config.imgSize.height / imgHeight, (float)config.imgSize.width / imgWidth);
	scaleRatio = min(scaleRatio, 1.0f);

	int unpaddedImgHeight = static_cast<int>(round(imgHeight * scaleRatio));
	int unpaddedImgWidth = static_cast<int>(round(imgWidth * scaleRatio));

	if (scaleRatio <= 1.0f)
	{
		cv::Size unpaddedImgSize(unpaddedImgWidth, unpaddedImgHeight);
		cv::resize(img, img, unpaddedImgSize);
	}

	heightPadding = config.imgSize.height - unpaddedImgHeight;
	widthPadding = config.imgSize.width - unpaddedImgWidth;
	...
	cv::copyMakeBorder(img, img, top, bottom, left, right, cv::BORDER_CONSTANT, value);
}
```

内存量级：

```text
640x480 BGR frame ~= 640 * 480 * 3 = 0.88 MiB
320x320 BGR input ~= 320 * 320 * 3 = 0.29 MiB
```

这和 1080P BGR 帧完全不是一个量级：

```text
1920x1080 BGR ~= 5.93 MiB
```

## 6. NPU 内存池和启动峰值

默认 NPU/VIPlite 内存池是 17 MiB：

```c
// tmp/yolov8/src/include/NeuralNetworkRuntime.hpp
struct Config
{
	bool isAutoInit = true;
	std::string modelFilePath = "";
	unsigned int memSize = 17 * 1024 * 1024;
};
```

命令行第三个参数可以覆盖：

```c
// tmp/yolov8/src/main.cpp
if (argc > 3) {
	nnRuntimeConfig.memSize = static_cast<unsigned int>(std::stoul(argv[3]));
}
```

创建时调用 `vip_init(config.memSize)`：

```c
// tmp/yolov8/src/NeuralNetworkRuntime.cpp
vip_status_e status = vip_init(config.memSize);
CHECK_VIP_STATUS(status);
```

然后从模型查询输入/输出参数并创建 NPU buffer：

```c
// tmp/yolov8/src/NeuralNetworkRuntime.cpp
status = vip_query_network(network, VIP_NETWORK_PROP_INPUT_COUNT, &inputCount);
...
status = vip_create_buffer(&bufferCreateParams, sizeof(bufferCreateParams), &inputBuffer);
...
status = vip_query_network(network, VIP_NETWORK_PROP_OUTPUT_COUNT, &outputCount);
...
status = vip_create_buffer(&bufferCreateParams, sizeof(bufferCreateParams), &outputBuffer);
```

启动阶段有一个额外峰值：程序会 `malloc(file_size)` 把整个模型读入内存，创建 network 后释放。

```c
// tmp/yolov8/src/NeuralNetworkRuntime.cpp
int file_size = get_file_size(config.modelFilePath.c_str());
...
void *networkBuffer = malloc(file_size);
load_file(config.modelFilePath.c_str(), networkBuffer);
status = vip_create_network(networkBuffer, file_size, VIP_CREATE_NETWORK_FROM_MEMORY, &network);
free(networkBuffer);
```

因此：

```text
启动峰值 ~= 稳定运行态 + 模型文件大小
稳定运行态 ~= VIPlite memSize + NPU input/output buffers + OpenCV/V4L2 buffers + Mat 临时对象 + 共享库/堆栈
```

如果模型文件很大，启动阶段比运行阶段更容易失败。

## 7. `tmp/yolov8` 稳定态内存量级估算

按默认路径粗估：

```text
VIPlite pool                       17-20 MiB
V4L2 640x480 NV21 4 buffers         ~1.8 MiB
OpenCV special ORIG/RGB buffers     ~1-2 MiB 级
当前 BGR frame                      ~0.9 MiB
clone + 320x320 preprocess          ~0.3-0.9 MiB 峰值
fb0 输出 480x800 BGR565             ~0.7 MiB
NPU output + result vector          视模型输出，通常 MiB 级
OpenCV/libstdc++/VIPlite 共享库      若干 MiB
```

这条链路能跑，是因为它避免了以下大头：

- 没有 1080P 采集。
- 没有 1080P VENC。
- 没有 MPP 1080P 3/5/8 帧原始帧池。
- 没有多线程无限积压 Mat。
- NPU 输入被压到 320x320。

所以它的正常运行不等于 DDR 余量很足。更准确的判断是：

```text
tmp/yolov8 正常运行说明当前 640x480 + 320x320 NPU + 17/20 MiB VIPlite pool 的组合还能放进 64 MiB；
但不说明再叠加 1080P VIN/VENC 后仍然安全。
```

## 8. 和 1080P MPP/VENC 的差别

`tmp/yolov8` 默认摄像头路径：

```text
640x480 NV21 V4L2 buffers ~= 1.8 MiB
640x480 BGR Mat           ~= 0.9 MiB
320x320 input Mat         ~= 0.3 MiB
```

1080P MPP/VENC 路径：

```text
1080P NV21 3 buffers ~= 9 MiB
1080P NV21 5 buffers ~= 15 MiB
1080P BGR Mat        ~= 5.9 MiB / copy
```

如果把 `tmp/yolov8` 改成 1080P OpenCV 输入，压力会快速上升，尤其是：

```c
// tmp/yolov8/src/main.cpp
auto inputFrame = frame.clone();
```

在 640x480 下，一份 BGR clone 不到 1 MiB；在 1080P 下，一份 BGR clone 接近 6 MiB。如果再有 resize/cvtColor 临时 Mat 或队列缓存，64 MiB 下很容易逼近极限。

## 9. 如何判断是否真的有 DDR 余量

板上建议同时观察：

```sh
cat /proc/meminfo
dmesg | grep -Ei "oom|ion|alloc|vb2|reqbuf|vip"
```

重点看：

```text
MemAvailable
Slab
SUnreclaim
Cached
```

经验判断：

- `MemAvailable` 长期只有几 MiB：能跑但余量薄，后续开流风险高。
- `MemAvailable` 还有十几 MiB以上：相对舒服，但仍要看启动峰值和模型文件大小。
- dmesg 有 `ion_alloc failed`、`VIDIOC_REQBUFS`、`vb2`、`Out of memory`：说明已经撞到实际分配边界。

更可靠的验证方法：

```sh
# 启动前
cat /proc/meminfo

# 启动 tmp/yolov8 后稳定 10 秒
cat /proc/meminfo

# 再开 VIN/VENC 或其它大程序后
cat /proc/meminfo
dmesg | tail -100
```

如果模型文件很大，还要观察启动瞬间是否有 OOM 或 `vip_create_network`/`vip_prepare_network` 失败。

## 10. 总结

`tmp/yolov8` 能跑的直接原因：

- OpenCV V4L2 默认 640x480，不是 1080P。
- 默认 V4L buffer 是 4 个，不够时 OpenCV 会尝试降低数量。
- NPU 输入是 320x320。
- 主程序是单线程逐帧处理，不堆多帧 Mat。
- 没有 1080P VENC 和 MPP 大帧池。
- VIPlite 内存池默认 17 MiB，可传参到 20 MiB，但这是固定吃掉的 DDR。

它不代表 DDR 很宽裕。它只能说明当前小分辨率 OpenCV + 320x320 NPU 推理链路可以放进 64 MiB。若叠加 1080P VIN/VENC、1080P OpenCV、更多 clone/队列，或者模型文件启动峰值较大，仍然可能遇到 buffer 分配失败。
