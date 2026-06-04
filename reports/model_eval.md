# Real CNN Model Evaluation

## Frozen Model

```text
model_id: waldo_real_tiny_cnn_v1
model_hash: 0xba6a1c74c722b21fb49ab66991494dbf1e15aca855138b0baaa8b9c44437a043
preprocessing_hash: 0xf3d3e0ae30bf900fbd768125ce991442c221725660ce0675d60c58cf96b922ac
threshold_logit: 2823294
```

This is a trained quantized convolutional neural network, not the earlier
handcrafted color detector.

```text
private crop: 64x64 RGB uint8
CNN input: deterministic 4x4 box average to 16x16 RGB uint8
architecture: Conv2D(3 -> 12, 3x3, stride 2) -> ReLU -> Flatten -> Dense(588 -> 1)
parameters: 925
conv and dense weights: int8
biases, accumulators, and output logit: int32
```

The exact bundle is stored in
`models/artifacts/waldo_cnn_quantized.json`. The training script emits the same
frozen values as Rust constants in `packages/zkvm/core/src/cnn_weights.rs`.
The public model commitment hashes only the exact integer inference contract:
architecture, preprocessing, frozen weights, and threshold.

## Data And Training

The trainer consumes the Hey-Waldo crop dataset, trains real convolutional and
dense weights with Adam, applies augmentation to positive crops, quantizes the
weights, and repeatedly hard-negative-mines every non-Waldo aligned tile from
the six real demo pages.

```text
positive crops: 39
negative validation crops: 500
real catalog pages: 6
catalog aligned tiles: 1536
catalog non-Waldo tiles: 1530
```

The puzzle catalog participates in training and hard-negative mining. These
numbers describe a prototype constrained to this demo and must not be read as
out-of-distribution or production quality.

## Frozen Evaluation

```text
balanced accuracy: 99.50%
positive recall: 100.00%
negative recall: 99.00%
catalog false-positive tiles: 0 / 1530
catalog accepted tiles: 6 / 1536
catalog target JS/Rust logits: 3,849,265 to 8,003,417
```

The automated test scans all six complete `1024x1024` demo pages in aligned
`64x64` tiles and asserts that exactly one labeled tile passes per page.

## Reproduce

```bash
git clone https://github.com/vc1492a/Hey-Waldo.git /tmp/hey-waldo
pnpm real:train
pnpm real:prepare
pnpm test
```

The Hey-Waldo repository labels the dataset ODbL 1.0. The underlying puzzle
artwork may have separate copyright restrictions.

## Known Limits

- The model operates on tile-aligned crops only.
- The model is deliberately tiny to keep zkVM inference affordable.
- The validation set is small and the six-page catalog participates in
  training.
- The model has not been tested against adversarial patches or broad unseen
  Where's Waldo pages.
- A false-positive crop would satisfy the proof statement, because the proof
  establishes classifier acceptance rather than metaphysical identity.
