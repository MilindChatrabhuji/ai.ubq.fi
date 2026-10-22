#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>

struct ruleset_attr { uint64_t fs; uint64_t net; uint64_t scoped; };
_Static_assert(sizeof(struct ruleset_attr) == 24, "exact Landlock attribute size");
int main(void) {
    struct ruleset_attr attr = {0x1ffff, 3, 3};
    errno = 0;
    long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, 1);
    int abi_errno = errno;
    errno = 0;
    long fd = syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
    int create_errno = errno;
    int closed = -1, close_errno = 0;
    if (fd >= 0) { errno = 0; closed = close((int)fd); close_errno = errno; }
    printf("{\"abi\":%ld,\"abiErrno\":%d,\"createResult\":%ld,\"createErrno\":%d,\"closeResult\":%d,\"closeErrno\":%d,\"attrBytes\":24,\"fsMask\":131071,\"netMask\":3,\"scopedMask\":3}\n",
           abi, abi_errno, fd, create_errno, closed, close_errno);
    return !(abi >= 9 && abi_errno == 0 && fd >= 0 && create_errno == 0 && closed == 0 && close_errno == 0);
}
