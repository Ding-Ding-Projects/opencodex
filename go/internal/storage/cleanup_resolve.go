package storage

// ResolveExactArchivedCandidates maps caller-supplied relative paths back onto
// real candidates.
//
// A path that no longer resolves means the preview the user approved has moved
// on. Reporting that is the whole point: silently cleaning the subset that
// still matches would delete a set the user never saw (oracle:
// src/storage/cleanup.ts:470).
//
// The boolean is false only for that drift. An empty request is a legitimate
// empty selection, not a failure.
func ResolveExactArchivedCandidates(relPaths []string, codexHome string) ([]ArchivedCandidate, bool) {
	if len(relPaths) == 0 {
		return []ArchivedCandidate{}, true
	}
	all := ListArchivedCandidates(codexHome)
	byRel := make(map[string]ArchivedCandidate, len(all))
	for _, candidate := range all {
		byRel[candidate.RelPath] = candidate
	}
	selected := make([]ArchivedCandidate, 0, len(relPaths))
	for _, rel := range relPaths {
		hit, ok := byRel[rel]
		if !ok {
			return nil, false
		}
		selected = append(selected, hit)
	}
	return selected, true
}
