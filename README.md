# VM 2026 — prediksjonsmodell

Elo → forventede mål → Poisson over alle resultater. Statisk side, gratis å kjøre.
Pre-kamp-prediksjon for hver kamp + **live-modus** der du selv mater inn xG/stilling
og modellen re-beregner sluttresultatet i nettleseren på sekundet.

## Hvorfor manuell live-input
Live-xG finnes ikke gratis i sanntid (Sportmonks ~€129/mnd, iSports ~$49/mnd).
Men du sitter uansett med Sofascore/Fotmob foran deg. Så i stedet for å betale for
en feed, taster du inn xG-en når du har den — det var nettopp xG-tallene som gjorde
prediksjonene presise. Du automatiserer matematikken, ikke datainnsamlingen.

## Struktur
```
scripts/engine.py   modellen (Elo, Poisson, live-betinging) — sannhetskilde
scripts/build.py    henter Elo (eloratings.net TSV + fallback) + fixtures -> site/data.json
data/fixtures.json  kampliste (oppdater manuelt eller fra openfootball)
site/index.html     frontend: speiler motoren i JS, gjør live-omregning i nettleseren
.github/workflows/  nightly build + deploy til GitHub Pages
```

Motoren finnes to steder bevisst: `engine.py` for nightly pre-kamp-bygging,
samme matte i `index.html` slik at live-omregning skjer uten ny server-kjøring.
De er verifisert mot hverandre (Belgia–Egypt live gir 19.5/32.2/48.4 i begge).

## Kjør lokalt
```bash
python scripts/build.py          # genererer site/data.json
cd site && python -m http.server # åpne localhost:8000
```

## Deploy
Push til GitHub, slå på Pages (Settings → Pages → Source: GitHub Actions).
Workflowen bygger nightly kl. 05 UTC og ved hver push. Manuell trigger:
Actions → Build and deploy → Run workflow.

## Modellantakelser (vær ærlig om disse)
- Elo fanger forventet styrke, ikke skader/form/tropp på dagen.
- Poisson antar uavhengige mål med konstant rate — fanger ikke kollaps
  (lag som gir opp ned 0-3) eller momentum. Høyre-halen på totalen er
  derfor litt undervurdert i utklassinger.
- Live blander observert xG-rate 60% / Elo-forventning 40% for å unngå
  overreaksjon på små utvalg tidlig i kampen.
- Vinnersjanse-fanen er en Elo-proxy (softmax), ikke full Monte Carlo.
  Den fulle bracket-simuleringen ligger i `simulate.py` (kjøres separat).

## Neste steg
- `simulate.py`: full 50k Monte Carlo med tredjeplass-logikk og R32-brakett
  (koden finnes — koble den inn i build.py for ekte vinnersjanse i data.json).
- Logg prediksjon vs faktisk resultat per kamp for å måle kalibrering over tid.
- Auto-oppdater fixtures fra openfootball/worldcup.json i workflowen.
