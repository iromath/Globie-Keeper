"""Real X11 input on the recording display (XTEST), for authentic screencast input."""
import time

from Xlib import X, display
from Xlib.ext import xtest

d = display.Display(":31")
root = d.screen().root

TICK = None


def _tick():
    """Let the recorder watchdog run during long pointer moves."""
    if TICK:
        TICK()


def warp(x, y):
    xtest.fake_input(d, X.MotionNotify, x=int(x), y=int(y))
    d.sync()


def move(x, y, ms=350, steps=14):
    """Glide the pointer from wherever it is to (x, y)."""
    p = root.query_pointer()
    x0, y0 = p.root_x, p.root_y
    for i in range(1, steps + 1):
        t = i / steps
        e = t * t * (3 - 2 * t)  # smoothstep
        warp(x0 + (x - x0) * e, y0 + (y - y0) * e)
        _tick()
        time.sleep(ms / 1000.0 / steps)
    warp(x, y)


def click(x=None, y=None, ms=350, button=1):
    if x is not None:
        move(x, y, ms)
    time.sleep(0.08)
    xtest.fake_input(d, X.ButtonPress, button)
    d.sync()
    time.sleep(0.07)
    xtest.fake_input(d, X.ButtonRelease, button)
    d.sync()


def scroll(x, y, clicks, up=False, pause=0.06):
    move(x, y, 300)
    for _ in range(clicks):
        xtest.fake_input(d, X.ButtonPress, 4 if up else 5)
        d.sync()
        xtest.fake_input(d, X.ButtonRelease, 4 if up else 5)
        d.sync()
        time.sleep(pause)


def pos():
    p = root.query_pointer()
    return p.root_x, p.root_y
