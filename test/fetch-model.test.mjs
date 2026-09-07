/**
 * Unit tests for scripts/fetch-model.mjs.
 *
 * Uses node:test + node:assert (built into Node 22). Zero new dependencies.
 * Mocks fetch via injected factories — no network. Files go to the OS temp dir.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  GGUFDownloader,
  ResumeCheckFailed,
  FetchFailed,
  IntegrityError,
  computeMD5,
} from "../scripts/fetch-model.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BODY = Buffer.from("GGUF model data here", "utf8");

function fakeResponse({ status = 200, contentLength = BODY.length, contentMD5 = null, extraHeaders = {}, body = BODY } = {}) {
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": String(contentLength),
    ...extraHeaders,
  });
  if (contentMD5) headers.set("Content-MD5", contentMD5);
  return new Response(body, { status, headers });
}

function streamFromBuffer(buf) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

let _id = 0;
function path(prefix) {
  return join(tmpdir(), `nad-${prefix}-${++_id}.gguf`);
}

function cleanup(file) {
  try { rmSync(file, { force: true }); } catch {}
}

function md5Of(buf) {
  const h = createHash("md5");
  h.update(buf);
  return h.digest("base64");
}

// ---------------------------------------------------------------------------
// GGUFDownloader — fresh download
// ---------------------------------------------------------------------------

describe("GGUFDownloader — fresh download", () => {
  it("writes file when no partial exists", async () => {
    const file = path("fresh");
    cleanup(file);

    const dl = new GGUFDownloader(file, { progress: false });
    await dl.download(() => fakeResponse({}));

    assert.ok(existsSync(file), "file should exist");
    assert.equal(statSync(file).size, BODY.length, "file size should match body");
    assert.deepEqual(Buffer.from(readFileSync(file)), BODY, "content should match");
    cleanup(file);
  });

  it("reports 100% via onProgress callback", async () => {
    const file = path("progress");
    cleanup(file);

    const outputs = [];
    const dl = new GGUFDownloader(file, {
      progress: true,
      onProgress: (pct) => outputs.push(pct),
    });
    await dl.download(() => fakeResponse({ contentLength: BODY.length }));

    assert.ok(
      outputs.includes("100.0%"),
      `expected 100.0% in outputs, got: ${JSON.stringify(outputs)}`,
    );
    cleanup(file);
  });

  it("succeeds when server omits Content-Length", async () => {
    const file = path("no-cl");
    cleanup(file);

    const dl = new GGUFDownloader(file, { progress: false });
    await dl.download(() => fakeResponse({ contentLength: 0 }));

    assert.ok(existsSync(file), "file should exist");
    assert.deepEqual(Buffer.from(readFileSync(file)), BODY, "content should match");
    cleanup(file);
  });
});

// ---------------------------------------------------------------------------
// GGUFDownloader — resume with server support (206 + Content-Range)
// ---------------------------------------------------------------------------

describe("GGUFDownloader — resume with server support", () => {
  it("resumes from partial when server returns 206", async () => {
    const file = path("resume");
    cleanup(file);

    const prefixLen = 15;
    const prefix = BODY.subarray(0, prefixLen);
    const remaining = BODY.subarray(prefixLen);
    writeFileSync(file, prefix, "binary");

    const dl = new GGUFDownloader(file, { progress: false });
    const res = fakeResponse({
      status: 206,
      contentLength: remaining.length,
      body: remaining,
      extraHeaders: { "Content-Range": `bytes ${prefixLen}-${BODY.length - 1}/${BODY.length}` },
    });

    await dl.download(() => res);

    const full = readFileSync(file);
    assert.equal(full.length, BODY.length, "full file should be complete");
    assert.ok(full.subarray(0, prefixLen).equals(prefix), "existing bytes should be preserved");
    assert.ok(full.subarray(prefixLen).equals(remaining), "new bytes should match");
    cleanup(file);
  });

  it("fails resume check when partial size doesn't match Range offset", async () => {
    const file = path("resume-mismatch");
    cleanup(file);
    writeFileSync(file, Buffer.from("short"), "binary"); // 5 bytes, server says offset 100

    const dl = new GGUFDownloader(file, { progress: false });
    const res = fakeResponse({
      status: 206,
      contentLength: BODY.length,
      body: BODY,
      extraHeaders: { "Content-Range": `bytes 100-${BODY.length + 99}/${BODY.length + 100}` },
    });

    let threw = false;
    try {
      await dl.download(() => res);
    } catch (e) {
      threw = true;
      assert.ok(e instanceof ResumeCheckFailed, `expected ResumeCheckFailed, got ${e.name}`);
      assert.ok(String(e.message).toLowerCase().includes("partial size"), `error should mention partial size: ${e.message}`);
    }
    assert.ok(threw, "should throw ResumeCheckFailed");
    cleanup(file);
  });

  it("re-downloads fresh when server returns 200 to a Range request", async () => {
    const file = path("no-resume");
    cleanup(file);
    writeFileSync(file, Buffer.from("old partial data"), "binary");

    const dl = new GGUFDownloader(file, { progress: false });
    const res = fakeResponse({ status: 200, contentLength: BODY.length, body: BODY });

    await dl.download(() => res);
    assert.deepEqual(readFileSync(file), BODY, "file should contain fresh download, not old partial");
    cleanup(file);
  });

  it("throws on 416 Range Not Satisfiable", async () => {
    const file = path("r416");
    cleanup(file);
    writeFileSync(file, Buffer.alloc(100), "binary");

    const dl = new GGUFDownloader(file, { progress: false });
    const res = fakeResponse({ status: 416 });

    let threw = false;
    try {
      await dl.download(() => res);
    } catch (e) {
      threw = true;
      assert.ok(e instanceof ResumeCheckFailed, `expected ResumeCheckFailed, got ${e.name}`);
    }
    assert.ok(threw, "should throw on 416");
    cleanup(file);
  });

  it("skips verifyFile when Content-Range has unknown total (*)", async () => {
    // Content-Range: bytes 0-19/* means the server doesn't know the total
    const file = path("unknown-total");
    cleanup(file);

    const dl = new GGUFDownloader(file, { progress: false });
    const res = fakeResponse({
      status: 206,
      contentLength: BODY.length,
      body: BODY,
      extraHeaders: { "Content-Range": `bytes 0-${BODY.length - 1}/*` },
    });

    await dl.download(() => res);
    assert.equal(readFileSync(file).length, BODY.length, "file should be complete");
    cleanup(file);
  });
});

// ---------------------------------------------------------------------------
// GGUFDownloader — fallback to fresh download when server doesn't support Range
// ---------------------------------------------------------------------------

describe("GGUFDownloader — fallback to fresh download", () => {
  it("discards partial and re-downloads when server returns 200", async () => {
    const file = path("fresh-fallback");
    cleanup(file);
    writeFileSync(file, Buffer.from("old data"), "binary");

    const dl = new GGUFDownloader(file, { progress: false });
    const newBody = Buffer.from("completely new content");
    const res = new Response(newBody, {
      status: 200,
      headers: new Headers({ "Content-Type": "application/octet-stream", "Content-Length": String(newBody.length) }),
    });

    await dl.download(() => res);

    assert.deepEqual(readFileSync(file), newBody, "file should contain new body, not old partial");
    cleanup(file);
  });
});

// ---------------------------------------------------------------------------
// GGUFDownloader — Content-MD5 verification
// ---------------------------------------------------------------------------

describe("GGUFDownloader — Content-MD5", () => {
  it("passes MD5 when Content-MD5 header matches", async () => {
    const file = path("md5-pass");
    cleanup(file);

    const dl = new GGUFDownloader(file, { progress: false });
    const checksum = md5Of(BODY);
    const res = fakeResponse({
      contentLength: BODY.length,
      contentMD5: checksum,
    });

    await dl.download(() => res);
    cleanup(file);
  });

  it("throws IntegrityError on MD5 mismatch via Content-MD5 header", async () => {
    const file = path("md5-fail");
    cleanup(file);

    const dl = new GGUFDownloader(file, { progress: false });
    const res = fakeResponse({
      contentLength: BODY.length,
      contentMD5: "AAAAAAAAAAAAAAAAAAAAAA==",
    });

    let threw = false;
    try {
      await dl.download(() => res);
    } catch (e) {
      threw = true;
      assert.ok(e instanceof IntegrityError, `expected IntegrityError, got ${e.name}`);
      assert.ok(String(e.message).toLowerCase().includes("md5"), `should mention md5: ${e.message}`);
    }
    assert.ok(threw, "should throw IntegrityError");
    cleanup(file);
  });

  it("skips MD5 when Content-MD5 header is absent", async () => {
    const file = path("md5-absent");
    cleanup(file);

    const dl = new GGUFDownloader(file, { progress: false });
    await dl.download(() => fakeResponse({ contentLength: BODY.length }));

    assert.ok(existsSync(file), "file should exist");
    cleanup(file);
  });
});

// ---------------------------------------------------------------------------
// GGUFDownloader — verifyFile
// ---------------------------------------------------------------------------

describe("GGUFDownloader — verifyFile", () => {
  it("passes when Content-Length matches actual file size", async () => {
    const file = path("verify-cl");
    cleanup(file);
    writeFileSync(file, BODY, "binary");

    const dl = new GGUFDownloader(file, { progress: false });
    await dl.verifyFile({ contentLength: String(BODY.length) });
    cleanup(file);
  });

  it("throws IntegrityError on Content-Length mismatch", async () => {
    const file = path("verify-cl-bad");
    cleanup(file);
    writeFileSync(file, Buffer.alloc(100), "binary");

    const dl = new GGUFDownloader(file, { progress: false });
    let threw = false;
    try {
      await dl.verifyFile({ contentLength: "200" });
    } catch (e) {
      threw = true;
      assert.ok(e instanceof IntegrityError, `expected IntegrityError, got ${e.name}`);
      assert.ok(String(e.message).toLowerCase().includes("content-length"), `should mention Content-Length: ${e.message}`);
      assert.ok(e.message.includes("100"), `should mention actual size: ${e.message}`);
      assert.ok(e.message.includes("200"), `should mention declared size: ${e.message}`);
    }
    assert.ok(threw, "should throw IntegrityError");
    cleanup(file);
  });

  it("passes MD5 with correct checksum", async () => {
    const file = path("verify-md5");
    cleanup(file);
    writeFileSync(file, BODY, "binary");

    const dl = new GGUFDownloader(file, { progress: false });
    await dl.verifyFile({ checksum: md5Of(BODY) });
    cleanup(file);
  });

  it("throws IntegrityError on MD5 mismatch", async () => {
    const file = path("verify-md5-bad");
    cleanup(file);
    writeFileSync(file, BODY, "binary");

    const dl = new GGUFDownloader(file, { progress: false });
    let threw = false;
    try {
      await dl.verifyFile({ checksum: "AAAAAAAAAAAAAAAAAAAAAA==" });
    } catch (e) {
      threw = true;
      assert.ok(e instanceof IntegrityError, `expected IntegrityError, got ${e.name}`);
      assert.ok(String(e.message).toLowerCase().includes("md5"), `should mention md5: ${e.message}`);
    }
    assert.ok(threw, "should throw IntegrityError");
    cleanup(file);
  });

  it("verifies both Content-Length and checksum together", async () => {
    const file = path("verify-both");
    cleanup(file);
    writeFileSync(file, BODY, "binary");

    const dl = new GGUFDownloader(file, { progress: false });
    await dl.verifyFile({ contentLength: String(BODY.length), checksum: md5Of(BODY) });
    cleanup(file);
  });

  it("skips verification when neither check is configured", async () => {
    const file = path("verify-none");
    cleanup(file);
    writeFileSync(file, Buffer.alloc(50), "binary");

    const dl = new GGUFDownloader(file, { progress: false });
    await dl.verifyFile({});
    cleanup(file);
  });
});

// ---------------------------------------------------------------------------
// computeMD5
// ---------------------------------------------------------------------------

describe("computeMD5", () => {
  it("returns base64-encoded MD5 of file contents", async () => {
    const file = path("md5");
    cleanup(file);
    writeFileSync(file, BODY, "binary");

    assert.equal(computeMD5(file), md5Of(BODY), "MD5 should match");
    cleanup(file);
  });

  it("returns empty string for missing file", async () => {
    assert.equal(computeMD5(join(tmpdir(), "nonexistent-file-12345.gguf")), "");
  });
});

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

describe("Error types", () => {
  it("ResumeCheckFailed has correct name and message", () => {
    const e = new ResumeCheckFailed("partial corrupted");
    assert.equal(e.name, "ResumeCheckFailed");
    assert.ok(e.message.includes("resume check failed"));
    assert.ok(e.message.includes("partial corrupted"));
  });

  it("FetchFailed has correct name and message", () => {
    const e = new FetchFailed("500 Internal Server Error");
    assert.equal(e.name, "FetchFailed");
    assert.ok(e.message.includes("fetch failed"));
  });

  it("IntegrityError has correct name and message", () => {
    const e = new IntegrityError("file truncated");
    assert.equal(e.name, "IntegrityError");
    assert.ok(e.message.includes("integrity error"));
  });

  it("all errors extend Error", () => {
    assert.ok(new ResumeCheckFailed("x") instanceof Error);
    assert.ok(new FetchFailed("x") instanceof Error);
    assert.ok(new IntegrityError("x") instanceof Error);
  });
});
