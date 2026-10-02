use std::collections::HashSet;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::backup::{AutoBackupConfig, Game, SaveUnit, SaveUnitSource};
use crate::config::{Config, cloud_bootstrap_inputs, get_config, set_config_local};

use super::{ServiceContext, cloud_library_target::bound_v2_operator};

const CLOUD_CONFIG_PATH: &str = "v2/game-management-config.json";
const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct GameManagementConfig {
    schema_version: u32,
    games: Vec<PortableGame>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PortableGame {
    name: String,
    storage_key: String,
    save_paths: Vec<SaveUnit>,
    auto_backup: Option<AutoBackupConfig>,
}

impl GameManagementConfig {
    fn capture(config: &Config, device: &str) -> Self {
        Self {
            schema_version: 1,
            games: config
                .games
                .iter()
                .map(|game| {
                    let mut save_paths = game.save_paths.clone();
                    for unit in &mut save_paths {
                        if let SaveUnitSource::Concrete { paths, .. } = &mut unit.source {
                            let local = paths.get(device).cloned();
                            paths.clear();
                            if let Some(path) = local {
                                paths.insert("local".into(), path);
                            }
                        }
                    }
                    PortableGame {
                        name: game.name.clone(),
                        storage_key: game.storage_key.clone(),
                        save_paths,
                        auto_backup: game.auto_backup.clone(),
                    }
                })
                .collect(),
        }
    }

    fn apply(self, current: &Config, device: &str) -> Result<Config> {
        if self.schema_version != 1 {
            bail!("{}", rust_i18n::t!("game_config_sync.invalid_format"));
        }
        let mut identities = HashSet::new();
        let mut names = HashSet::new();
        let mut next = current.clone();
        next.games.clear();
        for game in self.games {
            if game.name.trim().is_empty()
                || game.storage_key
                    != crate::backup::storage_key::generate_storage_key(&game.storage_key)
                || !identities.insert(game.storage_key.to_lowercase())
                || !names.insert(game.name.to_lowercase())
            {
                bail!("{}", rust_i18n::t!("game_config_sync.invalid_game"));
            }
            let previous = current
                .games
                .iter()
                .find(|item| item.storage_key == game.storage_key);
            let mut save_paths = game.save_paths;
            let mut unit_ids = HashSet::new();
            for unit in &mut save_paths {
                if !unit_ids.insert(unit.id) {
                    bail!("{}", rust_i18n::t!("game_config_sync.duplicate_unit"));
                }
                if let SaveUnitSource::Concrete { paths, .. } = &mut unit.source {
                    let local = previous
                        .and_then(|old| {
                            old.save_paths
                                .iter()
                                .find(|old_unit| old_unit.id == unit.id)
                        })
                        .and_then(|old_unit| old_unit.get_path_for_device(&device.to_string()))
                        .cloned()
                        .or_else(|| paths.get("local").cloned());
                    paths.clear();
                    if let Some(path) = local {
                        paths.insert(device.into(), path);
                    }
                }
            }
            let mut imported = Game {
                name: game.name,
                storage_key: game.storage_key,
                save_paths,
                auto_backup: game.auto_backup,
                next_save_unit_id: 0,
                game_paths: previous
                    .map(|old| old.game_paths.clone())
                    .unwrap_or_default(),
                device_bindings: previous
                    .map(|old| old.device_bindings.clone())
                    .unwrap_or_default(),
                ludusavi_meta: previous.and_then(|old| old.ludusavi_meta.clone()),
                cloud_sync_enabled: previous.is_some_and(|old| old.cloud_sync_enabled),
            };
            imported.normalize_save_unit_ids();
            next.games.push(imported);
        }
        Ok(next)
    }
}

impl ServiceContext {
    pub async fn upload_game_management_config(&self, confirmed: bool) -> Result<u32> {
        if !confirmed {
            bail!(
                "{}",
                rust_i18n::t!("game_config_sync.confirmation_required")
            );
        }
        let current = get_config()?;
        let (_, _, state) = cloud_bootstrap_inputs()?;
        let portable = GameManagementConfig::capture(&current, &state.current_device_id);
        let bytes = serde_json::to_vec_pretty(&portable)?;
        if bytes.len() as u64 > MAX_CONFIG_BYTES {
            bail!("{}", rust_i18n::t!("game_config_sync.too_large"));
        }
        // Validate the same format before publishing it.
        let validated: GameManagementConfig = serde_json::from_slice(&bytes)?;
        validated.apply(&current, &state.current_device_id)?;
        bound_v2_operator(&state)
            .await?
            .write(CLOUD_CONFIG_PATH, bytes)
            .await?;
        Ok(portable.games.len() as u32)
    }

    pub async fn pull_game_management_config(&self, confirmed: bool) -> Result<u32> {
        if !confirmed {
            bail!(
                "{}",
                rust_i18n::t!("game_config_sync.confirmation_required")
            );
        }
        let (_, _, state) = cloud_bootstrap_inputs()?;
        let operator = bound_v2_operator(&state).await?;
        let metadata = match operator.stat(CLOUD_CONFIG_PATH).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == opendal::ErrorKind::NotFound => {
                bail!("{}", rust_i18n::t!("game_config_sync.missing"));
            }
            Err(error) => return Err(error.into()),
        };
        if metadata.content_length() > MAX_CONFIG_BYTES {
            bail!("{}", rust_i18n::t!("game_config_sync.too_large"));
        }
        let bytes = operator.read(CLOUD_CONFIG_PATH).await?.to_vec();
        if bytes.len() as u64 > MAX_CONFIG_BYTES {
            bail!("{}", rust_i18n::t!("game_config_sync.too_large"));
        }
        let portable: GameManagementConfig = serde_json::from_slice(&bytes)?;
        let current = get_config()?;
        let next = portable.apply(&current, &state.current_device_id)?;
        // A mandatory local backup must succeed before replacing any settings.
        crate::atomic_file::write_bytes_atomically(
            &crate::app_dirs::resolve_app_path("GameSaveManager.config.before-cloud-pull.json"),
            &serde_json::to_vec_pretty(&current)?,
        )?;
        set_config_local(&next)?;
        Ok(next.games.len() as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn shared_config_excludes_local_settings_and_preserves_them_on_pull() {
        let mut current = Config {
            backup_path: "private-backup-folder".into(),
            ..Config::default()
        };
        current.settings.cloud_settings.backend = crate::cloud_sync::Backend::GitHub {
            owner: "private-owner".into(),
            repository: "private-repository".into(),
            branch: "saves".into(),
            token: "private-token-sentinel".into(),
        };
        current.games = vec![Game {
            name: "Game".into(),
            storage_key: "Game".into(),
            save_paths: vec![SaveUnit::concrete(
                1,
                crate::backup::SaveUnitType::File,
                HashMap::from([
                    ("pc".into(), "save-file".into()),
                    ("other".into(), "private-other-path".into()),
                ]),
                false,
                true,
            )],
            game_paths: HashMap::from([("pc".into(), "private-launcher".into())]),
            next_save_unit_id: 2,
            cloud_sync_enabled: false,
            auto_backup: None,
            ludusavi_meta: None,
            device_bindings: HashMap::new(),
        }];
        let portable = GameManagementConfig::capture(&current, "pc");
        let json = serde_json::to_string(&portable).unwrap();
        for private in [
            "private-backup-folder",
            "private-launcher",
            "private-other-path",
            "cloud_settings",
            "token",
            "appearance",
            "devices",
            "private-token-sentinel",
            "private-owner",
        ] {
            assert!(!json.contains(private));
        }
        let next = portable.apply(&current, "pc").unwrap();
        assert_eq!(next.backup_path, current.backup_path);
        assert_eq!(
            serde_json::to_value(&next.settings).unwrap(),
            serde_json::to_value(&current.settings).unwrap()
        );
        assert_eq!(next.games[0].game_paths, current.games[0].game_paths);
        assert_eq!(
            next.games[0].save_paths[0]
                .get_path_for_device(&"pc".into())
                .unwrap(),
            "save-file"
        );
    }

    #[test]
    fn malformed_shared_configuration_cannot_replace_local_settings() {
        let invalid = r#"{"schema_version":1,"games":[{"name":"Game","storage_key":"../escape","save_paths":[],"auto_backup":null}]}"#;
        let config: GameManagementConfig = serde_json::from_str(invalid).unwrap();
        assert!(config.apply(&Config::default(), "pc").is_err());
        assert!(
            serde_json::from_str::<GameManagementConfig>(
                r#"{"schema_version":1,"games":[],"token":"secret"}"#
            )
            .is_err()
        );
    }
}
