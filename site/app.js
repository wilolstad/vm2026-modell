/* VM 2026 Prediktor — Elo + Poisson, live data fra ESPN.
   Alt kjører klient-side: hent alle 104 kamper, replay Elo kronologisk,
   prediker kommende kamper og regn om live under kamp. */

"use strict";

const API =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard" +
  "?dates=20260611-20260719&limit=200";

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

/* Live: gjenstående tid -> restlambda, regn om gitt stillingen. */
function predictLive(m) {
  const eloH = teamElo(m.home.name) + hostBonus(m.home.name);
  const eloA = teamElo(m.away.name);
  const { lh, la } = lambdas(eloH, eloA);
  const played = Math.min(m.clockMin ?? 0, 90);
  const rem = Math.max(90 - played, 2) / 90;
  const g = grid(lh * rem, la * rem, m.home.score, m.away.score);
  let adv = null;
  if (m.knockout) {
    const et = grid(lh / 3, la / 3);
    adv = g.pH + g.pD * (et.pH + et.pD * 0.5);
  }
  return { ...g, adv };
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
    name: x.team.displayName,
    no: teamNo(x.team.displayName),
    abbr: x.team.abbreviation,
    logo: x.team.logo || null,
    score: x.score != null ? parseInt(x.score, 10) : null,
    pens: x.shootoutScore ?? null,
    winner: x.winner === true,
    tbd: isTBD(x.team.displayName),
  });

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
    pred: null, // settes under replay / prediksjon
  };
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
  if (S.tab === "power") { el.innerHTML = ""; return; }
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
    statusHtml = `<span>${fmtTime(m.date)}</span>`;
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

  $("modal-card").innerHTML = `
    <div class="m-round"><span>${m.group || ROUND_NO[m.round]}</span><button class="m-close" id="m-close">✕</button></div>
    <div class="m-teams">
      <div class="m-team">${flagImg(m.home)}<div class="n">${esc(m.home.no)}</div><div class="e">${m.home.tbd ? "" : "Elo " + eloH}</div></div>
      ${scoreHtml}
      <div class="m-team">${flagImg(m.away)}<div class="n">${esc(m.away.no)}</div><div class="e">${m.away.tbd ? "" : "Elo " + eloA}</div></div>
    </div>
    <div class="m-when">${m.state === "pre" ? "" : cap(fmtDayKey(m.date)) + " · " + fmtTime(m.date)}</div>
    ${probsHtml}
    <div class="m-venue">${esc(m.venue)}${m.city ? " · " + esc(m.city) : ""}</div>`;
  $("modal").hidden = false;
  document.body.style.overflow = "hidden";
  $("m-close").onclick = closeModal;
}

function closeModal() {
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
    replayElo();
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
