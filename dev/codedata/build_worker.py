# Fills the Worker template with its character data and writes the deployable Worker file.
import json, sys
from pathlib import Path

HERE = Path(__file__).parent
OUT = Path(sys.argv[1])
t = (HERE / "worker.template.js").read_text(encoding="utf-8")
glyphs = json.loads((HERE / "out/glyphs.json").read_text(encoding="utf-8"))
emoji = json.loads((HERE.parent / "emojiwork/emoji.json").read_text(encoding="utf-8"))
toneable = json.loads((HERE.parent / "emojiwork/toneable.json").read_text(encoding="utf-8"))
# English words and phrases a playlist label can't use (LDNOOBW, CC BY 4.0); phrases are joined with hyphens like labels
bad = set()
for line in (HERE.parent / "dl_badwords/en.txt").read_text(encoding="utf-8").splitlines():
    w = line.strip().lower()
    if w and all(c.isascii() and (c.isalpha() or c == " ") for c in w):
        bad.add("-".join(w.split()))
en_block = sorted(bad)
assert set(toneable) <= {x["e"] for x in emoji}, "every toneable emoji must be in the set"
pool = (HERE / "out/zh-pool.txt").read_text(encoding="utf-8")

def array(rows):
    return "[\n" + ",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in rows) + ",\n]"

fills = {
    "/*GLYPHS*/": array([{"c": g["c"], "name": g["name"], "meaning": g["meaning"]} for g in glyphs]),
    "/*ZH_POOL*/": "\n  " + "\n  + ".join(json.dumps(pool[i:i + 100], ensure_ascii=False) for i in range(0, len(pool), 100)),
    "/*ZH_SHAPES*/": json.dumps(json.loads((HERE / "out/zh-shapes.json").read_text(encoding="utf-8")), ensure_ascii=False),
    "/*ZH_BLOCK*/": json.dumps(json.loads((HERE / "out/zh-block.json").read_text(encoding="utf-8")), ensure_ascii=False),
    "/*EMOJI*/": array(emoji),
    "/*TONEABLE*/": json.dumps("".join(toneable), ensure_ascii=False),
    "/*EN_BLOCK*/": json.dumps(en_block),
}
for key, value in fills.items():
    assert t.count(key) == 1, key
    t = t.replace(key, value)
OUT.write_text(t, encoding="utf-8")
print(f"wrote {OUT} ({len(t.encode()):,} bytes): {len(glyphs)} glyphs, {len(pool)} Chinese characters, {len(emoji)} emoji ({len(toneable)} with skin tones), {len(en_block)} blocked English words")
