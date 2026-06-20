declare module "qrcode" {
  export function toString(
    payload: string,
    options: Record<string, unknown>
  ): Promise<string> | string;

  export function toDataURL(
    payload: string,
    options: Record<string, unknown>
  ): Promise<string> | string;
}
