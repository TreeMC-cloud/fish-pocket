// Network ops over HTTPS (Security.framework): clone, fetch, push, ls-remote.
#include "dsh_git.h"

#include <stdlib.h>
#include <string.h>

int ops_repo(const char *name, op_fn *out);
int ops_history(const char *name, op_fn *out);
int ops_refs(const char *name, op_fn *out);

/** A named remote, or an anonymous one for a URL. */
static int remote_for(job *j, git_repository *repo, const char *name, git_remote **out) {
  if (git_remote_lookup(out, repo, name) == 0) return 0;
  if (strstr(name, "://") || strchr(name, '@') || name[0] == '/' || name[0] == '.') {
    if (git_remote_create_anonymous(out, repo, name) == 0) return 0;
  }
  return fail(j, "noremote", "'%s' does not appear to be a git repository", name);
}

typedef struct {
  job *j;
  sb *b;
} update_ctx;

static int on_update_refs(const char *refname, const git_oid *a, const git_oid *b, git_refspec *spec, void *payload) {
  update_ctx *c = payload;
  git_buf source = GIT_BUF_INIT;
  j_open(c->b, NULL, '{');
  j_str(c->b, "ref", refname);
  if (spec && git_refspec_rtransform(&source, spec, refname) == 0) j_str(c->b, "source", source.ptr);
  j_oid(c->b, "old", git_oid_is_zero(a) ? NULL : a);
  j_oid(c->b, "new", git_oid_is_zero(b) ? NULL : b);
  j_close(c->b, '}');
  git_buf_dispose(&source);
  return 0;
}

/** clone url= path= branch= depth= bare=: the repository and the branch it checked out. */
static int op_clone(job *j) {
  git_repository *repo = NULL;
  int rc = 0;
  git_clone_options opts = GIT_CLONE_OPTIONS_INIT;
  remote_callbacks(j, &opts.fetch_opts.callbacks);
  const char *branch = arg(j, "branch");
  if (branch && *branch) opts.checkout_branch = branch;
  opts.fetch_opts.depth = arg_int(j, "depth", 0);
  opts.bare = arg_flag(j, "bare");
  if (arg_flag(j, "noCheckout")) opts.checkout_opts.checkout_strategy = GIT_CHECKOUT_NONE;
  int code = git_clone(&repo, arg(j, "url"), arg(j, "path"), &opts);
  if (code < 0) {
    rc = fail_git(j, code, "network");
    goto done;
  }
  j_open(&j->out, NULL, '{');
  j_str(&j->out, "gitdir", git_repository_path(repo));
  j_bool(&j->out, "empty", git_repository_is_empty(repo) == 1);
  j_head(&j->out, repo);
  j_close(&j->out, '}');
done:
  git_repository_free(repo);
  return rc;
}

/** fetch remote= refspec=… depth= prune= tags=all|none|auto: updated refs. */
static int op_fetch(job *j) {
  git_repository *repo = NULL;
  git_remote *remote = NULL;
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  const char *name = arg(j, "remote");
  if ((rc = remote_for(j, repo, name && *name ? name : "origin", &remote)) < 0) goto done;
  git_strarray refspecs = args_all(j, "refspec");
  git_fetch_options opts = GIT_FETCH_OPTIONS_INIT;
  remote_callbacks(j, &opts.callbacks);
  sb *b = &j->out;
  update_ctx ctx = {j, b};
  opts.depth = arg_int(j, "depth", 0);
  if (arg_flag(j, "unshallow")) opts.depth = GIT_FETCH_DEPTH_UNSHALLOW;
  if (arg_flag(j, "prune")) opts.prune = GIT_FETCH_PRUNE;
  const char *tags = arg(j, "tags");
  if (tags && strcmp(tags, "all") == 0) opts.download_tags = GIT_REMOTE_DOWNLOAD_TAGS_ALL;
  if (tags && strcmp(tags, "none") == 0) opts.download_tags = GIT_REMOTE_DOWNLOAD_TAGS_NONE;
  j_open(b, NULL, '{');
  j_str(b, "url", git_remote_url(remote));
  j_open(b, "updates", '[');
  // Connect and download with the job as payload (credentials need it), then
  // update tips with the writer as payload to report each ref.
  int code = git_remote_connect(remote, GIT_DIRECTION_FETCH, &opts.callbacks, &opts.proxy_opts, &opts.custom_headers);
  if (code == 0) code = git_remote_download(remote, refspecs.count ? &refspecs : NULL, &opts);
  if (code == 0) {
    git_remote_callbacks cb = opts.callbacks;
    cb.update_refs = on_update_refs;
    cb.payload = &ctx;
    code = git_remote_update_tips(remote, &cb, GIT_REMOTE_UPDATE_FETCHHEAD, opts.download_tags, "fetch");
  }
  if (code == 0 && opts.prune == GIT_FETCH_PRUNE) {
    git_remote_callbacks cb = opts.callbacks;
    cb.update_refs = on_update_refs;
    cb.payload = &ctx;
    code = git_remote_prune(remote, &cb);
  }
  git_remote_disconnect(remote);
  free(refspecs.strings);
  if (code < 0) {
    rc = fail_git(j, code, "network");
    goto done;
  }
  j_close(b, ']');
  j_close(b, '}');
done:
  git_remote_free(remote);
  git_repository_free(repo);
  return rc;
}

typedef struct {
  job *j;
  sb negotiated;
  sb statuses;
} push_ctx;

static int on_negotiation(const git_push_update **updates, size_t len, void *payload) {
  push_ctx *c = payload;
  for (size_t i = 0; i < len; i++) {
    j_open(&c->negotiated, NULL, '{');
    j_str(&c->negotiated, "src", updates[i]->src_refname);
    j_str(&c->negotiated, "dst", updates[i]->dst_refname);
    j_oid(&c->negotiated, "old", git_oid_is_zero(&updates[i]->src) ? NULL : &updates[i]->src);
    j_oid(&c->negotiated, "new", git_oid_is_zero(&updates[i]->dst) ? NULL : &updates[i]->dst);
    j_close(&c->negotiated, '}');
  }
  return 0;
}

static int on_push_status(const char *refname, const char *status, void *payload) {
  push_ctx *c = payload;
  j_open(&c->statuses, NULL, '{');
  j_str(&c->statuses, "ref", refname);
  j_str(&c->statuses, "error", status);
  j_close(&c->statuses, '}');
  return 0;
}

static int push_credentials(git_credential **out, const char *url, const char *user, unsigned int allowed, void *payload) {
  push_ctx *c = payload;
  git_remote_callbacks base = GIT_REMOTE_CALLBACKS_INIT;
  remote_callbacks(c->j, &base);
  return base.credentials(out, url, user, allowed, c->j);
}

/** push remote= refspec=…: what was negotiated and how each ref fared. */
static int op_push(job *j) {
  git_repository *repo = NULL;
  git_remote *remote = NULL;
  push_ctx ctx = {j, {0}, {0}};
  int rc = open_repo(j, &repo);
  if (rc < 0) return rc;
  const char *name = arg(j, "remote");
  if ((rc = remote_for(j, repo, name && *name ? name : "origin", &remote)) < 0) goto done;
  git_strarray refspecs = args_all(j, "refspec");
  git_push_options opts = GIT_PUSH_OPTIONS_INIT;
  opts.callbacks.credentials = push_credentials;
  opts.callbacks.push_negotiation = on_negotiation;
  opts.callbacks.push_update_reference = on_push_status;
  opts.callbacks.payload = &ctx;
  int code = git_remote_push(remote, &refspecs, &opts);
  free(refspecs.strings);
  if (code < 0) {
    rc = fail_git(j, code, "network");
    goto done;
  }
  sb *b = &j->out;
  j_open(b, NULL, '{');
  j_str(b, "url", git_remote_pushurl(remote) ? git_remote_pushurl(remote) : git_remote_url(remote));
  j_open(b, "updates", '[');
  if (ctx.negotiated.p) sb_put(b, ctx.negotiated.p, ctx.negotiated.n);
  j_close(b, ']');
  j_open(b, "statuses", '[');
  if (ctx.statuses.p) sb_put(b, ctx.statuses.p, ctx.statuses.n);
  j_close(b, ']');
  j_close(b, '}');
done:
  sb_free(&ctx.negotiated);
  sb_free(&ctx.statuses);
  git_remote_free(remote);
  git_repository_free(repo);
  return rc;
}

/** ls-remote remote=: the refs a remote advertises (works outside a repository). */
static int op_ls_remote(job *j) {
  git_repository *repo = NULL;
  git_remote *remote = NULL;
  const git_remote_head **heads = NULL;
  size_t count = 0;
  int rc = 0;
  const char *name = arg(j, "remote");
  if (open_repo(j, &repo) == 0) {
    rc = remote_for(j, repo, name, &remote);
  } else {
    free(j->error);
    j->error = NULL;
    rc = git_remote_create_detached(&remote, name) < 0 ? fail(j, "noremote", "'%s' does not appear to be a git repository", name) : 0;
  }
  if (rc < 0) goto done;
  git_remote_callbacks cb = GIT_REMOTE_CALLBACKS_INIT;
  remote_callbacks(j, &cb);
  int code = git_remote_connect(remote, GIT_DIRECTION_FETCH, &cb, NULL, NULL);
  if (code == 0) code = git_remote_ls(&heads, &count, remote);
  if (code < 0) {
    rc = fail_git(j, code, "network");
    goto done;
  }
  j_open(&j->out, NULL, '[');
  for (size_t i = 0; i < count; i++) {
    j_open(&j->out, NULL, '{');
    j_str(&j->out, "name", heads[i]->name);
    j_oid(&j->out, "oid", &heads[i]->oid);
    j_str(&j->out, "symref", heads[i]->symref_target);
    j_close(&j->out, '}');
  }
  j_close(&j->out, ']');
  git_remote_disconnect(remote);
done:
  git_remote_free(remote);
  git_repository_free(repo);
  return rc;
}

op_fn find_op(const char *name) {
  op_fn fn = NULL;
  if (ops_repo(name, &fn) || ops_history(name, &fn) || ops_refs(name, &fn)) return fn;
  if (strcmp(name, "clone") == 0) return op_clone;
  if (strcmp(name, "fetch") == 0) return op_fetch;
  if (strcmp(name, "push") == 0) return op_push;
  if (strcmp(name, "ls-remote") == 0) return op_ls_remote;
  return NULL;
}
