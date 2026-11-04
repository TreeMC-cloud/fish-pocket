// The view on this Mac: root.c links into this executable, so its libc calls
// bind to root.c's definitions the way the app's image does. argv[1] is a
// scratch directory. engine/test/root.test.mjs builds and runs it.
#include "../root.h"

#include <assert.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

static int failures;
#define CHECK(condition) do { if (!(condition)) { printf("FAIL %s:%d %s (errno %d)\n", __FILE__, __LINE__, #condition, errno); failures++; } } while (0)
#define SAME(actual, expected) do { const char *a_ = (actual); if (a_ == NULL || strcmp(a_, expected) != 0) { printf("FAIL %s:%d got [%s] want [%s]\n", __FILE__, __LINE__, a_ ? a_ : "(null)", expected); failures++; } } while (0)

static void write_file(const char *path, const char *text) {
  FILE *file = fopen(path, "w");
  CHECK(file != NULL);
  if (file) { fputs(text, file); fclose(file); }
}

int main(int argc, char **argv) {
  assert(argc == 2);
  char scratch[PATH_MAX], root[PATH_MAX], bundle[PATH_MAX], probe[PATH_MAX];
  assert(realpath(argv[1], scratch) != NULL);
  snprintf(root, sizeof root, "%s/container/root", scratch);
  snprintf(bundle, sizeof bundle, "%s/App.app", scratch);
  snprintf(probe, sizeof probe, "%s/container", scratch);
  char mk[PATH_MAX];
  snprintf(mk, sizeof mk, "%s/container", scratch); mkdir(mk, 0755); mkdir(root, 0755); mkdir(bundle, 0755);
  snprintf(mk, sizeof mk, "%s/data.txt", bundle); write_file(mk, "bundled");

  // Before install nothing is mapped.
  char out[PATH_MAX];
  CHECK(dsh_root_real("/home/dsh/x", out, sizeof out) == 0); SAME(out, "/home/dsh/x");
  SAME(getenv("HOME") != NULL && strcmp(getenv("HOME"), "/home/dsh") != 0 ? "real" : "mapped", "real");

  CHECK(dsh_root_install(root, bundle, probe) == 0);

  // Mapping.
  char want[PATH_MAX];
  snprintf(want, sizeof want, "%s/home/dsh/x", root);
  CHECK(dsh_root_real("/home/dsh/x", out, sizeof out) == 0); SAME(out, want);
  snprintf(want, sizeof want, "%s/", root);
  CHECK(dsh_root_real("/", out, sizeof out) == 0); SAME(out, want);
  snprintf(want, sizeof want, "%s/abc", root);
  CHECK(dsh_root_real("/abc", out, sizeof out) == 0); SAME(out, want);
  snprintf(want, sizeof want, "%s/x", bundle);
  CHECK(dsh_root_real("/opt/dsh/x", out, sizeof out) == 0); SAME(out, want);
  snprintf(want, sizeof want, "%s/opt/other", root);
  CHECK(dsh_root_real("/opt/other", out, sizeof out) == 0); SAME(out, want);
  CHECK(dsh_root_real("/opt/dshx", out, sizeof out) == 0);
  snprintf(want, sizeof want, "%s/opt/dshx", root); SAME(out, want);
  for (const char *const *p = (const char *const[]){"/dev/null", "/etc/hosts", "/usr/share/zoneinfo", "/System/Library", "/private/etc/hosts", NULL}; *p; p++) {
    CHECK(dsh_root_real(*p, out, sizeof out) == 0); SAME(out, *p);
  }
  CHECK(dsh_root_real("/private", out, sizeof out) == 0); SAME(out, "/private");
  snprintf(want, sizeof want, "%s/private/x", root);
  CHECK(dsh_root_real("/private/x", out, sizeof out) == 0); SAME(out, want);
  snprintf(want, sizeof want, "%s/usr/local", root);
  CHECK(dsh_root_real("/usr/local", out, sizeof out) == 0); SAME(out, want);
  snprintf(want, sizeof want, "%s/elsewhere", probe);
  CHECK(dsh_root_real(want, out, sizeof out) == 0); SAME(out, want);
  CHECK(dsh_root_real("relative/path", out, sizeof out) == 0); SAME(out, "relative/path");
  snprintf(want, sizeof want, "%s/home/dsh/a", root);
  CHECK(dsh_root_virtual(want, out, sizeof out) == 0); SAME(out, "/home/dsh/a");
  CHECK(dsh_root_virtual(root, out, sizeof out) == 0); SAME(out, "/");
  snprintf(want, sizeof want, "%s/x", bundle);
  CHECK(dsh_root_virtual(want, out, sizeof out) == 0); SAME(out, "/opt/dsh/x");
  CHECK(dsh_root_virtual("/dev/null", out, sizeof out) == 0); SAME(out, "/dev/null");
  char huge[PATH_MAX]; memset(huge, 'a', sizeof huge - 1); huge[0] = '/'; huge[sizeof huge - 1] = '\0'; huge[PATH_MAX - 40] = '\0';
  CHECK(open(huge, O_RDONLY) == -1 && errno == ENAMETOOLONG);

  // The skeleton shows in `/`.
  struct stat status;
  CHECK(stat("/", &status) == 0 && S_ISDIR(status.st_mode));
  CHECK(stat("/home/dsh", &status) == 0 && S_ISDIR(status.st_mode));
  CHECK(stat("/opt/dsh/data.txt", &status) == 0);
  DIR *top = opendir("/"); CHECK(top != NULL);
  int names = 0; for (struct dirent *e; top && (e = readdir(top));) if (!strcmp(e->d_name, "home") || !strcmp(e->d_name, "tmp") || !strcmp(e->d_name, "opt")) names++;
  if (top) closedir(top);
  CHECK(names == 3);

  // Paths the kernel produces come back in the view.
  CHECK(mkdir("/home/dsh/a", 0755) == 0);
  CHECK(chdir("/home/dsh/a") == 0);
  SAME(getcwd(out, sizeof out), "/home/dsh/a");
  char *allocated = getcwd(NULL, 0); SAME(allocated, "/home/dsh/a"); free(allocated);
  errno = 0; CHECK(getcwd(out, 3) == NULL && errno == ERANGE);
  write_file("/home/dsh/a/f", "x");
  CHECK(access("f", F_OK) == 0);
  SAME(realpath("/home/dsh/a/f", out), "/home/dsh/a/f");
  SAME(realpath("f", out), "/home/dsh/a/f");
  allocated = realpath("/opt/dsh/data.txt", NULL); SAME(allocated, "/opt/dsh/data.txt"); free(allocated);
  CHECK(realpath("/home/dsh/none", out) == NULL && errno == ENOENT);
  CHECK(lstat("/private", &status) == 0 && S_ISDIR(status.st_mode));

  // Links: virtual absolute targets land relative, so nothing on disk names the tree.
  CHECK(symlink("/home/dsh/a/f", "/home/dsh/abs") == 0);
  ssize_t n = readlink("/home/dsh/abs", out, sizeof out); CHECK(n > 0); out[n > 0 ? n : 0] = '\0'; SAME(out, "a/f");
  SAME(realpath("/home/dsh/abs", probe), "/home/dsh/a/f");
  CHECK(symlink("/tmp", "/home/dsh/a/up") == 0);
  n = readlink("/home/dsh/a/up", out, sizeof out); CHECK(n > 0); out[n > 0 ? n : 0] = '\0'; SAME(out, "../../../tmp");
  CHECK(symlink("/home/dsh/a", "rel-dir") == 0);
  n = readlink("rel-dir", out, sizeof out); CHECK(n > 0); out[n > 0 ? n : 0] = '\0'; SAME(out, ".");
  CHECK(symlink("/home/dsh", "/home/dsh/a/parent") == 0);
  n = readlink("/home/dsh/a/parent", out, sizeof out); CHECK(n > 0); out[n > 0 ? n : 0] = '\0'; SAME(out, "..");
  CHECK(symlink("/home/dsh/a", "/home/dsh/a/same") == 0);
  n = readlink("/home/dsh/a/same", out, sizeof out); CHECK(n > 0); out[n > 0 ? n : 0] = '\0'; SAME(out, ".");
  CHECK(symlink("f", "/home/dsh/a/plain") == 0);
  n = readlink("/home/dsh/a/plain", out, sizeof out); CHECK(n > 0); out[n > 0 ? n : 0] = '\0'; SAME(out, "f");
  CHECK(symlink("/dev/null", "/home/dsh/a/null") == 0);
  n = readlink("/home/dsh/a/null", out, sizeof out); CHECK(n > 0); out[n > 0 ? n : 0] = '\0'; SAME(out, "/dev/null");
  CHECK(symlink("/opt/dsh/data.txt", "/home/dsh/a/bundled") == -1 && errno == EPERM);

  // Templates are filled in the caller's own string.
  char directory[] = "/tmp/d-XXXXXX";
  CHECK(mkdtemp(directory) == directory); CHECK(strncmp(directory, "/tmp/d-", 7) == 0 && strstr(directory, "XXXXXX") == NULL);
  CHECK(stat(directory, &status) == 0 && S_ISDIR(status.st_mode));
  char temporary[] = "/tmp/f-XXXXXX";
  int descriptor = mkstemp(temporary); CHECK(descriptor >= 0); if (descriptor >= 0) close(descriptor);
  CHECK(strstr(temporary, "XXXXXX") == NULL && stat(temporary, &status) == 0);

  // Everything else that takes a path.
  CHECK(link("/home/dsh/a/f", "/home/dsh/hard") == 0);
  CHECK(rename("/home/dsh/hard", "/home/dsh/moved") == 0);
  CHECK(chmod("/home/dsh/moved", 0600) == 0);
  CHECK(utimes("/home/dsh/moved", NULL) == 0);
  CHECK(unlink("/home/dsh/moved") == 0);
  write_file("/home/dsh/gone", "x"); CHECK(remove("/home/dsh/gone") == 0);
  CHECK(mkdir("/abc", 0755) == 0 && rmdir("/abc") == 0);
  CHECK(pathconf("/home/dsh", _PC_NAME_MAX) > 0);

  // The environment: this image's answer, not the process's.
  SAME(getenv("HOME"), "/home/dsh");
  SAME(getenv("TMPDIR"), "/tmp");

  // A Unix socket under a path too long for sun_path.
  snprintf(want, sizeof want, "/home/dsh/%s", "0123456789012345678901234567890123456789012345678901234567890123456789");
  CHECK(mkdir(want, 0755) == 0);
  CHECK(chdir(want) == 0);
  int server = socket(AF_UNIX, SOCK_STREAM, 0), client = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  strcpy(address.sun_path, "/tmp/s");
  address.sun_len = (unsigned char)SUN_LEN(&address);
  CHECK(bind(server, (struct sockaddr *)&address, address.sun_len) == 0);
  CHECK(listen(server, 1) == 0);
  CHECK(connect(client, (struct sockaddr *)&address, address.sun_len) == 0);
  CHECK(stat("/tmp/s", &status) == 0);
  close(server); close(client); unlink("/tmp/s");

  printf(failures ? "%d failed\n" : "ok\n", failures);
  return failures != 0;
}
