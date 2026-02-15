import { Hono } from "hono";
import { hc } from "hono/client";
import { Doc as YDoc, applyUpdate } from "yjs";

import { upgrade } from "../middleware";

import type { YDurableObjectsAppType } from "../yjs";
import type { Context, Env } from "hono";
import type { Doc } from "yjs";

type Selector<E extends Env> = (c: E["Bindings"]) => DurableObjectNamespace;

type Authorization =
  | {
      apiToken?: string;
      authorize?: undefined;
    }
  | {
      apiToken?: undefined;
      authorize?: (
        authorizationHeader: string | undefined,
        c: Context,
      ) => boolean | Promise<boolean>;
    };

export type DocumentServerRouteOptions = Authorization;

type DocumentDurableObjectStub = DurableObjectStub & {
  hasDocument(): Promise<boolean>;
  getYDoc(): Promise<Uint8Array>;
  createDocument(update?: Uint8Array): Promise<boolean>;
  updateDocument(update: Uint8Array): Promise<boolean>;
  deleteDocument(): Promise<boolean>;
};

type GetFormat = "base64" | "json" | "text" | "yjs";
type MutationFormat = "yjs";

const getFormat = (value: string | undefined): GetFormat | undefined => {
  if (value === undefined) {
    return "json";
  }

  switch (value) {
    case "base64":
    case "json":
    case "text":
    case "yjs":
      return value;
    default:
      return undefined;
  }
};

const getMutationFormat = (
  value: string | undefined,
): MutationFormat | undefined => {
  if (value === undefined || value === "yjs") {
    return "yjs";
  }

  return undefined;
};

const selectFragments = (
  doc: Doc,
  fragmentNames: string[],
): Record<string, unknown> => {
  const filtered: Record<string, unknown> = {};
  const sourceFragments =
    fragmentNames.length > 0
      ? fragmentNames
      : Array.from((doc as { share: Map<string, unknown> }).share.keys());

  const resolveFragment = (fragmentName: string): unknown => {
    const readers = [
      () => doc.getXmlFragment(fragmentName),
      () => doc.getText(fragmentName),
      () => doc.getArray(fragmentName),
      () => doc.getMap(fragmentName),
    ];
    for (const read of readers) {
      try {
        const fragment = read();

        return fragment.toJSON();
      } catch {
        // try the next fragment constructor
      }
    }

    return undefined;
  };

  for (const fragmentName of sourceFragments) {
    const value = resolveFragment(fragmentName);
    if (value !== undefined) {
      filtered[fragmentName] = value;
    }
  }

  return filtered;
};

const toText = (payload: Record<string, unknown>): string => {
  const entries = Object.entries(payload);
  if (entries.length < 1) {
    return "";
  }
  if (entries.length === 1) {
    const [_fragment, value] = entries[0];
    if (typeof value === "string") {
      return value;
    }

    return JSON.stringify(value);
  }

  return entries
    .map(([fragment, value]) => {
      if (typeof value === "string") {
        return `${fragment}: ${value}`;
      }

      return `${fragment}: ${JSON.stringify(value)}`;
    })
    .join("\n");
};

const getStub = <E extends Env>(
  c: Context,
  selector: Selector<E>,
  identifier: string,
): DocumentDurableObjectStub => {
  const obj = selector(c.env as E["Bindings"]);

  return obj.get(obj.idFromName(identifier)) as DocumentDurableObjectStub;
};

const authorize = async <E extends Env>(
  c: Context<E>,
  options?: DocumentServerRouteOptions,
) => {
  if (options?.authorize !== undefined) {
    return options.authorize(c.req.header("Authorization"), c);
  }
  if (options?.apiToken === undefined) {
    return true;
  }

  return c.req.header("Authorization") === options.apiToken;
};

const notImplemented = (c: Context, feature: string) => {
  return c.json(
    {
      error: `${feature} is not implemented yet.`,
    },
    501,
  );
};

export const yDocumentServerRoute = <E extends Env>(
  selector: Selector<E>,
  options?: DocumentServerRouteOptions,
) => {
  const app = new Hono<E>();

  app.use("/api/*", async (c, next) => {
    if (await authorize(c, options)) {
      return next();
    }

    return c.json({ error: "Unauthorized" }, 401);
  });

  app.get("/:id", upgrade(), async (c) => {
    const stub = getStub(c, selector, c.req.param("id"));

    // get websocket connection
    const url = new URL("/", c.req.url);
    const client = hc<YDurableObjectsAppType>(url.toString(), {
      fetch: stub.fetch.bind(stub),
    });
    const res = await client.rooms[":roomId"].$get(
      { param: { roomId: c.req.param("id") } },
      { init: { headers: c.req.raw.headers } },
    );

    return new Response(null, {
      webSocket: res.webSocket,
      status: res.status,
      statusText: res.statusText,
    });
  });

  app.post("/api/documents/:identifier", async (c) => {
    const format = getMutationFormat(c.req.query("format"));
    if (format === undefined) {
      return c.json({ error: "Only format=yjs is currently supported." }, 415);
    }

    const update = new Uint8Array(await c.req.arrayBuffer());
    const stub = getStub(c, selector, c.req.param("identifier"));
    const created = await stub.createDocument(
      update.byteLength > 0 ? update : undefined,
    );
    if (!created) {
      return c.body(null, 409);
    }

    return c.body(null, 204);
  });

  app.get("/api/documents/:identifier", async (c) => {
    const stub = getStub(c, selector, c.req.param("identifier"));
    const exists = await stub.hasDocument();
    if (!exists) {
      return c.body(null, 404);
    }

    const format = getFormat(c.req.query("format"));
    if (format === undefined) {
      return c.json({ error: "Unsupported format parameter." }, 400);
    }
    const update = await stub.getYDoc();
    if (format === "yjs") {
      return new Response(update, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (format === "base64") {
      return c.json(
        {
          error: "format=base64 is not implemented yet.",
        },
        501,
      );
    }

    const doc = new YDoc();
    if (update.byteLength > 0) {
      applyUpdate(doc, update);
    }

    const fragments = new URL(c.req.url).searchParams.getAll("fragment");
    const payload = selectFragments(doc, fragments);
    if (format === "text") {
      return c.text(toText(payload));
    }

    return c.json(payload);
  });

  app.patch("/api/documents/:identifier", async (c) => {
    const format = getMutationFormat(c.req.query("format"));
    if (format === undefined) {
      return c.json({ error: "Only format=yjs is currently supported." }, 415);
    }

    const update = new Uint8Array(await c.req.arrayBuffer());
    if (update.byteLength < 1) {
      return c.body(null, 422);
    }

    const stub = getStub(c, selector, c.req.param("identifier"));
    try {
      const updated = await stub.updateDocument(update);
      if (!updated) {
        return c.body(null, 404);
      }

      return c.body(null, 204);
    } catch {
      return c.body(null, 422);
    }
  });

  app.delete("/api/documents/:identifier", async (c) => {
    const stub = getStub(c, selector, c.req.param("identifier"));
    const deleted = await stub.deleteDocument();
    if (!deleted) {
      return c.body(null, 404);
    }

    return c.body(null, 204);
  });

  app.get("/api/documents", (c) => {
    return notImplemented(c, "List documents endpoint");
  });

  app.put("/api/admin/batch-import", (c) => {
    return notImplemented(c, "Batch import endpoint");
  });

  app.post("/api/documents/:identifier/encrypt", (c) => {
    return notImplemented(c, "Encrypt document endpoint");
  });

  app.post("/api/documents/:identifier/versions", (c) => {
    return notImplemented(c, "Revert to version endpoint");
  });

  app.post("/api/documents/:identifier/versions/:versionId/revertTo", (c) => {
    return notImplemented(c, "Revert to version endpoint");
  });

  app.post("/api/search", (c) => {
    return notImplemented(c, "Search endpoint");
  });

  return app;
};
