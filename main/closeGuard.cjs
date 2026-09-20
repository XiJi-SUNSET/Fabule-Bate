/* 关闭握手：只有保存成功或用户明确放弃才允许关闭。 */
module.exports = function createCloseGuard(hooks, timers = { setTimeout, clearTimeout }) {
  let serial = 0, pending = null, ready = false;
  function clear() {
    if (pending && pending.timer) timers.clearTimeout(pending.timer);
    pending = null;
  }
  function arm(request) {
    request.timer = timers.setTimeout(async () => {
      if (pending !== request) return;
      let answer;
      try { answer = await hooks.ask(); } catch (_) { answer = 'cancel'; }
      if (pending !== request) return;
      if (answer === 'discard') { clear(); ready = true; hooks.close(); }
      else if (answer === 'wait') arm(request);
      else { clear(); hooks.cancel(request.id); }
    }, 12000);
  }
  return {
    request() {
      if (ready) return false;
      if (pending) return true;
      const request = pending = { id: ++serial, timer: null };
      arm(request);
      hooks.save(request.id);
      return true;
    },
    complete(id, error) {
      if (!pending || pending.id !== id) return false;
      clear();
      if (error) { hooks.failed(error); return false; }
      ready = true; hooks.close(); return true;
    },
    dispose: clear
  };
};
