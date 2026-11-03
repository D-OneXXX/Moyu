//! D2 read-only data routes and the session-authenticated HTTP gate.
//!
//! The production pair router delegates here only when a data provider is
//! injected. This module owns the exact eight-route allowlist, query parsing,
//! per-IP/session/render limits, ETag/304 handling, and the stable error body.
//! It never reads a request path from the client as a filesystem path, never
//! emits CORS headers, and never calls a provider on an unauthenticated
//! request.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http_body_util::Full;
use hyper::body::{Body, Bytes};
use hyper::header::{
    CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE, ETAG, IF_NONE_MATCH, RETRY_AFTER, SET_COOKIE,
    VARY,
};
use hyper::{Method, Request, Response, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::auth::PairingService;
use super::secret::random_hex;
use super::session::strict_u32;
use super::session_auth::{
    authenticate_request, refresh_for_request, session_cookie, AuthenticatedSession,
};
pub(crate) use crate::read_service::DataError;
use crate::read_service::{
    bucket_tile_width, ImageAsset, PageManifest, ProgressView, TileImage, WebBookDetail,
    WebBookPage,
};
use crate::PageDim;

/// The frozen default page width; the query layer clamps every request.
const DEFAULT_WIDTH: u32 = 1080;
const MIN_WIDTH: u32 = 320;
const MAX_WIDTH: u32 = 2160;

/// Read-only endpoint families used for rate-limit buckets.
const RATE_WINDOW: Duration = Duration::from_secs(60);
const METADATA_PER_WINDOW: u32 = 120;
const IMAGE_PER_WINDOW: u32 = 120;
const TILE_PER_WINDOW: u32 = 600;
const MAX_RATE_BUCKETS: usize = 1024;

/// Concurrency bounds. Permits are held only across the blocking provider call.
const SESSION_IN_FLIGHT: usize = 6;
const SESSION_WAIT: Duration = Duration::from_secs(5);
const RENDER_GATE: usize = 2;
const MAX_SESSION_BUCKETS: usize = 1024;
const DATA_HANDLER_TIMEOUT: Duration = Duration::from_secs(60);

const PRIVATE_NO_CACHE: &str = "private, no-cache";
const PRIVATE_MAX_AGE_300: &str = "private, max-age=300";
const NO_STORE: &str = "no-store";

const X_REQUEST_ID: &str = "x-request-id";
const X_CONTENT_TYPE_OPTIONS: &str = "x-content-type-options";
const X_TILE_COUNT: &str = "x-tile-count";
const X_TILE_HEIGHT: &str = "x-tile-height";

/// The eight data routes. Query parsing happens after authentication; the
/// shape itself is derived only from the raw path (no percent decoding).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DataRoute {
    Books,
    Book { id: String },
    Thumb { id: String },
    Pages { id: String },
    Page { id: String, index: u32 },
    Layout { id: String },
    Progress { id: String },
    Tile { id: String, index: u32, tile: u32 },
}

impl DataRoute {
    /// Match exactly one of the eight GET shapes. Any other method, path,
    /// trailing slash, ID encoding, or extra segment returns `None` so the
    /// caller answers the same `404` as an unknown path.
    pub(crate) fn parse(method: &Method, path: &str, _query: Option<&str>) -> Option<Self> {
        if method != Method::GET {
            return None;
        }
        let rest = path.strip_prefix("/api/books")?;
        if rest.is_empty() {
            return Some(Self::Books);
        }
        let rest = rest.strip_prefix('/')?;
        let segments = rest.split('/').collect::<Vec<_>>();
        if segments.iter().any(|segment| segment.is_empty()) {
            return None;
        }
        match segments.as_slice() {
            [id] => Some(Self::Book {
                id: parse_book_id(id)?,
            }),
            [id, "thumb"] => Some(Self::Thumb {
                id: parse_book_id(id)?,
            }),
            [id, "pages"] => Some(Self::Pages {
                id: parse_book_id(id)?,
            }),
            [id, "pages", index] => Some(Self::Page {
                id: parse_book_id(id)?,
                index: strict_u32(index)?,
            }),
            [id, "layout"] => Some(Self::Layout {
                id: parse_book_id(id)?,
            }),
            [id, "progress"] => Some(Self::Progress {
                id: parse_book_id(id)?,
            }),
            [id, "pages", index, "tiles", tile] => Some(Self::Tile {
                id: parse_book_id(id)?,
                index: strict_u32(index)?,
                tile: strict_u32(tile)?,
            }),
            _ => None,
        }
    }

    fn class(&self) -> DataClass {
        match self {
            Self::Thumb { .. } | Self::Page { .. } => DataClass::Image,
            Self::Tile { .. } => DataClass::Tile,
            Self::Books
            | Self::Book { .. }
            | Self::Pages { .. }
            | Self::Layout { .. }
            | Self::Progress { .. } => DataClass::Metadata,
        }
    }

    /// Only routes that may decode/probe image data take a render permit.
    /// Metadata reads are cheap and must not queue behind a tall-page render.
    fn uses_render(&self) -> bool {
        matches!(
            self,
            Self::Thumb { .. } | Self::Page { .. } | Self::Tile { .. } | Self::Layout { .. }
        )
    }

    fn into_call(self, query: Option<&str>) -> Result<DataCall, DataError> {
        match self {
            Self::Books => {
                let (q, cursor, limit) = parse_books_query(query)?;
                Ok(DataCall::Books { q, cursor, limit })
            }
            Self::Book { id } => Ok(DataCall::Book(id)),
            Self::Thumb { id } => Ok(DataCall::Thumb(id)),
            Self::Pages { id } => Ok(DataCall::Pages(id)),
            Self::Page { id, index } => Ok(DataCall::Page {
                id,
                index,
                width: parse_width(query)?,
            }),
            Self::Layout { id } => Ok(DataCall::Layout(id)),
            Self::Progress { id } => Ok(DataCall::Progress(id)),
            Self::Tile { id, index, tile } => Ok(DataCall::Tile {
                id,
                index,
                tile,
                width: bucket_tile_width(parse_width(query)?),
            }),
        }
    }
}

fn parse_book_id(value: &str) -> Option<String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    Some(value.to_owned())
}

/// The provider boundary. Implementations are synchronous and are always
/// invoked from `spawn_blocking`; they must not depend on a runtime handle.
pub(crate) trait WebDataAccess: Send + Sync {
    fn list_books(
        &self,
        q: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<WebBookPage, DataError>;
    fn book(&self, id: &str) -> Result<WebBookDetail, DataError>;
    fn thumb(&self, id: &str) -> Result<ImageAsset, DataError>;
    fn pages(&self, id: &str) -> Result<PageManifest, DataError>;
    fn page(&self, id: &str, index: u32, width: u32) -> Result<ImageAsset, DataError>;
    fn layout(&self, id: &str) -> Result<Vec<PageDim>, DataError>;
    fn tile(&self, id: &str, index: u32, tile: u32, width: u32) -> Result<TileImage, DataError>;
    fn progress(&self, id: &str) -> Result<ProgressView, DataError>;
}

/// Session-authenticated data gate used by the production pair router.
pub(crate) struct DataHttp {
    service: Arc<PairingService>,
    data: Arc<dyn WebDataAccess>,
    limiter: DataLimiter,
    sessions: SessionLimiter,
    render_gate: Arc<Semaphore>,
}

impl DataHttp {
    pub(crate) fn new(service: Arc<PairingService>, data: Arc<dyn WebDataAccess>) -> Self {
        Self {
            service,
            data,
            limiter: DataLimiter::new(RATE_WINDOW),
            sessions: SessionLimiter::new(SESSION_IN_FLIGHT, MAX_SESSION_BUCKETS),
            render_gate: Arc::new(Semaphore::new(RENDER_GATE)),
        }
    }

    /// Handle one request. `None` means the path is not one of the eight data
    /// routes; the caller keeps its own 404 response.
    pub(crate) async fn handle<B>(
        &self,
        request: &Request<B>,
        source_ip: Ipv4Addr,
    ) -> Option<Response<Full<Bytes>>>
    where
        B: Body<Data = Bytes> + Unpin,
    {
        let route = DataRoute::parse(
            request.method(),
            request.uri().path(),
            request.uri().query(),
        )?;
        let request_id = random_hex(8);
        let class = route.class();
        let uses_render = route.uses_render();

        // Rate limiting happens before authentication so an unauthenticated
        // flood cannot consume session/render work.
        if let Err(retry_after) = self.limiter.check(source_ip, class, Instant::now()) {
            return Some(rate_limited_response(&request_id, retry_after));
        }

        let session = match authenticate_request(request, &self.service) {
            Ok(session) => session,
            Err(_) => {
                return Some(error_response(
                    StatusCode::UNAUTHORIZED,
                    "unauthorized",
                    &request_id,
                    None,
                    None,
                    false,
                ));
            }
        };

        // Query validation is deliberately after authentication so a caller
        // without a session cannot probe parameter behavior.
        let call = match route.into_call(request.uri().query()) {
            Ok(call) => call,
            Err(error) => return Some(data_error_response(error, &request_id)),
        };

        let session_gate = self.sessions.gate(&session.view.id);
        let session_permit =
            match tokio::time::timeout(SESSION_WAIT, session_gate.acquire_owned()).await {
                Ok(Ok(permit)) => permit,
                _ => return Some(busy_response(&request_id)),
            };

        let render_permit: Option<OwnedSemaphorePermit> = if uses_render {
            match tokio::time::timeout(SESSION_WAIT, Arc::clone(&self.render_gate).acquire_owned())
                .await
            {
                Ok(Ok(permit)) => Some(permit),
                _ => return Some(busy_response(&request_id)),
            }
        } else {
            None
        };

        let provider = Arc::clone(&self.data);
        // Move the permits into the blocking task: a handler timeout must not
        // release the gates while an uncancellable render is still running.
        let outcome = tokio::time::timeout(
            DATA_HANDLER_TIMEOUT,
            tokio::task::spawn_blocking(move || {
                let _session_permit = session_permit;
                let _render_permit = render_permit;
                call.run(provider.as_ref())
            }),
        )
        .await;

        let payload = match outcome {
            Err(_) => return Some(data_error_response(DataError::Timeout, &request_id)),
            Ok(Err(_)) => return Some(data_error_response(DataError::Internal, &request_id)),
            Ok(Ok(Err(error))) => return Some(data_error_response(error, &request_id)),
            Ok(Ok(Ok(payload))) => payload,
        };

        let mut response = payload.into_response(request, &request_id);
        if response.status() == StatusCode::OK || response.status() == StatusCode::NOT_MODIFIED {
            self.apply_refresh(&session, request.uri().path(), &mut response);
        }
        Some(response)
    }

    /// Extend the session only for a successful page/tile read. Throttle and
    /// the 90-day absolute deadline stay owned by `SessionStore`.
    fn apply_refresh(
        &self,
        session: &AuthenticatedSession,
        path: &str,
        response: &mut Response<Full<Bytes>>,
    ) {
        let Ok(Some(super::session::RefreshOutcome::Refreshed { expires_at, .. })) =
            refresh_for_request(&self.service, &session.view, "GET", path, false)
        else {
            return;
        };
        let max_age = expires_at
            .saturating_duration_since(Instant::now())
            .as_secs();
        if let Some(cookie) = session_cookie(session.token.as_str(), max_age) {
            response.headers_mut().append(SET_COOKIE, cookie);
        }
    }
}

/// A provider call after query parsing. Values are owned so the blocking
/// closure can move them without borrowing the request.
enum DataCall {
    Books {
        q: Option<String>,
        cursor: Option<String>,
        limit: u32,
    },
    Book(String),
    Thumb(String),
    Pages(String),
    Page {
        id: String,
        index: u32,
        width: u32,
    },
    Layout(String),
    Progress(String),
    Tile {
        id: String,
        index: u32,
        tile: u32,
        width: u32,
    },
}

impl DataCall {
    fn run(self, provider: &dyn WebDataAccess) -> Result<Payload, DataError> {
        match self {
            Self::Books { q, cursor, limit } => provider
                .list_books(q.as_deref(), cursor.as_deref(), limit)
                .map(Payload::Books),
            Self::Book(id) => provider.book(&id).map(Payload::Book),
            Self::Thumb(id) => provider.thumb(&id).map(Payload::Thumb),
            Self::Pages(id) => provider.pages(&id).map(Payload::Pages),
            Self::Page { id, index, width } => {
                provider.page(&id, index, width).map(|asset| Payload::Page {
                    asset,
                    index,
                    width,
                })
            }
            Self::Layout(id) => provider.layout(&id).map(Payload::Layout),
            Self::Progress(id) => provider.progress(&id).map(Payload::Progress),
            Self::Tile {
                id,
                index,
                tile,
                width,
            } => provider
                .tile(&id, index, tile, width)
                .map(|image| Payload::Tile {
                    image,
                    index,
                    tile,
                    width,
                }),
        }
    }
}

enum Payload {
    Books(WebBookPage),
    Book(WebBookDetail),
    Thumb(ImageAsset),
    Pages(PageManifest),
    Page {
        asset: ImageAsset,
        index: u32,
        width: u32,
    },
    Layout(Vec<PageDim>),
    Progress(ProgressView),
    Tile {
        image: TileImage,
        index: u32,
        tile: u32,
        width: u32,
    },
}

impl Payload {
    fn into_response<B>(self, request: &Request<B>, request_id: &str) -> Response<Full<Bytes>> {
        match self {
            Self::Books(page) => json_response(&page, PRIVATE_NO_CACHE, request, request_id),
            Self::Book(book) => json_response(&book, PRIVATE_NO_CACHE, request, request_id),
            Self::Pages(manifest) => {
                json_response(&manifest, PRIVATE_NO_CACHE, request, request_id)
            }
            Self::Progress(progress) => {
                json_response(&progress, PRIVATE_NO_CACHE, request, request_id)
            }
            Self::Layout(dims) => json_response(
                &LayoutBody { pages: &dims },
                PRIVATE_MAX_AGE_300,
                request,
                request_id,
            ),
            Self::Thumb(asset) => {
                let ImageAsset { bytes, mime, .. } = asset;
                let etag = image_etag("t", &[], &bytes);
                image_response(
                    bytes,
                    mime,
                    etag,
                    PRIVATE_NO_CACHE,
                    &[],
                    request,
                    request_id,
                )
            }
            Self::Page {
                asset,
                index,
                width,
            } => {
                let parts = [index.to_string(), width.to_string()];
                let etag = image_etag("p", &parts, &asset.bytes);
                let ImageAsset { bytes, mime, .. } = asset;
                image_response(
                    bytes,
                    mime,
                    etag,
                    PRIVATE_NO_CACHE,
                    &[],
                    request,
                    request_id,
                )
            }
            Self::Tile {
                image,
                index,
                tile,
                width,
            } => {
                let parts = [index.to_string(), tile.to_string(), width.to_string()];
                let etag = image_etag("t", &parts, &image.image.bytes);
                let TileImage {
                    image: asset,
                    tile_count,
                    tile_height,
                } = image;
                let extras = [
                    (X_TILE_COUNT, tile_count.to_string()),
                    (X_TILE_HEIGHT, tile_height.to_string()),
                ];
                let ImageAsset { bytes, mime, .. } = asset;
                image_response(
                    bytes,
                    mime,
                    etag,
                    PRIVATE_NO_CACHE,
                    &extras,
                    request,
                    request_id,
                )
            }
        }
    }
}

#[derive(Serialize)]
struct LayoutBody<'a> {
    pages: &'a [PageDim],
}

fn json_response<T: Serialize, B>(
    value: &T,
    cache_control: &'static str,
    request: &Request<B>,
    request_id: &str,
) -> Response<Full<Bytes>> {
    let body = serde_json::to_vec(value).expect("data DTO serializes");
    let etag = json_etag(&body);
    if not_modified(request, &etag) {
        return not_modified_response(&etag, cache_control, &[], request_id);
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header(CACHE_CONTROL, cache_control)
        .header(VARY, "Cookie")
        .header(ETAG, etag)
        .header(X_REQUEST_ID, request_id)
        .body(Full::new(Bytes::from(body)))
        .expect("static response")
}

fn image_response<B>(
    bytes: Vec<u8>,
    mime: &'static str,
    etag: String,
    cache_control: &'static str,
    extras: &[(&'static str, String)],
    request: &Request<B>,
    request_id: &str,
) -> Response<Full<Bytes>> {
    if not_modified(request, &etag) {
        return not_modified_response(&etag, cache_control, extras, request_id);
    }
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, mime)
        .header(CACHE_CONTROL, cache_control)
        .header(VARY, "Cookie")
        .header(ETAG, etag)
        .header(CONTENT_DISPOSITION, "inline")
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(X_REQUEST_ID, request_id);
    for (name, value) in extras {
        builder = builder.header(*name, value);
    }
    builder
        .body(Full::new(Bytes::from(bytes)))
        .expect("static response")
}

fn not_modified_response(
    etag: &str,
    cache_control: &'static str,
    extras: &[(&'static str, String)],
    request_id: &str,
) -> Response<Full<Bytes>> {
    let mut builder = Response::builder()
        .status(StatusCode::NOT_MODIFIED)
        .header(CACHE_CONTROL, cache_control)
        .header(VARY, "Cookie")
        .header(ETAG, etag)
        .header(X_REQUEST_ID, request_id);
    for (name, value) in extras {
        builder = builder.header(*name, value);
    }
    builder
        .body(Full::new(Bytes::new()))
        .expect("static response")
}

fn image_etag(prefix: &str, parts: &[String], bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let hash = hex::encode(&digest[..8]);
    if parts.is_empty() {
        format!("\"{prefix}-{hash}\"")
    } else {
        format!("\"{prefix}-{}-{hash}\"", parts.join("-"))
    }
}

fn json_etag(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("\"j-{}\"", hex::encode(&digest[..8]))
}

/// `If-None-Match` only. `If-Modified-Since` is intentionally ignored because
/// the L2 mtime is refreshed by LRU touches and is not a content identity.
fn not_modified<B>(request: &Request<B>, etag: &str) -> bool {
    request
        .headers()
        .get_all(IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|candidate| etag_matches(candidate, etag))
}

/// GET uses weak comparison (RFC 7232): `W/"..."` matches the same strong
/// validator. `*` matches any current representation.
fn etag_matches(candidate: &str, etag: &str) -> bool {
    let candidate = candidate.trim();
    if candidate == "*" {
        return true;
    }
    candidate.strip_prefix("W/").unwrap_or(candidate) == etag
}

fn data_error_response(error: DataError, request_id: &str) -> Response<Full<Bytes>> {
    let retry_after = matches!(error, DataError::Busy).then(|| Duration::from_secs(1));
    error_response(
        error_status(error),
        error_code(error),
        request_id,
        error_details(error),
        retry_after,
        false,
    )
}

fn error_status(error: DataError) -> StatusCode {
    match error {
        DataError::NotFound | DataError::Removed | DataError::ThumbMissing => StatusCode::NOT_FOUND,
        DataError::PdfUnsupported | DataError::SourceUnsupported => {
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        }
        DataError::SourceMissing => StatusCode::CONFLICT,
        DataError::PageOutOfRange { .. } | DataError::TileOutOfRange { .. } => {
            StatusCode::RANGE_NOT_SATISFIABLE
        }
        DataError::InvalidParameter => StatusCode::BAD_REQUEST,
        DataError::Busy | DataError::DbUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        DataError::Timeout => StatusCode::GATEWAY_TIMEOUT,
        DataError::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn error_code(error: DataError) -> &'static str {
    match error {
        DataError::NotFound | DataError::Removed => "book-not-found",
        DataError::ThumbMissing => "thumbnail-missing",
        DataError::PdfUnsupported => "pdf-source-unsupported",
        DataError::SourceUnsupported => "source-unsupported",
        DataError::SourceMissing => "source-missing",
        // The frozen contract uses one 416 code for page and tile range errors;
        // `details.maxTile` distinguishes the tile case.
        DataError::PageOutOfRange { .. } | DataError::TileOutOfRange { .. } => "page-out-of-range",
        DataError::InvalidParameter => "invalid-parameter",
        // `busy` is the frozen 503 code for transient unavailability.
        DataError::Busy | DataError::DbUnavailable => "busy",
        DataError::Timeout => "render-timeout",
        DataError::Internal => "internal-error",
    }
}

fn error_details(error: DataError) -> Option<Value> {
    match error {
        DataError::PageOutOfRange { max_page } => Some(json!({ "maxPage": max_page })),
        DataError::TileOutOfRange { max_tile } => Some(json!({ "maxTile": max_tile })),
        _ => None,
    }
}

fn error_response(
    status: StatusCode,
    code: &'static str,
    request_id: &str,
    details: Option<Value>,
    retry_after: Option<Duration>,
    retry_after_in_body: bool,
) -> Response<Full<Bytes>> {
    let mut error = serde_json::Map::new();
    error.insert("code".to_owned(), Value::String(code.to_owned()));
    error.insert("requestId".to_owned(), Value::String(request_id.to_owned()));
    if let Some(details) = details {
        error.insert("details".to_owned(), details);
    }
    if retry_after_in_body {
        if let Some(retry_after) = retry_after {
            error.insert(
                "retryAfterMs".to_owned(),
                Value::from(retry_after_millis(retry_after)),
            );
        }
    }
    let body = serde_json::to_vec(&json!({ "error": Value::Object(error) }))
        .expect("error body serializes");
    let mut builder = Response::builder()
        .status(status)
        .header(CACHE_CONTROL, NO_STORE)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header(X_REQUEST_ID, request_id);
    if let Some(retry_after) = retry_after {
        builder = builder.header(RETRY_AFTER, retry_after_seconds(retry_after));
    }
    builder
        .body(Full::new(Bytes::from(body)))
        .expect("static response")
}

fn rate_limited_response(request_id: &str, retry_after: Duration) -> Response<Full<Bytes>> {
    error_response(
        StatusCode::TOO_MANY_REQUESTS,
        // The frozen 429 vocabulary has one code. The desktop localizes it as
        // the Web Access rate limit, which is the user-visible meaning here.
        "pairing-rate-limited",
        request_id,
        None,
        Some(retry_after),
        true,
    )
}

fn busy_response(request_id: &str) -> Response<Full<Bytes>> {
    error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "busy",
        request_id,
        None,
        Some(Duration::from_secs(1)),
        false,
    )
}

fn retry_after_seconds(retry_after: Duration) -> u64 {
    let seconds = retry_after.as_secs() + u64::from(retry_after.subsec_nanos() > 0);
    seconds.max(1)
}

fn retry_after_millis(retry_after: Duration) -> u64 {
    u64::try_from(retry_after.as_millis().max(1)).unwrap_or(u64::MAX)
}

type BooksQuery = (Option<String>, Option<String>, u32);

/// Parse `q`/`cursor`/`limit`. Duplicates of a known key are a client error;
/// unknown keys are ignored so the route remains forward-compatible.
fn parse_books_query(raw: Option<&str>) -> Result<BooksQuery, DataError> {
    let mut q: Option<String> = None;
    let mut cursor: Option<String> = None;
    let mut limit = 40u32;
    let mut limit_seen = false;

    for (key, value) in url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
        match key.as_ref() {
            "q" => {
                if q.is_some() || value.chars().count() > 128 {
                    return Err(DataError::InvalidParameter);
                }
                q = Some(value.into_owned());
            }
            "cursor" => {
                if cursor.is_some() || value.len() > 64 {
                    return Err(DataError::InvalidParameter);
                }
                cursor = Some(value.into_owned());
            }
            "limit" => {
                if limit_seen
                    || value.is_empty()
                    || !value.bytes().all(|byte| byte.is_ascii_digit())
                {
                    return Err(DataError::InvalidParameter);
                }
                limit_seen = true;
                limit = value.parse().map_err(|_| DataError::InvalidParameter)?;
                if !(1..=100).contains(&limit) {
                    return Err(DataError::InvalidParameter);
                }
            }
            _ => {}
        }
    }

    Ok((q.filter(|value| !value.is_empty()), cursor, limit))
}

/// Parse `w`, default 1080, clamp 320..=2160. A non-integer, empty, or
/// duplicate `w` is `400`; out-of-range integers are clamped, not rejected.
fn parse_width(raw: Option<&str>) -> Result<u32, DataError> {
    let mut width: Option<u32> = None;
    for (key, value) in url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
        if key != "w" {
            continue;
        }
        if width.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
            return Err(DataError::InvalidParameter);
        }
        width = Some(value.parse().map_err(|_| DataError::InvalidParameter)?);
    }
    Ok(width.unwrap_or(DEFAULT_WIDTH).clamp(MIN_WIDTH, MAX_WIDTH))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum DataClass {
    Metadata = 0,
    Image = 1,
    Tile = 2,
}

impl DataClass {
    fn index(self) -> usize {
        self as usize
    }

    fn limit(self) -> u32 {
        match self {
            Self::Metadata => METADATA_PER_WINDOW,
            Self::Image => IMAGE_PER_WINDOW,
            Self::Tile => TILE_PER_WINDOW,
        }
    }
}

struct IpBucket {
    window_started: Instant,
    counts: [u32; 3],
}

struct DataLimiter {
    buckets: Mutex<HashMap<Ipv4Addr, IpBucket>>,
    window: Duration,
}

impl DataLimiter {
    fn new(window: Duration) -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
            window,
        }
    }

    fn check(&self, ip: Ipv4Addr, class: DataClass, now: Instant) -> Result<(), Duration> {
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !buckets.contains_key(&ip) && buckets.len() >= MAX_RATE_BUCKETS {
            buckets.retain(|_, bucket| {
                now.saturating_duration_since(bucket.window_started) < self.window
            });
            if buckets.len() >= MAX_RATE_BUCKETS {
                return Err(self.window);
            }
        }
        let bucket = buckets.entry(ip).or_insert_with(|| IpBucket {
            window_started: now,
            counts: [0; 3],
        });
        if now.saturating_duration_since(bucket.window_started) >= self.window {
            bucket.window_started = now;
            bucket.counts = [0; 3];
        }
        let index = class.index();
        if bucket.counts[index] >= class.limit() {
            let elapsed = now.saturating_duration_since(bucket.window_started);
            return Err(self
                .window
                .saturating_sub(elapsed)
                .max(Duration::from_millis(1)));
        }
        bucket.counts[index] += 1;
        Ok(())
    }
}

/// Per-session in-flight gate. The map is bounded; evicting a bucket only
/// removes the lookup entry, never a permit an in-flight request still holds.
struct SessionLimiter {
    gates: Mutex<HashMap<String, Arc<Semaphore>>>,
    permits: usize,
    max_buckets: usize,
}

impl SessionLimiter {
    fn new(permits: usize, max_buckets: usize) -> Self {
        Self {
            gates: Mutex::new(HashMap::new()),
            permits,
            max_buckets,
        }
    }

    fn gate(&self, session_id: &str) -> Arc<Semaphore> {
        let mut gates = self
            .gates
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(gate) = gates.get(session_id) {
            return Arc::clone(gate);
        }
        if gates.len() >= self.max_buckets {
            if let Some(key) = gates.keys().next().cloned() {
                gates.remove(&key);
            }
        }
        let gate = Arc::new(Semaphore::new(self.permits));
        gates.insert(session_id.to_owned(), Arc::clone(&gate));
        gate
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book_id() -> String {
        "a".repeat(64)
    }

    #[test]
    fn data_route_shapes_are_exact() {
        let id = book_id();
        let page = format!("/api/books/{id}/pages/0");
        let tile = format!("/api/books/{id}/pages/0/tiles/0");
        let cases = vec![
            ("/api/books".to_owned(), true),
            (format!("/api/books/{id}"), true),
            (format!("/api/books/{id}/thumb"), true),
            (format!("/api/books/{id}/pages"), true),
            (page, true),
            (format!("/api/books/{id}/layout"), true),
            (format!("/api/books/{id}/progress"), true),
            (tile, true),
            ("/api/books/..%2f..%2fetc".to_owned(), false),
            ("/api/books/not-hex".to_owned(), false),
            ("/api/books/.../pages/0".to_owned(), false),
            (format!("/api/books/{id}/pages/0/tiles/"), false),
            (format!("/api/books/{id}/pages/0/tiles/0/extra"), false),
            (format!("/api/books/{id}/pages/999999999999"), false),
            (format!("/api/books/{id}/"), false),
            (format!("/api/books/{}", "A".repeat(64)), false),
            ("/api/book".to_owned(), false),
        ];
        for (path, expected) in cases {
            let parsed = DataRoute::parse(&Method::GET, &path, None);
            assert_eq!(parsed.is_some(), expected, "{path}");
        }
        assert!(DataRoute::parse(&Method::POST, "/api/books", None).is_none());
        assert!(DataRoute::parse(&Method::HEAD, "/api/books", None).is_none());
        assert!(DataRoute::parse(&Method::OPTIONS, "/api/books", None).is_none());
    }

    #[test]
    fn book_id_requires_lowercase_hex_of_exactly_64() {
        assert!(parse_book_id(&"a".repeat(64)).is_some());
        assert!(parse_book_id(&"0".repeat(64)).is_some());
        assert!(parse_book_id(&"A".repeat(64)).is_none());
        assert!(parse_book_id(&"g".repeat(64)).is_none());
        assert!(parse_book_id(&"a".repeat(63)).is_none());
        assert!(parse_book_id(&"a".repeat(65)).is_none());
    }

    #[test]
    fn books_query_validates_and_normalizes() {
        assert_eq!(parse_books_query(None).unwrap(), (None, None, 40));
        assert_eq!(
            parse_books_query(Some("q=abc&limit=5")).unwrap(),
            (Some("abc".to_owned()), None, 5)
        );
        assert_eq!(
            parse_books_query(Some("q=&cursor=abc")).unwrap(),
            (None, Some("abc".to_owned()), 40)
        );
        assert!(parse_books_query(Some("q=a&q=b")).is_err());
        assert!(parse_books_query(Some("limit=1&limit=2")).is_err());
        assert!(parse_books_query(Some("limit=0")).is_err());
        assert!(parse_books_query(Some("limit=101")).is_err());
        assert!(parse_books_query(Some("limit=x")).is_err());
        assert!(parse_books_query(Some("limit=")).is_err());
        assert!(parse_books_query(Some(&format!("q={}", "a".repeat(129)))).is_err());
        assert!(parse_books_query(Some(&format!("cursor={}", "a".repeat(65)))).is_err());
        assert!(parse_books_query(Some("cursor=&q=ok")).is_ok());
        assert!(parse_books_query(Some("unknown=value")).is_ok());
    }

    #[test]
    fn width_query_clamps_and_rejects_duplicates_or_non_integers() {
        assert_eq!(parse_width(None).unwrap(), DEFAULT_WIDTH);
        assert_eq!(parse_width(Some("w=1080")).unwrap(), 1080);
        assert_eq!(parse_width(Some("w=1")).unwrap(), MIN_WIDTH);
        assert_eq!(parse_width(Some("w=5000")).unwrap(), MAX_WIDTH);
        assert_eq!(parse_width(Some("x=1")).unwrap(), DEFAULT_WIDTH);
        for bad in ["w=", "w=abc", "w=1.5", "w=-1", "w=1&w=2"] {
            assert!(parse_width(Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn data_limiter_is_per_ip_and_per_class() {
        let limiter = DataLimiter::new(RATE_WINDOW);
        let now = Instant::now();
        let ip = Ipv4Addr::new(192, 168, 1, 20);
        for _ in 0..METADATA_PER_WINDOW {
            assert!(limiter.check(ip, DataClass::Metadata, now).is_ok());
        }
        let retry = limiter
            .check(ip, DataClass::Metadata, now)
            .expect_err("metadata bucket is full");
        assert!(retry > Duration::ZERO && retry <= RATE_WINDOW);
        assert!(limiter.check(ip, DataClass::Image, now).is_ok());
        assert!(limiter
            .check(Ipv4Addr::new(192, 168, 1, 21), DataClass::Metadata, now)
            .is_ok());
        assert!(limiter
            .check(ip, DataClass::Metadata, now + RATE_WINDOW)
            .is_ok());
    }

    #[test]
    fn etags_include_geometry_and_content_hash() {
        let etag = image_etag("p", &["0".to_owned(), "1080".to_owned()], b"abc");
        assert!(etag.starts_with("\"p-0-1080-"));
        assert!(etag.ends_with('"'));
        assert_eq!(etag.len(), 1 + 1 + 1 + 1 + 1 + 4 + 1 + 16 + 1);
        assert_ne!(
            etag,
            image_etag("p", &["0".to_owned(), "1080".to_owned()], b"abd")
        );

        let thumb = image_etag("t", &[], b"abc");
        assert!(thumb.starts_with("\"t-"));
        assert_eq!(thumb.len(), 1 + 1 + 1 + 16 + 1);

        let tile = image_etag(
            "t",
            &["0".to_owned(), "1".to_owned(), "1088".to_owned()],
            b"abc",
        );
        assert!(tile.starts_with("\"t-0-1-1088-"));
    }

    #[test]
    fn if_none_match_accepts_exact_comma_list_and_star_only() {
        let etag = "\"p-0-1080-deadbeefdeadbeef\"";
        let exact = Request::builder()
            .method(Method::GET)
            .uri("/api/books")
            .header(IF_NONE_MATCH, etag)
            .body(())
            .unwrap();
        assert!(not_modified(&exact, etag));

        let list = Request::builder()
            .method(Method::GET)
            .uri("/api/books")
            .header(IF_NONE_MATCH, format!("\"other\", {etag}"))
            .body(())
            .unwrap();
        assert!(not_modified(&list, etag));

        let star = Request::builder()
            .method(Method::GET)
            .uri("/api/books")
            .header(IF_NONE_MATCH, "*")
            .body(())
            .unwrap();
        assert!(not_modified(&star, etag));

        let weak = Request::builder()
            .method(Method::GET)
            .uri("/api/books")
            .header(IF_NONE_MATCH, format!("W/{etag}"))
            .body(())
            .unwrap();
        assert!(not_modified(&weak, etag));

        let different = Request::builder()
            .method(Method::GET)
            .uri("/api/books")
            .header(IF_NONE_MATCH, "\"other\"")
            .body(())
            .unwrap();
        assert!(!not_modified(&different, etag));
    }
}
