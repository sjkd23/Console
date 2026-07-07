# ROTMG Raid Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A comprehensive Discord bot for organizing **Realm of the Mad God** raids. Features automated run management, dual verification (RealmEye + Screenshot), moderation tools, and staff quota tracking.


**[View Complete Documentation](docs/README.md)** — Setup guides, command reference, and architecture

---

## Features

- **Raid Management:** Interactive panels, join buttons, headcount tracking, and automated run timers.
- **Verification:** Automated RealmEye verification and manual screenshot review system with audit logs.
- **Moderation:** Warnings, timed suspensions, mutes, bans, and staff notes.
- **Quota & Points:** Automated tracking for organizers and raiders with leaderboard support.
- **Logging:** Extensive logging for commands, raids, and moderation actions.

## Tech Stack

- **Bot:** Discord.js 14, TypeScript
- **Backend:** Fastify, Node.js 18+
- **Database:** PostgreSQL 14+
- **Infrastructure:** Docker Compose

## Installation

### Prerequisites
- Docker & Docker Compose (Recommended)
- Discord Bot Token ([Developer Portal](https://discord.com/developers/applications))

### Quick Start (Docker)

1.  **Clone the repository**
    ```bash
    git clone <repo-url>
    cd rotmg-raid-bot
    ```

2.  **Configure Environment**
    Create `backend/.env` and `bot/.env`. Ensure `BACKEND_API_KEY` matches in both.

    **backend/.env**
    ```env
    PORT=4000
    BACKEND_API_KEY=your_secret_key
    DATABASE_URL=postgres://postgres:postgres@db:5432/rotmg_raids
    ```

    **bot/.env**
    ```env
    APPLICATION_ID=your_app_id
    SECRET_KEY=your_bot_token
    DISCORD_GUILD_IDS=your_guild_id
    BACKEND_URL=http://backend:4000/v1
    BACKEND_API_KEY=your_secret_key
    ```

3.  **Run**
    ```bash
    docker-compose up -d
    ```

### Manual Setup
For local development without Docker, install dependencies and run `npm run dev` in both `backend` and `bot` directories. Ensure PostgreSQL is running locally.

## Configuration

1.  **Set Roles:** Map Discord roles to bot permissions.
    `/setroles organizer:@RaidLeader security:@Security verified_raider:@Verified ...`
2.  **Set Channels:** Configure log and panel channels.
    `/setchannels raid:#raids logs:#logs ...`
3.  **Verify:** Run `/run dungeon:Shatters` to test.

## Usage

- **Raids:** `/run`, `/headcount`, `/logrun`, `/taken`, `/party`
- **Verification:** `/configverification`, `/verify` (staff), `/createrole`
- **Moderation:** `/warn`, `/suspend`, `/mute`, `/kick`, `/ban`, `/find`
- **Quota:** `/configquota`, `/configpoints`, `/stats`, `/leaderboard`, `/logkey`
- **Config:** `/setroles`, `/setchannels`, `/configrolepings`

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
