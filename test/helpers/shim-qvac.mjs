/**
 * Test double for `@qvac/sdk`, injected into a REAL CLI subprocess via the
 * loader hook in shim-hooks.mjs (installed by shim-register.mjs, loaded with
 * `node --import <shim-register> dist/cli.mjs`).
 *
 * Only the model is faked — wallet init (dry-run), policy, history, the native
 * tool loop, confirm prompts and `process.exit` are all production code, so a
 * scripted run through this shim verifies the actual CLI exit path with no live
 * model, no GPU and no funded wallet.
 *
 * One scenario per process, selected via NAD_SHIM_SCENARIO (read lazily at each
 * completion call so the turn counter drives multi-turn cases):
 *   ok           — one get_address tool call, then a text-only turn (exit 0)
 *   refusal      — get_nfts with a bad address (dispatch returns Refused),
 *                  then a text-only turn (exit 1 — the refusal must stick)
 *   sdk-error    — a toolError event with a fixed message (exit 1)
 *   turn-exhaust — a get_address tool call on EVERY turn (exit 1 via turn limit)
 */

let calls = 0;

function eventsFor(scenario) {
  calls++;
  switch (scenario) {
    case "sdk-error":
      return [
        {
          type: "toolError",
          seq: 0,
          error: { code: "VALIDATION_ERROR", message: "shim SDK says no: bad tool arguments" },
        },
      ];
    case "turn-exhaust":
      return [
        {
          type: "toolCall",
          seq: 0,
          call: { id: `shim_${calls}`, name: "get_address", arguments: {} },
        },
      ];
    case "refusal":
      if (calls === 1) {
        return [
          {
            type: "toolCall",
            seq: 0,
            call: { id: "shim_r1", name: "get_nfts", arguments: { address: "not-an-address" } },
          },
        ];
      }
      return [{ type: "contentDelta", seq: 0, text: "Noted." }];
    case "ok":
    default:
      if (calls === 1) {
        return [
          {
            type: "toolCall",
            seq: 0,
            call: { id: "shim_ok", name: "get_address", arguments: {} },
          },
        ];
      }
      return [{ type: "contentDelta", seq: 0, text: "Done." }];
  }
}

export async function loadModel(_params, _opts) {
  return "shim-model-id";
}

export async function unloadModel(_params) {
  return null;
}

export function completion(_params, _opts) {
  const scenario = process.env.NAD_SHIM_SCENARIO || "ok";
  const events = eventsFor(scenario);
  return {
    events: (async function* () {
      for (const e of events) yield e;
    })(),
  };
}
