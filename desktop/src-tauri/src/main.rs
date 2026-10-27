#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod distribution;

use std::collections::HashMap;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::Menu;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

mod directories;
mod local_bot;
mod nav;
mod runtime;
mod self_update;
mod server;
mod ui;
mod window;

use local_bot::{clear_update_source, stop_all_local_bots};
use nav::{build_window, SeatOrigins};
use server::{check, normalize, reachable, read_server, write_server, DEFAULT_SERVER};
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

/// 正在换服务器：旧窗口都关了、新主窗口还没建起来的那一小段。窗口数归零时 Tauri 会发
/// ExitRequested，这段时间里要拦住，否则应用直接退出（见 reopen_main）。
static SWITCHING: AtomicBool = AtomicBool::new(false);

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
        .decorations(!crate::window::custom_chrome())
        // Windows shadows add a white DWM border to undecorated windows.
        .shadow(!cfg!(target_os = "windows"))
        .initialization_script(window::initialization_script())
        .inner_size(520.0, 460.0)
        .resizable(false)
        .build()?;
    Ok(())
}

#[tauri::command]
fn current_server(app: AppHandle) -> String {
    read_server(&app)
}

/** 启动时没能直接进去的原因。取一次就清掉——它说的是「刚才」，不是「现在」。 */
#[tauri::command]
fn startup_error(app: AppHandle) -> String {
    let state = app.state::<Startup>();
    let mut slot = state.0.lock().unwrap();
    std::mem::take(&mut *slot)
}

/** 规整地址，再敲门、要一次 /health。都过了才回规整后的地址。 */
async fn checked(url: &str) -> Result<Url, String> {
    let parsed = normalize(url)?;
    // 每一步都可能等上几秒，放进阻塞线程池：同步命令在主线程上，等的这几秒窗口全冻住。
    let probe = parsed.clone();
    tauri::async_runtime::spawn_blocking(move || check(&probe))
        .await
        .map_err(|e| e.to_string())??;
    Ok(parsed)
}

/**
 * 连。**连不上就不写盘**——写了的话下次启动会直接奔那个地址去，而那正是「白窗口」
 * 的来源；停在这一屏、把话说清楚，人还在键盘前面，改一个字母就好了。
 */
#[tauri::command]
async fn connect(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = checked(&url).await?;
    write_server(&app, parsed.as_str())?;
    // 在 async 命令里建窗口没问题；同步命令里建，Windows 上会死锁（见 build_window）。
    open_main(&app, parsed).map_err(|e| e.to_string())?;
    if let Some(win) = app.get_webview_window(SETUP) {
        let _ = win.close();
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayServerInfo {
    current: String,
    default: String,
}

/** 登录页「服务器」弹窗打开时要的：现在连的哪台，默认是哪台（「恢复默认」用）。 */
#[tauri::command]
fn gateway_server_info(app: AppHandle) -> GatewayServerInfo {
    GatewayServerInfo {
        current: read_server(&app),
        default: DEFAULT_SERVER.to_string(),
    }
}

/** 弹窗里的「检测」：只测不存，通过了回规整后的地址给页面显示。 */
#[tauri::command]
async fn check_gateway_server(url: String) -> Result<String, String> {
    Ok(checked(&url).await?.as_str().trim_end_matches('/').to_string())
}

/**
 * 弹窗里的「使用」：再测一遍（页面上测过之后人可能又改了一个字），过了才写盘，然后换掉
 * 主窗口——Gateway 地址是建窗口时注入进页面的，换地址只能重建。
 *
 * 重建放到后台去做、这里先回：要关掉的正是发起这条命令的那扇窗。
 */
#[tauri::command]
async fn use_gateway_server(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = checked(&url).await?;
    write_server(&app, parsed.as_str())?;
    tauri::async_runtime::spawn(async move {
        if let Err(e) = reopen_main(&app, parsed).await {
            eprintln!("换服务器后重建主窗口失败：{e}");
        }
    });
    Ok(())
}

/**
 * 换了服务器之后的收尾：老服务器上起的本地 Bot 停掉，运行时自查的地址和票清掉——它们都
 * 认的是老服务器。换到新服务器、登录、起了 Bot 之后会重新记上。
 */
fn forget_old_server(app: &AppHandle) {
    clear_update_source(app);
    let _ = stop_all_local_bots(app);
}

/**
 * 关掉所有装界面的窗口，用新地址重建主窗口。
 *
 * 主窗口的 label 只能是 MAIN（capability 按 label 放行命令），所以得等老的那扇真正销毁、
 * label 空出来才能建新的；中间窗口数为零，SWITCHING 拦住 Tauri 的自动退出。
 */
async fn reopen_main(app: &AppHandle, url: Url) -> Result<(), String> {
    SWITCHING.store(true, Ordering::SeqCst);
    let app2 = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || forget_old_server(&app2)).await;
    for (label, win) in app.webview_windows() {
        if label != SETUP {
            let _ = win.destroy();
        }
    }
    for _ in 0..100 {
        if app.get_webview_window(MAIN).is_none() {
            break;
        }
        let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(std::time::Duration::from_millis(30))).await;
    }
    let result = open_main(app, url).map_err(|e| e.to_string());
    SWITCHING.store(false, Ordering::SeqCst);
    result
}

/**
 * 系统默认菜单。macOS 上复制粘贴的快捷键是菜单项给的，不装的话 Cmd+C/Cmd+V 就没了。
 *
 * 以前这里还挂着「服务器 → 切换服务器…」，换服务器现在在登录页右上角的「服务器」按钮里
 * （use_gateway_server），菜单那一条去掉了。
 */
fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    app.set_menu(Menu::default(app)?)?;
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
            window::desktop_window_action,
            window::desktop_window_state,
            current_server,
            startup_error,
            connect,
            gateway_server_info,
            check_gateway_server,
            use_gateway_server,
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
            match normalize(&read_server(&handle)).and_then(|url| reachable(&url).map(|()| url)) {
                Ok(url) => open_main(&handle, url)?,
                Err(why) => {
                    *handle.state::<Startup>().0.lock().unwrap() = why;
                    open_setup(&handle)?
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Satuwork 桌面壳起不来")
        .run(|app, event| match event {
            // 换服务器时窗口数会短暂归零（见 reopen_main），那一下不是要退出。
            tauri::RunEvent::ExitRequested { code: None, api, .. } if SWITCHING.load(Ordering::SeqCst) => {
                api.prevent_exit();
            }
            tauri::RunEvent::Exit => {
                let _ = stop_all_local_bots(app);
            }
            _ => {}
        })
}
