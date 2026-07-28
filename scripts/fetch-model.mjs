/**
 * Download a GGUF model over plain HTTPS into ./models/ and print the
 * QVAC_MODEL_PATH line to add to .env.
 *
 * Why: QVAC's P2P model registry has a hard 60s download timeout that a slow or
 * NAT'd host can't beat for a multi-hundred-MB model. The registry `src` is just
 * a HuggingFace URL, so we fetch it directly and load from disk with
 * modelType:"llamacpp-completion". On a fast network / M4 Max the registry path
 * works fine and you don't need this.
 *
 * The download is resumable and verified (#19):
 *   - bytes stream into <outfile>.gguf.part and the file is renamed to its
 *     final name only after verification, so a .gguf on disk is always complete
 *   - an interrupted run resumes with an HTTP Range request from where the
 *     .part left off; if the server ignores the range (200 instead of 206) or
 *     the remote file changed size or checksum since the first attempt, the
 *     partial is discarded and the download restarts clean
 *   - the finished size is always checked against the remote size, and the
 *     sha256 is checked whenever a checksum is available: pass one with
 *     --sha256=<hex>, or it is picked up from the source automatically
 *     (HuggingFace publishes the sha256 of LFS files in an ETag header on the
 *     redirect; a <url>.sha256 sidecar file also works). With no checksum
 *     available, only the size is verified.
 *   - re-running against a verified complete file is a no-op
 *
 * Usage:
 *   node scripts/fetch-model.mjs <gguf-url> [outfile.gguf] [--sha256=<hex>]
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, join } from "node:path";

const HEX64 = /^[0-9a-f]{64}$/i;
const mb = (n) => (n / 1048576).toFixed(1);

function fail(reason) {
  console.error(`\nerror: ${reason}`);
  process.exit(1);
}

// --- args -------------------------------------------------------------------

let userSha = null;
const positional = [];
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--sha256=")) {
    userSha = arg.slice("--sha256=".length).toLowerCase();
    if (!HEX64.test(userSha)) fail(`--sha256 must be 64 hex characters, got "${userSha}"`);
  } else {
    positional.push(arg);
  }
}

const url = positional[0];
if (!url) {
  console.error(
    "usage: node scripts/fetch-model.mjs <gguf-url> [outfile.gguf] [--sha256=<hex>]\n" +
      "  find a URL on HuggingFace (the QVAC registry entry's `src`), e.g. a *.gguf resolve link."
  );
  process.exit(1);
}

mkdirSync("models", { recursive: true });
const out = join("models", positional[1] || basename(new URL(url).pathname) || "model.gguf");
const part = `${out}.part`;
const meta = `${part}.json`;

// --- helpers ----------------------------------------------------------------

/**
 * Follow redirects by hand so headers from every hop are visible. HuggingFace
 * puts the file's sha256 in `x-linked-etag` on the redirecting response, which
 * fetch(redirect:"follow") would hide. Only that header is trusted for the
 * checksum: a generic ETag that happens to be 64 hex chars (e.g. the HF CDN's
 * internal xet hash) is NOT the file's sha256 and would fail a good download.
 * Returns the remote size and the published sha256 when one was found.
 */
async function probe(startUrl) {
  let current = startUrl;
  let sha256 = null;
  for (let hop = 0; hop < 10; hop++) {
    let res = await fetch(current, { method: "HEAD", redirect: "manual" });
    if (res.status === 405 || res.status === 403) {
      // some hosts reject HEAD; ask for a single byte instead
      res = await fetch(current, { headers: { Range: "bytes=0-0" }, redirect: "manual" });
      await res.body?.cancel();
    }
    const tag = (res.headers.get("x-linked-etag") || "")
      .replace(/^W\//, "")
      .replaceAll('"', "")
      .toLowerCase();
    if (!sha256 && HEX64.test(tag)) sha256 = tag;
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    if (!res.ok && res.status !== 206) {
      fail(`cannot reach the model URL: ${res.status} ${res.statusText} (${current})`);
    }
    let total = 0;
    if (res.status === 206) {
      const m = /\/(\d+)\s*$/.exec(res.headers.get("content-range") || "");
      if (m) total = Number(m[1]);
    } else {
      total = Number(res.headers.get("content-length") || 0);
    }
    return { total, sha256 };
  }
  fail("too many redirects");
}

/** Some mirrors publish the checksum as a `<file>.sha256` sidecar next to the file. */
async function sidecarSha(fileUrl) {
  try {
    const res = await fetch(`${fileUrl}.sha256`, { redirect: "follow" });
    if (!res.ok) return null;
    const first = (await res.text()).trim().split(/\s+/)[0].toLowerCase();
    return HEX64.test(first) ? first : null;
  } catch {
    return null;
  }
}

async function hashFile(path, hash) {
  for await (const chunk of createReadStream(path)) hash.update(chunk);
}

function printEnvLine() {
  console.log(`\ndone. Add to .env:\n\n  QVAC_MODEL_PATH=${join(process.cwd(), out)}\n`);
}

// --- what does the remote look like? ----------------------------------------

const remote = await probe(url);
const expectedSha = userSha || remote.sha256 || (await sidecarSha(url));
const shaSource = userSha
  ? "--sha256 flag"
  : remote.sha256
    ? "source ETag"
    : expectedSha
      ? ".sha256 sidecar"
      : null;

// --- already downloaded? verify and no-op -----------------------------------

if (existsSync(out)) {
  const size = statSync(out).size;
  if (remote.total && size !== remote.total) {
    fail(
      `${out} already exists but is ${size} bytes and the remote is ${remote.total}. ` +
        `Delete it to re-download.`
    );
  }
  if (expectedSha) {
    console.log(`verifying existing ${out} ...`);
    const hash = createHash("sha256");
    await hashFile(out, hash);
    const got = hash.digest("hex");
    if (got !== expectedSha) {
      fail(
        `${out} already exists but its sha256 does not match (checked against ${shaSource}).\n` +
          `  expected ${expectedSha}\n  got      ${got}\nDelete it to re-download.`
      );
    }
  }
  console.log(
    `${out} is already complete and verified ` +
      `(${mb(size)} MB${expectedSha ? ", sha256 ok" : ""}). Nothing to do.`
  );
  printEnvLine();
  process.exit(0);
}

// --- resumable? -------------------------------------------------------------

// The .part.json sidecar remembers what the partial was downloaded from, so a
// resume can tell whether the remote file changed underneath it.
let offset = 0;
if (existsSync(part)) {
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(meta, "utf8"));
  } catch {}
  const partSize = statSync(part).size;
  const stale =
    !prev ||
    prev.url !== url ||
    (remote.total && prev.total !== remote.total) ||
    (remote.total && partSize > remote.total) ||
    (prev.sha256 && expectedSha && prev.sha256 !== expectedSha);
  if (stale) {
    console.log("found a partial download that no longer matches the remote file. Starting over.");
    unlinkSync(part);
  } else {
    offset = partSize;
  }
}
writeFileSync(meta, JSON.stringify({ url, total: remote.total || null, sha256: expectedSha }));

// --- download ----------------------------------------------------------------

console.log(`downloading\n  ${url}\n-> ${out}`);

// The hash covers the whole file: previously downloaded bytes are replayed
// through it from disk before new bytes are appended.
const hash = createHash("sha256");
let received = offset;

if (remote.total && offset === remote.total) {
  // the previous run got every byte but was killed before verify/rename
  console.log(`  the partial download is already complete (${mb(offset)} MB). Verifying.`);
  await hashFile(part, hash);
} else {
  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
  let res;
  try {
    res = await fetch(url, { redirect: "follow", headers });
  } catch (err) {
    fail(`fetch failed: ${err.cause?.message || err.message}`);
  }

  if (offset > 0 && res.status === 200) {
    // server ignored the Range request, so the partial can't be reused
    console.log("  server does not support resume (200 instead of 206). Starting over.");
    offset = 0;
    received = 0;
  } else if (offset > 0 && res.status === 206) {
    const m = /^bytes (\d+)-\d+\/(\d+)\s*$/.exec(res.headers.get("content-range") || "");
    if (!m || Number(m[1]) !== offset) {
      fail(`server returned an unexpected Content-Range: "${res.headers.get("content-range")}"`);
    }
    console.log(`  resuming at ${mb(offset)} MB (${offset} bytes, HTTP 206)`);
  } else if (!res.ok) {
    fail(`fetch failed: ${res.status} ${res.statusText}`);
  }

  const total =
    remote.total || offset + Number(res.headers.get("content-length") || 0) || 0;

  if (offset > 0) await hashFile(part, hash);

  const started = Date.now();
  let lastPrint = 0;
  const body = Readable.fromWeb(res.body);
  body.on("data", (chunk) => {
    hash.update(chunk);
    received += chunk.length;
    const now = Date.now();
    if (now - lastPrint < 1000) return; // at most one progress update per second
    lastPrint = now;
    const rate = mb((received - offset) / ((now - started || 1) / 1000));
    const line = total
      ? `  ${((received / total) * 100).toFixed(1)}%  ${mb(received)} / ${mb(total)} MB  ${rate} MB/s`
      : `  ${mb(received)} MB  ${rate} MB/s`;
    if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
    else console.log(line);
  });
  try {
    await pipeline(body, createWriteStream(part, { flags: offset > 0 ? "a" : "w" }));
  } catch (err) {
    fail(`download interrupted: ${err.cause?.message || err.message}. Re-run to resume.`);
  }
  if (process.stdout.isTTY) process.stdout.write("\n");
}

// --- verify, then make it real ------------------------------------------------

const size = statSync(part).size;
if (remote.total && size !== remote.total) {
  fail(
    `incomplete: got ${size} of ${remote.total} bytes. ` +
      `The connection closed early; re-run to resume.`
  );
}
if (expectedSha) {
  const got = hash.digest("hex");
  if (got !== expectedSha) {
    unlinkSync(part);
    try {
      unlinkSync(meta);
    } catch {}
    fail(
      `sha256 mismatch (checked against ${shaSource}).\n` +
        `  expected ${expectedSha}\n  got      ${got}\n` +
        `The corrupt partial was removed; re-run to download fresh.`
    );
  }
}

renameSync(part, out);
try {
  unlinkSync(meta);
} catch {}

console.log(
  expectedSha
    ? `verified: ${size} bytes, sha256 ok (${shaSource})`
    : `verified: ${size} bytes. The source publishes no checksum; ` +
        `pass --sha256=<hex> to also check content integrity.`
);
printEnvLine();
