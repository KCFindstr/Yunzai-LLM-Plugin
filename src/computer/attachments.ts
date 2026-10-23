import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../core/paths.ts'
import { detectImageMime, MIME_EXT, sha1 } from '../core/util.ts'
import type { ImagePart } from '../llm/types.ts'

export interface ComputerInputImage {
  index: number
  name: string
  mime: string
  bytes: number
}

export const MAX_COMPUTER_IMAGES = 8
export const MAX_COMPUTER_IMAGE_BYTES = 3_700_000

function inputDirectory(jobId: string): string {
  if (!/^[a-f0-9]{10}$/.test(jobId)) throw new Error('无效的电脑任务编号')
  return path.join(DATA_DIR, 'computer-inputs', jobId)
}

function imageName(name: string): string {
  if (!/^image-[1-8]-[a-f0-9]{12}\.(png|jpg|gif|webp|bmp)$/.test(name)) throw new Error('无效的电脑附件文件名')
  return name
}

export function computerImagePath(jobId: string, image: ComputerInputImage): string {
  inputDirectory(jobId)
  return `/work/attachments/${jobId}/${imageName(image.name)}`
}

/** Snapshot the already-loaded image bytes, before this chat turn and signed attachment URLs expire. */
export function captureComputerImages(jobId: string, images: ImagePart[], indices?: unknown): ComputerInputImage[] {
  const selected = indices === undefined ? images.map((_, index) => index + 1) : indices
  if (!Array.isArray(selected) || selected.length > MAX_COMPUTER_IMAGES || selected.some(index => !Number.isInteger(index) || index < 1 || index > images.length || index > MAX_COMPUTER_IMAGES))
    throw new Error(`请选择本轮有效的图片编号，最多 ${MAX_COMPUTER_IMAGES} 张`)
  // Validate the whole set before writing any files or submitting work to the desktop.
  const inputs = [...new Set<number>(selected)].map(index => {
    const part = images[index - 1]
    if (!part.data || part.data.length > Math.ceil(MAX_COMPUTER_IMAGE_BYTES / 3) * 4) throw new Error(`图片 ${index} 未加载或过大，请重新附图或引用原图`)
    const buffer = Buffer.from(part.data, 'base64')
    const mime = detectImageMime(buffer)
    if (!mime || buffer.length > MAX_COMPUTER_IMAGE_BYTES) throw new Error(`图片 ${index} 格式不支持或过大`)
    return { buffer, image: { index, name: `image-${index}-${sha1(buffer).slice(0, 12)}.${MIME_EXT[mime]}`, mime, bytes: buffer.length } }
  })
  if (inputs.length) {
    const directory = inputDirectory(jobId)
    fs.mkdirSync(directory, { recursive: true })
    for (const { image, buffer } of inputs) fs.writeFileSync(path.join(directory, image.name), buffer)
  }
  return inputs.map(input => input.image)
}

export function readComputerImages(jobId: string, images: ComputerInputImage[]) {
  if (images.length > MAX_COMPUTER_IMAGES) throw new Error('电脑附件数量超限')
  return images.map(image => {
    const buffer = fs.readFileSync(path.join(inputDirectory(jobId), imageName(image.name)))
    if (buffer.length > MAX_COMPUTER_IMAGE_BYTES || buffer.length !== image.bytes || detectImageMime(buffer) !== image.mime || !image.name.includes(sha1(buffer).slice(0, 12)))
      throw new Error('电脑附件已损坏，请重新附图或引用原图')
    return { name: image.name, data: buffer.toString('base64') }
  })
}
