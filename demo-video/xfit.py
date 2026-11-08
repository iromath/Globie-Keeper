"""Position/resize the single Chrome toplevel on the recording display (:31)."""
import sys

from Xlib import X, display

DISP = sys.argv[1] if len(sys.argv) > 1 else ":31"
W = int(sys.argv[2]) if len(sys.argv) > 2 else 1600
H = int(sys.argv[3]) if len(sys.argv) > 3 else 900

d = display.Display(DISP)
root = d.screen().root

chrome = None
for w in root.query_tree().children:
    try:
        cls = " ".join(w.get_wm_class() or ()).lower()
    except Exception:
        continue
    if "chrome" in cls:
        g = w.get_geometry()
        if g.width > 200 and g.height > 200:
            chrome = w

if chrome is None:
    raise SystemExit("no chrome window on " + DISP)

g = chrome.get_geometry()
print("before:", g.width, "x", g.height, "at", g.x, g.y)

chrome.configure(x=0, y=0, width=W, height=H)
d.sync()

g = chrome.get_geometry()
print("after :", g.width, "x", g.height, "at", g.x, g.y)
