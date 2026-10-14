import { prepareReleasePayload, verifyReleasePayload, releaseSourceTree } from "./release-artifact.ts";
import { chmod, lstat, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { missing } from "./io.ts";
const readTextFile = (path: string): Promise<string> => readFile(path, "utf8");
/** Shared immutable-release primitives for the existing CLI and bound controller. */
export const VPS_UNIT_SHA256 = "6563f11090766cc784361bc71a0c9c244bfa41c0f0e2163355a1f558000d3d44";
export const VPS_LAUNCHER_PROFILE_SHA256 = "50435a214d34cb7fbae3735a0a0502f8d96aaa3257dc502edc01bd64a8429ca7";
export type StoredVpsRelease = { sha: string; path: string; archive: string; tree: string };
export type StoredVpsPrior = StoredVpsRelease & { selector: string; port: number; profile: string };
export type VpsCommand = (program: string, args: string[], cwd: string) => Promise<string>;
export async function vpsBytesDigest(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", input))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export const vpsTextDigest = (text: string): Promise<string> => vpsBytesDigest(new TextEncoder().encode(text));
async function removeTemporary(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

export class ImmutableVpsReleaseStore {
  constructor(
    readonly root: string,
    private readonly _run: VpsCommand
  ) {}
  absolute(path: string): string {
    return `${this.root}/${path}`;
  }
  async exists(path: string): Promise<boolean> {
    try {
      await lstat(this.absolute(path));
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }
  async assertDirectories(): Promise<void> {
    if ((await realpath(this.root)) !== this.root) throw new Error("VPS release root is unsafe");
    for (const path of [".data", ".data/releases"]) {
      if (!(await this.exists(path))) continue;
      const stat = await lstat(this.absolute(path));
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(this.absolute(path))) !== this.absolute(path))
        throw new Error("VPS release directory is unsafe");
    }
  }
  async treeDigest(path: string): Promise<string> {
    const entries: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      const names: string[] = [];
      for (const entry of await readdir(`${path}/${relative}`)) names.push(entry);
      names.sort((left, right) => left.localeCompare(right));
      for (const name of names) {
        const entry = relative ? `${relative}/${name}` : name,
          absolute = `${path}/${entry}`;
        const stat = await lstat(absolute),
          mode = stat.mode & 0o777;
        if (stat.isSymbolicLink()) entries.push(JSON.stringify([entry, "link", mode, await readlink(absolute)]));
        else if (stat.isFile()) entries.push(JSON.stringify([entry, "file", mode, await vpsBytesDigest(await readFile(absolute))]));
        else if (stat.isDirectory()) {
          entries.push(JSON.stringify([entry, "directory", mode]));
          await walk(entry);
        } else throw new Error("Unsupported immutable release entry");
      }
    };
    await walk("");
    return vpsTextDigest(entries.join("\n"));
  }
  async expectedRelease(sha: string, payload = false): Promise<StoredVpsRelease> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("A full immutable release revision is required");
    const staging = await mkdtemp(this.absolute(".data/releases/.staging-"));
    const archivePath = `${staging}.tar`;
    try {
      await this._run("git", ["archive", "--format=tar", `--output=${archivePath}`, sha], this.root);
      const archive = await vpsBytesDigest(await readFile(archivePath));
      await this._run("tar", ["-xf", archivePath, "-C", staging], this.root);
      const directory = await lstat(`${staging}/src`);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe generated release directory in source archive");
      for (const generated of ["src/release.ts", ".uos-release.json"]) {
        try {
          const stat = await lstat(`${staging}/${generated}`);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe generated release file in source archive");
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      await writeFile(`${staging}/src/release.ts`, `// Generated for this immutable VPS release.\nexport const RELEASE_GIT_SHA = "${sha}";\n`, {
        mode: 0o600,
      });
      await chmod(`${staging}/src/release.ts`, 0o600);
      await writeFile(`${staging}/.uos-release.json`, JSON.stringify({ git_sha: sha, source_archive_sha256: archive }) + "\n", { mode: 0o600 });
      await chmod(`${staging}/.uos-release.json`, 0o600);
      if (payload) await this._prepareBunPayload(staging, sha, archive);
      return { sha, path: staging.slice(this.root.length + 1), archive, tree: await this.treeDigest(staging) };
    } catch (error) {
      await rm(staging, { recursive: true });
      throw error;
    } finally {
      await removeTemporary(archivePath);
    }
  }
  private async _prepareBunPayload(staging: string, sha: string, archive: string): Promise<void> {
    const packageFile = `${staging}/package.json`;
    if (!(await this.exists(packageFile.slice(this.root.length + 1)))) return;
    const metadata: unknown = JSON.parse(await readTextFile(packageFile));
    if (metadata && typeof metadata === "object" && "packageManager" in metadata && metadata.packageManager === "bun@1.4.0")
      await prepareReleasePayload(staging, sha, archive);
  }
  private async _verifyPublished(absolute: string, expected: StoredVpsRelease, bun: boolean): Promise<void> {
    if (bun) {
      const manifest = await verifyReleasePayload(absolute, expected.sha, await releaseSourceTree(this.absolute(expected.path)));
      if (manifest.source_archive_sha256 !== expected.archive) throw new Error("Immutable source archive digest changed");
      expected.tree = await this.treeDigest(absolute);
      return;
    }
    if ((await this.treeDigest(absolute)) !== expected.tree)
      throw new Error("Immutable release bytes, manifest or complete tree do not match the source archive");
  }
  async checkedRelease(sha: string, create = false): Promise<StoredVpsRelease> {
    const path = `.data/releases/${sha}`,
      absolute = this.absolute(path),
      present = await this.exists(path);
    if (present) {
      const stat = await lstat(absolute),
        manifest = await lstat(`${absolute}/.uos-release.json`);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(absolute)) !== absolute || !manifest.isFile() || manifest.isSymbolicLink())
        throw new Error("Immutable release root or manifest is unsafe");
    } else if (!create) throw new Error("Previous immutable release is missing");
    const metadata: unknown = present ? JSON.parse(await readTextFile(`${absolute}/.uos-release.json`)) : null;
    const bun = metadata !== null && typeof metadata === "object" && "schema" in metadata && metadata.schema === 2;
    const expected = await this.expectedRelease(sha, !present);
    try {
      if (present) await this._verifyPublished(absolute, expected, bun);
      else await rename(this.absolute(expected.path), absolute);
      return { ...expected, path };
    } finally {
      if (await this.exists(expected.path)) await rm(this.absolute(expected.path), { recursive: true });
    }
  }
  async selector(): Promise<string | null> {
    if (!(await this.exists(".data/current"))) return null;
    if (!(await lstat(this.absolute(".data/current"))).isSymbolicLink()) throw new Error("The current release selector must be a symlink");
    return readlink(this.absolute(".data/current"));
  }
  async checkedPrevious(selected: string): Promise<StoredVpsPrior> {
    const physical = await realpath(this.absolute(".data/current"));
    const sha = physical.slice(physical.lastIndexOf("/") + 1);
    if (physical !== this.absolute(`.data/releases/${sha}`) || !/^[0-9a-f]{40}$/.test(sha))
      throw new Error("Previous selector is outside the immutable release store");
    return this.checkedPreviousRelease(sha, selected);
  }
  async checkedPreviousRelease(sha: string, selected: string): Promise<StoredVpsPrior> {
    const path = selected.startsWith("/") ? selected : this.absolute(`.data/${selected}`);
    if ((await realpath(path)) !== this.absolute(`.data/releases/${sha}`)) throw new Error("Previous recovery selector is outside its verified release");
    const previous = await this.checkedRelease(sha);
    const launcher = await readTextFile(this.absolute(`${previous.path}/scripts/serve-vps.ts`));
    const matches = [...launcher.matchAll(/port: (\d+)/g)],
      port = Number(matches[0]?.[1]);
    const profile = await vpsTextDigest(launcher.replace(/port: \d+/, "port: 0"));
    const unit = await this.unitDigest(sha);
    const supported =
      profile === VPS_LAUNCHER_PROFILE_SHA256
        ? unit === VPS_UNIT_SHA256
        : profile === (await this.currentLauncherProfile()) && unit === (await vpsBytesDigest(await readFile(this.absolute("ops/ai-ubq-fi.service"))));
    if (matches.length !== 1 || port < 1 || port > 65535 || !supported) throw new Error("Unsupported previous launcher or service layout");
    return { ...previous, selector: selected, port, profile };
  }
  currentLauncherProfile(): Promise<string> {
    return readTextFile(this.absolute("scripts/serve-vps.ts")).then((source) => vpsTextDigest(source.replace(/port: \d+/, "port: 0")));
  }
  unitDigest(sha: string): Promise<string> {
    return readFile(this.absolute(`.data/releases/${sha}/ops/ai-ubq-fi.service`)).then(vpsBytesDigest);
  }
  async assertRollbackAllowed(prior: StoredVpsPrior, candidateSha: string): Promise<void> {
    const metadata: unknown = JSON.parse(await readTextFile(this.absolute(`.data/releases/${candidateSha}/.uos-release.json`)));
    if (prior.profile === VPS_LAUNCHER_PROFILE_SHA256 && metadata && typeof metadata === "object" && "schema" in metadata && metadata.schema === 2)
      throw new Error("Cross-codec rollback requires stopped latest-state Bun-to-Deno conversion; refusing stale legacy state");
  }
  async selectRelease(target: string | null): Promise<void> {
    if (target === null) {
      await rm(this.absolute(".data/current"));
      return;
    }
    const next = this.absolute(`.data/current-${crypto.randomUUID()}`);
    try {
      await symlink(target, next);
      await rename(next, this.absolute(".data/current"));
    } finally {
      await removeTemporary(next);
    }
  }
}
