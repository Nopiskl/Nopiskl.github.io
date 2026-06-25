# RK recovery image generation and partition analysis
_Exported on 2026/4/19 at GMT+8 13:24:25 from Cursor (2.6.21)_

---

**User**

帮我分析一下RK的recovery镜像如何生成的？并且根据源码简要分析recovery分区作用

---

**Cursor**

我先在源码里定位 `recovery` 镜像的构建入口、打包脚本和分区相关代码。

我已经定位到几处关键位置了，接下来读几个核心脚本和源码：`mk-recovery.sh`、`recovery.mk`、`external/recovery` 以及和启动参数相关的板级配置。

我继续往下看两类关键点：一类是 `recovery.img` 最终怎么被封装；另一类是系统如何“进入 recovery”，也就是 `misc/BCB/boot-recovery` 这一条链路。

我读到镜像打包脚本了：`recovery.img` 本质是“内核 + recovery 根文件系统（ramdisk）”打包出来的。下面再读 `bootloader.c` 和分区参数文件，确认它是如何依赖 `misc` 分区与 `recovery` 分区的。

现在已经确认了分区表里确实有独立 `recovery` 分区，也确认 `misc` 分区负责传递“下次启动进 recovery”的控制信息。再补两块：`recovery` 程序的主流程，以及 bootloader/U-Boot 如何根据 `misc` 决定启动 recovery。

我补读一下与构建变量、主流程实现直接相关的文件，避免只停留在脚本层面。

`pack` 那边也已经确认会把 `recovery.img` 一起纳入固件。现在我直接把 `recovery.c` 主流程关键片段读出来，并找到 `pack` 的实际脚本位置。

我已经把关键链路找出来了。为了给你一个更扎实的结论，我再补一下精确定位：把几个核心文件中的关键函数和语句定位到具体行号。

我把关键文件精确读一遍，拿到可引用的行号后，给你做一个按源码链路的简洁分析。

参数文件路径我刚才拼错了，我修正后补上分区表和 `bootloader/recovery` 关键头文件。

还差最后一步：把 `recovery.c` 中“写入 boot-recovery / 执行升级 / 擦数据 / 清理现场”几段拿成带行号的引用。

可以，下面我按“源码链路”给你做一个简要但尽量扎实的分析。

## 一、先说结论

在这套 RK3568 Linux SDK 里，`recovery.img` 不是单独编译出来一个大二进制，而是：

1. 先用 `buildroot` 构建一个最小恢复系统的根文件系统；
2. 根文件系统里包含 `external/recovery` 编译出来的 `recovery` 可执行程序，以及它依赖的资源/UI/升级工具；
3. 再把 **kernel + recovery ramdisk(rootfs.cpio.gz)** 打包成 `recovery.img`；
4. 最终烧到独立的 `recovery` 分区里；
5. 是否进入 recovery，不是靠 `recovery` 分区自己决定，而是靠 `misc` 分区里的 `bootloader_message`/BCB 信息告诉 bootloader：“下次启动进入 recovery”。

所以：

- `recovery.img` 本质上是“一个专门用于恢复/升级的小 Linux 启动镜像”；
- `recovery` 分区是“存放这个恢复系统镜像的专用启动分区”；
- `misc` 分区是“通知 bootloader 下次从 recovery 分区启动”的控制分区。

---

## 二、recovery 镜像如何生成

### 1）总入口：`mk-recovery.sh`

核心脚本在 `device/rockchip/common/scripts/mk-recovery.sh`。

从这里可以直接看出构建流程：

```1:35:/home/alientek/RK3568/rk356x-linux/device/rockchip/common/scripts/mk-recovery.sh
#!/bin/bash -e

usage_hook()
{
	echo -e "recovery                          \tbuild recovery"
}

clean_hook()
{
	check_config RK_RECOVERY_CFG || return 0
	rm -rf buildroot/output/$RK_RECOVERY_CFG
	rm -rf "$RK_OUTDIR/recovery"
}

BUILD_CMDS="recovery"
build_hook()
{
	[ -z "$RK_AB_UPDATE" ] || return 0

	check_config RK_RECOVERY_CFG || return 0

	echo "=========================================="
	echo "          Start building recovery(buildroot)"
	echo "=========================================="


	DST_DIR="$RK_OUTDIR/recovery"

	/usr/bin/time -f "you take %E to build recovery(buildroot)" \
		"$SCRIPTS_DIR/mk-buildroot.sh" $RK_RECOVERY_CFG "$DST_DIR"

	/usr/bin/time -f "you take %E to pack recovery image" \
		"$SCRIPTS_DIR/mk-ramdisk.sh" "$DST_DIR/rootfs.cpio.gz" \
		"$DST_DIR/recovery.img" "$RK_RECOVERY_FIT_ITS"
	ln -rsf "$DST_DIR/recovery.img" "$RK_FIRMWARE_DIR"

	finish_build build_recovery
}
```

这里已经很清楚了：

- `mk-buildroot.sh $RK_RECOVERY_CFG "$DST_DIR"`
  - 先根据 recovery 的 buildroot 配置生成恢复系统 rootfs；
- `mk-ramdisk.sh "$DST_DIR/rootfs.cpio.gz" "$DST_DIR/recovery.img" "$RK_RECOVERY_FIT_ITS"`
  - 再把这个 rootfs 打成 ramdisk，和内核一起封装成 `recovery.img`；
- 最后把 `recovery.img` 链接到固件目录，参与后续打包/烧录。

---

### 2）recovery 用户态程序从哪里来：`recovery.mk`

Buildroot 包定义在 `buildroot/package/rockchip/recovery/recovery.mk`：

```1:87:/home/alientek/RK3568/rk356x-linux/buildroot/package/rockchip/recovery/recovery.mk
################################################################################
#
# Rockchip Recovery For Linux
#
################################################################################

RECOVERY_VERSION = develop
RECOVERY_SITE = $(TOPDIR)/../external/recovery
RECOVERY_SITE_METHOD = local

RECOVERY_LICENSE = ROCKCHIP
RECOVERY_LICENSE_FILES = NOTICE

RECOVERY_CFLAGS = $(TARGET_CFLAGS) -I. \
	-fPIC \
	-lpthread \
	-lcurl \
	-lssl \
	-lcrypto \
	-lbz2

RECOVERY_MAKE_ENV = $(TARGET_MAKE_ENV)

RECOVERY_DEPENDENCIES += libpthread-stubs util-linux libcurl openssl

ifeq ($(BR2_PACKAGE_RECOVERY_NO_UI),y)
RECOVERY_MAKE_ENV += RecoveryNoUi=true
else
RECOVERY_CFLAGS += -lpng -ldrm -lz -lm -I$(STAGING_DIR)/usr/include/libdrm
RECOVERY_DEPENDENCIES += libpng libdrm libzlib
endif

# ...
define RECOVERY_BUILD_CMDS
	$(RECOVERY_MAKE_ENV) $(MAKE) -C $(@D) \
		CC="$(TARGET_CC)" CFLAGS="$(RECOVERY_CFLAGS)"
endef

ifeq ($(BR2_PACKAGE_RECOVERY_RECOVERYBIN),y)
define RECOVERYBIN_INSTALL_TARGET
	$(INSTALL) -D -m 755 $(@D)/recovery $(TARGET_DIR)/usr/bin/

	mkdir -p $(TARGET_DIR)/res/images
	cp $(@D)/res/images/* $(TARGET_DIR)/res/images/
endef

define RECOVERY_INSTALL_INIT_SYSV
	$(INSTALL) -D -m 755 $(RECOVERY_PKGDIR)/S40recovery \
		$(TARGET_DIR)/etc/init.d/S40recovery
endef
endif

# ...
define UPDATEENGINEBIN_INSTALL_TARGET
	$(INSTALL) -D -m 755 $(@D)/updateEngine $(TARGET_DIR)/usr/bin/
endef
```

这里说明 recovery rootfs 里至少包含：

- `/usr/bin/recovery`
- `/etc/init.d/S40recovery`
- `res/images/*`
- 以及可选的 `/usr/bin/updateEngine`

也就是说，`external/recovery` 是恢复系统的核心应用源码，Buildroot 把它编译后塞进 recovery rootfs。

---

### 3）recovery 启动脚本：进入 recovery 后实际运行什么

启动脚本在 `buildroot/package/rockchip/recovery/S40recovery`：

```1:20:/home/alientek/RK3568/rk356x-linux/buildroot/package/rockchip/recovery/S40recovery
#!/bin/sh
#
# Start Rockchip recovery...
#

case "$1" in
  start)
		echo "starting recovery... "
	  	touch /dev/.coldboot_done
		/usr/bin/recovery &

	;;
  stop)
		killall recovery
        ;;
  *)
        echo "Usage: $0 {start|stop}"
        exit 1
        ;;
esac
exit 0
```

这表明 recovery 分区启动后，init 会执行这个脚本，最后真正跑起来的是：

- `/usr/bin/recovery`

所以整个 recovery 模式的核心逻辑，其实就在 `external/recovery/recovery.c`。

---

### 4）最后如何打成 `recovery.img`：`mk-ramdisk.sh`

`device/rockchip/common/scripts/mk-ramdisk.sh` 直接说明了镜像打包方式：

```1:28:/home/alientek/RK3568/rk356x-linux/device/rockchip/common/scripts/mk-ramdisk.sh
#!/bin/bash -e

RAMDISK_IMG="$1"
TARGET_IMG="$2"
ITS="$3"

if [ ! -f "$RAMDISK_IMG" ]; then
	echo "$RAMDISK_IMG doesn't exist"
	exit 0
fi

KERNEL_IMG="$RK_KERNEL_IMG"

if [ ! -f "$KERNEL_IMG" ]; then
	echo "Build kernel for initrd"
	"$SCRIPTS_DIR/mk-kernel.sh"
fi

# ...

echo "Packing $RAMDISK_IMG to $TARGET_IMG"
if [ -n "$ITS" ]; then
	"$SCRIPTS_DIR/mk-fitimage.sh" "$TARGET_IMG" "$ITS" \
		"$KERNEL_IMG" "$RAMDISK_IMG"
else
	kernel/scripts/mkbootimg --kernel "$KERNEL_IMG" \
		--ramdisk "$RAMDISK_IMG" --second "kernel/resource.img" \
		-o "$TARGET_IMG"
fi
```

含义很明确：

- `RAMDISK_IMG` 是前面 buildroot 生成的 `rootfs.cpio.gz`
- `KERNEL_IMG` 是内核镜像
- 如果配置了 `ITS`，则用 `mk-fitimage.sh` 生成 FIT 格式镜像
- 否则走 `mkbootimg` 路径

你这套 rk3568 目录里还有 `boot4recovery.its`，说明不少板型会用 FIT 方式封装 recovery。

例如：

```1:55:/home/alientek/RK3568/rk356x-linux/device/rockchip/.chips/rk3566_rk3568/boot4recovery.its
/dts-v1/;
/ {
    description = "U-Boot FIT source file for arm";

    images {
        fdt {
            data = /incbin/("@KERNEL_DTB@");
            type = "flat_dt";
            arch = "arm64";
            compression = "none";
            load = <0xffffff00>;
            hash { algo = "sha256"; };
        };

        kernel {
            data = /incbin/("@KERNEL_IMG@");
            type = "kernel";
            arch = "arm64";
            os = "linux";
            compression = "none";
            entry = <0xffffff01>;
            load = <0xffffff01>;
            hash { algo = "sha256"; };
        };

		ramdisk {
			data = /incbin/("@RAMDISK_IMG@");
			type = "ramdisk";
			arch = "arm64";
			os = "linux";
			compression = "none";
			load = <0xffffff02>;
			hash { algo = "sha256"; };
		};

        resource {
            data = /incbin/("@RESOURCE_IMG@");
            type = "multi";
            arch = "arm64";
            compression = "none";
            hash { algo = "sha256"; };
        };
    };
```

所以从源码角度可以概括为：

\[
recovery.img = kernel + ramdisk(rootfs.cpio.gz) [+ dtb/resource]
\]

---

## 三、recovery 分区在哪里定义

在 RK 的 parameter 分区表文件里可以看到 recovery 是一个独立分区：

```1:11:/home/alientek/RK3568/rk356x-linux/device/rockchip/.chips/rk3566_rk3568/parameter-buildroot-fit.txt
FIRMWARE_VER: 1.0
MACHINE_MODEL: RK3568
MACHINE_ID: 007
MANUFACTURER: RK3568
MAGIC: 0x5041524B
ATAG: 0x00200800
MACHINE: 0xffffffff
CHECK_MASK: 0x80
PWR_HLD: 0,0,A,0,1
TYPE: GPT
GROW_ALIGN: 0
CMDLINE: mtdparts=:0x00002000@0x00004000(uboot),0x00002000@0x00006000(misc),0x00020000@0x00008000(boot),0x00040000@0x00028000(recovery),0x00010000@0x00068000(backup),-@0x00078000(rootfs:grow)
```

这里能看出几个重要点：

- `boot` 分区：正常启动镜像
- `recovery` 分区：恢复镜像
- `misc` 分区：启动控制/恢复命令
- `rootfs` 分区：正常系统根文件系统

也就是说，**recovery 分区不是普通数据分区，而是和 boot 分区同级的“启动镜像分区”**。

---

## 四、系统如何进入 recovery：核心靠 `misc` 分区

这部分是理解 recovery 工作机制的关键。

### 1）`misc` 中的数据结构

在 `external/recovery/bootloader.h` 里：

```18:73:/home/alientek/RK3568/rk356x-linux/external/recovery/bootloader.h
static const int BOOTLOADER_MESSAGE_OFFSET_IN_MISC = 16 * 1024;
#define MISC_OFFSET 2048
#define MISC_OFFSET_CMDLINE 6144
#define MISC_OFFSET_CUSTOM (10 * 1024)

// ...

struct bootloader_message {
    char command[32];
    char status[32];
    char recovery[768];
    char needupdate[4];
    char systemFlag[252];
};
```

这里定义了 `bootloader_message`，它存放在 `misc` 分区固定偏移位置，用来在 Linux 和 bootloader/recovery 之间传递状态。

关键字段：

- `command`
- `recovery`
- `systemFlag`

通常最重要的是：

- `command = "boot-recovery"`
- `recovery = "recovery\n--update_package=..."`

---

### 2）读写 `misc` 的实现

在 `external/recovery/bootloader.c` 里：

```28:40:/home/alientek/RK3568/rk356x-linux/external/recovery/bootloader.c
int get_bootloader_message(struct bootloader_message *out)
{
    if (isMtdDevice())
        return get_bootloader_message_mtd(out);

    return get_bootloader_message_block(out);
}

int set_bootloader_message(const struct bootloader_message *in)
{
    if (isMtdDevice())
        return set_bootloader_message_mtd(in);

    return set_bootloader_message_block(in);
}
```

对 block 设备的读写也很直接：

```145:191:/home/alientek/RK3568/rk356x-linux/external/recovery/bootloader.c
static int get_bootloader_message_block(struct bootloader_message *out)
{
    wait_for_device(MISC_PARTITION_NAME_BLOCK);
    FILE* f = fopen(MISC_PARTITION_NAME_BLOCK, "rb");
    // ...
    fseek(f, BOOTLOADER_MESSAGE_OFFSET_IN_MISC, SEEK_SET);
    int count = fread(&temp, sizeof(temp), 1, f);
    // ...
}

static int set_bootloader_message_block(const struct bootloader_message *in)
{
    FILE* f = fopen(MISC_PARTITION_NAME_BLOCK, "wb");
    // ...
    fseek(f, BOOTLOADER_MESSAGE_OFFSET_IN_MISC, SEEK_SET);
    int count = fwrite(in, sizeof(*in), 1, f);
    // ...
}
```

所以恢复链路本质是：

- Linux/Recovery 往 `misc` 固定偏移写 `bootloader_message`
- bootloader 下次上电读取 `misc`
- 决定是否切到 recovery 启动路径

---

## 五、recovery 程序主流程：它到底做什么

### 1）命令来源：命令行 / misc / command 文件

`recovery.c` 里有一个很关键的注释和实现：

```44:68:/home/alientek/RK3568/rk356x-linux/external/recovery/recovery.c
static const char *COMMAND_FILE = "/userdata/recovery/command";
static const char *INTENT_FILE = "/userdata/recovery/intent";
static const char *LOG_FILE = "/userdata/recovery/log";
static const char *LAST_LOG_FILE = "/userdata/recovery/last_log";
```

这说明 recovery 会从 `/userdata/recovery/command` 读命令，也会把日志写到 `/userdata/recovery/`。

更关键的是 `get_args()`：

```216:267:/home/alientek/RK3568/rk356x-linux/external/recovery/recovery.c
static void
get_args(int *argc, char ***argv)
{
    struct bootloader_message boot;
    memset(&boot, 0, sizeof(boot));
    get_bootloader_message(&boot);

    // --- if arguments weren't supplied, look in the bootloader control block
    if (*argc <= 1) {
        boot.recovery[sizeof(boot.recovery) - 1] = '\0';
        const char *arg = strtok(boot.recovery, "\n");
        if (arg != NULL && !strcmp(arg, "recovery")) {
            *argv = (char **) malloc(sizeof(char *) * MAX_ARGS);
            (*argv)[0] = strdup(arg);
            for (*argc = 1; *argc < MAX_ARGS; ++*argc) {
                if ((arg = strtok(NULL, "\n")) == NULL) break;
                (*argv)[*argc] = strdup(arg);
            }
        }
    }

    // --- if that doesn't work, try the command file
    if (*argc <= 1) {
        FILE *fp = fopen_path(COMMAND_FILE, "r");
        // ...
    }

    // always boot into recovery after this (until finish_recovery() is called)
    strlcpy(boot.command, "boot-recovery", sizeof(boot.command));
    strlcpy(boot.recovery, "recovery\n", sizeof(boot.recovery));
    // ...
    set_bootloader_message(&boot);
}
```

这个函数说明：

1. recovery 启动后，先读 `misc` 中的 BCB；
2. 如果没参数，再读 `/userdata/recovery/command`；
3. 一旦拿到参数，它会再次把 `boot.command` 写成 `boot-recovery`。

这个设计的目的就是“可恢复、可重启继续执行”。  
比如升级过程中突然断电，重启后 bootloader 依旧会再次进 recovery，而不是误进主系统。

---

### 2）执行完成后如何退出 recovery

`finish_recovery()` 非常关键：

```284:312:/home/alientek/RK3568/rk356x-linux/external/recovery/recovery.c
static void
finish_recovery(const char *send_intent)
{
    // Copy logs to cache so the system can find out what happened.
    copy_log_file(LOG_FILE, true);
    copy_log_file(LAST_LOG_FILE, false);
    chmod(LAST_LOG_FILE, 0640);

    // Reset to mormal system boot so recovery won't cycle indefinitely.
    struct bootloader_message boot;
    memset(&boot, 0, sizeof(boot));
    strlcpy(boot.systemFlag, systemFlag, sizeof(boot.systemFlag));
    set_bootloader_message(&boot);

    // Remove the command file, so recovery won't repeat indefinitely.
    if (ensure_path_mounted(COMMAND_FILE) != 0 ||
        (unlink(COMMAND_FILE) && errno != ENOENT)) {
        LOGW("Can't unlink %s\n", COMMAND_FILE);
    }

    sync();
}
```

这里做了三件事：

- 保存 recovery 日志；
- 清空/重置 bootloader message，避免无限循环进 recovery；
- 删除 `/userdata/recovery/command`。

所以 `misc` 分区不仅负责“进入 recovery”，也负责“退出 recovery”。

---

### 3）recovery 支持哪些核心功能

#### a. 擦除数据

```314:326:/home/alientek/RK3568/rk356x-linux/external/recovery/recovery.c
static int
erase_volume(const char *volume)
{
    ui_set_background(BACKGROUND_ICON_INSTALLING);
    ui_show_indeterminate_progress();
    ui_print("Formatting %s...\n", volume);

    if (strcmp(volume, "/userdata") == 0) {
        tmplog_offset = 0;
    }

    return format_volume(volume);
}
```

以及 `wipe_data()` 中：

```690:721:/home/alientek/RK3568/rk356x-linux/external/recovery/recovery.c
static void
wipe_data(int confirm)
{
    // ...
    ui_print("\n-- Wiping data...\n");
    device_wipe_data();
    erase_volume("/userdata");
    ui_print("Data wipe complete.\n");
}
```

说明 recovery 的一个典型职责就是：

- 格式化 `userdata`
- 恢复出厂设置

---

#### b. 升级固件 / OTA / update.img

你这套 RK Linux recovery 更偏 Rockchip 自己的升级机制，不完全是安卓标准 OTA ZIP。

关键逻辑：

```723:764:/home/alientek/RK3568/rk356x-linux/external/recovery/recovery.c
static int ui_update(const char * fw_package)
{
    const char* binary = "/usr/bin/rkupdate";
    // ...
#ifdef USE_RKUPDATE
        status = do_rk_update(binary, fw_package);
#endif

#ifdef USE_UPDATEENGINE
        const char* updateEnginebin = "/usr/bin/updateEngine";
        status = do_rk_updateEngine(updateEnginebin, fw_package);
#endif
    // ...
}
```

主流程里也有：

```1005:1045:/home/alientek/RK3568/rk356x-linux/external/recovery/recovery.c
    } else if (update_package != NULL) {
        int i, ret = 0;
        const char* binary = "/usr/bin/rkupdate";

        rockchip_partition_check();

        for (i = 0; i < 5; i++) {
            if (!ensure_path_mounted(update_package)) {
                LOGI("mounted %s Success.\n", update_package);
                break;
            }
            // ...
        }
        if (i != 5) {
#ifdef USE_RKUPDATE
            status = do_rk_update(binary, update_package);
#endif
#ifdef USE_UPDATEENGINE
            const char* updateEnginebin = "/usr/bin/updateEngine";
            status = do_rk_updateEngine(updateEnginebin, update_package);
#endif
            if (status == INSTALL_SUCCESS) {
                strcpy(systemFlag, update_package);
                if (access(update_package, F_OK) == 0)
                    remove(update_package);
                ui_print("update.img images success!\n");
            }
        }
```

这说明 recovery 负责：

- 挂载升级介质；
- 调用 `rkupdate` 或 `updateEngine`；
- 刷写固件镜像；
- 升级成功后清理升级文件。

#### c. 从 SD 卡 / U 盘 / userdata 升级

菜单逻辑在 `prompt_and_wait()` 里：

```766:839:/home/alientek/RK3568/rk356x-linux/external/recovery/recovery.c
static void
prompt_and_wait()
{
    // ...
    switch (chosen_item) {
        case ITEM_REBOOT:
            return;

        case ITEM_WIPE_DATA:
            wipe_data(ui_text_visible());
            break;

        case ITEM_APPLY_SDCARD: {
            int status = sdcard_directory(SDCARD_ROOT);
            // ...
        }
        break;

        case ITEM_APPLY_USERDATA: {
            const char* fw_package = "/userdata/update.img";
            int status = ui_update(fw_package);
            // ...
        }
        break;

        case ITEM_APPLY_UDISK: {
            const char* fw_package = "/udisk/update.img";
            int status = ui_update(fw_package);
            // ...
        }
        break;
    }
}
```

也就是说，这个 recovery 分区里的系统不是摆设，它就是一个独立可交互的维护环境。

---

## 六、根据源码，简要分析 recovery 分区的作用

结合上面源码，我认为可以把 `recovery` 分区的作用概括成 4 点。

### 1）提供一个独立于主系统的“最小可启动维护环境”

正常系统损坏时，`rootfs` 可能起不来；但 `recovery` 分区里有独立镜像，仍可启动。

也就是说 recovery 分区的意义首先是：

- **主系统坏了，仍然有一个备用启动环境可用。**

这和 `boot`/`rootfs` 是互相独立的。

---

### 2）承担固件升级、修复、刷写工作

从 `recovery.c` 来看，它能调用：

- `rkupdate`
- `updateEngine`

还能从：

- `/userdata/update.img`
- `/udisk/update.img`
- SD 卡/U 盘

读取升级包并执行升级。

所以 recovery 分区的核心业务作用就是：

- **离线升级**
- **故障修复**
- **重新刷写系统镜像**

尤其适合主系统不能稳定运行时做升级。

---

### 3）承担恢复出厂设置/擦除数据的职责

从 `erase_volume("/userdata")`、`wipe_data()` 这些逻辑看，recovery 分区还负责：

- 清空用户数据
- 恢复出厂状态

这类操作不能在正在运行的主系统里安全完成，所以通常都放到 recovery 环境里做。

---

### 4）作为升级流程中的“断电可恢复执行点”

`get_args()` 每次都会重新把 `boot-recovery` 写回 `misc`，直到 `finish_recovery()` 清掉为止。  
这说明 recovery 分区还承担了一个很重要的系统设计角色：

- **把升级/恢复过程做成“可中断、可重启、可续跑”的安全状态机。**

换句话说：

- 进入 recovery：由 `misc` 指令触发；
- 升级过程中断电：重启后仍继续进 recovery；
- 升级结束：`finish_recovery()` 清理 `misc`，恢复正常启动。

这是 recovery 分区在工程上的真正价值。

---

## 七、整个链路用一句话串起来

你可以把 RK 这套 recovery 机制理解成：

> 正常系统需要升级/恢复时，先把“下次进 recovery”的命令写入 `misc` 分区；bootloader 读取 `misc` 后改从 `recovery` 分区启动；进入 recovery 后运行独立的小 Linux 系统，执行升级、擦除数据、日志记录等操作；完成后再清除 `misc` 标志，恢复正常从 `boot/rootfs` 启动。

---

## 八、给你一个简洁版结论，适合记笔记

### recovery 镜像生成流程
1. `mk-recovery.sh` 调 `mk-buildroot.sh` 生成 recovery rootfs  
2. Buildroot 从 `external/recovery` 编译 `recovery` 程序并安装到 rootfs  
3. `mk-ramdisk.sh` 将 `kernel + rootfs.cpio.gz` 封装为 `recovery.img`  
4. `recovery.img` 烧录到独立 `recovery` 分区

### recovery 分区作用
1. 提供独立于主系统的最小恢复环境  
2. 执行 `update.img` 升级、OTA/刷机/修复  
3. 执行恢复出厂、擦除 `userdata`  
4. 配合 `misc` 分区实现可恢复的升级流程

### misc 分区作用
1. 存放 `bootloader_message`
2. 告诉 bootloader 下次是否进入 recovery
3. 保存 recovery 参数与状态
4. recovery 完成后清理该标记，回到正常启动

---

如果你愿意，我下一步可以继续帮你做两件事之一：

1. **进一步分析 U-Boot 里是怎么读取 `misc` 并跳转到 recovery 分区的**  
2. **结合你当前 RK3568 板型，把实际编译命令和烧录链路也梳理出来**

---

**User**

请详细解释一下Misc分区是干什么的？为什么它能负责启动控制/恢复命令？为什么不用rootfs中的？

---

**Cursor**

我补几个精准定位点，然后把 `misc` 分区的职责、设计原因和为什么不能放在 `rootfs` 里讲透。

我把 `misc`、`bootloader_message`、以及 `recovery` 如何读写它的关键源码片段再精确读一下，方便直接按代码解释。

可以，这个问题其实是理解 recovery 机制的核心。

先给一句话结论：

> `misc` 分区本质上不是“装系统文件”的分区，而是一个给 **bootloader、内核、recovery** 之间传递“启动控制状态”的小型控制区。  
> 它之所以适合负责“下次进 recovery / 传递恢复命令”，是因为它可以在 **主系统 rootfs 完全不可用之前** 就被读取，而且不依赖文件系统挂载是否成功。

下面我分 4 层讲清楚：

1. `misc` 分区到底存什么  
2. 为什么它能负责启动控制  
3. 为什么不能把这类信息放到 `rootfs` 里  
4. 你这套 RK 源码里具体是怎么体现的

---

## 一、`misc` 分区是干什么的

从你这套 RK3568 的分区表可以看到，`misc` 是一个独立小分区，和 `boot`、`recovery`、`rootfs` 并列：

```1:11:/home/alientek/RK3568/rk356x-linux/device/rockchip/.chips/rk3566_rk3568/parameter-buildroot-fit.txt
FIRMWARE_VER: 1.0
MACHINE_MODEL: RK3568
MACHINE_ID: 007
MANUFACTURER: RK3568
MAGIC: 0x5041524B
ATAG: 0x00200800
MACHINE: 0xffffffff
CHECK_MASK: 0x80
PWR_HLD: 0,0,A,0,1
TYPE: GPT
GROW_ALIGN: 0
CMDLINE: mtdparts=:0x00002000@0x00004000(uboot),0x00002000@0x00006000(misc),0x00020000@0x00008000(boot),0x00040000@0x00028000(recovery),0x00010000@0x00068000(backup),-@0x00078000(rootfs:grow)
```

这里能看出：

- `boot`：正常启动镜像
- `recovery`：恢复镜像
- `rootfs`：正常系统根文件系统
- `misc`：不是系统分区，而是**控制/元数据分区**

---

### 1）源码里 `misc` 存的核心数据：`bootloader_message`

在 `external/recovery/bootloader.h` 中，已经明确把 `misc` 定义为 bootloader 和 recovery 之间交换控制信息的地方：

```18:57:/home/alientek/RK3568/rk356x-linux/external/recovery/bootloader.h
static const int BOOTLOADER_MESSAGE_OFFSET_IN_MISC = 16 * 1024;
#define MISC_OFFSET 2048    //A,B 结构体在偏移2K 的位置
#define MISC_OFFSET_CMDLINE 6144    //擦除命令，在偏移4K 的位置，配合挂载脚本使用
#define MISC_OFFSET_CUSTOM (10 * 1024) //CUSTOM, 8K (10K), length 1K

#define MISC_PAGES_AB 2         // A,B 结构体存在 2 PAGE内
#define MISC_COMMAND_PAGE_AB 1  // A,B 结构体存在 1 PAGE处，即2k

#define AB_SLOT_NUM  2

/* Bootloader Message
 *
 * This structure describes the content of a block in flash
 * that is used for recovery and the bootloader to talk to
 * each other.
 */
struct bootloader_message {
    char command[32];
    char status[32];
    char recovery[768];
    char needupdate[4];
    char systemFlag[252];
};
```

这里至少能看出三层意思：

#### a. `misc` 里有固定偏移
不是“挂载后找个文件”，而是：
- 在固定偏移
- 按固定结构
- 直接读写裸分区

#### b. 它存的是“启动控制信息”
比如：
- `command`
- `status`
- `recovery`
- `systemFlag`

这类字段本身就不是普通业务数据，而是“下次怎么启动”的控制元数据。

#### c. 它不止服务 recovery
你看还有：
- A/B 结构体偏移
- 自定义命令偏移
- 擦除命令偏移

说明 `misc` 在设计上就是一个“小型启动控制邮箱”，不是只给 recovery 用。

---

## 二、为什么 `misc` 能负责启动控制/恢复命令

### 本质原因：因为 bootloader 能在“系统起来之前”读取它

启动顺序要先搞清楚：

1. BootROM
2. bootloader / U-Boot
3. kernel
4. init
5. rootfs 挂载
6. 用户态服务

而“是否进入 recovery”这个决策，必须发生在 **第 2 步或第 3 步之前/之中**。  
因为一旦决定进 recovery，就不能再按正常 rootfs 启动路径走了。

所以，负责这个决策的信息必须满足：

- bootloader 就能拿到
- 不依赖 rootfs 挂载成功
- 不依赖 Linux 用户态服务是否正常
- 分区损坏时仍尽量可读

`misc` 正好满足。

---

### 1）源码证明：recovery/系统直接把控制信息写进 `misc`

`bootloader.c` 里直接对 `misc` 分区原始读写：

```27:71:/home/alientek/RK3568/rk356x-linux/external/recovery/bootloader.c
static int get_bootloader_message_mtd(struct bootloader_message *out);
static int set_bootloader_message_mtd(const struct bootloader_message *in);
static int get_bootloader_message_block(struct bootloader_message *out);
static int set_bootloader_message_block(const struct bootloader_message *in);

int get_bootloader_message(struct bootloader_message *out)
{
    if (isMtdDevice())
        return get_bootloader_message_mtd(out);

    return get_bootloader_message_block(out);
}

int set_bootloader_message(const struct bootloader_message *in)
{
    if (isMtdDevice())
        return set_bootloader_message_mtd(in);

    return set_bootloader_message_block(in);
}

// The Bootloader message is at 16K(0x4000) offset
#define MISC_SIZE ((16 + 4) << 10)
#define CMD_OFFSET (16 << 10)

#define MISC_NAME "misc"
```

block 设备路径更直接：

```145:180:/home/alientek/RK3568/rk356x-linux/external/recovery/bootloader.c
static int get_bootloader_message_block(struct bootloader_message *out)
{
    wait_for_device(MISC_PARTITION_NAME_BLOCK);
    FILE* f = fopen(MISC_PARTITION_NAME_BLOCK, "rb");
    if (f == NULL) {
        LOGE("Can't open %s\n(%s)\n", MISC_PARTITION_NAME_BLOCK, strerror(errno));
        return -1;
    }
    struct bootloader_message temp;
    fseek(f, BOOTLOADER_MESSAGE_OFFSET_IN_MISC, SEEK_SET);

    int count = fread(&temp, sizeof(temp), 1, f);
    // ...
    memcpy(out, &temp, sizeof(temp));
    return 0;
}

static int set_bootloader_message_block(const struct bootloader_message *in)
{
    FILE* f = fopen(MISC_PARTITION_NAME_BLOCK, "wb");
    // ...
    fseek(f, BOOTLOADER_MESSAGE_OFFSET_IN_MISC, SEEK_SET);
    int count = fwrite(in, sizeof(*in), 1, f);
```

这说明 `misc` 的工作方式是：

- 直接打开块设备节点
- seek 到固定 offset
- 读/写结构体

也就是说，`misc` 不是“一个目录”，而是“一个启动协议区域”。

---

### 2）源码证明：recovery 会把“下次继续进 recovery”的命令写回 `misc`

`recovery.c` 中的 `get_args()` 是整个机制的关键：

```232:274:/home/alientek/RK3568/rk356x-linux/external/recovery/recovery.c
static void
get_args(int *argc, char ***argv)
{
    struct bootloader_message boot;
    memset(&boot, 0, sizeof(boot));
    get_bootloader_message(&boot);  // this may fail, leaving a zeroed structure

    // --- if arguments weren't supplied, look in the bootloader control block
    if (*argc <= 1) {
        boot.recovery[sizeof(boot.recovery) - 1] = '\0';
        const char *arg = strtok(boot.recovery, "\n");
        if (arg != NULL && !strcmp(arg, "recovery")) {
            *argv = (char **) malloc(sizeof(char *) * MAX_ARGS);
            (*argv)[0] = strdup(arg);
            for (*argc = 1; *argc < MAX_ARGS; ++*argc) {
                if ((arg = strtok(NULL, "\n")) == NULL) break;
                (*argv)[*argc] = strdup(arg);
            }
            LOGI("Got arguments from boot message\n");
        }
    }

    // --> write the arguments we have back into the bootloader control block
    // always boot into recovery after this (until finish_recovery() is called)
    strlcpy(boot.command, "boot-recovery", sizeof(boot.command));
    strlcpy(boot.recovery, "recovery\n", sizeof(boot.recovery));
    int i;
    for (i = 1; i < *argc; ++i) {
        strlcat(boot.recovery, (*argv)[i], sizeof(boot.recovery));
        strlcat(boot.recovery, "\n", sizeof(boot.recovery));
    }
    set_bootloader_message(&boot);
}
```

这段逻辑的含义是：

- recovery 先从 `misc` 读命令；
- 如果已经进入 recovery，它会再次把 `boot.command = "boot-recovery"` 写回去；
- 这样一来，哪怕升级/恢复中途掉电，重启后 bootloader 仍然知道：  
  “不要进正常系统，继续进 recovery。”

这就是为什么 `misc` 能承担“启动控制”——因为它的状态在**跨重启**时仍然存在，而且 bootloader 能认。

---

### 3）源码证明：操作完成后再清理 `misc`

`finish_recovery()` 会清除这个状态，防止设备一直卡在 recovery：

```334:356:/home/alientek/RK3568/rk356x-linux/external/recovery/recovery.c
static void
finish_recovery(const char *send_intent)
{
    // Copy logs to cache so the system can find out what happened.
    copy_log_file(LOG_FILE, true);
    copy_log_file(LAST_LOG_FILE, false);
    chmod(LAST_LOG_FILE, 0640);

    // Reset to mormal system boot so recovery won't cycle indefinitely.
    struct bootloader_message boot;
    memset(&boot, 0, sizeof(boot));
    strlcpy(boot.systemFlag, systemFlag, sizeof(boot.systemFlag));
    set_bootloader_message(&boot);

    // Remove the command file, so recovery won't repeat indefinitely.
    if (ensure_path_mounted(COMMAND_FILE) != 0 ||
        (unlink(COMMAND_FILE) && errno != ENOENT)) {
        LOGW("Can't unlink %s\n", COMMAND_FILE);
    }

    sync();  // For good measure.
}
```

注意这两步：

- 清 `misc` 里的 `bootloader_message`
- 删除 `/userdata/recovery/command`

这也进一步说明：

- **真正负责跨启动控制的是 `misc`**
- `/userdata/recovery/command` 只是辅助命令文件，不是 bootloader 级别的控制源

---

## 三、为什么不能把这些信息放到 `rootfs` 里

这是最重要的设计问题。

### 结论先说：

> 因为 “是否进入 recovery” 的判断，发生在 `rootfs` 还没被挂载、甚至可能根本挂不上来的时候。  
> 所以这类控制信息绝不能依赖 rootfs 中的文件。

下面分点讲。

---

### 1）bootloader 通常不解析你的 rootfs 文件系统

如果你把命令放到 `rootfs` 的某个文件，比如：

```bash
/rootfs/boot_mode
```

那 bootloader 想读取它，得先做到这些事：

1. 知道 `rootfs` 分区在哪里  
2. 知道它是什么文件系统 ext4 / squashfs / ubifs  
3. 能正确挂载或解析这个文件系统  
4. 能找到目录项和 inode  
5. 能读到指定文件内容  

这对 bootloader 来说代价很高，而且不可靠。

相比之下，`misc` 的方式是：

- 打开裸分区
- 跳到固定偏移
- 读固定结构

这对 bootloader 来说极其简单、稳定。

---

### 2）如果 rootfs 坏了，你就再也进不了 recovery 了

假设把“下次进 recovery”的命令放在 rootfs 中：

- 但现在 rootfs 已经损坏
- ext4 日志坏了
- superblock 坏了
- 分区升级中途写坏了
- 根本挂载不起来

那 bootloader 就拿不到命令了。

而 recovery 的设计目标恰恰是：

> 主系统坏了，也得还能进入恢复环境。

所以控制信息必须放在一个**独立于 rootfs** 的地方。  
`misc` 就是专门干这个的。

---

### 3）rootfs 是“被恢复对象”，不能同时当“恢复指挥中心”

这点非常关键。

在升级、恢复出厂、重刷系统时，`rootfs` 往往正是被操作对象：

- 它可能被覆盖
- 被格式化
- 被替换
- 被校验
- 被回滚

如果你把恢复指令也放在 rootfs 里，那就出现逻辑冲突：

- 一边拿 rootfs 当“要修复的对象”
- 一边又依赖 rootfs 来指导修复流程

这就像：
- 一边拆房子
- 一边把施工图钉在被拆的墙上

显然不合理。

---

### 4）`misc` 可以做到“跨重启状态保存”，而 rootfs 文件不一定可靠

升级/恢复的典型需求是：

- 写入命令：下次进 recovery
- 重启
- recovery 执行一半断电
- 再次启动还要继续 recovery
- 成功后清理标志

这要求状态满足：

- 很小
- 原子性强
- 写入简单
- 不依赖完整文件系统事务
- 跨掉电容易保留

`misc` 恰好是：

- 小分区
- 固定偏移
- 固定结构
- 直接读写

这类“控制字”非常适合放这里。

---

### 5）boot 决策必须早于 rootfs 挂载

再强调一次启动链路：

- bootloader 决定：进 `boot` 还是 `recovery`
- 然后才加载对应内核和 ramdisk
- 然后才可能挂载正常 `rootfs`

所以“进哪个启动分区”的决策逻辑，天然不能依赖“已经进入正常 rootfs 之后的文件”。

否则会出现循环悖论：

> 要决定是否进 recovery，先得挂载 rootfs；  
> 但如果 rootfs 坏了，本来就是要进 recovery 的。

因此从启动时序上，rootfs 根本不适合作为“启动控制源”。

---

## 四、那源码里为什么还有 `/userdata/recovery/command`？

这是个好问题。

在你的源码里，recovery 也支持从命令文件读取参数：

```44:48:/home/alientek/RK3568/rk356x-linux/external/recovery/recovery.c
static const char *COMMAND_FILE = "/userdata/recovery/command";
static const char *INTENT_FILE = "/userdata/recovery/intent";
static const char *LOG_FILE = "/userdata/recovery/log";
static const char *LAST_LOG_FILE = "/userdata/recovery/last_log";
```

而 `get_args()` 的优先级写得很清楚：

```225:266:/home/alientek/RK3568/rk356x-linux/external/recovery/recovery.c
// command line args come from, in decreasing precedence:
//   - the actual command line
//   - the bootloader control block (one per line, after "recovery")
//   - the contents of COMMAND_FILE (one per line)
static void
get_args(int *argc, char ***argv)
{
    // ...
}
```

所以 `/userdata/recovery/command` 的角色是：

- 给 Linux/recovery 用户态传参数
- 作为恢复程序的辅助命令来源
- 方便系统把详细命令写成文本

但它**不是** bootloader 级别的主控制通道。

更准确地说：

- `misc` 负责：  
  “下次必须进 recovery”
- `command` 文件负责：  
  “进入 recovery 后具体做什么参数处理”

而且 recovery 读完参数后，会回写 `misc`：

```257:274:/home/alientek/RK3568/rk356x-linux/external/recovery/recovery.c
    // --> write the arguments we have back into the bootloader control block
    // always boot into recovery after this (until finish_recovery() is called)
    strlcpy(boot.command, "boot-recovery", sizeof(boot.command));
    strlcpy(boot.recovery, "recovery\n", sizeof(boot.recovery));
    // ...
    set_bootloader_message(&boot);
```

这进一步说明：

- 文本命令文件只是“方便输入”
- 真正可靠的跨重启控制，最终还是落到 `misc`

---

## 五、从工程设计角度，可以把 `misc` 理解成什么

你可以把 `misc` 分区理解成以下几种东西的结合体：

### 1）启动邮箱
bootloader、recovery、系统之间传递短消息：

- 下次进 recovery
- 升级状态
- 清除标志

### 2）状态机存储区
升级流程是一个跨重启状态机：

- 请求进入 recovery
- recovery 执行
- 可能断电
- 再次恢复执行
- 完成后退出

`misc` 就是这个状态机的持久化状态。

### 3）独立控制平面
`rootfs`、`boot`、`recovery` 属于“数据面/执行面”  
`misc` 属于“控制面”

这也是为什么它必须独立存在。

---

## 六、一个非常直观的类比

可以把整机启动想成机场运行：

- `rootfs`：乘客区、航站楼
- `boot/recovery`：不同航班
- `misc`：塔台下达的起降指令

为什么指令不能贴在航站楼里？

因为塔台要先决定飞机飞哪条航线，  
不是等旅客都进航站楼后再决定。  
而且如果航站楼着火了，塔台指令仍然必须可用。

`misc` 就是这个“塔台指令区”。

---

## 七、简洁回答你的三个“为什么”

### 1）`misc` 分区是干什么的？
它是一个**小型控制/状态分区**，用于存放 bootloader、系统、recovery 之间约定的启动控制信息，例如：

- 是否进入 recovery
- recovery 参数
- A/B 槽位元数据
- 某些自定义启动命令

---

### 2）为什么它能负责启动控制/恢复命令？
因为它：

- 独立于 rootfs
- bootloader 可以直接读取
- 不依赖文件系统挂载
- 固定偏移、固定结构、读写简单
- 跨重启/掉电更可靠

所以它非常适合保存“下次怎么启动”的小状态。

---

### 3）为什么不用 rootfs 中的？
因为：

- bootloader 在 rootfs 挂载前就要做启动决策
- rootfs 可能损坏、挂载失败
- rootfs 本身可能正是被升级/修复/擦除的对象
- 依赖 rootfs 会让 recovery 在系统损坏时失效

所以启动控制信息必须放在 rootfs 之外。

---

如果你愿意，我下一步可以继续帮你画一张“**RK 启动链路 + misc/recovery/rootfs 关系图**”，用时序图的方式把：

- 正常启动
- 请求进入 recovery
- recovery 执行升级
- 清除 misc 返回正常系统

完整串起来。

