<?php

declare(strict_types=1);

use PrestaShop\Module\OpenReceive\Endpoint;

if (!defined('_PS_VERSION_')) {
    exit;
}

/**
 * The checkout's routes: /module/openreceive/api?path=/checkouts and the
 * rest, or index.php?fc=module&module=openreceive&controller=api&path=… with
 * friendly URLs off. Every answer is the engine's JSON.
 */
class OpenReceiveApiModuleFrontController extends ModuleFrontController
{
    /** @var bool */
    public $content_only = true;

    public function init(): void
    {
        parent::init();
        // PrestaShop sets this from the request's Accept header when it builds
        // the controller; every answer here is the engine's JSON.
        $this->ajax = true;
    }

    public function displayAjax(): void
    {
        $answer = Endpoint::handle(
            strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')),
            (string) Tools::getValue('path'),
            function_exists('getallheaders') ? (getallheaders() ?: []) : [],
            (string) file_get_contents('php://input'),
            $_SERVER,
        );
        // Anything PrestaShop changed in its cookie goes out before the body.
        $this->context->cookie->write();
        http_response_code($answer['status']);
        foreach ($answer['headers'] as $name => $values) {
            header($name . ': ' . implode(', ', $values));
        }
        echo $answer['body'];
    }
}
