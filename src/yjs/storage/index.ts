import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";

import { storageKey, Y_DOC_STORAGE_PREFIX } from "./storage-key";

import type { TransactionStorage } from "./type";

export interface YTransactionStorage {
  getYDoc(): Promise<Doc>;
  exists(): Promise<boolean>;
  markExists(): Promise<void>;
  clearDocument(): Promise<void>;
  storeUpdate(update: Uint8Array): Promise<void>;
  commit(): Promise<void>;
}

type Options = {
  /**
   * @description default is 10KB
   * @default 10 * 1024 * 1
   */
  maxBytes?: number;
  /**
   * @description default is 500 snapshot
   * @default 500
   */
  maxUpdates?: number;
};

export class YTransactionStorageImpl implements YTransactionStorage {
  private readonly MAX_BYTES: number;
  private readonly MAX_UPDATES: number;

  constructor(
    private readonly storage: TransactionStorage,
    options?: Options,
  ) {
    this.MAX_BYTES = options?.maxBytes ?? 10 * 1024;
    if (this.MAX_BYTES > 128 * 1024) {
      // https://developers.cloudflare.com/durable-objects/platform/limits/
      throw new Error("maxBytes must be less than 128KB");
    }

    this.MAX_UPDATES = options?.maxUpdates ?? 500;
  }

  async getYDoc(): Promise<Doc> {
    const snapshot = await this.storage.get<Uint8Array>(
      storageKey({ type: "state", name: "doc" }),
    );
    const data = await this.storage.list<Uint8Array>({
      prefix: storageKey({ type: "update" }),
    });

    const updates: Uint8Array[] = Array.from(data.values());
    const doc = new Doc();

    doc.transact(() => {
      if (snapshot) {
        applyUpdate(doc, snapshot);
      }
      for (const update of updates) {
        applyUpdate(doc, update);
      }
    });

    return doc;
  }

  async exists(): Promise<boolean> {
    const explicit = await this.storage.get<boolean>(
      storageKey({ type: "state", name: "exists" }),
    );
    if (explicit === true) {
      return true;
    }

    const snapshot = await this.storage.get<Uint8Array>(
      storageKey({ type: "state", name: "doc" }),
    );
    if (snapshot !== undefined) {
      await this.markExists();

      return true;
    }

    const count = await this.storage.get<number>(
      storageKey({ type: "state", name: "count" }),
    );
    if ((count ?? 0) > 0) {
      await this.markExists();

      return true;
    }

    const updates = await this.storage.list<Uint8Array>({
      prefix: storageKey({ type: "update" }),
    });
    if (updates.size > 0) {
      await this.markExists();

      return true;
    }

    return false;
  }

  async markExists(): Promise<void> {
    await this.storage.put(storageKey({ type: "state", name: "exists" }), true);
  }

  clearDocument(): Promise<void> {
    return this.storage.transaction(async (tx) => {
      const data = await tx.list({ prefix: Y_DOC_STORAGE_PREFIX });
      if (data.size > 0) {
        await tx.delete(Array.from(data.keys()));
      }
    });
  }

  storeUpdate(update: Uint8Array): Promise<void> {
    return this.storage.transaction(async (tx) => {
      await tx.put(storageKey({ type: "state", name: "exists" }), true);

      const bytes =
        (await tx.get<number>(storageKey({ type: "state", name: "bytes" }))) ??
        0;
      const count =
        (await tx.get<number>(storageKey({ type: "state", name: "count" }))) ??
        0;

      const updateBytes = bytes + update.byteLength;
      const updateCount = count + 1;

      if (updateBytes > this.MAX_BYTES || updateCount > this.MAX_UPDATES) {
        const doc = await this.getYDoc();
        applyUpdate(doc, update);

        await this._commit(doc, tx);
      } else {
        await tx.put(storageKey({ type: "state", name: "bytes" }), updateBytes);
        await tx.put(storageKey({ type: "state", name: "count" }), updateCount);
        await tx.put(storageKey({ type: "update", name: updateCount }), update);
      }
    });
  }

  private async _commit(doc: Doc, tx: Omit<TransactionStorage, "transaction">) {
    const data = await tx.list<Uint8Array>({
      prefix: storageKey({ type: "update" }),
    });

    for (const update of data.values()) {
      applyUpdate(doc, update);
    }

    const update = encodeStateAsUpdate(doc);

    await tx.delete(Array.from(data.keys()));
    await tx.put(storageKey({ type: "state", name: "exists" }), true);
    await tx.put(storageKey({ type: "state", name: "bytes" }), 0);
    await tx.put(storageKey({ type: "state", name: "count" }), 0);
    await tx.put(storageKey({ type: "state", name: "doc" }), update);
  }

  async commit(): Promise<void> {
    const doc = await this.getYDoc();

    return this.storage.transaction(async (tx) => {
      await this._commit(doc, tx);
    });
  }
}
