#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod distribution;

use std::collections::HashMap;
use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

mod directories;
mod local_bot;
mod nav;
mod runtime;
mod self_update;
mod server;
mod ui;

use local_bot::{clear_update_source, stop_all_local_bots};
use nav::{build_window, SeatOrigins};
use server::{normalize, reachable, read_server, server_locked, write_server};
use ui::serve_ui;

/**
 * Satuwork 桌面壳。
 *
 * **界面打在包里。** gateway/ui 那批分片原样拷进包（scripts/copy-ui.mjs），由这个
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
/// 界面自己的源。gateway/ui 打进了包里，由自注册的协议发出去（ui.rs 的 serve_ui）；页面里所有打 Gateway 的
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
    /// 起这个进程时的那份配置。
    ///
    /// 里面的席位票：Gateway 换了票（口令改过、被重置，旧票跟着作废），再来 start 时拿得出
    /// 不一样的一把——那时要用新票重起，见 start_local_bot。整份留着是给换壳用的：装新壳前
    /// 要把 Bot 全停掉，装失败了得按原样再拉起来（见 self_update 的 download_and_install），
    /// 而 api_key 这些只有页面 start 的那一刻给过一次。
    config: LocalBotConfig,
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

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalBotConfig {
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

/// 单测用的临时目录：按名字和进程号隔开，先清空再建。
#[cfg(test)]
fn scratch(name: &str) -> std::path::PathBuf {
    let base = std::env::temp_dir().join(format!("satu-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    base
}

#[cfg(test)]
mod tests {
    use super::is_ui_origin;
    use tauri::Url;

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
            local_bot::start_local_bot,
            local_bot::stop_local_bot,
            local_bot::local_bot_status,
            directories::approve_local_directory,
            directories::local_directories,
            directories::revoke_local_directory,
            nav::allow_seat_desktop,
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
                let _ = stop_all_local_bots(app);
            }
        })
}
