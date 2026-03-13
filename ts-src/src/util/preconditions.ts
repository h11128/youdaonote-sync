/**
 * Centralized precondition checks. All public functions that accept constrained
 * arguments should use these instead of ad-hoc validation.
 */

export function requireNonEmpty(name: string, value: string): void {
  if (!value) throw new Error(`${name} must not be empty`);
}

export function requireDefined<T>(name: string, value: T | null | undefined): T {
  if (value == null) throw new Error(`${name} is required`);
  return value;
}
