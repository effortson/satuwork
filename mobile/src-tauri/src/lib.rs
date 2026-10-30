use std::borrow::Cow;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/**
 * Satuwork 手机壳（Tauri 2 mobile）。
 *
 * **和桌面壳同一个思路，少掉一切「本机」的东西。** gateway/ui 那批分片原样打进包
 * （scripts/copy-ui.mjs），由这里自注册的 `satu://` 协议发出去（serve_ui；Android 上
 * Tauri 把它映射成 http://satu.localhost）。页面源因此和桌面端一样是 `satu://localhost`——
 * Gateway、席位机器的管家、本地 Bot 的守卫三处的 CORS 白名单早就认它，手机端一行不用加。
 * 壳子把 Gateway 地址注入给页面（LINK_SCRIPT 的 `__SATUWORK_GATEWAY__`），所有请求都是跨源的，
 * 凭据走 Authorization 头。
 *
 * 桌面壳（desktop/src-tauri/src/）里的本地 Bot、运行时下载、自升级、菜单、设置屏在
 * 手机上都不存在：手机只有一扇窗，登录页可以检测并切换 Gateway 地址，默认连 satuwork.com。
 * 这里负责发界面、注入、保存服务器地址、把往外走的导航
 * 交给系统浏览器。serve_ui / 导航守卫那几段是从桌面壳抄过来的，两边要一起改
 * （docs/adr-core-package-mobile.md §5 第 5 步记了这笔账）。
 */

const MAIN: &str = "main";

/// 「请帮我在外面打开这个地址」的暗号，走同源的普通 http 路径，理由见桌面壳的 OPEN_PATH。
const OPEN_PATH: &str = "/__satuwork_open";
const UI_SCHEME: &str = "satu";
const UI_HOST: &str = "satu.localhost";
const UI_ORIGIN: &str = "satu://localhost/";
const BOOTSTRAP_PATH: &str = "/__satuwork_mobile.js";

struct GatewayServer(Mutex<Url>);

/// 正式包连的 Gateway。
const DEFAULT_SERVER: &str = "https://satuwork.com";

fn is_ui_origin(url: &Url) -> bool {
    (url.scheme() == UI_SCHEME && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some(UI_HOST))
}

/**
 * 这次连哪儿：用户存过的地址优先；没有时 debug 构建先看
 * 仓库里的 `mobile/src-tauri/dev-server.txt`（不进版本库），再看编译期的 `SATUWORK_SERVER`。
 *
 * - iOS 模拟器的进程就是本机进程，运行时读得到那个文件：改完重开应用就生效，不用重编。
 *   不靠环境变量是因为 `tauri ios dev` 经 Xcode 起 cargo，shell 里的变量传不进去（实测）。
 * - Android 模拟器是一台虚拟机，读不到本机文件，靠 build.rs 在构建时把文件内容烤成
 *   `SATUWORK_SERVER`。本机的 127.0.0.1 在 Android 模拟器里要先 `adb reverse`（mobile/README.md）。
 */
fn pick_server<'a>(debug: bool, saved: Option<&'a str>, from_file: Option<&'a str>, baked: Option<&'a str>) -> &'a str {
    if let Some(s) = saved.map(str::trim).filter(|s| !s.is_empty()) {
        return s;
    }
    if debug {
        if let Some(s) = [from_file, baked].into_iter().flatten().map(str::trim).find(|s| !s.is_empty()) {
            return s;
        }
    }
    DEFAULT_SERVER
}

fn server_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|dir| dir.join("server.txt")).map_err(|e| format!("找不到配置目录：{e}"))
}

fn gateway_url(app: &AppHandle) -> Result<Url, String> {
    let saved = server_file(app).ok().and_then(|path| fs::read_to_string(path).ok());
    #[cfg(debug_assertions)]
    let from_file = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dev-server.txt")).ok();
    #[cfg(not(debug_assertions))]
    let from_file: Option<String> = None;
    normalize(pick_server(cfg!(debug_assertions), saved.as_deref(), from_file.as_deref(), option_env!("SATUWORK_SERVER")))
}

#[derive(Serialize)]
struct GatewayServerInfo {
    current: String,
    default: String,
}

#[tauri::command]
fn gateway_server_info(server: State<'_, GatewayServer>) -> Result<GatewayServerInfo, String> {
    Ok(GatewayServerInfo {
        current: server.0.lock().map_err(|e| e.to_string())?.as_str().trim_end_matches('/').to_string(),
        default: DEFAULT_SERVER.to_string(),
    })
}

/// 和桌面端一样：只有 /health 成功且报告 ok: true 才能保存。阻塞 HTTP 放到工作线程。
fn check_server(url: &Url) -> Result<(), String> {
    let health = format!("{}/health", url.as_str().trim_end_matches('/'));
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("建 HTTP 客户端失败：{e}"))?
        .get(&health)
        .send()
        .map_err(|e| format!("请求 {health} 失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("{health} 回了 HTTP {}，这个地址不像是 Satuwork Gateway", response.status().as_u16()));
    }
    let body: serde_json::Value = response.json()
        .map_err(|_| format!("{health} 回的不是 Gateway 的响应，这个地址不像是 Satuwork Gateway"))?;
    if body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!("{health} 没有报告正常（ok 不是 true）"));
    }
    Ok(())
}

async fn checked_server(raw: &str) -> Result<Url, String> {
    let url = normalize(raw)?;
    tauri::async_runtime::spawn_blocking(move || {
        check_server(&url)?;
        Ok(url)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check_gateway_server(url: String) -> Result<String, String> {
    Ok(checked_server(&url).await?.as_str().trim_end_matches('/').to_string())
}

#[tauri::command]
async fn use_gateway_server(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = checked_server(&url).await?;
    let server = app.state::<GatewayServer>();
    let mut current = server.0.lock().map_err(|e| e.to_string())?;
    let path = server_file(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("建配置目录失败：{e}"))?;
    }
    fs::write(path, parsed.as_str()).map_err(|e| format!("写配置失败：{e}"))?;
    *current = parsed;
    Ok(())
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
 *
 * 桌面壳没有的一条：`a[download]`（页面里所有的「下载」）交给系统分享面板（mobile/share-plugin）。
 * WebView 里这种点击什么都不发生——WKWebView 没挂下载处理就直接取消，Android 的 WebView 没有
 * DownloadListener。blob: / data: 的在这儿读成字节交给壳子；http(s) 的交给系统浏览器去下。
 * **fetch 要在点击这一下里同步发出**：页面点完一秒就 revokeObjectURL，晚了 blob 地址就读不到了。
 */
const LINK_SCRIPT: &str = r#"
(function () {
  window.__SATUWORK_MOBILE__ = true
  window.__SATUWORK_GATEWAY__ = __GATEWAY_URL__
  window.__SATUWORK_SERVER__ = {
    info: function () { return window.__TAURI_INTERNALS__.invoke('gateway_server_info') },
    check: function (url) { return window.__TAURI_INTERNALS__.invoke('check_gateway_server', { url: url }) },
    use: function (url) {
      return window.__TAURI_INTERNALS__.invoke('use_gateway_server', { url: url }).then(function () {
        // 页面源始终相同，旧服务器的登录票不能跟着发到新服务器。
        clearToken()
        location.replace('/login')
      })
    }
  }
  // 远程推送（mobile/push-plugin）：要设备令牌、取用户点开的那条通知。登记到 Gateway 由页面做
  // （gateway/ui/shell.js 的 syncMobilePush），壳子不碰登录票。
  window.__SATUWORK_PUSH__ = {
    register: function () { return window.__TAURI_INTERNALS__.invoke('plugin:satu-push|register') },
    takeTap: function () { return window.__TAURI_INTERNALS__.invoke('plugin:satu-push|take_tap') },
    clear: function (ids) { return window.__TAURI_INTERNALS__.invoke('plugin:satu-push|clear_notifications', { ids: ids }) },
    backgroundStatus: function () { return window.__TAURI_INTERNALS__.invoke('plugin:satu-push|background_status') },
    openBackgroundSettings: function () { return window.__TAURI_INTERNALS__.invoke('plugin:satu-push|open_background_settings') }
  }
  if (window.__satuLinkPatched) return
  window.__satuLinkPatched = true
  function hand(raw) {
    try {
      var abs = new URL(raw, location.href).href
      location.href = location.origin + __OPEN_PATH__ + '?u=' + encodeURIComponent(abs)
    } catch (e) {}
  }
  function save(a) {
    var href = a.href
    if (!/^(blob|data):/i.test(href)) {
      hand(href)
      return
    }
    var name = a.getAttribute('download') || ''
    fetch(href)
      .then(function (r) { return r.blob() })
      .then(function (b) {
        return b.arrayBuffer().then(function (buf) {
          return window.__TAURI_INTERNALS__.invoke('plugin:satu-share|share', buf, {
            headers: { 'x-satu-name': encodeURIComponent(name), 'x-satu-type': encodeURIComponent(b.type || '') }
          })
        })
      })
      .catch(function (e) { console.warn('satuwork: 交给分享面板失败：' + (e && e.message ? e.message : e)) })
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
      var d = el && el.closest ? el.closest('a[download]') : null
      if (d && d.href) {
        e.preventDefault()
        save(d)
        return
      }
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
        // Android 上应用的临时目录 adb 看不到，Rust 的 stderr 会进 logcat（标签 RustStdoutStderr）。
        eprintln!("[satuwork] {line}");
    }
    #[cfg(not(debug_assertions))]
    let _ = line;
}

/**
 * 交给系统处理、窗口不动的那几种地址：站外网页给浏览器，`mailto:` / `tel:` / `sms:` 给邮件、电话、
 * 短信。后三种 WebView 自己打不开——放行的话点了什么都不发生，而 markdown 里的邮箱、电话正是
 * 手机上最常点的链接。别的协议（blob:、data:、about: 这些页面内部用的）不归这里管。
 */
fn hand_to_system(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto" | "tel" | "sms")
}

/// 暗号只在界面自己的源或 Gateway 的源上认，理由见桌面壳的同名函数。
fn open_path_allowed(url: &Url, gateway: &Url) -> bool {
    url.path() == OPEN_PATH && (is_ui_origin(url) || same_origin(url, gateway))
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
    // 页面上的内容不全是我们写的（markdown 里的链接来自模型和用户），只认 hand_to_system 那几种，
    // 别的协议（javascript: 这些）一律当没发生。
    hand_to_system(&parsed).then_some(parsed)
}

/**
 * 交给系统浏览器。
 *
 * **另起一个线程调**：导航回调在 Android 上跑在界面线程，而 opener 插件在移动端要同步等原生那半
 * 回话，原生那半又要在界面线程上执行——在回调里直接调，浏览器就是起不来（实测，什么都不发生）。
 * 失败照实打一行：链接点了没反应是最难查的那种毛病。
 */
fn open_external(app: &AppHandle, url: &str) {
    let app = app.clone();
    let url = url.to_string();
    std::thread::spawn(move || {
        if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
            eprintln!("[satuwork] 交给系统浏览器失败：{e}");
        }
    });
}

fn route_open(app: &AppHandle, base: &Url, url: &Url) {
    let target = url.query_pairs().find(|(k, _)| k == "u").map(|(_, v)| v.to_string()).unwrap_or_default();
    if let Some(dest) = open_target(base, &target) {
        open_external(app, dest.as_str());
    }
}

/**
 * 每一次导航都过这里，要挡的只有一件事：把唯一的窗口导航到站外（这里没有地址栏也没有
 * 后退）。规则照桌面壳：暗号先认；界面自己的源放行；hand_to_system 那几种交给系统、窗口留在
 * 原地；剩下的（blob:、data: 这些页面内部用的）放行。
 *
 * 和桌面壳差两处：`mailto:` / `tel:` / `sms:` 交给系统（见 hand_to_system）；**没有**内嵌桌面那块
 * iframe 的放行——手机上不嵌桌面（gateway/ui/chat-desktop.js 的 deskEmbeddable），「打开桌面」走系统浏览器。
 */
fn allow_navigation(app: &AppHandle, base: &Url, url: &Url) -> bool {
    #[cfg(debug_assertions)]
    eprintln!("[satuwork] navigation {url}");
    if open_path_allowed(url, base) {
        route_open(app, base, url);
        return false;
    }
    if is_ui_origin(url) {
        return true;
    }
    if !hand_to_system(url) {
        return true;
    }
    open_external(app, url.as_str());
    false
}

/// 包里那份界面在哪：发布包里是打进二进制的 frontendDist（scripts/copy-ui.mjs 拷到 src-tauri/ui/）；
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

// UI_CSP 里 CDN 那几条路径源，照桌面壳抄；版本要和 gateway/src/ui-cdn.ts 的 UI_CDN_PACKAGES 一起改（e2e 的 markdown 那一组两个壳都核）。
macro_rules! ui_cdn {
    () => {
        "https://cdn.jsdelivr.net/npm/katex@0.16.11/ https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/ https://cdn.jsdelivr.net/npm/mermaid@11.4.1/ https://cdn.jsdelivr.net/npm/three@0.170.0/ https://cdn.jsdelivr.net/npm/jszip@3.10.1/ https://cdn.jsdelivr.net/npm/docx-preview@0.4.1/ https://cdn.jsdelivr.net/npm/exceljs@4.4.0/ https://cdn.jsdelivr.net/npm/@aiden0z/pptx-renderer@1.3.0/"
    };
}

/// 界面的 CSP，挂在 serve_ui 发出的每个 html 上。内容和为什么这么写见桌面壳的 UI_CSP。
/// 只比桌面壳多一处：connect-src 认 `blob:` / `data:`——LINK_SCRIPT 的 save 要 fetch 页面的 blob 下载地址
/// 读出字节交给分享面板，不放的话 fetch 被 CSP 挡掉（实测，Android 上报 Refused to connect）。
const UI_CSP: &str = concat!(
    "default-src 'self' satu: http://satu.localhost https://satu.localhost; ",
    "base-uri 'none'; ",
    "object-src 'none'; ",
    "script-src 'self' satu: http://satu.localhost https://satu.localhost ", ui_cdn!(), "; ",
    "style-src 'self' satu: http://satu.localhost https://satu.localhost 'unsafe-inline' ", ui_cdn!(), " https://fonts.googleapis.com; ",
    "font-src 'self' satu: http://satu.localhost https://satu.localhost data: ", ui_cdn!(), " https://fonts.gstatic.com; ",
    "img-src 'self' satu: http://satu.localhost https://satu.localhost data: blob: https: http:; ",
    "media-src 'self' satu: http://satu.localhost https://satu.localhost data: blob: https: http:; ",
    "connect-src 'self' satu: http://satu.localhost https://satu.localhost ipc: http://ipc.localhost https: http: wss: ws: blob: data:; ",
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

/**
 * 正式包里打进去的界面文件有哪些（键是 `/index.html` 这种，带前导斜杠）。只建一次。
 *
 * **为什么要先问「在不在」再取。** Tauri 的 `asset_resolver().get` 找不到文件时会自己回落到
 * index.html（tauri 的 manager/mod.rs 的 get_asset），而 MIME 是按请求的路径定的——不先判断的话，
 * 刷新 `/a/<botId>` 或者少了一个脚本，拿到的都是 index.html 的字节、却标成别的类型：页面
 * 白屏、脚本报语法错。debug 构建读仓库目录，看不出这个问题。
 */
fn embedded_ui(app: &AppHandle) -> &'static HashSet<String> {
    static KEYS: std::sync::OnceLock<HashSet<String>> = std::sync::OnceLock::new();
    KEYS.get_or_init(|| app.asset_resolver().iter().map(|(k, _)| k.into_owned()).collect())
}

/// 第一个真在包里（或仓库目录里）的候选，候选次序见 ui_candidates。
fn pick_ui_file(rel: &str, exists: impl Fn(&str) -> bool) -> Option<String> {
    ui_candidates(rel).into_iter().find(|c| exists(c))
}

fn read_ui_file(app: &AppHandle, rel: &str) -> Option<(Vec<u8>, &'static str)> {
    if let Some(dir) = ui_dir() {
        let path_of = |c: &str| {
            let mut file = dir.clone();
            for seg in c.split('/') {
                file.push(seg);
            }
            file
        };
        let hit = pick_ui_file(rel, |c| path_of(c).is_file())?;
        return fs::read(path_of(&hit)).ok().map(|b| (b, mime_of(&hit)));
    }
    let keys = embedded_ui(app);
    let hit = pick_ui_file(rel, |c| keys.contains(&format!("/{c}")))?;
    app.asset_resolver().get(format!("/{hit}")).map(|a| (a.bytes().to_vec(), mime_of(&hit)))
}

/// 每次加载从原生状态取最新地址。手机保留唯一的窗口，切换后重新加载登录页即可；
/// 不能把地址固定进 initialization_script，否则重载后仍会连回旧服务器。
fn link_script(gateway: &Url) -> String {
    LINK_SCRIPT
        .replace("__OPEN_PATH__", &serde_json::to_string(OPEN_PATH).expect("常量总能编成 JSON"))
        .replace("__GATEWAY_URL__", &serde_json::to_string(gateway.as_str().trim_end_matches('/')).expect("字符串总能编成 JSON"))
}

fn bootstrap_html(bytes: &[u8]) -> Vec<u8> {
    String::from_utf8_lossy(bytes)
        .replacen("</head>", &format!("<script src=\"{BOOTSTRAP_PATH}\"></script>\n</head>"), 1)
        .into_bytes()
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
    if request.uri().path() == BOOTSTRAP_PATH {
        let server = app.state::<GatewayServer>();
        let gateway = server.0.lock().expect("Gateway 状态锁");
        return tauri::http::Response::builder()
            .header("content-type", "text/javascript; charset=utf-8")
            .header("cache-control", "no-store")
            .body(Cow::Owned(link_script(&gateway).into_bytes()))
            .unwrap();
    }
    let Some(rel) = ui_rel_path(request.uri().path()) else { return not_found() };
    let Some((bytes, mime)) = read_ui_file(app, &rel) else {
        return not_found();
    };
    let mut response = tauri::http::Response::builder()
        .status(tauri::http::StatusCode::OK)
        .header("content-type", mime)
        .header("cache-control", "no-store");
    if mime.starts_with("text/html") {
        response = response.header("content-security-policy", UI_CSP);
    }
    let bytes = if mime.starts_with("text/html") { bootstrap_html(&bytes) } else { bytes };
    response.body(Cow::Owned(bytes)).unwrap()
}

fn build_window(app: &AppHandle) -> tauri::Result<()> {
    let handle = app.clone();
    let ui = Url::parse(UI_ORIGIN).expect("UI_ORIGIN 是常量");
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::CustomProtocol(ui))
        .title("Satuwork")
        .on_navigation(move |url| {
            let base = handle.state::<GatewayServer>().0.lock().expect("Gateway 状态锁").clone();
            allow_navigation(&handle, &base, url)
        });
    #[cfg(debug_assertions)]
    let builder = builder.initialization_script(DEBUG_SCRIPT);
    builder.build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_satu_push::init())
        .plugin(tauri_plugin_satu_share::init())
        .register_uri_scheme_protocol(UI_SCHEME, |ctx, request| serve_ui(&ctx.app_handle().clone(), &request))
        .invoke_handler(tauri::generate_handler![debug_log, gateway_server_info, check_gateway_server, use_gateway_server])
        .setup(|app| {
            let gateway = gateway_url(app.handle()).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            app.manage(GatewayServer(Mutex::new(gateway)));
            build_window(&app.handle().clone())?;
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
        assert_eq!(pick_server(false, None, Some("http://127.0.0.1:3080\n"), Some("http://127.0.0.1:3081")), DEFAULT_SERVER);
        assert_eq!(pick_server(true, None, Some(" http://127.0.0.1:3080\n"), Some("http://127.0.0.1:3081")), "http://127.0.0.1:3080");
        assert_eq!(pick_server(true, None, Some("  \n"), Some("http://127.0.0.1:3081")), "http://127.0.0.1:3081");
        assert_eq!(pick_server(true, None, None, Some("  ")), DEFAULT_SERVER);
        assert_eq!(pick_server(true, None, None, None), DEFAULT_SERVER);
    }

    #[test]
    fn saved_server_wins_in_release_and_debug() {
        for debug in [false, true] {
            assert_eq!(pick_server(debug, Some(" https://gw.corp.example\n"), Some("http://dev"), Some("http://baked")), "https://gw.corp.example");
            assert_eq!(pick_server(debug, Some("  "), None, None), DEFAULT_SERVER);
        }
    }

    #[test]
    fn bootstrap_uses_the_current_gateway_before_app_scripts() {
        let html = bootstrap_html(b"<head></head><body><script src=\"/state.js\"></script></body>");
        let html = String::from_utf8(html).unwrap();
        assert!(html.find(BOOTSTRAP_PATH).unwrap() < html.find("/state.js").unwrap());
        let first = link_script(&u("https://old.example"));
        let next = link_script(&u("https://new.example:3080"));
        assert!(first.contains("window.__SATUWORK_GATEWAY__ = \"https://old.example\""));
        assert!(next.contains("window.__SATUWORK_GATEWAY__ = \"https://new.example:3080\""));
        assert!(!next.contains("old.example"));
        assert!(next.contains("location.replace('/login')"));
    }

    #[test]
    fn health_check_requires_a_successful_gateway_response() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        for (status, body, pass) in [
            ("200 OK", r#"{"ok":true}"#, true),
            ("200 OK", r#"{"ok":false}"#, false),
            ("200 OK", r#"{"ok":"true"}"#, false),
            ("200 OK", "<html>another service</html>", false),
            ("503 Service Unavailable", r#"{"ok":true}"#, false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = u(&format!("http://{}", listener.local_addr().unwrap()));
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut request = [0; 4096];
                let size = stream.read(&mut request).unwrap();
                assert!(String::from_utf8_lossy(&request[..size]).starts_with("GET /health HTTP/1.1"));
                write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            assert_eq!(check_server(&url).is_ok(), pass, "{status}: {body}");
            server.join().unwrap();
        }
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
    fn mail_phone_and_web_go_to_the_system() {
        for s in ["https://a.com/p", "http://a.com", "mailto:a@b.com", "tel:+6512345678", "sms:+6512345678"] {
            assert!(hand_to_system(&u(s)), "{s}");
        }
        for s in ["blob:satu://localhost/abc", "data:text/plain,hi", "about:blank", "javascript:alert(1)", "satu://localhost/a"] {
            assert!(!hand_to_system(&u(s)), "{s}");
        }
        let gw = u("https://gw.example.com");
        assert_eq!(open_target(&gw, "mailto:a@b.com?subject=hi").unwrap().as_str(), "mailto:a@b.com?subject=hi");
        assert_eq!(open_target(&gw, "tel:+6512345678").unwrap().as_str(), "tel:+6512345678");
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
        // 先问在不在再取：不存在的路径（单页路由）落到 index.html，MIME 按 index.html 定。
        let have: HashSet<&str> = ["index.html", "chat.js"].into_iter().collect();
        let exists = |c: &str| have.contains(c);
        assert_eq!(pick_ui_file("chat.js", exists).as_deref(), Some("chat.js"));
        assert_eq!(pick_ui_file("ui/chat.js", exists).as_deref(), Some("chat.js"));
        assert_eq!(pick_ui_file("a/bot-1", exists).as_deref(), Some("index.html"));
        assert_eq!(mime_of(&pick_ui_file("a/bot-1", exists).unwrap()), "text/html; charset=utf-8");
        assert_eq!(pick_ui_file("x.js", |_| false), None);
    }
}
