<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useDark, useDebounceFn, useEventListener } from '@vueuse/core';
import { Gamepad2, Moon, Sun, Minus, Square, Copy, X } from '@lucide/vue';
import { commands } from '../api/commands';
import { hasWindowControls } from '../api/client';
import type { WindowAction } from '../api/generated/types.gen';
import { useConfig } from '../composables/useConfig';
import { notifyError } from '../composables/useActivityCenter';
import { $t } from '../i18n';

const isDark = useDark();
const maximized = ref(false);
const { programVersion } = useConfig();
const themeLabel = computed(() => $t(isDark.value ? 'titlebar.light' : 'titlebar.dark'));
async function control(action: WindowAction) {
  if (!hasWindowControls) return;
  const result = await commands.controlMainWindow(action).catch(() => null);
  if (result?.status === 'ok') maximized.value = result.data;
  else if (action !== 'close') notifyError($t('titlebar.action_failed'));
}
function drag(event: MouseEvent) {
  if (event.button !== 0 || event.detail > 1) return;
  void control('start_dragging');
}
onMounted(() => void control('inspect'));
useEventListener(
  window,
  'resize',
  useDebounceFn(() => void control('inspect'), 100)
);
</script>

<template>
  <header
    class="flex h-9 shrink-0 select-none items-center border-b border-border bg-surface text-text"
  >
    <div
      class="flex h-full min-w-0 flex-1 items-center gap-2 px-3"
      @mousedown="drag"
      @dblclick="control('toggle_maximize')"
    >
      <Gamepad2 :size="16" class="shrink-0 text-accent" aria-hidden="true" />
      <span class="truncate text-xs font-medium">{{ $t('app.product_name') }}</span>
      <span v-if="programVersion" class="text-xs text-text-dim">{{ programVersion }}</span>
    </div>
    <button
      type="button"
      class="flex h-full w-10 shrink-0 items-center justify-center hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
      :aria-label="themeLabel"
      :title="themeLabel"
      @click="isDark = !isDark"
    >
      <Sun v-if="isDark" :size="16" aria-hidden="true" />
      <Moon v-else :size="16" aria-hidden="true" />
    </button>
    <template v-if="hasWindowControls">
      <button
        type="button"
        class="titlebar-control"
        :aria-label="$t('titlebar.minimize')"
        :title="$t('titlebar.minimize')"
        @click="control('minimize')"
      >
        <Minus :size="16" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="titlebar-control"
        :aria-label="$t(maximized ? 'titlebar.restore' : 'titlebar.maximize')"
        :title="$t(maximized ? 'titlebar.restore' : 'titlebar.maximize')"
        @click="control('toggle_maximize')"
      >
        <Copy v-if="maximized" :size="14" aria-hidden="true" />
        <Square v-else :size="14" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="titlebar-control titlebar-close"
        :aria-label="$t('titlebar.close')"
        :title="$t('titlebar.close')"
        @click="control('close')"
      >
        <X :size="17" aria-hidden="true" />
      </button>
    </template>
  </header>
</template>

<style scoped>
.titlebar-control {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 44px;
}
.titlebar-control:hover {
  background: var(--surface-2);
}
.titlebar-close:hover {
  background: #dc2626;
  color: white;
}
.titlebar-control:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
</style>
