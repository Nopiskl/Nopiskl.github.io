
## 1）软硬件编解码器是怎么注册进 `MediaCodecList` 的？

不是某个地方手工写死一张总表，而是 `MediaCodecList` 在构造时调用多个 builder，把不同来源的 codec 信息写进同一个 `MediaCodecListWriter`。

### 入口在 `GetBuilders()`

```76:92:android14/frameworks/av/media/libstagefright/MediaCodecList.cpp
std::vector<MediaCodecListBuilderBase *> GetBuilders() {
    std::vector<MediaCodecListBuilderBase *> builders;
    ...
    if (surfaceTest == nullptr) {
        builders.push_back(&sOmxInfoBuilder);
    } else {
        builders.push_back(&sOmxNoSurfaceEncoderInfoBuilder);
    }
    builders.push_back(GetCodec2InfoBuilder());
    return builders;
}
```

也就是说：

- **OMX 组件** 由 `OmxInfoBuilder` 加入
- **Codec2 组件** 由 `Codec2InfoBuilder` 加入

---

### OMX codec 怎么进 list

`OmxInfoBuilder` 先从 `IOmxStore` 枚举 OMX roles / nodes：

```82:101:android14/frameworks/av/media/libstagefright/OmxInfoBuilder.cpp
status_t OmxInfoBuilder::buildMediaCodecList(MediaCodecListWriter* writer) {
    sp<IOmxStore> omxStore = IOmxStore::getService();
    ...
    hidl_vec<IOmxStore::RoleInfo> roles;
    auto transStatus = omxStore->listRoles(
            [&roles] (
            const hidl_vec<IOmxStore::RoleInfo>& inRoleList) {
                roles = inRoleList;
            });
```

然后为每个 node 创建一条 `MediaCodecInfo`：

```145:207:android14/frameworks/av/media/libstagefright/OmxInfoBuilder.cpp
auto c2i = codecName2Info.find(nodeName);
if (c2i == codecName2Info.end()) {
    c2i = codecName2Info.insert(std::make_pair(
            nodeName, writer->addMediaCodecInfo())).first;
    info = c2i->second.get();
    info->setName(nodeName.c_str());
    info->setOwner(node.owner.c_str());
    info->setRank(rank);
    ...
    info->setAttributes(attrs);
}
```

所以 OMX codec 注册进 list 的方式就是：

> 从 `IOmxStore` 枚举出来，再写成 `MediaCodecInfo` 条目。

---

### Codec2 codec 怎么进 list

`Codec2InfoBuilder` 先通过 `Codec2Client::ListComponents()` 拿到所有 Codec2 component traits：

```396:429:android14/frameworks/av/media/codec2/sfplugin/Codec2InfoBuilder.cpp
status_t Codec2InfoBuilder::buildMediaCodecList(MediaCodecListWriter* writer) {
    ...
    std::vector<Traits> traits = Codec2Client::ListComponents();
```

再结合 XML，为每个 component 生成一条 `MediaCodecInfo`：

```629:660:android14/frameworks/av/media/codec2/sfplugin/Codec2InfoBuilder.cpp
std::unique_ptr<MediaCodecInfoWriter> codecInfo = writer->addMediaCodecInfo();
codecInfo->setName(nameOrAlias.c_str());
codecInfo->setOwner(("codec2::" + trait.owner).c_str());
...
codecInfo->setAttributes(attrs);
...
codecInfo->setRank(rank);
```

所以 Codec2 codec 注册进 list 的方式就是：

> 从 Codec2 component store 列出 traits，再结合 XML 生成 `MediaCodecInfo`。

---

## 2）为什么硬件解码器一般优先？

根本原因不是 `for` 循环，而是 **rank**。

### `MediaCodecList` 最终会按 `rank` 排序

```137:156:android14/frameworks/av/media/libstagefright/MediaCodecList.cpp
MediaCodecList::MediaCodecList(std::vector<MediaCodecListBuilderBase*> builders) {
    ...
    writer.writeCodecInfos(&mCodecInfos);
    std::stable_sort(
            mCodecInfos.begin(),
            mCodecInfos.end(),
            [](const sp<MediaCodecInfo> &info1, const sp<MediaCodecInfo> &info2) {
                return info1 == nullptr
                        || (info2 != nullptr && info1->getRank() < info2->getRank());
            });
```

也就是说：

> rank 越小，越靠前。

---

### OMX builder 里，硬件视频 codec 默认 rank 更小

```136:165:android14/frameworks/av/media/libstagefright/OmxInfoBuilder.cpp
uint32_t defaultRank =
    ::android::base::GetUintProperty("debug.stagefright.omx_default_rank", 0x100u);
uint32_t defaultSwAudioRank =
    ::android::base::GetUintProperty("debug.stagefright.omx_default_rank.sw-audio", 0x10u);
uint32_t defaultSwOtherRank =
    ::android::base::GetUintProperty("debug.stagefright.omx_default_rank.sw-other", 0x210u);

bool isSoftware = hasPrefix(nodeName, "OMX.google");
uint32_t rank = isSoftware
        ? (isAudio ? defaultSwAudioRank : defaultSwOtherRank)
        : defaultRank;
```

对视频来说，通常是：

- 硬件 OMX 视频 codec：`0x100`
- 软件 OMX 视频 codec：`0x210`

所以硬件视频 codec 默认就更靠前。

---

### Codec2 软件组件默认也通常比硬件 OMX 更靠后

`Codec2InfoBuilder.cpp` 里直接写了注释：

```423:425:android14/frameworks/av/media/codec2/sfplugin/Codec2InfoBuilder.cpp
// Note: Currently, OMX components have default rank 0x100, while all
// Codec2.0 software components have default rank 0x200.
```

这就解释了为什么很多设备上看起来会是：

- 硬件 OMX / vendor codec 在前
- AOSP 软件 Codec2 在后

---

## 3）那 `findMatchingCodecs()` 和 `for` 循环在这里分别扮演什么角色？

### `findMatchingCodecs()`
它只是沿着**已经按 rank 排好序**的全局 `MediaCodecList`，把满足 mime/encoder/format 的候选项挑出来：

```342:384:android14/frameworks/av/media/libstagefright/MediaCodecList.cpp
void MediaCodecList::findMatchingCodecs(...) {
    ...
    ssize_t matchIndex = list->findCodecByType(mime, encoder, index);
    ...
    const sp<MediaCodecInfo> info = list->getCodecInfo(matchIndex);
    AString componentName = info->getCodecName();
    ...
    matches->push(componentName);
}
```

### `for` 循环
它只是按照这个候选顺序逐个 `init()`：

```154:169:android14/frameworks/av/media/libstagefright/MediaCodec.cpp
for (size_t i = 0; i < matchingCodecs.size(); ++i) {
    sp<MediaCodec> codec = new MediaCodec(looper, pid, uid);
    AString componentName = matchingCodecs[i];
    status_t ret = codec->init(componentName);
    ...
    if (ret == OK) {
        return codec;
    }
}
```

