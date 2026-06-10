import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  /**
   * fsync the temp file before rename. Use for shared registry files where the
   * extra syscall is worth the stronger durability; ordinary status/cache files
   * can use the default tmp+rename path.
   */
  fsync?: boolean;
  /**
   * Permission mode for the temp file (and therefore the renamed target). When
   * set, the temp file is created with this mode FROM THE START, closing the
   * brief world-readable window a post-rename chmod would otherwise leave open
   * (CWE-732). e.g. pass 0o600 for secrets. Subject to the process umask, which
   * can only further restrict — never widen — these bits. Defaults to 0o666.
   */
  mode?: number;
}

function tmpPathFor(targetPath: string): string {
  return `${targetPath}.tmp.${process.pid}.${randomUUID()}`;
}

export function atomicWriteText(path: string, content: string, options: AtomicWriteOptions = {}): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = tmpPathFor(path);
  let renamed = false;
  const fd = fs.openSync(tmp, "w", options.mode ?? 0o666);
  try {
    try {
      fs.writeFileSync(fd, content, "utf-8");
      if (options.fsync) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }
}

export function atomicWriteJson(path: string, value: unknown, options: AtomicWriteOptions = {}): void {
  atomicWriteText(path, JSON.stringify(value, null, 2) + "\n", options);
}
