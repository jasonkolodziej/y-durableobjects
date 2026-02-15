import { DurableObject } from "cloudflare:workers";
import { removeAwarenessStates } from "y-protocols/awareness";
import { applyUpdate, encodeStateAsUpdate } from "yjs";

import { WSSharedDoc } from "../yjs/remote";

import { setupWSConnection } from "./client/setup";
import { createApp } from "./hono";
import { YTransactionStorageImpl } from "./storage";

import type { AwarenessChanges } from "../yjs/remote";
import type { Env } from "hono";

export type WebSocketAttachment = {
  roomId: string;
  connectedAt: Date;
};

export type YDurableObjectsAppType = ReturnType<typeof createApp>;

export class YDurableObjects<T extends Env> extends DurableObject<
  T["Bindings"]
> {
  protected app = createApp({
    createRoom: this.createRoom.bind(this),
  });
  protected doc = new WSSharedDoc();
  protected storage = new YTransactionStorageImpl({
    get: (key) => this.state.storage.get(key),
    list: (options) => this.state.storage.list(options),
    put: (key, value) => this.state.storage.put(key, value),
    delete: async (key) =>
      this.state.storage.delete(Array.isArray(key) ? key : [key]),
    transaction: (closure) => this.state.storage.transaction(closure),
  });
  protected sessions = new Map<WebSocket, () => void>();
  private documentExists = false;
  private awarenessClients = new Set<number>();

  constructor(
    public state: DurableObjectState,
    public env: T["Bindings"],
  ) {
    super(state, env);

    void this.state.blockConcurrencyWhile(this.onStart.bind(this));
  }

  protected async onStart(): Promise<void> {
    this.documentExists = await this.storage.exists();
    if (this.documentExists) {
      const doc = await this.storage.getYDoc();
      applyUpdate(this.doc, encodeStateAsUpdate(doc));
    }

    this.registerDocumentObservers();

    for (const ws of this.state.getWebSockets()) {
      this.registerWebSocket(ws);
    }
    if (this.sessions.size > 0) {
      await this.ensureDocumentExists();
    }
  }

  protected async createRoom(roomId: string) {
    await this.ensureDocumentExists();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      roomId,
      connectedAt: new Date(),
    } satisfies WebSocketAttachment);

    this.state.acceptWebSocket(server);
    this.registerWebSocket(server);

    return client;
  }

  fetch(request: Request): Response | Promise<Response> {
    return this.app.request(request, undefined, this.env);
  }

  async hasDocument(): Promise<boolean> {
    return this.documentExists;
  }

  async createDocument(update?: Uint8Array): Promise<boolean> {
    if (this.documentExists) {
      return false;
    }

    await this.ensureDocumentExists();
    if (update !== undefined && update.byteLength > 0) {
      applyUpdate(this.doc, update);
      await this.cleanup();

      return true;
    }

    await this.storage.commit();

    return true;
  }

  async updateDocument(update: Uint8Array): Promise<boolean> {
    if (!this.documentExists) {
      return false;
    }

    applyUpdate(this.doc, update);
    await this.cleanup();

    return true;
  }

  async deleteDocument(): Promise<boolean> {
    if (!this.documentExists) {
      return false;
    }

    const sockets = new Set<WebSocket>([
      ...this.state.getWebSockets(),
      ...this.sessions.keys(),
    ]);
    for (const ws of sockets) {
      await this.unregisterWebSocket(ws);
      try {
        ws.close(1001, "Document deleted");
      } catch {
        // ignore close errors for sockets already closing/closed
      }
    }

    this.awarenessClients.clear();
    this.doc.destroy();
    this.doc = new WSSharedDoc();
    this.registerDocumentObservers();

    await this.storage.clearDocument();
    this.documentExists = false;

    return true;
  }

  async updateYDoc(update: Uint8Array): Promise<void> {
    await this.ensureDocumentExists();
    this.doc.update(update);
    await this.cleanup();
  }
  async getYDoc(): Promise<Uint8Array> {
    return encodeStateAsUpdate(this.doc);
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (!(message instanceof ArrayBuffer)) return;

    const update = new Uint8Array(message);
    await this.updateYDoc(update);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.unregisterWebSocket(ws);
    await this.cleanup();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.unregisterWebSocket(ws);
    await this.cleanup();
  }

  protected registerWebSocket(ws: WebSocket) {
    setupWSConnection(ws, this.doc);
    const s = this.doc.notify((message) => {
      ws.send(message);
    });
    this.sessions.set(ws, s);
  }

  protected async unregisterWebSocket(ws: WebSocket) {
    try {
      const dispose = this.sessions.get(ws);
      dispose?.();
      this.sessions.delete(ws);
      const clientIds = this.awarenessClients;

      removeAwarenessStates(this.doc.awareness, Array.from(clientIds), null);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
    }
  }

  protected async cleanup() {
    if (this.sessions.size < 1) {
      await this.storage.commit();
    }
  }

  private registerDocumentObservers() {
    this.doc.on("update", async (update) => {
      await this.storage.storeUpdate(update);
    });
    this.doc.awareness.on(
      "update",
      async ({ added, removed, updated }: AwarenessChanges) => {
        for (const client of [...added, ...updated]) {
          this.awarenessClients.add(client);
        }
        for (const client of removed) {
          this.awarenessClients.delete(client);
        }
      },
    );
  }

  private async ensureDocumentExists() {
    if (this.documentExists) {
      return;
    }

    await this.storage.markExists();
    this.documentExists = true;
  }
}
