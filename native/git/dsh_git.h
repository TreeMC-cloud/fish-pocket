// dsh_git: libgit2 behind one N-API call, `run(op, args, options)`.
// Every op runs on the libuv thread pool and answers with JSON (plus raw bytes
// for blob contents); engine/runtime/git turns that into git's command line.
#ifndef DSH_GIT_H
#define DSH_GIT_H

#include <stddef.h>
#include <stdint.h>
#include <git2.h>
#include <git2/sys/errors.h>
#include <git2/sys/odb_backend.h>
#include <git2/sys/repository.h>

/** A growable byte buffer; JSON output is built in one. */
typedef struct {
  char *p;
  size_t n, cap;
} sb;

void sb_put(sb *b, const char *s, size_t n);
void sb_puts(sb *b, const char *s);
void sb_printf(sb *b, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
void sb_free(sb *b);

// JSON writer: every value is followed by a comma; closing a container drops
// the trailing one. Keys and values are escaped as JSON strings.
void j_open(sb *b, const char *key, char bracket);
void j_close(sb *b, char bracket);
void j_str(sb *b, const char *key, const char *value);
void j_strn(sb *b, const char *key, const char *value, size_t n);
void j_int(sb *b, const char *key, int64_t value);
void j_bool(sb *b, const char *key, int value);
void j_oid(sb *b, const char *key, const git_oid *oid);
void j_sig(sb *b, const char *key, const git_signature *sig);

/** Repository selection and credentials, from the caller's options. */
enum { O_CWD, O_GIT_DIR, O_WORK_TREE, O_INDEX_FILE, O_OBJECT_DIR, O_ALTERNATES, O_USERNAME, O_PASSWORD, O_COUNT };

typedef struct job {
  char *op;
  char **argv;
  int argc;
  char *opt[O_COUNT];
  sb out;           // JSON result
  sb data;          // raw bytes, handed back as a Buffer
  int has_data;
  char *error;      // message for the rejection
  char kind[32];    // stable error kind the JS side maps to git's wording
  volatile int cancelled;
  int credential_attempts;
} job;

// Arguments are "key=value" strings; flags are "key=1".
const char *arg(job *j, const char *key);
int arg_flag(job *j, const char *key);
int arg_int(job *j, const char *key, int fallback);
/** Every value of a repeated key, as a strarray borrowing the job's strings. */
git_strarray args_all(job *j, const char *key);

/** Fail the job with libgit2's last error (or `fallback`) under `kind`. */
int fail_git(job *j, int code, const char *kind);
int fail(job *j, const char *kind, const char *fmt, ...) __attribute__((format(printf, 3, 4)));

int open_repo(job *j, git_repository **out);
void remote_callbacks(job *j, git_remote_callbacks *cb);
int resolve_commit(job *j, git_repository *repo, const char *spec, git_commit **out);
/** The identity for new commits: explicit arguments, then config. */
int signature_for(job *j, git_repository *repo, const char *prefix, git_signature **out);

// Shared JSON fragments.
void j_head(sb *b, git_repository *repo);
const char *repo_state_name(int state);
int diff_stats_text(git_diff *diff, git_diff_stats_format_t format, sb *out);

typedef int (*op_fn)(job *j);
op_fn find_op(const char *name);

#define TRY(x)                                   \
  do {                                           \
    int _rc = (x);                               \
    if (_rc < 0) {                               \
      rc = fail_git(j, _rc, "git");              \
      goto done;                                 \
    }                                            \
  } while (0)

#define TRY_AS(x, k)                             \
  do {                                           \
    int _rc = (x);                               \
    if (_rc < 0) {                               \
      rc = fail_git(j, _rc, k);                  \
      goto done;                                 \
    }                                            \
  } while (0)

#endif
