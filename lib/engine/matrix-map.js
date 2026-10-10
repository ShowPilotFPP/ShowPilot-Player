// Maps a channel range to a width x height RGB image, the same way an
// xLights matrix model numbers its pixels: strings run horizontally or
// vertically from a start corner, optionally zig-zagging (serpentine).
// Returns, for each display pixel in row-major order, the channel offset of
// its first byte plus the color-order permutation.

function buildMatrixMap({ startChannel = 1, width, height, colorOrder = 'RGB',
  startCorner = 'TL', orientation = 'horizontal', serpentine = false }) {
  const w = Math.max(1, width | 0), h = Math.max(1, height | 0);
  const base = Math.max(0, (startChannel | 0) - 1);
  const offsets = new Int32Array(w * h);
  const left = startCorner === 'TL' || startCorner === 'BL';
  const top = startCorner === 'TL' || startCorner === 'TR';

  for (let i = 0; i < w * h; i++) {
    let x, y;
    if (orientation === 'vertical') {
      const col = Math.floor(i / h);
      let row = i % h;
      if (serpentine && col % 2 === 1) row = h - 1 - row;
      x = left ? col : w - 1 - col;
      y = top ? row : h - 1 - row;
    } else {
      const row = Math.floor(i / w);
      let col = i % w;
      if (serpentine && row % 2 === 1) col = w - 1 - col;
      x = left ? col : w - 1 - col;
      y = top ? row : h - 1 - row;
    }
    offsets[y * w + x] = base + i * 3;
  }

  const order = String(colorOrder || 'RGB').toUpperCase();
  const perm = [order.indexOf('R'), order.indexOf('G'), order.indexOf('B')];
  if (perm.some((p) => p < 0)) perm.splice(0, 3, 0, 1, 2);
  return { width: w, height: h, offsets, perm, endChannel: base + w * h * 3 };
}

function renderMatrix(map, frame, out) {
  const { offsets, perm } = map;
  const [pr, pg, pb] = perm;
  const len = frame.length;
  for (let i = 0, o = 0; i < offsets.length; i++, o += 3) {
    const c = offsets[i];
    out[o] = c + pr < len ? frame[c + pr] : 0;
    out[o + 1] = c + pg < len ? frame[c + pg] : 0;
    out[o + 2] = c + pb < len ? frame[c + pb] : 0;
  }
  return out;
}

module.exports = { buildMatrixMap, renderMatrix };
