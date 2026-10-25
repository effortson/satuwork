//! 运行时换版：内置版落地、PENDING 提升、联网检查并暂存新版。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Url};

use super::unpack::unpack_runtime;
use super::{read_runtime_pointer, runtime_home, safe_runtime_version, write_runtime_pointer};
use crate::server::same_origin;
use crate::LocalBotRelease;

pub(crate) fn ensure_bundled_runtime(app: &AppHandle) -> Result<Option<String>, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("runtime");
    let archive = resources.join("bot.tgz");
    if !archive.is_file() {
        return Ok(None);
    }
    let wanted = safe_runtime_version(
        fs::read_to_string(resources.join("VERSION"))
            .map_err(|e| format!("读取内置运行时版本失败：{e}"))?
            .as_str(),
    )?;
    let home = runtime_home(app)?;
    let destination = home.join("releases").join(&wanted);
    unpack_runtime(&archive, &destination)?;
    // 以前只在 CURRENT 不存在时才指向内置版：Desktop 升级之后新包里那份 Bot 永远用不上，
    // 比它还旧的远端版反倒一直占着 CURRENT。现在按版本号比，内置的更新就切过去。
    let switch = match read_runtime_pointer(&home, "CURRENT") {
        None => true,
        Some(current) if current == wanted => false,
        Some(current) => match runtime_older(&current, &wanted) {
            Some(older) => older,
            // 比不出来：CURRENT 读不出版本号，是老壳内置的那种（VERSION 只写了 sha256），
            // 刚装的这份不会比它旧，切；内置这份读不出而 CURRENT 读得出（老打包脚本打的包），
            // 不动。
            None => version_numbers(&current).is_none(),
        },
    };
    if switch {
        write_runtime_pointer(&home, "CURRENT", &wanted)?;
    }
    // 比内置版还旧的 PENDING 留着，下一次启动就会被提升成 CURRENT——等于降级，删掉。
    if let Some(pending) = read_runtime_pointer(&home, "PENDING") {
        if runtime_older(&pending, &wanted) == Some(true) {
            let _ = fs::remove_file(home.join("PENDING"));
        }
    }
    Ok(Some(wanted))
}

/**
 * `a` 是不是比 `b` 旧：只比 x.y.z（version_numbers），`+构建号`、`-平台-架构` 不参与。
 * 任一方读不出版本号时返回 None，由调用方决定怎么办。
 */
fn runtime_older(a: &str, b: &str) -> Option<bool> {
    Some(version_numbers(a)? < version_numbers(b)?)
}

pub(crate) fn promote_pending_runtime(app: &AppHandle) -> Result<Option<(String, String)>, String> {
    let home = runtime_home(app)?;
    let Some(pending) = read_runtime_pointer(&home, "PENDING") else {
        return Ok(None);
    };
    let previous = read_runtime_pointer(&home, "CURRENT").unwrap_or_default();
    // 只往前走：PENDING 比 CURRENT 还旧（例如 CURRENT 刚被切到更新的内置版）就丢掉。
    if runtime_older(&pending, &previous) == Some(true) {
        let _ = fs::remove_file(home.join("PENDING"));
        return Ok(None);
    }
    write_runtime_pointer(&home, "CURRENT", &pending)?;
    let _ = fs::remove_file(home.join("PENDING"));
    Ok(Some((previous, pending)))
}

pub(crate) fn bot_runtime(app: &AppHandle) -> Result<(PathBuf, PathBuf, Option<String>), String> {
    if let Ok(raw) = std::env::var("SATUWORK_BOT_ROOT") {
        let root = PathBuf::from(raw);
        let entry = root.join("bin/satuwork.mjs");
        if !entry.is_file() {
            return Err("SATUWORK_BOT_ROOT 里没有 bin/satuwork.mjs".into());
        }
        return Ok((root, entry, None));
    }

    // `npm run dev` 必须跟着仓库源码走，发布构建才使用可升级的版本目录。
    #[cfg(debug_assertions)]
    {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../bot");
        if source.join("bin/satuwork.mjs").is_file() {
            return Ok((
                source.clone(),
                source.join("bin/satuwork.mjs"),
                Some("development".into()),
            ));
        }
    }

    let bundled = ensure_bundled_runtime(app)?;
    let home = runtime_home(app)?;
    let version = read_runtime_pointer(&home, "CURRENT").or(bundled);
    if let Some(version) = version {
        let root = home.join("releases").join(&version).join("bot");
        let entry = root.join("bin/satuwork.mjs");
        if entry.is_file() {
            return Ok((root, entry, Some(version)));
        }
    }
    Err("Desktop 包里没有本地 Bot 运行时，请重新安装完整版本".into())
}

fn local_runtime_target() -> Result<(&'static str, &'static str), String> {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        "linux" => "linux",
        other => return Err(format!("暂不支持 {other} 的本地 Bot 更新")),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => return Err(format!("暂不支持 {other} 架构的本地 Bot 更新")),
    };
    Ok((platform, arch))
}

fn version_numbers(raw: &str) -> Option<[u64; 3]> {
    let core = raw
        .trim()
        .trim_start_matches('v')
        .split(['-', '+'])
        .next()?;
    let mut parts = core.split('.');
    let parsed = [
        parts.next()?.parse().ok()?,
        parts.next().unwrap_or("0").parse().ok()?,
        parts.next().unwrap_or("0").parse().ok()?,
    ];
    Some(parsed)
}

fn desktop_version_supports(have: &str, minimum: &str) -> bool {
    match (version_numbers(have), version_numbers(minimum)) {
        (Some(have), Some(minimum)) => have >= minimum,
        _ => false,
    }
}

pub(crate) fn runtime_update_error(app: &AppHandle, message: Option<&str>) {
    let Ok(home) = runtime_home(app) else {
        return;
    };
    let path = home.join("LAST_ERROR");
    match message {
        Some(message) => {
            let _ = fs::create_dir_all(&home);
            let _ = fs::write(path, message.chars().take(500).collect::<String>());
        }
        None => {
            let _ = fs::remove_file(path);
        }
    }
}

/// 本地运行时包的上限。manifest 声明的 size 和实际下载都按它卡。
const MAX_RUNTIME_BYTES: u64 = 256 * 1024 * 1024;

/**
 * 把一次下载响应落进 `archive`，边写边算 sha256，最后和 manifest 声明的 size / sha256 比对。
 * 不通过就返回错误，调用方负责删临时文件。
 */
fn save_verified(
    mut response: reqwest::blocking::Response,
    release: &LocalBotRelease,
    archive: &Path,
) -> Result<(), String> {
    if !response.status().is_success() {
        return Err(format!("下载本地运行时失败：HTTP {}", response.status()));
    }
    let mut file = fs::File::create(archive).map_err(|e| format!("创建更新临时文件失败：{e}"))?;
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|e| format!("下载本地运行时失败：{e}"))?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > release.size || size > MAX_RUNTIME_BYTES {
            return Err("下载的本地运行时超过声明大小".into());
        }
        hash.update(&buffer[..read]);
        file.write_all(&buffer[..read])
            .map_err(|e| format!("保存本地运行时失败：{e}"))?;
    }
    file.sync_all()
        .map_err(|e| format!("保存本地运行时失败：{e}"))?;
    if size != release.size {
        return Err("下载的本地运行时大小与声明不符".into());
    }
    let actual = format!("{:x}", hash.finalize());
    if actual != release.sha256.to_ascii_lowercase() {
        return Err("下载的本地运行时 SHA-256 校验失败".into());
    }
    Ok(())
}

/**
 * 直连外部地址（GitHub Release）取包。
 *
 * 和走 Gateway 那条的两处不同，都是刻意的：
 * - **不带任何 Gateway 凭据。** 这是个公开地址，席位票只给 Gateway 自己。
 * - **允许跳转，但只跳 https、最多 5 次。** GitHub 的 release 下载一定会 302 到
 *   objects.githubusercontent.com（带签名的临时地址），不跟就永远取不到。跳到哪儿都不影响
 *   完整性：字节最后要过 save_verified 的 size + sha256，而那两个值来自带票的 manifest。
 *   不许降到 http，是为了别把「这台机器在取哪个版本」明文发出去。
 */
fn download_direct(raw: &str, release: &LocalBotRelease, archive: &Path) -> Result<(), String> {
    let url = Url::parse(raw).map_err(|e| format!("直连下载地址不合法：{e}"))?;
    if url.scheme() != "https" {
        return Err("直连下载地址不是 https".into());
    }
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("直连下载跳转次数过多")
            } else if attempt.url().scheme() != "https" {
                attempt.error("直连下载跳到了非 https 地址")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| format!("创建直连下载请求失败：{e}"))?;
    let response = client
        .get(url.as_str())
        .send()
        .map_err(|e| format!("直连下载本地运行时失败：{e}"))?;
    save_verified(response, release, archive).map_err(|e| format!("直连下载：{e}"))
}

/**
 * 下载并暂存适合本机的最新版。任何失败都只记状态，不阻止旧 Bot 启动。
 *
 * 一次只允许一路跑：每小时的更新线程（不持任何锁）和 start_local_bot（持 STARTING，不持 LocalBots）
 * 都会调它，而 unpack_runtime 对已存在的目标目录是先 remove_dir_all 再解。两路交错的话，
 * 一路刚解好、正要写 PENDING 的目录会被另一路当作损坏删掉。锁是这个函数自己的，
 * 不跟 LocalBots 扯上关系（锁序永远是 STARTING → STAGING），不会构成锁序问题。
 */
pub(crate) fn stage_runtime_update(
    app: &AppHandle,
    gateway: &Url,
    access_token: &str,
) -> Result<Option<String>, String> {
    if cfg!(debug_assertions) || std::env::var_os("SATUWORK_BOT_ROOT").is_some() {
        return Ok(None);
    }
    static STAGING: Mutex<()> = Mutex::new(());
    // 上一路带着锁 panic 了也照常往下走：锁保护的是文件系统，不是内存里的什么。
    let _staging = STAGING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = ensure_bundled_runtime(app)?;
    let home = runtime_home(app)?;
    let current = read_runtime_pointer(&home, "CURRENT").unwrap_or_default();
    let (platform, arch) = local_runtime_target()?;
    let desktop_version = app.package_info().version.to_string();
    let mut endpoint = gateway
        .join("/runtime/local-bot-release")
        .map_err(|e| format!("生成更新检查地址失败：{e}"))?;
    // 带上壳的版本：每个包登记了自己要的最低 Desktop 版本，Gateway 据此给这台装得了的最新一版。
    endpoint
        .query_pairs_mut()
        .append_pair("platform", platform)
        .append_pair("arch", arch)
        .append_pair("have", &current)
        .append_pair("desktop", &desktop_version);
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .redirect(Policy::none())
        .build()
        .map_err(|e| format!("创建更新请求失败：{e}"))?;
    let response = client
        .get(endpoint.as_str())
        .bearer_auth(access_token)
        .send()
        .map_err(|e| format!("检查本地运行时更新失败：{e}"))?;
    if response.status().as_u16() == 204 {
        runtime_update_error(app, None);
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "检查本地运行时更新失败：HTTP {}",
            response.status()
        ));
    }
    let release: LocalBotRelease = response
        .json()
        .map_err(|e| format!("读取本地运行时更新信息失败：{e}"))?;
    if !desktop_version_supports(&desktop_version, &release.min_desktop_version) {
        return Err(format!(
            "本地 Bot 新版本需要 Satuwork Desktop {} 或更高版本；当前是 {}，请先升级 Desktop",
            release.min_desktop_version, desktop_version
        ));
    }
    let version = safe_runtime_version(&release.version)?;
    let expected_suffix = format!("-{platform}-{arch}");
    if !version.ends_with(&expected_suffix) {
        return Err("服务器返回了不适合本机的运行时".into());
    }
    // Gateway 只看「和 have 不一样」，会把比本机还旧的版本发下来（例如 Desktop 升级后内置的
    // Bot 比 Gateway 上登记的都新）。不降级：这种情况等同于没有更新。同号不同构建的照样收。
    if runtime_older(&version, &current) == Some(true) {
        runtime_update_error(app, None);
        return Ok(None);
    }
    if release.sha256.len() != 64 || !release.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("服务器返回的运行时校验值不合法".into());
    }
    if release.size == 0 || release.size > MAX_RUNTIME_BYTES {
        return Err("服务器返回的运行时大小不合法".into());
    }
    let archive = home.join(format!(".{version}.download"));
    let result: Result<(), String> = (|| {
        // 先走直连（GitHub Release），失败了再退回 Gateway 转发。两条路落到同一个临时文件、
        // 过同一套 size + sha256 比对——sha256 来自上面那次带席位票的 manifest 请求，直连这条路
        // 本身不需要可信。
        let mut direct_error = None;
        let fetched = match release.direct_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(raw) => match download_direct(raw, &release, &archive) {
                Ok(()) => true,
                Err(error) => {
                    direct_error = Some(error);
                    false
                }
            },
            None => false,
        };
        if !fetched {
            let via_gateway = (|| {
                let download_url =
                    Url::parse(&release.url).map_err(|e| format!("更新地址不合法：{e}"))?;
                if !same_origin(gateway, &download_url) {
                    return Err("本地运行时下载地址与 Gateway 不同源".to_string());
                }
                // 这一条带席位票，所以沿用 Policy::none()：Gateway 的转发不该跳到别处，
                // 真跳了宁可失败，也不把票带去一个没核过的地址。
                let response = client
                    .get(download_url.as_str())
                    .bearer_auth(access_token)
                    .send()
                    .map_err(|e| format!("下载本地运行时失败：{e}"))?;
                save_verified(response, &release, &archive)
            })();
            if let Err(error) = via_gateway {
                return Err(match direct_error {
                    Some(direct) => format!("{direct}；改走 Gateway 转发也失败：{error}"),
                    None => error,
                });
            }
        }
        let destination = home.join("releases").join(&version);
        unpack_runtime(&archive, &destination)?;
        write_runtime_pointer(&home, "PENDING", &version)?;
        Ok(())
    })();
    let _ = fs::remove_file(&archive);
    result?;
    runtime_update_error(app, None);
    let _ = (
        &release.min_desktop_version,
        release.mandatory,
        &release.note,
    );
    Ok(Some(version))
}

#[cfg(test)]
mod tests {
    use super::{desktop_version_supports, runtime_older};

    #[test]
    fn runtime_versions_compare_on_numbers_only() {
        assert_eq!(runtime_older("0.1.13+abc1234-darwin-arm64", "0.1.14+0123456789abcdef"), Some(true));
        assert_eq!(runtime_older("0.1.14+abc1234-darwin-arm64", "0.1.14+0123456789abcdef"), Some(false));
        assert_eq!(runtime_older("0.2.0+abc1234-darwin-arm64", "0.1.14+0123456789abcdef"), Some(false));
        // 老壳内置版的 VERSION 只是 sha256，读不出版本号
        let sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(runtime_older(sha, "0.1.14+0123456789abcdef"), None);
    }

    #[test]
    fn desktop_minimum_version_is_compared_numerically() {
        assert!(desktop_version_supports("0.10.0", "0.2.9"));
        assert!(desktop_version_supports("1.0.0", "1.0.0"));
        assert!(!desktop_version_supports("0.1.9", "0.2.0"));
        assert!(!desktop_version_supports("broken", "0.2.0"));
    }
}
