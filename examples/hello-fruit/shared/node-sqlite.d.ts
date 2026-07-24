/**
 * Minimal typings for Node's experimental node:sqlite (DatabaseSync).
 * @types/node in this workspace predates the built-in module.
 */

declare module "node:sqlite" {
  export interface StatementSync {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
