不冲突，但两份文档说的是两个层面。



KW33000_VIN_MULTI_VC_ANALYSIS.md 这部分判断是对的：isp10/isp@4 在 sun8iw21p1.dtsi:1441-1445 里没有 reg、interrupts、work_mode，所以 sunxi_isp.c:3076-3080 里 of_iomap(np, 0) 失败后会把它标成 is_empty=1。而且 sunxi_isp_sensor_type() 在 sunxi_isp.c:3211-3217 里确实会把 empty ISP 强制改成 use_isp=0。也就是说，这个节点不会去跑正常 ISP 算法。



但 ISP type.md / bypass&manually disabled.md 说的“vinc0_isp_sel = 4 选择 bypass ISP 节点”也成立，因为这说的是路由和媒体图绑定，不是说 isp@4 是一个有真实寄存器资源的 ISP 核。源码里有两层动作：



路由层
vin.c:1685-1688、1828-1831 直接按 vinc->isp_sel 选 vind->isp[vinc->isp_sel].sd，所以 isp_sel=4 时，媒体图绑定的就是 id=4 这个 ISP subdev。
同时 vin.c:1025-1039 会把 isp_sel=4 折算成：
isp = 4 / 4 = 1
input = 4 % 4 = 0
也就是 top mux 走 logic isp1 / input0 这条路径，再由 csic_vipp_input_select() 选它的输出。



ISP处理层
isp@4 probe 时虽然没有硬件资源，但 sunxi_isp.c:3129 后仍然会走 __isp_init_subdev()，然后 vin.c:1501-1508 还会把所有 ISP subdev 注册进 v4l2。
所以它是“存在于媒体图里的一个 ISP 子设备占位节点/逻辑路径代表节点”。
只是因为它 is_empty=1，所以 sunxi_isp_sensor_type() 把它变成 use_isp=0，后面像 sunxi_isp_subdev_s_stream()、sunxi_isp_subdev_init() 这类函数一进来就直接 return，不做 ISP 算法处理。



所以更准确的说法是：

vinc0_isp_sel = 4：选中了 id=4 这条 bypass/raw path 的代表节点，路由切到了这条路径。
isp@4 is_empty -> use_isp=0：说明这条路径上的 ISP 子设备本体是个 no-op，占位但不处理。
两篇文档真正的区别，只在表述精度：

如果把“数据接入该节点”理解成“进入一个真实的 ISP4 硬件核”，那是不严谨的。
如果理解成“媒体图和 top mux 绑定到这个 bypass 代表节点/逻辑路径”，那就和 is_empty/use_isp=0 完全一致。
顺手把 bypass 和 manually disabled 再压一句：

vinc0_isp_sel=4 是“换路”，选 bypass 节点。
sensor0_isp_used=0 是“同一路上禁用 ISP 行为”。
前者通常也会因为选中的节点是 empty，最终表现成 use_isp=0；但它和“手动禁用普通 ISP 节点”不是一回事。