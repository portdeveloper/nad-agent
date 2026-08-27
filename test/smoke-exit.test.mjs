import { test } from "node:test";
import assert from "node:assert/strict";
import { flushSmokeSuccess } from "../src/smoke-exit.mjs";

test("flushSmokeSuccess waits for stdout before exiting", async () => {
  let written = null;
  let writeCallback = null;
  let exitCode = null;

  const pending = flushSmokeSuccess((chunk, callback) => {
    written = chunk;
    writeCallback = callback;
  }, (code) => {
    exitCode = code;
  });

  assert.equal(written, "\nSMOKE_OK\n");
  assert.equal(exitCode, null);
  writeCallback();
  await pending;
  assert.equal(exitCode, 0);
});

test("flushSmokeSuccess propagates stdout errors", async () => {
  const error = new Error("stdout failed");
  const pending = flushSmokeSuccess((_chunk, callback) => callback(error), () => {
    throw new Error("must not exit after a write error");
  });

  await assert.rejects(pending, error);
});
