/* 在独立 Electron 冒烟工程中执行，验证真实画布、保存 UI 与 DOM 接线。 */
(async function () {
  const M=window.MTG, E=window.__fabulaEngine, out={};
  const write=M.storage.writeFile;
  try {
    await window.fabula.project.create(window.__fabulaSmokeDir,'保存回归');
    M.audio.pause();M.board.resetCaches();M.assets.resetCaches();
    M.storage.mode='electron';M.storage.desktopRoot=window.__fabulaSmokeDir;
    M.state.project=M.newProject('保存回归');
    M.state.currentBoardId=null;M.state.playhead=0;M.state.dirty=false;
    M.board.unload();
    const p=M.state.project, track=p.tracks.find(t=>t.kind==='board');
    const a={id:'save-a',trackId:track.id,kind:'board',start:0,dur:3,meta:{}},
      b={id:'save-b',trackId:track.id,kind:'board',start:3,dur:3,meta:{}};
    p.clips.push(a,b);
    await M.board.createBlankBoard(a);await M.board.createBlankBoard(b);
    await M.board.loadFrame(a.boardId);M.render();await M.app.save();
    E.white('fg');
    const pixels=E.exportDataURL();
    M.storage.writeFile=async function(rel,blob) {
      if(rel.startsWith('boards/'))throw new Error('injected frame failure');
      return write.call(this,rel,blob);
    };
    try{await M.app.save();}catch(e){out.saveRejected=/injected/.test(e.message);}
    out.failedIndicator=document.getElementById('save-state').dataset.st==='failed';
    M.state.playhead=3.001;
    try{await M.board.syncToPlayhead();}catch(e){out.switchRejected=/injected/.test(e.message);}
    out.canvasKept=M.state.currentBoardId===a.boardId && E.exportDataURL()===pixels && M.board.dirty;
    M.storage.writeFile=write;
    await M.app.save();
    out.recovered=document.getElementById('save-state').dataset.st==='saved' && !M.state.dirty && !M.board.dirty;
    await M.assets.render();
    const item=()=>document.querySelector('[data-key="board:'+a.boardId+'"] .asset-thumb img');
    const before=item().src;
    E.clear('fg');await M.app.save();
    await M.assets.refreshBoardThumb(a.boardId);
    const cached=await M.board.thumbUrl(M.findBoard(a.boardId));
    out.thumbnailUpdated=item().src!==before && item().src===cached;
    M.timeline.render();
    const clip=document.querySelector('.clip[data-id="save-a"]');
    M.sheet.set(a,'size','特写');
    out.incrementalMeta=document.querySelector('.clip[data-id="save-a"]')===clip && clip.querySelector('.clip-label').textContent.includes('特写');
    M.state.selectedClipIds=new Set([b.id]);M.sheet.moveShot(-1);
    out.reorderAnchored=b.start===0 && a.start===3;
    await M.app.save();
    const disk=await M.storage.loadProject();
    out.diskCorrect=disk.clips.find(c=>c.id===b.id).start===0 && disk.clips.find(c=>c.id===a.id).meta.size==='特写';
  } catch(e) {out.error=e.stack||e.message;}
  finally {M.storage.writeFile=write;}
  return out;
})()
