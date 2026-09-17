// Query fields shared with the official plugin's note/file list API.
export function contentListRoute(collection: "notes" | "files", vault: string, page = 1, pageSize = 20, isRecycle = false, keyword = ""): string {
  const params = new URLSearchParams({ vault, page: String(page), pageSize: String(pageSize), isRecycle: String(isRecycle) });
  if (keyword) params.set("keyword", keyword);
  return `/api/${collection}?${params.toString()}`;
}
