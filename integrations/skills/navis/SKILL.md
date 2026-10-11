---
name: navis
description: Use an installed Navis CLI to connect a project, recover project context, obtain Equip, submit candidate Returns, and synchronize session observations. Use when a user asks to work with Navis or a project already has navis.toml.
---

# Navis project collaboration

Navis stores durable project authority separately from an Agent session. Use the installed CLI from the consuming project's working directory. The installed copy's command is recorded below; a source copy without that section requires an existing `navis` executable or installation through `pnpm instance install-skill` in the Navis checkout.

## Connection and context

1. Run `navis status` to check the selected Bridge profile. If it is unconfigured, use the operator-provided instance URL and the Agent's private credential file with `navis configure --remote <url> --credential-file <file>`. Never print or copy the credential into a project file. The provider model key belongs to the server and is not a Navis credential.
2. Run `navis hook` in the project. It discovers `navis.toml` in the current directory or its ancestors and verifies membership. A bound result includes `project_id`, `change_marker` and a context summary. A stale result is cached context, not current permission or state. An unbound result is not a successful connection.
3. Read `navis state` for the complete projection, grants, business `state_version` and independent `ledger_seq`. Use `navis history --types session --limit 20` for recorded session observations. Follow returned opaque cursors when another page is needed.

If no declaration exists, first determine whether the project already exists with `navis projects`. Bind an existing project only with a verified ID and the intended remote. If the user wants a new project, `navis init --name 'Project name'` creates it and writes its declaration; it refuses to overwrite one. Membership still requires a grant from an authorized member. Creating a project does not give an Agent human authority or permission to create Work.

Do not select a human profile to work around a denied operation. `NAVIS_HOME` selects local credentials and state; it does not change server policy. Human review, Work creation and other human-only decisions require the responsible human's action.

## Work, Equip and Return

Read the available Work and current version before writing. If no appropriate Work exists, report the needed human decision. Save command JSON to a temporary UTF-8 file and use `navis command --file <file> --request-id <stable-key>`. Keep temporary request files out of the consuming repository's tracked content.

For an authorized Work, obtain Equip:

```json
{ "type": "equip.issue", "work_id": "<work-id>", "expected_version": 0 }
```

Replace the example version with the current `state_version`. Read the returned Equip and its constraints before execution. A successful command returns `result`; an accepted value is in `result.value`. Check the actual outcome rather than assuming every response accepted the command. After doing the authorized work, submit reviewable candidate material:

```json
{
  "type": "return.submit",
  "equip_id": "<equip-id>",
  "expected_version": 0,
  "candidates": [
    {
      "kind": "artifact",
      "content": {
        "storage": "inline",
        "media_type": "text/plain",
        "text": "Describe the result, evidence, and remaining limitations."
      }
    }
  ]
}
```

Use IDs returned by Navis. A Return is candidate material; it does not accept an asset, deliver it, confirm an outcome, or execute an external effect. Report what needs human review. Never infer acceptance from a completed tool call or a model response.

Reuse a request key only for an identical retry after a lost response. On a stale-version or policy rejection, reread state and reconsider the command; do not blindly repeat it with a new key. Do not overwrite an existing project's binding to fix an authorization error.

## Observations and model assistance

For an explicitly selected session observation, save a step such as `{"kind":"user.message","body":"Source text"}` and call `navis capture --file <file> --session <session-label>`. For retryable capture, choose a UUIDv7 `--request-id` before the first attempt and reuse it only for that same step. Capture defaults to metadata; `--local-only` restricts transfer further. Raw transcript upload is not provided by this profile. Explicit Return content and assistance prompts are separate operations and may transmit their supplied text.

Run `navis sync`, then check `navis status`. A paused transfer or pending Outbox record is not acknowledged data. Keep the records, diagnose the reported condition, and resume only when the cause is addressed. Do not delete the Outbox or change credentials to conceal failure.

An explicit model request uses `navis assist --file <file> --request-id <stable-key>` with `{"prompt":"...","expected_version":0}` and the current version. Poll `navis assist-status --job <returned-job-id>` with a bounded wait. The output remains a candidate. A local-only project refuses external model assistance.

## Integration boundary

This skill guides explicit CLI operations. It does not install an automatic session hook, capture every conversation, provide an MCP server, or replace the external coding tool. `navis hook` is a callable session-start operation; automatic invocation requires that tool's own configured adapter. Report actual binding, command, capture and review outcomes separately.
