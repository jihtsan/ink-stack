import { request as httpsRequest } from "node:https";
import { describe, expect, it } from "vitest";
import { pinnedLookup, qweatherQueryAllowed } from "./qweather.js";

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

describe("QWeather query policy", () => {
  it("allows the provider parameters used by weather collection", () => {
    expect(qweatherQueryAllowed(new URL("https://project.qweatherapi.com/geo/v2/city/lookup?location=北京&number=20&lang=zh"))).toBe(true);
    expect(qweatherQueryAllowed(new URL("https://project.qweatherapi.com/weather/v1/hourly/39.90/116.41?hours=12&localTime=true&lang=zh"))).toBe(true);
    expect(qweatherQueryAllowed(new URL("https://project.qweatherapi.com/airquality/v1/current/39.90/116.41?lang=zh"))).toBe(true);
  });

  it("rejects credentials, duplicate parameters, and parameters from another endpoint", () => {
    expect(qweatherQueryAllowed(new URL("https://project.qweatherapi.com/weather/v1/current/39.90/116.41?key=secret"))).toBe(false);
    expect(qweatherQueryAllowed(new URL("https://project.qweatherapi.com/weather/v1/current/39.90/116.41?lang=zh&lang=en"))).toBe(false);
    expect(qweatherQueryAllowed(new URL("https://project.qweatherapi.com/airquality/v1/current/39.90/116.41?hours=12"))).toBe(false);
  });
});
