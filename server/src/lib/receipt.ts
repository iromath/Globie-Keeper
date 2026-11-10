/**
 * Receipt extraction: sample frames from a photo or video, ask a vision model
 * for the JSON schema in DEV_PLAN §2.7, then reconcile the frames into one
 * draft. Every amount is integer minor units.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

export type ReceiptItem = {
  name: string;
  qty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  confidence: number;
};

export type ReceiptDraft = {
  merchant: string | null;
  currency: string;
  items: ReceiptItem[];
  subtotalMinor: number;
  taxMinor: number;
  serviceChargeMinor: number;
  tipMinor: number;
  discountMinor: number;
  totalMinor: number;
  warnings: string[];
};

export type MediaInput = {
  kind: 'photo' | 'video';
  path: string;
  mimeType: string | null;
};

export type ExtractionResult = {
  draft: ReceiptDraft | null;
  framesExtracted: number;
  warnings: string[];
};

const CURRENCY = /^[A-Z]{3}$/;

/**
 * A Thai receipt prints "฿" or "บาท" far more often than "THB", and a model
 * handed an unlabelled receipt answers USD out of habit. Name the code, the
 * English name and the narrow symbol so the prompt itself carries the currency.
 */
function currencyHint(currency: string): string {
  const code = currency.trim().toUpperCase();
  try {
    const symbol = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    })
      .formatToParts(0)
      .find((part) => part.type === 'currency')?.value;
    const name = new Intl.DisplayNames(['en'], { type: 'currency' }).of(code);
    return [code, name, symbol].filter(Boolean).join(', ');
  } catch {
    return code;
  }
}

const SYSTEM_PROMPT = `You read bills — receipts, invoices, order confirmations, tickets, utility statements — and return JSON only.
Schema:
{
  "merchant": string|null,
  "currency": "ISO-4217",
  "currency_evidence": string|null,
  "items": [{"name": string, "qty": number, "unit_price_minor": integer, "line_total_minor": integer, "confidence": 0..1}],
  "subtotal_minor": integer,
  "tax_minor": integer,
  "service_charge_minor": integer,
  "tip_minor": integer,
  "discount_minor": integer,
  "total_minor": integer,
  "warnings": [string]
}
Rules:
- All money is an integer in the currency's minor unit (satang, cents). Never decimals.
- currency is the code of the currency actually printed on the document. When the document prints no currency code, symbol or word at all, use the currency named in the request.
- currency_evidence is the exact text the document prints to name its currency — a code such as "THB", a symbol such as "฿", or a word such as "บาท". Use null when nothing is printed. Never copy the requested currency into this field.
- Never assume USD, never convert an amount from one currency to another, and never guess a currency the document does not show.
- qty is a positive number; if unreadable use 1.
- confidence is your certainty for that line, 0 to 1.
- List every printed line item. Skip headings and payment lines.
- If a value is missing use 0. Do not invent items.
- No commentary outside the JSON.`;

function run(binary: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function asInt(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.round(parsed);
}

function asNumber(value: unknown, fallback = 1): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeDraft(raw: unknown, fallbackCurrency: string): ReceiptDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;

  const rawCurrency =
    typeof source.currency === 'string' ? source.currency.trim().toUpperCase() : '';
  // A model that answers "USD" out of habit would relabel every amount of a
  // bill printed in ฿, so a different code is only trusted when the model also
  // quotes the printed text that names it.
  const evidence =
    typeof source.currency_evidence === 'string' ? source.currency_evidence.trim() : '';
  const currency =
    CURRENCY.test(rawCurrency) && (rawCurrency === fallbackCurrency || evidence.length > 0)
      ? rawCurrency
      : fallbackCurrency;

  const warnings: string[] = Array.isArray(source.warnings)
    ? source.warnings.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const items: ReceiptItem[] = [];
  if (Array.isArray(source.items)) {
    for (const entry of source.items) {
      if (!entry || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) continue;

      const qty = asNumber(item.qty, 1);
      const unitPriceMinor = asInt(item.unit_price_minor);
      const lineTotalMinor = asInt(item.line_total_minor, Math.round(unitPriceMinor * qty));
      const confidence =
        typeof item.confidence === 'number' && item.confidence >= 0 && item.confidence <= 1
          ? item.confidence
          : 0.7;

      items.push({ name, qty, unitPriceMinor, lineTotalMinor, confidence });
    }
  }

  if (items.length === 0) return null;

  const itemSubtotal = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
  const subtotalMinor = asInt(source.subtotal_minor, itemSubtotal);
  if (subtotalMinor !== itemSubtotal) {
    warnings.push('Line items do not add up to the printed subtotal — check the amounts.');
  }

  const taxMinor = asInt(source.tax_minor);
  const serviceChargeMinor = asInt(source.service_charge_minor);
  const tipMinor = asInt(source.tip_minor);
  const discountMinor = asInt(source.discount_minor);

  // Itemised lines are the source of truth: they are what members allocate.
  const expectedTotal =
    itemSubtotal + taxMinor + serviceChargeMinor + tipMinor - discountMinor;
  const reportedTotal = asInt(source.total_minor, expectedTotal);
  if (reportedTotal !== expectedTotal) {
    warnings.push('Printed total differs from the itemised lines — verify before finalizing.');
  }

  const merchant =
    typeof source.merchant === 'string' && source.merchant.trim()
      ? source.merchant.trim().slice(0, 120)
      : null;

  return {
    merchant,
    currency,
    items,
    subtotalMinor: itemSubtotal,
    taxMinor,
    serviceChargeMinor,
    tipMinor,
    discountMinor,
    totalMinor: expectedTotal,
    warnings,
  };
}

async function probeDuration(input: string): Promise<number> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=nw=1:nk=1',
      input,
    ]);
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch {
    return 0;
  }
}

/** Render a frame to JPEG so HEIC originals work and uploads stay small. */
async function renderFrame(
  input: string,
  output: string,
  seekSeconds: number | null,
): Promise<boolean> {
  const args = ['-y', '-loglevel', 'error'];
  if (seekSeconds !== null) args.push('-ss', seekSeconds.toFixed(2));
  args.push(
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    "scale='min(1280,iw)':-2",
    '-q:v',
    '3',
    output,
  );
  try {
    await run('ffmpeg', args);
    return true;
  } catch {
    return false;
  }
}

async function sampleFrames(media: MediaInput, workDir: string): Promise<string[]> {
  await mkdir(workDir, { recursive: true });
  const frames: string[] = [];

  if (media.kind === 'photo') {
    const output = path.join(workDir, 'frame-0.jpg');
    // Without ffmpeg the original is still readable: it is already one of the
    // formats the vision model accepts.
    frames.push((await renderFrame(media.path, output, null)) ? output : media.path);
    return frames;
  }

  const duration = await probeDuration(media.path);
  const count =
    duration > 0 ? Math.max(1, Math.min(config.visionMaxFrames, Math.ceil(duration / 4))) : 1;

  for (let index = 0; index < count; index += 1) {
    const output = path.join(workDir, `frame-${index}.jpg`);
    const seek = duration > 0 ? (duration * (index + 0.5)) / count : null;
    if (await renderFrame(media.path, output, seek)) frames.push(output);
  }
  return frames;
}

type ChatResponse = {
  choices?: { message?: { content?: string | null } }[];
};

/** The vision model sniffs the container, so the data URL must name it correctly. */
function sniffImageMime(bytes: Buffer): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return null;
}

async function extractFrame(framePath: string, fallbackCurrency: string): Promise<ReceiptDraft | null> {
  const bytes = await readFile(framePath);
  const mime = sniffImageMime(bytes);
  if (!mime) throw new Error('unsupported image format — use a JPEG, PNG, WebP or GIF photo');
  const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;

  // The model's JSON output mode occasionally returns empty content; one retry
  // keeps a legible receipt from being reported as unreadable.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(config.visionApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.visionApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.visionModel,
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `Read this receipt from a group that keeps the bill in ${currencyHint(fallbackCurrency)}. ` +
                  `If the receipt prints no currency code, symbol or word, report "${fallbackCurrency}" and set currency_evidence to null. ` +
                  'Never answer USD unless the receipt prints a US-dollar sign or "USD".',
              },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(config.visionTimeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `vision request failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      );
    }

    const payload = (await response.json()) as ChatResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) continue;

    const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return normalizeDraft(JSON.parse(trimmed), fallbackCurrency);
  }

  return null;
}

function mergeDrafts(drafts: ReceiptDraft[]): ReceiptDraft {
  const base = drafts.reduce((best, draft) =>
    draft.items.length > best.items.length ? draft : best,
  );

  const byName = new Map<string, ReceiptItem>();
  for (const draft of drafts) {
    for (const item of draft.items) {
      const key = item.name.toLowerCase().replace(/\s+/g, ' ').trim();
      const existing = byName.get(key);
      if (!existing || item.confidence > existing.confidence) byName.set(key, item);
    }
  }

  const warnings = drafts.flatMap((draft) => draft.warnings);
  const totals = new Set(drafts.map((draft) => draft.totalMinor));
  if (totals.size > 1) {
    warnings.push('Video frames disagreed on the total — check the amount.');
  }

  return {
    ...base,
    items: [...byName.values()],
    warnings: [...new Set(warnings)],
  };
}

/**
 * Extract a draft from one or more media files. Without VISION_API_KEY the
 * pipeline reports that it is not configured instead of inventing items.
 */
export async function extractReceipt(
  media: MediaInput[],
  workDir: string,
  currency: string,
): Promise<ExtractionResult> {
  if (!config.visionApiKey) {
    return {
      draft: null,
      framesExtracted: 0,
      warnings: [
        'Receipt AI is not configured (VISION_API_KEY) — a human must type the items in.',
      ],
    };
  }

  const frames: string[] = [];
  for (const entry of media) {
    if (frames.length >= config.visionMaxFrames) break;
    const sampled = await sampleFrames(entry, path.join(workDir, entry.kind));
    frames.push(...sampled.slice(0, config.visionMaxFrames - frames.length));
  }

  const drafts: ReceiptDraft[] = [];
  const failures: string[] = [];
  // The model sometimes answers a perfectly legible receipt with an empty item
  // list. One extra pass over the same frames recovers those, instead of
  // parking the bill back in UPLOADED and asking the user to parse again.
  for (let pass = 0; pass < 2 && drafts.length === 0; pass += 1) {
    for (const frame of frames) {
      try {
        const draft = await extractFrame(frame, currency);
        if (draft) drafts.push(draft);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'frame extraction failed';
        if (!failures.includes(message)) failures.push(message);
      }
    }
  }

  const warnings = failures.length > 0 ? [`${failures.length} frame(s) could not be read`] : [];

  if (drafts.length === 0) {
    return {
      draft: null,
      framesExtracted: frames.length,
      warnings: [
        ...warnings,
        'No line items were legible — try a closer, sharper photo.',
      ],
    };
  }

  const draft = mergeDrafts(drafts);
  return { draft, framesExtracted: frames.length, warnings };
}

export async function cleanupWorkDir(workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
}
