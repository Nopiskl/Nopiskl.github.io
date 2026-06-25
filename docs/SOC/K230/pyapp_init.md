
---

**User**

请你继续分析一下，IDE端的MicroPython点击运行时，具体发生了什么，程序能在板端运行并输出结果？

---

**Cursor**

我继续沿着“IDE 点击运行”这条路径，把 PC 端发来的脚本如何进入板端、如何执行、输出如何回到 IDE 串起来。

下面只聚焦 **“IDE 端点击 MicroPython 运行”** 这一条路径，不再展开图像回传和文件上传。

## 总体链路

IDE 点击运行后，大致发生：

```text
CanMV IDE
  |
  | 1. 通过 USB/串口向板端发 IDE 协议帧
  v
RTOS /dev/ttyUSB
  |
  | 2. ide_dbg_task() 后台线程读到数据
  v
ide_dbg_update()
  |
  | 3. 识别 USBDBG_SCRIPT_EXEC 命令
  | 4. 读取 IDE 发来的 Python 脚本文本
  | 5. 保存到 script_string
  | 6. sem_post(&script_sem) 通知 MicroPython 主线程
  v
MicroPython main loop
  |
  | 7. ide_dbg_get_script() 取出脚本文本
  | 8. do_str(script) 编译并执行
  v
MicroPython VM
  |
  | 9. print() / 异常 / stdout 进入 mpy_stdout_tx()
  v
tx_buf 环形缓冲区
  |
  | 10. IDE 周期性发 USBDBG_TX_BUF_LEN / USBDBG_TX_BUF
  v
CanMV IDE 控制台显示输出
```

---

## 1. 点击运行前：IDE 已经让板端进入 IDE 模式

板端后台线程 `ide_dbg_task()` 一直监听 `/dev/ttyUSB`。如果还没进入 IDE 模式，它会识别 IDE 探测 token：

```1196:1235:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
        int size = read(usb_cdc_fd, usb_cdc_read_buf, sizeof(usb_cdc_read_buf));
        if (size == 0) {
            pr_verb("[usb] read timeout");
            continue;
        } else if (size < 0) {
            // TODO: error, but ???
            pr_err("[usb] read ttyUSB");
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
```

关键点：

- IDE 先发特殊帧，例如 `\x30\x8D\x04\x00\x00\x00`。
- 板端识别后：
  - `ide_attached = true`
  - 如果原来在 REPL 中，调用 `interrupt_repl()` 打断 REPL
  - 后续收到的数据就不再当普通 REPL 字符处理，而是交给 `ide_dbg_update()` 解析 IDE 协议。

---

## 2. IDE 点击运行：发送 `USBDBG_SCRIPT_EXEC`

点击运行时，IDE 会把编辑器里的 Python 脚本作为 payload 发给板端。板端在 `ide_dbg_update()` 中处理 `USBDBG_SCRIPT_EXEC`：

```728:744:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
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

这里做了几件非常关键的事：

1. 如果已有脚本正在运行：

```c
if (ide_script_running != 0)
    mp_thread_set_exception_main(MP_OBJ_FROM_PTR(&ide_exception));
```

会向 MicroPython 主线程注入一个 `IDE interrupt` 异常，尝试打断旧脚本。

2. 分配脚本缓冲：

```c
script_string = malloc(state->data_length + 1);
```

3. 从 `/dev/ttyUSB` 继续读取完整 Python 源码：

```c
read_until(usb_cdc_fd, script_string, state->data_length);
```

4. 补字符串结尾：

```c
script_string[state->data_length] = '\0';
```

5. 标记脚本正在运行：

```c
ide_script_running = 1;
```

6. 通过信号量唤醒 MicroPython 主线程：

```c
sem_post(&script_sem);
```

所以，IDE 点击运行后，**脚本源码并不是先保存成文件再执行**，而是直接通过 IDE 协议下发到内存里的 `script_string`，然后由 MicroPython 主线程执行。

---

## 3. MicroPython 主线程等待并取出 IDE 下发的脚本

在 `main.c` 中，如果已经处于 IDE attach 状态，就进入 IDE 脚本执行分支：

```834:858:/home/nopiskl/K230/canmv_k230/src/canmv/port/core/main.c
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
            mp_obj_print_exception(&mp_plat_print, (mp_obj_t)nlr.ret_val);
        }
        ide_dbg_on_script_end();
```

关键是：

```c
char* script = ide_dbg_get_script();
```

`ide_dbg_get_script()` 内部会等信号量：

```250:253:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
char* ide_dbg_get_script() {
    sem_wait(&script_sem);
    return ide_attached ? script_string : NULL;
}
```

也就是说：

```text
ide_dbg_task() 收到脚本
  -> script_string = IDE 发来的源码
  -> sem_post(&script_sem)

main.c
  -> ide_dbg_get_script()
  -> sem_wait(&script_sem) 被唤醒
  -> 返回 script_string
```

---

## 4. 脚本如何真正执行：`do_str(script)`

取到脚本文本后，`main.c` 调用：

```c
do_str(script);
```

`do_str()` 的实现是：

```328:332:/home/nopiskl/K230/canmv_k230/src/canmv/port/core/main.c
STATIC int do_str(const char *str) {
    repl_script_running = true;
    int ret = execute_from_lexer(LEX_SRC_STR, str, MP_PARSE_FILE_INPUT, false);
    repl_script_running = false;
    return ret;
}
```

也就是把 IDE 发来的源码字符串交给 `execute_from_lexer()`。

`execute_from_lexer()` 的关键流程是：

```136:178:/home/nopiskl/K230/canmv_k230/src/canmv/port/core/main.c
STATIC int execute_from_lexer(int source_kind, const void *source, mp_parse_input_kind_t input_kind, bool is_repl) {
    mp_hal_set_interrupt_char(CHAR_CTRL_C);

    nlr_buf_t nlr;
    if (nlr_push(&nlr) == 0) {
        // create lexer based on source kind
        mp_lexer_t *lex;
        if (source_kind == LEX_SRC_STR) {
            const char *line = source;
            lex = mp_lexer_new_from_str_len(MP_QSTR__lt_stdin_gt_, line, strlen(line), false);
        } else if (source_kind == LEX_SRC_VSTR) {
            const vstr_t *vstr = source;
            lex = mp_lexer_new_from_str_len(MP_QSTR__lt_stdin_gt_, vstr->buf, vstr->len, false);
        } else if (source_kind == LEX_SRC_FILENAME) {
            lex = mp_lexer_new_from_file((const char *)source);
        } else { // LEX_SRC_STDIN
            lex = mp_lexer_new_from_fd(MP_QSTR__lt_stdin_gt_, 0, false);
        }

        qstr source_name = lex->source_name;

        #if MICROPY_PY___FILE__
        if (input_kind == MP_PARSE_FILE_INPUT) {
            mp_store_global(MP_QSTR___file__, MP_OBJ_NEW_QSTR(source_name));
        }
        #endif

        mp_parse_tree_t parse_tree = mp_parse(lex, input_kind);

        #if defined(MICROPY_UNIX_COVERAGE)
```

继续往下：

```179:201:/home/nopiskl/K230/canmv_k230/src/canmv/port/core/main.c
        mp_obj_t module_fun = mp_compile(&parse_tree, source_name, is_repl);

        if (!compile_only) {
            // execute it
            mp_call_function_0(module_fun);
        }

        mp_hal_set_interrupt_char(-1);
        mp_handle_pending(true);
        nlr_pop();
        return 0;

    } else {
        // uncaught exception
        mp_hal_set_interrupt_char(-1);
        mp_handle_pending(false);
        return handle_uncaught_exception(nlr.ret_val);
    }
}
```

所以脚本运行的实际 MicroPython VM 路径是：

```text
script_string
  -> mp_lexer_new_from_str_len()
  -> mp_parse()
  -> mp_compile()
  -> mp_call_function_0()
```

这就是程序为什么能在板端执行：**IDE 下发的是源码字符串，板端 MicroPython VM 在本地解析、编译、调用执行。**

---

## 5. print 输出如何回到 IDE？

当脚本里执行：

```python
print("hello")
```

或者异常打印时，最后会走 MicroPython port 的 stdout：

```146:163:/home/nopiskl/K230/canmv_k230/src/canmv/port/core/mphalport.c
void mp_hal_stdout_tx_strn(const char *str, size_t len) {
    extern bool ide_dbg_attach(void);
    extern bool command_line_mode;
    if (command_line_mode) {
        fwrite(str, 1, len, stdout);
        return;
    }
    if (ide_dbg_attach()) {
        extern void mpy_stdout_tx(const char* data, size_t size);
        mpy_stdout_tx(str, len);
    } else {
        extern int usb_tx(const void* buffer, size_t size);
        extern int usb_cdc_get_dtr(void);

        if (usb_cdc_get_dtr()) {
            usb_tx(str, len);
        }
```

重点是：

```c
if (ide_dbg_attach()) {
    mpy_stdout_tx(str, len);
}
```

也就是说，IDE 模式下，输出不是直接 `write(/dev/ttyUSB)`，而是先进入 `mpy_stdout_tx()`。

`mpy_stdout_tx()` 会把数据写入 `tx_buf` 环形缓冲区：

```174:185:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
void mpy_stdout_tx(const char* data, size_t size) {
    // ringbuffer
    pthread_mutex_lock(&tx_buf_mutex);
    if (size > TX_BUF_WRITABLE) {
        pthread_mutex_unlock(&tx_buf_mutex);
        while (size > TX_BUF_WRITABLE) {
            usleep(1000);
        }
        pthread_mutex_lock(&tx_buf_mutex);
    }
    RINGBUFFER_WRITE(tx_buf, TX_BUF_SIZE, tx_buf_w_ptr, data, size);
```

IDE 再主动轮询输出长度：

```851:864:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
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
```

如果有数据，IDE 再发 `USBDBG_TX_BUF` 拉取：

```865:887:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
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
                            usb_tx(tx_buf + tx_buf_r_ptr, TX_BUF_SIZE - tx_buf_r_ptr);
                            usb_tx(tx_buf, len - (TX_BUF_SIZE - tx_buf_r_ptr));
                            tx_buf_r_ptr = len - (TX_BUF_SIZE - tx_buf_r_ptr);
```

所以输出回传不是“脚本 print 立即写回 IDE”，而是：

```text
print()
  -> mp_hal_stdout_tx_strn()
  -> mpy_stdout_tx()
  -> tx_buf
  -> IDE 周期性 USBDBG_TX_BUF_LEN 查询长度
  -> IDE 发 USBDBG_TX_BUF 拉数据
  -> 板端 usb_tx() 返回数据
  -> IDE 控制台显示
```

---

## 6. 脚本结束后发生什么？

`do_str(script)` 返回后，`main.c` 会调用：

```c
ide_dbg_on_script_end();
```

然后进入 `main_thread_exit`，执行 MicroPython 清理和 soft reboot：

```858:866:/home/nopiskl/K230/canmv_k230/src/canmv/port/core/main.c
            nlr_pop();
        } else {
            mp_obj_print_exception(&mp_plat_print, (mp_obj_t)nlr.ret_val);
        }
        ide_dbg_on_script_end();
    } else {
        fprintf(stdout, "[mpy] enter repl\n");
```

`ide_dbg_on_script_end()` 的作用包括：

```263:282:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
void ide_dbg_on_script_end(void) {
    if (script_string) {
        free(script_string);
        script_string = NULL;
    }
    // wait print done
    int count = 0;
    while (tx_buf_w_ptr != tx_buf_r_ptr && count < 100) {
        usleep(1000);
        count++;
    }
    ide_script_running = 0;
    if (ide_disconnect) {
        ide_disconnect = false;
        ide_attached = false;
    }
    fb_from = FB_FROM_NONE;

    repl_script_running = false;
}
```

关键点：

- 释放 IDE 下发的脚本字符串。
- 等待输出缓冲尽量发完。
- `ide_script_running = 0`，IDE 再查询 `USBDBG_SCRIPT_RUNNING` 时会知道脚本结束。
- 清理图像来源状态。
- 然后 `main.c` 会 soft reset MicroPython VM，准备下一轮运行。

`main_thread_exit` 中有：

```875:881:/home/nopiskl/K230/canmv_k230/src/canmv/port/core/main.c
    // exit other thread
    mp_thread_set_exception_other(mp_obj_new_exception(&mp_type_SystemExit));
    MP_THREAD_GIL_EXIT();

    #if MICROPY_PY_SYS_SETTRACE
    MP_STATE_THREAD(prof_trace_callback) = MP_OBJ_NULL;
```

以及：

```886:887:/home/nopiskl/K230/canmv_k230/src/canmv/port/core/main.c
    mp_hal_stdout_tx_str("MPY: soft reboot\r\n");
```

最后如果不是进程退出，会：

```947:948:/home/nopiskl/K230/canmv_k230/src/canmv/port/core/main.c
    goto soft_reset;
    return ret & 0xff;
```

也就是 **每次 IDE 运行脚本后，MicroPython VM 会走一轮 soft reboot，释放资源，再回到可继续运行下一段脚本的状态**。

---

## 7. 点击停止时发生什么？

如果 IDE 点击停止，会发送 `USBDBG_SCRIPT_STOP`：

```745:754:/home/nopiskl/K230/canmv_k230/src/canmv/port/omv/ide_dbg.c
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

这不是直接杀进程，而是向 MicroPython 主线程注入异常：

```c
mp_thread_set_exception_main(MP_OBJ_FROM_PTR(&ide_exception));
```

这个异常对象在 `ide_dbg_init()` 中构造，内容是 `"IDE interrupt"`。脚本收到异常后退出，然后同样进入 `ide_dbg_on_script_end()` 和 soft reboot 清理流程。

---

## 8. 最精简时序图

```text
IDE 点击运行
    |
    | USBDBG_SCRIPT_EXEC + data_length + Python源码
    v
ide_dbg_task()
    |
    v
ide_dbg_update()
    |
    | malloc(data_length + 1)
    | read_until(usb_cdc_fd, script_string, data_length)
    | script_string[data_length] = '\0'
    | ide_script_running = 1
    | sem_post(&script_sem)
    v
MicroPython main.c
    |
    | ide_dbg_get_script()
    |   sem_wait(&script_sem)
    |   return script_string
    |
    | do_str(script)
    v
execute_from_lexer()
    |
    | mp_lexer_new_from_str_len()
    | mp_parse()
    | mp_compile()
    | mp_call_function_0()
    v
Python 代码在板端执行
    |
    | print()/异常输出
    v
mp_hal_stdout_tx_strn()
    |
    | ide_dbg_attach() == true
    v
mpy_stdout_tx()
    |
    | 写入 tx_buf
    v
IDE 轮询
    |
    | USBDBG_TX_BUF_LEN
    | USBDBG_TX_BUF
    v
IDE 控制台显示结果
```

---

## 9. 一句话总结

IDE 点击 MicroPython 运行时，**PC 端 IDE 通过 `/dev/ttyUSB` 对应的 USB/串口通道发送 `USBDBG_SCRIPT_EXEC` 协议帧，把 Python 源码下发到板端；板端 `ide_dbg_task()` 收到后保存为 `script_string` 并唤醒 MicroPython 主线程；主线程用 `do_str()` 将源码字符串交给 MicroPython VM 解析、编译、执行；脚本的 `print()` 输出进入 IDE 专用 `tx_buf`，再由 IDE 通过 `USBDBG_TX_BUF_LEN` / `USBDBG_TX_BUF` 主动拉取并显示在控制台。**

