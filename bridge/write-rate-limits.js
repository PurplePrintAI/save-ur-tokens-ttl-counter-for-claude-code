#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_OUTPUT_PATH = path.join(os.homedir(), '.claude', 'ttl-counter-rate-limits.json');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function toFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function toStringValue(value) {
  return typeof value === 'string' && value.trim()
    ? value
    : undefined;
}

function normalizeWindow(window) {
  if (!window || typeof window !== 'object') {
    return undefined;
  }

  const usedPercentage = toFiniteNumber(window.used_percentage ?? window.usedPercentage);
  const resetsAt = toStringValue(window.resets_at ?? window.resetsAt);

  if (usedPercentage === undefined && resetsAt === undefined) {
    return undefined;
  }

  const normalized = {};
  if (usedPercentage !== undefined) {
    normalized.used_percentage = usedPercentage;
  }

  if (resetsAt !== undefined) {
    normalized.resets_at = resetsAt;
  }

  return normalized;
}

function buildPayload(parsed) {
  const rateLimits = parsed?.rate_limits ?? parsed?.rateLimits;
  if (!rateLimits || typeof rateLimits !== 'object') {
    return undefined;
  }

  const fiveHour = normalizeWindow(rateLimits.five_hour ?? rateLimits.fiveHour);
  const sevenDay = normalizeWindow(rateLimits.seven_day ?? rateLimits.sevenDay);
  if (!fiveHour && !sevenDay) {
    return undefined;
  }

  const payload = {
    updated_at: Date.now(),
    session_id: toStringValue(parsed.session_id ?? parsed.sessionId),
    rate_limits: {},
  };

  if (fiveHour) {
    payload.rate_limits.five_hour = fiveHour;
  }

  if (sevenDay) {
    payload.rate_limits.seven_day = sevenDay;
  }

  return payload;
}

async function main() {
  const outputPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTPUT_PATH;
  const raw = (await readStdin()).trim();
  if (!raw) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const payload = buildPayload(parsed);
  if (!payload) {
    return;
  }

  const dir = path.dirname(outputPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `ttl-counter-rate-limits.${process.pid}.${Date.now()}.tmp`);
  const content = `${JSON.stringify(payload, null, 2)}\n`;

  await fs.promises.writeFile(tempPath, content, 'utf8');
  try {
    await fs.promises.rename(tempPath, outputPath);
  } catch {
    await fs.promises.writeFile(outputPath, content, 'utf8');
    await fs.promises.rm(tempPath, { force: true });
  }
}

main().catch(() => {
  process.exitCode = 0;
});
