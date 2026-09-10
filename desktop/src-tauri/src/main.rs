#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/**
 * Satuwork 桌面壳。
 *
 * **它不装前端。** 界面还是 Gateway 那一份（gateway/ui），由 Gateway 自己发；这个壳
 * 做的事只有一件：把一个没有地址栏的窗口指到那台 Gateway 上。
 *
 * 为什么不把 ui 打进包里——那样每一条 fetch 都成了跨源请求，Gateway 要加 CORS，而
 * 真正会当场坏掉的是对话页右栏那块桌面：它那张 `satu_desk_*` 是 SameSite=Lax 的
 * cookie，跨源之后浏览器连存都不存（见 gateway/src/desktop.ts 开头那段）。同源是
 * 那条路唯一的前提，而「直接装远端页面」是保住同源最便宜的办法。
 *
 * 代价说清楚：没网就是一片空白，打开必须连得到 Gateway。这不亏——这个界面本来就
 * 没有一屏是离线能用的。换来的是前端**永远不会**和服务端版本漂开。
 *
 * 包里唯一的页面是 shell/index.html——「连哪台 Gateway」那一屏。它是本地资源，所以
 * 能调设置命令；主窗口装的是远端页面，只拿得到本地 Bot 那组窄命令。两组命令分别由
 * capability 放行，不能借远端页面去改 Gateway 地址。
 */

const SETUP: &str = "setup";
const MAIN: &str = "main";
const SWITCH_ITEM: &str = "switch-server";

/**
 * 「请帮我在外面打开这个地址」的暗号。
 *
 * 走的是一条**同源的普通 http 路径**，不是自定义协议——自定义协议在各家 webview 里
 * 会不会走到导航回调，是要一个个试的；同源路径一定会。Gateway 不认这个路径，但它也
 * 永远走不到 Gateway：导航回调在同源判断**之前**就把它截下来了。
 */
const OPEN_PATH: &str = "/__satuwork_open";

/** 新开的窗口编号。同一个 label 开第二次会失败，所以每开一扇加一。 */
static EXTRA: AtomicUsize = AtomicUsize::new(0);

/** 启动时那句「为什么没直接进去」。设置屏起来之后自己来取。 */
#[derive(Default)]
struct Startup(Mutex<String>);

/// 一颗跑着的本地 Bot：进程，和它听的那个口。口要记下来——页面直连本机就靠它
/// （隧道拆了，见 gateway/ui/data.js 的 localRoute），而端口是这里随机分的，别处没有。
struct LocalBotProc {
    child: Child,
    port: u16,
}

#[derive(Default)]
struct LocalBots(Mutex<HashMap<String, LocalBotProc>>);

/// 最近一次成功启动用的 Gateway 地址和席位票，给每小时一次的运行时自查用。
#[derive(Default)]
struct UpdateSource(Mutex<Option<(Url, String)>>);
static UPDATER_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalBotConfig {
    bot_id: String,
    gateway_url: String,
    access_token: String,
    api_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalBotStatus {
    running: bool,
    /// 在跑时本机监听的端口；页面拿它把这颗 Bot 的会话请求直接打到 127.0.0.1。
    port: Option<u16>,
    workspace: String,
    runtime_version: Option<String>,
    pending_runtime_version: Option<String>,
    runtime_update_error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalBotRelease {
    version: String,
    sha256: String,
    size: u64,
    url: String,
    min_desktop_version: String,
    mandatory: bool,
    note: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovedDirectory {
    path: String,
    mount: String,
}

/** 地址落磁盘。一台机器一个人用，没必要进 keychain——它不是凭据，只是个地址。 */
fn server_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("server.txt"))
}

/**
 * 这次该连哪儿。
 *
 * `SATUWORK_SERVER` **只覆盖，不写盘**：它是给开发和排查用的，跑完一次不该改掉用户
 * 存着的那个地址。
 */
fn read_server(app: &AppHandle) -> Option<String> {
    if let Ok(from_env) = std::env::var("SATUWORK_SERVER") {
        let s = from_env.trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    let raw = fs::read_to_string(server_file(app)?).ok()?;
    let s = raw.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn write_server(app: &AppHandle, url: &str) -> Result<(), String> {
    let path = server_file(app).ok_or("找不到配置目录")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("建配置目录失败：{e}"))?;
    }
    fs::write(path, url).map_err(|e| format!("写配置失败：{e}"))
}

/**
 * 人手打的地址得能用。`gw.example.com`、`192.168.1.10:3080` 这种不带协议的最常见，
 * 一律当 http 补上——内网部署本来就是 http（Gateway 自己也按这个假设发 cookie）。
 *
 * 只认 http/https：别的协议进到 WebviewUrl::External 里就是一扇没人审过的门。
 */
fn normalize(raw: &str) -> Result<Url, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("请填 Gateway 地址".into());
    }
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else {
        format!("http://{s}")
    };
    let url = Url::parse(&with_scheme).map_err(|e| format!("这个地址读不懂：{e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("只认 http 和 https，不认 {other}")),
    }
    if url.host_str().unwrap_or("").is_empty() {
        return Err("地址里没有主机名".into());
    }
    Ok(url)
}

/**
 * 打开之前先敲一下门。
 *
 * **不敲的话，连不上的表现是一片空白。** WKWebView 没有内建的错误页，装不上东西时
 * 窗口里一个字都没有——和「服务器正在重启」「地址打错一个字母」「公司 VPN 没连」
 * 长得一模一样，而人在这三种情况下要做的事完全不同。
 *
 * 只到 TCP 为止：解析得了域名、连得上端口就算数。**它证明不了那头是 Gateway**——
 * 端口通着但服务 500、或者连到了另一个服务，这里都看不出来。要的只是把最常见的那
 * 几种「白窗口」翻译成一句人话，不是健康检查。
 */
fn reachable(url: &Url) -> Result<(), String> {
    let host = url.host_str().unwrap_or("").to_string();
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("解析不了 {host}：{e}"))?;
    let mut last = String::from("没有可用地址");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, Duration::from_secs(3)) {
            Ok(_) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("连不上 {host}:{port}（{last}）"))
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/**
 * 装在远端页面里的一小段：**把「开新窗口」翻译成一次导航**。
 *
 * 起因是实测出来的一件事：`target="_blank"` 的链接和 `window.open()` 在这个 webview
 * 里都是**空操作**——不报错、不开窗、连请求都不发。而 gateway/ui 的外链一律带
 * `target="_blank"`（markdown.js 渲染的每个链接、chat.js 那个「打开桌面」按钮），
 * 于是在桌面端它们全部变成了点不动的死链，界面上还没有任何提示。
 *
 * 这段脚本把它们改写成一次到 OPEN_PATH 的普通导航，交给 Rust 那边分流：同源的另开
 * 一扇应用窗口，站外的交给系统浏览器。
 *
 * **不改同源的普通链接**——那是页面自己的路由，改了等于把界面拆了。
 */
const LINK_SCRIPT: &str = r#"
(function () {
  // 远端页面本身和浏览器里打开的是同一份。给它一个只由桌面壳注入的标记，让登录票
  // 可以落到持久存储；普通浏览器仍保持「关标签页即退出」的 sessionStorage 语义。
  window.__SATUWORK_DESKTOP__ = true
  window.__SATUWORK_LOCAL_BOT__ = {
    start: function (config) { return window.__TAURI_INTERNALS__.invoke('start_local_bot', { config: config }) },
    stop: function (botId) { return window.__TAURI_INTERNALS__.invoke('stop_local_bot', { botId: botId }) },
    status: function (botId) { return window.__TAURI_INTERNALS__.invoke('local_bot_status', { botId: botId }) },
    approveDirectory: function (botId) { return window.__TAURI_INTERNALS__.invoke('approve_local_directory', { botId: botId }) }
  }
  if (window.__satuLinkPatched) return
  window.__satuLinkPatched = true
  function hand(raw) {
    try {
      var abs = new URL(raw, location.href).href
      location.href = location.origin + '__OPEN_PATH__?u=' + encodeURIComponent(abs)
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
 * 每一次导航都过这里。
 *
 * 要挡的**只有一件事**：把唯一的窗口导航到站外。这个壳没有地址栏也没有后退，页面
 * 一旦跳出去，人就被关在一个回不来的地方了（只剩菜单里那条「切换服务器…」）。
 *
 * 所以按 scheme 分流：**不是 http/https 的一律放行**。第一版是「白名单 + 同源」，
 * 而白名单永远漏得掉——`blob:`（附件预览喂给 iframe 的那个）漏了就是预览白屏，
 * `ws:` 漏了就是桌面没画面，而同源比较里 `ws` 和 `http` 本来就不是同一个字。
 *
 * 拦这些也拦不住什么：页面里的 JS 想连哪儿就能连哪儿，这条回调不是它的边界。
 * 它是「窗口跑没跑掉」的边界，仅此而已。
 */
fn allow_navigation(app: &AppHandle, base: &Url, url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => {}
        _ => return true,
    }
    if same_origin(url, base) {
        if url.path() == OPEN_PATH {
            route_open(app, base, url);
            return false;
        }
        return true;
    }
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
    false
}

/** 暗号里带的那个地址：同源的另开一扇应用窗口，站外的交给系统浏览器。 */
fn route_open(app: &AppHandle, base: &Url, url: &Url) {
    let target = url
        .query_pairs()
        .find(|(k, _)| k == "u")
        .map(|(_, v)| v.to_string())
        .unwrap_or_default();
    let Ok(parsed) = Url::parse(&target) else {
        return;
    };
    match parsed.scheme() {
        "http" | "https" => {}
        // 暗号是页面递过来的，页面上的内容不全是我们写的（markdown 里的链接来自模型
        // 和用户）。只有 http/https 往下走，别的一律当没发生。
        _ => return,
    }
    if same_origin(&parsed, base) {
        let label = format!("extra-{}", EXTRA.fetch_add(1, Ordering::Relaxed));
        let _ = build_window(app, &label, parsed, base.clone(), "Satuwork");
    } else {
        let _ = app.opener().open_url(parsed.as_str(), None::<&str>);
    }
}

/** 装远端页面的窗口都从这儿出：同一套导航守卫，同一段链接脚本。 */
fn build_window(
    app: &AppHandle,
    label: &str,
    url: Url,
    base: Url,
    title: &str,
) -> tauri::Result<()> {
    let handle = app.clone();
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 600.0)
        .initialization_script(&LINK_SCRIPT.replace("__OPEN_PATH__", OPEN_PATH))
        .on_navigation(move |url| allow_navigation(&handle, &base, url))
        .build()?;
    Ok(())
}

fn open_main(app: &AppHandle, url: Url) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(MAIN) {
        win.set_focus()?;
        return Ok(());
    }
    build_window(app, MAIN, url.clone(), url, "Satuwork")
}

fn open_setup(app: &AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(SETUP) {
        win.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, SETUP, WebviewUrl::App("index.html".into()))
        .title("连接 Satuwork")
        .inner_size(520.0, 460.0)
        .resizable(false)
        .build()?;
    Ok(())
}

#[tauri::command]
fn current_server(app: AppHandle) -> String {
    read_server(&app).unwrap_or_default()
}

/** 启动时没能直接进去的原因。取一次就清掉——它说的是「刚才」，不是「现在」。 */
#[tauri::command]
fn startup_error(app: AppHandle) -> String {
    let state = app.state::<Startup>();
    let mut slot = state.0.lock().unwrap();
    std::mem::take(&mut *slot)
}

/**
 * 连。**连不上就不写盘**——写了的话下次启动会直接奔那个地址去，而那正是「白窗口」
 * 的来源；停在这一屏、把话说清楚，人还在键盘前面，改一个字母就好了。
 */
#[tauri::command]
fn connect(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = normalize(&url)?;
    reachable(&parsed)?;
    write_server(&app, parsed.as_str())?;
    open_main(&app, parsed).map_err(|e| e.to_string())?;
    if let Some(win) = app.get_webview_window(SETUP) {
        let _ = win.close();
    }
    Ok(())
}

fn safe_bot_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Bot id 不合法".into());
    }
    Ok(id.to_string())
}

fn bot_paths(app: &AppHandle, bot_id: &str) -> Result<(PathBuf, PathBuf), String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("local-bots")
        .join(bot_id);
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    let work = docs.join("Satuwork").join(bot_id);
    fs::create_dir_all(&data).map_err(|e| format!("创建本地 Bot 数据目录失败：{e}"))?;
    fs::create_dir_all(&work).map_err(|e| format!("创建默认工作目录失败：{e}"))?;
    Ok((data, work))
}

fn runtime_home(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .map(|dir| dir.join("local-runtime"))
}

fn safe_runtime_version(raw: &str) -> Result<String, String> {
    let version = raw.trim();
    if version.is_empty()
        || version.len() > 96
        || version.starts_with('.')
        || !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
    {
        return Err("本地运行时版本号不合法".into());
    }
    Ok(version.to_string())
}

fn read_runtime_pointer(home: &Path, name: &str) -> Option<String> {
    let value = fs::read_to_string(home.join(name)).ok()?;
    let version = safe_runtime_version(&value).ok()?;
    let entry = home
        .join("releases")
        .join(&version)
        .join("bot/bin/satuwork.mjs");
    entry.is_file().then_some(version)
}

fn write_runtime_pointer(home: &Path, name: &str, version: &str) -> Result<(), String> {
    let version = safe_runtime_version(version)?;
    fs::create_dir_all(home).map_err(|e| format!("创建本地运行时目录失败：{e}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let next = home.join(format!(".{name}.{nonce}.next"));
    fs::write(&next, format!("{version}\n")).map_err(|e| format!("写本地运行时指针失败：{e}"))?;
    let target = home.join(name);
    if let Err(first) = fs::rename(&next, &target) {
        // Windows 不允许 rename 覆盖已有文件。指针只有一行，删旧值后的窗口也很短；
        // 即便机器这时断电，下一次仍会回退到安装包内置版本。
        if target.exists() {
            fs::remove_file(&target).map_err(|e| format!("替换本地运行时指针失败：{e}"))?;
            fs::rename(&next, &target).map_err(|e| format!("替换本地运行时指针失败：{e}"))?;
        } else {
            let _ = fs::remove_file(&next);
            return Err(format!("替换本地运行时指针失败：{first}"));
        }
    }
    Ok(())
}

fn unpack_runtime(archive: &Path, destination: &Path) -> Result<(), String> {
    if destination.join("bot/bin/satuwork.mjs").is_file() {
        return Ok(());
    }
    let parent = destination.parent().ok_or("本地运行时目录不完整")?;
    fs::create_dir_all(parent).map_err(|e| format!("创建本地运行时目录失败：{e}"))?;
    if destination.exists() {
        fs::remove_dir_all(destination).map_err(|e| format!("清理损坏的本地运行时失败：{e}"))?;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staging = parent.join(format!(".install-{nonce}"));
    let bot = staging.join("bot");
    fs::create_dir_all(&bot).map_err(|e| format!("创建本地运行时临时目录失败：{e}"))?;
    let result: Result<(), String> = (|| {
        let file = fs::File::open(archive).map_err(|e| format!("打开本地运行时包失败：{e}"))?;
        let gz = flate2::read::GzDecoder::new(file);
        tar::Archive::new(gz)
            .unpack(&bot)
            .map_err(|e| format!("解开本地运行时失败：{e}"))?;
        if !bot.join("bin/satuwork.mjs").is_file() {
            return Err("本地运行时包缺少 bin/satuwork.mjs".into());
        }
        fs::rename(&staging, destination).map_err(|e| format!("安装本地运行时失败：{e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn ensure_bundled_runtime(app: &AppHandle) -> Result<Option<String>, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("runtime");
    let archive = resources.join("bot.tgz");
    if !archive.is_file() {
        return Ok(None);
    }
    let wanted = safe_runtime_version(
        fs::read_to_string(resources.join("VERSION"))
            .map_err(|e| format!("读取内置运行时版本失败：{e}"))?
            .as_str(),
    )?;
    let home = runtime_home(app)?;
    let destination = home.join("releases").join(&wanted);
    unpack_runtime(&archive, &destination)?;
    if read_runtime_pointer(&home, "CURRENT").is_none() {
        write_runtime_pointer(&home, "CURRENT", &wanted)?;
    }
    Ok(Some(wanted))
}

fn promote_pending_runtime(app: &AppHandle) -> Result<Option<(String, String)>, String> {
    let home = runtime_home(app)?;
    let Some(pending) = read_runtime_pointer(&home, "PENDING") else {
        return Ok(None);
    };
    let previous = read_runtime_pointer(&home, "CURRENT").unwrap_or_default();
    write_runtime_pointer(&home, "CURRENT", &pending)?;
    let _ = fs::remove_file(home.join("PENDING"));
    Ok(Some((previous, pending)))
}

fn bot_runtime(app: &AppHandle) -> Result<(PathBuf, PathBuf, Option<String>), String> {
    if let Ok(raw) = std::env::var("SATUWORK_BOT_ROOT") {
        let root = PathBuf::from(raw);
        let entry = root.join("bin/satuwork.mjs");
        if !entry.is_file() {
            return Err("SATUWORK_BOT_ROOT 里没有 bin/satuwork.mjs".into());
        }
        return Ok((root, entry, None));
    }

    // `npm run dev` 必须跟着仓库源码走，发布构建才使用可升级的版本目录。
    #[cfg(debug_assertions)]
    {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../bot");
        if source.join("bin/satuwork.mjs").is_file() {
            return Ok((
                source.clone(),
                source.join("bin/satuwork.mjs"),
                Some("development".into()),
            ));
        }
    }

    let bundled = ensure_bundled_runtime(app)?;
    let home = runtime_home(app)?;
    let version = read_runtime_pointer(&home, "CURRENT").or(bundled);
    if let Some(version) = version {
        let root = home.join("releases").join(&version).join("bot");
        let entry = root.join("bin/satuwork.mjs");
        if entry.is_file() {
            return Ok((root, entry, Some(version)));
        }
    }
    Err("Desktop 包里没有本地 Bot 运行时，请重新安装完整版本".into())
}

fn local_runtime_target() -> Result<(&'static str, &'static str), String> {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        "linux" => "linux",
        other => return Err(format!("暂不支持 {other} 的本地 Bot 更新")),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => return Err(format!("暂不支持 {other} 架构的本地 Bot 更新")),
    };
    Ok((platform, arch))
}

fn version_numbers(raw: &str) -> Option<[u64; 3]> {
    let core = raw
        .trim()
        .trim_start_matches('v')
        .split(['-', '+'])
        .next()?;
    let mut parts = core.split('.');
    let parsed = [
        parts.next()?.parse().ok()?,
        parts.next().unwrap_or("0").parse().ok()?,
        parts.next().unwrap_or("0").parse().ok()?,
    ];
    Some(parsed)
}

fn desktop_version_supports(have: &str, minimum: &str) -> bool {
    match (version_numbers(have), version_numbers(minimum)) {
        (Some(have), Some(minimum)) => have >= minimum,
        _ => false,
    }
}

fn runtime_update_error(app: &AppHandle, message: Option<&str>) {
    let Ok(home) = runtime_home(app) else {
        return;
    };
    let path = home.join("LAST_ERROR");
    match message {
        Some(message) => {
            let _ = fs::create_dir_all(&home);
            let _ = fs::write(path, message.chars().take(500).collect::<String>());
        }
        None => {
            let _ = fs::remove_file(path);
        }
    }
}

/** 下载并暂存适合本机的最新版。任何失败都只记状态，不阻止旧 Bot 启动。 */
fn stage_runtime_update(
    app: &AppHandle,
    gateway: &Url,
    access_token: &str,
) -> Result<Option<String>, String> {
    if cfg!(debug_assertions) || std::env::var_os("SATUWORK_BOT_ROOT").is_some() {
        return Ok(None);
    }
    let _ = ensure_bundled_runtime(app)?;
    let home = runtime_home(app)?;
    let current = read_runtime_pointer(&home, "CURRENT").unwrap_or_default();
    let (platform, arch) = local_runtime_target()?;
    let mut endpoint = gateway
        .join("/runtime/local-bot-release")
        .map_err(|e| format!("生成更新检查地址失败：{e}"))?;
    endpoint
        .query_pairs_mut()
        .append_pair("platform", platform)
        .append_pair("arch", arch)
        .append_pair("have", &current);
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .redirect(Policy::none())
        .build()
        .map_err(|e| format!("创建更新请求失败：{e}"))?;
    let response = client
        .get(endpoint.as_str())
        .bearer_auth(access_token)
        .send()
        .map_err(|e| format!("检查本地运行时更新失败：{e}"))?;
    if response.status().as_u16() == 204 {
        runtime_update_error(app, None);
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "检查本地运行时更新失败：HTTP {}",
            response.status()
        ));
    }
    let release: LocalBotRelease = response
        .json()
        .map_err(|e| format!("读取本地运行时更新信息失败：{e}"))?;
    let desktop_version = app.package_info().version.to_string();
    if !desktop_version_supports(&desktop_version, &release.min_desktop_version) {
        return Err(format!(
            "本地 Bot 新版本需要 Satuwork Desktop {} 或更高版本；当前是 {}，请先升级 Desktop",
            release.min_desktop_version, desktop_version
        ));
    }
    let version = safe_runtime_version(&release.version)?;
    let expected_suffix = format!("-{platform}-{arch}");
    if !version.ends_with(&expected_suffix) {
        return Err("服务器返回了不适合本机的运行时".into());
    }
    if release.sha256.len() != 64 || !release.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("服务器返回的运行时校验值不合法".into());
    }
    if release.size == 0 || release.size > 256 * 1024 * 1024 {
        return Err("服务器返回的运行时大小不合法".into());
    }
    let download_url = Url::parse(&release.url).map_err(|e| format!("更新地址不合法：{e}"))?;
    if !same_origin(gateway, &download_url) {
        return Err("本地运行时下载地址与 Gateway 不同源".into());
    }
    let mut response = client
        .get(download_url.as_str())
        .bearer_auth(access_token)
        .send()
        .map_err(|e| format!("下载本地运行时失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载本地运行时失败：HTTP {}", response.status()));
    }
    let archive = home.join(format!(".{version}.download"));
    let mut file = fs::File::create(&archive).map_err(|e| format!("创建更新临时文件失败：{e}"))?;
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    let result: Result<(), String> = (|| {
        loop {
            let read = response
                .read(&mut buffer)
                .map_err(|e| format!("下载本地运行时失败：{e}"))?;
            if read == 0 {
                break;
            }
            size += read as u64;
            if size > release.size || size > 256 * 1024 * 1024 {
                return Err("下载的本地运行时超过声明大小".into());
            }
            hash.update(&buffer[..read]);
            file.write_all(&buffer[..read])
                .map_err(|e| format!("保存本地运行时失败：{e}"))?;
        }
        file.sync_all()
            .map_err(|e| format!("保存本地运行时失败：{e}"))?;
        if size != release.size {
            return Err("下载的本地运行时大小与声明不符".into());
        }
        let actual = format!("{:x}", hash.finalize());
        if actual != release.sha256.to_ascii_lowercase() {
            return Err("下载的本地运行时 SHA-256 校验失败".into());
        }
        let destination = home.join("releases").join(&version);
        unpack_runtime(&archive, &destination)?;
        write_runtime_pointer(&home, "PENDING", &version)?;
        Ok(())
    })();
    let _ = fs::remove_file(&archive);
    result?;
    runtime_update_error(app, None);
    let _ = (
        &release.min_desktop_version,
        release.mandatory,
        &release.note,
    );
    Ok(Some(version))
}

fn node_in_runtime(runtime: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    return runtime.join("node").join("node.exe");
    #[cfg(not(target_os = "windows"))]
    return runtime.join("node").join("bin").join("node");
}

fn node_program(app: &AppHandle) -> PathBuf {
    if let Ok(raw) = std::env::var("SATUWORK_NODE") {
        return PathBuf::from(raw);
    }
    // `tauri dev` 会把 resources 再复制到 target/debug。macOS 对带嵌入签名的 Node
    // 做这次复制/临时签名后，可能留下互相冲突的 attached signature，内核会在 exec
    // 之前直接 SIGKILL（日志是 `embedded signature doesn't match attached signature`）。
    // 开发版和 bot_runtime 一样直接走源码侧资源；正式包仍只执行 .app 内的版本。
    #[cfg(debug_assertions)]
    {
        let source = node_in_runtime(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime"));
        if source.is_file() {
            return source;
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = node_in_runtime(&resources.join("runtime"));
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from("node")
}

fn runtime_status(app: &AppHandle, running: bool, port: Option<u16>, workspace: &Path) -> LocalBotStatus {
    let home = runtime_home(app).ok();
    LocalBotStatus {
        running,
        port: if running { port } else { None },
        workspace: workspace.display().to_string(),
        runtime_version: home
            .as_deref()
            .and_then(|home| read_runtime_pointer(home, "CURRENT")),
        pending_runtime_version: home
            .as_deref()
            .and_then(|home| read_runtime_pointer(home, "PENDING")),
        runtime_update_error: home
            .as_deref()
            .and_then(|home| fs::read_to_string(home.join("LAST_ERROR")).ok())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_local_bot_process(
    app: &AppHandle,
    config: &LocalBotConfig,
    bot_id: &str,
    gateway: &Url,
    data: &Path,
    work: &Path,
    port: u16,
    browser_port: u16,
) -> Result<Child, String> {
    let (root, entry, _) = bot_runtime(app)?;
    let log_path = data.join("runtime.log");
    if fs::metadata(&log_path).is_ok_and(|meta| meta.len() > 2 * 1024 * 1024) {
        let _ = fs::write(&log_path, b"");
    }
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("创建本地 Bot 日志失败：{e}"))?;
    let node = node_program(app);
    let _ = writeln!(
        log,
        "\n--- {} Desktop 启动本地 Bot ---\nNode: {}\nRuntime: {}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        node.display(),
        entry.display()
    );
    let stderr = log
        .try_clone()
        .map_err(|e| format!("打开本地 Bot 错误日志失败：{e}"))?;
    let mut command = Command::new(node);
    command
        .arg("--import")
        .arg("tsx")
        .arg(entry)
        .current_dir(root)
        .env("SATUWORK_RUNTIME_KIND", "local")
        .env("SATUWORK_DESKTOP_PID", std::process::id().to_string())
        .env("SATUWORK_BOT_ID", bot_id)
        .env("SATUWORK_BOT_PORT", port.to_string())
        .env("SATUWORK_CDP_PORT", browser_port.to_string())
        .env("SATUWORK_HOME", data)
        .env("SATUWORK_WORK_DIR", work)
        .env("SATUWORK_APPROVED_DIRS", data.join("approved-dirs.json"))
        .env("GATEWAY_URL", gateway.as_str().trim_end_matches('/'))
        .env("GATEWAY_TOKEN", &config.access_token)
        .env("GATEWAY_API_KEY", &config.api_key)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Bot 与它拉起的独立 Chrome 在同一进程组；停止 Bot 时可以一并清掉，不留孤儿进程。
        command.process_group(0);
    }
    command
        .spawn()
        .map_err(|e| format!("启动本地 Bot 失败：{e}"))
}

fn local_bot_log_tail(data: &Path, config: &LocalBotConfig) -> String {
    let Ok(raw) = fs::read_to_string(data.join("runtime.log")) else {
        return String::new();
    };
    let start = raw
        .char_indices()
        .rev()
        .nth(3_999)
        .map(|(index, _)| index)
        .unwrap_or(0);
    raw[start..]
        .replace(&config.access_token, "<redacted>")
        .replace(&config.api_key, "<redacted>")
        .trim()
        .to_string()
}

fn verify_local_bot_started(
    mut child: Child,
    data: &Path,
    config: &LocalBotConfig,
) -> Result<Child, String> {
    // 配置、原生依赖或入口损坏通常会在这一拍退出。不能先回“运行中”再让 UI 静默等死。
    std::thread::sleep(Duration::from_millis(500));
    let Some(status) = child.try_wait().map_err(|e| e.to_string())? else {
        return Ok(child);
    };
    let tail = local_bot_log_tail(data, config);
    let _ = terminate_local_bot(&mut child);
    Err(if tail.is_empty() {
        format!("本地 Bot 启动后立即退出（{status}）")
    } else {
        format!("本地 Bot 启动后立即退出（{status}）：\n{tail}")
    })
}

#[tauri::command]
fn start_local_bot(app: AppHandle, config: LocalBotConfig) -> Result<LocalBotStatus, String> {
    let bot_id = safe_bot_id(&config.bot_id)?;
    let configured = read_server(&app).ok_or("还没有配置 Gateway")?;
    let expected = normalize(&configured)?;
    let gateway = normalize(&config.gateway_url)?;
    if !same_origin(&expected, &gateway) {
        return Err("本地 Bot 的 Gateway 与 Desktop 当前服务器不一致".into());
    }
    if !config.access_token.starts_with("sat_") || !config.api_key.starts_with("sk_sw_") {
        return Err("本地 Bot 凭证格式不对".into());
    }
    let (data, work) = bot_paths(&app, &bot_id)?;
    let state = app.state::<LocalBots>();
    let mut bots = state.0.lock().map_err(|_| "本地 Bot 状态锁损坏")?;
    if let Some(proc_) = bots.get_mut(&bot_id) {
        if proc_.child.try_wait().map_err(|e| e.to_string())?.is_none() {
            let port = proc_.port;
            return Ok(runtime_status(&app, true, Some(port), &work));
        }
        bots.remove(&bot_id);
    }
    // 仅第一颗 Bot 启动前检查和切换。已有 Bot 在跑时只使用同一版本，绝不形成一台
    // Desktop 上多个运行时混跑，更不会为了升级强杀正在执行的任务。
    let mut previous_runtime = None;
    let mut promoted_runtime = None;
    if bots.is_empty() && !cfg!(debug_assertions) && std::env::var_os("SATUWORK_BOT_ROOT").is_none()
    {
        // 第一次联网升级前也先安装内置版，否则新包失败时还没有可回滚目标。
        let _ = ensure_bundled_runtime(&app)?;
        let home = runtime_home(&app)?;
        previous_runtime = read_runtime_pointer(&home, "CURRENT");
        if let Err(error) = stage_runtime_update(&app, &gateway, &config.access_token) {
            runtime_update_error(&app, Some(&error));
        }
        if let Some((_, promoted)) = promote_pending_runtime(&app)? {
            promoted_runtime = Some(promoted);
        }
    }
    // 两个 listener 同时占着，避免内核在第一次释放后把同一个端口又分给 Chrome。
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("分配本地端口失败：{e}"))?;
    let browser_listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("分配浏览器端口失败：{e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let browser_port = browser_listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    drop(listener);
    drop(browser_listener);
    let start = || {
        spawn_local_bot_process(
            &app,
            &config,
            &bot_id,
            &gateway,
            &data,
            &work,
            port,
            browser_port,
        )
    };
    let child = match start() {
        Ok(child) => child,
        Err(error) => {
            // 新版本连进程都拉不起来时立即回滚。旧目录仍保留，所以恢复只改一行指针。
            let can_rollback = promoted_runtime.is_some()
                && previous_runtime.as_deref().is_some_and(|previous| {
                    runtime_home(&app).ok().is_some_and(|home| {
                        home.join("releases")
                            .join(previous)
                            .join("bot/bin/satuwork.mjs")
                            .is_file()
                    })
                });
            if !can_rollback {
                return Err(error);
            }
            let previous = previous_runtime.as_deref().unwrap();
            write_runtime_pointer(&runtime_home(&app)?, "CURRENT", previous)?;
            runtime_update_error(&app, Some(&format!("新运行时启动失败，已回滚：{error}")));
            start()?
        }
    };
    let child = match verify_local_bot_started(child, &data, &config) {
        Ok(child) => child,
        Err(error) if promoted_runtime.is_some() => {
            let previous = previous_runtime
                .as_deref()
                .ok_or_else(|| format!("{error}，但找不到可回滚版本"))?;
            let home = runtime_home(&app)?;
            if !home
                .join("releases")
                .join(previous)
                .join("bot/bin/satuwork.mjs")
                .is_file()
            {
                return Err(format!("{error}，旧版本文件也已损坏"));
            }
            write_runtime_pointer(&home, "CURRENT", previous)?;
            runtime_update_error(&app, Some(&format!("新运行时启动失败，已回滚：{error}")));
            verify_local_bot_started(start()?, &data, &config)?
        }
        Err(error) => return Err(error),
    };
    bots.insert(bot_id, LocalBotProc { child, port });
    // 记下这次的地址和票，运行时自查（每小时一次）拿它去问 Gateway 有没有新版。
    if let Ok(mut src) = app.state::<UpdateSource>().0.lock() {
        *src = Some((gateway.clone(), config.access_token.clone()));
    }
    start_runtime_updater(&app);
    Ok(runtime_status(&app, true, Some(port), &work))
}

/**
 * 每小时自己去问一次有没有新运行时。**只下载、只写 PENDING，不动正在跑的进程**——切换
 * 仍留给下一次「没有本地 Bot 在跑」的启动时刻（见 start_local_bot），现有的回滚逻辑一行不改。
 * 以前只在冷启动前查一次，一台常开的桌面端可能几天不换版。
 */
fn start_runtime_updater(app: &AppHandle) {
    if UPDATER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3600));
        let src = app
            .state::<UpdateSource>()
            .0
            .lock()
            .ok()
            .and_then(|s| s.clone());
        let Some((gateway, token)) = src else { continue };
        if let Err(error) = stage_runtime_update(&app, &gateway, &token) {
            runtime_update_error(&app, Some(&error));
        }
    });
}

fn terminate_local_bot(child: &mut Child) -> Result<(), String> {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.to_string());
            }
        }
    }
    #[cfg(not(unix))]
    child.kill().map_err(|e| e.to_string())?;
    let _ = child.wait();
    Ok(())
}

#[tauri::command]
fn stop_local_bot(app: AppHandle, bot_id: String) -> Result<(), String> {
    let id = safe_bot_id(&bot_id)?;
    if let Some(mut child) = app
        .state::<LocalBots>()
        .0
        .lock()
        .map_err(|_| "本地 Bot 状态锁损坏")?
        .remove(&id)
    {
        terminate_local_bot(&mut child.child).map_err(|e| format!("停止本地 Bot 失败：{e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn local_bot_status(app: AppHandle, bot_id: String) -> Result<LocalBotStatus, String> {
    let id = safe_bot_id(&bot_id)?;
    let (_, work) = bot_paths(&app, &id)?;
    let state = app.state::<LocalBots>();
    let mut bots = state.0.lock().map_err(|_| "本地 Bot 状态锁损坏")?;
    let (running, port) = match bots.get_mut(&id) {
        Some(proc_) => (proc_.child.try_wait().map_err(|e| e.to_string())?.is_none(), Some(proc_.port)),
        None => (false, None),
    };
    if !running {
        bots.remove(&id);
    }
    Ok(runtime_status(&app, running, port, &work))
}

#[tauri::command]
async fn approve_local_directory(
    app: AppHandle,
    bot_id: String,
) -> Result<Option<ApprovedDirectory>, String> {
    let id = safe_bot_id(&bot_id)?;
    let running = {
        let state = app.state::<LocalBots>();
        let mut bots = state.0.lock().map_err(|_| "本地 Bot 状态锁损坏")?;
        match bots.get_mut(&id) {
            Some(proc_) => proc_.child.try_wait().map_err(|e| e.to_string())?.is_none(),
            None => false,
        }
    };
    if !running {
        return Err("这颗本地 Bot 尚未运行，不能批准目录".into());
    }
    let picker = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .set_title("批准本地 Bot 访问文件夹")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let target = selected
        .into_path()
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| format!("读取所选目录失败：{e}"))?;
    if !target.is_dir() {
        return Err("选择的不是文件夹".into());
    }
    let (data, work) = bot_paths(&app, &id)?;
    if target == work || target.starts_with(&work) {
        return Err("这个目录已经在 Bot 的默认工作区内，不需要额外批准".into());
    }

    let manifest = data.join("approved-dirs.json");
    let mut approved: Vec<String> = fs::read_to_string(&manifest)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let shown = target.display().to_string();
    if !approved.iter().any(|path| path == &shown) {
        approved.push(shown.clone());
        fs::write(
            &manifest,
            serde_json::to_vec_pretty(&approved).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("保存目录批准记录失败：{e}"))?;
    }

    let external = work.join("External");
    fs::create_dir_all(&external).map_err(|e| format!("创建外部目录入口失败：{e}"))?;
    let base = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Folder")
        .chars()
        .filter(|c| !c.is_control() && *c != '/' && *c != '\\')
        .take(64)
        .collect::<String>();
    let base = if base.trim().is_empty() {
        "Folder".to_string()
    } else {
        base
    };
    let mut link = external.join(&base);
    for index in 2..1000 {
        if !link.exists() && fs::symlink_metadata(&link).is_err() {
            break;
        }
        if link.canonicalize().ok().as_ref() == Some(&target) {
            return Ok(Some(ApprovedDirectory {
                path: shown,
                mount: format!("External/{}", link.file_name().unwrap().to_string_lossy()),
            }));
        }
        link = external.join(format!("{base}-{index}"));
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).map_err(|e| format!("创建批准目录入口失败：{e}"))?;
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&target, &link)
        .map_err(|e| format!("创建批准目录入口失败：{e}"))?;
    Ok(Some(ApprovedDirectory {
        path: shown,
        mount: format!("External/{}", link.file_name().unwrap().to_string_lossy()),
    }))
}

/**
 * 菜单里那一条「切换服务器…」。
 *
 * **少了它这个壳会砖。** 地址填对了但那台机器换了地方、或者页面被导航到了一个回不来
 * 的地方，界面上又没有地址栏可以改——人只能去删配置文件，而没人知道那个路径。
 *
 * 从系统默认菜单接着加：macOS 上复制粘贴的快捷键是菜单项给的，自己从空菜单搭一份
 * 就等于把 Cmd+C/Cmd+V 弄没了。
 */
fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let switch = MenuItem::with_id(app, SWITCH_ITEM, "切换服务器…", true, None::<&str>)?;
    let submenu = Submenu::with_items(app, "服务器", true, &[&switch])?;
    menu.append(&submenu)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id() != SWITCH_ITEM {
            return;
        }
        // 装着远端页面的窗口全关掉——包括「打开桌面」那种另开的。留着的话它们还指着
        // 老地址，而人正要换一台。
        for (label, win) in app.webview_windows() {
            if label != SETUP {
                let _ = win.close();
            }
        }
        let _ = open_setup(app);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{desktop_version_supports, safe_runtime_version};

    #[test]
    fn runtime_version_cannot_escape_release_directory() {
        assert!(safe_runtime_version("0.1.0+abc-darwin-arm64").is_ok());
        assert!(safe_runtime_version("../CURRENT").is_err());
        assert!(safe_runtime_version("a/b").is_err());
        assert!(safe_runtime_version(".hidden").is_err());
    }

    #[test]
    fn desktop_minimum_version_is_compared_numerically() {
        assert!(desktop_version_supports("0.10.0", "0.2.9"));
        assert!(desktop_version_supports("1.0.0", "1.0.0"));
        assert!(!desktop_version_supports("0.1.9", "0.2.0"));
        assert!(!desktop_version_supports("broken", "0.2.0"));
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Startup::default())
        .manage(LocalBots::default())
        .manage(UpdateSource::default())
        .invoke_handler(tauri::generate_handler![
            current_server,
            startup_error,
            connect,
            start_local_bot,
            stop_local_bot,
            local_bot_status,
            approve_local_directory
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            install_menu(&handle)?;
            // 存过地址、且那台机器现在敲得开，才直接进去。敲不开就回设置屏，并且把
            // 敲门的结果原样摆在上面。
            match read_server(&handle).and_then(|s| normalize(&s).ok()) {
                Some(url) => match reachable(&url) {
                    Ok(()) => open_main(&handle, url)?,
                    Err(why) => {
                        *handle.state::<Startup>().0.lock().unwrap() = format!("{why}");
                        open_setup(&handle)?
                    }
                },
                None => open_setup(&handle)?,
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Satuwork 桌面壳起不来")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut bots) = app.state::<LocalBots>().0.lock() {
                    for (_, mut proc_) in bots.drain() {
                        let _ = terminate_local_bot(&mut proc_.child);
                    }
                }
            }
        })
}
