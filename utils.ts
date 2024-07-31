import { CacheEntry } from './types';

export class CacheManager {
  private cache: Map<string, CacheEntry>;
  private cacheTimeout: number;

  constructor(cacheTimeout: number) {
    this.cache = new Map();
    this.cacheTimeout = cacheTimeout;
  }

  get(key: string): any {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp < this.cacheTimeout) {
      return entry.data;
    }
    this.cache.delete(key);
    return null;
  }

  set(key: string, data: any): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

export class BatchManager {
  private batchInterval: number;
  private queue: { [key: string]: (() => Promise<any>)[] };
  private timer: number | null;

  constructor(batchInterval: number) {
    this.batchInterval = batchInterval;
    this.queue = {};
    this.timer = null;
  }

  add<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (!this.queue[key]) {
      this.queue[key] = [];
    }

    return new Promise((resolve, reject) => {
      this.queue[key].push(async () => {
        try {
          const result = await operation();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      if (!this.timer) {
        this.timer = window.setTimeout(() => this.executeBatch(), this.batchInterval);
      }
    });
  }

  private async executeBatch(): Promise<void> {
    const batchedOperations = this.queue;
    this.queue = {};
    this.timer = null;

    for (const key in batchedOperations) {
      const operations = batchedOperations[key];
      await Promise.all(operations.map(op => op()));
    }
  }
}
