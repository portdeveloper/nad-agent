/**
 * `--import` entry for CLI subprocess tests: installs the `@qvac/sdk`
 * redirect (shim-hooks.mjs) before the CLI bundle loads. Usage:
 *   node --import <abs path to shim-register.mjs> dist/cli.mjs
 */
import { register } from "node:module";

register("./shim-hooks.mjs", import.meta.url);
