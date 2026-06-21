function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothAlpha(data, width, height, strength) {
  if (strength < 8) return data;
  const passes = strength > 66 ? 2 : 1;
  let current = data;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8ClampedArray(current);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const index = (y * width + x) * 4 + 3;
        let total = 0;
        for (let yy = -1; yy <= 1; yy++) {
          for (let xx = -1; xx <= 1; xx++) {
            total += current[((y + yy) * width + (x + xx)) * 4 + 3];
          }
        }
        next[index] = Math.round(total / 9);
      }
    }
    current = next;
  }
  return current;
}

function trimImageData(image, padding) {
  const { data, width, height } = image;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 3) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return { image, trimApplied: false };
  }

  minX = clamp(minX - padding, 0, width - 1);
  minY = clamp(minY - padding, 0, height - 1);
  maxX = clamp(maxX + padding, 0, width - 1);
  maxY = clamp(maxY + padding, 0, height - 1);

  const outputWidth = maxX - minX + 1;
  const outputHeight = maxY - minY + 1;
  if (outputWidth === width && outputHeight === height) {
    return { image, trimApplied: false };
  }

  const output = new ImageData(outputWidth, outputHeight);
  for (let y = 0; y < outputHeight; y++) {
    for (let x = 0; x < outputWidth; x++) {
      const source = ((minY + y) * width + (minX + x)) * 4;
      const target = (y * outputWidth + x) * 4;
      output.data[target] = data[source];
      output.data[target + 1] = data[source + 1];
      output.data[target + 2] = data[source + 2];
      output.data[target + 3] = data[source + 3];
    }
  }
  return { image: output, trimApplied: true };
}

self.onmessage = (event) => {
  const { id, black, white, width, height, settings } = event.data;
  try {
    const blackData = black.data;
    const whiteData = white.data;
    const result = new ImageData(width, height);
    const cleanupThreshold = Math.round((settings.alphaCleanup / 100) * 18);
    const denoiseThreshold = Math.round((settings.denoise / 100) * 8);

    let suspicious = 0;
    for (let i = 0; i < blackData.length; i += 4) {
      const alphaR = 255 - (whiteData[i] - blackData[i]);
      const alphaG = 255 - (whiteData[i + 1] - blackData[i + 1]);
      const alphaB = 255 - (whiteData[i + 2] - blackData[i + 2]);
      let alpha = clamp(Math.round((alphaR + alphaG + alphaB) / 3), 0, 255);

      if (alpha < cleanupThreshold || alpha < denoiseThreshold) {
        alpha = 0;
      }

      if (alpha === 0) {
        result.data[i] = 0;
        result.data[i + 1] = 0;
        result.data[i + 2] = 0;
        result.data[i + 3] = 0;
        continue;
      }

      const scale = 255 / alpha;
      result.data[i] = clamp(Math.round(blackData[i] * scale), 0, 255);
      result.data[i + 1] = clamp(Math.round(blackData[i + 1] * scale), 0, 255);
      result.data[i + 2] = clamp(Math.round(blackData[i + 2] * scale), 0, 255);
      result.data[i + 3] = alpha;

      const mismatch =
        Math.abs(alphaR - alphaG) + Math.abs(alphaG - alphaB) + Math.abs(alphaB - alphaR);
      if (mismatch > 90) suspicious++;
    }

    const smoothed = smoothAlpha(result.data, width, height, settings.edgeSmooth);
    const finalImage =
      smoothed === result.data ? result : new ImageData(smoothed, width, height);
    const trimmed = settings.trimBounds
      ? trimImageData(finalImage, settings.trimPadding)
      : { image: finalImage, trimApplied: false };

    self.postMessage({
      id,
      ok: true,
      image: trimmed.image,
      width,
      height,
      outputWidth: trimmed.image.width,
      outputHeight: trimmed.image.height,
      trimApplied: trimmed.trimApplied,
      warning: suspicious > (width * height) / 10 ? "Review edge" : ""
    });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      message: error instanceof Error ? error.message : "Recover failed"
    });
  }
};
