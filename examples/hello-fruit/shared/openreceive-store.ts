import { readOpenReceiveConfigFile, resolveOpenReceiveStore } from "@openreceive/node";

const DEFAULT_STORE_URI = "local-sqlite";
const DEFAULT_NAMESPACE = "hello_fruit";
type HelloFruitOpenReceiveStore = Awaited<ReturnType<typeof resolveOpenReceiveStore>>;

export async function createHelloFruitOpenReceiveKvStore(input: {
  readonly demoId: string;
}): Promise<HelloFruitOpenReceiveStore> {
  const config = readOpenReceiveConfigFile({ cwd: process.cwd() });
  const storeUri = (config?.storeUri ?? DEFAULT_STORE_URI).trim();
  const namespace = config?.namespace ?? DEFAULT_NAMESPACE;
  try {
    const store = await resolveOpenReceiveStore(storeUri, {
      namespace,
      cwd: process.cwd()
    });
    console.log(
      `[openreceive:${input.demoId}] OpenReceive store ready (${describeStore(storeUri)}).`
    );
    return store;
  } catch (error) {
    console.error(
      `[openreceive:${input.demoId}] OpenReceive store initialization failed. Check openreceive.yml store, OPENRECEIVE_NAMESPACE, and runtime dependencies.`
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
