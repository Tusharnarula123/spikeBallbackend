import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { createHash } from 'crypto';
import { ClerkUser } from './auth.types';
import { RedisService } from '../lib/redis.service';

const CACHE_PREFIX = 'clerk:token:';
// Accept tokens up to 60 s past their `exp` to tolerate local clock skew.
const CLOCK_SKEW_MS = 60_000;

@Injectable()
export class ClerkService {
  private readonly logger = new Logger(ClerkService.name);
  private readonly clerkClient;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.clerkClient = createClerkClient({
      secretKey: this.config.getOrThrow<string>('CLERK_SECRET_KEY'),
    });
  }

  async verifyRequestToken(token: string | undefined): Promise<ClerkUser | null> {
    if (!token) return null;

    // ── 1. Cache hit ────────────────────────────────────────────────────────
    const cacheKey = CACHE_PREFIX + createHash('sha256').update(token).digest('hex');
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as ClerkUser;
      } catch {
        // corrupt entry — fall through to re-verify
      }
    }

    // ── 2. Verify JWT locally (no network) ──────────────────────────────────
    const secretKey  = this.config.getOrThrow<string>('CLERK_SECRET_KEY');
    const jwtKey     = this.config.get<string>('CLERK_JWT_PUBLIC_KEY');
    const frontendUrl = this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';

    let payload: Awaited<ReturnType<typeof verifyToken>>;
    try {
      payload = await verifyToken(token, {
        secretKey,
        ...(jwtKey ? { jwtKey } : {}),
        clockSkewInMs: CLOCK_SKEW_MS,
        authorizedParties: [
          frontendUrl,
          'http://localhost:3000',
          'http://127.0.0.1:3000',
        ],
      });
    } catch (err: unknown) {
      const e = err as { reason?: string; message?: string };
      if (e?.reason === 'jwk-kid-mismatch') {
        this.logger.error(
          'CLERK_SECRET_KEY does not match the Clerk app your frontend uses. ' +
          'Copy the Secret key from the SAME Clerk application as NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ' +
          'into backend/.env, then restart the server.',
        );
      } else {
        this.logger.warn('Token verification failed:', err);
      }
      return null;
    }

    const userId = payload.sub;
    if (!userId) return null;

    // ── 3. Resolve role ──────────────────────────────────────────────────────
    // Prefer role embedded in JWT claims (set via Clerk JWT template).
    const p = payload as Record<string, unknown>;
    const claimRole =
      (p['role'] as string | undefined) ??
      ((p['publicMetadata'] as Record<string, unknown> | undefined)?.['role'] as string | undefined);

    let role = claimRole ?? 'player';

    if (!claimRole) {
      // Fallback: fetch from Clerk API (requires network)
      try {
        const user = await this.clerkClient.users.getUser(userId);
        role = (user.publicMetadata?.role as string) ?? 'player';
      } catch {
        this.logger.warn('Could not reach Clerk API to fetch user role; defaulting to "player".');
      }
    }

    const clerkUser: ClerkUser = { userId, role };

    // ── 4. Cache until token expires ─────────────────────────────────────────
    const exp = payload.exp; // Unix seconds
    if (exp) {
      const ttl = Math.floor(exp - Date.now() / 1000);
      await this.redis.set(cacheKey, JSON.stringify(clerkUser), ttl);
    }

    return clerkUser;
  }

  /**
   * Evict a token from the cache (call on logout / session revocation).
   */
  async invalidateToken(token: string): Promise<void> {
    const cacheKey = CACHE_PREFIX + createHash('sha256').update(token).digest('hex');
    await this.redis.del(cacheKey);
  }

  getClient() {
    return this.clerkClient;
  }
}
