<?php

declare(strict_types=1);

namespace OpenReceive\Support;

/**
 * A SharedCache in files, one per key, in a directory only this user can
 * open. It is the default `Service::fromEnvironment()` uses under a web
 * server, so a plain PHP app with no cache of its own still keeps the market
 * data and the wallet's capability list between requests.
 *
 * Each file holds its expiry and the value and is replaced by a rename, so a
 * reader never sees half a write. Every failure (no temp dir, open_basedir, a
 * read-only disk) is a miss: the engine then fetches as if there were no
 * cache.
 */
final class FileSharedCache implements SharedCache
{
    public function __construct(private readonly string $directory)
    {
    }

    /**
     * The default directory: under the system temp dir, named from `$scope`
     * and this process's user. `fromEnvironment()` derives `$scope` from the
     * connection codes, so another account on a shared host cannot guess the
     * name and create the directory first; one it did create anyway is
     * refused because it is not ours. A new code gets a new directory.
     */
    public static function inTempDir(string $scope): self
    {
        $user = function_exists('posix_geteuid') ? (string) posix_geteuid() : get_current_user();
        $name = 'openreceive-' . substr(hash('sha256', $scope . "\0" . $user), 0, 32);
        return new self(rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . $name);
    }

    public function directory(): string
    {
        return $this->directory;
    }

    public function get(string $key): ?string
    {
        if (!$this->ours()) {
            return null;
        }
        $raw = @file_get_contents($this->path($key));
        if (!is_string($raw)) {
            return null;
        }
        $newline = strpos($raw, "\n");
        if ($newline === false || (int) substr($raw, 0, $newline) <= time()) {
            return null;
        }
        return substr($raw, $newline + 1);
    }

    public function set(string $key, string $value, int $ttlSeconds): void
    {
        if (!@is_dir($this->directory) && !@mkdir($this->directory, 0700) && !@is_dir($this->directory)) {
            throw new \RuntimeException('The OpenReceive cache directory could not be created.');
        }
        if (!$this->ours()) {
            throw new \RuntimeException('The OpenReceive cache directory belongs to another user.');
        }
        $path = $this->path($key);
        $partial = $path . '.' . bin2hex(random_bytes(6)) . '.tmp';
        if (@file_put_contents($partial, (time() + $ttlSeconds) . "\n" . $value) === false || !@rename($partial, $path)) {
            @unlink($partial);
            throw new \RuntimeException('An OpenReceive cache entry could not be written.');
        }
    }

    private function ours(): bool
    {
        if (!@is_dir($this->directory) || @is_link($this->directory)) {
            return false;
        }
        return !function_exists('posix_geteuid') || @fileowner($this->directory) === posix_geteuid();
    }

    private function path(string $key): string
    {
        return $this->directory . DIRECTORY_SEPARATOR . hash('sha256', $key);
    }
}
