export type Key =
  | {
      type: "update";
      name?: number;
    }
  | {
      type: "state";
      name: "bytes" | "doc" | "count" | "exists";
    };

export const Y_DOC_STORAGE_PREFIX = "ydoc:";

export const storageKey = (key: Key) => {
  return `${Y_DOC_STORAGE_PREFIX}${key.type}:${key.name ?? ""}`;
};
