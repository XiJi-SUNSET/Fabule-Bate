/* MCP server 端到端测试（H-2 归一后：面向 montage.json）：
   stdio NDJSON 协议、镜头读写（clip+board）、字段别名（notes→remark）、
   非对象消息防御（M-11）、原子写 + 锁不残留（M-2/M-3）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 1×1 透明 PNG（magic 校验用） */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const MINI_MONTAGE = {
  version: 4,
  name: '测试工程',
  fps: 24,
  boardW: 1280,
  boardH: 720,
  duration: 60,
  tracks: [
    { id: 'tr_board_1', name: '分镜 V1', kind: 'board', h: 78, muted: false, groupId: 'g_v1' },
    { id: 'tr_audio_1', name: '音频 A1', kind: 'audio', h: 62, muted: false, groupId: null },
  ],
  groups: [{ id: 'g_v1', name: '分镜 V1' }],
  clips: [],
  assets: [],
  boards: [],
};

function rpcClient(proc) {
  let buf = '';
  const waiters = [];
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      const w = waiters.shift();
      if (w) w(msg);
    }
  });
  return {
    send(obj) { proc.stdin.write(JSON.stringify(obj) + '\n'); },
    sendRaw(line) { proc.stdin.write(line + '\n'); },
    next() {
      return new Promise((res, rej) => {
        waiters.push(res);
        setTimeout(() => rej(new Error('等待 MCP 响应超时')), 8000);
      });
    },
  };
}

test('MCP 端到端：面向 montage.json 的镜头读写', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-test-'));
  fs.writeFileSync(path.join(dir, 'montage.json'), JSON.stringify(MINI_MONTAGE, null, 2), 'utf8');

  const proc = spawn(process.execPath, [path.join(root, 'agent/mcp-server.mjs'), '--project', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const c = rpcClient(proc);

    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const init = await c.next();
    assert.equal(init.result.serverInfo.name, 'fabula');

    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = await c.next();
    const names = tools.result.tools.map((t) => t.name);
    for (const n of ['add_shot', 'update_shot', 'delete_shot', 'set_shot_image', 'set_shot_order', 'get_project', 'list_shots']) {
      assert.ok(names.includes(n), '缺少工具 ' + n);
    }

    /* 非对象消息（M-11）：不应崩溃，后续 ping 仍要有响应 */
    c.sendRaw('null');
    c.sendRaw('[1,2,3]');
    c.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
    const pong = await c.next();
    assert.deepEqual(pong.result, {});

    /* add_shot：notes 是 remark 的别名；自动创建 board 画面位 */
    c.send({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'add_shot', arguments: { duration: 2.5, description: { content: '第一镜', notes: '测试备注' } } },
    });
    const added = await c.next();
    const shot = JSON.parse(added.result.content[0].text);
    assert.match(shot.id, /^cl_/);
    assert.match(shot.boardId, /^bd_/);
    assert.equal(shot.duration, 2.5);
    assert.equal(shot.start, 0);
    assert.equal(shot.content, '第一镜');
    assert.equal(shot.remark, '测试备注');            // notes → remark 映射

    /* set_shot_image：写入 boards/<boardId>.png */
    c.send({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'set_shot_image', arguments: { id: shot.id, imageBase64: PNG_1PX } },
    });
    const img = await c.next();
    const imgRes = JSON.parse(img.result.content[0].text);
    assert.equal(imgRes.image, 'boards/' + shot.boardId + '.png');
    assert.ok(fs.existsSync(path.join(dir, imgRes.image)), '帧文件应已写入');

    /* update_shot：duration 改 5 + 字段增量 */
    c.send({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'update_shot', arguments: { id: shot.id, duration: 5, description: { move: '横摇' } } },
    });
    const upd = await c.next();
    const updShot = JSON.parse(upd.result.content[0].text);
    assert.equal(updShot.duration, 5);
    assert.equal(updShot.move, '横摇');
    assert.equal(updShot.content, '第一镜');          // 增量合并：旧字段保留

    /* 磁盘：montage.json 上是 clips + boards（Agent 与 UI 同一份真相） */
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'montage.json'), 'utf8'));
    assert.equal(disk.clips.length, 1);
    assert.equal(disk.boards.length, 1);
    assert.equal(disk.clips[0].kind, 'board');
    assert.equal(disk.clips[0].meta.remark, '测试备注');
    assert.equal(disk.clips[0].dur, 5);
    assert.equal(disk.tracks.length, 2);              // 未知字段/结构原样保留
    assert.equal(disk.version, 4);

    /* get_project / list_shots 读数一致 */
    c.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_project', arguments: {} } });
    const proj = await c.next();
    assert.equal(JSON.parse(proj.result.content[0].text).shotCount, 1);

    /* set_shot_order：单镜头排列（幂等） */
    c.send({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'set_shot_order', arguments: { ids: [shot.id] } },
    });
    const ord = await c.next();
    assert.equal(JSON.parse(ord.result.content[0].text).order.length, 1);

    /* delete_shot：只删片段（board 保留在素材库） */
    c.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'delete_shot', arguments: { id: shot.id } } });
    const del = await c.next();
    assert.equal(JSON.parse(del.result.content[0].text).remaining, 0);
    const disk2 = JSON.parse(fs.readFileSync(path.join(dir, 'montage.json'), 'utf8'));
    assert.equal(disk2.clips.length, 0);
    assert.equal(disk2.boards.length, 1, 'board 应保留在素材库');

    /* 锁文件与 tmp 不残留 */
    assert.equal(fs.existsSync(path.join(dir, 'montage.json.lock')), false);
    assert.equal(fs.readdirSync(dir).some((f) => f.includes('.tmp-')), false);
  } finally {
    proc.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});
