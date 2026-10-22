# s-core-map

Motore mappa comune delle app S* (oggi SMap). Crate Rust che incorpora e serve il motore
JavaScript (`web/map.js`, `web/map.css`), MapLibre GL e i caratteri IBM Plex delle etichette.

## Cosa fa il motore (`web/map.js`)
- fondali: stradale (OpenFreeMap liberty), satellite (Esri Clarity → serie normale se non
  risponde; Google dal server se attivo), mappa notte (palette sulla stradale o stile scuro
  dell'app); segue `data-theme` dell'interfaccia; ultima zona vista; fondale di sessione
- controlli: Strada/Satellite + tasto "Cosa vedere", zoom, bussola (telefono: solo se ruotata),
  scala; rotellina attorno a ciò che si segue; la camera non si muove mentre tocco
- icone su canvas: frecce, etichette (pillole con nome/velocità, righe con omino/freccia),
  segnaposti, omini dei colleghi, STOP, bolle dei gruppi, io (freccia/omino/cono)
- sorgenti e livelli: punti/aree, scie, storico, percorso, target, colleghi, io, gruppi
- etichette che non si accavallano; scorrimento morbido dei target; fermo "ancorato"
- tocco su target/colleghi/punti con scelta tra elementi vicini (elenco o raggiera),
  pressione lunga; raggruppamento di ciò che si sovrappone sullo schermo

Non sa niente di dati, API, WebSocket, navigatore, elenchi: l'app glieli dà con i ganci
(`MapCore.create({ container, hooks })`, elencati in cima a `map.js`).

## Uso
`Cargo.toml`: `s-core-map = { git = "https://github.com/fmichael98/s-core-map", rev = "…" }`

Router: `.merge(s_core_map::routes())` (rotte pubbliche `/map.js`, `/map.css`, `/vendor/…`).

`index.html` (dopo il guscio s-core, prima di `app.js`):
```html
<link rel="stylesheet" href="/vendor/maplibre-gl.css">
<link rel="stylesheet" href="/map.css?v=0.1.1">
<script src="/vendor/maplibre-gl.js"></script>
<script src="/map.js?v=0.1.1"></script>
```
`app.js`:
```js
const MC = MapCore.create({ container: 'map', storageKey: 'smap', hooks: { render, redraw, onStyleLoad, describe, onPick, clusterItems, … } });
const map = MC.map;
MC.upsertMarker(id, { lon, lat, ts, speed, course, valid });   // posizione di un target
MC.labelImg('Nome', '42 km/h'); MC.arrowImg('#f00'); MC.pinImg('#e11d48');   // immagini a richiesta
MC.drawTrails([{ id, color, from, pts: [[lon, lat, ms], …] }]);
```
Colori: il motore usa le variabili dell'app (`--surface`, `--surface-2`, `--border`, `--text`,
`--muted`, `--accent`, `--font`, `--mono`) con valori di ripiego.

## Rilascio
Alza `version` in Cargo.toml (e `MapCore.version` in map.js), commit, push. Le app puntano al `rev`.
