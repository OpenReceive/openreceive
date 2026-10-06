<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Console;

use Composer\InstalledVersions;
use Illuminate\Console\Command;
use Illuminate\Filesystem\Filesystem;

final class SkillsCommand extends Command
{
    protected $signature = 'openreceive:skills {--dir=.agents/skills : Destination relative to the current directory}';

    protected $description = 'Install the bundled OpenReceive agent skills into this project';

    public function handle(): int
    {
        $source = InstalledVersions::getInstallPath('openreceive/openreceive') . '/skills';
        $directory = $this->option('dir');
        if (!is_string($directory) || $directory === '') {
            $this->error('--dir needs a path.');
            return self::FAILURE;
        }
        $target = str_starts_with($directory, '/') ? $directory : getcwd() . '/' . $directory;
        $names = ['integrate-openreceive', 'debug-openreceive-payment'];
        $files = new Filesystem();
        foreach ($names as $name) {
            if (!is_file($source . '/' . $name . '/SKILL.md')) {
                $this->error("Bundled skill missing: {$name}. Reinstall openreceive/openreceive.");
                return self::FAILURE;
            }
        }
        $files->ensureDirectoryExists($target);
        $target = (string) realpath($target);
        $source = (string) realpath($source);
        if ($target === $source || str_starts_with($target, $source . '/')) {
            $this->error("Choose a skills directory outside the installed package's bundle.");
            return self::FAILURE;
        }
        foreach ($names as $name) {
            $destination = $target . '/' . $name;
            if (is_link($destination) || is_file($destination)) {
                if (!$files->delete($destination)) {
                    $this->error("Could not replace {$destination}");
                    return self::FAILURE;
                }
            } elseif (is_dir($destination) && !$files->deleteDirectory($destination)) {
                $this->error("Could not replace {$destination}");
                return self::FAILURE;
            }
            if (!$files->copyDirectory($source . '/' . $name, $destination)) {
                $this->error("Could not write {$destination}");
                return self::FAILURE;
            }
            $this->line("Wrote {$destination}");
        }
        $this->line('For Claude Code: php artisan openreceive:skills --dir .claude/skills');
        return self::SUCCESS;
    }
}
