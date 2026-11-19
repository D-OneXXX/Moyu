//! Static browser reader resources. The outer router applies Host and Origin guards.
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::header::{
    CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS,
};
use hyper::{Method, Request, Response, StatusCode};
use std::sync::OnceLock;

use super::pdf_assets;

/// Reader CSP. `worker-src 'self'` lets the PDF.js worker load from the same
/// embedded origin; `font-src 'self'` covers same-origin standard-font data.
/// No `unsafe-eval`, `wasm-unsafe-eval`, blob worker or external origin.
const READER_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; \
     img-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; \
     base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

pub(crate) fn handle<B>(request: &Request<B>) -> Option<Response<Full<Bytes>>> {
    if request.method() != Method::GET {
        return None;
    }
    if let Some(name) = pdf_asset_name(request.uri().path()) {
        let (bytes, mime) = pdf_assets::lookup(name)?;
        return Some(static_response(
            mime,
            Bytes::from_static(bytes),
            "private, max-age=3600",
        ));
    }
    let (content_type, body) = match request.uri().path() {
        "/" => (
            "text/html; charset=utf-8",
            Bytes::from_static(include_bytes!("reader/index.html")),
        ),
        "/reader.css" => (
            "text/css; charset=utf-8",
            Bytes::from_static(include_bytes!("reader/reader.css")),
        ),
        "/reader-theme.css" => {
            static THEME: OnceLock<Option<Bytes>> = OnceLock::new();
            (
                "text/css; charset=utf-8",
                THEME
                    .get_or_init(|| reader_theme().map(Bytes::from))
                    .clone()?,
            )
        }
        "/reader-messages.js" => (
            "text/javascript; charset=utf-8",
            Bytes::from_static(include_bytes!("../../../src/i18n/messages/webReader.ts")),
        ),
        "/reader-boot.js" => (
            "text/javascript; charset=utf-8",
            Bytes::from_static(include_bytes!("reader/reader-boot.js")),
        ),
        "/reader.js" => (
            "text/javascript; charset=utf-8",
            Bytes::from_static(include_bytes!("reader/reader.js")),
        ),
        _ => return None,
    };
    Some(static_response(content_type, body, "no-store"))
}

fn static_response(
    content_type: &'static str,
    body: Bytes,
    cache_control: &'static str,
) -> Response<Full<Bytes>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .header(CACHE_CONTROL, cache_control)
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(REFERRER_POLICY, "no-referrer")
        .header(CONTENT_SECURITY_POLICY, READER_CSP)
        .body(Full::new(body))
        .expect("static response")
}

/// Map the two reader-visible PDF.js namespaces onto the embedded table. Only
/// exact allow-listed names resolve; the table lookup itself is exact-match, so
/// `..`/percent-encoded traversal can never escape the approved set.
fn pdf_asset_name(path: &str) -> Option<&str> {
    match path {
        "/pdfjs/pdf.min.mjs" => Some("pdf.min.mjs"),
        "/pdfjs/pdf.worker.min.mjs" => Some("pdf.worker.min.mjs"),
        _ => path.strip_prefix("/pdf-assets/"),
    }
}

/// Reuse the desktop stylesheet's authoritative theme tokens instead of
/// maintaining an independent copy for the browser reader.
fn reader_theme() -> Option<String> {
    let source = include_str!("../../../src/index.css");
    let declarations = |selector: &str| -> Option<String> {
        let block = source.split_once(selector)?.1.split_once('}')?.0;
        let tokens: String = block
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("--sh-") && line.ends_with(';'))
            .collect();
        for key in [
            "--sh-background:",
            "--sh-foreground:",
            "--sh-card:",
            "--sh-primary:",
            "--sh-border:",
        ] {
            if !tokens.contains(key) {
                return None;
            }
        }
        Some(tokens)
    };
    let light = declarations(":root {")?;
    let dark = declarations("[data-theme=\"dark\"] {")?;
    // Three theme states, matching the desktop app's `data-theme` switch:
    //   auto   → follow the OS (media query)
    //   light  → force the light token block
    //   dark   → force the dark token block
    Some(format!(
        ":root{{color-scheme:light;{light}}}\
         :root[data-theme=\"dark\"]{{color-scheme:dark;{dark}}}\
         @media(prefers-color-scheme:dark){{:root:not([data-theme=\"light\"]){{color-scheme:dark;{dark}}}}}"
    ))
}
