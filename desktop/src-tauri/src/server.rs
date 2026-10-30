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

/** 默认连的 Gateway（发布包按地区编进来的那台）；没存过地址就连它。 */
pub(crate) const DEFAULT_SERVER: &str = crate::distribution::GATEWAY;

/**
 * 这次连哪儿：`SATUWORK_SERVER` > 用户存过的 > DEFAULT_SERVER。
 *
 * 以前正式包锁死只连 DEFAULT_SERVER（fdacc18），现在放开了：登录页的「服务器」弹窗能改，
 * 改之前要先过 check。中国区包也一样认存过的地址。
 * 拆成纯函数是为了能不起应用就把这条规则钉住。
 */
fn pick_server(from_env: Option<&str>, saved: Option<&str>) -> String {
    [from_env, saved]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SERVER)
        .to_string()
}

/**
 * 这次该连哪儿。
 *
 * `SATUWORK_SERVER` **只覆盖，不写盘**：它是给开发和排查用的，跑完一次不该改掉用户
 * 存着的那个地址。
 */
pub(crate) fn read_server(app: &AppHandle) -> String {
    let from_env = std::env::var("SATUWORK_SERVER").ok();
    let saved = server_file(app).and_then(|path| fs::read_to_string(path).ok());
    pick_server(from_env.as_deref(), saved.as_deref())
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

/**
 * 换服务器之前的那一下检测：比 reachable 多走一步，真去要一次 `/health`，回 `{"ok":true}` 才算
 * 是一台 Gateway。端口通着但那头是别的服务、或者 Gateway 起来了却在 500，reachable 都看不出来；
 * 这里是人主动要换地址，宁可慢一两秒把这些拦在门外，也别存下一个进去就白屏的地址。
 *
 * 阻塞调用，放进 spawn_blocking 里用。
 */
pub(crate) fn check(url: &Url) -> Result<(), String> {
    reachable(url)?;
    let health = format!("{}/health", url.as_str().trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("建 HTTP 客户端失败：{e}"))?;
    let resp = client
        .get(&health)
        .send()
        .map_err(|e| format!("请求 {health} 失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("{health} 回了 HTTP {}，这个地址不像是 Satuwork Gateway", status.as_u16()));
    }
    let body: serde_json::Value = resp
        .json()
        .map_err(|_| format!("{health} 回的不是 Gateway 的响应，这个地址不像是 Satuwork Gateway"))?;
    if body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!("{health} 没有报告正常（ok 不是 true）"));
    }
    Ok(())
}

pub(crate) fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use super::pick_server;

    /// 环境变量 > 存过的 > 默认地址；空白的不算。
    #[test]
    fn server_falls_back_to_default() {
        let d = super::DEFAULT_SERVER;
        assert_eq!(pick_server(Some("http://e"), Some("http://s")), "http://e");
        assert_eq!(pick_server(Some("  "), Some(" http://s\n")), "http://s");
        assert_eq!(pick_server(None, Some("http://s")), "http://s");
        assert_eq!(pick_server(None, Some("")), d);
        assert_eq!(pick_server(None, None), d);
    }
}
