# VM 2026 · Prediktor (+ liga-prediktor)

**Live:** https://wilolstad.github.io/vm2026-modell/
**Ligaer:** https://wilolstad.github.io/vm2026-modell/liga.html

Prediksjonsmodell for alle 104 kamper i FIFA World Cup 2026. Alt kjører
klient-side — siden henter live data direkte fra ESPNs (uoffisielle) scoreboard-API,
så den trenger verken backend, API-nøkkel eller cron-jobb.

## Modellen

1. **Elo-ratinger** — hvert lag starter med en seed-rating (≈ eloratings.net før
   mesterskapet). Alle spilte VM-kamper replays kronologisk i nettleseren og
   oppdaterer ratingene fortløpende (K = 50, margin-vekting, +60 hjemmebonus for
   USA/Mexico/Canada).
2. **Poisson** — Elo-differansen mapper til forventet målproduksjon per lag
   (snitt ≈ 2,55 mål/kamp). Poisson-grid over alle resultater gir H/U/B-sannsynligheter
   og de mest sannsynlige sluttresultatene. I sluttspillet beregnes også
   «videre»-sannsynlighet (ekstraomganger med 1/3 intensitet, straffer 50/50).
3. **Live in-play** — under kamp skaleres forventet restproduksjon med gjenstående
   spilletid og justeres for kampbildet (skudd på mål, ballbesittelse, røde kort
   fra ESPNs summary-API). Vinnersannsynligheten regnes om gitt stillingen.
   Auto-refresh hvert 60. sekund når det spilles.
4. **Vinnersjanser** — resten av sluttspilltreet simuleres 4 000 ganger
   (Monte Carlo) per datalast → sannsynlighet for kvartfinale/semifinale/finale/tittel.
5. **Modell vs. marked** — DraftKings-odds fra feeden konverteres til impliserte
   sannsynligheter (renset for margin) og vises mot modellen; 6+ pp avvik flagges
   som «value» (dvs. uenighet, ikke fasit).

Prediksjonene for spilte kamper er laget med ratingene slik de var *før* hver kamp,
så treffprosenten som vises er ærlig out-of-sample.

## Eksperimentlogg (backtest på spilte kamper, logloss 1X2)

| Endring | Resultat | Status |
|---|---|---|
| Att/def-residualratinger (C 3–12, cap 1.3–1.5) | 0,80–0,82 (verre) | Forkastet — for lite data per lag |
| Fast MU 2,7–3,05 | marginalt verre | Forkastet |
| Løpende MU (prior 2,55, vekt 20) | ~likt 1X2, bedre O/U | **Shippet** |
| Exp-mapping Elo→λ | verre logloss (flere klink-treff = TikTok-fella) | Forkastet |
| Power-mapping g=1,2 | bedre | **Shippet** |
| K=50 → 30 | bedre | **Shippet** |
| Hjemmebonus 60 → 100 | bedre (≈ standard for landskamper) | **Shippet** |
| DC ρ −0,15 → −0,20 | bedre | **Shippet** |
| KO-uavgjort-boost | ingen effekt | Forkastet |

**Runde 2 (V3):**

| Endring | Resultat | Status |
|---|---|---|
| Bivariat Poisson (felles komponent 0,4) | bedre på alt | **Shippet** |
| Prediksjons-Elo regressert mot seed (0,7) | bedre | **Shippet** |
| K-rabatt 0,5 i grupperunde 3 (rotasjon) | bedre | **Shippet** |
| KO-favoritt-boost (We-skalering 1,08) | målte bedre, men 13 KO-kamper er for tynt — ren chalk-artefakt-risiko | Observert, ikke shippet |
| KO-spesifikk lavere MU | verre | Forkastet |
| MOV-varianter (ingen/sqrt) | ~nøytralt | Beholdt standard |
| Elo-oppdatering: We-shrink i KO < 1 | verre | Forkastet |
| Lambda-gulv 0,1/0,3 | ~nøytralt | Beholdt 0,2 |

Samlet: logloss 0,787 (V1) → 0,765 (V2) → **0,754 (V3)**, KO-delsett
0,619 → 0,520, siste-30 0,712 → 0,667. Krav for shipping: forbedring på
hele settet OG begge delsett, pluss teoretisk begrunnelse. Forbehold:
tunet på 85 kamper — re-valideres mot resten av sluttspillet.

## Liga-prediktoren (liga.html)

Samme motor for klubbfotball: Eliteserien, Premier League, LaLiga, Bundesliga,
Serie A, Liga Portugal og Saudi Pro League.

- **Ratinger:** [ClubElo](http://clubelo.com), hentet nightly av
  `scripts/liga_build.py` (GitHub Actions kl. 04:30 UTC) → `site/liga-elo.json`.
  ClubElo har ikke CORS, derfor bygges fila server-side. Saudi Pro League finnes
  ikke på ClubElo — de ratingene beregnes ved å replaye alle resultater siden
  2023 fra ESPN (K=25, start 1500). Kamper spilt etter natt-snapshotet replays
  klient-side (K=20), så ratingene er alltid ferske.
- **Kalibrering per liga:** målsnittet beregnes fra forrige sesong (Serie A 2,4 →
  Bundesliga 3,2) og oppdateres løpende mot inneværende sesong; hjemmefordel
  +65 Elo (klubbnivå, mot +100 for landslag).
- **Sesongsim:** alle gjenstående serierunder simuleres 10 000 ganger →
  sannsynlighet for tittel, topp 4, playoff og nedrykk. Tie-break forenklet til
  poeng/målforskjell/scorede mål.
- **Ærlighet:** 1X2-treff måles kun mot prediksjoner snapshottet i localStorage
  *før* avspark. Nyopprykkede lag uten ClubElo-rating (f.eks. Viseu, Marítimo)
  får ligaens bunnrating minus 25.

## Struktur

```
site/
  index.html    – VM-siden
  liga.html     – liga-siden
  styles.css    – delt mørkt tema
  app.js        – VM: datahenting, Elo-replay, Poisson, rendering
  liga.js       – liga: samme motor + tabell og sesongsim
  liga-elo.json – klubb-Elo + målsnitt per liga (bygges nightly)
scripts/
  liga_build.py – henter ClubElo, mapper lagnavn, beregner Saudi-Elo og mu
```

Deployes automatisk til GitHub Pages ved push til `main` og nightly 04:30 UTC.

## Kjør lokalt

```bash
python3 -m http.server 4173 --directory site
```

Ikke bruk dette som betting-råd.
