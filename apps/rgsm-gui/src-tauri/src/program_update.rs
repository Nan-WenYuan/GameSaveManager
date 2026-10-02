//! Updates the portable executable only. User configuration and saves are never touched.
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

const REPOSITORY: &str = "Nan-WenYuan/GameSaveManager";
const TRANSITION_REPOSITORY: &str = "Nan-WenYuan/GameSaveManager-Releases";
const EXECUTABLE: &str = "游戏存档管理器.exe";
// GitHub normalizes non-ASCII upload names. Keep release assets ASCII while
// retaining the stable localized executable filename inside the portable package.
const ASSET_NAME: &str = "rgsm.exe";
const UPDATE_DIR: &str = ".rgsm-update";
const MAX_EXECUTABLE_SIZE: u64 = 256 * 1024 * 1024;
static PREPARING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProgramUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
    pub release_url: String,
    pub release_notes: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    size: u64,
    browser_download_url: String,
}

fn client() -> Result<reqwest::Client> {
    // Public program updates never read or send the private save repository token.
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "X-GitHub-Api-Version",
        reqwest::header::HeaderValue::from_static("2022-11-28"),
    );
    Ok(reqwest::Client::builder()
        .user_agent("game-save-manager-portable-updater")
        .default_headers(headers)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let host = attempt.url().host_str().unwrap_or_default();
            if attempt.previous().len() >= 5 {
                attempt.error(rust_i18n::t!("program_update.errors.redirect_invalid").to_string())
            } else if host == "api.github.com"
                || host == "github.com"
                || host.ends_with(".githubusercontent.com")
            {
                attempt.follow()
            } else {
                attempt.error(rust_i18n::t!("program_update.errors.redirect_invalid").to_string())
            }
        }))
        .timeout(Duration::from_secs(120))
        .build()?)
}

async fn latest(client: &reqwest::Client) -> Result<Release> {
    let mut response = client
        .get(format!(
            "https://api.github.com/repos/{REPOSITORY}/releases/latest"
        ))
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await?;
    if matches!(
        response.status(),
        reqwest::StatusCode::FORBIDDEN | reqwest::StatusCode::TOO_MANY_REQUESTS
    ) {
        // A public index avoids the anonymous API quota shared by a network.
        response = client
            .get(format!(
                "https://raw.githubusercontent.com/{REPOSITORY}/main/latest.json"
            ))
            .send()
            .await?;
    }
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        // Migration can be published before the final repository rename. Only
        // this fixed public transition endpoint is allowed; never use save config.
        response = client
            .get(format!(
                "https://api.github.com/repos/{TRANSITION_REPOSITORY}/releases/latest"
            ))
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .send()
            .await?;
        if matches!(
            response.status(),
            reqwest::StatusCode::FORBIDDEN | reqwest::StatusCode::TOO_MANY_REQUESTS
        ) {
            response = client
                .get(format!(
                    "https://raw.githubusercontent.com/{TRANSITION_REPOSITORY}/main/latest.json"
                ))
                .send()
                .await?;
        }
    }
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        bail!(rust_i18n::t!("program_update.errors.no_release").to_string());
    }
    let release: Release = response.error_for_status()?.json().await?;
    ensure!(
        !release.draft && !release.prerelease,
        rust_i18n::t!("program_update.errors.not_stable").to_string()
    );
    Ok(release)
}

fn version_from_tag(tag: &str) -> Result<semver::Version> {
    let value = tag.strip_prefix('v').unwrap_or(tag);
    let version = semver::Version::parse(value)
        .context(rust_i18n::t!("program_update.errors.tag_invalid").to_string())?;
    ensure!(
        version.pre.is_empty() && version.build.is_empty(),
        rust_i18n::t!("program_update.errors.tag_invalid").to_string()
    );
    Ok(version)
}

fn info(release: &Release) -> Result<ProgramUpdateInfo> {
    let latest_version = version_from_tag(&release.tag_name)?;
    let current_version = semver::Version::parse(env!("CARGO_PKG_VERSION"))?;
    Ok(ProgramUpdateInfo {
        current_version: current_version.to_string(),
        latest_version: latest_version.to_string(),
        available: latest_version > current_version,
        release_url: format!(
            "https://github.com/{REPOSITORY}/releases/tag/{}",
            release.tag_name
        ),
        release_notes: release.body.clone().unwrap_or_default(),
    })
}

pub async fn check() -> Result<ProgramUpdateInfo> {
    info(&latest(&client()?).await?)
}

fn validate_asset_url(value: &str) -> Result<()> {
    let url = reqwest::Url::parse(value)?;
    ensure!(
        url.scheme() == "https"
            && url.host_str() == Some("github.com")
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty()
            && url.password().is_none()
            && [REPOSITORY, TRANSITION_REPOSITORY]
                .iter()
                .any(|repository| {
                    url.path()
                        .starts_with(&format!("/{repository}/releases/download/"))
                }),
        rust_i18n::t!("program_update.errors.redirect_invalid").to_string()
    );
    Ok(())
}

async fn download(client: &reqwest::Client, asset: &Asset, limit: u64) -> Result<Vec<u8>> {
    ensure!(
        asset.size > 0 && asset.size <= limit,
        rust_i18n::t!("program_update.errors.size_invalid").to_string()
    );
    validate_asset_url(&asset.browser_download_url)?;
    let mut response = client
        .get(&asset.browser_download_url)
        .send()
        .await?
        .error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            (bytes.len() as u64) + (chunk.len() as u64) <= limit,
            rust_i18n::t!("program_update.errors.size_exceeded").to_string()
        );
        bytes.extend_from_slice(&chunk);
    }
    ensure!(
        bytes.len() as u64 == asset.size,
        rust_i18n::t!("program_update.errors.incomplete").to_string()
    );
    Ok(bytes)
}

fn checksum_for_executable(text: &str) -> Result<String> {
    for line in text.lines() {
        let Some((hash, name)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        if name.trim().trim_start_matches('*') == ASSET_NAME {
            ensure!(
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
                rust_i18n::t!("program_update.errors.checksum_invalid").to_string()
            );
            return Ok(hash.to_ascii_lowercase());
        }
    }
    bail!(rust_i18n::t!("program_update.errors.checksum_missing").to_string())
}

fn verify(bytes: &[u8], expected: &str) -> Result<()> {
    ensure!(
        bytes.starts_with(b"MZ"),
        rust_i18n::t!("program_update.errors.not_executable").to_string()
    );
    ensure!(
        format!("{:x}", Sha256::digest(bytes)) == expected,
        rust_i18n::t!("program_update.errors.checksum_failed").to_string()
    );
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct Handoff {
    parent_pid: u32,
    checksum: String,
}

/// Launches an independent copy of this executable before the caller exits.
pub async fn prepare() -> Result<()> {
    ensure!(
        cfg!(windows),
        rust_i18n::t!("program_update.errors.windows_only").to_string()
    );
    ensure!(
        !cfg!(debug_assertions),
        rust_i18n::t!("program_update.errors.development").to_string()
    );
    ensure!(
        !PREPARING.swap(true, Ordering::SeqCst),
        rust_i18n::t!("program_update.errors.preparing").to_string()
    );
    let result = prepare_inner().await;
    if result.is_err() {
        PREPARING.store(false, Ordering::SeqCst);
    }
    result
}

async fn prepare_inner() -> Result<()> {
    let executable = std::env::current_exe()?.canonicalize()?;
    ensure!(
        executable
            .file_name()
            .is_some_and(|name| name == EXECUTABLE),
        rust_i18n::t!("program_update.errors.portable_only").to_string()
    );
    let directory = executable
        .parent()
        .context(rust_i18n::t!("program_update.errors.directory_missing").to_string())?
        .join(UPDATE_DIR);
    ensure!(
        !directory.exists(),
        rust_i18n::t!("program_update.errors.previous_pending").to_string()
    );
    let client = client()?;
    let release = latest(&client).await?;
    ensure!(
        info(&release)?.available,
        rust_i18n::t!("program_update.errors.already_current").to_string()
    );
    let binary = release
        .assets
        .iter()
        .find(|asset| asset.name == ASSET_NAME)
        .context(rust_i18n::t!("program_update.errors.asset_missing").to_string())?;
    let sums = release
        .assets
        .iter()
        .find(|asset| asset.name == "SHA256SUMS")
        .context(rust_i18n::t!("program_update.errors.sums_missing").to_string())?;
    let hash = checksum_for_executable(std::str::from_utf8(
        &download(&client, sums, 16 * 1024).await?,
    )?)?;
    let bytes = download(&client, binary, MAX_EXECUTABLE_SIZE).await?;
    verify(&bytes, &hash)?;
    fs::create_dir(&directory)?;
    let staged = (|| -> Result<()> {
        fs::write(directory.join("new.exe"), bytes)?;
        fs::copy(&executable, directory.join("helper.exe"))?;
        let handoff = Handoff {
            parent_pid: std::process::id(),
            checksum: hash,
        };
        let mut file = fs::File::create(directory.join("handoff.json"))?;
        file.write_all(&serde_json::to_vec(&handoff)?)?;
        file.sync_all()?;
        let mut command = Command::new(directory.join("helper.exe"));
        command.arg("--apply-program-update");
        hide_console(&mut command);
        command
            .spawn()
            .context(rust_i18n::t!("program_update.errors.helper_start_failed").to_string())?;
        Ok(())
    })();
    if staged.is_err() {
        let _ = fs::remove_dir_all(&directory);
    }
    staged
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Must run before Tauri/single-instance setup. No paths are accepted from CLI arguments.
pub fn run_update_helper_if_requested() -> Result<bool> {
    if !std::env::args().any(|argument| argument == "--apply-program-update") {
        return Ok(false);
    }
    let helper = std::env::current_exe()?.canonicalize()?;
    ensure!(
        helper.file_name().is_some_and(|name| name == "helper.exe"),
        rust_i18n::t!("program_update.errors.helper_name_invalid").to_string()
    );
    let directory = helper
        .parent()
        .context(rust_i18n::t!("program_update.errors.helper_directory_missing").to_string())?;
    ensure!(
        directory.file_name().is_some_and(|name| name == UPDATE_DIR),
        rust_i18n::t!("program_update.errors.helper_directory_invalid").to_string()
    );
    let handoff: Handoff = serde_json::from_slice(&fs::read(directory.join("handoff.json"))?)?;
    let new_executable = directory.join("new.exe");
    verify(&fs::read(&new_executable)?, &handoff.checksum)?;
    let target = directory
        .parent()
        .context(rust_i18n::t!("program_update.errors.directory_missing").to_string())?
        .join(EXECUTABLE);
    wait_for_parent(handoff.parent_pid)?;
    let previous = directory.join("previous.exe");
    let mut child = replace_and_launch(&target, &new_executable, &previous)?;
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while !directory.join("started").is_file() {
        if child.try_wait()?.is_some() || std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            fs::rename(&target, &new_executable)?;
            fs::rename(&previous, &target)?;
            fs::write(
                directory.join("failed"),
                b"startup did not complete; previous executable restored",
            )?;
            let mut original = Command::new(&target);
            hide_console(&mut original);
            original.spawn()?;
            bail!(rust_i18n::t!("program_update.errors.startup_timeout").to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    fs::write(directory.join("completed"), b"ok")?;
    Ok(true)
}

#[cfg(windows)]
fn wait_for_parent(pid: u32) -> Result<()> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };
    // Read/wait access only; the updater never terminates a process.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return Ok(());
    }
    let status = unsafe { WaitForSingleObject(handle, 60_000) };
    unsafe {
        CloseHandle(handle);
    }
    ensure!(
        status == WAIT_OBJECT_0,
        rust_i18n::t!("program_update.errors.exit_timeout").to_string()
    );
    Ok(())
}

#[cfg(not(windows))]
fn wait_for_parent(_pid: u32) -> Result<()> {
    bail!(rust_i18n::t!("program_update.errors.windows_only").to_string())
}

fn replace_and_launch(
    target: &Path,
    staged: &Path,
    previous: &Path,
) -> Result<std::process::Child> {
    ensure!(
        target.is_file() && !previous.exists(),
        rust_i18n::t!("program_update.errors.target_invalid").to_string()
    );
    fs::rename(target, previous)
        .context(rust_i18n::t!("program_update.errors.target_busy").to_string())?;
    if let Err(reason) = fs::rename(staged, target) {
        fs::rename(previous, target)
            .context(rust_i18n::t!("program_update.errors.rollback_failed").to_string())?;
        return Err(reason.into());
    }
    let mut command = Command::new(target);
    command.current_dir(
        target
            .parent()
            .context(rust_i18n::t!("program_update.errors.directory_missing").to_string())?,
    );
    hide_console(&mut command);
    match command.spawn() {
        Ok(child) => Ok(child),
        Err(reason) => {
            fs::rename(target, staged)?;
            fs::rename(previous, target)?;
            let mut original = Command::new(target);
            hide_console(&mut original);
            let _ = original.spawn();
            Err(reason).context(rust_i18n::t!("program_update.errors.launch_failed").to_string())
        }
    }
}

/// Call during ordinary successful startup. Cleanup waits for the update helper to exit.
pub fn clean_completed_update() {
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let Some(parent) = executable.parent() else {
        return;
    };
    let directory: PathBuf = parent.join(UPDATE_DIR);
    if directory.join("handoff.json").is_file() && !directory.join("failed").exists() {
        let validation = (|| -> Result<()> {
            let handoff: Handoff =
                serde_json::from_slice(&fs::read(directory.join("handoff.json"))?)?;
            verify(&fs::read(&executable)?, &handoff.checksum)?;
            fs::write(directory.join("started"), b"ok")?;
            Ok(())
        })();
        if validation.is_err() {
            return;
        }
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        let completed = directory.join("completed").is_file();
        let rolled_back =
            directory.join("failed").is_file() && !directory.join("previous.exe").exists();
        if completed || rolled_back {
            // Only remove a validated, fixed update directory beside this executable.
            for name in [
                "previous.exe",
                "helper.exe",
                "handoff.json",
                "started",
                "completed",
                "failed",
                "new.exe",
            ] {
                let _ = fs::remove_file(directory.join(name));
            }
            let _ = fs::remove_dir(directory);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_update_requests_never_include_save_authorization() {
        let request = client()
            .unwrap()
            .get(format!(
                "https://api.github.com/repos/{REPOSITORY}/releases/latest"
            ))
            .build()
            .unwrap();
        assert!(
            !request
                .headers()
                .contains_key(reqwest::header::AUTHORIZATION)
        );
    }

    #[test]
    fn migration_accepts_only_new_and_transition_public_assets() {
        assert_eq!(REPOSITORY, "Nan-WenYuan/GameSaveManager");
        for repository in ["GameSaveManager", "GameSaveManager-Releases"] {
            assert!(
                validate_asset_url(&format!(
                    "https://github.com/Nan-WenYuan/{repository}/releases/download/v1.12.2/rgsm.exe"
                ))
                .is_ok()
            );
        }
        assert!(
            validate_asset_url(
                "https://github.com/Nan-WenYuan/Game_Data/releases/download/v1/rgsm.exe"
            )
            .is_err()
        );
        assert!(
            validate_asset_url(
                "https://github.com/Nan-WenYuan/GameSaveManager-Other/releases/download/v1/rgsm.exe"
            )
            .is_err()
        );
    }

    /// Opt-in acceptance against the public release without credentials.
    #[tokio::test]
    #[ignore = "requires a published public release and network access"]
    async fn public_release_assets_download_and_verify() {
        let client = client().unwrap();
        let release = latest(&client).await.unwrap();
        let update = info(&release).unwrap();
        assert_eq!(
            update.latest_version,
            env!("CARGO_PKG_VERSION"),
            "Acceptance must use the newly published build"
        );
        let executable = release
            .assets
            .iter()
            .find(|asset| asset.name == ASSET_NAME)
            .expect("Published release must contain rgsm.exe");
        let sums = release
            .assets
            .iter()
            .find(|asset| asset.name == "SHA256SUMS")
            .expect("Published release must contain SHA256SUMS");
        let sums = download(&client, sums, 16 * 1024).await.unwrap();
        let checksum = checksum_for_executable(std::str::from_utf8(&sums).unwrap()).unwrap();
        let bytes = download(&client, executable, MAX_EXECUTABLE_SIZE)
            .await
            .unwrap();
        verify(&bytes, &checksum).unwrap();
        println!(
            "Public release {}: {} bytes downloaded and SHA256 verified",
            update.latest_version,
            bytes.len()
        );
    }

    #[test]
    fn public_asset_urls_cannot_redirect_downloads_to_other_repositories() {
        assert!(
            validate_asset_url(&format!(
                "https://github.com/{REPOSITORY}/releases/download/v1.11.3/rgsm.exe"
            ))
            .is_ok()
        );
        for url in [
            "https://evil.example/rgsm.exe",
            "https://github.com/other/repo/releases/download/v1/rgsm.exe",
            "http://github.com/Nan-WenYuan/GameSaveManager-Releases/releases/download/v1/rgsm.exe",
            "https://secret@github.com/Nan-WenYuan/GameSaveManager-Releases/releases/download/v1/rgsm.exe",
        ] {
            assert!(validate_asset_url(url).is_err());
        }
    }

    #[test]
    fn rejects_checksum_for_other_files_and_invalid_hex() {
        assert!(checksum_for_executable(&format!("{}  other.exe", "a".repeat(64))).is_err());
        assert!(checksum_for_executable(&format!("{}  {EXECUTABLE}", "a".repeat(64))).is_err());
        assert!(checksum_for_executable(&format!("{}  {ASSET_NAME}", "x".repeat(64))).is_err());
        assert_eq!(
            checksum_for_executable(&format!("{} *{ASSET_NAME}\r\n", "A".repeat(64))).unwrap(),
            "a".repeat(64)
        );
    }

    #[test]
    fn rejects_corrupt_or_non_executable_updates() {
        let bytes = b"MZ example";
        let hash = format!("{:x}", Sha256::digest(bytes));
        assert!(verify(bytes, &hash).is_ok());
        assert!(verify(b"MZ corrupted", &hash).is_err());
        assert!(
            verify(
                b"not an exe",
                &format!("{:x}", Sha256::digest(b"not an exe"))
            )
            .is_err()
        );
    }

    #[test]
    fn release_tags_use_semantic_version_not_package_timestamps() {
        assert!(version_from_tag("v1.10.0").unwrap() > version_from_tag("v1.9.0").unwrap());
        assert!(version_from_tag("v1.9.0.261001_120000_R").is_err());
        assert!(version_from_tag("v1.9.0/../../").is_err());
        assert!(version_from_tag("v1.10.0-beta.1").is_err());
    }

    #[test]
    fn startup_failure_restores_original_in_chinese_space_directory() {
        let temporary = temp_dir::TempDir::new().unwrap();
        let directory = temporary.path().join("中文 便携包");
        fs::create_dir(&directory).unwrap();
        let target = directory.join(EXECUTABLE);
        let staged = directory.join("new.exe");
        let previous = directory.join("previous.exe");
        fs::write(&target, b"original program").unwrap();
        fs::write(&staged, b"invalid executable").unwrap();
        assert!(replace_and_launch(&target, &staged, &previous).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original program");
        assert!(!previous.exists());
    }
}
