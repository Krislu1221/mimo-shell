/** Read image files into data-URL attachments the engine accepts as FileParts. */

export const MAX_IMAGES = 6
export const MAX_BYTES = 12 * 1024 * 1024 // 12 MB per image after read

const IMAGE_OK = /^image\/(png|jpe?g|webp|gif|heic|heif|bmp|avif)$/i

export function isImageFile(file) {
  if (!file) return false
  if (file.type && IMAGE_OK.test(file.type)) return true
  // Some macOS paste/drop paths leave type empty; fall back to extension.
  return /\.(png|jpe?g|webp|gif|heic|heif|bmp|avif)$/i.test(file.name || '')
}

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * Accept File / Blob list → attachments:
 *   [{ id, mime, filename, url, dataUrl }]
 * Non-images are ignored (this UI only sends images for now).
 */
export async function filesToAttachments(fileList, existing = []) {
  const files = Array.from(fileList || []).filter(isImageFile)
  if (!files.length) return { added: [], rejected: 0, error: '' }

  let room = MAX_IMAGES - existing.length
  if (room <= 0) {
    return { added: [], rejected: files.length, error: `最多同时附带 ${MAX_IMAGES} 张图片` }
  }

  const added = []
  let rejected = 0
  let error = ''

  for (const file of files) {
    if (added.length >= room) {
      rejected++
      continue
    }
    try {
      const url = await readFileAsDataURL(file)
      if (url.length > MAX_BYTES * 1.4) {
        rejected++
        error = `「${file.name || '图片'}」太大（超过约 12MB）`
        continue
      }
      const mime = file.type || url.slice(5, url.indexOf(';')) || 'image/png'
      added.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mime,
        filename: file.name || `clipboard-${added.length + 1}.${mime.split('/')[1] || 'png'}`,
        url,
      })
    } catch {
      rejected++
    }
  }

  if (!added.length && !error) error = '没有可识别的图片'
  return { added, rejected, error }
}

/** ClipboardEvent → image attachments (paste). */
export async function pasteToAttachments(e, existing) {
  const items = e.clipboardData?.items
  if (!items) return { added: [], rejected: 0, error: '' }
  const files = []
  for (const item of items) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && isImageFile(file)) files.push(file)
  }
  return filesToAttachments(files, existing)
}

/** DragEvent → image attachments (drop). */
export async function dropToAttachments(e, existing) {
  return filesToAttachments(e.dataTransfer?.files, existing)
}

/** Map attachments to MiMo FilePart input. */
export function toFileParts(attachments) {
  return (attachments || []).map((a) => ({
    type: 'file',
    mime: a.mime,
    filename: a.filename,
    url: a.url,
  }))
}
