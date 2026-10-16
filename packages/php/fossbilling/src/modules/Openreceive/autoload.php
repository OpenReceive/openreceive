<?php

declare(strict_types=1);

// A release archive carries its dependencies prefixed (OpenReceive\FOSSBilling\
// Vendor\…) inside vendor.phar, so none of them can collide with FOSSBilling's
// own packages or another extension's. A source checkout after `composer
// install` loads the plain tree instead. FOSSBilling's own autoloader maps the
// module's classes (Box\Mod\Openreceive\…) to this directory.
require_once is_file(__DIR__ . '/vendor.phar')
    ? 'phar://' . __DIR__ . '/vendor.phar/autoload.php'
    : dirname(__DIR__, 3) . '/vendor/autoload.php';
