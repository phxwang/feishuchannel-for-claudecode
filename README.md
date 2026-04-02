# Feishu Channel for Claude Code

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) channel plugin that bridges [Feishu (Lark)](https://www.feishu.cn/) messaging with Claude Code. Send messages to a Feishu bot and get responses from Claude — right in your chat.

Uses **WebSocket persistent connection** mode, so no public HTTPS endpoint is required.

## Features

- **Direct messages** — Chat with Claude through Feishu DMs
- **Group chats** — Add the bot to group chats with @mention support
- **Access control** — Pairing-based onboarding, allowlists, and per-group policies
- **Confirm cards** — Interactive confirmation cards for risky actions
- **Attachments** — Send and receive files and images
- **Reactions** — Configurable emoji reactions on message receipt

## Prerequisites

- [Bun](https://bun.sh/) runtime
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- A Feishu (or Lark) workspace with admin access to create apps

## Quick Start

### 1. Create a Feishu App

1. Go to [Feishu Open Platform](https://open.feishu.cn) (or [Lark Open Platform](https://open.larksuite.com) for international)
2. Create a **Custom App** (enterprise internal app)
3. Note the **App ID** (`cli_...`) and **App Secret**
4. Under **Events & Callbacks**, configure two separate tabs:

   **Event Configuration** tab:
   - Switch connection method to **Using persistent connection** (WebSocket mode) at the top of the page
   - Add event: `im.message.receive_v1`

   **Callback Configuration** tab:
   - Also switch to **Using persistent connection** (WebSocket mode)
   - Add callback: **Card interaction callback** (卡片回传交互) — required for confirm card buttons to work

5. Under **Permissions & Scopes**, add:

   | Permission | Purpose |
   |---|---|
   | `im:message` | Send messages |
   | `im:message.receive_v1` | Receive messages |
   | `im:message.p2p_msg:readonly` | Read DM messages |
   | `im:message.group_at_msg:readonly` | Read group @mentions |
   | `im:chat:readonly` | Read chat metadata |
   | `im:resource` | Download attachments |

6. **Publish** the app version so permissions take effect

### 2. Install the Plugin

```bash
claude plugin add /path/to/feishuchannel
```

Or clone and add:

```bash
git clone git@github.com:phxwang/feishuclaudecode.git
claude plugin add ./feishuclaudecode
```

### 3. Start Claude Code with the Feishu Channel

The Feishu channel is a development channel plugin. Launch Claude Code with:

```bash
claude --dangerously-load-development-channels server:feishu
```

> **Note:** The `--dangerously-load-development-channels` flag is required because this is a local development channel. The flag tells Claude Code to load the channel server.

### 4. Configure Credentials

In your Claude Code terminal:

```
/feishu:auth cli_YOUR_APP_ID YOUR_APP_SECRET
```

Credentials are stored in `~/.claude/channels/feishu/.env` (mode 600).

### 5. Pair Your Account

1. Open Feishu and search for your bot by app name
2. Send any message to the bot
3. The bot replies with a pairing code
4. In Claude Code, run:

   ```
   /feishu:access pair <code>
   ```

5. The bot confirms: *"Paired! Say hi to Claude."*

You're ready — send messages to the bot and Claude will respond.

## Access Management

All access commands are run in your Claude Code terminal via `/feishu:access`.

### Check Status

```
/feishu:access
```

### DM Policies

| Policy | Behavior |
|---|---|
| `pairing` (default) | Unknown users get a pairing code to approve |
| `allowlist` | Unknown users are silently dropped |
| `disabled` | All messages dropped |

```
/feishu:access policy allowlist
```

> **Tip:** Once all your users are paired, switch to `allowlist` to prevent unsolicited pairing requests.

### Manage Users

```bash
# Approve a pairing
/feishu:access pair <code>

# Deny a pairing
/feishu:access deny <code>

# Manually allow a user by open_id
/feishu:access allow ou_xxxxxxxxxxxxxxxxxxxx

# Remove a user
/feishu:access remove ou_xxxxxxxxxxxxxxxxxxxx
```

### Group Chats

Groups are off by default. The bot must be added to the group by a group admin first.

```bash
# Enable a group (responds on @mention only)
/feishu:access group add oc_xxxxxxxxxxxxxxxxxxxx

# Respond to all messages (no @mention needed)
/feishu:access group add oc_xxxxxxxxxxxxxxxxxxxx --no-mention

# Restrict to specific users within the group
/feishu:access group add oc_xxxxxxxxxxxxxxxxxxxx --allow ou_id1,ou_id2

# Remove a group
/feishu:access group rm oc_xxxxxxxxxxxxxxxxxxxx
```

### Delivery Settings

```bash
# React to received messages with an emoji
/feishu:access set ackReaction THUMBSUP

# Set max characters per message chunk
/feishu:access set textChunkLimit 4096

# Custom mention patterns for group chats
/feishu:access set mentionPatterns ["@claude","@assistant"]
```

## File Layout

```
~/.claude/channels/feishu/
├── .env              # App credentials (FEISHU_APP_ID, FEISHU_APP_SECRET)
├── access.json       # Access control state (auto-managed)
├── approved/         # Pairing approval signals (transient)
├── inbox/            # Confirm card responses (transient)
└── debug.log         # Server debug log
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FEISHU_APP_ID` | Yes | Feishu app ID (`cli_...`) |
| `FEISHU_APP_SECRET` | Yes | Feishu app secret |
| `FEISHU_ENCRYPT_KEY` | No | Event payload encryption key |
| `FEISHU_ACCESS_MODE` | No | Set to `static` to disable pairing |
| `FEISHU_STATE_DIR` | No | Override state directory path |

## Security

- Credentials are stored with `chmod 600` — only the owner can read them
- Pairing codes expire after 1 hour
- After 2 unapproved messages, senders are silently dropped until the code expires
- Access mutations can only be made from the Claude Code terminal — never from channel messages (prompt injection protection)
- Group chats require explicit opt-in per group

## License

MIT
