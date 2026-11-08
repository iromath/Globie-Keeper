"""CDP helpers for locating UI elements on the Keeper page (page coords)."""
import json
import time
import urllib.request

import websocket

KEEPER = "https://keeper.globie.ai/"
PORT = 9333
ORIGIN = (0, 0)  # dedicated recording display :31, kiosk window at 0,0

_LOCATE = """(() => {
  const els = %s;
  for (const el of els) {
    if (!el || !el.getBoundingClientRect) continue;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (r.width < 4 || r.height < 4) continue;
    if (cx < 0 || cx > window.innerWidth || cy < 0 || cy > window.innerHeight) continue;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit) continue;
    if (el === hit || el.contains(hit) || hit.contains(el)) {
      return {x: cx, y: cy, w: r.width, h: r.height,
              txt: (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 70)};
    }
  }
  return null;
})()"""


def _targets():
    return json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % PORT))


def target():
    for t in _targets():
        if t.get("type") == "page" and t.get("url", "").startswith(KEEPER):
            return t
    raise SystemExit("keeper page not found")


class Page:
    def __init__(self):
        t = target()
        self.ws = websocket.create_connection(t["webSocketDebuggerUrl"], max_size=None, suppress_origin=True)
        self._id = 0
        self.send("Page.enable")
        self.send("Runtime.enable")

    def send(self, method, params=None):
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self._id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    def js(self, expr, await_promise=False):
        r = self.send("Runtime.evaluate", {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": await_promise,
            "userGesture": True,
        })
        res = r.get("result", {})
        if res.get("subtype") == "error":
            raise RuntimeError(res.get("description"))
        return res.get("value")

    def url(self):
        return self.js("location.href")

    def wait_url(self, sub, timeout=20):
        end = time.time() + timeout
        while time.time() < end:
            if sub in (self.js("location.href") or ""):
                return True
            time.sleep(0.2)
        return False

    def wait(self, js_bool, timeout=20):
        end = time.time() + timeout
        while time.time() < end:
            try:
                if self.js(js_bool):
                    return True
            except RuntimeError:
                pass
            time.sleep(0.2)
        return False

    def locate_els(self, js_els):
        return self.js(_LOCATE % js_els)

    def by_label(self, label):
        q = json.dumps(label)
        return self.locate_els(
            "[...document.querySelectorAll('[aria-label]')].filter(e => e.getAttribute('aria-label') === %s)" % q)

    def by_text(self, text, exact=False):
        q = json.dumps(text)
        cmp_ = "s === t" if exact else "s.includes(t)"
        return self.locate_els("""(() => {
          const t = %s;
          return [...document.querySelectorAll('a,button,[role=button],[role=link],div,span,p,h1,h2,h3')]
            .filter(e => { const s = (e.innerText || '').trim().replace(/\\s+/g, ' '); return %s; })
            .sort((a,b) => (a.getBoundingClientRect().width*a.getBoundingClientRect().height)
                         - (b.getBoundingClientRect().width*b.getBoundingClientRect().height));
        })()""" % (q, cmp_))

    def by_css(self, sel, index=0):
        js = "(() => { const a = [...document.querySelectorAll(%s)]; const e = a[%d]; return e ? [e] : []; })()"
        return self.locate_els(js % (json.dumps(sel), index))
