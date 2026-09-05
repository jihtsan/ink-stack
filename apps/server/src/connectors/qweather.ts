import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { IncomingHttpHeaders } from "node:http";
import { validateTarget } from "../data/target.js";
import type { CredentialStore } from "../data/credentials.js";
import type { QWeatherRequest, QWeatherTransport } from "@ink-stack/widgets/weather/server";

const MAX_RESPONSE_BYTES = 262_144;
const MAX_COMPRESSED_BYTES = 1_048_576;

/**
 * The QWeather widget only hands this client an allowlisted URL and a secret
 * reference. The client resolves the reference at request time and pins the
 * first validated DNS answer for the TLS connection. No response body or
 * credential is logged or forwarded to the browser.
 */
export class QWeatherHttpClient {
  private readonly readSecret: (connectionId: string, secretRef: string) => string | undefined;

  constructor(credentials: CredentialStore | ((connectionId: string, secretRef: string) => string | undefined)) {
    this.readSecret = typeof credentials === "function"
      ? credentials
      : (connectionId, secretRef) => credentials.read(connectionId, secretRef);
  }

  readonly transport: QWeatherTransport = async (request) => this.get(request);

  private async get(request: QWeatherRequest): Promise<unknown> {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || !isAllowedPath(url.pathname) || request.method !== "GET" || request.redirect !== "error") {
      throw new Error("target_not_allowed");
    }

    const target = await validateTarget(url.href, [url.origin]);
    const secret = this.readSecret(connectionIdFromSecretRef(request.authentication.secretRef), request.authentication.secretRef);
    if (!secret) throw new Error("credential_missing");
    const authorization = request.authentication.prefix === "Bearer " ? `Bearer ${secret}` : secret;
    const headerName = request.authentication.header;

    return await readJsonResponse({
      url,
      address: target.addresses[0]!,
      headers: {
        accept: "application/json",
        "accept-encoding": "gzip, br, deflate",
        [headerName]: authorization
      },
      timeoutMs: request.timeoutMs,
      signal: request.signal
    });
  }
}

/** The credential id is globally unique; its owning connection is checked by
 * CredentialStore. This helper leaves the owner argument empty for the read
 * call, so the store can validate the id against its own row. */
function connectionIdFromSecretRef(_secretRef: string): string {
  // CredentialStore.read requires an owner. The weather connection id is
  // encoded into the generated credential id as `qweather:<connection>:...`.
  // The caller-created ids are opaque to the browser but recoverable here.
  const parts = _secretRef.split(":");
  return parts.length >= 3 && parts[0] === "qweather" ? parts[1]! : "";
}

function isAllowedPath(pathname: string): boolean {
  return pathname === "/geo/v2/city/lookup"
    || pathname === "/v7/weather/now"
    || pathname === "/v7/weather/3d"
    || /^\/weather\/v1\/current\/-?\d+(?:\.\d+)?\/-?\d+(?:\.\d+)?$/.test(pathname)
    || /^\/weather\/v1\/daily\/-?\d+(?:\.\d+)?\/-?\d+(?:\.\d+)?$/.test(pathname);
}

async function readJsonResponse(options: {
  url: URL;
  address: string;
  headers: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let compressedBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => request.destroy(new Error("request_aborted"));
    const request = httpsRequest(options.url, {
      method: "GET",
      headers: options.headers,
      // The DNS result was checked immediately before connecting. Supplying
      // the fixed answer avoids a second resolver decision in the socket.
      lookup: (_hostname, _lookupOptions, callback) => callback(null, options.address, isIP(options.address) === 6 ? 6 : 4),
      servername: options.url.hostname,
      rejectUnauthorized: true,
      setHost: true
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        finish(undefined, { code: "redirect" });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        finish(undefined, { code: String(status || "network") });
        return;
      }
      const decoded = decodeBody(response, response.headers);
      const chunks: Buffer[] = [];
      let decodedBytes = 0;
      decoded.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        decodedBytes += bytes.length;
        if (decodedBytes > MAX_RESPONSE_BYTES) {
          decoded.destroy(new Error("response_too_large"));
          request.destroy();
          finish(new Error("response_too_large"));
          return;
        }
        chunks.push(bytes);
      });
      decoded.on("error", (error) => finish(new Error(error instanceof Error && error.message === "response_too_large" ? "response_too_large" : "response_decode_failed")));
      decoded.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          finish(undefined, JSON.parse(text));
        } catch {
          finish(new Error("response_invalid_json"));
        }
      });
    });
    request.on("error", () => finish(new Error("network_error")));
    request.on("response", (response) => {
      response.on("data", (chunk: Buffer | string) => {
        compressedBytes += Buffer.byteLength(chunk);
        if (compressedBytes > MAX_COMPRESSED_BYTES) request.destroy(new Error("response_too_large"));
      });
    });
    timer = setTimeout(() => request.destroy(new Error("request_timeout")), options.timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    request.end();
  });
}

function decodeBody(response: IncomingMessage, headers: IncomingHttpHeaders): Readable {
  const encoding = String(headers["content-encoding"] ?? "").toLowerCase();
  if (encoding.includes("gzip")) return response.pipe(createGunzip());
  if (encoding.includes("br")) return response.pipe(createBrotliDecompress());
  if (encoding.includes("deflate")) return response.pipe(createInflate());
  return response;
}
