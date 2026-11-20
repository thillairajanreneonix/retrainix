# Changelog

## 0.1 - 21 Nov 2026 (buildathon checkpoint)

The first tagged state of Retrainix, as deployed for Startup Buildathon India 2026.

- One model: Google's CircularNet (RF-DETR). It pre-labels frames and is the model that is retrained.
- Video upload and browser camera recording; frames sampled, de-duplicated, blur-filtered.
- Pre-labelling starts by itself after an upload. One camera frame can be labelled on request (`POST /predict`).
- Review in the app, gold set (20 examples + 10-frame hold-out), hold-out check, Gemini label check.
- MobileSAM outlines boxes a person draws (loaded through the Ultralytics library; no YOLO model is used).
- COCO dataset export, CircularNet fine-tuning on CPU as a Cloud Run job, scoring on the hold-out, promotion only if not worse, retrain schedule.
- Dashboard front page with a live camera view; orange and charcoal design system.

Known limits: no accuracy figure exists (no person-made gold set yet); the Gemini label check has not been run in the
current cloud project; no sign-in; no GPU; see CLAUDE.md for every measurement and open problem.
