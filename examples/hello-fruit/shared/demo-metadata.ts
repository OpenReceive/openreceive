export type HelloFruitDemoId =
  | "node-express-react"
  | "static-html-small-api";

export type HelloFruitDemoMode =
  | "unconfigured"
  | "test_nwc"
  | "production";

export interface HelloFruitDemoMetadata {
  readonly demo: {
    readonly id: HelloFruitDemoId;
    readonly product: "hello-fruit";
  };
  readonly mode: HelloFruitDemoMode;
  readonly build: {
    readonly git_sha: string | null;
    readonly image_digest: string | null;
  };
  readonly packages: Readonly<Record<string, string>>;
}

export interface HelloFruitDemoMetadataInput {
  readonly id: HelloFruitDemoId;
  readonly walletConfigured: boolean;
  readonly requestedMode?: string | undefined;
  readonly gitSha?: string | undefined;
  readonly imageDigest?: string | undefined;
  readonly packages?: Readonly<Record<string, string>> | undefined;
}

export function createHelloFruitDemoMetadata(
  input: HelloFruitDemoMetadataInput
): HelloFruitDemoMetadata {
  return {
    demo: {
      id: input.id,
      product: "hello-fruit"
    },
    mode: getDemoMode(input.walletConfigured, input.requestedMode),
    build: {
      git_sha: safeGitSha(input.gitSha),
      image_digest: safeImageDigest(input.imageDigest)
    },
    packages: {
      "@openreceive/core": "0.1.0",
      "@openreceive/express": "0.1.0",
      "@openreceive/node": "0.1.0",
      ...(input.packages ?? {})
    }
  };
}

function getDemoMode(
  walletConfigured: boolean,
  requestedMode: string | undefined
): HelloFruitDemoMode {
  if (!walletConfigured) return "unconfigured";
  if (requestedMode === "production" || requestedMode === "test_nwc") {
    return requestedMode;
  }
  return "test_nwc";
}

function safeGitSha(value: string | undefined): string | null {
  if (value === undefined) return null;
  return /^[0-9a-f]{7,40}$/i.test(value) ? value : null;
}

function safeImageDigest(value: string | undefined): string | null {
  if (value === undefined) return null;
  return /^sha256:[0-9a-f]{64}$/i.test(value) ? value : null;
}
