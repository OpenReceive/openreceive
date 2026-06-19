export type { OpenReceiveReceiveNwcClient } from "@openreceive/core";

export class OpenReceiveNodeNotImplemented extends Error {
  constructor(feature: string) {
    super(`${feature} is planned for the v0.1 reference payment path.`);
    this.name = "OpenReceiveNodeNotImplemented";
  }
}
