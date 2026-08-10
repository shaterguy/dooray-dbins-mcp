# Security

## Secrets

- Never commit `MCP_PATH_TOKEN`, `MCP_ACCESS_KEY`, `DOORAY_API_TOKEN`, `DOORAY_USERNAME`, `DOORAY_PASSWORD`, cookies, or upstream response dumps.
- Store secrets only in Vercel Environment Variables or a local ignored `.env.local` file.
- Rotate a secret immediately if it appears in a commit, issue, build log, screenshot, or chat message.

## Read-only boundaries

- CardDAV source and address-book hrefs are fixed/validated; arbitrary upstream URLs are not accepted.
- Dooray REST requests are restricted to HTTPS, an allowlisted host, safe `/<service>/v<number>/...` paths, GET, no redirects, bounded responses, and non-binary responses.
- CalDAV uses only discovery/read PROPFIND and REPORT requests.
- CardDAV is fixed to the personal and organization Dooray HTTPS origins, reuses the shared Dooray credentials, and uses only OPTIONS, PROPFIND, REPORT, and bounded GET reads. Redirects and hrefs outside the selected origin are rejected; raw vCards and sensitive properties are not returned.
- LDAP uses bind, bounded search, and unbind; filters and group member DNs are constrained.

## MCP ingress

- A 64-character URL-safe path token is required. Direct `/api/mcp`, alternate routes, and invalid path tokens are rejected.
- Optional `MCP_ACCESS_KEY` supports Bearer, `X-MCP-Access-Key`, and a compatibility query parameter with constant-time comparison.
- Origins are restricted to the ChatGPT allowlist plus explicitly configured additional origins.
- Requests, responses, and health output use no-store, no-referrer, and nosniff headers; body size is bounded.

Report suspected issues without including live credentials or private upstream response data.

