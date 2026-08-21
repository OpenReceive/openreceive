import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the repository root, resolved from this file's own location
 * so a tool behaves the same however it was launched. Tools that read
 * `process.cwd()` instead are deliberately root-only npm scripts — leave those.
 */
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
