#!/usr/bin/env python3
"""Globalt prediksjonsregnskap: snapshotter modellens pre-kamp-sannsynligheter
nightly og gjør dem opp mot fasit — committes til repoet, så regnskapet er
etterprøvbart for alle (ikke bare localStorage i én nettleser).

Kjøres i workflowen ETTER liga_build.py (trenger fersk site/liga-elo.json).
Pending-prediksjoner overskrives ved hver kjøring frem til avspark — siste
natt-kjøring før kampen vinner, og alt er fortsatt strengt pre-kamp.
"""

import json
import math
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from liga_build import PARAMS, current_window, espn_events
from backtest import probs

SITE = Path(__file__).resolve().parent.parent / "site"
ELO_FILE = SITE / "liga-elo.json"
OUT = SITE / "ledger.json"

K_REPLAY = 20
MU_WEIGHT = 60


def parse_events(evs):
    out = []
    for ev in evs:
        comp = sorted(ev["competitions"][0]["competitors"],
                      key=lambda c: 0 if c["homeAway"] == "home" else 1)
        if len(comp) != 2:
            continue
        h, a = comp
        rec = {
            "id": ev["id"],
            "date": ev["date"],
            "state": ev["status"]["type"]["state"],
            "h": h["team"]["displayName"], "a": a["team"]["displayName"],
            "hs": None, "as": None,
        }
        try:
            rec["hs"], rec["as"] = int(h["score"]), int(a["score"])
        except (KeyError, ValueError, TypeError):
            pass
        out.append(rec)
    out.sort(key=lambda m: m["date"])
    return out


def league_model(lg, entry, matches):
    """(elo-oppslag, mu, ad) — speiler frontendens applyElo()."""
    hfa = PARAMS["hfa"].get(lg, 45)
    elo = dict(entry.get("teams") or {})
    fallback = (min(elo.values()) - 25) if elo else 1500

    def team_elo(name):
        return elo.get(name, fallback)

    generated = entry_generated(entry)
    replay_from = generated - timedelta(days=1) if generated else None
    mu_prior = entry.get("mu") or 2.7
    cum_g = cum_m = 0
    for m in matches:
        if m["state"] != "post" or m["hs"] is None:
            continue
        cum_g += m["hs"] + m["as"]; cum_m += 1
        md = datetime.fromisoformat(m["date"].replace("Z", "+00:00"))
        if replay_from and md < replay_from:
            continue
        we = 1 / (1 + 10 ** (-(team_elo(m["h"]) + hfa - team_elo(m["a"])) / 400))
        res = 1.0 if m["hs"] > m["as"] else 0.0 if m["hs"] < m["as"] else 0.5
        gd = abs(m["hs"] - m["as"])
        g = 1 if gd <= 1 else 1.5 if gd == 2 else (11 + gd) / 8
        delta = K_REPLAY * g * (res - we)
        elo[m["h"]] = team_elo(m["h"]) + delta
        elo[m["a"]] = team_elo(m["a"]) - delta
    mu = (mu_prior * MU_WEIGHT + cum_g) / (MU_WEIGHT + cum_m)
    return team_elo, mu, entry.get("ad") or {}


def entry_generated(entry):
    gen = None
    try:
        gen = datetime.fromisoformat(json.loads(ELO_FILE.read_text())["generated"])
        gen = gen.replace(tzinfo=timezone.utc)
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        pass
    return gen


def ad_factors(ad, hn, an):
    C, G = PARAMS["adC"], PARAMS["adG"]
    z = [0, 0, 0, 0]
    h, a = ad.get(hn, z), ad.get(an, z)
    fh = (((h[0] + C) / (h[1] + C)) * ((a[2] + C) / (a[3] + C))) ** G
    fa = (((a[0] + C) / (a[1] + C)) * ((h[2] + C) / (h[3] + C))) ** G
    return fh, fa


def main():
    elo_data = json.loads(ELO_FILE.read_text())
    ledger = {"leagues": {}}
    if OUT.exists():
        try:
            ledger = json.loads(OUT.read_text())
        except (OSError, json.JSONDecodeError):
            pass
    ledger["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    for lg, entry in elo_data.get("leagues", {}).items():
        L = ledger["leagues"].setdefault(
            lg, {"pending": {}, "agg": {"n": 0, "hits": 0, "ll": 0.0}, "rows": []})
        matches = parse_events(espn_events(lg, current_window(lg)))
        if not matches:
            continue
        team_elo, mu, ad = league_model(lg, entry, matches)
        p = {"pow": PARAMS["pow"], "rho": PARAMS["rho"], "biv": PARAMS["biv"],
             "hfa": PARAMS["hfa"].get(lg, 45)}
        meta = entry.get("meta") or {}
        short = lambda n: (meta.get(n) or {}).get("short", n)

        n_new = n_res = 0
        for m in matches:
            if m["state"] == "pre":
                fh, fa = ad_factors(ad, m["h"], m["a"])
                pH, pD, pA, _ = probs(team_elo(m["h"]), team_elo(m["a"]), mu, p, fh, fa)
                L["pending"][m["id"]] = [m["date"], round(pH, 4), round(pD, 4), round(pA, 4)]
                n_new += 1
            elif m["state"] == "post" and m["id"] in L["pending"] and m["hs"] is not None:
                _, pH, pD, pA = L["pending"].pop(m["id"])
                outcome = "H" if m["hs"] > m["as"] else "A" if m["hs"] < m["as"] else "D"
                got = {"H": pH, "D": pD, "A": pA}[outcome]
                pred = max(("H", pH), ("D", pD), ("A", pA), key=lambda x: x[1])[0]
                L["agg"]["n"] += 1
                L["agg"]["hits"] += 1 if pred == outcome else 0
                L["agg"]["ll"] = round(L["agg"]["ll"] - math.log(max(got, 1e-9)), 4)
                L["rows"].append([m["id"], m["date"][:10],
                                  f"{short(m['h'])} – {short(m['a'])}",
                                  pH, pD, pA, f"{m['hs']}-{m['as']}",
                                  1 if pred == outcome else 0])
                n_res += 1

        # rydd bort utsatte/annullerte kamper (14 dager etter oppsatt tid)
        cutoff = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
        L["pending"] = {k: v for k, v in L["pending"].items() if v[0] > cutoff}
        agg = L["agg"]
        print(f"{lg}: {n_new} pending-prediksjoner, {n_res} gjort opp "
              f"(totalt {agg['n']} målt, {agg['hits']} treff)")

    OUT.write_text(json.dumps(ledger, ensure_ascii=False))
    print(f"Skrev {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
