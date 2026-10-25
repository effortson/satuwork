//! 手机壳的「下载」：把页面要存的文件交给系统的分享面板。
//!
//! **为什么要它。** 页面里的下载都是建一个 `<a download href="blob:…">` 点一下（全都走 dom-util.js 的
//! saveBlob：对话里存文件、工作区下载、markdown 的代码块、知识库原文件）。WKWebView 没挂下载处理时，这种导航
//! 直接被取消（wry 的 navigation_policy：shouldPerformDownload 且没有 download handler → Cancel）；
//! Android 的 WebView 没装 DownloadListener，同样什么都不发生——点了没反应，也没有报错。手机上也没有
//! 「下载文件夹」这回事，存到哪儿、发给谁本来就该交给系统：iOS 的面板里有「存储到文件」、AirDrop、
//! 发给别的应用，Android 是分享选择器。
//!
//! 一条命令 `share`，页面经注入脚本调（mobile/src-tauri/src/lib.rs 的 LINK_SCRIPT 拦 `a[download]`）：
//! 请求体是文件的字节，文件名和类型放在 `x-satu-name` / `x-satu-type` 头里（URL 编码，头里放不了中文）。
//! 这里写进应用缓存目录，再让原生那半弹面板。
//!
//! 原生那一半：iOS 在 ios/Sources/SatuSharePlugin.swift，Android 在 android/src/main/java/…/SatuSharePlugin.kt。
//! 桌面上没有原生那一半，`share` 回错。
use serde::Serialize;
use tauri::{
    ipc::InvokeBody,
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_satu_share);

/// 原生那一半的句柄。桌面上没有，也就不 manage 它。
#[cfg(any(target_os = "ios", target_os = "android"))]
struct Share<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[derive(Serialize)]
#[cfg_attr(not(any(target_os = "ios", target_os = "android")), allow(dead_code))]
struct ShareArgs {
    path: String,
    mime: String,
}

/**
 * 请求体里的字节。iOS 上 IPC 走自定义协议，ArrayBuffer 原样到（Raw）；Android 的 WebView 读不到
 * 请求体，Tauri 退回 postMessage，ArrayBuffer 被编成一个数字数组的 JSON——两种都认。
 */
fn body_bytes(body: &InvokeBody) -> Result<Vec<u8>, String> {
    match body {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(serde_json::Value::Array(items)) => items
            .iter()
            .map(|v| v.as_u64().filter(|n| *n <= 255).map(|n| n as u8))
            .collect::<Option<Vec<u8>>>()
            .ok_or_else(|| "文件内容不是字节".to_string()),
        InvokeBody::Json(_) => Err("要文件的字节，收到的是别的".into()),
    }
}

fn header_text(raw: Option<&str>) -> String {
    percent_encoding::percent_decode_str(raw.unwrap_or("")).decode_utf8_lossy().into_owned()
}

/**
 * 落到缓存目录里的文件名：就是面板里、「存储到文件」里人看到的那个名字，所以尽量保留原样
 * （中文、空格都留着），只去掉能逃出目录或者文件系统不认的字符。
 */
fn file_name(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last.chars().map(|c| if c.is_control() || c == ':' { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_start_matches('.');
    let name: String = trimmed.chars().take(120).collect();
    if name.trim().is_empty() {
        "file".into()
    } else {
        name
    }
}

/// `text/plain;charset=utf-8` 只取 `text/plain`：Android 按 MIME 匹配接收方，带参数的有的应用认不出。
fn mime_type(raw: &str) -> String {
    let base = raw.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if base.contains('/') {
        base
    } else {
        "application/octet-stream".into()
    }
}

#[tauri::command]
async fn share<R: Runtime>(app: tauri::AppHandle<R>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let bytes = body_bytes(request.body())?;
    let header = |key: &str| header_text(request.headers().get(key).and_then(|v| v.to_str().ok()));
    let name = file_name(&header("x-satu-name"));
    let mime = mime_type(&header("x-satu-type"));
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        use tauri::Manager;
        // 每次先清掉上一回的：面板是模态的，再点下载时上一个文件早就用完了，攒着只占空间。
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("share");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| format!("建不了缓存目录：{e}"))?;
        let path = dir.join(&name);
        std::fs::write(&path, &bytes).map_err(|e| format!("写不了文件：{e}"))?;
        let args = ShareArgs { path: path.to_string_lossy().into_owned(), mime };
        let share = app.state::<Share<R>>();
        share.0.run_mobile_plugin_async::<serde::de::IgnoredAny>("share", args).await.map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = (app, bytes, name, mime);
        Err("只有手机壳有分享面板".into())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("satu-share")
        .invoke_handler(tauri::generate_handler![share])
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                app.manage(Share(api.register_ios_plugin(init_plugin_satu_share)?));
            }
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                app.manage(Share(api.register_android_plugin("sg.dami.satuwork.share", "SatuSharePlugin")?));
            }
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
    fn body_accepts_raw_and_number_array() {
        assert_eq!(body_bytes(&InvokeBody::Raw(vec![1, 2, 255])).unwrap(), vec![1, 2, 255]);
        assert_eq!(body_bytes(&InvokeBody::Json(serde_json::json!([104, 105]))).unwrap(), b"hi".to_vec());
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!([256]))).is_err());
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!(["a"]))).is_err());
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!({ "a": 1 }))).is_err());
    }

    #[test]
    fn file_name_keeps_text_but_not_paths() {
        assert_eq!(file_name("对话 2026-10-11.md"), "对话 2026-10-11.md");
        assert_eq!(file_name("../../etc/passwd"), "passwd");
        assert_eq!(file_name("a\\b\\c.txt"), "c.txt");
        assert_eq!(file_name(".hidden"), "hidden");
        assert_eq!(file_name("a:b\n.txt"), "a_b_.txt");
        assert_eq!(file_name(""), "file");
        assert_eq!(file_name(".."), "file");
        assert_eq!(file_name("dir/"), "file");
        assert_eq!(file_name(&"字".repeat(300)).chars().count(), 120);
        assert_eq!(header_text(Some("%E5%AF%B9%E8%AF%9D.md")), "对话.md");
    }

    #[test]
    fn mime_drops_parameters() {
        assert_eq!(mime_type("text/plain;charset=utf-8"), "text/plain");
        assert_eq!(mime_type("Image/SVG+XML; charset=utf-8"), "image/svg+xml");
        assert_eq!(mime_type(""), "application/octet-stream");
        assert_eq!(mime_type("garbage"), "application/octet-stream");
    }
}
