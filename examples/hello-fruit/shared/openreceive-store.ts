import {
  readOpenReceiveConfigFile,
  resolveOpenReceiveStore,
  resolveOpenReceiveStoreUri,
} from "@openreceive/node";

const DEFAULT_NAMESPACE = "hello_fruit";
type HelloFruitOpenReceiveStore = Awaited<ReturnType<typeof resolveOpenReceiveStore>>;

export async function createHelloFruitOpenReceiveKvStore(input: {
  readonly demoId: string;
}): Promise<HelloFruitOpenReceiveStore> {
  const config = readOpenReceiveConfigFile({ cwd: process.cwd() });
  const resolved = resolveOpenReceiveStoreUri({ storeUri: config?.storeUri });
  const namespace = config?.namespace ?? DEFAULT_NAMESPACE;
  try {
    const store = await resolveOpenReceiveStore(resolved.storeUri, {
      namespace,
      cwd: process.cwd(),
    });
    console.log(
      `[openreceive:${input.demoId}] OpenReceive store ready (${describeStore(resolved.storeUri)}, source=${resolved.source}).`,
    );
    return store;
  } catch (error) {
    console.error(
      `[openreceive:${input.demoId}] OpenReceive store initialization failed. Check openreceive.yml store/namespace settings and runtime dependencies.`,
    );
    throw error;
  }
}

function describeStore(storeUri: string): string {
  if (storeUri === "local-sqlite") return "local-sqlite";
  if (storeUri.startsWith("sqlite:")) return "sqlite";
  if (/^postgres(?:ql)?:\/\//.test(storeUri)) return "postgres";
  return "configured";
}
