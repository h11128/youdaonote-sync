/**
 * Authentication module.
 *
 * Browser-based login (Playwright) is kept as a separate concern.
 * This module provides the minimal entry point; the full Playwright
 * flow will be implemented when the CLI layer is built.
 */

export function browserLogin(): Promise<string | null> {
  // Placeholder: Playwright persistent context login
  // Implementation deferred to Phase 5 (CLI layer)
  return Promise.reject(
    new Error(
      'Browser login not yet implemented in TypeScript. ' +
        'Use the Python CLI (python -m src login) to obtain cookies, ' +
        'then the TS engine can use the shared cookies.json.',
    ),
  );
}
