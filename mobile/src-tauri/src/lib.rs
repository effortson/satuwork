use std::borrow::Cow;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/**
 * Satuwork 手机壳（Tauri 2 mobile）。
 *
 * **和桌面壳同一个思路，少掉一切「本机」的东西。** gateway/ui 那批分片原样打进包
 * （mobile/scripts/prepare-ui.mjs），由这里自注册的 `satu://` 协议发出去（serve_ui；Android 上
 * Tauri 把它映射成 http://satu.localhost）。页面源因此和桌面端一样是 `satu://localhost`——
 * Gateway、席位机器的管家、本地 Bot 的守卫三处的 CORS 白名单早就认它，手机端一行不用加。
 * 壳子把 Gateway 地址注入给页面（LINK_SCRIPT 的 `__SATUWORK_GATEWAY__`），所有请求都是跨源的，
 * 凭据走 Authorization 头。
 *
 * 桌面壳（desktop/src-tauri/src/main.rs）里的本地 Bot、运行时下载、自升级、菜单、设置屏在
 * 手机上都不存在：手机只有一扇窗、一个 Gateway 地址（正式包锁死 satuwork.com，debug 构建
 * 认编译期的 SATUWORK_SERVER），所以这份文件只剩三件事：发界面、注入、把往外走的导航
 * 交给系统浏览器。serve_ui / 导航守卫那几段是从桌面壳抄过来的，两边要一起改
 * （docs/adr-core-package-mobile.md §5 第 5 步记了这笔账）。
 */

const MAIN: &str = "main";

/// 「请帮我在外面打开这个地址」的暗号，走同源的普通 http 路径，理由见桌面壳的 OPEN_PATH。
const OPEN_PATH: &str = "/__satuwork_open";
const UI_SCHEME: &str = "satu";
const UI_HOST: &str = "satu.localhost";
const UI_ORIGIN: &str = "satu://localhost/";

/// 正式包连的 Gateway。
const DEFAULT_SERVER: &str = "https://satuwork.com";

fn is_ui_origin(url: &Url) -> bool {
    (url.scheme() == UI_SCHEME && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some(UI_HOST))
}

/**
 * 这次连哪儿。手机上没有设置屏也没有菜单：正式包锁死 DEFAULT_SERVER；debug 构建先看
 * 仓库里的 `mobile/src-tauri/dev-server.txt`（不进版本库；模拟器里的进程就是本机进程，读得到），
 * 再看编译期的 `SATUWORK_SERVER`。文件优先是因为 `tauri ios dev` 经 Xcode 起 cargo，shell 里的
 * 环境变量传不进去（实测）；文件改完重开应用就生效，不用重编。
 */
fn pick_server<'a>(debug: bool, from_file: Option<&'a str>, baked: Option<&'a str>) -> &'a str {
    if debug {
        if let Some(s) = [from_file, baked].into_iter().flatten().map(str::trim).find(|s| !s.is_empty()) {
            return s;
        }
    }
    DEFAULT_SERVER
}

fn gateway_url() -> Result<Url, String> {
    #[cfg(debug_assertions)]
    let from_file = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dev-server.txt")).ok();
    #[cfg(not(debug_assertions))]
    let from_file: Option<String> = None;
    normalize(pick_server(cfg!(debug_assertions), from_file.as_deref(), option_env!("SATUWORK_SERVER")))
}

/// 不带协议的按 http 补上；只认 http/https。
fn normalize(raw: &str) -> Result<Url, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("Gateway 地址是空的".into());
    }
    let with_scheme = if s.contains("://") { s.to_string() } else { format!("http://{s}") };
    let url = Url::parse(&with_scheme).map_err(|e| format!("Gateway 地址读不懂：{e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("只认 http 和 https，不认 {other}")),
    }
    if url.host_str().unwrap_or("").is_empty() {
        return Err("Gateway 地址里没有主机名".into());
    }
    Ok(url)
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/**
 * 注入页面的一小段。和桌面壳的 LINK_SCRIPT 同一个骨架：给页面一个只由壳子注入的标记
 * （`__SATUWORK_MOBILE__`，state.js 据此把登录票落到 localStorage）、告诉它 Gateway 在哪、
 * 把 `target="_blank"` 和 `window.open()` 翻译成一次到 OPEN_PATH 的导航（裸 webview 里它们是
 * 空操作）。没有本地 Bot 那组桥，页面上对应的入口就不出现。
 */
const LINK_SCRIPT: &str = r#"
(function () {
  window.__SATUWORK_MOBILE__ = true
  window.__SATUWORK_GATEWAY__ = __GATEWAY_URL__
  window.__SATUWORK_SEAT_DESKTOP__ = {
    allow: function (url) { return window.__TAURI_INTERNALS__.invoke('allow_seat_desktop', { url: url }) }
  }
  if (window.__satuLinkPatched) return
  window.__satuLinkPatched = true
  function hand(raw) {
    try {
      var abs = new URL(raw, location.href).href
      location.href = location.origin + __OPEN_PATH__ + '?u=' + encodeURIComponent(abs)
    } catch (e) {}
  }
  var open0 = window.open
  window.open = function (u) {
    if (u) hand(String(u))
    return null
  }
  document.addEventListener(
    'click',
    function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return
      var el = e.target
      var a = el && el.closest ? el.closest('a[target="_blank"]') : null
      if (!a || !a.href) return
      e.preventDefault()
      hand(a.href)
    },
    true,
  )
})()
"#;

/**
 * debug 构建里把页面的 console.error / console.warn / 未捕获异常抄一份到文件。
 *
 * 手机上没有「打开开发者工具」这一说：Safari 的 Web 检查器要人手点，命令行里什么都看不到。
 * 这段只在 debug 构建注入，落到应用容器的 tmp 目录（`xcrun simctl get_app_container <设备>
 * sg.dami.satuwork.mobile data` 找得到），正式包里既不注入也不写。
 */
#[cfg(debug_assertions)]
const DEBUG_SCRIPT: &str = r#"
(function () {
  function send(kind, text) {
    try { window.__TAURI_INTERNALS__.invoke('debug_log', { line: kind + ' ' + text }) } catch (e) {}
  }
  function join(args) { return Array.prototype.map.call(args, function (a) { return a && a.stack ? a.stack : String(a) }).join(' ') }
  window.addEventListener('error', function (e) { send('error', (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || '')) })
  window.addEventListener('unhandledrejection', function (e) { send('rejection', e.reason && e.reason.stack ? e.reason.stack : String(e.reason)) })
  var ce = console.error.bind(console)
  console.error = function () { send('console.error', join(arguments)); ce.apply(console, arguments) }
  var cw = console.warn.bind(console)
  console.warn = function () { send('console.warn', join(arguments)); cw.apply(console, arguments) }
  window.addEventListener('DOMContentLoaded', function () {
    var app = document.getElementById('app')
    send('dom', 'loaded; #app children=' + (app ? app.childElementCount : 'none') + ' href=' + location.href)
  })
})()
"#;

#[tauri::command]
fn debug_log(line: String) {
    #[cfg(debug_assertions)]
    {
        use std::io::Write;
        let path = std::env::temp_dir().join("satuwork-mobile.log");
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{line}");
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = line;
}

/// 界面报上来的席位机器源，见 allow_seat_desktop。
#[derive(Default)]
struct SeatOrigins(Mutex<HashSet<String>>);

fn origin_key(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// `/seats/<席位>/vnc[/…]`：右栏那块内嵌桌面在加载席位机器的 noVNC。
fn is_seat_desktop(url: &Url) -> bool {
    let mut seg = match url.path_segments() {
        Some(it) => it,
        None => return false,
    };
    seg.next() == Some("seats") && seg.next().is_some_and(|s| !s.is_empty()) && seg.next() == Some("vnc")
}

fn seat_desktop_allowed(url: &Url, gateway: &Url, seats: &HashSet<String>) -> bool {
    matches!(url.scheme(), "http" | "https")
        && is_seat_desktop(url)
        && (same_origin(url, gateway) || seats.contains(&origin_key(url)))
}

/// 暗号只在界面自己的源或 Gateway 的源上认，理由见桌面壳的同名函数。
fn open_path_allowed(url: &Url, gateway: &Url) -> bool {
    url.path() == OPEN_PATH && (is_ui_origin(url) || same_origin(url, gateway))
}

#[tauri::command]
fn allow_seat_desktop(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| format!("桌面地址解析不了：{e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || !is_seat_desktop(&parsed) {
        return Err("不是席位桌面地址".into());
    }
    let state = app.state::<SeatOrigins>();
    let mut seats = state.0.lock().map_err(|_| "放行名单锁坏了".to_string())?;
    seats.insert(origin_key(&parsed));
    Ok(())
}

/**
 * 暗号里带的那个地址该去哪。手机只有一扇窗，「另开一扇应用窗口」这条路没有，所以
 * 一律交给系统浏览器；界面自己源上的地址（`satu://localhost/d/bot-1` 这种「打开桌面」）
 * 换成 Gateway 的源——Gateway 发的是同一份界面，在 Safari 里登录一次就能看。
 */
fn open_target(base: &Url, raw: &str) -> Option<Url> {
    let parsed = Url::parse(raw).ok()?;
    if is_ui_origin(&parsed) {
        let mut out = base.clone();
        out.set_path(parsed.path());
        out.set_query(parsed.query());
        out.set_fragment(parsed.fragment());
        return Some(out);
    }
    match parsed.scheme() {
        "http" | "https" => Some(parsed),
        // 页面上的内容不全是我们写的（markdown 里的链接来自模型和用户），别的协议一律当没发生。
        _ => None,
    }
}

fn route_open(app: &AppHandle, base: &Url, url: &Url) {
    let target = url.query_pairs().find(|(k, _)| k == "u").map(|(_, v)| v.to_string()).unwrap_or_default();
    if let Some(dest) = open_target(base, &target) {
        let _ = app.opener().open_url(dest.as_str(), None::<&str>);
    }
}

/**
 * 每一次导航都过这里，要挡的只有一件事：把唯一的窗口导航到站外（这里没有地址栏也没有
 * 后退）。规则照桌面壳：暗号先认；界面自己的源放行；不是 http(s) 的放行（blob:、ws: 这些）；
 * 内嵌桌面的 iframe 放行；剩下的 http(s) 都是往外走，交给系统浏览器、窗口留在原地。
 */
fn allow_navigation(app: &AppHandle, base: &Url, url: &Url) -> bool {
    if open_path_allowed(url, base) {
        route_open(app, base, url);
        return false;
    }
    if is_ui_origin(url) {
        return true;
    }
    match url.scheme() {
        "http" | "https" => {}
        _ => return true,
    }
    let seats = app.state::<SeatOrigins>();
    let allowed = seats.0.lock().map(|s| seat_desktop_allowed(url, base, &s)).unwrap_or(false);
    if allowed {
        return true;
    }
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
    false
}

/// 包里那份界面在哪：发布包里是打进二进制的 frontendDist（prepare-ui.mjs 拷到 src-tauri/ui/）；
/// debug 构建直接读仓库里的 gateway/ui——模拟器里的进程就是本机进程，读得到。
fn ui_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../gateway/ui");
        if source.join("index.html").is_file() {
            return Some(source);
        }
    }
    None
}

fn mime_of(path: &str) -> &'static str {
    match Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// UI_CSP 里 CDN 那几条路径源，照桌面壳抄；版本要和 gateway/src/ui-cdn.ts 的 UI_CDN_PACKAGES 一起改。
macro_rules! ui_cdn {
    () => {
        "https://cdn.jsdelivr.net/npm/katex@0.16.11/ https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/ https://cdn.jsdelivr.net/npm/mermaid@11.4.1/ https://cdn.jsdelivr.net/npm/three@0.170.0/ https://cdn.jsdelivr.net/npm/jszip@3.10.1/ https://cdn.jsdelivr.net/npm/docx-preview@0.4.1/ https://cdn.jsdelivr.net/npm/exceljs@4.4.0/ https://cdn.jsdelivr.net/npm/@aiden0z/pptx-renderer@1.3.0/"
    };
}

/// 界面的 CSP，挂在 serve_ui 发出的每个 html 上。内容和为什么这么写见桌面壳的 UI_CSP。
const UI_CSP: &str = concat!(
    "default-src 'self' satu: http://satu.localhost https://satu.localhost; ",
    "base-uri 'none'; ",
    "object-src 'none'; ",
    "script-src 'self' satu: http://satu.localhost https://satu.localhost ", ui_cdn!(), "; ",
    "style-src 'self' satu: http://satu.localhost https://satu.localhost 'unsafe-inline' ", ui_cdn!(), " https://fonts.googleapis.com; ",
    "font-src 'self' satu: http://satu.localhost https://satu.localhost data: ", ui_cdn!(), " https://fonts.gstatic.com; ",
    "img-src 'self' satu: http://satu.localhost https://satu.localhost data: blob: https: http:; ",
    "media-src 'self' satu: http://satu.localhost https://satu.localhost data: blob: https: http:; ",
    "connect-src 'self' satu: http://satu.localhost https://satu.localhost ipc: http://ipc.localhost https: http: wss: ws:; ",
    "frame-src 'self' satu: http://satu.localhost https://satu.localhost blob: https: http:; ",
    "worker-src 'self' satu: http://satu.localhost https://satu.localhost blob:"
);

/// 路径里的一段能不能拼到 ui 目录后面：`..` / `.` 逃目录，`\\` 和 `:` 挡 Windows / Android 上的花样。
fn safe_ui_segment(seg: &str) -> bool {
    !(seg == ".." || seg == "." || seg.contains('\\') || seg.contains(':'))
}

/// 请求路径 → 包里的相对路径（去掉前导 `/`、查询串和 Gateway 那边也认的 `ui/` 前缀）。
fn ui_rel_path(raw_path: &str) -> Option<String> {
    let rel = raw_path.trim_start_matches('/').split('?').next().unwrap_or("");
    let mut out = Vec::new();
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        if !safe_ui_segment(seg) {
            return None;
        }
        out.push(seg);
    }
    Some(out.join("/"))
}

/// 一份文件：先按原路径找，再去掉 `ui/` 前缀找，都没有就回 index.html（单页应用的兜底）。
fn ui_candidates(rel: &str) -> Vec<String> {
    let mut list = Vec::new();
    if !rel.is_empty() {
        list.push(rel.to_string());
        if let Some(stripped) = rel.strip_prefix("ui/") {
            if !stripped.is_empty() {
                list.push(stripped.to_string());
            }
        }
    }
    list.push("index.html".to_string());
    list
}

fn read_ui_file(app: &AppHandle, rel: &str) -> Option<(Vec<u8>, &'static str)> {
    if let Some(dir) = ui_dir() {
        let mut file = dir;
        for seg in rel.split('/') {
            file.push(seg);
        }
        if file.is_file() {
            return fs::read(&file).ok().map(|b| (b, mime_of(rel)));
        }
        return None;
    }
    app.asset_resolver().get(format!("/{rel}")).map(|a| (a.bytes().to_vec(), mime_of(rel)))
}

/// `satu://localhost/…`：从包里发界面。规矩和桌面壳 / Gateway 的 serveUi 一样。
fn serve_ui(app: &AppHandle, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Cow<'static, [u8]>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(tauri::http::StatusCode::NOT_FOUND)
            .header("content-type", "text/plain; charset=utf-8")
            .body(Cow::Borrowed("包里没有界面文件（gateway/ui）".as_bytes()))
            .unwrap()
    };
    let Some(rel) = ui_rel_path(request.uri().path()) else { return not_found() };
    let Some((bytes, mime)) = ui_candidates(&rel).iter().find_map(|c| read_ui_file(app, c)) else {
        return not_found();
    };
    let mut response = tauri::http::Response::builder()
        .status(tauri::http::StatusCode::OK)
        .header("content-type", mime)
        .header("cache-control", "no-store");
    if mime.starts_with("text/html") {
        response = response.header("content-security-policy", UI_CSP);
    }
    response.body(Cow::Owned(bytes)).unwrap()
}

fn build_window(app: &AppHandle, gateway: Url) -> tauri::Result<()> {
    let handle = app.clone();
    let base = gateway.clone();
    let ui = Url::parse(UI_ORIGIN).expect("UI_ORIGIN 是常量");
    // 占位符替换成 JSON 字符串字面量（带引号）：地址里一个引号就能从字面量里逃出来。
    let script = LINK_SCRIPT
        .replace("__OPEN_PATH__", &serde_json::to_string(OPEN_PATH).expect("常量总能编成 JSON"))
        .replace(
            "__GATEWAY_URL__",
            &serde_json::to_string(gateway.as_str().trim_end_matches('/')).expect("字符串总能编成 JSON"),
        );
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::CustomProtocol(ui))
        .title("Satuwork")
        .initialization_script(&script)
        .on_navigation(move |url| allow_navigation(&handle, &base, url));
    #[cfg(debug_assertions)]
    let builder = builder.initialization_script(DEBUG_SCRIPT);
    builder.build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol(UI_SCHEME, |ctx, request| serve_ui(&ctx.app_handle().clone(), &request))
        .manage(SeatOrigins::default())
        .invoke_handler(tauri::generate_handler![allow_seat_desktop, debug_log])
        .setup(|app| {
            let gateway = gateway_url().map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            build_window(&app.handle().clone(), gateway)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Satuwork 手机壳起不来");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn release_ignores_dev_server() {
        assert_eq!(pick_server(false, Some("http://127.0.0.1:3080\n"), Some("http://127.0.0.1:3081")), DEFAULT_SERVER);
        assert_eq!(pick_server(true, Some(" http://127.0.0.1:3080\n"), Some("http://127.0.0.1:3081")), "http://127.0.0.1:3080");
        assert_eq!(pick_server(true, Some("  \n"), Some("http://127.0.0.1:3081")), "http://127.0.0.1:3081");
        assert_eq!(pick_server(true, None, Some("  ")), DEFAULT_SERVER);
        assert_eq!(pick_server(true, None, None), DEFAULT_SERVER);
    }

    #[test]
    fn normalize_adds_http_and_rejects_other_schemes() {
        assert_eq!(normalize("192.168.64.1:3080").unwrap().as_str(), "http://192.168.64.1:3080/");
        assert!(normalize("ftp://x").is_err());
        assert!(normalize("").is_err());
    }

    #[test]
    fn open_path_only_from_ui_or_gateway_origin() {
        let gw = u("https://gw.example.com");
        assert!(open_path_allowed(&u("satu://localhost/__satuwork_open?u=https%3A%2F%2Fa.com"), &gw));
        assert!(open_path_allowed(&u("http://satu.localhost/__satuwork_open?u=x"), &gw));
        assert!(open_path_allowed(&u("https://gw.example.com/__satuwork_open?u=x"), &gw));
        assert!(!open_path_allowed(&u("https://evil.com/__satuwork_open?u=x"), &gw));
        assert!(!open_path_allowed(&u("satu://localhost/index.html?u=x"), &gw));
    }

    #[test]
    fn ui_origin_links_reopen_on_the_gateway() {
        let gw = u("https://gw.example.com");
        assert_eq!(open_target(&gw, "satu://localhost/d/bot-1?x=1#f").unwrap().as_str(), "https://gw.example.com/d/bot-1?x=1#f");
        assert_eq!(open_target(&gw, "https://a.com/p").unwrap().as_str(), "https://a.com/p");
        assert!(open_target(&gw, "javascript:alert(1)").is_none());
        assert!(open_target(&gw, "not a url").is_none());
    }

    #[test]
    fn seat_desktop_only_on_known_origins() {
        let gw = u("https://gw.example.com");
        let mut seats = HashSet::new();
        seats.insert(origin_key(&u("https://m001.example.com")));
        assert!(seat_desktop_allowed(&u("https://m001.example.com/seats/s1/vnc/"), &gw, &seats));
        assert!(seat_desktop_allowed(&u("https://gw.example.com/seats/s1/vnc/vnc.html?a=1"), &gw, &seats));
        assert!(!seat_desktop_allowed(&u("https://evil.com/seats/s1/vnc/"), &gw, &seats));
        assert!(!seat_desktop_allowed(&u("https://m001.example.com/other"), &gw, &seats));
    }

    #[test]
    fn ui_path_segments_cannot_escape_ui_directory() {
        assert_eq!(ui_rel_path("/a/bot-1?x=1").unwrap(), "a/bot-1");
        assert_eq!(ui_rel_path("/").unwrap(), "");
        assert!(ui_rel_path("/../Cargo.toml").is_none());
        assert!(ui_rel_path("/a/..%2f").is_some());
        assert!(ui_rel_path("/c:/x").is_none());
        assert_eq!(ui_candidates("ui/chat.js"), vec!["ui/chat.js", "chat.js", "index.html"]);
        assert_eq!(ui_candidates(""), vec!["index.html"]);
    }
}
