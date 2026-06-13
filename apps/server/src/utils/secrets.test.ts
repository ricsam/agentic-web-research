import { describe, expect, test } from "bun:test";
import { decryptSecret, encryptSecret } from "./secrets";

describe("secret encryption", () => {
  test("round-trips encrypted values", () => {
    const secret = "sk-test";
    const appSecret = "a-long-enough-application-secret";
    const encrypted = encryptSecret(secret, appSecret);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted, appSecret)).toBe(secret);
  });
});

