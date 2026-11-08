/**
 * A promise the caller awaits later, after other steps that can throw. If one
 * of them throws first, nothing ever awaits it, and its rejection when the
 * browser closes is unhandled: on 2026-11-08 a Medusa trial's
 * `page.waitForRequest` ended the whole 69-trial batch that way. Awaiting the
 * returned promise still rejects as before.
 */
export function awaitedLater<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}
