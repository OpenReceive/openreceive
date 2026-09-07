<?php

declare(strict_types=1);

namespace OpenReceive\Tests\PhpStan;

use PhpParser\Node;
use PhpParser\Node\Expr\BinaryOp\Div;
use PhpParser\Node\Expr\Cast\Double;
use PhpParser\Node\Expr\FuncCall;
use PHPStan\Analyser\Scope;
use PHPStan\Rules\Rule;
use PHPStan\Rules\RuleErrorBuilder;

/**
 * The float ban for the money paths (plan PART 5): no float casts, no
 * float-producing builtins and no `/` division inside src/Money and src/Rates.
 * Amounts are ints and BigDecimal strings there; a float anywhere silently rounds.
 *
 * @implements Rule<Node\Expr>
 */
final class NoFloatsInMoneyRule implements Rule
{
    private const BANNED_FUNCTIONS = ['floatval', 'round', 'fdiv', 'fmod', 'intval'];

    public function getNodeType(): string
    {
        return Node\Expr::class;
    }

    public function processNode(Node $node, Scope $scope): array
    {
        $file = str_replace('\\', '/', $scope->getFile());
        if (!str_contains($file, '/src/Money/') && !str_contains($file, '/src/Rates/')) {
            return [];
        }
        if ($node instanceof Double) {
            return [RuleErrorBuilder::message('Float cast in a money path; use BigDecimal or int.')->identifier('openreceive.noFloatMoney')->build()];
        }
        if ($node instanceof Div) {
            return [RuleErrorBuilder::message('Division operator in a money path; use BigDecimal::dividedBy with a rounding mode or intdiv.')->identifier('openreceive.noFloatMoney')->build()];
        }
        if ($node instanceof FuncCall && $node->name instanceof Node\Name && in_array(strtolower($node->name->toString()), self::BANNED_FUNCTIONS, true)) {
            return [RuleErrorBuilder::message("{$node->name->toString()}() in a money path; use BigDecimal or Integers::parse.")->identifier('openreceive.noFloatMoney')->build()];
        }
        return [];
    }
}
