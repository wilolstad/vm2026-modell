"""
VM 2026 prediksjonsmotor.
Elo -> forventede mål -> Poisson-fordeling over resultater.
Live-modus: betinger på faktisk stilling/xG og re-beregner resten av kampen.

Ingen eksterne avhengigheter utover stdlib. Kjøres av build.py og speiles
i ren JS i frontend (math.js) slik at live-omregning skjer i nettleseren
uten å vente på en ny nightly-kjøring.
"""
from math import exp, factorial


def win_draw_loss(elo_a, elo_b, home_adv=0.0):
    """Sannsynlighet for seier/uavgjort/tap fra Elo-differanse."""
    dr = (elo_a + home_adv) - elo_b
    we = 1.0 / (1.0 + 10 ** (-dr / 400.0))           # forventet skår (0-1)
    pd = 0.27 * exp(-((dr / 500.0) ** 2))            # uavgjort krymper med gap
    pw = max(we - pd / 2, 0.01)
    pl = max(1 - we - pd / 2, 0.01)
    s = pw + pd + pl
    return pw / s, pd / s, pl / s


def expected_goals(elo_a, elo_b, home_adv=0.0, total=2.55):
    """Fordel en forventet total målmengde mellom lagene etter styrkeforhold."""
    dr = (elo_a + home_adv) - elo_b
    we = 1.0 / (1.0 + 10 ** (-dr / 400.0))
    share_a = we ** 0.9 / (we ** 0.9 + (1 - we) ** 0.9)
    return total * share_a, total * (1 - total / total * (1 - (1 - share_a)))  # placeholder, overskrives under


def xg_split(elo_a, elo_b, home_adv=0.0, total=2.55):
    dr = (elo_a + home_adv) - elo_b
    we = 1.0 / (1.0 + 10 ** (-dr / 400.0))
    share_a = we ** 0.9 / (we ** 0.9 + (1 - we) ** 0.9)
    lam_a = total * share_a
    lam_b = total - lam_a
    return lam_a, lam_b


def _pois(k, lam):
    return lam ** k * exp(-lam) / factorial(k)


def score_matrix(lam_a, lam_b, max_goals=8):
    """Full sannsynlighetsmatrise P(a-b) for et helt kamp-xG-par."""
    return {
        (a, b): _pois(a, lam_a) * _pois(b, lam_b)
        for a in range(max_goals) for b in range(max_goals)
    }


def prematch(elo_a, elo_b, home_adv=0.0, total=2.55):
    """Full pre-kamp prediksjon."""
    lam_a, lam_b = xg_split(elo_a, elo_b, home_adv, total)
    d = score_matrix(lam_a, lam_b)
    return _summarise(d, lam_a, lam_b)


def live(elo_a, elo_b, minute, goals_a, goals_b,
         xg_a=None, xg_b=None, red_a=0, red_b=0,
         home_adv=0.0, total=2.55):
    """
    Prediksjon betinget på faktisk kamptilstand.
    - minute: spilte minutter (0-90+)
    - goals_a/b: mål så langt
    - xg_a/b: faktisk xG så langt (valgfritt; faller tilbake på Elo-rate)
    - red_a/b: antall røde kort (justerer gjenværende rate)
    Returnerer fordeling over SLUTTRESULTAT.
    """
    remaining = max(90 - minute, 0) + 4  # +4 tillegg som standard
    frac = remaining / 90.0

    # Baseline gjenværende rate fra Elo
    base_a, base_b = xg_split(elo_a, elo_b, home_adv, total)

    # Hvis faktisk xG er gitt, bruk observert rate som signal for resten
    if xg_a is not None and minute > 0:
        obs_rate_a = xg_a / minute * 90
        # bland observert (60%) med Elo-forventning (40%) -> unngå overreaksjon
        lam_a_full = 0.6 * obs_rate_a + 0.4 * base_a
    else:
        lam_a_full = base_a
    if xg_b is not None and minute > 0:
        obs_rate_b = xg_b / minute * 90
        lam_b_full = 0.6 * obs_rate_b + 0.4 * base_b
    else:
        lam_b_full = base_b

    # Hvem leder? Den som jager booster, den som leder demper (game-state)
    lead = goals_a - goals_b
    chase_boost, lead_damp = 1.30, 0.85
    ga, gb = 1.0, 1.0
    if lead > 0:        # A leder
        ga, gb = lead_damp, chase_boost
    elif lead < 0:      # B leder
        ga, gb = chase_boost, lead_damp

    # Røde kort: laget med kort mister ~30% rate per kort, motstander +15%
    ga *= (1 - 0.30 * red_a) * (1 + 0.15 * red_b)
    gb *= (1 - 0.30 * red_b) * (1 + 0.15 * red_a)

    lam_a = max(lam_a_full * frac * ga, 0.01)
    lam_b = max(lam_b_full * frac * gb, 0.01)

    # Fordeling over GJENVÆRENDE mål, forskjøvet med allerede scorede
    rem = score_matrix(lam_a, lam_b, max_goals=7)
    d = {}
    for (ra, rb), p in rem.items():
        d[(goals_a + ra, goals_b + rb)] = d.get((goals_a + ra, goals_b + rb), 0) + p
    return _summarise(d, lam_a, lam_b, live=True,
                      ga=goals_a, gb=goals_b)


def _summarise(d, lam_a, lam_b, live=False, ga=0, gb=0):
    """Bygg en kompakt oppsummering av en resultatfordeling."""
    win_a = sum(p for (a, b), p in d.items() if a > b)
    draw = sum(p for (a, b), p in d.items() if a == b)
    win_b = sum(p for (a, b), p in d.items() if a < b)
    over25 = sum(p for (a, b), p in d.items() if a + b > 2.5)
    over35 = sum(p for (a, b), p in d.items() if a + b > 3.5)
    btts = sum(p for (a, b), p in d.items() if a > 0 and b > 0)
    cs_a = sum(p for (a, b), p in d.items() if b == 0)
    cs_b = sum(p for (a, b), p in d.items() if a == 0)
    top = sorted(d.items(), key=lambda x: -x[1])[:6]
    return {
        "win_a": win_a, "draw": draw, "win_b": win_b,
        "over25": over25, "over35": over35, "under25": 1 - over25,
        "btts": btts, "cs_a": cs_a, "cs_b": cs_b,
        "xg_a": round(lam_a, 2), "xg_b": round(lam_b, 2),
        "top_scores": [{"a": a, "b": b, "p": round(p, 4)} for (a, b), p in top],
    }


if __name__ == "__main__":
    # Røyktest mot kveldens kamper
    print("Mexico-SorAfrika pre:", prematch(1830, 1645, home_adv=100))
    print("Belgia-Egypt live 0-1 @40 xG0.35/0.10:",
          live(1849, 1704, 40, 0, 1, xg_a=0.35, xg_b=0.10))
