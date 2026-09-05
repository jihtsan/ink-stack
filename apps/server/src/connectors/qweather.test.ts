import { request as httpsRequest } from "node:https";
import { describe, expect, it } from "vitest";
import { pinnedLookup } from "./qweather.js";

describe("QWeather pinned DNS lookup", () => {
  it("returns the array form required by Node when lookup asks for all addresses", async () => {
    let all: boolean | undefined;
    const error = await new Promise<Error>((resolve) => {
      const request = httpsRequest({
        hostname: "qweather.invalid",
        port: 1,
        path: "/",
        method: "GET",
        servername: "qweather.invalid",
        lookup: (hostname, options, callback) => {
          all = options.all;
          return pinnedLookup("127.0.0.1")(hostname, options, callback);
        }
      });
      request.once("error", resolve);
      request.setTimeout(1_000, () => request.destroy(new Error("lookup_test_timeout")));
      request.end();
    });

    expect(all).toBe(true);
    expect((error as NodeJS.ErrnoException).code).not.toBe("ERR_INVALID_IP_ADDRESS");
  });
});
