import assert from 'node:assert/strict';
import test from 'node:test';
import { backupCopyCounts, manualTransferPlan } from './manualCloudTransfers.ts';

const snapshot = (id, local, cloud) => ({
  snapshot_id: id,
  local_evidence: local,
  cloud_verified: cloud,
});
const game = (overrides = {}) => ({
  game_id: 'g',
  managed: true,
  local_only: false,
  definition_conflict: false,
  snapshots: [
    snapshot('local', 'present', false),
    snapshot('cloud', 'unknown', true),
    snapshot('both', 'present', true),
    snapshot('conflict', 'mismatch', true),
  ],
  ...overrides,
});

test('manual upload skips existing cloud copies and content conflicts', () => {
  assert.deepEqual(manualTransferPlan([game()], true), [{ gameId: 'g', snapshotId: 'local' }]);
});
test('manual pull skips local copies and never overwrites a content conflict', () => {
  assert.deepEqual(manualTransferPlan([game()], false), [{ gameId: 'g', snapshotId: 'cloud' }]);
});
test('first upload includes local games but still blocks conflicting definitions', () => {
  assert.deepEqual(
    manualTransferPlan([game({ local_only: true }), game({ definition_conflict: true })], true),
    [{ gameId: 'g', snapshotId: 'local' }]
  );
});

test('explicit upload includes existing cloud copies without trusting mismatched local bytes', () => {
  assert.deepEqual(manualTransferPlan([game()], true, true), [
    { gameId: 'g', snapshotId: 'local' },
    { gameId: 'g', snapshotId: 'both' },
  ]);
});

test('explicit pull can replace existing and mismatched local copies', () => {
  assert.deepEqual(manualTransferPlan([game()], false, true), [
    { gameId: 'g', snapshotId: 'cloud' },
    { gameId: 'g', snapshotId: 'both' },
    { gameId: 'g', snapshotId: 'conflict' },
  ]);
});

test('copy totals include backups available on both sides', () => {
  assert.deepEqual(backupCopyCounts([game()]), { local: 2, cloud: 3 });
});
