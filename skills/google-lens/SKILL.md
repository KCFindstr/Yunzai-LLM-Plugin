---
name: google-lens
description: Reverse-image search an attached or quoted image with Google Lens to identify characters, stickers, artwork, objects or their sources. Uploads the actual image and returns visual-match evidence directly to you.
---

Call `google_lens(image_index=1)` directly. Select the relevant current/quoted image by its 1-based position when several are present. The tool snapshots the original bytes and uploads the file through Google Images/Lens in the existing VM browser, reusing its Google sign-in. You do not need a local path. Do not delegate this workflow to `agy` or `computer_task`.

Use the returned public visual-match links to check the candidate against the original image. Read useful source pages with your web tools; prefer original/official sources where available. Compare distinctive visual details and names before answering. A match title alone may be wrong. Cite supporting source URLs and state uncertainty when results disagree.

If the image is absent, ask the user to attach it or quote the original. Do not reconstruct an image from a historical placeholder. Upload only the image relevant to the requested lookup. Browser account details, cookies, local paths and personal data are never part of the answer.

If Google requires verification, tell the user the search was blocked and that they can complete verification in the VM browser through RustDesk before retrying. Do not claim a keyword search or a failed upload was a reverse-image search. Report actual findings in your normal voice without mentioning internal jobs or another agent.

The result can also contain `description` (displayed Google result-page description) and `ai_overview` (explicitly labeled Google-generated summary with source links). Either is null when absent or not detected. Do not invent missing descriptions or treat Google AI text as verified fact. Compare it with the original image and source pages; keep it distinct from visual-match titles.
