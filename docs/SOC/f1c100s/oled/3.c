#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <linux/fb.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <string.h>

int main() {
    const char *fb_path = "/dev/fb1";
    int fb_fd = open(fb_path, O_RDWR);
    if (fb_fd < 0) {
        perror("open fb1");
        return 1;
    }

    struct fb_var_screeninfo vinfo;
    struct fb_fix_screeninfo finfo;

    if (ioctl(fb_fd, FBIOGET_FSCREENINFO, &finfo)) {
        perror("ioctl FBIOGET_FSCREENINFO");
        close(fb_fd);
        return 1;
    }

    if (ioctl(fb_fd, FBIOGET_VSCREENINFO, &vinfo)) {
        perror("ioctl FBIOGET_VSCREENINFO");
        close(fb_fd);
        return 1;
    }

    printf("Framebuffer resolution: %dx%d, %dbpp\n", vinfo.xres, vinfo.yres, vinfo.bits_per_pixel);

    long screensize = finfo.smem_len;

    // 映射 framebuffer 到内存
    unsigned char *fbmem = mmap(0, screensize, PROT_READ | PROT_WRITE, MAP_SHARED, fb_fd, 0);
    if ((int)fbmem == -1) {
        perror("mmap");
        close(fb_fd);
        return 1;
    }

    // 填满：每一位都是1（白色）——适用于 monochrome OLED
    memset(fbmem, 0xFF, screensize);

    // 解除映射
    munmap(fbmem, screensize);
    close(fb_fd);

    printf("OLED 填充完成！\n");

    return 0;
}
