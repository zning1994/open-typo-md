#!/usr/bin/env python3
"""从 `source.png` 生成三平台图标集与官网素材。

    python3 scripts/icons/generate.py        # 需要 Pillow

产物提交进仓库（跟截图同一个理由：让 CI 构建不必依赖 Python），
改 logo 时重跑一次即可。

## 为什么要重新排版而不是直接缩放

原图的笔画只占画面中间一小条，四周留白很大。直接缩到 16×16 之后笔画会细到
看不见 —— 而 16px 恰恰是 Windows 任务栏和文件列表里最常出现的尺寸。
所以先按内容的实际包围盒裁掉留白，再按各平台的安全边距重新放。

## 边距为什么不是一个数

macOS 的图标规范要求四周留出约 10% 的空白（系统会给它加圆角与阴影），
而 Windows 的 .ico 与 Linux 的 png 是「顶格画」，留白留多了就显得小一号。
所以两边分开算。
"""
import pathlib
import sys

from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
SRC = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / 'source.png'
OUT = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else REPO / 'apps/desktop/build'
OUT.mkdir(parents=True, exist_ok=True)

BG = (242, 237, 228, 255)   # 原图的米白底
INK = (38, 38, 42, 255)     # 笔画的黑

src = Image.open(SRC).convert('RGBA')

# 1. 找出笔画的实际包围盒：把接近底色的像素当成背景
mask = Image.new('L', src.size, 0)
px = src.load()
mpx = mask.load()
for y in range(src.height):
    for x in range(src.width):
        r, g, b, _ = px[x, y]
        # 跟底色的曼哈顿距离，够远就算笔画
        if abs(r - BG[0]) + abs(g - BG[1]) + abs(b - BG[2]) > 90:
            mpx[x, y] = 255
box = mask.getbbox()
if box is None:
    raise SystemExit('原图里找不到笔画')
stroke = src.crop(box)
stroke_mask = mask.crop(box)
print(f'原图 {src.size} → 笔画包围盒 {stroke.size}')


def compose(size: int, margin: float, transparent: bool) -> Image.Image:
    """把笔画放进一个正方形画布，四周留 `margin` 比例的空白。"""
    inner = max(1, int(size * (1 - 2 * margin)))
    w, h = stroke.size
    scale = min(inner / w, inner / h)
    tw, th = max(1, round(w * scale)), max(1, round(h * scale))

    # 先做一张纯色的笔画图，再用缩放后的 alpha 贴上去 ——
    # 直接缩放原图会把米白底一起缩进来，透明版就废了
    art = Image.new('RGBA', (tw, th), INK)
    art.putalpha(stroke_mask.resize((tw, th), Image.LANCZOS))

    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0) if transparent else BG)
    canvas.alpha_composite(art, ((size - tw) // 2, (size - th) // 2))
    return canvas


# 2. macOS：留白多一点（系统会加圆角/阴影），带米白底
MAC_SIZES = [16, 32, 64, 128, 256, 512, 1024]
mac = {s: compose(s, 0.14, transparent=False) for s in MAC_SIZES}
mac[1024].save(OUT / 'icon.png')  # electron-builder 会从这张派生 icns
print('写出 icon.png (1024, 带底)')

# 3. Windows .ico：顶格一点，透明底 —— 任务栏背景色不固定
ico_sizes = [16, 24, 32, 48, 64, 128, 256]
ico = compose(256, 0.06, transparent=True)
ico.save(OUT / 'icon.ico', sizes=[(s, s) for s in ico_sizes])
print(f'写出 icon.ico ({ico_sizes})')

# 4. Linux：electron-builder 要一个尺寸命名的目录
icons_dir = OUT / 'icons'
icons_dir.mkdir(exist_ok=True)
for s in (16, 32, 48, 64, 128, 256, 512):
    compose(s, 0.08, transparent=True).save(icons_dir / f'{s}x{s}.png')
print('写出 icons/{16..512}x*.png（透明底）')

# 5. 官网与 README 用：透明底的方形标记 + 一张 favicon
site = REPO / 'docs' / 'public'
site.mkdir(parents=True, exist_ok=True)
compose(512, 0.08, transparent=True).save(site / 'logo.png')
compose(180, 0.08, transparent=False).save(site / 'apple-touch-icon.png')
compose(32, 0.06, transparent=True).save(site / 'favicon.png')
print(f'写出 {site}/logo.png, apple-touch-icon.png, favicon.png')
