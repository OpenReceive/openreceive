/** What stagePublishedPlugin downloaded and verified. */
export interface PublishedPluginReceipt {
  readonly version: string;
  readonly buildId: number;
  readonly commit: string;
  readonly btcpayVersion: string;
  readonly url: string;
  readonly sha256: string;
}

export function demoBtcpayVersion(env?: Record<string, string | undefined>): string;

export function stagePublishedPlugin(options: {
  readonly root: string;
  readonly btcpayVersion: string;
  readonly fetchApi?: typeof fetch;
  readonly pluginDir?: string;
}): Promise<PublishedPluginReceipt>;
