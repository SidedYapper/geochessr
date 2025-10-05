#!/usr/bin/env python3
"""
Generate a Python dict mapping every ECO code (A00–E99) to a canonical opening name.

Data source: https://github.com/hayatbiralem/eco.json (MIT-licensed).
We download ecoA.json … ecoE.json (small files) and, for each ECO code, pick the
entry marked `isEcoRoot` when present; otherwise we fall back to the first seen name.

Outputs:
  1) Prints a variable named `eco_openings` as valid Python code to stdout
  2) Also saves JSON and a tiny .py module next to the script for convenience
"""

from urllib.request import urlopen
import os
import json
from collections import defaultdict, OrderedDict
from tqdm import tqdm
from functools import lru_cache

RAW_BASE = "https://raw.githubusercontent.com/hayatbiralem/eco.json/master"
FILES = [f"eco{letter}.json" for letter in "ABCDE"]


def fetch_json(url: str):
    with urlopen(url) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    eco_root_name = {}  # ECO -> root name (isEcoRoot == True)
    eco_all_names = defaultdict(list)  # ECO -> [all names encountered]

    # Pull and scan A..E
    for fname in tqdm(FILES):
        url = f"{RAW_BASE}/{fname}"
        data = fetch_json(url)

        # Each file is a dict mapping FEN -> { eco, name, ... }
        for _, rec in data.items():
            eco = rec.get("eco")
            name = rec.get("name")
            if not eco or not name:
                continue

            eco_all_names[eco].append(name)

            # Prefer canonical "root" entry when provided
            if rec.get("isEcoRoot") and eco not in eco_root_name:
                eco_root_name[eco] = name

    # Build final single-name mapping:
    #   take root name if available, else first seen name
    eco_codes = sorted(
        set(eco_all_names.keys()), key=lambda k: (k[0], int(k[1:]))
    )  # A00..E99 order
    eco_openings = OrderedDict()
    for code in eco_codes:
        eco_openings[code] = eco_root_name.get(code, eco_all_names[code][0])

    # Pretty-print as real Python code
    print("eco_openings = {")
    for code in eco_codes:
        print(f'    "{code}": {json.dumps(eco_openings[code])},')
    print("}")

    eco_openings["A00"] = "Irregular"

    # Also save to files for reuse
    with open(
        os.path.join(os.path.dirname(__file__), "..", "data", "eco_openings.json"),
        "w",
    ) as f:
        json.dump(eco_openings, f, indent=2, ensure_ascii=False)


@lru_cache(maxsize=1)
def get_eco_openings():
    with open(
        os.path.join(os.path.dirname(__file__), "..", "data", "eco_openings.json"),
        "r",
    ) as f:
        return json.load(f)


if __name__ == "__main__":
    main()
