"""Dump interactive elements on the current page (text + aria-label + rect)."""
import json
import sys
import ui

p = ui.Page()
print("url:", p.url())
els = p.js("""(() => {
  const out = [];
  for (const el of document.querySelectorAll('a,button,[role=button],[role=link],[aria-label]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    out.push({tag: el.tagName, label: el.getAttribute('aria-label'),
              text: (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
              x: Math.round(r.left), y: Math.round(r.top),
              w: Math.round(r.width), h: Math.round(r.height)});
  }
  return out;
})()""", await_promise=False)
for e in els:
    print("%-6s %-28s %-40s %4d,%4d %4dx%-4d" % (e["tag"], e["label"], e["text"], e["x"], e["y"], e["w"], e["h"]))
