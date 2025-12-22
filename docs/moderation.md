# Moderation Guide

Complete guide to punishments, modmail, notes, and message management.

**Audience:** Security staff, officers, and moderators handling discipline and support.

---

## Overview

The moderation system provides:

- **Punishments** — Warnings, suspensions, mutes, kicks, bans
- **Auto-Expiration** — Suspensions and mutes automatically lift after duration
- **Modmail** — Private support ticket system via DMs
- **Notes** — Staff-only notes on members
- **Message Management** — Bulk delete with rate limiting
- **Audit Logging** — All actions logged for accountability

---

## Punishment Types

### Warnings

**Non-restrictive disciplinary record.**

```
/warn
  member: @User
  reason: Spamming in chat
```

**Effects:**
- Creates punishment record in database
- Logged to `punishment_log` channel
- No role changes or restrictions
- Visible in `/checkpunishments`

**Use when:**
- First offense for minor rule violation
- Documenting verbal warning
- Building case for escalation

### Suspensions

**Temporary ban from raid participation.**

```
/suspend
  member: @User
  duration: 5h (or 2d for 2 days)
  reason: Toxic behavior in run
```

**Duration format:**
- `30m` = 30 minutes
- `5h` = 5 hours
- `2d` = 2 days
- **Maximum:** 30 days (720 hours)

**Effects:**
- Assigns `suspended` role
- Member cannot join raids
- Role auto-removed after duration expires
- Logged to `punishment_log`
- DM sent to member (if DMs open)

**Auto-expiration:**
- Checked every 5 minutes by scheduled task
- Role removed automatically when time expires
- Database updated to mark as expired

### Mutes

**Temporary prevention from sending messages.**

```
/mute
  member: @User
  duration: 30m
  reason: Harassment
```

**Duration format:**
- `30m` = 30 minutes
- `5h` = 5 hours
- `2d` = 2 days
- **Maximum:** 30 days

**Effects:**
- Assigns `muted` role
- Member cannot send messages (if role configured with permissions)
- Role auto-removed after duration
- Logged and DM sent

**Role permissions:**
The `muted` role must be configured in Discord to deny:
- Send Messages
- Add Reactions
- Use Voice Activity

### Kicks

**Remove member from server (can rejoin).**

```
/kick
  member: @User
  reason: Repeated rule violations
```

**Effects:**
- Member removed from server
- Can rejoin with new invite
- Logged to `punishment_log`
- DM sent before kick (if possible)

**Requires:** `Kick Members` bot permission

### Bans

**Permanent removal from server.**

```
/ban
  member: @User
  reason: Severe toxicity
```

**Effects:**
- Member permanently banned
- Cannot rejoin unless unbanned
- Logged to `punishment_log`
- DM sent before ban (if possible)

**Requires:** `Ban Members` bot permission

### Softbans

**Ban then immediately unban (purges messages).**

```
/softban
  member: @User
  reason: Spam cleanup
```

**Effects:**
- Member banned then unbanned
- Deletes their recent messages (Discord purge)
- Member can rejoin immediately
- Useful for message cleanup without long-term ban

**Use when:**
- Spam bot needs message cleanup
- Member flooded chat with unwanted content
- Want to purge messages but allow return

### Unbans

**Remove permanent ban.**

```
/unban
  user_id: 123456789012345678
  reason: Appeal accepted
```

**Note:** Requires user ID (not @mention) since they're not in the server.

---

## Managing Punishments

### Check Punishment History

**View all punishments for a member:**

```
/checkpunishments
  member: @User
```

**Interactive panel shows:**
- All warnings (active and expired)
- All suspensions (active and expired)
- All mutes (active and expired)
- Staff notes (toggle view)
- Pagination for long histories
- Who issued each punishment
- When issued and when expires

**Accessible to:** Security+ role

### Remove Punishment

**Delete a punishment record:**

```
/removepunishment
  punishment_id: abc123def456
  reason: Issued in error
```

**Effects:**
- Removes database record
- Does NOT remove active role (use `/unsuspend` or `/unmute` for that)
- Logs removal action
- Primarily for record-keeping corrections

**Authorization:**
- Security can remove warnings and own punishments
- Administrator can remove any punishment

### Unsuspend

**Manually lift an active suspension:**

```
/unsuspend
  member: @User
  reason: Good behavior, early release
```

**Effects:**
- Removes `suspended` role immediately
- Marks punishment as inactive
- Logged to `punishment_log`

### Unmute

**Manually lift an active mute:**

```
/unmute
  member: @User
  reason: Apologized
```

**Effects:**
- Removes `muted` role immediately
- Marks punishment as inactive
- Logged to `punishment_log`

---

## Staff Notes

### Add Note

**Create internal staff note on a member:**

```
/addnote
  member: @User
  note: Warned about behavior in voice chat
```

**Effects:**
- Stores note in database
- Visible to Security+ staff
- Appears in `/checkpunishments` under "Notes" tab
- Logged for audit trail

**Use for:**
- Recording verbal warnings
- Documenting suspicious behavior
- Context for future decisions
- Non-public information

**Maximum:** 1000 characters per note

### View Notes

Notes are visible in `/checkpunishments` — toggle between "Punishments" and "Notes" view.

**No separate delete command** — notes are permanent unless database admin removes them.

---

## Modmail System

### How Modmail Works

**Member-initiated support system via DMs:**

1. Member runs `/modmail` anywhere
2. Bot DMs them asking which server
3. Member selects guild from dropdown
4. Member provides message (+ optional attachments)
5. Ticket created in `modmail` channel (forum thread)
6. Staff replies in thread
7. Bot relays message to member's DMs
8. Conversation continues until ticket closed

**Fully private** — only visible to staff and the member.

### Member Flow

**Step 1:** Member runs `/modmail`

**Step 2:** Bot DMs: "Which server do you need help with?"
- Dropdown shows all mutual servers
- Member selects one

**Step 3:** Bot asks: "What's your message?"
- Member types question/issue
- Optional: Attach screenshots

**Step 4:** Ticket created
- Unique ID: `MM-ABC123`
- Posted to configured `modmail` channel
- Member receives confirmation DM

**Step 5:** Wait for staff response
- Staff replies in thread
- Bot relays to member's DM

**Step 6:** Member replies in DM
- Message added to thread
- Staff sees it in real-time

**Step 7:** Staff closes ticket when resolved

### Staff Workflow

**1. New Ticket Notification**

When member opens ticket:
- Forum thread created in `modmail` channel
- Contains: Member info, message, attachments
- Thread title: `MM-ABC123 - Username`

**2. Review Ticket**

Read member's message and any context:
- Check their verification status
- Review punishment history if relevant
- Consult other staff if needed

**3. Reply to Ticket**

```
/modmailreply
  ticket_id: MM-ABC123
  message: Thanks for reaching out! Let me help with that.
```

**Or:** Just reply in the forum thread — bot monitors and relays.

**4. Continue Conversation**

- Member replies in DM → appears in thread
- Staff replies in thread → sent to member DM
- Fully bidirectional

**5. Close Ticket**

React with ✅ in thread or use close button.

**Effects:**
- Thread locked and archived
- Member receives "ticket closed" DM
- Ticket status set to `closed` in database

### Modmail Commands

**Reply to ticket:**
```
/modmailreply
  ticket_id: MM-ABC123
  message: Your response
```

**Blacklist user from modmail:**
```
/modmailblacklist
  member: @User
  reason: Abuse of system
```

**Effects:**
- User cannot create new tickets
- Attempting to open ticket shows "You are blacklisted"
- Existing tickets remain accessible

**Unblacklist user:**
```
/modmailunblacklist
  member: @User
  reason: Appeal accepted
```

### Modmail Configuration

**Set modmail channel:**
```
/setchannels
  modmail: #support-tickets
```

**Must be a forum channel** (not regular text channel).

**Forum automatically:**
- Creates threads for each ticket
- Tags can be added for organization (e.g., "urgent", "resolved")
- Archived threads remain searchable

---

## Message Management

### Purge Messages

**Bulk delete messages in current channel:**

```
/purge
  amount: 25
```

**Maximum:** 25 messages per use

**Behavior:**
- Skips pinned messages (preserved)
- Cannot delete messages older than 14 days (Discord limitation)
- Deletes from most recent backwards

**Rate Limited:**
- 3 uses per minute
- 10 uses per hour
- Prevents abuse

**Requires:**
- Security+ role
- Bot needs `Manage Messages` permission

**Use cases:**
- Spam cleanup
- Clear off-topic discussion
- Remove bot command spam
- Clean up before announcements

**After 14 days:**
Messages older than 14 days cannot be bulk deleted (Discord API restriction). Must delete manually or use other tools.

---

## Role Hierarchy & Authorization

### Punishment Authorization

| Punishment Type | Required Role | Can Target |
|----------------|---------------|------------|
| Warn | Security | Members below in hierarchy |
| Suspend | Security | Members below in hierarchy |
| Mute | Security | Members below in hierarchy |
| Unsuspend | Security | Anyone with active suspension |
| Unmute | Security | Anyone with active mute |
| Kick | Officer | Members below in hierarchy |
| Ban | Officer | Members below in hierarchy |
| Softban | Officer | Members below in hierarchy |
| Unban | Officer | Any banned user |
| Remove Punishment | Admin (any) / Security (own) | N/A |

**Hierarchy enforcement:**
- Cannot target members with equal or higher roles
- Cannot target yourself
- Cannot target bots
- Bot must be positioned above target in role hierarchy

### Modmail Authorization

| Action | Required Role |
|--------|---------------|
| Reply to ticket | Security |
| Blacklist user | Officer |
| Unblacklist user | Officer |
| View tickets | Security |

### Notes Authorization

| Action | Required Role |
|--------|---------------|
| Add note | Security |
| View notes | Security |

---

## Logging & Audit Trail

### Punishment Logs

**All moderation actions logged to `punishment_log` channel:**

**Log entries include:**
- Timestamp
- Action type (warn/suspend/kick/ban/etc.)
- Moderator who issued
- Target member
- Reason provided
- Duration (if applicable)
- Expiration time (if applicable)

**Example log:**
```
⚠️ Warning Issued
Moderator: @StaffMember
Member: @TargetUser
Reason: Spamming in chat
ID: abc123def456
```

### Automatic Expiration Logs

**When suspensions/mutes expire automatically:**

```
✅ Suspension Expired
Member: @TargetUser
Duration: 5 hours
Issued by: @StaffMember
Auto-removed by: System
```

### Command Logging

**All moderation commands logged to `bot_log` channel:**
- Who executed
- Which command
- Parameters used
- Success/failure
- Execution time

---

## Troubleshooting

### Role not assigned/removed

**Check:**
- Bot's role is positioned above `suspended`/`muted` roles
- Bot has "Manage Roles" permission
- Roles are correctly mapped: `/setroles`

**Fix:**
1. Server Settings → Roles
2. Drag bot role above punishment roles
3. Retry command

### Auto-expiration not working

**Wait 5 minutes** — expiration checked every 5 minutes, not real-time.

**If still not expiring:**
- Check backend is running
- Check scheduled task logs
- Manually unsuspend/unmute as workaround

### Can't punish member

**Error:** "Target member has equal or higher role"

**Cause:** Role hierarchy violation.

**Fix:**
- Escalate to higher-ranked staff member
- Administrator can punish moderators
- Server owner can punish anyone

### Modmail not working

**Member can't create ticket:**
- Check they have DMs enabled
- Check bot has permissions in `modmail` channel
- Check they're not blacklisted

**Staff can't reply:**
- Check `modmail` channel is configured
- Check Security+ role
- Ensure forum thread not manually locked

### Purge failing

**Error:** "Missing Permissions"

**Fix:**
- Grant bot `Manage Messages` permission
- Ensure Security+ role for invoker

**Error:** "Messages too old"

**Cause:** Discord can't bulk delete messages older than 14 days.

**Solution:**
- Delete recent messages first
- Manually delete older messages
- Use archive/hide channel instead

### DM notifications not sent

**Common for punishments (suspend/mute/kick/ban).**

**Cause:** User has DMs disabled from server members.

**Expected behavior:**
- Bot attempts DM
- If fails, continues with punishment
- Logs "DM failed" in punishment log
- Member not notified but action proceeds

---

## Best Practices

### For Security Staff

1. **Always provide detailed reasons** — helps with appeals and audits
2. **Start with warnings** — escalate gradually
3. **Check punishment history first** — `/checkpunishments`
4. **Document everything in notes** — context matters
5. **Communicate with team** — discuss unclear cases

### For Officers

1. **Use kicks before bans** when appropriate
2. **Review ban appeals fairly** — check history
3. **Monitor modmail regularly** — respond within 24 hours
4. **Don't blacklist lightly** — only for clear abuse
5. **Coordinate major bans** — discuss with team

### For All Moderators

1. **Stay objective** — enforce rules consistently
2. **Explain punishments** — educate, don't just punish
3. **De-escalate when possible** — verbal warnings first
4. **Review logs periodically** — learn from trends
5. **Support each other** — tag team difficult situations

---

## Common Workflows

### Standard Warning → Suspension Escalation

**First offense:**
```
/warn member:@User reason:Spamming
```

**Second offense within period:**
```
/suspend member:@User duration:2h reason:Repeated spamming after warning
```

**Third offense:**
```
/suspend member:@User duration:24h reason:Continued spamming, third offense
```

**Fourth offense:**
```
/kick member:@User reason:Persistent rule violations despite multiple suspensions
```

### Handling Toxic Behavior

**Verbal warning first** (via DM or note):
```
/addnote member:@User note:Verbally warned about toxic language in voice
```

**If continues:**
```
/mute member:@User duration:1h reason:Toxic language after warning
```

**If severe/repeated:**
```
/suspend member:@User duration:1d reason:Severe toxicity
```

**If extreme:**
```
/ban member:@User reason:Extreme harassment, multiple complaints
```

### Modmail Ticket Workflow

1. **New ticket arrives** → Check member info
2. **Assess urgency** → Tag thread if urgent
3. **Reply promptly** → Acknowledge within few hours
4. **Gather info if needed** → Ask clarifying questions
5. **Resolve issue** → Provide solution or escalate
6. **Confirm resolution** → Ask if satisfied
7. **Close ticket** → Archive thread

### Emergency Spam Cleanup

**For spam bot:**
```
/softban member:@SpamBot reason:Spam bot
```
- Instantly removes all recent messages
- Bot can rejoin but likely won't

**For compromised account:**
```
/mute member:@CompromisedUser duration:1h reason:Account compromised
/addnote member:@CompromisedUser note:Notified user account was compromised, awaiting their confirmation
```
- Prevents further damage
- User can contact via modmail when they regain control

---

## Integration with Other Systems

### Verification

**Unverified members cannot be suspended** (no verified status to restrict).

**But can be:**
- Warned (creates record)
- Muted (if they can chat)
- Kicked/Banned

**See:** [verification.md](verification.md)

### Raid Management

**Suspended members cannot join runs** (no `verified_raider` role, have `suspended` role).

**Effects on quota:**
- Organizer suspensions don't affect past quota
- Future runs cannot be created while suspended

**See:** [raid-management.md](raid-management.md)

### Quota System

**Officer+ can adjust points** as punishment/reward.

**Examples:**
- `-10 quota points` as punishment for bad run management
- `+20 raider points` as reward for reporting bugs

**See:** [quota-system.md](quota-system.md)

---

## Next Steps

- **[Review raid management](raid-management.md)** — Understand what suspended members can't access
- **[Set up verification](verification.md)** — Ensure proper member tracking
- **[Configure quota](quota-system.md)** — Use point adjustments for rewards/penalties

---

## Summary

Moderation system is working when:
- ✅ `/warn` creates punishment record and logs
- ✅ `/suspend` assigns role and auto-removes after duration
- ✅ `/mute` works similarly to suspend
- ✅ Expired punishments auto-clear every 5 minutes
- ✅ `/checkpunishments` shows full history with pagination
- ✅ Modmail tickets create forum threads
- ✅ `/purge` deletes messages with rate limiting
- ✅ All actions logged to `punishment_log` channel

**Common moderation commands:** `/warn`, `/suspend`, `/mute`, `/kick`, `/ban`, `/checkpunishments`, `/modmail`
