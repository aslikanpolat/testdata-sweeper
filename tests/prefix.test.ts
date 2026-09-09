import { describe, expect, it } from 'vitest';
import { assertPrefix, createPrefix, escapeLikePrefix, escapeRegex } from '../src/prefix.js';

describe('prefix helpers', () => {
  it('creates deterministic run prefixes when inputs are supplied', () => {
    expect(createPrefix(new Date('2026-09-09T12:00:00Z'), 'abc12345')).toBe('testdata_20260909_abc12345_');
  });

  it('escapes SQL LIKE and regex metacharacters', () => {
    expect(escapeLikePrefix('testdata_20260909_x%_')).toBe('testdata\\_20260909\\_x\\%\\_%');
    expect(escapeRegex('qa.a+b?')).toBe('qa\\.a\\+b\\?');
  });

  it('rejects prefixes without the run format', () => {
    expect(() => assertPrefix('anything')).toThrow();
  });
});
