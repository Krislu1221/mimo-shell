/*
 * Launcher for the single MiMo Code entry.
 *
 * Why a compiled binary instead of a shell script:
 *
 * macOS decides whether an app is "native" by inspecting its main executable.
 * A #!/bin/sh script has no Mach-O header, so the architecture cannot be
 * determined and macOS falls back to treating the bundle as a possibly-Intel
 * app — surfacing the "即将结束对 Intel 芯片 App 的支持" dialog. A real arm64
 * Mach-O here makes the bundle unambiguously Apple Silicon native.
 *
 * It also fixes the LaunchServices gap: an ad-hoc-signed Electron app cannot
 * start through LaunchServices on this machine
 * (`codesign_util.cc: task_name_for_pid: (os/kern) failure (5)`, reproduced
 * with Electron's own downloaded Electron.app), so we exec the engine directly.
 * This process is replaced via execv, so it leaves nothing behind.
 *
 * Build:  clang -arch arm64 -O2 -o launch launcher.c
 * Usage:  the engine binary name is compiled in via -DMIMO_ENGINE="..."
 */

#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef MIMO_ENGINE
#define MIMO_ENGINE "mimo-webui"
#endif

int main(int argc, char **argv) {
  char self[PATH_MAX];
  uint32_t size = sizeof(self);
  if (_NSGetExecutablePath(self, &size) != 0) {
    fprintf(stderr, "launch: cannot resolve own path\n");
    return 1;
  }

  /* self = <bundle>/Contents/MacOS/launch
   * engine = <bundle>/Contents/Resources/engine/<name>.app/Contents/MacOS/<name>
   *
   * _NSGetExecutablePath returns the executable's full path, so the file name
   * has to be stripped before walking up to the bundle root — otherwise the
   * path resolves to .../MacOS/launch/../Resources and the exec fails. */
  char *slash = strrchr(self, '/');
  if (!slash) {
    fprintf(stderr, "launch: unexpected executable path %s\n", self);
    return 1;
  }
  *slash = '\0'; /* self is now <bundle>/Contents/MacOS */

  char engine[PATH_MAX];
  int n = snprintf(engine, sizeof(engine),
                   "%s/../Resources/engine/%s.app/Contents/MacOS/%s",
                   self, MIMO_ENGINE, MIMO_ENGINE);
  if (n < 0 || (size_t)n >= sizeof(engine)) {
    fprintf(stderr, "launch: engine path too long\n");
    return 1;
  }

  if (access(engine, X_OK) != 0) {
    fprintf(stderr, "launch: engine not executable at %s\n", engine);
    return 1;
  }

  /* Inherited from DeepSeek Harness in shared shells, this makes Electron run
   * as plain Node and no window appears. Drop it before exec. */
  unsetenv("ELECTRON_RUN_AS_NODE");

  /* Replace this process so the app is the one LaunchServices is tracking. */
  execv(engine, argv);
  fprintf(stderr, "launch: exec %s failed\n", engine);
  return 1;
}
