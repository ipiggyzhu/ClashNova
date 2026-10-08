//! 全局计数器负责总量, 连接快照只用于归因; 短连接余量明确标记为未归因。
use crate::state::{now_millis, AppState};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const FLUSH_INTERVAL: Duration = Duration::from_secs(10);
const UNATTRIBUTED: &str = "未归因";
static FLUSH_LOCK: Mutex<()> = Mutex::new(());
type BucketKey = (u64, String, String);
type Buckets = HashMap<BucketKey, (u64, u64)>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesPoint {
    pub ts: u64,
    pub up: u64,
    pub down: u64,
}
#[derive(Debug, Serialize)]
pub struct RankRow {
    pub key: String,
    pub up: u64,
    pub down: u64,
}
#[derive(Debug, Serialize)]
pub struct TrafficSummary {
    pub up: u64,
    pub down: u64,
    pub direct: u64,
    pub proxy: u64,
    pub unattributed: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnsPayload {
    upload_total: u64,
    download_total: u64,
    #[serde(default, deserialize_with = "deserialize_connections")]
    connections: Vec<ConnEntry>,
}

fn deserialize_connections<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<ConnEntry>, D::Error> {
    Ok(Option::<Vec<ConnEntry>>::deserialize(deserializer)?.unwrap_or_default())
}
#[derive(Debug, Deserialize)]
struct ConnEntry {
    id: String,
    upload: u64,
    download: u64,
    #[serde(default)]
    chains: Vec<String>,
    #[serde(default)]
    metadata: ConnMeta,
}
#[derive(Debug, Default, Deserialize)]
struct ConnMeta {
    #[serde(default)]
    host: String,
    #[serde(default, rename = "destinationIP")]
    destination_ip: String,
    #[serde(default)]
    process: String,
}

#[derive(Default)]
pub struct Accumulator {
    previous_totals: Option<(u64, u64)>,
    previous: HashMap<String, (u64, u64)>,
    pending: Buckets,
    controller: String,
}

impl Accumulator {
    fn add(&mut self, ts: u64, dim: &str, key: String, up: u64, down: u64) {
        if up == 0 && down == 0 {
            return;
        }
        let bucket = self.pending.entry((ts, dim.into(), key)).or_default();
        bucket.0 = bucket.0.saturating_add(up);
        bucket.1 = bucket.1.saturating_add(down);
    }

    fn observe(&mut self, payload: ConnsPayload, now: u64) {
        let totals = (payload.upload_total, payload.download_total);
        let previous = self.previous_totals.replace(totals);
        let seen = payload
            .connections
            .iter()
            .map(|conn| (conn.id.clone(), (conn.upload, conn.download)))
            .collect();
        let Some((previous_up, previous_down)) = previous else {
            // 仅采集器第一次连接记基线, 后续新连接的首段流量应计入。
            self.previous = seen;
            return;
        };
        let reset = totals.0 < previous_up || totals.1 < previous_down;
        let (up, down) = if reset {
            totals
        } else {
            (totals.0 - previous_up, totals.1 - previous_down)
        };
        if reset {
            self.previous.clear();
        }
        let ts = now / 60_000 * 60;
        self.add(ts, "total", String::new(), up, down);
        let (mut remaining_up, mut remaining_down) = (up, down);
        for conn in payload.connections {
            let (pu, pd) = self.previous.get(&conn.id).copied().unwrap_or_default();
            // 同一 JSON 快照的计数器可能在取样期间变化, 归因量不得超过总增量。
            let du = conn.upload.saturating_sub(pu).min(remaining_up);
            let dd = conn.download.saturating_sub(pd).min(remaining_down);
            remaining_up -= du;
            remaining_down -= dd;
            let proxy = conn
                .chains
                .first()
                .filter(|name| !name.is_empty())
                .cloned()
                .unwrap_or_else(|| UNATTRIBUTED.into());
            let process = if conn.metadata.process.is_empty() {
                "未知进程".into()
            } else {
                conn.metadata.process
            };
            let host = if conn.metadata.host.is_empty() {
                conn.metadata.destination_ip
            } else {
                conn.metadata.host
            };
            for (dim, key) in [("proxy", proxy), ("process", process), ("host", host)] {
                self.add(ts, dim, key, du, dd);
            }
        }
        for dim in ["proxy", "process", "host"] {
            self.add(ts, dim, UNATTRIBUTED.into(), remaining_up, remaining_down);
        }
        self.previous = seen;
    }
}

fn db_path(app: &AppHandle) -> PathBuf {
    app.state::<AppState>().dirs.config.join("stats.db")
}

fn open_db(path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("打开统计数据库失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS traffic_minute(
             ts INTEGER NOT NULL, dim TEXT NOT NULL, key TEXT NOT NULL,
             up INTEGER NOT NULL, down INTEGER NOT NULL, PRIMARY KEY(ts, dim, key));
         CREATE INDEX IF NOT EXISTS idx_dim_ts ON traffic_minute(dim, ts);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn spawn_collector(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        let mut last_flush = Instant::now();
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let settings = app.state::<AppState>().settings_snapshot();
            let response = client
                .get(format!(
                    "http://{}/connections",
                    settings.external_controller
                ))
                .bearer_auth(&settings.secret)
                .timeout(Duration::from_secs(3))
                .send()
                .await;
            if let Ok(response) = response {
                if response.status().is_success() {
                    if let Ok(payload) = response.json::<ConnsPayload>().await {
                        let state = app.state::<AppState>();
                        if let Ok(mut accumulator) = state.stats.lock() {
                            if accumulator.controller != settings.external_controller {
                                accumulator.previous_totals = None;
                                accumulator.previous.clear();
                                accumulator.controller = settings.external_controller;
                            }
                            accumulator.observe(payload, now_millis());
                        };
                    }
                }
            }
            // 内核暂时不可达也要尝试持久化之前采集的流量。
            if last_flush.elapsed() >= FLUSH_INTERVAL {
                let worker = app.clone();
                match tauri::async_runtime::spawn_blocking(move || flush_pending(&worker)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(err)) => log::warn!("统计落库失败, 已保留待写数据: {err}"),
                    Err(err) => log::warn!("统计落库任务失败: {err}"),
                }
                last_flush = Instant::now();
            }
        }
    });
}

fn flush_pending(app: &AppHandle) -> Result<(), String> {
    let _writer = FLUSH_LOCK.lock().map_err(|_| "统计写入锁中毒")?;
    let state = app.state::<AppState>();
    let pending = {
        let mut accumulator = state.stats.lock().map_err(|_| "统计缓存锁中毒")?;
        std::mem::take(&mut accumulator.pending)
    };
    if pending.is_empty() {
        return Ok(());
    }
    let retention = state.settings_snapshot().stats_retention_days;
    match flush(&db_path(app), &pending, retention) {
        Ok(()) => {
            let _ = app.emit("traffic-updated", ());
            Ok(())
        }
        Err(err) => {
            let mut accumulator = state.stats.lock().map_err(|_| "统计缓存锁中毒")?;
            for (key, value) in pending {
                let current = accumulator.pending.entry(key).or_default();
                current.0 = current.0.saturating_add(value.0);
                current.1 = current.1.saturating_add(value.1);
            }
            Err(err)
        }
    }
}

pub fn flush_on_exit(app: &AppHandle) {
    if let Err(err) = flush_pending(app) {
        log::error!("退出时保存统计失败: {err}");
    }
}

fn flush(db: &PathBuf, buckets: &Buckets, retention_days: u32) -> Result<(), String> {
    let mut conn = open_db(db)?;
    flush_into(&mut conn, buckets, retention_days, now_millis() / 1000)
}

fn flush_into(
    conn: &mut Connection,
    buckets: &Buckets,
    retention_days: u32,
    now: u64,
) -> Result<(), String> {
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = transaction
            .prepare(
                "INSERT INTO traffic_minute(ts, dim, key, up, down) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(ts, dim, key) DO UPDATE SET up = up + ?4, down = down + ?5",
            )
            .map_err(|e| e.to_string())?;
        for ((ts, dim, key), (up, down)) in buckets {
            stmt.execute(rusqlite::params![ts, dim, key, up, down])
                .map_err(|e| e.to_string())?;
        }
    }
    // 默认无限保留; 只有用户明确设置期限后才清理历史数据。
    if retention_days > 0 {
        let cutoff = now.saturating_sub(u64::from(retention_days) * 86_400);
        transaction
            .execute("DELETE FROM traffic_minute WHERE ts < ?1", [cutoff])
            .map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())
}

fn range_params(conn: &Connection, range: &str) -> Result<(u64, u64), String> {
    range_params_at(conn, range, now_millis() / 1000)
}

fn range_params_at(conn: &Connection, range: &str, now: u64) -> Result<(u64, u64), String> {
    let (offset, step) = match range {
        "day" => ("-0 days", 3600),
        "7d" => ("-6 days", 86_400),
        "30d" => ("-29 days", 86_400),
        _ => return Err("非法统计时间范围".into()),
    };
    let start = conn.query_row(
        "SELECT CAST(strftime('%s', ?1, 'unixepoch', 'localtime', 'start of day', ?2, 'utc') AS INTEGER)",
        rusqlite::params![now, offset], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    Ok((start, step))
}

pub fn query_series(app: &AppHandle, range: &str) -> Result<Vec<SeriesPoint>, String> {
    let conn = open_db(&db_path(app))?;
    let (since, step) = range_params(&conn, range)?;
    series_since(&conn, since, step)
}

fn series_since(conn: &Connection, since: u64, step: u64) -> Result<Vec<SeriesPoint>, String> {
    // 日桶按当地日历边界聚合; 小时桶以当地零点为基准, 而非 UTC 整点。
    let mut stmt = conn.prepare(
        "SELECT CASE WHEN ?1 = 86400
             THEN CAST(strftime('%s', ts, 'unixepoch', 'localtime', 'start of day', 'utc') AS INTEGER)
             ELSE (ts - ?2) / ?1 * ?1 + ?2 END AS bucket,
           SUM(up), SUM(down) FROM traffic_minute
         WHERE dim = 'total' AND ts >= ?2 GROUP BY bucket ORDER BY bucket"
    ).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![step, since], |row| {
            Ok(SeriesPoint {
                ts: row.get::<_, u64>(0)? * 1000,
                up: row.get(1)?,
                down: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn query_rank(app: &AppHandle, dim: &str, range: &str) -> Result<Vec<RankRow>, String> {
    let conn = open_db(&db_path(app))?;
    let (since, _) = range_params(&conn, range)?;
    rank_since(&conn, dim, since)
}

fn rank_since(conn: &Connection, dim: &str, since: u64) -> Result<Vec<RankRow>, String> {
    if !matches!(dim, "proxy" | "process" | "host") {
        return Err("非法统计维度".into());
    }
    let mut stmt = conn
        .prepare(
            "SELECT key, SUM(up), SUM(down) FROM traffic_minute WHERE dim = ?1 AND ts >= ?2
         GROUP BY key ORDER BY SUM(up) + SUM(down) DESC LIMIT 10",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![dim, since], |row| {
            Ok(RankRow {
                key: row.get(0)?,
                up: row.get(1)?,
                down: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn query_summary(app: &AppHandle, range: &str) -> Result<TrafficSummary, String> {
    let conn = open_db(&db_path(app))?;
    let (since, _) = range_params(&conn, range)?;
    summary_since(&conn, since)
}

fn summary_since(conn: &Connection, since: u64) -> Result<TrafficSummary, String> {
    conn.query_row(
        "SELECT
           COALESCE(SUM(CASE WHEN dim = 'total' THEN up ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN dim = 'total' THEN down ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN dim = 'proxy' AND key = 'DIRECT' THEN up + down ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN dim = 'proxy' AND key NOT IN ('DIRECT', ?2) THEN up + down ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN dim = 'proxy' AND key = ?2 THEN up + down ELSE 0 END), 0)
         FROM traffic_minute WHERE ts >= ?1",
        rusqlite::params![since, UNATTRIBUTED], |row| Ok(TrafficSummary {
            up: row.get(0)?, down: row.get(1)?, direct: row.get(2)?, proxy: row.get(3)?, unattributed: row.get(4)?,
        }),
    ).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(up: u64, down: u64, connections: Vec<ConnEntry>) -> ConnsPayload {
        ConnsPayload {
            upload_total: up,
            download_total: down,
            connections,
        }
    }
    #[test]
    fn short_connections_are_in_totals_and_unattributed() {
        let mut acc = Accumulator::default();
        acc.observe(sample(100, 100, vec![]), 60_000);
        acc.observe(sample(150, 300, vec![]), 62_000);
        assert_eq!(
            acc.pending.get(&(60, "total".into(), String::new())),
            Some(&(50, 200))
        );
        assert_eq!(
            acc.pending.get(&(60, "proxy".into(), UNATTRIBUTED.into())),
            Some(&(50, 200))
        );
    }
    #[test]
    fn new_connection_first_bytes_are_attributed() {
        let mut acc = Accumulator::default();
        acc.observe(sample(0, 0, vec![]), 60_000);
        acc.observe(
            sample(
                40,
                80,
                vec![ConnEntry {
                    id: "new".into(),
                    upload: 40,
                    download: 80,
                    chains: vec!["DIRECT".into()],
                    metadata: ConnMeta::default(),
                }],
            ),
            62_000,
        );
        assert_eq!(
            acc.pending.get(&(60, "proxy".into(), "DIRECT".into())),
            Some(&(40, 80))
        );
    }
    #[test]
    fn counter_reset_does_not_underflow() {
        let mut acc = Accumulator::default();
        acc.observe(sample(100, 200, vec![]), 60_000);
        acc.observe(sample(3, 5, vec![]), 62_000);
        assert_eq!(
            acc.pending.get(&(60, "total".into(), String::new())),
            Some(&(3, 5))
        );
    }

    #[test]
    fn idle_snapshot_accepts_null_connections() {
        let payload: ConnsPayload =
            serde_json::from_str(r#"{"uploadTotal":1,"downloadTotal":2,"connections":null}"#)
                .unwrap();
        assert!(payload.connections.is_empty());
    }

    #[test]
    fn missing_chain_is_not_reported_as_direct() {
        let mut acc = Accumulator::default();
        acc.observe(sample(0, 0, vec![]), 60_000);
        acc.observe(
            sample(
                3,
                5,
                vec![ConnEntry {
                    id: "unknown".into(),
                    upload: 3,
                    download: 5,
                    chains: vec![],
                    metadata: ConnMeta::default(),
                }],
            ),
            62_000,
        );
        assert_eq!(
            acc.pending.get(&(60, "proxy".into(), UNATTRIBUTED.into())),
            Some(&(3, 5))
        );
        assert!(!acc
            .pending
            .contains_key(&(60, "proxy".into(), "DIRECT".into())));
    }

    #[test]
    fn summary_includes_direct_outside_the_top_ten() {
        let mut conn = open_db(&PathBuf::from(":memory:")).unwrap();
        let mut buckets = Buckets::new();
        buckets.insert((60, "total".into(), String::new()), (1000, 500));
        buckets.insert((60, "proxy".into(), "DIRECT".into()), (1, 2));
        buckets.insert((60, "proxy".into(), UNATTRIBUTED.into()), (4, 5));
        for i in 0..12 {
            buckets.insert((60, "proxy".into(), format!("proxy-{i}")), (100, 24));
        }
        flush_into(&mut conn, &buckets, 0, 100).unwrap();
        let rank = rank_since(&conn, "proxy", 0).unwrap();
        assert_eq!(rank.len(), 10);
        assert!(!rank.iter().any(|row| row.key == "DIRECT"));
        let summary = summary_since(&conn, 0).unwrap();
        assert_eq!((summary.up, summary.down), (1000, 500));
        assert_eq!(
            (summary.direct, summary.proxy, summary.unattributed),
            (3, 1488, 9)
        );
    }

    #[test]
    fn retention_is_disabled_by_default_and_applied_only_when_requested() {
        let mut conn = open_db(&PathBuf::from(":memory:")).unwrap();
        let now = 100 * 86_400;
        let buckets = Buckets::from([
            ((now - 31 * 86_400, "total".into(), String::new()), (1, 2)),
            ((now - 29 * 86_400, "total".into(), String::new()), (3, 4)),
        ]);
        flush_into(&mut conn, &buckets, 0, now).unwrap();
        assert_eq!(summary_since(&conn, 0).unwrap().up, 4);
        flush_into(&mut conn, &Buckets::new(), 30, now).unwrap();
        assert_eq!(summary_since(&conn, 0).unwrap().up, 3);
    }

    #[test]
    fn failed_batch_rolls_back_before_retry() {
        let mut conn = open_db(&PathBuf::from(":memory:")).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_test_row BEFORE INSERT ON traffic_minute
             WHEN NEW.key = 'reject' BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
        )
        .unwrap();
        let buckets = Buckets::from([
            ((60, "total".into(), String::new()), (10, 20)),
            ((60, "proxy".into(), "reject".into()), (10, 20)),
        ]);
        assert!(flush_into(&mut conn, &buckets, 0, 100).is_err());
        assert_eq!(summary_since(&conn, 0).unwrap().up, 0);
        conn.execute_batch("DROP TRIGGER reject_test_row").unwrap();
        flush_into(&mut conn, &buckets, 0, 100).unwrap();
        assert_eq!(summary_since(&conn, 0).unwrap().up, 10);
    }

    #[test]
    fn day_starts_at_local_midnight_and_buckets_are_local_hours() {
        let mut conn = open_db(&PathBuf::from(":memory:")).unwrap();
        let (since, step) = range_params_at(&conn, "day", 1_790_000_000).unwrap();
        let local_time: String = conn
            .query_row(
                "SELECT strftime('%H:%M:%S', ?1, 'unixepoch', 'localtime')",
                [since],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(local_time, "00:00:00");
        let buckets = Buckets::from([
            ((since - 60, "total".into(), String::new()), (100, 100)),
            ((since + 60, "total".into(), String::new()), (1, 2)),
            ((since + 3660, "total".into(), String::new()), (3, 4)),
        ]);
        flush_into(&mut conn, &buckets, 0, since + 7200).unwrap();
        let rows = series_since(&conn, since, step).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].ts, rows[0].up, rows[0].down), (since * 1000, 1, 2));
        assert_eq!(rows[1].ts, (since + 3600) * 1000);
        assert_eq!(summary_since(&conn, since).unwrap().up, 4);
    }
}
