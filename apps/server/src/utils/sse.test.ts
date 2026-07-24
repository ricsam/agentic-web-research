import { describe, expect, test } from "bun:test";
import type { FastifyReply } from "fastify";
import { prepareSse } from "./sse";

describe("prepareSse", () => {
  test("hijacks the Fastify reply before writing the event stream", () => {
    const calls: string[] = [];
    const reply = {
      hijack() {
        calls.push("hijack");
      },
      raw: {
        writeHead() {
          calls.push("writeHead");
        },
        write() {
          calls.push("write");
        }
      }
    } as unknown as FastifyReply;

    prepareSse(reply);

    expect(calls).toEqual(["hijack", "writeHead", "write"]);
  });
});
