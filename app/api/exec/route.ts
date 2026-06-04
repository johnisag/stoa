import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { isWindows, defaultInteractiveShell } from "@/lib/platform";

const execAsync = promisify(exec);

// Max execution time (10 seconds)
const TIMEOUT = 10000;

export async function POST(request: NextRequest) {
  // Off by default: this runs ARBITRARY shell commands. It has no in-app callers
  // and is a remote-code-execution surface, so it stays disabled unless the
  // operator explicitly opts in with STOA_ENABLE_EXEC=1.
  if (process.env.STOA_ENABLE_EXEC !== "1") {
    return NextResponse.json(
      {
        error:
          "The /api/exec endpoint is disabled. Set STOA_ENABLE_EXEC=1 to enable it.",
      },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const { command } = body;

    if (!command) {
      return NextResponse.json(
        { error: "No command specified" },
        { status: 400 }
      );
    }

    const startTime = Date.now();

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: TIMEOUT,
        // On Windows use the platform default shell; on POSIX keep zsh.
        shell: isWindows ? defaultInteractiveShell() : "/bin/zsh",
        // On Windows inherit the full process env (don't strip PATH/SystemRoot);
        // on POSIX prepend the Homebrew paths as before.
        env: isWindows
          ? process.env
          : {
              ...process.env,
              PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}`,
              HOME: process.env.HOME,
            },
      });

      const duration = Date.now() - startTime;

      return NextResponse.json({
        success: true,
        output: stdout || stderr,
        duration,
      });
    } catch (execError: unknown) {
      const duration = Date.now() - startTime;
      const error = execError as {
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      return NextResponse.json({
        success: false,
        output:
          error.stderr || error.stdout || error.message || "Unknown error",
        duration,
      });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
