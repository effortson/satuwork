//! The macOS and Windows frames belong to the app. Commands always target the invoking window.

use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

pub(crate) fn custom_chrome() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

pub(crate) fn initialization_script() -> String {
    let platform = if cfg!(target_os = "windows") {
        "windows"
    } else {
        "macos"
    };
    if custom_chrome() {
        format!(
            "window.__SATUWORK_WINDOW_PLATFORM__ = '{}';\n{}",
            platform,
            include_str!("../../../gateway/ui/desktop-window.js")
        )
    } else {
        String::new()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WindowAction {
    Close,
    Minimize,
    Fullscreen,
    Zoom,
    Drag,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowState {
    focused: bool,
    fullscreen: bool,
    maximized: bool,
    resizable: bool,
}

#[tauri::command]
pub(crate) fn desktop_window_state(window: WebviewWindow) -> Result<WindowState, String> {
    Ok(WindowState {
        focused: window.is_focused().map_err(|e| e.to_string())?,
        fullscreen: window.is_fullscreen().map_err(|e| e.to_string())?,
        maximized: window.is_maximized().map_err(|e| e.to_string())?,
        resizable: window.is_resizable().map_err(|e| e.to_string())?,
    })
}

#[tauri::command]
pub(crate) fn desktop_window_action(
    window: WebviewWindow,
    action: WindowAction,
) -> Result<(), String> {
    let result = match action {
        WindowAction::Close => window.close(),
        WindowAction::Minimize => window.minimize(),
        WindowAction::Drag => window.start_dragging(),
        WindowAction::Fullscreen => {
            if !window.is_resizable().map_err(|e| e.to_string())? {
                return Ok(());
            }
            window.set_fullscreen(!window.is_fullscreen().map_err(|e| e.to_string())?)
        }
        WindowAction::Zoom => {
            if !window.is_resizable().map_err(|e| e.to_string())?
                || window.is_fullscreen().map_err(|e| e.to_string())?
            {
                return Ok(());
            }
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
    };
    result.map_err(|e| e.to_string())
}
