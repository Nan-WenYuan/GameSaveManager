import { error } from '../utils/logger';
import { isEqual } from 'lodash-unified';
import { shareUnchangedItems } from '../utils/stableCollections';
import { commands, DEFAULT_CONFIG, type Config, type DeviceGameStatus } from '../api/commands';
import { $t } from '../i18n';

const config = ref<Config>(structuredClone(DEFAULT_CONFIG));
const programVersion = ref(DEFAULT_CONFIG.version);
const deviceGameStatuses = ref<DeviceGameStatus[]>([]);
const isLoading = ref(false);
let firstLoad: Promise<boolean> | null = null;
let latestConfigRead: Promise<boolean> | null = null;
let metadataRead = 0;

async function whenConfigReady(): Promise<boolean> {
  if (!firstLoad) return refreshConfig();
  if (await firstLoad) return true;
  // App initialization can supersede the first read. Route validation must
  // await that newer read rather than treat a loading library as empty.
  return latestConfigRead ?? refreshConfig();
}
async function readConfig(libraryOnly: boolean, isCurrent = () => true): Promise<boolean> {
  const request = ++metadataRead;
  isLoading.value = true;
  try {
    const result = await commands.getLocalConfig();
    if (result.status === 'error') {
      throw new Error(result.error);
    }
    if (request !== metadataRead || !isCurrent()) return false;
    if (libraryOnly) {
      // Cloud metadata refresh must not replace local settings being edited.
      config.value.games = shareUnchangedItems(
        config.value.games,
        result.data.games,
        (game) => game.storage_key || game.name
      );
      if (!isEqual(config.value.devices, result.data.devices)) {
        config.value.devices = result.data.devices;
      }
    } else {
      config.value = result.data;
    }
    // Local configuration is already saved. Availability scans must not delay
    // names, launch paths, or closing the editor after a successful save.
    void Promise.all([commands.getBuildInfo(), commands.getCurrentDeviceGameStatuses()])
      .then(([build, statuses]) => {
        if (request !== metadataRead || !isCurrent()) return;
        programVersion.value = build.version;
        if (statuses.status === 'error') throw new Error(statuses.error);
        if (!isEqual(deviceGameStatuses.value, statuses.data)) {
          deviceGameStatuses.value = statuses.data;
        }
      })
      .catch((e) => {
        if (request === metadataRead && isCurrent()) error(`Failed to load device statuses: ${e}`);
      });
    return true;
  } catch (e) {
    if (request !== metadataRead || !isCurrent()) return false;
    error(`Failed to load config: ${e}`);
    notifyError($t('error.config_load_failed'));
    return false;
  } finally {
    if (request === metadataRead) isLoading.value = false;
  }
}

function refreshConfig(): Promise<boolean> {
  latestConfigRead = readConfig(false);
  return latestConfigRead;
}

function refreshLibraryConfig(isCurrent: () => boolean): Promise<boolean> {
  return readConfig(true, isCurrent);
}

async function saveConfig(): Promise<boolean> {
  try {
    const result = await commands.setConfig(config.value);
    if (result.status === 'error') {
      throw new Error(result.error);
    }
    return true;
  } catch (e) {
    error(`Failed to set config: ${e}`);
    notifyError($t('error.set_config_failed'));
    return false;
  }
}

firstLoad = refreshConfig();

export function useConfig() {
  const isGameVisible = (gameId: string | undefined, fallbackName?: string) => {
    const identity = gameId || fallbackName;
    return deviceGameStatuses.value.find((status) => status.game_id === identity)?.visible ?? true;
  };
  return {
    config,
    programVersion,
    deviceGameStatuses,
    isGameVisible,
    isLoading,
    refreshConfig,
    refreshLibraryConfig,
    saveConfig,
    whenConfigReady,
  };
}
