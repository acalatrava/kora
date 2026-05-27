# Telegram Groups and Topics

Kora supports Telegram groups and forum topics (threads). The bot can be added to group chats and will respond to messages where it is mentioned or replied to.

## How It Works

### Private Chats
- The bot responds to all messages (existing behavior, unchanged)

### Group Chats
- The bot only responds when:
  - It is mentioned with `@bot_username` in the message
  - The message is a reply to a previous bot message
- The `@bot_username` mention is automatically stripped from the message before processing
- Bot username is fetched automatically on startup via the Telegram API

### Forum Topics (Supergroups with Topics)
- When a supergroup has topics/forum mode enabled, each topic gets its own conversation thread
- The bot tracks separate sessions per topic using the `message_thread_id`
- Replies are sent back to the correct topic thread

## Identity Mapping

Identity IDs are constructed based on the chat context:

| Context           | Identity ID Format             | Example                  |
| ----------------- | ------------------------------ | ------------------------ |
| Private chat      | `telegram:{chatId}`            | `telegram:12345`         |
| Group (no topics) | `telegram:{chatId}`            | `telegram:-100123456`    |
| Group with topics | `telegram:{chatId}:{threadId}` | `telegram:-100123456:42` |

## Workspace Binding

In multiuser mode:
- The group's workspace is determined by the group owner's identity
- All interactions in the group use the owner's workspace
- Other members can interact but data is stored in the owner's workspace

In single-user mode:
- All groups use the default workspace

## Setup

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather)
2. **Important for groups**: Disable "Group Privacy" in BotFather settings so the bot can see all messages (otherwise it only sees commands and mentions)
3. Add the bot to your group
4. Mention the bot with `@bot_username` to start interacting

### Bot Permissions

For full functionality in groups, the bot needs:
- Read messages (disabled privacy mode)
- Send messages
- For forum topics: "Manage Topics" permission is not required; the bot just needs to be a member

## Supported Message Types

All message types work in groups when the bot is mentioned or replied to:
- Text messages
- Photos (with caption)
- Documents/files
- Voice messages
- Video messages

## Commands in Groups

Bot commands (like `/start`, `/help`, `/tasks`) work in groups as normal, as Telegram automatically routes commands to the bot. However, some commands may be restricted to the group owner in multiuser mode.

## Limitations

- In group mode, the bot needs to be explicitly mentioned or replied to for each message
- Forum topic support requires Telegram supergroups with forum mode enabled
- The bot cannot detect how many members are in a group via the message context alone
