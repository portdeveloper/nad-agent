/**
 * Minimal GGUF metadata reader: just enough to pull `tokenizer.chat_template`
 * out of a local .gguf WITHOUT loading the model. Whether that template can
 * render tool declarations is the ground truth for picking QVAC's native
 * tool-calling path (completion({ tools })) over the v0 JSON protocol —
 * SmolLM2's template has no `tools` variable, Qwen3's does, and no name
 * heuristic knows that as reliably as the file itself.
 *
 * GGUF layout (v2/v3): magic "GGUF", u32 version, u64 tensor count, u64 kv
 * count, then packed key/value pairs. Metadata (incl. the tokenizer vocab)
 * sits at the head of the file, so a bounded read is enough; we walk the
 * pairs and stop at the template key. Any surprise (v1 counts, truncated
 * head, unknown value type) returns null and the caller falls back safely.
 */

import { openSync, readSync, closeSync } from "node:fs";

const STRING = 8;
const ARRAY = 9;
const SCALAR_BYTES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
// Large models keep multi-MB vocab/merges arrays ahead of the template; 32 MB
// of head covers every model QVAC ships while staying a trivial read.
const HEAD_BYTES = 32 * 1024 * 1024;

/** Returns the model's chat template string, or null if it can't be read. */
export function readGgufChatTemplate(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    let filled = 0;
    for (;;) {
      const n = readSync(fd, buf, filled, HEAD_BYTES - filled, filled);
      if (n === 0 || (filled += n) >= HEAD_BYTES) break;
    }
    return parseChatTemplate(buf.subarray(0, filled));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseChatTemplate(buf) {
  if (buf.length < 24 || buf.readUInt32LE(0) !== 0x46554747) return null; // "GGUF"
  if (buf.readUInt32LE(4) < 2) return null; // v1 used 32-bit counts; modern models are v2+
  const kvCount = Number(buf.readBigUInt64LE(16));
  let off = 24;

  const need = (n) => {
    if (off + n > buf.length) throw new RangeError("gguf head truncated");
  };
  const u32 = () => {
    need(4);
    const v = buf.readUInt32LE(off);
    off += 4;
    return v;
  };
  const u64 = () => {
    need(8);
    const v = Number(buf.readBigUInt64LE(off));
    off += 8;
    return v;
  };
  const str = () => {
    const n = u64();
    need(n);
    const s = buf.toString("utf8", off, off + n);
    off += n;
    return s;
  };
  const skip = (n) => {
    need(n);
    off += n;
  };
  const skipValue = (type) => {
    if (type === STRING) return skip(u64());
    if (type === ARRAY) {
      const elem = u32();
      const count = u64();
      if (elem === ARRAY) throw new RangeError("nested gguf array");
      if (elem === STRING) {
        for (let i = 0; i < count; i++) skip(u64());
        return;
      }
      const size = SCALAR_BYTES[elem];
      if (!size) throw new RangeError(`unknown gguf type ${elem}`);
      return skip(count * size);
    }
    const size = SCALAR_BYTES[type];
    if (!size) throw new RangeError(`unknown gguf type ${type}`);
    skip(size);
  };

  try {
    for (let i = 0; i < kvCount; i++) {
      const key = str();
      const type = u32();
      if (key === "tokenizer.chat_template") return type === STRING ? str() : null;
      skipValue(type);
    }
  } catch {
    return null;
  }
  return null;
}
