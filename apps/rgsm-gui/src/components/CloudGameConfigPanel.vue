<script setup lang="ts">
import { ref } from 'vue';
import { commands } from '../api/commands';
import { $t } from '../i18n';
import { useConfig } from '../composables/useConfig';
import { useFeedback } from '../composables/useFeedback';
import { notifyError, notifySuccess } from '../composables/useActivityCenter';
import { KButton } from '../ui/kit';
import { startCloudTransfer } from '../composables/useCloudTransferProgress';

const busy = ref(false);
const feedback = useFeedback();
const { refreshConfig } = useConfig();

async function transfer(upload: boolean) {
  if (busy.value) return;
  busy.value = true;
  let progress: ReturnType<typeof startCloudTransfer> | undefined;
  try {
    try {
      await feedback.confirm(
        $t(upload ? 'game_config_sync.upload_confirm' : 'game_config_sync.pull_confirm'),
        $t(upload ? 'game_config_sync.upload' : 'game_config_sync.pull'),
        {
          confirmButtonText: $t('game_config_sync.confirm'),
          cancelButtonText: $t('manage.cancel'),
          type: 'warning',
        }
      );
    } catch {
      return;
    }
    progress = startCloudTransfer($t(upload ? 'game_config_sync.upload' : 'game_config_sync.pull'));
    const result = upload
      ? await commands.uploadGameManagementConfig(true)
      : await commands.pullGameManagementConfig(true);
    if (result.status === 'error') {
      notifyError($t('game_config_sync.failed'), result.error);
      return;
    }
    progress.finishing();
    if (!upload) await refreshConfig();
    notifySuccess(
      $t(upload ? 'game_config_sync.uploaded' : 'game_config_sync.pulled', { count: result.data })
    );
  } catch (error) {
    notifyError($t('game_config_sync.failed'), String(error));
  } finally {
    progress?.finish();
    busy.value = false;
  }
}
</script>

<template>
  <section class="rounded-md border border-border p-4">
    <h2 class="text-base font-semibold">{{ $t('game_config_sync.title') }}</h2>
    <p class="mt-2 text-sm text-text-dim">{{ $t('game_config_sync.hint') }}</p>
    <p class="mt-2 text-xs text-text-dim">{{ $t('game_config_sync.paths_hint') }}</p>
    <div class="mt-4 flex flex-wrap gap-2">
      <KButton :disabled="busy" @click="transfer(true)">{{
        $t('game_config_sync.upload')
      }}</KButton>
      <KButton :disabled="busy" @click="transfer(false)">{{ $t('game_config_sync.pull') }}</KButton>
    </div>
  </section>
</template>
