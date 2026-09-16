#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod model;
mod provider;
mod state;
mod transfer;

use model::*;
use provider::{FileSystemProvider, SmbFileSystem};
use state::{AppState, credential};
use std::{sync::{Arc, atomic::Ordering}, path::Path};
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex as AsyncMutex;
use transfer::{Task, Progress};

#[derive(serde::Serialize)]
struct Initial { home: String, settings: Settings }
#[tauri::command]
fn configure_menu(app: tauri::AppHandle, english: bool) -> Result<()> {
    if !cfg!(target_os = "macos") { return Ok(()); }
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let menu = Menu::default(&app).map_err(err)?;
    if let Some(first) = menu.items().map_err(err)?.first().and_then(|item| item.as_submenu()).cloned() {
        first.set_text("smb X").map_err(err)?;
        let settings = MenuItem::with_id(&app, "settings", if english { "Settings…" } else { "设置…" }, true, Some("CmdOrCtrl+,")).map_err(err)?;
        first.insert(&settings, 2).map_err(err)?;
        first.insert(&PredefinedMenuItem::separator(&app).map_err(err)?, 3).map_err(err)?;
    }
    app.set_menu(menu).map_err(err)?;
    Ok(())
}
#[tauri::command]
fn initial(state: State<'_, Arc<AppState>>) -> Result<Initial> {
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map_err(err)?;
    Ok(Initial { home, settings: state.settings.lock().unwrap().clone() })
}
#[tauri::command]
async fn list(location: Location, state: State<'_, Arc<AppState>>) -> Result<Vec<Entry>> {
    state.provider(&location).await?.list(&location.path).await
}
#[tauri::command]
async fn list_shares(server: Server, password: Option<String>, state: State<'_, Arc<AppState>>) -> Result<Vec<String>> {
    server.validate_endpoint()?;
    let pass = match password {
        Some(p) => p,
        None => {
            let saved = state.server(&server.id)?;
            let cached = state.passwords.lock().unwrap().get(&saved.id).cloned();
            match cached {
                Some(p) => p,
                None if saved.remember => tokio::task::spawn_blocking(move || credential(&saved.id)?.get_password().map_err(err)).await.map_err(err)??,
                None => return Err("请在连接窗口重新输入密码".into()),
            }
        }
    };
    // Enumeration is temporary: do not save credentials or replace an active connection.
    SmbFileSystem::list_shares(&server, pass).await
}
#[tauri::command]
async fn connect(mut server: Server, password: Option<String>, state: State<'_, Arc<AppState>>) -> Result<Server> {
    server.validate()?;
    if server.id.is_empty() { server.id = uuid::Uuid::new_v4().to_string(); }
    let pass = match password {
        Some(p) => p,
        None => { let id = server.id.clone(); tokio::task::spawn_blocking(move || credential(&id)?.get_password().map_err(err)).await.map_err(err)?? }
    };
    let mut provider = SmbFileSystem::connect(&server, pass.clone()).await?;
    provider.list("/").await?;
    let app_state = state.inner().clone(); let saved_state = app_state.clone(); let result = server.clone();
    tokio::task::spawn_blocking(move || {
        let key = credential(&server.id)?;
        if server.remember { key.set_password(&pass).map_err(err)?; }
        else { match key.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => {}, Err(e) => return Err(err(e)) } }
        let mut settings = saved_state.settings.lock().unwrap(); let mut next = settings.clone();
        next.servers.retain(|s| s.id != server.id); next.servers.push(server.clone());
        saved_state.save(&next)?; *settings = next;
        saved_state.passwords.lock().unwrap().insert(server.id, pass);
        Ok::<_, String>(())
    }).await.map_err(err)??;
    app_state.sessions.lock().await.insert(result.id.clone(), Arc::new(AsyncMutex::new(provider)));
    Ok(result)
}
#[tauri::command]
async fn update_server(mut server: Server, password: Option<String>, state: State<'_, Arc<AppState>>) -> Result<Server> {
    server.validate()?;
    server.label = normalize_server_label(&server.label)?;
    if state.tasks.lock().unwrap().iter().any(|t| { let p = t.progress.lock().unwrap(); !terminal(&p.status) && (p.source.connection.as_ref() == Some(&server.id) || p.destination.connection.as_ref() == Some(&server.id)) }) {
        return Err("此连接仍有任务，请先取消或等待完成再编辑".into());
    }
    // Serialize against session creation; saving never contacts the SMB server.
    let mut sessions = state.sessions.lock().await;
    let saved_state = state.inner().clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut settings = saved_state.settings.lock().unwrap();
        let old = settings.servers.iter().find(|s| s.id == server.id).ok_or("连接不存在")?;
        let key = credential(&server.id)?;
        let cached = saved_state.passwords.lock().unwrap().get(&server.id).cloned();
        let pass = match password {
            Some(p) => Some(p),
            None if cached.is_some() => cached,
            None if old.remember => match key.get_password() {
                Ok(p) => Some(p), Err(keyring::Error::NoEntry) => None, Err(e) => return Err(err(e)),
            },
            None => None,
        };
        if server.remember {
            if let Some(p) = &pass { key.set_password(p).map_err(err)?; }
        } else {
            match key.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => {}, Err(e) => return Err(err(e)) }
        }
        let mut next = settings.clone();
        *next.servers.iter_mut().find(|s| s.id == server.id).ok_or("连接不存在")? = server.clone();
        saved_state.save(&next)?; *settings = next;
        let mut passwords = saved_state.passwords.lock().unwrap();
        if let Some(p) = pass { passwords.insert(server.id.clone(), p); } else { passwords.remove(&server.id); }
        Ok::<_, String>(server)
    }).await.map_err(err)??;
    sessions.remove(&result.id);
    Ok(result)
}
#[tauri::command]
async fn forget_server(id: String, state: State<'_, Arc<AppState>>) -> Result<()> {
    if state.tasks.lock().unwrap().iter().any(|t| { let p = t.progress.lock().unwrap(); !terminal(&p.status) && (p.source.connection.as_ref() == Some(&id) || p.destination.connection.as_ref() == Some(&id)) }) { return Err("此连接仍有任务，请先取消或等待完成".into()); }
    state.sessions.lock().await.remove(&id);
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        match credential(&id)?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => {}, Err(e) => return Err(err(e)) }
        let mut settings = state.settings.lock().unwrap(); let mut next = settings.clone();
        next.servers.retain(|s| s.id != id); next.favorites.retain(|f| f.location.connection.as_ref() != Some(&id));
        state.save(&next)?; *settings = next; state.passwords.lock().unwrap().remove(&id); Ok(())
    }).await.map_err(err)?
}
#[tauri::command]
async fn rename_server(id: String, label: String, state: State<'_, Arc<AppState>>) -> Result<Settings> {
    let label = normalize_server_label(&label)?;
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut settings = state.settings.lock().unwrap(); let mut next = settings.clone();
        let server = next.servers.iter_mut().find(|server| server.id == id).ok_or("连接不存在")?;
        server.label = label;
        state.save(&next)?; *settings = next.clone(); Ok(next)
    }).await.map_err(err)?
}
#[tauri::command]
async fn favorite(favorite: Favorite, remove: bool, state: State<'_, Arc<AppState>>) -> Result<Settings> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut settings = state.settings.lock().unwrap(); let mut next = settings.clone();
        next.favorites.retain(|f| f.id != favorite.id);
        if !remove { next.favorites.push(favorite); }
        state.save(&next)?; *settings = next.clone(); Ok(next)
    }).await.map_err(err)?
}
fn guard_mutation(location: &Location) -> Result<()> {
    if location.path.contains('\0') || location.path.split(['/', '\\']).any(|s| s == "..") { return Err("不允许操作含 .. 的路径".into()); }
    if location.connection.is_some() {
        if location.path.trim_matches('/').is_empty() { return Err("不能修改共享根目录".into()); }
    } else if Path::new(&location.path).parent().is_none() || Path::new(&location.path).file_name().is_none() { return Err("不能修改文件系统根目录".into()); }
    Ok(())
}
#[tauri::command]
async fn mkdir(location: Location, name: String, state: State<'_, Arc<AppState>>) -> Result<()> {
    let target = location.child(&name)?;
    state.provider(&location).await?.mkdir(&target.path).await
}
#[tauri::command]
async fn rename(location: Location, name: String, state: State<'_, Arc<AppState>>) -> Result<()> {
    guard_mutation(&location)?; validate_name(&name)?;
    let path = if location.connection.is_some() { format!("{}/{}", location.path.rsplit_once('/').map(|p| p.0).unwrap_or(""), name) }
    else { Path::new(&location.path).with_file_name(name).to_string_lossy().into_owned() };
    state.provider(&location).await?.rename(&location.path, &path).await
}
#[tauri::command]
async fn delete(locations: Vec<Location>, confirmed: bool, state: State<'_, Arc<AppState>>) -> Result<()> {
    if !confirmed { return Err("删除操作需要确认".into()); }
    for location in locations {
        guard_mutation(&location)?;
        provider::delete_tree(state.provider(&location).await?.as_mut(), &location).await.map_err(|e| format!("删除 {} 失败：{e}。此前项目可能已删除，请刷新列表。", location.path))?;
    } Ok(())
}
#[tauri::command]
async fn open_local(location: Location) -> Result<()> {
    if location.connection.is_some() || !Path::new(&location.path).is_absolute() { return Err("只能打开本地绝对路径".into()); }
    tokio::task::spawn_blocking(move || open::that(&location.path).map_err(err)).await.map_err(err)?
}
#[tauri::command]
async fn reveal_local(location: Location) -> Result<()> {
    if location.connection.is_some() || !Path::new(&location.path).is_absolute() { return Err("只能在文件管理器中显示本地绝对路径".into()); }
    tokio::task::spawn_blocking(move || reveal_path(&location.path)).await.map_err(err)?
}
#[tauri::command]
async fn copy_local_to_clipboard(locations: Vec<Location>) -> Result<()> {
    if locations.is_empty() || locations.len() > 200 { return Err("系统剪贴板一次支持 1–200 个本机项目".into()); }
    let mut paths = Vec::with_capacity(locations.len());
    for location in locations {
        if location.connection.is_some() || !Path::new(&location.path).is_absolute() { return Err("只有本机文件可以复制到系统剪贴板".into()); }
        paths.push(location.path);
    }
    tokio::task::spawn_blocking(move || write_file_clipboard(paths)).await.map_err(err)?
}
#[cfg(target_os = "macos")]
fn write_file_clipboard(paths: Vec<String>) -> Result<()> {
    for path in &paths { if !Path::new(path).exists() { return Err(format!("文件已不存在：{path}")); } }
    // JXA exposes AppKit without requiring Xcode. Paths are argv values, never script source.
    let script = r#"ObjC.import('AppKit'); ObjC.import('Foundation');
function run(argv) {
  const urls = $.NSMutableArray.alloc.init;
  argv.forEach(function(path) { urls.addObject($.NSURL.fileURLWithPath(path)); });
  const board = $.NSPasteboard.generalPasteboard;
  board.clearContents;
  if (!board.writeObjects(urls)) throw new Error('NSPasteboard rejected the file URLs');
}"#;
    let output = std::process::Command::new("/usr/bin/osascript").args(["-l", "JavaScript", "-e", script, "--"]).args(paths).output().map_err(err)?;
    if output.status.success() { Ok(()) } else {
        let detail = String::from_utf8_lossy(&output.stderr);
        Err(format!("无法写入 macOS 文件剪贴板：{}", detail.trim()))
    }
}
#[cfg(not(target_os = "macos"))]
fn write_file_clipboard(_: Vec<String>) -> Result<()> { Err("系统文件剪贴板当前仅支持 macOS".into()) }
#[cfg(target_os = "macos")]
fn reveal_path(path: &str) -> Result<()> {
    let status = std::process::Command::new("/usr/bin/open").arg("-R").arg(path).status().map_err(err)?;
    if status.success() { Ok(()) } else { Err(format!("访达无法显示此项目（退出状态：{status}）")) }
}
#[cfg(target_os = "windows")]
fn reveal_path(path: &str) -> Result<()> {
    let status = std::process::Command::new("explorer.exe").arg(format!("/select,{path}")).status().map_err(err)?;
    if status.success() { Ok(()) } else { Err(format!("文件资源管理器无法显示此项目（退出状态：{status}）")) }
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn reveal_path(_: &str) -> Result<()> { Err("当前版本仅支持 macOS 和 Windows".into()) }
fn terminal(status: &str) -> bool { matches!(status, "success" | "skipped" | "cancelled" | "failed") }
#[tauri::command]
fn enqueue(sources: Vec<Location>, destination: Location, moving: bool, state: State<'_, Arc<AppState>>) -> Result<()> {
    if sources.is_empty() || sources.len() > 1000 { return Err("每批请选择 1–1000 项".into()); }
    let mut tasks = state.tasks.lock().unwrap();
    if tasks.iter().filter(|t| !terminal(&t.progress.lock().unwrap().status)).count() + sources.len() > 1000 { return Err("队列已满，请等待任务完成".into()); }
    for source in &sources { guard_mutation(source)?; }
    for source in sources {
        let name = source.path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("文件").to_owned();
        let task = Task::new(source, destination.clone(), name, moving);
        tasks.push(task.clone()); state.queue.send(task).map_err(err)?;
    } Ok(())
}
#[tauri::command]
fn tasks(state: State<'_, Arc<AppState>>) -> Vec<Progress> { state.tasks.lock().unwrap().iter().map(|t| t.progress.lock().unwrap().clone()).collect() }
#[tauri::command]
fn task_action(id: String, action: String, state: State<'_, Arc<AppState>>) -> Result<()> {
    let tasks = state.tasks.lock().unwrap(); let task = tasks.iter().find(|t| t.progress.lock().unwrap().id == id).ok_or("任务不存在")?;
    let mut p = task.progress.lock().unwrap();
    match action.as_str() {
        "cancel" if !terminal(&p.status) => { task.cancel.store(true, Ordering::Relaxed); if p.status == "queued" { p.status = "cancelling".into(); } task.notify.notify_one(); },
        "replace" | "skip" if p.status == "conflict" => { *task.decision.lock().unwrap() = Some(action); task.notify.notify_one(); },
        "retry" if matches!(p.status.as_str(), "failed" | "cancelled") => {
            task.cancel.store(false, Ordering::Relaxed); p.status = "queued".into(); p.done = 0; p.total = 0; p.error = None; p.conflict = None; p.skipped = 0;
            state.queue.send(task.clone()).map_err(err)?;
        },
        _ => return Err("当前状态不支持此操作".into()),
    } Ok(())
}
#[tauri::command]
fn clear_finished(state: State<'_, Arc<AppState>>) { state.tasks.lock().unwrap().retain(|t| !terminal(&t.progress.lock().unwrap().status)); }
fn main() {
    tauri::Builder::default().setup(|app| {
        let dir = app.path().app_config_dir()?; std::fs::create_dir_all(&dir)?;
        let config_path = dir.join("settings.json");
        let settings = match std::fs::read(&config_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => match std::fs::read(config_path.with_extension("json.bak")) {
                Ok(bytes) => serde_json::from_slice(&bytes)?, Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(), Err(e) => return Err(e.into()),
            },
            Err(e) => return Err(e.into()),
        };
        let (queue, rx) = tokio::sync::mpsc::unbounded_channel();
        let state = Arc::new(AppState { settings: std::sync::Mutex::new(settings), passwords: Default::default(), sessions: Default::default(), tasks: Default::default(), queue, config_path });
        app.manage(state.clone()); tauri::async_runtime::spawn(transfer::worker(state, rx)); Ok(())
    }).on_menu_event(|app, event| {
        if event.id().as_ref() == "settings" { let _ = app.emit("open-settings", ()); }
    }).invoke_handler(tauri::generate_handler![configure_menu, initial, list, list_shares, connect, update_server, forget_server, rename_server, favorite, mkdir, rename, delete, open_local, reveal_local, copy_local_to_clipboard, enqueue, tasks, task_action, clear_finished])
    .run(tauri::generate_context!()).expect("无法启动smb X");
}
