#!/usr/bin/env python3
"""
Generate the application icon.

Drawn programmatically so it is reproducible and reviewable.

DESIGN NOTES (revision 2)
-------------------------
The first version had a large gold "play" disc on top of the candles. Review
flagged three real problems, all fixed here:

  1. A big play glyph reads as "video player", not "trading". Removed entirely.
  2. It covered the fourth candle's wick, which a trader reads as a broken chart.
     Nothing overlaps the bars now.
  3. Wicks were ~2px at 512px, so they vanished below ~64px and the icon stopped
     looking like candlesticks. Wicks are now 5% of canvas width (26px), which
     survives 16px.
  4. The grid was 10 same-weight lines competing with the data. Reduced to 3 very
     low-contrast lines that only suggest a plot area.

Replay identity is carried by the LAST candle being gold — the "current bar" you
are replaying — instead of by a button. That is integrated with the data rather
than pasted over it, and it is what makes the icon specific rather than generic
"finance app".

Outputs:
  build/icon.png    512x512  (electron-builder derives .icns from this)
  build/icon.ico    multi-size, for Windows
"""
from PIL import Image, ImageDraw
import os

SIZE = 512
BG = (19, 23, 34)          # #131722, the app's chart background
BG_DEEP = (13, 17, 26)
GOLD = (240, 185, 11)      # #f0b90b, accent / "current bar"
TEAL = (38, 166, 154)      # #26a69a, bullish
RED = (232, 87, 79)        # #e8574f, bearish (lifted for lightness contrast)
GRID = (34, 38, 49)        # #222631, barely-there plot lines

# 5% of the canvas: stays visible at 16px. Below ~4% the wick aliases away.
WICK_W = 26
BODY_W = 74


def make_icon() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # --- rounded panel with a subtle vertical gradient ----------------------
    panel = Image.new("RGBA", (SIZE, SIZE))
    pd = ImageDraw.Draw(panel)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        c = tuple(int(BG[i] + (BG_DEEP[i] - BG[i]) * t) for i in range(3))
        pd.line([(0, y), (SIZE, y)], fill=c + (255,))

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, SIZE - 1, SIZE - 1], radius=88, fill=255
    )
    img.paste(panel, (0, 0), mask)

    d = ImageDraw.Draw(img)

    # --- plot area suggestion: 3 horizontal lines only ---------------------
    # Few and faint on purpose: at icon sizes any more becomes noise that competes
    # with the candles. Inset so an Android adaptive-icon crop cannot clip them.
    for y in (162, 276, 390):
        d.line([(84, y), (SIZE - 84, y)], fill=GRID + (255,), width=3)

    # --- candles -----------------------------------------------------------
    # COMPRESSED series: the three history bars nearly touch (72px pitch on a 74px
    # body) so they read as one continuous price ribbon rather than a bar chart,
    # with ONE deliberate gap before the live bar. The gap is the signal.
    # The group is shifted left so the mass is centred instead of right-heavy.
    # (cx, body_top, body_bottom, wick_top, wick_bottom, colour)
    candles = [
        (112, 302, 372, 264, 406, RED),   # lifted off the bottom gridline
        (184, 236, 322, 200, 356, TEAL),
        (256, 252, 338, 216, 380, RED),
        (360, 132, 238, 100, 282, GOLD),  # live bar, one gap to the right
    ]

    for cx, top, bottom, wt, wb, colour in candles:
        # wick first, then body on top, so the join is seamless
        d.line([(cx, wt), (cx, wb)], fill=colour + (255,), width=WICK_W)
        d.rounded_rectangle(
            [cx - BODY_W // 2, top, cx + BODY_W // 2, bottom],
            radius=12,
            fill=colour + (255,),
        )

    # --- live price line ---------------------------------------------------
    # A horizontal line at the live bar's close running to the right edge is the
    # convention TradingView and Binance actually use for "this is the current
    # price". Without it the gold bar only *implies* live; with it the icon states
    # it, and it still reads at 24px because it is a straight 6px stroke.
    liveClose = 200
    d.line([(360, liveClose), (SIZE - 74, liveClose)], fill=GOLD + (190,), width=6)
    # a small tag at the end, like the price axis label
    d.rounded_rectangle(
        [SIZE - 74, liveClose - 17, SIZE - 30, liveClose + 17],
        radius=8,
        fill=GOLD + (255,),
    )

    return img


def main() -> None:
    os.makedirs("build", exist_ok=True)
    icon = make_icon()

    png = "build/icon.png"
    icon.save(png, "PNG")
    print(f"wrote {png} ({os.path.getsize(png)} bytes)")

    ico = "build/icon.ico"
    icon.save(
        ico, format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"wrote {ico} ({os.path.getsize(ico)} bytes)")

    # Render the sizes that actually matter and check they are still legible.
    # Upscaled 4x with NEAREST so the pixel grid is inspectable rather than
    # smoothed into something that hides aliasing.
    for s in (16, 32, 64):
        small = icon.resize((s, s), Image.LANCZOS)
        small.resize((s * 8, s * 8), Image.NEAREST).save(f"/tmp/icon-check-{s}.png")
        print(f"  /tmp/icon-check-{s}.png  ({s}px, upscaled 8x for inspection)")


if __name__ == "__main__":
    main()
