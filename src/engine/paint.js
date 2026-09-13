
import { T as themeTokens, FONTS as UI_FONTS } from './ui/theme.js';

(() => {
'use strict';

/* ============================================================
   paint-lab · 绘画内核实验 01
   单文件 / 零依赖 / WebGL2

   这一版验证四件事：
     1. 笔画缓冲（stroke buffer）—— 解决 dab 重叠导致的不透明度累加
     2. 破坏性工具的脏矩形改写 —— 绕过"一个 pass 不能同时读写同一纹理"，
        并且不能靠交换缓冲推进（那样矩形外会残留旧像素，就是花屏）
     3. 选区掩膜贯通管线 —— 掩膜不是工具选项，是必经环节
     4. GPU 端脏矩形撤销 —— 不 readPixels，快照留在显存
   ============================================================ */

const DW = 1600, DH = 1000;          // 文档分辨率
const UNDO_MAX_BYTES = 192 * 1024 * 1024;   // 显存保护硬上限（不随偏好变）
/* 步数上限来自统一偏好（设置面板可调）；引擎独立可跑时兜底 40 */
function undoLimit() {
  try {
    const p = window.__fabulaPrefs;
    const n = p && +p.get('undoSteps');
    return (n && n > 0) ? Math.min(n, 200) : 40;
  } catch (_) { return 40; }
}

/* ---------- DOM ---------- */
const glc = document.getElementById('gl');
const ovc = document.getElementById('ov');
const stage = document.getElementById('stage');
const errBox = document.getElementById('err');
const uic = document.getElementById('ui');      /* 自绘 UI 层（工具条/色板/HUD 全画在这里） */
const uctx = uic.getContext('2d');

const gl = glc.getContext('webgl2', {
  /* alpha:true —— 文档外区域输出透明，透出 .board-stage 的 CSS 底色（montage 同款观感：
     画板区的"画布之外"由 DOM 层负责，画布只负责文档本身） */
  alpha: true, antialias: false, depth: false, stencil: false,
  premultipliedAlpha: false, preserveDrawingBuffer: false,
});

if (!gl) {
  errBox.style.display = 'grid';
  errBox.textContent = '这个页面需要 WebGL2。请用较新的 Chrome / Edge / Firefox / Safari 打开。';
  return;
}
gl.getExtension('EXT_color_buffer_float');
const HAS_FLOAT = !!gl.getExtension('EXT_color_buffer_float');
const TEX_IF = HAS_FLOAT ? gl.RGBA16F : gl.RGBA8;
const TEX_TY = HAS_FLOAT ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

/* 未捕获异常直接显示在画面上：demo 阶段不静默吞错，报错立即可见可报告 */
window.addEventListener('error', (ev) => {
  errBox.style.display = 'grid';
  errBox.textContent = '脚本错误：' + (ev.message || 'unknown')
    + (ev.lineno ? '（第 ' + ev.lineno + ' 行）' : '') + ' —— 请把这段文字截图报告';
});

/* ============================================================
   GL 基础设施
   ============================================================ */

function mkShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    console.error(log, src);
    throw new Error('着色器编译失败：' + log);
  }
  return s;
}

function mkProg(vs, fs, names) {
  const p = gl.createProgram();
  const a = mkShader(gl.VERTEX_SHADER, vs);
  const b = mkShader(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, a); gl.attachShader(p, b);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('链接失败：' + gl.getProgramInfoLog(p));
  }
  gl.deleteShader(a); gl.deleteShader(b);
  const u = {};
  for (const n of names) u[n] = gl.getUniformLocation(p, n);
  return { p, u };
}

function mkTex(w, h, filter, fmt, type) {
  fmt = fmt || TEX_IF; type = type || TEX_TY;
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, gl.RGBA, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

const fbo = gl.createFramebuffer();
let curBbox = [0, 0, DW, DH];

/* 绑定渲染目标。bx 未给定时为全画布；给定时用 scissor + viewport 限定到脏矩形。
   bbox 坐标一律为文档坐标（原点左上，y 向下）。 */
/* 脏矩形钳制到文档范围。floor/ceil 的方向错一个像素就会花屏/丢边 ——
   这类"必须全引擎同一份"的正确性敏感代码不许有第二个版本。
   pad = 每侧外扩像素（变形的羽化余量等）。返回 null 表示空矩形。 */
function clampBBox(x, y, w, h, pad = 0) {
  x = Math.max(0, Math.floor(x - pad)); y = Math.max(0, Math.floor(y - pad));
  w = Math.min(DW - x, Math.ceil(w + pad * 2)); h = Math.min(DH - y, Math.ceil(h + pad * 2));
  return (w <= 0 || h <= 0) ? null : [x, y, w, h];
}

function beginPass(tex, bx, by, bw, bh) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  /* pass 内默认关混合 —— 需要混合的调用方（只有 drawDabs）显式开。
     以前每个调用点自己关，漏一处就会带着脏混合态画出错误结果 */
  gl.disable(gl.BLEND);
  if (bx === undefined) {
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, DW, DH);
    curBbox = [0, 0, DW, DH];
    return true;
  }
  const c = clampBBox(bx, by, bw, bh);
  if (!c) return false;
  const [x, y, w, h] = c;
  const ygl = DH - y - h;
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(x, ygl, w, h);
  gl.viewport(x, ygl, w, h);
  curBbox = [x, y, w, h];
  return true;
}

function fsQuad() { gl.bindVertexArray(fsVAO); gl.drawArrays(gl.TRIANGLES, 0, 3); }

/* ---------- 全屏三角形（无需 VBO） ---------- */
const FS_VS = `#version 300 es
out vec2 vUV;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/* ---------- 共建函数：文档坐标 <-> 纹理 UV ----------
   纹理 v=0 对应文档底边。canvasToUV(c) = (c.x/W, 1 - c.y/H) */
const COMMON = `
uniform vec4 u_bbox;
uniform vec2 u_res;
vec2 bboxUV(vec2 gv){
  return vec2(u_bbox.x/u_res.x, 1.0 - (u_bbox.y + u_bbox.w)/u_res.y)
       + gv * vec2(u_bbox.z/u_res.x, u_bbox.w/u_res.y);
}
vec2 uvToCanvas(vec2 uv){ return vec2(uv.x*u_res.x, (1.0-uv.y)*u_res.y); }
vec2 canvasToUV(vec2 c){ return vec2(c.x/u_res.x, 1.0 - c.y/u_res.y); }
float segDist(vec2 p, vec2 a, vec2 b, out float t){
  vec2 ab = b - a;
  float l2 = max(dot(ab,ab), 1e-6);
  t = clamp(dot(p-a, ab)/l2, 0.0, 1.0);
  return length(p - (a + ab*t));
}`;
const HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\n';

/* ============================================================
   着色器
   ============================================================ */

/* --- 1. 笔尖印章（写入笔画缓冲）--- */
const DAB_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
uniform vec2 u_res;
uniform vec2 u_center;
uniform vec2 u_half;
uniform float u_rot;
out vec2 v_local;
void main(){
  float c = cos(u_rot), s = sin(u_rot);
  vec2 p = a_corner * u_half;
  vec2 r = vec2(p.x*c - p.y*s, p.x*s + p.y*c);
  vec2 w = u_center + r;
  gl_Position = vec4(w.x/u_res.x*2.0-1.0, 1.0 - w.y/u_res.y*2.0, 0.0, 1.0);
  v_local = a_corner;
}`;

/* 注意：dab 阶段**不乘掩膜**。
   笔画缓冲是一块纯覆盖率缓冲，掩膜只在"合成进图层"和"显示预览"两处各乘一次。
   两处用同一个公式，预览和落定才逐像素一致；在 dab 上先乘一次、合成再乘一次的话，
   选区边缘会被平方（50% 的边界变成 25%），表现为沿选区一圈发暗的细边，
   而且松开笔的一瞬间画面会变一次。 */
const DAB_FS = HEAD + `
in vec2 v_local;
uniform float u_hardness;
uniform float u_flow;
uniform float u_tip;          // 0 = 圆笔尖, 1 = 方笔尖（中间值得到超椭圆）
out vec4 frag;
void main(){
  vec2 q = v_local;
  float dr = length(q);
  float ds = max(abs(q.x), abs(q.y));
  float d = mix(dr, ds, clamp(u_tip, 0.0, 1.0));
  if (d >= 1.0) discard;
  float h = clamp(u_hardness, 0.0, 0.97);
  float a = 1.0 - smoothstep(h, 1.0, d);
  a = clamp(a, 0.0, 1.0) * u_flow;
  frag = vec4(a, a, a, a);
}`;

/* --- 纸纹（颗粒）---
   注意：颗粒不能在 dab 阶段施加。笔画缓冲用 MAX 合并覆盖率，
   相邻 dab 会互相盖掉对方的颗粒，纹理直接消失。
   正确做法是等覆盖度定稿后，在合成/显示阶段乘一次 —— 这才是"纸纹"。 */
const GRAIN = `
uniform float u_grain;        // 0 = 无颗粒
uniform float u_grainScale;   // 颗粒尺度（文档像素）
uniform float u_pigment;      // 颗粒对颜色的扰动强度（水粉的斑驳）
float ghash(vec2 p){
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.56);
  return fract(p.x * p.y);
}
float gnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(ghash(i), ghash(i + vec2(1.0, 0.0)), f.x),
             mix(ghash(i + vec2(0.0, 1.0)), ghash(i + vec2(1.0, 1.0)), f.x), f.y);
}
/* 返回：x = 覆盖率乘数, y = 颗粒原始值 */
vec2 grainPair(vec2 doc){
  if (u_grain <= 0.001) return vec2(1.0, 0.5);
  float s = max(u_grainScale, 0.6);
  float g = gnoise(doc / s) * 0.62 + gnoise(doc / (s * 0.41) + 17.0) * 0.38;
  return vec2(clamp(1.0 - u_grain * (1.0 - g) * 1.15, 0.0, 1.0), g);
}`;

/* --- 2. 笔画合成（把笔画缓冲烧进图层）--- */
const COMP_FS = HEAD + GRAIN + `
in vec2 vUV;
uniform sampler2D u_layer;
uniform sampler2D u_stroke;
uniform sampler2D u_mask;
uniform vec4 u_color;
uniform float u_opacity;
uniform float u_erase;
out vec4 frag;
void main(){
  vec4 base = texture(u_layer, vUV);
  vec2 gr = grainPair(gl_FragCoord.xy);       /* COMP 渲染到整幅画布的 FBO，坐标即文档坐标 */
  float cov = texture(u_stroke, vUV).a * gr.x;
  cov *= u_opacity * texture(u_mask, vUV).r;
  if (u_erase > 0.5) {
    frag = base * (1.0 - cov);
  } else {
    vec3 rgb = u_color.rgb;
    if (u_pigment > 0.001) rgb = clamp(rgb * (1.0 + u_pigment * (gr.y - 0.5) * 1.7), 0.0, 1.0);
    vec4 src = vec4(rgb * cov, cov);
    frag = src + base * (1.0 - src.a);
  }
}`;

/* --- 3. 区域拷贝（撤销快照 / 恢复）--- */
const BLIT_FS = HEAD + `
in vec2 vUV;
uniform sampler2D u_tex;
uniform vec4 u_src;
out vec4 frag;
void main(){ frag = texture(u_tex, u_src.xy + vUV * u_src.zw); }`;

/* --- 3b. 填充（受选区约束）---
   和笔刷走同一条规矩：掩膜在这里乘。选区内填成新色，选区外原样保留。
   图层是预乘 alpha，填充色 alpha=1 所以预乘后的 rgb 就是颜色本身。
   不这样做的话，"填充"会无视选区把整张画布铺满 —— 和"掩膜是管线必经环节"
   的说法自相矛盾，用户一旦用过套索就会立刻发现。 */
const FILL_FS = HEAD + `
in vec2 vUV;
uniform sampler2D u_layer;
uniform sampler2D u_mask;
uniform vec4 u_color;
out vec4 frag;
void main(){
  vec4 base = texture(u_layer, vUV);
  float m = texture(u_mask, vUV).r;
  frag = mix(base, vec4(u_color.rgb, 1.0), m);
}`;

/* --- 3c. 变形：提取 + 提交 ---
   变形是模态工具：会话开始时把图层拆成两半 ——
   内容 = paint×mask（选区里的东西，无选区时 mask 全白 = 全部内容），
   背景 = paint×(1−mask)。预览阶段图层一个字节都不动，
   显示着色器用逆矩阵从内容纹理采样叠上去；提交时才一次性 over 合成写回。
   图层是预乘 alpha，rgb 和 a 必须同乘，线性插值和 over 合成才都正确。 */
const XF_EXTRACT_FS = HEAD + `
in vec2 vUV;
uniform sampler2D u_layer;
uniform sampler2D u_mask;
uniform float u_keep;
out vec4 frag;
void main(){
  vec4 c = texture(u_layer, vUV);
  float m = texture(u_mask, vUV).r;
  frag = u_keep > 0.5 ? c * m : c * (1.0 - m);
}`;

/* 提交：new = over(背景, T(内容))。渲染目标直接是图层本身（本 pass 不采样它，
   无反馈环），vUV 只覆盖脏矩形，所以要先把 vUV 换算回文档坐标。
   边缘 1.5px 羽化：旋转/缩放后的内容边缘与背景的过渡靠它，不然是锯齿硬边。 */
const XF_COMMIT_FS = HEAD + `
in vec2 vUV;
uniform sampler2D u_back;
uniform sampler2D u_src;
uniform mat2 u_xfLin;
uniform vec2 u_xfOff;
uniform vec4 u_xfBox;
uniform vec4 u_rect;
uniform vec2 u_res;
out vec4 frag;
void main(){
  vec2 doc = vec2(u_rect.x + vUV.x * u_rect.z, u_rect.y + (1.0 - vUV.y) * u_rect.w);
  vec2 uv = vec2(doc.x / u_res.x, 1.0 - doc.y / u_res.y);
  vec4 back = texture(u_back, uv);
  vec2 sc = u_xfLin * doc + u_xfOff;
  float f = 1.5;
  float bx = smoothstep(u_xfBox.x - f, u_xfBox.x + f, sc.x)
           * (1.0 - smoothstep(u_xfBox.z - f, u_xfBox.z + f, sc.x));
  float by = smoothstep(u_xfBox.y - f, u_xfBox.y + f, sc.y)
           * (1.0 - smoothstep(u_xfBox.w - f, u_xfBox.w + f, sc.y));
  vec4 s = texture(u_src, vec2(sc.x / u_res.x, 1.0 - sc.y / u_res.y)) * (bx * by);
  frag = s + back * (1.0 - s.a);
}`;

/* --- 4. 涂抹 --- */
const SMUDGE_FS = HEAD + COMMON + `
in vec2 vUV;
uniform sampler2D u_src;
uniform sampler2D u_mask;
uniform sampler2D u_bucket;
uniform vec2 u_p0;
uniform vec2 u_p1;
uniform float u_radius;
uniform float u_hardness;
uniform float u_strength;
uniform float u_drag;
uniform float u_colorRate;
out vec4 frag;
void main(){
  vec2 uv = bboxUV(vUV);
  vec2 p = uvToCanvas(uv);
  float t;
  float d = segDist(p, u_p0, u_p1, t);
  float r = max(u_radius, 1.0);
  float hh = clamp(u_hardness, 0.0, 0.97) * r;
  float w = 1.0 - smoothstep(hh, r, d);
  vec4 orig = texture(u_src, uv);
  if (w <= 0.002) { frag = orig; return; }
  w *= texture(u_mask, uv).r;

  vec2 ab = u_p1 - u_p0;
  float L = max(length(ab), 1e-6);
  vec2 dir = ab / L;

  /* 本段的施加量按"这段走过的弧长"归一，而不是按采样点个数。
     直接按段数施加会有一个很隐蔽的后果：画得越慢 → 采样越密 → 段数越多
     → 同一个像素被反复涂抹，糊成一团（手感就是"劲太大"）；
     画得快反而几乎不动。而且同一笔画在 60Hz 和 120Hz 设备上效果还不一样。
     k 是这一段占"参考弧长"的比例，参考弧长取笔刷半径的 0.35。
     上限 2 只是防止笔尖瞬移（合成事件、丢帧）时一段吃满整块脏矩形；
     上限取 2 而不是 1，是因为取 1 会正好在"快笔"这一侧咬到，
     让快笔比慢笔少涂将近一半 —— 那就又回到速度相关了。 */
  float k = min(L / max(u_radius * 0.5, 2.0), 2.0);

  /* 拖拽取样：从"来时方向"取，距离固定为半径的一个比例。
     所以拖尾长度只由 drag 决定，不随运笔速度变化。 */
  vec2 sp = p - dir * (u_radius * u_drag * w);
  vec4 dragged = texture(u_src, canvasToUV(sp));
  vec4 col = mix(orig, dragged, clamp(u_strength * w * k, 0.0, 1.0));

  /* 颜料桶上色（预乘空间混合），同样按弧长归一 */
  vec4 bucket = texture(u_bucket, vec2(0.5, 0.5));
  col = mix(col, bucket, clamp(u_colorRate * w * k, 0.0, 1.0));
  frag = col;
}`;

/* --- 5. 模糊（分离式两趟）--- */
const BLUR_FS = HEAD + COMMON + `
in vec2 vUV;
uniform sampler2D u_tex;
uniform vec2 u_dir;
uniform float u_radius;
out vec4 frag;
void main(){
  vec2 uv = bboxUV(vUV);
  vec2 p = uvToCanvas(uv);
  float r = max(u_radius, 0.5);
  float sigma = max(r * 0.5, 0.35);
  float inv2s2 = 1.0 / (2.0 * sigma * sigma);
  vec4 sum = vec4(0.0);
  float ws = 0.0;
  for (int i = -6; i <= 6; i++) {
    float x = float(i) * r / 6.0;
    float w = exp(-x * x * inv2s2);
    sum += texture(u_tex, canvasToUV(p + u_dir * x)) * w;
    ws += w;
  }
  frag = sum / ws;
}`;

const BLUR_MIX_FS = HEAD + COMMON + `
in vec2 vUV;
uniform sampler2D u_blur;     // 已经过横向模糊的中间结果
uniform sampler2D u_orig;     // 原始图层
uniform sampler2D u_mask;
uniform vec2 u_p0;
uniform vec2 u_p1;
uniform float u_radius;
uniform float u_hardness;
uniform float u_strength;
uniform float u_blurRadius;
out vec4 frag;
void main(){
  vec2 uv = bboxUV(vUV);
  vec2 p = uvToCanvas(uv);
  float t;
  float d = segDist(p, u_p0, u_p1, t);
  float r = max(u_radius, 1.0);
  float hh = clamp(u_hardness, 0.0, 0.97) * r;
  float w = 1.0 - smoothstep(hh, r, d);
  vec4 o = texture(u_orig, uv);
  if (w <= 0.002) { frag = o; return; }
  w *= texture(u_mask, uv).r;

  /* 分离式高斯的第二趟（纵向）。把混合一起算在这里，
     就不用再开一块整幅尺寸的临时纹理。 */
  float br = max(u_blurRadius, 0.5);
  float sigma = max(br * 0.5, 0.35);
  float inv2s2 = 1.0 / (2.0 * sigma * sigma);
  vec4 sum = vec4(0.0);
  float ws = 0.0;
  for (int i = -6; i <= 6; i++) {
    float y = float(i) * br / 6.0;
    float g = exp(-y * y * inv2s2);
    sum += texture(u_blur, canvasToUV(p + vec2(0.0, y))) * g;
    ws += g;
  }
  vec4 b = sum / ws;

  /* 与涂抹同理：施加量按弧长归一，慢笔才不会把画面糊穿 */
  float k = min(length(u_p1 - u_p0) / max(u_radius * 0.5, 2.0), 2.0);
  frag = mix(o, b, clamp(w * u_strength * k, 0.0, 1.0));
}`;

/* --- 6. 液化 / 形变（反向重采样，所以不会出现空洞）--- */
const WARP_FS = HEAD + COMMON + `
in vec2 vUV;
uniform sampler2D u_src;
uniform sampler2D u_mask;
uniform vec2 u_p0;
uniform vec2 u_p1;
uniform float u_radius;
uniform float u_hardness;
uniform int u_mode;
uniform float u_strength;
out vec4 frag;
void main(){
  vec2 uv = bboxUV(vUV);
  vec2 p = uvToCanvas(uv);
  float t;
  float d = segDist(p, u_p0, u_p1, t);
  float r = max(u_radius, 1.0);
  float hh = clamp(u_hardness, 0.0, 0.97) * r;
  float w = (1.0 - smoothstep(hh, r, d)) * u_strength;
  vec4 orig = texture(u_src, uv);
  if (w <= 0.002) { frag = orig; return; }
  w *= texture(u_mask, uv).r;

  vec2 ab = u_p1 - u_p0;
  vec2 closest = u_p0 + ab * t;
  vec2 src;
  if (u_mode == 0) {
    src = p - ab * w;                                   // 前推
  } else if (u_mode == 1) {
    float ang = w * 3.14159 * 0.7;                      // 旋转
    vec2 v = p - closest;
    float c = cos(ang), s = sin(ang);
    src = closest + vec2(v.x*c - v.y*s, v.x*s + v.y*c);
  } else if (u_mode == 2) {
    src = closest + (p - closest) * (1.0 - 0.55 * w);   // 收缩
  } else if (u_mode == 3) {
    src = closest + (p - closest) * (1.0 + 1.10 * w);   // 膨胀
  } else if (u_mode == 4 || u_mode == 5) {
    /* 透镜（Krita Lens In/Out 的 r²/r⁴ 径向畸变思路）。
       幅度乘 (1-rn²) 让笔刷边缘严格收敛 —— Krita 的 Lens 在边界不连续
       （docs/04 §3.3 记过这个坑），这里不重复。 */
    vec2 v = p - closest;
    float rn = clamp(length(v) / r, 0.0, 1.0);
    float amp = 0.5 * w * (1.0 - rn * rn);
    float k = (u_mode == 4) ? (1.0 + amp) : 1.0 / (1.0 + amp);
    src = closest + v * k;
  } else {
    src = p;
  }
  frag = texture(u_src, canvasToUV(src));
}`;

/* --- 7. 颜料桶（1×1 输出，把笔刷下的画布颜色平均进来）--- */
const BUCKET_FS = HEAD + `
uniform sampler2D u_paint;
uniform sampler2D u_prev;
uniform vec2 u_center;
uniform float u_sampleRadius;
uniform float u_blend;
uniform vec2 u_res;
out vec4 frag;
void main(){
  vec4 sum = vec4(0.0);
  float cnt = 0.0;
  for (int i = -3; i <= 3; i++) {
    for (int j = -3; j <= 3; j++) {
      vec2 off = vec2(float(i), float(j)) / 3.0 * u_sampleRadius;
      vec2 c = u_center + off;
      vec2 uv = clamp(vec2(c.x/u_res.x, 1.0 - c.y/u_res.y), 0.0, 1.0);
      sum += texture(u_paint, uv);
      cnt += 1.0;
    }
  }
  vec4 avg = sum / max(cnt, 1.0);
  frag = mix(texture(u_prev, vec2(0.5, 0.5)), avg, u_blend);
}`;

/* --- 7b. 油漆桶合成（洪水填充结果 × 选区掩膜 → 图层）---
   填充区域由 CPU 扫描线算出（见 doFloodFill），烧成一张白=填充的掩膜纹理。
   和笔刷走同一条规矩：选区掩膜在这里相乘，选区外一个像素都不动。 */
const FLOOD_FS = HEAD + `
in vec2 vUV;
uniform sampler2D u_layer;
uniform sampler2D u_flood;
uniform sampler2D u_mask;
uniform vec4 u_color;
out vec4 frag;
void main(){
  vec4 base = texture(u_layer, vUV);
  float f = texture(u_flood, vUV).r * texture(u_mask, vUV).r;
  frag = mix(base, vec4(u_color.rgb, 1.0), f);
}`;

/* --- 8. 呈现（背景棋盘 + 视图变换 + 实时笔画预览）--- */
const DISP_FS = HEAD + GRAIN + `
in vec2 vUV;
uniform sampler2D u_layer;
uniform sampler2D u_stroke;
uniform sampler2D u_mask;
uniform vec4 u_color;
uniform float u_opacity;
uniform float u_erase;
uniform vec2 u_viewRes;
uniform vec2 u_docRes;
uniform vec3 u_view;      // scale, ox, oy
uniform vec3 u_paper;      // 画布底色（montage 的 paper：纯预览层，不进导出/帧文件）
uniform float u_xfOn;
uniform sampler2D u_xfBack;
uniform sampler2D u_xfSrc;
uniform mat2 u_xfLin;
uniform vec2 u_xfOff;
uniform vec4 u_xfBox;
out vec4 frag;
void main(){
  vec2 sp = vec2(vUV.x * u_viewRes.x, vUV.y * u_viewRes.y);

  vec2 s = vec2(sp.x, u_viewRes.y - sp.y);
  vec2 doc = (s - u_view.yz) / u_view.x;
  if (doc.x < 0.0 || doc.y < 0.0 || doc.x > u_docRes.x || doc.y > u_docRes.y) {
    frag = vec4(0.0, 0.0, 0.0, 0.0);   /* 文档外透明：透出画板区的 CSS 底色 */
    return;
  }
  vec2 uv = vec2(doc.x/u_docRes.x, 1.0 - doc.y/u_docRes.y);
  vec4 base = texture(u_layer, uv);
  if (u_xfOn > 0.5) base = texture(u_xfBack, uv);   /* 变形预览：图层被拆成背景+内容 */
  vec2 gr = grainPair(doc);                   /* 与 COMP 用同一套公式，收笔瞬间才不会跳变 */
  float cov = texture(u_stroke, uv).a * gr.x * u_opacity
            * texture(u_mask, uv).r;          /* 掩膜在这里乘，和 COMP 完全同式 */
  vec4 p;
  if (u_erase > 0.5) {
    p = base * (1.0 - cov);
  } else {
    vec3 rgb = u_color.rgb;
    if (u_pigment > 0.001) rgb = clamp(rgb * (1.0 + u_pigment * (gr.y - 0.5) * 1.7), 0.0, 1.0);
    vec4 src = vec4(rgb * cov, cov);
    p = src + base * (1.0 - src.a);
  }
  if (u_xfOn > 0.5) {
    /* 内容用逆矩阵采样：屏幕像素反查它在源纹理里的出处。
       边缘羽化与提交着色器同一套式子，预览和落定逐像素一致。 */
    vec2 sc = u_xfLin * doc + u_xfOff;
    float f = 1.5;
    float bx = smoothstep(u_xfBox.x - f, u_xfBox.x + f, sc.x)
             * (1.0 - smoothstep(u_xfBox.z - f, u_xfBox.z + f, sc.x));
    float by = smoothstep(u_xfBox.y - f, u_xfBox.y + f, sc.y)
             * (1.0 - smoothstep(u_xfBox.w - f, u_xfBox.w + f, sc.y));
    vec4 s = texture(u_xfSrc, vec2(sc.x / u_docRes.x, 1.0 - sc.y / u_docRes.y)) * (bx * by);
    p = s + p * (1.0 - s.a);
  }
  frag = vec4(p.rgb + u_paper * (1.0 - p.a), 1.0);
}`;

/* ============================================================
   程序装配
   ============================================================ */
/* u_res 是**顶点**着色器在用的：把文档坐标换算成 NDC。别因为片元着色器不用了就删掉。 */
const P_dab    = mkProg(DAB_VS, DAB_FS, ['u_res','u_center','u_half','u_rot','u_hardness','u_flow','u_tip']);
const P_comp   = mkProg(FS_VS, COMP_FS, ['u_layer','u_stroke','u_mask','u_color','u_opacity','u_erase','u_grain','u_grainScale','u_pigment']);
const P_blit   = mkProg(FS_VS, BLIT_FS, ['u_tex','u_src']);
const P_fill   = mkProg(FS_VS, FILL_FS, ['u_layer','u_mask','u_color']);
const P_smudge = mkProg(FS_VS, SMUDGE_FS, ['u_src','u_mask','u_bucket','u_p0','u_p1','u_radius','u_hardness','u_strength','u_drag','u_colorRate','u_bbox','u_res']);
const P_blur   = mkProg(FS_VS, BLUR_FS, ['u_tex','u_dir','u_radius','u_bbox','u_res']);
const P_blurmix= mkProg(FS_VS, BLUR_MIX_FS, ['u_blur','u_orig','u_mask','u_p0','u_p1','u_radius','u_hardness','u_strength','u_blurRadius','u_bbox','u_res']);
const P_warp   = mkProg(FS_VS, WARP_FS, ['u_src','u_mask','u_p0','u_p1','u_radius','u_hardness','u_mode','u_strength','u_bbox','u_res']);
const P_bucket = mkProg(FS_VS, BUCKET_FS, ['u_paint','u_prev','u_center','u_sampleRadius','u_blend','u_res']);
const P_disp   = mkProg(FS_VS, DISP_FS, ['u_layer','u_stroke','u_mask','u_color','u_opacity','u_erase','u_viewRes','u_docRes','u_view','u_paper','u_grain','u_grainScale','u_pigment','u_xfOn','u_xfBack','u_xfSrc','u_xfLin','u_xfOff','u_xfBox']);
const P_xfe    = mkProg(FS_VS, XF_EXTRACT_FS, ['u_layer','u_mask','u_keep']);
const P_xfc    = mkProg(FS_VS, XF_COMMIT_FS, ['u_back','u_src','u_xfLin','u_xfOff','u_xfBox','u_rect','u_res']);
const P_flood  = mkProg(FS_VS, FLOOD_FS, ['u_layer','u_flood','u_mask','u_color']);

/* ---------- VAO ---------- */
const fsVAO = gl.createVertexArray();                 // 全屏三角形，无属性

const quadBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
  -1,-1, 1,-1, 1,1, -1,-1, 1,1, -1,1,
]), gl.STATIC_DRAW);
const dabVAO = gl.createVertexArray();
gl.bindVertexArray(dabVAO);
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

/* ---------- 纹理 ---------- */
let texA = mkTex(DW, DH, gl.LINEAR);
let texB = mkTex(DW, DH, gl.LINEAR);
let paintCur = texA, paintAlt = texB;
let strokeTex = mkTex(DW, DH, gl.LINEAR);
let blurTmp   = mkTex(DW, DH, gl.LINEAR);
let fxTmp     = mkTex(DW, DH, gl.LINEAR);   // 破坏性工具改写脏矩形时的暂存
let preScratch= mkTex(DW, DH, gl.LINEAR);   // 破坏性工具的前置快照
let bucketA   = mkTex(1, 1, gl.NEAREST);
let bucketB   = mkTex(1, 1, gl.NEAREST);
let bucketCur = bucketA, bucketAlt = bucketB;
let maskTex   = mkTex(DW, DH, gl.LINEAR, gl.RGBA8, gl.UNSIGNED_BYTE);
let exportTex = mkTex(DW, DH, gl.NEAREST, gl.RGBA8, gl.UNSIGNED_BYTE);
let floodTex  = mkTex(DW, DH, gl.NEAREST, gl.RGBA8, gl.UNSIGNED_BYTE);   // 油漆桶的填充区域掩膜

function swapPaint(){ const t = paintCur; paintCur = paintAlt; paintAlt = t; }
function swapBucket(){ const t = bucketCur; bucketCur = bucketAlt; bucketAlt = t; }

function clearTex(tex) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND);
  gl.viewport(0, 0, DW, DH);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
function clearSmall(tex) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND);
  gl.viewport(0, 0, 1, 1);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
[paintCur, paintAlt, strokeTex, blurTmp, fxTmp, preScratch, bucketA, bucketB].forEach(t => {
  t === bucketA || t === bucketB ? clearSmall(t) : clearTex(t);
});

/* ============================================================
   选区掩膜（用 2D canvas 光栅化，白=选中）
   ============================================================ */
const maskCv = document.createElement('canvas');
maskCv.width = DW; maskCv.height = DH;
/* 每次改选区都要 getImageData 读回来提轮廓，所以这里要 willReadFrequently */
const mctx = maskCv.getContext('2d', { willReadFrequently: true });

function maskReset() {
  mctx.globalCompositeOperation = 'source-over';
  mctx.fillStyle = '#fff';
  mctx.fillRect(0, 0, DW, DH);
  maskChanged();
}
/* canvas → 纹理上传的唯一入口。FLIP_Y 的开与关必须成对出现，
   漏关会污染之后所有 texImage2D 的方向 —— 收到一处就漏不了 */
function uploadCanvasTex(tex, cv, filter) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
}
function maskUpload() {
  uploadCanvasTex(maskTex, maskCv, gl.LINEAR);
}
function maskChanged() { maskUpload(); buildAnts(); }

/* ---------- 蚂蚁线 ----------
   轮廓直接从**掩膜**里提，而不是记住"用户画过的路径"。
   记路径的做法有一堆对不上的情况：
     · replace 之后旧路径没被清掉 → 屏幕上挂着早就不存在的圈
     · 反选之后路径和真实选区正好相反 → 干脆没有线可画
     · add / sub 拼出来的边界不是任何一条路径
   从掩膜提取则永远和真实选区逐像素一致，且天然处理多段、带洞、自交的情况。 */
const antsWhite = document.createElement('canvas');
const antsBlack = document.createElement('canvas');
let antsReady = false;

function buildAnts() {
  const src = mctx.getImageData(0, 0, DW, DH).data;
  for (const cv of [antsWhite, antsBlack]) { cv.width = DW; cv.height = DH; }
  const wctx = antsWhite.getContext('2d');
  const img = wctx.createImageData(DW, DH);
  const o = img.data;
  const row = DW * 4;

  /* 取 50% 等值线：一个像素的四邻居里只要有一个在阈值另一侧，它就是边界像素。
     四邻居都查（而不是只查左/上）是为了让线有两像素宽 —— 只有一像素宽的话，
     视图缩小时轮廓不足一个屏幕像素，蚂蚁线会被抗锯齿抹成一条灰影。 */
  for (let y = 0; y < DH; y++) {
    const yr = y * row;
    for (let x = 0; x < DW; x++) {
      const i = yr + x * 4;
      const s = src[i] > 127;
      let e = false;
      if (x > 0) e = (src[i - 4] > 127) !== s;
      if (!e && y > 0) e = (src[i - row] > 127) !== s;
      if (!e && x < DW - 1) e = (src[i + 4] > 127) !== s;
      if (!e && y < DH - 1) e = (src[i + row] > 127) !== s;
      if (e) { o[i] = 255; o[i + 1] = 255; o[i + 2] = 255; o[i + 3] = 255; }
    }
  }
  wctx.putImageData(img, 0, 0);

  const bctx = antsBlack.getContext('2d');
  bctx.clearRect(0, 0, DW, DH);
  bctx.drawImage(antsWhite, 0, 0);
  bctx.globalCompositeOperation = 'source-in';
  bctx.fillStyle = '#000';
  bctx.fillRect(0, 0, DW, DH);
  antsReady = true;
}

/* 45° 斜条纹：白色处保留、透明处挖空。周期 16px（沿 x）。
   只造图，CanvasPattern 等覆盖层的 2D 上下文就绪后再建。 */
const antsStripeCv = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  const d = g.createImageData(16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const on = ((x + y) % 16) < 8;
      const i = (y * 16 + x) * 4;
      d.data[i] = 255; d.data[i + 1] = 255; d.data[i + 2] = 255;
      d.data[i + 3] = on ? 255 : 0;
    }
  }
  g.putImageData(d, 0, 0);
  return c;
})();

const antsTmp = document.createElement('canvas');
const actx = antsTmp.getContext('2d');

/* ============================================================
   撤销：GPU 端脏矩形快照
   ============================================================ */
const undoStack = [];
const redoStack = [];
let undoBytes = 0;

function snapRegion(srcTex, x, y, w, h) {
  const c = clampBBox(x, y, w, h);
  if (!c) return null;
  [x, y, w, h] = c;
  const t = mkTex(w, h, gl.LINEAR);
  beginPass(t);
  gl.disable(gl.BLEND);
  gl.useProgram(P_blit.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform1i(P_blit.u.u_tex, 0);
  gl.uniform4f(P_blit.u.u_src, x/DW, 1 - (y + h)/DH, w/DW, h/DH);
  fsQuad();
  return { tex: t, x, y, w, h, bytes: w * h * (HAS_FLOAT ? 8 : 4) };
}

function restoreRegion(e) {
  beginPass(paintCur, e.x, e.y, e.w, e.h);
  gl.disable(gl.BLEND);
  gl.useProgram(P_blit.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, e.tex);
  gl.uniform1i(P_blit.u.u_tex, 0);
  gl.uniform4f(P_blit.u.u_src, 0, 0, 1, 1);
  fsQuad();
}

/* 把 src 的当前脏矩形原样贴回 dst 的同一区域。
   ─────────────────────────────────────────────────────────
   破坏性工具（涂抹 / 模糊 / 液化）为什么要这一步，而不能像烘焙笔画那样
   直接"渲染到备用缓冲 + swap"：

   它们每趟只写脏矩形那一小块。swap 之后，新图层在矩形之外的部分
   是备用缓冲里上一次留下的旧像素 —— 于是每一段笔画都会让画面
   在"新内容"和"上一笔的旧内容"之间来回闪，也就是花屏。

   正确的做法是：把滤镜结果算到暂存纹理，再按脏矩形贴回图层本身。
   图层在矩形之外一个像素都没动过，自然不会有残留。 */
function copyBBox(src, dst) {
  const x = curBbox[0], y = curBbox[1], w = curBbox[2], h = curBbox[3];
  beginPass(dst, x, y, w, h);
  gl.disable(gl.BLEND);
  gl.useProgram(P_blit.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);
  gl.uniform1i(P_blit.u.u_tex, 0);
  /* vUV 在脏矩形内恰好是 0..1（viewport 被收到了矩形上），
     所以取样矩形要按"源纹理的绝对坐标"给 —— src 是和图层同尺寸的整幅纹理。 */
  gl.uniform4f(P_blit.u.u_src, x / DW, 1 - (y + h) / DH, w / DW, h / DH);
  fsQuad();
}

function pushUndo(entry) {
  if (!entry) return;
  undoStack.push(entry);
  undoBytes += entry.bytes;
  while (undoStack.length > undoLimit() || (undoBytes > UNDO_MAX_BYTES && undoStack.length > 4)) {
    const old = undoStack.shift();
    undoBytes -= old.bytes;
    gl.deleteTexture(old.tex);
  }
  for (const r of redoStack) { gl.deleteTexture(r.tex); }
  redoStack.length = 0;
  updateStat();
}

function doUndo() {
  if (!undoStack.length) return;
  const e = undoStack.pop(); undoBytes -= e.bytes;
  const cur = snapRegion(paintCur, e.x, e.y, e.w, e.h);
  restoreRegion(e);
  gl.deleteTexture(e.tex);
  if (cur) redoStack.push(cur);
  updateStat();
}
function doRedo() {
  if (!redoStack.length) return;
  const e = redoStack.pop();
  const cur = snapRegion(paintCur, e.x, e.y, e.w, e.h);
  restoreRegion(e);
  gl.deleteTexture(e.tex);
  if (cur) { undoStack.push(cur); undoBytes += cur.bytes; }
  updateStat();
}

/* 整层铺底色 */
function fillLayer(r, g, b, a) {
  const before = snapRegion(paintCur, 0, 0, DW, DH);
  beginPass(paintAlt);
  gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND);
  gl.viewport(0, 0, DW, DH);
  gl.useProgram(P_fill.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, paintCur);
  gl.uniform1i(P_fill.u.u_layer, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.uniform1i(P_fill.u.u_mask, 1);
  gl.uniform4f(P_fill.u.u_color, r, g, b, a);
  fsQuad();
  swapPaint();
  pushUndo(before);
}
function clearLayer() {
  const before = snapRegion(paintCur, 0, 0, DW, DH);
  clearTex(paintCur);
  pushUndo(before);
}

/* ============================================================
   参数 / 工具
   ============================================================ */
const P = {
  size: 38,
  opacity: 1.0,
  flow: 1.0,
  hardness: 0.55,
  spacing: 0.12,
  stabilize: 0.28,
  buildup: false,
  pressSize: true,
  pressFlow: true,
  /* --- 笔尖形状 --- */
  tip: 0,               // 0 圆 → 1 方
  roundness: 1.0,       // 笔尖压扁比（1 = 正圆）
  rotFollow: 0,         // 笔尖跟随笔画方向旋转
  /* --- 纸纹 / 颜料 --- */
  grain: 0,             // 颗粒强度
  grainScale: 3.0,      // 颗粒尺度 px
  pigment: 0,           // 颗粒对颜色的扰动（水粉的斑驳）
  /* --- 随机抖动 --- */
  jitterSize: 0,        // 每 dab 大小抖动
  jitterPos: 0,         // 每 dab 位置抖动（占笔刷直径比例）
  spread: 0,            // 沿笔画法线的散布（喷枪锥角）
  /* --- 时间 / 动态 --- */
  airbrush: false,      // 悬停也持续出墨
  airRate: 200,         // 每秒补发 dab 数
  dryOut: 0,            // 笔画内的流量衰减（铅笔越画越淡）
  /* --- 倾斜 --- */
  tiltOn: true,         // 倾角总开关：关闭后笔刷完全不受笔杆姿态影响
  angleOffset: 90,      // 笔刷默认角度（度）：倾角方位 → 笔头方向的映射偏移，按个人握笔习惯调
  tiltSize: 0,          // 倾斜 → 加宽（铅笔侧锋）
  tiltShape: 0,         // 倾斜 → 压扁并转向倾斜方位（马克笔平头）
  tiltFlow: 0,          // 倾斜 → 流量衰减（侧锋接触面大、单位压强小，墨量变淡）
  /* --- 修饰类工具 --- */
  /* 涂抹的"强度"现在定义成：在笔刷中心线上走一趟，原像素被替换掉的比例。
     内部的施加量是按弧长归一的，所以这个数字不随运笔快慢变。 */
  smudgeStrength: 0.30,
  smudgeDrag: 0.60,     // 拖尾长度 = 笔刷半径 × 这个比例
  smudgeColor: 0.08,
  blurStrength: 0.72,
  blurRadius: 14,
  warpMode: 0,
  warpStrength: 0.55,
  fillTolerance: 24,    // 油漆桶容差（0-100，映射到 0-255 的通道差）
};

/* ============================================================
   笔刷预设
   每个预设只做一件事：把 P 里的一组值覆盖成"这个笔该有的样子"。
   渲染路径完全共用 —— 铅笔和喷枪走的是同一套 dab 管线，
   区别只在参数组合，以及 dab 阶段的抖动/散布策略。
   ============================================================ */
const BRUSHES = {
  pen: {
    name: '秀丽笔', key: 'B',
    icon: 'M12 3c4 3 7 7 7 11a7 7 0 1 1-14 0c0-4 3-8 7-11z',
    p: { size:34, hardness:.46, spacing:.09, flow:1, opacity:1, buildup:0,
         tip:0, roundness:1, rotFollow:0, grain:0, pigment:0,
         jitterSize:0, jitterPos:0, spread:0,
         airbrush:0, dryOut:0, tiltSize:.3, tiltShape:0, tiltFlow:.35,
         pressSize:1, pressFlow:.85 },
    note: '软头秀丽笔：压感直接驱动笔宽，轻提收细、重按铺满 —— 对照 SAI 手感的基准笔。',
  },
  pencil: {
    name: '铅笔', key: 'P',
    icon: 'M4 20l3-1 11-11-2-2L5 17z M16 4l2 2 M4 20l1-3',
    p: { size:12, hardness:.88, spacing:.05, flow:.88, opacity:1, buildup:1,
         tip:0, roundness:1, rotFollow:0,
         grain:.62, grainScale:2.0, pigment:.2,
         jitterSize:.16, jitterPos:.22, spread:.35,
         airbrush:0, dryOut:.32, tiltSize:.85, tiltShape:0, tiltFlow:.45,
         pressSize:1, pressFlow:.85 },
    note: '硬笔尖 + 强纸纹 + 高间距抖动。笔尖倾斜会变宽（侧锋），笔画拖长会递减（dryOut）。',
  },
  marker: {
    name: '马克笔', key: 'K',
    icon: 'M8 3h5l1 9-3.5 9L7 12z M8 3h5',
    p: { size:26, hardness:.94, spacing:.04, flow:.95, opacity:.92, buildup:1,
         tip:1, roundness:.42, rotFollow:1,
         grain:.14, grainScale:5.5, pigment:0,
         jitterSize:0, jitterPos:0, spread:0,
         airbrush:0, dryOut:.12, tiltSize:0, tiltShape:.9, tiltFlow:0,
         pressSize:.28, pressFlow:1 },
    note: '方形扁笔尖，单一控制源：笔杆在死区外倾斜时，宽面方向由倾角方位决定（固定倾角 = 恒定方向，与运笔无关）；直立时回退为落笔运笔方向锁定。压感对大小只有弱影响（28%）。',
  },
  gouache: {
    name: '水粉', key: 'G',
    icon: 'M5 4h14v13a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z M9 4V2h6v2 M5 10h14',
    p: { size:44, hardness:.42, spacing:.09, flow:.85, opacity:1, buildup:0,
         tip:0, roundness:1, rotFollow:0,
         grain:.45, grainScale:12, pigment:.45,
         jitterSize:.2, jitterPos:.3, spread:.3,
         airbrush:0, dryOut:.3, tiltSize:.35, tiltShape:0, tiltFlow:.25,
         pressSize:1, pressFlow:.6 },
    note: '厚涂颜料：颗粒同时调制覆盖度和颜色，所以同一片区域会出现明暗沉积。大小/位置抖动模拟笔毛分叉。',
  },
  airbrush: {
    name: '喷枪', key: 'A',
    icon: 'M4 9h8v6H4z M12 11h3 M15 8h5v8h-5z M17 16v4',
    p: { size:64, hardness:.05, spacing:.05, flow:.13, opacity:.9, buildup:1,
         tip:0, roundness:1, rotFollow:0,
         grain:.16, grainScale:1.4, pigment:0,
         jitterSize:.1, jitterPos:.3, spread:2.8,
         airbrush:1, airRate:260, dryOut:0, tiltSize:.6, tiltShape:0, tiltFlow:0,
         pressSize:.3, pressFlow:1 },
    note: '极软笔尖 + 低流量 + 锥形散布。按住不动也会持续出墨（airRate 控制速度），这是它与其它笔的本质区别。',
  },
  eraser: {
    name: '橡皮', key: 'E',
    icon: 'M4 16l8-8 6 6-4 4H6z M14 6l3 3',
    p: { size:44, hardness:.72, spacing:.1, flow:1, opacity:1, buildup:1,
         tip:0, roundness:1, rotFollow:0, grain:0, pigment:0,
         jitterSize:0, jitterPos:0, spread:0,
         airbrush:0, dryOut:0, tiltSize:0, tiltShape:0, tiltFlow:0,
         pressSize:1, pressFlow:0 },
  },
  fill: {
    name: '油漆桶', key: 'F',
    icon: 'M7 11h9l-1 7a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2z M8 11V8h7v3 M17.5 13l1.4 1.6a2 2 0 1 1-2.8 0z',
    p: {},
  },
  smudge: {
    name: '涂抹', key: 'S',
    icon: 'M4 18c3 0 4-3 6-6s4-6 8-6 M14 6a3 3 0 1 0 0.01 0',
    /* 预设必须完整声明形状语义 —— 否则 applyBrush 会残留上一个工具的
       tip/roundness/grain（用过方头马克笔再切过来，笔刷就变成方的） */
    p: { size:46, hardness:.5, spacing:.12,
         tip:0, roundness:1, rotFollow:0,
         grain:0, grainScale:2, pigment:0,
         jitterSize:0, jitterPos:0, spread:0,
         airbrush:0, dryOut:0, tiltSize:0, tiltShape:0, tiltFlow:0,
         pressSize:.5, pressFlow:0 },
  },
  blur: {
    name: '模糊', key: 'R',
    icon: 'M12 4v4 M12 16v4 M4 12h4 M16 12h4 M7 7l3 3 M14 14l3 3 M17 7l-3 3 M10 14l-3 3',
    p: { size:46, hardness:.5, spacing:.12,
         tip:0, roundness:1, rotFollow:0,
         grain:0, grainScale:2, pigment:0,
         jitterSize:0, jitterPos:0, spread:0,
         airbrush:0, dryOut:0, tiltSize:0, tiltShape:0, tiltFlow:0,
         pressSize:.5, pressFlow:0 },
  },
  warp: {
    name: '液化', key: 'W',
    icon: 'M4 6h16 M4 12c4-4 12 4 16 0 M4 18h16',
    p: { size:52, hardness:.5, spacing:.12,
         tip:0, roundness:1, rotFollow:0,
         grain:0, grainScale:2, pigment:0,
         jitterSize:0, jitterPos:0, spread:0,
         airbrush:0, dryOut:0, tiltSize:0, tiltShape:0, tiltFlow:0,
         pressSize:.5, pressFlow:0 },
  },
  lasso: {
    name: '套索', key: 'L',
    icon: 'M4 11c0-4 4-7 8-7s8 3 8 7-4 6-8 6c-2 0-3 1-3 2s1 2 2 2',
    p: {},
  },
  transform: {
    name: '变形', key: 'T',
    icon: 'M4 4h4M4 4v4M16 4h4M20 4v4M4 16v4M4 20h4M20 16v4M20 20h-4',
    p: {},
  },
};

/* 工具 = 笔刷预设 + 渲染路径。stroke 路径写笔画缓冲，其余各自成派。 */
const TOOLS = [
  'pen', 'pencil', 'marker', 'gouache', 'airbrush', 'eraser', 'fill',
  '|',
  'smudge', 'blur', 'warp',
  '|',
  'lasso', 'transform',
].map(id => id === '|' ? { gap: true } : Object.assign({ id }, BRUSHES[id]));

const TOOL_BY_ID = {};
for (const t of TOOLS) if (!t.gap) TOOL_BY_ID[t.id] = t;

const DESTRUCTIVE = { smudge: 1, blur: 1, warp: 1 };
const isStrokeTool = id => !DESTRUCTIVE[id] && id !== 'lasso' && id !== 'transform' && id !== 'fill';   /* 走笔画缓冲的绘制类 */

let tool = 'pen';
let color = [0.16, 0.17, 0.19];

/* 应用笔刷预设：只覆盖该预设声明的字段，其余保留用户的手动调整 */
function applyBrush(id, keepSize) {
  const b = BRUSHES[id];
  if (!b) return;
  const keep = keepSize && P.size;
  for (const k in b.p) P[k] = b.p[k];
  if (keep) P.size = keep;
}

/* ============================================================
   视图
   ============================================================ */
const view = { scale: 1, x: 0, y: 0 };

function fitView() {
  const w = glc.width, h = glc.height;      /* 视图一律用设备像素，与 DISP_FS 对齐 */
  const s = Math.min(w / DW, h / DH) * 0.88;
  view.scale = s;
  view.x = (w - DW * s) / 2;
  view.y = (h - DH * s) / 2;
}
function toDoc(clientX, clientY) {
  const r = glc.getBoundingClientRect();
  const sx = (clientX - r.left) * (glc.width / r.width);
  const sy = (clientY - r.top) * (glc.height / r.height);
  return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = stage.clientWidth, h = stage.clientHeight;
  for (const c of [glc, ovc, uic]) {
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
  }
  ovc.style.width = w + 'px'; ovc.style.height = h + 'px';
  /* 界面全部 DOM 化后，uic 只承担画布区的覆盖层（光标/选区路径），与 stage 同尺寸 */
  uic.style.width = w + 'px'; uic.style.height = h + 'px';
}

/* ============================================================
   笔迹引擎
   ============================================================ */
const inputQ = [];
let drawing = false;
let activePointer = null;
const sm = { x: 0, y: 0, ok: false };
const strokeInfo = {
  carry: 0, dirty: null, bucketFrames: 0, segments: 0, dabs: 0,
  points: 0, lastInput: null, lastP: 1, lastSmoothed: null,
  lockAng: null,       // 扁笔尖的本笔锁定角（PS 语义：落笔后由第一段运笔方向定终身）
  lockRot: null,       // 本笔锁定的完整笔头旋转角（运笔方向 + 倾角方位），落笔期间不再变化
  startPt: null,       // 首点缓冲：等第一段运笔方向出现后再落 dab（避免首帧错向）
};
let lastLockAng = 0;   // 光标在未落笔时显示"上一次锁定的方向"
/* 笔级倾角快照：落笔时从悬空期已收敛的平滑值起步，落笔期间"只升不降"——
   驱动在悬空→接触的过渡期会把 tilt 短暂拉低甚至跌回死区，
   若笔头方向的锁定恰好赶上低谷，就会在"平行/垂直于倾角方向"之间二值抽奖。 */
let strokeTilt = null;
const lastCursor = { x: 0, y: 0, inside: false };
let penSeenAt = 0;      /* 最近一次收到 pen 事件的时间，用于手掌拒绝 */
let airAcc = 0;         /* 喷枪的时间累积器 */

function dirtyAdd(cx, cy, r) {
  const d = strokeInfo.dirty;
  const x0 = cx - r, y0 = cy - r, x1 = cx + r, y1 = cy + r;
  if (!d) strokeInfo.dirty = { x0, y0, x1, y1 };
  else {
    if (x0 < d.x0) d.x0 = x0;
    if (y0 < d.y0) d.y0 = y0;
    if (x1 > d.x1) d.x1 = x1;
    if (y1 > d.y1) d.y1 = y1;
  }
}

/* 倾角 → dab 形状的公共核。drawDabs（落笔）与 cursorShape（光标预览）必须
   从这一份公式走，否则"光标形状"和"实际笔迹形状"会悄悄分叉 */
function tiltWiden(size, tE) {
  return (P.tiltSize > 0) ? size * (1 + P.tiltSize * tE * 1.4) : size;
}
function tiltSquash(rx, ry, sE) {
  if (P.tiltShape > 0 && sE > 0) {
    const k = P.tiltShape * Math.min(1, sE * 1.6);
    ry *= 1 - 0.72 * k;
    rx *= 1 + 0.35 * k;
  }
  return [rx, ry];
}

function brushRadius(p) {
  /* 与 dabSizeOf 同源：涂抹/模糊/液化传线段平均压力 → 半径随压力呼吸；
     p 缺省 = 满尺寸（历史行为，光标/颜料桶采样等） */
  return Math.max(0.6, dabSizeOf(p === undefined ? 1 : p) * 0.5);
}

function stabilize(raw) {
  if (!sm.ok) { sm.x = raw.x; sm.y = raw.y; sm.ok = true; return { ...raw }; }
  const lv = P.stabilize;
  if (lv > 0.002) {
    const rope = lv * 90;
    let dx = raw.x - sm.x, dy = raw.y - sm.y;
    const d = Math.hypot(dx, dy);
    if (d > rope && d > 1e-6) {
      sm.x = raw.x - dx / d * rope;
      sm.y = raw.y - dy / d * rope;
      dx = raw.x - sm.x; dy = raw.y - sm.y;
    }
    const k = 1 - lv * 0.88;
    sm.x += (raw.x - sm.x) * k;
    sm.y += (raw.y - sm.y) * k;
  } else { sm.x = raw.x; sm.y = raw.y; }
  return { x: sm.x, y: sm.y, p: raw.p };
}

/* ---------- 确定性随机 ----------
   用可播种 PRNG 而不是 Math.random()：
   同样的输入 + 同样的种子 = 同样的像素输出，自动化验证才能断言结果。 */
let rngState = 0x9e3779b9;
function seedRng(s) { rngState = (s >>> 0) || 1; }
function rnd() {
  rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rnd11 = () => rnd() * 2 - 1;   /* -1 .. 1 */

/* 压力 → dab 大小（唯一公式源）：emitDabs 的间距与 drawDabs 的实际尺寸都从这走，
   两处永远一致 —— 轻压时 dab 变小、间距随之收紧，细线保持连续不断珠 */
function dabSizeOf(p) {
  let s = P.size;
  if (P.pressSize > 0) {
    const k = Math.min(1, P.pressSize);
    s *= (1 - k) + k * (0.14 + 0.86 * p);
  }
  return s;
}

function emitDabs(a, b, out) {
  let dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-5) return;
  const spacing = Math.max(0.85, Math.max(dabSizeOf(a.p), dabSizeOf(b.p)) * P.spacing);
  const ang = Math.atan2(dy, dx);
  let t = strokeInfo.carry;
  while (t <= L) {
    const f = t / L;
    out.push({
      x: a.x + dx * f, y: a.y + dy * f,
      p: a.p + (b.p - a.p) * f,
      tl: (a.tl || 0) + ((b.tl || 0) - (a.tl || 0)) * f,
      az: b.az,
      ang,
    });
    t += spacing;
  }
  strokeInfo.carry = t - L;
}

function drawDabs(dabs) {
  if (!dabs.length) return;
  beginPass(strokeTex);
  gl.enable(gl.BLEND);
  if (P.buildup) {
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  } else {
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
  }
  gl.useProgram(P_dab.p);
  gl.bindVertexArray(dabVAO);
  gl.uniform2f(P_dab.u.u_res, DW, DH);
  gl.uniform1f(P_dab.u.u_hardness, P.hardness);
  gl.uniform1f(P_dab.u.u_tip, P.tip);

  /* 笔画内流量衰减：按已落笔长度递减，模拟铅笔/干笔"越画越淡"。
     参考长度给足，衰减用指数而非线性 —— 线性会在中途直接触底，
     画一笔长线就只剩最开始的一小段有颜色。 */
  const dryLen = P.dryOut > 0 ? Math.max(300, P.size * 45) : 0;
  let drawn = strokeInfo.dryRun || 0;

  for (const d of dabs) {
    let size = dabSizeOf(d.p);   // 公式源同 emitDabs 的间距计算

    /* 倾斜 → 加宽（铅笔侧锋）。
       tE = dab 级死区重映射（实时，驱动 tilt 加宽/流量）；
       sE = 笔级倾角（strokeTilt 峰值，只升不降）——笔头形状/方向用它，落笔期间稳定。
       tiltOn 总开关关闭时两者归零，笔刷完全不受笔杆姿态影响。 */
    const tl = d.tl || 0;
    if (d.tl > strokeTilt.mag) { strokeTilt.mag = d.tl; strokeTilt.az = d.az; }
    const tE = P.tiltOn ? tiltEff(tl) : 0;
    const sE = P.tiltOn ? tiltEff(strokeTilt.mag) : 0;
    size = tiltWiden(size, tE);

    /* 每 dab 大小抖动 */
    if (P.jitterSize > 0) size *= 1 + rnd11() * P.jitterSize;

    let flow = P.flow;
    if (P.pressFlow > 0) {
      const k = Math.min(1, P.pressFlow);
      flow *= (1 - k) + k * (0.28 + 0.72 * d.p);
    }
    if (dryLen > 0) flow *= Math.exp(-P.dryOut * (drawn / dryLen));

    /* 倾斜 → 流量衰减：让侧锋不只是变宽，墨色也随压强变淡（真实笔的物理） */
    if (P.tiltFlow > 0) flow *= 1 - Math.min(1, P.tiltFlow * tE);

    const rr = Math.max(0.5, size * 0.5);
    let cx = d.x, cy = d.y;

    /* 抖动幅度必须跟着"当前这一印的实际尺寸"走，而不是设定尺寸。
       用设定尺寸的话，压力轻的小印章会被推出自身直径之外，
       整条笔画直接散成一串珠子，而不是一条线。 */
    const jb = size * 0.35;

    /* 位置抖动 */
    if (P.jitterPos > 0) {
      const j = P.jitterPos * jb;
      cx += rnd11() * j; cy += rnd11() * j;
    }
    /* 沿笔画法线的散布（喷枪锥角 / 笔毛分叉） */
    if (P.spread > 0) {
      const nx = -Math.sin(d.ang || 0), ny = Math.cos(d.ang || 0);
      const s = rnd11() * P.spread * jb;
      cx += nx * s; cy += ny * s;
    }

    /* 笔尖形状：压扁 + 旋转 */
    let [rx, ry] = tiltSquash(rr, rr * P.roundness, sE);
    /* 笔头角度 = **单一控制源**（对齐 PS/CSP 的 Dynamics 模型——两个源相加会让
       方向同时被运笔和倾角拉扯：固定倾角下拖动方向一变，就在"平行/垂直于倾角"
       之间二值切换，用户感知为"落笔抽奖"）：
       1) 倾角主控：tiltShape 开启且笔级有效倾角在死区外 → 方向 = 倾角方位 + 90°
          （笔杆倒向哪边，扁面长轴就垂直于倒向 —— 固定倾角 = 恒定方向，与运笔无关）
       2) 回退：直立/未开倾角 → 运笔方向锁定（PS 的 Initial Direction 语义） */
    let rot;
    if (strokeInfo.lockRot !== null) {
      rot = strokeInfo.lockRot;
    } else {
      if (P.tiltShape > 0 && sE > 0) {
        rot = (strokeTilt.az || 0) + P.angleOffset * Math.PI / 180;
        strokeInfo.lockRot = rot;                     // 倾角主控：首 dab 即锁定
      } else {
        rot = 0;
        if (P.rotFollow > 0) {
          if (strokeInfo.lockAng === null && d.ang !== undefined) {
            strokeInfo.lockAng = d.ang;
            lastLockAng = d.ang;
          }
          if (strokeInfo.lockAng !== null) rot = (strokeInfo.lockAng + P.angleOffset * Math.PI / 180) * P.rotFollow;
        }
        if (d.ang !== undefined) strokeInfo.lockRot = rot;   // 运笔主控：等方向出现
      }
    }

    gl.uniform2f(P_dab.u.u_center, cx, cy);
    gl.uniform2f(P_dab.u.u_half, rx, ry);
    gl.uniform1f(P_dab.u.u_rot, rot);
    gl.uniform1f(P_dab.u.u_flow, Math.min(1, flow));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    dirtyAdd(cx, cy, Math.max(rx, ry) + 2);
    drawn += P.size * P.spacing;
  }
  strokeInfo.dryRun = drawn;
  gl.bindVertexArray(null);
  gl.disable(gl.BLEND);
}

/* ---------- 破坏性工具：逐段 ping-pong ---------- */
function segBBox(p0, p1, r) {
  const x0 = Math.min(p0.x, p1.x) - r, y0 = Math.min(p0.y, p1.y) - r;
  const x1 = Math.max(p0.x, p1.x) + r, y1 = Math.max(p0.y, p1.y) + r;
  return [x0, y0, x1 - x0, y1 - y0];
}

function updateBucket() {
  const r = brushRadius(PEN.lastShapeP) * 0.75;   // 取样半径也随当前压力
  const c = strokeInfo.lastSmoothed || { x: sm.x, y: sm.y };
  const first = strokeInfo.bucketFrames < 2;
  beginPass(bucketAlt);
  gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
  gl.viewport(0, 0, 1, 1);
  gl.useProgram(P_bucket.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, paintCur);
  gl.uniform1i(P_bucket.u.u_paint, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bucketCur);
  gl.uniform1i(P_bucket.u.u_prev, 1);
  gl.uniform2f(P_bucket.u.u_center, c.x, c.y);
  gl.uniform1f(P_bucket.u.u_sampleRadius, Math.max(r, 1));
  gl.uniform1f(P_bucket.u.u_blend, first ? 1.0 : 0.14);
  gl.uniform2f(P_bucket.u.u_res, DW, DH);
  fsQuad();
  swapBucket();
  strokeInfo.bucketFrames++;
}

function runSmudge(p0, p1) {
  /* 压力响应：轻抹几乎不拖色，重抹全力（对照 PS/Krita 的涂抹直觉）。
     pk = 线段平均压力；半径与强度都随它呼吸 */
  const pk = ((p0.p || 0) + (p1.p || 0)) / 2;
  const r = brushRadius(pk);
  const bb = segBBox(p0, p1, r + r * P.smudgeDrag + 4);
  if (!beginPass(fxTmp, bb[0], bb[1], bb[2], bb[3])) return;
  gl.disable(gl.BLEND);
  gl.useProgram(P_smudge.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, paintCur);
  gl.uniform1i(P_smudge.u.u_src, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.uniform1i(P_smudge.u.u_mask, 1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, bucketCur);
  gl.uniform1i(P_smudge.u.u_bucket, 2);
  gl.uniform2f(P_smudge.u.u_p0, p0.x, p0.y);
  gl.uniform2f(P_smudge.u.u_p1, p1.x, p1.y);
  gl.uniform1f(P_smudge.u.u_radius, r);
  gl.uniform1f(P_smudge.u.u_hardness, P.hardness);
  gl.uniform1f(P_smudge.u.u_strength, P.smudgeStrength * (0.18 + 0.82 * pk));
  gl.uniform1f(P_smudge.u.u_drag, P.smudgeDrag);
  gl.uniform1f(P_smudge.u.u_colorRate, P.smudgeColor);
  gl.uniform4f(P_smudge.u.u_bbox, curBbox[0], curBbox[1], curBbox[2], curBbox[3]);
  gl.uniform2f(P_smudge.u.u_res, DW, DH);
  fsQuad();
  copyBBox(fxTmp, paintCur);
  dirtyAdd((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2 + r + r * P.smudgeDrag + 4);
}

function runBlur(p0, p1) {
  const pk = ((p0.p || 0) + (p1.p || 0)) / 2;   // 轻抚轻糊，重按重糊
  const r = brushRadius(pk);
  const br = P.blurRadius;
  const bb = segBBox(p0, p1, r + br + 4);
  if (!beginPass(blurTmp, bb[0], bb[1], bb[2], bb[3])) return;
  gl.disable(gl.BLEND);
  gl.useProgram(P_blur.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, paintCur);
  gl.uniform1i(P_blur.u.u_tex, 0);
  gl.uniform2f(P_blur.u.u_dir, 1, 0);
  gl.uniform1f(P_blur.u.u_radius, br);
  gl.uniform4f(P_blur.u.u_bbox, curBbox[0], curBbox[1], curBbox[2], curBbox[3]);
  gl.uniform2f(P_blur.u.u_res, DW, DH);
  fsQuad();

  if (!beginPass(fxTmp, bb[0], bb[1], bb[2], bb[3])) return;
  gl.useProgram(P_blurmix.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, blurTmp);
  gl.uniform1i(P_blurmix.u.u_blur, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, paintCur);
  gl.uniform1i(P_blurmix.u.u_orig, 1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.uniform1i(P_blurmix.u.u_mask, 2);
  gl.uniform2f(P_blurmix.u.u_p0, p0.x, p0.y);
  gl.uniform2f(P_blurmix.u.u_p1, p1.x, p1.y);
  gl.uniform1f(P_blurmix.u.u_radius, r);
  gl.uniform1f(P_blurmix.u.u_hardness, P.hardness);
  gl.uniform1f(P_blurmix.u.u_strength, P.blurStrength * (0.18 + 0.82 * pk));
  gl.uniform1f(P_blurmix.u.u_blurRadius, br);
  gl.uniform4f(P_blurmix.u.u_bbox, curBbox[0], curBbox[1], curBbox[2], curBbox[3]);
  gl.uniform2f(P_blurmix.u.u_res, DW, DH);
  fsQuad();
  copyBBox(fxTmp, paintCur);
  dirtyAdd((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2 + r + br + 4);
}

function runWarp(p0, p1) {
  const pk = ((p0.p || 0) + (p1.p || 0)) / 2;   // 轻推微变，重推大变
  const r = brushRadius(pk);
  const bb = segBBox(p0, p1, r * 2.4 + 4);
  if (!beginPass(fxTmp, bb[0], bb[1], bb[2], bb[3])) return;
  gl.disable(gl.BLEND);
  gl.useProgram(P_warp.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, paintCur);
  gl.uniform1i(P_warp.u.u_src, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.uniform1i(P_warp.u.u_mask, 1);
  gl.uniform2f(P_warp.u.u_p0, p0.x, p0.y);
  gl.uniform2f(P_warp.u.u_p1, p1.x, p1.y);
  gl.uniform1f(P_warp.u.u_radius, r);
  gl.uniform1f(P_warp.u.u_hardness, P.hardness);
  gl.uniform1i(P_warp.u.u_mode, P.warpMode);
  gl.uniform1f(P_warp.u.u_strength, P.warpStrength * (0.18 + 0.82 * pk));
  gl.uniform4f(P_warp.u.u_bbox, curBbox[0], curBbox[1], curBbox[2], curBbox[3]);
  gl.uniform2f(P_warp.u.u_res, DW, DH);
  fsQuad();
  copyBBox(fxTmp, paintCur);
  dirtyAdd((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2 + r * 2.4 + 4);
}

/* ---------- 笔画收尾：把笔画缓冲烧进图层 ---------- */
function bakeStroke() {
  if (!isStrokeTool(tool)) return;
  beginPass(paintAlt);
  gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
  gl.viewport(0, 0, DW, DH);
  gl.useProgram(P_comp.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, paintCur);
  gl.uniform1i(P_comp.u.u_layer, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, strokeTex);
  gl.uniform1i(P_comp.u.u_stroke, 1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.uniform1i(P_comp.u.u_mask, 2);
  gl.uniform4f(P_comp.u.u_color, color[0], color[1], color[2], 1);
  gl.uniform1f(P_comp.u.u_opacity, P.opacity);
  gl.uniform1f(P_comp.u.u_erase, erasing() ? 1 : 0);
  gl.uniform1f(P_comp.u.u_grain, P.grain);
  gl.uniform1f(P_comp.u.u_grainScale, P.grainScale);
  gl.uniform1f(P_comp.u.u_pigment, P.pigment);
  fsQuad();
  swapPaint();
  clearTex(strokeTex);
}

/* ============================================================
   输入
   ============================================================ */
/* 只保留"进行中"的那条路径；已确定的选区一律以掩膜为准（轮廓从掩膜提取） */
let lassoCur = null;
let lassoMode = 'replace';
let antsPhase = 0;

/* ============================================================
   笔输入管线 —— 数位板兼容层

   这一层要处理的，是浏览器给我们的原始数据与"笔真正感受到的"之间的差距：

   1. 压力报 0     有些驱动在落笔首帧、或悬停帧上报 pressure=0。
                   直接当 0 用，起笔就会断成一根细线；当成 0.5 又会突兀地变粗。
   2. 压力够不到 1 中低端板子上端阈值虚高，压到底也只有 0.6。
                   不补偿的话，笔刷永远画不到设定的最大尺寸。
   3. 没有压感     鼠标、部分平板、部分驱动根本不报压力，线宽恒定像塑料管。
   4. 合成事件     getCoalescedEvents() 在合成事件上返回空数组。
   5. 手势冲突     touch-action 不做处理时，浏览器会把运笔当成滚动手势并甩出 pointercancel。
   6. 手掌 / 多指  画到一半被第二根手指打断。
   7. 丢尾点       pointerup 本身也携带合并采样点，不看就会在收笔处丢一段。
   ============================================================ */

const PEN = {
  mode: 0,            // 0 自动 / 1 强制压力 / 2 速度驱动
  pMin: 0.03,         // 压力死区：低于此值视为未施力
  pMax: 0.90,         // 压力饱和点：到此即视为满压
  curve: 0.9,         // 压力曲线指数（<1 更早变粗，>1 更晚）
  speedRef: 2.4,      // 速度 → 压力 的参考速度（px/ms）
  smooth: 0.35,       // 压力平滑（0 = 不平滑）
  /* --- 运行时观测 --- */
  lastType: '—',
  sawTilt: false,
  pressureSeen: null, // null 未判定 / true 有压感 / false 无压感（自动降级速度）
  maxDev: 0,
  minRaw: 1,         // 整笔见过的最小/最大原始压力（区分真压感与恒 0.5 伪设备）
  maxRaw: 0,
  baseRaw: 0,
  smoothP: undefined,
  lastShapeP: 0.55,
  tilt: 0,
  az: 0,
  attackLeft: 0,     // 起笔斜坡剩余采样点数
  attackFrom: 0.15,  // 斜坡起点压力
  tiltSmooth: 0.5,   // 倾角向量平滑（0 = 不平滑；悬空读数噪声大，0.5 起步才稳）
  sTiltX: undefined, // 平滑后的 tilt 向量（直接平均 tiltX/tiltY，天然处理角度环绕）
  sTiltY: undefined,
  lastTiltX: 0,      // 上一帧原始 tilt（缺失帧沿用）
  lastTiltY: 0,
};

const clamp01 = v => v < 0 ? 0 : (v > 1 ? 1 : v);

/* 倾角死区重映射（Drawpile/Lazy Nezumi 同款三板斧之"死区"）：
   <9° 一律视为直立（悬空读数的噪声在这个区间完全不可见），
   ≥9° 线性铺满到 1。所有"倾斜 → 形状/流量"的映射都吃这个有效值。 */
const TILT_DEAD = 0.12;
function tiltEff(tl) { return Math.max(0, (tl - TILT_DEAD) / (1 - TILT_DEAD)); }

/* 倾斜：tiltX/tiltY 是相对屏幕的两轴角度（度），合成出方位角与倾角幅度。

   这里有两个实测坑（用户反馈：固定倾角落笔，锁定方向"抽奖"般随机）：
   1) coalesced 合并采样点经常不带 tilt（只有主事件带）——逐点直读会让读数
      在"真值 ↔ 0"之间抖动。缺失帧沿用上一帧（与压力缺失帧同一招）。
   2) atan2 对接近直立的笔（tx,ty ≈ 0）输出的是噪声方位角，一旦被锁进笔头
      方向就是一次"抽奖"。所以对 tiltX/tiltY 做**向量**指数平滑（直接平均
      两轴分量，天然处理 ±π 角度环绕），并给"参与笔头定向"设有效倾角阈值。
   悬空与落笔走同一条平滑路径：落笔瞬间拿到的已经是悬空期收敛好的稳定值。 */
function updateTilt(e) {
  const tx = e.tiltX || 0, ty = e.tiltY || 0;
  const has = Math.abs(tx) > 0.5 || Math.abs(ty) > 0.5;
  if (has) PEN.sawTilt = true;
  const ux = has ? tx : PEN.lastTiltX, uy = has ? ty : PEN.lastTiltY;
  PEN.lastTiltX = ux; PEN.lastTiltY = uy;
  if (PEN.sTiltX === undefined) { PEN.sTiltX = ux; PEN.sTiltY = uy; }
  const k = 1 - Math.max(0, Math.min(0.9, PEN.tiltSmooth));
  PEN.sTiltX += (ux - PEN.sTiltX) * k;
  PEN.sTiltY += (uy - PEN.sTiltY) * k;
  PEN.tilt = Math.min(1, Math.hypot(PEN.sTiltX, PEN.sTiltY) / 76);
  PEN.az = Math.atan2(PEN.sTiltY, PEN.sTiltX);
}

/* 把原始压力整形成可用范围：死区 → 归一化 → 曲线 */
function shapePressure(raw, type) {
  if (type === 'mouse') return 1;
  /* raw = 0 是数位笔合法的"极轻接触"，不是数据缺失。
     旧逻辑把它当缺失帧沿用 lastShapeP —— 轻笔会粘滞在起笔斜坡/上一笔
     的压力上（整笔异常粗大），且死区边缘 raw 跳变时大小 dab 交替（珠子状）。
     压感毛刺由平滑链负责抹平，这里只做忠实的死区映射。 */
  const lo = PEN.pMin, hi = Math.max(PEN.pMax, lo + 0.05);
  const x = clamp01((raw - lo) / (hi - lo));
  return Math.pow(x, Math.max(0.15, PEN.curve));
}

/* 速度反比：画得越快越细。给不报压力的设备（鼠标/部分驱动）用 */
function speedPressure(dist, dt) {
  if (dist < 0.05) return PEN.lastShapeP;         // 停笔时保持不变，否则原地震动会忽粗忽细
  const v = dist / Math.max(dt, 1);
  const k = Math.min(1, v / Math.max(0.25, PEN.speedRef));
  return clamp01(0.24 + 0.76 * (1 - k));
}

function ptFromEvent(e) {
  const d = toDoc(e.clientX, e.clientY);
  const type = e.pointerType || 'mouse';
  const raw = typeof e.pressure === 'number' ? e.pressure : 0;

  /* 采样间隔：coalesced 事件带真实 timeStamp，用不上时退回当前时间 */
  const now = (typeof e.timeStamp === 'number' && e.timeStamp > 0) ? e.timeStamp : performance.now();
  const prev = strokeInfo.lastInput;
  let dist = 0, dt = 16;
  if (prev) { dist = Math.hypot(d.x - prev.x, d.y - prev.y); dt = Math.max(1, now - prev.lastT); }

  /* 自动模式下先判有没有压感；判不出来就临时用压力（前几笔），
     判出来"没有"才永久切到速度驱动 */
  const usePressure = (PEN.mode === 1)
    || (PEN.mode === 0 && type !== 'mouse' && PEN.pressureSeen !== false);

  let p;
  const speedMode = (PEN.mode === 2 || !usePressure);
  if (speedMode) p = speedPressure(dist, dt);
  else p = shapePressure(raw, type);

  /* 斜坡 cap 先算：它必须同时约束"输出值"和"平滑状态本身"。
     只压输出的话，高压力（驱动过渡值/重按）会在斜坡掩护下继续往
     平滑链里积累，4 帧后解除瞬间爆发，整笔前半段异常粗 */
  let cap = Infinity;
  if (PEN.attackLeft > 0) {
    const t = 1 - PEN.attackLeft / 4;
    cap = PEN.attackFrom + (1 - PEN.attackFrom) * t * t;
    PEN.attackLeft--;
  }

  /* 平滑：抑制抖动，但不要太狠（会让收笔变粗） */
  if (!speedMode) {
    if (PEN.smoothP === undefined) PEN.smoothP = p;
    else PEN.smoothP += (p - PEN.smoothP) * (1 - PEN.smooth);
    if (PEN.smoothP > cap) PEN.smoothP = cap;   // 平滑链同步限幅：暗处不再积累
    p = PEN.smoothP;
  }
  if (p > cap) p = cap;
  PEN.lastShapeP = p;

  /* 压感存在性统计：整笔的压力变化幅度 + 读数包络 */
  if (type !== 'mouse') {
    if (!prev) PEN.baseRaw = raw;
    PEN.maxDev = Math.max(PEN.maxDev, Math.abs(raw - PEN.baseRaw));
    if (raw < PEN.minRaw) PEN.minRaw = raw;
    if (raw > PEN.maxRaw) PEN.maxRaw = raw;
  }
  PEN.lastType = type;
  if (type === 'pen') penSeenAt = performance.now();

  updateTilt(e);

  const pt = { x: d.x, y: d.y, p, tl: PEN.tilt, az: PEN.az, lastT: now };
  strokeInfo.lastInput = pt;
  strokeInfo.lastP = p;
  return pt;
}

/* 把一次 pointermove 携带的全部合并采样点推进队列 */
function pushPointerSamples(e) {
  let list = [];
  if (typeof e.getCoalescedEvents === 'function') {
    const ce = e.getCoalescedEvents();
    if (ce && ce.length > 0) list = ce;          /* 合成事件这里会返回空数组，必须兜底 */
  }
  if (!list.length) list = [e];
  for (const c of list) inputQ.push(ptFromEvent(c));

  /* 超限时均匀抽稀，而不是砍掉队头 —— 砍头会让笔画直接断成两截 */
  if (inputQ.length > 512) {
    const kept = [];
    for (let i = 0; i < inputQ.length; i += 2) kept.push(inputQ[i]);
    kept.push(inputQ[inputQ.length - 1]);
    inputQ.length = 0;
    for (const k of kept) inputQ.push(k);
  }
}

/* 笔尾橡皮 / 临时工具覆盖 */
let penRubberStroke = false;
function erasing() { return tool === 'eraser' || penRubberStroke; }

/* 起笔压力门槛（对照 PS 的行为）：极轻悬停不落笔。
   raw 低于死区 = 还没真正按压 —— 不开始笔画，等压力越过门槛才起笔。
   这同时消灭"整笔超低压力"的笔画，压感判定不再被极轻悬停污染。 */
let penPending = false;
let penPendingRubber = false;
let penPendingMoved = 0;               // pending 期间累计位移（恒 0 设备自愈用）
let penPendingXY = { x: 0, y: 0 };

uic.addEventListener('pointerdown', (e) => {
  if (uiPointerDown(e)) return;   /* 点在自绘 UI 上：处理 UI，不进画布 */
  { const pb = window.__fabulaPlayback;
    if (pb && pb.active && pb.active()) return; }   /* 播放/暂停态：画布不吃笔 */

  const now = performance.now();
  const type = e.pointerType || 'mouse';
  const isPen = type === 'pen';
  if (isPen) penSeenAt = now;

  /* --- 手掌 / 多指防线 --- */
  if (type === 'touch') {
    if (now - penSeenAt < 1200) return;                              /* 笔在附近活动 = 手掌搁上来了 */
    if (Math.max(e.width || 0, e.height || 0) > 40) return;          /* 接触面积过大 = 手掌 */
    if (activePointer !== null) return;                              /* 已经在画了 = 第二根手指 */
  }
  if (activePointer !== null && e.pointerId !== activePointer) return;

  /* --- 按键映射 --- */
  const rubber = isPen && (e.button === 5 || (e.buttons & 32) !== 0); /* 笔尾橡皮 */
  if (e.button === 1 || spaceDown || (isPen && e.button === 2)) { startPan(e); return; }

  const isDown = (e.button === 0) || rubber;
  if (!isDown) return;
  /* 笔悬停/未落笔时不该出墨 */
  if (isPen && e.buttons === 0) return;

  try { uic.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件没有有效 pointerId */ }
  activePointer = e.pointerId;

  const d = toDoc(e.clientX, e.clientY);

  if (xf.on) { xfDown(e, d); return; }

  if (tool === 'fill') { doFloodFill(d.x, d.y); return; }   /* 油漆桶：一次点击完成，无拖拽 */

  if (tool === 'lasso') {
    lassoMode = e.shiftKey ? 'add' : (e.altKey ? 'sub' : 'replace');
    lassoCur = { pts: [d], mode: lassoMode };
    return;
  }

  /* 起笔压力门槛：pen 输入压力低于死区 = 笔还没真正压下，不落笔（PS 同款行为）。
     fill / lasso 是即时操作不走门槛；鼠标/触屏没有压力语义也不走；
     已判定无压感（速度驱动）的设备不吃门槛 —— 恒 0/0.5 读数也能正常画。 */
    if (isPen && PEN.mode !== 2 && PEN.pressureSeen !== false) {
      const raw0 = typeof e.pressure === 'number' ? e.pressure : 0;
      if (raw0 < PEN.pMin) {
        penPending = true;
        penPendingRubber = rubber;
        penPendingMoved = 0;
        penPendingXY = { x: d.x, y: d.y };
        return;   // activePointer 已捕获：后续 move 在 pending 里等待压力到位
      }
    }
    penPending = false;
    beginStroke(e, rubber);
  });

  /* 真正起笔：初始化笔画状态（pointerdown 与 pending 转正共用）。
     pushStart=false 给转正路径：那里紧接着的 pushPointerSamples 会供点，
     这里再 push 同一个事件就会把"最新点"当起点、随后又画回旧点（首段倒插，
     rotFollow 笔头方向整笔反转 180°）。 */
  function beginStroke(e, rubber, pushStart = true) {
    if (!isStrokeTool(tool) && !DESTRUCTIVE[tool]) { penPending = false; return; }
  penRubberStroke = rubber;
  drawing = true;
  sm.ok = false;
  strokeInfo.carry = 0;
  strokeInfo.dirty = null;
  strokeInfo.bucketFrames = 0;
  strokeInfo.lastSmoothed = null;
  strokeInfo.lastInput = null;
  strokeInfo.dryRun = 0;
  strokeInfo.points = 0;
  strokeInfo.lockAng = null;
  strokeInfo.lockRot = null;
  strokeInfo.startPt = null;
  strokeTilt = { mag: PEN.tilt, az: PEN.az };   // 笔级倾角：悬空稳定值起步，只升不降
  PEN.smoothP = undefined;
  /* 起笔斜坡：压制两类"首笔粗疙瘩"——
     1) 驱动来不及给真实压力时，落笔首帧按 Pointer Events 规范报默认值 0.5，
        而首点恰好不做平滑、直接采用（下一帧才给真实值，压力骤降）；
     2) 上一笔收笔的重压经 lastShapeP 残留到新笔首帧。
     解法是最初 4 个采样点给压力设一个从低处放开的临时上限：
     轻落笔不受影响（min 取原值），重按起笔只多两三个 dab 的锥形期。 */
  PEN.attackLeft = 4;
  /* 起点固定低位，不再从上一笔末值推算 —— 上一笔重压收笔时，
     0.6 倍残留会让新笔第一帧就明显偏粗（轻落笔尤其明显）。
     重按落笔只多两三个 dab 的锥形期（33ms @120Hz），与真实笔一致。 */
  PEN.attackFrom = 0.15;
  PEN.maxDev = 0;
  PEN.minRaw = 1;
  PEN.maxRaw = 0;
  PEN.baseRaw = typeof e.pressure === 'number' ? e.pressure : 0;
  airAcc = 0;
  clearTex(strokeTex);

  if (DESTRUCTIVE[tool]) {
    /* 破坏性工具：落笔先整层快照到复用缓冲，收笔时再裁到脏矩形 */
    beginPass(preScratch);
    gl.disable(gl.BLEND);
    gl.useProgram(P_blit.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, paintCur);
    gl.uniform1i(P_blit.u.u_tex, 0);
    gl.uniform4f(P_blit.u.u_src, 0, 0, 1, 1);
    fsQuad();
    clearSmall(bucketCur); clearSmall(bucketAlt);
    strokeInfo.bucketFrames = 0;
  } else {
    if (pushStart) { inputQ.push(ptFromEvent(e)); strokeInfo.points++; }
  }
}

uic.addEventListener('pointermove', (e) => {
  if (uiDragSlider) { panelDragMove(e.clientX); return; }
  { const ws = window.__fabulaWorkspace;
    if (ws && ws.onPointerMove && ws.onPointerMove(e.clientX, e.clientY)) return; }
  const d = toDoc(e.clientX, e.clientY);
  lastCursor.x = d.x; lastCursor.y = d.y; lastCursor.inside = true;

  if (e.pointerType === 'pen') {
    penSeenAt = performance.now();
    /* 悬空也更新倾角：光标的变形/转向要实时（不落笔就能看到倾角效果）。
       只更新读数，不产生任何笔画。 */
    updateTilt(e);
  }
  if (panActive) { doPan(e); return; }
  if (activePointer !== null && e.pointerId !== activePointer) return;

  if (xf.on) { xfMove(e, d); return; }

  if (tool === 'lasso' && lassoCur) {
    const last = lassoCur.pts[lassoCur.pts.length - 1];
    if (!last || Math.hypot(d.x - last.x, d.y - last.y) > 1.4 / view.scale) lassoCur.pts.push(d);
    return;
  }
  if (penPending) {
    /* 起笔门槛等待中：压力越过死区才真正落笔，起点 = 越过门槛的位置（PS 同款）。
       极轻悬停拖动因此全程不产生笔画、不留痕。 */
    const rawP = e.pointerType === 'pen' && typeof e.pressure === 'number' ? e.pressure : 0;
    if (!(rawP >= PEN.pMin)) {
      if (rawP > 0) return;   // 有读数但还没过门槛：继续等
      /* 自愈：恒 0 压力的设备（部分驱动/数位屏）永远过不了门槛 ——
         拖出 12px 仍没有任何非零读数，就判为无压感、降级速度驱动并立即落笔，
         否则这支笔一支笔画都画不出来 */
      penPendingMoved += Math.hypot(d.x - penPendingXY.x, d.y - penPendingXY.y);
      penPendingXY.x = d.x; penPendingXY.y = d.y;
      if (penPendingMoved < 12) return;
      PEN.pressureSeen = false;
    }
    penPending = false;
    beginStroke(e, penPendingRubber, false);   // 随后继续走正常 move 采样
  }
  if (!drawing) return;

  pushPointerSamples(e);
  strokeInfo.points += 1;
});

function endStroke(e) {
  if (xf.on) { xf.drag = null; return; }   /* 变形会话：抬笔只结束拖拽，不动图层 */
  if (tool === 'lasso') { commitLasso(); return; }
  if (!drawing) return;
  consumeInput();          /* 把队列里剩下的点全部落实，否则收笔会截断 */
  /* 纯点画（落笔即抬、没有移动）补一颗 dab——必须在撤销快照之前，dirty 才覆盖它 */
  if (strokeInfo.startPt) {
    drawDabs([Object.assign({}, strokeInfo.startPt)]);
    strokeInfo.startPt = null;
  }
  drawing = false;
  inputQ.length = 0;

  /* 压感存在性判定：只在笔画足够长时更新，避免一两笔草稿把判断带偏。
     证据 = 读数偏离过规范默认值 0.5（无压感硬件的 pen 事件恒报 0.5）：
     - 变化幅度大（正常压感笔画）
     - 或出现过明显偏低的读数（极轻笔全程 0.02~0.08 —— 变化幅度小，
       旧判定 maxDev>0.10 会把它误杀成"无压感"→整笔降级速度驱动→慢速=粗）
     - 或出现过明显偏高的读数
     恒 0.5（真·无压感设备）三个条件全不命中 → 正确降级 */
  if (PEN.lastType !== 'mouse' && strokeInfo.points > 12) {
    PEN.pressureSeen = PEN.maxDev > 0.10
      || (PEN.minRaw < 0.40 && PEN.maxRaw > 0)   // 出现过任何非零读数即压感证据（极轻笔可能全程 < 0.02）
      || PEN.maxRaw > 0.60;
  }

  const d = strokeInfo.dirty;
  const w = d ? d.x1 - d.x0 : 0, h = d ? d.y1 - d.y0 : 0;

  if (DESTRUCTIVE[tool]) {
    /* 图层已被就地改写，落笔前的状态留在 preScratch 里 */
    if (d) pushUndo(snapRegion(preScratch, d.x0, d.y0, w, h));
  } else {
    /* 必须先快照（此刻笔画还没烧进图层），再烧入。顺序反了撤销就会记住画完的样子 */
    if (d) pushUndo(snapRegion(paintCur, d.x0, d.y0, w, h));
    bakeStroke();            /* 注意：penRubberStroke 必须等烧入之后才能清 */
  }
  penRubberStroke = false;
  strokeInfo.dirty = null;
  strokeInfo.lastInput = null;
  updatePenStat();
}

uic.addEventListener('pointerup', (e) => {
  if (uiDragSlider) { uiDragSlider = null; return; }
  { const ws = window.__fabulaWorkspace;
    if (ws && ws.onPointerUp) ws.onPointerUp(e.clientX, e.clientY); }
  if (panActive) { endPan(); return; }
  if (activePointer !== null && e.pointerId !== activePointer) return;
  penPending = false;   /* 极轻悬停就抬笔 = 无痕，与 PS 一致 */
  /* pointerup 自身也可能带着合并采样点 —— 不看就会在收笔处丢最后一段 */
  if (drawing && (tool !== 'lasso')) pushPointerSamples(e);
  activePointer = null;
  endStroke(e);
  inputQ.length = 0;
});
uic.addEventListener('pointercancel', (e) => {
  if (panActive) { endPan(); return; }
  activePointer = null;
  penPending = false;
  lassoCur = null;
  if (xf.on) xf.drag = null;
  /* 走正常收尾流程：以前这里只 bakeStroke() 不推撤销快照，
     被浏览器取消一次（滚动、手势、切窗口）撤销栈就会错位 */
  if (drawing) endStroke(e);
  inputQ.length = 0;
});
uic.addEventListener('lostpointercapture', (e) => {
  if (activePointer !== null && e.pointerId === activePointer) {
    activePointer = null;
    penPending = false;   /* pending 悬置时丢了捕获：不能让后续 move 裸奔起笔 */
    if (drawing) endStroke(e);
    else if (xf.on) xf.drag = null;   /* 变形拖拽丢了捕获：松手，别让拖拽粘住 */
    else commitLasso();          /* 套索中途丢了捕获，不能让路径悬在半空 */
  }
});
uic.addEventListener('pointerleave', () => { lastCursor.inside = false; });
uic.addEventListener('contextmenu', (e) => e.preventDefault());
uic.addEventListener('dblclick', () => { if (xf.on) xfCommit(); });

/* ---------- 套索光栅化 ----------
   掩膜是一张**不透明灰度图**：白 = 选中，黑 = 未选中。
   减选因此写成"用黑色 source-over 盖上去"，而不是 destination-out。
   destination-out 会把像素涂成 (255,255,255,0) —— 半透明的抗锯齿边上
   RGB 仍是 255，而着色器读的正是 .r，于是减选的边界完全没有过渡，硬得像刀切。 */
function rasterizeLasso(lp) {
  mctx.save();
  mctx.globalCompositeOperation = 'source-over';
  const col = (lp.mode === 'sub') ? '#000' : '#fff';
  if (lp.mode === 'replace') {
    mctx.fillStyle = '#000';
    mctx.fillRect(0, 0, DW, DH);
  }
  mctx.fillStyle = col;
  mctx.beginPath();
  mctx.moveTo(lp.pts[0].x, lp.pts[0].y);
  for (let i = 1; i < lp.pts.length; i++) mctx.lineTo(lp.pts[i].x, lp.pts[i].y);
  mctx.closePath();
  mctx.fill();
  mctx.restore();
  maskChanged();
}

/* 收尾：把进行中的路径落实成选区。中途切工具 / 失去指针捕获时也要走这里，
   否则 lassoCur 会一直挂着 —— 屏幕上留着一条永远消不掉的线，
   连"清除选区"都清不掉。 */
function commitLasso() {
  if (!lassoCur) return;
  const lp = lassoCur;
  lassoCur = null;
  if (lp.pts.length > 2) rasterizeLasso(lp);
}
function cancelLasso() { lassoCur = null; }

function deselectAll() {
  lassoCur = null;
  maskReset();
}

/* ============================================================
   变形（自由变换）：移动 / 等比缩放 / 旋转 / 翻转
   ============================================================
   模态工具：切到本工具即开始一次会话，对象是「选区内容」（无选区 = 整幅）。
   预览期间图层一个字节都不动 —— 显示着色器用逆矩阵从内容纹理采样，
   提交时才一次 over 合成写回图层（脏矩形 = 源框 ∪ 变换后四角）。

   交互沿用 PS 的手柄习惯：
     框内拖动 = 移动     角点手柄 = 等比缩放（绕视觉中心）
     贴近框边外侧拖 = 旋转（绕视觉中心）
     H / V = 水平 / 垂直翻转     方向键 = 1px 微调（Shift = 10px）
     Enter / 双击 / 点框外 / 切工具 = 提交      Esc = 取消 */
const xf = {
  on: false, drag: null, hover: 'out',
  box: null,                 // 源 bbox {x0,y0,x1,y1}，文档坐标 y 向下
  cx: 0, cy: 0,              // 变换锚点 = 源框中心
  ang: 0, sx: 1, sy: 1, tx: 0, ty: 0,
};
let xfSrcTex = null, xfBackTex = null;
const XF_CURSORS = { move: 'move', scale: 'nwse-resize', rotate: 'grab', out: 'default' };

/* 正向映射：p → R(ang)·S·(p−C) + C + T（Y 向下，ang 为顺时针） */
function xfFwd(p) {
  const c = Math.cos(xf.ang), s = Math.sin(xf.ang);
  const dx = p.x - xf.cx, dy = p.y - xf.cy;
  return {
    x: c * xf.sx * dx - s * xf.sy * dy + xf.cx + xf.tx,
    y: s * xf.sx * dx + c * xf.sy * dy + xf.cy + xf.ty,
  };
}
function xfCorners() {
  const b = xf.box;
  return [xfFwd({ x: b.x0, y: b.y0 }), xfFwd({ x: b.x1, y: b.y0 }),
          xfFwd({ x: b.x1, y: b.y1 }), xfFwd({ x: b.x0, y: b.y1 })];
}
/* 逆映射：src = L·doc + off。L 为 GLSL mat2 列主序。
   inv(R·S) = S⁻¹·Rᵀ；off = C − L·(C+T)，验证：src(C+T) = C ✓ */
function xfInv() {
  const c = Math.cos(xf.ang), s = Math.sin(xf.ang);
  const gsx = Math.abs(xf.sx) < 0.02 ? (xf.sx < 0 ? -0.02 : 0.02) : xf.sx;
  const gsy = Math.abs(xf.sy) < 0.02 ? (xf.sy < 0 ? -0.02 : 0.02) : xf.sy;
  const L = [c / gsx, -s / gsy, s / gsx, c / gsy];
  const subx = xf.cx + xf.tx, suby = xf.cy + xf.ty;
  return { L, off: [xf.cx - (L[0] * subx + L[2] * suby), xf.cy - (L[1] * subx + L[3] * suby)] };
}
/* u_xfBox：全选时把羽化带推到画布外，免得整幅变换时四边被羽化吃掉一线 */
function xfBoxUniform() {
  const b = xf.box, F = 1.5;
  return (b.x0 <= 0 && b.y0 <= 0 && b.x1 >= DW && b.y1 >= DH)
    ? [-F, -F, DW + F, DH + F] : [b.x0, b.y0, b.x1, b.y1];
}

function xfBegin() {
  if (xf.on) return;
  /* 源 bbox：有选区取选中像素包围盒；无选区 / 全选 → 整幅 */
  const img = mctx.getImageData(0, 0, DW, DH).data;
  let x0 = DW, y0 = DH, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < DH; y++) {
    const row = y * DW * 4;
    for (let x = 0; x < DW; x++) {
      if (img[row + x * 4] > 127) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0 || n >= DW * DH) { x0 = 0; y0 = 0; x1 = DW; y1 = DH; }
  xf.box = { x0, y0, x1, y1 };
  xf.cx = (x0 + x1) / 2; xf.cy = (y0 + y1) / 2;
  xf.ang = 0; xf.sx = 1; xf.sy = 1; xf.tx = 0; xf.ty = 0;
  xf.drag = null; xf.hover = 'move';
  if (!xfSrcTex) { xfSrcTex = mkTex(DW, DH, gl.LINEAR); xfBackTex = mkTex(DW, DH, gl.LINEAR); }
  for (const [tex, keep] of [[xfBackTex, 0], [xfSrcTex, 1]]) {
    beginPass(tex);
    gl.useProgram(P_xfe.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, paintCur);
    gl.uniform1i(P_xfe.u.u_layer, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.uniform1i(P_xfe.u.u_mask, 1);
    gl.uniform1f(P_xfe.u.u_keep, keep);
    fsQuad();
  }
  xf.on = true;
}

function xfCommit() {
  if (!xf.on) return;
  xf.on = false;
  xf.drag = null;
  uic.style.cursor = '';
  /* 纹丝未动的会话不配拥有一个撤销步骤，也不该把选区清掉 */
  if (Math.abs(xf.ang) < 1e-6 && Math.abs(xf.sx - 1) < 1e-6 && Math.abs(xf.sy - 1) < 1e-6
      && Math.abs(xf.tx) < 0.5 && Math.abs(xf.ty) < 0.5) return;
  /* 受影响区域 = 源框（被抠空）∪ 变换后四角（被写入） */
  const b = xf.box;
  let ux0 = b.x0, uy0 = b.y0, ux1 = b.x1, uy1 = b.y1;
  for (const p of xfCorners()) {
    if (p.x < ux0) ux0 = p.x;
    if (p.y < uy0) uy0 = p.y;
    if (p.x > ux1) ux1 = p.x;
    if (p.y > uy1) uy1 = p.y;
  }
  const c = clampBBox(ux0, uy0, ux1 - ux0, uy1 - uy0, 2);
  if (!c) return;
  const [rx, ry, rw, rh] = c;
  const before = snapRegion(paintCur, rx, ry, rw, rh);
  /* 直接写图层：本 pass 只采样 back/src 两张纹理，无反馈环 */
  if (beginPass(paintCur, rx, ry, rw, rh)) {
    gl.useProgram(P_xfc.p);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, xfBackTex);
    gl.uniform1i(P_xfc.u.u_back, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, xfSrcTex);
    gl.uniform1i(P_xfc.u.u_src, 1);
    const inv = xfInv();
    gl.uniformMatrix2fv(P_xfc.u.u_xfLin, false, inv.L);
    gl.uniform2f(P_xfc.u.u_xfOff, inv.off[0], inv.off[1]);
    gl.uniform4f(P_xfc.u.u_xfBox, ...xfBoxUniform());
    gl.uniform4f(P_xfc.u.u_rect, rx, ry, rw, rh);
    gl.uniform2f(P_xfc.u.u_res, DW, DH);
    fsQuad();
  }
  pushUndo(before);
  maskReset();            /* 变换完选区使命结束，清掉（复位成全白） */
}

function xfCancel() {
  if (!xf.on) return;
  xf.on = false;
  xf.drag = null;
  uic.style.cursor = '';
}

/* ---------- 命中判定 ----------
   角点命中用变换后的角点（屏幕半径换算成文档半径）；
   框内/框边用逆映射回源空间判定，任意角度下都精确。 */
function xfHit(d) {
  const hr = 11 / view.scale;
  for (const p of xfCorners()) {
    if (Math.hypot(d.x - p.x, d.y - p.y) < hr) return 'scale';
  }
  const { L, off } = xfInv();
  const sxp = L[0] * d.x + L[2] * d.y + off[0];
  const syp = L[1] * d.x + L[3] * d.y + off[1];
  const b = xf.box, m = 3 / view.scale;
  if (sxp > b.x0 - m && sxp < b.x1 + m && syp > b.y0 - m && syp < b.y1 + m) return 'move';
  const dxo = Math.max(b.x0 - sxp, sxp - b.x1, 0);
  const dyo = Math.max(b.y0 - syp, syp - b.y1, 0);
  /* 框边外侧 56 屏幕像素以内 = 旋转带。用源空间距离 × scale 近似，
     旋转本身不改变这个空间，缩放时误差可忽略 */
  if (Math.hypot(dxo, dyo) * view.scale < 56) return 'rotate';
  return 'out';
}

function xfDown(e, d) {
  const hit = xfHit(d);
  if (hit === 'out') { xfCommit(); return; }
  if (hit === 'move') {
    xf.drag = { kind: 'move', p0: d, t0: [xf.tx, xf.ty] };
  } else if (hit === 'scale') {
    xf.drag = { kind: 'scale', p0: d, s0: [xf.sx, xf.sy],
                cv: { x: xf.cx + xf.tx, y: xf.cy + xf.ty } };
  } else {
    const cv = { x: xf.cx + xf.tx, y: xf.cy + xf.ty };
    xf.drag = { kind: 'rotate', a0: xf.ang,
                a00: Math.atan2(d.y - cv.y, d.x - cv.x) };
  }
}

function xfMove(e, d) {
  if (!xf.drag) {
    xf.hover = xfHit(d);
    uic.style.cursor = XF_CURSORS[xf.hover] || '';
    return;
  }
  const g = xf.drag;
  if (g.kind === 'move') {
    xf.tx = g.t0[0] + (d.x - g.p0.x);
    xf.ty = g.t0[1] + (d.y - g.p0.y);
  } else if (g.kind === 'scale') {
    /* 等比缩放绕视觉中心 C+T：|T| 不变时 fwd(C) 恒等于 C+T，
       所以只动 S 就是"绕四角中心缩放"，不需要补偿平移 */
    const d0 = Math.max(4, Math.hypot(g.p0.x - g.cv.x, g.p0.y - g.cv.y));
    const k = Math.min(40, Math.max(0.04, Math.hypot(d.x - g.cv.x, d.y - g.cv.y) / d0));
    xf.sx = g.s0[0] * k;
    xf.sy = g.s0[1] * k;
  } else {
    const cv = { x: xf.cx + xf.tx, y: xf.cy + xf.ty };
    xf.ang = g.a0 + Math.atan2(d.y - cv.y, d.x - cv.x) - g.a00;
  }
}

function drawXfHandles(X, Y) {
  const cs = xfCorners().map(p => [X(p.x), Y(p.y)]);
  octx.lineWidth = 1;
  octx.strokeStyle = 'rgba(0,0,0,.7)';
  octx.beginPath();
  octx.moveTo(cs[0][0], cs[0][1]);
  for (let i = 1; i < 4; i++) octx.lineTo(cs[i][0], cs[i][1]);
  octx.closePath();
  octx.stroke();
  octx.setLineDash([4, 4]);
  octx.lineDashOffset = -antsPhase;
  octx.strokeStyle = 'rgba(255,255,255,.9)';
  octx.stroke();
  octx.setLineDash([]);
  for (const [hx, hy] of cs) {
    octx.fillStyle = '#fff';
    octx.fillRect(hx - 4, hy - 4, 8, 8);
    octx.strokeStyle = 'rgba(0,0,0,.85)';
    octx.strokeRect(hx - 4 + 0.5, hy - 4 + 0.5, 7, 7);
  }
  const c = xfFwd({ x: xf.cx, y: xf.cy });
  octx.strokeStyle = 'rgba(255,255,255,.9)';
  octx.beginPath();
  octx.moveTo(X(c.x) - 5, Y(c.y)); octx.lineTo(X(c.x) + 5, Y(c.y));
  octx.moveTo(X(c.x), Y(c.y) - 5); octx.lineTo(X(c.x), Y(c.y) + 5);
  octx.stroke();
}

/* ---------- 平移 / 缩放 ---------- */
let spaceDown = false, panActive = false;
const panStart = { x: 0, y: 0, vx: 0, vy: 0 };
function startPan(e) {
  panActive = true;
  panStart.x = e.clientX; panStart.y = e.clientY;
  panStart.vx = view.x; panStart.vy = view.y;
  try { uic.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件没有有效 pointerId */ }
  uic.style.cursor = 'grabbing';
}
function doPan(e) {
  const r = glc.getBoundingClientRect();
  const k = glc.width / r.width;
  view.x = panStart.vx + (e.clientX - panStart.x) * k;
  view.y = panStart.vy + (e.clientY - panStart.y) * k;
}
function endPan() { panActive = false; uic.style.cursor = ''; }

uic.addEventListener('wheel', (e) => {
  e.preventDefault();
  /* 工作台层（时间轴缩放/滚动、镜头面板滚动）优先消费 */
  { const ws = window.__fabulaWorkspace;
    if (ws && ws.onWheel && ws.onWheel(e.clientX, e.clientY, e)) return; }
  /* 面板上滚轮 = 滚动面板；画布上滚轮 = 以光标为锚缩放（抽屉收起时不再拦） */
  { const vw2 = window.__fabulaView;
    if ((!vw2 || vw2.paramsOpen()) && panelInRect(e.clientX, e.clientY)) {
      panelUI.scrollY = Math.max(0, Math.min(panelUI.maxScroll, panelUI.scrollY + e.deltaY));
      return;
    } }
  const r = glc.getBoundingClientRect();
  const k = glc.width / r.width;
  const sx = (e.clientX - r.left) * k, sy = (e.clientY - r.top) * k;
  const before = { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
  const f = Math.exp(-e.deltaY * 0.0016);
  view.scale = Math.min(14, Math.max(0.06, view.scale * f));
  view.x = sx - before.x * view.scale;
  view.y = sy - before.y * view.scale;
}, { passive: false });

/* ---------- 键盘 ---------- */
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  /* 动作表优先：工具选择与命令键位（撤销/重做/笔刷大小/视图…）都可由用户重绑
     （data/actions.js）。会话类键位（下方 xf 块、空格平移、Esc 取消、Shift+W
     液化模式、Ctrl+A/Shift+I 选区）不进动作表，保持引擎内处理。 */
  if (window.__fabulaActions && window.__fabulaActions.handleKey(e)) return;
  if (xf.on) {
    if (e.key === 'Enter') { e.preventDefault(); xfCommit(); return; }
    if (e.key === 'Escape') { e.preventDefault(); xfCancel(); return; }
    if (e.key === 'h' || e.key === 'H') { xf.sx = -xf.sx; return; }
    if (e.key === 'v' || e.key === 'V') { xf.sy = -xf.sy; return; }
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const st = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') xf.tx -= st;
      if (e.key === 'ArrowRight') xf.tx += st;
      if (e.key === 'ArrowUp') xf.ty -= st;
      if (e.key === 'ArrowDown') xf.ty += st;
      return;
    }
  }
  if (e.code === 'Space') { spaceDown = true; uic.style.cursor = 'grab'; e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }   /* Ctrl+Y 习惯键（重做主键位在动作表） */
  if (e.key === 'Escape') {
    if (lassoCur) { cancelLasso(); return; }        /* Esc 取消正在拖的这条套索 */
    if (tool === 'lasso') { deselectAll(); return; }
  }
  if (e.shiftKey && (e.key === 'W' || e.key === 'w') && tool === 'warp') {
    P.warpMode = (P.warpMode + 1) % WARP_MODES.length;      /* Shift+W 循环液化模式 */
    e.preventDefault();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault(); deselectAll(); return;               /* 全选 = 掩膜复位（无约束） */
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'i') {
    e.preventDefault(); invertMask(); return;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; if (!panActive) uic.style.cursor = ''; }
});

/* ============================================================
   UI 构建
   ============================================================ */
/* DOM UI 已移除：工具条 / 色板 / HUD 全部由自绘 UI（drawUI → ui 层 canvas）承担 */

const toolParams = {};

/* 按笔记忆：prefs.brushParams[id] 覆盖预设（在 applyBrush/会话缓存之后套用，
   只覆盖保存过的键）——PS 语义：改过的笔刷参数切走再切回来还在。 */
function applySavedBrushParams(id) {
  try {
    const p = window.__fabulaPrefs;
    const bp = p && p.get('brushParams');
    const saved = bp && bp[id];
    if (!saved || typeof saved !== 'object') return;
    for (const k in saved) if (k in P) P[k] = saved[k];
  } catch (_) {}
}

function setTool(id) {
  const changed = tool !== id;
  if (changed) {
    /* 笔画进行中切工具：先把当前笔按原工具收掉 —— 否则收笔撞上新工具的
       分支（以 pen 起笔、以 smudge 收笔，撤销快照会拿到上一笔的 preScratch） */
    if (drawing) endStroke();
    penPending = false;          /* 悬置的起笔门槛随工具切换一并作废 */
    penPendingMoved = 0;
    /* 套索画到一半切线工具：先把它落实成选区。
       不落实的话这条路径没人接手，会永远挂在屏幕上。 */
    if (tool === 'lasso') commitLasso();
    /* 变形会话同理：切走 = 提交（PS 也是这个行为） */
    if (xf.on && id !== 'transform') xfCommit();
    toolParams[tool] = Object.assign({}, P);
    tool = id;
    if (toolParams[id]) Object.assign(P, toolParams[id]);
    else applyBrush(id);
    applySavedBrushParams(id);
    if (id === 'transform') xfBegin();
  }
  updateStat();
  /* DOM 工具列同步（快捷键切工具时按钮态/参数面板也要跟着变） */
  try { window.__fabulaEngine.onToolChange && window.__fabulaEngine.onToolChange(id); } catch (_) {}
}

function invertMask() {
  const img = mctx.getImageData(0, 0, DW, DH);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i]; d[i+1] = d[i]; d[i+2] = d[i]; d[i+3] = 255;
  }
  mctx.putImageData(img, 0, 0);
  maskChanged();          /* 轮廓要从新掩膜重提，否则反选完就看不清选区在哪了 */
}

/* 顶栏动作（撤销/重做/铺底色/清空/导出）移入自绘工具条 —— 见 doAction */

/* 把图层读回 CPU（RGBA8；readPixels 行序自下而上：文档 y 对应 buf 行 H-1-y）。
   导出 PNG 与油漆桶共用这一条读回路径。 */
function readLayerRGBA8() {
  beginPass(exportTex);
  gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
  gl.viewport(0, 0, DW, DH);
  gl.useProgram(P_blit.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, paintCur);
  gl.uniform1i(P_blit.u.u_tex, 0);
  gl.uniform4f(P_blit.u.u_src, 0, 0, 1, 1);
  fsQuad();
  const buf = new Uint8Array(DW * DH * 4);
  gl.readPixels(0, 0, DW, DH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return buf;
}

function exportPNG() {
  const buf = readLayerRGBA8();

  const out = document.createElement('canvas');
  out.width = DW; out.height = DH;
  const octx = out.getContext('2d');
  const img = octx.createImageData(DW, DH);
  for (let y = 0; y < DH; y++) {
    const sy = DH - 1 - y;
    for (let x = 0; x < DW; x++) {
      const si = (sy * DW + x) * 4, di = (y * DW + x) * 4;
      const a = buf[si + 3] / 255;
      img.data[di]     = Math.round(buf[si]     + (1 - a) * 255);
      img.data[di + 1] = Math.round(buf[si + 1] + (1 - a) * 255);
      img.data[di + 2] = Math.round(buf[si + 2] + (1 - a) * 255);
      img.data[di + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  const a = document.createElement('a');
  a.download = 'fabula-' + Date.now() + '.png';
  a.href = out.toDataURL('image/png');
  a.click();
}

/* ============================================================
   自绘 UI（2D canvas，immediate mode）
   —— 路线 A 的落地：界面不经过 DOM。工具条/色板/HUD/探针每帧重画，
   命中区每帧重建，状态只存在数据里（tool / P / color / undoStack）。
   ============================================================ */
const SWATCHES = ['#22262b','#5a6472','#a8b4c0','#ffffff','#b4553f','#c99a4e','#6f8f5a','#4a7a9b','#7a5d8f','#c98fa6'];
const WARP_MODES = ['前推', '旋转', '收缩', '膨胀', '放大', '缩小'];
const UI_ACTIONS = [
  { id: 'undo',   name: '撤销',     icon: 'M9 14 4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3' },
  { id: 'redo',   name: '重做',     icon: 'M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3' },
  { id: 'white',  name: '铺白底',   icon: 'M4.5 4.5h15v15h-15z' },
  { id: 'clear',  name: '清空',     icon: 'M5 7h14 M9 7V5h6v2 M7 7l1 13h8l1-13' },
  { id: 'export', name: '导出 PNG', icon: 'M12 4v10 M8 10l4 4 4-4 M5 19h14' },
];

const UI = { items: [] };   // 每帧重建的命中区

function uiRoundRect(x, y, w, h, r) {
  uctx.beginPath();
  if (uctx.roundRect) uctx.roundRect(x, y, w, h, r);
  else uctx.rect(x, y, w, h);
}

/* 图标沿用 BRUSHES 的 24×24 SVG path 数据，Path2D 直接描边 */
function uiIcon(d, cx, cy, size, color) {
  const p = new Path2D(d);
  uctx.save();
  uctx.translate(cx - size / 2, cy - size / 2);
  uctx.scale(size / 24, size / 24);
  uctx.strokeStyle = color;
  uctx.lineWidth = 1.5;
  uctx.lineCap = 'round'; uctx.lineJoin = 'round';
  uctx.stroke(p);
  uctx.restore();
}

function drawUI() {
  const dpr = uic.width / Math.max(1, uic.clientWidth || 1);
  const W = uic.clientWidth || Math.round(uic.width / dpr);
  const H = uic.clientHeight || Math.round(uic.height / dpr);
  uctx.setTransform(1, 0, 0, 1, 0, 0);
  uctx.clearRect(0, 0, uic.width, uic.height);
  uctx.scale(dpr, dpr);
  UI.items.length = 0;

  /* ---- 左侧工具条（三区布局时让位给左镜头面板） ---- */
  const wsR = (window.__fabulaWorkspace && window.__fabulaWorkspace.rects) || null;
  const th = themeTokens();
  const vwView = window.__fabulaView;
  if (vwView && vwView.view() !== 'timeline') {
    const ws0 = window.__fabulaWorkspace;
    if (ws0 && ws0.onFrame) ws0.onFrame(uctx, W, H);
    return;
  }
  const bx = wsR ? wsR.canvas.x + 10 : 10;
  const entries = [];
  for (const t of TOOLS) {
    if (t.gap) entries.push({ gap: true });
    else entries.push({ kind: 'tool', id: t.id, icon: t.icon });
  }
  entries.push({ gap: true });
  for (const a of UI_ACTIONS) entries.push({ kind: 'action', id: a.id, icon: a.icon });

  const nBtn = entries.reduce((n, e) => n + (e.gap ? 0 : 1), 0);
  const nGap = entries.reduce((n, e) => n + (e.gap ? 1 : 0), 0);
  const panelH = nBtn * 42 + nGap * 9 + 6;

  uiRoundRect(bx - 4, 6, 48, panelH, 12);
  uctx.fillStyle = th.cardStrong; uctx.fill();
  uctx.strokeStyle = th.border; uctx.lineWidth = 1; uctx.stroke();

  let cy = 10;
  for (const e of entries) {
    if (e.gap) {
      uctx.fillStyle = th.border;
      uctx.fillRect(bx + 10, cy + 3, 20, 1);
      cy += 9;
      continue;
    }
    const active = e.kind === 'tool' && tool === e.id;
    UI.items.push({ kind: e.kind, id: e.id, x: bx, y: cy, w: 40, h: 40 });
    uiRoundRect(bx, cy, 40, 40, 9);
    uctx.fillStyle = active ? th.accentA(0.22) : th.inputBg;
    uctx.fill();
    if (active) { uctx.strokeStyle = th.accentA(0.75); uctx.stroke(); }
    uiIcon(e.icon, bx + 20, cy + 20, 18, active ? th.accent : th.textDim);
    cy += 42;
  }

  /* ---- 液化模式子菜单（warp 选中时出现在工具条右侧）---- */
  if (tool === 'warp') {
    const mx = bx + 56;
    uiRoundRect(mx - 4, 6, 74, WARP_MODES.length * 30 + 10, 10);
    uctx.fillStyle = th.cardStrong; uctx.fill();
    uctx.strokeStyle = th.border; uctx.stroke();
    let my = 11;
    WARP_MODES.forEach((m, i) => {
      const on = P.warpMode === i;
      UI.items.push({ kind: 'warpMode', i, x: mx, y: my, w: 66, h: 26 });
      uiRoundRect(mx, my, 66, 26, 7);
      uctx.fillStyle = on ? th.accentA(0.22) : th.inputBg;
      uctx.fill();
      if (on) { uctx.strokeStyle = th.accentA(0.7); uctx.stroke(); }
      uctx.font = '11px ' + th.fonts;
      uctx.fillStyle = on ? th.accent : th.textDim;
      uctx.textAlign = 'center'; uctx.textBaseline = 'middle';
      uctx.fillText(m, mx + 33, my + 14);
      uctx.textAlign = 'left'; uctx.textBaseline = 'alphabetic';
      my += 30;
    });
  }

  /* ---- 底部：当前色 + 色板（三区布局时收到画布区底缘之上） ---- */
  const sy = wsR ? (wsR.canvas.y + wsR.canvas.h - 34) : (H - 34);
  let sx = bx;
  uiRoundRect(sx, sy, 32, 28, 7);
  uctx.fillStyle = 'rgb(' + Math.round(color[0] * 255) + ',' + Math.round(color[1] * 255) + ',' + Math.round(color[2] * 255) + ')';
  uctx.fill();
  uctx.strokeStyle = th.border; uctx.stroke();
  sx += 40;
  SWATCHES.forEach((h, i) => {
    UI.items.push({ kind: 'swatch', i, x: sx, y: sy + 3, w: 22, h: 22 });
    uiRoundRect(sx, sy + 3, 22, 22, 6);
    uctx.fillStyle = h; uctx.fill();
    uctx.strokeStyle = 'rgba(0,0,0,.18)'; uctx.stroke();
    sx += 26;
  });

  /* ---- HUD：快捷键（色板上方两行）---- */
  uctx.font = '11px ' + th.fonts;
  uctx.fillStyle = th.textDim;
  uctx.fillText('v2 · B 秀丽笔  P 铅笔  K 马克笔  G 水粉  A 喷枪  E 橡皮  F 油漆桶  S 涂抹  R 模糊  W 液化  L 套索  T 变形', bx, sy - 28);
  uctx.fillText('[ ] 笔刷大小 · Ctrl+Z/Y 撤销重做 · 空格拖动平移 · 滚轮缩放 · Ctrl+A 全选 · Ctrl+Shift+I 反选 · 笔尾橡皮 · 笔侧键平移', bx, sy - 12);

  /* 压感探针已并入右侧参数面板顶部（drawPanel） */

  /* ---- 工作台层：左镜头面板 + 底时间轴骨架 ---- */
  const ws = window.__fabulaWorkspace;
  if (ws && ws.onFrame) ws.onFrame(uctx, W, H);
}

function uiHitTest(mx, my) {
  for (let i = UI.items.length - 1; i >= 0; i--) {
    const it = UI.items[i];
    if (mx >= it.x && mx <= it.x + it.w && my >= it.y && my <= it.y + it.h) return it;
  }
  return null;
}

function uiPointerDown(e) {
  const it = uiHitTest(e.clientX, e.clientY);
  if (it) {
    if (it.kind === 'tool') setTool(it.id);
    else if (it.kind === 'action') {
      if (it.id === 'undo') doUndo();
      else if (it.id === 'redo') doRedo();
      else if (it.id === 'white') fillLayer(1, 1, 1, 1);
      else if (it.id === 'clear') clearLayer();
      else if (it.id === 'export') exportPNG();
    }
    else if (it.kind === 'swatch') color = hexRgb(SWATCHES[it.i]);
    else if (it.kind === 'warpMode') P.warpMode = it.i;
    return true;
  }
  /* 工作台层：左镜头面板 / 底时间轴（命中即消费，不穿透到画布） */
  const ws = window.__fabulaWorkspace;
  if (ws && ws.onPointerDown && ws.onPointerDown(e.clientX, e.clientY)) return true;
  /* 参数面板：滑条/开关/分段；面板空白也拦截（不穿透到画布）。抽屉收起时不拦 */
  const vw1 = window.__fabulaView;
  if ((!vw1 || vw1.paramsOpen()) && panelInRect(e.clientX, e.clientY)) {
    panelPointerDown(e.clientX, e.clientY);
    return true;
  }
  return false;
}

/* ============================================================
   参数面板（自绘，右侧，可滚动）
   —— 滑条 / 开关 / 分段全部 immediate mode，每帧重画；
   滚轮在面板上滚动面板，在画布上缩放画布；
   每个工具各自记住手调参数（toolParams 机制不变）。
   ============================================================ */
const PANEL = { w: 214, pad: 11, rowH: 33, sectH: 26, checkH: 22, segH: 30, probeH: 38 };
const panelUI = { x: 0, y: 0, w: PANEL.w, h: 0, scrollY: 0, maxScroll: 0, items: [] };
let uiDragSlider = null;
/* 分组折叠状态（PS 式二级菜单）：默认只展开常用组，点组名展开/收起 */
const uiFolded = new Set(['tilt2', 'tipshape', 'grain', 'dyn', 'pen']);

function fmtPanelVal(r) {
  const v = r.obj[r.key], k = r.key;
  if (k === 'angleOffset') return Math.round(v) + '°';
  if (k === 'size' || k === 'blurRadius' || k === 'grainScale') return Math.round(v) + 'px';
  if (k === 'airRate') return Math.round(v) + '/s';
  if (k === 'fillTolerance') return String(Math.round(v));
  if (k === 'spacing' || k === 'jitterPos' || k === 'tip' || k === 'roundness'
      || k === 'pMin' || k === 'pMax' || k === 'curve' || k === 'speedRef' || k === 'smooth') return Number(v).toFixed(2);
  return Math.round(v * 100) + '%';
}

function panelRows() {
  const rows = [];
  let group = null;
  const T = (key, title) => { group = key; rows.push({ kind: 'sect', title, group: key }); };
  const S = (key, label, min, max, step, obj) => rows.push({ kind: 'slider', key, label, min, max, step, obj: obj || P, group });
  const C = (key, label) => rows.push({ kind: 'check', key, label, obj: P, group });

  rows.push({ kind: 'probe' });

  if (tool === 'transform') {
    T('xf', '变形');
    rows.push({ kind: 'note', text: '框内拖动 = 移动\n角点 = 等比缩放\n框边外侧 = 旋转\nH / V = 翻转\n方向键微调（Shift = 10px）\nEnter / 双击 = 应用 · Esc = 取消', group: 'xf' });
    return rows;
  }

  T('core', '笔刷');
  S('size', '大小', 2, 400, 1);
  if (isStrokeTool(tool)) {
    S('hardness', '硬度', 0, 1, 0.01);
    S('opacity', '不透明度', 0.01, 1, 0.01);
    S('flow', '流量', 0.01, 1, 0.01);
    S('spacing', '间距', 0.02, 1, 0.01);
    S('stabilize', '防抖', 0, 1, 0.01);
    T('tilt2', '倾角（笔杆姿态）');
    C('tiltOn', '启用倾角');
    S('angleOffset', '默认角度', 0, 180, 1);
    S('tiltSize', '倾斜→加宽', 0, 1, 0.01);
    S('tiltShape', '倾斜→压扁转向', 0, 1, 0.01);
    S('tiltFlow', '倾斜→流量衰减', 0, 1, 0.01);
    T('tipshape', '笔尖形状');
    S('tip', '方笔尖', 0, 1, 0.01);
    S('roundness', '压扁比', 0.15, 1, 0.01);
    S('rotFollow', '跟随运笔（直立回退）', 0, 1, 0.01);
    T('grain', '纸纹 / 颜料');
    S('grain', '颗粒', 0, 1, 0.01);
    S('grainScale', '颗粒尺度', 0.8, 20, 0.1);
    S('pigment', '颜色斑驳', 0, 1, 0.01);
    T('dyn', '抖动 / 动态');
    S('jitterSize', '大小抖动', 0, 1, 0.01);
    S('jitterPos', '位置抖动', 0, 1.5, 0.01);
    S('spread', '法线散布', 0, 6, 0.05);
    S('dryOut', '越画越淡', 0, 1, 0.01);
    C('airbrush', '喷枪持续出墨');
    if (P.airbrush) S('airRate', '出墨速率', 20, 900, 10);
    C('buildup', '流量叠加（Flow）');
  }
  if (tool === 'smudge') {
    T('smudge', '涂抹');
    S('smudgeStrength', '强度', 0, 1, 0.01);
    S('smudgeDrag', '拖拽距离', 0.1, 2.5, 0.05);
    S('smudgeColor', '上色率', 0, 1, 0.01);
  }
  if (tool === 'blur') {
    T('blur', '模糊');
    S('blurStrength', '强度', 0, 1, 0.01);
    S('blurRadius', '半径', 1, 60, 1);
  }
  if (tool === 'warp') {
    T('warp', '液化');
    S('warpStrength', '强度', 0, 1, 0.01);
  }
  if (tool === 'fill') {
    T('fill', '油漆桶');
    S('fillTolerance', '容差', 0, 100, 1);
  }
  if (isStrokeTool(tool)) {
    T('pen', '压感 / 数位板');
    rows.push({ kind: 'seg', key: 'mode', obj: PEN, items: ['自动', '强制压力', '速度驱动'], group: 'pen' });
    S('pMin', '死区', 0, 0.4, 0.005, PEN);
    S('pMax', '饱和点', 0.4, 1, 0.005, PEN);
    S('curve', '曲线', 0.25, 2.2, 0.01, PEN);
    S('speedRef', '速度参考', 0.4, 6, 0.05, PEN);
    S('smooth', '平滑', 0, 0.9, 0.01, PEN);
    S('pressSize', '压力→大小', 0, 1, 0.01);
    S('pressFlow', '压力→流量', 0, 1, 0.01);
  }
  return rows;
}

function rowH(r) {
  if (r.kind === 'sect') return PANEL.sectH;
  if (r.kind === 'probe') return PANEL.probeH;
  if (r.kind === 'check') return PANEL.checkH;
  if (r.kind === 'seg') return PANEL.segH;
  if (r.kind === 'note') return 92;
  return PANEL.rowH;
}

function drawPanel() {
  /* 参数抽屉：默认收起（montage 形态：素材库 | 画板 + 时间轴），顶栏 ⚙ 展开 */
  const vw0 = window.__fabulaView;
  if (vw0 && !vw0.paramsOpen()) return;
  const dpr = uic.width / Math.max(1, uic.clientWidth || 1);
  const W = uic.clientWidth || Math.round(uic.width / dpr);
  const H = uic.clientHeight || Math.round(uic.height / dpr);
  panelUI.x = W - PANEL.w - 10;
  /* 顶栏之下、时间轴之上（三区布局时）；无布局时退回原全屏定位 */
  const wsRR = (window.__fabulaWorkspace && window.__fabulaWorkspace.rects) || null;
  const topH = wsRR ? wsRR.top.h : 0;
  const tlY = wsRR ? wsRR.timeline.y : H;
  panelUI.y = topH + 10;
  panelUI.h = Math.max(120, tlY - panelUI.y - 10);
  const rows = panelRows();

  let ch = PANEL.pad;
  for (const r of rows) ch += rowH(r);
  ch += PANEL.pad;
  panelUI.maxScroll = Math.max(0, ch - panelUI.h);
  panelUI.scrollY = Math.max(0, Math.min(panelUI.maxScroll, panelUI.scrollY));
  panelUI.items.length = 0;

  const th = themeTokens();
  uiRoundRect(panelUI.x, panelUI.y, panelUI.w, panelUI.h, 12);
  uctx.fillStyle = th.cardStrong; uctx.fill();
  uctx.strokeStyle = th.border; uctx.lineWidth = 1; uctx.stroke();

  uctx.save();
  uiRoundRect(panelUI.x, panelUI.y, panelUI.w, panelUI.h, 12);
  uctx.clip();
  uctx.translate(0, -panelUI.scrollY);

  const x = panelUI.x + PANEL.pad;
  const w = panelUI.w - PANEL.pad * 2;
  let yy = panelUI.y + PANEL.pad;

  let curGroup = null;
  for (const r of rows) {
    if (r.kind === 'sect') {
      /* PS 式二级菜单：组名可点击展开/收起（▸ 收起 / ▾ 展开） */
      curGroup = r.group;
      const folded = uiFolded.has(r.group);
      panelUI.items.push({ kind: 'sect', group: r.group, x: panelUI.x, y: yy - panelUI.scrollY, w: panelUI.w, h: PANEL.sectH - 4 });
      uctx.font = '10px ' + th.fonts;
      uctx.fillStyle = th.accentA(0.9);
      uctx.fillText((folded ? '▸ ' : '▾ ') + r.title, x, yy + 12);
      uctx.fillStyle = th.border;
      uctx.fillRect(x, yy + 17, w, 1);
      yy += PANEL.sectH;
      continue;
    }
    if (curGroup && uiFolded.has(curGroup)) continue;   /* 组收起：整组跳过 */
    if (r.kind === 'probe') {
      /* 压感探针：拿笔划一下就知道板子在报什么 */
      uctx.font = '11px ui-monospace, Consolas, monospace';
      const kind = PEN.lastType === 'pen' ? '数位板' : (PEN.lastType === 'touch' ? '触摸' : (PEN.lastType === '—' ? '待输入' : '鼠标'));
      let mode;
      if (PEN.mode === 1) mode = '强制压力';
      else if (PEN.mode === 2) mode = '速度驱动';
      else if (PEN.pressureSeen === false) mode = '速度·自动降级';
      else if (PEN.pressureSeen === true) mode = '压力·自动';
      else mode = '压力·探测中';
      uctx.fillStyle = th.textDim;
      uctx.fillText((TOOL_BY_ID[tool] ? TOOL_BY_ID[tool].name : tool) + ' · ' + Math.round(P.size) + 'px · '
        + kind + '/' + mode + (PEN.sawTilt ? '·倾斜' : ''), x, yy + 11);
      uctx.fillStyle = th.inputBg;
      uctx.fillRect(x, yy + 16, w, 5);
      uctx.fillStyle = th.accent;
      uctx.fillRect(x, yy + 16, Math.round(w * clamp01(PEN.lastShapeP)), 5);
      uctx.fillText('压感 ' + PEN.lastShapeP.toFixed(2) + ' · 倾斜 ' + Math.round(PEN.tilt * 76) + '° · '
        + fpsVal + ' FPS · 撤销 ' + undoStack.length + ' 步', x, yy + 33);
    } else if (r.kind === 'slider') {
      const v = r.obj[r.key];
      const t = clamp01((v - r.min) / (r.max - r.min));
      uctx.font = '11px ' + th.fonts;
      uctx.fillStyle = th.textDim;
      uctx.fillText(r.label, x, yy + 11);
      uctx.fillStyle = th.accentA(0.95);
      uctx.textAlign = 'right';
      uctx.fillText(fmtPanelVal(r), x + w, yy + 11);
      uctx.textAlign = 'left';
      const ty = yy + 20;
      uiRoundRect(x, ty, w, 4, 2);
      uctx.fillStyle = th.inputBg; uctx.fill();
      uiRoundRect(x, ty, Math.max(2, w * t), 4, 2);
      uctx.fillStyle = th.accentA(0.45); uctx.fill();
      uctx.beginPath();
      uctx.arc(x + w * t, ty + 2, 5, 0, Math.PI * 2);
      uctx.fillStyle = th.accent; uctx.fill();
      panelUI.items.push({ kind: 'slider', r, x: panelUI.x + 4, y: yy - panelUI.scrollY, w: panelUI.w - 8, h: 30, tx: x, tw: w });
    } else if (r.kind === 'check') {
      const on = !!r.obj[r.key];
      panelUI.items.push({ kind: 'check', r, x: panelUI.x + 4, y: yy - panelUI.scrollY, w: panelUI.w - 8, h: PANEL.checkH });
      uctx.strokeStyle = on ? th.accent : th.textDim;
      uctx.lineWidth = 1.2;
      uctx.strokeRect(x + 0.5, yy + 4.5, 13, 13);
      if (on) {
        uctx.beginPath();
        uctx.moveTo(x + 3, yy + 11); uctx.lineTo(x + 6.5, yy + 14.5); uctx.lineTo(x + 12, yy + 6);
        uctx.stroke();
      }
      uctx.font = '12px ' + th.fonts;
      uctx.fillStyle = on ? th.text : th.textDim;
      uctx.fillText(r.label, x + 20, yy + 15);
    } else if (r.kind === 'seg') {
      const bw = w / r.items.length;
      r.items.forEach((it, i) => {
        const on = r.obj[r.key] === i;
        const bxx = x + i * bw;
        panelUI.items.push({ kind: 'seg', r, idx: i, x: bxx, y: yy - panelUI.scrollY, w: bw, h: 24 });
        uiRoundRect(bxx, yy, bw - 2, 24, 6);
        uctx.fillStyle = on ? th.accentA(0.22) : th.inputBg;
        uctx.fill();
        if (on) { uctx.strokeStyle = th.accentA(0.7); uctx.stroke(); }
        uctx.font = '11px ' + th.fonts;
        uctx.fillStyle = on ? th.accent : th.textDim;
        uctx.textAlign = 'center';
        uctx.fillText(it, bxx + bw / 2 - 1, yy + 15);
        uctx.textAlign = 'left';
      });
    } else if (r.kind === 'note') {
      uctx.font = '11px ' + th.fonts;
      uctx.fillStyle = th.textDim;
      String(r.text).split('\n').forEach((ln, i) => uctx.fillText(ln, x, yy + 13 + i * 15));
    }
    yy += rowH(r);
  }
  uctx.restore();
}

function panelPointerDown(mx, my) {
  for (const it of panelUI.items) {
    if (mx >= it.x && mx <= it.x + it.w && my >= it.y && my <= it.y + it.h) {
      if (it.kind === 'slider') {
        uiDragSlider = it;
        panelDragMove(mx);
        return true;
      }
      if (it.kind === 'check') { it.r.obj[it.r.key] = !it.r.obj[it.r.key]; return true; }
      if (it.kind === 'seg') { it.r.obj[it.r.key] = it.idx; return true; }
      if (it.kind === 'sect') {
        if (uiFolded.has(it.group)) uiFolded.delete(it.group);
        else uiFolded.add(it.group);
        return true;
      }
    }
  }
  return false;
}

function panelInRect(mx, my) {
  return mx >= panelUI.x && mx <= panelUI.x + panelUI.w
      && my >= panelUI.y && my <= panelUI.y + panelUI.h;
}

function panelDragMove(mx) {
  const it = uiDragSlider;
  if (!it) return;
  const t = clamp01((mx - it.tx) / it.tw);
  let v = it.r.min + t * (it.r.max - it.r.min);
  v = Math.round(v / it.r.step) * it.r.step;
  it.r.obj[it.r.key] = Math.max(it.r.min, Math.min(it.r.max, v));
}

/* ============================================================
   油漆桶：扫描线洪水填充（4 连通 + 容差）
   思路对齐 Krita 的 kis_scanline_fill：每像素只算一次 8bit 通道差，
   扫描线成段扩展；间隙闭合（GapMap）留到正式版（docs/04 §5）。
   填充结果烧成"白=要填"的掩膜纹理，走 FLOOD_FS 合成 ——
   选区掩膜照样相乘，管线必经的规矩在油漆桶上同样成立。
   ============================================================ */
const floodCv = document.createElement('canvas');
floodCv.width = DW; floodCv.height = DH;
const flctx = floodCv.getContext('2d');

function scanlineFill(buf, sx, sy, tol) {
  const W = DW, H = DH;
  const base = ((H - 1 - sy) * W + sx) * 4;
  const tr = buf[base], tg = buf[base + 1], tb = buf[base + 2], ta = buf[base + 3];
  const mask = new Uint8Array(W * H);
  const match = (x, y) => {
    const i = ((H - 1 - y) * W + x) * 4;
    return Math.abs(buf[i] - tr) <= tol && Math.abs(buf[i + 1] - tg) <= tol
        && Math.abs(buf[i + 2] - tb) <= tol && Math.abs(buf[i + 3] - ta) <= tol;
  };
  let bx0 = sx, by0 = sy, bx1 = sx, by1 = sy;
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop(), xs = stack.pop();
    if (mask[y * W + xs]) continue;
    let xl = xs;
    while (xl > 0 && !mask[y * W + xl - 1] && match(xl - 1, y)) xl--;
    let xr = xs;
    while (xr < W - 1 && !mask[y * W + xr + 1] && match(xr + 1, y)) xr++;
    for (let x = xl; x <= xr; x++) mask[y * W + x] = 255;
    if (xl < bx0) bx0 = xl;
    if (xr > bx1) bx1 = xr;
    if (y < by0) by0 = y;
    if (y > by1) by1 = y;
    for (let ny = y - 1; ny <= y + 1; ny += 2) {
      if (ny < 0 || ny >= H) continue;
      let x = xl;
      while (x <= xr) {
        if (!mask[ny * W + x] && match(x, ny)) {
          let xe = x;
          while (xe < xr && !mask[ny * W + xe + 1] && match(xe + 1, ny)) xe++;
          stack.push(x, ny);
          x = xe + 1;
        } else x++;
      }
    }
  }
  return { mask, bbox: { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 } };
}

function doFloodFill(cx, cy) {
  cx = Math.floor(cx); cy = Math.floor(cy);
  if (cx < 0 || cy < 0 || cx >= DW || cy >= DH) return;
  const buf = readLayerRGBA8();
  const { mask, bbox } = scanlineFill(buf, cx, cy, Math.round(P.fillTolerance * 2.55));

  /* 填充区域 → 白色掩膜图 → 纹理（y 翻转与 maskUpload 同一套约定） */
  const img = flctx.createImageData(DW, DH);
  for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
    const row = y * DW;
    for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
      if (mask[row + x]) {
        const i = (row + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; img.data[i + 3] = 255;
      }
    }
  }
  flctx.putImageData(img, 0, 0);
  uploadCanvasTex(floodTex, floodCv, gl.NEAREST);

  /* 先快照再合成（顺序反了，撤销就会记住填完的样子） */
  const before = snapRegion(paintCur, bbox.x, bbox.y, bbox.w, bbox.h);
  beginPass(paintAlt);
  gl.disable(gl.BLEND);
  gl.useProgram(P_flood.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, paintCur);
  gl.uniform1i(P_flood.u.u_layer, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, floodTex);
  gl.uniform1i(P_flood.u.u_flood, 1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.uniform1i(P_flood.u.u_mask, 2);
  gl.uniform4f(P_flood.u.u_color, color[0], color[1], color[2], 1);
  fsQuad();
  swapPaint();
  pushUndo(before);
}

/* ---------- 工具函数 ---------- */
function hexRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function updateStat() { /* 状态栏已由自绘 HUD 取代；保留调用点以减少对内核的侵入 */ }

/* 状态栏的笔输入指示：直接告诉用户"现在用的是压力还是速度"，
   省得在板子上摸索半天不知道为什么线宽没反应 */
function updatePenStat() { /* 同上：压感指示移入自绘探针（右下角） */ }

/* ============================================================
   呈现
   ============================================================ */
/* 画布底色（paper）——montage 语义：纯预览层，不影响导出/帧文件。
   由 DOM 设置模块（dom/paper.js）经 window.__fabulaPaper 提供；无 DOM 时用默认米白。 */
const PAPER_DEFAULT = '#f5f0ea';
let paperHexCache = PAPER_DEFAULT;
let paperRGB = hexRgb(PAPER_DEFAULT);
function syncPaper() {
  const hex = (window.__fabulaPaper && window.__fabulaPaper.get && window.__fabulaPaper.get()) || PAPER_DEFAULT;
  if (hex !== paperHexCache) { paperHexCache = hex; paperRGB = hexRgb(hex); }
}

/* 显示管线的 uniform 绑定。present() 和调试钩子 readPreview() 共用这一份 ——
   各写一份的话，验证器测的就不是屏幕上真正在跑的那条路径了。 */
function bindDisplay(vw, vh, scale, ox, oy) {
  gl.useProgram(P_disp.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, paintCur);
  gl.uniform1i(P_disp.u.u_layer, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, strokeTex);
  gl.uniform1i(P_disp.u.u_stroke, 1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.uniform1i(P_disp.u.u_mask, 2);
  gl.uniform4f(P_disp.u.u_color, color[0], color[1], color[2], 1);
  gl.uniform1f(P_disp.u.u_opacity, P.opacity);
  gl.uniform1f(P_disp.u.u_erase, erasing() ? 1 : 0);
  gl.uniform1f(P_disp.u.u_grain, P.grain);
  gl.uniform1f(P_disp.u.u_grainScale, P.grainScale);
  gl.uniform1f(P_disp.u.u_pigment, P.pigment);
  gl.uniform2f(P_disp.u.u_viewRes, vw, vh);
  gl.uniform2f(P_disp.u.u_docRes, DW, DH);
  gl.uniform3f(P_disp.u.u_view, scale, ox, oy);
  syncPaper();
  gl.uniform3f(P_disp.u.u_paper, paperRGB[0], paperRGB[1], paperRGB[2]);
  gl.uniform1f(P_disp.u.u_xfOn, xf.on ? 1 : 0);
  if (xf.on) {
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, xfBackTex);
    gl.uniform1i(P_disp.u.u_xfBack, 3);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, xfSrcTex);
    gl.uniform1i(P_disp.u.u_xfSrc, 4);
    const inv = xfInv();
    gl.uniformMatrix2fv(P_disp.u.u_xfLin, false, inv.L);
    gl.uniform2f(P_disp.u.u_xfOff, inv.off[0], inv.off[1]);
    gl.uniform4f(P_disp.u.u_xfBox, ...xfBoxUniform());
  }
}

function present() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND);
  gl.viewport(0, 0, glc.width, glc.height);
  bindDisplay(glc.width, glc.height, view.scale, view.x, view.y);
  fsQuad();
}

/* 调试用：把显示管线按 1:1 渲进一张离屏纹理，再读回像素。
   "预览"和"落定"用的是 COMP / DISP 两个着色器，光靠 readAlpha 读不到预览，
   只有把显示管线真的跑一遍，才能断言"按住笔的瞬间选区外没有脏"。 */
let previewTex = null;
function readPreview(x0, y0, w, h) {
  /* 必须是 RGBA8：默认的 RGBA16F 附件用 UNSIGNED_BYTE 读回来是未定义组合，
     实测读出来整片 0，看着像"什么都没画"。 */
  if (!previewTex) previewTex = mkTex(DW, DH, gl.NEAREST, gl.RGBA8, gl.UNSIGNED_BYTE);
  beginPass(previewTex);
  gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND);
  gl.viewport(0, 0, DW, DH);
  bindDisplay(DW, DH, 1, 0, 0);
  fsQuad();
  /* 必须在还绑着这张 FBO 的时候读 —— 先解绑读到的就是屏幕内容了 */
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(x0, DH - y0 - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { x0, y0, w, h, raw: Array.from(buf) };
}

/* ---------- 覆盖层：蚂蚁线 + 笔刷光标 ---------- */
const octx = ovc.getContext('2d');
const antsPat = octx.createPattern(antsStripeCv, 'repeat');

/* 光标形状 = 实际 dab 形状（用设定尺寸，不跟压感）：
   倾角加宽、压扁转向、扁笔尖锁定角与 drawDabs 同一套公式——
   倾斜笔杆时光标肉眼可见地变形转向，倾角效果不用画出来也能看到。 */
function cursorShape() {
  let size = P.size;
  const tE = P.tiltOn ? tiltEff(PEN.tilt || 0) : 0;
  /* 落笔期间形状跟随笔级倾角（与笔迹一致）；悬空用实时读数（预览） */
  const sE = (drawing && strokeTilt) ? (P.tiltOn ? tiltEff(strokeTilt.mag) : 0) : tE;
  const A = P.angleOffset * Math.PI / 180;
  size = tiltWiden(size, tE);
  const rr = Math.max(0.5, size * 0.5);
  let [rx, ry] = tiltSquash(rr, rr * P.roundness, sE);
  let rot = 0;
  if (P.tiltShape > 0 && sE > 0) {
    rot = (PEN.az || 0) + A;      // 倾角主控（悬空实时预览）
  } else if (P.rotFollow > 0) {
    const la = (strokeInfo.lockAng !== null && strokeInfo.lockAng !== undefined)
      ? strokeInfo.lockAng : lastLockAng;
    rot = (la + A) * P.rotFollow; // 回退：运笔锁定
  }
  /* 落笔期间与笔迹完全一致：用本笔已锁定的旋转角（未锁定时保持实时预览） */
  if (drawing && strokeInfo.lockRot !== null) rot = strokeInfo.lockRot;
  return { rx, ry, rot, square: P.tip > 0.5 };
}

/* 把掩膜轮廓贴到覆盖层上，用滚动斜条纹做出"蚂蚁在爬"的效果。
   先铺一层略微外扩的黑色轮廓，再用条纹把白色轮廓挖成虚线 —— 缺口处露出黑线，
   于是无论底下是深色还是浅色笔迹，线都看得见。 */
function drawAnts(dpr) {
  const W = ovc.width, H = ovc.height;
  if (W <= 0 || H <= 0) return;
  if (antsTmp.width !== W || antsTmp.height !== H) { antsTmp.width = W; antsTmp.height = H; }

  const S = view.scale / dpr, OX = view.x / dpr, OY = view.y / dpr;
  const dx = OX, dy = OY, dw = DW * S, dh = DH * S;

  /* 白虚线：轮廓 ∩ 斜条纹 */
  actx.setTransform(1, 0, 0, 1, 0, 0);
  actx.globalCompositeOperation = 'source-over';
  actx.globalAlpha = 1;
  actx.clearRect(0, 0, W, H);
  actx.save();
  actx.scale(dpr, dpr);
  actx.drawImage(antsWhite, dx, dy, dw, dh);
  actx.globalCompositeOperation = 'destination-in';
  actx.translate(antsPhase, 0);
  const cw = ovc.clientWidth || (W / dpr), ch = ovc.clientHeight || (H / dpr);
  actx.fillStyle = antsPat;
  actx.fillRect(-antsPhase, 0, cw + 32, ch);     /* 多给一点，免得右边留一条没被挖洞的实线 */
  actx.restore();

  octx.save();
  octx.globalAlpha = 0.72;
  octx.drawImage(antsBlack, dx, dy, dw, dh);
  octx.drawImage(antsBlack, dx - 1 / dpr, dy, dw, dh);
  octx.drawImage(antsBlack, dx + 1 / dpr, dy, dw, dh);
  octx.drawImage(antsBlack, dx, dy - 1 / dpr, dw, dh);
  octx.drawImage(antsBlack, dx, dy + 1 / dpr, dw, dh);
  octx.restore();

  octx.save();
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.drawImage(antsTmp, 0, 0);
  octx.restore();
}

function drawOverlay() {
  const dpr = ovc.width / Math.max(1, (ovc.clientWidth || 1));
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, ovc.width, ovc.height);
  octx.scale(dpr, dpr);

  /* 播放/暂停态：ovc 画布区被播放预览接管 —— 只跳过"编辑期覆盖层"
     （蚂蚁线/变形手柄/套索/光标），uic 层的 drawUI/drawPanel 仍每帧重画。
     这里若直接 return，左面板与时间轴会冻结在接管前的那一帧（实测踩过）。 */
  let playbackOwns = false;
  { const pb = window.__fabulaPlayback;
    if (pb && pb.active && pb.active() && pb.draw && pb.draw(octx, ovc.clientWidth, ovc.clientHeight)) {
      playbackOwns = true;
    } }

  const S = view.scale / dpr, OX = view.x / dpr, OY = view.y / dpr;
  const X = p => p * S + OX, Y = p => p * S + OY;

  if (!playbackOwns) {
    /* 参考层：图片素材叠加（不进图层/不写回/不导出） */
    { const rf = window.__fabulaReference;
      if (rf && rf.active && rf.active()) rf.draw(octx, X, Y, S, DW, DH); }

    if (antsReady) drawAnts(dpr);

    if (xf.on) drawXfHandles(X, Y);

    /* 正在拖的那条路径单独画（掩膜要等收笔才更新） */
    if (lassoCur && lassoCur.pts.length > 1) {
      octx.beginPath();
      octx.moveTo(X(lassoCur.pts[0].x), Y(lassoCur.pts[0].y));
      for (let i = 1; i < lassoCur.pts.length; i++) octx.lineTo(X(lassoCur.pts[i].x), Y(lassoCur.pts[i].y));
      octx.closePath();
      octx.lineWidth = 1;
      octx.setLineDash([]);
      octx.strokeStyle = 'rgba(0,0,0,.75)'; octx.stroke();
      octx.setLineDash([4, 4]);
      octx.lineDashOffset = -antsPhase;
      octx.strokeStyle = 'rgba(255,255,255,.95)'; octx.stroke();
      octx.setLineDash([]);
    }

    if (lastCursor.inside && !panActive && !xf.on) {
    /* 光标 = 实际笔刷形状：压扁比 / 倾角加宽与转向 / 扁笔尖锁定角全部实时反映，
       倾斜笔杆时光标会肉眼可见地变形——不再是一个看不出任何信息的圆圈 */
    const shp = cursorShape();
    const rx = Math.max(2, shp.rx * S), ry = Math.max(2, shp.ry * S);
    octx.save();
    octx.translate(X(lastCursor.x), Y(lastCursor.y));
    octx.rotate(shp.rot);
    octx.beginPath();
    if (shp.square) octx.rect(-rx, -ry, rx * 2, ry * 2);
    else octx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    octx.strokeStyle = 'rgba(0,0,0,.55)'; octx.lineWidth = 3; octx.setLineDash([]); octx.stroke();
    octx.strokeStyle = 'rgba(255,255,255,.85)'; octx.lineWidth = 1; octx.stroke();
    octx.restore();
  }
  } /* end if (!playbackOwns) */

  /* 界面已全部 DOM 化（montage 前端壳）：自绘工具条/色板/参数面板停用。
     drawUI/drawPanel 函数体保留待整体删除，这里不再调用。 */
}

/* ============================================================
   主循环
   ============================================================ */
let fpsT = performance.now(), fpsN = 0, fpsVal = 0;

function consumeInput() {
  if (!drawing || !inputQ.length) return;
  const stroke = isStrokeTool(tool);
  const dabs = [];
  const segs = [];
  while (inputQ.length) {
    const raw = inputQ.shift();
    const had = sm.ok;
    const prev = { x: sm.x, y: sm.y, p: strokeInfo.lastP, tl: strokeInfo.lastTl || 0 };
    const cur = stabilize(raw);
    cur.p = raw.p; cur.tl = raw.tl; cur.az = raw.az;
    if (!had) {
      /* 首点不立即落 dab：此刻还不知道运笔方向，画出来会是一帧
         "垂直于倾角方位"的错向笔头（扁笔尖在起笔处留一小条）。
         把起点存住，第一段方向出现时 emitDabs 自然从这个点开始产出，
         首帧方向与整笔锁定方向一致。纯点画在 endStroke 补画。 */
      if (stroke) strokeInfo.startPt = { x: cur.x, y: cur.y, p: cur.p, tl: cur.tl, az: cur.az };
    } else {
      if (stroke) emitDabs(prev, cur, dabs);
      else if (Math.hypot(cur.x - prev.x, cur.y - prev.y) > 0.6) segs.push([prev, cur]);
    }
    strokeInfo.lastP = cur.p;
    strokeInfo.lastTl = cur.tl;
    strokeInfo.lastSmoothed = { x: cur.x, y: cur.y };
  }
  if (dabs.length) { drawDabs(dabs); strokeInfo.dabs += dabs.length; }
  if (segs.length) {
    if (tool === 'smudge') updateBucket();
    for (const [a, b] of segs) {
      if (tool === 'smudge') runSmudge(a, b);
      else if (tool === 'blur') runBlur(a, b);
      else if (tool === 'warp') runWarp(a, b);
    }
    strokeInfo.segments += segs.length;
  }
}

/* 喷枪：笔停住不动也持续出墨。
   其它笔刷靠"位移"驱动 dab，而喷枪在物理上是按时间累积的 ——
   按住不动，颜料会一直堆在同一处，直到饱和。 */
function airbrushTick(dtMs) {
  if (!drawing || !P.airbrush || !isStrokeTool(tool)) return;
  airAcc += Math.max(0, P.airRate) * dtMs / 1000;
  let n = Math.floor(airAcc);
  if (n <= 0) return;
  airAcc -= n;
  if (n > 64) n = 64;
  const c = strokeInfo.lastSmoothed || { x: sm.x, y: sm.y };
  const dabs = [];
  for (let i = 0; i < n; i++) {
    dabs.push({ x: c.x, y: c.y, p: strokeInfo.lastP, tl: PEN.tilt, az: PEN.az, ang: 0 });
  }
  drawDabs(dabs);
  strokeInfo.dabs += n;
}

let lastFrameTs = 0;
function frame(ts) {
  const dt = lastFrameTs ? Math.min(80, ts - lastFrameTs) : 16;
  lastFrameTs = ts;

  consumeInput();
  airbrushTick(dt);

  present();

  antsPhase = (antsPhase + 0.5) % 16;
  drawOverlay();

  fpsN++;
  const now = performance.now();
  if (now - fpsT > 500) { fpsVal = Math.round(fpsN * 1000 / (now - fpsT)); fpsN = 0; fpsT = now; }
  requestAnimationFrame(frame);
}

/* ============================================================
   启动
   ============================================================ */
/* 引擎桥：镜头系统（shotEditor）用 —— 画布 ⇄ 镜头 PNG 的双向通道。
   载入 = 整幅替换当前图层并清撤销栈（每镜头是独立文档的语义）。 */
/* 偏好中的压感默认值（统一偏好存储，设置面板可调）——启动套用。
   参数面板里的改动是会话级（切工具/重启回到这里的默认），与 montage 的同语义。 */
(function applyPenPrefs() {
  try {
    const p = window.__fabulaPrefs;
    if (!p) return;
    const c = +p.get('penCurve'); if (c > 0) PEN.curve = c;
    const sm = +p.get('penSmooth'); if (sm >= 0) PEN.smooth = sm;
    const lo = +p.get('penPMin'); if (lo >= 0) PEN.pMin = lo;
    const hi = +p.get('penPMax'); if (hi > 0) PEN.pMax = hi;
    const sr = +p.get('penSpeedRef'); if (sr > 0) PEN.speedRef = sr;
  } catch (_) {}
})();

window.__fabulaEngine = {
  /* ---- DOM UI 桥（montage 前端壳）：参数定义的唯一来源仍在引擎内 ---- */
  TOOLS,
  UI_ACTIONS,
  tool: () => tool,
  setTool: (id) => setTool(id),
  onToolChange: null,                     // DOM 层赋值；setTool 结束时回调
  undo: () => doUndo(),
  redo: () => doRedo(),
  white: () => fillLayer(1, 1, 1, 1),
  clear: () => clearLayer(),
  fit: () => fitView(),
  zoom100: () => { const w = glc.width, h = glc.height; view.scale = 1; view.x = (w - DW) / 2; view.y = (h - DH) / 2; },
  getColor: () => color.slice(),
  setColor: (h) => { color = hexRgb(h); },
  SWATCHES,
  panelRows: () => panelRows(),
  fmtPanelVal,
  P,
  PEN,        // 压感设备参数（设置面板直接读写，立即生效）
  /* 重置某支笔刷：丢弃按笔记忆与会话缓存，重铺出厂预设（笔刷设置弹窗的「重置此笔刷」用） */
  resetBrush(id) {
    const bpId = id || tool;
    try {
      const p = window.__fabulaPrefs;
      const bp = p && p.get('brushParams');
      if (bp && bp[bpId]) {
        const next = Object.assign({}, bp);
        delete next[bpId];
        p.set('brushParams', next);
      }
    } catch (_) {}
    delete toolParams[bpId];
    if (bpId === tool) applyBrush(tool);
  },
  /* 当前图层导出为 PNG dataURL（白底合成，与 exportPNG 同一读回逻辑，不触发下载） */
  exportLayerPNG() {
    const buf = readLayerRGBA8();
    const out = document.createElement('canvas');
    out.width = DW; out.height = DH;
    const o2 = out.getContext('2d');
    const img = o2.createImageData(DW, DH);
    for (let y = 0; y < DH; y++) {
      const sy = DH - 1 - y;
      for (let x = 0; x < DW; x++) {
        const si = (sy * DW + x) * 4, di = (y * DW + x) * 4;
        const a = buf[si + 3] / 255;
        img.data[di] = Math.round(buf[si] + (1 - a) * 255);
        img.data[di + 1] = Math.round(buf[si + 1] + (1 - a) * 255);
        img.data[di + 2] = Math.round(buf[si + 2] + (1 - a) * 255);
        img.data[di + 3] = 255;
      }
    }
    o2.putImageData(img, 0, 0);
    return out.toDataURL('image/png');
  },
  /* 载入图片（URL）：contain 居中画到文档画幅，整幅替换图层；撤销栈清空 */
  loadLayerFromURL(url) {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = DW; cv.height = DH;
      const c2 = cv.getContext('2d');
      const s = Math.min(DW / img.width, DH / img.height);
      const w2 = img.width * s, h2 = img.height * s;
      c2.drawImage(img, (DW - w2) / 2, (DH - h2) / 2, w2, h2);
      const t = mkTex(DW, DH, gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      if (beginPass(paintCur)) {
        gl.useProgram(P_blit.p);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.uniform1i(P_blit.u.u_tex, 0);
        gl.uniform4f(P_blit.u.u_src, 0, 0, 1, 1);
        fsQuad();
      }
      gl.deleteTexture(t);
      clearTex(strokeTex);
      for (const e of undoStack) gl.deleteTexture(e.tex);
      for (const e of redoStack) gl.deleteTexture(e.tex);
      undoStack.length = 0; redoStack.length = 0; undoBytes = 0;
      strokeInfo.dirty = null;
      maskReset();
      fitView();
      updateStat();
    };
    img.src = url;
  },
  /* 顶栏"导出"按钮入口（复用既有导出管线） */
  exportPNG() { exportPNG(); },
  /* 清空画布（新空镜头开始画）；同样清撤销栈，避免跨镜头撤销 */
  clearForShot() {
    clearTex(paintCur); clearTex(paintAlt);
    clearTex(strokeTex); clearTex(fxTmp);
    for (const e of undoStack) gl.deleteTexture(e.tex);
    for (const e of redoStack) gl.deleteTexture(e.tex);
    undoStack.length = 0; redoStack.length = 0; undoBytes = 0;
    strokeInfo.dirty = null;
    maskReset();
    updateStat();
  },
};

/* 调试钩子：便于自动化验证和外部观察内部状态，不影响正常使用 */
window.__paintlab = {
  get stats() {
    return {
      tool,
      brushes: Object.keys(BRUSHES),
      precision: HAS_FLOAT ? 'RGBA16F' : 'RGBA8',
      dabs: strokeInfo.dabs,
      segments: strokeInfo.segments,
      points: strokeInfo.points,
      undo: undoStack.length,
      redo: redoStack.length,
      undoBytes,
      drawing,
      doc: [DW, DH],
      view: { scale: view.scale, x: view.x, y: view.y },
      pen: {
        mode: PEN.mode,
        lastType: PEN.lastType,
        pressureSeen: PEN.pressureSeen,
        sawTilt: PEN.sawTilt,
        maxDev: PEN.maxDev,
        minRaw: PEN.minRaw,
        maxRaw: PEN.maxRaw,
        pMin: PEN.pMin, pMax: PEN.pMax, curve: PEN.curve,
        lastP: PEN.lastShapeP,
      },
    };
  },
  resetCounters() { strokeInfo.dabs = 0; strokeInfo.segments = 0; strokeInfo.points = 0; },
  setTool,
  setParam(k, v) { if (k in P) P[k] = v; if (k in PEN) PEN[k] = v; },
  setColor(r, g, b) { color = [r, g, b]; },
  getParams() { return Object.assign({}, P); },
  seedRng,
  /* 恢复到出厂预设：自动化验证里，前面的测试会改乱参数 */
  applyBrush(id) { applyBrush(id); },
  /* 读回图层 alpha：自动化验证用，可以据此测线宽、纸纹方差、选区边界 */
  readAlpha(x0, y0, w, h) {
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    w = Math.max(1, Math.min(DW - x0, Math.round(w)));
    h = Math.max(1, Math.min(DH - y0, Math.round(h)));
    beginPass(exportTex);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, DW, DH);
    gl.useProgram(P_blit.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, paintCur);
    gl.uniform1i(P_blit.u.u_tex, 0);
    gl.uniform4f(P_blit.u.u_src, 0, 0, 1, 1);
    fsQuad();
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(x0, DH - y0 - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const a = new Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = buf[i * 4 + 3];
    /* raw 是原始 RGBA 字节。有些测试要测的是颜色（比如"涂抹把深色拖出去多远"），
       只看 alpha 是不够的 —— 铺了底色的画布上 alpha 恒为 255。 */
    return { x0, y0, w, h, alpha: a, raw: Array.from(buf) };
  },
  get penState() { return PEN; },
  get activePointer() { return activePointer; },
  /* 选区的真身是掩膜，不是某条路径。验证要断言"边界上的覆盖度等于掩膜值本身"，
     所以必须能把掩膜读回来。 */
  readMask(x0, y0, w, h) {
    const d = mctx.getImageData(x0, y0, w, h);
    const a = new Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = d.data[i * 4];
    return { x0, y0, w, h, mask: a };
  },
  readPreview,
  fillLayer,
  get selection() { return { dragging: !!lassoCur, antsReady }; },
  commitLasso, cancelLasso, invertMask,
  get xfState() {
    return { on: xf.on, ang: xf.ang, sx: xf.sx, sy: xf.sy, tx: xf.tx, ty: xf.ty,
             box: xf.box ? Object.assign({}, xf.box) : null };
  },
  xfBegin, xfCommit, xfCancel,
  /* 清空图层且不污染撤销栈：自动化验证里要反复重置画布，
     用界面上那个"清空"会让 39 步撤销把显存吃满 */
  wipe() {
    clearTex(paintCur); clearTex(paintAlt); clearTex(strokeTex); clearTex(fxTmp);
    for (const e of undoStack) gl.deleteTexture(e.tex);
    for (const e of redoStack) gl.deleteTexture(e.tex);
    undoStack.length = 0; redoStack.length = 0; undoBytes = 0;
    strokeInfo.dirty = null;
    updateStat();
  },
  /* 文档坐标 → 客户端坐标：自动化验证里要按文档坐标布置测试图案 */
  docToClient(x, y) {
    const r = glc.getBoundingClientRect();
    return {
      x: r.left + (x * view.scale + view.x) * (r.width / glc.width),
      y: r.top + (y * view.scale + view.y) * (r.height / glc.height),
    };
  },
  fitView,
  deselect: deselectAll,
};

function boot() {
  resize();
  fitView();
  maskReset();
  setTool('pen');
  updateStat();
  requestAnimationFrame(frame);
}
window.addEventListener('resize', () => {
  resize();
  const x1 = view.x + DW * view.scale, y1 = view.y + DH * view.scale;
  if (x1 < 0 || y1 < 0 || view.x > glc.width || view.y > glc.height) fitView();
});
boot();

})();
