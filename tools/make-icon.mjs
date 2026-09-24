/* 生成 Fabula 品牌图标（纯 Node，零依赖，可重复运行）：
   · build/icon.png                              窗口图标（256，主进程引用）
   · build/fabula.ico                            快捷方式/任务栏图标（256 PNG 封装）
   · android/res/mipmap-xxxhdpi/ic_launcher.png  Android 图标（192）
   形状 = 顶栏左上角 .brand-mark 的逐像素复刻：品牌红方块 + 右下"构成主义斜切"，
   clip-path(0 0, 100% 0, 100% 62%, 62% 100%, 0 100%)。2x 超采样抗锯齿。 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RED = [235, 104, 75];

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
function toPng(buf, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    buf.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- 形状渲染（相对坐标，任意尺寸）----
   256 画布上原定义：绘制区 6..250，斜切点为其 62% 处 → 斜线 x+y=407.28；
   边距与切点均为比例量，这里按 size 归一化，保证 192 与 256 视觉一致。 */
function render(size) {
  const SS = 2;
  const pad = (size * 6) / 256;
  const lo = pad, hi = size - pad;
  const cutXY = hi + (lo + 0.62 * (hi - lo));       // 保留条件：x + y <= cutXY
  const inShape = (px, py) =>
    px >= lo && px <= hi && py >= lo && py <= hi && px + py <= cutXY;

  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          /* 采样点归一化回 0..size 坐标系（形状定义域），避免超采样坐标错位 */
          if (inShape(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) a += 1;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {                                   // 单色形状：颜色恒为品牌红
        buf[o] = RED[0]; buf[o + 1] = RED[1]; buf[o + 2] = RED[2];
      }
      buf[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return toPng(buf, size);
}

const png256 = render(256);
const png192 = render(192);

/* ---- ICO 封装（单张 256×256 PNG） ---- */
const icondir = Buffer.alloc(6);
icondir.writeUInt16LE(0, 0); icondir.writeUInt16LE(1, 2); icondir.writeUInt16LE(1, 4);
const ent = Buffer.alloc(16);
ent[0] = 0; ent[1] = 0; ent[2] = 0; ent[3] = 0;        // 0=256
ent.writeUInt16LE(1, 4); ent.writeUInt16LE(32, 6);
ent.writeUInt32LE(png256.length, 8); ent.writeUInt32LE(22, 12);
const ico = Buffer.concat([icondir, ent, png256]);

/* ---- 三份输出：窗口 / 快捷方式 / Android ---- */
const buildDir = path.join(root, 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'icon.png'), png256);
fs.writeFileSync(path.join(buildDir, 'fabula.ico'), ico);
const androidRes = path.join(root, 'android', 'res', 'mipmap-xxxhdpi');
fs.mkdirSync(androidRes, { recursive: true });
fs.writeFileSync(path.join(androidRes, 'ic_launcher.png'), png192);
console.log('build/icon.png + build/fabula.ico + android/res/mipmap-xxxhdpi/ic_launcher.png written'
  + ' (png256 ' + png256.length + 'B / ico ' + ico.length + 'B / png192 ' + png192.length + 'B)');
