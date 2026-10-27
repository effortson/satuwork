//! 页面已取到的文件字节通过二进制 IPC 交给系统保存窗口，不依赖 WebView 的 blob: 下载。

use tauri::ipc::{InvokeBody, Request};
use tauri::{Url, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// 文件名只是保存窗口里的建议，不能让它带目录或平台保留字符。
fn suggested_name(encoded: &str) -> Result<String, String> {
    let url = Url::parse(&format!("satu://localhost/?name={encoded}"))
        .map_err(|e| format!("读取文件名失败：{e}"))?;
    let name = url
        .query_pairs()
        .next()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    let name = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .collect();
    let clean = clean.trim().trim_end_matches('.');
    Ok(if clean.is_empty() { "file" } else { clean }.to_string())
}

/// 只接收字节和建议文件名；写入路径始终由用户在系统窗口中选定。取消返回 false。
#[tauri::command]
pub(crate) async fn save_download(
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<bool, String> {
    let encoded = request
        .headers()
        .get("x-satuwork-download-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("file");
    let name = suggested_name(encoded)?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("文件内容必须通过二进制传递".into()),
    };
    // 系统选择器和磁盘写入都不能阻塞 UI 线程。
    tauri::async_runtime::spawn_blocking(move || {
        let selected = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(name)
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(false);
        };
        let path = selected.into_path().map_err(|e| e.to_string())?;
        std::fs::write(path, bytes).map_err(|e| format!("保存文件失败：{e}"))?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::suggested_name;

    #[test]
    fn download_names_preserve_unicode_and_drop_paths() {
        assert_eq!(
            suggested_name("%E6%B5%8B%E8%AF%95%20%2B%20%231.md").unwrap(),
            "测试 + #1.md"
        );
        assert_eq!(suggested_name("..%2F..%2Ftest.md").unwrap(), "test.md");
        assert_eq!(suggested_name("C%3A%5CUsers%5Ctest.md").unwrap(), "test.md");
        assert_eq!(suggested_name("a%00%0A%3Ab%3F.txt").unwrap(), "ab.txt");
        for empty in ["", ".", "..", "%20", "%2F"] {
            assert_eq!(suggested_name(empty).unwrap(), "file");
        }
    }
}
