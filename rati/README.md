# RATi Avatar System Schema (Official Reference)

This folder defines the **official, versioned schema reference** for RATi avatars.

Goals:
- Provide a **stable base schema** for avatar identity + persona.
- Provide a **modular expansions system** (energy, DnD, social/platforms, NFT attributes, etc.).
- Stay **compatible with the current runtime config** (`@swarm/core` `AvatarConfig`) and the current YAML file format used in `avatars/*/config.yaml`.

## What’s in here

- Schemas live in `rati/schema/`.
- Examples live in `rati/examples/`.

Primary entrypoints:
- `rati/schema/avatar-config.v1.schema.json` — canonical **normalized runtime** avatar config.
- `rati/schema/avatar-config-file.v1.schema.json` — **config file** shape (supports the `avatar:` wrapper pattern).
- `rati/schema/nft/metadata.v1.schema.json` — RATi NFT metadata schema aligned with `docs/RATI_AVATAR_NFT_SPEC.md`.

## Base + Expansions model

The schema set is organized as:
- **Base**: `rati/schema/base/avatar-base.v1.schema.json`
- **Expansions** (composable partials): `rati/schema/expansions/*.v1.schema.json`

The canonical runtime schema composes these via `allOf`.

## Compatibility notes

- The canonical runtime shape matches `packages/core/src/types/index.ts` (`AvatarConfig`).
- The file schema matches `packages/core/src/utils/config.ts` (`AvatarConfigFileSchema`).
- Legacy naming differences (example: older Twitter feature flags) are accepted where feasible, but are marked as deprecated.

## Versioning

- All schemas are versioned as `v1` and should be treated as immutable once published.
- Breaking changes require a new schema version file (e.g. `...v2.schema.json`).
