import assert from 'node:assert/strict';
import test from 'node:test';
import { singleFlight } from './singleFlight.ts';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

test('drawer save entry keeps its loading state until saving completes', async () => {
  const source = readFileSync(new URL('../components/AddGameDrawer.vue', import.meta.url), 'utf8');
  const entry = source.match(/const submitGame = singleFlight\([\s\S]*?\n\}\);/)[0];
  let release;
  let requests = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const isSaving = { value: false };
  const submit = vm.runInNewContext(stripTypeScriptTypes(`${entry}\nsubmitGame`), {
    singleFlight,
    isSaving,
  });
  const first = submit(async () => {
    await pending;
    requests++;
  });
  assert.equal(isSaving.value, true);
  await submit(async () => {
    requests++;
  });
  assert.equal(requests, 0);
  assert.equal(isSaving.value, true);
  release();
  await first;
  assert.equal(requests, 1);
  assert.equal(isSaving.value, false);
});

test('repeated submissions while saving do not issue a second request', async () => {
  let release;
  let requests = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const submit = singleFlight(async () => {
    requests++;
    await pending;
  });
  const first = submit();
  await submit();
  assert.equal(requests, 1);
  release();
  await first;
  await submit();
  assert.equal(requests, 2);
});

test('a failed submission releases the guard so the user can retry', async () => {
  let requests = 0;
  const submit = singleFlight(async () => {
    if (++requests === 1) throw new Error('save failed');
  });
  await assert.rejects(submit(), /save failed/);
  await submit();
  assert.equal(requests, 2);
});
