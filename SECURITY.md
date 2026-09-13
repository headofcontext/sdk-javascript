# Security policy

This client carries tokens to the HeadOfContext service and returns its decisions. A wrong
decision is a service issue and belongs to
[the core repository](https://github.com/headofcontext/headofcontext/security/policy). What
belongs here is anything the client itself could get wrong on the way.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting: **Security → Report a
vulnerability** on <https://github.com/headofcontext/sdk-javascript/security/advisories/new>.
Include the client version, the runtime, a reproduction and the impact you observed. You will
get an acknowledgement within three working days and a fix or a mitigation plan within thirty
days for confirmed issues. Coordinated disclosure is the default; we will credit you unless you
prefer otherwise.

## What is in scope

- A token, a client secret or a document appearing in a log line, an error message or a stack
  trace. Only fingerprints may appear.
- The client presenting a decision as wider than the service returned it: an `ALLOW` where the
  body said `DENY`, a kept item the filter did not keep, an approval redeemed more than once.
- Credentials sent to a host other than the configured service or issuer, or over a downgraded
  connection.
- A request the client accepts without the token it should carry.

## What is out of scope

Decisions the service makes, the OpenFGA model, the identity provider, and findings in the
fictional ACME fixtures.

## Supported versions

The latest release and the `main` branch.
