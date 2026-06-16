import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private _available = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    this.client = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      retryStrategy: (times) => {
        if (times > 3) {
          this.logger.warn('Redis unavailable after 3 retries — token cache disabled.');
          return null; // stop retrying
        }
        return Math.min(times * 200, 1000);
      },
    });

    this.client.on('connect', () => {
      this._available = true;
      this.logger.log('Redis connected — token cache enabled.');
    });

    this.client.on('error', () => {
      this._available = false;
    });

    // Attempt connection (non-blocking)
    this.client.connect().catch(() => {
      this._available = false;
    });
  }

  async onModuleDestroy() {
    await this.client?.quit().catch(() => null);
  }

  get available(): boolean {
    return this._available;
  }

  async get(key: string): Promise<string | null> {
    if (!this._available) return null;
    try {
      return await this.client!.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!this._available || ttlSeconds <= 0) return;
    try {
      await this.client!.set(key, value, 'EX', ttlSeconds);
    } catch {
      // non-fatal — just skip caching
    }
  }

  async del(key: string): Promise<void> {
    if (!this._available) return;
    try {
      await this.client!.del(key);
    } catch {
      // non-fatal
    }
  }
}
