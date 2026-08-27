import { createQrPayloadSvg, createQrSvg } from "@openreceive/browser/headless";
import { useEffect, useState } from "react";

// The QR the shipped renderers draw — no second QR dependency. Both builders
// are async (the encoder is), so the SVG arrives on a later tick; this holds it
// and drops a result that lands after the payload has already changed.
//
// Note for anyone reading the types: `dangerouslySetInnerHTML.__html` accepts
// `TrustedHTML`, which is an empty interface, so a forgotten `await` here type
// checks and renders the string "[object Promise]".
const useSvg = (payload: string, build: (value: string) => Promise<string>): string => {
  const [svg, setSvg] = useState("");

  useEffect(() => {
    if (!payload) {
      setSvg("");
      return;
    }

    let live = true;
    void build(payload).then((next) => {
      if (live) setSvg(next);
    });
    return () => {
      live = false;
    };
  }, [payload, build]);

  return svg;
};

export const useInvoiceQrSvg = (invoice: string): string => useSvg(invoice, createQrSvg);

export const usePayloadQrSvg = (payload: string): string => useSvg(payload, createQrPayloadSvg);
