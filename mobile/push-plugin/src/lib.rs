//! 手机壳的远程推送（docs/adr-core-package-mobile.md §2.5 第 4 件）。
//!
//! 两条命令，页面经 `window.__SATUWORK_PUSH__` 调（mobile/src-tauri/src/lib.rs 的注入脚本）：
//!
//! - `register`：要通知权限、向 APNs 要设备令牌。拿到的令牌由页面交给 Gateway 的
//!   `PUT /me/push-device`——壳子不碰登录票，登记和注销都在页面那层，和别的 API 请求一样。
//! - `take_tap`：用户点开的那条通知（botId / kind），取一次就清掉。页面在启动和回到前台时取，
//!   取到就跳到那颗 Bot 的对话。不用事件推给页面：点通知的那一刻页面可能还没起来，
//!   「放着等页面来取」两种情况都对。
//!
//! 只有 iOS 有原生那一半（ios/Sources/SatuPushPlugin.swift）。别的平台 `register` 回
//! `granted: false`、`take_tap` 回空，页面照常跑。Android（FCM）还没做。
use serde::{Deserialize, Serialize};
#[cfg(target_os = "ios")]
use tauri::Manager;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_satu_push);

/// iOS 那一半的句柄。别的平台没有原生那一半，也就不 manage 它。
#[cfg(target_os = "ios")]
struct Push<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registered {
    /// 用户有没有允许通知。拒了就没有令牌，页面不登记。
    pub granted: bool,
    #[serde(default)]
    pub token: Option<String>,
    /// APNs 的哪一头认这个令牌。由**构建**决定，不是由 Swift 决定：debug 构建的签名带的是
    /// `aps-environment: development`，令牌只在 sandbox 认；发布包是 production。
    #[serde(default)]
    pub environment: Option<String>,
    /// 要令牌失败的原因（没开推送能力、模拟器没联网……）。权限给了但没令牌时才有。
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

#[tauri::command]
async fn register<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Registered, String> {
    #[cfg(target_os = "ios")]
    {
        let push = app.state::<Push<R>>();
        let mut out: Registered = push.0.run_mobile_plugin_async("register", ()).await.map_err(|e| e.to_string())?;
        if out.token.is_some() {
            out.environment = Some(if cfg!(debug_assertions) { "sandbox" } else { "production" }.into());
        }
        Ok(out)
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Ok(Registered::default())
    }
}

#[tauri::command]
async fn take_tap<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Tap, String> {
    #[cfg(target_os = "ios")]
    {
        let push = app.state::<Push<R>>();
        push.0.run_mobile_plugin_async("takeTap", ()).await.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Ok(Tap::default())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("satu-push")
        .invoke_handler(tauri::generate_handler![register, take_tap])
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            app.manage(Push(api.register_ios_plugin(init_plugin_satu_push)?));
            #[cfg(not(target_os = "ios"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}
