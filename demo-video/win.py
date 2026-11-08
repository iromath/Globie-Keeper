"""Find / raise / check the Chrome toplevel on :20 (the display also hosts other windows)."""
from Xlib import X, display

d = display.Display(":20")
root = d.screen().root


def _props(w):
    try:
        cls = w.get_wm_class() or ()
    except Exception:
        cls = ()
    return " ".join(cls).lower()


def chrome_window():
    best = None
    for w in root.query_tree().children:
        try:
            if w.get_attributes().map_state != X.IsViewable:
                continue
        except Exception:
            continue
        if "chrome" in _props(w):
            g = w.get_geometry()
            if g.width > 800 and g.height > 500:
                best = w
    return best


def raise_chrome():
    w = chrome_window()
    if not w:
        return None
    w.configure(stack_mode=X.Above)
    d.sync()
    return w


def topmost():
    """Return the viewable toplevel window covering the screen centre."""
    kids = [w for w in root.query_tree().children]
    for w in reversed(kids):
        try:
            a = w.get_attributes()
            if a.map_state != X.IsViewable:
                continue
            g = w.get_geometry()
            if g.width < 100 or g.height < 100:
                continue
            # translate window origin to root coords
            t = w.translate_coords(root, 0, 0)
            x, y = -t.x, -t.y
            if x <= 960 <= x + g.width and y <= 540 <= y + g.height:
                return w
        except Exception:
            continue
    return None


def topmost_is_chrome():
    w = topmost()
    return bool(w) and "chrome" in _props(w)


if __name__ == "__main__":
    print("chrome:", chrome_window())
    print("topmost:", topmost(), _props(topmost()) if topmost() else None)
    print("is chrome:", topmost_is_chrome())
