import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));

export const HELLO_FRUIT_DEMOS = [
  {
    dir: "examples/hello-fruit/server/node-express",
    volumeName: "node-express_openreceive-node-express-openreceive"
  },
  {
    dir: "examples/hello-fruit/server/static-html-small-api",
    volumeName: "static-html-small-api_openreceive-static-html-small-api-openreceive"
  },
  {
    dir: "examples/hello-fruit/server/nextjs-fullstack",
    volumeName: "nextjs-fullstack_openreceive-nextjs-fullstack-openreceive"
  }
];

export const HELLO_FRUIT_DEMO_VOLUME_NAMES = HELLO_FRUIT_DEMOS.map(
  (demo) => demo.volumeName
);

export function clearHelloFruitDemoVolumes({ stdio = "inherit" } = {}) {
  for (const demo of HELLO_FRUIT_DEMOS) {
    runDocker(
      [
        "compose",
        "-f",
        "compose.yml",
        "-f",
        "compose.override.yml.example",
        "down",
        "--volumes",
        "--remove-orphans"
      ],
      {
        cwd: path.join(root, demo.dir),
        stdio
      }
    );
  }

  runDocker(["volume", "rm", "--force", ...HELLO_FRUIT_DEMO_VOLUME_NAMES], {
    stdio
  });
}

function runDocker(args, options) {
  const result = spawnSync("docker", args, options);
  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} exited with status ${result.status}`);
  }
}
