/* Liga-prediktor — klubb-Elo + bivariat Poisson, live data fra ESPN.
   Samme motor som VM-prediktoren, kalibrert per liga. Ratinger fra
   liga-elo.json (bygget nightly av scripts/liga_build.py); kamper spilt
   etter snapshotet replays klient-side så alt alltid er ferskt. */

"use strict";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/";

/* relDirect = direkte nedrykksplasser, playoff = kvalik-plass rett over.
   hfa = hjemmefordel i Elo, backtestet per liga (scripts/backtest.py) på
   sesongene 2024-25 (train) og 2025-26 (validering) med pre-kamp-ClubElo. */
const LEAGUES = {
  "nor.1": { name: "Eliteserien",      flagg: "🇳🇴", relDirect: 2, playoff: true,  muFb: 3.1, hfa: 45 },
  "eng.1": { name: "Premier League",   flagg: "🏴", relDirect: 3, playoff: false, muFb: 2.8, hfa: 30 },
  "esp.1": { name: "LaLiga",           flagg: "🇪🇸", relDirect: 3, playoff: false, muFb: 2.7, hfa: 65 },
  "ger.1": { name: "Bundesliga",       flagg: "🇩🇪", relDirect: 2, playoff: true,  muFb: 3.1, hfa: 10 },
  "ita.1": { name: "Serie A",          flagg: "🇮🇹", relDirect: 3, playoff: false, muFb: 2.6, hfa: 45 },
  "por.1": { name: "Liga Portugal",    flagg: "🇵🇹", relDirect: 2, playoff: true,  muFb: 2.7, hfa: 65 },
  "ksa.1": { name: "Saudi Pro League", flagg: "🇸🇦", relDirect: 3, playoff: false, muFb: 3.0, hfa: 30 },
  "uefa.champions": { name: "Champions League", flagg: "🏆", relDirect: 12, playoff: false, muFb: 3.4, hfa: 45, ucl: true },
};

const SIM_RUNS = 10000;
const SIM_CHUNK = 400;
const K_REPLAY = 20;    // Elo-K for kamper spilt etter natt-snapshotet
/* Formparametre delt på tvers av ligaer, backtestet pooled på 2 294 kamper og
   validert på 2 338 (logloss 1,036 -> 0,970, bedre i ALLE sju ligaer).
   VM-verdiene (POW 1,2 / RHO -0,2 / BIV 0,4) var for aggressive for klubb:
   Elo-vinnersannsynlighet skal mappe flatere til målandel enn 1:1. */
const POW = 0.6;
const BIV = 0.2;
const RHO = 0.0;
const MAX_G = 8;
/* Angreps-/forsvarssplitt (walk-forward fra liga-elo.json, bygget nightly):
   att = (scoret + C)/(Elo-forventet + C), def tilsvarende baklengs, dempet
   med eksponent G. Backtestet: marginal men konsistent gevinst (validering
   0,9704 -> 0,9691 pooled 1X2, best i Eliteserien; O/U-Brier også bedre). */
const AD_C = 80;
const AD_G = 0.5;

/* «Alle ligaer»-modus: S.lg === "all". Prediksjoner er liga-avhengige
   (Elo, mu, HFA, att/def), så hver liga beregnes i sin egen kontekst som
   lagres i S.CTX og aktiveres midlertidig (ctxLg) ved behov (modal). */
function cfgLg() { return S.ctxLg ?? S.lg; }

function HFA() { return LEAGUES[cfgLg()]?.hfa ?? 45; }

function enterCtx(lg) {
  const prev = { elo: S.elo, eloSnap: S.eloSnap, ad: S.ad, mu: S.mu, ctxLg: S.ctxLg };
  const c = S.CTX?.[lg];
  if (c) { S.elo = c.elo; S.eloSnap = c.eloSnap; S.ad = c.ad; S.mu = c.mu; }
  S.ctxLg = lg;
  return prev;
}
function exitCtx(prev) {
  S.elo = prev.elo; S.eloSnap = prev.eloSnap; S.ad = prev.ad; S.mu = prev.mu; S.ctxLg = prev.ctxLg;
}

function adFactors(homeName, awayName) {
  const z = [0, 0, 0, 0];
  const h = S.ad?.[homeName] || z, a = S.ad?.[awayName] || z;
  const fh = Math.pow(((h[0] + AD_C) / (h[1] + AD_C)) * ((a[2] + AD_C) / (a[3] + AD_C)), AD_G);
  const fa = Math.pow(((a[0] + AD_C) / (a[1] + AD_C)) * ((h[2] + AD_C) / (h[3] + AD_C)), AD_G);
  return { fh, fa };
}
const MU_WEIGHT = 60;   // pseudo-kamper på forrige sesongs målsnitt

/* Empirisk måltiming i klubbfotball per 15-min-bolk (inkl. tilleggstid) */
const GOAL_TIMING = [0.12, 0.12, 0.16, 0.16, 0.16, 0.28];

/* Sesongvindu: Eliteserien er vår->høst, resten høst->vår (ny sesong fra juli) */
function seasonWindow(lg) {
  const now = new Date();
  const y = now.getFullYear();
  if (lg === "nor.1") return `${y}0201-${y}1220`;
  const start = now.getMonth() >= 6 ? y : y - 1;
  return `${start}0701-${start + 1}0630`;
}

/* ---------- state ---------- */

const S = {
  lg: null,
  matches: [],
  elo: {},          // ESPN displayName -> rating (snapshot + klient-replay)
  eloSnap: {},      // snapshot-rating (for å vise endring)
  eloData: null,    // hele liga-elo.json
  mu: 2.7,
  summaries: {},
  sim: null,
  simHash: null,
  modalId: null,
  tab: "today",
  timer: null,
  seq: 0,           // ligabytte invaliderer gamle fetch-svar
};

/* ---------- matte (delt med VM-modellen) ---------- */

function eloExp(d) { return 1 / (1 + Math.pow(10, -d / 400)); }

function poisson(k, lam) {
  let p = Math.exp(-lam);
  for (let i = 1; i <= k; i++) p *= lam / i;
  return p;
}

function lambdas(eloH, eloA, mu = S.mu) {
  const we = eloExp(eloH - eloA);
  const wg = Math.pow(we, POW) / (Math.pow(we, POW) + Math.pow(1 - we, POW));
  return { lh: Math.max(0.2, mu * wg), la: Math.max(0.2, mu * (1 - wg)) };
}

function dcTau(h, a, lh, la) {
  if (h === 0 && a === 0) return 1 - lh * la * RHO;
  if (h === 0 && a === 1) return 1 + lh * RHO;
  if (h === 1 && a === 0) return 1 + la * RHO;
  if (h === 1 && a === 1) return 1 - RHO;
  return 1;
}

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

function predict(m) {
  const { lh, la } = lambdas(teamElo(m.home.name) + HFA(), teamElo(m.away.name));
  const { fh, fa } = adFactors(m.home.name, m.away.name);
  const ah = Math.max(0.2, lh * fh), aa = Math.max(0.2, la * fa);
  return { ...grid(ah, aa, 0, 0, true), lh: ah, la: aa };
}

function teamElo(name) {
  if (name in S.elo) return S.elo[name];
  const vals = Object.values(S.elo);
  return vals.length ? Math.min(...vals) - 25 : 1500; // nyopprykket uten rating
}

/* Andel av kampens målproduksjon som gjenstår ved minutt t */
function remainingGoalShare(t) {
  const cum = [0];
  for (const s of GOAL_TIMING) cum.push(cum[cum.length - 1] + s);
  const tc = Math.min(Math.max(t, 0), 90);
  const i = Math.min(5, Math.floor(tc / 15));
  const frac = (tc - i * 15) / 15;
  const done = cum[i] + (cum[i + 1] - cum[i]) * frac;
  return Math.max(0.02, 1 - done / cum[6]);
}

function predictLive(m) {
  const L = lambdas(teamElo(m.home.name) + HFA(), teamElo(m.away.name));
  const F = adFactors(m.home.name, m.away.name);
  const lh = Math.max(0.2, L.lh * F.fh), la = Math.max(0.2, L.la * F.fa);
  const played = Math.min(m.clockMin ?? 0, 90);
  const rem = remainingGoalShare(played);

  let mh = 1, ma = 1, statsUsed = false;
  const sum = S.summaries[m.id];
  const sh = sum?.stat?.[m.home.id], sa = sum?.stat?.[m.away.id];
  if (sh && sa && played >= 15) {
    const sotShare = (sh.sot + 1) / ((sh.sot || 0) + (sa.sot || 0) + 2);
    const possShare = sh.poss != null && sa.poss != null && sh.poss + sa.poss > 0
      ? sh.poss / (sh.poss + sa.poss) : 0.5;
    const mix = 0.7 * sotShare + 0.3 * possShare;
    mh = 0.6 + 0.8 * mix;
    ma = 0.6 + 0.8 * (1 - mix);
    if (sh.red) { mh *= Math.pow(0.7, sh.red); ma *= Math.pow(1.15, sh.red); }
    if (sa.red) { ma *= Math.pow(0.7, sa.red); mh *= Math.pow(1.15, sa.red); }
    statsUsed = true;
  }
  return { ...grid(lh * rem * mh, la * rem * ma, m.home.score, m.away.score), statsUsed };
}

/* O/U + BTTS fra målmodellen */
function goalMarkets(m) {
  const L = lambdas(teamElo(m.home.name) + HFA(), teamElo(m.away.name));
  const F = adFactors(m.home.name, m.away.name);
  const lh = Math.max(0.2, L.lh * F.fh), la = Math.max(0.2, L.la * F.fa);
  let pO15 = 0, pO25 = 0, pO35 = 0, pBTTS = 0, tot = 0;
  const l3 = BIV * Math.min(lh, la), l1 = lh - l3, l2 = la - l3;
  for (let x3 = 0; x3 <= 5; x3++) {
    const p3 = poisson(x3, l3);
    if (p3 < 1e-12) break;
    for (let x1 = 0; x1 <= MAX_G; x1++) {
      const p1 = p3 * poisson(x1, l1);
      for (let x2 = 0; x2 <= MAX_G; x2++) {
        const X = x1 + x3, Y = x2 + x3;
        const p = p1 * poisson(x2, l2) * dcTau(X, Y, lh, la);
        tot += p;
        const T = X + Y;
        if (T > 1.5) pO15 += p;
        if (T > 2.5) pO25 += p;
        if (T > 3.5) pO35 += p;
        if (X > 0 && Y > 0) pBTTS += p;
      }
    }
  }
  return { pO15: pO15 / tot, pO25: pO25 / tot, pO35: pO35 / tot, pBTTS: pBTTS / tot };
}

/* ---------- data ---------- */

function parseEvent(ev) {
  const c = ev.competitions[0];
  const comps = [...c.competitors].sort((x) => (x.homeAway === "home" ? -1 : 1));
  const [h, a] = comps;
  const st = ev.status.type;

  const team = (x) => ({
    id: x.team.id,
    name: x.team.displayName,
    short: x.team.shortDisplayName || x.team.displayName,
    abbr: x.team.abbreviation || (x.team.shortDisplayName || "").slice(0, 3).toUpperCase(),
    logo: x.team.logo || null,
    score: x.score != null ? parseInt(x.score, 10) : null,
    winner: x.winner === true,
  });

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
      market = { pH: ph / s, pD: pd / s, pA: pa / s,
        oH: decimal(rawH), oD: decimal(rawD), oA: decimal(rawA),
        provider: odds.provider?.name || "Marked" };
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
    week: ev.week?.number ?? null,
    state: st.state, // pre | in | post
    clock: ev.status.displayClock,
    clockMin,
    venue: c.venue ? c.venue.fullName : "",
    home: team(h),
    away: team(a),
    market,
    pred: null,
  };
}

async function fetchSummary(id, lg = cfgLg()) {
  try {
    const res = await fetchT(ESPN_BASE + lg + "/summary?event=" + id);
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
      };
    }
    const isGoal = (k) => {
      const t = (k.type?.text || "").toLowerCase();
      return t === "goal" || t === "own goal" || t === "penalty - scored";
    };
    const goals = (s.keyEvents || []).filter(isGoal)
      .map((k) => ({ clock: k.clock?.displayValue || "", text: k.text || "" }));
    const reds = (s.keyEvents || [])
      .filter((k) => /red card/i.test(k.type?.text || ""))
      .map((k) => ({ clock: k.clock?.displayValue || "", text: k.text || "" }));

    // tidfestede mål for kampforløps-grafen: ligaformatet oppgir scorerens lag
    // i parentes — «Tripic (Viking FK) Goal at 9'». Selvmål telles motsatt.
    const wpGoals = [];
    const mm = S.matches.find((x) => x.id === id);
    if (mm) {
      for (const k of s.keyEvents || []) {
        if (!isGoal(k)) continue;
        const tm = (k.text || "").match(/\(([^)]+)\)/);
        const cm = (k.clock?.displayValue || "").match(/^(\d+)'/);
        if (!tm || !cm || +cm[1] > 90) continue;
        const who = tm[1].trim();
        let side = null;
        for (const [sd, t] of [["home", mm.home], ["away", mm.away]]) {
          if (who === t.name || who === t.short || t.name.includes(who) || who.includes(t.short)) side = sd;
        }
        if (!side) continue;
        if (/own goal/i.test(k.type?.text || "")) side = side === "home" ? "away" : "home";
        wpGoals.push({ min: +cm[1], side });
      }
    }
    const h2h = (s.headToHeadGames?.[0]?.events || []).slice(0, 5).map((ev) => ({
      date: ev.gameDate, homeId: ev.homeTeamId, awayId: ev.awayTeamId,
      hs: ev.homeTeamScore, as: ev.awayTeamScore, league: ev.leagueName,
    }));
    S.summaries[id] = { stat, goals, reds, wpGoals, h2h, t: Date.now() };
  } catch { /* nice-to-have */ }
}

/* Kampforløp: vinnersannsynlighet minutt for minutt, rekonstruert fra
   lambdaene og de tidfestede målene. 538-stil stablet område. */
function wpChartHTML(m) {
  if (m.state === "pre") return "";
  const sum = S.summaries[m.id];
  if (!sum || !sum.wpGoals) return "";
  const L0 = lambdas(teamElo(m.home.name) + HFA(), teamElo(m.away.name));
  const F = adFactors(m.home.name, m.away.name);
  const lh0 = Math.max(0.2, L0.lh * F.fh), la0 = Math.max(0.2, L0.la * F.fa);

  const endMin = m.state === "in" ? Math.max(2, Math.min(m.clockMin ?? 0, 90)) : 90;
  const pts = [];
  for (let t = 0; t <= endMin; t += 2) {
    const h = sum.wpGoals.filter((g) => g.side === "home" && g.min <= t).length;
    const a = sum.wpGoals.filter((g) => g.side === "away" && g.min <= t).length;
    const rem = remainingGoalShare(t);
    const g = grid(lh0 * rem, la0 * rem, h, a);
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
      <span><i style="background:rgba(63,217,255,.7)"></i>${esc(m.home.short)}</span>
      <span><i style="background:rgba(44,65,112,.95)"></i>Uavgjort</span>
      <span><i style="background:rgba(142,163,207,.75)"></i>${esc(m.away.short)}</span>
    </div>
    <p class="mvm-note">Rekonstruert med dagens ratinger — sannsynlighetene her kan avvike litt fra det som ble vist før kampen.</p>`;
}

/* Elo: snapshot fra liga-elo.json + klient-replay av kamper spilt etter.
   Snapshotet (bygget dato D av gårsdagens ClubElo) dekker kamper t.o.m. D-2,
   så alt fra og med D-1 replays her. */
function applyElo() {
  const entry = S.eloData?.leagues?.[cfgLg()];
  S.elo = {};
  S.eloSnap = {};
  S.ad = entry?.ad || {};
  S.mu = entry?.mu ?? LEAGUES[cfgLg()].muFb;
  if (entry) {
    for (const [name, elo] of Object.entries(entry.teams)) {
      S.elo[name] = elo;
      S.eloSnap[name] = elo;
    }
  }
  // lag i terminlisten uten rating: bunn minus 25 (nyopprykket)
  for (const m of S.matches) {
    for (const t of [m.home, m.away]) {
      if (!(t.name in S.elo)) {
        const v = teamElo(t.name);
        S.elo[t.name] = v;
        S.eloSnap[t.name] = v;
      }
    }
  }

  // løpende målsnitt: forrige sesong som prior, denne sesongen oppdaterer
  const generated = S.eloData ? new Date(S.eloData.generated + "T00:00:00Z") : null;
  const replayFrom = generated ? generated.getTime() - 86400000 : Infinity;
  const muPrior = S.mu;
  let cumG = 0, cumM = 0;

  const played = S.matches
    .filter((m) => m.state === "post" && m.home.score != null)
    .sort((a, b) => a.date - b.date);
  for (const m of played) {
    cumG += m.home.score + m.away.score; cumM++;
    if (m.date.getTime() < replayFrom) continue;
    const res = m.home.score > m.away.score ? 1 : m.home.score < m.away.score ? 0 : 0.5;
    const gd = Math.abs(m.home.score - m.away.score);
    const G = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    const we = eloExp(teamElo(m.home.name) + HFA() - teamElo(m.away.name));
    const delta = K_REPLAY * G * (res - we);
    S.elo[m.home.name] = teamElo(m.home.name) + delta;
    S.elo[m.away.name] = teamElo(m.away.name) - delta;
  }
  S.mu = (muPrior * MU_WEIGHT + cumG) / (MU_WEIGHT + cumM);

  // prediksjoner for kommende/live kamper. Målmarkedene forhåndsberegnes i
  // riktig liga-kontekst her, så Bets-fanen virker også i «Alle ligaer».
  for (const m of S.matches) {
    if (m.state === "post") continue;
    m.pred = predict(m);
    if (m.state === "pre") m.gm = goalMarkets(m);
    if (m.state === "in") m.livePred = predictLive(m);
  }
}

/* Pre-kamp-prediksjoner snapshottes i localStorage FØR avspark — treffprosenten
   måles kun mot disse, så den er ærlig (ingen etterpåklokskap). */
function predsKey() { return "liga_preds_v1_" + cfgLg(); }

function snapshotPreds() {
  try {
    const st = JSON.parse(localStorage.getItem(predsKey()) || "{}");
    let dirty = false;
    for (const m of S.matches) {
      if (m.state === "pre" && m.pred && !st[m.id]) {
        st[m.id] = { pH: m.pred.pH, pD: m.pred.pD, pA: m.pred.pA, top: m.pred.top[0].k };
        dirty = true;
      }
    }
    if (dirty) localStorage.setItem(predsKey(), JSON.stringify(st));
    return st;
  } catch { return {}; }
}

/* ---------- tabell ---------- */

function leagueTable() {
  const rows = {};
  const ensure = (t) => rows[t.name] || (rows[t.name] = {
    team: t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0,
  });
  for (const m of S.matches) {
    ensure(m.home); ensure(m.away);
    if (m.state !== "post" || m.home.score == null) continue;
    const rh = rows[m.home.name], ra = rows[m.away.name];
    rh.p++; ra.p++;
    rh.gf += m.home.score; rh.ga += m.away.score;
    ra.gf += m.away.score; ra.ga += m.home.score;
    if (m.home.score > m.away.score) { rh.w++; ra.l++; rh.pts += 3; }
    else if (m.home.score < m.away.score) { ra.w++; rh.l++; ra.pts += 3; }
    else { rh.d++; ra.d++; rh.pts++; ra.pts++; }
  }
  return Object.values(rows).sort((a, b) =>
    b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf || a.team.name.localeCompare(b.team.name));
}

/* ---------- sesongsimulering ---------- */

function samplePoisson(lam) {
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

async function simSeason(runs) {
  const mySeq = S.seq;
  if (S.lg === "all" || LEAGUES[S.lg].ucl) return null; // liga-spesifikk
  const base = leagueTable();
  if (base.length < 2) return null;
  const names = base.map((r) => r.team.name);
  const idx = Object.fromEntries(names.map((n, i) => [n, i]));
  const remaining = S.matches
    .filter((m) => m.state !== "post" && idx[m.home.name] != null && idx[m.away.name] != null)
    .map((m) => {
      // live kamper simuleres fra nåværende stilling og resttid
      let lh, la, bh = 0, ba = 0;
      const L0 = lambdas(teamElo(m.home.name) + HFA(), teamElo(m.away.name));
      const F = adFactors(m.home.name, m.away.name);
      const L = { lh: Math.max(0.2, L0.lh * F.fh), la: Math.max(0.2, L0.la * F.fa) };
      if (m.state === "in") {
        const rem = remainingGoalShare(Math.min(m.clockMin ?? 0, 90));
        lh = L.lh * rem; la = L.la * rem;
        bh = m.home.score || 0; ba = m.away.score || 0;
      } else { lh = L.lh; la = L.la; }
      return { h: idx[m.home.name], a: idx[m.away.name], lh, la, bh, ba };
    });

  const n = names.length;
  const cfg = LEAGUES[S.lg];
  const counts = names.map(() => ({ w: 0, t4: 0, po: 0, rel: 0, posSum: 0, ptsSum: 0 }));
  const order = names.map((_, i) => i);
  const relFrom = n - cfg.relDirect;          // 0-indeksert: posisjoner >= relFrom rykker ned
  const poPos = cfg.playoff ? relFrom - 1 : -1;

  for (let r = 0; r < runs; r++) {
    if (r > 0 && r % SIM_CHUNK === 0) {
      await new Promise((res) => setTimeout(res, 0));
      if (S.seq !== mySeq) return null; // ligaen er byttet — forkast
    }
    const pts = base.map((x) => x.pts);
    const gd = base.map((x) => x.gf - x.ga);
    const gf = base.map((x) => x.gf);
    for (const f of remaining) {
      const l3 = BIV * Math.min(f.lh, f.la);
      const g3 = samplePoisson(l3);
      const gh = f.bh + samplePoisson(f.lh - l3) + g3;
      const ga = f.ba + samplePoisson(f.la - l3) + g3;
      gd[f.h] += gh - ga; gd[f.a] += ga - gh;
      gf[f.h] += gh; gf[f.a] += ga;
      if (gh > ga) pts[f.h] += 3; else if (gh < ga) pts[f.a] += 3; else { pts[f.h]++; pts[f.a]++; }
    }
    const rnd = order.map(() => Math.random());
    order.sort((x, y) => pts[y] - pts[x] || gd[y] - gd[x] || gf[y] - gf[x] || rnd[x] - rnd[y]);
    for (let pos = 0; pos < n; pos++) {
      const c = counts[order[pos]];
      c.posSum += pos + 1;
      c.ptsSum += pts[order[pos]];
      if (pos === 0) c.w++;
      if (pos < 4) c.t4++;
      if (pos === poPos) c.po++;
      if (pos >= relFrom) c.rel++;
    }
  }
  return names.map((name, i) => ({
    name,
    team: base[i].team,
    w: counts[i].w / runs,
    t4: counts[i].t4 / runs,
    po: counts[i].po / runs,
    rel: counts[i].rel / runs,
    avgPos: counts[i].posSum / runs,
    xPts: counts[i].ptsSum / runs,
  })).sort((a, b) => b.w - a.w || b.t4 - a.t4 || a.avgPos - b.avgPos);
}

/* ---------- hjelpere ---------- */

const pct = (p) => Math.round(p * 100) + " %";
const $ = (id) => document.getElementById(id);

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
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function outcomeOf(m) {
  if (m.home.score > m.away.score) return "H";
  if (m.home.score < m.away.score) return "A";
  return "D";
}
function fetchT(url, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

/* ---------- rendering ---------- */

function render() {
  renderStats();
  renderLgChips();
  renderContent();
  renderStatus();
  renderTicker();
  $("last-updated").textContent =
    "Sist oppdatert " + new Date().toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/* Liga-filter i «Alle ligaer»-modus: chips for å slå ligaer av/på i lista.
   S.lgHidden = Set av skjulte ligakoder (tom = alle vises). */
function renderLgChips() {
  const el = $("lg-chips");
  if (!el) return;
  if (S.lg !== "all") { el.innerHTML = ""; el.classList.remove("show"); return; }
  el.classList.add("show");
  // bare ligaer som faktisk har kamper i feeden akkurat nå
  const present = new Set(S.matches.map((m) => m.lg));
  const codes = Object.keys(LEAGUES).filter((c) => present.has(c));
  el.innerHTML = codes.map((c) => {
    const on = !S.lgHidden.has(c);
    return `<button class="lg-chip ${on ? "on" : ""}" data-lg="${c}">${LEAGUES[c].flagg} ${esc(LEAGUES[c].name)}</button>`;
  }).join("");
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
      ? "Neste: " + next.home.short + " – " + next.away.short + " · " + cap(fmtDayKey(next.date)) + " " + fmtTime(next.date)
      : S.matches.length ? "Sesongen er ferdigspilt" : "Terminlisten er ikke publisert ennå";
  }
}

function renderTicker() {
  const el = $("ticker-track");
  if (!el) return;
  const items = [];
  for (const m of S.matches.filter((x) => x.state === "in")) {
    items.push(`<span class="tk live">LIVE ${esc(m.clock || "")} ${esc(m.home.abbr)} ${m.home.score}–${m.away.score} ${esc(m.away.abbr)}</span>`);
  }
  const done = S.matches.filter((m) => m.state === "post").sort((a, b) => b.date - a.date).slice(0, 10);
  for (const m of done) {
    items.push(`<span class="tk">SLUTT ${esc(m.home.abbr)} <b>${m.home.score}–${m.away.score}</b> ${esc(m.away.abbr)}</span>`);
  }
  const next = S.matches.filter((m) => m.state === "pre").sort((a, b) => a.date - b.date).slice(0, 6);
  for (const m of next) {
    let tip = "";
    if (m.pred) {
      const mx = Math.max(m.pred.pH, m.pred.pD, m.pred.pA);
      const fav = mx === m.pred.pH ? m.home.abbr : mx === m.pred.pA ? m.away.abbr : "UAVGJORT";
      tip = ` · modellen: <b>${esc(fav)} ${pct(mx)}</b>`;
    }
    items.push(`<span class="tk pre">${fmtTime(m.date)} ${esc(m.home.abbr)}–${esc(m.away.abbr)}${tip}</span>`);
  }
  const seq = items.map((i) => i + `<span class="tk-sep">///</span>`).join("");
  const html = seq + seq;
  if (html === S.tickerHtml) return;
  S.tickerHtml = html;
  el.innerHTML = html;
}

function renderStats() {
  const played = S.matches.filter((m) => m.state === "post");
  const goals = played.reduce((s, m) => s + (m.home.score || 0) + (m.away.score || 0), 0);
  const today = S.matches.filter((m) => sameDay(m.date, new Date())).length;
  const total = S.matches.length;

  // treff kun mot prediksjoner snapshottet før avspark
  let preds = 0, hits = 0, exact = 0;
  try {
    const st = JSON.parse(localStorage.getItem(predsKey()) || "{}");
    for (const m of played) {
      const p = st[m.id];
      if (!p) continue;
      preds++;
      const mx = Math.max(p.pH, p.pD, p.pA);
      const po = mx === p.pH ? "H" : mx === p.pA ? "A" : "D";
      if (po === outcomeOf(m)) hits++;
      if (p.top === m.home.score + "-" + m.away.score) exact++;
    }
  } catch { /* privat modus */ }

  // globalt regnskap (nightly commit) foretrekkes; localStorage som fallback
  let glob = S.ledger?.leagues?.[S.lg]?.agg;
  if (S.lg === "all" && S.ledger?.leagues) {
    glob = Object.values(S.ledger.leagues).reduce(
      (a, l) => ({ n: a.n + (l.agg?.n || 0), hits: a.hits + (l.agg?.hits || 0) }), { n: 0, hits: 0 });
  }
  const hitCell = glob && glob.n > 0
    ? `<div class="stat hit"><div class="v">${Math.round((glob.hits / glob.n) * 100)} %</div><div class="k">1X2-treff (globalt, ${glob.n} målt)</div></div>`
    : `<div class="stat hit"><div class="v">${preds ? Math.round((hits / preds) * 100) + " %" : "–"}</div><div class="k">1X2-treff (${preds} målt)</div></div>`;
  $("stats").innerHTML = `
    <div class="stat"><div class="v">${played.length}<small> / ${total}</small></div><div class="k">Kamper spilt</div></div>
    <div class="stat"><div class="v">${goals}</div><div class="k">Mål totalt</div></div>
    <div class="stat"><div class="v">${today}</div><div class="k">Kamper i dag</div></div>
    ${hitCell}
    <div class="stat hit"><div class="v">${preds ? Math.round((exact / preds) * 100) + " %" : "–"}</div><div class="k">Klink</div></div>`;
}

function visibleMatches() {
  let ms = [...S.matches];
  if (S.lg === "all" && S.lgHidden.size) ms = ms.filter((m) => !S.lgHidden.has(m.lg));
  const now = new Date();
  switch (S.tab) {
    case "today":    ms = ms.filter((m) => sameDay(m.date, now) || m.state === "in"); break;
    case "upcoming": ms = ms.filter((m) => m.state === "pre"); break;
    case "results":  ms = ms.filter((m) => m.state === "post"); break;
  }
  ms.sort((a, b) => (S.tab === "results" ? b.date - a.date : a.date - b.date));
  // i all-modus vises flere kort siden de deles på tvers av ligaer
  const cap = S.lg === "all" ? 100 : 60;
  if (S.tab === "upcoming" || S.tab === "results") ms = ms.slice(0, cap);
  return ms;
}

function logoImg(t) {
  return t.logo ? `<img src="${t.logo}" alt="" loading="lazy">` : `<span class="flag-ph"></span>`;
}

function teamRowL(t, opp, m, prob) {
  const isLoser = m.state === "post" && t.score != null && t.score < opp.score;
  const score = m.state !== "pre" && t.score != null ? t.score : "";
  const probHtml = prob != null
    ? `<span class="prob-num ${prob >= 0.5 ? "fav" : ""}">${pct(prob)}</span>` : "";
  return `<div class="trow ${isLoser ? "loser" : ""}">
    ${logoImg(t)}
    <span class="tname">${esc(t.short)}</span>
    ${probHtml}
    <span class="tscore">${score}</span>
  </div>`;
}

function matchCard(m) {
  const cfg = LEAGUES[m.lg || S.lg] || {};
  const label = S.lg === "all" ? `${cfg.flagg} ${cfg.name}` : (m.week ? "Runde " + m.week : cfg.name);
  let statusHtml, foot;
  const p = m.state === "in" && m.livePred ? m.livePred : m.pred;

  if (m.state === "in") {
    statusHtml = `<span class="badge-live">LIVE ${esc(m.clock || "")}</span>`;
  } else if (m.state === "post") {
    statusHtml = `<span class="badge-ft">Slutt</span>`;
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

  if (m.state === "pre" && m.pred) {
    const t = m.pred.top[0];
    foot = `<div class="match-foot">
      <span class="xres">Tips: <b>${t.k.replace("-", "–")}</b> (${(t.p * 100).toFixed(0)} %)</span>
      <span>${esc(m.venue)}</span></div>`;
  } else if (m.state === "in" && p) {
    foot = `<div class="match-foot"><span class="xres">Live-sannsynlighet oppdateres</span><span>${esc(m.venue)}</span></div>`;
  } else {
    foot = `<div class="match-foot"><span></span><span>${esc(m.venue)}</span></div>`;
  }

  const showProbs = p && m.state !== "post";
  return `<article class="match ${m.state === "in" ? "is-live" : ""}" data-id="${m.id}">
    <div class="match-meta"><span class="round">${esc(label)}</span>${statusHtml}</div>
    <div class="match-rows">
      ${teamRowL(m.home, m.away, m, showProbs ? p.pH : null)}
      ${teamRowL(m.away, m.home, m, showProbs ? p.pA : null)}
    </div>
    ${probBar}
    ${foot}
  </article>`;
}

function formDots(name) {
  const played = S.matches
    .filter((m) => m.state === "post" && m.home.score != null &&
      (m.home.name === name || m.away.name === name))
    .sort((a, b) => a.date - b.date)
    .slice(-5);
  return played.map((m) => {
    const me = m.home.name === name ? m.home : m.away;
    const opp = m.home.name === name ? m.away : m.home;
    const cls = me.score > opp.score ? "fw" : me.score < opp.score ? "fl" : "fd";
    return `<i class="fdot ${cls}" title="${esc(m.home.short)} ${m.home.score}–${m.away.score} ${esc(m.away.short)}"></i>`;
  }).join("");
}

function tableHTML() {
  if (S.lg === "all") return "";
  const rows = leagueTable();
  if (!rows.length) return `<div class="empty">Ingen tabell ennå.</div>`;
  const cfg = LEAGUES[S.lg];
  const n = rows.length;
  const zone = (i) => {
    if (cfg.ucl) return i < 8 ? "z-top" : i < 24 ? "z-po" : "z-rel";
    if (i === 0) return "z-title";
    if (i < 4) return "z-top";
    if (i >= n - cfg.relDirect) return "z-rel";
    if (cfg.playoff && i === n - cfg.relDirect - 1) return "z-po";
    return "";
  };
  const note = cfg.ucl
    ? "Grønn = topp 8 (direkte til åttedelsfinale), gul = plass 9–24 (playoff), rød = ute. Tabellen regnes fra ESPNs resultater."
    : "Grønn = serieleder, blek grønn = topp 4, gul = playoff/kvalik, rød = direkte nedrykk. Tabellen regnes fra ESPNs resultater.";
  return `<div class="table-scroll"><table class="power-table lg-table">
    <thead><tr><th></th><th>Lag</th><th class="num-h">K</th><th class="num-h">V</th><th class="num-h">U</th><th class="num-h">T</th><th class="num-h">+/-</th><th class="num-h">P</th><th class="form-h">Form</th></tr></thead>
    <tbody>${rows.map((r, i) => `
      <tr class="${zone(i)}">
        <td class="rank">${i + 1}</td>
        <td><span class="tcell">${r.team.logo ? `<img src="${r.team.logo}" alt="">` : ""}${esc(r.team.short)}</span></td>
        <td class="num">${r.p}</td>
        <td class="num">${r.w}</td>
        <td class="num">${r.d}</td>
        <td class="num">${r.l}</td>
        <td class="num">${r.gf - r.ga > 0 ? "+" : ""}${r.gf - r.ga}</td>
        <td class="num win">${r.pts}</td>
        <td class="form-cell">${formDots(r.team.name)}</td>
      </tr>`).join("")}
    </tbody></table></div>
  <p class="mvm-note">${note}</p>`;
}

const HIST_COLORS = ["#3fd9ff", "#ffd23f", "#8fb8ff", "#e5484d", "#b16fd8", "#2ecc71", "#f5c542", "#8a93a8"];

function shortName(display) {
  for (const m of S.matches) {
    if (m.home.name === display) return m.home.short;
    if (m.away.name === display) return m.away.short;
  }
  return display;
}

/* Tittelsjanser over sesongen — nattlige snapshots fra simhist.json */
function simHistChartHTML() {
  const snaps = S.simhist?.leagues?.[S.lg];
  if (!snaps || !snaps.length) return "";
  if (snaps.length < 3) {
    return `<div class="br-sec">Tittelsjanser over sesongen</div>
      <p class="mvm-note">Grafen bygger seg selv: sjansene snapshottes hver natt (${snaps.length} ${snaps.length === 1 ? "måling" : "målinger"} til nå — kom tilbake om noen dager).</p>`;
  }
  const teams = new Set();
  for (const s of snaps) for (const [t, w] of Object.entries(s.w)) if (w >= 0.05) teams.add(t);
  const last = snaps[snaps.length - 1].w;
  const list = [...teams].sort((a, b) => (last[b] || 0) - (last[a] || 0)).slice(0, 8);

  const W = 720, H = 300, PL = 40, PR = 130, PT = 14, PB = 34;
  const maxW = Math.max(0.15, ...snaps.flatMap((s) => list.map((t) => s.w[t] || 0))) * 1.12;
  const x = (i) => PL + (i / (snaps.length - 1)) * (W - PL - PR);
  const y = (v) => H - PB - (v / maxW) * (H - PT - PB);

  const lines = list.map((t, ti) => {
    const c = HIST_COLORS[ti % HIST_COLORS.length];
    const pts = snaps.map((s, i) => `${x(i).toFixed(1)},${y(s.w[t] || 0).toFixed(1)}`).join(" ");
    const lw = last[t] || 0;
    return `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="2" opacity="0.9"/>
      <circle cx="${x(snaps.length - 1)}" cy="${y(lw)}" r="3" fill="${c}"/>
      <text x="${x(snaps.length - 1) + 8}" y="${y(lw) + 4}" fill="${c}" font-size="11" font-weight="600">${esc(shortName(t))} ${Math.round(lw * 100)} %</text>`;
  }).join("");

  const yticks = [0, 0.2, 0.4, 0.6, 0.8, 1].filter((v) => v <= maxW).map((v) => `
    <line x1="${PL}" y1="${y(v)}" x2="${W - PR}" y2="${y(v)}" stroke="#1c2c5c" stroke-dasharray="${v ? "2 4" : "0"}"/>
    <text x="${PL - 8}" y="${y(v) + 4}" fill="#8095c0" font-size="10" text-anchor="end">${v * 100}</text>`).join("");

  const step = Math.max(1, Math.round(snaps.length / 6));
  const xticks = snaps.map((s, i) => (i % step === 0 || i === snaps.length - 1) ? `
    <text x="${x(i)}" y="${H - PB + 18}" fill="#8095c0" font-size="10" text-anchor="middle">${new Date(s.d).toLocaleDateString("nb-NO", { day: "numeric", month: "numeric" })}</text>` : "").join("");

  return `
    <div class="br-sec">Tittelsjanser over sesongen</div>
    <p class="sim-intro">Hvert punkt er et nattlig snapshot av modellens simulerte tittelsjanser — kurven viser hvordan sesongen faktisk har svingt.</p>
    <div class="table-scroll"><svg viewBox="0 0 ${W} ${H}" style="min-width:640px;width:100%" role="img" aria-label="Tittelsjanser over sesongen">
      ${yticks}${xticks}${lines}
    </svg></div>`;
}

function simTabHTML() {
  if (S.lg === "all") return "";
  if (LEAGUES[S.lg].ucl) {
    return `<div class="empty">Ligafase-tabellen finner du under «Tabell». Sesongsimulering for Champions League krever sluttspillmodell — den kommer når ligafasen er i gang.</div>`;
  }
  if (!S.sim || !S.sim.length) {
    return `<div class="empty">Simulerer sesongen … kommer om et øyeblikk.</div>`;
  }
  const cfg = LEAGUES[S.lg];
  const fp = (p) => (p >= 0.995 ? "100 %" : p < 0.001 ? "–" : p < 0.10 ? (p * 100).toFixed(1).replace(".", ",") + " %" : Math.round(p * 100) + " %");
  const maxW = S.sim[0].w || 1;
  return `
    ${simHistChartHTML()}
    <div class="br-sec" style="margin-top:26px">Sesongen simulert nå</div>
    <p class="sim-intro">Alle gjenstående kamper simulert ${SIM_RUNS.toLocaleString("nb-NO")} ganger oppå dagens tabell, med dagens Elo-ratinger. Re-simuleres når resultater endrer seg.</p>
    <div class="table-scroll"><table class="power-table sim-table">
    <thead><tr><th></th><th>Lag</th><th class="num-h">Forventet poeng</th><th class="num-h">Seriemester</th><th class="num-h">Topp 4</th>${cfg.playoff ? `<th class="num-h">Playoff</th>` : ""}<th class="num-h">Nedrykk</th><th class="num-h">Snittplass</th><th class="sim-barcol"></th></tr></thead>
    <tbody>${S.sim.map((r, i) => `
      <tr>
        <td class="rank">${i + 1}</td>
        <td><span class="tcell">${r.team.logo ? `<img src="${r.team.logo}" alt="">` : ""}${esc(r.team.short)}</span></td>
        <td class="num xpts">${Math.round(r.xPts)}</td>
        <td class="num win">${fp(r.w)}</td>
        <td class="num">${fp(r.t4)}</td>
        ${cfg.playoff ? `<td class="num">${fp(r.po)}</td>` : ""}
        <td class="num ${r.rel >= 0.2 ? "down" : ""}">${fp(r.rel)}</td>
        <td class="num">${r.avgPos.toFixed(1).replace(".", ",")}</td>
        <td class="sim-barcol"><div class="sim-bar"><i style="width:${(r.w / maxW) * 100}%"></i></div></td>
      </tr>`).join("")}
    </tbody></table></div>
    <p class="mvm-note">«Forventet poeng» = snittet av lagets sluttpoeng over alle simuleringene (inkl. poengene det alt har). Tabellplassering avgjøres på poeng → målforskjell → scorede mål; ligaspesifikke regler (innbyrdes oppgjør m.m.) er forenklet bort. «Nedrykk» = direkte nedrykk${cfg.playoff ? ", «Playoff» = kvalikplassen rett over" : ""}.</p>`;
}

function powerHTML() {
  const fmtPct = (v) => (v == null ? "–" : `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${Math.round(v * 100)} %</span>`);
  const rows = Object.keys(S.elo)
    .map((n) => {
      const t = S.matches.map((m) => [m.home, m.away]).flat().find((x) => x.name === n);
      const s = S.ad?.[n];
      // rå over-/underprestasjon mot Elo-forventet, vises først når nok data
      const att = s && s[1] >= 8 ? s[0] / s[1] - 1 : null;
      const def = s && s[3] >= 8 ? 1 - s[2] / s[3] : null;
      return { n, short: t?.short || n, logo: t?.logo || null, elo: S.elo[n],
               d: S.elo[n] - (S.eloSnap[n] ?? S.elo[n]), att, def };
    })
    .sort((a, b) => b.elo - a.elo);
  if (!rows.length) return `<div class="empty">Ingen ratinger for denne ligaen ennå.</div>`;
  const src = S.lg === "ksa.1" ? "egen Elo-replay av alle resultater siden 2023 (ESPN)" : "ClubElo, oppdatert nightly";
  const anyAd = rows.some((r) => r.att != null);
  return `<div class="table-scroll"><table class="power-table">
    <thead><tr><th></th><th>Lag</th><th class="num-h">Elo nå</th><th class="num-h">Siden snapshot</th>${anyAd ? `<th class="num-h">Angrep vs Elo</th><th class="num-h">Forsvar vs Elo</th>` : ""}</tr></thead>
    <tbody>${rows.map((r, i) => `
      <tr>
        <td class="rank">${i + 1}</td>
        <td><span class="tcell">${r.logo ? `<img src="${r.logo}" alt="">` : ""}${esc(r.short)}</span></td>
        <td class="num">${Math.round(r.elo)}</td>
        <td class="num ${r.d >= 0 ? "up" : "down"}">${r.d >= 0 ? "+" : ""}${Math.round(r.d)}</td>
        ${anyAd ? `<td class="num">${fmtPct(r.att)}</td><td class="num">${fmtPct(r.def)}</td>` : ""}
      </tr>`).join("")}
    </tbody></table></div>
  <p class="mvm-note">Kilde: ${src}. «Siden snapshot» = klient-replay av kamper spilt etter siste natt-bygg.${anyAd ? " «Angrep vs Elo» = scorer så mye mer/mindre enn Elo-differansene tilsier; «Forsvar vs Elo» = slipper inn så mye mindre/mer. Modellen bruker en kraftig dempet versjon av disse tallene." : ""}</p>`;
}

/* ---------- bets + regnskap ---------- */

/* Modellens picks på tvers av markeder for kommende kamper. Bruker forhånds-
   beregnet m.pred + m.gm, så det funker også i «Alle ligaer». */
function betCandidates() {
  const out = [];
  const upcoming = S.matches
    .filter((m) => m.state === "pre" && m.pred && m.gm)
    .filter((m) => !(S.lg === "all" && S.lgHidden.has(m.lg)))
    .sort((a, b) => a.date - b.date);
  for (const m of upcoming) {
    const p = m.pred, gm = m.gm, mk = m.market;
    const push = (market, prob, dk = null) =>
      out.push({ m, market, prob, dk,
        fair: prob > 0.01 ? 1 / prob : null,
        ev: dk ? prob * dk - 1 : null });
    push(`${m.home.short} vinner`, p.pH, mk?.oH ?? null);
    push("Uavgjort", p.pD, mk?.oD ?? null);
    push(`${m.away.short} vinner`, p.pA, mk?.oA ?? null);
    push(`Dobbeltsjanse ${m.home.short}/uavgjort`, p.pH + p.pD);
    push(`Dobbeltsjanse ${m.away.short}/uavgjort`, p.pA + p.pD);
    push("Over 2,5 mål", gm.pO25);
    push("Under 2,5 mål", 1 - gm.pO25);
    push("Over 3,5 mål", gm.pO35);
    push("Under 1,5 mål", 1 - gm.pO15);
    push("Begge lag scorer", gm.pBTTS);
    push("Ikke begge lag scorer", 1 - gm.pBTTS);
  }
  return out;
}

const fmtOdds = (o) => (o != null ? o.toFixed(2).replace(".", ",") : "–");
const fmtPctD = (x) => (x * 100).toFixed(1).replace(".", ",");

/* Ligaene regnskapet skal dekke: alle i all-modus, ellers valgt liga */
function ledgerLeagues() {
  if (!S.ledger?.leagues) return [];
  return S.lg === "all" ? Object.keys(S.ledger.leagues) : [S.lg];
}

function regnskapHTML() {
  const lgs = ledgerLeagues();
  let n = 0, hits = 0, ll = 0;
  let rows = [];
  for (const lg of lgs) {
    const L = S.ledger.leagues[lg];
    if (!L) continue;
    n += L.agg?.n || 0; hits += L.agg?.hits || 0; ll += L.agg?.ll || 0;
    for (const r of L.rows || []) rows.push({ lg, r });
  }
  if (!n) {
    return `<div class="br-sec">Regnskapet</div>
      <p class="mvm-note">Modellens pre-kamp-sannsynligheter snapshottes hver natt og gjøres opp mot fasit når kampene er spilt. Regnskapet er tomt fordi ingen kamper er gjort opp ennå — det begynner å telle så snart en snapshottet kamp er ferdigspilt. Etterprøvbart i <a href="https://github.com/wilolstad/vm2026-modell/blob/main/site/ledger.json" rel="noopener">git-historikken</a>.</p>`;
  }
  rows.sort((a, b) => (a.r[1] < b.r[1] ? 1 : -1));
  rows = rows.slice(0, 20);
  const acc = Math.round((hits / n) * 100);
  const avgLl = (ll / n).toFixed(3).replace(".", ",");
  const row = ({ lg, r }) => {
    const [, date, name, pH, pD, pA, score, hit] = r;
    const mx = Math.max(pH, pD, pA);
    const pick = mx === pH ? "H" : mx === pA ? "A" : "U";
    const flag = LEAGUES[lg]?.flagg || "";
    return `<tr>
      <td>${esc(date.slice(5))}</td>
      <td class="bmatchname">${S.lg === "all" ? flag + " " : ""}${esc(name)}</td>
      <td class="num">${pick} ${Math.round(mx * 100)} %</td>
      <td class="num">${esc(score.replace("-", "–"))}</td>
      <td class="num ${hit ? "up" : "down"}">${hit ? "✓" : "✗"}</td>
    </tr>`;
  };
  return `
    <div class="br-sec">Regnskapet ${S.lg === "all" ? "· alle ligaer" : "· " + esc(LEAGUES[S.lg].name)}</div>
    <div class="ledger">
      <div class="led-card"><div class="v">${acc} %</div><div class="k">1X2-treff (${n} kamper målt)</div></div>
      <div class="led-card"><div class="v">${avgLl}</div><div class="k">Snitt-logloss (lavere er bedre)</div></div>
      <div class="led-card"><div class="v">${hits} / ${n}</div><div class="k">Riktig utfall truffet</div></div>
    </div>
    <p class="mvm-note">Alle prediksjoner ble snapshottet <b>før</b> avspark og committes til <a href="https://github.com/wilolstad/vm2026-modell/blob/main/site/ledger.json" rel="noopener">repoet</a> — ingen etterpåklokskap. Logloss straffer selvsikre feil; til referanse gir «alltid 33/33/33» ca. 1,10.</p>
    <div class="table-scroll"><table class="power-table bets-table">
      <thead><tr><th>Dato</th><th>Kamp</th><th class="num-h">Modell</th><th class="num-h">Resultat</th><th class="num-h">Traff</th></tr></thead>
      <tbody>${rows.map(row).join("")}</tbody>
    </table></div>`;
}

function betsHTML() {
  const cands = betCandidates();
  const soon = Date.now() + 48 * 3600 * 1000;
  // spillbart bånd: fair odds 1,40–4,00 (p mellom 25 % og 71 %)
  const playable = cands.filter((c) => c.prob <= 0.72 && c.prob >= 0.25);
  const evBets = playable.filter((c) => c.ev != null).sort((a, b) => b.ev - a.ev);
  const modelBets = playable.filter((c) => c.ev == null).sort((a, b) => b.prob - a.prob).slice(0, 12);

  const hero = evBets.find((c) => c.ev > 0 && c.m.date < soon)
    || playable.filter((c) => c.m.date < soon).sort((a, b) => (b.ev ?? b.prob - 1) - (a.ev ?? a.prob - 1))[0]
    || null;

  const flag = (m) => (S.lg === "all" ? (LEAGUES[m.lg]?.flagg || "") + " " : "");
  const heroHtml = hero ? `
    <div class="bet-hero" data-id="${hero.m.id}">
      <div class="bh-label">Dagens bet</div>
      <div class="bh-market">${esc(hero.market)}</div>
      <div class="bh-match">${flag(hero.m)}${esc(hero.m.home.short)} – ${esc(hero.m.away.short)} · ${cap(fmtDayKey(hero.m.date))} ${fmtTime(hero.m.date)}</div>
      <div class="bh-nums">
        <span><b>${pct(hero.prob)}</b> modell</span>
        <span><b>${fmtOdds(hero.fair)}</b> fair odds</span>
        ${hero.dk != null ? `<span><b>${fmtOdds(hero.dk)}</b> odds</span>` : ""}
        ${hero.ev != null ? `<span class="bh-edge"><b>${hero.ev > 0 ? "+" : ""}${fmtPctD(hero.ev)} %</b> EV</span>` : ""}
      </div>
    </div>` : "";

  const betRow = (c, mode) => `
    <tr class="bet-row" data-id="${c.m.id}">
      <td>${esc(c.market)}</td>
      <td class="bmatchname">${flag(c.m)}${esc(c.m.home.abbr)}–${esc(c.m.away.abbr)} · ${fmtTime(c.m.date)}</td>
      <td class="num win">${pct(c.prob)}</td>
      <td class="num">${fmtOdds(c.fair)}</td>
      ${mode === "ev" ? `<td class="num">${fmtOdds(c.dk)}</td>
      <td class="num ${c.ev > 0 ? "up" : "down"}">${c.ev > 0 ? "+" : ""}${fmtPctD(c.ev)} %</td>` : ""}
    </tr>`;

  const betsSection = !cands.length
    ? `<p class="mvm-note">Ingen kommende kamper med kjente lag akkurat nå.</p>`
    : `
    <p class="sim-intro">Kun bets i spillbart oddsområde (fair odds 1,40–4,00). Der ESPN har odds vises <b>EV</b> = modellens sannsynlighet × odds − 1; positiv EV betyr at modellen mener oddsen er feilpriset. Klikk en rad for kampdetaljer. Ikke betting-råd — modellen vet ingenting om skader eller rotasjon.</p>
    ${heroHtml}
    ${evBets.length ? `
    <div class="br-sec">Verdi mot markedet (EV)</div>
    <div class="table-scroll"><table class="power-table bets-table">
      <thead><tr><th>Marked</th><th>Kamp</th><th class="num-h">Modell</th><th class="num-h">Fair</th><th class="num-h">Odds</th><th class="num-h">EV</th></tr></thead>
      <tbody>${evBets.slice(0, 10).map((c) => betRow(c, "ev")).join("")}</tbody>
    </table></div>
    <p class="mvm-note">Negativ EV = markedet priser bedre enn modellen tror — normaltilstanden mot skarpe odds. Positiv EV er uenighet, ikke garantert verdi.</p>` : ""}
    <div class="br-sec">Modellens beste picks</div>
    <div class="table-scroll"><table class="power-table bets-table">
      <thead><tr><th>Marked</th><th>Kamp</th><th class="num-h">Modell</th><th class="num-h">Fair odds</th></tr></thead>
      <tbody>${modelBets.map((c) => betRow(c, "plain")).join("")}</tbody>
    </table></div>`;

  return regnskapHTML() + `<div style="margin-top:34px"></div>` + betsSection;
}

function renderContent() {
  const el = $("content");
  if (S.tab === "bets") { el.innerHTML = betsHTML(); return; }
  if (S.tab === "table") { el.innerHTML = tableHTML(); return; }
  if (S.tab === "sim") { el.innerHTML = simTabHTML(); return; }
  if (S.tab === "power") { el.innerHTML = powerHTML(); return; }
  const ms = visibleMatches();
  if (!ms.length) {
    const msg = S.lg === "all" && S.lgHidden.size
      ? "Ingen kamper i de valgte ligaene — slå på flere over."
      : !S.matches.length
      ? "Terminlisten for denne ligaen er ikke publisert ennå — kommer når sesongen nærmer seg."
      : S.tab === "today" ? "Ingen kamper i dag — sjekk «Kommende»." : "Ingen kamper her.";
    el.innerHTML = `<div class="empty">${msg}</div>`;
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

/* ---------- modal ---------- */

function openModal(m) {
  const ctx = S.lg === "all" && m.lg ? enterCtx(m.lg) : null;
  try {
  S.modalId = m.id;
  if (!S.summaries[m.id]) {
    fetchSummary(m.id).then(() => { if (S.modalId === m.id) openModal(m); });
  }
  const p = m.state === "in" && m.livePred ? m.livePred : m.pred;
  const eloH = Math.round(teamElo(m.home.name));
  const eloA = Math.round(teamElo(m.away.name));

  let scoreHtml;
  if (m.state === "pre") {
    scoreHtml = `<div class="m-score">${fmtTime(m.date)}<small>${cap(fmtDayKey(m.date))}</small></div>`;
  } else {
    const sub = m.state === "in" ? `<small class="badge-live">LIVE ${esc(m.clock || "")}</small>` : `<small>Slutt</small>`;
    scoreHtml = `<div class="m-score">${m.home.score} – ${m.away.score}${sub}</div>`;
  }

  let probsHtml = "";
  if (p) {
    const best = Math.max(p.pH, p.pD, p.pA);
    const label = m.state === "in" ? "Live-sannsynlighet akkurat nå" : "Modellens sannsynligheter";
    probsHtml = `
      <div class="m-sec">${label}</div>
      <div class="m-probs">
        <div class="m-prob ${best === p.pH ? "best" : ""}"><div class="p">${pct(p.pH)}</div><div class="l">${esc(m.home.short)}</div></div>
        <div class="m-prob ${best === p.pD ? "best" : ""}"><div class="p">${pct(p.pD)}</div><div class="l">Uavgjort</div></div>
        <div class="m-prob ${best === p.pA ? "best" : ""}"><div class="p">${pct(p.pA)}</div><div class="l">${esc(m.away.short)}</div></div>
      </div>
      <div class="m-sec">Mest sannsynlige resultater</div>
      ${p.top.map((s) => `
        <div class="scoreline">
          <span class="s">${s.k.replace("-", " – ")}</span>
          <div class="bar"><i style="width:${Math.min(100, (s.p / p.top[0].p) * 100)}%"></i></div>
          <span class="pc">${(s.p * 100).toFixed(1).replace(".", ",")} %</span>
        </div>`).join("")}`;
  } else if (m.state === "post") {
    probsHtml = "";
  }

  let marketHtml = "";
  if (m.market && m.pred && m.state === "pre") {
    const rows = [
      [m.home.short, m.pred.pH, m.market.pH],
      ["Uavgjort", m.pred.pD, m.market.pD],
      [m.away.short, m.pred.pA, m.market.pA],
    ];
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
      </table>`;
  }

  let marketsHtml = "";
  if (m.state === "pre") {
    const mk = goalMarkets(m);
    marketsHtml = `
      <div class="m-sec">Målmarkeder</div>
      <div class="mkt-row"><span>Over 2,5 mål</span><b>${pct(mk.pO25)}</b><span>Under</span><b>${pct(1 - mk.pO25)}</b></div>
      <div class="mkt-row"><span>Over 3,5 mål</span><b>${pct(mk.pO35)}</b><span>Under</span><b>${pct(1 - mk.pO35)}</b></div>
      <div class="mkt-row"><span>Begge lag scorer</span><b>${pct(mk.pBTTS)}</b><span>Nei</span><b>${pct(1 - mk.pBTTS)}</b></div>`;
  }

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

  let h2hHtml = "";
  if (sum?.h2h?.length) {
    const nameById = { [m.home.id]: m.home.short, [m.away.id]: m.away.short };
    h2hHtml = `
      <div class="m-sec">Innbyrdes oppgjør</div>
      ${sum.h2h.map((g) => {
        const yr = g.date ? new Date(g.date).getFullYear() : "";
        const hn = nameById[g.homeId] || "?", an = nameById[g.awayId] || "?";
        return `<div class="m-event"><span class="ec">${yr}</span><span>${esc(hn)} <b>${g.hs}–${g.as}</b> ${esc(an)}</span><span class="h2h-lg">${esc(g.league || "")}</span></div>`;
      }).join("")}`;
  }

  $("modal-card").innerHTML = `
    <div class="m-round"><span>${esc((LEAGUES[m.lg || S.lg] || {}).name || "")}${m.week ? " · Runde " + m.week : ""}</span><button class="m-close" id="m-close">✕</button></div>
    <div class="m-teams">
      <div class="m-team">${logoImg(m.home)}<div class="n">${esc(m.home.short)}</div><div class="e">Elo ${eloH}</div></div>
      ${scoreHtml}
      <div class="m-team">${logoImg(m.away)}<div class="n">${esc(m.away.short)}</div><div class="e">Elo ${eloA}</div></div>
    </div>
    <div class="m-when">${m.state === "pre" ? "" : cap(fmtDayKey(m.date)) + " · " + fmtTime(m.date)}</div>
    ${probsHtml}
    ${wpChartHTML(m)}
    ${marketHtml}
    ${marketsHtml}
    ${statsHtml}
    ${h2hHtml}
    <div class="m-venue">${esc(m.venue)}</div>`;
  $("modal").hidden = false;
  document.body.style.overflow = "hidden";
  $("m-close").onclick = closeModal;
  } finally { if (ctx) exitCtx(ctx); }
}

function closeModal() {
  S.modalId = null;
  $("modal").hidden = true;
  document.body.style.overflow = "";
}

/* ---------- fetch-løkke ---------- */

function dataHash() {
  return S.matches
    .map((m) => m.id + m.state + (m.clock || "") + m.home.score + "-" + m.away.score)
    .join("|");
}

async function loadEloData() {
  if (!S.eloData) {
    try {
      const res = await fetchT("liga-elo.json");
      if (res.ok) S.eloData = await res.json();
    } catch { /* frontend faller tilbake på muFb + flat rating */ }
  }
  if (!S.ledger) {
    try {
      const res = await fetchT("ledger.json");
      if (res.ok) S.ledger = await res.json();
    } catch { /* regnskapet er nice-to-have */ }
  }
  if (!S.simhist) {
    try {
      const res = await fetchT("simhist.json");
      if (res.ok) S.simhist = await res.json();
    } catch { /* grafen er nice-to-have */ }
  }
}

/* «Alle ligaer»: hent alle terminlister parallelt, prediker hver liga i sin
   egen kontekst, og flett kampene (tagget med m.lg) til én kronologisk liste. */
async function loadAllLeagues(mySeq) {
  const codes = Object.keys(LEAGUES);
  const results = await Promise.all(codes.map(async (lg) => {
    try {
      const res = await fetchT(ESPN_BASE + lg + "/scoreboard?dates=" + seasonWindow(lg) + "&limit=500", 20000);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.events || []).map((ev) => ({ ...parseEvent(ev), lg }));
    } catch { return []; }
  }));
  if (S.seq !== mySeq) return null;

  const CTX = {};
  const merged = [];
  for (let i = 0; i < codes.length; i++) {
    const lg = codes[i];
    if (!results[i].length) continue;
    S.ctxLg = lg;
    S.matches = results[i];
    await Promise.all(S.matches.filter((m) => m.state === "in").map((m) => fetchSummary(m.id, lg)));
    if (S.seq !== mySeq) { S.ctxLg = null; return null; }
    applyElo();
    snapshotPreds();
    CTX[lg] = { elo: S.elo, eloSnap: S.eloSnap, ad: S.ad, mu: S.mu };
    merged.push(...S.matches);
  }
  S.ctxLg = null;
  S.CTX = CTX;
  merged.sort((a, b) => a.date - b.date);
  return merged;
}

async function load() {
  const mySeq = S.seq;
  try {
    await loadEloData();
    if (S.lg === "all") {
      const merged = await loadAllLeagues(mySeq);
      if (!merged) return;
      S.matches = merged;
      S.sim = null;
    } else {
      const url = ESPN_BASE + S.lg + "/scoreboard?dates=" + seasonWindow(S.lg) + "&limit=500";
      const res = await fetchT(url, 20000);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (S.seq !== mySeq) return; // brukeren byttet liga mens vi ventet
      S.matches = (data.events || []).map(parseEvent);

      await Promise.all(S.matches.filter((m) => m.state === "in").map((m) => fetchSummary(m.id)));
      if (S.seq !== mySeq) return;
      applyElo();
      snapshotPreds();
    }
    S.lastLoad = Date.now();

    const dh = dataHash();
    if (dh !== S.renderHash) {
      S.renderHash = dh;
      render();
    } else {
      renderStatus();
      $("last-updated").textContent =
        "Sist oppdatert " + new Date().toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    if (S.lg !== "all") {
      const hash = S.lg + "|" + S.matches
        .filter((m) => m.state !== "pre")
        .map((m) => m.id + ":" + m.home.score + "-" + m.away.score + m.state)
        .join("|");
      if (hash !== S.simHash) {
        S.simHash = hash;
        simSeason(SIM_RUNS).then((table) => {
          if (!table || S.seq !== mySeq) return;
          S.sim = table;
          if (S.tab === "sim") renderContent();
        });
      }
    }
  } catch (err) {
    if (S.seq !== mySeq) return;
    console.error(err);
    $("status-dot").className = "dot dot-err";
    $("status-text").textContent = "Klarte ikke hente data — prøver igjen";
    if (!S.matches.length) {
      $("content").innerHTML = `<div class="empty">Fikk ikke kontakt med ESPNs API. Prøver igjen om litt …</div>`;
    }
  } finally {
    if (S.seq === mySeq) schedule();
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

/* ---------- ligabytte + events ---------- */

/* faner uten mening på tvers av ligaer skjules i «Alle ligaer»-modus */
const LEAGUE_ONLY_TABS = new Set(["table", "sim", "power"]);

function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
}

function switchLeague(lg) {
  if (lg !== "all" && !LEAGUES[lg]) lg = "all";
  S.lg = lg;
  S.seq++;
  S.matches = [];
  S.sim = null;
  S.simHash = null;
  S.renderHash = null;
  S.summaries = {};
  S.tickerHtml = null;
  S.CTX = null;
  S.ctxLg = null;
  document.getElementById("tabs").classList.toggle("all-mode", lg === "all");
  if (lg === "all" && LEAGUE_ONLY_TABS.has(S.tab)) setTab("upcoming");
  try { localStorage.setItem("liga_lg", lg); } catch { /* ok */ }
  const url = new URL(location.href);
  url.searchParams.set("lg", lg);
  history.replaceState(null, "", url);
  $("lg-select").value = lg;
  const name = lg === "all" ? "alle ligaer" : LEAGUES[lg].name;
  $("content").innerHTML = `<div class="loading"><div class="spinner"></div><p>Laster ${esc(name)} …</p></div>`;
  clearTimeout(S.timer);
  load();
}

document.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) {
    S.tab = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    renderContent();
    return;
  }
  const lgc = e.target.closest(".lg-chip");
  if (lgc) {
    const c = lgc.dataset.lg;
    if (S.lgHidden.has(c)) S.lgHidden.delete(c); else S.lgHidden.add(c);
    try { localStorage.setItem("liga_hidden", JSON.stringify([...S.lgHidden])); } catch { /* ok */ }
    renderLgChips();
    renderContent();
    return;
  }
  const card = e.target.closest(".match, .bet-row, .bet-hero");
  if (card) {
    const m = S.matches.find((x) => x.id === card.dataset.id);
    if (m) openModal(m);
    return;
  }
  if (e.target.id === "modal") closeModal();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

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

(function init() {
  const sel = $("lg-select");
  sel.innerHTML = `<option value="all">🌍 Alle ligaer</option>` + Object.entries(LEAGUES)
    .map(([code, l]) => `<option value="${code}">${l.flagg} ${l.name}</option>`)
    .join("");
  sel.addEventListener("change", () => switchLeague(sel.value));

  try { S.lgHidden = new Set(JSON.parse(localStorage.getItem("liga_hidden") || "[]")); }
  catch { S.lgHidden = new Set(); }

  let lg = new URLSearchParams(location.search).get("lg");
  if (!lg) { try { lg = localStorage.getItem("liga_lg"); } catch { /* ok */ } }
  lg = lg || "all"; // standard: kommende kamper på tvers av alle ligaene
  setTab("upcoming"); // «Kommende» er alltid landingsfanen; «I dag» klikker man seg til
  switchLeague(lg);
})();
