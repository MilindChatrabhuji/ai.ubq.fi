#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <node_api.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__aarch64__)
#error "Confinement has only been validated on Linux ARM64"
#endif
#ifndef LANDLOCK_RESTRICT_SELF_TSYNC
#define LANDLOCK_RESTRICT_SELF_TSYNC (1U << 3)
#endif

/* Primary ABI: docs.kernel.org/userspace-api/{landlock,seccomp_filter}.html. */
static napi_value failure(napi_env env, const char *operation) {
  char message[192];
  snprintf(message, sizeof(message), "%s failed: errno %d", operation, errno);
  napi_throw_error(env, "LINUX_CONFINEMENT_UNAVAILABLE", message);
  return NULL;
}

static char *string_value(napi_env env, napi_value value) {
  size_t length;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length > 4096) {
    napi_throw_type_error(env, NULL, "Confinement path must be a bounded string");
    return NULL;
  }
  char *path = malloc(length + 1);
  if (!path) { errno = ENOMEM; failure(env, "Path allocation"); return NULL; }
  if (napi_get_value_string_utf8(env, value, path, length + 1, &length) != napi_ok) {
    free(path);
    napi_throw_type_error(env, NULL, "Confinement path cannot be decoded");
    return NULL;
  }
  return path;
}

static int landlock_abi(void) {
  return (int)syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
}

static napi_value support(napi_env env, napi_callback_info info) {
  (void)info;
  int abi = landlock_abi();
  if (abi < 0) return failure(env, "Landlock ABI query");
  uint32_t action = SECCOMP_RET_ERRNO;
  bool available = syscall(__NR_seccomp, SECCOMP_GET_ACTION_AVAIL, 0, &action) == 0;
  napi_value result, version, seccomp;
  napi_create_object(env, &result);
  napi_create_int32(env, abi, &version);
  napi_get_boolean(env, available, &seccomp);
  napi_set_named_property(env, result, "landlockAbi", version);
  napi_set_named_property(env, result, "seccomp", seccomp);
  return result;
}

static napi_value readonly_mount(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument;
  napi_get_cb_info(env, info, &argc, &argument, NULL, NULL);
  if (argc != 1) { napi_throw_type_error(env, NULL, "A mount path is required"); return NULL; }
  char *path = string_value(env, argument);
  if (!path) return NULL;
  struct statfs filesystem;
  int status = statfs(path, &filesystem);
  free(path);
  if (status != 0) return failure(env, "Immutable mount inspection");
  napi_value result;
  napi_get_boolean(env, (filesystem.f_flags & 1) != 0, &result);
  return result;
}

static int install_process_filter(void) {
  struct sock_filter filter[128];
  size_t length = 0;
#define STMT(code, value) filter[length++] = (struct sock_filter)BPF_STMT(code, value)
#define JUMP(code, value, yes, no) filter[length++] = (struct sock_filter)BPF_JUMP(code, value, yes, no)
#define DENY(number) do { JUMP(BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1); STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM); } while (0)
  STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0);
  STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
  STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
  /* clone3's pointer cannot be inspected by BPF. glibc's ENOSYS fallback uses clone. */
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1);
  STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS);
  DENY(__NR_execve);
  DENY(__NR_execveat);
  DENY(__NR_fchmod);
  DENY(__NR_fchmodat);
  DENY(__NR_fchownat);
  DENY(__NR_fchown);
  DENY(__NR_utimensat);
  DENY(__NR_setxattr);
  DENY(__NR_lsetxattr);
  DENY(__NR_fsetxattr);
  DENY(__NR_removexattr);
  DENY(__NR_lremovexattr);
  DENY(__NR_fremovexattr);
  DENY(__NR_ptrace);
  DENY(__NR_process_vm_readv);
  DENY(__NR_process_vm_writev);
#ifdef __NR_fchmodat2
  DENY(__NR_fchmodat2);
#endif
#ifdef __NR_setxattrat
  DENY(__NR_setxattrat);
#endif
#ifdef __NR_removexattrat
  DENY(__NR_removexattrat);
#endif
#ifdef __NR_file_setattr
  DENY(__NR_file_setattr);
#endif
  JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 3);
  STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
  JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_THREAD, 1, 0);
  STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
  STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  struct sock_fprog program = { .len = (unsigned short)length, .filter = filter };
  return (int)syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, &program);
#undef STMT
#undef JUMP
#undef DENY
}

static napi_value enforce(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value grants;
  napi_get_cb_info(env, info, &argc, &grants, NULL, NULL);
  uint32_t count;
  if (argc != 1 || napi_get_array_length(env, grants, &count) != napi_ok || count > 1024) {
    napi_throw_type_error(env, NULL, "Confinement requires a bounded grant array");
    return NULL;
  }
  int abi = landlock_abi();
  if (abi < 8) { errno = ENOTSUP; return failure(env, "Supported Landlock ABI8+"); }
  struct landlock_ruleset_attr attributes = { .handled_access_fs = 0x7fffULL | (abi >= 9 ? (1ULL << 16) : 0) };
  int ruleset = (int)syscall(__NR_landlock_create_ruleset, &attributes, sizeof(uint64_t), 0);
  if (ruleset < 0) return failure(env, "Landlock ruleset creation");
  for (uint32_t index = 0; index < count; index++) {
    napi_value grant, path_value, access_value;
    uint32_t access;
    if (napi_get_element(env, grants, index, &grant) != napi_ok ||
        napi_get_named_property(env, grant, "path", &path_value) != napi_ok ||
        napi_get_named_property(env, grant, "access", &access_value) != napi_ok ||
        napi_get_value_uint32(env, access_value, &access) != napi_ok ||
        (access & 1) || (access & ~attributes.handled_access_fs)) {
      close(ruleset);
      napi_throw_type_error(env, NULL, "Invalid non-executable filesystem grant");
      return NULL;
    }
    char *path = string_value(env, path_value);
    if (!path) { close(ruleset); return NULL; }
    int fd = open(path, O_PATH | O_CLOEXEC);
    free(path);
    if (fd < 0) { close(ruleset); return failure(env, "Landlock path opening"); }
    struct landlock_path_beneath_attr rule = { .allowed_access = access, .parent_fd = fd };
    int status = (int)syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
    int saved_errno = errno;
    close(fd);
    if (status != 0) { close(ruleset); errno = saved_errno; return failure(env, "Landlock path grant"); }
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) { close(ruleset); return failure(env, "No-new-privileges enforcement"); }
  /* After this irreversible transition any failure terminates this dedicated child. */
  if (syscall(__NR_landlock_restrict_self, ruleset, LANDLOCK_RESTRICT_SELF_TSYNC) != 0) {
    dprintf(STDERR_FILENO, "Landlock thread synchronization failed: errno %d\n", errno);
    _exit(78);
  }
  close(ruleset);
  if (install_process_filter() != 0) {
    dprintf(STDERR_FILENO, "Seccomp thread synchronization failed: errno %d\n", errno);
    _exit(78);
  }
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    { "support", NULL, support, NULL, NULL, NULL, napi_default, NULL },
    { "readonlyMount", NULL, readonly_mount, NULL, NULL, NULL, napi_default, NULL },
    { "enforce", NULL, enforce, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, 3, properties);
  return exports;
}
