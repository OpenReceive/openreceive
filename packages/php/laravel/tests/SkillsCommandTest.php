<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests;

use Composer\InstalledVersions;
use Illuminate\Filesystem\Filesystem;

final class SkillsCommandTest extends TestCase
{
    public function testInstallsBothSkillsReplacesOldFilesAndPreservesOtherSkills(): void
    {
        $cwd = getcwd();
        $root = sys_get_temp_dir() . '/openreceive-skills-' . bin2hex(random_bytes(4));
        mkdir($root);
        chdir($root);
        try {
            foreach (['.agents/skills', '.claude/skills', $root . '/absolute skills'] as $directory) {
                $target = str_starts_with($directory, '/') ? $directory : $root . '/' . $directory;
                mkdir($target . '/other', 0777, true);
                file_put_contents($target . '/other/SKILL.md', 'keep');
                $options = $directory === '.agents/skills' ? [] : ['--dir' => $directory];
                $this->artisan('openreceive:skills', $options)
                    ->expectsOutputToContain($target . '/integrate-openreceive')
                    ->expectsOutputToContain('--dir .claude/skills')
                    ->assertSuccessful();
                foreach (['integrate-openreceive', 'debug-openreceive-payment'] as $name) {
                    self::assertFileEquals(InstalledVersions::getInstallPath('openreceive/openreceive') . '/skills/' . $name . '/SKILL.md', $target . '/' . $name . '/SKILL.md');
                    file_put_contents($target . '/' . $name . '/obsolete.md', 'old');
                    file_put_contents($target . '/' . $name . '/SKILL.md', 'old');
                }
                $this->artisan('openreceive:skills', $options)->assertSuccessful();
                foreach (['integrate-openreceive', 'debug-openreceive-payment'] as $name) {
                    self::assertFileDoesNotExist($target . '/' . $name . '/obsolete.md');
                    self::assertFileEquals(InstalledVersions::getInstallPath('openreceive/openreceive') . '/skills/' . $name . '/SKILL.md', $target . '/' . $name . '/SKILL.md');
                }
                self::assertFileExists($target . '/integrate-openreceive/references/php.md');
                self::assertSame('keep', file_get_contents($target . '/other/SKILL.md'));
            }
        } finally {
            chdir($cwd);
            (new Filesystem())->deleteDirectory($root);
        }
    }
}
