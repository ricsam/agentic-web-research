import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const blockedHostnameSuffixes = [
  ".internal",
  ".local",
  ".localhost",
  ".svc",
  ".cluster.local"
];

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

function normalizeHostname(hostname: string) {
  return hostname.trim().replace(/\.$/, "").toLowerCase();
}

export function isBlockedHostname(hostname: string) {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized === "metadata" ||
    normalized === "metadata.google.internal" ||
    blockedHostnameSuffixes.some((suffix) => normalized.endsWith(suffix))
  );
}

export function isBlockedIpAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("::ffff:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:")
    );
  }
  return true;
}

export async function assertSafeHttpUrl(input: string, allowPrivateNetworks: boolean) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Only http and https URLs can be rendered");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs containing credentials cannot be rendered");
  }
  if (allowPrivateNetworks) return url;

  if (isBlockedHostname(url.hostname)) {
    throw new UnsafeUrlError("Private network URLs are disabled");
  }

  const directIp = isIP(url.hostname);
  if (directIp && isBlockedIpAddress(url.hostname)) {
    throw new UnsafeUrlError("Private network URLs are disabled");
  }

  if (!directIp) {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some((address) => isBlockedIpAddress(address.address))) {
      throw new UnsafeUrlError("Private network URLs are disabled");
    }
  }

  return url;
}
