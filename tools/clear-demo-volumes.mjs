#!/usr/bin/env node

import {
  clearHelloFruitDemoVolumes,
  HELLO_FRUIT_DEMO_VOLUME_NAMES
} from "./demo-volumes.mjs";

console.log("Clearing Hello Fruit demo Docker volumes:");
for (const volumeName of HELLO_FRUIT_DEMO_VOLUME_NAMES) {
  console.log(`  ${volumeName}`);
}

try {
  clearHelloFruitDemoVolumes();
} catch (error) {
  if (error?.code === "ENOENT") {
    console.error("Could not run `docker`. Install Docker and ensure it is on PATH.");
  } else {
    console.error(`Failed to clear demo Docker volumes: ${error.message}`);
  }
  process.exit(1);
}
