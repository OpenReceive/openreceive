<?php

declare(strict_types=1);

// A release archive carries its dependencies prefixed (OpenReceive\PrestaShop\
// Vendor\…) inside vendor.phar, so none of them can collide with PrestaShop's
// own packages or another module's. A source checkout after `composer install`
// loads the package's plain tree instead. The module's own classes
// (PrestaShop\Module\OpenReceive\…) live in src/.
require_once is_file(__DIR__ . '/vendor.phar')
    ? 'phar://' . __DIR__ . '/vendor.phar/autoload.php'
    : dirname(__DIR__) . '/vendor/autoload.php';

spl_autoload_register(static function (string $class): void {
    $prefix = 'PrestaShop\\Module\\OpenReceive\\';
    if (strncmp($class, $prefix, strlen($prefix)) === 0) {
        $file = __DIR__ . '/src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
        if (is_file($file)) {
            require_once $file;
        }
    }
});
