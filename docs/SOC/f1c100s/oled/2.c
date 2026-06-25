#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <string.h>
#include <linux/fb.h>
#include <sys/ioctl.h>
#include <sys/mman.h>

unsigned char font8x8_basic[128][8] = {
    ['H'] = {0x42,0x42,0x42,0x7E,0x42,0x42,0x42,0x00},
    ['e'] = {0x00,0x3C,0x42,0x7E,0x40,0x42,0x3C,0x00},
    ['l'] = {0x0C,0x0C,0x0C,0x0C,0x0C,0x0C,0x0C,0x00},
    ['o'] = {0x00,0x3C,0x42,0x42,0x42,0x42,0x3C,0x00},
    [' '] = {0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00},
    ['W'] = {0x42,0x42,0x42,0x5A,0x5A,0x66,0x42,0x00},
    ['r'] = {0x00,0x5C,0x62,0x40,0x40,0x40,0x40,0x00},
    ['d'] = {0x02,0x02,0x3A,0x46,0x42,0x46,0x3A,0x00},
    [','] = {0x00,0x00,0x00,0x00,0x00,0x18,0x18,0x10},
    ['!'] = {0x18,0x18,0x18,0x18,0x18,0x00,0x18,0x00},
};

#define FB_DEVICE "/dev/fb1"
#define CHAR_W 8
#define CHAR_H 8

void draw_char(unsigned char *fbmem, int screen_width, int x, int y, char c) {
    if (c < 0 || c > 127) return;

    int row, col;
    for (row = 0; row < CHAR_H; row++) {
        unsigned char bits = font8x8_basic[(int)c][row];
        for (col = 0; col < CHAR_W; col++) {
            int byte_offset = ((y + row) * screen_width + (x + col)) / 8;
            int bit_offset = (x + col) % 8;
            if (bits & (1 << (7 - col))) {
                fbmem[byte_offset] |= (1 << bit_offset);  // 点亮像素
            } else {
                fbmem[byte_offset] &= ~(1 << bit_offset); // 熄灭像素
            }
        }
    }
}

int main() {
    int fb = open(FB_DEVICE, O_RDWR);
    if (fb < 0) {
        perror("open");
        return 1;
    }

    struct fb_var_screeninfo vinfo;
    struct fb_fix_screeninfo finfo;

    if (ioctl(fb, FBIOGET_VSCREENINFO, &vinfo)) {
        perror("FBIOGET_VSCREENINFO");
        close(fb);
        return 1;
    }
    if (ioctl(fb, FBIOGET_FSCREENINFO, &finfo)) {
        perror("FBIOGET_FSCREENINFO");
        close(fb);
        return 1;
    }

    int screensize = finfo.smem_len;
    unsigned char *fbmem = mmap(0, screensize, PROT_READ | PROT_WRITE, MAP_SHARED, fb, 0);
    if (fbmem == MAP_FAILED) {
        perror("mmap");
        close(fb);
        return 1;
    }

    // 清屏
    memset(fbmem, 0x00, screensize);

    // 要显示的文本
    const char *text = "Hello, World!";
    int x = 0, y = 0;
    int i;

    for (i = 0; text[i]; i++) {
        draw_char(fbmem, vinfo.xres, x, y, text[i]);
        x += CHAR_W;
        if (x + CHAR_W > vinfo.xres) {
            x = 0;
            y += CHAR_H;
        }
    }

    munmap(fbmem, screensize);
    close(fb);

    printf("文字已输出到 OLED：Hello, World!\n");

    return 0;
}