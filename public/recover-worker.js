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

function makeResponseMap(imageData, width, height, background) {
  const maxSide = Math.max(width, height);
  const scale = maxSide > 320 ? maxSide / 320 : 1;
  const mapWidth = Math.max(8, Math.round(width / scale));
  const mapHeight = Math.max(8, Math.round(height / scale));
  const map = new Uint8Array(mapWidth * mapHeight);
  const data = imageData.data;

  for (let y = 0; y < mapHeight; y++) {
    const sourceY = clamp(Math.round((y + 0.5) * scale - 0.5), 0, height - 1);
    for (let x = 0; x < mapWidth; x++) {
      const sourceX = clamp(Math.round((x + 0.5) * scale - 0.5), 0, width - 1);
      const index = (sourceY * width + sourceX) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const luminance = (r * 0.299 + g * 0.587 + b * 0.114);
      const foreground =
        background === "black"
          ? Math.max(r, g, b)
          : Math.max(255 - r, 255 - g, 255 - b);

      let edge = 0;
      if (sourceX > 0 && sourceX < width - 1 && sourceY > 0 && sourceY < height - 1) {
        const left = (sourceY * width + sourceX - 1) * 4;
        const right = (sourceY * width + sourceX + 1) * 4;
        const up = ((sourceY - 1) * width + sourceX) * 4;
        const down = ((sourceY + 1) * width + sourceX) * 4;
        const lx = (data[right] * 0.299 + data[right + 1] * 0.587 + data[right + 2] * 0.114) -
          (data[left] * 0.299 + data[left + 1] * 0.587 + data[left + 2] * 0.114);
        const ly = (data[down] * 0.299 + data[down + 1] * 0.587 + data[down + 2] * 0.114) -
          (data[up] * 0.299 + data[up + 1] * 0.587 + data[up + 2] * 0.114);
        edge = Math.min(255, Math.abs(lx) + Math.abs(ly));
      }

      const backgroundNoise = background === "black" ? luminance : 255 - luminance;
      const response = foreground < 10 && backgroundNoise < 10 ? 0 : foreground * 0.82 + edge * 0.18;
      map[y * mapWidth + x] = clamp(Math.round(response), 0, 255);
    }
  }

  return { data: map, width: mapWidth, height: mapHeight, scale };
}

function responseBounds(map, threshold) {
  const { data, width, height } = map;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] > threshold) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count++;
      }
    }
  }

  if (maxX < minX || maxY < minY || count < 12) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    count,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

function alignmentScore(blackMap, whiteMap, dx, dy) {
  const width = blackMap.width;
  const height = blackMap.height;
  const stride = width * height > 60000 ? 2 : 1;
  let total = 0;
  let count = 0;

  for (let y = 0; y < height; y += stride) {
    const sourceY = y - dy;
    if (sourceY < 0 || sourceY >= height) continue;
    for (let x = 0; x < width; x += stride) {
      const sourceX = x - dx;
      if (sourceX < 0 || sourceX >= width) continue;
      const blackValue = blackMap.data[y * width + x];
      const whiteValue = whiteMap.data[sourceY * width + sourceX];
      if (blackValue < 8 && whiteValue < 8) continue;
      total += Math.abs(blackValue - whiteValue);
      count++;
    }
  }

  if (count < 32) return Number.POSITIVE_INFINITY;
  return total / count;
}

function findAlignment(black, white, width, height, settings) {
  if (!settings.autoAlign) return { dx: 0, dy: 0, status: "off" };

  const blackMap = makeResponseMap(black, width, height, "black");
  const whiteMap = makeResponseMap(white, width, height, "white");
  const blackBounds = responseBounds(blackMap, 28);
  const whiteBounds = responseBounds(whiteMap, 28);
  if (!blackBounds || !whiteBounds) return { dx: 0, dy: 0, status: "review" };

  const sizeRatio =
    Math.max(blackBounds.width, whiteBounds.width) / Math.max(1, Math.min(blackBounds.width, whiteBounds.width)) *
    Math.max(blackBounds.height, whiteBounds.height) / Math.max(1, Math.min(blackBounds.height, whiteBounds.height));
  if (sizeRatio > 2.2) return { dx: 0, dy: 0, status: "review" };

  const roughDx = Math.round(blackBounds.centerX - whiteBounds.centerX);
  const roughDy = Math.round(blackBounds.centerY - whiteBounds.centerY);
  const baseScore = alignmentScore(blackMap, whiteMap, 0, 0);
  let best = { dx: roughDx, dy: roughDy, score: alignmentScore(blackMap, whiteMap, roughDx, roughDy) };
  const coarseRadius = Math.max(2, Math.round(36 / blackMap.scale));
  const coarseStep = 2;

  for (let dy = roughDy - coarseRadius; dy <= roughDy + coarseRadius; dy += coarseStep) {
    for (let dx = roughDx - coarseRadius; dx <= roughDx + coarseRadius; dx += coarseStep) {
      const score = alignmentScore(blackMap, whiteMap, dx, dy);
      if (score < best.score) best = { dx, dy, score };
    }
  }

  for (let dy = best.dy - 2; dy <= best.dy + 2; dy++) {
    for (let dx = best.dx - 2; dx <= best.dx + 2; dx++) {
      const score = alignmentScore(blackMap, whiteMap, dx, dy);
      if (score < best.score) best = { dx, dy, score };
    }
  }

  const dx = Math.round(best.dx * blackMap.scale);
  const dy = Math.round(best.dy * blackMap.scale);
  const maxOffset = Math.max(width, height) * 0.08;
  if (Math.abs(dx) > maxOffset || Math.abs(dy) > maxOffset) {
    return { dx: 0, dy: 0, status: "review", score: best.score, baseScore };
  }

  const improvement = Number.isFinite(baseScore) && baseScore > 0 ? (baseScore - best.score) / baseScore : 0;
  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) {
    return { dx: 0, dy: 0, status: "good", score: best.score, baseScore, improvement };
  }
  if (improvement < 0.02 && best.score > 18) {
    return { dx: 0, dy: 0, status: "review", score: best.score, baseScore, improvement };
  }

  return { dx, dy, status: "aligned", score: best.score, baseScore, improvement };
}

function shiftImageData(image, dx, dy, fillR, fillG, fillB) {
  if (dx === 0 && dy === 0) return image;
  const { width, height, data } = image;
  const output = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4;
      const sourceX = x - dx;
      const sourceY = y - dy;
      if (sourceX >= 0 && sourceX < width && sourceY >= 0 && sourceY < height) {
        const source = (sourceY * width + sourceX) * 4;
        output.data[target] = data[source];
        output.data[target + 1] = data[source + 1];
        output.data[target + 2] = data[source + 2];
        output.data[target + 3] = data[source + 3];
      } else {
        output.data[target] = fillR;
        output.data[target + 1] = fillG;
        output.data[target + 2] = fillB;
        output.data[target + 3] = 255;
      }
    }
  }
  return output;
}

self.onmessage = (event) => {
  const { id, black, white, width, height, settings } = event.data;
  try {
    const alignment = findAlignment(black, white, width, height, settings);
    const alignedWhite = shiftImageData(white, alignment.dx, alignment.dy, 255, 255, 255);
    const blackData = black.data;
    const whiteData = alignedWhite.data;
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
      alignment,
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
