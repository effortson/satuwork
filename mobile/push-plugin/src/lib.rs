//! 手机壳的远程推送（docs/adr-core-package-mobile.md §2.5 第 4 件）。
//!
//! 页面经 `window.__SATUWORK_PUSH__` 调（mobile/src-tauri/src/lib.rs 的注入脚本）：
//!
//! - `register`：要通知权限、要设备令牌（iOS 向 APNs，Android 向 FCM）。拿到的令牌由页面交给
//!   Gateway 的 `PUT /me/push-device`——壳子不碰登录票，登记和注销都在页面那层，和别的 API 请求一样。
//! - `take_tap`：用户点开的那条通知（botId / kind），取一次就清掉。页面在启动和回到前台时取，
//!   取到就跳到那颗 Bot 的对话。不用事件推给页面：点通知的那一刻页面可能还没起来，
//!   「放着等页面来取」两种情况都对。
//! - `background_status` / `open_background_settings`：Android 后台限制检测和应用设置入口。
//!
//! 原生那一半：iOS 在 ios/Sources/SatuPushPlugin.swift，Android 在 android/src/main/java/…/SatuPushPlugin.kt。
//! 桌面上没有原生那一半，`register` 回 `granted: false`、`take_tap` 回空，页面照常跑。
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "ios", target_os = "android"))]
use tauri::Manager;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_satu_push);

/// 原生那一半的句柄。桌面上没有，也就不 manage 它。
#[cfg(any(target_os = "ios", target_os = "android"))]
struct Push<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registered {
    /// 用户有没有允许通知。拒了就没有令牌，页面不登记。
    pub granted: bool,
    #[serde(default)]
    pub token: Option<String>,
    /// `ios` / `android`，原样交给 Gateway 的 `PUT /me/push-device`，它据此决定走 APNs 还是 FCM。
    #[serde(default)]
    pub platform: Option<String>,
    /// iOS：APNs 的哪一头认这个令牌，由**签名**决定（包里的 aps-environment），原生那半读描述文件报上来
    /// （SatuPushPlugin.swift 的 apsEnvironment）；没报的话才按编译开关猜。Android：FCM 不分环境，一律 production。
    #[serde(default)]
    pub environment: Option<String>,
    /// 要令牌失败的原因（没开推送能力、没配 Firebase、模拟器没联网……）。
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tap {
    #[serde(default)]
    pub bot_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundStatus {
    pub supported: bool,
    pub background_restricted: bool,
    pub battery_optimization_ignored: bool,
}

#[tauri::command]
async fn background_status<R: Runtime>(app: tauri::AppHandle<R>) -> Result<BackgroundStatus, String> {
    #[cfg(target_os = "android")]
    {
        let push = app.state::<Push<R>>();
        push.0.run_mobile_plugin_async("backgroundStatus", ()).await.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(BackgroundStatus::default())
    }
}

#[tauri::command]
async fn open_background_settings<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let push = app.state::<Push<R>>();
        push.0.run_mobile_plugin_async("openBackgroundSettings", ()).await.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Background settings are only available on Android".into())
    }
}

/**
 * 报给 Gateway 的环境。iOS 以原生那半从描述文件读到的为准：本机 `build:ios` 出的 release 包是开发签名，
 * 令牌只在 sandbox 认，按编译开关报 production 会让 Gateway 发错地方、把令牌当作废摘掉。原生那半
 * 没报（或报了不认识的）才退回按编译开关猜。
 */
#[cfg_attr(not(any(target_os = "ios", target_os = "android", test)), allow(dead_code))]
fn environment_of(ios: bool, native: Option<&str>, debug: bool) -> &'static str {
    if !ios {
        return "production";
    }
    match native {
        Some("sandbox") => "sandbox",
        Some("production") => "production",
        _ if debug => "sandbox",
        _ => "production",
    }
}

#[tauri::command]
async fn register<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Registered, String> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let push = app.state::<Push<R>>();
        let mut out: Registered = push.0.run_mobile_plugin_async("register", ()).await.map_err(|e| e.to_string())?;
        if out.token.is_some() {
            let ios = cfg!(target_os = "ios");
            out.platform = Some(if ios { "ios" } else { "android" }.into());
            out.environment = Some(environment_of(ios, out.environment.as_deref(), cfg!(debug_assertions)).into());
        }
        Ok(out)
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = app;
        Ok(Registered::default())
    }
}

#[tauri::command]
async fn take_tap<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Tap, String> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let push = app.state::<Push<R>>();
        push.0.run_mobile_plugin_async("takeTap", ()).await.map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = app;
        Ok(Tap::default())
    }
}

#[tauri::command]
async fn clear_notifications<R: Runtime>(app: tauri::AppHandle<R>, ids: Vec<String>) -> Result<(), String> {
    if ids.len() > 1000 || ids.iter().any(|id| id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err("Invalid notification identifiers".into());
    }
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let push = app.state::<Push<R>>();
        #[derive(Serialize)]
        struct Args { ids: Vec<String> }
        push.0.run_mobile_plugin_async("clearNotifications", Args { ids }).await.map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    { let _ = (app, ids); Ok(()) }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("satu-push")
        .invoke_handler(tauri::generate_handler![register, take_tap, clear_notifications, background_status, open_background_settings])
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            app.manage(Push(api.register_ios_plugin(init_plugin_satu_push)?));
            #[cfg(target_os = "android")]
            app.manage(Push(api.register_android_plugin("sg.dami.satuwork.push", "SatuPushPlugin")?));
            #[cfg(not(any(target_os = "ios", target_os = "android")))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ios_environment_follows_the_signature() {
        // 本机 release 包是开发签名：原生报 sandbox，就得是 sandbox，不能因为是 release 就报 production。
        assert_eq!(environment_of(true, Some("sandbox"), false), "sandbox");
        assert_eq!(environment_of(true, Some("production"), true), "production");
        assert_eq!(environment_of(true, None, true), "sandbox");
        assert_eq!(environment_of(true, None, false), "production");
        assert_eq!(environment_of(true, Some("weird"), false), "production");
        assert_eq!(environment_of(false, Some("sandbox"), true), "production");
    }
}
