const ACTIONABLE_KINDS = new Set(['turns', 'repeat', 'compaction']);

/** Two-stage notice admission: actionable allowlist, then per-session cooldown. */
export function createNoticeAdmission({ cooldownMs = 10 * 60_000, now = Date.now } = {}) {
  const lastSent = new Map();
  return function admit(message) {
    if (!message || message.type !== 'dsh-ios/notice') return false;
    const kind = message.detail?.kind;
    if (!ACTIONABLE_KINDS.has(kind) || typeof message.message !== 'string' || !message.message.trim()) return false;

    const session = String(message.detail?.session ?? 'global');
    const key = `${session}:${kind}`;
    const time = now();
    const previous = lastSent.get(key);
    if (previous !== undefined && time - previous < cooldownMs) return false;
    lastSent.set(key, time);

    // Bound memory if the process has many short-lived sessions.
    if (lastSent.size > 256) {
      const cutoff = time - cooldownMs;
      for (const [entry, at] of lastSent) if (at < cutoff) lastSent.delete(entry);
      while (lastSent.size > 256) lastSent.delete(lastSent.keys().next().value);
    }
    return true;
  };
}
