/* VM 2026 Prediktor — Elo + Poisson, live data fra ESPN.
   Alt kjører klient-side: hent alle 104 kamper, replay Elo kronologisk,
   prediker kommende kamper og regn om live under kamp. */

"use strict";

const API =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard" +
  "?dates=20260611-20260719&limit=200";
const SUMMARY_API =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=";
const SIM_RUNS = 4000;

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
const HOME_BONUS = 60;
const K = 50;
const MU_TOTAL = 2.55; // snitt mål per VM-kamp
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

function lambdas(eloH, eloA) {
  const we = eloExp(eloH - eloA);
  return {
    lh: Math.max(0.2, MU_TOTAL * we),
    la: Math.max(0.2, MU_TOTAL * (1 - we)),
  };
}

/* Poisson-grid: P(hjemmeseier), P(uavgjort), P(borteseier) + toppresultater.
   baseH/baseA = mål som allerede står (live). */
function grid(lh, la, baseH = 0, baseA = 0) {
  let pH = 0, pD = 0, pA = 0;
  const scores = [];
  for (let h = 0; h <= MAX_G; h++) {
    const ph = poisson(h, lh);
    for (let a = 0; a <= MAX_G; a++) {
      const p = ph * poisson(a, la);
      const th = baseH + h, ta = baseA + a;
      if (th > ta) pH += p; else if (th < ta) pA += p; else pD += p;
      scores.push({ h: th, a: ta, p });
    }
  }
  // slå sammen like sluttresultater (relevant ved base-mål)
  const merged = {};
  for (const s of scores) {
    const key = s.h + "-" + s.a;
    merged[key] = (merged[key] || 0) + s.p;
  }
  const top = Object.entries(merged)
    .map(([k, p]) => ({ k, p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 5);
  const tot = pH + pD + pA;
  return { pH: pH / tot, pD: pD / tot, pA: pA / tot, top };
}

/* Full prediksjon før kamp. Knockout: + sannsynlighet for å gå videre
   (ekstraomganger = 1/3 intensitet, straffer 50/50). */
function predict(eloH, eloA, knockout) {
  const { lh, la } = lambdas(eloH, eloA);
  const g = grid(lh, la);
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
  const rem = Math.max(90 - played, 2) / 90;

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

function teamElo(name) { return S.elo[name] ?? ELO_SEED[name] ?? ELO_DEFAULT; }
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

  /* markedets impliserte sannsynligheter fra amerikansk moneyline, renset for margin */
  const american = (o) => (o == null || isNaN(o) ? null : o > 0 ? 100 / (o + 100) : -o / (-o + 100));
  let market = null;
  const odds = (c.odds || [])[0];
  if (odds && odds.moneyline) {
    const ph = american(parseInt(odds.moneyline.home?.close?.odds, 10));
    const pa = american(parseInt(odds.moneyline.away?.close?.odds, 10));
    const pd = american(odds.drawOdds?.moneyLine);
    if (ph && pa && pd) {
      const s = ph + pd + pa;
      market = { pH: ph / s, pD: pd / s, pA: pa / s, provider: odds.provider?.name || "Marked" };
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
    const res = await fetch(SUMMARY_API + id);
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
    S.summaries[id] = { stat, goals, reds, t: Date.now() };
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

  for (const m of played) {
    const eloH = S.elo[m.home.name] + hostBonus(m.home.name);
    const eloA = S.elo[m.away.name];
    m.pred = predict(eloH, eloA, m.knockout);

    const gh = m.home.score, ga = m.away.score;
    const res = gh > ga ? 1 : gh < ga ? 0 : 0.5;
    const gd = Math.abs(gh - ga);
    const G = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    const we = eloExp(eloH - eloA);
    const delta = K * G * (res - we);
    S.elo[m.home.name] += delta;
    S.elo[m.away.name] -= delta;
  }

  // prediksjoner for kommende/live kamper med kjente lag
  for (const m of S.matches) {
    if (m.state === "post" || m.home.tbd || m.away.tbd) continue;
    const eloH = S.elo[m.home.name] + hostBonus(m.home.name);
    m.pred = predict(eloH, S.elo[m.away.name], m.knockout);
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

/* Plassholderne («Round of 32 11 Winner») refererer kamp nr. N i runden,
   kronologisk — verifisert mot spilte kamper. */
function simulate(runs) {
  const byRound = {};
  for (const r of SIM_ROUNDS) {
    byRound[r] = S.matches.filter((m) => m.round === r).sort((a, b) => a.date - b.date);
  }
  if (!byRound["final"].length) return null;

  const reach = {};
  const ensure = (t) => reach[t] || (reach[t] = { qf: 0, sf: 0, f: 0, w: 0 });

  for (let i = 0; i < runs; i++) {
    const winners = {}, losers = {};
    const resolve = (t) => {
      if (!t.tbd) return t.name;
      const mm = t.name.match(REF_RE);
      if (!mm) return null;
      const src = byRound[REF_ROUND[mm[1]]][+mm[2] - 1];
      if (!src) return null;
      return mm[3] === "Winner" ? winners[src.id] : losers[src.id];
    };

    for (const r of SIM_ROUNDS) {
      for (const m of byRound[r]) {
        let hN, aN, hWins;
        if (m.state === "post" && !m.home.tbd && !m.away.tbd) {
          hN = m.home.name; aN = m.away.name; hWins = m.home.winner;
        } else {
          hN = resolve(m.home); aN = resolve(m.away);
          if (!hN || !aN) continue;
          const { lh, la } = lambdas(teamElo(hN) + hostBonus(hN), teamElo(aN));
          const gh = samplePoisson(lh), ga = samplePoisson(la);
          if (gh !== ga) hWins = gh > ga;
          else {
            const eh = samplePoisson(lh / 3), ea = samplePoisson(la / 3);
            hWins = eh !== ea ? eh > ea : Math.random() < 0.5;
          }
        }
        winners[m.id] = hWins ? hN : aN;
        losers[m.id] = hWins ? aN : hN;
      }
    }
    for (const m of byRound["round-of-16"]) if (winners[m.id]) ensure(winners[m.id]).qf++;
    for (const m of byRound["quarterfinals"]) if (winners[m.id]) ensure(winners[m.id]).sf++;
    for (const m of byRound["semifinals"]) if (winners[m.id]) ensure(winners[m.id]).f++;
    const fin = byRound["final"][0];
    if (winners[fin.id]) ensure(winners[fin.id]).w++;
  }

  return Object.entries(reach)
    .map(([t, c]) => ({ t, qf: c.qf / runs, sf: c.sf / runs, f: c.f / runs, w: c.w / runs }))
    .sort((a, b) => b.w - a.w || b.f - a.f || b.sf - a.sf);
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
  el.innerHTML = seq + seq; // duplisert for sømløs loop
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
  const today = S.matches.filter((m) => sameDay(m.date, new Date())).length;
  $("stats").innerHTML = `
    <div class="stat"><div class="v">${played.length}<small> / 104</small></div><div class="k">Kamper spilt</div></div>
    <div class="stat"><div class="v">${goals}</div><div class="k">Mål totalt</div></div>
    <div class="stat"><div class="v">${(goals / Math.max(played.length, 1)).toFixed(2).replace(".", ",")}</div><div class="k">Mål per kamp</div></div>
    <div class="stat"><div class="v">${today}</div><div class="k">Kamper i dag</div></div>
    <div class="stat hit"><div class="v">${preds.length ? Math.round((hits / preds.length) * 100) + " %" : "–"}</div><div class="k">Modellens treffprosent</div></div>`;
}

function renderChips() {
  const el = $("chips");
  if (S.tab === "power" || S.tab === "sim") { el.innerHTML = ""; return; }
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
  if (S.tab === "power") { el.innerHTML = powerHTML(); return; }
  if (S.tab === "sim") { el.innerHTML = simHTML(); return; }
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
    foot = `<div class="match-foot">
      <span class="pred-tag ${hit ? "pred-hit" : "pred-miss"}">${hit ? "✓ Modellen traff" : "✗ Modellen bommet"}</span>
      <span>${esc(m.venue)}</span></div>`;
  } else if (m.state === "pre" && m.pred) {
    foot = `<div class="match-foot">
      <span class="xres">Forventet: ${expScore(m.pred)}</span>
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
    <p class="sim-intro">Resten av sluttspillet simulert ${SIM_RUNS.toLocaleString("nb-NO")} ganger med dagens Elo-ratinger. Oppdateres etter hver spilte kamp.</p>
    <table class="power-table sim-table">
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
    </tbody></table>`;
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

const logoCache = {};
function teamLogo(name) {
  if (name in logoCache) return logoCache[name];
  for (const m of S.matches) {
    if (m.home.name === name && m.home.logo) return (logoCache[name] = m.home.logo);
    if (m.away.name === name && m.away.logo) return (logoCache[name] = m.away.logo);
  }
  return (logoCache[name] = null);
}

/* ---------- modal ---------- */

function openModal(m) {
  S.modalId = m.id;
  // hent kampstatistikk i bakgrunnen for spilte/pågående kamper
  if (m.state !== "pre" && !S.summaries[m.id]) {
    fetchSummary(m.id).then(() => { if (S.modalId === m.id) openModal(m); });
  }
  const p = m.state === "in" && m.livePred ? m.livePred : m.pred;
  const eloH = Math.round(teamElo(m.home.name));
  const eloA = Math.round(teamElo(m.away.name));

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
    if (sum.goals.length || sum.reds.length) {
      const evs = [...sum.goals.map((g) => ({ ...g, kind: "goal" })), ...sum.reds.map((r) => ({ ...r, kind: "red" }))];
      statsHtml += `
        <div class="m-sec">Hendelser</div>
        ${evs.map((e) => `<div class="m-event"><span class="ec">${esc(e.clock)}</span><span class="ei">${e.kind === "goal" ? "⚽" : "🟥"}</span><span>${esc(e.text)}</span></div>`).join("")}`;
    }
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
    ${marketHtml}
    ${statsHtml}
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

async function load() {
  try {
    const res = await fetch(API);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    S.matches = (data.events || []).map(parseEvent);
    // hent kampstatistikk for pågående kamper før live-modellen regnes
    await Promise.all(S.matches.filter((m) => m.state === "in").map((m) => fetchSummary(m.id)));
    replayElo();
    S.sim = simulate(SIM_RUNS);
    render();
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
  const card = e.target.closest(".match");
  if (card) {
    const m = S.matches.find((x) => x.id === card.dataset.id);
    if (m) openModal(m);
    return;
  }
  if (e.target.id === "modal") closeModal();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

/* init: velg fane ut fra om det er kamper i dag */
(function init() {
  document.querySelector('.tab[data-tab="today"]').classList.add("active");
  load();
})();
