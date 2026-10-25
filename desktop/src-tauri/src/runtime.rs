//! 本地 Bot 运行时：版本目录和 CURRENT / PENDING 指针；解包见 unpack，联网更新见 update。

mod unpack;
mod update;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

pub(crate) use update::{bot_runtime, ensure_bundled_runtime, promote_pending_runtime, runtime_update_error, stage_runtime_update};

pub(crate) fn runtime_home(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .map(|dir| dir.join("local-runtime"))
}

fn safe_runtime_version(raw: &str) -> Result<String, String> {
    let version = raw.trim();
    if version.is_empty()
        || version.len() > 96
        || version.starts_with('.')
        || !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
    {
        return Err("本地运行时版本号不合法".into());
    }
    Ok(version.to_string())
}

pub(crate) fn read_runtime_pointer(home: &Path, name: &str) -> Option<String> {
    let value = fs::read_to_string(home.join(name)).ok()?;
    let version = safe_runtime_version(&value).ok()?;
    let entry = home
        .join("releases")
        .join(&version)
        .join("bot/bin/satuwork.mjs");
    entry.is_file().then_some(version)
}

pub(crate) fn write_runtime_pointer(home: &Path, name: &str, version: &str) -> Result<(), String> {
    let version = safe_runtime_version(version)?;
    fs::create_dir_all(home).map_err(|e| format!("创建本地运行时目录失败：{e}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let next = home.join(format!(".{name}.{nonce}.next"));
    fs::write(&next, format!("{version}\n")).map_err(|e| format!("写本地运行时指针失败：{e}"))?;
    let target = home.join(name);
    if let Err(first) = fs::rename(&next, &target) {
        // Windows 不允许 rename 覆盖已有文件。指针只有一行，删旧值后的窗口也很短；
        // 即便机器这时断电，下一次仍会回退到安装包内置版本。
        if target.exists() {
            fs::remove_file(&target).map_err(|e| format!("替换本地运行时指针失败：{e}"))?;
            fs::rename(&next, &target).map_err(|e| format!("替换本地运行时指针失败：{e}"))?;
        } else {
            let _ = fs::remove_file(&next);
            return Err(format!("替换本地运行时指针失败：{first}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::safe_runtime_version;

    #[test]
    fn runtime_version_cannot_escape_release_directory() {
        assert!(safe_runtime_version("0.1.0+abc-darwin-arm64").is_ok());
        assert!(safe_runtime_version("../CURRENT").is_err());
        assert!(safe_runtime_version("a/b").is_err());
        assert!(safe_runtime_version(".hidden").is_err());
    }
}
