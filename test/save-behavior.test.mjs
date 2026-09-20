import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const createSaveController = createRequire(import.meta.url)('../src/js/save-controller.js');
const load = (name, MTG, extra = {}) => vm.runInNewContext(fs.readFileSync(new URL('../src/js/' + name, import.meta.url), 'utf8'), {window: {MTG, ...extra}, console, Blob, URL, Uint8Array, setTimeout, clearTimeout});
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

test('JSON 保存期间的新编辑保持 dirty；保存旧工程不清新工程状态', async () => {
  const project = {name: 'before'};
  const M = {util:{}, state: {project, dirty:true, editRevision:1}, PROJECT_FILE:'montage.json'};
  load('storage.js', M);
  const g = gate(); let text;
  M.storage.writeFile = async (_, blob) => {text = await blob.text(); await g.promise;};
  const save = M.storage.saveProject(project);
  await new Promise(setImmediate);
  project.name = 'after'; M.state.editRevision++;
  g.resolve(); await save;
  assert.equal(JSON.parse(text).name, 'before'); assert.equal(M.state.dirty, true);
  await M.storage.saveProject(project); assert.equal(M.state.dirty, false);
  M.state.project = {}; M.state.dirty = true;
  await M.storage.saveProject(project); assert.equal(M.state.dirty, true);
});

function boardFixture(write) {
  const project = {tracks:[{id:'v1'}], clips:[{id:'c1',kind:'board',boardId:'b1',trackId:'v1',start:0,dur:3}]};
  const M = {util:{}, state:{project, currentBoardId:'b1'}, findBoard:id=>id ? {id,path:'boards/'+id+'.png'} : null,
    storage:{ready:true,writeFile:write}, toast(){}, audio:{playing:true,pause(){this.playing=false;}}};
  let exports=0;
  const engine = {commitStroke(){},exportBlob:async()=>new Blob([String(++exports)])};
  load('board.js', M, {__fabulaEngine:engine});
  M.testEngine = engine;
  M.board.dirty=true; M.board.revision=1;
  return M;
}

test('帧写入失败阻止切帧，保留 dirty 与当前画面', async () => {
  const M = boardFixture(async()=>{throw new Error('disk full');});
  M.board.clipAtPlayhead=()=>({boardId:'b2'});
  let restoredTime;
  M.setPlayhead = t => { restoredTime = t; };
  let changed=false;
  M.board.loadFrame=async()=>{changed=true;}; M.board.unload=()=>{changed=true;};
  await assert.rejects(M.board.syncToPlayhead(), /disk full/);
  assert.equal(changed,false); assert.equal(M.state.currentBoardId,'b1');
  assert.equal(M.board.dirty,true); assert.equal(M.audio.playing,false);
  assert.equal(restoredTime,0.001); assert.equal(M.board._frameBusy,0);
});

test('帧保存并发复用同一任务，期间新笔迹会补存', async () => {
  const g=gate(); const blobs=[]; let active=0,max=0;
  const M = boardFixture(async(_,blob)=>{max=Math.max(max,++active);blobs.push(await blob.text());if(blobs.length===1)await g.promise;active--;});
  const a=M.board.flush(), b=M.board.flush();
  assert.equal(a,b);
  await new Promise(setImmediate); M.board.revision++; M.board.dirty=true;
  g.resolve(); await Promise.all([a,b]);
  assert.deepEqual(blobs,['1','2']);assert.equal(max,1);assert.equal(M.board.dirty,false);
});

test('慢保存期间新起的笔画在切帧前提交并补存', async () => {
  const g=gate(), snapshots=[];
  const M=boardFixture(async(_,blob)=>{snapshots.push(await blob.text());if(snapshots.length===1)await g.promise;});
  let stroke=false,commits=0;
  M.testEngine.commitStroke=()=>{commits++;if(stroke){stroke=false;M.board.revision++;M.board.dirty=true;}};
  const save=M.board.flush();await new Promise(setImmediate);
  stroke=true;
  const switchingSave=M.board.flush();
  assert.equal(stroke,false,'复用已有保存也必须提交当前笔画');
  g.resolve();await Promise.all([save,switchingSave]);
  assert.equal(commits,2);assert.deepEqual(snapshots,['1','2']);assert.equal(M.board.dirty,false);
});

test('最终保存等待新建空帧编码、写盘与镜头登记完成', async () => {
  const shot={id:'c',kind:'board',trackId:'v1',start:0,dur:3};
  const project={boards:[],clips:[shot],tracks:[{id:'v1',kind:'board'}]};
  let encode, saved, finished=false;
  const M={util:{uid:()=> 'new-board'},state:{project,currentBoardId:null,playhead:0},
    storage:{ready:true,writeFile:async()=>{}},findBoard:()=>null,findTrack:()=>project.tracks[0],ensureTrackGroup:()=>null,
    markDirty(){this.state.dirty=true;},toast(){},render(){},setPlayhead(){}};
  const context={window:{MTG:M,__fabulaEngine:{commitStroke(){}}},document:{createElement:()=>({toBlob:cb=>{encode=cb;}})},console};
  vm.runInNewContext(fs.readFileSync(new URL('../src/js/board.js',import.meta.url),'utf8'),context);
  const c=createSaveController({project:()=>project,dirty:()=>!!M.state.dirty,flush:()=>M.board.flush(),state(){},
    async write(){saved=JSON.stringify(project);M.state.dirty=false;}});
  c.watch(M.board,['newFrame','createBlankBoard']);
  const edit=M.board.newFrame();await new Promise(setImmediate);
  const save=c.save().then(()=>{finished=true;});await new Promise(setImmediate);
  assert.equal(finished,false);assert.equal(saved,undefined);
  encode(new Blob(['png']));await edit;await save;
  assert.equal(JSON.parse(saved).boards.length,1);assert.equal(JSON.parse(saved).clips[0].boardId,'new-board');
});
