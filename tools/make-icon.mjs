/* 生成 Fabula.ico（纯 Node，零依赖）：品牌红圆角方 + 白色 F。
   支持 PNG 压缩 ICO（Vista+）；2x 超采样抗锯齿。可重复运行（幂等）。 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = 256, SS = 2, W = S * SS;

/* 圆角矩形距离场：点到矩形最近边角的距离 - 半径（负=内部） */
function rr(x, y, w, h, r, px, py) {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  return Math.hypot(px - cx, py - cy) - r;
}

/* 形状表：红底 + 白 F（竖笔/上横/中横，圆角并集） */
const RED = [235, 104, 75], WHITE = [255, 250, 244];
function sample(px, py) {
  let r = 0, g = 0, b = 0, a = 0;
  const put = (col, al) => { r = col[0]; g = col[1]; b = col[2]; a = al; };
  if (rr(6, 6, 244, 244, 56, px, py) <= 0) put(RED, 1);
  if (rr(86, 60, 34, 136, 12, px, py) <= 0
    || rr(86, 60, 92, 34, 12, px, py) <= 0
    || rr(86, 127, 76, 34, 12, px, py) <= 0) put(WHITE, 1);
  return [r, g, b, a];
}

/* 超采样并降采样为 RGBA 像素 */
const buf = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [sr, sg, sb, sa] = sample(x * SS + sx + 0.5, y * SS + sy + 0.5);
        r += sr * sa; g += sg * sa; b += sb * sa; a += sa;
      }
    }
    const n = SS * SS, o = (y * S + x) * 4;
    const aa = a / n;                       // 平均 alpha
    if (aa > 0) {                           // 按 alpha 加权还原颜色（避免边缘发黑）
      buf[o] = Math.round(r / a); buf[o + 1] = Math.round(g / a);
      buf[o + 2] = Math.round(b / a);
    }
    buf[o + 3] = Math.round(aa * 255);
  }
}

/* ---- PNG 编码（RGBA8，与 electron 冒烟里的最小编码器同构） ---- */
const crc32 = (b) => {
  let c, crc = 0xffffffff;
  for (let n = 0; n < b.length; n++) {
    c = (crc ^ b[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, c]);
};
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

/* ---- ICO 封装（单张 256×256 PNG） ---- */
const icondir = Buffer.alloc(6);
icondir.writeUInt16LE(0, 0); icondir.writeUInt16LE(1, 2); icondir.writeUInt16LE(1, 4);
const ent = Buffer.alloc(16);
ent[0] = 0; ent[1] = 0; ent[2] = 0; ent[3] = 0;        // 0=256
ent.writeUInt16LE(1, 4); ent.writeUInt16LE(32, 6);
ent.writeUInt32LE(png.length, 8); ent.writeUInt32LE(22, 12);
const ico = Buffer.concat([icondir, ent, png]);

/* 双份输出：窗口图标（png，主进程已引用）+ 快捷方式/任务栏图标（ico） */
const buildDir = path.join(root, 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'icon.png'), png);
fs.writeFileSync(path.join(buildDir, 'fabula.ico'), ico);
console.log('build/icon.png + build/fabula.ico written (png', png.length, '/ ico', ico.length, 'bytes)');
