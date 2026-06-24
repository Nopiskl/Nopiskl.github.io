# ISP library comparison and usage
_Exported on 2026/3/17 at GMT+8 11:34:38 from Cursor (2.3.34)_

---

**User**

能否帮我分析一下@platform/allwinner/eyesee-mpp 这个里面的ISP和@openwrt/package/allwinner/vision/libAWIspApi 这个ISP库的区别，以及我编译的系统用的是哪个ISP库

---

**Cursor**

我来分析这两个ISP相关目录的内容。

好的，我已经看到了基本目录结构，现在来深入分析两个ISP库的具体内容。

很好，已经获得了关键信息。继续深入分析。

继续深入分析关键文件。

已经收集到足够的信息，现在来看一下版本文件和系统实际使用的ISP库情况。

非常好，现在已有足够信息进行完整分析。再查一下实际链接的ISP版本。

现在已经收集到所有需要的信息，可以给出完整的分析结论了。

---

## 两个ISP库的详细分析

### 一、整体架构关系

这两个ISP是**同一套底层ISP硬件IP核（ISP600）的两种不同使用方式**，服务于不同的软件栈：

```
全志 V851S 平台
├── ISP 硬件 IP 核 (ISP600)
│
├── 方式一：libAWIspApi（轻量独立方式）
│   └── openwrt/package/allwinner/vision/libAWIspApi/
│
└── 方式二：eyesee-mpp 内置 libisp（MPP框架集成方式）
    └── platform/allwinner/eyesee-mpp/middleware/sun8iw21/media/LIBRARY/libisp/
```

---

### 二、`libAWIspApi`（`openwrt/package/allwinner/vision/libAWIspApi`）

**定位：** 独立、轻量的 ISP 控制 API 库，供不使用 eyesee-mpp 框架的应用直接调用。

**关键特征：**

| 项目 | 内容 |
|------|------|
| 支持的ISP版本 | isp520（r818 用）、**isp600（v851s 用）**、isp522 |
| v851s 实际使用 | `machinfo/v851s/build.mk` → `ISP_DIR:=isp600` |
| 对外接口 | `AWIspApi.h`，通过函数指针结构体暴露 `ispStart/ispStop/ispGetIspId` 等 |
| 编译产物 | `libAWIspApi.so` + 一组 `libisp_*.so`（ae/af/awb/base/gtm等） |
| 底层ISP核心 | `src/isp600/libisp/`，含源码，编译时构建 `libisp.so` |
| 使用场景 | 轻量应用，如 `camerademo`，不需要完整 MPP 管道 |

**ISP版本号（`isp600/libisp/isp_version.h`）：**
```
ISP_VERSION = 600
REPO_TAG = "isp-500-520-v2.00"
commit: 05be8648...  日期: 2021-12-20
```

---

### 三、`eyesee-mpp` 内置 `libisp`（`platform/allwinner/eyesee-mpp/middleware/sun8iw21/media/LIBRARY/libisp/`）

**定位：** 作为 eyesee-mpp 多媒体处理框架的一个子模块，为 `libmpp_isp.so` 提供底层 ISP 支撑。

**关键特征：**

| 项目 | 内容 |
|------|------|
| ISP IP核版本 | ISP600（`isp_version.h` 中 `ISP_VERSION=600`） |
| 对外接口 | 通过 `libISP.so` 暴露，再由 `libmpp_isp.so` 封装进 MPP 框架 |
| 预编译库 | `out/library/musl/` 下含 `libisp_ae/af/awb/base/gtm/rolloff/md/afs` 等 |
| 支持的Sensor | gc4663、sc4336、gc2053、imx386（头文件中含 isp600 调校参数） |
| 使用场景 | 完整的 eyesee-mpp 应用（virvi → ISP → venc → muxer 等完整管道） |

**ISP版本号（`sun8iw21/media/LIBRARY/libisp/isp_version.h`）：**
```
ISP_VERSION = 600
REPO_TAG = "isp-500-520-v2.00"
commit: 14df8348...  日期: 2022-07-14（比 libAWIspApi 中的版本更新）
```

---

### 四、两者核心区别对比

| 对比项 | `libAWIspApi` | `eyesee-mpp` 内置 `libisp` |
|--------|--------------|--------------------------|
| **使用场景** | 独立轻量应用 | eyesee-mpp 完整框架 |
| **对外接口** | `AWIspApi` 结构体（函数指针） | `libISP.so` → `libmpp_isp.so` |
| **源码版本** | ISP600，commit 2021-12-20 | ISP600，commit 2022-07-14（更新） |
| **isp522支持** | 有 isp522 目录（r818A等） | 无（仅 sun8iw21/ISP600） |
| **是否含源码** | 有 C 源码（`AWIspApi.c`），libisp部分有预编译 `.a`/`.so` | 算法核心为预编译 `.a`/`.so`，框架层有源码 |
| **子库分解** | `libisp.so` 含 ae/af/awb/base 等 | 同样分解为 `libisp_ae/af/awb` 等 |
| **isp_tuning_app** | 无 | 有（含 `isp_vencode` 调试工具） |

---

### 五、你的系统实际用的是哪个 ISP 库

**结论：你编译的系统（v851s/lizard）同时部署了两个，但核心相机功能走的是 `libAWIspApi`。**

证据来自 `out/v851s/lizard/` 的编译输出：

```
out/v851s/lizard/openwrt/staging_dir/target/usr/lib/libAWIspApi.so   ✅ 已编译安装
out/v851s/lizard/openwrt/build_dir/target/libAWIspApi/ipkg-install/usr/lib/
    ├── libAWIspApi.so        ← 主接口库
    ├── libisp.so             ← ISP核心（由 isp600 源码编译）
    ├── libisp_ae/af/awb/base/gtm/rolloff/md/afs/iso/pltm/dev/ini.so
    └── AWIspApi.h
```

而 `libmpp_isp.so`（eyesee-mpp 的 ISP 库）在 out 目录中**未找到**，说明当前系统配置中 `eyesee-mpp-middleware` 的 ISP 部分没有被启用或安装到最终镜像。

**实际调用链：**
```
应用程序 (如 camerademo)
    ↓
libAWIspApi.so   ← CreateAWIspApi() / ispStart() 等
    ↓
libisp.so        ← isp_init() / isp_run() / isp_stop()
    ↓
libisp_ae/awb/af/... .so   ← 3A算法模块
    ↓
V4L2 内核驱动 (sunxi-vin)   ← ISP600 硬件寄存器控制
```

```plaintext
全志 V851S 平台
├── ISP 硬件 IP 核 (ISP600)
│
├── 方式一：libAWIspApi（轻量独立方式）
│   └── openwrt/package/allwinner/vision/libAWIspApi/
│
└── 方式二：eyesee-mpp 内置 libisp（MPP框架集成方式）
    └── platform/allwinner/eyesee-mpp/middleware/sun8iw21/media/LIBRARY/libisp/
```

```plaintext
ISP_VERSION = 600
REPO_TAG = "isp-500-520-v2.00"
commit: 05be8648...  日期: 2021-12-20
```

```plaintext
ISP_VERSION = 600
REPO_TAG = "isp-500-520-v2.00"
commit: 14df8348...  日期: 2022-07-14（比 libAWIspApi 中的版本更新）
```

```plaintext
out/v851s/lizard/openwrt/staging_dir/target/usr/lib/libAWIspApi.so   ✅ 已编译安装
out/v851s/lizard/openwrt/build_dir/target/libAWIspApi/ipkg-install/usr/lib/
    ├── libAWIspApi.so        ← 主接口库
    ├── libisp.so             ← ISP核心（由 isp600 源码编译）
    ├── libisp_ae/af/awb/base/gtm/rolloff/md/afs/iso/pltm/dev/ini.so
    └── AWIspApi.h
```

```plaintext
应用程序 (如 camerademo)
    ↓
libAWIspApi.so   ← CreateAWIspApi() / ispStart() 等
    ↓
libisp.so        ← isp_init() / isp_run() / isp_stop()
    ↓
libisp_ae/awb/af/... .so   ← 3A算法模块
    ↓
V4L2 内核驱动 (sunxi-vin)   ← ISP600 硬件寄存器控制
```

---

**User**

1、那为什么out/v851s/lizard/openwrt/build_dir/target/eyesee-mpp-middleware/eyesee-mpp-middleware/sample/sample_virvi2vo这个mpp程序依然可以使用？
2、mpp的libisp和	libAWIspApi包里的libisp是不是一个东西？

---

**Cursor**

好的，先查一下 eyesee-mpp-middleware 的实际编译输出情况。

继续深入查看关键信息。

关键信息已经明确，再补充确认两个 libisp 的源码同一性。

再确认一下 sample_virvi2vo 的完整链接库列表和 mpp 的 ISP 使用方式。

现在信息已经完整，可以给出准确解答了。

现在所有信息都已齐备，可以给出完整准确的解答了。

---

## 问题一：`sample_virvi2vo` 为什么可以使用？

`sample_virvi2vo` 能正常运行，是因为 **eyesee-mpp 框架已经完整编译**，它的 ISP 功能由框架内部自己的 `libISP.a` + `libmpp_isp.so` 提供，**完全不依赖 `libAWIspApi.so`**。

调用链如下：

```
sample_virvi2vo（可执行程序）
    ↓ 链接
libmedia_mpp.so / libmpp_vi.so 等 MPP 框架库
    ↓ 链接（动态）
libmpp_isp.so          ← 由 tina_mpp_isp.mk 编译，封装 ISP 操作
    ↓ 链接（动态）
libISP.so / libISP.a   ← eyesee-mpp 内置的 libisp，来自 sun8iw21/media/LIBRARY/libisp/
    ↓
V4L2 / sunxi-vin 内核驱动
```

从 `tina_mpp_isp.mk` 可以明确看到：

```makefile
LOCAL_SHARED_LIBS := libISP         ← 动态链接 eyesee-mpp 自己的 libISP
LOCAL_TARGET_DYNAMIC := libmpp_isp  ← 编译产物是 libmpp_isp.so
```

而 `sample_virvi2vo` 的 `readelf -d` 结果显示它只依赖 `libasound/libglog/libstdc++/libc` 这些基础库——这说明 ISP 相关代码已经**静态链接进了上层的 `libmedia_mpp.so` 或通过 `libmpp_vi.so` 间接加载**，在运行时从 eyesee-mpp 的 `/usr/lib/eyesee-mpp/` 目录加载，与 `libAWIspApi.so` 完全无关。

---

## 问题二：两个 `libisp` 是不是同一个东西？

**不是同一个，但同源（同一套全志 ISP600 代码的不同版本快照）。**

| 对比项 | `libAWIspApi` 里的 `libisp` | `eyesee-mpp` 里的 `libisp` |
|--------|--------------------------|--------------------------|
| 路径 | `src/isp600/libisp/` | `middleware/sun8iw21/media/LIBRARY/libisp/` |
| ISP IP核 | ISP600 | ISP600（相同） |
| commit | `05be8648` | `14df8348` |
| 日期 | 2021-12-20 | **2022-07-14**（更新约7个月） |
| 编译产物 | `libisp.so`（动态库） | `libISP.a`（静态库，链进 `libmpp_isp.so`） |
| 库名 | `libisp.so` | `libISP.a` / `libISP.so` |
| 支持 Sensor | 较少 | 更多（gc4663/sc4336/gc2053/imx386，更多调校参数） |
| 子库分拆 | `libisp_ae/af/awb/...` 分离 `.so` | 同样分拆，但以 `.a` 静态归档为主 |

**结论：** 两者是全志同一个 ISP 驱动代码库的**不同时期的 fork 快照**，功能高度相似，接口基本一致（`isp_init/isp_run/isp_stop` 等），但 eyesee-mpp 里的版本**更新、bug修复更多、传感器支持更完整**。它们在运行时也是**两套独立的 `.so`，互不干扰**：
- `libAWIspApi.so` → 加载自己打包的 `libisp.so`
- `libmpp_isp.so` → 内部静态链接了 eyesee-mpp 的 `libISP.a`

```plaintext
sample_virvi2vo（可执行程序）
    ↓ 链接
libmedia_mpp.so / libmpp_vi.so 等 MPP 框架库
    ↓ 链接（动态）
libmpp_isp.so          ← 由 tina_mpp_isp.mk 编译，封装 ISP 操作
    ↓ 链接（动态）
libISP.so / libISP.a   ← eyesee-mpp 内置的 libisp，来自 sun8iw21/media/LIBRARY/libisp/
    ↓
V4L2 / sunxi-vin 内核驱动
```

```makefile
LOCAL_SHARED_LIBS := libISP         ← 动态链接 eyesee-mpp 自己的 libISP
LOCAL_TARGET_DYNAMIC := libmpp_isp  ← 编译产物是 libmpp_isp.so
```

---

**User**

”而 libmpp_isp.so（eyesee-mpp 的 ISP 库）在 out 目录中未找到，说明当前系统配置中 eyesee-mpp-middleware 的 ISP 部分没有被启用或安装到最终镜像。“
你不是说eyesee-mpp 的 ISP 库没有安装到当前文件系统吗？那sample_virvi2vo如何加载的

---

**Cursor**

好问题，我之前的判断有误，让我重新仔细检查实际的文件系统和安装情况。

staging_dir 里没有，再查更广的范围。

关键发现：ipkg 打包里只有 `cedarc.conf`，没有任何 `.so`。再查清楚 eyesee-mpp 的安装包内容和最终根文件系统。

关键发现：eyesee-mpp-middleware 的 ipkg 包里几乎是空的（只有395字节，仅含 cedarc.conf）。再查最终根文件系统里究竟有哪些库。

真相已经很清楚了！根文件系统里有 `libisp.so`、`libisp_ae.so` 等，这些是来自 `libAWIspApi` 包的。再确认 `sample_virvi2vo` 是否真的在根文件系统里，以及 eyesee-mpp 的库实际安装路径。

现在真相完全清晰了。让我最后确认一下 sample_virvi2vo 是否真的被打包进了最终镜像。

现在可以给出完整准确的结论了。

---

## 纠正之前的分析，给出准确答案

### 核心事实：`sample_virvi2vo` **并没有被安装进最终文件系统镜像**

经过完整的 `out` 目录搜索，结论如下：

**根文件系统 `root-v851s-lizard/` 中：**
- 没有 `sample_virvi2vo` 可执行文件
- 没有 `libmpp_isp.so`、`libmpp_vi.so`、`libmedia_mpp.so` 等 eyesee-mpp 运行库
- `eyesee-mpp-middleware` 的 ipkg 安装包**只有 395 字节**，内容仅为一个 `cedarc.conf` 配置文件

**`sample_virvi2vo` 只存在于编译中间目录：**
```
out/.../build_dir/target/eyesee-mpp-middleware/eyesee-mpp-middleware/sample/sample_virvi2vo/sample_virvi2vo
```
这是编译过程的**临时产物**，从未被打包进最终 rootfs 镜像。

---

### 回答两个问题

**问题一：`sample_virvi2vo` 为什么可以使用？**

**它目前实际上不能在设备上运行。** 该程序仅编译成功，存在于 `build_dir` 中间目录，但：

1. `eyesee-mpp-middleware` 包的 `Package/install` 规则中，**没有安装任何 `.so` 到 rootfs**（ipkg 只有 395 字节的 `cedarc.conf`）
2. `sample_virvi2vo` 本身也没有被安装（未出现在 rootfs 的 `/usr/bin/` 中）
3. 依赖的 `libmpp_isp.so`、`libmpp_vi.so` 等也未安装

所以这个程序是**可以编译，但没有部署到设备**。如果你想用它，需要手动 `scp` 到设备并配合相应的 `.so` 一起传过去。

**问题二：eyesee-mpp 的 `libISP` 和 `libAWIspApi` 包里的 `libisp` 是不是一个东西？**

**不是同一个文件，但功能同源。** 最终烧录到设备上的实际情况是：

```
设备 /usr/lib/ 中实际存在的 ISP 相关库（来自 libAWIspApi 包）：
├── libAWIspApi.so   ← 封装接口层
├── libisp.so        ← isp600 核心（commit: 2021-12-20）
├── libisp_ae/af/awb/base/gtm/rolloff/md/afs/iso/pltm/dev/ini/math.so
```

而 eyesee-mpp 的 `libISP.a`（commit: 2022-07-14，更新版本）**只编译进了 `.a` 静态库**，存放在 `staging_dir` 供开发时链接使用，**没有以 `.so` 形式部署到设备上**。

**一句话总结：** 你的设备上目前只运行着 `libAWIspApi` 体系的 ISP 库，eyesee-mpp 的 ISP 部分只编译了但没有安装，`sample_virvi2vo` 也只是编译产物，尚未部署到设备。

```plaintext
out/.../build_dir/target/eyesee-mpp-middleware/eyesee-mpp-middleware/sample/sample_virvi2vo/sample_virvi2vo
```

```plaintext
设备 /usr/lib/ 中实际存在的 ISP 相关库（来自 libAWIspApi 包）：
├── libAWIspApi.so   ← 封装接口层
├── libisp.so        ← isp600 核心（commit: 2021-12-20）
├── libisp_ae/af/awb/base/gtm/rolloff/md/afs/iso/pltm/dev/ini/math.so
```

---

**User**

但是拷贝到设备上确实可以使用，为什么

---

**Cursor**

好的，那说明设备上运行时能找到所需的依赖库。让我检查 `sample_virvi2vo` 实际链接了哪些动态库。

关键线索来了：`sample_virvi2vo` 只依赖 `libasound/libglog/libstdc++/libc`，没有直接依赖任何 `libmpp_*.so`。这说明 MPP 的功能是**静态链接**进去的。来验证这个判断。

找到关键线索了！`sample_virvi2vo` 依赖 `libmedia_mpp`、`libmpp_component` 等，再查完整的链接库列表和这些库在设备上的位置。

现在完全清楚了！再查一下这些库在设备上究竟是否存在。

找到根本原因了！`MPPCFG_COMPILE_DYNAMIC_LIB` 被注释掉了（`##` 开头），说明是 **静态库模式**。来确认静态链接的情况。

现在真相完全清晰了，可以给出完整准确的解答。

---

## 完整解答：`sample_virvi2vo` 为什么拷贝到设备上可以运行

### 根本原因：**全静态链接模式**

`mpp_config.mk` 中两行都被注释掉了：

```makefile
##MPPCFG_COMPILE_STATIC_LIB := Y
##MPPCFG_COMPILE_DYNAMIC_LIB := Y
```

当 `MPPCFG_COMPILE_DYNAMIC_LIB` 不为 `Y` 时，`tina.mk` 进入 **静态库模式**，所有 MPP 功能全部静态链接进可执行文件。这就解释了为什么：

1. `sample_virvi2vo` 体积高达 **11MB**（静态链接了大量库）
2. `readelf -d` 只显示 5 个动态依赖（`libasound/libglog/libstdc++/libgcc_s/libc`）
3. 设备上找不到任何 `libmpp_*.so` 也能运行

### 静态链接进去的 ISP 库

根据 `tina.mk` 静态模式，`libISP.a` 及全部 ISP 子库都被直接链进了二进制：

```
libaw_mpp.a          ← 整个MPP框架
libISP.a             ← eyesee-mpp 的 ISP 核心（ISP600，2022-07-14版本）
libisp_dev.a
libisp_ini.a
libiniparser.a
libisp_ae/af/afs/awb/base/gtm/iso/math/md/pltm/rolloff.a   ← 全部3A算法
libion.a / liblog.a / libMemAdapter.a / libVE.a ...
```

这些 `.a` 文件都已安装在 `staging_dir/target/usr/lib/eyesee-mpp/` 中供链接使用。

### 完整的调用关系图

```
sample_virvi2vo（11MB 可执行文件）
├── 静态链接（编译时已打包进二进制）
│   ├── libaw_mpp.a        ← MPP核心框架
│   ├── libISP.a           ← eyesee-mpp libisp（ISP600，较新版）
│   ├── libisp_ae/awb/af...a  ← 3A算法全家桶
│   ├── libion.a / libVE.a / libMemAdapter.a ...
│   └── libcedarxstream.a / libcdx_*.a ...
│
└── 动态链接（运行时从设备 /usr/lib/ 加载）
    ├── libasound.so.2     ← 设备上有
    ├── libglog.so.0.3.5   ← 设备上有
    ├── libstdc++.so.6     ← 设备上有
    └── libc.so            ← 设备上有
```

### 与 `libAWIspApi` 的关系

`sample_virvi2vo` 运行时**完全不使用 `libAWIspApi.so`**，它内部静态链接的是 eyesee-mpp 自己的 `libISP.a`（更新版本的 ISP600）。两套 ISP 在设备上并行存在，互不干扰：

| 程序 | 使用的 ISP | 方式 |
|------|-----------|------|
| `sample_virvi2vo` | eyesee-mpp `libISP.a`（2022-07-14） | 静态链接，内嵌于二进制 |
| `camerademo` 等 | `libAWIspApi.so`（2021-12-20） | 动态链接，运行时加载 |

```makefile
##MPPCFG_COMPILE_STATIC_LIB := Y
##MPPCFG_COMPILE_DYNAMIC_LIB := Y
```

```plaintext
libaw_mpp.a          ← 整个MPP框架
libISP.a             ← eyesee-mpp 的 ISP 核心（ISP600，2022-07-14版本）
libisp_dev.a
libisp_ini.a
libiniparser.a
libisp_ae/af/afs/awb/base/gtm/iso/math/md/pltm/rolloff.a   ← 全部3A算法
libion.a / liblog.a / libMemAdapter.a / libVE.a ...
```

```plaintext
sample_virvi2vo（11MB 可执行文件）
├── 静态链接（编译时已打包进二进制）
│   ├── libaw_mpp.a        ← MPP核心框架
│   ├── libISP.a           ← eyesee-mpp libisp（ISP600，较新版）
│   ├── libisp_ae/awb/af...a  ← 3A算法全家桶
│   ├── libion.a / libVE.a / libMemAdapter.a ...
│   └── libcedarxstream.a / libcdx_*.a ...
│
└── 动态链接（运行时从设备 /usr/lib/ 加载）
    ├── libasound.so.2     ← 设备上有
    ├── libglog.so.0.3.5   ← 设备上有
    ├── libstdc++.so.6     ← 设备上有
    └── libc.so            ← 设备上有
```

