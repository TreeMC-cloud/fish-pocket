// Branches, checkout, reset, merge, tags, stash, config, remotes, clean, worktrees.
#include "dsh_git.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

/** branches remotes=1 all=1: branch list with upstreams and tips. */
static int op_branches(job *j) {
  git_repository *repo = NULL;
  git_branch_iterator *it = NULL;
  git_reference *ref = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  git_branch_t kind = arg_flag(j, "all") ? GIT_BRANCH_ALL : arg_flag(j, "remotes") ? GIT_BRANCH_REMOTE : GIT_BRANCH_LOCAL;
  TRY(git_branch_iterator_new(&it, repo, kind));
  sb *b = &j->out;
  j_open(b, NULL, '{');
  j_head(b, repo);
  j_open(b, "branches", '[');
  git_branch_t type;
  while (git_branch_next(&ref, &type, it) == 0) {
    const char *name = NULL;
    git_branch_name(&name, ref);
    j_open(b, NULL, '{');
    j_str(b, "name", name);
    j_str(b, "ref", git_reference_name(ref));
    j_bool(b, "remote", type == GIT_BRANCH_REMOTE);
    j_bool(b, "head", type == GIT_BRANCH_LOCAL && git_branch_is_head(ref) == 1);
    if (git_reference_type(ref) == GIT_REFERENCE_SYMBOLIC) {
      j_str(b, "symbolic", git_reference_symbolic_target(ref));
    } else {
      git_commit *c = NULL;
      j_oid(b, "oid", git_reference_target(ref));
      if (git_commit_lookup(&c, repo, git_reference_target(ref)) == 0) {
        j_str(b, "subject", git_commit_summary(c));
        git_buf abbrev = GIT_BUF_INIT;
        git_object_short_id(&abbrev, (git_object *)c);
        j_str(b, "short", abbrev.ptr);
        git_buf_dispose(&abbrev);
      }
      git_commit_free(c);
    }
    git_buf up = GIT_BUF_INIT;
    if (type == GIT_BRANCH_LOCAL && git_branch_upstream_name(&up, repo, git_reference_name(ref)) == 0) {
      git_reference *upstream = NULL;
      j_str(b, "upstream", strncmp(up.ptr, "refs/remotes/", 13) == 0 ? up.ptr + 13 : up.ptr);
      if (git_reference_lookup(&upstream, repo, up.ptr) == 0) {
        size_t ahead = 0, behind = 0;
        git_graph_ahead_behind(&ahead, &behind, repo, git_reference_target(ref), git_reference_target(upstream));
        j_int(b, "ahead", (int64_t)ahead);
        j_int(b, "behind", (int64_t)behind);
      } else {
        j_bool(b, "gone", 1);
      }
      git_reference_free(upstream);
    }
    git_buf_dispose(&up);
    j_close(b, '}');
    git_reference_free(ref);
    ref = NULL;
  }
  j_close(b, ']');
  j_close(b, '}');
done:
  git_branch_iterator_free(it);
  git_repository_free(repo);
  return rc;
}

/** Track `start` when it names a remote-tracking branch (git's branch.autoSetupMerge). */
static void track_if_remote(git_repository *repo, git_reference *branch, const char *start, sb *out) {
  git_reference *ref = NULL;
  if (git_reference_dwim(&ref, repo, start) == 0 && git_reference_is_remote(ref)) {
    const char *name = NULL;
    git_branch_name(&name, ref);
    if (git_branch_set_upstream(branch, name) == 0) j_str(out, "tracking", name);
  }
  git_reference_free(ref);
}

/** branch-create name= start= force= track=: a new branch at start (HEAD by default). */
static int op_branch_create(job *j) {
  git_repository *repo = NULL;
  git_commit *start = NULL;
  git_reference *branch = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  const char *name = arg(j, "name"), *from = arg(j, "start");
  if (!from || !*from) from = "HEAD";
  if (strcmp(from, "HEAD") == 0 && git_repository_head_unborn(repo) == 1) {
    rc = fail(j, "unborn", "not a valid object name: '%s'", from);
    goto done;
  }
  if ((rc = resolve_commit(j, repo, from, &start)) < 0) goto done;
  int code = git_branch_create(&branch, repo, name, start, arg_flag(j, "force"));
  if (code == GIT_EEXISTS) {
    rc = fail(j, "exists", "%s", name);
    goto done;
  }
  if (code == GIT_EINVALIDSPEC) {
    rc = fail(j, "badname", "%s", name);
    goto done;
  }
  TRY(code);
  j_open(&j->out, NULL, '{');
  if (!arg(j, "track") || arg_flag(j, "track")) track_if_remote(repo, branch, from, &j->out);
  j_oid(&j->out, "oid", git_commit_id(start));
  j_close(&j->out, '}');
done:
  git_reference_free(branch);
  git_commit_free(start);
  git_repository_free(repo);
  return rc;
}

/** branch-delete name= force= remote=: refuses unmerged or checked-out branches without force. */
static int op_branch_delete(job *j) {
  git_repository *repo = NULL;
  git_reference *branch = NULL, *head = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  const char *name = arg(j, "name");
  int remote = arg_flag(j, "remote");
  if (git_branch_lookup(&branch, repo, name, remote ? GIT_BRANCH_REMOTE : GIT_BRANCH_LOCAL) < 0) {
    rc = fail(j, "notfound", "%s", name);
    goto done;
  }
  if (!remote && git_branch_is_checked_out(branch) == 1) {
    rc = fail(j, "current", "%s", name);
    goto done;
  }
  const git_oid *tip = git_reference_target(branch);
  if (!remote && !arg_flag(j, "force")) {
    // Merged means reachable from its upstream, or from HEAD without one.
    git_buf up = GIT_BUF_INIT;
    const git_oid *base = NULL;
    git_reference *upstream = NULL;
    if (git_branch_upstream_name(&up, repo, git_reference_name(branch)) == 0 &&
        git_reference_lookup(&upstream, repo, up.ptr) == 0)
      base = git_reference_target(upstream);
    else if (git_repository_head(&head, repo) == 0)
      base = git_reference_target(head);
    int merged = base && (git_oid_equal(base, tip) || git_graph_descendant_of(repo, base, tip) == 1);
    git_reference_free(upstream);
    git_buf_dispose(&up);
    if (!merged) {
      rc = fail(j, "notmerged", "%s", name);
      goto done;
    }
  }
  j_open(&j->out, NULL, '{');
  git_object *obj = NULL;
  git_buf abbrev = GIT_BUF_INIT;
  if (git_object_lookup(&obj, repo, tip, GIT_OBJECT_ANY) == 0) git_object_short_id(&abbrev, obj);
  j_str(&j->out, "short", abbrev.ptr);
  git_buf_dispose(&abbrev);
  git_object_free(obj);
  j_close(&j->out, '}');
  TRY(git_branch_delete(branch));
done:
  git_reference_free(head);
  git_reference_free(branch);
  git_repository_free(repo);
  return rc;
}

/** branch-rename from= to= force=: also moves HEAD when it pointed there. */
static int op_branch_rename(job *j) {
  git_repository *repo = NULL;
  git_reference *branch = NULL, *moved = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  if (git_branch_lookup(&branch, repo, arg(j, "from"), GIT_BRANCH_LOCAL) < 0) {
    rc = fail(j, "notfound", "%s", arg(j, "from"));
    goto done;
  }
  int code = git_branch_move(&moved, branch, arg(j, "to"), arg_flag(j, "force"));
  if (code == GIT_EEXISTS) {
    rc = fail(j, "exists", "%s", arg(j, "to"));
    goto done;
  }
  TRY(code);
  sb_puts(&j->out, "null");
done:
  git_reference_free(moved);
  git_reference_free(branch);
  git_repository_free(repo);
  return rc;
}

/** branch-upstream name= upstream=: set (or with an empty upstream, unset) tracking. */
static int op_branch_upstream(job *j) {
  git_repository *repo = NULL;
  git_reference *branch = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  const char *name = arg(j, "name"), *upstream = arg(j, "upstream");
  if (git_branch_lookup(&branch, repo, name, GIT_BRANCH_LOCAL) < 0) {
    rc = fail(j, "notfound", "%s", name);
    goto done;
  }
  if (git_branch_set_upstream(branch, upstream && *upstream ? upstream : NULL) < 0) {
    rc = fail(j, "noupstream", "%s", upstream ? upstream : "");
    goto done;
  }
  sb_puts(&j->out, "null");
done:
  git_reference_free(branch);
  git_repository_free(repo);
  return rc;
}

typedef struct {
  sb conflicts;
} checkout_notes;

static int on_checkout_notify(git_checkout_notify_t why, const char *path, const git_diff_file *baseline,
                              const git_diff_file *target, const git_diff_file *workdir, void *payload) {
  (void)why;
  (void)baseline;
  (void)target;
  (void)workdir;
  checkout_notes *n = payload;
  j_str(&n->conflicts, NULL, path);
  return 0;
}

static void checkout_options(git_checkout_options *opts, checkout_notes *notes, int force) {
  opts->checkout_strategy = force ? GIT_CHECKOUT_FORCE : GIT_CHECKOUT_SAFE;
  opts->notify_flags = GIT_CHECKOUT_NOTIFY_CONFLICT;
  opts->notify_cb = on_checkout_notify;
  opts->notify_payload = notes;
}

static int checkout_failed(job *j, int code, checkout_notes *notes) {
  if (code == GIT_ECONFLICT || notes->conflicts.n) {
    if (notes->conflicts.n && notes->conflicts.p[notes->conflicts.n - 1] == ',') notes->conflicts.n--;
    return fail(j, "overwrite", "[%s]", notes->conflicts.p ? notes->conflicts.p : "");
  }
  return fail_git(j, code, "git");
}

/**
 * checkout target= create= force= detach= guess= start= orphan=: switch HEAD to a branch
 * (creating it, or a tracking branch for a remote one) or detach at a commit.
 */
static int op_checkout(job *j) {
  git_repository *repo = NULL;
  git_reference *branch = NULL, *remote = NULL, *previous = NULL;
  git_commit *commit = NULL;
  checkout_notes notes = {{0}};
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  const char *target = arg(j, "target"), *create = arg(j, "create");
  int force = arg_flag(j, "force"), created = 0;
  sb *b = &j->out;
  j_open(b, NULL, '{');
  if (git_repository_head(&previous, repo) == 0 && git_reference_is_branch(previous))
    j_str(b, "previous", git_reference_shorthand(previous));
  if (arg_flag(j, "orphan")) {
    sb name = {0};
    sb_printf(&name, "refs/heads/%s", create);
    TRY(git_repository_set_head(repo, name.p));
    sb_free(&name);
    j_str(b, "branch", create);
    j_bool(b, "created", 1);
    j_close(b, '}');
    goto done;
  }
  if (create && *create) {
    const char *start = target && *target ? target : "HEAD";
    if ((rc = resolve_commit(j, repo, start, &commit)) < 0) goto done;
    int code = git_branch_create(&branch, repo, create, commit, arg_flag(j, "reset"));
    if (code == GIT_EEXISTS) {
      rc = fail(j, "exists", "%s", create);
      goto done;
    }
    if (code == GIT_EINVALIDSPEC) {
      rc = fail(j, "badname", "%s", create);
      goto done;
    }
    TRY(code);
    if (!arg(j, "track") || arg_flag(j, "track")) track_if_remote(repo, branch, start, b);
    created = 1;
  } else if (!arg_flag(j, "detach") && git_branch_lookup(&branch, repo, target, GIT_BRANCH_LOCAL) == 0) {
    TRY(git_reference_peel((git_object **)&commit, branch, GIT_OBJECT_COMMIT));
  } else if (!arg_flag(j, "detach") && arg_flag(j, "guess")) {
    // DWIM: exactly one remote has a branch by that name.
    git_strarray remotes = {0};
    int matches = 0;
    git_remote_list(&remotes, repo);
    for (size_t i = 0; i < remotes.count; i++) {
      git_reference *candidate = NULL;
      sb name = {0};
      sb_printf(&name, "%s/%s", remotes.strings[i], target);
      if (git_branch_lookup(&candidate, repo, name.p, GIT_BRANCH_REMOTE) == 0) {
        matches++;
        git_reference_free(remote);
        remote = candidate;
      }
      sb_free(&name);
    }
    git_strarray_dispose(&remotes);
    if (matches == 1) {
      TRY(git_reference_peel((git_object **)&commit, remote, GIT_OBJECT_COMMIT));
      TRY(git_branch_create(&branch, repo, target, commit, 0));
      const char *name = NULL;
      git_branch_name(&name, remote);
      if (git_branch_set_upstream(branch, name) == 0) j_str(b, "tracking", name);
      created = 1;
    }
  }
  if (!branch) {
    if (!commit && (!target || resolve_commit(j, repo, target, &commit) < 0)) {
      rc = fail(j, "notfound", "%s", target ? target : "");
      goto done;
    }
    if (!arg_flag(j, "allowDetach")) {
      rc = fail(j, "needdetach", "%s", target);
      goto done;
    }
  }
  git_checkout_options opts = GIT_CHECKOUT_OPTIONS_INIT;
  checkout_options(&opts, &notes, force);
  if (git_repository_head_unborn(repo) == 1) opts.checkout_strategy = GIT_CHECKOUT_SAFE;
  int already = branch && previous && strcmp(git_reference_name(branch), git_reference_name(previous)) == 0;
  if (!already) {
    int code = git_checkout_tree(repo, (git_object *)commit, &opts);
    if (code < 0) {
      if (created) git_branch_delete(branch);
      rc = checkout_failed(j, code, &notes);
      goto done;
    }
    if (branch) TRY(git_repository_set_head(repo, git_reference_name(branch)));
    else TRY(git_repository_set_head_detached(repo, git_commit_id(commit)));
  }
  if (branch) j_str(b, "branch", git_reference_shorthand(branch));
  j_bool(b, "created", created);
  j_bool(b, "already", already);
  j_oid(b, "oid", git_commit_id(commit));
  j_str(b, "subject", git_commit_summary(commit));
  j_head(b, repo);
  j_close(b, '}');
done:
  sb_free(&notes.conflicts);
  git_commit_free(commit);
  git_reference_free(previous);
  git_reference_free(remote);
  git_reference_free(branch);
  git_repository_free(repo);
  return rc;
}

/**
 * restore source= staged= worktree= path=…: put paths back from the index or a commit,
 * into the work tree, the index, or both.
 */
static int op_restore(job *j) {
  git_repository *repo = NULL;
  git_commit *commit = NULL;
  git_index *index = NULL;
  git_pathspec *ps = NULL;
  git_pathspec_match_list *matched = NULL;
  checkout_notes notes = {{0}};
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  git_strarray paths = args_all(j, "path");
  const char *source = arg(j, "source");
  int staged = arg_flag(j, "staged"), worktree = !arg(j, "worktree") || arg_flag(j, "worktree");
  if (staged && (!source || !*source)) source = "HEAD";
  int unborn = git_repository_head_unborn(repo) == 1;
  if (source && *source && !(unborn && strcmp(source, "HEAD") == 0) && (rc = resolve_commit(j, repo, source, &commit)) < 0)
    goto done;
  TRY(git_repository_index(&index, repo));
  // Every pathspec has to match something in the source (or the index).
  TRY(git_pathspec_new(&ps, &paths));
  if (commit) {
    git_tree *tree = NULL;
    TRY(git_commit_tree(&tree, commit));
    rc = git_pathspec_match_tree(&matched, tree, GIT_PATHSPEC_FIND_FAILURES, ps);
    git_tree_free(tree);
    TRY(rc);
  } else {
    TRY(git_pathspec_match_index(&matched, index, GIT_PATHSPEC_FIND_FAILURES, ps));
  }
  if (git_pathspec_match_list_failed_entrycount(matched) && !(staged && !worktree)) {
    rc = fail(j, "nomatch", "%s", git_pathspec_match_list_failed_entry(matched, 0));
    goto done;
  }
  if (staged) TRY(git_reset_default(repo, (git_object *)commit, &paths));
  if (worktree) {
    git_checkout_options opts = GIT_CHECKOUT_OPTIONS_INIT;
    checkout_options(&opts, &notes, 1);
    opts.paths = paths;
    if (commit) {
      if (!staged) opts.checkout_strategy |= GIT_CHECKOUT_DONT_UPDATE_INDEX;
      TRY(git_checkout_tree(repo, (git_object *)commit, &opts));
    } else {
      TRY(git_index_read(index, 1));
      TRY(git_checkout_index(repo, index, &opts));
    }
  }
  sb_puts(&j->out, "null");
done:
  free(paths.strings);
  sb_free(&notes.conflicts);
  git_pathspec_match_list_free(matched);
  git_pathspec_free(ps);
  git_index_free(index);
  git_commit_free(commit);
  git_repository_free(repo);
  return rc;
}

/** reset mode=soft|mixed|hard target= path=…: move HEAD (or reset index paths). */
static int op_reset(job *j) {
  git_repository *repo = NULL;
  git_commit *commit = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  git_strarray paths = args_all(j, "path");
  const char *target = arg(j, "target"), *mode = arg(j, "mode");
  if (!target || !*target) target = "HEAD";
  int unborn = git_repository_head_unborn(repo) == 1 && strcmp(target, "HEAD") == 0;
  if (!unborn && (rc = resolve_commit(j, repo, target, &commit)) < 0) goto done;
  if (paths.count || unborn) {
    TRY(git_reset_default(repo, (git_object *)commit, paths.count ? &paths : NULL));
  } else {
    git_reset_t type = GIT_RESET_MIXED;
    if (mode && strcmp(mode, "soft") == 0) type = GIT_RESET_SOFT;
    if (mode && strcmp(mode, "hard") == 0) type = GIT_RESET_HARD;
    git_checkout_options opts = GIT_CHECKOUT_OPTIONS_INIT;
    opts.checkout_strategy = GIT_CHECKOUT_FORCE;
    TRY(git_reset(repo, (git_object *)commit, type, &opts));
  }
  j_open(&j->out, NULL, '{');
  if (commit) {
    j_oid(&j->out, "oid", git_commit_id(commit));
    j_str(&j->out, "subject", git_commit_summary(commit));
  }
  j_close(&j->out, '}');
done:
  free(paths.strings);
  git_commit_free(commit);
  git_repository_free(repo);
  return rc;
}

static int conflicts_json(sb *b, git_index *index) {
  git_index_conflict_iterator *it = NULL;
  const git_index_entry *ancestor, *ours, *theirs;
  j_open(b, "conflicts", '[');
  if (git_index_conflict_iterator_new(&it, index) == 0)
    while (git_index_conflict_next(&ancestor, &ours, &theirs, it) == 0) {
      const char *path = ours ? ours->path : theirs ? theirs->path : ancestor->path;
      j_open(b, NULL, '{');
      j_str(b, "path", path);
      j_str(b, "kind", !ancestor ? "add/add" : !ours || !theirs ? "modify/delete" : "content");
      j_close(b, '}');
    }
  git_index_conflict_iterator_free(it);
  j_close(b, ']');
  return 0;
}

/**
 * merge target= ffOnly= noFf= noCommit= squash= message= label= favor= abort=: fast-forward, or
 * merge and commit (leaving conflicts in the index and work tree).
 */
static int op_merge(job *j) {
  git_repository *repo = NULL;
  git_annotated_commit *theirs = NULL;
  git_reference *head = NULL, *ref = NULL, *updated = NULL;
  git_commit *head_commit = NULL, *their_commit = NULL;
  git_index *index = NULL;
  git_tree *tree = NULL, *old_tree = NULL, *new_tree = NULL;
  git_signature *sig = NULL;
  git_diff *diff = NULL;
  checkout_notes notes = {{0}};
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  sb *b = &j->out;
  if (arg_flag(j, "abort")) {
    if (git_repository_state(repo) != GIT_REPOSITORY_STATE_MERGE) {
      rc = fail(j, "nomerge", "There is no merge to abort (MERGE_HEAD missing).");
      goto done;
    }
    TRY(resolve_commit(j, repo, "HEAD", &head_commit));
    git_checkout_options opts = GIT_CHECKOUT_OPTIONS_INIT;
    opts.checkout_strategy = GIT_CHECKOUT_FORCE;
    TRY(git_reset(repo, (git_object *)head_commit, GIT_RESET_HARD, &opts));
    git_repository_state_cleanup(repo);
    sb_puts(b, "null");
    goto done;
  }
  const char *target = arg(j, "target");
  if (git_reference_dwim(&ref, repo, target) == 0) TRY(git_annotated_commit_from_ref(&theirs, repo, ref));
  else if (git_annotated_commit_from_revspec(&theirs, repo, target) < 0) {
    rc = fail(j, "badrev", "%s", target);
    goto done;
  }
  git_merge_analysis_t analysis;
  git_merge_preference_t preference;
  TRY(git_merge_analysis(&analysis, &preference, repo, (const git_annotated_commit **)&theirs, 1));
  j_open(b, NULL, '{');
  const git_oid *their_oid = git_annotated_commit_id(theirs);
  if (analysis & GIT_MERGE_ANALYSIS_UP_TO_DATE) {
    j_str(b, "result", "up-to-date");
    j_close(b, '}');
    goto done;
  }
  TRY(git_commit_lookup(&their_commit, repo, their_oid));
  if (analysis & GIT_MERGE_ANALYSIS_UNBORN) {
    git_reference *symbolic = NULL;
    TRY(git_reference_lookup(&symbolic, repo, "HEAD"));
    rc = git_reference_create(&updated, repo, git_reference_symbolic_target(symbolic), their_oid, 0, "initial pull");
    git_reference_free(symbolic);
    TRY(rc);
    git_checkout_options opts = GIT_CHECKOUT_OPTIONS_INIT;
    checkout_options(&opts, &notes, 0);
    TRY(git_checkout_head(repo, &opts));
    j_str(b, "result", "fast-forward");
    j_oid(b, "to", their_oid);
    j_close(b, '}');
    goto done;
  }
  TRY(git_repository_head(&head, repo));
  TRY(git_reference_peel((git_object **)&head_commit, head, GIT_OBJECT_COMMIT));
  TRY(git_commit_tree(&old_tree, head_commit));
  TRY(git_commit_tree(&new_tree, their_commit));
  if ((analysis & GIT_MERGE_ANALYSIS_FASTFORWARD) && !arg_flag(j, "noFf") && !arg_flag(j, "squash")) {
    git_checkout_options opts = GIT_CHECKOUT_OPTIONS_INIT;
    checkout_options(&opts, &notes, 0);
    int code = git_checkout_tree(repo, (git_object *)their_commit, &opts);
    if (code < 0) {
      rc = checkout_failed(j, code, &notes);
      goto done;
    }
    sb reflog = {0};
    sb_printf(&reflog, "merge %s: Fast-forward", target);
    rc = git_reference_set_target(&updated, head, their_oid, reflog.p);
    sb_free(&reflog);
    TRY(rc);
    j_str(b, "result", "fast-forward");
    j_oid(b, "from", git_commit_id(head_commit));
    j_oid(b, "to", their_oid);
  } else if (arg_flag(j, "ffOnly")) {
    rc = fail(j, "notff", "Not possible to fast-forward, aborting.");
    goto done;
  } else {
    // Paths both sides changed since the merge base: git reports them as "Auto-merging".
    git_oid base_oid;
    git_commit *base = NULL;
    git_tree *base_tree = NULL;
    git_diff *ours_diff = NULL, *theirs_diff = NULL;
    j_open(b, "automerged", '[');
    if (git_merge_base(&base_oid, repo, git_commit_id(head_commit), their_oid) == 0 &&
        git_commit_lookup(&base, repo, &base_oid) == 0 && git_commit_tree(&base_tree, base) == 0 &&
        git_diff_tree_to_tree(&ours_diff, repo, base_tree, old_tree, NULL) == 0 &&
        git_diff_tree_to_tree(&theirs_diff, repo, base_tree, new_tree, NULL) == 0) {
      for (size_t i = 0; i < git_diff_num_deltas(ours_diff); i++) {
        const char *path = git_diff_get_delta(ours_diff, i)->new_file.path;
        for (size_t k = 0; k < git_diff_num_deltas(theirs_diff); k++)
          if (strcmp(path, git_diff_get_delta(theirs_diff, k)->new_file.path) == 0) j_str(b, NULL, path);
      }
    }
    j_close(b, ']');
    git_diff_free(ours_diff);
    git_diff_free(theirs_diff);
    git_tree_free(base_tree);
    git_commit_free(base);
    git_merge_options mopts = GIT_MERGE_OPTIONS_INIT;
    const char *favor = arg(j, "favor");
    if (favor && strcmp(favor, "ours") == 0) mopts.file_favor = GIT_MERGE_FILE_FAVOR_OURS;
    if (favor && strcmp(favor, "theirs") == 0) mopts.file_favor = GIT_MERGE_FILE_FAVOR_THEIRS;
    if (favor && strcmp(favor, "union") == 0) mopts.file_favor = GIT_MERGE_FILE_FAVOR_UNION;
    git_checkout_options copts = GIT_CHECKOUT_OPTIONS_INIT;
    checkout_options(&copts, &notes, 0);
    copts.checkout_strategy |= GIT_CHECKOUT_ALLOW_CONFLICTS;
    int code = git_merge(repo, (const git_annotated_commit **)&theirs, 1, &mopts, &copts);
    if (code < 0) {
      rc = checkout_failed(j, code, &notes);
      goto done;
    }
    TRY(git_repository_index(&index, repo));
    if (git_index_has_conflicts(index)) {
      j_str(b, "result", "conflict");
      conflicts_json(b, index);
    } else if (arg_flag(j, "noCommit") || arg_flag(j, "squash")) {
      if (arg_flag(j, "squash")) git_repository_state_cleanup(repo);
      j_str(b, "result", arg_flag(j, "squash") ? "squashed" : "uncommitted");
    } else {
      git_oid tree_oid, oid;
      TRY(git_index_write_tree(&tree_oid, index));
      TRY(git_tree_lookup(&tree, repo, &tree_oid));
      if ((rc = signature_for(j, repo, "committer", &sig)) < 0) goto done;
      const char *label = arg(j, "label");
      sb message = {0};
      if (arg(j, "message")) sb_puts(&message, arg(j, "message"));
      else sb_printf(&message, "Merge %s\n", label && *label ? label : target);
      const git_commit *parents[2] = {head_commit, their_commit};
      rc = git_commit_create(&oid, repo, NULL, sig, sig, NULL, message.p, tree, 2, parents);
      sb_free(&message);
      TRY(rc);
      sb reflog = {0};
      sb_printf(&reflog, "merge %s: Merge made by the 'ort' strategy.", target);
      rc = git_reference_set_target(&updated, head, &oid, reflog.p);
      sb_free(&reflog);
      TRY(rc);
      git_repository_state_cleanup(repo);
      j_str(b, "result", "merged");
      j_oid(b, "oid", &oid);
    }
  }
  if (!(git_repository_state(repo) == GIT_REPOSITORY_STATE_MERGE)) {
    git_diff_options dopts = GIT_DIFF_OPTIONS_INIT;
    if (git_diff_tree_to_tree(&diff, repo, old_tree, new_tree, &dopts) == 0) {
      sb stats = {0};
      git_diff_find_similar(diff, NULL);
      if (git_diff_num_deltas(diff))
        diff_stats_text(diff, GIT_DIFF_STATS_FULL | GIT_DIFF_STATS_INCLUDE_SUMMARY, &stats);
      j_str(b, "stat", stats.p ? stats.p : "");
      sb_free(&stats);
    }
  }
  j_close(b, '}');
done:
  sb_free(&notes.conflicts);
  git_diff_free(diff);
  git_signature_free(sig);
  git_tree_free(tree);
  git_tree_free(old_tree);
  git_tree_free(new_tree);
  git_index_free(index);
  git_commit_free(their_commit);
  git_commit_free(head_commit);
  git_reference_free(updated);
  git_reference_free(ref);
  git_reference_free(head);
  git_annotated_commit_free(theirs);
  git_repository_free(repo);
  return rc;
}

/** tag action=list|create|delete name= target= message= force= pattern= */
static int op_tag(job *j) {
  git_repository *repo = NULL;
  git_object *target = NULL;
  git_signature *sig = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  const char *action = arg(j, "action"), *name = arg(j, "name");
  if (strcmp(action, "list") == 0) {
    git_strarray tags = {0};
    const char *pattern = arg(j, "pattern");
    TRY(git_tag_list_match(&tags, pattern && *pattern ? pattern : "*", repo));
    j_open(&j->out, NULL, '[');
    for (size_t i = 0; i < tags.count; i++) j_str(&j->out, NULL, tags.strings[i]);
    j_close(&j->out, ']');
    git_strarray_dispose(&tags);
  } else if (strcmp(action, "delete") == 0) {
    git_reference *ref = NULL;
    sb full = {0};
    sb_printf(&full, "refs/tags/%s", name);
    int found = git_reference_lookup(&ref, repo, full.p) == 0;
    sb_free(&full);
    if (!found) {
      rc = fail(j, "notfound", "%s", name);
      goto done;
    }
    git_object *obj = NULL;
    git_buf abbrev = GIT_BUF_INIT;
    if (git_object_lookup(&obj, repo, git_reference_target(ref), GIT_OBJECT_ANY) == 0) git_object_short_id(&abbrev, obj);
    j_open(&j->out, NULL, '{');
    j_str(&j->out, "short", abbrev.ptr);
    j_close(&j->out, '}');
    git_buf_dispose(&abbrev);
    git_object_free(obj);
    git_reference_free(ref);
    TRY(git_tag_delete(repo, name));
  } else {
    const char *spec = arg(j, "target");
    if (git_revparse_single(&target, repo, spec && *spec ? spec : "HEAD") < 0) {
      rc = fail(j, "badrev", "%s", spec && *spec ? spec : "HEAD");
      goto done;
    }
    git_oid oid;
    const char *message = arg(j, "message");
    int code;
    if (message) {
      if ((rc = signature_for(j, repo, "committer", &sig)) < 0) goto done;
      code = git_tag_create(&oid, repo, name, target, sig, message, arg_flag(j, "force"));
    } else {
      code = git_tag_create_lightweight(&oid, repo, name, target, arg_flag(j, "force"));
    }
    if (code == GIT_EEXISTS) {
      rc = fail(j, "exists", "%s", name);
      goto done;
    }
    TRY(code);
    sb_puts(&j->out, "null");
  }
done:
  git_signature_free(sig);
  git_object_free(target);
  git_repository_free(repo);
  return rc;
}

static int on_stash(size_t index, const char *message, const git_oid *oid, void *payload) {
  sb *b = payload;
  j_open(b, NULL, '{');
  j_int(b, "index", (int64_t)index);
  j_str(b, "message", message);
  j_oid(b, "oid", oid);
  j_close(b, '}');
  return 0;
}

/** stash action=push|list|apply|pop|drop index= message= untracked= keepIndex= */
static int op_stash(job *j) {
  git_repository *repo = NULL;
  git_signature *sig = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  const char *action = arg(j, "action");
  size_t index = (size_t)arg_int(j, "index", 0);
  if (strcmp(action, "list") == 0) {
    j_open(&j->out, NULL, '[');
    git_stash_foreach(repo, on_stash, &j->out);
    j_close(&j->out, ']');
  } else if (strcmp(action, "push") == 0) {
    if (signature_for(j, repo, "committer", &sig) < 0) {
      // Stashing needs no real identity; git falls back the same way.
      free(j->error);
      j->error = NULL;
      TRY(git_signature_now(&sig, "dsh", "dsh@localhost"));
    }
    git_oid oid;
    uint32_t flags = (arg_flag(j, "untracked") ? GIT_STASH_INCLUDE_UNTRACKED : 0) |
                     (arg_flag(j, "keepIndex") ? GIT_STASH_KEEP_INDEX : 0);
    int code = git_stash_save(&oid, repo, sig, arg(j, "message"), flags);
    if (code == GIT_ENOTFOUND) {
      rc = fail(j, "nothing", "No local changes to save");
      goto done;
    }
    TRY(code);
    j_open(&j->out, NULL, '{');
    j_head(&j->out, repo);
    j_close(&j->out, '}');
  } else if (strcmp(action, "drop") == 0) {
    int code = git_stash_drop(repo, index);
    if (code == GIT_ENOTFOUND) {
      rc = fail(j, "nostash", "stash@{%zu} is not a valid reference", index);
      goto done;
    }
    TRY(code);
    sb_puts(&j->out, "null");
  } else {
    git_stash_apply_options opts = GIT_STASH_APPLY_OPTIONS_INIT;
    if (arg_flag(j, "restoreIndex")) opts.flags |= GIT_STASH_APPLY_REINSTATE_INDEX;
    int code = strcmp(action, "pop") == 0 ? git_stash_pop(repo, index, &opts) : git_stash_apply(repo, index, &opts);
    if (code == GIT_ENOTFOUND) {
      rc = fail(j, "nostash", "stash@{%zu} is not a valid reference", index);
      goto done;
    }
    if (code == GIT_ECONFLICT || code == GIT_EMERGECONFLICT) {
      rc = fail_git(j, code, "overwrite-stash");
      goto done;
    }
    TRY(code);
    sb_puts(&j->out, "null");
  }
done:
  git_signature_free(sig);
  git_repository_free(repo);
  return rc;
}

typedef struct {
  sb *b;
} config_walk;

static const char *level_name(git_config_level_t level) {
  switch (level) {
    case GIT_CONFIG_LEVEL_SYSTEM: return "system";
    case GIT_CONFIG_LEVEL_XDG:
    case GIT_CONFIG_LEVEL_GLOBAL: return "global";
    case GIT_CONFIG_LEVEL_LOCAL: return "local";
    case GIT_CONFIG_LEVEL_WORKTREE: return "worktree";
    default: return "command";
  }
}

/**
 * config action=list|get|get-all|get-regexp|set|add|unset|unset-all scope= key= value= pattern= home=:
 * reads merge every level (or one scope); writes go to the local file unless a scope is given.
 */
static int op_config(job *j) {
  git_repository *repo = NULL;
  git_config *all = NULL, *cfg = NULL;
  git_config_iterator *it = NULL;
  git_config_entry *entry = NULL;
  int rc = 0;
  const char *action = arg(j, "action"), *scope = arg(j, "scope"), *key = arg(j, "key"), *value = arg(j, "value");
  const char *file = arg(j, "file");
  int writing = strcmp(action, "set") == 0 || strcmp(action, "add") == 0 || strncmp(action, "unset", 5) == 0;
  if (file && *file) {
    TRY(git_config_open_ondisk(&cfg, file));
  } else {
    int in_repo = open_repo(j, &repo) == 0;
    free(j->error);
    j->error = NULL;
    if (in_repo) TRY(git_repository_config(&all, repo));
    else TRY(git_config_open_default(&all));
    if (scope && strcmp(scope, "global") == 0) {
      if (git_config_open_level(&cfg, all, GIT_CONFIG_LEVEL_GLOBAL) < 0) {
        // No ~/.gitconfig yet: create it where git would.
        const char *home = arg(j, "home");
        sb path = {0};
        sb_printf(&path, "%s/.gitconfig", home && *home ? home : getenv("HOME"));
        FILE *f = fopen(path.p, "a");
        if (f) fclose(f);
        rc = git_config_open_ondisk(&cfg, path.p);
        sb_free(&path);
        TRY(rc);
      }
    } else if (scope && strcmp(scope, "system") == 0) {
      TRY(git_config_open_level(&cfg, all, GIT_CONFIG_LEVEL_SYSTEM));
    } else if ((scope && strcmp(scope, "local") == 0) || writing) {
      if (!in_repo) {
        rc = fail(j, "notrepo", "not in a git directory");
        goto done;
      }
      TRY(git_config_open_level(&cfg, all, GIT_CONFIG_LEVEL_LOCAL));
    } else {
      cfg = all;
      all = NULL;
    }
  }
  sb *b = &j->out;
  if (strcmp(action, "set") == 0) {
    TRY(git_config_set_string(cfg, key, value));
    sb_puts(b, "null");
  } else if (strcmp(action, "add") == 0) {
    TRY(git_config_set_multivar(cfg, key, "^$", value));
    sb_puts(b, "null");
  } else if (strcmp(action, "unset") == 0 || strcmp(action, "unset-all") == 0) {
    int code = strcmp(action, "unset") == 0 ? git_config_delete_entry(cfg, key) : git_config_delete_multivar(cfg, key, ".*");
    if (code == GIT_ENOTFOUND) {
      rc = fail(j, "nokey", "%s", key);
      goto done;
    }
    TRY(code);
    sb_puts(b, "null");
  } else {
    const char *pattern = arg(j, "pattern");
    if (strcmp(action, "list") == 0) TRY(git_config_iterator_new(&it, cfg));
    else if (strcmp(action, "get-regexp") == 0) TRY(git_config_iterator_glob_new(&it, cfg, pattern));
    else TRY(git_config_multivar_iterator_new(&it, cfg, key, NULL));
    j_open(b, NULL, '[');
    while (git_config_next(&entry, it) == 0) {
      j_open(b, NULL, '{');
      j_str(b, "name", entry->name);
      j_str(b, "value", entry->value);
      j_str(b, "scope", level_name(entry->level));
      j_close(b, '}');
    }
    j_close(b, ']');
  }
done:
  git_config_iterator_free(it);
  git_config_free(cfg);
  git_config_free(all);
  git_repository_free(repo);
  return rc;
}

/** remote action=list|add|remove|rename|set-url|get-url name= url= to= push= */
static int op_remote(job *j) {
  git_repository *repo = NULL;
  git_remote *remote = NULL;
  git_strarray names = {0}, problems = {0};
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  const char *action = arg(j, "action"), *name = arg(j, "name"), *url = arg(j, "url");
  sb *b = &j->out;
  if (strcmp(action, "list") == 0) {
    TRY(git_remote_list(&names, repo));
    j_open(b, NULL, '[');
    for (size_t i = 0; i < names.count; i++) {
      if (git_remote_lookup(&remote, repo, names.strings[i]) < 0) continue;
      j_open(b, NULL, '{');
      j_str(b, "name", names.strings[i]);
      j_str(b, "url", git_remote_url(remote));
      j_str(b, "pushurl", git_remote_pushurl(remote));
      j_close(b, '}');
      git_remote_free(remote);
      remote = NULL;
    }
    j_close(b, ']');
    goto done;
  }
  if (strcmp(action, "add") == 0) {
    int code = git_remote_create(&remote, repo, name, url);
    if (code == GIT_EEXISTS) {
      rc = fail(j, "exists", "%s", name);
      goto done;
    }
    TRY(code);
  } else if (git_remote_lookup(&remote, repo, name) < 0) {
    rc = fail(j, "noremote", "%s", name);
    goto done;
  } else if (strcmp(action, "remove") == 0) {
    TRY(git_remote_delete(repo, name));
  } else if (strcmp(action, "rename") == 0) {
    TRY(git_remote_rename(&problems, repo, name, arg(j, "to")));
  } else if (strcmp(action, "set-url") == 0) {
    if (arg_flag(j, "push")) TRY(git_remote_set_pushurl(repo, name, url));
    else TRY(git_remote_set_url(repo, name, url));
  } else if (strcmp(action, "get-url") == 0) {
    const char *push = git_remote_pushurl(remote);
    j_open(b, NULL, '{');
    j_str(b, "url", arg_flag(j, "push") && push ? push : git_remote_url(remote));
    j_close(b, '}');
    goto done;
  }
  sb_puts(b, "null");
done:
  git_strarray_dispose(&names);
  git_strarray_dispose(&problems);
  git_remote_free(remote);
  git_repository_free(repo);
  return rc;
}

static int remove_tree(const char *path) {
  struct stat st;
  if (lstat(path, &st) < 0) return -1;
  if (!S_ISDIR(st.st_mode)) return unlink(path);
  sb cmd = {0};
  int rc = 0;
  DIR *dir = opendir(path);
  if (dir) {
    struct dirent *e;
    while ((e = readdir(dir))) {
      if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
      cmd.n = 0;
      sb_printf(&cmd, "%s/%s", path, e->d_name);
      if (remove_tree(cmd.p) < 0) rc = -1;
    }
    closedir(dir);
  }
  sb_free(&cmd);
  return rmdir(path) < 0 ? -1 : rc;
}

/** clean dirs= ignored= onlyIgnored= dry= path=…: delete untracked files (and directories). */
static int op_clean(job *j) {
  git_repository *repo = NULL;
  git_status_list *list = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  git_strarray paths = args_all(j, "path");
  int dirs = arg_flag(j, "dirs"), dry = arg_flag(j, "dry");
  int ignored = arg_flag(j, "ignored"), only_ignored = arg_flag(j, "onlyIgnored");
  git_status_options opts = GIT_STATUS_OPTIONS_INIT;
  opts.show = GIT_STATUS_SHOW_WORKDIR_ONLY;
  opts.flags = GIT_STATUS_OPT_INCLUDE_UNTRACKED | (dirs ? 0 : GIT_STATUS_OPT_RECURSE_UNTRACKED_DIRS) |
               (ignored || only_ignored ? GIT_STATUS_OPT_INCLUDE_IGNORED : 0);
  opts.pathspec = paths;
  TRY(git_status_list_new(&list, repo, &opts));
  const char *workdir = git_repository_workdir(repo);
  j_open(&j->out, NULL, '[');
  for (size_t i = 0, n = git_status_list_entrycount(list); i < n; i++) {
    const git_status_entry *e = git_status_byindex(list, i);
    int is_ignored = (e->status & GIT_STATUS_IGNORED) != 0;
    if (!(e->status & (GIT_STATUS_WT_NEW | GIT_STATUS_IGNORED))) continue;
    if (only_ignored ? !is_ignored : (is_ignored && !ignored)) continue;
    const char *path = e->index_to_workdir->new_file.path;
    size_t len = strlen(path);
    if (!dirs && len && path[len - 1] == '/') continue;
    j_str(&j->out, NULL, path);
    if (dry) continue;
    sb full = {0};
    sb_printf(&full, "%s%s", workdir, path);
    if (full.n && full.p[full.n - 1] == '/') full.p[--full.n] = 0;
    remove_tree(full.p);
    sb_free(&full);
  }
  j_close(&j->out, ']');
done:
  free(paths.strings);
  git_status_list_free(list);
  git_repository_free(repo);
  return rc;
}

/** worktree action=list|add|remove|prune path= name= branch= create= commit= force= noCheckout= */
static int op_worktree(job *j) {
  git_repository *repo = NULL, *wt_repo = NULL;
  git_worktree *wt = NULL;
  git_reference *branch = NULL;
  git_commit *commit = NULL;
  git_strarray names = {0};
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  const char *action = arg(j, "action");
  sb *b = &j->out;
  if (strcmp(action, "list") == 0) {
    git_repository *main = NULL;
    // From a linked worktree, list from the main repository.
    if (git_repository_is_worktree(repo)) TRY(git_repository_open(&main, git_repository_commondir(repo)));
    git_repository *base = main ? main : repo;
    j_open(b, NULL, '[');
    j_open(b, NULL, '{');
    j_str(b, "path", git_repository_workdir(base) ? git_repository_workdir(base) : git_repository_path(base));
    j_bool(b, "bare", git_repository_is_bare(base));
    j_head(b, base);
    j_close(b, '}');
    TRY(git_worktree_list(&names, base));
    for (size_t i = 0; i < names.count; i++) {
      if (git_worktree_lookup(&wt, base, names.strings[i]) < 0) continue;
      j_open(b, NULL, '{');
      j_str(b, "name", names.strings[i]);
      j_str(b, "path", git_worktree_path(wt));
      j_bool(b, "locked", git_worktree_is_locked(NULL, wt) > 0);
      j_bool(b, "prunable", git_worktree_validate(wt) < 0);
      if (git_repository_open_from_worktree(&wt_repo, wt) == 0) j_head(b, wt_repo);
      git_repository_free(wt_repo);
      wt_repo = NULL;
      j_close(b, '}');
      git_worktree_free(wt);
      wt = NULL;
    }
    j_close(b, ']');
    git_repository_free(main);
  } else if (strcmp(action, "add") == 0) {
    const char *path = arg(j, "path"), *name = arg(j, "name"), *create = arg(j, "create"), *existing = arg(j, "branch");
    const char *from = arg(j, "commit");
    git_worktree_add_options opts = GIT_WORKTREE_ADD_OPTIONS_INIT;
    if (create && *create) {
      if ((rc = resolve_commit(j, repo, from && *from ? from : "HEAD", &commit)) < 0) goto done;
      int code = git_branch_create(&branch, repo, create, commit, arg_flag(j, "force"));
      if (code == GIT_EEXISTS) {
        rc = fail(j, "exists", "%s", create);
        goto done;
      }
      TRY(code);
      opts.ref = branch;
    } else if (existing && *existing) {
      if (git_branch_lookup(&branch, repo, existing, GIT_BRANCH_LOCAL) < 0) {
        rc = fail(j, "notfound", "%s", existing);
        goto done;
      }
      if (git_branch_is_checked_out(branch) == 1 && !arg_flag(j, "force")) {
        rc = fail(j, "checkedout", "%s", existing);
        goto done;
      }
      opts.ref = branch;
    }
    if (arg_flag(j, "noCheckout")) opts.checkout_options.checkout_strategy = GIT_CHECKOUT_NONE;
    TRY(git_worktree_add(&wt, repo, name, path, &opts));
    if (!opts.ref && from && *from) {
      // Detached at a commit: libgit2 makes a branch named after the worktree; git does not.
      if ((rc = resolve_commit(j, repo, from, &commit)) < 0) goto done;
      TRY(git_repository_open_from_worktree(&wt_repo, wt));
      TRY(git_repository_set_head_detached(wt_repo, git_commit_id(commit)));
      git_checkout_options copts = GIT_CHECKOUT_OPTIONS_INIT;
      copts.checkout_strategy = GIT_CHECKOUT_FORCE;
      TRY(git_checkout_head(wt_repo, &copts));
    }
    j_open(b, NULL, '{');
    j_str(b, "path", git_worktree_path(wt));
    j_close(b, '}');
  } else if (strcmp(action, "remove") == 0) {
    const char *path = arg(j, "path");
    // A crash here takes the whole app down: no path matches no worktree.
    if (!path) path = "";
    TRY(git_worktree_list(&names, repo));
    for (size_t i = 0; i < names.count && !wt; i++) {
      if (git_worktree_lookup(&wt, repo, names.strings[i]) < 0) continue;
      const char *wpath = git_worktree_path(wt);
      size_t n = strlen(path);
      while (n > 1 && path[n - 1] == '/') n--;
      if (!(path[0] && (strcmp(names.strings[i], path) == 0 || (strncmp(wpath, path, n) == 0 && (!wpath[n] || wpath[n] == '/'))))) {
        git_worktree_free(wt);
        wt = NULL;
      }
    }
    if (!wt) {
      rc = fail(j, "notworktree", "'%s' is not a working tree", path);
      goto done;
    }
    if (!arg_flag(j, "force") && git_repository_open_from_worktree(&wt_repo, wt) == 0) {
      git_status_list *list = NULL;
      git_status_options sopts = GIT_STATUS_OPTIONS_INIT;
      sopts.flags = GIT_STATUS_OPT_INCLUDE_UNTRACKED;
      size_t dirty = git_status_list_new(&list, wt_repo, &sopts) == 0 ? git_status_list_entrycount(list) : 0;
      git_status_list_free(list);
      if (dirty) {
        rc = fail(j, "dirty", "'%s' contains modified or untracked files, use --force to delete it", path);
        goto done;
      }
    }
    git_worktree_prune_options popts = GIT_WORKTREE_PRUNE_OPTIONS_INIT;
    popts.flags = GIT_WORKTREE_PRUNE_VALID | GIT_WORKTREE_PRUNE_WORKING_TREE |
                  (arg_flag(j, "force") ? GIT_WORKTREE_PRUNE_LOCKED : 0);
    TRY(git_worktree_prune(wt, &popts));
    sb_puts(b, "null");
  } else {
    // prune: drop records whose directories are gone.
    TRY(git_worktree_list(&names, repo));
    for (size_t i = 0; i < names.count; i++) {
      if (git_worktree_lookup(&wt, repo, names.strings[i]) < 0) continue;
      if (git_worktree_is_prunable(wt, NULL) > 0) git_worktree_prune(wt, NULL);
      git_worktree_free(wt);
      wt = NULL;
    }
    sb_puts(b, "null");
  }
done:
  git_strarray_dispose(&names);
  git_commit_free(commit);
  git_reference_free(branch);
  git_worktree_free(wt);
  git_repository_free(wt_repo);
  git_repository_free(repo);
  return rc;
}

int ops_refs(const char *name, op_fn *out) {
  static const struct {
    const char *name;
    op_fn fn;
  } table[] = {
      {"branches", op_branches},           {"branch-create", op_branch_create},
      {"branch-delete", op_branch_delete}, {"branch-rename", op_branch_rename},
      {"branch-upstream", op_branch_upstream}, {"checkout", op_checkout},
      {"restore", op_restore},             {"reset", op_reset},
      {"merge", op_merge},                 {"tag", op_tag},
      {"stash", op_stash},                 {"config", op_config},
      {"remote", op_remote},               {"clean", op_clean},
      {"worktree", op_worktree},
  };
  for (size_t i = 0; i < sizeof table / sizeof table[0]; i++)
    if (strcmp(table[i].name, name) == 0) {
      *out = table[i].fn;
      return 1;
    }
  return 0;
}
