//! 本地 Bot 进程：起、停、查状态，换壳前后整批停和重起。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, Url};

use crate::runtime::{
    bot_runtime, ensure_bundled_runtime, promote_pending_runtime, read_runtime_pointer, runtime_home, runtime_update_error,
    stage_runtime_update, write_runtime_pointer,
};
use crate::server::{normalize, read_server, same_origin};
#[cfg(windows)]
use crate::BotJob;
use crate::{BotChild, LocalBotConfig, LocalBotProc, LocalBotStatus, LocalBots, UpdateSource, UPDATER_STARTED};

pub(crate) fn safe_bot_id(raw: &str) -> Result<String, String> {
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

pub(crate) fn bot_paths(app: &AppHandle, bot_id: &str) -> Result<(PathBuf, PathBuf), String> {
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

fn runtime_status(app: &AppHandle, running: bool, port: Option<u16>, data: &Path, workspace: &Path) -> LocalBotStatus {
    let home = runtime_home(app).ok();
    LocalBotStatus {
        running,
        port: if running { port } else { None },
        // bot_paths 会把数据目录建出来，所以看目录在不在没用；看 Bot 进程自己写的库。
        has_data: data.join("satuwork.db").exists(),
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
pub(crate) async fn start_local_bot(app: AppHandle, config: LocalBotConfig) -> Result<LocalBotStatus, String> {
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
    let configured = read_server(&app);
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
        if let Some(proc_) = bots.get(&bot_id).filter(|p| alive && p.config.access_token == config.access_token) {
            let port = proc_.port;
            drop(bots);
            return Ok(runtime_status(&app, true, Some(port), &data, &work));
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
        .insert(bot_id, LocalBotProc { child, port, config: config.clone() });
    // 记下这次的地址和票，运行时自查（每小时一次）拿它去问 Gateway 有没有新版。
    if let Ok(mut src) = app.state::<UpdateSource>().0.lock() {
        *src = Some((gateway.clone(), config.access_token.clone()));
    }
    start_runtime_updater(&app);
    Ok(runtime_status(&app, true, Some(port), &data, &work))
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
 * 所有本地 Bot 一起停，返回停掉的那几颗当初的配置。应用退出（RunEvent::Exit）和换壳
 * （self_update）都走这里；换壳那条不会经过 RunEvent::Exit——Windows 上安装器起来后插件直接
 * process::exit，macOS 上是 restart。换壳没换成时拿返回值交给 restart_local_bots。
 */
pub(crate) fn stop_all_local_bots(app: &AppHandle) -> Vec<LocalBotConfig> {
    let mut stopped = Vec::new();
    if let Ok(mut bots) = app.state::<LocalBots>().0.lock() {
        for (_, mut proc_) in bots.drain() {
            let _ = terminate_local_bot(&mut proc_.child);
            stopped.push(proc_.config);
        }
    }
    clear_update_source(app);
    stopped
}

/**
 * 按原配置把停掉的本地 Bot 再拉起来。换壳时装新包失败（macOS 上管理员授权点了取消、Windows
 * 上安装器没起来）走这里：Bot 是为了换壳才停的，壳没换成就不该让人一颗颗手动重开。
 *
 * 在阻塞线程里一颗颗起（start_local_bot_blocking 本来就靠 STARTING 串行）。起不来的只记一行，
 * 返回起不来的那几颗的 id——页面上它们显示成没在跑，人还能自己点。
 */
pub(crate) fn restart_local_bots(app: &AppHandle, configs: Vec<LocalBotConfig>) -> Vec<String> {
    let mut failed = Vec::new();
    for config in configs {
        let id = config.bot_id.clone();
        if let Err(e) = start_local_bot_blocking(app.clone(), config) {
            eprintln!("换壳失败后重起本地 Bot {id} 失败：{e}");
            failed.push(id);
        }
    }
    failed
}

#[tauri::command]
pub(crate) fn stop_local_bot(app: AppHandle, bot_id: String) -> Result<(), String> {
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
pub(crate) fn clear_update_source(app: &AppHandle) {
    if let Ok(mut src) = app.state::<UpdateSource>().0.lock() {
        *src = None;
    }
}

#[tauri::command]
pub(crate) fn local_bot_status(app: AppHandle, bot_id: String) -> Result<LocalBotStatus, String> {
    let id = safe_bot_id(&bot_id)?;
    let (data, work) = bot_paths(&app, &id)?;
    let state = app.state::<LocalBots>();
    let mut bots = state.0.lock().map_err(|_| "本地 Bot 状态锁损坏")?;
    let (running, port) = match bots.get_mut(&id) {
        Some(proc_) => (proc_.child.try_wait().map_err(|e| e.to_string())?.is_none(), Some(proc_.port)),
        None => (false, None),
    };
    if !running {
        bots.remove(&id);
    }
    Ok(runtime_status(&app, running, port, &data, &work))
}

// 这一组只有 Windows 的那条（Job Object 清孙进程），别的平台整组不编。
#[cfg(all(test, windows))]
mod tests {
    use crate::scratch;

    /// 停本地 Bot 要连它拉起的孙进程一起清——Chrome 就是这么挂在 node 底下的。这里拿 PowerShell
    /// 当「Bot」，过一拍再起一个长命的 ping 当「Chrome」并写出它的 PID；停下之后 ping 也得没了。
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
