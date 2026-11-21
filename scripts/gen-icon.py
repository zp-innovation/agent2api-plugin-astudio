import base64, io
from PIL import Image, ImageDraw, ImageFilter

S = 4  # supersample
N = 128 * S

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

top = (46, 91, 255)      # indigo
bottom = (124, 58, 237)  # violet

# 垂直渐变底
grad = Image.new("RGB", (1, N))
for y in range(N):
    grad.putpixel((0, y), lerp(top, bottom, y / (N - 1)))
grad = grad.resize((N, N), Image.BICUBIC)

# 圆角遮罩
mask = Image.new("L", (N, N), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, N - 1, N - 1], radius=int(28 * S), fill=255)

icon = Image.new("RGBA", (N, N), (0, 0, 0, 0))
icon.paste(grad, (0, 0), mask)

# 星芒（星辰）
cx, cy = N / 2, N / 2
R = 34 * S
w = 5.5 * S
star = [(cx, cy - R), (cx + w, cy - w), (cx + R, cy), (cx + w, cy + w),
        (cx, cy + R), (cx - w, cy + w), (cx - R, cy), (cx - w, cy - w)]

glow = Image.new("RGBA", (N, N), (0, 0, 0, 0))
ImageDraw.Draw(glow).polygon(star, fill=(255, 255, 255, 110))
glow = glow.filter(ImageFilter.GaussianBlur(9 * S))
icon = Image.alpha_composite(icon, glow)

layer = Image.new("RGBA", (N, N), (0, 0, 0, 0))
ImageDraw.Draw(layer).polygon(star, fill=(255, 255, 255, 255))
icon = Image.alpha_composite(icon, layer)

# 右下角小星，暗示「助手」
r2, w2 = 10 * S, 2.2 * S
cx2, cy2 = N * 0.775, N * 0.775
small = [(cx2, cy2 - r2), (cx2 + w2, cy2 - w2), (cx2 + r2, cy2), (cx2 + w2, cy2 + w2),
         (cx2, cy2 + r2), (cx2 - w2, cy2 + w2), (cx2 - r2, cy2), (cx2 - w2, cy2 - w2)]
layer2 = Image.new("RGBA", (N, N), (0, 0, 0, 0))
ImageDraw.Draw(layer2).polygon(small, fill=(255, 255, 255, 210))
icon = Image.alpha_composite(icon, layer2)

icon = icon.resize((128, 128), Image.LANCZOS)
buf = io.BytesIO()
icon.save(buf, format="PNG", optimize=True)
data = base64.b64encode(buf.getvalue()).decode("ascii")
print(len(data))
open(r"D:\\Development\\Agent2Plugin\\AStudio\\icon.b64.txt", "w", encoding="ascii").write(data)
