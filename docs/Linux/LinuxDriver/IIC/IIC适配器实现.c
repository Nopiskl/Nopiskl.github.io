//这款 CPU 有 x 个 IIC 硬件控制器，这个 xxx_i2c_probe 会被匹配 x 次，也就是调用 x 次
//从而完成对应次数的硬件初始化工作

static struct platform_device_id imx_i2c_devtype[] = {
{
.name = "imx1-i2c",
.driver_data = (kernel_ulong_t)&imx1_i2c_hwdata,
}, {
.name = "imx21-i2c",
.driver_data = (kernel_ulong_t)&imx21_i2c_hwdata,
}, {
/* sentinel */
}
};


MODULE_DEVICE_TABLE(platform, imx_i2c_devtype);


static const struct of_device_id i2c_imx_dt_ids[] = {
{ .compatible = "fsl,imx1-i2c", .data = &imx1_i2c_hwdata, },
{ .compatible = "fsl,imx21-i2c", .data = &imx21_i2c_hwdata, },
{ .compatible = "fsl,vf610-i2c", .data = &vf610_i2c_hwdata, },
{ /* sentinel */ }
};
MODULE_DEVICE_TABLE(of, i2c_imx_dt_ids);


//驱动实例
static struct platform_driver i2c_imx_driver = {
.probe = i2c_imx_probe,
.remove = i2c_imx_remove,
.driver = {
.name = DRIVER_NAME,
.owner = THIS_MODULE,
.of_match_table = i2c_imx_dt_ids,
.pm = IMX_I2C_PM,
},
.id_table = imx_i2c_devtype,
};


static int __init i2c_adap_imx_init(void)
{
return platform_driver_register(&i2c_imx_driver);
}


subsys_initcall(i2c_adap_imx_init);
static void __exit i2c_adap_imx_exit(void)
{
platform_driver_unregister(&i2c_imx_driver);
}
module_exit(i2c_adap_imx_exit);