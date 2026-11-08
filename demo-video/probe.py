"""Grab one x11grab frame of the whole :20 screen plus a CDP screenshot, then calibrate."""
import base64
import json
import subprocess
import urllib.request
import websocket

full = "/tmp/devpost-video/probe-full.png"
cdp_png = "/tmp/devpost-video/probe-cdp.png"

subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "x11grab", "-draw_mouse", "0", "-video_size", "1920x1080",
                "-framerate", "1", "-i", ":20", "-frames:v", "1", full], check=True)

targets = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/list"))
t = next(x for x in targets if x.get("type") == "page" and x.get("url", "").startswith("https://keeper.globie.ai/"))
ws = websocket.create_connection(t["webSocketDebuggerUrl"], max_size=None, suppress_origin=True)
ws.send(json.dumps({"id": 1, "method": "Page.captureScreenshot", "params": {"format": "png"}}))
while True:
    msg = json.loads(ws.recv())
    if msg.get("id") == 1:
        break
open(cdp_png, "wb").write(base64.b64decode(msg["result"]["data"]))
print("wrote", full, cdp_png)

import PIL.Image as I
f = I.open(full).convert("L")
c = I.open(cdp_png).convert("L")
fw, fh = f.size
cw, ch = c.size
print("full", f.size, "cdp", c.size)

fr = list(f.resize((1, fh), I.BOX).getdata())
cr = list(c.resize((1, ch), I.BOX).getdata())
best = (1e9, -1)
for off in range(0, fh - ch + 1):
    err = sum(abs(fr[y + off] - cr[y]) for y in range(0, ch, 3)) / (ch / 3)
    if err < best[0]:
        best = (err, off)
print("row offset", best)
oy = best[1]

fc = list(f.crop((0, oy, fw, oy + ch)).resize((fw, 1), I.BOX).getdata())
cc = list(c.resize((cw, 1), I.BOX).getdata())
bestc = (1e9, -1)
for off in range(0, fw - cw + 1):
    err = sum(abs(fc[x + off] - cc[x]) for x in range(0, cw, 3)) / (cw / 3)
    if err < bestc[0]:
        bestc = (err, off)
print("col offset", bestc)
print("CONTENT_ORIGIN", bestc[1], oy, "SIZE", cw, ch)
