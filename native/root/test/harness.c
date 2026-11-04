// The real NodeMobile in the filesystem view, without the app: what
// scripts/test-root-sim.sh runs in a simulator. Starts Node the way
// NodeEngine does, on a large stack, with the view installed first.
#include "../root.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

extern int node_start(int, char **);
static int count, status;
static char **arguments;

static void *run(void *unused) {
  (void)unused;
  status = node_start(count, arguments);
  return NULL;
}

int main(int argc, char **argv) {
  if (dsh_root_install(getenv("DSH_TEST_ROOT"), getenv("DSH_TEST_BUNDLE"), getenv("DSH_TEST_CONTAINER")) != 0) {
    perror("dsh_root_install");
    return 90;
  }
  count = argc;
  arguments = argv;
  pthread_attr_t attributes;
  pthread_attr_init(&attributes);
  pthread_attr_setstacksize(&attributes, 16 << 20);
  pthread_t thread;
  pthread_create(&thread, &attributes, run, NULL);
  pthread_join(thread, NULL);
  return status;
}
