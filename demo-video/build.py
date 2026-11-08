"""Assemble the final demo video: intro card + captioned screencast + outro card.

Caption windows come from marks.json so they stay glued to the action even if the
take runs slower than the dry run. The screencast is scaled to 1728x972 and padded
into a 1920x1080 frame, which leaves a 108 px lower-third strip for captions that
never covers app content.
"""
import json
import subprocess
import sys

D = "/tmp/devpost-video"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
BG = "0x070B10"

W, H = 1920, 1080
APP_W, APP_H = 1728, 972
APP_X = (W - APP_W) // 2
STRIP_Y = APP_H
TEXT_Y = 1006

CAPS = [
    (None, "home-hover", "Home — your tables, and what you owe"),
    ("home-hover", "group", "Open a table for the dinner"),
    ("group", "group-chat", "Invite by code, link or QR"),
    ("group-chat", "bill-hover", "The group chat already knows the plan"),
    ("bill-hover", "bill", "Open the bill"),
    ("bill", "bill-note", "Globie reads the receipt and the group chat"),
    ("bill-note", "bill-lines", "Total, currency notes, item prices — all from the photo"),
    ("bill-lines", "bill-payee", "Who had what, split line by line"),
    ("bill-payee", "bill-tip", "Every line mapped to the people who ate it"),
    ("bill-tip", "bill-tip+1.8", "Pay your share — the PayPal order names the payee"),
    ("bill-tip+1.8", "hero", "Back at the table — open the hero board"),
    ("hero", "shares", "Hero board: who fronted the money"),
    ("shares", "shares-scroll", "Shares: everything you owe, in one place"),
    ("shares-scroll", None, "Back to your tables"),
]


def at(t, spec):
    """Resolve a mark name, optionally with a +N seconds offset."""
    name, _, delta = spec.partition("+")
    return t[name] + (float(delta) if delta else 0.0)


def windows():
    m = json.load(open(D + "/marks.json"))
    t = {x["name"]: x["t"] for x in m["marks"]}
    off = m["rec0"] - m["parts"][0]["start"]
    end = t["rec-stop"] - off
    out = []
    for a, b, text in CAPS:
        s = 0.8 if a is None else at(t, a) - off
        e = end if b is None else at(t, b) - off
        if e <= s:
            continue
        out.append((s, e, text))
    print("off %.2fs, body %.2fs" % (off, end))
    for s, e, text in out:
        print("  %6.2f %6.2f  %s" % (s, e, text))
    return out


def cap_filters(win):
    out = []
    for a, b, text in win:
        safe = text.replace("\\", "\\\\").replace("'", "\u2019").replace(":", "\\:")
        out.append(
            "drawtext=fontfile=%s:text='%s':fontcolor=0xE9F6EE:fontsize=34:"
            "x=(w-text_w)/2:y=%d:enable='between(t,%.2f,%.2f)'"
            % (FONT, safe, TEXT_Y, a, b))
    return ",".join(out)


def run(args):
    print(" ".join(args)[:160], "...")
    subprocess.run(args, check=True)


def main():
    win = windows()

    # 1. intro
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-loop", "1", "-t", "3.2", "-i", D + "/card-intro.png",
         "-vf", "scale=1920:1080:flags=lanczos,format=yuv420p,"
                "fade=t=in:st=0:d=0.6,fade=t=out:st=2.6:d=0.6",
         "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "16",
         "-pix_fmt", "yuv420p", D + "/p1-intro.mp4"])

    # 2. captioned screencast: 1600x900 -> 1728x972 inside a 1920x1080 canvas
    vf = ",".join([
        "scale=%d:%d:flags=lanczos" % (APP_W, APP_H),
        "pad=%d:%d:%d:0:color=%s" % (W, H, APP_X, BG),
        "drawbox=x=%d:y=%d:w=%d:h=1:color=0x9FB4C2@0.16:t=fill" % (APP_X, STRIP_Y, APP_W),
        cap_filters(win),
        "format=yuv420p",
    ])
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", D + "/seg00.mp4", "-vf", vf,
         "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
         "-pix_fmt", "yuv420p", D + "/p2-body.mp4"])

    # 3. outro
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-loop", "1", "-t", "3.6", "-i", D + "/card-outro.png",
         "-vf", "scale=1920:1080:flags=lanczos,format=yuv420p,"
                "fade=t=in:st=0:d=0.6,fade=t=out:st=3.0:d=0.6",
         "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "16",
         "-pix_fmt", "yuv420p", D + "/p3-outro.mp4"])

    # 4. concat
    with open(D + "/concat.txt", "w") as f:
        for p in ("p1-intro.mp4", "p2-body.mp4", "p3-outro.mp4"):
            f.write("file '%s/%s'\n" % (D, p))
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "concat", "-safe", "0", "-i", D + "/concat.txt",
         "-c:v", "libx264", "-preset", "medium", "-crf", "18",
         "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart",
         D + "/globie-keeper-demo.mp4"])
    print("done")


if __name__ == "__main__":
    sys.exit(main())
