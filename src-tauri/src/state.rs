use crate::{model::*, provider::{FileSystemProvider, LocalFileSystem, SharedSmbFileSystem, SmbFileSystem}, transfer::Task};
use std::{collections::HashMap, path::PathBuf, sync::{Arc, Mutex}};
use tokio::sync::{mpsc, Mutex as AsyncMutex};

pub struct AppState {
    pub settings: Mutex<Settings>,
    /// Session-only credentials. Never serialized or sent back to the webview.
    pub passwords: Mutex<HashMap<String, String>>,
    /// One authenticated SMB session per saved server. NAS devices often reject rapid session churn.
    pub sessions: AsyncMutex<HashMap<String, Arc<AsyncMutex<SmbFileSystem>>>>,
    pub tasks: Mutex<Vec<Arc<Task>>>,
    pub queue: mpsc::UnboundedSender<Arc<Task>>,
    pub config_path: PathBuf,
}
impl AppState {
    pub fn server(&self, id: &str) -> Result<Server> {
        self.settings.lock().unwrap().servers.iter().find(|s| s.id == id).cloned().ok_or("连接不存在，请重新连接".into())
    }
    pub async fn provider(&self, loc: &Location) -> Result<Box<dyn FileSystemProvider>> {
        match &loc.connection {
            None => {
                if !std::path::Path::new(&loc.path).is_absolute() { return Err("请输入本地绝对路径".into()); }
                Ok(Box::new(LocalFileSystem))
            },
            Some(id) => {
                if let Some(session) = self.sessions.lock().await.get(id).cloned() {
                    return Ok(Box::new(SharedSmbFileSystem::new(session)));
                }
                let server = self.server(id)?;
                let cached = self.passwords.lock().unwrap().get(id).cloned();
                let password = match cached {
                    Some(p) => p,
                    None if server.remember => {
                        let id = id.clone();
                        tokio::task::spawn_blocking(move || credential(&id)?.get_password().map_err(err)).await.map_err(err)??
                    },
                    None => return Err("请在连接窗口重新输入密码".into()),
                };
                self.passwords.lock().unwrap().insert(id.clone(), password.clone());
                // Re-check while holding the creation lock so concurrent pane loads cannot
                // authenticate twice for the same server.
                let mut sessions = self.sessions.lock().await;
                if let Some(session) = sessions.get(id).cloned() {
                    return Ok(Box::new(SharedSmbFileSystem::new(session)));
                }
                let session = Arc::new(AsyncMutex::new(SmbFileSystem::connect(&server, password).await?));
                sessions.insert(id.clone(), session.clone());
                Ok(Box::new(SharedSmbFileSystem::new(session)))
            }
        }
    }
    pub fn save(&self, settings: &Settings) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(settings).map_err(err)?;
        let temp = self.config_path.with_extension("json.tmp");
        std::fs::write(&temp, bytes).map_err(err)?;
        // Windows rename does not replace. Keep a recoverable previous generation.
        let backup = self.config_path.with_extension("json.bak");
        if backup.exists() { std::fs::remove_file(&backup).map_err(err)?; }
        if self.config_path.exists() { std::fs::rename(&self.config_path, &backup).map_err(err)?; }
        if let Err(e) = std::fs::rename(&temp, &self.config_path) {
            let _ = std::fs::rename(&backup, &self.config_path); return Err(err(e));
        }
        Ok(())
    }
}
pub fn credential(id: &str) -> Result<keyring::Entry> { keyring::Entry::new("dev.transx.smb", id).map_err(err) }
