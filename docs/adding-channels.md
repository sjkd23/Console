# Adding New Channels - Checklist

When adding a new internal channel to the bot, you must update **4 locations**:

## 1. Database Migration
Create a new migration file in `backend/src/db/migrations/XXX_channel_name.sql`:

```sql
BEGIN;

INSERT INTO channel_catalog (channel_key, label, description) VALUES
    ('new_channel', 'New Channel', 'Description of what this channel does')
ON CONFLICT (channel_key) DO UPDATE SET
    label = EXCLUDED.label,
    description = EXCLUDED.description;

COMMIT;
```

## 2. Backend Routes - guilds.ts
Add the channel key to the `CHANNEL_KEYS` array in `backend/src/routes/guilds.ts`:

```typescript
const CHANNEL_KEYS = [
    'raid',
    'veri_log',
    // ... other channels ...
    'new_channel', // <-- ADD HERE
] as const;
```

## 3. Backend Routes - admin/guilds.ts
Add the channel key to the `CHANNEL_KEYS` array in `backend/src/routes/admin/guilds.ts`:

```typescript
const CHANNEL_KEYS = [
    'raid',
    'veri_log',
    // ... other channels ...
    'new_channel', // <-- ADD HERE
] as const;
```

**⚠️ CRITICAL:** These two arrays must be kept in sync. If they differ, you'll get inconsistent validation behavior.

## 4. Bot Command - setchannels.ts
Add the channel to `CHANNEL_OPTIONS` array in `bot/src/commands/configs/setchannels.ts`:

```typescript
const CHANNEL_OPTIONS = [
    { key: 'raid', label: 'Raid', description: '...' },
    // ... other channels ...
    { key: 'new_channel', label: 'New Channel', description: '...' }, // <-- ADD HERE
] as const;
```

And add a command option:

```typescript
.addChannelOption(o => o.setName('new_channel').setDescription('...').addChannelTypes(ChannelType.GuildText))
```

## Why This Happens

The backend uses **two separate validation layers**:

1. **Database constraint**: The migration ensures the key exists in `channel_catalog`
2. **Runtime validation**: The `CHANNEL_KEYS` arrays define what the API will accept

If you forget step 2 or 3, the database will accept the channel, but the API will reject it with "Unknown channel key" warnings.

## Future Improvement Suggestion

Consider refactoring to a single source of truth:
- Store valid channel keys in a shared constant file
- Import that constant in both routes and the bot
- Or, query `channel_catalog` dynamically instead of hardcoding keys

This would reduce the implementation from 4 locations to 2 (migration + bot command).
