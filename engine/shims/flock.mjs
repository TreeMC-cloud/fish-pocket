// iOS stand-in for @deepseek-ai/node-addon-system/flock (no native addon can
// load here). session-persistence-jsonl takes this lock to keep a second
// *process* from writing the same session; on iOS the engine is the only
// process that can open the app's container, and the in-process write claim
// already excludes every writer — the same reasoning as upstream's browser
// worker, which stubs this entry to immediate success.
export async function tryLockExclusive(fd) {
  if (!Number.isInteger(fd) || fd < 0) throw Object.assign(new TypeError(`invalid descriptor: ${fd}`), { code: 'EBADF', syscall: 'flock' });
}
