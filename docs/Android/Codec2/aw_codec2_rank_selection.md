# AW Codec2 Rank Selection

本文记录 Allwinner Codec2 硬件编解码器在 `MediaCodecList` 中相对 `c2.android.*` software 编解码器更容易被优先选中的原因。

结论先行：

```text
AW video Codec2 traits rank = 512
AOSP software video Codec2 traits rank = 512
Codec2 service 枚举顺序: default(AW) 在 software 前
MediaCodecList 使用 stable_sort 按 rank 升序排序
同 rank 保持原始插入顺序
=> c2.allwinner.* 排在 c2.android.* 前
=> MediaCodec.createDecoderByType 默认优先拿到 AW 硬件 codec
```

也就是说，当前源码里 AW 硬件 video codec 通常不是靠更小的 rank 压过 software，而是靠同 rank 下的插入顺序。

## 1. rank 的含义

`MediaCodecList` 中 rank 数值越小，优先级越高。

`MediaCodecInfoWriter::setRank()` 的注释说明 `MediaCodecList` 会按照 rank 非降序稳定排序：

```cpp
// frameworks/av/media/libmedia/include/media/MediaCodecInfo.h
// Set rank of the codec. MediaCodecList will stable-sort the list according
// to rank in non-descending order.
void setRank(uint32_t rank);
```

`MediaCodecInfo` 默认 rank 是 `0x100`：

```cpp
// frameworks/av/media/libmedia/MediaCodecInfo.cpp
MediaCodecInfo::MediaCodecInfo()
    : mAttributes((MediaCodecInfo::Attributes)0),
      mRank(0x100) {
}
```

但 Codec2 path 会在 `Codec2InfoBuilder` 中显式调用 `codecInfo->setRank(rank)`，因此最终使用的是 Codec2 traits/XML/属性处理后的 rank。

## 2. AW traits rank 来源

AW Codec2 HAL 的实际 component store 是 `C2AwComponentStore`：

```text
hardware/aw/libcodec2/vndk/C2Store.cpp
```

AW store 在 `ComponentModule::init()` 中创建每个组件的 `C2ComponentInterface`，再 query 出 `name/kind/domain/mediaType/aliases` 组装 `C2Component::Traits`。rank 在同一函数中按 domain 设置：

```cpp
// hardware/aw/libcodec2/vndk/C2Store.cpp
switch (traits->domain) {
  case C2Component::DOMAIN_AUDIO:
    traits->rank = 8;
    break;
  default:
    traits->rank = 512;
}
```

AW 当前这些 `c2.allwinner.*` 组件基本都是 video domain，因此 traits rank 为：

```text
512 == 0x200
```

例如 `c2.allwinner.avc.decoder` 的 traits 大致是：

```text
name      = c2.allwinner.avc.decoder
domain    = C2Component::DOMAIN_VIDEO
kind      = C2Component::KIND_DECODER
rank      = 512
mediaType = video/avc
owner     = default   # client 侧补上
aliases   = 通常为空
```

AW component name/mediaType 来源于各组件的 `IntfImpl`，例如：

```cpp
// hardware/aw/libcodec2/components/decoders/avc/AvcDecComponent.cpp
constexpr char COMPONENT_NAME[] = "c2.allwinner.avc.decoder";

HwC2Interface<void>::BaseParams(
        helper, COMPONENT_NAME,
        C2Component::KIND_DECODER,
        C2Component::DOMAIN_VIDEO,
        MEDIA_MIMETYPE_VIDEO_AVC)
```

`HwC2Interface<void>::BaseParams` 再把这些值注册为 C2 参数：

```cpp
// hardware/aw/libcodec2/components/HwC2Interface.cpp
DefineParam(mName, C2_PARAMKEY_COMPONENT_NAME)
DefineParam(mKind, C2_PARAMKEY_COMPONENT_KIND)
DefineParam(mDomain, C2_PARAMKEY_COMPONENT_DOMAIN)
DefineParam(mInputMediaType, C2_PARAMKEY_INPUT_MEDIA_TYPE)
DefineParam(mOutputMediaType, C2_PARAMKEY_OUTPUT_MEDIA_TYPE)
```

## 3. software traits rank 来源

AOSP software Codec2 store 是 `C2PlatformComponentStore`：

```text
frameworks/av/media/codec2/vndk/C2Store.cpp
```

它加载 `libcodec2_soft_*.so`：

```cpp
// frameworks/av/media/codec2/vndk/C2Store.cpp
emplace("libcodec2_soft_avcdec.so");
emplace("libcodec2_soft_hevcdec.so");
emplace("libcodec2_soft_vp8dec.so");
emplace("libcodec2_soft_vp9dec.so");
...
```

software store 的 rank 设置逻辑和 AW 类似：

```cpp
// frameworks/av/media/codec2/vndk/C2Store.cpp
switch (traits->domain) {
case C2Component::DOMAIN_AUDIO:
    traits->rank = 8;
    break;
default:
    traits->rank = 512;
}
```

因此 software video codec，例如 `c2.android.avc.decoder`、`c2.android.hevc.decoder`，默认 rank 也是：

```text
512 == 0x200
```

这与 `Codec2InfoBuilder` 中的注释一致：

```cpp
// frameworks/av/media/codec2/sfplugin/Codec2InfoBuilder.cpp
// OMX components have default rank 0x100, while all
// Codec2.0 software components have default rank 0x200.
```

## 4. Codec2InfoBuilder 如何确定最终 rank

`Codec2InfoBuilder::buildMediaCodecList()` 先拿所有 Codec2 traits：

```cpp
// frameworks/av/media/codec2/sfplugin/Codec2InfoBuilder.cpp
std::vector<Traits> traits = Codec2Client::ListComponents();
```

对每个 trait，初始 rank 取自 `trait.rank`：

```cpp
C2Component::rank_t rank = trait.rank;
```

然后会受两个因素影响：

1. `debug.stagefright.ccodec`
2. XML 中的 `rank="..."`

最终写入 `MediaCodecInfo`：

```cpp
if (!codec.rank.empty()) {
    uint32_t xmlRank;
    char dummy;
    if (sscanf(codec.rank.c_str(), "%u%c", &xmlRank, &dummy) == 1) {
        rank = xmlRank;
    }
}
codecInfo->setRank(rank);
```

当前 `device/softwinner/jupiter/common/media/codec/media_codecs_allwinner_video.xml` 中 AW 条目没有显式 `rank="..."`，例如：

```xml
<MediaCodec name="c2.allwinner.avc.decoder" type="video/avc">
```

因此 AW 最终通常沿用 traits rank，也就是 `512`。

`media_codecs_performance.xml` 中的 AW 条目多为 `update="true"`，主要补 measured-frame-rate 等性能数据，也没有覆盖 rank。

## 5. service 枚举顺序为何让 AW 在同 rank 时排前

`Codec2Client::GetServiceNames()` 会按 service instance 名字分组：

```cpp
// frameworks/av/media/codec2/hal/client/client.cpp
std::vector<std::string> defaultNames; // Prefixed with "default"
std::vector<std::string> vendorNames;  // Prefixed with "vendor"
std::vector<std::string> otherNames;   // Others
```

然后拼接顺序是：

```text
defaultNames -> vendorNames -> otherNames
```

AW 硬件 Codec2 service 注册为 `default`：

```cpp
// hardware/aw/libcodec2/services/vendor.cpp
store->registerAsService("default")
```

software Codec2 service 注册为 `software`，它属于 `otherNames`：

```cpp
// frameworks/av/media/module/codecserviceregistrant/CodecServiceRegistrant.cpp
storeV1_2->registerAsService("software")
```

所以 service 顺序通常是：

```text
default   # AW hardware
software  # AOSP software
```

`Codec2Client::ListComponents()` 按 service 顺序合并 traits：

```cpp
// frameworks/av/media/codec2/hal/client/client.cpp
for (Cache& cache : Cache::List()) {
    std::vector<C2Component::Traits> const& traits = cache.getTraits();
    list.insert(list.end(), traits.begin(), traits.end());
}
```

因此进入 `Codec2InfoBuilder` 的 traits 原始顺序大致是：

```text
c2.allwinner.avc.decoder      rank 512 owner default
c2.allwinner.hevc.decoder     rank 512 owner default
...
c2.android.avc.decoder        rank 512 owner software
c2.android.hevc.decoder       rank 512 owner software
...
```

## 6. MediaCodecList 排序保留同 rank 顺序

最终排序发生在 `MediaCodecList` 构造函数：

```cpp
// frameworks/av/media/libstagefright/MediaCodecList.cpp
std::stable_sort(
        mCodecInfos.begin(),
        mCodecInfos.end(),
        [](const sp<MediaCodecInfo> &info1, const sp<MediaCodecInfo> &info2) {
            return info1 == nullptr
                    || (info2 != nullptr && info1->getRank() < info2->getRank());
        });
```

排序规则：

```text
rank 小的排前
rank 相同保持插入顺序
```

因此在 AW 和 software video rank 同为 `512` 时：

```text
AW hardware 因为来自 default service，先插入
software 因为来自 software service，后插入
stable_sort 保持同 rank 顺序
=> AW 排在 software 前
```

## 7. MediaCodec 默认如何选中靠前 codec

`MediaCodec.createDecoderByType()` 这类按 MIME 创建 codec 的路径最终会通过 `MediaCodecList::findMatchingCodecs()` 找匹配项。它按已经排序好的 `MediaCodecList` 从前往后找：

```cpp
// frameworks/av/media/libstagefright/MediaCodecList.cpp
ssize_t matchIndex = list->findCodecByType(mime, encoder, index);
...
matches->push(componentName);
```

默认情况下不会把 software 重新排到前面。只有下面条件成立时才偏向 software：

```cpp
if (flags & kPreferSoftwareCodecs ||
        property_get_bool("debug.stagefright.swcodec", false)) {
    matches->sort(compareSoftwareCodecsFirst);
}
```

因此正常情况下，`video/avc` 的候选顺序更可能是：

```text
c2.allwinner.avc.decoder
c2.android.avc.decoder
...
```

## 8. debug.stagefright.ccodec 的影响

`Codec2InfoBuilder` 读取：

```cpp
int option = ::android::base::GetIntProperty("debug.stagefright.ccodec", 4);
```

默认 `4` 表示：

```text
All components are available with their normal ranks.
```

也就是 AW 和 software video 都保持 `512`。

如果该属性被改成 `1/2/3`，`c2.android.*` 可能被改成 rank `1`，或者某些非 `c2.android.*` AVC codec 被排到最后。例如：

```cpp
if (hasPrefix(canonName, "c2.android.")) {
    rank = 1;
}
```

所以如果实际设备上 software 反而排前，需要检查：

```bash
adb shell getprop debug.stagefright.ccodec
adb shell getprop debug.stagefright.swcodec
```

## 9. XML rank 可以显式改变优先级

如果不想依赖同 rank 下的插入顺序，可以在 XML 中显式写 rank。

例如让 AW 明确优先于 rank 512 的 software：

```xml
<MediaCodec name="c2.allwinner.avc.decoder" type="video/avc" rank="256">
```

或者让 software 显式靠后：

```xml
<MediaCodec name="c2.android.avc.decoder" type="video/avc" rank="1024">
```

`Codec2InfoBuilder` 会优先使用 XML rank 覆盖 traits rank。

## 10. 和 OMX 的比较

本文主要解释 AW Codec2 和 software Codec2 的优先级。

如果同 MIME 下还有 OMX codec，需要注意 OMX 默认 rank 往往是 `0x100`，即 `256`，比 Codec2 video 默认 `512` 更靠前。`Codec2InfoBuilder` 注释也提到：

```text
OMX components have default rank 0x100
Codec2.0 software components have default rank 0x200
```

因此 AW C2 是否优先于 OMX，还取决于 OMX builder、XML rank、属性配置以及是否保留该 OMX 条目。

## 11. 排查建议

建议在以下位置加日志确认实际设备行为：

1. `hardware/aw/libcodec2/vndk/C2Store.cpp`

   在 `mTraits = traits;` 前打印：

   ```text
   traits->name
   traits->domain
   traits->kind
   traits->rank
   traits->mediaType
   traits->aliases
   ```

2. `frameworks/av/media/codec2/hal/client/client.cpp`

   在 client 侧 `_listComponents()` 中确认：

   ```text
   traits[i].owner = serviceName
   ```

   期望 AW owner 为 `default`，software owner 为 `software`。

3. `frameworks/av/media/codec2/sfplugin/Codec2InfoBuilder.cpp`

   在 `codecInfo->setRank(rank)` 前打印：

   ```text
   trait.name
   trait.owner
   trait.rank
   XML rank
   final rank
   ```

4. `frameworks/av/media/libstagefright/MediaCodecList.cpp`

   在 `stable_sort` 后打印同 MIME 的 codec 顺序，确认最终 `MediaCodecList` 中谁排前。

## 12. 最短结论

当前 AW 硬件 Codec2 video 相对 software Codec2 video 被优先选中，主要依赖：

```text
AW rank = 512
software video rank = 512
AW service instance = default
software service instance = software
Codec2Client 先合并 default，再合并 software
MediaCodecList stable_sort 同 rank 保持顺序
```

如果需要更强、更可控的优先级策略，应在 `media_codecs_allwinner_video.xml` 中显式配置 AW codec 的 `rank`，避免依赖同 rank 下的 service 插入顺序。
