import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { parse as parseYaml } from "yaml";
import {
  blockersFailed,
  closingChecks,
  commandChecks,
  commandOutputCheck,
  evaluate,
  outputCheck,
  scopeViolation,
  secretMaterial,
} from "../trials/harness/checks.ts";
import { liveShopChecks } from "../trials/harness/live.ts";
import { loadMerchantCodes } from "../trials/harness/codes.ts";
import { agentPool, pick } from "../trials/harness/agents.ts";
import { parseClaudeStream } from "../trials/harness/claude.ts";
import { parseCodexStream, unwrapShell } from "../trials/harness/codex.ts";
import { cursorEnv, parseStream } from "../trials/harness/cursor.ts";
import { InfraError, platformOverrideFile, shopComposeEnv } from "../trials/harness/docker.ts";
import { withDatabase } from "../trials/harness/local-publish.ts";
import { classify, merchantReply } from "../trials/harness/merchant.ts";
import { runPool } from "../trials/harness/pool.ts";
import { platformEnvFile, prepareShop } from "../trials/harness/sandbox.ts";
import { redact } from "../trials/harness/redact.ts";
import { scanTrackedSecrets } from "../trials/harness/scan.ts";
import { serveDirectory } from "../trials/harness/serve.ts";
import { trialWalletOverride } from "../trials/harness/wallet.ts";

const nwc =
  "nostr+walletconnect://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?relay=wss%3A%2F%2Frelay.example&secret=71a8c14c1407c113601079c4302dab36460f0ccd0ad506f1f2dc73b5100e4f3c";
const lsc = "lightning+swapconnect://fake-lsc.test/?key=eval-test-key&secret=eval-test-secret";

const woocommerce = JSON.parse(
  await readFile(new URL("../trials/platforms/woocommerce/platform.json", import.meta.url), "utf8"),
);

const canonical = {
  id: "canonical",
  prompt: "Enable Bitcoin and stablecoin payments.",
  swaps: true,
  choice: "Yes, stablecoins too.",
};

const bitcoinOnly = { ...canonical, id: "bitcoin-only", swaps: false, choice: "Bitcoin only" };

function failed(id, turns, scenario = canonical) {
  const checks = evaluate({ scenario, platform: woocommerce, turns, nwc, lsc });
  const check = checks.find((item) => item.id === id);
  assert.ok(check, id);
  return check.pass === false;
}

const askNwc = {
  role: "agent",
  text: "To receive payments I need a receive-only wallet code. In Rizful: open the menu, tap NWC, choose Receive-only. Paste the code here.",
};

const askLsc = {
  role: "agent",
  text: "Go to https://lightning-swap.com, create a key, and copy the whole URI. Paste it here, or say Bitcoin only.",
};

test("a merchant paste is classified as the code that was asked for", () => {
  assert.equal(classify(askNwc.text), "nwc");
  assert.equal(classify(askLsc.text), "lsc");
  assert.equal(merchantReply(askNwc.text, canonical, { nwc, lsc }), nwc);
  assert.equal(merchantReply(askLsc.text, canonical, { nwc, lsc }), lsc);
  assert.equal(merchantReply(askLsc.text, bitcoinOnly, { nwc, lsc }), "Bitcoin only");
});

test("acknowledging the wallet code while asking for the swap URI pastes the swap code", () => {
  const text =
    'I have the receive-only wallet code and will store it with the plugin. Go to https://lightning-swap.com, sign in for API keys, create a key, and copy the whole URI. Paste it here and I will store it — or say "Bitcoin only".';
  assert.equal(classify(text), "lsc");
  assert.equal(merchantReply(text, canonical, { nwc, lsc }), lsc);
  const turns = [askNwc, { role: "merchant", text: nwc }, { role: "agent", text }];
  assert.equal(failed("one_question", turns), false);
  assert.equal(failed("lsc_question", turns), false);
  assert.equal(failed("nwc_question", turns), false);
});

test("narrating a saved code does not paste it again", () => {
  const narrate =
    "That receive-only wallet code is already on file. I'll save this copy the same way, through WP-CLI's stdin, and confirm the wallet check still passes.";
  assert.equal(classify(narrate), "other");
  assert.equal(merchantReply(narrate, canonical, { nwc, lsc }), "Yes, go ahead.");
});

test("a backup swap question pastes the backup only when one was provided", () => {
  const ask = "If you have a backup LSC code, paste it here.";
  const backup = "lightning+swapconnect://backup.example/?key=eval-bk&secret=eval-bs";
  assert.equal(classify(ask), "lsc_backup");
  assert.equal(merchantReply(ask, canonical, { nwc, lsc, lscBackup: backup }), backup);
  const missing = merchantReply(ask, canonical, { nwc, lsc });
  assert.equal(missing, "I don't have a backup code.");
  assert.doesNotMatch(missing, /LSC_URI/);
  const primary = "Paste the LSC code. A backup is optional and is not requested in this message.";
  assert.equal(classify(primary), "lsc");
  assert.equal(merchantReply(primary, canonical, { nwc, lsc, lscBackup: backup }), lsc);
});

test("a finished settlement report ends the conversation", () => {
  const text =
    "Bitcoin and stablecoin checkout is already enabled, and the settlement test is complete.";
  assert.equal(classify(text), "done");
  assert.equal(merchantReply(text, canonical, { nwc, lsc }), null);
});

test("a finished Step 3 message ends the run despite the refund sentence and the order-pay URL", () => {
  const text = `Setup is finished. Bitcoin and stablecoin checkout is on, the wallet check passed, and the swap provider is connected.

Test order **#17** (Facet, $7.00, 8,179 sats) is pending and yours to delete. This link opens checkout on that same Lightning invoice:

http://127.0.0.1:50364/checkout/order-pay/17/?pay_for_order=true&key=wc_order_Z1On8a2Z4lq6O

Keep this order-pay link reachable. If a stablecoin deposit arrives short or late, the customer claims a refund on that same page. A receive-only wallet cannot send merchant refunds; those come from your wallet.`;
  assert.equal(classify(text), "done");
  assert.equal(merchantReply(text, canonical, { nwc, lsc }), null);
  assert.equal(
    classify("Setup is already finished. There is no remaining step to approve."),
    "done",
  );
  assert.equal(classify("Setup is finished. Do you want a system cron too?"), "other");
  assert.equal(classify("Could you send me the receive-only NWC code?"), "nwc");
});

test("reading the installed plugin or calling its REST route by hand is forbidden", () => {
  const ran = (command) => [
    askNwc,
    askLsc,
    { role: "agent", text: "Setup is finished.", tools: [{ type: "shell", command }] },
  ];
  const source =
    "docker compose run --rm -T cli cat /var/www/html/wp-content/plugins/openreceive/src/Cli.php";
  const rest = `docker compose run --rm -T cli wp eval '$request = new WP_REST_Request("POST", "/openreceive/v1/checkouts/prepare");'`;
  const install =
    "docker compose run --rm -T cli wp plugin install https://github.com/OpenReceive/openreceive/releases/download/v0.4.17/openreceive-wordpress-0.4.17.zip --activate";
  assert.equal(failed("forbidden:wp-content/plugins/openreceive", ran(source)), true);
  assert.equal(failed("forbidden:openreceive/v1", ran(rest)), true);
  assert.equal(
    blockersFailed(
      evaluate({ scenario: canonical, platform: woocommerce, turns: ran(install), nwc, lsc }),
    ),
    false,
  );
});

test("cursor's environment does not receive wallet codes", () => {
  const backup = "lightning+swapconnect://backup.example/?key=eval-bk&secret=eval-bs";
  const env = cursorEnv({
    PATH: "/usr/bin",
    HOME: "/tmp",
    NWC_URI: nwc,
    LSC_URI_PRIMARY: lsc,
    LSC_URI_BACKUP: backup,
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.NWC_URI, undefined);
  assert.equal(env.LSC_URI_PRIMARY, undefined);
  assert.equal(env.LSC_URI_BACKUP, undefined);
});

test("missing wallet codes name the key and do not echo a value", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ortrial-env-"));
  try {
    const file = path.join(directory, ".env");
    await writeFile(file, 'NWC_URI="nostr+walletconnect://should-not-appear"\n');
    await assert.rejects(loadMerchantCodes(file), (error) => {
      assert.ok(error instanceof InfraError);
      assert.match(error.message, /LSC_URI_PRIMARY/);
      assert.doesNotMatch(error.message, /should-not-appear/);
      return true;
    });
    await writeFile(
      file,
      [
        "NWC_URI=nostr+walletconnect://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?relay=wss%3A%2F%2Frelay.example&secret=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "LSC_URI_PRIMARY=lightning+swapconnect://primary.example/?key=eval-pk&secret=eval-ps",
        "LSC_URI_BACKUP=lightning+swapconnect://backup.example/?key=eval-bk&secret=eval-bs",
      ].join("\n"),
    );
    const loaded = await loadMerchantCodes(file);
    assert.equal(loaded.nwc.startsWith("nostr+walletconnect://"), true);
    assert.equal(loaded.lscBackup?.includes("eval-bs"), true);
    const hidden = redact(`backup ${loaded.lscBackup}`, [loaded.nwc, loaded.lsc, loaded.lscBackup]);
    assert.equal(hidden.includes("eval-bs"), false);
    assert.match(hidden, /<LSC>/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("asking the merchant to run a command does not hand them a code unless they were asked for one", () => {
  const install = "Please run this: npm install woocommerce";
  assert.equal(classify(install), "delegate");
  assert.equal(
    merchantReply(install, canonical, { nwc, lsc }),
    "I'd rather not run commands or edit files. Can you do it?",
  );
  const store = "Run this in your terminal and paste your NWC code into it.";
  assert.match(
    merchantReply(store, canonical, { nwc, lsc }) ?? "",
    new RegExp(secretMaterial(nwc)),
  );
});

test("stopping after install, without asking for a code, is a blocker", () => {
  const turns = [
    {
      role: "agent",
      text: "Setup is complete. The plugin is installed.",
      tools: [
        { type: "shell", command: "wp plugin install https://example.test/plugin.zip --activate" },
      ],
    },
  ];
  assert.equal(failed("nwc_question", turns), true);
  assert.equal(failed("lsc_question", turns), true);
});

test("handing the merchant a printf of the code, then telling them to revoke it, fails", () => {
  const turns = [
    askNwc,
    { role: "merchant", text: nwc },
    {
      role: "agent",
      text: "Run this in your terminal, then revoke the code because it was pasted into the chat.",
      tools: [{ type: "shell", command: `printf '${nwc}' | wp openreceive configure --nwc-uri=-` }],
    },
  ];
  assert.equal(failed("merchant_does_the_work", turns), true);
  assert.equal(failed("secret_not_in_command", turns), true);
  assert.equal(failed("no_revoke", turns), true);
  assert.equal(failed("lsc_question", turns), true);
});

test("a file write plus stdin redirection keeps the secret out of the command line", () => {
  const turns = [
    askNwc,
    { role: "merchant", text: nwc },
    askLsc,
    { role: "merchant", text: lsc },
    {
      role: "agent",
      text: "Payments are enabled. Setup is complete.",
      tools: [
        { type: "write", path: "/tmp/openreceive-code", tracked: false },
        { type: "shell", command: "wp openreceive configure --nwc-uri=- < /tmp/openreceive-code" },
        { type: "write", path: "/tmp/openreceive-code", tracked: false },
        {
          type: "shell",
          command: "wp openreceive configure --lsc-uri-primary=- < /tmp/openreceive-code",
        },
      ],
    },
  ];
  const checks = evaluate({ scenario: canonical, platform: woocommerce, turns, nwc, lsc });
  assert.equal(blockersFailed(checks), false);
});

test("cloning the repo is a blocker unless the release asset 404s", () => {
  const clone = {
    role: "agent",
    text: "Payments are enabled.",
    tools: [{ type: "shell", command: "git clone https://github.com/OpenReceive/openreceive.git" }],
  };
  assert.equal(failed("no_repo_clone", [askNwc, askLsc, clone]), true);
  const with404 = {
    ...clone,
    tools: [
      {
        type: "fetch",
        url: "https://github.com/OpenReceive/openreceive/releases/download/v0.4.14/openreceive-wordpress-0.4.14.zip",
        status: 404,
      },
      { type: "shell", command: "git clone https://github.com/OpenReceive/openreceive.git" },
    ],
  };
  assert.equal(failed("no_repo_clone", [askNwc, askLsc, with404]), false);
});

test("printenv is forbidden", () => {
  const turns = [
    askNwc,
    askLsc,
    {
      role: "agent",
      text: "Payments are enabled.",
      tools: [{ type: "shell", command: "printenv NWC_URI" }],
    },
  ];
  assert.equal(failed("forbidden:printenv", turns), true);
});

test("a prohibition is not a request for the merchant to do the work", () => {
  assert.equal(classify("Paste your NWC code here. Setup is complete."), "nwc");
  assert.equal(classify("Setup is complete. Payments are enabled."), "done");
  assert.equal(classify("Do not run this."), "other");
  assert.equal(classify("Never run this in your terminal."), "other");
  assert.equal(classify("Do not do this in wp-admin."), "other");
  assert.equal(classify("Never ask them to run this, and paste your NWC code here."), "nwc");
  assert.equal(
    classify("Do not run this yourself. Please run this: wp plugin install x"),
    "delegate",
  );
});

test("an LSC secret is caught when the key param comes first", () => {
  const turns = [
    askNwc,
    askLsc,
    {
      role: "agent",
      text: "Payments are enabled.",
      tools: [{ type: "shell", command: `printf '${lsc.split("secret=")[1]}'` }],
    },
  ];
  assert.equal(failed("secret_not_in_command", turns), true);
});

test("reports replace the code and every 12-character slice of it", () => {
  const hidden = redact(`printf '${nwc}' ${lsc.split("secret=")[1]}`, [nwc, lsc]);
  assert.equal(hidden.includes(secretMaterial(nwc).slice(0, 12)), false);
  assert.equal(hidden.includes("eval-test-secret"), false);
  assert.match(hidden, /<NWC>/);
  assert.match(hidden, /<LSC>/);
});

test("commands that read this repo or a credential file are out of scope", () => {
  const root = "/work/openreceive";
  assert.equal(scopeViolation("docker compose port wordpress 80", root), undefined);
  assert.equal(scopeViolation(`cat ${root}/docs/agents/woocommerce.md`, root), root);
  assert.equal(scopeViolation("cat ~/.ssh/id_rsa", root), "~/.ssh");
});

test("stream-json keeps the assistant text, the shell line, and a failed release download", () => {
  const raw = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "chat-1", model: "test-model" }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Paste your NWC code here." }] },
      session_id: "chat-1",
    }),
    JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      session_id: "chat-1",
      tool_call: {
        shellToolCall: {
          args: {
            command:
              "curl -fsSL https://github.com/OpenReceive/openreceive/releases/download/v0.4.16/openreceive-wordpress-0.4.16.zip",
          },
          result: { success: { exitCode: 22 } },
        },
      },
    }),
    JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      session_id: "chat-1",
      tool_call: {
        editToolCall: {
          args: { path: "/tmp/openreceive-code", streamContent: "nostr+walletconnect://example" },
        },
      },
    }),
  ].join("\n");
  const parsed = parseStream(raw);
  assert.equal(parsed.sessionId, "chat-1");
  assert.equal(parsed.model, "test-model");
  assert.match(parsed.text, /Paste your NWC code/);
  assert.equal(parsed.tools.filter((tool) => tool.type === "shell").length, 1);
  assert.equal(parsed.tools.find((tool) => tool.type === "fetch")?.status, 404);
  assert.equal(parsed.writes[0]?.path, "/tmp/openreceive-code");
});

test("a secret in a tracked file fails, and a gitignored .env does not", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ortrial-scan-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git("init", "-b", "master");
    await writeFile(path.join(directory, ".gitignore"), ".env\n");
    await writeFile(path.join(directory, "README.md"), "plain\n");
    git("add", ".gitignore", "README.md");
    git("-c", "user.name=dev", "-c", "user.email=dev@example.com", "commit", "-m", "plain");
    const ignored = await scanTrackedSecrets(
      directory,
      [nwc, lsc],
      [{ path: path.join(directory, ".env"), content: nwc }],
    );
    assert.equal(ignored.pass, true);
    await writeFile(path.join(directory, "README.md"), `${nwc}\n`);
    git("add", "README.md");
    git("-c", "user.name=dev", "-c", "user.email=dev@example.com", "commit", "-m", "leaked");
    const tracked = await scanTrackedSecrets(directory, [nwc, lsc], []);
    assert.equal(tracked.pass, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the directions server serves the working tree file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ortrial-serve-"));
  await writeFile(path.join(directory, "woocommerce.md"), "step 0\n");
  const served = await serveDirectory(directory);
  try {
    const response = await fetch(served.fileUrl("woocommerce.md"));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "step 0\n");
    const missing = await fetch(`${served.base}/../package.json`);
    assert.equal(missing.status, 404);
  } finally {
    await served.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("at most two heavy shops run even when the pool is wider", async () => {
  let current = 0;
  let max = 0;
  const jobs = [1, 2, 3, 4].map(() => ({
    heavy: true,
    run: async () => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => setTimeout(resolve, 40));
      current -= 1;
    },
  }));
  await runPool(jobs, 4, 2);
  assert.equal(max, 2);
});

test("jobs that share a serial key run one at a time while the rest run in parallel", async () => {
  let vercelNow = 0;
  let vercelMax = 0;
  let allNow = 0;
  let allMax = 0;
  const job = (serial) => ({
    heavy: false,
    serial,
    run: async () => {
      allNow += 1;
      allMax = Math.max(allMax, allNow);
      if (serial === "vercel") {
        vercelNow += 1;
        vercelMax = Math.max(vercelMax, vercelNow);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (serial === "vercel") vercelNow -= 1;
      allNow -= 1;
    },
  });
  await runPool([job("vercel"), job("vercel"), job("vercel"), job(), job(), job()], 6, 2);
  assert.equal(vercelMax, 1);
  assert.equal(allMax, 4);
});

const vercel = JSON.parse(
  await readFile(new URL("../trials/platforms/vercel/platform.json", import.meta.url), "utf8"),
);

function platformChecks(turns) {
  return evaluate({ scenario: canonical, platform: vercel, turns, nwc, lsc });
}

test("on a hosting platform, the merchant never pastes a code, even when asked", () => {
  for (const ask of [
    "Please paste your receive-only NWC code here.",
    "Now send me the LSC code from lightning-swap.com?",
    "Run this in your terminal: echo NWC_URI. Paste the NWC code too.",
  ]) {
    const reply = merchantReply(ask, canonical, { nwc, lsc }, true);
    assert.ok(reply !== null && !reply.includes(nwc) && !reply.includes(lsc), ask);
  }
});

test("on a hosting platform, asking for a code or echoing one is a blocker", () => {
  const finished = {
    role: "agent",
    text: "Setup is finished. Checkout: https://shop.test/orders/1",
  };
  const clean = platformChecks([finished]);
  assert.equal(clean.find((item) => item.id === "no_code_question")?.pass, true);
  assert.equal(clean.find((item) => item.id === "secret_not_in_message")?.pass, true);
  assert.equal(
    clean.some((item) => item.id === "nwc_question"),
    false,
  );

  const asked = platformChecks([
    { role: "agent", text: "Please paste your receive-only NWC code." },
  ]);
  assert.equal(asked.find((item) => item.id === "no_code_question")?.pass, false);

  const echoed = platformChecks([
    { role: "agent", text: `Your project has NWC_URI=${nwc} set.` },
    finished,
  ]);
  assert.equal(echoed.find((item) => item.id === "secret_not_in_message")?.pass, false);
});

test("a code copied in its shortened display form stops the run before it starts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ortrial-codes-"));
  try {
    const shortened =
      "nostr+walletconnect://a1b2c3d4…e5f6a7b8?relay=wss%3A%2F%2Frelay.example&secret=…";
    const env = path.join(directory, ".env");
    await writeFile(env, `NWC_URI=${nwc}\nLSC_URI_PRIMARY=${lsc}\nNWC_URI_VERCEL=${shortened}\n`);
    await assert.rejects(loadMerchantCodes(env), (error) => {
      assert.ok(error instanceof InfraError);
      assert.match(error.message, /NWC_URI_VERCEL/);
      assert.ok(!error.message.includes("a1b2c3d4"));
      return true;
    });
    await writeFile(env, `NWC_URI=${nwc}\nLSC_URI_PRIMARY=${lsc}\nNWC_URI_VERCEL=${nwc}\n`);
    assert.equal((await loadMerchantCodes(env)).nwcVercel, nwc);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a local publish moves only DATABASE_URL to the empty production database", () => {
  const env = `DATABASE_URL=postgresql://shop:shop@postgres:5432/shop\nNWC_URI=${nwc}\nLSC_URI_PRIMARY=${lsc}\n`;
  assert.equal(
    withDatabase(env, "shop_production"),
    `DATABASE_URL=postgresql://shop:shop@postgres:5432/shop_production\nNWC_URI=${nwc}\nLSC_URI_PRIMARY=${lsc}\n`,
  );
  assert.equal(
    withDatabase("DATABASE_URL=postgresql://u:p@db:5432/shop?sslmode=disable\n", "prod"),
    "DATABASE_URL=postgresql://u:p@db:5432/prod?sslmode=disable\n",
  );
});

test("cursor gets COMPOSE_FILE from the harness, but never a wallet code through it", () => {
  const env = cursorEnv(
    { PATH: "/usr/bin" },
    { COMPOSE_FILE: "/work/shop/compose.yml", NWC_URI: nwc },
  );
  assert.equal(env.COMPOSE_FILE, "/work/shop/compose.yml");
  assert.equal(env.NWC_URI, undefined);
});

test("a platform shop holds no path to the platform's variables", async () => {
  const fixture = new URL("../trials/platforms/replit/fixture", import.meta.url).pathname;
  const directory = await prepareShop(fixture, "replit-test", {
    DATABASE_URL: "postgresql://shop:shop@postgres:5432/shop",
    NWC_URI: nwc,
  });
  try {
    const shopText = [];
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else shopText.push(await readFile(full, "utf8"));
      }
    };
    await walk(directory);
    const all = shopText.join("\n");
    assert.ok(!all.includes(platformEnvFile(directory)));
    assert.ok(!all.includes(platformOverrideFile(directory)));
    assert.ok(!all.includes("secret="));
    const override = await readFile(platformOverrideFile(directory), "utf8");
    assert.match(override, /web:\n {4}env_file:\n {6}- .*\.platform\.env\n/);
    assert.equal(
      shopComposeEnv(directory).COMPOSE_FILE,
      `${path.join(directory, "compose.yml")}:${platformOverrideFile(directory)}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(platformEnvFile(directory), { force: true });
    await rm(platformOverrideFile(directory), { force: true });
  }
});

test("the trial wallet override joins each service to the trial network and trusts its CA", () => {
  const wallet = {
    network: "openreceive-trial",
    caFile: "/repo/trials/wallet/certs/ca.crt",
    caBundle: "/repo/trials/wallet/certs/ca-bundle.crt",
  };
  const text = trialWalletOverride(["web", "worker", "web"], wallet);
  const override = parseYaml(text);
  assert.deepEqual(Object.keys(override.services), ["web", "worker"]);
  assert.deepEqual(override.networks, { "openreceive-trial": { external: true } });
  const bundle = "/etc/ssl/certs/ca-certificates.crt";
  for (const service of Object.values(override.services)) {
    assert.deepEqual(service.networks, ["default", "openreceive-trial"]);
    assert.deepEqual(service.volumes, [
      { type: "bind", source: wallet.caBundle, target: bundle, read_only: true },
      {
        type: "bind",
        source: wallet.caFile,
        target: "/etc/ssl/certs/openreceive-trial-ca.crt",
        read_only: true,
      },
    ]);
    assert.deepEqual(service.environment, {
      NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/openreceive-trial-ca.crt",
      SSL_CERT_FILE: bundle,
      REQUESTS_CA_BUNDLE: bundle,
      CURL_CA_BUNDLE: bundle,
    });
  }
  assert.throws(() => trialWalletOverride([], wallet), InfraError);
  assert.throws(() => trialWalletOverride(["web: {}"], wallet), InfraError);
});

test("on a hosting platform, checking that codes exist passes and printing a value fails", () => {
  const names = '{"stdout":"NWC_URI: set\\nLSC_URI_PRIMARY: set\\n"}';
  assert.equal(outputCheck([names], [nwc, lsc]).pass, true);
  const value = `{"stdout":"NWC_URI=${nwc}\\n"}`;
  assert.equal(outputCheck([names, value], [nwc, lsc]).pass, false);
});

// Cursor files a command that exited nonzero under `failure`. Reading only
// `success` hid every failed command from the trials, including the 0.4.21
// Django agents' `openreceive_install` that stopped on openreceive.E001.
test("stream-json keeps a failed command's exit code and output", () => {
  const raw = JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    session_id: "chat-1",
    tool_call: {
      shellToolCall: {
        args: { command: "python manage.py openreceive_install shop" },
        result: {
          failure: {
            exitCode: 1,
            stdout: "",
            stderr: "SystemCheckError: (openreceive.E001) cannot be imported",
          },
        },
      },
    },
  });
  const [shell] = parseStream(raw).tools;
  assert.equal(shell.type, "shell");
  assert.equal(shell.exitCode, 1);
  assert.match(shell.output, /openreceive\.E001/);
});

function shell(command, exitCode = 0, output = "") {
  return { type: "shell", command, exitCode, output };
}

function commandCheck(id, tools) {
  return commandChecks([{ role: "agent", text: "", tools }]).find((item) => item.id === id);
}

function commandCheckWith(id, tools, writes) {
  return commandChecks([{ role: "agent", text: "", tools }], writes).find((item) => item.id === id);
}

test("an OpenReceive command failing in OpenReceive's own code, or a flag that forces past it, is a blocker", () => {
  const install = "docker compose exec -T web python manage.py openreceive_install shop";
  // The 0.4.21 Django video failure.
  const e001 = shell(
    install,
    1,
    'SystemCheckError: System check identified some issues:\nERRORS:\n?: (openreceive.E001) settings.OPENRECEIVE["HOST"] cannot be imported',
  );
  assert.equal(commandCheck("openreceive_command_clean", [e001]).pass, false);
  assert.match(commandCheck("openreceive_command_clean", [e001]).evidence, /E001/);
  assert.equal(
    commandCheck("no_workaround_flag", [e001, shell(`${install} --skip-checks`)]).pass,
    false,
  );
  // A traceback through the installed gem (the generator's NameError).
  const generator = shell(
    "docker compose exec -T web bundle exec rails generate openreceive:install",
    1,
    "/usr/local/bundle/gems/openreceive-rails-0.4.21/lib/generators/openreceive/install/install_generator.rb:56:in `schema_version': uninitialized constant OpenReceive::Server (NameError)",
  );
  assert.equal(commandCheck("openreceive_command_clean", [generator]).pass, false);
  assert.equal(commandCheck("openreceive_command_clean", [shell(install)]).pass, true);
});

// Seen in the 2026-10-10 sweep: the chain died before our command ran, or
// after it, in the framework's own code. Those are failed_commands polish.
test("a chain that fails outside OpenReceive's code is not an OpenReceive failure", () => {
  const venv = shell(
    "python3 -m venv /tmp/or-venv && /tmp/or-venv/bin/pip install 'openreceive[fastapi]' && /tmp/or-venv/bin/openreceive scaffold payments --sql",
    1,
    "The virtual environment was not created successfully because ensurepip is not available.",
  );
  const migrate = shell(
    "php artisan openreceive:install --no-interaction && php artisan migrate --force",
    1,
    "app/OpenReceive/Host.php .. written\nIlluminate\\Database\\QueryException Database file at path [/data/shop.sqlite] does not exist.\nat vendor/laravel/framework/src/Illuminate/Database/Connection.php:838",
  );
  const down = shell(
    "docker compose ps && docker compose exec -T web python manage.py openreceive_install shop",
    1,
    'service "web" is not running',
  );
  // Codex grepped the installed type definitions, then ran `doctor --help`.
  const grep = shell(
    "docker compose exec -T web sh -c 'grep -n paidAt node_modules/@openreceive/http/dist/adapter-surface.d.ts' && docker compose exec -T web npx --yes openreceive@0.4.21 doctor --help",
    1,
    "node_modules/@openreceive/http/dist/adapter-surface-Cs4g29Ez.d.ts:131:    readonly paidAt: number | null;\nUnexpected option: --help.",
  );
  assert.equal(commandCheck("openreceive_command_clean", [venv, migrate, down, grep]).pass, true);
  const polish = commandCheck("failed_commands", [venv, migrate, down]);
  assert.equal(polish.severity, "polish");
  assert.equal(polish.pass, false);
});

// One 0.4.21 Django trial agent got past the admin TypeError by rewriting the
// installed openreceive/django/admin.py from the shop's Dockerfile, then passed
// every other check.
test("rewriting OpenReceive's installed package is a blocker; serving its files is not", () => {
  const dockerfile = {
    path: "/tmp/shop/Dockerfile",
    content:
      "RUN pip install -r requirements.txt && python - <<'PY'\npath = Path(\"/usr/local/lib/python3.12/site-packages/openreceive/django/admin.py\")\npath.write_text(text)\nPY",
  };
  assert.equal(commandCheckWith("no_package_patch", [], [dockerfile]).pass, false);
  assert.equal(
    commandCheckWith("no_package_patch", [
      shell(
        "sed -i 's/ModelAdmin\\[.*\\]/ModelAdmin/' /usr/local/lib/python3.12/site-packages/openreceive/django/admin.py",
      ),
    ]).pass,
    false,
  );
  const server = {
    path: "/tmp/shop/server.js",
    content:
      'await app.register(fastifyStatic, { root: join(__dirname, "node_modules/@openreceive/elements/dist/standalone") });\n'.concat(
        "\n".repeat(20),
        'await writeFile("orders.json", line);',
      ),
  };
  assert.equal(commandCheckWith("no_package_patch", [], [server]).pass, true);
  // A Rails agent's Dockerfile copying the standalone checkout out of the package.
  const copy = {
    path: "/tmp/shop/Dockerfile",
    content:
      "RUN mkdir -p public/openreceive \\\n    && cp node_modules/@openreceive/elements/dist/standalone/openreceive-checkout.js public/openreceive/",
  };
  assert.equal(commandCheckWith("no_package_patch", [], [copy]).pass, true);
  // A third ran sed -i on it, the path on the line after the sed.
  const sed = {
    path: "/tmp/shop/Dockerfile",
    content:
      "RUN sed -i \\\n    -e 's/admin\\.ModelAdmin\\[OpenReceivePayment\\]/admin.ModelAdmin/' \\\n    -e 's/admin\\.ModelAdmin\\[OpenReceiveMeta\\]/admin.ModelAdmin/' \\\n    /usr/local/lib/python3.12/site-packages/openreceive/django/admin.py",
  };
  assert.equal(commandCheckWith("no_package_patch", [], [sed]).pass, false);
  // Another got past it by patching Django's class from settings.py.
  const settings = {
    path: "/tmp/shop/widgetshop/settings.py",
    content:
      "import django.contrib.admin.options as _admin_options\n_admin_options.ModelAdmin.__class_getitem__ = classmethod(lambda cls, _item: cls)\n",
  };
  assert.equal(commandCheckWith("no_package_patch", [], [settings]).pass, false);
  const plain = { path: "/tmp/shop/views.py", content: 'if __name__ == "__main__":\n    main()\n' };
  assert.equal(commandCheckWith("no_package_patch", [], [plain]).pass, true);
});

test("a stack frame inside OpenReceive's code in any output is surfaced as polish", () => {
  const logs = shell(
    "docker compose logs --tail 40 web",
    0,
    "File \"/usr/local/lib/python3.12/site-packages/openreceive/django/admin.py\", line 17, in <module>\nTypeError: type 'ModelAdmin' is not subscriptable",
  );
  const found = commandCheck("openreceive_raised", [logs]);
  assert.equal(found.severity, "polish");
  assert.equal(found.pass, false);
  assert.match(found.evidence, /not subscriptable/);
  const frames = [
    "/usr/local/bundle/gems/openreceive-rails-0.4.21/lib/generators/openreceive/install/install_generator.rb:56:in `schema_version'",
    "at /app/vendor/openreceive/laravel/src/Http/Controller.php:88",
    "#0 /app/vendor/openreceive/laravel/src/Http/Controller.php(88): handle()",
    "    at handler (file:///app/node_modules/@openreceive/http/dist/index.js:120:7)",
  ];
  for (const frame of frames) {
    assert.equal(commandCheck("openreceive_raised", [shell("x", 1, frame)]).pass, false, frame);
  }
  // Searching the installed source prints path:line, which is not a frame.
  const search = [
    "node_modules/@openreceive/fastify/dist/index.js:120:  const prefix = options.prefix;",
    "vendor/openreceive/laravel/src/Host.php:12:    public function authorize()",
    "/usr/local/bundle/gems/openreceive-rails-0.4.21/lib/openreceive/engine.rb:8:    isolate_namespace OpenReceive",
  ];
  for (const line of search) {
    assert.equal(
      commandCheck("openreceive_raised", [shell("rg -n prefix", 0, line)]).pass,
      true,
      line,
    );
  }
});

test("doctor must have run, and its last run must be clean", () => {
  const doctor = "docker compose exec -T web python manage.py openreceive_doctor";
  assert.equal(commandCheck("doctor_clean", []).evidence, "doctor never ran");
  assert.equal(commandCheck("doctor_clean", [shell(doctor, 1), shell(doctor, 0)]).pass, true);
  assert.equal(commandCheck("doctor_clean", [shell(doctor, 0), shell(doctor, 1)]).pass, false);
  assert.equal(
    commandCheck("doctor_clean", [shell("npx openreceive doctor --db shop.db")]).pass,
    true,
  );
  assert.equal(commandCheck("doctor_clean", [shell("php bin/doctor")]).pass, true);
  assert.equal(commandCheck("doctor_clean", [shell("bin/rails openreceive:doctor")]).pass, true);
  // How Codex ran it in the 2026-10-10 trials: a pinned package, and argv in a spawn.
  assert.equal(
    commandCheck("doctor_clean", [
      shell(
        "docker compose exec web npx --yes openreceive@0.4.21 doctor --db /data/shop.sqlite --url http://localhost:3000",
      ),
    ]).pass,
    true,
  );
  assert.equal(
    commandCheck("doctor_clean", [
      shell(
        `docker compose exec web node --input-type=module -e 'spawnSync("npx",["--yes","openreceive@0.4.21","doctor","--db",process.env.DATABASE_URL])'`,
      ),
    ]).pass,
    true,
  );
  assert.equal(
    commandCheck("doctor_clean", [shell("npm ls openreceive")]).evidence,
    "doctor never ran",
  );
});

function closing(id, message, maxLines = 5) {
  const turns = [{ role: "agent", text: `earlier bubble\n${message}`, last: message }];
  return closingChecks(turns, maxLines).find((item) => item.id === id);
}

test("the closing message says Setup is finished, stays short, and says nothing after", () => {
  const good = [
    "Setup is finished.",
    "Open http://127.0.0.1:8000/ and click Buy: it opens the checkout.",
    "It offers Bitcoin, plus USDT, USDC, ETH and SOL.",
    "Check that the wallet logos and a pay tutorial's screenshots load.",
  ].join("\n");
  for (const id of [
    "closing_says_finished",
    "closing_short",
    "closing_no_question",
    "closing_no_minimum",
  ]) {
    assert.equal(closing(id, good).pass, true, id);
  }
  // The 0.4.21 Django run 1: the browser checklist copied out after the link.
  const trailing = `${good}\nCheck that the payment-method icons render.\nOpen a wallet's pay tutorial.\nScreenshots load.`;
  assert.equal(closing("closing_short", trailing).pass, false);
  assert.equal(closing("closing_short", `I wired the hooks.\nI ran doctor.\n${good}`).pass, false);
  assert.equal(closing("closing_says_finished", "Payments are enabled.").pass, false);
  assert.equal(
    closing("closing_no_question", `${good}\nWant me to add a receipt page?`).pass,
    false,
  );
  assert.equal(
    closing("closing_no_question", "Setup is finished.\nOpen http://127.0.0.1:8000/orders/1?pay=1")
      .pass,
    true,
  );
  assert.equal(
    closing("closing_no_minimum", "Setup is finished.\nUSDT is unavailable below the $10 minimum.")
      .pass,
    false,
  );
});

test("a command that prints a code's value is a blocker on a dotenv shop", () => {
  const turns = [
    {
      role: "agent",
      text: "",
      tools: [
        shell(
          "grep -E '^(NWC_URI|LSC_URI_PRIMARY)=.' .env | cut -d= -f1",
          0,
          "NWC_URI\nLSC_URI_PRIMARY",
        ),
      ],
    },
  ];
  assert.equal(commandOutputCheck(turns, [nwc, lsc]).pass, true);
  turns[0].tools.push(shell("cat .env", 0, `NWC_URI=${nwc}`));
  const leaked = commandOutputCheck(turns, [nwc, lsc]);
  assert.equal(leaked.pass, false);
  assert.equal(leaked.evidence, "cat .env");
});

/**
 * A Django-shaped shop: a session cookie, a CSRF cookie and form field, a
 * checkout that wants the token in X-CSRFToken and refuses another session.
 */
const HASH = "ab".repeat(32);

async function csrfShop(authorize, { relayBlips = 0, onPaidWired = true } = {}) {
  const orders = new Map();
  let sessions = 0;
  let blips = relayBlips;
  let settled = false;
  const server = createServer((request, response) => {
    const cookies = Object.fromEntries(
      (request.headers.cookie ?? "")
        .split(";")
        .map((pair) => pair.trim().split("="))
        .filter((pair) => pair.length === 2),
    );
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (cookies.sessionid === undefined) {
        sessions += 1;
        response.setHeader("set-cookie", [
          `sessionid=s${sessions}; Path=/`,
          "csrftoken=tok; Path=/",
        ]);
      }
      const session = cookies.sessionid ?? `s${sessions}`;
      const csrfOk = cookies.csrftoken === "tok";
      if (request.url === "/health") return response.end("ok");
      if (request.method === "GET") {
        return response.end(
          '<form><input type="hidden" name="csrfmiddlewaretoken" value="tok"></form>',
        );
      }
      if (request.url === "/orders") {
        if (!csrfOk || !new URLSearchParams(body).has("csrfmiddlewaretoken")) {
          response.statusCode = 403;
          return response.end("CSRF");
        }
        const id = String(orders.size + 1);
        orders.set(id, session);
        response.statusCode = 302;
        response.setHeader("location", `/orders/${id}`);
        return response.end();
      }
      if (request.url === "/openreceive/payments/check") {
        response.statusCode = 200;
        return response.end(`{"status":"${settled ? "settled" : "pending"}"}`);
      }
      if (request.url === "/openreceive/checkouts") {
        if (!csrfOk || request.headers["x-csrftoken"] !== "tok") {
          response.statusCode = 403;
          return response.end("CSRF");
        }
        if (blips > 0) {
          blips -= 1;
          response.statusCode = 503;
          return response.end('{"code":"TIMEOUT","retryable":true}');
        }
        const { reference } = JSON.parse(body);
        if (authorize && orders.get(reference) !== session) {
          response.statusCode = 403;
          return response.end('{"error":"forbidden"}');
        }
        response.statusCode = 201;
        return response.end(`{"checkout":{"bolt11":"lnbc10n1pexample","payment_hash":"${HASH}"}}`);
      }
      response.statusCode = 404;
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
    // The trial wallet's settle, and the shop's own order row afterwards.
    paid: {
      settle: async (hash) => {
        settled = hash === HASH;
      },
      orderStatus: async () => (settled && onPaidWired ? "paid" : "awaiting_payment"),
    },
  };
}

test("the live check orders and pays through a CSRF-protected shop, as a browser would", async () => {
  const shop = await csrfShop(true);
  try {
    const checks = await liveShopChecks(shop.base);
    assert.deepEqual(
      checks.map((item) => [item.id, item.pass]),
      [
        ["live_health", true],
        ["live_invoice", true],
        ["live_refuses_stranger", true],
      ],
    );
  } finally {
    shop.close();
  }
});

test("a 503 the API marks retryable is tried again, as the browser checkout would", async () => {
  const shop = await csrfShop(true, { relayBlips: 1 });
  try {
    const checks = await liveShopChecks(shop.base, { retryDelayMs: 10 });
    assert.equal(checks.find((item) => item.id === "live_invoice")?.pass, true);
  } finally {
    shop.close();
  }
});

test("the stranger has a valid session and token, so only authorize can refuse them", async () => {
  // The generated allow-all placeholder left in place: CSRF alone would have
  // refused a cookieless stranger and hidden it.
  const shop = await csrfShop(false);
  try {
    const checks = await liveShopChecks(shop.base);
    assert.equal(checks.find((item) => item.id === "live_refuses_stranger")?.pass, false);
  } finally {
    shop.close();
  }
});

test("a platform summary prints the passed.json entry only when every trial passed", async () => {
  const { platformSummaryMarkdown } = await import("../trials/harness/report.ts");
  const base = {
    slug: "django",
    day: "2026-10-09",
    mode: "candidate",
    release: "0.4.21",
    directionsUrl: "http://127.0.0.1:1/django.md",
    directions: "0123456789ab",
  };
  const cursor = { agent: "cursor", model: "grok-4.7-medium-fast" };
  const codex = { agent: "codex", model: "default" };
  const pass = (id, who) => ({ id, ok: true, elapsedMs: 300_000, checks: [], ...who });
  const fail = {
    id: "b",
    ok: false,
    elapsedMs: 420_000,
    checks: [
      { id: "closing_short", severity: "blocker", pass: false, summary: "", evidence: "8 lines" },
    ],
    ...codex,
  };
  const all = platformSummaryMarkdown({
    ...base,
    runs: [pass("a", cursor), pass("c", codex), pass("d", cursor)],
  });
  assert.match(all, /3 of 3 trials passed/);
  assert.match(
    all,
    /"runs":3,"agents":\["codex\/default","cursor\/grok-4\.7-medium-fast"\],"mode":"candidate","directions":"0123456789ab"/,
  );
  assert.match(all, /## a \(cursor\/grok-4\.7-medium-fast\) \(5\.0 min\)/);
  const some = platformSummaryMarkdown({ ...base, runs: [pass("a", cursor), fail] });
  assert.match(some, /1 of 2 trials passed/);
  assert.doesNotMatch(some, /passed\.json entry/);
  assert.match(some, /closing_short: 8 lines/);
});

// The shapes `claude -p --output-format stream-json --verbose` printed in a
// probe run: a Bash success, a Bash failure with its exit code, a Write.
test("Claude Code's stream keeps the text, each command's exit code and output, and the writes", () => {
  const lines = [
    { type: "system", subtype: "init", session_id: "s-1", model: "claude-test" },
    {
      type: "assistant",
      session_id: "s-1",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat note.txt" } }],
      },
    },
    {
      type: "user",
      session_id: "s-1",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "hello", is_error: false }],
      },
    },
    {
      type: "assistant",
      session_id: "s-1",
      message: {
        content: [
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls /nonexistent-dir" } },
        ],
      },
    },
    {
      type: "user",
      session_id: "s-1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: "Exit code 2\nls: cannot access '/nonexistent-dir': No such file or directory",
            is_error: true,
          },
        ],
      },
    },
    {
      type: "assistant",
      session_id: "s-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t3",
            name: "Write",
            input: { file_path: "/tmp/shop/.env", content: "NWC_URI=x\n" },
          },
          { type: "text", text: "Setup is finished." },
        ],
      },
    },
    {
      type: "result",
      subtype: "success",
      session_id: "s-1",
      result: "Setup is finished.",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ];
  const parsed = parseClaudeStream(lines.map((line) => JSON.stringify(line)).join("\n"));
  assert.equal(parsed.sessionId, "s-1");
  assert.equal(parsed.model, "claude-test");
  assert.equal(parsed.lastText, "Setup is finished.");
  const shells = parsed.tools.filter((tool) => tool.type === "shell");
  assert.deepEqual(
    shells.map((tool) => [tool.command, tool.exitCode]),
    [
      ["cat note.txt", 0],
      ["ls /nonexistent-dir", 2],
    ],
  );
  assert.match(shells[1].output, /No such file/);
  assert.deepEqual(parsed.writes, [{ path: "/tmp/shop/.env", content: "NWC_URI=x\n" }]);
  assert.deepEqual(parsed.usage, { inputTokens: 10, outputTokens: 5 });
});

test("a settled invoice turns the shop's own order paid, unless onPaid is a placeholder", async () => {
  const wired = await csrfShop(true);
  try {
    const checks = await liveShopChecks(wired.base, {
      retryDelayMs: 10,
      settleTimeoutMs: 2_000,
      paid: wired.paid,
    });
    assert.equal(checks.find((item) => item.id === "live_settled")?.pass, true);
    assert.equal(checks.find((item) => item.id === "live_order_paid")?.pass, true);
  } finally {
    wired.close();
  }
  // The generated logging-only onPaid: the engine settles, the order never changes.
  const placeholder = await csrfShop(true, { onPaidWired: false });
  try {
    const checks = await liveShopChecks(placeholder.base, {
      retryDelayMs: 10,
      settleTimeoutMs: 2_000,
      paid: placeholder.paid,
    });
    assert.equal(checks.find((item) => item.id === "live_settled")?.pass, true);
    const order = checks.find((item) => item.id === "live_order_paid");
    assert.equal(order?.pass, false);
    assert.match(order?.evidence ?? "", /awaiting_payment/);
  } finally {
    placeholder.close();
  }
});

// The events `codex exec --json` printed in a probe run.
test("Codex's stream keeps the text, each command's exit code and output, and the thread", () => {
  const lines = [
    { type: "thread.started", thread_id: "01a1-thread" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "Running them." },
    },
    {
      type: "item.completed",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "/bin/bash -lc 'cat note.txt'",
        aggregated_output: "hello\n",
        exit_code: 0,
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "item_2",
        type: "command_execution",
        command: "/bin/bash -lc 'ls /nonexistent-dir'",
        aggregated_output: "ls: cannot access '/nonexistent-dir': No such file or directory\n",
        exit_code: 2,
        status: "failed",
      },
    },
    {
      type: "item.completed",
      item: { id: "item_3", type: "agent_message", text: "Setup is finished." },
    },
    { type: "turn.completed", usage: { input_tokens: 28, output_tokens: 9 } },
  ];
  const parsed = parseCodexStream(
    `Reading additional input from stdin...\n${lines.map((line) => JSON.stringify(line)).join("\n")}`,
  );
  assert.equal(parsed.sessionId, "01a1-thread");
  assert.equal(parsed.lastText, "Setup is finished.");
  assert.deepEqual(
    parsed.tools.map((tool) => [tool.command, tool.exitCode]),
    [
      ["cat note.txt", 0],
      ["ls /nonexistent-dir", 2],
    ],
  );
  assert.deepEqual(parsed.usage, { inputTokens: 28, outputTokens: 9 });
});

test("Codex's shell wrapper is removed before the checks read a command", () => {
  assert.equal(
    unwrapShell("/bin/bash -lc 'grep -E '\\''^(NWC_URI)=.'\\'' .env'"),
    "grep -E '^(NWC_URI)=.' .env",
  );
  assert.equal(unwrapShell('/bin/bash -lc "printf \\"ok\\" > out.txt"'), 'printf "ok" > out.txt');
  assert.equal(unwrapShell("docker compose ps"), "docker compose ps");
});

test("the default agent pool is Cursor on Grok and Codex, one picked per trial", () => {
  const pool = agentPool("random");
  assert.deepEqual(
    pool.map((choice) => [choice.agent.name, choice.model]),
    [
      ["cursor", "grok-4.7-medium-fast"],
      ["codex", undefined],
    ],
  );
  assert.equal(pick(pool, () => 0).agent.name, "cursor");
  assert.equal(pick(pool, () => 0.99).agent.name, "codex");
  assert.equal(agentPool("claude")[0]?.agent.name, "claude");
  assert.equal(agentPool("cursor", "gpt-5.2")[0]?.model, "gpt-5.2");
  assert.throws(() => agentPool("random", "gpt-5.2"), /single --agent/);
  assert.throws(() => agentPool("gemini"), /Unknown agent/);
});
