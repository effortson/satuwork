//! 连哪台 Gateway：地址的来源、落盘、规整和敲门。

use std::fs;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};

/** 地址落磁盘。一台机器一个人用，没必要进 keychain——它不是凭据，只是个地址。 */
fn server_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("server.txt"))
}

/** 正式发布包连的 Gateway。 */
const DEFAULT_SERVER: &str = "https://satuwork.com";

/**
 * 服务器地址锁死：**正式发布包不让填、不让换**，固定连 DEFAULT_SERVER；只有 debug 构建
 * （`tauri dev`，本地测试）才有「连接到 Gateway」那一屏和菜单里的「切换服务器…」。
 */
pub(crate) fn server_locked() -> bool {
    !cfg!(debug_assertions)
}

/**
 * 这次连哪儿。`SATUWORK_SERVER` 两种构建都认（排查用，不写盘）；再往下：
 * 锁死时是 DEFAULT_SERVER，存在磁盘上的老地址（0.1.2 及之前用户填过的）一律不看；
 * 没锁时是用户存过的，没有就是 None，交给设置屏去问。
 * 拆成纯函数是为了能不起应用就把这条规则钉住。
 */
fn pick_server(locked: bool, from_env: Option<&str>, saved: Option<&str>) -> Option<String> {
    let fallback = if locked { Some(DEFAULT_SERVER) } else { saved };
    [from_env, fallback]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_string)
}

/**
 * 这次该连哪儿。
 *
 * `SATUWORK_SERVER` **只覆盖，不写盘**：它是给开发和排查用的，跑完一次不该改掉用户
 * 存着的那个地址。
 */
pub(crate) fn read_server(app: &AppHandle) -> Option<String> {
    let from_env = std::env::var("SATUWORK_SERVER").ok();
    let saved = server_file(app).and_then(|path| fs::read_to_string(path).ok());
    pick_server(server_locked(), from_env.as_deref(), saved.as_deref())
}

pub(crate) fn write_server(app: &AppHandle, url: &str) -> Result<(), String> {
    let path = server_file(app).ok_or("找不到配置目录")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("建配置目录失败：{e}"))?;
    }
    fs::write(path, url).map_err(|e| format!("写配置失败：{e}"))
}

/**
 * 人手打的地址得能用。`gw.example.com`、`192.168.1.10:3080` 这种不带协议的最常见，
 * 一律当 http 补上——内网部署本来就是 http（Gateway 自己也按这个假设发 cookie）。
 *
 * 只认 http/https：别的协议进到 WebviewUrl::External 里就是一扇没人审过的门。
 */
pub(crate) fn normalize(raw: &str) -> Result<Url, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("请填 Gateway 地址".into());
    }
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else {
        format!("http://{s}")
    };
    let url = Url::parse(&with_scheme).map_err(|e| format!("这个地址读不懂：{e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("只认 http 和 https，不认 {other}")),
    }
    if url.host_str().unwrap_or("").is_empty() {
        return Err("地址里没有主机名".into());
    }
    Ok(url)
}

/**
 * 打开之前先敲一下门。
 *
 * **不敲的话，连不上的表现是一片空白。** WKWebView 没有内建的错误页，装不上东西时
 * 窗口里一个字都没有——和「服务器正在重启」「地址打错一个字母」「公司 VPN 没连」
 * 长得一模一样，而人在这三种情况下要做的事完全不同。
 *
 * 只到 TCP 为止：解析得了域名、连得上端口就算数。**它证明不了那头是 Gateway**——
 * 端口通着但服务 500、或者连到了另一个服务，这里都看不出来。要的只是把最常见的那
 * 几种「白窗口」翻译成一句人话，不是健康检查。
 */
pub(crate) fn reachable(url: &Url) -> Result<(), String> {
    let host = url.host_str().unwrap_or("").to_string();
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("解析不了 {host}：{e}"))?;
    let mut last = String::from("没有可用地址");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, Duration::from_secs(3)) {
            Ok(_) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("连不上 {host}:{port}（{last}）"))
}

pub(crate) fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use super::pick_server;

    /// 正式包固定连默认地址，存过的老地址不看；本地测试按 环境变量 > 存过的，没有就 None。
    #[test]
    fn server_locked_ignores_saved_address() {
        let d = Some("https://satuwork.com");
        assert_eq!(pick_server(true, None, Some("http://old")).as_deref(), d);
        assert_eq!(pick_server(true, None, None).as_deref(), d);
        assert_eq!(pick_server(true, Some("  "), None).as_deref(), d);
        assert_eq!(
            pick_server(true, Some("http://e"), Some("http://old")).as_deref(),
            Some("http://e")
        );
        assert_eq!(
            pick_server(false, Some("http://e"), Some("http://s")).as_deref(),
            Some("http://e")
        );
        assert_eq!(
            pick_server(false, None, Some(" http://s\n")).as_deref(),
            Some("http://s")
        );
        assert_eq!(pick_server(false, None, Some("")), None);
        assert_eq!(pick_server(false, None, None), None);
    }
}
