import base64
import json
import os
import time
import urllib.request

import websocket

STOP = "/tmp/devpost-video/stop"
OUT = "/tmp/devpost-video/frames"
os.makedirs(OUT, exist_ok=True)

targets = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/list"))
target = None
for t in targets:
    if t.get("type") == "page" and "keeper.globie.ai" in t.get("url", ""):
        target = t
        break
assert target, "no keeper.globie.ai page found"

ws = websocket.create_connection(
    target["webSocketDebuggerUrl"], max_size=None, suppress_origin=True
)
_id = 0


def send(method, params=None):
    global _id
    _id += 1
    ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _id:
            return msg


send("Page.enable")
manifest = []
n = 0
while not os.path.exists(STOP):
    t0 = time.time()
    res = send(
        "Page.captureScreenshot",
        {"format": "jpeg", "quality": 88, "captureBeyondViewport": False},
    )
    data = res.get("result", {}).get("data")
    if data:
        path = "%s/f%06d.jpg" % (OUT, n)
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(data))
        manifest.append({"file": path, "t": t0})
        n += 1
    time.sleep(0.03)

with open("/tmp/devpost-video/manifest.json", "w") as fh:
    json.dump(manifest, fh)
print("frames:", n)
