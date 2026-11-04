// git's output formats: dates, commit headers and pretty formats, decorations.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n, w = 2) => String(n).padStart(w, '0');

function tz(offset, colon = false) {
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${sign}${pad(Math.floor(abs / 60))}${colon ? ':' : ''}${pad(abs % 60)}`;
}

function relative(time, now = Date.now() / 1000) {
  const diff = Math.max(0, Math.round(now - time));
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (diff < 90) return plural(diff, 'second');
  const minutes = Math.round(diff / 60);
  if (minutes < 90) return plural(minutes, 'minute');
  const hours = Math.round(diff / 3600);
  if (hours < 36) return plural(hours, 'hour');
  const days = Math.round(diff / 86400);
  if (days < 14) return plural(days, 'day');
  if (days < 70) return plural(Math.round(days / 7), 'week');
  if (days < 365) return plural(Math.round(days / 30), 'month');
  const years = Math.floor(days / 365);
  const months = Math.round((days - years * 365) / 30);
  return months ? `${years} year${years === 1 ? '' : 's'}, ${months} month${months === 1 ? '' : 's'} ago` : plural(years, 'year');
}

/** A signature's date in one of git's --date modes. */
export function formatDate(sig, mode = 'default') {
  const d = new Date((sig.time + sig.offset * 60) * 1000);
  const Y = d.getUTCFullYear();
  const M = d.getUTCMonth();
  const D = d.getUTCDate();
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  switch (mode) {
    case 'iso':
    case 'iso8601': return `${Y}-${pad(M + 1)}-${pad(D)} ${time} ${tz(sig.offset)}`;
    case 'iso-strict':
    case 'iso8601-strict': return `${Y}-${pad(M + 1)}-${pad(D)}T${time}${tz(sig.offset, true)}`;
    case 'short': return `${Y}-${pad(M + 1)}-${pad(D)}`;
    case 'unix': return String(sig.time);
    case 'raw': return `${sig.time} ${tz(sig.offset)}`;
    case 'relative': return relative(sig.time);
    case 'rfc':
    case 'rfc2822': return `${DAYS[d.getUTCDay()]}, ${D} ${MONTHS[M]} ${Y} ${time} ${tz(sig.offset)}`;
    default: return `${DAYS[d.getUTCDay()]} ${MONTHS[M]} ${D} ${time} ${Y} ${tz(sig.offset)}`;
  }
}

/** Ref names pointing at each commit, for --decorate and %d. */
export function decorations(refsResult) {
  const byCommit = new Map();
  const add = (oid, name) => {
    if (!oid) return;
    if (!byCommit.has(oid)) byCommit.set(oid, []);
    byCommit.get(oid).push(name);
  };
  const head = refsResult.head;
  const order = (ref) => (ref.name.startsWith('refs/heads/') ? 0 : ref.name.startsWith('refs/remotes/') ? 1 : 2);
  const refs = refsResult.refs.filter((r) => r.name !== 'HEAD' && !r.name.startsWith('refs/stash')).sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  for (const ref of refs) {
    if (ref.name.startsWith('refs/heads/')) {
      const name = ref.name.slice(11);
      if (head.branch === name && !head.detached) continue;
      add(ref.commit ?? ref.oid, name);
    } else if (ref.name.startsWith('refs/remotes/')) {
      if (ref.symbolic) continue;
      add(ref.commit ?? ref.oid, ref.name.slice(13));
    } else if (ref.name.startsWith('refs/tags/')) {
      add(ref.commit ?? ref.oid, `tag: ${ref.name.slice(10)}`);
    }
  }
  if (head.oid) {
    const list = byCommit.get(head.oid) ?? [];
    byCommit.set(head.oid, [head.detached ? 'HEAD' : `HEAD -> ${head.branch}`, ...list]);
  }
  return byCommit;
}

const subjectOf = (message) => message.split('\n\n')[0].replace(/\n/g, ' ').trim();
const bodyOf = (message) => {
  const at = message.indexOf('\n\n');
  return at < 0 ? '' : message.slice(at + 2);
};

/** Expand a --format string for one commit. */
export function expandFormat(format, c, { decorated, dateMode = 'default' } = {}) {
  const sig = (s, key) => {
    switch (key) {
      case 'n': return s.name;
      case 'N': return s.name;
      case 'e': return s.email;
      case 'E': return s.email;
      case 'l': return s.email.split('@')[0];
      case 'd': return formatDate(s, dateMode);
      case 'D': return formatDate(s, 'rfc');
      case 'r': return formatDate(s, 'relative');
      case 't': return String(s.time);
      case 'i': return formatDate(s, 'iso');
      case 'I': return formatDate(s, 'iso-strict');
      case 's': return formatDate(s, 'short');
      default: return undefined;
    }
  };
  const names = decorated?.get(c.oid) ?? [];
  return format.replace(/%(x[0-9a-fA-F]{2}|[aAcC][a-zA-Z]|[HhTtPpsbBnmdD%]|[+-]?.)/g, (whole, key) => {
    if (key.startsWith('x')) return String.fromCharCode(parseInt(key.slice(1), 16));
    if (key[0] === 'a' || key[0] === 'c') {
      const value = sig(key[0] === 'a' ? c.author : c.committer, key[1]);
      if (value !== undefined) return value;
    }
    switch (key) {
      case 'H': return c.oid;
      case 'h': return c.short;
      case 'T': return c.tree;
      case 't': return c.tree.slice(0, 7);
      case 'P': return c.parents.join(' ');
      case 'p': return c.parents.map((p) => p.slice(0, 7)).join(' ');
      case 's': return subjectOf(c.message);
      case 'b': return bodyOf(c.message);
      case 'B': return c.message;
      case 'n': return '\n';
      case 'm': return '>';
      case 'd': return names.length ? ` (${names.join(', ')})` : '';
      case 'D': return names.join(', ');
      case '%': return '%';
      default: return whole;
    }
  });
}

const indent = (message) => message.replace(/\n+$/, '').split('\n').map((l) => `    ${l}`).join('\n');

/** A commit in one of the built-in pretty formats (medium by default). */
export function prettyCommit(c, pretty, { decorated, dateMode = 'default', label = 'commit' } = {}) {
  const names = decorated?.get(c.oid);
  const deco = names?.length ? ` (${names.join(', ')})` : '';
  if (pretty === 'oneline') return `${c.oid}${deco} ${subjectOf(c.message)}\n`;
  if (pretty === 'reference') return `${c.short} (${subjectOf(c.message)}, ${formatDate(c.author, 'short')})\n`;
  if (pretty === 'raw') {
    return `commit ${c.oid}\ntree ${c.tree}\n${c.parents.map((p) => `parent ${p}\n`).join('')}author ${c.author.name} <${c.author.email}> ${formatDate(c.author, 'raw')}\ncommitter ${c.committer.name} <${c.committer.email}> ${formatDate(c.committer, 'raw')}\n\n${indent(c.message)}\n`;
  }
  let out = `${label} ${c.oid}${deco}\n`;
  if (c.parents.length > 1) out += `Merge: ${c.parents.map((p) => p.slice(0, 7)).join(' ')}\n`;
  if (pretty === 'short') return `${out}Author: ${c.author.name} <${c.author.email}>\n\n${indent(subjectOf(c.message))}\n`;
  if (pretty === 'full' || pretty === 'fuller') {
    out += `Author:     ${c.author.name} <${c.author.email}>\n`;
    if (pretty === 'fuller') out += `AuthorDate: ${formatDate(c.author, dateMode)}\n`;
    out += `Commit:     ${c.committer.name} <${c.committer.email}>\n`;
    if (pretty === 'fuller') out += `CommitDate: ${formatDate(c.committer, dateMode)}\n`;
    return `${out}\n${indent(c.message)}\n`;
  }
  return `${out}Author: ${c.author.name} <${c.author.email}>\nDate:   ${formatDate(c.author, dateMode)}\n\n${indent(c.message)}\n`;
}

/** "--numstat"/"--name-status"/… lines for a diff op's files. */
export function diffLines(files, mode, { z = false } = {}) {
  const end = z ? '\0' : '\n';
  const sep = z ? '\0' : '\t';
  return files.map((f) => {
    const renamed = f.status === 'R' || f.status === 'C';
    if (mode === 'name-only') return `${f.new}${end}`;
    if (mode === 'name-status') {
      const code = renamed ? `${f.status}${String(f.similarity).padStart(3, '0')}` : f.status;
      return renamed ? `${code}${sep}${f.old}${sep}${f.new}${end}` : `${code}${sep}${f.status === 'D' ? f.old : f.new}${end}`;
    }
    if (mode === 'numstat') {
      const counts = f.binary ? '-\t-' : `${f.adds}\t${f.dels}`;
      if (!renamed) return `${counts}\t${f.new}${end}`;
      return z ? `${counts}\t\0${f.old}\0${f.new}\0` : `${counts}\t${renameArrow(f.old, f.new)}\n`;
    }
    // raw
    const modes = `:${octal(f.oldMode)} ${octal(f.newMode)} ${f.oldOid.slice(0, 7)} ${f.newOid.slice(0, 7)} `;
    const code = renamed ? `${f.status}${String(f.similarity).padStart(3, '0')}` : f.status;
    return renamed ? `${modes}${code}${sep}${f.old}${sep}${f.new}${end}` : `${modes}${code}${sep}${f.new}${end}`;
  }).join('');
}

export const octal = (mode) => mode.toString(8).padStart(6, '0');

/** git's compact rename notation: "dir/{a => b}/file" around common path components. */
export function renameArrow(from, to) {
  const a = from.split('/');
  const b = to.split('/');
  let p = 0;
  while (p < a.length - 1 && p < b.length - 1 && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - 1 - p && s < b.length - 1 - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (!p && !s) return `${from} => ${to}`;
  const pre = p ? `${a.slice(0, p).join('/')}/` : '';
  const post = s ? `/${a.slice(a.length - s).join('/')}` : '';
  return `${pre}{${a.slice(p, a.length - s).join('/')} => ${b.slice(p, b.length - s).join('/')}}${post}`;
}
