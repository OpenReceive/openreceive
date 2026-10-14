<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Support;

use OpenReceive\Support\FileSharedCache;
use PHPUnit\Framework\TestCase;

final class FileSharedCacheTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'openreceive-test-' . bin2hex(random_bytes(6));
        mkdir($this->root, 0700);
    }

    protected function tearDown(): void
    {
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST) as $entry) {
            $entry->isDir() && !$entry->isLink() ? rmdir($entry->getPathname()) : unlink($entry->getPathname());
        }
        rmdir($this->root);
    }

    public function testEntriesOutliveTheInstanceThatWroteThemUntilTheyExpire(): void
    {
        $dir = $this->root . '/cache';
        (new FileSharedCache($dir))->set('openreceive:price_feed', '{"entry":1}', 60);
        $other = new FileSharedCache($dir);
        self::assertSame('{"entry":1}', $other->get('openreceive:price_feed'), 'the next request reads what this one stored');
        self::assertNull($other->get('openreceive:swap_limits:primary'));
        self::assertSame(0700, fileperms($dir) & 0777, 'only this user can open the directory');

        $other->set('openreceive:price_feed', "two\nlines", 60);
        self::assertSame("two\nlines", $other->get('openreceive:price_feed'));
        $other->set('openreceive:price_feed', 'gone', 0);
        self::assertNull($other->get('openreceive:price_feed'), 'an expired entry is a miss');
        self::assertCount(1, glob($dir . '/*') ?: [], 'no partial files are left behind');
    }

    public function testAnUnusableDirectoryIsAMissNotAnError(): void
    {
        $file = $this->root . '/a-file';
        file_put_contents($file, 'x');
        $cache = new FileSharedCache($file . '/cache');
        self::assertNull($cache->get('k'));
        $this->expectException(\RuntimeException::class);
        $cache->set('k', 'v', 60);
    }

    public function testASymlinkedDirectoryIsRefused(): void
    {
        $real = $this->root . '/real';
        mkdir($real, 0700);
        (new FileSharedCache($real))->set('k', 'planted', 60);
        $link = $this->root . '/link';
        symlink($real, $link);
        $cache = new FileSharedCache($link);
        self::assertNull($cache->get('k'), 'a directory someone swapped for a link is not read');
        $this->expectException(\RuntimeException::class);
        $cache->set('k', 'v', 60);
    }

    public function testTheDefaultDirectoryIsPrivateToItsScope(): void
    {
        $a = FileSharedCache::inTempDir('app-a');
        self::assertSame($a->directory(), FileSharedCache::inTempDir('app-a')->directory());
        self::assertNotSame($a->directory(), FileSharedCache::inTempDir('app-b')->directory(), 'another app or code gets its own directory');
        self::assertStringStartsWith(rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'openreceive-', $a->directory());
        self::assertStringNotContainsString('app-a', $a->directory(), 'the scope (it holds the codes) is hashed, never written out');
    }
}
