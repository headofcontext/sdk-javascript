# Contributing

This repository is the JavaScript / TypeScript client of
[HeadOfContext](https://github.com/headofcontext/headofcontext). It is deliberately thin, and
the rules below keep it that way.

## What the client is

1. **No runtime dependency.** The client uses the global `fetch` and nothing else. It never
   imports the core package: the service API is the only boundary between the two, and
   `contract/openapi.json` is that boundary written down.
2. **The client never decides.** It transports tokens and returns the service's decisions. A
   denial is a normal result (`outcome === "DENY"`); an authentication or token failure throws.
3. **Tokens never appear in logs or error messages**, only their fingerprints.
4. **The contract is copied, never edited.** `scripts/sync_contract.sh` copies `docs/openapi.json`
   from a core checkout and records the core commit in `contract/core-ref`. CI runs the contract
   tests against that exact commit and fails if the two files differ.

## How to work

1. Write the unit test first, over the fake service in `tests/unit/fake-service.ts` (a `fetch`
   shaped by the contract). Every public method has one.
2. When the change follows a service change, sync the contract once the core commit is pushed,
   then add or adjust a test in `tests/contract`.
3. Run the checks before opening the pull request:

   ```
   pnpm install
   pnpm check          # biome, tsc, unit tests, build
   HOC_API_URL=http://localhost:8000 HOC_KEYCLOAK_URL=http://localhost:8180 pnpm test:contract
   ```

   The contract tests need the core's local stack (`docker compose up -d`, `hoc model load`,
   `hoc fixtures load`, then the service on port 8000). They are skipped when the two variables
   are unset.
4. One concern per pull request, Conventional Commits, in English, with the why. Merges are
   squashed: the pull request title becomes the commit on `main` and decides the next version
   (`feat` bumps the minor, `fix` the patch; `feat!:` marks a breaking change), and the release
   notes are generated from it. There is no changelog file to edit.
5. Never add a runtime dependency, never widen what the service decided, never copy code under
   a licence incompatible with Apache 2.0.

Security issues go through [`SECURITY.md`](SECURITY.md), not the issue tracker.
Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
