# Feishu Channel for Claude Code

A [Feishu (Lark)](https://www.feishu.cn/) channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), built on Claude Code's **native [Channel interface](https://docs.anthropic.com/en/docs/claude-code/channels)**. Send messages to a Feishu bot and interact with Claude — right in your chat.

Uses the MCP Channel protocol to integrate Feishu as a first-class messaging channel for Claude Code, with **WebSocket persistent connection** mode requiring no public HTTPS endpoint.

## Multi-Group Router — One Bot, Many Projects

The killer feature: **route different Feishu groups to different Claude Code instances**, each working in its own project directory. A single Feishu bot serves your entire team — each group gets its own isolated Claude with full project context.

```
                             ┌─ Claude Code (project-a)
Feishu Bot ──→ Router ───────┤─ Claude Code (project-b)
           (single WebSocket)└─ Claude Code (project-c)
                                  ▲ auto-connect via Unix socket
```

**How it works:**
- The **router** holds the single Feishu WebSocket connection and routes messages by `chat_id → workdir → worker`
- Each **worker** (server.ts) runs inside a Claude Code instance, registered by its working directory
- The first `claude-feishu` launch **auto-spawns the router** — no manual setup needed
- When all workers disconnect, the router **auto-shuts down** after a grace period

**Zero-config startup** — just run `claude-feishu` in each project directory:

```bash
cd /path/to/project-a && claude-feishu   # spawns router + connects as worker
cd /path/to/project-b && claude-feishu   # connects to existing router
cd /path/to/project-c && claude-feishu   # connects to existing router
```

Map Feishu groups to project directories in `~/.claude/channels/feishu/access.json`:

```jsonc
{
  "groups": {
    "oc_groupA": { "workdir": "/path/to/project-a", ... },
    "oc_groupB": { "workdir": "/path/to/project-b", ... }
  },
  "defaultWorkdir": "/path/to/default-project"  // DMs route here
}
```

> See [Multi-Group Router Setup](#multi-group-router-setup) for full configuration details.

## Features

- **Multi-group routing** — One Feishu bot serves multiple Claude Code instances, each in its own project
- **Auto-managed router** — Router spawns on first launch, shuts down when all workers disconnect
- **Direct messages** — Chat with Claude through Feishu DMs
- **Group chats** — Add the bot to group chats with @mention support
- **Access control** — Pairing-based onboarding, allowlists, and per-group policies
- **Confirm cards** — Interactive confirmation cards for risky actions
- **Permission cards** — Interactive approve/deny cards for tool permission requests
- **Attachments** — Send and receive files and images
- **Reactions** — Configurable emoji reactions on message receipt
- **Smart connection** — Only connects when launched as a channel, skipping unnecessary connections
- **Graceful shutdown** — Detects parent process exit via ppid polling, preventing orphaned processes

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
   - Add callback: `card.action.trigger` (Card interaction callback) — required for confirm card buttons to work

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

One command:

```bash
npx feishuchannel-for-claudecode
```

This clones the repo, installs dependencies, registers the Claude Code plugin, and creates the `claude-feishu` shortcut — all automatically.

<details>
<summary>Manual installation</summary>

```bash
git clone https://github.com/phxwang/feishuchannel-for-claudecode.git
cd feishuchannel-for-claudecode
bun install
claude plugin marketplace add .
claude plugin install feishu@feishu-local
```

</details>

### 3. Start Claude Code with the Feishu Channel

```bash
claude-feishu
```

Or use the full command:

```bash
claude --dangerously-load-development-channels plugin:feishu@feishu-local
```

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

## Multi-Group Router Setup

### 1. Configure Group Workdirs

Add `workdir` to each group in `~/.claude/channels/feishu/access.json`:

```jsonc
{
  "groups": {
    "oc_groupA": {
      "requireMention": true,
      "allowFrom": [],
      "workdir": "/path/to/project-a"
    },
    "oc_groupB": {
      "requireMention": true,
      "allowFrom": [],
      "workdir": "/path/to/project-b"
    }
  },
  "defaultWorkdir": "/path/to/default-project"  // DMs route here
}
```

### 2. Start Claude Code Instances

In separate terminals, start Claude in each project directory:

```bash
cd /path/to/project-a
claude-feishu

cd /path/to/project-b
claude-feishu
```

The **first** instance auto-spawns the router. Subsequent instances connect as workers. The router matches incoming messages by `chat_id → workdir → connected worker`.

> **Manual router start** (optional): Run `bun run router` in the plugin directory before starting any Claude instances.

### 3. Check Status

```bash
kill -USR1 $(pgrep -f 'bun router.ts')
cat ~/.claude/channels/feishu/router-debug.log | tail -10
```

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
# React to received messages with an emoji (default: Get)
/feishu:access set ackReaction Get

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
├── inbox/            # Downloaded attachments
├── debug.log         # Server debug log
├── router-debug.log  # Router debug log (when using router)
└── router/           # Router message inboxes (when using router)
    └── <chat_id>/    # Per-group message files
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FEISHU_APP_ID` | Yes | Feishu app ID (`cli_...`) |
| `FEISHU_APP_SECRET` | Yes | Feishu app secret |
| `FEISHU_ENCRYPT_KEY` | No | Event payload encryption key |
| `FEISHU_ACCESS_MODE` | No | Set to `static` to disable pairing |
| `FEISHU_STATE_DIR` | No | Override state directory path |
| `FEISHU_CHAT_ID` | No | Set by router — puts server.ts in worker mode |

## How It Works

### Smart Connection

The plugin detects whether it's running under a Feishu channel Claude instance by walking up the process tree and checking for `--dangerously-load-development-channels` with `feishu` in the ancestor's command line. Non-channel Claude instances (e.g., regular `claude` or `claude --channels plugin:discord@...`) skip the Feishu WebSocket connection entirely, keeping the MCP tools available without unnecessary remote connections.

### Orphan Protection

When the parent Claude process exits, the plugin detects the ppid change within 2 seconds and shuts down gracefully. This prevents orphaned `bun server.ts` processes from consuming 100% CPU — a workaround for Bun not reliably firing stdin `end`/`close` events on broken unix domain sockets.

## Testing

```bash
bun test
```

Tests cover access control (gate logic), text chunking, mention detection, permission reply parsing, confirm code generation, chat authorization, and router workdir resolution.

## Security

- Credentials are stored with `chmod 600` — only the owner can read them
- Pairing codes expire after 1 hour
- After 2 unapproved messages, senders are silently dropped until the code expires
- Access mutations can only be made from the Claude Code terminal — never from channel messages (prompt injection protection)
- Group chats require explicit opt-in per group

## License

MIT
