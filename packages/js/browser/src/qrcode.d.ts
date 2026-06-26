declare module "qrcode" {
  // biome-ignore lint/suspicious/noShadowRestrictedNames: the qrcode package exposes this export name.
  export function toString(
    payload: string,
    options: Record<string, unknown>
  ): Promise<string> | string;

  export function toDataURL(
    payload: string,
    options: Record<string, unknown>
  ): Promise<string> | string;
}
