<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Api;

use Box\Mod\Openreceive\Support\Runtime;

/**
 * The settings page's two calls. A code is never sent back: the page shows
 * only whether each one is set.
 */
class Admin extends \FOSSBilling\Api\AbstractApi
{
    /** @return array<string, mixed> */
    public function status($data): array
    {
        $this->checkPermissions('openreceive', 'manage_settings');
        Runtime::setDi($this->getDi());
        $env = Runtime::environment();
        $gateway = Runtime::gateway();
        return [
            'nwc_uri_set' => $env['NWC_URI'] !== '',
            'lsc_uri_primary_set' => $env['LSC_URI_PRIMARY'] !== '',
            'gateway_name' => $gateway?->name,
            'gateway_enabled' => (bool) ($gateway?->enabled),
        ];
    }

    /** Saves the codes entered; a blank field keeps the saved code. */
    public function save($data): bool
    {
        $this->checkPermissions('openreceive', 'manage_settings');
        Runtime::setDi($this->getDi());
        $codes = [];
        foreach (array_keys(Runtime::SECRET_KEYS) as $key) {
            if (isset($data[$key]) && is_string($data[$key])) {
                $codes[$key] = $data[$key];
            }
        }
        try {
            Runtime::saveCodes($codes, isset($data['name']) && is_string($data['name']) ? $data['name'] : null);
        } catch (\Throwable $error) {
            throw new \FOSSBilling\InformationException('Nothing was saved: :reason', [':reason' => Runtime::errorMessage($error)]);
        }
        return true;
    }
}
