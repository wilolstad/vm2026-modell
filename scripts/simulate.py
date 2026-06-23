import numpy as np
from collections import defaultdict

rng = np.random.default_rng(42)
N_SIMS = 50000

# Elo ratings per 11 June 2026 (eloratings.net / footballratings.org, estimates for lower teams)
elo = {
    # Group A
    "Mexico": 1830, "South Africa": 1645, "South Korea": 1786, "Czechia": 1758,
    # Group B
    "Canada": 1812, "Bosnia": 1703, "Qatar": 1556, "Switzerland": 1897,
    # Group C
    "Brazil": 1991, "Morocco": 1851, "Haiti": 1503, "Scotland": 1747,
    # Group D
    "USA": 1790, "Paraguay": 1771, "Australia": 1734, "Turkiye": 1880,
    # Group E
    "Germany": 1910, "Curacao": 1532, "Ivory Coast": 1752, "Ecuador": 1933,
    # Group F
    "Netherlands": 1959, "Japan": 1879, "Sweden": 1772, "Tunisia": 1694,
    # Group G
    "Belgium": 1849, "Egypt": 1704, "Iran": 1763, "New Zealand": 1597,
    # Group H
    "Spain": 2157, "Cape Verde": 1601, "Saudi Arabia": 1624, "Uruguay": 1890,
    # Group I
    "France": 2063, "Iraq": 1601, "Norway": 1922, "Senegal": 1869,
    # Group J
    "Argentina": 2115, "Algeria": 1721, "Austria": 1809, "Jordan": 1601,
    # Group K
    "Portugal": 1989, "DR Congo": 1662, "Uzbekistan": 1673, "Colombia": 1982,
    # Group L
    "England": 2024, "Croatia": 1933, "Ghana": 1658, "Panama": 1703,
}

groups = {
    "A": ["Mexico", "South Africa", "South Korea", "Czechia"],
    "B": ["Canada", "Bosnia", "Qatar", "Switzerland"],
    "C": ["Brazil", "Morocco", "Haiti", "Scotland"],
    "D": ["USA", "Paraguay", "Australia", "Turkiye"],
    "E": ["Germany", "Curacao", "Ivory Coast", "Ecuador"],
    "F": ["Netherlands", "Japan", "Sweden", "Tunisia"],
    "G": ["Belgium", "Egypt", "Iran", "New Zealand"],
    "H": ["Spain", "Cape Verde", "Saudi Arabia", "Uruguay"],
    "I": ["France", "Iraq", "Norway", "Senegal"],
    "J": ["Argentina", "Algeria", "Austria", "Jordan"],
    "K": ["Portugal", "DR Congo", "Uzbekistan", "Colombia"],
    "L": ["England", "Croatia", "Ghana", "Panama"],
}

hosts = {"USA": 80, "Mexico": 80, "Canada": 60}  # crowd/home Elo bonus

def eff(team, knockout=False):
    e = elo[team]
    if team in hosts:
        e += hosts[team] * (0.7 if knockout else 1.0)  # knockout mostly in USA
    return e

def match_probs(ea, eb):
    """Win/draw/loss probabilities from Elo diff (group stage)."""
    dr = ea - eb
    we = 1.0 / (1.0 + 10 ** (-dr / 400.0))
    # draw probability shrinks with rating gap
    pd = 0.27 * np.exp(-(dr / 500.0) ** 2)
    pw = we - pd / 2
    pl = 1 - we - pd / 2
    pw, pl = max(pw, 0.01), max(pl, 0.01)
    s = pw + pd + pl
    return pw / s, pd / s, pl / s

def ko_winprob(ea, eb):
    return 1.0 / (1.0 + 10 ** (-(ea - eb) / 400.0))

def sim_group(teams):
    pts = {t: 0 for t in teams}
    gd = {t: 0.0 for t in teams}
    for i in range(4):
        for j in range(i + 1, 4):
            a, b = teams[i], teams[j]
            pw, pd, pl = match_probs(eff(a), eff(b))
            r = rng.random()
            margin = abs(rng.normal((eff(a) - eff(b)) / 250.0, 1.1))
            if r < pw:
                pts[a] += 3; gd[a] += margin; gd[b] -= margin
            elif r < pw + pd:
                pts[a] += 1; pts[b] += 1
            else:
                pts[b] += 3; gd[b] += margin; gd[a] -= margin
    order = sorted(teams, key=lambda t: (pts[t], gd[t], rng.random()), reverse=True)
    return order, pts, gd

# R32 slots: group-winner slots that face a third-placed team, with allowed source groups
third_slots = {
    "1E": set("ABCDF"), "1I": set("CDFGH"), "1A": set("CEFHI"), "1L": set("EHIJK"),
    "1D": set("BEFIJ"), "1G": set("AEHIJ"), "1B": set("EFGIJ"), "1K": set("DEIJL"),
}
slot_names = list(third_slots.keys())

def assign_thirds(qual_groups):
    """Backtracking bipartite match: assign 8 third-place groups to 8 slots."""
    qg = list(qual_groups)
    rng.shuffle(qg)
    assignment = {}
    used = set()
    def bt(i):
        if i == len(slot_names):
            return True
        slot = slot_names[i]
        for g in qg:
            if g not in used and g in third_slots[slot]:
                used.add(g); assignment[slot] = g
                if bt(i + 1):
                    return True
                used.discard(g); del assignment[slot]
        return False
    return assignment if bt(0) else None

def ko(a, b):
    return a if rng.random() < ko_winprob(eff(a, True), eff(b, True)) else b

champ = defaultdict(int); final_ = defaultdict(int); semi = defaultdict(int)
qf = defaultdict(int); r16 = defaultdict(int); adv = defaultdict(int)

for _ in range(N_SIMS):
    first, second, thirds = {}, {}, {}
    third_rank = []
    for g, teams in groups.items():
        order, pts, gd = sim_group(teams)
        first[g], second[g] = order[0], order[1]
        thirds[g] = order[2]
        third_rank.append((pts[order[2]], gd[order[2]], rng.random(), g))
    third_rank.sort(reverse=True)
    qual_thirds = {g for *_, g in third_rank[:8]}
    asg = assign_thirds(qual_thirds)
    if asg is None:
        asg = {s: g for s, g in zip(slot_names, list(qual_thirds))}

    for g in groups:
        adv[first[g]] += 1; adv[second[g]] += 1
    for g in qual_thirds:
        adv[thirds[g]] += 1

    m = {}
    m[73] = ko(second["A"], second["B"])
    m[74] = ko(first["E"], thirds[asg["1E"]])
    m[75] = ko(first["F"], second["C"])
    m[76] = ko(first["C"], second["F"])
    m[77] = ko(first["I"], thirds[asg["1I"]])
    m[78] = ko(second["E"], second["I"])
    m[79] = ko(first["A"], thirds[asg["1A"]])
    m[80] = ko(first["L"], thirds[asg["1L"]])
    m[81] = ko(first["D"], thirds[asg["1D"]])
    m[82] = ko(first["G"], thirds[asg["1G"]])
    m[83] = ko(second["K"], second["L"])
    m[84] = ko(first["H"], second["J"])
    m[85] = ko(first["B"], thirds[asg["1B"]])
    m[86] = ko(first["J"], second["H"])
    m[87] = ko(first["K"], thirds[asg["1K"]])
    m[88] = ko(second["D"], second["G"])
    for k in range(73, 89):
        r16[m[k]] += 1

    m[89] = ko(m[74], m[77]); m[90] = ko(m[73], m[75])
    m[91] = ko(m[76], m[78]); m[92] = ko(m[79], m[80])
    m[93] = ko(m[83], m[84]); m[94] = ko(m[81], m[82])
    m[95] = ko(m[86], m[88]); m[96] = ko(m[85], m[87])
    for k in range(89, 97):
        qf[m[k]] += 1

    m[97] = ko(m[89], m[90]); m[98] = ko(m[93], m[94])
    m[99] = ko(m[91], m[92]); m[100] = ko(m[95], m[96])
    for k in range(97, 101):
        semi[m[k]] += 1

    f1 = ko(m[97], m[98]); f2 = ko(m[99], m[100])
    final_[f1] += 1; final_[f2] += 1
    champ[ko(f1, f2)] += 1

print(f"{'Team':<14}{'Win%':>7}{'Final%':>8}{'Semi%':>7}{'QF%':>6}{'Adv%':>6}")
for t, c in sorted(champ.items(), key=lambda x: -x[1])[:20]:
    print(f"{t:<14}{100*c/N_SIMS:>6.1f}%{100*final_[t]/N_SIMS:>7.1f}%"
          f"{100*semi[t]/N_SIMS:>6.1f}%{100*qf[t]/N_SIMS:>5.1f}%{100*adv[t]/N_SIMS:>5.1f}%")

print("\nNorge spesifikt:")
t = "Norway"
print(f"Videre fra gruppen: {100*adv[t]/N_SIMS:.1f}% | R16: {100*r16[t]/N_SIMS:.1f}% | "
      f"QF: {100*qf[t]/N_SIMS:.1f}% | Semi: {100*semi[t]/N_SIMS:.1f}% | "
      f"Finale: {100*final_[t]/N_SIMS:.2f}% | Gull: {100*champ[t]/N_SIMS:.2f}%")
