// One filesystem view for everything that runs in-process: Node, libgit2, and
// whatever is linked in later. iOS moves the data container (a new UUID in its
// path) on every app update, and programs store absolute paths; so those
// programs get a stable tree instead of the real one:
//
//   /            <Application Support>/dsh-ios/root
//   /home/dsh    $HOME, an ordinary directory inside it
//   /tmp         $TMPDIR, likewise
//   /opt/dsh     the app bundle, read-only
//   /dev /etc /usr/share /System     the real system, which refuses writes
//
// The real tree mirrors this one, so relative symlinks work unchanged and
// nothing on disk mentions the container.
//
// How it attaches: this library defines the libc functions that take paths and
// re-exports the rest of libSystem. NodeMobile's libSystem dependency is pointed
// here (scripts/fetch-nodejs-mobile.sh), and the app's own image binds here by
// link order, so dyld resolves those images' calls to these definitions; nothing
// is patched at run time. System frameworks are bound to libSystem directly and
// keep seeing real paths. Out of reach: code inside libc++'s std::filesystem
// (see engine/runtime/real-paths.mjs for what that leaves to JavaScript).
//
// native/root/imports.txt lists what NodeMobile imports; a new import fails
// scripts/check-root-imports.sh, which is how a path function added by a Node
// upgrade gets noticed.
#include "root.h"

#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#define HOME_DIRECTORY "/home/dsh"
#define TEMP_DIRECTORY "/tmp"
#define BUNDLE_DIRECTORY "/opt/dsh"

/** A real directory, canonical; `alias` is its spelling without /private, if any. */
typedef struct {
  char path[PATH_MAX];
  size_t length;
  const char *alias;
  size_t aliasLength;
} Place;

static Place rootPlace, bundlePlace, containerPlace;
static bool installed;

/** System paths the engine reads as they are. */
static const char *const systemPaths[] = {"/dev", "/etc", "/private/etc", "/usr/share", "/System"};

static const char *after(const char *path, const char *directory, size_t length) {
  if (strncmp(path, directory, length) != 0) return NULL;
  return path[length] == '/' || path[length] == '\0' ? path + length : NULL;
}

/** What follows `place` in `path`, or NULL when `path` is not inside it. */
static const char *inside(const Place *place, const char *path) {
  if (place->length == 0) return NULL;
  const char *rest = after(path, place->path, place->length);
  if (rest == NULL && place->alias != NULL) rest = after(path, place->alias, place->aliasLength);
  return rest;
}

/** `path` in the real tree: `buffer` when it changes, NULL with errno when it does not fit. */
static const char *toReal(const char *path, char *buffer) {
  if (path == NULL || path[0] != '/' || !installed) return path;
  if (inside(&containerPlace, path) != NULL || inside(&bundlePlace, path) != NULL) return path;
  // /etc is a link to private/etc: resolving it passes through /private itself.
  if (strcmp(path, "/private") == 0) return path;
  for (size_t i = 0; i < sizeof systemPaths / sizeof *systemPaths; i++) {
    if (after(path, systemPaths[i], strlen(systemPaths[i])) != NULL) return path;
  }
  const char *rest = after(path, BUNDLE_DIRECTORY, strlen(BUNDLE_DIRECTORY));
  const Place *base = rest != NULL ? &bundlePlace : &rootPlace;
  if (rest == NULL) rest = path;
  if (snprintf(buffer, PATH_MAX, "%s%s", base->path, rest) >= PATH_MAX) {
    errno = ENAMETOOLONG;
    return NULL;
  }
  return buffer;
}

/** Rewrite a path the kernel produced, in place. `path` holds PATH_MAX bytes. */
static void toVirtual(char *path) {
  if (!installed || path[0] != '/') return;
  char result[PATH_MAX];
  const char *rest = inside(&bundlePlace, path);
  if (rest != NULL) {
    snprintf(result, sizeof result, "%s%s", BUNDLE_DIRECTORY, rest);
  } else if ((rest = inside(&rootPlace, path)) != NULL) {
    snprintf(result, sizeof result, "%s", *rest == '\0' ? "/" : rest);
  } else {
    return;
  }
  strcpy(path, result);
}

/** `target` relative to the directory `from`; both absolute, in the same tree. */
static bool relativePath(const char *from, const char *target, char *out, size_t size) {
  size_t common = 0;
  for (size_t i = 0;; i++) {
    bool fromEnd = from[i] == '\0' || from[i] == '/';
    bool targetEnd = target[i] == '\0' || target[i] == '/';
    if (fromEnd && targetEnd) common = i;
    if (from[i] == '\0' || target[i] == '\0' || from[i] != target[i]) break;
  }
  size_t used = 0;
  out[0] = '\0';
  for (const char *c = from + common; *c != '\0'; c++) {
    if (*c != '/' || c[1] == '\0' || c[1] == '/') continue;
    int written = snprintf(out + used, size - used, "../");
    if (written < 0 || (size_t)written >= size - used) return false;
    used += (size_t)written;
  }
  const char *rest = target + common;
  while (*rest == '/') rest++;
  if (*rest == '\0') {
    if (used == 0) snprintf(out, size, ".");
    else out[used - 1] = '\0';
    return true;
  }
  int written = snprintf(out + used, size - used, "%s", rest);
  return written >= 0 && (size_t)written < size - used;
}

// The real libc, resolved when this library loads: NodeMobile's static
// initializers run before main and already call through these.
#define REAL(name) static __typeof__(&name) real_##name
REAL(access); REAL(bind); REAL(chdir); REAL(chmod); REAL(chown); REAL(connect); REAL(getcwd); REAL(getenv);
REAL(lchown); REAL(link); REAL(lstat); REAL(mkdir); REAL(mkdtemp); REAL(mkstemp); REAL(opendir); REAL(pathconf);
REAL(readlink); REAL(remove); REAL(rename); REAL(rmdir); REAL(scandir); REAL(stat); REAL(statfs); REAL(symlink);
REAL(unlink); REAL(utimensat); REAL(utimes);
static int (*real_open)(const char *, int, ...);
static FILE *(*real_fopen)(const char *, const char *);
static FILE *(*real_fopenExtended)(const char *, const char *);
static char *(*real_realpath)(const char *, char *);

__attribute__((constructor)) static void resolveLibc(void) {
  void *system = dlopen("/usr/lib/libSystem.B.dylib", RTLD_LAZY | RTLD_NOLOAD);
#define RESOLVE(name) *(void **)&real_##name = dlsym(system, #name)
  RESOLVE(access); RESOLVE(bind); RESOLVE(chdir); RESOLVE(chmod); RESOLVE(chown); RESOLVE(connect); RESOLVE(getcwd);
  RESOLVE(getenv); RESOLVE(lchown); RESOLVE(link); RESOLVE(lstat); RESOLVE(mkdir); RESOLVE(mkdtemp); RESOLVE(mkstemp);
  RESOLVE(open); RESOLVE(opendir); RESOLVE(pathconf); RESOLVE(readlink); RESOLVE(remove); RESOLVE(rename);
  RESOLVE(rmdir); RESOLVE(scandir); RESOLVE(stat); RESOLVE(statfs); RESOLVE(symlink); RESOLVE(unlink);
  RESOLVE(utimensat); RESOLVE(utimes); RESOLVE(fopen);
  *(void **)&real_fopenExtended = dlsym(system, "fopen$DARWIN_EXTSN");
  if (real_fopenExtended == NULL) real_fopenExtended = real_fopen;
  *(void **)&real_realpath = dlsym(system, "realpath$DARWIN_EXTSN");
}

// The definitions dyld binds to. Exported under libc's names; `dsh_` only keeps
// them from colliding with the SDK's declarations here.
#define EXPORT(symbol) __asm__("_" symbol) __attribute__((visibility("default")))

#define ONE_PATH(type, failure, name, parameters, arguments)                 \
  type dsh_##name parameters EXPORT(#name);                                  \
  type dsh_##name parameters {                                               \
    char buffer[PATH_MAX];                                                   \
    const char *mapped = toReal(path, buffer);                               \
    if (mapped == NULL) return failure;                                      \
    return real_##name arguments;                                            \
  }

ONE_PATH(int, -1, access, (const char *path, int mode), (mapped, mode))
ONE_PATH(int, -1, chdir, (const char *path), (mapped))
ONE_PATH(int, -1, chmod, (const char *path, mode_t mode), (mapped, mode))
ONE_PATH(int, -1, chown, (const char *path, uid_t owner, gid_t group), (mapped, owner, group))
ONE_PATH(int, -1, lchown, (const char *path, uid_t owner, gid_t group), (mapped, owner, group))
ONE_PATH(int, -1, lstat, (const char *path, struct stat *result), (mapped, result))
ONE_PATH(int, -1, mkdir, (const char *path, mode_t mode), (mapped, mode))
ONE_PATH(DIR *, NULL, opendir, (const char *path), (mapped))
ONE_PATH(long, -1, pathconf, (const char *path, int name), (mapped, name))
ONE_PATH(int, -1, remove, (const char *path), (mapped))
ONE_PATH(int, -1, rmdir, (const char *path), (mapped))
ONE_PATH(int, -1, stat, (const char *path, struct stat *result), (mapped, result))
ONE_PATH(int, -1, statfs, (const char *path, struct statfs *result), (mapped, result))
ONE_PATH(int, -1, unlink, (const char *path), (mapped))
ONE_PATH(int, -1, utimes, (const char *path, const struct timeval times[2]), (mapped, times))
ONE_PATH(int, -1, scandir,
         (const char *path, struct dirent ***list, int (*select)(const struct dirent *),
          int (*compare)(const struct dirent **, const struct dirent **)),
         (mapped, list, select, compare))

int dsh_utimensat(int directory, const char *path, const struct timespec times[2], int flags) EXPORT("utimensat");
int dsh_utimensat(int directory, const char *path, const struct timespec times[2], int flags) {
  char buffer[PATH_MAX];
  const char *mapped = toReal(path, buffer);
  return mapped == NULL ? -1 : real_utimensat(directory, mapped, times, flags);
}

int dsh_open(const char *path, int flags, ...) EXPORT("open");
int dsh_open(const char *path, int flags, ...) {
  va_list arguments;
  va_start(arguments, flags);
  int mode = flags & O_CREAT ? va_arg(arguments, int) : 0;
  va_end(arguments);
  char buffer[PATH_MAX];
  const char *mapped = toReal(path, buffer);
  return mapped == NULL ? -1 : real_open(mapped, flags, mode);
}

FILE *dsh_fopen(const char *path, const char *mode) EXPORT("fopen");
FILE *dsh_fopen(const char *path, const char *mode) {
  char buffer[PATH_MAX];
  const char *mapped = toReal(path, buffer);
  return mapped == NULL ? NULL : real_fopen(mapped, mode);
}

FILE *dsh_fopenExtended(const char *path, const char *mode) EXPORT("fopen$DARWIN_EXTSN");
FILE *dsh_fopenExtended(const char *path, const char *mode) {
  char buffer[PATH_MAX];
  const char *mapped = toReal(path, buffer);
  return mapped == NULL ? NULL : real_fopenExtended(mapped, mode);
}

int dsh_link(const char *from, const char *to) EXPORT("link");
int dsh_link(const char *from, const char *to) {
  char first[PATH_MAX], second[PATH_MAX];
  const char *mappedFrom = toReal(from, first), *mappedTo = toReal(to, second);
  return mappedFrom == NULL || mappedTo == NULL ? -1 : real_link(mappedFrom, mappedTo);
}

int dsh_rename(const char *from, const char *to) EXPORT("rename");
int dsh_rename(const char *from, const char *to) {
  char first[PATH_MAX], second[PATH_MAX];
  const char *mappedFrom = toReal(from, first), *mappedTo = toReal(to, second);
  return mappedFrom == NULL || mappedTo == NULL ? -1 : real_rename(mappedFrom, mappedTo);
}

char *dsh_getcwd(char *out, size_t size) EXPORT("getcwd");
char *dsh_getcwd(char *out, size_t size) {
  char path[PATH_MAX];
  if (real_getcwd(path, sizeof path) == NULL) return NULL;
  toVirtual(path);
  if (out == NULL) return strdup(path);
  if (strlen(path) + 1 > size) {
    errno = ERANGE;
    return NULL;
  }
  return strcpy(out, path);
}

char *dsh_realpath(const char *path, char *out) EXPORT("realpath$DARWIN_EXTSN");
char *dsh_realpath(const char *path, char *out) {
  char buffer[PATH_MAX], result[PATH_MAX];
  const char *mapped = toReal(path, buffer);
  if (mapped == NULL || real_realpath(mapped, result) == NULL) return NULL;
  toVirtual(result);
  return out == NULL ? strdup(result) : strcpy(out, result);
}

ssize_t dsh_readlink(const char *path, char *out, size_t size) EXPORT("readlink");
ssize_t dsh_readlink(const char *path, char *out, size_t size) {
  char buffer[PATH_MAX], target[PATH_MAX];
  const char *mapped = toReal(path, buffer);
  if (mapped == NULL) return -1;
  ssize_t length = real_readlink(mapped, target, sizeof target - 1);
  if (length < 0) return length;
  target[length] = '\0';
  toVirtual(target);
  length = (ssize_t)strlen(target);
  if ((size_t)length > size) length = (ssize_t)size;
  memcpy(out, target, (size_t)length);
  return length;
}

/**
 * The kernel resolves a link's target without us, so an engine path in it would
 * be wrong and a real path would pin the UUID. Targets in the tree are stored
 * relative. A target in the bundle cannot be: it is elsewhere on disk and moves
 * with every update, so such a link is refused rather than left dangling.
 */
int dsh_symlink(const char *target, const char *path) EXPORT("symlink");
int dsh_symlink(const char *target, const char *path) {
  char buffer[PATH_MAX], relative[PATH_MAX], directory[PATH_MAX], linkBuffer[PATH_MAX];
  const char *mappedLink = toReal(path, linkBuffer);
  if (mappedLink == NULL) return -1;
  const char *mappedTarget = toReal(target, buffer);
  if (mappedTarget == NULL) return -1;
  if (installed && target[0] == '/' && mappedTarget != target) {
    if (after(target, BUNDLE_DIRECTORY, strlen(BUNDLE_DIRECTORY)) != NULL) {
      errno = EPERM;
      return -1;
    }
    if (path[0] == '/') {
      snprintf(directory, sizeof directory, "%s", path);
    } else {
      char cwd[PATH_MAX];
      if (dsh_getcwd(cwd, sizeof cwd) == NULL) return -1;
      if (snprintf(directory, sizeof directory, "%s/%s", cwd, path) >= (int)sizeof directory) {
        errno = ENAMETOOLONG;
        return -1;
      }
    }
    *strrchr(directory, '/') = '\0';
    if (!relativePath(directory, target, relative, sizeof relative)) {
      errno = ENAMETOOLONG;
      return -1;
    }
    target = relative;
  }
  return real_symlink(target, mappedLink);
}

/** A template the kernel filled in: copy the generated name back to the caller's. */
static void copySuffix(char *template, const char *filled) {
  size_t length = strlen(template), filledLength = strlen(filled), suffix = 0;
  while (suffix < length && template[length - 1 - suffix] == 'X') suffix++;
  memcpy(template + length - suffix, filled + filledLength - suffix, suffix);
}

char *dsh_mkdtemp(char *template) EXPORT("mkdtemp");
char *dsh_mkdtemp(char *template) {
  char buffer[PATH_MAX], filled[PATH_MAX];
  const char *mapped = toReal(template, buffer);
  if (mapped == NULL) return NULL;
  snprintf(filled, sizeof filled, "%s", mapped);
  if (real_mkdtemp(filled) == NULL) return NULL;
  copySuffix(template, filled);
  return template;
}

int dsh_mkstemp(char *template) EXPORT("mkstemp");
int dsh_mkstemp(char *template) {
  char buffer[PATH_MAX], filled[PATH_MAX];
  const char *mapped = toReal(template, buffer);
  if (mapped == NULL) return -1;
  snprintf(filled, sizeof filled, "%s", mapped);
  int descriptor = real_mkstemp(filled);
  if (descriptor >= 0) copySuffix(template, filled);
  return descriptor;
}

/**
 * Unix sockets: `sun_path` holds 104 bytes and the real tree alone takes more,
 * so a path that does not fit goes relative to the working directory, which is
 * inside the tree once the engine has started.
 */
static int unixSocketCall(int (*call)(int, const struct sockaddr *, socklen_t), int socket, const struct sockaddr *address,
                          socklen_t length) {
  if (!installed || address == NULL || address->sa_family != AF_UNIX) return call(socket, address, length);
  const struct sockaddr_un *given = (const struct sockaddr_un *)address;
  if (length <= offsetof(struct sockaddr_un, sun_path)) return call(socket, address, length);
  size_t available = length - offsetof(struct sockaddr_un, sun_path);
  char path[sizeof given->sun_path + 1];
  memcpy(path, given->sun_path, available < sizeof given->sun_path ? available : sizeof given->sun_path);
  path[available < sizeof given->sun_path ? available : sizeof given->sun_path] = '\0';
  char buffer[PATH_MAX];
  const char *mapped = toReal(path, buffer);
  if (mapped == NULL) return -1;
  if (mapped == path) return call(socket, address, length);
  struct sockaddr_un translated = {.sun_family = AF_UNIX};
  char relative[PATH_MAX], cwd[PATH_MAX];
  if (strlen(mapped) >= sizeof translated.sun_path) {
    if (real_getcwd(cwd, sizeof cwd) == NULL) return -1;
    if (!relativePath(cwd, mapped, relative, sizeof relative) || strlen(relative) >= sizeof translated.sun_path) {
      errno = ENAMETOOLONG;
      return -1;
    }
    mapped = relative;
  }
  strcpy(translated.sun_path, mapped);
  translated.sun_len = (unsigned char)SUN_LEN(&translated);
  return call(socket, (const struct sockaddr *)&translated, translated.sun_len);
}

int dsh_bind(int socket, const struct sockaddr *address, socklen_t length) EXPORT("bind");
int dsh_bind(int socket, const struct sockaddr *address, socklen_t length) {
  return unixSocketCall(real_bind, socket, address, length);
}

int dsh_connect(int socket, const struct sockaddr *address, socklen_t length) EXPORT("connect");
int dsh_connect(int socket, const struct sockaddr *address, socklen_t length) {
  return unixSocketCall(real_connect, socket, address, length);
}

/**
 * The process environment stays real, because system frameworks read it: what
 * they would do with TMPDIR=/tmp is fail. Programs in this view get their own
 * answer. The engine's workers have private environments with the same values.
 */
char *dsh_getenv(const char *name) EXPORT("getenv");
char *dsh_getenv(const char *name) {
  if (installed && strcmp(name, "HOME") == 0) return (char *)HOME_DIRECTORY;
  if (installed && strcmp(name, "TMPDIR") == 0) return (char *)TEMP_DIRECTORY;
  return real_getenv(name);
}

static int setPlace(Place *place, const char *path) {
  if (real_realpath(path, place->path) == NULL) return -1;
  place->length = strlen(place->path);
  bool hasAlias = strncmp(place->path, "/private/var/", 13) == 0;
  place->alias = hasAlias ? place->path + strlen("/private") : NULL;
  place->aliasLength = hasAlias ? place->length - strlen("/private") : 0;
  return 0;
}

static int makeDirectories(const char *base, const char *relative) {
  char path[PATH_MAX];
  if (snprintf(path, sizeof path, "%s/%s", base, relative) >= (int)sizeof path) {
    errno = ENAMETOOLONG;
    return -1;
  }
  for (char *slash = path + 1;; slash++) {
    if (*slash != '/' && *slash != '\0') continue;
    char end = *slash;
    *slash = '\0';
    if (real_mkdir(path, 0755) != 0 && errno != EEXIST) return -1;
    *slash = end;
    if (end == '\0') return 0;
  }
}

int dsh_root_install(const char *root, const char *bundle, const char *container) {
  // Empty stand-ins, so that listing `/` shows what the view maps elsewhere.
  static const char *const skeleton[] = {"home/dsh", "tmp", "opt/dsh", "etc", "usr/share", "System"};
  for (size_t i = 0; i < sizeof skeleton / sizeof *skeleton; i++) {
    if (makeDirectories(root, skeleton[i]) != 0) return -1;
  }
  if (setPlace(&rootPlace, root) != 0 || setPlace(&bundlePlace, bundle) != 0 || setPlace(&containerPlace, container) != 0) {
    return -1;
  }
  installed = true;
  struct stat status;
  if (dsh_stat(HOME_DIRECTORY, &status) != 0 || !S_ISDIR(status.st_mode)) {
    int failure = errno;
    installed = false;
    errno = failure;
    return -1;
  }
  return 0;
}

int dsh_root_real(const char *path, char *out, size_t size) {
  char buffer[PATH_MAX];
  const char *mapped = toReal(path, buffer);
  if (mapped == NULL) return -1;
  if (strlen(mapped) >= size) {
    errno = ENAMETOOLONG;
    return -1;
  }
  strcpy(out, mapped);
  return 0;
}

int dsh_root_virtual(const char *path, char *out, size_t size) {
  char result[PATH_MAX];
  if (strlen(path) >= sizeof result) {
    errno = ENAMETOOLONG;
    return -1;
  }
  strcpy(result, path);
  toVirtual(result);
  if (strlen(result) >= size) {
    errno = ENAMETOOLONG;
    return -1;
  }
  strcpy(out, result);
  return 0;
}
