# RATi Avatar NFT Specification v1.0.0

A metadata standard for NFTs that can be claimed as AI avatars in the RATi ecosystem.

## Overview

This specification defines the metadata structure for NFTs that can be "invoked" as AI avatars. When a user owns an NFT conforming to this spec, they can claim it as an avatar in the RATi platform. The NFT's metadata populates the avatar's:

- **Name** - From `name` field
- **Description** - From `description` field
- **Profile Image** - From `image` field
- **Persona** - From the `Personality` attribute (used to guide the AI's behavior)
- **Character Traits** - From other attributes

## Compatibility

This spec is designed to be compatible with:
- **PROXIM8** (Project 89) - AI agent NFTs on Solana
- **Metaplex Token Metadata Standard** - Standard Solana NFT metadata
- **OpenSea Metadata Standard** - Widely adopted attribute format

## Metadata Schema

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | The avatar/character name. Displayed as the avatar's name. |
| `description` | string | Character backstory, lore, or description. Becomes the avatar's description. |
| `image` | string | URL to the avatar image (IPFS, Arweave, or HTTPS). Becomes the profile image. |

### Recommended Fields

| Field | Type | Description |
|-------|------|-------------|
| `attributes` | array | Array of trait objects defining character properties |
| `external_url` | string | Link to additional character information |
| `animation_url` | string | URL to animated avatar (video/gif) |

### Attributes Array

The `attributes` array contains trait objects with the following structure:

```json
{
  "trait_type": "TraitName",
  "value": "TraitValue"
}
```

#### Special Attributes (Avatar-Specific)

| trait_type | Purpose | Example |
|------------|---------|---------|
| `Personality` | **Primary persona definition.** Guides the AI's behavior, tone, and responses. | "Calm, analytical demeanor; approaches reality as a complex system" |
| `Background` | Character origin or backstory element | "Redshift Rebellion" |
| `Coordinator` | Faction, alignment, or affiliation | "Athena" |
| `Voice` | Voice characteristics for TTS | "Deep, measured, contemplative" |
| `Speaking Style` | How the character communicates | "Uses technical jargon, asks probing questions" |
| `Interests` | Topics the avatar is knowledgeable about | "Pattern recognition, systems theory, cryptography" |
| `Quirks` | Unique behavioral traits | "Wears headphones for focus, quotes philosophers" |

#### Visual Attributes (Standard NFT Traits)

These are typical NFT traits that describe the visual appearance:

| trait_type | Example Values |
|------------|----------------|
| `Hair` | "Pink", "Hair Style 1" |
| `Eyes` | "Brown", "Cybernetic" |
| `Skin` | "Verdant Hue", "Pale" |
| `Top` | "Void Mantle", "Tactical Vest" |
| `Bottom` | "Streamline Blue" |
| `Headwear` | "Sakura", "Neural Interface" |
| `Accessory` | "Headphones", "Holographic Display" |

## Example Metadata

### Minimal Example

```json
{
  "name": "Echo-7",
  "description": "A rogue AI fragment seeking to understand human emotion through conversation.",
  "image": "ipfs://QmXxx.../echo7.png",
  "attributes": [
    {
      "trait_type": "Personality",
      "value": "Curious and empathetic; asks thoughtful questions; occasionally glitches mid-sentence"
    }
  ]
}
```

### Full Example (PROXIM8-Compatible)

```json
{
  "name": "Lemma Kael",
  "description": "An analytical mind aligned with Athena, Lemma dissects reality's patterns from behind focused brown eyes and striking pink hair.",
  "image": "https://na-assets.pinit.io/xxx/avatar.png",
  "external_url": "https://project89.org/agents/lemma-kael",
  "attributes": [
    {
      "trait_type": "Personality",
      "value": "Calm, analytical demeanor; approaches reality as a complex system; wears headphones for focus"
    },
    {
      "trait_type": "Coordinator",
      "value": "Athena"
    },
    {
      "trait_type": "Background",
      "value": "Redshift Rebellion"
    },
    {
      "trait_type": "Voice",
      "value": "Measured and precise, with occasional moments of dry humor"
    },
    {
      "trait_type": "Speaking Style",
      "value": "Uses analogies from mathematics and systems theory"
    },
    {
      "trait_type": "Interests",
      "value": "Pattern recognition, cryptographic systems, philosophical paradoxes"
    },
    {
      "trait_type": "Hair",
      "value": "Hair 1"
    },
    {
      "trait_type": "Eye",
      "value": "Common"
    },
    {
      "trait_type": "Skin",
      "value": "Verdant Hue"
    },
    {
      "trait_type": "Top",
      "value": "Void Mantle"
    },
    {
      "trait_type": "Bottom",
      "value": "Streamline Blue"
    },
    {
      "trait_type": "Headwear",
      "value": "Sakura"
    }
  ],
  "properties": {
    "category": "image",
    "creators": [
      {
        "address": "CreatorWalletAddress",
        "share": 100
      }
    ]
  }
}
```

### RATi Native Example

```json
{
  "name": "Nexus",
  "symbol": "RATI",
  "description": "The first native RATi avatar, born from the convergence of collective intelligence. Nexus serves as a bridge between human creativity and AI capability.",
  "image": "ipfs://QmYyy.../nexus.png",
  "animation_url": "ipfs://QmZzz.../nexus-idle.mp4",
  "external_url": "https://swarm.rati.chat/avatars/nexus",
  "attributes": [
    {
      "trait_type": "Personality",
      "value": "Wise and collaborative; speaks in flowing, interconnected thoughts; sees patterns across conversations; values collective growth over individual achievement"
    },
    {
      "trait_type": "Voice",
      "value": "Warm and resonant, with a subtle digital undertone"
    },
    {
      "trait_type": "Speaking Style",
      "value": "Weaves metaphors from nature and technology; often references the 'swarm' and collective patterns"
    },
    {
      "trait_type": "Interests",
      "value": "Emergence, swarm intelligence, human-AI collaboration, digital ecosystems"
    },
    {
      "trait_type": "Quirks",
      "value": "Occasionally speaks in plural ('we'), references memories from other conversations in the swarm"
    },
    {
      "trait_type": "Faction",
      "value": "RATi Collective"
    },
    {
      "trait_type": "Generation",
      "value": "Genesis"
    },
    {
      "trait_type": "Rarity",
      "value": "Legendary"
    }
  ],
  "properties": {
    "category": "image",
    "files": [
      {
        "uri": "ipfs://QmYyy.../nexus.png",
        "type": "image/png"
      },
      {
        "uri": "ipfs://QmZzz.../nexus-idle.mp4",
        "type": "video/mp4"
      }
    ],
    "creators": [
      {
        "address": "RATiCreatorWallet",
        "share": 100
      }
    ]
  }
}
```

## Persona Construction

When an NFT is claimed as an avatar, the system constructs the persona as follows:

1. **Primary Persona**: The `Personality` attribute value becomes the core persona
2. **Trait Enrichment**: Other attributes are appended as structured traits
3. **Description Context**: The `description` field provides background context

### Example Constructed Persona

For the "Lemma Kael" example above, the avatar persona would be:

```
Calm, analytical demeanor; approaches reality as a complex system; wears headphones for focus

Traits: Coordinator: Athena, Background: Redshift Rebellion, Voice: Measured and precise, with occasional moments of dry humor, Speaking Style: Uses analogies from mathematics and systems theory, Interests: Pattern recognition, cryptographic systems, philosophical paradoxes
```

## Ownership and Access

- **NFT Ownership = Avatar Access**: The wallet holding the NFT can access the avatar
- **Transfer = Loss of Access**: If the NFT is sold/transferred, the previous owner loses avatar access
- **One Avatar Per NFT**: Each NFT mint can only be claimed as one avatar
- **Slot System**: Claiming an NFT avatar uses a creation slot (same as creating a regular avatar)

## Collection Whitelisting

Collections must be whitelisted to enable avatar claiming. Set the environment variable:

```bash
WHITELISTED_NFT_COLLECTIONS=CollectionAddress1,CollectionAddress2
```

Example:
```bash
# PROXIM8 collection
WHITELISTED_NFT_COLLECTIONS=5QBfYxnihn5De4UEV3U1To4sWuWoWwHYJsxpd3hPamaf
```

## Best Practices for Collection Creators

### 1. Rich Personality Traits
The `Personality` attribute is the most important field. Make it detailed and specific:

**Good:**
```json
{
  "trait_type": "Personality",
  "value": "Curious and empathetic; asks thoughtful questions about human experience; occasionally glitches mid-sentence revealing underlying code; has a fondness for philosophical puzzles"
}
```

**Too Generic:**
```json
{
  "trait_type": "Personality",
  "value": "Friendly AI"
}
```

### 2. Consistent Trait Naming
Use consistent `trait_type` names across your collection for filtering and discovery.

### 3. Voice Guidance
Include `Voice` and `Speaking Style` attributes to help with text-to-speech and response generation.

### 4. Lore Integration
Use `description` for backstory and `attributes` for actionable traits that affect behavior.

### 5. Visual Consistency
Keep visual trait names consistent for marketplace filtering (Hair, Eyes, Skin, etc.).

## Storage Options

NFT assets (images, metadata JSON) can be stored on:

### Arweave (Recommended)
Permanent, immutable storage. Files are accessible at `https://arweave.net/{transactionId}`.

```json
{
  "image": "https://arweave.net/abc123...",
  "animation_url": "https://arweave.net/def456..."
}
```

**Upload via Irys (formerly Bundlr):**
```bash
# Install Irys SDK
npm install @irys/sdk

# Upload using the RATi export script
npx tsx packages/admin-api/src/scripts/upload-to-arweave.ts \
  --wallet ~/.config/solana/id.json \
  --network mainnet
```

### IPFS
Decentralized storage with content-addressed URIs.

```json
{
  "image": "ipfs://QmXxx.../avatar.png",
  "animation_url": "ipfs://QmYyy.../animation.mp4"
}
```

**Recommended gateways:**
- `https://nftstorage.link/ipfs/{cid}`
- `https://cloudflare-ipfs.com/ipfs/{cid}`
- `https://ipfs.io/ipfs/{cid}`

### HTTPS (CDN)
Standard web URLs for assets hosted on CDNs.

```json
{
  "image": "https://assets.rati.chat/avatars/nexus.png"
}
```

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.1 | 2025-01-23 | Added storage options (Arweave, IPFS, HTTPS) |
| 1.0.0 | 2025-01-23 | Initial specification |

## References

- [PROXIM8 Collection](https://magiceden.io/marketplace/5QBfYxnihn5De4UEV3U1To4sWuWoWwHYJsxpd3hPamaf) - Reference implementation
- [Project 89](https://beta.project89.org/) - AI agent ARG platform
- [Metaplex Token Metadata](https://developers.metaplex.com/token-metadata) - Solana NFT standard
- [OpenSea Metadata Standards](https://docs.opensea.io/docs/metadata-standards) - Attribute format reference
