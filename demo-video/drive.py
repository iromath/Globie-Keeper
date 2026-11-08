"""Drive a real-mouse walkthrough of keeper.globie.ai and record the screen with x11grab."""
import json
import os
import subprocess
import sys
import time

import ui
import xctl

OX, OY = ui.ORIGIN
OUT = "/tmp/devpost-video/raw.mp4"
W, H = 1600, 900

p = ui.Page()
T0 = time.time()
MARKS = []


class Rec:
    """ffmpeg x11grab segmented recorder; restarts itself if the X cursor fetch fails."""

    def __init__(self):
        self.parts = []
        self.n = 0
        self.proc = None
        self.path = None
        self.t0 = 0.0
        self.quick_fails = 0

    def _cmd(self, path):
        return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "x11grab", "-draw_mouse", "1",
                "-video_size", "%dx%d" % (W, H), "-framerate", "30",
                "-i", ":31+%d,%d" % (OX, OY),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                "-pix_fmt", "yuv420p", path]

    def start(self):
        self.path = "/tmp/devpost-video/seg%02d.mp4" % self.n
        self.n += 1
        self.proc = subprocess.Popen(self._cmd(self.path), stdin=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL)
        self.t0 = time.time()

    def close_part(self):
        if not self.proc:
            return
        if self.proc.poll() is None:
            try:
                self.proc.stdin.write(b"q")
                self.proc.stdin.flush()
            except BrokenPipeError:
                pass
        try:
            self.proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.parts.append({"path": self.path, "start": self.t0, "end": time.time()})
        self.proc = None

    def ensure(self):
        """Restart the recorder if ffmpeg died (XFixes cursor race)."""
        if self.proc and self.proc.poll() is not None:
            lived = time.time() - self.t0
            self.close_part()
            if lived < 1.0:
                self.quick_fails += 1
                if self.quick_fails >= 3:
                    raise SystemExit("ffmpeg keeps exiting immediately (screen size wrong?)")
            else:
                self.quick_fails = 0
            print("  [rec] ffmpeg died, restarting", flush=True)
            self.start()


REC = Rec()


def guard():
    """Keep the x11grab process alive (XFixes cursor race)."""
    REC.ensure()


xctl.TICK = guard


def mark(name):
    t = time.time() - T0
    MARKS.append({"name": name, "t": round(t, 2)})
    print("[%6.2f] %s" % (t, name), flush=True)


def pause(s):
    end = time.time() + s
    while True:
        guard()
        left = end - time.time()
        if left <= 0:
            return
        time.sleep(min(0.1, left))


def scroll_to(top):
    p.js("""(() => { const c = [...document.querySelectorAll('*')]
        .filter(e => e.scrollHeight > e.clientHeight + 20 && e.clientHeight > 200)[0];
        if (c) c.scrollTo({top: %d, behavior: 'smooth'}); })()""" % top)


def scroll_by(d):
    p.js("""(() => { const c = [...document.querySelectorAll('*')]
        .filter(e => e.scrollHeight > e.clientHeight + 20 && e.clientHeight > 200)[0];
        if (c) c.scrollBy({top: %d, behavior: 'smooth'}); })()""" % d)


def hover(loc, ms=600):
    if not loc:
        raise SystemExit("hover target missing")
    xctl.move(OX + loc["x"], OY + loc["y"], ms)


def tap(loc, ms=450, settle=1.2, label=""):
    if not loc:
        raise SystemExit("click target missing: " + label)
    xctl.click(OX + loc["x"], OY + loc["y"], ms)
    time.sleep(settle)


def find_label(*labels, scroll_step=0, tries=10):
    for _ in range(tries):
        for lb in labels:
            loc = p.by_label(lb)
            if loc:
                return loc
        if not scroll_step:
            return None
        scroll_by(scroll_step)
        time.sleep(0.5)
    return None


def home():
    if p.url().rstrip("/") == "https://keeper.globie.ai":
        return
    p.send("Page.navigate", {"url": "https://keeper.globie.ai/"})
    p.wait_url("keeper.globie.ai/", 15)
    time.sleep(3.0)


def on_group_page():
    u = p.url()
    return "/groups/" in u and "billId" not in u


def wait_group(tries=120):
    for _ in range(tries):
        if on_group_page():
            return
        time.sleep(0.1)
    raise SystemExit("did not get back to the group page: " + p.url())


def main():
    home()
    pause(1.0)
    scroll_to(0)
    time.sleep(0.5)
    print("start url:", p.url())

    if not os.environ.get("DRY"):
        sc = xctl.d.screen()
        if (sc.width_in_pixels, sc.height_in_pixels) != (W, H):
            raise SystemExit("screen is %dx%d, expected %dx%d"
                             % (sc.width_in_pixels, sc.height_in_pixels, W, H))
        REC.start()
        time.sleep(1.5)
        mark("rec-ffmpeg")
    REC0 = time.time()
    mark("rec-start")

    # ---- 1. Home -------------------------------------------------------
    xctl.move(OX + 300, OY + 420, 400)
    pause(1.2)
    mark("home-idle")
    card = find_label("Open Volunteer Dinner")
    hover(card, 900)
    pause(0.8)
    mark("home-hover")
    tap(card, 450, 0.0, "card")
    p.wait_url("/groups/", 10)
    pause(1.4)
    mark("group")

    # ---- 2. Group: invite + agreement --------------------------------
    hover(find_label("Share invite"), 700)
    pause(1.0)
    pause(1.2)
    mark("group-invite")
    scroll_by(420)
    pause(2.6)
    mark("group-chat")
    scroll_by(430)
    pause(1.2)
    bill_btn = find_label("Open the bill")
    hover(bill_btn, 700)
    pause(0.7)
    mark("bill-hover")
    tap(bill_btn, 450, 0.0, "open bill")
    p.wait_url("billId=", 10)
    pause(1.8)
    mark("bill")

    # ---- 3. Bill: AI reading ----------------------------------------
    hover(p.by_text("Who had what") or p.by_text("Collecting"), 900)
    pause(1.2)
    mark("bill-note")
    scroll_to(0)
    pause(1.4)
    scroll_by(380)
    pause(2.8)
    mark("bill-lines")
    scroll_by(430)
    pause(2.6)
    mark("bill-payee")
    scroll_by(420)
    pause(2.2)
    mark("bill-tip")

    # ---- 4. Hero board ----------------------------------------------
    scroll_to(0)
    pause(1.2)
    tap(find_label("Back"), 450, 1.0, "back")
    wait_group()
    pause(0.8)
    lb = find_label("Leaderboard", scroll_step=300)
    hover(lb, 700)
    pause(0.6)
    tap(lb, 450, 0.0, "leaderboard")
    p.wait_url("leaderboard", 10)
    pause(2.0)
    mark("hero")
    pause(2.6)
    mark("hero-idle")

    # ---- 5. Shares ---------------------------------------------------
    tap(find_label("Back"), 450, 1.0, "back2")
    pause(0.6)
    tap(find_label("Shares"), 450, 1.6, "shares")
    mark("shares")
    pause(3.0)
    scroll_by(300)
    pause(2.0)
    mark("shares-scroll")

    # ---- 6. Back home -----------------------------------------------
    tap(find_label("Home"), 450, 1.4, "home")
    mark("home-end")
    pause(1.6)

    if not os.environ.get("DRY"):
        REC.close_part()
    mark("rec-stop")
    json.dump({"rec0": REC0, "marks": MARKS, "parts": REC.parts},
              open("/tmp/devpost-video/marks.json", "w"), indent=1)
    print("done", OUT)


if __name__ == "__main__":
    main()
