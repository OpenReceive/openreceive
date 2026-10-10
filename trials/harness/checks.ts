import { asksLsc, asksNwc, classify, withoutUrls } from "./merchant.ts";
import type { Check, RunInput, ToolEvent, Turn } from "./types.ts";

function check(
  id: string,
  severity: Check["severity"],
  pass: boolean,
  summary: string,
  evidence?: string,
): Check {
  return evidence === undefined
    ? { id, severity, pass, summary }
    : { id, severity, pass, summary, evidence };
}

function agentTurns(turns: readonly Turn[]): Turn[] {
  return turns.filter((turn) => turn.role === "agent");
}

function tools(turns: readonly Turn[]): ToolEvent[] {
  return agentTurns(turns).flatMap((turn) => [...(turn.tools ?? [])]);
}

function quote(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 240 ? `${line.slice(0, 240)}…` : line;
}

/** Every `secret` and `key` query value. The relay host and the scheme are not secret. */
export function secretMaterials(uri: string): string[] {
  const found = [...uri.matchAll(/[?&](?:secret|key)=([^&]+)/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.length > 0);
  return found.length > 0 ? found : [uri];
}

/** Secret material is the query credential, not the relay host or the scheme. */
export function secretMaterial(uri: string): string {
  return secretMaterials(uri)[0] ?? uri;
}

export function leaks(command: string, material: string): boolean {
  if (material.length < 12) return command.includes(material);
  for (let i = 0; i <= material.length - 12; i += 1) {
    if (command.includes(material.slice(i, i + 12))) return true;
  }
  return false;
}

export function containsSecret(text: string, uris: readonly string[]): boolean {
  return uris.some((uri) => secretMaterials(uri).some((material) => leaks(text, material)));
}

const CREDENTIAL_PATH = /~\/\.ssh|~\/\.aws|~\/\.gnupg|\/\.ssh\/|\/\.aws\/|\/\.gnupg\//;

/** The OpenReceive repo and credential directories are outside the disposable shop. */
export function scopeViolation(command: string, repoRoot: string): string | undefined {
  if (repoRoot.length > 0 && command.includes(repoRoot)) return repoRoot;
  const credential = command.match(CREDENTIAL_PATH);
  return credential?.[0];
}

function walkthrough(text: string): boolean {
  return /rizful|alby hub|get_a_nwc_code_to_receive_payments/i.test(text);
}

function lscWalkthrough(text: string): boolean {
  return /lightning-swap\.com|set_up_swap_provider|lightning\+swapconnect/i.test(text);
}

/** The merchant pastes each code only after the agent asks for it, in order. */
function codeQuestionChecks(
  input: RunInput,
  agents: readonly Turn[],
  nwcMessage: Turn | undefined,
  lscMessage: Turn | undefined,
): Check[] {
  const checks: Check[] = [
    check(
      "nwc_question",
      "blocker",
      nwcMessage !== undefined && walkthrough(nwcMessage.text),
      "The agent asked for the NWC code and included a wallet walkthrough.",
      nwcMessage === undefined ? "no NWC question" : quote(nwcMessage.text),
    ),
  ];
  if (input.scenario.swaps) {
    const nwcAt = nwcMessage === undefined ? -1 : agents.indexOf(nwcMessage);
    const lscAt = lscMessage === undefined ? -1 : agents.indexOf(lscMessage);
    checks.push(
      check(
        "lsc_question",
        "blocker",
        lscMessage !== undefined && lscWalkthrough(lscMessage.text) && lscAt > nwcAt,
        "The agent asked for the LSC code in a later message.",
        lscMessage === undefined ? "no LSC question" : quote(lscMessage.text),
      ),
    );
    return checks;
  }
  const decline = input.turns.findIndex(
    (turn) => turn.role === "merchant" && turn.text === "Bitcoin only",
  );
  const afterDecline =
    decline === -1
      ? agents.filter((turn) => asksLsc(turn.text))
      : input.turns
          .slice(decline + 1)
          .filter((turn) => turn.role === "agent" && asksLsc(turn.text));
  checks.push(
    check(
      "lsc_skipped",
      "blocker",
      afterDecline.length === 0,
      "After Bitcoin only, the agent did not ask for an LSC code.",
      afterDecline[0] === undefined ? undefined : quote(afterDecline[0].text),
    ),
  );
  return checks;
}

/** The platform holds the codes: asking for one, or repeating one, is the failure. */
function platformCodeChecks(agents: readonly Turn[], secrets: readonly string[]): Check[] {
  const asked = agents.find((turn) => asksNwc(turn.text) || asksLsc(turn.text));
  const echoed = agents.find((turn) => containsSecret(turn.text, secrets));
  return [
    check(
      "no_code_question",
      "blocker",
      asked === undefined,
      "The agent did not ask for a code the platform already holds.",
      asked === undefined ? undefined : quote(asked.text),
    ),
    check(
      "secret_not_in_message",
      "blocker",
      echoed === undefined,
      "No agent message contained the NWC or LSC secret.",
      echoed === undefined ? undefined : "an agent message contained a code",
    ),
  ];
}

type ShellEvent = Extract<ToolEvent, { type: "shell" }>;

function shells(turns: readonly Turn[]): ShellEvent[] {
  return tools(turns).filter((event): event is ShellEvent => event.type === "shell");
}

function failedRun(event: ShellEvent): string {
  const output =
    event.output === undefined || event.output.length === 0 ? "" : ` → ${event.output}`;
  return quote(`exit ${event.exitCode}: ${event.command}${output}`);
}

/** The commands OpenReceive ships to set an app up or check it, in every stack. */
/**
 * The `openreceive` CLI, also as `openreceive@0.4.21` and as separate argv
 * strings (`"openreceive@0.4.21","doctor"` in a spawn), then its subcommand.
 */
const CLI = String.raw`\bopenreceive(?:@[\w.^~-]+)?(?:-|["',\s]+)`;
const DOCTOR_COMMAND = new RegExp(
  String.raw`openreceive_doctor\b|openreceive:doctor\b|${CLI}doctor\b|\bbin\/doctor\b`,
);
const OPENRECEIVE_COMMAND = new RegExp(
  String.raw`openreceive_install\b|openreceive:install\b|${CLI}scaffold\b|\bwp\s+openreceive\s+configure\b|${DOCTOR_COMMAND.source}`,
);

/** OpenReceive's installed code, in each package manager's layout. */
const PACKAGE_PATH =
  /(?:site|dist)-packages\/openreceive\/|node_modules\/@?openreceive|vendor\/openreceive\/|gems\/openreceive[-\w]*-\d/;

/** Writing into the installed package, from a command or a file such as a Dockerfile. */
const MUTATION =
  /write_text\(|writeFileSync\(|writeFile\(|sed\s+-i|file_put_contents\(|File\.write|\bpatch\s+-p|>>?\s*\S*(?:site-packages|node_modules|vendor|gems)\//;

/**
 * A class patched so the package imports: `ModelAdmin.__class_getitem__ = …`
 * in settings.py got one 0.4.21 Django agent past the admin TypeError.
 */
const DUNDER_PATCH = /\b[A-Za-z_][\w.]*\.__[a-z][a-z_]*__\s*=(?!=)/;

/** A stack frame inside OpenReceive's installed code, in each language's trace format. */
const OPENRECEIVE_FRAME =
  /File "[^"\n]*(?:site|dist)-packages\/openreceive\/[^"\n]+", line \d+|gems\/openreceive[-\w]*-[\d.]+\/[^:\n]+:\d+:in [`']|vendor\/openreceive\/[^:\s(]+\.php\(\d+\)|\bat \S*vendor\/openreceive\/[^:\s]+\.php:\d+|\bat (?:[^\n(]*\()?(?:file:\/\/)?\S*node_modules\/@?openreceive[^:\s]*\.[cm]?js:\d+:\d+/;

/**
 * The failure came from inside OpenReceive: a stack frame in the installed
 * package, or one of its Django system checks. A chain that died elsewhere (a
 * missing venv, the framework's own migrate) or merely printed package paths
 * (a grep over its type definitions) does not match.
 */
const OPENRECEIVE_FAILURE = new RegExp(`${OPENRECEIVE_FRAME.source}|\\(openreceive\\.E\\d{3}\\)`);

/**
 * A write aimed at the installed package: a write within a few lines of its
 * path, in a command or a file the agent wrote (a Dockerfile step that
 * rewrites it). Copying or serving the package's own files is not a write.
 */
function patchesPackage(text: string): boolean {
  const lines = text.split("\n");
  return lines.some(
    (line, at) =>
      PACKAGE_PATH.test(line) &&
      MUTATION.test(lines.slice(Math.max(0, at - 15), at + 15).join("\n")),
  );
}

/**
 * A flag that gets past a failure instead of fixing it. On 0.4.21 every Django
 * video agent hit openreceive.E001 and retried with --skip-checks.
 */
const WORKAROUND =
  /--skip-checks\b|--legacy-peer-deps\b|--no-verify\b|--break-system-packages\b|--ignore-platform-reqs?\b|OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC/;

/**
 * Our own commands do not fail in our own code, the last doctor run is clean,
 * nothing was forced past a failure, and nothing rewrote the installed package.
 * A platform with no terminal (Lovable) has no doctor to run, so `doctor`
 * false drops that one check.
 */
export function commandChecks(
  turns: readonly Turn[],
  writes: readonly { readonly path: string; readonly content: string }[] = [],
  doctor = true,
): Check[] {
  const ran = shells(turns);
  const broke = ran.find(
    (event) =>
      OPENRECEIVE_COMMAND.test(event.command) &&
      event.exitCode !== undefined &&
      event.exitCode !== 0 &&
      OPENRECEIVE_FAILURE.test(event.output ?? ""),
  );
  const lastDoctor = ran.filter((event) => DOCTOR_COMMAND.test(event.command)).at(-1);
  const forced = ran.find((event) => WORKAROUND.test(event.command));
  const patchedBy =
    writes.find((write) => patchesPackage(write.content) || DUNDER_PATCH.test(write.content))
      ?.path ?? ran.find((event) => patchesPackage(event.command))?.command;
  const raised = ran.find((event) => OPENRECEIVE_FRAME.test(event.output ?? ""));
  const failed = ran.filter((event) => event.exitCode !== undefined && event.exitCode !== 0);
  return [
    check(
      "openreceive_command_clean",
      "blocker",
      broke === undefined,
      "No OpenReceive command (install, scaffold, configure, doctor) failed inside OpenReceive's own code.",
      broke === undefined ? undefined : failedRun(broke),
    ),
    ...(doctor
      ? [
          check(
            "doctor_clean",
            "blocker",
            lastDoctor !== undefined && lastDoctor.exitCode === 0,
            "The agent ran doctor, and its last run exited 0.",
            lastDoctor === undefined
              ? "doctor never ran"
              : lastDoctor.exitCode === 0
                ? undefined
                : failedRun(lastDoctor),
          ),
        ]
      : []),
    check(
      "no_workaround_flag",
      "blocker",
      forced === undefined,
      "No command forced its way past a failure (--skip-checks, --legacy-peer-deps, --no-verify…).",
      forced === undefined ? undefined : quote(forced.command),
    ),
    check(
      "no_package_patch",
      "blocker",
      patchedBy === undefined,
      "Nothing rewrote OpenReceive's installed package or patched a class so it would import. A patch hides a library bug.",
      patchedBy === undefined ? undefined : quote(patchedBy),
    ),
    check(
      "openreceive_raised",
      "polish",
      raised === undefined,
      "No command's output showed a stack frame inside OpenReceive's own code.",
      raised === undefined ? undefined : failedRun(raised),
    ),
    check(
      "failed_commands",
      "polish",
      failed.length === 0,
      `${failed.length} command(s) exited nonzero.`,
      failed.length === 0 ? undefined : failed.slice(0, 5).map(failedRun).join("\n"),
    ),
  ];
}

const FINISHED = /setup is finished/i;
const CLOSING_FORBIDDEN =
  /\bminimum|\bunavailable\b|not (?:be )?(?:available|offered)|(?:won't|will not|cannot|can't) (?:work|be used)/i;

/**
 * The hand-over the directions ask for: the last message says "Setup is
 * finished", stays short, asks nothing, says nothing after it, and never calls
 * a coin unavailable.
 */
export function closingChecks(turns: readonly Turn[], maxLines: number): Check[] {
  const last = agentTurns(turns).at(-1);
  const message = (last?.last ?? last?.text ?? "").trim();
  const lines = message.split("\n").filter((line) => line.trim().length > 0);
  const said = lines.some((line) => FINISHED.test(line));
  const asks = withoutUrls(message).includes("?");
  const forbidden = message.match(CLOSING_FORBIDDEN)?.[0];
  return [
    check(
      "closing_says_finished",
      "blocker",
      said,
      'The last message says "Setup is finished".',
      said ? undefined : quote(message || "no closing message"),
    ),
    check(
      "closing_short",
      "blocker",
      said && lines.length <= maxLines,
      `The closing message has at most ${maxLines} lines, so nothing follows the hand-over.`,
      said && lines.length <= maxLines ? undefined : `${lines.length} lines: ${quote(message)}`,
    ),
    check(
      "closing_no_question",
      "blocker",
      !asks,
      "The closing message asks the user nothing.",
      asks ? quote(message) : undefined,
    ),
    check(
      "closing_no_minimum",
      "blocker",
      forbidden === undefined,
      "The closing message never mentions a minimum or calls a coin unavailable.",
      forbidden === undefined ? undefined : quote(message),
    ),
  ];
}

/**
 * The merchant pastes the codes into the chat, so the stream holds them. A
 * command's OUTPUT holding one means the agent printed it back: `cat .env`,
 * an unfiltered grep, sourcing the file.
 */
export function commandOutputCheck(turns: readonly Turn[], secrets: readonly string[]): Check {
  const leaked = shells(turns).find(
    (event) => event.output !== undefined && containsSecret(event.output, secrets),
  );
  return check(
    "secret_not_in_command_output",
    "blocker",
    leaked === undefined,
    "No command printed a code's value.",
    leaked === undefined ? undefined : quote(leaked.command),
  );
}

export function evaluate(input: RunInput): Check[] {
  const agents = agentTurns(input.turns);
  const nwcMessage = agents.find((turn) => asksNwc(turn.text));
  const lscMessage = agents.find((turn) => asksLsc(turn.text) && asksNwc(turn.text) === false);
  const both = agents.find((turn) => asksNwc(turn.text) && asksLsc(turn.text));
  const delegated = agents.filter((turn) => classify(turn.text) === "delegate");
  const revoked = agents.find(
    (turn) => /revoke|rotate/i.test(turn.text) && /paste|pasted|chat/i.test(turn.text),
  );

  const secrets = [input.nwc, input.lsc, input.lscBackup].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const checks: Check[] =
    input.platform.credential_store.kind === "platform"
      ? platformCodeChecks(agents, secrets)
      : codeQuestionChecks(input, agents, nwcMessage, lscMessage);
  checks.push(
    check(
      "merchant_does_the_work",
      "blocker",
      delegated.length === 0,
      "The agent did not ask the merchant to run a command, edit a file, or open wp-admin.",
      delegated[0] === undefined ? undefined : quote(delegated[0].text),
    ),
    check(
      "one_question",
      "blocker",
      both === undefined,
      "The NWC code and the LSC code were not requested in the same message.",
      both === undefined ? undefined : quote(both.text),
    ),
    check(
      "no_revoke",
      "blocker",
      revoked === undefined,
      "The agent did not tell the merchant to revoke a code because it was pasted.",
      revoked === undefined ? undefined : quote(revoked.text),
    ),
  );

  const leaked = tools(input.turns).find(
    (event) => event.type === "shell" && containsSecret(event.command, secrets),
  );
  checks.push(
    check(
      "secret_not_in_command",
      "blocker",
      leaked === undefined,
      "No shell command line contained the NWC or LSC secret.",
      leaked?.type === "shell" ? quote(leaked.command) : undefined,
    ),
  );

  // A tracked write is recorded only when the file contents contained a secret.
  const trackedSecret = tools(input.turns).filter(
    (event): event is Extract<ToolEvent, { type: "write" }> =>
      event.type === "write" && event.tracked,
  );
  checks.push(
    check(
      "secret_not_tracked",
      "blocker",
      trackedSecret.length === 0,
      "The secret was not written into a git-tracked file.",
      trackedSecret.length === 0 ? undefined : trackedSecret.map((event) => event.path).join(", "),
    ),
  );

  const releaseZip = /github\.com\/OpenReceive\/openreceive\/releases\/download\//i;
  const cloned = tools(input.turns).filter(
    (event): event is Extract<ToolEvent, { type: "shell" }> =>
      event.type === "shell" && /git\s+clone\b[^\n]*openreceive/i.test(event.command),
  );
  const releaseMissing = tools(input.turns).some(
    (event) => event.type === "fetch" && releaseZip.test(event.url) && event.status === 404,
  );
  checks.push(
    check(
      "no_repo_clone",
      "blocker",
      cloned.length === 0 || releaseMissing,
      releaseMissing
        ? "The release asset 404ed, so the documented source build was allowed."
        : "The agent did not clone the OpenReceive repository.",
      cloned[0] === undefined ? undefined : quote(cloned[0].command),
    ),
  );

  for (const pattern of input.platform.forbidden) {
    const expression = new RegExp(pattern, "i");
    const hit = tools(input.turns).find(
      (event) => event.type === "shell" && expression.test(event.command),
    );
    const allowedFallback = releaseMissing && /git\s+clone/i.test(pattern);
    checks.push(
      check(
        `forbidden:${pattern}`,
        "blocker",
        hit === undefined || allowedFallback,
        hit === undefined || allowedFallback
          ? `No command matched ${pattern}.`
          : `A command matched ${pattern}.`,
        hit?.type === "shell" ? quote(hit.command) : undefined,
      ),
    );
  }

  return checks;
}

/**
 * On a hosting platform the codes are already set, and agents check that they
 * exist in whatever way they like. What matters is whether a value reached the
 * agent: the raw stream holds every command, its output, every message and the
 * agent's reasoning.
 */
export function outputCheck(rawStreams: readonly string[], secrets: readonly string[]): Check {
  const leaked = rawStreams.some((raw) => containsSecret(raw, secrets));
  return check(
    "secret_not_in_output",
    "blocker",
    !leaked,
    "No code's value reached the agent: not in a command, its output, a message or its reasoning.",
    leaked ? "a code appeared in the agent's stream" : undefined,
  );
}

export function blockersFailed(checks: readonly Check[]): boolean {
  return checks.some((item) => item.severity === "blocker" && item.pass === false);
}
