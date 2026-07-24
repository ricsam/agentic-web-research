import { describe, expect, test } from "bun:test";
import { assertSafeHttpUrl, isBlockedHostname, isBlockedIpAddress, UnsafeUrlError } from "./urlSafety";

describe("URL safety", () => {
  test("blocks internal hostnames and address ranges", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("postgres.r5d-dev.svc.cluster.local")).toBe(true);
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
    expect(isBlockedIpAddress("127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("10.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("169.254.169.254")).toBe(true);
    expect(isBlockedIpAddress("100.100.100.200")).toBe(true);
    expect(isBlockedIpAddress("::1")).toBe(true);
    expect(isBlockedIpAddress("fe80::1")).toBe(true);
    expect(isBlockedIpAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("8.8.8.8")).toBe(false);
  });

  test("rejects unsupported protocols and credential-bearing URLs", async () => {
    await expect(assertSafeHttpUrl("file:///etc/passwd", false)).rejects.toThrow("Only http and https");
    await expect(assertSafeHttpUrl("https://user:pass@example.com", false)).rejects.toThrow("credentials");
  });

  test("allows private URLs only when explicitly enabled", async () => {
    await expect(assertSafeHttpUrl("http://127.0.0.1", false)).rejects.toBeInstanceOf(UnsafeUrlError);
    expect((await assertSafeHttpUrl("http://127.0.0.1", true)).hostname).toBe("127.0.0.1");
  });
});
