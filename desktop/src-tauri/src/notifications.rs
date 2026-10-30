//! 桌面通知只依赖当前进程的实时流。焦点由原生窗口核对，不登记 APNs/FCM 设备。

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::{Action, ActionType, NotificationExt};

// 各平台认的声音名称不同。随系统通知播放，让系统的静音、勿扰和应用通知设置继续生效。
const NOTIFICATION_SOUND: &str = if cfg!(target_os = "macos") {
    "Ping"
} else if cfg!(windows) {
    "Default"
} else {
    "message-new-instant"
};

#[derive(Default)]
struct Session {
    account_id: Option<String>,
    generation: u64,
    next_notification_id: i32,
    notification_ids: HashMap<String, i32>,
}

#[derive(Default)]
pub(crate) struct DesktopNotifications(Mutex<Session>);

pub(crate) fn reset(app: &AppHandle) {
    let state = app.state::<DesktopNotifications>();
    if let Ok(mut session) = state.0.lock() {
        session.account_id = None;
        session.generation += 1;
        session.notification_ids.clear();
    }
    let _ = app.notification().remove_all_active();
}

impl Session {
    fn accepts(&self, generation: u64, focused: bool) -> bool {
        self.account_id.is_some() && self.generation == generation && !focused
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Notice {
    generation: u64,
    bot_id: String,
    title: String,
    #[serde(default)]
    body: String,
    kind: String,
    locale: String,
    #[serde(default)]
    notification_id: String,
}

#[tauri::command]
pub(crate) fn desktop_clear_notifications(
    app: AppHandle,
    generation: u64,
    ids: Vec<String>,
) -> Result<(), String> {
    if ids.len() > 1000 {
        return Err("Too many notification identifiers".into());
    }
    let state = app.state::<DesktopNotifications>();
    let mut session = state.0.lock().map_err(|e| e.to_string())?;
    if session.account_id.is_none() || session.generation != generation {
        return Ok(());
    }
    let system_ids = ids
        .iter()
        .filter_map(|id| session.notification_ids.get(id).copied())
        .collect();
    app.notification()
        .remove_active(system_ids)
        .map_err(|e| e.to_string())?;
    for id in ids {
        session.notification_ids.remove(&id);
    }
    Ok(())
}

fn body(kind: &str, locale: &str) -> Result<&'static str, String> {
    match (kind, locale == "en") {
        ("turn-end", false) => Ok("回复好了"),
        ("turn-end", true) => Ok("Replied"),
        ("approval", false) => Ok("在等你批准一个操作"),
        ("approval", true) => Ok("Waiting for your approval"),
        ("handoff", false) => Ok("转给你一件事，需要人来接手"),
        ("handoff", true) => Ok("Handed something over to you"),
        _ => Err("未知的通知类型".into()),
    }
}

fn notice_body(kind: &str, locale: &str, preview: &str) -> Result<String, String> {
    let fallback = body(kind, locale)?;
    Ok(if preview.trim().is_empty() {
        fallback.to_string()
    } else {
        preview.trim().chars().take(240).collect()
    })
}

/// 换账号或退出时使旧请求和旧通知点击失效；不保存设备令牌。
#[tauri::command]
pub(crate) async fn desktop_notification_session(
    app: AppHandle,
    account_id: Option<String>,
) -> Result<u64, String> {
    let state = app.state::<DesktopNotifications>();
    let mut session = state.0.lock().map_err(|e| e.to_string())?;
    if session.account_id != account_id {
        session.account_id = account_id;
        session.generation += 1;
        session.notification_ids.clear();
        app.notification()
            .remove_all_active()
            .map_err(|e| e.to_string())?;
    }
    Ok(session.generation)
}

#[tauri::command]
pub(crate) async fn desktop_notify(app: AppHandle, notice: Notice) -> Result<bool, String> {
    let text = notice_body(&notice.kind, &notice.locale, &notice.body)?;
    if notice.bot_id.is_empty() || app.get_webview_window(crate::MAIN).is_none() {
        return Ok(false);
    }
    // 所有应用窗口都算：用户在设置页或其他应用窗口操作时也不打断。
    let focused = app
        .webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(true));
    let state = app.state::<DesktopNotifications>();
    let mut session = state.0.lock().map_err(|e| e.to_string())?;
    if !session.accepts(notice.generation, focused) {
        return Ok(false);
    }
    let mut builder = app.notification().builder();
    if !notice.notification_id.is_empty() {
        let id = if let Some(id) = session.notification_ids.get(&notice.notification_id) {
            *id
        } else {
            session.next_notification_id = session
                .next_notification_id
                .checked_add(1)
                .ok_or("Too many notifications")?;
            let id = session.next_notification_id;
            session
                .notification_ids
                .insert(notice.notification_id.clone(), id);
            id
        };
        builder = builder.id(id);
    }
    builder
        .title(notice.title.chars().take(120).collect::<String>())
        .body(text)
        .sound(NOTIFICATION_SOUND)
        .action_type_id(if notice.locale == "en" {
            "satuwork-open-en"
        } else {
            "satuwork-open-zh"
        })
        .extra("botId", notice.bot_id)
        .extra("generation", notice.generation)
        .extra("notificationId", notice.notification_id)
        .show()
        .map_err(|e| e.to_string())?;
    Ok(true)
}

pub(crate) fn listen_for_taps(app: &AppHandle) -> tauri::Result<()> {
    // macOS 的通知后端只有带操作按钮时才等待点击回调。提供明确的「打开」操作，
    // 也让点击通知正文能带着原通知的数据回到指定 Bot，而不只是由系统恢复窗口。
    app.notification()
        .register_action_types(vec![
            ActionType::builder("satuwork-open-zh")
                .actions(vec![Action::builder("open", "打开").build()])
                .build(),
            ActionType::builder("satuwork-open-en")
                .actions(vec![Action::builder("open", "Open").build()])
                .build(),
        ])
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;
    let handle = app.clone();
    app.notification()
        .on_action(move |action| {
            if !matches!(action.action_id(), "tap" | "open") {
                return;
            }
            let Some(notification) = action.notification() else {
                return;
            };
            let Some(generation) = notification
                .extra()
                .get("generation")
                .and_then(|v| v.as_u64())
            else {
                return;
            };
            let Some(bot_id) = notification.extra().get("botId").and_then(|v| v.as_str()) else {
                return;
            };
            let state = handle.state::<DesktopNotifications>();
            if !state
                .0
                .lock()
                .map(|s| s.accepts(generation, false))
                .unwrap_or(false)
            {
                return;
            }
            if let Some(window) = handle.get_webview_window(crate::MAIN) {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                let bot_json = serde_json::to_string(bot_id).unwrap_or_default();
                let _ = window.eval(format!(
                    "window.__SATUWORK_DESKTOP_NOTIFICATION_TAPPED__?.({generation}, {bot_json})"
                ));
            }
        })
        .map_err(|e| tauri::Error::Anyhow(e.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_uses_reply_preview_with_legacy_fallback_and_unicode_limit() {
        assert_eq!(
            notice_body("turn-end", "zh", " 已整理好 3 张发票 ").unwrap(),
            "已整理好 3 张发票"
        );
        assert_eq!(notice_body("turn-end", "en", " ").unwrap(), "Replied");
        assert_eq!(
            notice_body("turn-end", "zh", &"✅".repeat(300))
                .unwrap()
                .chars()
                .count(),
            240
        );
        assert!(notice_body("unknown", "zh", "摘要").is_err());
    }

    #[test]
    fn only_current_signed_in_background_session_can_notify() {
        let session = Session {
            account_id: Some("account-a".into()),
            generation: 2,
            ..Session::default()
        };
        assert!(session.accepts(2, false));
        assert!(!session.accepts(2, true));
        assert!(!session.accepts(1, false));
        assert!(!Session::default().accepts(0, false));
        assert_eq!(body("approval", "en").unwrap(), "Waiting for your approval");
        assert!(body("unknown", "zh").is_err());
    }
}
