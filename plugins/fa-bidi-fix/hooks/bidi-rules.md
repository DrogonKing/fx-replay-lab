# Bidi-safe Persian writing rules — fa-bidi-fix

Audience: the assistant. Apply to every response that contains Persian (or other RTL) text mixed with Latin text, including short replies, summaries, and handoffs. Skip when the response is entirely English. Goal: mixed text must render unscrambled in LTR-oriented markdown renderers. To adjust these rules, edit `hooks/bidi-rules.md` in the fa-bidi-fix plugin.

## Rules

1. **Isolate every Latin token in inline code (backticks).** File paths, commands, identifiers, flags, package names, error strings, versions, URLs, and hyphen/slash-joined tokens (`node-gyp`, `C:\Users`, `2026-10-24`) are directionally fragile in RTL context. Backticks create a clean LTR island and stop neighboring Persian punctuation from jumping to the wrong side. Example: فایل `package.json` را ویرایش کن.
2. **Never end a Persian sentence with a bare Latin token.** Persian is verb-final — end sentences with the Persian verb, so sentence punctuation sits safely in the RTL run. If a Latin token must lead a sentence, wrap it in backticks and keep the surrounding punctuation Persian.
3. **Persian punctuation inside Persian sentences**: use `،` `؛` `؟` and never ASCII `,` `;` `?` in Persian prose. ASCII punctuation is allowed only inside code spans or in fully-English sentences.
4. **Digits**: Persian prose uses Persian digits (۱۴۰۵، ۵۰٪). Code spans, measurements, and technical values use ASCII digits (`3.5`, `v0.1.0`). Never mix digit systems in one run; a range like `10-20` in prose becomes «۱۰ تا ۲۰» or goes into backticks.
5. **Parentheses and quotes**: Latin content inside Persian parentheses gets backticks — (نسخهٔ `2.0`). Avoid nesting Persian inside Latin inside Persian within a single run.
6. **Minimize direction switches**: at most 2–3 per line. When a sentence weaves English and Persian word-by-word, restructure: state the technical part in English (or a code block) first, then give the Persian explanation — not token-by-token mixing.
7. **Headings and tables**: keep each heading in one language; if mixed, wrap the Latin part in backticks. Keep table keys and column headers English; Persian belongs in value cells.
8. **Code blocks, file contents, and anything meant for copy-paste: never insert bidi control characters** (LRM/RLM) — they corrupt silently. In prose, prefer the structural fixes above; insert U+200F (RLM) after a bare Latin run only as a last resort when backticks are impossible.
9. **Write logical order — never manually reverse, mirror, or reorder text** to "fix" display. The structural rules handle rendering.
