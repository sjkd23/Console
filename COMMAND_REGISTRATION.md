# Command Registration Guide

## Overview

This bot supports two modes of command registration:

1. **Guild-Specific (Development)** - Commands appear instantly in a single test server
2. **Global (Production)** - Commands appear in ALL servers with the bot (takes up to 1 hour)

## Quick Start

### For Development (Instant)
Register commands to your dev guild only:

```bash
npm run register-commands
```

This uses the `DISCORD_DEV_GUILD_ID` from your `.env` file.

### For Production (Global)
Register commands to ALL servers:

```bash
npm run register-commands -- --global
```

⚠️ **Important**: Global commands can take up to 1 hour to propagate across all Discord servers.

## When to Use Each Mode

### Guild-Specific Registration (`npm run register-commands`)
✅ Use when:
- Testing new commands or changes
- Developing features
- You want instant updates
- You only need commands in your test server

### Global Registration (`npm run register-commands -- --global`)
✅ Use when:
- Deploying to production
- Making the bot public
- You want commands in ALL servers with the bot
- Ready for end users

## How It Works

### Permission System
The bot uses a **backend-managed permission system**:
- Each server configures its own role mappings via `/setroles`
- Commands check permissions dynamically using the guild's role configuration
- No Discord permission overwrites needed
- Works automatically in any server

### Command Availability
Once registered globally:
- ✅ Commands appear in any server the bot joins
- ✅ Permissions are checked per-server using that server's role config
- ✅ Each server can have different role setups
- ✅ No additional registration needed when adding bot to new servers

## Technical Details

### Guild Commands vs Global Commands

| Feature | Guild Commands | Global Commands |
|---------|---------------|-----------------|
| Propagation Speed | Instant | Up to 1 hour |
| Visibility | Single guild only | All guilds |
| Best For | Development | Production |
| Command Limit | 100 per guild | 100 globally |

### Backend Integration
Commands communicate with the backend API to:
- Fetch guild role mappings
- Verify user permissions
- Store command execution logs
- Manage guild configurations

Each guild is independent - permissions and configurations don't interfere between servers.

## Troubleshooting

### Commands Not Appearing
1. **If using guild registration**: Commands should appear instantly. Try:
   - Verify `DISCORD_DEV_GUILD_ID` is correct in `.env`
   - Restart Discord client
   - Check bot has `applications.commands` scope

2. **If using global registration**: 
   - Wait up to 1 hour for propagation
   - Check bot was invited with proper OAuth2 scopes
   - Verify `APPLICATION_ID` is correct in `.env`

### Permission Errors
If users get "Role Not Configured" errors:
- Server admins need to run `/setroles` to configure role mappings
- Ensure the Discord roles are properly assigned to users
- Check that internal roles are correctly mapped to Discord roles

### Bot Joins New Server
- If using **global registration**: Commands appear automatically (after propagation delay)
- If using **guild registration**: Commands won't appear in new servers
  - Need to either re-register globally or add that guild ID

## Migration Checklist

When moving from guild-specific to global:

- [ ] Test all commands in dev guild first
- [ ] Run `npm run register-commands -- --global`
- [ ] Wait 1 hour for propagation
- [ ] Test in multiple servers
- [ ] Document for server admins to use `/setroles`
- [ ] Update any deployment scripts

## Environment Variables

Required in `.env`:

```env
APPLICATION_ID=your_bot_application_id
SECRET_KEY=your_bot_token
DISCORD_DEV_GUILD_ID=your_test_server_id  # Used for guild-specific registration
BACKEND_URL=http://backend:4000/v1
BACKEND_API_KEY=your_api_key
```

## Additional Resources

- [Discord Developer Portal](https://discord.com/developers/applications)
- [Discord.js Guide - Slash Commands](https://discordjs.guide/slash-commands/)
- [Backend API Documentation](./docs/API.md) (if applicable)
