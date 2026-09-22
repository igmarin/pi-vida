# jev-json — Jev call archive

## Purpose

Audit trail of **real Jev API calls** that drive decisions for pi-vida work.
Every request body is saved verbatim **before** sending; every response body
is saved verbatim as returned. Analysis lives in `docs/decisions.md` (and
`docs/question-audit.md` for question framing); this directory holds only
raw evidence.

## File naming

- `NNN-slug.request.json` — exact body POSTed to `https://api.typesafe.ai/v1/systemone`
- `NNN-slug.response.json` — exact JSON response received

Numbering starts at `001`. `000` is reserved for the connectivity smoke test.
Numbers are never reused; a re-asked question gets a new number.

## How calls are made

`TYPESAFE_AI_KEY` is exported in `~/.zshrc`; non-interactive shells don't
inherit it, so calls run via `zsh -ic 'curl ...'`. The key is never printed,
committed, or stored in this repo.

## Privacy

Saved state must stay **anonymized aggregates**: no names, exact dates,
identifiers, free text about people, or secrets — in request files or
anywhere else in this archive.
