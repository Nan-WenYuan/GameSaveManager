import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

test('route readiness waits for the newer read when initial loading was superseded', async () => {
  const source = readFileSync(new URL('./useConfig.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function whenConfigReady(');
  const end = source.indexOf('async function readConfig(', start);
  let release;
  const latest = new Promise((resolve) => {
    release = resolve;
  });
  const ready = vm.runInNewContext(
    stripTypeScriptTypes(`${source.slice(start, end)}\nwhenConfigReady`),
    {
      firstLoad: Promise.resolve(false),
      latestConfigRead: latest,
      refreshConfig: () => {
        throw new Error('should share the pending read');
      },
    }
  );
  let completed = false;
  const result = ready().then((ok) => {
    completed = ok;
    return ok;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  release(true);
  assert.equal(await result, true);
});

test('saved configuration becomes visible without waiting for path status checks', async () => {
  const source = readFileSync(new URL('./useConfig.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function readConfig(');
  const end = source.indexOf('\nfunction refreshConfig()', start);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const config = { value: { games: [] } };
  const statuses = { value: [] };
  const context = {
    config,
    deviceGameStatuses: statuses,
    programVersion: { value: '1.12.3' },
    isLoading: { value: false },
    isEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    error() {},
    notifyError() {},
    $t: (key) => key,
    commands: {
      getLocalConfig: async () => ({ status: 'ok', data: { games: [{ name: 'Renamed' }] } }),
      getBuildInfo: async () => ({ version: '1.12.3' }),
      getCurrentDeviceGameStatuses: async () => {
        await pending;
        return { status: 'ok', data: [{ game_id: 'one' }] };
      },
    },
  };
  const read = vm.runInNewContext(
    stripTypeScriptTypes(`let metadataRead = 0;\n${source.slice(start, end)}\nreadConfig`),
    context
  );
  const result = read(false);
  let completed = false;
  result.then((ok) => {
    completed = ok;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(config.value.games[0]?.name, 'Renamed');
  assert.equal(completed, true);
  assert.equal(context.isLoading.value, false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statuses.value[0].game_id, 'one');
});
