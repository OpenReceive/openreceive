<?php

declare(strict_types=1);

namespace OpenReceive\Server;

use OpenReceive\Host;
use OpenReceive\Hosts\AllowAllAuthorize;
use OpenReceive\Hosts\LoggingOnPaid;

/**
 * Step 0 of the agent directions, as report lines. PRESENCE ONLY: no secret is
 * ever printed, echoed or partially shown — every credential line is "set" or
 * "unset", which is what makes the output safe to paste into an issue.
 */
final class Doctor
{
    /**
     * @param array<string, mixed> $env
     * @param (callable(): void)|null $walletCheck builds the Service (and with it the receive-only preflight); a throw is reported, never raised
     * @return list<string>
     */
    public static function report(array $env, ?Host $host = null, ?callable $walletCheck = null, ?string $mountedAt = null): array
    {
        $set = static fn (string $name): string => trim((string) ($env[$name] ?? '')) === '' ? 'unset' : 'set';
        $lines = [
            'openreceive:doctor',
            "  NWC_URI:          {$set('NWC_URI')}",
            "  LSC_URI_PRIMARY:  {$set('LSC_URI_PRIMARY')}",
            "  LSC_URI_BACKUP:   {$set('LSC_URI_BACKUP')}",
        ];
        if ($host === null) {
            $lines[] = '  host:             NOT CONFIGURED — implement OpenReceive\\Host and pass it to the engine';
        } else {
            $lines[] = '  host:             ' . $host::class;
            $lines[] = '  authorize:        ' . (self::usesTrait($host, AllowAllAuthorize::class) ? 'the generated placeholder (allow-all) — replace it' : 'set');
            $lines[] = '  amount_for:       set';
            $lines[] = '  on_paid:          ' . (self::usesTrait($host, LoggingOnPaid::class) ? 'the generated placeholder (logging-only) — replace it' : 'set');
        }
        $lines[] = '  engine mounted:   ' . ($mountedAt === null ? 'unknown — the host mounts Psr15Handler' : "at {$mountedAt}");
        $lines[] = '  wallet preflight: ' . self::walletReport($walletCheck);
        return $lines;
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

    private static function walletReport(?callable $walletCheck): string
    {
        if ($walletCheck === null) {
            return 'skipped — no wallet check was supplied';
        }
        try {
            $walletCheck();
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
