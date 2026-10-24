# Builds ui/stats.json: the in-game stats of every named part, from crosscalc.net's item table
# (read 2026-09-30 into cc_items.json; item types from its type pages in cc_types.json), joined to
# the models through the in-game names in ui/names.json.
#   python tools/stats/make_stats.py
# Refuses to write when a part's kind doesn't fit where its model lives (a weapon under chassis/, a
# wheel outside it ...): that is a wrong name in names.json, to be fixed there.
import collections
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
UI = HERE.parent.parent / "ui"
cc = json.loads((HERE / "cc_items.json").read_text(encoding="utf-8"))
heads = cc["heads"]
types = json.loads((HERE / "cc_types.json").read_text(encoding="utf-8"))
names = json.loads((UI / "names.json").read_text(encoding="utf-8"))["parts"]

WEAPONS = {"Machine gun", "Shotgun", "Autocannon", "Cannon", "Rocket launcher", "Grenade launcher", "Energy weapon", "Crossbow",
           "Melee weapon", "Flame weapon", "Cryogenic weapon", "Minelayer", "Drone", "Uncategorized weapon"}
MODULES = {"Special module", "Power node", "Stealth", "Recharge booster", "Radar", "Scope", "Spread stabilizer", "Engine", "Booster",
           "Cooler", "Ammunition", "Structure fortifiers"}
MOVEMENT = {"Light wheel", "Medium wheel", "Heavy wheel", "Frontal wheel", "Rolling-based", "Auger", "Track", "Air cushion", "Hover",
            "Mechanical leg", "Robotic leg", "Rotor"}
CABINS = {"Light cabin", "Medium cabin", "Heavy cabin"}
# An item's rarity, by the colour crosscalc gives its name (the game's own colours: white common, blue
# rare, teal special, purple epic, orange legendary, red relic; grey the plain parts)
RARITY = {"#FFFFFF": "common", "#999999": "base", "#379BFE": "rare", "#47C8C8": "special", "#CA40FF": "epic", "#FFA217": "legendary",
          "#FF6600": "relic"}

bad_numbers = []


def num(v, where):
    """A table cell as a number: "+1,000", "2 100.00", "1,5", "−12 %" all read right; "", "—" are none."""
    if v is None:
        return None
    s = str(v).strip().replace("−", "-").replace(" ", " ").replace("%", "").replace("+", "").strip()
    if s in ("", "-", "—", "–"):
        return None
    s = s.replace(" ", "")
    if re.fullmatch(r"-?\d{1,3}(,\d{3})+(\.\d+)?", s):  # thousands separators
        s = s.replace(",", "")
    elif re.fullmatch(r"-?\d+,\d+", s):  # decimal comma
        s = s.replace(",", ".")
    try:
        f = float(s)
    except ValueError:
        bad_numbers.append(f"{where}: {v!r}")
        return None
    return int(f) if f == int(f) else f


def norm(s):
    s = s.lower().replace("“", '"').replace("”", '"').replace("«", '"').replace("»", '"').replace("’", "'")
    s = s.replace("–", "-").replace("—", "-").replace("×", "x")
    return re.sub(r"\s+", " ", s).strip()


items = {}
by_name = {}
for r in cc["rows"]:
    t = types.get(str(r["id"]))
    c = {heads[i]: r["cells"][i] for i in range(len(heads))}
    kind = ("cabin" if t in CABINS else "weapon" if t in WEAPONS else "generator" if t == "Generator" else
            "module" if t in MODULES else "movement" if t in MOVEMENT else "other")
    it = {"type": t or "", "kind": kind}
    rarity = RARITY.get((r.get("color") or "").upper())
    if rarity:
        it["rarity"] = rarity
    for key, col in [("hp", "health"), ("mass", "physical_mass"), ("power", "power"), ("cost", "required_power"),
                     ("tonnage", "tonnage"), ("massLimit", "crit_mass"), ("speed", "engine_max_speed"), ("enginePower", "engine_power"),
                     ("tonnageAdd", "tonnage_add"), ("massLimitAdd", "crit_mass_add"), ("speedMul", "engine_max_speed_mul"),
                     ("powerMul", "engine_power_mul"), ("speedLimit", "speed_limit"), ("speedLimitMul", "speed_limit_mul"),
                     ("reload", "shooting_cooldown")]:  # (a weapon's: seconds from one shot to the next; a pod's salvo)
        v = num(c.get(col), f"{r['name']} {col}")
        if v is not None:
            it[key] = v
    items[r["name"]] = it
    by_name[norm(r["name"])] = r["name"]

# Name forms in names.json: "Base", "Base · skin", "Base (old model)", "Base · Lucifer kit", "Base · trap"
# (a piece), "Base · barrel, Hyperborea skin" (a piece in a skin). The part after " · " names the
# whole item only when every comma-separated piece of it is a look (a skin, a kit, decorated ...).
LOOK = re.compile(r"^(skin|decorated|variant|ravager-infested|no logo|brawl version|[\w'’.\- ]+ skin|[\w'’.\- ]+ kit( \(.*\))?)$", re.I)
PAREN_WHOLE = {"old model", "customized", "before 2021", "old look", "old copy", "no logo", "green lights", "red lights"}
paths, missing, pieces, gone = {}, [], [], []
for path, v in names.items():
    n = v["name"]
    base, suffix, paren = n, None, None
    m = re.match(r"^(.*?) · (.+)$", base)
    if m:
        base, suffix = m.group(1), m.group(2)
    m = re.match(r"^(.*?) \(([^)]*)\)$", base)
    if m:
        base, paren = m.group(1), m.group(2)
    if paren == "not in today's game":
        gone.append(n)
        continue
    if suffix and not all(LOOK.match(x.strip()) for x in suffix.split(",")):
        pieces.append(n)
        continue
    if paren and paren not in PAREN_WHOLE:
        pieces.append(n)
        continue
    cands = ([base + " (cust.)"] if paren == "customized" else []) + [base]
    # A corner frame named without its side (left / right not yet told apart) has the same stats
    # as either: take the left one's.
    cands.append(re.sub(r"\bframe (?=\d)", "frame left ", base))
    hit = next((by_name[norm(c)] for c in cands if norm(c) in by_name), None)
    if not hit:
        missing.append(n)
        continue
    paths[path] = hit

# Items the type pages did not list: tell the kind from the stats (and where the model lives).
for name in {h for h in paths.values()}:
    it = items[name]
    if it["kind"] != "other":
        continue
    first = next(p for p, h in paths.items() if h == name)
    if "tonnage" in it and "massLimit" in it:
        it["kind"], it["type"] = "cabin", "Cabin"
    elif "power" in it:
        it["kind"], it["type"] = "generator", "Generator"
    elif "tonnageAdd" in it or "speedLimit" in it or "powerMul" in it:
        it["kind"], it["type"] = "movement", "Movement part"
    elif re.search(r"\bframe\b", name, re.I):
        it["kind"], it["type"] = "frame", "Frame"
    elif first.startswith("models/weapons/"):
        it["kind"], it["type"] = "weapon", "Weapon"
    elif "/modules/" in first:
        it["kind"], it["type"] = "module", "Module"
    else:
        it["kind"], it["type"] = "structure", it["type"] or "Structure"

# A steering wheel ("Array ST") is the same model as the plain one ("Array"): the plain item points to it.
used = {h for h in paths.values()}
for name in list(used):
    st = by_name.get(norm(name + " ST"))
    if st and items[name]["kind"] == "movement":
        items[name]["st"] = st
        items[st]["kind"] = "movement"
        items[st]["type"] = items[st]["type"] or items[name]["type"]
        used.add(st)


# Sanity: an item's kind has to fit the folder its model lives in.
def misplaced(path, kind):
    if kind == "weapon" and ("/chassis/" in path or "/cabins/" in path):
        return "a weapon's name on a chassis or cabin model"
    if kind == "movement" and "/chassis/" not in path:
        return "a movement part's name on a model outside chassis/"
    if kind == "cabin" and "/cabins/" not in path:
        return "a cabin's name on a model outside cabins/"
    return None


wrong = [f"{p}: \"{h}\" ({items[h]['kind']}): {why}" for p, h in paths.items() if (why := misplaced(p, items[h]["kind"]))]

# Parts crosscalc does not list (decor, armour renamed since): their durability and mass from the
# game's 2018-19 item data (gamedata_parts.json, made once from CrossoutMarket's old item files), marked "old".
# Only where the part still has that item's name (otherwise the numbers may be another item's).
old_file = HERE / "gamedata_parts.json"
old = json.loads(old_file.read_text(encoding="utf-8"))["parts"] if old_file.exists() else {}
old_used = 0
for path, v in names.items():
    o = old.get(path)
    if path in paths or not o or o["name"] != v["name"] or (o.get("hp") is None and o.get("mass") is None):
        continue
    key = f"{o['name']} [{o['item']}]"  # (unique: two old items may share a name)
    it = {"type": "Decor" if o["kind"] == "decor" else "Structure", "kind": o["kind"], "old": True}
    for k in ("hp", "mass"):
        if o.get(k) is not None:
            it[k] = o[k]
    items[key] = it
    paths[path] = key
    used.add(key)
    old_used += 1
for w in bad_numbers:
    print("unreadable number:", w)
if wrong:
    print("Not written: names that don't fit their models (fix them in ui/names.json):")
    for w in wrong:
        print("  " + w)
    sys.exit(1)

used = sorted(used)
out = {
    "source": "crosscalc.net item table (current game values), read 2026-09-30",
    "items": {k: items[k] for k in used},
    "paths": dict(sorted(paths.items())),
}
(UI / "stats.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
without = [n for p, n in ((p, v["name"]) for p, v in names.items()) if n in missing and p not in paths]
print(f"{len(paths)} paths -> {len(used)} items ({old_used} with the old game data's numbers); {len(pieces)} pieces skipped, {len(gone)} gone, {len(without)} named parts without numbers")
print("WITHOUT NUMBERS:", without)
print(collections.Counter(items[h]["kind"] for h in paths.values()))
