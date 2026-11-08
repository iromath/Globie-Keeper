#!/usr/bin/env node
/**
 * Preview server for the web export.
 *
 * Serves `web-dist` at / and answers the API surface from `lib/queries.ts` at
 * /api/* with in-memory fixtures, so the app can be reviewed in a browser
 * without a Postgres instance.
 *
 * The fixtures are mutable on purpose: confirming an allocation, locking the
 * bill, requesting payments and capturing a share all change state, so the
 * invalidated refetches in the client show real progress instead of 404s.
 *
 *   npx expo export -p web --output-dir web-dist   # once
 *   npm run preview                                # http://localhost:8080/
 */
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../web-dist', import.meta.url));
const PREFIX = process.env.PREVIEW_PREFIX ?? '';
const PORT = Number(process.env.PORT ?? 8080);
const ORIGIN = process.env.PREVIEW_ORIGIN ?? `http://localhost:${PORT}`;
const APP = `${ORIGIN}${PREFIX}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const now = Date.now();
const iso = (msAgo = 0) => new Date(now - msAgo).toISOString();

function makeItems() {
  return [
    { id: 'i1', name: 'Somtam Thai', qty: 2, unitPriceMinor: 6500, lineTotalMinor: 13000, confidence: 0.97 },
    { id: 'i2', name: 'Gai Yang', qty: 1, unitPriceMinor: 18900, lineTotalMinor: 18900, confidence: 0.94 },
    { id: 'i3', name: 'Tom Yum Goong', qty: 1, unitPriceMinor: 22000, lineTotalMinor: 22000, confidence: 0.91 },
    { id: 'i4', name: 'Sticky rice', qty: 4, unitPriceMinor: 3500, lineTotalMinor: 14000, confidence: 0.88 },
    { id: 'i5', name: 'Singha beer', qty: 3, unitPriceMinor: 9500, lineTotalMinor: 28500, confidence: 0.72 },
    { id: 'i6', name: 'Mango sticky rice', qty: 2, unitPriceMinor: 12000, lineTotalMinor: 24000, confidence: 0.95 },
    { id: 'i7', name: 'Pad See Ew', qty: 1, unitPriceMinor: 12500, lineTotalMinor: 12500, confidence: 0.69 },
    { id: 'i8', name: 'Iced tea', qty: 4, unitPriceMinor: 4500, lineTotalMinor: 18000, confidence: 0.93 },
  ];
}

const members = [
  { id: 'm1', groupId: 'g1', userId: 'u1', displayName: 'Ada', role: 'owner', status: 'active' },
  { id: 'm2', groupId: 'g1', userId: 'u2', displayName: 'Bank', role: 'member', status: 'active' },
  { id: 'm3', groupId: 'g1', userId: 'u3', displayName: 'Chai', role: 'fronter', status: 'active' },
  { id: 'm4', groupId: 'g1', userId: 'u4', displayName: 'Dao', role: 'member', status: 'active' },
];

const groups = new Map([
  [
    'g1',
    {
      group: {
        id: 'g1',
        name: 'Friday somtam crew',
        defaultCurrency: 'THB',
        ownerId: 'm1',
        inviteToken: 'SOMTAM24',
        createdAt: iso(6 * 864e5),
      },
      members,
      agreement: {
        id: 'a1',
        groupId: 'g1',
        currency: 'THB',
        estimatedTotalMinor: 248000,
        deadline: iso(-2 * 864e5),
        status: 'accepted',
        createdBy: 'm1',
        acceptedCount: 4,
        memberCount: 4,
      },
    },
  ],
]);

/** Bill id -> bill. New bills from POST /bills land here too. */
const bills = new Map();
/** Allocation id -> allocation. */
const allocations = new Map();
/** Share id -> share. */
const shares = new Map();

let allocationSeq = 0;
let shareSeq = 0;
let billSeq = 1;
let mediaSeq = 0;

/**
 * Notification settings mirror `routes/me.ts`: a missing opt-out means enabled,
 * and only channels this deployment can actually reach are available. The
 * preview has no providers, so remote channels are shown as not set up.
 */
const notificationPreferences = new Map();
let pushRegistered = false;

function notificationSettings() {
  return {
    channels: ['in_app', 'push', 'email', 'whatsapp'].map((channel) => ({
      channel,
      enabled: notificationPreferences.get(channel) !== false,
      available: channel === 'in_app',
    })),
    pushRegistered,
  };
}

function nextAllocationId() {
  allocationSeq += 1;
  return `al${allocationSeq}`;
}

function addAllocation(billItemId, item, memberId, amountMinor) {
  const id = nextAllocationId();
  const allocation = {
    id,
    billItemId,
    memberId,
    memberName: members.find((m) => m.id === memberId)?.displayName ?? memberId,
    itemName: item.name,
    qty: 1,
    amountMinor,
    status: memberId === 'm1' ? 'proposed' : 'confirmed',
  };
  allocations.set(id, allocation);
  return allocation;
}

/** Deterministic "who shared what" so the demo bill looks plausible. */
function sharersOf(item) {
  return ['m1', 'm2', 'm3', 'm4'].filter((_, index) => index <= (item.id.charCodeAt(1) % 4));
}

function allocateBill(bill) {
  for (const allocation of allocations.values()) {
    if (allocation.billItemId.startsWith(bill.id)) allocations.delete(allocation.id);
  }
  for (const item of bill.items) {
    const table = sharersOf(item);
    const lineId = `${bill.id}-${item.id}`;
    for (const memberId of table) {
      addAllocation(lineId, item, memberId, Math.round(item.lineTotalMinor / table.length));
    }
  }
}

const b1 = {
  id: 'b1',
  groupId: 'g1',
  agreementId: 'a1',
  merchant: 'Somtam Der',
  currency: 'THB',
  subtotalMinor: 151000,
  taxMinor: 10800,
  serviceChargeMinor: 15100,
  tipMinor: 0,
  discountMinor: 0,
  totalMinor: 176900,
  status: 'ALLOCATED',
  items: makeItems(),
  framesExtracted: 1,
  warnings: ['Line 5 was low confidence — check the beer count.'],
  createdAt: iso(45 * 60e3),
};
bills.set(b1.id, b1);

for (const item of b1.items) {
  const table = sharersOf(item);
  for (const memberId of table) {
    addAllocation(`b1-${item.id}`, item, memberId, Math.round(item.lineTotalMinor / table.length));
  }
}

function addShare(share) {
  shareSeq += 1;
  const id = `s${shareSeq}`;
  shares.set(id, { id, ...share });
  return shares.get(id);
}

addShare({
  billId: 'b1',
  groupId: 'g1',
  groupName: 'Friday somtam crew',
  memberId: 'm1',
  memberName: 'Ada',
  amountMinor: 46200,
  currency: 'THB',
  status: 'requested',
  dueAt: iso(-1 * 864e5),
  paidAt: null,
  paypalOrderId: 'ORDER-1',
  approveUrl: `${APP}/paypal/return?share=s1`,
});
addShare({
  billId: 'b2',
  groupId: 'g1',
  groupName: 'Saturday brunch',
  memberId: 'm1',
  memberName: 'Ada',
  amountMinor: 31800,
  currency: 'THB',
  status: 'proposed',
  dueAt: iso(-3 * 864e5),
  paidAt: null,
});
addShare({
  billId: 'b3',
  groupId: 'g1',
  groupName: 'Office lunch',
  memberId: 'm1',
  memberName: 'Ada',
  amountMinor: 21900,
  currency: 'THB',
  status: 'disputed',
  dueAt: iso(-4 * 864e5),
  paidAt: null,
});

const leaderboard = [
  { memberId: 'm3', memberName: 'Chai', frontedMinor: 486000, globieBalance: 320, repaymentSpeedHours: 4.2, isHero: true },
  { memberId: 'm1', memberName: 'Ada', frontedMinor: 312000, globieBalance: 210, repaymentSpeedHours: 9.5, isHero: false },
  { memberId: 'm2', memberName: 'Bank', frontedMinor: 148000, globieBalance: 120, repaymentSpeedHours: 22.1, isHero: false },
  { memberId: 'm4', memberName: 'Dao', frontedMinor: 0, globieBalance: 60, repaymentSpeedHours: null, isHero: false },
];

const timeline = [
  { id: 't1', at: iso(4 * 60e3), actor: 'Chai', type: 'bill.parsed', summary: 'read 8 lines from Somtam Der', amountMinor: 176900 },
  { id: 't2', at: iso(38 * 60e3), actor: 'Ada', type: 'allocation.set', summary: 'split the tom yum three ways' },
  { id: 't3', at: iso(2 * 36e5), actor: 'Bank', type: 'agreement.accepted', summary: 'accepted the ฿2,480.00 estimate' },
  { id: 't4', at: iso(3 * 36e5), actor: 'Globie', type: 'globie.nudge', summary: 'pinged Dao about the beer line' },
  { id: 't5', at: iso(26 * 36e5), actor: 'Chai', type: 'share.requested', summary: 'asked Ada for her share', amountMinor: 46200 },
  { id: 't6', at: iso(30 * 36e5), actor: 'Dao', type: 'member.joined', summary: 'joined from the invite link' },
];
let eventSeq = timeline.length;

const activity = [
  { id: 'e1', at: iso(6 * 60e3), actor: 'Ada', type: 'payment.settled', summary: 'paid her share of Somtam Der', amountMinor: 46200, groupId: 'g1', groupName: 'Friday somtam crew', currency: 'THB' },
  { id: 'e2', at: iso(52 * 60e3), actor: 'Globie', type: 'globie.awarded', summary: 'awarded 25 Globie for paying first', groupId: 'g1', groupName: 'Friday somtam crew' },
  { id: 'e3', at: iso(5 * 36e5), actor: 'Bank', type: 'share.requested', summary: 'requested ฿318.00 for brunch', amountMinor: 31800, groupId: 'g2', groupName: 'Saturday brunch', currency: 'THB' },
  { id: 'e4', at: iso(28 * 36e5), actor: 'Chai', type: 'bill.finalized', summary: 'locked the office lunch bill', groupId: 'g3', groupName: 'Office lunch', currency: 'THB' },
  { id: 'e5', at: iso(50 * 36e5), actor: 'Ada', type: 'member.joined', summary: 'joined the somtam crew', groupId: 'g1', groupName: 'Friday somtam crew' },
];

let points = 210;

function pushEvent(actor, type, summary, amountMinor) {
  eventSeq += 1;
  timeline.unshift({ id: `t${eventSeq}`, at: iso(0), actor, type, summary, amountMinor });
}

function billFor(groupId) {
  const owned = [...bills.values()].filter((bill) => bill.groupId === groupId);
  return owned[owned.length - 1] ?? null;
}

function allocationsFor(billId) {
  return [...allocations.values()].filter((allocation) =>
    allocation.billItemId.startsWith(`${billId}-`)
  );
}

function sharesFor(billId) {
  return [...shares.values()].filter((share) => share.billId === billId);
}

function detailFor(groupId) {
  const entry = groups.get(groupId);
  if (!entry) return null;
  return {
    group: entry.group,
    members: entry.members,
    agreement: entry.agreement,
    bill: billFor(groupId),
    me: entry.members[0],
  };
}

/** Stands in for the one-time code the real callback issues. */
const PREVIEW_HANDOFF = 'preview-handoff';

const WRITE_TOOLS = new Set([
  'send_reminder',
  'create_payment_request',
  'award_points',
]);

function agentReply(tool, confirmToken) {
  const open = sharesFor(billFor('g1')?.id ?? 'b1').filter(
    (share) => !['paid', 'settled', 'refunded'].includes(share.status)
  );
  const needsConfirmation = WRITE_TOOLS.has(tool) && !confirmToken;
  if (needsConfirmation) {
    return {
      tool,
      groupId: 'g1',
      executed: false,
      confirmationRequired: true,
      confirmToken: `ct-${tool}`,
      result: {},
      reply: 'Say the word and I will do it. Nothing has moved yet.',
    };
  }
  const replies = {
    get_bill_status: open.length
      ? `${open.length} share${open.length === 1 ? '' : 's'} still open. Chai is chasing the last one.`
      : 'Everyone is paid up.',
    send_reminder: 'Sent a friendly nudge. I will circle back tomorrow if it stays open.',
    create_payment_request: 'PayPal request sent. The link expires in 24 hours.',
    award_points: 'Globie awarded.',
    parse_receipt_media: 'Read the receipt again: 8 lines, no new ones.',
    propose_allocation: 'Split proposed from the receipt lines.',
    request_item_confirmation: 'Asked everyone to confirm their own lines.',
  };
  if (tool === 'award_points') points += 25;
  return {
    tool,
    groupId: 'g1',
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: { shares: open },
    reply: replies[tool] ?? 'Done.',
  };
}

function route(method, path, body) {
  if (method === 'GET' && path === '/api/health') return { ok: true };

  // Email + password sign-in (server/src/routes/auth.ts). The preview keeps no
  // credential store, so any password of the right length passes; the display
  // name is derived from the address so a review sign-in is stable across reloads.
  if (method === 'POST' && path === '/api/auth/session') {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email.includes('@') || password.length < 8) {
      return {
        __status: 400,
        code: 'invalid_request',
        message: 'email and a password of at least 8 characters are required',
      };
    }
    const localPart = email.split('@')[0].replace(/[._-]+/g, ' ');
    const displayName =
      body?.displayName ?? (localPart.charAt(0).toUpperCase() + localPart.slice(1) || 'Ada');
    return { token: 'demo-token', userId: 'u1', displayName };
  }

  if (method === 'POST' && path === '/api/auth/logout') return { __status: 204 };

  // PayPal identity (DEV_PLAN §2.17). The real API 302s to PayPal and the
  // callback 302s back with a one-time code; the preview skips the consent page
  // and jumps straight to the return route so the landing screen is reviewable.
  if (method === 'GET' && path === '/api/auth/paypal/start') {
    return { __redirect: `${APP}/paypal/login?handoff=${PREVIEW_HANDOFF}` };
  }
  if (method === 'GET' && path === '/api/auth/paypal/callback') {
    return { __redirect: `${APP}/paypal/login?handoff=${PREVIEW_HANDOFF}` };
  }
  if (method === 'POST' && path === '/api/auth/paypal/handoff') {
    if (body?.code !== PREVIEW_HANDOFF) {
      return { __status: 400, code: 'invalid_handoff', message: 'That sign-in link expired.' };
    }
    return { token: 'demo-paypal-token', userId: 'u1', displayName: 'Ada Lovelace' };
  }

  if (method === 'GET' && path === '/api/me/shares') {
    const mine = [...shares.values()].filter((share) => share.memberId === 'm1');
    return {
      shares: mine,
      outstandingMinor: mine
        .filter((share) => !['paid', 'settled'].includes(share.status))
        .reduce((sum, share) => sum + share.amountMinor, 0),
      currency: 'THB',
    };
  }
  if (method === 'GET' && path === '/api/me/points') return { balance: points };
  if (method === 'GET' && path === '/api/me/activity') return { events: activity };

  // Notification settings (DEV_PLAN §2.13). The screen reads the channel list
  // and the handset token state, so both must answer here too.
  if (method === 'GET' && path === '/api/me/notifications') return notificationSettings();
  if (method === 'PATCH' && path === '/api/me/notifications') {
    if (!['in_app', 'push', 'email', 'whatsapp'].includes(body?.channel)) {
      return {
        __status: 400,
        code: 'invalid_channel',
        message: 'channel must be one of in_app, push, email, whatsapp',
      };
    }
    if (typeof body?.enabled !== 'boolean') {
      return { __status: 400, code: 'invalid_enabled', message: 'enabled must be a boolean' };
    }
    notificationPreferences.set(body.channel, body.enabled);
    return notificationSettings();
  }
  if (method === 'POST' && path === '/api/me/push-token') {
    pushRegistered = true;
    return { registered: true };
  }
  if (method === 'DELETE' && path === '/api/me/push-token') {
    pushRegistered = false;
    return { registered: false };
  }

  const groupMatch = path.match(/^\/api\/groups\/([^/]+)$/);
  if (method === 'GET' && groupMatch) return detailFor(groupMatch[1]) ?? detailFor('g1');

  const timelineMatch = path.match(/^\/api\/groups\/([^/]+)\/timeline$/);
  if (method === 'GET' && timelineMatch) {
    return { events: timelineMatch[1] === 'g1' ? timeline : [] };
  }

  const boardMatch = path.match(/^\/api\/groups\/([^/]+)\/leaderboard$/);
  if (method === 'GET' && boardMatch) {
    return { rows: boardMatch[1] === 'g1' ? leaderboard : [] };
  }

  if (method === 'POST' && path === '/api/groups') {
    const id = `g${groups.size + 1}`;
    const member = {
      id: `m-${id}`,
      groupId: id,
      userId: 'u1',
      displayName: 'Ada',
      role: 'owner',
      status: 'active',
    };
    const group = {
      id,
      name: body?.name ?? 'New group',
      defaultCurrency: body?.currency ?? 'THB',
      ownerId: member.id,
      inviteToken: `INV${id.toUpperCase()}`,
      createdAt: iso(0),
    };
    groups.set(id, { group, members: [member], agreement: null });
    return { group, member };
  }

  if (method === 'POST' && path === '/api/groups/join') {
    const entry = groups.get('g1');
    return { group: entry.group, member: entry.members[0] };
  }

  if (method === 'POST' && path === '/api/agreements') {
    const entry = groups.get(body?.groupId ?? 'g1') ?? groups.get('g1');
    entry.agreement = {
      ...entry.agreement,
      id: entry.agreement?.id ?? 'a1',
      groupId: entry.group.id,
      currency: body?.currency ?? entry.group.defaultCurrency,
      estimatedTotalMinor: body?.estimatedTotalMinor ?? 0,
      deadline: body?.deadline ?? null,
      status: 'pending',
      acceptedCount: 1,
      memberCount: entry.members.length,
    };
    return { agreement: entry.agreement };
  }

  const acceptMatch = path.match(/^\/api\/agreements\/([^/]+)\/accept$/);
  if (method === 'POST' && acceptMatch) {
    const entry = [...groups.values()].find((value) => value.agreement?.id === acceptMatch[1]);
    if (entry?.agreement) {
      entry.agreement.status = 'accepted';
      entry.agreement.acceptedCount = entry.members.length;
      pushEvent('Ada', 'agreement.accepted', 'accepted the estimate');
    }
    return { agreement: entry?.agreement ?? null };
  }

  if (method === 'POST' && path === '/api/bills') {
    billSeq += 1;
    const bill = {
      id: `b${billSeq}`,
      groupId: groups.get('g1')?.group.id ?? 'g1',
      agreementId: body?.agreementId ?? 'a1',
      merchant: null,
      currency: body?.currency ?? 'THB',
      subtotalMinor: 0,
      taxMinor: 0,
      serviceChargeMinor: 0,
      tipMinor: 0,
      discountMinor: 0,
      totalMinor: 0,
      status: 'UPLOADED',
      items: [],
      framesExtracted: 0,
      warnings: [],
      createdAt: iso(0),
    };
    bills.set(bill.id, bill);
    return { bill };
  }

  const billMatch = path.match(/^\/api\/bills\/([^/]+)$/);
  if (method === 'GET' && billMatch) {
    const bill = bills.get(billMatch[1]);
    if (!bill) return null;
    return { bill, allocations: allocationsFor(bill.id), shares: sharesFor(bill.id) };
  }

  const mediaMatch = path.match(/^\/api\/bills\/([^/]+)\/media$/);
  if (method === 'POST' && mediaMatch) {
    mediaSeq += 1;
    const bill = bills.get(mediaMatch[1]);
    if (bill) bill.mediaId = `md${mediaSeq}`;
    return { mediaId: `md${mediaSeq}`, status: 'uploaded' };
  }

  const parseMatch = path.match(/^\/api\/bills\/([^/]+)\/parse$/);
  if (method === 'POST' && parseMatch) {
    const bill = bills.get(parseMatch[1]);
    if (!bill) return null;
    bill.status = 'PARSING';
    setTimeout(() => {
      const items = makeItems();
      const subtotal = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
      const tax = Math.round(subtotal * 0.07);
      bill.items = items;
      bill.merchant = 'Somtam Der';
      bill.subtotalMinor = subtotal;
      bill.taxMinor = tax;
      bill.serviceChargeMinor = Math.round(subtotal * 0.1);
      bill.totalMinor = subtotal + tax + bill.serviceChargeMinor;
      bill.framesExtracted = 1;
      bill.warnings = ['Line 5 was low confidence — check the beer count.'];
      bill.status = 'ALLOCATED';
      allocateBill(bill);
      pushEvent('Globie', 'bill.parsed', `read ${items.length} lines from ${bill.merchant}`, bill.totalMinor);
    }, 2500);
    return { status: 'PARSING' };
  }

  const splitMatch = path.match(/^\/api\/bills\/([^/]+)\/allocations$/);
  if (method === 'PATCH' && splitMatch) {
    const bill = bills.get(splitMatch[1]);
    if (!bill) return null;
    for (const allocation of allocationsFor(bill.id)) allocations.delete(allocation.id);
    const byItem = new Map();
    for (const entry of body?.allocations ?? []) {
      const list = byItem.get(entry.billItemId) ?? [];
      list.push(entry);
      byItem.set(entry.billItemId, list);
    }
    for (const [itemId, entries] of byItem) {
      const item = bill.items.find((candidate) => candidate.id === itemId);
      if (!item) continue;
      const lineId = `${bill.id}-${item.id}`;
      for (const entry of entries) {
        addAllocation(lineId, item, entry.memberId, Math.round(item.lineTotalMinor / entries.length));
      }
    }
    const rows = allocationsFor(bill.id);
    if (!['FINALIZED', 'COLLECTING', 'SETTLED'].includes(bill.status)) bill.status = 'ALLOCATED';
    pushEvent('Ada', 'allocation.set', 'updated the split');
    return { allocations: rows };
  }

  const confirmMatch = path.match(/^\/api\/allocations\/([^/]+)\/confirm$/);
  if (method === 'POST' && confirmMatch) {
    const allocation = allocations.get(confirmMatch[1]);
    if (!allocation) return null;
    allocation.status = 'confirmed';
    const billId = allocation.billItemId.split('-')[0];
    const bill = bills.get(billId);
    if (bill && !['FINALIZED', 'COLLECTING', 'SETTLED'].includes(bill.status)) {
      const remaining = allocationsFor(bill.id).some((row) => row.status === 'proposed');
      if (!remaining) bill.status = 'CONFIRMED';
    }
    return { allocation };
  }

  const finalizeMatch = path.match(/^\/api\/bills\/([^/]+)\/finalize$/);
  if (method === 'POST' && finalizeMatch) {
    const bill = bills.get(finalizeMatch[1]);
    if (!bill) return null;
    bill.status = 'FINALIZED';
    for (const share of sharesFor(bill.id)) shares.delete(share.id);
    const totals = new Map();
    for (const allocation of allocationsFor(bill.id)) {
      const current = totals.get(allocation.memberId) ?? { amount: 0, name: allocation.memberName };
      current.amount += allocation.amountMinor;
      totals.set(allocation.memberId, current);
    }
    const created = [];
    for (const [memberId, total] of totals) {
      created.push(
        addShare({
          billId: bill.id,
          groupId: bill.groupId,
          groupName: groups.get(bill.groupId)?.group.name ?? 'Group',
          memberId,
          memberName: total.name,
          amountMinor: total.amount,
          currency: bill.currency,
          status: 'proposed',
          dueAt: iso(-3 * 864e5),
          paidAt: null,
        })
      );
    }
    pushEvent('Ada', 'bill.finalized', `locked the ${bill.merchant ?? 'bill'} bill`, bill.totalMinor);
    return { bill, shares: created };
  }

  const requestMatch = path.match(/^\/api\/bills\/([^/]+)\/request-payments$/);
  if (method === 'POST' && requestMatch) {
    const bill = bills.get(requestMatch[1]);
    if (!bill) return null;
    const requests = sharesFor(bill.id)
      .filter((share) => !['paid', 'settled'].includes(share.status))
      .map((share) => {
        share.status = 'requested';
        share.approveUrl = `${APP}/paypal/return?share=${share.id}`;
        return { shareId: share.id, approveUrl: share.approveUrl };
      });
    bill.status = 'COLLECTING';
    pushEvent('Ada', 'share.requested', 'sent PayPal requests to everyone who owes');
    return { requests };
  }

  const captureMatch = path.match(/^\/api\/shares\/([^/]+)\/capture$/);
  if (method === 'POST' && captureMatch) {
    const share = shares.get(captureMatch[1]);
    if (!share) return null;
    if (['paid', 'settled'].includes(share.status)) {
      return {
        shareId: share.id,
        status: share.status,
        alreadyPaid: true,
        captureId: share.captureId ?? null,
        pointsAwarded: 0,
        rank: null,
        billSettled: bills.get(share.billId)?.status === 'SETTLED',
      };
    }
    const bill = bills.get(share.billId);
    const paidCount = [...shares.values()].filter(
      (candidate) => candidate.billId === share.billId && ['paid', 'settled'].includes(candidate.status)
    ).length;
    share.status = 'paid';
    share.paidAt = iso(0);
    share.captureId = `CAP-${share.id.toUpperCase()}`;
    points += 25;
    const settled = sharesFor(share.billId).every((candidate) =>
      ['paid', 'settled'].includes(candidate.status)
    );
    if (bill && settled) bill.status = 'SETTLED';
    else if (bill) bill.status = 'COLLECTING';
    pushEvent(share.memberName, 'payment.settled', `paid ${share.amountMinor / 100} for the bill`, share.amountMinor);
    return {
      shareId: share.id,
      status: share.status,
      alreadyPaid: false,
      captureId: share.captureId,
      pointsAwarded: 25,
      rank: paidCount + 1,
      billSettled: settled,
    };
  }

  if (method === 'POST' && path === '/api/agent/message') {
    return agentReply(body?.tool ?? 'get_bill_status', body?.confirmToken ?? null);
  }

  return null;
}

async function serveStatic(pathname, res) {
  const rel = pathname.slice(PREFIX.length) || '/';
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  let file = join(ROOT, safe);
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(ROOT, 'index.html');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (!path.startsWith(PREFIX)) {
    res.writeHead(404).end('outside prefix');
    return;
  }

  if (path.startsWith(`${PREFIX}/api/`)) {
    const apiPath = path.slice(PREFIX.length).replace(/\/+$/, '') || '/api';
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
    }
    const result = route(req.method, apiPath, body);

    // `__redirect` / `__status` let a fixture answer like the Fastify routes do
    // (302 to PayPal, 4xx for an expired code) instead of always replying 200.
    if (result?.__redirect) {
      res.writeHead(302, { Location: result.__redirect });
      res.end();
      return;
    }

    const status = result ? (result.__status ?? 200) : 404;
    const payload = result ? { ...result } : null;
    if (payload) delete payload.__status;
    if (!result) console.warn(`[404] ${req.method} ${apiPath}`);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify(
        payload ?? { code: 'not_found', message: `No fixture for ${req.method} ${apiPath}` }
      )
    );
    return;
  }

  await serveStatic(path, res);
}).listen(PORT, () => console.log(`preview on ${APP}/`));
