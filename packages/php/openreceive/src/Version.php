<?php

declare(strict_types=1);

namespace OpenReceive;

/**
 * The engine version, written by `release:prepare` from the root package.json.
 * composer.json carries no version field: Packagist versions from tags.
 */
final class Version
{
    public const VERSION = '0.4.3';
}
