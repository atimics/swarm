# OpenAI-Compatible Chat API

The Swarm platform provides an OpenAI-compatible API that allows external applications to chat with avatars using the familiar `/v1/chat/completions` format.

## Base URL

```
https://swarm.rati.chat/api/v1
```

(Or your custom API domain)

## Authentication

All requests require an API key in the `Authorization` header:

```bash
Authorization: Bearer sk-your-api-key-here
```

### Creating API Keys

#### Avatar-Scoped Key (Recommended)
Create an API key that only works with a specific avatar:

```bash
curl -X POST https://swarm.rati.chat/api/avatars/{avatarId}/api-keys \
  -H "Content-Type: application/json" \
  -H "Cookie: swarm_session=..." \
  -d '{"name": "My Integration"}'
```

Response:
```json
{
  "apiKey": "sk-abc123...",
  "keyPrefix": "sk-abc123...",
  "message": "API key created. Save this key - it will not be shown again."
}
```

#### Wildcard Key (Admin Only)
Create an API key that can access all avatars:

```bash
curl -X POST https://swarm.rati.chat/api/api-keys \
  -H "Content-Type: application/json" \
  -H "Cookie: swarm_session=..." \
  -d '{"name": "Admin Integration"}'
```

**⚠️ Warning:** Save your API key immediately! It will only be shown once.

---

## Endpoints

### List Available Avatars

```bash
GET /v1/models
```

Lists all avatars available to your API key.

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "avatar:my-bot",
      "object": "model",
      "created": 1706644800,
      "owned_by": "swarm",
      "permission": [],
      "root": "my-bot",
      "parent": null,
      "capabilities": {
        "voice": true
      },
      "avatar": {
        "name": "My Bot",
        "description": "A helpful assistant",
        "profile_image": "https://cdn.rati.chat/avatars/my-bot/profile.png"
      }
    }
  ]
}
```

The `capabilities.voice` field indicates whether the avatar has voice generation enabled. If `true`, you can use `include_audio: true` in chat requests.

---

### Get Model Details

```bash
GET /v1/models/{model_id}
```

Get detailed information about a specific avatar, including profile images, platform presence, and capabilities.

**Response:**
```json
{
  "id": "avatar:my-bot",
  "object": "model",
  "created": 1706644800,
  "owned_by": "swarm",
  "permission": [],
  "root": "my-bot",
  "parent": null,
  "capabilities": {
    "voice": true
  },
  "avatar": {
    "id": "my-bot",
    "name": "My Bot",
    "description": "A helpful assistant",
    "profile_image": "https://cdn.rati.chat/avatars/my-bot/profile.png",
    "character_reference": "https://cdn.rati.chat/avatars/my-bot/character.png",
    "platforms": {
      "telegram": {
        "username": "mybot",
        "home_channel": "https://t.me/mybotchat"
      },
      "twitter": {
        "username": "mybot"
      },
      "discord": null
    },
    "voice": {
      "style": "voice-clone"
    },
    "sticker_pack": {
      "name": "mybot_stickers",
      "title": "My Bot Stickers",
      "count": 12
    }
  }
}
```

---

### Chat Completions

```bash
POST /v1/chat/completions
```

Generate a chat completion from an avatar.

**Request Body:**
```json
{
  "model": "avatar:my-bot",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "temperature": 0.8,
  "max_tokens": 1024,
  "include_audio": true
}
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | Yes | Avatar ID, either as `avatar:my-bot` or just `my-bot` |
| `messages` | array | Yes | Array of message objects with `role` and `content` |
| `temperature` | number | No | Sampling temperature (0-2), default varies by avatar |
| `max_tokens` | number | No | Maximum tokens to generate |
| `stream` | boolean | No | **Not yet supported** - must be `false` or omitted |
| `user` | string | No | Optional user identifier for tracking |
| `include_audio` | boolean | No | Generate voice audio for the response (requires avatar with voice configured) |

**Message Roles:**
- `system` - System instructions (optional, avatar persona is used if not provided)
- `user` - User messages
- `assistant` - Previous assistant responses (for context)

**Response:**
```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1706644800,
  "model": "avatar:my-bot",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?",
        "audio": {
          "url": "https://cdn.rati.chat/voice/abc123.wav",
          "format": "wav",
          "duration_ms": 2500
        }
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 10,
    "total_tokens": 25
  }
}
```

The `audio` field is only present when:
1. `include_audio: true` was specified in the request
2. The avatar has voice generation configured and enabled

---

## Example Usage

### cURL

```bash
curl -X POST https://swarm.rati.chat/api/v1/chat/completions \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "avatar:my-bot",
    "messages": [
      {"role": "user", "content": "What is the meaning of life?"}
    ]
  }'
```

### Python (OpenAI SDK)

The official OpenAI Python SDK works seamlessly:

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-your-key",
    base_url="https://swarm.rati.chat/api/v1"
)

response = client.chat.completions.create(
    model="avatar:my-bot",
    messages=[
        {"role": "user", "content": "Hello!"}
    ]
)

print(response.choices[0].message.content)
```

### JavaScript/TypeScript (OpenAI SDK)

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-your-key',
  baseURL: 'https://swarm.rati.chat/api/v1',
});

const response = await client.chat.completions.create({
  model: 'avatar:my-bot',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
});

console.log(response.choices[0].message.content);
```

### LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    api_key="sk-your-key",
    base_url="https://swarm.rati.chat/api/v1",
    model="avatar:my-bot"
)

response = llm.invoke("Hello!")
print(response.content)
```

---

## Error Responses

Errors follow the OpenAI format:

```json
{
  "error": {
    "message": "Invalid API key",
    "type": "authentication_error",
    "code": "invalid_api_key"
  }
}
```

**Common Error Codes:**

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `missing_api_key` | 401 | No Authorization header provided |
| `invalid_api_key` | 401 | API key not found or disabled |
| `unauthorized_avatar` | 403 | API key not authorized for requested avatar |
| `avatar_not_found` | 404 | Avatar ID doesn't exist |
| `unsupported_stream` | 400 | Streaming is not yet supported |

---

## Rate Limits

Rate limits are applied per API key:

- **Default:** 100 requests/minute, 1000 requests/day
- **Custom limits:** Can be configured per API key

Rate limit headers are included in responses:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1706644860
```

---

## Limitations

1. **Streaming not supported** - The `stream: true` parameter is not yet implemented
2. **No function calling** - Tools/function calling is not exposed through this API
3. **No image generation** - Media generation tools are not available
4. **Token counting is approximate** - Usage stats use character-based estimation

---

## Best Practices

1. **Use avatar-scoped keys** - Only create wildcard keys when absolutely necessary
2. **Rotate keys regularly** - Create new keys and disable old ones periodically
3. **Store keys securely** - Use environment variables or secret managers
4. **Handle rate limits** - Implement exponential backoff on 429 responses
5. **Monitor usage** - Track your API key usage in the admin dashboard

---

## Coming Soon

- [ ] Streaming responses
- [ ] Tool/function calling
- [ ] Image generation via chat
- [ ] API key management UI
- [ ] Usage analytics dashboard
