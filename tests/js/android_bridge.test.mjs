// The pause a track change causes must not reach the native shell.
// AudioService releases its PARTIAL_WAKE_LOCK on onPause(), so reporting the transient
// pause of a source swap let a sleeping phone suspend between two tracks.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;

const { abPlay, abPause, abStop, _internals } = await import('../../static/js/androidbridge.js');

function installBridge() {
  const calls = [];
  globalThis.AndroidBridge = {
    onPlay: (t, a) => calls.push(['play', t, a]),
    onPause: () => calls.push(['pause']),
    onStop: () => calls.push(['stop']),
  };
  return calls;
}

test('a pause immediately followed by play is never reported', (t) => {
  const calls = installBridge();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  abPause();                       // src swap pauses the element
  t.mock.timers.tick(300);
  abPlay('The Curse', 'Agnes Obel');  // the next track starts
  t.mock.timers.tick(60_000);

  assert.deepEqual(calls, [['play', 'The Curse', 'Agnes Obel']]);
});

test('a pause nobody undoes is reported once the grace is over', (t) => {
  const calls = installBridge();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  abPause();
  t.mock.timers.tick(_internals.PAUSE_GRACE_MS - 1);
  assert.deepEqual(calls, [], 'still inside the grace window');

  t.mock.timers.tick(2);
  assert.deepEqual(calls, [['pause']]);
});

test('repeated pauses collapse into one report', (t) => {
  const calls = installBridge();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  abPause(); t.mock.timers.tick(100);
  abPause(); t.mock.timers.tick(100);
  abPause(); t.mock.timers.tick(60_000);

  assert.deepEqual(calls, [['pause']]);
});

test('stop is immediate and cancels a pending pause', (t) => {
  const calls = installBridge();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  abPause();
  abStop();
  t.mock.timers.tick(60_000);

  assert.deepEqual(calls, [['stop']]);
});

test('without the native shell nothing is scheduled', (t) => {
  delete globalThis.AndroidBridge;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  abPause();
  assert.equal(_internals.pending(), false);
});
