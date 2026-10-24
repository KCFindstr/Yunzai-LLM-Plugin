import { readStoredImage, type SavedImage } from '../chat/images.ts'
export type ComputerInputImage = SavedImage
export const MAX_COMPUTER_IMAGE_BYTES = 5_242_880
export function computerImagePath(_jobId: string, image: ComputerInputImage): string { return image.path }
/** Jobs retain stable references; bytes always come from the global image store. */
export function readComputerImages(_jobId: string, images: ComputerInputImage[]) {
  return images.map(image => {
    const saved = readStoredImage(image.path)
    return { name: saved.image.name, path: saved.image.path, data: saved.part.data! }
  })
}
