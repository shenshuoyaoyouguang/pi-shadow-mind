import { copyFile, link, lstat, mkdir, open, readlink, rename, unlink, writeFile } from "node:fs/promises";
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
  await writeFile(tmpPath, data, "utf8");
  if (options.overwrite) {
    await rename(tmpPath, targetPath);
    return;
  }
  try {
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

async function resolveOverwriteTarget(filePath: string): Promise<string> {
  try {
    const entry = await lstat(filePath);
    if (!entry.isSymbolicLink()) return filePath;
    const linkedPath = await readlink(filePath);
    return isAbsolute(linkedPath) ? linkedPath : resolve(dirname(filePath), linkedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return filePath;
    throw error;
  }
}

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
