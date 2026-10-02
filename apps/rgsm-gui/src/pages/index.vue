<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Archive, ArrowUpRight, Cloud, Gamepad2, Plus, Search } from '@lucide/vue';
import { $t } from '../i18n';
import { useConfig } from '../composables/useConfig';
import { useAddGameDrawer } from '../composables/useAddGameDrawer';
import { useSaveListSort } from '../composables/useSaveListSort';
import { getGameManagementPath } from '../composables/useGameManagementRoute';
import { commands } from '../api/commands';
import { compareSnapshotTime, formatSnapshotTime } from '../utils/snapshotPresentation';
import { KButton, KInput, KTag } from '../ui/kit';

const { config, isGameVisible, isLoading } = useConfig();
const { sortedGames } = useSaveListSort();
const { open: openAddGame } = useAddGameDrawer();
const query = ref('');
const router = useRouter();
const games = computed(() =>
  sortedGames(config.value.games.filter((game) => isGameVisible(game.storage_key, game.name)))
);
const visibleGames = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  return games.value.filter((game) => game.name.toLocaleLowerCase().includes(search));
});
const backupStats = ref<Record<string, { count: number; latest: string | null }>>({});
let statsRequest = 0;
watch(
  () => games.value,
  async (currentGames) => {
    const request = ++statsRequest;
    const entries = await Promise.all(
      currentGames.map(async (game) => {
        const result = await commands.getLocalBackupsInfo(game).catch(() => null);
        if (!result || result.status !== 'ok') return null;
        const backups = result.data.backups;
        const latest = [...backups].sort(compareSnapshotTime).at(-1);
        return [
          game.storage_key || game.name,
          { count: backups.length, latest: latest ? formatSnapshotTime(latest) : null },
        ] as const;
      })
    );
    if (request === statsRequest)
      backupStats.value = Object.fromEntries(entries.filter((entry) => entry !== null));
  },
  { immediate: true }
);
</script>

<template>
  <div class="mx-auto max-w-[1100px] px-4 py-6">
    <header class="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold text-text">{{ $t('personal.library') }}</h1>
        <p class="mt-2 text-sm text-text-dim">{{ $t('personal.library_hint') }}</p>
      </div>
      <KButton variant="primary" @click="openAddGame()">
        <template #icon><Plus :size="16" aria-hidden="true" /></template>
        {{ $t('sidebar.add_game') }}
      </KButton>
    </header>
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <KInput
        v-model="query"
        class="w-full max-w-sm"
        :placeholder="$t('misc.search')"
        :aria-label="$t('misc.search')"
      />
      <KButton size="sm" variant="ghost" @click="router.push('/SyncSettings')">
        <template #icon><Cloud :size="15" aria-hidden="true" /></template>
        {{ $t('personal.cloud_backup') }}
      </KButton>
    </div>
    <p v-if="isLoading && games.length === 0" class="py-16 text-center text-sm text-text-dim">
      {{ $t('personal.loading') }}
    </p>
    <section
      v-else-if="games.length === 0"
      class="flex flex-col items-center rounded-md border border-dashed border-border bg-surface px-6 py-16 text-center"
    >
      <Archive :size="36" class="mb-4 text-text-dim" aria-hidden="true" />
      <h2 class="text-lg font-medium text-text">{{ $t('personal.empty_title') }}</h2>
      <p class="mb-5 mt-2 text-sm text-text-dim">{{ $t('personal.empty_hint') }}</p>
      <KButton variant="primary" @click="openAddGame()">{{ $t('sidebar.add_game') }}</KButton>
    </section>
    <p v-else-if="visibleGames.length === 0" class="py-16 text-center text-sm text-text-dim">
      <Search :size="24" class="mx-auto mb-3" aria-hidden="true" />
      {{ $t('misc.no_search_results') }}
    </p>
    <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <button
        v-for="game in visibleGames"
        :key="game.storage_key"
        type="button"
        class="group flex cursor-pointer flex-col gap-4 rounded-md border border-border bg-surface p-5 text-left transition-colors hover:border-accent hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
        @click="router.push(getGameManagementPath(game))"
      >
        <div class="flex w-full items-center gap-3">
          <Gamepad2 :size="24" class="shrink-0 text-accent" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate font-medium text-text" :title="game.name">{{
            game.name
          }}</span>
          <ArrowUpRight :size="16" class="shrink-0 text-text-dim" aria-hidden="true" />
        </div>
        <div class="flex flex-wrap items-center gap-2 text-xs text-text-dim">
          <KTag :tone="game.auto_backup ? 'success' : 'neutral'">{{
            $t(game.auto_backup ? 'personal.auto_backup' : 'personal.manual_backup')
          }}</KTag>
          <span>{{ $t('personal.save_locations', { count: game.save_paths.length }) }}</span>
        </div>
        <div class="text-xs text-text-dim">
          <template v-if="backupStats[game.storage_key || game.name]">
            <p>
              {{
                $t('personal.backup_count', {
                  count: backupStats[game.storage_key || game.name]!.count,
                })
              }}
            </p>
            <p class="mt-1">
              {{
                backupStats[game.storage_key || game.name]!.latest
                  ? $t('personal.latest_backup', {
                      time: backupStats[game.storage_key || game.name]!.latest,
                    })
                  : $t('personal.no_backups')
              }}
            </p>
          </template>
          <p v-else>{{ $t('personal.backup_status_unknown') }}</p>
        </div>
      </button>
    </div>
    <p v-if="games.length > 0" class="mt-5 text-xs text-text-dim">
      {{ $t('personal.game_count', { count: games.length }) }}
    </p>
  </div>
</template>
