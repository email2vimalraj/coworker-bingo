/** Base URL for QR codes: NEXT_PUBLIC_APP_URL if set, else the current origin. Browser only. */
export function getAppOrigin(): string {
  const env = process.env.NEXT_PUBLIC_APP_URL;
  if (env) return env.replace(/\/+$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}
