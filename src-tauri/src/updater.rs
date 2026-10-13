//! Windows 应用与内核更新状态机。下载和安装分离，安装/切换只接受已检查的候选。
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::core_update::{self, CoreRelease, InstalledCore};
use crate::state::AppState;
use crate::update_io::{self, Asset, Cancellation, Release, Staging, APP_REPO, MAX_BINARY};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdate {
    pub version: String,
    pub build_id: String,
    pub asset_name: String,
    pub size: u64,
    pub sha256: String,
    pub same_version: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreUpdate {
    pub version: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    Downloading,
    Verifying,
    Ready,
    Installing,
    Switching,
    Failed,
    Cancelled,
}

impl Phase {
    fn busy(self) -> bool {
        matches!(
            self,
            Self::Checking
                | Self::Downloading
                | Self::Verifying
                | Self::Installing
                | Self::Switching
        )
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    App,
    Core,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    supported: bool,
    current_build_id: String,
    app_checked: bool,
    app_downloaded: bool,
    app: Option<AppUpdate>,
    core: Option<CoreUpdate>,
    installed_cores: Vec<InstalledCore>,
    phase: Phase,
    kind: Option<Kind>,
    downloaded: u64,
    total: u64,
    error: Option<String>,
}

#[derive(Clone)]
struct AppCandidate {
    info: AppUpdate,
    asset: Asset,
}

struct ReadyApp {
    stage: Staging,
    candidate: AppCandidate,
}

#[derive(Default)]
struct Session {
    app_checked: bool,
    app: Option<AppCandidate>,
    core: Option<CoreRelease>,
    phase: Phase,
    kind: Option<Kind>,
    downloaded: u64,
    total: u64,
    error: Option<String>,
    cancel: Cancellation,
    ready: Option<ReadyApp>,
}

impl Session {
    fn begin(&mut self, phase: Phase, kind: Kind) -> Result<Cancellation, String> {
        if self.phase.busy() {
            return Err("另一个更新操作正在进行".into());
        }
        self.phase = phase;
        self.kind = Some(kind);
        self.error = None;
        self.downloaded = 0;
        self.total = 0;
        self.cancel = Cancellation::default();
        Ok(self.cancel.clone())
    }

    fn fail(&mut self, error: String) {
        self.phase = if self.cancel.check().is_err() {
            Phase::Cancelled
        } else {
            Phase::Failed
        };
        self.error = Some(error);
    }
}

#[derive(Default)]
pub struct Updater {
    session: Mutex<Session>,
}

fn windows_only() -> Result<(), String> {
    if cfg!(windows) {
        Ok(())
    } else {
        Err("应用内更新本轮仅支持 Windows".into())
    }
}

fn current_build_id() -> &'static str {
    option_env!("CLASHNOVA_BUILD_ID").unwrap_or("dev")
}

#[tauri::command]
pub fn get_update_state(app: AppHandle) -> Result<UpdateState, String> {
    let state = app.state::<AppState>();
    let installed = core_update::installed(&state.dirs.config)?;
    let updater = app.state::<Updater>();
    let session = updater.session.lock().map_err(|_| "更新状态锁错误")?;
    Ok(UpdateState {
        supported: cfg!(windows),
        current_build_id: current_build_id().into(),
        app_checked: session.app_checked,
        app_downloaded: session.ready.is_some(),
        app: session.app.as_ref().map(|candidate| candidate.info.clone()),
        core: session.core.as_ref().map(core_info).transpose()?,
        installed_cores: installed,
        phase: session.phase,
        kind: session.kind,
        downloaded: session.downloaded,
        total: session.total,
        error: session.error.clone(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildManifest {
    schema: u32,
    version: String,
    build_id: String,
    asset_name: String,
    sha256: String,
    size: u64,
}

fn validate_manifest(manifest: &BuildManifest, version: &str, asset: &Asset) -> Result<(), String> {
    if manifest.schema != 1
        || manifest.version != version
        || !update_io::valid_hash(&manifest.build_id, 40)
        || manifest.asset_name != asset.name
        || manifest.size != asset.size
        || manifest.sha256 != update_io::asset_hash(asset)?
    {
        return Err("构建清单与安装包发布信息不一致，已停止更新".into());
    }
    Ok(())
}

#[derive(Deserialize)]
struct Comparison {
    status: String,
    ahead_by: u64,
    behind_by: u64,
    merge_base_commit: Commit,
}
#[derive(Deserialize)]
struct Commit {
    sha: String,
}

fn is_forward_revision(comparison: &Comparison, current: &str) -> bool {
    comparison.status == "ahead"
        && comparison.ahead_by > 0
        && comparison.behind_by == 0
        && comparison
            .merge_base_commit
            .sha
            .eq_ignore_ascii_case(current)
}

async fn check_application() -> Result<Option<AppCandidate>, String> {
    let client = update_io::client()?;
    let release: Release = update_io::api(&client, APP_REPO, "releases/latest").await?;
    if release.draft || release.prerelease {
        return Err("应用发布不是稳定版本".into());
    }
    let next_version = update_io::version_tuple(&release.tag_name)?;
    let current_version = update_io::version_tuple(env!("CARGO_PKG_VERSION"))?;
    let same_version = next_version == current_version;
    // 本地开发构建无可靠源码身份；不把旧的同版本 Release 当作更新。
    if next_version < current_version
        || same_version && !update_io::valid_hash(current_build_id(), 40)
    {
        return Ok(None);
    }
    let version = release
        .tag_name
        .strip_prefix('v')
        .ok_or("应用发布标签缺少 v 前缀")?;
    let name = format!("ClashNova_{version}_x64-setup.exe");
    let manifest_name = format!("ClashNova_{version}_windows-build.json");
    let asset = unique_asset(&release, &name)?;
    update_io::validate_asset(asset, APP_REPO, &release.tag_name, &name, MAX_BINARY)?;
    let manifest_asset = unique_asset(&release, &manifest_name)?;
    update_io::validate_asset(
        manifest_asset,
        APP_REPO,
        &release.tag_name,
        &manifest_name,
        16 * 1024,
    )?;
    let data = update_io::asset_bytes(&client, manifest_asset, &Cancellation::default()).await?;
    let manifest: BuildManifest = serde_json::from_slice(&data).map_err(|_| "构建清单格式错误")?;
    validate_manifest(&manifest, version, asset)?;
    if same_version {
        if manifest.build_id.eq_ignore_ascii_case(current_build_id()) {
            return Ok(None);
        }
        let comparison: Comparison = update_io::api(
            &client,
            APP_REPO,
            &format!("compare/{}...{}", current_build_id(), manifest.build_id),
        )
        .await?;
        if !is_forward_revision(&comparison, current_build_id()) {
            return Ok(None);
        }
    }
    Ok(Some(AppCandidate {
        info: AppUpdate {
            version: version.into(),
            build_id: manifest.build_id,
            asset_name: asset.name.clone(),
            size: asset.size,
            sha256: update_io::asset_hash(asset)?,
            same_version,
        },
        asset: asset.clone(),
    }))
}

fn unique_asset<'a>(release: &'a Release, name: &str) -> Result<&'a Asset, String> {
    let mut assets = release.assets.iter().filter(|asset| asset.name == name);
    let asset = assets
        .next()
        .ok_or_else(|| format!("发布缺少 {name}，请等待完整构建发布"))?;
    if assets.next().is_some() {
        return Err("发布存在重复更新资产".into());
    }
    Ok(asset)
}

#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<Option<AppUpdate>, String> {
    windows_only()?;
    {
        let updater = app.state::<Updater>();
        updater
            .session
            .lock()
            .map_err(|_| "更新状态锁错误")?
            .begin(Phase::Checking, Kind::App)?;
    }
    let result = check_application().await;
    let updater = app.state::<Updater>();
    let mut session = updater.session.lock().map_err(|_| "更新状态锁错误")?;
    match result {
        Ok(candidate) => {
            let info = candidate.as_ref().map(|candidate| candidate.info.clone());
            let same_ready = session.ready.as_ref().is_some_and(|ready| {
                candidate
                    .as_ref()
                    .is_some_and(|new| new.info.sha256 == ready.candidate.info.sha256)
            });
            if !same_ready {
                session.ready = None;
            }
            session.app = candidate;
            session.app_checked = true;
            session.phase = if same_ready {
                Phase::Ready
            } else {
                Phase::Idle
            };
            Ok(info)
        }
        Err(error) => {
            session.fail(error.clone());
            Err(error)
        }
    }
}

fn core_info(release: &CoreRelease) -> Result<CoreUpdate, String> {
    Ok(CoreUpdate {
        version: release.version.clone(),
        size: release.asset.size,
        sha256: update_io::asset_hash(&release.asset)?,
    })
}

#[tauri::command]
pub async fn check_core_update(app: AppHandle) -> Result<CoreUpdate, String> {
    windows_only()?;
    {
        let updater = app.state::<Updater>();
        updater
            .session
            .lock()
            .map_err(|_| "更新状态锁错误")?
            .begin(Phase::Checking, Kind::Core)?;
    }
    let result = async { core_update::release(&update_io::client()?, None).await }.await;
    let updater = app.state::<Updater>();
    let mut session = updater.session.lock().map_err(|_| "更新状态锁错误")?;
    match result {
        Ok(release) => {
            let info = core_info(&release)?;
            session.core = Some(release);
            session.phase = Phase::Idle;
            Ok(info)
        }
        Err(error) => {
            session.fail(error.clone());
            Err(error)
        }
    }
}

fn progress(app: &AppHandle, downloaded: u64) {
    let updater = app.state::<Updater>();
    if let Ok(mut session) = updater.session.lock() {
        session.downloaded = downloaded;
    };
}

#[tauri::command]
pub fn download_app_update(app: AppHandle) -> Result<(), String> {
    windows_only()?;
    let (candidate, cancel) = {
        let updater = app.state::<Updater>();
        let mut session = updater.session.lock().map_err(|_| "更新状态锁错误")?;
        let candidate = session.app.clone().ok_or("请先检查可用的应用更新")?;
        let cancel = session.begin(Phase::Downloading, Kind::App)?;
        session.ready = None;
        session.total = candidate.asset.size;
        (candidate, cancel)
    };
    tauri::async_runtime::spawn(async move {
        let result = async {
            let stage = Staging::create(
                &app.state::<AppState>()
                    .dirs
                    .config
                    .join("updates/downloads"),
            )?;
            let path = stage.0.join("installer.exe");
            update_io::download(
                &update_io::client()?,
                &candidate.asset,
                &path,
                &cancel,
                |bytes| progress(&app, bytes),
            )
            .await?;
            cancel.check()?;
            Ok::<_, String>(ReadyApp { stage, candidate })
        }
        .await;
        let updater = app.state::<Updater>();
        if let Ok(mut session) = updater.session.lock() {
            match result {
                Ok(ready) if cancel.check().is_ok() => {
                    session.ready = Some(ready);
                    session.phase = Phase::Ready;
                }
                Ok(_) => session.fail("更新下载已取消".into()),
                Err(error) => session.fail(error),
            }
        };
    });
    Ok(())
}

#[tauri::command]
pub fn download_core_update(app: AppHandle) -> Result<(), String> {
    windows_only()?;
    let (release, cancel) = {
        let updater = app.state::<Updater>();
        let mut session = updater.session.lock().map_err(|_| "更新状态锁错误")?;
        let release = session.core.clone().ok_or("请先检查官方内核更新")?;
        let cancel = session.begin(Phase::Downloading, Kind::Core)?;
        session.total = release.asset.size;
        (release, cancel)
    };
    tauri::async_runtime::spawn(async move {
        let result = async {
            let config = app.state::<AppState>().dirs.config.clone();
            let stage = Staging::create(&config.join("updates/downloads"))?;
            update_io::download(
                &update_io::client()?,
                &release.asset,
                &stage.0.join("archive.zip"),
                &cancel,
                |bytes| progress(&app, bytes),
            )
            .await?;
            cancel.check()?;
            {
                app.state::<Updater>()
                    .session
                    .lock()
                    .map_err(|_| "更新状态锁错误")?
                    .phase = Phase::Verifying;
            }
            let token = cancel.clone();
            tauri::async_runtime::spawn_blocking(move || {
                token.check()?;
                core_update::cache_download(&config, &release, &stage)?;
                // 成功缓存不会自动切换，更不会因关闭弹层触发执行。
                Ok::<_, String>(())
            })
            .await
            .map_err(|_| "内核解压任务失败")?
        }
        .await;
        let updater = app.state::<Updater>();
        if let Ok(mut session) = updater.session.lock() {
            match result {
                Ok(()) => {
                    session.phase = Phase::Idle;
                    session.error = None;
                }
                Err(error) => session.fail(error),
            }
        };
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_update(app: AppHandle) -> Result<(), String> {
    let updater = app.state::<Updater>();
    let mut session = updater.session.lock().map_err(|_| "更新状态锁错误")?;
    if !matches!(
        session.phase,
        Phase::Downloading | Phase::Ready | Phase::Verifying
    ) {
        return Err("当前操作不是可取消的更新下载".into());
    }
    if session.phase == Phase::Verifying {
        return Err("内核正在校验落盘，请等待完成；不会自动切换".into());
    }
    session.cancel.cancel();
    if session.phase == Phase::Ready {
        session.ready = None;
        session.phase = Phase::Cancelled;
    }
    Ok(())
}

#[tauri::command]
pub async fn install_app_update(app: AppHandle, confirm: bool) -> Result<(), String> {
    windows_only()?;
    if !confirm {
        return Err("需要明确确认退出并安装更新".into());
    }
    let ready = {
        let updater = app.state::<Updater>();
        let mut session = updater.session.lock().map_err(|_| "更新状态锁错误")?;
        if session.phase.busy() {
            return Err("另一个更新操作正在进行".into());
        }
        let ready = session
            .ready
            .take()
            .ok_or("没有完成校验的安装包，请先下载")?;
        session.begin(Phase::Installing, Kind::App)?;
        ready
    };
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    let worker = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || launch_installer(&worker, &ready))
        .await
        .map_err(|_| "启动安装程序任务失败".to_string())
        .and_then(|result| result);
    if let Err(error) = result {
        let updater = app.state::<Updater>();
        updater
            .session
            .lock()
            .map_err(|_| "更新状态锁错误")?
            .fail(error.clone());
        return Err(error);
    }
    app.exit(0);
    Ok(())
}

#[cfg(windows)]
fn launch_installer(app: &AppHandle, ready: &ReadyApp) -> Result<(), String> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::process::CommandExt;
    let path = ready.stage.0.join("installer.exe");
    update_io::checked_path(&path)?;
    // 从最后校验到 ShellExecute 已打开文件期间拒绝写入和删除。
    let _locked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .map_err(|_| "锁定已校验安装包失败")?;
    update_io::verify_file(
        &path,
        ready.candidate.info.size,
        &ready.candidate.info.sha256,
    )?;
    let settings = app.state::<AppState>().settings_snapshot();
    let was_service = crate::core::service_core_is_running();
    let was_running = crate::core::is_sidecar_running(app) || was_service;
    with_install_restore(
        || {
            // stop 可能已停止 sidecar 后才在服务 IPC 阶段失败，也必须进入恢复分支。
            crate::core::stop(app).map_err(|error| format!("停止更新前内核失败: {error}"))?;
            app.state::<AppState>()
                .guard_gen
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            crate::sysproxy_win::clear_on_exit(&settings);
            let script = format!("$ErrorActionPreference='Stop'; $p=Start-Process -FilePath '{}' -ArgumentList '/UPDATE' -Verb RunAs -PassThru -WindowStyle Normal; if(-not $p){{throw 'Installer launch failed'}}", path.to_string_lossy().replace('\'', "''"));
            let powershell = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let launched = std::process::Command::new(powershell)
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .creation_flags(0x08000000)
                .output();
            if launched.is_ok_and(|output| output.status.success()) {
                Ok(())
            } else {
                Err("安装程序未启动或 UAC 已取消".into())
            }
        },
        || {
            let mut failures = Vec::new();
            if let Err(error) = resume_core(app, was_running, was_service) {
                failures.push(error);
            }
            if let Err(error) = crate::sysproxy_win::apply(&settings) {
                failures.push(error);
            }
            crate::sysproxy_win::restart_guard(app);
            if failures.is_empty() {
                Ok(())
            } else {
                Err(failures.join("；"))
            }
        },
    )
}

fn with_install_restore(
    install: impl FnOnce() -> Result<(), String>,
    restore: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    install().map_err(|error| match restore() {
        Ok(()) => format!("{error}；已恢复更新前运行状态"),
        Err(restore) => format!("{error}；恢复运行状态失败: {restore}"),
    })
}

#[cfg(not(windows))]
fn launch_installer(_app: &AppHandle, _ready: &ReadyApp) -> Result<(), String> {
    windows_only()
}

#[tauri::command]
pub async fn switch_core_version(app: AppHandle, id: String, confirm: bool) -> Result<(), String> {
    windows_only()?;
    if !confirm {
        return Err("需要明确确认重启并切换内核".into());
    }
    if id != "bundled" {
        core_update::parse_id(&id)?;
    }
    {
        let updater = app.state::<Updater>();
        updater
            .session
            .lock()
            .map_err(|_| "更新状态锁错误")?
            .begin(Phase::Switching, Kind::Core)?;
    }
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    let result = switch_core(&app, &id).await;
    let updater = app.state::<Updater>();
    let mut session = updater.session.lock().map_err(|_| "更新状态锁错误")?;
    match result {
        Ok(()) => {
            session.phase = Phase::Idle;
            Ok(())
        }
        Err(error) => {
            session.fail(error.clone());
            Err(error)
        }
    }
}

async fn switch_core(app: &AppHandle, id: &str) -> Result<(), String> {
    let config = app.state::<AppState>().dirs.config.clone();
    let previous = core_update::selected_id(&config)?;
    let worker = app.clone();
    let running = crate::core::is_running(app).await;
    let (managed, was_service) = tauri::async_runtime::spawn_blocking(|| {
        (
            crate::service::status() == "installed",
            crate::core::service_core_is_running(),
        )
    })
    .await
    .map_err(|_| "查询服务状态失败")?;
    // 即使选择相同 id 也允许重装服务副本，修复旧服务安装覆盖默认内核的情况。
    let desired = id.to_string();
    let config_arg = config.clone();
    let switched = tauri::async_runtime::spawn_blocking(move || {
        if desired != "bundled" {
            core_update::verified_cached_binary(&config_arg, &desired)?;
        }
        let change = crate::core::stop(&worker).and_then(|_| {
            if managed {
                crate::service_installer::update_core_with_installer_sync(&config_arg, &desired)
            } else {
                Ok(())
            }
        });
        if let Err(error) = change {
            return match resume_core(&worker, running, was_service) {
                Ok(()) => Err(error),
                Err(restart) => Err(format!("{error}；恢复原内核运行状态失败: {restart}")),
            };
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| "内核切换任务失败")?;
    switched?;
    let activation = async {
        core_update::select(&config, id)?;
        let worker = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let content = std::fs::read_to_string(worker.state::<AppState>().dirs.runtime_config())
                .map_err(|_| "读取运行配置失败")?;
            crate::core::validate_runtime(&worker, &content)?;
            resume_core(&worker, running, was_service)?;
            Ok::<_, String>(())
        })
        .await
        .map_err(|_| "新内核启动任务失败")??;
        if running {
            let expected = if id == "bundled" {
                core_update::bundled_version()?
            } else {
                core_update::read_receipt(&config, id)?.version
            };
            wait_for_core(app, &expected, Duration::from_secs(25)).await?;
            if app.state::<AppState>().settings_snapshot().tun {
                crate::core::wait_runtime_tun(app, true, Duration::from_secs(10)).await?;
            }
        }
        Ok::<_, String>(())
    }
    .await;
    if let Err(error) = activation {
        let worker = app.clone();
        let rollback = tauri::async_runtime::spawn_blocking(move || {
            crate::core::stop(&worker)?;
            if managed {
                crate::service_installer::rollback_core_with_installer_sync(&config)?;
            }
            core_update::select(&config, &previous)?;
            resume_core(&worker, running, was_service)?;
            Ok::<_, String>(())
        })
        .await
        .map_err(|_| "内核回滚任务失败")?;
        return match rollback {
            Ok(()) => Err(format!("新内核未通过配置/健康检查，已回滚: {error}")),
            Err(rollback) => Err(format!("新内核失败: {error}；回滚失败: {rollback}")),
        };
    }
    Ok(())
}

fn resume_core(app: &AppHandle, running: bool, service: bool) -> Result<(), String> {
    if !running {
        return Ok(());
    }
    if service {
        crate::core::start_with_service(app)
    } else {
        crate::core::start(app)
    }
}

async fn wait_for_core(app: &AppHandle, expected: &str, timeout: Duration) -> Result<(), String> {
    let settings = app.state::<AppState>().settings_snapshot();
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|_| "创建内核健康检查失败")?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let response = client
            .get(format!("http://{}/version", settings.external_controller))
            .bearer_auth(&settings.secret)
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        if let Ok(response) = response {
            if response.status().is_success() {
                if let Ok(value) = response.json::<serde_json::Value>().await {
                    if value["version"].as_str().is_some_and(|version| {
                        version.trim_start_matches('v') == expected.trim_start_matches('v')
                    }) {
                        return Ok(());
                    }
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err("等待新内核控制器就绪超时".into());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// 仅在 GUI 初始化时调用，清理上次已经结束的下载暂存目录，不触碰已安装内核缓存。
pub fn cleanup_stale_downloads(config_dir: &std::path::Path) {
    let downloads = config_dir.join("updates/downloads");
    if update_io::checked_path(&downloads).is_err() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(downloads) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir())
                && entry.file_name().to_string_lossy().starts_with("stage-")
            {
                drop(Staging(entry.path()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_version_updates_require_forward_ancestry_not_asset_timestamp() {
        let current = "a".repeat(40);
        let mut comparison = Comparison {
            status: "ahead".into(),
            ahead_by: 2,
            behind_by: 0,
            merge_base_commit: Commit {
                sha: current.clone(),
            },
        };
        assert!(is_forward_revision(&comparison, &current));
        for status in ["behind", "diverged", "identical"] {
            comparison.status = status.into();
            assert!(!is_forward_revision(&comparison, &current));
        }
        comparison.status = "ahead".into();
        comparison.merge_base_commit.sha = "b".repeat(40);
        assert!(!is_forward_revision(&comparison, &current));
    }

    #[test]
    fn manifest_must_match_final_signed_installer() {
        let mut manifest = BuildManifest {
            schema: 1,
            version: "2.4.8".into(),
            build_id: "a".repeat(40),
            asset_name: "ClashNova_2.4.8_x64-setup.exe".into(),
            sha256: "b".repeat(64),
            size: 42,
        };
        let asset = Asset {
            name: manifest.asset_name.clone(),
            size: manifest.size,
            digest: Some(format!("sha256:{}", manifest.sha256)),
            browser_download_url: String::new(),
            state: "uploaded".into(),
        };
        assert!(validate_manifest(&manifest, "2.4.8", &asset).is_ok());
        manifest.sha256 = "c".repeat(64);
        assert!(validate_manifest(&manifest, "2.4.8", &asset).is_err());
        manifest.sha256 = "b".repeat(64);
        manifest.build_id = "../../main".into();
        assert!(validate_manifest(&manifest, "2.4.8", &asset).is_err());
    }

    #[test]
    fn parallel_mutating_updates_are_rejected_and_cancel_is_preserved() {
        let mut session = Session::default();
        let cancel = session.begin(Phase::Downloading, Kind::App).unwrap();
        assert!(session.begin(Phase::Switching, Kind::Core).is_err());
        cancel.cancel();
        session.fail("cancelled".into());
        assert!(session.phase == Phase::Cancelled);
        assert!(session.begin(Phase::Checking, Kind::App).is_ok());
    }

    #[test]
    fn partial_stop_and_launch_failures_restore_but_success_does_not() {
        use std::cell::Cell;
        for failure in ["service stop IPC failed", "UAC cancelled"] {
            let running = Cell::new(true);
            let result = with_install_restore(
                || {
                    running.set(false);
                    Err(failure.into())
                },
                || {
                    running.set(true);
                    Ok(())
                },
            );
            assert!(running.get());
            assert!(result.unwrap_err().contains(failure));
        }
        assert!(
            with_install_restore(|| Ok(()), || panic!("successful launch must not restore"))
                .is_ok()
        );
        let error =
            with_install_restore(|| Err("stop failed".into()), || Err("resume failed".into()))
                .unwrap_err();
        assert!(error.contains("stop failed") && error.contains("resume failed"));
    }
}
