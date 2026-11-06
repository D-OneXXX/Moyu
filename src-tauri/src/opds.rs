//! OPDS 1.2 client and local remote-library configuration.
//!
//! Only the explicitly configured origin is reachable. Feed/cover/download
//! requests never use ambient proxies and never forward credentials to a
//! different origin. Credentials and feed URLs are never logged.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use quick_xml::{
    events::{BytesStart, Event},
    name::ResolveResult,
    reader::NsReader,
    XmlVersion,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;
use zeroize::Zeroizing;

use crate::source::{BackendError, ImageSource as _};

const ATOM_NS: &str = "http://www.w3.org/2005/Atom";
const MAX_FEED_BYTES: usize = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 2000;
const MAX_LINKS: usize = 32;
/// Upper bound for a cover image. Covers are decoded and re-encoded before
/// reaching the WebView, so this only bounds the download phase.
pub(crate) const MAX_COVER_BYTES: usize = 16 * 1024 * 1024;
/// Upper bound for one chapter archive. Existing archive validation applies
/// after download (page count, per-page size, total uncompressed size).
pub(crate) const MAX_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;
/// CBR pages must fit the existing local archive per-page limit.
const CBR_PAGE_MAX_BYTES: u64 = crate::online::PAGE_MAX_BYTES as u64;
/// Header count cap before materializing RAR member metadata.
const CBR_MAX_MEMBERS: usize = 50_000;
const MAX_URL_BYTES: usize = 2048;
const MAX_USERNAME_BYTES: usize = 256;
const MAX_PASSWORD_BYTES: usize = 4096;
const MAX_TITLE_CHARS: usize = 120;

pub(crate) const OPDS_ENABLED_KEY: &str = "opds_enabled";
pub(crate) const OPDS_URL_KEY: &str = "opds_url";
pub(crate) const OPDS_USERNAME_KEY: &str = "opds_username";
pub(crate) const OPDS_PASSWORD_KEY: &str = "opds_password";
const OPDS_FEED_ACCEPT: &str =
    "application/atom+xml,application/atom+xml;profile=opds-catalog,application/xml;q=0.9,*/*;q=0.5";

/// Local-only OPDS configuration. Neither the stored username nor the
/// password is serialized to the frontend: [`OpdsConfigView`] only exposes
/// whether they are stored. Credentials never leave the Rust side.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpdsConfigView {
    pub enabled: bool,
    pub url: String,
    pub has_username: bool,
    pub has_password: bool,
}

impl std::fmt::Debug for OpdsConfigView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OpdsConfigView { configuration: [REDACTED] }")
    }
}

/// Request payload for saving local OPDS configuration.
///
/// `None` preserves the stored value; `Some("")` clears it. The frontend never
/// receives the stored username/password, so an untouched field stays `None`.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpdsConfigInput {
    pub enabled: bool,
    pub url: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

/// Validated runtime configuration (in-process only).
#[derive(Clone)]
pub(crate) struct OpdsRuntime {
    pub origin: Url,
    pub username: String,
    pub password: String,
}

impl std::fmt::Debug for OpdsRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OpdsRuntime { configuration: [REDACTED] }")
    }
}

#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpdsEntryView {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub navigation_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    pub media_type: String,
    /// `zip`, `rar`, or `auto` (sniffed after download). `None` = unsupported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive: Option<String>,
}

impl std::fmt::Debug for OpdsEntryView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OpdsEntryView { content: [REDACTED] }")
    }
}

#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpdsFeedView {
    pub url: String,
    pub title: String,
    pub entries: Vec<OpdsEntryView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_url: Option<String>,
}

impl std::fmt::Debug for OpdsFeedView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OpdsFeedView { content: [REDACTED] }")
    }
}

/// Dedicated client for an explicitly configured OPDS origin. It does not use
/// the generic website fetcher or ambient proxies; every redirect is checked.
pub(crate) struct OpdsClient {
    origin: Url,
    agent: ureq::Agent,
    authorization: Option<Zeroizing<String>>,
}

impl OpdsClient {
    pub(crate) fn new(
        origin: Url,
        credentials: Option<(&str, &str)>,
    ) -> Result<Self, &'static str> {
        same_origin_link(&origin, &origin, origin.as_str())?;
        let authorization = credentials.map(|(user, password)| {
            let value = Zeroizing::new(format!("{user}:{password}"));
            let mut header = Zeroizing::new(String::from("Basic "));
            STANDARD.encode_string(value.as_bytes(), &mut header);
            header
        });
        Ok(Self {
            origin,
            // Overall request timeouts would cut off large chapter downloads;
            // per-read timeout still bounds silent/hung servers.
            agent: ureq::AgentBuilder::new()
                .try_proxy_from_env(false)
                .redirects(0)
                .timeout_connect(Duration::from_secs(10))
                .timeout_read(Duration::from_secs(60))
                .build(),
            authorization,
        })
    }

    /// Return bounded bytes. Never include request URLs or headers in errors.
    pub(crate) fn fetch(&self, target: &Url, max_bytes: usize) -> Result<Vec<u8>, &'static str> {
        self.fetch_with_final(target, max_bytes)
            .map(|(_, bytes)| bytes)
    }

    fn fetch_with_final(
        &self,
        target: &Url,
        max_bytes: usize,
    ) -> Result<(Url, Vec<u8>), &'static str> {
        if max_bytes == 0 {
            return Err("invalid OPDS resource limit");
        }
        let mut current = same_origin_link(&self.origin, &self.origin, target.as_str())?;
        for hop in 0..=5 {
            let mut request = self
                .agent
                .get(current.as_str())
                .set("Accept", OPDS_FEED_ACCEPT);
            if let Some(auth) = &self.authorization {
                request = request.set("Authorization", auth.as_str());
            }
            let response = match request.call() {
                Ok(response) | Err(ureq::Error::Status(_, response)) => response,
                Err(ureq::Error::Transport(_)) => return Err("OPDS 请求失败（opds-fetch-failed）"),
            };
            let status = response.status();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                if hop == 5 {
                    return Err("OPDS 重定向次数过多（opds-fetch-failed）");
                }
                let location = response
                    .header("Location")
                    .ok_or("OPDS 重定向缺少目标（opds-fetch-failed）")?;
                current = same_origin_link(&self.origin, &current, location)?;
                continue;
            }
            if !(200..300).contains(&status) {
                return Err(match status {
                    401 | 403 => "OPDS 认证失败，请检查用户名和密码（opds-auth-failed）",
                    404 => "OPDS 目录不存在（opds-not-found）",
                    _ => "OPDS 请求失败（opds-fetch-failed）",
                });
            }
            let mut bytes = Vec::new();
            response
                .into_reader()
                .take((max_bytes as u64).saturating_add(1))
                .read_to_end(&mut bytes)
                .map_err(|_| "OPDS 响应读取失败（opds-fetch-failed）")?;
            if bytes.len() > max_bytes {
                return Err("OPDS 资源超过大小上限（opds-resource-too-large）");
            }
            return Ok((current, bytes));
        }
        Err("OPDS 重定向次数过多（opds-fetch-failed）")
    }

    /// Stream a bounded resource to a local file. The target file is created
    /// with `create_new` so an interrupted download can never be mistaken for
    /// a completed archive. The caller owns cleanup on error.
    pub(crate) fn download_to(
        &self,
        target: &Url,
        max_bytes: usize,
        dest: &Path,
    ) -> Result<u64, &'static str> {
        if max_bytes == 0 {
            return Err("无效的 OPDS 资源上限（opds-fetch-failed）");
        }
        let mut current = same_origin_link(&self.origin, &self.origin, target.as_str())?;
        for hop in 0..=5 {
            let mut request = self
                .agent
                .get(current.as_str())
                .set("Accept", "application/vnd.comicbook+zip,application/vnd.comicbook-rar,application/zip,application/rar,application/octet-stream,*/*;q=0.5");
            if let Some(auth) = &self.authorization {
                request = request.set("Authorization", auth.as_str());
            }
            let response = match request.call() {
                Ok(response) | Err(ureq::Error::Status(_, response)) => response,
                Err(ureq::Error::Transport(_)) => return Err("OPDS 请求失败（opds-fetch-failed）"),
            };
            let status = response.status();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                if hop == 5 {
                    return Err("OPDS 重定向次数过多（opds-fetch-failed）");
                }
                let location = response
                    .header("Location")
                    .ok_or("OPDS 重定向缺少目标（opds-fetch-failed）")?;
                current = same_origin_link(&self.origin, &current, location)?;
                continue;
            }
            if !(200..300).contains(&status) {
                return Err(match status {
                    401 | 403 => "OPDS 认证失败，请检查用户名和密码（opds-auth-failed）",
                    404 => "OPDS 附件不存在（opds-not-found）",
                    _ => "OPDS 下载失败（opds-fetch-failed）",
                });
            }
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(dest)
                .map_err(|_| "无法写入本地下载缓存（opds-io-failed）")?;
            let mut reader = response
                .into_reader()
                .take((max_bytes as u64).saturating_add(1));
            let written = std::io::copy(&mut reader, &mut file)
                .map_err(|_| "OPDS 下载写入失败（opds-io-failed）")?;
            if written > max_bytes as u64 {
                let _ = fs::remove_file(dest);
                return Err("OPDS 附件超过大小上限（opds-resource-too-large）");
            }
            file.sync_all()
                .map_err(|_| "OPDS 下载写入失败（opds-io-failed）")?;
            return Ok(written);
        }
        Err("OPDS 重定向次数过多（opds-fetch-failed）")
    }

    pub(crate) fn feed(&self, target: &Url) -> Result<Feed, &'static str> {
        let (final_url, bytes) = self.fetch_with_final(target, MAX_FEED_BYTES)?;
        let xml =
            std::str::from_utf8(&bytes).map_err(|_| "OPDS 目录格式无效（opds-invalid-feed）")?;
        parse_feed(&self.origin, &final_url, xml)
            .map_err(|_| "OPDS 目录格式无效（opds-invalid-feed）")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct FeedLink {
    pub rel: String,
    pub media_type: String,
    pub url: Url,
}
#[derive(Clone, PartialEq, Eq, Default)]
pub(crate) struct FeedEntry {
    pub title: String,
    pub links: Vec<FeedLink>,
}
#[derive(Clone, PartialEq, Eq, Default)]
pub(crate) struct Feed {
    pub title: String,
    pub links: Vec<FeedLink>,
    pub entries: Vec<FeedEntry>,
}

/// Resolve only HTTP(S) links on the user-configured origin. Credentials in
/// URL userinfo are not accepted; query strings may contain Kavita keys and
/// must be treated as secrets by every caller.
pub(crate) fn same_origin_link(origin: &Url, base: &Url, href: &str) -> Result<Url, &'static str> {
    if href.len() > MAX_URL_BYTES || href.chars().any(char::is_control) {
        return Err("OPDS 链接过长或含非法字符（opds-url-invalid）");
    }
    let target = base
        .join(href)
        .map_err(|_| "无效的 OPDS 链接（opds-url-invalid）")?;
    if target.as_str().len() > MAX_URL_BYTES {
        return Err("OPDS 链接过长（opds-url-invalid）");
    }
    if !matches!(origin.scheme(), "http" | "https")
        || !origin.username().is_empty()
        || origin.password().is_some()
        || !matches!(target.scheme(), "http" | "https")
        || !target.username().is_empty()
        || target.password().is_some()
        || target.origin() != origin.origin()
    {
        return Err("OPDS 链接超出已配置服务器（opds-cross-origin）");
    }
    Ok(target)
}

fn link(
    element: &BytesStart<'_>,
    origin: &Url,
    base: &Url,
) -> Result<Option<FeedLink>, &'static str> {
    let mut href = None;
    let mut rel = String::new();
    let mut media_type = String::new();
    for attribute in element.attributes() {
        let attr = attribute.map_err(|_| "invalid OPDS attribute")?;
        let value = attr
            .normalized_value(XmlVersion::Implicit1_0)
            .map_err(|_| "invalid OPDS attribute")?
            .into_owned();
        match attr.key.as_ref() {
            "href" => href = Some(value),
            "rel" => rel = value,
            "type" => media_type = value,
            _ => {}
        }
    }
    let Some(href) = href else { return Ok(None) };
    // Discard off-origin links rather than following them with local credentials.
    Ok(same_origin_link(origin, base, &href)
        .ok()
        .map(|url| FeedLink {
            rel,
            media_type,
            url,
        }))
}

fn element_base(element: &BytesStart<'_>, origin: &Url, parent: &Url) -> Result<Url, &'static str> {
    for attribute in element.attributes() {
        let attr = attribute.map_err(|_| "invalid OPDS attribute")?;
        if attr.key.as_ref() == "xml:base" {
            let value = attr
                .normalized_value(XmlVersion::Implicit1_0)
                .map_err(|_| "invalid OPDS base")?;
            return same_origin_link(origin, parent, &value);
        }
    }
    Ok(parent.clone())
}

pub(crate) fn parse_feed(origin: &Url, base: &Url, xml: &str) -> Result<Feed, &'static str> {
    if xml.len() > MAX_FEED_BYTES || same_origin_link(origin, origin, base.as_str()).is_err() {
        return Err("invalid OPDS feed");
    }
    let mut reader = NsReader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut feed = Feed::default();
    let mut current: Option<FeedEntry> = None;
    let mut depth = 0usize;
    let mut title_depth = None;
    let mut root = false;
    let mut bases: Vec<Url> = Vec::new();
    loop {
        let (ns, event) = reader
            .read_resolved_event()
            .map_err(|_| "invalid OPDS XML")?;
        let atom = matches!(ns, ResolveResult::Bound(namespace) if namespace.0 == ATOM_NS);
        match event {
            Event::Start(ref tag) => {
                depth += 1;
                if depth > 64 {
                    return Err("OPDS XML nesting limit");
                }
                let current_base = element_base(tag, origin, bases.last().unwrap_or(base))?;
                bases.push(current_base);
                let local = tag.local_name();
                let name = local.as_ref();
                if depth == 1 {
                    if !atom || name != "feed" || root {
                        return Err("not an Atom feed");
                    }
                    root = true;
                }
                if atom && depth == 2 && name == "entry" {
                    if feed.entries.len() >= MAX_ENTRIES {
                        return Err("OPDS entry limit");
                    }
                    current = Some(FeedEntry::default());
                } else if atom
                    && name == "title"
                    && ((depth == 2 && current.is_none()) || (depth == 3 && current.is_some()))
                {
                    title_depth = Some(depth);
                } else if atom
                    && name == "link"
                    && (depth == 2 || (depth == 3 && current.is_some()))
                {
                    if let Some(item) = link(tag, origin, bases.last().unwrap())? {
                        let links = if let Some(entry) = current.as_mut() {
                            &mut entry.links
                        } else {
                            &mut feed.links
                        };
                        if links.len() >= MAX_LINKS {
                            return Err("OPDS link limit");
                        }
                        links.push(item);
                    }
                }
            }
            Event::Empty(ref tag)
                if depth == 0 && atom && tag.local_name().as_ref() == "feed" && !root =>
            {
                element_base(tag, origin, base)?;
                root = true;
            }
            Event::Empty(ref tag)
                if atom
                    && tag.local_name().as_ref() == "link"
                    && (depth == 1 || (depth == 2 && current.is_some())) =>
            {
                let link_base = element_base(tag, origin, bases.last().unwrap_or(base))?;
                if let Some(item) = link(tag, origin, &link_base)? {
                    let links = if let Some(entry) = current.as_mut() {
                        &mut entry.links
                    } else {
                        &mut feed.links
                    };
                    if links.len() >= MAX_LINKS {
                        return Err("OPDS link limit");
                    }
                    links.push(item);
                }
            }
            Event::Text(text) if title_depth == Some(depth) => {
                let value = text.xml_content(XmlVersion::Implicit1_0);
                let title = if let Some(entry) = current.as_mut() {
                    &mut entry.title
                } else {
                    &mut feed.title
                };
                title.push_str(&value);
                if title.len() > 4096 {
                    return Err("OPDS title limit");
                }
            }
            Event::CData(text) if title_depth == Some(depth) => {
                let title = if let Some(entry) = current.as_mut() {
                    &mut entry.title
                } else {
                    &mut feed.title
                };
                title.push_str(&text.xml_content(XmlVersion::Implicit1_0));
                if title.len() > 4096 {
                    return Err("OPDS title limit");
                }
            }
            Event::GeneralRef(reference) if title_depth == Some(depth) => {
                let ch = match reference.as_ref() {
                    "amp" => '&',
                    "lt" => '<',
                    "gt" => '>',
                    "quot" => '"',
                    "apos" => '\'',
                    _ => reference
                        .resolve_char_ref()
                        .map_err(|_| "invalid OPDS entity")?
                        .ok_or("unsupported OPDS entity")?,
                };
                let title = if let Some(entry) = current.as_mut() {
                    &mut entry.title
                } else {
                    &mut feed.title
                };
                title.push(ch);
                if title.len() > 4096 {
                    return Err("OPDS title limit");
                }
            }
            Event::DocType(_) => return Err("OPDS DTD not allowed"),
            Event::End(ref tag) => {
                if title_depth == Some(depth) {
                    let title = if let Some(entry) = current.as_mut() {
                        &mut entry.title
                    } else {
                        &mut feed.title
                    };
                    *title = title.trim().to_owned();
                    title_depth = None;
                }
                if atom && depth == 2 && tag.local_name().as_ref() == "entry" {
                    feed.entries
                        .push(current.take().ok_or("invalid OPDS entry")?);
                }
                depth = depth.checked_sub(1).ok_or("invalid OPDS XML")?;
                bases.pop().ok_or("invalid OPDS XML")?;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !root || depth != 0 || current.is_some() {
        return Err("invalid OPDS XML");
    }
    Ok(feed)
}

// ---------- Local configuration (SQLite settings; never serialized secrets) ----------

fn setting(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>, BackendError> {
    crate::db::get_setting(conn, key)
}

fn bool_setting(conn: &rusqlite::Connection, key: &str) -> Result<bool, BackendError> {
    Ok(matches!(
        setting(conn, key)?.as_deref(),
        Some("true") | Some("1")
    ))
}

fn validate_config_url(raw: &str, required: bool) -> Result<Option<Url>, BackendError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return if required {
            Err(BackendError::Msg(
                "远程书库地址未配置（opds-not-configured）".into(),
            ))
        } else {
            Ok(None)
        };
    }
    if raw.len() > MAX_URL_BYTES || raw.chars().any(char::is_control) {
        return Err(BackendError::Msg(
            "远程书库地址无效（opds-url-invalid）".into(),
        ));
    }
    let mut url = Url::parse(raw)
        .map_err(|_| BackendError::Msg("远程书库地址无效（opds-url-invalid）".into()))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().map(str::is_empty).unwrap_or(true)
    {
        return Err(BackendError::Msg(
            "远程书库地址无效（opds-url-invalid）".into(),
        ));
    }
    url.set_fragment(None);
    Ok(Some(url))
}

fn validate_username(raw: &str) -> Result<String, BackendError> {
    let value = raw.trim();
    if value.len() > MAX_USERNAME_BYTES
        || value.contains(':')
        || value.chars().any(char::is_control)
    {
        return Err(BackendError::Msg(
            "远程书库账号含非法字符（opds-credentials-invalid）".into(),
        ));
    }
    Ok(value.to_string())
}

fn validate_password(raw: &str) -> Result<(), BackendError> {
    if raw.len() > MAX_PASSWORD_BYTES || raw.chars().any(char::is_control) {
        return Err(BackendError::Msg(
            "远程书库密码含非法字符（opds-credentials-invalid）".into(),
        ));
    }
    Ok(())
}

pub(crate) fn load_config(conn: &rusqlite::Connection) -> Result<OpdsConfigView, BackendError> {
    let username = setting(conn, OPDS_USERNAME_KEY)?.unwrap_or_default();
    let password = setting(conn, OPDS_PASSWORD_KEY)?.unwrap_or_default();
    Ok(OpdsConfigView {
        enabled: bool_setting(conn, OPDS_ENABLED_KEY)?,
        url: setting(conn, OPDS_URL_KEY)?.unwrap_or_default(),
        has_username: !username.is_empty(),
        has_password: !password.is_empty(),
    })
}

pub(crate) fn save_config(
    conn: &rusqlite::Connection,
    input: OpdsConfigInput,
) -> Result<OpdsConfigView, BackendError> {
    let url = validate_config_url(&input.url, input.enabled)?;
    let username = match input.username.as_deref() {
        Some(raw) => Some(validate_username(raw)?),
        None => None,
    };
    let transaction = conn.unchecked_transaction()?;
    let conn = &transaction;
    let previous_url = setting(conn, OPDS_URL_KEY)?.unwrap_or_default();
    let previous_origin = Url::parse(&previous_url).ok().map(|value| value.origin());
    let next_origin = url.as_ref().map(|value| value.origin());
    if let Some(password) = input.password.as_deref() {
        validate_password(password)?;
        crate::db::set_setting(conn, OPDS_PASSWORD_KEY, password)?;
    } else if previous_origin != next_origin {
        // Switching servers must never silently forward the old Basic secret
        // to a new origin. The user has to re-enter it (or explicitly clear).
        crate::db::set_setting(conn, OPDS_PASSWORD_KEY, "")?;
    }
    match username {
        Some(username) => crate::db::set_setting(conn, OPDS_USERNAME_KEY, &username)?,
        None if previous_origin != next_origin => {
            crate::db::set_setting(conn, OPDS_USERNAME_KEY, "")?;
        }
        None => {}
    }
    crate::db::set_setting(
        conn,
        OPDS_ENABLED_KEY,
        if input.enabled { "true" } else { "false" },
    )?;
    let url = url.map(|value| value.to_string()).unwrap_or_default();
    crate::db::set_setting(conn, OPDS_URL_KEY, &url)?;
    let view = load_config(conn)?;
    transaction.commit()?;
    Ok(view)
}

pub(crate) fn load_runtime(conn: &rusqlite::Connection) -> Result<OpdsRuntime, BackendError> {
    if !bool_setting(conn, OPDS_ENABLED_KEY)? {
        return Err(BackendError::Msg("远程书库未启用（opds-disabled）".into()));
    }
    let raw = setting(conn, OPDS_URL_KEY)?.unwrap_or_default();
    let origin = validate_config_url(&raw, true)?
        .ok_or_else(|| BackendError::Msg("远程书库地址未配置（opds-not-configured）".into()))?;
    // Settings can be edited outside the app (or corrupted by an old build);
    // revalidate at use time so a control character can never become a header.
    let username = validate_username(&setting(conn, OPDS_USERNAME_KEY)?.unwrap_or_default())?;
    let password = setting(conn, OPDS_PASSWORD_KEY)?.unwrap_or_default();
    validate_password(&password)?;
    Ok(OpdsRuntime {
        origin,
        username,
        password,
    })
}

pub(crate) fn client_for(runtime: &OpdsRuntime) -> Result<OpdsClient, BackendError> {
    let credentials = (!runtime.username.is_empty() || !runtime.password.is_empty())
        .then_some((runtime.username.as_str(), runtime.password.as_str()));
    OpdsClient::new(runtime.origin.clone(), credentials)
        .map_err(|error| BackendError::Msg(error.into()))
}

// ---------- Generic OPDS 1.2 feed projection ----------

fn link_with_rel<'a>(feed: &'a Feed, rel: &str) -> Option<&'a FeedLink> {
    feed.links.iter().find(|link| link.rel == rel)
}

fn link_url(feed: &Feed, rel: &str) -> Option<String> {
    link_with_rel(feed, rel).map(|link| link.url.to_string())
}

fn is_acquisition(link: &FeedLink) -> bool {
    link.rel == "http://opds-spec.org/acquisition"
        || link.rel.starts_with("http://opds-spec.org/acquisition/")
        || link.rel == "enclosure"
}

fn navigation_priority(link: &FeedLink) -> Option<u8> {
    if link.rel == "subsection" {
        return Some(0);
    }
    if matches!(
        link.rel.as_str(),
        "next" | "prev" | "first" | "last" | "self" | "start" | "up" | "search"
    ) {
        return None;
    }
    link.media_type
        .to_ascii_lowercase()
        .contains("application/atom+xml")
        .then_some(1)
}

fn cover_priority(link: &FeedLink) -> Option<u8> {
    match link.rel.as_str() {
        "http://opds-spec.org/image/thumbnail" => Some(0),
        "http://opds-spec.org/image" => Some(1),
        "thumbnail" => Some(2),
        "cover" => Some(3),
        _ => None,
    }
}

fn acquisition_priority(link: &FeedLink) -> Option<u8> {
    if !is_acquisition(link) {
        return None;
    }
    if link.rel == "http://opds-spec.org/acquisition" {
        Some(0)
    } else if link.rel.starts_with("http://opds-spec.org/acquisition/") {
        Some(1)
    } else if link.rel == "enclosure" {
        Some(2)
    } else {
        None
    }
}

fn extension_kind(url: &Url) -> Option<&'static str> {
    let path = url.path().to_ascii_lowercase();
    if path.ends_with(".cbz") || path.ends_with(".zip") {
        Some("zip")
    } else if path.ends_with(".cbr") || path.ends_with(".rar") {
        Some("rar")
    } else {
        None
    }
}

/// Map an OPDS acquisition media type to a local archive strategy.
///
/// `auto` means the response must be sniffed after download. Unknown types
/// with no archive extension remain unsupported.
pub(crate) fn archive_kind(media_type: &str, url: &Url) -> Option<&'static str> {
    let media_type = media_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match media_type.as_str() {
        "application/vnd.comicbook+zip"
        | "application/comicbook+zip"
        | "application/zip"
        | "application/x-cbz"
        | "application/x-zip-compressed" => Some("zip"),
        "application/vnd.comicbook-rar"
        | "application/comicbook-rar"
        | "application/vnd.rar"
        | "application/x-cbr"
        | "application/x-rar-compressed"
        | "application/x-rar" => Some("rar"),
        "" | "application/octet-stream" | "binary/octet-stream" => {
            extension_kind(url).or(Some("auto"))
        }
        _ => extension_kind(url),
    }
}

pub(crate) fn feed_view(feed: &Feed, url: &Url) -> OpdsFeedView {
    let entries = feed
        .entries
        .iter()
        .map(|entry| {
            let navigation = entry
                .links
                .iter()
                .enumerate()
                .filter_map(|(order, link)| {
                    navigation_priority(link).map(|priority| (priority, order, link))
                })
                .min_by_key(|(priority, order, _)| (*priority, *order))
                .map(|(_, _, link)| link.url.to_string());
            let cover = entry
                .links
                .iter()
                .enumerate()
                .filter_map(|(order, link)| {
                    cover_priority(link).map(|priority| (priority, order, link))
                })
                .min_by_key(|(priority, order, _)| (*priority, *order))
                .map(|(_, _, link)| link.url.to_string());
            let acquisition = entry
                .links
                .iter()
                .enumerate()
                .filter_map(|(order, link)| {
                    acquisition_priority(link).map(|priority| (priority, order, link))
                })
                .min_by_key(|(priority, order, _)| (*priority, *order))
                .map(|(_, _, link)| link);
            OpdsEntryView {
                title: entry.title.trim().to_string(),
                navigation_url: navigation,
                cover_url: cover,
                download_url: acquisition.map(|link| link.url.to_string()),
                media_type: acquisition
                    .map(|link| link.media_type.trim().to_string())
                    .unwrap_or_default(),
                archive: acquisition
                    .and_then(|link| archive_kind(&link.media_type, &link.url))
                    .map(str::to_string),
            }
        })
        .collect::<Vec<_>>();
    OpdsFeedView {
        url: url.to_string(),
        title: feed.title.trim().to_string(),
        entries,
        next_url: link_url(feed, "next"),
        prev_url: link_url(feed, "prev"),
    }
}

// ---------- Bounded download and CBR normalization ----------

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

/// Sanitize an OPDS entry title for a single Windows/POSIX filename.
fn safe_archive_name(title: &str) -> String {
    let mut name: String = title
        .chars()
        .filter(|ch| !ch.is_control())
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => ch,
        })
        .take(MAX_TITLE_CHARS)
        .collect();
    let lower = name.to_ascii_lowercase();
    for extension in [".cbz", ".cbr", ".zip", ".rar"] {
        if lower.ends_with(extension) {
            name.truncate(name.len() - extension.len());
            break;
        }
    }
    let name = name.trim().trim_end_matches('.').trim().to_string();
    let mut name = if name.is_empty() {
        "opds-book".to_string()
    } else {
        name
    };
    let upper = name.to_ascii_uppercase();
    let reserved = matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    if reserved {
        name = format!("_{name}");
    }
    name
}

enum SniffedArchive {
    Zip,
    Rar,
}

fn sniff_archive(path: &Path) -> Result<SniffedArchive, BackendError> {
    let mut file = File::open(path)
        .map_err(|_| BackendError::Msg("无法读取下载文件（opds-io-failed）".into()))?;
    let mut head = [0u8; 8];
    let mut filled = 0;
    while filled < head.len() {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(_) => {
                return Err(BackendError::Msg(
                    "无法读取下载文件（opds-io-failed）".into(),
                ))
            }
        }
    }
    let head = &head[..filled];
    if head.starts_with(&[0x50, 0x4B, 0x03, 0x04])
        || head.starts_with(&[0x50, 0x4B, 0x05, 0x06])
        || head.starts_with(&[0x50, 0x4B, 0x07, 0x08])
    {
        Ok(SniffedArchive::Zip)
    } else if head.starts_with(b"Rar!") {
        Ok(SniffedArchive::Rar)
    } else {
        Err(BackendError::Msg(
            "该 OPDS 附件不是 CBZ/CBR（opds-unsupported-format）".into(),
        ))
    }
}

/// Download one acquisition entry into `dest_root` and return a validated,
/// locally readable `.cbz`. The URL hash gives a stable directory; a second
/// request for the same chapter reuses the local file without networking.
pub(crate) fn download_archive(
    client: &OpdsClient,
    target: &Url,
    dest_root: &Path,
    title: &str,
) -> Result<PathBuf, BackendError> {
    let safe_name = safe_archive_name(title);
    let digest = hex::encode(Sha256::digest(target.as_str().as_bytes()));
    let directory = dest_root.join(&digest[..16]);
    let destination = directory.join(format!("{safe_name}.cbz"));
    if destination.is_file() {
        if let Ok(handle) = crate::source::open_source(&destination) {
            if handle.page_count().unwrap_or(0) > 0 {
                return Ok(destination);
            }
        }
        let _ = fs::remove_file(&destination);
    }
    fs::create_dir_all(dest_root)
        .map_err(|_| BackendError::Msg("无法创建 OPDS 下载目录（opds-io-failed）".into()))?;
    let temporary = dest_root.join(format!(".opds-download-{}.tmp", unique_suffix()));
    let result = (|| {
        client
            .download_to(target, MAX_ARCHIVE_BYTES, &temporary)
            .map_err(|error| BackendError::Msg(error.into()))?;
        let kind = sniff_archive(&temporary)?;
        fs::create_dir_all(&directory)
            .map_err(|_| BackendError::Msg("无法创建 OPDS 下载目录（opds-io-failed）".into()))?;
        match kind {
            SniffedArchive::Zip => {
                fs::rename(&temporary, &destination).map_err(|_| {
                    BackendError::Msg("无法保存 OPDS 附件（opds-io-failed）".into())
                })?;
            }
            SniffedArchive::Rar => {
                // Convert to a separate temp file and rename last: a crash
                // must never leave a truncated but structurally valid CBZ.
                let converted = dest_root.join(format!(".opds-convert-{}.tmp", unique_suffix()));
                if let Err(error) = convert_rar_to_cbz(&temporary, &converted) {
                    let _ = fs::remove_file(&converted);
                    return Err(error);
                }
                if fs::rename(&converted, &destination).is_err() {
                    let _ = fs::remove_file(&converted);
                    return Err(BackendError::Msg(
                        "无法保存 OPDS 附件（opds-io-failed）".into(),
                    ));
                }
                let _ = fs::remove_file(&temporary);
            }
        }
        let handle = crate::source::open_source(&destination)?;
        if handle.page_count().unwrap_or(0) == 0 {
            let _ = fs::remove_file(&destination);
            return Err(BackendError::Msg(
                "该 OPDS 附件没有可读图片（opds-unsupported-format）".into(),
            ));
        }
        Ok(destination.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        let _ = fs::remove_file(&destination);
    }
    result
}

fn cbr_error(error: unrar_rs::RarError) -> BackendError {
    use unrar_rs::RarError;
    match error {
        RarError::EncryptedArchive | RarError::InvalidPassword | RarError::WrongPassword { .. } => {
            BackendError::Msg("CBR 已加密，当前版本不支持（opds-cbr-encrypted）".into())
        }
        RarError::MissingVolume { .. } => {
            BackendError::Msg("CBR 是分卷压缩包，请先在服务器端合并（opds-cbr-multivolume）".into())
        }
        RarError::EncryptedMember { .. } => {
            BackendError::Msg("CBR 含加密条目，当前版本不支持（opds-cbr-encrypted）".into())
        }
        _ => BackendError::Msg("CBR 读取或解压失败（opds-cbr-failed）".into()),
    }
}

struct BoundedPageBuffer {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl Write for BoundedPageBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(std::io::Error::other("page size limit exceeded"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Convert a CBR/RAR file into a stored-method CBZ so the existing local
/// archive pipeline can read it. Encrypted, multi-volume, over-limit or
/// image-less archives are rejected before anything is written.
pub(crate) fn convert_rar_to_cbz(src: &Path, dest: &Path) -> Result<(), BackendError> {
    use std::collections::HashSet;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    let file = File::open(src).map_err(|_| cbr_error(unrar_rs::RarError::InvalidSignature))?;
    let mut archive = unrar_rs::RarArchive::open(file).map_err(cbr_error)?;
    archive.set_limits(unrar_rs::Limits {
        max_unpacked_size: crate::source::MAX_ARCHIVE_UNCOMPRESSED,
        max_data_segment: 64 * 1024 * 1024,
        ..Default::default()
    });
    // A downloaded OPDS attachment is always a single file. Multi-volume RAR
    // sets cannot be completed here, so fail closed before extracting any
    // member instead of surfacing a truncated/partial archive later.
    let missing_volumes = archive
        .member_names()
        .iter()
        .any(|name| !archive.missing_volumes(name).is_empty());
    if archive.more_volumes() || missing_volumes {
        return Err(cbr_error(unrar_rs::RarError::MissingVolume {
            volume: 1,
            member: String::new(),
        }));
    }
    if archive.len() > CBR_MAX_MEMBERS {
        return Err(BackendError::Msg(
            "CBR 条目数量超过安全上限（opds-resource-too-large）".into(),
        ));
    }
    let members = archive.entries().collect::<Vec<_>>();
    let mut images = HashSet::new();
    let mut total = 0u64;
    for (index, member) in members.iter().enumerate() {
        if member.is_encrypted {
            return Err(cbr_error(unrar_rs::RarError::EncryptedMember {
                member: member.name.clone(),
            }));
        }
        if member.is_directory || !crate::source::is_image_name(&member.name) {
            continue;
        }
        if member.is_symlink || member.is_hardlink {
            return Err(BackendError::Msg(
                "CBR 含不支持的链接条目（opds-cbr-failed）".into(),
            ));
        }
        let size = member.unpacked_size.ok_or_else(|| {
            BackendError::Msg("CBR 条目标头缺少大小信息（opds-cbr-failed）".into())
        })?;
        if size > CBR_PAGE_MAX_BYTES {
            return Err(BackendError::Msg(
                "CBR 单页超过大小上限（opds-resource-too-large）".into(),
            ));
        }
        total = total.saturating_add(size);
        if total > crate::source::MAX_ARCHIVE_UNCOMPRESSED {
            return Err(BackendError::Msg(
                "CBR 解压总量超过安全上限（opds-resource-too-large）".into(),
            ));
        }
        if images.len() >= crate::source::MAX_LOCAL_PAGES {
            return Err(BackendError::Msg(
                "CBR 页数超过安全上限（opds-resource-too-large）".into(),
            ));
        }
        images.insert(index);
    }
    if images.is_empty() {
        return Err(BackendError::Msg(
            "CBR 中没有可读图片（opds-unsupported-format）".into(),
        ));
    }
    let result = (|| {
        let output = File::create(dest)
            .map_err(|_| BackendError::Msg("无法写入 CBR 转换结果（opds-io-failed）".into()))?;
        let mut writer = zip::ZipWriter::new(output);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (index, member) in members.iter().enumerate() {
            let entry = archive.by_index(index).map_err(cbr_error)?;
            if images.contains(&index) {
                let mut page = BoundedPageBuffer {
                    bytes: Vec::with_capacity(
                        member.unpacked_size.unwrap_or(0).min(CBR_PAGE_MAX_BYTES) as usize,
                    ),
                    limit: CBR_PAGE_MAX_BYTES as usize,
                    exceeded: false,
                };
                let copied = entry.copy_to(&mut page);
                if page.exceeded {
                    return Err(BackendError::Msg(
                        "CBR 单页解压后超过大小上限（opds-resource-too-large）".into(),
                    ));
                }
                copied.map_err(cbr_error)?;
                let name = if member.name.is_empty() {
                    format!("{:05}.png", index + 1)
                } else {
                    member.name.clone()
                };
                writer
                    .start_file(name, options)
                    .map_err(|_| BackendError::Msg("CBR 转换写入失败（opds-cbr-failed）".into()))?;
                writer
                    .write_all(&page.bytes)
                    .map_err(|_| BackendError::Msg("CBR 转换写入失败（opds-cbr-failed）".into()))?;
            } else if !member.is_directory {
                entry.skip().map_err(cbr_error)?;
            }
        }
        writer
            .finish()
            .map_err(|_| BackendError::Msg("CBR 转换写入失败（opds-cbr-failed）".into()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(dest);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cbr_page_buffer_rejects_oversized_output_during_write() {
        let mut page = BoundedPageBuffer {
            bytes: Vec::new(),
            limit: 4,
            exceeded: false,
        };
        page.write_all(b"abcd").unwrap();
        assert!(page.write_all(b"e").is_err());
        assert!(page.exceeded);
        assert_eq!(page.bytes, b"abcd");
    }

    #[test]
    fn failed_config_write_rolls_back_all_changes() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        save_config(
            &conn,
            OpdsConfigInput {
                enabled: true,
                url: "http://old.example/catalog".into(),
                username: Some("old".into()),
                password: Some("secret".into()),
            },
        )
        .unwrap();
        conn.execute_batch("CREATE TRIGGER fail_opds_url BEFORE UPDATE ON settings WHEN NEW.k = 'opds_url' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").unwrap();
        assert!(save_config(
            &conn,
            OpdsConfigInput {
                enabled: true,
                url: "http://new.example/catalog".into(),
                username: Some("new".into()),
                password: None,
            }
        )
        .is_err());
        let runtime = load_runtime(&conn).unwrap();
        assert_eq!(runtime.origin.host_str(), Some("old.example"));
        assert_eq!(runtime.username, "old");
        assert_eq!(runtime.password, "secret");
        assert!(!format!("{runtime:?}").contains("secret"));
    }

    #[test]
    fn isolated_http_server_serves_catalog_cover_and_cbz_after_same_origin_redirect() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::Instant;
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(10, 20)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        archive
            .start_file("001.png", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(&png.into_inner()).unwrap();
        let book = archive.finish().unwrap().into_inner();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        println!(
            "OPDS mock PID {}; loopback port {}",
            std::process::id(),
            address.port()
        );
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut handled = 0;
            while handled < 4 && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(error) => panic!("mock accept failed: {error}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buf = [0; 1024];
                while !request.ends_with(b"\r\n\r\n") && request.len() < 8192 {
                    let count = stream.read(&mut buf).unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&buf[..count]);
                }
                let text = std::str::from_utf8(&request).unwrap();
                assert!(text.to_ascii_lowercase().contains(
                    "authorization: basic dXNlcjpwYXNz"
                        .to_ascii_lowercase()
                        .as_str()
                ));
                let path = text
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                let (status, headers, body): (&str, &str, &[u8]) = match path {
                    "/start" => ("302 Found", "Location: /library/catalog\r\n", b""),
                    "/library/catalog" => ("200 OK", "Content-Type: application/atom+xml\r\n", b"<feed xmlns='http://www.w3.org/2005/Atom'><entry><title>My book</title><link rel='http://opds-spec.org/image' href='cover.png'/><link rel='http://opds-spec.org/acquisition' type='application/vnd.comicbook+zip' href='book.cbz'/></entry></feed>"),
                    "/library/cover.png" => ("200 OK", "Content-Type: image/png\r\n", b"cover-bytes"),
                    "/library/book.cbz" => ("200 OK", "Content-Type: application/vnd.comicbook+zip\r\n", &book),
                    _ => panic!("unexpected mock route"),
                };
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(body).unwrap();
                handled += 1;
            }
            assert_eq!(handled, 4, "mock requests were not completed");
        });
        let root = Url::parse(&format!("http://{address}/start")).unwrap();
        let client = OpdsClient::new(root.clone(), Some(("user", "pass"))).unwrap();
        let feed = client.feed(&root).unwrap();
        assert_eq!(feed.entries[0].title, "My book");
        assert_eq!(
            client.fetch(&feed.entries[0].links[0].url, 128).unwrap(),
            b"cover-bytes"
        );
        let downloaded = client
            .fetch(&feed.entries[0].links[1].url, 1024 * 1024)
            .unwrap();
        let directory = std::env::temp_dir().join(format!(
            "moyu-opds-fixture-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let file = directory.join("book.cbz");
        struct TestBook(std::path::PathBuf, std::path::PathBuf);
        impl Drop for TestBook {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
                let _ = std::fs::remove_dir(&self.1);
            }
        }
        let _cleanup = TestBook(file.clone(), directory.clone());
        std::fs::write(&file, downloaded).unwrap();
        let handle = crate::source::SourceHandle::open(&file).unwrap();
        assert_eq!(handle.page_count().unwrap(), 1);
        let page = handle.read_raw(0).unwrap();
        let rendered = crate::pipeline::render_raw(&page, Some(320), Some(320)).unwrap();
        assert_eq!((rendered.orig_width, rendered.orig_height), (10, 20));
        drop(handle);
        server.join().unwrap();
        println!("OPDS mock listener and thread stopped");
    }

    #[test]
    fn redirect_to_another_origin_never_reaches_that_server() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let target_addr = target.local_addr().unwrap();
        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let source_addr = source.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = source.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut buf = [0; 2048];
            let _ = stream.read(&mut buf).unwrap();
            write!(stream, "HTTP/1.1 302 Found\r\nLocation: http://{target_addr}/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let root = Url::parse(&format!("http://{source_addr}/catalog")).unwrap();
        let client = OpdsClient::new(root.clone(), Some(("user", "pass"))).unwrap();
        assert!(client
            .fetch(&root, 1024)
            .unwrap_err()
            .contains("opds-cross-origin"));
        worker.join().unwrap();
        assert_eq!(
            target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn changing_configured_server_requires_no_code_change() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        for title in ["Server one", "Server two"] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buffer = [0; 2048];
                let _ = stream.read(&mut buffer).unwrap();
                let body = format!(
                    "<feed xmlns='http://www.w3.org/2005/Atom'><title>{title}</title></feed>"
                );
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            });
            let url = Url::parse(&format!("http://{address}/opds/catalog")).unwrap();
            let client = OpdsClient::new(url.clone(), None).unwrap();
            assert_eq!(client.feed(&url).unwrap().title, title);
            server.join().unwrap();
        }
    }
    #[test]
    fn parses_atom_entries_and_keeps_only_same_origin_links() {
        let base = Url::parse("http://192.168.1.2:25600/opds/v1.2/catalog").unwrap();
        let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>Library &amp; More</title><entry><title>My Comic</title><link rel="http://opds-spec.org/image" href="/cover/1"/><link rel="http://opds-spec.org/acquisition" type="application/vnd.comicbook+zip" href="../book/1?key=a&amp;page=1"/><link rel="http://opds-spec.org/acquisition" href="http://elsewhere.invalid/secret"/></entry><link rel="next" href="?page=2"/></feed>"#;
        let feed = parse_feed(&base, &base, xml).unwrap();
        assert_eq!(feed.title, "Library & More");
        assert_eq!(feed.entries[0].title, "My Comic");
        assert_eq!(feed.entries[0].links.len(), 2);
        assert_eq!(feed.entries[0].links[1].url.query(), Some("key=a&page=1"));
        assert_eq!(feed.links.len(), 1);
    }
    #[test]
    fn rejects_off_origin_userinfo_dtd_and_unbounded_feeds() {
        let base = Url::parse("http://192.168.1.2:25600/catalog").unwrap();
        assert!(parse_feed(&base, &base, "<feed xmlns='http://www.w3.org/2005/Atom'/>").is_ok());
        assert!(same_origin_link(&base, &base, "http://192.168.1.3:25600/x").is_err());
        assert!(same_origin_link(&base, &base, "http://user:pass@192.168.1.2:25600/x").is_err());
        assert!(same_origin_link(&base, &base, "/x\r\nInjected: 1").is_err());
        assert!(parse_feed(
            &base,
            &base,
            "<!DOCTYPE feed><feed xmlns='http://www.w3.org/2005/Atom'/>"
        )
        .is_err());
        assert!(parse_feed(&base, &base, &"x".repeat(MAX_FEED_BYTES + 1)).is_err());
    }

    #[test]
    fn xml_base_is_inherited_without_permitting_cross_origin() {
        let base = Url::parse("https://library.example/opds/catalog").unwrap();
        let xml = "<feed xmlns='http://www.w3.org/2005/Atom' xml:base='/books/'><entry xml:base='one/'><title><![CDATA[A & B]]></title><link rel='next' href='cover'/></entry></feed>";
        let feed = parse_feed(&base, &base, xml).unwrap();
        assert_eq!(feed.entries[0].title, "A & B");
        assert_eq!(
            feed.entries[0].links[0].url.as_str(),
            "https://library.example/books/one/cover"
        );
        assert!(parse_feed(
            &base,
            &base,
            "<feed xmlns='http://www.w3.org/2005/Atom' xml:base='https://evil.invalid/'></feed>"
        )
        .is_err());
    }

    #[test]
    fn archive_kind_accepts_opds_comic_types_and_known_extensions() {
        let base = Url::parse("http://192.168.1.20:8080/opds").unwrap();
        let kind =
            |media_type: &str, href: &str| archive_kind(media_type, &base.join(href).unwrap());
        for media_type in [
            "application/vnd.comicbook+zip",
            "application/comicbook+zip",
            "application/zip",
            "application/x-cbz",
            "application/x-zip-compressed",
            "application/vnd.comicbook+zip; charset=binary",
        ] {
            assert_eq!(kind(media_type, "book.bin"), Some("zip"), "{media_type}");
        }
        for media_type in [
            "application/vnd.comicbook-rar",
            "application/comicbook-rar",
            "application/vnd.rar",
            "application/x-cbr",
            "application/x-rar-compressed",
        ] {
            assert_eq!(kind(media_type, "book.bin"), Some("rar"), "{media_type}");
        }
        assert_eq!(kind("application/octet-stream", "book.CBR"), Some("rar"));
        assert_eq!(kind("", "book.cbz?x=1"), Some("zip"));
        assert_eq!(kind("application/octet-stream", "download"), Some("auto"));
        assert_eq!(kind("application/epub+zip", "book.epub"), None);
        assert_eq!(kind("text/html", "book.cbz"), Some("zip"));
    }

    #[test]
    fn feed_view_exposes_navigation_cover_download_and_pagination() {
        let base = Url::parse("http://192.168.1.20:8080/opds/v1.2/catalog").unwrap();
        let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom">
          <title>QA Library</title>
          <link rel="next" href="?page=2"/>
          <link rel="prev" href="?page=0"/>
          <entry>
            <title>Series A</title>
            <link rel="subsection" type="application/atom+xml;profile=opds-catalog;kind=navigation" href="/opds/v1.2/series/a"/>
            <link rel="http://opds-spec.org/image/thumbnail" type="image/jpeg" href="/thumbs/a.jpg"/>
            <link rel="http://opds-spec.org/image" type="image/jpeg" href="/covers/a.jpg"/>
          </entry>
          <entry>
            <title>Book B</title>
            <link rel="http://opds-spec.org/image" type="image/png" href="/covers/b.png"/>
            <link rel="http://opds-spec.org/acquisition" type="application/vnd.comicbook+zip" href="/books/b.cbz"/>
          </entry>
          <entry>
            <title>EPUB C</title>
            <link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="/books/c.epub"/>
          </entry>
          <entry><title>Empty D</title></entry>
        </feed>"#;
        let feed = parse_feed(&base, &base, xml).unwrap();
        let view = feed_view(&feed, &base);
        assert_eq!(view.title, "QA Library");
        assert_eq!(view.url, base.as_str());
        assert_eq!(
            view.next_url.as_deref(),
            Some("http://192.168.1.20:8080/opds/v1.2/catalog?page=2")
        );
        assert_eq!(
            view.prev_url.as_deref(),
            Some("http://192.168.1.20:8080/opds/v1.2/catalog?page=0")
        );

        assert_eq!(view.entries[0].title, "Series A");
        assert_eq!(
            view.entries[0].navigation_url.as_deref(),
            Some("http://192.168.1.20:8080/opds/v1.2/series/a")
        );
        assert_eq!(
            view.entries[0].cover_url.as_deref(),
            Some("http://192.168.1.20:8080/thumbs/a.jpg")
        );
        assert!(view.entries[0].download_url.is_none());

        assert_eq!(view.entries[1].title, "Book B");
        assert_eq!(
            view.entries[1].download_url.as_deref(),
            Some("http://192.168.1.20:8080/books/b.cbz")
        );
        assert_eq!(view.entries[1].archive.as_deref(), Some("zip"));
        assert_eq!(view.entries[1].media_type, "application/vnd.comicbook+zip");
        assert_eq!(
            view.entries[1].cover_url.as_deref(),
            Some("http://192.168.1.20:8080/covers/b.png")
        );

        assert!(view.entries[2].download_url.is_some());
        assert!(view.entries[2].archive.is_none());
        assert!(view.entries[3].navigation_url.is_none());
        assert!(view.entries[3].download_url.is_none());
    }

    #[test]
    fn local_config_is_write_only_and_can_be_switched() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let input = OpdsConfigInput {
            enabled: true,
            url: "http://192.168.1.20:25600/opds/v1.2/catalog#ignored".into(),
            username: Some("reader".into()),
            password: Some("top-secret".into()),
        };
        let view = save_config(&conn, input).unwrap();
        assert!(view.enabled);
        assert_eq!(view.url, "http://192.168.1.20:25600/opds/v1.2/catalog");
        assert!(view.has_username);
        assert!(view.has_password);
        let serialized = serde_json::to_string(&view).unwrap();
        assert!(!serialized.contains("reader"), "{serialized}");
        assert!(!serialized.contains("top-secret"), "{serialized}");
        assert!(!serialized.contains("\"username\""), "{serialized}");
        assert_eq!(
            crate::db::get_setting(&conn, OPDS_PASSWORD_KEY)
                .unwrap()
                .as_deref(),
            Some("top-secret")
        );

        let runtime = load_runtime(&conn).unwrap();
        assert_eq!(runtime.username, "reader");
        assert_eq!(runtime.password, "top-secret");

        // None preserves the stored credentials; Some("") explicitly clears.
        save_config(
            &conn,
            OpdsConfigInput {
                enabled: true,
                url: "http://192.168.1.20:25600/opds/v1.2/catalog".into(),
                username: None,
                password: None,
            },
        )
        .unwrap();
        assert!(load_config(&conn).unwrap().has_password);
        assert!(load_config(&conn).unwrap().has_username);
        save_config(
            &conn,
            OpdsConfigInput {
                enabled: true,
                url: "http://192.168.1.20:25600/opds/v1.2/catalog".into(),
                username: Some(String::new()),
                password: Some(String::new()),
            },
        )
        .unwrap();
        assert!(!load_config(&conn).unwrap().has_password);
        assert!(!load_config(&conn).unwrap().has_username);
        assert!(load_runtime(&conn).unwrap().password.is_empty());
        assert!(load_runtime(&conn).unwrap().username.is_empty());

        // Local self-hosted addresses are intentionally allowed.
        let runtime = load_runtime(&conn).unwrap();
        assert_eq!(runtime.origin.host_str(), Some("192.168.1.20"));

        // Disabled runtime refuses network work; empty/invalid inputs fail closed.
        save_config(
            &conn,
            OpdsConfigInput {
                enabled: false,
                url: "http://192.168.1.20:25600/opds/v1.2/catalog".into(),
                username: None,
                password: None,
            },
        )
        .unwrap();
        assert!(load_runtime(&conn)
            .unwrap_err()
            .to_string()
            .contains("opds-disabled"));
        for (enabled, url, code) in [
            (true, "", "opds-not-configured"),
            (true, "file:///tmp/catalog.xml", "opds-url-invalid"),
            (
                true,
                "http://user:pass@192.168.1.20/opds/v1.2/catalog",
                "opds-url-invalid",
            ),
        ] {
            let error = save_config(
                &conn,
                OpdsConfigInput {
                    enabled,
                    url: url.into(),
                    username: None,
                    password: None,
                },
            )
            .unwrap_err()
            .to_string();
            assert!(error.contains(code), "{error}");
        }
    }

    #[test]
    fn stored_corrupt_credentials_fail_closed() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        save_config(
            &conn,
            OpdsConfigInput {
                enabled: true,
                url: "http://192.168.1.20:25600/opds/v1.2/catalog".into(),
                username: Some("reader".into()),
                password: Some("secret".into()),
            },
        )
        .unwrap();
        crate::db::set_setting(&conn, OPDS_USERNAME_KEY, "reader\r\nInjected: 1").unwrap();
        let error = load_runtime(&conn).unwrap_err().to_string();
        assert!(error.contains("opds-credentials-invalid"), "{error}");
        crate::db::set_setting(&conn, OPDS_USERNAME_KEY, "reader").unwrap();
        crate::db::set_setting(&conn, OPDS_PASSWORD_KEY, "bad\nsecret").unwrap();
        let error = load_runtime(&conn).unwrap_err().to_string();
        assert!(error.contains("opds-credentials-invalid"), "{error}");
    }

    #[test]
    fn changing_origin_without_a_new_password_clears_the_stored_secret() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let save = |url: &str, username: Option<&str>, password: Option<&str>| {
            save_config(
                &conn,
                OpdsConfigInput {
                    enabled: true,
                    url: url.into(),
                    username: username.map(str::to_string),
                    password: password.map(str::to_string),
                },
            )
            .unwrap()
        };
        save(
            "http://192.168.1.20:25600/opds/v1.2/catalog",
            Some("reader"),
            Some("old-secret"),
        );
        assert!(load_config(&conn).unwrap().has_password);
        assert!(load_config(&conn).unwrap().has_username);
        // Same origin, different path: keep the credentials.
        save("http://192.168.1.20:25600/opds/v1.2/other", None, None);
        assert!(load_config(&conn).unwrap().has_password);
        assert!(load_config(&conn).unwrap().has_username);
        // New origin without new credentials: never forward the old pair.
        save("http://192.168.1.30:25600/opds/v1.2/catalog", None, None);
        assert!(!load_config(&conn).unwrap().has_password);
        assert!(!load_config(&conn).unwrap().has_username);
        assert!(load_runtime(&conn).unwrap().password.is_empty());
        assert!(load_runtime(&conn).unwrap().username.is_empty());
        save(
            "http://192.168.1.30:25600/opds/v1.2/catalog",
            Some("reader"),
            Some("new-secret"),
        );
        assert_eq!(load_runtime(&conn).unwrap().password, "new-secret");
        assert_eq!(load_runtime(&conn).unwrap().username, "reader");
    }

    #[test]
    fn switching_config_between_two_isolated_servers_requires_no_code_change() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        for (title, path) in [
            ("Server one", "/one/catalog"),
            ("Server two", "/two/catalog"),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                use std::io::{Read, Write};
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buffer = [0; 2048];
                let _ = stream.read(&mut buffer).unwrap();
                let body = format!(
                    "<feed xmlns='http://www.w3.org/2005/Atom'><title>{title}</title></feed>"
                );
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            });
            save_config(
                &conn,
                OpdsConfigInput {
                    enabled: true,
                    url: format!("http://{address}{path}"),
                    username: None,
                    password: None,
                },
            )
            .unwrap();
            let runtime = load_runtime(&conn).unwrap();
            let client = OpdsClient::new(
                runtime.origin.clone(),
                (!runtime.username.is_empty() || !runtime.password.is_empty())
                    .then_some((runtime.username.as_str(), runtime.password.as_str())),
            )
            .unwrap();
            let feed = client.feed(&runtime.origin).unwrap();
            assert_eq!(feed.title, title);
            server.join().unwrap();
        }
    }

    #[test]
    fn download_archive_imports_cbz_and_reuses_local_copy() {
        use std::io::Write;
        use std::net::TcpListener;
        let png = test_png();
        let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        archive
            .start_file("001.png", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(&png).unwrap();
        let book = archive.finish().unwrap().into_inner();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 2048];
            let _ = stream.read(&mut request).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.comicbook+zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                book.len()
            )
            .unwrap();
            stream.write_all(&book).unwrap();
        });
        let root = test_temp_dir("opds-download");
        let target = Url::parse(&format!("http://{address}/books/qa.cbz")).unwrap();
        let client = OpdsClient::new(target.clone(), None).unwrap();
        let path = download_archive(&client, &target, &root, "QA / Book: One").unwrap();
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("cbz"));
        assert!(path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap()
            .starts_with("QA _ Book_ One"));
        let handle = crate::source::open_source(&path).unwrap();
        assert_eq!(handle.page_count().unwrap(), 1);
        drop(handle);
        server.join().unwrap();

        // The server is gone: a second call must reuse the local copy.
        let again = download_archive(&client, &target, &root, "QA / Book: One").unwrap();
        assert_eq!(again, path);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn download_archive_rejects_non_archive_payload() {
        use std::io::Write;
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 2048];
            let _ = stream.read(&mut request).unwrap();
            let body = b"this is not a comic archive";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        });
        let root = test_temp_dir("opds-bad-download");
        let target = Url::parse(&format!("http://{address}/books/bad.cbz")).unwrap();
        let client = OpdsClient::new(target.clone(), None).unwrap();
        let error = download_archive(&client, &target, &root, "Bad")
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("opds-unsupported-format") || error.contains("archive-not-zip"),
            "{error}"
        );
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn stored_cbr_converts_to_cbz_with_all_pages() {
        let png = test_png();
        let cbr = rar5_archive(&[
            ("001.png", png.as_slice(), png.len() as u64),
            ("notes.txt", b"ignored".as_slice(), 7),
            ("002.png", png.as_slice(), png.len() as u64),
        ]);
        let root = test_temp_dir("opds-cbr-success");
        let src = root.join("book.cbr");
        let out = root.join("book.cbz");
        std::fs::write(&src, &cbr).unwrap();
        convert_rar_to_cbz(&src, &out).unwrap();
        let handle = crate::source::open_source(&out).unwrap();
        assert_eq!(handle.page_count().unwrap(), 2);
        assert!(!handle.read_raw(0).unwrap().bytes.is_empty());
        drop(handle);
        let names = {
            let file = File::open(&out).unwrap();
            let mut archive = zip::ZipArchive::new(file).unwrap();
            (0..archive.len())
                .map(|index| archive.by_index(index).unwrap().name().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(names, vec!["001.png", "002.png"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn multivolume_cbr_fails_closed_with_stable_code() {
        let png = test_png();
        let vol0 = rar5_split_archive(&png, png.len() / 2);
        let root = test_temp_dir("opds-cbr-volume");
        let src = root.join("book.cbr");
        let out = root.join("book.cbz");
        std::fs::write(&src, &vol0).unwrap();
        let error = convert_rar_to_cbz(&src, &out).unwrap_err().to_string();
        assert!(error.contains("opds-cbr-multivolume"), "{error}");
        assert!(!out.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn oversized_cbr_page_fails_closed_with_stable_code() {
        let declared = CBR_PAGE_MAX_BYTES + 1;
        let cbr = rar5_archive(&[("001.png", b"tiny".as_slice(), declared)]);
        let root = test_temp_dir("opds-cbr-large");
        let src = root.join("book.cbr");
        let out = root.join("book.cbz");
        std::fs::write(&src, &cbr).unwrap();
        let error = convert_rar_to_cbz(&src, &out).unwrap_err().to_string();
        assert!(error.contains("opds-resource-too-large"), "{error}");
        assert!(!out.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn path_api_keys_stay_on_the_configured_origin_only() {
        let base = Url::parse("http://192.168.1.20:26500/api/opds/qa-key/catalog").unwrap();
        let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom">
          <title>Key library</title>
          <entry>
            <title>Chapter</title>
            <link rel="http://opds-spec.org/acquisition" type="application/vnd.comicbook+zip" href="/api/opds/qa-key/books/1.cbz"/>
            <link rel="subsection" type="application/atom+xml" href="http://192.168.1.21:26500/api/opds/other-key/catalog"/>
          </entry>
          <link rel="next" href="http://127.0.0.1:26500/api/opds/qa-key/catalog?page=2"/>
        </feed>"#;
        let feed = parse_feed(&base, &base, xml).unwrap();
        // Off-origin LAN and loopback links are discarded before a request can
        // ever carry the path credential to another server.
        assert_eq!(feed.entries[0].links.len(), 1);
        assert!(feed.links.is_empty());
        let view = feed_view(&feed, &base);
        assert!(view.entries[0]
            .download_url
            .as_deref()
            .unwrap()
            .contains("/api/opds/qa-key/"));
        assert!(view.next_url.is_none());
        assert!(same_origin_link(
            &base,
            &base,
            "http://192.168.1.21:26500/api/opds/qa-key/catalog"
        )
        .is_err());
        // Relative links keep the key because they stay on the same origin.
        assert_eq!(
            same_origin_link(&base, &base, "../books/1.cbz")
                .unwrap()
                .as_str(),
            "http://192.168.1.20:26500/api/opds/books/1.cbz"
        );
    }

    #[test]
    fn ambient_proxy_is_ignored_for_opds_requests() {
        if std::env::var_os("MOYU_OPDS_PROXY_CHILD").is_some() {
            return;
        }
        let exe = std::env::current_exe().unwrap();
        let output = std::process::Command::new(exe)
            .args(["--exact", "opds::tests::ambient_proxy_child", "--nocapture"])
            .env("MOYU_OPDS_PROXY_CHILD", "1")
            .env("HTTP_PROXY", "http://127.0.0.1:1")
            .env("http_proxy", "http://127.0.0.1:1")
            .env("ALL_PROXY", "http://127.0.0.1:1")
            .env("all_proxy", "http://127.0.0.1:1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "OPDS used the ambient proxy: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn ambient_proxy_child() {
        if std::env::var_os("MOYU_OPDS_PROXY_CHILD").is_none() {
            return;
        }
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut buffer = [0; 2048];
            let _ = stream.read(&mut buffer).unwrap();
            let body = "<feed xmlns='http://www.w3.org/2005/Atom'><title>Direct</title></feed>";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        let root = Url::parse(&format!("http://{address}/catalog")).unwrap();
        let client = OpdsClient::new(root.clone(), None).unwrap();
        assert_eq!(client.feed(&root).unwrap().title, "Direct");
        server.join().unwrap();
    }

    #[test]
    fn rar_conversion_rejects_invalid_and_imageless_archives() {
        let root = test_temp_dir("opds-cbr");
        let invalid = root.join("bad.cbr");
        std::fs::write(&invalid, b"not a rar").unwrap();
        let out = root.join("out.cbz");
        let error = convert_rar_to_cbz(&invalid, &out).unwrap_err().to_string();
        assert!(error.contains("opds-cbr-failed"), "{error}");
        assert!(!out.exists());

        // Tiny header-only RAR fixtures from the MIT-licensed `unrar` crate
        // test data (0.5.8). Test-only; they are never shipped in the app.
        let plain = root.join("plain.rar");
        std::fs::write(
            &plain,
            STANDARD
                .decode("UmFyIRoHAM+QcwAADQAAAAAAAAAPDHQggCcAFQAAAAsAAAADRfN9xqSKB0cdMwcApIEAAFZFUlNJT04MAI/sikXMI8hICINi/l/dXFOI8HLEPXsAQAcA")
                .unwrap(),
        )
        .unwrap();
        let error = convert_rar_to_cbz(&plain, &out).unwrap_err().to_string();
        assert!(error.contains("opds-unsupported-format"), "{error}");
        assert!(!out.exists());

        let encrypted = root.join("encrypted.rar");
        std::fs::write(
            &encrypted,
            STANDARD
                .decode("UmFyIRoHAM+QcwAADQAAAAAAAADT2XQkhDIAIAAAABIAAAAD84oDbi2BA0cdMwoApIEAAC5naXRpZ25vcmWJBLqMkwZDIh85hflvJV85z+khJAZWPBJPkAbK/Nli2F/wxyMypS5txD17AEAHAA==")
                .unwrap(),
        )
        .unwrap();
        let error = convert_rar_to_cbz(&encrypted, &out)
            .unwrap_err()
            .to_string();
        assert!(error.contains("opds-cbr-encrypted"), "{error}");
        assert!(!out.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn full_catalog_navigation_cover_archive_and_pipeline_works() {
        use std::io::Write;
        use std::net::TcpListener;
        let png = test_png();
        let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        archive
            .start_file("001.png", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(&png).unwrap();
        let book = archive.finish().unwrap().into_inner();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let png_for_server = png.clone();
        let server = std::thread::spawn(move || {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buf = [0; 1024];
                while !request.ends_with(b"\r\n\r\n") && request.len() < 8192 {
                    let count = stream.read(&mut buf).unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&buf[..count]);
                }
                let text = std::str::from_utf8(&request).unwrap();
                assert!(text.to_ascii_lowercase().contains(
                    "authorization: basic dXNlcjpwYXNz"
                        .to_ascii_lowercase()
                        .as_str()
                ));
                let path = text
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                let (content_type, body): (&str, &[u8]) = match path {
                    "/opds/v1.2/catalog" => (
                        "application/atom+xml",
                        b"<feed xmlns='http://www.w3.org/2005/Atom'><title>QA OPDS</title><entry><title>Library One</title><link rel='subsection' type='application/atom+xml;profile=opds-catalog;kind=navigation' href='/opds/v1.2/libraries/one'/></entry></feed>",
                    ),
                    "/opds/v1.2/libraries/one" => (
                        "application/atom+xml",
                        b"<feed xmlns='http://www.w3.org/2005/Atom'><title>Library One</title><entry><title>Book A</title><link rel='http://opds-spec.org/image/thumbnail' type='image/png' href='/cover/a.png'/><link rel='http://opds-spec.org/acquisition' type='application/vnd.comicbook+zip' href='/books/a.cbz'/></entry><link rel='next' href='?page=2'/></feed>",
                    ),
                    "/cover/a.png" => ("image/png", png_for_server.as_slice()),
                    "/books/a.cbz" => ("application/vnd.comicbook+zip", book.as_slice()),
                    _ => panic!("unexpected route {path}"),
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(body).unwrap();
            }
        });
        let start = Url::parse(&format!("http://{address}/opds/v1.2/catalog")).unwrap();
        let client = OpdsClient::new(start.clone(), Some(("user", "pass"))).unwrap();
        let root_feed = client.feed(&start).unwrap();
        let root_view = feed_view(&root_feed, &start);
        assert_eq!(root_view.title, "QA OPDS");
        let library_url =
            Url::parse(root_view.entries[0].navigation_url.as_ref().unwrap()).unwrap();
        let library_feed = client.feed(&library_url).unwrap();
        let library_view = feed_view(&library_feed, &library_url);
        assert_eq!(library_view.title, "Library One");
        assert_eq!(
            library_view.next_url.as_deref(),
            Some(format!("http://{address}/opds/v1.2/libraries/one?page=2").as_str())
        );
        let entry = &library_view.entries[0];
        assert_eq!(entry.title, "Book A");
        let cover_url = Url::parse(entry.cover_url.as_ref().unwrap()).unwrap();
        let cover = client.fetch(&cover_url, MAX_COVER_BYTES).unwrap();
        assert_eq!(cover, png);
        let download_url = Url::parse(entry.download_url.as_ref().unwrap()).unwrap();
        let root = test_temp_dir("opds-e2e");
        let path = download_archive(&client, &download_url, &root, &entry.title).unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let imported = crate::commands::scan_single_book_with_title(
            &conn,
            &path,
            Some("Book A: Special / Edition"),
        )
        .unwrap();
        assert_eq!(imported.title, "Book A: Special / Edition");
        assert_eq!(imported.page_count, 1);
        assert_eq!(imported.source_type, "local");
        let handle = crate::source::open_source(&path).unwrap();
        assert_eq!(handle.page_count().unwrap(), 1);
        assert!(!handle.read_raw(0).unwrap().bytes.is_empty());
        drop(handle);
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------- Test-only RAR5 writer (stored method) ----------
    //
    // unrar-rs is read-only, so the CBR acceptance tests build valid RAR5
    // archives byte by byte. The layout mirrors what RARLAB `rar` emits for
    // `-m0` (stored) files; it is only used by unit tests.

    fn rar5_vint(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                return out;
            }
        }
    }

    fn rar5_crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for &byte in bytes {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn rar5_finish(content: Vec<u8>) -> Vec<u8> {
        let size = rar5_vint(content.len() as u64);
        let mut crc_input = size.clone();
        crc_input.extend_from_slice(&content);
        let mut out = Vec::new();
        out.extend_from_slice(&rar5_crc32(&crc_input).to_le_bytes());
        out.extend_from_slice(&size);
        out.extend_from_slice(&content);
        out
    }

    fn rar5_header(kind: u64, flags: u64, body: &[u8]) -> Vec<u8> {
        let mut content = Vec::new();
        content.extend_from_slice(&rar5_vint(kind));
        content.extend_from_slice(&rar5_vint(flags));
        content.extend_from_slice(body);
        rar5_finish(content)
    }

    fn rar5_file_header(
        name: &str,
        unpacked: u64,
        common_extra: u64,
        crc: Option<u32>,
        data_size: u64,
    ) -> Vec<u8> {
        let mut file_flags = 0u64;
        if crc.is_some() {
            file_flags |= 0x0004;
        }
        let mut body = Vec::new();
        body.extend_from_slice(&rar5_vint(file_flags));
        body.extend_from_slice(&rar5_vint(unpacked));
        body.extend_from_slice(&rar5_vint(0o644));
        if let Some(crc) = crc {
            body.extend_from_slice(&crc.to_le_bytes());
        }
        body.extend_from_slice(&rar5_vint(0)); // stored
        body.extend_from_slice(&rar5_vint(1)); // Unix host
        body.extend_from_slice(&rar5_vint(name.len() as u64));
        body.extend_from_slice(name.as_bytes());

        let mut content = Vec::new();
        content.extend_from_slice(&rar5_vint(2)); // file header
        content.extend_from_slice(&rar5_vint(0x0002 | common_extra)); // data area
        content.extend_from_slice(&rar5_vint(data_size));
        content.extend_from_slice(&body);
        rar5_finish(content)
    }

    fn rar5_archive(files: &[(&str, &[u8], u64)]) -> Vec<u8> {
        let mut archive = Vec::new();
        archive.extend_from_slice(b"Rar!\x1a\x07\x01\x00");
        archive.extend_from_slice(&rar5_header(1, 0, &rar5_vint(0)));
        for (name, data, unpacked) in files {
            archive.extend_from_slice(&rar5_file_header(
                name,
                *unpacked,
                0,
                Some(rar5_crc32(data)),
                data.len() as u64,
            ));
            archive.extend_from_slice(data);
        }
        archive.extend_from_slice(&rar5_header(5, 0, &rar5_vint(0)));
        archive
    }

    fn rar5_split_archive(content: &[u8], split_at: usize) -> Vec<u8> {
        let part = &content[..split_at];
        let mut archive = Vec::new();
        archive.extend_from_slice(b"Rar!\x1a\x07\x01\x00");
        archive.extend_from_slice(&rar5_header(1, 0, &rar5_vint(0x0001)));
        archive.extend_from_slice(&rar5_file_header(
            "001.png",
            content.len() as u64,
            0x0010, // SPLIT_AFTER
            None,
            part.len() as u64,
        ));
        archive.extend_from_slice(part);
        archive.extend_from_slice(&rar5_header(5, 0, &rar5_vint(0x0001)));
        archive
    }

    fn test_png() -> Vec<u8> {
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(10, 20)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        png.into_inner()
    }

    fn test_temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("moyu-opds-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
