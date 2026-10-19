// `node node_modules/@openreceive/vendure/dist/enable-openreceive.js`, run in
// the Vendure server's project while the server is up: creates the
// OpenReceive payment method in the default channel through the Admin API,
// as creating it under Settings → Payment methods in the dashboard does, or
// enables it again. Safe to run again. It signs in with SUPERADMIN_USERNAME
// and SUPERADMIN_PASSWORD from .env, as a new Vendure project has them, and
// prints neither.
//
//   --admin-api <url>   the Admin API (default http://localhost:<PORT>/admin-api)
//   --name <name>       the method's name at checkout

import { existsSync } from "node:fs";
import { OPENRECEIVE_VENDURE_HANDLER_CODE } from "./index.ts";

const METHOD_CODE = "openreceive";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message: string): never {
  console.error(`OpenReceive: ${message}`);
  process.exit(1);
}

if (existsSync(".env")) process.loadEnvFile(".env");

const port = process.env.PORT || process.env.VENDURE_SERVER_PORT || "3000";
const adminApi =
  option("--admin-api") ??
  process.env.VENDURE_ADMIN_API_URL ??
  `http://localhost:${port}/admin-api`;
const swaps = (process.env.LSC_URI_PRIMARY ?? "").trim() !== "";
const name = option("--name") ?? (swaps ? "Bitcoin & stablecoins" : "Bitcoin Lightning");
const description = swaps
  ? "Pay with Bitcoin over Lightning, or with USDT, USDC, SOL or ETH, converted to Bitcoin."
  : "Pay with Bitcoin over Lightning.";

let token: string | undefined;

async function call<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(adminApi, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ query, variables }),
  }).catch((error: unknown) =>
    fail(`could not reach the Admin API at ${adminApi} (${String(error)}). Is the server up?`),
  );
  token = response.headers.get("vendure-auth-token") ?? token;
  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (body.errors !== undefined && body.errors.length > 0) {
    fail(body.errors.map((error) => error.message).join("; "));
  }
  if (body.data === undefined) fail(`the Admin API answered ${response.status} without data`);
  return body.data;
}

const username = process.env.SUPERADMIN_USERNAME;
const password = process.env.SUPERADMIN_PASSWORD;
if (!username || !password) {
  fail(
    "set SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD in .env, or create the method in the dashboard.",
  );
}

const login = await call<{ login: { __typename: string; message?: string } }>(
  `mutation ($username: String!, $password: String!) {
    login(username: $username, password: $password) { __typename ... on ErrorResult { message } }
  }`,
  { username, password },
);
if (login.login.__typename !== "CurrentUser")
  fail(`could not sign in: ${login.login.message ?? "refused"}`);
if (token === undefined) {
  fail("the Admin API did not hand out a bearer token: add 'bearer' to authOptions.tokenMethod.");
}

const { paymentMethods } = await call<{
  paymentMethods: {
    items: {
      id: string;
      code: string;
      name: string;
      enabled: boolean;
      handler: { code: string };
    }[];
  };
}>(
  `query { paymentMethods(options: { take: 100 }) { items { id code name enabled handler { code } } } }`,
);

const existing = paymentMethods.items.find(
  (method) => method.handler.code === OPENRECEIVE_VENDURE_HANDLER_CODE,
);
if (existing?.enabled) {
  console.log(
    `OpenReceive: payment method "${existing.name}" (${existing.code}) is already enabled.`,
  );
} else if (existing !== undefined) {
  await call(
    `mutation ($id: ID!) { updatePaymentMethod(input: { id: $id, enabled: true }) { id } }`,
    {
      id: existing.id,
    },
  );
  console.log(`OpenReceive: enabled payment method "${existing.name}" (${existing.code}).`);
} else {
  await call(
    `mutation ($input: CreatePaymentMethodInput!) { createPaymentMethod(input: $input) { id } }`,
    {
      input: {
        code: METHOD_CODE,
        enabled: true,
        handler: { code: OPENRECEIVE_VENDURE_HANDLER_CODE, arguments: [] },
        translations: [{ languageCode: "en", name, description }],
      },
    },
  );
  console.log(
    `OpenReceive: created payment method "${name}" (${METHOD_CODE}) in the default channel.`,
  );
}
