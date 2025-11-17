/**
 * Mock helpers for authorization tests.
 * 
 * These utilities help test authorization logic without requiring real database access.
 */

import { vi } from 'vitest';

/**
 * Mock the hasInternalRole function for testing authorization logic.
 * 
 * Usage:
 * ```ts
 * const mockHasInternalRole = createMockHasInternalRole();
 * mockHasInternalRole.mockResolvedValue(true); // User has role
 * ```
 */
export function createMockHasInternalRole() {
  return vi.fn().mockResolvedValue(false);
}

/**
 * Mock the getGuildRoles function.
 * 
 * Usage:
 * ```ts
 * const mockGetGuildRoles = createMockGetGuildRoles();
 * mockGetGuildRoles.mockResolvedValue({ organizer: '123456' });
 * ```
 */
export function createMockGetGuildRoles() {
  return vi.fn().mockResolvedValue({});
}

/**
 * Create a simple mock for database queries.
 * 
 * Usage:
 * ```ts
 * const mockQuery = createMockQuery();
 * mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
 * ```
 */
export function createMockQuery() {
  return vi.fn();
}

/**
 * Create a mock RunRow for authorization tests.
 */
export function createMockRun(overrides?: {
  organizer_id?: string;
  guild_id?: string;
  status?: string;
}) {
  return {
    organizer_id: '111111111111111111',
    guild_id: '999999999999999999',
    status: 'open',
    ...overrides,
  };
}

/**
 * Create a mock RunActorContext for authorization tests.
 */
export function createMockActor(overrides?: {
  userId?: string;
  userRoles?: string[];
}) {
  return {
    userId: '222222222222222222',
    userRoles: [],
    ...overrides,
  };
}
