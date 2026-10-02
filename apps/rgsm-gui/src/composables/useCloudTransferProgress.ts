import { readonly, ref } from 'vue';

const state = ref<{
  title: string;
  current: string;
  total: number;
  completed: number;
  finishing: boolean;
} | null>(null);

export const cloudTransferProgress = readonly(state);

export function startCloudTransfer(title: string, total = 1) {
  const entry = { title, current: '', total, completed: 0, finishing: false };
  state.value = entry;
  const active = state.value;
  return {
    current(label: string) {
      active.current = label;
    },
    completed(count: number) {
      active.completed = count;
    },
    finishing() {
      active.finishing = true;
    },
    finish() {
      if (state.value === active) state.value = null;
    },
  };
}
