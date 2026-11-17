// plmdrop.js — where a drop in the playlist manager puts a track (pure, node-tested).
//
// `beforeIdx` is the index (in the list as drawn) of the row the track is
// dropped before; null = after the last row. Answers the `to_index` for
// POST /api/library/playlist-transfer, or undefined for "nothing to do":
//   * same playlist: the place in the list WITHOUT the dragged row (null = end);
//   * other playlist: the place in that list (null = end).

export function dropIndex({ same, fromIdx, beforeIdx, fromLen, toLen }) {
  if (same) {
    const b = beforeIdx == null ? fromLen : beforeIdx;
    if (b === fromIdx || b === fromIdx + 1) return undefined;   // dropped on itself
    const at = b > fromIdx ? b - 1 : b;
    return at >= fromLen - 1 ? null : at;
  }
  return beforeIdx == null || beforeIdx >= toLen ? null : beforeIdx;
}
