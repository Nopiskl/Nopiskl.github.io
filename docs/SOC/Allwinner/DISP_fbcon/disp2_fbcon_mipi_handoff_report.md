# T113 MIPI 屏启用 fbcon 后异常的 disp2 接管时序报告

## 1. 背景

这份报告基于两份对话记录和当前仓库源码核对：

- `codex.md`：Codex 对 T113 MIPI 屏、disp2、fbcon、smooth display 时序的初步分析。
- `cursor_.md`：Cursor Claude agent 对 `fb_free_reserve_mem()`、`sunxi_fb_open()`、`enable()`、`sw_enable()` 等路径的追问和回答。
- 当前源码以 `kernel/linux-5.4`、`brandy/brandy-2.0/u-boot-2018`、`device/config/chips/t113/configs/evb1_auto` 为准。

说明：报告中的源码块直接摘自当前仓库；为了让主线能读下去，少数较长函数用 `...` 省略了与本问题无关的局部变量、错误处理或重复字段赋值，但关键判断、调用顺序和状态写入都保留在代码块里。

你要做的事情是：T113 的 MIPI 屏已经能在 U-Boot 阶段显示 bootlogo，Linux 进入内核后也能正常接管；现在希望打开内核 framebuffer console，让屏幕显示内核调试信息，并作为本地终端登录。但启用 fbcon 相关配置后出现异常：

- U-Boot 阶段 bootlogo 正常。
- 进入 Linux 后原本应该亮背光，现在背光不亮。
- `dmesg | grep -i fb` 出现：

```text
[ 0.741177] display_fb_request,fb_id:0
[15.068616] [DISP] fb_free_reserve_mem,line:2312:
[15.068620] [DISP] fb_free_reserve_mem wait for sync timeout
```

你还做了两个非常关键的实验：

- 关闭 U-Boot 的 disp2 驱动后，Linux 侧屏幕能正常输出终端信息。
- 注释 `dev_fb.c` 中 `sunxi_fb_open()` 里的 `mgr->device->enable(mgr->device);` 后，屏幕可以亮并正常显示。

这两个实验把问题范围从“fbcon 字符绘制函数本身”收缩到了“U-Boot 已点亮显示链路时，Linux smooth display 接管时序被 fbcon 打断”。

## 2. 总体结论

当前最高概率根因是：

```text
U-Boot 已经点亮 MIPI DSI video 屏
  -> U-Boot 把 boot_disp / boot_fb0 / fb_base 等 handoff 信息传给 Linux
  -> Linux disp2 识别为 smooth display，预期后续走 sw_enable()
  -> 但 disp_init() 先执行 fb_init()，后执行 start_process()
  -> fb_init() 注册 fb0 时，fbcon 同步接管 console
  -> fbcon takeover 调用 info->fbops->fb_open(info, 0)
  -> sunxi_fb_open() 看到 lcdp->enabled 仍为 0
  -> 它误以为 LCD 设备未启用，调用 mgr->device->enable()
  -> enable() 走完整开屏路径，重配 IRQ/clock/GPIO/PWM/TCON/panel open flow/backlight
  -> 这打断了 U-Boot 留下的 DSI video/VBLK 状态机
  -> 后续 VBLK/sync finish 不再正常推进 wait_count
  -> fb_free_reserve_mem() 等不到下一次 sync，打印 wait for sync timeout
```

换句话说，`fb_free_reserve_mem wait for sync timeout` 更像最终症状，不是第一故障点。第一故障点更可能是 fbcon 过早 `fb_open()` 触发 `disp_lcd_enable()`，导致本来应该平滑接管的硬件链路被完整重启。

## 3. Cursor 记录对 Codex 猜想的验证情况

Cursor 记录总体支持 Codex 的核心猜想：

- `cursor_.md` 也把问题归因到 fbcon 提前介入 `sunxi_fb_open()`。
- 它也指出 `is_enabled()` 查的是 Linux 软件状态 `lcdp->enabled`，不是直接查询 U-Boot 已经点亮的硬件状态。
- 它也区分了 `enable()` 和 `sw_enable()`：
  - `enable()` 是完整硬件初始化。
  - `sw_enable()` 是 smooth display 接管路径，避免重新跑完整 panel open flow。
- 它也解释了 `boot_info.sync == 0` 和 `boot_info.sync == 1` 两条分支：
  - 非 seamless 启动通过 `disp_device_set_config()` 最终调用 `mgr->device->enable()`。
  - seamless 启动通过 `bsp_disp_sync_with_hw()` 最终调用 `mgr->device->sw_enable()`。

但 Cursor 记录有几个需要修正或收紧的地方：

1. Cursor 记录里大量行号和路径来自 `kernel/linux-4.9`，当前项目讨论对象是 `kernel/linux-5.4`。本报告下面全部以当前 `linux-5.4` 源码为准。

2. Cursor 早期把 `fb_free_reserve_mem()` 描述成旧式 `disp_reserve_mem(false)` 流程；当前 `linux-5.4` 实现已经是直接 `memblock_free()` 和 `free_reserved_area()`，见 `kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c:2300` 到 `2315`。

3. Cursor 说 `sw_enable()` “只设置软件标志”不够准确。当前 `disp_lcd_sw_enable()` 确实不会重跑完整 panel open flow，但它仍会做 `mgr->sw_enable()`、必要 clock、power/gpio/pin regulator、backlight GPIO/PWM、IRQ disable/enable 等动作，见 `disp_lcd.c:2282` 到 `2400`。它和 `enable()` 的关键区别是：`sw_enable()` 不重新 `disp_al_lcd_cfg()`，不重新执行 `cfg_open_flow()`，不重新发 panel 初始化命令。

4. Cursor 提到用 `g_fbi.fb_enable[info->node]` 保护 `sunxi_fb_open()` 的方案，在当前代码中不适合作为启动期判断。因为 `display_fb_request()` 在 `register_framebuffer()` 之前就已经把 `g_fbi.fb_enable[fb_id] = 1`，见 `dev_fb.c:2199` 和 `2474` 到 `2475`。所以 fbcon 调到 `sunxi_fb_open()` 时，这个标志已经是 1，不能用它判断“handoff 是否完成”。

5. 当前配置是 `CONFIG_ARCH_SUN8IW20=y`，实际低层目录由 `de/Makefile` 选择为 `lowlevel_v2x`，不是 `lowlevel_sun8iw8`。这不影响大结论，但 DSI IRQ 分析应以 `lowlevel_v2x/disp_al.c` 为准。

## 4. 当前配置和板级信息

### 4.1 内核配置

当前 `device/config/chips/t113/configs/evb1_auto/linux-5.4/config-5.4` 里：

- `CONFIG_ARCH_SUN8IW20=y`，见第 27 行。
- `CONFIG_FB=y`，见第 177 行。
- `CONFIG_FB_CONSOLE_SUNXI=y`，见第 178 行。
- `CONFIG_DISP2_SUNXI=y`，见第 179 行。
- `CONFIG_FRAMEBUFFER_CONSOLE=y`，见第 184 行。
- `CONFIG_FRAMEBUFFER_CONSOLE_DETECT_PRIMARY=y`，见第 185 行。
- 未看到 `CONFIG_FRAMEBUFFER_CONSOLE_DEFERRED_TAKEOVER=y`。

`fbcon.c` 在没有 `CONFIG_FRAMEBUFFER_CONSOLE_DEFERRED_TAKEOVER` 时将 `deferred_takeover` 定义为 `false`，见 `kernel/linux-5.4/drivers/video/fbdev/core/fbcon.c:153` 到 `155`。

对应源码如下：

```c
/* kernel/linux-5.4/drivers/video/fbdev/core/fbcon.c */
#else
#define deferred_takeover false
#endif
```

### 4.2 bootargs

如果当前跑的是 buildroot 的 mmc 启动环境，`device/config/chips/t113/configs/evb1_auto/buildroot/env.cfg:24` 有：

```text
fbcon=map:0
```

`fbcon=map:0` 会让 fbcon 把 console 映射到 fb0。`fbcon.c` 对 `map:` 的解析在 `fbcon.c:484` 到 `495`，它会填充 `con2fb_map_boot[]` 并设置 map override。这会让 fbcon 更确定地在 fb0 注册时接管。

对应源码如下：

```c
/* kernel/linux-5.4/drivers/video/fbdev/core/fbcon.c */
if (!strncmp(options, "map:", 4)) {
    options += 4;
    if (*options) {
        for (i = 0, j = 0; i < MAX_NR_CONSOLES; i++) {
            if (!options[j])
                j = 0;
            con2fb_map_boot[i] =
                (options[j++]-'0') % FB_MAX;
        }

        fbcon_map_override();
    }
    continue;
}
```

### 4.3 当前内核屏配置

`kernel/linux-5.4/arch/arm/boot/dts/t113-s3-kickpi-k4b.dts` 当前包含：

```dts
#include "t113-s3-kickpi-lcd-mipi-10-800-1280.dtsi"
//#include "t113-s3-kickpi-lcd-mipi-8-800-1280.dtsi"
```

即实际用的是 10 寸 MIPI 800x1280 配置，不是 8 寸配置。

`kernel/linux-5.4/arch/arm/boot/dts/t113-s3-kickpi-lcd-mipi-10-800-1280.dtsi` 中：

- `lcd_driver_name = "mipi_10_800x1280"`，见第 139 行。
- `lcd_if = <4>`，即 MIPI DSI，见第 141 行。
- `lcd_dsi_if = <0>`，即 DSI video mode，见第 163 行。
- `lcd_dsi_te = <0>`，见第 165 行。
- `lcd_bl_en = <&pio PD 18 GPIO_ACTIVE_HIGH>`，见第 177 行。
- `lcd_gpio_0 = <&pio PD 21 GPIO_ACTIVE_HIGH>`，见第 178 行。

关键 DTS 源码如下：

```dts
/* kernel/linux-5.4/arch/arm/boot/dts/t113-s3-kickpi-lcd-mipi-10-800-1280.dtsi */
&lcd0 {
        lcd_used            = <1>;
        lcd_driver_name     = "mipi_10_800x1280";
        lcd_backlight       = <50>;
        lcd_if              = <4>;

        lcd_x               = <800>;
        lcd_y               = <1280>;
        lcd_dclk_freq       = <75>;

        lcd_dsi_lane        = <4>;
        lcd_dsi_if          = <0>;
        lcd_dsi_format      = <0>;
        lcd_dsi_te          = <0>;
        lcd_dsi_eotp        = <0>;

        lcd_bl_en  = <&pio PD 18 GPIO_ACTIVE_HIGH>;
        lcd_gpio_0 = <&pio PD 21 GPIO_ACTIVE_HIGH>;
        pinctrl-0 = <&dsi4lane_pins_a>;
        pinctrl-1 = <&dsi4lane_pins_b>;
};
```

### 4.4 U-Boot 屏配置和一个重要差异

U-Boot 当前 `brandy/brandy-2.0/u-boot-2018/arch/arm/dts/t113-s3-kickpi-k4b-uboot.dts` 也包含 10 寸 MIPI 配置：

```dts
#include "t113-s3-kickpi-lcd-mipi-10-800-1280.dtsi"
```

但 U-Boot 的 `brandy/brandy-2.0/u-boot-2018/arch/arm/dts/t113-s3-kickpi-lcd-mipi-10-800-1280.dtsi` 中：

- `lcd_driver_name = "mipi_10_800x1280"`，见第 138 行。
- `lcd_if = <4>`，见第 140 行。
- `lcd_dsi_if = <0>`，见第 162 行。
- `lcd_dsi_te = <0>`，见第 164 行。
- `lcd_bl_en = <&pio PD 18 GPIO_ACTIVE_LOW>`，见第 176 行。
- `lcd_gpio_0 = <&pio PD 21 GPIO_ACTIVE_LOW>`，见第 177 行。

关键 DTS 源码如下：

```dts
/* brandy/brandy-2.0/u-boot-2018/arch/arm/dts/t113-s3-kickpi-lcd-mipi-10-800-1280.dtsi */
&lcd0 {
        lcd_used            = <1>;
        lcd_driver_name     = "mipi_10_800x1280";
        lcd_backlight       = <50>;
        lcd_if              = <4>;

        lcd_x               = <800>;
        lcd_y               = <1280>;
        lcd_dclk_freq       = <75>;

        lcd_dsi_lane        = <4>;
        lcd_dsi_if          = <0>;
        lcd_dsi_format      = <0>;
        lcd_dsi_te          = <0>;
        lcd_dsi_eotp        = <0>;

        lcd_bl_en  = <&pio PD 18 GPIO_ACTIVE_LOW>;
        lcd_gpio_0 = <&pio PD 21 GPIO_ACTIVE_LOW>;
        pinctrl-0 = <&dsi4lane_pins_a>;
        pinctrl-1 = <&dsi4lane_pins_b>;
};
```

这说明 U-Boot 和 Kernel 虽然使用同一类屏和同一套 MIPI timing，但 PD18 背光使能、PD21 面板电源使能的有效电平相反。只要 Linux 在 handoff 早期重新 request 或重新配置这两个 GPIO，就很容易把 U-Boot 已经点亮的屏和背光拉到相反状态。这不是 fbcon 提前接管的唯一根因，但它是非常强的放大因素，尤其能解释“背光都亮不了”。

## 5. U-Boot 到 Linux 的 handoff 信息

U-Boot 会保存显示输出参数给 Linux：

`brandy/brandy-2.0/u-boot-2018/drivers/video/sunxi/bootGUI/video_hal.c:279` 到 `293`：

```c
int hal_save_boot_disp(void *handle)
{
    int disp_para0, disp_para1 = 0, disp_para2 = 0;
    hal_fb_dev_t *fb_dev = (hal_fb_dev_t *)handle;

    disp_para0 = (((fb_dev->disp_dev->type << 8) | fb_dev->disp_dev->mode)
              << (fb_dev->disp_dev->screen_id * 16));

    disp_para1 = ((fb_dev->disp_dev->cs << 16) |
              (fb_dev->disp_dev->bits << 8) | fb_dev->disp_dev->format);
    disp_para2 = (fb_dev->disp_dev->eotf);

    hal_save_int_to_kernel("boot_disp", disp_para0);
    hal_save_int_to_kernel("boot_disp1", disp_para1);
    hal_save_int_to_kernel("boot_disp2", disp_para2);
    return  0;
}
```

U-Boot 还会把 logo framebuffer 地址写入 FDT 的 `disp.fb_base`：

`brandy/brandy-2.0/u-boot-2018/drivers/video/sunxi/logo_display/sunxi_load_bmp.c:47` 到 `64`。

```c
int save_bmp_logo_to_kernel(void)
{
    char name[] = "fb_base";
    int value = (int)bmp_addr;
    int node;
    int ret = -1;

    node = fdt_path_offset(working_fdt, "disp");
    if (node < 0) {
        pr_error("%s:disp_fdt_nodeoffset %s fail\n", __func__, "disp");
        goto exit;
    }

    ret = fdt_setprop_u32(working_fdt, node, name, (uint32_t)value);
    if (ret < 0)
        pr_error("fdt_setprop_u32 %s.%s(0x%x) fail.err code:%s\n",
                 "disp", name, value, fdt_strerror(ret));
    else
        ret = 0;

exit:
    return ret;
}
```

Linux 侧 `dev_disp.c` 解析这些参数。这里就是你选中的 `dev_disp.c:2287` 附近的真实代码：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/dev_disp.c */
value = disp_boot_para_parse("boot_disp");
value1 = disp_boot_para_parse("boot_disp1");
value2 = disp_boot_para_parse("boot_disp2");
output_type = (value >> 8) & 0xff;
output_mode = (value) & 0xff;

output_format = (value1 >> 0) & 0xff;
output_bits = (value1 >> 8) & 0xff;
output_cs = (value1 >> 16) & 0xffff;
output_eotf = (value2 >> 0) & 0xff;

if (output_type != (int)DISP_OUTPUT_TYPE_NONE) {
    para->boot_info.sync = 1;
    para->boot_info.disp = 0;    /* disp0 */
    para->boot_info.type = output_type;
    para->boot_info.mode = output_mode;
    para->boot_info.format = output_format;
    para->boot_info.bits = output_bits;
    para->boot_info.cs = output_cs;
    para->boot_info.eotf = output_eotf;
} else {
    output_type = (value >> 24) & 0xff;
    output_mode = (value >> 16) & 0xff;
    if (output_type != (int)DISP_OUTPUT_TYPE_NONE) {
        para->boot_info.sync = 1;
        para->boot_info.disp = 1;    /* disp1 */
        para->boot_info.type = output_type;
        para->boot_info.mode = output_mode;
        para->boot_info.format = output_format;
        para->boot_info.bits = output_bits;
        para->boot_info.cs = output_cs;
        para->boot_info.eotf = output_eotf;
    }
}

if (para->boot_info.sync == 1) {
    __wrn("smooth display screen:%d type:%d mode:%d\n",
          para->boot_info.disp, para->boot_info.type,
          para->boot_info.mode);
    g_disp_drv.disp_init.disp_mode = para->boot_info.disp;
    g_disp_drv.disp_init.output_type[para->boot_info.disp] = output_type;
    g_disp_drv.disp_init.output_mode[para->boot_info.disp] = output_mode;
    g_disp_drv.disp_init.output_format[para->boot_info.disp] = output_format;
    g_disp_drv.disp_init.output_bits[para->boot_info.disp] = output_bits;
    g_disp_drv.disp_init.output_cs[para->boot_info.disp] = output_cs;
    g_disp_drv.disp_init.output_eotf[para->boot_info.disp] = output_eotf;
}
```

Linux 侧还解析 `fb_base`：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c */
static s32 fb_parse_bootlogo_base(phys_addr_t *fb_base, int *fb_size)
{
    *fb_base = (phys_addr_t) disp_boot_para_parse("fb_base");

    return 0;
}
```

此外，`Fb_copy_boot_fb()` 会读取 `boot_fb0`，复制 U-Boot 旧 framebuffer，并设置：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c */
boot_fb_str = (char *)disp_boot_para_parse_str("boot_fb0");
if (boot_fb_str != NULL) {
    ...
} else {
    __wrn("no boot_fb0\n");
    return -1;
}

...

bootlogo_addr = (unsigned long)src_phy_addr;
bootlogo_sz =  src_stride * fb_height;
g_fbi.free_uboot_buffer = true;
return 0;
```

位置在 `dev_fb.c:1418` 到 `1484` 和 `1575` 到 `1577`。

所以，一旦你已经看到 `fb_free_reserve_mem wait for sync timeout`，基本可以说明：旧 boot logo buffer 的释放流程已经被触发，handoff 信息不是完全缺失。问题更像是在 handoff 过程中显示链路被提前重启或状态机被打断。

## 6. Linux disp2 初始化顺序

当前 `disp_init()` 的关键顺序在 `kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/dev_disp.c`：

下面是删掉无关细节后的真实顺序。注意 `fb_init(pdev)` 明确在 `start_process()` 前面：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/dev_disp.c */
static s32 disp_init(struct platform_device *pdev)
{
    struct disp_bsp_init_para *para;
    int i, disp, num_screens;
    unsigned int value, value1, value2, output_type, output_mode;
    unsigned int output_format, output_bits, output_eotf, output_cs;

    INIT_WORK(&g_disp_drv.start_work, start_work);
    parser_disp_init_para(pdev->dev.of_node, &g_disp_drv.disp_init);
    para = &g_disp_drv.para;

    memset(para, 0, sizeof(struct disp_bsp_init_para));
    para->disp_int_process = disp_sync_finish_process;
    para->vsync_event = drv_disp_vsync_event;
    para->start_process = start_process;

    value = disp_boot_para_parse("boot_disp");
    value1 = disp_boot_para_parse("boot_disp1");
    value2 = disp_boot_para_parse("boot_disp2");
    output_type = (value >> 8) & 0xff;
    output_mode = (value) & 0xff;
    ...

    if (output_type != (int)DISP_OUTPUT_TYPE_NONE) {
        para->boot_info.sync = 1;
        para->boot_info.disp = 0;    /* disp0 */
        para->boot_info.type = output_type;
        para->boot_info.mode = output_mode;
        ...
    }

    if (para->boot_info.sync == 1) {
        __wrn("smooth display screen:%d type:%d mode:%d\n",
              para->boot_info.disp, para->boot_info.type,
              para->boot_info.mode);
        g_disp_drv.disp_init.disp_mode = para->boot_info.disp;
        g_disp_drv.disp_init.output_type[para->boot_info.disp] = output_type;
        g_disp_drv.disp_init.output_mode[para->boot_info.disp] = output_mode;
        ...
    }

    bsp_disp_init(para);

    /*
     * 这段硬件 enabled 检查被注释掉了，所以 smooth display 是否有效
     * 更依赖后面的 sw_enable 时序。
     */
    /*if (bsp_disp_check_device_enabled(para) == 0)
        para->boot_info.sync = 0;
    */

    num_screens = bsp_disp_feat_get_num_screens();
    for (disp = 0; disp < num_screens; disp++) {
        g_disp_drv.mgr[disp] = disp_get_layer_manager(disp);
        ...
    }

    lcd_init();
    bsp_disp_open();

    fb_init(pdev);

    g_disp_drv.inited = true;
    start_process();

    return 0;
}
```

最关键的是第 9 和第 11 步的顺序：

```text
fb_init()
  -> register_framebuffer()
  -> fbcon 可能立刻 takeover

start_process()
  -> schedule_work(start_work)
  -> 后续才可能 bsp_disp_sync_with_hw()
```

所以，smooth display 的软件状态同步点在 `fb_init()` 之后。fbcon 一旦在 `register_framebuffer()` 期间同步接管，就会抢在 smooth handoff 之前进入 `sunxi_fb_open()`。

## 7. smooth display 原本应该走的路径

`start_process()` 只是调度 `start_work`：

`dev_disp.c:1801` 到 `1807`：

```c
static s32 start_process(void)
{
    flush_work(&g_disp_drv.start_work);
#if !IS_ENABLED(CONFIG_EINK_PANEL_USED) && !IS_ENABLED(CONFIG_EINK200_SUNXI)
    schedule_work(&g_disp_drv.start_work);
#endif
    return 0;
}
```

`start_work()` 分两条路径：

### 7.1 `boot_info.sync == 0`

非 smooth display 情况下，`start_work()` 会通过 `disp_device_set_config()` 配置并打开设备：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/dev_disp.c */
static void start_work(struct work_struct *work)
{
    ...
    if (g_disp_drv.para.boot_info.sync == 0) {
        for (screen_id = 0; screen_id < num_screens; screen_id++) {
            int disp_mode = g_disp_drv.disp_init.disp_mode;
            int output_type =
                g_disp_drv.disp_init.output_type[screen_id % DE_NUM];
            int lcd_registered =
                bsp_disp_get_lcd_registered(screen_id);

            if (((disp_mode == DISP_INIT_MODE_SCREEN0) && (screen_id == 0))
                || ((disp_mode == DISP_INIT_MODE_SCREEN1) && (screen_id == 1))) {
                if (output_type == DISP_OUTPUT_TYPE_LCD) {
                    if (lcd_registered &&
                        bsp_disp_get_output_type(screen_id) != DISP_OUTPUT_TYPE_LCD) {
                        disp_device_set_config(&g_disp_drv.disp_init, screen_id);
                        suspend_output_type[screen_id] = output_type;
                    }
                } else {
                    disp_device_set_config(&g_disp_drv.disp_init, screen_id);
                    suspend_output_type[screen_id] = output_type;
                }
            }
        }
    } else {
        ...
    }
}
```

`disp_device_set_config()` 后续调用链是：

```text
disp_device_set_config()
  -> bsp_disp_device_set_config()
  -> disp_device_attached_and_enable()
  -> mgr->device->enable()
```

其中 `disp_device_attached_and_enable()` 在 `disp_display.c:162` 到 `256`，完整 `enable()` 调用在 `disp_display.c:223`。

关键源码如下：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/dev_disp.c */
int disp_device_set_config(struct disp_init_para *init, unsigned int screen_id)
{
    struct disp_device_config config;

    memset(&config, 0, sizeof(struct disp_device_config));
    config.type = init->output_type[screen_id];
    config.mode = init->output_mode[screen_id];
    config.format = init->output_format[screen_id];
    config.bits = init->output_bits[screen_id];
    config.eotf = init->output_eotf[screen_id];
    config.cs = init->output_cs[screen_id];
    config.range = init->output_range[screen_id];
    config.scan = init->output_scan[screen_id];
    config.aspect_ratio = init->output_aspect_ratio[screen_id];

    if (!init->using_device_config[screen_id])
        return bsp_disp_device_switch(screen_id, config.type,
                                      (enum disp_output_type)config.mode);
    else
        return bsp_disp_device_set_config(screen_id, &config);
}
```

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/de/disp_display.c */
s32 disp_device_attached_and_enable(int disp_mgr, int disp_dev,
                                    struct disp_device_config *config)
{
    ...
    if (mgr->device) {
        disp_config_update_t update = DISP_NORMAL_UPDATE;

        if (mgr->device->check_config_dirty)
            update = mgr->device->check_config_dirty(mgr->device, config);

        if (update == DISP_NORMAL_UPDATE) {
            if (mgr->device->is_enabled(mgr->device))
                mgr->device->disable(mgr->device);

            if (mgr->device->set_static_config)
                ret = mgr->device->set_static_config(mgr->device, config);
            if (ret != 0)
                goto exit;

            ret = mgr->device->enable(mgr->device);
            DE_WRN("attached %s, mgr%d<-->dev%d\n",
                   (ret == 0) ? "ok" : "fail", disp_mgr, disp_dev);
            if (ret != 0)
                goto exit;
        } else if (update == DISP_SMOOTH_UPDATE) {
            if (mgr->device->set_static_config)
                ret = mgr->device->set_static_config(mgr->device, config);
            mgr->device->smooth_enable(mgr->device);
            if (ret != 0)
                goto exit;
        }
    }

    return 0;
exit:
    return ret;
}
```

这条路径适合冷启动，即 U-Boot 没有留下正在运行的显示硬件状态。

### 7.2 `boot_info.sync == 1`

smooth display 情况下，`start_work()` 预期调用：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/dev_disp.c */
} else {
    if (bsp_disp_get_output_type(g_disp_drv.para.boot_info.disp) !=
        g_disp_drv.para.boot_info.type) {
        bsp_disp_sync_with_hw(&g_disp_drv.para);
        suspend_output_type[g_disp_drv.para.boot_info.disp] =
            g_disp_drv.para.boot_info.type;
    }
}
```

位置在 `dev_disp.c:1792` 到 `1797`。

`bsp_disp_sync_with_hw()` 在 `disp_display.c:561` 到 `637`。它做的事情是：

- 构造从 U-Boot 传来的 output config。
- `disp_device_attached()` 把 manager 和 device 关联起来，见 `disp_display.c:607` 到 `617`。
- 关键点：调用 `mgr->device->sw_enable()`，不是 `enable()`，见 `disp_display.c:626` 到 `632`。

关键源码如下：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/de/disp_display.c */
s32 bsp_disp_sync_with_hw(struct disp_bsp_init_para *para)
{
    if ((para->boot_info.sync == 1)
        && (para->boot_info.type != DISP_OUTPUT_TYPE_NONE)) {
        int disp = para->boot_info.disp;
        int disp_dev = disp;
        enum disp_output_type type =
            (enum disp_output_type)para->boot_info.type;
        enum disp_tv_mode mode =
            (enum disp_tv_mode)para->boot_info.mode;
        struct disp_manager *mgr = NULL;
        struct disp_device_config config;

        memset(&config, 0, sizeof(struct disp_device_config));
        config.type = type;
        config.mode = mode;
        config.format = (enum disp_csc_type)para->boot_info.format;
        config.bits = (enum disp_data_bits)para->boot_info.bits;
        config.eotf = (enum disp_eotf)para->boot_info.eotf;
        config.cs = (enum disp_color_space)para->boot_info.cs;
        config.range = para->boot_info.range;
        config.scan = para->boot_info.scan;
        config.aspect_ratio = para->boot_info.aspect_ratio;

        mgr = disp_get_layer_manager(disp);
        if (!mgr)
            return -1;

        ret = disp_device_attached(disp, disp_dev, &config);
        if (ret != 0) {
            ...
        }

        /* enable display device(only software) */
        if (ret != 0) {
            DE_WRN("Can't find device(%d) for manager %d\n",
                   (int)type, disp);
            return -1;
        }

        if (mgr->device && mgr->device->sw_enable) {
            if (mgr->device->set_mode)
                mgr->device->set_mode(mgr->device, mode);
            else if (mgr->device->set_static_config)
                mgr->device->set_static_config(mgr->device, &config);
            return mgr->device->sw_enable(mgr->device);
        }
    }

    return -1;
}
```

这才是 U-Boot 已经点亮屏幕后 Linux 应该走的接管方式。

### 7.3 fbcon 抢跑后为什么可能让 start_work 跳过 handoff

`start_work()` 在 smooth 分支里只有当当前 output type 和 bootloader 传来的 output type 不一致时才调用 `bsp_disp_sync_with_hw()`：

```c
if (bsp_disp_get_output_type(g_disp_drv.para.boot_info.disp) !=
    g_disp_drv.para.boot_info.type) {
    bsp_disp_sync_with_hw(&g_disp_drv.para);
}
```

见 `dev_disp.c:1792` 到 `1797`。

而 `bsp_disp_get_output_type()` 的判断是：如果 manager 上挂着 device，且 `dispdev->is_enabled()` 返回 true，就返回 `dispdev->type`，见 `disp_display.c:834` 到 `846`。

对应源码如下：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/de/disp_display.c */
s32 bsp_disp_get_output_type(u32 disp)
{
    struct disp_manager *mgr = disp_get_layer_manager(disp);

    if (mgr) {
        struct disp_device *dispdev = mgr->device;

        if (dispdev && dispdev->is_enabled
            && dispdev->is_enabled(dispdev))
            return dispdev->type;
    }

    return DISP_OUTPUT_TYPE_NONE;
}
```

因此，如果 fbcon 抢先调用了 `disp_lcd_enable()`，并且它执行到 `lcdp->enabled = 1`，那么后面的 `start_work()` 会认为 output type 已经匹配，从而跳过 `bsp_disp_sync_with_hw()`。这样 smooth handoff 的 `sw_enable()` 路径就不会按原设计执行。

如果 `disp_lcd_enable()` 在更早位置失败，它也已经触碰了 IRQ、GPIO、clock、TCON 或 panel open flow 的一部分，仍然足以破坏 U-Boot 留下的显示状态。

## 8. fbcon 为什么会抢先调用 sunxi_fb_open()

`fb_init()` 在 `dev_fb.c:2340` 到 `2481`。关键点：

- `display_fb_request()` 建立 fb buffer 和 layer config，见 `dev_fb.c:2467`。
- 之后调用 `register_framebuffer(g_fbi.fbinfo[i])`，见 `dev_fb.c:2474` 到 `2475`。
- 如果 `g_fbi.free_uboot_buffer` 为 true，再调度 `fb_free_reserve_mem`，见 `dev_fb.c:2477` 到 `2479`。

关键源码如下：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c */
s32 fb_init(struct platform_device *pdev)
{
    ...
    disp_register_sync_finish_proc(DRV_disp_int_process);

    ...

    if (g_disp_drv.disp_init.b_init) {
        struct disp_init_para *disp_init = &g_disp_drv.disp_init;

        for (i = 0; i < SUNXI_FB_MAX; i++) {
            u32 screen_id = g_disp_drv.disp_init.disp_mode;

            if (g_disp_drv.para.boot_info.sync)
                screen_id = g_disp_drv.para.boot_info.disp;

            ...
            ret = display_fb_request(i, &fb_para);
            if (ret)
                break;
        }

        for (i = 0; i < SUNXI_FB_MAX; i++)
            register_framebuffer(g_fbi.fbinfo[i]);
    }

    if (g_fbi.free_uboot_buffer) {
        INIT_WORK(&g_fbi.free_wq, fb_free_reserve_mem);
        schedule_work(&g_fbi.free_wq);
    }

    return ret;
}
```

`register_framebuffer()` 的内部流程在 `fbmem.c`：

- `do_register_framebuffer()` 中设置 fb node、注册 `registered_fb[]`。
- 然后在 `console_lock()` 保护下调用 `fbcon_fb_registered(fb_info)`，见 `fbmem.c:1647` 到 `1653`。

关键源码如下：

```c
/* kernel/linux-5.4/drivers/video/fbdev/core/fbmem.c */
static int do_register_framebuffer(struct fb_info *fb_info)
{
    ...
    registered_fb[i] = fb_info;

    if (!lockless_register_fb)
        console_lock();
    else
        atomic_inc(&ignore_console_lock_warning);

    lock_fb_info(fb_info);
    ret = fbcon_fb_registered(fb_info);
    unlock_fb_info(fb_info);

    if (!lockless_register_fb)
        console_unlock();
    else
        atomic_dec(&ignore_console_lock_warning);

    return ret;
}
```

fbcon 侧：

- `fbcon_fb_registered()` 在 `fbcon.c:3232` 到 `3264`。
- 如果没有 deferred takeover，直接进入 takeover 判断，见 `fbcon.c:3241` 到 `3255`。
- `do_fbcon_takeover()` 调用 `do_take_over_console()`，见 `fbcon.c:568` 到 `582`。
- takeover 过程中 `con2fb_acquire_newinfo()` 会调用 `info->fbops->fb_open(info, 0)`，见 `fbcon.c:736` 到 `747`。

对应源码如下：

```c
/* kernel/linux-5.4/drivers/video/fbdev/core/fbcon.c */
int fbcon_fb_registered(struct fb_info *info)
{
    int ret = 0, i, idx;

    idx = info->node;
    fbcon_select_primary(info);

    if (deferred_takeover) {
        pr_info("fbcon: Deferring console take-over\n");
        return 0;
    }

    if (info_idx == -1) {
        for (i = first_fb_vc; i <= last_fb_vc; i++) {
            if (con2fb_map_boot[i] == idx) {
                info_idx = idx;
                break;
            }
        }

        if (info_idx != -1)
            ret = do_fbcon_takeover(1);
    } else {
        for (i = first_fb_vc; i <= last_fb_vc; i++) {
            if (con2fb_map_boot[i] == idx)
                set_con2fb_map(i, idx, 0);
        }
    }

    return ret;
}
```

```c
/* kernel/linux-5.4/drivers/video/fbdev/core/fbcon.c */
static int do_fbcon_takeover(int show_logo)
{
    int err, i;

    if (!num_registered_fb)
        return -ENODEV;

    if (!show_logo)
        logo_shown = FBCON_LOGO_DONTSHOW;

    for (i = first_fb_vc; i <= last_fb_vc; i++)
        con2fb_map[i] = info_idx;

    err = do_take_over_console(&fb_con, first_fb_vc, last_fb_vc,
                               fbcon_is_default);
    ...
}
```

```c
/* kernel/linux-5.4/drivers/video/fbdev/core/fbcon.c */
static int con2fb_acquire_newinfo(struct vc_data *vc, struct fb_info *info,
                                  int unit, int oldidx)
{
    ...
    if (!err && info->fbops->fb_open &&
        info->fbops->fb_open(info, 0))
        err = -ENODEV;
    ...
}
```

所以 fbcon 调 `sunxi_fb_open()` 不是异步小概率事件，而是 `register_framebuffer()` 过程中的同步路径。

## 9. sunxi_fb_open() 的问题点

当前 `sunxi_fb_open()` 在 `dev_fb.c:572` 到 `596`：

```c
static int sunxi_fb_open(struct fb_info *info, int user)
{
    u32 num_screens;
    u32 sel = 0;

    num_screens = bsp_disp_feat_get_num_screens();
    for (sel = 0; sel < num_screens; sel++) {
        if (sel == g_fbi.fb_mode[info->node]) {
            struct disp_manager *mgr = g_disp_drv.mgr[sel];

            if (mgr && mgr->device) {
                if (mgr->device->is_enabled) {
                    if (!mgr->device->is_enabled(mgr->device)) {
                        if (mgr->device->enable)
                            mgr->device->enable(mgr->device);
                        mgr->set_layer_config(mgr, &g_fbi.config[sel], 1);
                        disp_delay_ms(20);
                    }
                }
            }
        }
    }
    return 0;
}
```

问题在于：这里的 `is_enabled()` 对 LCD 来说就是 `disp_lcd_is_enabled()`，它返回的是 `lcdp->enabled`，见 `disp_lcd.c:2403` 到 `2412`。

对应源码如下：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/de/disp_lcd.c */
s32 disp_lcd_is_enabled(struct disp_device *lcd)
{
    struct disp_lcd_private_data *lcdp = disp_lcd_get_priv(lcd);

    if ((lcd == NULL) || (lcdp == NULL)) {
        DE_WRN("NULL hdl!\n");
        return DIS_FAIL;
    }

    return (s32)lcdp->enabled;
}
```

U-Boot 虽然已经把 MIPI 屏点亮，但 Linux 的 `lcdp->enabled` 是 Linux 私有软件状态。它只有在 Linux 自己走过：

- `disp_lcd_enable()` 的末尾，见 `disp_lcd.c:2196` 到 `2199`；
- 或 `disp_lcd_sw_enable()` 的中段，见 `disp_lcd.c:2356` 到 `2361`；

两处设置 `lcdp->enabled` 的源码如下：

```c
/* disp_lcd_enable() 末尾 */
spin_lock_irqsave(&lcd_data_lock, flags);
lcdp->enabled = 1;
lcdp->enabling = 0;
spin_unlock_irqrestore(&lcd_data_lock, flags);
```

```c
/* disp_lcd_sw_enable() 中段 */
spin_lock_irqsave(&lcd_data_lock, flags);
lcdp->enabled = 1;
lcdp->enabling = 0;
lcdp->bl_need_enabled = 1;
lcdp->bl_enabled = true;
spin_unlock_irqrestore(&lcd_data_lock, flags);
```

才会变成 1。

fbcon 进入 `sunxi_fb_open()` 时，`start_process()` 还没有执行，`sw_enable()` 也还没执行，所以 `lcdp->enabled` 合理地还是 0。`sunxi_fb_open()` 因此误判“设备没有 enable”，于是调用完整 `enable()`。

这就是“硬件实际已经亮着，但 Linux 软件状态还没同步”的典型 handoff 时序问题。

## 10. enable() 和 sw_enable() 到底差在哪里

### 10.1 `disp_lcd_enable()` 是完整开屏路径

`disp_lcd_enable()` 在 `disp_lcd.c:2090` 到 `2207`。主要动作：

- 检查 `disp_lcd_is_enabled()`，如果软件状态已 enabled 才直接返回，见 `2114` 到 `2115`。
- `mgr->enable(mgr)`，见 `2117` 到 `2119`。
- 对 DSI video mode 注册和使能 DSI IRQ，见 `2121` 到 `2139`。
- 设置 `lcdp->enabling = 1`、`bl_need_enabled = 0`，见 `2140` 到 `2143`。
- `disp_lcd_gpio_init(lcd)`，见 `2146`。
- `lcd_clk_enable(lcd)`，见 `2147`。
- 配置 PWM，见 `2154` 到 `2160`。
- `disp_al_lcd_cfg()` 重配 TCON / DSI / panel timing，见 `2161` 到 `2163`。
- 调 panel 驱动的 `cfg_open_flow()`，见 `2177` 到 `2180`。
- 执行 open flow 里的各个函数，见 `2185` 到 `2193`。
- 最后设置 `lcdp->enabled = 1`，见 `2196` 到 `2199`。
- 设置背光亮度，见 `2200` 到 `2201`。

关键源码如下：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/de/disp_lcd.c */
static s32 disp_lcd_enable(struct disp_device *lcd)
{
    unsigned long flags;
    struct disp_lcd_private_data *lcdp = disp_lcd_get_priv(lcd);
    int i;
    struct disp_manager *mgr = NULL;
    unsigned bl;
    int ret = 0;

    if ((lcd == NULL) || (lcdp == NULL)) {
        DE_WRN("NULL hdl!\n");
        return DIS_FAIL;
    }

    if (!disp_lcd_is_used(lcd)) {
        return ret;
    }

    mgr = lcd->manager;
    if (mgr == NULL) {
        DE_WRN("mgr is NULL!\n");
        return DIS_FAIL;
    }
    if (disp_lcd_is_enabled(lcd) == 1)
        return 0;

    disp_lcd_cal_fps(lcd);
    if (mgr->enable)
        mgr->enable(mgr);

    if ((lcdp->panel_info.lcd_if == LCD_IF_DSI)
        && (lcdp->irq_no_dsi != 0)) {
        if (lcdp->panel_info.lcd_dsi_if == LCD_DSI_IF_COMMAND_MODE) {
            disp_sys_register_irq(lcdp->irq_no, 0, disp_lcd_event_proc,
                                  (void *)lcd, 0, 0);
            disp_sys_enable_irq(lcdp->irq_no);
        } else {
            disp_sys_register_irq(lcdp->irq_no_dsi, 0, disp_lcd_event_proc,
                                  (void *)lcd, 0, 0);
            disp_sys_enable_irq(lcdp->irq_no_dsi);
        }
    }

    spin_lock_irqsave(&lcd_data_lock, flags);
    lcdp->enabling = 1;
    lcdp->bl_need_enabled = 0;
    spin_unlock_irqrestore(&lcd_data_lock, flags);

    disp_lcd_gpio_init(lcd);
    ret = lcd_clk_enable(lcd);
    if (ret != 0)
        return DIS_FAIL;

    disp_sys_pwm_config(lcdp->pwm_info.dev, lcdp->pwm_info.duty_ns,
                        lcdp->pwm_info.period_ns);
    disp_sys_pwm_set_polarity(lcdp->pwm_info.dev,
                              lcdp->pwm_info.polarity);
    disp_check_timing_param(&lcdp->panel_info);
    disp_al_lcd_cfg(lcd->hwdev_index, &lcdp->panel_info,
                    &lcdp->panel_extend_info_set);

    lcdp->open_flow.func_num = 0;
    if (lcdp->lcd_panel_fun.cfg_open_flow)
        lcdp->lcd_panel_fun.cfg_open_flow(lcd->disp);
    else
        DE_WRN("lcd_panel_fun[%d].cfg_open_flow is NULL\n", lcd->disp);

    for (i = 0; i < lcdp->open_flow.func_num - skip_open_backlight; i++) {
        if (lcdp->open_flow.func[i].func) {
            lcdp->open_flow.func[i].func(lcd->disp);
            if (lcdp->open_flow.func[i].delay != 0)
                disp_delay_ms(lcdp->open_flow.func[i].delay);
        }
    }

    spin_lock_irqsave(&lcd_data_lock, flags);
    lcdp->enabled = 1;
    lcdp->enabling = 0;
    spin_unlock_irqrestore(&lcd_data_lock, flags);

    bl = disp_lcd_get_bright(lcd);
    disp_lcd_set_bright(lcd, bl);

    return 0;
}
```

你的 MIPI 10 寸 panel open flow 在 `kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/lcd/mipi_10_800x1280.c:83` 到 `88`：

```c
LCD_OPEN_FUNC(sel, lcd_power_on, 50);
LCD_OPEN_FUNC(sel, lcd_panel_init1, 20);
LCD_OPEN_FUNC(sel, sunxi_lcd_tcon_enable, 100);
LCD_OPEN_FUNC(sel, lcd_bl_open, 0);
```

`lcd_panel_init1()` 里还会 `sunxi_lcd_dsi_clk_enable(sel)` 并发送 panel 初始化命令，见同文件 `142` 到 `145` 起。

所以 `enable()` 不是一个轻量“确保打开”的函数。它会重新上电、重配、重发初始化序列、重新打开 TCON 和背光。对 U-Boot 已经点亮的 DSI video panel 来说，这非常容易把状态机打乱。

### 10.2 `disp_lcd_sw_enable()` 是 smooth display 接管路径

`disp_lcd_sw_enable()` 在 `disp_lcd.c:2282` 到 `2400`。它也会做一些接管必要动作：

- `disp_lcd_cal_fps()`、`lcd_calc_judge_line()`，见 `2299` 到 `2300`。
- `mgr->sw_enable(mgr)`，见 `2301` 到 `2302`。
- 在未启用 `CONFIG_COMMON_CLK_ENABLE_SYNCBOOT` 时使能时钟，见 `2304` 到 `2307`。
- 初始化 power/gpio/pin/backlight 相关 regulator 和 PWM，见 `2312` 到 `2354`。
- 设置 `lcdp->enabled = 1`、`bl_need_enabled = 1`、`bl_enabled = true`，见 `2356` 到 `2361`。
- 重新注册并使能 IRQ，见 `2374` 到 `2398`。

关键源码如下：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/de/disp_lcd.c */
static s32 disp_lcd_sw_enable(struct disp_device *lcd)
{
    unsigned long flags;
    struct disp_lcd_private_data *lcdp = disp_lcd_get_priv(lcd);
    int i, ret;
    struct disp_manager *mgr = NULL;

    if ((lcd == NULL) || (lcdp == NULL)) {
        DE_WRN("NULL hdl!\n");
        return DIS_FAIL;
    }

    mgr = lcd->manager;
    if (mgr == NULL) {
        DE_WRN("mgr is NULL!\n");
        return DIS_FAIL;
    }

    disp_lcd_cal_fps(lcd);
    lcd_calc_judge_line(lcd);
    if (mgr->sw_enable)
        mgr->sw_enable(mgr);

#if !defined(CONFIG_COMMON_CLK_ENABLE_SYNCBOOT)
    if (lcd_clk_enable(lcd) != 0)
        return DIS_FAIL;
#endif

    for (i = 0; i < LCD_POWER_NUM; i++) {
        ret = disp_sys_power_enable(lcdp->lcd_cfg.regulator[i]);
        if (ret)
            return DIS_FAIL;
    }

    if (lcdp->lcd_cfg.lcd_bl_en_used) {
        ret = disp_sys_power_enable(lcdp->lcd_cfg.bl_regulator);
        if (ret)
            return DIS_FAIL;
        disp_sys_gpio_request(&lcdp->lcd_cfg.lcd_bl_en);
    }

    if (lcdp->panel_info.lcd_pwm_used) {
        if (!lcdp->pwm_info.dev) {
            lcdp->pwm_info.dev = disp_sys_pwm_request(
                lcdp->panel_info.lcd_pwm_ch);
        }
        if (lcdp->pwm_info.dev) {
            disp_sys_pwm_config(lcdp->pwm_info.dev,
                                lcdp->pwm_info.duty_ns,
                                lcdp->pwm_info.period_ns);
            disp_sys_pwm_set_polarity(lcdp->pwm_info.dev,
                                      lcdp->pwm_info.polarity);
            disp_sys_pwm_enable(lcdp->pwm_info.dev);
        }
    }

    spin_lock_irqsave(&lcd_data_lock, flags);
    lcdp->enabled = 1;
    lcdp->enabling = 0;
    lcdp->bl_need_enabled = 1;
    lcdp->bl_enabled = true;
    spin_unlock_irqrestore(&lcd_data_lock, flags);

    disp_al_lcd_disable_irq(lcd->hwdev_index, LCD_IRQ_TCON0_VBLK,
                            &lcdp->panel_info);

    if ((lcdp->panel_info.lcd_if == LCD_IF_DSI) &&
        (lcdp->irq_no_dsi != 0)) {
        if (lcdp->panel_info.lcd_dsi_if == LCD_DSI_IF_COMMAND_MODE) {
            disp_sys_register_irq(lcdp->irq_no, 0,
                                  disp_lcd_event_proc, (void *)lcd, 0, 0);
            disp_sys_enable_irq(lcdp->irq_no);
        } else {
            disp_sys_register_irq(lcdp->irq_no_dsi, 0,
                                  disp_lcd_event_proc, (void *)lcd, 0, 0);
            disp_sys_enable_irq(lcdp->irq_no_dsi);
        }
    }

    disp_al_lcd_enable_irq(lcd->hwdev_index, LCD_IRQ_TCON0_VBLK,
                           &lcdp->panel_info);

    return 0;
}
```

但它没有重新执行 `disp_al_lcd_cfg()`，也没有重新执行 panel `cfg_open_flow()`。这是它适合 smooth display 的核心原因：让 Linux 软件状态接管已经由 U-Boot 配好的硬件，而不是把硬件从头初始化一遍。

## 11. 为什么 fb_free_reserve_mem 会 timeout

`fb_free_reserve_mem()` 在 `dev_fb.c:2300` 到 `2316`。

它的逻辑是：

- 如果 `g_fbi.free_uboot_buffer` 为 true，取当前 `g_fbi.wait_count[disp]`。
- 等待 3000 ms，直到 `wait_count` 变化。
- 如果等不到，打印 `wait for sync timeout`。
- 然后释放 boot logo buffer。

对应源码如下：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c */
static void fb_free_reserve_mem(struct work_struct *work)
{
    int disp = g_disp_drv.para.boot_info.disp;
    int ret;
    unsigned long count;

    if (g_fbi.free_uboot_buffer) {
        count = g_fbi.wait_count[disp];
        ret = wait_event_interruptible_timeout(g_fbi.wait[disp],
                                               count != g_fbi.wait_count[disp],
                                               msecs_to_jiffies(3000));
        if (ret <= 0) {
            __wrn("[DISP] %s wait for sync timeout\n", __func__);
        }
    }

    memblock_free((unsigned long)bootlogo_addr, bootlogo_sz);
    free_reserved_area(__va(bootlogo_addr),
                       __va(bootlogo_addr + PAGE_ALIGN(bootlogo_sz)),
                       0x00, "logo buffer");
}
```

`wait_count` 在 `DRV_disp_int_process()` 里增长，见 `dev_fb.c:858` 到 `862`：

```c
void DRV_disp_int_process(u32 sel)
{
    g_fbi.wait_count[sel]++;
    wake_up_interruptible_all(&g_fbi.wait[sel]);
}
```

`fb_init()` 会注册这个 sync finish 回调，见 `dev_fb.c:2363`。

对应源码如下：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c */
init_waitqueue_head(&g_fbi.wait[0]);
init_waitqueue_head(&g_fbi.wait[1]);
init_waitqueue_head(&g_fbi.wait[2]);
disp_register_sync_finish_proc(DRV_disp_int_process);
```

sync finish 又依赖 LCD/DSI 的 VBLK IRQ 能正常进入 `disp_lcd_event_proc()`。`disp_lcd_event_proc()` 在 `disp_lcd.c:1633` 起，关键查询在 `disp_lcd.c:1665` 到 `1666`：

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/de/disp_lcd.c */
if (disp_al_lcd_query_irq(hwdev_index, LCD_IRQ_TCON0_VBLK,
                          &lcdp->panel_info)) {
    ...
}
```

当前 SoC 是 `SUN8IW20`，`de/Makefile` 选择 `lowlevel_v2x`，见 `de/Makefile:88` 到 `89`。在 `lowlevel_v2x/disp_al.c:938` 到 `946`，DSI 且非 command mode 时，`LCD_IRQ_TCON0_VBLK` 会映射到 `DSI_IRQ_VIDEO_VBLK`。

对应源码如下：

```makefile
# kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/de/Makefile
ifeq ($(CONFIG_ARCH_SUN8IW20),y)
sub_dir = lowlevel_v2x
endif
```

```c
/* kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/de/lowlevel_v2x/disp_al.c */
int disp_al_lcd_query_irq(u32 screen_id, __lcd_irq_id_t irq_id,
                          struct disp_panel_para *panel)
{
    int ret = 0;

#if defined(SUPPORT_DSI) && defined(DSI_VERSION_40)
    if (panel->lcd_if == LCD_IF_DSI &&
        panel->lcd_dsi_if != LCD_DSI_IF_COMMAND_MODE) {
        enum __dsi_irq_id_t dsi_irq =
            (irq_id == LCD_IRQ_TCON0_VBLK) ?
            DSI_IRQ_VIDEO_VBLK : DSI_IRQ_VIDEO_LINE;

        ret = dsi_irq_query(screen_id, dsi_irq);
    } else
#endif
        ret = tcon_irq_query(screen_id,
                (al_priv.tcon_type[screen_id] == 0) ?
                irq_id : LCD_IRQ_TCON1_VBLK);

    return ret;
}
```

而当前屏配置 `lcd_dsi_if = <0>`，是 DSI video mode。所以这条 wait 本质上依赖 DSI video VBLK IRQ。只要 fbcon 抢跑导致 DSI video IRQ 状态机不再正常，`DRV_disp_int_process()` 就不会推进 `wait_count`，`fb_free_reserve_mem()` 就会 timeout。

所以 timeout 是一个很有用的信号：它告诉我们 “VBLK/sync finish 没有按预期发生”。但它不等价于“释放旧 buffer 本身造成了死锁”。旧 buffer 释放更像被卡在已经坏掉的同步点后面。

## 12. 为什么关闭 U-Boot disp2 反而正常

这个现象非常符合上面的判断：

### U-Boot disp2 开启

```text
U-Boot 已点亮屏
Linux boot_info.sync = 1
Linux 本该 sw_enable 平滑接管
fbcon 抢先 fb_open
sunxi_fb_open 调用 enable
重复初始化已在跑的 DSI video panel
屏幕异常
```

### U-Boot disp2 关闭

```text
U-Boot 没有留下已运行的显示链路
Linux 不需要保护旧 DSI video 状态机
即使走完整 enable，也是合理冷启动
fbcon 输出可以正常出现
```

因此，“U-Boot disp2 开时坏，关时好”不是反证，反而是 smooth handoff 被破坏的强证据。

## 13. 根因排序

### 13.1 第一优先级：fbcon 提前 takeover

证据强度：非常高。

源码确认 `register_framebuffer()` 中同步调用 `fbcon_fb_registered()`，然后 takeover 过程会调用 `fb_open()`。当前又没有 deferred takeover，且 bootargs 可能有 `fbcon=map:0`。

### 13.2 第二优先级：sunxi_fb_open() 在 smooth handoff 前调用完整 enable()

证据强度：非常高。

源码中 `sunxi_fb_open()` 明确在 `is_enabled()==0` 时调用 `mgr->device->enable()`。而用户实验表明注释这个调用后屏幕能亮并正常显示。

### 13.3 第三优先级：U-Boot 和 Kernel 的 PD18/PD21 GPIO 有效电平相反

证据强度：高，是放大因素，也可能参与直接导致背光不亮。

U-Boot MIPI 10 DTS 使用 `GPIO_ACTIVE_LOW`，Kernel MIPI 10 DTS 使用 `GPIO_ACTIVE_HIGH`。如果 Linux 早期重新初始化 GPIO，可能直接把 panel power 或 backlight 拉反。

### 13.4 第四优先级：boot logo buffer 释放流程本身

证据强度：中低，更像症状链尾。

`fb_free_reserve_mem()` 确实在等待 sync 后释放旧 buffer，但它等待的是下一次 VBLK/sync finish。timeout 说明 sync 没来。结合注释 `enable()` 后恢复，根因不应优先放在 memblock/free_reserved_area 本身。

### 13.5 第五优先级：fbcon 的 cfb 绘图函数

证据强度：低。

`CONFIG_FB_CONSOLE_SUNXI` 给 `fb_ops` 挂上 `cfb_fillrect/cfb_copyarea/cfb_imageblit`，见 `dev_fb.c:1364` 到 `1368`。但当前异常发生在背光都不亮、sync timeout 的阶段，更像显示链路初始化/IRQ 状态机问题，不像字符绘制把 framebuffer 内容画坏。

## 14. 建议的最小插桩验证

建议先不急着做结构性修复，先插入少量日志，把“先进入 enable 还是先进入 sw_enable”坐实。

### 14.1 `sunxi_fb_open()`

位置：`kernel/linux-5.4/drivers/video/fbdev/sunxi/disp2/disp/dev_fb.c:572`

建议打印：

- `info->node`
- `user`
- `sel`
- `g_fbi.fb_mode[info->node]`
- `g_disp_drv.inited`
- `g_disp_drv.para.boot_info.sync`
- `g_disp_drv.para.boot_info.disp`
- `g_disp_drv.para.boot_info.type`
- `bsp_disp_get_output_type(sel)`
- `mgr`
- `mgr->device`
- `mgr->device->type`
- `mgr->device->is_enabled(mgr->device)` 的返回值
- 是否即将调用 `mgr->device->enable()`

预期异常启动时会看到：`g_disp_drv.inited` 还没变 true 或 `start_process()` 尚未完成，`boot_info.sync=1`，`is_enabled=0`，随后进入 `enable()`。

### 14.2 `disp_lcd_enable()`

位置：`disp_lcd.c:2090`

建议打印入口和出口：

- `lcd->disp`
- `lcd->hwdev_index`
- `lcdp->enabled`
- `lcdp->enabling`
- `lcdp->irq_no`
- `lcdp->irq_no_dsi`
- `panel_info.lcd_if`
- `panel_info.lcd_dsi_if`
- 是否执行到 `disp_lcd_gpio_init()`
- 是否执行到 `disp_al_lcd_cfg()`
- 是否执行到 `cfg_open_flow()`
- 是否执行到 `lcdp->enabled = 1`

预期异常启动时，fbcon 路径会先进入这里。

### 14.3 `disp_lcd_sw_enable()`

位置：`disp_lcd.c:2282`

建议打印入口和出口，尤其看它发生在 `disp_lcd_enable()` 之前还是之后。

预期健康 handoff 应该是 `sw_enable()` 先发生，且不应先跑完整 `enable()`。

### 14.4 `start_work()`

位置：`dev_disp.c:1748`

建议打印：

- `g_disp_drv.para.boot_info.sync`
- `g_disp_drv.para.boot_info.disp`
- `g_disp_drv.para.boot_info.type`
- `bsp_disp_get_output_type(g_disp_drv.para.boot_info.disp)`
- 是否进入 `bsp_disp_sync_with_hw()`

如果 fbcon 的 `enable()` 先把 `lcdp->enabled` 置为 1，后面可能看到 `bsp_disp_get_output_type()` 已经等于 LCD，从而没有调用 `bsp_disp_sync_with_hw()`。

### 14.5 `fb_free_reserve_mem()` 和 VBLK

位置：

- `dev_fb.c:2300`
- `dev_fb.c:858`
- `disp_lcd.c:1633`

建议打印：

- `fb_free_reserve_mem()` 等待前后的 `wait_count`
- `DRV_disp_int_process()` 前几次进入时的 `sel` 和 `wait_count`
- `disp_lcd_event_proc()` 是否收到 VBLK IRQ

注意这里要做限频日志，否则 VBLK 会刷屏。

## 15. 建议的实验矩阵

### 实验 A：只去掉 `fbcon=map:0`

目的：判断 bootargs 强制映射是否是必要触发条件。

预期：

- 如果去掉后问题明显缓解，说明 `fbcon=map:0` 加速或强制了 takeover。
- 如果仍复现，说明只要 `CONFIG_FRAMEBUFFER_CONSOLE=y` 且 fb0 被选中，仍可能抢跑。

### 实验 B：启用 deferred takeover

打开：

```text
CONFIG_FRAMEBUFFER_CONSOLE_DEFERRED_TAKEOVER=y
```

它依赖 `FB=y && FRAMEBUFFER_CONSOLE && DUMMY_CONSOLE`，见 `drivers/video/console/Kconfig:154` 到 `156`。

目的：验证延迟 takeover 后是否能避开 handoff 窗口。

注意：如果启动参数有大量早期 console 输出，deferred takeover 在首次文本输出时仍可能接管，只是时机不同。

### 实验 C：临时在 `sunxi_fb_open()` 中保护 smooth boot

最小实验思路，不等于最终补丁：

```c
if (g_disp_drv.para.boot_info.sync == 1 &&
    sel == g_disp_drv.para.boot_info.disp &&
    !g_disp_drv.inited) {
    /* skip full enable during smooth handoff window */
}
```

目的：验证只要避免启动期 `fb_open()` 触发完整 `enable()`，问题是否消失。

注意不要用 `g_fbi.fb_enable[info->node]` 作为判断条件，因为它在 `register_framebuffer()` 前已经置 1。

### 实验 D：统一 U-Boot 和 Kernel 的 PD18/PD21 有效电平

目的：排除 GPIO 极性不一致导致的背光/电源被拉反。

建议先明确硬件真实有效电平，再让 U-Boot 和 Kernel 一致。由于当前 U-Boot 能点亮 bootlogo，U-Boot 侧的 LOW 配置可能更接近实际硬件，也可能是 U-Boot GPIO 解析语义不同，需要结合实际 pin 电平测量确认。

### 实验 E：保留 U-Boot disp2，禁用 fbcon

这是对照组。预期 smooth display 应该能按原来的非 fbcon 路径稳定接管。

### 实验 F：关闭 U-Boot disp2，打开 fbcon

这是另一个对照组。预期 Linux 冷启动完整 `enable()` 时能显示，符合你已经观察到的现象。

## 16. 修复方向建议

### 16.1 不建议的修法：永久注释 `mgr->device->enable()`

这虽然能验证问题，但不适合作为最终方案。因为普通用户态打开 `/dev/fb0`、屏幕 resume、设备被 disable 后再次打开等场景可能确实需要 `fb_open()` 恢复显示设备。

### 16.2 更合理的方向：给 smooth handoff 增加明确状态

应该区分两种状态：

```text
硬件已由 U-Boot 点亮，但 Linux 还未完成 sw_enable 接管
硬件确实未启用，需要 Linux 完整 enable
```

当前 `disp_lcd_is_enabled()` 只能看 `lcdp->enabled`，无法表达第一种状态。可以考虑增加一个“smooth handoff pending/done”的状态，让 `sunxi_fb_open()` 在 handoff pending 阶段不调用完整 `enable()`。

### 16.3 更合理的方向：把 smooth handoff 提前到 register_framebuffer() 之前

如果设备对象、manager、panel 参数都已经可用，可以在 `fb_init()` 之前完成一次 `bsp_disp_sync_with_hw()` 或等价 `sw_enable()`，让 `lcdp->enabled` 在 fbcon 接管前已经为 1。

这样 fbcon 进入 `sunxi_fb_open()` 时：

```text
is_enabled() == 1
  -> 不会调用 enable()
  -> 不会重启 DSI/panel
```

这个方向比在 fbcon 路径里堆特殊判断更干净，但要确认 `bsp_disp_sync_with_hw()` 所需的 device、manager、panel function 指针是否已经初始化完成。

### 16.4 折中方向：只在启动 handoff 窗口保护 `sunxi_fb_open()`

可以在 `sunxi_fb_open()` 中判断：

- `boot_info.sync == 1`
- 当前 `sel == boot_info.disp`
- handoff 尚未完成
- 当前调用来自 fbcon takeover 或启动早期

满足时不调用完整 `enable()`，最多只做 layer config。等 `start_process()` 正常完成 `sw_enable()` 后，再恢复普通 `fb_open()` 语义。

这个方案改动小，但需要一个可靠的 handoff 完成标志，不能只靠 `g_disp_drv.inited` 或 `g_fbi.fb_enable` 这类间接状态。

### 16.5 必须同步修正或确认 GPIO 极性

无论采用哪种时序修复，都建议把 U-Boot 和 Kernel 的 MIPI 10 DTS GPIO 极性统一。否则后续任何一次 Linux 重新初始化 panel/backlight，都可能再次出现背光或电源状态相反的问题。

## 17. 最终判断

从 `codex.md` 和 `cursor_.md` 交叉验证，再结合当前 `linux-5.4` 源码，可以得出比较稳的判断：

1. `fb_free_reserve_mem wait for sync timeout` 是 VBLK/sync 没来的后果，不是首要根因。
2. 首要根因是 fbcon 在 `register_framebuffer()` 期间同步 takeover，早于 `start_process()` 的 smooth display handoff。
3. `sunxi_fb_open()` 此时看到的是 Linux 软件状态 `lcdp->enabled=0`，于是错误调用完整 `mgr->device->enable()`。
4. 完整 `enable()` 会重跑 DSI/panel/TCON/backlight 初始化，破坏 U-Boot 已经点亮的 MIPI video 链路。
5. U-Boot 和 Kernel 对 PD18/PD21 的 GPIO active polarity 不一致，会进一步放大问题，尤其解释“背光都不亮”。
6. 后续最小验证应围绕“启动时先进入 `disp_lcd_enable()` 还是先进入 `disp_lcd_sw_enable()`”展开。

一句话版本：

```text
这个问题不是 fbcon 把字符画坏了，而是 fbcon 太早打开 fb0，导致 sunxi_fb_open() 把 U-Boot 已点亮的 MIPI 屏当作未启用设备重新完整 enable，破坏了本该由 sw_enable 完成的 smooth handoff。
```
