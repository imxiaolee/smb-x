//! UI-independent providers. No complete file is ever buffered in memory.
use crate::model::*;
use async_trait::async_trait;
use smb2::{client::{ClientConfig, SmbClient, Tree, stream::{FileReader, FileWriter}}, ErrorKind};
use std::{collections::HashMap, path::Path, sync::Arc, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::{fs, io::{AsyncReadExt, AsyncWriteExt}};

pub const CHUNK: usize = 1024 * 1024;
pub fn timestamp(t: Option<SystemTime>) -> Option<u64> { t.and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()) }

pub enum Reader { Local(fs::File), Smb(FileReader) }
impl Reader {
    pub async fn read(&mut self, offset: u64) -> Result<Vec<u8>> {
        match self {
            Self::Local(f) => { let mut b = vec![0; CHUNK]; let n = f.read(&mut b).await.map_err(err)?; b.truncate(n); Ok(b) },
            Self::Smb(f) => f.read_at(offset, CHUNK as u64).await.map_err(err),
        }
    }
    pub async fn close(self) -> Result<()> { match self { Self::Local(_) => Ok(()), Self::Smb(f) => f.close().await.map_err(err) } }
}
pub enum Writer { Local(fs::File), Smb(FileWriter) }
impl Writer {
    pub async fn write(&mut self, b: &[u8]) -> Result<()> { match self { Self::Local(f) => f.write_all(b).await.map_err(err), Self::Smb(f) => f.write_chunk(b).await.map_err(err) } }
    pub async fn finish(self) -> Result<()> { match self { Self::Local(f) => f.sync_all().await.map_err(err), Self::Smb(f) => f.finish().await.map(|_| ()).map_err(err) } }
    pub async fn abort(self) -> Result<()> { match self { Self::Local(_) => Ok(()), Self::Smb(f) => f.abort().await.map(|_| ()).map_err(err) } }
}

#[async_trait]
pub trait FileSystemProvider: Send {
    async fn list(&mut self, path: &str) -> Result<Vec<Entry>>;
    async fn stat(&mut self, path: &str) -> Result<Option<Entry>>;
    async fn mkdir(&mut self, path: &str) -> Result<()>;
    /// Never overwrites an existing destination. Replacement is managed by transfer.rs.
    async fn rename(&mut self, from: &str, to: &str) -> Result<()>;
    async fn delete(&mut self, path: &str, is_dir: bool) -> Result<()>;
    async fn read(&mut self, path: &str) -> Result<Reader>;
    async fn write(&mut self, path: &str) -> Result<Writer>;
}
pub struct LocalFileSystem;
fn local_entry(path: &Path, m: std::fs::Metadata) -> Entry {
    Entry { name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(), is_dir: m.is_dir(), size: m.len(), modified: timestamp(m.modified().ok()), is_link: m.file_type().is_symlink() }
}
#[async_trait]
impl FileSystemProvider for LocalFileSystem {
    async fn list(&mut self, path: &str) -> Result<Vec<Entry>> {
        let mut result = Vec::new(); let mut dir = fs::read_dir(path).await.map_err(err)?;
        while let Some(e) = dir.next_entry().await.map_err(err)? {
            let m = fs::symlink_metadata(e.path()).await.map_err(err)?;
            result.push(local_entry(&e.path(), m));
        } Ok(result)
    }
    async fn stat(&mut self, path: &str) -> Result<Option<Entry>> {
        match fs::symlink_metadata(path).await {
            Ok(m) => Ok(Some(local_entry(Path::new(path), m))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None), Err(e) => Err(err(e)),
        }
    }
    async fn mkdir(&mut self, path: &str) -> Result<()> { fs::create_dir(path).await.map_err(err) }
    async fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        // Platform-exclusive rename avoids a check-then-overwrite race on macOS.
        let from = from.to_owned(); let to = to.to_owned();
        tokio::task::spawn_blocking(move || rename_exclusive(&from, &to)).await.map_err(err)?
    }
    async fn delete(&mut self, path: &str, is_dir: bool) -> Result<()> {
        if is_dir { fs::remove_dir(path).await.map_err(err) } else { fs::remove_file(path).await.map_err(err) }
    }
    async fn read(&mut self, path: &str) -> Result<Reader> { Ok(Reader::Local(fs::File::open(path).await.map_err(err)?)) }
    async fn write(&mut self, path: &str) -> Result<Writer> { Ok(Writer::Local(fs::OpenOptions::new().write(true).create_new(true).open(path).await.map_err(err)?)) }
}

#[cfg(target_os = "macos")]
fn rename_exclusive(from: &str, to: &str) -> Result<()> {
    use std::ffi::CString;
    extern "C" { fn renamex_np(from: *const std::ffi::c_char, to: *const std::ffi::c_char, flags: u32) -> i32; }
    let a = CString::new(from).map_err(err)?; let b = CString::new(to).map_err(err)?;
    // RENAME_EXCL, from <stdio.h>. Fails if destination already exists.
    if unsafe { renamex_np(a.as_ptr(), b.as_ptr(), 4) } == 0 { Ok(()) } else { Err(err(std::io::Error::last_os_error())) }
}
#[cfg(target_os = "windows")]
fn rename_exclusive(from: &str, to: &str) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" { fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32; }
    let a: Vec<u16> = std::ffi::OsStr::new(from).encode_wide().chain(Some(0)).collect();
    let b: Vec<u16> = std::ffi::OsStr::new(to).encode_wide().chain(Some(0)).collect();
    // Deliberately omit MOVEFILE_REPLACE_EXISTING (std::fs::rename uses it).
    if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 0) } != 0 { Ok(()) } else { Err(err(std::io::Error::last_os_error())) }
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn rename_exclusive(_: &str, _: &str) -> Result<()> { Err("当前版本仅支持 macOS 和 Windows".into()) }

pub struct SmbFileSystem { client: SmbClient, tree: Tree }
impl SmbFileSystem {
    pub async fn connect(server: &Server, password: String) -> Result<Self> {
        server.validate()?;
        let mut client = Self::connect_client(server, password).await?;
        let tree = client.connect_share(&server.share).await.map_err(err)?;
        Ok(Self { client, tree })
    }
    pub async fn list_shares(server: &Server, password: String) -> Result<Vec<String>> {
        let mut client = Self::connect_client(server, password).await?;
        let mut names: Vec<String> = client.list_shares().await.map_err(err)?.into_iter()
            .map(|share| share.name).filter(|name| validate_name(name).is_ok()).collect();
        names.sort();
        names.dedup();
        Ok(names)
    }
    async fn connect_client(server: &Server, password: String) -> Result<SmbClient> {
        server.validate_endpoint()?;
        let host = server.host.trim_matches(['[', ']']);
        let addr = if host.contains(':') { format!("[{host}]:{}", server.port) } else { format!("{host}:{}", server.port) };
        let config = ClientConfig { addr, username: server.username.clone(), password, domain: server.domain.clone(), timeout: Duration::from_secs(20), auto_reconnect: true, compression: false, dfs_enabled: false, dfs_target_overrides: HashMap::new() };
        let mut client = SmbClient::connect(config).await.map_err(connect_err)?;
        client.connection_mut().set_response_timeout(Some(Duration::from_secs(30)));
        client.connection_mut().set_send_timeout(Some(Duration::from_secs(30)));
        client.connection_mut().set_write_budget(4 * CHUNK as u64);
        Ok(client)
    }
}
fn connect_err(e: impl std::fmt::Display) -> String {
    let message = e.to_string();
    if message.contains("STATUS_REQUEST_NOT_ACCEPTED") {
        format!("{message}（服务器暂时拒绝新的 SMB 会话；请稍后重试，并检查 NAS 的连接数限制）")
    } else { message }
}

/// Serializes metadata operations while readers and writers keep using the same SMB session.
/// Reusing one authenticated session per saved server avoids exhausting NAS session limits.
pub struct SharedSmbFileSystem {
    inner: Arc<tokio::sync::Mutex<SmbFileSystem>>,
}
impl SharedSmbFileSystem {
    pub fn new(inner: Arc<tokio::sync::Mutex<SmbFileSystem>>) -> Self { Self { inner } }
}
fn remote(path: &str) -> Result<String> {
    if path.contains('\0') || path.split(['/', '\\']).any(|s| s == "..") { return Err("无效的 SMB 路径".into()); }
    // smb2::name::encode_path expects forward slashes as separators and turns
    // literal backslashes into private-use filename characters. Keep the
    // hierarchy in slash form and let the crate perform the wire conversion.
    Ok(path.trim_start_matches(['/', '\\']).replace('\\', "/"))
}
#[async_trait]
impl FileSystemProvider for SmbFileSystem {
    async fn list(&mut self, path: &str) -> Result<Vec<Entry>> {
        self.client.list_directory(&mut self.tree, &remote(path)?).await.map_err(err)?.into_iter().filter(|e| e.name != "." && e.name != "..").map(|e| {
            validate_name(&e.name)?;
            Ok(Entry { name: e.name, is_dir: e.is_directory, size: e.size, modified: timestamp(e.modified.to_system_time()), is_link: false })
        }).collect()
    }
    async fn stat(&mut self, path: &str) -> Result<Option<Entry>> {
        if path.trim_matches('/').is_empty() { return Ok(Some(Entry { name: "/".into(), is_dir: true, size: 0, modified: None, is_link: false })); }
        match self.client.stat(&mut self.tree, &remote(path)?).await {
            Ok(e) => Ok(Some(Entry { name: path.rsplit('/').next().unwrap_or(path).into(), is_dir: e.is_directory, size: e.size, modified: timestamp(e.modified.to_system_time()), is_link: false })),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None), Err(e) => Err(err(e)),
        }
    }
    async fn mkdir(&mut self, path: &str) -> Result<()> { self.client.create_directory(&mut self.tree, &remote(path)?).await.map_err(err) }
    async fn rename(&mut self, from: &str, to: &str) -> Result<()> { self.client.rename(&mut self.tree, &remote(from)?, &remote(to)?).await.map_err(err) }
    async fn delete(&mut self, path: &str, is_dir: bool) -> Result<()> {
        if is_dir { self.client.delete_directory(&mut self.tree, &remote(path)?).await.map_err(err) }
        else { self.client.delete_file(&mut self.tree, &remote(path)?).await.map_err(err) }
    }
    async fn read(&mut self, path: &str) -> Result<Reader> { self.client.open_file_reader(&self.tree, &remote(path)?).await.map(Reader::Smb).map_err(err) }
    async fn write(&mut self, path: &str) -> Result<Writer> { self.client.create_file_writer_exclusive(&self.tree, &remote(path)?).await.map(Writer::Smb).map_err(err) }
}

#[async_trait]
impl FileSystemProvider for SharedSmbFileSystem {
    async fn list(&mut self, path: &str) -> Result<Vec<Entry>> { self.inner.lock().await.list(path).await }
    async fn stat(&mut self, path: &str) -> Result<Option<Entry>> { self.inner.lock().await.stat(path).await }
    async fn mkdir(&mut self, path: &str) -> Result<()> { self.inner.lock().await.mkdir(path).await }
    async fn rename(&mut self, from: &str, to: &str) -> Result<()> { self.inner.lock().await.rename(from, to).await }
    async fn delete(&mut self, path: &str, is_dir: bool) -> Result<()> { self.inner.lock().await.delete(path, is_dir).await }
    async fn read(&mut self, path: &str) -> Result<Reader> { self.inner.lock().await.read(path).await }
    async fn write(&mut self, path: &str) -> Result<Writer> { self.inner.lock().await.write(path).await }
}

/// Iterative post-order deletion: no recursion overflow and no following local symlinks.
pub async fn delete_tree(provider: &mut dyn FileSystemProvider, location: &Location) -> Result<()> {
    let mut stack = vec![(location.clone(), false)];
    let mut count = 0usize;
    while let Some((loc, visited)) = stack.pop() {
        count += 1;
        if count + stack.len() > 400_000 { return Err("删除遍历超出限制，请分批操作并检查共享是否含循环链接".into()); }
        let entry = provider.stat(&loc.path).await?.ok_or("文件已不存在")?;
        if entry.is_dir && !visited {
            stack.push((loc.clone(), true));
            for child in provider.list(&loc.path).await? { stack.push((loc.child(&child.name)?, false)); }
        } else { provider.delete(&loc.path, entry.is_dir).await?; }
    } Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_path_keeps_nested_components_for_smb_encoder() {
        let path = remote("/一级/二级/三级").unwrap();
        assert_eq!(path, "一级/二级/三级");
        assert_eq!(smb2::name::encode_path(&path), "一级\\二级\\三级");
        assert_eq!(remote("\\一级\\二级").unwrap(), "一级/二级");
    }
}
