//! 主窗口的导航守卫：注入的链接脚本、站外地址交给系统、内嵌桌面放行，以及建主窗口。

use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::server::same_origin;
use crate::{is_ui_origin, OPEN_PATH, UI_ORIGIN};

/**
 * 注入主窗口页面的一小段：**把「开新窗口」翻译成一次导航**。
 *
 * 起因是实测出来的一件事：`target="_blank"` 的链接和 `window.open()` 在这个 webview
 * 里都是**空操作**——不报错、不开窗、连请求都不发。而 gateway/ui 的外链一律带
 * `target="_blank"`（markdown.js 渲染的每个链接、chat.js 那个「打开桌面」按钮），
 * 于是在桌面端它们全部变成了点不动的死链，界面上还没有任何提示。
 *
 * 这段脚本把它们改写成一次到 OPEN_PATH 的普通导航，交给 Rust 那边分流：同源的另开
 * 一扇应用窗口，站外的交给系统浏览器。
 *
 * **不改同源的普通链接**——那是页面自己的路由，改了等于把界面拆了。
 */
const LINK_SCRIPT: &str = r#"
(function () {
  // 界面是包里自带的那份，和 Gateway 发的是同一批文件。给它一个只由桌面壳注入的标记，让登录票
  // 可以落到持久存储；再告诉它 Gateway 在哪——页面源是 satu://localhost，相对路径打不到 Gateway。
  window.__SATUWORK_DESKTOP__ = true
  window.__SATUWORK_GATEWAY__ = __GATEWAY_URL__
  window.__SATUWORK_LOCAL_BOT__ = {
    start: function (config) { return window.__TAURI_INTERNALS__.invoke('start_local_bot', { config: config }) },
    stop: function (botId) { return window.__TAURI_INTERNALS__.invoke('stop_local_bot', { botId: botId }) },
    status: function (botId) { return window.__TAURI_INTERNALS__.invoke('local_bot_status', { botId: botId }) },
    approveDirectory: function (botId, path) { return window.__TAURI_INTERNALS__.invoke('approve_local_directory', { botId: botId, path: path || null }) },
    directories: function (botId) { return window.__TAURI_INTERNALS__.invoke('local_directories', { botId: botId }) },
    revokeDirectory: function (botId, path) { return window.__TAURI_INTERNALS__.invoke('revoke_local_directory', { botId: botId, path: path }) }
  }
  // Desktop 壳自己的升级（self_update.rs）：侧栏那条「有新版本」由它驱动。
  window.__SATUWORK_DESKTOP_UPDATE__ = {
    status: function () { return window.__TAURI_INTERNALS__.invoke('desktop_update_status') },
    check: function (force) { return window.__TAURI_INTERNALS__.invoke('desktop_update_check', { force: Boolean(force) }) },
    install: function () { return window.__TAURI_INTERNALS__.invoke('desktop_update_install') }
  }
  // 连哪台 Gateway：登录页右上角那颗「服务器」按钮用。检测通过才写盘，然后壳子用新地址重建主窗口。
  window.__SATUWORK_SERVER__ = {
    info: function () { return window.__TAURI_INTERNALS__.invoke('gateway_server_info') },
    check: function (url) { return window.__TAURI_INTERNALS__.invoke('check_gateway_server', { url: url }) },
    use: function (url) { return window.__TAURI_INTERNALS__.invoke('use_gateway_server', { url: url }) }
  }
  // 内嵌桌面挂上之前先报一声地址，导航守卫只放行报过的机器（allow_seat_desktop）。
  window.__SATUWORK_SEAT_DESKTOP__ = {
    allow: function (url) { return window.__TAURI_INTERNALS__.invoke('allow_seat_desktop', { url: url }) }
  }
  if (window.__satuLinkPatched) return
  window.__satuLinkPatched = true
  function hand(raw) {
    try {
      var abs = new URL(raw, location.href).href
      location.href = location.origin + __OPEN_PATH__ + '?u=' + encodeURIComponent(abs)
    } catch (e) {}
  }
  var open0 = window.open
  window.open = function (u) {
    if (u) hand(String(u))
    return null
  }
  document.addEventListener(
    'click',
    function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return
      var el = e.target
      var a = el && el.closest ? el.closest('a[target="_blank"]') : null
      if (!a || !a.href) return
      e.preventDefault()
      hand(a.href)
    },
    true,
  )
})()
"#;

/**
 * 每一次导航都过这里。
 *
 * 要挡的**只有一件事**：把唯一的窗口导航到站外。这个壳没有地址栏也没有后退，页面
 * 一旦跳出去，人就被关在一个回不来的地方了。
 *
 * 所以按 scheme 分流：**hand_to_system 那几种之外的一律放行**。第一版是「白名单 + 同源」，
 * 而白名单永远漏得掉——`blob:`（附件预览喂给 iframe 的那个）漏了就是预览白屏，
 * `ws:` 漏了就是桌面没画面，而同源比较里 `ws` 和 `http` 本来就不是同一个字。
 * `mailto:` / `tel:` / `sms:` 以前也在放行里，可 WebView 自己打不开它们：WKWebView 上
 * 点了什么都不发生，所以和站外网页一样交给系统。
 *
 * 拦这些也拦不住什么：页面里的 JS 想连哪儿就能连哪儿，这条回调不是它的边界。
 * 它是「窗口跑没跑掉」的边界，仅此而已。
 */
fn allow_navigation(app: &AppHandle, base: &Url, url: &Url) -> bool {
    // 链接脚本递过来的暗号：在界面自己的源上，路径是 OPEN_PATH。先认它，再看 scheme。
    // 源不对的不认（见 open_path_allowed），当一次普通导航往下走。
    if open_path_allowed(url, base) {
        route_open(app, base, url);
        return false;
    }
    // 界面自身（包含 Windows 上的 http://satu.localhost）必须放行留在窗口内。
    if is_ui_origin(url) {
        return true;
    }
    if !hand_to_system(url) {
        return true;
    }
    // 内嵌桌面那块 iframe 也是一次 http(s) 导航，不能跟着往系统浏览器送。
    let seats = app.state::<SeatOrigins>();
    let allowed = seats.0.lock().map(|s| seat_desktop_allowed(url, base, &s)).unwrap_or(false);
    if allowed {
        return true;
    }
    // 界面在自己的源上，任何 http(s) 导航都是往外走（OAuth 跳转、外链）：交给系统浏览器，
    // 窗口留在原地。以前界面在 Gateway 的源上时同源导航是页面自己的路由，现在没有这一类了。
    // mailto: / tel: / sms: 同样交出去，由系统挑邮件、电话、短信应用。
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
    false
}

/**
 * 交给系统处理、窗口不动的那几种地址：站外网页给浏览器，`mailto:` / `tel:` / `sms:` 给邮件、电话、
 * 短信。后三种 WebView 自己打不开——放行的话点了什么都不发生，而 markdown 里的邮箱、电话正是
 * 对话里常点的链接。别的协议（blob:、data:、ws: 这些页面内部用的）不归这里管。
 *
 * 和 mobile/src-tauri/src/lib.rs 的同名函数一起改。
 */
fn hand_to_system(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto" | "tel" | "sms")
}

/**
 * 这次导航是不是内嵌桌面那块 iframe 在加载席位机器的 noVNC。
 *
 * **为什么需要这一条。** 上面那条回调想挡的是「唯一的窗口跑到站外」，可它分不出主框架
 * 和子框架——wry 的 navigation_policy 把 WKNavigationAction 里的 URL 取出来就交给上层，
 * `targetFrame.isMainFrame` 从头到尾没碰过。于是右栏那块屏（`{directUrl}/seats/<席位>/vnc/`，
 * 见 gateway/ui/chat-desktop.js 的 mountDesktop）一挂上去就被判成「往外走」：地址送进系统浏览器，
 * iframe 这边 Cancel。表现是桌面从窗口里跳到浏览器里打开，而配置上看不出任何毛病。
 *
 * **只认路径不够，还得认源。** 以前只看路径，于是 `http://evil.com/seats/x/vnc/` 也放行：
 * 被诱导的主窗口、或者框里那页自己导航过去，窗口就跑出去了。机器的直连地址按公司各不相同、
 * 壳子这头无从枚举，所以由界面在挂 iframe 之前把那个地址报上来（allow_seat_desktop），
 * 这里只放行报过的源和 Gateway 自己的源，见 seat_desktop_allowed。
 *
 * 管家那一跳（`/seats/<席位>/vnc/` → `/seats/<席位>/vnc/vnc.html?…`，见 manager/src/proxy.ts）
 * 也是一次导航，所以判的是前缀而不是整条路径。
 */
fn is_seat_desktop(url: &Url) -> bool {
    let mut seg = match url.path_segments() {
        Some(it) => it,
        None => return false,
    };
    // /seats/<席位>/vnc[/…]
    seg.next() == Some("seats")
        && seg.next().is_some_and(|s| !s.is_empty())
        && seg.next() == Some("vnc")
}

/// 界面报上来的席位机器源（`https://m001.example.com` 这种），见 allow_seat_desktop。
#[derive(Default)]
pub(crate) struct SeatOrigins(Mutex<HashSet<String>>);

fn origin_key(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/**
 * 内嵌桌面放不放行：路径是 `/seats/<席位>/vnc…`，**并且**源是 Gateway 自己的、或者界面
 * 挂 iframe 前报过的那台机器。报名单的命令只放给本地源（capabilities/main.json），框里那页
 * 和跑到站外的页面都调不到，所以名单上只会有界面自己拿到的桌面地址。
 */
fn seat_desktop_allowed(url: &Url, gateway: &Url, seats: &HashSet<String>) -> bool {
    matches!(url.scheme(), "http" | "https")
        && is_seat_desktop(url)
        && (same_origin(url, gateway) || seats.contains(&origin_key(url)))
}

/**
 * 暗号认不认：路径是 OPEN_PATH，**并且**导航发生在界面自己的源或 Gateway 的源上。
 *
 * 链接脚本只注入主框架，它拼出来的暗号总在界面的源上。以前只看路径，框里那页（席位的
 * noVNC）或者随便哪个被诱导打开的站外页，导航到 `https://随便哪/__satuwork_open?u=…`
 * 就能让系统浏览器替它打开任意地址。
 */
fn open_path_allowed(url: &Url, gateway: &Url) -> bool {
    url.path() == OPEN_PATH && (is_ui_origin(url) || same_origin(url, gateway))
}

/**
 * 界面挂内嵌桌面之前调一次：把这块屏的源记进放行名单（seat_desktop_allowed）。
 * 只收 http(s) 的 `/seats/<席位>/vnc…` 地址，别的一律拒——名单只该装席位机器。
 */
#[tauri::command]
pub(crate) fn allow_seat_desktop(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| format!("桌面地址解析不了：{e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || !is_seat_desktop(&parsed) {
        return Err("不是席位桌面地址".into());
    }
    let state = app.state::<SeatOrigins>();
    let mut seats = state.0.lock().map_err(|_| "放行名单锁坏了".to_string())?;
    seats.insert(origin_key(&parsed));
    Ok(())
}

/**
 * 暗号里带的那个地址该不该交给系统。暗号是页面递过来的，页面上的内容不全是我们写的
 * （markdown 里的链接来自模型和用户），只认 hand_to_system 那几种，别的协议（javascript: 这些）
 * 一律当没发生。markdown 渲染的链接都带 `target="_blank"`，邮箱、电话链接走的正是这条路。
 */
fn open_target(raw: &str) -> Option<Url> {
    let parsed = Url::parse(raw).ok()?;
    hand_to_system(&parsed).then_some(parsed)
}

/** 暗号里带的那个地址：交给系统（浏览器，或者邮件、电话、短信应用）。 */
fn route_open(app: &AppHandle, base: &Url, url: &Url) {
    let target = url
        .query_pairs()
        .find(|(k, _)| k == "u")
        .map(|(_, v)| v.to_string())
        .unwrap_or_default();
    let Some(parsed) = open_target(&target) else {
        return;
    };
    // 界面不再在 Gateway 的源上，「另开一扇应用窗口装 Gateway 页面」这条路没有了：
    // 同源与否都交给系统浏览器。`base` 留着是给将来「同源另开窗」用的判据。
    let _ = same_origin(&parsed, base);
    let _ = app.opener().open_url(parsed.as_str(), None::<&str>);
}

/**
 * 装界面的窗口都从这儿出：同一套导航守卫，同一段链接脚本（连同注入的 Gateway 地址）。
 *
 * 只从 setup 钩子、async 命令或别的线程上调：Windows 上 build() 放在同步命令、事件回调里
 * 会死锁（WebView2 的已知问题）。open_setup 同理。
 */
pub(crate) fn build_window(
    app: &AppHandle,
    label: &str,
    gateway: Url,
    title: &str,
) -> tauri::Result<()> {
    let handle = app.clone();
    let base = gateway.clone();
    // 装的是包里那份界面（satu://localhost/），不是 Gateway 的页面；Gateway 地址注入给它。
    let ui = Url::parse(UI_ORIGIN).expect("UI_ORIGIN 是常量");
    // 两个占位符都替换成 JSON 字符串字面量（带引号），而不是裸拼进单引号里：地址里一个
    // 引号或反斜杠就能从字面量里逃出来，往注入脚本里塞任意 JS。
    let script = LINK_SCRIPT
        .replace(
            "__OPEN_PATH__",
            &serde_json::to_string(OPEN_PATH).expect("常量字符串总能编成 JSON"),
        )
        .replace(
            "__GATEWAY_URL__",
            &serde_json::to_string(gateway.as_str().trim_end_matches('/'))
                .expect("字符串总能编成 JSON"),
        );
    WebviewWindowBuilder::new(app, label, WebviewUrl::CustomProtocol(ui))
        .title(title)
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 600.0)
        .initialization_script(&script)
        .on_navigation(move |url| allow_navigation(&handle, &base, url))
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{hand_to_system, is_seat_desktop, open_path_allowed, open_target, origin_key, seat_desktop_allowed};
    use std::collections::HashSet;
    use tauri::Url;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    /// 外链暗号只在界面源和 Gateway 源上认（见 open_path_allowed）。
    #[test]
    fn open_path_only_from_ui_or_gateway_origin() {
        let gw = u("https://gw.example.com/");
        let yes = [
            "satu://localhost/__satuwork_open?u=https%3A%2F%2Fa.com",
            "http://satu.localhost/__satuwork_open?u=https%3A%2F%2Fa.com",
            "https://gw.example.com/__satuwork_open?u=https%3A%2F%2Fa.com",
        ];
        for s in yes {
            assert!(open_path_allowed(&u(s), &gw), "该认：{s}");
        }
        let no = [
            "https://evil.com/__satuwork_open?u=https%3A%2F%2Fphish",
            "https://m001.example.com/__satuwork_open?u=https%3A%2F%2Fphish",
            // 端口、scheme 不同都不算 Gateway 的源
            "http://gw.example.com/__satuwork_open?u=x",
            "https://gw.example.com:8443/__satuwork_open?u=x",
            "https://gw.example.com.evil.com/__satuwork_open?u=x",
            // 界面源上别的路径不是暗号
            "satu://localhost/index.html?u=x",
        ];
        for s in no {
            assert!(!open_path_allowed(&u(s), &gw), "不该认：{s}");
        }
    }

    /// 邮箱、电话、短信和站外网页交给系统；页面内部用的协议留在 WebView 里（见 hand_to_system）。
    #[test]
    fn mail_phone_and_web_go_to_the_system() {
        for s in ["https://a.com/p", "http://a.com", "mailto:a@b.com", "tel:+6512345678", "sms:+6512345678"] {
            assert!(hand_to_system(&u(s)), "{s}");
        }
        for s in [
            "blob:satu://localhost/abc",
            "data:text/plain,hi",
            "about:blank",
            "javascript:alert(1)",
            "ws://gw.example.com/x",
            "satu://localhost/a",
        ] {
            assert!(!hand_to_system(&u(s)), "{s}");
        }
        // target="_blank" 走暗号那条路，同一套规则。
        assert_eq!(open_target("mailto:a@b.com?subject=hi").unwrap().as_str(), "mailto:a@b.com?subject=hi");
        assert_eq!(open_target("tel:+6512345678").unwrap().as_str(), "tel:+6512345678");
        assert_eq!(open_target("https://a.com/p").unwrap().as_str(), "https://a.com/p");
        assert!(open_target("javascript:alert(1)").is_none());
        assert!(open_target("satu://localhost/d/bot-1").is_none());
        assert!(open_target("not a url").is_none());
    }

    /// 内嵌桌面只放行 Gateway 源和界面报过的机器源（见 seat_desktop_allowed）。
    #[test]
    fn seat_desktop_only_on_known_origins() {
        let gw = u("https://gw.example.com/");
        let mut seats = HashSet::new();
        seats.insert(origin_key(&u("https://m001.example.com/seats/sw-a/vnc/")));
        seats.insert(origin_key(&u("http://192.168.64.1:8443/seats/sw-a/vnc/")));
        let yes = [
            "https://m001.example.com/seats/sw-abc/vnc/",
            "https://m001.example.com/seats/sw-abc/vnc/vnc.html?path=x",
            "http://192.168.64.1:8443/seats/sw-abc/vnc/",
            "https://gw.example.com/seats/sw-abc/vnc/",
        ];
        for s in yes {
            assert!(seat_desktop_allowed(&u(s), &gw, &seats), "该放行：{s}");
        }
        let no = [
            "http://evil.com/seats/x/vnc/",
            // 同主机换 scheme / 端口不算报过的源
            "http://m001.example.com/seats/sw-abc/vnc/",
            "https://m001.example.com:8443/seats/sw-abc/vnc/",
            "http://192.168.64.1/seats/sw-abc/vnc/",
            // 源对了路径不对
            "https://m001.example.com/other",
        ];
        for s in no {
            assert!(!seat_desktop_allowed(&u(s), &gw, &seats), "不该放行：{s}");
        }
        assert!(!seat_desktop_allowed(&u("https://m001.example.com/seats/a/vnc/"), &gw, &HashSet::new()));
    }

    /// 内嵌桌面那块 iframe 不能被导航守卫送去系统浏览器（见 is_seat_desktop）。
    #[test]
    fn seat_desktop_navigation_stays_in_the_window() {
        let yes = [
            "https://m001.example.com/seats/sw-abc-def/vnc/",
            "https://m001.example.com/seats/sw-abc-def/vnc/?ticket=x",
            // 管家那一跳
            "https://m001.example.com/seats/sw-abc-def/vnc/vnc.html?path=x&autoconnect=1",
            // 本地开发的 http 直连
            "http://192.168.64.1:8443/seats/sw-abc-def/vnc/",
        ];
        for u in yes {
            assert!(is_seat_desktop(&Url::parse(u).unwrap()), "该放行：{u}");
        }
        let no = [
            "https://example.com/",
            "https://example.com/seats/",
            "https://example.com/seats/sw-abc-def",
            // 对话流和名单流是 fetch，不走导航；真走到这儿也不该当桌面放行
            "https://m001.example.com/seats/sw-abc-def/stream/sessions/s-1/events",
            "https://m001.example.com/roster/stream",
            // 空席位段
            "https://m001.example.com/seats//vnc/",
        ];
        for u in no {
            assert!(!is_seat_desktop(&Url::parse(u).unwrap()), "不该放行：{u}");
        }
    }
}
