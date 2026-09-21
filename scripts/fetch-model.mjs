/**
 * Download a GGUF model over HTTPS into ./models/ with resume + integrity check.
 *
 * Exports:
 *   GGUFDownloader   — class for download + verify + resume logic
 *   computeMD5       — MD5 checksum of a local file (streaming)
 *
 * CLI (unchanged):
 *   node scripts/fetch-model.mjs <gguf-url> [outfile.gguf]
 */

import { createWriteStream, existsSync, mkdirSync, statSync, readFileSync, realpathSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// GGUFDownloader
// ---------------------------------------------------------------------------

export class GGUFDownloader {
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this.progress = opts.progress !== false;
    this.onProgress = opts.onProgress || null;
  }

  /**
   * Main download entry point. Accepts a factory function for fetch so tests
   * can inject mocks.
   *
   * Strategy:
   *  1. If a partial file exists, try a Range request.
   *  2. Validate the server's response (206 = resume OK, 200 = no resume, 416 = can't resume).
   *  3. Stream to disk, appending if resuming.
   *  4. Verify file size against total from Content-Range (or Content-Length).
   *  5. Verify MD5 if the server sent Content-MD5.
   */
  async download(fetchFn) {
    const hasPartial = existsSync(this.filePath);
    const existingSize = hasPartial ? statSync(this.filePath).size : 0;
    let res;

    if (hasPartial && existingSize > 0) {
      res = await fetchFn("GET", undefined, {
        headers: { Range: `bytes=${existingSize}-` },
      });
    } else {
      res = await fetchFn("GET", undefined, {});
    }

    const contentLength = Number(res.headers.get("Content-Length") || 0);

    // For 206: Content-Length is the chunk size; total from Content-Range.
    // Content-Range: bytes N-M/* means unknown total.
    let totalFileSize;
    let md5Checksum = null;
    if (res.status === 206) {
      const range = res.headers.get("Content-Range");
      if (!range) throw new ResumeCheckFailed("206 without Content-Range");
      const totalMatch = range.match(/\/(\d+)$/);
      if (totalMatch) totalFileSize = Number(totalMatch[1]); // undefined if *
      const offsetMatch = range.match(/bytes (\d+)-/);
      if (!offsetMatch) throw new ResumeCheckFailed(`unparseable Content-Range: ${range}`);
      const serverOffset = Number(offsetMatch[1]);
      if (serverOffset !== existingSize) {
        throw new ResumeCheckFailed(
          `partial size (${existingSize}) doesn't match server offset (${serverOffset}); delete and retry`,
        );
      }
    } else {
      totalFileSize = contentLength || undefined;
    }

    // Content-MD5 from response header
    const contentMD5 = res.headers.get("Content-MD5");
    if (contentMD5) md5Checksum = contentMD5.trim();

    // --- Resume / fallback validation ---
    if (hasPartial && existingSize > 0) {
      if (res.status === 206) {
        // resume validated above
      } else if (res.status === 200) {
        console.warn(`server doesn't support resume; starting fresh download`);
      } else if (res.status === 416) {
        throw new ResumeCheckFailed(
          `server returned 416 (Range Not Satisfiable); partial may be corrupt, delete ${this.filePath} and retry`,
        );
      } else {
        throw new ResumeCheckFailed(`unexpected status ${res.status} during resume attempt`);
      }
    }

    if (!res.ok) {
      throw new FetchFailed(`${res.status} ${res.statusText}`);
    }

    // --- Stream to disk (with inline MD5 hash) ---
    const writeMode = (hasPartial && existingSize > 0 && res.status === 206) ? "a" : "w";
    const body = Readable.fromWeb(res.body);
    let received = existingSize;

    await new Promise((resolve, reject) => {
      const ws = createWriteStream(this.filePath, { flags: writeMode });
      body.on("data", (chunk) => {
        received += chunk.length;
        if (this.progress && contentLength) {
          const target = totalFileSize || contentLength;
          const pct = ((received / (target + (res.status === 206 ? existingSize : 0))) * 100).toFixed(1);
          process.stdout.write(`\r  ${pct}%   `);
        }
      });
      pipeline(body, ws).then(resolve, reject);
    });

    if (this.progress && contentLength) {
      process.stdout.write(`\n`);
      this._reportProgress(100);
    }

    // --- Verify ---
    if (totalFileSize) await this.verifyFile({ contentLength: String(totalFileSize), checksum: md5Checksum });
  }

  /**
   * Verify the downloaded file against declared Content-Length and/or checksum.
   * @param {{ contentLength?: string, checksum?: string }} opts
   */
  async verifyFile({ contentLength, checksum } = {}) {
    const actualSize = statSync(this.filePath).size;

    if (contentLength && actualSize !== Number(contentLength)) {
      throw new IntegrityError(
        `Content-Length mismatch: declared ${contentLength} bytes, got ${actualSize} bytes`,
      );
    }

    if (checksum) {
      const expected = checksum.trim();
      const actual = computeMD5(this.filePath);
      if (actual !== expected) {
        throw new IntegrityError(
          `MD5 mismatch: expected ${expected}, got ${actual}`,
        );
      }
    }
  }

  _reportProgress(pct) {
    if (this.onProgress) {
      this.onProgress(`${pct.toFixed(1)}%`);
    }
  }
}

// ---------------------------------------------------------------------------
// Resume error types
// ---------------------------------------------------------------------------

export class ResumeCheckFailed extends Error {
  constructor(message) {
    super(`resume check failed: ${message}`);
    this.name = "ResumeCheckFailed";
  }
}

export class FetchFailed extends Error {
  constructor(message) {
    super(`fetch failed: ${message}`);
    this.name = "FetchFailed";
  }
}

export class IntegrityError extends Error {
  constructor(message) {
    super(`integrity error: ${message}`);
    this.name = "IntegrityError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Base64-encoded MD5 of a local file, or "" if missing. */
export function computeMD5(filePath) {
  if (!existsSync(filePath)) return "";
  const hash = createHash("md5");
  hash.update(readFileSync(filePath));
  return hash.digest("base64");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// Compare resolved filesystem paths, not a URL pathname against argv. A URL
// pathname is percent-encoded and POSIX-shaped, so it never equals argv[1] on
// Windows, on a path holding a space, or when the script is run via a symlink —
// and this file's only side effect lives behind this guard, so a mismatch makes
// the CLI exit 0 having done nothing. realpathSync resolves the symlink case;
// argv[1] is absent under `node -e` and the REPL.
const isEntryPoint =
  Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const url = process.argv[2];
  if (!url) {
    console.error(
      "usage: node scripts/fetch-model.mjs <gguf-url> [outfile.gguf]\n" +
        "  find a URL on HuggingFace (the QVAC registry entry's `src`), e.g. a *.gguf resolve link.",
    );
    process.exit(1);
  }

  mkdirSync("models", { recursive: true });
  const out = join("models", process.argv[3] || basename(new URL(url).pathname) || "model.gguf");

  console.log(`downloading\n  ${url}\n-> ${out}`);

  const dl = new GGUFDownloader(out);
  try {
    await dl.download(
      (method, _body, init) => fetch(url, { ...init, method, redirect: "follow" }),
    );
    console.log(`\ndone. Add to .env:\n\n  QVAC_MODEL_PATH=${join(process.cwd(), out)}\n`);
  } catch (e) {
    console.error(`\nfailed: ${e.message}`);
    process.exit(1);
  }
}
