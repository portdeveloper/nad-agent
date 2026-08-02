/**
 * Local address book: resolve a name to an address before a send.
 *
 * Monad has no name service yet, so names come from `address-book.json` next to `.env`:
 *
 *   { "alice": "0x1111111111111111111111111111111111111111" }
 *
 * Override the path with NAD_ADDRESS_BOOK. No file means no aliases, and raw `0x…`
 * addresses behave exactly as before.
 *
 * The recipient of a transfer cannot be taken back, so every ambiguity is a refusal with a
 * reason rather than a best guess: an unknown name, an entry whose address is malformed, and
 * one name spelled two ways with two different addresses are each declined. "Present but
 * rejected" is reported differently from "not in the book" — telling someone their alias is
 * unknown when it is merely malformed sends them looking for a typo that is not there.
 *
 * The ambiguity that gets refused is the one this file creates: names are matched
 * case-insensitively, so `alice` and `Alice` become one alias, and if they disagree there is
 * no honest way to pick. A key repeated verbatim — `{"alice": A, "alice": B}` — is not that
 * case: JSON already defines it as B, and `JSON.parse` settles it before this code runs.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAddress, toChecksumAddress } from "./format.mjs";

const DEFAULT_BOOK = fileURLToPath(new URL("../address-book.json", import.meta.url));
const BOOK_PATH = () => process.env.NAD_ADDRESS_BOOK || DEFAULT_BOOK;

/** ASCII only, and never address-shaped, so names and addresses cannot overlap. */
const VALID_NAME = /^(?!0[xX])[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Untrusted text reaches a terminal. Keep it printable and short. */
export function safeEcho(value, maxLen = 64) {
  let s;
  try {
    s = String(value ?? "");
  } catch {
    return "<unprintable>";
  }
  const clean = s.replace(/[^\x20-\x7E]/g, "�");
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}...` : clean;
}


/**
 * Load and validate the book.
 * Returns { entries, rejected, warnings, unreadable, path }.
 *
 * `unreadable` is a third state, not "no aliases": reporting a permission error as an empty
 * book is a lie about the operator's own file. Read on every call, so an operator who edits
 * the book to redirect a compromised alias does not keep paying the old address.
 */
export function loadAddressBook() {
  const path = BOOK_PATH();
  const warnings = [];
  const entries = new Map();
  const rejected = new Map();
  let unreadable = null;
  // Distinct from `unreadable`: the file is simply not there. Only meaningful when the
  // operator named the path, and kept separate so a send can say so instead of falling back
  // to "No aliases are defined" — the message this file exists to avoid.
  let missing = false;
  const done = () => ({ entries, rejected, warnings, unreadable, missing, path });

  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      // No default book is the normal case: no file, no aliases, nothing to say. A path the
      // operator typed that does not exist is a mistake, and reporting it as "No aliases are
      // defined" sends them hunting a typo in a book that was never opened. A stale
      // NAD_ADDRESS_BOOK, a dangling symlink and an unexpected cwd all land here.
      if (process.env.NAD_ADDRESS_BOOK) {
        missing = true;
        warnings.push(`address book at ${safeEcho(path)} does not exist (NAD_ADDRESS_BOOK points at it)`);
      }
      return done();
    }
    unreadable = err.code || "unreadable";
    // safeEcho on the message too: it embeds the path a second time, unsanitised, and that
    // copy is what reaches the terminal at startup.
    warnings.push(`address book at ${safeEcho(path)} could not be read: ${safeEcho(err.message, 200)}`);
    return done();
  }
  // Windows editors and PowerShell write a UTF-8 BOM by default; without this the whole book
  // is "not valid JSON" and the operator has nothing to act on.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not err.message: JSON.parse quotes the offending input, which would echo the head of
    // whatever file NAD_ADDRESS_BOOK happened to point at.
    unreadable = "not valid JSON";
    warnings.push(`address book at ${safeEcho(path)} is not valid JSON`);
    return done();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    unreadable = "not a JSON object";
    warnings.push(`address book at ${safeEcho(path)} must be a JSON object of name -> address`);
    return done();
  }

  for (const [name, address] of Object.entries(parsed)) {
    const key = name.toLowerCase();
    const reject = (reason) => {
      warnings.push(`alias "${safeEcho(name)}" ignored: ${reason}`);
      entries.delete(key);
      rejected.set(key, reason);
    };

    if (!VALID_NAME.test(name)) {
      reject("not a usable alias name — letters, digits, dot, dash and underscore only, and not starting with 0x");
      continue;
    }
    if (typeof address !== "string" || !isAddress(address)) {
      // Name the shape rather than JSON.stringify it: a deeply nested value blows the stack
      // inside stringify, and that RangeError escapes every caller.
      const shape = Array.isArray(address) ? "an array" : address === null ? "null" : `a ${typeof address}`;
      reject(`value is ${shape}, not a 0x-prefixed 40-hex address`);
      continue;
    }
    // Same checksum rule as a typed address: an alias is written by hand too, and a book entry
    // that fails it would otherwise be the one way a mistyped address still reaches a send.
    try {
      toChecksumAddress(address);
    } catch {
      reject("address fails its EIP-55 checksum — one character is likely mistyped");
      continue;
    }
    if (rejected.has(key)) continue;

    const existing = entries.get(key);
    if (existing && existing.address.toLowerCase() !== address.trim().toLowerCase()) {
      // Two spellings of one name pointing at different addresses: refuse both rather than
      // let parse order pick the recipient.
      reject("defined twice with different addresses");
      continue;
    }
    entries.set(key, { name, address: address.trim() });
  }

  return done();
}

/**
 * Resolve a send target.
 *   { ok: true,  address, name: null }     raw address: surrounding whitespace trimmed,
 *                                          everything else passed through untouched
 *   { ok: true,  address, name: "alice" }  alias hit
 *   { ok: false, reason }                  refusal, with something an operator can act on
 */
export function resolveRecipient(to) {
  if (typeof to !== "string" || to.trim() === "") {
    return { ok: false, reason: "no recipient given" };
  }
  const value = to.trim();

  // A raw address always wins and is never looked up, so no alias can shadow one. The only
  // edit it gets is the trim above — its case in particular is never rewritten, which is what
  // lets the operator approve a string and know that exact string is what gets signed.
  //
  // The EIP-55 checksum is still verified, because a mixed-case address carries one and a
  // single mistyped character invalidates it. Verified, not applied: getAddress() would hand
  // back a re-cased string, and rewriting what was approved is the thing this function exists
  // to avoid. An all-lowercase address carries no checksum and is accepted as before.
  if (isAddress(value)) {
    try {
      toChecksumAddress(value);
    } catch {
      return { ok: false, reason: `"${safeEcho(value)}" is not a valid address (checksum failed)` };
    }
    return { ok: true, address: value, name: null };
  }

  if (/^0x/i.test(value)) {
    return { ok: false, reason: `"${safeEcho(value)}" looks like an address but is not a valid one (expected 0x + 40 hex)` };
  }
  // Hold the lookup to the same rules as storage, so a string that could never be stored as
  // an alias cannot match one either.
  if (!VALID_NAME.test(value)) {
    return { ok: false, reason: `"${safeEcho(value)}" is not a usable recipient: not an address, and not a valid alias name` };
  }

  const { entries, rejected, unreadable, missing, path } = loadAddressBook();
  if (unreadable) {
    return { ok: false, reason: `cannot resolve "${safeEcho(value)}" — the address book at ${safeEcho(path)} could not be read (${unreadable})` };
  }
  if (missing) {
    return { ok: false, reason: `cannot resolve "${safeEcho(value)}" — the address book at ${safeEcho(path)} does not exist (NAD_ADDRESS_BOOK points at it)` };
  }

  const key = value.toLowerCase();
  const why = rejected.get(key);
  if (why) {
    return { ok: false, reason: `alias "${safeEcho(value)}" is present in the address book but was ignored: ${why}` };
  }

  const hit = entries.get(key);
  if (!hit) {
    // Capped: a book of a few thousand entries turns one refusal into tens of kilobytes on
    // a single line, which buries the reason it was printed for.
    const known = [...entries.values()].map((e) => e.name);
    const shown = known.slice(0, 10).join(", ");
    const rest = known.length > 10 ? ` and ${known.length - 10} more` : "";
    const hint = known.length ? ` Known aliases: ${shown}${rest}.` : " No aliases are defined.";
    return { ok: false, reason: `unknown recipient "${safeEcho(value)}" — not an address and not in the address book.${hint}` };
  }
  return { ok: true, address: hit.address, name: hit.name };
}

/**
 * What the operator sees before approving: the full address, always.
 *
 * A truncated form would be worse than useless here — "0x1111…1111" hides 32 of 40 hex
 * characters, so two different addresses can render identically. The confirm prompt is the
 * only human check on a transfer that cannot be undone.
 */
export function formatRecipient({ address, name }) {
  if (!name) return address;
  return `${address}  (alias: ${safeEcho(name)})`;
}

/** Load-time problems, for the caller to show once at startup. */
export function addressBookWarnings() {
  return loadAddressBook().warnings;
}
