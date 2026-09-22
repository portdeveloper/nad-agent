/**
 * Loader hooks for CLI subprocess tests: redirect the bare `@qvac/sdk`
 * specifier to the test double in shim-qvac.mjs. Everything else resolves
 * normally. (The esbuild bundle keeps `@qvac/sdk` external, so the specifier
 * reaches this hook untouched.)
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@qvac/sdk") {
    return {
      url: new URL("./shim-qvac.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier);
}
