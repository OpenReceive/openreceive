<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Controller;

use Box\Mod\Openreceive\Support\Endpoint;
use Box\Mod\Openreceive\Support\Runtime;
use Symfony\Component\HttpFoundation\Response;

/**
 * FOSSBilling routes every URL under /openreceive here: the engine's routes
 * under /openreceive/api and the checkout's script and stylesheet under
 * /openreceive/assets.
 */
class Client implements \FOSSBilling\InjectionAwareInterface
{
    protected ?\Pimple\Container $di = null;

    public function setDi(\Pimple\Container $di): void
    {
        $this->di = $di;
        Runtime::setDi($di);
    }

    public function getDi(): ?\Pimple\Container
    {
        return $this->di;
    }

    public function register(\Box_App &$app): void
    {
        $app->get('/openreceive/assets/:file', 'get_asset', ['file' => 'openreceive-checkout\.(?:js|css)'], static::class);
        foreach (['get', 'post', 'put', 'delete'] as $method) {
            $app->{$method}('/openreceive/api/:path', 'api', ['path' => '.*'], static::class);
        }
    }

    public function get_asset(\Box_App $app, string $file): Response
    {
        return Endpoint::asset($file);
    }

    public function api(\Box_App $app, string $path = ''): Response
    {
        return Endpoint::api($app->getRequest(), $path);
    }
}
