# RotMG Raid Bot — Documentation

Complete documentation for the Discord raid coordination bot designed for Realm of the Mad God guilds.

> **Documentation Version:** Reflects v1.1 behavior and features. Last updated December 2025.

---

## Overview

This bot provides automated raid management, member verification, quota tracking, and moderation tools for large-scale Realm of the Mad God raiding guilds. It combines a Discord bot with a REST API backend and PostgreSQL database.

---

## Start Here

**Choose your path:**

| Your Role | Read This First | Then Read |
|-----------|----------------|-----------|
| **Guild Administrator** (first-time setup) | [Setup Guide](setup.md) | [Verification](verification.md) |
| **Organizer** (running raids) | [Raid Management](raid-management.md) | [Quota System](quota-system.md) |
| **Security/Officer** (moderation) | [Moderation](moderation.md) | [Verification](verification.md) |
| **Developer** (contributing code) | [Architecture](architecture.md) | All operator docs |

---

## Documentation Files

| Document | Purpose | Audience |
|----------|---------|----------|
| **[setup.md](setup.md)** | Initial bot installation and guild configuration | Administrators |
| **[verification.md](verification.md)** | Member verification workflows (RealmEye + manual) | Security, Admins |
| **[raid-management.md](raid-management.md)** | Creating runs, headcounts, party finder, key tracking | Organizers |
| **[quota-system.md](quota-system.md)** | Quota requirements, points, leaderboards | Officers, Organizers |
| **[moderation.md](moderation.md)** | Punishments, modmail, notes, message management | Security, Officers |
| **[architecture.md](architecture.md)** | Technical architecture and development guide | Contributors |

---

## Role Hierarchy

The bot enforces this permission hierarchy (higher roles inherit all permissions of roles below them):

| Role | Typical Use | Key Permissions |
|------|-------------|-----------------|
| **Administrator** | Guild owner, head staff | All commands, bulk sync, force verification |
| **Moderator** | Senior staff | Message purge, all moderation actions |
| **Head Organizer** | Lead raid organizers | All raid commands, quota adjustments |
| **Officer** | Promoted staff | Kick/ban, quota management, modmail blacklist |
| **Security** | Verification & discipline | Verify, warn, suspend, mute, notes |
| **Organizer** | Run raid events | Create runs, log runs, log keys |
| **Team** | Special access group | (Optional custom permissions) |
| **Verified Raider** | Verified members | Join runs, create party finder posts |

> **Note:** Roles are mapped to Discord roles during setup. See [setup.md](setup.md) for configuration.

---

## Quick Start Flow

For new guilds getting started:

1. **[Install the bot](setup.md#installation)** — Invite bot, configure environment
2. **[Map roles](setup.md#role-mapping)** — Run `/setroles` to map internal roles to Discord roles
3. **[Map channels](setup.md#channel-mapping)** — Run `/setchannels` to configure log channels
4. **[Test verification](verification.md#testing)** — Verify yourself to confirm setup
5. **[Create first run](raid-management.md#creating-a-run)** — Test the raid system
6. **[Configure quota](quota-system.md#configuration)** — Set organizer requirements (optional)

---

## Support

- **Issues & Bugs:** Open an issue in the repository
- **Questions:** Review relevant documentation first
- **Contributing:** See [architecture.md](architecture.md) for development setup

---

## Version

**Current Version:** 1.1  
**Last Updated:** December 2025  
**Status:** Production Ready
