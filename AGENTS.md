# InkStack development guidance

## Product

InkStack (墨栈) is a configurable widget dashboard for e-ink displays. The server generates PNG images; a device client downloads and displays them on a schedule. Start with kndl-online-screensaver on jailbroken Kindles.

## Current state

This repository currently contains a project skeleton and design drafts. Do not describe planned features as implemented. Update this section when runnable application code is introduced.

## Boundaries

- `apps/web`: configuration UI and preview.
- `apps/server`: persistence, data fetching, rendering and HTTP delivery.
- `packages/widgets`: widget definitions and renderers.
- `packages/shared`: contracts shared between modules; no server secrets.
- `devices/kindle`: device integration and operational documentation.

## Working agreements

- Keep changes focused on the requested scope; prefer small, reviewable commits.
- Read `docs/architecture.md` and `docs/widgets.md` before implementing cross-module behavior.
- Keep credentials on the server and out of public configuration or images.
- Never execute uploaded widget code or arbitrary commands from dashboard configuration.
- Distinguish serving a PNG from installing device software or modifying firmware.
- Do not bundle external client code, fonts or binaries without checking their licenses and attribution requirements.
- Verify changed behavior with the smallest relevant check. Record device behavior as unverified unless tested on the actual model and firmware.
- Keep the Chinese README accurate, including runnable commands and known limitations.

## Commits

Use the Lore protocol: a concise intent line explaining why, followed by useful decision trailers such as `Constraint:`, `Confidence:`, `Scope-risk:`, `Tested:` and `Not-tested:`. Do not invent test results.
