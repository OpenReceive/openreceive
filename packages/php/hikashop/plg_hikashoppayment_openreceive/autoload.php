<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

declare(strict_types=1);

defined('_JEXEC') or die;

// A release archive carries its dependencies prefixed (OpenReceive\HikaShop\
// Vendor\…) inside vendor.phar, so none of them can collide with Joomla's own
// packages or another extension's. A source checkout after `composer install`
// loads the package's plain tree instead. The plugin's own classes
// (OpenReceiveHikaShop\…) live in src/.
require_once is_file(__DIR__ . '/vendor.phar')
    ? 'phar://' . __DIR__ . '/vendor.phar/autoload.php'
    : dirname(__DIR__) . '/vendor/autoload.php';

spl_autoload_register(static function (string $class): void {
    $prefix = 'OpenReceiveHikaShop\\';
    if (strncmp($class, $prefix, strlen($prefix)) === 0) {
        $file = __DIR__ . '/src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
        if (is_file($file)) {
            require_once $file;
        }
    }
});
