//! 从包里发界面：`satu://localhost/…` 协议、MIME 和主窗口那份 CSP。

use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// 包里那份界面在哪：发布包里是资源目录下的 ui/（scripts/copy-ui.mjs 拷进去的），开发时直接读仓库里的 gateway/ui。
fn ui_dir(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../gateway/ui");
        if source.join("index.html").is_file() {
            return Some(source);
        }
    }
    app.path().resource_dir().ok().map(|dir| dir.join("ui")).filter(|dir| dir.join("index.html").is_file())
}

fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// UI_CSP 里 CDN 那几条路径源，三条指令共用；由来见 UI_CSP 的注释。
macro_rules! ui_cdn {
    () => {
        "https://cdn.jsdelivr.net/npm/katex@0.16.11/ https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/ https://cdn.jsdelivr.net/npm/mermaid@11.4.1/ https://cdn.jsdelivr.net/npm/three@0.170.0/ https://cdn.jsdelivr.net/npm/jszip@3.10.1/ https://cdn.jsdelivr.net/npm/docx-preview@0.4.1/ https://cdn.jsdelivr.net/npm/exceljs@4.4.0/ https://cdn.jsdelivr.net/npm/@aiden0z/pptx-renderer@1.3.0/"
    };
}

/**
 * 主窗口那份界面的 CSP，挂在 serve_ui 发出的每一个 html 响应上。
 *
 * **为什么要有。** 主窗口调得动本地 Bot 那组命令（起进程、批准目录），渲染的又是模型输出和
 * 用户写的 markdown——等同于外部输入。markdown.js 那层已经转义、白名单协议，但它是唯一一道
 * 防线；漏一处，注进来的脚本就能直接 invoke。这条头是第二道：**脚本只认包里的文件和那一个
 * CDN**，内联脚本、`javascript:`、eval、`<object>` 都不行。tauri.conf.json 里的 `csp` 管不到
 * 这里——Tauri 只把它挂在自己的 tauri:// 资源上（设置屏），自注册协议的响应得自己带。
 *
 * 底子照抄 Gateway 发页面时那条（gateway/src/http.ts 的 CSP），界面是同一批文件、在浏览器里
 * 已经跑得通。和它的不同都是因为源换了：
 *
 * - `'self'` 之外再写一遍 `satu:` 和 `http(s)://satu.localhost`：自定义 scheme 在各家 webview
 *   里算不算 `'self'` 不一定，Windows 上它又被映射成 http://satu.localhost。
 * - `connect-src` 放整个 `https: http:`（外加 `ws: wss:`）：Gateway 是人填的地址，内网部署
 *   就是 http；席位机器的直连对话流、本机的本地 Bot（http://127.0.0.1:<随机口>）也都在这里。
 *   `ipc: http://ipc.localhost` 是 Tauri 的 IPC 通道（invoke 走的就是它），少了本地 Bot 的
 *   命令全调不动。
 * - `frame-src https: http: blob:`：桌面那块 noVNC iframe（席位机器的直连地址）和文件预览的
 *   blob iframe。
 * - `img-src` / `media-src` 放 `https: http:`：图片地址是模型写的，附件从 Gateway 来。
 *
 * 刻意的松：`style-src 'unsafe-inline'`（界面里几十处 `style="…"`，内联样式换不出脚本执行）。
 * 刻意的紧：`script-src` 不带 `'unsafe-inline'` / `'unsafe-eval'`，和 Gateway 那条一样；
 * index.html 和各分片里没有内联脚本，e2e 有一条按源码扫的用例守着。Tauri 注入的初始化脚本
 * （LINK_SCRIPT、IPC 那几段）是 webview 的 user script，不受页面 CSP 管。
 *
 * CDN 只放行 KaTeX / highlight.js / Mermaid 那三个「包@版本/」目录，不放整个 cdn.jsdelivr.net
 * （jsdelivr 出任意 npm 包，放行整个源等于放行任何人发的脚本）。这三条是照
 * gateway/src/ui-cdn.ts 的 UI_CDN_PACKAGES 手抄的——桌面包里的页面没有 Gateway 插的
 * `<meta name="satu-cdn">`，markdown.js 用的是 jsdelivr 默认值。**改版本要一起改**，e2e 的
 * markdown 那一组按源码核对这三处；挡掉的表现是公式和图静默退回纯文本。
 *
 * 设置屏（shell/index.html，走 tauri://）的那条在 tauri.conf.json 的 `csp`：只认自己的文件和
 * IPC；页面里那段内联 `<script>` / `<style>` 由 Tauri 编译期算哈希补进策略，不用开
 * `'unsafe-inline'`。
 */
const UI_CSP: &str = concat!(
    "default-src 'self' satu: http://satu.localhost https://satu.localhost; ",
    "base-uri 'none'; ",
    "object-src 'none'; ",
    "script-src 'self' satu: http://satu.localhost https://satu.localhost ", ui_cdn!(), "; ",
    "style-src 'self' satu: http://satu.localhost https://satu.localhost 'unsafe-inline' ", ui_cdn!(), " https://fonts.googleapis.com; ",
    "font-src 'self' satu: http://satu.localhost https://satu.localhost data: ", ui_cdn!(), " https://fonts.gstatic.com; ",
    "img-src 'self' satu: http://satu.localhost https://satu.localhost data: blob: https: http:; ",
    "media-src 'self' satu: http://satu.localhost https://satu.localhost data: blob: https: http:; ",
    "connect-src 'self' satu: http://satu.localhost https://satu.localhost ipc: http://ipc.localhost https: http: wss: ws:; ",
    "frame-src 'self' satu: http://satu.localhost https://satu.localhost blob: https: http:; ",
    "worker-src 'self' satu: http://satu.localhost https://satu.localhost blob:"
);

/**
 * 界面路径里的一段能不能拼到 ui 目录后面。`..` / `.` 逃目录；`\\` 在 Windows 上是分隔符；
 * `:` 挡的是 Windows 的盘符前缀（`C:foo` 被 PathBuf::push 当成另一个盘上的路径，整个替换掉
 * ui 目录）和 NTFS 的备用数据流（`index.html:x`）。界面文件名里本来就没有冒号。
 */
fn safe_ui_segment(seg: &str) -> bool {
    !(seg == ".." || seg == "." || seg.contains('\\') || seg.contains(':'))
}

/**
 * `satu://localhost/…`：从包里发界面。
 *
 * 和 Gateway 的 serveUi 同一套规矩：路径不得逃出目录；找不到的路径**回 index.html**——这是个
 * 单页应用，`/a/bot-1` 这种地址刷新一下也得回到同一页。Tauri 自带的 asset 协议没有这条兜底，
 * 所以自己发。
 */
pub(crate) fn serve_ui(app: &AppHandle, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Cow<'static, [u8]>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(tauri::http::StatusCode::NOT_FOUND)
            .header("content-type", "text/plain; charset=utf-8")
            .body(Cow::Borrowed("包里没有界面文件（gateway/ui）".as_bytes()))
            .unwrap()
    };
    let Some(dir) = ui_dir(app) else { return not_found() };
    let raw = request.uri().path().trim_start_matches('/');
    let rel = raw.split('?').next().unwrap_or("");
    let mut file = dir.clone();
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        if !safe_ui_segment(seg) {
            return not_found();
        }
        file.push(seg);
    }
    // Gateway 那边 /ui/x.js 也认；这里同样去掉 ui/ 前缀，两处发的是同一批文件。
    if !file.is_file() {
        let stripped = rel.strip_prefix("ui/").unwrap_or(rel);
        let mut alt = dir.clone();
        for seg in stripped.split('/').filter(|s| !s.is_empty()) {
            alt.push(seg);
        }
        file = if alt.is_file() && !stripped.is_empty() { alt } else { dir.join("index.html") };
    }
    let Ok(bytes) = fs::read(&file) else { return not_found() };
    let mime = mime_of(&file);
    let mut response = tauri::http::Response::builder()
        .status(tauri::http::StatusCode::OK)
        .header("content-type", mime)
        .header("cache-control", "no-store");
    // 和 Gateway 一样只挂在页面本身上：脚本、样式是被这一页加载的，约束它们的是这一页的策略。
    if mime.starts_with("text/html") {
        response = response.header("content-security-policy", UI_CSP);
    }
    response.body(Cow::Owned(bytes)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::safe_ui_segment;

    #[test]
    fn ui_path_segments_cannot_escape_ui_directory() {
        for ok in ["index.html", "chat.js", "assets", "satuwork-logo.png"] {
            assert!(safe_ui_segment(ok), "该放行：{ok}");
        }
        for bad in ["..", ".", "C:", "C:..", "c:foo", "index.html:x", "a\\b"] {
            assert!(!safe_ui_segment(bad), "不该放行：{bad}");
        }
    }
}
