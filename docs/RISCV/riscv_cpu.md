# CPU execution analysis with tb and test files
_Exported on 2026/3/31 at GMT+8 16:40:03 from Cursor (2.6.21)_

---

**User**

@ADD @tb_rvseed.v 帮我结合tb和测试指令文件，一步一步帮我分析一下CPU如何执行的

---

**Cursor**

Let me read both files to understand the testbench and the instruction dump file.

让我再读一下其他相关的核心模块文件，以便给出完整的分析。

现在我已经掌握了所有关键文件，可以做完整的分析了。下面是逐步详解：

---

## RVSeed CPU 执行流程分析

### 第一步：仿真环境启动（tb_rvseed.v）

仿真开始时，`initial` 块按以下顺序执行：

```
时间轴：
t=10ns:  clk=0, rst_n=0
         $readmemh("ADD", inst_mem_f)  ← 将 ADD 测试文件加载进指令存储器
t=30ns:  rst_n=1  ← CPU 从复位中释放，开始运行
```

`inst_load` 任务把 `rv32ui-p-add` 测试文件的二进制机器码（hex格式）逐字装入 `inst_mem_f` 数组。指令从地址 `0x000` 开始存放。

---

### 第二步：复位阶段 — pc_reg.v

复位期间（`rst_n=0`）：

```
curr_pc ← 0x00000000
ena     ← 0
```

复位释放后第一个时钟上升沿（`rst_n=1`）：

```
curr_pc ← next_pc（由mux_pc决定，初始为0x00000004）
ena     ← 1
```

---

### 第三步：第一条指令取指 — PC=0x000

指令存储器根据 `curr_pc` 取出：

```
地址 0x000: 机器码 0x00000d13
反汇编:     li s10, 0   (伪指令，实际是 addi s10, x0, 0)
```

---

### 第四步：控制器译码 — ctrl.v

对指令 `0x00000d13` 进行字段拆分：

| 字段 | 值 | 含义 |
|------|-----|------|
| opcode | `0010011` | `INST_TYPE_I`（I型立即数运算）|
| funct3 | `000` | `INST_ADDI` |
| rd     | `11010`(26) | x26 = s10 |
| rs1    | `00000`(0) | x0 |
| imm    | `000000000000` | 0 |

控制器输出信号：

```
reg_wen     = 1   ← 允许写寄存器
reg1_raddr  = 0   ← 读 x0（恒为0）
reg_waddr   = 26  ← 写 x26 (s10)
alu_op      = ALU_ADD (0011)
alu_src_sel = ALU_SRC_IMM (01) ← ALU 第二操作数用立即数
imm_gen_op  = IMM_GEN_I
branch      = 0
jump        = 0
```

---

### 第五步：立即数生成 — imm_gen.v

I型立即数符号扩展：

```
inst[31:20] = 000000000000
符号扩展 → imm = 0x00000000
```

---

### 第六步：ALU 计算

```
alu_src_sel = ALU_SRC_IMM：
  src1 = reg1_rdata = reg_f[0] = 0  (x0 硬连接为0)
  src2 = imm = 0
alu_op = ALU_ADD：
  result = 0 + 0 = 0
```

---

### 第七步：写回寄存器

```
reg_wen   = 1
reg_waddr = 26 (s10)
reg_wdata = 0
→ reg_f[26] = 0x00000000
```

---

### 第八步：PC 更新

无分支无跳转：

```
next_pc = curr_pc + 4 = 0x004
```

---

### 第九步：PC=0x004，执行第二条指令

```
地址 0x004: 0x00000d93
反汇编:     li s11, 0   (addi s11, x0, 0)
```

同样流程：`reg_f[27] = 0`（s11 = 0，这是"测试失败标志"的初始化）

---

### 第十步：进入 test_2（PC=0x008）— 核心 ADD 测试

```
0x008: li ra, 0       → reg_f[1]  = 0
0x00C: li sp, 0       → reg_f[2]  = 0
0x010: add t5, ra, sp → 操作如下：
```

指令 `0x00208f33` 译码：

| 字段 | 值 | 含义 |
|------|-----|------|
| opcode | `0110011` | `INST_TYPE_R`（R型）|
| funct3 | `000` | `INST_ADD_SUB` |
| funct7 | `0000000` | `FUNCT7_INST_A` → ADD |
| rd     | `11110`(30) | x30 = t5 |
| rs1    | `00001`(1)  | x1 = ra |
| rs2    | `00010`(2)  | x2 = sp |

控制信号：
```
reg_wen     = 1
alu_src_sel = ALU_SRC_REG  ← 两个操作数都来自寄存器
alu_op      = ALU_ADD
src1        = reg_f[1] = 0
src2        = reg_f[2] = 0
result      = 0 + 0 = 0
→ reg_f[30] = 0   (t5 = 0)
```

```
0x014: li t4, 0       → reg_f[29] = 0   (期望值)
0x018: li gp, 2       → reg_f[3]  = 2   (测试编号)
0x01C: bne t5, t4, fail
```

`bne` 指令译码（`INST_TYPE_B`）：
```
branch = 1, alu_op = ALU_SUB
t5(0) - t4(0) = 0  → 结果为0 → 不跳转 (相等则继续)
next_pc = 0x020  ← 进入 test_3
```

---

### 第十一步：pass 路径（PC=0x4F4）

所有 38 个测试（test_2 ~ test_38）全部通过后，执行：

```
0x4E4: bne zero, gp, 0x4F4   → 跳转到 pass

0x4F4: li s10, 1   → reg_f[26] = 1
0x4F8: li s11, 1   → reg_f[27] = 1
0x4FC: j 0x4FC     → 无限循环（等待tb检测）
```

---

### 第十二步：Testbench 检测结果

```verilog
wait(s10_x26 == 1);   // 检测到 x26 = 1，CPU 已完成
// 延迟一个周期后检查 x27
if (s11_x27 == 1)
    $display("~~~ ADD PASS ~~~");
else
    $display("~~~ ADD FAIL ~~~");  // 打印失败的测试编号 gp_x3
```

---

### 整体数据流总结

```
┌─────────────┐    curr_pc    ┌──────────┐    inst     ┌──────┐
│   pc_reg    │──────────────▶│ inst_mem │────────────▶│ ctrl │
│ (PC寄存器)  │◀──────────────│ (指令存储)│             │(译码)│
└─────────────┘   next_pc     └──────────┘             └──┬───┘
       ▲                                                   │
       │ mux_pc                                 控制信号   │
       │ (branch/jump判断)                                  ▼
       │                                        ┌──────────────┐
       │                                        │  reg_file    │
       │                                        │  (寄存器堆)  │
       │                                        └──────┬───────┘
       │                                               │ src1/src2
       │                                               ▼
       │                                        ┌──────────┐
       │                                        │   ALU    │
       │                                        │ (运算单元)│
       │                                        └──────┬───┘
       │              branch/jump信号                  │ result
       └──────────────────────────────────────────────┘
                                                写回 reg_file
```

**关键结论：** 这是一个单周期 RV32I CPU，每条指令在一个时钟周期内完成取指→译码→执行→写回全流程。测试程序通过 `s10(x26)=1` 作为"完成信号"，`s11(x27)=1` 作为"通过信号"，`gp(x3)` 记录当前正在执行的测试编号，失败时可精确定位到哪个测试用例出错。

