"""
Henter Elo-ratinger og VM-fixtures, kobler dem sammen og skriver
site/data.json som frontend leser. Kjøres nightly av GitHub Actions.

Robusthet: hvis eloratings.net svikter, faller den tilbake på en
hardkodet snapshot slik at siden aldri blir tom.
"""
import json
import urllib.request
from pathlib import Path
from datetime import datetime, timezone

import engine

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
DATA = ROOT / "data"

# ISO-koder -> visningsnavn for de 48 VM-lagene
TEAMS = {
    "MX": "Mexico", "ZA": "South Africa", "KR": "South Korea", "CZ": "Czechia",
    "CA": "Canada", "BA": "Bosnia", "QA": "Qatar", "CH": "Switzerland",
    "BR": "Brazil", "MA": "Morocco", "HT": "Haiti", "SCO": "Scotland",
    "US": "USA", "PY": "Paraguay", "AU": "Australia", "TR": "Turkiye",
    "DE": "Germany", "CW": "Curacao", "CI": "Ivory Coast", "EC": "Ecuador",
    "NL": "Netherlands", "JP": "Japan", "SE": "Sweden", "TN": "Tunisia",
    "BE": "Belgium", "EG": "Egypt", "IR": "Iran", "NZ": "New Zealand",
    "ES": "Spain", "CV": "Cape Verde", "SA": "Saudi Arabia", "UY": "Uruguay",
    "FR": "France", "IQ": "Iraq", "NO": "Norway", "SN": "Senegal",
    "AR": "Argentina", "DZ": "Algeria", "AT": "Austria", "JO": "Jordan",
    "PT": "Portugal", "CD": "DR Congo", "UZ": "Uzbekistan", "CO": "Colombia",
    "EN": "England", "HR": "Croatia", "GH": "Ghana", "PA": "Panama",
}

# Hardkodet fallback (per juni 2026) — brukes kun hvis henting feiler
FALLBACK_ELO = {
    "Mexico": 1830, "South Africa": 1645, "South Korea": 1786, "Czechia": 1758,
    "Canada": 1812, "Bosnia": 1703, "Qatar": 1556, "Switzerland": 1897,
    "Brazil": 1991, "Morocco": 1851, "Haiti": 1503, "Scotland": 1747,
    "USA": 1790, "Paraguay": 1771, "Australia": 1734, "Turkiye": 1880,
    "Germany": 1910, "Curacao": 1532, "Ivory Coast": 1752, "Ecuador": 1933,
    "Netherlands": 1959, "Japan": 1879, "Sweden": 1772, "Tunisia": 1694,
    "Belgium": 1849, "Egypt": 1704, "Iran": 1763, "New Zealand": 1597,
    "Spain": 2157, "Cape Verde": 1601, "Saudi Arabia": 1624, "Uruguay": 1890,
    "France": 2063, "Iraq": 1601, "Norway": 1922, "Senegal": 1869,
    "Argentina": 2115, "Algeria": 1721, "Austria": 1809, "Jordan": 1601,
    "Portugal": 1989, "DR Congo": 1662, "Uzbekistan": 1673, "Colombia": 1982,
    "England": 2024, "Croatia": 1933, "Ghana": 1658, "Panama": 1703,
}

# Vertsnasjoner får hjemmebane-bonus (Elo-poeng)
HOSTS = {"USA": 80, "Mexico": 80, "Canada": 60}


def fetch_elo():
    """Hent live Elo fra eloratings.net TSV. Returner {navn: rating}."""
    try:
        req = urllib.request.Request(
            "https://www.eloratings.net/World.tsv",
            headers={"User-Agent": "Mozilla/5.0",
                     "Accept": "text/tab-separated-values,text/plain"},
        )
        raw = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
        if raw.lstrip().startswith("<"):
            raise ValueError("fikk HTML, ikke TSV")
        by_code = {}
        for line in raw.split("\n"):
            cols = line.split("\t")
            if len(cols) < 4:
                continue
            code, rating = cols[2], cols[3]
            try:
                by_code[code] = int(rating)
            except ValueError:
                continue
        out = {}
        for code, name in TEAMS.items():
            if code in by_code:
                out[name] = by_code[code]
        # fyll hull fra fallback
        for name, r in FALLBACK_ELO.items():
            out.setdefault(name, r)
        if len(out) < 40:
            raise ValueError(f"bare {len(out)} lag matchet")
        print(f"Elo hentet live: {len(out)} lag")
        return out, "live"
    except Exception as e:
        print(f"Elo-henting feilet ({e}); bruker fallback")
        return dict(FALLBACK_ELO), "fallback"


def load_fixtures():
    """Last fixtures fra lokal fil (vedlikeholdt manuelt / via openfootball)."""
    fx = DATA / "fixtures.json"
    if fx.exists():
        return json.loads(fx.read_text())
    return []


def build():
    elo, source = fetch_elo()
    fixtures = load_fixtures()
    out_matches = []
    for m in fixtures:
        a, b = m["home"], m["away"]
        if a not in elo or b not in elo:
            continue
        ha = HOSTS.get(a, 0)
        total = m.get("total", 2.55)
        pred = engine.prematch(elo[a], elo[b], home_adv=ha, total=total)
        out_matches.append({
            "id": m.get("id"),
            "date": m.get("date"),
            "group": m.get("group"),
            "home": a, "away": b,
            "elo_home": elo[a], "elo_away": elo[b],
            "home_adv": ha, "total": total,
            "status": m.get("status", "scheduled"),
            "score": m.get("score"),
            "prematch": pred,
        })
    payload = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "elo_source": source,
        "elo": elo,
        "hosts": HOSTS,
        "matches": out_matches,
    }
    SITE.mkdir(exist_ok=True)
    (SITE / "data.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"Skrev {len(out_matches)} kamper -> site/data.json ({source} Elo)")


if __name__ == "__main__":
    build()
