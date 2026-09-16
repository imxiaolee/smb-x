use crate::{model::*, provider::*, state::AppState};
use serde::Serialize;
use std::{sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Instant};
use tokio::sync::{mpsc, Notify};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String, pub name: String, pub source: Location, pub destination: Location,
    pub moving: bool, pub status: String, pub done: u64, pub total: u64,
    pub speed: f64, pub error: Option<String>, pub conflict: Option<String>, pub skipped: usize,
}
pub struct Task {
    pub progress: Mutex<Progress>, pub cancel: AtomicBool,
    pub decision: Mutex<Option<String>>, pub notify: Notify,
}
impl Task {
    pub fn new(source: Location, destination: Location, name: String, moving: bool) -> Arc<Self> {
        Arc::new(Self { progress: Mutex::new(Progress { id: uuid::Uuid::new_v4().to_string(), name, source, destination, moving, status: "queued".into(), done: 0, total: 0, speed: 0.0, error: None, conflict: None, skipped: 0 }), cancel: AtomicBool::new(false), decision: Mutex::new(None), notify: Notify::new() })
    }
    pub fn check(&self) -> Result<()> { if self.cancel.load(Ordering::Relaxed) { Err("已取消".into()) } else { Ok(()) } }
    fn status(&self, status: &str) { let mut p = self.progress.lock().unwrap(); p.status = status.into(); p.speed = 0.0; }
    async fn conflict(&self, path: &str) -> Result<bool> {
        *self.decision.lock().unwrap() = None;
        { let mut p = self.progress.lock().unwrap(); p.status = "conflict".into(); p.conflict = Some(path.into()); p.speed = 0.0; }
        loop {
            self.check()?;
            let decision = self.decision.lock().unwrap().take();
            if let Some(d) = decision {
                { let mut p = self.progress.lock().unwrap(); p.status = "running".into(); p.conflict = None; }
                return match d.as_str() { "replace" => Ok(true), "skip" => Ok(false), _ => Err("已取消".into()) };
            }
            self.notify.notified().await;
        }
    }
}
pub async fn worker(state: Arc<AppState>, mut rx: mpsc::UnboundedReceiver<Arc<Task>>) {
    while let Some(task) = rx.recv().await {
        if task.cancel.load(Ordering::Relaxed) { task.status("cancelled"); continue; }
        let result = run(&state, &task).await;
        let mut p = task.progress.lock().unwrap(); p.speed = 0.0; p.conflict = None;
        match result {
            Ok(()) => { p.status = if p.skipped > 0 { "skipped" } else { "success" }.into(); },
            Err(e) => { p.status = if task.cancel.load(Ordering::Relaxed) { "cancelled" } else { "failed" }.into(); p.error = Some(e); }
        }
    }
}
struct Planned { source: Location, destination: Location, entry: Entry }
async fn run(state: &AppState, task: &Task) -> Result<()> {
    task.status("scanning");
    let p = task.progress.lock().unwrap().clone();
    let mut src = state.provider(&p.source).await?;
    let mut dst = state.provider(&p.destination).await?;
    let root = src.stat(&p.source.path).await?.ok_or("源文件不存在")?;
    if root.is_link { return Err("第一版不复制符号链接，请选择实际文件".into()); }
    let target = p.destination.child(&root.name)?;
    validate_target(state, &p.source, &p.destination, &root.name).await?;
    let target_dir = dst.stat(&p.destination.path).await?.ok_or("目标目录不存在")?;
    if !target_dir.is_dir || target_dir.is_link { return Err("目标必须是实际目录".into()); }
    let mut stack = vec![Planned { source: p.source.clone(), destination: target, entry: root }];
    let mut plan = Vec::new(); let mut total = 0;
    while let Some(item) = stack.pop() {
        task.check()?;
        if item.entry.is_link { return Err(format!("不支持复制符号链接：{}", item.source.path)); }
        if item.entry.is_dir {
            for e in src.list(&item.source.path).await? {
                stack.push(Planned { source: item.source.child(&e.name)?, destination: item.destination.child(&e.name)?, entry: e });
            }
        } else { total += item.entry.size; }
        plan.push(item);
        if plan.len() + stack.len() > 200_000 { return Err("单个任务超过 20 万项，请分批传输".into()); }
    }
    { let mut p = task.progress.lock().unwrap(); p.total = total; p.status = "running".into(); }
    let mut dirs = Vec::new(); let mut skip_prefixes: Vec<Location> = Vec::new();
    for item in plan {
        task.check()?;
        if skip_prefixes.iter().any(|l| beneath(l, &item.destination)) { task.progress.lock().unwrap().skipped += 1; continue; }
        let existing = dst.stat(&item.destination.path).await?;
        if existing.as_ref().is_some_and(|e| e.is_link) { return Err("目标包含符号链接，已停止".into()); }
        if item.entry.is_dir {
            if let Some(e) = existing {
                if !e.is_dir {
                    if !task.conflict(&format!("{}（文件与目录类型冲突，仅支持跳过或取消）", item.destination.path)).await? { skip_prefixes.push(item.destination); task.progress.lock().unwrap().skipped += 1; continue; }
                    return Err("不能用目录替换文件，请重命名后重试".into());
                }
            } else { dst.mkdir(&item.destination.path).await?; }
            dirs.push(item.source); continue;
        }
        let replace = if let Some(e) = &existing {
            let yes = task.conflict(&item.destination.path).await?;
            if !yes { task.progress.lock().unwrap().skipped += 1; continue; }
            if e.is_dir { return Err("不能用文件替换目录，请重命名后重试".into()); }
            true
        } else { false };
        copy_file(src.as_mut(), dst.as_mut(), &item, existing, replace, task).await?;
        if p.moving {
            // A moved file is removed only after commit and a source-change check.
            let current = src.stat(&item.source.path).await?.ok_or("源文件在传输后消失")?;
            if current.size != item.entry.size || current.modified != item.entry.modified { return Err("源文件在传输期间发生变化，已保留源文件".into()); }
            src.delete(&item.source.path, false).await?;
        }
    }
    if p.moving && task.progress.lock().unwrap().skipped == 0 {
        for dir in dirs.into_iter().rev() { task.check()?; src.delete(&dir.path, true).await?; }
    }
    Ok(())
}
fn beneath(parent: &Location, child: &Location) -> bool {
    let a = parent.path.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let b = child.path.replace('\\', "/").to_lowercase();
    parent.connection == child.connection && (a == b || b.starts_with(&(a + "/")))
}
async fn validate_target(state: &AppState, source: &Location, dest: &Location, name: &str) -> Result<()> {
    if source.connection.is_none() && dest.connection.is_none() {
        let src = tokio::fs::canonicalize(&source.path).await.map_err(err)?;
        let target = tokio::fs::canonicalize(&dest.path).await.map_err(err)?.join(name);
        let a = Location { connection: None, path: src.to_string_lossy().into_owned() };
        let b = Location { connection: None, path: target.to_string_lossy().into_owned() };
        if beneath(&a, &b) { return Err("不能复制到自身或自身的子目录".into()); }
    } else if let (Some(a), Some(b)) = (&source.connection, &dest.connection) {
        let sa = state.server(a)?; let sb = state.server(b)?;
        if sa.host.eq_ignore_ascii_case(&sb.host) && sa.port == sb.port && sa.share.eq_ignore_ascii_case(&sb.share) {
            let mut target = dest.child(name)?; target.connection = source.connection.clone();
            if beneath(source, &target) { return Err("不能复制到自身或自身的子目录".into()); }
        }
    }
    Ok(())
}
async fn copy_file(src: &mut dyn FileSystemProvider, dst: &mut dyn FileSystemProvider, item: &Planned, expected: Option<Entry>, replace: bool, task: &Task) -> Result<()> {
    let suffix = uuid::Uuid::new_v4();
    let temp = format!("{}.transx-{suffix}.part", item.destination.path);
    let mut reader = src.read(&item.source.path).await?;
    let writer = dst.write(&temp).await;
    let mut writer = match writer { Ok(w) => w, Err(e) => { let _ = reader.close().await; return Err(e); } };
    let mut offset = 0; let mut tick = Instant::now(); let mut tick_bytes = 0;
    let copied: Result<()> = async {
        while offset < item.entry.size {
            task.check()?;
            let bytes = reader.read(offset).await?;
            if bytes.is_empty() { return Err("源文件提前结束，可能已被修改".into()); }
            if offset + bytes.len() as u64 > item.entry.size { return Err("源文件大小发生变化".into()); }
            writer.write(&bytes).await?;
            offset += bytes.len() as u64; tick_bytes += bytes.len() as u64;
            let mut p = task.progress.lock().unwrap(); p.done += bytes.len() as u64;
            if tick.elapsed().as_secs_f64() >= 0.25 { p.speed = tick_bytes as f64 / tick.elapsed().as_secs_f64(); tick = Instant::now(); tick_bytes = 0; }
        }
        task.check()?;
        let current = src.stat(&item.source.path).await?.ok_or("源文件消失")?;
        if current.size != item.entry.size || current.modified != item.entry.modified { return Err("源文件在传输期间发生变化".into()); }
        Ok(())
    }.await;
    let closed = reader.close().await;
    let copied = copied.and(closed);
    if let Err(e) = copied {
        let abort = writer.abort().await;
        let cleanup = dst.delete(&temp, false).await;
        return Err(format!("{e}{}{}", abort.err().map(|x| format!("；关闭失败：{x}")).unwrap_or_default(), cleanup.err().map(|x| format!("；临时文件未清理 {temp}：{x}")).unwrap_or_default()));
    }
    if let Err(e) = writer.finish().await { let _ = dst.delete(&temp, false).await; return Err(format!("{e}；请检查临时路径 {temp}")); }
    let commit: Result<()> = async {
        task.check()?;
        let now = dst.stat(&item.destination.path).await?;
        if replace {
            let old = expected.as_ref().ok_or("缺少目标快照")?;
            let current = now.as_ref().ok_or("目标文件在确认后消失，请重试")?;
            if current.size != old.size || current.modified != old.modified || current.is_dir || current.is_link { return Err("目标文件在确认后发生变化，请重试".into()); }
            let backup = format!("{}.transx-{suffix}.backup", item.destination.path);
            dst.rename(&item.destination.path, &backup).await?;
            if let Err(e) = dst.rename(&temp, &item.destination.path).await {
                let rollback = dst.rename(&backup, &item.destination.path).await;
                return Err(format!("提交失败：{e}；原文件备份 {backup}；回滚：{}", rollback.err().unwrap_or_else(|| "成功".into())));
            }
            dst.delete(&backup, false).await.map_err(|e| format!("新文件已提交，旧文件备份未清理 {backup}：{e}"))?;
        } else {
            // The provider's rename is exclusive; a late conflict never overwrites.
            if now.is_some() { return Err("目标出现同名文件，请重试后确认".into()); }
            dst.rename(&temp, &item.destination.path).await?;
        }
        Ok(())
    }.await;
    if commit.is_err() { let _ = dst.delete(&temp, false).await; }
    commit
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn descendants_use_component_boundary() {
        let a = Location { connection: None, path: "/a/dir".into() };
        assert!(beneath(&a, &Location { path: "/a/dir/x".into(), ..a.clone() }));
        assert!(!beneath(&a, &Location { path: "/a/directory".into(), ..a.clone() }));
    }
    #[tokio::test] async fn cancel_wakes_conflict() {
        let loc = Location { connection: None, path: "/x".into() };
        let task = Task::new(loc.clone(), loc, "x".into(), false);
        let t = task.clone(); let wait = tokio::spawn(async move { t.conflict("x").await });
        tokio::task::yield_now().await;
        task.cancel.store(true, Ordering::Relaxed); task.notify.notify_one();
        assert!(wait.await.unwrap().is_err());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    mod files {
        use super::*;
        fn location(path: &std::path::Path) -> Location { Location { connection: None, path: path.to_string_lossy().into_owned() } }
        fn state(root: &std::path::Path) -> AppState {
            let (queue, _) = mpsc::unbounded_channel();
            AppState { settings: Default::default(), passwords: Default::default(), sessions: Default::default(), tasks: Default::default(), queue, config_path: root.join("settings.json") }
        }
        #[tokio::test] async fn copies_multiple_chunks_empty_files_and_empty_directories() {
            let temp = tempfile::tempdir().unwrap(); let root = temp.path();
            let source = root.join("source"); let dest = root.join("dest");
            std::fs::create_dir(&source).unwrap(); std::fs::create_dir(&dest).unwrap(); std::fs::create_dir(source.join("empty-dir")).unwrap();
            let data: Vec<u8> = (0..CHUNK * 2 + 173).map(|i| (i % 251) as u8).collect();
            std::fs::write(source.join("large.bin"), &data).unwrap(); std::fs::write(source.join("empty"), []).unwrap();
            let task = Task::new(location(&source), location(&dest), "source".into(), false);
            run(&state(root), &task).await.unwrap();
            assert_eq!(std::fs::read(dest.join("source/large.bin")).unwrap(), data);
            assert_eq!(std::fs::metadata(dest.join("source/empty")).unwrap().len(), 0);
            assert!(dest.join("source/empty-dir").is_dir());
            assert!(source.join("large.bin").exists());
            let p = task.progress.lock().unwrap(); assert_eq!(p.done, p.total);
        }
        #[tokio::test] async fn successful_move_removes_source_only_after_copy() {
            let temp = tempfile::tempdir().unwrap(); let root = temp.path();
            let source = root.join("file"); let dest = root.join("dest");
            std::fs::write(&source, b"data").unwrap(); std::fs::create_dir(&dest).unwrap();
            run(&state(root), &Task::new(location(&source), location(&dest), "file".into(), true)).await.unwrap();
            assert!(!source.exists()); assert_eq!(std::fs::read(dest.join("file")).unwrap(), b"data");
        }
        #[tokio::test] async fn source_size_change_leaves_target_intact_and_cleans_partial() {
            let temp = tempfile::tempdir().unwrap(); let root = temp.path();
            let source = root.join("source"); let target = root.join("target");
            std::fs::write(&source, b"new data").unwrap(); std::fs::write(&target, b"old data").unwrap();
            let mut src = LocalFileSystem; let mut dst = LocalFileSystem;
            let mut entry = src.stat(source.to_str().unwrap()).await.unwrap().unwrap(); entry.size = 1;
            let expected = dst.stat(target.to_str().unwrap()).await.unwrap();
            let task = Task::new(location(&source), location(root), "source".into(), false);
            let item = Planned { source: location(&source), destination: location(&target), entry };
            assert!(copy_file(&mut src, &mut dst, &item, expected, true, &task).await.is_err());
            assert_eq!(std::fs::read(&target).unwrap(), b"old data");
            assert_eq!(std::fs::read_dir(root).unwrap().count(), 2);
        }
        struct FailCommit(LocalFileSystem);
        #[async_trait::async_trait]
        impl FileSystemProvider for FailCommit {
            async fn list(&mut self, p: &str) -> Result<Vec<Entry>> { self.0.list(p).await }
            async fn stat(&mut self, p: &str) -> Result<Option<Entry>> { self.0.stat(p).await }
            async fn mkdir(&mut self, p: &str) -> Result<()> { self.0.mkdir(p).await }
            async fn rename(&mut self, from: &str, to: &str) -> Result<()> {
                if from.ends_with(".part") { Err("injected commit failure".into()) } else { self.0.rename(from, to).await }
            }
            async fn delete(&mut self, p: &str, d: bool) -> Result<()> { self.0.delete(p, d).await }
            async fn read(&mut self, p: &str) -> Result<Reader> { self.0.read(p).await }
            async fn write(&mut self, p: &str) -> Result<Writer> { self.0.write(p).await }
        }
        #[tokio::test] async fn failed_replace_commit_restores_original() {
            let temp = tempfile::tempdir().unwrap(); let root = temp.path();
            let source = root.join("source"); let target = root.join("target");
            std::fs::write(&source, b"new").unwrap(); std::fs::write(&target, b"original").unwrap();
            let mut src = LocalFileSystem; let mut dst = FailCommit(LocalFileSystem);
            let entry = src.stat(source.to_str().unwrap()).await.unwrap().unwrap();
            let expected = dst.stat(target.to_str().unwrap()).await.unwrap();
            let item = Planned { source: location(&source), destination: location(&target), entry };
            let task = Task::new(location(&source), location(root), "source".into(), false);
            assert!(copy_file(&mut src, &mut dst, &item, expected, true, &task).await.is_err());
            assert_eq!(std::fs::read(&target).unwrap(), b"original");
            assert_eq!(std::fs::read_dir(root).unwrap().count(), 2);
        }
        #[tokio::test] async fn rename_never_replaces_and_self_copy_is_rejected() {
            let temp = tempfile::tempdir().unwrap(); let root = temp.path();
            let source = root.join("source"); let target = root.join("target");
            std::fs::write(&source, b"new").unwrap(); std::fs::write(&target, b"old").unwrap();
            assert!(LocalFileSystem.rename(source.to_str().unwrap(), target.to_str().unwrap()).await.is_err());
            assert_eq!(std::fs::read(&target).unwrap(), b"old");
            assert!(validate_target(&state(root), &location(&source), &location(root), "source").await.is_err());
        }
    }
}
