# Builds the Chinese side of Spotiky codes from the hanzi package's data files:
#   zh-pool.txt    characters codes may use: China's 3,500 level-1 common characters
#                  (2013 table), minus a few rude or grim ones
#   zh-shapes.json look-alike families: char -> family key. Two codes that differ only by
#                  look-alike swaps (白光 / 自光) count as the same code, so only one can exist
#   zh-block.json  pairs that must never be a code (slang, rude, unlucky, political)
#   zh-words.json  common two-character words (CC-CEDICT, by subtitle frequency) -> short
#                  gloss, so the page can say when a code is also a real word
import json, re, sys
from pathlib import Path

DATA, OUT = Path(sys.argv[1]), Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

level1 = []
for line in (DATA / "tongyong-guifan-2013.txt").read_text(encoding="utf-8").splitlines():
    if line.startswith("#") or not line.strip():
        continue
    ch, num = line.split("\t")[:2]
    if int(num) <= 3500:
        level1.append(ch)

BLOCK_CHARS = set("屌屄肏屎尿粪屁妓婊嫖淫骚贱逼鸡鸭腚睾尸孬")
pool = [c for c in level1 if c not in BLOCK_CHARS]
pool_set = set(pool)

# Characters people mix up when reading or retyping a code. Overlapping families merge.
FAMILIES = [
    "己已巳", "未末", "土士", "日曰", "人入八", "大太犬", "天夫夭", "王玉主", "刀力", "千干于",
    "戊戌戍戎", "免兔", "鸟乌", "白自", "贝见", "由甲申田", "午牛", "今令", "折拆析", "侯候",
    "失矢", "拔拨", "辨辩辫", "壁璧", "暑署", "崇祟", "狠很", "幻幼", "洒酒", "历厉", "徒徙",
    "弛驰", "晴睛", "盲肓", "冶治",
]
parent = {}
def find(c):
    while parent.setdefault(c, c) != c:
        c = parent[c]
    return c
for fam in FAMILIES:
    members = [c for c in fam if c in pool_set]
    for c in members[1:]:
        parent[find(c)] = find(members[0])
shapes = {c: find(c) for c in parent if c in pool_set and any(find(o) == find(c) and o != c for o in parent)}

BLOCK_WORDS = [
    "傻逼", "牛逼", "装逼", "我操", "卧槽", "王八", "二逼", "绿帽", "鸡巴", "婊子", "去死", "该死", "找死",
    "死人", "送终", "送钟", "分梨", "妈的", "他妈", "你妈", "滚蛋", "混蛋", "笨蛋", "蠢货", "废物", "垃圾",
    "屌丝", "屁股", "放屁", "狗屎", "畜生", "贱人", "骚货", "小三", "二奶", "奶子", "出轨", "上床", "做爱",
    "性交", "强奸", "自杀", "毒品", "吸毒", "杀人", "六四", "法轮", "台独", "藏独", "疆独", "港独",
]

# Word frequency from film/TV subtitles, so the list holds words people actually know
wfreq = {}
for line in (DATA / "SUBTLEX-CH-WF").read_bytes().decode("gbk", errors="ignore").splitlines()[3:]:
    parts = line.split("\t")
    if len(parts) > 1 and parts[1].isdigit() and len(parts[0]) == 2:
        wfreq[parts[0]] = int(parts[1])

words = {}
for line in (DATA / "cedict_ts.u8.js").read_text(encoding="utf-8").splitlines():
    m = re.match(r"^\S+ (\S+) \[[^\]]*\] /(.+)/\s*$", line)
    if not m:
        continue
    simp, glosses = m.group(1), m.group(2).split("/")
    if len(simp) != 2 or not all(c in pool_set for c in simp) or wfreq.get(simp, 0) < 20:
        continue
    gloss = next((g for g in glosses if not g.startswith(("CL:", "variant of", "old variant", "surname", "see ", "abbr. for"))), glosses[0])
    gloss = re.sub(r"\s*\(.*?\)", "", gloss).strip()[:40]
    if not gloss:
        continue
    # A word with two dictionary entries (东西: east and west / thing) keeps both senses
    if simp not in words:
        words[simp] = gloss
    elif ";" not in words[simp] and gloss != words[simp]:
        words[simp] = f"{words[simp]}; {gloss}"

(OUT / "zh-pool.txt").write_text("".join(pool), encoding="utf-8")
(OUT / "zh-shapes.json").write_text(json.dumps(shapes, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
(OUT / "zh-block.json").write_text(json.dumps(sorted(set(BLOCK_WORDS)), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
(OUT / "zh-words.json").write_text(json.dumps(words, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print("pool:", len(pool), "| look-alike characters:", len(shapes), "| blocked words:", len(set(BLOCK_WORDS)), "| common words:", len(words))
for f in ("zh-pool.txt", "zh-shapes.json", "zh-block.json", "zh-words.json"):
    print(f"  {f}: {(OUT / f).stat().st_size:,} bytes")
print("families:", " ".join(sorted({"".join(sorted(c for c in shapes if shapes[c] == k)) for k in set(shapes.values())})))
print("sample:", {k: words.get(k) for k in ["夜光", "开心", "东西", "小心", "山海", "星光", "心火", "白光", "晴天"]})
