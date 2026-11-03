/* Decode FS25 DX10/BC7 (and BC1/BC3) DDS store icons to raw RGBA8 on stdout.
 * Width/height as little-endian uint32 header, then width*height*4 bytes.
 * MIT/Unlicense via bcdec.h (iOrange).
 */
#define BCDEC_IMPLEMENTATION
#include "bcdec.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

static int write_u32(uint32_t v) {
    unsigned char b[4] = {
        (unsigned char)(v & 0xff),
        (unsigned char)((v >> 8) & 0xff),
        (unsigned char)((v >> 16) & 0xff),
        (unsigned char)((v >> 24) & 0xff),
    };
    return fwrite(b, 1, 4, stdout) == 4;
}

int main(int argc, char **argv) {
    FILE *f;
    long size;
    unsigned char *dds;
    uint32_t height, width, pfFlags, dxgi;
    char fourCc[5];
    const unsigned char *data;
    size_t dataLen, offset;
    int blocksX, blocksY, x, y;
    unsigned char *rgba;
    size_t rgbaLen;

    if (argc != 2) {
        fprintf(stderr, "usage: dds2rgba file.dds\n");
        return 2;
    }

    f = fopen(argv[1], "rb");
    if (!f) {
        perror(argv[1]);
        return 1;
    }
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return 1;
    }
    size = ftell(f);
    if (size < 128) {
        fclose(f);
        return 1;
    }
    rewind(f);
    dds = (unsigned char *)malloc((size_t)size);
    if (!dds || fread(dds, 1, (size_t)size, f) != (size_t)size) {
        free(dds);
        fclose(f);
        return 1;
    }
    fclose(f);

    if (memcmp(dds, "DDS ", 4) != 0) {
        free(dds);
        return 1;
    }

    height = (uint32_t)dds[12] | ((uint32_t)dds[13] << 8) | ((uint32_t)dds[14] << 16) | ((uint32_t)dds[15] << 24);
    width = (uint32_t)dds[16] | ((uint32_t)dds[17] << 8) | ((uint32_t)dds[18] << 16) | ((uint32_t)dds[19] << 24);
    pfFlags = (uint32_t)dds[80] | ((uint32_t)dds[81] << 8) | ((uint32_t)dds[82] << 16) | ((uint32_t)dds[83] << 24);
    memcpy(fourCc, dds + 84, 4);
    fourCc[4] = 0;

    /* PDA overviews are 4096 or 8192. Output is reduced to 4096 below. */
    if (width < 1 || height < 1 || width > 8192 || height > 8192) {
        free(dds);
        return 1;
    }

    if (memcmp(fourCc, "DX10", 4) == 0) {
        if ((size_t)size < 148) {
            free(dds);
            return 1;
        }
        dxgi = (uint32_t)dds[128] | ((uint32_t)dds[129] << 8) | ((uint32_t)dds[130] << 16) | ((uint32_t)dds[131] << 24);
        data = dds + 148;
        dataLen = (size_t)size - 148;
    } else {
        dxgi = 0;
        data = dds + 128;
        dataLen = (size_t)size - 128;
        if ((pfFlags & 0x4) == 0) {
            free(dds);
            return 1;
        }
        if (memcmp(fourCc, "DXT1", 4) == 0) {
            dxgi = 71;
        } else if (memcmp(fourCc, "DXT3", 4) == 0) {
            dxgi = 74;
        } else if (memcmp(fourCc, "DXT5", 4) == 0) {
            dxgi = 77;
        } else {
            free(dds);
            return 1;
        }
    }

    blocksX = (int)((width + 3) / 4);
    blocksY = (int)((height + 3) / 4);
    rgbaLen = (size_t)width * (size_t)height * 4;
    rgba = (unsigned char *)calloc(1, rgbaLen);
    if (!rgba) {
        free(dds);
        return 1;
    }

    offset = 0;
    for (y = 0; y < blocksY; ++y) {
        for (x = 0; x < blocksX; ++x) {
            unsigned char blockRgba[16 * 4];
            size_t blockSize;
            int row, col, px, py, src, dst;

            memset(blockRgba, 0, sizeof(blockRgba));
            if (dxgi == 71 || dxgi == 72) {
                blockSize = 8;
                if (offset + blockSize > dataLen) {
                    free(rgba);
                    free(dds);
                    return 1;
                }
                bcdec_bc1(data + offset, blockRgba, 16);
            } else if (dxgi == 74 || dxgi == 75) {
                blockSize = 16;
                if (offset + blockSize > dataLen) {
                    free(rgba);
                    free(dds);
                    return 1;
                }
                bcdec_bc2(data + offset, blockRgba, 16);
            } else if (dxgi == 77 || dxgi == 78) {
                blockSize = 16;
                if (offset + blockSize > dataLen) {
                    free(rgba);
                    free(dds);
                    return 1;
                }
                bcdec_bc3(data + offset, blockRgba, 16);
            } else if (dxgi == 98 || dxgi == 99) {
                blockSize = 16;
                if (offset + blockSize > dataLen) {
                    free(rgba);
                    free(dds);
                    return 1;
                }
                bcdec_bc7(data + offset, blockRgba, 16);
            } else {
                free(rgba);
                free(dds);
                return 1;
            }
            offset += blockSize;

            for (row = 0; row < 4; ++row) {
                for (col = 0; col < 4; ++col) {
                    px = x * 4 + col;
                    py = y * 4 + row;
                    if (px >= (int)width || py >= (int)height) {
                        continue;
                    }
                    src = (row * 4 + col) * 4;
                    dst = (py * (int)width + px) * 4;
                    rgba[dst + 0] = blockRgba[src + 0];
                    rgba[dst + 1] = blockRgba[src + 1];
                    rgba[dst + 2] = blockRgba[src + 2];
                    rgba[dst + 3] = blockRgba[src + 3];
                }
            }
        }
    }

    free(dds);

    if (width > 4096 || height > 4096) {
        uint32_t factor = 2;
        uint32_t nw, nh, sx, sy, ox, oy, n;
        unsigned char *small;
        uint32_t acc[4];

        while (((width > height ? width : height) / factor) > 4096) {
            factor++;
        }
        nw = width / factor;
        nh = height / factor;
        if (nw < 1 || nh < 1) {
            free(rgba);
            return 1;
        }
        small = (unsigned char *)malloc((size_t)nw * (size_t)nh * 4);
        if (!small) {
            free(rgba);
            return 1;
        }
        for (sy = 0; sy < nh; ++sy) {
            for (sx = 0; sx < nw; ++sx) {
                acc[0] = acc[1] = acc[2] = acc[3] = 0;
                n = 0;
                for (oy = 0; oy < factor; ++oy) {
                    for (ox = 0; ox < factor; ++ox) {
                        size_t src = (((size_t)sy * factor + oy) * width + ((size_t)sx * factor + ox)) * 4;
                        acc[0] += rgba[src];
                        acc[1] += rgba[src + 1];
                        acc[2] += rgba[src + 2];
                        acc[3] += rgba[src + 3];
                        n++;
                    }
                }
                small[((size_t)sy * nw + sx) * 4] = (unsigned char)(acc[0] / n);
                small[((size_t)sy * nw + sx) * 4 + 1] = (unsigned char)(acc[1] / n);
                small[((size_t)sy * nw + sx) * 4 + 2] = (unsigned char)(acc[2] / n);
                small[((size_t)sy * nw + sx) * 4 + 3] = (unsigned char)(acc[3] / n);
            }
        }
        free(rgba);
        rgba = small;
        width = nw;
        height = nh;
        rgbaLen = (size_t)nw * (size_t)nh * 4;
    }

    if (!write_u32(width) || !write_u32(height) || fwrite(rgba, 1, rgbaLen, stdout) != rgbaLen) {
        free(rgba);
        return 1;
    }
    free(rgba);
    return 0;
}
