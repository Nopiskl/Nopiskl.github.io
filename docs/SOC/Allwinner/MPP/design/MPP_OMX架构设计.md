# MPP design analysis based on OMX
_Exported on 2026/6/4 at GMT+8 14:40:53 from Cursor (2.6.21)_

---

**User**

@agent_docs/设计模式.md @agent_docs/mpp_omx.md 请你参考这两份报告，帮我详细分析一下MPP参考OMX的设计思路，结合具体MPP源码，主要聚焦架构设计上的分析，不用管细节方面

---

**Cursor**

我会先阅读这两份报告，并结合仓库里的 MPP/OMX 相关源码做架构层面的梳理。

接下来我会定位核心组件框架、注册表、MPI 绑定和典型组件源码，用具体代码来支撑架构分析。

我还需要读取几个关键源码片段：组件接口、组件注册、系统绑定，以及 VI/VENC 组件如何通过 tunnel 串起来。

我会补充读取函数指针表定义和绑定实现的后半段，避免只凭报告推断。

前面的搜索结果不够完整，我直接按文件分段读取关键区域。

我会再确认组件接口结构体的具体行号，便于后面用源码引用说明。

我会读取 `AW_MPI_SYS_Bind` 的具体实现位置，确保对“系统层如何把组件连成 pipeline”的分析准确。

我已经掌握主要证据了，最后读取几个带行号的关键片段，方便给你精确对应到源码。

我还会快速定位 `AW_MPI_SYS_Bind` 的函数位置，这个是 MPP 对 OMX tunnel/system 思想最集中的地方。

函数名可能是 `BindExt` 为主体，我读取该处附近。

下面结合 `agent_docs/设计模式.md`、`agent_docs/mpp_omx.md` 两份报告，以及 `middleware/sun8iw21/media` 下的具体源码，从**架构设计**角度分析 eyesee-mpp 参考 OMX 的设计思路。

---

# 一、总判断：MPP 不是 OMX 实现，而是“OMX IL 思想的工程化改造版”

eyesee-mpp 并不是标准 OpenMAX IL 实现，不能直接作为标准 OMX Core 给外部 IL Client 使用。它更像是：

> 全志把 OMX IL 的核心组件模型、状态机、端口、Tunnel、Buffer、Callback 这些设计思想抽出来，重写成一套适合嵌入式 Linux / 安防摄像头场景的内部 MPP 框架。

也就是说，它借鉴的是 **OMX IL 的架构模式**，不是完全遵守 OMX 的 ABI 或规范。

可以把它理解为：

```text
标准 OMX IL：
App / IL Client
    ↓
OMX Core
    ↓
OMX Component
    ↓
Codec / Driver / Hardware

eyesee-mpp：
EyeseeCamera / EyeseeRecorder / AW_MPI_xxx
    ↓
MPP SYS / MPI
    ↓
COMP Core / MM_COMPONENTTYPE
    ↓
VI / VENC / VDEC / VO / MUX / DEMUX Component
    ↓
videoInputHw / CedarV / audioHw / VO / ION / V4L2 / ISP / VE
```

所以 MPP 参考 OMX 的重点不在“接口名字像不像”，而在于它采用了 OMX IL 最核心的几个架构理念：

1. **所有多媒体模块组件化**
2. **组件之间通过统一函数表交互**
3. **组件有统一状态机**
4. **组件有输入/输出端口**
5. **端口之间可以 Tunnel 直连**
6. **数据用统一 Buffer Header 描述**
7. **控制流和数据流异步解耦**
8. **上层 MPI 不直接关心底层组件实现**

---

# 二、MPP 中对应 OMX 的核心分层

从架构上看，eyesee-mpp 可以拆成几层：

```text
┌──────────────────────────────────────────────┐
│ App / Demo / Sample                           │
│ sample_virvi2venc2muxer 等                    │
├──────────────────────────────────────────────┤
│ Eyesee C++ API                                │
│ EyeseeCamera / EyeseeRecorder / EyeseePlayer │
├──────────────────────────────────────────────┤
│ MPI / SYS 层                                  │
│ mpi_vi.c / mpi_venc.c / mpi_sys.c            │
│ AW_MPI_VI_xxx / AW_MPI_VENC_xxx / SYS_Bind   │
├──────────────────────────────────────────────┤
│ MPP Component Core                            │
│ mm_component.c / mm_component.h              │
│ COMP_GetHandle / COMP_SetupTunnel            │
├──────────────────────────────────────────────┤
│ Component 实现层                              │
│ VideoVirVi_Component.c                       │
│ VideoEnc_Component.c                         │
│ RecRender_Component.c                        │
│ Demux_Component.c / VideoDec_Component.c     │
├──────────────────────────────────────────────┤
│ Platform / Hardware / Codec Adapter           │
│ videoInputHw.c / vencoder / audioHw / ION    │
│ V4L2 / ISP / VE / display / filesystem       │
└──────────────────────────────────────────────┘
```

如果对照 OMX，大致是：

| eyesee-mpp | OMX 中的对应思想 |
|---|---|
| `mm_component.c` | OMX Core |
| `MM_COMPONENTTYPE` | `OMX_COMPONENTTYPE` |
| `ComponentsRegistryTable.c` | OMX Core 的组件注册表 |
| `VideoVirVi_Component.c` | OMX Video Source Component |
| `VideoEnc_Component.c` | OMX Video Encoder Component |
| `RecRender_Component.c` | OMX Mux / Sink Component 思想 |
| `AW_MPI_SYS_Bind()` | `OMX_SetupTunnel()` 上层封装 |
| `COMP_BUFFERHEADERTYPE` | `OMX_BUFFERHEADERTYPE` |
| `COMP_CALLBACKTYPE` | `OMX_CALLBACKTYPE` |
| `videoInputHw.c` | Component 内部 HAL / Resource Layer |

---

# 三、第一层借鉴：Component Core —— 用统一 Core 管理所有组件

OMX IL 的一个核心思想是：应用不直接创建具体编码器、解码器、渲染器，而是通过 Core 按名字获取 Component。

标准 OMX 是：

```text
OMX_GetHandle("OMX.xxx.video.encoder")
```

MPP 中对应的是：

```text
COMP_GetHandle("OMX.CedarX.videoEncoder")
```

相关源码在：

- `middleware/sun8iw21/media/component/mm_component.c`
- `middleware/sun8iw21/media/component/ComponentsRegistryTable.c`
- `middleware/sun8iw21/media/include/component/mm_component.h`

`COMP_GetHandle()` 的设计非常像 OMX Core：  
它不关心具体组件是什么，只按组件名查注册表，然后调用对应的初始化函数。

核心逻辑是：

```40:62:middleware/sun8iw21/media/component/mm_component.c
ERRORTYPE COMP_GetHandle(
    PARAM_OUT COMP_HANDLETYPE* pHandle, 
    PARAM_IN  char* cComponentName,
    PARAM_IN  void* pAppData,
    PARAM_IN  COMP_CALLBACKTYPE* pCallBacks)
{
    ERRORTYPE eRet = SUCCESS;
    alogv("COMP CORE API - COMP_GetHandle");
    int compIndex = get_cmp_index(cComponentName);//通过组件名字获取组件索引
    if(compIndex >= 0)
    {
        COMP_HANDLETYPE compHandle;
        compHandle = (COMP_HANDLETYPE) malloc(sizeof(MM_COMPONENTTYPE));
        if (!compHandle) 
        {
            aloge("Component Creation failed");
            return ERR_COMPCORE_NOMEM;
        }
        memset(compHandle, 0, sizeof(MM_COMPONENTTYPE));
        cdx_comp_table[compIndex].comp_init_fn(compHandle);//通过组件索引获取组件的创建函数，并创建组件实例
        ((MM_COMPONENTTYPE *)compHandle)->SetCallbacks(compHandle, pCallBacks, pAppData);
        *pHandle = compHandle;
    }
```

这个设计背后的思想是：

> Core 只负责“找组件、创建组件、释放组件、建立 Tunnel”，不参与具体业务处理。

这样 VI、VENC、VDEC、MUX、VO 都可以被统一管理。

---

# 四、第二层借鉴：组件注册表 —— 静态化的 OMX Component Registry

OMX Core 通常会维护一个 Component Registry，用组件名字查找组件实现。  
MPP 也有类似机制，只不过它没有做成标准 OMX 动态加载，而是使用静态表。

源码在 `ComponentsRegistryTable.c`：

```31:83:middleware/sun8iw21/media/component/ComponentsRegistryTable.c
CDX_COMPONENTREGISTRY cdx_comp_table[] =
{
#if (MPPCFG_DEMUXER == OPTION_DEMUXER_ENABLE)
    {
        CDX_ComponentNameDemux,
        DemuxComponentInit
    },
#endif
#if (MPPCFG_VDEC == OPTION_VDEC_ENABLE)
    {
        CDX_ComponentNameVideoDecoder,
        VideoDecComponentInit
    },
#endif
#if (MPPCFG_ADEC == OPTION_ADEC_ENABLE)
    {
        CDX_ComponentNameAudioDecoder,
        AudioDecComponentInit
    },
#endif
```

后面继续注册：

- `ClockComponentInit`
- `VideoEncComponentInit`
- `AudioEncComponentInit`
- `RecRenderComponentInit`
- `AIChannel_ComponentInit`
- `AOChannel_ComponentInit`
- `VideoViComponentInit`
- `VideoIseComponentInit`
- `VideoEISComponentInit`
- `UvcComponentInit`

这个表的架构意义很大：

1. **组件发现机制统一**
2. **组件创建逻辑统一**
3. **编译期可裁剪**
4. **模块可以按配置开关增删**
5. **Core 层不依赖具体组件实现**

它和标准 OMX 的区别是：

| 项目 | 标准 OMX | eyesee-mpp |
|---|---|---|
| 注册方式 | OMX Core 动态注册 / 动态库 | 静态 C 表 |
| 组件名字 | `"OMX.xxx"` | `"OMX.CedarX.xxx"` |
| 初始化入口 | Component init function | `xxxComponentInit()` |
| 外部兼容性 | 标准 OMX IL | 内部私有框架 |
| 可裁剪性 | 依赖平台实现 | 通过 `MPPCFG_xxx` 宏裁剪 |

全志这么做的原因很现实：  
嵌入式设备上不需要完整 OMX 动态插件机制，静态表更简单、更稳定、更容易裁剪。

---

# 五、第三层借鉴：`MM_COMPONENTTYPE` —— C 语言版组件虚函数表

OMX IL 最典型的设计是 `OMX_COMPONENTTYPE`，本质是一个 C 语言函数指针表。

MPP 中对应的是 `MM_COMPONENTTYPE`。

它不是普通结构体，而是一个“组件接口对象”：

```1116:1197:middleware/sun8iw21/media/include/component/mm_component.h
typedef struct MM_COMPONENTTYPE
{
    /** pComponentPrivate is a pointer to the component private data area.
        This member is allocated and initialized by the component when the
        component is first loaded.  The application should not access this
        data area. */
    void* pComponentPrivate;

    /** pApplicationPrivate is a pointer that is a parameter to the
        OMX_GetHandle method, and contains an application private value
        provided by the IL client.  This application private data is
        returned to the IL Client by OMX in all callbacks */
    void* pApplicationPrivate;

    /** refer to OMX_SendCommand in OMX_core.h or the OMX IL
        specification for details on the SendCommand method.
     */
    ERRORTYPE (*SendCommand)(
            PARAM_IN  COMP_HANDLETYPE hComponent,
            PARAM_IN  COMP_COMMANDTYPE Cmd,
            PARAM_IN  unsigned int nParam1,
            PARAM_IN  void* pCmdData);


    /** refer to OMX_GetConfig in OMX_core.h or the OMX IL
        specification for details on the GetConfig method.
     */
    ERRORTYPE (*GetConfig)(
            PARAM_IN  COMP_HANDLETYPE hComponent,
            PARAM_IN  COMP_INDEXTYPE nIndex,
            PARAM_INOUT void* pComponentConfigStructure);
```

继续往下还有：

```1198:1290:middleware/sun8iw21/media/include/component/mm_component.h
    ERRORTYPE (*SetConfig)(
            PARAM_IN  COMP_HANDLETYPE hComponent,
            PARAM_IN  COMP_INDEXTYPE nIndex,
            PARAM_IN  void* pComponentConfigStructure);



    /** refer to OMX_GetState in OMX_core.h or the OMX IL
        specification for details on the GetState method.
     */
    ERRORTYPE (*GetState)(
            PARAM_IN  COMP_HANDLETYPE hComponent,
            PARAM_OUT COMP_STATETYPE* pState);


    /** The ComponentTunnelRequest method will interact with another OMX
        component to determine if tunneling is possible and to setup the
        tunneling.  The return codes for this method can be used to
        determine if tunneling is not possible, or if tunneling is not
        supported.
```

后面还有：

```1291:1330:middleware/sun8iw21/media/include/component/mm_component.h
    ERRORTYPE (*ComponentTunnelRequest)(
        PARAM_IN  COMP_HANDLETYPE hComp,
        PARAM_IN  unsigned int nPort,
        PARAM_IN  COMP_HANDLETYPE hTunneledComp,
        PARAM_IN  unsigned int nTunneledPort,
        PARAM_INOUT  COMP_TUNNELSETUPTYPE* pTunnelSetup);

    /** refer to OMX_EmptyThisBuffer in OMX_core.h or the OMX IL
        specification for details on the EmptyThisBuffer method.
        @ingroup buf
     */
    ERRORTYPE (*EmptyThisBuffer)(
            PARAM_IN  COMP_HANDLETYPE hComponent,
            PARAM_IN  COMP_BUFFERHEADERTYPE* pBuffer);

    /** refer to OMX_FillThisBuffer in OMX_core.h or the OMX IL
        specification for details on the FillThisBuffer method.
        @ingroup buf
     */
    ERRORTYPE (*FillThisBuffer)(
            PARAM_IN  COMP_HANDLETYPE hComponent,
            PARAM_IN  COMP_BUFFERHEADERTYPE* pBuffer);
```

这个设计非常关键。

它解决的问题是：

## 1. 用 C 实现面向对象

C 没有类、继承、多态，所以 MPP 用函数指针表模拟“虚函数表”。

不同组件内部实现完全不同：

- VI 组件从 V4L2/ISP 拿图像
- VENC 组件调用 CedarV 编码
- VDEC 组件调用解码库
- MUX 组件写文件
- VO 组件显示图像

但对 Core / SYS / MPI 来说，它们都长这样：

```text
SendCommand()
GetConfig()
SetConfig()
GetState()
ComponentTunnelRequest()
EmptyThisBuffer()
FillThisBuffer()
SetCallbacks()
ComponentDeInit()
```

这就是组件化的统一抽象。

## 2. 上层不需要知道组件类型

例如 `AW_MPI_SYS_Bind()` 不需要知道源组件到底是 VI、VDEC、ISE 还是 UVC。  
它只要拿到 `MM_COMPONENTTYPE *`，然后调用统一的 `COMP_SetupTunnel()` 即可。

## 3. 新增组件成本低

如果后续要加一个新模块，比如新的图像处理组件，只需要：

1. 实现一套 `xxxComponentInit()`
2. 填充 `MM_COMPONENTTYPE` 函数指针
3. 加到 `ComponentsRegistryTable.c`
4. 在 `mpi_sys.c` 中补充绑定关系

整体框架不用改。

---

# 六、第四层借鉴：统一状态机 —— OMX 的 Loaded / Idle / Executing / Pause

MPP 的组件状态机几乎直接来自 OMX IL：

```text
COMP_StateLoaded
COMP_StateIdle
COMP_StateExecuting
COMP_StatePause
COMP_StateWaitForResources
```

这些状态出现在 `mm_component.h` 中，语义也沿用 OMX：

- `Loaded`：组件被创建，但资源还没完全准备好
- `Idle`：资源准备完成，可以启动
- `Executing`：组件开始处理数据
- `Pause`：暂停
- `Invalid`：内部异常

架构意义是：

> 多媒体模块不是普通函数调用，而是有资源生命周期的对象。

例如编码器需要：

1. 创建通道
2. 设置参数
3. 分配 buffer
4. 初始化硬件编码器
5. 启动线程
6. 接收输入帧
7. 输出码流
8. 停止
9. 回收资源

如果没有统一状态机，上层很容易在错误时机调用接口，例如：

- 还没创建就启动
- 已经启动后修改关键参数
- buffer 没回收就销毁
- tunnel 已经建立后又修改端口格式

OMX 的状态机正是为了解决这个问题。MPP 继承了这个设计。

---

# 七、第五层借鉴：Port 模型 —— 组件不是直接相互调用，而是通过端口连接

OMX 中每个 Component 有 Port：

- Source 组件通常只有 Output Port
- Sink 组件通常只有 Input Port
- Filter 组件通常有 Input + Output
- Demux 可能有多个 Output Port
- Mux 可能有多个 Input Port

MPP 也采用这个模型。

在 `COMP_PARAM_PORTDEFINITIONTYPE` 中可以看到端口定义：

```1022:1040:middleware/sun8iw21/media/include/component/mm_component.h
typedef struct COMP_PARAM_PORTDEFINITIONTYPE {
    unsigned int nPortIndex;            /**< Port number the structure applies to, we use it to record array suffix too. */
    COMP_DIRTYPE eDir;              /**< Direction (input or output) of this port */
    BOOL bEnabled;             /**< Ports default to enabled and are enabled/disabled by
                                        OMX_CommandPortEnable/OMX_CommandPortDisable.
                                        When disabled a port is unpopulated. A disabled port
                                        is not populated with buffers on a transition to IDLE. */
    COMP_PORTDOMAINTYPE eDomain;    /**< Domain of the port. Determines the contents of metadata below. */
    union {
        COMP_AUDIO_PORTDEFINITIONTYPE audio;
        COMP_VIDEO_PORTDEFINITIONTYPE video;
    } format;
} COMP_PARAM_PORTDEFINITIONTYPE;
```

端口包含几个核心信息：

| 字段 | 作用 |
|---|---|
| `nPortIndex` | 端口编号 |
| `eDir` | 输入还是输出 |
| `bEnabled` | 是否启用 |
| `eDomain` | 音频、视频、图像、文本等 |
| `format` | 端口数据格式 |

这个设计使得组件之间的连接不是“写死函数调用”，而是：

```text
源组件输出端口 → 目标组件输入端口
```

例如：

```text
VI output port  → VENC input port
VENC output port → MUX input port
VDEC output port → VO input port
DEMUX video port → VDEC input port
DEMUX audio port → ADEC input port
ADEC output port → AO input port
```

这使得 pipeline 可以被组合，而不是固定死。

---

# 八、第六层借鉴：Tunnel 模型 —— 组件间直连，减少上层参与

OMX IL 的一大核心设计是 Tunnel。  
Tunnel 的目的不是简单“绑定”，而是让两个组件在底层直接传递 buffer，避免应用层反复搬运数据。

MPP 中的对应机制是：

- `COMP_SetupTunnel()`
- `ComponentTunnelRequest()`
- `AW_MPI_SYS_Bind()`
- `AW_MPI_SYS_UnBind()`

`COMP_SetupTunnel()` 的实现非常像 OMX：

```74:97:middleware/sun8iw21/media/component/mm_component.c
ERRORTYPE COMP_SetupTunnel(
    PARAM_IN  COMP_HANDLETYPE hOutput,
    PARAM_IN  unsigned int nPortOutput,
    PARAM_IN  COMP_HANDLETYPE hInput,
    PARAM_IN  unsigned int nPortInput)
{
    alogv("COMP CORE API - COMP_SetupTunnel %p %d %p %d", hOutput, nPortOutput, hInput, nPortInput);
    ERRORTYPE eError;
    COMP_TUNNELSETUPTYPE oTunnelSetup;
    eError = ((MM_COMPONENTTYPE *)hOutput)->ComponentTunnelRequest(hOutput, nPortOutput, hInput, nPortInput, &oTunnelSetup);
    if(eError!=SUCCESS)
    {
        aloge("fatal error! setup tunnel on output port fail[0x%x]!", eError);
        return ERR_COMPCORE_NOT_SUPPORT;
    }
    eError = ((MM_COMPONENTTYPE *)hInput)->ComponentTunnelRequest(hInput, nPortInput, hOutput, nPortOutput, &oTunnelSetup);
```

这段代码体现了 OMX Tunnel 的典型流程：

1. 先让输出组件确认能不能接这个 tunnel
2. 再让输入组件确认能不能接这个 tunnel
3. 双方都成功后，绑定建立
4. 失败则回滚

MPP 上层用户一般不直接调用 `COMP_SetupTunnel()`，而是通过 `AW_MPI_SYS_Bind()`：

```1681:1717:middleware/sun8iw21/media/mpi_sys.c
ERRORTYPE AW_MPI_SYS_Bind(MPP_CHN_S* pSrcChn, MPP_CHN_S* pDestChn)
{
    MM_COMPONENTTYPE *pSrcComp = NULL, *pDstComp = NULL;
    unsigned int srcPortIdx, dstPortIdx;
    ERRORTYPE eError = SUCCESS;

    if (pSrcChn == NULL || pDestChn == NULL) {
        return ERR_SYS_ILLEGAL_PARAM;
    }

    SYS_GetComp(pSrcChn, &pSrcComp);
    if (pSrcComp == NULL) {
        aloge("fatal error! Bind error! source component not found!");
        return FAILURE;
    }

    SYS_GetComp(pDestChn, &pDstComp);
    if (pDstComp == NULL) {
        aloge("Bind error! dest component not found!");
        return FAILURE;
    }

    eError = SYS_QueryBindRelation(pSrcChn, pDestChn);
```

后面继续：

```1718:1734:middleware/sun8iw21/media/mpi_sys.c
    if (eError == FAILURE)
    {
        aloge("Bind type error! SrcMod[0x%x], DestChn[0x%x]", pSrcChn->mModId, pDestChn->mModId);
        return FAILURE;
    }

    SYS_DecideBindPortIndex(pSrcChn, pDestChn, &srcPortIdx, &dstPortIdx, NULL);
    eError = COMP_SetupTunnel(pSrcComp, srcPortIdx, pDstComp, dstPortIdx);
    if (eError != SUCCESS)
    {
        aloge("COMP_SetupTunnel error! SrcChn[0x%x][%d][%d], DstChn[0x%x][%d][%d]",
            pSrcChn->mModId, pSrcChn->mDevId, pSrcChn->mChnId, pDestChn->mModId, pDestChn->mDevId, pDestChn->mChnId);
        return eError;
    }
```

也就是说：

```text
AW_MPI_SYS_Bind()
    ↓
SYS_GetComp()
    ↓
SYS_QueryBindRelation()
    ↓
SYS_DecideBindPortIndex()
    ↓
COMP_SetupTunnel()
    ↓
ComponentTunnelRequest()
```

这正是 OMX 的设计思想在 MPP 中的落地。

---

# 九、第七层借鉴：SYS 层承担了 OMX IL Client + System Glue 的角色

在标准 OMX 中，通常有：

```text
IL Client 负责选择组件、设置参数、建立 Tunnel、启动状态机
OMX Core 负责组件创建和管理
Component 负责实际处理
```

在 eyesee-mpp 中，这个职责被拆到了 MPI / SYS 层。

`mpi_sys.c` 主要做几件事：

## 1. 全局系统初始化

`AW_MPI_SYS_Init()` 会初始化 VI、ISP、ION、DEMUX、VDEC、VO、AENC、VENC、MUX、ISE、EIS 等模块。

架构上它相当于：

> MPP 运行时环境初始化器。

包括：

- 初始化 ISP
- 打开 ION 内存
- 构造各模块管理器
- 构造音视频组件管理对象
- 启动环境变量监控线程
- 设置全局状态

这部分比标准 OMX Core 更“系统化”，因为 MPP 要直接面对硬件资源。

## 2. 从 `MPP_CHN_S` 找到真实组件

`SYS_GetComp()` 根据模块 ID 找到对应组件：

```text
MOD_ID_VIU  → videoInputHw_GetChnComp()
MOD_ID_VENC → VENC_GetChnComp()
MOD_ID_MUX  → MUX_GetChnComp()
MOD_ID_VOU  → VO_GetChnComp()
MOD_ID_VDEC → VDEC_GetChnComp()
```

这说明 MPP 对外暴露的不是 OMX 组件名，而是更符合国产 MPP 风格的：

```text
模块 ID + 设备 ID + 通道 ID
```

也就是：

```c
MPP_CHN_S {
    mModId;
    mDevId;
    mChnId;
}
```

这其实是把 OMX 的 Component Handle 隐藏起来了。  
用户只看到 `VI_DEV`、`VI_CHN`、`VENC_CHN`、`MUX_CHN` 等概念。

## 3. 管理合法绑定关系

`mpi_sys.c` 中有 `gMppBindMapTable`，定义哪些模块可以绑定。

例如：

```text
VI   → VENC
VI   → VO
VI   → ISE
VI   → EIS
ISE  → VENC
EIS  → VENC
VENC → MUX
DEMUX → VDEC
VDEC → VO
AENC → MUX
ADEC → AO
```

这说明 MPP 并不是允许任意组件乱连，而是在 SYS 层维护了一张“合法媒体图谱”。

架构意义是：

> SYS 层是 pipeline 拓扑管理者。

它帮上层屏蔽了 OMX port 细节。

用户只需要：

```text
AW_MPI_SYS_Bind(VI, VENC)
AW_MPI_SYS_Bind(VENC, MUX)
```

不用知道：

- VI 的输出 port 是几号
- VENC 的输入 port 是几号
- MUX 当前哪个输入 port 空闲
- Demux 的视频 port / 音频 port 如何区分

这些都由 `SYS_DecideBindPortIndex()` 决定。

---

# 十、第八层借鉴：Buffer Header —— 数据不是裸指针，而是带元数据的媒体帧

OMX 中数据通过 `OMX_BUFFERHEADERTYPE` 传递。  
MPP 中对应的是 `COMP_BUFFERHEADERTYPE`。

```830:852:middleware/sun8iw21/media/include/component/mm_component.h
typedef struct COMP_BUFFERHEADERTYPE
{
    unsigned char* pBuffer;            /**< Pointer to actual block of memory
                                     that is acting as the buffer */
    unsigned int nAllocLen;          /**< size of the buffer allocated, in bytes */
    unsigned int nFilledLen;         /**< number of bytes currently in the
                                     buffer */
    unsigned int nOffset;            /**< start offset of valid data in bytes from
                                     the start of the buffer */
    void* pAppPrivate;        /**< pointer to any data the application
                                     wants to associate with this buffer */
    void* pPlatformPrivate;   /**< pointer to any data the platform
                                     wants to associate with this buffer */
    void* pInputPortPrivate;  /**< pointer to any data the input port
                                     wants to associate with this buffer */
    void* pOutputPortPrivate; /**< pointer to any data the output port
```

后面还有时间戳、flag、输入输出端口：

```853:863:middleware/sun8iw21/media/include/component/mm_component.h
                                     wants to associate with this buffer */
    int64_t nTimeStamp;       /**< Timestamp corresponding to the sample
                                     starting at the first logical sample
                                     boundary in the buffer. Timestamps of
                                     successive samples within the buffer may
                                     be inferred by adding the duration of the
                                     of the preceding buffer to the timestamp
                                     of the preceding buffer.*/
    unsigned int     nFlags;         /**< buffer specific flags */
    unsigned int nOutputPortIndex;   /**< The index of the output port (if any) using
                                     this buffer */
    unsigned int nInputPortIndex;    /**< The index of the input port (if any) using
```

架构意义是：

> 媒体数据不能只传 `void*`，必须带上长度、时间戳、flag、端口归属、私有上下文。

否则 pipeline 无法处理：

- 音视频同步
- EOS
- codec config
- key frame
- 解码但不显示帧
- buffer 复用
- tunnel 中的 buffer ownership
- 输入输出端口匹配

所以 MPP 复制了 OMX 的 Buffer Header 思想。

---

# 十一、第九层借鉴：Callback —— 控制流和数据流异步解耦

OMX 组件是异步模型。  
应用发命令后，组件内部线程处理，完成后通过 callback 通知应用。

MPP 中对应的是 `COMP_CALLBACKTYPE`：

```865:915:middleware/sun8iw21/media/include/component/mm_component.h
typedef struct COMP_CALLBACKTYPE
{
    /** The EventHandler method is used to notify the application when an
        event of interest occurs.  Events are defined in the COMP_EVENTTYPE
        enumeration.  Please see that enumeration for details of what will
        be returned for each type of event. Callbacks should not return
        an error to the component, so if an error occurs, the application
        shall handle it internally.  This is a blocking call.

        The application should return from this call within 5 msec to avoid
        blocking the component for an excessively long period of time.

        @param hComponent
            handle of the component to access.  This is the component
            handle returned by the call to the GetHandle function.
```

并包含：

- `EventHandler`
- `EmptyBufferDone`
- `FillBufferDone`

这也是 OMX 的典型三件套：

| Callback | 作用 |
|---|---|
| `EventHandler` | 通知状态变化、错误、端口变化、业务事件 |
| `EmptyBufferDone` | 输入 buffer 已消费完，可以复用 |
| `FillBufferDone` | 输出 buffer 已填充好，可以取走 |

这个设计非常适合多媒体，因为多媒体处理天然是异步的：

```text
采集线程持续出帧
编码线程持续消费帧
MUX 线程持续写文件
显示线程持续刷新
上层控制线程只是发命令
```

如果所有东西都做成同步函数调用，pipeline 很容易阻塞。

---

# 十二、第十层借鉴：Vendor Extension —— 保留 OMX 标准框架，但大量扩展私有能力

MPP 的 `COMP_INDEXTYPE` 很明显借鉴 OMX。

前半部分保留大量 OMX 标准 index，例如：

- `COMP_IndexParamPortDefinition`
- `COMP_IndexParamVideoPortFormat`
- `COMP_IndexConfigVideoBitrate`
- `COMP_IndexParamAudioPcm`
- `COMP_IndexParamCommonSensorMode`

后面则是全志私有扩展：

```text
COMP_IndexVendorViChnAttr
COMP_IndexVendorVencChnAttr
COMP_IndexVendorVencGetStream
COMP_IndexVendorMuxSwitchFd
COMP_IndexVendorIseGroupAttr
COMP_IndexVendorEisGyroAttr
COMP_IndexVendorVOChnAttr
```

这正是 OMX 的典型扩展方式：

```text
标准框架 + vendor index
```

为什么要这样设计？

因为多媒体框架一方面需要统一，另一方面每家芯片都有大量私有能力：

- ISP 参数
- VI 通道属性
- VENC 码控
- ROI
- 智能 P 帧
- 2D/3D 降噪
- ISE 鱼眼矫正
- EIS 防抖
- MUX 文件切换
- OSD
- ION buffer
- VE 频率

这些不可能全部塞进标准 OMX。  
所以 MPP 保留了 OMX 的 `Index + void* config` 模式，用 vendor index 扩展。

---

# 十三、MPP 相比 OMX 做了哪些“工程化改造”

MPP 没有完整照搬 OMX，而是根据嵌入式产品做了很多简化和改造。

## 1. 不暴露标准 OMX API，而是暴露 AW_MPI API

标准 OMX 用户会直接面对：

```text
OMX_GetHandle
OMX_SetParameter
OMX_SendCommand
OMX_EmptyThisBuffer
OMX_FillThisBuffer
```

MPP 用户面对的是：

```text
AW_MPI_VI_CreateVirChn
AW_MPI_VENC_CreateChn
AW_MPI_VENC_StartRecvPic
AW_MPI_SYS_Bind
AW_MPI_MUX_CreateChn
```

这说明 MPP 把 OMX 思想隐藏在内部，外部使用更像海思 HiMPP。

设计好处是：

- 应用开发者不用理解 OMX port
- API 更贴近摄像头业务
- 更容易移植安防应用
- 与国内 MPP 使用习惯一致

## 2. `GetParameter/SetParameter` 和 `GetConfig/SetConfig` 被合并

标准 OMX 区分：

```text
GetParameter / SetParameter
GetConfig / SetConfig
```

MPP 基本只保留：

```text
GetConfig
SetConfig
```

这是一种简化。

它牺牲了标准 OMX 的严格语义，但降低了实现复杂度。

## 3. 组件注册表静态化

标准 OMX 可以动态加载组件库。  
MPP 直接用 `ComponentsRegistryTable.c` 静态表。

这对嵌入式设备更合适：

- 启动更简单
- 可裁剪
- 依赖少
- 调试容易
- 不需要完整插件系统

## 4. SYS 层强管控 pipeline 关系

标准 OMX 中 IL Client 可以更自由地组 pipeline。  
MPP 通过 `gMppBindMapTable` 限制合法绑定关系。

这符合产品化 SDK 的设计：

- 防止用户乱连组件
- 降低错误使用概率
- 隐藏 port 细节
- 让 API 更稳定

## 5. Component 和 Hardware Manager 混合更紧

标准 OMX 概念上 Component 与底层硬件资源管理可以分开。  
MPP 中很多模块的 MPI、Component、HwManager 关系更紧。

例如 VI：

```text
mpi_vi.c
    ↓
videoInputHw.c
    ↓
VideoVirVi_Component.c
    ↓
V4L2 / ISP
```

它不是纯粹的标准 OMX Component，而是为了 Allwinner 硬件场景做了深度绑定。

---

# 十四、以 VI → VENC → MUX 为例看 MPP 的 OMX 化设计

一个典型录像 pipeline 是：

```text
VI → VENC → MUX
```

在 MPP 中上层大概做：

```text
创建 VI 虚通道
创建 VENC 通道
创建 MUX 通道
AW_MPI_SYS_Bind(VI, VENC)
AW_MPI_SYS_Bind(VENC, MUX)
启动 VI
启动 VENC
启动 MUX
```

架构上展开后是：

```text
AW_MPI_SYS_Bind(VI, VENC)
    ↓
SYS_GetComp(VI)      → VideoVirVi Component
SYS_GetComp(VENC)    → VideoEnc Component
    ↓
SYS_QueryBindRelation(VI, VENC)
    ↓
SYS_DecideBindPortIndex()
    ↓
COMP_SetupTunnel()
    ↓
VideoViComponentTunnelRequest()
VideoEncComponentTunnelRequest()
    ↓
VI 输出帧时直接 EmptyThisBuffer 到 VENC
```

然后：

```text
AW_MPI_SYS_Bind(VENC, MUX)
    ↓
SYS_GetComp(VENC)    → VideoEnc Component
SYS_GetComp(MUX)     → RecRender Component
    ↓
COMP_SetupTunnel()
    ↓
VENC 编码输出码流直接送给 MUX
```

从数据流看：

```text
V4L2 / ISP
    ↓
videoInputHw
    ↓
VideoVirVi_Component output port
    ↓ Tunnel
VideoEnc_Component input port
    ↓
CedarV / VE
    ↓
VideoEnc_Component output port
    ↓ Tunnel
RecRender_Component input port
    ↓
MP4/TS 文件
```

这就是 OMX IL 的典型 pipeline 思想，只是换成了 MPP API 和 Allwinner 私有组件。

---

# 十五、MPP 参考 OMX 的核心设计目的

## 1. 统一复杂多媒体模块

多媒体系统里有很多异构模块：

- 摄像头输入
- 音频输入
- 视频编码
- 音频编码
- 解码
- 显示
- 文件封装
- 文件解封装
- 图像处理
- 防抖
- 鱼眼矫正

如果每个模块都暴露一套完全不同的接口，框架会非常混乱。

OMX 的 Component 模型让它们统一成：

```text
组件 + 状态 + 端口 + buffer + callback
```

MPP 正是借鉴这个抽象来管理复杂性。

## 2. 支持 pipeline 拼接

安防、行车记录仪、IPC 类产品经常有多种 pipeline：

```text
VI → VENC → MUX
VI → VENC → RTSP
VI → VO
VI → ISE → VENC → MUX
VI → EIS → VENC
DEMUX → VDEC → VO
AI → AENC → MUX
```

如果没有统一的组件和端口模型，每种 pipeline 都要写一套专门逻辑。

借鉴 OMX 后，MPP 可以通过 `AW_MPI_SYS_Bind()` 构建不同媒体图。

## 3. 支持异步和实时处理

多媒体处理不能简单同步阻塞。

比如：

- VI 不能等编码器太久，否则丢帧
- VENC 不能等 MUX 写盘太久，否则码流堆积
- VO 需要按时间显示
- DEMUX / VDEC / CLOCK 需要同步

OMX 的异步命令、callback、buffer done 模型很适合这类场景。  
MPP 继承了这个模型。

## 4. 支持零拷贝或少拷贝

Tunnel 模式的关键价值是减少上层搬运。

例如 VI 到 VENC：

```text
非 Tunnel：
应用取 VI 帧
应用再送给 VENC
VENC 编码
应用再取码流
应用再送 MUX

Tunnel：
VI → VENC → MUX 内部直连
应用只控制，不搬运
```

对嵌入式视频系统来说，这很重要：

- 降低 CPU 占用
- 降低内存带宽
- 减少延迟
- 提高稳定性

## 5. 支持芯片私有扩展

全志硬件有大量私有能力，不适合完全走标准 OMX。

所以 MPP 采用：

```text
OMX 风格基础模型
+
Vendor Index
+
MPP Channel API
+
Allwinner 私有硬件适配
```

这是一种折中设计。

---

# 十六、从架构设计看，各层职责可以这样理解

## 1. `mm_component.h / mm_component.c`

对应 OMX Core + Component Interface。

职责：

- 定义组件统一接口
- 定义状态机
- 定义端口
- 定义 buffer
- 定义 callback
- 创建组件
- 释放组件
- 建立 tunnel
- 重置 tunnel

它是 MPP 内部组件框架的“内核”。

## 2. `ComponentsRegistryTable.c`

对应 OMX Component Registry。

职责：

- 维护组件名到初始化函数的映射
- 支持编译期裁剪
- 让 Core 通过名字创建组件

## 3. `mpi_sys.c`

对应 OMX IL Client + MPP System Manager 的混合层。

职责：

- 初始化全局系统资源
- 构造/析构各模块 manager
- 根据 `MPP_CHN_S` 找组件
- 判断模块之间是否允许绑定
- 决定 port index
- 调用 `COMP_SetupTunnel()`
- 管理模块拓扑

这是 MPP 比 OMX 多出来、也更产品化的一层。

## 4. `mpi_vi.c / mpi_venc.c / mpi_mux.c / ...`

对应面向用户的 MPP API 层。

职责：

- 把通道概念暴露给应用
- 隐藏 Component Handle
- 提供类似海思 MPP 的接口
- 将用户配置转换成 Component 的 `SetConfig`
- 将用户操作转换成 Component 的 `SendCommand`

## 5. `VideoVirVi_Component.c / VideoEnc_Component.c / RecRender_Component.c`

对应 OMX Component 实现层。

职责：

- 管理组件私有状态
- 管理输入输出端口
- 处理命令队列
- 启动内部线程
- 处理 buffer 输入输出
- 调用底层硬件或库
- 处理 tunnel

## 6. `videoInputHw.c / vencoder / audioHw / ion_memmanager`

对应 OMX Component 内部的硬件资源层。

职责：

- 操作 V4L2/ISP/VE/ION/Audio/Display
- 分配物理连续内存
- 与内核驱动交互
- 管理硬件 buffer
- 提供平台相关能力

---

# 十七、MPP 和 OMX 的最大区别

虽然 MPP 参考了 OMX，但它不是标准 OMX。区别主要在：

| 维度 | OMX IL | eyesee-mpp |
|---|---|---|
| 对外 API | 标准 OMX API | AW_MPI_xxx / Eyesee_xxx |
| Core | 标准 OMX Core | 私有 `COMP_Core` |
| Component Handle | 应用直接使用 | 多数被 MPI 隐藏 |
| 组件注册 | 可动态 | 静态表 |
| 参数接口 | Parameter / Config 分离 | 多数合并到 Config |
| Tunnel | 标准 OMX Tunnel | 私有 `COMP_SetupTunnel` |
| Buffer | OMX Buffer Header | COMP Buffer Header |
| 扩展 | OMX vendor extension | 大量 Allwinner vendor index |
| 使用场景 | 通用多媒体中间层 | 嵌入式摄像头/录像/播放 SDK |
| 兼容性 | 可对接标准 IL Client | 不兼容标准 OMX |

---

# 十八、总结：MPP 参考 OMX 的设计思路

可以概括为一句话：

> eyesee-mpp 借鉴 OMX IL 的组件化、状态机、端口、Tunnel、Buffer、Callback 架构，把它改造成一个更适合 Allwinner 嵌入式媒体处理的私有 MPP 框架，并在上层用 MPI API 隐藏 OMX 复杂性。

更具体地说：

1. **用 OMX Component 思想统一所有媒体模块**
   - VI、VENC、VDEC、VO、MUX、DEMUX 都是 Component。

2. **用函数指针表实现 C 语言多态**
   - 所有组件都实现 `MM_COMPONENTTYPE`。

3. **用 Core + Registry 解耦组件创建**
   - `COMP_GetHandle()` 按名字创建组件。

4. **用状态机管理资源生命周期**
   - `Loaded → Idle → Executing → Pause`。

5. **用 Port 模型表达媒体流方向**
   - 输入端口、输出端口、音频域、视频域。

6. **用 Tunnel 实现模块直连**
   - `AW_MPI_SYS_Bind()` 最终落到 `COMP_SetupTunnel()`。

7. **用 Buffer Header 统一数据描述**
   - 数据、长度、时间戳、flag、端口信息都封装起来。

8. **用 Callback 实现异步通知**
   - 事件、输入 buffer 归还、输出 buffer 完成。

9. **用 Vendor Index 扩展芯片私有能力**
   - VI/VENC/MUX/ISE/EIS/VO 都通过私有 index 扩展。

10. **用 MPI 层屏蔽 OMX 复杂性**
    - 用户面对的是 `AW_MPI_VI`、`AW_MPI_VENC`、`AW_MPI_SYS_Bind`，而不是直接操作 OMX Component。

所以，eyesee-mpp 的本质不是“实现了 OMX”，而是：

> 以 OMX IL 为底层架构蓝本，以 HiMPP 风格 MPI 为外部 API，以 Allwinner 硬件能力为底层实现，组合出来的一套私有多媒体中间件。

