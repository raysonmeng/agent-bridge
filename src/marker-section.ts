/**
 * Idempotent marker-based section injection for markdown files.
 *
 * Supports three cases:
 *   1. Empty/no content → return markers + section
 *   2. Content exists, no markers → append markers + section
 *   3. Content exists, markers present → replace between markers
 */

const MARKER_START = (id: string) => `<!-- ${id}:start -->`;
const MARKER_END = (id: string) => `<!-- ${id}:end -->`;

/**
 * Insert or replace a marked section in a markdown string.
 *
 * @param content  - Existing file content (empty string if file doesn't exist)
 * @param sectionId - Unique marker identifier (e.g. "AgentBridge")
 * @param section  - The new content to place between markers (no trailing newline needed)
 * @returns Updated content string
 */
export function upsertMarkedSection(
  content: string,
  sectionId: string,
  section: string,
): string {
  const startMarker = MARKER_START(sectionId);
  const endMarker = MARKER_END(sectionId);
  const block = `${startMarker}\n${section}\n${endMarker}`;

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  const hasStart = startIdx !== -1;
  const hasEnd = endIdx !== -1;

  // Case 3: well-formed marker pair → replace between them.
  if (hasStart && hasEnd && startIdx < endIdx) {
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + endMarker.length);
    return before + block + after;
  }

  // Malformed: one marker without its pair, or end marker before start. Refuse
  // to write — silently appending a second block would cause the next call to
  // splice out user content between the stray marker and the new block.
  if (hasStart || hasEnd) {
    throw new Error(
      `Malformed ${sectionId} markers in file (start=${startIdx}, end=${endIdx}). ` +
        `Please repair the file manually — remove the stray marker(s) or restore the pair.`,
    );
  }

  // Case 1: empty content → just the block
  if (content.trim() === "") {
    return block + "\n";
  }

  // Case 2: content exists but no markers → append
  const trimmed = content.endsWith("\n") ? content : content + "\n";
  return trimmed + "\n" + block + "\n";
}

/**
 * Remove a marked section (markers included) from a markdown string — the
 * inverse of upsertMarkedSection, used by `abg deinit`.
 *
 * Collapses the blank line upsert introduced around the block so that
 * upsert → remove round-trips an existing file back to (at most a trailing
 * newline of) its original shape. A file that contained ONLY the block
 * collapses to the empty string.
 *
 * @returns removed=false (content untouched) when no markers are present.
 * @throws on a malformed marker pair, mirroring upsertMarkedSection — a lone
 *         marker means we cannot know the block's true extent, and guessing
 *         could delete user content.
 */
export function removeMarkedSection(
  content: string,
  sectionId: string,
): { content: string; removed: boolean } {
  const startMarker = MARKER_START(sectionId);
  const endMarker = MARKER_END(sectionId);

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  const hasStart = startIdx !== -1;
  const hasEnd = endIdx !== -1;

  if (!hasStart && !hasEnd) {
    return { content, removed: false };
  }

  if (!(hasStart && hasEnd && startIdx < endIdx)) {
    throw new Error(
      `Malformed ${sectionId} markers in file (start=${startIdx}, end=${endIdx}). ` +
        `Please repair the file manually — remove the stray marker(s) or restore the pair.`,
    );
  }

  let before = content.slice(0, startIdx);
  let after = content.slice(endIdx + endMarker.length);

  // The whole file was just the block (case 1 of upsert) → empty string.
  if (before.trim() === "" && after.trim() === "") {
    return { content: "", removed: true };
  }

  // Collapse the separator blank line(s) upsert added: leave `before` ending in
  // a single newline, and drop the newline(s) that immediately followed the
  // end marker.
  before = before.replace(/\n+$/, "\n");
  after = after.replace(/^\n+/, "");
  if (after !== "" && !before.endsWith("\n") && before !== "") {
    before += "\n";
  }
  return { content: before + after, removed: true };
}
