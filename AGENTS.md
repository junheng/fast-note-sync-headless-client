# Fast Note Sync Headless Client — Agent Instructions

## Project identity

This repository is a maintained fork of `haierkeys/obsidian-fast-note-sync`.
Its product direction is a Node.js headless sync client. The inherited Obsidian plugin build remains supported. Node bidirectional file
sync, daemon entry points and versioned conflict resolution are implemented;
directory operations, resource validation and Hermes acceptance remain pending. Do not claim the full MVP complete.
Read `docs/headless/HANDOFF.md` and `docs/headless/UPSTREAM.md` before implementation.
Use the formal stable upstream release pinned in `docs/headless/BASELINE.json`,
not the tip of `master` or `main`. Review unreleased fixes as explicit, tested backports.

## Boundaries

- Follow the official stable plugin behavior. Do not fix inherited upstream issues,
  modify the server, or make stronger remote CAS/identity guarantees a delivery
  prerequisite. Document inherited limitations; preserve headless persistence,
  version-specific acknowledgements and local filesystem protections.
- Reuse upstream protocol behavior and extract narrow host interfaces. Avoid a full
  fake Obsidian runtime or a second handwritten protocol implementation.
- Keep the original plugin build working while extracting the shared core.
- Keep Hermes-specific deployment, credentials and Kanban integration in the
  separate Hermes Ops repository. This client exposes a generic conflict contract.
- Preserve upstream history and attribution. Keep custom changes small and reviewable.
- Do not carry experimental Python CLI patches into this project as the foundation.
- Use Chinese for user documentation; English for code, schema fields and logs.

## Data integrity

- Never treat connection/authentication or a sent message as successful synchronization.
  Require operation acknowledgements, completed batches and durable checkpoints.
- Never resolve conflicts using timestamps alone. Preserve base/local/remote versions.
- In the Hermes integration, the librarian owns conflict resolution. Revalidate the
  versions after resolution; a stale decision must produce a fresh conflict.
- Missing history, failed scans and missing files are not automatically deletion intent.
- Use atomic writes, durable pending operations, bounded resource use and exclusive
  ownership of a local sync state directory. Reject paths escaping the configured vault.
- Do not expose credentials, note contents or private paths in ordinary logs or tests.
- Use synthetic fixtures and isolated directories first. Production credentials, runtime
  data, backups and `.env` files must never be committed.
- Production cutover belongs to an explicit Ops deployment with a verified backup;
  stop the old writer before enabling the new writer.

## Development and validation

- Honor the pinned package manager and runtime declared by the project.
- Establish the inherited test/build baseline before refactoring. Record failures as
  upstream baseline evidence; do not silently bypass them.
- Add protocol and state-machine tests for behavior changes, including crashes,
  duplicate/out-of-order events, conflicts and offline deletions.
- Keep upstream changes and headless changes in separate commits when practical.
- Never run inherited release or mirror workflows to publish a headless release.
  Replace or gate them as part of the explicit release milestone.
- If this checkout has no `.codegraph/codegraph.db`, use ordinary source inspection;
  do not initialize an index without a user request.
