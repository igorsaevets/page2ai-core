# Security Policy

## Supported versions

Only the latest release on npm receives security updates.

| Version | Supported |
|---------|-----------|
| 0.1.x (latest) | Yes |
| older | No |

## Reporting a vulnerability

Please do not open a public issue for security reports.

Preferred: GitHub private reporting for this repository:
https://github.com/igorsaevets/page2ai-core/security/advisories/new

Alternative: email **igorsaevets@gmail.com** with subject `[page2ai-core Security] <short description>`. Include what you found, how to reproduce it, and the potential impact. Expect a response within 3 business days.

## Scope

`@page2ai/core` parses untrusted HTML. Reports of particular interest:

- HTML input that causes catastrophic performance (ReDoS, unbounded memory) or a crash
- Markdown output that smuggles content not present in the source page (injection through the converter)
- Any way a parsed page can reach code execution in the host process

The Node adapter's `fetchProtected` helper performs network requests with an SSRF guard; bypasses of that guard are in scope. Everything else network-related is the caller's responsibility.
