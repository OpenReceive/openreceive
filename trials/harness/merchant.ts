import type { MerchantCodes } from "./codes.ts";
import { pasted } from "./scenarios.ts";
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
  /(?:\bpaste\b|\bsend(?=\s+(?:me|it|the|that|this|your|over)\b)|\bshare\b|\bneed\b|\bcopy(?=\s+(?:the|your|it|a)\b)).{0,240}(?:\bnwc\b|nostr wallet connect|receive-only|nostr\+walletconnect)|(?:\bnwc\b|nostr wallet connect|receive-only).{0,240}(?:\bpaste\b|\bsend(?=\s+(?:me|it|the|that|this|your|over)\b)|\bshare\b|\btap\s+copy\b|\?)/is;

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

/**
 * The choice is asked, not reported. "Bitcoin only is already set. Open the
 * shop and click Buy." is a closing: answering it "Bitcoin only" kept three
 * 2026-11-08 trials going until their 30th turn.
 */
function asksChoice(text: string): boolean {
  return sentences(withoutUrls(text)).some(
    (sentence) =>
      CHOICE.test(sentence) &&
      (/\?/.test(sentence) ||
        /\b(?:whether|or say|reply|answer|tell me|let me know|choose|pick)\b/i.test(sentence)),
  );
}

/** One of the merchant's codes. */
export type CodeName = "nwc" | "lsc" | "lsc_backup";

/** The code a message asks to have pasted in chat, if any. */
function chatCode(message: string): CodeName | undefined {
  if (asksPrimaryLsc(message) && asksNwc(message) === false) return "lsc";
  if (asksBackup(message) && asksNwc(message) === false) return "lsc_backup";
  if (asksNwc(message)) return "nwc";
  if (asksPrimaryLsc(message)) return "lsc";
  if (asksBackup(message)) return "lsc_backup";
  return undefined;
}

/**
 * Classify the agent's latest message. A request to save a code in a named
 * file wins; then imperatives aimed at the merchant win over a code question.
 */
export function classify(text: string): Intent {
  const message = text.trim();
  if (codeFileAsks(message).length > 0) return "file";
  if (delegateRequest(message)) return "delegate";
  const code = chatCode(message);
  if (code !== undefined) return code;
  if (asksChoice(message)) return "bitcoin_choice";
  if (withoutUrls(message).includes("?") === false && DONE.test(message)) return "done";
  return "other";
}

// ------------------------------------------------------------ a code in a file
//
// An agent that will not take a code in chat asks for it in a file, as the
// directions allow: "Add `NWC_URI=<your code>` to `.env` in this project,
// then reply saved." or "Save the code alone in `/tmp/openreceive-nwc`, then
// reply saved." On 2026-11-23 Codex asked this way and the merchant, who
// only answered "Yes, go ahead.", kept a Vendure trial going for 30 turns.

/** A code variable, prefix and all: `NWC_URI`, `OPENRECEIVE_LSC_URI_PRIMARY`. */
const CODE_VARIABLE = /\b((?:[A-Z][A-Z0-9]*_)*(?:NWC_URI|LSC_URI_PRIMARY|LSC_URI_BACKUP))\b/g;
const CODE_ASSIGNMENT = new RegExp(`${CODE_VARIABLE.source}=`);
const BACKTICKED = /`([^`\s]+)`/g;
/** A file to hold `NAME=value` lines; an example file is tracked, so never one. */
const ENV_FILE =
  /^(?:\.env(?:\.(?!example$|sample$|template$|dist$)[\w.-]+)?|[\w.-]+\.env|\.dev\.vars)$/i;
/** A file of source or config, which a code on its own would break. */
const SOURCE_FILE =
  /\.(?:[cm]?[jt]sx?|php|py|rb|go|rs|java|cs|json|ya?ml|toml|xml|html?|css|scss|vue|svelte|astro|sh|ini|conf|cfg|lock|md|sql)$/i;
const VERBS =
  "add|put|save|write|set|store|place|configure|paste|enter|create|update|edit|insert|append|copy";
const WRITE_VERB = new RegExp(`\\b(?:${VERBS})\\b`, "i");
/** The clause opens with the verb: "Add …", "Then save …", "2. Put …". */
const IMPERATIVE = new RegExp(
  `^[\\s"'“‘*_>(•-]*(?:\\d+[.)]\\s*)?(?:(?:please|then|now|next|just|also|first|finally|instead|so|simply)\\b[\\s,]*)*(?:${VERBS})\\b`,
  "i",
);
const POLITE = /\bplease\b|\b(?:can|could|would|will) you\b|\byou (?:can|could)\b/i;
/** "I will store it in `.env`": the agent does the writing. */
const FIRST_PERSON = /\bI\b|\b[Ww]e\b/;
const PROHIBITION = /\b(?:do not|don't|never)\b/i;
const REPLY_CUE = /\b(?:reply|respond|let me know|tell me|ping me)\b/i;
const CLAUSE = /[,;]\s+|\s+(?:and|or|then)\s+|\s+[—–]\s+/i;
const ALONE =
  /\b(?:alone|by itself|on its own|nothing else)\b|\b(?:only|just) the (?:code|uri|value)\b/i;
const CODE_WORD = /\b(?:code|uri|connection|secret|key|credential)\b/i;
const NWC_WORDS =
  /\bnwc\b|nostr wallet connect|nostr\+walletconnect|receive-only|\bwallet\b|rizful|alby/i;
const LSC_WORDS = /\blsc\b|swap|lightning-swap\.com|lightning\+swapconnect/i;

/** URLs out of the way, keeping the period that ends their sentence. */
function maskUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+?(?=[).,;:!?'"]*(?:\s|$))/gi, "<url>");
}

/**
 * A sentence's clauses. One with no verb and no subject of its own goes on
 * with the clause before it: "Add `A` and `B` to `.env`" is one request, while
 * "Paste it here and I will store it in `.env`" is two.
 */
function clauses(sentence: string): string[] {
  const out: string[] = [];
  for (const part of sentence.split(CLAUSE)) {
    const previous = out.at(-1);
    if (previous !== undefined && !WRITE_VERB.test(part) && !FIRST_PERSON.test(part)) {
      out[out.length - 1] = `${previous} ${part}`;
    } else {
      out.push(part);
    }
  }
  return out;
}

function pathLike(token: string): boolean {
  return (
    /^[~\w.@+\-/]+$/.test(token) &&
    /\w/.test(token) &&
    !token.endsWith("/") &&
    (token.includes("/") || token.startsWith(".") || /\.\w+$/.test(token))
  );
}

function variableCode(variable: string): CodeName {
  if (variable.endsWith("NWC_URI")) return "nwc";
  return variable.endsWith("BACKUP") ? "lsc_backup" : "lsc";
}

/** The code some words name, when they name only one kind. */
function codeNamed(text: string): CodeName | undefined {
  const nwc = NWC_WORDS.test(text);
  const lsc = LSC_WORDS.test(text);
  if (lsc && !nwc) return /backup/i.test(text) ? "lsc_backup" : "lsc";
  return nwc && !lsc ? "nwc" : undefined;
}

/** A file the agent asked the merchant to put a code in. */
export interface CodeFileAsk {
  /** As the agent wrote it: relative to the shop, or absolute. */
  readonly path: string;
  /** The `NAME=value` line to set, or undefined for a file that holds the code alone. */
  readonly variable?: string;
  /** Undefined when nothing in the message says which code. */
  readonly code?: CodeName;
}

/**
 * Every request in a message to save a code in a backticked file: a code
 * variable (`NWC_URI=<your code>`) for an env file, or the code alone in any
 * other file that is not source. The clause naming the file asks the merchant
 * to write it ("Add …", "Please configure …"), not the agent ("I will store
 * it in `.env`"), and is not a rule ("never …"). A closing is not a request.
 */
export function codeFileAsks(text: string): CodeFileAsk[] {
  const message = maskUrls(text.trim());
  if (DONE.test(message) && !message.includes("?") && !REPLY_CUE.test(message)) return [];
  const replyAsked = REPLY_CUE.test(message);
  const context = NWC_WORDS.test(message) || LSC_WORDS.test(message);
  const asks: CodeFileAsk[] = [];
  for (const sentence of sentences(message)) {
    const variables = [...new Set([...sentence.matchAll(CODE_VARIABLE)].map((m) => m[1] ?? ""))];
    const assigned = CODE_ASSIGNMENT.test(sentence);
    for (const clause of clauses(sentence)) {
      if (!WRITE_VERB.test(clause) || FIRST_PERSON.test(clause) || PROHIBITION.test(clause)) {
        continue;
      }
      const addressed =
        POLITE.test(clause) || (IMPERATIVE.test(clause) && (assigned || replyAsked));
      if (!addressed) continue;
      for (const [, file = ""] of clause.matchAll(BACKTICKED)) {
        if (!pathLike(file)) continue;
        const name = file.split("/").at(-1) ?? file;
        if (ENV_FILE.test(name)) {
          for (const variable of variables) {
            asks.push({ path: file, variable, code: variableCode(variable) });
          }
        } else if (
          !SOURCE_FILE.test(name) &&
          context &&
          (ALONE.test(sentence) || (CODE_WORD.test(sentence) && codeNamed(sentence) !== undefined))
        ) {
          const hinted = variables.length === 1 ? variableCode(variables[0] ?? "") : undefined;
          asks.push({
            path: file,
            code: codeNamed(sentence) ?? codeNamed(name) ?? hinted ?? chatCode(text),
          });
        }
      }
    }
  }
  return asks;
}

/** Every code a message asks for in a file. */
export function fileCodes(text: string): CodeName[] {
  return [
    ...new Set(codeFileAsks(text).flatMap((ask) => (ask.code === undefined ? [] : [ask.code]))),
  ];
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

/** A merchant who has no wallet code yet. */
export const NO_CODE_YET =
  "I don't have that code yet; I'll get it tomorrow. Please stop here for today.";

/** The owner's approval the house-rules AGENTS.md tells the agent to ask for. */
export const MIGRATION_APPROVAL = "Yes, go ahead and run the migration.";

/** A message about a migration: the house rule says to ask before running one. */
export const MIGRATION = /\bmigrat|openreceive_payments|\bdatabase tables?\b/i;

/** What a merchant has answered so far in one run, for the scenarios that change their mind. */
export interface MerchantMemory {
  nwcAsks: number;
  lscAsks: number;
  /** The spend-capable code was pasted and the receive-only one not yet. */
  spendCodeLive: boolean;
  toldNoCode: boolean;
  followedUp: boolean;
}

export function newMerchantMemory(): MerchantMemory {
  return { nwcAsks: 0, lscAsks: 0, spendCodeLive: false, toldNoCode: false, followedUp: false };
}

/** After a spend-capable code was refused, an agent may ask for a new one in its own words. */
const ASKS_ANOTHER_CODE =
  /\b(?:receive[- ]only|read[- ]only|spend[- ]capable|can spend|pay_invoice|another code|new code|different code)\b/i;

function nwcCode(scenario: Scenario, codes: MerchantCodes, memory: MerchantMemory): string {
  memory.nwcAsks += 1;
  if (memory.nwcAsks === 1) {
    if (scenario.firstPaste === "swapped") return codes.lsc;
    if (scenario.firstPaste === "spend-capable" && codes.spendNwc !== undefined) {
      memory.spendCodeLive = true;
      return codes.spendNwc;
    }
  }
  memory.spendCodeLive = false;
  return codes.nwc;
}

function lscCode(scenario: Scenario, codes: MerchantCodes, memory: MerchantMemory): string {
  memory.lscAsks += 1;
  return scenario.firstPaste?.startsWith("swapped") && memory.lscAsks === 1 ? codes.nwc : codes.lsc;
}

/** The merchant's whole answer after saving a code where the agent asked. */
export const SAVED = "saved";

/** Before the code, when the file the agent named is outside the shop and the temp directory. */
export const CANNOT_SAVE = "I can only save files in this project. Here it is:";

/** A code the merchant saves to a file; loop.ts writes it, or sends `refused` instead. */
export interface CodeFileSave {
  readonly path: string;
  /** Set this `NAME=value` line; undefined writes the code alone. */
  readonly variable?: string;
  readonly value: string;
  /** The reply in place of SAVED when the file may not be written: the code, in chat. */
  readonly refused: string;
}

export interface MerchantTurn {
  /** Null when the agent said it is done. */
  readonly reply: string | null;
  readonly save?: CodeFileSave;
}

function fileTurn(
  text: string,
  scenario: Scenario,
  codes: MerchantCodes,
  memory: MerchantMemory,
): MerchantTurn {
  const asks = codeFileAsks(text);
  const ask = asks.find((each) => each.code !== undefined) ?? asks[0];
  if (ask === undefined) return { reply: GO_AHEAD };
  // Nothing says which code: the one the merchant has not given yet.
  const code = ask.code ?? (memory.nwcAsks === 0 ? "nwc" : "lsc");
  if (code !== "nwc" && scenario.swaps === false) return { reply: "Bitcoin only" };
  const value =
    code === "nwc"
      ? nwcCode(scenario, codes, memory)
      : code === "lsc"
        ? lscCode(scenario, codes, memory)
        : codes.lscBackup;
  if (value === undefined || value.length === 0) return { reply: "I don't have a backup code." };
  return {
    reply: SAVED,
    save: {
      path: ask.path,
      ...(ask.variable === undefined ? {} : { variable: ask.variable }),
      value,
      refused: `${CANNOT_SAVE} ${pasted(value, scenario)}`,
    },
  };
}

/** The merchant's next line, as a string; merchantTurn also says what to save. */
export function merchantReply(
  text: string,
  scenario: Scenario,
  codes: MerchantCodes,
  platformCodes = false,
  memory: MerchantMemory = newMerchantMemory(),
): string | null {
  return merchantTurn(text, scenario, codes, platformCodes, memory).reply;
}

export function merchantTurn(
  text: string,
  scenario: Scenario,
  codes: MerchantCodes,
  platformCodes = false,
  memory: MerchantMemory = newMerchantMemory(),
): MerchantTurn {
  const intent = classify(text);
  if (intent === "file" && !memory.toldNoCode && !memory.followedUp) {
    if (scenario.noCodeYet === true) {
      memory.toldNoCode = true;
      return { reply: NO_CODE_YET };
    }
    if (platformCodes) return { reply: PLATFORM_CODES_REPLY };
    return fileTurn(text, scenario, codes, memory);
  }
  return { reply: chatReply(text, intent, scenario, codes, platformCodes, memory) };
}

function chatReply(
  text: string,
  intent: Intent,
  scenario: Scenario,
  codes: MerchantCodes,
  platformCodes: boolean,
  memory: MerchantMemory,
): string | null {
  // A scenario's last word: the merchant stopped, or asked the one follow-up.
  if (memory.toldNoCode || memory.followedUp) return null;
  if (scenario.noCodeYet === true) {
    if (intent === "done") return null;
    if (intent === "nwc" || intent === "lsc" || intent === "lsc_backup" || intent === "delegate") {
      memory.toldNoCode = true;
      return NO_CODE_YET;
    }
    return GO_AHEAD;
  }
  if (intent === "done") {
    if (scenario.followUp === undefined) return null;
    memory.followedUp = true;
    return scenario.followUp;
  }
  if (platformCodes) {
    if (intent === "nwc" || intent === "lsc" || intent === "lsc_backup")
      return PLATFORM_CODES_REPLY;
    if (intent === "delegate") return "I'd rather not run commands or edit files. Can you do it?";
  }
  if (
    scenario.houseRules === true &&
    MIGRATION.test(text) &&
    (intent === "other" || intent === "delegate")
  ) {
    return MIGRATION_APPROVAL;
  }
  const paste = (code: string | undefined): string | undefined =>
    code === undefined || code.length === 0 ? code : pasted(code, scenario);
  if (memory.spendCodeLive && intent === "other" && ASKS_ANOTHER_CODE.test(text)) {
    return paste(nwcCode(scenario, codes, memory)) ?? codes.nwc;
  }
  if (intent === "delegate") {
    const handed =
      (asksNwc(text) ? nwcCode(scenario, codes, memory) : undefined) ??
      (asksPrimaryLsc(text) ? lscCode(scenario, codes, memory) : undefined) ??
      (asksBackup(text) ? codes.lscBackup : undefined);
    return withCode(paste(handed)) ?? "I'd rather not run commands or edit files. Can you do it?";
  }
  if ((intent === "lsc" || intent === "bitcoin_choice") && scenario.swaps === false) {
    return "Bitcoin only";
  }
  if (intent === "lsc_backup" && scenario.swaps === false) return "Bitcoin only";
  if (intent === "nwc") return paste(nwcCode(scenario, codes, memory)) ?? codes.nwc;
  if (intent === "lsc") return paste(lscCode(scenario, codes, memory)) ?? codes.lsc;
  if (intent === "lsc_backup") return paste(codes.lscBackup) ?? "I don't have a backup code.";
  if (intent === "bitcoin_choice") return scenario.choice;
  return GO_AHEAD;
}
