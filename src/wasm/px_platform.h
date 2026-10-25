/*
  Platform hooks used by the ps3xport core when it is built for WebAssembly.

  The core sources in src/core are kept as close to upstream as possible; the
  only behavioural differences are routed through the two functions below.
*/

#ifndef PX_PLATFORM_H
#define PX_PLATFORM_H

#include <stdint.h>

/*
  WebAssembly has no reliable directory-entry type information through the
  browser-backed filesystem, so the core asks for a stat() of every entry.
*/
#if defined(PS3XPORT_WASM)
#define PX_STAT_DIRENT 1
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* Reports a fatal core error and unwinds back to the API boundary. */
void px_die (const char *format, ...) __attribute__ ((noreturn, format (printf, 1, 2)));

/* Fills buffer with cryptographically secure random bytes. */
void px_random (void *buffer, uint32_t size);

#ifdef __cplusplus
}
#endif

#endif /* PX_PLATFORM_H */
