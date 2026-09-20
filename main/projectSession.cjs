/* 工程目录事务：读取候选不会改变当前工程，确认时重新核对原文件。 */
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('../src/js/project-format.js');
const { normalizeProject, newProjectModel } = require('./projectModel.cjs');
function readOptional(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
function prepare(root) {
  root = path.resolve(root);
  const montageText = readOptional(path.join(root, 'montage.json'));
  const auxiliaryText = readOptional(path.join(root, 'fabula.json'));
  if (montageText !== null) parse(montageText);
  if (auxiliaryText !== null) normalizeProject(JSON.parse(auxiliaryText));
  return { root, montageText, auxiliaryText };
}
function commit(candidate, initialText, store) {
  const current = prepare(candidate.root);
  if (current.montageText !== candidate.montageText || current.auxiliaryText !== candidate.auxiliaryText) {
    throw new Error('候选工程已被外部修改，请重新打开');
  }
  if (candidate.montageText === null) {
    parse(initialText);
    store.writeAtomic(path.join(candidate.root, 'montage.json'), initialText);
  }
  if (candidate.auxiliaryText === null) {
    store.writeAtomic(path.join(candidate.root, 'fabula.json'), JSON.stringify(newProjectModel(path.basename(candidate.root)), null, 2));
  }
  return store.openDir(candidate.root);
}
module.exports = { prepare, commit };
