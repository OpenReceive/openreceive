<?php

declare(strict_types=1);

namespace OpenReceive\Server;

use OpenReceive\Host;
use OpenReceive\Hosts\AllowAllAuthorize;
use OpenReceive\Hosts\LoggingOnPaid;
use OpenReceive\Kernel;
use OpenReceive\Nwc\Errors;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Nwc\WalletUnavailableError;

/**
 * Step 0 of the agent directions, as report lines. PRESENCE ONLY: no secret is
 * ever printed, echoed or partially shown — every credential line is "set" or
 * "unset", which is what makes the output safe to paste into an issue.
 */
final class Doctor
{
    /**
     * @param array<string, mixed> $env
     * @param (callable(): mixed)|null $walletCheck builds the Service (and with it the receive-only preflight); return it so the report can prove the wallet accepts the code; a throw is reported, never raised
     * @return list<string>
     */
    public static function report(array $env, ?Host $host = null, ?callable $walletCheck = null, ?string $mountedAt = null): array
    {
        $set = static fn (string $name): string => trim((string) ($env[$name] ?? '')) === '' ? 'unset' : 'set';
        $lines = [
            'OpenReceive doctor',
            "  NWC_URI:          {$set('NWC_URI')}",
            "  LSC_URI_PRIMARY:  {$set('LSC_URI_PRIMARY')}",
            "  LSC_URI_BACKUP:   {$set('LSC_URI_BACKUP')}",
        ];
        if ($host === null) {
            $lines[] = '  host:             NOT CONFIGURED — implement OpenReceive\\Host and pass it to the engine';
        } else {
            // An anonymous class's name holds a NUL byte, and tools then treat the report as binary.
            $lines[] = '  host:             ' . ((new \ReflectionClass($host))->isAnonymous() ? 'an anonymous class' : $host::class);
            $lines[] = '  authorize:        ' . (self::usesTrait($host, AllowAllAuthorize::class) ? 'the generated placeholder (allow-all) — replace it' : 'set');
            $lines[] = '  amount_for:       set';
            $lines[] = '  on_paid:          ' . (self::usesTrait($host, LoggingOnPaid::class) ? 'the generated placeholder (logging-only) — replace it' : 'set');
        }
        $lines[] = '  engine mounted:   ' . ($mountedAt === null ? 'unknown — the host mounts Psr15Handler' : "at {$mountedAt}");
        $lines[] = '  wallet preflight: ' . self::walletReport($walletCheck);
        $lines[] = self::agentSkillsLine((string) getcwd(), ($env['HOME'] ?? null) ?: (getenv('HOME') ?: null));
        return $lines;
    }

    /**
     * Where an agent already finds the integrate-openreceive skill: a copy in
     * the project's skills folders, or the Claude Code plugin enabled in
     * project or user settings. Doctor suggests an install only when it finds none.
     */
    public static function agentSkillsLine(string $cwd, ?string $home): string
    {
        foreach (['.agents/skills', '.claude/skills'] as $dir) {
            if (is_file("{$cwd}/{$dir}/integrate-openreceive/SKILL.md")) {
                return "Agent skills: installed ({$dir}/integrate-openreceive)";
            }
        }
        $settings = [
            '.claude/settings.local.json' => "{$cwd}/.claude/settings.local.json",
            '.claude/settings.json' => "{$cwd}/.claude/settings.json",
        ];
        if ($home !== null && $home !== '') {
            $settings['~/.claude/settings.json'] = "{$home}/.claude/settings.json";
        }
        foreach ($settings as $label => $file) {
            // Missing or not JSON: Claude Code would not load the plugin from it either.
            $parsed = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
            if (is_array($parsed) && is_array($parsed['enabledPlugins'] ?? null)
                && ($parsed['enabledPlugins']['openreceive@openreceive'] ?? null) === true) {
                return "Agent skills: installed ({$label} enables the openreceive plugin)";
            }
        }
        return 'Agent skills: optional — if your agent has no OpenReceive skill yet, run `npx skills add OpenReceive/openreceive`';
    }

    /**
     * Boot-time warnings for a host still shipping the scaffolded placeholders.
     *
     * @return list<string>
     */
    public static function placeholderWarnings(Host $host): array
    {
        $warnings = [];
        if (self::usesTrait($host, AllowAllAuthorize::class)) {
            $warnings[] = '[openreceive] authorize is the generated placeholder (allow-all): anyone holding an order reference can mint invoices, poll status and request refunds for it. Replace it before going live. https://openreceive.org/guides/authorization.md';
        }
        if (self::usesTrait($host, LoggingOnPaid::class)) {
            $warnings[] = '[openreceive] onPaid is the generated placeholder (logging-only): orders will be recorded as settled without being fulfilled. Replace it before going live. https://openreceive.org/guides/api-reference.md';
        }
        return $warnings;
    }

    /**
     * A wallet publishes its methods for anyone to read, so a wrong secret
     * passes the preflight. Only a signed request proves the wallet accepts
     * this code, and reading a history row changes nothing.
     */
    public static function proveCodeAccepted(ReceiveNwcClient $client): void
    {
        try {
            $client->listTransactions(['limit' => 1]);
        } catch (\Throwable $e) {
            $code = Errors::normalizeWalletError($e)['code'];
            if ($code === 'UNAUTHORIZED') {
                throw new \RuntimeException('the wallet refused this code (UNAUTHORIZED). The secret in NWC_URI is wrong, or the connection was removed from the wallet. Get a fresh receive-only code: ' . Kernel::NWC_CODE_HELP_URL, 0, $e);
            }
            if ($code === 'TIMEOUT' || $e instanceof WalletUnavailableError) {
                throw new \RuntimeException('the wallet published its details but did not answer a signed request. The secret in NWC_URI may be wrong, or the wallet may be offline. Copy the code from your wallet again and rerun.', 0, $e);
            }
            throw $e;
        }
    }

    private static function walletReport(?callable $walletCheck): string
    {
        if ($walletCheck === null) {
            return 'skipped — no wallet check was supplied';
        }
        try {
            $service = $walletCheck();
            if ($service instanceof Service) {
                self::proveCodeAccepted($service->nwcClient());
            }
            return 'ok — the wallet answered and is receive-only';
        } catch (\Throwable $e) {
            return 'FAILED — ' . Reconciler::sanitizeFailureMessage($e);
        }
    }

    private static function usesTrait(object $object, string $trait): bool
    {
        $class = $object::class;
        while ($class !== false) {
            if (in_array($trait, class_uses($class) ?: [], true)) {
                return true;
            }
            $class = get_parent_class($class);
        }
        return false;
    }
}
