# Backend Testing

This directory contains the test suite for the rotmg-raid-bot backend.

## Setup

Tests use **Vitest** as the test framework. The suite includes:

- **Unit tests with mocks**: `test/auth/authorization.test.ts`
- **Integration tests with real DB**: `test/services/quota-service.test.ts`, `test/services/run-service.test.ts`

### Prerequisites

For integration tests that require a real PostgreSQL database:

1. Set up a dedicated test database (do NOT use your production database!)
2. Set the `DATABASE_URL` environment variable to point to your test database
3. Run migrations on the test database:
   ```bash
   npm run migrate
   ```

**⚠️ WARNING**: Integration tests use `TRUNCATE` to clean all data between tests. Only use a dedicated test database!

## Running Tests

```bash
# Run all tests once
npm test

# Run tests in watch mode (re-runs on file changes)
npm run test:watch

# Run with coverage report
npm run test:coverage
```

## Test Structure

```
test/
├── helpers/
│   ├── test-db.ts       # Database setup/teardown utilities
│   └── mocks.ts         # Mock helpers for unit tests
├── auth/
│   └── authorization.test.ts  # Authorization logic tests (mocked)
└── services/
    ├── quota-service.test.ts  # QuotaService tests (real DB)
    └── run-service.test.ts    # RunService tests (real DB)
```

## Test Categories

### Unit Tests (Mocked)
- **`authorization.test.ts`**: Tests `authorizeRunActor` with mocked database access
  - Auto-end bypass logic
  - Organizer role checks
  - Run organizer checks
  - Authorization priority
  - Denial cases

### Integration Tests (Real DB)
- **`quota-service.test.ts`**: Tests `QuotaService` with real PostgreSQL
  - `awardOrganizerQuota` - organizer quota points
  - `awardRaidersQuotaFromParticipants` - raider points from participant list
  - `awardRaidersQuotaFromSnapshot` - raider points from key pop snapshot
  - Idempotency guarantees
  - Custom point configurations

- **`run-service.test.ts`**: Tests `RunService` transaction flows
  - `endRunWithTransaction` - full end-run flow
  - Run status updates
  - Organizer + raider point awards
  - Snapshot vs participant fallback logic
  - Transaction atomicity
  - Idempotency

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string for test database
  - Example: `postgresql://user:pass@localhost:5432/rotmg_raid_test`

## CI/CD Considerations

For continuous integration:
1. Spin up a test PostgreSQL instance (e.g., via Docker)
2. Run migrations
3. Execute tests
4. Tear down the test database

Example Docker setup:
```bash
docker run -d --name test-postgres \
  -e POSTGRES_DB=rotmg_raid_test \
  -e POSTGRES_USER=test \
  -e POSTGRES_PASSWORD=test \
  -p 5433:5432 \
  postgres:16

export DATABASE_URL="postgresql://test:test@localhost:5433/rotmg_raid_test"
npm run migrate
npm test
```
