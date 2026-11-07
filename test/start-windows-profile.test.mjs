import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProfile } from '../skills/jev-browser-use/start-windows-profile.mjs';

const root = await mkdtemp(join(tmpdir(), 'start-windows-profile-'));
// No Chrome install paths: code that ignores the injected values fails before spawning a real browser.
const env = { JEV_BROWSER_PROFILE_DIR: join(root, 'profile') };

function fakeChild(event, payload) {
  const child = new EventEmitter();
  child.pid = 4321;
  child.unref = () => { child.unrefCalled = true; };
  const spawnProcess = (...args) => {
    child.spawnArgs = args;
    queueMicrotask(() => child.emit(event, payload));
    return child;
  };
  return { child, spawnProcess };
}

try {
  {
    const { child, spawnProcess } = fakeChild('error', new Error('spawn ENOENT'));
    await assert.rejects(
      startProfile({ env, chrome: 'chrome.exe', spawnProcess }),
      /spawn ENOENT/,
      'a failed spawn must reject instead of reporting a started profile'
    );
    assert.equal(child.unrefCalled, undefined);
    assert.equal(child.listenerCount('spawn'), 0);
  }

  {
    const { child, spawnProcess } = fakeChild('spawn');
    const result = await startProfile({ env, chrome: 'chrome.exe', profile: join(root, 'explicit'), url: 'https://example.test/', spawnProcess });
    assert.deepEqual(result, { chrome: 'chrome.exe', profile: join(root, 'explicit'), pid: 4321 });
    assert.equal(child.unrefCalled, true);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.spawnArgs[0], 'chrome.exe');
    assert.ok(child.spawnArgs[1].includes(`--user-data-dir=${join(root, 'explicit')}`));
    assert.ok(child.spawnArgs[1].includes('https://example.test/'));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
