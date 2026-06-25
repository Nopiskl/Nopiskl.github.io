# 全志 U-Boot SD 卡烧写模式调用链分析

本文基于当前工程中的 `brandy/brandy-2.0/u-boot-2018` 源码，说明 SD 卡烧写，也就是 Allwinner Card Sprite / Card Product 模式下：

- U-Boot 如何知道当前是 `WORK_MODE_CARD_PRODUCT`
- 为什么 `sunxi_flash_init_ext()` 会进入 `sunxi_flash_probe()`
- 为什么会调用到 `sunxi_sprite_mmc_probe()`
- 为什么默认探测 `card2/eMMC` 作为烧写目标
- 为什么后面又切回 `card0/SD` 作为固件来源
- `cmd/sunxi_flash.c` 与自动烧卡流程的关系

> 结论先行：`WORK_MODE_CARD_PRODUCT` 不是 U-Boot 从环境变量或者分区内容里临时判断出来的，而是前级 boot0/SPL/TOC0 启动流程传进 `uboot_spare_head.boot_data.work_mode` 的启动模式字段。U-Boot 进入后通过 `get_boot_work_mode()` 读取该字段。当该字段为 `0x11` 时，`sunxi_flash_init_ext()` 识别它属于 product 大类，从而执行 `sunxi_flash_probe()`。在当前配置 `CONFIG_SUNXI_SDMMC=y` 下，`sunxi_flash_probe()` 优先使用 `sunxi_sdmmcs_desc` 探测 MMC sprite 目标介质，而该描述符的 `.probe` 函数就是 `sunxi_sprite_mmc_probe()`。

## 1. 当前配置前提

当前 `.config` 中与这条路径相关的配置为：

```text
brandy/brandy-2.0/u-boot-2018/.config

CONFIG_ARCH_SUNXI=y
CONFIG_ENV_IS_IN_SUNXI_FLASH=y
CONFIG_SUNXI_FLASH=y
CONFIG_SUNXI_SDMMC=y
CONFIG_SUNXI_SPRITE=y
CONFIG_SUNXI_SPRITE_RECOVERY=y
```

其中最关键的是：

- `CONFIG_ARCH_SUNXI=y`：会执行全志平台初始化 `initr_sunxi_plat()`
- `CONFIG_SUNXI_FLASH=y`：会调用 `sunxi_flash_init_ext()`
- `CONFIG_SUNXI_SDMMC=y`：`sunxi_flash_probe()` 会编译 SDMMC 分支
- `CONFIG_SUNXI_SPRITE=y`：支持 sprite 烧写相关流程
- `CONFIG_ENV_IS_IN_SUNXI_FLASH=y`：product 模式下 env 加载会切到 sprite env

## 2. 总体调用链

SD 卡烧写模式下，关键调用链可以概括为：

```text
前级 boot0/SPL/TOC0
 -> 设置 uboot_spare_head.boot_data.work_mode = WORK_MODE_CARD_PRODUCT(0x11)
 -> 跳入 U-Boot

U-Boot init:
board_init_r()
 -> initcall_run_list(init_sequence_r)
 -> initr_sunxi_plat()
 -> sunxi_flashmap_init()
 -> sunxi_flash_init_ext()
      -> workmode = get_boot_work_mode()
      -> workmode == 0x11
      -> (workmode & WORK_MODE_PRODUCT) 成立
      -> sunxi_flash_probe()
           -> current_flash = &sunxi_sdmmcs_desc
           -> current_flash->probe()
                -> sunxi_sprite_mmc_probe()
                     -> sdmmc_init_for_sprite(0, 2)
                     -> 初始化 card2/eMMC 作为烧写目标
           -> sprite_flash = current_flash
           -> if get_boot_work_mode() == WORK_MODE_CARD_PRODUCT
                -> current_flash = &sunxi_sdmmc_desc
                -> current_flash->init(0, 0)
                     -> sdmmc_init_for_boot(0, 0)
                     -> 初始化 card0/SD 作为固件来源

U-Boot env / command:
env_sunxi_flash_load()
 -> product 模式使用 SUNXI_SPRITE_ENV_SETTINGS
 -> bootcmd=run sunxi_sprite_test
 -> sprite_test read
 -> do_sprite_test()
 -> get_boot_work_mode() == WORK_MODE_CARD_PRODUCT
 -> sunxi_card_sprite_main()
```

## 3. WORK_MODE_CARD_PRODUCT 是什么

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/include/spare_head.h:12
```

关键片段：

```c
/* work mode */
#define WORK_MODE_PRODUCT      (1<<4)
#define WORK_MODE_UPDATE       (1<<5)

#define WORK_MODE_BOOT          0x00    /*normal boot mode */
#define WORK_MODE_USB_PRODUCT   0x10    /*usb product mode */
#define WORK_MODE_CARD_PRODUCT  0x11    /*card burn mode */
#define WORK_MODE_USB_DEBUG     0x12    /*some test mode by usb efex protocol */
#define WORK_MODE_SPRITE_RECOVERY 0x13  /*update firmware from internal backup part */
#define WORK_MODE_CARD_UPDATE   0x14    /*update firmware from sdcard */
#define WORK_MODE_USB_UPDATE    0x20    /*usb update mode */
#define WORK_MODE_UDISK_UPDATE  0x15
#define WORK_MODE_OUTER_UPDATE  0x21
```

这里需要注意：

```text
WORK_MODE_PRODUCT      = 0x10
WORK_MODE_CARD_PRODUCT = 0x11
```

所以：

```text
WORK_MODE_CARD_PRODUCT & WORK_MODE_PRODUCT
= 0x11 & 0x10
= 0x10
```

也就是说 `WORK_MODE_CARD_PRODUCT` 属于 product 模式大类。后面 `sunxi_flash_init_ext()` 里的判断不是直接写 `workmode == WORK_MODE_CARD_PRODUCT`，而是通过：

```c
(workmode & WORK_MODE_PRODUCT)
```

识别所有 product 类工作模式，包括 USB product 和 card product。

## 4. U-Boot 从哪里读到 work mode

### 4.1 work_mode 字段位于 U-Boot 启动头

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/include/private_uboot.h:51
```

关键片段：

```c
struct spare_boot_data_head
{
    unsigned int                dram_para[32];
    int                         run_clock;              /* Mhz */
    int                         run_core_vol;           /* mV */
    int                         uart_port;              /* UART ctrl num */
    normal_gpio_cfg             uart_gpio[2];           /* UART GPIO info */
    int                         twi_port;               /* TWI ctrl num */
    normal_gpio_cfg             twi_gpio[2];            /* TWI GPIO info */
    int                         work_mode;              /* boot,usb-burn, card-burn */
    int                         storage_type;           /* 0:nand 1:sdcard 2:spinor */
    normal_gpio_cfg             nand_gpio[32];          /* nand GPIO info */
    char                        nand_spare_data[256];   /* nand info */
    normal_gpio_cfg             sdcard_gpio[32];        /* sdcard GPIO info */
    char                        sdcard_spare_data[256]; /* sdcard info */
    ...
};
```

完整启动头结构：

```c
typedef struct spare_boot_head_t
{
    struct spare_boot_ctrl_head    boot_head;
    struct spare_boot_data_head    boot_data;
    struct spare_boot_ext_head     boot_ext[15];
    char   hash[64];
} uboot_head_t;
```

所以 U-Boot 读取的实际字段是：

```text
uboot_spare_head.boot_data.work_mode
```

### 4.2 U-Boot 镜像中默认 work_mode 是 0

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/arch/arm/cpu/armv7/spare_head.c:29
```

关键片段：

```c
struct spare_boot_head_t  uboot_spare_head =
{
    {
        /* jump_instruction */
        ( 0xEA000000 | ( ( ( sizeof( struct spare_boot_head_t ) + sizeof( int ) - 1 ) / sizeof( int ) - 2 ) & 0x00FFFFFF ) ),
        UBOOT_MAGIC,
        STAMP_VALUE,
        ALIGN_SIZE,
        0,
        0,
        UBOOT_VERSION,
        UBOOT_PLATFORM,
        {CONFIG_SYS_TEXT_BASE}
    },
    {
        { 0 },      // dram para
        1008,       // run core clock
        1200,       // run core vol
        0,          // uart port
        ...
        0,          // work mode
        0,          // storage mode
        ...
    },
};
```

这里默认 `work mode = 0`，也就是普通启动 `WORK_MODE_BOOT`。因此如果 U-Boot 启动后读到的是 `WORK_MODE_CARD_PRODUCT`，这个值不是 U-Boot 默认值，而是前级启动流程改写/传递进来的。

### 4.3 get_boot_work_mode() 只是读取该字段

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:71
```

关键片段：

```c
void set_boot_work_mode(int work_mode)
{
       uboot_spare_head.boot_data.work_mode = work_mode;
}

int get_boot_work_mode(void)
{
    return uboot_spare_head.boot_data.work_mode;
}
```

所以所有类似下面的判断：

```c
if (get_boot_work_mode() == WORK_MODE_CARD_PRODUCT)
```

本质上都是：

```c
if (uboot_spare_head.boot_data.work_mode == 0x11)
```

### 4.4 谁设置 WORK_MODE_CARD_PRODUCT

当前 U-Boot 源码能证明“读取位置”和“使用位置”，但完整 boot0/SPL 源码不在当前 `u-boot-2018` 树中。结合源码结构可以判断：

- U-Boot 镜像默认 `work_mode = 0`
- card product 模式下 U-Boot 启动后读到 `0x11`
- 因此前级 boot0/SPL/TOC0 启动流程需要把该字段设置为 `WORK_MODE_CARD_PRODUCT`

当前源码中也能看到 TOC0 配置结构里有卡启动工作模式字段：

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/include/private_toc.h:115
```

关键片段：

```c
typedef struct sbrom_toc0_config
{
    unsigned char       config_vsn[4];
    unsigned int        dram_para[32];
    int                 uart_port;
    ...
    unsigned int        card_work_mode;
    unsigned int        dram_size;
    unsigned int        res[1];
} sbrom_toc0_config_t;
```

这说明 card 启动工作模式属于 boot0/TOC0 传给后级的启动参数范畴，而不是 U-Boot env 临时决定的。

## 5. sunxi_flash_init_ext() 为什么进入 sunxi_flash_probe()

### 5.1 全志平台初始化会调用 sunxi_flash_init_ext()

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/common/board_r.c:527
```

关键片段：

```c
#ifdef CONFIG_ARCH_SUNXI
static int initr_sunxi_plat(void)
{
    __maybe_unused int ret = 0;
    __maybe_unused int workmode = get_boot_work_mode();
    ...
    sunxi_flashmap_init();
    ...
    if (!gd->boot_logo_addr) {
        tick_printf("flash init start\n");
#ifdef CONFIG_SUNXI_FLASH
        ret = sunxi_flash_init_ext();
        if (ret)
            return ret;
#endif
    }
    ...
}
#endif
```

`initr_sunxi_plat()` 被挂在 `init_sequence_r` 中：

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/common/board_r.c:1057
```

关键片段：

```c
#ifdef CONFIG_ARCH_SUNXI
    initr_sunxi_plat,
#endif
#ifndef CONFIG_ENABLE_MTD_CMDLINE_PARTS_BY_ENV
    initr_env,
#endif
```

注意这里 `initr_sunxi_plat` 在 `initr_env` 之前，因此 flash 初始化时不是靠 env 里的 `bootcmd` 判断模式，而是靠 `uboot_spare_head.boot_data.work_mode`。

### 5.2 product 模式分支

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/sunxi_flash.c:646
```

关键片段：

```c
int sunxi_flash_init_ext(void)
{
    int workmode     = 0;
    int storage_type = 0;
    int state        = 0;
    uint32_t uboot_dragon_board_test = 0;

    workmode     = get_boot_work_mode();
    storage_type = get_boot_storage_type();

    tick_printf("workmode = %d,storage type = %d\n", workmode, storage_type);

    if (workmode == WORK_MODE_USB_DEBUG) {
        return 0;
    } else if (workmode == WORK_MODE_BOOT ||
           workmode == WORK_MODE_SPRITE_RECOVERY) {
        ...
        state = sunxi_flash_boot_init(storage_type, workmode);
        ...
    } else if ((workmode & WORK_MODE_PRODUCT) || (workmode == 0x30)) {
        ...
        state = sunxi_flash_probe();
    } else if (workmode & WORK_MODE_UPDATE) {
        ...
    } else {
        ...
    }
}
```

当 `workmode == WORK_MODE_CARD_PRODUCT` 时：

```text
workmode = 0x11
WORK_MODE_PRODUCT = 0x10
(workmode & WORK_MODE_PRODUCT) == 0x10
```

所以进入：

```text
sunxi_flash_init_ext()
 -> sunxi_flash_probe()
```

## 6. 为什么会走到 sunxi_sprite_mmc_probe()

### 6.1 sunxi_flash_probe() 优先尝试 sunxi_sdmmcs_desc

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/sunxi_flash.c:367
```

关键片段：

```c
int sunxi_flash_probe(void)
{
    int state = 0;

//try emmc, nand, spi-nor
    do {
#ifdef CONFIG_SUNXI_SDMMC
        current_flash = &sunxi_sdmmcs_desc;
        state     = current_flash->probe();
        if (state == 0)
            break;
        printf("try emmc fail\n");
#endif

#ifdef CONFIG_SUNXI_UFS
        current_flash = &sunxi_ufss_desc;
        state     = current_flash->probe();
        if (state == 0)
            break;
        printf("try UFS fail\n");
#endif

#ifdef CONFIG_SUNXI_NAND
        current_flash = &sunxi_nand_desc;
        state     = current_flash->probe();
        if (state == 0)
            break;
        printf("try nand fail\n");
#endif

#ifdef CONFIG_SUNXI_SPINOR
        current_flash = &sunxi_spinor_desc;
        state     = current_flash->probe();
        if (state == 0)
            break;

        printf("try spinor fail\n");
#endif

        if (state != 0) {
            return -1;
        }

    } while(0);

    sprite_flash = current_flash;
    ...
}
```

因为当前配置中 `CONFIG_SUNXI_SDMMC=y`，所以进入 SDMMC 分支。这里不是使用普通的 `sunxi_sdmmc_desc`，而是使用带 `s` 的：

```c
current_flash = &sunxi_sdmmcs_desc;
```

这个 `s` 可以理解为 sprite target 版本的 SDMMC 描述符。

### 6.2 sunxi_sdmmcs_desc 的 .probe 就是 sunxi_sprite_mmc_probe

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/mmc/sdmmc.c:793
```

普通 SD/MMC 描述符：

```c
sunxi_flash_desc sunxi_sdmmc_desc = {
    .probe = sunxi_flash_mmc_probe,
    .init = sunxi_flash_mmc_init,
    .exit = sunxi_flash_mmc_exit,
    .read = sunxi_flash_mmc_read,
    .write = sunxi_flash_mmc_write,
    .erase = sunxi_sprite_mmc_erase,
    .flush = sunxi_flash_mmc_flush,
    .size = sunxi_flash_mmc_size,
    ...
    .phyread = sunxi_flash_mmc_phyread,
    .phywrite = sunxi_flash_mmc_phywrite,
    .phyerase = sunxi_flash_mmc_phyerase,
    .download_spl = sunxi_flash_mmc_download_spl,
    .download_boot_param = sunxi_flash_mmc_download_boot_param,
    .download_toc = sunxi_flash_mmc_download_toc,
    .update_backup_boot0 = sunxi_flash_update_backup_boot0,
};
```

sprite 目标描述符：

```c
sunxi_flash_desc sunxi_sdmmcs_desc = {
    .probe = sunxi_sprite_mmc_probe,
    .init = sunxi_sprite_mmc_init,
    .exit = sunxi_sprite_mmc_exit,
    .read = sunxi_sprite_mmc_read,
    .write = sunxi_sprite_mmc_write,
    .erase = sunxi_sprite_mmc_erase,
    .force_erase = sunxi_sprite_mmc_force_erase,
    .flush = sunxi_sprite_mmc_flush,
    .size = sunxi_sprite_mmc_size,
    ...
};
```

因此调用关系是函数指针展开：

```text
sunxi_flash_probe()
 -> current_flash = &sunxi_sdmmcs_desc
 -> current_flash->probe()
 -> sunxi_sdmmcs_desc.probe()
 -> sunxi_sprite_mmc_probe()
```

### 6.3 sunxi_sprite_mmc_probe() 默认探测 card2

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/mmc/sdmmc.c:203
```

关键片段：

```c
int sunxi_sprite_mmc_probe(void)
{
#ifndef CONFIG_MACH_SUN50IW11
    return sdmmc_init_for_sprite(0, 2);
#else
    int workmode = uboot_spare_head.boot_data.work_mode;
    if (workmode == WORK_MODE_CARD_PRODUCT)
        return -1;
    else
        return sdmmc_init_for_sprite(0, 0);
#endif
}
```

当前工程不是 `CONFIG_MACH_SUN50IW11` 这条特殊路径，所以直接执行：

```text
sdmmc_init_for_sprite(0, 2)
```

也就是默认探测 `card2`。在全志平台中，`card0` 通常是外置 SD 卡，`card2` 通常是板载 eMMC。因此这里的含义是：

```text
烧卡固件从 SD/card0 启动
烧写目标默认探测 eMMC/card2
```

## 7. sdmmc_init_for_sprite(0, 2) 做了什么

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/mmc/sdmmc.c:868
```

关键片段：

```c
int sdmmc_init_for_sprite(int workmode, int card_no)
{
    static int mmc_has_init;

    if (!mmc_has_init) {
        printf("try card %d\n", card_no);
    } else {
        printf("card %d Has init\n", card_no);
        return 0;
    }

    if (mmc_has_pre_init)  {
        mmc_sprite = sunxi_mmc_init(card_no);
    } else {
        mmc_has_pre_init = 1;
        board_mmc_set_num(card_no);
        printf("set card number %d\n", card_no);
        printf("get card number %d\n", board_mmc_get_num());
        board_mmc_pre_init(card_no);
        mmc_sprite = find_mmc_device(sunxi_mmcno_to_devnum(card_no));
    }

    mmc_no = card_no;

    if (!mmc_sprite) {
        printf("fail to find one useful mmc card2\n");
#ifdef CONFIG_MMC3_SUPPORT
        printf("try to find card3 \n");
        board_mmc_pre_init(3);
        mmc_sprite = find_mmc_device(3);
        mmc_no = 3;
        if (!mmc_sprite) {
            printf("try card3 fail \n");
            return -1;
        } else {
            set_boot_storage_type(STORAGE_EMMC3);
        }
#else
        return -1;
#endif
    } else {
        if (card_no == 0)
            set_boot_storage_type(STORAGE_EMMC0);
        else
            set_boot_storage_type(STORAGE_EMMC);
    }

    if (mmc_init(mmc_sprite)) {
        printf("MMC init failed\n");
        return -1;
    }

    debug("sunxi sprite has installed sdcard2 function\n");
    mmc_has_init = 1;
    return 0;
}
```

这里有几个重点：

- `card_no = 2` 时，优先初始化 `card2`
- 成功找到 `mmc_sprite` 后，如果 `card_no != 0`，会执行 `set_boot_storage_type(STORAGE_EMMC)`
- 也就是说烧写目标被认为是 `STORAGE_EMMC`
- 如果找不到 card2 且配置了 `CONFIG_MMC3_SUPPORT`，会尝试 card3，并设置 `STORAGE_EMMC3`

存储类型枚举在：

```text
brandy/brandy-2.0/u-boot-2018/include/spare_head.h:139
```

```c
typedef enum
{
    STORAGE_NAND =0,
    STORAGE_SD,
    STORAGE_EMMC,
    STORAGE_NOR,
    STORAGE_EMMC3,
    STORAGE_SPI_NAND,
    STORAGE_SD1,
    STORAGE_EMMC0,
    STORAGE_UFS,
    STORAGE_MAX,
} SUNXI_BOOT_STORAGE;
```

## 8. 为什么探测完目标后又切回 sunxi_sdmmc_desc

`sunxi_flash_probe()` 在探测成功后会先保存目标介质：

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/sunxi_flash.c:413
```

关键片段：

```c
sprite_flash = current_flash;
#ifdef CONFIG_SUNXI_SDMMC
if (get_boot_work_mode() == WORK_MODE_CARD_PRODUCT) {
    current_flash = &sunxi_sdmmc_desc;
    if (current_flash->init(0, 0))
        return -1;
}
#endif
```

执行到这里时，如果 eMMC 探测成功：

```text
current_flash = &sunxi_sdmmcs_desc
```

随后：

```c
sprite_flash = current_flash;
```

所以：

```text
sprite_flash = &sunxi_sdmmcs_desc
```

也就是 `sprite_flash` 指向烧写目标 eMMC。

之后如果是 `WORK_MODE_CARD_PRODUCT`：

```c
current_flash = &sunxi_sdmmc_desc;
current_flash->init(0, 0);
```

也就是把 `current_flash` 切换成普通 SD/MMC 描述符，并初始化 `card0`：

```text
current_flash = &sunxi_sdmmc_desc
current_flash->init(0, 0)
 -> sunxi_flash_mmc_init(0, 0)
 -> sdmmc_init_for_boot(0, 0)
```

`sdmmc_init_for_boot()` 片段：

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/mmc/sdmmc.c:840
```

```c
int sdmmc_init_for_boot(int workmode, int card_no)
{
    pr_debug("MMC:   %d\n", card_no);

    if (!mmc_has_pre_init) {
        mmc_has_pre_init = 1;
        board_mmc_set_num(card_no);
        debug("set card number\n");
        board_mmc_pre_init(card_no);
        debug("begin to find mmc\n");
        mmc_boot = find_mmc_device(sunxi_mmcno_to_devnum(card_no));
    } else {
        mmc_boot = sunxi_mmc_init(card_no);
    }

    if (!mmc_boot) {
        printf("fail to find one useful mmc card\n");
        return -1;
    }

    debug("try to init mmc\n");
    if (mmc_init(mmc_boot)) {
        puts("MMC init failed\n");
        return -1;
    }

    debug("mmc %d init ok\n", card_no);
    return 0;
}
```

所以 card product 模式下形成了两个全局 flash 指针的分工：

```text
sprite_flash  -> 烧写目标，通常 eMMC/card2
current_flash -> 固件来源，启动 SD/card0
```

## 9. current_flash 与 sprite_flash 的读写分工

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/drivers/sunxi_flash/sunxi_flash.c:28
```

关键片段：

```c
__attribute__((section(".data"))) static sunxi_flash_desc *current_flash;

__attribute__((section(".data"))) static sunxi_flash_desc *sprite_flash;
```

普通 flash 接口走 `current_flash`：

```c
int sunxi_flash_read(uint start_block, uint nblock, void *buffer)
{
    return current_flash->read(start_block, nblock, buffer);
}

int sunxi_flash_write(uint start_block, uint nblock, void *buffer)
{
    return current_flash->write(start_block, nblock, buffer);
}
```

sprite 烧写接口走 `sprite_flash`：

```c
int sunxi_sprite_read(uint start_block, uint nblock, void *buffer)
{
    return sprite_flash->read(start_block, nblock, buffer);
}

int sunxi_sprite_write(uint start_block, uint nblock, void *buffer)
{
    return sprite_flash->write(start_block, nblock, buffer);
}

int sunxi_sprite_phywrite(uint start_block, uint nblock, void *buffer)
{
    return sprite_flash->phywrite(start_block, nblock, buffer);
}

int sunxi_sprite_phyerase(unsigned int start_block, unsigned int nblock, void *skip)
{
    return sprite_flash->phyerase(start_block, nblock, skip);
}
```

因此 card sprite 下载分区时的典型数据路径是：

```text
读固件：
sunxi_flash_read(...)
 -> current_flash->read(...)
 -> sunxi_sdmmc_desc.read
 -> sunxi_flash_mmc_read(...)
 -> 读 SD/card0

写目标：
sunxi_sprite_write(...)
 -> sprite_flash->write(...)
 -> sunxi_sdmmcs_desc.write
 -> sunxi_sprite_mmc_write(...)
 -> 写 eMMC/card2
```

这就是 `sunxi_flash_probe()` 先 probe `sunxi_sdmmcs_desc`，再把 `current_flash` 切回 `sunxi_sdmmc_desc` 的根本原因。

## 10. product 模式下 env 如何进入 sprite_test

### 10.1 product 模式使用 sprite env

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/env/sunxi_flash.c:321
```

关键片段：

```c
static int env_sunxi_flash_load(void)
{
    ...
    int workmode = get_boot_work_mode();
    ...

    if ((workmode & WORK_MODE_PRODUCT) &&
        (!(workmode & WORK_MODE_UPDATE))) {
        use_sprite_env();
        return 0;
    }

    desc = blk_get_devnum_by_typename("sunxi_flash", 0);
    ...
}
```

`use_sprite_env()` 导入的是 `SUNXI_SPRITE_ENV_SETTINGS`：

```c
const uchar sunxi_sprite_environment[] = {
#ifdef SUNXI_SPRITE_ENV_SETTINGS
    SUNXI_SPRITE_ENV_SETTINGS
#endif
    "\0"
};

static void use_sprite_env(void)
{
    extern struct hsearch_data env_htab;

    if (himport_r(&env_htab, (char *)sunxi_sprite_environment,
              sizeof(sunxi_sprite_environment), '\0', H_INTERACTIVE, 0,
              0, NULL) == 0)
        pr_err("Environment import failed: errno = %d\n", errno);
    gd->flags |= GD_FLG_ENV_READY;
}
```

### 10.2 sprite env 中 bootcmd 指向 sprite_test

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/include/configs/sunxi-common.h:443
```

关键片段：

```c
#define SUNXI_SPRITE_ENV_SETTINGS  \
    "bootdelay=0\0" \
    "bootcmd=run sunxi_sprite_test\0" \
    "console=ttyS0,115200\0" \
    "sunxi_sprite_test=sprite_test read\0"
```

所以 product 模式下自动命令是：

```text
bootcmd=run sunxi_sprite_test
sunxi_sprite_test=sprite_test read
```

### 10.3 sprite_test 中根据 work mode 进入 card sprite

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/cmd/sunxi_sprite.c:21
```

关键片段：

```c
int do_sprite_test(cmd_tbl_t *cmdtp, int flag, int argc, char * const argv[])
{
    __maybe_unused int ret;

    printf("sunxi work mode=0x%x\n", get_boot_work_mode());

    if(get_boot_work_mode() == WORK_MODE_USB_PRODUCT) {
        ...
    }
#ifdef CONFIG_SUNXI_SDMMC
    else if (get_boot_work_mode() == WORK_MODE_CARD_PRODUCT) {
        printf("run card sprite\n");
#ifdef CONFIG_SUNXI_SPRITE_LED
        sprite_led_init();
#endif
        ret = sunxi_card_sprite_main(0, NULL);
#ifdef CONFIG_SUNXI_SPRITE_LED
        sprite_led_exit(ret);
#endif
        return ret;
    }
#endif
    ...
}

U_BOOT_CMD(
    sprite_test, 2, 0, do_sprite_test,
    "do a sprite test",
    "NULL"
);
```

因此自动烧卡主流程最终入口是：

```text
sprite_test read
 -> do_sprite_test()
 -> sunxi_card_sprite_main(0, NULL)
```

## 11. sunxi_card_sprite_main() 后续主流程概览

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/sprite/sprite_main.c:80
```

主流程概括：

```text
sunxi_card_sprite_main()
 -> production_media = get_boot_storage_type()
 -> sprite_card_firmware_probe()
      -> Img_Open()
      -> 从 SD 卡固件分区读取 image 头
 -> sprite_card_fetch_download_map()
      -> 读取 DLINFO
 -> sprite_card_fetch_mbr()
      -> 读取镜像内 MBR/分区表
 -> sunxi_sprite_erase_flash()
      -> 擦除目标介质，必要时保护 private 分区
 -> sunxi_sprite_download_mbr()
      -> 转 GPT/写分区表
 -> sunxi_sprite_deal_part()
      -> 逐分区从固件镜像读 item，写入目标分区
 -> sunxi_sprite_deal_uboot()
      -> 写 TOC1/boot_package/uboot
 -> sunxi_sprite_deal_boot0()
      -> 写 BOOT0/TOC0
 -> sunxi_update_subsequent_processing()
      -> 根据 next_work 重启/关机/进入下一动作
```

这里和前面指针分工对应：

- `Img_Open()` / `Img_ReadItem()` 底层读源固件，走 `sunxi_flash_read()`，也就是 `current_flash`，对应 SD/card0
- 分区写入、boot0 写入、toc 写入，走 `sunxi_sprite_write()` / `sunxi_sprite_phywrite()` / `sunxi_sprite_download_spl()`，也就是 `sprite_flash`，对应 eMMC/card2

## 12. cmd/sunxi_flash.c 与自动烧卡流程的关系

你当前打开的文件是：

```text
brandy/brandy-2.0/u-boot-2018/cmd/sunxi_flash.c
```

这个文件提供的是手动 `sunxi_flash` 命令入口，不是 card product 自动烧卡的入口。自动烧卡入口是：

```text
cmd/sunxi_sprite.c
 -> sprite_test
 -> sunxi_card_sprite_main()
```

`cmd/sunxi_flash.c` 中的命令入口如下：

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/cmd/sunxi_flash.c:227
```

关键片段：

```c
int do_sunxi_flash(cmd_tbl_t *cmdtp, int flag, int argc, char *const argv[])
{
    ...

    if (!strcmp("init", argv[1])) {
        argc--;
        argv++;
        return do_sunxi_flash_init(cmdtp, flag, argc, argv);
    }

    if (!strcmp("boot0", argv[1])) {
        argc--;
        argv++;
        return do_sunxi_flash_boot0(cmdtp, flag, argc, argv);
    }

    ...

    if (strncmp(cmd, "read", strlen("read")) == 0) {
        load_addr = (ulong)simple_strtoul(argv[2], NULL, 16);
        if (argc == 5)
            load_size = (ulong)simple_strtoul(argv[4], NULL, 16);
        env_set("boot_from_partion", part_name);
    }
#ifdef CONFIG_SUNXI_SPRITE
    else if (!strncmp(cmd, "write", strlen("write"))) {
        load_addr = (ulong)simple_strtoul(argv[2], NULL, 16);
        if (!strncmp(part_name, "boot_package", strlen("boot_package")) ||
            !strncmp(part_name, "uboot", strlen("uboot")) ||
            !strncmp(part_name, "toc1", strlen("toc1"))) {
            return sunxi_sprite_download_uboot((void *)load_addr, get_boot_storage_type(), 0);
        } else if (!strncmp(part_name, "boot0", strlen("boot0")) ||
            !strncmp(part_name, "toc0", strlen("toc0"))) {
            return sunxi_sprite_download_boot0((void *)load_addr, get_boot_storage_type());
        }
    ...
}
```

命令注册：

```c
U_BOOT_CMD(sunxi_flash, 6, 1, do_sunxi_flash, "sunxi_flash sub-system",
       "sunxi_flash init storage_type\n"
       "sunxi_flash read mem_addr part_name [size]\n"
       "sunxi_flash read_mtd mem_addr part_name [size]\n"
       "sunxi_flash write <mem_addr> <part_name> [size]\n"
       "sunxi_flash write <mem_addr> <part_name> [offset] [size]\n"
       "sunxi_flash write_mtd <mem_addr> <part_name>\n"
       "sunxi_flash boot0 force_dram_update_size <new_val> \n"
       "sunxi_flash boot0 force_dram_update_flag <new_val> \n");
```

它和 card sprite 自动流程的关系是：

- `cmd/sunxi_flash.c` 是命令行手动读写 flash 的入口
- card product 自动流程不会从 `do_sunxi_flash()` 进入
- 但两者底层共用 `sunxi_flash_*`、`sunxi_sprite_*`、`sunxi_sprite_download_boot0()`、`sunxi_sprite_download_uboot()` 等接口

所以如果分析“插入烧录 SD 卡，上电自动烧 eMMC”的路径，主线应该看：

```text
board_r.c
 -> sunxi_flash_init_ext()
 -> sunxi_flash_probe()
 -> cmd/sunxi_sprite.c
 -> sunxi_card_sprite_main()
 -> sprite/sprite_card.c
 -> sprite/sprite_download.c
```

而不是以 `cmd/sunxi_flash.c` 的 `SUNXI_FLASH_READ` 或 `sunxi_flash read` 命令作为自动烧卡入口。

## 13. 关键日志对应关系

根据源码，card product 模式下串口日志里可能看到这些关键点：

```text
workmode = 17,storage type = ...
```

对应：

```c
tick_printf("workmode = %d,storage type = %d\n", workmode, storage_type);
```

`17` 就是 `0x11`，即 `WORK_MODE_CARD_PRODUCT`。

```text
try card 2
set card number 2
get card number 2
```

对应：

```c
sunxi_sprite_mmc_probe()
 -> sdmmc_init_for_sprite(0, 2)
```

如果 card2/eMMC 探测失败：

```text
fail to find one useful mmc card2
try emmc fail
```

对应：

```c
sunxi_flash_probe()
 -> current_flash = &sunxi_sdmmcs_desc
 -> current_flash->probe()
 -> sunxi_sprite_mmc_probe()
 -> sdmmc_init_for_sprite(0, 2)
 -> return -1
```

执行自动烧卡命令时：

```text
sunxi work mode=0x11
run card sprite
```

对应：

```c
do_sprite_test()
 -> get_boot_work_mode() == WORK_MODE_CARD_PRODUCT
 -> sunxi_card_sprite_main(0, NULL)
```

## 14. 最容易混淆的几个点

### 14.1 U-Boot 不是通过 bootcmd 知道自己是 card product

`bootcmd` 是后续命令执行入口。真正决定 flash init 走哪条路径的是：

```text
uboot_spare_head.boot_data.work_mode
```

flash init 发生在 env 初始化前，因此不是先有 `bootcmd=sprite_test`，再决定 `WORK_MODE_CARD_PRODUCT`。

实际顺序是：

```text
前级设置 work_mode = 0x11
 -> U-Boot flash init 读 work_mode
 -> product 模式使用 sprite env
 -> bootcmd 变成 sprite_test
```

### 14.2 sunxi_sdmmc_desc 与 sunxi_sdmmcs_desc 不是同一个角色

```text
sunxi_sdmmc_desc
 -> 普通 SD/MMC flash 描述符
 -> card product 中被用作源 SD/card0
 -> current_flash

sunxi_sdmmcs_desc
 -> sprite SD/MMC 描述符
 -> card product 中被用作目标 eMMC/card2
 -> sprite_flash
```

### 14.3 sunxi_flash_read 与 sunxi_sprite_write 指向不同介质

card product 初始化完成后：

```text
sunxi_flash_read()
 -> current_flash
 -> SD/card0

sunxi_sprite_write()
 -> sprite_flash
 -> eMMC/card2
```

这就是烧卡时可以“从 SD 卡读固件，同时写入 eMMC”的原因。

### 14.4 cmd/sunxi_flash.c 不是自动烧卡入口

`cmd/sunxi_flash.c` 的 `sunxi_flash read/write/init` 是命令行接口。自动烧卡由 sprite env 触发：

```text
bootcmd=run sunxi_sprite_test
sunxi_sprite_test=sprite_test read
```

然后进入：

```text
cmd/sunxi_sprite.c
 -> do_sprite_test()
 -> sunxi_card_sprite_main()
```

## 15. 精简版答案

如果只看最核心的问题：

### U-Boot 怎么知道 if WORK_MODE_CARD_PRODUCT？

因为：

```c
get_boot_work_mode()
{
    return uboot_spare_head.boot_data.work_mode;
}
```

`uboot_spare_head.boot_data.work_mode` 是启动头字段，card product 模式下由前级 boot0/SPL/TOC0 传入 `0x11`。

### 为什么会走到 sunxi_sprite_mmc_probe()？

因为：

```text
WORK_MODE_CARD_PRODUCT = 0x11
WORK_MODE_PRODUCT = 0x10
0x11 & 0x10 成立
```

所以：

```text
sunxi_flash_init_ext()
 -> product 分支
 -> sunxi_flash_probe()
```

而 `sunxi_flash_probe()` 在 `CONFIG_SUNXI_SDMMC=y` 下首先执行：

```c
current_flash = &sunxi_sdmmcs_desc;
state = current_flash->probe();
```

`sunxi_sdmmcs_desc.probe` 定义为：

```c
.probe = sunxi_sprite_mmc_probe,
```

所以进入：

```text
sunxi_sprite_mmc_probe()
 -> sdmmc_init_for_sprite(0, 2)
```

这条路径的含义是：

```text
先探测 eMMC/card2 作为烧写目标
再切换 current_flash 到 SD/card0 作为固件来源
最后 sprite_test 进入 sunxi_card_sprite_main() 执行烧写
```
