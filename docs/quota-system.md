# Quota System Guide

Complete guide to quota requirements, points configuration, and leaderboards.

**Audience:** Officers and administrators managing organizer requirements and participation tracking.

---

## Overview

The quota system tracks two types of points:

1. **Quota Points** — Organizer requirements (runs organized per period)
2. **Raider Points** — Participation tracking (runs completed, keys popped)

**Key Features:**
- Configurable requirements per role
- Custom point values per dungeon
- Automatic period resets
- Real-time leaderboards
- Manual adjustments for corrections

---

## Quota Points (Organizer Requirements)

### What Are Quota Points?

**Quota points** track how many runs organizers have led during the current quota period.

**Use cases:**
- Require organizers to lead X runs per week/month
- Track activity for promotions/demotions
- Ensure organizers stay active

**Example requirement:**
- Organizer role: 20 points per week
- Head Organizer: 40 points per week

### Configuration

Configure quota requirements for a specific role:

```
/configquota
  role: @Organizer
```

**Interactive panel opens with:**

**1. Required Points**
- Set minimum points needed per quota period
- Example: 20 points = 20 runs (if 1 point per run)

**2. Reset Schedule**
- Day of week (Monday-Sunday)
- Hour (0-23 UTC)
- Minute (0-59)

**3. Per-Dungeon Overrides**
- Assign custom point values for specific dungeons
- Example: Shatters = 2 points, Sprite World = 0.5 points

**4. Leaderboard Panel**
- Set which channel displays the quota leaderboard
- Updates automatically as organizers complete runs

### How Points Are Earned

**Automatic:**
- Run created with `/run` and ended (not cancelled) → points awarded based on dungeon

**Manual:**
- `/logrun dungeon:Shatters amount:5` → adds 5 runs worth of points
- `/addquotapoints member:@User amount:10` → directly adds 10 quota points

**Points calculation:**
```
Points Earned = Number of Runs × Points Per Dungeon
```

If Shatters = 2 points per run:
- Organizing 5 Shatters runs = 10 quota points

### Period Resets

**Quota periods reset automatically** based on configured schedule.

**Example:** Reset every Monday at 00:00 UTC
- Monday 12:00 AM: All quota points reset to 0
- Members start fresh accumulation
- Previous period stats archived (visible in history)

**Reset triggers:**
- Scheduled datetime reaches (checked periodically)
- Manual reset via backend (admin only)

**After reset:**
- Current period points → 0
- Leaderboard updates automatically
- Requirements apply to new period

### Per-Dungeon Point Values

**Default:** 1 point per run (all dungeons)

**Custom values:**
Set different point values for specific dungeons:

| Dungeon | Points | Rationale |
|---------|--------|-----------|
| Shatters | 2.0 | Difficult, time-consuming |
| O3 | 3.0 | Requires coordination |
| Fungal | 1.5 | Moderate difficulty |
| Sprite World | 0.5 | Quick, easy dungeon |
| Lost Halls | 2.5 | Long dungeon |

**Configuration:**
In `/configquota` panel, select "Set Dungeon Overrides" and choose dungeon + point value.

**Fractional points supported:** 0.5, 1.5, 2.5, etc.

---

## Raider Points (Participation Tracking)

### What Are Raider Points?

**Raider points** track member participation in runs and key contributions.

**Awards for:**
- Completing runs (joining and finishing)
- Popping keys for dungeons
- Helping with difficult content

**Use cases:**
- Reward active raiders
- Track participation for promotions
- Encourage key contributions

### Configuration

Configure raider points for all dungeons:

```
/configpoints
```

**Interactive panel shows:**
- List of all dungeons
- Current point value for completing each
- Edit button to change values

**Example configuration:**
- Complete O3 run: 5 points
- Complete Shatters: 3 points
- Complete Sprite World: 1 point
- Pop Lost Halls key: 10 points

### How Raider Points Are Earned

**Automatic (future feature):**
- Join run with `/run` reactions → track completion
- React with key emoji → log key contribution

**Manual (current system):**
- `/logkey member:@Raider dungeon:Shatters amount:1` → awards key pop points
- `/addpoints member:@Raider amount:50` → directly adds raider points

### Key Pop Points

**Separate configuration** for keys popped:

In `/configpoints`, there's a section for key pop points (distinct from run completion points).

**Example:**
- Popping Void key: 15 points
- Popping Shatters key: 5 points
- Popping Fungal key: 3 points

**Logged via:**
```
/logkey
  member: @Raider
  dungeon: Lost Halls
  amount: 1
```

---

## Leaderboards

### Viewing Leaderboards

**View personal stats:**
```
/stats
  member: @User (optional)
```

**Shows:**
- Total raider points
- Total quota points (if organizer)
- Runs organized
- Verifications performed
- Keys popped
- Per-dungeon breakdown

**View guild leaderboard:**
```
/leaderboard
```

**Interactive leaderboard with pages:**
- Top 25 members per page
- Navigate with arrow buttons
- Shows: Rank, Member, Points, Quota Points, Runs, Keys
- Sortable by different metrics (if configured)

**Leaderboard updates:**
- Real-time: updates as activities happen
- Automatic: no manual refresh needed
- Persistent: stored in database

### Quota Panel

**Automated leaderboard panel** posted to configured channel (via `/configquota`).

**Panel shows:**
- Top organizers in current quota period
- Current points vs required points
- Progress bars (visual indicators)
- Updates automatically after each run

**Setup:**
1. Run `/configquota role:@Organizer`
2. Click "Set Leaderboard Channel"
3. Select channel (e.g., #quota-tracking)
4. Panel auto-posts and stays updated

---

## Manual Adjustments

### Add/Remove Quota Points

**Officer+ command:**
```
/addquotapoints
  member: @Organizer
  amount: 10
```

**Negative amounts to deduct:**
```
/addquotapoints
  member: @Organizer
  amount: -5
```

**Use cases:**
- Correction for incorrectly logged run
- Bonus points for exceptional work
- Penalty for rule violation
- Importing historical data

**Maximum:** 9999 points per command (prevents accidents)

### Add/Remove Raider Points

**Officer+ command:**
```
/addpoints
  member: @Raider
  amount: 50
```

**Negative amounts to deduct:**
```
/addpoints
  member: @Raider
  amount: -20
```

**Use cases:**
- Reward event participation
- Bonus for helping new players
- Correction for system errors

### Manual Run Logging

**Log runs that happened outside the bot:**

```
/logrun
  dungeon: Shatters
  amount: 3
  member: @Organizer (optional)
```

**Effects:**
- Adds 3 runs worth of quota points
- Uses configured point value for Shatters
- Updates leaderboard
- Logs action for audit trail

**Common scenarios:**
- Runs before bot was installed
- Runs in another Discord server
- Bot was offline during run

### Manual Key Logging

**Log key pops:**

```
/logkey
  member: @Raider
  dungeon: Lost Halls
  amount: 1
```

**Effects:**
- Awards key pop points to raider
- Updates their stats
- Appears on leaderboard

---

## Configuration Examples

### Example 1: Weekly Organizer Quota

**Goal:** Organizers must lead 15 runs per week, resets every Monday.

**Setup:**
1. `/configquota role:@Organizer`
2. Set Required Points: `15`
3. Set Reset Schedule: `Monday, 00:00 UTC`
4. Save

**Dungeon values (defaults to 1 point each):**
- All dungeons = 1 point
- Organizers need to complete 15 runs of any type

### Example 2: Difficulty-Based Points

**Goal:** Harder dungeons worth more quota points.

**Setup:**
1. `/configquota role:@Organizer`
2. Set Dungeon Overrides:
   - O3: 3 points
   - Shatters: 2 points
   - Lost Halls: 2 points
   - Fungal: 1.5 points
   - All others: 1 point

**Result:**
- 5 O3 runs = 15 quota points
- 8 Shatters runs = 16 quota points
- Mix: 3 O3 (9) + 4 Shatters (8) + 2 Fungal (3) = 20 points

### Example 3: Raider Participation Tracking

**Goal:** Track and reward active raiders.

**Setup:**
1. `/configpoints`
2. Set completion points:
   - O3: 10 points
   - Shatters: 5 points
   - Lost Halls: 5 points
   - Fungal: 3 points
   - Sprite: 1 point
3. Set key pop points:
   - Void key: 20 points
   - Shatters key: 10 points
   - Helm Rune: 8 points

**Usage:**
- After runs, log participation manually
- After key pops, use `/logkey`
- View active raiders with `/leaderboard`

### Example 4: Multiple Role Tiers

**Goal:** Different requirements for Organizer vs Head Organizer.

**Setup:**
1. `/configquota role:@Organizer`
   - Required: 15 points per week
2. `/configquota role:@HeadOrganizer`
   - Required: 30 points per week
3. Both use same reset schedule

**Result:**
- Organizers track toward 15 point goal
- Head Organizers track toward 30 point goal
- Each role has separate leaderboard

---

## Permissions

| Command | Required Role | Notes |
|---------|---------------|-------|
| `/configquota` | Moderator | Configure quota requirements |
| `/configpoints` | Moderator | Configure raider points |
| `/stats` | Verified Raider | View personal or others' stats |
| `/leaderboard` | Verified Raider | View guild leaderboard |
| `/logrun` | Organizer | Log runs for self or others |
| `/logkey` | Organizer | Log key pops for any member |
| `/addquotapoints` | Officer | Manually adjust quota points |
| `/addpoints` | Officer | Manually adjust raider points |

---

## Troubleshooting

### Quota points not awarded after run

**Check:**
- Run was "Ended", not "Cancelled"
- Organizer has the configured role (e.g., @Organizer)
- Quota config exists for that role: `/configquota role:@Organizer`
- Backend is running and accessible

**Fix:**
- Use `/logrun` to manually add missing points
- Check logs in `raid_log` for errors
- Verify quota config is saved

### Leaderboard not updating

**Check:**
- Leaderboard channel is configured in `/configquota`
- Bot has permissions in that channel (Send Messages, Embed Links)
- Panel message wasn't deleted manually

**Fix:**
- Reconfigure leaderboard channel: `/configquota` → Set Leaderboard Channel
- Grant bot permissions
- Panel will auto-recreate on next update

### Period didn't reset

**Check:**
- Reset time is in UTC (not your local timezone)
- Scheduled task is running: check bot logs
- Backend is running

**If past reset time and still not reset:**
- Backend may have been down during reset window
- Contact admin for manual reset via backend API

### Points calculation seems wrong

**Check:**
- Dungeon override values: `/configquota` → View Overrides
- Verify dungeon type was logged correctly
- Check for fractional points (0.5, 1.5, etc.)

**Example:**
- Logged 5 Shatters runs
- Shatters = 2 points per run
- Expected: 5 × 2 = 10 points

**Fix:**
- Use `/addquotapoints` with negative amount to correct
- Update dungeon overrides if values are wrong

### Can't set fractional points

**Fractional points ARE supported** (e.g., 0.5, 1.5, 2.5).

**In configuration panel:**
- Type the decimal value directly
- Example: `1.5` for one and a half points
- Backend stores as decimal

### Stats showing 0 despite activity

**Check:**
- Member is verified (raider record exists)
- Activity happened in current guild
- Database connectivity (check backend logs)

**Fix:**
- Verify member with `/verify` if needed
- Check backend logs for errors
- Use manual commands to add missing data

---

## Best Practices

### For Administrators

1. **Start with simple quota** — 1 point per run, adjust based on feedback
2. **Clearly communicate requirements** — post quota rules in announcements
3. **Review leaderboards weekly** — catch anomalies early
4. **Use realistic requirements** — don't burn out organizers
5. **Provide grace period** — new organizers need time to learn

### For Officers

1. **Check quota progress mid-period** — warn organizers falling behind
2. **Reward exceptional work** — use `/addquotapoints` for bonuses
3. **Correct errors promptly** — use negative amounts to fix mistakes
4. **Log historical data carefully** — verify before bulk imports
5. **Audit manual adjustments** — review logs for abuse

### For Organizers

1. **Track your progress** — check `/stats` regularly
2. **Don't wait until last day** — spread runs throughout period
3. **Focus on higher-point dungeons** (if configured that way)
4. **Log missed runs promptly** — use `/logrun` for offline runs
5. **Ask for corrections** — if system error, contact officers

---

## Advanced Features

### Quota Recalculation

**Backend-only feature** for admins to recalculate all quota points based on current dungeon overrides.

**Use case:** You change Shatters from 1 point to 2 points, and want to retroactively apply to all past runs.

**Contact admin** — requires backend API access or database query.

### Multiple Reset Schedules

**Each role can have different reset schedules.**

**Example:**
- Organizer role: Resets every Monday
- Head Organizer role: Resets every 1st of the month

Configure separately with `/configquota` for each role.

### Archived Period Stats

**Previous period stats are stored** but not visible in main leaderboard.

**To view history:**
- Backend API: Query `quota_event` table with date filters
- Future feature: In-bot historical leaderboards

---

## Integration with Other Systems

### Verification System

**Quota/points only track for verified members.**

Members must be verified before:
- Earning raider points
- Being eligible for organizer quota tracking

**See:** [verification.md](verification.md)

### Raid Management

**Quota points auto-awarded when runs end.**

Organizers don't need to manually log every run — the system tracks automatically.

**See:** [raid-management.md](raid-management.md)

### Moderation

**Officers can adjust points** as part of discipline or rewards.

Examples:
- Penalty: Remove 10 quota points for rule violation
- Reward: Add 20 raider points for event participation

**See:** [moderation.md](moderation.md)

---

## Next Steps

- **[Configure verification](verification.md)** — Ensure members are verified before tracking
- **[Set up raid management](raid-management.md)** — Create runs that award quota
- **[Review moderation tools](moderation.md)** — Manage point adjustments

---

## Summary

Quota system is working when:
- ✅ `/configquota` saves requirements for at least one role
- ✅ Runs auto-award quota points on end
- ✅ `/stats` shows accurate current period stats
- ✅ `/leaderboard` displays top members with pagination
- ✅ Quota panel auto-updates in configured channel
- ✅ Period resets occur automatically at scheduled time

**Common configuration commands:** `/configquota`, `/configpoints`, `/logrun`, `/addquotapoints`
