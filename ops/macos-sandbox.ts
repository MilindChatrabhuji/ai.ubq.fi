export type MacSandboxPaths = Readonly<{ release: string; runtime: string; root: string; nativeHome: string; control: string; externalNativeAuth?: string }>;
/** Seatbelt applies before Bun starts the application child. */
export const macSandboxProfile = (paths: MacSandboxPaths): string => {
  const quote = (path: string): string => JSON.stringify(path);
  const read = [
    paths.release,
    paths.runtime,
    paths.nativeHome,
    paths.control,
    paths.root + "/.data",
    "/System",
    "/usr/lib",
    "/Library/Apple",
    "/private/etc/ssl",
    "/private/var/db/timezone",
  ];
  const exactRead = [
    paths.root + "/.env",
    ...(paths.externalNativeAuth ? [paths.externalNativeAuth] : []),
    "/dev/null",
    "/dev/urandom",
    "/dev/random",
    "/private/etc/resolv.conf",
    "/private/etc/hosts",
    "/private/etc/localtime",
  ];
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow network* mach-lookup sysctl-read process-info* signal)",
    "(allow process-exec (literal " + quote(paths.runtime) + "))",
    "(allow process-fork)",
    "(allow file-read* " +
      read.map((path) => "(subpath " + quote(path) + ")").join(" ") +
      " " +
      exactRead.map((path) => "(literal " + quote(path) + ")").join(" ") +
      ")",
    "(allow file-write* (subpath " + quote(paths.root + "/.data") + ") (subpath " + quote(paths.control) + "))",
    "(deny file-write* " +
      [paths.root + "/.data/releases", paths.root + "/.data/runtimes", paths.release, paths.runtime].map((path) => "(subpath " + quote(path) + ")").join(" ") +
      ")",
  ].join("\n");
};
