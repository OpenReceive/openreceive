/**
 * Never-throw fetch helpers for the host app's own Rails routes (/orders,
 * /rates). Store flows branch on `resp.success === false` / `resp.message`
 * instead of wrapping every call in try/catch.
 *
 * Engine routes (/openreceive/*) are NOT called through these helpers — they
 * use the @openreceive/browser protocol helpers, whose typed errors carry the
 * server's payer-facing message, retryable hint, and Retry-After.
 */

const networkErrorResponse = {
  success: false,
  message: "Network error. Please refresh the page and try again.",
};

const reportError = (err: unknown, where: string, context?: Record<string, unknown>) => {
  console.error(`[requests] ${where}`, err, context ?? {});
};

const getCsrfToken = (): string => {
  const meta = document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null;
  return meta?.content ?? "";
};

const jsonHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-CSRF-Token": getCsrfToken(),
});

const readBodyMessage = async (response: Response): Promise<string | undefined> => {
  try {
    const body = (await response.json()) as unknown;
    if (body !== null && typeof body === "object" && "message" in body) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
  } catch {
    // Non-JSON error body (e.g. a proxy's HTML 502) — fall back to the status.
  }
  return undefined;
};

// Generic: send arbitrary JSON to a Rails controller action.
export const sendToRailsController = async (data: object, url: string): Promise<any> => {
  try {
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: jsonHeaders(),
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const message = await readBodyMessage(response);
      reportError(`Non-OK response (${response.status})`, "sendToRailsController", { url });
      return { ...networkErrorResponse, message: message ?? `Server error (${response.status}).` };
    }
    return await response.json();
  } catch (err: unknown) {
    reportError(err, "sendToRailsController", {
      url,
      data: JSON.stringify(data).substring(0, 500),
    });
    return networkErrorResponse;
  }
};

// Helper specifically for GET requests that return JSON.
export const getJsonFromRails = async (url: string): Promise<any> => {
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const message = await readBodyMessage(response);
      return { ...networkErrorResponse, message: message ?? `Server error (${response.status}).` };
    }
    return await response.json();
  } catch (err: unknown) {
    reportError(err, "getJsonFromRails", { url });
    return networkErrorResponse;
  }
};
