# Verification Guide

Complete guide to member verification workflows including RealmEye automation, manual review, and bulk imports.

**Audience:** Security staff and administrators managing member verification.

---

## Overview

The bot offers two verification methods:

1. **RealmEye Verification** (automated) — Members add a code to their RealmEye profile
2. **Manual Verification** (screenshot-based) — Staff review screenshots of in-game characters

Both methods result in:

- Member receives `verified_raider` role
- IGN stored in database
- Discord nickname updated to match IGN
- Verification logged for audit trail

---

## Configuration

### Panel Setup

Send a verification panel to a channel where members can start the process:

```
/configverification send-panel
  channel: #get-verified (optional)
  custom_message: "Click below to verify your ROTMG account!"
  image_url: https://example.com/banner.png
```

The panel creates a button that members click to begin verification in DMs.

### Verification Method

Configure which method is available (check command options for exact syntax):

```
/configverification set-method <method>
```

Options depend on your guild's needs:

- **RealmEye** — Fully automated, requires public profile
- **Manual** — Screenshot review by staff
- **Both** — Members choose their preferred method

---

## RealmEye Verification (Automated)

### How It Works

1. Member clicks verification button
2. Bot DMs them requesting their IGN
3. Bot generates unique verification code (e.g., `VER-ABC123`)
4. Member adds code to RealmEye profile description
5. Bot automatically checks RealmEye, verifies profile
6. If successful: role granted, nickname updated

### Member Flow

**Step 1:** Click "Get Verified" button in the verification panel

**Step 2:** Receive DM from bot asking for IGN

**Step 3:** Reply with ROTMG in-game name:

```
YourIGN
```

**Step 4:** Bot provides verification code and RealmEye link:

```
Add this code to your RealmEye profile description:
VER-ABC123

1. Go to: https://www.realmeye.com/player/YourIGN
2. Click "Options" → "Add description"
3. Paste: VER-ABC123
4. Save changes
5. Click "Verify" button below
```

**Step 5:** Click "Verify" button — bot automatically checks profile

**Step 6:** If code found: verification complete!

### Requirements

- RealmEye profile must be **public** (not private/hidden)
- Profile must be updated recently (not dead account)
- IGN must match character name exactly

### Troubleshooting for Members

**"IGN not found on RealmEye"**

- Profile may be private — check RealmEye privacy settings
- IGN spelling must match exactly (case-insensitive)
- Try again after RealmEye updates (can take a few minutes)

**"Verification code not found"**

- Ensure code is in the **description** field, not elsewhere
- Wait ~30 seconds after saving, then click Verify
- Code must be exact match (copy-paste recommended)

**"Session expired"**

- Verification expires after 30 minutes of inactivity
- Click verification button again to restart

---

## Manual Verification (Screenshot Review)

### How It Works

1. Member clicks verification button
2. Bot DMs requesting IGN
3. Member provides screenshot of in-game character screen
4. Screenshot posted to manual verification channel
5. Staff reviews and approves/denies
6. Member receives notification of decision

### Member Flow

**Step 1-2:** Same as RealmEye (click button, provide IGN)

**Step 3:** Upload screenshot showing:

- Character name matching IGN
- Character stats/equipment (proof of ownership)
- Clear, unedited image

**Step 4:** Wait for staff review (typically <24 hours)

**Step 5:** Receive DM with approval or denial

### Staff Review Process

Manual verification requests appear in the channel mapped to `manual_verification`.

**Review ticket:**

1. Check screenshot quality and legitimacy:
   - ✅ Character name matches stated IGN
   - ✅ Screenshot is clear and unedited
   - ✅ Account appears active (stats, gear, etc.)

2. **Approve:**

   ```
   /verify
     member: @Username
     ign: TheirIGN
   ```

   - Grants `verified_raider` role
   - Updates nickname
   - Notifies member

3. **Deny** (if suspicious/fake):
   - Use the provided review controls (buttons/commands shown in the staff channel) to Approve or Deny
   - Member receives denial notification
   - Can resubmit with better screenshot

### Screenshot Requirements

Tell members to include:

- Full character screen with name visible
- Stats showing account is active
- No editing or cropping of critical elements
- Original resolution (not compressed/blurry)

---

## IGN Management

### Edit IGN

Update a verified member's IGN (corrects typos, name changes):

```
/editname
  member: @Member
  ign: NewIGN
```

- Updates stored IGN
- Changes Discord nickname
- Logs the change

### Add Alternate IGN

Members with multiple accounts can register an alt:

```
/addalt
  member: @Member
  ign: AltIGN
```

- Nickname becomes: `MainIGN | AltIGN`
- Both names recognized by the system
- Useful for players with multiple accounts

### Remove Alternate IGN

```
/removealt
  member: @Member
```

- Removes alt IGN from profile
- Nickname reverts to main IGN only

---

## Unverify

Remove verification status from a member:

```
/unverify
  member: @Member
  reason: Reason for removal
```

**Effects:**

- Removes `verified_raider` role
- Sets raider status to `pending`
- Keeps IGN on record (for history)
- Logs action with reason

**Use cases:**

- Member left guild, returned unverified
- Verification was granted in error
- IGN ownership disputed

Member can re-verify later through normal flow.

---

## Bulk IGN Sync

Sync all verified members' IGNs from their Discord nicknames into the database (admin only).

### Use Case

- Migrating an existing guild where members already have their IGN as their nickname
- Recovering after a database issue where raider records are missing
- Onboarding an established guild that was managing nicknames manually

### How It Works

`/forcesync` reads the Discord nickname of every member who has the `verified_raider` or `suspended` role and creates or updates the raider record in the database using that nickname as their IGN.

**Nickname parsing:**
- `"PlayerOne"` → main IGN: `PlayerOne`
- `"MainIGN | AltIGN"` → main IGN: `MainIGN`, alt: `AltIGN`

### Import Process

```
/forcesync
```

The command runs automatically with live progress updates. No additional input is required.

**The command will:**

- Fetch all guild members with `verified_raider` or `suspended` roles
- Parse IGNs from their server nicknames
- Bulk-sync those IGNs to the database
- Report progress, successes, and failures

**Authorization:** Requires `administrator` role (only one instance runs at a time)

### After Sync

1. Check logs in `veri_log` channel
2. Verify key members received roles
3. Review any reported failures

---

## Team Role Sync

Manually sync the `team` marker role for all members in the guild.

```
/syncteam
```

The `team` role is automatically assigned to any member who holds at least one staff role (organizer, security, officer, etc.) and removed from those who don't. This command triggers that sync manually for the entire guild — useful after initially configuring the `team` role mapping.

**Authorization:** Requires `administrator` role

---

## Verification Logs

All verification events log to the channel mapped to `veri_log`:

- ✅ Member verified (method: RealmEye/Manual)
- 📝 IGN updated
- ➕ Alt IGN added
- ➖ Alt IGN removed
- ❌ Member unverified
- 🔄 Bulk sync completed

Each log entry includes:

- Timestamp
- Member mention
- IGN(s) involved
- Staff member who performed action
- Reason (if applicable)

**Review logs regularly** to monitor verification activity and catch anomalies.

---

## Permissions

Verification commands require specific roles:

| Command | Required Role | Notes |
|---------|---------------|-------|
| `/verify` | Security | Manual verification (staff grants role directly) |
| `/unverify` | Security | Remove verification |
| `/editname` | Security | Update main IGN |
| `/addalt` | Security | Add alternate IGN |
| `/removealt` | Security | Remove alternate IGN |
| `/forcesync` | Administrator | Bulk-sync IGNs from nicknames into DB |
| `/syncteam` | Administrator | Re-sync Team role for all guild members |
| `/configverification` | Moderator | Panel and system config |

Role hierarchy allows higher roles to use lower-level commands (e.g., Moderator can use Security commands).

---

## Troubleshooting

### Member can't start verification

**Check:**

- Verification panel is posted in accessible channel
- Bot is online and responding
- Member has DMs enabled (bot needs to DM them)

**Fix:**

- Repost panel: `/configverification send-panel`
- Tell member to enable DMs from server members
- Check bot permissions in the channel

### Verification role not granted

**Check:**

- Bot's role is positioned **above** `verified_raider` role in Server Settings
- Bot has "Manage Roles" permission
- `verified_raider` role is mapped: `/setroles verified_raider:@YourRole`

**Fix:**

1. Server Settings → Roles
2. Drag bot role above `verified_raider`
3. Retry verification

### Nickname won't update

**Cause:** Bot cannot modify nicknames of members with roles above bot's role.

**Fix:**

- Ensure bot role is positioned above member's highest role
- Members with "Manage Nicknames" or "Administrator" permission may be immune
- Owner nickname cannot be changed by bot

### RealmEye checks failing

**Check:**

- RealmEye website is accessible (not down)
- Member's profile is public
- Recent RealmEye updates (cache delay)

**Solution:**

- Wait 5-10 minutes and retry
- Use manual verification as backup
- Check bot logs for specific RealmEye API errors

### Bulk sync conflicts

**"IGN already in use"**

- Another member has that IGN registered
- Check verification logs for original owner
- Resolve manually with `/editname` or `/unverify`

**"Member already verified"**

- Entry skipped (expected behavior)
- Sync only updates unverified members

### Session expired during verification

**Cause:** Verification sessions expire after 30 minutes of inactivity.

**Fix:**

- Click verification button again to start fresh session
- Complete verification faster (especially RealmEye method)
- Sessions are tracked per user per guild

---

## Best Practices

### For Security Staff

1. **Respond to manual verifications promptly** (within 24 hours)
2. **Be strict with screenshot quality** — reject blurry/edited images
3. **Log all verification actions** (automatic, but review logs)
4. **Use unverify sparingly** — only for legitimate issues
5. **Keep verification panel visible** — pin it or use dedicated channel

### For Administrators

1. **Test verification flow yourself** before opening to members
2. **Configure both methods** — RealmEye primary, manual as backup
3. **Position bot role correctly** — above all manageable roles
4. **Review verification logs weekly** — catch anomalies early
5. **Back up raider database** — contains all verified members

### For Members

1. **Use RealmEye if possible** — faster and automated
2. **Have IGN ready** — exact spelling from in-game
3. **Enable DMs from bot** — required for verification flow
4. **Don't forge screenshots** — results in permanent ban
5. **Ask staff if stuck** — don't create multiple tickets

---

## Common Workflows

### Standard New Member Verification

1. Member joins Discord server
2. Sees welcome message pointing to #get-verified
3. Clicks verification button
4. Completes RealmEye or manual flow
5. Receives role, can join raids

### Re-verification After Name Change

1. Member changes IGN in-game
2. Staff updates: `/editname member:@User ign:NewName`
3. Nickname automatically updated
4. Verification status unchanged

### Suspicious Verification

1. Manual verification submitted with questionable screenshot
2. Staff denies ticket with reason
3. Member receives denial notification
4. Member can resubmit with better proof OR
5. Staff escalates to moderator for investigation

### Bulk Migration from Spreadsheet

1. Admin exports verified members from old system
2. Formats data: `UserID MainIGN AltIGN`
3. Runs `/syncteam` and pastes formatted list
4. Reviews sync results in logs
5. Manually handles conflicts/errors
6. Announces migration complete

---

## Next Steps

- **[Set up raid management](raid-management.md)** — Let verified members join runs
- **[Configure quota system](quota-system.md)** — Track organizer activity
- **[Review moderation tools](moderation.md)** — Manage verified members

---

## Summary

Verification is complete when:

- ✅ Verification panel posted and accessible
- ✅ At least one method enabled (RealmEye or manual)
- ✅ Test verification successful (gave role + updated nickname)
- ✅ Logs appearing in `veri_log` channel
- ✅ Security staff trained on manual review process (if using)

**Common verification roles:** `security`, `moderator`, `administrator`
