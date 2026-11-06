/**
 * Boundary arithmetic for `reminderStage` (DEV_PLAN §2.13).
 *
 * The ladder is pure date maths, so unlike the sweep suites it needs no
 * database and runs everywhere. It exists because the original defect was
 * entirely in the boundaries: the weekly stages were counted from `due + 3d`
 * instead of `due`, so `weekly:1` first fired on day 10, the 3-7 day bucket was
 * labelled "three days overdue", and the ladder never terminated.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reminderStage } from '../lib/notify.js';

const DUE = new Date('2026-03-10T16:00:00Z');
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Stage key at `offsetMs` from the due date, or null when the ladder is done. */
const keyAt = (offsetMs: number) =>
  reminderStage(new Date(DUE.getTime() + offsetMs), DUE)?.key ?? null;

const labelAt = (offsetMs: number) =>
  reminderStage(new Date(DUE.getTime() + offsetMs), DUE)?.label ?? null;

describe('reminderStage boundaries', () => {
  it('stays quiet until the T-24h window opens', () => {
    assert.equal(keyAt(-2 * DAY), null);
    assert.equal(keyAt(-DAY - HOUR), null);
  });

  it('walks friendly -> firm -> final as the clock passes each boundary', () => {
    assert.equal(keyAt(-DAY), 'due-24h');
    assert.equal(keyAt(-HOUR), 'due-24h');
    assert.equal(keyAt(0), 'due');
    assert.equal(keyAt(DAY - 1), 'due');
    assert.equal(keyAt(DAY), 'late-24h');
    assert.equal(keyAt(3 * DAY - 1), 'late-24h');
    assert.equal(keyAt(3 * DAY), 'late-72h');
  });

  it('labels the 3-7 day bucket with the real number of days late', () => {
    assert.equal(labelAt(3 * DAY), '3 days overdue');
    assert.equal(labelAt(6 * DAY), '6 days overdue');
  });

  it('anchors weekly stages on the due date', () => {
    // Day 7 is one complete week late. Day 9 used to report "three days
    // overdue" and day 10 used to be the first `weekly:1`, because the week
    // counter started from due+3d.
    assert.equal(keyAt(7 * DAY), 'weekly:1');
    assert.equal(keyAt(9 * DAY), 'weekly:1');
    assert.equal(keyAt(10 * DAY), 'weekly:1');
    assert.equal(keyAt(14 * DAY), 'weekly:2');
    assert.equal(labelAt(9 * DAY), '1 week overdue');
  });

  it('stops after four weekly nudges instead of counting forever', () => {
    assert.equal(keyAt(28 * DAY), 'weekly:4');
    assert.equal(keyAt(34 * DAY), 'weekly:4');
    assert.equal(keyAt(35 * DAY), null);
    assert.equal(keyAt(365 * DAY), null);
  });
});
