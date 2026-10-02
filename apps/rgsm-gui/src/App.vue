<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue';
import { useDark } from '@vueuse/core';
import ActivityDrawer from './components/ActivityDrawer.vue';
import ActivityToast from './components/ActivityToast.vue';
import AddGameDrawer from './components/AddGameDrawer.vue';
import RemoteProgressPrompt from './components/RemoteProgressPrompt.vue';
import CloudTransferProgress from './components/CloudTransferProgress.vue';
import KFeedbackHost from './ui/kit/KFeedbackHost.vue';
import { events } from './api/commands';
import {
  notifyInfo,
  notifyWarning,
  notifyError,
  routeStageUpdate,
} from './composables/useActivityCenter';
import { useConfig } from './composables/useConfig';
import { connectSavedCloudLibrary } from './composables/useCloudConnection';
import { useCloudLibraryRefresh } from './composables/useCloudLibrary';
import { useGlobalLoading } from './composables/useGlobalLoading';
import { useHostNotificationCollector } from './composables/useHostNotificationCollector';
import { LAYER } from './ui/layers';
import { $t, i18n } from './i18n';
import { computed, provide, ref, watch } from 'vue';
import { mapLegacyHomePage, resolveStartupDestination } from './utils/appRoutes';
import { error as logError } from './utils/logger';

const { config, programVersion, refreshConfig, saveConfig } = useConfig();
watch(
  () => programVersion.value,
  (version) => {
    document.title = `${$t('app.product_name')}${version ? `-${version}` : ''}`;
  },
  { immediate: true }
);
useCloudLibraryRefresh();
const route = useRoute();
useDark();

const { isLoading, loadingMessage, loadingDetail } = useGlobalLoading();
const { addIfCollecting } = useHostNotificationCollector();
const sidebarWidth = ref(240);

provide('sidebarWidth', sidebarWidth);

const globalLoadingStyle = computed(() => ({
  zIndex: LAYER.globalLoading,
}));

const defaultUiFontFallbackStack =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

function toCssFontFamily(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes(',')) return trimmed;
  if (trimmed.includes('"') || trimmed.includes("'")) return trimmed;
  return trimmed.includes(' ') ? `"${trimmed}"` : trimmed;
}

const uiFontStack = computed(() => {
  const appearance = config.value?.settings?.appearance;
  if (!appearance?.custom_font_enabled) return null;
  const family = String(appearance?.ui_font_family ?? '');
  const cssFamily = toCssFontFamily(family);
  if (!cssFamily) return null;
  return `${cssFamily}, ${defaultUiFontFallbackStack}`;
});

function applyUiFont(stack: string | null) {
  if (typeof window === 'undefined') return;
  const style = document.documentElement.style;
  if (stack) {
    style.setProperty('--rgsm-ui-font-family', stack);
  } else {
    style.removeProperty('--rgsm-ui-font-family');
  }
}

async function initializeApp() {
  try {
    if (!(await refreshConfig())) return;
    const currentLocale = config.value.settings.locale;
    if (currentLocale) {
      i18n.global.locale.value = currentLocale as typeof i18n.global.locale.value;
    }
    applyUiFont(uiFontStack.value);

    const configuredHome = config.value.settings.home_page;
    const mappedHome = mapLegacyHomePage(configuredHome);
    if (mappedHome !== configuredHome) {
      config.value.settings.home_page = mappedHome;
      await saveConfig();
    }

    const destination = resolveStartupDestination(route.fullPath, mappedHome, config.value.games);
    if (destination !== route.fullPath) {
      await navigateTo(destination);
    }

    if ((config.value.settings.cloud_settings?.backend?.type ?? 'Disabled') !== 'Disabled') {
      void connectSavedCloudLibrary()
        .then((result) => {
          if (result.status === 'error') logError(`Cloud connection failed: ${result.error}`);
        })
        .catch((cause) => logError(`Cloud connection failed: ${cause}`));
    }
  } catch (cause) {
    logError(`Failed to initialize app: ${cause}`);
    if (route.path !== '/') {
      try {
        await navigateTo('/');
      } catch (navigationError) {
        logError(`Failed to recover startup route: ${navigationError}`);
      }
    }
  }
}

void initializeApp();
events.ipcNotification.listen((event) => {
  const ev = event.payload;
  if (addIfCollecting(ev)) return;
  // Backend stage text enriches the running drawer entry instead of toasting.
  if (ev.level === 'info' && routeStageUpdate(ev.title, ev.msg)) return;
  switch (ev.level) {
    case 'info':
      notifyInfo(ev.title || $t('misc.info'), ev.msg);
      break;
    case 'warning':
      notifyWarning(ev.title || $t('misc.warning'), ev.msg);
      break;
    case 'error':
      notifyError(ev.title || $t('misc.error'), ev.msg);
      break;
  }
});

if (typeof window !== 'undefined') {
  watch(uiFontStack, (stack) => applyUiFont(stack), { immediate: true });
}

// 下方代码由于 tauri-specta 的bug导致无法正常运行，因此使用上方方式替代
// events.ipcNotification.listen((event) => {
//   let ev = event.payload;
//   switch (ev.level) {
//     case "info":
//       showInfo({ message: ev.msg, title: ev.title });
//       break;
//     case "warning":
//       showWarning({ message: ev.msg, title: ev.title });
//       break;
//     case "error":
//       showError({ message: ev.msg, title: ev.title });
//       break;
//   }
// });
</script>

<template>
  <div>
    <div class="app-shell">
      <aside class="app-aside" :style="{ width: sidebarWidth + 'px' }">
        <MainSideBar />
      </aside>
      <main class="app-main">
        <RouterView v-slot="{ Component }">
          <Transition name="page" mode="out-in">
            <component :is="Component" />
          </Transition>
        </RouterView>
      </main>
    </div>

    <Teleport to="body">
      <Transition name="global-loading-fade">
        <div
          v-if="isLoading"
          class="global-loading-overlay"
          role="status"
          aria-live="polite"
          :style="globalLoadingStyle"
          @pointerdown.stop
        >
          <div class="global-loading-card">
            <LoaderCircle class="global-loading-spinner" :size="36" />
            <p class="global-loading-text">{{ loadingMessage }}</p>
            <p v-if="loadingDetail" class="global-loading-detail">{{ loadingDetail }}</p>
          </div>
        </div>
      </Transition>

      <ActivityDrawer />
      <ActivityToast />
    </Teleport>
    <AddGameDrawer />
    <KFeedbackHost />
    <RemoteProgressPrompt />
    <CloudTransferProgress />
  </div>
</template>

<style>
html,
body {
  margin: 0;
  overflow: hidden;
}

.app-shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.app-aside {
  flex-shrink: 0;
  height: 100%;
  overflow: hidden;
}

.app-main {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  /* 与旧 el-main 默认内边距保持一致:未迁移页面仍按 20px 布局;
     主页等整页画面用负 margin 抵消 */
  padding: 20px;
}

/* Custom font family - applied globally when user enables custom font */
body,
button,
input,
select,
textarea,
.el-button,
.el-input__inner,
.el-select,
.el-menu,
.el-menu-item,
.el-tabs__item,
.el-dialog,
.el-message-box,
.el-notification,
.el-table,
.el-form-item__label,
.el-checkbox__label,
.el-radio__label,
.el-alert,
.el-tag,
[class^='el-'] {
  font-family: var(--rgsm-ui-font-family, var(--font-sans-stack)) !important;
}

.global-loading-overlay {
  pointer-events: auto;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(2px);
}

.global-loading-card {
  min-width: 260px;
  padding: 1.75rem 2.5rem;
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  background: var(--surface);
  box-shadow: var(--shadow-overlay);
  color: var(--text);
  text-align: center;
}

.global-loading-spinner {
  animation: global-loading-spin 1s linear infinite;
}

.global-loading-text {
  margin: 0;
  font-size: 1rem;
  line-height: 1.4;
}

.global-loading-detail {
  margin: 0.25rem 0 0;
  font-size: 0.8rem;
  line-height: 1.3;
  color: var(--text-dim);
  opacity: 0.85;
}

@keyframes global-loading-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.global-loading-fade-enter-active,
.global-loading-fade-leave-active {
  transition: opacity 0.2s ease;
}

.global-loading-fade-enter-from,
.global-loading-fade-leave-to {
  opacity: 0;
}

.page-enter-active,
.page-leave-active {
  transition: opacity 0.15s ease-out;
}

.page-enter-from,
.page-leave-to {
  opacity: 0.4;
}
</style>
