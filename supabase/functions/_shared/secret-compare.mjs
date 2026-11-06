// Constant-time comparison for shared secrets presented in request headers.
// The loop always runs over the longer input and never returns early, so the
// time taken does not depend on how many leading characters match.

export function constantTimeSecretMatch(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string") return false;
  if (!expected) return false;
  const encoder = new TextEncoder();
  const left = encoder.encode(supplied);
  const right = encoder.encode(expected);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/** True when any supplied value matches any accepted secret; every pair is compared. */
export function anySecretMatches(suppliedValues, acceptedSecrets) {
  let matched = false;
  for (const accepted of acceptedSecrets) {
    if (!accepted) continue;
    for (const supplied of suppliedValues) {
      if (constantTimeSecretMatch(supplied, accepted)) matched = true;
    }
  }
  return matched;
}
