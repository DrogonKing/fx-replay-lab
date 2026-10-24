---
description: اصلاح متن درهم‌ریخته فارسی/انگلیسی (bidi)
---

Repair scrambled mixed Persian/English text (bidi jumbling). The input is whatever the user supplied with this command: pasted text, a quoted block, or a workspace file path.

Steps:

1. If the argument is an existing file path, read that file; otherwise treat the argument (or the user's pasted text) as the input.
2. Rewrite the input applying the bidi rules of this plugin (see `hooks/bidi-rules.md`):
   - Wrap every Latin token — paths, commands, identifiers, versions, hyphen/slash-joined tokens — in backticks.
   - Persian punctuation for Persian sentences (`،` `؛` `؟`)؛ never ASCII commas or question marks in Persian prose.
   - Persian digits in Persian prose; ASCII digits only inside code spans.
   - Never start or end a Persian sentence with a bare Latin token; reorder so Persian words lead and the verb closes the sentence.
   - Reduce direction switches per line; split heavy weaving into an English technical line plus a Persian explanation.
3. Change ONLY direction, formatting, and punctuation — never wording, names, values, or meaning. Do not translate. Do not reverse or mirror text manually.
4. Deliver:
   - Pasted text: show the fixed text as a normal markdown paragraph (readable in chat), followed by a short bullet list of the change types applied.
   - Text destined for use OUTSIDE markdown (user says it is for Telegram, Word, etc.): also emit a plain-text version in a fenced block where Latin runs are guarded with U+200E/U+200F marks instead of backticks.
   - A file: apply the fixes with file edits, change nothing else, and report the changed spots as `file:line`.
