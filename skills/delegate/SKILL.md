---
name: delegate
description: >
  Ask Google Antigravity (agy, Gemini) for its view or hand it coding work through the
  agy-delegate-mcp delegate tool. Use when the user says ask Gemini or Antigravity what it
  thinks, get Gemini's view or a second opinion, delegate or hand off to agy, plan with
  Antigravity, resume an agy session, or diagnose agy delegation. Do not shell out to agy.
license: MIT
---

# Delegate to Antigravity

Call the agy-delegate-mcp `delegate` tool; never run `agy` from the shell.

## Write the brief

`spec` carries the whole task, inline:

- **Goal**: the outcome, precisely.
- **Scope**: the files and directories in play. Point at files to read or follow rather than
  pasting code; attach images and documents outside the repo with `contextFiles`.
- **Decisions**: what the user already settled, in their exact words.
- **Done when**: verifiable acceptance criteria, and the tests to run while it works. For `ask` and
  `plan`, the form and length of the answer.
- End by asking agy to report any criterion it could not meet and any assumption it made.

`workspace` is the smallest existing directory that holds the task's files.

## Ask and compare

`mode: "ask"` answers a question or gives a second opinion; `result` is the answer. To compare
models, send the same brief in parallel calls, one `model` per call or another plugin's
`delegate` tool, then set the answers side by side with your own view. Check the claims that
matter before relaying them.

## Hand off the work

- `agent` implements.
- `plan`: `plan.detail` is the plan and `result` is agy's note on it, often open questions.
  Present both, wait for approval, then resume the session in `agent` mode with
  `resumeSessionId` and a `spec` such as "implement the approved plan" plus any changes.
- `steer` redirects a turn that is still running. Once the turn has ended, resume instead.

Parallel runs that write need separate directories; otherwise run them one after another.

## After the run

1. Read the git diff after every run, whatever the mode, and run the tests yourself when files
   changed. `filesReportedByEditTools` misses files written by shell commands.
2. `effectiveModel` names the model agy ran when it differs from `model`, and always when
   `model` was omitted. `effectiveEffort` is the level in force; report it rather than calling
   it the default.
3. If a criterion fails on a sound approach, resume the same session with the specific
   failure. For a wrong approach, after two failed resumes, or when `context.used` nears
   `context.size`, start a new session with a rewritten brief. After a resume, an absent
   `resumed` means that run had no prior context: send the full brief on the returned
   `sessionId`.
4. Report what changed and which criteria pass.

A failure arrives as `delegate failed [reason]: …`. Fix `invalid-spec`, `invalid-workspace`,
`invalid-mode` and `unknown-model` rather than retrying; every other reason, and any unfamiliar
field, is explained in [reference.md](reference.md).
