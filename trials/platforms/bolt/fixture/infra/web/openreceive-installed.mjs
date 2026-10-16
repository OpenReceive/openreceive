// "yes" once the app depends on an OpenReceive package, for the trial harness.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("/app/package.json", "utf8"));
const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
console.log(names.some((name) => name === "openreceive" || name.startsWith("@openreceive/")) ? "yes" : "no");
