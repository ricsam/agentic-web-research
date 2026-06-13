import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isPrivateIpv4(ip: string) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function isPrivateIpv6(ip: string) {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized === "::"
  );
}

export async function assertSafeHttpUrl(input: string, allowPrivateNetworks: boolean) {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be rendered");
  }

  if (allowPrivateNetworks) return url;

  const directIp = isIP(url.hostname);
  if (directIp === 4 && isPrivateIpv4(url.hostname)) {
    throw new Error("Private network URLs are disabled");
  }
  if (directIp === 6 && isPrivateIpv6(url.hostname)) {
    throw new Error("Private network URLs are disabled");
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: false });
  for (const address of addresses) {
    if (address.family === 4 && isPrivateIpv4(address.address)) {
      throw new Error("Private network URLs are disabled");
    }
    if (address.family === 6 && isPrivateIpv6(address.address)) {
      throw new Error("Private network URLs are disabled");
    }
  }

  return url;
}

