/* 保存协调器：所有需要完整保存结果的操作共用同一条队列。
   失败不阻断后续重试；exclusive 用于工程切换和外部同步。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.MTG.createSaveController = factory;
})(typeof window === 'undefined' ? globalThis : window, function (hooks) {
  'use strict';
  let tail = Promise.resolve();
  const operations = new Set();
  function track(task) {
    const job = Promise.resolve().then(task);
    operations.add(job);
    job.then(() => operations.delete(job), () => operations.delete(job));
    return job;
  }
  async function settle() {
    let failure;
    while (operations.size) {
      const results = await Promise.allSettled([...operations]);
      const rejected = results.find(r => r.status === 'rejected');
      if (rejected && !failure) failure = rejected.reason;
    }
    if (failure) throw failure;
  }
  function exclusive(task) {
    const job = tail.then(task);
    tail = job.catch(() => {});
    return job;
  }
  return {
    exclusive,
    track,
    settle,
    watch(object, names) {
      for (const name of names) {
        const method = object[name];
        object[name] = function (...args) { return track(() => method.apply(this, args)); };
      }
    },
    idle: () => tail,
    save(options = {}) {
      const project = hooks.project();
      return exclusive(async () => {
        if (!project) return;
        if (hooks.project() !== project) throw new Error('工程已切换，请保存当前工程');
        hooks.state('saving');
        try {
          let force = !!options.force;
          do {
            await settle();
            await hooks.flush();
            if (hooks.project() !== project) throw new Error('工程已切换，已停止旧工程保存');
            if (force || hooks.dirty()) await hooks.write(project);
            force = false;
          } while (hooks.dirty() || operations.size);
          hooks.state('saved');
        } catch (err) {
          hooks.state('failed', err);
          throw err;
        }
      });
    }
  };
});
