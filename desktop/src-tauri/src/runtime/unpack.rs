//! 运行时包落地：Windows 上自己建链接（junction / 硬链接），解在临时目录里再整体 rename。

use std::collections::HashMap;
use std::fs;
#[cfg(windows)]
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/**
 * 运行时包里一条符号链接落地之后指到哪儿（相对包根的路径），或者指到包外。
 *
 * 只有 Windows 用得上（见 unpack_links_windows）：那边普通用户建不了符号链接（错误 1314），要
 * 自己把每条链接落成 junction / 硬链接，而 junction 和硬链接都得知道「真正指着的那个东西」。
 * 解析本身是纯路径运算，放在外面好让每个平台的单测都跑得到。
 */
#[cfg_attr(not(windows), allow(dead_code))] // 只有 Windows 的解包用它；别的平台只剩单测在跑
#[derive(Debug, Clone, PartialEq, Eq)]
enum LinkDest {
    Inside(PathBuf),
    /// 构建机上 workspace 包那种 `../../../../bot`：在这台电脑上本来就不存在，跳过不建。
    Outside,
}

/// 包里一条条目的路径：只留普通段，`.` 丢掉；`..`、绝对路径、盘符一律不认——和 tar 的
/// `unpack_in` 挡的是同一类东西，链接不经过它，得自己挡。
#[cfg_attr(not(windows), allow(dead_code))] // 只有 Windows 的解包用它；别的平台只剩单测在跑
fn safe_entry_path(raw: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in raw.components() {
        match c {
            std::path::Component::Normal(s) => out.push(s),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// 链接目标换算成包内路径。目标是相对链接所在目录写的；绝对路径、`..` 退出包根的算 Outside。
#[cfg_attr(not(windows), allow(dead_code))] // 只有 Windows 的解包用它；别的平台只剩单测在跑
fn link_target_in_root(link: &Path, target: &Path) -> LinkDest {
    let mut out: Vec<std::ffi::OsString> = link
        .parent()
        .map(|p| p.iter().map(|s| s.to_owned()).collect())
        .unwrap_or_default();
    for c in target.components() {
        match c {
            std::path::Component::Normal(s) => out.push(s.to_owned()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if out.pop().is_none() {
                    return LinkDest::Outside;
                }
            }
            _ => return LinkDest::Outside,
        }
    }
    LinkDest::Inside(out.iter().collect())
}

/**
 * 把一条包内路径上经过的链接一层层换成它们指的地方，直到落在真实路径上。
 *
 * **不看链接在包里的先后。** `a -> b`、`b -> c` 这种链，按包里的顺序一条条建的话，建 `a` 的
 * 时候 `b` 还不存在，既判不出它是目录还是文件，junction 也没东西可指。先在内存里把整条链
 * 走完，拿到的就是一个不含任何链接的真实路径。走到包外算 Outside；兜圈子报错。
 */
#[cfg_attr(not(windows), allow(dead_code))] // 只有 Windows 的解包用它；别的平台只剩单测在跑
fn resolve_through_links(path: &Path, links: &HashMap<PathBuf, LinkDest>) -> Result<LinkDest, String> {
    let mut cur = path.to_path_buf();
    for _ in 0..64 {
        let parts: Vec<_> = cur.iter().collect();
        let mut prefix = PathBuf::new();
        let mut hit = None;
        for (i, part) in parts.iter().enumerate() {
            prefix.push(part);
            if let Some(dest) = links.get(&prefix) {
                hit = Some((i, dest));
                break;
            }
        }
        let Some((i, dest)) = hit else {
            return Ok(LinkDest::Inside(cur));
        };
        let LinkDest::Inside(base) = dest else {
            return Ok(LinkDest::Outside);
        };
        let mut next = base.clone();
        for part in &parts[i + 1..] {
            next.push(part);
        }
        cur = next;
    }
    Err(format!("运行时包里的链接成环：{}", path.display()))
}

/// 一条要落地的链接：`location` 是它在包里的位置（已经绕开了路上的链接），`target` 是包里写的
/// 原样目标（建真符号链接时用），`dest` 是解析到底的真实路径。
#[cfg_attr(not(windows), allow(dead_code))] // 只有 Windows 的解包用它；别的平台只剩单测在跑
#[derive(Debug)]
struct LinkPlan {
    location: PathBuf,
    target: PathBuf,
    dest: LinkDest,
}

#[cfg_attr(not(windows), allow(dead_code))] // 只有 Windows 的解包用它；别的平台只剩单测在跑
fn plan_links(raw: Vec<(PathBuf, PathBuf)>) -> Result<Vec<LinkPlan>, String> {
    let mut links = HashMap::new();
    let mut list = Vec::new();
    for (path, target) in raw {
        let link = safe_entry_path(&path)
            .ok_or_else(|| format!("运行时包里的链接路径不合法：{}", path.display()))?;
        let dest = link_target_in_root(&link, &target);
        links.insert(link.clone(), dest);
        list.push((link, target));
    }
    let mut plans = Vec::new();
    for (link, target) in list {
        let first = links.get(&link).cloned().unwrap_or(LinkDest::Outside);
        let dest = match first {
            LinkDest::Inside(p) => resolve_through_links(&p, &links)?,
            LinkDest::Outside => LinkDest::Outside,
        };
        // 链接本身所在的目录也可能经过别的链接（pnpm 不这么打，但包是外面来的）。
        let location = match link.parent().filter(|p| !p.as_os_str().is_empty()) {
            None => link.clone(),
            Some(parent) => match resolve_through_links(parent, &links)? {
                LinkDest::Inside(p) => p.join(link.file_name().unwrap_or_default()),
                LinkDest::Outside => continue,
            },
        };
        plans.push(LinkPlan { location, target, dest });
    }
    Ok(plans)
}

/**
 * Windows 上解包：普通条目照常交给 tar（`unpack_in` 挡 `..` 和绝对路径），符号链接先记下，
 * 等文件都落地了再按 plan_links 的结果一条条建，**全在临时目录里完成**，之后才整体 rename——
 * 装到一半断掉的话留下的只是临时目录，不会有一个「有 bin/satuwork.mjs、缺依赖链接」的版本
 * 目录被 unpack_runtime / read_runtime_pointer 当成完整的。
 *
 * 为什么不直接 `Archive::unpack`：它建链接用 `CreateSymbolicLinkW`，普通用户没开开发者模式
 * 就是 1314，整个运行时装不上。
 */
#[cfg(windows)]
fn unpack_links_windows<R: Read>(archive: &mut tar::Archive<R>, bot: &Path, final_bot: &Path) -> Result<(), String> {
    let mut links = Vec::new();
    for entry in archive.entries().map_err(|e| format!("读取本地运行时条目失败：{e}"))? {
        let mut entry = entry.map_err(|e| format!("解开本地运行时条目失败：{e}"))?;
        if entry.header().entry_type() == tar::EntryType::Symlink {
            let path = entry.path().map_err(|e| format!("读取链接路径失败：{e}"))?.into_owned();
            let target = entry
                .link_name()
                .map_err(|e| format!("读取链接目标失败：{e}"))?
                .ok_or_else(|| format!("链接 {} 没有目标", path.display()))?
                .into_owned();
            links.push((path, target));
            continue;
        }
        entry.unpack_in(bot).map_err(|e| format!("解开本地运行时失败：{e}"))?;
    }
    materialize_links(bot, final_bot, &plan_links(links)?, true)
}

/**
 * 把链接建在 `bot`（临时目录）里。`final_bot` 是 rename 之后它们所在的位置：junction 只认
 * 绝对路径，指向临时目录的话一 rename 就断了，所以直接指 rename 之后的地方（junction 不要求
 * 目标此刻存在）。硬链接跟着文件走，rename 不影响。
 *
 * 顺序：先试真符号链接（开了开发者模式或管理员时能成，保持相对路径；目标里的 `/` 换成 `\`，
 * 标准库原样写进去，Windows 解析相对目标不认 `/`），不行目录用 junction、文件用硬链接，
 * 硬链接也不行再拷文件。目录不再退回整树拷贝：pnpm 的依赖图里有环，跟着链接拷会没完没了。
 */
#[cfg(windows)]
fn materialize_links(bot: &Path, final_bot: &Path, plans: &[LinkPlan], try_symlink: bool) -> Result<(), String> {
    for plan in plans {
        let LinkDest::Inside(real) = &plan.dest else { continue };
        let link_path = bot.join(&plan.location);
        let real_now = bot.join(real);
        let meta = fs::metadata(&real_now).map_err(|e| {
            format!("运行时包里的链接 {} 指向的 {} 不存在：{e}", plan.location.display(), real.display())
        })?;
        if let Some(parent) = link_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建链接父目录失败：{e}"))?;
        }
        if try_symlink {
            let rel = PathBuf::from(plan.target.to_string_lossy().replace('/', "\\"));
            let made = if meta.is_dir() {
                std::os::windows::fs::symlink_dir(&rel, &link_path)
            } else {
                std::os::windows::fs::symlink_file(&rel, &link_path)
            };
            if made.is_ok() {
                continue;
            }
        }
        if meta.is_dir() {
            junction::create(final_bot.join(real), &link_path).map_err(|e| {
                format!("创建目录链接失败 {} -> {}：{e}", plan.location.display(), real.display())
            })?;
        } else if fs::hard_link(&real_now, &link_path).is_err() {
            fs::copy(&real_now, &link_path).map_err(|e| {
                format!("创建文件链接失败 {} -> {}：{e}", plan.location.display(), real.display())
            })?;
        }
    }
    Ok(())
}

/**
 * 只在 STAGING 锁里调（见 stage_runtime_update）：它会把已经存在的 destination 整个删掉
 * 重解，两路并发跑到这里，一路刚解好的目录会被另一路当「损坏」删掉。有锁之后开头这一次
 * `is_file` 检查就够了——前一路解好的，后一路进来看到文件直接返回。
 */
pub(crate) fn unpack_runtime(archive: &Path, destination: &Path) -> Result<(), String> {
    if destination.join("bot/bin/satuwork.mjs").is_file() {
        return Ok(());
    }
    let parent = destination.parent().ok_or("本地运行时目录不完整")?;
    fs::create_dir_all(parent).map_err(|e| format!("创建本地运行时目录失败：{e}"))?;
    if destination.exists() {
        fs::remove_dir_all(destination).map_err(|e| format!("清理损坏的本地运行时失败：{e}"))?;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staging = parent.join(format!(".install-{nonce}"));
    let bot = staging.join("bot");
    fs::create_dir_all(&bot).map_err(|e| format!("创建本地运行时临时目录失败：{e}"))?;
    let result: Result<(), String> = (|| {
        let file = fs::File::open(archive).map_err(|e| format!("打开本地运行时包失败：{e}"))?;
        let gz = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(gz);
        #[cfg(not(windows))]
        archive
            .unpack(&bot)
            .map_err(|e| format!("解开本地运行时失败：{e}"))?;
        #[cfg(windows)]
        unpack_links_windows(&mut archive, &bot, &destination.join("bot"))?;
        if !bot.join("bin/satuwork.mjs").is_file() {
            return Err("本地运行时包缺少 bin/satuwork.mjs".into());
        }
        fs::rename(&staging, destination).map_err(|e| format!("安装本地运行时失败：{e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{link_target_in_root, plan_links, safe_entry_path, unpack_runtime, LinkDest};
    use crate::scratch;

    /// 造一个运行时包：`(路径, 文件内容)` 或 `(路径, 链接目标)`。`raw_path` 为真时绕开 tar 对
    /// `..` 的检查，把路径原样写进头里——测「包是外面来的，里面写什么都可能」那种。
    enum TarEntry<'a> {
        File(&'a str, &'a [u8]),
        Link(&'a str, &'a str),
        RawLink(&'a str, &'a str),
    }

    fn write_tgz(path: &std::path::Path, entries: &[TarEntry]) {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        let file = std::fs::File::create(path).unwrap();
        let mut tar = tar::Builder::new(GzEncoder::new(file, Compression::default()));
        for entry in entries {
            let mut header = tar::Header::new_gnu();
            match entry {
                TarEntry::File(p, body) => {
                    header.set_path(p).unwrap();
                    header.set_size(body.len() as u64);
                    header.set_mode(0o644);
                    header.set_cksum();
                    tar.append(&header, *body).unwrap();
                    continue;
                }
                TarEntry::Link(p, _) => header.set_path(p).unwrap(),
                TarEntry::RawLink(p, _) => {
                    let name = &mut header.as_old_mut().name;
                    name[..p.len()].copy_from_slice(p.as_bytes());
                }
            }
            let target = match entry {
                TarEntry::Link(_, t) | TarEntry::RawLink(_, t) => *t,
                TarEntry::File(..) => unreachable!(),
            };
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_link_name(target).unwrap();
            header.set_size(0);
            header.set_mode(0o777);
            header.set_cksum();
            tar.append(&header, &[][..]).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
    }

    /// 链接不经过 tar 的 `unpack_in`，`..` 和绝对路径得自己挡（见 safe_entry_path）。
    #[test]
    fn link_paths_stay_inside_the_package() {
        use std::path::{Path, PathBuf};
        assert_eq!(safe_entry_path(Path::new("./node_modules/dep")), Some(PathBuf::from("node_modules/dep")));
        for bad in ["../evil", "node_modules/../../evil", "/etc/passwd", ".", ""] {
            assert_eq!(safe_entry_path(Path::new(bad)), None, "不该认：{bad}");
        }
        let link = Path::new("node_modules/dep");
        assert_eq!(
            link_target_in_root(link, Path::new(".pnpm/dep@1.0.0/node_modules/dep")),
            LinkDest::Inside(PathBuf::from("node_modules/.pnpm/dep@1.0.0/node_modules/dep"))
        );
        assert_eq!(
            link_target_in_root(Path::new("node_modules/.pnpm/a@1/node_modules/b"), Path::new("../../b@2/node_modules/b")),
            LinkDest::Inside(PathBuf::from("node_modules/.pnpm/b@2/node_modules/b"))
        );
        // 构建机上 workspace 包那种，和绝对路径：都算包外
        assert_eq!(link_target_in_root(link, Path::new("../../../../../../../bot")), LinkDest::Outside);
        assert_eq!(link_target_in_root(link, Path::new("/Users/someone/secrets")), LinkDest::Outside);
    }

    /// 链条先在内存里走到底，不看链接在包里的先后（见 resolve_through_links）。
    #[test]
    fn link_chains_resolve_regardless_of_order() {
        use std::path::PathBuf;
        let p = |a: &str, b: &str| (PathBuf::from(a), PathBuf::from(b));
        // alias 排在它指向的那条链接前面
        let plans = plan_links(vec![
            p("node_modules/alias", ".pnpm/node_modules/dep"),
            p("node_modules/.pnpm/node_modules/dep", "../dep@1.0.0/node_modules/dep"),
            p("node_modules/@w/pkg", "../../../../../../../bot"),
            // 位置本身在一条指到包外的链接底下：跳过
            p("node_modules/@w/pkg/node_modules/x", "../../y"),
        ])
        .unwrap();
        let dest_of = |loc: &str| plans.iter().find(|l| l.location == PathBuf::from(loc)).map(|l| l.dest.clone());
        let real = LinkDest::Inside(PathBuf::from("node_modules/.pnpm/dep@1.0.0/node_modules/dep"));
        assert_eq!(dest_of("node_modules/alias"), Some(real.clone()));
        assert_eq!(dest_of("node_modules/.pnpm/node_modules/dep"), Some(real));
        assert_eq!(dest_of("node_modules/@w/pkg"), Some(LinkDest::Outside));
        assert_eq!(plans.len(), 3, "在包外链接底下的那条该跳过：{plans:?}");

        // 成环、路径不合法：报错，不静默跳过
        assert!(plan_links(vec![p("a", "b"), p("b", "a")]).is_err());
        assert!(plan_links(vec![p("../evil", "x")]).is_err());
    }

    #[test]
    fn unpack_runtime_follows_links() {
        use std::fs;
        let base = scratch("unpack-links");
        let archive = base.join("bot.tgz");
        let destination = base.join("releases/v1");
        write_tgz(
            &archive,
            &[
                TarEntry::File("bin/satuwork.mjs", b"console.log('hello');"),
                TarEntry::File("node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js", b"module.exports = 42;"),
                // 链：alias -> .pnpm/node_modules/dep -> ../dep@1.0.0/...，alias 排在前面
                TarEntry::Link("node_modules/alias", ".pnpm/node_modules/dep"),
                TarEntry::Link("node_modules/.pnpm/node_modules/dep", "../dep@1.0.0/node_modules/dep"),
                TarEntry::Link("node_modules/dep", ".pnpm/dep@1.0.0/node_modules/dep"),
                TarEntry::Link("node_modules/.bin/dep.js", "../.pnpm/dep@1.0.0/node_modules/dep/index.js"),
                // 构建机上的 workspace 链接：这台电脑上不存在
                TarEntry::Link("node_modules/@w/pkg", "../../../../../../../bot"),
            ],
        );
        unpack_runtime(&archive, &destination).unwrap();
        let bot = destination.join("bot");
        for p in ["node_modules/dep/index.js", "node_modules/alias/index.js", "node_modules/.bin/dep.js"] {
            assert_eq!(fs::read_to_string(bot.join(p)).unwrap(), "module.exports = 42;", "读不到 {p}");
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// 路径带 `..` 的链接条目：哪个平台都不能落到版本目录外面。非 Windows 走 tar 的 unpack，
    /// 它跳过这种条目；Windows 自己解析链接，直接判整包不合法。
    #[test]
    fn link_entries_never_land_outside_the_package() {
        use std::fs;
        let base = scratch("unpack-escape");
        let archive = base.join("bot.tgz");
        let destination = base.join("releases/v1");
        write_tgz(&archive, &[TarEntry::File("bin/satuwork.mjs", b"x"), TarEntry::RawLink("../escape", "bin")]);
        let result = unpack_runtime(&archive, &destination);
        #[cfg(windows)]
        assert!(result.is_err(), "Windows 上该判整包不合法");
        #[cfg(not(windows))]
        result.unwrap();
        for p in [destination.join("escape"), base.join("releases/escape")] {
            assert!(fs::symlink_metadata(&p).is_err(), "不该在包外建出 {}", p.display());
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// 普通用户那条路：不建符号链接，目录落成 junction、文件落成硬链接，并且在临时目录里建好、
    /// rename 之后仍然指得对（junction 指的是 rename 之后的位置）。
    #[cfg(windows)]
    #[test]
    fn windows_links_fall_back_to_junction_and_hard_link() {
        use super::materialize_links;
        use std::fs;
        use std::path::PathBuf;
        let base = scratch("win-links");
        let staging = base.join(".install-x/bot");
        let final_dir = base.join("releases/v1");
        let dep = staging.join("node_modules/.pnpm/dep@1.0.0/node_modules/dep");
        fs::create_dir_all(&dep).unwrap();
        fs::write(dep.join("index.js"), "module.exports = 42;").unwrap();
        let p = |a: &str, b: &str| (PathBuf::from(a), PathBuf::from(b));
        let plans = plan_links(vec![
            p("node_modules/alias", ".pnpm/node_modules/dep"),
            p("node_modules/.pnpm/node_modules/dep", "../dep@1.0.0/node_modules/dep"),
            p("node_modules/.bin/dep.js", "../.pnpm/dep@1.0.0/node_modules/dep/index.js"),
        ])
        .unwrap();
        materialize_links(&staging, &final_dir.join("bot"), &plans, false).unwrap();
        fs::create_dir_all(final_dir.parent().unwrap()).unwrap();
        fs::rename(base.join(".install-x"), &final_dir).unwrap();
        let bot = final_dir.join("bot");
        for p in ["node_modules/alias/index.js", "node_modules/.pnpm/node_modules/dep/index.js", "node_modules/.bin/dep.js"] {
            assert_eq!(fs::read_to_string(bot.join(p)).unwrap(), "module.exports = 42;", "读不到 {p}");
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// 包里的链接出问题时整次安装失败，**不留下版本目录**：否则下次 unpack_runtime 看到
    /// bin/satuwork.mjs 就当它装好了。
    #[cfg(windows)]
    #[test]
    fn windows_bad_links_leave_no_release_directory() {
        use std::fs;
        for (name, entries) in [
            ("dangling", vec![TarEntry::Link("node_modules/gone", ".pnpm/gone@1/node_modules/gone")]),
            ("cycle", vec![TarEntry::Link("node_modules/a", "b"), TarEntry::Link("node_modules/b", "a")]),
        ] {
            let base = scratch(&format!("win-bad-{name}"));
            let archive = base.join("bot.tgz");
            let destination = base.join("releases/v1");
            let mut all = vec![TarEntry::File("bin/satuwork.mjs", b"x")];
            all.extend(entries);
            write_tgz(&archive, &all);
            assert!(unpack_runtime(&archive, &destination).is_err(), "{name} 该失败");
            assert!(!destination.exists(), "{name} 失败后不该留下版本目录");
            let _ = fs::remove_dir_all(&base);
        }
    }
}
