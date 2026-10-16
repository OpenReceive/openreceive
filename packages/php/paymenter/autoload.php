<?php

declare(strict_types=1);

// A release archive carries its dependencies prefixed (OpenReceive\Paymenter\
// Vendor\…) inside vendor.phar, so none of them can collide with Paymenter's
// own packages or another extension's, and Paymenter's Composer never scans
// them. A source checkout after `composer install` loads the plain tree
// instead. Paymenter's Composer autoloader already maps this extension's own
// classes (Paymenter\Extensions\Gateways\OpenReceive\…) to this directory.
require_once is_file(__DIR__ . '/vendor.phar')
    ? 'phar://' . __DIR__ . '/vendor.phar/autoload.php'
    : __DIR__ . '/vendor/autoload.php';
