# VM 2026 · Prediktor

**Live:** https://wilolstad.github.io/vm2026-modell/

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

## Struktur

```
site/
  index.html   – markup
  styles.css   – mørkt tema
  app.js       – datahenting, Elo-replay, Poisson, rendering
```

Deployes automatisk til GitHub Pages ved push til `main`.

## Kjør lokalt

```bash
python3 -m http.server 4173 --directory site
```

Ikke bruk dette som betting-råd.
