//! Static browser reader resources. The outer router applies Host and Origin guards.
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::header::{
    CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS,
};
use hyper::{Method, Request, Response, StatusCode};
use std::sync::OnceLock;

pub(crate) fn handle<B>(request: &Request<B>) -> Option<Response<Full<Bytes>>> {
    if request.method() != Method::GET {
        return None;
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
        "/reader.js" => (
            "text/javascript; charset=utf-8",
            Bytes::from_static(include_bytes!("reader/reader.js")),
        ),
        _ => return None,
    };
    Some(Response::builder().status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .header(CACHE_CONTROL, "no-store")
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(REFERRER_POLICY, "no-referrer")
        .header(CONTENT_SECURITY_POLICY, "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        .body(Full::new(body)).expect("static response"))
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
