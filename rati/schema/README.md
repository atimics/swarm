# RATi Schemas

Schemas in this folder are JSON Schema Draft 2020-12.

## Entry points

- `avatar-config.v1.schema.json` — normalized runtime config (canonical).
- `avatar-config-file.v1.schema.json` — YAML/JSON file config format.

## Composition

The canonical runtime schema uses `allOf` to compose:
- Base identity/persona schema
- Required runtime expansions (platforms, llm, media, scheduling, behavior, tools/secrets)
- Optional expansions (voice, solana, energy, dnd, nft)

## Conventions

- Schemas are written to be readable and “product spec”-like.
- Optional expansions are added as optional properties at the top level (e.g. `energy`, `dnd`, `nft`).
- Future/experimental extensions can be added under `extensions`.
