#!/usr/bin/env python3
"""Regenerate online/data.json from the game's own items.py and spells.py.

Run from the repository root:  python3 online/tools/export_data.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

import items  # noqa: E402
import spells  # noqa: E402

out = {"items": {}, "spells": {}, "loot": {}, "startingSpells": {}}
for key, item in items.ITEMS.items():
    entry = item.to_dict()
    entry["effects"] = [
        {"type": e.effect_type, "value": e.value, "duration": getattr(e, "duration", 0)}
        for e in getattr(item, "effects", [])
    ]
    out["items"][key] = entry
for key, spell in spells.SPELLS.items():
    entry = spell.to_dict()
    entry["effect"] = spell.effect
    entry["damage"] = list(spell.damage)
    entry["heal"] = list(spell.heal)
    out["spells"][key] = entry
for key, table in items.LOOT_TABLES.items():
    out["loot"][key] = {
        "gold": list(table.gold_range),
        "items": [{"id": e["item_id"], "chance": e["chance"], "qty": list(e["quantity"])} for e in table.items],
    }
for cls in ["Fighter", "Wizard", "Rogue", "Cleric"]:
    out["startingSpells"][cls] = spells.get_class_starting_spells(cls)

with open(os.path.join(ROOT, "online", "data.json"), "w") as fh:
    json.dump(out, fh, indent=1)
print("wrote online/data.json")
