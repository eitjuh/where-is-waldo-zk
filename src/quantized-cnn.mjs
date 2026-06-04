export function realCnnLogit(cropPixels, model) {
  const cropSize = model.preprocessing.crop_width;
  const inputSize = model.preprocessing.cnn_input_width;
  if (cropPixels.length !== cropSize * cropSize * 3) {
    throw new Error(`expected ${cropSize}x${cropSize} RGB crop`);
  }
  if (cropSize % inputSize !== 0) {
    throw new Error("CNN input size must evenly divide the private crop size");
  }

  const input = downsampleRgbBox(cropPixels, cropSize, inputSize);
  const conv = model.architecture.layers[0];
  const filters = conv.filters;
  const kernel = conv.kernel[0];
  const stride = conv.stride[0];
  const outputSize = Math.floor((inputSize - kernel) / stride) + 1;
  const activations = new Int32Array(filters * outputSize * outputSize);

  for (let filter = 0; filter < filters; filter += 1) {
    for (let outputY = 0; outputY < outputSize; outputY += 1) {
      for (let outputX = 0; outputX < outputSize; outputX += 1) {
        let accumulator = model.weights.conv_bias[filter];
        for (let kernelY = 0; kernelY < kernel; kernelY += 1) {
          for (let kernelX = 0; kernelX < kernel; kernelX += 1) {
            const inputY = outputY * stride + kernelY;
            const inputX = outputX * stride + kernelX;
            const inputBase = (inputY * inputSize + inputX) * 3;
            const weightBase = ((filter * kernel + kernelY) * kernel + kernelX) * 3;
            for (let channel = 0; channel < 3; channel += 1) {
              accumulator +=
                (input[inputBase + channel] - model.quantization.input_zero_point) *
                model.weights.conv[weightBase + channel];
            }
          }
        }
        const feature = (filter * outputSize + outputY) * outputSize + outputX;
        activations[feature] = Math.max(0, accumulator);
      }
    }
  }

  let logit = model.weights.dense_bias;
  for (let feature = 0; feature < activations.length; feature += 1) {
    logit += activations[feature] * model.weights.dense[feature];
  }
  return logit;
}

export function downsampleRgbBox(cropPixels, cropSize, inputSize) {
  const boxSize = cropSize / inputSize;
  const pixelsPerBox = boxSize * boxSize;
  const output = new Uint8Array(inputSize * inputSize * 3);
  for (let outputY = 0; outputY < inputSize; outputY += 1) {
    for (let outputX = 0; outputX < inputSize; outputX += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        for (let boxY = 0; boxY < boxSize; boxY += 1) {
          for (let boxX = 0; boxX < boxSize; boxX += 1) {
            const sourceX = outputX * boxSize + boxX;
            const sourceY = outputY * boxSize + boxY;
            sum += cropPixels[(sourceY * cropSize + sourceX) * 3 + channel];
          }
        }
        output[(outputY * inputSize + outputX) * 3 + channel] = Math.round(sum / pixelsPerBox);
      }
    }
  }
  return output;
}
