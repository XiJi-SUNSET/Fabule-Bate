#!/usr/bin/env python3
"""Fabula Board · 故事板外挂审阅服务

Fabula 桌面端「发布到服务器」→ 本服务存储一份独立副本（json + 图片），
手机浏览器打开 /s/<secret>/ 浏览、替换某镜图片、记便签 —— 永不回写工程。

设计（对齐 Exterior / file-bridge 的运维模式）：
  · 单文件、零依赖（Python 标准库），内存占用小（ECS 仅 2GB）
  · 绑 127.0.0.1，公网走 Nginx 反代（80 → Anubis → Nginx → 本服务）
  · 访问控制 = secret 路径门：所有端点（页面/API/图片）校验 /s/<secret>/，
    恒定时间比较；错误 secret 一律 404（不泄露端点存在性）
  · 上传防护：体积上限 + 图片魔数校验 + 文件名白名单（仅 NN.png）
  · 数据原子落盘（tmp + rename）；发布时旧版自动备份为 board.json.bak

环境变量：
  FABULA_BOARD_PORT         监听端口（默认 8787）
  FABULA_BOARD_DATA         数据目录（默认 ./data）
  FABULA_BOARD_SECRET       固定 secret（省略则从 data/secret.txt 读；不存在则生成）
"""
import base64
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get('FABULA_BOARD_PORT', '8787'))
DATA_DIR = os.path.abspath(os.environ.get('FABULA_BOARD_DATA', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')))
SECRET_FILE = os.path.join(DATA_DIR, 'secret.txt')
IMG_DIR = os.path.join(DATA_DIR, 'img')
BOARD_FILE = os.path.join(DATA_DIR, 'board.json')

MAX_BODY = 24 * 1024 * 1024          # 单请求上限（客户端已压缩，留足余量）
MAX_IMG_BYTES = 8 * 1024 * 1024      # 单图上限
MAX_NOTE = 2000                      # 便签字数上限
MAX_SHOTS = 500

IMG_NAME_RE = re.compile(r'^\d{1,4}\.png$')     # 发布时按序号生成
# 编辑期图片名（替换空镜时生成 u<hex>.png）：字符白名单 + 无路径分隔 + 不以点开头
IMG_FILE_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.png$')


def img_content_type(buf):
    """按魔数给 MIME：客户端替换上传的是压缩后的 JPEG，但文件名统一 .png
       （nosniff 下内容与声明必须一致，否则浏览器可能拒绝渲染）。"""
    if buf[:8] == b'\x89PNG\r\n\x1a\n':
        return 'image/png'
    if buf[:3] == b'\xff\xd8\xff':
        return 'image/jpeg'
    if buf[:3] == b'GIF':
        return 'image/gif'
    if buf[:4] == b'RIFF' and buf[8:12] == b'WEBP':
        return 'image/webp'
    return 'application/octet-stream'

_lock = threading.Lock()


def load_secret():
    env = os.environ.get('FABULA_BOARD_SECRET', '')
    if env:
        return env.strip()
    try:
        with open(SECRET_FILE, 'r', encoding='utf-8') as f:
            s = f.read().strip()
            if s:
                return s
    except OSError:
        pass
    s = secrets.token_hex(16)
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SECRET_FILE, 'w', encoding='utf-8') as f:
        f.write(s + '\n')
    try:
        os.chmod(SECRET_FILE, 0o600)
    except OSError:
        pass
    return s


SECRET = load_secret()


def read_board():
    try:
        with open(BOARD_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp-' + str(os.getpid()) + '-' + str(int(time.time() * 1000))
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)


def write_board(obj):
    if os.path.exists(BOARD_FILE):
        try:
            with open(BOARD_FILE, 'rb') as f:
                write_atomic(BOARD_FILE + '.bak', f.read())
        except OSError:
            pass
    write_atomic(BOARD_FILE, json.dumps(obj, ensure_ascii=False, indent=1).encode('utf-8'))


def sniff_image(buf):
    """魔数校验：只放 PNG / JPEG / GIF / WebP"""
    if buf[:8] == b'\x89PNG\r\n\x1a\n':
        return True
    if buf[:3] == b'\xff\xd8\xff':
        return True
    if buf[:3] == b'GIF':
        return True
    if buf[:4] == b'RIFF' and buf[8:12] == b'WEBP':
        return True
    return False


def decode_data_url(data_url, max_bytes):
    """data:image/xxx;base64,.... → bytes；非法/超限返回 None"""
    if not isinstance(data_url, str) or not data_url.startswith('data:image/'):
        return None
    try:
        b64 = data_url.split(',', 1)[1]
        buf = base64.b64decode(b64, validate=True)
    except (IndexError, ValueError):
        return None
    if not buf or len(buf) > max_bytes or not sniff_image(buf):
        return None
    return buf


def sanitize_field(v):
    if v is None:
        return ''
    s = str(v)
    return s[:2000]


def new_shot_id():
    return 'u' + secrets.token_hex(4)


def ensure_ids(board):
    """旧数据补稳定 id（排序/删除后定位不再依赖序号）。返回是否发生过补写。"""
    changed = False
    for s in board.get('shots') or []:
        if isinstance(s, dict) and not s.get('id'):
            s['id'] = new_shot_id()
            changed = True
    return changed


def find_shot(board, body):
    """编辑类接口的定位：优先 id，兼容旧式 1-based no。"""
    sid = body.get('id')
    if isinstance(sid, str) and sid:
        for s in board.get('shots') or []:
            if s.get('id') == sid:
                return s
        return None
    no = clip_no(body.get('no'), 1, MAX_SHOTS)
    shots = board.get('shots') or []
    if no is not None and 1 <= no <= len(shots):
        return shots[no - 1]
    return None


def clip_no(v, lo, hi):
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if lo <= n <= hi else None


class Handler(BaseHTTPRequestHandler):
    server_version = 'FabulaBoard/1.0'
    protocol_version = 'HTTP/1.1'

    # ---------- 基础 ----------
    def log_message(self, fmt, *args):
        sys.stderr.write('[%s] %s\n' % (self.address_string(), fmt % args))

    @staticmethod
    def _norm_parts(path):
        """路径规范化：线上 Nginx 以 /fabula-board/ 前缀透传（proxy_pass 不剥前缀），
        本地直连则没有前缀 —— 两种形态在此归一。"""
        parts = path.split('/')
        if len(parts) > 1 and parts[1] == 'fabula-board':
            parts = [''] + parts[2:]
        return parts

    def _send(self, code, body, ctype='application/octet-stream', cache=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        if cache:
            self.send_header('Cache-Control', cache)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')

    def _not_found(self):
        self._json(404, {'error': 'not found'})

    def _check_secret(self, parts):
        """路径形如 ['', 's', <secret>, ...]。恒定时间比较；不通过返回 False。"""
        if len(parts) < 3 or parts[1] != 's':
            return False
        got = parts[2]
        return hmac.compare_digest(got, SECRET)

    def _read_json(self):
        try:
            n = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return None
        if n <= 0 or n > MAX_BODY:
            return None
        try:
            raw = self.rfile.read(n)
            return json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeDecodeError, OSError):
            return None

    # ---------- GET ----------
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/health':
            self._json(200, {'ok': True, 'service': 'fabula-board'})
            return
        parts = self._norm_parts(u.path)
        # 固定入口（不带密钥的地址，如 /fabula-board/）：门户页 —— 学 file-bridge 的
        # "固定首页 + 页面自持密钥"模式：页面本体不含任何数据，密钥输一次存 localStorage，
        # 之后打开同一个固定地址即直达最新内容（手机只需收藏这一个链接）。
        if len(parts) <= 2:
            self._send(200, PORTAL_HTML.encode('utf-8'), 'text/html; charset=utf-8', 'no-store')
            return
        if not self._check_secret(parts):
            self._not_found()
            return
        rest = parts[3:]
        if rest == [] or rest == ['']:
            # 页面不再内嵌密钥：API 基址由页面 location 推导（分享 HTML 也不泄密）
            self._send(200, PAGE_HTML.encode('utf-8'), 'text/html; charset=utf-8', 'no-store')
            return
        if rest == ['api', 'board']:
            b = read_board()
            if b is None:
                self._json(200, {'empty': True})
            else:
                # 旧数据（无稳定 id）首次读取即补写：页面的编辑操作依赖 id
                with _lock:
                    if ensure_ids(b):
                        try:
                            write_board(b)
                        except OSError:
                            pass
                self._json(200, b)
            return
        if len(rest) == 2 and rest[0] == 'img':
            name = rest[1]
            if not IMG_FILE_RE.match(name):
                self._not_found()
                return
            p = os.path.join(IMG_DIR, name)
            try:
                with open(p, 'rb') as f:
                    buf = f.read(MAX_IMG_BYTES)
            except OSError:
                self._not_found()
                return
            self._send(200, buf, img_content_type(buf), 'no-cache')
            return
        self._not_found()

    # ---------- POST ----------
    def do_POST(self):
        u = urlparse(self.path)
        parts = self._norm_parts(u.path)
        if not self._check_secret(parts):
            self._not_found()
            return
        rest = parts[3:]
        if rest == ['api', 'publish']:
            self._handle_publish()
        elif rest == ['api', 'replace']:
            self._handle_replace()
        elif rest == ['api', 'note']:
            self._handle_note()
        elif rest == ['api', 'shot', 'add']:
            self._handle_shot_add()
        elif rest == ['api', 'shot', 'remove']:
            self._handle_shot_remove()
        elif rest == ['api', 'shot', 'move']:
            self._handle_shot_move()
        elif rest == ['api', 'shot', 'update']:
            self._handle_shot_update()
        else:
            self._not_found()

    def _handle_publish(self):
        body = self._read_json()
        if body is None:
            self._json(400, {'error': 'bad json'})
            return
        shots_in = body.get('shots')
        if not isinstance(shots_in, list) or not (0 < len(shots_in) <= MAX_SHOTS):
            self._json(400, {'error': 'bad shots'})
            return
        with _lock:
            old = read_board() or {}
            old_list = old.get('shots') if isinstance(old.get('shots'), list) else []
            shots_out = []
            os.makedirs(IMG_DIR, exist_ok=True)
            for i, s in enumerate(shots_in, 1):
                if not isinstance(s, dict):
                    continue
                # 旧数据按"位置"匹配（网页端的便签/替换在重新发布时尽量保留；无法匹配则重来）
                keep = old_list[i - 1] if i - 1 < len(old_list) and isinstance(old_list[i - 1], dict) else None
                sid = (keep or {}).get('id') or new_shot_id()
                img = decode_data_url(s.get('img'), MAX_IMG_BYTES)
                name = '%02d.png' % i
                if img is not None:
                    write_atomic(os.path.join(IMG_DIR, name), img)
                    # 同名旧图若来自更早一次发布，首次见到时留一份 orig 备份
                    if old and not os.path.exists(os.path.join(IMG_DIR, '%02d.orig.png' % i)):
                        try:
                            with open(os.path.join(IMG_DIR, name), 'rb') as f:
                                write_atomic(os.path.join(IMG_DIR, '%02d.orig.png' % i), f.read())
                        except OSError:
                            pass
                    replaced = False
                    note = sanitize_field((keep or {}).get('note'))
                elif keep and keep.get('img'):
                    # 本次没带图（理论上发布都带）：沿用旧图与旧状态
                    name = str(keep.get('img'))[:96]
                    replaced = bool(keep.get('replaced'))
                    note = sanitize_field(keep.get('note'))
                else:
                    name = ''
                    replaced = False
                    note = sanitize_field(s.get('note'))
                fields = s.get('fields') if isinstance(s.get('fields'), dict) else {}
                shots_out.append({
                    'id': sid,
                    'dur': sanitize_field(s.get('dur'))[:32],
                    'fields': {str(k)[:32]: sanitize_field(v) for k, v in list(fields.items())[:24]},
                    'img': name,
                    'replaced': replaced,
                    'at': (keep or {}).get('at') if replaced else None,
                    'note': note,
                })
            board = {
                'name': sanitize_field(body.get('name'))[:120] or '故事板',
                'size': sanitize_field(body.get('size'))[:32],
                'updatedAt': int(time.time() * 1000),
                'shots': shots_out,
            }
            write_board(board)
        self._json(200, {'ok': True, 'shots': len(shots_out)})

    def _handle_replace(self):
        body = self._read_json()
        if body is None:
            self._json(400, {'error': 'bad json'})
            return
        img = decode_data_url(body.get('dataUrl'), MAX_IMG_BYTES)
        if img is None:
            self._json(400, {'error': 'bad image'})
            return
        with _lock:
            b = read_board()
            if b is None:
                self._json(404, {'error': 'board empty'})
                return
            ensure_ids(b)
            target = find_shot(b, body)
            if target is None:
                self._json(404, {'error': 'shot not found'})
                return
            # 图名跟随 img 字段（空镜替换时生成稳定的随机名，排序/删除后不再错位）
            name = str(target.get('img') or '')
            if not IMG_FILE_RE.match(name):
                name = 'u%s.png' % secrets.token_hex(4)
            cur = os.path.join(IMG_DIR, name)
            orig = os.path.join(IMG_DIR, (name[:-4] if name.endswith('.png') else name) + '.orig.png')
            if os.path.exists(cur) and not os.path.exists(orig):
                try:
                    with open(cur, 'rb') as f:
                        write_atomic(orig, f.read())
                except OSError:
                    pass
            write_atomic(cur, img)
            target['img'] = name
            target['replaced'] = True
            target['at'] = int(time.time() * 1000)
            write_board(b)
        self._json(200, {'ok': True})

    def _handle_note(self):
        body = self._read_json()
        if body is None:
            self._json(400, {'error': 'bad json'})
            return
        text = sanitize_field(body.get('text'))[:MAX_NOTE]
        with _lock:
            b = read_board()
            if b is None:
                self._json(404, {'error': 'board empty'})
                return
            ensure_ids(b)
            target = find_shot(b, body)
            if target is None:
                self._json(404, {'error': 'shot not found'})
                return
            target['note'] = text
            write_board(b)
        self._json(200, {'ok': True})

    # ---------- 分镜编辑（增删 / 排序 / 文案；全部只动服务器副本） ----------

    def _handle_shot_add(self):
        body = self._read_json() or {}
        after_id = body.get('afterId') if isinstance(body.get('afterId'), str) else None
        with _lock:
            b = read_board()
            if b is None or not isinstance(b.get('shots'), list):
                self._json(404, {'error': 'board empty'})
                return
            ensure_ids(b)
            shot = {'id': new_shot_id(), 'dur': '', 'fields': {}, 'img': '',
                    'replaced': False, 'at': None, 'note': ''}
            idx = len(b['shots'])
            if after_id:
                for i, s in enumerate(b['shots']):
                    if s.get('id') == after_id:
                        idx = i + 1
                        break
            b['shots'].insert(idx, shot)
            b['updatedAt'] = int(time.time() * 1000)
            write_board(b)
        self._json(200, {'ok': True, 'id': shot['id'], 'index': idx})

    def _handle_shot_remove(self):
        body = self._read_json() or {}
        sid = body.get('id')
        if not isinstance(sid, str) or not sid:
            self._json(400, {'error': 'bad id'})
            return
        with _lock:
            b = read_board()
            if b is None or not isinstance(b.get('shots'), list):
                self._json(404, {'error': 'board empty'})
                return
            ensure_ids(b)
            before = len(b['shots'])
            gone = next((s for s in b['shots'] if s.get('id') == sid), None)
            b['shots'] = [s for s in b['shots'] if s.get('id') != sid]
            if len(b['shots']) == before:
                self._json(404, {'error': 'shot not found'})
                return
            # 清理该分镜专属的图片文件（安全：文件名过白名单；不存在则忽略）
            img = str((gone or {}).get('img') or '')
            if img and IMG_FILE_RE.match(img):
                base = img[:-4] if img.lower().endswith('.png') else img
                for fn in (img, base + '.orig.png'):
                    try:
                        os.remove(os.path.join(IMG_DIR, fn))
                    except OSError:
                        pass
            b['updatedAt'] = int(time.time() * 1000)
            write_board(b)
        self._json(200, {'ok': True})

    def _handle_shot_move(self):
        body = self._read_json() or {}
        sid = body.get('id')
        d = body.get('dir')
        if not isinstance(sid, str) or d not in ('up', 'down'):
            self._json(400, {'error': 'bad args'})
            return
        with _lock:
            b = read_board()
            if b is None or not isinstance(b.get('shots'), list):
                self._json(404, {'error': 'board empty'})
                return
            ensure_ids(b)
            shots = b['shots']
            i = next((k for k, s in enumerate(shots) if s.get('id') == sid), -1)
            if i < 0:
                self._json(404, {'error': 'shot not found'})
                return
            j = i - 1 if d == 'up' else i + 1
            if 0 <= j < len(shots):
                shots[i], shots[j] = shots[j], shots[i]
            b['updatedAt'] = int(time.time() * 1000)
            write_board(b)
        self._json(200, {'ok': True})

    def _handle_shot_update(self):
        body = self._read_json() or {}
        fields = body.get('fields')
        if not isinstance(fields, dict):
            self._json(400, {'error': 'bad fields'})
            return
        with _lock:
            b = read_board()
            if b is None or not isinstance(b.get('shots'), list):
                self._json(404, {'error': 'board empty'})
                return
            ensure_ids(b)
            target = find_shot(b, body)
            if target is None:
                self._json(404, {'error': 'shot not found'})
                return
            nf = dict(target.get('fields') or {})
            for k, v in list(fields.items())[:24]:
                nf[str(k)[:32]] = sanitize_field(v)
            target['fields'] = nf
            if 'dur' in body:
                target['dur'] = sanitize_field(body.get('dur'))[:32]
            b['updatedAt'] = int(time.time() * 1000)
            write_board(b)
        self._json(200, {'ok': True})

    # ---------- 还原原图（可选能力） ----------
    def do_DELETE(self):
        u = urlparse(self.path)
        parts = self._norm_parts(u.path)
        if not self._check_secret(parts):
            self._not_found()
            return
        rest = parts[3:]
        if rest == ['api', 'replace']:
            body = self._read_json() or {}
            with _lock:
                b = read_board() or {'shots': []}
                ensure_ids(b)
                target = find_shot(b, body)
                if target is None:
                    self._json(404, {'error': 'shot not found'})
                    return
                img = str(target.get('img') or '')
                orig = os.path.join(IMG_DIR, img[:-4] + '.orig.png') if img.lower().endswith('.png') else ''
                if img and orig and os.path.exists(orig):
                    # 有发布原图备份：恢复它
                    try:
                        with open(orig, 'rb') as f:
                            write_atomic(os.path.join(IMG_DIR, img), f.read())
                    except OSError:
                        self._json(500, {'error': 'io'})
                        return
                    target['replaced'] = False
                    target['at'] = None
                else:
                    # 替换前本来就是空镜（无 orig）：退回空镜
                    target['img'] = ''
                    target['replaced'] = False
                    target['at'] = None
                write_board(b)
            self._json(200, {'ok': True})
            return
        self._not_found()


PORTAL_HTML = r'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1c1916">
<title>Fabula 故事板</title>
<style>
:root{--red:#eb684b;--red-rgb:235,104,75;--bg:#1c1916;--card:#282320;--line:rgba(255,255,255,.09);--tx:#efe7dd;--dim:#a89c90}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font:15px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.wrap{width:100%;max-width:360px}
.brand{font-size:22px;font-weight:650;letter-spacing:.5px}
.sub{color:var(--dim);font-size:12.5px;margin:2px 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 16px}
.t{font-size:14px;font-weight:600;margin-bottom:12px}
input{width:100%;height:40px;background:rgba(0,0,0,.3);border:1px solid var(--line);border-radius:9px;color:var(--tx);font:inherit;padding:0 12px;outline:none}
input:focus{border-color:rgba(var(--red-rgb),.6)}
button{width:100%;height:42px;margin-top:12px;background:var(--red);border:0;border-radius:10px;color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:active{opacity:.85}
.err{color:#ffb3a1;font-size:13px;margin-top:10px;min-height:18px}
.hint{color:var(--dim);font-size:12px;line-height:1.8;margin-top:12px}
#loading{color:var(--dim);text-align:center;padding:26px 0}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">Fabula</div>
  <div class="sub">故事板 · 手机端（固定入口）</div>
  <div class="card" id="form">
    <div class="t">输入访问密钥</div>
    <input id="key" type="password" placeholder="在 Fabula 发布弹窗里查看" autocomplete="off">
    <button id="go">进入</button>
    <div class="err" id="err"></div>
    <div class="hint">密钥只需输入一次。<br>本地址是固定入口，收藏它，每次打开直达最新发布。</div>
  </div>
  <div class="card" id="loading" style="display:none">正在进入…</div>
</div>
<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var STORE = 'fabulaBoardKey';
  function fail(msg){
    $('form').style.display = ''; $('loading').style.display = 'none';
    $('err').textContent = msg;
  }
  function enter(k){
    $('form').style.display = 'none';
    $('loading').style.display = '';
    fetch('./s/' + encodeURIComponent(k) + '/api/board').then(function(r){
      if (r.ok) {
        try { localStorage.setItem(STORE, k); } catch (e) {}
        location.replace('./s/' + encodeURIComponent(k) + '/');
      } else {
        fail('密钥不正确，请核对后重试');
      }
    }).catch(function(){ fail('连接失败，请稍后重试'); });
  }
  $('go').onclick = function(){ var v = $('key').value.trim(); if (v) enter(v); };
  $('key').addEventListener('keydown', function(e){ if (e.key === 'Enter') $('go').onclick(); });
  var saved = '';
  try { saved = localStorage.getItem(STORE) || ''; } catch (e) {}
  if (saved) enter(saved);      /* 已有密钥：打开固定地址即直达最新 */
  else $('key').focus();
})();
</script>
</body>
</html>
'''


PAGE_HTML = r'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1c1916">
<title>Fabula 故事板</title>
<style>
:root{--red:#eb684b;--red-rgb:235,104,75;--bg:#1c1916;--card:#282320;--line:rgba(255,255,255,.09);--tx:#efe7dd;--dim:#a89c90}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font:15px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;padding:14px 12px 40px;max-width:720px;margin:0 auto}
header{display:flex;align-items:baseline;gap:10px;margin:6px 2px 14px}
h1{font-size:19px;font-weight:650}
.meta{color:var(--dim);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:14px}
.imgw{position:relative;background:#fff}
.imgw img{display:block;width:100%;height:auto}
.badge{position:absolute;right:8px;top:8px;background:rgba(var(--red-rgb),.92);color:#fff;font-size:11px;padding:3px 9px;border-radius:99px}
.ph{height:180px;display:flex;align-items:center;justify-content:center;color:#8f8880;font-size:13px}
.hd{display:flex;justify-content:space-between;align-items:baseline;padding:10px 12px 4px;font-weight:650}
.hd .dur{font-weight:400;font-size:12px;color:var(--dim)}
.fields{padding:2px 12px 8px}
.frow{display:flex;gap:8px;font-size:13px;padding:3px 0}
.frow .k{flex:0 0 60px;color:var(--dim)}
.frow .v{flex:1;white-space:pre-wrap;word-break:break-word}
.note{margin:0 12px 10px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.04);border:1px dashed var(--line);font-size:13px;color:var(--dim)}
.note.has{color:var(--tx);border-style:solid;border-color:rgba(var(--red-rgb),.45)}
.ops{display:flex;gap:8px;padding:0 12px 12px}
.ops.sub{padding-top:0}
.btn{flex:1;height:38px;border:1px solid var(--line);border-radius:9px;background:rgba(255,255,255,.05);color:var(--tx);font:inherit;font-size:13.5px;cursor:pointer}
.btn.p{background:var(--red);border-color:var(--red);color:#fff;font-weight:600}
.btn.sm{height:32px;font-size:12.5px;border-radius:8px}
.btn.danger{color:#ffb3a1;border-color:rgba(var(--red-rgb),.45)}
.btn.big{height:44px;font-size:14px}
.btn:active{opacity:.85}
.edit{padding:2px 12px 8px}
.ef{display:block;margin:7px 0}
.ef span{display:block;font-size:12px;color:var(--dim);margin-bottom:3px}
.ef textarea{width:100%;background:rgba(0,0,0,.3);border:1px solid var(--line);border-radius:7px;color:var(--tx);font:inherit;font-size:13px;line-height:1.5;padding:6px 8px;resize:vertical;outline:none}
.ef textarea:focus{border-color:rgba(var(--red-rgb),.6)}
.addwrap{padding:2px 0 8px}
#toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#332c27;border:1px solid var(--line);color:var(--tx);padding:9px 16px;border-radius:9px;font-size:13px;max-width:86%;z-index:9;display:none}
#toast.err{border-color:rgba(var(--red-rgb),.7);color:#ffb3a1}
.empty{color:var(--dim);text-align:center;padding:48px 12px;font-size:14px;line-height:2}
footer{color:var(--dim);font-size:11.5px;text-align:center;margin-top:22px}
</style>
</head>
<body>
<header><h1 id="t">Fabula 故事板</h1><span class="meta" id="m"></span></header>
<div id="list"><div class="empty">加载中…</div></div>
<footer>Fabula · 外挂审阅副本（改动只存服务器，不影响工程）</footer>
<div id="toast"></div>
<input type="file" id="pick" accept="image/*" style="display:none">
<script>
(function(){
  /* API 基址从页面自身路径推导（补尾斜杠）：线上挂在 /fabula-board/ 前缀下、
     本地直连无前缀，两种形态都正确 —— 此前写死 '/s/...' 绝对路径，
     线上请求打到 Nginx 静态根（404 HTML 页），fetch 解析 JSON 爆
     "Unexpected token '<'"。 */
  var BASE = location.pathname.replace(/\/?$/, '/');
  var curId = '', curBtn = null;
  var FIELDS = ['画面内容','对白','音效','景别','运镜','焦段','转场','备注'];
  function $(id){ return document.getElementById(id); }
  var toastT = null;
  function toast(msg, bad){
    var t = $('toast'); t.textContent = msg; t.className = bad ? 'err' : ''; t.style.display = 'block';
    clearTimeout(toastT); toastT = setTimeout(function(){ t.style.display = 'none'; }, 2600);
  }
  function api(path, opt){
    return fetch(BASE + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opt || {}))
      .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }
  function compress(file, cb){
    var fr = new FileReader();
    fr.onload = function(){
      var im = new Image();
      im.onload = function(){
        var maxW = 1600, w = im.width, h = im.height;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(im, 0, 0, w, h);
        cb(c.toDataURL('image/jpeg', 0.86));
      };
      im.onerror = function(){ cb(null); };
      im.src = fr.result;
    };
    fr.onerror = function(){ cb(null); };
    fr.readAsDataURL(file);
  }
  var FIELDS8 = ['画面内容', '对白', '音效', '景别', '运镜', '焦段', '转场', '备注'];
  function mkBtn(label, cls, fn){
    var b = document.createElement('button');
    b.className = 'btn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.onclick = fn;
    return b;
  }
  function act(path, body, okMsg){
    api(path, { method: 'POST', body: JSON.stringify(body) })
      .then(function(){ toast(okMsg || '完成'); load(); })
      .catch(function(e){ toast('操作失败：' + e.message, true); });
  }
  function render(b){
    var shots = b.shots || [];
    $('t').textContent = b.name || '故事板';
    $('m').textContent = shots.length + ' 镜 · ' + new Date(b.updatedAt || Date.now()).toLocaleString('zh-CN');
    var list = $('list'); list.innerHTML = '';
    if (!shots.length) {
      list.innerHTML = '<div class="empty">服务器上还没有内容<br>在 Fabula 里点「发布到服务器」<br>或点下方「＋ 添加分镜」</div>';
    }
    shots.forEach(function(s, idx){
      var no = idx + 1;
      var card = document.createElement('div'); card.className = 'card';
      var imw = document.createElement('div'); imw.className = 'imgw';
      if (s.img) {
        var im = document.createElement('img');
        im.loading = 'lazy'; im.src = BASE + 'img/' + s.img + '?t=' + (s.at || b.updatedAt || 0);
        im.alt = '镜 ' + no;
        imw.appendChild(im);
      } else {
        var ph = document.createElement('div'); ph.className = 'ph'; ph.textContent = '（空镜 · 点「替换图」上传画面）';
        imw.appendChild(ph);
      }
      if (s.replaced) { var bd = document.createElement('span'); bd.className = 'badge'; bd.textContent = '已替换'; imw.appendChild(bd); }
      card.appendChild(imw);
      var hd = document.createElement('div'); hd.className = 'hd';
      hd.innerHTML = '<span>镜 ' + no + '</span><span class="dur">' + (s.dur || '') + '</span>';
      card.appendChild(hd);
      var fl = document.createElement('div'); fl.className = 'fields';
      var keys = Object.keys(s.fields || {});
      var shown = 0;
      keys.forEach(function(k){
        if (!s.fields[k]) return;
        shown++;
        var row = document.createElement('div'); row.className = 'frow';
        var kk = document.createElement('span'); kk.className = 'k'; kk.textContent = k;
        var vv = document.createElement('span'); vv.className = 'v'; vv.textContent = s.fields[k];
        row.appendChild(kk); row.appendChild(vv); fl.appendChild(row);
      });
      if (!shown) {
        var nf = document.createElement('div');
        nf.className = 'frow'; nf.style.color = 'var(--dim)'; nf.style.fontSize = '13px';
        nf.textContent = '（无描述 · 点「编辑文案」补充）';
        fl.appendChild(nf);
      }
      card.appendChild(fl);
      var note = document.createElement('div'); note.className = 'note' + (s.note ? ' has' : '');
      note.textContent = s.note ? ('便签：' + s.note) : '便签：点「想法」随手记一条';
      card.appendChild(note);
      /* 编辑区（默认隐藏） */
      var ed = document.createElement('div'); ed.className = 'edit'; ed.style.display = 'none';
      var tas = {};
      FIELDS8.forEach(function(label){
        var w = document.createElement('label'); w.className = 'ef';
        var t = document.createElement('span'); t.textContent = label;
        var ta = document.createElement('textarea'); ta.rows = 2;
        ta.value = (s.fields && s.fields[label]) || '';
        tas[label] = ta;
        w.appendChild(t); w.appendChild(ta); ed.appendChild(w);
      });
      var eops = document.createElement('div'); eops.className = 'ops';
      eops.appendChild(mkBtn('保存', 'p', function(){
        var o = {};
        FIELDS8.forEach(function(k){ o[k] = tas[k].value; });
        act('api/shot/update', { id: s.id, fields: o }, '已保存文案');
      }));
      eops.appendChild(mkBtn('取消', '', function(){ ed.style.display = 'none'; }));
      ed.appendChild(eops);
      card.appendChild(ed);
      /* 操作区两行：常用一行 + 结构编辑一行 */
      var ops = document.createElement('div'); ops.className = 'ops';
      var b1 = mkBtn('替换图', '', function(){ curId = s.id; curBtn = b1; $('pick').click(); });
      var b2 = mkBtn('想法', '', function(){
        var t = prompt('镜 ' + no + ' 的临时想法（只存服务器）', s.note || '');
        if (t === null) return;
        act('api/note', { id: s.id, text: t }, '已保存便签');
      });
      var b3 = mkBtn('编辑文案', '', function(){ ed.style.display = (ed.style.display === 'none') ? '' : 'none'; });
      var b4 = mkBtn('还原', '', function(){
        if (!confirm('退回发布时的原图？')) return;
        api('api/replace', { method: 'DELETE', body: JSON.stringify({ id: s.id }) })
          .then(function(){ toast('已还原'); load(); })
          .catch(function(e){ toast('还原失败：' + e.message, true); });
      });
      b4.style.display = s.replaced ? '' : 'none';
      ops.appendChild(b1); ops.appendChild(b2); ops.appendChild(b3); ops.appendChild(b4);
      card.appendChild(ops);
      var ops2 = document.createElement('div'); ops2.className = 'ops sub';
      ops2.appendChild(mkBtn('＋ 在其后插入', 'sm', function(){ act('api/shot/add', { afterId: s.id }, '已插入新分镜'); }));
      ops2.appendChild(mkBtn('↑ 上移', 'sm', function(){ act('api/shot/move', { id: s.id, dir: 'up' }, '已上移'); }));
      ops2.appendChild(mkBtn('↓ 下移', 'sm', function(){ act('api/shot/move', { id: s.id, dir: 'down' }, '已下移'); }));
      ops2.appendChild(mkBtn('删除', 'sm danger', function(){
        if (!confirm('删除镜 ' + no + '？（只删服务器副本）')) return;
        act('api/shot/remove', { id: s.id }, '已删除');
      }));
      card.appendChild(ops2);
      list.appendChild(card);
    });
    var addWrap = document.createElement('div'); addWrap.className = 'addwrap';
    addWrap.appendChild(mkBtn('＋ 添加分镜（追加到末尾）', 'p big', function(){ act('api/shot/add', {}, '已添加分镜'); }));
    list.appendChild(addWrap);
  }
  function load(){ api('api/board').then(render).catch(function(e){ toast('加载失败：' + e.message, true); }); }
  $('pick').addEventListener('change', function(){
    var f = this.files && this.files[0]; this.value = '';
    if (!f || !curId) return;
    if (curBtn) { curBtn.disabled = true; curBtn.textContent = '上传中…'; }
    compress(f, function(dataUrl){
      if (!dataUrl) { toast('图片读取失败', true); if (curBtn){ curBtn.disabled = false; curBtn.textContent = '替换图'; } return; }
      api('api/replace', { method: 'POST', body: JSON.stringify({ id: curId, dataUrl: dataUrl }) })
        .then(function(){ toast('已替换（仅服务器副本）'); load(); })
        .catch(function(e){ toast('替换失败：' + e.message, true); });
      setTimeout(function(){ if (curBtn){ curBtn.disabled = false; curBtn.textContent = '替换图'; } }, 1200);
    });
  });
  load();
})();
</script>
</body>
</html>
'''


def main():
    os.makedirs(IMG_DIR, exist_ok=True)
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    srv.daemon_threads = True
    sys.stderr.write('fabula-board listening on 127.0.0.1:%d  data=%s\n' % (PORT, DATA_DIR))
    sys.stderr.write('secret=%s\n' % SECRET)
    srv.serve_forever()


if __name__ == '__main__':
    main()
