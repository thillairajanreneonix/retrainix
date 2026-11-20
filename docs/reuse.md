# reuse.md - what came from the camera dashboard

plan.md A1.7 allows reuse of the camera dashboard's tools, weights and labelled data, on the
condition that every reused file is listed here with its source path. Paths are relative to
`../Reneonix-Camera-Dashboard-/`.

| Reused here | Source | What was taken |
|---|---|---|
| `config/models.yaml` - CircularNet `classes` | `models/circularnet/labels50.csv` | the 50 class names, in order |
| `config/models.yaml` - CircularNet `input_size` | `src/inference/onnx_stage2.py` (docstring) | the 432x432 input contract read from Google's Triton config |
| `config/agents.yaml` - `annotator_model.profiles.tiled_lowconf` | `src/inference/detector.py` | tiling values: 3x2 tiles, 0.2 overlap, NMS IoU 0.5 |

Weights and footage are not in git. Uploaded to `gs://retrainix-data-desktop-application-515217`
on 20 Nov 2026:

| Bucket path | Source | Notes |
|---|---|---|
| `seed/ultralytics_yolo/yolov8s-seg_sammix_best.pt` | `Model_Handoff/weights/yolov8s-seg_sammix_best.pt` | 23.8 MB, sha256 starts `a41fe305846881311cd52a99a5d54d28` (matches HANDOFF.md). Trained on machine-made labels - see HANDOFF.md section 7 before quoting its accuracy |
| `seed/circularnet_rfdetr/cn_segmentation.onnx` | `models/circularnet/cn_segmentation.onnx` | 139 MB. Google's published CircularNet model, unchanged; Apache-2.0 |
| `seed/circularnet_rfdetr/labels50.csv` | `models/circularnet/labels50.csv` | its 50 class names |
| `projects/p_84bd67/raw/.../video_20260904_163003.mp4` | `captures/video_20260904_163003.mp4` | 29 MB belt clip used for the first live upload test |
| `seed/sam/mobile_sam.pt` | `mobile_sam.pt` | 38.8 MB MobileSAM weights, sha256 starts `6dbb90523a35330fedd7f1d3dfc66f99`. Used by `agents/outliner.py` to outline boxes that have none |
| `seed/ultralytics_yolo/yolov8s-seg_sammix_best.onnx` | exported from `Model_Handoff/weights/yolov8s-seg_sammix_best.pt` | the same weights exported to ONNX at 448 px for the CPU pre-label worker |

Method reused, not a file: `backend/agents/outliner.py` follows the dashboard's
`tools/annotate_with_sam.py` - a box goes in as the prompt, SAM returns the mask. The
dashboard used a detector's boxes; here the boxes are the ones that have no outline, mostly
drawn by a person.

## Changed by plan.md Amendment A2 (20 Nov 2026, late evening)

No longer used by the product, and to be deleted from the bucket at the next deploy:
`seed/ultralytics_yolo/yolov8s-seg_sammix_best.pt`, its `.onnx` export, and
`seed/sam/mobile_sam.pt`. `backend/agents/outliner.py` is deleted. The rows above are kept
so the record of what was brought across stays complete.

Added:

| In this project | From the dashboard project | Notes |
|---|---|---|
| `seed/circularnet_rfdetr/checkpoint_circularnet_recovered.pth` (bucket only, 143 MB) | made by running `tools/circularnet_onnx_to_pth.py` on `models/circularnet/cn_segmentation.onnx` | The starting point for CircularNet training. Rebuilt on this PC on 20 Nov 2026 with rfdetr 1.5.2: 416 parameters copied, 28 class-head parameters skipped, 156 left at RF-DETR's COCO values, 0 shape mismatches - the same counts HANDOFF.md section 4.4 records. The tool's own output check reports a difference from the ONNX, which is expected for a partial copy with a new class head; it is NOT a faithful copy of Google's model and must not be described as one |

Method reused, not a file: the COCO layout and the batch 2 x 4 accumulation setting come
from the dashboard's CircularNet runs (HANDOFF.md sections 4.3-4.5, `tools/yolo_seg_to_coco.py`).
