import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { EmailDelivery } from '../../resources/types';
import { resolveApp, baseResource } from '../_shared';
import { invalidInput, dependencyUnavailable } from '../../shared/errors';
import {
  IMPLEMENTATION,
  SMTP_URL_SECRET,
  FROM_SECRET,
  TEMPLATES,
  resolveEmailConfig,
  renderTemplate,
  redactRecipient,
  sanitizeError,
  getEmailTransport,
  type OutboundEmail,
} from '../../plugins/email-smtp/index';

const inputSchema = z
  .object({
    // The Application NAME. Optional: defaults to the runtime's own app (data-plane: FORGE_APP_NAME),
    // so the running app / an internal caller usually needn't pass it, like C1/C3/C4.
    app: z.string().min(1).optional(),
    to: z.string().email().describe('Recipient email address'),
    // Provide EITHER a built-in template (+ data) OR an inline subject with html/text.
    subject: z.string().min(1).optional().describe('Subject line (required for an inline body)'),
    html: z.string().min(1).optional().describe('HTML body'),
    text: z.string().min(1).optional().describe('Plain-text body'),
    template: z.enum(TEMPLATES).optional().describe('Built-in template: verify-email | reset-password'),
    data: z.record(z.unknown()).optional().describe('Template data, e.g. { url, product?, name? }'),
  })
  .superRefine((val, ctx) => {
    const hasTemplate = Boolean(val.template);
    const hasInline = Boolean(val.subject) && Boolean(val.html || val.text);
    if (!hasTemplate && !hasInline) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either `template` (+ `data`) or `subject` with `html`/`text`.',
      });
    }
    // Both built-in templates render a link C10 generated — require it here so a missing link is a
    // clean 422 (change-input) before any send, never a delivery failure.
    if (val.template === 'verify-email' || val.template === 'reset-password') {
      const url = (val.data as Record<string, unknown> | undefined)?.url;
      if (typeof url !== 'string' || url.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['data', 'url'],
          message: `Template "${val.template}" requires data.url (the verification/reset link).`,
        });
      }
    }
  });
type Input = z.infer<typeof inputSchema>;

// SendEmail (C12) — the platform's transactional-email delivery. Composes a message (an inline
// subject+body, or one of the built-in "verify your email" / "reset your password" templates it is
// HANDED — token/link generation is the caller's job, e.g. C10 identity/auth) and DELIVERS it via a
// provider-agnostic transport whose credentials come from the C5 secret store. Persists EVERY attempted
// send (success AND failure) as a durable, inspectable EmailDelivery — recording to (REDACTED) / subject
// / status only, never the credentials or the message body/PII. Generic by construction: no auth/goal/
// app concepts; behavior lives in the email-smtp Implementation, this Capability is the stable contract.
export const sendEmail: Capability<Input, EmailDelivery> = {
  name: 'SendEmail',
  slug: 'send-email',
  description:
    'Deliver a transactional email (inline subject+body or a built-in verify/reset template) via a C5-configured provider; persist the send (EmailDelivery) with a redacted recipient — no body/creds retained.',
  inputSchema,
  resourceType: 'EmailDelivery',
  events: ['EmailSent', 'EmailFailed'],
  longRunning: false,
  requiresDocker: false,
  plane: 'data', // email is sent at runtime (the app / C10's auth flow); control plane only inspects
  async execute(input, ctx) {
    const appName = input.app ?? process.env.FORGE_APP_NAME;
    if (!appName) {
      throw invalidInput('unknown app (pass `app` or set FORGE_APP_NAME).', { field: 'app' });
    }
    const app = await resolveApp(ctx.store, appName);

    // (3) Detectable absence -> graceful degradation. When email is unconfigured (no SMTP_URL / no
    // EMAIL_FROM in the C5 vault or env), fail with a typed 503 dependency_unavailable ForgeError
    // (NOT an unhandled throw) so the consuming auth flow can detect "email not configured" and decide
    // (block a signup that needs verification, surface the state) — it never crashes. No delivery is
    // persisted: there was no send attempt.
    const cfg = await resolveEmailConfig(app.id);
    if (!cfg.ok) {
      throw dependencyUnavailable(
        `Email is not configured for app "${app.name}": missing ${cfg.missing.join(', ')}. Set them: ` +
          `forge secrets set --app ${app.name} --name ${SMTP_URL_SECRET} --value "smtp://user:pass@host:587"  and  ` +
          `--name ${FROM_SECRET} --value "Name <no-reply@your-domain>"`,
        { app: app.name, missing: cfg.missing, capability: 'SendEmail' },
      );
    }

    // (1) Compose: a built-in template (rendered from the link/data it is handed) or an inline body.
    let subject: string;
    let html: string | undefined;
    let text: string | undefined;
    if (input.template) {
      const rendered = renderTemplate(input.template, input.data ?? {});
      subject = rendered.subject;
      html = rendered.html;
      text = rendered.text;
    } else {
      subject = input.subject!;
      html = input.html;
      text = input.text;
    }

    // (4) Redact the recipient for everything that is stored/emitted — the full address is used only to
    // hand the message to the transport, never persisted.
    const toRedacted = redactRecipient(input.to);
    const outbound: OutboundEmail = { from: cfg.config.from, to: input.to, subject, html, text };

    // (1) Deliver. A transport error is REPORTED (persisted + returned as status:'failed'), never
    // silently dropped — an auth flow can trust status to decide whether verification really went out.
    try {
      const { id } = await getEmailTransport()(outbound, cfg.config);
      const delivery: EmailDelivery = {
        ...baseResource('EmailDelivery', app.id),
        type: 'EmailDelivery',
        status: 'sent',
        to: toRedacted,
        subject,
        ...(input.template ? { template: input.template } : {}),
        implementation: IMPLEMENTATION,
        message_id: id,
      };
      await ctx.store.saveResource(delivery);
      await ctx.emit({
        type: 'EmailSent',
        resource_type: 'EmailDelivery',
        resource_id: delivery.id,
        app_id: app.id,
        data: { to: toRedacted, subject, template: input.template ?? null, implementation: IMPLEMENTATION },
      });
      return delivery;
    } catch (err) {
      const delivery: EmailDelivery = {
        ...baseResource('EmailDelivery', app.id),
        type: 'EmailDelivery',
        status: 'failed',
        to: toRedacted,
        subject,
        ...(input.template ? { template: input.template } : {}),
        implementation: IMPLEMENTATION,
        error: sanitizeError(String((err as Error)?.message ?? err)),
      };
      await ctx.store.saveResource(delivery);
      await ctx.emit({
        type: 'EmailFailed',
        resource_type: 'EmailDelivery',
        resource_id: delivery.id,
        app_id: app.id,
        data: { to: toRedacted, subject, template: input.template ?? null, error: delivery.error },
      });
      return delivery;
    }
  },
};
