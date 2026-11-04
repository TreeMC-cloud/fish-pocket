// Local repository ops: discovery, init, status, the index, commits, objects.
#include "dsh_git.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void j_repo(sb *b, git_repository *repo) {
  j_str(b, "workdir", git_repository_workdir(repo));
  j_str(b, "gitdir", git_repository_path(repo));
  j_str(b, "commondir", git_repository_commondir(repo));
  j_bool(b, "bare", git_repository_is_bare(repo));
  j_bool(b, "shallow", git_repository_is_shallow(repo));
  j_bool(b, "worktree", git_repository_is_worktree(repo));
  j_str(b, "state", repo_state_name(git_repository_state(repo)));
  j_head(b, repo);
}

/** discover: where the repository is and what HEAD is. */
static int op_discover(job *j) {
  git_repository *repo = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  j_open(&j->out, NULL, '{');
  j_repo(&j->out, repo);
  j_close(&j->out, '}');
  git_repository_free(repo);
  return 0;
}

/** init path= bare= branch= */
static int op_init(job *j) {
  git_repository *repo = NULL, *existing = NULL;
  int rc = 0;
  const char *path = arg(j, "path");
  int reinit = git_repository_open_ext(&existing, path, GIT_REPOSITORY_OPEN_NO_SEARCH, NULL) == 0;
  git_repository_free(existing);
  git_repository_init_options opts = GIT_REPOSITORY_INIT_OPTIONS_INIT;
  opts.flags = GIT_REPOSITORY_INIT_MKPATH;
  if (arg_flag(j, "bare")) opts.flags |= GIT_REPOSITORY_INIT_BARE;
  const char *branch = arg(j, "branch");
  if (branch && *branch) opts.initial_head = branch;
  TRY(git_repository_init_ext(&repo, path, &opts));
  j_open(&j->out, NULL, '{');
  j_str(&j->out, "gitdir", git_repository_path(repo));
  j_bool(&j->out, "reinit", reinit);
  j_close(&j->out, '}');
done:
  git_repository_free(repo);
  return rc;
}

/** revparse spec=… (repeated): each resolves to an object, or null. */
static int op_revparse(job *j) {
  git_repository *repo = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  git_strarray specs = args_all(j, "spec");
  int peel = arg_int(j, "peel", GIT_OBJECT_ANY);
  j_open(&j->out, NULL, '[');
  for (size_t i = 0; i < specs.count; i++) {
    git_object *obj = NULL, *peeled = NULL;
    git_reference *ref = NULL;
    // GIT_OBJECT_ANY would peel one level (commit → tree); "any" means as named.
    if (git_revparse_ext(&obj, &ref, repo, specs.strings[i]) < 0 ||
        (peel == GIT_OBJECT_ANY ? git_object_dup(&peeled, obj) : git_object_peel(&peeled, obj, (git_object_t)peel)) < 0) {
      sb_puts(&j->out, "null,");
    } else {
      git_buf abbrev = GIT_BUF_INIT;
      git_object_short_id(&abbrev, peeled);
      j_open(&j->out, NULL, '{');
      j_oid(&j->out, "oid", git_object_id(peeled));
      j_str(&j->out, "short", abbrev.ptr);
      j_str(&j->out, "type", git_object_type2string(git_object_type(peeled)));
      j_str(&j->out, "ref", ref ? git_reference_name(ref) : NULL);
      j_close(&j->out, '}');
      git_buf_dispose(&abbrev);
    }
    git_object_free(peeled);
    git_object_free(obj);
    git_reference_free(ref);
  }
  j_close(&j->out, ']');
  free(specs.strings);
  git_repository_free(repo);
  return 0;
}

static int each_ref(git_reference *ref, void *payload) {
  sb *b = payload;
  git_object *peeled = NULL;
  j_open(b, NULL, '{');
  j_str(b, "name", git_reference_name(ref));
  if (git_reference_type(ref) == GIT_REFERENCE_SYMBOLIC) {
    j_str(b, "symbolic", git_reference_symbolic_target(ref));
  } else {
    j_oid(b, "oid", git_reference_target(ref));
    if (git_reference_peel(&peeled, ref, GIT_OBJECT_COMMIT) == 0) j_oid(b, "commit", git_object_id(peeled));
  }
  j_close(b, '}');
  git_object_free(peeled);
  git_reference_free(ref);
  return 0;
}

/** refs: every reference with its target and the commit it peels to. */
static int op_refs(job *j) {
  git_repository *repo = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  j_open(&j->out, NULL, '{');
  j_head(&j->out, repo);
  j_open(&j->out, "refs", '[');
  git_reference_foreach(repo, each_ref, &j->out);
  j_close(&j->out, ']');
  j_close(&j->out, '}');
  git_repository_free(repo);
  return 0;
}

/** The two-letter conflict code from which index stages exist. */
static const char *conflict_code(git_index *index, const char *path) {
  const git_index_entry *ancestor = NULL, *ours = NULL, *theirs = NULL;
  if (git_index_conflict_get(&ancestor, &ours, &theirs, index, path) < 0) return "UU";
  if (!ancestor) return ours && theirs ? "AA" : ours ? "AU" : "UA";
  return ours && theirs ? "UU" : ours ? "UD" : theirs ? "DU" : "DD";
}

static char index_code(unsigned s) {
  if (s & GIT_STATUS_INDEX_NEW) return 'A';
  if (s & GIT_STATUS_INDEX_DELETED) return 'D';
  if (s & GIT_STATUS_INDEX_RENAMED) return 'R';
  if (s & GIT_STATUS_INDEX_TYPECHANGE) return 'T';
  if (s & GIT_STATUS_INDEX_MODIFIED) return 'M';
  return '.';
}

static char worktree_code(unsigned s) {
  if (s & GIT_STATUS_WT_DELETED) return 'D';
  if (s & GIT_STATUS_WT_RENAMED) return 'R';
  if (s & GIT_STATUS_WT_TYPECHANGE) return 'T';
  if (s & GIT_STATUS_WT_MODIFIED) return 'M';
  return '.';
}

/** status untracked=no|normal|all ignored= path=…: entries plus HEAD. */
static int op_status(job *j) {
  git_repository *repo = NULL;
  git_status_list *list = NULL;
  git_index *index = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  if (git_repository_is_bare(repo)) {
    rc = fail(j, "bare", "this operation must be run in a work tree");
    goto done;
  }
  git_status_options opts = GIT_STATUS_OPTIONS_INIT;
  opts.show = GIT_STATUS_SHOW_INDEX_AND_WORKDIR;
  opts.flags = GIT_STATUS_OPT_RENAMES_HEAD_TO_INDEX | GIT_STATUS_OPT_SORT_CASE_SENSITIVELY;
  const char *untracked = arg(j, "untracked");
  if (!untracked || strcmp(untracked, "no") != 0) opts.flags |= GIT_STATUS_OPT_INCLUDE_UNTRACKED;
  if (untracked && strcmp(untracked, "all") == 0) opts.flags |= GIT_STATUS_OPT_RECURSE_UNTRACKED_DIRS;
  if (arg_flag(j, "ignored")) opts.flags |= GIT_STATUS_OPT_INCLUDE_IGNORED;
  git_strarray paths = args_all(j, "path");
  opts.pathspec = paths;
  TRY(git_status_list_new(&list, repo, &opts));
  TRY(git_repository_index(&index, repo));
  sb *b = &j->out;
  j_open(b, NULL, '{');
  j_repo(b, repo);
  j_open(b, "entries", '[');
  for (size_t i = 0, n = git_status_list_entrycount(list); i < n; i++) {
    const git_status_entry *e = git_status_byindex(list, i);
    unsigned s = e->status;
    const git_diff_delta *d = e->head_to_index ? e->head_to_index : e->index_to_workdir;
    const unsigned staged = GIT_STATUS_INDEX_NEW | GIT_STATUS_INDEX_MODIFIED | GIT_STATUS_INDEX_DELETED |
                            GIT_STATUS_INDEX_RENAMED | GIT_STATUS_INDEX_TYPECHANGE;
    if ((s & GIT_STATUS_WT_NEW) && (s & staged)) {
      // Removed from the index but still on disk: git lists the deletion and the untracked file.
      char xy[3] = {index_code(s), '.', 0};
      j_open(b, NULL, '{');
      j_str(b, "xy", xy);
      j_str(b, "path", e->head_to_index->old_file.path);
      j_close(b, '}');
      s &= ~staged;
    }
    j_open(b, NULL, '{');
    if (s & GIT_STATUS_CONFLICTED) {
      j_str(b, "xy", conflict_code(index, d->new_file.path));
    } else if (s & GIT_STATUS_WT_NEW) {
      j_str(b, "xy", "??");
    } else if (s & GIT_STATUS_IGNORED) {
      j_str(b, "xy", "!!");
    } else {
      char xy[3] = {index_code(s), worktree_code(s), 0};
      j_str(b, "xy", xy);
    }
    if (e->head_to_index && !(s & GIT_STATUS_WT_NEW)) {
      j_str(b, "path", e->head_to_index->new_file.path);
      if (s & GIT_STATUS_INDEX_RENAMED) {
        j_str(b, "orig", e->head_to_index->old_file.path);
        j_int(b, "score", e->head_to_index->similarity);
      }
    } else {
      j_str(b, "path", e->index_to_workdir->new_file.path);
    }
    j_close(b, '}');
  }
  j_close(b, ']');
  j_close(b, '}');
done:
  free(paths.strings);
  git_index_free(index);
  git_status_list_free(list);
  git_repository_free(repo);
  return rc;
}

/** Pathspecs that match neither the work tree nor the index. */
static int unmatched_pathspec(job *j, git_repository *repo, git_index *index, git_strarray *paths) {
  git_pathspec *ps = NULL;
  git_pathspec_match_list *in_tree = NULL, *in_index = NULL;
  int rc = 0;
  if (!paths->count || arg_flag(j, "ignoreUnmatch")) return 0;
  TRY(git_pathspec_new(&ps, paths));
  uint32_t flags = GIT_PATHSPEC_FIND_FAILURES | (arg_flag(j, "literal") ? GIT_PATHSPEC_NO_GLOB : 0);
  if (git_repository_workdir(repo)) TRY(git_pathspec_match_workdir(&in_tree, repo, flags, ps));
  TRY(git_pathspec_match_index(&in_index, index, flags, ps));
  for (size_t i = 0, n = git_pathspec_match_list_failed_entrycount(in_index); i < n; i++) {
    const char *spec = git_pathspec_match_list_failed_entry(in_index, i);
    int found = !in_tree;
    for (size_t k = 0, m = in_tree ? git_pathspec_match_list_failed_entrycount(in_tree) : 0; k < m; k++)
      if (strcmp(git_pathspec_match_list_failed_entry(in_tree, k), spec) == 0) found = 1;
    if (found) {
      rc = fail(j, "nomatch", "%s", spec);
      goto done;
    }
  }
done:
  git_pathspec_match_list_free(in_tree);
  git_pathspec_match_list_free(in_index);
  git_pathspec_free(ps);
  return rc;
}

typedef struct {
  job *j;
  int dry;
} add_ctx;

static int on_add(const char *path, const char *matched, void *payload) {
  (void)matched;
  add_ctx *c = payload;
  j_str(&c->j->out, NULL, path);
  return c->dry ? 1 : 0;
}

/** add mode=default|all|update force= dry= path=…: stages additions, changes and removals. */
static int op_add(job *j) {
  git_repository *repo = NULL;
  git_index *index = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  git_strarray paths = args_all(j, "path");
  const char *mode = arg(j, "mode");
  add_ctx c = {j, arg_flag(j, "dry")};
  TRY(git_repository_index(&index, repo));
  if ((rc = unmatched_pathspec(j, repo, index, &paths)) < 0) goto done;
  j_open(&j->out, NULL, '[');
  unsigned flags = GIT_INDEX_ADD_CHECK_PATHSPEC | (arg_flag(j, "force") ? GIT_INDEX_ADD_FORCE : 0);
  if (!mode || strcmp(mode, "update") != 0) {
    int code = git_index_add_all(index, &paths, flags, on_add, &c);
    if (code == GIT_EINVALIDSPEC) {
      rc = fail_git(j, code, "ignored");
      goto done;
    }
    TRY(code);
  }
  if (!c.dry) TRY(git_index_update_all(index, &paths, NULL, NULL));
  j_close(&j->out, ']');
  if (!c.dry) TRY(git_index_write(index));
done:
  free(paths.strings);
  git_index_free(index);
  git_repository_free(repo);
  return rc;
}

/** rm cached= recursive= force= path=…: removes from the index (and the work tree). */
static int op_rm(job *j) {
  git_repository *repo = NULL;
  git_index *index = NULL;
  git_pathspec *ps = NULL;
  git_pathspec_match_list *matches = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  git_strarray paths = args_all(j, "path");
  int cached = arg_flag(j, "cached"), force = arg_flag(j, "force"), dry = arg_flag(j, "dry");
  TRY(git_repository_index(&index, repo));
  TRY(git_pathspec_new(&ps, &paths));
  TRY(git_pathspec_match_index(&matches, index, GIT_PATHSPEC_FIND_FAILURES, ps));
  if (git_pathspec_match_list_failed_entrycount(matches) && !arg_flag(j, "ignoreUnmatch")) {
    rc = fail(j, "nomatch", "%s", git_pathspec_match_list_failed_entry(matches, 0));
    goto done;
  }
  size_t n = git_pathspec_match_list_entrycount(matches);
  if (!arg_flag(j, "recursive"))
    for (size_t i = 0; i < n; i++) {
      const char *entry = git_pathspec_match_list_entry(matches, i);
      int literal = 0;
      for (size_t k = 0; k < paths.count; k++)
        if (strcmp(paths.strings[k], entry) == 0) literal = 1;
      if (!literal) {
        for (size_t k = 0; k < paths.count; k++) {
          size_t len = strlen(paths.strings[k]);
          if (strncmp(paths.strings[k], entry, len) == 0 && entry[len] == '/') {
            rc = fail(j, "recursive", "%s", paths.strings[k]);
            goto done;
          }
        }
      }
    }
  if (!force)
    for (size_t i = 0; i < n; i++) {
      const char *entry = git_pathspec_match_list_entry(matches, i);
      unsigned int s = 0;
      if (git_status_file(&s, repo, entry) < 0) continue;
      int staged = s & (GIT_STATUS_INDEX_NEW | GIT_STATUS_INDEX_MODIFIED | GIT_STATUS_INDEX_TYPECHANGE);
      int modified = s & (GIT_STATUS_WT_MODIFIED | GIT_STATUS_WT_TYPECHANGE);
      if ((staged && modified) || (!cached && (staged || modified))) {
        rc = fail(j, staged && modified ? "rm-both" : staged ? "rm-staged" : "rm-modified", "%s", entry);
        goto done;
      }
    }
  const char *workdir = git_repository_workdir(repo);
  j_open(&j->out, NULL, '[');
  for (size_t i = 0; i < n; i++) {
    const char *entry = git_pathspec_match_list_entry(matches, i);
    j_str(&j->out, NULL, entry);
    if (dry) continue;
    if (!cached && workdir) {
      sb full = {0};
      sb_printf(&full, "%s%s", workdir, entry);
      unlink(full.p);
      // Empty parent directories go too, as with git.
      for (char *slash = strrchr(full.p, '/'); slash && (size_t)(slash - full.p) > strlen(workdir) - 1;
           slash = strrchr(full.p, '/')) {
        *slash = 0;
        if (rmdir(full.p) < 0) break;
      }
      sb_free(&full);
    }
    TRY(git_index_remove_bypath(index, entry));
  }
  j_close(&j->out, ']');
  if (!dry) TRY(git_index_write(index));
done:
  free(paths.strings);
  git_pathspec_match_list_free(matches);
  git_pathspec_free(ps);
  git_index_free(index);
  git_repository_free(repo);
  return rc;
}

/** mv from= to=: renames one tracked file (to may be a path inside the work tree). */
static int op_mv(job *j) {
  git_repository *repo = NULL;
  git_index *index = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  const char *from = arg(j, "from"), *to = arg(j, "to");
  const char *workdir = git_repository_workdir(repo);
  sb a = {0}, b = {0};
  TRY(git_repository_index(&index, repo));
  if (!git_index_get_bypath(index, from, 0)) {
    rc = fail(j, "mv-untracked", "%s", from);
    goto done;
  }
  sb_printf(&a, "%s%s", workdir, from);
  sb_printf(&b, "%s%s", workdir, to);
  struct stat st;
  if (!arg_flag(j, "force") && lstat(b.p, &st) == 0) {
    rc = fail(j, "mv-exists", "%s", to);
    goto done;
  }
  if (rename(a.p, b.p) < 0) {
    rc = fail(j, "mv-failed", "%s", from);
    goto done;
  }
  TRY(git_index_remove_bypath(index, from));
  TRY(git_index_add_bypath(index, to));
  TRY(git_index_write(index));
  sb_puts(&j->out, "null");
done:
  sb_free(&a);
  sb_free(&b);
  git_index_free(index);
  git_repository_free(repo);
  return rc;
}

static int on_mergehead(const git_oid *oid, void *payload) {
  git_oid **cursor = payload;
  git_oid_cpy(*cursor, oid);
  (*cursor)++;
  return 0;
}

/**
 * commit message= amend= allowEmpty= all= authorName/Email/Time= committerName/Email/Time=:
 * writes the index as a commit on HEAD (concluding a merge when one is in progress).
 */
static int op_commit(job *j) {
  git_repository *repo = NULL;
  git_index *index = NULL;
  git_tree *tree = NULL, *parent_tree = NULL;
  git_commit *head = NULL;
  git_signature *author = NULL, *committer = NULL;
  git_reference *head_ref = NULL, *updated = NULL;
  git_diff *diff = NULL;
  const git_commit *parents[16] = {0};
  git_commit *merge_parents[15] = {0};
  git_oid merge_oids[15];
  size_t parent_count = 0, merge_count = 0;
  git_buf msg_buf = GIT_BUF_INIT;
  sb message = {0};
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  int amend = arg_flag(j, "amend");
  int merging = git_repository_state(repo) == GIT_REPOSITORY_STATE_MERGE;
  TRY(git_repository_index(&index, repo));
  if (arg_flag(j, "all")) {
    TRY(git_index_update_all(index, NULL, NULL, NULL));
    TRY(git_index_write(index));
  }
  if (git_index_has_conflicts(index)) {
    rc = fail(j, "unmerged", "you have unmerged files");
    goto done;
  }
  int unborn = git_repository_head_unborn(repo) == 1;
  if (!unborn) TRY(resolve_commit(j, repo, "HEAD", &head));
  if (amend && !head) {
    rc = fail(j, "amend-unborn", "You have nothing to amend.");
    goto done;
  }
  const char *given = arg(j, "message");
  if (given) sb_puts(&message, given);
  else if (amend) sb_puts(&message, git_commit_message(head));
  else if (merging && git_repository_message(&msg_buf, repo) == 0) {
    // MERGE_MSG, minus its comment lines.
    for (char *line = msg_buf.ptr, *next; line && *line; line = next) {
      next = strchr(line, '\n');
      size_t len = next ? (size_t)(++next - line) : strlen(line);
      if (*line != '#') sb_put(&message, line, len);
    }
  }
  int empty_message = 1;
  for (size_t i = 0; i < message.n; i++)
    if (message.p[i] != ' ' && message.p[i] != '\n' && message.p[i] != '\t') empty_message = 0;
  if (empty_message && !arg_flag(j, "allowEmptyMessage")) {
    rc = fail(j, "nomsg", "Aborting commit due to empty commit message.");
    goto done;
  }
  git_buf clean = GIT_BUF_INIT;
  if (!arg_flag(j, "verbatim") && git_message_prettify(&clean, message.p ? message.p : "", 0, 0) == 0) {
    message.n = 0;
    sb_puts(&message, clean.ptr ? clean.ptr : "");
  }
  git_buf_dispose(&clean);

  git_oid tree_oid;
  TRY(git_index_write_tree(&tree_oid, index));
  TRY(git_tree_lookup(&tree, repo, &tree_oid));
  if (amend) {
    for (unsigned i = 0; i < git_commit_parentcount(head) && parent_count < 16; i++)
      git_commit_parent((git_commit **)&parents[parent_count++], head, i);
  } else if (head) {
    parents[parent_count++] = head;
  }
  if (merging && !amend) {
    git_oid *cursor = merge_oids;
    git_repository_mergehead_foreach(repo, on_mergehead, &cursor);
    merge_count = (size_t)(cursor - merge_oids);
    for (size_t i = 0; i < merge_count && parent_count < 16; i++)
      if (git_commit_lookup(&merge_parents[i], repo, &merge_oids[i]) == 0) parents[parent_count++] = merge_parents[i];
  }
  if (parent_count) TRY(git_commit_tree(&parent_tree, (git_commit *)parents[0]));
  if (!arg_flag(j, "allowEmpty") && !merging && !amend) {
    int same = parent_tree ? git_oid_equal(git_tree_id(parent_tree), &tree_oid) : git_index_entrycount(index) == 0;
    if (same) {
      rc = fail(j, "nothing", "nothing to commit");
      goto done;
    }
  }
  if ((rc = signature_for(j, repo, "author", &author)) < 0) goto done;
  if (amend && !arg(j, "authorName") && !arg_flag(j, "resetAuthor")) {
    git_signature_free(author);
    git_signature_dup(&author, git_commit_author(head));
  }
  if ((rc = signature_for(j, repo, "committer", &committer)) < 0) goto done;
  git_oid oid;
  TRY(git_commit_create(&oid, repo, NULL, author, committer, NULL, message.p, tree, parent_count, parents));

  char subject[200] = {0};
  for (size_t i = 0; i < message.n && message.p[i] != '\n' && i < sizeof subject - 1; i++) subject[i] = message.p[i];
  sb reflog = {0};
  sb_printf(&reflog, "commit%s: %s", amend ? " (amend)" : !head ? " (initial)" : merging ? " (merge)" : "", subject);
  TRY(git_reference_lookup(&head_ref, repo, "HEAD"));
  if (git_reference_type(head_ref) == GIT_REFERENCE_SYMBOLIC)
    rc = git_reference_create(&updated, repo, git_reference_symbolic_target(head_ref), &oid, 1, reflog.p);
  else
    rc = git_reference_set_target(&updated, head_ref, &oid, reflog.p);
  sb_free(&reflog);
  if (rc < 0) {
    rc = fail_git(j, rc, "git");
    goto done;
  }
  if (merging) git_repository_state_cleanup(repo);

  sb *b = &j->out;
  j_open(b, NULL, '{');
  j_oid(b, "oid", &oid);
  j_bool(b, "root", parent_count == 0);
  j_str(b, "subject", subject);
  j_head(b, repo);
  git_diff_options dopts = GIT_DIFF_OPTIONS_INIT;
  if (git_diff_tree_to_tree(&diff, repo, parent_tree, tree, &dopts) == 0) {
    git_diff_find_similar(diff, NULL);
    sb stats = {0};
    diff_stats_text(diff, GIT_DIFF_STATS_SHORT | GIT_DIFF_STATS_INCLUDE_SUMMARY, &stats);
    j_str(b, "stats", stats.p ? stats.p : "");
    sb_free(&stats);
  }
  j_close(b, '}');
  rc = 0;
done:
  for (size_t i = amend ? 0 : 1; amend && i < parent_count; i++) git_commit_free((git_commit *)parents[i]);
  for (size_t i = 0; i < merge_count; i++) git_commit_free(merge_parents[i]);
  git_buf_dispose(&msg_buf);
  sb_free(&message);
  git_diff_free(diff);
  git_reference_free(updated);
  git_reference_free(head_ref);
  git_signature_free(author);
  git_signature_free(committer);
  git_tree_free(parent_tree);
  git_tree_free(tree);
  git_commit_free(head);
  git_index_free(index);
  git_repository_free(repo);
  return rc;
}

/** cat spec=: the object; its raw bytes come back as data (tree entries as JSON). */
static int op_cat(job *j) {
  git_repository *repo = NULL;
  git_object *obj = NULL;
  git_odb *odb = NULL;
  git_odb_object *raw = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  if (git_revparse_single(&obj, repo, arg(j, "spec")) < 0) {
    rc = fail(j, "badrev", "%s", arg(j, "spec"));
    goto done;
  }
  const char *peel = arg(j, "peel");
  if (peel && *peel) {
    git_object *peeled = NULL;
    if (git_object_peel(&peeled, obj, git_object_string2type(peel)) < 0) {
      rc = fail(j, "notcommit", "%s", arg(j, "spec"));
      goto done;
    }
    git_object_free(obj);
    obj = peeled;
  }
  TRY(git_repository_odb(&odb, repo));
  TRY(git_odb_read(&raw, odb, git_object_id(obj)));
  sb *b = &j->out;
  j_open(b, NULL, '{');
  j_oid(b, "oid", git_object_id(obj));
  j_str(b, "type", git_object_type2string(git_object_type(obj)));
  j_int(b, "size", (int64_t)git_odb_object_size(raw));
  if (git_object_type(obj) == GIT_OBJECT_TREE) {
    j_open(b, "entries", '[');
    for (size_t i = 0, n = git_tree_entrycount((git_tree *)obj); i < n; i++) {
      const git_tree_entry *e = git_tree_entry_byindex((git_tree *)obj, i);
      j_open(b, NULL, '{');
      j_int(b, "mode", git_tree_entry_filemode(e));
      j_str(b, "type", git_object_type2string(git_tree_entry_type(e)));
      j_oid(b, "oid", git_tree_entry_id(e));
      j_str(b, "name", git_tree_entry_name(e));
      j_close(b, '}');
    }
    j_close(b, ']');
  } else {
    j->has_data = 1;
    sb_put(&j->data, git_odb_object_data(raw), git_odb_object_size(raw));
  }
  j_close(b, '}');
done:
  git_odb_object_free(raw);
  git_odb_free(odb);
  git_object_free(obj);
  git_repository_free(repo);
  return rc;
}

typedef struct {
  sb *b;
  git_odb *odb;
  int sizes;
  int recursive;
  int trees;
} tree_walk;

static int on_tree_entry(const char *root, const git_tree_entry *e, void *payload) {
  tree_walk *w = payload;
  git_object_t type = git_tree_entry_type(e);
  if (w->recursive && type == GIT_OBJECT_TREE && !w->trees) return 0;
  j_open(w->b, NULL, '{');
  j_int(w->b, "mode", git_tree_entry_filemode(e));
  j_str(w->b, "type", git_object_type2string(type));
  j_oid(w->b, "oid", git_tree_entry_id(e));
  sb path = {0};
  sb_printf(&path, "%s%s", root, git_tree_entry_name(e));
  j_str(w->b, "path", path.p);
  sb_free(&path);
  if (w->sizes && type == GIT_OBJECT_BLOB) {
    size_t size = 0;
    git_object_t t;
    if (git_odb_read_header(&size, &t, w->odb, git_tree_entry_id(e)) == 0) j_int(w->b, "size", (int64_t)size);
  }
  j_close(w->b, '}');
  return w->recursive ? 0 : 1;
}

/** ls-tree tree= recursive= trees= sizes=: entries (filtered by path in JS). */
static int op_ls_tree(job *j) {
  git_repository *repo = NULL;
  git_object *obj = NULL;
  git_tree *tree = NULL;
  git_odb *odb = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  if (git_revparse_single(&obj, repo, arg(j, "tree")) < 0 ||
      git_object_peel((git_object **)&tree, obj, GIT_OBJECT_TREE) < 0) {
    rc = fail(j, "badrev", "%s", arg(j, "tree"));
    goto done;
  }
  TRY(git_repository_odb(&odb, repo));
  tree_walk w = {&j->out, odb, arg_flag(j, "sizes"), arg_flag(j, "recursive"), arg_flag(j, "trees")};
  j_open(&j->out, NULL, '[');
  git_tree_walk(tree, GIT_TREEWALK_PRE, on_tree_entry, &w);
  j_close(&j->out, ']');
done:
  git_odb_free(odb);
  git_tree_free(tree);
  git_object_free(obj);
  git_repository_free(repo);
  return rc;
}

/** ls-files: the index, with stages. */
static int op_ls_files(job *j) {
  git_repository *repo = NULL;
  git_index *index = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  TRY(git_repository_index(&index, repo));
  sb *b = &j->out;
  j_open(b, NULL, '[');
  for (size_t i = 0, n = git_index_entrycount(index); i < n; i++) {
    const git_index_entry *e = git_index_get_byindex(index, i);
    j_open(b, NULL, '{');
    j_str(b, "path", e->path);
    j_int(b, "mode", e->mode);
    j_oid(b, "oid", &e->id);
    j_int(b, "stage", git_index_entry_stage(e));
    j_close(b, '}');
  }
  j_close(b, ']');
done:
  git_index_free(index);
  git_repository_free(repo);
  return rc;
}

/** write-tree: the index as a tree object. */
static int op_write_tree(job *j) {
  git_repository *repo = NULL;
  git_index *index = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  TRY(git_repository_index(&index, repo));
  git_oid oid;
  TRY(git_index_write_tree(&oid, index));
  j_open(&j->out, NULL, '{');
  j_oid(&j->out, "oid", &oid);
  j_close(&j->out, '}');
done:
  git_index_free(index);
  git_repository_free(repo);
  return rc;
}

/** check-ignore path=…: the paths that are ignored (tracked files never are, as with git). */
static int op_check_ignore(job *j) {
  git_repository *repo = NULL;
  git_index *index = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  git_strarray paths = args_all(j, "path");
  git_repository_index(&index, repo);
  j_open(&j->out, NULL, '[');
  for (size_t i = 0; i < paths.count; i++) {
    int ignored = 0;
    if (index && git_index_get_bypath(index, paths.strings[i], 0)) continue;
    if (git_ignore_path_is_ignored(&ignored, repo, paths.strings[i]) == 0 && ignored)
      j_str(&j->out, NULL, paths.strings[i]);
  }
  j_close(&j->out, ']');
  free(paths.strings);
  git_index_free(index);
  git_repository_free(repo);
  return 0;
}

/** merge-base spec=a spec=b: their best common ancestor. */
static int op_merge_base(job *j) {
  git_repository *repo = NULL;
  git_commit *a = NULL, *b = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  git_strarray specs = args_all(j, "spec");
  if (specs.count < 2) {
    rc = fail(j, "usage", "merge-base needs two commits");
    goto done;
  }
  if ((rc = resolve_commit(j, repo, specs.strings[0], &a)) < 0 || (rc = resolve_commit(j, repo, specs.strings[1], &b)) < 0)
    goto done;
  git_oid base;
  if (git_merge_base(&base, repo, git_commit_id(a), git_commit_id(b)) < 0) {
    rc = fail(j, "nobase", "no merge base");
    goto done;
  }
  j_open(&j->out, NULL, '{');
  j_oid(&j->out, "oid", &base);
  j_bool(&j->out, "ancestor", git_oid_equal(&base, git_commit_id(a)));
  j_close(&j->out, '}');
done:
  free(specs.strings);
  git_commit_free(a);
  git_commit_free(b);
  git_repository_free(repo);
  return rc;
}

/** hash-object write= path=…: blob ids of work-tree files. */
static int op_hash_object(job *j) {
  git_repository *repo = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  git_strarray paths = args_all(j, "path");
  j_open(&j->out, NULL, '[');
  for (size_t i = 0; i < paths.count; i++) {
    git_oid oid;
    if (arg_flag(j, "write")) TRY(git_blob_create_from_disk(&oid, repo, paths.strings[i]));
    else TRY(git_odb_hashfile(&oid, paths.strings[i], GIT_OBJECT_BLOB));
    j_oid(&j->out, NULL, &oid);
  }
  j_close(&j->out, ']');
done:
  free(paths.strings);
  git_repository_free(repo);
  return rc;
}

int ops_repo(const char *name, op_fn *out) {
  static const struct {
    const char *name;
    op_fn fn;
  } table[] = {
      {"discover", op_discover},   {"init", op_init},           {"revparse", op_revparse},
      {"refs", op_refs},           {"status", op_status},       {"add", op_add},
      {"rm", op_rm},               {"mv", op_mv},               {"commit", op_commit},
      {"cat", op_cat},             {"ls-tree", op_ls_tree},     {"ls-files", op_ls_files},
      {"write-tree", op_write_tree}, {"check-ignore", op_check_ignore}, {"merge-base", op_merge_base},
      {"hash-object", op_hash_object},
  };
  for (size_t i = 0; i < sizeof table / sizeof table[0]; i++)
    if (strcmp(table[i].name, name) == 0) {
      *out = table[i].fn;
      return 1;
    }
  return 0;
}
