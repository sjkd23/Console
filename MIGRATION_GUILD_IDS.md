# Migration Guide: DISCORD_DEV_GUILD_ID → DISCORD_GUILD_IDS

## What Changed?

The bot now supports registering commands to **multiple guilds** at once using a comma-separated list.

## Required Action

Update your `.env` file:

### Before
```env
DISCORD_DEV_GUILD_ID=123456789012345678
```

### After
```env
# Single guild (same as before)
DISCORD_GUILD_IDS=123456789012345678

# Multiple guilds
DISCORD_GUILD_IDS=123456789012345678,987654321098765432,111222333444555666
```

## How to Use

### Single Server
Just put one guild ID:
```env
DISCORD_GUILD_IDS=your_server_id
```

### Multiple Servers
Add all server IDs separated by commas (spaces are optional):
```env
DISCORD_GUILD_IDS=server1,server2,server3
```

or with spaces for readability:
```env
DISCORD_GUILD_IDS=server1, server2, server3
```

## Registering Commands

Same command as before:
```bash
npm run register-commands
```

The script will now automatically register commands to **all guilds** in your list.

## Benefits

- ✅ Commands appear instantly in all listed servers
- ✅ No 1-hour wait for global propagation
- ✅ Control exactly which servers have commands
- ✅ Easy to add/remove servers by editing .env

## Finding Guild IDs

1. Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode)
2. Right-click on a server icon
3. Click "Copy Server ID"
4. Paste it into your DISCORD_GUILD_IDS list

## Example

If you have:
- Development server: `123456789012345678`
- Production server #1: `987654321098765432`
- Production server #2: `111222333444555666`

Your `.env` would be:
```env
DISCORD_GUILD_IDS=123456789012345678,987654321098765432,111222333444555666
```

When you run `npm run register-commands`, commands will be registered to all three servers instantly.
