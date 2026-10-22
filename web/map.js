/* s-core-map — motore mappa comune delle app S* (SMap e, in futuro, altre).
 *
 * Sopra MapLibre GL mette tutto ciò che riguarda il DISEGNO sulla mappa:
 *   fondali (stradale OpenFreeMap, satellite Esri/Google, mappa notte), tema chiaro/scuro,
 *   controlli (Strada/Satellite/livelli, zoom, bussola, scala), ultima zona vista,
 *   icone disegnate su canvas (frecce, etichette, segnaposti, omini, STOP, gruppi),
 *   sorgenti e livelli dell'app (punti/aree, scie, storico, percorsi, target, colleghi, io),
 *   etichette che non si accavallano, scorrimento morbido dei target, "fermo ancorato",
 *   gesti dell'utente (la camera non si muove da sola mentre tocco), tocco/pressione lunga
 *   sugli elementi con scelta tra elementi vicini, raggruppamento (bolle col numero, raggiera).
 *
 * NON sa niente di dati, API, WebSocket, navigatore, elenchi: l'app glieli dà con i ganci.
 *
 *   const MC = MapCore.create({ container: 'map', hooks: {...} });   // MC.map è la mappa MapLibre
 *
 * Ganci (tutti facoltativi):
 *   autoCam()            true se la camera è guidata dall'app (navigazione): niente ricentramenti/rotazioni del motore
 *   autoRotating()       true se la mappa ruota da sola (bussola nascosta)
 *   following()          true se la mappa segue qualcosa (rotellina: zoom attorno al centro)
 *   focusPos()           [lon,lat] da rimettere al centro a fine gesto (null = niente)
 *   followId()           id del target da tenere al centro durante lo scorrimento (null = nessuno)
 *   canReload()          false se la pagina non va ricaricata al cambio telefono/computer
 *   render()             ridisegna i target (sorgente "veh") — chiamato dal motore quando serve
 *   redraw()             ridisegna tutto ciò che ha etichette/colori (target, colleghi, punti, io)
 *   onStyleLoad()        stile caricato e livelli creati: l'app rimette i suoi dati
 *   onStyleReady()       anche gruppi e percorsi al loro posto (ultimo gancio del caricamento)
 *   onAnimEnd()          finito lo scorrimento dei target (es. chiudere le scie sul punto raggiunto)
 *   onBasemap(bm)        cambiato fondale ('liberty' | 'satellite')
 *   onTheme(dark)        cambiato tema della mappa
 *   onLayers(ctl)        tasto "Cosa vedere" premuto (ctl = elemento del selettore)
 *   onImage(id)          immagine sconosciuta al motore: ritorna un canvas (o null)
 *   onUserDrag()         l'utente trascina la mappa
 *   onUserZoom()         l'utente zooma/ruota la mappa
 *   selected()           id del target selezionato (etichetta con priorità, mai raggruppato)
 *   pickBlocked()        true se il tocco sulla mappa non deve scegliere elementi (es. disegno in corso)
 *   describe(item)       {name, type, sw (html), pos} per {kind:'veh'|'peer'|'poi'|'me', id} — null = non mostrare
 *   onPick(item, lngLat) elemento scelto (tocco o dalla raggiera/elenco)
 *   onPickStart()        prima di aprire la scelta (mobile: chiudere pannelli)
 *   onLongPress(item, point) pressione lunga su un target
 *   closeMenus()         chiudere menu dell'app (prima di raggiera/elenco)
 *   clusterItems()       [{key, kind, id, pos, color}] elementi che possono raggrupparsi
 */
(function () {
'use strict';

const MapCore = { version: '0.1.1' };

function create(cfg) {
  const H = Object.assign({}, cfg.hooks || {});
  const KEY = cfg.storageKey || 'smap';
  const h = (name, ...a) => { const f = H[name]; if (!f) return undefined; try { return f(...a); } catch (e) { console.error(e); return undefined; } };
  const MC = { hooks: H };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---------------------------------------------------------------- fondali
  const SAT_CLARITY = 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const SAT_STD = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const STYLES = {
    liberty: cfg.roadStyle || 'https://tiles.openfreemap.org/styles/liberty',
    satellite: {
      version: 8,
      sources: {
        esri: {
          // schermi ad alta densità: piastrelle di un livello più dettagliato (foto nitida, non "stirata")
          type: 'raster', tileSize: (window.devicePixelRatio || 1) >= 1.5 ? 128 : 256, maxzoom: 19,
          // Esri "Clarity": immagini più nitide e meno ritoccate (se non risponde, torno alla serie normale)
          tiles: [SAT_CLARITY],
          attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
        },
      },
      // etichette aggiunte a parte, vettoriali (nitide) da OpenFreeMap — vedi addSatLabels()
      layers: [{ id: 'esri', type: 'raster', source: 'esri', paint: { 'raster-fade-duration': 0 } }],
    },
  };
  // Si parte sempre dalla mappa stradale. Il satellite vale solo per la sessione in corso: chiudendo
  // l'app/la scheda, o tornandoci dopo BM_IDLE senza usarla, si torna alla stradale.
  const BM_IDLE = 30 * 60000;
  MC.basemap = (() => {
    try {
      const s = JSON.parse(sessionStorage.getItem(KEY + '.bm') || 'null');
      if (s && STYLES[s.bm] && Date.now() - s.ts < BM_IDLE) return s.bm;
    } catch {}
    return 'liberty';
  })();
  const saveBasemap = () => { try { sessionStorage.setItem(KEY + '.bm', JSON.stringify({ bm: MC.basemap, ts: Date.now() })); } catch {} };
  saveBasemap();
  {
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); saveBasemap(); return; }
      if (MC.basemap !== 'liberty' && hiddenAt && Date.now() - hiddenAt > BM_IDLE) setBasemap('liberty');
      hiddenAt = 0; saveBasemap();
    });
    addEventListener('pagehide', saveBasemap);
    setInterval(() => { if (!document.hidden) saveBasemap(); }, 60000);   // in uso: la sessione resta viva
  }
  MC.mapDark = false;
  // colore "auto": nero sulla mappa chiara, bianco su quella scura (si ricalcola al cambio)
  MC.autoColor = () => (MC.mapDark || MC.basemap === 'satellite' ? '#f4f4f5' : '#18181b');
  // mappa notte: stile apposta (es. MapTiler, se l'app lo passa con setDarkStyle), altrimenti la
  // mappa stradale ricolorata con la palette notte
  let DARK_ROADS = null, darkIsMapTiler = false;
  MC.setDarkStyle = (url) => { DARK_ROADS = url || null; darkIsMapTiler = !!url; syncMapTheme(true); };
  // satellite di Google (dal server, con strade e nomi già sopra) se attivo; altrimenti Esri gratuito
  const SG = Object.assign({ tiles: '/api/sat/{z}/{x}/{y}', maxzoom: '/api/sat/maxzoom', config: '/api/config' }, cfg.satGoogle || {});
  let SAT_GOOGLE = (() => { try { return localStorage.getItem(KEY + '.satGoogle') === '1'; } catch { return false; } })();
  const GSAT_STYLE = {
    version: 8,
    sources: { gsat: { type: 'raster', tiles: [location.origin + SG.tiles], tileSize: 256, maxzoom: 21, attribution: 'Immagini e mappe © Google' } },
    layers: [{ id: 'gsat', type: 'raster', source: 'gsat', paint: { 'raster-fade-duration': 0 } }],
  };
  const styleFor = () => (MC.basemap === 'satellite' && SAT_GOOGLE ? GSAT_STYLE
    : MC.basemap === 'liberty' && MC.mapDark && DARK_ROADS ? DARK_ROADS : STYLES[MC.basemap]);
  // stesso zoom massimo per strada e satellite: passando dall'una all'altro lo zoom resta uguale;
  // satellite gratuito (Esri): meno dettaglio, zoom più limitato; Google: fino a dove ha le foto
  const MAXZOOM = { liberty: 20, satellite: 20 };
  let SAT_MAXZ = null;
  const maxZoomFor = () => (MC.basemap === 'satellite' && !SAT_GOOGLE ? 18.5 : MC.basemap === 'satellite' ? (SAT_MAXZ ?? 20) : MAXZOOM[MC.basemap] ?? 20);
  MC.maxZoomFor = maxZoomFor;
  function applyMaxZoom() {
    const mz = maxZoomFor();
    if (Math.abs(map.getMaxZoom() - mz) > 0.01) map.setMaxZoom(mz);
  }
  // logo Google sulla mappa (richiesto) quando il satellite viene da Google
  function syncGoogleLogo() {
    let el = document.getElementById('gLogo');
    const on = MC.basemap === 'satellite' && SAT_GOOGLE;
    if (!on) { el?.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'gLogo'; el.className = 'g-logo'; el.textContent = 'Google'; map.getContainer().appendChild(el); }
  }
  // stato del satellite Google (chiave, limite esaurito…): se cambia, ricarico lo stile
  function applySatGoogle(v) {
    v = !!v;
    try { localStorage.setItem(KEY + '.satGoogle', v ? '1' : '0'); } catch {}
    if (v === SAT_GOOGLE) return;
    SAT_GOOGLE = v;
    if (MC.basemap === 'satellite') {
      map.setStyle(styleFor(), { diff: false });   // cambio di fonte: stile ricaricato da zero
      map.setMaxZoom(maxZoomFor());
    }
    syncGoogleLogo();
  }
  MC.applySatGoogle = applySatGoogle;
  const checkSatGoogle = () => fetch(SG.config, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((c) => { if (c) applySatGoogle(c.satGoogle); }).catch(() => {});
  MC.checkSatGoogle = checkSatGoogle;
  setInterval(checkSatGoogle, 5 * 60000);

  const isMobile = () => window.innerWidth <= 760;
  MC.isMobile = isMobile;
  // finestra del computer allargata o stretta oltre la soglia: i comandi (zoom, pannello, tasti)
  // si scelgono all'apertura, quindi rimetto in piedi la pagina nella forma giusta invece di
  // lasciare un misto tra telefono e computer. Non nell'app e non durante una navigazione.
  {
    const mq = matchMedia('(max-width: 760px)');
    mq.addEventListener?.('change', () => {
      if (window.AndroidApp || h('canReload') === false || document.querySelector('dialog[open]')) return;
      saveView(0);
      location.reload();
    });
  }
  // desktop: lo zoom dell'interfaccia è bloccato; Ctrl/⌘ +/− zoomano la mappa
  addEventListener('smap:zoomkey', (e) => { if (e.detail > 0) map.zoomIn(); else map.zoomOut(); });
  // riquadri aperti sulla mappa: si chiudono quando l'utente trascina la mappa
  const OPEN_POPS = new Set();
  MC.OPEN_POPS = OPEN_POPS;
  {
    const addTo = maplibregl.Popup.prototype.addTo;
    maplibregl.Popup.prototype.addTo = function (m) {
      OPEN_POPS.add(this); this.once('close', () => OPEN_POPS.delete(this));
      return addTo.call(this, m);
    };
  }
  // riapertura: ultima zona vista, un po' più da lontano
  const SAVED_VIEW = (() => { try { const v = JSON.parse(localStorage.getItem(KEY + '.view') || 'null'); return v?.c?.length === 2 && isFinite(v.z) ? v : null; } catch { return null; } })();
  MC.SAVED_VIEW = SAVED_VIEW;
  const map = new maplibregl.Map({
    container: cfg.container || 'map',
    style: styleFor(),
    center: SAVED_VIEW ? SAVED_VIEW.c : cfg.center || [12.57, 44.06],
    zoom: SAVED_VIEW ? Math.max(3, SAVED_VIEW.z - 1.5) : cfg.zoom ?? 11,
    maxZoom: maxZoomFor(),
    attributionControl: false,
    maxPitch: 0,          // mappa solo 2D: niente inclinazione
    fadeDuration: 0,      // etichette: niente dissolvenza (due etichette non si vedono mai sovrapposte)
    bearingSnap: 0,       // niente "calamita" verso nord
    pitchWithRotate: false,
    touchPitch: false,
  });
  MC.map = map;
  syncGoogleLogo();
  // satellite Google: chiedo fin dove ci sono foto nel punto inquadrato e non lascio zoomare oltre
  // (Google lavora a piastrelle di un livello più dettagliato di quello della mappa: -0.5)
  {
    let tm = 0, seq = 0;
    const check = () => {
      clearTimeout(tm);
      tm = setTimeout(async () => {
        if (MC.basemap !== 'satellite' || !SAT_GOOGLE) { if (SAT_MAXZ != null) { SAT_MAXZ = null; applyMaxZoom(); } return; }
        const c = map.getCenter(), my = ++seq;
        try {
          const j = await (await fetch(`${SG.maxzoom}?lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}`, { credentials: 'same-origin' })).json();
          if (my !== seq) return;
          SAT_MAXZ = j?.maxZoom ? Math.min(20, Math.max(12, j.maxZoom - 0.5)) : null;
          applyMaxZoom();
        } catch {}
      }, 350);
    };
    map.on('moveend', check); check();
    let last = 0;
    map.on('error', (e) => {
      if (e.sourceId !== 'gsat' || Date.now() - last < 10000) return;
      last = Date.now(); checkSatGoogle();
    });
  }
  // satellite "Clarity" che non risponde (bloccato o fuori servizio): passo alla serie normale di Esri
  {
    let fails = 0, ok = 0;
    map.on('error', (e) => {
      if (e.sourceId !== 'esri' || STYLES.satellite.sources.esri.tiles[0] !== SAT_CLARITY) return;
      if (++fails >= 6 && ok < 3) {
        console.warn('satellite Clarity non disponibile: uso la serie normale');
        STYLES.satellite.sources.esri.tiles = [SAT_STD];
        if (MC.basemap === 'satellite' && !SAT_GOOGLE) map.setStyle(styleFor(), { diff: false });
      }
    });
    map.on('sourcedata', (e) => { if (e.sourceId === 'esri' && e.tile && e.tile.state === 'loaded') ok++; });
  }
  // Dito/mouse sulla mappa: la camera non si muove più "da sola" (navigazione, inseguimento):
  // ogni spostamento automatico annullerebbe il gesto appena iniziato (zoom/trascinamento bloccati)
  MC.camHold = false;
  let camHoldTm = 0;
  {
    const cont = map.getCanvasContainer();
    const hold = () => { MC.camHold = true; clearTimeout(camHoldTm); };
    const release = (ms = 350) => { clearTimeout(camHoldTm); camHoldTm = setTimeout(() => { MC.camHold = false; refocus(); }, ms); };
    cont.addEventListener('touchstart', hold, { passive: true, capture: true });
    cont.addEventListener('touchend', (e) => { if (!e.touches.length) release(); }, { passive: true, capture: true });
    cont.addEventListener('touchcancel', () => release(), { passive: true, capture: true });
    cont.addEventListener('mousedown', hold, { capture: true });
    window.addEventListener('mouseup', () => release());
    cont.addEventListener('wheel', () => { hold(); release(500); wheelAround(); }, { passive: true, capture: true });
  }
  // finito il gesto (zoom con due dita, rotellina): se sto seguendo qualcosa lo rimetto subito al
  // centro, senza aspettare la sua prossima posizione
  function refocus() {
    if (h('autoCam') || MC.flying) return;
    const pos = h('focusPos');
    if (!pos) return;
    const c = map.getCenter();
    if (Math.abs(c.lng - pos[0]) > 1e-6 || Math.abs(c.lat - pos[1]) > 1e-6) map.easeTo({ center: pos, duration: 300, essential: true });
  }
  MC.refocus = refocus;
  // rotellina del mouse: se sto seguendo qualcosa lo zoom resta centrato su di lui invece che
  // sul puntatore; il fuoco si toglie solo trascinando la mappa o scegliendo un altro elemento
  let WHEEL_CENTER = false;
  function wheelAround() {
    const want = !h('autoCam') && !!h('following');
    if (want === WHEEL_CENTER) return;
    WHEEL_CENTER = want;
    map.scrollZoom.disable();
    map.scrollZoom.enable(want ? { around: 'center' } : undefined);
  }
  MC.wheelAround = wheelAround;
  // la mappa cambia altezza (tastiera che si apre/chiude): tengo fermo il bordo in alto invece del
  // centro, così la mappa non "salta"
  {
    let lastH = map.getContainer().clientHeight, lastW = map.getContainer().clientWidth;
    map.on('resize', () => {
      const hh = map.getContainer().clientHeight, w = map.getContainer().clientWidth;
      // durante un volo/animazione non tocco la camera: lo interromperei
      if (w === lastW && hh !== lastH && !h('autoCam') && !map.isMoving()) map.panBy([0, (hh - lastH) / 2], { duration: 0 });
      lastH = hh; lastW = w;
    });
  }
  // ultima zona vista: salvata per la prossima apertura
  let viewTm = 0;
  function saveView(delay = 800) {
    clearTimeout(viewTm);
    const go = () => { try { const c = map.getCenter(); localStorage.setItem(KEY + '.view', JSON.stringify({ c: [+c.lng.toFixed(5), +c.lat.toFixed(5)], z: +map.getZoom().toFixed(2) })); } catch {} };
    if (delay) viewTm = setTimeout(go, delay); else go();
  }
  map.on('moveend', () => saveView());
  // zoom con rotella più fluido e uniforme (evita salti grandi/piccoli)
  map.scrollZoom.setWheelZoomRate(1 / 220);
  map.scrollZoom.setZoomRate(1 / 120);
  // niente rotazione manuale da PC (l'inseguimento ruota comunque via codice); con due dita solo su mobile
  map.dragRotate.disable();
  if (!isMobile()) map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation?.();

  // ---------------------------------------------------------------- bussola
  // telefono: la bussola compare se la mappa è ruotata; tornata a nord resta 1 secondo e poi
  // sparisce con una piccola "implosione". Mentre la mappa ruota da sola (navigazione) niente bussola.
  if (isMobile()) map.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showCompass: true, showZoom: false }), 'top-right');
  {
    let hideTm = 0;
    const rot = () => {
      const c = map.getContainer();
      const want = Math.abs(map.getBearing()) > 0.5 && !h('autoRotating');
      if (want) { clearTimeout(hideTm); hideTm = 0; c.classList.remove('compass-out'); c.classList.add('rotated'); return; }
      if (!c.classList.contains('rotated') || hideTm) return;
      hideTm = setTimeout(() => {
        hideTm = 0;
        c.classList.add('compass-out');
        setTimeout(() => { if (c.classList.contains('compass-out')) c.classList.remove('rotated', 'compass-out'); }, 480);
      }, 1000);
    };
    map.on('rotate', rot); map.on('load', rot);
    MC.syncCompass = rot;
  }

  // ---------------------------------------------------------------- selettore Strada / Satellite
  class BasemapControl {
    onAdd() {
      const c = document.createElement('div');
      c.className = 'maplibregl-ctrl basemap-ctrl';
      c.innerHTML = `<button type="button" data-bm="liberty">Strada</button><button type="button" data-bm="satellite">Satellite</button>
        <button type="button" class="bm-layers" data-layers title="Cosa vedere sulla mappa" aria-label="Cosa vedere sulla mappa">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></svg></button>`;
      c.addEventListener('click', (e) => {
        if (e.target.closest('[data-layers]')) { e.stopPropagation(); h('onLayers', c); return; }
        const b = e.target.closest('[data-bm]');
        if (b) setBasemap(b.dataset.bm);
      });
      this.c = c;
      this.sync();
      return c;
    }
    sync() { for (const b of this.c.querySelectorAll('[data-bm]')) b.setAttribute('aria-pressed', String(b.dataset.bm === MC.basemap)); }
    onRemove() { this.c.remove(); }
  }
  const basemapCtl = new BasemapControl();
  MC.basemapCtl = basemapCtl;
  // desktop, in alto a destra: Strada/Satellite/livelli, sotto lo zoom, sotto ancora la bussola
  // (clic sinistro: ruota di 90° a sinistra; clic destro: di 90° a destra)
  class CompassControl {
    onAdd(m) {
      const c = this.c = document.createElement('div');
      c.className = 'maplibregl-ctrl maplibregl-ctrl-group compass-ctl';
      c.innerHTML = `<button type="button" class="maplibregl-ctrl-compass" title="Clic: ruota di 90° a sinistra · tasto destro: a destra"><span class="maplibregl-ctrl-icon" aria-hidden="true"></span></button>`;
      const icon = c.querySelector('.maplibregl-ctrl-icon');
      const sync = () => { icon.style.transform = `rotate(${-m.getBearing()}deg)`; };
      m.on('rotate', sync); sync();
      const turn = (d) => m.easeTo({ bearing: Math.round((m.getBearing() + d) / 90) * 90, duration: 450 });
      c.querySelector('button').addEventListener('click', (e) => { e.preventDefault(); turn(-90); });
      c.querySelector('button').addEventListener('contextmenu', (e) => { e.preventDefault(); turn(90); });
      return c;
    }
    onRemove() { this.c.remove(); }
  }
  if (isMobile()) map.addControl(basemapCtl, 'top-left');
  else {
    map.addControl(basemapCtl, 'top-right');
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showCompass: false, showZoom: true }), 'top-right');
    map.addControl(new CompassControl(), 'top-right');
  }
  // scala: desktop in basso a destra, mobile in basso a sinistra
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 110 }), isMobile() ? 'bottom-left' : 'bottom-right');

  function setBasemap(bm) {
    if (bm === MC.basemap || !STYLES[bm]) return;
    MC.basemap = bm;
    refreshLabels();
    saveBasemap();
    map.setStyle(styleFor());
    syncGoogleLogo();
    const mz = maxZoomFor();
    map.setMaxZoom(mz);
    if (map.getZoom() > mz) map.setZoom(mz);
    basemapCtl.sync();
    h('onBasemap', bm);   // colore "auto": sul satellite diventa bianco
  }
  MC.setBasemap = setBasemap;

  // Se il server delle mappe non risponde, l'app resta usabile su sfondo neutro
  const FALLBACK_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9ecef' } }] };
  map.on('error', (e) => {
    // stile scuro dell'app (es. chiave MapTiler errata/scaduta): torno alla mappa notte
    if (darkIsMapTiler && /maptiler/i.test(String(e.error?.message || e.error?.url || '')) && !map.isStyleLoaded()) {
      console.warn('Stile scuro non disponibile, uso la mappa notte');
      darkIsMapTiler = false; DARK_ROADS = null;
      map.setStyle(styleFor());
      return;
    }
    if (/\/styles\//.test(String(e.error?.message)) && !map.isStyleLoaded()) {
      console.warn('Stile mappa non raggiungibile, uso sfondo neutro');
      map.setStyle(FALLBACK_STYLE);
    }
  });

  // ---------------------------------------------------------------- etichette che non si accavallano
  // ogni etichetta resta SOTTO il suo segnalino; se tocca un'altra etichetta la faccio scorrere in
  // orizzontale quel tanto che basta (il segnalino resta sempre dentro la sua larghezza). Se non
  // basta, la mappa ne nasconde una (collisione nativa): due etichette non si sovrappongono mai.
  const LA = new Map();
  MC.LA = LA;
  let laTm = 0;
  const scheduleLabelLayout = () => { clearTimeout(laTm); laTm = setTimeout(layoutLabels, 200); };
  function layoutLabels() {
    // le etichette nascoste dalla mappa non risultano "disegnate": leggo i segnalini (sempre visibili)
    const defs = [['veh-label', ['veh-dot', 'veh-cam', 'veh-stop'], 'veh', 'id', 14], ['peer-label', ['peer-dot'], 'peer', 'u', 14], ['peer-off-label', ['peer-off-dot'], 'peer', 'u', 13], ['poi-label', ['poi-pt'], 'poi', 'id', 3]]
      .filter(([l]) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
    if (!defs.length) return;
    const sel = h('selected');
    const items = [], seen = new Set();
    for (const [, marks, kind, key, base] of defs) {
      const layers = marks.filter((l) => map.getLayer(l));
      if (!layers.length) continue;
      for (const f of map.queryRenderedFeatures({ layers })) {
        if (f.geometry?.type !== 'Point' || !f.properties?.label) continue;
        const id = f.properties[key], k = `${kind}:${id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const p = map.project(f.geometry.coordinates);
        const img = map.getImage?.(f.properties.label);
        const w = img ? img.data.width / (img.pixelRatio || DPR) : 80, hh = img ? img.data.height / (img.pixelRatio || DPR) : 18;
        items.push({ k, p, w, h: hh, base, pri: kind === 'veh' && String(id) === String(sel) ? 0 : kind === 'veh' ? 1 : kind === 'peer' ? 2 : 3 });
      }
    }
    items.sort((a, b) => a.pri - b.pri || a.p.y - b.p.y);
    const GAP = 5;   // distanza minima tra due etichette
    const hit = (a, b) => a[0] < b[0] + b[2] + GAP && b[0] < a[0] + a[2] + GAP && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
    const placed = [];   // { it, dx, r }
    const boxOf = (it, dx) => [it.p.x + dx - it.w / 2, it.p.y + it.base, it.w, it.h];
    const limOf = (it) => Math.min(160, Math.max(0, it.w / 2 - 8));   // il segnalino resta sotto l'etichetta
    const free = (r, skip) => !placed.some((q) => q !== skip && hit(r, q.r));
    // anche i segnalini degli altri: un'etichetta non dovrebbe coprirli (se si può evitare)
    const markR = (it) => it.base < 10 ? [it.p.x - 12, it.p.y - 32, 24, 32] : [it.p.x - 12, it.p.y - 12, 24, 24];
    const clearOfMarks = (r, self) => !items.some((o) => o !== self && hit(r, markR(o)));
    for (const it of items) {
      const lim = limOf(it);
      let dx = 0;
      // stabile: se la posizione di prima va ancora bene la tengo (niente etichette che "ballano")
      const prev = LA.get(it.k) || 0;
      const okAt = (d) => { const r = boxOf(it, d); return free(r) && clearOfMarks(r, it); };
      if (!okAt(0) && prev && Math.abs(prev) <= lim && okAt(prev)) dx = prev;
      else if (!okAt(0)) {
        dx = null;
        // 1) libera da etichette e segnalini, 2) almeno libera dalle etichette
        for (const strict of [true, false]) {
          if (dx != null) break;
          for (let d = strict ? 0 : 2; d <= lim && dx == null; d += 2) for (const c of d ? [d, -d] : [0]) {
            const r = boxOf(it, c);
            if (free(r) && (!strict || clearOfMarks(r, it))) { dx = c; break; }
          }
        }
        // non basta spostare questa: sposto un po' anche quella con cui si tocca, in senso opposto
        if (dx == null) {
          const conf = placed.filter((q) => hit(boxOf(it, 0), q.r));
          if (conf.length === 1) {
            const q = conf[0], dir = it.p.x >= q.it.p.x ? 1 : -1;
            for (let a = 2; a <= lim && dx == null; a += 2) {
              const r = boxOf(it, dir * a);
              for (let b = 2; Math.abs(q.dx - dir * b) <= limOf(q.it); b += 2) {
                const qr = boxOf(q.it, q.dx - dir * b);
                if (!hit(r, qr) && free(qr, q) && free(r, q)) { q.dx -= dir * b; q.r = qr; dx = dir * a; break; }
              }
            }
          }
        }
        if (dx == null) dx = 0;   // non c'è spazio: ci pensa la collisione della mappa (ne nasconde una)
      }
      placed.push({ it, dx, r: boxOf(it, dx) });
    }
    let changed = false;
    for (const { it, dx } of placed) {
      const v = Math.round(dx / 2) * 2 || undefined;
      if (LA.get(it.k) !== v) { if (v) LA.set(it.k, v); else LA.delete(it.k); changed = true; }
    }
    if (changed) redrawAll();
  }
  map.on('moveend', scheduleLabelLayout);
  setInterval(() => { if (!map.isMoving()) layoutLabels(); }, 2000);
  // ridisegno di tutto ciò che ha etichette (target, colleghi, punti, io): gruppi inclusi
  function redrawAll() { CL.sig = ''; h('redraw'); }
  MC.redrawAll = redrawAll;
  // cambio tema/mappa: ridisegno le etichette (nuovi colori)
  function refreshLabels() { setTimeout(redrawAll, 50); }
  MC.refreshLabels = refreshLabels;
  // etichetta sotto il suo segnalino, spostata in orizzontale di "lx" px (passi di 2) se serve
  function labelOffset(base) {
    const e = ['match', ['coalesce', ['get', 'lx'], 0]];
    for (let x = -160; x <= 160; x += 2) if (x) e.push(x, ['literal', [x, base]]);
    e.push(['literal', [0, base]]);
    return e;
  }
  MC.labelOffset = labelOffset;
  // simboli che si muovono: icon-size ≠ 1 => filtro lineare, niente tremolio a sottopixel
  const SMOOTH = 0.9999;
  MC.SMOOTH = SMOOTH;
  // trasparenza delle bolle sopra la mappa (gruppi)
  const BUBBLE_A = 0.8;

  // ---------------------------------------------------------------- tema della mappa
  // la mappa stradale segue il tema dell'interfaccia (data-theme="dark" → mappa notte)
  function syncMapTheme(force) {
    const want = document.documentElement.dataset.theme === 'dark';
    if (want === MC.mapDark && !force) return;
    MC.mapDark = want;
    h('onTheme', want);
    refreshLabels();
    if (MC.basemap !== 'liberty') return;                          // satellite: invariato
    if (DARK_ROADS && want) map.setStyle(styleFor());              // stile scuro dell'app
    else if (want) { try { applyMapDark(); } catch {} }            // palette notte sulla mappa già caricata
    else map.setStyle(STYLES.liberty, { diff: false });           // torno ai colori originali
  }
  new MutationObserver(() => syncMapTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  syncMapTheme();   // tema già scuro all'apertura: la mappa notte si applica al caricamento dello stile
  // Mappa scura: la stessa mappa stradale (stesse etichette, cartelli e icone) ricolorata con una
  // palette notte. Regole per nome del livello dello stile OpenFreeMap "liberty".
  const NIGHT = {
    bg: '#11151b', park: '#172119', wood: '#161f18', grass: '#18221a', resid: '#1a1e25', ice: '#1e2a33', sand: '#22211b',
    pitch: '#19241c', cemetery: '#172019', hospital: '#4a2531', school: '#353320',
    water: '#173a5c', waterway: '#2f6a99', aero: '#1d2129', runway: '#2b313b', building: '#20252d',
    casing: '#0a0c10', motorway: '#d4884a', motorwayTunnel: '#a8703f', major: '#c9a54c', secondary: '#8f8a66',
    minor: '#69717f', path: '#5a616d', rail: '#5c6370', boundary: '#7a7f95', boundaryLow: '#555b70',
    place: '#e6e8ec', road: '#c3c8d0', roadPath: '#9aa1ad', waterLbl: '#7db4e0', poi: '#aeb4be', halo: '#0b0d11',
  };
  function nightColor(l) {
    const id = l.id;
    if (l.type === 'background') return ['background-color', NIGHT.bg];
    if (l.type === 'fill' || l.type === 'fill-extrusion') {
      const k = l.type === 'fill' ? 'fill-color' : 'fill-extrusion-color';
      if (id === 'water') return [k, NIGHT.water];
      if (id.startsWith('park')) return [k, NIGHT.park];
      if (/wood/.test(id)) return [k, NIGHT.wood];
      if (/grass/.test(id)) return [k, NIGHT.grass];
      if (/residential/.test(id)) return [k, NIGHT.resid];
      if (/ice/.test(id)) return [k, NIGHT.ice];
      if (/sand/.test(id)) return [k, NIGHT.sand];
      if (/pitch|track/.test(id)) return [k, NIGHT.pitch];
      if (/cemetery/.test(id)) return [k, NIGHT.cemetery];
      if (/hospital/.test(id)) return [k, NIGHT.hospital];
      if (/school/.test(id)) return [k, NIGHT.school];
      if (/aeroway/.test(id)) return [k, NIGHT.aero];
      if (/building/.test(id)) return [k, NIGHT.building];
      return null;
    }
    if (l.type === 'line') {
      // stradine viste da lontano: il bordo scuro è più largo della linea e la "spegne";
      // da lontano lo schiarisco quasi come la strada, da vicino torna scuro
      if (/casing/.test(id) && /minor|street|service_track/.test(id))
        return ['line-color', ['interpolate', ['linear'], ['zoom'], 12, '#7f8794', 14, '#596170', 15.5, NIGHT.casing]];
      if (/casing/.test(id)) return ['line-color', NIGHT.casing];
      if (id === 'park_outline') return ['line-color', NIGHT.park];
      if (/^waterway/.test(id)) return ['line-color', NIGHT.waterway];
      if (/runway|taxiway/.test(id)) return ['line-color', NIGHT.runway];
      if (/boundary_3/.test(id)) return ['line-color', NIGHT.boundaryLow];
      if (/boundary/.test(id)) return ['line-color', NIGHT.boundary];
      if (/rail/.test(id)) return ['line-color', NIGHT.rail];
      if (/motorway/.test(id)) return ['line-color', id.startsWith('tunnel') ? NIGHT.motorwayTunnel : NIGHT.motorway];
      if (/trunk_primary|_link$/.test(id)) return ['line-color', NIGHT.major];
      if (/secondary_tertiary/.test(id)) return ['line-color', NIGHT.secondary];
      if (/path_pedestrian/.test(id)) return ['line-color', NIGHT.path];
      // da lontano le stradine sono sottilissime: più chiare, avvicinandosi tornano al grigio normale
      if (/minor|street|service_track/.test(id)) return ['line-color', ['interpolate', ['linear'], ['zoom'], 12, '#a3aab6', 14, '#8a919e', 16, NIGHT.minor]];
      return null;
    }
    return null;
  }
  // Confini delle regioni (admin_level 4) sulla mappa stradale, tratteggio leggero. Sul satellite
  // ci sono già (sat-border-4).
  function addRegionBorders() {
    if (MC.basemap !== 'liberty' || map.getLayer('region-border')) return;
    const st = map.getStyle();
    const vsrc = st.layers.find((l) => l['source-layer'] === 'boundary')?.source
      || Object.keys(st.sources).find((k) => st.sources[k].type === 'vector');
    if (!vsrc) return;
    const col = MC.mapDark ? '#5b6276' : '#9aa0ad';
    const before = st.layers.find((l) => l.type === 'symbol')?.id;   // appena sotto le etichette
    try {
      map.addLayer({
        id: 'region-border', type: 'line', source: vsrc, 'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': col, 'line-opacity': 0.6, 'line-dasharray': [3, 2], 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 9, 1, 13, 1.6] },
      }, before);
    } catch {}
  }
  function applyMapDark() {
    // lo stile scuro dell'app è già fatto per la notte: lo lascio com'è
    if (!(MC.mapDark && MC.basemap === 'liberty') || darkIsMapTiler) return;
    if (map.getLayer('region-border')) map.setPaintProperty('region-border', 'line-color', NIGHT.boundaryLow);
    for (const l of map.getStyle()?.layers || []) {
      try {
        if (l.type === 'raster') { map.setPaintProperty(l.id, 'raster-brightness-max', 0.3); continue; }
        if (l.id === 'road_area_pattern') { map.setPaintProperty(l.id, 'fill-opacity', 0.08); continue; } // piazze: niente zebratura vistosa
        if (/hatching/.test(l.id)) { map.setPaintProperty(l.id, 'line-opacity', 0.35); }
        // boschi/verde: di notte erano verdi accesi. Le texture ad alberelli (fill-pattern) e i
        // verdi del territorio vanno smorzati molto (ghiacciai, sabbia e zone abitate esclusi)
        const veg = /wood|forest|grass|scrub|heath|park|vegetation|wetland|farm|orchard|meadow|vineyard|golf/.test(l.id)
          && !/ice|glacier|sand|residential/.test(l.id);
        if (veg && (l.type === 'fill' || l.type === 'fill-extrusion')) {
          const k = l.type === 'fill' ? 'fill-color' : 'fill-extrusion-color';
          if (l.paint?.['fill-pattern'] !== undefined) { try { map.setPaintProperty(l.id, 'fill-pattern', null); } catch {} }
          map.setPaintProperty(l.id, k, NIGHT.wood);
          if (l.type === 'fill') {
            map.setPaintProperty(l.id, 'fill-opacity', 0.6);
            map.setPaintProperty(l.id, 'fill-outline-color', '#1d2a20');
          }
          continue;
        }
        if (veg && l.type === 'line') { map.setPaintProperty(l.id, 'line-color', NIGHT.wood); map.setPaintProperty(l.id, 'line-opacity', 0.4); continue; }
        const c = nightColor(l);
        if (c) {
          map.setPaintProperty(l.id, c[0], c[1]);
          if (l.type === 'fill' && /building/.test(l.id)) map.setPaintProperty(l.id, 'fill-outline-color', '#2a3038');
          continue;
        }
        if (l.type !== 'symbol' || !l.layout?.['text-field']) continue;
        if (/shield/.test(l.id)) continue; // cartelli: restano come sulla mappa chiara
        const sl = l['source-layer'];
        const col = sl === 'place' ? NIGHT.place
          : /water/.test(sl) ? NIGHT.waterLbl
          : l.id === 'highway-name-path' ? NIGHT.roadPath
          : sl === 'transportation_name' ? NIGHT.road : NIGHT.poi;
        map.setPaintProperty(l.id, 'text-color', col);
        map.setPaintProperty(l.id, 'text-halo-color', NIGHT.halo);
        map.setPaintProperty(l.id, 'text-halo-width', 1.5);
      } catch {}
    }
  }

  // ---------------------------------------------------------------- strati dello stile di base
  const empty = () => ({ type: 'FeatureCollection', features: [] });
  MC.empty = empty;
  // primo livello dell'app (punti di interesse): le etichette della mappa vanno sotto
  const appBottomLayer = () => ['poi-fill', 'trails'].find((id) => map.getLayer(id));
  MC.appBottomLayer = appBottomLayer;
  // percorsi (mio e dei colleghi): SOPRA a tutte le strade della mappa (anche ponti e svincoli) ma
  // SOTTO a tutte le scritte. Dal basso: prima le navigazioni dei colleghi, poi SOPRA la mia
  const ROUTE_LAYERS = ['peer-nav-casing', 'peer-nav-line', 'peer-nav-end', 'route-casing', 'route-line', 'route-straight', 'route-conn'];
  function placeRoutes() {
    const all = map.getStyle()?.layers || [];
    const app = appBottomLayer();
    const appAt = app ? all.findIndex((l) => l.id === app) : all.length;
    const base = all.slice(0, appAt < 0 ? all.length : appAt).filter((l) => !ROUTE_LAYERS.includes(l.id));
    // ultimo strato "disegnato" della mappa (strade, ponti, aree…), edifici esclusi
    let last = -1;
    base.forEach((l, k) => { if ((l.type === 'line' || l.type === 'fill' || l.type === 'raster') && !/building/i.test(l.id)) last = k; });
    const anchor = base[last + 1]?.id || app;   // strato subito dopo: i percorsi vanno lì sotto
    if (!anchor) return;
    for (const id of ROUTE_LAYERS) if (map.getLayer(id)) { try { map.moveLayer(id, anchor); } catch {} }
    // scritte della mappa che nello stile stanno prima delle strade (es. nomi dei fiumi, numeri
    // civici): le porto sopra ai percorsi, nello stesso ordine
    const after = base[last + 1] ? anchor : null;
    for (const l of base.slice(0, last + 1)) if (l.type === 'symbol') { try { after ? map.moveLayer(l.id, after) : map.moveLayer(l.id, app); } catch {} }
  }
  MC.placeRoutes = placeRoutes;
  // Lo stile "Stradale" contiene edifici 3D (fill-extrusion): li rendo piatti.
  function flattenBuildings() {
    const layers = map.getStyle()?.layers || [];
    layers.forEach((l, i) => {
      if (l.type !== 'fill-extrusion') return;
      const before = layers[i + 1]?.id;
      const flat = { id: `${l.id}-2d`, type: 'fill', source: l.source, 'source-layer': l['source-layer'],
        paint: { 'fill-color': '#ddd6ce', 'fill-outline-color': '#cbc3ba' } };
      if (l.filter) flat.filter = l.filter;
      if (l.minzoom != null) flat.minzoom = l.minzoom;
      map.removeLayer(l.id);
      try { map.addLayer(flat, before && map.getLayer(before) ? before : undefined); } catch {}
    });
  }
  // Su satellite: etichette vettoriali di OpenFreeMap (città, vie) e strade sopra l'immagine.
  let libertyStyle = null;
  async function addSatLabels() {
    if (MC.basemap !== 'satellite' || SAT_GOOGLE) return;   // Google ha già strade e nomi
    try {
      if (!libertyStyle) libertyStyle = await fetch(STYLES.liberty).then((r) => r.json());
      // nel frattempo può essere arrivato il satellite di Google: niente doppioni
      if (MC.basemap !== 'satellite' || SAT_GOOGLE || !map.getSource('esri')) return;
      const st = libertyStyle;
      map.setGlyphs(st.glyphs);
      if (st.sprite) map.setSprite(st.sprite);
      for (const [id, src] of Object.entries(st.sources)) {
        if (src.type === 'vector' && !map.getSource(id)) map.addSource(id, src);
      }
      // strade sopra la foto (vista "ibrida"): colori PIENI e linee sottili; un solo colore per categoria
      for (const l of st.layers) {
        if (l.type !== 'line' || l['source-layer'] !== 'transportation' || map.getLayer(`sat-${l.id}`)) continue;
        if (/casing|rail|hatching|tunnel|path_pedestrian|aeroway|service_track/.test(l.id)) continue;
        const major = /motorway|trunk_primary|_link$/.test(l.id), mid = /secondary_tertiary/.test(l.id);
        const col = /motorway/.test(l.id) ? '#f2b45c' : major ? '#efd98a' : mid ? '#e9e3c4' : '#d9d9d9';
        const w = major ? [8, 0.8, 12, 1.6, 15, 3, 18, 6] : mid ? [10, 0.6, 13, 1.2, 16, 2.4, 18, 4.5] : [12, 0.4, 14, 0.9, 16, 1.8, 18, 3.5];
        const lay = { id: `sat-${l.id}`, type: 'line', source: l.source, 'source-layer': l['source-layer'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': col, 'line-width': l.paint?.['line-width'] ?? ['interpolate', ['exponential', 1.5], ['zoom'], ...w], 'line-opacity': 1 } };
        if (l.filter) lay.filter = l.filter;
        if (l.minzoom != null) lay.minzoom = Math.max(l.minzoom, major ? 6 : mid ? 10 : 13);
        try { map.addLayer(lay, appBottomLayer()); } catch {}
      }
      // strade semitrasparenti SENZA i segmenti sovrapposti più scuri: strade piene e sopra ripasso
      // la foto satellitare al 40%
      if (!map.getLayer('sat-veil')) {
        try { map.addLayer({ id: 'sat-veil', type: 'raster', source: 'esri', paint: { 'raster-opacity': 0.4, 'raster-fade-duration': 0 } }, appBottomLayer()); } catch {}
      }
      // confini: stati (linea bianca piena con bordo scuro) e regioni (tratteggio leggero)
      const vsrc = st.layers.find((l) => l['source-layer'] === 'boundary')?.source || Object.keys(st.sources).find((k) => st.sources[k].type === 'vector');
      if (vsrc && !map.getLayer('sat-border-2')) {
        try {
          map.addLayer({ id: 'sat-border-4', type: 'line', source: vsrc, 'source-layer': 'boundary',
            filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
            paint: { 'line-color': '#ffffff', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 12, 1.4], 'line-dasharray': [3, 2] } }, appBottomLayer());
          map.addLayer({ id: 'sat-border-2c', type: 'line', source: vsrc, 'source-layer': 'boundary',
            filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
            paint: { 'line-color': '#111827', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 2.2, 12, 4.5] } }, appBottomLayer());
          map.addLayer({ id: 'sat-border-2', type: 'line', source: vsrc, 'source-layer': 'boundary',
            filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
            paint: { 'line-color': '#ffffff', 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 12, 2.2] } }, appBottomLayer());
        } catch {}
      }
      // solo nomi di città/località, vie e acque, in bianco con alone scuro
      const KEEP = new Set(['place', 'transportation_name', 'water_name']);
      for (const l of st.layers) {
        if (l.type !== 'symbol' || !KEEP.has(l['source-layer']) || map.getLayer(l.id)) continue;
        // cartelli stradali (es. SS258): testo scuro sul loro scudo bianco, come sulla mappa stradale
        if (/shield/.test(l.id) || l.layout?.['icon-image'] && l['source-layer'] === 'transportation_name') {
          try { map.addLayer(l, appBottomLayer()); } catch {}
          continue;
        }
        const lay = { ...l, paint: { ...(l.paint || {}),
          'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.6, 'text-halo-blur': 0.4 } };
        try { map.addLayer(lay, appBottomLayer()); } catch {}   // sotto i livelli dell'app
      }
      placeRoutes();   // percorsi sotto ai nomi appena aggiunti
    } catch (e) { console.warn('etichette satellite non disponibili', e); }
  }

  // ---------------------------------------------------------------- icone disegnate su canvas
  const DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  MC.DPR = DPR;
  MC.fontOk = 0;
  document.fonts?.load('600 11px "IBM Plex Sans"').then(() => { MC.fontOk = 1; redrawAll(); }).catch(() => {});
  function canvas(w, hh) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * DPR); c.height = Math.ceil(hh * DPR);
    const ctx = c.getContext('2d');
    ctx.scale(DPR, DPR);
    return [c, ctx];
  }
  MC.canvas = canvas;
  // freccia di direzione (punta in su; la mappa la ruota con icon-rotate)
  function drawArrow(color) {
    const [c, ctx] = canvas(16, 11);
    ctx.beginPath(); ctx.moveTo(8, 0.9); ctx.lineTo(14.6, 10); ctx.lineTo(1.4, 10); ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 1.4; ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round'; ctx.stroke();
    return c;
  }
  // etichette: scure con bordo chiaro su mappa scura e satellite, chiare e discrete su mappa chiara
  const labelsDark = () => MC.basemap === 'satellite' || MC.mapDark;
  MC.labelsDark = labelsDark;
  const LBL = {
    d: { bg: 'rgba(30,41,59,0.82)', line: 'rgba(255,255,255,0.28)', text: '#ffffff', line2: '#6ee7b7', sub: '#cbd5e1' },
    l: { bg: 'rgba(255,255,255,0.8)', line: 'rgba(15,23,42,0.14)', text: '#111827', line2: '#047857', sub: '#475569' },
  };
  // simbolo "naviga" (rombo con la freccia di svolta), su 24x24: usato nelle etichette e dall'app
  const NAV_ICON_D = 'M21.7 11.3l-9-9a1 1 0 0 0-1.4 0l-9 9a1 1 0 0 0 0 1.4l9 9a1 1 0 0 0 1.4 0l9-9a1 1 0 0 0 0-1.4zM14 14.5V12h-4v3H8v-4a1 1 0 0 1 1-1h5V7.5l3.5 3.5z';
  MC.NAV_ICON_D = NAV_ICON_D;
  // etichetta col nome (pillola) e, sotto, la velocità. Righe che iniziano con:
  //   \u0001 utente presente (omino verde a sinistra)  \u0002 destinazione di una navigazione (freccia)
  //   \u0003 io (omino blu)                            \u0004 utente offline (omino grigio)
  function drawLabel(text, sub, theme = 'd') {
    const T = LBL[theme] || LBL.d;
    const font = '600 11px "IBM Plex Sans", system-ui, sans-serif';
    const font2 = '500 10px "IBM Plex Mono", ui-monospace, monospace';
    const lines = String(text).split('\n');   // più righe ("\n"): es. veicolo e, sotto, i colleghi a bordo
    const [, m] = canvas(1, 1);
    const isU = (l) => l.startsWith('\u0001') || l.startsWith('\u0003') || l.startsWith('\u0004'), isN = (l) => l.startsWith('\u0002'), txt = (l) => (isU(l) || isN(l) ? l.slice(1) : l);
    const lw = (l, i) => { m.font = i ? '500 11px "IBM Plex Sans", system-ui, sans-serif' : font; return m.measureText(txt(l)).width + (isU(l) || isN(l) ? 15 : 0); };
    let tw = Math.max(...lines.map(lw));
    if (sub) { m.font = font2; tw = Math.max(tw, m.measureText(sub).width); }
    const w = Math.ceil(tw / 2) * 2 + 12, hh = 18 + (lines.length - 1) * 13 + (sub ? 12 : 0);
    const [c, ctx] = canvas(w, hh);
    ctx.fillStyle = T.bg;
    ctx.beginPath(); ctx.roundRect(0.5, 0.5, w - 1, hh - 1, 4); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = T.line; ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    lines.forEach((l, i) => {
      const y = 9.5 + i * 13;
      ctx.font = i ? '500 11px "IBM Plex Sans", system-ui, sans-serif' : font;
      if (isU(l)) {
        const t = txt(l), tw2 = ctx.measureText(t).width, x0 = w / 2 - (tw2 + 15) / 2;
        ctx.beginPath(); ctx.arc(x0 + 5.5, y, 5.5, 0, 2 * Math.PI); ctx.fillStyle = l.startsWith('\u0003') ? '#2563eb' : l.startsWith('\u0004') ? '#8b929d' : '#059669'; ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x0 + 5.5, y - 1.6, 1.7, 0, 2 * Math.PI); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x0 + 2.6, y + 3.3); ctx.quadraticCurveTo(x0 + 2.8, y + 0.4, x0 + 5.5, y + 0.4); ctx.quadraticCurveTo(x0 + 8.2, y + 0.4, x0 + 8.4, y + 3.3); ctx.closePath(); ctx.fill();
        ctx.textAlign = 'left'; ctx.fillStyle = T.text; ctx.fillText(t, x0 + 15, y); ctx.textAlign = 'center';
        return;
      }
      if (isN(l)) {
        const t = txt(l), tw2 = ctx.measureText(t).width, x0 = w / 2 - (tw2 + 15) / 2;
        const k = 11 / 24;
        ctx.save(); ctx.translate(x0, y - 5.5); ctx.scale(k, k);
        ctx.fillStyle = T.line2; ctx.fill(new Path2D(NAV_ICON_D), 'evenodd');
        ctx.restore();
        ctx.textAlign = 'left'; ctx.fillStyle = T.line2; ctx.fillText(t, x0 + 15, y); ctx.textAlign = 'center';
        return;
      }
      ctx.fillStyle = i ? T.line2 : T.text; ctx.fillText(l, w / 2, y);
    });
    if (sub) { ctx.font = font2; ctx.fillStyle = T.sub; ctx.fillText(sub, w / 2, hh - 8.5); }
    return c;
  }
  // punto di interesse: segnaposto (goccia) del colore scelto, bordo bianco e foro bianco
  function drawPin(color) {
    const [c, ctx] = canvas(24, 32);
    ctx.beginPath();
    ctx.moveTo(12, 30.5);
    ctx.bezierCurveTo(12, 30.5, 2, 20, 2, 12);
    ctx.arc(12, 12, 10, Math.PI, 0);
    ctx.bezierCurveTo(22, 20, 12, 30.5, 12, 30.5);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.beginPath(); ctx.arc(12, 12, 3.8, 0, 2 * Math.PI); ctx.fillStyle = '#fff'; ctx.fill();
    return c;
  }
  // collega: cerchio verde con omino bianco (diverso dal mio cursore blu e dai target)
  function drawPeerIcon(fill = '#059669') {
    const [c, ctx] = canvas(26, 26);
    ctx.beginPath(); ctx.arc(13, 13, 11, 0, 2 * Math.PI);
    ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(13, 9.3, 3.1, 0, 2 * Math.PI); ctx.fill();
    ctx.beginPath(); ctx.moveTo(7.3, 19.2); ctx.quadraticCurveTo(7.6, 13.3, 13, 13.3); ctx.quadraticCurveTo(18.4, 13.3, 18.7, 19.2); ctx.closePath(); ctx.fill();
    return c;
  }
  // cartello di stop: target fermo
  function drawStop() {
    const [c, ctx] = canvas(26, 26);
    const r = 12, cx = 13, cy = 13;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i * Math.PI) / 4;
      ctx[i ? 'lineTo' : 'moveTo'](cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    ctx.closePath();
    ctx.fillStyle = '#dc2626'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.font = '700 7px "IBM Plex Sans", system-ui, sans-serif';
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('STOP', cx, cy + 0.5);
    return c;
  }
  // pallino del gruppo: cerchio con il numero e un bordo che ricorda cosa contiene
  function drawCluster(id) {
    const [, nStr, kinds, color, theme] = id.split('|');
    const dark = theme === 'dark';
    const n = +nStr, r = n < 10 ? 15 : 18, size = (r + 4) * 2;
    const [c, ctx] = canvas(size, size);
    const cx = size / 2;
    ctx.beginPath(); ctx.arc(cx, cx, r + 2, 0, 2 * Math.PI);
    ctx.fillStyle = kinds.includes('veh') ? color : kinds.includes('me') ? '#1d4ed8' : kinds.includes('peer') ? '#059669' : '#7c3aed'; ctx.fill();
    // interno semitrasparente (si intravede la mappa): il colore dell'anello resta pieno
    ctx.save(); ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath(); ctx.arc(cx, cx, r - 1.5, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
    ctx.beginPath(); ctx.arc(cx, cx, r - 1.5, 0, 2 * Math.PI); ctx.fillStyle = dark ? `rgba(17,24,39,${BUBBLE_A})` : `rgba(255,255,255,${BUBBLE_A})`; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cx, r + 2.5, 0, 2 * Math.PI); ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `700 ${n < 10 ? 13 : 12}px "IBM Plex Sans", system-ui, sans-serif`;
    ctx.lineWidth = 3; ctx.strokeStyle = dark ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)'; ctx.strokeText(String(n), cx, cx + 0.5);
    ctx.fillStyle = dark ? '#fff' : '#111827'; ctx.fillText(String(n), cx, cx + 0.5);
    return c;
  }
  // io: freccia di navigazione blu, omino blu, cono della direzione (bussola del telefono)
  function addMeImages() {
    const R = 2, SZ = 26 * R;
    const mk = (draw) => {
      const c = document.createElement('canvas'); c.width = c.height = SZ;
      const g = c.getContext('2d'); g.scale(R, R); draw(g);
      return g.getImageData(0, 0, SZ, SZ);
    };
    const shadow = (g) => { g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 3; g.shadowOffsetY = 1; };
    if (!map.hasImage('me-arrow')) map.addImage('me-arrow', mk((g) => {
      shadow(g);
      g.beginPath(); g.moveTo(13, 2); g.lineTo(23, 23); g.lineTo(13, 18); g.lineTo(3, 23); g.closePath();
      g.fillStyle = '#1d4ed8'; g.fill();
      g.shadowColor = 'transparent'; g.lineJoin = 'round'; g.lineWidth = 2.2; g.strokeStyle = '#fff'; g.stroke();
    }), { pixelRatio: R });
    if (!map.hasImage('me-person')) map.addImage('me-person', mk((g) => {
      shadow(g);
      g.beginPath(); g.arc(13, 13, 11, 0, Math.PI * 2); g.fillStyle = '#1d4ed8'; g.fill();
      g.shadowColor = 'transparent'; g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(13, 8.6, 2.9, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.moveTo(7.6, 19.5); g.quadraticCurveTo(7.8, 12.6, 13, 12.6);
      g.quadraticCurveTo(18.2, 12.6, 18.4, 19.5); g.closePath(); g.fill();
    }), { pixelRatio: R });
    if (!map.hasImage('me-beam')) {
      const S2 = 96 * R, c = document.createElement('canvas'); c.width = c.height = S2;
      const g = c.getContext('2d'); g.scale(R, R);
      const grd = g.createRadialGradient(48, 48, 6, 48, 48, 46);
      grd.addColorStop(0, 'rgba(37,99,235,0.55)'); grd.addColorStop(1, 'rgba(37,99,235,0)');
      g.fillStyle = grd; g.beginPath(); g.moveTo(48, 48);
      g.arc(48, 48, 46, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); g.closePath(); g.fill();
      map.addImage('me-beam', g.getImageData(0, 0, S2, S2), { pixelRatio: R });
    }
  }
  MC.addMeImages = addMeImages;
  // le immagini vengono create quando la mappa le chiede (anche dopo un cambio stile)
  map.on('styleimagemissing', (e) => {
    const id = e.id;
    let c = null;
    if (id.startsWith('arr|')) c = drawArrow(id.slice(4));
    else if (id.startsWith('lbl|')) {
      // lbl|font+tema|sotto|nome  (il nome può contenere "|", quindi sta in fondo)
      const p = id.split('|');
      c = drawLabel(p.slice(3).join('|'), p[2], p[1].slice(-1));
    } else if (id === 'stop-sign') c = drawStop();
    else if (id === 'peer-ic') c = drawPeerIcon();
    else if (id === 'peer-ic-off') c = drawPeerIcon('#8b929d');   // utente offline: grigio
    else if (id.startsWith('cl|')) c = drawCluster(id);
    else if (id.startsWith('pin|')) c = drawPin(id.slice(4));
    else c = h('onImage', id) || null;
    if (!c || map.hasImage(id)) return;
    map.addImage(id, c.getContext('2d').getImageData(0, 0, c.width, c.height), { pixelRatio: DPR });
  });
  MC.arrowImg = (color) => `arr|${color}`;
  MC.labelImg = (name, sub = '') => `lbl|${MC.fontOk}${labelsDark() ? 'd' : 'l'}|${sub}|${name}`;
  MC.pinImg = (color) => `pin|${color}`;

  // ---------------------------------------------------------------- sorgenti e livelli dell'app
  function addVehicleLayers() {
    // icon-size ≠ 1: MapLibre disegna le icone con filtro lineare (scorrono fluide, non saltano di un pixel)
    const nonOverlap = { 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': SMOOTH };
    // storico: partenza/arrivo e mezzo in riproduzione
    map.addLayer({ id: 'hist-pins', type: 'circle', source: 'hist-pins',
      paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'play-stop', type: 'symbol', source: 'play', filter: ['!', ['get', 'moving']],
      layout: { 'icon-image': 'stop-sign', ...nonOverlap } });
    map.addLayer({ id: 'play-dot', type: 'circle', source: 'play', filter: ['get', 'moving'],
      paint: { 'circle-radius': 10, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: 'play-arrow', type: 'symbol', source: 'play', filter: ['get', 'moving'],
      layout: { 'icon-image': ['get', 'arrow'], 'icon-rotate': ['get', 'course'], 'icon-rotation-alignment': 'map', 'icon-offset': [0, -15], ...nonOverlap } });
    map.addLayer({ id: 'play-label', type: 'symbol', source: 'play',
      layout: { 'icon-image': ['get', 'label'], 'icon-anchor': 'top', 'icon-offset': [0, 13], ...nonOverlap } });
    // live: ultimo tratto della scia (dal punto da cui il veicolo è ripartito fino a dove è
    // disegnato), nella stessa sorgente del segnalino così la scia non lo precede mai
    map.addLayer({ id: 'veh-tail', type: 'line', source: 'veh', filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': 0.75 } });
    map.addLayer({ id: 'veh-halo', type: 'circle', source: 'veh', filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'st'], 'alarm']],
      paint: { 'circle-radius': 18, 'circle-color': '#dc2626', 'circle-opacity': 0.3 } });
    // target GPS: pallino nel suo colore (grigio se offline, bordo più spesso se selezionato);
    // telecamere e simili: la loro icona ("cam")
    map.addLayer({ id: 'veh-dot', type: 'circle', source: 'veh', filter: ['all', ['==', ['geometry-type'], 'Point'], ['!', ['get', 'sosta']], ['!', ['get', 'cam']]],
      layout: { 'circle-sort-key': ['get', 'z'] },
      paint: { 'circle-radius': 10,
        'circle-color': ['case', ['==', ['get', 'st'], 'offline'], '#9ca3af', ['get', 'color']],
        'circle-stroke-color': '#fff',
        'circle-stroke-width': ['case', ['get', 'sel'], 3.5, 2.5] } });
    map.addLayer({ id: 'veh-cam', type: 'symbol', source: 'veh', filter: ['all', ['==', ['geometry-type'], 'Point'], ['get', 'cam']],
      layout: { 'icon-image': ['get', 'icon'], 'symbol-sort-key': ['get', 'z'], ...nonOverlap, 'icon-size': ['case', ['get', 'sel'], 1.18, SMOOTH] } });
    // freccia di direzione: solo in movimento e solo se il GPS fornisce la direzione
    map.addLayer({ id: 'veh-arrow', type: 'symbol', source: 'veh', filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'st'], 'moving'], ['get', 'hasCourse']],
      layout: { 'icon-image': ['get', 'arrow'], 'icon-rotate': ['get', 'course'], 'icon-rotation-alignment': 'map',
        'icon-offset': [0, -15], 'symbol-sort-key': ['get', 'z'], ...nonOverlap } });
    // in sosta: cartello di stop al posto del pallino
    map.addLayer({ id: 'veh-stop', type: 'symbol', source: 'veh', filter: ['all', ['==', ['geometry-type'], 'Point'], ['get', 'sosta']],
      layout: { 'icon-image': 'stop-sign', 'symbol-sort-key': ['get', 'z'], ...nonOverlap } });
    // collega a bordo: omino accanto all'icona del target
    map.addLayer({ id: 'veh-crew', type: 'symbol', source: 'veh', filter: ['all', ['==', ['geometry-type'], 'Point'], ['get', 'crew']],
      layout: { 'icon-image': 'peer-ic', ...nonOverlap, 'icon-size': 0.55, 'icon-offset': ['case', ['get', 'sosta'], ['literal', [17.5, -17.5]], ['literal', [16.5, -16.5]]], 'symbol-sort-key': ['get', 'z'] } });
    map.addLayer({ id: 'veh-label', type: 'symbol', source: 'veh', filter: ['==', ['geometry-type'], 'Point'],
      layout: { 'icon-image': ['get', 'label'], 'icon-anchor': 'top', 'icon-offset': labelOffset(14), 'icon-padding': 1, 'symbol-sort-key': ['get', 'z'], ...nonOverlap, 'icon-allow-overlap': false, 'icon-ignore-placement': false } });
  }
  // tracciato storico: fermo = rosso, in movimento = blu
  const MOVE_COLORS = ['case', ['==', ['get', 'moving'], 1], '#2563eb', '#dc2626'];
  map.on('style.load', () => {
    flattenBuildings();
    applyMapDark();   // dopo l'appiattimento: anche gli edifici 2D prendono i colori notte
    addSatLabels();
    addRegionBorders();
    // tolerance bassa: la linea resta fedele anche a zoom ridotto (default 0.375)
    const add = (id, data = empty()) => map.addSource(id, { type: 'geojson', data, tolerance: 0.15 });
    add('trails'); add('hist'); add('hist-gaps'); add('hist-stops'); add('hist-alarms'); add('hist-hover');
    add('pts-sel');
    add('pois'); add('poi-draw'); add('peers'); add('peers-off'); add('nav-dest'); add('clusters');

    // punti di interesse e aree: sotto scie e target
    map.addLayer({ id: 'poi-fill', type: 'fill', source: 'pois', filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.14 } });
    map.addLayer({ id: 'poi-line', type: 'line', source: 'pois', filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [3, 1.5] } });
    // punto di interesse: segnaposto nel colore scelto (diverso dal pallino dei veicoli)
    map.addLayer({ id: 'poi-pt', type: 'symbol', source: 'pois', filter: ['all', ['==', ['geometry-type'], 'Point'], ['!', ['has', 'area']]],
      layout: { 'icon-image': ['get', 'pin'], 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
    // etichette dei punti sempre visibili (anche sopra i nomi delle città)
    map.addLayer({ id: 'poi-label', type: 'symbol', source: 'pois', filter: ['==', ['geometry-type'], 'Point'],
      layout: { 'icon-image': ['get', 'label'], 'icon-anchor': 'top', 'icon-offset': ['case', ['has', 'area'], ['literal', [0, -9]], labelOffset(3)], 'icon-padding': 1, 'icon-allow-overlap': false, 'icon-ignore-placement': false } });
    map.addLayer({ id: 'poi-draw-fill', type: 'fill', source: 'poi-draw', filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#e11d48', 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'poi-draw-line', type: 'line', source: 'poi-draw',
      paint: { 'line-color': '#e11d48', 'line-width': 2.5 } });
    map.addLayer({ id: 'poi-draw-pt', type: 'circle', source: 'poi-draw', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#e11d48', 'circle-stroke-width': 2.5 } });

    // destinazione ricevuta (navigazione verso un punto)
    map.addLayer({ id: 'nav-dest-pt', type: 'circle', source: 'nav-dest',
      paint: { 'circle-radius': 9, 'circle-color': '#e11d48', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'nav-dest-label', type: 'symbol', source: 'nav-dest',
      layout: { 'icon-image': ['get', 'label'], 'icon-anchor': 'top', 'icon-offset': [0, 11] } });

    map.addLayer({ id: 'trails', type: 'line', source: 'trails',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': 0.75 } });

    map.addLayer({ id: 'hist-casing', type: 'line', source: 'hist',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0b0d12', 'line-width': 7, 'line-opacity': 0.35 } });
    map.addLayer({ id: 'hist-line', type: 'line', source: 'hist',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': MOVE_COLORS, 'line-width': 4.5 } });
    map.addLayer({ id: 'hist-gaps', type: 'line', source: 'hist-gaps',
      paint: { 'line-color': '#9ca3af', 'line-width': 2, 'line-dasharray': [2, 2] } });
    map.addLayer({ id: 'hist-stops', type: 'circle', source: 'hist-stops',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'minutes'], 3, 6, 120, 12],
        'circle-color': '#2563eb', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-opacity': 0.9 } });
    map.addLayer({ id: 'hist-alarms', type: 'circle', source: 'hist-alarms',
      paint: { 'circle-radius': 7, 'circle-color': '#dc2626', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'hist-hover', type: 'circle', source: 'hist-hover',
      paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': '#111', 'circle-stroke-width': 2 } });
    // punto selezionato dall'elenco "Punti"
    map.addLayer({ id: 'pts-sel', type: 'circle', source: 'pts-sel',
      paint: { 'circle-radius': 8, 'circle-color': '#f59e0b', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });

    // navigatore: percorso stradale da me al target
    add('route');
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', filter: ['!=', ['get', 'conn'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0b3a8c', 'line-width': 10, 'line-opacity': 0.55 } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['!=', ['get', 'straight'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#3b82f6', 'line-width': 6 } });
    // ripiego se il routing non risponde: linea d'aria tratteggiata
    map.addLayer({ id: 'route-straight', type: 'line', source: 'route', filter: ['all', ['==', ['get', 'straight'], true], ['!=', ['get', 'conn'], true]],
      paint: { 'line-color': '#3b82f6', 'line-width': 4, 'line-dasharray': [2, 2] } });
    // da me alla strada (o dalla strada al punto d'arrivo) quando sono lontani: puntini
    map.addLayer({ id: 'route-conn', type: 'line', source: 'route', filter: ['==', ['get', 'conn'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#3b82f6', 'line-width': 5, 'line-dasharray': [0.1, 2] } });

    add('hist-pins'); add('veh'); add('play');
    addVehicleLayers();

    add('me');
    // colleghi che stanno navigando: linea tratteggiata dal collega alla sua destinazione
    add('peer-nav');
    map.addLayer({ id: 'peer-nav-casing', type: 'line', source: 'peer-nav', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.75 } });
    map.addLayer({ id: 'peer-nav-line', type: 'line', source: 'peer-nav', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#10b981', 'line-width': 4, 'line-dasharray': [1.4, 1.4] } });
    map.addLayer({ id: 'peer-nav-end', type: 'circle', source: 'peer-nav', filter: ['==', ['get', 'end'], true],
      paint: { 'circle-radius': 5, 'circle-color': '#059669', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    // utenti offline: omino grigio all'ultima posizione nota
    map.addLayer({ id: 'peer-off-dot', type: 'symbol', source: 'peers-off',
      layout: { 'icon-image': 'peer-ic-off', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': 0.9 } });
    map.addLayer({ id: 'peer-off-label', type: 'symbol', source: 'peers-off',
      layout: { 'icon-image': ['get', 'label'], 'icon-anchor': 'top', 'icon-offset': labelOffset(13), 'icon-padding': 1, 'icon-allow-overlap': false, 'icon-ignore-placement': false },
      paint: { 'icon-opacity': 0.85 } });
    // colleghi con posizione attiva: cerchio verde con omino + nome
    map.addLayer({ id: 'peer-acc', type: 'circle', source: 'peers',
      paint: { 'circle-color': '#059669', 'circle-opacity': 0.08, 'circle-stroke-color': '#059669', 'circle-stroke-opacity': 0.25, 'circle-stroke-width': 1,
        'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, ['/', ['get', 'acc'], 152], 20, ['/', ['get', 'acc'], 0.149]] } });
    map.addLayer({ id: 'peer-dot', type: 'symbol', source: 'peers',
      layout: { 'icon-image': 'peer-ic', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': SMOOTH } });
    map.addLayer({ id: 'peer-label', type: 'symbol', source: 'peers',
      layout: { 'icon-image': ['get', 'label'], 'icon-anchor': 'top', 'icon-offset': labelOffset(14), 'icon-padding': 1, 'icon-size': SMOOTH, 'icon-allow-overlap': false, 'icon-ignore-placement': false } });

    // io: alone + cono della direzione + freccia (mentre seguo) o omino (sempre dritto)
    map.addLayer({ id: 'me-halo', type: 'circle', source: 'me',
      paint: { 'circle-radius': 23, 'circle-color': '#3b82f6', 'circle-opacity': 0.18 } });
    addMeImages();
    map.addLayer({ id: 'me-beam', type: 'symbol', source: 'me', filter: ['has', 'beam'],
      layout: { 'icon-image': 'me-beam', 'icon-rotate': ['get', 'beam'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true } });
    map.addLayer({ id: 'me-dot', type: 'symbol', source: 'me', filter: ['==', ['get', 'icon'], 'me-arrow'],
      layout: { 'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map',
        'icon-size': 1.35, 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
    map.addLayer({ id: 'me-person', type: 'symbol', source: 'me', filter: ['==', ['get', 'icon'], 'me-person'],
      layout: { 'icon-image': 'me-person', 'icon-rotation-alignment': 'viewport',
        'icon-allow-overlap': true, 'icon-ignore-placement': true } });

    h('onStyleLoad');   // l'app rimette i suoi dati nelle sorgenti

    // gruppi sopra a tutto
    map.addLayer({ id: 'cl-dot', type: 'symbol', source: 'clusters',
      layout: { 'icon-image': ['get', 'img'], 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
    CL.sig = ''; scheduleClusters();
    placeRoutes();
    h('onStyleReady');   // tutto al suo posto (es. l'app porta il proprio segnalino sopra a tutto)
  });
  // in navigazione il mio segnalino sta sopra a tutti gli altri (target, punti, bolle)
  MC.bringMeToTop = () => { for (const id of ['me-halo', 'me-beam', 'me-dot', 'me-person']) if (map.getLayer(id)) { try { map.moveLayer(id); } catch {} } };
  // mostra/nasconde un livello
  MC.vis = (id, on) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };
  // dati in una sorgente (se c'è)
  MC.setData = (id, data) => { const s = map.getSource(id); if (s) s.setData(data || empty()); };

  // gesti dell'utente: l'app decide cosa fare (smettere di seguire, mettere in pausa il navigatore)
  const userGesture = (e) => e.originalEvent != null;
  MC.userGesture = userGesture;
  map.on('dragstart', (e) => { if (userGesture(e)) h('onUserDrag'); });
  for (const ev of ['zoomstart', 'rotatestart', 'pitchstart']) map.on(ev, (e) => { if (userGesture(e)) h('onUserZoom'); });

  // ---------------------------------------------------------------- scorrimento morbido dei target
  // posizione mostrata di ogni target (con scorrimento tra un fix e il successivo)
  const anim = new Map(); // id -> { pos, from, to, t0, dur, pending, speed, course, courseTo, reachedTs, toTs }
  MC.anim = anim;
  MC.posOf = (id) => anim.get(id)?.pos || null;
  let renderRq = 0;
  const scheduleRender = () => { if (!renderRq) renderRq = requestAnimationFrame(() => { renderRq = 0; h('render'); }); };
  MC.scheduleRender = scheduleRender;
  // focus su qualcosa che si muove (mobile): la mappa si orienta nella sua direzione di marcia,
  // con una rotazione morbida (niente scatti a ogni punto)
  const FOLLOW_ROT_KMH = 8;
  MC.FOLLOW_ROT_KMH = FOLLOW_ROT_KMH;
  function followBearing(kmh, c) {
    if (h('autoCam') || !isMobile() || MC.camHold) return;
    if ((kmh || 0) < FOLLOW_ROT_KMH || c == null || isNaN(c)) return;
    const b = map.getBearing(), d = ((c - b + 540) % 360) - 180;
    if (Math.abs(d) < 0.5) return;
    map.setBearing(b + d * 0.08);
  }
  MC.followBearing = followBearing;
  let animRaf = 0;
  // mappa che insegue qualcosa: il centro segue ESATTAMENTE il punto (arrotondare a pixel interi
  // faceva saltare tutta la mappa di un pixel alla volta: sembrava tremare)
  function animStep(now) {
    animRaf = 0;
    let active = false;
    const fid = h('followId');
    for (const [id, a] of anim) {
      if (!a.t0) continue;
      const k = Math.min(1, (now - a.t0) / (a.dur || 1200)), e = a.dur > 1200 ? k : k * (2 - k);
      a.pos = [a.from[0] + (a.to[0] - a.from[0]) * e, a.from[1] + (a.to[1] - a.from[1]) * e];
      if (k >= 1) { a.t0 = 0; a.reachedTs = a.toTs; } else active = true;
      if (fid != null && fid === id && !MC.camHold && !MC.flying) { map.setCenter(a.pos); followBearing(a.speed, a.courseTo); }
      h('onFrame', id, a.pos);
    }
    h('render');
    if (!active) h('onAnimEnd');   // fine dello scorrimento: la scia si chiude sul punto raggiunto
    if (active) animRaf = requestAnimationFrame(animStep);
  }
  // ---- fermo "ancorato": da fermo il GPS manda punti che ballano di qualche metro (e velocità
  // di pochi km/h). Per non far tremare il segnale lo tengo fermo finché il punto non si
  // allontana davvero o la velocità non supera la soglia di ripartenza. Solo visualizzazione.
  const STOP_KMH = 3;           // sotto questa velocità è fermo
  const ANCHOR_LEAVE_M = 60;    // oltre questa distanza dall'ancora considero che si è mosso
  const RESTART_KMH = 6;        // per uscire dallo stato di fermo serve più di questa velocità
  Object.assign(MC, { STOP_KMH, ANCHOR_LEAVE_M, RESTART_KMH });
  const still = new Map();      // id -> { stopped, anchor:[lon,lat], ts, out }
  MC.still = still;
  const toRad = (x) => (x * Math.PI) / 180;
  function distLL(a, b) {
    const R = 6371000, dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
    const hh = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(hh));
  }
  MC.distLL = distLL;
  /** stato di fermo di un target: id e ultimo fix {lon, lat, ts, speed (km/h), valid} */
  function stillState(id, l) {
    const p = [l.lon, l.lat];
    let s = still.get(id);
    // stato iniziale sconosciuto: uso la soglia tollerante (il rumore da fermo arriva a ~5 km/h)
    if (!s) { s = { stopped: l.speed <= RESTART_KMH, anchor: p, ts: l.ts, out: 0 }; still.set(id, s); return s; }
    if (s.ts === l.ts) return s; // stesso punto già valutato
    s.ts = l.ts;
    if (l.valid === false) return s; // senza fix GPS: non cambia lo stato
    if (s.stopped) {
      // un punto isolato che "salta" non basta: serve anche il successivo in movimento
      if (l.speed > RESTART_KMH || distLL(s.anchor, p) > ANCHOR_LEAVE_M) {
        if (++s.out >= 2) { s.stopped = false; s.anchor = p; s.out = 0; }
      } else s.out = 0;
    } else if (l.speed <= STOP_KMH) { s.stopped = true; s.anchor = p; s.out = 0; }
    else s.anchor = p;
    return s;
  }
  MC.stillState = stillState;
  /** nuova posizione di un target: il segnalino scorre fino a lì */
  function upsertMarker(id, l, animate = true) {
    const ss = stillState(id, l);
    const to = ss.stopped ? ss.anchor : [l.lon, l.lat];
    const ts = typeof l.ts === 'number' ? l.ts : Date.parse(l.ts);
    let a = anim.get(id);
    if (a) { a.courseTo = l.course; a.speed = l.speed || 0; }
    if (!a) {
      anim.set(id, { pos: to, from: to, to, t0: 0, speed: l.speed || 0, course: l.course || 0, courseTo: l.course || 0, reachedTs: ts, toTs: ts });
    } else if (MC.interacting) {
      a.pending = to; a.toTs = ts; // durante zoom/trascinamento: applicata a gesto finito
    } else {
      const far = Math.abs(a.pos[0] - to[0]) + Math.abs(a.pos[1] - to[1]) > 0.05;
      if (!animate || far || document.hidden) { a.pos = to; a.to = to; a.t0 = 0; a.reachedTs = a.toTs = ts; }
      else {
        // scorrimento continuo: dura quanto l'intervallo tra due posizioni (1,2–5 s), un po' meno
        // così il segnalino arriva sul punto prima del successivo (passa davvero per ogni punto)
        const now = performance.now();
        a.dur = Math.max(1200, Math.min(5000, a.lastAt ? (now - a.lastAt) * 0.95 : 1200));
        a.lastAt = now;
        a.from = a.pos; a.to = to; a.toTs = ts; a.t0 = now; if (!animRaf) animRaf = requestAnimationFrame(animStep);
      }
    }
    scheduleRender();
  }
  MC.upsertMarker = upsertMarker;
  MC.removeMarker = (id) => { anim.delete(id); still.delete(id); };
  // Durante un gesto dell'utente (rotellina, trascinamento) i target stanno fermi: le nuove
  // posizioni vengono applicate quando il gesto finisce.
  MC.interacting = false;
  MC.userMovedAt = 0;
  function freezeMarkers() {
    MC.interacting = true;
    for (const a of anim.values()) if (a.t0) { a.pending = a.to; a.t0 = 0; }
  }
  function thawMarkers() {
    MC.interacting = false;
    for (const a of anim.values()) if (a.pending) { a.pos = a.pending; a.to = a.pending; a.pending = null; a.reachedTs = a.toTs; }
    h('render');
  }
  map.on('movestart', (e) => { if (userGesture(e)) { freezeMarkers(); MC.userMovedAt = Date.now(); } });
  map.on('zoomstart', (e) => { if (userGesture(e)) { freezeMarkers(); MC.userMovedAt = Date.now(); } });
  map.on('moveend', () => { if (MC.interacting) thawMarkers(); });
  map.on('zoomend', () => { if (MC.interacting) thawMarkers(); });
  // volo verso ciò che ho scelto: finché dura, chi è seguito non ricentra la mappa (lo
  // interromperebbe a metà, e lo zoom cambiava a seconda del momento in cui arrivava un punto)
  MC.flying = false;
  let flyTm = 0;
  MC.flyFocus = (center, opts = {}) => {
    MC.flying = true;
    map.flyTo({ essential: true, center, speed: 1.6, ...opts });
    clearTimeout(flyTm);
    const done = () => { MC.flying = false; clearTimeout(flyTm); };
    map.once('moveend', done);
    flyTm = setTimeout(done, 4000);
  };

  // ---------------------------------------------------------------- scie
  /** scie dei target: series = [{ id, color, from (ms: ignora i punti precedenti), pts: [[lon,lat,ms], …] }].
   *  Spezzate dove due punti distano oltre gapSec o gapM; la scia arriva fin dove è disegnato il
   *  segnalino (mai davanti). */
  MC.drawTrails = (series, { gapSec = 300, gapM = 500 } = {}) => {
    const src = map.getSource?.('trails');
    if (!src) return;
    const features = [];
    for (const s of series) {
      const pts = s.pts, from = s.from || 0;
      let run = [];
      const flush = () => { if (run.length > 1) features.push({ type: 'Feature', properties: { color: s.color }, geometry: { type: 'LineString', coordinates: run.map((p) => [p[0], p[1]]) } }); run = []; };
      const a = anim.get(s.id);
      let src2 = pts;
      if (a?.pos && a.reachedTs != null) {
        src2 = pts.filter((p) => p[2] <= a.reachedTs);
        const t = (src2[src2.length - 1]?.[2] || 0) + 1;
        // fermo: fino al segnalino; in movimento: fino al punto da cui è ripartito (il tratto
        // successivo lo disegna veh-tail insieme al segnalino)
        src2.push(a.t0 && a.from ? [a.from[0], a.from[1], t] : [a.pos[0], a.pos[1], t]);
      }
      for (const p of src2) {
        if (p[2] < from) { flush(); continue; }
        const prev = run[run.length - 1];
        if (prev && ((p[2] - prev[2]) / 1000 > gapSec || distLL(prev, p) > gapM)) flush();
        run.push(p);
      }
      flush();
    }
    src.setData({ type: 'FeatureCollection', features });
  };

  // ---------------------------------------------------------------- tocco sugli elementi
  // Clic sulla mappa: target, colleghi e punti di interesse in un unico punto. Se sotto il
  // dito/mouse ci sono più oggetti vicini, compare un elenco per scegliere.
  const PICK_LAYERS = ['cl-dot', 'veh-dot', 'veh-cam', 'veh-stop', 'veh-arrow', 'veh-crew', 'veh-label', 'peer-dot', 'peer-label', 'peer-off-dot', 'peer-off-label', 'poi-pt', 'poi-label', 'poi-fill'];
  let lpTimer = 0, lpFired = false, lpStart = null;
  const cancelLP = () => { clearTimeout(lpTimer); lpTimer = 0; };
  map.on('click', (e) => {
    if (e.defaultPrevented || h('pickBlocked')) return;
    if (lpFired) { lpFired = false; e.preventDefault(); return; } // il clic che chiude una pressione lunga
    // bolla di un gruppo aperta (raggiera o elenco): un tocco altrove la chiude e basta
    if (bubbleOpen()) {
      // tocco su un'altra bolla: chiudo la prima e apro questa; altrove: chiudo e basta
      const onCl = map.getLayer('cl-dot') && map.queryRenderedFeatures([[e.point.x - 14, e.point.y - 14], [e.point.x + 14, e.point.y + 14]], { layers: ['cl-dot'] })[0];
      const same = onCl && CL.groups.get(onCl.properties.k)?.map((it) => it.key).sort().join(',') === openClusterKey;
      closeSpider(); closePickSheet(); closePickPops();
      if (!onCl || same) { openClusterKey = null; e.preventDefault(); return; }
      openClusterKey = null;
    }
    const r = isMobile() ? 14 : 8;
    const layers = PICK_LAYERS.filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
    const feats = map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers });
    const items = [], seen = new Set();
    const clf = feats.find((f) => f.layer.id === 'cl-dot');
    if (clf) { e.preventDefault(); openCluster(clf.properties.k, e.lngLat); return; }
    for (const f of feats) {
      const L = f.layer.id, pr = f.properties;
      const it = L.startsWith('veh-') ? { kind: 'veh', id: pr.id }
        : L.startsWith('peer-') ? { kind: 'peer', id: pr.u }
        : { kind: 'poi', id: pr.id, area: L === 'poi-fill' };
      const k = `${it.kind}:${it.id}`;
      if (seen.has(k)) continue;
      seen.add(k); items.push(it);
    }
    // un'area fa da sfondo: conta solo se non c'è nient'altro sotto il clic
    const pts = items.filter((i) => !i.area);
    const list = (pts.length ? pts : items).filter((i) => h('describe', i));
    if (!list.length) return;
    e.preventDefault();
    h('onPickStart');   // su mobile la scheda non deve finire sotto il pannello
    if (list.length === 1) openPick(list[0], e.lngLat);
    else showPicker(list, e.lngLat);
  });
  // zoom: dall'elenco di un gruppo porto la mappa sull'elemento scelto, abbastanza vicino da separarlo
  function openPick(i, lngLat, zoom = false) {
    const pos = i.kind === 'veh' ? anim.get(i.id)?.pos || h('describe', i)?.pos : h('describe', i)?.pos;
    h('onPick', i, lngLat);
    if (zoom && pos) {
      const z = Math.min(19, Math.max(map.getZoom() + 2.5, 17));
      setTimeout(() => map.easeTo({ center: pos, zoom: z, duration: 700 }));
    }
  }
  MC.openPick = openPick;
  // mobile: elenco in basso (scorrevole), chiuso da Indietro o trascinando la mappa
  let pickSheet = null;
  function closePickSheet() { if (pickSheet) { pickSheet.remove(); pickSheet = null; } }
  MC.closePickSheet = closePickSheet;
  function showPicker(list, lngLat) {
    h('closeMenus');
    const rows = list.map((i, n) => {
      const l = h('describe', i);
      return `<button type="button" class="pk-row" data-n="${n}">${l.sw || ''}<span class="pk-t"><b>${esc(l.name)}</b><span class="muted">${l.type || ''}</span></span></button>`;
    }).join('');
    if (isMobile()) {
      closePickSheet();
      const el = pickSheet = document.createElement('div');
      el.className = 'pick-sheet';
      el.innerHTML = `<div class="pk-h"><b>${list.length} elementi qui</b><button type="button" class="pk-x" aria-label="Chiudi">✕</button></div><div class="pk-list">${rows}</div>`;
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('.pk-x')) return closePickSheet();
        const b = ev.target.closest('[data-n]'); if (!b) return;
        closePickSheet(); openPick(list[+b.dataset.n], lngLat, true);
      });
      map.getContainer().appendChild(el);
      return;
    }
    const html = `<div class="pop pick-pop"><div class="muted pk-h">${list.length} elementi qui</div>${rows}</div>`;
    const pop = new maplibregl.Popup({ offset: 6, maxWidth: '260px' }).setLngLat(lngLat).setHTML(html).addTo(map);
    pop.getElement().addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-n]'); if (!b) return;
      pop.remove(); openPick(list[+b.dataset.n], lngLat, true);
    });
  }
  MC.showPicker = showPicker;
  // pressione lunga (mobile) su un target
  for (const id of ['veh-dot', 'veh-cam', 'veh-stop', 'veh-label']) {
    map.on('touchstart', id, (e) => {
      if (e.points?.length > 1) return;
      const devId = e.features[0].properties.id;
      lpFired = false; cancelLP(); lpStart = e.point;
      lpTimer = setTimeout(() => {
        if (h('autoCam')) return;   // in navigazione la pressione lunga non apre menu
        lpFired = true;
        navigator.vibrate?.(30);
        h('onLongPress', { kind: 'veh', id: devId }, lpStart);
      }, 600);
    });
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
  for (const ev of ['touchend', 'touchcancel', 'dragstart', 'zoomstart']) map.on(ev, cancelLP);
  // il dito trema sempre un po': annullo solo se si sposta davvero
  map.on('touchmove', (e) => { if (lpTimer && lpStart && Math.hypot(e.point.x - lpStart.x, e.point.y - lpStart.y) > 12) cancelLP(); });
  // riquadri aperti: chiusi da zoom/rotazione (quelli con campi di testo restano)
  function closeAllPops() { for (const p of [...OPEN_POPS]) if (!p.getElement()?.querySelector('input, textarea, select')) p.remove(); }
  MC.closeAllPops = closeAllPops;
  for (const ev of ['zoomstart', 'rotatestart']) map.on(ev, (e) => { if (e.originalEvent) { closeAllPops(); openClusterKey = null; } });

  // ---------------------------------------------------------------- raggruppamento
  // Elementi troppo vicini sullo schermo diventano un solo pallino con il numero (niente etichette
  // sovrapposte). L'app dice cosa può raggrupparsi (clusterItems); il selezionato resta a sé.
  const CL = { ids: new Set(), groups: new Map(), sig: '', tm: 0 };
  MC.CL = CL;
  const CL_RADIUS = 34; // px
  function computeClusters() {
    const src = map.getSource('clusters'); if (!src) return;
    // solo ciò che è sullo schermo (più un margine): il pallino resta sempre in vista
    const W = map.getContainer().clientWidth, Hh = map.getContainer().clientHeight;
    const items = (h('clusterItems') || []).map((it) => ({ ...it, px: map.project(it.pos) }))
      .filter((it) => it.px.x > -40 && it.px.y > -40 && it.px.x < W + 40 && it.px.y < Hh + 40);
    const used = new Set(), groups = [];
    // i target fanno da "centro" per primi, poi colleghi e punti
    const ord = { veh: 0, me: 1, peer: 2, poi: 3 };
    const order = [...items].sort((a, b) => (ord[a.kind] ?? 9) - (ord[b.kind] ?? 9));
    for (const a of order) {
      if (used.has(a.key)) continue;
      const g = order.filter((b) => !used.has(b.key) && Math.hypot(a.px.x - b.px.x, a.px.y - b.px.y) <= CL_RADIUS);
      if (g.length < 2) continue;
      for (const b of g) used.add(b.key);
      groups.push(g);
    }
    const sig = groups.map((g) => g.map((x) => x.key).sort().join(',')).sort().join('|');
    CL.groups = new Map();
    const feats = groups.map((g, i) => {
      const k = `g${i}`;
      CL.groups.set(k, g);
      const x = g.reduce((s, it) => s + it.px.x, 0) / g.length, y = g.reduce((s, it) => s + it.px.y, 0) / g.length;
      const ll = map.unproject([x, y]);
      const kinds = [...new Set(g.map((it) => it.kind))].sort().join('');
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [ll.lng, ll.lat] },
        properties: { k, img: `cl|${g.length}|${kinds}|${g.find((it) => it.kind === 'veh')?.color || g[0].color}|${clTheme()}` } };
    });
    src.setData({ type: 'FeatureCollection', features: feats });
    const sigT = sig + clTheme();
    if (sigT !== CL.sig) {
      CL.sig = sigT;
      CL.ids = used;
      h('redraw');
    }
  }
  MC.computeClusters = computeClusters;
  const clTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  new MutationObserver(() => computeClusters()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  function scheduleClusters() { if (!CL.tm) CL.tm = setTimeout(() => { CL.tm = 0; computeClusters(); }, 120); }
  MC.scheduleClusters = scheduleClusters;
  map.on('move', scheduleClusters);
  map.on('moveend', () => { CL.tm && clearTimeout(CL.tm); CL.tm = 0; computeClusters(); });
  setInterval(computeClusters, 1500); // nuovi punti, target in movimento, colleghi
  // tocco sul gruppo: elenco di cosa contiene, per vederlo o sceglierne uno (niente zoom)
  let openClusterKey = null;
  function openCluster(k, lngLat) {
    const g = CL.groups.get(k); if (!g) return;
    // ritocco la stessa bolla già aperta: la chiudo
    const sig = g.map((it) => it.key).sort().join(',');
    if (openClusterKey === sig && (spider || OPEN_POPS.size || pickSheet)) { closeSpider(); closeAllPops(); closePickSheet(); openClusterKey = null; return; }
    closeSpider(); closeAllPops();
    openClusterKey = sig;
    h('onPickStart');
    const items = g.map((it) => ({ kind: it.kind, id: it.id })).filter((i) => h('describe', i));
    // fino a 6 elementi: aperti a raggiera attorno a un centro chiaro; oltre: elenco
    const at = g.length ? map.unproject(g.reduce((s, it) => [s[0] + it.px.x / g.length, s[1] + it.px.y / g.length], [0, 0])) : lngLat;
    if (items.length <= 6) openSpider(items, at); else showPicker(items, lngLat);
  }
  // ---- raggiera: gli elementi di un gruppo disposti in cerchio, collegati al centro
  let spider = null;
  function closeSpider() { if (spider) { spider.remove(); spider = null; } }
  MC.closeSpider = closeSpider;
  const isPickPop = (p) => !!p.getElement()?.querySelector('.pick-pop');
  function closePickPops() { for (const p of [...OPEN_POPS]) if (isPickPop(p)) p.remove(); }
  function bubbleOpen() { return !!spider || !!pickSheet || [...OPEN_POPS].some(isPickPop); }
  MC.bubbleOpen = bubbleOpen;
  MC.closeBubbles = () => { closeSpider(); closePickSheet(); closePickPops(); openClusterKey = null; };
  map.on('click', (e) => { if (!e.defaultPrevented) { openClusterKey = null; closeSpider(); } });
  function openSpider(items, lngLat) {
    h('closeMenus');
    closeSpider(); closePickSheet();
    const n = items.length, R = n <= 2 ? 56 : n <= 4 ? 72 : 84, W = 2 * R + 40;
    const pts = items.map((_, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [Math.round(Math.cos(a) * R), Math.round(Math.sin(a) * R)]; });
    const el = document.createElement('div');
    el.className = 'spider';
    const D = 2 * R + 64;   // disco di sfondo leggero (le etichette possono uscire dal bordo)
    el.innerHTML = `<span class="sp-back" style="width:${D}px;height:${D}px"></span><svg class="sp-lines" width="${W}" height="${W}" viewBox="${-W / 2} ${-W / 2} ${W} ${W}">${pts.map(([x, y]) => `<line x1="0" y1="0" x2="${x}" y2="${y}"/>`).join('')}</svg>
      <span class="sp-center"></span>` + items.map((it, i) => {
        const l = h('describe', it);
        // nome verso l'esterno: sopra/sotto per chi sta in alto/in basso, a sinistra/destra ai lati
        const [x, y] = pts[i], side = Math.abs(y) >= Math.abs(x) * 2 ? (y < 0 ? 'up' : 'down') : x < 0 ? 'left' : 'right';
        return `<button type="button" class="sp-item sp-${side}" data-n="${i}" style="--x:${x}px;--y:${y}px"><span class="sp-ic">${l.sw || ''}</span><span class="sp-l">${esc(l.name)}</span></button>`;
      }).join('');
    for (const ev of ['mousedown', 'touchstart', 'wheel', 'dblclick']) el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const b = ev.target.closest('[data-n]');
      if (!b) return closeSpider();
      const it = items[+b.dataset.n];
      closeSpider();
      openPick(it, lngLat, true);   // e la mappa zooma sull'elemento scelto
    });
    spider = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(lngLat).addTo(map);
  }
  for (const ev of ['dragstart', 'zoomstart', 'rotatestart']) map.on(ev, (e) => { if (e.originalEvent) closeSpider(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSpider(); });

  return MC;
}

MapCore.create = create;
window.MapCore = MapCore;
})();
