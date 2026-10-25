/*
  ps3export-wasm C API.

  This file is the only new C code in the port: it exposes a small, flat,
  JavaScript-friendly surface over the upstream ps3xport core (see
  ../core/archive.c). Nothing here implements archive parsing; it only glues
  the upstream entry points to the browser filesystem and turns the core's
  die()/exit() failure path into a return value plus px_last_error().

  Copyright 2015 Kakaroto (upstream ps3xport)
  Copyright 2026 ps3export-wasm contributors

  Licensed under the terms of the GNU General Public License version 3.
*/

#include <setjmp.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <emscripten.h>

#include "tools.h"
#include "types.h"
#include "common.h"
#include "keys.h"
#include "paged_file.h"
#include "archive.h"

#include "keys_conf_blob.h"

/* Declared in archive.c but not part of the upstream public header. */
int archive_dump (const char *path, const char *prefix, const char *output);

#define PX_KEYS_CONF_PATH "/keys.conf"

static jmp_buf px_jmp;
static int px_active;
static char px_error[1024];
static char px_string[128];

static ArchiveIndex px_index;
static int px_index_open_flag;

static ArchiveData px_data;
static int px_data_valid;

/* ------------------------------------------------------------------ */
/* Core error handling                                                */
/* ------------------------------------------------------------------ */

static void
px_set_error (const char *format, ...)
{
  va_list args;

  va_start (args, format);
  vsnprintf (px_error, sizeof (px_error), format, args);
  va_end (args);
}

void
px_die (const char *format, ...)
{
  va_list args;
  int saved_errno = errno;

  va_start (args, format);
  vsnprintf (px_error, sizeof (px_error), format, args);
  va_end (args);

  /* Trim the trailing newline the core likes to append. */
  {
    size_t len = strlen (px_error);
    while (len > 0 && (px_error[len - 1] == '\n' || px_error[len - 1] == '\r'))
      px_error[--len] = 0;
  }

  if (saved_errno != 0 && strlen (px_error) + 24 < sizeof (px_error)) {
    size_t len = strlen (px_error);
    snprintf (px_error + len, sizeof (px_error) - len, " (errno %d)", saved_errno);
  }

  if (px_active)
    longjmp (px_jmp, 1);

  /* No API call is in flight: nothing sensible left to do. */
  fprintf (stderr, "ps3export-wasm: %s\n", px_error);
  __builtin_trap ();
}

void
px_random (void *buffer, uint32_t size)
{
  uint8_t *out = buffer;

  while (size > 0) {
    uint32_t chunk = size > 0x10000 ? 0x10000 : size;

    if (EM_ASM_INT ({
          try {
            var view = HEAPU8.subarray($0, $0 + $1);
            globalThis.crypto.getRandomValues(view);
            return 1;
          } catch (e) {
            return 0;
          }
        }, (uintptr_t) out, chunk) != 1)
      px_die ("Unable to generate random numbers\n");

    out += chunk;
    size -= chunk;
  }
}

/* ------------------------------------------------------------------ */
/* Call helpers                                                       */
/* ------------------------------------------------------------------ */

#define PX_BEGIN()                                     \
  do {                                                 \
    px_error[0] = 0;                                   \
    if (setjmp (px_jmp) != 0) {                        \
      px_active = 0;                                   \
      return -1;                                       \
    }                                                  \
    px_active = 1;                                     \
  } while (0)

#define PX_END()                                       \
  do {                                                 \
    px_active = 0;                                     \
    return 0;                                          \
  } while (0)

static int
px_parse_id (const char *hex, u8 *out)
{
  memset (out, 0, 0x10);
  if (hex == NULL || hex[0] == 0)
    return 0;
  if (strlen (hex) != 32 || parse_hex (hex, out, 0x10) != 0x10)
    return -1;
  return 0;
}

static void
px_bytes_to_hex (const u8 *data, u32 len, char *out)
{
  static const char digits[] = "0123456789abcdef";
  u32 i;

  for (i = 0; i < len; i++) {
    out[i * 2] = digits[data[i] >> 4];
    out[i * 2 + 1] = digits[data[i] & 0x0F];
  }
  out[len * 2] = 0;
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                          */
/* ------------------------------------------------------------------ */

EMSCRIPTEN_KEEPALIVE int
px_init (void)
{
  FILE *fd;

  memset (&px_index, 0, sizeof (px_index));
  px_index_open_flag = 0;
  px_data_valid = 0;

  /* Materialise the bundled keys.conf inside the in-memory filesystem. */
  fd = fopen (PX_KEYS_CONF_PATH, "wb");
  if (fd == NULL) {
    px_set_error ("Unable to create %s\n", PX_KEYS_CONF_PATH);
    return -1;
  }
  if (px_keys_conf_len > 0 &&
      fwrite (px_keys_conf, px_keys_conf_len, 1, fd) != 1) {
    fclose (fd);
    px_set_error ("Unable to write bundled keys.conf\n");
    return -1;
  }
  fclose (fd);

  keys_set_path (PX_KEYS_CONF_PATH);

  return 0;
}

EMSCRIPTEN_KEEPALIVE const char *
px_last_error (void)
{
  return px_error;
}

/*
  Lets the JavaScript filesystem driver use the real errno values compiled into
  the wasm binary instead of hard-coding platform constants.
*/
EMSCRIPTEN_KEEPALIVE int
px_errno (int which)
{
  switch (which) {
    case 0: return ENOENT;
    case 1: return EEXIST;
    case 2: return ENOTDIR;
    case 3: return EISDIR;
    case 4: return EINVAL;
    case 5: return ENOSYS;
    case 6: return EBADF;
    case 7: return ENODEV;
    case 8: return EACCES;
    case 9: return EPERM;
    case 10: return EBUSY;
    case 11: return EIO;
    default: return EINVAL;
  }
}

EMSCRIPTEN_KEEPALIVE int
px_set_device_id (const char *hex)
{
  u8 id[0x10];

  if (px_parse_id (hex, id) != 0) {
    px_set_error ("Device ID must be 32 hex characters\n");
    return -1;
  }
  archive_set_device_id (id);
  return 0;
}

EMSCRIPTEN_KEEPALIVE int
px_set_open_psid (const char *hex)
{
  u8 id[0x10];

  if (px_parse_id (hex, id) != 0) {
    px_set_error ("OpenPSID must be 32 hex characters\n");
    return -1;
  }
  if (hex != NULL && hex[0] != 0)
    archive_set_open_psid (id);
  return 0;
}

/* ------------------------------------------------------------------ */
/* Index inspection                                                   */
/* ------------------------------------------------------------------ */

static void px_index_close_internal (void);

EMSCRIPTEN_KEEPALIVE int
px_index_open (const char *path)
{
  PX_BEGIN ();

  px_index_close_internal ();
  px_index.prefix = NULL;

  if (!archive_index_read (&px_index, path)) {
    if (px_error[0] == 0)
      px_set_error ("Unable to read index file (bad HMAC or not a PS3 index)\n");
    px_active = 0;
    return -1;
  }
  px_index_open_flag = 1;

  PX_END ();
}

EMSCRIPTEN_KEEPALIVE void
px_index_close (void)
{
  if (px_index_open_flag) {
    archive_index_free (&px_index);
    memset (&px_index, 0, sizeof (px_index));
    px_index_open_flag = 0;
  }
}

static void
px_index_close_internal (void)
{
  px_index_close ();
}

static ArchiveFile *
px_index_nth_file (int i, int *count)
{
  ChainedList *current = px_index.files;
  int n = 0;

  while (current != NULL) {
    if (n == i) {
      if (count != NULL)
        *count = n;
      return current->data;
    }
    n++;
    current = current->next;
  }
  return NULL;
}

static ArchiveDirectory *
px_index_nth_dir (int i)
{
  ChainedList *current = px_index.dirs;
  int n = 0;

  while (current != NULL) {
    if (n == i)
      return current->data;
    n++;
    current = current->next;
  }
  return NULL;
}

EMSCRIPTEN_KEEPALIVE int
px_index_file_count (void)
{
  ChainedList *current = px_index.files;
  int n = 0;

  while (current != NULL) {
    n++;
    current = current->next;
  }
  return n;
}

EMSCRIPTEN_KEEPALIVE const char *
px_index_file_path (int i)
{
  ArchiveFile *file = px_index_nth_file (i, NULL);

  return file == NULL ? "" : file->path;
}

EMSCRIPTEN_KEEPALIVE double
px_index_file_size (int i)
{
  ArchiveFile *file = px_index_nth_file (i, NULL);

  return file == NULL ? 0 : (double) file->fsstat.file_size;
}

EMSCRIPTEN_KEEPALIVE unsigned
px_index_file_mode (int i)
{
  ArchiveFile *file = px_index_nth_file (i, NULL);

  return file == NULL ? 0 : file->fsstat.mode;
}

EMSCRIPTEN_KEEPALIVE double
px_index_file_mtime (int i)
{
  ArchiveFile *file = px_index_nth_file (i, NULL);

  return file == NULL ? 0 : (double) file->fsstat.mtime;
}

EMSCRIPTEN_KEEPALIVE int
px_index_dir_count (void)
{
  ChainedList *current = px_index.dirs;
  int n = 0;

  while (current != NULL) {
    n++;
    current = current->next;
  }
  return n;
}

EMSCRIPTEN_KEEPALIVE const char *
px_index_dir_path (int i)
{
  ArchiveDirectory *dir = px_index_nth_dir (i);

  return dir == NULL ? "" : dir->path;
}

EMSCRIPTEN_KEEPALIVE unsigned
px_index_dir_mode (int i)
{
  ArchiveDirectory *dir = px_index_nth_dir (i);

  return dir == NULL ? 0 : dir->fsstat.mode;
}

EMSCRIPTEN_KEEPALIVE double
px_index_total_files (void)
{
  return (double) px_index.total_files;
}

EMSCRIPTEN_KEEPALIVE double
px_index_total_file_sizes (void)
{
  return (double) px_index.total_file_sizes;
}

EMSCRIPTEN_KEEPALIVE double
px_index_total_dirs (void)
{
  return (double) px_index.total_dirs;
}

EMSCRIPTEN_KEEPALIVE double
px_index_archive2_size (void)
{
  return (double) px_index.footer.archive2_size;
}

EMSCRIPTEN_KEEPALIVE int
px_index_archive_type (void)
{
  return px_index.header.archive_type;
}

EMSCRIPTEN_KEEPALIVE const char *
px_index_id (void)
{
  px_bytes_to_hex ((const u8 *) &px_index.header.id, 8, px_string);
  return px_string;
}

EMSCRIPTEN_KEEPALIVE const char *
px_index_psid (void)
{
  px_bytes_to_hex (px_index.footer.psid, 0x10, px_string);
  return px_string;
}

/* ------------------------------------------------------------------ */
/* Raw .dat probing / verification                                    */
/* ------------------------------------------------------------------ */

EMSCRIPTEN_KEEPALIVE int
px_probe_dat (const char *path)
{
  PagedFile file = {0};
  DatFileHeader header;
  u8 raw[sizeof (DatFileHeader)];
  int encryption_type;

  if (!paged_file_open (&file, path, TRUE))
    return -1;
  if (paged_file_read (&file, raw, sizeof (raw)) != (int) sizeof (raw)) {
    paged_file_close (&file);
    return -1;
  }
  paged_file_close (&file);

  memcpy (&header, raw, sizeof (header));
  ARCHIVE_DAT_FILE_HEADER_FROM_BE (header);
  encryption_type = (int) header.encryption_type;

  if (encryption_type != ENCRYPTION_TYPE_IDP &&
      encryption_type != ENCRYPTION_TYPE_KEYSEED)
    return -1;

  return encryption_type;
}

EMSCRIPTEN_KEEPALIVE int
px_data_read (const char *path)
{
  PX_BEGIN ();

  px_data_valid = 0;

  if (!archive_data_read (&px_data, path)) {
    if (px_error[0] == 0)
      px_set_error ("Unable to verify data file (bad HMAC)\n");
    px_active = 0;
    return -1;
  }
  px_data_valid = 1;

  PX_END ();
}

EMSCRIPTEN_KEEPALIVE const char *
px_data_id (void)
{
  px_bytes_to_hex ((const u8 *) &px_data.header.id, 8, px_string);
  return px_string;
}

EMSCRIPTEN_KEEPALIVE int
px_data_index (void)
{
  return px_data_valid ? (int) px_data.header.index : -1;
}

EMSCRIPTEN_KEEPALIVE int
px_data_archive_type (void)
{
  return px_data_valid ? (int) px_data.header.archive_type : -1;
}

EMSCRIPTEN_KEEPALIVE int
px_data_file_type (void)
{
  return px_data_valid ? (int) px_data.header.file_type : -1;
}

/* ------------------------------------------------------------------ */
/* Extraction                                                         */
/* ------------------------------------------------------------------ */

static void
px_mkdir_parent (const char *path)
{
  char parent[2048];
  char *slash;

  snprintf (parent, sizeof (parent), "%s", path);
  slash = strrchr (parent, '/');
  if (slash != NULL && slash != parent) {
    *slash = 0;
    mkdir_recursive (parent);
  }
}

static int
px_extract_entry (ArchiveIndex *index, const char *dir, u32 segment,
    u64 offset, u64 size, const char *output)
{
  px_mkdir_parent (output);

  if (!archive_extract (index, dir, segment, offset, size, output)) {
    if (px_error[0] == 0)
      px_set_error ("Unable to extract %s\n", output);
    return -1;
  }
  return 0;
}

EMSCRIPTEN_KEEPALIVE int
px_extract_file (const char *dir, const char *prefix, const char *filename,
    const char *output)
{
  ArchiveIndex index = {0};
  ArchiveFile *file = NULL;
  char index_path[1024];
  u32 segment;
  u64 offset;
  int ret = -1;

  PX_BEGIN ();

  index.prefix = prefix;
  snprintf (index_path, sizeof (index_path), "%s/%s.dat", dir, prefix);
  if (!archive_index_read (&index, index_path)) {
    if (px_error[0] == 0)
      px_set_error ("Unable to read %s\n", index_path);
    goto end;
  }

  if (!archive_find_file (&index, dir, filename, &file, &segment, &offset)) {
    px_set_error ("%s is not part of this backup\n", filename);
    goto end;
  }

  ret = px_extract_entry (&index, dir, segment, offset,
      file->fsstat.file_size, output);

 end:
  archive_index_free (&index);
  px_active = 0;
  return ret;
}

static int
px_extract_matching (const char *dir, const char *prefix, const char *match,
    const char *output_dir)
{
  ArchiveIndex index = {0};
  ChainedList *current;
  char index_path[1024];
  char segment_path[1024];
  char output[2048];
  struct stat stat_buf;
  size_t match_len = match == NULL ? 0 : strlen (match);
  u32 segment = 0;
  u64 position = 0x50;
  int ret = 0;

  index.prefix = prefix;
  snprintf (index_path, sizeof (index_path), "%s/%s.dat", dir, prefix);
  if (!archive_index_read (&index, index_path)) {
    if (px_error[0] == 0)
      px_set_error ("Unable to read %s\n", index_path);
    archive_index_free (&index);
    return 0;
  }

  snprintf (segment_path, sizeof (segment_path), "%s/%s_%02d.dat", dir,
      prefix, segment);
  if (stat (segment_path, &stat_buf) != 0) {
    px_set_error ("Missing data segment %s\n", segment_path);
    archive_index_free (&index);
    return -1;
  }

  for (current = index.files; current != NULL; current = current->next) {
    ArchiveFile *file = current->data;
    u64 size = file->fsstat.file_size;

    if (match_len == 0 || strncmp (file->path, match, match_len) == 0) {
      snprintf (output, sizeof (output), "%s/%s", output_dir, file->path);
      px_mkdir_parent (output);

      if (!archive_extract (&index, dir, segment, position, size, output)) {
        if (px_error[0] == 0)
          px_set_error ("Unable to extract %s\n", file->path);
        ret = -1;
        break;
      }
    }

    /* Walk the same segment/offset sequence archive_find_file() uses. */
    if (position + size >= (u64) stat_buf.st_size) {
      position = 0x50 + (position + size) % stat_buf.st_size;
      segment++;
      if (current->next != NULL) {
        snprintf (segment_path, sizeof (segment_path), "%s/%s_%02d.dat", dir,
            prefix, segment);
        if (stat (segment_path, &stat_buf) != 0) {
          px_set_error ("Missing data segment %s\n", segment_path);
          ret = -1;
          break;
        }
      }
    } else {
      position += size;
    }
  }

  archive_index_free (&index);
  return ret;
}

EMSCRIPTEN_KEEPALIVE int
px_extract_all (const char *dir, const char *prefix, const char *output_dir)
{
  int ret;

  PX_BEGIN ();
  ret = px_extract_matching (dir, prefix, NULL, output_dir);
  px_active = 0;
  return ret;
}

EMSCRIPTEN_KEEPALIVE int
px_extract_path (const char *dir, const char *prefix, const char *match,
    const char *output_dir)
{
  int ret;

  PX_BEGIN ();
  ret = px_extract_matching (dir, prefix, match, output_dir);
  px_active = 0;
  return ret;
}

EMSCRIPTEN_KEEPALIVE int
px_decrypt (const char *input, const char *output)
{
  int ret;

  PX_BEGIN ();
  px_mkdir_parent (output);
  ret = archive_decrypt (input, output) ? 0 : -1;
  if (ret != 0 && px_error[0] == 0)
    px_set_error ("Unable to decrypt %s (bad keys or corrupt archive)\n", input);
  px_active = 0;
  return ret;
}

/* ------------------------------------------------------------------ */
/* Building                                                           */
/* ------------------------------------------------------------------ */

EMSCRIPTEN_KEEPALIVE int
px_create_backup (const char *dir, const char *content,
    const char *protected_content)
{
  int ret;

  PX_BEGIN ();
  ret = archive_create_backup (dir, content, protected_content) ? 0 : -1;
  if (ret != 0 && px_error[0] == 0)
    px_set_error ("Unable to create backup\n");
  px_active = 0;
  return ret;
}

EMSCRIPTEN_KEEPALIVE int
px_add (const char *dir, const char *content, int is_protected)
{
  int ret;

  PX_BEGIN ();
  ret = archive_add (dir, content, is_protected) ? 0 : -1;
  if (ret != 0 && px_error[0] == 0)
    px_set_error ("Unable to add files to backup\n");
  px_active = 0;
  return ret;
}

EMSCRIPTEN_KEEPALIVE int
px_delete_file (const char *dir, const char *filename)
{
  ArchiveIndex index = {0};
  ArchiveFile *file = NULL;
  char index_path[1024];
  u32 segment;
  u64 offset;
  int ret = -1;

  PX_BEGIN ();

  index.prefix = "archive";
  snprintf (index_path, sizeof (index_path), "%s/archive.dat", dir);
  if (!archive_index_read (&index, index_path)) {
    if (px_error[0] == 0)
      px_set_error ("Unable to read %s\n", index_path);
    goto end;
  }

  if (!archive_find_file (&index, dir, filename, &file, &segment, &offset)) {
    px_set_error ("%s is not part of this backup\n", filename);
    goto end;
  }

  /* Deleting a file would require rebuilding the data archive, so the core
     removes it from the index by pointing it at a path that can never exist. */
  strcpy (file->path, "/dev_hdd0/tmp/null");

  if (!archive_index_write (&index, index_path)) {
    if (px_error[0] == 0)
      px_set_error ("Unable to write %s\n", index_path);
    goto end;
  }
  ret = 0;

 end:
  archive_index_free (&index);
  px_active = 0;
  return ret;
}

EMSCRIPTEN_KEEPALIVE int
px_delete_path (const char *dir, const char *match)
{
  ArchiveIndex index = {0};
  ChainedList *current;
  char index_path[1024];
  size_t match_len = match == NULL ? 0 : strlen (match);
  int changed = 0;
  int ret = -1;

  PX_BEGIN ();

  index.prefix = "archive";
  snprintf (index_path, sizeof (index_path), "%s/archive.dat", dir);
  if (!archive_index_read (&index, index_path)) {
    if (px_error[0] == 0)
      px_set_error ("Unable to read %s\n", index_path);
    goto end;
  }

  for (current = index.files; current != NULL; current = current->next) {
    ArchiveFile *file = current->data;

    if (strncmp (file->path, match, match_len) == 0) {
      strcpy (file->path, "/dev_hdd0/tmp/null");
      changed = 1;
    }
  }

  if (!changed) {
    px_set_error ("No file matched %s\n", match);
    goto end;
  }

  if (!archive_index_write (&index, index_path)) {
    if (px_error[0] == 0)
      px_set_error ("Unable to write %s\n", index_path);
    goto end;
  }
  ret = 0;

 end:
  archive_index_free (&index);
  px_active = 0;
  return ret;
}

EMSCRIPTEN_KEEPALIVE int
px_delete_protected (const char *dir)
{
  int ret;

  PX_BEGIN ();
  ret = archive_delete_protected (dir) ? 0 : -1;
  if (ret != 0 && px_error[0] == 0)
    px_set_error ("Unable to update archive.dat\n");
  px_active = 0;
  return ret;
}
