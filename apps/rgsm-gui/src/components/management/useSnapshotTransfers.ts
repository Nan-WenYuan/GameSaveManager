import { computed, type Ref } from 'vue';
import { commands, type CloudArchiveGameView, type Game, type Snapshot } from '../../api/commands';
import { $t } from '../../i18n';
import { startCloudTransfer } from '../../composables/useCloudTransferProgress';
import {
  canDownloadSnapshot,
  canEvictSnapshot,
  canUploadSnapshot,
  cloudSnapshotOf,
  isRetentionProtectedDate,
  isSnapshotOnDevice,
} from './snapshotAvailability';

/**
 * Cloud archive row operations for the management page: single-snapshot
 * transfers (up/download/evict/remove), pending-deletion retry, retention
 * protection, and the selection-driven batch variants. Local lifecycle
 * (create/apply/delete local snapshots) stays in the page.
 */
export function useSnapshotTransfers(deps: {
  game: Ref<Game>;
  cloudGame: Ref<CloudArchiveGameView | null>;
  localCatalogDates: Ref<Set<string>>;
  activeTransfer: Ref<string>;
  retentionProtectedDates: Ref<Set<string>>;
  /** Currently selected rows (drives batch availability). */
  selected: () => Snapshot[];
  /** All rows in the local table (legacy-namespace describe lookup). */
  allSnapshots: () => Snapshot[];
  snapshotLabel: (date: string) => string;
  refresh: (refreshCloud?: boolean) => Promise<void>;
}) {
  const {
    game,
    cloudGame,
    localCatalogDates,
    activeTransfer,
    retentionProtectedDates,
    selected,
    allSnapshots,
    snapshotLabel,
    refresh,
  } = deps;
  const feedback = useFeedback();

  const selectedUploadable = computed(() =>
    selected().filter((snapshot) =>
      canUploadSnapshot(localCatalogDates.value, cloudGame.value, snapshot.date)
    )
  );
  const selectedDownloadable = computed(() =>
    selected().filter((snapshot) =>
      canDownloadSnapshot(localCatalogDates.value, cloudGame.value, snapshot.date)
    )
  );
  const selectedEvictable = computed(() =>
    selected().filter((snapshot) =>
      canEvictSnapshot(localCatalogDates.value, cloudGame.value, snapshot.date)
    )
  );

  function gameId() {
    return game.value.storage_key || game.value.name;
  }

  async function confirmOverwrite(dates: string[], upload: boolean) {
    const count = dates.filter((date) =>
      upload
        ? Boolean(cloudSnapshotOf(cloudGame.value, date)?.cloud_verified)
        : localCatalogDates.value.has(date)
    ).length;
    if (count === 0) return true;
    try {
      await feedback.confirm(
        $t(upload ? 'personal.transfer_upload_confirm' : 'personal.transfer_download_confirm', {
          count,
        }),
        $t('personal.transfer_overwrite_title'),
        {
          confirmButtonText: $t(upload ? 'personal.upload_backup' : 'personal.pull_backup'),
          cancelButtonText: $t('manage.cancel'),
          type: 'warning',
        }
      );
      return true;
    } catch {
      return false;
    }
  }

  async function runTransfer(
    date: string,
    upload: boolean,
    batchProgress?: ReturnType<typeof startCloudTransfer>
  ) {
    activeTransfer.value = date;
    const progress =
      batchProgress ??
      startCloudTransfer($t(upload ? 'personal.upload_backup' : 'personal.pull_backup'));
    progress.current(`${game.value.name} · ${snapshotLabel(date)}`);
    try {
      const result = upload
        ? await commands.uploadCloudArchive(gameId(), date)
        : await commands.downloadCloudArchive(gameId(), date);
      if (result.status === 'error') {
        notifyError($t('sync_settings.archives.transfer_failed'), result.error);
        return false;
      }
      notifySuccess(
        upload
          ? $t('sync_settings.archives.upload_success')
          : $t('sync_settings.archives.download_success')
      );
      if (!batchProgress) progress.finishing();
      await refresh();
      return true;
    } finally {
      if (!batchProgress) progress.finish();
      activeTransfer.value = '';
    }
  }

  async function transferSnapshot(date: string, upload: boolean) {
    if (!(await confirmOverwrite([date], upload))) return;
    await runTransfer(date, upload);
  }

  async function retryPendingDeletion(snapshotId: string, retryable: boolean) {
    if (!retryable) return;
    activeTransfer.value = snapshotId;
    try {
      const result = await commands.deleteV2Snapshot(gameId(), snapshotId, false);
      if (result.status === 'error') {
        notifyError($t('sync_settings.archives.delete_incomplete'), result.error);
        return;
      }
      notifySuccess($t('sync_settings.archives.delete_success'));
      await refresh();
    } finally {
      activeTransfer.value = '';
    }
  }

  function evictConfirmKey(date: string, cloud: boolean): string {
    const snapshot = cloudSnapshotOf(cloudGame.value, date);
    const prefix = cloud ? 'sync_settings.archives.evict_cloud' : 'sync_settings.archives.evict';
    if (!snapshot) return `${prefix}.confirm_last`;
    const hasReplacement = cloud
      ? isSnapshotOnDevice(localCatalogDates.value, cloudGame.value, date)
      : snapshot.cloud_verified;
    if (hasReplacement) return `${prefix}.confirm`;
    if (snapshot.reported_on_devices.length > 0) return `${prefix}.confirm_other_device`;
    return `${prefix}.confirm_last`;
  }

  async function evictSnapshot(date: string) {
    try {
      await feedback.confirm(
        $t(evictConfirmKey(date, false), { snapshot: snapshotLabel(date) }),
        $t('sync_settings.archives.evict.title'),
        {
          confirmButtonText: $t('sync_settings.archives.evict.action'),
          cancelButtonText: $t('manage.cancel'),
          type: 'warning',
        }
      );
    } catch {
      return;
    }
    activeTransfer.value = date;
    try {
      const result = await commands.evictLocalArchive(gameId(), date, true);
      if (result.status === 'error') {
        notifyError($t('sync_settings.archives.evict.failed'), result.error);
        return;
      }
      notifySuccess($t('sync_settings.archives.evict.success'));
      await refresh(false);
    } finally {
      activeTransfer.value = '';
    }
  }

  async function evictCloudSnapshot(date: string) {
    try {
      await feedback.confirm(
        $t(evictConfirmKey(date, true), { snapshot: snapshotLabel(date) }),
        $t('sync_settings.archives.evict_cloud.title'),
        {
          confirmButtonText: $t('sync_settings.archives.evict_cloud.action'),
          cancelButtonText: $t('manage.cancel'),
          type: 'warning',
        }
      );
    } catch {
      return;
    }
    activeTransfer.value = date;
    try {
      const result = await commands.evictCloudArchive(gameId(), date, true);
      if (result.status === 'error') {
        notifyError($t('sync_settings.archives.evict_cloud.failed'), result.error);
        return;
      }
      notifySuccess($t('sync_settings.archives.evict_cloud.success'));
      await refresh();
    } finally {
      activeTransfer.value = '';
    }
  }

  async function batchTransfer(upload: boolean) {
    const rows = upload ? selectedUploadable.value : selectedDownloadable.value;
    if (
      !(await confirmOverwrite(
        rows.map((snapshot) => snapshot.date),
        upload
      ))
    )
      return;
    if (!rows.length) return;
    const progress = startCloudTransfer(
      $t(upload ? 'personal.upload_backup' : 'personal.pull_backup'),
      rows.length
    );
    try {
      let completed = 0;
      for (const snapshot of rows) {
        if (!(await runTransfer(snapshot.date, upload, progress))) break;
        progress.completed(++completed);
      }
    } finally {
      progress.finish();
    }
  }

  async function batchEvict() {
    const rows = selectedEvictable.value;
    if (rows.length === 0) return;
    try {
      const unverified = rows.filter(
        (s) => !cloudSnapshotOf(cloudGame.value, s.date)?.cloud_verified
      ).length;
      await feedback.confirm(
        unverified > 0
          ? $t('manage.batch_evict_confirm_mixed', { count: rows.length, unverified })
          : $t('manage.batch_evict_confirm', { count: rows.length }),
        $t('sync_settings.archives.evict.title'),
        {
          confirmButtonText: $t('sync_settings.archives.evict.action'),
          cancelButtonText: $t('manage.cancel'),
          type: 'warning',
        }
      );
    } catch {
      return;
    }
    let succeeded = 0;
    for (const snapshot of rows) {
      activeTransfer.value = snapshot.date;
      const result = await commands.evictLocalArchive(gameId(), snapshot.date, true);
      if (result.status === 'error') {
        notifyError($t('sync_settings.archives.evict.failed'), result.error);
        break;
      }
      succeeded += 1;
    }
    activeTransfer.value = '';
    if (succeeded === rows.length) {
      notifySuccess($t('manage.batch_evict_success', { count: succeeded }));
    } else if (succeeded > 0) {
      notifyError(
        $t('manage.batch_evict_partial', {
          succeeded,
          failed: rows.length - succeeded,
        })
      );
    }
    await refresh(false);
  }

  function isRetentionProtected(date: string) {
    return isRetentionProtectedDate(retentionProtectedDates.value, cloudGame.value, date);
  }

  async function convertToPermanent(snapshotDate: string) {
    try {
      const ownership = await commands.getCurrentDeviceGameStatuses();
      if (ownership.status === 'error') {
        notifyError(ownership.error);
        return;
      }
      if (ownership.data.some((status) => status.game_id === gameId() && status.shared)) {
        const nextProtected = !isRetentionProtected(snapshotDate);
        if (nextProtected) {
          await feedback.confirm(
            $t('manage.protect_from_retention_confirm'),
            $t('manage.convert_to_permanent'),
            {
              confirmButtonText: $t('manage.convert_to_permanent'),
              cancelButtonText: $t('manage.cancel'),
              type: 'info',
            }
          );
        } else {
          await feedback.confirm(
            $t('sync_settings.archives.retention.unprotect_confirm'),
            $t('sync_settings.archives.retention.unprotect_title'),
            {
              confirmButtonText: $t('sync_settings.archives.retention.unprotect'),
              cancelButtonText: $t('manage.cancel'),
              type: 'warning',
            }
          );
        }
        const result = await commands.setSnapshotRetentionProtected(
          gameId(),
          snapshotDate,
          nextProtected,
          !nextProtected
        );
        if (result.status === 'error') {
          notifyError($t('sync_settings.archives.retention.protection_failed'), result.error);
          return;
        }
        notifySuccess(
          nextProtected
            ? $t('manage.protect_from_retention_success')
            : $t('sync_settings.archives.retention.unprotected')
        );
        await refresh();
        return;
      }
      const snapshot = allSnapshots().find((x) => x.date === snapshotDate);
      const { value } = await feedback.prompt(
        $t('manage.input_description_prompt'),
        $t('manage.convert_to_permanent'),
        {
          confirmButtonText: $t('manage.confirm'),
          cancelButtonText: $t('manage.cancel'),
          inputValue: snapshot?.describe,
        }
      );
      if (value !== snapshot?.describe) {
        const descResult = await commands.setSnapshotDescription(game.value, snapshotDate, value);
        if (descResult.status === 'error') {
          notifyError($t('manage.change_description_failed'));
          return;
        }
      }
      const result = await commands.setSnapshotCreatedBy(game.value, snapshotDate, 'Manual');
      if (result.status === 'error') {
        notifyError($t('manage.convert_to_permanent_failed'));
        return;
      }
      notifySuccess($t('manage.convert_to_permanent_success'));
      await refresh();
    } catch {
      notifyInfo($t('manage.operation_canceled'));
    }
  }

  return {
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
  };
}
