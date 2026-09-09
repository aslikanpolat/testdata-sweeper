import { describe, expect, it, vi } from 'vitest';
import { MongoCleaner } from '../src/mongo.js';
import type { MongoClientLike } from '../src/types.js';

describe('MongoCleaner', () => {
  it('uses escaped anchored regex and deleteMany', async () => {
    const deleteMany = vi.fn(async () => ({ deletedCount: 2 }));
    const countDocuments = vi.fn(async () => 2);
    const client: MongoClientLike = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      db: () => ({ collection: () => ({ countDocuments, deleteMany }) })
    };
    await new MongoCleaner(client, 'qa', true).cleanup('testdata_20260909_ab123456_', [{ name: 'records', collection: 'records', field: 'createdBy' }], false, () => undefined);
    expect(countDocuments).toHaveBeenCalledWith({ createdBy: { $regex: '^testdata_20260909_ab123456_' } });
    expect(deleteMany).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });
});
