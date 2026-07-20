#!/usr/bin/env python3
"""Bygger site/liga-elo.json: klubb-Elo per liga + målsnitt per liga.

Kilder:
  - ClubElo (api.clubelo.com) for europeiske ligaer — gratis, oppdateres daglig.
  - Saudi Pro League har ikke ClubElo; ratingene beregnes ved å replaye alle
    resultater fra ESPN siden 2023 (start 1500, K=25, marginvekt, HFA 65).
  - Målsnitt (mu) per liga beregnes fra forrige sesongs resultater på ESPN.

Kjøres nightly i GitHub Actions. Feiler den, deployes den committede fila —
siden virker uansett, bare med ett døgn gamle ratinger.
"""

import json
import re
import sys
import unicodedata
import urllib.request
from datetime import date, timedelta
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "site" / "liga-elo.json"
ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/{lg}/scoreboard?dates={win}&limit=500"

# ESPN-kode -> (visningsnavn, ClubElo-landskode, forrige sesongs vindu for mu)
LEAGUES = {
    "nor.1": ("Eliteserien", "NOR", "20250301-20251215"),
    "eng.1": ("Premier League", "ENG", "20250801-20260601"),
    "esp.1": ("LaLiga", "ESP", "20250801-20260601"),
    "ger.1": ("Bundesliga", "GER", "20250801-20260601"),
    "ita.1": ("Serie A", "ITA", "20250801-20260601"),
    "por.1": ("Liga Portugal", "POR", "20250801-20260601"),
    "ksa.1": ("Saudi Pro League", None, "20250801-20260601"),
}

# Vindu for å finne lagene i inneværende sesong
CURRENT = {
    "nor.1": "20260301-20261215",
    "ksa.1": "20260801-20270601",
    "_default": "20260801-20270601",
}

# ESPN displayName -> ClubElo-navn der normalisering ikke strekker til
ALIASES = {
    "AFC Bournemouth": "Bournemouth",
    "Wolverhampton Wanderers": "Wolves",
    "Brighton & Hove Albion": "Brighton",
    "West Ham United": "West Ham",
    "Tottenham Hotspur": "Tottenham",
    "Newcastle United": "Newcastle",
    "Nottingham Forest": "Forest",
    "Manchester United": "Man United",
    "Manchester City": "Man City",
    "Leeds United": "Leeds",
    "FC Cologne": "Koeln",
    "Borussia Monchengladbach": "Gladbach",
    "Bayern Munich": "Bayern",
    "TSG Hoffenheim": "Hoffenheim",
    "Bayer Leverkusen": "Leverkusen",
    "Borussia Dortmund": "Dortmund",
    "Eintracht Frankfurt": "Frankfurt",
    "VfB Stuttgart": "Stuttgart",
    "VfL Wolfsburg": "Wolfsburg",
    "SC Freiburg": "Freiburg",
    "1. FC Heidenheim 1846": "Heidenheim",
    "FSV Mainz 05": "Mainz",
    "FC St. Pauli": "St Pauli",
    "Hamburg SV": "Hamburg",
    "1. FC Union Berlin": "Union Berlin",
    "RB Leipzig": "RB Leipzig",
    "Atletico Madrid": "Atletico",
    "Deportivo La Coruna": "Depor",
    "Athletic Club": "Bilbao",
    "Real Sociedad": "Sociedad",
    "Real Betis": "Betis",
    "Celta Vigo": "Celta",
    "Rayo Vallecano": "Rayo Vallecano",
    "Deportivo Alaves": "Alaves",
    "Internazionale": "Inter",
    "AC Milan": "Milan",
    "AS Roma": "Roma",
    "Hellas Verona": "Verona",
    "Sporting CP": "Sporting",
    "Sporting Braga": "Braga",
    "Vitoria de Guimaraes": "Guimaraes",
    "Bodo/Glimt": "Bodoe Glimt",
    "Bodø/Glimt": "Bodoe Glimt",
    "FK Haugesund": "Haugesund",
    "Valerenga": "Valerenga",
    "Vålerenga": "Valerenga",
    "Hamarkameratene": "Ham-Kam",
    "Stromsgodset": "Stroemsgodset",
    "Strømsgodset": "Stroemsgodset",
}


def fetch_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "liga-build/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def fetch_text(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "liga-build/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()


def norm(s):
    """Normaliser lagnavn for matching: ascii, småbokstaver, uten fyllord."""
    s = s.replace("ø", "oe").replace("Ø", "oe").replace("æ", "ae").replace("Æ", "ae")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9 ]", " ", s.lower())
    drop = {"fc", "cf", "sc", "ac", "as", "cd", "ud", "sd", "afc", "fk", "sk", "if",
            "bk", "il", "1", "de", "real", "club", "cp", "sv", "vfb", "vfl", "tsg",
            "rcd", "rc", "calcio", "us", "ssc", "sl", "fsv"}
    toks = [t for t in s.split() if t not in drop]
    return " ".join(toks)


def _ascii(s):
    s = s.replace("ø", "o").replace("Ø", "O").replace("æ", "ae").replace("Æ", "Ae")
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


# alias-oppslag skal tåle aksenter begge veier ("Atlético Madrid" == "Atletico Madrid")
ALIASES_NORM = {_ascii(k): v for k, v in ALIASES.items()}


def match_elo(display, country_rows):
    """Finn ClubElo-rating for et ESPN-lagnavn innen ett lands klubber."""
    alias = ALIASES.get(display) or ALIASES_NORM.get(_ascii(display))
    target = norm(alias) if alias else norm(display)
    if not target:
        return None
    # eksakt normalisert match
    for cname, elo in country_rows:
        if norm(cname) == target:
            return elo
    # token-subset: alle tokens i det ene navnet finnes i det andre
    tt = set(target.split())
    best = None
    for cname, elo in country_rows:
        ct = set(norm(cname).split())
        if tt <= ct or ct <= tt:
            if best is not None:
                return None  # tvetydig — heller fallback enn feil lag
            best = elo
    return best


def espn_events(lg, window):
    try:
        d = fetch_json(ESPN.format(lg=lg, win=window))
        return d.get("events", [])
    except Exception as e:
        print(f"  ADVARSEL: klarte ikke hente {lg} {window}: {e}")
        return []


def season_mu(lg, window):
    """Snitt mål per kamp fra ferdigspilte kamper i vinduet."""
    goals, n = 0, 0
    for ev in espn_events(lg, window):
        if ev["status"]["type"]["state"] != "post":
            continue
        comp = ev["competitions"][0]["competitors"]
        try:
            goals += sum(int(c["score"]) for c in comp)
            n += 1
        except (KeyError, ValueError, TypeError):
            continue
    return (round(goals / n, 3), n) if n >= 50 else (None, n)


def current_teams(lg):
    """Lagnavn i inneværende sesong fra terminlisten."""
    window = CURRENT.get(lg, CURRENT["_default"])
    teams = {}
    for ev in espn_events(lg, window):
        for c in ev["competitions"][0]["competitors"]:
            t = c["team"]
            teams[t["displayName"]] = {
                "short": t.get("shortDisplayName") or t["displayName"],
                "abbr": t.get("abbreviation") or t["displayName"][:3].upper(),
            }
    return teams


def saudi_elo():
    """Replay alle SPL-resultater fra ESPN siden 2023 -> Elo per lag."""
    K, HFA, START = 25, 65, 1500.0
    windows = ["20230801-20240701", "20240801-20250701", "20250801-20260701"]
    matches = []
    for w in windows:
        for ev in espn_events("ksa.1", w):
            if ev["status"]["type"]["state"] != "post":
                continue
            comp = sorted(ev["competitions"][0]["competitors"],
                          key=lambda c: 0 if c["homeAway"] == "home" else 1)
            try:
                h, a = comp
                matches.append((ev["date"], h["team"]["displayName"], a["team"]["displayName"],
                                int(h["score"]), int(a["score"])))
            except (KeyError, ValueError, TypeError):
                continue
    matches.sort()
    elo = {}
    for _, hn, an, hs, gs in matches:
        eh = elo.get(hn, START)
        ea = elo.get(an, START)
        we = 1 / (1 + 10 ** (-(eh + HFA - ea) / 400))
        res = 1.0 if hs > gs else 0.0 if hs < gs else 0.5
        gd = abs(hs - gs)
        g = 1 if gd <= 1 else 1.5 if gd == 2 else (11 + gd) / 8
        delta = K * g * (res - we)
        elo[hn] = eh + delta
        elo[an] = ea - delta
    print(f"  Saudi: {len(matches)} kamper replayet, {len(elo)} lag")
    return elo


def main():
    today = date.today()
    # ClubElo dropper klubber uten kommende kamper fra dagsfila (typisk i
    # sommerpausen) — slå derfor sammen gårsdagens snapshot med et eldre,
    # der ferske ratinger vinner.
    ratings_by_name = {}
    for days_back in (45, 1):
        try:
            csv = fetch_text(f"http://api.clubelo.com/{today - timedelta(days=days_back)}")
        except Exception as e:
            print(f"  ADVARSEL: ClubElo {days_back} dager tilbake feilet: {e}")
            continue
        for line in csv.strip().splitlines()[1:]:
            parts = line.split(",")
            if len(parts) < 5:
                continue
            _, club, country, _, elo = parts[:5]
            ratings_by_name[(country, club)] = float(elo)
    by_country = {}
    for (country, club), elo in ratings_by_name.items():
        by_country.setdefault(country, []).append((club, elo))
    print(f"ClubElo: {sum(len(v) for v in by_country.values())} klubber, "
          f"{len(by_country)} land")

    out = {"generated": today.isoformat(), "leagues": {}}
    ok = True
    for lg, (name, country, mu_window) in LEAGUES.items():
        print(f"{name} ({lg}):")
        teams = current_teams(lg)
        ratings = saudi_elo() if country is None else None
        # terminliste ikke publisert ennå (typisk Saudi i sommerpausen):
        # bruk lagene fra replay-ratingene så Elo-tabellen kan vises likevel
        if not teams and ratings:
            teams = {n: {"short": n, "abbr": n[:3].upper()} for n in ratings}
        entry = {"name": name, "teams": {}, "meta": {}}

        mu, mu_n = season_mu(lg, mu_window)
        if mu:
            entry["mu"] = mu
            print(f"  mu = {mu} ({mu_n} kamper forrige sesong)")

        rows = by_country.get(country, []) if country else None
        matched, missing = 0, []
        for display, meta in teams.items():
            if ratings is not None:
                elo = ratings.get(display)
            else:
                elo = match_elo(display, rows)
            if elo is not None:
                entry["teams"][display] = round(elo, 1)
                matched += 1
            else:
                missing.append(display)
            entry["meta"][display] = meta
        print(f"  {matched}/{len(teams)} lag matchet" +
              (f" — MANGLER: {missing}" if missing else ""))
        if teams and matched < len(teams) * 0.8:
            ok = False
        out["leagues"][lg] = entry

    if not out["leagues"] or not ok:
        print("FEIL: for dårlig dekning — beholder eksisterende fil")
        sys.exit(1)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"Skrev {OUT}")


if __name__ == "__main__":
    main()
