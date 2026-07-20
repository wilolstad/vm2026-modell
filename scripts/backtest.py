#!/usr/bin/env python3
"""Backtest av liga-modellen på historiske sesonger, med pre-kamp-ratinger.

Metodikk (samme som VM-modellens eksperimentlogg, men med 25x mer data):
  - Resultater fra ESPN for to hele sesonger per liga (train + validering).
  - Pre-kamp-Elo fra ClubElos per-klubb-historikk (api.clubelo.com/<Klubb>):
    ratingen slik den faktisk var FØR hver kamp — ærlig out-of-sample.
    Saudi Pro League: egen Elo-replay kronologisk (som i liga_build.py).
  - Målsnitt-prior per sesong = forrige sesongs snitt, løpende oppdatert
    (vekt 60) — speiler frontend-pipelinen nøyaktig.
  - Koordinat-søk over HFA/POW/RHO/BIV per liga med 1X2-logloss på train;
    shippes KUN hvis logloss også bedres på valideringssesongen.

Kjøres lokalt (én gang, ikke i CI): python3 scripts/backtest.py
Cache i scripts/.cache/ — slett den for å hente ferske data.
"""

import json
import math
import re
import urllib.request
from pathlib import Path

from liga_build import ALIASES, ALIASES_NORM, _ascii, norm, match_club, fetch_text, fetch_json

CACHE = Path(__file__).resolve().parent / ".cache"
CACHE.mkdir(exist_ok=True)
ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/{lg}/scoreboard?dates={win}&limit=500"

# (navn, ClubElo-land, mu-sesong, train-sesong, valideringssesong)
LEAGUES = {
    "nor.1": ("Eliteserien", "NOR", "20230301-20231215", "20240301-20241215", "20250301-20251215"),
    "eng.1": ("Premier League", "ENG", "20230801-20240601", "20240801-20250601", "20250801-20260601"),
    "esp.1": ("LaLiga", "ESP", "20230801-20240601", "20240801-20250601", "20250801-20260601"),
    "ger.1": ("Bundesliga", "GER", "20230801-20240601", "20240801-20250601", "20250801-20260601"),
    "ita.1": ("Serie A", "ITA", "20230801-20240601", "20240801-20250601", "20250801-20260601"),
    "por.1": ("Liga Portugal", "POR", "20230801-20240601", "20240801-20250601", "20250801-20260601"),
    "ksa.1": ("Saudi Pro League", None, "20230801-20240601", "20240801-20250601", "20250801-20260601"),
}

# dagens frontend-parametre (arvet fra VM-modellen) = baseline
DEFAULT = {"hfa": 65, "pow": 1.2, "rho": -0.2, "biv": 0.4}
GRID = {
    "hfa": [0, 10, 20, 30, 45, 65, 85, 110],
    "pow": [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2],
    "rho": [0.0, -0.1, -0.2, -0.3],
    "biv": [0.0, 0.2, 0.4, 0.6],
}
MU_WEIGHT = 60
MAX_G = 8


def cached(key, fetch):
    f = CACHE / (re.sub(r"[^A-Za-z0-9_.-]", "_", key) + ".json")
    if f.exists():
        return json.loads(f.read_text())
    data = fetch()
    f.write_text(json.dumps(data))
    return data


def espn_results(lg, window):
    """[(iso-dato, hjemme, borte, hs, as)] for ferdigspilte kamper, kronologisk."""
    def go():
        evs = fetch_json(ESPN.format(lg=lg, win=window)).get("events", [])
        out = []
        for ev in evs:
            if ev["status"]["type"]["state"] != "post":
                continue
            comp = sorted(ev["competitions"][0]["competitors"],
                          key=lambda c: 0 if c["homeAway"] == "home" else 1)
            try:
                h, a = comp
                out.append((ev["date"], h["team"]["displayName"], a["team"]["displayName"],
                            int(h["score"]), int(a["score"])))
            except (KeyError, ValueError, TypeError):
                continue
        out.sort()
        return out
    return cached(f"espn_{lg}_{window}", go)


def clubelo_snapshot():
    """Landskart {land: [(klubb, elo)]} for navneoppslag (merged, som liga_build)."""
    def go():
        rows = {}
        for d in ("2026-06-01", "2026-07-19"):
            for line in fetch_text(f"http://api.clubelo.com/{d}").strip().splitlines()[1:]:
                p = line.split(",")
                if len(p) >= 5:
                    rows[(p[2], p[1])] = float(p[4])
        return [[c, n, e] for (c, n), e in rows.items()]
    flat = cached("clubelo_snapshot", go)
    by = {}
    for country, name, elo in flat:
        by.setdefault(country, []).append((name, elo))
    return by


def club_history(club_name):
    """[(from_iso, to_iso, elo)] fra ClubElos per-klubb-endepunkt."""
    def go():
        url_name = re.sub(r"[^A-Za-z0-9]", "", club_name)
        out = []
        for line in fetch_text(f"http://api.clubelo.com/{url_name}").strip().splitlines()[1:]:
            p = line.split(",")
            if len(p) >= 7:
                out.append((p[5], p[6], float(p[4])))
        return out
    return cached(f"hist_{club_name}", go)


def elo_lookup(history):
    """dato-iso -> rating: siste intervall som starter før datoen (pre-kamp)."""
    def at(date_iso):
        d = date_iso[:10]
        best = None
        for frm, to, elo in history:
            if frm <= d:
                best = elo  # historikken er kronologisk; siste vinner
            else:
                break
        return best
    return at


def saudi_prematch(train_win, val_win):
    """Replay SPL fra 2023; returner {vindu: [kamper med pre-kamp-Elo]}."""
    K, HFA_R, START = 25, 65, 1500.0
    all_matches = []
    for w in ("20230801-20240701", "20240801-20250701", "20250801-20260701"):
        all_matches += espn_results("ksa.1", w)
    all_matches.sort()
    elo = {}
    out = {train_win: [], val_win: []}
    windows = {train_win: espn_results("ksa.1", train_win),
               val_win: espn_results("ksa.1", val_win)}
    in_win = {m[0]: w for w, ms in windows.items() for m in ms}
    for date, hn, an, hs, gs in all_matches:
        eh, ea = elo.get(hn, START), elo.get(an, START)
        w = in_win.get(date)
        if w is not None:
            out[w].append({"h": hn, "a": an, "hs": hs, "as": gs, "eh": eh, "ea": ea})
        we = 1 / (1 + 10 ** (-(eh + HFA_R - ea) / 400))
        res = 1.0 if hs > gs else 0.0 if hs < gs else 0.5
        gd = abs(hs - gs)
        g = 1 if gd <= 1 else 1.5 if gd == 2 else (11 + gd) / 8
        delta = K * g * (res - we)
        elo[hn], elo[an] = eh + delta, ea - delta
    return out


def build_matches(lg, country, window, name_cache, hist_cache):
    """Kamper i vinduet med pre-kamp-Elo fra ClubElo-historikk."""
    snapshot = clubelo_snapshot()
    rows = snapshot.get(country, [])
    results = espn_results(lg, window)
    matches, missing = [], set()

    def resolve(display):
        if display in name_cache:
            return name_cache[display]
        m = match_club(display, rows)
        club = m[0] if m else None
        if club is None:
            # nedrykkede klubber finnes ikke i dagens snapshot, men har full
            # historikk hos ClubElo — prøv URL-gjetninger direkte
            alias = ALIASES.get(display) or ALIASES_NORM.get(_ascii(display))
            guesses = [g for g in {alias, _ascii(display),
                                   " ".join(t.capitalize() for t in norm(display).split())} if g]
            for g in guesses:
                if club_history(g):
                    club = g
                    break
        name_cache[display] = club
        return club

    def pre_elo(display, date):
        club = resolve(display)
        if not club:
            missing.add(display)
            return None
        if club not in hist_cache:
            hist_cache[club] = elo_lookup(club_history(club))
        return hist_cache[club](date)

    for date, hn, an, hs, gs in results:
        eh, ea = pre_elo(hn, date), pre_elo(an, date)
        matches.append({"h": hn, "a": an, "hs": hs, "as": gs, "eh": eh, "ea": ea})

    # fallback som i frontend: ligaens bunnrating minus 25
    known = [m[x] for m in matches for x in ("eh", "ea") if m[x] is not None]
    fb = (min(known) - 25) if known else 1500
    n_fb = 0
    for m in matches:
        if m["eh"] is None: m["eh"] = fb; n_fb += 1
        if m["ea"] is None: m["ea"] = fb; n_fb += 1
    if missing:
        print(f"    (uten ClubElo, fallback {round(fb)}: {sorted(missing)} — {n_fb} kampsider)")
    return matches


def season_avg_goals(lg, window):
    res = espn_results(lg, window)
    return sum(m[3] + m[4] for m in res) / len(res) if res else 2.7


# ---------- modellen (eksakt port av liga.js) ----------

def pois_row(lam, n):
    row = [math.exp(-lam)]
    for k in range(1, n + 1):
        row.append(row[-1] * lam / k)
    return row


def probs(eh, ea, mu, p):
    """(pH, pD, pA, pO25) med bivariat Poisson + Dixon-Coles."""
    we = 1 / (1 + 10 ** (-(eh + p["hfa"] - ea) / 400))
    wg = we ** p["pow"] / (we ** p["pow"] + (1 - we) ** p["pow"])
    lh = max(0.2, mu * wg)
    la = max(0.2, mu * (1 - wg))
    l3 = p["biv"] * min(lh, la)
    l1, l2 = lh - l3, la - l3
    rho = p["rho"]
    p1 = pois_row(l1, MAX_G)
    p2 = pois_row(l2, MAX_G)
    p3 = pois_row(l3, 5)
    pH = pD = pA = pO25 = tot = 0.0
    for x3 in range(6):
        q3 = p3[x3]
        if q3 < 1e-12:
            break
        for x1 in range(MAX_G + 1):
            q1 = q3 * p1[x1]
            X = x1 + x3
            for x2 in range(MAX_G + 1):
                q = q1 * p2[x2]
                Y = x2 + x3
                if X == 0 and Y == 0: q *= 1 - lh * la * rho
                elif X == 0 and Y == 1: q *= 1 + lh * rho
                elif X == 1 and Y == 0: q *= 1 + la * rho
                elif X == 1 and Y == 1: q *= 1 - rho
                tot += q
                if X > Y: pH += q
                elif X < Y: pA += q
                else: pD += q
                if X + Y > 2.5: pO25 += q
    return pH / tot, pD / tot, pA / tot, pO25 / tot


def evaluate(matches, mu_prior, p):
    """1X2-logloss + O/U 2,5-Brier, med løpende mu som i frontend."""
    ll = br = 0.0
    cum_g = cum_m = 0
    for m in matches:
        mu = (mu_prior * MU_WEIGHT + cum_g) / (MU_WEIGHT + cum_m)
        pH, pD, pA, pO = probs(m["eh"], m["ea"], mu, p)
        got = pH if m["hs"] > m["as"] else pA if m["hs"] < m["as"] else pD
        ll += -math.log(max(got, 1e-9))
        over = 1.0 if m["hs"] + m["as"] > 2.5 else 0.0
        br += (pO - over) ** 2
        cum_g += m["hs"] + m["as"]
        cum_m += 1
    n = len(matches)
    return ll / n, br / n


def base_rate_ll(matches):
    n = len(matches)
    cnt = {"H": 0, "D": 0, "A": 0}
    for m in matches:
        cnt["H" if m["hs"] > m["as"] else "A" if m["hs"] < m["as"] else "D"] += 1
    return -sum(c / n * math.log(c / n) for c in cnt.values() if c)


def tune(matches, mu_prior):
    """Koordinat-søk, to pass, 1X2-logloss som mål."""
    best = dict(DEFAULT)
    best_ll, _ = evaluate(matches, mu_prior, best)
    for _ in range(2):
        for axis, values in GRID.items():
            for v in values:
                cand = {**best, axis: v}
                ll, _ = evaluate(matches, mu_prior, cand)
                if ll < best_ll - 1e-6:
                    best, best_ll = cand, ll
    return best, best_ll


def load_all():
    """{lg: {train, val, mu_train, mu_val}} for alle ligaer."""
    data = {}
    for lg, (name, country, mu_win, train_win, val_win) in LEAGUES.items():
        mu_train = season_avg_goals(lg, mu_win)
        mu_val = season_avg_goals(lg, train_win)
        if country is None:
            wins = saudi_prematch(train_win, val_win)
            train, val = wins[train_win], wins[val_win]
        else:
            name_cache, hist_cache = {}, {}
            train = build_matches(lg, country, train_win, name_cache, hist_cache)
            val = build_matches(lg, country, val_win, name_cache, hist_cache)
        if len(train) < 100 or len(val) < 100:
            print(f"  HOPPER OVER {lg}: for få kamper ({len(train)}/{len(val)})")
            continue
        data[lg] = {"train": train, "val": val, "mu_train": mu_train, "mu_val": mu_val}
    return data


def main():
    """Pooled tuning: POW/RHO/BIV deles på tvers av ligaer (2 300+ kamper),
    kun HFA er per liga. Per-liga-tuning av alle fire parametrene på ~300
    kamper overfittet (bedre train, dels verre validering) — dette er
    bias/varians-avveiningen: formen på modellen er ikke liganspesifikk,
    men hjemmefordelen er det."""
    data = load_all()

    shape = {k: DEFAULT[k] for k in ("pow", "rho", "biv")}
    hfa = {lg: DEFAULT["hfa"] for lg in data}

    def pooled_ll(shape_p, hfa_p, split):
        tot_ll = tot_n = 0
        for lg, d in data.items():
            p = {**shape_p, "hfa": hfa_p[lg]}
            mu = d["mu_train"] if split == "train" else d["mu_val"]
            ll, _ = evaluate(d[split], mu, p)
            tot_ll += ll * len(d[split])
            tot_n += len(d[split])
        return tot_ll / tot_n

    # alternerende koordinat-søk: per-liga HFA <-> felles form
    for it in range(3):
        for lg, d in data.items():
            best_v, best_ll = hfa[lg], None
            for v in GRID["hfa"]:
                ll, _ = evaluate(d["train"], d["mu_train"], {**shape, "hfa": v})
                if best_ll is None or ll < best_ll - 1e-6:
                    best_v, best_ll = v, ll
            hfa[lg] = best_v
        for axis in ("pow", "rho", "biv"):
            best_v, best_ll = shape[axis], pooled_ll(shape, hfa, "train")
            for v in GRID[axis]:
                ll = pooled_ll({**shape, axis: v}, hfa, "train")
                if ll < best_ll - 1e-6:
                    best_v, best_ll = v, ll
            shape[axis] = best_v
        print(f"iterasjon {it + 1}: form={shape} hfa={hfa}")

    # rapport + ship-vurdering per liga
    print(f"\n{'liga':22} {'train base->tunet':>22} {'val base->tunet':>22}  {'base rate':>9}")
    shipped = {}
    ok_all = True
    for lg, d in data.items():
        p = {**shape, "hfa": hfa[lg]}
        ll0_t, _ = evaluate(d["train"], d["mu_train"], DEFAULT)
        llT_t, _ = evaluate(d["train"], d["mu_train"], p)
        ll0_v, br0 = evaluate(d["val"], d["mu_val"], DEFAULT)
        llT_v, brT = evaluate(d["val"], d["mu_val"], p)
        flag = "" if llT_v < ll0_v - 0.001 else "  <-- IKKE bedre på validering"
        if flag:
            ok_all = False
        print(f"{lg:22} {ll0_t:.4f} -> {llT_t:.4f}      {ll0_v:.4f} -> {llT_v:.4f}"
              f"   {base_rate_ll(d['val']):.4f}{flag}")
        shipped[lg] = p
    b0 = pooled_ll(DEFAULT | {"pow": DEFAULT["pow"]}, {lg: DEFAULT["hfa"] for lg in data}, "val")
    bT = pooled_ll(shape, hfa, "val")
    print(f"\npooled validering: {b0:.4f} -> {bT:.4f}  ({'SHIPPES' if ok_all else 'sjekk ligaene over'})")
    print("\n---- til liga.js (LEAGUES-parametre) ----")
    print(json.dumps(shipped, indent=2))


if __name__ == "__main__":
    main()
