//! OPDS 1.2 feed primitives. No network or credential storage is performed here.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use quick_xml::{
    events::{BytesStart, Event},
    name::ResolveResult,
    reader::NsReader,
    XmlVersion,
};
use std::io::Read;
use std::time::Duration;
use url::Url;
use zeroize::Zeroizing;

const ATOM_NS: &str = "http://www.w3.org/2005/Atom";
const MAX_FEED_BYTES: usize = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 2000;
const MAX_LINKS: usize = 32;

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
            agent: ureq::AgentBuilder::new()
                .try_proxy_from_env(false)
                .redirects(0)
                .timeout_connect(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
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
            let mut request = self.agent.get(current.as_str());
            if let Some(auth) = &self.authorization {
                request = request.set("Authorization", auth.as_str());
            }
            let response = match request.call() {
                Ok(response) | Err(ureq::Error::Status(_, response)) => response,
                Err(ureq::Error::Transport(_)) => return Err("OPDS connection failed"),
            };
            let status = response.status();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                if hop == 5 {
                    return Err("OPDS redirect limit");
                }
                let location = response
                    .header("Location")
                    .ok_or("OPDS redirect missing location")?;
                current = same_origin_link(&self.origin, &current, location)?;
                continue;
            }
            if !(200..300).contains(&status) {
                return Err("OPDS request failed");
            }
            let mut bytes = Vec::new();
            response
                .into_reader()
                .take((max_bytes as u64).saturating_add(1))
                .read_to_end(&mut bytes)
                .map_err(|_| "OPDS response read failed")?;
            if bytes.len() > max_bytes {
                return Err("OPDS resource too large");
            }
            return Ok((current, bytes));
        }
        Err("OPDS redirect limit")
    }

    pub(crate) fn feed(&self, target: &Url) -> Result<Feed, &'static str> {
        let (final_url, bytes) = self.fetch_with_final(target, MAX_FEED_BYTES)?;
        let xml = std::str::from_utf8(&bytes).map_err(|_| "invalid OPDS XML encoding")?;
        parse_feed(&self.origin, &final_url, xml)
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
    let target = base.join(href).map_err(|_| "invalid OPDS link")?;
    if !matches!(origin.scheme(), "http" | "https")
        || !origin.username().is_empty()
        || origin.password().is_some()
        || !matches!(target.scheme(), "http" | "https")
        || !target.username().is_empty()
        || target.password().is_some()
        || target.origin() != origin.origin()
    {
        return Err("OPDS link outside configured origin");
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(
            client.fetch(&root, 1024).unwrap_err(),
            "OPDS link outside configured origin"
        );
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
}
