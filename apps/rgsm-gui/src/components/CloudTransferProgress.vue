<script setup lang="ts">
import { computed } from 'vue';
import { cloudTransferProgress as progress } from '../composables/useCloudTransferProgress';
import { $t } from '../i18n';
import { KDialog } from '../ui/kit';
import { LAYER } from '../ui/layers';

const open = computed(() => Boolean(progress.value));
</script>

<template>
  <KDialog
    :open="open"
    :title="progress?.title"
    :dismissable="false"
    :layer="LAYER.globalLoading"
    :width="440"
  >
    <template #description>{{ $t('cloud_transfer.wait_hint') }}</template>
    <div v-if="progress" role="status" aria-live="polite" class="space-y-3">
      <p class="break-words text-sm">{{ progress.current }}</p>
      <div class="transfer-running" role="progressbar" :aria-label="progress.title">
        <span />
      </div>
      <template v-if="progress.total > 1">
        <progress
          class="transfer-progress w-full"
          :max="progress.total"
          :value="progress.completed"
          :aria-label="$t('cloud_transfer.completed', progress)"
        />
        <p class="text-sm text-text-dim">{{ $t('cloud_transfer.completed', progress) }}</p>
      </template>
      <p class="text-sm text-text-dim">
        {{ $t(progress.finishing ? 'cloud_transfer.refreshing' : 'cloud_transfer.running') }}
      </p>
    </div>
  </KDialog>
</template>

<style scoped>
.transfer-progress {
  height: 8px;
  appearance: none;
  border: none;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--surface-2);
}
.transfer-progress::-webkit-progress-bar {
  background: var(--surface-2);
}
.transfer-progress::-webkit-progress-value {
  background: var(--accent);
}
.transfer-progress::-moz-progress-bar {
  background: var(--accent);
}
.transfer-running {
  height: 8px;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.transfer-running span {
  display: block;
  width: 35%;
  height: 100%;
  background: var(--accent);
  animation: cloud-transfer-running 1.4s ease-in-out infinite alternate;
}
@keyframes cloud-transfer-running {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(286%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .transfer-running span {
    animation: none;
  }
}
</style>
