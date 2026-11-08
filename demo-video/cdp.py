import json, sys, urllib.request, websocket

KEEPER = "https://keeper.globie.ai/"


def targets():
    return json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/list"))


def keeper_target():
    for t in targets():
        if t.get("type") == "page" and t.get("url", "").startswith(KEEPER):
            return t
    raise SystemExit("keeper page not found")


def conn(t):
    ws = websocket.create_connection(t["webSocketDebuggerUrl"], max_size=None, suppress_origin=True)
    state = {"id": 0}

    def send(method, params=None):
        state["id"] += 1
        ws.send(json.dumps({"id": state["id"], "method": method, "params": params or {}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == state["id"]:
                return msg
    return ws, send


if __name__ == "__main__":
    t = keeper_target()
    ws, send = conn(t)
    send("Page.enable")
    send("Page.bringToFront")
    win = send("Browser.getWindowForTarget", {"targetId": t["id"]})["result"]["windowId"]
    send("Browser.setWindowBounds", {"windowId": win, "bounds": {"windowState": "normal"}})
    import time
    time.sleep(0.8)
    send("Browser.setWindowBounds", {"windowId": win, "bounds": {"left": 0, "top": 0, "width": 1644, "height": 1031}})
    time.sleep(0.8)
    print("window", win, "bounds", send("Browser.getWindowBounds", {"windowId": win})["result"])
    print(json.dumps(send("Page.getLayoutMetrics")["result"], indent=1)[:600])
