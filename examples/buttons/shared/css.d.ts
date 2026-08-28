/**
 * Stylesheet imports, for the type checker.
 *
 * Every stack's entry point imports CSS for its side effect — the shop's own
 * sheet and the checkout package's — and TypeScript needs to be told those
 * specifiers resolve to something. Vite, webpack and Next all handle the
 * loading; this file only stops `tsc --noEmit` from calling them missing
 * modules.
 *
 * It lives in shared/ because the stylesheets do, and because the repo
 * typechecks every stack in ONE program: a declaration in any one of them
 * would silently be doing this job for the other three. The demo it replaced
 * got this transitively, from a `/// <reference types="vite/client" />` in a
 * stack that happened to still exist — which is exactly the kind of dependency
 * that breaks when a directory is deleted.
 */

declare module "*.css";
