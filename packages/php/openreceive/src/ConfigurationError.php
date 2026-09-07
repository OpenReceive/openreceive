<?php

declare(strict_types=1);

namespace OpenReceive;

/** A host wiring problem the engine can name (missing NWC_URI, unmigrated tables, mismatched hooks). */
final class ConfigurationError extends \RuntimeException
{
}
