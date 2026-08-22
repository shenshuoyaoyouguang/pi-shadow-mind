import { copyFile, link, lstat, mkdir, open, readlink, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Write `data` to `filePath` without exposing a partially written file.
 *
 * - overwrite: stage to a temp file, then rename it onto the target (atomic on POSIX and NTFS).
 * - create: claim the target exclusively so a concurrent create cannot clobber it. The preferred
 *   claim is a hard link (the file appears fully formed), but on Windows hard links require
 *   SeCreateSymbolicLinkPrivilege (administrators or developer mode); when that is unavailable
 *   (EPERM/EACCES) or the paths are on different volumes (EXDEV), fall back to an O_EXCL claim
 *   plus copy of the staged content.
 */
export async function atomicWriteFile(filePath: string, data: string, options: { overwrite: boolean }): Promise<void> {
  const targetPath = options.overwrite ? await resolveOverwriteTarget(filePath) : filePath;
  await mkdir(dirname(targetPath), { recursive: true });
  const tmpPath = join(dirname(targetPath), `.${basename(targetPath)}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFile(tmpPath, data, "utf8");
    if (options.overwrite) {
      await rename(tmpPath, targetPath);
      return;
    }
    try {
      await link(tmpPath, targetPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || !(code === "EPERM" || code === "EACCES" || code === "EXDEV")) throw error;
      await claimAndCopy(tmpPath, targetPath);
    }
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

const MAX_SYMLINK_HOPS = 40;

/**
 * Follow the complete symlink chain so an overwrite publishes to the final
 * target instead of replacing an intermediate link. A dangling chain resolves
 * to its missing last hop and writes there. The hop cap is a cycle safety
 * valve, deliberately above the OS ELOOP limits (Linux 40, macOS 32) — every
 * hop is checked, so chains at or under the cap always resolve.
 */
async function resolveOverwriteTarget(filePath: string): Promise<string> {
  let current = filePath;
  for (let hops = 0; ; hops += 1) {
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return current;
      throw error;
    }
    if (!entry.isSymbolicLink()) return current;
    if (hops >= MAX_SYMLINK_HOPS) throw new Error(`symlink chain too deep: ${filePath}`);
    const linkedPath = await readlink(current);
    if (isAbsolute(linkedPath)) {
      current = linkedPath;
    } else {
      // The kernel resolves `..` hops against the physical parent, not the
      // lexical alias the chain may have been entered through.
      const physicalParent = await realpath(dirname(current));
      current = resolve(physicalParent, linkedPath);
    }
  }
}

/**
 * Windows fallback for the hardlink claim. The O_EXCL claim is exclusive but
 * empty for the sub-millisecond copy, so a concurrent reader may observe a
 * partial file; exclusivity (never clobbering a racing create) is prioritized
 * over that transient visibility because no atomic create-with-content
 * primitive exists without hardlink support.
 */
async function claimAndCopy(tmpPath: string, filePath: string): Promise<void> {
  const handle = await open(filePath, "wx");
  await handle.close();
  try {
    await copyFile(tmpPath, filePath);
  } catch (error) {
    // Never leave an empty or partial file claiming the id.
    await unlink(filePath).catch(() => {});
    throw error;
  }
}
