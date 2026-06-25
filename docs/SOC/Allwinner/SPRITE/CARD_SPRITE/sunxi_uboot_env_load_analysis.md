# 全志 U-Boot env 加载流程与 Card Sprite 模式分析

本文基于当前工程源码，分析 Allwinner U-Boot 中 env 的加载逻辑，重点回答：

- 为什么 SD 卡烧写流程中会自动导入 `SUNXI_SPRITE_ENV_SETTINGS`
- `himport_r(&env_htab, (char *)sunxi_sprite_environment, ...)` 实际做了什么
- 正常启动路径如何从 `env` 分区加载环境变量
- `device/config/chips/a733/configs/default/env.cfg` 是什么文件
- `env.cfg` 与 `env.fex`、`sys_partition.fex`、U-Boot 运行时 env 的关系

> 结论先行：`SUNXI_SPRITE_ENV_SETTINGS` 不是从 `device/.../env.cfg` 生成的，而是编译进 U-Boot 的一组极简烧写模式 env。Card Product / SD 卡烧写模式下，U-Boot 会绕过目标介质上的 `env` 分区，直接把这组内置 env 导入到内存 hash table，确保 `bootcmd` 固定走 `sprite_test read`，从而进入 `sunxi_card_sprite_main()`。正常启动时才会读取打包进固件、烧到 `env` 分区的 `env.fex`，而 `env.fex` 是由 `device/.../env.cfg` 在 pack 阶段生成的。

## 1. 总体流程对比

### 1.1 Card Product / SD 卡烧写模式

```text
前级 boot0/SPL/TOC0
 -> 设置 uboot_spare_head.boot_data.work_mode = WORK_MODE_CARD_PRODUCT(0x11)

U-Boot:
initr_env()
 -> env_relocate()
 -> env_load()
 -> env_sunxi_flash_load()
      -> workmode = get_boot_work_mode()
      -> (workmode & WORK_MODE_PRODUCT) 成立
      -> use_sprite_env()
           -> himport_r(... sunxi_sprite_environment ...)
           -> gd->flags |= GD_FLG_ENV_READY
      -> return 0

autoboot:
bootcmd=run sunxi_sprite_test
 -> sunxi_sprite_test=sprite_test read
 -> do_sprite_test()
 -> sunxi_card_sprite_main()
```

### 1.2 正常启动模式

```text
前级 boot0/SPL/TOC0
 -> 设置 uboot_spare_head.boot_data.work_mode = WORK_MODE_BOOT(0)

U-Boot:
initr_env()
 -> env_relocate()
 -> env_load()
 -> env_sunxi_flash_load()
      -> product 判断不成立
      -> blk_get_devnum_by_typename("sunxi_flash", 0)
      -> sunxi_flash_try_partition(desc, "env", &info)
      -> read_env(desc, ..., info.start, buf)
      -> env_import(buf, 1)
           -> 校验 CRC
           -> himport_r(... ep->data ...)
           -> gd->flags |= GD_FLG_ENV_READY

board_late_init()
 -> sunxi_update_bootcmd()
 -> 根据实际 storage_type 修正 bootcmd 中的 setargs_nand/setargs_mmc/setargs_ufs

autoboot:
 -> 执行 env 分区中加载出的 bootcmd
```

## 2. env 加载发生在 U-Boot 初始化阶段

### 2.1 早期 env_init

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/common/board_f.c:864
```

关键片段：

```c
	env_init,		/* initialize environment */
	init_baud_rate,		/* initialze baudrate settings */
	serial_init,		/* serial communications setup */
	console_init_f,		/* stage 1 init of console */
```

`env_init()` 属于早期初始化，主要初始化 env driver 状态。它还不是最终从 flash/env 分区加载完整环境变量。

对应实现位于：

```text
brandy/brandy-2.0/u-boot-2018/env/env.c:243
```

关键片段：

```c
int env_init(void)
{
	struct env_driver *drv;
	int ret = -ENOENT;
	int prio;

	for (prio = 0; (drv = env_driver_lookup(ENVOP_INIT, prio)); prio++) {
		if (!drv->init || !(ret = drv->init()))
			env_set_inited(drv->location);

		debug("%s: Environment %s init done (ret=%d)\n", __func__,
		      drv->name, ret);
	}

	if (!prio)
		return -ENODEV;

	if (ret == -ENOENT) {
		gd->env_addr = (ulong)&default_environment[0];
		gd->env_valid = ENV_VALID;

		return 0;
	}

	return ret;
}
```

这里会把可用的 env location 标记为已初始化，为后续 `env_load()` 做准备。

### 2.2 relocation 后 initr_env 才真正加载 env

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/common/board_r.c:707
```

关键片段：

```c
static int initr_env(void)
{
	/* initialize environment */
	if (should_load_env())
		env_relocate();
	else
		set_default_env(NULL);
#ifdef CONFIG_OF_CONTROL
	env_set_addr("fdtcontroladdr", gd->fdt_blob);
#endif
	/* Initialize from environment */
	load_addr = env_get_ulong("loadaddr", 16, load_addr);
	...
}
```

`should_load_env()` 默认返回 1：

```text
brandy/brandy-2.0/u-boot-2018/common/board_r.c:696
```

```c
static int should_load_env(void)
{
#ifdef CONFIG_OF_CONTROL
	return fdtdec_get_config_int(gd->fdt_blob, "load-environment", 1);
#elif defined CONFIG_DELAY_ENVIRONMENT
	return 0;
#else
	return 1;
#endif
}
```

因此通常会执行：

```text
initr_env()
 -> env_relocate()
```

### 2.3 initr_env 在 sunxi flash 初始化之后

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

`initr_sunxi_plat()` 中会先执行 flash 初始化：

```text
brandy/brandy-2.0/u-boot-2018/common/board_r.c:527
```

```c
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
```

所以全志平台上典型顺序是：

```text
initr_sunxi_plat()
 -> sunxi_flash_init_ext()
 -> 初始化 sunxi_flash 块设备、current_flash/sprite_flash 等

initr_env()
 -> env_relocate()
 -> env_load()
 -> 从 sunxi_flash env driver 加载 env
```

这也是正常路径中 `env_sunxi_flash_load()` 可以调用：

```c
blk_get_devnum_by_typename("sunxi_flash", 0)
```

的原因：对应块设备已经在前面的 flash init 阶段建立。

## 3. env driver 如何选到 sunxi_flash

当前 `.config` 中：

```text
brandy/brandy-2.0/u-boot-2018/.config

CONFIG_ENV_IS_IN_SUNXI_FLASH=y
CONFIG_ENV_SIZE=0x20000
# CONFIG_SUNXI_ENV_BACKUP is not set
# CONFIG_SUNXI_REDUNDAND_ENVIRONMENT is not set
```

`CONFIG_ENV_IS_IN_SUNXI_FLASH=y` 会使 `ENVL_SUNXI_FLASH` 进入 env location 列表。

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/env/env.c:49
```

关键片段：

```c
static enum env_location env_locations[] = {
#ifdef CONFIG_ENV_IS_IN_EEPROM
	ENVL_EEPROM,
#endif
...
#ifdef CONFIG_ENV_IS_IN_SUNXI_FLASH
	ENVL_SUNXI_FLASH,
#endif

#ifdef CONFIG_ENV_IS_NOWHERE
	ENVL_NOWHERE,
#endif
};
```

`env_load()` 会遍历这些 location：

```text
brandy/brandy-2.0/u-boot-2018/env/env.c:187
```

```c
int env_load(void)
{
	struct env_driver *drv;
	int prio;

	for (prio = 0; (drv = env_driver_lookup(ENVOP_LOAD, prio)); prio++) {
		int ret;

		if (!drv->load)
			continue;

		if (!env_has_inited(drv->location))
			continue;

		tick_printf("Loading Environment from %s... ", drv->name);
		ret = drv->load();
		if (ret)
			printf("Failed (%d)\n", ret);
		else
			printf("OK\n");

		if (!ret)
			return 0;
	}

	return -ENODEV;
}
```

`sunxi_flash` env driver 注册在：

```text
brandy/brandy-2.0/u-boot-2018/env/sunxi_flash.c:429
```

关键片段：

```c
U_BOOT_ENV_LOCATION(sunxi_flash) = {
	.location		     = ENVL_SUNXI_FLASH,
	ENV_NAME("SUNXI_FLASH").load = env_sunxi_flash_load,
	.save			     = env_save_ptr(env_sunxi_flash_save),

};
```

因此完整调用关系是：

```text
initr_env()
 -> env_relocate()
 -> env_load()
 -> env_driver_lookup(ENVOP_LOAD, ...)
 -> ENVL_SUNXI_FLASH
 -> env_sunxi_flash_load()
```

## 4. Card Product 模式为什么导入 SUNXI_SPRITE_ENV_SETTINGS

### 4.1 内置 sprite env 的定义

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/env/sunxi_flash.c:28
```

关键片段：

```c
const uchar sunxi_sprite_environment[] = {
#ifdef SUNXI_SPRITE_ENV_SETTINGS
	SUNXI_SPRITE_ENV_SETTINGS
#endif
	"\0"
};
```

`SUNXI_SPRITE_ENV_SETTINGS` 定义在：

```text
brandy/brandy-2.0/u-boot-2018/include/configs/sunxi-common.h:443
```

关键片段：

```c
#define SUNXI_SPRITE_ENV_SETTINGS	\
	"bootdelay=0\0" \
	"bootcmd=run sunxi_sprite_test\0" \
	"console=ttyS0,115200\0" \
	"sunxi_sprite_test=sprite_test read\0"
```

因此 `sunxi_sprite_environment` 实际内容是：

```text
bootdelay=0\0
bootcmd=run sunxi_sprite_test\0
console=ttyS0,115200\0
sunxi_sprite_test=sprite_test read\0
\0
```

换成人类可读形式：

```text
bootdelay=0
bootcmd=run sunxi_sprite_test
console=ttyS0,115200
sunxi_sprite_test=sprite_test read
```

### 4.2 use_sprite_env() 导入内置 env

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/env/sunxi_flash.c:35
```

关键片段：

```c
static void use_sprite_env(void)
{
	extern struct hsearch_data env_htab;

	if (himport_r(&env_htab, (char *)sunxi_sprite_environment,
		      sizeof(sunxi_sprite_environment), '\0', H_INTERACTIVE, 0,
		      0, NULL) == 0)
		pr_err("Environment import failed: errno = %d\n", errno);
	gd->flags |= GD_FLG_ENV_READY;

	return;
}
```

这里的含义：

- `env_htab` 是 U-Boot 运行时 env 的 hash table
- `sunxi_sprite_environment` 是编译进 U-Boot 的 `name=value\0` 字符串
- `sizeof(sunxi_sprite_environment)` 是导入数据大小
- `'\0'` 表示变量之间用 NUL 字符分隔
- `H_INTERACTIVE` 表示这次导入按交互/用户来源处理
- 没有设置 `H_NOCLEAR`，所以会清掉旧 hash table 后重新导入
- `gd->flags |= GD_FLG_ENV_READY` 表示 env 已经可用

`himport_r()` 的行为注释在：

```text
brandy/brandy-2.0/u-boot-2018/lib/hashtable.c:751
```

关键片段：

```c
 * H_NOCLEAR bit is set, then an existing hash table will kept, i. e.
 * new data will be added to an existing hash table; otherwise, old
 * data will be discarded and a new hash table will be created.
 *
 * The separator character for the "name=value" pairs can be selected,
 * so we both support importing from externally stored environment
 * data (separated by NUL characters) and from plain text files
 * (entries separated by newline characters).
```

函数内部也能看到，如果没有 `H_NOCLEAR`，会销毁旧表：

```text
brandy/brandy-2.0/u-boot-2018/lib/hashtable.c:804
```

```c
if ((flag & H_NOCLEAR) == 0) {
	/* Destroy old hash table if one exists */
	debug("Destroy Hash Table: %p table = %p\n", htab,
	       htab->table);
	if (htab->table)
		hdestroy_r(htab);
}
```

所以在 product 模式下，`use_sprite_env()` 会让内存中的 env 变成一套极简 sprite env，而不是继续使用普通系统启动 env。

### 4.3 env_sunxi_flash_load() 中的 product 判断

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/env/sunxi_flash.c:321
```

关键片段：

```c
static int env_sunxi_flash_load(void)
{
#ifdef CONFIG_SUNXI_ENV_BACKUP
	ALLOC_CACHE_ALIGN_BUFFER(char, buf, CONFIG_ENV_SIZE*2);
#else
	ALLOC_CACHE_ALIGN_BUFFER(char, buf, CONFIG_ENV_SIZE);
#endif
	struct blk_desc *desc;
	disk_partition_t info = { 0 };
	int ret;
	char *errmsg = "!no device";
	int workmode = get_boot_work_mode();
	char ids[MTDIDS_MAXLEN];
	char parts[MTDPARTS_MAXLEN];
	char partition[PARTITION_MAXLEN];

	if ((workmode & WORK_MODE_PRODUCT) &&
	    (!(workmode & WORK_MODE_UPDATE))) {
		use_sprite_env();
		return 0;
	}

	desc = blk_get_devnum_by_typename("sunxi_flash", 0);
	...
}
```

前面已经分析过：

```text
WORK_MODE_CARD_PRODUCT = 0x11
WORK_MODE_PRODUCT      = 0x10
WORK_MODE_UPDATE       = 0x20
```

所以当 `workmode == WORK_MODE_CARD_PRODUCT` 时：

```text
(workmode & WORK_MODE_PRODUCT) != 0
(workmode & WORK_MODE_UPDATE)  == 0
```

判断成立：

```text
env_sunxi_flash_load()
 -> use_sprite_env()
 -> return 0
```

这意味着 card product 模式不会继续执行：

```c
blk_get_devnum_by_typename("sunxi_flash", 0);
sunxi_flash_try_partition(desc, "env", &info);
read_env(...);
env_import(...);
```

也就是**不会从目标介质的 env 分区读取普通启动 env**。

### 4.4 为什么烧写模式要绕过 env 分区

原因很实际：

- Card Product 模式的目标介质通常是待烧写的 eMMC/NAND/UFS
- 目标介质可能是空片、旧系统、脏数据、分区表不完整
- 烧写流程本身可能马上要擦除/重写 `env` 分区
- 如果此时读取目标介质上的普通 env，`bootcmd` 可能会变成正常启动命令，导致不进入烧写流程

所以 Allwinner 在 product 模式中强制导入内置 env：

```text
bootdelay=0
bootcmd=run sunxi_sprite_test
sunxi_sprite_test=sprite_test read
```

保证后续自动执行：

```text
sprite_test read
 -> do_sprite_test()
 -> sunxi_card_sprite_main()
```

对应入口在：

```text
brandy/brandy-2.0/u-boot-2018/cmd/sunxi_sprite.c:21
```

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
		...
		ret = sunxi_card_sprite_main(0, NULL);
		...
		return ret;
	}
#endif
	...
}
```

## 5. 正常路径如何读取 env 分区

当 `workmode == WORK_MODE_BOOT` 时，product 判断不成立，继续执行 `env_sunxi_flash_load()` 后半部分。

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/env/sunxi_flash.c:343
```

关键片段：

```c
desc = blk_get_devnum_by_typename("sunxi_flash", 0);
if (desc == NULL) {
	ret = -ENODEV;
	goto err;
}
ret = sunxi_flash_try_partition(desc, "env", &info);
/* printf ("name:%s start:0x%x, size: 0x%x\n", info.name, (u32)info.start, (u32)info.size); */
if (ret < 0) {
	ret = -ENODEV;
	goto err;
}

strncpy(ids, env_get("mtdids"), sizeof(ids));
strncpy(parts, env_get("mtdparts"), sizeof(parts));
strncpy(partition, env_get("partition"), sizeof(partition));

#ifdef CONFIG_SUNXI_ENV_BACKUP
if (read_env(desc, (CONFIG_ENV_SIZE*2 + 511) / 512, (uint)info.start,
	     buf)) {
#else
if (read_env(desc, (CONFIG_ENV_SIZE + 511) / 512, (uint)info.start,
	     buf)) {
#endif
	errmsg = "!read failed";
	ret    = -EIO;
	goto err;
}
...
ret = env_import(buf, 1);
...
err:
if (ret)
	set_default_env(errmsg);
```

当前配置没有启用 `CONFIG_SUNXI_ENV_BACKUP`，所以读取大小是：

```text
(CONFIG_ENV_SIZE + 511) / 512
```

当前 `.config` 中：

```text
CONFIG_ENV_SIZE=0x20000
```

也就是读取 128 KiB。

### 5.1 env 分区查找

`sunxi_flash_try_partition()` 位于：

```text
brandy/brandy-2.0/u-boot-2018/board/sunxi/sys_partition.c:377
```

关键片段：

```c
int sunxi_flash_try_partition(struct blk_desc *desc, const char *str,
			      disk_partition_t *info)
{
	int i, ret;
	char temp_part_name[16] = {0};
	...
	sunxi_replace_android_ab_system((char *)str, temp_part_name);

	for (i = 1;; i++) {
#if defined (CONFIG_ENABLE_MTD_CMDLINE_PARTS_BY_ENV) /*Get partitiones by env*/
		ret = sunxi_partition_parse_get_info(i, info);
#else /* Get partitiones by GPT */
		ret = part_get_info(desc, i, info);
		debug("%s: try part %d, ret = %d\n", __func__, i, ret);

#endif
		if (ret < 0)
			return ret;

		if (!strncmp((const char *)info->name, temp_part_name, sizeof(info->name)))
			break;
		else if (!strncmp((const char *)info->name, (char *)str, sizeof(info->name)))
			break;
	}
	return 0;
}
```

对于 env 加载来说，传入的是：

```c
sunxi_flash_try_partition(desc, "env", &info);
```

所以它会遍历分区表，找到名字为 `env` 的分区，把分区起始 LBA 和大小填到 `info`。

### 5.2 env 数据格式和 CRC 校验

env 分区里的内容不是纯文本 `env.cfg`，而是 U-Boot env 二进制格式。

结构定义位于：

```text
brandy/brandy-2.0/u-boot-2018/include/environment.h:136
```

关键片段：

```c
#ifdef CONFIG_SYS_REDUNDAND_ENVIRONMENT
# define ENV_HEADER_SIZE	(sizeof(uint32_t) + 1)

# define ACTIVE_FLAG   1
# define OBSOLETE_FLAG 0
#else
# define ENV_HEADER_SIZE	(sizeof(uint32_t))
#endif

#define ENV_SIZE (CONFIG_ENV_SIZE - ENV_HEADER_SIZE)

typedef struct environment_s {
	uint32_t	crc;		/* CRC32 over data bytes	*/
#ifdef CONFIG_SYS_REDUNDAND_ENVIRONMENT
	unsigned char	flags;		/* active/obsolete flags	*/
#endif
	unsigned char	data[ENV_SIZE]; /* Environment data		*/
} env_t;
```

普通非冗余 env 格式是：

```text
偏移 0x0000: 4 字节 CRC32
偏移 0x0004: name=value\0name=value\0...\0
```

`env_import(buf, 1)` 会校验 CRC：

```text
brandy/brandy-2.0/u-boot-2018/env/common.c:127
```

```c
int env_import(const char *buf, int check)
{
	env_t *ep = (env_t *)buf;

	if (check) {
		uint32_t crc;

		memcpy(&crc, &ep->crc, sizeof(crc));

		if (crc32(0, ep->data, ENV_SIZE) != crc) {
			set_default_env("!bad CRC");
			return -EIO;
		}
	}

	if (himport_r(&env_htab, (char *)ep->data, ENV_SIZE, '\0', 0, 0,
			0, NULL)) {
		gd->flags |= GD_FLG_ENV_READY;
		return 0;
	}

	pr_err("Cannot import environment: errno = %d\n", errno);

	set_default_env("!import failed");
	...
}
```

如果读取失败或 CRC 错误，则 fallback 到 `set_default_env()`：

```text
brandy/brandy-2.0/u-boot-2018/env/common.c:61
```

```c
void set_default_env(const char *s)
{
	...
	if (himport_r(&env_htab, (char *)default_environment,
			sizeof(default_environment), '\0', flags, 0,
			0, NULL) == 0)
		pr_err("Environment import failed: errno = %d\n", errno);

	gd->flags |= GD_FLG_ENV_READY;
	gd->flags |= GD_FLG_ENV_DEFAULT;
}
```

## 6. default_environment 与 SUNXI_SPRITE_ENV_SETTINGS 的区别

### 6.1 default_environment 是编译默认环境

源码位置：

```text
brandy/brandy-2.0/u-boot-2018/include/env_default.h:20
```

关键片段：

```c
#ifdef DEFAULT_ENV_INSTANCE_EMBEDDED
env_t environment __UBOOT_ENV_SECTION__(environment) = {
	ENV_CRC,	/* CRC Sum */
...
#elif defined(DEFAULT_ENV_INSTANCE_STATIC)
static char default_environment[] = {
#else
const uchar default_environment[] = {
#endif
#ifndef CONFIG_USE_DEFAULT_ENV_FILE
...
#ifdef	CONFIG_BOOTCOMMAND
	"bootcmd="	CONFIG_BOOTCOMMAND		"\0"
#endif
...
#ifdef	CONFIG_EXTRA_ENV_SETTINGS
	CONFIG_EXTRA_ENV_SETTINGS
#endif
	"\0"
```

`CONFIG_EXTRA_ENV_SETTINGS` 在 sunxi 平台中定义为：

```text
brandy/brandy-2.0/u-boot-2018/include/configs/sunxi-common.h:433
```

```c
#define CONFIG_EXTRA_ENV_SETTINGS \
	MEM_LAYOUT_ENV_SETTINGS \
	"fdtfile=" FDTFILE "\0" \
	BOOTENV
```

这套 `default_environment` 是 env 分区不可用时的 fallback。

### 6.2 SUNXI_SPRITE_ENV_SETTINGS 是烧写模式专用环境

`SUNXI_SPRITE_ENV_SETTINGS` 不属于 `CONFIG_EXTRA_ENV_SETTINGS`，而是 `env/sunxi_flash.c` 专门为 product 模式准备的：

```c
const uchar sunxi_sprite_environment[] = {
#ifdef SUNXI_SPRITE_ENV_SETTINGS
	SUNXI_SPRITE_ENV_SETTINGS
#endif
	"\0"
};
```

所以三类 env 要区分开：

```text
device/.../env.cfg
 -> 打包时生成 env.fex
 -> 正常启动时从 env 分区读入

default_environment[]
 -> 编译进 U-Boot 的默认 env
 -> env 分区读取失败或 CRC 错时使用

SUNXI_SPRITE_ENV_SETTINGS
 -> 编译进 U-Boot 的烧写模式 env
 -> product/card sprite 模式强制使用
```

## 7. device/config/chips/a733/configs/default/env.cfg 的作用

源码/配置位置：

```text
device/config/chips/a733/configs/default/env.cfg
```

关键内容：

```text
#kernel command arguments
earlyprintk=sunxi-uart,0x02500000
initcall_debug=0
console=ttyS0,115200
nand_root=/dev/nand0p4
mmc_root=/dev/mmcblk0p4
ufs_root=/dev/sda4
init=/init
loglevel=8
selinux=0
cma=8M
mac=
wifi_mac=
bt_mac=
specialstr=
keybox_list=hdcpkey,widevine
arm-smmu-v3=0
```

启动参数拼接命令：

```text
setargs_nand=setenv bootargs earlyprintk=${earlyprintk} initcall_debug=${initcall_debug} console=${console} loglevel=${loglevel} root=${nand_root} init=${init} partitions=${partitions} cma=${cma} snum=${snum} mac_addr=${mac} wifi_mac=${wifi_mac} bt_mac=${bt_mac} selinux=${selinux} specialstr=${specialstr} gpt=1 arm-smmu-v3.disable_bypass=${arm-smmu-v3}
setargs_mmc=setenv  bootargs earlyprintk=${earlyprintk} initcall_debug=${initcall_debug} console=${console} loglevel=${loglevel} root=${mmc_root}  init=${init} partitions=${partitions} cma=${cma} snum=${snum} mac_addr=${mac} wifi_mac=${wifi_mac} bt_mac=${bt_mac} selinux=${selinux} specialstr=${specialstr} gpt=1 arm-smmu-v3.disable_bypass=${arm-smmu-v3}
setargs_ufs=setenv  bootargs earlyprintk=${earlyprintk} initcall_debug=${initcall_debug} console=${console} loglevel=${loglevel} root=${ufs_root}  init=${init} partitions=${partitions} cma=${cma} snum=${snum} mac_addr=${mac} wifi_mac=${wifi_mac} bt_mac=${bt_mac} selinux=${selinux} specialstr=${specialstr} gpt=1 arm-smmu-v3.disable_bypass=${arm-smmu-v3}
```

启动命令：

```text
boot_normal=sunxi_flash read 4007f800 boot;bootm 0x4007f800
boot_fastboot=fastboot

bootdelay=0
bootcmd=run setargs_nand boot_normal#default nand boot
```

这个文件是**普通系统启动 env 的文本源文件**，主要描述：

- kernel command line 基础变量
- 各存储介质的 `setargs_*`
- 读取 boot 分区并启动内核的 `boot_normal`
- 默认 `bootcmd`
- `bootdelay`、console 等基础 env

U-Boot 运行时不会直接打开这个路径读取。它在 pack 阶段被工具转换为 `env.fex`，再被烧录到镜像的 `env` 分区。

## 8. env.cfg 如何生成 env.fex

打包脚本会选择合适的 `env.cfg` 并复制到 pack 输出目录。

源码位置：

```text
build/pack:549
```

关键片段：

```sh
if [ x"${PACK_PLATFORM}" != x"android" ]; then
	printf "linux copying boardt&linux_kernel_version configs file\n"
	local possible_env_path=(
		configs/default
		configs/${LICHEE_BOARD}
		configs/${LICHEE_BOARD}/${LICHEE_KERN_VER}
		configs/${LICHEE_BOARD}/${PACK_PLATFORM}
	)
	local possible_env_list=(
		env.cfg
		env-$(echo ${LICHEE_KERN_VER} | awk -F '-' '{print $2}').cfg
	)
	local copy_env_file=''

	for d in ${possible_env_path[@]}; do
		[ ! -d ${LICHEE_CHIP_CONFIG_DIR}/$d ] && continue
		for file in ${possible_env_list[@]} ; do
			if [ -e "${LICHEE_CHIP_CONFIG_DIR}/$d/$file" ]; then
				copy_env_file=${LICHEE_CHIP_CONFIG_DIR}/$d/$file
			fi
		done
	done
	echo "Use u-boot env file: ${copy_env_file}"
	...
	cp -f ${copy_env_file} ${LICHEE_PACK_OUT_DIR}/env.cfg 2>/dev/null
	...
fi
```

之后生成 `env.fex`：

源码位置：

```text
build/pack:1204
```

关键片段：

```sh
echo 2:LICHEE_REDUNDANT_ENV_SIZE:$LICHEE_REDUNDANT_ENV_SIZE
if [ "x${PACK_FUNC}" = "xprvt" ] ; then
	if [ "x${LICHEE_REDUNDANT_ENV_SIZE}" != "x" ]; then
		generate_env_use_mkenvimage env_burn.cfg env.fex ${LICHEE_REDUNDANT_ENV_SIZE}
	else
		generate_env_for_uboot env_burn.cfg env.fex
	fi
else
	if [ "x${LICHEE_REDUNDANT_ENV_SIZE}" != "x" ]; then
		generate_env_use_mkenvimage env.cfg env.fex ${LICHEE_REDUNDANT_ENV_SIZE}
	else
		generate_env_for_uboot env.cfg env.fex
	fi
fi
```

`generate_env_for_uboot()` 定义在：

```text
build/pack:945
```

```sh
function generate_env_for_uboot()
{
	# u_boot_env_gen env_nor.cfg env_nor.fex >/dev/null
	u_boot_env_gen $1 $2 >/dev/null
}
```

也就是：

```text
env.cfg
 -> u_boot_env_gen
 -> env.fex
```

如果启用冗余 env，则走 `mkenvimage`：

```text
build/pack:935
```

```sh
function generate_env_use_mkenvimage()
{
	echo "--mkenvimage create redundant env data!--"
	echo "--redundant $1 data size ${LICHEE_REDUNDANT_ENV_SIZE}---"
	mv $1 .env.cfg
	sed 's/#.*//' .env.cfg > $1
	# mkenvimage -r -p 0x00 -s ${LICHEE_REDUNDANT_ENV_SIZE} -o env.fex env_burn.cfg
	mkenvimage -r -p 0x00 -s $3 -o $2 $1
}
```

当前 `.config` 未启用 U-Boot 侧的 env backup/redundant，因此正常理解为单份 `env.fex`。

## 9. env.fex 如何进入 env 分区

分区配置中指定了 `env` 分区和对应下载文件。

配置位置：

```text
device/config/chips/a733/configs/default/sys_partition.fex:36
```

关键片段：

```ini
[partition]
    name         = env
    size         = 32768
    downloadfile = "env.fex"
	user_type    = 0x8000
```

因此 pack/烧写关系是：

```text
device/.../env.cfg
 -> pack 生成 env.fex
 -> 固件镜像中 env 分区的 downloadfile 是 env.fex
 -> sprite 烧写时把 env.fex 写入目标介质 env 分区
 -> 正常启动时 U-Boot 从 env 分区读取 env.fex 内容
```

这也解释了为什么 Card Product 模式不能直接读取 env 分区：烧写开始前，这个分区可能还不存在或内容无效；烧写过程中，这个分区会被重写为镜像中的 `env.fex`。

## 10. 当前工程实际使用哪个 env.cfg

当前 `.buildconfig` 中可以看到：

```text
LICHEE_PLATFORM=linux
LICHEE_LINUX_DEV=debian
LICHEE_BOARD=x733mhn_aic8800
LICHEE_KERN_VER=linux-6.6
LICHEE_CHIP_CONFIG_DIR=.../device/config/chips/a733
LICHEE_BOARD_CONFIG_DIR=.../device/config/chips/a733/configs/x733mhn_aic8800
```

工程中存在：

```text
device/config/chips/a733/configs/default/env.cfg
device/config/chips/a733/configs/x733mhn_aic8800/debian/env.cfg
```

按照 `build/pack` 的选择逻辑：

```sh
possible_env_path=(
	configs/default
	configs/${LICHEE_BOARD}
	configs/${LICHEE_BOARD}/${LICHEE_KERN_VER}
	configs/${LICHEE_BOARD}/${PACK_PLATFORM}
)
```

后找到的会覆盖前面的 `copy_env_file`，因此当前 `x733mhn_aic8800 + debian` 组合更可能使用：

```text
device/config/chips/a733/configs/x733mhn_aic8800/debian/env.cfg
```

而不是：

```text
device/config/chips/a733/configs/default/env.cfg
```

二者关键差异包括：

```text
default/env.cfg:
mmc_root=/dev/mmcblk0p4
init=/init

x733mhn_aic8800/debian/env.cfg:
mmc_root=/dev/mmcblk1p4
init=/usr/sbin/init
setargs_mmc 中额外包含 rootwait rw
```

所以：

- `default/env.cfg` 是芯片默认模板
- board/platform 目录下的 `env.cfg` 是板级/系统级覆盖
- 最终烧进 env 分区的是 pack 输出目录中的 `env.fex`

## 11. 为什么 env.cfg 默认 bootcmd 是 nand，但 eMMC 也能启动

`env.cfg` 中默认：

```text
bootcmd=run setargs_nand boot_normal#default nand boot
```

这看起来像默认 NAND 启动，但 U-Boot 正常启动时还会根据实际存储类型修正 `bootcmd`。

修正逻辑位于：

```text
brandy/brandy-2.0/u-boot-2018/board/sunxi/board_helper.c:783
```

关键片段：

```c
int sunxi_update_bootcmd(void)
{
	char  boot_commond[128];
	int   storage_type = get_boot_storage_type();
	memset(boot_commond, 0x0, 128);
	strncpy(boot_commond, env_get("bootcmd"), sizeof(boot_commond)-1);
	debug("base bootcmd=%s\n", boot_commond);

	if ((storage_type == STORAGE_SD) || (storage_type == STORAGE_EMMC) ||
	    (storage_type == STORAGE_EMMC3) || (storage_type == STORAGE_EMMC0)) {
		sunxi_str_replace(boot_commond, "setargs_nand", "setargs_mmc");
		debug("bootcmd set setargs_mmc\n");
	} else if ((storage_type == STORAGE_UFS)) {
		sunxi_str_replace(boot_commond, "setargs_nand", "setargs_ufs");
		debug("bootcmd set setargs_ufs\n");
	} else if (storage_type == STORAGE_NOR) {
		sunxi_str_replace(boot_commond, "setargs_nand", "setargs_nor");
	} else if (storage_type == STORAGE_NAND) {
		...
	}

	sunxi_set_bootcmd(boot_commond);

	env_set("bootcmd", boot_commond);
	...
}
```

调用点在 `board_late_init()`：

```text
brandy/brandy-2.0/u-boot-2018/board/sunxi/board_common.c:813
```

```c
sunxi_update_bootcmd();
```

所以正常 eMMC/SD 启动时：

```text
env 分区加载出的 bootcmd:
run setargs_nand boot_normal

sunxi_update_bootcmd():
setargs_nand -> setargs_mmc

最终执行:
run setargs_mmc boot_normal
```

UFS 启动时则会替换为：

```text
run setargs_ufs boot_normal
```

## 12. Card Product 模式与正常模式中的 bootcmd 来源对比

### 12.1 Card Product 模式

```text
bootcmd 来源：
SUNXI_SPRITE_ENV_SETTINGS

运行时 bootcmd：
bootcmd=run sunxi_sprite_test

后续：
sunxi_sprite_test=sprite_test read
 -> do_sprite_test()
 -> sunxi_card_sprite_main()
```

这一路不读目标介质上的 `env` 分区。

### 12.2 正常启动模式

```text
bootcmd 来源：
目标介质 env 分区中的 env.fex

env.fex 来源：
device/.../env.cfg 在 pack 阶段生成

运行时 bootcmd：
先导入 env.fex 中的 bootcmd
再由 sunxi_update_bootcmd() 根据 storage_type 修正
最后 autoboot 执行
```

如果 env 分区读取失败或 CRC 错误，则使用编译进 U-Boot 的 `default_environment[]`。

## 13. 与前一份 Card Sprite 调用链的衔接

前一份文档已经分析了：

```text
sunxi_flash_init_ext()
 -> sunxi_flash_probe()
 -> current_flash = &sunxi_sdmmcs_desc
 -> sunxi_sprite_mmc_probe()
 -> sdmmc_init_for_sprite(0, 2)
 -> sprite_flash = target eMMC
 -> current_flash = source SD
```

env 这条线接在它后面：

```text
initr_sunxi_plat()
 -> flash 初始化完成

initr_env()
 -> product 模式导入 sprite env

autoboot
 -> bootcmd=run sunxi_sprite_test
 -> sprite_test read
 -> sunxi_card_sprite_main()
```

因此完整 Card Product 自动烧写路径可以理解为两条初始化线汇合：

```text
介质初始化线：
workmode=0x11
 -> sunxi_flash_init_ext()
 -> probe target eMMC
 -> init source SD

env/命令线：
workmode=0x11
 -> env_sunxi_flash_load()
 -> use_sprite_env()
 -> bootcmd=run sunxi_sprite_test

汇合：
autoboot 执行 sprite_test
 -> sunxi_card_sprite_main()
 -> 从 SD 读固件，向 eMMC 写镜像
```

## 14. 常见误区

### 14.1 env.cfg 不是 U-Boot 运行时直接读的文件

U-Boot 运行时读的是目标介质 `env` 分区中的二进制 env 数据，即 `env.fex` 烧进去后的内容。`device/.../env.cfg` 是 pack 阶段输入文件。

### 14.2 SUNXI_SPRITE_ENV_SETTINGS 不是 env.cfg 生成的

`SUNXI_SPRITE_ENV_SETTINGS` 是写在 `include/configs/sunxi-common.h` 里的宏，编译进 U-Boot。

### 14.3 Card Product 模式不会读取目标 env 分区

只要：

```c
(workmode & WORK_MODE_PRODUCT) && (!(workmode & WORK_MODE_UPDATE))
```

成立，`env_sunxi_flash_load()` 就直接 `use_sprite_env()` 并返回，不再读取 `env` 分区。

### 14.4 default_environment 与 env.cfg 不是同一回事

`default_environment[]` 是编译进 U-Boot 的 fallback；`env.cfg` 是 pack 时生成 `env.fex` 的源文本。

### 14.5 env.cfg 中默认 setargs_nand 不代表最终一定 NAND 启动

正常启动时 `sunxi_update_bootcmd()` 会按实际 `storage_type` 替换为 `setargs_mmc`、`setargs_ufs` 等。

## 15. 精简版答案

### 为什么这个流程中会自动添加 SUNXI_SPRITE_ENV_SETTINGS？

因为 card product 模式下：

```c
workmode = get_boot_work_mode(); // 0x11

if ((workmode & WORK_MODE_PRODUCT) &&
    (!(workmode & WORK_MODE_UPDATE))) {
	use_sprite_env();
	return 0;
}
```

`use_sprite_env()` 会执行：

```c
himport_r(&env_htab, (char *)sunxi_sprite_environment,
          sizeof(sunxi_sprite_environment), '\0', H_INTERACTIVE, 0,
          0, NULL);
gd->flags |= GD_FLG_ENV_READY;
```

而 `sunxi_sprite_environment` 的内容来自：

```c
#define SUNXI_SPRITE_ENV_SETTINGS \
	"bootdelay=0\0" \
	"bootcmd=run sunxi_sprite_test\0" \
	"console=ttyS0,115200\0" \
	"sunxi_sprite_test=sprite_test read\0"
```

目的就是强制进入烧写命令：

```text
bootcmd=run sunxi_sprite_test
 -> sprite_test read
 -> sunxi_card_sprite_main()
```

### 正常路径呢？

正常启动 `workmode == WORK_MODE_BOOT`，product 判断不成立，于是：

```text
env_sunxi_flash_load()
 -> 找 sunxi_flash 块设备
 -> 找 env 分区
 -> 读 CONFIG_ENV_SIZE 数据
 -> env_import(buf, 1)
 -> CRC 校验
 -> himport_r(ep->data)
```

### device/config/chips/a733/configs/default/env.cfg 是干什么的？

它是 pack 阶段生成 `env.fex` 的文本源文件：

```text
env.cfg
 -> u_boot_env_gen
 -> env.fex
 -> sys_partition.fex 指定 downloadfile="env.fex"
 -> 烧到目标介质 env 分区
 -> 正常启动时 U-Boot 从 env 分区读取
```

Card Product 烧写模式不会用目标介质上的这份 env；正常启动才会用。
