/* Home 启动器渲染端：最近项目列表 + 新建/打开。
   全部动作经 preload 的 fabula.launcher（主进程侧有安全门与对话框）。
   交互：双击打开 · 单击选中 · × 从列表移除。 */
const L = window.fabula.launcher;
const $ = (id) => document.getElementById(id);
const listEl = $('hm-list');

let toastTimer = null;
function toast(msg, bad) {
  const t = $('hm-toast');
  t.textContent = msg;
  t.classList.toggle('err', !!bad);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  if (d < 30 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
  const dt = new Date(ts);
  return dt.getFullYear() + '/' + (dt.getMonth() + 1) + '/' + dt.getDate();
}

let selRoot = null;

function render(items) {
  listEl.innerHTML = '';
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'hm-empty';
    e.textContent = '还没有工程记录。点下方「新建工程」开始，或「打开文件夹」选一个已有的 Fabula 工程。';
    listEl.appendChild(e);
    return;
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'rl-item' + (it.exists ? '' : ' missing') + (it.root === selRoot ? ' sel' : '');
    row.dataset.root = it.root;
    const name = document.createElement('div');
    name.className = 'rl-name';
    name.textContent = it.name || it.root;
    const meta = document.createElement('div');
    meta.className = 'rl-meta';
    const bits = [it.root];
    if (it.exists) bits.push((it.shots || 0) + ' 镜头');
    else bits.push('路径不存在');
    if (it.openedAt) bits.push(relTime(it.openedAt));
    meta.textContent = bits.join(' · ');
    meta.title = it.root;
    const x = document.createElement('button');
    x.className = 'rl-x';
    x.title = '从列表移除（不影响磁盘文件）';
    x.textContent = '×';
    x.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const items2 = await L.forget(it.root);
      if (selRoot === it.root) selRoot = null;
      render(items2);
    });
    row.appendChild(name);
    row.appendChild(meta);
    row.appendChild(x);

    row.addEventListener('click', () => {
      selRoot = it.root;
      for (const n of listEl.children) n.classList.toggle('sel', n.dataset && n.dataset.root === selRoot);
    });
    row.addEventListener('dblclick', async () => {
      if (!it.exists) { toast('该路径已不存在，可从列表移除（×）', true); return; }
      try {
        await L.open(it.root);      // 成功则主进程开主窗口并关掉本窗口
      } catch (e) {
        toast('打开失败：' + String((e && e.message) || e), true);
        refresh();
      }
    });
    listEl.appendChild(row);
  }
}

async function refresh() {
  try {
    const r = await L.list();
    $('hm-ver').textContent = 'v' + r.version;
    render(r.items || []);
  } catch (e) {
    toast('读取最近项目失败：' + String((e && e.message) || e), true);
  }
}

$('btn-new').addEventListener('click', async () => {
  try { await L.newProject(); } catch (e) { toast('新建失败：' + String((e && e.message) || e), true); }
});
$('btn-open').addEventListener('click', async () => {
  try { await L.openDialog(); } catch (e) { toast('打开失败：' + String((e && e.message) || e), true); }
});

refresh();
