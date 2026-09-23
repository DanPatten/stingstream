/**
 * The name a download client form shows when its type is picked.
 *
 * The name is the client's identity in both managers and must be unique, but almost everybody calls
 * theirs after what it is. So picking a type fills the name in, and picking another type changes
 * it again, for as long as the name is still one the form wrote. A name the reader typed is theirs
 * and is never replaced.
 *
 * "One the form wrote" is recognised by its shape, a type's label with an optional number, rather
 * than by tracking keystrokes, so it also holds for a client opened for editing: one still called
 * "qBittorrent" follows its type, one called "Seedbox" does not.
 */

/**
 * A free name for a type: its label, or its label with the first number not already taken.
 *
 * @param label the type's label, e.g. "qBittorrent".
 * @param taken names already in use by other clients, compared case-insensitively.
 */
export function suggestClientName(
  label: string,
  taken: readonly string[],
): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  if (!used.has(label.toLowerCase())) return label;
  for (let n = 2; ; n++) {
    const candidate = `${label} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** Whether `name` is empty or one this form would have written for any of `labels`. */
export function isAutomaticClientName(
  name: string,
  labels: readonly string[],
): boolean {
  const trimmed = name.trim();
  if (trimmed === "") return true;
  return labels.some((label) =>
    new RegExp(`^${escape(label)}( \\d+)?$`, "i").test(trimmed),
  );
}

/**
 * The name to show after the type changes.
 *
 * @param current what the name field holds now.
 * @param nextLabel the label of the type just picked.
 * @param labels every type's label, to recognise a name the form wrote.
 * @param taken names used by the other clients.
 */
export function nameForType(
  current: string,
  nextLabel: string,
  labels: readonly string[],
  taken: readonly string[],
): string {
  return isAutomaticClientName(current, labels)
    ? suggestClientName(nextLabel, taken)
    : current;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
