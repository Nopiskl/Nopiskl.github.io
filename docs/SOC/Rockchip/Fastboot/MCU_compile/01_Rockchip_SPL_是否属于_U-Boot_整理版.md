# Rockchip 的 SPL 阶段是否属于 U-Boot：整理版

## 原始问题

**Rockchip 的 SPL 阶段是 U-Boot 中的一部分吗？**

---

## 整理后的结论

**是，但要分场景说。**

在 **upstream U-Boot** 的语境里，Rockchip 如果走的是 **“U-Boot TPL/SPL”** 这条启动链路，那么这里的 **SPL 就是 U-Boot 的一部分**，不是 U-Boot 外部的独立程序。

原因很直接：

1. U-Boot 官方把启动阶段定义为 **TPL / VPL / SPL / U-Boot proper**。
2. 官方文档明确说明：
   - **SPL（Secondary Program Loader）** 的职责是做早期初始化，例如 **初始化 SDRAM**，然后 **加载 U-Boot proper**。
3. 在 U-Boot 的打包文档里，`u-boot-spl` 被直接定义为 **“U-Boot SPL binary”**。
4. Rockchip 官方的主线 U-Boot 文档里，明确存在一条打包方式叫：
   - **Package the image with U-Boot TPL/SPL**
   这说明在这条链路下，Rockchip 平台用到的 TPL/SPL 就是 U-Boot 体系里的 xPL 阶段。

---

## 但有一个容易混淆的例外

Rockchip 还支持另一条链路：

- **Package the image with Rockchip miniloader**

这条链路下，前级镜像不一定是 upstream U-Boot 的 SPL，而可能是：

- Rockchip 提供的 DDR 初始化二进制
- Rockchip 的 `miniloader`

也就是说：

### 情况 1：走 U-Boot TPL/SPL 方案
- **结论：SPL 属于 U-Boot。**

### 情况 2：走 Rockchip miniloader 方案
- **结论：前级加载阶段不一定是 U-Boot SPL，可能是 Rockchip 自己的 miniloader。**

---

## 更细一点的说明

Rockchip 在部分 SoC 上，U-Boot 自身未必完整具备 DDR 初始化能力。  
这时官方文档允许你在 **U-Boot TPL/SPL** 方案里，使用 rkbin 提供的 DDR 二进制作为 **`ROCKCHIP_TPL`**。

这表示：

- **TPL** 可能是 Rockchip 提供的 DDR 初始化 binary
- 但后面的 **SPL 仍然可以是 U-Boot SPL**
- 所以这仍然属于 **U-Boot TPL/SPL 方案**

因此不要把“用了 rkbin 的 DDR bin”直接等同于“不是 U-Boot SPL”。

---

## 最终一句话结论

**在 Rockchip 平台上，如果你走的是官方文档所说的 “Package the image with U-Boot TPL/SPL” 路线，那么 SPL 就是 U-Boot 的一部分。**  
**只有当你走的是 “Package the image with Rockchip miniloader” 路线时，前级加载程序才可能不是 upstream U-Boot SPL。**

---

## 推荐记忆方式

可以把它记成下面这句：

> **SPL 在概念上是 U-Boot 的一个启动子阶段；但 Rockchip 既支持 U-Boot SPL 方案，也支持 Rockchip 自家的 miniloader 方案。**

---

## 参考依据（官方文档）

### 1. U-Boot 启动阶段定义
U-Boot 官方文档说明，启动阶段通常包括：

- TPL
- SPL
- U-Boot proper

并明确写到：

- **SPL：Secondary program loader**
- **Sets up SDRAM and loads U-Boot proper**

### 2. U-Boot binman 文档
`u-boot-spl` 条目被定义为：

- **U-Boot SPL binary**

### 3. Rockchip 板级文档
Rockchip 官方主线文档同时列出了两条不同路径：

1. **Package the image with U-Boot TPL/SPL**
2. **Package the image with Rockchip miniloader**

这正是判断是否“属于 U-Boot”的关键分界。

---

## 适合直接引用的回答版本

你可以直接引用下面这段：

> 在 upstream U-Boot 的语境里，Rockchip 的 SPL 阶段如果走的是 “U-Boot TPL/SPL” 方案，那么它就是 U-Boot 的一部分。因为 U-Boot 官方把启动流程定义为 TPL / VPL / SPL / U-Boot proper，其中 SPL 负责早期初始化并加载 U-Boot proper。  
> 但 Rockchip 也支持另一条 “Rockchip miniloader” 路线，这时前级加载程序可能是 rkbin 提供的 DDR bin 和 miniloader，而不一定是 upstream U-Boot SPL。  
> 所以准确说法是：**Rockchip 可以使用 U-Boot SPL，也可以不用；如果你当前走的是 U-Boot TPL/SPL 方案，那么 SPL 就属于 U-Boot。**

---

## 官方文档链接

- U-Boot xPL / SPL 文档：<https://docs.u-boot.org/en/stable/develop/spl.html>
- U-Boot Rockchip 文档：<https://docs.u-boot.org/en/latest/board/rockchip/rockchip.html>
- U-Boot binman entry 文档：<https://docs.u-boot.org/en/latest/develop/package/entries.html>
