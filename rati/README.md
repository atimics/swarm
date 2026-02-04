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

Available expansions:
| Expansion | Description |
|-----------|-------------|
| `platforms` | Telegram, Twitter, Discord, Web platform configs |
| `llm` | LLM provider/model configuration |
| `media` | Image/video generation settings |
| `scheduling` | Cron-based scheduled tasks |
| `behavior` | Response delays, cooldowns, context limits |
| `tools-secrets` | Enabled tools and required secrets |
| `voice` | TTS/voice clone configuration |
| `solana` | Solana wallet and token features |
| `energy` | Energy system (refill rates, costs) |
| `dnd` | Tabletop RPG/DnD character context |
| `nft-avatar` | NFT backing and trait mapping |
| `integrations` | AI provider and platform integration configs |
| `stickers` | Telegram sticker pack info |

The canonical runtime schema composes these via `allOf`.

## Validation

Validate avatar config files against the schema:

```bash
# Install dependencies (if needed)
pnpm add -D ajv ajv-formats yaml

# Validate a single file
npx tsx scripts/validate-avatar-config.ts avatars/my-agent/config.yaml

# Validate multiple files
npx tsx scripts/validate-avatar-config.ts avatars/*/config.yaml

# Validate examples
npx tsx scripts/validate-avatar-config.ts rati/examples/*.json rati/examples/*.yaml
```

## Compatibility notes

- The canonical runtime shape matches `packages/core/src/types/index.ts` (`AvatarConfig`).
- The file schema matches `packages/core/src/utils/config.ts` (`AvatarConfigFileSchema`).
- Legacy naming differences (example: older Twitter feature flags) are accepted where feasible, but are marked as deprecated.

## Versioning

- All schemas are versioned as `v1` and should be treated as immutable once published.
- Breaking changes require a new schema version file (e.g. `...v2.schema.json`).
