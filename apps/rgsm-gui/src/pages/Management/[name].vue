<script lang="ts" setup>
import { computed, ref, watch, onBeforeUnmount, onMounted, h } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { isEqual } from 'lodash-unified';
import {
  commands,
  events,
  type CandidateDimensions,
  type CloudArchiveGameView,
  type Device,
  type Game,
  type GameSnapshots,
  type Snapshot,
} from '../../api/commands';
import SaveLocationDrawer from '../../components/SaveLocationDrawer.vue';
import AutoSaveSettingsDrawer from '../../components/AutoSaveSettingsDrawer.vue';
import BranchTreeView from '../../components/BranchTreeView.vue';
import ExtraBackupDrawer from '../../components/ExtraBackupDrawer.vue';
import SnapshotTable from '../../components/management/SnapshotTable.vue';
import { canApplySnapshot } from '../../components/management/snapshotAvailability';
import { useDeviceHeads } from '../../components/management/useDeviceHeads';
import { useSnapshotTransfers } from '../../components/management/useSnapshotTransfers';
import { runUndoRestore } from '../../components/management/undoRestore';
import { $t } from '../../i18n';
import { error, info } from '../../utils/logger';
import {
  Cloud,
  Copy,
  Download,
  Ellipsis,
  FolderCog,
  FolderMinus,
  FolderOpen,
  GitBranch,
  List,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  ShieldCheck,
  Timer,
  Undo2,
  Upload,
  Zap,
} from '@lucide/vue';
import { compareSnapshotTime, formatSnapshotTime } from '../../utils/snapshotPresentation';
import {
  getGameManagementPath,
  getGameNameFromRouteParam,
} from '../../composables/useGameManagementRoute';
import { resolveGameReference, resolveManagementGame } from '../../utils/appRoutes';
import { useApplyConfirmation } from '../../composables/useApplyConfirmation';
import { useCloudLibrary } from '../../composables/useCloudLibrary';
import { usePathResolution } from '../../composables/usePathResolution';
import { KButton, KInput, KMenu, KSegmented, KTooltip, type KMenuEntry } from '../../ui/kit';

const { addActivity, updateActivity } = useActivityCenter();
const feedback = useFeedback();
const { config, deviceGameStatuses, refreshConfig } = useConfig();
const { confirmAndRun } = useApplyConfirmation();
const { markGamePlayed } = useSaveListSort();
const { withLoading } = useGlobalLoading();
const { startCollecting, stopCollecting } = useHostNotificationCollector();
const { preview: previewSaveUnit, rememberRestoreMapping } = usePathResolution();
const router = useRouter();
const route = useRoute();

// View mode: 'table' or 'branch'
const viewMode = ref<'table' | 'branch'>('table');

const search = ref(''); // 搜索时使用的字符串
const drawer = ref(false); // 是否显示存档位置侧栏
const extraBackupDrawer = ref(false);
const autoSaveSettingsDrawer = ref(false); // 是否显示自动保存设置抽屉

const table_data = ref<Snapshot[]>([]);
const table_data_desc = ref<Snapshot[]>([]);
const sortDesc = ref(true);
const selectedDates = ref<Set<string>>(new Set());
const retentionProtectedDates = ref<Set<string>>(new Set());
const { library: cloudLibrary, refresh: refreshCloudLibrary } = useCloudLibrary();
const cloudDefinition = computed(
  () =>
    cloudLibrary.value?.games.find(
      (item) => item.game_id === (game.value?.storage_key || game.value?.name)
    ) ?? null
);
const definitionConflict = computed(() => Boolean(cloudDefinition.value?.definition_conflict));
const cloudGame = computed(() => (definitionConflict.value ? null : cloudDefinition.value));
const choosingDefinition = ref(false);
const localCatalogDates = ref<Set<string>>(new Set());
const activeTransfer = ref('');

// Game snapshots info including HEAD
const gameSnapshots = ref<GameSnapshots | null>(null);
let backupRead = 0;

const game: Ref<Game> = ref({
  name: '',
  storage_key: '',
  save_paths: [],
  game_paths: {},
  device_bindings: {},
});
const isSharedGame = computed(() =>
  deviceGameStatuses.value.some(
    (status) => status.game_id === (game.value.storage_key || game.value.name) && status.shared
  )
);
const deleteLabel = computed(() =>
  $t(isSharedGame.value ? 'sync_settings.archives.evict.action' : 'manage.delete')
);

// 当前设备信息
const currentDevice = ref<Device | null>(null);

// 获取当前设备信息
async function fetchCurrentDevice() {
  try {
    const result = await commands.getCurrentDeviceInfo();
    if (result.status === 'ok') {
      currentDevice.value = result.data;
    } else {
      notifyError(result.error);
    }
  } catch (e) {
    error(`Error getting current device info: ${e}`);
    notifyError($t('error.get_device_info_failed'));
  }
}

// 在组件挂载时获取当前设备信息
fetchCurrentDevice();

const describe = ref('');
let backup_button_backup_limit = true; // 上次没备份好禁止再备份或读取
let apply_button_apply_limit = true; // 上次未恢复好禁止读取或备份

// 撤销上次应用的状态
interface UndoInfo {
  extraBackupDate: string;
  previousHead: string | null;
}
const undoInfo = ref<UndoInfo | null>(null);

// 撤销按钮是否可用
const canUndo = computed(() => undoInfo.value !== null);
const extraBackupEnabled = computed(() => config.value.settings.extra_backup_when_apply !== false);
const undoTooltip = computed(() => {
  if (canUndo.value) return $t('manage.undo_last_apply');
  if (!extraBackupEnabled.value) return $t('manage.undo_requires_extra_backup');
  return $t('manage.undo_not_available');
});

let stopQuickActionListener: (() => void) | null = null;

onMounted(async () => {
  try {
    stopQuickActionListener = await events.quickActionCompleted.listen(async (event) => {
      const payload = event.payload;
      if (
        payload.status === 'Success' &&
        payload.operation === 'Backup' &&
        payload.game_name &&
        payload.game_name === game.value.name
      ) {
        await refresh_backups_info();
      }
    });
  } catch (e) {
    error(`Failed to listen quick action events: ${e}`);
  }
});

onBeforeUnmount(() => {
  if (stopQuickActionListener) {
    stopQuickActionListener();
    stopQuickActionListener = null;
  }
});

const pendingDeletions = computed(() => cloudGame.value?.pending_deletions ?? []);
async function batch_delete() {
  try {
    const ownership = await commands.getCurrentDeviceGameStatuses();
    if (ownership.status === 'error') {
      notifyError(ownership.error);
      return;
    }
    const global = ownership.data.some(
      (status) => status.game_id === (game.value.storage_key || game.value.name) && status.shared
    );
    if (global) {
      await batchEvict();
      return;
    }
    const promptResult = await feedback.prompt($t('manage.batch_delete_prompt'), $t('home.hint'), {
      confirmButtonText: $t('manage.confirm'),
      cancelButtonText: $t('manage.cancel'),
      inputPattern: /yes/,
      inputErrorMessage: $t('manage.invalid_input_error'),
    });

    if (promptResult.value === 'yes') {
      const dates = selected_game_snapshots.value.map((item) => item.date);
      const deleteResult = await commands.batchDeleteSnapshots(game.value, dates);
      await refresh_backups_info();
      if (deleteResult.status === 'ok') {
        notifySuccess($t('manage.batch_delete_success', { count: dates.length }));
      } else {
        notifyError(deleteResult.error);
      }
    } else {
      notifyInfo($t('manage.invalid_input_error'));
    }
  } catch {
    notifyError($t('manage.operation_canceled'));
  }
}

const autoSaveConfigured = computed(() => isAutoSaveConfigured(config.value, game.value));

async function onAutoSaveSettingsSaved() {
  await refreshConfig();
  const latestGame = config.value.games.find((item) => item.storage_key === game.value.storage_key);
  if (latestGame) {
    game.value = latestGame;
  }
  await refresh_backups_info();
}

// Init game info
watch(
  () => route.fullPath,
  (path) => {
    const selected = resolveManagementGame(config.value.games, path);
    if (!selected) return;
    game.value = selected;
    gameSnapshots.value = null;
    table_data.value = [];
    table_data_desc.value = [];
    localCatalogDates.value = new Set();
    undoInfo.value = null;
    retentionProtectedDates.value = new Set();
    selectedDates.value = new Set();
    void refresh_backups_info(false);
    // 检查当前设备的存档路径是否为空
  },
  { immediate: true }
);

async function refresh_backups_info(refreshCloud = false) {
  const request = ++backupRead;
  const target = game.value;
  if (!target?.name) return;
  // Publish local changes before remote metadata reads; an offline/slow cloud
  // connection must not hide a backup that was already saved on this device.
  const [result, local] = await Promise.all([
    commands.getGameSnapshotsInfo(target),
    commands.getLocalBackupsInfo(target),
  ]);
  if (request !== backupRead || target.storage_key !== game.value?.storage_key) return;
  if (result.status === 'error') {
    notifyError(result.error);
    return;
  }
  if (local.status === 'error') {
    notifyError(local.error);
    return;
  }
  const cloud = cloudGame.value;
  const merged = mergeCloudOnlySnapshots(local.data.backups, cloud);
  localCatalogDates.value = new Set(local.data.backups.map((snapshot) => snapshot.date));
  const next = { ...result.data, backups: merged };
  if (!isEqual(gameSnapshots.value, next)) {
    gameSnapshots.value = next;
    table_data.value = merged;
    table_data_desc.value = [...merged].reverse();
  }
  selectedDates.value = refreshCloud
    ? new Set()
    : new Set(
        [...selectedDates.value].filter((id) => merged.some((snapshot) => snapshot.date === id))
      );
  retentionProtectedDates.value = new Set(
    cloud?.snapshots
      .filter((snapshot) => snapshot.retention_protected)
      .map((snapshot) => snapshot.snapshot_id) ?? []
  );
  if (refreshCloud) await refreshCloudLibrary(true);
}

watch(cloudLibrary, (current, previous) => {
  const gameId = game.value.storage_key || game.value.name;
  const before = previous?.games.find((item) => item.game_id === gameId);
  const after = current?.games.find((item) => item.game_id === gameId);
  if (!isEqual(before, after)) void refresh_backups_info(false);
});

watch(
  () => config.value.games.find((item) => item.storage_key === game.value?.storage_key),
  (latest) => {
    if (latest && latest !== game.value) {
      game.value = latest;
      void refresh_backups_info(false);
    } else if (!latest && game.value?.name) {
      // Remote deletion must not leave actions bound to an obsolete definition.
      void router.replace('/');
    }
  }
);

async function onDefinitionSelected() {
  const gameId = game.value.storage_key;
  await refreshConfig();
  const selected = config.value.games.find((item) => item.storage_key === gameId);
  if (selected) await router.replace(getGameManagementPath(selected));
  await refreshCloudLibrary(true);
}

function mergeCloudOnlySnapshots(
  local: Snapshot[],
  cloud: CloudArchiveGameView | null
): Snapshot[] {
  if (!cloud) return [...local].sort(compareSnapshotTime);
  const known = new Set(local.map((snapshot) => snapshot.date));
  const extras = cloud.snapshots
    .filter(
      (snapshot) =>
        !known.has(snapshot.snapshot_id) &&
        (snapshot.cloud_verified || snapshot.reported_on_devices.length > 0)
    )
    .map((snapshot) => ({
      date: snapshot.snapshot_id,
      describe: snapshot.description,
      path: '',
      size: snapshot.size ?? 0,
      created_by: snapshot.created_by,
      created_at: snapshot.created_at,
      device_id: snapshot.device_id,
      parent: snapshot.parent,
    }));
  return [...local, ...extras].sort(compareSnapshotTime);
}

const { currentHead, branchDeviceHeads } = useDeviceHeads({
  gameSnapshots,
  tableData: table_data,
  currentDevice,
  config,
  cloudGame,
});
const packageHeadMarkers = computed(() =>
  branchDeviceHeads.value
    .filter((entry) => entry.isCurrentDevice)
    .map((entry) => ({
      ...entry,
      label: $t('personal.current_backup'),
      tooltip: $t('personal.current_backup'),
    }))
);

const {
  selectedUploadable,
  selectedDownloadable,
  selectedEvictable,
  transferSnapshot,
  retryPendingDeletion,
  evictSnapshot,
  evictCloudSnapshot,
  batchTransfer,
  batchEvict,
  convertToPermanent,
} = useSnapshotTransfers({
  game,
  cloudGame,
  localCatalogDates,
  activeTransfer,
  retentionProtectedDates,
  selected: () => selected_game_snapshots.value,
  allSnapshots: () => table_data.value,
  snapshotLabel: formatSnapshotPromptLine,
  refresh: (refreshCloud = true) => refresh_backups_info(refreshCloud),
});

const backupDirectory = ref('');
const gameLaunchPath = computed(() =>
  currentDevice.value ? game.value.game_paths?.[currentDevice.value.id]?.trim() || '' : ''
);
const showAdvancedViews = ref(false);
watch(
  () => [game.value.storage_key, config.value.backup_path],
  async () => {
    backupDirectory.value = '';
    const result = await commands.getBackupDirectory(game.value).catch(() => null);
    if (result?.status === 'ok') backupDirectory.value = result.data;
  },
  { immediate: true }
);

function backupSuccessMessage() {
  if (backupDirectory.value) return $t('personal.backup_saved_to', { path: backupDirectory.value });
  if (cloudGame.value?.sync_mode === 'manual') return $t('personal.local_backup_created');
  const backendEnabled = config.value?.settings.cloud_settings?.backend?.type !== 'Disabled';
  return backendEnabled && game.value.cloud_sync_enabled !== false
    ? $t('manage.backup_success_with_sync')
    : $t('manage.backup_success');
}

function formatSnapshotPromptLine(date: string) {
  const snapshot = table_data.value.find((item) => item.date === date);
  const formatted = formatSnapshotTime(snapshot ?? { date }) ?? $t('manage.unknown_snapshot_time');
  const description = snapshot?.describe?.trim();
  return [formatted, description].filter(Boolean).join(' · ');
}

async function resolveParentForNewSnapshot(): Promise<string | null> {
  if (!currentDevice.value) await fetchCurrentDevice();
  return currentHead.value ?? null;
}

async function send_save_to_background() {
  if (!backup_button_backup_limit) {
    notifyError($t('manage.last_backup_unfinished_error'));
    return;
  }
  if (!apply_button_apply_limit) {
    notifyError($t('manage.last_overwrite_unfinished_error'));
    return;
  }

  const parentDate = await resolveParentForNewSnapshot();
  if (parentDate === undefined) {
    return;
  }

  backup_button_backup_limit = false;

  const activityId = addActivity({
    title: $t('manage.creating_backup'),
    status: 'running',
    acceptsStageUpdates: true,
  });
  try {
    await withLoading(
      async () => {
        const result = await commands.createSnapshotAt(game.value, describe.value, parentDate);
        if (result.status === 'error') {
          updateActivity(activityId, {
            status: 'error',
            title: $t('error.backup_failed'),
            description: result.error,
          });
        } else {
          updateActivity(activityId, { status: 'success', title: backupSuccessMessage() });
        }
      },
      $t('manage.creating_backup'),
      $t('manage.wait_for_prompt_hint')
    );
  } catch {
    updateActivity(activityId, { status: 'error', title: $t('error.backup_failed') });
  }
  backup_button_backup_limit = true;
  refresh_backups_info();

  describe.value = '';
}

async function create_new_save() {
  // Description is optional; the main path must stay one click.
  send_save_to_background();
}

async function launch_game() {
  // 获取当前设备的游戏路径
  let gamePath = '';
  if (currentDevice.value && game.value.game_paths) {
    gamePath = game.value.game_paths[currentDevice.value.id] || '';
  }

  if (!gamePath) {
    notifyError($t('manage.no_launch_path_error'));
    return;
  } else {
    const result = await commands.openFileOrFolder(gamePath);
    if (result.status === 'error') {
      notifyError(result.error);
    } else {
      markGamePlayed(game.value);
    }
  }
}

async function del_save(date: string) {
  try {
    const ownership = await commands.getCurrentDeviceGameStatuses();
    if (ownership.status === 'error') {
      notifyError(ownership.error);
      return;
    }
    let result;
    if (
      ownership.data.some(
        (status) => status.game_id === (game.value.storage_key || game.value.name) && status.shared
      )
    ) {
      await evictSnapshot(date);
      return;
    } else {
      // 行内 popconfirm 移除后，本地命名空间也走统一破坏性确认
      await feedback.confirm($t('manage.confirm_delete_prompt'), $t('manage.delete'), {
        confirmButtonText: $t('manage.delete'),
        cancelButtonText: $t('manage.cancel'),
        type: 'warning',
      });
      result = await commands.deleteSnapshot(game.value, date);
    }
    if (result.status === 'error') {
      notifyError(result.error);
      return;
    }
    await refresh_backups_info();
    notifySuccess($t('manage.delete_success'));
  } catch (e) {
    info(`Snapshot deletion cancelled or interrupted: ${e}`);
  }
}

async function handleApplyClick(date: string) {
  if (!canApplySnapshot(localCatalogDates.value, cloudGame.value, date)) {
    notifyError($t('manage.download_before_apply'));
    return;
  }
  await confirmAndRun('snapshot', () => apply_save(date));
}

async function apply_save(date: string) {
  if (!apply_button_apply_limit) {
    notifyError($t('manage.last_overwrite_unfinished_error'));
    return;
  }
  if (!backup_button_backup_limit) {
    notifyError($t('manage.last_backup_unfinished_error'));
    return;
  }
  apply_button_apply_limit = false;

  // 记录应用前的 HEAD，用于撤销
  const previousHead = currentHead.value ?? null;

  // 记录应用前最新额外备份的 date，用于验证新备份是否成功创建
  let latestExtraDateBefore: string | null = null;
  if (extraBackupEnabled.value) {
    try {
      const beforeResult = await commands.getGameExtraBackups(game.value);
      if (beforeResult.status === 'ok' && beforeResult.data.length > 0 && beforeResult.data[0]) {
        latestExtraDateBefore = beforeResult.data[0].date;
      }
    } catch {
      // ignore
    }
  }

  let integrityFailed = false;
  let restoreError = '';
  let mappingError: {
    saveUnitId: number;
    sourceDimensions: CandidateDimensions;
  } | null = null;

  const activityId = addActivity({
    title: $t('manage.restoring_backup'),
    status: 'running',
    acceptsStageUpdates: true,
  });
  startCollecting();
  try {
    await withLoading(
      async () => {
        const result = await commands.restoreSnapshot(game.value, date);
        if (result.status === 'error') {
          const err = result.error;
          if (err.type === 'IntegrityCheckFailed') {
            integrityFailed = true;
          } else if (err.type === 'BackupNotFound') {
            restoreError = $t('manage.backup_not_found', { date: err.date });
          } else if (err.type === 'RestoreMappingRequired' || err.type === 'StaleRestoreMapping') {
            mappingError = {
              saveUnitId: err.save_unit_id,
              sourceDimensions: err.source_dimensions,
            };
          } else {
            restoreError = err.message;
          }
        } else {
          // 验证最新额外备份已更新（date 不同），才启用撤销
          if (extraBackupEnabled.value) {
            try {
              const extraResult = await commands.getGameExtraBackups(game.value);
              if (extraResult.status === 'ok' && extraResult.data.length > 0) {
                const latestExtra = extraResult.data[0];
                if (latestExtra && latestExtra.date !== latestExtraDateBefore) {
                  undoInfo.value = {
                    extraBackupDate: latestExtra.date,
                    previousHead,
                  };
                }
              }
            } catch (e) {
              error(`Failed to get extra backups for undo: ${e}`);
            }
          }
        }
      },
      $t('manage.restoring_backup'),
      $t('manage.wait_for_prompt_hint')
    );
  } catch {
    stopCollecting();
    updateActivity(activityId, { status: 'error', title: $t('manage.recover_failed') });
    apply_button_apply_limit = true;
    refresh_backups_info();
    return;
  }
  const collectedNotifications = stopCollecting();
  apply_button_apply_limit = true;
  refresh_backups_info();

  // Show error dialogs after loading overlay is dismissed
  if (integrityFailed) {
    updateActivity(activityId, { status: 'error', title: $t('manage.integrity_failed_title') });
    try {
      await feedback.alert(
        $t('manage.integrity_failed_detail'),
        $t('manage.integrity_failed_title'),
        { type: 'error', confirmButtonText: $t('manage.confirm') }
      );
    } catch {
      // dialog dismissed
    }
  } else if (mappingError) {
    updateActivity(activityId, { status: 'error', title: $t('manage.choose_restore_location') });
    const mapped = await chooseRestoreLocation(mappingError);
    if (mapped) {
      await apply_save(date);
    }
  } else if (restoreError) {
    updateActivity(activityId, {
      status: 'error',
      title: $t('manage.recover_failed'),
      description: restoreError,
    });
  } else {
    // Consolidate success + any backend warnings into a single activity entry
    const warnings = collectedNotifications.filter((n) => n.level === 'warning');
    if (warnings.length > 0) {
      updateActivity(activityId, {
        status: 'success',
        title: $t('manage.recover_success_with_warnings', { count: warnings.length }),
        description: undefined,
        autoDismissMs: 5000,
      });
    } else {
      updateActivity(activityId, { status: 'success', title: $t('manage.recover_success') });
    }
  }
}

async function chooseRestoreLocation(mapping: {
  saveUnitId: number;
  sourceDimensions: CandidateDimensions;
}): Promise<boolean> {
  const unit = game.value.save_paths.find((candidate) => candidate.id === mapping.saveUnitId);
  if (!unit) return false;
  const preview = await previewSaveUnit(game.value, unit);
  if (!preview || preview.candidates.length === 0) {
    notifyError($t('manage.no_restore_locations'));
    return false;
  }
  const choices = preview.candidates
    .map((candidate, index) => `${index + 1}. ${candidate.expression}`)
    .join('\n');
  try {
    const { value } = await feedback.prompt(
      `${$t('manage.choose_restore_location_hint')}\n\n${choices}`,
      $t('manage.choose_restore_location'),
      { inputPlaceholder: '1' }
    );
    const index = Number(value) - 1;
    const selected = preview.candidates[index];
    if (!selected) {
      notifyWarning($t('manage.invalid_restore_location'));
      return false;
    }
    const result = await rememberRestoreMapping(
      game.value,
      mapping.saveUnitId,
      mapping.sourceDimensions,
      [selected.id]
    );
    if (result.status === 'error') {
      notifyError(result.error);
      return false;
    }
    await refreshConfig();
    const refreshedGame = config.value.games.find(
      (item) => item.storage_key === game.value.storage_key
    );
    if (refreshedGame) {
      game.value = refreshedGame;
    }
    return true;
  } catch {
    return false;
  }
}

async function undo_last_apply() {
  if (!undoInfo.value) return;

  try {
    await feedback.confirm($t('manage.undo_confirm'), $t('manage.warning'), {
      confirmButtonText: $t('manage.confirm'),
      cancelButtonText: $t('manage.cancel'),
      type: 'warning',
    });
  } catch {
    return;
  }

  const { extraBackupDate, previousHead } = undoInfo.value;

  const activityId = addActivity({ title: $t('manage.restoring_backup'), status: 'running' });
  try {
    await withLoading(async () => {
      const result = await runUndoRestore(
        () => commands.restoreExtraBackup(game.value, extraBackupDate),
        async () => {
          // Clearing an originally absent HEAD is not yet supported by the API.
          return previousHead
            ? commands.setSnapshotHead(game.value, previousHead)
            : { status: 'ok' };
        }
      );
      if (result.status === 'ok' || result.stage === 'position') {
        // Files were restored. Do not offer another file overwrite to retry
        // a failed position update.
        undoInfo.value = null;
      }
      if (result.status === 'error') {
        error(`Undo ${result.stage} failed: ${result.error}`);
        updateActivity(activityId, {
          status: 'error',
          title: $t(
            result.stage === 'position' ? 'manage.undo_position_failed' : 'manage.undo_failed'
          ),
        });
        return;
      }
      updateActivity(activityId, { status: 'success', title: $t('manage.undo_success') });
    }, $t('manage.restoring_backup'));
  } catch {
    updateActivity(activityId, { status: 'error', title: $t('manage.undo_failed') });
  }

  refresh_backups_info();
}

async function change_describe(date: string) {
  if (!localCatalogDates.value.has(date)) return;
  try {
    const snapshot = table_data.value.find((x) => x.date == date);
    const { value } = await feedback.prompt(
      $t('manage.input_description_prompt'),
      $t('manage.change_description'),
      {
        confirmButtonText: $t('manage.confirm'),
        cancelButtonText: $t('manage.cancel'),
        inputValue: snapshot?.describe,
      }
    );
    const result = await commands.setSnapshotDescription(game.value, date, value);
    if (result.status === 'error') {
      notifyError($t('manage.change_description_failed'));
      return;
    }
    refresh_backups_info();
    notifySuccess($t('manage.change_description_success'));
  } catch {
    notifyInfo($t('manage.operation_canceled'));
  }
}

async function load_latest_save() {
  const lastBackup = [...table_data.value]
    .reverse()
    .find((snapshot) => canApplySnapshot(localCatalogDates.value, cloudGame.value, snapshot.date));

  if (lastBackup?.date) {
    await confirmAndRun('latest', () => apply_save(lastBackup.date));
  } else {
    notifyError($t('manage.no_backup_error'));
  }
}

async function open_backup_folder() {
  const result = await commands.openBackupFolder(game.value);
  if (result.status === 'error') {
    notifyError($t('error.open_backup_folder_failed'));
  }
}

async function verify_archive_hashes() {
  const snapshots = table_data.value.filter((s) => s.archive_hash);
  if (snapshots.length === 0) {
    notifyInfo($t('manage.verify_no_hashes'));
    return;
  }

  let passed = 0;
  const failedSnapshots: string[] = [];

  const activityId = addActivity({ title: $t('manage.verifying_archives'), status: 'running' });
  try {
    await withLoading(async () => {
      for (const snapshot of snapshots) {
        const result = await commands.verifyArchiveIntegrity(
          snapshot.path,
          snapshot.archive_hash ?? null
        );
        if (result.status === 'ok' && result.data) {
          passed++;
        } else {
          failedSnapshots.push(snapshot.date);
        }
      }
    }, $t('manage.verifying_archives'));
  } catch {
    updateActivity(activityId, { status: 'error', title: $t('manage.verify_failed_title') });
    return;
  }

  // Show results after loading overlay is dismissed
  if (failedSnapshots.length === 0) {
    updateActivity(activityId, {
      status: 'success',
      title: $t('manage.verify_all_passed', { count: passed }),
    });
  } else {
    updateActivity(activityId, { status: 'error', title: $t('manage.verify_failed_title') });
    const messageVNode = h('div', [
      h('p', $t('manage.verify_failed_summary', { passed, failed: failedSnapshots.length })),
      h(
        'ul',
        { style: 'max-height:200px;overflow-y:auto;padding-left:20px;margin:8px 0' },
        failedSnapshots.map((d) => h('li', { style: 'font-family:monospace;margin:2px 0' }, d))
      ),
      h('p', { style: 'color:#909399;font-size:12px' }, $t('manage.verify_failed_hint')),
    ]);
    try {
      await feedback.alert(messageVNode, $t('manage.verify_failed_title'), {
        type: 'error',
        confirmButtonText: $t('manage.verify_select_corrupted'),
      });
      // User clicked "Select corrupted" — select those snapshots in the table
      selectedDates.value = new Set(failedSnapshots);
    } catch {
      // dialog dismissed via close button
    }
  }
}

// 设置快速备份，由快捷键和tray触发备份和恢复
const isQuickBackupGame = computed(() => {
  const identity = config.value.quick_action?.quick_action_game_id;
  if (!identity) return false;
  const selected =
    config.value.games.find((item) => item.storage_key === identity) ??
    resolveGameReference(config.value.games, identity);
  return selected?.storage_key === game.value.storage_key;
});

async function set_quick_backup() {
  const result = await commands.setQuickBackupGame(game.value);
  if (result.status === 'error') {
    notifyError($t('manage.set_quick_backup_failed'));
    return;
  }
  await refreshConfig();
  notifySuccess($t('manage.set_quick_backup_success'));
}

// 处理抽屉组件保存游戏路径的事件
async function on_drawer_save_changes(updatedGame: Game) {
  try {
    const result = await commands.updateGame(game.value.storage_key ?? game.value.name, {
      name: updatedGame.name,
      save_paths: updatedGame.save_paths,
      game_paths: updatedGame.game_paths ?? {},
      ludusavi_meta: updatedGame.ludusavi_meta ?? null,
      device_bindings: updatedGame.device_bindings ?? {},
    });

    if (result.status === 'error') {
      notifyError(result.error);
      return;
    }

    await refreshConfig();
    notifySuccess($t('manage.save_paths_updated'));
    drawer.value = false;

    const currentRouteGameName = getGameNameFromRouteParam(
      'name' in route.params ? route.params.name : undefined
    );
    if (updatedGame.name !== currentRouteGameName) {
      await router.replace(getGameManagementPath(updatedGame));
    } else {
      const refreshedGame = config.value.games.find(
        (g) => g.storage_key === updatedGame.storage_key
      );
      if (refreshedGame) {
        game.value = refreshedGame;
      }
    }
  } catch (e) {
    error(`Error saving game paths: ${e}`);
    notifyError($t('error.save_config_failed'));
  }
}

const orderedTableData = computed(() =>
  sortDesc.value ? table_data_desc.value : table_data.value
);

const filter_table = computed(() => {
  const keyword = search.value.trim();
  if (!keyword) {
    return orderedTableData.value;
  }

  return orderedTableData.value.filter(
    (data) => formatSnapshotPromptLine(data.date).includes(keyword) || data.date.includes(keyword)
  );
});

const selected_game_snapshots = computed<Snapshot[]>(() => {
  if (selectedDates.value.size === 0) {
    return [];
  }
  return filter_table.value.filter((snapshot) => selectedDates.value.has(snapshot.date));
});

function toggleSnapshotSelection(date: string, checked: boolean) {
  const next = new Set(selectedDates.value);
  if (checked) {
    next.add(date);
  } else {
    next.delete(date);
  }
  selectedDates.value = next;
}

function toggleSelectAll(checked: boolean) {
  if (checked) {
    selectedDates.value = new Set(filter_table.value.map((snapshot) => snapshot.date));
    return;
  }
  selectedDates.value = new Set();
}

watch(filter_table, (rows) => {
  if (selectedDates.value.size === 0) return;
  const visibleDates = new Set(rows.map((snapshot) => snapshot.date));
  const next = new Set<string>();
  let changed = false;

  for (const date of selectedDates.value) {
    if (visibleDates.has(date)) {
      next.add(date);
    } else {
      changed = true;
    }
  }

  if (changed) {
    selectedDates.value = next;
  }
});

async function onSetHead(date: string) {
  try {
    const result = await commands.setSnapshotHead(game.value, date);
    if (result.status === 'error') {
      notifyError($t('manage.set_head_failed'));
    } else {
      notifySuccess($t('manage.set_head_success'));
      await refresh_backups_info();
    }
  } catch (e) {
    error(`Failed to set HEAD: ${e}`);
    notifyError($t('manage.set_head_failed'));
  }
}

async function onDetach(date: string) {
  try {
    const result = await commands.detachSnapshot(game.value, date);
    if (result.status === 'error') {
      notifyError($t('manage.detach_failed'));
    } else {
      notifySuccess($t('manage.detach_success'));
      await refresh_backups_info();
    }
  } catch (e) {
    error(`Failed to detach snapshot: ${e}`);
    notifyError($t('manage.detach_failed'));
  }
}

async function onCreateBranch(parentDate: string) {
  try {
    const { value } = await feedback.prompt(
      $t('manage.input_description_prompt'),
      $t('manage.create_branch'),
      {
        confirmButtonText: $t('manage.confirm'),
        cancelButtonText: $t('manage.cancel'),
      }
    );

    await withLoading(async () => {
      const result = await commands.createSnapshotAt(game.value, value || '', parentDate);
      if (result.status === 'error') {
        notifyError(result.error);
      } else {
        notifySuccess(backupSuccessMessage());
        await refresh_backups_info();
      }
    }, $t('manage.creating_backup'));
  } catch {
    // User cancelled
  }
}

const syncParticipationLabel = computed(() => {
  const next = cloudGame.value;
  if (!next) return '';
  if (!next.managed) return $t('sync_settings.overview.unmanaged');
  if (!next.cloud_sync_enabled) return $t('sync_settings.overview.status_disabled');
  const mode = next.sync_mode;
  if (mode === 'multi_device_sync') {
    return $t('sync_settings.overview.mode_live');
  }
  if (mode === 'cloud_backup') {
    return $t('sync_settings.overview.mode_snapshot');
  }
  return $t('sync_settings.overview.mode_manual');
});

// 头部工具区：低频/破坏性动作收纳进溢出菜单，主按钮只留高频
const headerMenuEntries = computed<KMenuEntry[]>(() => [
  { type: 'item', key: 'openFolder', label: $t('manage.open_backup_folder'), icon: FolderOpen },
  { type: 'item', key: 'verify', label: $t('manage.verify_archive_hashes'), icon: ShieldCheck },
  { type: 'item', key: 'extraBackups', label: $t('manage.extra_backups'), icon: Copy },
  {
    type: 'item',
    key: 'quickBackup',
    label: $t('manage.set_quick_backup'),
    icon: Zap,
    active: isQuickBackupGame.value,
  },
  {
    type: 'item',
    key: 'autoSave',
    label: $t('manage.auto_save_settings'),
    icon: Timer,
    active: autoSaveConfigured.value,
  },
]);

function onHeaderMenuSelect(key: string) {
  if (key === 'openFolder') open_backup_folder();
  else if (key === 'verify') verify_archive_hashes();
  else if (key === 'extraBackups') extraBackupDrawer.value = true;
  else if (key === 'quickBackup') set_quick_backup();
  else if (key === 'autoSave') autoSaveSettingsDrawer.value = true;
}

const viewModeOptions = computed(() => [
  { value: 'table' as const, label: $t('manage.table_view'), icon: List },
  { value: 'branch' as const, label: $t('manage.branch_view'), icon: GitBranch },
]);
</script>

<template>
  <div class="flex h-[calc(100vh-40px)] flex-col gap-4 overflow-hidden">
    <!-- Page Header -->
    <div class="flex shrink-0 items-center justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="flex h-5 w-5 shrink-0 items-center justify-center text-text-dim">
            <KTooltip v-if="cloudGame" :content="syncParticipationLabel">
              <span
                role="img"
                :aria-label="syncParticipationLabel"
                tabindex="0"
                class="inline-flex"
              >
                <Cloud :size="17" aria-hidden="true" />
              </span>
            </KTooltip>
          </span>
          <h2 class="truncate text-lg font-semibold text-text">{{ game.name }}</h2>
        </div>
        <button
          v-if="definitionConflict"
          class="mt-1 block border-none bg-transparent p-0 text-xs text-warning"
          @click="choosingDefinition = true"
        >
          {{ $t('sync_settings.library.definitions.action') }}
        </button>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <KButton variant="default" @click="launch_game">
          <template #icon><Play :size="14" aria-hidden="true" /></template>
          {{ $t('manage.launch_game') }}
        </KButton>
        <KButton variant="default" @click="drawer = true">
          <template #icon><FolderCog :size="14" aria-hidden="true" /></template>
          {{ $t('manage.show_drawer') }}
        </KButton>
        <KMenu
          :entries="headerMenuEntries"
          :aria-label="$t('manage.more_actions')"
          @select="onHeaderMenuSelect"
        >
          <KButton variant="ghost" :aria-label="$t('manage.more_actions')">
            <template #icon><Ellipsis :size="16" aria-hidden="true" /></template>
          </KButton>
        </KMenu>
      </div>
    </div>

    <div
      class="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs"
    >
      <div class="min-w-0 flex-1 space-y-1 break-all text-text-dim">
        <div v-if="gameLaunchPath">
          {{ $t('save_location_drawer.launch_path') }}: {{ gameLaunchPath }}
        </div>
        <div>
          {{ $t('personal.backup_directory') }}: {{ backupDirectory || $t('personal.loading') }}
        </div>
      </div>
      <KButton size="sm" @click="open_backup_folder">{{ $t('manage.open_backup_folder') }}</KButton>
    </div>

    <!-- Quick Actions -->
    <section
      class="flex shrink-0 items-center gap-3 rounded-md border border-border bg-surface p-3"
    >
      <KInput
        v-model="describe"
        class="flex-1"
        :placeholder="$t('manage.input_description_prompt')"
        :aria-label="$t('manage.input_description_prompt')"
        @keyup.enter="create_new_save"
      />
      <KButton variant="primary" @click="create_new_save">
        <template #icon><Plus :size="14" aria-hidden="true" /></template>
        {{ $t('manage.create_new_save') }}
      </KButton>
      <div class="h-6 w-px shrink-0 bg-border" aria-hidden="true" />
      <KButton variant="default" @click="load_latest_save">
        <template #icon><RotateCcw :size="14" aria-hidden="true" /></template>
        {{ $t('manage.load_latest_save') }}
      </KButton>
      <KTooltip :content="undoTooltip" side="bottom">
        <KButton
          variant="ghost"
          :aria-label="undoTooltip"
          :disabled="!canUndo"
          @click="undo_last_apply"
        >
          <template #icon><Undo2 :size="15" aria-hidden="true" /></template>
        </KButton>
      </KTooltip>
    </section>

    <!-- Main Content -->
    <section class="flex min-h-0 flex-1 flex-col rounded-md border border-border bg-surface">
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <details
          class="text-xs text-text-dim"
          @toggle="
            showAdvancedViews = ($event.target as HTMLDetailsElement).open;
            if (!showAdvancedViews) viewMode = 'table';
          "
        >
          <summary class="cursor-pointer">{{ $t('personal.advanced_views') }}</summary>
          <KSegmented
            v-model="viewMode"
            :options="viewModeOptions"
            :aria-label="$t('manage.table_view')"
            class="mt-2 w-52"
          />
        </details>

        <KInput
          v-if="viewMode === 'table'"
          v-model="search"
          class="w-48"
          :placeholder="$t('manage.input_description_search_prompt')"
          :aria-label="$t('manage.input_description_search_prompt')"
        />

        <template v-if="viewMode === 'table'">
          <KButton v-if="selectedDownloadable.length > 0" size="sm" @click="batchTransfer(false)">
            <template #icon><Download :size="13" aria-hidden="true" /></template>
            {{ $t('manage.batch_download') }}
          </KButton>
          <KButton v-if="selectedEvictable.length > 0" size="sm" @click="batchEvict()">
            <template #icon><FolderMinus :size="13" aria-hidden="true" /></template>
            {{ $t('manage.batch_evict') }}
          </KButton>
          <KButton v-if="selectedUploadable.length > 0" size="sm" @click="batchTransfer(true)">
            <template #icon><Upload :size="13" aria-hidden="true" /></template>
            {{ $t('manage.batch_upload') }}
          </KButton>
          <KButton
            v-if="selected_game_snapshots.length > 0"
            size="sm"
            variant="danger"
            @click="batch_delete()"
          >
            {{ isSharedGame ? deleteLabel : $t('manage.batch_delete') }}
          </KButton>
        </template>
      </div>

      <div
        v-if="pendingDeletions.length"
        class="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5"
      >
        <div
          v-for="deletion in pendingDeletions"
          :key="deletion.snapshot_id"
          class="flex items-center justify-between gap-3 rounded-sm border border-[color-mix(in_oklab,var(--warning)_35%,transparent)] bg-[color-mix(in_oklab,var(--warning)_10%,transparent)] px-3 py-2"
        >
          <div class="min-w-0">
            <div class="truncate text-sm font-medium text-text">
              {{ deletion.description || deletion.snapshot_id }}
            </div>
            <div class="text-xs text-text-dim">
              {{ $t('sync_settings.archives.deletion_pending') }}
            </div>
          </div>
          <KButton
            v-if="deletion.retryable"
            size="sm"
            :loading="activeTransfer === deletion.snapshot_id"
            @click="retryPendingDeletion(deletion.snapshot_id, deletion.retryable)"
          >
            <template #icon><RotateCw :size="13" aria-hidden="true" /></template>
            {{ $t('sync_settings.archives.retry_delete') }}
          </KButton>
          <span v-else class="shrink-0 text-xs text-text-dim">{{
            $t('sync_settings.archives.deletion_waiting')
          }}</span>
        </div>
      </div>

      <!-- Table View -->
      <div v-if="viewMode === 'table'" class="h-full min-h-0 flex-1 overflow-hidden">
        <SnapshotTable
          :time-format="config.settings.appearance?.snapshot_time_format"
          :current-head="currentHead"
          :delete-label="deleteLabel"
          :devices="config.devices"
          :rows="filter_table"
          :sort-desc="sortDesc"
          :selected-dates="selectedDates"
          :cloud-game="cloudGame"
          :local-catalog-dates="localCatalogDates"
          :retention-protected-dates="retentionProtectedDates"
          :active-transfer="activeTransfer"
          @toggle-sort="sortDesc = !sortDesc"
          @toggle-select="toggleSnapshotSelection"
          @toggle-select-all="toggleSelectAll"
          @apply="handleApplyClick"
          @remove="del_save"
          @change-describe="change_describe"
          @convert-permanent="convertToPermanent"
          @evict="evictSnapshot"
          @evict-cloud="evictCloudSnapshot"
          @download="transferSnapshot($event, false)"
          @upload="transferSnapshot($event, true)"
        />
      </div>

      <!-- Branch View -->
      <div v-else class="h-full min-h-0 flex-1 overflow-hidden bg-surface-2">
        <BranchTreeView
          v-if="viewMode === 'branch'"
          :delete-label="deleteLabel"
          :devices="config.devices"
          :snapshots="table_data"
          :current-head="currentHead"
          :device-heads="packageHeadMarkers"
          :editable-dates="[...localCatalogDates]"
          @apply="handleApplyClick"
          @delete="del_save"
          @change-description="change_describe"
          @set-head="onSetHead"
          @detach="onDetach"
          @create-branch="onCreateBranch"
        />
      </div>
    </section>

    <!-- Drawer -->
    <save-location-drawer
      v-if="game"
      v-model="drawer"
      :game="game"
      @closed="drawer = false"
      @save-changes="on_drawer_save_changes"
    />

    <ExtraBackupDrawer v-if="game" v-model="extraBackupDrawer" :game="game" />
    <CloudLibraryJoinDialog
      v-model="choosingDefinition"
      :game-id="game.storage_key"
      @joined="onDefinitionSelected"
    />
    <AutoSaveSettingsDrawer
      v-model="autoSaveSettingsDrawer"
      :game="game"
      :cloud-game="cloudGame"
      @saved="onAutoSaveSettingsSaved"
    />
  </div>
</template>
