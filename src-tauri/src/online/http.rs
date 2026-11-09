//! 阻塞 HTTP Transport：ureq + 代理 + 重试 + 响应大小上限。

use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use crate::online::{
    allow_loopback_for_dev, is_blocked_ip, validate_host_literal, validate_proxy, OnlineError,
    ONLINE_UA,
};
use crate::state::AssistedSessionRegistry;

/// 一次 HTTP 请求的最终结果（含重定向后的最终 URL）。
pub struct HttpResponse {
    pub status: u16,
    pub final_url: String,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

/// 页面/清单下载使用的同步传输抽象（便于测试替换）。
pub trait HttpTransport: Send + Sync {
    fn get(
        &self,
        url: &str,
        max_bytes: usize,
        referer: Option<&str>,
        header_scope: Option<&str>,
    ) -> Result<HttpResponse, OnlineError>;

    /// 只读取 `start` 之后的 `max_bytes` 字节（图片头部尺寸探测）。
    ///
    /// 默认实现退化为普通 GET，便于测试桩与自定义传输保持兼容；
    /// 生产 [`UreqTransport`] 会发送 `Range` 头并允许服务端截断响应。
    fn get_range(
        &self,
        url: &str,
        max_bytes: usize,
        referer: Option<&str>,
        header_scope: Option<&str>,
        start: u64,
    ) -> Result<HttpResponse, OnlineError> {
        let _ = start;
        self.get(url, max_bytes, referer, header_scope)
    }
}

/// 手动请求头：JSON 对象或单行 Cookie。
#[derive(Debug, Clone)]
pub struct RequestHeaders {
    values: Vec<(String, String)>,
}

/// Host/Content-Length/Connection/Transfer-Encoding 不允许由用户覆盖。
fn is_forbidden_header(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "host" | "content-length" | "connection" | "transfer-encoding"
    )
}

/// RFC 7230 token：字母/数字与 `!#$%&'*+-.^_`|~`，用于请求头名称校验。
fn is_token_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

impl RequestHeaders {
    /// 解析手动请求头；拒绝非法名称/CRLF 与 Host/Content-Length/Connection/Transfer-Encoding。
    pub fn parse(raw: &str) -> Result<Self, OnlineError> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Ok(Self { values: Vec::new() });
        }
        let values: Vec<(String, String)> = if raw.starts_with('{') {
            let map: std::collections::BTreeMap<String, String> = serde_json::from_str(raw)
                .map_err(|e| OnlineError::HeaderInvalid(format!("JSON 请求头无效：{e}")))?;
            map.into_iter().collect()
        } else {
            // 单行模式只接受 Cookie；若整行以禁用头名开头（如 Host: ...）直接拒绝。
            if let Some((name, _)) = raw.split_once(':') {
                if is_forbidden_header(name) {
                    return Err(OnlineError::HeaderInvalid(format!(
                        "不允许设置 {}",
                        name.trim()
                    )));
                }
            }
            // `Cookie:` 前缀大小写不敏感，输出统一为规范的 `Cookie`。
            let cookie = match raw.split_once(':') {
                Some((name, rest)) if name.trim().eq_ignore_ascii_case("cookie") => {
                    rest.trim().to_string()
                }
                _ => raw.to_string(),
            };
            vec![("Cookie".to_string(), cookie)]
        };
        for (k, v) in &values {
            if !is_token_name(k) || v.contains('\r') || v.contains('\n') {
                return Err(OnlineError::HeaderInvalid(
                    "请求头名称或值包含非法字符".into(),
                ));
            }
            if is_forbidden_header(k) {
                return Err(OnlineError::HeaderInvalid(format!("不允许设置 {k}")));
            }
        }
        Ok(Self { values })
    }

    fn has(&self, name: &str) -> bool {
        self.values
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case(name))
    }
}

/// ureq 阻塞传输实现。
pub struct UreqTransport {
    agent: ureq::Agent,
    proxy: Option<String>,
    resolver: Arc<HostResolver>,
    /// 代理配置存在且 NO_PROXY 命中时使用的直连 agent。
    direct_agent: Option<ureq::Agent>,
    /// 进程环境里的 NO_PROXY 规则（逗号/空白分隔，已去除 scheme/path）。
    no_proxy: Vec<String>,
    headers: RequestHeaders,
    /// 辅助会话注册表（进程内存）：命中已注册 origin 时复用该会话的 UA。
    /// `None` 表示没有辅助上下文，一律使用标准桌面 Chrome UA。
    assisted: Option<Arc<AssistedSessionRegistry>>,
    /// 仅 debug 测试/QA 通过环境变量放行回环；release 恒为 false。
    allow_loopback: bool,
}

type HostResolver = dyn Fn(&str, u16) -> std::io::Result<Vec<SocketAddr>> + Send + Sync;

struct RawResponse {
    status: u16,
    final_url: String,
    content_type: Option<String>,
    body: Vec<u8>,
    retry_after_s: Option<u64>,
    location: Option<String>,
}

struct PinnedTls {
    original_host: String,
    tls: Arc<rustls::ClientConfig>,
}

impl ureq::TlsConnector for PinnedTls {
    fn connect(
        &self,
        _address: &str,
        stream: Box<dyn ureq::ReadWrite>,
    ) -> Result<Box<dyn ureq::ReadWrite>, ureq::Error> {
        ureq::TlsConnector::connect(&self.tls, &self.original_host, stream)
    }
}

/// 最多跟随的重定向次数；第 6 个重定向响应视为错误。
const MAX_REDIRECTS: usize = 5;

/// 主机是否相同（大小写不敏感）。
fn same_host(a: &url::Url, b: &url::Url) -> bool {
    match (a.host_str(), b.host_str()) {
        (Some(x), Some(y)) => x.eq_ignore_ascii_case(y),
        _ => false,
    }
}

/// origin（scheme + host + port）是否相同；端口按 scheme 默认值归一。
fn same_origin(a: &url::Url, b: &url::Url) -> bool {
    a.scheme().eq_ignore_ascii_case(b.scheme())
        && same_host(a, b)
        && a.port_or_known_default() == b.port_or_known_default()
}

/// 解析导入源/整本书的 header scope；非法或非 http(s) 时返回 None（不发送用户头）。
fn parse_header_scope(raw: Option<&str>) -> Option<url::Url> {
    let u = url::Url::parse(raw?).ok()?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    if !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    Some(u)
}

/// 跨源时去掉 Referer 的 query 与 fragment，同源保持原样。
fn referer_value(target: &url::Url, page: &url::Url, scope: Option<&url::Url>) -> String {
    let same_referer = same_origin(target, page);
    let same_scope = scope.is_some_and(|s| same_origin(target, s));
    if same_referer && same_scope {
        page.to_string()
    } else {
        let mut u = page.clone();
        u.set_query(None);
        u.set_fragment(None);
        u.to_string()
    }
}

/// 归一化代理地址：小写 scheme；https 按 HTTP CONNECT 代理映射为 http；
/// 仅保留 http/socks5，并要求非空 host。
fn normalize_proxy(raw: &str) -> Result<Option<String>, OnlineError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    validate_proxy(raw).map_err(OnlineError::Proxy)?;
    let u = url::Url::parse(raw).map_err(|e| OnlineError::Proxy(format!("代理地址无效：{e}")))?;
    let scheme = match u.scheme() {
        "http" | "https" => "http",
        "socks5" => "socks5",
        other => {
            return Err(OnlineError::Proxy(format!(
                "代理仅支持 http/https/socks5，收到 {other}"
            )))
        }
    };
    let host = u
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| OnlineError::Proxy("代理地址缺少主机名".into()))?;
    Ok(Some(match (scheme, u.port_or_known_default()) {
        ("socks5", None) => format!("socks5://{host}"),
        (_, Some(port)) => format!("{scheme}://{host}:{port}"),
        (_, None) => format!("{scheme}://{host}"),
    }))
}

/// 进程环境里的 NO_PROXY（兼容全小写变量名）。
fn no_proxy_env() -> Option<String> {
    std::env::var_os("NO_PROXY")
        .or_else(|| std::env::var_os("no_proxy"))
        .map(|value| value.to_string_lossy().into_owned())
}

/// 拆分单条 NO_PROXY 规则：去 scheme/path、识别 `host:port` 与 `[v6]:port`。
fn normalize_no_proxy_rule(raw: &str) -> Option<String> {
    let mut rule = raw.trim().to_ascii_lowercase();
    if rule.is_empty() {
        return None;
    }
    if rule == "*" {
        return Some(rule);
    }
    if let Some((scheme, rest)) = rule.split_once("://") {
        // 带 scheme 的规则按 URL 处理，路径不属于主机。
        rule = if scheme == "http" || scheme == "https" {
            rest.split('/').next().unwrap_or(rest).to_string()
        } else {
            rest.to_string()
        };
    } else if rule.contains('/') {
        // 不支持 CIDR：带 `/` 的裸规则直接忽略，避免把网络前缀误当主机后缀。
        return None;
    }
    if rule.starts_with('[') {
        // [::1]:8080 → [::1]:8080（保留括号，匹配时同样按括号主机比较）
        return Some(rule);
    }
    // 只有一个冒号才按 host:port 处理；IPv6 字面量本身含多个冒号。
    if rule.matches(':').count() == 1 {
        if let Some((host, port)) = rule.rsplit_once(':') {
            if port.parse::<u16>().is_ok() && !host.is_empty() {
                return Some(format!("{host}:{port}"));
            }
        }
    }
    Some(rule)
}

fn parse_no_proxy(raw: &str) -> Vec<String> {
    raw.split(|c: char| c == ',' || c.is_whitespace())
        .filter_map(normalize_no_proxy_rule)
        .collect()
}

fn split_no_proxy_host_port(rule: &str) -> (&str, Option<u16>) {
    if rule.starts_with('[') {
        if let Some((host, tail)) = rule.split_once(']') {
            let port = tail
                .strip_prefix(':')
                .and_then(|value| value.parse::<u16>().ok());
            return (host.trim_start_matches('['), port);
        }
    }
    if rule.matches(':').count() == 1 {
        if let Some((host, port)) = rule.rsplit_once(':') {
            if let Ok(port) = port.parse::<u16>() {
                return (host, Some(port));
            }
        }
    }
    (rule, None)
}

/// NO_PROXY 匹配：`*` 全放行；域名规则同时匹配子域；带端口时必须同端口。
fn no_proxy_matches(host: &str, port: Option<u16>, rules: &[String]) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return false;
    }
    let host_lower = host.to_ascii_lowercase();
    for rule in rules {
        if rule == "*" {
            return true;
        }
        let (rule_host, rule_port) = split_no_proxy_host_port(rule);
        if let Some(rule_port) = rule_port {
            if port != Some(rule_port) {
                continue;
            }
        }
        let rule_host = rule_host.trim_start_matches("*.").trim_start_matches('.');
        if rule_host.is_empty() {
            continue;
        }
        if host_lower == rule_host || host_lower.ends_with(&format!(".{rule_host}")) {
            return true;
        }
    }
    false
}

/// 直连 agent 的连接层解析器。
///
/// 返回的地址**就是 ureq 真正要连接的地址**（它不会再解析一次），且每个地址都过
/// 可直连地址白名单。因此「先解析校验、连接时再解析」的
/// DNS 重绑定窗口在直连路径上不存在：攻击者域名第二次解析到私网也不会被连上。
fn direct_resolver(
    allow_loopback: bool,
) -> impl Fn(&str) -> std::io::Result<Vec<SocketAddr>> + Send + Sync + 'static {
    move |netloc: &str| {
        let addresses: Vec<SocketAddr> = netloc.to_socket_addrs()?.collect();
        acceptable_addresses(addresses, allow_loopback)
    }
}

fn build_agent(proxy: Option<&str>, allow_loopback: bool) -> Result<ureq::Agent, OnlineError> {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        // 关闭 ureq 自动重定向：手动跟随以便每个 hop 重新应用请求头。
        .redirects(0)
        .user_agent(ONLINE_UA);
    if proxy.is_none() {
        builder = builder.resolver(direct_resolver(allow_loopback));
    }
    if let Some(proxy) = proxy {
        let p = ureq::Proxy::new(proxy).map_err(|e| OnlineError::Proxy(e.to_string()))?;
        builder = builder.proxy(p);
    }
    Ok(builder.build())
}

/// 只保留**允许直连**的地址，并让公网 IPv4 排在前面。
///
/// 这里刻意不再采用「任一地址被拦就整体拒绝」：一个域名同时给出公网 IPv4
/// 与 ULA / link-local IPv6 时，整体拒绝会让本来可访问的站点彻底打不开
/// （v0.18.0 → v0.19.x 的在线直读回归）。
///
/// SSRF 防护没有削弱：返回的地址就是 ureq 真正会连接的地址，被拦掉的私网
/// 地址永远不会被连到；只有当**一个**可用地址都不存在时才 fail-closed。
fn acceptable_addresses(
    addresses: Vec<SocketAddr>,
    allow_loopback: bool,
) -> std::io::Result<Vec<SocketAddr>> {
    let mut acceptable: Vec<SocketAddr> = addresses
        .into_iter()
        .filter(|addr| !is_blocked_ip(addr.ip(), allow_loopback))
        .collect();
    if acceptable.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "no acceptable resolved address",
        ));
    }
    // 公网 IPv4 优先：SOCKS 适配器无法表达带方括号的 IPv6 目标，
    // 且漫画站点的 IPv4 可达性通常更稳。
    acceptable.sort_by_key(|addr| !addr.is_ipv4());
    Ok(acceptable)
}

impl UreqTransport {
    pub fn new(proxy: &str, headers: &str) -> Result<Self, OnlineError> {
        let proxy = normalize_proxy(proxy)?;
        let headers = RequestHeaders::parse(headers)?;
        let no_proxy = parse_no_proxy(no_proxy_env().as_deref().unwrap_or_default());
        let allow_loopback = allow_loopback_for_dev();
        let agent = build_agent(proxy.as_deref(), allow_loopback)?;
        // 只有真的配置了代理才需要直连分支；代理地址非法时上面已经拒绝。
        let direct_agent = if proxy.is_some() && !no_proxy.is_empty() {
            Some(build_agent(None, allow_loopback)?)
        } else {
            None
        };
        Ok(Self {
            agent,
            proxy,
            resolver: Arc::new(|host, port| {
                (host, port).to_socket_addrs().map(|addrs| addrs.collect())
            }),
            direct_agent,
            no_proxy,
            headers,
            assisted: None,
            allow_loopback,
        })
    }

    /// 按 NO_PROXY 选择代理/直连 agent；两条路径都保留同一超时与重定向策略。
    fn agent_for(&self, target: &url::Url) -> &ureq::Agent {
        let host = target.host_str().unwrap_or_default();
        if let Some(direct) = self.direct_agent.as_ref() {
            if no_proxy_matches(host, target.port_or_known_default(), &self.no_proxy) {
                return direct;
            }
        }
        &self.agent
    }

    /// 构造带辅助会话上下文的传输：请求目标命中已注册 origin 时复用该会话的 UA，
    /// 否则回落到标准桌面 Chrome UA。注册表只在内存里，绝不落库、绝不记日志。
    pub fn new_with_assisted(
        proxy: &str,
        headers: &str,
        assisted: Arc<AssistedSessionRegistry>,
    ) -> Result<Self, OnlineError> {
        let mut transport = Self::new(proxy, headers)?;
        transport.assisted = Some(assisted);
        Ok(transport)
    }

    /// 目标 origin 命中的辅助会话 UA；未命中返回 None（回落到标准桌面 Chrome UA）。
    ///
    /// UA 本身不是机密，可按 origin 复用；请求头仍只允许用户显式提供的那份。
    fn assisted_user_agent(&self, target: &url::Url) -> Option<String> {
        self.assisted
            .as_ref()
            .and_then(|registry| registry.user_agent_for_url(target))
    }

    /// 目标 origin 命中的辅助会话请求头（用户显式提供的那份）。
    ///
    /// **严格按 origin 绑定**：只有当初登记该请求头的站点才拿得到它，
    /// 其它站点一律不附带，避免上一站凭据泄漏到下一站。
    fn assisted_headers(&self, target: &url::Url) -> Option<String> {
        self.assisted
            .as_ref()
            .and_then(|registry| registry.headers_for_url(target))
    }

    /// 每一跳都校验目标：字面 IP/localhost + DNS 解析后的全部地址。
    /// 仅 debug/QA 的显式回环开关可放行 127.0.0.0/8 与 ::1；
    /// 私网、link-local、169.254.169.254、fc00::/7、fe80::/10 永远拒绝。
    fn validate_target(&self, target: &url::Url) -> Result<(), OnlineError> {
        let host = target
            .host_str()
            .filter(|host| !host.is_empty())
            .ok_or_else(|| OnlineError::Network("URL 缺少主机名（online-url-invalid）".into()))?;
        validate_host_literal(host, self.allow_loopback).map_err(OnlineError::Network)?;
        if host.parse::<IpAddr>().is_ok()
            || host.eq_ignore_ascii_case("localhost")
            || host.ends_with(".localhost")
        {
            return Ok(());
        }
        let port = target.port_or_known_default().unwrap_or(443);
        let addrs = (self.resolver)(host, port)
            .map_err(|_| OnlineError::Network("域名解析失败（online-fetch-failed）".into()))?;
        // 只要解析结果里存在**可直连**的公网地址就放行：域名同时给出
        // 公网 IPv4 与 ULA / link-local IPv6 时不能一刀切拒绝（v0.19.x 回归）。
        // 连接只会发生在这些已校验的地址上，私网地址不会被连到。
        let acceptable = acceptable_addresses(addrs, self.allow_loopback).map_err(|_| {
            OnlineError::Network(
                "目标域名只解析到本机/私网/链路本地地址，已拒绝（online-blocked-address）".into(),
            )
        })?;
        if acceptable.is_empty() {
            return Err(OnlineError::Network(
                "域名没有可用地址（online-fetch-failed）".into(),
            ));
        }
        Ok(())
    }

    /// 单次请求：应用手动请求头与派生的 Referer/Origin。
    /// 用户请求头只在目标与 header_scope 同 origin（scheme+host+port）时发送；
    /// 跨 origin 丢弃全部用户请求头（含 Cookie/Authorization/自定义密钥头），
    /// 只保留由页面 URL 派生的 Referer/Origin。
    ///
    /// User-Agent 另走辅助会话：目标 origin 命中已注册辅助会话时复用该会话的 UA，
    /// 未命中则沿用标准桌面 Chrome UA；用户显式提供的 UA 头优先。
    fn execute(
        &self,
        target: &url::Url,
        scope: Option<&url::Url>,
        max_bytes: usize,
        referer: Option<&str>,
        range: Option<(u64, u64)>,
        allow_truncate: bool,
    ) -> Result<RawResponse, OnlineError> {
        let within_scope = scope.is_some_and(|s| same_origin(target, s));
        let use_proxy = self.proxy.as_deref().filter(|_| {
            !no_proxy_matches(
                target.host_str().unwrap_or_default(),
                target.port_or_known_default(),
                &self.no_proxy,
            )
        });
        // A proxy resolves its own destination, independently of our DNS
        // preflight. Pass an already validated IP to the proxy while keeping
        // the original name for HTTP Host and TLS certificate verification.
        let pinned = if let Some(proxy) = use_proxy {
            let host = target.host_str().ok_or_else(|| {
                OnlineError::Network("URL 缺少主机名（online-url-invalid）".into())
            })?;
            let host = host.trim_start_matches('[').trim_end_matches(']');
            let port = target.port_or_known_default().unwrap_or(443);
            let addresses = (self.resolver)(host, port)
                .map_err(|_| OnlineError::Network("域名解析失败（online-fetch-failed）".into()))?;
            let addresses = acceptable_addresses(addresses, self.allow_loopback).map_err(|_| {
                OnlineError::Network("目标地址不允许访问（online-blocked-address）".into())
            })?;
            // ureq's SOCKS adapter treats bracketed IPv6 URL hosts as DNS
            // names. Never let the proxy resolve them again; prefer IPv4 and
            // fail closed for IPv6-only targets until the adapter supports it.
            let selected = if proxy.starts_with("socks5://") {
                addresses
                    .iter()
                    .find(|addr| addr.is_ipv4())
                    .ok_or_else(|| {
                        OnlineError::Network(
                            "SOCKS 代理暂不支持仅 IPv6 的目标（online-fetch-failed）".into(),
                        )
                    })?
            } else {
                addresses
                    .iter()
                    .find(|addr| addr.is_ipv4())
                    .unwrap_or(&addresses[0])
            };
            let mut pinned_url = target.clone();
            pinned_url
                .set_ip_host(selected.ip())
                .map_err(|_| OnlineError::Network("目标地址无效（online-url-invalid）".into()))?;
            let root_store = rustls::RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };
            let tls = Arc::new(
                rustls::ClientConfig::builder_with_provider(Arc::new(
                    rustls::crypto::ring::default_provider(),
                ))
                .with_safe_default_protocol_versions()
                .map_err(|_| OnlineError::Network("TLS 初始化失败（online-fetch-failed）".into()))?
                .with_root_certificates(root_store)
                .with_no_client_auth(),
            );
            let connector = Arc::new(PinnedTls {
                original_host: host.to_string(),
                tls,
            });
            let proxy = ureq::Proxy::new(proxy).map_err(|e| OnlineError::Proxy(e.to_string()))?;
            let agent = ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .redirects(0)
                .user_agent(ONLINE_UA)
                .proxy(proxy)
                .tls_connector(connector)
                .build();
            Some((agent, pinned_url))
        } else {
            None
        };
        let mut req = match pinned.as_ref() {
            Some((agent, url)) => agent.get(url.as_str()),
            None => self.agent_for(target).get(target.as_str()),
        };
        // 辅助会话请求头：只在目标 origin 与登记 origin 完全一致时附带。
        // 放在用户请求头之前，保证用户显式设置优先。
        if let Some(headers) = self.assisted_headers(target) {
            if let Ok(parsed) = RequestHeaders::parse(&headers) {
                for (k, v) in &parsed.values {
                    req = req.set(k, v);
                }
            }
        }
        if !self.headers.has("user-agent") {
            if let Some(user_agent) = self.assisted_user_agent(target) {
                req = req.set("User-Agent", &user_agent);
            }
        }
        if within_scope {
            for (k, v) in &self.headers.values {
                req = req.set(k, v);
            }
        }
        if let Some(page) = referer {
            if let Ok(u) = url::Url::parse(page) {
                if matches!(u.scheme(), "http" | "https") && u.host_str().is_some() {
                    // 跨 origin 时用户头已被丢弃，必须使用派生值；
                    // 同 origin 时显式配置的同名头优先。
                    if !within_scope || !self.headers.has("referer") {
                        req = req.set("Referer", &referer_value(target, &u, scope));
                    }
                    if !within_scope || !self.headers.has("origin") {
                        let origin = u.origin().ascii_serialization();
                        req = req.set("Origin", &origin);
                    }
                }
            }
        }
        if pinned.is_some() {
            req = req.set(
                "Host",
                &target[url::Position::BeforeHost..url::Position::AfterPort],
            );
        }
        if let Some((start, end)) = range {
            req = req.set("Range", &format!("bytes={start}-{end}"));
        }
        match req.call() {
            Ok(resp) => read_response(resp, target, max_bytes, allow_truncate),
            Err(ureq::Error::Status(_, resp)) => {
                read_response(resp, target, max_bytes, allow_truncate)
            }
            // Transport 的 Display/Debug 可能包含完整请求 URL/query，日志会经
            // `BackendError` 落到 `app.log`。只保留错误类别，避免泄漏查询串。
            Err(ureq::Error::Transport(t)) => {
                Err(OnlineError::Network(format!("传输失败（{:?}）", t.kind())))
            }
        }
    }

    /// 手动跟随 301/302/303/307/308；每一跳都按同一个 header_scope 判断
    /// （用户请求头只在同 origin 时发送，跨 origin 仅派生 Referer/Origin）。
    fn get_once(
        &self,
        url: &url::Url,
        max_bytes: usize,
        referer: Option<&str>,
        scope: Option<&url::Url>,
        range: Option<(u64, u64)>,
        allow_truncate: bool,
    ) -> Result<RawResponse, OnlineError> {
        let mut current = url.clone();
        for hop in 0..=MAX_REDIRECTS {
            self.validate_target(&current)?;
            let raw = self.execute(&current, scope, max_bytes, referer, range, allow_truncate)?;
            if !is_redirect(raw.status) {
                return Ok(raw);
            }
            if hop == MAX_REDIRECTS {
                return Err(OnlineError::Network(format!(
                    "重定向次数过多（上限 {MAX_REDIRECTS} 次）"
                )));
            }
            let location = raw
                .location
                .as_deref()
                .ok_or_else(|| OnlineError::Network("重定向缺少 Location".into()))?;
            let next = current
                .join(location)
                .map_err(|e| OnlineError::Network(format!("重定向地址无效：{e}")))?;
            if !matches!(next.scheme(), "http" | "https") {
                return Err(OnlineError::Network("重定向到非 HTTP(S) URL".into()));
            }
            // 重定向目标同样受输入约束：拒绝 userinfo 与超长 URL。
            if !next.username().is_empty() || next.password().is_some() {
                return Err(OnlineError::Network(
                    "重定向目标不能包含用户名或密码".into(),
                ));
            }
            if next.as_str().len() > 2048 {
                return Err(OnlineError::Network(
                    "重定向目标 URL 过长（上限 2048 字节）".into(),
                ));
            }
            current = next;
        }
        unreachable!("redirect loop always returns")
    }
}

/// 校验 URL 仅允许 http/https。
fn ensure_http_url(raw: &str) -> Result<url::Url, OnlineError> {
    let u = url::Url::parse(raw).map_err(|e| OnlineError::Network(format!("URL 无效：{e}")))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(OnlineError::Network("仅支持 http/https URL".into()));
    }
    validate_host_literal(u.host_str().unwrap_or_default(), allow_loopback_for_dev())
        .map_err(OnlineError::Network)?;
    Ok(u)
}

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn read_response(
    resp: ureq::Response,
    url: &url::Url,
    max_bytes: usize,
    allow_truncate: bool,
) -> Result<RawResponse, OnlineError> {
    let status = resp.status();
    let final_url = url.to_string();
    let location = resp.header("location").map(str::to_string);
    let content_type = resp.header("content-type").map(str::to_string);
    let retry_after_s = resp
        .header("retry-after")
        .and_then(|v| v.trim().parse::<u64>().ok());
    let mut body = Vec::new();
    let read_cap = if allow_truncate {
        max_bytes as u64
    } else {
        max_bytes.saturating_add(1) as u64
    };
    resp.into_reader()
        .take(read_cap)
        .read_to_end(&mut body)
        .map_err(|e| OnlineError::Network(e.to_string()))?;
    if !allow_truncate && body.len() > max_bytes {
        return Err(OnlineError::TooLarge(max_bytes));
    }
    Ok(RawResponse {
        status,
        final_url,
        content_type,
        body,
        retry_after_s,
        location,
    })
}

fn should_retry(status: u16) -> bool {
    matches!(status, 408 | 429 | 500 | 502 | 503 | 504)
}

impl HttpTransport for UreqTransport {
    fn get(
        &self,
        url: &str,
        max_bytes: usize,
        referer: Option<&str>,
        header_scope: Option<&str>,
    ) -> Result<HttpResponse, OnlineError> {
        let url = ensure_http_url(url)?;
        self.validate_target(&url)?;
        let scope = parse_header_scope(header_scope);
        for attempt in 0..=2u32 {
            match self.get_once(&url, max_bytes, referer, scope.as_ref(), None, false)? {
                raw if should_retry(raw.status) && attempt < 2 => {
                    let wait_ms = raw
                        .retry_after_s
                        .map(|s| s.saturating_mul(1000))
                        .unwrap_or(if attempt == 0 { 500 } else { 1500 })
                        .min(5000);
                    std::thread::sleep(Duration::from_millis(wait_ms));
                }
                raw => {
                    return Ok(HttpResponse {
                        status: raw.status,
                        final_url: raw.final_url,
                        content_type: raw.content_type,
                        body: raw.body,
                    });
                }
            }
        }
        unreachable!("retry loop always returns")
    }

    fn get_range(
        &self,
        url: &str,
        max_bytes: usize,
        referer: Option<&str>,
        header_scope: Option<&str>,
        start: u64,
    ) -> Result<HttpResponse, OnlineError> {
        let url = ensure_http_url(url)?;
        self.validate_target(&url)?;
        let scope = parse_header_scope(header_scope);
        let end = start.saturating_add(max_bytes as u64).saturating_sub(1);
        for attempt in 0..=2u32 {
            match self.get_once(
                &url,
                max_bytes,
                referer,
                scope.as_ref(),
                Some((start, end)),
                true,
            )? {
                raw if should_retry(raw.status) && attempt < 2 => {
                    let wait_ms = raw
                        .retry_after_s
                        .map(|s| s.saturating_mul(1000))
                        .unwrap_or(if attempt == 0 { 500 } else { 1500 })
                        .min(5000);
                    std::thread::sleep(Duration::from_millis(wait_ms));
                }
                raw => {
                    return Ok(HttpResponse {
                        status: raw.status,
                        final_url: raw.final_url,
                        content_type: raw.content_type,
                        body: raw.body,
                    });
                }
            }
        }
        unreachable!("retry loop always returns")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn connection_resolver_rejects_rebound_and_mixed_private_addresses() {
        let public = "8.8.8.8:443".parse().unwrap();
        let private = "192.168.1.1:443".parse().unwrap();
        assert!(super::acceptable_addresses(vec![public], false).is_ok());
        assert!(super::acceptable_addresses(vec![private], false).is_err());
        // 混合解析结果：只要有公网地址就放行，并只把公网地址交给连接层。
        let mixed = super::acceptable_addresses(vec![public, private], false).expect("mixed");
        assert_eq!(mixed, vec![public]);
        assert!(super::acceptable_addresses(vec![], false).is_err());
    }

    /// 回归：域名同时给出公网 IPv4 与 ULA / link-local IPv6 时，
    /// 必须优先用公网 IPv4 正常连接，绝不能因为那条 IPv6 记录就整体拒绝。
    #[test]
    fn mixed_a_and_aaaa_keeps_the_public_ipv4() {
        let public_v4: SocketAddr = "203.0.113.10:443".parse().unwrap();
        let ula: SocketAddr = "[fd00::1]:443".parse().unwrap();
        let link_local: SocketAddr = "[fe80::1]:443".parse().unwrap();
        for extra in [ula, link_local] {
            let accepted =
                super::acceptable_addresses(vec![extra, public_v4], false).expect("public v4 wins");
            assert_eq!(
                accepted,
                vec![public_v4],
                "only the public IPv4 may reach the connection layer",
            );
        }
    }

    /// 公网 IPv4 与公网 IPv6 并存时，IPv4 排在前面：SOCKS 适配器无法表达
    /// 带方括号的 IPv6 目标，且 IPv4 可达性在漫画站点上更稳。
    #[test]
    fn public_ipv4_is_preferred_over_public_ipv6() {
        let public_v4: SocketAddr = "203.0.113.10:443".parse().unwrap();
        let public_v6: SocketAddr = "[2001:db8::1]:443".parse().unwrap();
        let accepted =
            super::acceptable_addresses(vec![public_v6, public_v4], false).expect("both usable");
        assert_eq!(accepted, vec![public_v4, public_v6]);
    }
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread::JoinHandle;

    /// 直连解析器：返回给 ureq 的地址就是校验通过的地址（netloc 形式的 IP 字面量
    /// 不触发 DNS，测试可离线、确定），不存在「校验后再解析」的第二次机会。
    #[test]
    fn direct_resolver_returns_only_validated_connection_addresses() {
        assert_eq!(
            direct_resolver(false)("8.8.8.8:443").unwrap(),
            vec!["8.8.8.8:443".parse().unwrap()]
        );
        for blocked in [
            "127.0.0.1:80",
            "[::1]:443",
            "169.254.169.254:80",
            "10.0.0.5:8080",
            "192.168.1.1:443",
            "0.0.0.0:443",
        ] {
            let err = direct_resolver(false)(blocked).unwrap_err();
            assert_eq!(
                err.kind(),
                std::io::ErrorKind::PermissionDenied,
                "{blocked} 必须在连接层被拒绝"
            );
        }
        // 回环只在 debug/QA 显式放行时可用。
        assert!(direct_resolver(true)("127.0.0.1:80").is_ok());
    }

    /// 直连 agent 必须真的装上上面的解析器：即使本地有监听、目标可达，
    /// 校验失败时也不得建立 TCP 连接（DNS 重绑定防线是否接线的回归点）。
    #[test]
    fn direct_agent_validates_the_address_it_actually_connects_to() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let agent = build_agent(None, false).unwrap();
        assert!(agent.get(&format!("http://{address}/")).call().is_err());
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock,
            "校验失败时不得发起 TCP 连接"
        );

        // 显式放行回环时才真正连上（对照组，排除环境因素）。
        listener.set_nonblocking(false).unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });
        let agent = build_agent(None, true).unwrap();
        let body = agent
            .get(&format!("http://{address}/"))
            .call()
            .unwrap()
            .into_string()
            .unwrap();
        assert_eq!(body, "ok");
        server.join().unwrap();
    }

    #[test]
    fn proxy_dns_rebinding_is_rejected_before_contacting_proxy() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let mut transport = UreqTransport::new(&format!("http://{address}"), "").unwrap();
        transport.no_proxy.clear();
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        transport.resolver = Arc::new(move |_, port| {
            let ip = if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                "8.8.8.8"
            } else {
                "192.168.1.1"
            };
            Ok(vec![SocketAddr::new(ip.parse().unwrap(), port)])
        });
        let target = url::Url::parse("http://rebind.example/page").unwrap();
        assert!(transport
            .get_once(&target, 1024, None, None, None, false)
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn socks_ipv6_only_target_fails_before_contacting_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let mut transport = UreqTransport::new(&format!("socks5://{address}"), "").unwrap();
        transport.no_proxy.clear();
        transport.resolver = Arc::new(|_, port| {
            Ok(vec![SocketAddr::new(
                "2606:4700:4700::1111".parse().unwrap(),
                port,
            )])
        });
        let target = url::Url::parse("http://ipv6-only.example/page").unwrap();
        assert!(transport
            .get_once(&target, 1024, None, None, None, false)
            .is_err());
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    /// 本地隔离复现「仅 IPv6 目标」为什么必须 fail closed：
    /// `url::Url::host_str()` 对 IPv6 带方括号，ureq 2.x 的 SOCKS 适配层
    /// `Ipv6Addr::from_str("[…]")` 失败后按**域名**下发，代理只能去 DNS 解析
    /// 这个带括号的串；我们也不会把未校验的域名交给代理重新解析。
    /// 上游适配层支持 IPv6 ATYP 后，本用例会失败并提示移除 fail-closed 分支。
    #[test]
    fn socks5_upstream_cannot_express_bracketed_ipv6_targets() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let observed = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut greeting = [0u8; 2];
            socket.read_exact(&mut greeting).unwrap();
            let mut methods = vec![0u8; greeting[1] as usize];
            socket.read_exact(&mut methods).unwrap();
            socket.write_all(&[5, 0]).unwrap();
            let mut head = [0u8; 4];
            socket.read_exact(&mut head).unwrap();
            let mut dest = Vec::new();
            match head[3] {
                1 => {
                    let mut buf = [0u8; 6];
                    socket.read_exact(&mut buf).unwrap();
                    dest.extend_from_slice(&buf);
                }
                3 => {
                    let mut len = [0u8; 1];
                    socket.read_exact(&mut len).unwrap();
                    let mut buf = vec![0u8; len[0] as usize + 2];
                    socket.read_exact(&mut buf).unwrap();
                    dest.extend_from_slice(&buf);
                }
                4 => {
                    let mut buf = [0u8; 18];
                    socket.read_exact(&mut buf).unwrap();
                    dest.extend_from_slice(&buf);
                }
                other => panic!("unexpected SOCKS ATYP {other}"),
            }
            (head[3], dest)
        });
        let proxy = ureq::Proxy::new(format!("socks5://{address}")).unwrap();
        let agent = ureq::AgentBuilder::new().proxy(proxy).build();
        let _ = agent.get("http://[2606:4700:4700::1111]/").call();
        let (atyp, dest) = observed.join().unwrap();
        let name = String::from_utf8_lossy(&dest[..dest.len().saturating_sub(2)]).to_string();
        assert_eq!(atyp, 3, "ATYP 3 = 域名（而非 IPv6 0x04）");
        assert!(
            name.starts_with('['),
            "上游把带括号的 IPv6 字面量当域名下发：{name}"
        );
    }

    #[test]
    fn http_proxy_receives_validated_ip_and_original_host() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0u8; 1];
            while !bytes.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 8192);
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
            String::from_utf8(bytes).unwrap()
        });
        let mut transport = UreqTransport::new(&format!("http://{proxy_address}"), "").unwrap();
        transport.allow_loopback = true;
        transport.no_proxy.clear();
        let target = url::Url::parse("http://localhost:9876/book?x=1").unwrap();
        let response = transport
            .execute(&target, None, 1024, None, None, false)
            .unwrap();
        assert_eq!(response.body, b"ok");
        let request = server.join().unwrap().to_ascii_lowercase();
        assert!(
            request.starts_with("get http://127.0.0.1:9876/book?x=1 ")
                || request.starts_with("get http://[::1]:9876/book?x=1 "),
            "{request}"
        );
        assert!(
            request.contains("\r\nhost: localhost:9876\r\n"),
            "{request}"
        );
    }

    #[test]
    fn range_execute_sends_exact_byte_range_and_accepts_truncation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0u8; 1];
            while !bytes.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 8192);
            }
            socket
                .write_all(
                    b"HTTP/1.1 206 Partial Content\r\nContent-Length: 2\r\nContent-Range: bytes 5-6/10\r\nConnection: close\r\n\r\nok",
                )
                .unwrap();
            String::from_utf8(bytes).unwrap().to_ascii_lowercase()
        });
        let mut transport = UreqTransport::new("", "").unwrap();
        transport.allow_loopback = true;
        transport.no_proxy.clear();
        let target = url::Url::parse(&format!("http://{address}/image.jpg")).unwrap();
        let response = transport
            .execute(&target, None, 2, None, Some((5, 6)), true)
            .unwrap();
        assert_eq!(response.status, 206);
        assert_eq!(response.body, b"ok");
        let request = server.join().unwrap();
        assert!(request.contains("\r\nrange: bytes=5-6\r\n"), "{request}");
    }

    #[test]
    fn socks5_proxy_receives_an_ip_instead_of_a_hostname() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut greeting = [0; 2];
            socket.read_exact(&mut greeting).unwrap();
            assert_eq!(greeting[0], 5);
            let mut methods = vec![0; greeting[1] as usize];
            socket.read_exact(&mut methods).unwrap();
            socket.write_all(&[5, 0]).unwrap();
            let mut command = [0; 4];
            socket.read_exact(&mut command).unwrap();
            assert_eq!(&command[..3], &[5, 1, 0]);
            let addr_len = match command[3] {
                1 => 4,
                4 => 16,
                _ => panic!("proxy received a hostname"),
            };
            let mut dest = vec![0; addr_len + 2];
            socket.read_exact(&mut dest).unwrap();
            socket.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() < 8192);
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
            String::from_utf8(request).unwrap()
        });
        let mut transport = UreqTransport::new(&format!("socks5://{address}"), "").unwrap();
        transport.allow_loopback = true;
        transport.no_proxy.clear();
        let target = url::Url::parse("http://localhost:9876/book").unwrap();
        assert_eq!(
            transport
                .execute(&target, None, 1024, None, None, false)
                .unwrap()
                .body,
            b"ok"
        );
        assert!(server
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("\r\nhost: localhost:9876\r\n"));
    }

    #[test]
    fn pinned_tls_verifies_and_sends_the_original_server_name() {
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let der = cert.cert.der().clone();
        let key = rustls::pki_types::PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der());
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let server_config = rustls::ServerConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![der.clone()], key.into())
            .unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(der).unwrap();
        let client_config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut connect = Vec::new();
            let mut byte = [0u8; 1];
            while !connect.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                connect.push(byte[0]);
                assert!(connect.len() < 8192);
            }
            assert!(String::from_utf8(connect)
                .unwrap()
                .starts_with("CONNECT 127.0.0.1:9876 "));
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .unwrap();
            let connection = rustls::ServerConnection::new(Arc::new(server_config)).unwrap();
            let mut tls = rustls::StreamOwned::new(connection, socket);
            let mut request = [0u8; 1024];
            assert!(tls.read(&mut request).unwrap() > 0);
            let server_name = tls.conn.server_name().map(str::to_string);
            tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
            tls.flush().unwrap();
            server_name
        });
        let connector = Arc::new(PinnedTls {
            original_host: "localhost".into(),
            tls: Arc::new(client_config),
        });
        let proxy = ureq::Proxy::new(format!("http://{address}")).unwrap();
        let agent = ureq::AgentBuilder::new()
            .proxy(proxy)
            .tls_connector(connector)
            .build();
        let response = agent.get("https://127.0.0.1:9876/").call().unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(server.join().unwrap().as_deref(), Some("localhost"));
    }

    #[test]
    fn no_proxy_rules_match_exact_subdomain_port_and_wildcard() {
        let rules =
            parse_no_proxy("example.com, .internal.test, https://secure.test/path, api.test:8443");
        assert!(no_proxy_matches("example.com", Some(443), &rules));
        assert!(no_proxy_matches("cdn.example.com", Some(443), &rules));
        assert!(!no_proxy_matches("notexample.com", Some(443), &rules));
        assert!(no_proxy_matches("db.internal.test", Some(443), &rules));
        assert!(no_proxy_matches("secure.test", Some(443), &rules));
        assert!(no_proxy_matches("api.test", Some(8443), &rules));
        assert!(!no_proxy_matches("api.test", Some(443), &rules));

        let wildcard = parse_no_proxy("*");
        assert!(no_proxy_matches("anything.example", None, &wildcard));
        let none = parse_no_proxy("");
        assert!(!no_proxy_matches("example.com", None, &none));
        // CIDR 不做半吊子解析，宁可忽略也不误放行。
        assert!(parse_no_proxy("10.0.0.0/8").is_empty());
    }

    fn spawn_server(responses: Vec<(u16, &'static str, Vec<u8>)>) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            for (status, ct, body) in responses {
                let (mut s, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                let reason = match status {
                    200 => "OK",
                    404 => "Not Found",
                    408 => "Request Timeout",
                    429 => "Too Many Requests",
                    503 => "Service Unavailable",
                    _ => "Error",
                };
                let headers = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nRetry-After: 0\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                s.write_all(headers.as_bytes()).unwrap();
                s.write_all(&body).unwrap();
            }
        });
        (format!("http://{addr}/page"), h)
    }

    #[test]
    fn reads_200_and_preserves_404_status() {
        let (url, h) = spawn_server(vec![
            (200, "image/png", b"png-bytes".to_vec()),
            (404, "text/plain", b"missing".to_vec()),
        ]);
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&url, 1024, None, None).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.content_type.as_deref(), Some("image/png"));
        assert_eq!(r.body, b"png-bytes");
        let r = t.get(&url, 1024, None, None).unwrap();
        assert_eq!(r.status, 404);
        assert_eq!(r.body, b"missing");
        h.join().unwrap();
    }

    #[test]
    fn retries_429_then_succeeds() {
        let (url, h) = spawn_server(vec![
            (429, "text/plain", b"slow".to_vec()),
            (200, "image/png", b"ok".to_vec()),
        ]);
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&url, 1024, None, None).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"ok");
        h.join().unwrap();
    }

    #[test]
    fn transport_rejects_private_and_metadata_literals() {
        let t = UreqTransport::new("", "").unwrap();
        for url in [
            "http://10.0.0.1/x",
            "http://192.168.1.1/x",
            "http://169.254.169.254/latest/meta-data",
            "http://[fc00::1]/x",
        ] {
            assert!(t.get(url, 1024, None, None).is_err(), "必须拒绝：{url}");
        }
        assert!(ensure_http_url("http://169.254.169.254/").is_err());
        // 单元测试/debug QA 显式放行 loopback 夹具。
        assert!(ensure_http_url("http://127.0.0.1:1/").is_ok());
    }

    #[test]
    fn retries_408_then_succeeds() {
        let (url, h) = spawn_server(vec![
            (408, "text/plain", b"timeout".to_vec()),
            (200, "image/png", b"ok".to_vec()),
        ]);
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&url, 1024, None, None).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"ok");
        h.join().unwrap();
    }

    #[test]
    fn retries_503_then_succeeds() {
        let (url, h) = spawn_server(vec![
            (503, "text/plain", b"busy".to_vec()),
            (200, "image/png", b"ok".to_vec()),
        ]);
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&url, 1024, None, None).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"ok");
        h.join().unwrap();
    }

    #[test]
    fn retry_exhaustion_returns_last_503() {
        let (url, h) = spawn_server(vec![
            (503, "text/plain", b"first".to_vec()),
            (503, "text/plain", b"second".to_vec()),
            (503, "text/plain", b"third".to_vec()),
        ]);
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&url, 1024, None, None).unwrap();
        assert_eq!(r.status, 503);
        assert_eq!(r.body, b"third");
        h.join().unwrap();
    }

    #[test]
    fn rejects_body_larger_than_limit() {
        let (url, h) = spawn_server(vec![(200, "image/png", vec![0u8; 16])]);
        let t = UreqTransport::new("", "").unwrap();
        assert!(matches!(
            t.get(&url, 8, None, None),
            Err(OnlineError::TooLarge(8))
        ));
        h.join().unwrap();
    }

    #[test]
    fn rejects_invalid_proxy() {
        assert!(UreqTransport::new("ftp://127.0.0.1:21", "").is_err());
        assert!(UreqTransport::new("http://user:pass@127.0.0.1:7890", "").is_err());
        assert!(UreqTransport::new("socks5://", "").is_err());
        assert!(UreqTransport::new("socks5://:1080", "").is_err());
        assert!(UreqTransport::new("http://", "").is_err());
    }

    #[test]
    fn accepts_supported_proxy_forms() {
        assert!(UreqTransport::new("http://127.0.0.1:7890", "").is_ok());
        assert!(UreqTransport::new("socks5://127.0.0.1:1080", "").is_ok());
        // 大写 scheme 与 https（按 HTTP CONNECT 代理处理）必须在构造期归一化。
        assert!(UreqTransport::new("HTTPS://127.0.0.1:7890", "").is_ok());
        assert_eq!(
            normalize_proxy("HTTPS://127.0.0.1:7890")
                .unwrap()
                .as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            normalize_proxy("socks5://127.0.0.1:1080")
                .unwrap()
                .as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
    }

    #[test]
    fn rejects_non_http_url_without_network() {
        let t = UreqTransport::new("", "").unwrap();
        assert!(matches!(
            t.get("file:///C:/a.png", 1024, None, None),
            Err(OnlineError::Network(_))
        ));
        assert!(ensure_http_url("https://example.com/a.png").is_ok());
    }

    fn spawn_redirect() -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let (mut s, _) = listener.accept().unwrap();
            let n = s.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(req.starts_with("GET /start "), "{req}");
            assert!(req.contains("Cookie: sid=abc"), "{req}");
            assert!(req.contains("Referer: http://gallery.example/g/1"), "{req}");
            s.write_all(
                b"HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
            let (mut s2, _) = listener.accept().unwrap();
            let n = s2.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(req.starts_with("GET /final "), "{req}");
            assert!(req.contains("Cookie: sid=abc"), "{req}");
            assert!(req.contains("Referer: http://gallery.example/g/1"), "{req}");
            s2.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            )
            .unwrap();
        });
        (format!("http://{addr}/start"), h)
    }

    #[test]
    fn follows_redirect_and_reports_final_url() {
        let (url, h) = spawn_redirect();
        let t = UreqTransport::new("", "Cookie: sid=abc").unwrap();
        let r = t
            .get(
                &url,
                1024,
                Some("http://gallery.example/g/1"),
                Some(url.as_str()),
            )
            .unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"ok");
        assert!(r.final_url.ends_with("/final"), "{}", r.final_url);
        h.join().unwrap();
    }

    /// 有界 accept：监听非阻塞 + 截止时间，避免实现异常时测试永久挂起。
    fn accept_bounded(listener: &TcpListener) -> std::net::TcpStream {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        listener.set_nonblocking(true).unwrap();
        loop {
            match listener.accept() {
                Ok((s, _)) => {
                    s.set_nonblocking(false).unwrap();
                    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    s.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
                    return s;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(std::time::Instant::now() < deadline, "等待客户端请求超时");
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("accept 失败：{e}"),
            }
        }
    }

    /// 只处理一次请求的 loopback hop；可返回 302 或 200，并回传收到的原始请求。
    fn spawn_hop(redirect_to: Option<String>) -> (String, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let mut s = accept_bounded(&listener);
            let mut buf = [0u8; 8192];
            let n = s.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            match redirect_to {
                Some(location) => {
                    let resp = format!(
                        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    s.write_all(resp.as_bytes()).unwrap();
                }
                None => {
                    s.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )
                    .unwrap();
                }
            }
            req
        });
        (format!("http://{addr}/start"), h)
    }

    /// 同源两跳：/start 302 → /final，回传第二跳的原始请求。
    fn spawn_same_origin_redirect() -> (String, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut first = accept_bounded(&listener);
            let n = first.read(&mut buf).unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /start "));
            first
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            let mut second = accept_bounded(&listener);
            let n = second.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            second
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
            req
        });
        (format!("http://{addr}/start"), h)
    }

    /// 读取原始请求中的指定请求头（名称大小写不敏感）。
    fn header_value<'a>(req: &'a str, name: &str) -> Option<&'a str> {
        req.lines().find_map(|line| {
            let (k, v) = line.split_once(':')?;
            if k.eq_ignore_ascii_case(name) {
                Some(v.trim())
            } else {
                None
            }
        })
    }

    const CREDENTIAL_HEADERS: &str = r#"{"Cookie":"sid=abc","Authorization":"Bearer secret","X-Test":"yes","X-Api-Key":"secret-key"}"#;

    #[test]
    fn redirect_same_host_other_port_drops_all_user_headers() {
        // 同主机不同端口即跨 origin：所有用户请求头都不得重放。
        let (target_url, target_h) = spawn_hop(None);
        let (start_url, start_h) = spawn_hop(Some(target_url));
        let t = UreqTransport::new("", CREDENTIAL_HEADERS).unwrap();
        let r = t
            .get(&start_url, 1024, None, Some(start_url.as_str()))
            .unwrap();
        assert_eq!(r.status, 200);
        let first = start_h.join().unwrap();
        assert_eq!(header_value(&first, "cookie"), Some("sid=abc"));
        assert_eq!(header_value(&first, "authorization"), Some("Bearer secret"));
        assert_eq!(header_value(&first, "x-api-key"), Some("secret-key"));
        let second = target_h.join().unwrap();
        assert_eq!(header_value(&second, "cookie"), None, "{second}");
        assert_eq!(header_value(&second, "authorization"), None, "{second}");
        assert_eq!(header_value(&second, "x-test"), None, "{second}");
        assert_eq!(header_value(&second, "x-api-key"), None, "{second}");
    }

    #[test]
    fn redirect_cross_host_drops_all_user_headers() {
        // 127.0.0.1 → localhost 视为跨主机：Cookie、Authorization 与自定义头都丢弃。
        let (target_url, target_h) = spawn_hop(None);
        let port = url::Url::parse(&target_url).unwrap().port().unwrap();
        let (start_url, start_h) = spawn_hop(Some(format!("http://localhost:{port}/final")));
        let t = UreqTransport::new("", CREDENTIAL_HEADERS).unwrap();
        let r = t
            .get(&start_url, 1024, None, Some(start_url.as_str()))
            .unwrap();
        assert_eq!(r.status, 200);
        let first = start_h.join().unwrap();
        assert_eq!(header_value(&first, "cookie"), Some("sid=abc"));
        assert_eq!(header_value(&first, "authorization"), Some("Bearer secret"));
        assert_eq!(header_value(&first, "x-api-key"), Some("secret-key"));
        let second = target_h.join().unwrap();
        assert_eq!(header_value(&second, "cookie"), None, "{second}");
        assert_eq!(header_value(&second, "authorization"), None, "{second}");
        assert_eq!(header_value(&second, "x-test"), None, "{second}");
        assert_eq!(header_value(&second, "x-api-key"), None, "{second}");
    }

    #[test]
    fn redirect_cross_host_drops_api_key() {
        // 自定义密钥头（X-Api-Key）跨主机时同样不得重放。
        let (target_url, target_h) = spawn_hop(None);
        let port = url::Url::parse(&target_url).unwrap().port().unwrap();
        let (start_url, start_h) = spawn_hop(Some(format!("http://localhost:{port}/final")));
        let t = UreqTransport::new("", r#"{"X-Api-Key":"secret-key"}"#).unwrap();
        let r = t
            .get(&start_url, 1024, None, Some(start_url.as_str()))
            .unwrap();
        assert_eq!(r.status, 200);
        let first = start_h.join().unwrap();
        assert_eq!(header_value(&first, "x-api-key"), Some("secret-key"));
        let second = target_h.join().unwrap();
        assert_eq!(header_value(&second, "x-api-key"), None, "{second}");
    }

    #[test]
    fn redirect_same_origin_keeps_cookie_and_authorization() {
        let (url, h) = spawn_same_origin_redirect();
        let t = UreqTransport::new("", CREDENTIAL_HEADERS).unwrap();
        let r = t.get(&url, 1024, None, Some(url.as_str())).unwrap();
        assert_eq!(r.status, 200);
        let second = h.join().unwrap();
        assert_eq!(header_value(&second, "cookie"), Some("sid=abc"));
        assert_eq!(
            header_value(&second, "authorization"),
            Some("Bearer secret")
        );
        assert_eq!(header_value(&second, "x-test"), Some("yes"));
        assert_eq!(header_value(&second, "x-api-key"), Some("secret-key"));
    }

    #[test]
    fn rejects_redirect_target_with_userinfo() {
        let (start_url, h) = spawn_hop(Some("http://user:pass@127.0.0.1:1/final".into()));
        let t = UreqTransport::new("", "").unwrap();
        let msg = match t.get(&start_url, 1024, None, None) {
            Ok(_) => panic!("重定向目标含 userinfo 时应报错"),
            Err(OnlineError::Network(msg)) => msg,
            Err(other) => panic!("unexpected error: {other}"),
        };
        assert!(msg.contains("用户名或密码"), "{msg}");
        h.join().unwrap();
    }

    /// 重定向的每一跳都要重新校验：首跳成功不代表后续 hop 可以打到云元数据地址。
    #[test]
    fn redirect_hop_to_metadata_address_is_rejected() {
        let (start_url, h) = spawn_hop(Some("http://169.254.169.254/latest/meta-data/".into()));
        let mut t = UreqTransport::new("", "").unwrap();
        t.allow_loopback = true;
        let msg = match t.get(&start_url, 1024, None, None) {
            Ok(_) => panic!("重定向到云元数据地址时必须报错"),
            Err(OnlineError::Network(msg)) => msg,
            Err(other) => panic!("unexpected error: {other}"),
        };
        h.join().unwrap();
        assert!(msg.contains("online-blocked-address"), "{msg}");
    }

    #[test]
    fn rejects_overlong_redirect_target() {
        let target = format!("http://127.0.0.1:1/{}", "a".repeat(2100));
        let (start_url, h) = spawn_hop(Some(target));
        let t = UreqTransport::new("", "").unwrap();
        let msg = match t.get(&start_url, 1024, None, None) {
            Ok(_) => panic!("重定向目标超长时应报错"),
            Err(OnlineError::Network(msg)) => msg,
            Err(other) => panic!("unexpected error: {other}"),
        };
        assert!(msg.contains("2048 字节"), "{msg}");
        h.join().unwrap();
    }

    #[test]
    fn rejects_more_than_five_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            for _ in 0..6 {
                let (mut s, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                s.write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: /loop\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            }
        });
        let t = UreqTransport::new("", "").unwrap();
        let err = match t.get(&format!("http://{addr}/loop"), 1024, None, None) {
            Ok(_) => panic!("超过 5 次重定向应报错"),
            Err(OnlineError::Network(msg)) => msg,
            Err(other) => panic!("unexpected error: {other}"),
        };
        assert!(err.contains("重定向"), "{err}");
        h.join().unwrap();
    }

    #[test]
    fn transport_failure_message_excludes_url_and_query() {
        // 预留 loopback 端口后立即释放，保证连接被拒绝；不访问公网。
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let t = UreqTransport::new("", "").unwrap();
        let url = format!("http://127.0.0.1:{port}/x?token=secret");
        let msg = match t.get(&url, 1024, None, None) {
            Ok(_) => panic!("连接被拒绝时应返回错误"),
            Err(OnlineError::Network(msg)) => msg,
            Err(other) => panic!("unexpected error: {other}"),
        };
        assert!(msg.starts_with("传输失败（"), "{msg}");
        assert!(!msg.contains("token=secret"), "{msg}");
        assert!(!msg.contains("/x?"), "{msg}");
    }

    #[test]
    fn parses_headers_and_rejects_forbidden() {
        assert!(RequestHeaders::parse("").is_ok());
        assert!(RequestHeaders::parse("Cookie: a=b").is_ok());
        assert!(RequestHeaders::parse("a=b").is_ok());
        assert!(RequestHeaders::parse(r#"{"Authorization":"Bearer x"}"#).is_ok());
        assert!(RequestHeaders::parse("Host: example.com").is_err());
        assert!(RequestHeaders::parse("content-length: 1").is_err());
        assert!(RequestHeaders::parse("Connection: keep-alive").is_err());
        assert!(RequestHeaders::parse("Transfer-Encoding: chunked").is_err());
        assert!(RequestHeaders::parse("X-Test: a\r\nInjected: b").is_err());
        assert!(RequestHeaders::parse("{\"X\\r\\nInjected\":\"b\"}").is_err());
        assert!(RequestHeaders::parse(r#"{"":"x"}"#).is_err());
        assert!(RequestHeaders::parse("{not-json}").is_err());
        // 请求头名称必须是 RFC 7230 token：空格、控制符、分隔符均拒绝。
        assert!(RequestHeaders::parse(r#"{"Bad Name":"x"}"#).is_err());
        assert!(RequestHeaders::parse("{\"X\\tY\":\"x\"}").is_err());
        assert!(RequestHeaders::parse(r#"{"X@Y":"x"}"#).is_err());
        assert!(RequestHeaders::parse(r#"{"X[Y":"x"}"#).is_err());
    }

    fn spawn_header_server(expected: &'static [&'static str]) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let n = s.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]);
            let ok = expected.iter().all(|e| req.contains(e));
            let resp = if ok {
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
            } else {
                "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            };
            s.write_all(resp.as_bytes()).unwrap();
        });
        (format!("http://{addr}/x"), h)
    }

    #[test]
    fn sends_custom_headers_and_referer() {
        let (url, h) = spawn_header_server(&[
            "X-Test: yes",
            "Referer: http://gallery.example/g/1",
            "Origin: http://gallery.example",
        ]);
        let t = UreqTransport::new("", r#"{"X-Test":"yes"}"#).unwrap();
        let r = t
            .get(
                &url,
                1024,
                Some("http://gallery.example/g/1"),
                Some(url.as_str()),
            )
            .unwrap();
        assert_eq!(r.status, 200);
        h.join().unwrap();
    }

    #[test]
    fn cookie_prefix_strip_is_case_insensitive() {
        assert_eq!(
            RequestHeaders::parse("CoOkIe: sid=xyz").unwrap().values,
            vec![("Cookie".to_string(), "sid=xyz".to_string())]
        );
        // 线上请求头也必须是规范的 `Cookie` 名与去掉前缀后的值。
        let (url, h) = spawn_header_server(&["Cookie: sid=xyz"]);
        let t = UreqTransport::new("", "COOKIE: sid=xyz").unwrap();
        let r = t.get(&url, 1024, None, Some(url.as_str())).unwrap();
        assert_eq!(r.status, 200);
        h.join().unwrap();
    }

    #[test]
    fn explicit_referer_and_origin_win() {
        let (url, h) = spawn_header_server(&[
            "Referer: http://mine.example/page",
            "Origin: http://mine.example",
        ]);
        let t = UreqTransport::new(
            "",
            r#"{"Referer":"http://mine.example/page","Origin":"http://mine.example"}"#,
        )
        .unwrap();
        let r = t
            .get(
                &url,
                1024,
                Some("http://gallery.example/g/1"),
                Some(url.as_str()),
            )
            .unwrap();
        assert_eq!(r.status, 200);
        h.join().unwrap();
    }

    #[test]
    fn same_scope_page_sends_user_headers() {
        let (url, h) = spawn_header_server(&[
            "Cookie: sid=abc",
            "Authorization: Bearer secret",
            "X-Api-Key: secret-key",
        ]);
        let t = UreqTransport::new("", CREDENTIAL_HEADERS).unwrap();
        let r = t.get(&url, 1024, None, Some(url.as_str())).unwrap();
        assert_eq!(r.status, 200);
        h.join().unwrap();
    }

    #[test]
    fn cross_scope_page_drops_user_headers() {
        let (url, h) = spawn_hop(None);
        let t = UreqTransport::new("", CREDENTIAL_HEADERS).unwrap();
        let r = t
            .get(&url, 1024, None, Some("http://gallery.example/g/1"))
            .unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        for name in ["cookie", "authorization", "x-test", "x-api-key"] {
            assert_eq!(header_value(&req, name), None, "{req}");
        }
    }

    #[test]
    fn invalid_header_scope_sends_no_user_headers() {
        let (url, h) = spawn_hop(None);
        let t = UreqTransport::new("", CREDENTIAL_HEADERS).unwrap();
        let r = t
            .get(&url, 1024, None, Some("not a valid absolute url"))
            .unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        for name in ["cookie", "authorization", "x-test", "x-api-key"] {
            assert_eq!(header_value(&req, name), None, "{req}");
        }
    }

    #[test]
    fn cross_origin_referer_drops_query_and_fragment() {
        let (url, h) = spawn_hop(None);
        let referer = "http://gallery.example/g/1?token=secret#frag";
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&url, 1024, Some(referer), Some(referer)).unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        assert_eq!(
            header_value(&req, "referer"),
            Some("http://gallery.example/g/1"),
            "{req}"
        );
        assert!(!req.contains("token=secret"), "{req}");
        assert!(!req.contains("#frag"), "{req}");
    }

    #[test]
    fn origin_header_includes_non_default_port_and_keeps_same_origin_referer() {
        let (url, h) = spawn_hop(None);
        let port = url::Url::parse(&url).unwrap().port().unwrap();
        let referer = format!("{url}?token=secret#frag");
        let t = UreqTransport::new("", "").unwrap();
        let r = t
            .get(&url, 1024, Some(&referer), Some(url.as_str()))
            .unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        assert_eq!(
            header_value(&req, "origin"),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "{req}"
        );
        assert_eq!(
            header_value(&req, "referer"),
            Some(referer.as_str()),
            "{req}"
        );
    }

    /// 百分号编码的在线 URL 必须在请求行原样送出：既不二次编码，也不解码，query 不截断。
    #[test]
    fn request_line_preserves_percent_encoded_path_and_query() {
        let (base, h) = spawn_hop(None);
        let origin = url::Url::parse(&base)
            .unwrap()
            .origin()
            .ascii_serialization();
        let path = "/%E6%BC%AB%E7%94%BB%20one/%5B1%5D%23x%25.jpg?a=%2Fb%20c";
        let target = format!("{origin}{path}");
        // 纯函数层：url crate 的解析/序列化必须幂等，不得解码既有转义。
        assert_eq!(url::Url::parse(&target).unwrap().as_str(), target);

        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&target, 1024, None, None).unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        let line = req.lines().next().unwrap_or_default();
        assert_eq!(line, format!("GET {path} HTTP/1.1"), "{req}");
        assert!(!req.contains("%2520"), "路径/query 不得被二次编码：{req}");
    }

    /// 原始中文/空格 URL 只在传输层编码一次（UTF-8 → 大写百分号），不双写。
    #[test]
    fn raw_chinese_path_is_percent_encoded_once() {
        let (base, h) = spawn_hop(None);
        let origin = url::Url::parse(&base)
            .unwrap()
            .origin()
            .ascii_serialization();
        let target = format!("{origin}/漫画 one/第1话.jpg?q=中文 值");
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&target, 1024, None, None).unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        let line = req.lines().next().unwrap_or_default();
        assert_eq!(
            line,
            "GET /%E6%BC%AB%E7%94%BB%20one/%E7%AC%AC1%E8%AF%9D.jpg?q=%E4%B8%AD%E6%96%87%20%E5%80%BC HTTP/1.1",
            "{req}"
        );
        assert!(
            !req.contains("漫画"),
            "请求行不得出现未编码的原始中文：{req}"
        );
    }

    /// 同源 Referer：保留 query 与既有百分号编码（含中文路径）。
    #[test]
    fn same_origin_referer_keeps_percent_encoded_query() {
        let (base, h) = spawn_hop(None);
        let origin = url::Url::parse(&base)
            .unwrap()
            .origin()
            .ascii_serialization();
        let target = format!("{origin}/%E6%BC%AB%E7%94%BB%20one/%5B1%5D%23x%25.jpg?a=%2Fb%20c");
        let page = format!("{origin}/%E6%BC%AB%E7%94%BB%20one/?token=%2Fsecret%20x#frag");
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&target, 1024, Some(&page), Some(&page)).unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        assert_eq!(
            header_value(&req, "referer"),
            Some(page.as_str()),
            "同源 Referer 必须保留 query/百分号编码：{req}"
        );
        let referer = header_value(&req, "referer").unwrap();
        assert!(referer.contains("/%E6%BC%AB%E7%94%BB%20one/"), "{referer}");
        assert!(referer.contains("?token=%2Fsecret%20x"), "{referer}");
        assert!(!referer.contains("%2520"), "不得二次编码：{referer}");
    }

    /// 跨源 Referer：去掉 query/fragment，但路径中的百分号编码原样保留。
    #[test]
    fn cross_origin_referer_drops_query_without_decoding_path() {
        let (base, h) = spawn_hop(None);
        let page = "http://gallery.example/%E6%BC%AB%E7%94%BB%20one/?token=%2Fsecret%20x#frag";
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&base, 1024, Some(page), Some(page)).unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        assert_eq!(
            header_value(&req, "referer"),
            Some("http://gallery.example/%E6%BC%AB%E7%94%BB%20one/"),
            "{req}"
        );
        assert!(!req.contains("token"), "跨源不得泄漏 page query：{req}");
        assert!(!req.contains("#frag"), "{req}");
    }

    #[test]
    fn redirect_from_cross_scope_to_same_scope_restores_user_headers() {
        let (same_scope_url, same_scope_h) = spawn_hop(None);
        let (cross_scope_url, cross_scope_h) = spawn_hop(Some(same_scope_url.clone()));
        let t = UreqTransport::new("", CREDENTIAL_HEADERS).unwrap();
        let r = t
            .get(&cross_scope_url, 1024, None, Some(same_scope_url.as_str()))
            .unwrap();
        assert_eq!(r.status, 200);
        let first = cross_scope_h.join().unwrap();
        assert_eq!(header_value(&first, "cookie"), None, "{first}");
        let second = same_scope_h.join().unwrap();
        assert_eq!(header_value(&second, "cookie"), Some("sid=abc"), "{second}");
        assert_eq!(
            header_value(&second, "authorization"),
            Some("Bearer secret"),
            "{second}"
        );
    }

    /// 命中已注册辅助会话的 origin：复用该会话的 UA（UA 非机密，可按 origin 复用）。
    #[test]
    fn assisted_origin_uses_registered_user_agent() {
        let (url, h) = spawn_hop(None);
        let origin = url::Url::parse(&url)
            .unwrap()
            .origin()
            .ascii_serialization();
        let registry = Arc::new(crate::state::AssistedSessionRegistry::new());
        registry
            .register(
                &origin,
                crate::state::AssistedSession {
                    user_agent: Some("Assisted-UA/1.0".into()),
                    headers: None,
                },
            )
            .unwrap();
        let t = UreqTransport::new_with_assisted("", "", registry).unwrap();
        let r = t.get(&url, 1024, None, Some(url.as_str())).unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        assert_eq!(
            header_value(&req, "user-agent"),
            Some("Assisted-UA/1.0"),
            "{req}"
        );
    }

    /// 未命中辅助会话的 origin：一律回落到标准桌面 Chrome UA。
    #[test]
    fn other_origin_falls_back_to_standard_user_agent() {
        let (url, h) = spawn_hop(None);
        let registry = Arc::new(crate::state::AssistedSessionRegistry::new());
        registry
            .register(
                "https://other.example",
                crate::state::AssistedSession {
                    user_agent: Some("Assisted-UA/1.0".into()),
                    headers: None,
                },
            )
            .unwrap();
        let t = UreqTransport::new_with_assisted("", "", registry).unwrap();
        let r = t.get(&url, 1024, None, Some(url.as_str())).unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        assert_eq!(
            header_value(&req, "user-agent"),
            Some(crate::online::ONLINE_UA),
            "{req}"
        );
    }

    /// 没有辅助上下文时（默认构造）：始终使用标准桌面 Chrome UA。
    #[test]
    fn transport_without_assisted_sessions_uses_standard_user_agent() {
        let (url, h) = spawn_hop(None);
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&url, 1024, None, Some(url.as_str())).unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        assert_eq!(
            header_value(&req, "user-agent"),
            Some(crate::online::ONLINE_UA),
            "{req}"
        );
    }

    /// 辅助会话不放大**用户请求头**作用域：scope 指向别的 origin 时用户头全部丢弃；
    /// 辅助会话自己的请求头按「目标 origin 命中」附带。
    #[test]
    fn assisted_session_does_not_widen_user_header_scope() {
        let (url, h) = spawn_hop(None);
        let origin = url::Url::parse(&url)
            .unwrap()
            .origin()
            .ascii_serialization();
        let registry = Arc::new(crate::state::AssistedSessionRegistry::new());
        registry
            .register(
                &origin,
                crate::state::AssistedSession {
                    user_agent: Some("Assisted-UA/1.0".into()),
                    headers: Some(r#"{"Cookie":"sid=assisted"}"#.into()),
                },
            )
            .unwrap();
        let t = UreqTransport::new_with_assisted(
            "",
            r#"{"Cookie":"sid=user-scope","Authorization":"Bearer user"}"#,
            registry,
        )
        .unwrap();
        // scope 指向别的 origin：用户请求头必须全部丢弃。
        let r = t
            .get(&url, 1024, None, Some("http://gallery.example/g/1"))
            .unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        assert_eq!(
            header_value(&req, "cookie"),
            Some("sid=assisted"),
            "只有辅助会话自己的（按 origin 绑定的）头可以出现：{req}"
        );
        assert_eq!(header_value(&req, "authorization"), None, "{req}");
        assert_eq!(
            header_value(&req, "user-agent"),
            Some("Assisted-UA/1.0"),
            "{req}"
        );
    }

    /// 辅助会话的请求头**严格按 origin 绑定**：目标 origin 不是登记 origin 时一律不附带，
    /// 避免上一站凭据泄漏到下一站。
    #[test]
    fn assisted_headers_never_cross_origins() {
        let (url, h) = spawn_hop(None);
        let registry = Arc::new(crate::state::AssistedSessionRegistry::new());
        registry
            .register(
                "https://other.example",
                crate::state::AssistedSession {
                    user_agent: Some("Assisted-UA/1.0".into()),
                    headers: Some(r#"{"Cookie":"sid=other-site"}"#.into()),
                },
            )
            .unwrap();
        let t = UreqTransport::new_with_assisted("", "", registry).unwrap();
        let r = t.get(&url, 1024, None, Some(url.as_str())).unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        assert_eq!(
            header_value(&req, "cookie"),
            None,
            "其它 origin 不得拿到辅助会话的请求头：{req}"
        );
    }
}
