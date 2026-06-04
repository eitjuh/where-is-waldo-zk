#!/usr/bin/env python3
"""Train and freeze the tiny integer CNN used by the real-image demo.

The script intentionally depends only on Pillow plus the Python standard
library. It consumes the ODbL Hey-Waldo dataset and writes a compact model
bundle plus Rust constants for the RISC Zero guest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from pathlib import Path

from PIL import Image, ImageOps


INPUT_SIZE = 16
CROP_SIZE = 64
FILTERS = 12
KERNEL = 3
STRIDE = 2
OUT_SIZE = (INPUT_SIZE - KERNEL) // STRIDE + 1
CHANNELS = 3
CONV_WEIGHTS = FILTERS * KERNEL * KERNEL * CHANNELS
DENSE_FEATURES = FILTERS * OUT_SIZE * OUT_SIZE
PUZZLE_CATALOG = (
    {"id": "knights-encampment", "title": "Knights' Encampment", "dataset_index": 7, "source": "3.jpg", "x": 12, "y": 5},
    {"id": "musical-parade", "title": "Musical Parade", "dataset_index": 10, "source": "6.jpg", "x": 15, "y": 4},
    {"id": "crowded-beach", "title": "Crowded Beach", "dataset_index": 11, "source": "7.jpg", "x": 6, "y": 11},
    {"id": "feast-hall", "title": "Feast Hall", "dataset_index": 16, "source": "12.jpg", "x": 10, "y": 4},
    {"id": "museum-mayhem", "title": "Museum Mayhem", "dataset_index": 14, "source": "9.jpg", "x": 1, "y": 12},
    {"id": "train-station", "title": "Train Station", "dataset_index": 17, "source": "13.jpg", "x": 13, "y": 5},
)
CATALOG_DATASET_INDICES = frozenset(entry["dataset_index"] for entry in PUZZLE_CATALOG)
HOLDOUT_DATASET_INDICES = frozenset(range(1, 20)) - CATALOG_DATASET_INDICES
SEED = 0x5A17D0


def dataset_index_from_sample(path: Path) -> int:
    return int(path.name.split("_", 1)[0])


def is_holdout_sample(path: Path) -> bool:
    return dataset_index_from_sample(path) in HOLDOUT_DATASET_INDICES


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dataset",
        default="/tmp/hey-waldo",
        help="Path to a checkout of https://github.com/vc1492a/Hey-Waldo",
    )
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--negative-train", type=int, default=900)
    parser.add_argument("--negative-val", type=int, default=500)
    parser.add_argument("--positive-repeats", type=int, default=12)
    parser.add_argument("--learning-rate", type=float, default=0.004)
    parser.add_argument("--repo", default=".")
    return parser.parse_args()


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def sha256_json(value: object) -> str:
    return "0x" + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def model_commitment(bundle: dict[str, object]) -> dict[str, object]:
    return {
        key: bundle[key]
        for key in (
            "schema",
            "model_id",
            "architecture",
            "preprocessing",
            "weights",
            "threshold_logit",
        )
    }


def load_sample(path: Path) -> list[float]:
    image = Image.open(path).convert("RGB").resize(
        (INPUT_SIZE, INPUT_SIZE), Image.Resampling.BOX
    )
    return [channel / 128.0 - 1.0 for pixel in image.getdata() for channel in pixel]


def augment(sample: list[float], rng: random.Random) -> list[float]:
    brightness = rng.uniform(0.88, 1.12)
    channel_shift = [rng.uniform(-0.07, 0.07) for _ in range(CHANNELS)]
    flip = rng.random() < 0.5
    output = [0.0] * len(sample)
    for y in range(INPUT_SIZE):
        for x in range(INPUT_SIZE):
            source_x = INPUT_SIZE - 1 - x if flip else x
            for channel in range(CHANNELS):
                source = (y * INPUT_SIZE + source_x) * CHANNELS + channel
                target = (y * INPUT_SIZE + x) * CHANNELS + channel
                noise = rng.uniform(-0.035, 0.035)
                output[target] = max(
                    -1.0,
                    min(1.0, sample[source] * brightness + channel_shift[channel] + noise),
                )
    return output


class TinyCnn:
    def __init__(self, rng: random.Random) -> None:
        limit = math.sqrt(2.0 / (KERNEL * KERNEL * CHANNELS))
        self.conv_w = [rng.uniform(-limit, limit) for _ in range(CONV_WEIGHTS)]
        self.conv_b = [0.0] * FILTERS
        self.dense_w = [rng.uniform(-0.08, 0.08) for _ in range(DENSE_FEATURES)]
        self.dense_b = 0.0
        self.step = 0
        self.m = {
            "conv_w": [0.0] * CONV_WEIGHTS,
            "conv_b": [0.0] * FILTERS,
            "dense_w": [0.0] * DENSE_FEATURES,
            "dense_b": [0.0],
        }
        self.v = {
            "conv_w": [0.0] * CONV_WEIGHTS,
            "conv_b": [0.0] * FILTERS,
            "dense_w": [0.0] * DENSE_FEATURES,
            "dense_b": [0.0],
        }

    def forward(self, sample: list[float]) -> tuple[float, list[float], list[float]]:
        activations = [0.0] * DENSE_FEATURES
        preactivations = [0.0] * DENSE_FEATURES
        for filter_index in range(FILTERS):
            for out_y in range(OUT_SIZE):
                for out_x in range(OUT_SIZE):
                    acc = self.conv_b[filter_index]
                    for ky in range(KERNEL):
                        for kx in range(KERNEL):
                            input_y = out_y * STRIDE + ky
                            input_x = out_x * STRIDE + kx
                            input_base = (input_y * INPUT_SIZE + input_x) * CHANNELS
                            weight_base = (
                                ((filter_index * KERNEL + ky) * KERNEL + kx) * CHANNELS
                            )
                            for channel in range(CHANNELS):
                                acc += (
                                    sample[input_base + channel]
                                    * self.conv_w[weight_base + channel]
                                )
                    feature = (filter_index * OUT_SIZE + out_y) * OUT_SIZE + out_x
                    preactivations[feature] = acc
                    activations[feature] = max(0.0, acc)

        logit = self.dense_b
        for feature in range(DENSE_FEATURES):
            logit += activations[feature] * self.dense_w[feature]
        return logit, activations, preactivations

    def train_sample(self, sample: list[float], label: int, learning_rate: float) -> float:
        logit, activations, preactivations = self.forward(sample)
        probability = sigmoid(logit)
        dlogit = probability - label
        gradients = {
            "conv_w": [0.0] * CONV_WEIGHTS,
            "conv_b": [0.0] * FILTERS,
            "dense_w": [dlogit * value for value in activations],
            "dense_b": [dlogit],
        }

        for filter_index in range(FILTERS):
            for out_y in range(OUT_SIZE):
                for out_x in range(OUT_SIZE):
                    feature = (filter_index * OUT_SIZE + out_y) * OUT_SIZE + out_x
                    if preactivations[feature] <= 0:
                        continue
                    dconv = dlogit * self.dense_w[feature]
                    gradients["conv_b"][filter_index] += dconv
                    for ky in range(KERNEL):
                        for kx in range(KERNEL):
                            input_y = out_y * STRIDE + ky
                            input_x = out_x * STRIDE + kx
                            input_base = (input_y * INPUT_SIZE + input_x) * CHANNELS
                            weight_base = (
                                ((filter_index * KERNEL + ky) * KERNEL + kx) * CHANNELS
                            )
                            for channel in range(CHANNELS):
                                gradients["conv_w"][weight_base + channel] += (
                                    dconv * sample[input_base + channel]
                                )

        self._adam_update("conv_w", self.conv_w, gradients["conv_w"], learning_rate)
        self._adam_update("conv_b", self.conv_b, gradients["conv_b"], learning_rate)
        self._adam_update("dense_w", self.dense_w, gradients["dense_w"], learning_rate)
        dense_bias = [self.dense_b]
        self._adam_update("dense_b", dense_bias, gradients["dense_b"], learning_rate)
        self.dense_b = dense_bias[0]
        self.step += 1
        return binary_cross_entropy(probability, label)

    def _adam_update(
        self, name: str, values: list[float], gradients: list[float], learning_rate: float
    ) -> None:
        beta1 = 0.9
        beta2 = 0.999
        epsilon = 1e-8
        step = self.step + 1
        correction1 = 1.0 - beta1**step
        correction2 = 1.0 - beta2**step
        for index, gradient in enumerate(gradients):
            self.m[name][index] = beta1 * self.m[name][index] + (1.0 - beta1) * gradient
            self.v[name][index] = beta2 * self.v[name][index] + (1.0 - beta2) * gradient * gradient
            m_hat = self.m[name][index] / correction1
            v_hat = self.v[name][index] / correction2
            values[index] -= learning_rate * m_hat / (math.sqrt(v_hat) + epsilon)


def sigmoid(value: float) -> float:
    if value >= 0:
        exp = math.exp(-value)
        return 1.0 / (1.0 + exp)
    exp = math.exp(value)
    return exp / (1.0 + exp)


def binary_cross_entropy(probability: float, label: int) -> float:
    probability = max(1e-8, min(1.0 - 1e-8, probability))
    return -(label * math.log(probability) + (1 - label) * math.log(1.0 - probability))


def quantize(model: TinyCnn) -> dict[str, object]:
    conv_max = max(abs(value) for value in model.conv_w)
    dense_max = max(abs(value) for value in model.dense_w)
    conv_scale = min(96.0, 127.0 / max(conv_max, 1e-6))
    dense_scale = min(96.0, 127.0 / max(dense_max, 1e-6))
    conv_bias_scale = 128.0 * conv_scale
    output_scale = conv_bias_scale * dense_scale
    return {
        "conv_weight_scale": conv_scale,
        "dense_weight_scale": dense_scale,
        "output_scale": output_scale,
        "conv_weights": [clamp_i8(round(value * conv_scale)) for value in model.conv_w],
        "conv_biases": [round(value * conv_bias_scale) for value in model.conv_b],
        "dense_weights": [clamp_i8(round(value * dense_scale)) for value in model.dense_w],
        "dense_bias": round(model.dense_b * output_scale),
    }


def clamp_i8(value: int) -> int:
    return max(-127, min(127, value))


def sample_to_u8(sample: list[float]) -> list[int]:
    return [max(0, min(255, round((value + 1.0) * 128.0))) for value in sample]


def quantized_logit(sample: list[float], quantized: dict[str, object]) -> int:
    pixels = sample_to_u8(sample)
    conv_weights = quantized["conv_weights"]
    conv_biases = quantized["conv_biases"]
    dense_weights = quantized["dense_weights"]
    activations = [0] * DENSE_FEATURES
    for filter_index in range(FILTERS):
        for out_y in range(OUT_SIZE):
            for out_x in range(OUT_SIZE):
                acc = conv_biases[filter_index]
                for ky in range(KERNEL):
                    for kx in range(KERNEL):
                        input_y = out_y * STRIDE + ky
                        input_x = out_x * STRIDE + kx
                        input_base = (input_y * INPUT_SIZE + input_x) * CHANNELS
                        weight_base = (
                            ((filter_index * KERNEL + ky) * KERNEL + kx) * CHANNELS
                        )
                        for channel in range(CHANNELS):
                            acc += (pixels[input_base + channel] - 128) * conv_weights[
                                weight_base + channel
                            ]
                feature = (filter_index * OUT_SIZE + out_y) * OUT_SIZE + out_x
                activations[feature] = max(0, acc)
    return quantized["dense_bias"] + sum(
        activations[index] * dense_weights[index] for index in range(DENSE_FEATURES)
    )


def choose_threshold(positive_scores: list[int], negative_scores: list[int]) -> tuple[int, dict]:
    candidates = sorted(set(positive_scores + negative_scores))
    best = None
    for threshold in candidates:
        true_positive = sum(score >= threshold for score in positive_scores)
        true_negative = sum(score < threshold for score in negative_scores)
        tpr = true_positive / len(positive_scores)
        tnr = true_negative / len(negative_scores)
        balanced = (tpr + tnr) / 2.0
        false_positive = 1.0 - tnr
        candidate = (balanced, -false_positive, threshold, tpr, tnr)
        if best is None or candidate > best:
            best = candidate
    assert best is not None
    _, _, threshold, tpr, tnr = best
    return threshold, {
        "positive_recall": round(tpr, 4),
        "negative_recall": round(tnr, 4),
        "balanced_accuracy": round((tpr + tnr) / 2.0, 4),
    }


def evaluate_float(model: TinyCnn, positives: list[list[float]], negatives: list[list[float]]) -> dict:
    positive_scores = [model.forward(sample)[0] for sample in positives]
    negative_scores = [model.forward(sample)[0] for sample in negatives]
    return {
        "positive_mean": sum(positive_scores) / len(positive_scores),
        "negative_mean": sum(negative_scores) / len(negative_scores),
        "positive_at_zero": sum(score >= 0 for score in positive_scores) / len(positive_scores),
        "negative_at_zero": sum(score < 0 for score in negative_scores) / len(negative_scores),
    }


def rust_array(values: list[int], per_line: int = 18) -> str:
    lines = []
    for start in range(0, len(values), per_line):
        lines.append("    " + ", ".join(str(value) for value in values[start : start + per_line]) + ",")
    return "\n".join(lines)


def write_outputs(
    repo: Path,
    dataset: Path,
    quantized: dict[str, object],
    threshold: int,
    metrics: dict,
) -> None:
    preprocessing = {
        "schema": "zk-waldo-real-preprocessing-v1",
        "accepted_input": "canonical-png-rgb",
        "canonical_pixels": "rgb-uint8-row-major",
        "image_width": 1024,
        "image_height": 1024,
        "tile_size": CROP_SIZE,
        "crop_width": CROP_SIZE,
        "crop_height": CROP_SIZE,
        "crop_alignment": "tile-aligned-top-left",
        "cnn_input_width": INPUT_SIZE,
        "cnn_input_height": INPUT_SIZE,
        "cnn_downsample": "4x4-rgb-box-average",
        "cnn_input_zero_point": 128,
    }
    bundle = {
        "schema": "zk-waldo-quantized-cnn-v1",
        "model_id": "waldo_real_tiny_cnn_v1",
        "model_family": "trained quantized convolutional neural network",
        "architecture": {
            "input": [INPUT_SIZE, INPUT_SIZE, CHANNELS],
            "layers": [
                {
                    "op": "conv2d",
                    "filters": FILTERS,
                    "kernel": [KERNEL, KERNEL],
                    "stride": [STRIDE, STRIDE],
                    "padding": "valid",
                },
                {"op": "relu"},
                {"op": "flatten"},
                {"op": "dense", "outputs": 1},
            ],
        },
        "preprocessing": preprocessing,
        "quantization": {
            "input_zero_point": 128,
            "conv_weight_scale": quantized["conv_weight_scale"],
            "dense_weight_scale": quantized["dense_weight_scale"],
            "output_scale": quantized["output_scale"],
        },
        "weights": {
            "conv": quantized["conv_weights"],
            "conv_bias": quantized["conv_biases"],
            "dense": quantized["dense_weights"],
            "dense_bias": quantized["dense_bias"],
        },
        "threshold_logit": threshold,
        "metrics": metrics,
        "dataset": {
            "name": "Hey-Waldo",
            "source": "https://github.com/vc1492a/Hey-Waldo",
            "license": "ODbL-1.0",
            "note": "The real puzzle catalog participates in hard-negative mining; metrics describe this constrained prototype, not production generalization.",
        },
    }
    model_hash = sha256_json(model_commitment(bundle))
    preprocessing_hash = sha256_json(preprocessing)
    artifact = {**bundle, "model_hash": model_hash, "preprocessing_hash": preprocessing_hash}

    model_path = repo / "models/artifacts/waldo_cnn_quantized.json"
    model_path.parent.mkdir(parents=True, exist_ok=True)
    model_path.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    rust_path = repo / "packages/zkvm/core/src/cnn_weights.rs"
    rust_path.write_text(
        "// Generated by scripts/train_real_cnn.py. Do not edit by hand.\n"
        f"pub const REAL_CNN_FILTERS: usize = {FILTERS};\n"
        f"pub const REAL_CNN_INPUT_SIZE: usize = {INPUT_SIZE};\n"
        f"pub const REAL_CNN_KERNEL: usize = {KERNEL};\n"
        f"pub const REAL_CNN_STRIDE: usize = {STRIDE};\n"
        f"pub const REAL_CNN_OUT_SIZE: usize = {OUT_SIZE};\n"
        f"pub const REAL_CNN_DENSE_FEATURES: usize = {DENSE_FEATURES};\n"
        f"pub const REAL_CNN_THRESHOLD: i32 = {threshold};\n"
        f"pub const REAL_CNN_MODEL_HASH: [u8; 32] = {hex_to_rust_bytes(model_hash)};\n"
        f"pub const REAL_CNN_PREPROCESSING_HASH: [u8; 32] = {hex_to_rust_bytes(preprocessing_hash)};\n"
        f"pub const REAL_CNN_CONV_WEIGHTS: [i8; {len(quantized['conv_weights'])}] = [\n"
        f"{rust_array(quantized['conv_weights'])}\n"
        "];\n"
        f"pub const REAL_CNN_CONV_BIASES: [i32; {len(quantized['conv_biases'])}] = [\n"
        f"{rust_array(quantized['conv_biases'])}\n"
        "];\n"
        f"pub const REAL_CNN_DENSE_WEIGHTS: [i8; {len(quantized['dense_weights'])}] = [\n"
        f"{rust_array(quantized['dense_weights'])}\n"
        "];\n"
        f"pub const REAL_CNN_DENSE_BIAS: i32 = {quantized['dense_bias']};\n",
        encoding="utf-8",
    )

    puzzle_root = repo / "apps/real-demo/assets/puzzles"
    puzzle_root.mkdir(parents=True, exist_ok=True)
    private_catalog = {"schema": "zk-waldo-real-private-catalog-v1", "puzzles": []}
    for puzzle in PUZZLE_CATALOG:
        source = dataset / "original-images" / puzzle["source"]
        puzzle_path = puzzle_root / f"{puzzle['id']}.png"
        canonical = ImageOps.fit(
            Image.open(source).convert("RGB"), (1024, 1024), method=Image.Resampling.LANCZOS
        )
        canonical.save(puzzle_path, format="PNG", optimize=True)
        private_catalog["puzzles"].append(
            {
                "id": puzzle["id"],
                "title": puzzle["title"],
                "dataset_index": puzzle["dataset_index"],
                "image_path": str(puzzle_path.relative_to(repo)),
                "x": puzzle["x"] * CROP_SIZE,
                "y": puzzle["y"] * CROP_SIZE,
            }
        )

    fixture_path = repo / "demo/real/catalog.private.json"
    fixture_path.parent.mkdir(parents=True, exist_ok=True)
    fixture_path.write_text(json.dumps(private_catalog, indent=2) + "\n", encoding="utf-8")


def hex_to_rust_bytes(value: str) -> str:
    clean = value.removeprefix("0x")
    return "[" + ", ".join(f"0x{clean[index:index+2]}" for index in range(0, len(clean), 2)) + "]"


def main() -> None:
    args = parse_args()
    rng = random.Random(SEED)
    dataset = Path(args.dataset).resolve()
    repo = Path(args.repo).resolve()
    positives = [
        load_sample(path)
        for path in sorted((dataset / "64/waldo").glob("*.jpg"))
        if not is_holdout_sample(path)
    ]
    negative_paths = sorted(
        path for path in (dataset / "64/notwaldo").glob("*.jpg") if not is_holdout_sample(path)
    )
    rng.shuffle(negative_paths)
    negative_train = [load_sample(path) for path in negative_paths[: args.negative_train]]
    negative_val = [
        load_sample(path)
        for path in negative_paths[args.negative_train : args.negative_train + args.negative_val]
    ]
    catalog_targets = [
        load_sample(dataset / f"64/waldo/{puzzle['dataset_index']}_{puzzle['x']}_{puzzle['y']}.jpg")
        for puzzle in PUZZLE_CATALOG
    ]
    catalog_negatives = [
        load_sample(path)
        for puzzle in PUZZLE_CATALOG
        for path in sorted((dataset / "64/notwaldo").glob(f"{puzzle['dataset_index']}_*.jpg"))
    ]

    print(
        f"training samples: {len(positives)} positive x {args.positive_repeats} repeats, "
        f"{len(negative_train)} negative, {len(catalog_negatives)} catalog hard negatives; "
        f"validation negatives: {len(negative_val)}"
    )
    model = TinyCnn(rng)
    hard_negatives = catalog_negatives[:]
    for epoch in range(args.epochs):
        epoch_rng = random.Random(SEED + epoch * 101)
        if epoch % 4 == 0:
            hard_negatives = sorted(
                catalog_negatives,
                key=lambda sample: model.forward(sample)[0],
                reverse=True,
            )[: len(positives) * args.positive_repeats]
        examples: list[tuple[list[float], int]] = []
        for positive in positives:
            for _ in range(args.positive_repeats):
                examples.append((augment(positive, epoch_rng), 1))
        positive_count = len(examples)
        for hard_negative in hard_negatives:
            examples.append((hard_negative, 0))
        for _ in range(max(0, positive_count - len(hard_negatives))):
            examples.append((negative_train[epoch_rng.randrange(len(negative_train))], 0))
        epoch_rng.shuffle(examples)
        loss = 0.0
        for sample, label in examples:
            loss += model.train_sample(sample, label, args.learning_rate)
        if epoch == 0 or (epoch + 1) % 6 == 0 or epoch + 1 == args.epochs:
            metrics = evaluate_float(model, positives, negative_val)
            print(
                f"epoch {epoch + 1:02d}: loss={loss / len(examples):.4f} "
                f"pos@0={metrics['positive_at_zero']:.3f} "
                f"neg@0={metrics['negative_at_zero']:.3f}"
            )

    quantized = quantize(model)
    positive_scores = [quantized_logit(sample, quantized) for sample in positives]
    negative_scores = [quantized_logit(sample, quantized) for sample in negative_val]
    threshold, metrics = choose_threshold(positive_scores, negative_scores)
    catalog_target_scores = [quantized_logit(sample, quantized) for sample in catalog_targets]
    catalog_negative_scores = [quantized_logit(sample, quantized) for sample in catalog_negatives]
    catalog_threshold = max(catalog_negative_scores) + 1
    if catalog_threshold <= min(catalog_target_scores):
        threshold = max(threshold, catalog_threshold)
        metrics["threshold_adjustment"] = "raised to reject every catalog hard negative"
    else:
        threshold = min(catalog_target_scores)
        metrics["threshold_adjustment"] = "lowered to accept every catalog Waldo target"
    holdout_targets = [
        load_sample(path)
        for path in sorted((dataset / "64/waldo").glob("*.jpg"))
        if is_holdout_sample(path)
    ]
    holdout_negatives = sorted(
        path for path in (dataset / "64/notwaldo").glob("*.jpg") if is_holdout_sample(path)
    )[:500]
    holdout_positive_scores = [quantized_logit(sample, quantized) for sample in holdout_targets]
    holdout_negative_scores = [quantized_logit(load_sample(path), quantized) for path in holdout_negatives]

    metrics.update(
        {
            "positive_samples": len(positives),
            "negative_validation_samples": len(negative_val),
            "catalog_target_logit_min": min(catalog_target_scores),
            "catalog_target_logit_max": max(catalog_target_scores),
            "threshold_logit": threshold,
            "positive_logit_min": min(positive_scores),
            "positive_logit_max": max(positive_scores),
            "negative_logit_min": min(negative_scores),
            "negative_logit_max": max(negative_scores),
            "catalog_puzzles": len(PUZZLE_CATALOG),
            "catalog_false_positive_tiles": sum(score >= threshold for score in catalog_negative_scores),
            "holdout_dataset_indices": sorted(HOLDOUT_DATASET_INDICES),
            "holdout_positive_samples": len(holdout_positive_scores),
            "holdout_negative_samples": len(holdout_negative_scores),
            "holdout_positive_recall": (
                sum(score >= threshold for score in holdout_positive_scores) / len(holdout_positive_scores)
                if holdout_positive_scores
                else None
            ),
            "holdout_negative_recall": (
                sum(score < threshold for score in holdout_negative_scores) / len(holdout_negative_scores)
                if holdout_negative_scores
                else None
            ),
        }
    )
    print("quantized metrics:", json.dumps(metrics, sort_keys=True))
    write_outputs(repo, dataset, quantized, threshold, metrics)


if __name__ == "__main__":
    main()
