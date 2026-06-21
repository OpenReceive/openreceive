const cashappTutorial1 = new URL("./assets/pay_tutorials/cashapp-1.webp", import.meta.url).href;
const cashappTutorial2 = new URL("./assets/pay_tutorials/cashapp-2.webp", import.meta.url).href;
const cashappTutorial3 = new URL("./assets/pay_tutorials/cashapp-3.webp", import.meta.url).href;
const cashappTutorial4 = new URL("./assets/pay_tutorials/cashapp-4.webp", import.meta.url).href;
const cashappTutorial5 = new URL("./assets/pay_tutorials/cashapp-5.webp", import.meta.url).href;
const cashappTutorial6 = new URL("./assets/pay_tutorials/cashapp-6.webp", import.meta.url).href;
const boltzTutorial1 = new URL("./assets/pay_tutorials/boltz-1.webp", import.meta.url).href;
const boltzTutorial2 = new URL("./assets/pay_tutorials/boltz-2.webp", import.meta.url).href;
const coinbaseTutorial1 = new URL("./assets/pay_tutorials/coinbase-1.webp", import.meta.url).href;
const coinbaseTutorial2 = new URL("./assets/pay_tutorials/coinbase-2.webp", import.meta.url).href;
const fixedfloatTutorial1 = new URL("./assets/pay_tutorials/fixedfloat-1.webp", import.meta.url).href;
const fixedfloatTutorial2 = new URL("./assets/pay_tutorials/fixedfloat-2.webp", import.meta.url).href;
const krakenTutorial1 = new URL("./assets/pay_tutorials/kraken-1.webp", import.meta.url).href;
const krakenTutorial2 = new URL("./assets/pay_tutorials/kraken-2.webp", import.meta.url).href;
const krakenTutorial3 = new URL("./assets/pay_tutorials/kraken-3.webp", import.meta.url).href;
const krakenTutorial4 = new URL("./assets/pay_tutorials/kraken-4.webp", import.meta.url).href;
const strikeTutorial1 = new URL("./assets/pay_tutorials/strike-1.webp", import.meta.url).href;
const strikeTutorial2 = new URL("./assets/pay_tutorials/strike-2.webp", import.meta.url).href;
const strikeTutorial3 = new URL("./assets/pay_tutorials/strike-3.webp", import.meta.url).href;
const strikeTutorial4 = new URL("./assets/pay_tutorials/strike-4.webp", import.meta.url).href;

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
