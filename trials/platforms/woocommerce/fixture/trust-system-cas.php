<?php
/**
 * Plugin Name: Trial CA trust
 * Description: Test setup, not part of the shop. WordPress's HTTP API uses the CA bundle in the container's system store.
 */

// WordPress sends HTTPS requests with the CA bundle it ships and ignores the
// system store. A trial run mounts the system store with the test swap
// provider's private CA added, so the shop reaches the trial wallet's swap
// provider the way every other trial does. Outside a trial the system store
// is the image's own.
defined('ABSPATH') || exit;

add_filter('http_request_args', static function (array $args): array {
    $bundle = '/etc/ssl/certs/ca-certificates.crt';
    if (is_readable($bundle)) {
        $args['sslcertificates'] = $bundle;
    }
    return $args;
});
