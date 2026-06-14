import { describe, it, expect } from "vitest";
import { parseCommitHistory } from "@/lib/git-history";

// B001 regression: getCommitHistory's old line-by-line parser expected 7
// NUL-separated fields on one PHYSICAL line. Because the format embeds %b (the
// body, which contains newlines), any multi-line-body commit spilled across
// several lines, failed `parts.length < 7`, and was silently DROPPED.
//
// The fix frames each record with an RS sentinel (0x1e) so the whole output is
// split on record boundaries first, then on NUL into the 7 fields — embedded
// newlines in the body no longer break parsing.

const NUL = "\x00";
const RS = "\x1e";

// Build records exactly as `git log --format=…%x1e --shortstat` emits them on
// the wire (verified against real git via `od -c`):
//   - The format ends with the RS sentinel (%x1e); git appends a newline.
//   - A commit WITH file changes: --shortstat prints a blank line, then
//     " N files changed, …", then a newline →  <fields><RS>\n\n <stat>\n
//   - A commit with NO file changes (empty / merge commit): --shortstat prints
//     nothing — just the format's trailing newline →  <fields><RS>\n
// Records are concatenated directly (git emits no extra separator between them);
// each commit's shortstat therefore sits at the HEAD of the next RS segment,
// which is exactly the boundary parseCommitHistory has to disentangle.
function record(
  fields: {
    hash: string;
    short: string;
    subject: string;
    body: string;
    author: string;
    email: string;
    ts: number;
  },
  shortstat: string
): string {
  const f = [
    fields.hash,
    fields.short,
    fields.subject,
    fields.body,
    fields.author,
    fields.email,
    String(fields.ts),
  ].join(NUL);
  const hasStat = shortstat.trim() !== "";
  return hasStat ? `${f}${RS}\n\n${shortstat}\n` : `${f}${RS}\n`;
}

describe("B001 parseCommitHistory — multi-line bodies survive framing", () => {
  it("keeps a commit whose body spans multiple lines", () => {
    const multiLineBody =
      "This body has\nmultiple lines\n\nand a blank line in the middle.";
    const output =
      record(
        {
          hash: "a".repeat(40),
          short: "aaaaaaa",
          subject: "feat: multi-line body commit",
          body: multiLineBody,
          author: "Ada",
          email: "ada@example.com",
          ts: 1700000000,
        },
        " 3 files changed, 10 insertions(+), 5 deletions(-)"
      ) +
      record(
        {
          hash: "b".repeat(40),
          short: "bbbbbbb",
          subject: "fix: single-line body",
          body: "Just one line.",
          author: "Linus",
          email: "linus@example.com",
          ts: 1700000100,
        },
        " 1 file changed, 2 insertions(+)"
      );

    const commits = parseCommitHistory(output);

    // Old parser dropped the multi-line-body commit; both must survive now.
    expect(commits).toHaveLength(2);

    const [first, second] = commits;
    expect(first.hash).toBe("a".repeat(40));
    expect(first.subject).toBe("feat: multi-line body commit");
    expect(first.body).toBe(multiLineBody);
    expect(first.author).toBe("Ada");
    expect(first.authorEmail).toBe("ada@example.com");
    expect(first.timestamp).toBe(1700000000);
    expect(first.filesChanged).toBe(3);
    expect(first.additions).toBe(10);
    expect(first.deletions).toBe(5);

    expect(second.hash).toBe("b".repeat(40));
    expect(second.subject).toBe("fix: single-line body");
    expect(second.filesChanged).toBe(1);
    expect(second.additions).toBe(2);
    expect(second.deletions).toBe(0);
  });

  it("handles a commit with no shortstat (no file changes)", () => {
    const output = record(
      {
        hash: "c".repeat(40),
        short: "ccccccc",
        subject: "chore: empty commit",
        body: "",
        author: "Bob",
        email: "bob@example.com",
        ts: 1700000200,
      },
      ""
    );

    const commits = parseCommitHistory(output);
    expect(commits).toHaveLength(1);
    expect(commits[0].filesChanged).toBe(0);
    expect(commits[0].additions).toBe(0);
    expect(commits[0].deletions).toBe(0);
    expect(commits[0].body).toBe("");
  });

  it("attributes shortstats correctly across an empty/merge commit in the middle", () => {
    // The fragile branch: a zero-stat commit emits "<RS>\n<next-hash>" (no
    // leading shortstat at the head of the next segment), so the parser must
    // attach NO stats to it and still carry the previous/next commits' stats
    // to the right records. This reproduces the true byte layout git produces
    // for an empty or merge commit sandwiched between two changed commits.
    const output =
      record(
        {
          hash: "1".repeat(40),
          short: "1111111",
          subject: "feat: before",
          body: "first",
          author: "Ada",
          email: "ada@example.com",
          ts: 1700000000,
        },
        " 4 files changed, 40 insertions(+), 4 deletions(-)"
      ) +
      record(
        {
          hash: "2".repeat(40),
          short: "2222222",
          subject: "Merge branch 'feature'",
          body: "",
          author: "Bot",
          email: "bot@example.com",
          ts: 1700000100,
        },
        "" // merge/empty commit: no shortstat
      ) +
      record(
        {
          hash: "3".repeat(40),
          short: "3333333",
          subject: "fix: after",
          body: "third\nwith two lines",
          author: "Eve",
          email: "eve@example.com",
          ts: 1700000200,
        },
        " 1 file changed, 2 insertions(+), 1 deletion(-)"
      );

    const commits = parseCommitHistory(output);
    expect(commits).toHaveLength(3);

    const [before, merge, after] = commits;

    expect(before.subject).toBe("feat: before");
    expect(before.filesChanged).toBe(4);
    expect(before.additions).toBe(40);
    expect(before.deletions).toBe(4);

    // The empty/merge commit must carry zero stats — not the neighbours'.
    expect(merge.hash).toBe("2".repeat(40));
    expect(merge.subject).toBe("Merge branch 'feature'");
    expect(merge.filesChanged).toBe(0);
    expect(merge.additions).toBe(0);
    expect(merge.deletions).toBe(0);

    expect(after.hash).toBe("3".repeat(40));
    expect(after.subject).toBe("fix: after");
    expect(after.body).toBe("third\nwith two lines");
    expect(after.filesChanged).toBe(1);
    expect(after.additions).toBe(2);
    expect(after.deletions).toBe(1);
  });

  it("ignores trailing whitespace/blank tail after the last record", () => {
    const output =
      record(
        {
          hash: "d".repeat(40),
          short: "ddddddd",
          subject: "docs: update",
          body: "line one\nline two",
          author: "Eve",
          email: "eve@example.com",
          ts: 1700000300,
        },
        " 2 files changed, 4 insertions(+), 1 deletion(-)"
      ) + "\n\n";

    const commits = parseCommitHistory(output);
    expect(commits).toHaveLength(1);
    expect(commits[0].deletions).toBe(1);
    expect(commits[0].body).toBe("line one\nline two");
  });
});
