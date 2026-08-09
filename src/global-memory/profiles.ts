import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolveGlobalMemoryRepository, isPathInsideRepository, type RepositoryResolutionOptions } from "./repository";
import type { ProjectProfile, ProjectProfileList, ProjectProfileShow } from "./types";

export const PROJECT_PROFILE_SLUG = /^[a-z0-9][a-z0-9-]*$/u;
export const MAX_PROJECT_PROFILE_BYTES = 256 * 1024;

export class ProjectProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectProfileError";
  }
}

function profileRoot(repositoryPath: string): string {
  return resolve(repositoryPath, "memory", "projects");
}

function requireSlug(slug: string): string {
  if (!PROJECT_PROFILE_SLUG.test(slug) || slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
    throw new ProjectProfileError(`Invalid project profile slug '${slug}'. Use lowercase letters, numbers, and hyphens only.`);
  }
  return slug;
}

async function safeProfileRoot(repositoryPath: string): Promise<string> {
  const root = profileRoot(repositoryPath);
  await ensureNoReparseComponents(root);
  let info;
  try { info = await lstat(root); }
  catch { throw new ProjectProfileError(`Project profile directory is missing: ${root}`); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProjectProfileError(`Project profile directory is not a regular directory: ${root}`);
  if (!isPathInsideRepository(repositoryPath, root)) throw new ProjectProfileError(`Project profile directory escapes the repository: ${root}`);
  return root;
}

async function safeProfilePath(repositoryPath: string, slug: string): Promise<{ root: string; path: string }> {
  const safeSlug = requireSlug(slug);
  const root = await safeProfileRoot(repositoryPath);
  const path = resolve(root, `${safeSlug}.md`);
  if (!isPathInsideRepository(root, path)) throw new ProjectProfileError(`Project profile path escapes the profile directory: ${path}`);
  await ensureNoReparseComponents(path);
  let info;
  try { info = await lstat(path); }
  catch { throw new ProjectProfileError(`Project profile '${safeSlug}' was not found.`); }
  if (!info.isFile() || info.isSymbolicLink()) throw new ProjectProfileError(`Project profile '${safeSlug}' is not a regular file.`);
  if (info.size > MAX_PROJECT_PROFILE_BYTES) throw new ProjectProfileError(`Project profile '${safeSlug}' exceeds the ${MAX_PROJECT_PROFILE_BYTES}-byte read limit.`);
  return { root, path };
}

async function ensureNoReparseComponents(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    let info;
    try { info = await lstat(current); }
    catch {
      const parent = dirname(current);
      if (parent === current) throw new ProjectProfileError(`Project profile path does not exist: ${path}`);
      current = parent;
      continue;
    }
    if (info.isSymbolicLink()) throw new ProjectProfileError(`Project profile path resolves through a symlink or reparse point: ${path}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function metadata(repositoryPath: string, root: string, path: string, slug: string): ProjectProfile {
  const relativePath = relative(resolve(repositoryPath), path).split(sep).join("/");
  return { slug, path: relativePath };
}

export async function listProjectProfiles(
  options: RepositoryResolutionOptions = {},
): Promise<ProjectProfileList> {
  const repository = await resolveGlobalMemoryRepository(options);
  const root = await safeProfileRoot(repository.repositoryPath);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { throw new ProjectProfileError(`Could not read project profiles: ${error instanceof Error ? error.message : String(error)}`); }
  const profiles: ProjectProfile[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    const slug = entry.name.slice(0, -3);
    requireSlug(slug);
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new ProjectProfileError(`Project profile entry is a symlink or reparse point: ${path}`);
    await ensureNoReparseComponents(path);
    const info = await lstat(path);
    if (!info.isFile()) throw new ProjectProfileError(`Project profile entry is not a regular file: ${path}`);
    profiles.push(metadata(repository.repositoryPath, root, path, slug));
  }
  profiles.sort((a, b) => a.slug.localeCompare(b.slug));
  return { schemaVersion: 1, repository: repository.repositoryPath, profiles };
}

export async function showProjectProfile(
  slug: string,
  options: RepositoryResolutionOptions = {},
): Promise<ProjectProfileShow> {
  const repository = await resolveGlobalMemoryRepository(options);
  const { root, path } = await safeProfilePath(repository.repositoryPath, slug);
  let content: string;
  try { content = await readFile(path, { encoding: "utf8" }); }
  catch (error) { throw new ProjectProfileError(`Could not read project profile '${slug}': ${error instanceof Error ? error.message : String(error)}`); }
  return {
    schemaVersion: 1,
    repository: repository.repositoryPath,
    profile: { ...metadata(repository.repositoryPath, root, path, requireSlug(slug)), content },
  };
}
