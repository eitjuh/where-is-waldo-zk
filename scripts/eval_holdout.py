#!/usr/bin/env python3
"""Report CNN scores on Hey-Waldo pages outside the six-page demo catalog."""

from __future__ import annotations

import json
from pathlib import Path

from train_real_cnn import PUZZLE_CATALOG, load_sample, parse_args, quantized_logit


def main() -> None:
    args = parse_args()
    dataset = Path(args.dataset).resolve()
    repo = Path(args.repo).resolve()
    catalog_indices = {entry["dataset_index"] for entry in PUZZLE_CATALOG}
    model_path = repo / "models/artifacts/waldo_cnn_quantized.json"
    artifact = json.loads(model_path.read_text(encoding="utf-8"))
    threshold = artifact["threshold_logit"]
    quantized = {
        "conv_weights": artifact["weights"]["conv"],
        "conv_biases": artifact["weights"]["conv_bias"],
        "dense_weights": artifact["weights"]["dense"],
        "dense_bias": artifact["weights"]["dense_bias"],
    }

    holdout_targets = sorted(
        path
        for path in (dataset / "64/waldo").glob("*.jpg")
        if int(path.name.split("_", 1)[0]) not in catalog_indices
    )
    holdout_negatives = sorted(
        path
        for path in (dataset / "64/notwaldo").glob("*.jpg")
        if int(path.name.split("_", 1)[0]) not in catalog_indices
    )[:500]

    positive_scores = [quantized_logit(load_sample(path), quantized) for path in holdout_targets]
    negative_scores = [quantized_logit(load_sample(path), quantized) for path in holdout_negatives]

    report = {
        "schema": "zk-waldo-holdout-eval-v1",
        "catalog_pages": len(PUZZLE_CATALOG),
        "holdout_positive_samples": len(positive_scores),
        "holdout_negative_samples": len(negative_scores),
        "threshold_logit": threshold,
        "holdout_positive_logit_min": min(positive_scores) if positive_scores else None,
        "holdout_positive_logit_max": max(positive_scores) if positive_scores else None,
        "holdout_negative_logit_max": max(negative_scores) if negative_scores else None,
        "holdout_positive_recall": (
            sum(score >= threshold for score in positive_scores) / len(positive_scores)
            if positive_scores
            else None
        ),
        "holdout_negative_recall": (
            sum(score < threshold for score in negative_scores) / len(negative_scores)
            if negative_scores
            else None
        ),
        "note": "Holdout uses dataset indices not present in the demo catalog; this is a sanity check, not a production SLA.",
    }
    out = repo / "reports/holdout_eval.json"
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
