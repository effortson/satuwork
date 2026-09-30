#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
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

mod self_update;

/**
 * Satuwork 桌面壳。
 *
 * **界面打在包里。** gateway/ui 那批分片原样拷进包（desktop/scripts/prepare-ui.mjs），由这个
 * 壳子自注册的 `satu://` 协议发出来（serve_ui；Windows 上 Tauri 把它映射成
 * http://satu.localhost）。壳子记住「连哪台 Gateway」，把地址注入给页面（LINK_SCRIPT 里的
 * `__SATUWORK_GATEWAY__`），所以页面打 Gateway 的每一条请求都是跨源的：Gateway 按这几个源开
 * CORS（gateway/src/http.ts 的 CORS_ORIGINS），凭据走 Authorization 头、不走 cookie。
 *
 * 以前包里没有前端、窗口直接装 Gateway 发的页面，为的是保住同源。改成内置是
 * docs/adr-gateway-vercel-neon.md §4 的决定（本地 Bot 的会话不经过 Gateway）。代价照实写：
 * 界面版本跟着桌面端发版走，Gateway 升级了界面不会自己变，两边的接口契约靠 e2e 钉着。
 *
 * 包里两份页面：shell/index.html 是「连哪台 Gateway」那一屏，能调设置命令；主窗口装的是包里
 * 那份界面，只拿得到本地 Bot 那组窄命令。两组命令各由一份 capability 放行（capabilities/），
 * **都只认本地源**（自注册的协议在 Tauri 眼里是本地源）——主窗口哪天被导航到站外，那一页
 * 一个命令都调不了，更改不了 Gateway 地址。
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
/// 界面自己的源。gateway/ui 打进了包里，由下面那个自定义协议发出去；页面里所有打 Gateway 的
/// 请求都是跨源的，Gateway 那头按这个源开 CORS（gateway/src/http.ts 的 CORS_ORIGINS）。
const UI_SCHEME: &str = "satu";
const UI_HOST: &str = "satu.localhost";
const UI_ORIGIN: &str = "satu://localhost/";

fn is_ui_origin(url: &Url) -> bool {
    (url.scheme() == UI_SCHEME && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https")
            && url
                .host_str()
                .is_some_and(|h| h.eq_ignore_ascii_case(UI_HOST)))
}

/** 新开的窗口编号。同一个 label 开第二次会失败，所以每开一扇加一。 */

/** 启动时那句「为什么没直接进去」。设置屏起来之后自己来取。 */
#[derive(Default)]
struct Startup(Mutex<String>);

/// 一颗跑着的本地 Bot：进程，和它听的那个口。口要记下来——页面直连本机就靠它
/// （隧道拆了，见 gateway/ui/data.js 的 localRoute），而端口是这里随机分的，别处没有。
struct LocalBotProc {
    child: BotChild,
    port: u16,
    /// 起这个进程时交给它的席位票。Gateway 换了票（口令改过、被重置，旧票跟着作废），
    /// 再来 start 时拿得出不一样的一把——那时要用新票重起，见 start_local_bot。
    access_token: String,
}

#[derive(Default)]
struct LocalBots(Mutex<HashMap<String, LocalBotProc>>);

/// 本地 Bot 的 node 进程，连同它往下拉起的一整棵（Bot 自己起的 Chrome 等）。停的时候要一起清：
/// Unix 上靠 spawn 时开的进程组，Windows 上靠这里挂着的 Job Object。
struct BotChild {
    /// 没建成就是 None，停止时退回只杀 node。
    #[cfg(windows)]
    job: Option<BotJob>,
    child: Child,
}

impl std::ops::Deref for BotChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}

impl std::ops::DerefMut for BotChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

/// 装着一颗本地 Bot 整棵进程树的 Job Object。node 之后拉起的子孙自动继承这个 Job，
/// TerminateJobObject 一把全清，相当于 Unix 上 kill 整个进程组。另设 KILL_ON_JOB_CLOSE：
/// 句柄一关系统就清场——Desktop 崩了、或者死掉的 Bot 从表里被换下来时，也不留孤儿 Chrome。
#[cfg(windows)]
struct BotJob(windows_sys::Win32::Foundation::HANDLE);

// 内核对象句柄，换线程用没问题；放进 LocalBots 那把 Mutex 要求 Send。
#[cfg(windows)]
unsafe impl Send for BotJob {}

#[cfg(windows)]
impl BotJob {
    fn assign(child: &Child) -> std::io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        // 先包起来：下面任何一步失败，Drop 都会把句柄关掉。
        let job = BotJob(handle);
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&info) as u32,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if unsafe { AssignProcessToJobObject(handle, child.as_raw_handle() as _) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(job)
    }

    fn terminate(&self) -> std::io::Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for BotJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

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
    /// Gateway 转发的同源地址（`/internal/local-bot-releases/<版本>`），要带席位票。
    url: String,
    /// 包在外面的公开地址（GitHub Release），null = 只能走 `url`。见 gateway/src/releases.ts
    /// 的 directReleaseUrl：Gateway 在 Vercel 上时函数响应体有 4.5 MB 上限，几十 MB 的包
    /// 从 `url` 转发一定失败，所以有这个就先走它。老 Gateway 不带这个字段，按 null 算。
    #[serde(default)]
    direct_url: Option<String>,
    min_desktop_version: String,
    mandatory: bool,
    note: String,
}

#[derive(Serialize, Debug, PartialEq)]
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

/** 正式发布包连的 Gateway。 */
const DEFAULT_SERVER: &str = "https://satuwork.com";

/**
 * 服务器地址锁死：**正式发布包不让填、不让换**，固定连 DEFAULT_SERVER；只有 debug 构建
 * （`tauri dev`，本地测试）才有「连接到 Gateway」那一屏和菜单里的「切换服务器…」。
 */
fn server_locked() -> bool {
    !cfg!(debug_assertions)
}

/**
 * 这次连哪儿。`SATUWORK_SERVER` 两种构建都认（排查用，不写盘）；再往下：
 * 锁死时是 DEFAULT_SERVER，存在磁盘上的老地址（0.1.2 及之前用户填过的）一律不看；
 * 没锁时是用户存过的，没有就是 None，交给设置屏去问。
 * 拆成纯函数是为了能不起应用就把这条规则钉住。
 */
fn pick_server(locked: bool, from_env: Option<&str>, saved: Option<&str>) -> Option<String> {
    let fallback = if locked { Some(DEFAULT_SERVER) } else { saved };
    [from_env, fallback]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_string)
}

/**
 * 这次该连哪儿。
 *
 * `SATUWORK_SERVER` **只覆盖，不写盘**：它是给开发和排查用的，跑完一次不该改掉用户
 * 存着的那个地址。
 */
fn read_server(app: &AppHandle) -> Option<String> {
    let from_env = std::env::var("SATUWORK_SERVER").ok();
    let saved = server_file(app).and_then(|path| fs::read_to_string(path).ok());
    pick_server(server_locked(), from_env.as_deref(), saved.as_deref())
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
 * 注入主窗口页面的一小段：**把「开新窗口」翻译成一次导航**。
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
  // 界面是包里自带的那份，和 Gateway 发的是同一批文件。给它一个只由桌面壳注入的标记，让登录票
  // 可以落到持久存储；再告诉它 Gateway 在哪——页面源是 satu://localhost，相对路径打不到 Gateway。
  window.__SATUWORK_DESKTOP__ = true
  window.__SATUWORK_GATEWAY__ = __GATEWAY_URL__
  window.__SATUWORK_LOCAL_BOT__ = {
    start: function (config) { return window.__TAURI_INTERNALS__.invoke('start_local_bot', { config: config }) },
    stop: function (botId) { return window.__TAURI_INTERNALS__.invoke('stop_local_bot', { botId: botId }) },
    status: function (botId) { return window.__TAURI_INTERNALS__.invoke('local_bot_status', { botId: botId }) },
    approveDirectory: function (botId) { return window.__TAURI_INTERNALS__.invoke('approve_local_directory', { botId: botId }) },
    directories: function (botId) { return window.__TAURI_INTERNALS__.invoke('local_directories', { botId: botId }) },
    revokeDirectory: function (botId, path) { return window.__TAURI_INTERNALS__.invoke('revoke_local_directory', { botId: botId, path: path }) }
  }
  // Desktop 壳自己的升级（self_update.rs）：侧栏那条「有新版本」由它驱动。
  window.__SATUWORK_DESKTOP_UPDATE__ = {
    status: function () { return window.__TAURI_INTERNALS__.invoke('desktop_update_status') },
    check: function (force) { return window.__TAURI_INTERNALS__.invoke('desktop_update_check', { force: Boolean(force) }) },
    install: function () { return window.__TAURI_INTERNALS__.invoke('desktop_update_install') }
  }
  // 内嵌桌面挂上之前先报一声地址，导航守卫只放行报过的机器（allow_seat_desktop）。
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
    // 链接脚本递过来的暗号：在界面自己的源上，路径是 OPEN_PATH。先认它，再看 scheme。
    // 源不对的不认（见 open_path_allowed），当一次普通导航往下走。
    if open_path_allowed(url, base) {
        route_open(app, base, url);
        return false;
    }
    // 界面自身（包含 Windows 上的 http://satu.localhost）必须放行留在窗口内。
    if is_ui_origin(url) {
        return true;
    }
    match url.scheme() {
        "http" | "https" => {}
        _ => return true,
    }
    // 内嵌桌面那块 iframe 也是一次 http(s) 导航，不能跟着往系统浏览器送。
    let seats = app.state::<SeatOrigins>();
    let allowed = seats.0.lock().map(|s| seat_desktop_allowed(url, base, &s)).unwrap_or(false);
    if allowed {
        return true;
    }
    // 界面在自己的源上，任何 http(s) 导航都是往外走（OAuth 跳转、外链）：交给系统浏览器，
    // 窗口留在原地。以前界面在 Gateway 的源上时同源导航是页面自己的路由，现在没有这一类了。
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
    false
}

/**
 * 这次导航是不是内嵌桌面那块 iframe 在加载席位机器的 noVNC。
 *
 * **为什么需要这一条。** 上面那条回调想挡的是「唯一的窗口跑到站外」，可它分不出主框架
 * 和子框架——wry 的 navigation_policy 把 WKNavigationAction 里的 URL 取出来就交给上层，
 * `targetFrame.isMainFrame` 从头到尾没碰过。于是右栏那块屏（`{directUrl}/seats/<席位>/vnc/`，
 * 见 gateway/ui/chat.js 的 mountDesktop）一挂上去就被判成「往外走」：地址送进系统浏览器，
 * iframe 这边 Cancel。表现是桌面从窗口里跳到浏览器里打开，而配置上看不出任何毛病。
 *
 * **只认路径不够，还得认源。** 以前只看路径，于是 `http://evil.com/seats/x/vnc/` 也放行：
 * 被诱导的主窗口、或者框里那页自己导航过去，窗口就跑出去了。机器的直连地址按公司各不相同、
 * 壳子这头无从枚举，所以由界面在挂 iframe 之前把那个地址报上来（allow_seat_desktop），
 * 这里只放行报过的源和 Gateway 自己的源，见 seat_desktop_allowed。
 *
 * 管家那一跳（`/seats/<席位>/vnc/` → `/seats/<席位>/vnc/vnc.html?…`，见 manager/src/proxy.ts）
 * 也是一次导航，所以判的是前缀而不是整条路径。
 */
fn is_seat_desktop(url: &Url) -> bool {
    let mut seg = match url.path_segments() {
        Some(it) => it,
        None => return false,
    };
    // /seats/<席位>/vnc[/…]
    seg.next() == Some("seats")
        && seg.next().is_some_and(|s| !s.is_empty())
        && seg.next() == Some("vnc")
}

/// 界面报上来的席位机器源（`https://m001.example.com` 这种），见 allow_seat_desktop。
#[derive(Default)]
struct SeatOrigins(Mutex<HashSet<String>>);

fn origin_key(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/**
 * 内嵌桌面放不放行：路径是 `/seats/<席位>/vnc…`，**并且**源是 Gateway 自己的、或者界面
 * 挂 iframe 前报过的那台机器。报名单的命令只放给本地源（capabilities/main.json），框里那页
 * 和跑到站外的页面都调不到，所以名单上只会有界面自己拿到的桌面地址。
 */
fn seat_desktop_allowed(url: &Url, gateway: &Url, seats: &HashSet<String>) -> bool {
    matches!(url.scheme(), "http" | "https")
        && is_seat_desktop(url)
        && (same_origin(url, gateway) || seats.contains(&origin_key(url)))
}

/**
 * 暗号认不认：路径是 OPEN_PATH，**并且**导航发生在界面自己的源或 Gateway 的源上。
 *
 * 链接脚本只注入主框架，它拼出来的暗号总在界面的源上。以前只看路径，框里那页（席位的
 * noVNC）或者随便哪个被诱导打开的站外页，导航到 `https://随便哪/__satuwork_open?u=…`
 * 就能让系统浏览器替它打开任意地址。
 */
fn open_path_allowed(url: &Url, gateway: &Url) -> bool {
    url.path() == OPEN_PATH && (is_ui_origin(url) || same_origin(url, gateway))
}

/**
 * 界面挂内嵌桌面之前调一次：把这块屏的源记进放行名单（seat_desktop_allowed）。
 * 只收 http(s) 的 `/seats/<席位>/vnc…` 地址，别的一律拒——名单只该装席位机器。
 */
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
    // 界面不再在 Gateway 的源上，「另开一扇应用窗口装 Gateway 页面」这条路没有了：
    // 同源与否都交给系统浏览器。`base` 留着是给将来「同源另开窗」用的判据。
    let _ = same_origin(&parsed, base);
    let _ = app.opener().open_url(parsed.as_str(), None::<&str>);
}

/**
 * 装界面的窗口都从这儿出：同一套导航守卫，同一段链接脚本（连同注入的 Gateway 地址）。
 *
 * 只从 setup 钩子、async 命令或别的线程上调：Windows 上 build() 放在同步命令、事件回调里
 * 会死锁（WebView2 的已知问题）。open_setup 同理。
 */
fn build_window(
    app: &AppHandle,
    label: &str,
    gateway: Url,
    title: &str,
) -> tauri::Result<()> {
    let handle = app.clone();
    let base = gateway.clone();
    // 装的是包里那份界面（satu://localhost/），不是 Gateway 的页面；Gateway 地址注入给它。
    let ui = Url::parse(UI_ORIGIN).expect("UI_ORIGIN 是常量");
    // 两个占位符都替换成 JSON 字符串字面量（带引号），而不是裸拼进单引号里：地址里一个
    // 引号或反斜杠就能从字面量里逃出来，往注入脚本里塞任意 JS。
    let script = LINK_SCRIPT
        .replace(
            "__OPEN_PATH__",
            &serde_json::to_string(OPEN_PATH).expect("常量字符串总能编成 JSON"),
        )
        .replace(
            "__GATEWAY_URL__",
            &serde_json::to_string(gateway.as_str().trim_end_matches('/'))
                .expect("字符串总能编成 JSON"),
        );
    WebviewWindowBuilder::new(app, label, WebviewUrl::CustomProtocol(ui))
        .title(title)
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 600.0)
        .initialization_script(&script)
        .on_navigation(move |url| allow_navigation(&handle, &base, url))
        .build()?;
    Ok(())
}

/// 包里那份界面在哪：发布包里是资源目录下的 ui/（prepare-ui.mjs 拷进去的），开发时直接读仓库里的 gateway/ui。
fn ui_dir(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../gateway/ui");
        if source.join("index.html").is_file() {
            return Some(source);
        }
    }
    app.path().resource_dir().ok().map(|dir| dir.join("ui")).filter(|dir| dir.join("index.html").is_file())
}

fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
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

// UI_CSP 里 CDN 那几条路径源，三条指令共用；由来见 UI_CSP 的注释。
macro_rules! ui_cdn {
    () => {
        "https://cdn.jsdelivr.net/npm/katex@0.16.11/ https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/ https://cdn.jsdelivr.net/npm/mermaid@11.4.1/"
    };
}

/**
 * 主窗口那份界面的 CSP，挂在 serve_ui 发出的每一个 html 响应上。
 *
 * **为什么要有。** 主窗口调得动本地 Bot 那组命令（起进程、批准目录），渲染的又是模型输出和
 * 用户写的 markdown——等同于外部输入。markdown.js 那层已经转义、白名单协议，但它是唯一一道
 * 防线；漏一处，注进来的脚本就能直接 invoke。这条头是第二道：**脚本只认包里的文件和那一个
 * CDN**，内联脚本、`javascript:`、eval、`<object>` 都不行。tauri.conf.json 里的 `csp` 管不到
 * 这里——Tauri 只把它挂在自己的 tauri:// 资源上（设置屏），自注册协议的响应得自己带。
 *
 * 底子照抄 Gateway 发页面时那条（gateway/src/http.ts 的 CSP），界面是同一批文件、在浏览器里
 * 已经跑得通。和它的不同都是因为源换了：
 *
 * - `'self'` 之外再写一遍 `satu:` 和 `http(s)://satu.localhost`：自定义 scheme 在各家 webview
 *   里算不算 `'self'` 不一定，Windows 上它又被映射成 http://satu.localhost。
 * - `connect-src` 放整个 `https: http:`（外加 `ws: wss:`）：Gateway 是人填的地址，内网部署
 *   就是 http；席位机器的直连对话流、本机的本地 Bot（http://127.0.0.1:<随机口>）也都在这里。
 *   `ipc: http://ipc.localhost` 是 Tauri 的 IPC 通道（invoke 走的就是它），少了本地 Bot 的
 *   命令全调不动。
 * - `frame-src https: http: blob:`：桌面那块 noVNC iframe（席位机器的直连地址）和文件预览的
 *   blob iframe。
 * - `img-src` / `media-src` 放 `https: http:`：图片地址是模型写的，附件从 Gateway 来。
 *
 * 刻意的松：`style-src 'unsafe-inline'`（界面里几十处 `style="…"`，内联样式换不出脚本执行）。
 * 刻意的紧：`script-src` 不带 `'unsafe-inline'` / `'unsafe-eval'`，和 Gateway 那条一样；
 * index.html 和各分片里没有内联脚本，e2e 有一条按源码扫的用例守着。Tauri 注入的初始化脚本
 * （LINK_SCRIPT、IPC 那几段）是 webview 的 user script，不受页面 CSP 管。
 *
 * CDN 只放行 KaTeX / highlight.js / Mermaid 那三个「包@版本/」目录，不放整个 cdn.jsdelivr.net
 * （jsdelivr 出任意 npm 包，放行整个源等于放行任何人发的脚本）。这三条是照
 * gateway/src/ui-cdn.ts 的 UI_CDN_PACKAGES 手抄的——桌面包里的页面没有 Gateway 插的
 * `<meta name="satu-cdn">`，markdown.js 用的是 jsdelivr 默认值。**改版本要一起改**，e2e 的
 * markdown 那一组按源码核对这三处；挡掉的表现是公式和图静默退回纯文本。
 *
 * 设置屏（shell/index.html，走 tauri://）的那条在 tauri.conf.json 的 `csp`：只认自己的文件和
 * IPC；页面里那段内联 `<script>` / `<style>` 由 Tauri 编译期算哈希补进策略，不用开
 * `'unsafe-inline'`。
 */
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

/**
 * 界面路径里的一段能不能拼到 ui 目录后面。`..` / `.` 逃目录；`\\` 在 Windows 上是分隔符；
 * `:` 挡的是 Windows 的盘符前缀（`C:foo` 被 PathBuf::push 当成另一个盘上的路径，整个替换掉
 * ui 目录）和 NTFS 的备用数据流（`index.html:x`）。界面文件名里本来就没有冒号。
 */
fn safe_ui_segment(seg: &str) -> bool {
    !(seg == ".." || seg == "." || seg.contains('\\') || seg.contains(':'))
}

/**
 * `satu://localhost/…`：从包里发界面。
 *
 * 和 Gateway 的 serveUi 同一套规矩：路径不得逃出目录；找不到的路径**回 index.html**——这是个
 * 单页应用，`/a/bot-1` 这种地址刷新一下也得回到同一页。Tauri 自带的 asset 协议没有这条兜底，
 * 所以自己发。
 */
fn serve_ui(app: &AppHandle, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Cow<'static, [u8]>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(tauri::http::StatusCode::NOT_FOUND)
            .header("content-type", "text/plain; charset=utf-8")
            .body(Cow::Borrowed("包里没有界面文件（gateway/ui）".as_bytes()))
            .unwrap()
    };
    let Some(dir) = ui_dir(app) else { return not_found() };
    let raw = request.uri().path().trim_start_matches('/');
    let rel = raw.split('?').next().unwrap_or("");
    let mut file = dir.clone();
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        if !safe_ui_segment(seg) {
            return not_found();
        }
        file.push(seg);
    }
    // Gateway 那边 /ui/x.js 也认；这里同样去掉 ui/ 前缀，两处发的是同一批文件。
    if !file.is_file() {
        let stripped = rel.strip_prefix("ui/").unwrap_or(rel);
        let mut alt = dir.clone();
        for seg in stripped.split('/').filter(|s| !s.is_empty()) {
            alt.push(seg);
        }
        file = if alt.is_file() && !stripped.is_empty() { alt } else { dir.join("index.html") };
    }
    let Ok(bytes) = fs::read(&file) else { return not_found() };
    let mime = mime_of(&file);
    let mut response = tauri::http::Response::builder()
        .status(tauri::http::StatusCode::OK)
        .header("content-type", mime)
        .header("cache-control", "no-store");
    // 和 Gateway 一样只挂在页面本身上：脚本、样式是被这一页加载的，约束它们的是这一页的策略。
    if mime.starts_with("text/html") {
        response = response.header("content-security-policy", UI_CSP);
    }
    response.body(Cow::Owned(bytes)).unwrap()
}

fn open_main(app: &AppHandle, url: Url) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(MAIN) {
        win.set_focus()?;
        return Ok(());
    }
    build_window(app, MAIN, url, "Satuwork")
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

/** 设置页据此决定要不要画输入框：锁死时只剩「连不上的原因」和「重试」。 */
#[tauri::command]
fn server_is_locked() -> bool {
    server_locked()
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
async fn connect(app: AppHandle, url: String) -> Result<(), String> {
    // 锁死时页面上没有输入框，这里也不认页面传来的地址——「重试」就是重连默认那台。
    let url = if server_locked() {
        read_server(&app).ok_or("没有可连的服务器")?
    } else {
        url
    };
    let parsed = normalize(&url)?;
    // 敲门每个地址最多等 3 秒，放进阻塞线程池：同步命令在主线程上，等的这几秒窗口全冻住。
    let probe = parsed.clone();
    tauri::async_runtime::spawn_blocking(move || reachable(&probe))
        .await
        .map_err(|e| e.to_string())??;
    if !server_locked() {
        write_server(&app, parsed.as_str())?;
    }
    // 在 async 命令里建窗口没问题；同步命令里建，Windows 上会死锁（见 build_window）。
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

/**
 * 运行时包里一条符号链接落地之后指到哪儿（相对包根的路径），或者指到包外。
 *
 * 只有 Windows 用得上（见 unpack_links_windows）：那边普通用户建不了符号链接（错误 1314），要
 * 自己把每条链接落成 junction / 硬链接，而 junction 和硬链接都得知道「真正指着的那个东西」。
 * 解析本身是纯路径运算，放在外面好让每个平台的单测都跑得到。
 */
#[cfg_attr(not(windows), allow(dead_code))] // 只有 Windows 的解包用它；别的平台只剩单测在跑
#[derive(Debug, Clone, PartialEq, Eq)]
enum LinkDest {
    Inside(PathBuf),
    /// 构建机上 workspace 包那种 `../../../../bot`：在这台电脑上本来就不存在，跳过不建。
    Outside,
}

/// 包里一条条目的路径：只留普通段，`.` 丢掉；`..`、绝对路径、盘符一律不认——和 tar 的
/// `unpack_in` 挡的是同一类东西，链接不经过它，得自己挡。
#[cfg_attr(not(windows), allow(dead_code))] // 只有 Windows 的解包用它；别的平台只剩单测在跑
fn safe_entry_path(raw: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in raw.components() {
        match c {
            std::path::Component::Normal(s) => out.push(s),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// 链接目标换算成包内路径。目标是相对链接所在目录写的；绝对路径、`..` 退出包根的算 Outside。
#[cfg_attr(not(windows), allow(dead_code))] // 只有 Windows 的解包用它；别的平台只剩单测在跑
fn link_target_in_root(link: &Path, target: &Path) -> LinkDest {
    let mut out: Vec<std::ffi::OsString> = link
        .parent()
        .map(|p| p.iter().map(|s| s.to_owned()).collect())
        .unwrap_or_default();
    for c in target.components() {
        match c {
            std::path::Component::Normal(s) => out.push(s.to_owned()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if out.pop().is_none() {
                    return LinkDest::Outside;
                }
            }
            _ => return LinkDest::Outside,
        }
    }
    LinkDest::Inside(out.iter().collect())
}

/**
 * 把一条包内路径上经过的链接一层层换成它们指的地方，直到落在真实路径上。
 *
 * **不看链接在包里的先后。** `a -> b`、`b -> c` 这种链，按包里的顺序一条条建的话，建 `a` 的
 * 时候 `b` 还不存在，既判不出它是目录还是文件，junction 也没东西可指。先在内存里把整条链
 * 走完，拿到的就是一个不含任何链接的真实路径。走到包外算 Outside；兜圈子报错。
 */
#[cfg_attr(not(windows), allow(dead_code))] // 只有 Windows 的解包用它；别的平台只剩单测在跑
fn resolve_through_links(path: &Path, links: &HashMap<PathBuf, LinkDest>) -> Result<LinkDest, String> {
    let mut cur = path.to_path_buf();
    for _ in 0..64 {
        let parts: Vec<_> = cur.iter().collect();
        let mut prefix = PathBuf::new();
        let mut hit = None;
        for (i, part) in parts.iter().enumerate() {
            prefix.push(part);
            if let Some(dest) = links.get(&prefix) {
                hit = Some((i, dest));
                break;
            }
        }
        let Some((i, dest)) = hit else {
            return Ok(LinkDest::Inside(cur));
        };
        let LinkDest::Inside(base) = dest else {
            return Ok(LinkDest::Outside);
        };
        let mut next = base.clone();
        for part in &parts[i + 1..] {
            next.push(part);
        }
        cur = next;
    }
    Err(format!("运行时包里的链接成环：{}", path.display()))
}

/// 一条要落地的链接：`location` 是它在包里的位置（已经绕开了路上的链接），`target` 是包里写的
/// 原样目标（建真符号链接时用），`dest` 是解析到底的真实路径。
#[cfg_attr(not(windows), allow(dead_code))] // 只有 Windows 的解包用它；别的平台只剩单测在跑
#[derive(Debug)]
struct LinkPlan {
    location: PathBuf,
    target: PathBuf,
    dest: LinkDest,
}

#[cfg_attr(not(windows), allow(dead_code))] // 只有 Windows 的解包用它；别的平台只剩单测在跑
fn plan_links(raw: Vec<(PathBuf, PathBuf)>) -> Result<Vec<LinkPlan>, String> {
    let mut links = HashMap::new();
    let mut list = Vec::new();
    for (path, target) in raw {
        let link = safe_entry_path(&path)
            .ok_or_else(|| format!("运行时包里的链接路径不合法：{}", path.display()))?;
        let dest = link_target_in_root(&link, &target);
        links.insert(link.clone(), dest);
        list.push((link, target));
    }
    let mut plans = Vec::new();
    for (link, target) in list {
        let first = links.get(&link).cloned().unwrap_or(LinkDest::Outside);
        let dest = match first {
            LinkDest::Inside(p) => resolve_through_links(&p, &links)?,
            LinkDest::Outside => LinkDest::Outside,
        };
        // 链接本身所在的目录也可能经过别的链接（pnpm 不这么打，但包是外面来的）。
        let location = match link.parent().filter(|p| !p.as_os_str().is_empty()) {
            None => link.clone(),
            Some(parent) => match resolve_through_links(parent, &links)? {
                LinkDest::Inside(p) => p.join(link.file_name().unwrap_or_default()),
                LinkDest::Outside => continue,
            },
        };
        plans.push(LinkPlan { location, target, dest });
    }
    Ok(plans)
}

/**
 * Windows 上解包：普通条目照常交给 tar（`unpack_in` 挡 `..` 和绝对路径），符号链接先记下，
 * 等文件都落地了再按 plan_links 的结果一条条建，**全在临时目录里完成**，之后才整体 rename——
 * 装到一半断掉的话留下的只是临时目录，不会有一个「有 bin/satuwork.mjs、缺依赖链接」的版本
 * 目录被 unpack_runtime / read_runtime_pointer 当成完整的。
 *
 * 为什么不直接 `Archive::unpack`：它建链接用 `CreateSymbolicLinkW`，普通用户没开开发者模式
 * 就是 1314，整个运行时装不上。
 */
#[cfg(windows)]
fn unpack_links_windows<R: Read>(archive: &mut tar::Archive<R>, bot: &Path, final_bot: &Path) -> Result<(), String> {
    let mut links = Vec::new();
    for entry in archive.entries().map_err(|e| format!("读取本地运行时条目失败：{e}"))? {
        let mut entry = entry.map_err(|e| format!("解开本地运行时条目失败：{e}"))?;
        if entry.header().entry_type() == tar::EntryType::Symlink {
            let path = entry.path().map_err(|e| format!("读取链接路径失败：{e}"))?.into_owned();
            let target = entry
                .link_name()
                .map_err(|e| format!("读取链接目标失败：{e}"))?
                .ok_or_else(|| format!("链接 {} 没有目标", path.display()))?
                .into_owned();
            links.push((path, target));
            continue;
        }
        entry.unpack_in(bot).map_err(|e| format!("解开本地运行时失败：{e}"))?;
    }
    materialize_links(bot, final_bot, &plan_links(links)?, true)
}

/**
 * 把链接建在 `bot`（临时目录）里。`final_bot` 是 rename 之后它们所在的位置：junction 只认
 * 绝对路径，指向临时目录的话一 rename 就断了，所以直接指 rename 之后的地方（junction 不要求
 * 目标此刻存在）。硬链接跟着文件走，rename 不影响。
 *
 * 顺序：先试真符号链接（开了开发者模式或管理员时能成，保持相对路径；目标里的 `/` 换成 `\`，
 * 标准库原样写进去，Windows 解析相对目标不认 `/`），不行目录用 junction、文件用硬链接，
 * 硬链接也不行再拷文件。目录不再退回整树拷贝：pnpm 的依赖图里有环，跟着链接拷会没完没了。
 */
#[cfg(windows)]
fn materialize_links(bot: &Path, final_bot: &Path, plans: &[LinkPlan], try_symlink: bool) -> Result<(), String> {
    for plan in plans {
        let LinkDest::Inside(real) = &plan.dest else { continue };
        let link_path = bot.join(&plan.location);
        let real_now = bot.join(real);
        let meta = fs::metadata(&real_now).map_err(|e| {
            format!("运行时包里的链接 {} 指向的 {} 不存在：{e}", plan.location.display(), real.display())
        })?;
        if let Some(parent) = link_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建链接父目录失败：{e}"))?;
        }
        if try_symlink {
            let rel = PathBuf::from(plan.target.to_string_lossy().replace('/', "\\"));
            let made = if meta.is_dir() {
                std::os::windows::fs::symlink_dir(&rel, &link_path)
            } else {
                std::os::windows::fs::symlink_file(&rel, &link_path)
            };
            if made.is_ok() {
                continue;
            }
        }
        if meta.is_dir() {
            junction::create(final_bot.join(real), &link_path).map_err(|e| {
                format!("创建目录链接失败 {} -> {}：{e}", plan.location.display(), real.display())
            })?;
        } else if fs::hard_link(&real_now, &link_path).is_err() {
            fs::copy(&real_now, &link_path).map_err(|e| {
                format!("创建文件链接失败 {} -> {}：{e}", plan.location.display(), real.display())
            })?;
        }
    }
    Ok(())
}

/**
 * 只在 STAGING 锁里调（见 stage_runtime_update）：它会把已经存在的 destination 整个删掉
 * 重解，两路并发跑到这里，一路刚解好的目录会被另一路当「损坏」删掉。有锁之后开头这一次
 * `is_file` 检查就够了——前一路解好的，后一路进来看到文件直接返回。
 */
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
        let mut archive = tar::Archive::new(gz);
        #[cfg(not(windows))]
        archive
            .unpack(&bot)
            .map_err(|e| format!("解开本地运行时失败：{e}"))?;
        #[cfg(windows)]
        unpack_links_windows(&mut archive, &bot, &destination.join("bot"))?;
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
    // 以前只在 CURRENT 不存在时才指向内置版：Desktop 升级之后新包里那份 Bot 永远用不上，
    // 比它还旧的远端版反倒一直占着 CURRENT。现在按版本号比，内置的更新就切过去。
    let switch = match read_runtime_pointer(&home, "CURRENT") {
        None => true,
        Some(current) if current == wanted => false,
        Some(current) => match runtime_older(&current, &wanted) {
            Some(older) => older,
            // 比不出来：CURRENT 读不出版本号，是老壳内置的那种（VERSION 只写了 sha256），
            // 刚装的这份不会比它旧，切；内置这份读不出而 CURRENT 读得出（老打包脚本打的包），
            // 不动。
            None => version_numbers(&current).is_none(),
        },
    };
    if switch {
        write_runtime_pointer(&home, "CURRENT", &wanted)?;
    }
    // 比内置版还旧的 PENDING 留着，下一次启动就会被提升成 CURRENT——等于降级，删掉。
    if let Some(pending) = read_runtime_pointer(&home, "PENDING") {
        if runtime_older(&pending, &wanted) == Some(true) {
            let _ = fs::remove_file(home.join("PENDING"));
        }
    }
    Ok(Some(wanted))
}

/**
 * `a` 是不是比 `b` 旧：只比 x.y.z（version_numbers），`+构建号`、`-平台-架构` 不参与。
 * 任一方读不出版本号时返回 None，由调用方决定怎么办。
 */
fn runtime_older(a: &str, b: &str) -> Option<bool> {
    Some(version_numbers(a)? < version_numbers(b)?)
}

fn promote_pending_runtime(app: &AppHandle) -> Result<Option<(String, String)>, String> {
    let home = runtime_home(app)?;
    let Some(pending) = read_runtime_pointer(&home, "PENDING") else {
        return Ok(None);
    };
    let previous = read_runtime_pointer(&home, "CURRENT").unwrap_or_default();
    // 只往前走：PENDING 比 CURRENT 还旧（例如 CURRENT 刚被切到更新的内置版）就丢掉。
    if runtime_older(&pending, &previous) == Some(true) {
        let _ = fs::remove_file(home.join("PENDING"));
        return Ok(None);
    }
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

/// 本地运行时包的上限。manifest 声明的 size 和实际下载都按它卡。
const MAX_RUNTIME_BYTES: u64 = 256 * 1024 * 1024;

/**
 * 把一次下载响应落进 `archive`，边写边算 sha256，最后和 manifest 声明的 size / sha256 比对。
 * 不通过就返回错误，调用方负责删临时文件。
 */
fn save_verified(
    mut response: reqwest::blocking::Response,
    release: &LocalBotRelease,
    archive: &Path,
) -> Result<(), String> {
    if !response.status().is_success() {
        return Err(format!("下载本地运行时失败：HTTP {}", response.status()));
    }
    let mut file = fs::File::create(archive).map_err(|e| format!("创建更新临时文件失败：{e}"))?;
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|e| format!("下载本地运行时失败：{e}"))?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > release.size || size > MAX_RUNTIME_BYTES {
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
    Ok(())
}

/**
 * 直连外部地址（GitHub Release）取包。
 *
 * 和走 Gateway 那条的两处不同，都是刻意的：
 * - **不带任何 Gateway 凭据。** 这是个公开地址，席位票只给 Gateway 自己。
 * - **允许跳转，但只跳 https、最多 5 次。** GitHub 的 release 下载一定会 302 到
 *   objects.githubusercontent.com（带签名的临时地址），不跟就永远取不到。跳到哪儿都不影响
 *   完整性：字节最后要过 save_verified 的 size + sha256，而那两个值来自带票的 manifest。
 *   不许降到 http，是为了别把「这台机器在取哪个版本」明文发出去。
 */
fn download_direct(raw: &str, release: &LocalBotRelease, archive: &Path) -> Result<(), String> {
    let url = Url::parse(raw).map_err(|e| format!("直连下载地址不合法：{e}"))?;
    if url.scheme() != "https" {
        return Err("直连下载地址不是 https".into());
    }
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("直连下载跳转次数过多")
            } else if attempt.url().scheme() != "https" {
                attempt.error("直连下载跳到了非 https 地址")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| format!("创建直连下载请求失败：{e}"))?;
    let response = client
        .get(url.as_str())
        .send()
        .map_err(|e| format!("直连下载本地运行时失败：{e}"))?;
    save_verified(response, release, archive).map_err(|e| format!("直连下载：{e}"))
}

/**
 * 下载并暂存适合本机的最新版。任何失败都只记状态，不阻止旧 Bot 启动。
 *
 * 一次只允许一路跑：每小时的更新线程（不持任何锁）和 start_local_bot（持 STARTING，不持 LocalBots）
 * 都会调它，而 unpack_runtime 对已存在的目标目录是先 remove_dir_all 再解。两路交错的话，
 * 一路刚解好、正要写 PENDING 的目录会被另一路当作损坏删掉。锁是这个函数自己的，
 * 不跟 LocalBots 扯上关系（锁序永远是 STARTING → STAGING），不会构成锁序问题。
 */
fn stage_runtime_update(
    app: &AppHandle,
    gateway: &Url,
    access_token: &str,
) -> Result<Option<String>, String> {
    if cfg!(debug_assertions) || std::env::var_os("SATUWORK_BOT_ROOT").is_some() {
        return Ok(None);
    }
    static STAGING: Mutex<()> = Mutex::new(());
    // 上一路带着锁 panic 了也照常往下走：锁保护的是文件系统，不是内存里的什么。
    let _staging = STAGING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = ensure_bundled_runtime(app)?;
    let home = runtime_home(app)?;
    let current = read_runtime_pointer(&home, "CURRENT").unwrap_or_default();
    let (platform, arch) = local_runtime_target()?;
    let desktop_version = app.package_info().version.to_string();
    let mut endpoint = gateway
        .join("/runtime/local-bot-release")
        .map_err(|e| format!("生成更新检查地址失败：{e}"))?;
    // 带上壳的版本：每个包登记了自己要的最低 Desktop 版本，Gateway 据此给这台装得了的最新一版。
    endpoint
        .query_pairs_mut()
        .append_pair("platform", platform)
        .append_pair("arch", arch)
        .append_pair("have", &current)
        .append_pair("desktop", &desktop_version);
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
    // Gateway 只看「和 have 不一样」，会把比本机还旧的版本发下来（例如 Desktop 升级后内置的
    // Bot 比 Gateway 上登记的都新）。不降级：这种情况等同于没有更新。同号不同构建的照样收。
    if runtime_older(&version, &current) == Some(true) {
        runtime_update_error(app, None);
        return Ok(None);
    }
    if release.sha256.len() != 64 || !release.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("服务器返回的运行时校验值不合法".into());
    }
    if release.size == 0 || release.size > MAX_RUNTIME_BYTES {
        return Err("服务器返回的运行时大小不合法".into());
    }
    let archive = home.join(format!(".{version}.download"));
    let result: Result<(), String> = (|| {
        // 先走直连（GitHub Release），失败了再退回 Gateway 转发。两条路落到同一个临时文件、
        // 过同一套 size + sha256 比对——sha256 来自上面那次带席位票的 manifest 请求，直连这条路
        // 本身不需要可信。
        let mut direct_error = None;
        let fetched = match release.direct_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(raw) => match download_direct(raw, &release, &archive) {
                Ok(()) => true,
                Err(error) => {
                    direct_error = Some(error);
                    false
                }
            },
            None => false,
        };
        if !fetched {
            let via_gateway = (|| {
                let download_url =
                    Url::parse(&release.url).map_err(|e| format!("更新地址不合法：{e}"))?;
                if !same_origin(gateway, &download_url) {
                    return Err("本地运行时下载地址与 Gateway 不同源".to_string());
                }
                // 这一条带席位票，所以沿用 Policy::none()：Gateway 的转发不该跳到别处，
                // 真跳了宁可失败，也不把票带去一个没核过的地址。
                let response = client
                    .get(download_url.as_str())
                    .bearer_auth(access_token)
                    .send()
                    .map_err(|e| format!("下载本地运行时失败：{e}"))?;
                save_verified(response, &release, &archive)
            })();
            if let Err(error) = via_gateway {
                return Err(match direct_error {
                    Some(direct) => format!("{direct}；改走 Gateway 转发也失败：{error}"),
                    None => error,
                });
            }
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
) -> Result<BotChild, String> {
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Windows 下 node.exe 是控制台子系统程序，GUI 宿主直接 spawn 会被系统（尤其是 Windows Terminal）
        // 弹出黑色终端窗口。传入 CREATE_NO_WINDOW 避免为 node 进程分配/弹出控制台窗口。
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    let child = command
        .spawn()
        .map_err(|e| format!("启动本地 Bot 失败：{e}"))?;
    Ok(BotChild {
        // node 在挂进 Job 之前就已经开跑，但它起 Chrome 远在这之后（要等浏览器工具被调用），
        // 那时的子孙都会继承 Job。挂不上（极少见）不拦启动，只是停止时退回只杀 node。
        #[cfg(windows)]
        job: BotJob::assign(&child).ok(),
        child,
    })
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
    mut child: BotChild,
    data: &Path,
    config: &LocalBotConfig,
) -> Result<BotChild, String> {
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

/**
 * 起一颗本地 Bot。
 *
 * **必须是 async 命令、活儿放进 spawn_blocking。** Tauri v2 里同步命令跑在主线程上，而这里
 * 要联网问更新、可能下载解包上百 MB（120 秒超时）、再等 500ms 看进程有没有立刻退出——同步
 * 写的话整个界面冻在那儿，窗口拖不动、菜单点不开。
 */
#[tauri::command]
async fn start_local_bot(app: AppHandle, config: LocalBotConfig) -> Result<LocalBotStatus, String> {
    tauri::async_runtime::spawn_blocking(move || start_local_bot_blocking(app, config))
        .await
        .map_err(|e| format!("启动本地 Bot 的后台任务异常：{e}"))?
}

/**
 * start_local_bot 的本体，在阻塞线程池里跑。
 *
 * 锁分两把：STARTING 把「起 Bot」这件事整段串起来（两次 start 交错的话，同一颗 Bot 会起两份、
 * 「是不是第一颗」的判断也会失真）；LocalBots 只在查表、改表那一下持有，**绝不跨着联网、
 * 解包、sleep 拿着**——status / stop / approve 都要这把锁，拿着它等 IO 就等于把它们一起卡住。
 */
fn start_local_bot_blocking(app: AppHandle, config: LocalBotConfig) -> Result<LocalBotStatus, String> {
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
    static STARTING: Mutex<()> = Mutex::new(());
    // 上一路带着锁 panic 了也照常往下走：这把锁不护内存里的数据，只负责排队。
    let _starting = STARTING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = app.state::<LocalBots>();
    let (stale, first) = {
        let mut bots = state.0.lock().map_err(|_| "本地 Bot 状态锁损坏")?;
        let alive = match bots.get_mut(&bot_id) {
            Some(proc_) => proc_.child.try_wait().map_err(|e| e.to_string())?.is_none(),
            None => false,
        };
        if let Some(proc_) = bots.get(&bot_id).filter(|p| alive && p.access_token == config.access_token) {
            let port = proc_.port;
            drop(bots);
            return Ok(runtime_status(&app, true, Some(port), &work));
        }
        // 票换了：Gateway 已经把这个进程手上那把作废了（改口令、被管理员重置之后，本地 Bot
        // 的票跟登录票一起作废），它从此每一次回 Gateway 都是 401、页面也敲不开它。手上的
        // 活反正已经做不下去，用新票重起一遍。先从表里摘出来，出了锁再杀。
        let stale = bots.remove(&bot_id).filter(|_| alive);
        (stale, bots.is_empty())
    };
    if let Some(mut proc_) = stale {
        terminate_local_bot(&mut proc_.child).map_err(|e| format!("换票时停止本地 Bot 失败：{e}"))?;
    }
    // 仅第一颗 Bot 启动前检查和切换。已有 Bot 在跑时只使用同一版本，绝不形成一台
    // Desktop 上多个运行时混跑，更不会为了升级强杀正在执行的任务。`first` 是上面那一眼看到的，
    // 有 STARTING 串着，这期间别处只可能停 Bot、不可能再起一颗，所以它不会过期成「错的第一颗」。
    let mut previous_runtime = None;
    let mut promoted_runtime = None;
    if first && !cfg!(debug_assertions) && std::env::var_os("SATUWORK_BOT_ROOT").is_none()
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
    state
        .0
        .lock()
        .map_err(|_| "本地 Bot 状态锁损坏")?
        .insert(bot_id, LocalBotProc { child, port, access_token: config.access_token.clone() });
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

fn terminate_local_bot(child: &mut BotChild) -> Result<(), String> {
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
    #[cfg(windows)]
    {
        // 整个 Job 一起终止：node 连同它拉起的 Chrome。Job 没建成或终止失败才退回只杀 node。
        if !child.job.as_ref().is_some_and(|job| job.terminate().is_ok()) {
            child.kill().map_err(|e| e.to_string())?;
        }
    }
    let _ = child.wait();
    Ok(())
}

/**
 * 所有本地 Bot 一起停。应用退出（RunEvent::Exit）和换壳（self_update）都走这里；换壳那条
 * 不会经过 RunEvent::Exit——Windows 上安装器起来后插件直接 process::exit，macOS 上是 restart。
 */
pub(crate) fn stop_all_local_bots(app: &AppHandle) {
    if let Ok(mut bots) = app.state::<LocalBots>().0.lock() {
        for (_, mut proc_) in bots.drain() {
            let _ = terminate_local_bot(&mut proc_.child);
        }
    }
    clear_update_source(app);
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
    // 一颗都不剩了，就别再拿最后那张票每小时去问更新：人可能已经退出登录、票也可能作废了。
    // 下一次 start 会重新记上。
    let empty = app.state::<LocalBots>().0.lock().map(|bots| bots.is_empty()).unwrap_or(false);
    if empty {
        clear_update_source(&app);
    }
    Ok(())
}

/** 清掉每小时运行时自查用的 Gateway 地址和票（见 UpdateSource）。 */
fn clear_update_source(app: &AppHandle) {
    if let Ok(mut src) = app.state::<UpdateSource>().0.lock() {
        *src = None;
    }
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
    // Windows 普通用户建不了符号链接（1314），退回 junction——同样是「指向那个目录的一个入口」，
    // list_approved / revoke_approved 认它（std 把 junction 也算 is_symlink，remove_dir 只拆入口）。
    // 两次都失败时两个原因都报：只报后一个的话，「入口已经存在」这类真原因就被盖掉了。
    #[cfg(windows)]
    if let Err(symlink_err) = std::os::windows::fs::symlink_dir(&target, &link) {
        junction::create(&target, &link).map_err(|junction_err| {
            format!("创建批准目录入口失败：符号链接 {symlink_err}；junction {junction_err}")
        })?;
    }
    Ok(Some(ApprovedDirectory {
        path: shown,
        mount: format!("External/{}", link.file_name().unwrap().to_string_lossy()),
    }))
}

/**
 * 批准过的文件夹：清单（approved-dirs.json）和工作区 `External/` 下的符号链接**两头都对上**
 * 才算——和 bot 那边 workspace.approvedMounts 同一条判据。只剩一头的（撤销到一半、手工删过
 * 链接）不列：列出来人会以为 Bot 还能访问，而 bot 那边已经不认了。
 */
fn list_approved(manifest: &Path, work: &Path) -> Vec<ApprovedDirectory> {
    let approved: Vec<String> = fs::read_to_string(manifest)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(work.join("External")) else {
        return out;
    };
    for entry in entries.flatten() {
        let link = entry.path();
        let is_link = fs::symlink_metadata(&link)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        if !is_link {
            continue;
        }
        let Ok(target) = link.canonicalize() else {
            continue;
        };
        let shown = target.display().to_string();
        if approved.iter().any(|p| p == &shown) {
            out.push(ApprovedDirectory {
                path: shown,
                mount: format!("External/{}", entry.file_name().to_string_lossy()),
            });
        }
    }
    out.sort_by(|a, b| a.mount.cmp(&b.mount));
    out
}

/**
 * 撤销一个批准：从清单里去掉，再拆掉 `External/` 下指向它的链接。
 *
 * **只拆链接，不碰文件夹本身**——`remove_file` 作用在符号链接上删的是链接；Windows 的目录
 * 链接要用 `remove_dir`，同样只删链接。先改清单再拆链接：拆到一半失败时，bot 那边按清单
 * 已经不认了（isApprovedPath），剩下的链接只是一条进不去的死路。
 */
fn revoke_approved(manifest: &Path, work: &Path, path: &str) -> Result<bool, String> {
    let mut approved: Vec<String> = fs::read_to_string(manifest)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let before = approved.len();
    approved.retain(|p| p != path);
    let changed = approved.len() != before;
    if changed {
        fs::write(
            manifest,
            serde_json::to_vec_pretty(&approved).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("保存目录批准记录失败：{e}"))?;
    }
    if let Ok(entries) = fs::read_dir(work.join("External")) {
        for entry in entries.flatten() {
            let link = entry.path();
            let is_link = fs::symlink_metadata(&link)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);
            if !is_link || link.canonicalize().ok().map(|t| t.display().to_string()).as_deref() != Some(path) {
                continue;
            }
            #[cfg(unix)]
            fs::remove_file(&link).map_err(|e| format!("拆除目录入口失败：{e}"))?;
            #[cfg(windows)]
            fs::remove_dir(&link).map_err(|e| format!("拆除目录入口失败：{e}"))?;
        }
    }
    Ok(changed)
}

/** 右栏那张「批准访问的文件夹」列表。 */
#[tauri::command]
fn local_directories(app: AppHandle, bot_id: String) -> Result<Vec<ApprovedDirectory>, String> {
    let id = safe_bot_id(&bot_id)?;
    let (data, work) = bot_paths(&app, &id)?;
    Ok(list_approved(&data.join("approved-dirs.json"), &work))
}

/**
 * 撤销一个批准。不用等 Bot 重启：bot 每次访问都现读清单（workspace.isApprovedPath），
 * 下一次读写就不认了；系统提示里的那张表下一轮也跟着变。
 */
#[tauri::command]
fn revoke_local_directory(app: AppHandle, bot_id: String, path: String) -> Result<bool, String> {
    let id = safe_bot_id(&bot_id)?;
    let (data, work) = bot_paths(&app, &id)?;
    revoke_approved(&data.join("approved-dirs.json"), &work, &path)
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
    if server_locked() {
        app.set_menu(menu)?;
        return Ok(());
    }
    let switch = MenuItem::with_id(app, SWITCH_ITEM, "切换服务器…", true, None::<&str>)?;
    let submenu = Submenu::with_items(app, "服务器", true, &[&switch])?;
    menu.append(&submenu)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id() != SWITCH_ITEM {
            return;
        }
        // 老服务器的地址和票也别留给每小时的运行时自查；换到新服务器、起了 Bot 之后会重新记上。
        clear_update_source(app);
        // 建窗口不能在菜单回调里同步做：Windows 上 WebviewWindowBuilder::build() 在同步命令和
        // 事件回调里会死锁（WebView2 的已知问题，见 Tauri 的 WebviewWindowBuilder 文档），
        // 要换到别的线程上建。
        // 先打开设置窗口，再关旧窗口：如果先关旧窗口，主窗口一关所有窗口数为 0，
        // Tauri 会按默认行为触发退出流程导致应用异常退出。
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = open_setup(&app) {
                eprintln!("打开设置窗口失败：{e}");
                return;
            }
            // 装着界面的窗口全关掉——包括「打开桌面」那种另开的。留着的话它们注入的还是
            // 老地址，而人正要换一台。
            for (label, win) in app.webview_windows() {
                if label != SETUP {
                    let _ = win.close();
                }
            }
        });
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        desktop_version_supports, is_seat_desktop, is_ui_origin, list_approved, open_path_allowed,
        origin_key, pick_server, revoke_approved, runtime_older, safe_runtime_version, safe_ui_segment,
        seat_desktop_allowed, unpack_runtime, link_target_in_root, plan_links, safe_entry_path, LinkDest,
    };
    use std::collections::HashSet;
    use tauri::Url;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    /// 正式包固定连默认地址，存过的老地址不看；本地测试按 环境变量 > 存过的，没有就 None。
    #[test]
    fn server_locked_ignores_saved_address() {
        let d = Some("https://satuwork.com");
        assert_eq!(pick_server(true, None, Some("http://old")).as_deref(), d);
        assert_eq!(pick_server(true, None, None).as_deref(), d);
        assert_eq!(pick_server(true, Some("  "), None).as_deref(), d);
        assert_eq!(
            pick_server(true, Some("http://e"), Some("http://old")).as_deref(),
            Some("http://e")
        );
        assert_eq!(
            pick_server(false, Some("http://e"), Some("http://s")).as_deref(),
            Some("http://e")
        );
        assert_eq!(
            pick_server(false, None, Some(" http://s\n")).as_deref(),
            Some("http://s")
        );
        assert_eq!(pick_server(false, None, Some("")), None);
        assert_eq!(pick_server(false, None, None), None);
    }

    /// 外链暗号只在界面源和 Gateway 源上认（见 open_path_allowed）。
    #[test]
    fn open_path_only_from_ui_or_gateway_origin() {
        let gw = u("https://gw.example.com/");
        let yes = [
            "satu://localhost/__satuwork_open?u=https%3A%2F%2Fa.com",
            "http://satu.localhost/__satuwork_open?u=https%3A%2F%2Fa.com",
            "https://gw.example.com/__satuwork_open?u=https%3A%2F%2Fa.com",
        ];
        for s in yes {
            assert!(open_path_allowed(&u(s), &gw), "该认：{s}");
        }
        let no = [
            "https://evil.com/__satuwork_open?u=https%3A%2F%2Fphish",
            "https://m001.example.com/__satuwork_open?u=https%3A%2F%2Fphish",
            // 端口、scheme 不同都不算 Gateway 的源
            "http://gw.example.com/__satuwork_open?u=x",
            "https://gw.example.com:8443/__satuwork_open?u=x",
            "https://gw.example.com.evil.com/__satuwork_open?u=x",
            // 界面源上别的路径不是暗号
            "satu://localhost/index.html?u=x",
        ];
        for s in no {
            assert!(!open_path_allowed(&u(s), &gw), "不该认：{s}");
        }
    }

    /// 内嵌桌面只放行 Gateway 源和界面报过的机器源（见 seat_desktop_allowed）。
    #[test]
    fn seat_desktop_only_on_known_origins() {
        let gw = u("https://gw.example.com/");
        let mut seats = HashSet::new();
        seats.insert(origin_key(&u("https://m001.example.com/seats/sw-a/vnc/")));
        seats.insert(origin_key(&u("http://192.168.64.1:8443/seats/sw-a/vnc/")));
        let yes = [
            "https://m001.example.com/seats/sw-abc/vnc/",
            "https://m001.example.com/seats/sw-abc/vnc/vnc.html?path=x",
            "http://192.168.64.1:8443/seats/sw-abc/vnc/",
            "https://gw.example.com/seats/sw-abc/vnc/",
        ];
        for s in yes {
            assert!(seat_desktop_allowed(&u(s), &gw, &seats), "该放行：{s}");
        }
        let no = [
            "http://evil.com/seats/x/vnc/",
            // 同主机换 scheme / 端口不算报过的源
            "http://m001.example.com/seats/sw-abc/vnc/",
            "https://m001.example.com:8443/seats/sw-abc/vnc/",
            "http://192.168.64.1/seats/sw-abc/vnc/",
            // 源对了路径不对
            "https://m001.example.com/other",
        ];
        for s in no {
            assert!(!seat_desktop_allowed(&u(s), &gw, &seats), "不该放行：{s}");
        }
        assert!(!seat_desktop_allowed(&u("https://m001.example.com/seats/a/vnc/"), &gw, &HashSet::new()));
    }

    #[test]
    fn ui_origin_stays_in_the_window() {
        let yes = [
            "satu://localhost/",
            "satu://localhost/index.html",
            "satu://localhost/a/bot-1",
            "http://satu.localhost/",
            "http://satu.localhost/index.html",
            "http://satu.localhost/a/bot-1",
            "https://satu.localhost/",
        ];
        for u in yes {
            assert!(is_ui_origin(&Url::parse(u).unwrap()), "该放行：{u}");
        }
        let no = [
            "http://localhost/",
            "http://example.com/",
            "http://satu.com/",
            "http://evil.localhost/",
        ];
        for u in no {
            assert!(!is_ui_origin(&Url::parse(u).unwrap()), "不该当界面源：{u}");
        }
    }

    #[test]
    fn ui_path_segments_cannot_escape_ui_directory() {
        for ok in ["index.html", "chat.js", "assets", "satuwork-logo.png"] {
            assert!(safe_ui_segment(ok), "该放行：{ok}");
        }
        for bad in ["..", ".", "C:", "C:..", "c:foo", "index.html:x", "a\\b"] {
            assert!(!safe_ui_segment(bad), "不该放行：{bad}");
        }
    }

    #[test]
    fn runtime_version_cannot_escape_release_directory() {
        assert!(safe_runtime_version("0.1.0+abc-darwin-arm64").is_ok());
        assert!(safe_runtime_version("../CURRENT").is_err());
        assert!(safe_runtime_version("a/b").is_err());
        assert!(safe_runtime_version(".hidden").is_err());
    }

    #[test]
    fn runtime_versions_compare_on_numbers_only() {
        assert_eq!(runtime_older("0.1.13+abc1234-darwin-arm64", "0.1.14+0123456789abcdef"), Some(true));
        assert_eq!(runtime_older("0.1.14+abc1234-darwin-arm64", "0.1.14+0123456789abcdef"), Some(false));
        assert_eq!(runtime_older("0.2.0+abc1234-darwin-arm64", "0.1.14+0123456789abcdef"), Some(false));
        // 老壳内置版的 VERSION 只是 sha256，读不出版本号
        let sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(runtime_older(sha, "0.1.14+0123456789abcdef"), None);
    }

    #[test]
    fn desktop_minimum_version_is_compared_numerically() {
        assert!(desktop_version_supports("0.10.0", "0.2.9"));
        assert!(desktop_version_supports("1.0.0", "1.0.0"));
        assert!(!desktop_version_supports("0.1.9", "0.2.0"));
        assert!(!desktop_version_supports("broken", "0.2.0"));
    }

    /// 内嵌桌面那块 iframe 不能被导航守卫送去系统浏览器（见 is_seat_desktop）。
    #[test]
    fn seat_desktop_navigation_stays_in_the_window() {
        let yes = [
            "https://m001.example.com/seats/sw-abc-def/vnc/",
            "https://m001.example.com/seats/sw-abc-def/vnc/?ticket=x",
            // 管家那一跳
            "https://m001.example.com/seats/sw-abc-def/vnc/vnc.html?path=x&autoconnect=1",
            // 本地开发的 http 直连
            "http://192.168.64.1:8443/seats/sw-abc-def/vnc/",
        ];
        for u in yes {
            assert!(is_seat_desktop(&Url::parse(u).unwrap()), "该放行：{u}");
        }
        let no = [
            "https://example.com/",
            "https://example.com/seats/",
            "https://example.com/seats/sw-abc-def",
            // 对话流和名单流是 fetch，不走导航；真走到这儿也不该当桌面放行
            "https://m001.example.com/seats/sw-abc-def/stream/sessions/s-1/events",
            "https://m001.example.com/roster/stream",
            // 空席位段
            "https://m001.example.com/seats//vnc/",
        ];
        for u in no {
            assert!(!is_seat_desktop(&Url::parse(u).unwrap()), "不该放行：{u}");
        }
    }
    #[test]
    fn approved_directories_list_and_revoke() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("satu-approved-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let work = base.join("work");
        let target = base.join("Downloads");
        let stray = base.join("NotApproved");
        fs::create_dir_all(work.join("External")).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&stray).unwrap();
        fs::write(target.join("keep.txt"), "别删我").unwrap();
        let target_real = target.canonicalize().unwrap().display().to_string();
        let manifest = base.join("approved-dirs.json");
        fs::write(&manifest, serde_json::to_vec(&vec![target_real.clone()]).unwrap()).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, work.join("External/Downloads")).unwrap();
            std::os::unix::fs::symlink(&stray, work.join("External/NotApproved")).unwrap();
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(&target, work.join("External/Downloads")).is_err() {
                junction::create(&target, work.join("External/Downloads")).unwrap();
            }
            if std::os::windows::fs::symlink_dir(&stray, work.join("External/NotApproved")).is_err() {
                junction::create(&stray, work.join("External/NotApproved")).unwrap();
            }
        }

        let listed = list_approved(&manifest, &work);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].mount, "External/Downloads");
        assert_eq!(listed[0].path, target_real);

        assert!(revoke_approved(&manifest, &work, &target_real).unwrap());
        assert!(list_approved(&manifest, &work).is_empty());
        assert!(fs::symlink_metadata(work.join("External/Downloads")).is_err(), "链接该拆掉");
        // 文件夹本身和里面的东西一个字节都不能动
        assert_eq!(fs::read_to_string(target.join("keep.txt")).unwrap(), "别删我");
        // 别人的链接不动
        assert!(fs::symlink_metadata(work.join("External/NotApproved")).is_ok());
        // 再撤一次：清单里已经没有，返回 false，不报错
        assert!(!revoke_approved(&manifest, &work, &target_real).unwrap());
        let _ = fs::remove_dir_all(&base);
    }

    /// 造一个运行时包：`(路径, 文件内容)` 或 `(路径, 链接目标)`。`raw_path` 为真时绕开 tar 对
    /// `..` 的检查，把路径原样写进头里——测「包是外面来的，里面写什么都可能」那种。
    enum TarEntry<'a> {
        File(&'a str, &'a [u8]),
        Link(&'a str, &'a str),
        RawLink(&'a str, &'a str),
    }

    fn write_tgz(path: &std::path::Path, entries: &[TarEntry]) {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        let file = std::fs::File::create(path).unwrap();
        let mut tar = tar::Builder::new(GzEncoder::new(file, Compression::default()));
        for entry in entries {
            let mut header = tar::Header::new_gnu();
            match entry {
                TarEntry::File(p, body) => {
                    header.set_path(p).unwrap();
                    header.set_size(body.len() as u64);
                    header.set_mode(0o644);
                    header.set_cksum();
                    tar.append(&header, *body).unwrap();
                    continue;
                }
                TarEntry::Link(p, _) => header.set_path(p).unwrap(),
                TarEntry::RawLink(p, _) => {
                    let name = &mut header.as_old_mut().name;
                    name[..p.len()].copy_from_slice(p.as_bytes());
                }
            }
            let target = match entry {
                TarEntry::Link(_, t) | TarEntry::RawLink(_, t) => *t,
                TarEntry::File(..) => unreachable!(),
            };
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_link_name(target).unwrap();
            header.set_size(0);
            header.set_mode(0o777);
            header.set_cksum();
            tar.append(&header, &[][..]).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!("satu-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    /// 链接不经过 tar 的 `unpack_in`，`..` 和绝对路径得自己挡（见 safe_entry_path）。
    #[test]
    fn link_paths_stay_inside_the_package() {
        use std::path::{Path, PathBuf};
        assert_eq!(safe_entry_path(Path::new("./node_modules/dep")), Some(PathBuf::from("node_modules/dep")));
        for bad in ["../evil", "node_modules/../../evil", "/etc/passwd", ".", ""] {
            assert_eq!(safe_entry_path(Path::new(bad)), None, "不该认：{bad}");
        }
        let link = Path::new("node_modules/dep");
        assert_eq!(
            link_target_in_root(link, Path::new(".pnpm/dep@1.0.0/node_modules/dep")),
            LinkDest::Inside(PathBuf::from("node_modules/.pnpm/dep@1.0.0/node_modules/dep"))
        );
        assert_eq!(
            link_target_in_root(Path::new("node_modules/.pnpm/a@1/node_modules/b"), Path::new("../../b@2/node_modules/b")),
            LinkDest::Inside(PathBuf::from("node_modules/.pnpm/b@2/node_modules/b"))
        );
        // 构建机上 workspace 包那种，和绝对路径：都算包外
        assert_eq!(link_target_in_root(link, Path::new("../../../../../../../bot")), LinkDest::Outside);
        assert_eq!(link_target_in_root(link, Path::new("/Users/someone/secrets")), LinkDest::Outside);
    }

    /// 链条先在内存里走到底，不看链接在包里的先后（见 resolve_through_links）。
    #[test]
    fn link_chains_resolve_regardless_of_order() {
        use std::path::PathBuf;
        let p = |a: &str, b: &str| (PathBuf::from(a), PathBuf::from(b));
        // alias 排在它指向的那条链接前面
        let plans = plan_links(vec![
            p("node_modules/alias", ".pnpm/node_modules/dep"),
            p("node_modules/.pnpm/node_modules/dep", "../dep@1.0.0/node_modules/dep"),
            p("node_modules/@w/pkg", "../../../../../../../bot"),
            // 位置本身在一条指到包外的链接底下：跳过
            p("node_modules/@w/pkg/node_modules/x", "../../y"),
        ])
        .unwrap();
        let dest_of = |loc: &str| plans.iter().find(|l| l.location == PathBuf::from(loc)).map(|l| l.dest.clone());
        let real = LinkDest::Inside(PathBuf::from("node_modules/.pnpm/dep@1.0.0/node_modules/dep"));
        assert_eq!(dest_of("node_modules/alias"), Some(real.clone()));
        assert_eq!(dest_of("node_modules/.pnpm/node_modules/dep"), Some(real));
        assert_eq!(dest_of("node_modules/@w/pkg"), Some(LinkDest::Outside));
        assert_eq!(plans.len(), 3, "在包外链接底下的那条该跳过：{plans:?}");

        // 成环、路径不合法：报错，不静默跳过
        assert!(plan_links(vec![p("a", "b"), p("b", "a")]).is_err());
        assert!(plan_links(vec![p("../evil", "x")]).is_err());
    }

    #[test]
    fn unpack_runtime_follows_links() {
        use std::fs;
        let base = scratch("unpack-links");
        let archive = base.join("bot.tgz");
        let destination = base.join("releases/v1");
        write_tgz(
            &archive,
            &[
                TarEntry::File("bin/satuwork.mjs", b"console.log('hello');"),
                TarEntry::File("node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js", b"module.exports = 42;"),
                // 链：alias -> .pnpm/node_modules/dep -> ../dep@1.0.0/...，alias 排在前面
                TarEntry::Link("node_modules/alias", ".pnpm/node_modules/dep"),
                TarEntry::Link("node_modules/.pnpm/node_modules/dep", "../dep@1.0.0/node_modules/dep"),
                TarEntry::Link("node_modules/dep", ".pnpm/dep@1.0.0/node_modules/dep"),
                TarEntry::Link("node_modules/.bin/dep.js", "../.pnpm/dep@1.0.0/node_modules/dep/index.js"),
                // 构建机上的 workspace 链接：这台电脑上不存在
                TarEntry::Link("node_modules/@w/pkg", "../../../../../../../bot"),
            ],
        );
        unpack_runtime(&archive, &destination).unwrap();
        let bot = destination.join("bot");
        for p in ["node_modules/dep/index.js", "node_modules/alias/index.js", "node_modules/.bin/dep.js"] {
            assert_eq!(fs::read_to_string(bot.join(p)).unwrap(), "module.exports = 42;", "读不到 {p}");
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// 路径带 `..` 的链接条目：哪个平台都不能落到版本目录外面。非 Windows 走 tar 的 unpack，
    /// 它跳过这种条目；Windows 自己解析链接，直接判整包不合法。
    #[test]
    fn link_entries_never_land_outside_the_package() {
        use std::fs;
        let base = scratch("unpack-escape");
        let archive = base.join("bot.tgz");
        let destination = base.join("releases/v1");
        write_tgz(&archive, &[TarEntry::File("bin/satuwork.mjs", b"x"), TarEntry::RawLink("../escape", "bin")]);
        let result = unpack_runtime(&archive, &destination);
        #[cfg(windows)]
        assert!(result.is_err(), "Windows 上该判整包不合法");
        #[cfg(not(windows))]
        result.unwrap();
        for p in [destination.join("escape"), base.join("releases/escape")] {
            assert!(fs::symlink_metadata(&p).is_err(), "不该在包外建出 {}", p.display());
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// 普通用户那条路：不建符号链接，目录落成 junction、文件落成硬链接，并且在临时目录里建好、
    /// rename 之后仍然指得对（junction 指的是 rename 之后的位置）。
    #[cfg(windows)]
    #[test]
    fn windows_links_fall_back_to_junction_and_hard_link() {
        use super::materialize_links;
        use std::fs;
        use std::path::PathBuf;
        let base = scratch("win-links");
        let staging = base.join(".install-x/bot");
        let final_dir = base.join("releases/v1");
        let dep = staging.join("node_modules/.pnpm/dep@1.0.0/node_modules/dep");
        fs::create_dir_all(&dep).unwrap();
        fs::write(dep.join("index.js"), "module.exports = 42;").unwrap();
        let p = |a: &str, b: &str| (PathBuf::from(a), PathBuf::from(b));
        let plans = plan_links(vec![
            p("node_modules/alias", ".pnpm/node_modules/dep"),
            p("node_modules/.pnpm/node_modules/dep", "../dep@1.0.0/node_modules/dep"),
            p("node_modules/.bin/dep.js", "../.pnpm/dep@1.0.0/node_modules/dep/index.js"),
        ])
        .unwrap();
        materialize_links(&staging, &final_dir.join("bot"), &plans, false).unwrap();
        fs::create_dir_all(final_dir.parent().unwrap()).unwrap();
        fs::rename(base.join(".install-x"), &final_dir).unwrap();
        let bot = final_dir.join("bot");
        for p in ["node_modules/alias/index.js", "node_modules/.pnpm/node_modules/dep/index.js", "node_modules/.bin/dep.js"] {
            assert_eq!(fs::read_to_string(bot.join(p)).unwrap(), "module.exports = 42;", "读不到 {p}");
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// 包里的链接出问题时整次安装失败，**不留下版本目录**：否则下次 unpack_runtime 看到
    /// bin/satuwork.mjs 就当它装好了。
    #[cfg(windows)]
    #[test]
    fn windows_bad_links_leave_no_release_directory() {
        use std::fs;
        for (name, entries) in [
            ("dangling", vec![TarEntry::Link("node_modules/gone", ".pnpm/gone@1/node_modules/gone")]),
            ("cycle", vec![TarEntry::Link("node_modules/a", "b"), TarEntry::Link("node_modules/b", "a")]),
        ] {
            let base = scratch(&format!("win-bad-{name}"));
            let archive = base.join("bot.tgz");
            let destination = base.join("releases/v1");
            let mut all = vec![TarEntry::File("bin/satuwork.mjs", b"x")];
            all.extend(entries);
            write_tgz(&archive, &all);
            assert!(unpack_runtime(&archive, &destination).is_err(), "{name} 该失败");
            assert!(!destination.exists(), "{name} 失败后不该留下版本目录");
            let _ = fs::remove_dir_all(&base);
        }
    }

    /// 停本地 Bot 要连它拉起的孙进程一起清——Chrome 就是这么挂在 node 底下的。这里拿 PowerShell
    /// 当「Bot」，过一拍再起一个长命的 ping 当「Chrome」并写出它的 PID；停下之后 ping 也得没了。
    #[cfg(windows)]
    #[test]
    fn windows_stop_takes_down_grandchildren() {
        use super::{terminate_local_bot, BotChild, BotJob};
        use std::fs;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        let base = scratch("win-job");
        let pid_file = base.join("grandchild.pid");
        let script = format!(
            "Start-Sleep -Milliseconds 500; \
             $p = Start-Process ping -ArgumentList '-n','120','127.0.0.1' -NoNewWindow -PassThru; \
             Set-Content -Path '{}' -Value $p.Id; Start-Sleep 120",
            pid_file.display()
        );
        let child = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut bot = BotChild { job: Some(BotJob::assign(&child).unwrap()), child };
        let deadline = Instant::now() + Duration::from_secs(30);
        let pid: u32 = loop {
            if let Some(pid) = fs::read_to_string(&pid_file).ok().and_then(|s| s.trim().parse().ok()) {
                break pid;
            }
            assert!(Instant::now() < deadline, "PowerShell 没写出孙进程的 PID");
            std::thread::sleep(Duration::from_millis(100));
        };
        let grandchild = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!grandchild.is_null(), "孙进程已经不在了，测不出东西");
        terminate_local_bot(&mut bot).unwrap();
        let waited = unsafe { WaitForSingleObject(grandchild, 10_000) };
        unsafe { CloseHandle(grandchild) };
        assert_eq!(waited, WAIT_OBJECT_0, "停下 Bot 之后孙进程还活着");
        let _ = fs::remove_dir_all(&base);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol(UI_SCHEME, |ctx, request| serve_ui(&ctx.app_handle().clone(), &request))
        .manage(Startup::default())
        .manage(LocalBots::default())
        .manage(UpdateSource::default())
        .manage(SeatOrigins::default())
        .invoke_handler(tauri::generate_handler![
            current_server,
            startup_error,
            connect,
            server_is_locked,
            start_local_bot,
            stop_local_bot,
            local_bot_status,
            approve_local_directory,
            local_directories,
            revoke_local_directory,
            allow_seat_desktop,
            self_update::desktop_update_status,
            self_update::desktop_update_check,
            self_update::desktop_update_install
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            handle.manage(self_update::SelfUpdate::new(handle.package_info().version.to_string()));
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
                stop_all_local_bots(app);
            }
        })
}
