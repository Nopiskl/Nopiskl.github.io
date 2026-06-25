# AOSP codec2 框架分析
下面按 `MediaCodec codec = MediaCodec.createDecoderByType("video/avc");` 这条实际调用链，结合当前代码树里的源码，分析从 App 到 AOSP 软件 Codec2 解码器的完整过程。
---
## 一、App 层入口
应用代码通常是这样开始的：
```java
MediaCodec codec = MediaCodec.createDecoderByType("video/avc");
```
这里的 `video/avc` 只是 **MIME type**，表示“我要一个能解 AVC 的 decoder”，并不是具体组件名。
Java 层对应代码在 `frameworks/base/media/java/android/media/MediaCodec.java`：
```2007:2010:android14/frameworks/base/media/java/android/media/MediaCodec.java
public static MediaCodec createDecoderByType(@NonNull String type)
        throws IOException {
    return new MediaCodec(type, true /* nameIsType */, false /* encoder */);
}
```
这一步的含义很简单：
- `name = "video/avc"`
- `nameIsType = true`
- `encoder = false`
也就是说，后面 native 层需要根据 MIME 去找匹配的 decoder。
---
## 二、JNI 层：转到 `MediaCodec::CreateByType()`
JNI 里真正做分流的是 `JMediaCodec::JMediaCodec(...)`：
```210:232:android14/frameworks/base/media/jni/android_media_MediaCodec.cpp
JMediaCodec::JMediaCodec(
        JNIEnv *env, jobject thiz,
        const char *name, bool nameIsType, bool encoder, int pid, int uid)
    : mClass(NULL),
      mObject(NULL) {
    ...
    if (nameIsType) {
        mCodec = MediaCodec::CreateByType(mLooper, name, encoder, &mInitStatus, pid, uid);
        if (mCodec == nullptr || mCodec->getName(&mNameAtCreation) != OK) {
            mNameAtCreation = "(null)";
        }
    } else {
        mCodec = MediaCodec::CreateByComponentName(mLooper, name, &mInitStatus, pid, uid);
        mNameAtCreation = name;
    }
}
```
因为这里 `nameIsType=true`，所以最终进入：
```cpp
MediaCodec::CreateByType(mLooper, "video/avc", false, ...)
```
到这一步，framework 才开始真正查 codec 列表。
---
## 三、`MediaCodec::CreateByType()`：先找候选，再逐个尝试
关键代码在 `frameworks/av/media/libstagefright/MediaCodec.cpp`：
```144:173:android14/frameworks/av/media/libstagefright/MediaCodec.cpp
sp<MediaCodec> MediaCodec::CreateByType(
        const sp<ALooper> &looper, const AString &mime, bool encoder, status_t *err, pid_t pid,
        uid_t uid, sp<AMessage> format) {
    Vector<AString> matchingCodecs;
    MediaCodecList::findMatchingCodecs(
            mime.c_str(),
            encoder,
            0,
            format,
            &matchingCodecs);
    if (err != NULL) {
        *err = NAME_NOT_FOUND;
    }
    for (size_t i = 0; i < matchingCodecs.size(); ++i) {
        sp<MediaCodec> codec = new MediaCodec(looper, pid, uid);
        AString componentName = matchingCodecs[i];
        status_t ret = codec->init(componentName);
        if (err != NULL) {
            *err = ret;
        }
        if (ret == OK) {
            return codec;
        }
        ALOGD("Allocating component '%s' failed (%d), try next one.",
                componentName.c_str(), ret);
    }
    return NULL;
}
```
这段逻辑要分成两部分理解。
### 1. `findMatchingCodecs()` 负责找“候选组件名列表”
它返回的是一个 `Vector<AString>`，每一项都是一个**具体 codec 组件名**。
比如对 `video/avc`，候选可能包括：
- `c2.android.avc.decoder`
- `OMX.google.h264.decoder`
- 某个厂商 AVC decoder 组件名
### 2. 后面的 `for` 循环负责“逐个初始化尝试”
它的职责不是排序，也不是再次筛选，而是：
- 依次取出 `matchingCodecs[i]`
- 新建一个 `MediaCodec`
- 调 `codec->init(componentName)`
- 谁先成功，就返回谁
- 如果失败，就继续尝试下一个候选组件
所以你问的这段 `for`，本质上是一个 **fallback 机制**：
> `findMatchingCodecs()` 决定候选顺序；`for` 循环按这个顺序一个个尝试，直到有组件成功初始化。
---
## 四、`findMatchingCodecs()` 具体怎么排序
`MediaCodecList.cpp` 中核心实现如下：
```342:384:android14/frameworks/av/media/libstagefright/MediaCodecList.cpp
void MediaCodecList::findMatchingCodecs(
        const char *mime, bool encoder, uint32_t flags, const sp<AMessage> &format,
        Vector<AString> *matches) {
    matches->clear();
    const sp<IMediaCodecList> list = getInstance();
    if (list == nullptr) {
        return;
    }
    size_t index = 0;
    for (;;) {
        ssize_t matchIndex =
            list->findCodecByType(mime, encoder, index);
        if (matchIndex < 0) {
            break;
        }
        index = matchIndex + 1;
        const sp<MediaCodecInfo> info = list->getCodecInfo(matchIndex);
        CHECK(info != nullptr);
        AString componentName = info->getCodecName();
        if (!codecHandlesFormat(mime, info, format)) {
            continue;
        }
        if ((flags & kHardwareCodecsOnly) && isSoftwareCodec(componentName)) {
            continue;
        }
        matches->push(componentName);
    }
    if (flags & kPreferSoftwareCodecs ||
            property_get_bool("debug.stagefright.swcodec", false)) {
        matches->sort(compareSoftwareCodecsFirst);
    }
}
```
这里的排序来源有两层。
### 第一层：默认顺序来自全局 `MediaCodecList`
`findMatchingCodecs()` 本身并没有写“硬解优先”或者“软解优先”。
它调用的是：
```cpp
list->findCodecByType(mime, encoder, index)
```
也就是说，它是沿着全局 `IMediaCodecList` 内部已有的顺序往后找。
而这个全局列表在构建完成后，会先按 `rank` 做稳定排序：
```194:208:android14/frameworks/av/media/libstagefright/MediaCodecList.cpp
writer.writeGlobalSettings(mGlobalSettings);
writer.writeCodecInfos(&mCodecInfos);
std::stable_sort(
        mCodecInfos.begin(),
        mCodecInfos.end(),
        [](const sp<MediaCodecInfo> &info1, const sp<MediaCodecInfo> &info2) {
            return info1 == nullptr
                    || (info2 != nullptr && info1->getRank() < info2->getRank());
        });
```
所以默认情况下：
> `findMatchingCodecs()` 的顺序，首先取决于全局 codec 列表的 `rank` 顺序。
因此原来那种“固定硬解优先、软解其次”的写法是不准确的。
### 第二层：特定条件下会把软件 codec 前置
只有在下面任一条件成立时：
- `flags & kPreferSoftwareCodecs`
- `debug.stagefright.swcodec=true`
才会额外调用：
```cpp
matches->sort(compareSoftwareCodecsFirst)
```
排序规则在这里：
```319:337:android14/frameworks/av/media/libstagefright/MediaCodecList.cpp
static int compareSoftwareCodecsFirst(const AString *name1, const AString *name2) {
    bool isSoftwareCodec1 = MediaCodecList::isSoftwareCodec(*name1);
    bool isSoftwareCodec2 = MediaCodecList::isSoftwareCodec(*name2);
    if (isSoftwareCodec1 != isSoftwareCodec2) {
        return isSoftwareCodec2 - isSoftwareCodec1;
    }
    bool isC2_1 = name1->startsWithIgnoreCase("c2.");
    bool isC2_2 = name2->startsWithIgnoreCase("c2.");
    if (isC2_1 != isC2_2) {
        return isC2_2 - isC2_1;
    }
    bool isOMX1 = name1->startsWithIgnoreCase("OMX.");
    bool isOMX2 = name2->startsWithIgnoreCase("OMX.");
    return isOMX2 - isOMX1;
}
```
也就是：
1. 软件 codec 在前
2. 同为软件 codec 时，`c2.*` 在前
3. 再不分出来时，`OMX.*` 在前
软件 codec 的判断规则是：
```313:317:android14/frameworks/av/media/libstagefright/MediaCodecList.cpp
bool MediaCodecList::isSoftwareCodec(const AString &componentName) {
    return componentName.startsWithIgnoreCase("OMX.google.")
            || componentName.startsWithIgnoreCase("c2.android.")
            || (!componentName.startsWithIgnoreCase("OMX.")
                    && !componentName.startsWithIgnoreCase("c2."));
}
```
所以像 `c2.android.avc.decoder` 会被判定为软件 codec。
---
## 五、`codec->init(componentName)`：从“组件名”走向“真实组件”
当 `for` 循环拿到一个候选组件名后，会进入：
```cpp
codec->init(componentName)
```
`MediaCodec::init()` 的关键部分如下：
```1886:1939:android14/frameworks/av/media/libstagefright/MediaCodec.cpp
status_t MediaCodec::init(const AString &name) {
    ...
    mCodecInfo.clear();
    bool secureCodec = false;
    const char *owner = "";
    if (!name.startsWith("android.filter.")) {
        err = mGetCodecInfo(name, &mCodecInfo);
        if (err != OK) {
            return err;
        }
        if (mCodecInfo == nullptr) {
            return NAME_NOT_FOUND;
        }
        secureCodec = name.endsWith(".secure");
        ...
        owner = mCodecInfo->getOwnerName();
    }
    mCodec = mGetCodecBase(name, owner);
    if (mCodec == NULL) {
        return NAME_NOT_FOUND;
    }
```
这一步至少完成了三件事：
1. 通过 `mGetCodecInfo(name, &mCodecInfo)` 把组件名映射回 `MediaCodecInfo`；
2. 通过 `mCodecInfo->getOwnerName()` 取出 owner；
3. 通过 `mGetCodecBase(name, owner)` 决定底层走 `CCodec` 还是 `ACodec`。
如果这个组件名是 `c2.android.avc.decoder`，那么这里通常会走到 `CCodec` 路径。
---
## 六、`MediaCodec` 进入 `CCodec` 路径
`MediaCodec` 完成 `mCodec` 选择后，会发起初始化消息：
```1972:1978:android14/frameworks/av/media/libstagefright/MediaCodec.cpp
sp<AMessage> msg = new AMessage(kWhatInit, this);
if (mCodecInfo) {
    msg->setObject("codecInfo", mCodecInfo);
}
msg->setString("name", name);
```
后面在 `kWhatInit` 分支里，重新组装参数并调用：
```4354:4382:android14/frameworks/av/media/libstagefright/MediaCodec.cpp
...
sp<RefBase> codecInfo;
(void)msg->findObject("codecInfo", &codecInfo);
AString name;
CHECK(msg->findString("name", &name));
sp<AMessage> format = new AMessage;
if (codecInfo) {
    format->setObject("codecInfo", codecInfo);
}
format->setString("componentName", name);
mCodec->initiateAllocateComponent(format);
```
如果底层是 `CCodec`，这里就进入 Codec2 路径。
---
## 七、`CCodec::allocate()`：真正按组件名创建 Codec2 组件
最关键的代码在 `CCodec.cpp`：
```735:759:android14/frameworks/av/media/codec2/sfplugin/CCodec.cpp
void CCodec::allocate(const sp<MediaCodecInfo> &codecInfo) {
    if (codecInfo == nullptr) {
        mCallback->onError(UNKNOWN_ERROR, ACTION_CODE_FATAL);
        return;
    }
    ALOGD("allocate(%s)", codecInfo->getCodecName());
    mClientListener.reset(new ClientListener(this));
    AString componentName = codecInfo->getCodecName();
    std::shared_ptr<Codec2Client> client;
    client = Codec2Client::CreateFromService("default");
    ...
    std::shared_ptr<Codec2Client::Component> comp;
    c2_status_t status = Codec2Client::CreateComponentByName(
            componentName.c_str(),
            mClientListener,
            &comp,
            &client);
```
注意这里：
```cpp
AString componentName = codecInfo->getCodecName();
Codec2Client::CreateComponentByName(componentName.c_str(), ...)
```
这说明最开始 `MediaCodecList` 选出来的具体组件名，最终会被原样送到底层 Codec2 client / service，用来真正创建对应组件。
---
## 八、以 AOSP 软件 AVC 解码器为例
如果最终选中的组件名是：
- `c2.android.avc.decoder`
那么它的源码定义在：
```33:35:android14/frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp
constexpr size_t kMinInputBufferSize = 2 * 1024 * 1024;
constexpr char COMPONENT_NAME[] = "c2.android.avc.decoder";
constexpr uint32_t kDefaultOutputDelay = 8;
```
平台 store 中登记了对应的 so：
```1075:1087:android14/frameworks/av/media/codec2/vndk/C2Store.cpp
emplace("libcodec2_soft_aacdec.so");
...
emplace("libcodec2_soft_avcdec.so");
emplace("libcodec2_soft_avcenc.so");
...
emplace("libcodec2_soft_hevcdec.so");
```
按名字查找 component：
```1175:1197:android14/frameworks/av/media/codec2/vndk/C2Store.cpp
c2_status_t C2PlatformComponentStore::findComponent(
        C2String name, std::shared_ptr<ComponentModule> *module) {
    (*module).reset();
    visitComponents();
    auto pos = mComponentNameToPath.find(name);
    if (pos != mComponentNameToPath.end()) {
        return mComponents.at(pos->second).fetchModule(module);
    }
    return C2_NOT_FOUND;
}
```
而具体 so 通过 factory 导出：
```1063:1073:android14/frameworks/av/media/codec2/components/avc/C2SoftAvcDec.cpp
extern "C" ::C2ComponentFactory* CreateCodec2Factory() {
    return new ::android::C2SoftAvcDecFactory();
}
extern "C" void DestroyCodec2Factory(::C2ComponentFactory* factory) {
    delete factory;
}
```
所以完整落点就是：
```text
c2.android.avc.decoder
  -> libcodec2_soft_avcdec.so
  -> C2SoftAvcDecFactory
  -> C2SoftAvcDec
```
---
## 九、把这条链路串成一句完整的话
当 App 调用：
```java
MediaCodec codec = MediaCodec.createDecoderByType("video/avc");
```
framework 会先通过 `MediaCodecList::findMatchingCodecs("video/avc", false, ...)` 找到一组候选组件名，并按既定顺序生成 `matchingCodecs`；然后 `MediaCodec::CreateByType()` 里的 `for` 循环按顺序逐个调用 `codec->init(componentName)` 去尝试初始化，谁先成功就返回谁；如果最终成功的是 `c2.android.avc.decoder`，那么后续会进入 `CCodec`，并通过 `Codec2Client::CreateComponentByName("c2.android.avc.decoder")` 在 Codec2 store 中创建出 `libcodec2_soft_avcdec.so` 对应的 `C2SoftAvcDec` 实例。