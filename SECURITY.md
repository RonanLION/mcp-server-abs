# Security policy

## Supported versions

Security fixes are applied to the latest release on the default branch.

## Reporting a vulnerability

Please use GitHub's private **Report a vulnerability** flow under the repository's Security tab when it is available. If that option is unavailable, open an issue containing no vulnerability details and ask the maintainer to arrange a private reporting channel. Do not disclose an unpatched vulnerability in a public issue.

Include the affected version, reproduction steps, impact, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Security model

This server is read-only and makes `GET` requests only to the fixed `https://data.api.abs.gov.au` origin. It accepts no credentials. Query responses are untrusted external data and should not be treated as instructions.
