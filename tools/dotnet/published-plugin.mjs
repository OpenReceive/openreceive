import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const identifier = "BTCPayServer.Plugins.OpenReceive";
const directoryUrl = "https://plugin-builder.btcpayserver.org/api/v1/plugins/directory/openreceive";

export function demoBtcpayVersion(env = process.env) {
  const image = env.BTCPAY_IMAGE;
  const version = /:(\d+\.\d+\.\d+)$/.exec(image ?? "")?.[1];
  assert(
    version,
    "Published-plugin mode needs a BTCPAY_IMAGE with a numeric version tag (for example btcpayserver/btcpayserver:2.4.4).",
  );
  return version;
}

// Stage the directory's package and manifest exactly as BTCPay's plugin download
// does, then queue its native installer. This never copies a local plugin build.
export async function stagePublishedPlugin({ root, btcpayVersion, fetchApi = fetch }) {
  const response = await fetchApi(
    `${directoryUrl}?btcpayVersion=${encodeURIComponent(btcpayVersion)}`,
    {
      signal: AbortSignal.timeout(30000),
    },
  );
  assert(
    response.ok,
    `Plugin Directory lookup failed (HTTP ${response.status}); no local build was substituted.`,
  );
  const published = await response.json();
  const manifest = published.manifestInfo;
  assert(
    published.projectSlug === "openreceive" && manifest?.Identifier === identifier,
    "Plugin Directory returned a different plugin.",
  );
  assert(
    /^\d+\.\d+\.\d+\.\d+$/.test(published.version) && manifest.Version === published.version,
    "Plugin Directory returned inconsistent version metadata.",
  );
  assert(
    /^[a-f0-9]{64}$/i.test(published.buildInfo?.buildHash ?? ""),
    "Plugin Directory package checksum is missing.",
  );
  const downloadUrl = new URL(published.buildInfo.url);
  assert(downloadUrl.protocol === "https:", "Plugin package download must use HTTPS.");
  const download = await fetchApi(downloadUrl.href, { signal: AbortSignal.timeout(120000) });
  assert(download.ok, `Plugin package download failed (HTTP ${download.status}).`);
  const archive = Buffer.from(await download.arrayBuffer());
  const sha256 = createHash("sha256").update(archive).digest("hex");
  assert(
    sha256 === published.buildInfo.buildHash.toLowerCase(),
    "Plugin package checksum mismatch; the current demo has not been changed.",
  );

  const pluginDir = path.join(root, "packages/dotnet/docker/.state/published-plugins");
  mkdirSync(pluginDir, { recursive: true });
  const archivePath = path.join(pluginDir, `${identifier}.btcpay`);
  writeFileSync(`${archivePath}.download`, archive);
  renameSync(`${archivePath}.download`, archivePath);
  writeFileSync(
    path.join(pluginDir, `${identifier}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(path.join(pluginDir, "commands"), `install:${identifier}\n`);
  const receipt = {
    version: published.version,
    buildId: published.buildId,
    commit: published.buildInfo.gitCommit,
    btcpayVersion,
    url: downloadUrl.href,
    sha256,
  };
  writeFileSync(path.join(pluginDir, "download.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const receipt = await stagePublishedPlugin({ root, btcpayVersion: demoBtcpayVersion() });
    console.log(
      `Plugin Directory: OpenReceive ${receipt.version}, build ${receipt.buildId}, BTCPay ${receipt.btcpayVersion}`,
    );
    console.log(`Verified package SHA256: ${receipt.sha256}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
