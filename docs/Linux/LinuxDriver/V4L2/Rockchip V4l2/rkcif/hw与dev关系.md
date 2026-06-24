
---

**User**

那为什么是hw匹配设备树的compatible属性？

---

**Cursor**

---

## 为什么是 `hw` 匹配设备树的 `compatible` 属性？

这是 Rockchip CIF 驱动采用的一种**两层设备树节点 + 两个平台驱动**的设计模式，用一张图来说明：

```
rk3568.dtsi 设备树
─────────────────────────────────────────────────────
rkcif: rkcif@fdfe0000 {                          ← 【hw 节点】
    compatible = "rockchip,rk3568-cif";          ← hw 驱动匹配这个
    reg = <0x0 0xfdfe0000 0x0 0x8000>;           ← 寄存器基地址
    clocks = ...;                                ← 时钟
    resets = ...;                                ← 复位
    interrupts = ...;                            ← 中断
};

rkcif_dvp: rkcif_dvp {                           ← 【逻辑设备节点】
    compatible = "rockchip,rkcif-dvp";           ← dev 驱动匹配这个
    rockchip,hw = <&rkcif>;                      ← phandle 指向 hw 节点
};

rkcif_mipi_lvds: rkcif_mipi_lvds {               ← 【逻辑设备节点】
    compatible = "rockchip,rkcif-mipi-lvds";     ← dev 驱动匹配这个
    rockchip,hw = <&rkcif>;                      ← phandle 指向 hw 节点
};
```

### 两个驱动各自的职责

**hw 驱动（`hw.c` → `rkcif_hw_plat_drv`）**

匹配 `"rockchip,rk3568-cif"`，在 `rkcif_plat_hw_probe` 中完成：
- 映射寄存器基地址（`ioremap`）
- 申请时钟、复位信号、中断等**物理硬件资源**
- 注册 `rkcif_plat_drv`（即 dev 驱动）

```1050:1100:kernel/drivers/media/platform/rockchip/cif/hw.c
	if (data->chip_id >= CHIP_RK1808_CIF &&
	    data->chip_id != CHIP_RV1126_CIF_LITE) {
		platform_driver_register(&rkcif_plat_drv);
		platform_driver_register(&rkcif_subdev_driver);
	}
```

**dev 驱动（`dev.c` → `rkcif_plat_drv`）**

匹配 `"rockchip,rkcif-dvp"` 或 `"rockchip,rkcif-mipi-lvds"`，在 `rkcif_plat_probe` 中：
- 通过 `rockchip,hw = <&rkcif>` 这个 phandle，找到已经 probe 好的 hw 设备
- 调用 `rkcif_attach_hw` 完成绑定，获得寄存器地址、时钟等资源

```1650:1670:kernel/drivers/media/platform/rockchip/cif/dev.c
int rkcif_attach_hw(struct rkcif_device *cif_dev)
{
	struct device_node *np;
	struct platform_device *pdev;
	struct rkcif_hw *hw;

	if (cif_dev->hw_dev)
		return 0;

	cif_dev->chip_id = CHIP_RV1126_CIF_LITE;
	np = of_parse_phandle(cif_dev->dev->of_node, "rockchip,hw", 0);
	// ...
	hw = platform_get_drvdata(pdev);
	// ...
	cif_dev->hw_dev = hw;   ← 拿到 hw 的资源
	cif_dev->chip_id = hw->chip_id;
```

### 为什么要这样设计？

原因是 **RK3568 只有一个 CIF 硬件控制器，但对外暴露了两种接口（DVP 和 MIPI）**，它们共享同一组寄存器基地址和时钟：

```
            一套物理硬件（rkcif@fdfe0000）
                    ↓
        ┌───────────┴───────────┐
   rkcif_dvp               rkcif_mipi_lvds
（DVP 接口逻辑设备）      （MIPI 接口逻辑设备）
  /dev/video0              /dev/video1~4
```

如果两个逻辑设备都直接在自己的 `compatible` 里写 `"rockchip,rk3568-cif"` 并各自 ioremap 寄存器、申请时钟，就会**重复申请同一套硬件资源，造成冲突**。

所以 Rockchip 的解决方案是：
- **hw 节点**：持有真实的硬件资源（reg/clocks/resets/interrupts），只做一次资源申请
- **逻辑设备节点**：通过 `rockchip,hw = <&rkcif>` phandle 共享 hw 节点的资源，只负责接口类型（DVP/MIPI）和 V4L2 框架逻辑

这就是为什么 **`compatible` 属性由 hw 节点持有，而 dev 节点只需要一个 phandle 指向 hw**。

```plaintext
rk3568.dtsi 设备树
─────────────────────────────────────────────────────
rkcif: rkcif@fdfe0000 {                          ← 【hw 节点】
    compatible = "rockchip,rk3568-cif";          ← hw 驱动匹配这个
    reg = <0x0 0xfdfe0000 0x0 0x8000>;           ← 寄存器基地址
    clocks = ...;                                ← 时钟
    resets = ...;                                ← 复位
    interrupts = ...;                            ← 中断
};

rkcif_dvp: rkcif_dvp {                           ← 【逻辑设备节点】
    compatible = "rockchip,rkcif-dvp";           ← dev 驱动匹配这个
    rockchip,hw = <&rkcif>;                      ← phandle 指向 hw 节点
};

rkcif_mipi_lvds: rkcif_mipi_lvds {               ← 【逻辑设备节点】
    compatible = "rockchip,rkcif-mipi-lvds";     ← dev 驱动匹配这个
    rockchip,hw = <&rkcif>;                      ← phandle 指向 hw 节点
};
```

```c
	if (data->chip_id >= CHIP_RK1808_CIF &&
	    data->chip_id != CHIP_RV1126_CIF_LITE) {
		platform_driver_register(&rkcif_plat_drv);
		platform_driver_register(&rkcif_subdev_driver);
	}
```

```c
int rkcif_attach_hw(struct rkcif_device *cif_dev)
{
	struct device_node *np;
	struct platform_device *pdev;
	struct rkcif_hw *hw;

	if (cif_dev->hw_dev)
		return 0;

	cif_dev->chip_id = CHIP_RV1126_CIF_LITE;
	np = of_parse_phandle(cif_dev->dev->of_node, "rockchip,hw", 0);
	// ...
	hw = platform_get_drvdata(pdev);
	// ...
	cif_dev->hw_dev = hw;   ← 拿到 hw 的资源
	cif_dev->chip_id = hw->chip_id;
```

```plaintext
            一套物理硬件（rkcif@fdfe0000）
                    ↓
        ┌───────────┴───────────┐
   rkcif_dvp               rkcif_mipi_lvds
（DVP 接口逻辑设备）      （MIPI 接口逻辑设备）
  /dev/video0              /dev/video1~4
```

