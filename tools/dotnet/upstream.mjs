import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const latestReleaseUrl = "https://api.github.com/repos/btcpayserver/btcpayserver/releases/latest";

export async function latestBtcpayRelease(fetchImpl = fetch) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const response = await fetchImpl(latestReleaseUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "openreceive-btcpay-compatibility",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `Cannot resolve latest BTCPay release: GitHub HTTP ${response.status}`);
  const release = await response.json();
  assert(
    release.draft === false && release.prerelease === false,
    "Latest BTCPay release must be stable",
  );
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name);
  assert(match, `Unsupported BTCPay release tag: ${release.tag_name}`);
  return {
    tag: release.tag_name,
    version: match[1],
    image: `btcpayserver/btcpayserver:${match[1]}`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const release = await latestBtcpayRelease();
    console.error(`Latest stable BTCPay: ${release.version}`);
    console.log(release.image);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
