# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest `main` | ✅ Active security support |
| Older tags / branches | ❌ No security backports |

Only the current `main` branch receives security fixes.  Users on older
releases are strongly encouraged to upgrade before reporting issues against
those versions.

---

## Reporting a Vulnerability

**Please do NOT file a public GitHub issue for security vulnerabilities.**

We use [GitHub Private Security Advisories][ghsa] for coordinated disclosure.
To open a private report:

1. Go to **Security → Advisories → Report a vulnerability** on the GitHub
   repository page for this project.
2. Fill in the template — the more detail the better.
3. We will acknowledge the report within **5 business days** and aim to
   provide a fix or mitigation timeline within **15 business days**.

If you are unable to use GitHub's advisory system, you may reach the
maintainers via the contact method listed in the repository profile.

[ghsa]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability

---

## Scope

The following are **in scope** for security reports:

- Authentication bypasses, session fixation, or improper token handling
- Authorization bypasses or privilege escalation in the API
- Remote code execution or command injection
- SQL or NoSQL injection
- Cross-site scripting (XSS) or cross-site request forgery (CSRF)
- Insecure direct object references in the API
- Secrets or credentials exposed in logs, responses, or build artifacts
- Container escape or dangerous Linux capability exposure
- Supply-chain or dependency tampering
- Path traversal or arbitrary file read/write
- WebSocket authentication weaknesses
- Rate-limit bypass in authentication flows
- Denial-of-service requiring no authentication

The following are **out of scope**:

- Issues in NapCat, SnowLuma (TRSS Mirai), or other upstream components
  (please report those to the respective upstream projects)
- Social engineering
- Physical attacks
- Findings from automated scanners without a working proof-of-concept
- Rate limiting for non-authentication endpoints where the risk is minimal

---

## Disclosure Policy

- We follow **coordinated disclosure**: we ask reporters to keep findings
  confidential until a fix is released or 90 days have elapsed, whichever
  comes first.
- We will credit reporters in release notes and the advisory unless they
  prefer anonymity.
- We will not take legal action against good-faith security researchers.

---

## Accidentally Committed Secrets

If you discover credentials, API keys, tokens, or other secrets that appear to
have been committed to this repository (including in the Git history):

1. **Report it immediately** via the private advisory channel above.
2. Do **not** attempt to use or further access any systems the secret may
   control — that crosses into unauthorised access.
3. We will treat the secret as compromised, revoke/rotate it, and determine
   whether git-history rewriting is necessary.

---

## Security-Relevant Configuration

The following configuration items have security implications.  See the inline
documentation in `deploy/.env.example` and the README for guidance:

| Setting | Purpose |
|---------|---------|
| `QQ_GUARDIAN_JWT_SECRET` | JWT signing key — must be a strong random secret injected via environment variable |
| `QQ_GUARDIAN_AI_API_KEY` | AI provider key — inject via environment variable, never commit |
| `SNOWLUMA_ACCESS_TOKEN` | Authenticates SnowLuma → Guardian OneBot events — must be a strong random secret |
| `VNC_PASSWD` | noVNC access password — required, no empty default |
| `auth.trustedProxyCidrs` | List of trusted reverse-proxy CIDRs — empty by default; set only if running behind a known proxy |
| `QQ_GUARDIAN_HTTP_HOST` | Management listener bind address — defaults to `127.0.0.1`; set to `0.0.0.0` explicitly for container deployments |

---

## Response Expectations

| Step | Target |
|------|--------|
| Acknowledgement | ≤ 5 business days |
| Initial triage | ≤ 10 business days |
| Fix or mitigation plan | ≤ 15 business days |
| Public advisory | After fix is released or 90 days, whichever comes first |
