# InkStack development guidance

## Product

InkStack (墨栈) is a configurable widget dashboard for e-ink displays. The server generates PNG images; a device client downloads and displays them on a schedule. Start with kndl-online-screensaver on jailbroken Kindles.

## Current state

This repository contains the first runnable local application: React/Vite editor, Fastify/SQLite server, four built-in widgets, worker-based grayscale PNG rendering, and a read-only local Codex connector. See docs/verification.md for actual validation evidence and remaining gates. Kindle hardware and battery-life acceptance remain unverified.

## Boundaries

- `apps/web`: configuration UI and preview.
- `apps/server`: persistence, data fetching, rendering and HTTP delivery.
- `packages/widgets`: one folder per widget type, with metadata, configuration, rendering, optional server data loading, and fixtures.
- `packages/shared`: shared contracts and pure grid validation/pixel conversion; no server secrets.
- `devices/kindle`: device integration and operational documentation.

## Working agreements

- Keep changes focused on the requested scope; prefer small, reviewable commits.
- Read `docs/design-v1.md`, `docs/architecture.md`, `docs/grid-layout.md`, and `docs/widgets.md` before implementing cross-module behavior.
- Persist integer grid positions and spans, not independent pixel coordinates. Reject overlap, out-of-bounds placement, and unsupported sizes on the server as well as in the editor.
- Keep the browser-facing widget catalog separate from server-only rendering and data-loading registration.
- Keep credentials on the server and out of public configuration or images.
- Never execute uploaded widget code or arbitrary commands from dashboard configuration.
- Distinguish serving a PNG from installing device software or modifying firmware.
- Do not bundle external client code, fonts or binaries without checking their licenses and attribution requirements.
- Verify changed behavior with the smallest relevant check. Record device behavior as unverified unless tested on the actual model and firmware.
- Keep the Chinese README accurate, including runnable commands and known limitations.

## Commits

Use the Lore protocol: a concise intent line explaining why, followed by useful decision trailers such as `Constraint:`, `Confidence:`, `Scope-risk:`, `Tested:` and `Not-tested:`. Do not invent test results.
