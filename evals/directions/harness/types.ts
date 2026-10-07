/** One assistant or merchant message, plus the tool calls that happened on that turn. */
export interface Turn {
  readonly role: "agent" | "merchant";
  readonly text: string;
  readonly tools?: readonly ToolEvent[];
}

export type ToolEvent =
  | { readonly type: "shell"; readonly command: string }
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
  readonly credential_store: { readonly kind: string; readonly where: string };
  readonly allowed_install_paths: readonly string[];
  readonly forbidden: readonly string[];
  readonly max_turns: number;
  readonly max_minutes: number;
  /** WordPress and BTCPay each need a database server. At most two of these run at once. */
  readonly heavy: boolean;
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
