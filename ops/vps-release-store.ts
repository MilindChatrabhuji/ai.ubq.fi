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
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
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
      await Deno.lstat(this.absolute(path));
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }
  async assertDirectories(): Promise<void> {
    if ((await Deno.realPath(this.root)) !== this.root) throw new Error("VPS release root is unsafe");
    for (const path of [".data", ".data/releases"]) {
      if (!(await this.exists(path))) continue;
      const stat = await Deno.lstat(this.absolute(path));
      if (!stat.isDirectory || stat.isSymlink || (await Deno.realPath(this.absolute(path))) !== this.absolute(path))
        throw new Error("VPS release directory is unsafe");
    }
  }
  async treeDigest(path: string): Promise<string> {
    const entries: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      const names: string[] = [];
      for await (const entry of Deno.readDir(`${path}/${relative}`)) names.push(entry.name);
      names.sort((left, right) => left.localeCompare(right));
      for (const name of names) {
        const entry = relative ? `${relative}/${name}` : name,
          absolute = `${path}/${entry}`;
        const stat = await Deno.lstat(absolute),
          mode = (stat.mode ?? 0) & 0o777;
        if (stat.isSymlink) entries.push(JSON.stringify([entry, "link", mode, await Deno.readLink(absolute)]));
        else if (stat.isFile) entries.push(JSON.stringify([entry, "file", mode, await vpsBytesDigest(await Deno.readFile(absolute))]));
        else if (stat.isDirectory) {
          entries.push(JSON.stringify([entry, "directory", mode]));
          await walk(entry);
        } else throw new Error("Unsupported immutable release entry");
      }
    };
    await walk("");
    return vpsTextDigest(entries.join("\n"));
  }
  async expectedRelease(sha: string): Promise<StoredVpsRelease> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("A full immutable release revision is required");
    const staging = await Deno.makeTempDir({ dir: this.absolute(".data/releases"), prefix: ".staging-" });
    const archivePath = `${staging}.tar`;
    try {
      await this._run("git", ["archive", "--format=tar", `--output=${archivePath}`, sha], this.root);
      const archive = await vpsBytesDigest(await Deno.readFile(archivePath));
      await this._run("tar", ["-xf", archivePath, "-C", staging], this.root);
      const directory = await Deno.lstat(`${staging}/src`);
      if (!directory.isDirectory || directory.isSymlink) throw new Error("Unsafe generated release directory in source archive");
      for (const generated of ["src/release.ts", ".uos-release.json"]) {
        try {
          const stat = await Deno.lstat(`${staging}/${generated}`);
          if (!stat.isFile || stat.isSymlink) throw new Error("Unsafe generated release file in source archive");
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
      await Deno.writeTextFile(`${staging}/src/release.ts`, `// Generated for this immutable VPS release.\nexport const RELEASE_GIT_SHA = "${sha}";\n`, {
        mode: 0o600,
      });
      await Deno.chmod(`${staging}/src/release.ts`, 0o600);
      await Deno.writeTextFile(`${staging}/.uos-release.json`, JSON.stringify({ git_sha: sha, source_archive_sha256: archive }) + "\n", { mode: 0o600 });
      await Deno.chmod(`${staging}/.uos-release.json`, 0o600);
      return { sha, path: staging.slice(this.root.length + 1), archive, tree: await this.treeDigest(staging) };
    } catch (error) {
      await Deno.remove(staging, { recursive: true });
      throw error;
    } finally {
      await removeTemporary(archivePath);
    }
  }
  async checkedRelease(sha: string, create = false): Promise<StoredVpsRelease> {
    const path = `.data/releases/${sha}`,
      absolute = this.absolute(path),
      present = await this.exists(path);
    if (present) {
      const stat = await Deno.lstat(absolute),
        manifest = await Deno.lstat(`${absolute}/.uos-release.json`);
      if (!stat.isDirectory || stat.isSymlink || (await Deno.realPath(absolute)) !== absolute || !manifest.isFile || manifest.isSymlink)
        throw new Error("Immutable release root or manifest is unsafe");
    } else if (!create) throw new Error("Previous immutable release is missing");
    const expected = await this.expectedRelease(sha);
    try {
      if (present) {
        if ((await this.treeDigest(absolute)) !== expected.tree)
          throw new Error("Immutable release bytes, manifest or complete tree do not match the source archive");
      } else await Deno.rename(this.absolute(expected.path), absolute);
      return { ...expected, path };
    } finally {
      if (await this.exists(expected.path)) await Deno.remove(this.absolute(expected.path), { recursive: true });
    }
  }
  async selector(): Promise<string | null> {
    if (!(await this.exists(".data/current"))) return null;
    if (!(await Deno.lstat(this.absolute(".data/current"))).isSymlink) throw new Error("The current release selector must be a symlink");
    return Deno.readLink(this.absolute(".data/current"));
  }
  async checkedPrevious(selected: string): Promise<StoredVpsPrior> {
    const physical = await Deno.realPath(this.absolute(".data/current"));
    const sha = physical.slice(physical.lastIndexOf("/") + 1);
    if (physical !== this.absolute(`.data/releases/${sha}`) || !/^[0-9a-f]{40}$/.test(sha))
      throw new Error("Previous selector is outside the immutable release store");
    return this.checkedPreviousRelease(sha, selected);
  }
  async checkedPreviousRelease(sha: string, selected: string): Promise<StoredVpsPrior> {
    const path = selected.startsWith("/") ? selected : this.absolute(`.data/${selected}`);
    if ((await Deno.realPath(path)) !== this.absolute(`.data/releases/${sha}`)) throw new Error("Previous recovery selector is outside its verified release");
    const previous = await this.checkedRelease(sha);
    const launcher = await Deno.readTextFile(this.absolute(`${previous.path}/scripts/serve-vps.ts`));
    const matches = [...launcher.matchAll(/port: (\d+)/g)],
      port = Number(matches[0]?.[1]);
    const profile = await vpsTextDigest(launcher.replace(/port: \d+/, "port: 0"));
    if (
      matches.length !== 1 ||
      port < 1 ||
      port > 65535 ||
      profile !== VPS_LAUNCHER_PROFILE_SHA256 ||
      (await vpsBytesDigest(await Deno.readFile(this.absolute("ops/ai-ubq-fi.service")))) !== VPS_UNIT_SHA256 ||
      (await vpsBytesDigest(await Deno.readFile(this.absolute(`${previous.path}/ops/ai-ubq-fi.service`)))) !== VPS_UNIT_SHA256
    )
      throw new Error("Unsupported previous launcher or service layout");
    return { ...previous, selector: selected, port, profile };
  }
  async selectRelease(target: string | null): Promise<void> {
    if (target === null) {
      await Deno.remove(this.absolute(".data/current"));
      return;
    }
    const next = this.absolute(`.data/current-${crypto.randomUUID()}`);
    try {
      await Deno.symlink(target, next);
      await Deno.rename(next, this.absolute(".data/current"));
    } finally {
      await removeTemporary(next);
    }
  }
}
