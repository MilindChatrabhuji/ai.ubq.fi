/** Match native filesystem errors without treating other failures as missing entries. */
export const isFsError = (error: unknown, code: "ENOENT" | "EACCES" | "EPERM"): boolean => error instanceof Error && "code" in error && error.code === code;
