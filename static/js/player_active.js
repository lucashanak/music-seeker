// player_active.js — single source of truth for the active player engine.
//
// Two engines exist (classic player.js, dj player_v3.js) and are selected at runtime
// via localStorage('ms_player_engine'). Cross-module callers MUST resolve the engine
// through getPlayerModule() instead of importing a literal './player.js', otherwise
// the dj engine is silently bypassed (the classic engine grabs #audioElement and
// plays through a muted Web Audio gain node).
//
// The 'crossfade' engine (player_v2.js) was removed; getPlayerEngine() migrates any
// lingering stored value back to 'classic'.
//
// ES module caching dedupes by resolved specifier, so every getPlayerModule() caller
// shares the exact module instance app.js initialized.

let _modPromise = null;

export function getPlayerEngine() {
  let engine = localStorage.getItem('ms_player_engine') || 'classic';
  if (engine === 'crossfade') {
    engine = 'classic';
    localStorage.setItem('ms_player_engine', 'classic');
  }
  return engine;
}

export function getPlayerModule() {
  if (!_modPromise) {
    const engine = getPlayerEngine();
    const path = engine === 'dj' ? './player_v3.js' : './player.js';
    _modPromise = import(path).catch(e => {
      console.error('Player engine load failed, falling back to classic:', e);
      return import('./player.js');
    });
  }
  return _modPromise;
}
