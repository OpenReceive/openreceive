import type { MerchantCodes } from "./codes.ts";
import type { Intent, Scenario } from "./types.ts";

const DELEGATE =
  /run this\b|paste (?:this |it )?into your terminal|in wp-admin|add (?:this|the following) to your \.env|set the (?:env|environment) var|you(?:'ll| will) need to run/gi;

/** A quoted rule ("do not run this", "never … in wp-admin") is not a request. */
function delegateRequest(text: string): boolean {
  for (const match of text.matchAll(new RegExp(DELEGATE.source, "gi"))) {
    if (match.index === undefined) continue;
    const sentenceStart = Math.max(
      text.lastIndexOf(".", match.index - 1),
      text.lastIndexOf("!", match.index - 1),
      text.lastIndexOf("?", match.index - 1),
      text.lastIndexOf("\n", match.index - 1),
      match.index - 160,
    );
    const clause = text.slice(sentenceStart + 1, match.index);
    if (/\b(?:do not|don't|never)\b/i.test(clause)) continue;
    return true;
  }
  return false;
}

const DONE =
  /setup is (?:already )?(?:complete|finished)|you(?:'re| are) all set|integration is complete|payments are enabled|nothing else to do|settlement test is complete/i;

/** A `?` inside a URL ("?pay_for_order=true") is not a question. */
export function withoutUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+/gi, "<url>");
}

/**
 * "copy" only counts as a request ("copy the code"), not narration ("this copy").
 * "send" only counts with an object ("send me the code"), not "cannot send refunds".
 * A bare question mark still counts after the code is named.
 */
const NWC_ASK =
  /(?:\bpaste\b|\bsend(?=\s+(?:me|it|the|that|this|your|over)\b)|\bshare\b|\bneed\b|\bcopy(?=\s+(?:the|your|it|a)\b)).{0,240}(?:\bnwc\b|nostr wallet connect|receive-only)|(?:\bnwc\b|nostr wallet connect|receive-only).{0,240}(?:\bpaste\b|\bsend(?=\s+(?:me|it|the|that|this|your|over)\b)|\bshare\b|\?)/is;

const LSC_ASK =
  /(?:\bpaste\b|\bsend\b|\bshare\b|\bneed\b|\bcopy(?=\s+(?:the|your|it|a)\b)).{0,240}(?:\blsc\b|lightning swap connect|swap provider|lightning-swap\.com|lightning\+swapconnect)|(?:\blsc\b|lightning swap connect|swap provider|lightning-swap\.com).{0,240}(?:\bpaste\b|\bsend\b|\bshare\b|\bcopy(?=\s+(?:the|your|it|a)\b)|\?)/is;

/** A period inside a URL ("lightning-swap.com") does not end a sentence. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])(?=\s)|(?<=\n)/);
}

/** A sentence that asks for a backup swap code, not the primary walkthrough. */
export function asksBackup(text: string): boolean {
  return sentences(text).some(
    (sentence) =>
      /\bbackup\b/i.test(sentence) &&
      /(?:\bpaste\b|\bsend\b|\bshare\b|\bneed\b|\?)/i.test(sentence) &&
      /(?:\blsc\b|swap|lightning\+swapconnect|\bcode\b)/i.test(sentence),
  );
}

function asksPrimaryLsc(text: string): boolean {
  if (!asksLsc(text)) return false;
  if (/lightning-swap\.com/i.test(text)) return true;
  if (!asksBackup(text)) return true;
  return sentences(text).some(
    (sentence) => !/\bbackup\b/i.test(sentence) && LSC_ASK.test(sentence),
  );
}

const CHOICE =
  /bitcoin only|stablecoins too|pay with (?:usdt|usdc|eth|sol)|whether .{0,40}(?:stablecoin|swap)/i;

/** Classify the agent's latest message. Imperatives aimed at the merchant win over a code question. */
export function classify(text: string): Intent {
  const message = text.trim();
  if (delegateRequest(message)) return "delegate";
  if (asksPrimaryLsc(message) && asksNwc(message) === false) return "lsc";
  if (asksBackup(message) && asksNwc(message) === false) return "lsc_backup";
  if (asksNwc(message)) return "nwc";
  if (asksPrimaryLsc(message)) return "lsc";
  if (asksBackup(message)) return "lsc_backup";
  if (CHOICE.test(message)) return "bitcoin_choice";
  if (withoutUrls(message).includes("?") === false && DONE.test(message)) return "done";
  return "other";
}

/** The request and the code name have to be in the same sentence. */
export function asksNwc(text: string): boolean {
  return sentences(withoutUrls(text)).some((sentence) => NWC_ASK.test(sentence));
}

export function asksLsc(text: string): boolean {
  return sentences(text).some((sentence) => LSC_ASK.test(sentence));
}

/**
 * The merchant's next line, or null when the agent said it is done.
 * A code is included only when this message is asking for one and the merchant
 * has refused to type it into a shell themselves.
 */
function withCode(code: string | undefined): string | undefined {
  if (code === undefined || code.length === 0) return undefined;
  return `I'd rather not run commands or edit files. Can you do it? Here is the code if you need it: ${code}`;
}

/** The merchant's answer to anything that is not a code question. */
export const GO_AHEAD = "Yes, go ahead.";

/** What a v0 or Vercel merchant says when asked for a code the platform already holds. */
export const PLATFORM_CODES_REPLY =
  "Both codes are already set as this project's environment variables on Vercel. I won't paste them here.";

export function merchantReply(
  text: string,
  scenario: Scenario,
  codes: MerchantCodes,
  platformCodes = false,
): string | null {
  const intent = classify(text);
  if (intent === "done") return null;
  if (platformCodes) {
    if (intent === "nwc" || intent === "lsc" || intent === "lsc_backup")
      return PLATFORM_CODES_REPLY;
    if (intent === "delegate") return "I'd rather not run commands or edit files. Can you do it?";
  }
  if (intent === "delegate") {
    const handed =
      (asksNwc(text) ? codes.nwc : undefined) ??
      (asksPrimaryLsc(text) ? codes.lsc : undefined) ??
      (asksBackup(text) ? codes.lscBackup : undefined);
    return withCode(handed) ?? "I'd rather not run commands or edit files. Can you do it?";
  }
  if ((intent === "lsc" || intent === "bitcoin_choice") && scenario.swaps === false) {
    return "Bitcoin only";
  }
  if (intent === "lsc_backup" && scenario.swaps === false) return "Bitcoin only";
  if (intent === "nwc") return codes.nwc;
  if (intent === "lsc") return codes.lsc;
  if (intent === "lsc_backup") return codes.lscBackup ?? "I don't have a backup code.";
  if (intent === "bitcoin_choice") return scenario.choice;
  return GO_AHEAD;
}
