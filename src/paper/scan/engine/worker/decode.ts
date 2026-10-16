import type { RGBAImage } from '../imaging/image';

export function rgbaToImageData(image: RGBAImage): ImageData {
  return new ImageData(image.data, image.width, image.height);
}
