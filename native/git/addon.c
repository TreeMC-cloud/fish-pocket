// N-API glue, the JSON writer, and what every op shares: opening the
// repository the caller selected and answering credential prompts.
#include "dsh_git.h"

#include <node_api.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ---- buffers and JSON -----------------------------------------------------

void sb_put(sb *b, const char *s, size_t n) {
  if (b->n + n + 1 > b->cap) {
    size_t cap = b->cap ? b->cap : 256;
    while (cap < b->n + n + 1) cap *= 2;
    b->p = realloc(b->p, cap);
    b->cap = cap;
  }
  memcpy(b->p + b->n, s, n);
  b->n += n;
  b->p[b->n] = 0;
}

void sb_puts(sb *b, const char *s) { sb_put(b, s, strlen(s)); }

void sb_printf(sb *b, const char *fmt, ...) {
  char small[256];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(small, sizeof small, fmt, ap);
  va_end(ap);
  if (n < (int)sizeof small) {
    sb_put(b, small, (size_t)n);
    return;
  }
  char *big = malloc((size_t)n + 1);
  va_start(ap, fmt);
  vsnprintf(big, (size_t)n + 1, fmt, ap);
  va_end(ap);
  sb_put(b, big, (size_t)n);
  free(big);
}

void sb_free(sb *b) {
  free(b->p);
  b->p = NULL;
  b->n = b->cap = 0;
}

static void j_escape(sb *b, const char *s, size_t n) {
  sb_put(b, "\"", 1);
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    switch (c) {
      case '"': sb_put(b, "\\\"", 2); break;
      case '\\': sb_put(b, "\\\\", 2); break;
      case '\n': sb_put(b, "\\n", 2); break;
      case '\r': sb_put(b, "\\r", 2); break;
      case '\t': sb_put(b, "\\t", 2); break;
      default:
        if (c < 0x20) sb_printf(b, "\\u%04x", c);
        else sb_put(b, (const char *)&s[i], 1);
    }
  }
  sb_put(b, "\"", 1);
}

static void j_key(sb *b, const char *key) {
  if (!key) return;
  j_escape(b, key, strlen(key));
  sb_put(b, ":", 1);
}

void j_open(sb *b, const char *key, char bracket) {
  j_key(b, key);
  sb_put(b, &bracket, 1);
}

void j_close(sb *b, char bracket) {
  if (b->n && b->p[b->n - 1] == ',') b->n--;
  sb_put(b, &bracket, 1);
  sb_put(b, ",", 1);
}

void j_strn(sb *b, const char *key, const char *value, size_t n) {
  j_key(b, key);
  if (value) j_escape(b, value, n);
  else sb_puts(b, "null");
  sb_put(b, ",", 1);
}

void j_str(sb *b, const char *key, const char *value) { j_strn(b, key, value, value ? strlen(value) : 0); }

void j_int(sb *b, const char *key, int64_t value) {
  j_key(b, key);
  sb_printf(b, "%lld,", (long long)value);
}

void j_bool(sb *b, const char *key, int value) {
  j_key(b, key);
  sb_puts(b, value ? "true," : "false,");
}

void j_oid(sb *b, const char *key, const git_oid *oid) {
  if (!oid) {
    j_str(b, key, NULL);
    return;
  }
  char hex[GIT_OID_MAX_HEXSIZE + 1];
  git_oid_tostr(hex, sizeof hex, oid);
  j_str(b, key, hex);
}

void j_sig(sb *b, const char *key, const git_signature *sig) {
  j_open(b, key, '{');
  j_str(b, "name", sig->name);
  j_str(b, "email", sig->email);
  j_int(b, "time", sig->when.time);
  j_int(b, "offset", sig->when.offset);
  j_close(b, '}');
}

// ---- arguments and errors ---------------------------------------------------

const char *arg(job *j, const char *key) {
  size_t n = strlen(key);
  for (int i = 0; i < j->argc; i++)
    if (strncmp(j->argv[i], key, n) == 0 && j->argv[i][n] == '=') return j->argv[i] + n + 1;
  return NULL;
}

int arg_flag(job *j, const char *key) {
  const char *v = arg(j, key);
  return v && *v && strcmp(v, "0") != 0;
}

int arg_int(job *j, const char *key, int fallback) {
  const char *v = arg(j, key);
  return v && *v ? atoi(v) : fallback;
}

git_strarray args_all(job *j, const char *key) {
  size_t n = strlen(key), count = 0;
  for (int i = 0; i < j->argc; i++)
    if (strncmp(j->argv[i], key, n) == 0 && j->argv[i][n] == '=') count++;
  git_strarray out = {NULL, 0};
  if (!count) return out;
  out.strings = calloc(count, sizeof(char *));
  for (int i = 0; i < j->argc; i++)
    if (strncmp(j->argv[i], key, n) == 0 && j->argv[i][n] == '=') out.strings[out.count++] = j->argv[i] + n + 1;
  return out;
}

int fail(job *j, const char *kind, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  free(j->error);
  if (vasprintf(&j->error, fmt, ap) < 0) j->error = NULL;
  va_end(ap);
  snprintf(j->kind, sizeof j->kind, "%s", kind);
  return -1;
}

int fail_git(job *j, int code, const char *kind) {
  const git_error *e = git_error_last();
  const char *message = e && e->message && *e->message ? e->message : "unknown error";
  if (code == GIT_EUSER && j->cancelled) return fail(j, "cancelled", "operation cancelled");
  if (code == GIT_EAUTH || (e && e->klass == GIT_ERROR_HTTP && strstr(message, "authentication")))
    return fail(j, "auth", "%s", message);
  return fail(j, kind, "%s", message);
}

// ---- repository selection ---------------------------------------------------

/** A primary object directory, read-write, with the repository's as alternates. */
static int object_directory(job *j, git_repository *repo) {
  git_odb *odb = NULL;
  git_odb_backend *loose = NULL, *packed = NULL;
  int rc = 0;
  TRY(git_odb_new(&odb));
  TRY(git_odb_backend_loose(&loose, j->opt[O_OBJECT_DIR], -1, 0, 0, 0));
  TRY(git_odb_add_backend(odb, loose, 2));
  loose = NULL;
  TRY(git_odb_backend_pack(&packed, j->opt[O_OBJECT_DIR]));
  TRY(git_odb_add_backend(odb, packed, 1));
  packed = NULL;
  git_repository_set_odb(repo, odb);
done:
  if (loose) loose->free(loose);
  if (packed) packed->free(packed);
  git_odb_free(odb);
  return rc;
}

static int alternates(job *j, git_repository *repo) {
  git_odb *odb = NULL;
  int rc = 0;
  TRY(git_repository_odb(&odb, repo));
  char *list = strdup(j->opt[O_ALTERNATES]);
  for (char *save = NULL, *dir = strtok_r(list, ":", &save); dir; dir = strtok_r(NULL, ":", &save))
    if (*dir && git_odb_add_disk_alternate(odb, dir) < 0) {
      rc = fail_git(j, -1, "git");
      break;
    }
  free(list);
done:
  git_odb_free(odb);
  return rc;
}

/**
 * The repository the command runs against: GIT_DIR (and GIT_WORK_TREE) when
 * set, otherwise discovered upward from cwd; GIT_INDEX_FILE,
 * GIT_OBJECT_DIRECTORY and GIT_ALTERNATE_OBJECT_DIRECTORIES as git applies
 * them. The caller's environment never reaches the process environment, so
 * each override is applied here.
 */
int open_repo(job *j, git_repository **out) {
  git_repository *repo = NULL;
  git_index *index = NULL;
  int rc = 0;
  const char *gitdir = j->opt[O_GIT_DIR];
  int code = gitdir ? git_repository_open_ext(&repo, gitdir, GIT_REPOSITORY_OPEN_NO_SEARCH, NULL)
                    : git_repository_open_ext(&repo, j->opt[O_CWD], 0, NULL);
  if (code == GIT_ENOTFOUND) {
    rc = fail(j, "notrepo", "not a git repository (or any of the parent directories): .git");
    goto done;
  }
  TRY(code);
  if (j->opt[O_WORK_TREE]) TRY(git_repository_set_workdir(repo, j->opt[O_WORK_TREE], 0));
  if (j->opt[O_INDEX_FILE]) {
    TRY(git_index_open(&index, j->opt[O_INDEX_FILE]));
    git_repository_set_index(repo, index);
  }
  if (j->opt[O_OBJECT_DIR] && (rc = object_directory(j, repo)) < 0) goto done;
  if (j->opt[O_ALTERNATES] && (rc = alternates(j, repo)) < 0) goto done;
  *out = repo;
  repo = NULL;
done:
  git_index_free(index);
  git_repository_free(repo);
  return rc;
}

int resolve_commit(job *j, git_repository *repo, const char *spec, git_commit **out) {
  git_object *obj = NULL;
  int code = git_revparse_single(&obj, repo, spec);
  if (code < 0) return fail(j, "badrev", "%s", spec);
  code = git_object_peel((git_object **)out, obj, GIT_OBJECT_COMMIT);
  git_object_free(obj);
  return code < 0 ? fail(j, "notcommit", "%s", spec) : 0;
}

int signature_for(job *j, git_repository *repo, const char *prefix, git_signature **out) {
  char key[64];
  snprintf(key, sizeof key, "%sName", prefix);
  const char *name = arg(j, key);
  snprintf(key, sizeof key, "%sEmail", prefix);
  const char *email = arg(j, key);
  snprintf(key, sizeof key, "%sTime", prefix);
  const char *when = arg(j, key);
  git_signature *base = NULL;
  if (!name || !*name || !email) {
    if (git_signature_default(&base, repo) < 0) return fail(j, "noident", "unable to auto-detect email address");
    if (!name || !*name) name = base->name;
    if (!email) email = base->email;
  }
  int code;
  if (when && *when) {
    long long seconds = 0;
    int offset = 0;
    sscanf(when, "%lld %d", &seconds, &offset);
    code = git_signature_new(out, name, email, (git_time_t)seconds, offset);
  } else {
    code = git_signature_now(out, name, email);
  }
  git_signature_free(base);
  return code < 0 ? fail_git(j, code, "noident") : 0;
}

// ---- remotes ----------------------------------------------------------------

static int on_credentials(git_credential **out, const char *url, const char *username_from_url,
                          unsigned int allowed, void *payload) {
  (void)url;
  job *j = payload;
  if (!(allowed & GIT_CREDENTIAL_USERPASS_PLAINTEXT) || !j->opt[O_PASSWORD] || j->credential_attempts++ > 0) {
    git_error_set_str(GIT_ERROR_HTTP, "authentication required but no usable credentials");
    return GIT_EAUTH;
  }
  const char *user = j->opt[O_USERNAME] ? j->opt[O_USERNAME] : username_from_url ? username_from_url : "git";
  return git_credential_userpass_plaintext_new(out, user, j->opt[O_PASSWORD]);
}

static int on_progress(const git_indexer_progress *stats, void *payload) {
  (void)stats;
  return ((job *)payload)->cancelled ? GIT_EUSER : 0;
}

void remote_callbacks(job *j, git_remote_callbacks *cb) {
  cb->credentials = on_credentials;
  cb->transfer_progress = on_progress;
  cb->payload = j;
}

// ---- shared fragments -------------------------------------------------------

const char *repo_state_name(int state) {
  switch (state) {
    case GIT_REPOSITORY_STATE_MERGE: return "merge";
    case GIT_REPOSITORY_STATE_REVERT:
    case GIT_REPOSITORY_STATE_REVERT_SEQUENCE: return "revert";
    case GIT_REPOSITORY_STATE_CHERRYPICK:
    case GIT_REPOSITORY_STATE_CHERRYPICK_SEQUENCE: return "cherry-pick";
    case GIT_REPOSITORY_STATE_BISECT: return "bisect";
    case GIT_REPOSITORY_STATE_REBASE:
    case GIT_REPOSITORY_STATE_REBASE_INTERACTIVE:
    case GIT_REPOSITORY_STATE_REBASE_MERGE: return "rebase";
    case GIT_REPOSITORY_STATE_APPLY_MAILBOX:
    case GIT_REPOSITORY_STATE_APPLY_MAILBOX_OR_REBASE: return "am";
    default: return NULL;
  }
}

/**
 * HEAD as the status line needs it: branch (or detached), commit, whether the
 * branch is unborn, and its upstream with ahead/behind counts.
 */
void j_head(sb *b, git_repository *repo) {
  git_reference *head = NULL, *resolved = NULL, *upstream = NULL;
  j_open(b, "head", '{');
  if (git_reference_lookup(&head, repo, "HEAD") == 0 && git_reference_type(head) == GIT_REFERENCE_SYMBOLIC) {
    const char *target = git_reference_symbolic_target(head);
    j_str(b, "ref", target);
    j_str(b, "branch", strncmp(target, "refs/heads/", 11) == 0 ? target + 11 : target);
    j_bool(b, "detached", 0);
  } else {
    j_bool(b, "detached", 1);
  }
  if (git_reference_resolve(&resolved, head) == 0) {
    const git_oid *oid = git_reference_target(resolved);
    j_oid(b, "oid", oid);
    j_bool(b, "unborn", 0);
    git_buf name = GIT_BUF_INIT;
    if (git_reference_is_branch(resolved) && git_branch_upstream_name(&name, repo, git_reference_name(resolved)) == 0) {
      j_str(b, "upstream", strncmp(name.ptr, "refs/remotes/", 13) == 0 ? name.ptr + 13 : name.ptr);
      if (git_reference_lookup(&upstream, repo, name.ptr) == 0) {
        size_t ahead = 0, behind = 0;
        git_graph_ahead_behind(&ahead, &behind, repo, oid, git_reference_target(upstream));
        j_int(b, "ahead", (int64_t)ahead);
        j_int(b, "behind", (int64_t)behind);
      } else {
        j_bool(b, "gone", 1);
      }
    }
    git_buf_dispose(&name);
  } else {
    j_bool(b, "unborn", 1);
  }
  j_close(b, '}');
  git_reference_free(upstream);
  git_reference_free(resolved);
  git_reference_free(head);
}

int diff_stats_text(git_diff *diff, git_diff_stats_format_t format, sb *out) {
  git_diff_stats *stats = NULL;
  git_buf buf = GIT_BUF_INIT;
  int code = git_diff_get_stats(&stats, diff);
  if (code == 0) code = git_diff_stats_to_buf(&buf, stats, format, 80);
  if (code == 0 && buf.ptr) sb_puts(out, buf.ptr);
  git_buf_dispose(&buf);
  git_diff_stats_free(stats);
  return code;
}

// ---- N-API ------------------------------------------------------------------

static char *string_value(napi_env env, napi_value value) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return NULL;
  size_t n = 0;
  napi_get_value_string_utf8(env, value, NULL, 0, &n);
  char *s = malloc(n + 1);
  napi_get_value_string_utf8(env, value, s, n + 1, &n);
  return s;
}

typedef struct {
  job j;
  napi_deferred deferred;
  napi_async_work work;
  napi_ref cancel_ref;
} task;

static void execute(napi_env env, void *data) {
  (void)env;
  task *t = data;
  op_fn fn = find_op(t->j.op);
  git_error_clear();
  if (!fn) fail(&t->j, "usage", "unknown op: %s", t->j.op);
  else if (fn(&t->j) < 0 && !t->j.error) fail(&t->j, "git", "operation failed");
}

static void complete(napi_env env, napi_status status, void *data) {
  task *t = data;
  job *j = &t->j;
  if (status != napi_ok && !j->error) fail(j, "cancelled", "operation cancelled");
  if (j->error) {
    napi_value message, code, error;
    napi_create_string_utf8(env, j->error, NAPI_AUTO_LENGTH, &message);
    napi_create_string_utf8(env, j->kind, NAPI_AUTO_LENGTH, &code);
    napi_create_error(env, code, message, &error);
    napi_reject_deferred(env, t->deferred, error);
  } else {
    napi_value result, json, buffer;
    napi_create_object(env, &result);
    if (j->out.n && j->out.p[j->out.n - 1] == ',') j->out.n--;
    napi_create_string_utf8(env, j->out.n ? j->out.p : "null", j->out.n ? j->out.n : 4, &json);
    napi_set_named_property(env, result, "json", json);
    if (j->has_data) {
      void *copy;
      napi_create_buffer_copy(env, j->data.n, j->data.p ? j->data.p : "", &copy, &buffer);
      napi_set_named_property(env, result, "data", buffer);
    }
    napi_resolve_deferred(env, t->deferred, result);
  }
  napi_delete_async_work(env, t->work);
  if (t->cancel_ref) napi_delete_reference(env, t->cancel_ref);
  free(j->op);
  for (int i = 0; i < j->argc; i++) free(j->argv[i]);
  free(j->argv);
  for (int i = 0; i < O_COUNT; i++) free(j->opt[i]);
  sb_free(&j->out);
  sb_free(&j->data);
  free(j->error);
  free(t);
}

static napi_value cancel(napi_env env, napi_callback_info info) {
  void *data;
  napi_get_cb_info(env, info, NULL, NULL, NULL, &data);
  ((task *)data)->j.cancelled = 1;
  return NULL;
}

static const char *option_names[O_COUNT] = {"cwd", "gitDir", "workTree", "indexFile",
                                            "objectDirectory", "alternates", "username", "password"};

/** run(op, args: string[], options) → Promise<{ json, data? }>, with promise.cancel(). */
static napi_value run(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  task *t = calloc(1, sizeof *t);
  job *j = &t->j;
  j->op = string_value(env, argv[0]);
  uint32_t count = 0;
  napi_get_array_length(env, argv[1], &count);
  j->argv = calloc(count ? count : 1, sizeof(char *));
  for (uint32_t i = 0; i < count; i++) {
    napi_value item;
    napi_get_element(env, argv[1], i, &item);
    char *s = string_value(env, item);
    if (s) j->argv[j->argc++] = s;
  }
  for (int i = 0; i < O_COUNT; i++) {
    napi_value value;
    bool has = false;
    if (argc > 2 && napi_has_named_property(env, argv[2], option_names[i], &has) == napi_ok && has &&
        napi_get_named_property(env, argv[2], option_names[i], &value) == napi_ok)
      j->opt[i] = string_value(env, value);
    if (j->opt[i] && !*j->opt[i]) {
      free(j->opt[i]);
      j->opt[i] = NULL;
    }
  }
  if (!j->op) j->op = strdup("");
  napi_value promise, name, fn;
  napi_create_promise(env, &t->deferred, &promise);
  napi_create_function(env, "cancel", NAPI_AUTO_LENGTH, cancel, t, &fn);
  napi_set_named_property(env, promise, "cancel", fn);
  napi_create_string_utf8(env, j->op, NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, execute, complete, t, &t->work);
  napi_queue_async_work(env, t->work);
  return promise;
}

/**
 * configure({ home }): where ~/.gitconfig lives. libgit2 would read HOME once
 * at first use; the engine sets it explicitly so the order of imports and
 * environment changes cannot matter. Call before ops run, not concurrently.
 */
static napi_value configure(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], value;
  bool has = false;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc > 0 && napi_has_named_property(env, argv[0], "home", &has) == napi_ok && has &&
      napi_get_named_property(env, argv[0], "home", &value) == napi_ok) {
    char *home = string_value(env, value);
    if (home && *home) {
      sb xdg = {0};
      sb_printf(&xdg, "%s/.config/git", home);
      git_libgit2_opts(GIT_OPT_SET_SEARCH_PATH, GIT_CONFIG_LEVEL_GLOBAL, home);
      git_libgit2_opts(GIT_OPT_SET_SEARCH_PATH, GIT_CONFIG_LEVEL_XDG, xdg.p);
      sb_free(&xdg);
    }
    free(home);
  }
  return NULL;
}

static napi_value init(napi_env env, napi_value exports) {
  static int initialized = 0;
  if (!initialized) {
    git_libgit2_init();
    // Agents work in throwaway clones and checkouts; ownership checks on
    // shared paths only get in the way inside one app's container.
    git_libgit2_opts(GIT_OPT_SET_OWNER_VALIDATION, 0);
    initialized = 1;
  }
  napi_value fn, version;
  napi_create_function(env, "run", NAPI_AUTO_LENGTH, run, NULL, &fn);
  napi_set_named_property(env, exports, "run", fn);
  napi_create_function(env, "configure", NAPI_AUTO_LENGTH, configure, NULL, &fn);
  napi_set_named_property(env, exports, "configure", fn);
  napi_create_string_utf8(env, LIBGIT2_VERSION, NAPI_AUTO_LENGTH, &version);
  napi_set_named_property(env, exports, "libgit2", version);
  return exports;
}

#ifdef DSH_GIT_LINKED
// Linked into the app: registered before Node starts, reached through
// process._linkedBinding('dsh_git') from any thread's environment.
static napi_module module = {1, 0, __FILE__, init, "dsh_git", NULL, {0}};
__attribute__((constructor)) static void register_module(void) { napi_module_register(&module); }
#else
NAPI_MODULE(dsh_git, init)
#endif
