// Draws the app/tray artwork: three level rows filling left to right, the shape of the open panel.
// Run `node icon.mjs` after changing anything here.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// ---- PNG (stdlib zlib, so no image dependency)

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
function png(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride); // filter byte 0 per row, already zeroed
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO: a directory of PNGs, which Windows has taken since Vista

function ico(entries) {
  const dir = Buffer.alloc(6 + 16 * entries.length);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    dir[e] = dir[e + 1] = size & 0xff; // 256 is stored as 0
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.data)]);
}

// ---- signed distance fields, so every edge is antialiased for free

function sdBox(x, y, hx, hy, r) {
  const qx = Math.abs(x) - hx + r;
  const qy = Math.abs(y) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function paint(px, i, [r, g, b], a) {
  if (a <= 0.002) return;
  const da = px[i + 3] / 255;
  const out = a + da * (1 - a);
  const w = (da * (1 - a)) / out;
  px[i] = Math.round(r * (1 - w) + px[i] * w);
  px[i + 1] = Math.round(g * (1 - w) + px[i + 1] * w);
  px[i + 2] = Math.round(b * (1 - w) + px[i + 2] * w);
  px[i + 3] = Math.round(out * 255);
}

const PLATE_HI = [46, 41, 38];
const PLATE_LO = [20, 17, 15];
const LEAD_TOP = [245, 177, 131];
const LEAD_LOW = [214, 119, 87];
const REST = [126, 168, 216];
const RED = [255, 77, 61];
const LEVELS = [0.82, 0.46, 0.64]; // the lead limit first, the provider's other limits dimmer behind it

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const small = size < 48; // below this a 1px track and the redline turn to mud
  const bw = size * (small ? 0.19 : 0.14); // row thickness
  const gap = size * (small ? 0.07 : 0.08);
  const h = size * 0.62; // track length
  const y0 = h / 2; // start of the track, from the centre
  const xs = [-1, 0, 1].map((k) => k * (bw + gap));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      {
        const cov = clamp01(0.5 - sdBox(dx, dy, c, c, size * 0.22));
        const t = clamp01((dx + dy) / (size * 1.4) + 0.5);
        paint(px, i, mix(PLATE_HI, PLATE_LO, t), cov);
      }
      // Rows, not columns: across runs down the plate, along runs left to right.
      const across = dy;
      const along = -dx;
      xs.forEach((bx, n) => {
        const r = small ? 0 : bw * 0.3;
        const track = clamp01(0.5 - sdBox(across - bx, along, bw / 2, h / 2, r));
        const up = (y0 - along) / h; // 0 at the left of the track, 1 at the right
        paint(px, i, [255, 255, 255], track * 0.1);
        if (!small && up > 0.9) paint(px, i, RED, track * 0.3); // the last 10%, where amber turns red
        const lvl = LEVELS[n];
        const fill = clamp01(0.5 - sdBox(across - bx, along - (y0 - (h * lvl) / 2), bw / 2, (h * lvl) / 2, r));
        const colour = n === 0 ? mix(LEAD_LOW, LEAD_TOP, clamp01(up / lvl)) : REST;
        paint(px, i, colour, fill * (n === 0 ? 1 : 0.75));
      });
    }
  }
  return px;
}

const out = (file, size) => {
  const data = png(size, render(size));
  writeFileSync(file, data);
  return { size, data };
};

mkdirSync('build', { recursive: true });
mkdirSync('assets', { recursive: true });
const sizes = [256, 128, 64, 48, 32, 16];
writeFileSync('build/icon.ico', ico(sizes.map((s) => ({ size: s, data: png(s, render(s)) }))));
out('build/icon.png', 256);
out('assets/tray.png', 16);
out('assets/tray@2x.png', 32);
console.log('wrote build/icon.ico, build/icon.png, assets/tray.png, assets/tray@2x.png');
