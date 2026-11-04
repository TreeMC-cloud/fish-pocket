// process._linkedBinding('dsh_root'): the few Node entry points libc cannot
// reach get real paths from here (engine/runtime/real-paths.mjs), so the mapping
// lives in one place and no real path has to sit in the engine's environment.
#include "root.h"

#include <limits.h>
#include <node_api.h>
#include <stdlib.h>

static napi_value convert(napi_env env, napi_callback_info info, int (*map)(const char *, char *, size_t)) {
  size_t count = 1;
  napi_value argument, result = NULL;
  char path[PATH_MAX], mapped[PATH_MAX];
  size_t length;
  if (napi_get_cb_info(env, info, &count, &argument, NULL, NULL) != napi_ok || count != 1) return NULL;
  if (napi_get_value_string_utf8(env, argument, path, sizeof path, &length) != napi_ok) return NULL;
  if (map(path, mapped, sizeof mapped) != 0) {
    napi_throw_error(env, "ENAMETOOLONG", "path too long");
    return NULL;
  }
  napi_create_string_utf8(env, mapped, NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value real(napi_env env, napi_callback_info info) { return convert(env, info, dsh_root_real); }
static napi_value engine(napi_env env, napi_callback_info info) { return convert(env, info, dsh_root_virtual); }

static napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"real", NULL, real, NULL, NULL, NULL, napi_enumerable, NULL},
    {"virtual", NULL, engine, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  napi_define_properties(env, exports, 2, properties);
  return exports;
}

static napi_module module = {.nm_version = 1, .nm_register_func = init, .nm_modname = "dsh_root"};
// Registered at load: process._linkedBinding('dsh_root') from any thread's environment.
__attribute__((constructor)) static void registerModule(void) { napi_module_register(&module); }
