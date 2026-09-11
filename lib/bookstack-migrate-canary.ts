import type { TargetPage } from "./bookstack-migrate-source.ts";

const groupIdentity = (page: TargetPage) =>
  `${page.shelfName}\0${page.bookName}\0${page.chapterName}`;

const firstDistinct = (
  pages: TargetPage[],
  shelfName: TargetPage["shelfName"],
  selectedGroups: Set<string>,
) => pages.find((page) => page.shelfName === shelfName && !selectedGroups.has(groupIdentity(page)));

export function selectBookStackCanaryPages(pages: TargetPage[], maximum = 10): TargetPage[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10) throw new Error("canary_limit_invalid");
  const ordered = [...pages].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const selected: TargetPage[] = [];
  const groups = new Set<string>();
  for (const shelfName of ["Lifecycle Artifacts", "Institutional Knowledge"] as const) {
    const page = firstDistinct(ordered, shelfName, groups);
    if (!page || selected.length >= maximum) continue;
    selected.push(page);
    groups.add(groupIdentity(page));
  }
  for (const page of ordered) {
    const group = groupIdentity(page);
    if (selected.length >= maximum) break;
    if (groups.has(group)) continue;
    selected.push(page);
    groups.add(group);
  }
  const selectedIds = new Set(selected.map((page) => page.sourceId));
  for (const page of ordered) {
    if (selected.length >= maximum) break;
    if (selectedIds.has(page.sourceId)) continue;
    selected.push(page);
    selectedIds.add(page.sourceId);
  }
  return selected.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}
