//! 这台电脑的设备身份（docs/local-bot-device.md §2）：本地 Bot 只属于建它的那台电脑。
//!
//! id 存在 `app_data_dir/device.json`，和本地 Bot 的数据（`local-bots/<id>`）在同一个根目录下：
//! 数据目录没了，这台电脑上的本地 Bot 也跑不回来了，身份跟着换掉是对的。**不放 WebView 的
//! localStorage**——那份可能被单独清掉，而 Bot 的数据还在，用户会看着自己的本地 Bot 凭空消失。

use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceFile {
    id: String,
    created_at: u64,
}

/// 注入给页面的那一份：`window.__SATUWORK_DESKTOP_DEVICE__`。
#[derive(Serialize)]
pub(crate) struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub platform: &'static str,
}

/// 和 Gateway 那头（lib/guards.ts 的 DEVICE_ID）同一个格式。
fn valid_id(id: &str) -> bool {
    (16..=100).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/**
 * 新的 id：32 位十六进制。壳子没带随机数的 crate，拿纳秒时间、进程号、栈地址和数据目录
 * 拼起来过一遍 sha256——要的只是「两台电脑撞不上」，不是密码学意义上的随机。
 */
fn new_id(dir: &Path) -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let marker = 0u8;
    let mut h = Sha256::new();
    h.update(nanos.to_le_bytes());
    h.update(std::process::id().to_le_bytes());
    h.update((&marker as *const u8 as usize).to_le_bytes());
    h.update(dir.to_string_lossy().as_bytes());
    h.update(host_name().as_bytes());
    h.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// 这个进程里的设备身份只定一次：每开一扇窗都要注入它，写盘失败时不能每扇窗各生成一个。
static DEVICE_ID: OnceLock<String> = OnceLock::new();

/**
 * 读 device.json；读不到、解析不了、格式不对就生成一个新的写回去。写不进去（磁盘满、
 * 没权限）也照样返回这次生成的——这一次启动里本地 Bot 还能用，只是下次启动会换一个身份。
 */
pub(crate) fn device_id(app: &AppHandle) -> Result<String, String> {
    if let Some(id) = DEVICE_ID.get() {
        return Ok(id.clone());
    }
    let id = load_or_create(app)?;
    Ok(DEVICE_ID.get_or_init(|| id).clone())
}

fn load_or_create(app: &AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("device.json");
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(file) = serde_json::from_str::<DeviceFile>(&raw) {
            if valid_id(&file.id) {
                return Ok(file.id);
            }
        }
    }
    let id = new_id(&dir);
    let file = DeviceFile { id: id.clone(), created_at: now_ms() };
    let body = serde_json::to_string(&file).map_err(|e| e.to_string())?;
    if let Err(e) = fs::create_dir_all(&dir).and_then(|_| fs::write(&path, body)) {
        eprintln!("satuwork-desktop: 写 device.json 失败：{e}");
    }
    Ok(id)
}

/// 主机名：只用于界面上「在哪台电脑上」那一行，不参与任何判断。取不到就是空串。
fn host_name() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: buf 够长，gethostname 最多写 buf.len() 字节；结果按 NUL 截断。
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if rc == 0 {
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            let name = String::from_utf8_lossy(&buf[..end]).trim().to_string();
            // macOS 上常见的 `xxx.local` 后缀对人没有意义。
            return name.strip_suffix(".local").unwrap_or(&name).to_string();
        }
        String::new()
    }
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

pub(crate) fn device_info(app: &AppHandle) -> Option<DeviceInfo> {
    match device_id(app) {
        Ok(id) => Some(DeviceInfo { id, name: host_name(), platform: platform() }),
        Err(e) => {
            eprintln!("satuwork-desktop: 拿不到设备身份：{e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_ids_match_gateway_format_and_differ() {
        let dir = Path::new("/tmp/satu-device-test");
        let a = new_id(dir);
        let b = new_id(dir);
        assert!(valid_id(&a), "{a}");
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }

    #[test]
    fn rejects_malformed_ids() {
        assert!(!valid_id("short"));
        assert!(!valid_id("has space in it 1234567"));
        assert!(!valid_id("quote'\"injection-123456"));
        assert!(valid_id("0123456789abcdef"));
    }
}
