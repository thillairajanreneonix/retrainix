"""Build the filled submission deck on the organisers' template look.

    python build_deck.py <template.pdf> <shots dir> <out.pptx>

Each slide uses a page of the template PDF as its picture background, so the header and
branding are the organisers'; everything written on top is ordinary editable text.
"""
import io
import sys
from pathlib import Path

import pymupdf
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Pt

PDF, SHOTS, OUT = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
doc = pymupdf.open(PDF)
W, H = 720, 405  # points, as the template
INK, GREY, ORANGE, BLUE, PALE = RGBColor(0x1F, 0x1F, 0x1F), RGBColor(0x55, 0x5B, 0x64), RGBColor(0xE8, 0x5D, 0x04), RGBColor(0x1A, 0x73, 0xE8), RGBColor(0xF1, 0xF3, 0xF4)
FONT = "Arial"

prs = Presentation()
prs.slide_width, prs.slide_height = Pt(W), Pt(H)
BLANK = prs.slide_layouts[6]


def page_png(n):
    return io.BytesIO(doc[n - 1].get_pixmap(dpi=200).tobytes("png"))


def slide(bg_page):
    s = prs.slides.add_slide(BLANK)
    s.shapes.add_picture(page_png(bg_page), 0, 0, prs.slide_width, prs.slide_height)
    return s


def text(s, x, y, w, h, lines, size=11, bold=False, color=INK, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, gap=3):
    box = s.shapes.add_textbox(Pt(x), Pt(y), Pt(w), Pt(h))
    tf = box.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = Pt(2)
    lines = [lines] if isinstance(lines, str) else lines
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.space_after = Pt(gap)
        head, _, rest = line.partition("||")  # "Bold lead||rest of the line"
        parts = [(head, True), (rest, False)] if rest else [(head, bold)]
        for part, is_bold in parts:
            r = p.add_run()
            r.text = part
            r.font.size, r.font.bold, r.font.name, r.font.color.rgb = Pt(size), is_bold, FONT, color
    return box


def title(s, t):
    text(s, 25, 56, 660, 24, t, size=15, bold=True)


def bullets(s, items, y=92, size=11, x=40, w=640, h=290, gap=5):
    text(s, x, y, w, h, ["•  " + i for i in items], size=size, gap=gap)


def node(s, x, y, w, h, label, fill=PALE, color=INK, size=8.5, bold=False, line=GREY):
    shp = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Pt(x), Pt(y), Pt(w), Pt(h))
    shp.fill.solid()
    shp.fill.fore_color.rgb = fill
    shp.line.color.rgb = line
    shp.line.width = Pt(0.75)
    shp.adjustments[0] = 0.12
    tf = shp.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.margin_left = tf.margin_right = Pt(3)
    tf.margin_top = tf.margin_bottom = Pt(1)
    for i, line_text in enumerate(label.split("\n")):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = PP_ALIGN.CENTER
        r = p.add_run()
        r.text = line_text
        r.font.size, r.font.name, r.font.color.rgb = Pt(size), FONT, color
        r.font.bold = bold or i == 0
    return shp


def arrow(s, x1, y1, x2, y2, color=GREY):
    c = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Pt(x1), Pt(y1), Pt(x2), Pt(y2))
    c.line.color.rgb = color
    c.line.width = Pt(1.25)
    ln = c.line._get_or_add_ln()
    tail = ln.makeelement("{http://schemas.openxmlformats.org/drawingml/2006/main}tailEnd", {"type": "triangle"})
    ln.append(tail)


def table(s, x, y, w, col_widths, rows, size=8.5, row_h=22):
    shape = s.shapes.add_table(len(rows), len(rows[0]), Pt(x), Pt(y), Pt(w), Pt(row_h * len(rows)))
    t = shape.table
    for c, cw in enumerate(col_widths):
        t.columns[c].width = Pt(cw)
    for r, row in enumerate(rows):
        t.rows[r].height = Pt(row_h)
        for c, value in enumerate(row):
            cell = t.cell(r, c)
            cell.margin_left = cell.margin_right = Pt(4)
            cell.margin_top = cell.margin_bottom = Pt(2)
            cell.fill.solid()
            cell.fill.fore_color.rgb = RGBColor(0x20, 0x21, 0x24) if r == 0 else (PALE if r % 2 == 0 else RGBColor(0xFF, 0xFF, 0xFF))
            tf = cell.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            run = p.add_run()
            run.text = value
            run.font.size, run.font.name, run.font.bold = Pt(size), FONT, r == 0
            run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF) if r == 0 else INK


def shot(s, name, x, y, w):
    path = next(SHOTS.glob(f"*{name}.jpg"))
    pic = s.shapes.add_picture(str(path), Pt(x), Pt(y), width=Pt(w))
    pic.line.color.rgb = RGBColor(0xC0, 0xC4, 0xCC)
    pic.line.width = Pt(0.5)
    return pic


# 2 - cover (the template's own labels are in the background picture)
s = slide(2)
text(s, 135, 261, 520, 18, "Reneonix", size=12)
text(s, 122, 294, 520, 18, "[team to fill in]", size=12, color=ORANGE)
text(s, 180, 323, 505, 60, "Vision models that sort recyclables go stale when the material, lighting or camera changes, and relabelling images to retrain them is slow manual work. Retrainix turns new video into checked labels and a retrained, scored model on Google Cloud.", size=10.5)

# 3 - brief
s = slide(14)
title(s, "Brief about the idea")
bullets(s, [
    "Retrainix||  is a web app on Google Cloud that keeps a recycling line's vision model up to date with the line's own footage.",
    "An operator adds video or records from a camera. Google's CircularNet labels every frame by itself; Gemini flags doubtful labels; a person approves or corrects them.",
    "The reviewed labels become a versioned dataset. CircularNet is retrained as a Cloud Run job and scored on a fixed set of frames a person checked.",
    "A new model version replaces the old one only if it scores at least as well, so an update can never quietly make things worse.",
    "It is the cloud data-and-retraining workflow of our REXTOR application: human-reviewed corrections, versioned datasets and model versions.",
], size=11.5, gap=7)

# 4 - opportunities
s = slide(14)
title(s, "Opportunities")
text(s, 40, 88, 640, 300, [
    "How different is it from any of the other existing ideas?||",
    "•  Labelling, review and training tools already exist. Retrainix joins them into one loop for one job: updating a sorting model when the line changes.",
    "•  Every version is scored on the same person-checked frames, and the app refuses to promote a version that scores worse.",
    "How will it be able to solve the problem?||",
    "•  The model draws the outlines, so people review instead of drawing. Gemini points reviewers to the labels most likely to be wrong.",
    "•  Export, training, scoring and the retrain schedule run as managed jobs; the operator needs no ML engineer.",
    "USP of the proposed solution||",
    "•  A closed loop: the model that was just retrained labels the next video, so each round starts from better labels.",
    "•  Honest by design: no accuracy is shown unless it comes from frames a person checked.",
], size=10.5, gap=5)

# 5 - features
s = slide(14)
title(s, "List of features offered by the solution")
bullets(s, [
    "Video upload or browser camera recording; frames sampled, near-duplicates and blurry frames dropped",
    "Automatic labelling with Google's CircularNet as soon as frames are ready: outline, box, class, score",
    "Live camera view on the dashboard, labelled one frame every few seconds",
    "Review screen: accept, change class, delete, draw a missing box; MobileSAM outlines hand-drawn boxes",
    "Gold set: 30 person-checked frames, 10 of them a fixed exam no job may change",
    "Gemini 3.8 Flash label check with a capped number of calls per project",
    "Versioned COCO dataset export; CircularNet retraining as a Cloud Run job; PyTorch and ONNX downloads",
    "Scoring of every version on the same exam, promotion only if not worse, and a retrain schedule",
    "Estimate of human annotation minutes saved, with its assumption shown",
    "Starts with four classes (plastic, glass, metal, paper); a project can be created with any number of classes",
], size=10.5, gap=4)

# 6 - process flow
s = slide(14)
title(s, "Process flow diagram or Use-case diagram")
steps = [
    ("1  Capture", "Operator uploads video\nor records from a camera"),
    ("2  Frames", "Cloud Run job samples,\ndrops duplicates and blur"),
    ("3  Label", "CircularNet labels\nevery frame by itself"),
    ("4  Gold set", "A person checks 30 frames:\n20 examples + 10-frame exam"),
    ("5  Exam", "Current model is scored\non the 10 exam frames"),
    ("6  Gemini check", "Gemini flags wrong classes\nand missed objects"),
    ("7  Review", "A person clears the queue;\nMobileSAM outlines new boxes"),
    ("8  Dataset", "Checked labels exported\nas a numbered COCO dataset"),
    ("9  Retrain", "CircularNet fine-tuned\nas a Cloud Run job"),
    ("10  Score and promote", "Same exam; active only\nif not worse"),
]
bw, bh, gx, x0 = 122, 62, 12, 30
for i, (head, body) in enumerate(steps):
    row, col = divmod(i, 5)
    col = col if row == 0 else 4 - col  # second row runs right to left
    x, y = x0 + col * (bw + gx), 100 + row * 110
    node(s, x, y, bw, bh, head + "\n" + body, fill=RGBColor(0xFF, 0xF1, 0xE6) if i in (2, 5, 8) else PALE, size=8)
    if i in (0, 1, 2, 3):
        arrow(s, x + bw, y + bh / 2, x + bw + gx, y + bh / 2)
    if i in (5, 6, 7, 8):
        arrow(s, x, y + bh / 2, x - gx, y + bh / 2)
arrow(s, x0 + 4 * (bw + gx) + bw / 2, 162, x0 + 4 * (bw + gx) + bw / 2, 210)
text(s, 30, 290, 660, 60, [
    "The loop closes: the promoted version labels the next video (back to step 3). Cloud Scheduler can start step 8-10 on a set interval once enough new frames are checked.",
    "Orange boxes are the AI steps: Google's CircularNet (label and retrain) and Gemini (label check).",
], size=9.5, color=GREY)

# 7 - wireframes / mock
s = slide(14)
title(s, "Wireframes/Mock diagrams of the proposed solution")
for i, (name, cap) in enumerate([
    ("0chh3t", "Dashboard: belt view (live camera or labelled frame), material count, loop status"),
    ("4iyf11", "Project setup: classes, class mapping, add video or record from camera"),
    ("c63frd", "Annotation QA: six steps from class mapping to the review queue"),
    ("t2zg3h", "Train and export: score by version, train, datasets, retrain schedule"),
]):
    col, row = i % 2, i // 2
    x, y = 60 + col * 310, 84 + row * 155
    shot(s, name, x, y, 235)
    text(s, x, y + 135, 290, 20, cap, size=8.5, color=GREY)

# 8 - architecture
s = slide(14)
title(s, "Architecture diagram of the proposed solution")
node(s, 30, 150, 95, 60, "Browser\nReact app, camera,\nvideo upload", fill=RGBColor(0xE8, 0xF0, 0xFE))
node(s, 170, 95, 150, 70, "Cloud Run service\nFastAPI API + web app\n/predict: CircularNet on one frame", fill=RGBColor(0xE6, 0xF4, 0xEA))
node(s, 170, 200, 150, 62, "Cloud Run job: worker\nframes, CircularNet labelling,\nGemini check, dataset export", fill=RGBColor(0xE6, 0xF4, 0xEA))
node(s, 170, 290, 150, 62, "Cloud Run job: trainer\nCircularNet fine-tune (CPU),\nMobileSAM outlines, scoring", fill=RGBColor(0xE6, 0xF4, 0xEA))
node(s, 380, 95, 130, 55, "Firestore\nprojects, jobs, labels index,\nmodel versions", fill=RGBColor(0xFE, 0xF7, 0xE0))
node(s, 380, 175, 130, 62, "Cloud Storage\nvideo, frames, labels,\ndatasets, weights", fill=RGBColor(0xFE, 0xF7, 0xE0))
node(s, 380, 262, 130, 45, "Vertex AI\nGemini 3.8 Flash", fill=RGBColor(0xFF, 0xF1, 0xE6))
node(s, 380, 325, 130, 40, "Cloud Scheduler\nretrain tick, every 15 min", fill=RGBColor(0xFE, 0xF7, 0xE0))
node(s, 560, 95, 130, 55, "Cloud Build +\nArtifact Registry\ncontainer images", fill=PALE)
node(s, 560, 175, 130, 45, "Secret Manager\nfallback Gemini key (empty)", fill=PALE)
arrow(s, 125, 170, 170, 135)
arrow(s, 125, 190, 380, 205)
arrow(s, 320, 125, 380, 122)
arrow(s, 245, 165, 245, 200)
arrow(s, 245, 262, 245, 290)
arrow(s, 320, 225, 380, 210)
arrow(s, 320, 240, 380, 280)
arrow(s, 320, 315, 380, 225)
arrow(s, 380, 345, 320, 150)
text(s, 30, 232, 130, 60, "Video goes straight from the browser to Cloud Storage through a signed link.", size=8, color=GREY)
text(s, 540, 240, 160, 120, ["All in project region asia-south1 (Mumbai).", "The service scales to zero. Each job run is one container execution that receives only a project id and a job id.", "No GPU: labelling and training run on CPU."], size=8, color=GREY)

# 9 - technologies
s = slide(14)
title(s, "Technologies to be used in the solution")
text(s, 40, 92, 640, 290, [
    "Google Cloud||  Cloud Run (service and jobs), Cloud Storage, Firestore, Cloud Scheduler, Cloud Build, Artifact Registry, Secret Manager",
    "Google AI||  Gemini 3.8 Flash through Vertex AI for the label check; Google's CircularNet as the model that labels and is retrained",
    "Model and ML||  CircularNet is built on RF-DETR (Roboflow's architecture; library rfdetr 1.5.2). PyTorch on CPU for training, ONNX Runtime for labelling. MobileSAM, loaded through the Ultralytics library, outlines hand-drawn boxes. OpenCV for video frames",
    "Backend||  Python 3.12, FastAPI",
    "Frontend||  React 19, TypeScript, MUI, Vite",
    "Data formats||  COCO segmentation datasets; one label file per frame per round, never overwritten",
    "Development tools||  Claude Code as the coding assistant; gcloud CLI",
], size=10.5, gap=7)

# 10 - cost
s = slide(14)
title(s, "Estimated implementation cost (optional)")
text(s, 40, 90, 640, 40, "No bill has been reconciled yet, so no rupee figure is claimed. What drives the cost, with the run times measured on the prototype:", size=10.5)
table(s, 40, 128, 640, [150, 250, 240], [
    ["Cost driver", "What it uses", "Measured on the prototype"],
    ["Web app", "Cloud Run service, 2 vCPU / 2 GiB, scales to zero", "Billed only while requests are served"],
    ["Labelling job", "Cloud Run job, 4 vCPU / 4 GiB, CPU", "47 s for 43 frames"],
    ["Retraining job", "Cloud Run job, 8 vCPU / 16 GiB, CPU", "Under 3 minutes for one pass on 29 frames"],
    ["Gemini label check", "Gemini 3.8 Flash; capped at 2,000 calls per project", "About 3 calls per frame in an earlier run"],
    ["Storage and records", "Cloud Storage and Firestore", "Small at demo size: one clip, its frames and labels"],
], size=8.5, row_h=24)
bullets(s, [
    "No GPU and no always-on server are needed at this size.",
    "Next step: read the real figures from the Cloud Billing export after a full cycle and set a per-cycle budget.",
], y=290, size=10)

# 11 - snapshots
s = slide(14)
title(s, "Snapshots of the prototype")
shot(s, "0chh3t", 30, 86, 325)
shot(s, "c63frd", 365, 86, 325)
text(s, 30, 274, 325, 30, "Dashboard of the default project, retrainix-demo, as deployed (version 0.1)", size=9, color=GREY)
text(s, 365, 274, 325, 30, "Annotation QA: each of the six steps says what it is waiting for", size=9, color=GREY)
text(s, 30, 305, 660, 60, ["Live prototype: https://retrainix-111360744309.asia-south1.run.app", "[Team: add one snapshot of a labelled camera frame from your own demo session here before submitting.]"], size=9.5, color=ORANGE)

# 12 - performance
s = slide(14)
title(s, "Prototype Performance report/Benchmarking")
table(s, 40, 86, 640, [215, 235, 190], [
    ["What was run on the deployed prototype", "Result", "Where"],
    ["Upload of a 58 MB, 66-second test clip", "26 s, straight from the client to Cloud Storage", "Live site, 21 Nov 2026"],
    ["Frame extraction", "65 frames sampled, 43 kept, in 16 s", "Cloud Run worker job"],
    ["Automatic labelling with CircularNet", "0.8 s per frame; 47 s for the 43 frames", "Cloud Run worker job, CPU"],
    ["An uploaded clip labelled with no button", "Labelled 29 s after the upload finished", "Live site"],
    ["One camera frame labelled on request", "5.8 s for the first frame, then about 1.5 s each", "Cloud Run service, 2 vCPU"],
    ["MobileSAM outlines for hand-drawn boxes", "2 boxes in 11 s", "Cloud Run trainer job, CPU"],
    ["CircularNet retraining, one pass, 29 frames", "2.4 minutes of training; the version was scored and correctly not promoted", "Cloud Run trainer job, 8 vCPU"],
], size=8, row_h=23)
bullets(s, [
    "Annotation saved (estimate): outlines drawn by the model x an assumed 60 s to draw one by hand. The test run's 627 outlines come to about 10 hours at that assumption; review time is not subtracted.",
    "Not measured yet: model accuracy. It needs the gold set a person makes; scores from test data are not quoted here.",
], y=280, size=9.5, gap=4)

# 13 - future
s = slide(14)
title(s, "Additional Details/Future Development (if any)")
bullets(s, [
    "First: a person-made gold set and one full real cycle, so a true before-and-after score can be shown.",
    "Measure the saving properly: time hand labelling against review with and without Gemini on the same frames.",
    "More classes: a project can be created with any number of classes; adding classes to a running project comes next.",
    "Sign-in and per-customer storage before any customer data is used; today the prototype is open to anyone with the link.",
    "GPU training and larger datasets once quota is available; today training is CPU only.",
    "Per-class scores and a person's approval before a new version is promoted.",
    "Honest notes: CircularNet is Google's model built on Roboflow's RF-DETR; MobileSAM is loaded through the Ultralytics library.",
], size=10.5, gap=6)

# 14 - links
s = slide(14)
title(s, "Prototype links and status")
text(s, 40, 95, 640, 280, [
    "Live prototype||  https://retrainix-111360744309.asia-south1.run.app",
    "Version||  0.1 (tagged 21 Nov 2026), deployed on Google Cloud, region Mumbai",
    "Code repository||  [team to add]",
    "Demo video||  [team to add]",
    "",
    "Verified on the deployed prototype||  upload, frame extraction, CircularNet labelling, gold set, exam scoring, MobileSAM outlines, dataset export, CircularNet retraining, scoring and the promotion rule, labelling of a single camera frame",
    "Not yet done||  a person-made gold set, a Gemini label check in the current cloud project, a run with a real camera on the line",
], size=10.5, gap=7)

# 15 - thank you
slide(16)

prs.save(OUT)
print("saved", OUT, "slides:", len(prs.slides))
