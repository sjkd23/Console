# Raid Management Guide

Complete guide to running raids, headcounts, party finder, and key tracking.

**Audience:** Organizers and raid leaders managing dungeon runs.

---

## Overview

The raid management system provides:

- **Runs** — Full raid coordination with reaction tracking and auto-end
- **Headcounts** — Lightweight interest checks without creating a run
- **Party Finder** — User-created party posts for casual groups
- **Key Tracking** — Log who popped keys for point rewards

**Run Lifecycle:** `Open` → `Started` → `Ended/Cancelled`

---

## Creating a Run

### Basic Run Creation

```
/run
  dungeon: Shatters
  party: Epic Party
  location: USEast
  description: Fast clear, bring pet
```

**What happens:**
1. Run posted in configured `raid` channel
2. Interactive panel with join/bench/leave buttons
3. Temporary role created and mentioned (e.g., @ShattersRun)
4. Auto-end timer starts (default: 2 hours)
5. Organizer panel sent to you (ephemeral)

### Dungeon Selection

The bot supports all major RotMG dungeons:
- **Exalt Dungeons:** Shatters, Nest, Fungal, Crystal, O3, Void, etc.
- **Godland Dungeons:** Sprite World, UDL, Abyss, etc.
- **Epic Dungeons:** Lost Halls, Shatters, Fungal, etc.

Use autocomplete — type a few letters and Discord suggests matches.

### Run Options

| Option | Description | Required |
|--------|-------------|----------|
| `dungeon` | Dungeon type | **Yes** |
| `party` | Party name (e.g., "Epic Party") | No |
| `location` | Server/location (e.g., "USWest") | No |
| `description` | Additional details | No |

### Run Roles

Each run creates a temporary Discord role that:
- Gets mentioned in the run post (@ShattersRun)
- Auto-assigned to all members who click "Join"
- Auto-removed when they click "Leave"
- Deleted automatically when run ends

**Purpose:** Members can mute/unmute individual runs by muting the role.

---

## Managing Your Run

### Organizer Panel

When you create a run, you receive an **Organizer Panel** (visible only to you) with these controls:

**Start Run:**
- Locks join button (no new joiners)
- Changes run status to "Started"
- Used when you're entering portal

**End Run:**
- Closes the run completely
- Awards quota points automatically
- Deletes temporary role
- Removes all buttons from panel

**Cancel Run:**
- Closes run without awarding quota
- Use when run didn't happen
- Still deletes role and cleans up

**Edit Description:**
- Update run details after posting
- Changes reflect immediately in public panel

### Auto-End System

**Default:** Runs auto-end after **2 hours**

**When auto-end triggers:**
- Run status changes to "Ended"
- Quota points awarded to organizer
- Temporary role deleted
- Ping message deleted (if exists)
- Run panel updated to show "Auto-ended"

**Runs check every 5 minutes** — may take up to 5 minutes after timeout to auto-end.

**Max duration:** 24 hours (configurable per server)

### Key Reactions

For dungeons with keys (e.g., Lost Halls Void), the panel shows key emojis:
- Shield Rune 🛡️
- Sword Rune ⚔️
- Helm Rune 🪖
- Wine Cellar Inc 🍷
- Etc.

**Members react with key emoji to indicate they have the key.**

Organizer can see who has keys in the reactions list.

---

## Reaction System

### Member Interactions

**Join:** 
- Click green "Join" button
- Receive run role
- Name added to "Raiders" list
- Choose class (optional)

**Bench:**
- Click yellow "Bench" button
- Still receive run role
- Shows as "backup" in case main group is full
- Can promote self to main roster later

**Leave:**
- Click red "Leave" button
- Role removed
- Removed from raiders list

### Class Selection

After clicking Join/Bench, members can select their class:
- Wizard 🧙
- Archer 🏹
- Knight 🛡️
- Priest ✨
- Etc.

**Class selection updates automatically in the panel.**

### Reaction Counts

The run panel shows:
```
Raiders: 42 joined | 5 benched
```

Click the panel to see full list with classes.

---

## Headcounts

### What Are Headcounts?

**Lightweight interest checks** that don't create a database run record.

**Use when:**
- Gauging interest before committing to a run
- Checking if enough people are available
- Planning ahead for future runs

**Not stored in database** — purely informational.

### Creating a Headcount

```
/headcount
```

1. Select dungeon from dropdown
2. Headcount panel posted to `raid` channel
3. Members react to show interest
4. You receive organizer panel (start/cancel options)

### Converting to Run

From the headcount organizer panel:

**"Start as Run"** button:
- Converts headcount to actual run
- Creates database record
- All reactions carry over
- Begins auto-end timer
- Awards quota when ended

**"Cancel"** button:
- Closes headcount
- No database record created
- No quota awarded

**Headcounts do NOT auto-end** — they stay open until you manually close them.

---

## Party Finder

### Member-Created Parties

**Anyone with `verified_raider` role** can create party finder posts.

```
/party
  party_name: Chill Fungal Runs
  description: Doing multiple fungi, all welcome
  location: USEast
  dungeon_1: Fungal Cavern
  dungeon_2: Crystal Cavern
  dungeon_3: (optional)
```

**What happens:**
1. Party post created in `party_finder` channel (if configured)
2. Party leader receives controls (close)
3. Creates optional thread for coordination
4. No database tracking or quota

### Party Controls

**Party Leader:**
- Can close the party (removes all buttons)
- Archives thread automatically
- **Rate limited:** One party per member at a time

**Not a Run:**
- No reaction tracking
- No quota points
- No auto-end
- Purely organizational

### Use Cases

- Casual groups outside official raid times
- Farming specific dungeons
- Lower-tier dungeons that don't need full raid coordination
- Testing new strategies

---

## Manual Logging

### Log Completed Runs

Manually add quota for runs completed outside the bot:

```
/logrun
  dungeon: Shatters
  amount: 3
  member: @Organizer (optional)
```

**Effects:**
- Adds specified number of runs to quota
- Updates quota leaderboard
- Logs action for audit trail

**Use cases:**
- Runs organized in other Discord servers
- Runs before bot was installed
- Correction for missing auto-log

**Negative amounts:** Use `-3` to remove incorrectly logged runs.

**Maximum:** 999 runs per command (prevents accidents).

### Log Key Pops

Record when members pop keys:

```
/logkey
  member: @Raider
  dungeon: Lost Halls
  amount: 1
```

**Effects:**
- Awards key pop points (if configured)
- Updates member's key pop count
- Appears on leaderboard

**Use cases:**
- Member popped key but reaction wasn't tracked
- Importing historical key data
- Correction for bugs

**Requires:** Organizer role or higher

---

## Role Pings

### Dungeon Role Self-Assignment

Allow members to opt-in for pings when specific dungeons are posted.

### Setup

1. **Create roles** for dungeons you want pingable (e.g., @Shatters, @O3, @Void)
2. **Send role ping panel:**
   ```
   /sendrolepingembed
     channel: #role-selection
   ```
3. Members click buttons to add/remove roles

### Configure Auto-Ping

Set which dungeons auto-ping their respective roles:

```
/configrolepings
```

Follow the prompts to:
- Link dungeon types to Discord roles
- Enable/disable auto-pinging
- Update existing configurations

**Example:**
- Shatters run created → @Shatters mentioned
- O3 run created → @O3 mentioned
- Generic dungeon → No role ping (just @here)

### Managing Pings

**Ping message:**
- Separate message above run panel
- Contains @here + any dungeon-specific role mentions
- Deleted automatically when run ends

**Members control their pings:**
- Add role = get pinged
- Remove role = no pings
- No staff intervention needed

---

## Run Permissions

| Action | Required Role | Notes |
|--------|---------------|-------|
| Create run (`/run`) | Organizer | One active run at a time |
| Create headcount | Organizer | One active headcount at a time |
| Start run | Organizer | Must own the run |
| End run | Organizer | Must own the run |
| Cancel run | Organizer | Must own the run |
| Create party | Verified Raider | One active party at a time |
| Log runs | Organizer | Can log for self or others |
| Log keys | Organizer | Can log for any member |
| Configure pings | Moderator | Guild-wide settings |

**Role hierarchy applies:** Officers can use organizer commands, etc.

---

## Limitations & Rules

### One Active Activity Per Organizer

**You cannot have:**
- Two active runs simultaneously
- An active run + active headcount
- Two active headcounts

**Trying to create second activity shows error:**
```
❌ You already have an active run:
🔹 Shatters (Started 15 minutes ago)

Please end your current run before creating a new one.
```

**Rationale:** Prevents confusion, ensures focus on current run.

### Party Finder Limits

**One active party per member** (regardless of role).

**Rate limit:** 3 party creations per hour to prevent spam.

### Reaction Limits

**No technical limit** on join/bench reactions, but consider:
- Discord message size limits (~6000 characters)
- Practical group sizes for dungeons
- Performance with 100+ reactions

**Panel updates automatically** as reactions change.

---

## Troubleshooting

### Run not posted

**Check:**
- `raid` channel is configured: `/setchannels raid:#channel`
- Bot has permissions in that channel (Send Messages, Embed Links)
- No active run already (one per organizer rule)

**Fix:**
- Configure channel with `/setchannels`
- Grant bot permissions in Server Settings → Channels
- End existing run before creating new one

### Can't create run (already have active)

**Check your active runs:**
- Look in configured `raid` channel
- Check if old run exists from crashed bot

**Fix:**
- Use organizer panel to end/cancel old run
- If panel lost, ask admin to manually end via backend
- Check `raid_log` for your active runs

### Role not assigned when joining

**Check:**
- Bot's role is above the run role in hierarchy
- Bot has "Manage Roles" permission
- Run role wasn't manually deleted

**Fix:**
1. Server Settings → Roles
2. Ensure bot role is above temporary run roles
3. Recreate run if role was deleted

### Auto-end not triggering

**Wait 5 minutes** — checks run every 5 minutes, not real-time.

**Check:**
- Backend is running: `docker-compose logs backend`
- Scheduled task is active: check bot logs
- Run hasn't been manually ended already

**If still not ending after 10 minutes:**
- Check backend logs for errors
- Manually end run using organizer panel

### Quota not awarded

**Check:**
- Run was "Ended", not "Cancelled"
- Organizer has `organizer` role (or higher)
- Backend is running and accessible

**Quota awards on:**
- ✅ Manual end (via panel)
- ✅ Auto-end (after timeout)
- ❌ Cancel (no quota for cancelled runs)

### Key reactions not showing

**Check:**
- Dungeon has keys defined in dungeon database
- Bot has "Add Reactions" permission
- Custom emojis are accessible (not from another server)

**Fix:**
- Grant "Add Reactions" to bot role
- Report missing dungeon key config to admins

### Headcount vs Run confusion

| Feature | Headcount | Run |
|---------|-----------|-----|
| Database record | ❌ No | ✅ Yes |
| Quota awarded | ❌ No | ✅ Yes |
| Auto-end | ❌ No | ✅ Yes (2 hours) |
| Can convert | ✅ To Run | ❌ N/A |
| Purpose | Gauge interest | Official raid |

**Use headcount first if uncertain about participation.**

---

## Best Practices

### For Organizers

1. **Use headcount for uncertain runs** — convert to run if enough interest
2. **Start run status when entering portal** — locks new joiners
3. **End runs promptly** — don't let them auto-end unless necessary
4. **Use party for description** — helps members distinguish multiple runs
5. **Cancel if run fails** — don't award quota for runs that didn't happen
6. **Check key reactions** before starting — ensure someone has keys

### For Raiders

1. **Click Join, not Bench** unless you're genuinely backup
2. **Select your class** — helps organizer plan composition
3. **Click Leave if you can't attend** — don't ghost after joining
4. **React with key emoji** if you have the key — helps organizer
5. **Don't spam party finder** — one party at a time

### For Administrators

1. **Configure `raid` channel** before enabling bot
2. **Set up role pings** for popular dungeons
3. **Review auto-end duration** (default 2 hours, max 24)
4. **Monitor quota logs** for abuse/corrections
5. **Pin party finder rules** in the channel

---

## Advanced Features

### Custom Run Roles

The temporary role created for each run:
- Named: `[Organizer] - [Dungeon]` (e.g., "Alice - Shatters")
- Color: Matches dungeon color
- Permissions: None (purely for mentions/notifications)
- Auto-deleted on run end

**Members can mute the role** to silence run-specific pings without leaving.

### Run Panel Embeds

The run panel shows:
- **Title:** Dungeon name + status
- **Organizer:** Who created the run
- **Description:** Custom text from organizer
- **Party/Location:** If provided
- **Raiders Count:** X joined | Y benched
- **Key Reactions:** Who has keys (if applicable)
- **Footer:** Created timestamp

**Color changes by status:**
- Green: Open
- Blue: Started
- Gray: Ended
- Red: Cancelled

### Organizer Panel Controls

All organizer actions are **ephemeral** (only you see them):
- Start Run
- End Run
- Cancel Run
- Edit Description
- View Full Raiders List

**Panel persists across bot restarts** — buttons remain functional.

---

## Next Steps

- **[Configure quota system](quota-system.md)** — Track organizer requirements
- **[Review moderation tools](moderation.md)** — Manage run participants
- **[Set up verification](verification.md)** — Ensure only verified members join

---

## Summary

Raid management is working when:
- ✅ `/run` creates interactive panel in `raid` channel
- ✅ Join/bench/leave buttons update panel in real-time
- ✅ Temporary role created and assigned to joiners
- ✅ Auto-end triggers after configured duration
- ✅ Quota points awarded on run end
- ✅ Organizer panel controls work (start/end/cancel)

**Common organizer commands:** `/run`, `/headcount`, `/logrun`, `/logkey`
