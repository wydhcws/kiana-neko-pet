// 生成应用图标 assets/icon.png（1024×1024）
// 不依赖任何图形库：自己算像素 + 手写最小 PNG 编码器，任何平台上跑 `node assets/make-icon.js` 都能复现。
// electron-builder 会从这张 PNG 自动生成 macOS 的 .icns 和 Windows 的 .ico。
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 1024;      // 输出尺寸
const SS = 2;        // 超采样倍数（抗锯齿）
const N = S * SS;

// —— 调色（琪亚娜配色：白发、蓝眼、金铃铛）——
const BG_TOP = [122, 176, 255];
const BG_BOT = [196, 226, 255];
const FUR = [252, 250, 255];
const FUR_SHADE = [223, 230, 246];
const EAR_IN = [255, 183, 205];
const EYE = [46, 134, 222];
const EYE_DEEP = [26, 88, 168];
const MOUTH = [150, 116, 235];
const BLUSH = [255, 170, 190];
const BELL = [247, 197, 62];

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
// 椭圆内部判定：<=1 在内
const ell = (x, y, cx, cy, rx, ry) => ((x - cx) ** 2) / (rx * rx) + ((y - cy) ** 2) / (ry * ry);

function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const d = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = d(px, py, ax, ay, bx, by), d2 = d(px, py, bx, by, cx, cy), d3 = d(px, py, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

// 以 16×16 的设计网格描述形状，再缩放到目标尺寸（和托盘图标同一套比例）
function shade(gx, gy) {
  // 圆角方形背景
  const r = 3.4, lo = 0.35, hi = 15.65;
  const cx = Math.min(Math.max(gx, lo + r), hi - r);
  const cy = Math.min(Math.max(gy, lo + r), hi - r);
  if ((gx - cx) ** 2 + (gy - cy) ** 2 > r * r) return null;   // 圆角外 → 透明
  let c = mix(BG_TOP, BG_BOT, Math.min(1, Math.max(0, (gy - 1) / 14)));

  // 耳朵（外白内粉）
  const earL = inTri(gx, gy, 2.7, 1.5, 3.1, 7.2, 7.2, 5.4);
  const earR = inTri(gx, gy, 13.3, 1.5, 12.9, 7.2, 8.8, 5.4);
  if (earL || earR) c = FUR;
  const earLi = inTri(gx, gy, 3.5, 3.0, 3.7, 6.6, 6.4, 5.6);
  const earRi = inTri(gx, gy, 12.5, 3.0, 12.3, 6.6, 9.6, 5.6);
  if (earLi || earRi) c = EAR_IN;

  // 脸
  const face = ell(gx, gy, 8, 9.3, 5.5, 4.9);
  if (face <= 1) {
    c = FUR;
    if (gy > 11.4) c = mix(FUR, FUR_SHADE, Math.min(1, (gy - 11.4) / 2.2));  // 下巴阴影
  }

  if (face <= 1) {
    // 腮红
    const bl = ell(gx, gy, 4.7, 10.6, 1.25, 0.8), br = ell(gx, gy, 11.3, 10.6, 1.25, 0.8);
    if (bl <= 1) c = mix(c, BLUSH, 0.55 * (1 - bl));
    if (br <= 1) c = mix(c, BLUSH, 0.55 * (1 - br));

    // 眼睛（上深下浅的渐变 + 高光）
    for (const ex of [5.9, 10.1]) {
      const e = ell(gx, gy, ex, 9.0, 1.28, 1.72);
      if (e <= 1) {
        c = mix(EYE_DEEP, EYE, Math.min(1, Math.max(0, (gy - 7.4) / 3.0)));
        if (ell(gx, gy, ex - 0.42, 8.25, 0.42, 0.52) <= 1) c = [255, 255, 255];        // 大高光
        else if (ell(gx, gy, ex + 0.45, 9.85, 0.24, 0.3) <= 1) c = mix(c, [255, 255, 255], 0.8); // 小高光
      }
    }

    // 嘴：ω 形（两段小圆弧）
    for (const mx of [7.45, 8.55]) {
      const d = Math.hypot(gx - mx, (gy - 11.15) * 1.15);
      if (d > 0.36 && d < 0.6 && gy > 11.0) c = MOUTH;
    }
  }

  // 项圈 + 铃铛
  if (Math.abs(gy - 13.55) < 0.46 && ell(gx, gy, 8, 9.3, 6.0, 5.4) <= 1.06) c = [232, 92, 106];
  const bell = ell(gx, gy, 8, 13.9, 0.92, 0.92);
  if (bell <= 1) {
    c = mix(BELL, [255, 232, 150], Math.max(0, 1 - bell) * 0.5);
    if (Math.abs(gx - 8) < 0.13 && gy > 13.9) c = [186, 140, 30];
    if (ell(gx, gy, 8, 14.32, 0.2, 0.2) <= 1) c = [186, 140, 30];
  }
  return c;
}

// —— 渲染（超采样后下采样）——
const px = Buffer.alloc(S * S * 4);
for (let j = 0; j < S; j++) {
  for (let i = 0; i < S; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const gx = ((i + (sx + 0.5) / SS) / S) * 16;
        const gy = ((j + (sy + 0.5) / SS) / S) * 16;
        const c = shade(gx, gy);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
      }
    }
    const n = SS * SS, k = (j * S + i) * 4;
    if (a > 0) {
      px[k] = Math.round(r / (a / 255)); px[k + 1] = Math.round(g / (a / 255)); px[k + 2] = Math.round(b / (a / 255));
      px[k + 3] = Math.round(a / n);
    }
  }
}

// —— 最小 PNG 编码器 ——
function crc32(buf) {
  let c, t = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const byte of buf) crc = t[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8bit RGBA
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let j = 0; j < S; j++) {
  raw[j * (S * 4 + 1)] = 0;
  px.copy(raw, j * (S * 4 + 1) + 1, j * S * 4, (j + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log(`已生成 ${out}  ${S}×${S}  ${(png.length / 1024).toFixed(1)} KB`);
