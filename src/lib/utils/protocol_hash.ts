// Extracted from obsidian-fast-note-sync 2.4.0; keep wire hashes compatible.
// This module has no Obsidian, filesystem, UI or Node dependencies.
export type HashYield = () => Promise<void>;

export interface BinaryHashReader {
  readAll(): Promise<ArrayBuffer>;
  readRange(offset: number, length: number): Promise<ArrayBuffer>;
  onRangeError?(error: unknown): void;
}

const yieldToEventLoop: HashYield = () => new Promise(resolve => setTimeout(resolve, 0));

export const hashContent = function (content: string): string {
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash &= hash
  }
  return String(hash)
}

/**
 * 对字符串内容进行异步哈希 (支持大字符串分段处理，防止 UI 挂起)
 * Async version of hashContent that yields the thread for large strings
 */
export const hashContentAsync = async function (content: string, yieldTask: HashYield = yieldToEventLoop): Promise<string> {
  let hash = 0
  const len = content.length
  // 每 256K 字符让出一次主线程
  const yieldSize = 256 * 1024

  for (let i = 0; i < len; i++) {
    const char = content.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash &= hash

    if (i > 0 && i % yieldSize === 0) {
      await yieldTask()
    }
  }
  return String(hash)
}

const FILE_HASH_THRESHOLD = 10 * 1024 * 1024 // 10MB
const FILE_HASH_SLICE_SIZE = 5 * 1024 * 1024 // 5MB

/**
 * 计算大文件中段采样起始偏移：以文件中点为中心取一个切片长度的区间，并夹紧到有效范围内
 * Calculate the start offset of the middle sample slice for large files: centered on the
 * file's midpoint, clamped to a valid range.
 */
function computeMidSliceStart(size: number): number {
  const idealStart = Math.floor(size / 2) - Math.floor(FILE_HASH_SLICE_SIZE / 2)
  const maxStart = Math.max(0, size - FILE_HASH_SLICE_SIZE)
  return Math.min(Math.max(0, idealStart), maxStart)
}

/**
 * 对 ArrayBuffer 进行哈希 (统一采用 JS 数字滚动哈希以保持一致性)
 * 对于超过 10MB 的数据，仅计算前 5MB、中间 5MB (以文件中点为中心) 和后 5MB 的哈希值。
 * 分段计算并适时让出主线程，防止大文件导致 UI 卡顿 (Processed in chunks to yield main thread)
 */
export const hashArrayBuffer = async function (buffer: ArrayBuffer, yieldTask: HashYield = yieldToEventLoop): Promise<string> {
  const size = buffer.byteLength
  let view: Uint8Array | null

  if (size <= FILE_HASH_THRESHOLD) {
    view = new Uint8Array(buffer)
  } else {
    // 大文件优化：拼接前 5MB、中间 5MB 和后 5MB (Optimize for large files: slice first, middle, and last 5MB)
    view = new Uint8Array(FILE_HASH_SLICE_SIZE * 3)
    const fullView = new Uint8Array(buffer)

    // 添加边界保护：确保 subarray 不会超出 view 的预留空间 (Boundary protection: ensure subarray fits in view)
    const headLen = Math.min(size, FILE_HASH_SLICE_SIZE)
    const tailLen = Math.min(size, FILE_HASH_SLICE_SIZE)
    const tailStart = Math.max(0, size - tailLen)
    const midStart = computeMidSliceStart(size)
    const midLen = Math.min(FILE_HASH_SLICE_SIZE, size - midStart)

    view.set(fullView.subarray(0, headLen), 0)
    view.set(fullView.subarray(midStart, midStart + midLen), FILE_HASH_SLICE_SIZE)
    view.set(fullView.subarray(tailStart, size), FILE_HASH_SLICE_SIZE * 2)
  }

  return await computeRollingHash(view, yieldTask)
}

export const hashFileContent = async function (size: number, reader: BinaryHashReader, yieldTask: HashYield = yieldToEventLoop): Promise<string> {
  let view: Uint8Array

  if (size <= FILE_HASH_THRESHOLD) {
    // 小文件直接读取 (Read small files directly)
    const buffer = await reader.readAll()
    view = new Uint8Array(buffer)
  } else {
    // 大文件优化：优先使用 fetch + Range 仅读取前 5MB、中间 5MB 和后 5MB (Large file optimization: try fetch head/middle/tail 5MB)
    const midOffset = computeMidSliceStart(size)
    try {
      const head = await reader.readRange(0, FILE_HASH_SLICE_SIZE)
      const mid = await reader.readRange(midOffset, Math.min(FILE_HASH_SLICE_SIZE, size - midOffset))
      const tailOffset = Math.max(0, size - FILE_HASH_SLICE_SIZE)
      const tail = await reader.readRange(tailOffset, FILE_HASH_SLICE_SIZE)

      view = new Uint8Array(FILE_HASH_SLICE_SIZE * 3)
      const headUint8 = new Uint8Array(head)
      const midUint8 = new Uint8Array(mid)
      const tailUint8 = new Uint8Array(tail)

      // 强制截断至标准切片大小，防止 Uint8Array.set 越界 (Force slice to standard size to prevent RangeError)
      view.set(headUint8.subarray(0, Math.min(headUint8.length, FILE_HASH_SLICE_SIZE)), 0)
      view.set(midUint8.subarray(0, Math.min(midUint8.length, FILE_HASH_SLICE_SIZE)), FILE_HASH_SLICE_SIZE)
      view.set(tailUint8.subarray(0, Math.min(tailUint8.length, FILE_HASH_SLICE_SIZE)), FILE_HASH_SLICE_SIZE * 2)
    } catch (e) {
      reader.onRangeError?.(e);
      // 兜底方案：加载完整文件内容 (Fallback: read full file)
      const buffer = await reader.readAll()
      const fullView = new Uint8Array(buffer)
      view = new Uint8Array(FILE_HASH_SLICE_SIZE * 3)

      const headLen = Math.min(size, FILE_HASH_SLICE_SIZE)
      const tailLen = Math.min(size, FILE_HASH_SLICE_SIZE)
      const tailStart = Math.max(0, size - tailLen)
      const midLen = Math.min(FILE_HASH_SLICE_SIZE, size - midOffset)

      view.set(fullView.subarray(0, headLen), 0)
      view.set(fullView.subarray(midOffset, midOffset + midLen), FILE_HASH_SLICE_SIZE)
      view.set(fullView.subarray(tailStart, size), FILE_HASH_SLICE_SIZE * 2)
    }
  }

  const hash = await computeRollingHash(view, yieldTask)
  return hash
}

async function computeRollingHash(view: Uint8Array | null, yieldTask: HashYield): Promise<string> {
  if (!view) return "0"
  let hash = 0
  const len = view.length
  const yieldSize = 512 * 1024 // 每 512KB 让出一次主线程 (Yield every 512KB)

  for (let i = 0; i < len; i++) {
    const byte = view[i]
    hash = (hash << 5) - hash + byte
    hash &= hash

    if (i > 0 && i % yieldSize === 0) {
      await yieldTask()
    }
  }
  const result = String(hash)
  view = null // 显式释放引用 (Explicitly release reference)
  return result
}
