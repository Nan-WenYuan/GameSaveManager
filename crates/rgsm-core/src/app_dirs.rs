use log::info;
use std::fmt;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Stores the application's data directory path
static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static APP_DATA_DIR_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();
#[cfg(test)]
static TEST_APP_DATA_DIR: OnceLock<temp_dir::TempDir> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppDataDirOverrideError {
    AlreadyInitialized,
    AlreadySet,
}

impl fmt::Display for AppDataDirOverrideError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppDataDirOverrideError::AlreadyInitialized => {
                write!(f, "application data directory is already initialized")
            }
            AppDataDirOverrideError::AlreadySet => {
                write!(f, "application data directory override is already set")
            }
        }
    }
}

impl std::error::Error for AppDataDirOverrideError {}

/// Set an explicit application data directory before any config/path access.
///
/// The override is intended for non-GUI frontends such as `rgsm-tui` and must
/// be installed during process startup. Once the default directory has been
/// resolved, changing it would make later config reads/write target a different
/// root from earlier reads, so this function rejects late calls.
pub fn set_app_data_dir_override(path: PathBuf) -> Result<(), AppDataDirOverrideError> {
    if APP_DATA_DIR.get().is_some() {
        return Err(AppDataDirOverrideError::AlreadyInitialized);
    }
    APP_DATA_DIR_OVERRIDE
        .set(path)
        .map_err(|_| AppDataDirOverrideError::AlreadySet)
}

/// Get the directory where application data should be stored
///
/// This function implements the following logic:
/// - In debug mode: Check pwd first (to avoid test configs in target/debug being cleared)
/// - Portable data lives in data/ beside the executable; legacy settings migrate at startup.
///
/// The result is cached after the first call.
/// The data directory is determined at startup and remains fixed for the application lifetime.
pub fn get_app_data_dir() -> &'static PathBuf {
    if let Some(path) = APP_DATA_DIR_OVERRIDE.get() {
        return path;
    }
    APP_DATA_DIR.get_or_init(init_app_data_dir)
}

#[cfg(test)]
fn init_app_data_dir() -> PathBuf {
    init_test_app_data_dir()
}

#[cfg(not(test))]
fn init_app_data_dir() -> PathBuf {
    init_runtime_app_data_dir()
}

#[cfg(test)]
fn init_test_app_data_dir() -> PathBuf {
    let test_data_dir = TEST_APP_DATA_DIR.get_or_init(|| {
        temp_dir::TempDir::new().expect("failed to create temporary test data directory")
    });
    info!(
        "Test mode: Using temp directory as data directory: {}",
        test_data_dir.path().display()
    );
    test_data_dir.path().to_path_buf()
}

#[cfg_attr(test, allow(dead_code))]
fn init_runtime_app_data_dir() -> PathBuf {
    // In debug mode, check pwd first to avoid test configs in target/debug
    // being cleared during cargo clean or rebuilds
    #[cfg(debug_assertions)]
    {
        if let Ok(cwd) = std::env::current_dir() {
            let pwd_config_path = cwd.join("GameSaveManager.config.json");
            if pwd_config_path.exists() {
                info!("Debug mode: Using pwd as data directory: {}", cwd.display());
                return cwd;
            }
        }
    }

    // Standard behavior: use executable directory for both portable and installed versions
    if let Ok(exe_path) = std::env::current_exe()
        && let Some(exe_dir) = exe_path.parent()
    {
        info!(
            "Using executable directory as data directory: {}",
            exe_dir.display()
        );
        return prepare_portable_data_dir(exe_dir).unwrap_or_else(|error| {
            log::warn!("Portable data migration failed; keeping legacy layout: {error}");
            exe_dir.to_path_buf()
        });
    }

    // Fallback only if we cannot determine executable directory
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    log::warn!(
        "Failed to determine executable directory, falling back to current directory: {}",
        cwd.display()
    );
    cwd
}

/// Backups remain relative to the program directory, independently of config storage.
pub fn get_backup_base_dir() -> PathBuf {
    #[cfg(test)]
    {
        get_app_data_dir().clone()
    }
    #[cfg(not(test))]
    {
        if APP_DATA_DIR_OVERRIDE.get().is_some() {
            return get_app_data_dir().clone();
        }
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
            .unwrap_or_else(|| get_app_data_dir().clone())
    }
}

/// Move only application-owned settings/cache entries. Preflight prevents overwrites;
/// a failed move rolls already moved entries back. Game backup folders never move.
pub fn prepare_portable_data_dir(root: &std::path::Path) -> std::io::Result<PathBuf> {
    let data = root.join("data");
    let names = [
        "GameSaveManager.config.json",
        "GameSaveManager.host.json",
        "GameSaveManager.config.json.bak",
        "GameSaveManager.config.json.backup.0",
        "GameSaveManager.config.json.backup.1",
        "GameSaveManager.config.json.backup.2",
        "GameSaveManager.config.json.backup.3",
        "GameSaveManager.config.json.backup.4",
        "GameSaveManager.config",
        "GameSaveManager.config.staging",
        "GameSaveManager.config.rollback",
        "GameSaveManager.config.v2",
        "GameSaveManager.config.v2.staging",
        "GameSaveManager.config.v2.rollback",
        "GameSaveManager.cloud-v2-materialization.json",
        "ludusavi_manifest.yaml",
        "ludusavi_manifest.meta.json",
    ];
    let is_cutover_record = |name: &str| {
        name.strip_prefix("GameSaveManager.cloud-cutover.")
            .and_then(|name| name.strip_suffix(".json"))
            .is_some_and(|identity| {
                identity.len() == 16 && identity.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
    };
    let journal = data.join(".portable-layout-migration.json");
    if journal.exists() {
        let pending: Vec<String> = serde_json::from_slice(&std::fs::read(&journal)?)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        if pending
            .iter()
            .any(|name| !names.contains(&name.as_str()) && !is_cutover_record(name))
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Invalid portable migration entry",
            ));
        }
        for name in pending.iter().rev() {
            if data.join(name).exists() {
                if root.join(name).exists() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::AlreadyExists,
                        "Interrupted migration has conflicting files",
                    ));
                }
                std::fs::rename(data.join(name), root.join(name))?;
            }
        }
        std::fs::remove_file(&journal)?;
    }
    let mut entries: Vec<String> = names
        .iter()
        .filter(|name| root.join(name).exists())
        .map(|name| (*name).to_string())
        .collect();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_cutover_record(&name) {
                entries.push(name);
            }
        }
    }
    for name in &entries {
        if data.join(name).exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("Both legacy and data directories contain {name}; refusing to overwrite"),
            ));
        }
    }
    std::fs::create_dir_all(&data)?;
    if entries.is_empty() {
        return Ok(data);
    }
    let serialized = serde_json::to_vec(&entries).map_err(std::io::Error::other)?;
    crate::atomic_file::write_bytes_atomically(&journal, &serialized)?;
    let mut moved = Vec::new();
    for name in &entries {
        if let Err(error) = std::fs::rename(root.join(name), data.join(name)) {
            for previous in moved.iter().rev() {
                std::fs::rename(data.join(previous), root.join(previous))?;
            }
            std::fs::remove_file(&journal)?;
            return Err(error);
        }
        moved.push(name);
    }
    if let Err(error) = std::fs::remove_file(&journal) {
        log::warn!("Portable migration completed, but its journal could not be removed: {error}");
    }
    Ok(data)
}

/// Resolve a path relative to the app data directory
///
/// If the path is already absolute, return it as-is.
/// Otherwise, resolve it relative to the app data directory.
pub fn resolve_app_path(path: &str) -> PathBuf {
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() {
        return candidate;
    }

    get_app_data_dir().join(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_layout_preserves_backup_folders_and_is_repeatable() {
        let root = temp_dir::TempDir::new().unwrap();
        std::fs::write(
            root.path().join("GameSaveManager.config.json"),
            "legacy config",
        )
        .unwrap();
        std::fs::create_dir(root.path().join("GameSaveManager.config.v2")).unwrap();
        std::fs::write(
            root.path().join("GameSaveManager.config.v2/profile.json"),
            "profile",
        )
        .unwrap();
        std::fs::create_dir(root.path().join("My Game")).unwrap();
        std::fs::write(root.path().join("My Game/save.7z"), "backup").unwrap();
        let data = prepare_portable_data_dir(root.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(data.join("GameSaveManager.config.v2/profile.json")).unwrap(),
            "profile"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("My Game/save.7z")).unwrap(),
            "backup"
        );
        assert!(!root.path().join("GameSaveManager.config.json").exists());
        assert_eq!(prepare_portable_data_dir(root.path()).unwrap(), data);
    }

    #[test]
    fn portable_layout_recovers_an_interrupted_move() {
        let root = temp_dir::TempDir::new().unwrap();
        std::fs::create_dir(root.path().join("data")).unwrap();
        std::fs::write(
            root.path().join("data/GameSaveManager.config.json"),
            "original",
        )
        .unwrap();
        std::fs::write(
            root.path().join("data/.portable-layout-migration.json"),
            r#"["GameSaveManager.config.json","GameSaveManager.config.v2"]"#,
        )
        .unwrap();
        std::fs::create_dir(root.path().join("GameSaveManager.config.v2")).unwrap();
        let data = prepare_portable_data_dir(root.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(data.join("GameSaveManager.config.json")).unwrap(),
            "original"
        );
        assert!(data.join("GameSaveManager.config.v2").is_dir());
        assert!(!data.join(".portable-layout-migration.json").exists());
    }

    #[test]
    fn portable_layout_conflict_never_overwrites_or_partially_moves() {
        let root = temp_dir::TempDir::new().unwrap();
        std::fs::create_dir(root.path().join("data")).unwrap();
        std::fs::write(root.path().join("GameSaveManager.config.json"), "legacy").unwrap();
        std::fs::write(root.path().join("ludusavi_manifest.yaml"), "cache").unwrap();
        std::fs::write(root.path().join("data/ludusavi_manifest.yaml"), "existing").unwrap();
        assert!(prepare_portable_data_dir(root.path()).is_err());
        assert_eq!(
            std::fs::read_to_string(root.path().join("GameSaveManager.config.json")).unwrap(),
            "legacy"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("data/ludusavi_manifest.yaml")).unwrap(),
            "existing"
        );
    }

    #[test]
    fn test_resolve_absolute_path() {
        #[cfg(target_os = "windows")]
        let absolute_path = "C:\\test\\path";
        #[cfg(not(target_os = "windows"))]
        let absolute_path = "/test/path";

        let result = resolve_app_path(absolute_path);
        assert_eq!(result, PathBuf::from(absolute_path));
    }

    #[test]
    fn test_resolve_relative_path() {
        let relative_path = "config.json";
        let result = resolve_app_path(relative_path);

        // The result should be relative to app data dir
        assert!(result.ends_with(relative_path));
    }

    #[test]
    fn test_override_error_display() {
        assert_eq!(
            AppDataDirOverrideError::AlreadyInitialized.to_string(),
            "application data directory is already initialized"
        );
        assert_eq!(
            AppDataDirOverrideError::AlreadySet.to_string(),
            "application data directory override is already set"
        );
    }

    #[test]
    fn test_override_path_resolution_shape() {
        let base = PathBuf::from("custom-data-dir");
        let resolved = base.join("GameSaveManager.config.json");
        assert!(resolved.ends_with("GameSaveManager.config.json"));
    }
}
