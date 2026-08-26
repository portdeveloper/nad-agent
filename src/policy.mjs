/**
 * Declarative spend policy: hard limits the wallet enforces on its own, so the
 * human is not the only guardrail.
 *
 * The confirm flow asks a person to approve each send; a policy bounds what an
 * agent can do at all. Both run before the prompt: a violation is refused the
 * same way a bad checksum is, with the violated rule named.
 *
 * The file is optional. No file means no policy and byte-identical behavior to
 * before, so nothing changes for anyone who does not opt in.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMon, formatMon, toChecksumAddress } from "./format.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = resolve(HERE, "..", "policy.json");

/**
 * Load and validate `policy.json` (override with NAD_POLICY). Returns null when
 * no file exists. Throws on a malformed policy: a policy that cannot be parsed
 * must stop the agent, never silently permit everything.
 */
export function loadPolicy(path = process.env.NAD_POLICY || DEFAULT_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`policy file ${path} could not be read: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`policy file ${path} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`policy file ${path} must contain a JSON object`);
  }

  const KNOWN_KEYS = new Set(["maxPerSend", "maxPerSession", "allowlist"]);
  const unknown = Object.keys(parsed).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length) {
    throw new Error(`policy file ${path} contains unknown key${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  }

  const policy = { path, maxPerSend: null, maxPerSession: null, allowlist: null };

  for (const key of ["maxPerSend", "maxPerSession"]) {
    if (parsed[key] == null) continue;
    let wei;
    try {
      wei = parseMon(parsed[key]);
    } catch {
      throw new Error(`policy ${key} is not an amount in MON: ${parsed[key]}`);
    }
    if (wei <= 0n) throw new Error(`policy ${key} must be greater than zero`);
    policy[key] = wei;
  }

  if (parsed.allowlist != null) {
    if (!Array.isArray(parsed.allowlist)) {
      throw new Error("policy allowlist must be an array of addresses");
    }
    // Validated at load, not at send time: a typo in the allowlist would
    // otherwise silently refuse a legitimate recipient much later.
    policy.allowlist = parsed.allowlist.map((entry) => {
      try {
        return toChecksumAddress(entry);
      } catch {
        throw new Error(`policy allowlist entry is not a valid address: ${entry}`);
      }
    });
  }

  return policy;
}

/** True when the policy has at least one rule to enforce. */
export function hasRules(policy) {
  return !!policy && (policy.maxPerSend != null || policy.maxPerSession != null || policy.allowlist != null);
}

/**
 * Check one send against the policy. Returns { ok } or { ok: false, rule,
 * message } naming the rule that refused it. `sessionSpent` is the running
 * total for this process.
 *
 * `value` is the amount in wei for a native send, or null for a token send:
 * the allowlist governs the recipient of every write, while the MON amount
 * limits only bind sends actually denominated in MON.
 */
/** MON amount limits shared by sends and native-in swaps. No recipient. */
function checkAmountLimits(policy, { value, sessionSpent = 0n }) {
  const symbol = "MON";
  if (policy.maxPerSend != null && value > policy.maxPerSend) {
    return {
      ok: false,
      rule: "maxPerSend",
      message: `amount ${formatMon(value)} ${symbol} is above the policy limit of ${formatMon(policy.maxPerSend)} ${symbol} per send.`,
    };
  }
  if (policy.maxPerSession != null && sessionSpent + value > policy.maxPerSession) {
    const left = policy.maxPerSession - sessionSpent;
    return {
      ok: false,
      rule: "maxPerSession",
      message: `this send would exceed the policy session budget of ${formatMon(policy.maxPerSession)} ${symbol} (${formatMon(left > 0n ? left : 0n)} ${symbol} left).`,
    };
  }
  return { ok: true };
}

export function checkPolicy(policy, { to, value, sessionSpent = 0n }) {
  if (!hasRules(policy)) return { ok: true };

  const lower = to.toLowerCase();
  if (policy.allowlist && !policy.allowlist.some((a) => a.toLowerCase() === lower)) {
    return {
      ok: false,
      rule: "allowlist",
      message: `${to} is not in the policy allowlist (${policy.allowlist.length} address${policy.allowlist.length === 1 ? "" : "es"} allowed).`,
    };
  }

  if (value == null) return { ok: true };
  return checkAmountLimits(policy, { value, sessionSpent });
}

/**
 * Spend policy for swaps. Swaps have no third-party recipient, so the allowlist
 * does not apply (output always returns to the agent's own Safe). MON amount
 * limits apply when the input is native MON. If those limits are configured and
 * the input is not MON, refuse rather than silently skipping a rule we cannot
 * evaluate.
 */
export function checkSwapPolicy(policy, { nativeIn, value, sessionSpent = 0n }) {
  if (!hasRules(policy)) return { ok: true };
  const amountRules = policy.maxPerSend != null || policy.maxPerSession != null;
  if (!amountRules) return { ok: true };

  if (!nativeIn) {
    const rule = policy.maxPerSend != null ? "maxPerSend" : "maxPerSession";
    return {
      ok: false,
      rule,
      message: "swap input is not MON, so the policy MON limits cannot be evaluated.",
    };
  }

  if (value == null) {
    return { ok: false, rule: "maxPerSend", message: "native swap amount is missing." };
  }

  return checkAmountLimits(policy, { value, sessionSpent });
}

/** One-line summary of swap policy (amount rules only; no recipient allowlist). */
export function describeSwapPolicy(policy, { nativeIn, value, sessionSpent = 0n }) {
  if (!hasRules(policy)) return null;
  if (!nativeIn) return null;
  if (policy.maxPerSend == null && policy.maxPerSession == null) return null;
  return describePolicy({ ...policy, allowlist: null, path: policy.path }, { value, sessionSpent });
}

/** One-line summary of what applied, shown in the confirmation block. */
export function describePolicy(policy, { value, sessionSpent = 0n }) {
  if (!hasRules(policy)) return null;
  const parts = [];
  // Token sends pass value=null because the MON amount limits do not apply to them.
  if (policy.maxPerSession != null && value != null) {
    parts.push(`${formatMon(sessionSpent + value)} of ${formatMon(policy.maxPerSession)} MON session budget`);
  }
  if (policy.maxPerSend != null && value != null) {
    parts.push(`per-send limit ${formatMon(policy.maxPerSend)} MON`);
  }
  if (policy.allowlist) {
    parts.push("recipient allowlisted");
  }
  return parts.join(" · ");
}
