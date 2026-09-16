use serde::{Deserialize, Serialize};
use std::path::Path;

pub type Result<T> = std::result::Result<T, String>;
pub fn err(e: impl std::fmt::Display) -> String { e.to_string() }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Location { pub connection: Option<String>, pub path: String }
impl Location {
    pub fn child(&self, name: &str) -> Result<Self> {
        validate_name(name)?;
        let path = if self.connection.is_some() {
            format!("{}/{}", self.path.trim_end_matches('/'), name)
        } else { Path::new(&self.path).join(name).to_string_lossy().into_owned() };
        Ok(Self { connection: self.connection.clone(), path })
    }
}
pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name == "." || name == ".." || name.chars().any(|c| c < ' ' || "/\\:*?\"<>|".contains(c)) || name.ends_with(['.', ' ']) {
        return Err("名称为空或含有不支持的字符".into());
    }
    let base = name.split('.').next().unwrap_or("").to_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&base.as_str()) || (base.len() == 4 && (base.starts_with("COM") || base.starts_with("LPT")) && matches!(base.as_bytes()[3], b'1'..=b'9')) {
        return Err("此名称是 Windows 保留名称".into());
    }
    Ok(())
}
pub fn normalize_server_label(label: &str) -> Result<String> {
    let label = label.trim();
    if label.is_empty() || label.chars().count() > 80 || label.chars().any(char::is_control) {
        return Err("显示名称应为 1–80 个字符且不能包含控制字符".into());
    }
    Ok(label.to_owned())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry { pub name: String, pub is_dir: bool, pub size: u64, pub modified: Option<u64>, pub is_link: bool }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server { pub id: String, pub label: String, pub host: String, pub port: u16, pub share: String, pub username: String, pub domain: String, pub remember: bool }
impl Server {
    pub fn validate_endpoint(&self) -> Result<()> {
        if self.host.is_empty() || self.host.chars().any(|c| c.is_whitespace() || "/\\@\0".contains(c)) || self.port == 0 { return Err("服务器地址或端口无效".into()); }
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        self.validate_endpoint()?;
        validate_name(&self.share)
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Favorite { pub id: String, pub label: String, pub location: Location }
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Settings { pub servers: Vec<Server>, pub favorites: Vec<Favorite> }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_traversal_and_reserved_names() {
        for name in ["", "..", "../x", "a/b", "a\\b", "a\0b", "NUL.txt", "COM1", "x."] { assert!(validate_name(name).is_err(), "{name}"); }
        assert!(validate_name("项目 2026.txt").is_ok());
    }
    #[test] fn remote_child_stays_beneath_parent() {
        let root = Location { connection: Some("nas".into()), path: "/".into() };
        assert_eq!(root.child("项目").unwrap().path, "/项目");
        assert!(root.child("../other").is_err());
    }
    #[test] fn normalizes_server_labels() {
        assert_eq!(normalize_server_label("  家庭 NAS  ").unwrap(), "家庭 NAS");
        assert!(normalize_server_label("   ").is_err());
        assert!(normalize_server_label("NAS\n名称").is_err());
        assert!(normalize_server_label(&"a".repeat(81)).is_err());
    }
}
