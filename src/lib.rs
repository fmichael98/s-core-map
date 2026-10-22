//! s-core-map — motore mappa comune delle app S*.
//!
//! Incorpora e serve: `map.js` / `map.css` (il motore: fondali, tema, controlli, icone, livelli,
//! etichette, scorrimento dei target, scelta tra elementi vicini, raggruppamento), MapLibre GL
//! (`maplibre-gl.js` / `.css`) e i caratteri IBM Plex usati nelle etichette disegnate.
//!
//! Nella pagina (dopo il guscio s-core, prima di `app.js`):
//! ```html
//! <link rel="stylesheet" href="/vendor/maplibre-gl.css">
//! <link rel="stylesheet" href="/map.css?v=0.1.0">
//! <script src="/vendor/maplibre-gl.js"></script>
//! <script src="/map.js?v=0.1.0"></script>
//! ```
//! e nel router axum: `.merge(s_core_map::routes())`.
//!
//! Poi, in `app.js`: `const MC = MapCore.create({ container: 'map', hooks: {…} })` (vedi `web/map.js`).

use axum::{
    http::{header, HeaderValue},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};

/// Versione del motore (quella di questo crate): utile come `?v=` per la cache del browser.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MAP_JS: &str = include_str!("../web/map.js");
pub const MAP_CSS: &str = include_str!("../web/map.css");
pub const MAPLIBRE_JS: &str = include_str!("../web/vendor/maplibre-gl.js");
pub const MAPLIBRE_CSS: &str = include_str!("../web/vendor/maplibre-gl.css");

const FONTS: &[(&str, &[u8])] = &[
    ("ibm-plex-sans-latin-400-normal.woff2", include_bytes!("../web/vendor/fonts/ibm-plex-sans-latin-400-normal.woff2")),
    ("ibm-plex-sans-latin-500-normal.woff2", include_bytes!("../web/vendor/fonts/ibm-plex-sans-latin-500-normal.woff2")),
    ("ibm-plex-sans-latin-600-normal.woff2", include_bytes!("../web/vendor/fonts/ibm-plex-sans-latin-600-normal.woff2")),
    ("ibm-plex-mono-latin-400-normal.woff2", include_bytes!("../web/vendor/fonts/ibm-plex-mono-latin-400-normal.woff2")),
    ("ibm-plex-mono-latin-500-normal.woff2", include_bytes!("../web/vendor/fonts/ibm-plex-mono-latin-500-normal.woff2")),
];

fn asset(body: &'static str, mime: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(mime)),
            (header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=86400")),
        ],
        body,
    )
        .into_response()
}

fn font(body: &'static [u8]) -> Response {
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("font/woff2")),
            (header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable")),
        ],
        body,
    )
        .into_response()
}

/// Le rotte del motore: `/map.js`, `/map.css`, `/vendor/maplibre-gl.js`, `/vendor/maplibre-gl.css`,
/// `/vendor/fonts/*.woff2`. Possono restare pubbliche (non contengono dati).
pub fn routes<S: Clone + Send + Sync + 'static>() -> Router<S> {
    let mut r = Router::new()
        .route("/map.js", get(|| async { asset(MAP_JS, "application/javascript; charset=utf-8") }))
        .route("/map.css", get(|| async { asset(MAP_CSS, "text/css; charset=utf-8") }))
        .route("/vendor/maplibre-gl.js", get(|| async { asset(MAPLIBRE_JS, "application/javascript; charset=utf-8") }))
        .route("/vendor/maplibre-gl.css", get(|| async { asset(MAPLIBRE_CSS, "text/css; charset=utf-8") }));
    for (name, body) in FONTS {
        r = r.route(&format!("/vendor/fonts/{name}"), get(move || async move { font(body) }));
    }
    r
}

/// Il blocco `<head>` da mettere nella pagina: MapLibre e il motore, con la versione per la cache.
pub fn head_tags() -> String {
    format!(
        r#"<link rel="stylesheet" href="/vendor/maplibre-gl.css">
<link rel="stylesheet" href="/map.css?v={v}">
<script src="/vendor/maplibre-gl.js"></script>
<script src="/map.js?v={v}"></script>"#,
        v = VERSION
    )
}

/// Percorsi pubblici (da lasciare fuori dal controllo di accesso).
pub const PUBLIC_PREFIXES: &[&str] = &["/map.js", "/map.css", "/vendor/"];
