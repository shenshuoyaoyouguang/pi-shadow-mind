import { lstat, mkdir, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { atomicWriteFile } from "../src/atomic-file.js";

// Track fs.promises.link/copyFile/rename so tests can simulate hardlink-unavailable
// platforms (Windows without SeCreateSymbolicLinkPrivilege) and publish failures.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn((...args: Parameters<typeof actual.link>) => actual.link(...args)),
    copyFile: vi.fn((...args: Parameters<typeof actual.copyFile>) => actual.copyFile(...args)),
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => actual.rename(...args)),
  };
});

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-shadow-mind-atomic-"));
}

async function canCreateSymlink(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "pi-shadow-mind-atomic-symlink-"));
  try {
    await symlink(join(dir, "target"), join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const symlinkSupported = await canCreateSymlink();

describe("atomicWriteFile", () => {
  describe("overwrite: true (rename-based)", () => {
    it("creates a new file with the given content and no tmp remnants", async () => {
      const dir = await makeDir();
      try {
        const filePath = join(dir, "file.txt");
        await atomicWriteFile(filePath, "hello world", { overwrite: true });
        expect(await readFile(filePath, "utf8")).toBe("hello world");
        const files = await readdir(dir);
        expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("overwrites existing content", async () => {
      const dir = await makeDir();
      try {
        const filePath = join(dir, "file.txt");
        await writeFile(filePath, "old content", "utf8");
        await atomicWriteFile(filePath, "new content", { overwrite: true });
        expect(await readFile(filePath, "utf8")).toBe("new content");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("creates missing parent directories recursively", async () => {
      const dir = await makeDir();
      try {
        const filePath = join(dir, "nested", "deeper", "file.txt");
        await atomicWriteFile(filePath, "nested content", { overwrite: true });
        expect(await readFile(filePath, "utf8")).toBe("nested content");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it.skipIf(!symlinkSupported)(
      "writes through an absolute symlink, preserving the symlink itself",
      async () => {
        const dir = await makeDir();
        try {
          const targetDir = join(dir, "target-dir");
          await mkdir(targetDir, { recursive: true });
          const targetPath = join(targetDir, "real.txt");
          const linkPath = join(dir, "link.txt");
          await writeFile(targetPath, "original", "utf8");
          await symlink(targetPath, linkPath);

          await atomicWriteFile(linkPath, "updated via symlink", { overwrite: true });

          expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
          expect(await readFile(targetPath, "utf8")).toBe("updated via symlink");
          expect(await readFile(linkPath, "utf8")).toBe("updated via symlink");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );

    it.skipIf(!symlinkSupported)(
      "writes through a relative symlink, resolving relative to the link's directory",
      async () => {
        const dir = await makeDir();
        try {
          const targetPath = join(dir, "real.txt");
          const linkPath = join(dir, "link.txt");
          await writeFile(targetPath, "original", "utf8");
          // Relative link target, resolved relative to dirname(linkPath) === dir.
          await symlink("real.txt", linkPath);

          await atomicWriteFile(linkPath, "updated via relative symlink", { overwrite: true });

          expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
          expect(await readFile(targetPath, "utf8")).toBe("updated via relative symlink");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );

    it.skipIf(!symlinkSupported)(
      "writes through a symlink chain, preserving every intermediate link",
      async () => {
        const dir = await makeDir();
        try {
          const targetDir = join(dir, "deep-target");
          await mkdir(targetDir, { recursive: true });
          const targetPath = join(targetDir, "real.txt");
          const link2 = join(dir, "link2.txt");
          const link1 = join(dir, "link1.txt");
          await writeFile(targetPath, "original", "utf8");
          await symlink(targetPath, link2);
          await symlink(link2, link1);

          await atomicWriteFile(link1, "updated through the chain", { overwrite: true });

          expect((await lstat(link1)).isSymbolicLink()).toBe(true);
          expect((await lstat(link2)).isSymbolicLink()).toBe(true);
          expect(await readFile(targetPath, "utf8")).toBe("updated through the chain");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );

    it.skipIf(!symlinkSupported)(
      "writes at the final hop of a dangling chain instead of replacing the link",
      async () => {
        const dir = await makeDir();
        try {
          const missingTarget = join(dir, "shared", "not-there.txt");
          const linkPath = join(dir, "dangling.txt");
          await symlink(missingTarget, linkPath);

          await atomicWriteFile(linkPath, "revived", { overwrite: true });

          expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
          expect(await readFile(missingTarget, "utf8")).toBe("revived");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );

    it.skipIf(!symlinkSupported)(
      "resolves a symlink chain exactly 40 links deep (at the hop cap)",
      async () => {
        const dir = await makeDir();
        try {
          const targetPath = join(dir, "real.txt");
          await writeFile(targetPath, "original", "utf8");
          let previous = targetPath;
          for (let index = 0; index < 40; index += 1) {
            const linkPath = join(dir, `l${index}.txt`);
            await symlink(previous, linkPath);
            previous = linkPath;
          }
          await atomicWriteFile(previous, "deep update", { overwrite: true });
          expect(await readFile(targetPath, "utf8")).toBe("deep update");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );

    it.skipIf(!symlinkSupported)(
      "resolves relative .. hops against the physical parent, not a symlinked alias",
      async () => {
        const dir = await makeDir();
        try {
          await mkdir(join(dir, "b", "real"), { recursive: true });
          await mkdir(join(dir, "b", "shared"), { recursive: true });
          const targetPath = join(dir, "b", "shared", "g.md");
          await writeFile(targetPath, "original", "utf8");
          // dir/a-alias is a directory alias for dir/b/real; link.md uses a
          // relative .. hop. The kernel resolves ../shared against b/real, so
          // the physical parent must be used — not the a-alias lexical path.
          await symlink(join(dir, "b", "real"), join(dir, "a-alias"));
          await symlink("../shared/g.md", join(dir, "b", "real", "link.md"));

          await atomicWriteFile(join(dir, "a-alias", "link.md"), "updated via alias", { overwrite: true });

          expect(await readFile(targetPath, "utf8")).toBe("updated via alias");
          const rootEntries = await readdir(dir);
          expect(rootEntries).not.toContain("shared"); // no stray lexical tree
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );

    it("cleans up the staged tmp file when the overwrite rename fails", async () => {
      const { rename } = await import("node:fs/promises");
      const renameMock = rename as unknown as { mockRejectedValueOnce: (value: unknown) => void };
      renameMock.mockRejectedValueOnce(Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }));
      const dir = await makeDir();
      try {
        const filePath = join(dir, "file.txt");
        await writeFile(filePath, "original", "utf8");
        await expect(atomicWriteFile(filePath, "x", { overwrite: true })).rejects.toMatchObject({ code: "EPERM" });
        expect(await readFile(filePath, "utf8")).toBe("original");
        const files = await readdir(dir);
        expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("falls back to filePath when the target does not exist yet (ENOENT)", async () => {
      const dir = await makeDir();
      try {
        const filePath = join(dir, "does-not-exist-yet.txt");
        await atomicWriteFile(filePath, "fresh content", { overwrite: true });
        expect(await readFile(filePath, "utf8")).toBe("fresh content");
        expect((await lstat(filePath)).isSymbolicLink()).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("propagates lstat errors other than ENOENT", async () => {
      const dir = await makeDir();
      try {
        // A path with a non-directory path segment produces ENOTDIR on lstat,
        // not ENOENT, and should not be silently swallowed.
        const filePath = join(dir, "not-a-dir.txt");
        await writeFile(filePath, "i am a file", "utf8");
        const impossibleChildPath = join(filePath, "child.txt");
        await expect(atomicWriteFile(impossibleChildPath, "x", { overwrite: true })).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("overwrite: false (hardlink-based create)", () => {
    it("creates a new file via hardlink", async () => {
      const dir = await makeDir();
      try {
        const filePath = join(dir, "created.txt");
        await atomicWriteFile(filePath, "created content", { overwrite: false });
        expect(await readFile(filePath, "utf8")).toBe("created content");
        const files = await readdir(dir);
        expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("throws EEXIST when the target already exists and does not overwrite it", async () => {
      const dir = await makeDir();
      try {
        const filePath = join(dir, "exists.txt");
        await writeFile(filePath, "original", "utf8");
        await expect(atomicWriteFile(filePath, "attempted overwrite", { overwrite: false })).rejects.toMatchObject({
          code: "EEXIST",
        });
        expect(await readFile(filePath, "utf8")).toBe("original");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("cleans up the tmp file even when link() throws EEXIST", async () => {
      const dir = await makeDir();
      try {
        const filePath = join(dir, "exists2.txt");
        await writeFile(filePath, "original", "utf8");
        await expect(atomicWriteFile(filePath, "x", { overwrite: false })).rejects.toBeTruthy();
        const files = await readdir(dir);
        expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("falls back to O_EXCL claim + copy when link() fails with EPERM", async () => {
      const { link } = await import("node:fs/promises");
      const linkMock = link as unknown as { mockRejectedValueOnce: (value: unknown) => void };
      linkMock.mockRejectedValueOnce(Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" }));
      const dir = await makeDir();
      try {
        const filePath = join(dir, "fallback-eperm.txt");
        await atomicWriteFile(filePath, "fallback content", { overwrite: false });
        expect(await readFile(filePath, "utf8")).toBe("fallback content");
        const files = await readdir(dir);
        expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("falls back to O_EXCL claim + copy when link() fails with EACCES", async () => {
      const { link } = await import("node:fs/promises");
      const linkMock = link as unknown as { mockRejectedValueOnce: (value: unknown) => void };
      linkMock.mockRejectedValueOnce(Object.assign(new Error("EACCES: permission denied, link"), { code: "EACCES" }));
      const dir = await makeDir();
      try {
        const filePath = join(dir, "fallback-eacces.txt");
        await atomicWriteFile(filePath, "fallback content", { overwrite: false });
        expect(await readFile(filePath, "utf8")).toBe("fallback content");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("falls back to O_EXCL claim + copy when link() fails with EXDEV (cross-device)", async () => {
      const { link } = await import("node:fs/promises");
      const linkMock = link as unknown as { mockRejectedValueOnce: (value: unknown) => void };
      linkMock.mockRejectedValueOnce(Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }));
      const dir = await makeDir();
      try {
        const filePath = join(dir, "fallback-exdev.txt");
        await atomicWriteFile(filePath, "fallback content", { overwrite: false });
        expect(await readFile(filePath, "utf8")).toBe("fallback content");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("propagates unexpected link() error codes without attempting fallback", async () => {
      const { link, copyFile } = await import("node:fs/promises");
      const linkMock = link as unknown as { mockRejectedValueOnce: (value: unknown) => void };
      const copyFileMock = copyFile as unknown as { mock: { calls: unknown[][] } };
      linkMock.mockRejectedValueOnce(Object.assign(new Error("EIO: i/o error, link"), { code: "EIO" }));
      const dir = await makeDir();
      try {
        const callsBefore = copyFileMock.mock.calls.length;
        const filePath = join(dir, "unexpected-error.txt");
        await expect(atomicWriteFile(filePath, "x", { overwrite: false })).rejects.toMatchObject({ code: "EIO" });
        expect(copyFileMock.mock.calls.length).toBe(callsBefore);
        const files = await readdir(dir);
        expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("unlinks the claimed file if copyFile fails during fallback, and propagates the error", async () => {
      const { link, copyFile } = await import("node:fs/promises");
      const linkMock = link as unknown as { mockRejectedValueOnce: (value: unknown) => void };
      const copyFileMock = copyFile as unknown as { mockRejectedValueOnce: (value: unknown) => void };
      linkMock.mockRejectedValueOnce(Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" }));
      copyFileMock.mockRejectedValueOnce(new Error("disk full"));
      const dir = await makeDir();
      try {
        const filePath = join(dir, "claim-copy-fail.txt");
        await expect(atomicWriteFile(filePath, "x", { overwrite: false })).rejects.toThrow("disk full");
        // The exclusively-claimed (empty) file must be removed, not left behind.
        const files = await readdir(dir);
        expect(files).not.toContain("claim-copy-fail.txt");
        expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("creates missing parent directories recursively", async () => {
      const dir = await makeDir();
      try {
        const filePath = join(dir, "nested", "deeper", "created.txt");
        await atomicWriteFile(filePath, "nested created", { overwrite: false });
        expect(await readFile(filePath, "utf8")).toBe("nested created");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});