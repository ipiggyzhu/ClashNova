//! 流量统计:轮询 mihomo /connections 差分增量,按 代理/进程/域名 三维度
//! 分钟桶聚合,落地 SQLite(stats.db);供流量统计页与仪表盘查询。

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::state::{now_millis, AppState};

const POLL_INTERVAL: Duration = Duration::from_secs(2);

/* ---------------- 数据模型 ---------------- */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesPoint {
    pub ts: u64,
    pub up: u64,
    pub down: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankRow {
    pub key: String,
    pub up: u64,
    pub down: u64,
}

#[derive(Debug, Deserialize)]
struct ConnsPayload {
    #[serde(default)]
    connections: Option<Vec<ConnEntry>>,
}

#[derive(Debug, Deserialize)]
struct ConnEntry {
    id: String,
    upload: u64,
    download: u64,
    #[serde(default)]
    chains: Vec<String>,
    metadata: ConnMeta,
}

#[derive(Debug, Deserialize)]
struct ConnMeta {
    #[serde(default)]
    host: String,
    #[serde(default, rename = "destinationIP")]
    destination_ip: String,
    #[serde(default)]
    process: String,
}

/* ---------------- SQLite ---------------- */

fn db_path(app: &AppHandle) -> PathBuf {
    app.state::<AppState>().dirs.config.join("stats.db")
}

fn open_db(path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("打开 stats.db 失败: {e}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS traffic_minute(
           ts   INTEGER NOT NULL,
           dim  TEXT    NOT NULL,
           key  TEXT    NOT NULL,
           up   INTEGER NOT NULL,
           down INTEGER NOT NULL,
           PRIMARY KEY (ts, dim, key)
         );
         CREATE INDEX IF NOT EXISTS idx_dim_ts ON traffic_minute(dim, ts);",
    )
    .map_err(|e| format!("初始化 stats.db 失败: {e}"))?;
    Ok(conn)
}

/* ---------------- 采集器 ---------------- */

/// setup 时启动:常驻轮询任务(内核不可达时静默跳过该轮)。
pub fn spawn_collector(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let db = db_path(&app);
        // Connection 非 Send 不能跨 await 持有: 这里仅建表校验, 落库时按需重开
        if let Err(e) = open_db(&db) {
            log::error!("{e}; 流量统计不可用");
            return;
        }
        let client = reqwest::Client::new();
        // 连接 id → 上次累计(up, down)
        let mut prev: HashMap<String, (u64, u64)> = HashMap::new();
        // 当前分钟桶: (dim, key) → 增量(up, down)
        let mut bucket: HashMap<(String, String), (u64, u64)> = HashMap::new();
        let mut bucket_ts = now_millis() / 60_000 * 60;

        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let (controller, secret) = {
                let s = app.state::<AppState>().settings_snapshot();
                (s.external_controller, s.secret)
            };
            let resp = client
                .get(format!("http://{controller}/connections"))
                .bearer_auth(&secret)
                .timeout(Duration::from_secs(3))
                .send()
                .await;
            let Ok(resp) = resp else { continue };
            let Ok(payload) = resp.json::<ConnsPayload>().await else { continue };
            let conns = payload.connections.unwrap_or_default();

            let mut seen: HashMap<String, (u64, u64)> = HashMap::with_capacity(conns.len());
            for c in &conns {
                seen.insert(c.id.clone(), (c.upload, c.download));
                // 首见连接只记基线不计量, 避免把启动前流量整段计入
                let Some(&(pu, pd)) = prev.get(&c.id) else { continue };
                let du = c.upload.saturating_sub(pu);
                let dd = c.download.saturating_sub(pd);
                if du == 0 && dd == 0 {
                    continue;
                }
                let proxy = c.chains.first().cloned().unwrap_or_else(|| "DIRECT".into());
                let process = if c.metadata.process.is_empty() {
                    "未知进程".into()
                } else {
                    c.metadata.process.clone()
                };
                let host = if c.metadata.host.is_empty() {
                    c.metadata.destination_ip.clone()
                } else {
                    c.metadata.host.clone()
                };
                for (dim, key) in [
                    ("total", String::new()),
                    ("proxy", proxy),
                    ("process", process),
                    ("host", host),
                ] {
                    let slot = bucket.entry((dim.into(), key)).or_insert((0, 0));
                    slot.0 += du;
                    slot.1 += dd;
                }
            }
            prev = seen;

            // 分钟翻转 → 落库
            let now_min = now_millis() / 60_000 * 60;
            if now_min != bucket_ts && !bucket.is_empty() {
                if let Err(e) = flush(&db, bucket_ts, &bucket) {
                    log::warn!("流量统计落库失败: {e}");
                }
                bucket.clear();
            }
            bucket_ts = now_min;
        }
    });
}

fn flush(
    db: &PathBuf,
    ts: u64,
    bucket: &HashMap<(String, String), (u64, u64)>,
) -> Result<(), String> {
    let conn = open_db(db)?;
    let mut stmt = conn
        .prepare(
            "INSERT INTO traffic_minute(ts, dim, key, up, down) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(ts, dim, key) DO UPDATE SET up = up + ?4, down = down + ?5",
        )
        .map_err(|e| e.to_string())?;
    for ((dim, key), (up, down)) in bucket {
        stmt.execute(rusqlite::params![ts, dim, key, up, down])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* ---------------- 查询 ---------------- */

fn range_params(range: &str) -> (u64, u64) {
    // (回看秒数, 聚合桶秒数)
    match range {
        "day" => (86_400, 3_600),
        "30d" => (2_592_000, 86_400),
        _ => (604_800, 86_400), // 7d 默认
    }
}

/// 总量时间序列(按小时/天聚合)。
pub fn query_series(app: &AppHandle, range: &str) -> Result<Vec<SeriesPoint>, String> {
    let (lookback, step) = range_params(range);
    let since = (now_millis() / 1000).saturating_sub(lookback);
    let conn = open_db(&db_path(app))?;
    let mut stmt = conn
        .prepare(
            "SELECT ts / ?1 * ?1 AS bucket, SUM(up), SUM(down)
             FROM traffic_minute WHERE dim = 'total' AND ts >= ?2
             GROUP BY bucket ORDER BY bucket",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![step, since], |r| {
            Ok(SeriesPoint {
                ts: r.get::<_, u64>(0)? * 1000,
                up: r.get(1)?,
                down: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// 指定维度 TopN 排行。
pub fn query_rank(app: &AppHandle, dim: &str, range: &str) -> Result<Vec<RankRow>, String> {
    if !matches!(dim, "proxy" | "process" | "host") {
        return Err(format!("非法维度: {dim}"));
    }
    let (lookback, _) = range_params(range);
    let since = (now_millis() / 1000).saturating_sub(lookback);
    let conn = open_db(&db_path(app))?;
    let mut stmt = conn
        .prepare(
            "SELECT key, SUM(up), SUM(down) FROM traffic_minute
             WHERE dim = ?1 AND ts >= ?2
             GROUP BY key ORDER BY SUM(up) + SUM(down) DESC LIMIT 10",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![dim, since], |r| {
            Ok(RankRow {
                key: r.get(0)?,
                up: r.get(1)?,
                down: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}
