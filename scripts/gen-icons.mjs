// Generates maskable PWA icons (no external deps) — a roundnet net + ball motif.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, pixels /* Uint8Array RGBA */) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    pixels.subarray(y * stride, y * stride + stride).forEach((v, i) => {
      raw[y * (stride + 1) + 1 + i] = v;
    });
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function draw(size) {
  const px = new Uint8Array(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const bg = hex("#0c0e10");
  const green = hex("#cbfb4f");
  const greenDim = hex("#1b1f23");
  const ball = hex("#f4f5f6");
  const set = (x, y, [r, g, b]) => {
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };
  const R = size * 0.40; // net outer
  const Rin = size * 0.27; // net inner
  const ballR = size * 0.11;
  const ballCx = cx;
  const ballCy = cy - size * 0.02;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      let color = bg;
      if (d <= R) color = greenDim; // net membrane
      if (d <= R && d >= Rin) color = green; // net rim
      // radial net lines
      if (d < Rin) {
        const ang = Math.atan2(y - cy, x - cx);
        const seg = ((ang + Math.PI) / (Math.PI / 6)) % 1;
        if (seg < 0.04 || seg > 0.96) color = green;
        const ring = (d / (Rin / 4)) % 1;
        if (ring < 0.06) color = green;
      }
      // the ball
      if (Math.hypot(x - ballCx, y - ballCy) <= ballR) color = ball;
      set(x, y, color);
    }
  }
  return px;
}

for (const size of [192, 512]) {
  const png = encodePng(size, draw(size));
  writeFileSync(new URL(`../public/icon-${size}.png`, import.meta.url), png);
  console.log(`wrote public/icon-${size}.png (${png.length} bytes)`);
}
