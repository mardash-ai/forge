import { describe, it, expect, afterEach } from 'vitest';
import { setCalDavClient, resetCalDavClient, type CalDavProbe } from '../src/caldav';
import { caldavCredentialVerifier } from '../src/connectors/caldav-verifier';
import { providerDescriptor, type BasicProviderDescriptor } from '../src/connectors/providers';

const apple = providerDescriptor('apple') as BasicProviderDescriptor;

const withProbe = (probe: CalDavProbe, spy?: (c: unknown) => void) =>
  setCalDavClient({
    probe: async (c) => {
      spy?.(c);
      return probe;
    },
    // The verifier never writes; a stub that throws proves it (a verifier that quietly wrote would
    // fail loudly here rather than mutating a real calendar during a credential check).
    writeEvent: async () => {
      throw new Error('the credential verifier must not write');
    },
  });

const ok = (calendars: number): CalDavProbe => ({
  ok: true,
  principal: {
    principalUrl: 'https://p42-caldav.icloud.com/1234/principal/',
    calendarHomeUrl: 'https://p42-caldav.icloud.com/1234/calendars/',
  },
  calendars: Array.from({ length: calendars }, (_, i) => ({
    url: `https://p42-caldav.icloud.com/1234/calendars/c${i}/`,
    displayName: `Calendar ${i}`,
    readOnly: false,
  })),
});

afterEach(() => resetCalDavClient());

describe('CalDAV credential verifier', () => {
  it('probes the DISCOVERY root from the descriptor — never a hardcoded or partition host', async () => {
    let seen: { serverUrl?: string; username?: string; password?: string } = {};
    withProbe(ok(1), (c) => (seen = c as typeof seen));
    await caldavCredentialVerifier.verify({ descriptor: apple, username: 'u@i.com', password: 'p' });
    // The partition host (pNN-) differs per account and is discovered, never configured.
    expect(seen.serverUrl).toBe('https://caldav.icloud.com');
    expect(seen.serverUrl).not.toContain('p42-');
    expect(seen.username).toBe('u@i.com');
    expect(seen.password).toBe('p');
  });

  it('accepts an account that authenticates AND exposes at least one calendar', async () => {
    withProbe(ok(2));
    const out = await caldavCredentialVerifier.verify({
      descriptor: apple,
      username: 'dorinda-test@mardash.ai',
      password: 'app-specific',
    });
    expect(out).toEqual({ ok: true, account_label: 'dorinda-test@mardash.ai' });
  });

  // ⛔ THE WEB-ONLY-ACCOUNT GUARD. A browser-created Apple Account authenticates perfectly and has NO
  // calendar service until it is signed in on a real Apple device once (verified the hard way on
  // 2026-08-24). Treating "the password works" as "this will sync" produces a card reading Connected
  // above a permanently empty calendar, with the real cause — an undocumented provisioning step —
  // invisible to the user and to us.
  it('REFUSES an authenticated account that exposes no calendars, and says why', async () => {
    withProbe(ok(0));
    const out = await caldavCredentialVerifier.verify({
      descriptor: apple,
      username: 'web-only@mardash.ai',
      password: 'app-specific',
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.detail).toContain('signed in on an Apple device');
  });

  it('passes a 401 through as invalid_credentials', async () => {
    withProbe({ ok: false, reason: 'invalid_credentials', detail: 'HTTP 401' });
    const out = await caldavCredentialVerifier.verify({ descriptor: apple, username: 'u', password: 'p' });
    expect(out).toMatchObject({ ok: false, reason: 'invalid_credentials' });
  });

  // A transport failure must never be reported as a bad password: on Apple that sends the user to reset
  // a primary password, which silently revokes every app-specific password they hold.
  it('passes a transport failure through as unreachable, never as a rejection', async () => {
    withProbe({ ok: false, reason: 'unreachable', detail: 'ETIMEDOUT' });
    const out = await caldavCredentialVerifier.verify({ descriptor: apple, username: 'u', password: 'p' });
    expect(out).toMatchObject({ ok: false, reason: 'unreachable' });
  });
});
