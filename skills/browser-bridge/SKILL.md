---
name: agent-browser-bridge
description: Route trusted local automation between APIs/files, a verified dedicated Edge/Chrome CDP bridge, and a guarded agent-desktop client. Always use the single canonical entry node cli/agent.cjs (or lib/automation); default to read-only cooperative operation.
---

# Agent Browser Bridge

## Single canonical entry (never call legacy interfaces)

Read `AGENTS.md` and `docs/automation.md`. Always start with `node cli/agent.cjs` (`npm run agent -- ...`) or `require('./lib/automation')`:

- **Do NOT** call legacy PowerShell helpers (`invokeNamedButton`, `focusNamedWindow`, `sendKeysToNamedWindow`, `captureNamedWindow` — blocked at runtime with `LEGACY_INTERFACE_DISABLED`).
- **Do NOT** call `node cli/abb.cjs` or `node cli/run.cjs` for general browser/workflow tasks (use `node cli/agent.cjs browser ...` and `node cli/agent.cjs run --file ...`).
- **Do NOT** spawn separate `agent-desktop` CLI processes per message or keystroke when refs or target bounds are known — use `desktop deliver --stdin` or `desktop batch --stdin`.

```powershell
node cli/agent.cjs --help
node cli/agent.cjs doctor
node cli/agent.cjs browser scenes
node cli/agent.cjs --scene smoke browser snap --open-url https://example.com
node cli/agent.cjs --write --scene smoke browser hover-click ".todo-list li" "button.destroy"
node cli/agent.cjs desktop capabilities --app notepad.exe
node cli/agent.cjs --write --mode exclusive desktop ensure-ready --app notepad.exe
node cli/agent.cjs --write desktop deliver --stdin
node cli/agent.cjs --write --mode exclusive desktop batch --stdin
node cli/agent.cjs run --file .\reviewed-workflow.cjs
```

## Policy, capabilities, and batching

1. Defaults are `readOnly: true` and `mode: 'cooperative'`. `--write` permits supported semantic mutations; known foreground commands (`adType`, `adPress`, pointer input, `restore`, `focus-window`, `screenshot`, `clipboard-set`, `launch`/`close-app`) additionally require `--mode exclusive`.
2. Every `desktop.ad*` method returns a Promise — always `await` it.
3. Before operating an unfamiliar or minimized desktop window, call `desktop capabilities` or `desktop ensure-ready` (`scenes.ensureWindowReady`). When `mode === 'custom_ui_visual'` (zero client UIA controls or caption-only buttons), switch directly to controlled exclusive visual mode (`deliverMessagesVerified` or `adBatch`) instead of repeatedly polling `find` or `snapshot`.
4. Browser `pressKey` (`Enter`/`Tab`/`Escape`), `hover`, and atomic single-lock `hoverAndClick(hoverSelector, clickSelector, guard)` run over CDP on the leased tab in writable cooperative mode without stealing OS focus.
5. Keep refs distinct: browser `@e1` (`e1`) and snapshot-qualified desktop `'@s8f3k2p9:e1'` are never interchangeable. Quote `'@s8f3k2p9:e1'` in PowerShell.
6. Every workflow step requires `step(name, action, verify)` where `verify` returns `true`. Preserve `disposition`; never auto-retry `unknown`, `uncertain`, or `delivered_unverified` actions.

## Dedicated browser & credential rules

1. Default to a dedicated debug window via `lib/profile/Start-DebugBrowser.ps1` under `%LOCALAPPDATA%\AgentBrowserBridge\profiles`. Never attach the daily default browser unless the user explicitly asks again; never close business tabs or user browsers automatically.
2. Look up credentials in the local Obsidian `密码簿.md` when authorized; pass secrets via `--stdin` or `--env VAR`, never on `argv` or in logs/commits.
3. `npm test` runs headless unit/contract checks; `npm run smoke:workflow` runs isolated cooperative browser + desktop smoke without physical input. Report fixture tests and real-application runs separately.
