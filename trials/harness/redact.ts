import { secretMaterials } from "./checks.ts";

/** Replace wallet codes and every 12-character slice of their secret parts. */
export function redact(text: string, uris: readonly string[]): string {
  let out = text;
  const owned: { material: string; token: string }[] = [];
  uris.forEach((uri, index) => {
    const token = index === 0 ? "<NWC>" : "<LSC>";
    if (uri.length > 0) out = out.split(uri).join(token);
    for (const material of secretMaterials(uri)) {
      if (material !== uri) owned.push({ material, token });
    }
  });
  for (const { material, token } of owned.sort((a, b) => b.material.length - a.material.length)) {
    out = out.split(material).join(token);
    if (material.length < 12) continue;
    for (let i = 0; i <= material.length - 12; i += 1) {
      out = out.split(material.slice(i, i + 12)).join(token);
    }
  }
  return out;
}
