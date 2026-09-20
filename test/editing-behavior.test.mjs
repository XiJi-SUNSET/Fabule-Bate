import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function load(name,M,extra={}) {
  vm.runInNewContext(fs.readFileSync(new URL('../src/js/'+name,import.meta.url),'utf8'),{window:{MTG:M},console,URL,Blob,...extra});
}
function sheetFixture(clips) {
  const M={util:{},SHOT_FIELDS:[],state:{},findClip:id=>clips.find(c=>c.id===id),board:{orderedShots:()=>clips.slice().sort((a,b)=>a.start-b.start)},markDirty(){},render(){},toast(){}};
  load('sheet.js',M);return M;
}

test('上移、下移与拖拽换位均保持原轨起点', () => {
  for(const action of ['up','down','drop']) {
    const clips=[{id:'a',trackId:'v',start:5,dur:3},{id:'b',trackId:'v',start:8,dur:4}];
    const M=sheetFixture(clips);
    M.sheet.singleBoard=()=>clips[action==='down'?0:1];
    if(action==='drop')M.sheet.dropRow('b','a',false);
    else M.sheet.moveShot(action==='up'?-1:1);
    assert.deepEqual(clips.map(c=>c.start),[9,5],action);
  }
});

test('跨轨拖走首镜同时保持源轨与目标轨原起点', () => {
  const clips=[{id:'a',trackId:'v1',start:0,dur:3},{id:'b',trackId:'v1',start:3,dur:4},{id:'c',trackId:'v2',start:10,dur:2}];
  const M=sheetFixture(clips);M.sheet.dropRow('a','c',false);
  assert.deepEqual(clips.map(c=>[c.trackId,c.start]),[['v2',10],['v1',0],['v2',13]]);
});

test('分镜字段编辑只更新对应片段标签，不重建时间轴', () => {
  const M=sheetFixture([]), updated=[];
  M.timeline={refreshClipMeta:c=>updated.push(c.id),render(){throw new Error('不应全量重绘');}};
  const c={id:'a'};
  M.sheet.set(c,'dialogue','新对白');
  assert.equal(c.meta.dialogue,'新对白');assert.deepEqual(updated,['a']);
});

test('时间轴元数据刷新保留其它片段与波形节点', () => {
  const label={textContent:'old'}, other={textContent:'other'};
  const a={dataset:{id:'a'},querySelector:()=>label}, b={dataset:{id:'b'},querySelector:()=>other};
  const M={util:{tc:v=>String(v)},state:{}};
  load('timeline.js',M);
  M.timeline.el={tracks:{querySelectorAll:()=>[a,b]}};
  M.timeline._shotNo=new Map([['a',1]]);
  M.timeline.refreshClipMeta({id:'a',kind:'board',dur:3,meta:{size:'特写',dialogue:'你好'}});
  assert.match(label.textContent,/特写/);assert.match(a.title,/你好/);assert.equal(other.textContent,'other');
});

test('素材库与时间轴共用帧缓存；失效期间的旧请求不会回填旧帧', async () => {
  const M={util:{},state:{project:{}},storage:{ready:true}};
  load('board.js',M);load('assets.js',M);
  const pending=[];
  M.storage.readBlob=()=>new Promise(resolve=>pending.push(resolve));
  const board={id:'b',path:'boards/b.png',kind:'board',type:'board'};
  const first=M.board.thumbUrl(board), same=M.assets.thumb(board);
  assert.equal(pending.length,1);
  M.board.dropThumb('b');
  const latest=M.board.thumbUrl(board);
  assert.equal(pending.length,2);
  pending[1](new Blob(['new']));const url=await latest;
  pending[0](new Blob(['old']));
  assert.equal(await first,url);assert.equal(await same,url);
  assert.equal(await (await fetch(url)).text(),'new');
  assert.equal(M.assets.urlCache.has('b'),false);
  M.board.clearThumbnails();
});

test('切工程作废在途缩略图，不污染新工程相同 ID 缓存', async () => {
  const M={util:{},state:{project:{}},storage:{ready:true}};
  load('board.js',M);
  let finish;M.storage.readBlob=()=>new Promise(r=>{finish=r;});
  const request=M.board.thumbUrl({id:'b',path:'boards/b.png'});
  M.state.project={};M.board.clearThumbnails();
  finish(new Blob(['old']));assert.equal(await request,null);assert.equal(M.board.thumbCache.size,0);
});
