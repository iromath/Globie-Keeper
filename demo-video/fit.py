"""Force the recording Chrome window to an exact 1600x900 page viewport (display :31, port 9333)."""
import json
import sys
import time
import urllib.request

import websocket

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9333
TW, TH = 1600, 900


class B:
    def __init__(self):
        info = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/version" % PORT))
        self.ws = websocket.create_connection(info["webSocketDebuggerUrl"], max_size=None,
                                              suppress_origin=True)
        self.i = 0

    def send(self, m, p=None):
        self.i += 1
        self.ws.send(json.dumps({"id": self.i, "method": m, "params": p or {}}))
        while True:
            r = json.loads(self.ws.recv())
            if r.get("id") == self.i:
                if "error" in r:
                    raise RuntimeError(r["error"])
                return r.get("result", {})


class P:
    def __init__(self):
        ts = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % PORT))
        t = [x for x in ts if x.get("type") == "page" and "keeper" in x.get("url", "")][0]
        self.ws = websocket.create_connection(t["webSocketDebuggerUrl"], max_size=None,
                                              suppress_origin=True)
        self.i = 0

    def send(self, m, p=None):
        self.i += 1
        self.ws.send(json.dumps({"id": self.i, "method": m, "params": p or {}}))
        while True:
            r = json.loads(self.ws.recv())
            if r.get("id") == self.i:
                if "error" in r:
                    raise RuntimeError(r["error"])
                return r.get("result", {})

    def vp(self):
        r = self.send("Runtime.evaluate", {"expression":
                     "window.innerWidth + ',' + window.innerHeight", "returnByValue": True})
        w, h = r["result"]["value"].split(",")
        return int(w), int(h)


def main():
    b = B()
    win = b.send("Browser.getWindowForTarget", {})["windowId"]
    b.send("Browser.setWindowBounds", {"windowId": win, "bounds": {"windowState": "normal"}})
    time.sleep(0.6)
    cur = b.send("Browser.getWindowBounds", {"windowId": win})["bounds"]
    vw, vh = P().vp()
    print("window", win, "bounds", cur, "viewport", (vw, vh))
    dx = cur["width"] - vw
    dy = cur["height"] - vh
    target = {"left": 0, "top": 0, "width": TW + dx, "height": TH + dy}
    b.send("Browser.setWindowBounds", {"windowId": win, "bounds": target})
    time.sleep(0.9)
    print("set    ", b.send("Browser.getWindowBounds", {"windowId": win})["bounds"],
          "viewport", P().vp())


if __name__ == "__main__":
    main()
