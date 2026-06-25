# 打包流程与bootlogo分析
_Exported on 2026/5/7 at GMT+8 17:24:15 from Cursor (2.6.21)_

---

**User**

能否分析一下当前打包流程，分析一下bootlogo是从哪里来的？

---

**Cursor**

我来帮你分析一下当前的打包流程，特别是bootlogo的来源。

我来分析一下打包流程和bootlogo的来源。让我先查看主要的打包脚本：

好的，我已经分析完打包流程。让我为你总结一下bootlogo的来源和打包流程：

## 打包流程分析

### 1. **主打包脚本流程**

主打包脚本是 `build.sh`，执行流程如下：

```bash
build.sh
  ├─> brandy/brandy-2.0/build.sh  # 编译uboot
  ├─> build/mkcommon.sh           # 编译kernel和rootfs
  └─> build/mkcommon.sh pack      # 打包固件
```

### 2. **bootlogo来源优先级**

根据 `build/pack` 脚本第197-205行的配置，bootlogo的来源优先级如下：

```bash
boot_resource_list=(
  ${LICHEE_CHIP_CONFIG_DIR}/boot-resource/boot-resource:${LICHEE_PACK_OUT_DIR}
  ${LICHEE_CHIP_CONFIG_DIR}/boot-resource/boot-resource.ini:${LICHEE_PACK_OUT_DIR}
  ${LICHEE_CHIP_CONFIG_DIR}/configs/${PACK_BOARD}/*.bmp:${LICHEE_PACK_OUT_DIR}/boot-resource/
  ${LICHEE_CHIP_CONFIG_DIR}/configs/${PACK_BOARD}/bootlogo.bmp:${LICHEE_PACK_OUT_DIR}/bootlogo.bmp
  ${LICHEE_CHIP_CONFIG_DIR}/configs/${PACK_BOARD}/${PACK_TYPE}/*.bmp:${LICHEE_PACK_OUT_DIR}/boot-resource/
  ...
)
```

**优先级顺序：**

1. **最高优先级**：`device/config/chips/a133/configs/c3/bootlogo.bmp`
   - 如果这个文件存在，会直接复制到打包输出目录

2. **次优先级**：`device/config/chips/a133/configs/c3/bsp/*.bmp`（或android/*.bmp）
   - 板级配置目录下的平台特定bmp文件

3. **默认来源**：`device/config/chips/a133/boot-resource/boot-resource/bootlogo.bmp`
   - 这是芯片级的默认bootlogo（当前存在，775KB）

### 3. **打包处理逻辑**

在 `build/pack` 脚本第467-477行：

```bash
# 复制boot资源
for file in ${boot_resource_list[@]} ; do
    cp -rf $(echo $file | sed -e 's/:/ /g') 2>/dev/null
done

# 如果打包输出目录没有bootlogo.bmp，则从boot-resource复制
if [ ! -f ${LICHEE_PACK_OUT_DIR}/bootlogo.bmp ]; then
    cp ${LICHEE_PACK_OUT_DIR}/boot-resource/bootlogo.bmp ${LICHEE_PACK_OUT_DIR}/bootlogo.bmp
fi

# 压缩bootlogo
lzma -k ${LICHEE_PACK_OUT_DIR}/bootlogo.bmp
```

### 4. **当前配置情况**

根据查询结果：
- ✅ 存在：`device/config/chips/a133/boot-resource/boot-resource/bootlogo.bmp` (775KB)
- ❌ 不存在：`device/config/chips/a133/configs/c3/bootlogo.bmp`

**因此当前bootlogo来源是：**
```
device/config/chips/a133/boot-resource/boot-resource/bootlogo.bmp
```

### 5. **如何自定义bootlogo**

如果你想替换bootlogo，有两种方式：

**方式1（推荐）**：在板级配置目录放置
```bash
cp your_logo.bmp device/config/chips/a133/configs/c3/bootlogo.bmp
```

**方式2**：替换默认的
```bash
cp your_logo.bmp device/config/chips/a133/boot-resource/boot-resource/bootlogo.bmp
```

**注意事项**：
- bootlogo会被压缩成 `.bmp.lzma` 格式
- 在 `boot_package.cfg` 中，logo项目前是被注释的（第5行）
- 实际显示由uboot的logo_display驱动控制

这就是完整的bootlogo打包流程分析！

