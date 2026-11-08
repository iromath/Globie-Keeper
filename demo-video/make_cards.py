"""Render the intro / outro title cards for the Globie Keeper demo video."""
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
BG = (7, 10, 15)
MINT = (127, 227, 176)
WHITE = (243, 248, 245)
GREY = (154, 168, 180)
DIM = (108, 122, 134)

FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def font(path, size):
    return ImageFont.truetype(path, size)


def tracked(draw, xy, text, f, fill, spacing):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textlength(ch, font=f) + spacing
    return x


def centre(draw, y, text, f, fill, spacing=0):
    if spacing:
        total = sum(draw.textlength(c, font=f) + spacing for c in text) - spacing
        tracked(draw, ((W - total) / 2, y), text, f, fill, spacing)
    else:
        w = draw.textlength(text, font=f)
        draw.text(((W - w) / 2, y), text, font=f, fill=fill)


def base():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # soft mint glow at the top-centre
    glow = Image.new("RGB", (W, H), BG)
    gd = ImageDraw.Draw(glow)
    for i in range(26):
        r = 620 - i * 22
        if r <= 0:
            break
        shade = tuple(int(BG[j] + (MINT[j] - BG[j]) * (0.012 * (26 - i) / 26)) for j in range(3))
        gd.ellipse([(W / 2 - r, -260 - r / 3), (W / 2 + r, -260 + r / 3)], fill=shade)
    img = Image.blend(img, glow, 0.9)
    return img, ImageDraw.Draw(img)


def intro():
    img, d = base()
    centre(d, 250, "PAYPAL AI HACKATHON 2026", font(FB, 26), MINT, 6)
    centre(d, 330, "Globie Keeper", font(FB, 118), WHITE)
    d.rectangle([(W / 2 - 70, 500), (W / 2 + 70, 505)], fill=MINT)
    centre(d, 560, "Honest bill splitting for friend groups", font(FR, 46), GREY)
    centre(d, 640, "AI reads the receipt and the chat, then says who owes what.", font(FR, 34), DIM)
    centre(d, 880, "live demo  ·  keeper.globie.ai", font(FB, 28), MINT, 2)
    img.save("/tmp/devpost-video/card-intro.png")


def outro():
    img, d = base()
    centre(d, 430, "keeper.globie.ai", font(FB, 92), MINT)
    d.rectangle([(W / 2 - 70, 566), (W / 2 + 70, 571)], fill=MINT)
    centre(d, 620, "Group tables  ·  AI receipt reading  ·  Hero board", font(FR, 38), GREY)
    centre(d, 700, "PayPal AI Hackathon 2026", font(FR, 30), DIM)
    img.save("/tmp/devpost-video/card-outro.png")


if __name__ == "__main__":
    intro()
    outro()
    print("cards written")
