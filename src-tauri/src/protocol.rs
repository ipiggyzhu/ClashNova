use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingImport {
    id: u64,
    #[serde(skip)]
    url: String,
    name: Option<String>,
    host: String,
    importing: bool,
    #[serde(skip)]
    source: String,
}

#[derive(Default)]
struct Queue {
    sequence: u64,
    items: Vec<PendingImport>,
}

#[derive(Default)]
pub struct PendingImports(Mutex<Queue>);

impl Queue {
    fn push(&mut self, value: &str) -> Result<(), String> {
        if value.len() > 16 * 1024 {
            return Err("订阅协议链接过长".into());
        }
        let source = crate::profiles::resolve_import_url(value)?;
        if self.items.iter().any(|item| item.source == source.url) {
            return Ok(());
        }
        if self.items.len() >= 8 {
            return Err("待确认订阅已达 8 项，请先处理已有请求".into());
        }
        let host = reqwest::Url::parse(&source.url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .ok_or("订阅下载地址缺少主机名")?;
        self.sequence += 1;
        self.items.push(PendingImport {
            id: self.sequence, url: value.to_string(), name: source.name,
            host, source: source.url, importing: false,
        });
        Ok(())
    }

    fn begin_import(&mut self, id: u64) -> Result<String, String> {
        let item = self.items.iter_mut().find(|item| item.id == id).ok_or("订阅请求已处理")?;
        if item.importing { return Err("订阅正在导入，请等待完成".into()); }
        item.importing = true;
        Ok(item.url.clone())
    }

    fn finish_import(&mut self, id: u64, success: bool) {
        if success { self.items.retain(|item| item.id != id); }
        else if let Some(item) = self.items.iter_mut().find(|item| item.id == id) { item.importing = false; }
    }
}

/// 外部协议只入队，不下载、不执行增强脚本，等待窗口中的显式确认。
pub fn enqueue_args(app: &AppHandle, args: &[String]) {
    let state = app.state::<PendingImports>();
    let Ok(mut queue) = state.0.lock() else { return };
    for arg in args {
        if !arg.split_once(':').is_some_and(|(scheme, _)| {
            ["clash", "clash-verge", "clashnova"].iter().any(|value| scheme.eq_ignore_ascii_case(value))
        }) { continue; }
        if let Err(error) = queue.push(arg) {
            // 错误只包含固定文本，不将带凭据的链接写入日志。
            log::warn!("接收订阅协议失败: {error}");
        }
    }
    drop(queue);
    let _ = app.emit("profile-imports-changed", ());
}

#[tauri::command]
pub fn pending_profile_imports(app: AppHandle) -> Result<Vec<PendingImport>, String> {
    app.state::<PendingImports>().0.lock().map(|queue| queue.items.clone())
        .map_err(|_| "订阅队列锁中毒".into())
}

#[tauri::command]
pub fn dismiss_profile_import(app: AppHandle, id: u64) -> Result<(), String> {
    let state = app.state::<PendingImports>();
    let mut queue = state.0.lock().map_err(|_| "订阅队列锁中毒")?;
    if queue.items.iter().any(|item| item.id == id && item.importing) {
        return Err("正在导入的请求请等待完成".into());
    }
    queue.items.retain(|item| item.id != id);
    drop(queue);
    let _ = app.emit("profile-imports-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn confirm_profile_import(app: AppHandle, id: u64) -> Result<crate::profiles::ProfileMeta, String> {
    let state = app.state::<PendingImports>();
    let url = state.0.lock().map_err(|_| "订阅队列锁中毒")?.begin_import(id)?;
    let _ = app.emit("profile-imports-changed", ());
    let result = crate::profiles::import(&app, url, None).await;
    state.0.lock().map_err(|_| "订阅队列锁中毒")?.finish_import(id, result.is_ok());
    let _ = app.emit("profile-imports-changed", ());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deduplicates_pending_links_without_exposing_credentials_in_host() {
        let mut queue = Queue::default();
        queue.push("clashnova://install-config?url=https%3A%2F%2Fuser%3Afake%40example.invalid%2Fsub%3Ftoken%3Dfixture&name=Fixture").unwrap();
        queue.push("clash://install-config?url=https%3A%2F%2Fuser%3Afake%40example.invalid%2Fsub%3Ftoken%3Dfixture").unwrap();
        assert_eq!(queue.items.len(), 1);
        assert_eq!(queue.items[0].host, "example.invalid");
        assert_eq!(queue.items[0].name.as_deref(), Some("Fixture"));
        assert!(serde_json::to_value(&queue.items[0]).unwrap().get("source").is_none());
        assert!(serde_json::to_value(&queue.items[0]).unwrap().get("url").is_none());
    }

    #[test]
    fn bounds_and_rejects_invalid_imports() {
        let mut queue = Queue::default();
        assert!(queue.push("clashnova://install-config?url=file:///test").is_err());
        assert!(queue.push(&"x".repeat(16 * 1024 + 1)).is_err());
        for id in 0..8 { queue.push(&format!("clash://install-config?url=https://example.invalid/{id}")).unwrap(); }
        assert!(queue.push("clash://install-config?url=https://example.invalid/9").is_err());
        assert_eq!(queue.items.len(), 8);
    }

    #[test]
    fn import_is_single_flight_and_success_cannot_be_replayed() {
        let mut queue = Queue::default();
        queue.push("clash://install-config?url=https://example.invalid/sub").unwrap();
        let id = queue.items[0].id;
        assert!(queue.begin_import(id).is_ok());
        assert!(queue.begin_import(id).is_err());
        queue.finish_import(id, false);
        assert!(queue.begin_import(id).is_ok());
        queue.finish_import(id, true);
        assert!(queue.begin_import(id).is_err());
        assert!(queue.items.is_empty());
    }
}
