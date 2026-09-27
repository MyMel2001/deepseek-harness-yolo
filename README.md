# dsh-plugin-yolo

"YOLO mode" plugin and agent preset for DeepSeek Harness.

## Features
- **Auto-accepts all actions**: Intercepts `approval/request` and `user-questions/request` (including plan reviews and user questions) to approve and answer automatically.
- **Auto-continues on any failure**: Detects tool exit code failures, tool errors, turn failures, and model step errors; automatically dispatches a `"continue"` user message to wake the agent.
- **Full Standard mode parity**: Inherits file editing, shell (`pwsh`/`bash`), background jobs, web search, skills, goals, subagents, and workflows.

## Distribution & Installation

### Distributable package
- `dsh-plugin-yolo-1.0.0.tgz`

### Install into DeepSeek Harness
Run from any PowerShell/terminal:
```sh
dsh plugin --profile web add ./dsh-plugin-yolo-1.0.0.tgz
```

### Usage
1. In Web GUI (`http://127.0.0.1:3080`), open preset dropdown and select **YOLO mode**.
2. Or use `/yolo` command to toggle YOLO mode in the active session.
3. Or set `DSH_YOLO=1` environment variable for global YOLO behavior across all sessions.
