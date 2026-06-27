import { NextRequest, NextResponse } from "next/server";
import {
  supportedSkillProviders,
  listSkills,
  getSkill,
  writeSkill,
  deleteSkill,
  SkillValidationError,
} from "@/lib/skills";

// Skills → native per-provider slash commands (#8). Author a command and Stoa
// writes it into the provider's native command directory (~/.claude/commands/...)
// so it becomes a real `/<name>` in that provider's TUI.
//
// GET  /api/skills                            → providers that support commands
// GET  /api/skills?provider=claude            → that provider's commands (list)
// GET  /api/skills?provider=claude&name=foo   → one command's full body (404 else)
// POST /api/skills { provider,name,description?,body } → create/overwrite
// DELETE /api/skills?provider=claude&name=foo → remove

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request: NextRequest) {
  try {
    const provider = request.nextUrl.searchParams.get("provider");
    if (!provider) {
      return NextResponse.json({ providers: supportedSkillProviders() });
    }
    const name = request.nextUrl.searchParams.get("name");
    if (name != null) {
      const skill = getSkill(provider, name);
      if (!skill) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      return NextResponse.json({ skill });
    }
    return NextResponse.json({ skills: listSkills(provider) });
  } catch (error) {
    if (error instanceof SkillValidationError) return badRequest(error.message);
    console.error("skills GET failed:", error);
    return NextResponse.json(
      { error: "Failed to read commands" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  try {
    const {
      provider,
      name,
      description,
      body: text,
    } = (body ?? {}) as {
      provider?: unknown;
      name?: unknown;
      description?: unknown;
      body?: unknown;
    };
    const skill = writeSkill({ provider, name, description, body: text });
    return NextResponse.json({ skill }, { status: 201 });
  } catch (error) {
    if (error instanceof SkillValidationError) return badRequest(error.message);
    console.error("skills POST failed:", error);
    return NextResponse.json(
      { error: "Failed to save command" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const provider = request.nextUrl.searchParams.get("provider");
    const name = request.nextUrl.searchParams.get("name");
    return NextResponse.json({ removed: deleteSkill(provider, name) });
  } catch (error) {
    if (error instanceof SkillValidationError) return badRequest(error.message);
    console.error("skills DELETE failed:", error);
    return NextResponse.json(
      { error: "Failed to delete command" },
      { status: 500 }
    );
  }
}
