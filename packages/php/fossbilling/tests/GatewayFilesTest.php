<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Tests;

use Box\Mod\Openreceive\Support\GatewayFiles;
use PHPUnit\Framework\TestCase;

/**
 * The module writes its payment gateway into FOSSBilling's library folder on
 * activation, because the extension directory installs the module alone.
 */
final class GatewayFilesTest extends TestCase
{
    private string $library;

    private string $module;

    protected function setUp(): void
    {
        $this->library = sys_get_temp_dir() . '/openreceive-gateway-' . bin2hex(random_bytes(6));
        mkdir($this->library . '/Payment/Adapter', 0o755, true);
        $this->module = dirname(__DIR__) . '/src/modules/Openreceive';
    }

    protected function tearDown(): void
    {
        $adapter = $this->library . '/Payment/Adapter';
        @chmod($adapter, 0o755);
        foreach (glob($adapter . '/OpenReceive/{,.}*', GLOB_BRACE) ?: [] as $file) {
            if (is_file($file)) {
                unlink($file);
            }
        }
        @rmdir($adapter . '/OpenReceive');
        @rmdir($adapter);
        @rmdir($this->library . '/Payment');
        @rmdir($this->library);
    }

    public function testActivationWritesTheGatewayOnceAndLeavesACurrentCopyAlone(): void
    {
        self::assertSame(GatewayFiles::MISSING, GatewayFiles::status($this->library));
        self::assertSame(GatewayFiles::MISSING, GatewayFiles::install($this->library));

        $directory = GatewayFiles::directory($this->library);
        self::assertFileEquals($this->module . '/Gateway/OpenReceive.php', $directory . '/OpenReceive.php');
        self::assertFileEquals($this->module . '/icon.svg', $directory . '/logo.svg');
        self::assertSame(['OpenReceive.php', 'logo.svg'], $this->installedNames());

        self::assertSame(GatewayFiles::CURRENT, GatewayFiles::install($this->library));
        self::assertSame(GatewayFiles::CURRENT, GatewayFiles::status($this->library));
    }

    public function testAnOlderOpenReceiveGatewayIsReplaced(): void
    {
        $directory = GatewayFiles::directory($this->library);
        mkdir($directory);
        file_put_contents($directory . '/OpenReceive.php', "<?php\n\nclass Payment_Adapter_OpenReceive\n{\n}\n");

        self::assertSame(GatewayFiles::OUTDATED, GatewayFiles::status($this->library));
        self::assertSame(GatewayFiles::OUTDATED, GatewayFiles::install($this->library));
        self::assertFileEquals($this->module . '/Gateway/OpenReceive.php', $directory . '/OpenReceive.php');
        self::assertSame(GatewayFiles::CURRENT, GatewayFiles::status($this->library));
    }

    public function testAMissingLogoIsWrittenAgain(): void
    {
        GatewayFiles::install($this->library);
        unlink(GatewayFiles::directory($this->library) . '/logo.svg');

        self::assertSame(GatewayFiles::OUTDATED, GatewayFiles::install($this->library));
        self::assertSame(GatewayFiles::CURRENT, GatewayFiles::status($this->library));
    }

    public function testAnotherGatewayInTheFolderIsNeverOverwritten(): void
    {
        $directory = GatewayFiles::directory($this->library);
        mkdir($directory);
        $foreign = "<?php\n\n// Someone else's file.\n";
        file_put_contents($directory . '/OpenReceive.php', $foreign);

        self::assertSame(GatewayFiles::FOREIGN, GatewayFiles::status($this->library));
        try {
            GatewayFiles::install($this->library);
            self::fail('A foreign gateway file was overwritten.');
        } catch (\RuntimeException $error) {
            self::assertStringContainsString('left it alone', $error->getMessage());
        }
        self::assertSame($foreign, file_get_contents($directory . '/OpenReceive.php'));
        self::assertSame(['OpenReceive.php'], $this->installedNames());
    }

    public function testAnUnwritableLibraryFailsWithWhatToDo(): void
    {
        if (function_exists('posix_geteuid') && posix_geteuid() === 0) {
            self::markTestSkipped('root writes to any folder.');
        }
        chmod($this->library . '/Payment/Adapter', 0o555);

        try {
            GatewayFiles::install($this->library);
            self::fail('An unwritable library folder was reported as written.');
        } catch (\RuntimeException $error) {
            self::assertStringContainsString('write to library/Payment/Adapter', $error->getMessage());
        }
        self::assertSame(GatewayFiles::MISSING, GatewayFiles::status($this->library));
    }

    /** @return list<string> */
    private function installedNames(): array
    {
        $names = array_values(array_diff(scandir(GatewayFiles::directory($this->library)) ?: [], ['.', '..']));
        sort($names);
        return $names;
    }
}
