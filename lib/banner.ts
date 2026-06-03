// Stoa session initialization
// Writes an init script that shows the banner, configures tmux, then runs the agent

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Generate the bash init script that shows the Stoa banner, configures the tmux
 * status bar, then execs the agent.
 *
 * SINGLE SOURCE OF TRUTH for the session banner. Both the tmux interactive path
 * (app/api/sessions/init-script) and orchestration workers (wrapWithBanner) call
 * this — previously each had its own copy and the rebrand updated only one, so
 * tmux sessions kept printing the old "AgentOS" figlet. Keep the art here only.
 */
export function generateInitScript(agentCommand: string): string {
  return `#!/bin/bash
# Stoa Session Init Script
# Auto-generated - do not edit manually

# ANSI Colors (purple theme)
C_RESET=$'\\033[0m'
C_PURPLE=$'\\033[38;5;141m'
C_PURPLE2=$'\\033[38;5;177m'
C_PINK=$'\\033[38;5;213m'
C_MUTED=$'\\033[38;5;245m'

# Configure tmux status bar
tmux set-option status-style 'bg=#1e1e2e,fg=#cdd6f4' 2>/dev/null
tmux set-option status-left '#[fg=#cba6f7,bold] Stoa #[fg=#6c7086]| ' 2>/dev/null
tmux set-option status-left-length 20 2>/dev/null
tmux set-option status-right '#[fg=#6c7086]| #[fg=#89b4fa]#S #[fg=#6c7086]| #[fg=#a6adc8]%H:%M ' 2>/dev/null
tmux set-option status-right-length 40 2>/dev/null
tmux set-option status-position bottom 2>/dev/null

# Clear and show banner
clear

# Banner — "Stoa" (figlet standard). The art is passed as a single-quoted %s arg
# so backslashes / backticks stay literal and don't get reinterpreted by bash.
printf "\\n"
printf '%s%s%s\\n' "\${C_PURPLE}" '      ____  _' "\${C_RESET}"
printf '%s%s%s\\n' "\${C_PURPLE}" '     / ___|| |_ ___   __ _' "\${C_RESET}"
printf '%s%s%s\\n' "\${C_PURPLE2}" '     \\___ \\| __/ _ \\ / _\` |' "\${C_RESET}"
printf '%s%s%s\\n' "\${C_PURPLE2}" '      ___) | || (_) | (_| |' "\${C_RESET}"
printf '%s%s%s\\n' "\${C_PINK}" '     |____/ \\__\\___/ \\__,_|' "\${C_RESET}"
printf "\\n"
printf "\${C_MUTED}         AI Coding Session Manager\${C_RESET}\\n"
printf "\\n"

# Brief pause to show banner
sleep 0.8

# Ensure ~/.local/bin is in PATH (where claude is installed)
export PATH="$HOME/.local/bin:$PATH"

# If running as root, set IS_SANDBOX=1 so Claude Code allows --dangerously-skip-permissions
if [ "$(id -u)" = "0" ]; then
  export IS_SANDBOX=1
fi

# Start the agent
exec ${agentCommand}
`;
}

/**
 * Write the init script to a temp file. Returns its path and the command that
 * runs it (`bash <path>`).
 */
export function writeInitScript(agentCommand: string): {
  scriptPath: string;
  command: string;
} {
  const scriptContent = generateInitScript(agentCommand);
  const scriptPath = path.join(os.tmpdir(), `stoa-init-${Date.now()}.sh`);
  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
  return { scriptPath, command: `bash ${scriptPath}` };
}

/**
 * Write the init script and return just the command to run it.
 */
export function wrapWithBanner(agentCommand: string): string {
  return writeInitScript(agentCommand).command;
}

/**
 * Returns just the banner string (for display elsewhere)
 */
export function getBanner(): string {
  return `
      ____  _
     / ___|| |_ ___   __ _
     \\___ \\| __/ _ \\ / _\` |
      ___) | || (_) | (_| |
     |____/ \\__\\___/ \\__,_|

         AI Coding Session Manager
`;
}
