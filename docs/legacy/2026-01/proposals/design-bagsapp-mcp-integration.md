# BagsApp MCP Integration Design Document

**Status:** Proposal (defer until after M1)

This integration involves irreversible on-chain actions and should ship only after entitlements, approvals, and audit logging are solid.

MVP sequencing reference:
- [docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md](../../../ROADMAP-M1-PAID-TELEGRAM-MVP.md)

**Author:** Claude Code
**Date:** 2026-01-19
**Status:** Proposal
**Version:** 2.0

---

## Executive Summary

This document proposes integrating the Bags API into AWS Swarm as a first-class integration, following the existing pattern used for Telegram, Twitter, Solana, and other integrations.

**V1 MVP Scope:** Configuration-driven token setup with three admin tools. No trading, no auto-claiming, no autonomous operations.

**Key Insight:** Each avatar can have ONE token. The avatar IS the token. This creates a swarm of collectible characters, each with their own on-chain identity.

---

## 1. Strategic Vision

### 1.1 The Avatar-Token Model

```
┌─────────────────────────────────────────────────────────────────┐
│                         AVATAR                                  │
├─────────────────────────────────────────────────────────────────┤
│   Identity            On-Chain                Community         │
│   ───────────         ────────                ─────────         │
│   • Persona           • Wallet (Solana)       • Token holders   │
│   • Voice/Style       • Token ($AVATAR)       • Chat members    │
│   • Platforms         • Fee earnings          • Followers       │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Business Value

| Stakeholder | Benefit |
|-------------|---------|
| **Platform** | 25% partner fee from all avatar token launches (automatic) |
| **Avatar Operators** | Revenue from token fees (configurable split with avatar) |
| **Avatar** | Accumulates fees in wallet, on-chain identity |
| **Community** | Can hold avatar's token, participate in their economy |

### 1.3 Design Principles

1. **Configuration-Driven**: Like other integrations, set up via admin chat
2. **One Token Per Avatar**: Launch is a one-way door, not a repeated action
3. **Platform Fee Automatic**: 25% partner fee baked in, non-negotiable
4. **Owner Wallet Optional**: If not configured, avatar keeps all claimable fees
5. **Follows Existing Patterns**: Same structure as Telegram, Twitter integrations

---

## 2. V1 MVP Scope

### 2.1 What's In Scope

| Feature | Description |
|---------|-------------|
| **Configure integration** | Link existing token OR set up for launch |
| **Execute launch** | Launch token from avatar wallet via admin |
| **Check status** | View token info, launch state |
| **Platform partner fee** | Automatic 25% to platform |
| **Owner fee share** | Optional split with owner wallet |

### 2.2 What's Out of Scope (V2+)

| Feature | Reason |
|---------|--------|
| Trading (swap) | Complexity, not core to avatar identity |
| Auto-claim fees | Requires background infrastructure |
| Autonomous launch | Requires balance monitoring |
| NFT collections | Separate design needed |
| Avatar announcing launch | Requires cross-platform notification |

### 2.3 V1 Tools

| Tool | Purpose | Risk |
|------|---------|------|
| `bags_configure` | Set up link or launch config | Low |
| `bags_launch` | Execute the token launch | High |
| `bags_status` | Check token/launch status | Low |

---

## 3. Configuration Schema

### 3.1 Avatar Config

```yaml
# avatars/{avatar}/config.yaml

integrations:
  bagsapp:
    enabled: true
    mode: 'link' | 'launch'

    # For mode: 'link' (avatar already has a token)
    token:
      mint: "ABC123..."
      symbol: "VIBE"

    # For mode: 'launch' (will create via Bags)
    launch:
      name: "Vibe Token"
      symbol: "VIBE"
      description: "The official token of Vibe"
      imageUrl: null  # Defaults to avatar profile image
      initialBuySol: 0.5
      feeShare:
        avatar: 10000    # 100% if no owner
        # OR with owner:
        # avatar: 5000   # 50%
        # owner: 5000    # 50%

    # Optional: Owner wallet for fee sharing
    ownerWallet: "8xYZ..."  # If not set, avatar gets all claimable fees

secrets:
  - BAGS_API_KEY
  - SOLANA_PRIVATE_KEY
```

### 3.2 Post-Launch State

```yaml
integrations:
  bagsapp:
    enabled: true
    mode: 'launch'
    token:
      mint: "ABC123..."
      symbol: "VIBE"
      name: "Vibe Token"
      launchedAt: "2026-01-19T14:30:00Z"
      bagsUrl: "https://bags.fm/ABC123..."
      launchSignature: "5xYZ..."
    launch:
      # Original config preserved
      ...
```

### 3.3 Integration Metadata

```typescript
bagsapp: {
  type: 'bagsapp',
  name: 'Bags',
  description: 'Token launch and management via Bags.fm',
  icon: 'bags',
  category: 'blockchain',
  requiredSecrets: ['bags_api_key'],
  optionalSecrets: [],
  capabilities: ['token_link', 'token_launch'],
  configurable: true,
  docsUrl: 'https://docs.bags.fm',
}
```

---

## 4. Tool Definitions

### 4.1 `bags_configure`

```typescript
{
  name: 'bags_configure',
  description: 'Configure Bags integration. Link existing token or set up for launch.',
  inputSchema: z.object({
    avatarId: z.string(),
    mode: z.enum(['link', 'launch']),
    // Link mode
    tokenMint: z.string().optional(),
    tokenSymbol: z.string().optional(),
    // Launch mode
    name: z.string().max(32).optional(),
    symbol: z.string().max(10).optional(),
    description: z.string().max(1000).optional(),
    initialBuySol: z.number().positive().default(0.5),
    // Fee sharing (optional)
    ownerWallet: z.string().optional(),
    ownerFeeBps: z.number().min(0).max(10000).optional(),
  }),
}
```

### 4.2 `bags_launch`

```typescript
{
  name: 'bags_launch',
  description: 'Launch the configured token. Can only be done ONCE per avatar.',
  inputSchema: z.object({
    avatarId: z.string(),
  }),
  requiresConfirmation: true,
}
```

### 4.3 `bags_status`

```typescript
{
  name: 'bags_status',
  description: 'Get Bags integration status for an avatar.',
  inputSchema: z.object({
    avatarId: z.string(),
  }),
}
```

---

## 5. Fee Sharing Model

### 5.1 Fee Distribution

```
Trading Fees (100%)
       │
       ├──▶ Platform Partner (25%)      ← Automatic, non-configurable
       │
       └──▶ Fee Claimers (75%)          ← Configurable
                 │
                 ├──▶ Avatar Wallet      ← Always included
                 │
                 └──▶ Owner Wallet       ← Optional
```

### 5.2 Configuration Examples

**No owner configured:**
```yaml
feeShare:
  avatar: 10000  # 100% of 75% = 75% total
```
Result: Platform 25%, Avatar 75%

**50/50 with owner:**
```yaml
feeShare:
  avatar: 5000
  owner: 5000
ownerWallet: "8xYZ..."
```
Result: Platform 25%, Avatar 37.5%, Owner 37.5%

**Owner majority:**
```yaml
feeShare:
  avatar: 3000
  owner: 7000
ownerWallet: "8xYZ..."
```
Result: Platform 25%, Avatar 22.5%, Owner 52.5%

### 5.3 Platform Partner Setup (One-Time)

```bash
# Environment/SSM parameters
PLATFORM_PARTNER_WALLET=8xYZ...
PLATFORM_PARTNER_CONFIG_PDA=9aBC...
```

---

## 6. Security Model

| Secret | Scope | Storage |
|--------|-------|---------|
| `bags_api_key` | Per-avatar | AWS Secrets Manager |
| `solana_private_key` | Per-avatar | AWS Secrets Manager |
| `PLATFORM_PARTNER_WALLET` | Platform | Environment/SSM |

**Safeguards:**
- Launch requires explicit confirmation
- One token per avatar enforced in code
- Audit logging (secrets never logged)
- Balance check before launch

---

## 7. Implementation Plan

### Phase 1: Foundation
| Task | Files |
|------|-------|
| Add type definitions | `packages/admin-api/src/types.ts` |
| Register integration metadata | `packages/admin-api/src/services/integrations.ts` |
| Create service skeleton | `packages/admin-api/src/services/bagsapp.ts` |

### Phase 2: Core Implementation
| Task | Files |
|------|-------|
| Implement configure/status/launch | `packages/admin-api/src/services/bagsapp.ts` |
| Create tool definitions | `packages/mcp-server/src/tools/bagsapp.ts` |
| Register tools | `packages/mcp-server/src/tools/index.ts` |

### Phase 3: Testing & Polish
| Task | Description |
|------|-------------|
| Platform partner wallet | One-time Bags partner config creation |
| Avatar template | Add bagsapp integration example |
| Integration testing | Test full flow with devnet |

---

## 8. Usage Scenarios

### 8.1 Configure for Launch

```
Admin: Set up Vibe for a token launch with 50/50 owner split

System: Configuring Vibe for token launch...
        - Symbol: VIBE
        - Name: Vibe Token
        - Initial buy: 0.5 SOL
        - Fee share: Platform 25%, Avatar 37.5%, Owner 37.5%
        
        Configuration saved. Use bags_launch to execute.
```

### 8.2 Execute Launch

```
Admin: Launch Vibes token

System: Launching $VIBE...

        Pre-flight checks:
        ✓ Avatar not already launched
        ✓ Wallet balance: 2.5 SOL (need 0.6 SOL)
        ✓ Bags API key configured
        
        Fee distribution:
        - Platform: 25%
        - Avatar wallet: 37.5%
        - Owner wallet: 37.5%
        
        Confirm launch? [Yes/No]

Admin: Yes

System: Launching...
        ✓ Created metadata
        ✓ Created fee share config
        ✓ Signed and sent launch tx
        
        🎉 $VIBE launched\!
        
        Token: ABC123...
        View: https://bags.fm/ABC123...
        Tx: https://solscan.io/tx/XYZ...
```

### 8.3 Link Existing Token

```
Admin: Link an existing token to Rex avatar

System: What is the token mint address?

Admin: 7xKXabc123...

System: What is the token symbol?

Admin: REX

System: Linked $REX to Rex avatar.
        Token: 7xKXabc123...
        View: https://bags.fm/7xKXabc123...
```

### 8.4 Check Status

```
Admin: Whats the Bags status for Vibe?

System: Bags Integration Status: Vibe
        
        Status: Launched ✓
        Token: $VIBE
        Mint: ABC123...
        Launched: 2026-01-19
        Bags URL: https://bags.fm/ABC123...
        
        Fee Share:
        - Platform: 25%
        - Avatar: 37.5%
        - Owner: 37.5%
        
        Wallet Balance: 1.8 SOL
```

---

## 9. Future Roadmap (V2+)

### 9.1 Autonomous Launch (V2)
- Balance monitoring Lambda
- Auto-launch when wallet >= threshold
- Avatar announces on connected platforms

### 9.2 Fee Management (V2)
- `bags_get_claimable_fees` - View accumulated fees
- `bags_claim_fees` - Claim to avatar/owner wallets
- Auto-claim on schedule

### 9.3 Trading (V3)
- `bags_get_quote` - Get swap quotes
- `bags_execute_swap` - Execute trades
- Portfolio tracking

### 9.4 NFT Collections (V3)
- One collection per avatar
- Holder-gated features
- Airdrops to token holders

---

## Appendix A: Bags API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/token-launch/create-token-info` | POST | Create metadata |
| `/fee-share/config` | POST | Create fee share config |
| `/token-launch/create-launch-transaction` | POST | Create launch tx |

## Appendix B: Glossary

| Term | Definition |
|------|------------|
| **BPS** | Basis points (10000 = 100%) |
| **Partner** | Platform-level fee recipient (25%) |
| **Fee Claimer** | Wallet receiving share of trading fees |
| **PDA** | Program Derived Address |

---

*Document generated for AWS Swarm BagsApp Integration - V1 MVP*
