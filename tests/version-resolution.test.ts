/**
 * version-resolution.test.ts — the delivery version + feature resolution matrix
 * (execution plan §1.2).
 *
 * Pure, no DB. This logic is tested exhaustively because BOTH of its failure
 * modes are SILENT: a customer receives the wrong build, or is promised
 * features their build cannot deliver, with nothing in the logs to explain it.
 * A wrong answer here surfaces as a confused support ticket weeks later, not as
 * an exception — so the matrix is pinned rather than sampled.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveVersion, resolveFeatures, missingFromBuild, channelAllows,
  eligibleAsDefault,
} from '../src/licensing/version-resolution';

describe('resolveVersion — the four-step chain, first match wins', () => {
  it('1. a pin beats everything else', () => {
    expect(resolveVersion({
      pinnedVersion: '1.0.0',
      overrideVersion: '1.5.0',
      channelDefault: '1.4.0',
      globalDefault: '1.3.0',
    })).toEqual({ version: '1.0.0', source: 'pin' });
  });

  it('2. an admin override beats channel + global', () => {
    expect(resolveVersion({
      overrideVersion: '1.5.0',
      channelDefault: '1.4.0',
      globalDefault: '1.3.0',
    })).toEqual({ version: '1.5.0', source: 'override' });
  });

  it('3. the channel default beats the global default', () => {
    expect(resolveVersion({ channelDefault: '1.4.0', globalDefault: '1.3.0' }))
      .toEqual({ version: '1.4.0', source: 'channel' });
  });

  it('4. the global default is the fallback', () => {
    expect(resolveVersion({ globalDefault: '1.3.0' }))
      .toEqual({ version: '1.3.0', source: 'global' });
  });

  it('resolves to nothing when no default is configured (caller must handle it)', () => {
    expect(resolveVersion({})).toEqual({ version: null, source: 'none' });
  });

  it('treats null/undefined/empty-string as "not set", not as a value', () => {
    expect(resolveVersion({
      pinnedVersion: null,
      overrideVersion: undefined,
      channelDefault: '',
      globalDefault: '1.3.0',
    })).toEqual({ version: '1.3.0', source: 'global' });
  });

  // PINNING IS A PROMISE — these three cases are the whole point of the feature.
  describe('a pin is absolute', () => {
    it('a new global default does NOT move a pinned customer', () => {
      expect(resolveVersion({ pinnedVersion: '1.0.0', globalDefault: '9.9.9' }).version)
        .toBe('1.0.0');
    });

    it('a channel promotion does NOT move a pinned customer', () => {
      expect(resolveVersion({ pinnedVersion: '1.0.0', channelDefault: '9.9.9' }).version)
        .toBe('1.0.0');
    });

    it('a ROLLBACK does not move a pinned customer either', () => {
      // Rollback = moving the global default backwards. A pinned customer is
      // unaffected by both the bad release and the rollback — that is the point.
      expect(resolveVersion({ pinnedVersion: '1.4.0', globalDefault: '1.2.0' }).version)
        .toBe('1.4.0');
    });
  });
});

describe('resolveFeatures — package ∩ build (T14, the silent failure)', () => {
  it('grants only what BOTH the plan allows and the build supports', () => {
    expect(resolveFeatures(
      ['text.bold', 'table.insert', 'export.pdf'],
      ['text.bold', 'table.insert', 'text.italic'],
    )).toEqual(['table.insert', 'text.bold']);
  });

  it('DRIFT A: a feature added to the plan later still reaches an old licence', () => {
    // The customer's licence snapshot is irrelevant — the PACKAGE is the source
    // of truth. A Pro customer from January receives table.merge once their
    // build supports it, without re-purchasing.
    const packageFeatures = ['text.bold', 'table.merge']; // plan gained table.merge
    const buildSupports = ['text.bold', 'table.merge'];   // build has it
    expect(resolveFeatures(packageFeatures, buildSupports)).toContain('table.merge');
  });

  it('DRIFT B: a pinned customer is never promised what their build lacks', () => {
    // Plan grants table.merge, but they are pinned to an old build without it.
    // The token must not claim it — otherwise the editor gates the feature ON
    // and it silently does nothing.
    const packageFeatures = ['text.bold', 'table.merge'];
    const oldBuild = ['text.bold'];
    expect(resolveFeatures(packageFeatures, oldBuild)).toEqual(['text.bold']);
  });

  it('a build supporting extra features does not grant them without the plan', () => {
    // The premium BUILD contains export.pdf, but a free PLAN must not get it.
    expect(resolveFeatures(['text.bold'], ['text.bold', 'export.pdf']))
      .toEqual(['text.bold']);
  });

  it('returns a sorted, de-duplicated-by-construction list', () => {
    expect(resolveFeatures(['c', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('empty plan or empty build grants nothing', () => {
    expect(resolveFeatures([], ['a'])).toEqual([]);
    expect(resolveFeatures(['a'], [])).toEqual([]);
  });

  // REGRESSION — found by the delivery e2e test, not by unit tests.
  // The free tier has no package to intersect against. Passing [] intersected
  // to nothing, so an anonymous user received a working free bundle with every
  // feature switched off. The '*' sentinel means "whatever this build has".
  describe("the '*' sentinel — the free tier has no package", () => {
    it('grants everything the build supports', () => {
      expect(resolveFeatures(['*'], ['text.bold', 'text.italic']))
        .toEqual(['text.bold', 'text.italic']);
    });

    it('is still bounded BY THE BUILD — it cannot conjure premium features', () => {
      // A free build does not contain export.pdf, so '*' cannot grant it. The
      // build itself is the entitlement boundary.
      expect(resolveFeatures(['*'], ['text.bold'])).toEqual(['text.bold']);
    });

    it('reports nothing missing, since it asked for whatever exists', () => {
      expect(missingFromBuild(['*'], ['text.bold'])).toEqual([]);
    });
  });
});

describe('missingFromBuild — observability for silent feature loss', () => {
  it('reports paid features the served build cannot provide', () => {
    expect(missingFromBuild(['text.bold', 'table.merge'], ['text.bold']))
      .toEqual(['table.merge']);
  });

  it('is empty when the build satisfies the whole plan', () => {
    expect(missingFromBuild(['text.bold'], ['text.bold', 'extra'])).toEqual([]);
  });
});

describe('channelAllows — a ladder, not a set', () => {
  it('a stable customer receives only stable builds', () => {
    expect(channelAllows('stable', 'stable')).toBe(true);
    expect(channelAllows('stable', 'beta')).toBe(false);
    expect(channelAllows('stable', 'internal')).toBe(false);
  });

  it('a beta customer receives beta AND stable (stable is more conservative)', () => {
    expect(channelAllows('beta', 'stable')).toBe(true);
    expect(channelAllows('beta', 'beta')).toBe(true);
    expect(channelAllows('beta', 'internal')).toBe(false);
  });

  it('internal receives everything', () => {
    expect(channelAllows('internal', 'stable')).toBe(true);
    expect(channelAllows('internal', 'beta')).toBe(true);
    expect(channelAllows('internal', 'internal')).toBe(true);
  });
});

describe('eligibleAsDefault — retired builds serve pins but are never chosen', () => {
  it('published builds may become a default', () => {
    expect(eligibleAsDefault('published')).toBe(true);
  });

  it('retired builds may NOT become a default', () => {
    // They remain serveable to customers pinned to them — retirement stops new
    // installs, it does not break existing ones. Deleting would.
    expect(eligibleAsDefault('retired')).toBe(false);
  });
});
