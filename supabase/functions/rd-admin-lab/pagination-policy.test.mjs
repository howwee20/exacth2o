import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultHistoryPageSize,
  maximumHistoryPageSize,
  parseHistoryPageRequest,
  takeHistoryPage,
} from "./pagination-policy.mjs";

test("history page requests are bounded and reject invalid cursors", () => {
  assert.deepEqual(parseHistoryPageRequest({}), {
    pageSize: defaultHistoryPageSize,
    cursor: null,
  });
  assert.deepEqual(
    parseHistoryPageRequest({
      history_page_size: 5000,
      history_cursor: "not-a-time",
    }),
    {
      pageSize: maximumHistoryPageSize,
      cursor: null,
    },
  );
});

test("history pages expose a keyset cursor without returning the lookahead row", () => {
  const rows = [
    { id: "3", first_open_device_at: "2026-07-17T03:00:00.000Z" },
    { id: "2", first_open_device_at: "2026-07-17T02:00:00.000Z" },
    { id: "1", first_open_device_at: "2026-07-17T01:00:00.000Z" },
  ];
  assert.deepEqual(takeHistoryPage(rows, 2), {
    items: rows.slice(0, 2),
    pagination: {
      page_size: 2,
      has_more: true,
      next_cursor: "2026-07-17T02:00:00.000Z",
    },
  });
});
