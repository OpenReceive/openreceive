<?php
declare(strict_types=1);
defined('ABSPATH') || exit;

// Release archives only carry the isolated dependency tree. Composer's ordinary
// autoloader is used by the source-level PHP tests, never copied into a release.
require_once is_file(__DIR__ . '/vendor-prefixed/autoload.php')
    ? __DIR__ . '/vendor-prefixed/autoload.php'
    : __DIR__ . '/vendor/autoload.php';
spl_autoload_register(static function (string $class): void {
    $prefix = 'OpenReceive\\WP\\';
    if (str_starts_with($class, $prefix)) {
        $file = __DIR__ . '/src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
        if (is_file($file)) {
            require_once $file;
        }
    }
});
