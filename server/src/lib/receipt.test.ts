/**
 * Currency acceptance for the receipt draft (DEV_PLAN §2.7).
 *
 * A vision model handed a Thai receipt answers "USD" out of habit, and every
 * amount then renders with a dollar sign even though the bill is kept in THB
 * and nothing was converted. A code that differs from the bill's currency is
 * therefore only trusted when the model also quotes the printed marker that
 * names it — "THB", "฿" or "บาท".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeDraft } from '../lib/receipt.js';

const receipt = (currency: unknown, evidence?: unknown, fallback = 'THB') =>
  normalizeDraft(
    {
      merchant: 'SAI THAI KITCHEN',
      currency,
      ...(evidence === undefined ? {} : { currency_evidence: evidence }),
      items: [{ name: 'Pad Thai Goong', qty: 1, unit_price_minor: 18000, line_total_minor: 18000 }],
      total_minor: 18000,
    },
    fallback,
  );

describe('receipt currency', () => {
  it('keeps the printed code when it matches the bill', () => {
    assert.equal(receipt('THB', 'THB')?.currency, 'THB');
    assert.equal(receipt('thb', 'บาท')?.currency, 'THB');
  });

  it('falls back when the model omits the currency', () => {
    assert.equal(receipt(undefined)?.currency, 'THB');
    assert.equal(receipt(null)?.currency, 'THB');
  });

  it('drops a habitual USD with no printed evidence', () => {
    assert.equal(receipt('USD', null)?.currency, 'THB');
    assert.equal(receipt('USD')?.currency, 'THB');
    assert.equal(receipt('USD', '   ')?.currency, 'THB');
  });

  it('keeps a differing code the receipt actually prints', () => {
    assert.equal(receipt('USD', '$')?.currency, 'USD');
    assert.equal(receipt('THB', 'TOTAL (THB)', 'USD')?.currency, 'THB');
  });

  it('rejects a malformed code even with evidence', () => {
    assert.equal(receipt('US', '$')?.currency, 'THB');
    assert.equal(receipt('DOLLARS', '$')?.currency, 'THB');
  });
});
