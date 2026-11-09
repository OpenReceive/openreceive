<?php

declare(strict_types=1);

// FOSSBilling's own classes do not exist in a source checkout. These stand in
// for the ones the deactivation hook touches, only when the real ones are not
// loaded, and keep to what a FOSSBilling 0.8.0 install has: no extension
// repository (that class arrived in 0.8.5).

namespace Pimple {
    if (!class_exists(Container::class)) {
        class Container implements \ArrayAccess
        {
            /** @var array<string, mixed> */
            private array $values = [];

            public function offsetExists(mixed $offset): bool
            {
                return isset($this->values[$offset]);
            }

            public function offsetGet(mixed $offset): mixed
            {
                return $this->values[$offset];
            }

            public function offsetSet(mixed $offset, mixed $value): void
            {
                $this->values[$offset] = $value;
            }

            public function offsetUnset(mixed $offset): void
            {
                unset($this->values[$offset]);
            }
        }
    }
}

namespace FOSSBilling {
    if (!interface_exists(InjectionAwareInterface::class)) {
        interface InjectionAwareInterface
        {
        }
    }
}

namespace {
    if (!class_exists('Box_Event')) {
        class Box_Event
        {
            /** @param array<string, mixed> $parameters */
            public function __construct(private \Pimple\Container $di, private array $parameters)
            {
            }

            public function getDi(): \Pimple\Container
            {
                return $this->di;
            }

            /** @return array<string, mixed> */
            public function getParameters(): array
            {
                return $this->parameters;
            }
        }
    }
    if (!class_exists('Model_PayGateway')) {
        class Model_PayGateway
        {
            public int $enabled = 1;

            public ?string $config = null;
        }
    }
}

namespace Box\Mod\Openreceive\Tests {
    use Box\Mod\Openreceive\Service;
    use Box\Mod\Openreceive\Support\Runtime;
    use PHPUnit\Framework\TestCase;

    /**
     * Deactivating the module stops offering its gateway. The hook finds out
     * which extension was deactivated with one query that every FOSSBilling
     * 0.8 release can run; `getExtensionRepository()` only exists from 0.8.5,
     * and a hook that throws blocks the admin from deactivating the module.
     */
    final class DeactivationHookTest extends TestCase
    {
        /**
         * The container FOSSBilling hands the hook, with a `dbal` that answers
         * the extension row's name and a gateway row to pause.
         *
         * @return array{0: \Pimple\Container, 1: \Model_PayGateway, 2: object}
         */
        private static function container(string|false $rowName): array
        {
            $gateway = new \Model_PayGateway();
            $dbal = new class ($rowName) {
                /** @var list<array{0: string, 1: array<int, int>}> */
                public array $queries = [];

                public function __construct(private string|false $rowName)
                {
                }

                /** @param array<int, int> $params */
                public function fetchOne(string $sql, array $params): string|false
                {
                    $this->queries[] = [$sql, $params];
                    return $this->rowName;
                }
            };
            $db = new class ($gateway) {
                public int $stored = 0;

                public function __construct(private \Model_PayGateway $gateway)
                {
                }

                public function findOne(string $type, string $where, array $params): \Model_PayGateway
                {
                    return $this->gateway;
                }

                public function store(\Model_PayGateway $bean): void
                {
                    $this->stored++;
                }
            };
            $di = new \Pimple\Container();
            $di['dbal'] = $dbal;
            $di['db'] = $db;
            // As on 0.8.0: the extension service has no getExtensionRepository().
            $di['mod_service'] = static fn (string $name): object => new class {
            };
            return [$di, $gateway, $dbal];
        }

        public function testDeactivatingTheModulePausesTheGatewayOnFossBilling080(): void
        {
            [$di, $gateway, $dbal] = self::container(Runtime::MODULE);

            Service::onBeforeAdminDeactivateExtension(new \Box_Event($di, ['id' => '7']));

            self::assertSame(0, $gateway->enabled, 'the gateway stops being offered');
            self::assertStringContainsString('openreceive_paused', (string) $gateway->config);
            self::assertSame(1, $di['db']->stored);
            self::assertCount(1, $dbal->queries);
            self::assertSame([7], $dbal->queries[0][1], 'the id FOSSBilling names, as an integer');
            self::assertStringContainsString("type = 'mod'", $dbal->queries[0][0]);
        }

        public function testAnotherExtensionsDeactivationLeavesTheGatewayAlone(): void
        {
            [$di, $gateway] = self::container('invoice');

            Service::onBeforeAdminDeactivateExtension(new \Box_Event($di, ['id' => 3]));

            self::assertSame(1, $gateway->enabled);
            self::assertSame(0, $di['db']->stored);
        }

        public function testAnUnknownExtensionRowLeavesTheGatewayAlone(): void
        {
            [$di, $gateway] = self::container(false);

            Service::onBeforeAdminDeactivateExtension(new \Box_Event($di, []));

            self::assertSame(1, $gateway->enabled);
        }
    }
}
