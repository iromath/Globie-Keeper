import ui

p = ui.Page()
print("url:", p.url())
print(p.js("""(() => {
  const out = [];
  document.querySelectorAll('*').forEach((e, i) => {
    if (e.scrollHeight > e.clientHeight + 20 && e.clientHeight > 100) {
      const r = e.getBoundingClientRect();
      out.push({i, tag: e.tagName, cls: (e.className || '').toString().slice(0, 60),
                sh: e.scrollHeight, ch: e.clientHeight, st: Math.round(e.scrollTop),
                top: Math.round(r.top), h: Math.round(r.height)});
    }
  });
  return out;
})()"""))
