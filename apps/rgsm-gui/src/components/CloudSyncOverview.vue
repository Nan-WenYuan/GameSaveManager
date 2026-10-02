<script setup lang="ts">
import { ref } from 'vue';
import type { CloudArchiveGameView } from '../api/commands';
const definitionGameId = ref('');
const publishingGame = ref(false);
const fleet = ref<{ load: () => Promise<void> } | null>(null);
function configure(game: CloudArchiveGameView) {
  publishingGame.value = game.local_only;
  definitionGameId.value = game.game_id;
}
</script>

<template>
  <section>
    <CloudArchivePanel ref="fleet" @configure="configure" />
    <CloudLibraryJoinDialog
      v-if="definitionGameId"
      :model-value="Boolean(definitionGameId)"
      :game-id="definitionGameId"
      :publish-local="publishingGame"
      @update:model-value="definitionGameId = ''"
      @joined="fleet?.load()"
    />
  </section>
</template>
