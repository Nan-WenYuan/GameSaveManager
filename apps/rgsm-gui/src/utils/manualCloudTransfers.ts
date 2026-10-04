import type { CloudArchiveGameView } from '../api/commands';

/** Never overwrite a mismatching local copy during a bulk transfer. */
export function manualTransferPlan(
  games: CloudArchiveGameView[],
  upload: boolean,
  includeExisting = false
) {
  return games.flatMap((game) => {
    if (upload && (!game.managed || game.definition_conflict)) return [];
    return game.snapshots
      .filter((snapshot) =>
        upload
          ? snapshot.local_evidence === 'present' && (includeExisting || !snapshot.cloud_verified)
          : snapshot.cloud_verified && (includeExisting || snapshot.local_evidence === 'unknown')
      )
      .map((snapshot) => ({ gameId: game.game_id, snapshotId: snapshot.snapshot_id }));
  });
}

export function backupCopyCounts(games: CloudArchiveGameView[]) {
  return games.reduce(
    (counts, game) => {
      counts.local += game.snapshots.filter(
        (snapshot) => snapshot.local_evidence === 'present'
      ).length;
      counts.cloud += game.snapshots.filter((snapshot) => snapshot.cloud_verified).length;
      return counts;
    },
    { local: 0, cloud: 0 }
  );
}
