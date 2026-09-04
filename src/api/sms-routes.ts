import type { FastifyInstance } from 'fastify';
import { getBackends } from '../storage/backends';
import {
  newTwofaCode,
  hashToken,
  twofaCodeTtlSeconds,
  twofaMaxAttempts,
} from '../plugins/auth-identity/index';
import { sendSms, twiml, twimlEmpty, HELP_REPLY, verifyTwilioSignature } from '../plugins/twilio-sms/index';
import { readSecrets } from '../plugins/secrets-local/index';
import { nowIso } from '../shared/time';
import type { SmsConfig } from '../plugins/twilio-sms/index';

// C21 SMS channel routes.
//
// Phone verification (POST /auth/phone/send-code, POST /auth/phone/verify-code):
//   Reuses the email-2FA OTP hashing + attempt-cap machinery (putTwofaCode / redeemTwofaCode).
//   Purpose: 'phone_verify'. Code key: 'phone_verify:<userId>'.
//   On confirmation: stamps phone_verified_at + sms_consent_at (opt-in consent timestamp).
//
// Inbound Twilio webhook (POST /hooks/sms/twilio):
//   Handles STOP/START/YES/UNSTOP/HELP keywords per TCPA/CTIA carrier requirements.
//   Replies with registered TwiML copy. NEVER creates an opt-in from an inbound keyword alone —
//   a number must have a prior sms_consent_at (obtained via the verification flow above).

// Resolve Twilio config for an app — C5 vault with env fallback (mirrors delivery.ts).
async function resolveSmsConfig(appId: string): Promise<SmsConfig | null> {
  try {
    const secrets = await readSecrets(appId);
    const accountSid = secrets.TWILIO_ACCOUNT_SID?.trim() || process.env.TWILIO_ACCOUNT_SID?.trim() || '';
    const authToken = secrets.TWILIO_AUTH_TOKEN?.trim() || process.env.TWILIO_AUTH_TOKEN?.trim() || '';
    const fromNumber = secrets.TWILIO_FROM_NUMBER?.trim() || process.env.TWILIO_FROM_NUMBER?.trim() || '';
    if (!accountSid || !authToken || !fromNumber) return null;
    return { accountSid, authToken, fromNumber };
  } catch {
    return null;
  }
}

// A basic E.164 phone validator: +<digits>, 8–15 total digits (ITU-T E.164 range).
function isE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

// --- STOP/START/HELP keyword sets (case-insensitive, trimmed) ---------------------------------
// CTIA carriers require opt-out on STOP, opt-back-in on START/YES/UNSTOP, and a fixed HELP reply.
const STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const START_KEYWORDS = new Set(['start', 'yes', 'unstop']);
const HELP_KEYWORDS = new Set(['help', 'info']);

function classifyKeyword(body: string): 'stop' | 'start' | 'help' | 'other' {
  const kw = body.trim().toLowerCase();
  if (STOP_KEYWORDS.has(kw)) return 'stop';
  if (START_KEYWORDS.has(kw)) return 'start';
  if (HELP_KEYWORDS.has(kw)) return 'help';
  return 'other';
}

export function registerSmsRoutes(fastify: FastifyInstance, opts: { defaultApp: () => string }): void {
  // POST /auth/phone/send-code
  // Body: { userId: string; phone: string; appId?: string }
  // Stores the phone on the user record, mints a 6-digit OTP, sends it by SMS.
  // The caller must be authenticated (session) before calling this; the route trusts `userId`.
  fastify.post('/auth/phone/send-code', async (req, reply) => {
    const {
      userId,
      phone,
      appId: bodyAppId,
    } = req.body as {
      userId?: string;
      phone?: string;
      appId?: string;
    };
    const appId = bodyAppId || opts.defaultApp();

    if (!userId || typeof userId !== 'string') {
      return reply.status(422).send({ error: { code: 'validation_error', message: 'userId required' } });
    }
    if (!phone || typeof phone !== 'string' || !isE164(phone)) {
      return reply.status(422).send({
        error: {
          code: 'validation_error',
          message: 'phone must be a valid E.164 number (e.g. +15551234567)',
        },
      });
    }

    const { identity } = await getBackends();
    const user = await identity.getUser(appId, userId);
    if (!user) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'user not found' } });
    }

    // Store the phone (unverified) so the webhook can look it up during the confirmation window.
    await identity.updateUser(appId, userId, { phone });

    // Resolve SMS config — if not configured, surface a clean error (not a 500).
    const cfg = await resolveSmsConfig(appId);
    if (!cfg) {
      return reply.status(503).send({
        error: { code: 'sms_not_configured', message: 'SMS is not configured for this app' },
      });
    }

    // Mint the OTP (same machinery as email 2FA).
    const { code, hash } = newTwofaCode();
    const ttl = twofaCodeTtlSeconds();
    const codeId = `phone_verify:${userId}`;
    await identity.putTwofaCode(appId, {
      id: codeId,
      userId,
      purpose: 'phone_verify',
      codeHash: hash,
      ttlSeconds: ttl,
    });

    // Send the SMS — best-effort: if delivery fails we still return a 200 so the caller retries.
    const smsBody = `Your Dorinda verification code is ${code}`;
    const result = await sendSms(phone, smsBody, cfg);

    if (!result.ok) {
      // Log but don't expose Twilio error detail to the client.
      return reply.status(502).send({
        error: { code: 'sms_delivery_failed', message: 'SMS could not be delivered. Please try again.' },
      });
    }

    return reply.status(200).send({
      sent: true,
      // 'inert' when SMS_DELIVERY_ENABLED is off — useful for dev/test awareness.
      ...(result.status === 'inert' ? { inert: true } : {}),
    });
  });

  // POST /auth/phone/verify-code
  // Body: { userId: string; code: string; appId?: string }
  // Redeems the OTP, stamps phone_verified_at + sms_consent_at on success.
  fastify.post('/auth/phone/verify-code', async (req, reply) => {
    const {
      userId,
      code,
      appId: bodyAppId,
    } = req.body as {
      userId?: string;
      code?: string;
      appId?: string;
    };
    const appId = bodyAppId || opts.defaultApp();

    if (!userId || typeof userId !== 'string') {
      return reply.status(422).send({ error: { code: 'validation_error', message: 'userId required' } });
    }
    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return reply
        .status(422)
        .send({ error: { code: 'validation_error', message: 'code must be a 6-digit string' } });
    }

    const { identity } = await getBackends();
    const codeId = `phone_verify:${userId}`;
    const redeem = await identity.redeemTwofaCode(appId, codeId, hashToken(code), {
      maxAttempts: twofaMaxAttempts(),
    });

    if (redeem.outcome === 'invalid') {
      return reply
        .status(400)
        .send({ error: { code: 'code_invalid', message: 'Code not found or expired. Request a new code.' } });
    }
    if (redeem.outcome === 'exhausted') {
      return reply
        .status(400)
        .send({ error: { code: 'code_exhausted', message: 'Too many attempts. Request a new code.' } });
    }
    if (redeem.outcome === 'mismatch') {
      return reply.status(400).send({
        error: {
          code: 'code_mismatch',
          message: `Incorrect code. ${redeem.attemptsRemaining} attempt${redeem.attemptsRemaining === 1 ? '' : 's'} remaining.`,
        },
      });
    }

    // Stamp verification + consent (single atomic update).
    const now = nowIso();
    await identity.updateUser(appId, userId, {
      phone_verified_at: now,
      sms_consent_at: now,
      sms_opt_out: false,
    });

    return reply.status(200).send({ verified: true, phone_verified_at: now, sms_consent_at: now });
  });

  // POST /hooks/sms/twilio
  // Inbound Twilio webhook: receives From + Body (application/x-www-form-urlencoded).
  // Handles STOP (opt-out), START/YES/UNSTOP (re-enable, only if prior consent exists), HELP.
  // Replies with TwiML. NEVER creates an opt-in from an inbound keyword alone.
  //
  // SECURITY: Every request is verified with Twilio's HMAC-SHA1 signature scheme
  // (X-Twilio-Signature header; signed with TWILIO_AUTH_TOKEN over full URL + sorted params).
  // Missing or invalid signatures are rejected 403 before any business logic runs.
  //
  // Carrier-registered endpoint — the response copy is compliance-locked. Do not edit without
  // a corresponding carrier re-submission.
  fastify.register(async (twilio) => {
    // Parse the form body as a raw string so we can extract the exact param values
    // Twilio used when computing the HMAC-SHA1 signature.
    //
    // removeContentTypeParser first: this scope is a Fastify child that inherits a COPY of the
    // parent scope's parser map. If an ancestor scope (e.g. registerAuthRoutes) already registered
    // application/x-www-form-urlencoded as a parsed-object parser, calling addContentTypeParser
    // here throws FST_ERR_CTP_ALREADY_PRESENT. Remove it from this child's copy first so we can
    // install the raw-string variant needed for HMAC-SHA1 verification. removeContentTypeParser is
    // a no-op (returns false) when the parser is absent, so this is safe on a clean instance too.
    twilio.removeContentTypeParser('application/x-www-form-urlencoded');
    twilio.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, body),
    );
    // Fallback for misrouted or missing content-type — same guard for consistency.
    twilio.removeContentTypeParser('*');
    twilio.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

    twilio.post('/hooks/sms/twilio', async (req, reply) => {
      reply.header('Content-Type', 'text/xml; charset=utf-8');

      // Parse the form body to extract params for signature verification AND business logic.
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const params: Record<string, string> = {};
      new URLSearchParams(rawBody).forEach((v, k) => {
        params[k] = v;
      });

      // Reconstruct the URL Twilio signed: prefer X-Forwarded-* headers (set by Traefik / Cloud Run)
      // over the raw Host header so the URL matches what was configured in the Twilio console.
      const proto = String((req.headers['x-forwarded-proto'] as string | undefined) ?? 'https')
        .split(',')[0]!
        .trim();
      const host = String(
        ((req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '') as string,
      )
        .split(',')[0]!
        .trim();
      const webhookUrl = `${proto}://${host}/hooks/sms/twilio`;

      // Verify the Twilio HMAC-SHA1 signature. Reject before any business logic if invalid.
      const sigHeader = req.headers['x-twilio-signature'];
      const signature = (Array.isArray(sigHeader) ? sigHeader[0] : sigHeader) ?? '';
      const cfg = await resolveSmsConfig(opts.defaultApp());
      if (!cfg || !verifyTwilioSignature(cfg.authToken, webhookUrl, params, signature)) {
        // Empty TwiML + 403: reject Twilio-carrier-initiated; don't leak anything.
        return reply.status(403).send(twimlEmpty());
      }

      const from = (params['From'] ?? '').trim();
      const msgBody = (params['Body'] ?? '').trim();

      if (!from) {
        // Malformed — no From; return empty TwiML (don't leak info).
        return reply.status(200).send(twimlEmpty());
      }

      const keyword = classifyKeyword(msgBody);

      if (keyword === 'help') {
        return reply.status(200).send(twiml(HELP_REPLY));
      }

      // Look up the user by phone number — must exist with prior in-app consent (sms_consent_at).
      // We scan all apps for this phone; in practice the data-plane has a single app.
      const appId = opts.defaultApp();
      const { identity } = await getBackends();
      const user = await identity.findByPhone(appId, from);

      if (keyword === 'stop') {
        if (user) {
          await identity.updateUser(appId, user.id, {
            sms_opt_out: true,
            sms_opt_out_at: nowIso(),
          });
        }
        // Always acknowledge STOP (even for unknown numbers) per CTIA requirements. Empty TwiML
        // lets the carrier's automatic STOP handling reply — we don't send a duplicate message.
        return reply.status(200).send(twimlEmpty());
      }

      if (keyword === 'start') {
        // NEVER create an opt-in from an inbound keyword — only re-enable an existing opted-in user.
        // A number that never went through the phone-verification flow has no sms_consent_at, so we
        // drop the message silently (empty TwiML). The carrier handles the mandatory START reply.
        if (user && user.sms_consent_at) {
          await identity.updateUser(appId, user.id, {
            sms_opt_out: false,
            sms_opt_out_at: undefined,
          });
        }
        // Empty TwiML — carrier's built-in START reply fires automatically.
        return reply.status(200).send(twimlEmpty());
      }

      // 'other' — not a compliance keyword; no action, no reply.
      return reply.status(200).send(twimlEmpty());
    });
  });
}
