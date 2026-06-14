import { execFileSync } from "child_process";
import { expandPath } from "./git-status";

export interface CommitSummary {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  timestamp: number;
  relativeTime: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface CommitFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

export interface CommitDetail extends CommitSummary {
  files: CommitFile[];
}

/**
 * Get relative time string from timestamp
 */
function getRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp * 1000;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (months > 0) return `${months}mo ago`;
  if (weeks > 0) return `${weeks}w ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

// Field separator (NUL) splits the 7 fields inside one record; the record
// separator (ASCII RS, 0x1e) frames each commit so an embedded newline in the
// commit body never confuses record boundaries.
const FIELD_SEP = "\x00";
const RECORD_SEP = "\x1e";

// %H<NUL>%h<NUL>%s<NUL>%b<NUL>%an<NUL>%ae<NUL>%at then a record-separator so the
// whole `git log` output can be split on RS first, then on NUL into 7 fields.
// `git log --shortstat` emits the shortstat line(s) AFTER the format expansion,
// i.e. just after the RS, so a commit's shortstat lands at the head of the next
// RS-delimited segment (and the last commit's shortstat is the final segment).
const HISTORY_FORMAT = "%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%at%x1e";

/**
 * Pull the file/insertion/deletion counts out of a --shortstat fragment such as
 * "3 files changed, 10 insertions(+), 5 deletions(-)" (any field may be absent).
 */
function parseShortstat(text: string): {
  filesChanged: number;
  additions: number;
  deletions: number;
} {
  const filesMatch = text.match(/(\d+) files? changed/);
  const addMatch = text.match(/(\d+) insertions?\(\+\)/);
  const delMatch = text.match(/(\d+) deletions?\(-\)/);
  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    additions: addMatch ? parseInt(addMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
  };
}

/**
 * Parse the raw `git log --format=… --shortstat` output into commit summaries.
 *
 * Records are framed by RECORD_SEP (0x1e) so a multi-line commit body never
 * breaks record boundaries. Because --shortstat prints after the format, a
 * commit's shortstat sits at the front of the *next* RS segment; we therefore
 * carry the field block of one record and attach the shortstat that follows it.
 *
 * git permits arbitrary control bytes in a commit message, so a body (%b) may
 * itself contain a literal RS. That splits one logical record across several
 * `output.split(RECORD_SEP)` segments, leaving a short field block (< 7 fields)
 * whose tail is the continuation of the SAME record's body. We re-join those
 * continuation segments — restoring the RS the split consumed — until the record
 * has its full 7 fields. The 7th field (%at) is a unix-timestamp of digits, a
 * reliable end-of-record marker that an embedded body byte cannot fake.
 *
 * Pure and side-effect free so it can be unit-tested with a fixture.
 */
export function parseCommitHistory(output: string): CommitSummary[] {
  const commits: CommitSummary[] = [];
  const segments = output.split(RECORD_SEP);

  // Pending field block whose shortstat appears at the head of the next segment.
  let pendingFields: string[] | null = null;

  // A record whose body contained an RS: its field block is still incomplete
  // (< 7 fields) and the next segment(s) continue its body. We restore the RS
  // that split() removed and keep accumulating until 7 fields are present.
  let partialFields: string[] | null = null;

  const flush = (shortstatText: string) => {
    if (!pendingFields) return;
    const [hash, shortHash, subject, body, author, authorEmail, timestampStr] =
      pendingFields;
    const timestamp = parseInt(timestampStr, 10);
    const { filesChanged, additions, deletions } =
      parseShortstat(shortstatText);
    commits.push({
      hash,
      shortHash,
      subject,
      body: body.trim(),
      author,
      authorEmail,
      timestamp,
      relativeTime: getRelativeTime(timestamp),
      filesChanged,
      additions,
      deletions,
    });
    pendingFields = null;
  };

  for (const segment of segments) {
    if (partialFields) {
      // We are mid-record: the previous segment ended inside the body because
      // it held a literal RS. Re-join this segment onto the unfinished field
      // (restoring the RS that split() consumed), then keep appending any
      // further NUL-delimited fields this segment carries.
      const extra = segment.split(FIELD_SEP);
      partialFields[partialFields.length - 1] += RECORD_SEP + extra[0];
      for (let i = 1; i < extra.length; i++) partialFields.push(extra[i]);

      if (
        partialFields.length < 7 ||
        !/^\d+$/.test(partialFields[partialFields.length - 1])
      ) {
        // Still inside the body (not yet 7 fields, or the would-be %at field is
        // not an all-digit timestamp → another RS landed in the body).
        continue;
      }
      pendingFields = partialFields;
      partialFields = null;
      continue;
    }

    const nulIdx = segment.indexOf(FIELD_SEP);
    if (nulIdx === -1) {
      // No field block: this whole segment is the trailing shortstat for the
      // previously buffered commit (e.g. the final commit's stats).
      flush(segment);
      continue;
    }

    // The head of the segment (everything before the first NUL) is
    // "<previous commit's shortstat>\n<this commit's hash>". The hash never
    // contains a newline, so the boundary is the last newline before that NUL;
    // anything after it is the hash, anything before it is the prior shortstat.
    const head = segment.slice(0, nulIdx);
    const lastNl = head.lastIndexOf("\n");
    const leadingShortstat = lastNl === -1 ? "" : head.slice(0, lastNl);
    const hash = lastNl === -1 ? head : head.slice(lastNl + 1);

    flush(leadingShortstat);

    const fields = [hash, ...segment.slice(nulIdx + 1).split(FIELD_SEP)];
    if (fields.length < 7) {
      // Record's body held a literal RS; it continues in the next segment(s).
      partialFields = fields;
      continue;
    }
    pendingFields = fields;
  }

  // Last buffered commit had no following shortstat segment.
  flush("");

  return commits;
}

/**
 * Get commit history
 */
export function getCommitHistory(
  workingDir: string,
  limit: number = 30
): CommitSummary[] {
  const cwd = expandPath(workingDir);

  try {
    const output = execFileSync(
      "git",
      ["log", `--format=${HISTORY_FORMAT}`, "-n", String(limit), "--shortstat"],
      { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, windowsHide: true }
    );

    return parseCommitHistory(output);
  } catch (error) {
    console.error("Failed to get commit history:", error);
    return [];
  }
}

/**
 * Get detailed commit info including files changed
 */
export function getCommitDetail(
  workingDir: string,
  commitHash: string
): CommitDetail | null {
  const cwd = expandPath(workingDir);

  try {
    // Get commit info
    const format = "%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%at";
    const infoOutput = execFileSync(
      "git",
      ["show", `--format=${format}`, "-s", commitHash],
      {
        cwd,
        encoding: "utf-8",
        windowsHide: true,
      }
    ).trim();

    const parts = infoOutput.split("\x00");
    if (parts.length < 7) return null;

    const [hash, shortHash, subject, body, author, authorEmail, timestampStr] =
      parts;
    const timestamp = parseInt(timestampStr, 10);

    // Get file stats using numstat
    const statOutput = execFileSync(
      "git",
      ["show", "--numstat", "--format=", commitHash],
      { cwd, encoding: "utf-8", windowsHide: true }
    );

    // Get name-status for detecting renames
    const nameStatusOutput = execFileSync(
      "git",
      ["show", "--name-status", "--format=", commitHash],
      { cwd, encoding: "utf-8", windowsHide: true }
    );

    const files: CommitFile[] = [];
    const statLines = statOutput.trim().split("\n").filter(Boolean);
    const nameStatusLines = nameStatusOutput.trim().split("\n").filter(Boolean);

    // Build a map of path -> status from name-status
    const statusMap = new Map<string, { status: string; oldPath?: string }>();
    for (const line of nameStatusLines) {
      const match = line.match(/^([AMDRC])\d*\t(.+?)(?:\t(.+))?$/);
      if (match) {
        const [, status, path1, path2] = match;
        const finalPath = path2 || path1;
        statusMap.set(finalPath, {
          status,
          oldPath: path2 ? path1 : undefined,
        });
      }
    }

    // Parse numstat for additions/deletions
    for (const line of statLines) {
      const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (match) {
        const [, addStr, delStr, path] = match;
        const additions = addStr === "-" ? 0 : parseInt(addStr, 10);
        const deletions = delStr === "-" ? 0 : parseInt(delStr, 10);

        const statusInfo = statusMap.get(path);
        let status: CommitFile["status"] = "modified";
        if (statusInfo) {
          switch (statusInfo.status) {
            case "A":
              status = "added";
              break;
            case "D":
              status = "deleted";
              break;
            case "R":
              status = "renamed";
              break;
            default:
              status = "modified";
          }
        }

        files.push({
          path,
          oldPath: statusInfo?.oldPath,
          status,
          additions,
          deletions,
        });
      }
    }

    // Get total stats
    let totalFilesChanged = files.length;
    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const file of files) {
      totalAdditions += file.additions;
      totalDeletions += file.deletions;
    }

    return {
      hash,
      shortHash,
      subject,
      body: body.trim(),
      author,
      authorEmail,
      timestamp,
      relativeTime: getRelativeTime(timestamp),
      filesChanged: totalFilesChanged,
      additions: totalAdditions,
      deletions: totalDeletions,
      files,
    };
  } catch (error) {
    console.error("Failed to get commit detail:", error);
    return null;
  }
}

/**
 * Get diff for a specific file in a commit
 */
export function getCommitFileDiff(
  workingDir: string,
  commitHash: string,
  filePath: string
): string {
  const cwd = expandPath(workingDir);

  try {
    // Get diff for the specific file in this commit
    // Use -m to handle merge commits (shows diff against first parent)
    const diff = execFileSync(
      "git",
      ["show", "-m", "--first-parent", commitHash, "--", filePath],
      { cwd, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, windowsHide: true }
    );
    return diff;
  } catch (error) {
    console.error("Failed to get commit file diff:", error);
    return "";
  }
}
