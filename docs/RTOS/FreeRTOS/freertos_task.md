# 调度器与高优先级任务的状态转换
_Exported on 2026/3/31 at GMT+8 13:41:36 from Cursor (2.6.21)_

---

**User**

以串口中断为例，解释一下如果有一个高优先级任务阻塞在一个串口接收队列中，当收到串口数据后，调度器如何让高优先级任务由blocker->ready，并抢占当前低优先级任务运行

---

**Cursor**

我来读取 FreeRTOS 的相关源码，重点看任务调度、队列和中断相关的实现。我现在直接读取 FreeRTOS 源码中的关键文件来分析调度流程。

---

## 全流程图解

```
UART硬件收到数据
       │
       ▼
① UART_IRQHandler()  ← 中断服务程序入口（用户编写）
       │  向队列发送数据
       ▼
② xQueueSendFromISR() / xQueueGenericSendFromISR()  ← queue.c
       │  队列有空间，复制数据到队列缓冲区
       │  发现有任务阻塞在这个队列的等待接收列表中
       ▼
③ xTaskRemoveFromEventList()  ← tasks.c
       │  把高优先级任务从 EventList（队列等待列表）移除
       │  把高优先级任务从 DelayedTaskList 移除（如果有超时）
       │  把高优先级任务加入 ReadyList[高优先级]
       │  返回 pdTRUE（表示有更高优先级任务就绪了）
       ▼
④ xQueueGenericSendFromISR() 得知 xYieldRequired=pdTRUE
       │  设置 *pxHigherPriorityTaskWoken = pdTRUE
       ▼
⑤ 用户 ISR 返回前调用 portYIELD_FROM_ISR(pdTRUE)
       │  触发 PendSV 异常（写 ICSR 寄存器挂起 PendSV）
       ▼
⑥ 所有更高优先级中断退出后，PendSV_Handler 执行  ← port.c
       │  保存当前任务（低优先级）的上下文到其 TCB 栈
       │  调用 vTaskSwitchContext() 更新 pxCurrentTCB
       │  恢复高优先级任务的上下文
       ▼
⑦ 高优先级任务从 xQueueReceive() 挂起点继续执行
       状态：Blocked → Ready → Running ✓
```

---

## 每一步详细说明（对应源码）

### ① 用户编写的 UART ISR

```c
void USART1_IRQHandler(void)
{
    uint8_t data = USART1->DR;  // 读取串口数据寄存器
    BaseType_t xHigherPriorityTaskWoken = pdFALSE;

    // 向队列发送，ISR 版本（不能阻塞）
    xQueueSendFromISR(xUartRxQueue, &data, &xHigherPriorityTaskWoken);

    // 如果有更高优先级任务被唤醒，触发调度
    portYIELD_FROM_ISR(xHigherPriorityTaskWoken);
}
```

`xHigherPriorityTaskWoken` 是关键桥梁：FreeRTOS 通过它把"是否需要切换任务"这个信息从内核传回用户 ISR。

---

### ② `xQueueGenericSendFromISR()` — queue.c

这是 `xQueueSendFromISR` 的底层实现。关键逻辑（对应你的 queue.c）：

```c
BaseType_t xQueueGenericSendFromISR(QueueHandle_t xQueue,
                                    const void * const pvItemToQueue,
                                    BaseType_t * const pxHigherPriorityTaskWoken,
                                    const BaseType_t xCopyPosition)
{
    // ...
    // 把数据复制进队列缓冲区
    prvCopyDataToQueue(pxQueue, pvItemToQueue, xCopyPosition);

    // 检查：是否有任务阻塞在这个队列的接收等待列表？
    if (listLIST_IS_EMPTY(&(pxQueue->xTasksWaitingToReceive)) == pdFALSE)
    {
        // 有任务在等待接收！把它移到就绪列表
        if (xTaskRemoveFromEventList(&(pxQueue->xTasksWaitingToReceive)) != pdFALSE)
        {
            // 被唤醒的任务优先级 > 当前任务优先级
            if (pxHigherPriorityTaskWoken != NULL)
            {
                *pxHigherPriorityTaskWoken = pdTRUE;  // 通知用户 ISR 需要切换
            }
        }
    }
    // ...
}
```

`xTasksWaitingToReceive` 是队列结构体（`Queue_t`）里的一个列表，专门存放所有阻塞在"等待从这个队列接收数据"的任务。

---

### ③ `xTaskRemoveFromEventList()` — tasks.c

这是状态转换的核心函数，把任务从 **Blocked** 变为 **Ready**：


---

**User**

继续

---

**Cursor**

现在我已经收集到所有关键源码。下面给出完整、精确的解释，每一步都对应你工程里的真实代码。

---

## 串口中断触发高优先级任务抢占的完整流程

你的工程用的是 **ARM Cortex-M3 + GCC port**（`portable/GCC/ARM_CM3/port.c`），FreeRTOS V10.3.1。

---

### 阶段一：高优先级任务主动阻塞自己

高优先级任务（假设优先级=5）调用 `xQueueReceive()`，队列为空，于是任务把自己挂入队列的等待接收列表，然后让出 CPU：

```c
// 高优先级任务代码（用户层面）
uint8_t byte;
xQueueReceive(xUartRxQueue, &byte, portMAX_DELAY); // 永久等待
// 执行到这里时任务已阻塞，CPU 转去跑低优先级任务
```

`xQueueReceive()` 内部（`queue.c`）把该任务的 TCB 的 `xEventListItem` 插入队列的 `xTasksWaitingToReceive` 列表，并把 TCB 的 `xStateListItem` 插入 `pxDelayedTaskList`（超时列表），然后调用调度器切换到低优先级任务。

此后，CPU 一直在运行低优先级任务（优先级=2）。

---

### 阶段二：串口中断触发，ISR 向队列写数据

UART 硬件收到数据，触发中断，执行用户 ISR：

```c
void USART1_IRQHandler(void)
{
    uint8_t data = USART1->DR;
    BaseType_t xHigherPriorityTaskWoken = pdFALSE;

    xQueueSendFromISR(xUartRxQueue, &data, &xHigherPriorityTaskWoken);

    portYIELD_FROM_ISR(xHigherPriorityTaskWoken); // 关键：决定是否触发切换
}
```

---

### 阶段三：`xQueueGenericSendFromISR()` 复制数据并检查等待列表

对应源码 `queue.c:950`：

```950:1080:c:\Users\Admin\Desktop\Tmp files\LED\LED_TEST\Middlewares\Third_Party\FreeRTOS\Source\queue.c
BaseType_t xQueueGenericSendFromISR( QueueHandle_t xQueue, const void * const pvItemToQueue, BaseType_t * const pxHigherPriorityTaskWoken, const BaseType_t xCopyPosition )
{
// ...
    uxSavedInterruptStatus = portSET_INTERRUPT_MASK_FROM_ISR();  // 进入临界区
    {
        if( ( pxQueue->uxMessagesWaiting < pxQueue->uxLength ) || ( xCopyPosition == queueOVERWRITE ) )
        {
            // 1. 把串口数据复制进队列缓冲区
            ( void ) prvCopyDataToQueue( pxQueue, pvItemToQueue, xCopyPosition );

            if( cTxLock == queueUNLOCKED )
            {
                // 2. 检查：是否有任务阻塞在等待接收此队列？
                if( listLIST_IS_EMPTY( &( pxQueue->xTasksWaitingToReceive ) ) == pdFALSE )
                {
                    // 3. 有！把它从阻塞态移到就绪态
                    if( xTaskRemoveFromEventList( &( pxQueue->xTasksWaitingToReceive ) ) != pdFALSE )
                    {
                        // 4. 被唤醒的任务优先级 > 当前任务（低优先级），需要切换
                        if( pxHigherPriorityTaskWoken != NULL )
                        {
                            *pxHigherPriorityTaskWoken = pdTRUE; // 通知用户 ISR
                        }
                    }
                }
            }
        }
    }
    portCLEAR_INTERRUPT_MASK_FROM_ISR( uxSavedInterruptStatus );
}
```

---

### 阶段四：`xTaskRemoveFromEventList()` 完成 Blocked → Ready 状态转换

对应源码 `tasks.c:3138`，这是状态转换的核心：

```3138:3205:c:\Users\Admin\Desktop\Tmp files\LED\LED_TEST\Middlewares\Third_Party\FreeRTOS\Source\tasks.c
BaseType_t xTaskRemoveFromEventList( const List_t * const pxEventList )
{
TCB_t *pxUnblockedTCB;
BaseType_t xReturn;

    // 从队列的 xTasksWaitingToReceive 列表取出优先级最高的任务 TCB
    pxUnblockedTCB = listGET_OWNER_OF_HEAD_ENTRY( pxEventList );
    configASSERT( pxUnblockedTCB );

    // 步骤A：把 TCB 的 xEventListItem 从队列等待列表摘出
    ( void ) uxListRemove( &( pxUnblockedTCB->xEventListItem ) );

    if( uxSchedulerSuspended == ( UBaseType_t ) pdFALSE )
    {
        // 步骤B：把 TCB 的 xStateListItem 从延时列表摘出
        ( void ) uxListRemove( &( pxUnblockedTCB->xStateListItem ) );

        // 步骤C：把任务加入 pxReadyTasksLists[5]（高优先级就绪列表）
        prvAddTaskToReadyList( pxUnblockedTCB );
    }
    else
    {
        // 调度器挂起时，先放入 xPendingReadyList，调度器恢复时再移入就绪列表
        vListInsertEnd( &( xPendingReadyList ), &( pxUnblockedTCB->xEventListItem ) );
    }

    // 步骤D：比较优先级
    if( pxUnblockedTCB->uxPriority > pxCurrentTCB->uxPriority )
    {
        // 高优先级任务(5) > 当前低优先级任务(2)，返回 pdTRUE
        xReturn = pdTRUE;

        // 同时设置 xYieldPending 保险标志（即使用户没传 pxHigherPriorityTaskWoken 也能切换）
        xYieldPending = pdTRUE;
    }
    else
    {
        xReturn = pdFALSE;
    }

    return xReturn;  // 返回 pdTRUE
}
```

执行完这个函数后，高优先级任务的状态已经完成转换：
- `xTasksWaitingToReceive` 列表：**已移除**（不再是 Blocked）
- `pxDelayedTaskList`：**已移除**
- `pxReadyTasksLists[5]`：**已加入**（Ready 状态）

但 CPU 此时仍在 ISR 中，还没有切换。

---

### 阶段五：ISR 返回前触发 PendSV

`portYIELD_FROM_ISR(xHigherPriorityTaskWoken)` 展开为（`portmacro.h`）：

```c
#define portEND_SWITCHING_ISR( xSwitchRequired ) \
    if( xSwitchRequired != pdFALSE ) portYIELD()

// portYIELD() 的实现：
#define portYIELD() \
{ \
    portNVIC_INT_CTRL_REG = portNVIC_PENDSVSET_BIT; \  // 写 ICSR 寄存器，挂起 PendSV
    __dsb( portSY_FULL_READ_WRITE ); \
    __isb( portSY_FULL_READ_WRITE ); \
}
```

`portNVIC_INT_CTRL_REG = portNVIC_PENDSVSET_BIT` 就是向 ARM 的 `SCB->ICSR` 寄存器第28位写1，**挂起 PendSV 异常**。

PendSV 被设置为系统最低优先级（`port.c:326`）：
```c
portNVIC_SYSPRI2_REG |= portNVIC_PENDSV_PRI;  // PendSV = 最低优先级 (0xFF)
```

所以 PendSV **不会立即打断 UART ISR**，而是等 UART ISR 完整退出，所有更高优先级中断都处理完后，才会触发。

---

### 阶段六：PendSV 执行，完成上下文切换

对应源码 `port.c:389`，这是一段裸汇编函数：

```389:425:c:\Users\Admin\Desktop\Tmp files\LED\LED_TEST\Middlewares\Third_Party\FreeRTOS\Source\portable\GCC\ARM_CM3\port.c
void xPortPendSVHandler( void )
{
    __asm volatile
    (
    // === 保存当前任务（低优先级任务）的上下文 ===
    "   mrs r0, psp              \n"  // 读取低优先级任务的进程栈指针
    "   isb                      \n"
    "   ldr r3, pxCurrentTCBConst\n"  // r3 = &pxCurrentTCB（指向低优先级任务TCB的指针的地址）
    "   ldr r2, [r3]             \n"  // r2 = pxCurrentTCB（低优先级任务TCB地址）
    "   stmdb r0!, {r4-r11}      \n"  // 把 r4-r11 压入低优先级任务的PSP栈
    "   str r0, [r2]             \n"  // 把新的栈顶指针保存回 TCB->pxTopOfStack

    // === 调用 vTaskSwitchContext() 更新 pxCurrentTCB ===
    "   stmdb sp!, {r3, r14}     \n"  // 保存 r3 和 LR
    "   mov r0, %0               \n"  // 临时屏蔽低优先级中断
    "   msr basepri, r0          \n"
    "   bl vTaskSwitchContext     \n"  // 关键！更新 pxCurrentTCB → 指向高优先级任务
    "   mov r0, #0               \n"
    "   msr basepri, r0          \n"  // 恢复中断
    "   ldmia sp!, {r3, r14}     \n"

    // === 恢复新任务（高优先级任务）的上下文 ===
    "   ldr r1, [r3]             \n"  // r1 = pxCurrentTCB（现在指向高优先级任务TCB）
    "   ldr r0, [r1]             \n"  // r0 = 高优先级任务的栈顶指针
    "   ldmia r0!, {r4-r11}      \n"  // 从高优先级任务的栈上恢复 r4-r11
    "   msr psp, r0              \n"  // 更新 PSP 指向高优先级任务的栈
    "   isb                      \n"
    "   bx r14                   \n"  // 返回，CPU 进入高优先级任务的线程模式
    // ARM 硬件自动从栈上恢复 r0-r3, r12, LR, PC, xPSR
    );
}
```

`vTaskSwitchContext()` 的核心逻辑（`tasks.c`）就是：
```c
// 找到当前就绪列表中优先级最高的任务，更新 pxCurrentTCB
taskSELECT_HIGHEST_PRIORITY_TASK();
// 展开后等效于:
// pxCurrentTCB = pxReadyTasksLists[uxTopReadyPriority] 的头部任务
```



