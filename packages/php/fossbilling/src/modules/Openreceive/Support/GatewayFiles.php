<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Support;

/**
 * FOSSBilling loads a payment gateway from library/Payment/Adapter, outside
 * every module's folder, while its extension directory installs a module into
 * modules/Openreceive alone. So the module carries its gateway (Gateway/ and
 * its icon) and writes it into library/Payment/Adapter/OpenReceive each time
 * it is activated. A file there that differs is replaced only when it is
 * OpenReceive's own gateway from another version; anything else stops the
 * activation instead of being overwritten.
 */
final class GatewayFiles
{
    public const CURRENT = 'current';

    public const MISSING = 'missing';

    /** OpenReceive's gateway from another version, or with a file missing. */
    public const OUTDATED = 'outdated';

    /** A file that is not OpenReceive's gateway. */
    public const FOREIGN = 'foreign';

    /** Each installed file, and the module's copy of it. */
    private const FILES = ['OpenReceive.php' => 'Gateway/OpenReceive.php', 'logo.svg' => 'icon.svg'];

    private const DECLARATION = 'class Payment_Adapter_OpenReceive';

    /** library/Payment/Adapter/OpenReceive, under FOSSBilling's library folder. */
    public static function directory(?string $library = null): string
    {
        return ($library ?? PATH_LIBRARY) . '/Payment/Adapter/' . Runtime::GATEWAY;
    }

    public static function status(?string $library = null): string
    {
        $directory = self::directory($library);
        $adapter = $directory . '/OpenReceive.php';
        if (!is_file($adapter)) {
            return self::MISSING;
        }
        if (!str_contains((string) file_get_contents($adapter), self::DECLARATION)) {
            return self::FOREIGN;
        }
        foreach (self::FILES as $name => $source) {
            $installed = $directory . '/' . $name;
            if (!is_file($installed) || hash_file('sha256', $installed) !== hash_file('sha256', self::source($source))) {
                return self::OUTDATED;
            }
        }
        return self::CURRENT;
    }

    /**
     * Writes the gateway's files when they are missing or OpenReceive's own
     * from another version. Returns the status it found.
     *
     * @throws \RuntimeException when the folder holds another gateway, or FOSSBilling's web user cannot write it
     */
    public static function install(?string $library = null): string
    {
        $status = self::status($library);
        if ($status === self::CURRENT) {
            return $status;
        }
        $directory = self::directory($library);
        $shown = 'library/Payment/Adapter/' . Runtime::GATEWAY;
        if ($status === self::FOREIGN) {
            throw new \RuntimeException("{$shown}/OpenReceive.php is not OpenReceive's payment gateway, so OpenReceive left it alone. Move that folder elsewhere, then activate OpenReceive again.");
        }
        if (!is_dir($directory) && !@mkdir($directory, 0o755, true) && !is_dir($directory)) {
            throw new \RuntimeException("OpenReceive could not create {$shown}. Let the web server's user write to library/Payment/Adapter, then activate OpenReceive again.");
        }
        foreach (self::FILES as $name => $source) {
            $target = $directory . '/' . $name;
            // Each file is replaced whole, so a request never loads half of one.
            $temporary = $target . '.' . bin2hex(random_bytes(6)) . '.tmp';
            if (!@copy(self::source($source), $temporary) || !@rename($temporary, $target)) {
                @unlink($temporary);
                throw new \RuntimeException("OpenReceive could not write {$shown}/{$name}. Let the web server's user write to {$shown}, then activate OpenReceive again.");
            }
        }
        return $status;
    }

    private static function source(string $name): string
    {
        return dirname(__DIR__) . '/' . $name;
    }
}
