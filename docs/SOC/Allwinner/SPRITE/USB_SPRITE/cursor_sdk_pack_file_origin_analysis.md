
---

**User**

结合lichee/brandy-2.0/u-boot-2018/sprite等uboot资源，以及网络资源https://github.com/YuzukiTsuru/libefex 等烧录实现，帮我分析一下具体uboot环节是如何与usb交互实现具体image下载的？

---

**Cursor**

先给结论：

> USB 烧录时，真正和 PC 工具交互的是 U-Boot 里的 `drivers/sunxi_usb/usb_efex.c`。  
> `sprite/` 目录主要提供底层烧录动作，例如初始化 Flash、擦除、写 MBR、写 boot0、写 boot_package、校验分区。  
> PC 端工具，例如 PhoenixSuit、LiveSuit、OpenixSuit、`libefex`，负责解析固件 image，然后通过 EFEX/FES USB 命令把 MBR、boot0、boot_package、分区数据一块一块发给 U-Boot。  
> U-Boot 不主动去“读 image 文件”，USB 烧录场景中 image 解析主要在 PC 端完成，U-Boot 只是被动接收命令和数据并写入 Flash。

---

# 1. U-Boot 是怎么进入 USB EFEX 烧录模式的？

你前面已经看过 linux-sunxi 的 FES 流程。Boot 2.0 大致是：

```text
PC 端通过 FEL:
  1. 下载 fes1.fex 到 SRAM
  2. 执行 fes1.fex 初始化 DRAM
  3. 下载 u-boot.fex 到 DRAM
  4. 修改 u-boot 的 work mode 为 USB mode
  5. 跳转执行 u-boot.fex
```

U-Boot 启动后会根据 `work mode` 进入不同模式。对应代码在：

`lichee/brandy-2.0/u-boot-2018/cmd/sunxi_sprite.c`

关键逻辑是：

```17:31:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/cmd/sunxi_sprite.c
int do_sprite_test(cmd_tbl_t *cmdtp, int flag, int argc, char * const argv[])
{
	__maybe_unused int ret;
	printf("sunxi work mode=0x%x\n", get_boot_work_mode());
	if(get_boot_work_mode() == WORK_MODE_USB_PRODUCT) {
		printf("run usb efex\n");
		if(sunxi_usb_dev_register(2))
		{
			printf("invalid usb device\n");
		}
		sunxi_usb_main_loop(2500);
	}
```

也就是说：

```text
WORK_MODE_USB_PRODUCT
  -> sunxi_usb_dev_register(2)
  -> sunxi_usb_main_loop()
```

这里的 `2` 对应 USB EFEX 设备类型：

```text
SUNXI_USB_DEVICE_EFEX
```

注册逻辑在：

`drivers/sunxi_usb/usb_base_common.c`

```33:60:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_base_common.c
int sunxi_usb_dev_register(uint dev_name)
{
	int ret = 0;
	sunxi_usb_dbg("sunxi_usb_dev_register\n");
	switch(dev_name)
	{
#ifdef  SUNXI_USB_DEVICE_MASS
		case SUNXI_USB_DEVICE_MASS:
			sunxi_usb_dbg("register SUNXI_USB_DEVICE_MASS begin\n");
			sunxi_usb_module_reg(SUNXI_USB_DEVICE_MASS);
			sunxi_usb_dbg("register SUNXI_USB_DEVICE_MASS ok\n");
			break;
#endif

#ifdef  SUNXI_USB_DEVICE_EFEX
		case SUNXI_USB_DEVICE_EFEX:
			sunxi_usb_module_reg(SUNXI_USB_DEVICE_EFEX);

			break;
```

所以入口链路是：

```text
u-boot 启动
  -> do_sprite_test
  -> 判断 WORK_MODE_USB_PRODUCT
  -> 注册 SUNXI_USB_DEVICE_EFEX
  -> 进入 sunxi_usb_main_loop
  -> usb_efex.c 负责后续 USB 请求和数据传输
```

---

# 2. USB EFEX 设备枚举成什么样？

EFEX USB 设备描述在：

`drivers/sunxi_usb/usb_efex.h`

```26:34:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.h
#define DRIVER_VENDOR_ID			0x1F3A
#define DRIVER_PRODUCT_ID			0xEfE8

#define CBW_MAGIC		0x43555741	//AWUC
#define CSW_MAGIC		0x53555741	//AWUS
#define CSW_STATUS_PASS	0x00
#define CSW_STATUS_FAIL	0x01
```

所以 PC 端看到的设备通常是：

```text
VID = 0x1F3A
PID = 0xEFE8
```

这也是很多 Allwinner EFEX/FES 工具识别设备的依据。

`usb_efex.c` 的 USB 配置描述符里定义了：

```text
InterfaceClass    = 0xff
InterfaceSubClass = 0xff
InterfaceProtocol = 0xff
Bulk IN endpoint
Bulk OUT endpoint
```

也就是说，它不是标准 UMS/Fastboot，而是 Allwinner 私有协议：

```text
Vendor Specific + Bulk IN/OUT
```

---

# 3. U-Boot EFEX 协议层：CBW/CSW + FES 命令

U-Boot 这套 EFEX 协议长得很像 USB Mass Storage BOT 的 CBW/CSW 模式，但 magic 不是标准 `USBC/USBS`，而是 Allwinner 自己的：

```text
CBW = "AWUC"
CSW = "AWUS"
```

结构定义在 `usb_efex.h`：

```45:67:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.h
typedef struct tag_TRANSFERDATA
{
	u8	direction;					///
	u8	resv;						///
	u32	dataLen;					///
	u8  resv2[10];					///
}__attribute__ ((packed)) tTransferData;

struct sunxi_efex_cbw_t
{
	u32	magic;				//必须为CBW_MAGIC
	u32	tag;
	u32	data_transfer_len;	//表示本次传输的数据阶段要传递的数据大小
	u16	reserved_1;
	u8	reserved_2;
	u8	cmd_len;			//cmd_package的实际有效长度
	//u8	cmd_package[CBW_MAX_CMD_SIZE];
	tTransferData  cmd_package;
}__attribute__ ((packed));
```

CSW：

```70:77:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.h
#define CSW_TOTAL_LEN	13
struct sunxi_efex_csw_t
{
	u32	magic;		//必须为CSW_MAGIC
	u32	tag;
	u32	residue;		//没有发送/接收的数据长度
	u8	status;		//为CSW_STATUS_PASS或	CSW_STATUS_FAIL
}__attribute__ ((packed));
```

方向定义：

```80:82:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.h
#define TL_CMD_RESERVED	    0x00
#define TL_CMD_TRANSMIT	    0x11
#define TL_CMD_RECEIVE		0x12
```

注意这里方向是从“小机端/U-Boot 端”的角度描述的：

```text
TL_CMD_RECEIVE  = U-Boot 接收数据，也就是 PC -> 设备
TL_CMD_TRANSMIT = U-Boot 发送数据，也就是 设备 -> PC
```

---

# 4. FES/EFEX 命令号和 linux-sunxi / libefex 对应关系

`usb_efex.h` 里定义了这些命令：

```103:128:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.h
#define	FEX_CMD_fes_trans						0x0201
#define	FEX_CMD_fes_run 						0x0202
#define FEX_CMD_fes_down						0x0206
#define FEX_CMD_fes_up	    					0x0207
#define FEX_CMD_fes_verify    					0x0208
#define FEX_CMD_fes_query_storage				0x0209
#define FEX_CMD_fes_probe_hardware  			0x020A
#define FEX_CMD_fes_flash_set_on				0x020A
#define FEX_CMD_fes_flash_set_off				0x020B
#define FEX_CMD_fes_verify_value    			0x020C
#define FEX_CMD_fes_verify_status   			0x020D
#define FEX_CMD_fes_flash_size_probe			0x020E
#define FEX_CMD_fes_tool_mode					0x020F
#define FEX_CMD_fes_memset                      0x0210
#define FEX_CMD_fes_pmu                         0x0211
#define FEX_CMD_fes_unseqmem_read   			0x0212
#define FEX_CMD_fes_unseqmem_write  			0x0213
#define FEX_CMD_fes_force_erase                 0x0220
#define FEX_CMD_fes_force_erase_key             0x0221
#define FEX_CMD_fes_reset_cpu					0x0214
#define FEX_CMD_fes_low_power_manger 			0x0215
#define FEX_CMD_fes_query_secure                0x0230
#define FEX_CMD_fes_query_info               0x0231
```

这和 linux-sunxi FES 页面里的命令基本一致：

```text
0x201 FES_TRANSMITE
0x202 FES_RUN
0x206 FES_DOWNLOAD
0x207 FES_UPLOAD
0x208 FES_VERIFY
0x209 FES_QUERY_STORAGE
0x20A FES_FLASH_SET_ON
0x20B FES_FLASH_SET_OFF
0x20C FES_VERIFY_VALUE
0x20D FES_VERIFY_STATUS
0x20E FES_FLASH_SIZE_PROBE
0x20F FES_TOOL_MODE
```

`libefex` README 里说它支持：

```text
FEL and FES modes
Read and write device memory
Execute code in device memory
Flash programming and management
```

对应到这里就是：

```text
FEL 阶段：
  写 SRAM/DRAM
  执行 fes1/u-boot

FES/EFEX 阶段：
  发送 FEX_CMD_fes_down/up/verify/flash_set_on/tool_mode
  实现 Flash 写入、读取、校验、重启
```

---

# 5. U-Boot 端如何接收一个命令？

`usb_efex.c` 里核心状态机是 `sunxi_efex_state_loop()`。

它处理三类阶段：

```text
SETUP   : 收 CBW 或新格式命令
CMD     : 收 FES/EFEX 命令结构
DATA    : 根据命令收/发数据
STATUS  : 返回 CSW 或 Status_t
```

关键状态机逻辑在：

```1580:1649:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.c
static int sunxi_efex_state_loop(void  *buffer)
{
	static struct sunxi_efex_cbw_t  *cbw;
	static struct sunxi_efex_csw_t   csw;
	sunxi_ubuf_t *sunxi_ubuf = (sunxi_ubuf_t *)buffer;
    int  efex_write_error_flag = 0;

	switch(sunxi_usb_efex_status)
	{
		case SUNXI_USB_EFEX_IDLE:
			if(sunxi_ubuf->rx_ready_for_data == 1)
			{
				sunxi_usb_efex_status = SUNXI_USB_EFEX_SETUP;
			}
			//when product finish and usb disconnect ,shutdown machine
			if( sunxi_efex_next_action == SUNXI_UPDATE_NEXT_ACTION_NORMAL ||
				sunxi_efex_next_action >  SUNXI_UPDATE_NEXT_ACTION_REUPDATE )
			{
				if(efex_suspend_flag)
				{
					return SUNXI_UPDATE_NEXT_ACTION_SHUTDOWN;
				}
			}

			break;

		case SUNXI_USB_EFEX_SETUP:		//cbw

			sunxi_usb_dbg("SUNXI_USB_EFEX_SETUP\n");

            if((sunxi_ubuf->rx_req_length == sizeof(struct sunxi_efex_cbw_t)))
```

当收到 32 字节 CBW 时，检查 magic：

```1605:1616:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.c
            if((sunxi_ubuf->rx_req_length == sizeof(struct sunxi_efex_cbw_t)))
            {
                cbw = (struct sunxi_efex_cbw_t *)sunxi_ubuf->rx_req_buffer;
                if(CBW_MAGIC != cbw->magic)
                {
                    printf("sunxi usb error: the cbw signature 0x%x is bad, need 0x%x\n", cbw->magic, CBW_MAGIC);
                    sunxi_ubuf->rx_ready_for_data = 0;
                    sunxi_usb_efex_status = SUNXI_USB_EFEX_IDLE;
                    return -1;
                }
```

也支持 20 字节新格式命令：

```1617:1632:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.c
            else if(sunxi_ubuf->rx_req_length == FES_NEW_CMD_LEN)
            {
                sunxi_usb_dbg("----------new cmd format--------\n");
                if(CBW_MAGIC != ((u32*)(sunxi_ubuf->rx_req_buffer))[4])
                {
                    printf("sunxi usb error: the cmd signature 0x%x is bad, need 0x%x\n",
                          ((u32*)(sunxi_ubuf->rx_req_buffer))[4],CBW_MAGIC);


                    sunxi_ubuf->rx_ready_for_data = 0;
                    sunxi_usb_efex_status = SUNXI_USB_EFEX_IDLE;
```

然后根据方向和当前阶段决定是：

```text
继续 DMA 接收命令
继续 DMA 接收数据
发送数据
发送状态
```

---

# 6. PC 端发送 image 时，U-Boot 如何知道这块数据写哪里？

关键结构是 `fes_trans_t`：

```220:228:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.h
typedef struct tag_fes_trans
{
	u16 	app_cmd;
	u16 	tag;
	u32 	addr;				///
	u32 	len;				///
	u32     type;
}fes_trans_t;
```

PC 端每次发送 `FEX_CMD_fes_down` 时，会带上：

```text
addr : 如果是 Flash 数据，表示 Flash 起始扇区
       如果是 DRAM 数据，表示内存地址

len  : 本次传输长度，字节单位

type : 数据类型，例如 MBR、BOOT0、BOOT1、普通 Flash、DRAM 等
```

类型定义在：

```337:359:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.h
#define  SUNXI_EFEX_DATA_TYPE_MASK		(0x7fff)
#define  SUNXI_EFEX_DRAM_MASK			(0x7f00)
#define  SUNXI_EFEX_DRAM_TAG			(0x7f00)
#define  SUNXI_EFEX_MBR_TAG				(0x7f01)
#define  SUNXI_EFEX_BOOT1_TAG			(0x7f02)
#define  SUNXI_EFEX_BOOT0_TAG			(0x7f03)
#define  SUNXI_EFEX_ERASE_TAG           (0x7f04)
#define  SUNXI_EFEX_PMU_SET             (0x7f05)
#define  SUNXI_EFEX_UNSEQ_MEM_FOR_READ  (0x7f06)
#define  SUNXI_EFEX_UNSEQ_MEM_FOR_WRITE (0x7f07)
#define  SUNXI_EFEX_FULLIMG_SIZE_TAG    (0x7f10)
#define  SUNXI_EFEX_EXT4_UBIFS_TAG      (0x7ff0)

#define  SUNXI_EFEX_FLASH_TAG           (0x8000)
#define  SUNXI_EFEX_FLASH_BOOT0_TAG     (0x8001)
#define  SUNXI_EFEX_FLASH_BOOT1_TAG     (0x8002)

#define  SUNXI_EFEX_TRANS_MASK			(0x30000)
#define  SUNXI_EFEX_TRANS_START_TAG		(0x20000)
#define  SUNXI_EFEX_TRANS_FINISH_TAG	(0x10000)
```

所以 PC 端不是单纯把整个 `.img` 原样推给 U-Boot，而是类似这样：

```text
发送 MBR：
  cmd = FEX_CMD_fes_down
  type = SUNXI_EFEX_MBR_TAG | START/FINISH
  addr = 0
  len = MBR 数据长度

发送 boot0：
  cmd = FEX_CMD_fes_down
  type = SUNXI_EFEX_BOOT0_TAG | START/FINISH
  len = boot0 长度

发送 boot_package/toc1/u-boot：
  cmd = FEX_CMD_fes_down
  type = SUNXI_EFEX_BOOT1_TAG | START/FINISH
  len = boot_package/toc1 长度

发送普通分区数据：
  cmd = FEX_CMD_fes_down
  type = SUNXI_EFEX_FLASH_TAG 或普通 flash type
  addr = 目标分区起始扇区 + 当前偏移
  len = 当前 chunk 长度
```

---

# 7. `FEX_CMD_fes_down` 在 U-Boot 里怎么处理？

代码在 `usb_efex.c`：

```1008:1049:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.c
		case FEX_CMD_fes_down:
			sunxi_usb_dbg("FEX_CMD_fes_down\n");
			{
				fes_trans_t  *trans = (fes_trans_t *)cmd_buf;

				trans_data.type  = trans->type;									 //数据类型，MBR,BOOT1,BOOT0...以及分区类型
				if((trans->type & SUNXI_EFEX_DRAM_MASK) == SUNXI_EFEX_DRAM_MASK) //如果属于内存数据，则执行这里
				{
					if((SUNXI_EFEX_DRAM_MASK | SUNXI_EFEX_TRANS_FINISH_TAG) == trans->type)
					{
					    trans_data.act_recv_buffer = trans_data.base_recv_buffer;
						trans_data.dram_trans_buffer = (void*)(ulong)trans->addr;
						//printf("dram write: start 0x%x: length 0x%x\n", trans->addr, trans->len);
					}
					else
					{
						trans_data.act_recv_buffer   = trans_data.base_recv_buffer + trans_data.to_be_recved_size;	 //设置接收地址
					}
					trans_data.recv_size         = trans->len;	//设置接收长度，字节单位
					trans_data.to_be_recved_size += trans->len;
					sunxi_usb_dbg("down dram: start 0x%x, sectors 0x%x\n", trans_data.flash_start, trans_data.flash_sectors);
				}
				else	//属于flash数据，分别表示起始扇区，扇区数
				{
					trans_data.act_recv_buffer   = (trans_data.base_recv_buffer + SUNXI_EFEX_RECV_MEM_SIZE/2);	 //设置接收地址
					trans_data.recv_size         = trans->len;	//设置接收长度，字节单位

					trans_data.flash_start       = trans->addr;
					trans_data.flash_sectors     = (trans->len + 511) >> 9;
```

这里分两类：

## A. `type` 带 `SUNXI_EFEX_DRAM_MASK`

这种先收进 DRAM buffer，等 `FINISH` 时统一处理。

典型包括：

```text
MBR
BOOT0
BOOT1 / boot_package / toc1
ERASE flag
PMU config
```

## B. 不带 `SUNXI_EFEX_DRAM_MASK`

这种认为是普通 Flash 数据：

```text
addr = Flash 起始扇区
len  = 数据长度
```

后续收到数据后直接：

```text
sunxi_flash_write(flash_start, flash_sectors, buffer)
```

或者进入队列异步写。

---

# 8. 数据接收完成后如何真正写 Flash？

接收完成后，在状态机的 `SUNXI_USB_EFEX_RECEIVE_DATA_NEW` 里处理：

```1940:1980:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.c
                //wait for dma recv finish
				if (runtime_tick() - dma_recv_time_out > 30000) {
					tick_printf("err:dma recv time out\n");
					sunxi_board_run_fel();
				}
                if(!sunxi_usb_efex_write_enable)
                {
#ifdef _EFEX_USE_BUF_QUEUE_
                    if(efex_queue_write_one_page())
                    {
                        printf("sunxi efex queue: buf_queue_write_one_page() err\n");
                        efex_write_error_flag = 1;
                    }
#endif
                    break;
                }
                sunxi_usb_dbg("SUNXI_USB_RECEIVE_DATA_NEW\n");

                //表示当次数据已经接收完成
                uint data_type = trans_data.type & SUNXI_EFEX_DATA_TYPE_MASK;
                if(trans_data.type & SUNXI_EFEX_DRAM_MASK)      //表示属于内存数据，需要事先保存到内存中
                {
                    sunxi_usb_dbg("SUNXI_EFEX_DRAM_MASK\n");
                    if(trans_data.type & SUNXI_EFEX_TRANS_FINISH_TAG)   //表示当前类型数据已经接收完成
                    {
                        dram_data_recv_finish(data_type);
                    }
```

普通 Flash 数据走这里：

```1966:1988:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.c
                else        //表示当前数据需要写入flash
                {
                    sunxi_usb_dbg("SUNXI_EFEX_FLASH_MASK\n");
#ifdef _EFEX_USE_BUF_QUEUE_
                    if(0 != efex_save_buff_to_queue(trans_data.flash_start,trans_data.flash_sectors,(void *)trans_data.act_recv_buffer))
                    {
                        printf("efex queue not enough space...\n");
                        trans_data.last_err = -1;
                    }

#else
                    if(!sunxi_flash_write(trans_data.flash_start, trans_data.flash_sectors, (void *)trans_data.act_recv_buffer))
                    {
                        printf("sunxi usb efex err: write flash from 0x%x, sectors 0x%x failed\n", trans_data.flash_start, trans_data.flash_sectors);
                        trans_data.last_err = -1;
```

你这个配置里，如果不是 SPI NOR，会启用 `_EFEX_USE_BUF_QUEUE_`：

```text
PC -> USB bulk -> DMA buffer -> efex_save_buff_to_queue -> 后台队列 -> sunxi_flash_write
```

队列写入在 `efex_queue.c`：

```82:106:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/efex_queue.c
int efex_queue_write_all_page( void )
{
    if(buf_queue_empty())
    {
        //printf("efex queue empty\n");
        return 0;
    }
    while(buf_dequeue(&buf_queue_element) == 0)
    {
        if(!sunxi_flash_write(buf_queue_element.addr, buf_queue_element.sector_num,
            (void *)buf_queue_element.buff))
        {
            printf("efex_queue_write_one_page error: write flash from 0x%x, sectors 0x%x failed\n", 
                buf_queue_element.addr,buf_queue_element.sector_num);
            return -1;
        }
    }
    //printf("write all page done\n");
    return 0;
}
```

所以普通分区数据的链路是：

```text
PC 工具解析 image
  -> 计算目标分区扇区地址
  -> FEX_CMD_fes_down(type=flash, addr=sector, len=chunk)
  -> USB OUT bulk 发送 chunk
  -> U-Boot DMA 接收
  -> efex_save_buff_to_queue 或 sunxi_flash_write
  -> 写入 eMMC/NAND/NOR
  -> 返回 CSW
```

---

# 9. MBR、boot0、boot_package 这种特殊数据怎么处理？

特殊数据不直接按普通扇区写，而是先接收到 DRAM buffer，等 `FINISH` 后进入：

```text
dram_data_recv_finish(data_type)
```

核心逻辑在 `usb_efex.c`：

```1336:1372:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.c
static void dram_data_recv_finish(uint data_type)
{
	if(data_type == SUNXI_EFEX_MBR_TAG)			//传输MBR已经完成
        {
		//检查MBR的正确性


                trans_data.last_err = sunxi_sprite_verify_mbr((void *)trans_data.base_recv_buffer);
		if(!trans_data.last_err )
		{
#ifdef  CONFIG_SUNXI_NAND
		    nand_get_mbr((char *)trans_data.base_recv_buffer, 16 * 1024);
#endif
		        //准备擦除
		    if(!sunxi_sprite_erase_flash((void *)trans_data.base_recv_buffer))
		    {       //烧录mbr
                        printf("SUNXI_EFEX_MBR_TAG\n");
                        printf("mbr size = 0x%x\n", trans_data.to_be_recved_size);
                        trans_data.last_err = sunxi_sprite_download_mbr((void *)trans_data.base_recv_buffer, trans_data.to_be_recved_size);
		    }
```

boot_package / boot1：

```1374:1382:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.c
	else if(data_type == SUNXI_EFEX_BOOT1_TAG)	//传输BOOT1已经完成
	{
		printf("SUNXI_EFEX_BOOT1_TAG\n");
		printf("boot1 size = 0x%x, max size = 0x%x\n", trans_data.to_be_recved_size, SUNXI_EFEX_RECV_MEM_SIZE);
		if (trans_data.to_be_recved_size > SUNXI_EFEX_RECV_MEM_SIZE)
			trans_data.last_err = -1;
		else
			trans_data.last_err = sunxi_sprite_download_uboot((void *)trans_data.base_recv_buffer, get_boot_storage_type(), 0);
```

boot0：

```1383:1388:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.c
	else if(data_type == SUNXI_EFEX_BOOT0_TAG)	//传输BOOT0已经完成
	{
		printf("SUNXI_EFEX_BOOT0_TAG\n");
		printf("boot0 size = 0x%x\n", trans_data.to_be_recved_size);
		trans_data.last_err = sunxi_sprite_download_boot0((void *)trans_data.base_recv_buffer, get_boot_storage_type());
	}
```

这几个函数在 `sprite_download.c` 中实现。

例如 MBR 下载：

```109:142:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/sprite/sprite_download.c
int sunxi_sprite_download_mbr(void *buffer, uint buffer_size)
{
	int ret = 0;
	int storage_type = 0;
	int mbr_num = SUNXI_MBR_COPY_NUM;

	if (get_boot_storage_type() == STORAGE_NOR) {
		  mbr_num = 1;
	}

	if(buffer_size != (SUNXI_MBR_SIZE * mbr_num)) {
		printf("the mbr size is bad\n");
		return -1;
	}

#ifdef CONFIG_SUNXI_COMPARE_IMAGE_AND_FLASH
	if (compare_image_and_flash_size(buffer)) {
		pr_err("please check you image and flash size!\n");
		pr_err("=============Exit burning now=============\n");
		return -1;
	}
#endif

	storage_type = get_boot_storage_type();
	if ((storage_type == STORAGE_NAND) && (sunxi_sprite_init(0))) {
		return -2;
	}
	/*write GPT Table*/
	ret = download_standard_gpt(buffer,buffer_size,storage_type);
```

boot_package / toc1 下载：

```145:169:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/sprite/sprite_download.c
int sunxi_sprite_download_uboot(void *buffer, int production_media, int generate_checksum)
{
	u32 length = 0;

	sbrom_toc1_head_info_t *toc1 = (sbrom_toc1_head_info_t *)buffer;

	if(toc1->magic != TOC_MAIN_INFO_MAGIC)
	{
		printf("sunxi sprite: toc magic is error\n");
		printf("need %s image\n", gd->bootfile_mode == SUNXI_BOOT_FILE_TOC ? "secure" : "normal");
		return -1;
	}
	length = toc1->valid_len;
	if(generate_checksum) {
		toc1->add_sum = sunxi_sprite_generate_checksum(buffer,
					toc1->valid_len,toc1->add_sum);
	}

	printf("uboot size = 0x%x\n", length);
```

所以特殊 item 的链路是：

```text
PC 发送 MBR/boot0/boot_package 数据
  -> U-Boot 暂存到 base_recv_buffer
  -> 收到 FINISH type
  -> dram_data_recv_finish()
  -> 根据 data_type 调用 sprite_download.c
      MBR   -> sunxi_sprite_download_mbr()
      BOOT0 -> sunxi_sprite_download_boot0()
      BOOT1 -> sunxi_sprite_download_uboot()
  -> 内部按介质类型写 eMMC/NAND/NOR 的特殊区域
```

---

# 10. Flash 初始化在哪里触发？

PC 端在开始烧录前会发：

```text
FEX_CMD_fes_flash_set_on = 0x020A
```

U-Boot 处理：

```1198:1205:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.c
		case FEX_CMD_fes_flash_set_on:
			sunxi_usb_dbg("FEX_CMD_fes_flash_set_on\n");

			trans_data.last_err = sunxi_sprite_init(0);
			trans_data.app_next_status   = SUNXI_USB_EFEX_APPS_STATUS;

			break;
```

烧录结束时发：

```text
FEX_CMD_fes_flash_set_off = 0x020B
```

U-Boot 处理：

```1206:1212:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.c
		case FEX_CMD_fes_flash_set_off:
			sunxi_usb_dbg("FEX_CMD_fes_flash_set_off\n");

			trans_data.last_err = sunxi_sprite_exit(1);
			trans_data.app_next_status   = SUNXI_USB_EFEX_APPS_STATUS;

			break;
```

所以 PC 端烧录大致会：

```text
FES_FLASH_SET_ON
  -> 初始化 eMMC/NAND/NOR
  -> 建立访问接口
下载 MBR/分区/boot0/boot_package
FES_FLASH_SET_OFF
  -> flush/退出 Flash 驱动
```

---

# 11. 校验怎么做？

PC 端可以发：

```text
FEX_CMD_fes_verify_value = 0x020C
```

U-Boot 处理：

```1164:1183:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.c
		case FEX_CMD_fes_verify_value:
			sunxi_usb_dbg("FEX_CMD_fes_verify_value\n");
			{
				fes_cmd_verify_value_t  *cmd_verify = (fes_cmd_verify_value_t *)cmd_buf;
				fes_efex_verify_t 		*verify_data= (fes_efex_verify_t *)trans_data.base_send_buffer;

				verify_data->media_crc = sunxi_sprite_part_rawdata_verify(cmd_verify->start, cmd_verify->size);
				verify_data->flag 	   = EFEX_CRC32_VALID_FLAG;

				printf("FEX_CMD_fes_verify_value, start 0x%x, size high 0x%x:low 0x%x\n", cmd_verify->start, (uint)(cmd_verify->size>>32), (uint)(cmd_verify->size));
				printf("FEX_CMD_fes_verify_value 0x%x\n", verify_data->media_crc);
			}
			trans_data.act_send_buffer   = trans_data.base_send_buffer;
			trans_data.send_size         = sizeof(fes_efex_verify_t);
```

它会对 Flash 指定区域计算 CRC，然后返回给 PC 工具。

注意新格式命令下，在 `verify_value` 或 `flash_set_off` 前会先 flush 队列：

```1868:1878:/home/alientek/A133/DshanPI-ROSx-TinaSDK-V1/lichee/brandy-2.0/u-boot-2018/drivers/sunxi_usb/usb_efex.c
#ifdef _EFEX_USE_BUF_QUEUE_
                //flush queue buff   when verify cmd or flash set off cmd coming
                if(FEX_CMD_fes_verify_value == ((struct global_cmd_s *)cmd_buf)->app_cmd
                   ||  FEX_CMD_fes_flash_set_off==  ((struct global_cmd_s *)cmd_buf)->app_cmd )
                {
                    if(efex_queue_write_all_page())
                    {
                        printf("efex queue error: buf_queue_write_all_page fail\n");
                        efex_write_error_flag = 1;
```

这很重要。因为普通 Flash 数据可能先进入 buffer queue，还没完全落盘。校验前必须 flush。

---

# 12. `sprite_card.c` 和 USB 烧录是什么关系？

你当前打开的是：

`lichee/brandy-2.0/u-boot-2018/sprite/sprite_card.c`

这个文件主要是 **卡量产/SD 卡升级** 流程。

卡量产时，U-Boot 自己从 SD 卡上的固件镜像读取 item：

```text
sprite_card_firmware_probe()
sprite_card_fetch_download_map()
sprite_card_fetch_mbr()
sunxi_sprite_deal_part()
sunxi_sprite_deal_uboot()
sunxi_sprite_deal_boot0()
```

它会自己调用 `Img_OpenItem()`、`Img_GetItemSize()`、`Img_ReadItem()` 等去解析卡上的固件。

例如下载普通分区时：

```text
Img_OpenItem(imghd, "RFSFAT16", part_info->dl_filename)
Img_GetItemSize()
Img_GetItemStart()
sunxi_flash_read()
sunxi_sprite_write()
```

但 USB EFEX 模式不一样：

```text
USB EFEX 模式：
  PC 端解析 image
  U-Boot 只接收 FES_DOWN 命令和数据
  然后写 Flash

卡量产模式：
  U-Boot 自己从卡上的 image 读取 item
  自己解析 dlinfo/mbr/partition image
  然后写 Flash
```

所以 `sprite_card.c` 更多是理解“卡烧 image 解析”的参考；USB 烧录的核心是：

```text
drivers/sunxi_usb/usb_efex.c
sprite/sprite_download.c
sprite/sprite_erase.c
sprite/sprite_verify.c
sunxi_flash_xxx()
```

---

# 13. PC 端 `libefex` / OpenixSuit 做了什么？

以 `libefex` 这类开源实现来看，PC 端分两阶段：

## 阶段 A：FEL 阶段

PC 端通过 BootROM FEL 协议：

```text
1. 找到 FEL 设备
2. 写 fes1.fex 到 SRAM，例如 0x2000
3. 执行 fes1.fex
4. DRAM 初始化完成
5. 写 u-boot.fex 到 DRAM，例如 0x4a000000
6. 设置 u-boot work mode 为 USB product / FES
7. 执行 u-boot.fex
```

这部分对应 `libefex` README 里说的：

```text
Read and write device memory
Execute code in device memory
```

## 阶段 B：FES/EFEX 阶段

U-Boot 起来后，PC 端重新枚举到：

```text
VID 0x1F3A / PID 0xEFE8
```

然后通过 bulk 端点发送：

```text
APP_LAYER_COMMEN_CMD_VERIFY_DEV
APP_LAYER_COMMEN_CMD_IS_READY
APP_LAYER_COMMEN_CMD_GET_CMD_SET_VER
FEX_CMD_fes_flash_set_on
FEX_CMD_fes_down
FEX_CMD_fes_verify_value
FEX_CMD_fes_flash_set_off
FEX_CMD_fes_tool_mode
```

这些命令在 U-Boot 端全部可以对应到 `usb_efex.c`。

---

# 14. 一个完整 USB 烧录 image 的典型流程

结合你这个 SDK，完整流程可以抽象成：

```text
PC 工具，例如 PhoenixSuit/OpenixSuit/libefex
|
|-- FEL 阶段
|   |
|   |-- 下载 fes1.fex 到 SRAM
|   |-- 执行 fes1.fex
|   |-- fes1 初始化 DRAM
|   |
|   |-- 下载 u-boot.fex 到 DRAM
|   |-- 修改 u-boot work mode 为 USB product
|   |-- 执行 u-boot
|
|-- U-Boot EFEX 阶段
    |
    |-- U-Boot 枚举 USB EFEX 设备
    |     VID=0x1F3A PID=0xEFE8
    |
    |-- PC 发送 VERIFY_DEV
    |     U-Boot 返回 AWUSBFEX
    |
    |-- PC 发送 IS_READY
    |     U-Boot 返回 READY
    |
    |-- PC 发送 GET_CMD_SET_VER
    |     U-Boot 返回 2.0
    |
    |-- PC 发送 FES_FLASH_SET_ON
    |     U-Boot 调 sunxi_sprite_init()
    |
    |-- PC 发送 MBR
    |     FES_DOWN type=SUNXI_EFEX_MBR_TAG
    |     U-Boot 收完整后：
    |       sunxi_sprite_verify_mbr()
    |       sunxi_sprite_erase_flash()
    |       sunxi_sprite_download_mbr()
    |
    |-- PC 发送 boot_package / toc1
    |     FES_DOWN type=SUNXI_EFEX_BOOT1_TAG
    |     U-Boot 收完整后：
    |       sunxi_sprite_download_uboot()
    |
    |-- PC 发送 boot0
    |     FES_DOWN type=SUNXI_EFEX_BOOT0_TAG
    |     U-Boot 收完整后：
    |       sunxi_sprite_download_boot0()
    |
    |-- PC 发送各分区数据
    |     FES_DOWN type=FLASH
    |     addr=目标 Flash 扇区
    |     len=chunk 大小
    |     U-Boot：
    |       DMA 接收
    |       efex_save_buff_to_queue()
    |       sunxi_flash_write()
    |
    |-- PC 发送 VERIFY_VALUE
    |     U-Boot：
    |       flush queue
    |       sunxi_sprite_part_rawdata_verify()
    |       返回 CRC
    |
    |-- PC 发送 FES_FLASH_SET_OFF
    |     U-Boot：
    |       flush queue
    |       sunxi_sprite_exit()
    |
    |-- PC 发送 FES_TOOL_MODE
          U-Boot 设置下一步动作：
            reboot / shutdown / normal boot
```

---

# 15. 为什么说 image 解析主要在 PC 端？

因为 USB EFEX 的 `FEX_CMD_fes_down` 命令只告诉 U-Boot：

```text
addr
len
type
```

它没有传：

```text
我要烧 boot.fex
我要烧 rootfs.fex
我要烧 env.fex
```

这种文件名语义。

也就是说 USB EFEX 里的 U-Boot 不关心：

```text
image.cfg
sys_partition.fex
boot.fex
rootfs.fex
Vrootfs.fex
```

这些文件名本身。

PC 工具需要先解析 Allwinner `.img` 文件：

```text
读取 image item table
找到 sunxi_mbr.fex
找到 dlinfo.fex
找到 boot0_xxx.fex
找到 boot_package.fex
找到 rootfs.fex / boot.fex / env.fex 等分区数据
根据 MBR / dlinfo 计算每个分区的目标扇区
```

然后转成一系列 FES 命令：

```text
FES_DOWN(type, addr, len) + bulk data
```

U-Boot 只根据 `type` 和 `addr` 写入。

这和卡烧不同。卡烧时 U-Boot 自己读 SD 卡上的 image，所以 `sprite_card.c` 里有大量 `Img_OpenItem()`、`Img_ReadItem()` 逻辑。

---

# 16. `boot.fex/rootfs.fex/env.fex` 在 USB 烧录时是怎么对应到 Flash 的？

以你的 `sys_partition.fex` 为例：

```text
boot       -> downloadfile = boot.fex
rootfs     -> downloadfile = rootfs.fex
env        -> downloadfile = env.fex
recovery   -> downloadfile = recovery.fex
```

`dragon` 打包时会把这些文件打进最终 `.img`，并生成 `dlinfo.fex`/下载映射。

PC 工具解析 `.img` 后得到类似：

```text
boot.fex   应写到 boot 分区起始扇区
rootfs.fex 应写到 rootfs 分区起始扇区
env.fex    应写到 env 分区起始扇区
```

然后 PC 端发送：

```text
FEX_DOWN(type=FLASH, addr=boot_start_sector, len=chunk)
FEX_DOWN(type=FLASH, addr=rootfs_start_sector, len=chunk)
FEX_DOWN(type=FLASH, addr=env_start_sector, len=chunk)
```

U-Boot 收到后只看到：

```text
写 Flash sector X，长度 Y
写 Flash sector A，长度 B
```

它不知道这个 chunk 原始文件名叫 `rootfs.fex`。

---

# 17. 和 `libefex` 的对应关系

`libefex` 这类库通常会把流程拆成 API：

```text
fel_write(addr, buf, len)
fel_exec(addr)

fes_verify_dev()
fes_flash_set_on()
fes_down(type, addr, data, len)
fes_up(type, addr, len)
fes_verify_value(start, size)
fes_flash_set_off()
fes_tool_mode(...)
```

这些 API 在 U-Boot 端分别对应：

| PC/libefex 行为 | U-Boot 对应 |
|---|---|
| 扫描 FEL/FES 设备 | USB VID/PID、descriptor |
| FEL write memory | BootROM FEL，不在 U-Boot |
| FEL exec | BootROM FEL，不在 U-Boot |
| FES verify device | `APP_LAYER_COMMEN_CMD_VERIFY_DEV` |
| FES ready | `APP_LAYER_COMMEN_CMD_IS_READY` |
| FES get version | `APP_LAYER_COMMEN_CMD_GET_CMD_SET_VER` |
| FES download | `FEX_CMD_fes_down` |
| FES upload | `FEX_CMD_fes_up` |
| FES verify | `FEX_CMD_fes_verify_value/status` |
| FES flash init | `FEX_CMD_fes_flash_set_on` |
| FES flash exit | `FEX_CMD_fes_flash_set_off` |
| FES finish/reboot | `FEX_CMD_fes_tool_mode` |

所以 `libefex` 的作用相当于 PhoenixSuit 的开源主机端协议实现；U-Boot 端就是你 SDK 里的 `usb_efex.c`。

---

# 18. 最关键的一句话

USB 烧录时的“image 下载”不是 U-Boot 自己去读 `.img` 文件，而是：

```text
PC 工具解析 Allwinner image
  -> 转换成 EFEX/FES 命令流
  -> 通过 USB bulk 发给 U-Boot
  -> U-Boot 根据 type/addr/len 接收数据
  -> 调 sprite_download/sunxi_flash_write 写入存储介质
```

核心 U-Boot 代码路径是：

```text
cmd/sunxi_sprite.c
  -> sunxi_usb_dev_register(SUNXI_USB_DEVICE_EFEX)
  -> sunxi_usb_main_loop()

drivers/sunxi_usb/usb_efex.c
  -> USB 枚举
  -> CBW/CSW 状态机
  -> FEX_CMD_fes_down/up/verify/flash_set_on/tool_mode

sprite/sprite_download.c
  -> sunxi_sprite_download_mbr()
  -> sunxi_sprite_download_boot0()
  -> sunxi_sprite_download_uboot()

drivers/sunxi_flash/*
  -> sunxi_flash_write()
  -> sunxi_flash_read()
```

而你打开的：

```text
sprite/sprite_card.c
```

主要对应 **卡烧/SD 升级**，它会自己解析卡上的 image；USB EFEX 模式则是 **PC 端解析 image，U-Boot 端只执行写入命令**。

