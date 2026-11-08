import PIL.Image as I

full = I.open("/tmp/devpost-video/x20-probe3.png").convert("L")
cdp = I.open("/tmp/devpost-video/cdp.png").convert("L")
fw, fh = full.size
cw, ch = cdp.size
print("full", full.size, "cdp", cdp.size)


def rowprof(im):
    return list(im.resize((1, im.size[1]), I.BOX).getdata())


fr = rowprof(full)
cr = rowprof(cdp)

best = (1e9, -1)
for off in range(0, fh - ch + 1):
    err = sum(abs(fr[y + off] - cr[y]) for y in range(0, ch, 3)) / (ch / 3)
    if err < best[0]:
        best = (err, off)
print("row offset", best)
oy = best[1]

fc = full.crop((0, oy, fw, oy + ch)).resize((fw, 1), I.BOX)
cc = cdp.resize((cw, 1), I.BOX)
fcp = list(fc.getdata())
ccp = list(cc.getdata())
bestc = (1e9, -1)
for off in range(0, fw - cw + 1):
    err = sum(abs(fcp[x + off] - ccp[x]) for x in range(0, cw, 3)) / (cw / 3)
    if err < bestc[0]:
        bestc = (err, off)
print("col offset", bestc)
ox = bestc[1]
print("CONTENT_ORIGIN", ox, oy, "SIZE", cw, ch)
full.crop((ox, oy, ox + cw, oy + ch)).save("/tmp/devpost-video/crop-check.png")
