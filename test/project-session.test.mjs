import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const session=require('../main/projectSession.cjs');
const format=require('../src/js/project-format.js');
const valid={version:4,name:'next',tracks:[],groups:[],assets:[],boards:[],clips:[],boardW:1280,boardH:720};

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fabula-session-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const state={root:'original'};
  const store={writeAtomic:fs.writeFileSync,openDir:dir=>{state.root=dir;return {root:dir};}};
  return {root,state,store};
}

test('损坏或未来版本的候选不改变活动目录和原文件', t => {
  const f=fixture(t), file=path.join(f.root,'montage.json');
  for(const content of ['{bad','null',JSON.stringify({...valid,version:99}),JSON.stringify({...valid,clips:'invalid'})]) {
    fs.writeFileSync(file,content);
    assert.throws(()=>session.prepare(f.root));
    assert.equal(f.state.root,'original'); assert.equal(fs.readFileSync(file,'utf8'),content);
  }
});

test('目录准备无写入，确认前外部变化会中止提交', t => {
  const f=fixture(t), file=path.join(f.root,'montage.json');
  fs.writeFileSync(file,JSON.stringify(valid));
  const candidate=session.prepare(f.root);
  assert.equal(f.state.root,'original'); assert.deepEqual(fs.readdirSync(f.root),['montage.json']);
  fs.writeFileSync(file,JSON.stringify({...valid,name:'external'}));
  assert.throws(()=>session.commit(candidate,JSON.stringify(valid),f.store),/外部修改/);
  assert.equal(f.state.root,'original');
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).name,'external');
});

test('新建候选写入失败不提交活动目录，成功后才打开', t => {
  const f=fixture(t), candidate=session.prepare(f.root);
  assert.throws(()=>session.commit(candidate,JSON.stringify(valid),{...f.store,writeAtomic(){throw new Error('disk full');}}),/disk full/);
  assert.equal(f.state.root,'original');
  const result=session.commit(candidate,JSON.stringify(valid),f.store);
  assert.equal(result.root,f.root); assert.equal(f.state.root,f.root);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'montage.json'),'utf8')).name,'next');
});

test('桌面准备、解析或确认失败时保留原存储目标；取消不提交', async () => {
  let candidate=null, commits=0, fail=false;
  const MTG={util:{},projectFormat:format,state:{},newProject:()=>structuredClone(valid),migrateProject:p=>p};
  const bridge={openDialog:async()=>candidate,commitOpen:async()=>{commits++;if(fail)throw new Error('changed');}};
  vm.runInNewContext(fs.readFileSync(new URL('../src/js/storage.js',import.meta.url),'utf8'),{window:{MTG,fabula:{project:bridge}},console});
  const S=MTG.storage;S.mode='electron';S.desktopRoot='old';S.dirName='old';
  assert.equal(await S.openFolder(),null);assert.equal(commits,0);
  candidate={root:'new',token:'x',montageText:'{bad'};
  await assert.rejects(S.openFolder());assert.equal(commits,0);assert.equal(S.desktopRoot,'old');
  candidate.montageText=JSON.stringify(valid);fail=true;
  await assert.rejects(S.openFolder(),/changed/);assert.equal(S.desktopRoot,'old');
  fail=false;const opened=await S.openFolder();assert.equal(S.desktopRoot,'new');assert.equal(opened.project.name,'next');
});
