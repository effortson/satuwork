/**
 * Desktop 壳自己的升级（和本地 Bot 运行时那条是两件事，见 main.rs 的 stage_runtime_update）。
 *
 * 本地 Bot 运行时只是一包 JS，壳子自己解、自己切指针就行；而 Rust 壳、内置 Node、系统权限声明
 * 变了，只能换整个安装包。这里用 tauri-plugin-updater 干这件事：
 *
 * - **去哪儿问**：tauri.conf.json 的 `plugins.updater.endpoints`，指向 GitHub 上固定的
 *   `desktop-latest` Release 里那份 `latest.json`（desktop-release.yml 生成、sync-latest 同步）。
 *   不经过 Gateway：壳子换版和连哪台 Gateway 无关，自托管的公司也从同一处拿包。
 * - **凭什么信**：包的签名。公钥编进壳里（`plugins.updater.pubkey`），私钥只在 CI 的 secret 里；
 *   下载完先验签再装，manifest 被人换了也装不进来。这层签名和 Apple / 微软的代码签名无关，
 *   没有证书也成立。
 * - **怎么换**：macOS 上把 `.app.tar.gz` 解出来原地替换 Satuwork.app（没写权限时插件会用
 *   osascript 弹管理员授权），然后重启；Windows 上起 NSIS 安装器（passive，只有进度条），
 *   插件自己退出进程，安装器装完再把应用拉起来。
 *
 * **页面来驱动，不自己定时。** 界面启动时和之后每隔几小时调一次 `desktop_update_check`，
 * 有新版就在侧栏亮一条；人点了才调 `desktop_update_install`。下载在后台跑，页面轮询
 * `desktop_update_status` 画进度。不做「后台静默下好、下次启动自动换」：换壳要重启整个应用，
 * 本地 Bot 手上的活会被打断，这一下得由人来按。
 */
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};

/// 两次真去问 GitHub 的最短间隔。页面每次启动都会调 check，开关几次窗口不该每次都敲一遍。
const CHECK_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    /// `disabled` 开发版 / `idle` 还没问过 / `checking` / `latest` 已是最新 / `available` 有新版 /
    /// `downloading` / `installing` / `error`
    phase: &'static str,
    current: String,
    version: Option<String>,
    notes: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    error: Option<String>,
}

pub struct SelfUpdate {
    view: Mutex<UpdateView>,
    /// check 拿到的那一份，install 用它下载。Update 自带下载地址和签名，不用再问一次。
    pending: Mutex<Option<Update>>,
    checked_at: Mutex<Option<Instant>>,
}

impl SelfUpdate {
    pub fn new(current: String) -> Self {
        let phase = if enabled() { "idle" } else { "disabled" };
        SelfUpdate {
            view: Mutex::new(UpdateView {
                phase,
                current,
                version: None,
                notes: None,
                downloaded: 0,
                total: None,
                error: None,
            }),
            pending: Mutex::new(None),
            checked_at: Mutex::new(None),
        }
    }

    fn snapshot(&self) -> UpdateView {
        self.view.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn edit(&self, f: impl FnOnce(&mut UpdateView)) {
        f(&mut self.view.lock().unwrap_or_else(|p| p.into_inner()));
    }

    fn busy(&self) -> bool {
        matches!(self.snapshot().phase, "checking" | "downloading" | "installing")
    }
}

/**
 * 开发版（`tauri dev`）不查：它的版本号就是 tauri.conf.json 里那个，查到线上同号或更新的包
 * 会把源码跑着的这份当成「旧版」提示升级，点下去还会拿安装包盖掉 target/debug 里的东西。
 * 排查升级链路时用 `SATUWORK_SELF_UPDATE=1` 强开。
 */
fn enabled() -> bool {
    !cfg!(debug_assertions) || std::env::var_os("SATUWORK_SELF_UPDATE").is_some()
}

/**
 * 平时就是 tauri.conf.json 里那个地址。`SATUWORK_UPDATE_ENDPOINT` 只在排查时用：指到本机起的
 * 一份 latest.json 上，不发版也能把「查到 → 下载 → 验签」走一遍。验签的公钥不跟着换，
 * 所以这条覆盖装不进没用正式私钥签过的包。
 */
fn updater(app: &AppHandle) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    match std::env::var("SATUWORK_UPDATE_ENDPOINT").ok().filter(|s| !s.trim().is_empty()) {
        Some(raw) => {
            let url = tauri::Url::parse(raw.trim())
                .map_err(|e| tauri_plugin_updater::Error::Network(format!("SATUWORK_UPDATE_ENDPOINT 不是合法地址：{e}")))?;
            app.updater_builder().endpoints(vec![url])?.build()
        }
        None => app.updater(),
    }
}

fn state(app: &AppHandle) -> tauri::State<'_, SelfUpdate> {
    app.state::<SelfUpdate>()
}

#[tauri::command]
pub fn desktop_update_status(app: AppHandle) -> UpdateView {
    state(&app).snapshot()
}

/**
 * 问一次有没有新版。十分钟内问过就直接回上次的结果；`force` 给「检查更新」那种人手点的。
 * 下载、安装进行中不再问——那时 pending 已经被 install 拿走了，再问一次会把进度盖掉。
 */
#[tauri::command]
pub async fn desktop_update_check(app: AppHandle, force: Option<bool>) -> UpdateView {
    let me = state(&app);
    if !enabled() || me.busy() {
        return me.snapshot();
    }
    let fresh = me
        .checked_at
        .lock()
        .ok()
        .and_then(|at| *at)
        .is_some_and(|at| at.elapsed() < CHECK_TTL);
    if fresh && !force.unwrap_or(false) && me.snapshot().phase != "error" {
        return me.snapshot();
    }
    me.edit(|v| {
        v.phase = "checking";
        v.error = None;
    });
    let result = match updater(&app) {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    if let Ok(mut at) = me.checked_at.lock() {
        *at = Some(Instant::now());
    }
    match result {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let notes = update.body.clone().filter(|s| !s.trim().is_empty());
            *me.pending.lock().unwrap_or_else(|p| p.into_inner()) = Some(update);
            me.edit(|v| {
                v.phase = "available";
                v.version = Some(version);
                v.notes = notes;
                v.downloaded = 0;
                v.total = None;
            });
        }
        Ok(None) => {
            *me.pending.lock().unwrap_or_else(|p| p.into_inner()) = None;
            me.edit(|v| {
                v.phase = "latest";
                v.version = None;
                v.notes = None;
            });
        }
        Err(e) => me.edit(|v| {
            // 查不到不算大事（没网、GitHub 被墙）：界面只在已经知道有新版时才亮，
            // 这里记下原因给「检查更新」那一下看。
            v.phase = if v.version.is_some() { "available" } else { "error" };
            v.error = Some(format!("检查更新失败：{e}"));
        }),
    }
    me.snapshot()
}

/**
 * 人点了「升级」。立即返回，下载和安装在后台跑，页面轮询 status 看进度。
 *
 * 失败时把那份 Update 放回去、状态回到 `available` 并带上原因：人可以直接再点一次，不必重查。
 */
#[tauri::command]
pub async fn desktop_update_install(app: AppHandle) -> Result<UpdateView, String> {
    let me = state(&app);
    if !enabled() {
        return Err("开发版不走自动升级".into());
    }
    if me.busy() {
        return Ok(me.snapshot());
    }
    let taken = me.pending.lock().unwrap_or_else(|p| p.into_inner()).take();
    let Some(update) = taken else {
        return Err("没有可安装的新版本，请先检查更新".into());
    };
    me.edit(|v| {
        v.phase = "downloading";
        v.downloaded = 0;
        v.total = None;
        v.error = None;
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = download_and_install(&handle, &update).await {
            let me = state(&handle);
            *me.pending.lock().unwrap_or_else(|p| p.into_inner()) = Some(update);
            me.edit(|v| {
                v.phase = "available";
                v.error = Some(error);
            });
        }
    });
    Ok(me.snapshot())
}

/**
 * macOS 上插件认「要换掉的那个 app」的办法是：可执行文件的路径里带 `Contents/MacOS`，就往上
 * 两级取 `.app`；**不带就直接取可执行文件所在的目录**，然后整个 `rm -rf` 换成新包。开发版跑在
 * target/debug 里、有人把二进制拷出来直接跑，都会落进后一种——被整个换掉的是那个目录。
 * 所以不在 `.app` 里跑的，一律不装。
 */
fn guard_install_target() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| format!("找不到当前程序的位置：{e}"))?;
    if inside_app_bundle(&exe) {
        Ok(())
    } else {
        Err(format!(
            "当前程序不在 .app 里（{}），不能原地升级，请下载安装包手动安装",
            exe.display()
        ))
    }
}

/// `/x/Satuwork.app/Contents/MacOS/<程序>` 才算。
fn inside_app_bundle(exe: &std::path::Path) -> bool {
    exe.parent().is_some_and(|dir| dir.ends_with("Contents/MacOS"))
        && exe
            .ancestors()
            .nth(3)
            .and_then(|app| app.extension())
            .is_some_and(|ext| ext == "app")
}

async fn download_and_install(app: &AppHandle, update: &Update) -> Result<(), String> {
    let progress = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                state(&progress).edit(|v| {
                    v.downloaded += chunk as u64;
                    v.total = total;
                });
            },
            || {},
        )
        .await
        .map_err(|e| format!("下载新版本失败：{e}"))?;
    guard_install_target()?;
    state(app).edit(|v| v.phase = "installing");
    // 换壳前先把本地 Bot 停干净。Windows 上 install 会直接 process::exit，RunEvent::Exit 不会来；
    // macOS 上 restart 同样不走那条。不停的话 Bot 进程要等看门狗发现壳子的 PID 没了才退，
    // 这期间新壳起来的那一份会跟它抢同一个工作区。
    crate::stop_all_local_bots(app);
    // install 是同步的，Windows 上还会在里面起安装器、退出进程；放到阻塞线程池里，
    // 别卡住 async 运行时。
    let installer = update.clone();
    tauri::async_runtime::spawn_blocking(move || installer.install(bytes))
        .await
        .map_err(|e| format!("安装新版本的后台任务异常：{e}"))?
        .map_err(|e| format!("安装新版本失败：{e}"))?;
    // 走到这儿的是 macOS / Linux：新包已经换上，重启进去。
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::inside_app_bundle;
    use std::path::Path;

    #[test]
    fn only_replaces_a_real_app_bundle() {
        assert!(inside_app_bundle(Path::new("/Applications/Satuwork.app/Contents/MacOS/satuwork-desktop")));
        assert!(inside_app_bundle(Path::new("/Users/a/Applications/Satuwork.app/Contents/MacOS/x")));
        // 开发版：插件会把 target/debug 整个换掉
        assert!(!inside_app_bundle(Path::new("/w/desktop/src-tauri/target/debug/satuwork-desktop")));
        // 路径里带 Contents/MacOS、上面却不是 .app
        assert!(!inside_app_bundle(Path::new("/tmp/Contents/MacOS/x")));
        assert!(!inside_app_bundle(Path::new("/tmp/Satuwork/Contents/MacOS/x")));
    }
}
