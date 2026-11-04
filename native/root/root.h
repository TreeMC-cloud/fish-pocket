// The engine's filesystem view: see root.c.
#ifndef DSH_ROOT_H
#define DSH_ROOT_H

#include <stddef.h>

/**
 * Make `root` the engine's `/` and `bundle` its `/opt/dsh`, creating the
 * skeleton under `root`. `container` is the app's data container: real paths
 * inside it pass through unchanged. Call once, before Node starts. Returns 0,
 * or -1 with errno set when the view does not work; nothing is mapped then.
 */
int dsh_root_install(const char *root, const char *bundle, const char *container);

/** The real path for an engine path, in `out`. Returns 0, or -1 with errno. */
int dsh_root_real(const char *path, char *out, size_t size);

/** The engine path for a real path, in `out`. Returns 0, or -1 with errno. */
int dsh_root_virtual(const char *path, char *out, size_t size);

#endif
