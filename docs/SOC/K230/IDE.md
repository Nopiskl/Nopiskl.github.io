
---

**User**

那你继续帮我分析一下CanMV IDE如何和RTOS系统进行通信的，找出相关源码并做架构上的分析
如有需求可以浏览网络资源

---

**Cursor**

结论：**CanMV IDE 和 RTOS 系统的通信核心在 `canmv_k230/src/canmv/port/omv/ide_dbg.c/.h`，底层通过 RTOS 里的 `/dev/ttyUSB` 设备节点进行类 USB CDC/串口通信，上层复用了 OpenMV 风格的 USB debug 协议。**

整体架构可以概括为：

```text
CanMV IDE / OpenMV IDE
        |
        | USB CDC / 串口协议帧
        v
RTOS /dev/ttyUSB
        |
        v
ide_dbg_task() 后台线程
        |
        +--> IDE debug 协议解析：0x30 + cmd + length + payload
        |
        +--> 脚本执行：USBDBG_SCRIPT_EXEC / STOP
        |
        +--> stdout 缓冲：USBDBG_TX_BUF_LEN / TX_BUF
        |
        +--> 图像回传：USBDBG_FRAME_SIZE / FRAME_DUMP
        |
        +--> 文件传输：CREATEFILE / WRITEFILE / VERIFYFILE
        |
        v
MicroPython VM / OpenMV image / MPP Display / VO writeback
```

---

## 1. 协议入口：`ide_dbg.h` 定义 CanMV IDE 支持和命令集

`ide_dbg.h` 里直接打开了 `CONFIG_CANMV_IDE_SUPPORT`，并定义了一套 `USBDBG_*` 命令。这套命令名基本就是 OpenMV IDE 调试协议风格。

```15:51:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.h
#define CONFIG_CANMV_IDE_SUPPORT 1

#if CONFIG_CANMV_IDE_SUPPORT

#define NEW_SAVE_FILE_IMPL

/**
  * To add a new debugging command, increment the last command value used.
  * Set the MSB of the value if the request has a device-to-host data phase.
  * Add the command to usr/openmv.py using the same value.
  * Handle the command control and data in/out (if any) phases in usbdbg.c.
  *
  * See usbdbg.c for examples.
  */
enum usbdbg_cmd {
    USBDBG_NONE             =0x00,
    USBDBG_FW_VERSION       =0x80,
    USBDBG_FRAME_SIZE       =0x81,
    USBDBG_FRAME_DUMP       =0x82,
    USBDBG_ARCH_STR         =0x83,
    USBDBG_SCRIPT_EXEC      =0x05,
    USBDBG_SCRIPT_STOP      =0x06,
    USBDBG_SCRIPT_SAVE      =0x07,
    // USBDBG_FILE_SAVE        =0x07,
    // USBDBG_FILE_SAVE_STATUS =0x88,
    USBDBG_SCRIPT_RUNNING   =0x87,
    USBDBG_TEMPLATE_SAVE    =0x08,
    USBDBG_DESCRIPTOR_SAVE  =0x09,
    USBDBG_ATTR_READ        =0x8A,
    USBDBG_ATTR_WRITE       =0x0B,
    USBDBG_SYS_RESET        =0x0C,
    USBDBG_FB_ENABLE        =0x0D,
    USBDBG_QUERY_STATUS     =0x8D,//0xFFEEBBAA
    USBDBG_TX_BUF_LEN       =0x8E,
    USBDBG_TX_BUF           =0x8F,
    USBDBG_SENSOR_ID        =0x90,
    USBDBG_TX_INPUT         =0x11,
    USBDBG_SET_TIME         =0x12,
    USBDBG_CREATEFILE       =0x20,
    USBDBG_WRITEFILE        =0x21,
```

这个枚举可以直接对应 IDE 端功能：

| 命令 | 功能 |
|---|---|
| `USBDBG_QUERY_STATUS` | IDE 探测设备是否在线 |
| `USBDBG_FW_VERSION` | 获取固件版本 |
| `USBDBG_ARCH_STR` | 获取板卡/架构字符串 |
| `USBDBG_SCRIPT_EXEC` | 下发并执行脚本 |
| `USBDBG_SCRIPT_STOP` | 停止脚本 |
| `USBDBG_SCRIPT_RUNNING` | 查询脚本是否运行 |
| `USBDBG_TX_BUF_LEN` / `USBDBG_TX_BUF` | IDE 拉取 Python 输出 |
| `USBDBG_FRAME_SIZE` / `USBDBG_FRAME_DUMP` | IDE 拉取图像帧 |
| `USBDBG_CREATEFILE` / `WRITEFILE` / `VERIFYFILE` | IDE 文件上传、写入、校验 |
| `USBDBG_SYS_RESET` | IDE 触发复位/退出 IDE 模式 |
| `USBDBG_FB_ENABLE` | 打开/关闭图像回传 |

通信帧状态机也在这里定义：

```86:101:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.h
enum frame_state {
    FRAME_HEAD,
    FRAME_CMD,
    FRAME_RECV,
    FRAME_DATA_LENGTH,
    FRAME_DISPATCH
};

typedef struct {
    enum frame_state state;
    enum usbdbg_cmd cmd;
    uint32_t data_length;
    void* data;
    // private
    uint32_t recv_lack;
    enum frame_state recv_next;
    void* recv_data;
} ide_dbg_state_t;
```

---

## 2. RTOS 端底层通道：打开 `/dev/ttyUSB`

`ide_dbg.c` 的初始化函数会打开 `/dev/ttyUSB`，然后创建后台线程 `ide_dbg_task()`。也就是说，CanMV IDE 并不是直接和 MicroPython VM 通信，而是先进入 RTOS 的 tty 设备，再由 `ide_dbg_task` 做协议分发。

```1326:1355:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
void ide_dbg_init(void) {
    pr_info("IDE debugger built %s %s", __DATE__, __TIME__);

    canmv_misc_dev_ioctl(MISC_DEV_CMD_GET_MEMORY_SIZE, &sys_mem_total_size);

    usb_cdc_fd = open("/dev/ttyUSB", O_RDWR);
    if (usb_cdc_fd < 0) {
        perror("open /dev/ttyUSB error");
        return;
    }
    // clear input buffer
    //while (0 < read(usb_cdc_fd, usb_cdc_read_buf, sizeof(usb_cdc_read_buf)));
    sem_init(&script_sem, 0, 0);
    sem_init(&stdin_sem, 0, 0);
    pthread_mutex_init(&fb_mutex, NULL);
    ide_exception_str.data = (const byte*)"IDE interrupt";
    ide_exception_str.len  = 13;
    ide_exception_str.base.type = &mp_type_str;
    ide_exception_str.hash = qstr_compute_hash(ide_exception_str.data, ide_exception_str.len);
    ide_exception_str_tuple = (mp_obj_tuple_t*)malloc(sizeof(mp_obj_tuple_t)+sizeof(mp_obj_t)*1);
    if(ide_exception_str_tuple==NULL)
        return;
    ide_exception_str_tuple->base.type = &mp_type_tuple;
    ide_exception_str_tuple->len = 1;
    ide_exception_str_tuple->items[0] = MP_OBJ_FROM_PTR(&ide_exception_str);
    ide_exception.base.type = &mp_type_Exception;
    ide_exception.traceback_alloc = 0;
    ide_exception.traceback_len = 0;
    ide_exception.traceback_data = NULL;
    ide_exception.args = ide_exception_str_tuple;
    pthread_create(&ide_dbg_task_p, NULL, ide_dbg_task, NULL);
}
```

`usb_cdc_fd` 是全局 fd，后续所有 IDE 收发都通过它：

```57:68:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
int usb_cdc_fd;
pthread_t ide_dbg_task_p;
static unsigned char usb_cdc_read_buf[4096];
static struct ide_dbg_svfil_t ide_dbg_sv_file;
static mp_obj_exception_t ide_exception; //IDE interrupt
static mp_obj_str_t ide_exception_str;
static mp_obj_tuple_t* ide_exception_str_tuple = NULL;
static sem_t stdin_sem;
static char stdin_ring_buffer[4096];
static unsigned stdin_write_ptr = 0;
static unsigned stdin_read_ptr = 0;
```

---

## 3. 启动时机：MicroPython 主程序启动后初始化 IDE 调试器

`main.c` 里在没有命令行参数时调用 `ide_dbg_init()`。这说明正常固件启动模式下，IDE 调试通道会自动启动。

```480:493:/home/nopiskl/K230/canmv_k230/src/canmv/port/core/main.c
int main(int argc, char **argv) {
    printf("CanMV K230 start in %ld us\n", mp_hal_ticks_us());

    if (argc == 1)
        ide_dbg_init();
    //dup2(usb_cdc_fd, STDOUT_FILENO);
    // We should capture stack top ASAP after start, and it should be
    // captured guaranteedly before any other stack variables are allocated.
    // For this, actual main (renamed main_) should not be inlined into
    // this function. main_() itself may have other functions inlined (with
    // their own stack variables), that's why we need this main/main_ split.
    return main_(argc, argv);
}
```

---

## 4. 模式切换：普通 REPL 模式 vs IDE 模式

`ide_dbg_task()` 会监听 `/dev/ttyUSB`。如果还没有进入 IDE 模式，它会检查 IDE 发送的特殊探测 token。

源码中明确写了三个 token：

```1213:1225:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
        } else if (ide_dbg_attach()) {
            ide_dbg_update(&state, usb_cdc_read_buf, size);
        } else {
            // FIXME: IDE connect
            // FIXME: IDE special token
            const char* IDE_TOKEN = "\x30\x8D\x04\x00\x00\x00"; // CanMV IDE
            const char* IDE_TOKEN2 = "\x30\x80\x0C\x00\x00\x00"; // OpenMV IDE
            const char* IDE_TOKEN3 = "\x30\x87\x04\x00\x00\x00";
            if ((size == 6) && (
                (strncmp((const char*)usb_cdc_read_buf, IDE_TOKEN, size) == 0) ||
                (strncmp((const char*)usb_cdc_read_buf, IDE_TOKEN2, size) == 0) ||
                (strncmp((const char*)usb_cdc_read_buf, IDE_TOKEN3, size) == 0)
```

如果匹配成功，就切换到 IDE 模式：

```1226:1237:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
                )) {
                // switch to ide mode
                pr_verb("[usb] switch to IDE mode");
                if (!ide_dbg_attach()) {
                    interrupt_repl();
                }
                ide_attached = true;
                if (ide_script_running)
                    mp_thread_set_exception_main(MP_OBJ_FROM_PTR(&ide_exception));
                ide_dbg_update(&state, usb_cdc_read_buf, size);
            } else {
```

这说明 CanMV IDE 连接设备时，并不是简单开串口 REPL，而是先发一个特殊协议帧。RTOS 端识别后从普通 REPL 模式切到 IDE debug 模式。

---

## 5. 普通 REPL 通信路径

在没有 IDE attach 时，串口数据会被塞进 `stdin_ring_buffer`，然后 MicroPython 的 `mp_hal_stdin_rx_chr()` 从这个 ring buffer 里取字符。

`ide_dbg_task()` 中普通 REPL 输入路径：

```1281:1293:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
                } else {
                    if (stdin_write_ptr + size <= sizeof(stdin_ring_buffer)) {
                        memcpy(stdin_ring_buffer + stdin_write_ptr, usb_cdc_read_buf, size);
                        stdin_write_ptr += size;
                    } else {
                        // rotate
                        memcpy(stdin_ring_buffer + stdin_write_ptr, usb_cdc_read_buf, sizeof(stdin_ring_buffer) - stdin_write_ptr);
                        memcpy(stdin_ring_buffer, usb_cdc_read_buf + (sizeof(stdin_ring_buffer) - stdin_write_ptr),
                            stdin_write_ptr + size - sizeof(stdin_ring_buffer));
                        stdin_write_ptr = stdin_write_ptr + size - sizeof(stdin_ring_buffer);
                    }
                    while (size--)
                        sem_post(&stdin_sem);
```

MicroPython HAL 里读取 stdin：

```126:139:/home/nopiskl/K230/canmv_k230/src/canmv/port/core/mphalport.c
int mp_hal_stdin_rx_chr(void) {
    int c;
    extern int usb_rx(void);
    while (1) {
        MP_THREAD_GIL_EXIT();
        c = usb_rx();
        MP_THREAD_GIL_ENTER();
        if (c != -1)
            break;
        mp_handle_pending(true);
    }
    return c;
}
```

普通 stdout 输出则在未 attach IDE 时直接走 `usb_tx()`，并且会检查 DTR：

```146:163:/home/nopiskl/K230/canmv_k230/src/canmv/port/core/mphalport.c
    if (ide_dbg_attach()) {
        extern void mpy_stdout_tx(const char* data, size_t size);
        mpy_stdout_tx(str, len);
    } else {
        extern int usb_tx(const void* buffer, size_t size);
        extern int usb_cdc_get_dtr(void);

        if (usb_cdc_get_dtr()) {
            usb_tx(str, len);
        }
    }
    mp_os_dupterm_tx_strn(str, len);
}
```

所以普通 REPL 模式是：

```text
IDE/串口工具输入
  -> /dev/ttyUSB
  -> ide_dbg_task()
  -> stdin_ring_buffer + sem_post()
  -> mp_hal_stdin_rx_chr()
  -> MicroPython REPL

MicroPython print()
  -> mp_hal_stdout_tx_strn()
  -> usb_tx()
  -> /dev/ttyUSB
  -> PC
```

---

## 6. IDE 模式通信帧格式

`ide_dbg_update()` 是核心协议状态机。它按以下顺序解析：

```text
FRAME_HEAD        等待 0x30
FRAME_CMD         读取 1 字节命令
FRAME_DATA_LENGTH 读取 4 字节 data_length
FRAME_DISPATCH    根据 cmd 分发
```

源码：

```617:656:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
static ide_dbg_status_t ide_dbg_update(ide_dbg_state_t* state, const uint8_t* data, size_t length) {
    for (size_t i = 0; i < length;) {
        switch (state->state) {
            case FRAME_HEAD:
                if (data[i] == 0x30) {
                    state->state = FRAME_CMD;
                }
                i += 1;
                break;
            case FRAME_CMD:
                state->cmd = data[i];
                state->state = FRAME_DATA_LENGTH;
                i += 1;
                break;
            case FRAME_DATA_LENGTH:
                // recv 4 bytes
                state->recv_lack = 4;
                state->state = FRAME_RECV;
                state->recv_next = FRAME_DISPATCH;
                state->recv_data = &state->data_length;
                break;
            case FRAME_DISPATCH:
                #define PRINT_ALL 0
                #if !PRINT_ALL
                if ((state->cmd != USBDBG_SCRIPT_RUNNING) &&
                    (state->cmd != USBDBG_FRAME_SIZE) &&
                    (state->cmd != USBDBG_TX_BUF_LEN) &&
                    (state->cmd != USBDBG_FRAME_DUMP))
                #endif
```

因此 IDE 发往 RTOS 的基本帧是：

```text
byte[0]     = 0x30
byte[1]     = cmd
byte[2..5]  = uint32 data_length
byte[6..]   = payload，部分命令再 read_until() 读取
```

---

## 7. IDE 探测、版本、架构信息

`USBDBG_QUERY_STATUS` 返回固定魔数 `0xFFEEBBAA`，这就是 CanMV IDE 判断设备在线的握手响应。

```662:668:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
                    case USBDBG_QUERY_STATUS: {
                        pr_verb("cmd: USBDBG_QUERY_STATUS");
                        uint32_t resp = 0xFFEEBBAA;
                        usb_tx(&resp, sizeof(resp));
                        break;
                    }
```

固件版本命令返回三段版本号：

```669:678:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
                    case USBDBG_FW_VERSION: {
                        pr_verb("cmd: USBDBG_FW_VERSION");
                        uint32_t resp[3] = {
                            FIRMWARE_VERSION_MAJOR,
                            FIRMWARE_VERSION_MINOR,
                            FIRMWARE_VERSION_MICRO
                        };
                        usb_tx(&resp, sizeof(resp));
                        break;
                    }
```

架构字符串会包含 `OMV_ARCH_STR` 和 `OMV_BOARD_TYPE`：

```680:710:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
                    case USBDBG_ARCH_STR: {
                        char buffer[0x40];
                        char unit;
                        int value;

                        if (state->data_length != sizeof(buffer)) {
                            pr_verb("Warning: USBDBG_ARCH_STR data length %u, expected %lu", state->data_length, sizeof(buffer));
                        }

                        // Determine the unit and value
                        if (sys_mem_total_size >= (1 << 30)) {
                            value = sys_mem_total_size / (1 << 30); // Convert to GB
                            unit = 'G';
                        } else if (sys_mem_total_size >= (1 << 20)) {
                            value = sys_mem_total_size / (1 << 20); // Convert to MB
                            unit = 'M';
                        } else if (sys_mem_total_size >= (1 << 10)) {
                            value = sys_mem_total_size / (1 << 10); // Convert to KB
                            unit = 'K';
                        } else {
                            value = sys_mem_total_size; // Stay in bytes
                            unit = 'B';
```

---

## 8. IDE 下发脚本：`USBDBG_SCRIPT_EXEC`

IDE 下发脚本时走 `USBDBG_SCRIPT_EXEC`。RTOS 端会：

1. 如果已有脚本运行，则给主线程注入 `ide_exception`。
2. 分配 `script_string`。
3. 从 `/dev/ttyUSB` 读完整脚本文本。
4. `sem_post(&script_sem)` 唤醒 MicroPython 主循环执行脚本。

```713:731:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
                    case USBDBG_SCRIPT_EXEC: {
                        // TODO
                        pr_verb("cmd: USBDBG_SCRIPT_EXEC size %u", state->data_length);
                        if (ide_script_running != 0)
                            mp_thread_set_exception_main(MP_OBJ_FROM_PTR(&ide_exception));
                        usleep(1000);
                        if (ide_script_running != 0)
                            break;
                        // recv script string
                        script_string = malloc(state->data_length + 1);
                        read_until(usb_cdc_fd, script_string, state->data_length);
                        script_string[state->data_length] = '\0';
                        // into script mode, interrupt REPL, send CTRL-D
                        ide_script_running = 1;
                        sem_post(&script_sem);
                        break;
                    }
```

主线程在发现 `ide_dbg_attach()` 为真时，会进入 IDE 脚本执行路径，从 `ide_dbg_get_script()` 取脚本文本并 `do_str(script)` 执行。

```840:858:/home/nopiskl/K230/canmv_k230/src/canmv/port/core/main.c
    if (ide_dbg_attach()) {
        is_repl_intr = false;
        mp_hal_stdout_tx_str(MICROPY_BANNER_NAME_AND_VERSION);
        mp_hal_stdout_tx_str("; " MICROPY_BANNER_MACHINE);
        mp_hal_stdout_tx_str("\r\n");

        fprintf(stdout, "[mpy] enter script\n");
        nlr_buf_t nlr;
        if (nlr_push(&nlr) == 0) {
            extern char* ide_dbg_get_script();
            gc_collect();
            char* script = ide_dbg_get_script();
            if (script) {
                do_str(script);
            }
            nlr_pop();
        } else {
```

这条链路是：

```text
IDE 点击运行
  -> USBDBG_SCRIPT_EXEC + Python 源码
  -> ide_dbg_update()
  -> script_string
  -> sem_post(script_sem)
  -> main.c IDE 分支
  -> ide_dbg_get_script()
  -> do_str(script)
  -> MicroPython VM 执行
```

---

## 9. 停止脚本：异常注入

`USBDBG_SCRIPT_STOP` 会向 MicroPython 主线程注入 `ide_exception`，实现停止脚本。

```732:741:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
                    case USBDBG_SCRIPT_STOP: {
                        // TODO
                        pr_verb("cmd: USBDBG_SCRIPT_STOP");
                        // raise IDE interrupt
                        if (ide_script_running) {
                            wait_mp_irq_handler_done();
                            mp_thread_set_exception_main(MP_OBJ_FROM_PTR(&ide_exception));
                        }
                        break;
                    }
```

这个设计说明 RTOS 端并不是直接 kill 进程，而是通过 MicroPython 线程异常机制让脚本退出，随后走 soft reset 清理资源。

---

## 10. IDE 获取 Python 输出：stdout ring buffer

IDE 模式下，MicroPython 的 stdout 不直接写 USB，而是进入 `tx_buf` 环形缓冲区。

`mp_hal_stdout_tx_strn()`：

```146:150:/home/nopiskl/K230/canmv_k230/src/canmv/port/core/mphalport.c
    if (ide_dbg_attach()) {
        extern void mpy_stdout_tx(const char* data, size_t size);
        mpy_stdout_tx(str, len);
    } else {
```

`mpy_stdout_tx()` 把输出写入 `tx_buf`：

```160:185:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
// ringbuffer
#define TX_BUF_SIZE (1024 * 128)
static char tx_buf[TX_BUF_SIZE];
static uint32_t tx_buf_w_ptr = 0;
static uint32_t tx_buf_r_ptr = 0;
static pthread_mutex_t tx_buf_mutex = PTHREAD_MUTEX_INITIALIZER;

#define RINGBUFFER_WRITABLE(len,wptr,rptr) ((wptr)>=(rptr)?((len)-(wptr)+(rptr)):((rptr)-(wptr)-1))
#define RINGBUFFER_READABLE(len,wptr,rptr) ((wptr)>=(rptr)?(wptr-rptr):(len-rptr+wptr))
#define TX_BUF_WRITABLE RINGBUFFER_WRITABLE(TX_BUF_SIZE,tx_buf_w_ptr,tx_buf_r_ptr)
#define TX_BUF_READABLE RINGBUFFER_READABLE(TX_BUF_SIZE,tx_buf_w_ptr,tx_buf_r_ptr)
#define RINGBUFFER_WRITE(buf,len,wptr,w,wlen) do{\
if(wlen+wptr<len){memcpy(buf+wptr,w,wlen);wptr+=wlen;}\
else{memcpy(buf+wptr,w,len-wptr);\
memcpy(buf,w+len-wptr,wlen-(len-wptr));wptr=wlen-(len-wptr);}\
}while(0)

void mpy_stdout_tx(const char* data, size_t size) {
    // ringbuffer
    pthread_mutex_lock(&tx_buf_mutex);
```

IDE 通过两个命令拉取输出：

```851:887:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
                    case USBDBG_TX_BUF_LEN: {
                        // DO NOT PRINT
                        pthread_mutex_lock(&tx_buf_mutex);
                        uint32_t len = TX_BUF_READABLE;
                        if (len == 0) {
                        }
                        #if !PRINT_ALL
                        else {
                            pr_verb("cmd: USBDBG_TX_BUF_LEN %u", len);
                        }
                        #endif
                        usb_tx((void*)&len, sizeof(len));
                        pthread_mutex_unlock(&tx_buf_mutex);
                        break;
                    }
                    case USBDBG_TX_BUF: {
                        pthread_mutex_lock(&tx_buf_mutex);
                        // pr_verb("cmd: USBDBG_TX_BUF %u", TX_BUF_READABLE);
                        uint32_t len = TX_BUF_READABLE;
                        if (len > state->data_length) {
                            len = state->data_length;
                        }
                        if (TX_BUF_SIZE - tx_buf_r_ptr > len) {
                            usb_tx(tx_buf + tx_buf_r_ptr, len);
                            tx_buf_r_ptr += len;
                        } else {
```

所以 IDE 控制台输出是**轮询式**：

```text
MicroPython print()
  -> mp_hal_stdout_tx_strn()
  -> mpy_stdout_tx()
  -> tx_buf 环形缓冲
  -> IDE 周期性发 USBDBG_TX_BUF_LEN
  -> 如果 len > 0，再发 USBDBG_TX_BUF
  -> RTOS usb_tx() 返回输出内容
```

---

## 11. 图像回传：两条路径

CanMV IDE 的图像预览有两种来源。

### 11.1 OpenMV framebuffer 路径：`fb_encode_for_ide()`

`framebuffer.c` 中 `fb_encode_for_ide()` 会调用 `ide_set_fb()`，把 `image_t` 的数据交给 IDE 调试模块。

```27:39:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/imlib/framebuffer.c
uint32_t framebuffer_get_buffer_size()
{
    // fprintf(stderr, "[omv] %s\n", __func__);
    return 0;
}

void ide_set_fb(const void* data, uint32_t size, uint32_t width, uint32_t height);

void fb_encode_for_ide(uint8_t *ptr, image_t *img)
{
    // fprintf(stderr, "[omv] %s %p %u %p\n", __func__, ptr, img->size, img->data);
    ide_set_fb(img->data, img->size, img->w, img->h);
```

`ide_set_fb()` 内部会缓存图像数据，等待 IDE 通过 `USBDBG_FRAME_SIZE` / `USBDBG_FRAME_DUMP` 拉取。

```293:306:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
static bool enable_pic = true;
static void* fb_data = NULL;
static uint32_t fb_size = 0, fb_width = 0, fb_height = 0;
static pthread_mutex_t fb_mutex;
// FIXME: reuse buf
void ide_set_fb(const void* data, uint32_t size, uint32_t width, uint32_t height) {
    pthread_mutex_lock(&fb_mutex);
    fb_from = FB_FROM_USER_SET;
    if (fb_data) {
        // not sended
        pthread_mutex_unlock(&fb_mutex);
        return;
    }
```

### 11.2 Display/VO writeback 路径：`Display.init(to_ide=True)`

Python 层 `Display.init()` 支持 `to_ide` 参数。如果开启，它会配置 VO writeback，并调用 `ide_dbg_set_vo_wbc()`。

```193:207:/home/nopiskl/K230/canmv_k230/src/canmv/port/builtin_py/media/display.py
    # type
    # width
    # height
    # to_ide
    # osd_num
    @classmethod
    def init(cls, type = None, width = None, height = None, osd_num = 1, to_ide = False, flag = None, fps = None, quality = 90):
        if cls._is_inited:
            print("Already run Display.init()")
            return

        _type = type
        if _type is None:
            raise ValueError("please run Display.init(type=)")
```

```491:528:/home/nopiskl/K230/canmv_k230/src/canmv/port/builtin_py/media/display.py
        if cls._write_back_to_ide:
            config = k_vb_config()
            config.max_pool_cnt = 1
            config.comm_pool[0].blk_size = cls._width * cls._height * 2
            config.comm_pool[0].blk_cnt = 4
            config.comm_pool[0].mode = VB_REMAP_MODE_NOCACHE

            # configure buffer for image compress in media.init()
            # config.comm_pool[1].blk_size = (cls._width * cls._height + 0xfff) & ~0xfff
            # config.comm_pool[1].blk_cnt = 2
            # config.comm_pool[1].mode = VB_REMAP_MODE_NOCACHE

            # for vo_wbc rotate
            # if cls._panel_flag != None:
            #     config.max_pool_cnt = 3
            #     config.comm_pool[2].blk_size = cls._width * cls._height * 2
            #     config.comm_pool[2].blk_cnt = 1
            #     config.comm_pool[2].mode = VB_REMAP_MODE_NOCACHE

            ret = MediaManager._config(config)
            if not ret:
                raise RuntimeError(f"Display configure buffer for ide failed.")
            config = None

            if not isinstance(quality, int):
                quality = 90
            if quality < 10:
                quality = 90

            ide_dbg_set_vo_wbc(quality, cls._width, cls._height)
```

IDE 端拉图像时，先发 `USBDBG_FRAME_SIZE` 获取宽、高、数据大小，再发 `USBDBG_FRAME_DUMP` 获取图像数据：

```888:916:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
                    case USBDBG_FRAME_SIZE: {
                        // DO NOT PRINT
                        #if PRINT_ALL
                        pr_verb("cmd: USBDBG_FRAME_SIZE");
                        #endif
                        uint32_t resp[3] = {
                            0, // width
                            0, // height
                            0, // size
                        };
                        if (!enable_pic || fb_from == FB_FROM_NONE)
                            goto skip;

                        static uint64_t last_frame_ticks_ms = 0;
                        uint64_t curr_frame_ticks_ms = 0;

                        curr_frame_ticks_ms = mp_hal_ticks_ms();
                        if(33 > (curr_frame_ticks_ms - last_frame_ticks_ms)) {
                            goto skip;
                        }
```

`USBDBG_FRAME_DUMP` 发送实际图像数据：

```1088:1101:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
                    case USBDBG_FRAME_DUMP: {
                        if (fb_from_current == FB_FROM_USER_SET) {
                            pthread_mutex_lock(&fb_mutex);
                            usb_tx((void*)fb_data, fb_size);
                            free((void*)fb_data);
                            fb_data = NULL;
                            pthread_mutex_unlock(&fb_mutex);
                        }
                        #if ENABLE_VO_WRITEBACK
                        else if (fb_from_current == FB_FROM_VO_WRITEBACK) {
                            usb_tx(wbc_jpeg_buffer, wbc_jpeg_size);
                            wbc_jpeg_size = 0;
```

所以图像预览链路是：

```text
方式 A：OpenMV image
Python/Image API
  -> fb_encode_for_ide()
  -> ide_set_fb()
  -> USBDBG_FRAME_SIZE
  -> USBDBG_FRAME_DUMP
  -> IDE 显示

方式 B：Display to_ide
Display.init(to_ide=True)
  -> ide_dbg_set_vo_wbc()
  -> VO writeback
  -> hd_jpeg_encode()
  -> USBDBG_FRAME_SIZE
  -> USBDBG_FRAME_DUMP
  -> IDE 显示
```

---

## 12. 文件上传链路：CREATEFILE / WRITEFILE / VERIFYFILE

CanMV IDE 保存脚本或传文件到板端时，会走新文件传输实现。

`USBDBG_CREATEFILE` 接收文件名、chunk 大小、sha256，并默认把相对路径放到 `/sdcard/` 下：

```786:835:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
                    case USBDBG_CREATEFILE: {
                        pr_verb("cmd: USBDBG_CREATEFILE");
                        memset(&ide_dbg_sv_file.info, 0, sizeof(ide_dbg_sv_file.info));
                        if (sizeof(ide_dbg_sv_file.info) != state->data_length) {
                            ide_dbg_sv_file.errcode = USBDBG_SVFILE_ERR_PATH_ERR;
                            pr_verb("Warning: CREATEFILE expect data length %lu, got %u", sizeof(ide_dbg_sv_file.info), state->data_length);
                            break;
                        }

                        read_until(usb_cdc_fd, &ide_dbg_sv_file.info, sizeof(ide_dbg_sv_file.info));
                        pr_verb("create file: chunk_size(%d), name(%s)",
                                ide_dbg_sv_file.info.chunk_size, ide_dbg_sv_file.info.name);
                        print_sha256(ide_dbg_sv_file.info.sha256);

                        if (ide_dbg_sv_file.file != NULL) {
                            fclose(ide_dbg_sv_file.file);
                        }

                        if (ide_dbg_sv_file.chunk_buffer) {
                            free(ide_dbg_sv_file.chunk_buffer);
                            ide_dbg_sv_file.chunk_buffer = NULL;
                        }

                        const char *name = ide_dbg_sv_file.info.name;
                        char filepath[120] = {0};

                        // 1. if name is empty or dangerous, reject
                        if (strlen(name) == 0 || strstr(name, "..")) {
                            ide_dbg_sv_file.errcode = USBDBG_SVFILE_ERR_PATH_ERR;
                            break;
                        }

                        // 2. if name starts with '/', it's an absolute path: use as-is
```

`USBDBG_WRITEFILE` 按 chunk 写入：

```755:775:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
                    case USBDBG_WRITEFILE: {
                        pr_verb("cmd: USBDBG_WRITEFILE %u bytes", state->data_length);
                        if ((ide_dbg_sv_file.file == NULL) ||
                            (ide_dbg_sv_file.chunk_buffer == NULL) ||
                            (ide_dbg_sv_file.info.chunk_size < state->data_length)) {
                            ide_dbg_sv_file.errcode = USBDBG_SVFILE_ERR_WRITE_ERR;
                            break;
                        }
                        read_until(usb_cdc_fd, ide_dbg_sv_file.chunk_buffer, state->data_length);
                        if (ide_dbg_sv_file.file == NULL) {
                            ide_dbg_sv_file.errcode = USBDBG_SVFILE_ERR_WRITE_ERR;
                        } else {
                            if (fwrite(ide_dbg_sv_file.chunk_buffer, 1, state->data_length, ide_dbg_sv_file.file) == state->data_length) {
                                ide_dbg_sv_file.errcode = USBDBG_SVFILE_ERR_NONE;
```

`USBDBG_VERIFYFILE` 用 SHA256 校验：

```776:785:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
                        break;
                    }
                    case USBDBG_VERIFYFILE: {
                        pr_verb("cmd: USBDBG_VERIFYFILE");

                        uint32_t resp = USBDBG_SVFILE_VERIFY_ERR_NONE;

                        if (ide_dbg_sv_file.file != NULL) {
                            fclose(ide_dbg_sv_file.file);
```

这条链路是：

```text
IDE 保存文件
  -> USBDBG_CREATEFILE，发送 name/chunk_size/sha256
  -> RTOS fopen("/sdcard/xxx", "w")
  -> USBDBG_WRITEFILE，多次 chunk 写入
  -> USBDBG_VERIFYFILE，RTOS 计算 sha256
  -> IDE 获取结果
```

---

## 13. RTOS 侧还提供一个用户态 `usb.Serial` 模块，但它不是 IDE 主控制通道

`modusb.c` 注册了 Python 模块 `usb`，里面有 `Serial` 类型：

```27:41:/home/nopiskl/K230/canmv_k230/src/canmv/port/modules/modusb.c
#include "py_modules.h"

STATIC const mp_rom_map_elem_t usb_module_globals_table[] = {
    { MP_ROM_QSTR(MP_QSTR___name__), MP_ROM_QSTR(MP_QSTR_usb) },

    { MP_ROM_QSTR(MP_QSTR_Serial), MP_ROM_PTR(&py_usb_serial_type) },
};
STATIC MP_DEFINE_CONST_DICT(usb_module_globals, usb_module_globals_table);

const mp_obj_module_t usb_module = {
    .base    = { &mp_type_module },
    .globals = (mp_obj_dict_t*)&usb_module_globals,
};

MP_REGISTER_MODULE(MP_QSTR_usb, usb_module);
```

`usb.Serial` 默认打开 `/dev/ttyUSB1`：

```70:88:/home/nopiskl/K230/canmv_k230/src/canmv/port/modules/modusb.serial.c
STATIC mp_obj_t py_usb_serial_make_new(const mp_obj_type_t* type, size_t n_args, size_t n_kw, const mp_obj_t* args)
{
    /* clang-format off */
    enum {ARG_path, ARG_timeout_ms, };
    static const mp_arg_t allowed_args[] = {
        { MP_QSTR_path, MP_ARG_OBJ | MP_ARG_REQUIRED, { .u_obj = mp_const_none  } },
        { MP_QSTR_timeout_ms, MP_ARG_INT, { .u_int = 300 } },
    };
    /* clang-format on */
    mp_map_t     kw_args;
    mp_arg_val_t parsed_args[MP_ARRAY_SIZE(allowed_args)];

    mp_arg_check_num(n_args, n_kw, 1, 2, true);
```

```87:97:/home/nopiskl/K230/canmv_k230/src/canmv/port/modules/modusb.serial.c
    py_usb_seria_t serial;
    const char*    dev_path = "/dev/ttyUSB1";

    serial.fd         = -1;
    serial.timeout_ms = parsed_args[ARG_timeout_ms].u_int;

    if (mp_const_none != parsed_args[ARG_path].u_obj) {
        dev_path = mp_obj_str_get_str(parsed_args[ARG_path].u_obj);
    }
```

因此要区分：

- `/dev/ttyUSB`：IDE/REPL 主控制通道，被 `ide_dbg.c` 使用。
- `/dev/ttyUSB1`：Python 用户脚本里的 `usb.Serial`，更像额外串口数据通道。

---

## 14. 架构分层总结

### 第一层：物理/驱动层

```text
PC CanMV IDE
  <---- USB CDC / virtual serial ---->
RTOS /dev/ttyUSB
```

源码证据：`ide_dbg_init()` 打开 `/dev/ttyUSB`。

### 第二层：后台通信线程

```text
ide_dbg_task()
  - select() 监听 usb_cdc_fd
  - 未 attach：普通 REPL 或识别 IDE token
  - 已 attach：调用 ide_dbg_update() 解析协议帧
```

这层负责“模式切换”和“协议分发”。

### 第三层：协议层

```text
0x30 + cmd + data_length + payload
```

核心命令：

```text
QUERY_STATUS
FW_VERSION
ARCH_STR
SCRIPT_EXEC
SCRIPT_STOP
SCRIPT_RUNNING
TX_BUF_LEN
TX_BUF
FRAME_SIZE
FRAME_DUMP
CREATEFILE
WRITEFILE
VERIFYFILE
SYS_RESET
FB_ENABLE
```

### 第四层：MicroPython VM 桥接层

```text
输入：
  IDE/REPL bytes -> stdin_ring_buffer -> mp_hal_stdin_rx_chr()

输出：
  MicroPython print -> mp_hal_stdout_tx_strn()
    - 普通模式：usb_tx()
    - IDE 模式：mpy_stdout_tx() -> tx_buf -> IDE 主动拉取
```

### 第五层：图像/显示回传层

```text
OpenMV image:
  fb_encode_for_ide() -> ide_set_fb()

MPP/Display:
  Display.init(to_ide=True)
  -> ide_dbg_set_vo_wbc()
  -> VO writeback
  -> JPEG 编码
  -> FRAME_SIZE / FRAME_DUMP
```

### 第六层：文件系统层

```text
IDE 保存文件
  -> CREATEFILE
  -> WRITEFILE chunks
  -> VERIFYFILE sha256
  -> /sdcard/...
```

---

## 15. 一个完整的“IDE 运行脚本并显示图像”的流程

```text
1. IDE 打开串口/USB CDC
2. IDE 发送探测帧：
   0x30 0x8D 0x04 0x00 0x00 0x00
3. RTOS ide_dbg_task() 识别 token
4. ide_attached = true
5. IDE 发送 USBDBG_FW_VERSION / ARCH_STR 获取设备信息
6. 用户点击运行
7. IDE 发送 USBDBG_SCRIPT_EXEC + Python 脚本文本
8. RTOS 保存到 script_string，sem_post(script_sem)
9. MicroPython 主线程从 ide_dbg_get_script() 取脚本
10. do_str(script) 执行
11. print 输出进入 tx_buf
12. IDE 周期性：
    - USBDBG_TX_BUF_LEN
    - USBDBG_TX_BUF
13. 如果脚本调用图像显示：
    - OpenMV image 路径：fb_encode_for_ide()
    - Display 路径：Display.init(to_ide=True)
14. IDE 周期性：
    - USBDBG_FRAME_SIZE
    - USBDBG_FRAME_DUMP
15. IDE 显示控制台输出和图像帧
16. 用户点击停止：
    - USBDBG_SCRIPT_STOP
    - RTOS 注入 ide_exception
    - 脚本退出，MicroPython soft reboot
```

---

## 16. 关键源码清单

建议你后续重点看这些文件：

| 文件 | 作用 |
|---|---|
| `src/canmv/port/omv/ide_dbg.h` | IDE 协议命令、状态机结构定义 |
| `src/canmv/port/omv/ide_dbg.c` | IDE 通信主实现，打开 `/dev/ttyUSB`，协议解析，脚本、输出、图像、文件命令分发 |
| `src/canmv/port/core/mphalport.c` | MicroPython stdin/stdout 和 IDE/REPL 的桥接 |
| `src/canmv/port/core/main.c` | MicroPython 主循环，IDE attach 后执行 IDE 下发脚本 |
| `src/canmv/port/omv/imlib/framebuffer.c` | OpenMV 图像回传到 IDE 的入口 |
| `src/canmv/port/builtin_py/media/display.py` | `Display.init(to_ide=True)` 触发 VO writeback 到 IDE |
| `src/canmv/port/modules/modusb.c` | Python 层 `usb` 模块注册 |
| `src/canmv/port/modules/modusb.serial.c` | Python 层额外 USB serial 通道，默认 `/dev/ttyUSB1` |

---

最终一句话总结：**CanMV IDE 与 RTOS 的通信不是普通裸 REPL，而是在 `/dev/ttyUSB` 上跑一套 OpenMV/CanMV USBDBG 协议；RTOS 端由 `ide_dbg_task()` 后台线程解析协议帧，再桥接到 MicroPython VM、文件系统、图像 framebuffer 和 MPP/VO writeback，从而实现 IDE 的运行脚本、停止脚本、控制台输出、图像预览和文件传输。**

