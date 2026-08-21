// Plugin: twilio-sms.
//
// The SMS delivery Implementation of C21's SMS channel — a real technology boundary (the Twilio
// Messaging REST API) that a future carrier-direct or alternate-provider Implementation can replace
// WITHOUT touching the notify() fan-out contract. It owns exactly the provider-specific things
// Twilio requires and nothing else:
//   - POST to /2010-04-01/Accounts/{SID}/Messages.json with HTTP Basic auth (SID:AuthToken).
//   - Compliance: every outbound body is appended with "\nReply STOP to opt out" (TCPA/CTIA).
//   - Feature flag: SMS_DELIVERY_ENABLED env must be "true" for any send to reach Twilio. When
//     the flag is off the transport returns a synthetic { ok: true, status: 'inert' } so callers
//     can distinguish "delivery disabled" from a real failure.
//   - Swappable transport (setSmsTransport/resetSmsTransport): the test suite injects a capture
//     sink so no real HTTP is opened during tests — the same seam webpush-vapid uses.
//
// Dependency-clean by design (like webpush-vapid / email-smtp): Node's built-in `fetch` + `Buffer`
// only — no twilio SDK, so the slim data-plane image stays small and multi-arch.

export const IMPLEMENTATION = 'twilio-sms';

// The env flag that gates live delivery. Must be exactly the string "true" to fire real sends.
// Any other value (absent, "false", "1", etc.) keeps the transport inert (returns ok:true/inert).
export const SMS_DELIVERY_ENABLED_ENV = 'SMS_DELIVERY_ENABLED';

// TCPA / CTIA opt-out notice that MUST appear at the end of every outbound message template.
// The carrier registration requires this copy verbatim; never shorten or reword it.
const OPT_OUT_SUFFIX = '\nReply STOP to opt out';

// Append the opt-out suffix if it isn't already there (idempotent so callers can call it
// defensively). Internal helpers always produce it themselves; this is for external callers.
export function appendOptOut(body: string): string {
  return body.endsWith(OPT_OUT_SUFFIX) ? body : `${body}${OPT_OUT_SUFFIX}`;
}

// --- transport layer (swappable seam) -------------------------------------------------------

export interface SmsResult {
  ok: boolean;
  sid?: string;
  status?: string; // Twilio message status ("queued", "sent", …) or synthetic ("inert")
  error?: string; // error detail on !ok
}

// The minimal per-call shape passed to the transport (raw strings — no SDK types).
export type SmsTransport = (
  to: string,
  from: string,
  body: string,
  accountSid: string,
  authToken: string,
) => Promise<SmsResult>;

async function realTwilioTransport(
  to: string,
  from: string,
  body: string,
  accountSid: string,
  authToken: string,
): Promise<SmsResult> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      },
      body: params,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, error: `twilio network error: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    return { ok: false, error: `twilio ${res.status}: ${detail}` };
  }
  let json: { sid?: string; status?: string } = {};
  try {
    json = (await res.json()) as { sid?: string; status?: string };
  } catch {
    /* ignore */
  }
  return { ok: true, sid: json.sid, status: json.status };
}

let currentTransport: SmsTransport = realTwilioTransport;

export function setSmsTransport(t: SmsTransport): void {
  currentTransport = t;
}
export function resetSmsTransport(): void {
  currentTransport = realTwilioTransport;
}
export function getSmsTransport(): SmsTransport {
  return currentTransport;
}

// --- public API -------------------------------------------------------------------------------

export interface SmsConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

// Send an SMS to `to` (E.164) with `body`. Appends the opt-out suffix automatically.
// Returns { ok: true, status: 'inert' } when SMS_DELIVERY_ENABLED is not "true" — this is a
// DELIBERATE state (flag off), not a failure. Callers should surface it as 'skipped', not 'failed'.
export async function sendSms(to: string, body: string, cfg: SmsConfig): Promise<SmsResult> {
  if (process.env[SMS_DELIVERY_ENABLED_ENV] !== 'true') {
    return { ok: true, status: 'inert' };
  }
  const fullBody = appendOptOut(body);
  return currentTransport(to, cfg.fromNumber, fullBody, cfg.accountSid, cfg.authToken);
}

// --- TwiML compliance copy (carrier-registered; never drift) ---------------------------------

// Exact HELP reply string. Carrier-registered; any change requires a carrier re-submission.
// The acceptance criteria specifies the EXACT string — do not edit without updating the carrier.
export const HELP_REPLY =
  "Dorinda: You're receiving the notifications you set up at dorinda.ai. For help visit https://dorinda.ai/sms or email legal@dorinda.ai. Reply STOP to cancel at any time. Msg & data rates may apply.";

// Wrap a reply body in TwiML for Twilio's inbound webhook response.
// Twilio only reads the body; other TwiML verbs are stripped.
export function twiml(body: string): string {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

// An empty TwiML response (for STOP/START where a confirm TwiML is sent — or for no-reply).
export function twimlEmpty(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response/>`;
}
