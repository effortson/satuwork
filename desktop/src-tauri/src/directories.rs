//! 批准给本地 Bot 访问的文件夹：清单（approved-dirs.json）加工作区 `External/` 下的入口链接。

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::local_bot::{bot_paths, safe_bot_id};
use crate::{ApprovedDirectory, LocalBots};

#[tauri::command]
pub(crate) async fn approve_local_directory(
    app: AppHandle,
    bot_id: String,
) -> Result<Option<ApprovedDirectory>, String> {
    let id = safe_bot_id(&bot_id)?;
    let running = {
        let state = app.state::<LocalBots>();
        let mut bots = state.0.lock().map_err(|_| "本地 Bot 状态锁损坏")?;
        match bots.get_mut(&id) {
            Some(proc_) => proc_.child.try_wait().map_err(|e| e.to_string())?.is_none(),
            None => false,
        }
    };
    if !running {
        return Err("这颗本地 Bot 尚未运行，不能批准目录".into());
    }
    let picker = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .set_title("批准本地 Bot 访问文件夹")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let target = selected
        .into_path()
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| format!("读取所选目录失败：{e}"))?;
    if !target.is_dir() {
        return Err("选择的不是文件夹".into());
    }
    let (data, work) = bot_paths(&app, &id)?;
    if target == work || target.starts_with(&work) {
        return Err("这个目录已经在 Bot 的默认工作区内，不需要额外批准".into());
    }

    let manifest = data.join("approved-dirs.json");
    let mut approved = read_approved(&manifest);
    let shown = target.display().to_string();
    if !approved.iter().any(|path| path == &shown) {
        approved.push(shown.clone());
        fs::write(
            &manifest,
            serde_json::to_vec_pretty(&approved).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("保存目录批准记录失败：{e}"))?;
    }

    let external = work.join("External");
    fs::create_dir_all(&external).map_err(|e| format!("创建外部目录入口失败：{e}"))?;
    let base = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Folder")
        .chars()
        .filter(|c| !c.is_control() && *c != '/' && *c != '\\')
        .take(64)
        .collect::<String>();
    let base = if base.trim().is_empty() {
        "Folder".to_string()
    } else {
        base
    };
    let mut link = external.join(&base);
    for index in 2..1000 {
        if !link.exists() && fs::symlink_metadata(&link).is_err() {
            break;
        }
        if link.canonicalize().ok().as_ref() == Some(&target) {
            return Ok(Some(ApprovedDirectory {
                path: shown,
                mount: format!("External/{}", link.file_name().unwrap().to_string_lossy()),
            }));
        }
        link = external.join(format!("{base}-{index}"));
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).map_err(|e| format!("创建批准目录入口失败：{e}"))?;
    // Windows 普通用户建不了符号链接（1314），退回 junction——同样是「指向那个目录的一个入口」，
    // list_approved / revoke_approved 认它（std 把 junction 也算 is_symlink，remove_dir 只拆入口）。
    // 两次都失败时两个原因都报：只报后一个的话，「入口已经存在」这类真原因就被盖掉了。
    #[cfg(windows)]
    if let Err(symlink_err) = std::os::windows::fs::symlink_dir(&target, &link) {
        junction::create(&target, &link).map_err(|junction_err| {
            format!("创建批准目录入口失败：符号链接 {symlink_err}；junction {junction_err}")
        })?;
    }
    Ok(Some(ApprovedDirectory {
        path: shown,
        mount: format!("External/{}", link.file_name().unwrap().to_string_lossy()),
    }))
}

/**
 * 批准过的文件夹：清单（approved-dirs.json）和工作区 `External/` 下的符号链接**两头都对上**
 * 才算——和 bot 那边 workspace.approvedMounts 同一条判据。只剩一头的（撤销到一半、手工删过
 * 链接）不列：列出来人会以为 Bot 还能访问，而 bot 那边已经不认了。
 */
fn list_approved(manifest: &Path, work: &Path) -> Vec<ApprovedDirectory> {
    let approved = read_approved(manifest);
    let mut out = Vec::new();
    for link in external_links(work) {
        let Ok(target) = link.canonicalize() else {
            continue;
        };
        let shown = target.display().to_string();
        if approved.iter().any(|p| p == &shown) {
            out.push(ApprovedDirectory {
                path: shown,
                mount: format!("External/{}", link.file_name().unwrap_or_default().to_string_lossy()),
            });
        }
    }
    out.sort_by(|a, b| a.mount.cmp(&b.mount));
    out
}

/**
 * 撤销一个批准：从清单里去掉，再拆掉 `External/` 下指向它的链接。
 *
 * **只拆链接，不碰文件夹本身**——`remove_file` 作用在符号链接上删的是链接；Windows 的目录
 * 链接要用 `remove_dir`，同样只删链接。先改清单再拆链接：拆到一半失败时，bot 那边按清单
 * 已经不认了（isApprovedPath），剩下的链接只是一条进不去的死路。
 */
fn revoke_approved(manifest: &Path, work: &Path, path: &str) -> Result<bool, String> {
    let mut approved = read_approved(manifest);
    let before = approved.len();
    approved.retain(|p| p != path);
    let changed = approved.len() != before;
    if changed {
        fs::write(
            manifest,
            serde_json::to_vec_pretty(&approved).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("保存目录批准记录失败：{e}"))?;
    }
    for link in external_links(work) {
        if link.canonicalize().ok().map(|t| t.display().to_string()).as_deref() != Some(path) {
            continue;
        }
        #[cfg(unix)]
        fs::remove_file(&link).map_err(|e| format!("拆除目录入口失败：{e}"))?;
        #[cfg(windows)]
        fs::remove_dir(&link).map_err(|e| format!("拆除目录入口失败：{e}"))?;
    }
    Ok(changed)
}

/// 清单里记着的那几条路径。文件不在、读不出、不是 JSON 数组都当空清单。
fn read_approved(manifest: &Path) -> Vec<String> {
    fs::read_to_string(manifest)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// 工作区 `External/` 底下的入口：只要符号链接（Windows 上的 junction std 也算 is_symlink），
/// 普通文件和目录不算。`External/` 不存在就是一个都没有。
fn external_links(work: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(work.join("External")) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|link| {
            fs::symlink_metadata(link)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
        })
        .collect()
}

/** 右栏那张「批准访问的文件夹」列表。 */
#[tauri::command]
pub(crate) fn local_directories(app: AppHandle, bot_id: String) -> Result<Vec<ApprovedDirectory>, String> {
    let id = safe_bot_id(&bot_id)?;
    let (data, work) = bot_paths(&app, &id)?;
    Ok(list_approved(&data.join("approved-dirs.json"), &work))
}

/**
 * 撤销一个批准。不用等 Bot 重启：bot 每次访问都现读清单（workspace.isApprovedPath），
 * 下一次读写就不认了；系统提示里的那张表下一轮也跟着变。
 */
#[tauri::command]
pub(crate) fn revoke_local_directory(app: AppHandle, bot_id: String, path: String) -> Result<bool, String> {
    let id = safe_bot_id(&bot_id)?;
    let (data, work) = bot_paths(&app, &id)?;
    revoke_approved(&data.join("approved-dirs.json"), &work, &path)
}

#[cfg(test)]
mod tests {
    use super::{list_approved, revoke_approved};

    #[test]
    fn approved_directories_list_and_revoke() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("satu-approved-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let work = base.join("work");
        let target = base.join("Downloads");
        let stray = base.join("NotApproved");
        fs::create_dir_all(work.join("External")).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&stray).unwrap();
        fs::write(target.join("keep.txt"), "别删我").unwrap();
        let target_real = target.canonicalize().unwrap().display().to_string();
        let manifest = base.join("approved-dirs.json");
        fs::write(&manifest, serde_json::to_vec(&vec![target_real.clone()]).unwrap()).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, work.join("External/Downloads")).unwrap();
            std::os::unix::fs::symlink(&stray, work.join("External/NotApproved")).unwrap();
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(&target, work.join("External/Downloads")).is_err() {
                junction::create(&target, work.join("External/Downloads")).unwrap();
            }
            if std::os::windows::fs::symlink_dir(&stray, work.join("External/NotApproved")).is_err() {
                junction::create(&stray, work.join("External/NotApproved")).unwrap();
            }
        }

        let listed = list_approved(&manifest, &work);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].mount, "External/Downloads");
        assert_eq!(listed[0].path, target_real);

        assert!(revoke_approved(&manifest, &work, &target_real).unwrap());
        assert!(list_approved(&manifest, &work).is_empty());
        assert!(fs::symlink_metadata(work.join("External/Downloads")).is_err(), "链接该拆掉");
        // 文件夹本身和里面的东西一个字节都不能动
        assert_eq!(fs::read_to_string(target.join("keep.txt")).unwrap(), "别删我");
        // 别人的链接不动
        assert!(fs::symlink_metadata(work.join("External/NotApproved")).is_ok());
        // 再撤一次：清单里已经没有，返回 false，不报错
        assert!(!revoke_approved(&manifest, &work, &target_real).unwrap());
        let _ = fs::remove_dir_all(&base);
    }
}
