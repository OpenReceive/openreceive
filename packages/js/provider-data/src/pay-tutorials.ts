declare const __filename: string | undefined;

const moduleUrl =
  typeof import.meta.url === "string" && import.meta.url.length > 0
    ? import.meta.url
    : fileUrlFromPath(__filename as string);

function fileUrlFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(absolute).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

function assetUrl(path: string): string {
  return new URL(path, moduleUrl).href;
}

const cashappTutorial1 = assetUrl("./assets/pay_tutorials/cashapp-1.webp");
const cashappTutorial2 = assetUrl("./assets/pay_tutorials/cashapp-2.webp");
const cashappTutorial3 = assetUrl("./assets/pay_tutorials/cashapp-3.webp");
const cashappTutorial4 = assetUrl("./assets/pay_tutorials/cashapp-4.webp");
const cashappTutorial5 = assetUrl("./assets/pay_tutorials/cashapp-5.webp");
const cashappTutorial6 = assetUrl("./assets/pay_tutorials/cashapp-6.webp");
const boltzTutorial1 = assetUrl("./assets/pay_tutorials/boltz-1.webp");
const boltzTutorial2 = assetUrl("./assets/pay_tutorials/boltz-2.webp");
const coinbaseTutorial1 = assetUrl("./assets/pay_tutorials/coinbase-1.webp");
const coinbaseTutorial2 = assetUrl("./assets/pay_tutorials/coinbase-2.webp");
const fixedfloatTutorial1 = assetUrl("./assets/pay_tutorials/fixedfloat-1.webp");
const fixedfloatTutorial2 = assetUrl("./assets/pay_tutorials/fixedfloat-2.webp");
const krakenTutorial1 = assetUrl("./assets/pay_tutorials/kraken-1.webp");
const krakenTutorial2 = assetUrl("./assets/pay_tutorials/kraken-2.webp");
const krakenTutorial3 = assetUrl("./assets/pay_tutorials/kraken-3.webp");
const krakenTutorial4 = assetUrl("./assets/pay_tutorials/kraken-4.webp");
const strikeTutorial1 = assetUrl("./assets/pay_tutorials/strike-1.webp");
const strikeTutorial2 = assetUrl("./assets/pay_tutorials/strike-2.webp");
const strikeTutorial3 = assetUrl("./assets/pay_tutorials/strike-3.webp");
const strikeTutorial4 = assetUrl("./assets/pay_tutorials/strike-4.webp");

export const openReceivePayTutorialUrls: Readonly<Record<string, string>> = {
  "assets/pay_tutorials/cashapp-1.webp": cashappTutorial1,
  "assets/pay_tutorials/cashapp-2.webp": cashappTutorial2,
  "assets/pay_tutorials/cashapp-3.webp": cashappTutorial3,
  "assets/pay_tutorials/cashapp-4.webp": cashappTutorial4,
  "assets/pay_tutorials/cashapp-5.webp": cashappTutorial5,
  "assets/pay_tutorials/cashapp-6.webp": cashappTutorial6,
  "assets/pay_tutorials/boltz-1.webp": boltzTutorial1,
  "assets/pay_tutorials/boltz-2.webp": boltzTutorial2,
  "assets/pay_tutorials/coinbase-1.webp": coinbaseTutorial1,
  "assets/pay_tutorials/coinbase-2.webp": coinbaseTutorial2,
  "assets/pay_tutorials/fixedfloat-1.webp": fixedfloatTutorial1,
  "assets/pay_tutorials/fixedfloat-2.webp": fixedfloatTutorial2,
  "assets/pay_tutorials/kraken-1.webp": krakenTutorial1,
  "assets/pay_tutorials/kraken-2.webp": krakenTutorial2,
  "assets/pay_tutorials/kraken-3.webp": krakenTutorial3,
  "assets/pay_tutorials/kraken-4.webp": krakenTutorial4,
  "assets/pay_tutorials/strike-1.webp": strikeTutorial1,
  "assets/pay_tutorials/strike-2.webp": strikeTutorial2,
  "assets/pay_tutorials/strike-3.webp": strikeTutorial3,
  "assets/pay_tutorials/strike-4.webp": strikeTutorial4
} as const;
