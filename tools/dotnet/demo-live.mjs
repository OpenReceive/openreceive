import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEMO_PASSWORD = "OpenReceive-demo-123!";

// Only the launcher calls this against its localhost Docker instance. Never log
// request/response bodies: they can contain wallet or provider credentials.
export async function configureLiveDemo({ root, env = process.env, fetchApi = fetch }) {
  const base = "http://127.0.0.1:14180";
  const stateDir = path.join(root, "packages/dotnet/docker/.state/live");
  const stateFile = path.join(stateDir, "login.json");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const state = existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : { email: "demo@openreceive.test", password: DEMO_PASSWORD };
  const save = () => {
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(stateFile, 0o600);
  };
  save();
  let ready = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      const response = await fetchApi(`${base}/login`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Server is still starting. */
    }
    await delay(1000);
  }
  if (!ready)
    throw new Error("BTCPay did not start within 3 minutes. Check Docker's btcpayserver logs.");
  const api = async (method, route, body, basic = false) => {
    let response;
    try {
      response = await fetchApi(`${base}/api/v1${route}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(basic
            ? {
                Authorization: `Basic ${Buffer.from(`${state.email}:${state.password}`).toString("base64")}`,
              }
            : state.apiKey
              ? { Authorization: `token ${state.apiKey}` }
              : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      throw new Error(`BTCPay ${method} ${route} could not complete.`);
    }
    if (!response.ok)
      throw new Error(
        `BTCPay ${method} ${route} returned HTTP ${response.status}. Check the demo configuration.`,
      );
    return response.json();
  };
  if (!state.apiKey) {
    // Registration may already have succeeded if an earlier run was interrupted.
    try {
      await api("POST", "/users", { ...state, isAdministrator: true });
    } catch {
      /* Try the saved login. */
    }
    const key = await api(
      "POST",
      "/api-keys",
      { label: "OpenReceive local demo", permissions: ["unrestricted"] },
      true,
    );
    state.apiKey = key.apiKey;
    if (!state.apiKey) throw new Error("BTCPay did not return a demo API key.");
    save();
  }
  // Upgrade local state created by the earlier random-password launcher.
  if (state.password !== DEMO_PASSWORD) {
    await api("PUT", "/users/me", { currentPassword: state.password, newPassword: DEMO_PASSWORD });
    state.password = DEMO_PASSWORD;
    save();
  }
  if (!state.storeId) {
    const stores = await api("GET", "/stores");
    const store =
      stores.find((entry) => entry.name === "OpenReceive demo") ??
      (await api("POST", "/stores", { name: "OpenReceive demo", defaultCurrency: "USD" }));
    state.storeId = store.id;
    if (!state.storeId) throw new Error("BTCPay did not return a demo store.");
    save();
  }
  const settings = await api("PUT", `/stores/${state.storeId}/openreceive/settings`, {
    nwcUri: env.NWC_URI.trim(),
    allowSpendCapableWallet: false,
    lscPrimary: env.LSC_URI_PRIMARY?.trim() ?? "",
    lscBackup: env.LSC_URI_BACKUP?.trim() ?? "",
    swapsEnabled: Boolean(env.LSC_URI_PRIMARY?.trim()),
  });
  if (
    !settings.lightningNodeIsOpenReceive ||
    settings.swapsEnabled !== Boolean(env.LSC_URI_PRIMARY?.trim())
  ) {
    throw new Error("BTCPay did not apply the wallet and swap settings.");
  }
  return {
    email: state.email,
    password: state.password,
    stateFile,
    swapsEnabled: settings.swapsEnabled,
  };
}
