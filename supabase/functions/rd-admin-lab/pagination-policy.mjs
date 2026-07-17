export const defaultHistoryPageSize = 24;
export const maximumHistoryPageSize = 50;

export function parseHistoryPageRequest(value) {
  const body = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const requestedSize = Number(body.history_page_size);
  const pageSize = Number.isFinite(requestedSize)
    ? Math.max(1, Math.min(maximumHistoryPageSize, Math.floor(requestedSize)))
    : defaultHistoryPageSize;
  const cursorValue = typeof body.history_cursor === "string"
    ? body.history_cursor.trim()
    : "";
  const cursor = cursorValue && Number.isFinite(Date.parse(cursorValue))
    ? new Date(cursorValue).toISOString()
    : null;

  return { pageSize, cursor };
}

export function takeHistoryPage(rows, pageSize) {
  const hasMore = rows.length > pageSize;
  const items = rows.slice(0, pageSize);
  const finalItem = items.at(-1);
  const nextCursor = hasMore && finalItem?.first_open_device_at
    ? String(finalItem.first_open_device_at)
    : null;

  return {
    items,
    pagination: {
      page_size: pageSize,
      has_more: hasMore,
      next_cursor: nextCursor,
    },
  };
}
