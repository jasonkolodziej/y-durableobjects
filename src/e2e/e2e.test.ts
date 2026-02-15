import { SELF, env, runInDurableObject } from "cloudflare:test";
import { hc } from "hono/client";
import { fromUint8Array } from "js-base64";
import { Doc, applyUpdate } from "yjs";

import { createSyncMessage, createYDocMessage } from "./helper";

import type { AppType } from ".";
import type { InternalYDurableObject } from "../yjs/internal";

describe("yRoute Shorthand", () => {
  it("should return a route", async () => {
    const res = await SELF.fetch("http://localhost/shorthand/1", {
      headers: {
        Upgrade: "websocket",
      },
    });
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeInstanceOf(WebSocket);
  });

  it("should return status 426 if no headers are present", async () => {
    const res = await SELF.fetch("http://localhost/shorthand/1");
    expect(res.status).toBe(426);
    await expect(res.text()).resolves.toBe("Expected websocket");
  });

  // eslint-disable-next-line vitest/expect-expect
  it("should verify the typing of the shorthand route", () => {
    const client = hc<AppType>("http://localhost", {
      fetch: SELF.fetch.bind(SELF),
    });

    expectTypeOf(client.shorthand[":id"].$ws).toEqualTypeOf<
      (args?: { param: { id: string } } | undefined) => WebSocket
    >();
  });
});

describe("endpoint request", () => {
  it("should return a WebSocket response", async () => {
    const res = await SELF.fetch("http://localhost/rooms/1", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeInstanceOf(WebSocket);
  });

  it("should return status 426 if no headers are present", async () => {
    const res = await SELF.fetch("http://localhost/rooms/1");
    expect(res.status).toBe(426);
    await expect(res.text()).resolves.toBe("Expected websocket");
  });

  it("should get the YDoc state", async () => {
    const roomId = "1";
    const id = env.Y_DURABLE_OBJECTS.idFromName(roomId);
    const stub = env.Y_DURABLE_OBJECTS.get(id);
    const message = createYDocMessage("get state");
    const update = createSyncMessage(message);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      await instance.updateYDoc(update.slice(0));
    });

    const res = await SELF.fetch(`http://localhost/rooms/${roomId}/state`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ doc: fromUint8Array(message) });
  });

  it("should update the YDoc state", async () => {
    const message = createYDocMessage("get state");
    const update = createSyncMessage(message);

    const roomId = "1";
    const id = env.Y_DURABLE_OBJECTS.idFromName(roomId);
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    const res = await SELF.fetch(`http://localhost/rooms/${roomId}/update`, {
      method: "POST",
      body: update.slice(0).buffer,
    });
    expect(res.status).toBe(200);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      const state = await instance.getYDoc();
      expect(state).toEqual(message);
    });
  });
});

describe("document server API", () => {
  it("creates and gets a document in yjs format", async () => {
    const identifier = "api-yjs-create";
    const update = createYDocMessage("document-server");

    const createRes = await SELF.fetch(
      `http://localhost/document-server/api/documents/${identifier}?format=yjs`,
      {
        method: "POST",
        body: update.slice(0).buffer,
      },
    );
    expect(createRes.status).toBe(204);

    const getRes = await SELF.fetch(
      `http://localhost/document-server/api/documents/${identifier}?format=yjs`,
    );
    expect(getRes.status).toBe(200);
    const payload = new Uint8Array(await getRes.arrayBuffer());
    const ydoc = new Doc();
    applyUpdate(ydoc, payload);
    expect(ydoc.getText("root").toString()).toEqual("document-server");
  });

  it("returns 409 when creating an existing document", async () => {
    const identifier = "api-create-conflict";
    const update = createYDocMessage("first");

    const firstRes = await SELF.fetch(
      `http://localhost/document-server/api/documents/${identifier}?format=yjs`,
      {
        method: "POST",
        body: update.slice(0).buffer,
      },
    );
    expect(firstRes.status).toBe(204);

    const secondRes = await SELF.fetch(
      `http://localhost/document-server/api/documents/${identifier}?format=yjs`,
      {
        method: "POST",
        body: update.slice(0).buffer,
      },
    );
    expect(secondRes.status).toBe(409);
  });

  it("returns json document by default on GET", async () => {
    const identifier = "api-default-json";
    const update = createYDocMessage("json-output");
    const createRes = await SELF.fetch(
      `http://localhost/document-server/api/documents/${identifier}?format=yjs`,
      {
        method: "POST",
        body: update.slice(0).buffer,
      },
    );
    expect(createRes.status).toBe(204);

    const getRes = await SELF.fetch(
      `http://localhost/document-server/api/documents/${identifier}`,
    );
    expect(getRes.status).toBe(200);
    await expect(getRes.json()).resolves.toEqual({ root: "json-output" });
  });

  it("patches an existing document with a yjs update", async () => {
    const identifier = "api-patch";
    const firstUpdate = createYDocMessage("before");
    const secondUpdate = createYDocMessage("after");

    await SELF.fetch(
      `http://localhost/document-server/api/documents/${identifier}?format=yjs`,
      {
        method: "POST",
        body: firstUpdate.slice(0).buffer,
      },
    );

    const patchRes = await SELF.fetch(
      `http://localhost/document-server/api/documents/${identifier}?format=yjs`,
      {
        method: "PATCH",
        body: secondUpdate.slice(0).buffer,
      },
    );
    expect(patchRes.status).toBe(204);

    const getRes = await SELF.fetch(
      `http://localhost/document-server/api/documents/${identifier}`,
    );
    expect(getRes.status).toBe(200);
    const json = (await getRes.json()) as { root: string };
    expect(json.root).toContain("before");
    expect(json.root).toContain("after");
  });

  it("deletes a document and returns 404 afterwards", async () => {
    const identifier = "api-delete";
    const update = createYDocMessage("delete-me");

    await SELF.fetch(
      `http://localhost/document-server/api/documents/${identifier}?format=yjs`,
      {
        method: "POST",
        body: update.slice(0).buffer,
      },
    );

    const deleteRes = await SELF.fetch(
      `http://localhost/document-server/api/documents/${identifier}`,
      { method: "DELETE" },
    );
    expect(deleteRes.status).toBe(204);

    const getRes = await SELF.fetch(
      `http://localhost/document-server/api/documents/${identifier}`,
    );
    expect(getRes.status).toBe(404);
  });

  it("returns 404 for patch on non-existent document", async () => {
    const update = createYDocMessage("missing");
    const patchRes = await SELF.fetch(
      "http://localhost/document-server/api/documents/missing?format=yjs",
      {
        method: "PATCH",
        body: update.slice(0).buffer,
      },
    );
    expect(patchRes.status).toBe(404);
  });

  it("returns 501 for not-yet-implemented global endpoints", async () => {
    const listRes = await SELF.fetch(
      "http://localhost/document-server/api/documents",
    );
    expect(listRes.status).toBe(501);

    const searchRes = await SELF.fetch(
      "http://localhost/document-server/api/search",
      {
        method: "POST",
      },
    );
    expect(searchRes.status).toBe(501);
  });
});
