import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { startFakeWallet } from "./fake-wallet.mjs";

// What every Workers test needs: a receive-only wallet on the local relay,
// reached through wss:// with a throwaway CA that workerd trusts (OpenReceive
// accepts wss relays only), and a Worker under `wrangler dev`.

const wrangler = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "node_modules",
  ".bin",
  "wrangler",
);

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

export async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A CA and a localhost certificate it signed, made fresh with openssl. */
function makeCertificates(directory) {
  const file = (name) => path.join(directory, name);
  const openssl = (...args) => execFileSync("openssl", args, { stdio: "pipe" });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  openssl(
    "req",
    "-x509",
    ...ec,
    "-days",
    "1",
    "-subj",
    "/CN=OpenReceive workers test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
    "-keyout",
    file("ca.key"),
    "-out",
    file("ca.pem"),
  );
  openssl(
    "req",
    ...ec,
    "-subj",
    "/CN=localhost",
    "-keyout",
    file("relay.key"),
    "-out",
    file("relay.csr"),
  );
  writeFileSync(
    file("relay.ext"),
    "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
  );
  openssl(
    "x509",
    "-req",
    "-in",
    file("relay.csr"),
    "-CA",
    file("ca.pem"),
    "-CAkey",
    file("ca.key"),
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    file("relay.ext"),
    "-out",
    file("relay.pem"),
  );
  return {
    ca: file("ca.pem"),
    key: readFileSync(file("relay.key")),
    cert: readFileSync(file("relay.pem")),
  };
}

/** wss:// in front of the plain relay: TLS ends here, bytes pass through. */
async function startTlsFront({ key, cert }, upstream) {
  const server = tls.createServer({ key, cert }, (socket) => {
    const relay = net.connect(Number(upstream.port), upstream.hostname);
    socket.pipe(relay).pipe(socket);
    socket.on("error", () => relay.destroy());
    relay.on("error", () => socket.destroy());
  });
  return { server, port: await listen(server) };
}

async function waitForWorker(worker, base, output) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`wrangler dev exited:\n${output.join("")}`);
    const up = await fetch(base).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`wrangler dev did not answer within 90 s:\n${output.join("")}`);
}

/** The fake wallet behind a TLS front; `ca` is the file workerd must trust. */
export async function startTlsWallet(relayUrl, scratch) {
  const certificates = makeCertificates(scratch);
  const front = await startTlsFront(certificates, new URL(relayUrl));
  const wallet = await startFakeWallet(relayUrl, {
    advertisedRelayUrl: `wss://localhost:${front.port}`,
  });
  return {
    wallet,
    ca: certificates.ca,
    close() {
      wallet.close();
      front.server.close();
    },
  };
}

/**
 * `wrangler dev` for the Worker in `workerDir`, with `vars` as its
 * environment. Resolves once it answers; `stop()` ends it.
 */
export async function startWorker({ workerDir, vars, ca, scratch }) {
  // Values go through an env file: `--var KEY:VALUE` would split a URL's colons.
  const varsFile = path.join(scratch, `${path.basename(workerDir)}.env`);
  writeFileSync(
    varsFile,
    Object.entries(vars)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const output = [];
  const worker = spawn(
    wrangler,
    ["dev", "--ip", "127.0.0.1", "--port", String(port), "--env-file", varsFile],
    {
      cwd: workerDir,
      env: {
        ...process.env,
        // wrangler hands this CA to workerd, which verifies relay certificates.
        ...(ca === undefined ? {} : { NODE_EXTRA_CA_CERTS: ca }),
        WRANGLER_SEND_METRICS: "false",
        CI: "1",
      },
    },
  );
  worker.stdout.on("data", (chunk) => output.push(String(chunk)));
  worker.stderr.on("data", (chunk) => output.push(String(chunk)));
  await waitForWorker(worker, base, output);
  return {
    base,
    output,
    async stop() {
      if (worker.exitCode !== null) return;
      const exited = new Promise((resolve) => worker.once("exit", resolve));
      worker.kill("SIGTERM");
      await exited;
    },
  };
}
