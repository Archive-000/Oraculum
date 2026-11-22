import { UnauthorizedException } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from '../../users/entities/user.entity';
import { JwtHelper } from '../helper/jwt-helper';
import { TOTP_REPLAY_TTL_MS, VerifyTotpProvider } from './verify-totp.provider';

// The real otplib depends on an ESM-only package that Jest cannot load, so
// (like the sibling TOTP specs) it is replaced. The fake keeps the one
// behaviour that matters here: a code is valid only inside the 30 second
// step it was issued for.
jest.mock('otplib', () => ({
  verifySync: ({ token }: { token: string }) => ({
    valid: token === `code-${Math.floor(Date.now() / 30_000)}`,
  }),
}));

/**
 * #853 — a TOTP code that has already completed verification must not be
 * accepted again inside the same time window.
 *
 * Time is pinned so every code is generated and verified inside one
 * 30 second step regardless of when the suite runs.
 */
describe('VerifyTotpProvider replay protection (#853)', () => {
  const START = Date.parse('2026-11-22T10:00:00.000Z');
  const STEP_MS = 30_000;
  const SECRET = 'JBSWY3DPEHPK3PXP';

  let now: number;
  let nowSpy: jest.SpyInstance;
  let users: Record<string, Partial<User>>;
  let usersRepository: { findOne: jest.Mock };
  let jwtHelper: { verifyTempToken: jest.Mock; generateTokens: jest.Mock };
  let cache: { get: jest.Mock; set: jest.Mock };
  let store: Map<string, unknown>;
  let provider: VerifyTotpProvider;

  const codeNow = () => `code-${Math.floor(now / STEP_MS)}`;
  const wrongCode = () => 'not-a-valid-code';
  const login = (userId: string, token: string) =>
    provider.verifyTotpLogin({ tempToken: `temp-${userId}`, token } as never);

  beforeEach(() => {
    now = START;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

    users = {
      'user-1': { id: 'user-1', email: 'one@example.com', totpSecret: SECRET },
      'user-2': { id: 'user-2', email: 'two@example.com', totpSecret: SECRET },
      'no-2fa': { id: 'no-2fa', email: 'none@example.com' },
    };
    usersRepository = {
      findOne: jest.fn(async ({ where }) => users[where.id] ?? null),
    };
    jwtHelper = {
      verifyTempToken: jest.fn((temp: string) => ({
        sub: temp.replace('temp-', ''),
      })),
      generateTokens: jest.fn(() => ({ accessToken: 'a', refreshToken: 'r' })),
    };
    store = new Map();
    cache = {
      get: jest.fn(async (key: string) => store.get(key)),
      set: jest.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
    };

    provider = new VerifyTotpProvider(
      usersRepository as never,
      jwtHelper as never,
      cache as never,
    );
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('accepts a valid code the first time and issues tokens', async () => {
    const result = await login('user-1', codeNow());

    expect(result).toMatchObject({
      user: { id: 'user-1', email: 'one@example.com' },
      accessToken: 'a',
      refreshToken: 'r',
    });
    expect(jwtHelper.generateTokens).toHaveBeenCalledTimes(1);
  });

  it('rejects the same code when it is replayed in the same window', async () => {
    const code = codeNow();
    await login('user-1', code);

    await expect(login('user-1', code)).rejects.toThrow(
      new UnauthorizedException('TOTP code has already been used'),
    );
    expect(jwtHelper.generateTokens).toHaveBeenCalledTimes(1);
  });

  it('still rejects the replay a few seconds later in the same step', async () => {
    const code = codeNow();
    await login('user-1', code);

    now += 10_000;

    await expect(login('user-1', code)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('accepts the next code once the time window has moved on', async () => {
    const first = codeNow();
    await login('user-1', first);

    now += STEP_MS;
    const second = codeNow();
    expect(second).not.toBe(first);

    await expect(login('user-1', second)).resolves.toMatchObject({
      accessToken: 'a',
    });
  });

  it('does not let one member consume another member’s identical code', async () => {
    const code = codeNow();
    await login('user-1', code);

    await expect(login('user-2', code)).resolves.toMatchObject({
      user: { id: 'user-2' },
    });
  });

  it('does not remember a wrong code, so the right one still works', async () => {
    await expect(login('user-1', wrongCode())).rejects.toThrow(
      new UnauthorizedException('Invalid TOTP code'),
    );
    expect(cache.set).not.toHaveBeenCalled();

    await expect(login('user-1', codeNow())).resolves.toMatchObject({
      accessToken: 'a',
    });
  });

  it('remembers a consumed code for longer than one step without storing it in clear', async () => {
    const code = codeNow();
    await login('user-1', code);

    expect(TOTP_REPLAY_TTL_MS).toBeGreaterThan(STEP_MS);
    expect(cache.set).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = cache.set.mock.calls[0];
    expect(value).toBe(true);
    expect(ttl).toBe(TOTP_REPLAY_TTL_MS);
    expect(key).toMatch(/^auth:totp:used:[0-9a-f]{64}$/);
    expect(key).not.toContain(code);
    expect(key).not.toContain('user-1');
  });

  it('does not touch the cache for an unknown member or one without 2FA', async () => {
    await expect(login('ghost', codeNow())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(login('no-2fa', codeNow())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('rejects the replay using the real Nest cache provider', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CacheModule.register()],
      providers: [
        VerifyTotpProvider,
        { provide: getRepositoryToken(User), useValue: usersRepository },
        { provide: JwtHelper, useValue: jwtHelper },
      ],
    }).compile();
    const wired = moduleRef.get(VerifyTotpProvider);
    const code = codeNow();
    const dto = { tempToken: 'temp-user-1', token: code } as never;

    await expect(wired.verifyTotpLogin(dto)).resolves.toMatchObject({
      accessToken: 'a',
    });
    await expect(wired.verifyTotpLogin(dto)).rejects.toThrow(
      'TOTP code has already been used',
    );
  });
});
