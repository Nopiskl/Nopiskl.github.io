
---

## FreeRTOS 任务调度实现分析

基于对 `tasks.c` 和 `port.c`（ARM Cortex-M3 移植层）的完整阅读，以下是 FreeRTOS 任务调度的核心实现原理：

---

### 一、核心数据结构

**任务控制块 TCB（`tskTCB` / `TCB_t`）**

```252:270:c:/Users/Admin/Desktop/Tmp files/LED/LED_TEST/Middlewares/Third_Party/FreeRTOS/Source/tasks.c"
typedef struct tskTaskControlBlock
{
    volatile StackType_t *pxTopOfStack;  // 栈顶指针（必须是第一个成员，上下文切换依赖）
    ListItem_t  xStateListItem;          // 状态链表节点（就绪/阻塞/挂起）
    ListItem_t  xEventListItem;          // 事件链表节点（等待队列/信号量等）
    UBaseType_t uxPriority;              // 任务优先级
    StackType_t *pxStack;                // 栈起始地址
    char        pcTaskName[...];         // 任务名称
} tskTCB;
```

**全局调度相关变量**

```345:360:c:/Users/Admin/Desktop/Tmp files/LED/LED_TEST/Middlewares/Third_Party/FreeRTOS/Source/tasks.c"
TCB_t * volatile pxCurrentTCB = NULL;                          // 当前运行任务
static List_t pxReadyTasksLists[ configMAX_PRIORITIES ];       // 按优先级分组的就绪链表
static List_t xDelayedTaskList1, xDelayedTaskList2;            // 延时任务链表（双缓冲）
static List_t xPendingReadyList;                               // 调度器挂起期间的待就绪任务
static volatile UBaseType_t uxTopReadyPriority;                // 当前最高就绪优先级
static volatile TickType_t  xNextTaskUnblockTime;              // 下一个任务解阻塞时间
```

---

### 二、调度器启动流程

```
vTaskStartScheduler()
    ├── 创建 Idle 任务（优先级 0，最低）
    ├── 创建 Timer 守护任务（若启用）
    ├── portDISABLE_INTERRUPTS()        // 关中断
    ├── xSchedulerRunning = pdTRUE
    └── xPortStartScheduler()           // 进入移植层
            ├── 设置 PendSV 和 SysTick 为最低优先级中断
            ├── vPortSetupTimerInterrupt()   // 配置 SysTick 定时器
            └── prvPortStartFirstTask()      // 触发 SVC 启动第一个任务
```

**启动第一个任务（汇编）**：

```c
// port.c - prvPortStartFirstTask
__asm volatile(
    " ldr r0, =0xE000ED08 \n"  // 读取向量表偏移
    " ldr r0, [r0]        \n"
    " ldr r0, [r0]        \n"
    " msr msp, r0         \n"  // 重置主栈指针
    " cpsie i             \n"  // 开全局中断
    " svc 0               \n"  // 触发SVC异常，进入第一个任务
);
```

---

### 三、任务选择算法（最高优先级调度）

**通用版本（`configUSE_PORT_OPTIMISED_TASK_SELECTION == 0`）**：

```115:130:c:/Users/Admin/Desktop/Tmp files/LED/LED_TEST/Middlewares/Third_Party/FreeRTOS/Source/tasks.c"
#define taskSELECT_HIGHEST_PRIORITY_TASK()                          \
{                                                                    \
    UBaseType_t uxTopPriority = uxTopReadyPriority;                 \
    /* 从高到低遍历就绪链表，找到第一个非空的链表 */                    \
    while( listLIST_IS_EMPTY( &( pxReadyTasksLists[uxTopPriority] ) ) ) \
    {                                                                \
        --uxTopPriority;                                             \
    }                                                                \
    /* 轮转获取该优先级下的下一个任务（时间片轮转） */                  \
    listGET_OWNER_OF_NEXT_ENTRY( pxCurrentTCB, &( pxReadyTasksLists[uxTopPriority] ) ); \
    uxTopReadyPriority = uxTopPriority;                              \
}
```

**优化版本（使用 CLZ 指令，`configUSE_PORT_OPTIMISED_TASK_SELECTION == 1`）**：通过 `portGET_HIGHEST_PRIORITY()` 调用硬件前导零计数指令，O(1) 时间找到最高优先级，无需遍历。

---

### 四、上下文切换流程（核心）

**触发时机：**
- **SysTick 中断** → 每个 tick 调用 `xTaskIncrementTick()` → 返回需要切换 → 挂起 PendSV
- **任务主动让出** → `taskYIELD()` → 直接挂起 PendSV
- **高优先级任务就绪** → 通过 `taskYIELD_IF_USING_PREEMPTION()` 挂起 PendSV

**SysTick → PendSV 链路：**

```c
// port.c - xPortSysTickHandler
void xPortSysTickHandler(void) {
    portDISABLE_INTERRUPTS();
    if( xTaskIncrementTick() != pdFALSE ) {
        // 需要切换，挂起PendSV（延迟执行，避免在SysTick中直接切换）
        portNVIC_INT_CTRL_REG = portNVIC_PENDSVSET_BIT;
    }
    portENABLE_INTERRUPTS();
}
```

**PendSV 处理器（真正的上下文切换，纯汇编）：**

```c
// port.c - xPortPendSVHandler（naked函数，无编译器自动保存）
__asm volatile (
    "mrs r0, psp              \n"  // 读取当前任务的进程栈指针
    "ldr r3, pxCurrentTCBConst\n"  // 获取 pxCurrentTCB 地址
    "ldr r2, [r3]             \n"
    "stmdb r0!, {r4-r11}      \n"  // 保存 r4-r11（r0-r3,r12,LR,PC,xPSR 由硬件自动保存）
    "str r0, [r2]             \n"  // 将新栈顶保存到 TCB->pxTopOfStack
    // --- 调用 C 函数选择下一个任务 ---
    "bl vTaskSwitchContext     \n"  // 更新 pxCurrentTCB 指向下一个任务
    // --- 恢复新任务上下文 ---
    "ldr r1, [r3]             \n"  // 读取新 pxCurrentTCB
    "ldr r0, [r1]             \n"  // 读取新任务栈顶
    "ldmia r0!, {r4-r11}      \n"  // 恢复 r4-r11
    "msr psp, r0              \n"  // 更新 PSP 指向新任务栈
    "bx r14                   \n"  // 异常返回，硬件自动恢复 r0-r3,r12,LR,PC,xPSR
);
```

---

### 五、Tick 中断与任务解阻塞（`xTaskIncrementTick`）

```c
BaseType_t xTaskIncrementTick(void) {
    xTickCount++;                          // Tick 计数加1
    if(xConstTickCount == 0)
        taskSWITCH_DELAYED_LISTS();        // 溢出时交换延时链表双缓冲

    // 检查延时链表，唤醒到期任务
    while( xConstTickCount >= xNextTaskUnblockTime ) {
        pxTCB = listGET_OWNER_OF_HEAD_ENTRY(pxDelayedTaskList);
        uxListRemove(&pxTCB->xStateListItem);
        prvAddTaskToReadyList(pxTCB);      // 移入就绪链表
        if(pxTCB->uxPriority >= pxCurrentTCB->uxPriority)
            xSwitchRequired = pdTRUE;      // 需要抢占
    }

    // 时间片轮转：同优先级多任务时强制切换
    if( listCURRENT_LIST_LENGTH(&pxReadyTasksLists[pxCurrentTCB->uxPriority]) > 1 )
        xSwitchRequired = pdTRUE;

    return xSwitchRequired;                // 返回是否需要切换
}
```

---

### 六、完整调度流程总结图

```
用户创建任务 xTaskCreate()
    └── 初始化TCB + 栈帧 → 加入就绪链表 pxReadyTasksLists[优先级]

vTaskStartScheduler()
    └── 配置SysTick → SVC启动第一任务

┌─────────────────────────────────────────────┐
│              运行时调度循环                   │
│                                             │
│  SysTick(1ms)                               │
│    └── xTaskIncrementTick()                 │
│          ├── 延时任务到期 → 移入就绪链表      │
│          ├── 时间片到期 → xSwitchRequired=1 │
│          └── 挂起 PendSV 中断               │
│                                             │
│  PendSV（最低优先级，所有中断处理完后执行）   │
│    ├── 保存当前任务寄存器到其栈               │
│    ├── vTaskSwitchContext()                 │
│    │     └── taskSELECT_HIGHEST_PRIORITY_TASK()│
│    │           └── 更新 pxCurrentTCB        │
│    └── 恢复新任务寄存器，切换到新任务运行     │
└─────────────────────────────────────────────┘
```

---

### 七、关键设计要点

| 机制 | 说明 |
|------|------|
| **抢占式调度** | `configUSE_PREEMPTION=1` 时，高优先级任务就绪立即抢占 |
| **时间片轮转** | 同优先级任务每个 Tick 轮换，由 `listGET_OWNER_OF_NEXT_ENTRY` 实现 |
| **PendSV 延迟切换** | 上下文切换延迟到所有中断处理完毕后，避免中断嵌套问题 |
| **双缓冲延时链表** | `xDelayedTaskList1/2` 交替使用，优雅处理 Tick 计数溢出 |
| **临界区保护** | `taskENTER_CRITICAL()` 通过 `basepri` 寄存器屏蔽低优先级中断，不影响高优先级 ISR |
| **硬件辅助** | ARM Cortex-M3 硬件自动保存/恢复 r0-r3, r12, LR, PC, xPSR，软件只需处理 r4-r11 |

```plaintext
typedef struct tskTaskControlBlock
{
    volatile StackType_t *pxTopOfStack;  // 栈顶指针（必须是第一个成员，上下文切换依赖）
    ListItem_t  xStateListItem;          // 状态链表节点（就绪/阻塞/挂起）
    ListItem_t  xEventListItem;          // 事件链表节点（等待队列/信号量等）
    UBaseType_t uxPriority;              // 任务优先级
    StackType_t *pxStack;                // 栈起始地址
    char        pcTaskName[...];         // 任务名称
} tskTCB;
```

```plaintext
TCB_t * volatile pxCurrentTCB = NULL;                          // 当前运行任务
static List_t pxReadyTasksLists[ configMAX_PRIORITIES ];       // 按优先级分组的就绪链表
static List_t xDelayedTaskList1, xDelayedTaskList2;            // 延时任务链表（双缓冲）
static List_t xPendingReadyList;                               // 调度器挂起期间的待就绪任务
static volatile UBaseType_t uxTopReadyPriority;                // 当前最高就绪优先级
static volatile TickType_t  xNextTaskUnblockTime;              // 下一个任务解阻塞时间
```

```plaintext
vTaskStartScheduler()
    ├── 创建 Idle 任务（优先级 0，最低）
    ├── 创建 Timer 守护任务（若启用）
    ├── portDISABLE_INTERRUPTS()        // 关中断
    ├── xSchedulerRunning = pdTRUE
    └── xPortStartScheduler()           // 进入移植层
            ├── 设置 PendSV 和 SysTick 为最低优先级中断
            ├── vPortSetupTimerInterrupt()   // 配置 SysTick 定时器
            └── prvPortStartFirstTask()      // 触发 SVC 启动第一个任务
```

```c
// port.c - prvPortStartFirstTask
__asm volatile(
    " ldr r0, =0xE000ED08 \n"  // 读取向量表偏移
    " ldr r0, [r0]        \n"
    " ldr r0, [r0]        \n"
    " msr msp, r0         \n"  // 重置主栈指针
    " cpsie i             \n"  // 开全局中断
    " svc 0               \n"  // 触发SVC异常，进入第一个任务
);
```

```plaintext
#define taskSELECT_HIGHEST_PRIORITY_TASK()                          \
{                                                                    \
    UBaseType_t uxTopPriority = uxTopReadyPriority;                 \
    /* 从高到低遍历就绪链表，找到第一个非空的链表 */                    \
    while( listLIST_IS_EMPTY( &( pxReadyTasksLists[uxTopPriority] ) ) ) \
    {                                                                \
        --uxTopPriority;                                             \
    }                                                                \
    /* 轮转获取该优先级下的下一个任务（时间片轮转） */                  \
    listGET_OWNER_OF_NEXT_ENTRY( pxCurrentTCB, &( pxReadyTasksLists[uxTopPriority] ) ); \
    uxTopReadyPriority = uxTopPriority;                              \
}
```

```c
// port.c - xPortSysTickHandler
void xPortSysTickHandler(void) {
    portDISABLE_INTERRUPTS();
    if( xTaskIncrementTick() != pdFALSE ) {
        // 需要切换，挂起PendSV（延迟执行，避免在SysTick中直接切换）
        portNVIC_INT_CTRL_REG = portNVIC_PENDSVSET_BIT;
    }
    portENABLE_INTERRUPTS();
}
```

```c
// port.c - xPortPendSVHandler（naked函数，无编译器自动保存）
__asm volatile (
    "mrs r0, psp              \n"  // 读取当前任务的进程栈指针
    "ldr r3, pxCurrentTCBConst\n"  // 获取 pxCurrentTCB 地址
    "ldr r2, [r3]             \n"
    "stmdb r0!, {r4-r11}      \n"  // 保存 r4-r11（r0-r3,r12,LR,PC,xPSR 由硬件自动保存）
    "str r0, [r2]             \n"  // 将新栈顶保存到 TCB->pxTopOfStack
    // --- 调用 C 函数选择下一个任务 ---
    "bl vTaskSwitchContext     \n"  // 更新 pxCurrentTCB 指向下一个任务
    // --- 恢复新任务上下文 ---
    "ldr r1, [r3]             \n"  // 读取新 pxCurrentTCB
    "ldr r0, [r1]             \n"  // 读取新任务栈顶
    "ldmia r0!, {r4-r11}      \n"  // 恢复 r4-r11
    "msr psp, r0              \n"  // 更新 PSP 指向新任务栈
    "bx r14                   \n"  // 异常返回，硬件自动恢复 r0-r3,r12,LR,PC,xPSR
);
```

```c
BaseType_t xTaskIncrementTick(void) {
    xTickCount++;                          // Tick 计数加1
    if(xConstTickCount == 0)
        taskSWITCH_DELAYED_LISTS();        // 溢出时交换延时链表双缓冲

    // 检查延时链表，唤醒到期任务
    while( xConstTickCount >= xNextTaskUnblockTime ) {
        pxTCB = listGET_OWNER_OF_HEAD_ENTRY(pxDelayedTaskList);
        uxListRemove(&pxTCB->xStateListItem);
        prvAddTaskToReadyList(pxTCB);      // 移入就绪链表
        if(pxTCB->uxPriority >= pxCurrentTCB->uxPriority)
            xSwitchRequired = pdTRUE;      // 需要抢占
    }

    // 时间片轮转：同优先级多任务时强制切换
    if( listCURRENT_LIST_LENGTH(&pxReadyTasksLists[pxCurrentTCB->uxPriority]) > 1 )
        xSwitchRequired = pdTRUE;

    return xSwitchRequired;                // 返回是否需要切换
}
```

```plaintext
用户创建任务 xTaskCreate()
    └── 初始化TCB + 栈帧 → 加入就绪链表 pxReadyTasksLists[优先级]

vTaskStartScheduler()
    └── 配置SysTick → SVC启动第一任务

┌─────────────────────────────────────────────┐
│              运行时调度循环                   │
│                                             │
│  SysTick(1ms)                               │
│    └── xTaskIncrementTick()                 │
│          ├── 延时任务到期 → 移入就绪链表      │
│          ├── 时间片到期 → xSwitchRequired=1 │
│          └── 挂起 PendSV 中断               │
│                                             │
│  PendSV（最低优先级，所有中断处理完后执行）   │
│    ├── 保存当前任务寄存器到其栈               │
│    ├── vTaskSwitchContext()                 │
│    │     └── taskSELECT_HIGHEST_PRIORITY_TASK()│
│    │           └── 更新 pxCurrentTCB        │
│    └── 恢复新任务寄存器，切换到新任务运行     │
└─────────────────────────────────────────────┘
```

