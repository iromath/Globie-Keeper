"""Prepare the clean recording display (:31, port 9333): restore session, report geometry."""
import json
import sys
import time
import urllib.request

import websocket

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9333
SESSION = ('{"token":"Hq3Fft4obUMzrnW7MRp5Ug7E1_AK_vqHWv5P33eWSUo",'
           '"userId":"cecc8e65-9a15-4344-955f-d7c4b6e8c480",'
           '"displayName":"Member Globie"}')


def pages():
    return json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % PORT))


def keeper():
    for t in pages():
        if t.get("type") == "page" and "keeper.globie.ai" in t.get("url", ""):
            return t
    for t in pages():
        if t.get("type") == "page":
            return t
    raise SystemExit("no page target on %d" % PORT)


class P:
    def __init__(self):
        self.t = keeper()
        self.ws = websocket.create_connection(self.t["webSocketDebuggerUrl"], max_size=None,
                                              suppress_origin=True)
        self.i = 0
        self.send("Page.enable")
        self.send("Runtime.enable")

    def send(self, m, p=None):
        self.i += 1
        self.ws.send(json.dumps({"id": self.i, "method": m, "params": p or {}}))
        while True:
            r = json.loads(self.ws.recv())
            if r.get("id") == self.i:
                if "error" in r:
                    raise RuntimeError(r["error"])
                return r.get("result", {})

    def js(self, e):
        r = self.send("Runtime.evaluate", {"expression": e, "returnByValue": True,
                                           "userGesture": True})
        res = r.get("result", {})
        if res.get("subtype") == "error":
            raise RuntimeError(res.get("description"))
        return res.get("value")


def main():
    p = P()
    print("url      :", p.url if False else p.js("location.href"))
    print("viewport :", p.js("window.innerWidth + 'x' + window.innerHeight + ' dpr=' + devicePixelRatio"))
    print("screen   :", p.js("screen.width + 'x' + screen.height"))
    print("has ses  :", bool(p.js("!!localStorage.getItem('globie.session')")))
    if not p.js("!!localStorage.getItem('globie.session')"):
        p.js("localStorage.setItem('globie.session', %s); localStorage.setItem('globie.displayCurrency','USD'); 1"
             % json.dumps(SESSION))
        p.send("Page.reload", {"ignoreCache": False})
        time.sleep(4.0)
        print("after reload url:", p.js("location.href"))
        print("logged in      :", p.js("!!localStorage.getItem('globie.session')"))


if __name__ == "__main__":
    main()
