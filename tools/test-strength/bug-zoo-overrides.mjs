// Hand-made undos for the bug zoo (tools/test-strength/bug-zoo.mjs).
//
// When a fix no longer reverse-applies at HEAD (later commits moved the same
// lines) but is still recognizable, an entry here undoes it by hand. Keyed by
// commit SHA prefix; each file maps to the edits that restore the bug
// ([{ find, replace, count? }]), to "keep" to leave that file as it is at HEAD
// (a piece of the commit that is not the behaviour under test), to "auto" to
// reverse that file as the tool normally would, or to { ours: true, edits? } to
// reverse every hunk that still reverses, keep HEAD for the hunks later commits
// rewrote, then apply `edits`. Every `find` must occur exactly `count` times
// (default 1), so a stale override fails loudly instead of silently undoing
// nothing. Edits apply to the file as it stands at HEAD. The `note` says what
// the entry is standing in for. An override keeps a name a test imports where a
// plain revert would only produce an import error (a [load-only] catch).
//
// VARIANTS are extra rows for a commit that made several separate fixes: each
// part is undone alone so a commit-level catch cannot hide an untested part.
//
// OUT_OF_SCOPE lists path patterns; a commit touching any of them is left out
// and reported as out of scope instead of being guessed at.

export const OUT_OF_SCOPE = [
  {
    pattern: /WalletSuggestions/,
    reason: "WalletSuggestions is still changing in a separate session",
  },
];

export const OVERRIDES = {
  82557573: {
    note: "createRetryingBoot replaced the promise the fix guarded; undo by dropping the handler that keeps a failed boot from going unhandled",
    files: {
      "packages/js/http/src/stack.ts": [{ find: "  ready.catch(() => {});\n", replace: "" }],
    },
  },
  61827060: {
    note: "a later comment rewrite touched the doctor's POST probe and later wiring-guide edits touched the claim snippet; their hunks stay at HEAD, the probe's call site reverses",
    files: {
      "packages/js/node/src/cli.ts": { ours: true },
      "packages/js/node/src/scaffold/wiring-guide.ts": { ours: true },
    },
  },
  a04eb783: {
    note: "a later commit added retryable to the same throw; undo by never treating a relay outage as unreachable",
    files: {
      "packages/js/node/src/service.ts": [
        {
          find: "const unreachable = unreachableWalletError(cause);",
          replace: "const unreachable = undefined as OpenReceiveError | undefined;",
        },
      ],
    },
  },
  f12966ec: {
    note: "undo the retry by making a failed boot permanent again; createRetryingBoot stays as the seam the tests call",
    files: {
      "packages/js/http/src/stack.ts": [
        {
          find: "        options.retries &&\n        !stopped &&",
          replace: "        false &&\n        options.retries &&\n        !stopped &&",
        },
      ],
    },
  },
  a694974f: {
    note: "the only hunks later commits rewrote are doc comments, so they stay at HEAD",
    files: {
      "packages/js/express/src/index.ts": { ours: true },
      "packages/js/next/src/index.ts": { ours: true },
      "packages/js/http/src/stack.ts": { ours: true },
    },
  },
  c09ef75c: {
    note: "the swap, boot-page and debug-filter names stay so tests still import; their behaviour is undone (a later commit also added constants beside them)",
    files: {
      "packages/python/openreceive/src/openreceive/server/service.py": [
        {
          find: "        except Exception as error:\n            failure = classify_transport_failure(error)",
          replace:
            "        except Exception as error:\n            raise\n            failure = classify_transport_failure(error)",
        },
      ],
      "packages/python/openreceive/src/openreceive/django/views.py": [
        {
          find: "    except (ConfigurationError, NwcUriParseError) as error:\n        return _render(_boot_failure(error))",
          replace: "    except (ConfigurationError, NwcUriParseError):\n        raise",
        },
      ],
      "packages/python/openreceive/src/openreceive/django/debug.py": "keep",
      "packages/python/openreceive/src/openreceive/swap/fixedfloat.py": "keep",
      "packages/python/openreceive/src/openreceive/swap/__init__.py": "keep",
      "packages/ruby/openreceive-server/lib/openreceive/server/service.rb": { ours: true },
    },
  },
  63661868: {
    note: "keep the module names the tests import; undo the relay-down deferral itself: an unreachable wallet refuses the start again",
    files: {
      "packages/python/openreceive/src/openreceive/server/service.py": [
        {
          find: "            if wallet_unreachable(error):\n                raise _WalletUnreachable(_one_line_failure(error)) from error\n            raise WalletPreflightError(",
          replace: "            raise WalletPreflightError(",
        },
      ],
    },
  },
  "9b131dc8": {
    note: "the skills check stays (the unit test calls it); the doctor's report goes back to the fixed line",
    files: {
      "packages/php/openreceive/src/Server/Doctor.php": [
        {
          find: "$lines[] = self::agentSkillsLine((string) getcwd(), ($env['HOME'] ?? null) ?: (getenv('HOME') ?: null));",
          replace:
            "$lines[] = 'Agent skills: run `npx skills add OpenReceive/openreceive` in your project';",
        },
      ],
    },
  },
  "4aee6620": {
    note: "10f5bc42 grew payerErrorMessage over this commit; hunks that no longer reverse stay at HEAD and the wallet-words behaviour is undone by hand",
    files: {
      "packages/js/browser/src/headless.ts": { ours: true },
      "packages/js/browser/src/internal/labels.ts": { ours: true },
      "packages/js/elements/src/element-checkout-session.ts": { ours: true },
      "packages/js/react/src/checkout.ts": { ours: true },
      "packages/js/browser/src/internal/checkout-session.ts": {
        ours: true,
        edits: [
          {
            find: '    errorCode === "UNAVAILABLE"\n  ) {\n    return checkoutLabels.paymentServiceUnavailable;\n  }',
            replace:
              '    errorCode === "UNAVAILABLE"\n  ) {\n    return message.length > 0 ? message : fallback;\n  }',
          },
        ],
      },
    },
  },
};

// Commits that made several separate fixes: each named part is undone alone, so
// a commit-level catch cannot hide a part with no test. Only hand edits apply.
export const VARIANTS = [
  {
    commit: "c09ef75c",
    label: "swap-sentences",
    engine: "python",
    note: "a provider failure reaches the payer as the opaque 500 again",
    files: {
      "packages/python/openreceive/src/openreceive/server/service.py": [
        {
          find: "        except Exception as error:\n            failure = classify_transport_failure(error)",
          replace:
            "        except Exception as error:\n            raise\n            failure = classify_transport_failure(error)",
        },
      ],
    },
  },
  {
    commit: "c09ef75c",
    label: "django-boot-503",
    engine: "python",
    note: "a stack that cannot start answers Django's HTML 500 again",
    files: {
      "packages/python/openreceive/src/openreceive/django/views.py": [
        {
          find: "    except (ConfigurationError, NwcUriParseError) as error:\n        return _render(_boot_failure(error))",
          replace: "    except (ConfigurationError, NwcUriParseError):\n        raise",
        },
      ],
    },
  },
  {
    commit: "c09ef75c",
    label: "django-debug-filter",
    engine: "python",
    note: "the app no longer installs the filter that hides NWC_URI and LSC_URI_* on the DEBUG page",
    files: {
      "packages/python/openreceive/src/openreceive/django/debug.py": [
        {
          find: "    setattr(settings, SETTING, FILTER_PATH)\n",
          replace: "    return False\n    setattr(settings, SETTING, FILTER_PATH)\n",
        },
      ],
    },
  },
  {
    commit: "f12966ec",
    label: "failed-boot-closes-client",
    engine: "js",
    note: "a failed boot leaves the client it built open, one relay socket per retry",
    files: { "packages/js/node/src/service.ts": "auto" },
  },
  {
    commit: "b4ad712b",
    label: "element-paid-label",
    engine: "js",
    note: "the element prints the engine's word (settled) again",
    files: { "packages/js/elements/src/render-checkout.ts": "auto" },
  },
  {
    commit: "10f5bc42",
    label: "element-prepare-log",
    engine: "js",
    note: "a refused prepare in the element loses the developer's copy of the text",
    files: { "packages/js/elements/src/element-checkout-session.ts": "auto" },
  },
  {
    commit: "691375a0",
    label: "woocommerce-gateway",
    engine: "php",
    note: "WooCommerce's is_available builds the engine again; the shared helper keeps its unit tests",
    files: { "packages/php/wordpress/src/Gateway.php": "auto" },
  },
  {
    commit: "2daa5167",
    label: "edd-save-notice",
    engine: "php",
    note: "EDD's settings error goes back to its own unescaped text",
    files: { "packages/php/wordpress/src/EddGateway.php": "auto" },
  },
  {
    commit: "2daa5167",
    label: "woo-save-notice",
    engine: "php",
    note: "WooCommerce's settings error blames the codes again whatever happened",
    files: { "packages/php/wordpress/src/Gateway.php": "auto" },
  },
  {
    commit: "4aee6620",
    label: "wallet-words",
    engine: "js",
    note: "a wallet outage shows the operator's text to the payer again",
    files: {
      "packages/js/browser/src/internal/checkout-session.ts": [
        {
          find: '    errorCode === "UNAVAILABLE"\n  ) {\n    return checkoutLabels.paymentServiceUnavailable;\n  }',
          replace:
            '    errorCode === "UNAVAILABLE"\n  ) {\n    return message.length > 0 ? message : fallback;\n  }',
        },
      ],
    },
  },
  {
    commit: "4aee6620",
    label: "total-host-amount",
    engine: "js",
    note: "the Total row shows the provider's rounding of the payout, not the host's amount",
    files: {
      "packages/js/browser/src/internal/checkout-swap-view.ts": [
        {
          find: "total?.currency === fee.currency && total.value !== undefined",
          // Still a boolean, so the package's type-checking build goes through.
          replace:
            "total?.currency === fee.currency && total.value !== undefined && Date.now() < 0",
        },
      ],
    },
  },
  {
    commit: "4aee6620",
    label: "total-label",
    engine: "js",
    note: "the breakdown row reads Cart total again",
    files: {
      "packages/js/browser/src/internal/labels.ts": [
        { find: 'cartTotal: "Total",', replace: 'cartTotal: "Cart total",' },
      ],
    },
  },
  {
    commit: "4aee6620",
    label: "settled-thanks",
    engine: "js",
    note: "the settled panel reads the backend note again",
    files: {
      "packages/js/browser/src/internal/labels.ts": [
        {
          find: 'settledDetail: "Thank you. Your payment is confirmed.",',
          replace: 'settledDetail: "Backend settlement verified.",',
        },
      ],
    },
  },
  {
    commit: "4aee6620",
    label: "mint-retry-element",
    engine: "js",
    note: "a failed Lightning mint shows bare text with no Try again in the element",
    files: {
      "packages/js/elements/src/render-wizard.ts": [
        {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: source text, matched literally
          find: '                <button\n                  part="wizard-retry"\n                  class="${orClasses.btn}"\n                  type="button"\n                  ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.method}="bitcoin"\n                >${escapeHtml(checkoutLabels.tryAgain)}</button>\n',
          replace: "",
        },
      ],
    },
  },
  {
    commit: "4aee6620",
    label: "mint-retry-react",
    engine: "js",
    note: "a failed Lightning mint shows nothing in React",
    files: {
      "packages/js/react/src/wizard.ts": [
        {
          find: "    props.lightningMintError === undefined\n      ? null",
          replace: "    (props.lightningMintError === undefined || Date.now() > 0)\n      ? null",
        },
      ],
    },
  },
];
