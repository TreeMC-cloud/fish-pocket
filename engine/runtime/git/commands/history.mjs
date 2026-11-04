// History commands: log, show, diff, rev-list, diff-tree, shortlog.
import fs from 'node:fs';
import path from 'node:path';
import { Exit, parseArgs } from '../core.mjs';
import { decorations, diffLines, expandFormat, formatDate, prettyCommit } from '../format.mjs';

/** Split arguments before `--` into revisions and paths, as git disambiguates them. */
async function revsAndPaths(git, args, rest) {
  const revs = [];
  const paths = [...(rest ?? [])];
  for (const a of args) {
    if (/\.\.|^\^|^--(all|branches|tags|remotes)/.test(a)) {
      revs.push(a);
      continue;
    }
    const [resolved] = await git.call('revparse', { spec: a }).catch(() => [null]);
    if (resolved && paths.length === 0) revs.push(a);
    else if (rest === undefined && !fs.existsSync(path.resolve(git.cwd, a))) {
      git.fatal(`ambiguous argument '${a}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
    } else paths.push(a);
  }
  return { revs, paths };
}

/** "2 weeks ago", "yesterday", ISO dates → unix seconds. */
function approxDate(text) {
  const now = Date.now() / 1000;
  const units = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };
  const m = /^(\d+)[ .]?(second|minute|hour|day|week|month|year)s?(?:[ .]ago)?$/i.exec(text.trim());
  if (m) return Math.floor(now - Number(m[1]) * units[m[2].toLowerCase()]);
  if (/^yesterday$/i.test(text)) return Math.floor(now - 86400);
  if (/^(today|now)$/i.test(text)) return Math.floor(now);
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

const DIFF_OPTIONS = {
  'p|u|patch': 'bool', 's|no-patch': 'bool', 'stat': 'optional', 'shortstat': 'bool', 'numstat': 'bool',
  'name-only': 'bool', 'name-status': 'bool', 'raw': 'bool', 'summary': 'bool', 'U|unified': 'value',
  'w|ignore-all-space': 'bool', 'b|ignore-space-change': 'bool', 'M|find-renames': 'optional', 'no-renames': 'bool',
  'color': 'optional', 'no-color': 'bool', 'a|text': 'bool', 'binary': 'bool', 'diff-filter': 'value', 'R': 'bool',
  'full-index': 'bool', 'abbrev': 'optional', 'no-ext-diff': 'bool', 'ext-diff': 'bool', 'textconv': 'bool',
  'z': 'bool', 'inter-hunk-context': 'value', 'ignore-blank-lines': 'bool', 'patch-with-stat': 'bool',
  'minimal': 'bool', 'patience': 'bool', 'histogram': 'bool', 'diff-algorithm': 'value', 'relative': 'optional',
  'ignore-cr-at-eol': 'bool', 'C|find-copies': 'optional', 'irreversible-delete': 'bool', 'D': 'bool',
  'src-prefix': 'value', 'dst-prefix': 'value', 'no-prefix': 'bool', 'word-diff': 'optional', 'color-words': 'optional',
  'dirstat': 'optional', 'compact-summary': 'bool', 'check': 'bool', 'ignore-submodules': 'optional', 'submodule': 'optional',
  'G': 'value', 'S': 'value',
};

function diffArgs(opts) {
  return {
    context: opts.unified,
    interhunk: opts['inter-hunk-context'],
    renames: !opts['no-renames'],
    ignoreWhitespace: opts['ignore-all-space'],
    ignoreWhitespaceChange: opts['ignore-space-change'],
    text: opts.text,
    binary: opts.binary,
    reverse: opts.R,
  };
}

function checkDiffSupport(git, opts) {
  if (opts['word-diff'] || opts['color-words']) git.unsupported('--word-diff');
  if (opts['no-prefix'] || opts['src-prefix'] || opts['dst-prefix']) git.unsupported('custom diff prefixes');
  if (opts.G || opts.S) git.unsupported('pickaxe (-S/-G)');
}

/** Keep only files whose status letter passes --diff-filter (upper: include, lower: exclude). */
function filterFiles(files, filter) {
  if (!filter) return files;
  const include = filter.replace(/[a-z]/g, '');
  const exclude = filter.replace(/[A-Z*]/g, '').toUpperCase();
  return files.filter((f) => (!include || include.includes(f.status)) && !exclude.includes(f.status));
}

/** Diff text for a resolved comparison, in whatever formats the options ask for. */
async function renderDiff(git, request, opts, { defaultPatch = true } = {}) {
  const wantsStat = opts.stat || opts['patch-with-stat'];
  const summaryOnly = opts.shortstat || opts.numstat || opts['name-only'] || opts['name-status'] || opts.raw || opts.summary || wantsStat;
  const patch = !opts['no-patch'] && (opts.patch || opts['patch-with-stat'] || (defaultPatch && !summaryOnly));
  let base = { ...request, ...diffArgs(opts) };
  let d = await git.call('diff', { ...base, patch, stat: wantsStat, shortstat: opts.shortstat, summary: opts.summary }).catch((e) => git.failOp(e));
  if (opts['diff-filter']) {
    const files = filterFiles(d.files, opts['diff-filter']);
    if (files.length !== d.files.length) {
      const paths = [...new Set(files.flatMap((f) => [f.old, f.new]))];
      if (!paths.length) return { text: '', files };
      base = { ...base, path: paths, literal: true };
      d = await git.call('diff', { ...base, patch, stat: wantsStat, shortstat: opts.shortstat, summary: opts.summary });
      d.files = files;
    }
  }
  const z = opts.z;
  let text = '';
  if (opts.raw) text += diffLines(d.files, 'raw', { z });
  if (opts.numstat) text += diffLines(d.files, 'numstat', { z });
  if (opts['name-only']) text += diffLines(d.files, 'name-only', { z });
  if (opts['name-status']) text += diffLines(d.files, 'name-status', { z });
  if (wantsStat || opts.shortstat || opts.summary) text += d.stat ?? '';
  if (patch) text += (text && d.patch ? '\n' : '') + (d.patch ?? '');
  return { text, files: d.files };
}

async function diff(git, argv) {
  const { opts, args, rest } = parseArgs(git, argv, {
    ...DIFF_OPTIONS, 'cached|staged': 'bool', 'quiet': 'bool', 'exit-code': 'bool', 'no-index': 'bool', 'merge-base': 'bool',
  });
  checkDiffSupport(git, opts);
  if (opts['no-index']) git.unsupported('diff --no-index');
  const { revs, paths: specs } = await revsAndPaths(git, args, rest);
  const paths = await git.pathspecs(specs);
  let request;
  const range = revs.length === 1 && /^(.*?)(\.\.\.?)(.*)$/.exec(revs[0]);
  if (range) {
    let [, from, dots, to] = range;
    from ||= 'HEAD';
    to ||= 'HEAD';
    if (dots === '...') from = (await git.call('merge-base', { spec: [from, to] }).catch((e) => git.failOp(e))).oid;
    request = { mode: 'trees', from, to };
  } else if (revs.length >= 2) {
    request = { mode: 'trees', from: revs[0], to: revs[1] };
  } else if (opts.cached) {
    request = { mode: 'cached', from: revs[0] };
  } else if (revs.length === 1) {
    request = { mode: 'tree-workdir', from: revs[0] };
  } else {
    request = { mode: 'workdir' };
  }
  const { text, files } = await renderDiff(git, { ...request, path: paths, literal: git.literal }, opts);
  if (!opts.quiet) git.print(text);
  if ((opts.quiet || opts['exit-code']) && files.length) throw new Exit(1);
}

const LOG_OPTIONS = {
  ...DIFF_OPTIONS,
  'n|max-count': 'value', 'skip': 'value', 'oneline': 'bool', 'pretty': 'optional', 'format': 'value',
  'abbrev-commit': 'bool', 'no-abbrev-commit': 'bool', 'decorate': 'optional', 'no-decorate': 'bool', 'graph': 'bool',
  'all': 'bool', 'branches': 'optional', 'tags': 'optional', 'remotes': 'optional', 'reverse': 'bool',
  'first-parent': 'bool', 'author': 'value', 'committer': 'value', 'grep': 'value', 'i|regexp-ignore-case': 'bool',
  'since|after': 'value', 'until|before': 'value', 'date': 'value', 'no-merges': 'bool', 'merges': 'bool',
  'follow': 'bool', 'relative-date': 'bool', 'topo-order': 'bool', 'date-order': 'bool', 'author-date-order': 'bool',
  'no-walk': 'optional', 'L': 'value', 'mailmap': 'bool', 'use-mailmap': 'bool', 'source': 'bool', 'cc': 'bool',
  'm': 'bool', 'c': 'bool', 'no-notes': 'bool', 'show-signature': 'bool', 'left-right': 'bool', 'boundary': 'bool',
  'ancestry-path': 'bool', 'simplify-by-decoration': 'bool', 'full-history': 'bool', 'no-max-parents': 'bool',
  'min-parents': 'value', 'max-parents': 'value', 'exclude': 'value', 'count': 'bool', 'objects': 'bool',
};

/** Pull `-<n>` (max count) out of a log-style argument list. */
function numericCount(argv) {
  const out = [];
  let max;
  for (const a of argv) {
    if (/^-\d+$/.test(a)) max = a.slice(1);
    else out.push(a);
  }
  return { argv: out, max };
}

async function walk(git, opts, args, rest) {
  if (opts.L) git.unsupported('log -L');
  const { revs, paths: specs } = await revsAndPaths(git, args, rest);
  for (const flag of ['all', 'branches', 'tags', 'remotes']) {
    if (!opts[flag]) continue;
    const glob = { all: '--all', branches: 'refs/heads/*', tags: 'refs/tags/*', remotes: 'refs/remotes/*' }[flag];
    revs.push(flag === 'all' ? '--all' : `--glob=${typeof opts[flag] === 'string' ? `refs/${flag === 'branches' ? 'heads' : flag}/${opts[flag]}` : glob}`);
  }
  const paths = await git.pathspecs(specs);
  const since = opts.since && approxDate(opts.since);
  const until = opts.until && approxDate(opts.until);
  let commits;
  try {
    commits = await git.call('log', {
      rev: revs, path: paths, max: opts.reverse ? undefined : opts['max-count'], skip: opts.skip,
      firstParent: opts['first-parent'], author: opts.author, grep: opts.grep, since, until,
      minParents: opts.merges ? 2 : opts['min-parents'], maxParents: opts['no-merges'] ? 1 : opts['max-parents'],
    });
  } catch (error) {
    if (error.kind === 'unborn') {
      const repo = await git.repo();
      git.fatal(`your current branch '${repo.head.branch}' does not have any commits yet`);
    }
    git.failOp(error);
  }
  if (opts.reverse) {
    commits.reverse();
    if (opts['max-count'] !== undefined) commits = commits.slice(-Number(opts['max-count'])).slice(0);
  }
  return commits;
}

async function log(git, argv, { label = 'commit' } = {}) {
  const pre = numericCount(argv);
  const { opts, args, rest } = parseArgs(git, pre.argv, LOG_OPTIONS);
  if (pre.max !== undefined) opts['max-count'] = pre.max;
  checkDiffSupport(git, opts);
  const commits = await walk(git, opts, args, rest);
  await printCommits(git, commits, opts, { label });
}

async function printCommits(git, commits, opts, { label = 'commit', defaultPatch = false, single = false } = {}) {
  const dateMode = opts['relative-date'] ? 'relative' : opts.date ?? 'default';
  const decorate = opts.decorate !== undefined ? opts.decorate !== false : false;
  const needsRefs = decorate || /%d|%D/.test(opts.format ?? (typeof opts.pretty === 'string' ? opts.pretty : ''));
  const decorated = needsRefs ? decorations(await git.call('refs')) : undefined;
  let format = opts.format;
  let pretty = typeof opts.pretty === 'string' ? opts.pretty : 'medium';
  let separator = false;
  if (pretty.startsWith('format:')) {
    format = pretty.slice(7);
    separator = true;
  } else if (pretty.startsWith('tformat:')) {
    format = pretty.slice(8);
  } else if (pretty.includes('%')) {
    format = pretty;
  }
  if (format?.startsWith('tformat:')) format = format.slice(8);
  else if (format?.startsWith('format:')) {
    format = format.slice(7);
    separator = true;
  }
  if (opts.oneline) pretty = 'oneline';
  const abbrev = opts.oneline ? opts['abbrev-commit'] !== false : opts['abbrev-commit'];
  const wantsDiff = opts.patch || opts.stat || opts.shortstat || opts.numstat || opts['name-only'] || opts['name-status'] || opts.raw || opts.summary || opts['patch-with-stat'];
  const graph = opts.graph;
  const out = [];
  for (const [i, c] of commits.entries()) {
    let text;
    const shown = abbrev ? { ...c, oid: c.short } : c;
    if (format !== undefined) {
      text = expandFormat(format, c, { decorated, dateMode });
      text += separator ? (i < commits.length - 1 ? '\n' : '') : '\n';
    } else if (pretty === 'oneline') {
      const deco = decorated?.get(c.oid);
      text = `${abbrev ? c.short : c.oid}${deco?.length ? ` (${deco.join(', ')})` : ''} ${c.message.split('\n\n')[0].replace(/\n/g, ' ').trim()}\n`;
    } else {
      text = prettyCommit(shown, pretty, { decorated: decorated && new Map([[shown.oid, decorated.get(c.oid) ?? []]]), dateMode, label });
    }
    // Merges: no combined diff (git's --cc); `show --stat` and friends compare with the first parent.
    const statsOnly = !opts.patch && (opts.stat || opts.shortstat || opts.numstat || opts['name-only'] || opts['name-status']);
    if ((wantsDiff || (defaultPatch && !opts['no-patch'])) && (c.parents.length <= 1 || (single && statsOnly))) {
      const request = { mode: 'trees', from: c.parents[0] ?? '', to: c.oid };
      const { text: diffText } = await renderDiff(git, request, opts, { defaultPatch });
      if (diffText) {
        const compact = pretty === 'oneline' || format !== undefined;
        text += compact ? diffText : `\n${diffText}`;
      }
    }
    if (graph) text = text.replace(/\n$/, '').split('\n').map((l, k) => (k === 0 ? `* ${l}` : `| ${l}`)).join('\n') + '\n';
    const between = !single && i > 0 && pretty !== 'oneline' && format === undefined ? (graph ? '|\n' : '\n') : '';
    out.push(between + text);
  }
  git.print(out.join(''));
}

function parseTag(raw) {
  const text = raw.toString('utf8');
  const split = text.indexOf('\n\n');
  const headers = Object.fromEntries(text.slice(0, split < 0 ? text.length : split).split('\n').map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]));
  const tagger = /^(.*) <(.*)> (\d+) ([+-])(\d\d)(\d\d)$/.exec(headers.tagger ?? '');
  return {
    object: headers.object,
    type: headers.type,
    tag: headers.tag,
    tagger: tagger && { name: tagger[1], email: tagger[2], time: Number(tagger[3]), offset: (tagger[4] === '-' ? -1 : 1) * (Number(tagger[5]) * 60 + Number(tagger[6])) },
    message: split < 0 ? '' : text.slice(split + 2),
  };
}

async function show(git, argv) {
  const { opts, args, rest } = parseArgs(git, argv, LOG_OPTIONS);
  checkDiffSupport(git, opts);
  const specs = args.length ? args : ['HEAD'];
  if (rest?.length) git.unsupported('show with pathspecs');
  for (const [i, spec] of specs.entries()) {
    let object;
    try {
      object = await git.call('cat', { spec });
    } catch (error) {
      if (error.kind === 'badrev') {
        const at = spec.indexOf(':');
        if (at > 0) git.fatal(`path '${spec.slice(at + 1)}' does not exist in '${spec.slice(0, at)}'`);
        git.fatal(`ambiguous argument '${spec}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
      }
      git.failOp(error);
    }
    const { value, data } = object.value ? object : { value: object };
    if (i > 0) git.print('\n');
    if (value.type === 'blob') {
      git.print(data.toString('utf8'));
    } else if (value.type === 'tree') {
      git.print(`tree ${spec}\n\n${value.entries.map((e) => `${e.name}${e.type === 'tree' ? '/' : ''}\n`).join('')}`);
    } else if (value.type === 'tag') {
      const tag = parseTag(data);
      git.print(`tag ${tag.tag}\nTagger: ${tag.tagger.name} <${tag.tagger.email}>\nDate:   ${formatDate(tag.tagger, opts.date)}\n\n${tag.message.replace(/\n*$/, '\n')}\n`);
      if (tag.type === 'commit') {
        const commits = await git.call('log', { rev: tag.object, max: 1 });
        await printCommits(git, commits, opts, { defaultPatch: true, single: true });
      }
    } else {
      const commits = await git.call('log', { rev: value.oid, max: 1 });
      await printCommits(git, commits, opts, { defaultPatch: true, single: true });
    }
  }
}

async function revList(git, argv) {
  const pre = numericCount(argv);
  const { opts, args, rest } = parseArgs(git, pre.argv, LOG_OPTIONS);
  if (pre.max !== undefined) opts['max-count'] = pre.max;
  if (opts.objects) git.unsupported('rev-list --objects');
  if (opts['left-right'] && opts.count) {
    const range = args.length === 1 && /^(.+?)\.\.\.(.+)$/.exec(args[0]);
    if (!range) git.fatal('--left-right --count needs a symmetric range (A...B)');
    const left = await git.call('log', { rev: [range[1], `^${range[2]}`] }).catch((e) => git.failOp(e));
    const right = await git.call('log', { rev: [range[2], `^${range[1]}`] }).catch((e) => git.failOp(e));
    git.print(`${left.length}\t${right.length}\n`);
    return;
  }
  const commits = await walk(git, opts, args, rest);
  if (opts.count) git.print(`${commits.length}\n`);
  else if (opts.format || opts.pretty || opts.oneline) await printCommits(git, commits, opts, { label: 'commit' });
  else git.print(commits.map((c) => `${c.oid}\n`).join(''));
}

async function diffTree(git, argv) {
  const { opts, args, rest } = parseArgs(git, argv, {
    ...DIFF_OPTIONS, 'r': 'bool', 't': 'bool', 'root': 'bool', 'no-commit-id': 'bool', 'commit-id': 'bool',
    'stdin': 'bool', 'm': 'bool', 'c': 'bool', 'cc': 'bool', 'v': 'bool', 'pretty': 'optional', 'format': 'value',
  });
  checkDiffSupport(git, opts);
  if (opts.stdin) git.unsupported('diff-tree --stdin');
  const paths = await git.pathspecs(rest ?? args.slice(2));
  let request;
  let header = '';
  if (args.length >= 2) {
    request = { mode: 'trees', from: args[0], to: args[1] };
  } else if (args.length === 1) {
    const [c] = await git.call('log', { rev: args[0], max: 1 }).catch((e) => git.failOp(e));
    if (c.parents.length === 0 && !opts.root) return;
    request = { mode: 'trees', from: c.parents[0] ?? '', to: c.oid };
    if (!opts['no-commit-id']) header = `${c.oid}\n`;
  } else {
    git.usage('usage: git diff-tree [<options>] <tree-ish> [<tree-ish>] [<path>...]');
  }
  const formats = opts.patch || opts.stat || opts.shortstat || opts.numstat || opts['name-only'] || opts['name-status'] || opts.summary;
  const { text } = await renderDiff(git, { ...request, path: paths, literal: git.literal }, formats ? opts : { ...opts, raw: true }, { defaultPatch: false });
  if (text) git.print(header + text);
}

async function shortlog(git, argv) {
  const { opts, args, rest } = parseArgs(git, argv, { ...LOG_OPTIONS, 's|summary': 'bool', 'n|numbered': 'bool', 'e|email': 'bool', 'group': 'value', 'w': 'optional' });
  const commits = await walk(git, opts, args.length ? args : ['HEAD'], rest);
  const groups = new Map();
  for (const c of [...commits].reverse()) {
    const who = opts.email ? `${c.author.name} <${c.author.email}>` : c.author.name;
    if (!groups.has(who)) groups.set(who, []);
    groups.get(who).push(c.message.split('\n')[0]);
  }
  let entries = [...groups.entries()];
  entries.sort(opts.numbered ? (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]) : (a, b) => a[0].localeCompare(b[0]));
  git.print(entries.map(([who, subjects]) => (opts.summary
    ? `${String(subjects.length).padStart(6)}\t${who}\n`
    : `${who} (${subjects.length}):\n${subjects.map((s) => `      ${s}\n`).join('')}\n`)).join(''));
}

export default {
  log, show, diff, 'rev-list': revList, 'diff-tree': diffTree, shortlog,
  whatchanged: (git, argv) => log(git, ['--raw', ...argv]),
};
