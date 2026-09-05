# Stitch MCP

This project-scoped Codex configuration connects to the Stitch Streamable HTTP
MCP server. The API key is intentionally read from the local `STITCH_API_KEY`
environment variable and is not stored in this repository.

Before starting Codex for this project, set the key in the environment used by
Codex:

```sh
export STITCH_API_KEY='your-stitch-api-key'
```

Then restart Codex and verify the server with `/mcp` or `codex mcp list`.
