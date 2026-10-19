/** One assistant or merchant message, plus the tool calls that happened on that turn. */
export interface Turn {
  readonly role: "agent" | "merchant";
  readonly text: string;
  /** The agent's last message of the turn, the one the merchant reads last. */
  readonly last?: string;
  readonly tools?: readonly ToolEvent[];
}

export type ToolEvent =
  | {
      readonly type: "shell";
      readonly command: string;
      /** Absent when the stream carried no result (a background command). */
      readonly exitCode?: number;
      /** The tail of stderr then stdout. */
      readonly output?: string;
    }
  | { readonly type: "write"; readonly path: string; readonly tracked: boolean }
  | { readonly type: "fetch"; readonly url: string; readonly status?: number };

export type Intent =
  | "nwc"
  | "lsc"
  | "lsc_backup"
  | "bitcoin_choice"
  | "delegate"
  | "done"
  | "other";

export interface Scenario {
  readonly id: string;
  /** `{{name}}` and `{{directions_url}}` are filled from the platform and the run. */
  readonly prompt: string;
  /** When true, the merchant wants USDT, USDC, SOL, and ETH as well as Bitcoin. */
  readonly swaps: boolean;
  readonly choice: string;
}

export interface Platform {
  readonly slug: string;
  readonly name: string;
  readonly directions: string;
  readonly prompt_name: string;
  readonly doctor: string;
  /**
   * Where the codes live. `platform` means the hosting platform already holds
   * them as project environment variables (v0, Vercel), so the agent must not
   * ask for them and the merchant never pastes one.
   */
  readonly credential_store: { readonly kind: string; readonly where: string };
  /** The directions file to follow when the platform reuses another stack's. */
  readonly directions_slug?: string;
  /** The merchant's first message; `{{directions_url}}` is filled in. */
  readonly opening?: string;
  /**
   * Or: the platform-prompt block of this guide, the prompt openreceive.org
   * tells people to paste, after `opening_context`. A served or explicit
   * directions URL replaces the published one in it.
   */
  readonly opening_guide?: string;
  readonly opening_context?: string;
  /** Variables the platform gives the shop's web service, before any code. */
  readonly platform_env?: Readonly<Record<string, string>>;
  /**
   * The service that gets `platform_env` and, on a platform that holds them,
   * the codes. `service` when omitted; Bolt's go to its server functions.
   */
  readonly platform_env_service?: string;
  /**
   * After the agent finishes, deploy the shop and check it live: `vercel`
   * deploys to the `openreceive-eval` project on Vercel; `local` plays a Replit publish on
   * this machine (an empty production database, a rebuild and a restart).
   */
  readonly deploy?: "vercel" | "local";
  /**
   * Compose commands run after the agent finishes and before the live checks,
   * as the platform would: Lovable applies the migrations the agent wrote when
   * the user approves them, then serves the new build.
   */
  readonly before_live?: readonly (readonly string[])[];
  /**
   * The repo-root .env variable holding a real Supabase project's transaction
   * pooler URL. The shop's server gets it as DATABASE_URL, with Supabase's CA
   * as SUPABASE_CA_CERT. The harness empties the project's public schema
   * before each run, so runs go one at a time; it keeps the password out of
   * every report, and after the run it checks OpenReceive's tables are closed
   * to Supabase's Data API (supabase.ts).
   */
  readonly supabase_project?: string;
  /**
   * After the agent finishes, check the running shop on this machine: the
   * shop's own order form makes an order, its buyer gets a real Lightning
   * invoice, and another visitor asking for that order is refused.
   */
  readonly live?: boolean;
  /**
   * Compose arguments that print the shop's recent errors, added to a failed
   * live check. `logs --tail 40 <service>` when omitted.
   */
  readonly logs?: readonly string[];
  /** Services that run OpenReceive and so reach the trial wallet. `service` when omitted. */
  readonly wallet_services?: readonly string[];
  /**
   * `test` (the default) gives the shop the trial wallet's test swap provider;
   * `live` the repo-root .env's LSC_URI_PRIMARY, for a shop that cannot reach
   * or trust the test provider. No platform needs it today: WooCommerce's
   * fixture points WordPress's HTTP API at the system CA store
   * (trust-system-cas.php). The NWC code is the trial wallet's either way.
   */
  readonly swap_provider?: "test" | "live";
  /** The most lines the closing message may have. 5 when omitted. */
  readonly closing_max_lines?: number;
  readonly allowed_install_paths: readonly string[];
  readonly forbidden: readonly string[];
  readonly max_turns: number;
  readonly max_minutes: number;
  /** WordPress and BTCPay each need a database server. At most two of these run at once. */
  readonly heavy: boolean;
  /**
   * A server product rather than an app. `btcpay`: a BTCPay Server that
   * btcpay.ts sets up, inspects and checks through Greenfield, whose merchant
   * installs the plugin when asked, and which shares the trial chain's node.
   * `bolt`: a Vite React app whose payment routes are a Supabase Edge
   * Function on another site; bolt.ts buys through the page in Chromium and
   * calls the function with the buyer's token.
   * `paymenter`: a Paymenter billing panel that paymenter.ts seeds with its
   * owner, two clients and five products; the client orders through
   * Paymenter's shop and pays from the invoice's payment dialog in Chromium.
   * `fossbilling`: a FOSSBilling billing panel that fossbilling.ts installs
   * and seeds with two clients and five products; the client orders through
   * FOSSBilling's shop and pays on its payment page in Chromium.
   * `prestashop`: a PrestaShop store that prestashop.ts installs and seeds
   * with two customers and five products; the customer checks out in
   * PrestaShop's shop and pays on its order confirmation page in Chromium.
   */
  readonly host?: "btcpay" | "bolt" | "paymenter" | "fossbilling" | "prestashop";
  /** The WordPress post type the five seeded products are: WooCommerce's `product` when omitted, `download` for Easy Digital Downloads. */
  readonly wordpress_post_type?: string;
  /** Compose service that publishes the shop. WordPress when omitted. */
  readonly service?: string;
  /** Port inside that service. 80 when omitted. */
  readonly container_port?: number;
  /** Run the platform seed script after the stack is up. WordPress does; Node boots seeded. */
  readonly seed?: boolean;
  /** Commands that print the product count and whether OpenReceive is installed. Node scripts when omitted. */
  readonly probes?: {
    readonly products: readonly string[];
    readonly openreceive: readonly string[];
    /** Prints an order's status column, given its id. */
    readonly orderStatus?: readonly string[];
  };
}

export type Severity = "blocker" | "polish";

export interface Check {
  readonly id: string;
  readonly severity: Severity;
  readonly pass: boolean;
  readonly summary: string;
  readonly evidence?: string;
}

export interface RunInput {
  readonly scenario: Scenario;
  readonly platform: Platform;
  readonly turns: readonly Turn[];
  readonly nwc: string;
  readonly lsc: string;
  readonly lscBackup?: string;
}
