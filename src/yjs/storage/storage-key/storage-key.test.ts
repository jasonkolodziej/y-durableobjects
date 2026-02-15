import { storageKey, Y_DOC_STORAGE_PREFIX } from ".";

import type { Key } from ".";

describe("storageKey functionality", () => {
  it.each([
    [{ type: "update" }, "ydoc:update:"], // nameが省略された場合
    [{ type: "update", name: 1 }, "ydoc:update:1"], // nameが数値で提供された場合
    [{ type: "state", name: "bytes" }, "ydoc:state:bytes"], // typeがstateでnameがbytesの場合
    [{ type: "state", name: "doc" }, "ydoc:state:doc"], // typeがstateでnameがdocの場合
    [{ type: "state", name: "count" }, "ydoc:state:count"], // typeがstateでnameが新しく追加されたcountの場合
    [{ type: "state", name: "exists" }, "ydoc:state:exists"], // typeがstateでnameがexistsの場合
  ])("correctly generates storage key for key: %o", (key, expected) => {
    expect(storageKey(key as Key)).toEqual(expected);
  });

  it("exposes storage prefix", () => {
    expect(Y_DOC_STORAGE_PREFIX).toEqual("ydoc:");
  });
});
