/* VM 2026 Prediktor — Elo + Poisson, live data fra ESPN.
   Alt kjører klient-side: hent alle 104 kamper, replay Elo kronologisk,
   prediker kommende kamper og regn om live under kamp. */

"use strict";

const API =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard" +
  "?dates=20260611-20260719&limit=200";
const SUMMARY_API =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=";
const SIM_RUNS = 50000;
const SIM_CHUNK = 5000; // yield til UI-tråden mellom chunks

/* Start-Elo (≈ eloratings.net før mesterskapet). Oppdateres live av spilte kamper. */
const ELO_SEED = {
  "Spain": 2170, "Argentina": 2145, "France": 2060, "England": 2050,
  "Brazil": 2035, "Portugal": 2010, "Netherlands": 1985, "Germany": 1945,
  "Colombia": 1935, "Belgium": 1930, "Croatia": 1905, "Morocco": 1900,
  "Uruguay": 1895, "Japan": 1880, "Ecuador": 1875, "Norway": 1875,
  "Switzerland": 1855, "Mexico": 1845, "United States": 1840, "Austria": 1825,
  "Senegal": 1820, "Türkiye": 1800, "South Korea": 1785, "Canada": 1775,
  "Iran": 1770, "Paraguay": 1770, "Egypt": 1760, "Australia": 1755,
  "Algeria": 1750, "Czechia": 1745, "Ivory Coast": 1740, "Scotland": 1735,
  "Sweden": 1720, "Tunisia": 1715, "Bosnia-Herzegovina": 1710, "Panama": 1705,
  "Ghana": 1700, "South Africa": 1690, "Congo DR": 1685, "Uzbekistan": 1680,
  "Qatar": 1665, "Saudi Arabia": 1655, "Iraq": 1640, "Jordan": 1635,
  "Cape Verde": 1600, "New Zealand": 1590, "Curaçao": 1570, "Haiti": 1540,
};
const ELO_DEFAULT = 1650;
const HOSTS = new Set(["United States", "Mexico", "Canada"]);
/* Parametre backtestet på spilte VM-kamper (logloss 0,787 -> 0,765, bekreftet
   på sluttspillkamper alene). HB=100 ~ standard hjemmefordel i landskamper,
   K=30 standard for landslag, power-mapping 1,2 skjerper favoritt-splitten. */
const HOME_BONUS = 100;
const K = 30;
const MU_PRIOR = 2.55;   // prior mål per kamp; oppdateres løpende mot turneringssnittet
const MU_WEIGHT = 20;    // pseudo-kamper på prioren
const POW = 1.2;         // eksponent i Elo->lambda-splitten
const BIV = 0.4;         // bivariat Poisson: felles målkomponent (korrelerte mål)
const REG = 0.7;         // prediksjons-Elo regresseres mot seed (demper overreaksjon)
const R3_DISC = 0.5;     // K-rabatt i gruppespillets runde 3 (rotasjon/døde kamper)
let MU_CUR = MU_PRIOR;   // settes under replay, brukes av alle prediksjoner
const MAX_G = 8;

const NAME_NO = {
  "Spain": "Spania", "France": "Frankrike", "Germany": "Tyskland",
  "Netherlands": "Nederland", "Belgium": "Belgia", "Croatia": "Kroatia",
  "Austria": "Østerrike", "Switzerland": "Sveits", "Türkiye": "Tyrkia",
  "Sweden": "Sverige", "Norway": "Norge", "Scotland": "Skottland",
  "Czechia": "Tsjekkia", "Bosnia-Herzegovina": "Bosnia-Hercegovina",
  "Brazil": "Brasil", "United States": "USA", "Morocco": "Marokko",
  "Algeria": "Algerie", "Ivory Coast": "Elfenbenskysten", "Cape Verde": "Kapp Verde",
  "South Africa": "Sør-Afrika", "Congo DR": "DR Kongo", "South Korea": "Sør-Korea",
  "Iraq": "Irak", "Saudi Arabia": "Saudi-Arabia", "Uzbekistan": "Usbekistan",
  "Greece": "Hellas", "Denmark": "Danmark", "Italy": "Italia",
};

const ROUND_NO = {
  "group-stage": "Gruppespill",
  "round-of-32": "Sekstendedelsfinale",
  "round-of-16": "Åttedelsfinale",
  "quarterfinals": "Kvartfinale",
  "semifinals": "Semifinale",
  "3rd-place-match": "Bronsefinale",
  "final": "Finale",
};
const ROUND_ORDER = Object.keys(ROUND_NO);

/* ---------- state ---------- */

const S = {
  matches: [],
  elo: {},          // navn -> rating nå
  eloStart: {},     // navn -> seed brukt
  alive: new Set(), // lag som fortsatt er med
  summaries: {},    // eventId -> {stat, goals, t} fra summary-API
  sim: null,        // Monte Carlo-resultat
  modalId: null,    // åpen kamp i modal
  tab: "today",
  round: "all",
  timer: null,
};

/* ---------- matte ---------- */

function eloExp(d) { return 1 / (1 + Math.pow(10, -d / 400)); }

function poisson(k, lam) {
  let p = Math.exp(-lam);
  for (let i = 1; i <= k; i++) p *= lam / i;
  return p;
}

function lambdas(eloH, eloA, mu = MU_CUR) {
  const we = eloExp(eloH - eloA);
  const wg = Math.pow(we, POW) / (Math.pow(we, POW) + Math.pow(1 - we, POW));
  return {
    lh: Math.max(0.2, mu * wg),
    la: Math.max(0.2, mu * (1 - wg)),
  };
}

/* Dixon-Coles-korreksjon: ren Poisson undervurderer uavgjort fordi målene
   antas uavhengige. Tau justerer de fire lavscore-cellene. ρ = −0,15,
   estimert med grid-search på spilte VM-kamper (logloss 0,810 → 0,798). */
const RHO = -0.20;
function dcTau(h, a, lh, la) {
  if (h === 0 && a === 0) return 1 - lh * la * RHO;
  if (h === 0 && a === 1) return 1 + lh * RHO;
  if (h === 1 && a === 0) return 1 + la * RHO;
  if (h === 1 && a === 1) return 1 - RHO;
  return 1;
}

/* Bivariat Poisson-grid: X = x1 + x3, Y = x2 + x3, der x3 er en felles
   komponent (BIV * min(lambda)) som gir korrelerte mål og mer realistisk
   uavgjort-masse. P(H/U/B) + toppresultater. baseH/baseA = mål som allerede
   står (live). dc = Dixon-Coles på lavscore-cellene. */
function grid(lh, la, baseH = 0, baseA = 0, dc = false) {
  const l3 = BIV * Math.min(lh, la);
  const l1 = lh - l3, l2 = la - l3;
  let pH = 0, pD = 0, pA = 0;
  const merged = {};
  for (let x3 = 0; x3 <= 5; x3++) {
    const p3 = poisson(x3, l3);
    if (p3 < 1e-12) break;
    for (let x1 = 0; x1 <= MAX_G; x1++) {
      const p1 = p3 * poisson(x1, l1);
      for (let x2 = 0; x2 <= MAX_G; x2++) {
        let p = p1 * poisson(x2, l2);
        const X = x1 + x3, Y = x2 + x3;
        if (dc) p *= dcTau(X, Y, lh, la);
        const th = baseH + X, ta = baseA + Y;
        if (th > ta) pH += p; else if (th < ta) pA += p; else pD += p;
        const key = th + "-" + ta;
        merged[key] = (merged[key] || 0) + p;
      }
    }
  }
  const tot = pH + pD + pA;
  const top = Object.entries(merged)
    .map(([k, p]) => ({ k, p: p / tot }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 5);
  return { pH: pH / tot, pD: pD / tot, pA: pA / tot, top };
}

/* Full prediksjon før kamp. Knockout: + sannsynlighet for å gå videre
   (ekstraomganger = 1/3 intensitet, straffer 50/50). */
function predict(eloH, eloA, knockout) {
  const { lh, la } = lambdas(eloH, eloA);
  const g = grid(lh, la, 0, 0, true);
  let adv = null;
  if (knockout) {
    const et = grid(lh / 3, la / 3);
    const winEt = et.pH + et.pD * 0.5;
    adv = g.pH + g.pD * winEt;
  }
  return { ...g, lh, la, adv };
}

/* Live: gjenstående tid -> restlambda, justert for kampbildet
   (skudd på mål + possession + røde kort), regnet om gitt stillingen. */
function predictLive(m) {
  const eloH = teamElo(m.home.name) + hostBonus(m.home.name);
  const eloA = teamElo(m.away.name);
  const { lh, la } = lambdas(eloH, eloA);
  const played = Math.min(m.clockMin ?? 0, 90);
  const rem = remainingGoalShare(played); // empirisk måltiming, ikke lineær tid

  let mh = 1, ma = 1, statsUsed = false;
  const sum = S.summaries[m.id];
  const sh = sum?.stat?.[m.home.id], sa = sum?.stat?.[m.away.id];
  if (sh && sa && played >= 15) { // trenger litt kamp før statistikken sier noe
    const sotShare = (sh.sot + 1) / ((sh.sot || 0) + (sa.sot || 0) + 2);
    const possShare = sh.poss != null && sa.poss != null && sh.poss + sa.poss > 0
      ? sh.poss / (sh.poss + sa.poss) : 0.5;
    const mix = 0.7 * sotShare + 0.3 * possShare; // dominans, 0..1
    mh = 0.6 + 0.8 * mix;
    ma = 0.6 + 0.8 * (1 - mix);
    if (sh.red) { mh *= Math.pow(0.7, sh.red); ma *= Math.pow(1.15, sh.red); }
    if (sa.red) { ma *= Math.pow(0.7, sa.red); mh *= Math.pow(1.15, sa.red); }
    statsUsed = true;
  }

  const g = grid(lh * rem * mh, la * rem * ma, m.home.score, m.away.score);
  let adv = null;
  if (m.knockout) {
    const et = grid((lh * mh) / 3, (la * ma) / 3);
    adv = g.pH + g.pD * (et.pH + et.pD * 0.5);
  }
  return { ...g, adv, statsUsed };
}

/* Prediksjons-Elo: regressert mot seed — turnerings-Elo på 4-6 kamper
   overreagerer, så vi tror 70 % på bevegelsen. Rå verdi vises i tabellen. */
function teamElo(name) {
  const seed = S.eloStart[name] ?? ELO_SEED[name] ?? ELO_DEFAULT;
  const cur = S.elo[name] ?? seed;
  return seed + REG * (cur - seed);
}
function teamEloRaw(name) { return S.elo[name] ?? ELO_SEED[name] ?? ELO_DEFAULT; }
function hostBonus(name) { return HOSTS.has(name) ? HOME_BONUS : 0; }

/* ---------- data ---------- */

function isTBD(name) { return /Winner|Loser|TBD/i.test(name); }

function tbdNo(name) {
  return name
    .replace(/^Round of 32 (\d+) Winner$/, "Vinner 16.-delsfinale $1")
    .replace(/^Round of 16 (\d+) Winner$/, "Vinner åttedelsfinale $1")
    .replace(/^Quarterfinal (\d+) Winner$/, "Vinner kvartfinale $1")
    .replace(/^Semifinal (\d+) Winner$/, "Vinner semifinale $1")
    .replace(/^Semifinal (\d+) Loser$/, "Taper semifinale $1");
}

function teamNo(name) {
  if (isTBD(name)) return tbdNo(name);
  return NAME_NO[name] || name;
}

function parseEvent(ev) {
  const c = ev.competitions[0];
  const comps = [...c.competitors].sort((x) => (x.homeAway === "home" ? -1 : 1));
  const [h, a] = comps;
  const st = ev.status.type;
  const note = (c.altGameNote || "").replace("FIFA World Cup, ", "");
  const groupMatch = note.match(/Group ([A-L])/);

  const team = (x) => ({
    id: x.team.id,
    name: x.team.displayName,
    no: teamNo(x.team.displayName),
    abbr: x.team.abbreviation,
    logo: x.team.logo || null,
    score: x.score != null ? parseInt(x.score, 10) : null,
    pens: x.shootoutScore ?? null,
    winner: x.winner === true,
    tbd: isTBD(x.team.displayName),
  });

  /* markedets sannsynligheter (renset for margin) + rå decimal-odds (for EV) */
  const american = (o) => (o == null || isNaN(o) ? null : o > 0 ? 100 / (o + 100) : -o / (-o + 100));
  const decimal = (o) => (o == null || isNaN(o) ? null : o > 0 ? 1 + o / 100 : 1 + 100 / -o);
  let market = null;
  const odds = (c.odds || []).find((o) => o && (o.moneyline || o.homeTeamOdds));
  if (odds) {
    const rawH = parseFloat(odds.homeTeamOdds?.moneyLine ?? odds.moneyline?.home?.close?.odds);
    const rawA = parseFloat(odds.awayTeamOdds?.moneyLine ?? odds.moneyline?.away?.close?.odds);
    const rawD = parseFloat(odds.drawOdds?.moneyLine);
    const ph = american(rawH), pa = american(rawA), pd = american(rawD);
    if (ph && pa && pd) {
      const s = ph + pd + pa;
      market = {
        pH: ph / s, pD: pd / s, pA: pa / s,
        oH: decimal(rawH), oD: decimal(rawD), oA: decimal(rawA),
        provider: odds.provider?.name || "Marked",
      };
    }
  }

  let clockMin = null;
  if (st.state === "in") {
    const mm = String(ev.status.displayClock || "").match(/(\d+)/);
    clockMin = mm ? parseInt(mm[1], 10) : Math.round((ev.status.clock || 0) / 60);
  }

  return {
    id: ev.id,
    date: new Date(ev.date),
    round: ev.season.slug,
    knockout: ev.season.slug !== "group-stage",
    group: groupMatch ? "Gruppe " + groupMatch[1] : null,
    state: st.state, // pre | in | post
    statusDetail: st.detail,
    aet: st.name === "STATUS_FINAL_AET",
    pens: st.name === "STATUS_FINAL_PEN",
    clock: ev.status.displayClock,
    clockMin,
    venue: c.venue ? c.venue.fullName : "",
    city: c.venue && c.venue.address ? c.venue.address.city : "",
    home: team(h),
    away: team(a),
    market,
    pred: null, // settes under replay / prediksjon
  };
}

/* ---------- summary-API: kampstatistikk + målscorere ---------- */

async function fetchSummary(id) {
  try {
    const res = await fetchT(SUMMARY_API + id);
    if (!res.ok) return;
    const s = await res.json();
    const stat = {};
    for (const t of s.boxscore?.teams || []) {
      const get = (n) => {
        const x = (t.statistics || []).find((y) => y.name === n);
        return x && x.displayValue != null ? parseFloat(x.displayValue) : null;
      };
      stat[t.team.id] = {
        poss: get("possessionPct"), shots: get("totalShots"), sot: get("shotsOnTarget"),
        corners: get("wonCorners"), yellow: get("yellowCards"), red: get("redCards"),
        saves: get("saves"), fouls: get("foulsCommitted"),
      };
    }
    const goals = (s.keyEvents || [])
      .filter((k) => {
        const t = (k.type?.text || "").toLowerCase();
        return t === "goal" || t === "own goal" || t === "penalty - scored";
      })
      .map((k) => ({ clock: k.clock?.displayValue || "", text: k.text || "" }));
    const reds = (s.keyEvents || [])
      .filter((k) => /red card/i.test(k.type?.text || ""))
      .map((k) => ({ clock: k.clock?.displayValue || "", text: k.text || "" }));

    // målscorere + tidfestede mål: stillingsendringen i målteksten avslører siden
    const scorers = [];
    const wpGoals = []; // {min, side} for kampforløps-grafen (ordinær tid)
    let ph = 0;
    for (const k of s.keyEvents || []) {
      const t = (k.type?.text || "").toLowerCase();
      if (t !== "goal" && t !== "penalty - scored" && t !== "own goal") continue;
      const sc = (k.text || "").match(/(\d+),[^,]*?(\d+)\./);
      if (!sc) continue;
      const nh = +sc[1];
      const side = nh > ph ? "home" : "away";
      const cm = (k.clock?.displayValue || "").match(/^(\d+)'/);
      if (cm && +cm[1] <= 90) wpGoals.push({ min: +cm[1], side });
      if (t !== "own goal") {
        const pm = (k.text || "").match(/\.\s*([A-ZÆØÅÀ-ž][^().]*?)\s*\(/);
        if (pm) scorers.push({ player: pm[1].trim(), side });
      }
      ph = nh;
    }

    // innbyrdes oppgjør (siste 5)
    const h2h = (s.headToHeadGames?.[0]?.events || []).slice(0, 5).map((ev) => ({
      date: ev.gameDate, homeId: ev.homeTeamId, awayId: ev.awayTeamId,
      hs: ev.homeTeamScore, as: ev.awayTeamScore, league: ev.leagueName,
    }));

    // historiske odds: scoreboard nuller odds etter kampslutt, summary beholder dem
    let market = null;
    const pc = (s.pickcenter || s.odds || []).find((o) => o && (o.homeTeamOdds || o.moneyline));
    if (pc) {
      const am = (o) => (o == null || isNaN(o) ? null : o > 0 ? 100 / (o + 100) : -o / (-o + 100));
      const dec = (o) => (o == null || isNaN(o) ? null : o > 0 ? 1 + o / 100 : 1 + 100 / -o);
      const rawH = parseFloat(pc.homeTeamOdds?.moneyLine ?? pc.moneyline?.home?.close?.odds);
      const rawA = parseFloat(pc.awayTeamOdds?.moneyLine ?? pc.moneyline?.away?.close?.odds);
      const rawD = parseFloat(pc.drawOdds?.moneyLine);
      const ph = am(rawH), pa = am(rawA), pd = am(rawD);
      if (ph && pa && pd) {
        const t = ph + pd + pa;
        market = { pH: ph / t, pD: pd / t, pA: pa / t,
          oH: dec(rawH), oD: dec(rawD), oA: dec(rawA),
          provider: pc.provider?.name || "DraftKings" };
        const m = S.matches.find((x) => x.id === id);
        if (m && !m.market) m.market = market;
        try {
          const st = JSON.parse(localStorage.getItem("vm26_odds_v1") || "{}");
          if (!st[id]) { st[id] = market; localStorage.setItem("vm26_odds_v1", JSON.stringify(st)); }
        } catch { /* privat modus */ }
      }
    }

    S.summaries[id] = { stat, goals, reds, scorers, wpGoals, h2h, market, t: Date.now() };
  } catch { /* summary er nice-to-have, aldri blokkerende */ }
}

/* Replay alle spilte kamper kronologisk: lagre pre-kamp-prediksjon
   (ærlig out-of-sample) og oppdater Elo. */
function replayElo() {
  S.elo = {};
  S.eloStart = {};
  for (const m of S.matches) {
    for (const t of [m.home, m.away]) {
      if (t.tbd) continue;
      if (!(t.name in S.elo)) {
        const seed = ELO_SEED[t.name] ?? ELO_DEFAULT;
        S.elo[t.name] = seed;
        S.eloStart[t.name] = seed;
      }
    }
  }

  const played = S.matches
    .filter((m) => m.state === "post" && !m.home.tbd && !m.away.tbd)
    .sort((x, y) => x.date - y.date);

  // løpende målsnitt: prior 2,55 vektet som 20 kamper, oppdateres kronologisk
  MU_CUR = MU_PRIOR;
  let cumG = 0, cumM = 0;
  const groupGames = {}; // for K-rabatt i gruppespillets runde 3

  for (const m of played) {
    // prediksjon med regressert Elo (slik den var før kampen)
    const seedH = S.eloStart[m.home.name], seedA = S.eloStart[m.away.name];
    const predH = seedH + REG * (S.elo[m.home.name] - seedH) + hostBonus(m.home.name);
    const predA = seedA + REG * (S.elo[m.away.name] - seedA);
    m.pred = predict(predH, predA, m.knockout);

    const gh = m.home.score, ga = m.away.score;
    cumG += gh + ga; cumM++;
    MU_CUR = (MU_PRIOR * MU_WEIGHT + cumG) / (MU_WEIGHT + cumM);

    // Elo-oppdatering med rå ratinger; runde 3 i gruppespillet teller halvt
    let kx = K;
    if (!m.knockout) {
      const gr = Math.max(groupGames[m.home.name] || 0, groupGames[m.away.name] || 0) + 1;
      if (gr === 3) kx = K * R3_DISC;
      groupGames[m.home.name] = (groupGames[m.home.name] || 0) + 1;
      groupGames[m.away.name] = (groupGames[m.away.name] || 0) + 1;
    }
    const res = gh > ga ? 1 : gh < ga ? 0 : 0.5;
    const gd = Math.abs(gh - ga);
    const G = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    const we = eloExp(S.elo[m.home.name] + hostBonus(m.home.name) - S.elo[m.away.name]);
    const delta = kx * G * (res - we);
    S.elo[m.home.name] += delta;
    S.elo[m.away.name] -= delta;
  }

  // prediksjoner for kommende/live kamper med kjente lag (regressert Elo)
  for (const m of S.matches) {
    if (m.state === "post" || m.home.tbd || m.away.tbd) continue;
    m.pred = predict(teamElo(m.home.name) + hostBonus(m.home.name), teamElo(m.away.name), m.knockout);
    if (m.state === "in") m.livePred = predictLive(m);
  }

  // hvem er fortsatt med: alle lag minus tapere i sluttspill / gruppespill-exit
  S.alive = new Set(Object.keys(S.elo));
  for (const m of S.matches) {
    if (m.state !== "post" || !m.knockout || m.home.tbd || m.away.tbd) continue;
    if (m.round === "3rd-place-match") continue;
    const loser = m.home.winner ? m.away : m.home.winner === m.away.winner ? null : m.home;
    if (loser) S.alive.delete(loser.name);
  }
  // lag som ikke nådde sluttspillet
  const inKO = new Set();
  for (const m of S.matches) {
    if (m.knockout && !m.home.tbd) inKO.add(m.home.name);
    if (m.knockout && !m.away.tbd) inKO.add(m.away.name);
  }
  const groupDone = S.matches.filter((m) => m.round === "group-stage" && m.state === "post").length;
  if (groupDone >= 72) {
    for (const t of Object.keys(S.elo)) if (!inKO.has(t)) S.alive.delete(t);
  }
}

/* ---------- lagstatistikk: corner- og kortrater fra spilte kamper ---------- */

const STATS_KEY = "vm26_teamstats_v4";

/* Måltiming: andel av ordinær-tids-mål per 15-min-bolk. Fallback = målt på
   turneringen t.o.m. 3. juli (n=215); erstattes av løpende data når nok mål. */
const GOAL_TIMING_PRIOR = [0.14, 0.12, 0.17, 0.18, 0.13, 0.26];

function goalTimingShares() {
  const gm = S.teamStats?.gm;
  if (gm && S.teamStats.gmN >= 120) {
    const tot = gm.reduce((a, b) => a + b, 0) || 1;
    return gm.map((x) => x / tot);
  }
  return GOAL_TIMING_PRIOR;
}

/* Andel av kampens målproduksjon som gjenstår ved minutt t (0..90).
   Lineær tid undervurderer sene mål grovt — 26 % av målene kommer etter 75'. */
function remainingGoalShare(t) {
  const shares = goalTimingShares();
  const cum = [0];
  for (const s of shares) cum.push(cum[cum.length - 1] + s);
  const tc = Math.min(Math.max(t, 0), 90);
  const i = Math.min(5, Math.floor(tc / 15));
  const frac = (tc - i * 15) / 15;
  const done = cum[i] + (cum[i + 1] - cum[i]) * frac;
  return Math.max(0.02, 1 - done / cum[6]);
}

async function buildTeamStats() {
  const st = JSON.parse(localStorage.getItem(STATS_KEY) || "null") || { done: [], teams: {}, scorers: {} };
  st.scorers = st.scorers || {};
  st.gm = st.gm || [0, 0, 0, 0, 0, 0]; // mål per 15-min-bolk (ordinær tid)
  st.gmN = st.gmN || 0;
  st.lateMatches = st.lateMatches || 0; // kamper med mål etter 75'
  st.evMatches = st.evMatches || 0;     // kamper med hendelseslogg
  const doneSet = new Set(st.done);
  const todo = S.matches.filter((m) => m.state === "post" && !m.home.tbd && !m.away.tbd && !doneSet.has(m.id));

  for (let i = 0; i < todo.length; i += 8) {
    const batch = todo.slice(i, i + 8);
    await Promise.all(batch.map((m) => S.summaries[m.id] ? null : fetchSummary(m.id)));
    for (const m of batch) {
      const sum = S.summaries[m.id];
      const sh = sum?.stat?.[m.home.id], sa = sum?.stat?.[m.away.id];
      if (!sh || !sa || sh.corners == null) continue;
      const add = (name, own, opp) => {
        const t = st.teams[name] || (st.teams[name] = { g: 0, cf: 0, ca: 0, y: 0 });
        t.g++; t.cf += own.corners || 0; t.ca += opp.corners || 0; t.y += own.yellow || 0;
      };
      add(m.home.name, sh, sa);
      add(m.away.name, sa, sh);
      for (const sc of sum.scorers || []) {
        const team = sc.side === "home" ? m.home.name : m.away.name;
        const key = sc.player + "|" + team;
        st.scorers[key] = (st.scorers[key] || 0) + 1;
      }
      // måltiming fra hendelsesloggen
      if ((sum.goals || []).length) {
        st.evMatches++;
        let late = false;
        for (const g of sum.goals) {
          const mm = (g.clock || "").match(/^(\d+)'/);
          if (!mm) continue;
          const min = +mm[1];
          if (min > 90) continue; // e.o. holdes utenfor timing-kurven
          st.gm[Math.min(5, Math.max(0, Math.ceil(min / 15) - 1))]++;
          st.gmN++;
          if (min >= 76) late = true;
        }
        if (late) st.lateMatches++;
      }
      st.done.push(m.id);
    }
  }
  try { localStorage.setItem(STATS_KEY, JSON.stringify(st)); } catch { /* full/privat modus */ }
  S.teamStats = st;
  if (S.tab === "power" || S.tab === "bets") renderContent(); // toppscorere/regnskap kan ha kommet
}

/* Poisson-baserte markeder for en kommende kamp: mål-O/U + BTTS fra
   målmodellen, cornere og gule kort fra lagenes turneringsrater
   (attack x defense-justert, krympet mot snittet ved få kamper). */
function markets(m) {
  const eloH = teamElo(m.home.name) + hostBonus(m.home.name);
  const { lh, la } = lambdas(eloH, teamElo(m.away.name));

  // målmarkeder — bivariat + Dixon-Coles, som hovedmodellen
  let pO15 = 0, pO25 = 0, pO35 = 0, pBTTS = 0, totG = 0;
  const l3 = BIV * Math.min(lh, la), l1 = lh - l3, l2 = la - l3;
  for (let x3 = 0; x3 <= 5; x3++) {
    const p3 = poisson(x3, l3);
    if (p3 < 1e-12) break;
    for (let x1 = 0; x1 <= MAX_G; x1++) {
      const p1 = p3 * poisson(x1, l1);
      for (let x2 = 0; x2 <= MAX_G; x2++) {
        const X = x1 + x3, Y = x2 + x3;
        const p = p1 * poisson(x2, l2) * dcTau(X, Y, lh, la);
        totG += p;
        const T = X + Y;
        if (T > 1.5) pO15 += p;
        if (T > 2.5) pO25 += p;
        if (T > 3.5) pO35 += p;
        if (X > 0 && Y > 0) pBTTS += p;
      }
    }
  }
  pO15 /= totG; pO25 /= totG; pO35 /= totG; pBTTS /= totG;

  let corners = null, cards = null;
  const ts = S.teamStats?.teams;
  const A = ts?.[m.home.name], B = ts?.[m.away.name];
  if (A && B && A.g >= 2 && B.g >= 2) {
    const all = Object.values(ts).filter((t) => t.g > 0);
    const avgC = all.reduce((s, t) => s + t.cf, 0) / all.reduce((s, t) => s + t.g, 0); // per lag per kamp
    const avgY = all.reduce((s, t) => s + t.y, 0) / all.reduce((s, t) => s + t.g, 0);
    const K = 2; // pseudo-kamper shrinkage
    const rate = (num, g, avg) => (num + K * avg) / (g + K);
    const lcA = rate(A.cf, A.g, avgC) * (rate(B.ca, B.g, avgC) / avgC);
    const lcB = rate(B.cf, B.g, avgC) * (rate(A.ca, A.g, avgC) / avgC);
    const lcT = lcA + lcB;
    const line = Math.round(lcT) - 0.5;
    let pOver = 0;
    for (let k = 0; k <= 30; k++) if (k > line) pOver += poisson(k, lcT);
    // flest cornere: P(A > B) over uavhengige Poisson
    let pAflest = 0, pLikt = 0;
    for (let x = 0; x <= 25; x++) {
      const px = poisson(x, lcA);
      for (let y = 0; y <= 25; y++) {
        const p = px * poisson(y, lcB);
        if (x > y) pAflest += p; else if (x === y) pLikt += p;
      }
    }
    corners = { lcA, lcB, lcT, line, pOver, pAflest, pBflest: 1 - pAflest - pLikt };

    const lyT = rate(A.y, A.g, avgY) + rate(B.y, B.g, avgY);
    const lineY = Math.round(lyT) + 0.5;
    let pOverY = 0;
    for (let k = 0; k <= 20; k++) if (k > lineY) pOverY += poisson(k, lyT);
    cards = { lyT, lineY, pOverY };
  }

  return { pO15, pO25, pO35, pBTTS, corners, cards };
}

/* ---------- bets: modellens picks på tvers av markeder ---------- */

function betCandidates() {
  const out = [];
  const upcoming = S.matches
    .filter((m) => m.state === "pre" && !m.home.tbd && !m.away.tbd && m.pred)
    .sort((a, b) => a.date - b.date);
  for (const m of upcoming) {
    const p = m.pred;
    const mk = markets(m);
    const push = (market, prob, marketProb = null, dk = null) =>
      out.push({
        m, market, prob, marketProb, dk,
        fair: prob > 0.01 ? 1 / prob : null,
        edge: marketProb != null ? prob - marketProb : null,
        ev: dk ? prob * dk - 1 : null,
      });
    push(`${m.home.no} vinner`, p.pH, m.market?.pH ?? null, m.market?.oH ?? null);
    push("Uavgjort", p.pD, m.market?.pD ?? null, m.market?.oD ?? null);
    push(`${m.away.no} vinner`, p.pA, m.market?.pA ?? null, m.market?.oA ?? null);
    push(`Dobbeltsjanse ${m.home.no}/uavgjort`, p.pH + p.pD);
    push(`Dobbeltsjanse ${m.away.no}/uavgjort`, p.pA + p.pD);
    push("Over 1,5 mål", mk.pO15);
    push("Under 1,5 mål", 1 - mk.pO15);
    push("Over 2,5 mål", mk.pO25);
    push("Under 2,5 mål", 1 - mk.pO25);
    push("Over 3,5 mål", mk.pO35);
    push("Under 3,5 mål", 1 - mk.pO35);
    push("Begge lag scorer", mk.pBTTS);
    push("Ikke begge lag scorer", 1 - mk.pBTTS);
    if (m.knockout && p.adv != null) {
      push(`${m.home.no} videre`, p.adv);
      push(`${m.away.no} videre`, 1 - p.adv);
    }
    if (mk.corners) {
      const ln = String(mk.corners.line).replace(".", ",");
      push(`Over ${ln} cornere`, mk.corners.pOver);
      push(`Under ${ln} cornere`, 1 - mk.corners.pOver);
      const fav = mk.corners.pAflest >= mk.corners.pBflest
        ? [`Flest cornere: ${m.home.no}`, mk.corners.pAflest]
        : [`Flest cornere: ${m.away.no}`, mk.corners.pBflest];
      push(fav[0], fav[1]);
    }
    if (mk.cards) {
      const ln = String(mk.cards.lineY).replace(".", ",");
      push(`Over ${ln} gule kort`, mk.cards.pOverY);
      push(`Under ${ln} gule kort`, 1 - mk.cards.pOverY);
    }
  }
  return out;
}

/* value-regnskapet: modell vs DraftKings på alle spilte kamper med odds */
function valueLedger() {
  let n = 0, llM = 0, llB = 0, vCount = 0, vWins = 0, vExp = 0;
  for (const m of S.matches) {
    if (m.state !== "post" || !m.pred || !m.market) continue;
    const o = outcomeOf(m);
    const pm = o === "H" ? m.pred.pH : o === "D" ? m.pred.pD : m.pred.pA;
    const pb = o === "H" ? m.market.pH : o === "D" ? m.market.pD : m.market.pA;
    llM += -Math.log(Math.max(pm, 1e-9));
    llB += -Math.log(Math.max(pb, 1e-9));
    n++;
    const edges = [
      ["H", m.pred.pH - m.market.pH, m.pred.pH],
      ["D", m.pred.pD - m.market.pD, m.pred.pD],
      ["A", m.pred.pA - m.market.pA, m.pred.pA],
    ].sort((a, b) => b[1] - a[1]);
    if (edges[0][1] >= 0.06) {
      vCount++; vExp += edges[0][2];
      if (edges[0][0] === o) vWins++;
    }
  }
  return { n, llM: n ? llM / n : 0, llB: n ? llB / n : 0, vCount, vWins, vExp };
}

/* Turneringsinnsikt: aggregert fra alle spilte kamper */
function insightsHTML() {
  const st = S.teamStats;
  const played = S.matches.filter((m) => m.state === "post");
  if (!played.length) return "";

  // BTTS / over 2,5 / snitt regnes fra scoreboard (komplett), timing fra hendelseslogger
  const btts = played.filter((m) => m.home.score > 0 && m.away.score > 0).length;
  const o25 = played.filter((m) => m.home.score + m.away.score > 2.5).length;
  const goals = played.reduce((s, m) => s + m.home.score + m.away.score, 0);

  let timingHtml = "";
  if (st && st.gmN >= 60) {
    const labels = ["1–15", "16–30", "31–45+", "46–60", "61–75", "76–90+"];
    const max = Math.max(...st.gm);
    const h2share = Math.round(((st.gm[3] + st.gm[4] + st.gm[5]) / st.gmN) * 100);
    const lateShare = Math.round((st.gm[5] / st.gmN) * 100);
    const lateMatchShare = st.evMatches ? Math.round((st.lateMatches / st.evMatches) * 100) : 0;
    timingHtml = `
      <div class="ins-chart">
        ${st.gm.map((n, i) => `
          <div class="ins-col">
            <div class="ins-val">${n}</div>
            <div class="ins-bar"><i style="height:${(n / max) * 100}%"></i></div>
            <div class="ins-lbl">${labels[i]}'</div>
          </div>`).join("")}
      </div>
      <div class="ins-facts">
        <span><b>${h2share} %</b> av målene kommer i 2. omgang</span>
        <span><b>${lateShare} %</b> etter 75. minutt</span>
        <span><b>${lateMatchShare} %</b> av kampene har mål etter 75'</span>
        <span><b>${Math.round((btts / played.length) * 100)} %</b> begge lag scorer</span>
        <span><b>${Math.round((o25 / played.length) * 100)} %</b> over 2,5 mål</span>
        <span><b>${(goals / played.length).toFixed(2).replace(".", ",")}</b> mål per kamp</span>
      </div>
      <p class="mvm-note">Måltiming fra ESPNs hendelseslogger (${st.evMatches} kamper, ${st.gmN} mål i ordinær tid). Live-modellen bruker denne kurven i stedet for lineær tid — derfor faller ikke vinnersannsynligheten «for fort» for laget som jager sent i kampen.</p>`;
  }

  return `<div class="br-sec" style="margin-top:34px">Turneringsinnsikt</div>${timingHtml || `<p class="mvm-note">Måltiming-data lastes i bakgrunnen…</p>`}`;
}

function betsHTML() {
  const cands = betCandidates();
  if (!cands.length) return `<div class="empty">Ingen kommende kamper med kjente lag akkurat nå.</div>`;

  const fmtOdds = (o) => o != null ? o.toFixed(2).replace(".", ",") : "–";
  const soon = Date.now() + 48 * 3600 * 1000;

  // spillbart = fair odds >= 1,40 (p <= ~71 %) og ikke ren longshot (p >= 25 %)
  const playable = cands.filter((c) => c.prob <= 0.72 && c.prob >= 0.25);

  // EV-bets: der vi har rå DK-odds. EV = p * odds - 1 (inkl. bookmaker-margin)
  const evBets = playable.filter((c) => c.ev != null).sort((a, b) => b.ev - a.ev);
  // modellens beste picks uten markedsodds: sortert på sannsynlighet innen spillbart bånd
  const modelBets = playable.filter((c) => c.ev == null).sort((a, b) => b.prob - a.prob).slice(0, 10);

  // dagens bet: beste positive EV innen 48t; fallback beste spillbare pick
  const hero = evBets.find((c) => c.ev > 0 && c.m.date < soon)
    || playable.filter((c) => c.m.date < soon).sort((a, b) => (b.ev ?? b.prob - 1) - (a.ev ?? a.prob - 1))[0]
    || null;

  const heroHtml = hero ? `
    <div class="bet-hero" data-id="${hero.m.id}">
      <div class="bh-label">Dagens bet</div>
      <div class="bh-market">${esc(hero.market)}</div>
      <div class="bh-match">${esc(hero.m.home.no)} – ${esc(hero.m.away.no)} · ${cap(fmtDayKey(hero.m.date))} ${fmtTime(hero.m.date)}</div>
      <div class="bh-nums">
        <span><b>${pct(hero.prob)}</b> modell</span>
        <span><b>${fmtOdds(hero.fair)}</b> fair odds</span>
        ${hero.dk != null ? `<span><b>${fmtOdds(hero.dk)}</b> DraftKings</span>` : ""}
        ${hero.ev != null ? `<span class="bh-edge"><b>${hero.ev > 0 ? "+" : ""}${(hero.ev * 100).toFixed(1).replace(".", ",")} %</b> EV</span>` : ""}
      </div>
    </div>` : "";

  const betRow = (c, mode) => `
    <tr class="bet-row" data-id="${c.m.id}">
      <td>${esc(c.market)}</td>
      <td class="bmatchname">${esc(c.m.home.abbr)}–${esc(c.m.away.abbr)} · ${fmtTime(c.m.date)}</td>
      <td class="num win">${pct(c.prob)}</td>
      <td class="num">${fmtOdds(c.fair)}</td>
      ${mode === "ev" ? `<td class="num">${fmtOdds(c.dk)}</td>
      <td class="num ${c.ev > 0 ? "up" : "down"}">${c.ev > 0 ? "+" : ""}${(c.ev * 100).toFixed(1).replace(".", ",")} %</td>` : ""}
    </tr>`;

  const led = valueLedger();
  const diff = led.llB - led.llM;
  const ledHtml = led.n ? `
    <div class="br-sec">Regnskapet: modell vs. DraftKings</div>
    <div class="ledger">
      <div class="led-card"><div class="v">${led.llM.toFixed(3).replace(".", ",")}</div><div class="k">Modellens logloss (${led.n} kamper)</div></div>
      <div class="led-card"><div class="v">${led.llB.toFixed(3).replace(".", ",")}</div><div class="k">DraftKings' logloss</div></div>
      <div class="led-card ${diff >= 0 ? "good" : "bad"}"><div class="v">${diff >= 0 ? "Modellen" : "Markedet"}</div><div class="k">leder med ${Math.abs(diff).toFixed(3).replace(".", ",")}</div></div>
      <div class="led-card"><div class="v">${led.vWins} / ${led.vCount}</div><div class="k">Value-flagg som traff (forventet ≈ ${led.vExp.toFixed(1).replace(".", ",")})</div></div>
    </div>
    <p class="mvm-note">Logloss = straff for feil sannsynligheter, lavere er bedre. Value-flagg = kamper der modellen avvek 6+ pp fra markedet; «forventet» er summen av modellens egne sannsynligheter på de valgene. <b>Ærlig forbehold:</b> modellens parametre er tunet på disse kampene, mens DraftKings' odds er ekte out-of-sample — så historikken flatterer modellen. Regnskapet teller for alvor fra i dag og fremover.</p>` : "";

  return `
    <p class="sim-intro">Kun bets i spillbart oddsområde (fair odds 1,40–4,00) — 99 %-dobbeltsjanser til odds 1,05 er ikke bets. Der DraftKings-odds finnes vises <b>EV</b> = modellens sannsynlighet × odds − 1; positiv EV betyr at modellen mener oddsen er feilpriset (inkl. bookmakerens margin). Klikk en rad for kampdetaljer. Ikke betting-råd — modellen vet ingenting om skader eller rotasjon.</p>
    ${heroHtml}
    <div class="br-sec">EV mot DraftKings (1X2)</div>
    ${evBets.length ? `<div class="table-scroll"><table class="power-table bets-table">
      <thead><tr><th>Marked</th><th>Kamp</th><th style="text-align:right">Modell</th><th style="text-align:right">Fair</th><th style="text-align:right">DK-odds</th><th style="text-align:right">EV</th></tr></thead>
      <tbody>${evBets.slice(0, 8).map((c) => betRow(c, "ev")).join("")}</tbody>
    </table></div>
    <p class="mvm-note">Negativ EV = markedet priser bedre enn modellen tror — som er normaltilstanden mot closing-odds. Positiv EV er uenighet, ikke garantert verdi.</p>`
    : `<p class="mvm-note">Ingen kommende kamper med DraftKings-odds i spillbart område akkurat nå.</p>`}
    <div class="br-sec">Modellens beste picks uten markedsodds</div>
    <div class="table-scroll"><table class="power-table bets-table">
      <thead><tr><th>Marked</th><th>Kamp</th><th style="text-align:right">Modell</th><th style="text-align:right">Fair odds</th></tr></thead>
      <tbody>${modelBets.map((c) => betRow(c, "plain")).join("")}</tbody>
    </table></div>
    ${ledHtml}
    ${insightsHTML()}`;
}

/* ---------- Monte Carlo: simuler resten av sluttspillet ---------- */

function samplePoisson(lam) {
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

const REF_RE = /^(Round of 32|Round of 16|Quarterfinal|Semifinal) (\d+) (Winner|Loser)$/;
const REF_ROUND = {
  "Round of 32": "round-of-32", "Round of 16": "round-of-16",
  "Quarterfinal": "quarterfinals", "Semifinal": "semifinals",
};
const SIM_ROUNDS = ["round-of-32", "round-of-16", "quarterfinals", "semifinals", "3rd-place-match", "final"];
const PREV_OF = {
  "final": "semifinals", "3rd-place-match": "semifinals", "semifinals": "quarterfinals",
  "quarterfinals": "round-of-16", "round-of-16": "round-of-32",
};

/* Slot-kilder for hele sluttspillet: {fixed: navn} eller {ref: kampId, loser}.
   To ESPN-særheter håndteres:
   1) Slots pre-fylles (med winner-flagg) mens feeder-kampen pågår — et navn er
      derfor bare «fast» når feeder-kampen er ferdigspilt.
   2) Pre-fyllingen kan lande i feil slot (sett live: «R32 11 Winner vs Spania»
      der Spania sto i kamp 11 og slotten egentlig var «R32 12 Winner»).
      Repareres med eliminasjon: kolliderer to slots om samme feeder, flyttes
      den pre-fylte til den eneste ukonsumerte kampen i forrige runde. */
function koSources(cutoff = Infinity) {
  const by = {};
  for (const r of SIM_ROUNDS) by[r] = S.matches.filter((m) => m.round === r).sort((a, b) => a.date - b.date);
  // «spilt» relativt til cutoff — lar oss rekonstruere turneringstilstanden bakover i tid
  const isPost = (m) => m.state === "post" && m.date.getTime() <= cutoff;

  const srcs = {};
  for (const r of SIM_ROUNDS) {
    const prev = by[PREV_OF[r]] || [];
    const claims = {};   // "id:W"/"id:L" -> [soft-kilder]
    const consumed = new Set();

    for (const m of by[r]) {
      srcs[m.id] = {};
      for (const side of ["home", "away"]) {
        const t = m[side];
        let s, feederId = null, kind = "W";
        if (t.tbd) {
          const mm = t.name.match(REF_RE);
          const f = mm ? by[REF_ROUND[mm[1]]][+mm[2] - 1] : null;
          s = f ? { ref: f.id, loser: mm[3] === "Loser", hard: true } : {};
          if (f) { feederId = f.id; kind = s.loser ? "L" : "W"; }
        } else {
          const f = prev.find((pm) => pm.home.name === t.name || pm.away.name === t.name);
          if (f && !isPost(f)) {
            s = { ref: f.id, loser: false, movable: true };
            feederId = f.id;
          } else {
            s = { fixed: t.name };
            if (f) {
              feederId = f.id;
              const wn = f.home.winner ? f.home.name : f.away.winner ? f.away.name : null;
              kind = wn === t.name ? "W" : "L";
              s.movable = true; // pre-fyll kan ligge i feil slot selv etter kampslutt
            }
          }
        }
        srcs[m.id][side] = s;
        if (feederId) {
          consumed.add(feederId);
          const key = feederId + ":" + kind;
          (claims[key] || (claims[key] = [])).push(s);
        }
      }
    }

    // eliminasjons-reparasjon: ved kollisjon flyttes den flyttbare (pre-fylte)
    // kilden til den eneste ukonsumerte kampen i forrige runde
    for (const list of Object.values(claims)) {
      if (list.length < 2) continue;
      const movable = list.filter((s) => s.movable && !s.hard);
      const un = prev.filter((p) => !consumed.has(p.id));
      if (movable.length === 1 && un.length === 1) {
        const s = movable[0];
        delete s.fixed;
        s.ref = un[0].id;
        s.loser = false;
        consumed.add(un[0].id);
      }
    }
  }
  return { srcs, by, isPost };
}

/* Plassholderne («Round of 32 11 Winner») refererer kamp nr. N i runden,
   kronologisk — verifisert mot spilte kamper. */
/* opts: {cutoff, elo, mu, history} — brukes til å rekonstruere historiske
   turneringstilstander («slik verden så ut etter kamp k»). */
async function simulate(runs, opts = {}) {
  const cutoff = opts.cutoff ?? Infinity;
  const { srcs, by: byRound, isPost } = koSources(cutoff);
  if (!byRound["final"].length) return null;

  // rating-oppslag: enten dagens (regressert), eller et historisk elo-kart
  const getElo = opts.elo
    ? (name) => {
        const seed = S.eloStart[name] ?? ELO_SEED[name] ?? ELO_DEFAULT;
        const cur = opts.elo[name] ?? seed;
        return seed + REG * (cur - seed);
      }
    : teamElo;
  const mu = opts.mu ?? MU_CUR;

  const reach = {};
  const ensure = (t) => reach[t] || (reach[t] = { qf: 0, sf: 0, f: 0, w: 0 });
  const detail = {}; // matchId -> {home:{lag:antall}, away:{...}, win:{...}} for braketten
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

  for (let i = 0; i < runs; i++) {
    if (i > 0 && i % SIM_CHUNK === 0) await new Promise((r) => setTimeout(r, 0));
    const winners = {}, losers = {};
    const resolve = (s) => s.fixed || (s.ref ? (s.loser ? losers[s.ref] : winners[s.ref]) : null);

    for (const r of SIM_ROUNDS) {
      for (const m of byRound[r]) {
        let hN, aN, hWins;
        if (isPost(m) && !m.home.tbd && !m.away.tbd) {
          hN = m.home.name; aN = m.away.name; hWins = m.home.winner;
        } else {
          hN = resolve(srcs[m.id].home); aN = resolve(srcs[m.id].away);
          if (!hN || !aN) continue;
          const { lh, la } = lambdas(getElo(hN) + hostBonus(hN), getElo(aN), mu);
          // bivariat trekk: felles komponent gir korrelerte mål
          const l3 = BIV * Math.min(lh, la);
          const g3 = samplePoisson(l3);
          const gh = samplePoisson(lh - l3) + g3, ga = samplePoisson(la - l3) + g3;
          if (gh !== ga) hWins = gh > ga;
          else {
            const e3 = samplePoisson(l3 / 3);
            const eh = samplePoisson((lh - l3) / 3) + e3, ea = samplePoisson((la - l3) / 3) + e3;
            hWins = eh !== ea ? eh > ea : Math.random() < 0.5;
          }
        }
        winners[m.id] = hWins ? hN : aN;
        losers[m.id] = hWins ? aN : hN;
        const dd = detail[m.id] || (detail[m.id] = { home: {}, away: {}, win: {} });
        bump(dd.home, hN); bump(dd.away, aN); bump(dd.win, winners[m.id]);
      }
    }
    for (const m of byRound["round-of-16"]) if (winners[m.id]) ensure(winners[m.id]).qf++;
    for (const m of byRound["quarterfinals"]) if (winners[m.id]) ensure(winners[m.id]).sf++;
    for (const m of byRound["semifinals"]) if (winners[m.id]) ensure(winners[m.id]).f++;
    const fin = byRound["final"][0];
    if (winners[fin.id]) ensure(winners[fin.id]).w++;
  }

  if (!opts.history) S.simDetail = { runs, byId: detail };
  return Object.entries(reach)
    .map(([t, c]) => ({ t, qf: c.qf / runs, sf: c.sf / runs, f: c.f / runs, w: c.w / runs }))
    .sort((a, b) => b.w - a.w || b.f - a.f || b.sf - a.sf);
}

/* Elo-tilstand og målsnitt slik de var ved et gitt tidspunkt */
function eloAsOf(cutoff) {
  const elo = {};
  for (const t of Object.keys(S.eloStart)) elo[t] = S.eloStart[t];
  let mu = MU_PRIOR, cumG = 0, cumM = 0;
  const gp = {};
  const played = S.matches
    .filter((m) => m.state === "post" && !m.home.tbd && !m.away.tbd && m.date.getTime() <= cutoff)
    .sort((a, b) => a.date - b.date);
  for (const m of played) {
    const gh = m.home.score, ga = m.away.score;
    cumG += gh + ga; cumM++;
    mu = (MU_PRIOR * MU_WEIGHT + cumG) / (MU_WEIGHT + cumM);
    let kx = K;
    if (!m.knockout) {
      const gr = Math.max(gp[m.home.name] || 0, gp[m.away.name] || 0) + 1;
      if (gr === 3) kx = K * R3_DISC;
      gp[m.home.name] = (gp[m.home.name] || 0) + 1;
      gp[m.away.name] = (gp[m.away.name] || 0) + 1;
    }
    const res = gh > ga ? 1 : gh < ga ? 0 : 0.5;
    const gd = Math.abs(gh - ga);
    const G = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    const we = eloExp((elo[m.home.name] ?? 1650) + hostBonus(m.home.name) - (elo[m.away.name] ?? 1650));
    const delta = kx * G * (res - we);
    elo[m.home.name] = (elo[m.home.name] ?? 1650) + delta;
    elo[m.away.name] = (elo[m.away.name] ?? 1650) - delta;
  }
  return { elo, mu };
}

/* Historikk: tittelsjanser etter hver spilte sluttspillkamp (rekonstruert) */
async function buildHistory() {
  const ko = S.matches
    .filter((m) => m.knockout && m.state === "post" && !m.home.tbd && !m.away.tbd)
    .sort((a, b) => a.date - b.date);
  if (!ko.length) return null;
  const hash = ko.map((m) => m.id).join(",");
  if (S.history?.hash === hash) return S.history;
  if (S.historyBuilding) return null;
  S.historyBuilding = true;

  const snaps = [];
  for (let k = 0; k <= ko.length; k++) {
    const cutoff = k === 0 ? ko[0].date.getTime() - 1 : ko[k - 1].date.getTime();
    const { elo, mu } = eloAsOf(cutoff);
    const table = await simulate(5000, { cutoff, elo, mu, history: true });
    snaps.push({
      label: k === 0 ? "Før sluttspillet" : `Etter ${ko[k - 1].home.abbr}–${ko[k - 1].away.abbr}`,
      date: k === 0 ? ko[0].date : ko[k - 1].date,
      w: Object.fromEntries((table || []).map((r) => [r.t, r.w])),
    });
  }
  S.history = { hash, snaps };
  S.historyBuilding = false;
  return S.history;
}

const HIST_COLORS = ["#3fd9ff", "#ffd23f", "#8fb8ff", "#e5484d", "#b16fd8", "#2ecc71", "#f5c542", "#8a93a8"];

function historyChartHTML() {
  const h = S.history;
  if (!h || h.snaps.length < 3) {
    return `<div class="br-sec">Tittelsjanser gjennom sluttspillet</div>
      <p class="mvm-note">Rekonstruerer historikken (kjører ${(5000).toLocaleString("nb-NO")} simuleringer per kamp-snapshot) …</p>`;
  }
  const snaps = h.snaps;
  // lag som på noe tidspunkt var >= 5 %, pluss Norge om de er med
  const teams = new Set();
  for (const s of snaps) for (const [t, w] of Object.entries(s.w)) if (w >= 0.05) teams.add(t);
  if (snaps.some((s) => (s.w["Norway"] || 0) > 0.001)) teams.add("Norway");
  const list = [...teams].sort((a, b) => (snaps[snaps.length - 1].w[b] || 0) - (snaps[snaps.length - 1].w[a] || 0));

  const W = 720, H = 300, PL = 40, PR = 130, PT = 14, PB = 34;
  const maxW = Math.max(0.15, ...snaps.flatMap((s) => list.map((t) => s.w[t] || 0))) * 1.12;
  const x = (i) => PL + (i / (snaps.length - 1)) * (W - PL - PR);
  const y = (v) => H - PB - (v / maxW) * (H - PT - PB);

  const lines = list.map((t, ti) => {
    const c = HIST_COLORS[ti % HIST_COLORS.length];
    const pts = snaps.map((s, i) => `${x(i).toFixed(1)},${y(s.w[t] || 0).toFixed(1)}`).join(" ");
    const last = snaps[snaps.length - 1].w[t] || 0;
    return `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="2" opacity="0.9"/>
      <circle cx="${x(snaps.length - 1)}" cy="${y(last)}" r="3" fill="${c}"/>
      <text x="${x(snaps.length - 1) + 8}" y="${y(last) + 4}" fill="${c}" font-size="11" font-weight="600">${esc(teamNo(t))} ${Math.round(last * 100)} %</text>`;
  }).join("");

  const yticks = [0, 0.1, 0.2, 0.3, 0.4, 0.5].filter((v) => v <= maxW).map((v) => `
    <line x1="${PL}" y1="${y(v)}" x2="${W - PR}" y2="${y(v)}" stroke="#1c2c5c" stroke-dasharray="${v ? "2 4" : "0"}"/>
    <text x="${PL - 8}" y="${y(v) + 4}" fill="#8095c0" font-size="10" text-anchor="end">${v * 100}</text>`).join("");

  const step = Math.max(1, Math.round(snaps.length / 6));
  const xticks = snaps.map((s, i) => (i % step === 0 || i === snaps.length - 1) ? `
    <text x="${x(i)}" y="${H - PB + 18}" fill="#8095c0" font-size="10" text-anchor="middle">${i === 0 ? "start" : s.date.toLocaleDateString("nb-NO", { day: "numeric", month: "numeric" })}</text>` : "").join("");

  return `
    <div class="br-sec">Tittelsjanser gjennom sluttspillet</div>
    <p class="sim-intro">Rekonstruert: hvert punkt er ${(5000).toLocaleString("nb-NO")} simuleringer av resten av turneringen slik den sto <em>etter den kampen</em> — med Elo-ratingene og målsnittet slik de var da.</p>
    <div class="table-scroll"><svg viewBox="0 0 ${W} ${H}" style="min-width:640px;width:100%" role="img" aria-label="Tittelsjanser over tid">
      ${yticks}${xticks}${lines}
    </svg></div>`;
}

/* ---------- hjelpere ---------- */

const pct = (p) => Math.round(p * 100) + " %";

function fmtDayKey(d) {
  return d.toLocaleDateString("nb-NO", { weekday: "long", day: "numeric", month: "long" });
}
function fmtTime(d) {
  return d.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function expScore(pred) {
  return (Math.round(pred.lh * 10) / 10 + " – " + Math.round(pred.la * 10) / 10).replace(/\./g, ",");
}

function outcomeOf(m) {
  if (m.home.score > m.away.score) return "H";
  if (m.home.score < m.away.score) return "A";
  return "D";
}
function predOutcome(pred) {
  const mx = Math.max(pred.pH, pred.pD, pred.pA);
  return mx === pred.pH ? "H" : mx === pred.pA ? "A" : "D";
}

/* ---------- rendering ---------- */

const $ = (id) => document.getElementById(id);

function render() {
  renderStats();
  renderChips();
  renderContent();
  renderStatus();
  renderTicker();
  renderCalib();
  $("last-updated").textContent =
    "Sist oppdatert " + new Date().toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/* Broadcast-ticker: live -> siste resultater -> neste kamper med modellens favoritt. */
function renderTicker() {
  const el = $("ticker-track");
  if (!el) return;
  const items = [];
  for (const m of S.matches.filter((x) => x.state === "in")) {
    items.push(`<span class="tk live">LIVE ${esc(m.clock || "")} ${esc(m.home.abbr)} ${m.home.score}–${m.away.score} ${esc(m.away.abbr)}</span>`);
  }
  const done = S.matches.filter((m) => m.state === "post").sort((a, b) => b.date - a.date).slice(0, 10);
  for (const m of done) {
    const pens = m.pens ? ` <b>(${m.home.pens}–${m.away.pens} str.)</b>` : "";
    items.push(`<span class="tk">SLUTT ${esc(m.home.abbr)} <b>${m.home.score}–${m.away.score}</b> ${esc(m.away.abbr)}${pens}</span>`);
  }
  const next = S.matches.filter((m) => m.state === "pre" && !m.home.tbd && !m.away.tbd)
    .sort((a, b) => a.date - b.date).slice(0, 6);
  for (const m of next) {
    let tip = "";
    if (m.pred) {
      const o = predOutcome(m.pred);
      const fav = o === "H" ? m.home.abbr : o === "A" ? m.away.abbr : "UAVGJORT";
      const p = Math.max(m.pred.pH, m.pred.pD, m.pred.pA);
      tip = ` · modellen: <b>${esc(fav)} ${pct(p)}</b>`;
    }
    items.push(`<span class="tk pre">${fmtTime(m.date)} ${esc(m.home.abbr)}–${esc(m.away.abbr)}${tip}</span>`);
  }
  const seq = items.map((i) => i + `<span class="tk-sep">///</span>`).join("");
  const html = seq + seq; // duplisert for sømløs loop
  if (html === S.tickerHtml) return; // ikke restart marquee-animasjonen unødig
  S.tickerHtml = html;
  el.innerHTML = html;
}

function renderStatus() {
  const live = S.matches.filter((m) => m.state === "in");
  const dot = $("status-dot"), txt = $("status-text");
  if (live.length) {
    dot.className = "dot dot-live";
    txt.textContent = live.length + (live.length === 1 ? " kamp pågår nå" : " kamper pågår nå");
  } else {
    const next = S.matches.filter((m) => m.state === "pre").sort((a, b) => a.date - b.date)[0];
    dot.className = "dot dot-ok";
    txt.textContent = next
      ? "Neste kamp: " + next.home.no + " – " + next.away.no + " · " + cap(fmtDayKey(next.date)) + " " + fmtTime(next.date)
      : "Mesterskapet er ferdigspilt";
  }
}

function renderStats() {
  const played = S.matches.filter((m) => m.state === "post");
  const goals = played.reduce((s, m) => s + (m.home.score || 0) + (m.away.score || 0), 0);
  const preds = played.filter((m) => m.pred);
  const hits = preds.filter((m) => predOutcome(m.pred) === outcomeOf(m)).length;
  const exact = preds.filter((m) => m.pred.top[0].k === m.home.score + "-" + m.away.score).length;
  const today = S.matches.filter((m) => sameDay(m.date, new Date())).length;
  $("stats").innerHTML = `
    <div class="stat"><div class="v">${played.length}<small> / 104</small></div><div class="k">Kamper spilt</div></div>
    <div class="stat"><div class="v">${goals}</div><div class="k">Mål totalt</div></div>
    <div class="stat"><div class="v">${today}</div><div class="k">Kamper i dag</div></div>
    <div class="stat hit"><div class="v">${preds.length ? Math.round((hits / preds.length) * 100) + " %" : "–"}</div><div class="k">1X2-treff</div></div>
    <div class="stat hit"><div class="v">${preds.length ? Math.round((exact / preds.length) * 100) + " %" : "–"}</div><div class="k">Klink (eksakt resultat)</div></div>`;
}

function renderChips() {
  const el = $("chips");
  if (S.tab === "power" || S.tab === "sim" || S.tab === "bracket" || S.tab === "bets") { el.innerHTML = ""; return; }
  const chips = [["all", "Alle runder"], ...ROUND_ORDER.map((r) => [r, ROUND_NO[r]])];
  el.innerHTML = chips
    .map(([v, l]) => `<button class="chip ${S.round === v ? "active" : ""}" data-round="${v}">${l}</button>`)
    .join("");
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function visibleMatches() {
  let ms = [...S.matches];
  if (S.round !== "all") ms = ms.filter((m) => m.round === S.round);
  const now = new Date();
  switch (S.tab) {
    case "today":    ms = ms.filter((m) => sameDay(m.date, now) || m.state === "in"); break;
    case "upcoming": ms = ms.filter((m) => m.state === "pre"); break;
    case "results":  ms = ms.filter((m) => m.state === "post"); break;
  }
  ms.sort((a, b) => (S.tab === "results" ? b.date - a.date : a.date - b.date));
  return ms;
}

function renderContent() {
  const el = $("content");
  if (S.tab === "power") { el.innerHTML = `<div class="table-scroll">${powerHTML()}</div>${scorersHTML()}`; return; }
  if (S.tab === "bets") { el.innerHTML = betsHTML(); return; }
  if (S.tab === "sim") {
    el.innerHTML = simHTML();
    buildHistory().then((h) => { if (h && S.tab === "sim") { el.innerHTML = simHTML(); } });
    return;
  }
  if (S.tab === "bracket") {
    el.innerHTML = bracketHTML();
    const bs = el.querySelector(".bracket-scroll");
    if (bs) bs.scrollLeft = (bs.scrollWidth - bs.clientWidth) / 2; // start ved finalen
    return;
  }
  const ms = visibleMatches();
  if (!ms.length) {
    el.innerHTML = `<div class="empty">Ingen kamper her${S.tab === "today" ? " i dag — sjekk «Kommende»" : ""}.</div>`;
    return;
  }
  let html = "", lastDay = "";
  let cards = [];
  const flush = () => {
    if (cards.length) html += `<div class="match-grid">${cards.join("")}</div>`;
    cards = [];
  };
  for (const m of ms) {
    const day = cap(fmtDayKey(m.date));
    if (day !== lastDay) {
      flush();
      html += `<div class="day-head">${day}</div>`;
      lastDay = day;
    }
    cards.push(matchCard(m));
  }
  flush();
  el.innerHTML = html;
}

function flagImg(t) {
  return t.logo
    ? `<img src="${t.logo}" alt="" loading="lazy">`
    : `<span class="flag-ph"></span>`;
}

function teamRow(t, opp, m, prob) {
  const isLoser = m.state === "post" && !t.winner && (t.score !== opp.score || m.pens);
  const score = m.state !== "pre" && t.score != null ? t.score : "";
  const pens = m.pens && t.pens != null ? `<span class="pens">(${t.pens})</span>` : "";
  const probHtml = prob != null
    ? `<span class="prob-num ${prob >= 0.5 ? "fav" : ""}">${pct(prob)}</span>` : "";
  return `<div class="trow ${isLoser ? "loser" : ""}">
    ${flagImg(t)}
    <span class="tname ${t.tbd ? "tbd" : ""}">${esc(t.no)}</span>
    ${probHtml}
    <span class="tscore">${score}${pens ? " " + pens : ""}</span>
  </div>`;
}

function matchCard(m) {
  const roundLabel = m.group || ROUND_NO[m.round];
  let statusHtml, foot = "";
  const p = m.state === "in" && m.livePred ? m.livePred : m.pred;

  if (m.state === "in") {
    statusHtml = `<span class="badge-live">LIVE ${esc(m.clock || "")}</span>`;
  } else if (m.state === "post") {
    statusHtml = `<span class="badge-ft">${m.pens ? "Straffer" : m.aet ? "E.omg." : "Slutt"}</span>`;
  } else {
    const edge = edgeOf(m);
    const vb = edge ? `<span class="value-badge" title="Modellen avviker ${Math.round(edge.d * 100)} pp fra markedet">Value</span> ` : "";
    statusHtml = `<span>${vb}${fmtTime(m.date)}</span>`;
  }

  let probBar = "";
  if (p && m.state !== "post") {
    probBar = `<div class="prob-bar">
      <span class="pH" style="width:${p.pH * 100}%"></span>
      <span class="pD" style="width:${p.pD * 100}%"></span>
      <span class="pA" style="width:${p.pA * 100}%"></span>
    </div>`;
  }

  if (m.state === "post" && m.pred) {
    const hit = predOutcome(m.pred) === outcomeOf(m);
    const klink = m.pred.top[0].k === m.home.score + "-" + m.away.score;
    foot = `<div class="match-foot">
      <span class="pred-tag ${hit ? "pred-hit" : "pred-miss"}">${klink ? "◎ Klink! Tipset " + m.pred.top[0].k.replace("-", "–") : hit ? "✓ Modellen traff" : "✗ Modellen bommet"}</span>
      <span>${esc(m.venue)}</span></div>`;
  } else if (m.state === "pre" && m.pred) {
    const t = m.pred.top[0];
    foot = `<div class="match-foot">
      <span class="xres">Tips: <b>${t.k.replace("-", "–")}</b> (${(t.p * 100).toFixed(0)} %)</span>
      <span>${esc(m.venue)}</span></div>`;
  } else if (m.state === "in" && p) {
    foot = `<div class="match-foot">
      <span class="xres">Live-sannsynlighet oppdateres</span>
      <span>${esc(m.venue)}</span></div>`;
  } else {
    foot = `<div class="match-foot"><span></span><span>${esc(m.venue)}</span></div>`;
  }

  const showProbs = p && m.state !== "post";
  const norge = m.home.name === "Norway" || m.away.name === "Norway" ? "is-norge" : "";
  return `<article class="match ${m.state === "in" ? "is-live" : ""} ${norge}" data-id="${m.id}">
    <div class="match-meta"><span class="round">${roundLabel}</span>${statusHtml}</div>
    <div class="match-rows">
      ${teamRow(m.home, m.away, m, showProbs ? p.pH : null)}
      ${teamRow(m.away, m.home, m, showProbs ? p.pA : null)}
    </div>
    ${probBar}
    ${foot}
  </article>`;
}

function powerHTML() {
  const rows = Object.keys(S.elo)
    .map((n) => ({
      n,
      elo: S.elo[n],
      d: S.elo[n] - S.eloStart[n],
      alive: S.alive.has(n),
      logo: teamLogo(n),
    }))
    .sort((a, b) => b.elo - a.elo);
  return `<table class="power-table">
    <thead><tr><th></th><th>Lag</th><th style="text-align:right">Elo nå</th><th style="text-align:right">Endring i VM</th></tr></thead>
    <tbody>${rows.map((r, i) => `
      <tr class="${r.alive ? "" : "out"}">
        <td class="rank">${i + 1}</td>
        <td><span class="tcell">${r.logo ? `<img src="${r.logo}" alt="">` : ""}${esc(teamNo(r.n))}</span></td>
        <td class="num">${Math.round(r.elo)}</td>
        <td class="num ${r.d >= 0 ? "up" : "down"}">${r.d >= 0 ? "+" : ""}${Math.round(r.d)}</td>
      </tr>`).join("")}
    </tbody></table>`;
}

function simHTML() {
  if (!S.sim || !S.sim.length) {
    return `<div class="empty">Simuleringen trenger sluttspillkamper — kommer når treet er klart.</div>`;
  }
  const fp = (p) => (p >= 0.995 ? "100 %" : p < 0.001 ? "–" : p < 0.10 ? (p * 100).toFixed(1).replace(".", ",") + " %" : Math.round(p * 100) + " %");
  const maxW = S.sim[0].w || 1;
  return `
    ${historyChartHTML()}
    <div class="br-sec" style="margin-top:30px">Vinnersjanser nå</div>
    <p class="sim-intro">Resten av sluttspillet simulert ${SIM_RUNS.toLocaleString("nb-NO")} ganger med dagens Elo-ratinger. Oppdateres etter hver spilte kamp.</p>
    <div class="table-scroll"><table class="power-table sim-table">
    <thead><tr><th></th><th>Lag</th><th style="text-align:right">Kvartfinale</th><th style="text-align:right">Semifinale</th><th style="text-align:right">Finale</th><th style="text-align:right">Vinner VM</th><th class="sim-barcol"></th></tr></thead>
    <tbody>${S.sim.map((r, i) => `
      <tr class="${r.t === "Norway" ? "sim-norge" : ""}">
        <td class="rank">${i + 1}</td>
        <td><span class="tcell">${teamLogo(r.t) ? `<img src="${teamLogo(r.t)}" alt="">` : ""}${esc(teamNo(r.t))}</span></td>
        <td class="num">${fp(r.qf)}</td>
        <td class="num">${fp(r.sf)}</td>
        <td class="num">${fp(r.f)}</td>
        <td class="num win">${fp(r.w)}</td>
        <td class="sim-barcol"><div class="sim-bar"><i style="width:${(r.w / maxW) * 100}%"></i></div></td>
      </tr>`).join("")}
    </tbody></table></div>`;
}

/* ---------- braketten: gruppespill -> mester ---------- */

function groupTables() {
  const g = {};
  for (const m of S.matches) {
    if (m.round !== "group-stage" || m.state !== "post" || !m.group) continue;
    const t = g[m.group] || (g[m.group] = {});
    for (const [me, opp] of [[m.home, m.away], [m.away, m.home]]) {
      const r = t[me.name] || (t[me.name] = { team: me, p: 0, gf: 0, ga: 0, pts: 0 });
      r.p++; r.gf += me.score; r.ga += opp.score;
      r.pts += me.score > opp.score ? 3 : me.score < opp.score ? 0 : 1;
    }
  }
  return Object.keys(g).sort().map((k) => ({
    name: k,
    rows: Object.values(g[k]).sort((a, b) => b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf),
  }));
}

/* Rekonstruer sluttspilltreet. For uavklarte slots peker plassholderen
   («Round of 32 11 Winner») på feeder-kampen; for avklarte finner vi
   feederen via laget som vant den. */
function bracketTree() {
  const { srcs, by } = koSources();
  const byId = {};
  for (const r of SIM_ROUNDS) for (const m of by[r]) byId[m.id] = m;
  const feeder = (m, side) => {
    const s = srcs[m.id]?.[side];
    if (!s) return null;
    if (s.ref) return byId[s.ref] || null;
    // fast navn: finn den ferdigspilte feeder-kampen laget deltok i
    const prev = by[PREV_OF[m.round]] || [];
    return prev.find((pm) => pm.home.name === s.fixed || pm.away.name === s.fixed) || null;
  };
  const fin = by["final"][0];
  if (!fin) return null;
  const half = (sf) => {
    if (!sf) return null;
    const qfs = [feeder(sf, "home"), feeder(sf, "away")];
    const r16s = qfs.flatMap((qf) => qf ? [feeder(qf, "home"), feeder(qf, "away")] : [null, null]);
    const r32s = r16s.flatMap((r) => r ? [feeder(r, "home"), feeder(r, "away")] : [null, null]);
    if (qfs.some((x) => !x) || r16s.some((x) => !x) || r32s.some((x) => !x)) return null;
    return { sf, qfs, r16s, r32s };
  };
  const L = half(feeder(fin, "home"));
  const R = half(feeder(fin, "away"));
  if (!L || !R) return null;
  // guard mot ESPN-glitcher: hver kamp skal forekomme nøyaktig én gang i treet
  const all = [fin, L.sf, R.sf, ...L.qfs, ...R.qfs, ...L.r16s, ...R.r16s, ...L.r32s, ...R.r32s];
  if (new Set(all.map((m) => m.id)).size !== all.length) return null;
  return { fin, L, R, bronze: by["3rd-place-match"][0] || null };
}

function bracketHTML() {
  const det = S.simDetail;
  if (!det) return `<div class="empty">Braketten kommer når simuleringen er kjørt.</div>`;
  const runs = det.runs;

  // lag som gikk videre fra gruppespillet
  const advanced = new Set();
  for (const m of S.matches) {
    if (!m.knockout) continue;
    if (!m.home.tbd) advanced.add(m.home.name);
    if (!m.away.tbd) advanced.add(m.away.name);
  }

  const groups = groupTables();
  const groupsHtml = groups.length ? `
    <div class="br-sec">Gruppespillet <span class="br-sub">· lag i grønt gikk videre</span></div>
    <div class="groups">${groups.map((gr) => `
      <div class="gtable">
        <div class="gname">${esc(gr.name)}</div>
        ${gr.rows.map((r) => `
          <div class="grow ${advanced.has(r.team.name) ? "adv" : ""}">
            ${r.team.logo ? `<img src="${r.team.logo}" alt="">` : ""}
            <span class="gn">${esc(r.team.no)}</span>
            <span class="gd">${r.gf - r.ga > 0 ? "+" : ""}${r.gf - r.ga}</span>
            <span class="gp">${r.pts}</span>
          </div>`).join("")}
      </div>`).join("")}
    </div>` : "";

  // slot-rad i en brakettkamp
  const slotRow = (m, side, t) => {
    const d = det.byId[m.id];
    const counts = d ? d[side] : null;
    const settled = m.state === "post" || (counts && Object.keys(counts).length === 1);

    if (settled && !t.tbd) {
      const winP = d && m.state !== "post" ? (d.win[t.name] || 0) / runs : null;
      const isW = m.state === "post" && t.winner;
      const isL = m.state === "post" && !t.winner && (t.score !== (side === "home" ? m.away : m.home).score || m.pens);
      const score = m.state !== "pre" && t.score != null ? `<span class="bs">${t.score}${m.pens && t.pens != null ? ` <i>(${t.pens})</i>` : ""}</span>` : "";
      const pctS = winP != null ? `<span class="bp ${winP >= 0.5 ? "fav" : ""}">${pct(winP)}</span>` : "";
      return `<div class="brow ${isW ? "bwin" : ""} ${isL ? "bloss" : ""}">
        ${t.logo ? `<img src="${t.logo}" alt="">` : `<span class="bph"></span>`}
        <span class="bn">${esc(t.no)}</span>${score}${pctS}</div>`;
    }
    // uavklart: mest sannsynlige lag i slotten fra simuleringen
    const top = counts ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0] : null;
    if (!top) return `<div class="brow tbd"><span class="bph"></span><span class="bn">${esc(t.no)}</span></div>`;
    const [name, cnt] = top;
    const winP = (d.win[name] || 0) / runs;
    return `<div class="brow tbd">
      ${teamLogo(name) ? `<img src="${teamLogo(name)}" alt="">` : `<span class="bph"></span>`}
      <span class="bn">${esc(teamNo(name))} <i class="bslot">${Math.round((cnt / runs) * 100)} %</i></span>
      <span class="bp ${winP >= 0.5 ? "fav" : ""}">${pct(winP)}</span></div>`;
  };

  const card = (m, extra = "") => m ? `<div class="bmatch ${m.state === "in" ? "is-live" : ""} ${extra}" data-id="${m.id}">
    ${slotRow(m, "home", m.home)}
    ${slotRow(m, "away", m.away)}
  </div>` : "";

  const tree = bracketTree();
  let treeHtml;
  if (tree) {
    const col = (ms, label, cls) => `<div class="bcol ${cls}">
      <div class="bround">${label}</div>
      <div class="bcol-inner">${ms.map((m) => card(m)).join("")}</div>
    </div>`;

    // mester-kort fra finalens vinnerfordeling
    const wd = det.byId[tree.fin.id]?.win;
    let champHtml = "";
    if (wd) {
      const top3 = Object.entries(wd).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const [cn, cc] = top3[0];
      champHtml = `<div class="champ">
        ${teamLogo(cn) ? `<img src="${teamLogo(cn)}" alt="">` : ""}
        <div class="cn">${esc(teamNo(cn))}</div>
        <div class="cp">${pct(cc / runs)}</div>
        <div class="crest">${top3.slice(1).map(([n, c]) => `${esc(teamNo(n))} ${pct(c / runs)}`).join("<br>")}</div>
      </div>`;
    }

    treeHtml = `<div class="bracket-scroll"><div class="bracket b2">
      ${col(tree.L.r32s, "16.-dels", "half-l")}
      ${col(tree.L.r16s, "8.-dels", "half-l")}
      ${col(tree.L.qfs, "Kvart", "half-l")}
      ${col([tree.L.sf], "Semi", "half-l")}
      <div class="bcol bcenter">
        <div class="bround">Finale</div>
        <div class="bcol-inner bcenter-inner">
          ${champHtml}
          ${card(tree.fin, "bfinal")}
          ${tree.bronze ? `<div class="bronze-wrap"><div class="bround">Bronse</div>${card(tree.bronze)}</div>` : ""}
        </div>
      </div>
      ${col([tree.R.sf], "Semi", "half-r")}
      ${col(tree.R.qfs, "Kvart", "half-r")}
      ${col(tree.R.r16s, "8.-dels", "half-r")}
      ${col(tree.R.r32s, "16.-dels", "half-r")}
    </div></div>`;
  } else {
    // fallback: enkel kolonnevisning hvis treet ikke lar seg rekonstruere
    treeHtml = `<div class="bracket-scroll"><div class="bracket">
      ${SIM_ROUNDS.filter((r) => r !== "3rd-place-match").map((slug) => `<div class="bcol">
        <div class="bround">${ROUND_NO[slug]}</div>
        <div class="bcol-inner">${S.matches.filter((m) => m.round === slug).sort((a, b) => a.date - b.date).map((m) => card(m)).join("")}</div>
      </div>`).join("")}
    </div></div>`;
  }

  // Norges vei — sjanse per runde fra simuleringen
  let norgeHtml = "";
  const nor = S.sim && S.sim.find((r) => r.t === "Norway");
  if (nor && S.alive.has("Norway")) {
    const steps = [["Kvartfinale", nor.qf], ["Semifinale", nor.sf], ["Finale", nor.f], ["Tittelen", nor.w]];
    norgeHtml = `<div class="norge-path">
      <span class="np-flag">🇳🇴</span><span class="np-label">Norges vei:</span>
      ${steps.map(([l, p]) => `<span class="np-step"><b>${p < 0.10 ? (p * 100).toFixed(1).replace(".", ",") : Math.round(p * 100)} %</b> ${l}</span>`).join('<span class="np-arrow">→</span>')}
    </div>`;
  }

  return `
    <p class="sim-intro">Hele veien fra gruppespill til mester slik modellen ser den. Prosentene på kommende kamper er sjansen for å <b>vinne kampen</b> (fra ${runs.toLocaleString("nb-NO")} simuleringer); på uavklarte plasser vises det mest sannsynlige laget med sjansen for å <b>stå i kampen</b>. Klikk på en kamp for detaljer.</p>
    ${norgeHtml}
    <div class="br-sec">Sluttspillet</div>
    ${treeHtml}
    ${groupsHtml}`;
}

/* value-flagg: modellen avviker 6+ pp fra markedet på et utfall */
function edgeOf(m) {
  if (!m.pred || !m.market || m.state !== "pre") return null;
  const diffs = [
    { k: "H", d: m.pred.pH - m.market.pH, team: m.home },
    { k: "D", d: m.pred.pD - m.market.pD, team: null },
    { k: "A", d: m.pred.pA - m.market.pA, team: m.away },
  ].sort((a, b) => b.d - a.d);
  return diffs[0].d >= 0.06 ? diffs[0] : null;
}

function scorersHTML() {
  const sc = S.teamStats?.scorers;
  if (!sc || !Object.keys(sc).length) return "";
  const rows = Object.entries(sc)
    .map(([k, g]) => { const [player, team] = k.split("|"); return { player, team, g }; })
    .sort((a, b) => b.g - a.g).slice(0, 12);
  return `
    <div class="br-sec" style="margin-top:30px">Toppscorere</div>
    <div class="table-scroll"><table class="power-table">
      <thead><tr><th></th><th>Spiller</th><th>Lag</th><th style="text-align:right">Mål</th></tr></thead>
      <tbody>${rows.map((r, i) => `
        <tr>
          <td class="rank">${i + 1}</td>
          <td style="font-weight:600">${esc(r.player)}</td>
          <td><span class="tcell">${teamLogo(r.team) ? `<img src="${teamLogo(r.team)}" alt="">` : ""}${esc(teamNo(r.team))}</span></td>
          <td class="num win">${r.g}</td>
        </tr>`).join("")}
      </tbody></table></div>
    <p class="mvm-note">Aggregert fra ESPNs kampdata (selvmål ikke medregnet).</p>`;
}

/* Kalibrering: predikert sannsynlighet vs faktisk frekvens, alle H/U/B-utfall */
function renderCalib() {
  const el = $("calib");
  if (!el) return;
  const pts = [];
  for (const m of S.matches) {
    if (m.state !== "post" || !m.pred) continue;
    const o = outcomeOf(m);
    pts.push([m.pred.pH, o === "H" ? 1 : 0], [m.pred.pD, o === "D" ? 1 : 0], [m.pred.pA, o === "A" ? 1 : 0]);
  }
  if (pts.length < 30) { el.innerHTML = ""; return; }
  const B = 8, buckets = Array.from({ length: B }, () => ({ sp: 0, sh: 0, n: 0 }));
  for (const [p, hit] of pts) {
    const b = Math.min(B - 1, Math.floor(p * B));
    buckets[b].sp += p; buckets[b].sh += hit; buckets[b].n++;
  }
  const W = 520, H = 300, PAD = 44;
  const x = (v) => PAD + v * (W - PAD - 14);
  const y = (v) => H - PAD + v * -(H - PAD - 14);
  const dots = buckets.filter((b) => b.n >= 4).map((b) => {
    const px = b.sp / b.n, py = b.sh / b.n;
    const r = 4 + Math.min(8, Math.sqrt(b.n));
    return `<circle cx="${x(px).toFixed(1)}" cy="${y(py).toFixed(1)}" r="${r.toFixed(1)}" fill="rgba(63,217,255,.75)"><title>${b.n} utfall · predikert ${Math.round(px * 100)} % · faktisk ${Math.round(py * 100)} %</title></circle>`;
  }).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((v) => `
    <text x="${x(v)}" y="${H - PAD + 20}" fill="#8095c0" font-size="11" text-anchor="middle">${v * 100}</text>
    <text x="${PAD - 10}" y="${y(v) + 4}" fill="#8095c0" font-size="11" text-anchor="end">${v * 100}</text>`).join("");
  el.innerHTML = `
    <h3 style="margin-top:26px">Kalibrering</h3>
    <p style="font-size:.85rem;color:var(--ink-dim);max-width:640px">Hvert punkt er en gruppe prediksjoner (${pts.length} utfall totalt fra ${pts.length / 3} kamper). Ligger punktene på diagonalen, betyr «70 %» fra modellen faktisk 70 %. Størrelse = antall utfall.</p>
    <svg viewBox="0 0 ${W} ${H}" style="max-width:560px;width:100%;margin-top:10px" role="img" aria-label="Kalibreringsplot">
      <line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="#24397a" stroke-dasharray="4 4"/>
      <line x1="${PAD}" y1="${H - PAD}" x2="${W - 14}" y2="${H - PAD}" stroke="#1c2c5c"/>
      <line x1="${PAD}" y1="${H - PAD}" x2="${PAD}" y2="14" stroke="#1c2c5c"/>
      ${ticks}
      <text x="${(W + PAD) / 2}" y="${H - 6}" fill="#8095c0" font-size="11" text-anchor="middle">Predikert sannsynlighet (%)</text>
      <text x="12" y="${(H - PAD) / 2}" fill="#8095c0" font-size="11" text-anchor="middle" transform="rotate(-90 12 ${(H - PAD) / 2})">Faktisk frekvens (%)</text>
      ${dots}
    </svg>`;
}

const logoCache = {};
function teamLogo(name) {
  if (name in logoCache) return logoCache[name];
  for (const m of S.matches) {
    if (m.home.name === name && m.home.logo) return (logoCache[name] = m.home.logo);
    if (m.away.name === name && m.away.logo) return (logoCache[name] = m.away.logo);
  }
  return (logoCache[name] = null);
}

/* Kampforløp: vinnersannsynlighet minutt for minutt, rekonstruert fra
   pre-kamp-lambdaene og de tidfestede målene. 538-stil stablet område. */
function wpChartHTML(m) {
  if (m.state === "pre" || !m.pred || m.pred.lh == null) return "";
  const sum = S.summaries[m.id];
  if (!sum || !sum.wpGoals) return "";

  const endMin = m.state === "in" ? Math.max(2, Math.min(m.clockMin ?? 0, 90)) : 90;
  const pts = [];
  for (let t = 0; t <= endMin; t += 2) {
    const h = sum.wpGoals.filter((g) => g.side === "home" && g.min <= t).length;
    const a = sum.wpGoals.filter((g) => g.side === "away" && g.min <= t).length;
    const rem = remainingGoalShare(t);
    const g = grid(m.pred.lh * rem, m.pred.la * rem, h, a);
    pts.push({ t, pH: g.pH, pD: g.pD });
  }

  const W = 460, H = 170, PL = 6, PR = 6, PT = 8, PB = 22;
  const x = (t) => PL + (t / 90) * (W - PL - PR);
  const y = (v) => PT + (1 - v) * (H - PT - PB);
  const up = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.pH).toFixed(1)}`);
  const mid = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.pH + p.pD).toFixed(1)}`);
  const x0 = x(0).toFixed(1), xE = x(pts[pts.length - 1].t).toFixed(1);
  const areaH = `M ${x0},${y(0)} L ${up.join(" L ")} L ${xE},${y(0)} Z`;
  const areaD = `M ${up.join(" L ")} L ${[...mid].reverse().join(" L ")} Z`;
  const areaA = `M ${mid.join(" L ")} L ${xE},${y(1)} L ${x0},${y(1)} Z`;

  const goalMarks = sum.wpGoals.filter((g) => g.min <= endMin).map((g) => `
    <line x1="${x(g.min)}" y1="${y(1)}" x2="${x(g.min)}" y2="${y(0)}" stroke="rgba(240,243,233,.35)" stroke-dasharray="3 3"/>
    <text x="${x(g.min)}" y="${g.side === "home" ? y(0.06) : y(0.94) + 8}" font-size="11" text-anchor="middle">⚽</text>`).join("");

  const ticks = [0, 45, 90].map((t) => `
    <text x="${x(t)}" y="${H - 6}" fill="#8095c0" font-size="10" text-anchor="middle">${t}'</text>`).join("");

  return `
    <div class="m-sec">Kampforløpet${m.state === "in" ? " (live)" : ""}</div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%" role="img" aria-label="Vinnersannsynlighet gjennom kampen">
      <path d="${areaH}" fill="rgba(63,217,255,.45)"/>
      <path d="${areaD}" fill="rgba(44,65,112,.6)"/>
      <path d="${areaA}" fill="rgba(142,163,207,.4)"/>
      ${goalMarks}${ticks}
    </svg>
    <div class="wp-legend">
      <span><i style="background:rgba(63,217,255,.7)"></i>${esc(m.home.no)}</span>
      <span><i style="background:rgba(44,65,112,.95)"></i>Uavgjort</span>
      <span><i style="background:rgba(142,163,207,.75)"></i>${esc(m.away.no)}</span>
    </div>
    ${m.aet || m.pens ? `<p class="mvm-note">Grafen dekker ordinær tid — kampen ble avgjort ${m.pens ? "på straffer" : "i ekstraomgangene"}.</p>` : ""}`;
}

/* ---------- modal ---------- */

function openModal(m) {
  S.modalId = m.id;
  // hent kampstatistikk/H2H i bakgrunnen (H2H finnes også før avspark)
  if (!m.home.tbd && !m.away.tbd && !S.summaries[m.id]) {
    fetchSummary(m.id).then(() => { if (S.modalId === m.id) openModal(m); });
  }
  const p = m.state === "in" && m.livePred ? m.livePred : m.pred;
  const eloH = Math.round(teamEloRaw(m.home.name));
  const eloA = Math.round(teamEloRaw(m.away.name));

  let scoreHtml;
  if (m.state === "pre") {
    scoreHtml = `<div class="m-score">${fmtTime(m.date)}<small>${cap(fmtDayKey(m.date))}</small></div>`;
  } else {
    const pens = m.pens ? `<small>Straffer ${m.home.pens}–${m.away.pens}</small>`
      : m.aet ? `<small>Etter ekstraomganger</small>`
      : m.state === "in" ? `<small class="badge-live">LIVE ${esc(m.clock || "")}</small>` : `<small>Slutt</small>`;
    scoreHtml = `<div class="m-score">${m.home.score} – ${m.away.score}${pens}</div>`;
  }

  let probsHtml = "";
  if (p) {
    const best = Math.max(p.pH, p.pD, p.pA);
    const label = m.state === "post" ? "Modellens pre-kamp-sannsynligheter" :
                  m.state === "in" ? "Live-sannsynlighet akkurat nå" : "Modellens sannsynligheter";
    probsHtml = `
      <div class="m-sec">${label}</div>
      <div class="m-probs">
        <div class="m-prob ${best === p.pH ? "best" : ""}"><div class="p">${pct(p.pH)}</div><div class="l">${esc(m.home.no)}</div></div>
        <div class="m-prob ${best === p.pD ? "best" : ""}"><div class="p">${pct(p.pD)}</div><div class="l">Uavgjort</div></div>
        <div class="m-prob ${best === p.pA ? "best" : ""}"><div class="p">${pct(p.pA)}</div><div class="l">${esc(m.away.no)}</div></div>
      </div>
      ${m.knockout && p.adv != null && m.state !== "post" ? `
        <div class="m-advance"><span>Videre til neste runde (inkl. e.o. + straffer)</span>
        <span><b>${esc(m.home.no)}</b> ${pct(p.adv)} · <b>${esc(m.away.no)}</b> ${pct(1 - p.adv)}</span></div>` : ""}
      <div class="m-sec">Mest sannsynlige resultater</div>
      ${p.top.map((s) => `
        <div class="scoreline">
          <span class="s">${s.k.replace("-", " – ")}</span>
          <div class="bar"><i style="width:${Math.min(100, (s.p / p.top[0].p) * 100)}%"></i></div>
          <span class="pc">${(s.p * 100).toFixed(1).replace(".", ",")} %</span>
        </div>`).join("")}`;
  } else {
    probsHtml = `<div class="m-sec">Prediksjon</div>
      <p style="color:var(--ink-dim);font-size:.88rem">Lagene er ikke klare ennå — prediksjonen kommer når motstanderne er avgjort.</p>`;
  }

  // modell vs. marked
  let marketHtml = "";
  if (m.market && m.pred && m.state === "pre") {
    const rows = [
      [m.home.no, m.pred.pH, m.market.pH],
      ["Uavgjort", m.pred.pD, m.market.pD],
      [m.away.no, m.pred.pA, m.market.pA],
    ];
    const edge = edgeOf(m);
    marketHtml = `
      <div class="m-sec">Modell vs. marked (${esc(m.market.provider)})</div>
      <table class="mvm">
        <thead><tr><th></th>${rows.map((r) => `<th>${esc(r[0])}</th>`).join("")}</tr></thead>
        <tbody>
          <tr><td>Modell</td>${rows.map((r) => `<td>${pct(r[1])}</td>`).join("")}</tr>
          <tr><td>Marked</td>${rows.map((r) => `<td>${pct(r[2])}</td>`).join("")}</tr>
          <tr class="diff"><td>Avvik</td>${rows.map((r) => {
            const d = Math.round((r[1] - r[2]) * 100);
            return `<td class="${d >= 6 ? "pos" : d <= -6 ? "neg" : ""}">${d > 0 ? "+" : ""}${d} pp</td>`;
          }).join("")}</tr>
        </tbody>
      </table>
      ${edge ? `<p class="mvm-note">Modellen tror mer på ${edge.team ? esc(edge.team.no) : "uavgjort"} enn markedet gjør. Det betyr at de er uenige — ikke at modellen har rett.</p>` : ""}`;
  }

  // andre markeder (kun kommende kamper med kjente lag)
  let marketsHtml = "";
  if (m.state === "pre" && !m.home.tbd && !m.away.tbd) {
    const mk = markets(m);
    const fmt1 = (x) => x.toFixed(1).replace(".", ",");
    const rows = [
      `<div class="mkt-row"><span>Over 2,5 mål</span><b>${pct(mk.pO25)}</b><span>Under</span><b>${pct(1 - mk.pO25)}</b></div>`,
      `<div class="mkt-row"><span>Begge lag scorer</span><b>${pct(mk.pBTTS)}</b><span>Nei</span><b>${pct(1 - mk.pBTTS)}</b></div>`,
    ];
    if (mk.corners) {
      rows.push(`<div class="mkt-row"><span>Cornere over ${String(mk.corners.line).replace(".", ",")}</span><b>${pct(mk.corners.pOver)}</b><span>Forventet</span><b>${fmt1(mk.corners.lcT)}</b></div>`);
      rows.push(`<div class="mkt-row"><span>Flest cornere: ${esc(m.home.no)}</span><b>${pct(mk.corners.pAflest)}</b><span>${esc(m.away.no)}</span><b>${pct(mk.corners.pBflest)}</b></div>`);
    }
    if (mk.cards) {
      rows.push(`<div class="mkt-row"><span>Gule kort over ${String(mk.cards.lineY).replace(".", ",")}</span><b>${pct(mk.cards.pOverY)}</b><span>Forventet</span><b>${fmt1(mk.cards.lyT)}</b></div>`);
    }
    marketsHtml = `
      <div class="m-sec">Andre markeder</div>
      ${rows.join("")}
      ${!mk.corners ? `<p class="mvm-note">Corner- og kortmodellen trenger lagenes turneringsdata — lastes i bakgrunnen, prøv igjen om litt.</p>` : ""}`;
  }

  // kampstatistikk + målscorere fra summary-API
  let statsHtml = "";
  const sum = S.summaries[m.id];
  if (m.state !== "pre" && sum) {
    const sh = sum.stat[m.home.id], sa = sum.stat[m.away.id];
    if (sh && sa) {
      const rows = [
        ["Ballbesittelse", sh.poss, sa.poss, "%"],
        ["Skudd", sh.shots, sa.shots, ""],
        ["Skudd på mål", sh.sot, sa.sot, ""],
        ["Cornere", sh.corners, sa.corners, ""],
        ["Gule kort", sh.yellow, sa.yellow, ""],
        ["Røde kort", sh.red, sa.red, ""],
      ].filter((r) => r[1] != null && r[2] != null);
      statsHtml = `
        <div class="m-sec">Kampstatistikk${m.state === "in" ? " (live)" : ""}</div>
        ${rows.map(([l, a, b, u]) => {
          const tot = (a + b) || 1;
          return `<div class="stat-duel">
            <span class="sv">${a}${u}</span>
            <div class="sd-bars"><i class="l" style="width:${(a / tot) * 100}%"></i><i class="r" style="width:${(b / tot) * 100}%"></i></div>
            <span class="sv">${b}${u}</span>
            <span class="sl">${l}</span>
          </div>`;
        }).join("")}`;
    }
    if ((sum.goals || []).length || (sum.reds || []).length) {
      const evs = [...sum.goals.map((g) => ({ ...g, kind: "goal" })), ...sum.reds.map((r) => ({ ...r, kind: "red" }))];
      statsHtml += `
        <div class="m-sec">Hendelser</div>
        ${evs.map((e) => `<div class="m-event"><span class="ec">${esc(e.clock)}</span><span class="ei">${e.kind === "goal" ? "⚽" : "🟥"}</span><span>${esc(e.text)}</span></div>`).join("")}`;
    }
  }

  // innbyrdes oppgjør
  let h2hHtml = "";
  const h2hSum = S.summaries[m.id];
  if (h2hSum?.h2h?.length) {
    const nameById = { [m.home.id]: m.home.no, [m.away.id]: m.away.no };
    h2hHtml = `
      <div class="m-sec">Innbyrdes oppgjør</div>
      ${h2hSum.h2h.map((g) => {
        const yr = g.date ? new Date(g.date).getFullYear() : "";
        const hn = nameById[g.homeId] || "?", an = nameById[g.awayId] || "?";
        return `<div class="m-event"><span class="ec">${yr}</span><span>${esc(hn)} <b>${g.hs}–${g.as}</b> ${esc(an)}</span><span class="h2h-lg">${esc(g.league || "")}</span></div>`;
      }).join("")}`;
  }

  $("modal-card").innerHTML = `
    <div class="m-round"><span>${m.group || ROUND_NO[m.round]}</span><button class="m-close" id="m-close">✕</button></div>
    <div class="m-teams">
      <div class="m-team">${flagImg(m.home)}<div class="n">${esc(m.home.no)}</div><div class="e">${m.home.tbd ? "" : "Elo " + eloH}</div></div>
      ${scoreHtml}
      <div class="m-team">${flagImg(m.away)}<div class="n">${esc(m.away.no)}</div><div class="e">${m.away.tbd ? "" : "Elo " + eloA}</div></div>
    </div>
    <div class="m-when">${m.state === "pre" ? "" : cap(fmtDayKey(m.date)) + " · " + fmtTime(m.date)}</div>
    ${probsHtml}
    ${wpChartHTML(m)}
    ${marketHtml}
    ${marketsHtml}
    ${statsHtml}
    ${h2hHtml}
    <div class="m-venue">${esc(m.venue)}${m.city ? " · " + esc(m.city) : ""}</div>`;
  $("modal").hidden = false;
  document.body.style.overflow = "hidden";
  $("m-close").onclick = closeModal;
}

function closeModal() {
  S.modalId = null;
  $("modal").hidden = true;
  document.body.style.overflow = "";
}

/* ---------- fetch-løkke ---------- */

/* fetch med timeout — et hengende kall på mobilnett skal ikke drepe refresh-løkka */
function fetchT(url, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

/* signatur av alt som vises — endres den ikke, rører vi ikke DOM-en */
function dataHash() {
  return S.matches
    .map((m) => m.id + m.state + (m.clock || "") + m.home.score + "-" + m.away.score + m.home.name)
    .join("|");
}

async function load() {
  try {
    const res = await fetchT(API);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    S.matches = (data.events || []).map(parseEvent);

    // ESPN-feeden inkluderer odds bare i noen kall — snapshot dem når de dukker
    // opp, og bruk snapshotet ellers (pre-kamp-snapshot = ærlig regnskap)
    try {
      const store = JSON.parse(localStorage.getItem("vm26_odds_v1") || "{}");
      let dirty = false;
      for (const m of S.matches) {
        if (m.market && (m.state === "pre" || !store[m.id])) { store[m.id] = m.market; dirty = true; }
        if (!m.market && store[m.id]) m.market = store[m.id];
      }
      if (dirty) localStorage.setItem("vm26_odds_v1", JSON.stringify(store));
    } catch { /* privat modus e.l. */ }

    // hent kampstatistikk for pågående kamper før live-modellen regnes
    await Promise.all(S.matches.filter((m) => m.state === "in").map((m) => fetchSummary(m.id)));
    replayElo();
    S.lastLoad = Date.now();

    // rør bare DOM-en når noe faktisk har endret seg — ellers blinker lista
    // og tickeren hopper til start ved hver polling
    const dh = dataHash();
    if (dh !== S.renderHash) {
      S.renderHash = dh;
      render();
    } else {
      renderStatus();
      $("last-updated").textContent =
        "Sist oppdatert " + new Date().toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    // 50k-simuleringen er ~0,5-2s: kjør chunked, og bare når resultatbildet
    // eller sluttspill-slots faktisk har endret seg
    const hash = S.matches
      .filter((m) => m.state === "post" || m.knockout)
      .map((m) => m.id + ":" + m.home.name + m.home.score + "-" + m.away.name + m.away.score + m.state)
      .join("|");
    if (hash !== S.simHash) {
      S.simHash = hash;
      simulate(SIM_RUNS).then((table) => {
        if (!table) return;
        S.sim = table;
        if (S.tab === "sim" || S.tab === "bracket") renderContent();
      });
    }
    buildTeamStats(); // corner-/kortrater i bakgrunnen (cachet i localStorage)
  } catch (err) {
    console.error(err);
    $("status-dot").className = "dot dot-err";
    $("status-text").textContent = "Klarte ikke hente data — prøver igjen";
    if (!S.matches.length) {
      $("content").innerHTML = `<div class="empty">Fikk ikke kontakt med ESPNs API. Prøver igjen om litt …</div>`;
    }
  } finally {
    schedule();
  }
}

function schedule() {
  clearTimeout(S.timer);
  const anyLive = S.matches.some((m) => m.state === "in");
  const soonKickoff = S.matches.some(
    (m) => m.state === "pre" && m.date - Date.now() < 10 * 60 * 1000 && m.date - Date.now() > -10 * 60 * 1000
  );
  S.timer = setTimeout(load, anyLive || soonKickoff ? 60 * 1000 : 5 * 60 * 1000);
}

/* ---------- events ---------- */

document.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) {
    S.tab = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    renderChips();
    renderContent();
    return;
  }
  const chip = e.target.closest(".chip");
  if (chip) {
    S.round = chip.dataset.round;
    renderChips();
    renderContent();
    return;
  }
  const card = e.target.closest(".match, .bmatch, .bet-row, .bet-hero");
  if (card) {
    const m = S.matches.find((x) => x.id === card.dataset.id);
    if (m) openModal(m);
    return;
  }
  if (e.target.id === "modal") closeModal();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

/* Mobil-nettlesere fryser timere når fanen/skjermen er inaktiv — hent ferske
   data umiddelbart når siden blir synlig igjen (eller nettet kommer tilbake). */
function wakeUp() {
  if (document.hidden) return;
  if (Date.now() - (S.lastLoad || 0) > 30 * 1000) {
    clearTimeout(S.timer);
    load();
  }
}
document.addEventListener("visibilitychange", wakeUp);
window.addEventListener("focus", wakeUp);
window.addEventListener("pageshow", wakeUp);
window.addEventListener("online", wakeUp);

/* init: velg fane ut fra om det er kamper i dag */
(function init() {
  document.querySelector('.tab[data-tab="today"]').classList.add("active");
  load();
})();
