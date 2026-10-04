<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ChevronDown, Download, RefreshCw, Upload } from '@lucide/vue';
import { commands, type CloudArchiveGameView } from '../api/commands';
import { useCloudLibrary } from '../composables/useCloudLibrary';
import { useFeedback } from '../composables/useFeedback';
import { notifyError, notifySuccess } from '../composables/useActivityCenter';
import { backupCopyCounts, manualTransferPlan } from '../utils/manualCloudTransfers';
import { formatSnapshotTime } from '../utils/snapshotPresentation';
import {
  cloudArchiveAvailabilityLabel,
  formatCloudArchiveBytes,
} from '../utils/cloudArchivePresentation';
import { $t } from '../i18n';
import { KAlert, KButton, KInput } from '../ui/kit';
import { startCloudTransfer } from '../composables/useCloudTransferProgress';

const emit = defineEmits<{ configure: [game: CloudArchiveGameView] }>();
const { library, lastError, refresh } = useCloudLibrary();
const feedback = useFeedback();
const busy = ref(false);
const progress = ref('');
const search = ref('');
const expanded = ref(new Set<string>());
const allGames = computed(() => library.value?.games ?? []);
const games = computed(() =>
  allGames.value.filter((game) =>
    game.name.toLowerCase().includes(search.value.trim().toLowerCase())
  )
);
const counts = computed(() => backupCopyCounts(allGames.value));
function toggle(gameId: string) {
  const next = new Set(expanded.value);
  if (next.has(gameId)) next.delete(gameId);
  else next.add(gameId);
  expanded.value = next;
}
function transferCount(game: CloudArchiveGameView, upload: boolean) {
  return manualTransferPlan([game], upload, true).length;
}
async function load(options: { silent?: boolean } = {}) {
  await refresh(!options.silent);
  if (lastError.value && !options.silent)
    notifyError($t('sync_settings.archives.load_failed'), lastError.value);
}
async function transfer(upload: boolean, gameId?: string, snapshotId?: string) {
  if (busy.value) return;
  busy.value = true;
  let completed = 0;
  let transferProgress: ReturnType<typeof startCloudTransfer> | undefined;
  try {
    transferProgress = startCloudTransfer($t('cloud_transfer.preparing'));
    await refresh(true);
    if (lastError.value) {
      notifyError($t('sync_settings.archives.load_failed'), lastError.value);
      return;
    }
    const selectedGames = allGames.value.filter((game) => !gameId || game.game_id === gameId);
    const plan = manualTransferPlan(selectedGames, upload, true).filter(
      (item) => !snapshotId || item.snapshotId === snapshotId
    );
    if (!plan.length) return;
    const overwrites = plan.filter((item) => {
      const snapshot = selectedGames
        .find((game) => game.game_id === item.gameId)
        ?.snapshots.find((snapshot) => snapshot.snapshot_id === item.snapshotId);
      return upload ? snapshot?.cloud_verified : snapshot?.local_evidence !== 'unknown';
    }).length;
    transferProgress.finish();
    if (overwrites) {
      try {
        await feedback.confirm(
          $t(upload ? 'personal.transfer_upload_confirm' : 'personal.transfer_download_confirm', {
            count: overwrites,
          }),
          $t('personal.transfer_overwrite_title'),
          {
            type: 'warning',
            cancelButtonText: $t('manage.cancel'),
            confirmButtonText: $t(upload ? 'personal.upload_backup' : 'personal.pull_backup'),
          }
        );
      } catch {
        return;
      }
    }
    transferProgress = startCloudTransfer(
      $t(upload ? 'personal.upload_backup' : 'personal.pull_backup'),
      plan.length
    );
    for (const item of plan) {
      transferProgress.current(
        selectedGames.find((game) => game.game_id === item.gameId)?.name ?? item.gameId
      );
      progress.value = $t('personal.transfer_progress', {
        completed: completed + 1,
        total: plan.length,
      });
      const result = upload
        ? await commands.uploadCloudArchive(item.gameId, item.snapshotId)
        : await commands.downloadCloudArchive(item.gameId, item.snapshotId);
      if (result.status === 'error') {
        notifyError(
          $t(
            upload
              ? 'sync_settings.archives.upload_failed'
              : 'sync_settings.archives.download_failed'
          ),
          result.error
        );
        break;
      }
      completed += 1;
      transferProgress.completed(completed);
    }
    if (completed > 0)
      notifySuccess(
        $t(upload ? 'personal.upload_done' : 'personal.pull_done', { count: completed })
      );
    transferProgress.finishing();
    await load({ silent: true });
  } finally {
    transferProgress?.finish();
    busy.value = false;
    progress.value = '';
  }
}
defineExpose({ load });
onMounted(() => {
  void load({ silent: true });
});
</script>

<template>
  <section class="flex flex-col gap-4">
    <KAlert v-if="lastError" tone="warning"
      >{{ $t('sync_settings.archives.refresh_unavailable') }}
      {{ $t('personal.cloud_optional') }}</KAlert
    >
    <div
      class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-4"
    >
      <div>
        <p class="text-sm font-semibold">{{ $t('personal.backup_totals', counts) }}</p>
        <p class="mt-1 text-xs text-text-dim">{{ $t('personal.transfer_help') }}</p>
        <p v-if="progress" role="status" class="mt-1 text-xs text-accent">{{ progress }}</p>
      </div>
      <KButton :disabled="busy" @click="load()"
        ><template #icon><RefreshCw :size="14" /></template>{{ $t('common.refresh') }}</KButton
      >
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <KButton
        variant="primary"
        :disabled="Boolean(lastError) || busy || !manualTransferPlan(allGames, true, true).length"
        @click="transfer(true)"
        ><template #icon><Upload :size="14" /></template>{{ $t('personal.upload_all') }}</KButton
      >
      <KButton :disabled="Boolean(lastError) || busy || !counts.cloud" @click="transfer(false)"
        ><template #icon><Download :size="14" /></template>{{ $t('personal.pull_all') }}</KButton
      >
      <KInput
        v-model="search"
        class="w-72"
        :placeholder="$t('sync_settings.overview.search')"
        :aria-label="$t('sync_settings.overview.search')"
      />
    </div>
    <p v-if="!games.length" class="py-6 text-center text-sm text-text-dim">
      {{ $t('sync_settings.overview.no_games') }}
    </p>
    <article
      v-for="game in games"
      :key="game.game_id"
      :data-game-id="game.game_id"
      class="overflow-hidden rounded-md border border-border"
    >
      <div class="flex flex-wrap items-center justify-between gap-3 p-4">
        <button
          type="button"
          class="flex cursor-pointer items-center gap-2 border-none bg-transparent p-0 text-left text-text"
          :aria-expanded="expanded.has(game.game_id)"
          @click="toggle(game.game_id)"
        >
          <ChevronDown
            :size="16"
            :class="{ '-rotate-90': !expanded.has(game.game_id) }"
            aria-hidden="true"
          />
          <span
            ><span class="text-sm font-semibold">{{ game.name }}</span
            ><span class="mt-1 block text-xs text-text-dim">{{
              $t('personal.backup_totals', backupCopyCounts([game]))
            }}</span></span
          >
        </button>
        <div class="flex flex-wrap gap-2">
          <KButton
            v-if="game.definition_conflict"
            :disabled="busy || !game.managed || Boolean(lastError)"
            @click="emit('configure', game)"
            >{{ $t('sync_settings.library.definitions.action') }}</KButton
          >
          <KButton
            size="sm"
            :disabled="Boolean(lastError) || busy || !transferCount(game, true)"
            @click="transfer(true, game.game_id)"
            ><template #icon><Upload :size="14" /></template
            >{{ $t('personal.upload_game') }}</KButton
          >
          <KButton
            size="sm"
            :disabled="Boolean(lastError) || busy || !transferCount(game, false)"
            @click="transfer(false, game.game_id)"
            ><template #icon><Download :size="14" /></template
            >{{ $t('personal.pull_game') }}</KButton
          >
        </div>
      </div>
      <div v-if="expanded.has(game.game_id)" class="overflow-x-auto border-t border-border">
        <table class="w-full text-left text-xs">
          <thead class="bg-surface-2 text-text-dim">
            <tr>
              <th class="p-3">{{ $t('personal.backup_record') }}</th>
              <th class="p-3">{{ $t('personal.backup_location') }}</th>
              <th class="p-3">{{ $t('personal.backup_actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="snapshot in game.snapshots"
              :key="snapshot.snapshot_id"
              class="border-t border-border"
            >
              <td class="p-3">
                <span class="block">{{
                  formatSnapshotTime({
                    date: snapshot.snapshot_id,
                    created_at: snapshot.created_at,
                  }) || snapshot.snapshot_id
                }}</span
                ><span class="text-text-dim"
                  >{{ snapshot.description || $t('personal.no_description') }} ·
                  {{ formatCloudArchiveBytes(snapshot.size) }}</span
                >
              </td>
              <td class="p-3">{{ cloudArchiveAvailabilityLabel(snapshot) }}</td>
              <td class="p-3">
                <div class="flex gap-2">
                  <KButton
                    size="sm"
                    :disabled="
                      Boolean(lastError) ||
                      busy ||
                      game.definition_conflict ||
                      !game.managed ||
                      snapshot.local_evidence !== 'present'
                    "
                    @click="transfer(true, game.game_id, snapshot.snapshot_id)"
                    >{{ $t('personal.upload_backup') }}</KButton
                  ><KButton
                    size="sm"
                    :disabled="Boolean(lastError) || busy || !snapshot.cloud_verified"
                    @click="transfer(false, game.game_id, snapshot.snapshot_id)"
                    >{{ $t('personal.pull_backup') }}</KButton
                  >
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>
  </section>
</template>
