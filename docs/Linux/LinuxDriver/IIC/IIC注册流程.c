static int xxx_probe(struct i2c_client *client,

const struct i2c_device_id *id)
{
/* 函数具体程序 */
return 0;
}

/* i2c 驱动的 remove 函数 */
static int xxx_remove(struct i2c_client *client)
 {
 /* 函数具体程序 */
 return 0;
 }

 /* 传统匹配方式 ID 列表 */
 static const struct i2c_device_id xxx_id[] = {
 {"xxx", 0},
 {}
 };

 /* 设备树匹配列表 */
 static const struct of_device_id xxx_of_match[] = {
 { .compatible = "xxx" },
 { /* Sentinel */ }
 };

 /* i2c 驱动结构体 */
 static struct i2c_driver xxx_driver = {
 .probe = xxx_probe,
 .remove = xxx_remove,
 .driver = {
 .owner = THIS_MODULE,
 .name = "xxx",
 .of_match_table = xxx_of_match,
 },
 .id_table = xxx_id,
 };

 /* 驱动入口函数 */
 static int __init xxx_init(void)
 {
 int ret = 0;

 ret = i2c_add_driver(&xxx_driver)
 return ret;
 }

 /* 驱动出口函数 */
 static void __exit xxx_exit(void)
 {
 i2c_del_driver(&xxx_driver);
 }

 module_init(xxx_init);
 module_exit(xxx_exit);