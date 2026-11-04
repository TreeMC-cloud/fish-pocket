// History ops: log walks, diffs, and applying patches.
#include "dsh_git.h"

#include <stdlib.h>
#include <string.h>
#include <strings.h>

static int touches(git_repository *repo, git_commit *commit, git_diff_options *opts) {
  git_tree *tree = NULL;
  int changed = 0;
  if (git_commit_tree(&tree, commit) < 0) return 0;
  unsigned parents = git_commit_parentcount(commit);
  if (parents == 0) {
    git_diff *diff = NULL;
    if (git_diff_tree_to_tree(&diff, repo, NULL, tree, opts) == 0) changed = git_diff_num_deltas(diff) > 0;
    git_diff_free(diff);
  }
  // A merge is shown only when it differs from every parent (git's TREESAME rule).
  changed = parents == 0 ? changed : 1;
  for (unsigned i = 0; i < parents; i++) {
    git_commit *parent = NULL;
    git_tree *parent_tree = NULL;
    git_diff *diff = NULL;
    if (git_commit_parent(&parent, commit, i) == 0 && git_commit_tree(&parent_tree, parent) == 0 &&
        git_diff_tree_to_tree(&diff, repo, parent_tree, tree, opts) == 0 && git_diff_num_deltas(diff) == 0)
      changed = 0;
    git_diff_free(diff);
    git_tree_free(parent_tree);
    git_commit_free(parent);
  }
  git_tree_free(tree);
  return changed;
}

static int contains_ci(const char *haystack, const char *needle) {
  size_t n = strlen(needle);
  for (; haystack && *haystack; haystack++)
    if (strncasecmp(haystack, needle, n) == 0) return 1;
  return 0;
}

static int push_rev(job *j, git_repository *repo, git_revwalk *walk, const char *rev) {
  if (strcmp(rev, "--all") == 0) {
    git_revwalk_push_glob(walk, "refs/*");
    git_revwalk_push_head(walk);
    return 0;
  }
  if (strncmp(rev, "--glob=", 7) == 0) return git_revwalk_push_glob(walk, rev + 7);
  const char *dots = strstr(rev, "...");
  if (dots) {
    // a...b: reachable from either but not both.
    sb left = {0};
    sb_put(&left, rev, (size_t)(dots - rev));
    const char *a = left.n ? left.p : "HEAD", *b = dots[3] ? dots + 3 : "HEAD";
    git_object *oa = NULL, *ob = NULL;
    int rc = 0;
    if (git_revparse_single(&oa, repo, a) < 0 || git_revparse_single(&ob, repo, b) < 0) {
      rc = fail(j, "badrev", "%s", rev);
    } else {
      git_oid base;
      git_revwalk_push(walk, git_object_id(oa));
      git_revwalk_push(walk, git_object_id(ob));
      if (git_merge_base(&base, repo, git_object_id(oa), git_object_id(ob)) == 0) git_revwalk_hide(walk, &base);
    }
    git_object_free(oa);
    git_object_free(ob);
    sb_free(&left);
    return rc;
  }
  if (strstr(rev, "..")) {
    // libgit2 wants both ends spelled out.
    const char *at = strstr(rev, "..");
    sb range = {0};
    if (at == rev) sb_puts(&range, "HEAD");
    sb_puts(&range, rev);
    if (!at[2]) sb_puts(&range, "HEAD");
    int code = git_revwalk_push_range(walk, range.p);
    sb_free(&range);
    return code < 0 ? fail(j, "badrev", "%s", rev) : 0;
  }
  int hide = rev[0] == '^';
  git_object *obj = NULL, *commit = NULL;
  if (git_revparse_single(&obj, repo, rev + hide) < 0 || git_object_peel(&commit, obj, GIT_OBJECT_COMMIT) < 0) {
    git_object_free(obj);
    return fail(j, "badrev", "%s", rev + hide);
  }
  if (hide) git_revwalk_hide(walk, git_object_id(commit));
  else git_revwalk_push(walk, git_object_id(commit));
  git_object_free(commit);
  git_object_free(obj);
  return 0;
}

/**
 * log rev=… path=… max= skip= firstParent= minParents= maxParents= author= grep= since= until=:
 * commits newest first, with their metadata and full messages.
 */
static int op_log(job *j) {
  git_repository *repo = NULL;
  git_revwalk *walk = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  git_strarray revs = args_all(j, "rev"), paths = args_all(j, "path");
  int max = arg_int(j, "max", -1), skip = arg_int(j, "skip", 0);
  int min_parents = arg_int(j, "minParents", 0), max_parents = arg_int(j, "maxParents", -1);
  const char *author = arg(j, "author"), *grep = arg(j, "grep");
  long long since = arg(j, "since") ? atoll(arg(j, "since")) : 0, until = arg(j, "until") ? atoll(arg(j, "until")) : 0;
  TRY(git_revwalk_new(&walk, repo));
  git_revwalk_sorting(walk, GIT_SORT_TOPOLOGICAL | GIT_SORT_TIME);
  if (arg_flag(j, "firstParent")) git_revwalk_simplify_first_parent(walk);
  if (revs.count == 0) {
    if (git_repository_head_unborn(repo) == 1) {
      rc = fail(j, "unborn", "your current branch does not have any commits yet");
      goto done;
    }
    TRY(git_revwalk_push_head(walk));
  }
  for (size_t i = 0; i < revs.count; i++)
    if ((rc = push_rev(j, repo, walk, revs.strings[i])) < 0) goto done;
  git_diff_options dopts = GIT_DIFF_OPTIONS_INIT;
  dopts.pathspec = paths;
  sb *b = &j->out;
  j_open(b, NULL, '[');
  git_oid oid;
  int shown = 0;
  while ((max < 0 || shown < max) && git_revwalk_next(&oid, walk) == 0) {
    git_commit *c = NULL;
    if (git_commit_lookup(&c, repo, &oid) < 0) continue;
    const git_signature *a = git_commit_author(c);
    unsigned parents = git_commit_parentcount(c);
    int keep = (int)parents >= min_parents && (max_parents < 0 || (int)parents <= max_parents);
    if (keep && paths.count && !touches(repo, c, &dopts)) keep = 0;
    if (keep && author && !(contains_ci(a->name, author) || contains_ci(a->email, author))) keep = 0;
    if (keep && grep && !contains_ci(git_commit_message(c), grep)) keep = 0;
    if (keep && since && git_commit_time(c) < since) keep = 0;
    if (keep && until && git_commit_time(c) > until) keep = 0;
    if (keep && skip > 0) {
      skip--;
      keep = 0;
    }
    if (keep) {
      shown++;
      j_open(b, NULL, '{');
      j_oid(b, "oid", &oid);
      git_buf abbrev = GIT_BUF_INIT;
      git_object_short_id(&abbrev, (git_object *)c);
      j_str(b, "short", abbrev.ptr);
      git_buf_dispose(&abbrev);
      j_oid(b, "tree", git_commit_tree_id(c));
      j_open(b, "parents", '[');
      for (unsigned i = 0; i < git_commit_parentcount(c); i++) j_oid(b, NULL, git_commit_parent_id(c, i));
      j_close(b, ']');
      j_sig(b, "author", a);
      j_sig(b, "committer", git_commit_committer(c));
      j_str(b, "message", git_commit_message(c));
      j_close(b, '}');
    }
    git_commit_free(c);
  }
  j_close(b, ']');
done:
  free(revs.strings);
  free(paths.strings);
  git_revwalk_free(walk);
  git_repository_free(repo);
  return rc;
}

static char status_char(git_delta_t s) {
  switch (s) {
    case GIT_DELTA_ADDED: return 'A';
    case GIT_DELTA_DELETED: return 'D';
    case GIT_DELTA_MODIFIED: return 'M';
    case GIT_DELTA_RENAMED: return 'R';
    case GIT_DELTA_COPIED: return 'C';
    case GIT_DELTA_TYPECHANGE: return 'T';
    case GIT_DELTA_UNTRACKED: return '?';
    case GIT_DELTA_CONFLICTED: return 'U';
    default: return 'X';
  }
}

static int on_line(const git_diff_delta *d, const git_diff_hunk *h, const git_diff_line *l, void *payload) {
  (void)d;
  (void)h;
  sb *b = payload;
  if (l->origin == GIT_DIFF_LINE_CONTEXT || l->origin == GIT_DIFF_LINE_ADDITION || l->origin == GIT_DIFF_LINE_DELETION)
    sb_put(b, &l->origin, 1);
  sb_put(b, l->content, l->content_len);
  return 0;
}

static int tree_of(job *j, git_repository *repo, const char *spec, git_tree **out) {
  git_object *obj = NULL;
  int code = git_revparse_single(&obj, repo, spec);
  if (code == 0) code = git_object_peel((git_object **)out, obj, GIT_OBJECT_TREE);
  git_object_free(obj);
  return code < 0 ? fail(j, "badrev", "%s", spec) : 0;
}

/**
 * diff mode=workdir|cached|tree-workdir|trees from= to= path=… context= renames= literal=
 * ignoreWhitespace= patch= stat= shortstat= summary=: changed files with line counts, and the
 * texts that were asked for.
 */
static int op_diff(job *j) {
  git_repository *repo = NULL;
  git_tree *a = NULL, *b_tree = NULL;
  git_diff *diff = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  const char *mode = arg(j, "mode");
  git_strarray paths = args_all(j, "path");
  git_diff_options opts = GIT_DIFF_OPTIONS_INIT;
  opts.pathspec = paths;
  opts.context_lines = (uint32_t)arg_int(j, "context", 3);
  opts.interhunk_lines = (uint32_t)arg_int(j, "interhunk", 0);
  if (arg_flag(j, "literal")) opts.flags |= GIT_DIFF_DISABLE_PATHSPEC_MATCH;
  if (arg_flag(j, "ignoreWhitespace")) opts.flags |= GIT_DIFF_IGNORE_WHITESPACE;
  if (arg_flag(j, "ignoreWhitespaceChange")) opts.flags |= GIT_DIFF_IGNORE_WHITESPACE_CHANGE;
  if (arg_flag(j, "text")) opts.flags |= GIT_DIFF_FORCE_TEXT;
  if (arg_flag(j, "reverse")) opts.flags |= GIT_DIFF_REVERSE;
  if (arg_flag(j, "binary")) opts.flags |= GIT_DIFF_SHOW_BINARY;
  const char *from = arg(j, "from"), *to = arg(j, "to");
  if (!mode || strcmp(mode, "workdir") == 0) {
    TRY(git_diff_index_to_workdir(&diff, repo, NULL, &opts));
  } else if (strcmp(mode, "cached") == 0) {
    if (from) {
      if ((rc = tree_of(j, repo, from, &a)) < 0) goto done;
    } else if (git_repository_head_unborn(repo) != 1) {
      if ((rc = tree_of(j, repo, "HEAD", &a)) < 0) goto done;
    }
    TRY(git_diff_tree_to_index(&diff, repo, a, NULL, &opts));
  } else if (strcmp(mode, "tree-workdir") == 0) {
    if ((rc = tree_of(j, repo, from, &a)) < 0) goto done;
    TRY(git_diff_tree_to_workdir_with_index(&diff, repo, a, &opts));
  } else {
    if (from && *from && (rc = tree_of(j, repo, from, &a)) < 0) goto done;
    if ((rc = tree_of(j, repo, to, &b_tree)) < 0) goto done;
    TRY(git_diff_tree_to_tree(&diff, repo, a, b_tree, &opts));
  }
  if (arg_flag(j, "renames")) {
    git_diff_find_options find = GIT_DIFF_FIND_OPTIONS_INIT;
    find.flags = GIT_DIFF_FIND_RENAMES;
    TRY(git_diff_find_similar(diff, &find));
  }
  sb *b = &j->out;
  j_open(b, NULL, '{');
  j_open(b, "files", '[');
  for (size_t i = 0, n = git_diff_num_deltas(diff); i < n; i++) {
    const git_diff_delta *d = git_diff_get_delta(diff, i);
    git_patch *patch = NULL;
    size_t context = 0, adds = 0, dels = 0;
    char status[2] = {status_char(d->status), 0};
    j_open(b, NULL, '{');
    j_str(b, "status", status);
    j_str(b, "old", d->old_file.path);
    j_str(b, "new", d->new_file.path);
    j_int(b, "oldMode", d->old_file.mode);
    j_int(b, "newMode", d->new_file.mode);
    j_oid(b, "oldOid", &d->old_file.id);
    j_oid(b, "newOid", &d->new_file.id);
    j_int(b, "similarity", d->similarity);
    if (git_patch_from_diff(&patch, diff, i) == 0 && patch) {
      git_patch_line_stats(&context, &adds, &dels, patch);
      j_bool(b, "binary", (git_patch_get_delta(patch)->flags & GIT_DIFF_FLAG_BINARY) != 0);
    } else {
      j_bool(b, "binary", (d->flags & GIT_DIFF_FLAG_BINARY) != 0);
    }
    j_int(b, "adds", (int64_t)adds);
    j_int(b, "dels", (int64_t)dels);
    git_patch_free(patch);
    j_close(b, '}');
  }
  j_close(b, ']');
  if (arg_flag(j, "patch")) {
    sb text = {0};
    git_diff_print(diff, GIT_DIFF_FORMAT_PATCH, on_line, &text);
    j_strn(b, "patch", text.p ? text.p : "", text.n);
    sb_free(&text);
  }
  if (arg_flag(j, "stat") || arg_flag(j, "shortstat") || arg_flag(j, "summary")) {
    sb text = {0};
    git_diff_stats_format_t format = arg_flag(j, "stat") ? GIT_DIFF_STATS_FULL : 0;
    if (arg_flag(j, "shortstat")) format |= GIT_DIFF_STATS_SHORT;
    if (arg_flag(j, "summary")) format |= GIT_DIFF_STATS_INCLUDE_SUMMARY;
    if (git_diff_num_deltas(diff)) diff_stats_text(diff, format, &text);
    j_strn(b, "stat", text.p ? text.p : "", text.n);
    sb_free(&text);
  }
  j_close(b, '}');
done:
  free(paths.strings);
  git_diff_free(diff);
  git_tree_free(a);
  git_tree_free(b_tree);
  git_repository_free(repo);
  return rc;
}

/** apply patch= location=workdir|index|both check=: applies a unified diff. */
static int op_apply(job *j) {
  git_repository *repo = NULL;
  git_diff *diff = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  const char *patch = arg(j, "patch");
  const char *where = arg(j, "location");
  if (git_diff_from_buffer(&diff, patch, strlen(patch)) < 0) {
    rc = fail_git(j, -1, "badpatch");
    goto done;
  }
  git_apply_location_t location = GIT_APPLY_LOCATION_WORKDIR;
  if (where && strcmp(where, "index") == 0) location = GIT_APPLY_LOCATION_INDEX;
  if (where && strcmp(where, "both") == 0) location = GIT_APPLY_LOCATION_BOTH;
  git_apply_options opts = GIT_APPLY_OPTIONS_INIT;
  if (arg_flag(j, "check")) opts.flags |= GIT_APPLY_CHECK;
  TRY_AS(git_apply(repo, diff, location, &opts), "apply");
  j_open(&j->out, NULL, '[');
  for (size_t i = 0, n = git_diff_num_deltas(diff); i < n; i++)
    j_str(&j->out, NULL, git_diff_get_delta(diff, i)->new_file.path);
  j_close(&j->out, ']');
done:
  git_diff_free(diff);
  git_repository_free(repo);
  return rc;
}

int ops_history(const char *name, op_fn *out) {
  if (strcmp(name, "log") == 0) *out = op_log;
  else if (strcmp(name, "diff") == 0) *out = op_diff;
  else if (strcmp(name, "apply") == 0) *out = op_apply;
  else return 0;
  return 1;
}
